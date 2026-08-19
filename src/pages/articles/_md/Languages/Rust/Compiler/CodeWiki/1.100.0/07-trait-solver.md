---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "Trait 求解"
date: "2026-08-19T15:02:00+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "trait", "CodeWiki"]
description: "rustc 的 trait obligation 求解：旧 solver 与 next solver 的迁移与对比。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/00-overview)

---

## 模块定位

Trait 系统是 Rust 类型系统的灵魂——"某类型是否实现了某 trait"这一问题的求解贯穿类型检查（方法解析、coercion）与代码生成（vtable 构造）。这一层解决 trait obligation（如 `T: Clone`）是否成立、用哪个 impl 满足、嵌套 obligation 如何递归。`rustc` 正处于从旧 `rustc_trait_selection` 迁移到 `rustc_next_trait_solver` 的过渡期，新旧并存是理解这一层的关键。涉及 crate：`rustc_trait_selection`（旧 solver，~50k 行，全编译器第二大）、`rustc_next_trait_solver`（新 solver）、`rustc_traits`（helper query）、`rustc_pattern_analysis`（match 穷尽性）。

## 模块架构

### 旧 solver（`rustc_trait_selection`）

- **`SelectionContext<'cx,'tcx>`**（`select/mod.rs:102`）：候选选择核心，持 `infcx`、`freshener`（类型变量刷新器，递归检测）、`query_mode`。关键方法：`select()`（`:294`）、`candidate_from_obligation()`（`:323`，带缓存）、`evaluate_candidate()`（`:1277`）。
- **`FulfillmentContext<'tcx,E>`**（`fulfill.rs:61`）：obligation 栈驱动器，内部持 `ObligationForest<PendingPredicateObligation>`，实现 `TraitEngine` trait。
- **`PendingPredicateObligation`**（`fulfill.rs:76`）：包装 `PredicateObligation` + `stalled_on: Vec<TyOrConstInferVar>`（记录被卡住的推理变量）。
- **`FulfillProcessor`**（`fulfill.rs:279`）：实现 `ObligationProcessor`，`process_obligation()`（`:379`）是每个 obligation 的处理入口。
- **`SelectionCandidate`**（`rustc_middle/src/traits/select.rs:101`）：枚举，20+ 变体（`ImplCandidate(DefId)`/`ParamCandidate`/`BuiltinCandidate`/`AutoImplCandidate`/`ClosureCandidate`/`ObjectCandidate`/`BuiltinUnsizeCandidate` 等）。
- **`ImplSource`**（`rustc_middle/src/traits/mod.rs:687`）：`UserDefined`/`Param`/`Builtin`——selection 的最终产物，codegen 据此构造 vtable。

### 新 solver（`rustc_next_trait_solver`）

- **`EvalCtxt<'a,D,I>`**（`solve/eval_ctxt/mod.rs:98`）：下一代求解核心，持 `delegate`（`SolverDelegate`）、`var_values`、`search_graph`、`nested_goals`、`tainted`。关键方法：`compute_goal()`（`:886`）、`evaluate_added_goals_and_make_canonical_response()`（`:1519`）、`try_evaluate_added_goals()`（`:946`，固定点循环 `FIXPOINT_STEP_LIMIT=8`）。
- **`Certainty`**（`rustc_type_ir/src/solve/mod.rs:725`）：`Yes`/`Maybe(MaybeInfo)`，替代旧 solver 的 `EvaluationResult`。
- **`SearchGraphDelegate<D>`**（`solve/search_graph.rs:18`）：实现 `search_graph::Delegate`，配置 `ENABLE_PROVISIONAL_CACHE=true`、`FIXPOINT_STEP_LIMIT=8`、cycle handling 策略。

## 调用链路

### 旧 solver

```
typeck 注册 obligation
  → FulfillmentEngine::register_predicate_obligation()  // engine.rs:60
    → FulfillmentContext::register  // fulfill.rs:139 → ObligationForest::register_obligation

FulfillmentContext::select(selcx)  // fulfill.rs:108
  → ObligationForest::process_obligations(FulfillProcessor)
    → FulfillProcessor::process_obligation()  // fulfill.rs:379
      1. normalize
      2. match PredicateKind:
         - Trait → process_trait_obligation()
           → SelectionContext::select()  // select/mod.rs:294
             → candidate_from_obligation()  // :323 (缓存检查)
               → assemble_candidates()  // candidate_assembly.rs:32 按 lang_item 分派
               → winnow（多候选时 evaluate 逐一筛选）
             → evaluate_candidate()  // :1277
               → confirm_candidate()  // confirmation.rs:35 → ImplSource（含 nested obligations）
               → evaluate_predicates_recursively()  // :572
```

### 新 solver

```
InferCtxt::select_in_new_trait_solver(obligation)  // solve/select.rs:20
  → visit_proof_tree
    → EvalCtxt::compute_goal()  // eval_ctxt/mod.rs:886
      → 按 PredicateKind 分派:
        - Trait → compute_trait_goal()  // trait_goals.rs
          → consider_impl_candidate()  // :60
          → consider_param_env_candidate()
          → assemble_builtin_impl_candidates()
        - Projection → compute_projection_goal()
        - NormalizesTo → compute_normalizes_to_goal()
      → evaluate_added_goals_and_make_canonical_response()  // :1519
        → try_evaluate_added_goals()  // :946 固定点迭代
          for _ in 0..FIXPOINT_STEP_LIMIT(8):
            evaluate_added_goals_step() → 对每个 nested_goal 调 compute_goal()（递归）
      → canonicalize_response()  // canonical form 输出
```

## 核心实现

### 三阶段选择（旧 solver）

`assemble_candidates` → `evaluate_candidate`（winnow）→ `confirm_candidate`。候选组装只判断类型是否可能匹配（`args_may_unify`），评估阶段深入验证嵌套 obligation，确认阶段统一类型参数。代码：`candidate_assembly.rs:32`、`select/mod.rs:1277`、`confirmation.rs:35`。

### 为什么迁移到 next solver

旧 solver 的核心缺陷在 `select/mod.rs:1035-1123` 注释中可见——provisional cache 和 cycle handling 是"targeted fix"，`#60010` 问题只用 `reached_depth` 标记抑制缓存，不是根本解决方案。旧 solver 将推理状态与 selection 深度耦合，canonical query 难以正确缓存（注释 `:350` "this cache is not taking into account cycles"）。新 solver 用 canonical form 隔离推理状态，`SearchGraph` 统一处理 coinductive/inductive cycle（`search_graph.rs:47-80`），并用 `FIXPOINT_STEP_LIMIT` 显式控制不动点迭代次数。

### Canonical query 机制

旧 solver 中 selection 结果依赖 `InferCtxt` 的即时状态（哪些推理变量已解析），无法安全缓存跨调用结果。新 solver 将 goal canonicalize 为 `CanonicalInput`（所有推理变量替换为 canonical placeholder），response 同样 canonicalize——`has_no_inference_or_external_constraints()`（`solve/mod.rs:57`）检查 response 是否"纯"（无推理约束），纯结果可直接全局缓存。

### Coherence 检查与 Specialization

`select/mod.rs:371` 的 `is_knowable` 检查——intercrate mode 下若 trait ref "not knowable"（下游 crate 可能新增 impl），返回 `Ok(None)`（ambiguous）。这是 overlap 检查基础：两个 impl 重叠当且仅当存在一个类型使两者同时 applicable。Specialization（`specialize/mod.rs:1-8`）当前只支持"chain rule"（重叠 impl 必须严格子集），soundness 依赖 coherence 确保无歧义重叠。

### Overflow / 递归 bound 处理

旧 solver 用 `check_recursion_limit`（`select/mod.rs:330`）+ `OverflowError::Canonical`（`:1235`）。新 solver 更精细：`DIVIDE_AVAILABLE_DEPTH_ON_OVERFLOW=4`（`search_graph.rs:45`）——overflow 时将可用深度除以 4 避免立即失败；`FIXPOINT_OVERFLOW_AMBIGUITY_KIND` 为 `Certainty::overflow(false)`（`:109`），表示"可能成立但不保证"，允许后续推理继续推进。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 三阶段选择 | `assemble → evaluate → confirm` | 分离类型匹配/嵌套验证/参数统一 |
| ObligationForest | `FulfillmentContext` (`fulfill.rs:64`) | DAG 森林，`stalled_on` 避免重复求值 |
| Canonical Form（新） | `EvalCtxt::enter_canonical` (`eval_ctxt/mod.rs:519`) | 隔离推理状态，结果可缓存 |
| Provisional Cache | 旧 `select/mod.rs:1035` / 新 `search_graph.rs:29` | 循环处理：临时结果回复，闭合后验证 |
| Memoization Query | 旧 `in_task`/`insert_evaluation_cache` | dep_graph 跟踪缓存有效性 |

## 模块间交互

被 typeck 调用：method resolution 通过 `probe::ProbeScope` 调 `select()` 确定方法来源 impl；coercion 通过 `convert_trait_ref_to_pointer` 等路径注册 `Unsize`/`Coerce` obligation。入口 `ObligationCtxt` → `FulfillmentEngine` → `FulfillmentContext`。产出 vtable 给 codegen：`get_vtable()` 在 `rustc_codegen_ssa/src/meth.rs:103` 通过 `tcx.vtable_allocation((ty, trait_ref))` 获取，最终 impl 列表来自 `ImplSource::UserDefined`。与 infer 的关系：`SelectionContext` 持 `&InferCtxt`，selection 中产生的 unification/region constraint 直接注册到 infcx，`evaluate_candidate` 内用 `evaluation_probe` 开 snapshot，失败回滚。新旧桥接：`FulfillmentEngine` enum（`engine.rs:34`）在 `new()` 时根据 `infcx.next_trait_solver()` 选择 `Old` 或 `Next`，`SelectionContext::select()` 第一行检查并委托到 `select_in_new_trait_solver()`（`solve/select.rs:20`）。

## 扩展方式

新增 builtin trait 实现选择规则：在 `rustc_trait_selection/src/traits/select/candidate_assembly.rs` 的 `assemble_candidates()`（`:32`）`match lang_item` 加分支，在 `confirmation.rs` 的 `confirm_candidate()`（`:35`）加分支，在 `rustc_middle/src/traits/select.rs` 的 `SelectionCandidate`（`:101`）加变体；新 solver 侧在 `rustc_next_trait_solver/src/solve/assembly/structural_traits.rs` 加 `consider_builtin_*_candidate`，在 `trait_goals.rs` 的 `assemble_candidates` 调用。调整 overflow：改 `rustc_next_trait_solver/src/solve/mod.rs:45` 的 `FIXPOINT_STEP_LIMIT` 和 `search_graph.rs:45/109`。
