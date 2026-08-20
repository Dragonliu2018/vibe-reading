---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "Overview"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "TSDB", "时序数据库", "可观测性", "DataFusion"]
description: "开源可观测性数据库——metrics/logs/traces 统一列式引擎、对象存储之上的 region 存储内核、多协议接入与分布式查询协调机制解读。"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 1.3.0 · **解读基线** commit [`8fac71287`](https://github.com/GreptimeTeam/greptimedb/commit/8fac712870d5f95aef6ccdec8e9ae45f872f4afb)（2026-08-19，main 分支快照，领先 v1.3.0 canary tag）· **协议** Apache-2.0 · **语言** Rust (nightly) · **代码量** ~815,000 行 · **仓库** [GitHub](https://github.com/GreptimeTeam/greptimedb)

---

## 总览

### 项目简介

**GreptimeDB** 是一个开源、云原生的可观测性数据库（observability database），把 metrics、logs、traces 三类信号跑在**同一个列式引擎**上，数据落在对象存储（S3 / Azure Blob / GCS / 阿里云 OSS 等）。它用 Rust 编写，面向 PB 级数据量提供亚秒级查询与高性价比存储。三类信号共享一套表模型——**tags、timestamp、fields**：当不同信号携带公共标识符（service、host、trace ID）时，可以用 SQL 在同一引擎内关联它们，而不必在多个数据库间搬运数据。

核心价值在于把"时序数据库的写入吞吐与压缩存储"和"列式查询引擎的分析能力"合二为一：存储层 `mito2` 以 region 为单位做 WAL + memtable + LSM SST + compaction，并用 `metric-engine` 在其上做 metrics 专用复用、用 `index` 做倒排/全文/向量索引加速日志检索；查询层基于 Apache DataFusion（Greptime 维护的 fork）做逻辑/物理计划与分布式执行；协调层 `meta-srv` 用 procedure 状态机管理元数据、路由与 region 迁移；可选的 `flow`（Flownode）提供持续流计算与物化视图。

**项目边界**：GreptimeDB 负责可观测性数据的高吞吐写入、低成本对象存储持久化、SQL/PromQL 统一查询与流式物化。它不是 OLTP 事务数据库——时序写入以 region 为粒度、无跨表事务；也不负责集群运维编排（部署/监控/告警链路由外部工具承担）。

### 功能矩阵

| 特性 | 实现目录 | 说明 |
| --- | --- | --- |
| SQL 接入（MySQL/PostgreSQL 协议） | `src/servers/src/mysql/`、`src/servers/src/postgres/` | 兼容 MySQL/PG 客户端，SQL 方言经 `src/sql/` 解析 |
| PromQL | `src/promql/`、`src/query/src/promql/` | Prometheus 查询语言，remote_read/write 兼容 |
| OpenTelemetry（OTLP）接入 | `src/servers/src/otlp.rs` | metrics/logs/traces 统一摄入协议 |
| Prometheus remote write/read | `src/servers/src/prom_remote_write/`、`src/servers/src/prom_store.rs` | 原生 Prom 兼容 |
| gRPC 接入 | `src/servers/src/grpc/` | greptime Database/Flight/region_server gRPC |
| HTTP API / Dashboard | `src/servers/src/http/` | RESTful、Jaeger 查询、Script |
| InfluxDB/OpenTSDB/Loki/ES 兼容 | `src/servers/src/influxdb.rs` 等 | 行协议与 _bulk 兼容 |
| Region 存储引擎 | `src/mito2/` | WAL + memtable + SST + compaction + manifest |
| Metric 专用引擎 | `src/metric-engine/` | 逻辑/物理表复用、auto-partition、TSID |
| 倒排/全文/向量索引 | `src/index/` | 日志与语义检索加速 |
| 分布式查询 | `src/query/src/dist_plan/` | 分区裁剪、scatter、MergeScan |
| 元数据与协调 | `src/meta-srv/` | leader 选举、procedure、region 分配/迁移 |
| 持续流计算 | `src/flow/` | 物化视图、Streaming/Batching 双引擎 |
| 管理工具 | `src/cli/` | CLI 运维工具 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Rust nightly | 核心 | 全仓语言，workspace 多 crate |
| tokio | 核心 | 异步运行时，按负载分 named runtime |
| DataFusion（Greptime fork） | 核心 | 查询逻辑/物理计划、优化器、执行 |
| Apache Arrow / Parquet | 核心 | 列式内存格式与 SST 文件格式 |
| `object_store` | 核心 | S3/Azure/GCS/OSS 对象存储抽象 |
| sqlparser-rs | 核心 | SQL 解析（扩展而非 fork） |
| snafu | 核心 | 错误处理 + `ErrorExt`/`status_code` |
| fst / roaring-rs | 核心 | 倒排索引 FST + Roaring Bitmap |
| Tantivy | 可选 | 全文索引分词与建库 |
| USearch | 可选 | 向量索引（HNSW） |
| etcd / PostgreSQL / MySQL | 可选 | meta-srv 可插拔 KV 后端 |
| dfir_rs（hydroflow） | 可选 | Flownode 流式计算后端 |
| puffin | 核心 | SST 旁路索引文件格式 |
| prost / greptime-proto | 核心 | gRPC wire 类型生成 |

### 顶层上下文图

GreptimeDB 是一个多角色系统：客户端通过 MySQL/PG/gRPC/HTTP/OTLP/Prometheus 等协议接入；集群模式下 Frontend 接收请求并下发到 Datanode（region 引擎）执行，Metasrv 维护元数据与路由、Datanode/Flownode 通过 meta-client 向它注册与拉取路由；数据最终落到对象存储与可选的本地盘。Standalone 模式把前三者装进一个进程，是开发与小部署的默认形态。

---

## 快速上手

最快看到 GreptimeDB 跑起来的方式是 Docker 单机启动（来自 README）：

```bash title="standalone 启动"
docker run -p 127.0.0.1:4000-4003:4000-4003 \
  -v "$(pwd)/greptimedb_data:/greptimedb_data" \
  --name greptime --rm \
  greptime/greptimedb:latest standalone start \
  --http-addr 0.0.0.0:4000 \
  --grpc-bind-addr 0.0.0.0:4001 \
  --mysql-addr 0.0.0.0:4002 \
  --postgres-addr 0.0.0.0:4003
```

端口分工：`4000` HTTP/Dashboard、`4001` gRPC、`4002` MySQL、`4003` PostgreSQL。打开 `http://localhost:4000/dashboard` 可见 Web 面板。用任意 MySQL 客户端连 `4002`，即可建表、写入时序数据并查询：

```sql title="端到端验证"
CREATE TABLE monitor (host STRING, ts TIMESTAMP TIME INDEX, cpu DOUBLE DEFAULT 0, memory DOUBLE, PRIMARY KEY(host));
INSERT INTO monitor VALUES ('host1', 1700000000, 0.5, 1024);
SELECT host, cpu, memory FROM monitor WHERE ts > 0;
```

从源码构建：`make build`（debug）或 `make build RELEASE=true`；运行 `cargo run -- standalone start`。工具链要求 Rust nightly、Protobuf 编译器（>= 3.15）、C/C++ 构建工具链。

---

## 架构设计解析

### 系统架构

GreptimeDB 的架构思想是**分层解耦 + 按负载隔离运行时**：把"协议接入—查询执行—存储引擎—存储契约—基础设施"拆成单向依赖的 crate 层，每一层只依赖下层，禁止反向依赖（`.agents/architecture-invariants.md` 把它列为不可违反的仓库级不变量）。这样协议、查询、存储三者可独立演进——例如新增一种接入协议不会触碰存储引擎，换一种对象存储后端不会影响查询。

部署形态上，这套分层被组装成四个可独立伸缩的组件：**Frontend**（协议入口 + 分布式查询引擎，无状态）、**Datanode**（region 引擎，含 WAL/memtable/SST/compaction/cache，弹性伸缩）、**Metasrv**（元数据/路由/repartition/安全，背靠可插拔 KV 层 etcd 或 RDS）、**Flownode**（可选，持续流计算）。Standalone 模式通过 `src/standalone/src/datanode_manager.rs` 的 `RegionServer` 适配器让 Frontend **进程内直连** Datanode，绕过 gRPC——这是单机模式与分布式模式在数据流上的唯一结构性差异。

![GreptimeDB 分层架构](/vibe-reading/images/articles/greptimedb-internals/architecture.svg)

文字上，自上而下五层各有职责：**接入层** `servers` 把十种协议的 codec 与上下文构造收敛到统一的 `QueryHandler` trait，执行权全部上交给 `frontend::Instance`；**执行协调层** `operator` 把高层 DDL/DML 翻译成 region 请求并按 peer 分组并行下发，`query` 基于 DataFusion 做逻辑/物理计划与分布式 scatter，`sql` 扩展 sqlparser 解析 GreptimeDB 专有语法，`flow` 提供持续计算，`meta-srv`/`meta-client`/`partition` 负责协调与分区路由；**存储引擎层** `mito2` 是核心 region 引擎，`metric-engine` 在其上做 metrics 多路复用，`index` 作为 external provider 注入 SST 加速检索；**存储契约层** `store-api` 定义 `RegionEngine` trait 与 `RegionId`，`datatypes`/`table`/`catalog` 提供数据类型与表抽象；**基础设施层** `common-runtime`（按负载隔离的 named runtime）、`common-error`（snafu + `ErrorExt`）、`common-telemetry`、`common-memory-manager`、`common-procedure`（状态机框架）、`common-wal` 等被全仓共享。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接入层 | `src/servers/` | 隔离外部协议，把多协议归一为统一 QueryHandler，保护核心不受协议变化影响 |
| 执行协调层 | `src/frontend/`、`src/operator/`、`src/query/`、`src/sql/`、`src/flow/`、`src/meta-srv/`、`src/partition/` | 编排请求流程、构建查询计划、协调分布式 region 路由 |
| 存储引擎层 | `src/mito2/`、`src/metric-engine/`、`src/file-engine/`、`src/index/` | 承载 region 级读写与 LSM 合并，实现 `RegionEngine` 契约 |
| 存储契约层 | `src/store-api/`、`src/datatypes/`、`src/table/`、`src/catalog/` | 定义引擎 trait 与核心数据结构，解耦引擎实现与上层 |
| 基础设施层 | `src/common/*`、`src/object-store/` | 运行时/配置/错误/遥测/内存/过程框架，全仓共享 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Worker 单写多读 | `RegionWorkerLoop`（`src/mito2/src/worker.rs:837`） | region 哈希到固定 worker，写串行化避免锁竞争，读取 version 快照异步并发 |
| Procedure 状态机 | `State` trait（`src/meta-srv/src/procedure/region_migration.rs:780`） | 多步分布式操作可序列化、崩溃恢复，leader 切换后从上一步续跑 |
| 策略模式 | `Selector` trait（`src/meta-srv/src/selector.rs:33`）、`Picker` trait（`src/mito2/src/compaction/picker.rs:41`）、`FlowEngine`（`src/flow/src/engine.rs:48`） | 选择器/compaction 策略/流引擎可插拔替换 |
| 适配器/门面 | `servers` 把协议归一为 `QueryHandler`（`src/servers/src/query_handler/`）；`metric-engine` 代理 `mito2` | 收敛十种协议、在引擎之上做 metrics 专用分层 |
| 插件系统 | `Plugins`（`src/common/base/src/plugins.rs`），`SelectorFactory`、`HeartbeatHandlerGroupBuilderCustomizer` | 组件可插拔，避免构造函数参数爆炸 |
| CoW Version | `VersionControl`（`src/mito2/src/region/version.rs:49`） | 读不持锁、写不阻塞读，`Arc` 共享内部数据 |

### 核心概念

GreptimeDB 里最重要的"东西"是 region——它是存储、调度、故障恢复与负载均衡的最小单位。

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Region`（`store_api`） | 一段数据的分片单元，由 `RegionId`（TableId 32 位 + RegionNumber 32 位）标识 | 建表时由 meta-srv 分配，迁移/分裂时变化 | 一个表含多个 region，分布在不同 datanode |
| `MitoRegion`（`src/mito2/src/region.rs:142`） | mito2 里 region 的运行时态 | 进程内打开即存在，drop 时关闭 | 持有 `VersionControl`/`AccessLayer`/`ManifestContext` |
| `Version`（`version.rs:360`） | 某时刻 memtables + ssts 的不可变快照 | CoW，每次 flush/compaction 生成新版本 | 被 `Scanner` 读取、被 `apply_edit` 更新 |
| `TableInfo`/`TableRoute`（`common-meta`） | 表元数据与 region 路由（region 分布在哪些 peer） | meta-srv 持久化在 KV，datanode/frontend 缓存 | `operator` 据此路由写入与查询 |
| `Flow`（`src/flow`） | 持续计算定义（sink 表 + SQL） | CREATE FLOW 时建，存于 metasrv | 从 source 表增量取数、写回 sink 物化表 |
| `Memtable`（`src/mito2/src/memtable.rs:255`） | 写入内存结构，flush 成 SST | mutable→immutable→flush | `TimeSeriesMemtable`/`BulkMemtable` |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `RegionEngine` | `src/store-api/src/region_engine.rs` | `MitoEngine`、`MetricEngine`、`FileEngine`、`MockRegionEngine` | datanode 启动时注册到 `RegionServer` 的 `region_engines` |
| `QueryEngine` | `src/query/src/query_engine.rs` | `DatafusionQueryEngine` | frontend 构造时注入 |
| `HeartbeatHandler` | `src/meta-srv/src/handler.rs:88` | 20+ handler（KeepLease/CheckLeader/Mailbox/RegionFailure…） | `HeartbeatHandlerGroupBuilder` 顺序注册，可被插件定制 |
| `FlowEngine` | `src/flow/src/engine.rs:48` | `StreamingEngine`、`BatchingEngine` | `FlowDualEngine` 按 `FlowType` 分发 |
| `Picker`（compaction） | `src/mito2/src/compaction/picker.rs:41` | `TwcsPicker`、`WindowedCompactionPicker` | `new_picker` 按 region options 选择 |

---

## 代码目录

```
greptimedb/
├── src/
│   ├── cmd/                 # 二进制入口（greptime CLI），按子命令分发 datanode/frontend/metasrv/flownode/standalone/cli
│   ├── standalone/          # 单机模式：把前三者装一进程，RegionServer 适配器进程内直连
│   ├── servers/              # 多协议服务器（MySQL/PG/gRPC/HTTP/OTLP/Prom/ES/InfluxDB/OpenTSDB）
│   ├── frontend/             # 请求编排 + 分布式查询入口（Instance）
│   ├── operator/             # DDL/DML 算子，语句→region 请求翻译
│   ├── query/                # DataFusion 查询引擎 + 分布式计划
│   ├── sql/                  # SQL 解析（扩展 sqlparser）
│   ├── promql/               # PromQL 解析与计划
│   ├── flow/                 # Flownode 持续流计算
│   ├── mito2/                # 核心 region 存储引擎（WAL/memtable/SST/compaction/manifest/cache）
│   ├── metric-engine/        # metrics 专用引擎（逻辑/物理表复用）
│   ├── file-engine/          # 文件引擎（外部 parquet）
│   ├── index/                # 倒排/全文/bloom/向量索引
│   ├── log-store/            # RaftEngine 日志存储（WAL 后端）
│   ├── puffin/               # puffin 文件格式（索引旁路存储）
│   ├── meta-srv/             # Metasrv：元数据/路由/选举/procedure
│   ├── meta-client/          # frontend/datanode/flownode 访问 metasrv 的客户端
│   ├── partition/            # 分区规则与 region leader 查找
│   ├── pipeline/             # ETL pipeline（数据摄入转换）
│   ├── catalog/              # catalog/schema/table 元数据管理
│   ├── datatypes/            # 列式数据类型与 Vector
│   ├── store-api/            # 引擎契约：RegionEngine trait、RegionId
│   ├── table/                # Table trait 与请求类型
│   ├── object-store/         # 对象存储抽象
│   ├── session/             # QueryContext 会话
│   ├── auth/                 # 鉴权
│   └── common/               # 共享基础设施（runtime/config/error/telemetry/memory-manager/procedure/meta/recordbatch/wal/…）
├── config/                    # 示例 TOML 配置
├── tests/ tests-integration/ tests-fuzz/   # 测试
└── Cargo.toml                 # workspace 根
```

`src/common/` 是体量最大的目录（~16.4 万行、546 文件、30+ 子 crate），但都是被频繁复用的基础设施，不单独成模块解读——见 [10-infrastructure](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/10-infrastructure)。`tests/compatibility/` 维护持久化/wire 格式的向后/向前兼容性测试，改持久化格式时必须加用例。

## 模块地图

下表列出全部解读模块。模块间静态依赖见依赖关系图——箭头表示"依赖/调用"。

![模块依赖关系](/vibe-reading/images/articles/greptimedb-internals/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| mito2 | region 存储引擎（WAL/memtable/SST/compaction） | `MitoEngine::handle_request`（`engine.rs:1245`） | 时序写入/读放大/LSM 合并的核心，4 组件里 Datanode 的心脏 | [01-mito2](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/01-mito2) · [compaction 深读](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/01-mito2-compaction) |
| metric-engine | metrics 专用引擎（逻辑/物理表复用） | `MetricEngine::handle_request`（`engine.rs:137`） | 海量小 metric 表需复用物理 region，避免元数据开销 | [02-metric-engine](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/02-metric-engine) |
| query | DataFusion 查询引擎 + 分布式计划 | `DatafusionQueryEngine::execute`（`datafusion.rs:507`） | 逻辑/物理计划与跨 region scatter是查询能力的来源 | [03-query](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/03-query) |
| servers | 多协议接入层 | `SqlQueryHandler::do_query`（`query_handler/sql.rs:34`） | 十种协议的 codec 与上下文构造需统一收敛 | [04-servers](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/04-servers) |
| meta-srv | 元数据/路由/选举/procedure | `Metasrv::try_start`（`metasrv.rs:927`） | 分布式协调是独立职责，含选主与 region 迁移状态机 | [05-meta-srv](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/05-meta-srv) |
| flow | Flownode 持续流计算 | `FlowDualEngine::create_flow`（`flownode_impl.rs:667`） | 物化视图/流式聚合与离线查询是不同计算模式 | [06-flow](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/06-flow) |
| sql | SQL 解析（扩展 sqlparser） | `ParserContext::create_with_dialect`（`parser.rs:71`） | GreptimeDB 专有语法（TIME INDEX/PARTITION/TTL）需 AST 扩展 | [07-sql](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/07-sql) |
| index | 倒排/全文/向量索引 | `InvertedIndexApplier::apply`（`mito2/sst/index/inverted_index/applier.rs:214`） | 日志/语义检索加速是可观测性的关键能力 | [08-index](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/08-index) |
| operator | DDL/DML 算子层 | `StatementExecutor::execute_sql`（`statement.rs:244`） | 桥接 Frontend 与 region engine，统一多入口格式 | [09-operator](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/09-operator) |
| infrastructure | 共享基础设施 + 存储契约 | `RegionEngine` trait（`store-api/src/region_engine.rs`）、`Runtime`（`common/runtime`） | 全仓共享运行时/错误/内存/过程框架与引擎契约 | [10-infrastructure](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/10-infrastructure) |

> 模块间的动态调用顺序见运行时行为 > 核心运行流程。

## 运行时行为

### 启动流程

`src/cmd/src/bin/greptime.rs` 的 `main_body()` 在多线程 tokio runtime 上启动，`Command` 按 `datanode/flownode/frontend/metasrv/standalone/cli/user` 子命令分发。standalone 子命令经 `StartCommand::build()`（`src/cmd/src/standalone.rs`）把 Datanode + Frontend + Flownode 装进一个 `Instance`，`App::start()` 依次起 leader 服务、frontend plugins、`frontend.start()`、`flownode.start()`。

对象装配的关键：配置由 TOML 文件 + 环境变量 + 命令行参数三级合并（`Configurable` trait，env 用 `__` 分隔映射嵌套字段），优先级 file > env > default。`MitoEngine` 在 datanode 启动时构造并注册为 `RegionEngineRef`（`src/datanode/src/datanode.rs`），`MetricEngine` 紧随其后包装同一个 `MitoEngine` clone 注册——两者都实现 `RegionEngine` trait，由 `RegionServer` 按 region 的引擎名路由。`Metasrv` 通过 `MetasrvBuilder` 链式注入 KV backend、selector、handler group、election（`src/meta-srv/src/metasrv/builder.rs`）。standalone 下 `StandaloneDatanodeManager` 让 frontend 持有 `RegionServer` 引用直接调用，跳过 gRPC。

命名 runtime（`src/common/runtime/src/global.rs`）由宏生成 `spawn_global/ingest/query/compact/hb`——产品组件必须用这些 spawn 函数而非自建 runtime，按负载隔离以免写爆查询。CPU 密集或阻塞调用走 `spawn_blocking_*`，**绝不**在 async 上下文里 `block_on`（会死锁 runtime，见 architecture-invariants 第 3 条）。

### 核心运行流程

下面两条主链路覆盖了 GreptimeDB 最核心的运行模式——写入与查询。它们共享 `servers → frontend → operator/query → RegionServer → mito2` 的主干，但在执行协调层分叉（写走 `Inserter`，读走 `QueryEngine`）。

#### 写入链路：MySQL/OTLP/Prom → WAL + memtable

业务流程：客户端按协议提交数据 → servers 归一为 `RowInsertRequests` → frontend 的 `Inserter` 做按需建表/加列 + 分区分裂 + 按 peer 分组 → 并行下发到 datanode 的 `RegionServer` → mito2 worker 先批量写 WAL 再写 memtable → 返回 affected rows；memtable 异步 flush 成 SST。

![写入与查询数据流](/vibe-reading/images/articles/greptimedb-internals/data-flow.svg)

文字上（详见 [09-operator](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/09-operator) 与 [01-mito2](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/01-mito2)）：`Inserter::do_request`（`insert.rs:389`）用 `RegionRequestFactory` 把 `RegionInsertRequests` 包成 `RegionRequest`，`group_requests_by_peer` 经 `partition_manager.find_region_leader` 找到每个 region 的 leader peer，再用 `spawn_global` 对每个 peer 并发调 `node_manager.datanode(&peer).handle(request)`。standalone 下这是进程内直连（`StandaloneDatanodeManager` → `RegionServer`），分布式下走 gRPC。`RegionServerInner::handle_request`（`region_server.rs:1563`）按 region_id 找到引擎（mito2 或 metric-engine），`spawn_ingest` 后调 `engine.handle_request`。mito2 把请求投进 worker 的 mpsc channel（`engine.rs:1029`），`RegionWorkerLoop::handle_write_requests`（`handle_write.rs:43`）批量 `write_wal`（`append_batch` 一次落盘）再 `write_memtable`——同一 region 串行、多 region memtable 写并发。返回的 `RegionResponse{affected_rows}` 沿原路回传。metric-engine 表会先把逻辑行改写（`RowModifier` 编码 `__primary_key`/`__table_id`/`__tsid`）再委托 mito2 写 data region。

#### 查询链路：SELECT → planner → dist scatter → region 下推 → memtable+SST merge

业务流程：客户端 SQL → servers 转交 frontend → `query` 的 `DfLogicalPlanner` 构建逻辑计划 → `DistPlannerAnalyzer` 用 `MergeScanLogicalPlan` 包裹远端 TableScan → DataFusion 优化 → `DistExtensionPlanner` 物理计划期做分区裁剪 + scatter → `MergeScanExec` 对每个目标 region 并发 `do_get` → datanode 执行注入后的 per-region 子计划 → mito2 `scan_region` 合并 memtable + SST → `RecordBatch` 流式回传。

文字上（详见 [03-query](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/03-query)）：`Instance::plan_and_exec_sql`（`instance.rs:405`）先 `query_engine.planner().plan` 得到 `LogicalPlan`，再 `query_engine.execute`。`exec_query_plan`（`datafusion.rs:152`）在 `create_physical_plan` 里跑 `DistPlannerAnalyzer`（`analyzer.rs:116`）把谓词推到 TableScan.filters、用 `MergeScanLogicalPlan` 标记远端下沉，然后 `DistExtensionPlanner::plan_extension`（`planner.rs:159`）调 `ConstraintPruner::prune_regions`（`region_pruner.rs:35`）按分区表达式裁掉无关 region，构造 `MergeScanExec` scatter 到多 region。执行期 `MergeScanExec` 对每个 region 调 `FrontendRegionQueryHandler.do_get`（`region_query.rs:117`）→ `node_manager.datanode(peer).handle_query`。datanode 的 `RegionServer::handle_read`（`region_server.rs:1803`）用 `spawn_query` 跑注入后的子计划，数据源指向 mito2 region，最终 `MitoEngine::handle_query`（`engine.rs:1275`）→ `scan_region` 取 `Version` 快照里的 memtable ranges + SST file ranges，`Scanner.build_stream` 做合并去重。读路径**不走 worker 线程**——直接读 version 快照（`engine.rs:1053` 注释明确说明）。

#### 异步与并发要点

- **三套 runtime 隔离负载**：`ingest`（写）、`query`（读）、`global`（worker loop/flush/通用），加 `compact`/`hb`，避免写爆查询。
- **批量写 WAL**：worker 把多个 region 的 WAL entry 攒一次 `append_batch`，减少 I/O。
- **后台 flush 两条触发**：写前检查 `write_buffer_manager` 全局/region 阈值（`handle_flush.rs:81`）；worker 的 `flush_receiver` 被其他 worker 的 flush 唤醒（`worker.rs:963`）。flush job 在 `flush_job_pool` 跑，SST 写再 `spawn_global` + `flush_semaphore` 限流。
- **背压三级**：flush（超阈值触发）→ stall（全局写缓冲满，请求挂入 `StalledRequests`）→ reject（超 `global_write_buffer_reject_size` 拒写），借鉴 RocksDB WriteBufferManager。
- **错误传播**：每层 snafu `Error` + `ErrorExt`，跨模块用 `BoxedError::new` 装箱再 `.context(上层 Snafu)`，`status_code()` 决定客户端可见结果与是否脱敏（`Internal`/`Unknown` 对终端用户屏蔽）。

---

## 典型修改场景

#### 场景 1：新增一种接入协议（如 Loki 兼容）

- `src/servers/src/loki.rs`（新建）：实现协议 codec，把 Loki 行协议转成 `RowInsertRequests`，复用 `Inserter` 走写入主干。
- `src/servers/src/http.rs`：在 HTTP 命名空间 nest 里加路由（`http.rs:639-820` 的 nest 模式）。
- `src/frontend/src/server.rs` 的 `Services::build`：把新 handler 注入到 server builder 一处。既有协议无需改动——trait 边界把改动面限制在"新文件 + 一处注入"。

#### 场景 2：新增一种 compaction 策略

- `src/mito2/src/compaction/`（新建 picker 文件）：实现 `Picker` trait（`picker.rs:41`），`pick()` 返回 `PickerOutput`。
- `src/mito2/src/compaction/picker.rs:129` `new_picker`：match 新增分支。
- `src/mito2/src/region/options.rs`：`CompactionOptions` enum 新增变体。
- 对应测试：`src/mito2/src/compaction/` 下的单测 + `tests-integration` 的 compaction 用例。

#### 场景 3：新增一种 region 引擎

- 新 crate 实现 `RegionEngine` trait（`src/store-api/src/region_engine.rs`）。
- `src/datanode/src/datanode.rs`：启动时构造并注册到 `region_engines`，由 `RegionServer` 按引擎名路由。
- `src/sql/src/parsers/create_parser.rs:1106` `parse_table_engine`：让 `ENGINE=` 接受新引擎名。
- 对应测试：`tests-integration` 端到端用例。

> 扩展点的契约定义见「架构设计解析 > 核心概念」的核心抽象表。每个场景的测试路径见对应模块文档。

## 测试体系

```
tests/                    # sqlness SQL 回归测试（cargo sqlness bare -t <case>）
tests-integration/        # 端到端集成测试（多组件协作、协议兼容）
tests-fuzz/               # 模糊测试
tests/compatibility/      # 持久化/wire 格式向后向前兼容（改格式必加用例）
tests/perf/               # 查询性能回归 harness
```

| 代码层 | 测试类型 | 命令 |
| --- | --- | --- |
| 单 crate 内部逻辑 | 单元测试 | `cargo nextest run -p <package>` |
| 跨 crate 行为 | 集成 + sqlness | `make test`；`cargo sqlness bare -t <case>` |
| SQL 解析/计划/输出 | sqlness 回归 | `cargo sqlness bare`，检查 `.result` |
| 持久化/wire 格式 | compatibility | `tests/compatibility/` 用例 |
| 性能 | perf harness | `tests/perf/AGENTS.md` |

修改某层代码时，参照上表找对应测试类型优先阅读——很多模块的 `test_util.rs` 与 `*_test.rs` 是可执行文档。改持久化或 wire 格式必须加 compatibility 用例（architecture-invariants 第 1 条）。

## 阅读源码推荐路线

- **第一遍：理解主流程（写 + 读两条链路）**
  `src/cmd/src/bin/greptime.rs`（子命令分发）→ `src/standalone/src/datanode_manager.rs`（进程内直连适配）→ `src/operator/src/insert.rs` 的 `Inserter::do_request`（写入主干）→ `src/mito2/src/worker.rs` 的 `RegionWorkerLoop::handle_write_requests`（WAL+memtable）→ `src/query/src/datafusion.rs` 的 `exec_query_plan`（查询主干）→ `src/mito2/src/read/scan_region.rs` 的 `ScanRegion::region_scanner`（memtable+SST 合并）。
- **第二遍：理解核心数据结构与契约**
  `src/store-api/src/region_engine.rs`（`RegionEngine` trait）→ `src/mito2/src/region/version.rs` 的 `VersionControl`/`Version`（CoW 快照）→ `src/common/meta/src/` 的 `TableInfo`/`TableRoute`/`RegionRoute`（元数据与路由）→ `src/datatypes/src/` 的 `ConcreteDataType`/`Vector`。
- **第三遍：理解扩展机制**
  `src/meta-srv/src/handler.rs` 的 `HeartbeatHandler` + `HeartbeatHandlerGroupBuilder`（handler 链注册）→ `src/meta-srv/src/selector.rs` 的 `Selector` + `bootstrap.rs:429` 的 `SelectorFactory`（选择器可插拔）→ `src/mito2/src/compaction/picker.rs` 的 `Picker` + `new_picker`（compaction 策略）→ `src/common/base/src/plugins.rs` 的 `Plugins`（插件系统）。
- **第四遍：选重点子模块深入阅读**（模块文档；mito2 的 compaction 深读从 [01-mito2](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/01-mito2) 的「核心实现」链接进 [compaction 深读](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/01-mito2-compaction)）

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| region | GreptimeDB 的数据分片与调度最小单位，由 `RegionId`（TableId+RegionNumber）标识 |
| TIME INDEX | GreptimeDB 特有表约束，指定时间索引列（时序数据的时间轴），见 `TableConstraint::TimeIndex` |
| SST | Sorted String Table，LSM 持久化文件（mito2 用 Parquet + Puffin 索引） |
| WAL | Write-Ahead Log，预写日志，保证写入持久性 |
| TSID | metric-engine 里一组 tag value 的 FxHash，用于把同组 tag 数据聚集到同一主键 |
| procedure | meta-srv 里可序列化、可恢复的多步分布式操作状态机 |
| MergeScan | 分布式查询里包裹多个远端 region scan 的逻辑/物理算子 |
| puffin | SST 旁路索引文件格式，一个文件存多个命名 blob（倒排/全文/向量各自一 blob） |

### 参考资料

- [GreptimeDB 官方文档](https://docs.greptime.com/) · [架构概览](https://docs.greptime.com/contributor-guide/overview/#architecture)
- [AGENTS.md](https://github.com/GreptimeTeam/greptimedb/blob/main/AGENTS.md) 与 `.agents/architecture-invariants.md`（仓库级架构不变量）
- [DataFusion](https://arrow.apache.org/datafusion/) · [sqlparser-rs](https://github.com/datafusion-contrib/sqlparser-rs) · [hydroflow/dfir_rs](https://github.com/hydro-project/hydroflow)
