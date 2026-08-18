---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "GIMPLE/SSA 优化遍"
date: "2026-08-14T10:26:00+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "SSA", "GIMPLE", "向量化", "pass 管线", "SCCVN"]
description: "GCC 中端在 GIMPLE 上构造 SSA，按声明式 passes.def 运行优化遍——SCCVN 值编号、PRE、自动向量化（loop + SLP）。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

本模块是 GCC 中端优化器：在 GIMPLE 上构造 **SSA**（Static Single Assignment），按声明式 `passes.def` 管线运行一系列优化遍——常量传播、值编号（SCCVN）、部分冗余消除（PRE）、死代码消除（DCE）、循环优化、**自动向量化**（loop + SLP）。SSA 是 GCC 几乎所有数据流分析的前提：每个变量只定义一次、带 φ 节点，使 def-use 链、常量传播、死代码分析的实现大大简化。本模块独立于语言与架构，是 GCC 优化能力的核心。

## 模块架构

```
pass 管线（passes.def 声明，passes.cc 调度）
  all_lowering_passes ── pass_build_cfg / pass_lower_cf / pass_lower_eh / pass_expand_omp
  all_small_ipa_passes ── pass_ipa_free_lang_data / pass_build_ssa_passes
       └─ pass_build_ssa_passes（容器）
           ├─ pass_fixup_cfg
           ├─ pass_build_ssa（tree-into-ssa.cc:2471）── SSA 构造
           └─ pass_ccp / pass_fre / pass_early_vrp / ...（早期优化）

SSA 数据结构（tree-core.h）
  tree_ssa_name（@1724）── var + def_stmt + imm_uses（立即使用链）
  ssa_use_operand_t（@1712）── use 操作数链节点

SSA 构造（tree-into-ssa.cc）
  pass_build_ssa::execute（@2490）
   ├─ calculate_dominance_info（CDI_DOMINATORS）
   ├─ compute_dominance_frontiers
   ├─ mark_def_sites
   ├─ insert_phi_nodes ── 在支配边界插 φ
   └─ rewrite_into_ssa ── 变量重写为 SSA_NAME

值编号（tree-ssa-sccvn.cc / .h）
  vn_ssa_aux（@222）── 每个 SSA_NAME 的值编号信息
  VN_INFO（@466）── 全局值编号表
  do_rpo_vn_1（@8858）── RPO 顺序值编号（SCC 强连通分量合并）
  pass_fre::execute（@9339）── FRE 部分冗余消除，消费 SCCVN

自动向量化（tree-vect-*.cc / tree-vectorizer.h）
  pass_vectorize（tree-vectorizer.cc:1241）/ pass_slp_vectorize（:1525）
  try_vectorize_loop_1（:1080）/ vect_transform_loops（:1010）
  _loop_vec_info（tree-vectorizer.h:947）── 循环向量化信息
  vect_analyze_loop（tree-vect-loop.cc:2927）/ vect_transform_loop（:11222）
  vect_recog_func 表 + STMT_VINFO_RELATED_STMT ── pattern 识别
```

pass 管线用声明式 `passes.def` + `gen-pass-instances.awk` 代码生成（X-macro）；SSA 构造按支配边界插 φ 节点；SCCVN 用 RPO + SCC 合并做等价值编号；向量化分 loop（跨迭代）与 SLP（同迭代内并行）两路。

## 调用链路

```
# SSA 构造
pass_build_ssa::execute (tree-into-ssa.cc:2490)
  ├─ calculate_dominance_info (CDI_DOMINATORS)  ── 计算支配关系
  ├─ compute_dominance_frontiers                 ── 支配边界
  ├─ mark_def_sites                              ── 标记定义点
  ├─ insert_phi_nodes                            ── 支配边界插 φ
  └─ rewrite_into_ssa                            ── 变量 → SSA_NAME
      └─ make_ssa_name (tree-into-ssa.cc:1396)    ── 分配 SSA_NAME 关联 def_stmt

# 向量化（loop）
pass_vectorize::execute (tree-vectorizer.cc:1241)
  └─ vect_transform_loops (tree-vectorizer.cc:1010)
      └─ try_vectorize_loop_1 (tree-vectorizer.cc:1080)
          ├─ vect_create_loop_vinfo (tree-vect-loop.cc:1672) ── 建 loop_vec_info
          ├─ vect_analyze_loop (tree-vect-loop.cc:2927)      ── 可行性分析
          │   └─ vect_pattern_recog（tree-vect-patterns.cc） ── pattern 识别
          └─ vect_transform_loop (tree-vect-loop.cc:11222)   ── 实际变换
```

pass 调度入口是 `execute_one_pass`（`passes.cc:2569`，见[编译驱动器](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/01-编译驱动器)模块）：`gate()` 门控 → `execute()` 虚函数。`execute_pass_list_1`（`passes.cc:2748`）沿 `next` 递归 `sub`。IPA pass 用 `execute_ipa_pass_list`（`passes.cc:3099`），对子 pass 区分类型：`GIMPLE_PASS` 子 pass 用 `do_per_function_toporder` 逐函数执行，IPA/SIMPLE_IPA 递归。

## 核心实现

### SSA 构造：支配边界 + φ 节点

`pass_build_ssa::execute`（`tree-into-ssa.cc:2490`）实现经典 SSA 构造算法：计算支配树（`calculate_dominance_info`）→ 计算支配边界（`compute_dominance_frontiers`）→ 标记定义点（`mark_def_sites`）→ 在每个定义的支配边界插入 φ 节点（`insert_phi_nodes`）→ 重写变量为 SSA_NAME（`rewrite_into_ssa`）。`make_ssa_name`（`tree-into-ssa.cc:1396`）分配 SSA_NAME tree 节点并关联 `def_stmt`。`tree_ssa_name`（`tree-core.h:1724`）含 `var`（被包装的 `_DECL`）、`def_stmt`（定义语句）、`imm_uses`（立即使用链，`ssa_use_operand_t` 链表，`tree-core.h:1712`）。SSA 退出在 `pass_expand`（`cfgexpand.cc:7058`）的 `rewrite_out_of_ssa`（:7067），把 SSA_NAME 映射到分区/伪寄存器。

> SSA 构造是五次 IR 演变的第三次（GENERIC→GIMPLE→**GIMPLE SSA**→RTL→汇编），边界跨越函数 `rewrite_blocks`（`tree-into-ssa.cc:2285`）的细节与全局状态 `cfun->gimple_df` 的流转见[编译数据流深读](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview-dataflow-deepdive)。

> pass 调度的 properties 依赖机制（`properties_required/provided/destroyed`，如 `pass_build_ssa` 提供 `PROP_ssa`）让 pass 声明"我要什么"而非"我在谁之后"——`execute_one_pass`（`passes.cc:2569`）执行前用 `verify_curr_properties`（`passes.cc:2187`）断言前置属性满足。TODO 机制（`todo_flags_start/finish`，如 `TODO_update_ssa`/`TODO_cleanup_cfg`）让 pass 只声明副作用，由 `execute_todo` 统一执行维护工作。两者细节见[编译驱动器](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/01-compiler-driver)模块的 pass 管理器章节。

### SCCVN：RPO + SCC 合并的值编号

`tree-ssa-sccvn.cc` 实现值编号：`vn_ssa_aux`（`tree-ssa-sccvn.h:222`）记录每个 SSA_NAME 的等价值。`do_rpo_vn_1`（`tree-ssa-sccvn.cc:8858`）按逆后序（RPO）遍历，用 **SCC（强连通分量）合并**处理循环——同 SCC 内的 SSA_NAME 视为等价值集合，避免循环引用无法求解。`VN_INFO`（:466）是全局值编号表。`pass_fre::execute`（:9339）的 FRE（Full Redundancy Elimination）消费 SCCVN 结果消除冗余计算。这比传统 GVN 更精确，能识别循环不变量。

### 自动向量化：loop 与 SLP 两路

GCC 向量化分两条路径，反映两种并行模式：**loop 向量化**（`pass_vectorize`，`tree-vectorizer.cc:1241`）跨循环迭代找数据并行（如 `a[i]=a[i]+b[i]` 各迭代独立可向量化为 SIMD）；**SLP 向量化**（`pass_slp_vectorize`，:1525）在同一迭代内找可并行的独立语句（Superword-Level Parallelism）。`_loop_vec_info`（`tree-vectorizer.h:947`，继承 `vec_info`）承载循环向量化信息。流程：`vect_transform_loops`（:1010）→ `try_vectorize_loop_1`（:1080）→ `vect_create_loop_vinfo`（`tree-vect-loop.cc:1672`）建 vinfo → `vect_analyze_loop`（:2927）可行性分析 → `vect_transform_loop`（:11222）实际变换。pattern 识别（`tree-vect-patterns.cc`）：`vect_recog_func` 数组被 `vect_pattern_recog` 遍历，匹配的 pattern 语句通过 `STMT_VINFO_RELATED_STMT`（`tree-vectorizer.h`）链接到原语句，`vect_transform_loop` 自动用 pattern 语句替代。

### pass 参数：`NEXT_PASS_WITH_ARGS` 与多实例

`passes.def` 中 pass 可带参数，如 `NEXT_PASS(pass_ccp, false /* nonzero_p */)`（`passes.def:84`）。这展开为 `NEXT_PASS_WITH_ARGS`（`passes.cc:1638`），由宏遍历可变参数调 `opt_pass::set_pass_param`（`tree-pass.h:86`）绑定参数。同一 pass 可在 `passes.def` 出现多次（如 `pass_ccp` 出现 4 次：`:84/:215/:271/:364`），首个实例调 `make_PASS()` 工厂，后续调 `clone()`——故 `clone` 必须正确复制参数状态。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 声明式 pass 管线 | `passes.def` + `gen-pass-instances.awk` | pass 顺序即声明顺序，新增 pass 加一行，成员/链表/dump 三处自动一致 |
| 模板方法 | `opt_pass` in `tree-pass.h:73`；`execute_one_pass` in `passes.cc:2569` | 统一 `gate`→`execute`→`todo`，子类只 override `execute` |
| 访问者 | `walk_gimple_stmt` in `gimple-walk.cc:596` | 遍历 GIMPLE 语句树，分离遍历逻辑与 pass 特定逻辑 |

## 模块间交互

SSA 遍依赖 GIMPLE IR（`tree.cc`/`gimple.h`）：`pass_build_ssa` 把 GIMPLE 的 `_DECL` 变量转为 `ssa_name`，操作数扫描用 `gimple_stmt_iterator`。SSA 构造在 `all_small_ipa_passes` 的 `pass_build_ssa_passes` 容器内（`passes.def`）。IPA 遍（`all_regular_ipa_passes`：`pass_ipa_inline`/`pass_ipa_cp`/`pass_ipa_devirt` 等，`cgraphunit.cc:2302`）跨函数在全 `cgraph` 上操作。向量化不直接调 RTL，而是产出带向量化语义的 GIMPLE，由下游 `pass_expand`（`cfgexpand.cc:7058`）展开为 RTL 指令。pass 管理器被 `toplev::main`（`toplev.cc:1167`）在 `general_init` 创建，被 `cgraphunit.cc` 的 `analyze_functions`（:1176）和 `expand_function`（:1827）调度。哪些遍是 IPA（全程序）、哪些是 per-function，由 `passes.def` 的链归属决定。

## 扩展方式

- **新增 GIMPLE 优化 pass**：见概览「典型修改场景 1」——新建 `gcc/tree-ssa-mypass.cc` 定义 `pass_data`（`type=GIMPLE_PASS`，`properties_required=PROP_cfg|PROP_ssa`）+ `class pass_my_pass:public gimple_opt_pass` override `execute`；`passes.def` 加 `NEXT_PASS(pass_my_pass)`（位置决定时机，如 SSA 构造后、PRE 前）；`Makefile.in` 加目标。
- **新增向量化 pattern**：在 `gcc/tree-vect-patterns.cc` 加 `vect_recog_xxx_pattern` 函数 → 在 `vect_recog_func` 数组注册 → pattern 语句经 `STMT_VINFO_RELATED_STMT` 链接 → `vect_transform_loop`（`tree-vect-loop.cc:11222`）自动替代。对应测试：`gcc/testsuite/gcc.dg/vect/`。
- **在已有 pass 加参数**：在 pass 类加成员变量 → override `set_pass_param`（参考 `tree-ssa-dce.cc:2080` 的 `pass_dce_base::set_pass_param`）→ `passes.def` 用 `NEXT_PASS(pass_xxx, arg)`（展开为 `NEXT_PASS_WITH_ARGS`）。多实例时注意 `clone()` 复制参数。
