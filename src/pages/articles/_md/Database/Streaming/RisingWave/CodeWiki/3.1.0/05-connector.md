---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Connector 连接器"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "CDC", "Iceberg", "数据集成"]
description: "Connector 模块解读：source/sink trait 族与 X-macro 注册、CDC 与 Kafka 的本质差异、Iceberg 两阶段 exactly-once、schema registry 双向支持"
readingTime: "26 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

Connector 是外部世界的统一接入层：source 侧 20+ 连接器（Kafka/Pulsar/Kinesis/PubSub/NATS/MQTT/datagen/nexmark/iceberg/fs + 5 种 CDC），sink 侧 35+ 连接器（Iceberg/Doris/ClickHouse/Redis/HTTP...）。它刻意不依赖 expr/frontend/meta——trait 定义与类型转换都只靠 `risingwave_common`，外部世界的变化被隔离在这一个 crate 里。

一个结构性事实：`SplitEnumerator` 的代码在 connector crate，**进程却跑在 meta 服务里**（base.rs:220 注释明确说明）——split 发现是全局决策（哪台 CN 消费哪个 partition），读取是本地行为（SplitReader 跑在 CN）。

## 模块架构

```text
src/connector/src/
├── source/
│   ├── base.rs          # SourceProperties/SplitEnumerator/SplitReader/SplitMetaData trait 族
│   ├── cdc/             # 5 种 CDC（泛型 CdcProperties<T> 共用 Debezium JNI 引擎）
│   ├── kafka/ kinesis/ pubsub/ nats/ mqtt/ datagen/ nexmark/ iceberg/ filesystem/
│   └── manager.rs       # SourceColumnDesc 等列描述
├── sink/
│   ├── mod.rs           # Sink trait + for_all_sinks! 注册表
│   ├── writer.rs        # SinkWriter trait + FormattedSink 模板方法
│   ├── coordinate.rs    # CoordinatedLogSinker（与 meta 协调流）
│   ├── iceberg/         # 两阶段 commit 的湖仓核心
│   ├── encoder/         # sink 侧编码（avro/json/protobuf）
│   └── kafka.rs redis.rs doris.rs ...（35+ 实现）
├── parser/              # format × encode 正交的消息解析
├── schema/              # Confluent/Glue/本地 schema registry 加载
└── macros.rs            # for_all_classified_sources! / for_all_connections! X-macro
+ src/connector/codec/   # 独立子 crate（avro/protobuf 编解码）
```

source 的四个核心 trait（base.rs）构成一个连接器的全部契约：

```rust
// src/connector/src/source/base.rs:111
pub trait SourceProperties: TryFromBTreeMap + Clone + WithOptions + EnforceSecret {
    const SOURCE_NAME: &'static str;
    type Split: SplitMetaData + Into<SplitImpl>;
    type SplitEnumerator: SplitEnumerator<Properties = Self, Split = Self::Split>;
    type SplitReader: SplitReader<Split = Self::Split, Properties = Self>;
}
// :221 跑在 meta 进程（split 发现）
pub trait SplitEnumerator { async fn list_splits(&mut self) ...; async fn on_tick(&mut self) ...; }
// :596 跑在 compute 节点（读消息 → StreamChunk）
pub trait SplitReader { fn into_stream(self) -> BoxSourceChunkStream; ... }
// :959 split 持久化协议（offset 编解码，checkpoint 状态的最小粒度）
pub trait SplitMetaData { fn encode_to_json(&self) -> JsonbVal; fn update_offset(&mut self, ...) ...; }
```

sink 侧对应 `Sink`（mod.rs:777，DDL 入口：`const SINK_NAME` + 关联类型 `LogSinker`）/ `SinkWriter`（writer.rs:34，compute 侧写入）/ `LogSinker`（mod.rs:908，从 log store 消费的常驻循环）三件套，加 meta 侧的 `SinkCommitCoordinator`（mod.rs:925）。`SinkImpl::new` 按 WITH 里 `connector` 属性（`UPSTREAM_SOURCE_KEY`，base.rs:64）小写匹配后经 `match_sink_name_str!` 宏路由到具体 sink。

### 宏生成的注册体系

connector 侧的枚举与分发几乎全部由 X-macro 展开：`for_all_classified_sources!`（macros.rs:16）把 source 分成 CDC 组（Mysql/Postgres/Citus/Mongodb/SqlServer——经 `for_all_sources_inner!` 用 `paste!` 拼出 `MysqlCdc` 等变体名，split 固定为 `DebeziumCdcSplit<T>`）与其他组（Kafka/Kinesis/Nexmark/Datagen/fs...）；`impl_split!` 生成 `SplitImpl` 枚举 + 各 split 的 TryFrom 转换，`impl_connector_properties!` 生成 `ConnectorProperties` 枚举（变体为 `Box<属性类型>`，附 `kind()` 方法），`dispatch_split_impl!`/`dispatch_source_prop!` 以这两个枚举做分发。sink 侧对称的 `for_all_sinks!`（sink/mod.rs:123）展开出 `SinkImpl` 与 `match_sink_name_str!`。

WITH 参数解析（`ConnectorProperties::extract`，base.rs:671）有一个务实的双模式：`deny_unknown_fields` 在**新建 source 时拒绝未知字段**（防拼写错误），但从 meta 恢复既有 catalog 时容忍（前向兼容旧版本持久化的属性）；secret 经 `LocalSecretManager::global().fill_secrets` 填充。

## 调用链路

source 从 split 分配到 StreamChunk：

```text
meta: validate_source_once → SplitEnumerator::list_splits     source_manager.rs:381
 └ SplitAssignment{FragmentId → ActorId → Vec<SplitImpl>} 随 actor schedule 下发
compute: SourceExecutor::execute                              stream/executor/source/source_executor.rs:721
 └ ConnectorProperties::create_split_reader                   base.rs:745
    └ create_split_readers：support_multiple_splits（Kafka/fs 单 reader 多 partition）
       否则每 split 一个 reader + select_all 合流              base.rs:164
 └ parse_message_stream：parse_one_with_txn 写 SourceStreamChunkBuilder   parser/mod.rs:378
    （事务边界、CDC heartbeat、schema change 事件上抛等待）
checkpoint: WaitCheckpointTask 提交 offset                     source/mod.rs:128
   （CDC 经 JNI commit_cdc_offset；Pulsar/PubSub ack；Kafka 靠 consumer group）
```

sink 从 executor 到 commit：

```text
SinkExecutor 写 log_store_writer.write_chunk（计算与外部 IO 解耦）  stream/executor/sink.rs:499
 └ dispatch_sink! → new_log_sinker().consume_log_and_sink(log_reader)
    ├ 非协调：LogSinkerOf 状态机 Uninitialized→EpochBegun→BarrierReceived  writer.rs:123
    └ 协调：CoordinatedLogSinker 与 meta 建流                     coordinate.rs:75
       └ checkpoint 到达 + commit_checkpoint_interval 满足
          → writer.barrier(true) 产出 SinkMetadata
          → coordinator_stream_handle.commit(epoch, metadata) → truncate
meta: SinkCoordinatorManager → CoordinatorWorker 聚合全部 actor 的 metadata  meta/manager/sink_coordination/
 └ TwoPhase: pre_commit → 全体确认 → commit_data（原子 snapshot commit）  iceberg/commit.rs:405/461
writer 失败 → executor 对 log reader rewind → 重建 sinker 重放（幂等保证不重不漏）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `list_splits` in base.rs:221 | split 发现（meta 进程） | on_tick 周期监控 |
| `create_split_readers` in base.rs:164 | reader 构造 | 单/多 split 特判 |
| `parse_one_with_txn` in parser/mod.rs:319 | 消息→行 | 事务控制消息处理 |
| `consume_log_and_sink` in writer.rs:123 | sink 主循环 | 状态机 + truncate |
| `CoordinatedLogSinker::consume_log_and_sink` in coordinate.rs:75 | 协调式提交 | rewind 起点协商 |
| `IcebergSinkCommitter::pre_commit/commit_data` in iceberg/commit.rs:405/461 | 两阶段 | 幂等重试 |

</details>

## 核心实现

### Source trait 为什么以 split 为并发单位

split 是外部系统天然的并行度单位（Kafka partition、Kinesis shard、PG replication slot），也是 checkpoint 状态的最小粒度——`update_offset` 让每个 split 的位点独立持久化，恢复时按 `SplitImpl` 重建 reader 精确续传；meta 才能做 split→actor 的 rebalance。`support_multiple_splits` 特判（base.rs:728）是性能补丁：单 Kafka consumer 拿多 partition 避免建 N 个 TCP 连接。

### CDC 与 Kafka source 的本质差异

拉**事务日志**（有状态连接）vs 拉**消息**（无状态流）：`CdcSplitReader::new` 里 `assert_eq!(splits.len(), 1)`（cdc/source/reader.rs:74）——CDC 一个 split 是一个 Debezium 连接器实例（JNI 线程持有上游连接、slot/wal 位点、事务缓冲），不可能多份实例化；Kafka reader 无状态可任意重分配。CDC offset 是 Debezium 的 JSON sourceOffset（含 file/pos/transaction_id），checkpoint 后经 JNI 显式提交。五种 CDC 共用 `CdcProperties<T: CdcSourceTypeTrait>` 泛型族（cdc/mod.rs:122）——`T` 只是类型 tag（其 `CDC_CONNECTOR_NAME` 常量由 `impl_cdc_source_type!` 宏生成，`concat!` 拼接小写类型名 + "-cdc" 后缀如 mysql-cdc，macros.rs:376），零运行时分发成本。CDC 的事务边界由 parser 的 `TransactionControl::{Begin,Commit}`（parser/mod.rs:286，目前仅 Debezium 事务消息使用）表达——解析到事务控制消息时产生边界而非数据 chunk。

### Iceberg exactly-once：两阶段 commit + meta 协调

每个 actor 的 `IcebergSinkWriter` 在 barrier 产出 SinkMetadata（data/delete file 写结果）→ meta 的 CoordinatorWorker 聚合全部 writer → `pre_commit` 不碰 catalog 只序列化 write_results → 全体确认后 `commit_data` 才对 iceberg catalog 做原子 snapshot commit。Why：iceberg snapshot 是**全表级单点操作**，N 个并行 actor 各自 commit 会 optimistic concurrency 互相冲突，必须收拢单协调者；两阶段保证某 writer 失败时整体 abort 不留"半提交" snapshot。`commit_data` 幂等（trait 注释明示同 epoch 可重调），配合 `commit_retry_num` 处理 meta 自身重试。

### sink decouple：log store + commit_checkpoint_interval

`SinkExecutor` 把 chunk 先写**内部 log store**，sink 消费异步进行——barrier 不再被慢 sink 阻塞。`commit_checkpoint_interval` 摊薄 commit 成本，是吞吐与延迟的显式权衡开关。**只有五种 sink 支持该参数**（`is_sink_support_commit_checkpoint_interval` in mod.rs:771：Iceberg/ClickHouse/StarRocks/DeltaLake/SnowflakeV2），默认 iceberg 60、其他 10 个 checkpoint 提交一次（decouple_checkpoint_log_sink.rs:24-27）。

消费侧有两条 LogSinker 路径（writer.rs）：`LogSinkerOf<W>`（要求 `CommitMetadata = ()`）——write_batch 失败先 abort 再返回错误，仅 checkpoint barrier 才 truncate；`AsyncTruncateLogSinkerOf<W>`（基于 `AsyncTruncateSinkWriter` + `DeliveryFutureManager`，:236）——用 select 同时等 log_reader 下一项与 future_manager 的 truncate offset，收到即可提前 truncate 释放 log store 空间。协调式的 `CoordinatedLogSinker`（coordinate.rs:75）在 checkpoint 上仍要过两道闸：`current_checkpoint >= commit_checkpoint_interval` 计数，或 `should_force_commit_on_checkpoint_barrier`（decouple_checkpoint_log_sink.rs:63，**三条件任一强制提交**：vnode bitmap 更新 / is_stop / 有 schema change）。

### format × encode 正交 + schema registry

`SourceFormat`（协议语义：Plain/Debezium/Maxwell/Canal/Upsert/Native）× `SourceEncode`（字节格式：Json/Avro/Protobuf/Csv/Bytes/Parquet）独立演化，`extract_source_struct`（base.rs:479）校验合法组合。schema registry 双向支持：source 侧 `ConfluentSchemaLoader` 按 name_strategy 推 subject，wire format 里的 magic byte + schema_id 与 Confluent 生态互认；`for_all_connections!` 把 connection 做成**可复用的命名凭据对象**。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| X-macro 注册表 | `for_all_classified_sources!` in macros.rs:16、`for_all_sinks!` in sink/mod.rs:123 | 新增连接器只改一行 |
| 泛型 + PhantomData 类型族 | `CdcProperties<T>` in cdc/mod.rs:122 | 五种 CDC 零成本共用 |
| 协调者 | `SinkCommitCoordinator` in sink/mod.rs:925 | 跨 actor 全序提交 |
| 模板方法 | `FormattedSink::write_chunk` in writer.rs:79 | KV sink 零成本三格式 |
| 回调注入 | `CdcAutoSchemaChangeFailCallback` in base.rs:71 | 不反向依赖 meta |

## 模块间交互

**↔ stream**：source/sink executor 是 trait 的唯一消费方，经 `SourceContext` 注入 metrics/schema-change 通道；**↔ meta**：enumerator 跑在 meta 进程、sink 协调服务在 meta；**↔ 类型系统**：parser 的 `ScalarAdapter::into_scalar` 把 JSON/Avro 值按目标列类型转 `ScalarImpl`（不经 expr crate）；**↔ JNI**：CDC 家族经 `risingwave_jni_core` 调 Java Debezium（独立线程 + mpsc 跨边界）。

## 扩展方式

**新增 source**：`source/<name>/` 实现四 trait → `macros.rs` 的 `for_all_classified_sources!` 清单加一行（枚举/分发/try_from_btreemap 全部宏展开自动获得）→ `source/mod.rs` 挂 pub mod → `base.rs:935` 的 `SourceMeta` 加 variant → frontend `create_source/validate.rs` 校验。

**新增 sink**：`sink/<name>.rs` 实现 `Sink`（复用 `FormattedSink` 可零成本获得三种格式）→ `for_all_sinks!` 加一行 → 需要 exactly-once 时 `is_coordinated_sink() → true` + 实现 `new_coordinator`（参照 iceberg/mod.rs:372），meta 侧零改动。
