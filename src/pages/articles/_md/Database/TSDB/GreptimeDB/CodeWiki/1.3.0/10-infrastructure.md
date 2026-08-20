---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "infrastructure 基础设施"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "运行时", "RegionEngine", "procedure", "插件系统"]
description: "infrastructure——全仓共享基础设施与存储契约：named runtime、Plugins、MemoryManager、Procedure 框架与 RegionEngine trait。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`common/*`（~16.4 万行、546 文件、30+ 子 crate）+ `store-api`/`datatypes`/`table`/`catalog` 是全仓共享的基础设施与存储契约层。它们被所有上层组件频繁复用（高扇入：`datatypes` 1448 次、`store_api` 1387 次、`common_meta` 1153 次、`api` 943 次），但不含业务逻辑——按 Step 2 分量门槛归入基础设施附录而非独立模块。这一层定义了运行时隔离、错误范式、内存控制、过程框架、插件系统，以及存储引擎的契约（`RegionEngine` trait）与核心数据结构。

## 模块架构

按职责分四组：

**运行时与进程**：`common-runtime`（`src/common/runtime/`）按负载隔离 named runtime——`define_global_runtime_spawn!` 宏生成 `spawn_global`/`spawn_query`/`spawn_ingest`/`spawn_compact`/`spawn_hb`，分别跑通用 worker/查询/写入/压缩/心跳。产品组件必须用这些 spawn 而非自建 tokio runtime，CPU 密集或阻塞走 `spawn_blocking_*`，**绝不**在 async 里 `block_on`（死锁，architecture-invariants 第 3 条）。`common-base` 提供 `Plugins`（`plugins.rs`，anymap2 按类型注册，同类型重复注册 panic 是 fail-fast）、log compaction 等。

**配置/错误/遥测/内存**：`common-config`（`Configurable` trait，三级优先级 file > env > default，env 用 `__` 分隔映射嵌套字段、列表逗号分隔，`config.rs:29`）；`common-error`（snafu `Error` + `ErrorExt`，`ext.rs`，`status_code()` 决定客户端可见与脱敏，`retry_hint()` 标记可重试，非测试代码禁 panic）；`common-telemetry`（日志/metrics/tracing，`set_panic_hook`）；`common-memory-manager`（`MemoryManager` 用 Semaphore 做逻辑配额控制，配 `common-mem-prof` 做物理内存监控）。

**过程框架/元数据/记录**：`common-procedure`（`ProcedureManagerRef`、`LocalManager`，`Procedure`/`Status`/`LockKey` trait——状态机持久化与崩溃恢复，被 meta-srv 复用）；`common-meta`（`TableInfo`/`TableRoute`/`RegionRoute` 等元数据类型、`KvBackendRef`/`ElectionRef`、`TableMetadataManager`/`FlowMetadataManager`、ddl/peer/lock_key/region_keeper）；`common-recordbatch`（`SendableRecordBatchStream`、`QueryMemoryTracker`）；`common-wal`（`WalOptions`、WAL provider 抽象 Kafka/Local）；`common-time`/`common-catalog`/`common-session`/`common-grpc`/`common-options`/`common-plugins`/`common-pprof`/`common-stat`/`common-substrait`/`common-function`/`common-test-util`/`common-version`。

**存储契约与数据结构**：`store-api`（`region_engine.rs` 定义 `RegionEngine` trait——`name`/`handle_request`/`handle_query`/`handle_batch_open_requests`/`region_statistic`/`stop` 等，4 个实现 `MitoEngine`/`MetricEngine`/`FileEngine`/`MockRegionEngine`；`storage/descriptors.rs:51` `RegionId` 64 位编码 TableId 32 + RegionNumber 32，RegionNumber 内部 Group(8)+Sequence(24) 支持 region 分组）；`datatypes`（`ConcreteDataType`、`Vector`、`ColumnSchema`、`ColumnDefaultConstraint`——Arrow 列式数据类型）；`table`（`Table` trait、`TableId`、`TableInfo`、`InsertRequest`/`DeleteRequest`、`validate_table_option` 白名单）；`catalog`（`CatalogManagerRef`，catalog/schema/table 元数据管理）。

## 调用链路

**Plugins 注册与取用**：

```
Plugins::new()                                          common/base/src/plugins.rs
  → insert::<T>(Arc<T>)（anymap2 按类型 Any::type_id 注册）
  → get::<T>() → Option<Arc<T>>
  # 同类型重复注册 → panic（fail-fast）
```

**Procedure step 执行 + 持久化 + 恢复**：

```
ProcedureManager::submit(procedure_with_id)             common-procedure
  → spawn 执行 procedure.execute()
     → state.next() → (Box<dyn State>, Status::executing(need_persist))
        → need_persist=true 时 dump()（serde 序列化状态）写 KV backend
崩溃恢复：
新 leader 启动 → ProcedureManager::start()
  → 从 KV backend 读取未完成 procedure 的 JSON
  → from_json()（typetag serde 反序列化恢复 State）
  → 续跑 state.next()
```

## 核心实现

### RegionEngine trait：存储引擎契约

`RegionEngine` trait（`store-api/src/region_engine.rs`）是存储引擎与上层的契约。`datanode` 经 `RegionServer` 通过 trait（而非引擎内部）驱动引擎——`RegionServerInner::handle_request`（`region_server.rs:1589`）按 region_id 找 `RegionEngineRef`（mito2 或 metric-engine），调 `engine.handle_request`。这实现引擎可插拔（mito2/metric-engine/file-engine/Mock 都实现该 trait）。architecture-invariants 第 2 条强调：common-* 不得依赖引擎，`frontend` 经 operator/query/catalog 而非 datanode internals 访问存储，standalone 是唯一 bridge（`RegionServer` 适配器 `standalone/src/datanode_manager.rs`）。

### named runtime 负载隔离

按 workload 分区 runtime，让一种负载不能饿死另一种：写入爆不会拖垮查询。宏 `define_global_runtime_spawn!` 生成每个 runtime 的 `spawn_*` 函数，runtime 构造只在进程启动或 test harness。详见 architecture-invariants 第 3 条。

### MemoryManager 逻辑配额

用 Semaphore 做配额控制而非直接跟踪实际分配——控制"各子系统声明的预计使用量"（逻辑配额），配 `common-mem-prof`/`pprof` 做物理内存监控。mito2 的 `WriteBufferManager` 与 compaction `CompactionMemoryManager` 都消费它做背压。

### Plugins 插件系统

`Plugins`（`common/base/src/plugins.rs`）用 anymap2 按类型注册，避免构造函数参数爆炸。meta-srv 的 `SelectorFactory`、`HeartbeatHandlerGroupBuilderCustomizer` 都经 Plugins 注入——`bootstrap.rs:429` 检查有无插件注册选择器替换默认。fail-fast（同类型重复注册 panic）。

### Procedure 状态机持久化

`Procedure`/`Status`/`LockKey` trait + `typetag::serde` 序列化——多步分布式操作可序列化、崩溃恢复。meta-srv 的 region_migration/repartition procedure 复用此框架（见 [05-meta-srv](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/05-meta-srv)）。

### RegionId 编码

`RegionId` 64 位 = TableId(32) + RegionNumber(32)，RegionNumber = Group(8) + Sequence(24)。metric-engine 用 group 区分 data region 与 metadata region（`METRIC_DATA_REGION_GROUP`/`METRIC_METADATA_REGION_GROUP`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| trait 契约 | `RegionEngine`（`store-api/region_engine.rs`）、`Table`、`QueryEngine` | 解耦引擎实现与上层，可插拔 |
| 插件系统 | `Plugins`（`common/base/plugins.rs`） | anymap2 按类型注册，避免参数爆炸 |
| 状态机 | `Procedure`/`Status`（`common-procedure`） | 多步操作可序列化、崩溃恢复 |
| 运行时隔离 | named `spawn_*`（`common-runtime/global.rs:177`） | 按负载分区防饿死 |
| 错误范式 | snafu + `ErrorExt`（`common-error/ext.rs`） | `status_code` 决定可见与脱敏 |

## 模块间交互

这些契约 crate 被全仓依赖：`store_api` 被 mito2/metric-engine/operator（1387 次）；`datatypes` 几乎所有（1448 次）；`common_meta` 被所有组件（1153 次）；`common_error`/`common_telemetry`/`common_base`/`common_runtime` 被所有。`api`（greptime-proto，943 次）是 gRPC wire 类型来源。`object-store` 抽象对象存储（S3/Azure/GCS/OSS）。architecture-invariants 第 2 条强制依赖只向下：common-* 不依赖引擎/frontend/datanode/meta-srv，新依赖经根 `Cargo.toml` 的 `[workspace.dependencies]` 声明。

## 扩展方式

- **新增 region engine 实现**：实现 `RegionEngine` trait（`store-api/src/region_engine.rs`），在 `src/datanode/src/datanode.rs` 启动时构造并注册到 `region_engines`，让 `CreateTableExpr.engine` 接受新引擎名（`sql/parsers/create_parser.rs:1106`）。
- **新增 procedure**：复用 `common-procedure` 的 `Procedure`/`State` trait（`typetag::serde`），在 meta-srv 注册 loader（见 [05-meta-srv](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/05-meta-srv) 扩展方式）。
- **新增插件**：实现 `SelectorFactory`/`HeartbeatHandlerGroupBuilderCustomizer` 等 trait，经 `Plugins` 注入，在 `bootstrap.rs` 检查并替换默认实现。
