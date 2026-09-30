---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Overview"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "流数据库", "物化视图", "增量计算"]
description: "RisingWave v3.1.0 源码解读概览：Rust 流数据库——actor 模型流引擎、Chandy-Lamport barrier checkpoint、Hummock 云原生 LSM 状态存储、SQL 优化器 typestate 五阶段与批/流双执行引擎全景"
readingTime: "55 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** v3.1.0 · **协议** Apache-2.0 · **语言** Rust（edition 2024）· **代码量** ~863,700 行（src/，2,600+ 文件）· **仓库** [GitHub](https://github.com/risingwavelabs/risingwave)

---

## 总览

### 项目简介

RisingWave 是一个用 Rust 从零构建的**流数据库**（streaming database）：它用 SQL 声明物化视图（Materialized View），内部以增量计算持续维护 MV 结果，同时提供 PostgreSQL 协议兼容的即时查询能力。官方当前的定位口号是 "Event Streaming for Agentic AI"——为实时应用和 Agent 提供始终新鲜、毫秒级可查的数据层。

它要替代的是一条传统实时链路：Debezium（CDC）→ Kafka（传输）→ Flink（计算）→ 数据库（服务），四跳四系统的延迟与运维成本，被一个数据库吞下：**ingest、process、serve、store** 四件事在同一个系统内完成。增量计算保证只有受影响的聚合结果被重算，端到端新鲜度 < 100ms；查询结果维护在内部行存里，p99 服务延迟 10-20ms。

**项目当前边界**：负责流处理、增量物化、低延迟服务与状态存储；长期留存与分析查询走 Apache Iceberg 湖仓（DataFusion 执行 Iceberg 查询），RisingWave 自管 Iceberg REST catalog 与 compaction。它不是通用 OLAP 数仓，也不做 OLTP 事务性负载。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| PostgreSQL 协议兼容 | `src/utils/pgwire/` | 简单 + 扩展协议（PREPARE/portal/ResultCache 分页），psql/JDBC 直连 |
| SQL 解析（流语法扩展） | `src/sqlparser/` | fork 自 sqlparser-rs，CREATE SOURCE/SINK/SUBSCRIPTION/CONNECTION/SECRET、WATERMARK、EMIT |
| 查询优化 | `src/frontend/src/optimizer/` | 自研启发式流水线（~35 个 OptimizationStage），非 Cascades |
| 流执行 | `src/stream/` | actor 模型，62 种 executor，barrier 对齐 + 增量计算 |
| 批执行 | `src/batch/` | 火山式拉模型，38 种 executor，Local/Distributed 双模式 |
| 状态存储 | `src/storage/` | Hummock：S3 上的 LSM，epoch MVCC，compactor 独立进程 |
| Source 接入 | `src/connector/src/source/` | Kafka/Pulsar/Kinesis/PubSub/NATS/MQTT + 5 种 CDC（JNI Debezium） |
| Sink 输出 | `src/connector/src/sink/` | 35+ 种（Iceberg/Doris/ClickHouse/Redis...），两阶段 commit exactly-once |
| 表达式/UDF | `src/expr/` | 向量式求值，`#[function]` 宏注册，外部 UDF（Arrow Flight）+ 嵌入 Python/Wasm/JS + AI 函数 |
| 集群元数据与调度 | `src/meta/` | catalog/fragment/cluster 控制器（SQL 事务）、barrier 全局流水线、扩缩容 |
| Iceberg 湖仓 | `src/frontend/src/datafusion/` + connector | 引擎为 Iceberg 的表、流式写入、DataFusion 直查 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| tokio | 核心 | 全异步运行时（每组件独立 multi-thread runtime） |
| tonic / prost | 核心 | gRPC 服务与 protobuf 编解码（`src/prost/` 生成 `risingwave_pb`） |
| foyer | 核心 | SST 两级缓存（内存 LRU + 磁盘 file cache），替代 v3 前的 NewMemCache |
| opendal | 核心 | 对象存储抽象（S3/GCS/OSS/COS/HDFS/Azure Blob） |
| sea-orm + SQLite/Postgres | 核心 | meta 元数据持久化（v2.0 起取代内存 HashMap） |
| madsim | 测试 | 确定性模拟（集群故障注入，`src/tests/simulation/`） |
| arrow-udf-runtime | 可选 | UDF 跨语言运行时（Arrow Flight gRPC 协议） |
| await-tree | 可调试 | 流算子 await 链路追踪（诊断流作业卡点） |
| winnow | 迁移中 | 新解析器组合子（`src/sqlparser/src/parser_v2/`） |

### 版本历史

RisingWave 2021-11 发布 v0.1，2023-07 v1.0（生产可用），此后小步快跑：v2.0（2025）重构 meta 为 SQL-backed controller 层，v3.0（2026-06）起产品叙事转向 Iceberg 湖仓一体化。本文解读的 **v3.1.0（2026-09-21）** 处于这条演进线的最新一环：connector 生态最全（20+ source / 35+ sink）、meta 层完成 SQL 事务化、存储层迁移到 foyer 缓存与事件驱动写路径。

### 顶层上下文图

系统的外部交互方：上游**消息系统与数据库**（Kafka/CDC 的事务日志，经 source 摄入）；下游**查询客户端**（psql/JDBC/任何 PG 兼容工具，经 pgwire）与**外部存储/搜索引擎**（经 sink 写出）；底座是**S3 兼容对象存储**（SST 持久层）。多个 RisingWave 集群间还可通过 subscription（共享 MV 数据流）互联。

---

## 快速上手

代码阅读者最快的验证路径（risedev 是官方开发编排工具）：

```bash
# 1. 构建（首次 ~30 分钟，workspace 90+ crate）
./risedev build

# 2. 起单机集群（默认 ~/risingwave 下 SQLite meta + 内存 hummock + 单进程全组件）
./risedev p   # 或 risedev playground

# 3. psql 连上（4566 端口，PG 协议）
psql -h localhost -p 4566 -d dev -U root

# 4. 端到端验证：建源 → 建 MV → 查询
CREATE SOURCE s (v INT) WITH (connector='datagen');
CREATE MATERIALIZED VIEW mv AS SELECT sum(v) FROM s;
SELECT * FROM mv;   -- 持续增长的求和结果
```

若只想要单二进制直接跑：`cargo build -p risingwave_cmd_all` 后执行 `./risingwave`（裸跑即 single-node 模式，`~/.risingwave` 目录 + SQLite + 内存态 hummock）。

---

## 架构设计解析

### 系统架构

RisingWave 的架构思想可以一句话概括：**把 Flink 的流计算、Flink state 的痛点、数据库的服务与存储，重做成一个存算分离的分布式数据库**。四个进程角色各司其职——Frontend 是无状态 SQL 代理，Compute 是跑 actor 的计算节点，Compactor 是无状态压实工人，Meta 是唯一的"有状态大脑"（元数据 + barrier 调度 + 版本管理）；所有用户数据状态都在 S3 上，计算节点无盘化，因此扩缩容和故障恢复都是分钟级甚至秒级操作。

![分层架构](/vibe-reading/images/articles/risingwave-internals/architecture.svg)

从上到下：**接口层**（pgwire + frontend）负责协议与会话、SQL 全链路（解析→绑定→优化→调度）；**计算层**（stream + batch 双引擎）分别承载长驻增量数据流和一次性快照查询，两套 executor 共享 common 的列式数据结构与 expr 的求值层；**共享层**（expr / sqlparser / common）是纯 Rust 库，无进程形态；**存储层**（hummock + compactor）把状态持久化到 S3 并异步压实。层间依赖单向向下，meta 与 connector 作为独立进程/子系统经 gRPC 与对象存储接入。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 接口层 | `src/utils/pgwire/`、`src/frontend/` | 隔离 PG 协议细节；SQL 理解与调度决策集中于此，核心引擎不感知客户端存在 |
| 计算层 | `src/stream/`、`src/batch/`、`src/compute/` | 承载执行模型本身（actor 增量流 / 火山式拉取），compute crate 是装配组合根 |
| 共享层 | `src/expr/`、`src/sqlparser/`、`src/common/` | 定义全系统共享的数据契约（StreamChunk、类型系统、函数注册表），是依赖图的根 |
| 存储层 | `src/storage/`、`src/object_store/` | 状态持久化与压实，对上只暴露 epoch 语义的 KV 接口 |
| 外部系统 | `src/connector/`、`src/meta/` | 外部世界接入（source/sink）与全局协调（元数据、barrier、版本） |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Typestate（类型状态） | `PlanRoot<P: PlanPhase>` in `src/frontend/src/optimizer/mod.rs:116` | 五阶段计划（Logical→…→Batch/Stream）的合法跃迁编码进类型系统，编译期拦截"未优化就物化"类错误 |
| Reactor 事件循环 | `GlobalBarrierWorker::run_inner` in `src/meta/src/barrier/worker.rs:525` | barrier 是全局心跳，单线程 `tokio::select! { biased }` 免锁消费 7 类事件 |
| 命令模式 | `Command → Mutation → PostCollectCommand` in `src/meta/src/barrier/command.rs:467` | 配置变更"寄生"在 barrier 上：注入期下发 Mutation、收集期落库，两半合成原子变更 |
| Actor 模型 | `Actor<C>` in `src/stream/src/executor/actor.rs:195` | 流计算的最小调度单元，actor 间只经 channel/gRPC 通信，无共享可变状态 |
| X-macro 注册表 | `for_all_sinks!` in `src/connector/src/sink/mod.rs:123`、`for_all_variants!` in `src/common/src/types/macros.rs` | 单一真源清单展开出枚举/分发宏/转换矩阵，新增成员只改一行 |
| proc-macro + linkme | `#[function]` + `FUNCTION_REGISTRY` in `src/expr/core/src/sig/mod.rs:39` | 函数签名在编译期注册、链接期收集，前后端共享同一份签名单 |
| 协调者 | `SinkCommitCoordinator` in `src/connector/src/sink/mod.rs:925` | 跨 actor 的全序提交上收 meta 单点，解决 Iceberg snapshot 级 commit 冲突 |
| 装饰器 | `ManagedExecutor`、`MonitoredStateStore`、`WrapperExecutor` | 取消/监控/指标横切关注点与业务 executor 解耦 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `StreamChunk` | 流数据的最小传输单位：`ops: Arc<[Op]>` + `DataChunk`（列式 + visibility） | 一次消息传递 | 由 source/parser 产出，流经 executor 树，最终物化进 StateTable |
| `Barrier`（`BarrierInner<M>`） | 流内的控制消息：epoch + Mutation + kind | 一个 epoch | 从 meta 注入 source，流经全图，回到 meta 触发 checkpoint |
| `Epoch` / `EpochWithGap` | barrier 的单调递增编号；gap 编码 epoch 内多次 spill | 系统生命周期 | 即 hummock 的 MVCC 版本号，读写快照都由它界定 |
| `Actor` | 流计算最小调度单元（merger + executor 链 + dispatcher） | 作业生命周期 | 挂在 parallel unit 上，经 exchange 与其他 actor 通信 |
| `StateTable` | 算子状态的门面：内存 write buffer + epoch 对齐 flush | actor 生命周期 | 包装 `LocalHummockStorage`，是"一切皆表"的物质基础 |
| `Fragment` / `StreamFragmentGraph` | 切分后的子计划 + 并行度 + dispatcher 拓扑 | 作业生命周期 | meta 按 fragment 调度 actor 到 CN |
| `HummockVersion` | SST 清单的不可变版本 | 每次 commit_epoch | `PinnedVersion` RAII pin 防止读时被 GC |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `Session` / `SessionManager` | `src/utils/pgwire/src/pg_server.rs:81/49` | `SessionImpl`（frontend） | frontend 在 `lib.rs:259` 调 `pg_serve` 挂接 |
| `Execute`（流 executor） | `src/stream/src/executor/mod.rs:244` | 62 种 executor | `from_proto` + `dispatch_stream_node_body!` 宏 |
| `Executor`（批 executor） | `src/batch/src/executor/mod.rs` | 38 种 executor | `register_executor!` + linkme `BUILDER_DESCS` |
| `StateStore` / `LocalStateStore` | `src/storage/src/store.rs` | HummockStorage / Memory（测试） | `StateStoreImpl` enum + opaque type |
| `SourceProperties` / `SplitReader` | `src/connector/src/source/base.rs:111/596` | 20+ source | `for_all_classified_sources!` X-macro |
| `Sink` / `SinkWriter` | `src/connector/src/sink/mod.rs:777`、`writer.rs:34` | 35+ sink | `for_all_sinks!` X-macro |
| `SyncExpression` / `AggregateFunction` | `src/expr/core/src/expr/mod.rs:73`、`aggregate/mod.rs:39` | ~90 文件内建 + 4 种 UDF runtime | `#[function]` 宏 + linkme |
| `GlobalBarrierWorkerContext` | `src/meta/src/barrier/context/mod.rs:87` | 生产 context_impl / 测试 mock | 泛型注入 |
| `Command` | `src/meta/src/barrier/command.rs:467` | ~20 个变体 | `BarrierScheduler::run_command` |

对象关系的骨架（详细交互见各模块文档）：

```text
FrontendEnv ── SessionImpl ── OptimizerContext(P:P PlanRoot)
                                    │ StreamPlan (proto)
                                    ▼
              MetaSrvEnv ── GlobalStreamManager ── BarrierScheduler
                              │                        │ Command
                              ▼                        ▼
                   CatalogController(SQL)      GlobalBarrierWorker ── CheckpointControl
                              │                        │ inject/collect (gRPC control 流)
                              ▼                        ▼
                   StreamActorManager ── Actor ── DispatchExecutor
                              │                        │ StreamChunk / Barrier
                              ▼                        ▼
                   StateTable ── LocalHummockStorage ── SharedBuffer ── S3 (SST)
```

---

## 代码目录

```shell
risingwave/
├── src/
│   ├── frontend/            # SQL 前端 ~167k 行：session/handler(~90 DDL 文件)/binder/
│   │                        #   optimizer/planner/scheduler/stream_fragmenter/
│   │                        #   datafusion( iceberg 查询)/webhook/
│   ├── meta/                # 元数据节点 ~145k 行：barrier/(心跳核心) controller/
│   │                        #   stream/(作业管理) hummock/(版本) manager/ rpc/
│   │                        #   + 独立子 crate meta/service、meta/model(sea-orm)
│   ├── stream/              # 流引擎 ~122k 行：task/(actor 管理) executor/(62 种)
│   │                        #   + from_proto/ exchange/ backfill/ mview/
│   ├── storage/             # Hummock ~97k 行：hummock/(store/event_handler/sstable/
│   │                        #   iterator/shared_buffer/local_version) table/ cache/
│   │                        #   + 独立 compactor 子 crate（独立进程）
│   ├── connector/           # 外部集成 ~96k 行：source/(20+) sink/(35+) parser/
│   │                        #   schema/ + 独立 codec 子 crate
│   ├── common/              # 共享基础 ~69k 行：array/(StreamChunk) types/(DataType)
│   │                        #   catalog/ util/(epoch/row_id/sort) + estimate_size 等子 crate
│   ├── expr/                # 表达式 ~36k 行：core/(trait+注册表) impl/(函数实现)
│   │                        #   macro/(proc-macro)
│   ├── batch/               # 批引擎 ~25k 行 + executors 子 crate（38 种）
│   ├── sqlparser/           # SQL 解析 fork ~19k 行：parser/ast/keywords/ + parser_v2(winnow 迁移)
│   ├── compute/             # CN 装配 ~4.7k 行（组合根：6 个 gRPC service）
│   ├── cmd_all/             # 单二进制入口（multicall：frontend/meta/compute/compactor/single-node）
│   ├── rpc_client/          # meta/compute gRPC 客户端（连接池）
│   ├── prost/               # proto 生成（risingwave_pb，所有进程的共享契约）
│   └── utils/pgwire/        # PG 协议实现（~10k 行，无 RisingWave 语义的通用库）
├── e2e_test/                # 端到端 SLT（sqllogictest）测试套件
├── integration_tests/       # 各 connector 的集成测试
├── docs/dev/src/design/     # 16 篇官方设计文档（streaming/checkpoint/backfill/shared-buffer...）
├── proto/                   # 所有 .proto 契约
└── risedev/                 # 开发集群编排（./risedev p）
```

`src/tests/simulation/`（madsim 确定性模拟）与 `src/tests/sqlsmith`（SQL 模糊测试）是两个特殊目录，前者把整个集群跑在可控的模拟 runtime 上做故障注入，后者生成随机 SQL 喂给 differential 数据湖验证正确性。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/risingwave-internals/module-dependencies.svg)

依赖方向总体单向向下：frontend 几乎依赖全部 crate；common 是依赖图的根（被全仓库 import 3800+ 次）；meta 与 compactor 是独立进程，仅经 gRPC（契约在 `risingwave_pb`）与 frontend/compute 交互，不在 crate 依赖图上。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| Frontend 前端 | SQL 会话与调度决策 | `session.rs` 的 `SessionImpl` | 无状态代理，进程形态与引擎分离 | [01-frontend.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/01-frontend) |
| Meta 元数据中枢 | 元数据、barrier 心跳、扩缩容 | `barrier/worker.rs` 的 `GlobalBarrierWorker` | 全局唯一有状态协调者，正确性的根 | [02-meta.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/02-meta) |
| Stream 流引擎 | actor 增量计算执行 | `task/actor_manager.rs` | 产品的核心价值所在，执行模型与批完全不同 | [03-stream.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/03-stream) |
| Hummock 存储 | epoch MVCC 的 S3 LSM | `hummock/store/hummock_storage.rs` | 云原生状态存储，与计算解耦的弹性之源 | [04-hummock.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/04-hummock) |
| Connector 连接器 | source/sink 外部集成 | `source/base.rs` 的 trait 族 | 外部世界边界，connector 变化不影响引擎 | [05-connector.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/05-connector) |
| Common 共享基础 | 数据契约（chunk/类型/catalog） | `array/stream_chunk.rs` | 全仓库的地基，必须零上层依赖 | [06-common.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/06-common) |
| Expr 表达式 | 向量式求值与函数注册表 | `core/src/sig/mod.rs` 的 `FUNCTION_REGISTRY` | 前后端单一真源，UDF/内建统一 | [07-expr.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/07-expr) |
| Batch 批引擎 | 快照查询执行 | `executor/mod.rs` 的 `Executor` trait | MV 已物化所以批查询是纯拉取，模型正交 | [08-batch.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/08-batch) |
| SQLParser 解析器 | SQL → AST（流语法扩展） | `parser.rs` 的 `parse_create` | fork 自 sqlparser-rs，方言层已删除 | [09-sqlparser.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/09-sqlparser) |
| Pgwire 与进程装配 | PG 协议 + 二进制组装 | `cmd_all/src/bin/risingwave.rs` | 协议库无业务语义；装配是独立关注点 | [10-pgwire-and-process.md](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/10-pgwire-and-process) |

模块间的动态调用顺序见「运行时行为 > 核心运行流程」；批/流两引擎对 StateStore 的不同用法是贯穿主线——流侧 `StateTable` 写增量、批侧 `RowSeqScan` 读快照。

---

## 运行时行为

### 启动流程

单二进制 `risingwave` 的分发（`parse_args` in `src/cmd_all/src/bin/risingwave.rs:172`）同时支持 multicall（docker 里 symlink 成 `meta-node`/`compute-node` 等名字共用一份产物）与子命令模式（`./risingwave meta ...`）；裸跑默认 single-node。

```text
main()                                            cmd_all/src/bin/risingwave.rs:217
 └ parse_args() → Component 枚举                  :172   Compute/Meta/Frontend/Compactor/Ctl/Playground/Standalone/SingleNode
    └ Component::start()
       ├ 分布式：各自 crate::start(opts, shutdown)
       └ standalone()/single_node()                cmd_all/src/standalone.rs:241
          ├ meta → compute → frontend → compactor 顺序 Service::spawn
          │   （每组件独立 multi-thread tokio runtime，线程名 rw-standalone-{name}）
          ├ meta 启动后自旋等 is_server_started()  :261
          └ 关停逆序 compactor → frontend → compute → meta   :384

compute 节点装配（compute_node_serve in src/compute/src/server.rs:93）：
 load_config → MetaClient::register_new(ComputeNode) → start_heartbeat_loop
 → StateStoreImpl::new(hummock, 可带 embedded compactor)        :235
 → BatchManager + MemoryManager + DmlManager
 → BatchEnvironment::new / StreamEnvironment::new（共享同一 StateStore Arc）:380/:400
 → LocalStreamManager::new                                     :412
 → 6 个 gRPC service add_service（Task/Exchange/Stream/Monitor/Config/Health）:470
 → meta_client.activate()（两阶段上线：注册后未激活不接活）      :530
```

对象装配的关键事实：**同一个 `StateStoreImpl` Arc 被批、流两个 Environment 共享**——批与流看到同一个 hummock 版本世界；frontend 侧对应组合根是 `SessionManagerImpl::new → FrontendEnv::init`（frontend/session.rs:303），向 meta 注册、起心跳、建 catalog 缓存与 ComputeClientPool。

### 核心运行流程

下面三条链路覆盖系统的三种核心运转模式：DDL 建流作业（改变系统形态）、流数据持续处理（系统的心跳与日常）、批查询服务（对外读路径）。

#### 生命周期：CREATE MATERIALIZED VIEW（改变形态）

业务流程：提交 SQL → 优化成 StreamPlan → 切 fragment → meta 编排 → 等 barrier 对齐 → CN 建 actor 树 → backfill 回填存量 → 持续产流。

![CREATE MATERIALIZED VIEW 数据流](/vibe-reading/images/articles/risingwave-internals/data-flow-mv.svg)

文字描述：frontend 把 `BoundStatement` 经五阶段 typestate 优化为 `StreamMaterialize` 计划，`StreamFragmenter`（stream_fragmenter/mod.rs 的 `build_graph_with_strategy:175`）切出 fragment 图并推导 dispatcher 与并行度；meta 侧 `DdlController::create_streaming_job` → `GlobalStreamManager` 先 `discover_splits`，再把 `Command::CreateStreamingJob` 交给 `BarrierScheduler::run_command`——**调用方挂起，直到这个 barrier 完整走完注入→收集→提交**。barrier 期间 `actors_to_build` 随 control 流下发 CN，`StreamActorManager::create_actor` 递归物化 executor 树；收齐后 `CompleteBarrierTask` 在**同一个 SQL 事务窗口**里 `commit_epoch` + 落 catalog（job_status → Created）+ 唤醒 DDL 返回。存量数据由 backfill executor 每个 epoch 读一段历史快照 + 应用同期增量，直到追平转纯流式。

#### 日常：barrier 驱动的增量计算与 checkpoint（心跳）

barrier 默认每 1000ms 从 meta 注入（`barrier_interval_ms` 默认值在 `src/common/src/system_param/mod.rs:84`）：`GlobalBarrierWorker` 的 reactor 从命令队列或定时器产出 `BarrierInfo`（epoch 单调递增），经与每个 CN 的常驻双向 control 流下发；在 CN 内 barrier 作为普通消息流经 source → merger（对齐）→ 各 executor（触发 `flush_data`：本 epoch 的 StateTable 增量 flush）→ dispatcher → 回到 `LocalBarrierWorker` 收齐上报；meta 收齐全部 CN 后 `CompleteBarrierTask::complete_barrier` 调 `HummockManager::commit_epoch` 提交新 SST 版本。非 checkpoint 的 barrier 只推进 epoch，折叠进下一个 checkpoint barrier 一起提交（`pending_non_checkpoint_barriers` in checkpoint/state.rs:83）——**一个 checkpoint 逻辑上覆盖多个 epoch，epoch 链连续而落盘开销摊薄**。

#### 服务：SELECT 即时查询（读路径）

用户 `SELECT * FROM mv` 时：frontend 绑定/优化后发现目标已物化，生成 `RowSeqScan` 计划；小查询走 **Local 模式**（`LocalQueryExecution` 在 frontend 进程内直接拉执行树，scan 经单 RPC 短路到 CN 即席执行），大查询走 **Distributed 模式**（`BatchPlanFragmenter` 切 stage，按 vnode 分区把 task 调度到数据所在 CN，stage 间经 exchange shuffle）。两侧最终都按 `query_epoch`（`HummockSnapshotManager` pin 的快照）读 hummock——**一致性免费**：读到的永远是某个已提交 barrier 时刻的完整快照。

### 状态流

![状态流](/vibe-reading/images/articles/risingwave-internals/state-flow.svg)

代码位置：barrier 生命周期由 `GlobalBarrierWorker`（meta/src/barrier/worker.rs:93）+ `CheckpointControl`（checkpoint/control.rs:95）驱动，epoch 单调性的唯一真源是 `BarrierWorkerState`（checkpoint/state.rs:75）；故障路径 `failure_recovery`（worker.rs:968）把 database 转入 `Recovering`，从 hummock 最后 committed epoch 重放。流作业状态（Creating/Created/Running/Dropped）由 `PostCollectCommand` 在 barrier 收齐后的 SQL 事务里变更（complete_task.rs:162-179）——两个状态机在同一个 epoch 上交汇，这是 RisingWave"运行时与 catalog 一致"的机制本体。

---

## 典型修改场景

#### 场景 1：新增一种流 executor（如新 join 变体）

- `src/stream/src/executor/xxx.rs` 实现 `Execute` trait（处理首 barrier + 每 epoch flush）
- `src/stream/src/from_proto/xxx.rs` 实现 `ExecutorBuilder`，`from_proto/mod.rs` 挂 mod——`dispatch_stream_node_body!` 宏自动接线，**无需改中央注册表**
- proto `stream_plan.proto` 的 `NodeBody` oneof 加变体；有状态则经 `StateTable`，并在 `actor_manager.rs:223` 的 `is_stateful_executor` 评估
- frontend 侧配套 plan node（optimizer/plan_node/）
- 对应测试：`src/stream/tests/`（推荐 expect_test 集成测试风格，见 stream/README.md）

#### 场景 2：新增一种 connector（source 或 sink）

- source：`src/connector/src/source/<name>/` 实现 `SourceProperties`/`SplitEnumerator`/`SplitReader` 四 trait，`macros.rs` 的 `for_all_classified_sources!` 清单加一行——枚举与分发宏全部自动展开
- sink：`sink/<name>.rs` 实现 `Sink` trait（复用 `FormattedSink` 模板可零成本获得三种格式），`for_all_sinks!` 加一行；需要 exactly-once 时 `is_coordinated_sink() → true` 并实现 `new_coordinator`
- frontend 校验点：`handler/create_source/validate.rs`；WITH 参数快照测试 `with_options_test.rs`

#### 场景 3：新增一个内建 SQL 函数

- `src/expr/impl/src/scalar/foo.rs`：一个普通 Rust 函数 + `#[function("foo(varchar) -> int4")]` 宏标注——同步/异步、SIMD、null 传播、注册全部由宏生成
- proto `expr.proto` 的 `expr_node.Type` 加枚举值（函数名与 proto 名对应）
- frontend **零改动**：`FUNCTION_REGISTRY` 自动获得签名（linkme 链接期收集），类型推断直接可用
- 对应测试：`src/expr/impl/tests/` 的 slt

---

## 测试体系

```text
e2e_test/              # sqllogictest(.slt) 端到端套件：按特性分目录
  ├── backfill/ batch/ ddl/ dml/ ...
integration_tests/     # 各 connector 真实集成（kafka/iceberg/cdc...）
src/tests/
  ├── simulation/     # madsim 确定性模拟：整集群跑在模拟 runtime，故障注入可复现
  ├── sqlsmith/       # 随机 SQL 差分测试
  ├── regress/        # PG 兼容性回归
  └── compaction_test/ state_cleaning_test/ ...
各 crate tests/      # 单元/集成测试（stream 推荐 expect_test）
```

| 代码层 | 测试类型 |
|--------|----------|
| expr 函数 / common 数组 | 单元测试（expect_test 快照） |
| stream executor | 集成测试（tests/ 目录，`check_until_pending` 水位推进断言） |
| meta barrier / hummock | madsim 确定性模拟（集群故障注入） |
| connector | integration_tests（真实外部系统） |
| SQL 语义 | e2e SLT + sqlsmith 差分 |

理解某个模块时优先看它对应层级的测试：executor 看 `src/stream/tests/` 的 expect 文件（输入 chunk 序列 + 期望输出直接写在测试里），SQL 行为看 `e2e_test/` 的 .slt。

---

## 阅读源码推荐路线

- **第一遍：理解主流程（批查询链路，最短）**
  `src/utils/pgwire/src/pg_protocol.rs` 的 `process_query_msg` → `src/frontend/src/session.rs:1793` 的 `SessionImpl::run_one_query` → `handler/mod.rs:305` 的 `handle` 巨型 match → `handler/query.rs:74` 的 `handle_query` → `optimizer/mod.rs` 的 `PlanRoot` 五阶段 → `scheduler/local.rs` 的 `LocalQueryExecution` → `src/batch/executors/src/executor/row_seq_scan.rs` 的 `RowSeqScanExecutor`（看 `query_epoch` 如何 pin 快照）
- **第二遍：理解流作业创建（系统形态如何改变）**
  `handler/create_mv.rs:186` 的 `handle_create_mv` → `optimizer/mod.rs:641` 的 `gen_optimized_stream_plan` → `stream_fragmenter/mod.rs:371` 的 `generate_fragment_graph` → `src/meta/src/stream/stream_manager.rs:376` 的 `create_streaming_job` → `src/meta/src/barrier/schedule.rs:270` 的 `run_command`（在此挂起）→ `src/meta/src/barrier/worker.rs:525` 的 `run_inner` reactor → `barrier/complete_task.rs:98` 的 `complete_barrier`
- **第三遍：理解运行时心跳（barrier 的闭环）**
  `src/meta/src/barrier/checkpoint/state.rs:75` 的 `BarrierWorkerState`（epoch 单调真源）→ `barrier/rpc.rs:1257` 的 `inject_barrier` → `src/stream/src/task/barrier_worker/mod.rs:715`（CN 侧收齐与 sync）→ `src/storage/src/hummock/store/hummock_storage.rs:673` 的 `sync` → `src/meta/src/hummock/manager/commit_epoch.rs:73`
- **第四遍：选择重点子模块深入**（模块文档）
  状态与缓存去 [04-hummock]；增量算法（degree table、backfill）去 [03-stream]；表达式与函数注册去 [07-expr]；连接器生态去 [05-connector]

---

## 附录

### 术语表

| 术语 | 解释 |
|------|------|
| MV (Materialized View) | 物化视图：流引擎持续维护的查询结果，也是用户表的一种 |
| barrier / epoch | 流内的控制消息 / 其单调编号；Chandy-Lamport 快照算法的载体，checkpoint 与可见性的单位 |
| actor | 流计算最小调度单元：merger + executor 链 + dispatcher，无内部并行 |
| fragment | 切分后的子计划，一个 fragment 实例化为多个并行 actor |
| dispatcher / exchange | actor 内的输出分发器 / 跨 CN 的数据传输服务 |
| vnode (virtual node) | 一致性哈希的虚拟节点，数据分片与 actor 并行度的基本单位 |
| backfill | MV/表/订阅创建时对存量数据的历史回填：每 epoch 读一段快照 + 应用同期增量 |
| shared buffer | CN 上未提交写数据的暂存区（imm），checkpoint 时合并上传为 L0 SST |
| staging / committed | hummock 读视图的两层：本 CN 未提交 / 全局已提交版本 |
| hummock | RisingWave 的云原生 LSM 状态存储引擎名 |
| changelog | 流语义下的变更流（Op 列标注 Insert/Delete/Update 对） |
| EOWC (Emit On Window Close) | 窗口关闭才发射的输出模式（`EMIT ON WINDOW CLOSE`） |

### 参考资料

- 官方设计文档（仓库内 `docs/dev/src/design/`）：[streaming-overview](https://github.com/risingwavelabs/risingwave/blob/main/docs/dev/src/design/streaming-overview.md)、[checkpoint](https://github.com/risingwavelabs/risingwave/blob/main/docs/dev/src/design/checkpoint.md)、[state-store-overview](https://github.com/risingwavelabs/risingwave/blob/main/docs/dev/src/design/state-store-overview.md)、[backfill](https://github.com/risingwavelabs/risingwave/blob/main/docs/dev/src/design/backfill.md)、[shared-buffer](https://github.com/risingwavelabs/risingwave/blob/main/docs/dev/src/design/shared-buffer.md)、[consistent-hash](https://github.com/risingwavelabs/risingwave/blob/main/docs/dev/src/design/consistent-hash.md) 等 16 篇
- RisingWave 论文：*RisingWave: A Distributed SQL Streaming Database* (SIGMOD 2023)——"为何不用 timely/differential-dataflow"的完整论证
- [Materialize 的流一致性模型](https://materialize.com/blog/consistency/)（RisingWave 一致性语义的参照系）
