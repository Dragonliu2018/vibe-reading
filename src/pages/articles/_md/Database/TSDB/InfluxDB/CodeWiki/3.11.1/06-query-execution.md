---
source:
  type: "源码解读"
  project: "InfluxDB"
  url: "https://github.com/influxdata/influxdb"
title: "查询执行"
date: "2026-08-20T13:07:26+08:00"
category: [Database, TSDB, InfluxDB, CodeWiki, "3.11.1"]
tags: ["InfluxDB", "Rust", "TSDB"]
description: "InfluxDB 3 Core 查询执行：基于 Apache DataFusion，IOxSessionContext god node，DedicatedExecutor 线程池隔离，三语言统一"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/00-overview)

---

## 模块定位

本模块是查询引擎层，把 SQL/InfluxQL/FlightSQL 三种语言统一到 Apache DataFusion 执行栈。`influxdb3_query_executor`（`QueryExecutorImpl`/`Database`/`QueryTable`）是入口门面，`core/iox_query`（`IOxSessionContext`/`Executor`/`ChunkTableProvider`）是 DataFusion 集成核心。设计哲学是"不自研引擎，专注时序特有需求"——DataFusion 提供 SQL parser/CBO 优化器/向量化执行/Parquet reader，IOx 通过 `ExtensionPlanner`/自定义 analyzer/optimizer 扩展而非替换，注册时序特有节点（`StreamSplitExec`/`DeduplicateExec`/`GapFill`/`SeriesLimit`）。边界：从 `query_sql`/`query_influxql` 进入到 `SendableRecordBatchStream` 返回，不涉及 HTTP 路由（见 [HTTP API 服务](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/02-http-server)）。

## 模块架构

`QueryExecutorImpl`（`lib.rs:60`）实现 `QueryExecutor`（HTTP REST 入口）与 `QueryDatabase`（gRPC Flight 入口）双 trait。`Database`（`lib.rs:531`）是适配器，同时实现 `QueryNamespace`（IOx 内部）、`CatalogProvider`、`SchemaProvider` 三 trait，暴露 `iox`（用户 schema）与 `system`（系统表）两个 schema。`QueryTable`（`lib.rs:718`）impl `TableProvider`，`scan` 从 `write_buffer` 获取 chunks。`IOxSessionContext`（`core/iox_query/src/exec/context.rs:435`）是 god node，聚合 DataFusion `SessionContext` + `DedicatedExecutor` + `SpanRecorder` + `MemoryMonitor`。`Executor`（`exec.rs:163`）持有 DedicatedExecutor 线程池与 `RuntimeEnv`。`ChunkTableProvider`（`provider.rs:134`）适配 `Vec<QueryChunk>` 为 DataFusion `TableProvider`。

## 调用链路

```
HTTP /api/v3/query_sql → route_request → query_sql
  └─ QueryExecutorImpl::query_sql()  [lib.rs:158]
       ├─ get_db_namespace(database)  → catalog.db_schema → Database::new
       ├─ query_database_sql(db, query, params)  [lib.rs:293]
       │    ├─ db.record_query() → QueryCompletedToken 状态机
       │    ├─ db.new_query_context()  [lib.rs:625]  ★ 构造 IOxSessionContext
       │    │    └─ IOxSessionConfig::new(exec, runtime, mem_pool)
       │    │         .with_default_catalog(self).build()  [context.rs:282]
       │    │         (注册 analyzer/logical/physical optimizer + scalar/window/aggregate + UDTF)
       │    ├─ Planner::new(&ctx).sql(query, params)  [query_planner.rs:38]
       │    │    └─ ctx.run(async {                    ← DedicatedExecutor 线程池
       │    │         SqlQueryPlanner::logical_plan()  [frontend/sql.rs:19]
       │    │           → ctx.sql_to_logical_plan → DataFusion create_logical_plan
       │    │         ctx.create_physical_plan()      [context.rs:595]
       │    │           → IOxQueryPlanner + IOxExtensionPlanner
       │    │         ★ DataFusion 调 TableProvider::scan()
       │    │         QueryTable::scan()  [lib.rs:790]
       │    │           └─ chunks() → write_buffer.get_table_chunks
       │    │           └─ ProviderBuilder → ChunkTableProvider::scan()  [provider.rs:202]
       │    │                → chunks_to_physical_nodes (RecordBatchesExec / DataSourceExec+pruning)
       │    │                → DeduplicateExec → FilterExec → ProjectionExec
       │    │       })
       │    └─ ctx.execute_stream(plan)  [context.rs:630]
       │         └─ CrossRtStream (mpsc channel(1) 跨 runtime 桥接) → SendableRecordBatchStream
       └─ → HTTP Response (RecordBatch)
```

## 核心实现

### IOxSessionContext god node 设计

`IOxSessionContext`（`context.rs:435`）聚合 DataFusion `SessionContext` + `DedicatedExecutor` + `SpanRecorder` + `MemoryMonitor`。查询需同时管理 CPU 调度、分布式追踪、per-query 内存控制，集中到一个对象减少传递成本。`child_ctx()`（`context.rs:709`）创建子上下文（仅替换 SpanRecorder），保持其他引用不变形成 span 树不复制重资源。每次 `sql_to_logical_plan`/`create_physical_plan`/`execute_stream` 都通过 `child_ctx` 创建带名子 span，实现细粒度追踪。`build()`（`context.rs:282-365`）注册 `register_iox_analyzers`（`context.rs:348`）、`register_iox_logical_optimizers`（`context.rs:349`）、`register_iox_physical_optimizers`（`context.rs:350`）、`register_iox_scalar_functions`/`register_selector_aggregates`/`register_iox_window_functions`，并注册 `IOxExtensionPlanner` 处理 `StreamSplitNode`/`GapFill`/`SeriesLimit`/`SleepNode`。

### DedicatedExecutor CPU/IO 线程池隔离

所有 DataFusion 计划与执行在 `DedicatedExecutor`（`core/executor/src/lib.rs:101`）的独立 tokio runtime 上运行，不与 HTTP/gRPC IO runtime 共享。DataFusion 计算是 CPU-bound，tokio 协作式调度会让长时间 CPU 任务延迟 IO 请求 poll，影响小请求吞吐。`DedicatedExecutor` 创建独立线程（低优先级，不抢占健康检查），`IOxSessionContext::run()`（`context.rs:687`）把 future spawn 到其上，通过 oneshot channel 传回值。`CrossRtStream`（`context.rs:681`）用 `tokio::sync::mpsc::channel(1)` 桥接——driver future 在 DedicatedExecutor 拉取数据，ReceiverStream 在 IO runtime 安全 poll；driver panic 时发送 `Err(Context("Join Error (panic)"))`。`PerQueryMemoryPool`（`memory_pool.rs:36`）为每查询创建独立内存池，`MonitoredMemoryPool` 用 `AllocationMonitor` 跟踪堆内存。

### Pruning 下推过滤到 Parquet

`prune_chunks()`（`core/iox_query/src/pruning.rs:77`）收集每 chunk 的 `Statistics`（min/max/null_count），实现 DataFusion `PruningStatistics` trait。`ChunkPruningStatistics`（`pruning.rs:155`）将 chunk 统计暴露给 DataFusion `PruningPredicate`，后者把过滤条件改写为对 min/max 的判断（`col > 100` → `max(col) > 100`），不满足的 chunk 被标记 `false` 不进物理计划。`BucketPartitionPruningOracle`（`pruning_oracle.rs:16`）支持基于 tag 哈希分区的精确裁剪。Pruning 失败不影响正确性（`pruning.rs:71` 注释），只是性能退化。`ChunkTableProvider::scan` 手动在 `DeduplicateExec` 之上加 `FilterExec` 确保过滤在去重后执行。

### 三语言统一与 last-cache 快路径

三种前端产出相同 `LogicalPlan`，后端统一：SQL（`SqlQueryPlanner::logical_plan`，DataFusion `create_logical_plan`）、InfluxQL（`InfluxQLQueryPlanner::statement_to_plan`，手动构建 LogicalPlan）、FlightSQL（`FlightSQLPlanner::do_get_logical_plan`，转 Flight 命令）。统一点在 `IOxSessionContext::create_physical_plan`。Last-value 查询走 UDTF 快路径：`Database::new_query_context`（`lib.rs:641-654`）注册 `LAST_CACHE_UDTF_NAME`/`DISTINCT_CACHE_UDTF_NAME`，用户 `SELECT * FROM last_cache(...)` 直接命中内存缓存绕过 Parquet 扫描，实现 <10ms 响应。过滤下推声明 `Inexact`/`Exact`（`lib.rs:787`）——去重开启时 `Exact`（filter 可安全下推但不被跳过），去重关闭时 `Inexact`（chunk 级 pruning 近似，DataFusion 加 FilterExec）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 前端/后端分离 | `SqlQueryPlanner`/`InfluxQLQueryPlanner`/`FlightSQLPlanner` vs `IOxSessionContext` | 三前端产出统一 LogicalPlan，后端不关心语言 |
| 策略 | `Planner` 选择前端 `query_planner.rs:38` | 按调用者选 SQL/InfluxQL 策略 |
| 适配器 | `Database` 三 trait `lib.rs:598/668/689` + `ChunkTableProvider` | IOx chunk 模型适配 DataFusion |
| 扩展点 | `IOxExtensionPlanner` `context.rs:98` | DataFusion ExtensionPlanner 插件机制 |
| Builder | `IOxSessionConfig` `context.rs:158` + `ProviderBuilder` `provider.rs:89` | 链式构建会话/chunk provider |

## 模块间交互

`QueryExecutorImpl` 持有 `catalog: Arc<Catalog>`、`write_buffer: Arc<dyn WriteBuffer>`、`exec: Arc<Executor>`、`query_execution_semaphore`（并发限制）、`query_log`、`processing_engine`（`OnceLock`，双向链接）。`QueryTable::chunks` 从 catalog 取 `TableDefinition` + retention period cutoff，从 `write_buffer.get_table_chunks` 取实际数据（内存 buffer + 已持久化 Parquet）。Object store 注册在 `Executor` 的 `RuntimeEnv`（`exec.rs:267`），物理计划 `DataSourceExec` 通过 `RuntimeEnv` 的 object_store_registry 读 Parquet。`QueryCompletedToken` 状态机（`lib.rs:303`）记录 `StateReceived→LogicallyPlanned→PhysicallyPlanned→ExecutionPermit`，每错误路径调 `token.fail()` 确保查询日志记录最终结果。

## 扩展方式

- **新增 SQL 标量函数**：`core/query_functions/src/` 加函数实现，`register_iox_scalar_functions`（`context.rs:358`）链加 `inner.register_udf(...)`，无需改 QueryExecutorImpl。
- **支持新查询语言（如 PromQL）**：新建 `core/iox_query/src/frontend/promql.rs` 实现 `PromQLQueryPlanner` 转 LogicalPlan；`Planner` 加 `promql()` 方法；`QueryExecutor` trait 加 `query_promql`；`QueryExecutorImpl` 实现；HTTP 路由加 `/api/v3/query?format=promql`。
- **新增物理优化规则**：`core/iox_query/src/physical_optimizer/` 加规则实现 `PhysicalOptimizerRule`；`register_iox_physical_optimizers`（`context.rs:350`）加 `.add_rule(...)`。
