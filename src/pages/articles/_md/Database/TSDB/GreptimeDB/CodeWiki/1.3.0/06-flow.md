---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "flow 持续流计算"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "Flownode", "流计算", "物化视图", "differential dataflow"]
description: "flow——Flownode 持续流计算：Streaming（DFIR）/Batching 双引擎、增量物化视图、DirtyTimeWindows 与 checkpoint 切换。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`flow`（`src/flow/`，~3.7 万行）是 GreptimeDB 的 Flownode 组件，提供持续流计算（continuous flow），支持流式聚合/物化视图/窗口计算。用户一次 `CREATE FLOW ... AS SELECT ...` 创建 flow，系统自动持续执行该查询、把结果写入 sink table（物化视图），后续直接查 sink table 即得最新结果。它基于 DataFusion 增量计算，有两种执行后端：Streaming（基于 differential dataflow / `dfir_rs`，低延迟）与 Batching（基于时间窗口批量查询，支持完整 SQL）。与离线查询（一次性算完返回）是不同计算模式。

## 模块架构

`FlowEngine` trait（`engine.rs:48`）定义 `create_flow`/`remove_flow`/`flush_flow`/`flow_exist`/`list_flows`/`handle_flow_inserts`/`handle_mark_window_dirty` 等。三个实现：`StreamingEngine`（`adapter.rs:172`，基于 DFIR/hydroflow）、`BatchingEngine`（`batching_mode/engine.rs:64`，批量模式）、`FlowDualEngine`（`adapter/flownode_impl.rs:66`，管理器，按 `FlowType` 分发）。

`StreamingEngine` 持 `WorkerHandle[]`、`QueryEngine`、`ManagedTableSource`、`FrontendInvoker`、`FlownodeContext`（`node_context.rs:40`，source_to_tasks/flow_to_sink/flow_plans/source_sender/sink_receiver 等映射）、`FlowTickManager`、refill_tasks。`Worker`（`adapter/worker.rs:245`）持 `ActiveDataflowState[]`（`df: Dfir` + `DataflowState`）。

`BatchingEngine` 持 `FlowRuntimeRegistry`、`FrontendClient`、`FlowMetadataManager`、`TableMetadataManager`、`BatchingModeOptions`。`BatchingTask`（`batching_mode/task.rs:147`）是批量任务核心。

`Plan` enum（`plan.rs:123`）是流计算计划 DAG：Constant/Get/Let/Mfp(MapFilterProject)/Reduce/Join/Union。`TypedPlan`（`plan.rs:31`）带 schema。`ReducePlan`（`plan/reduce.rs:39`）Distinct/Accumulable。

## 调用链路

**Streaming 流式**（创建→增量输入→计算→写回）：

```
FlowDualEngine::create_flow() → 按 FlowType 分发           flownode_impl.rs:667
StreamingEngine::create_flow_inner()                        adapter.rs:753
  → FlownodeContext::assign_global_id_to_table（为 source/sink 分配 GlobalId）
  → register_task_src_sink（注册 SourceSender/sink_receiver）
  → sql_to_flow_plan()                                       df_optimizer.rs:88
     （SQL → DataFusion LogicalPlan → Substrait → TypedPlan）
  → create_table_from_relation（自动建 sink 表）             adapter.rs:836
  → WorkerHandle::create_flow → Worker::create_flow          worker.rs:121,253
     → Context::render_source_batch / render_plan_batch / render_unbounded_sink_batch
        （把 TypedPlan 编译成 DFIR 数据流图）                compute/render.rs:124
增量输入：
FlowDualEngine::handle_flow_inserts() → StreamingEngine::handle_inserts_inner()  flownode_impl.rs:1036
  → FlownodeContext::send → SourceSender::send_rows（背压：buf > BATCH_SIZE*4 时 yield）
主循环：
StreamingEngine::run() → run_available() → WorkerHandle::run_available → Worker::run_tick
  → ActiveDataflowState::run_available → Dfir::run_available（执行 DFIR 图）
  → flush_all_sender 推送 batch 到 broadcast channel
  → generate_writeback_request → batches_to_rows_req → FrontendInvoker::row_inserts/deletes
     （经 gRPC 写回 frontend → datanode 物化表）
```

**Batching 批量**（标记 dirty → 执行查询 → 写回）：

```
BatchingEngine::create_flow_inner()                        batching_mode/engine.rs:530
  → sql_to_df_plan → find_time_window_expr → EvalSchedule::from_config
  → BatchingTask::try_new → check_or_create_sink_table → validate_sink_table_schema
  → spawn_global → start_executing_loop（有 EVAL INTERVAL → scheduled；无 → adaptive）task.rs:963
增量输入（标记 dirty）：
handle_inserts_inner() → 按 table_id 分组 → TimeWindowExpr::handle_rows → DirtyTimeWindows::add_lower_bounds  engine.rs:297
计算：
BatchingTask::execute_once_serialized_with_outcome()        task.rs:419
  → gen_insert_plan_unlocked → gen_query_with_time_window    task.rs:1319
     → TaskState::gen_scoped_filter_exprs（从 DirtyTimeWindows 生成时间范围过滤）
     → AddFilterRewriter 注入 WHERE、ColumnMatcherRewriter、apply_df_optimizer
     → 构建 DmlStatement（INSERT INTO sink SELECT ...）
  → execute_logical_plan_unlocked                            task.rs:579
     → breakup_insert_plan → encode_insert_plan_request（Substrait 编码）
     → FrontendClient::query_with_terminal_metrics（送 frontend 执行，直接写 sink）
     → TaskState::after_query_exec（更新 checkpoint）
```

## 核心实现

### 双引擎：Streaming vs Batching

Streaming 基于 DFIR（differential dataflow），数据以 `(Row, Timestamp, Diff)` 流动（+1 插入/-1 删除），低延迟、支持 CDC，但 JOIN/Union 仍是 WIP（`compute/render.rs:135` 返 NotImplemented）。Batching 基于时间窗口批量查询，支持完整 SQL（JOIN/UNION/CTE）但延迟较高。`FlowDualEngine` 按 `FlowType` 分发（`flownode_impl.rs:667`）。两种模式覆盖不同场景。

### Batching 增量计算：DirtyTimeWindows

不是每次全表扫描，而是：数据插入时按 `time_window_expr`（如 `date_bin`）把时间戳对齐到窗口边界标记 dirty（`state.rs:438`）；查询时只查 dirty 窗口的时间范围（`AddFilterRewriter` 注入 WHERE，`task.rs:1319`）；成功后从 DirtyTimeWindows 移除已处理窗口（`state.rs:601`）。大幅降低计算量。

### Checkpoint 模式切换：FullSnapshot → Incremental

`CheckpointMode`（`state.rs:916`）：`FullSnapshot`（全量快照，首次/修复用）→ `Incremental`（基于 region watermark/sequence number，只查 (checkpoint, current_watermark] 范围）。切换条件：FullSnapshot 成功且所有参与 region 返回 watermark → `advance_checkpoints`（`:160`）→ Incremental。增量不安全（source 非 append-only）时永久回退 FullSnapshot（`disable_incremental`，`:146`）。

### Fenced Repair

从 Incremental 回退 FullSnapshot 修复 dirty windows 时，冻结高水位线 `H`，所有修复查询在 `H` 快照上执行，新数据不影响修复过程（`state.rs:190`、`task.rs:182` `QueryCoverage::FencedRepairChunk`），防修复期间新数据导致不一致。

### sink table 自动创建与维护

flow 创建时若 sink table 不存在，按 flow plan schema 自动建表，加 `update_at`（毫秒时间戳）+ `__ts_placeholder`（时间索引占位）；已存在则校验列类型（`adapter.rs:511`）。Streaming 经 `FrontendInvoker::row_inserts`、Batching 经 INSERT INTO 写回。

### SQL → Substrait → TypedPlan

刻意走 Substrait 中间格式而非直接从 DataFusion LogicalPlan 转（`df_optimizer.rs:88`）：Substrait 是跨引擎标准计划格式，解耦 DataFusion 版本与 flow 内部 plan 表示，`transform/` 可独立测试。

### 背压与 Worker 单线程

`SourceSender` 在 send_buf 超 `BATCH_SIZE*4` 时 `yield_now`（`node_context.rs:175`），broadcast channel 容量 `BROADCAST_CAP=1024`（`repr.rs:55`）。DFIR 的 `Dfir` 是 `!Send`，`Worker` 跑在固定线程，经 `InterThreadCall`（mpsc + oneshot）收命令（`worker.rs:309`）——differential dataflow 内部状态非线程安全，单线程避免锁。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略（双引擎） | `FlowDualEngine` 持 Streaming/Batching（`flownode_impl.rs:66`） | 覆盖低延迟/复杂 SQL 两场景 |
| 适配器 | `FlownodeContext`/`SourceSender`（`node_context.rs:90`） | 外部 region 数据适配为 DiffRow/Batch |
| 命令 | `Worker` 的 `Request` enum（`worker.rs:429`） | DFIR `!Send`，跨线程经 channel |
| 管道-过滤器 | `Plan` enum DAG（`plan.rs:123`）、`render_plan_batch`（`compute/render.rs:124`） | DAG 表达力强、复用 DataFusion 优化器 |
| 增量计算/物化视图 | DFIR DiffRow（`repr.rs:38`）、DirtyTimeWindows（`state.rs:438`） | 自动维护增量聚合 |
| 观察者 | `HeartbeatTask`（`heartbeat.rs:61`） | 向 metasrv 发 FlowStat |

## 模块间交互

依赖 `query`（QueryEngine/SQL）、`datafusion`、`dfir_rs`(hydroflow)、`substrait`、`common_meta`（FlowMetadataManager/TableMetadataManager/heartbeat）、`meta_client`、`operator`（Inserter/Deleter）、`catalog`、`api`、`datatypes`/`table`/`store_api`/`session`/`servers`。从 datanode 取数（Streaming 经 SourceSender channel，Batching 经 FrontendClient gRPC 查 frontend→datanode），写回物化表（Streaming `FrontendInvoker::row_inserts`，Batching INSERT INTO）。向 metasrv 注册（`HeartbeatTask` 心跳 + `ConsistentCheckTask` 对账，`flownode_impl.rs:505`）。启动时从 metasrv 恢复所有 flow（`reconcile_flows_from_metadata`，`:489`）。

## 扩展方式

- **新增流式聚合**（如 median）：`plan/reduce.rs` `ReducePlan` 加变体，`expr/relation/func.rs` `AggregateFunc` 加 variant，`expr/relation/accum.rs` 实现 `Accum` trait，`transform/aggr.rs` Substrait→TypedPlan 映射，`compute/render/reduce.rs` DFIR 渲染。
- **新增 transform/窗口**（如 hop）：`transform.rs` 新建 struct 实现 `Function` trait，`register_function_to_query_engine`（`:110`）注册，`expr.rs` 加常量，`batching_mode/time_window.rs` 扩展 `TimeWindowExpr`。
- **为 Streaming 实现 JOIN**：`plan/join.rs` 完善，`compute/render/` 新增 join 渲染，`render.rs:135` NotImplemented 替换为实际调用。
