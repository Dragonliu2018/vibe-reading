---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "类型检查与推导"
date: "2026-08-19T15:01:00+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "类型检查", "CodeWiki"]
description: "rustc 的类型推导、coercion、方法解析与 TypeckResults 产出。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/00-overview)

---

## 模块定位

类型检查是 Rust 安全保证的核心——它验证 HIR 中每个表达式的类型正确性，并推导出无法静态标注的类型。这一层用**推断变量 + 约束求解**（而非纯 Hindley-Milner）处理 Rust 的 subtyping、coercion、方法重载、region 约束。产出 `TypeckResults`（含每个节点的 `Ty` 与 coercion adjustments），是 MIR 构建的前提。涉及 crate：`rustc_hir_typeck`（函数体类型检查）、`rustc_hir_analysis`（well-formedness/coherence）、`rustc_infer`（推导上下文 `InferCtxt`）。

## 模块架构

- **`InferCtxt`**（`rustc_infer/src/infer/mod.rs:242`）：推断上下文，持 `inner: RefCell<InferCtxtInner>`，后者含四张 `UnificationTable`：`type_variable_storage`/`int_unification_storage`/`float_unification_storage`/`const_unification_storage`，外加 `region_constraint_storage`/`opaque_type_storage`。关键方法：`next_ty_var`（`:904`）、`shallow_resolve`（`:1241`）、`resolve_vars_if_possible`（`:1399`）、`fully_resolve`（`:1441`，writeback 阶段彻底解析）。
- **`UnificationTable`**（`:84`）：底层 `rustc_data_structures::unify::UnificationTable<InPlace<...>>`，支持 snapshot/rollback，用于 speculative unification。
- **`FnCtxt`**（`rustc_hir_typeck/src/fn_ctxt/mod.rs:46`）：函数体类型检查上下文，包装 `TypeckRootCtxt`（后者 `Deref` 到 `InferCtxt`）。核心字段：`param_env`、`ret_coercion: Option<RefCell<CoerceMany>>`、`diverges`。关键方法：`check_expr_with_expectation`（`expr.rs:207`）、`demand_coerce`（`demand.rs:230`）、`demand_suptype`（`demand.rs:171`）。
- **`Expectation`**（`expectation.rs:11`）：hint-driven inference 的核心 enum `NoExpectation | ExpectHasType(Ty) | ExpectCastableToType(Ty) | ExpectRvalueLikeUnsized(Ty)`。
- **`Coerce`**（`coercion.rs:73`）：coercion 引擎，字段含 `use_lub`/`allow_two_phase`/`coerce_never`。

## 调用链路

从 `typeck` query 出发：

```
typeck_with_inspect (lib.rs:111)
  ├─ TypeckRootCtxt::new (InferCtxt + fulfillment_cx)
  ├─ FnCtxt::new
  ├─ check_fn (check.rs:26)
  │    ├─ replace_opaque_types_with_inference_vars → ret_ty
  │    ├─ GatherLocalsVisitor::gather_from_param
  │    ├─ check_pat_top
  │    └─ check_return_or_body_tail
  │         └─ check_expr_with_expectation (expr.rs:207)
  │              └─ check_expr_kind (expr.rs:324 按 ExprKind 分发)
  │                   ├─ check_expr_method_call (expr.rs:1461)
  │                   │    ├─ check_expr(receiver) → rcvr_t
  │                   │    ├─ lookup_method → autoderef + probe
  │                   │    └─ check_argument_types
  │                   ├─ check_expr_call → callee type + check_argument_types
  │                   ├─ check_expr_binop / check_expr_unop / ...
  │                   └─ (递归子表达式)
  │    └─ CoerceMany::complete (聚合返回值类型)
  ├─ type_inference_fallback (lib.rs:235, fallback.rs:25)
  │    ├─ select_obligations_where_possible
  │    ├─ fallback_types (int→i32, float→f64, diverging→!/())
  │    └─ select_obligations_where_possible
  ├─ closure_analyze
  ├─ report_ambiguity_errors
  └─ resolve_type_vars_in_body (writeback.rs:40, 解析所有推断变量)
```

关键路径：`check_expr_coercible_to_type_or_error`（`expr.rs:136`）→ `check_expr_with_hint`（传 Expectation）→ `demand_coerce_diag`（`demand.rs:256`）→ `Coerce::coerce`（`coercion.rs:243`）→ 按源/目标类型分发到 `coerce_to_ref`/`coerce_unsized`/`coerce_from_inference_variable`/`unify` → `at().sup()` 或 `at().lub()` 进入 `InferCtxt` 的 unification。

## 核心实现

### 为什么用 inference variables + bounds 而非纯 HM unify

Rust 有 subtyping（lifetime）、coercion、方法重载、region constraint——纯 Hindley-Milner 无法表达。类型变量维护 upper/lower bounds 而非直接 unify（`type_variable_storage` 注释 `mod.rs:102-104`），允许 `T: Bound` 而非确定 `T = Bound`，trait obligation 可延迟求解。`coerce_from_inference_variable`（`coercion.rs:363`）当源是推断变量时注册 `CoercePredicate` obligation 而非立即 unify，保留后续 coercion 可能性。

### Autoderef 设计

方法解析通过 `Autoderef`（`autoderef.rs:17`）迭代 deref 链，每步尝试 builtin deref 或 overloaded `Deref` trait。`method_autoderef_steps`（`method/probe.rs:625`）作为独立 query 被缓存，因 autoderef 结果可能被多处复用。

### Coercion 的 sort 优先级

`Coerce::coerce`（`coercion.rs:243`）按优先级尝试：`NeverToAny` → unsized → 目标类型特定（raw ptr/ref/Pin）→ 源类型特定（fn item/fn ptr/closure → fn ptr）。deref coercion 在 `coerce_to_ref`（`:412`）沿 autoderef 链搜索匹配。

### Well-formedness 独立前 pass

`check_well_formed`（`wfcheck.rs:227`）在 fn body 检查前验证签名，注释（`:248-252`）说明：提前检查避免 fn body 中出现由 wf 违规导致的混淆错误。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Hint-driven inference | `Expectation` (`expectation.rs`) | 上下文类型提示驱动推导 |
| Constraint solving (unification with bounds) | `UnificationTable` (`mod.rs:84`) | union-find + bounds，支持 subtyping |
| Obligation-based lazy evaluation | `InferOk<T>` (`mod.rs:76`) | obligation 注册后延迟求解，`#[must_use]` |
| Deref coercion via autoderef | `Autoderef` (`autoderef.rs`) | 迭代 deref 链 |
| Visitor | HIR `intravisit::Visitor` / `WritebackCx` | writeback 阶段替换推断变量 |

## 模块间交互

消费 HIR + `Res`（来自 `rustc_resolve`）。与 `rustc_trait_selection` 紧耦合——`FulfillmentEngine`（`typeck_root_ctxt.rs:34`）持 trait obligation 求解器，`InferCtxt` 的 `selection_cache`/`evaluation_cache` 缓存 trait selection 结果，`ObligationCtxt` 在 coercion 中即时评估 obligation（`coercion.rs:183-186`）。产出 `TypeckResults` 给 mir/borrowck：`resolve_type_vars_in_body` 产出不含推断变量的 `TypeckResults`，含 `node_types`/`adjustments`/`liberated_fn_sigs`，供 MIR 构建与 NLL borrowck 消费。`rustc_hir_analysis` 提供 wf 检查：`check_well_formed`（`wfcheck.rs:227`）→ `check_item_type` 在 fn body 检查前验证签名。

## 扩展方式

新增 coercion 规则：改 `Coerce::coerce`（`rustc_hir_typeck/src/coercion.rs:243`）的 match 分发，在目标类型 match（`:289`）或源类型 match（`:325`）加分支，还需在 `rustc_middle::ty::adjustment::Adjust` 新增 adjustment kind。修改方法解析：改 `method_autoderef_steps`（`method/probe.rs:625`）和 `check_expr_method_call`（`expr.rs:1461`），probe 逻辑按 candidate sort（inherent > trait > autoderef）选择。修改 fallback（如 int 从 i32 改 i64）：改 `fallback_types`（`fallback.rs:66`），遍历 `unresolved_root_variables()` 按类别应用 fallback。
