---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "GENERIC/GIMPLE 中间表示"
date: "2026-08-14T10:26:00+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "GENERIC", "GIMPLE", "tree_node", "IR", "GGC"]
description: "GCC 用 GENERIC（语言无关 AST）和 GIMPLE（三地址 SSA-ready）两层 IR 解耦前后端；gimplify 是唯一转换点。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

本模块是 GCC 中端 IR 的数据结构层：**GENERIC**（语言无关的高层 AST，`union tree_node`）由各前端产出；**GIMPLE**（三地址式低层 IR，`struct gimple` C++ 继承层次）由 `gimplify` 从 GENERIC 降级。两层 IR 解耦了前端与后端——前端只需产出 GENERIC，后端只消费 GIMPLE。本模块涵盖 tree 节点系统（`tree.cc`/`tree-core.h`）、GENERIC→GIMPLE 降级（`gimplify.cc`）、GIMPLE 语句数据结构（`gimple.h`/`gimple.cc`）与 GGC 垃圾回收管理节点生命周期。

## 模块架构

```
GENERIC 层（union tree_node，C 联合体）
  tree_base ── tree_typed ── tree_common ── {tree_int_cst, tree_exp, tree_ssa_name, tree_decl_common, tree_function_decl, ...}
  tree_code（tree.def 的 DEFTREECODE，~200 个）区分变体
  tree_node_structure() 按 code 查 treestruct.def 的 TS_* 决定联合体分支（GGC 遍历用）

  │ gimplify_function_tree（gimplify.cc:22004）── 唯一转换点

  ▼
GIMPLE 层（struct gimple，C++ 继承）
  gimple（GSS_BASE）─ gimple_statement_with_ops_base ─ gimple_statement_with_ops
      ├─ gcond / gdebug / ggoto / glabel / gswitch
  gimple_statement_with_memory_ops_base ─ gimple_statement_with_memory_ops
      ├─ gassign / greturn
  gcall / gbind / gphi / gtry / gasm / gomp_*（各 GSS_* tag）
  gimple_code（gimple.def 的 DEFGSCODE）区分语句类型

GGC（ggc-page.cc）── mark-sweep 回收 tree/gimple 节点
```

GENERIC 用 C 联合体（历史与性能），GIMPLE 用 C++ 继承（2005 年后新代码，类型安全）。两者都由 GGC 分配回收。`gimplify_function_tree` 是 GENERIC→GIMPLE 的唯一入口（漏斗设计）。

## 调用链路

```
gimplify_function_tree (gimplify.cc:22004)         ── cgraph_node::analyze (cgraphunit.cc:691) 触发
  └─ gimplify_body (gimplify.cc:21782)
      ├─ init_tree_ssa / push_gimplify_context / unshare_body
      ├─ gimplify_parameters (gimplify.cc:21819)
      └─ gimplify_stmt (&DECL_SAVED_TREE, &seq) (gimplify.cc:8572)
          └─ gimplify_expr (gimplify.cc:20326)     ── do-while 循环直到 GS_ALL_DONE
              ├─ lang_hooks.gimplify_expr()        ── 先让前端处理语言特定节点（默认返回 GS_UNHANDLED）
              └─ switch (TREE_CODE(*expr_p)) (gimplify.cc:20435)  ── ~50+ case
                  case MODIFY_EXPR → gimplify_modify_expr (gimplify.cc:7227)
                  case COND_EXPR    → gimplify_cond_expr (gimplify.cc:5443)
                  case CALL_EXPR    → gimplify_call_expr (gimplify.cc:4489)
                  ...
                  └─ 非兼容形式 → get_formal_tmp_var 创建临时变量
  └─ gimple_set_body (fndecl, seq) (gimplify.cc:22049)

# GIMPLE 序列 → CFG（后续 pass_build_cfg）
pass_build_cfg (tree-cfg.cc:364) → build_gimple_cfg (tree-cfg.cc:183)
  ├─ make_blocks (tree-cfg.cc:575) ── 语句序列划分为基本块
  └─ make_edges (tree-cfg.cc:975) ── 基本块间建边
```

`gimplify_modify_expr`（`gimplify.cc:7227`）是典型 case：递归 gimplify 左右值 → `gimple_build_assign`（:7496，内部 `gimple_alloc(GIMPLE_ASSIGN,...)` 分配）→ `gimplify_seq_add_stmt`（:7509）挂入序列 → 返回 `GS_ALL_DONE`。

## 核心实现

### `union tree_node`：GTY 标注的变体联合体

`union tree_node`（`tree-core.h:2193`）通过 `GTY((desc ("tree_node_structure (&%h)"), variable_size))` 标注。它用**分层组合**而非继承：`tree_base`（`tree-core.h:1146`，所有节点公共基座：16 位 `code` + 32 个标志位）→ `tree_typed`（:1573，加 `type` 指针）→ `tree_common`（:1578，加 `chain` 链表指针），之上是各特化 struct（`tree_int_cst`/`tree_exp`/`tree_ssa_name`/`tree_decl_common`/`tree_function_decl` 等，共 30+ 变体）。

变体判定：`tree_node_structure()`（`tree.cc:4247`）按 `TREE_CODE(t)` 查表返回 `tree_node_structure_enum`（`treestruct.def`，43 个 `TS_*` 值），GGC 用此 `desc` 决定走哪个联合体分支做标记遍历。`tree_code_size()`（`tree.cc:1091`）按 code 决定分配多大 struct。`tree_contains_struct[][]`（`tree.cc:297`）记录每个 code "包含"哪些 struct 层次，供 `contains_struct_check` 做编译期安全检查。

`enum tree_code`（`tree-core.h:155`）由 `all-tree.def`（构建期生成）顺序 `#include` `tree.def`（语言无关基础 code，`DEFTREECODE(CODE,NAME,CLASS,NARGS)`）+ 各前端 `.def`。`tree_code_class`（`tree-core.h:232`）分 10 类：`tcc_constant`/`tcc_type`/`tcc_declaration`/`tcc_unary`/`tcc_binary`/`tcc_comparison`/`tcc_statement`/`tcc_expression`/`tcc_vl_exp`/`tcc_exceptional`。

### GIMPLE C++ 继承层次

`struct gimple`（`gimple.h:223`）是基类，`GTY((desc ("gimple_statement_structure (&%h)"), tag ("GSS_BASE")))`，含 `gimple_code`（:229，8 位）、标志位、`uid`、`num_ops`、`location`、`bb`、`next`/`prev`（双向链表）。继承层次：`gimple_statement_with_ops_base`（:299，加 use_ops）→ `gimple_statement_with_ops`（:315，加 `op[]`）→ `{gcond(:904)/gdebug(:915)/ggoto(:925)/glabel(:935)/gswitch(:945)}`；`gimple_statement_with_memory_ops_base`（:330）→ `gimple_statement_with_memory_ops`（:345）→ `{gassign(:955)/greturn(:966)}`；独立分支 `gcall`（:361）/`gbind`（:400）/`gphi`（:477）/`gtry`（:523）/`gasm`（:571）/`gomp_*`。`enum gimple_code`（`gimple.h:33`）由 `gimple.def` 的 `DEFGSCODE` 生成。

类型安全向下转换用 `is_a_helper<T>::test()` 模板特化（`gimple.h:982` 起），`as_a<gassign *>(stmt)` 比 C 风格强制转换安全。`gss_for_code_[]`（`gimple.cc:102`）将 `gimple_code` 映射到 `gimple_statement_structure_enum`，`gimple_alloc()`（`gimple.cc:168`）据此计算大小并 GGC 分配。

### `gimplify_expr`：大 switch + lang_hooks 钩子

`gimplify_expr`（`gimplify.cc:20326`）在 `do-while` 循环（`gimplify.cc:20404`）中反复处理表达式。每次迭代先调 `lang_hooks.gimplify_expr`（`gimplify.cc:20422`，`langhooks.h:611`）让前端处理语言特定 tree code，返回 `GS_UNHANDLED` 才进入 `switch (TREE_CODE(*expr_p))`（`gimplify.cc:20435`）大 switch（~50+ case）。每个 case 调对应 `gimplify_xxx()` 辅助函数，返回 `GS_ALL_DONE`（完全处理）/`GS_OK`（部分，继续循环）/`GS_ERROR`。循环持续到 `GS_ALL_DONE`。某些 `gimplify_xxx` 返回 `GS_OK` 让循环继续处理变换后的表达式——例如 `gimplify_cond_expr` 把 `&&`/`||` 拆成多个 `COND_EXPR` 后子表达式需进一步 gimplify。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 变体类型（tagged union） | `union tree_node` in `tree-core.h:2193` | 1987 C 代码库，`TREE_CODE` O(1)，无 vtable 间接，GGC `desc` 友好 |
| 访问者/大 switch | `gimplify_expr` in `gimplify.cc:20326` | tree code 有限（~200），每个 gimplify 规则不同，switch 跳转表最高效 |
| C++ 继承 + is_a | `struct gimple` 层次 in `gimple.h:223` | GIMPLE 是 2005 年新 IR，可用 C++ 继承获类型安全，`as_a<>` 安全转换 |
| 对象池/GC（GGC） | `make_node` in `tree.cc:1328`；`ggc_collect` in `ggc-page.cc:2292` | 百万节点 + 图有环，mark-sweep 自动回收 |
| 前端可扩展联合体 | `lang_tree_node`（`ptr_alias` in `tree-core.h:2193`） | 各前端扩展自己的 tree 节点类型（如 C++ template）而不破坏统一接口 |

## 模块间交互

前端产出 GENERIC：各前端 parser 用 `tree.cc` 的 `build_decl`/`build2`/`build1` 构造 `tree_node`，存入 `DECL_SAVED_TREE`，可经 `lang_tree_node` 扩展语言特有节点。Gimplify 入口：`cgraph_node::analyze`（`cgraphunit.cc:628`）在分析函数时调 `gimplify_function_tree`（`cgraphunit.cc:691`），其他触发点 `ipa.cc:928`/`tree-nested.cc:3869`/`omp-expand.cc:10440`。语言钩子：`lang_hooks.gimplify_expr`（`langhooks.h:611`）在 switch 前调，C 的 `c_gimplify_expr`（`c-gimplify.cc:914`）只处理 C 特有节点（`C_MAYBE_CONST_EXPR` 等），返回 `GS_UNHANDLED` 交通用 switch。下游消费：`pass_build_cfg`（`tree-cfg.cc:364`）把 GIMPLE 序列转 CFG；`pass_build_ssa`（`tree-into-ssa.cc:2490`）转 SSA；大量 `tree-ssa-*` 优化遍用 `gimple_stmt_iterator` 遍历、`gimple_assign_rhs1`/`gimple_call_arg` 访问操作数；`pass_expand`（`cfgexpand.cc:7058`）的 `expand_gimple_stmt_1`（`cfgexpand.cc:4244`）按 `gimple_code` 分发翻译为 RTL。

## 扩展方式

- **新增 tree code**：在 `gcc/tree.def` 加 `DEFTREECODE(NEW_CODE,"new_code",tcc_xxx,N)` → `enum tree_code` 自动包含 → 在 `tree.cc:551` 的 `tree_node_structure_for_code` 加 case 返回 `TS_*` → 在 `tree.cc:1091` 的 `tree_code_size` 加 case → 在 `tree.cc:623` 的 `initialize_tree_contains_struct` 更新表 → 若需 GIMPLE 表示，在 `gimplify.cc:20435` 的 switch 加 `case NEW_CODE`。
- **新增 GIMPLE 语句类型**：在 `gcc/gimple.def` 加 `DEFGSCODE(GIMPLE_NEW,...)` → 在 `gimple.h` 定义 C++ 子类 + `is_a_helper` 特化 → 在 `gimple.cc` 更新 `gss_for_code_[]` 和 `gimple_size` → 加 `gimple_build_new_stmt` → 在 `gimplify.cc` 加降级逻辑 → 在 `tree-cfg.cc:861` 的 `make_edges_bb` 加 CFG 边 → 在 `cfgexpand.cc:4244` 的 `expand_gimple_stmt_1` 加 RTL 展开。
- **新增 gimplify 规则**：在 `gimplify.cc:20435` 的 switch 加 `case TARGET_TREE_CODE` → 实现 `gimplify_target_expr`（递归 gimplify 子表达式、构造 GIMPLE 语句、`gimplify_seq_add_stmt` 挂入、返回 `GS_ALL_DONE`/`GS_OK`）。语言特定规则改前端的 `lang_hooks.gimplify_expr` 而非 `gimplify.cc` 的 switch。
