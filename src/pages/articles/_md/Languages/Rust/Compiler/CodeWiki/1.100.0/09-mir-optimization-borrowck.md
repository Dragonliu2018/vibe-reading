---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "MIR 优化与借用检查"
date: "2026-08-19T15:04:00+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "借用检查", "NLL", "CodeWiki"]
description: "rustc 的数据流分析框架、MIR 优化 pass 流水线与 NLL 借用检查。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/00-overview)

---

## 模块定位

这一层做两件互相支撑的事：在 MIR 上跑**数据流分析**与**优化 pass**，以及 Rust 的招牌特性——**借用检查（borrowck）**。借用检查基于 MIR 的 NLL（Non-Lexical Lifetimes）算法，把 lifetime 推理从词法作用域移到控制流图，是 Rust 借用规则能在编译期精确执行的关键。`rustc_mir_dataflow` 提供通用数据流框架，`rustc_mir_transform` 跑优化流水线，`rustc_borrowck` 做借用检查。

## 模块架构

- **`Analysis` trait**（`rustc_mir_dataflow/src/framework/mod.rs:98`）：数据流框架核心，`type Domain: Clone + JoinSemiLattice`，定义 `bottom_value`/`initialize_start_block`/`apply_*_effect`。`JoinSemiLattice`（`framework/lattice.rs:51`）的 `join` 对应最小上界，`DenseBitSet<T>` 实现为 powerset lattice（union）。
- **`MirPass`/`MirLint`**（`rustc_mir_transform/src/pass_manager.rs:131/152`）：MIR pass 注册接口，`run_pass(&self, tcx, body: &mut Body)`。`PassPolicy` 分 `Required`（不可禁用）和 `Optional`（可由 `-Zmir-enable-passes` 控制）。
- **`BorrowCheckRootCtxt`**（`rustc_borrowck/src/root_cx.rs:30`）：借用检查根上下文，在嵌套 body 间共享，持 `hidden_types`、`collect_region_constraints_results`、`propagated_borrowck_results`。
- **`MirBorrowckCtxt`**（`rustc_borrowck/src/lib.rs:738`）：单 body 借用检查上下文，持 `regioncx: &RegionInferenceContext`、`borrow_set: &BorrowSet`、`move_data: &MoveData`、`used_mut`。是 `ResultsVisitor` 实现者。
- **`BorrowSet`**（`borrow_set.rs:21`）：`BorrowSet::build`（`:49`）收集 MIR 所有借用，`borrows: IndexVec<BorrowIndex, BorrowData>`、`location_map`（location→borrow 映射）。
- **`Borrowck`/`BorrowckDomain`**（`dataflow.rs:20`）：组合三个子分析的 dataflow Analysis，Domain 为 `BorrowckDomain { borrows, uninits, ever_inits }`。**不使用** `iterate_to_fixpoint`，而是分别计算三子分析后组合 entry states（见 `get_flow_results` `lib.rs:608`）。

## 调用链路

### Borrowck 调用链（NLL 算法）

```
mir_borrowck (lib.rs:117)
  └→ BorrowCheckRootCtxt::new → do_mir_borrowck (root_cx.rs:269)
       ├─ Phase 1: 对每个 nested body:
       │    borrowck_collect_region_constraints (lib.rs:320)
       │      ├→ nll::replace_regions_in_mir (nll.rs:56)  // renumber regions→inference vars
       │      ├→ MoveData::gather_moves
       │      ├→ BorrowSet::build (borrow_set.rs:49)
       │      └→ type_check::type_check                    // 产生 region constraints
       ├─ Phase 2: apply_closure_requirements_modulo_opaques (root_cx.rs:168)
       ├─ Phase 3: handle_opaque_type_uses (root_cx.rs:100)
       └─ Phase 4: 对依赖 opaque 的 body → borrowck_check_region_constraints (lib.rs:399)
            ├→ nll::compute_regions (nll.rs:113)
            │    ├→ compute_sccs_applying_placeholder_outlives_constraints  // SCC 约束图
            │    └→ RegionInferenceContext::new
            ├→ get_flow_results (lib.rs:608)        // 三子分析 iterate_to_fixpoint 后组合
            │    ├→ Borrows::new → iterate_to_fixpoint
            │    ├→ MaybeUninitializedPlaces::new → iterate_to_fixpoint
            │    └→ EverInitializedPlaces::new → iterate_to_fixpoint
            └→ visit_results(body, &flow_results, &mut mbcx)  // 逐 location 报错
                 └→ mbcx.report_region_errors / report_move_errors
```

### MIR 优化 Pipeline（`rustc_mir_transform/src/lib.rs`）

```
mir_built → run_passes: LintAndRemoveUninhabited → Lint checks → SimplifyCfg::Initial
mir_promoted → PromoteTemps → SimplifyCfg::PromoteConsts → InstrumentCoverage
mir_drops_elaborated_and_const_checked (lib.rs:537)
  ├→ tcx.mir_borrowck()  ← borrowck 在此处运行!
  └→ run_analysis_to_runtime_passes (lib.rs:597)
       ├→ run_analysis_cleanup: CleanupPostBorrowck → SimplifyCfg::PostAnalysis → Derefer
       ├→ run_runtime_lowering: ElaborateDrops → StateTransform → ...
       └→ run_runtime_cleanup: LowerIntrinsics → SimplifyCfg::PreOptimizations
optimized_mir (lib.rs:778)
  └→ run_optimization_passes (lib.rs:687)
       → CheckAlignment → Inline → RemoveStorageMarkers → GVN → DataflowConstProp
          → JumpThreading → SimplifyCfg::Final → CopyProp → DestProp → ...
```

## 核心实现

### 为什么基于 MIR 做 borrowck（NLL 解决了什么）

NLL 将 lifetime 推理从 AST/HIR 层移到 MIR 层，基于控制流图而非词法作用域判断 borrow 是否活跃。`replace_regions_in_mir`（`nll.rs:56`）将所有 region 替换为 fresh inference Variable，使 lifetime 不再绑定于语法结构，而由数据流分析决定——解决了"borrow 在词法作用域结束前就不再使用但仍被认为活跃"的经典痛点。

### Dataflow 框架为何用 powerset lattice

`JoinSemiLattice for DenseBitSet<T>`（`lattice.rs:74`）用 union 做 join，对应"可能"语义（may-flow analysis）。borrow 的活跃性是一个 may-flow 问题——多前驱块的 join 取并集，确保保守过近似。

### Pass 顺序为何这样排

`run_optimization_passes`（`lib.rs:687`）中 `CheckAlignment`/`CheckNull`/`CheckEnums` 在最前（UB 检查必须在优化消除前），`Inline` 在 early simplification 之后（减少 inline 工作量），`GVN` 在 `SimplifyLocals::BeforeConstProp` 后，`SimplifyCfg::Final` 在末尾（合并 CFG 碎片）。`RemoveStorageMarkers` 必须在 inline 后（跨 crate 代码有 storage marker）。

### 为什么 Borrowck 不用 iterate_to_fixpoint

三个子分析（borrows/uninits/ever_inits）各有不同方向和 domain，组合后 join 语义不明确。改用分别 fixpoint 后 zip 组合 `EntryStates`（`lib.rs:646`），既复用框架又不引入语义错误。

### Two-phase Opaque Handling

`apply_closure_requirements_modulo_opaques`（`root_cx.rs:168`）先处理不依赖 opaque 的 body，再 `handle_opaque_type_uses` 解析 hidden types，最后处理依赖 opaque 的 body。因 opaque 类型的 defining use 在父 body、non-defining use 在子 body，形成循环依赖，需两阶段打破。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Dataflow Framework（lattice+transfer+fixpoint） | `Analysis` trait (`framework/mod.rs:98`) | 统一建模 may-flow 问题 |
| Pass Pipeline/Registry | `declare_passes!` (`lib.rs:80`) + `run_passes_inner` (`pass_manager.rs:275`) | 静态注册 + 按序执行 |
| Visitor | `GatherBorrows` (`borrow_set.rs`) / `MirBorrowckCtxt` | 遍历 MIR 收集/检查 |
| NLL Constraint Graph | `compute_sccs_*` | SCC 做 region 等价类推理 |
| Two-phase Opaque | `apply_closure_requirements_modulo_opaques` | 打破 opaque 循环依赖 |

## 模块间交互

`rustc_mir_transform` 管理 MIR 生命周期阶段（`MirPhase::Analysis` → `Runtime`），在 `mir_drops_elaborated_and_const_checked` 中**先调 `mir_borrowck`** 再做 drop elaboration（`lib.rs:544`）。borrowck 消费 `mir_promoted` 阶段的 MIR，产出 `RegionInferenceContext`（region 关系）和 `ClosureRegionRequirements`（闭包 region 需求传父 body）。`CleanupPostBorrowck` 在 borrowck 后清理专用 MIR 结构。`rustc_mir_dataflow` 是通用框架，被 borrowck 的三子分析和 MIR 优化的 `DataflowConstProp`/`DeadStoreElimination` 共用。

## 扩展方式

新增 MIR 优化 pass：新建 `rustc_mir_transform/src/my_pass.rs`，`struct MyPass;` 实现 `MirPass`（`pass_manager.rs:131`）的 `run_pass`/`policy`；在 `lib.rs` 的 `declare_passes!`（`:122`）加 `mod my_pass : MyPass;`；在 `run_optimization_passes`（`:687`）的 pass 数组按依赖插入。新增 dataflow 分析：在 `rustc_mir_dataflow/src/impls/` 实现 `Analysis` trait，定义 `Domain` 为 `DenseBitSet<T>`，调 `iterate_to_fixpoint` 后用 `ResultsCursor`/`visit_results` 消费。修改借用规则：改 `borrow_set.rs` 的 `GatherBorrows`、`dataflow.rs` 的 `Borrows` analysis、`places_conflict.rs` 的冲突判断、`diagnostics/` 的错误诊断。
