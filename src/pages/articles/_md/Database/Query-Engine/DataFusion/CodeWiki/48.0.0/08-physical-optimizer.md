---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "物理优化器"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "PhysicalOptimizerRule 单遍执行、JoinSelection/EnforceDistribution/EnforceSorting 需求驱动模型。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/physical-optimizer` 对 `ExecutionPlan` 做重写优化。它独立于逻辑优化器，因为依赖运行时物理属性（`boundedness`/`pipeline_behavior`/`PartitionMode`/统计）——这些在逻辑阶段不可用。核心是**需求驱动**模型：算子声明对子节点的分布/排序需求（`required_input_distribution`/`required_input_ordering`），优化器插入补偿算子（`RepartitionExec`/`SortExec`）满足需求。规则按固定依赖顺序单遍执行（非 fixpoint），因为物理规则有明确前驱-后继依赖。

## 模块架构

```text
physical-optimizer/
├── optimizer.rs              # PhysicalOptimizerRule trait + PhysicalOptimizer（16 条默认规则）
├── join_selection.rs         # JoinSelection（流式修复 + 统计选择）
├── enforce_distribution.rs   # EnforceDistribution（插 RepartitionExec，最大单文件 1415 行）
├── enforce_sorting/          # EnforceSorting（插/消 SortExec + 保序变体替换）
├── output_requirements.rs    # OutputRequirements 书挡规则（add/remove）
├── projection_pushdown.rs filter_pushdown.rs limit_pushdown.rs  # 算子下推
├── combine_partial_final_agg.rs aggregate_statistics.rs  # 聚合优化
├── pruning.rs sanity_checker.rs  # 谓词裁剪 / 最终验证
```

## 调用链路

由 `DefaultPhysicalPlanner::optimize_physical_plan`（`core/src/physical_planner.rs:1910`）编排，单遍线性：

```text
let mut new_plan = Arc::clone(&plan);
for optimizer in optimizers {                                   # 按 rules Vec 顺序，每条只跑一次
    let before_schema = new_plan.schema();
    new_plan = optimizer.optimize(new_plan, session_state.config_options())?;
    OptimizationInvariantChecker::new(optimizer).check(&new_plan, before_schema)?;  # 每规则后校验
    observer(new_plan, optimizer)
}
# 全部完成后 InvariantChecker(Executable) 最终可执行性验证
```

与逻辑优化器对比：逻辑用 `ApplyOrder` 枚举框架控制递归 + fixpoint 多轮；物理无 `apply_order`（每规则自管 `transform_up`/`transform_down`）+ 单遍无循环。物理不做 fixpoint 因规则有明确依赖链（`EnforceDistribution` 必在 `JoinSelection` 之后、`EnforceSorting` 之前），一次有序遍历保证正确性。

## 核心实现

### PhysicalOptimizerRule trait

```rust title="datafusion/physical-optimizer/src/optimizer.rs:49"
pub trait PhysicalOptimizerRule: Debug {
    fn optimize(&self, plan: Arc<dyn ExecutionPlan>, config: &ConfigOptions) -> Result<Arc<dyn ExecutionPlan>>;
    fn name(&self) -> &str;
    fn schema_check(&self) -> bool;    // 是否规则后校验 schema 不变性
}
```

`PhysicalOptimizer` struct（`:69`）持 `Vec<Arc<dyn PhysicalOptimizerRule + Send + Sync>>`，`new()`（`:82`）硬编码 16 条规则固定顺序。

### JoinSelection：两阶段，依赖物理属性

`join_selection.rs:153` 两阶段均 `transform_up`（自底向上）：

**阶段一 Pipeline Fixing**（`apply_subrules`）：`hash_join_convert_symmetric_subrule`（`:388`）当 HashJoin 左右都 unbounded + incremental 时替换为 `SymmetricHashJoinExec`（对称哈希连接，避免 pipeline-breaking）；`hash_join_swap_subrule`（`:529`）当左 unbounded 右 finite 时交换输入使 build 侧有限。

**阶段二 Statistical Join Selection**（`statistical_join_selection_subrule`，`:302`）：`HashJoin + PartitionMode::Auto` 时 `try_collect_left`（`:211`）按阈值 `hash_join_single_partition_threshold`（字节）与 `..._threshold_rows`（行数）判断 CollectLeft（小表广播），不适合则 `partitioned_hash_join`。`should_swap_join_order`（`:61`）优先比 `total_byte_size` 不足比 `num_rows`，小表放 build 侧。JoinSelection 必在 `EnforceDistribution`/`EnforceSorting` 之前（`optimizer.rs:93`）——它把 `Auto` 解析为具体模式，后续规则才能据决定是否插 Repartition/Sort。

### EnforceDistribution：需求驱动插 RepartitionExec

`enforce_distribution.rs:192`：可选 join key 重排序（`top_down_join_key_reordering` 启用则 `adjust_input_keys_ordering` 自顶向下，否则 `reorder_join_keys_to_inputs` 自底向上），再 `ensure_distribution`（`:1160`）自底向上对每子节点比 `plan.required_input_distribution()[idx]` 与子节点 `output_partitioning()`：`SinglePartition`→插 `CoalescePartitionsExec` 或 `SortPreservingMergeExec` 合并；`HashPartitioned(exprs)`→先试 RoundRobin 增并行度（`enable_round_robin_repartition`），再按需插 `RepartitionExec(HashPartitioning(exprs, target_partitions))`；`repartition_file_scans` 启用则调 `plan.repartitioned()` 在数据源层增并行度。规则保证幂等与分布有效（`:161`）。

### EnforceSorting：插/消 SortExec + 保序变体

`enforce_sorting/mod.rs:202` 四阶段：`ensure_sorting`（`:427`）自底向上比 `required_input_ordering` 与 `output_ordering`，不满足 `add_sort_above` 插 SortExec，已有排序被覆盖则消多余 Sort；`parallelize_sorts`（`:361`，`repartition_sorts` 启用）把 `CoalescePartitions+Sort` 级联替为 `Sort+SortPreservingMerge` 实现分区并行排序；`replace_with_order_preserving_variants` 把普通算子替为保序变体（如 `CoalescePartitions`→`SortPreservingMerge`）减不必要排序中断；`pushdown_sorts` 利用自底向上遗漏的下推机会；`replace_with_partial_sort`（`:254`）对 unbounded 输入若子已有部分排序前缀替为 `PartialSortExec`。

### OutputRequirements 书挡模式

`OutputRequirementExec` 是不可执行辅助节点，仅优化期携带全局输出排序/分布需求。`new_add_mode()`（`optimizer.rs:86`）在规则链最前插入，`new_remove_mode()`（`:123`）末尾前移除——防止 `EnforceDistribution` 为满足局部 join 需求而破坏全局输出需求。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Strategy | 每规则 impl `PhysicalOptimizerRule`，`rules` Vec | 规则可插拔 |
| Visitor/TreeNode 重写 | 规则经 `plan.transform_up`/`transform_down`（如 `join_selection.rs:168`） | 不直接操作树，统一遍历重写 |
| Pipeline | `PhysicalOptimizer.rules` 线性规则流水线 | 有序执行 |
| Context Decorator | `PlanContext<T>`（`physical_plan::tree_node`）携辅助数据（`PlanWithKeyRequirements`/`DistributionContext`/`OrderPreservationContext`） | 单次遍历做需全局视角的决策 |
| Composite Subrules | `JoinSelection` 内 `apply_subrules` 串子规则、`EnforceSorting` 串 5 子函数 | 规则内组合多步骤 |

## 模块间交互

依赖 `physical-plan`（`ExecutionPlan`/`RepartitionExec`/`SortExec`/各 join exec/`Partitioning`/`Distribution`/`PlanContext`/`TreeNode`）、`physical-expr`（`EquivalenceProperties`/`PhysicalExpr`/`LexOrdering`/`Partitioning`）、`common`。被 `core` 的 `DefaultPhysicalPlanner` 末段调用（`physical_planner.rs:1910`）。完整流程：LogicalPlan→`create_initial_plan`→ExecutionPlan→`optimize_physical_plan`→最终 ExecutionPlan。

## 扩展方式

- **新增 PhysicalOptimizerRule**：新建文件 impl `PhysicalOptimizerRule`（`optimize`/`name`/`schema_check`），`lib.rs` 加 `pub mod`，在 `PhysicalOptimizer::new()`（`:82`）合适位置插入——位置关键，注释标了依赖（如 `EnforceDistribution` "make sure the whole plan tree is determined before this rule"，`:103`；`EnforceSorting` "should always run after EnforceDistribution"，`:110`）。用户层可 `SessionState::add_physical_optimizer_rule` 不改源码。
- **自定义 join 选择**：改 `statistical_join_selection_subrule`（`:302`）在 `HashJoinExec` 分支加输入排序属性检查，已满足 join key 排序则替为 `SortMergeJoinExec`；或新规则在 `JoinSelection` 后扫 `HashJoinExec` 替换。
- **调整规则顺序**：改 `new()`（`:82`）的 `rules` vec 顺序，风险是破坏依赖（调整后 `SanityCheckPlan`，`sanity_checker.rs:56`，会捕获不合法 plan）。
