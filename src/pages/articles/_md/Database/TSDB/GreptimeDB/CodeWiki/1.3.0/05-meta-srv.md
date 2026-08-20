---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "meta-srv 元数据协调"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "元数据", "procedure", "leader选举", "region迁移"]
description: "meta-srv——Metasrv 协调组件：leader 选举、procedure 状态机、心跳 handler 链、region 分配与迁移 failover。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`meta-srv`（`src/meta-srv/`，~5.3 万行）是 GreptimeDB 的 Metasrv 组件，负责集群元数据管理、路由、region 分配/repartition、procedure 框架、心跳、选主、安全。它背靠可插拔 KV 层（etcd 或 PostgreSQL/MySQL/RDS），通过 gRPC 心跳双向流与 datanode/frontend/flownode 通信，用 procedure 状态机协调跨节点多步操作（如 region 迁移）。它是分布式模式下唯一有状态的控制平面。

## 模块架构

`Metasrv`（`metasrv.rs:561`）是核心结构，持有：`StateRef`（Leader/Follower）、`KvBackendRef`（可插拔后端）、`LeaderCachedKvBackend`（leader 节点缓存层）、`MetaPeerClient`（follower 代理到 leader）、`SelectorRef`（datanode/flownode 选择器）、`HeartbeatHandlerGroupRef`（handler 链）、`ElectionRef`（选主）、`ProcedureManagerRef`、`MailboxRef`（心跳邮箱）、`TableMetadataManagerRef`、`RegionMigrationManagerRef`、`RegionSupervisorTicker`、`CacheInvalidatorRef` 等。

`Context`（`metasrv.rs:433`）是心跳处理上下文。`BackendImpl`（`metasrv.rs:96`）枚举 KV 后端：`EtcdStore`（默认）/`MemoryStore`/`PostgresStore`/`MysqlStore`（feature-gated）。`MetasrvBuilder`（`metasrv/builder.rs:98`）链式注入。

## 调用链路

**region 分配（建表）**：DDL 请求到 `service/procedure.rs:110 ddl()` → `check_leader!` 验证 → `ddl_manager.submit_ddl_task`。DDL task 执行到分配阶段经 `MetasrvPeerAllocator`（`common-meta/ddl/allocator/`）→ `Selector::select`。以 `RoundRobinSelector`（`selector/round_robin.rs:99`）为例：`get_peers`（`discovery.rs:46` 经 `MetaPeerClient::active_datanodes` 检查 lease）→ 按 node_id 排序 → `counter.fetch_add(1) % len` 轮询。分配结果写 `TableRouteValue` 持久化。

**region 迁移 procedure**（`procedure/region_migration/`）：

```
gRPC migrate() → check_leader! → lookup_datanode_peer            service/procedure.rs:163
  → region_migration_manager.submit_procedure()                   manager.rs:544
     （insert_running_procedure 获取 Guard 防重复 + verify_task + verify_table_route）
     → 构造 RegionMigrationProcedure（初始 RegionMigrationStart）
     → procedure_manager.submit
        → spawn_global 异步等待
  → execute() 调 state.next()                                     region_migration.rs:943
状态流转：
  RegionMigrationStart → OpenCandidateRegion → FlushLeaderRegion
  → UpdateMetadata::Downgrade → DowngradeLeaderRegion → UpgradeCandidateRegion
  → UpdateMetadata::Upgrade → CloseDowngradedRegion → RegionMigrationEnd
  （失败 → UpdateMetadata::Rollback → RegionMigrationAbort）
每步通过 Mailbox 与 Datanode 通信：
  ctx.mailbox.send(&Channel::Datanode(peer_id), msg, timeout)     handler.rs:519
     → HeartbeatMailbox（嵌入 HeartbeatResponse 推送，datanode 下次心跳回复）
```

## 核心实现

### Procedure 状态机

`State` trait（`procedure/region_migration.rs:780`，repartition 复用同模式 `procedure/repartition.rs:481`）用 `#[typetag::serde]` 实现 trait object 序列化/反序列化。每个 State 的 `next()` 返回 `(Box<dyn State>, Status)`，`Status::executing(need_persist)` 控制是否持久化。`from_json()`/`dump()` 支持序列化——leader 崩溃后新 leader从上一步恢复（`region_migration.rs:984`）。`LockKey`（`:992`）对 region_id 加 Write lock、catalog/schema 加 Read lock 防并发。错误分 retryable/non-retryable（`:955`）。`ProcedureManagerListenerAdapter`（`procedure.rs:31`）实现 `LeadershipChangeListener`，leader 切换时自动 `start()`/`stop()`。

### Leader 选举

`ElectionRef` trait（common-meta 定义）抽象三种后端：EtcdElection（lease + compare-and-put，`bootstrap.rs:294`）、PostgreSQL election（advisory lock + lease，`:313`）、MySQL election（`GET_LOCK` + lease，`:360`）。**两阶段初始化**（`metasrv.rs:526`、`state.rs:99`）：新 leader 先 `enable_leader_cache=false` → 加载 `LeaderCachedKvBackend` cache → `enable_leader_cache=true`，确保 cache 完全加载后才对外服务。无选举模式（`election=None`，`metasrv.rs:748`）直接作 leader（单节点）。切换时 `in_memory.reset()` + `leader_cached_kv_backend.reset()` 清脏数据（`:688`）。

### KV 层可插拔

`KvBackendRef` trait 在 common-meta 定义，`MetasrvBuilder::kv_backend` 注入。`ChrootKvBackend`（`bootstrap.rs:395`）支持 `store_key_prefix` 前缀隔离，多集群共享 etcd/PG/MySQL。`max_txn_ops`（`:274`，etcd 默认 128）限制单事务操作数防大事务阻塞。`pg_kvbackend`/`mysql_kvbackend` 是编译期 feature。

### Selector 与 placement

`Selector` trait（`selector.rs:33`）抽象选择策略，`select()` 接 `SelectorOptions`（min_required_items/exclude_peer_ids/workload_filter/extensions）。三种实现：`RoundRobinSelector`（默认）、`LoadBasedSelector`（region 数量权重，`selector/load_based.rs:30`）、`LeaseBasedSelector`（随机，`selector/lease_based.rs:26`）。`RegionStatAwareSelector`（`:45`）专用于 region 迁移，感知 region 统计。`SelectorFactory` trait（`metasrv.rs:508`）允许插件替换选择器（`bootstrap.rs:429`）。`WeightCompute` trait（`selector/weight_compute.rs`）可插拔权重计算，注释提到未来改 Capacity Units（`selector.rs:89`）。

### 心跳：信息总线 + 通信通道 + 故障检测

`HeartbeatHandlerGroup`（`handler.rs:322`）持有有序 handler 向量，`handle()` 按序调用，`HandleControl::Done` 可早停。`HeartbeatHandlerGroupBuilder` 提供 `add_handler_last/before/after/replace`（`:653-783`）精确控序。默认链 20+ handler（`:664-699`）：ResponseHeader → KeepLease → CheckLeader → OnLeaderStart → ExtractStat → CollectClusterInfo → Mailbox → RegionLease → RegionFailure → PublishHeartbeat → CollectLeaderRegion → PersistStats …。

心跳三重作用：(1) **信息总线**——datanode 上报 `Stat`（region_stats），handler 链提取；(2) **通信通道**——`HeartbeatMailbox`（`handler.rs:416`）把 `MailboxMessage` 嵌入 `HeartbeatResponse` 推送，procedure 借此发 open/downgrade/upgrade 指令，datanode 下次心跳回复；(3) **故障检测**——`RegionSupervisor`（`region/supervisor.rs:280`）接 `DatanodeHeartbeat` 更新 `PhiAccrualFailureDetector` 心跳时间戳，Ticker 每秒 `detect_region_failure` 调 `is_available`（`:832`），失败触发 region migration failover，`failover_counts` 退避（`:710`），维护模式跳过（`:628`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Procedure 状态机 | `State` trait（`region_migration.rs:780`） | 多步分布式操作可序列化、崩溃恢复 |
| 策略 Selector | `Selector` trait（`selector.rs:33`） | 选择策略可插拔 |
| 责任链 | `HeartbeatHandlerGroup`（`handler.rs:322`） | 心跳 handler 有序处理 |
| Leader 选举 | `ElectionRef`（`metasrv.rs:643`） | 抽象选举后端 |
| Builder | `MetasrvBuilder`（`metasrv/builder.rs:98`） | 依赖链式注入 |
| Observer | `LeadershipChangeNotifier`（`metasrv.rs:655`） | leader 变化通知 WAL/Procedure/Supervisor 等 |

## 模块间交互

依赖 `common_meta`（KV backend/election/table metadata/ddl/peer/lock_key/region_keeper）、`common_procedure`（ProcedureManager）、`api`（gRPC proto）、`common_wal`、`etcd-client`/`tokio-postgres`/`sqlx`、`client`、`partition`。通过 `meta-client` 被 frontend/datanode/flownode 访问（心跳双向流 gRPC + DDL/Procedure gRPC + Cluster gRPC 代理 + Store gRPC）。`check_leader!` 宏（`service/procedure.rs:51`）验证写操作在 leader 上，否则返 `NotLeader` 引导客户端重试。

## 扩展方式

- **新增 procedure**：新建 `procedure/<name>.rs` 定义 `PersistentContext`/`VolatileContext`/`State` 各步骤 + 实现 `Procedure` trait（`type_name`/`execute`/`dump`/`from_json`/`lock_key`/`rollback`），在 `MetasrvBuilder::build` 注册 loader，可选暴露 gRPC 方法（`service/procedure.rs`）。
- **新增 selector 策略**：实现 `Selector` trait，`SelectorType` enum（`selector.rs:86`）加 variant，`bootstrap.rs:409` match 加分支。
- **新增心跳 handler**：实现 `HeartbeatHandler` trait，`handler.rs:654` `add_default_handlers` 注册（或经 `HeartbeatHandlerGroupBuilderCustomizer` 插件化）。
