---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "名称解析"
date: "2026-08-19T15:00:00+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "名称解析", "CodeWiki"]
description: "rustc 的 early/late 两阶段名称解析、作用域链与 glob 导入固定点。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/00-overview)

---

## 模块定位

名称解析把 HIR 中的路径（`foo::bar`）、`use` 导入、标识符解析到具体的 `DefId`/`Res`，是类型检查的前提条件。`rustc_resolve` 的特殊之处在于它必须与宏展开交错——宏路径需先解析才能展开，展开又产生新的模块与导入。因此解析分 early/late 两阶段：early 与宏展开交错增量构建模块树，late 在展开完成后遍历整个 crate 解析路径。crate：`rustc_resolve`（~29k 行）。

## 模块架构

- **`Resolver`**（`lib.rs:1332`）：名称解析主体，持 `graph_root: LocalModule`（crate 根模块）、`partial_res_map: NodeMap<PartialRes>`（节点→部分解析结果，供 typeck 消费）、`indeterminate_imports`/`determined_imports`（待定/已定导入）、`glob_map`（glob 导入实际引入的名称集）。
- **`Scope`**（`lib.rs:114`）：作用域种类枚举——`ModuleNonGlobs`/`ModuleGlobs`/`MacroRules`/`StdLibPrelude`/`ExternPreludeItems`/`BuiltinTypes`。**`ScopeSet`**（`:150`）决定访问哪些子集。
- **`Rib`**（`late.rs:287`）：局部作用域栈条目，含 `bindings: FxIndexMap<Ident, R>` 和 `kind: RibKind`。**`RibKind`**（`:190`）定义作用域限制：`Normal`/`Block`/`AssocItem`/`FnOrCoroutine`/`Item(HasGenericParams)`/`ConstantItem`/`Module`/`ConstParamTy`——不同 Rib 对不同名称"透明度"不同。
- **`LateResolutionVisitor`**（`late.rs:795`）：持 `ribs: PerNS<Vec<Rib>>`（Type/Value/Macro 三命名空间各自独立栈）、`label_ribs`、`lifetime_ribs`。
- **`ImportKind`**（`imports.rs:73`）：`Single`/`Glob`/`ExternCrate`/`MacroUse`/`MacroExport`。

## 调用链路

入口 `resolve_crate()`（`lib.rs:2055`）分三大阶段：

```
resolve_crate()                        // lib.rs:2055
├─ 阶段1: Early Resolution（与宏展开交错）
│   宏展开回调 visit_ast_fragment_with_placeholders()  // macros.rs:196
│     ├→ collect_definitions()        // def_collector.rs:23  DefCollector Visitor 创建 DefId
│     ├→ build_reduced_graph_for_use_tree()  // build_reduced_graph.rs:584  注册 Import
│     └→ build_reduced_graph_for_item()      // :820  mod/fn/struct → define_local()
│
├─ 阶段2: Import Resolution（固定点迭代）
│   finalize_imports()                 // imports.rs:923
│     └→ resolve_imports()            // imports.rs:775  批量固定点
│         par_for_each_slice 并行解析每个 import
│         循环直到 indeterminate_imports 不再减少
│     └→ finalize_import()            // :1193  报告未解析错误
│
└─ 阶段3: Late Resolution（全 crate AST 遍历）
    late_resolve_crate()               // late.rs:5653
      → LateResolutionVisitor::new()   // :1494
      → visit::walk_crate()            // :5664  DFS 遍历
          visit_expr → resolve_expr → smart_resolve_path()  // late.rs:4487
          visit_path_segment → resolve_path()  // late.rs:1555
              → resolve_path_with_ribs()  // ident.rs:1823  逐段解析
                  → visit_scopes()     // ident.rs:54  ← 作用域链遍历核心
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `resolve_crate` (`lib.rs:2055`) | 名称解析总入口 | early/late 两阶段因宏展开而必需 |
| `build_reduced_graph_for_use_tree` (`build_reduced_graph.rs:584`) | 解析 use 树注册 Import | 增量构建模块树 |
| `resolve_imports` (`imports.rs:775`) | 批量并行解析导入 | 固定点迭代处理 glob |
| `resolve_path_with_ribs` (`ident.rs:1823`) | 逐段解析路径 | 作用域链从内到外 |
| `visit_scopes` (`ident.rs:54`) | 作用域链遍历核心 | 按优先级排序作用域 |

</details>

## 核心实现

### 为什么分 Early/Late

`late.rs:1-7` 明确说明——Late resolution 在 crate 完全展开、模块结构完全构建后运行，因此只需遍历一次。Early 阶段必须与宏展开交错，因为宏路径需要先解析才能展开，而展开又产生新的模块/导入。

### 为什么用 Reduced Graph

`build_reduced_graph.rs:1-6` 解释——宏展开产出的 AST 片段需集成到已有的部分构建的模块结构中。Reduced graph 是"模块树+定义注册"的增量构建，允许宏展开过程中逐步扩展。

### Glob 导入与歧义处理

`resolve_imports()`（`imports.rs:775`）用固定点迭代——每轮并行解析所有未定导入，提交结果后检查是否有新的导入变为可定。`glob_map`（`lib.rs:1401`）记录每个 glob 导入实际引入的名称。歧义错误通过 `ambiguity_errors`（`:1410`）延迟去重。

### 作用域链设计

`visit_scopes()` 注释（`ident.rs:68-107`）详细列出 TypeNS/ValueNS/MacroNS 各自的查找优先级。核心原则：非受控名称（用户定义）优先于受控名称（语言内建/标准库），允许向后兼容地添加新名称。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Visitor | `LateResolutionVisitor` (`late.rs:852`) / `DefCollector` (`def_collector.rs:147`) | 遍历 AST 节点 |
| 作用域链（Scope Chain） | `visit_scopes` (`ident.rs:54`) + Rib 栈 (`late.rs:802`) | 从内到外查找 |
| 两阶段 Resolution | early (`build_reduced_graph` + `imports`) + late (`late.rs`) | 因宏展开交错 |
| 条件可变性 | `CmResolver`/`RefOrMut` (`lib.rs:2830`) | 并行导入解析时标记投机模式 |

## 模块间交互

消费 AST（从 `rustc_ast`）和 `rustc_expand`（经 `ResolverExpand` trait `macros.rs:172` 接收回调）。产出 `ResolverOutputs`（`lib.rs:1939`），含 `ResolverGlobalCtxt`（模块子项、effective_visibilities）和 `ResolverAstLowering`（`partial_res_map`、`next_node_id`、`owners`）。`partial_res_map` 被 `rustc_hir_analysis`/typeck 消费，将 AST NodeId 映射到 `Res`（DefId）。边界（`lib.rs:7`）：rustc_resolve 只做"不依赖类型检查"的解析；方法解析、字段访问、关联项解析在 `rustc_hir_analysis` 完成。`traits_in_scope()`（`:2081`）为 typeck 提供"尽力而为"的 trait 候选列表。

## 扩展方式

新增导入行为（如 `use ... as _` 语义调整）：改 `ImportKind`（`imports.rs:73`）、`resolve_import`/`finalize_import`（`imports.rs`）、`build_reduced_graph_for_use_tree`（`build_reduced_graph.rs:584`）的导入注册。新增路径前缀关键字：改 `resolve_path_with_ribs`（`ident.rs:1823`）的段解析，可能还需 `smart_resolve_path_fragment`（`late.rs:4504`）调 `PathSource`。新增作用域类型：在 `Scope`（`lib.rs:114`）和 `ScopeSet`（`:150`）加变体，在 `visit_scopes`（`ident.rs:54`）的 loop 加分支。
