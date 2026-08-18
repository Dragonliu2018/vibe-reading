---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "过程间分析与调用图"
date: "2026-08-18T14:16:25+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "IPA", "cgraph", "inline", "devirt", "IPA-CP", "modref", "WHOPR"]
description: "GCC 的调用图与过程间分析：symtab/cgraph_node/edge 数据结构、analyze_functions 全程序编排、内联/去虚化/IPA-CP/modref 四大 IPA pass，及 WHOPR 三阶段 LTO。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

本模块是 GCC 的**全程序视野**——在单函数优化（GIMPLE/SSA pass，见 [GIMPLE/SSA 优化遍](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/04-gimple-ssa-passes)）之上，跨函数边界做分析：调用图构建、内联、虚函数去虚化、过程间常量传播、内存副作用建模。它由两部分组成：**调用图与符号表**（`cgraph.cc`/`cgraph.h`/`cgraphunit.cc`/`cgraphclones.cc`）是承载全程序状态的数据结构，`cgraphunit.cc` 是把"前端产出 GENERIC"驱动到"逐函数编译"的**全程序编排器**；**IPA pass 群**（`ipa-*.cc`）是在调用图上运行的各过程间分析。调用图还承载 LTO 的三阶段（WPA/LTRANS）分区与 streaming，是 GCC 链接时优化的骨架。

> 与单函数 pass 的分界：单函数 pass 在 `execute_pass_list(cfun, all_passes)` 里逐函数跑（[编译驱动器](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/01-compiler-driver) 的调用链路）；IPA pass 在 `symbol_table::compile` 的全程序层面跑，操作的是整个 `cgraph` 而非单个 `cfun`。

## 模块架构

```
符号表与调用图（cgraph.h 数据结构）
  toplevel_node
    └─ symtab_node ── 函数与变量的统一基类（visibility/comdat/partition/LTO streaming）
          ├─ cgraph_node ── 函数：callees/callers/indirect_calls/clones/inlined_to
          └─ varpool_node ── 全局变量：output/tls_model/used_by_single_function
  cgraph_edge ── 调用边：caller/callee/call_stmt/profile_count/inline_failed
                 speculative 三件套（直接边+间接边+ipa_ref）
  symbol_table ── 顶层容器：nodes/asmnodes + symtab_state 状态机

全程序编排（cgraphunit.cc）
  finalize_compilation_unit() ── 入口（toplev.cc:482 调）
    ├─ analyze_functions() ── 自底向上可达性分析 + gimplify + lower
    └─ compile() = symbol_table::compile
        ├─ ipa_passes() ── 三组 IPA pass 调度
        ├─ expand_all_functions() ── 逐函数 execute_pass_list(all_passes)
        └─ output_variables()

IPA pass 群（ipa-*.cc，注册在 passes.def 的 all_small/regular/late_ipa_passes）
  pass_ipa_inline (ipa-inline.cc)      pass_ipa_devirt (ipa-devirt.cc)
  pass_ipa_cp (ipa-cp.cc)               pass_ipa_modref (ipa-modref.cc)
  pass_ipa_pure_const                  pass_ipa_icf (ipa-icf.cc)
```

`symbol_table`（`cgraph.h:2549`）是顶层容器，用 `symtab_state` 枚举（`cgraph.h:2510`）追踪编译阶段：`PARSING → CONSTRUCTION → LTO_STREAMING → IPA → IPA_SSA → IPA_SSA_AFTER_INLINING → EXPANSION → FINISHED`。这个状态机决定了"此刻能做什么操作"——例如 IPA 阶段才允许跨函数传播，EXPANSION 阶段函数体必须已物化。

## 调用链路

### 全程序编排主链

```
symtab->finalize_compilation_unit()  (cgraphunit.cc:2562, 由 toplev.cc:482 调)
  ├─ analyze_functions(first_time=true)  (cgraphunit.cc:1176, 2593)
  │    └─ for each reachable cgraph_node:
  │         cgraph_node::analyze()  (cgraphunit.cc:628)
  │           ├─ push_cfun(DECL_STRUCT_FUNCTION(decl))  (cgraphunit.cc:692)
  │           ├─ gimplify_function_tree()  (gimplify.cc:22004)  GENERIC→GIMPLE
  │           ├─ execute_pass_list(cfun, all_lowering_passes)  (cgraphunit.cc:701)
  │           │    └─ pass_build_cfg / pass_build_cgraph_edges
  │           └─ pop_cfun()
  ├─ analyze_functions(first_time=false)  ── 二次（thunks 等）
  └─ compile() = symbol_table::compile  (cgraphunit.cc:2343, 2626)
       ├─ state = IPA  (cgraphunit.cc:2253)
       ├─ ipa_passes()  (cgraphunit.cc:2253-2306)
       │    ├─ execute_ipa_pass_list(all_small_ipa_passes)   [passes.def:49-161]
       │    ├─ execute_ipa_summary_passes(all_regular_ipa)    ── 先收集 summary
       │    ├─ ipa_write_summaries()  (仅 flag_lto 时 streaming)
       │    └─ execute_ipa_pass_list(all_regular_ipa_passes) [passes.def:163-187]
       ├─ execute_ipa_pass_list(all_late_ipa_passes)  (cgraphunit.cc:2397)
       ├─ mark_functions_to_output()
       ├─ expand_all_functions()  (cgraphunit.cc:1990, 2435)
       │    └─ for each node (RPO 逆序): cgraph_node::expand()  (cgraphunit.cc:1827)
       │         └─ execute_pass_list(cfun, all_passes)  (cgraphunit.cc:1874)
       └─ output_variables()
```

`analyze_functions`（`cgraphunit.cc:1176`）的核心是 **BFS 可达性分析**：先 `needed_p()`（`cgraphunit.cc:240`）发现"显然必要"的符号（`externally_visible`、构造/析构、`TREE_PUBLIC` 且非 COMDAT）入队，再从队列取节点 `analyze()`，遍历 `callees` 把有定义的 callee 入队，对 `indirect_calls` 中的多态调用经 `walk_polymorphic_call_targets()` 发现可能虚函数目标并入队。外层 `while(changed)` 循环保证收敛（分析中可能引入新静态变量）。COMDAT 组成员互相入队。

## 核心实现

### 符号表统一抽象：symtab_node

函数与变量共享 `symtab_node` 基类（`cgraph.h:134`），因为它们在可见性、COMDAT、alias、LTO 分区上有完全相同的属性与操作。继承层次：

```
toplevel_node  (cgraph.h:110)          ── 引入 order 字段（全局输出序号）
  └─ symtab_node  (cgraph.h:134)       ── 共享 visibility/comdat/partition/ref_list
        ├─ cgraph_node  (cgraph.h:922) ── 函数
        └─ varpool_node (cgraph.h:2239)── 变量
```

```cpp title="cgraph.h — symtab_node 关键字段"
struct symtab_node : public toplevel_node {
  tree decl;                       // FUNCTION_DECL 或 VAR_DECL
  unsigned definition : 1;         // 是否有定义（而非仅声明）
  unsigned analyzed : 1;           // 是否完成 lowering + callgraph 边构建
  unsigned externally_visible : 1;
  symtab_node *same_comdat_group;  // 同一 COMDAT 组环形链表
  ipa_ref_list ref_list;           // 指向/被指向的 ipa_ref 引用
  // WHOPR 分区标志 (cgraph.h:624)
  unsigned used_from_other_partition : 1;
  unsigned in_other_partition : 1;
  // 可见性标志群：alias / transparent_alias / weakref / ...
};
```

`cgraph_node`（`cgraph.h:922`）在 `symtab_node` 上加调用边：`callees`（调出）、`callers`（被调入）、`indirect_calls`（callee 未确定）、`clones`/`clone_of`（克隆树）、`inlined_to`（内联宿主）、`profile_count`（执行次数）、`ipa_transforms_to_apply`（待应用 IPA 变换）。

### 调用边 cgraph_edge 与推测性调用

`cgraph_edge`（`cgraph.h:1877`）用四个指针维护 caller/callee 双向链表，`call_stmt` 指向对应的 GIMPLE `gcall`。关键字段是 `inline_failed`（`cgraph.h:2139`，`enum cgraph_inline_failed_t`，`CIF_OK` 表示可内联）记录**未内联原因**，`cgraph_inline_failed_string` 转可读文本——这让 `-Winline` 能解释每个边为何未内联。

**推测性调用（speculative call）** 是 profile-guided 的核心机制：一条间接调用边若被 devirt 或 profile 判定为"很可能调用某直接目标"，会被拆成三件套挂在同一条 `call_stmt` 上——(1) 直接调用边、(2) 保留的间接调用边、(3) 对目标的 `IPA_REF_ADDR` 引用。`make_speculative()`（`cgraph.h:1922`）创建、`resolve_speculation()`（`cgraph.h:2046`）在后续 inline 验证后消除间接边。

### 内联：两阶段架构

GCC 内联分两个阶段（`ipa-inline.cc:21-90` 文件头注释）：

- **`pass_early_inline`**（small IPA 组，`passes.def:76`）：拓扑序上对每个函数执行，callee 已局部优化。消除 C++ 抽象惩罚，为后续 IPA 分析提供更精确信息。`can_early_inline_edge_p()`（`ipa-inline.cc:693`）检查可早内联。
- **`pass_ipa_inline`**（regular IPA 组，`passes.def:175`）：全程序知识下的内联。入口 `ipa_inline()`（`ipa-inline.cc:2822`）。

```cpp title="ipa-inline.cc — ipa_inline 决策流程"
ipa_inline()  (ipa-inline.cc:2822)
  ├─ ipa_reverse_postorder()  (ipa-utils.cc:286)   ── 调用图逆拓扑序
  ├─ flatten pass  (ipa-inline.cc:2860)            ── flatten 属性函数递归内联
  ├─ inline_small_functions()  (ipa-inline.cc:2917) ── 贪心：按 badness 排序内联
  ├─ symtab->remove_unreachable_nodes()            ── 清理内联导致的死代码
  └─ inline-to-all-callers  (ipa-inline.cc:2950)    ── 只被调用一次的函数内联到所有 caller
```

内联决策用 **badness 评分**：`ipa_fn_summary`（`ipa-fnsummary.cc`）提供函数大小估计，结合边的 profile count 计算 badness——越低（负数表示有收益）越优先。`can_inline_edge_p()` 检查用户限制（function growth、`-finline-*`），`can_inline_edge_by_limits_p()` 检查 inline limits。贪心循环内联到 growth limit 耗尽。

### 去虚化 ipa-devirt

`ipa-devirt.cc` 把虚函数调用解析为直接调用，依据三个概念（`ipa-devirt.cc:22-105`）：

- **ODR（One Definition Rule）**：C++ 规则，同一类型在不同编译单元定义必须相同。LTO 下利用 ODR 合并跨单元类型层次。
- **OTR（OBJ_TYPE_REF）**：GIMPLE 中虚函数调用的表示，含 `otr_type`（类类型）和 `otr_token`（vtable 索引）。
- **BINFO**：前端附加在 `RECORD_TYPE` 上的继承信息（`TYPE_BINFO`），提供基类列表与 vtable 指针。

`build_type_inheritance_graph()`（由 `cgraphunit.cc:1203` 调用）基于函数方法类型建图，顶点是 `odr_type_d`（`ipa-devirt.cc:203`），含 `bases`/`derived_types` 边。`possible_polymorphic_call_targets()`（`ipa-devirt.cc:3119`）给定 `otr_type`/`otr_token`/`ipa_polymorphic_call_context` 返回所有可能目标，`final` 参数指示列表是否完整。

```cpp title="ipa-devirt.cc — pass_ipa_devirt 流程"
ipa_devirt()  (ipa-devirt.cc:3782)
  └─ for each function's indirect_calls (polymorphic type):
       跳过冷调用 (!e->maybe_hot_p())
       possible_polymorphic_call_targets() ── 取目标列表
       if 信息不可用 (pii->usable_p() false / vptr_changed): mark_unusable
       if flag_devirtualize_speculatively:
         make_speculative() ── 对 likely target 建推测性直接调用边
```

**能去虚化**：`otr_type` 已知且 ODR 完成、`ipa_polymorphic_call_context` 足够精确、目标列表唯一（`final` 类/方法）、vptr 未被修改（`vptr_changed == false`）。推测性去虚化（`try_speculative_devirtualization`，`ipa-devirt.cc:3689`）保留间接调用作 fallback 并插入条件直接调用，后续 inline 验证后 `resolve_speculation()` 消除间接边。

### IPA-CP：过程间常量传播

`ipa-cp.cc` 三阶段算法（`ipa-cp.cc:23-100`）：

1. **Summary**（`ipcp_generate_summary`，`ipa-cp.cc:6777`）：逐函数构建 jump function——描述调用点传的实际参数值，类型有 pass-through（传 caller 形参）、constant、unknown。
2. **Propagation**（`ipcp_propagate_stage`，`ipa-cp.cc:4079`）：拓扑序遍历，在每个 SCC 内沿调用边传播常量。核心 `propagate_constants_topo()`。
3. **Decision**（`ipcp_decision_stage`，`ipa-cp.cc:6530`）：拓扑逆序遍历，`decide_whether_version_node()`（`ipa-cp.cc:6557`）决定是否创建特化克隆。

```cpp title="ipa-cp.cc — lattice 与特化克隆"
template <typename valtype>
struct ipcp_lattice {            // valtype = tree(常量) 或 ipa_polymorphic_call_context
  bool bottom;                   // TOP：所有值都可能
  bool contains_variable;
  unsigned values_count;
  bool is_single_const() const;  // ipa-cp.cc:196
};
// decide_whether_version_node (ipa-cp.cc:6557):
//   某参数在所有调用点同一常量 → 函数体内直接替换
//   部分调用点为常量但收益>成本 → create_virtual_clone (cgraphclones.cc:662)
//   ipa_param_adjustments 描述签名修改，ipa_replace_map 描述体内常量替换
```

IPA-CP 创建的是 **virtual clone**（无函数体，只有变换描述），在 materialize 阶段才生成实际函数体——这与 `cgraphclones.cc` 的 `create_virtual_clone`（`cgraphclones.cc:662`）配合。

### Modref：内存副作用建模

`ipa-modref.cc` 记录函数对内存的 load/store 行为，喂给 alias analysis 消歧跨函数调用的内存访问。核心是 **EAF flags**（`tree-core.h:112-132`）描述每个参数指针的逃逸/读写性质：

```cpp title="ipa-modref.h — EAF flags（参数指针性质）"
EAF_NO_DIRECT_CLOBBER   (1<<2)  // 不直接写参数指向的内存
EAF_NO_INDIRECT_CLOBBER (1<<3)  // 不间接写
EAF_NO_DIRECT_ESCAPE    (1<<4)  // 参数指针不直接逃逸
EAF_NO_INDIRECT_ESCAPE  (1<<5)
EAF_NOT_RETURNED_DIRECTLY   (1<<6)  // 不直接返回
EAF_NO_DIRECT_READ      (1<<8)  // 不直接读
// 预定义组合：implicit_const_eaf_flags / implicit_pure_eaf_flags / implicit_retslot_eaf_flags
struct modref_summary {          // ipa-modref.h:28
  modref_records *loads, *stores; // 按 alias set 分层的内存访问树
  auto_vec<eaf_flags_t> arg_flags; // 每个参数的 EAF flags
  unsigned side_effects : 1, nondeterministic : 1;
  unsigned global_memory_read : 1, global_memory_written : 1;
};
```

`analyze_function(bool ipa)`（`ipa-modref.cc:3122`）分析函数体建 load/store 树与 EAF flags，只在 `always_executed_bbs`（`ipa-modref.cc:1892`，必然执行的基本块）中记录访问。IPA 传播沿调用图传播 EAF flags——callee 某参数不 clobber，则 caller 传给该参数的指针也不被 clobber。`modref_records` 直接被 `tree-ssa-alias` 消歧 load/store，EAF flags 被 `tree-ssa-structalias`（points-to）约束指针逃逸范围。

## 设计模式

| 模式 | 位置（文件:方法名） | 为什么用 |
|------|---------------------|----------|
| 统一抽象（symtab_node） | `symtab_node` in `cgraph.h:134` | 函数/变量共享 visibility/comdat/partition 逻辑，避免 cgraph 与 varpool 重复实现 |
| 状态机（symtab_state） | `symbol_table` in `cgraph.h:2549` | 编译阶段显式化，IPA 阶段才允许跨函数传播、EXPANSION 阶段函数体必须物化 |
| 拓扑序遍历（RPO/SCC） | `ipa_reverse_postorder` in `ipa-utils.cc:286` | 内联/CP 传播按调用图拓扑序，保证 callee 先于 caller 处理，信息单向流动 |
| 三阶段 IPA（summary/propagation/transform） | `ipa_opt_pass_d` in `tree-pass.h:141` | LTO 需在 streaming 前收 summary、WPA 时操作 summary、LTRANS 时有函数体才 transform |
| 推测性优化（speculative） | `make_speculative` in `cgraph.h:1922` | devirt/profile 不确定时保留 fallback + 插直接边，后续验证后再消除 |
| 克隆物化延迟（virtual clone） | `create_virtual_clone` in `cgraphclones.cc:662` | IPA-CP 只记变换描述不生成函数体，减少分析期内存，materialize 时才生成 |

## 模块间交互

- **与前端**：前端解析完一个函数即调 `cgraph_node::finalize_function`（`cgraphunit.cc:452`）注册到调用图，body 仍为 GENERIC tree（存于 `DECL_SAVED_TREE`），`definition=true` 但未分析。
- **与 GIMPLE/SSA**：`cgraph_node::analyze`（`cgraphunit.cc:628`）内调 `gimplify_function_tree`（`gimplify.cc:22004`）与 `all_lowering_passes`，是 GENERIC→GIMPLE+CFG 的发生点。IPA 阶段 `pass_build_ssa`（small IPA 组内）构造 SSA。
- **与后端**：`cgraph_node::expand`（`cgraphunit.cc:1827`）触发 `execute_pass_list(all_passes)`（`cgraphunit.cc:1874`），含 `pass_expand`（GIMPLE→RTL）与整个 RTL 管线。
- **IPA 三组分工**：`all_small_ipa_passes`（`passes.def:49-161`）不需跨单元信息、每单元独立执行（SSA 构建、early inline、early opts）；`all_regular_ipa_passes`（`passes.def:163-187`）需全程序知识（ICF/devirt/CP/inline/pure_const/modref）；`all_late_ipa_passes`（`passes.def:192-195`，PTA/omp_simd_clone）分区后执行。pass 顺序有依赖：devirt 在 inline 前（inline 利用 devirt 结果），modref 在 inline 后（内联产生新 callee 需更新 summary）。

## 扩展方式

- **新增 IPA pass**：建 `gcc/ipa-mypass.cc` 定义 `class pass_ipa_mypass : public ipa_opt_pass_d`，实现 `generate_summary`/`write_summary`/`read_summary`/`execute`/可选 `function_transform`；在 `passes.def` 的 `all_regular_ipa_passes`（`:163-187`）或 `all_small_ipa_passes` 按依赖插入 `NEXT_PASS`；在 `gcc/Makefile.in` 加目标文件。关键是确定它在 inline 前/后（影响 summary 时效）。
- **加内联启发式**：改 `ipa-inline.cc` 的 `ipa_inline()`（`:2822`）决策流程或 `can_inline_edge_p()`/badness 计算；若需不同函数大小模型，改 `ipa-fnsummary.cc`；用 `--param` 暴露阈值在 `gcc/params.opt` 加参数。
- **改进 modref 精度**：改 `ipa-modref.cc` 的 `analyze_function()`（`:3122`）访问分析或 EAF 传播；需更细内存树则改 `ipa-modref-tree.h`；需新 EAF flag 则改 `tree-core.h:112`。
- **加新 checker 到 analyzer**：见 [analyzer 模块](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/10-analyzer) 的扩展方式——analyzer 复用 IPA pass 框架注册。

> **WHOPR/LTO 三阶段**：链接时全程序优化需看所有编译单元 summary，但全程序函数体太大无法同时驻留内存。WPA 阶段（`do_whole_program_analysis` in `lto/lto.cc`）只加载 summary 数据（jump functions、modref tree、fn summary——远小于完整函数体），分区后 LTRANS 各分区独立流式回读 body 并走正常后端，可 `make -jN` 并行。不分区会导致 LTO 链接大程序 OOM。`ipa_passes()`（`cgraphunit.cc:2253`）中 `if (!in_lto_p)` 控制 small IPA pass 只在编译时跑一次，`ipa_write_summaries()`（`:2285`）在 `flag_lto` 时 streaming summary 到目标文件。
