---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "query 查询引擎"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "DataFusion", "查询引擎", "分布式计划"]
description: "query——基于 DataFusion（Greptime fork）的查询引擎：逻辑/物理计划、DistPlanner 分布式下沉、分区裁剪与 MergeScan scatter。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`query`（`src/query/`，~6.3 万行）是 GreptimeDB 的查询引擎，基于 Apache DataFusion（Greptime 维护的 pinned fork，见 architecture-invariants 第 6 条）做逻辑/物理计划、查询执行与**分布式查询计划**（`dist_plan/`）。它把 SQL/PromQL/log_query 翻译成 DataFusion `LogicalPlan`，再用 `DistPlannerAnalyzer` + `DistExtensionPlanner` 把远端 TableScan 包裹成 `MergeScan`，做分区裁剪后 scatter 到多 datanode 并发执行。它是 Frontend 查询能力的来源，也提供 datanode 侧的 per-region 子计划执行。

## 模块架构

`DatafusionQueryEngine`（`datafusion.rs`）是核心实现，持有 `QueryEngineState`（`query_engine/state.rs`）——状态里注册了 `LogicalPlanner`（`DfLogicalPlanner`，`planner.rs:613`）、`DfQueryPlanner` + `DefaultPhysicalPlanner`（`state.rs:493`）、`DistPlannerAnalyzer`/`DistExtensionPlanner`/`MergeSortExtensionPlanner`（`state.rs:205,262,555`，由 `with_dist_planner` 控制是否启用）、逻辑/物理优化规则（`optimizer/`，如 `ParallelizeScan`、`PassDistribution`）。子能力：`range_select/`（范围查询）、`log_query/`（日志查询）、`promql/`（PromPlanner）、`sql/`。

## 调用链路

**SQL SELECT 查询链路**（详见概览「查询链路」，此处聚焦 query 内部）：

```
DfLogicalPlanner::plan(stmt, query_ctx)                    planner.rs:615
  → plan_sql → DataFusion SqlToRel + catalog TableProvider → LogicalPlan
DatafusionQueryEngine::execute(plan, query_ctx)            datafusion.rs:507
  → exec_query_plan(plan, query_ctx)                       datafusion.rs:152
     → engine_context(query_ctx) → QueryEngineContext
     → create_physical_plan(&mut ctx, &plan)               datafusion.rs:347
        1. analyzer.execute_and_check（含 DistPlannerAnalyzer）  datafusion.rs:397
           → DistPlannerAnalyzer::analyze                  dist_plan/analyzer.rs:116
              → try_push_down → PlanRewriter                analyzer.rs:249
                 用 MergeScanLogicalPlan 包裹远端 TableScan
        2. optimizer.optimize（logical rules）              datafusion.rs:415
        3. query_planner().create_physical_plan             datafusion.rs:421
           → DfQueryPlanner + DefaultPhysicalPlanner       state.rs:493
              → DistExtensionPlanner::plan_extension       dist_plan/planner.rs:159
                 → extract_full_table_name                  planner.rs:222
                 → get_regions(table_name, plan)            planner.rs:315
                    → ConstraintPruner::prune_regions       region_pruner.rs:35
                       （按 PartitionExpr×PartitionInfo 求交裁剪）
                 → MergeScanExec::new(...)                  planner.rs:203
     → optimize_physical_plan                               datafusion.rs:432
        （ParallelizeScan 改 TableScan 分区，PassDistribution）
     → execute_stream(&ctx, &physical_plan)                 datafusion.rs:177
        → OutputData::Stream(SendableRecordBatchStream)
[执行期] MergeScanExec 对每个目标 region:
  → RegionQueryHandler::select_target(region_id, ReadPreference)  region_query.rs:58
     → partition_manager.find_region_leader → RegionQueryTarget
  → do_get(target, QueryRequest)                           region_query.rs:65
     → node_manager.datanode(peer).handle_query(QueryRequest)
        → RegionServer::handle_read → spawn_query → datanode query_engine.execute
           → MitoEngine::handle_query → scan_region（memtable + SST merge）
```

**关键设计**：`DistPlannerAnalyzer` 的 `pre_merge_scan_optimizer`（`analyzer.rs:192-228`）**刻意只用子集规则**——因为 `MergeScanLogicalPlan::inputs()` 返回空 vec，DataFusion 优化器看不到远端子计划内部。所以 `PushDownFilter` 等必须在 MergeScan 包裹前运行，把谓词推到 `TableScan.filters`，分区裁剪和 scan 级裁剪才能用上这些谓词；故意不加 `PushDownLimit`/`OptimizeProjections` 等会改变分布式边界的规则。`MergeScanExec` 的 `output_partition_count`（`merge_scan.rs:478`）按 region 数与 `target_partitions` 算，多 region 结果分到多 partition 异步并发 `do_get`。push down 失败可回退本地执行（`use_fallback`，`analyzer.rs:257`，计 `PUSH_DOWN_FALLBACK_ERRORS_TOTAL`）。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `DfLogicalPlanner::plan`（`planner.rs:615`） | 逻辑计划生成 | DataFusion SqlToRel + TableProvider |
| `DatafusionQueryEngine::execute`（`datafusion.rs:507`） | 执行入口 | 创建物理计划 + 流式执行 |
| `create_physical_plan`（`datafusion.rs:347`） | 物理计划 | analyzer + optimizer + DistExtensionPlanner |
| `DistPlannerAnalyzer::analyze`（`analyzer.rs:116`） | 分布式分析 | MergeScan 包裹远端 TableScan |
| `DistExtensionPlanner::plan_extension`（`planner.rs:159`） | 物理扩展 | 分区裁剪 + MergeScanExec scatter |
| `ConstraintPruner::prune_regions`（`region_pruner.rs:35`） | 分区裁剪 | PartitionExpr×PartitionInfo 求交 |
| `RegionQueryHandler::do_get`（`region_query.rs:65`） | region 查询下发 | find_region_leader → datanode |

</details>

## 核心实现

### 基于 DataFusion fork

architecture-invariants 第 6 条：GreptimeDB 用 `GreptimeTeam/datafusion` fork，根 `Cargo.toml` 用 `[workspace.dependencies]` 精确 pin + `[patch.crates-io]` 重定向到 fork。这样能定制优化器行为（如 `DistPlannerAnalyzer` 的子集规则），代价是升级需同步所有 pin 与 fork 修订。

### 逻辑/物理/分布式三层计划

逻辑计划（`LogicalPlan`）由 `DfLogicalPlanner` 经 DataFusion `SqlToRel` 构建；`DistPlannerAnalyzer` 作为 analyzer rule 在逻辑层插入 `MergeScanLogicalPlan` 标记远端下沉；物理计划由 `DfQueryPlanner` + `DefaultPhysicalPlanner` 生成，`DistExtensionPlanner` 作为 `plan_extension` 在物理层做分区裁剪并产出 `MergeScanExec`。三层分层让"下沉哪些算子""裁剪哪些 region""scatter 到几路"各司其职。

### 分区裁剪

`ConstraintPruner::prune_regions`（`region_pruner.rs:35`）接收 `[PartitionExpr]`×`[PartitionInfo]` + 列类型，按分区表达式求交裁掉无关 region，把剩余 region 交给 `MergeScanExec`。这让带分区键过滤的查询不必扫所有 region。

### Substrait 编解码

`DFLogicalSubstraitConvertor`（query_engine/default_serializer.rs）提供 substrait 编解码，`should_expand` 检测计划可序列化性。分布式模式下逻辑计划序列化为 Substrait 经 gRPC `QueryRequest` 发到 datanode，datanode 反序列化后用本地 `query_engine` 执行注入后的 per-region 子计划。

### 多查询语言

`sql/`（SQL）、`promql/`（`PromPlanner`）、`log_query/`（`LogQueryPlanner`）、`range_select/`（`RangeSelectPlanner`）各自把不同查询语言归一为 DataFusion `LogicalPlan`，复用同一套执行与优化管线。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略模式 | `LogicalPlanner`/`QueryEngine` trait（`query_engine.rs`）、多查询语言 planner | 不同查询语言复用执行管线 |
| 访问者 | DataFusion `PlanRewriter` 遍历计划（`analyzer.rs:249`） | 递归改写计划树插入 MergeScan |
| Provider 适配 | `DfContextProviderAdapter`（`datafusion/planner.rs`）、catalog `TableProvider` | 把 GreptimeDB 表适配为 DataFusion 数据源 |
| Extension | `ExtensionPlanner`/`ExtensionPlan`（`dist_plan/planner.rs:159`） | 把 MergeScan 注入 DataFusion 物理计划生成 |

## 模块间交互

依赖 `sql`（Statement→DataFusion）、`datafusion`（计划/优化/执行）、`store_api`/`operator`（region 查询经 `FrontendRegionQueryHandler`）、`common_query`、`common_recordbatch`、`substrait`、`partition`。被 `frontend`（`Instance` 持 `QueryEngineRef`）、`datanode`（本地 `query_engine` 执行注入子计划）、`flow`（`BatchingEngine` 调 `QueryEngine` 生成查询计划）调用。`MergeScanExec` 通过 `RegionQueryHandlerRef`（实为 `FrontendRegionQueryHandler`，`frontend/src/instance/region_query.rs`）回调 datanode 取数——这是 query 与 frontend 的关键耦合点。

## 扩展方式

- **新增优化规则**：实现 DataFusion `OptimizerRule` 或 `PhysicalOptimizerRule`，在 `QueryEngineState::try_new`（`state.rs:138-283`）注册到 logical/physical 优化器列表。
- **新增下推算子**：在 `DistExtensionPlanner::plan_extension`（`planner.rs:159`）的 match 加分支，让该算子可下沉到远端 region 执行。
- **新增查询语言**：实现一个 planner 把新语言转为 `LogicalPlan`，在 `query_engine` 注册。
