---
source:
  type: "源码解读"
  project: "InfluxDB"
  url: "https://github.com/influxdata/influxdb"
title: "Overview"
date: "2026-08-20T13:07:26+08:00"
category: [Database, TSDB, InfluxDB, CodeWiki, "3.11.1"]
tags: ["InfluxDB", "Rust", "TSDB"]
description: "InfluxDB 3 Core 源码架构解读——Rust 编写的云原生时序数据库，基于 Apache Arrow/DataFusion/Parquet，diskless 对象存储架构"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 3.11.1 · **协议** MIT/Apache-2.0 · **语言** Rust 1.97.1 · **代码量** ~388,000 行 · **仓库** [GitHub](https://github.com/influxdata/influxdb)

---

## 总览

### 项目简介

InfluxDB 3 Core 是 InfluxData 用 **Rust** 重写的时序数据库（Time Series Database, TSDB），定位为"收集、处理、转换、存储事件与时序数据"的实时数据库。它解决的核心问题是：在海量时序数据写入的同时，支持毫秒级的最近值查询（last-value）与去重值查询（distinct），以驱动仪表盘、监控和自动化场景。

核心价值在于三点：**(1) diskless 架构**——WAL 与 Parquet 文件均持久化到对象存储（S3/Azure/GCP）或本地磁盘，节点无状态，可随时重启迁移；**(2) 列式栈**——内存格式用 Apache Arrow，查询引擎用 DataFusion，持久化用 Parquet，端到端列式零拷贝；**(3) 嵌入式 Python VM**——通过 PyO3 在进程内运行插件与触发器，零 IPC 开销。

**项目边界**：InfluxDB 3 Core 负责时序数据的写入、查询、缓存与插件处理引擎，不负责分布式集群协调（那是 InfluxDB 3 Enterprise 的职责）；查询语言支持 SQL 与 InfluxQL，v3 Core 分支不再支持 Flux（Flux 在 v2.x 分支）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| HTTP 写入 API | `influxdb3_server/src/http.rs` | 端口 8181，兼容 v1/v2/v3 Line Protocol |
| FlightSQL gRPC | `influxdb_server/src/grpc.rs` + `core/service_grpc_flight/` | 与 HTTP 同端口，协议检测复用 |
| SQL 查询 | `influxdb3_query_executor/src/lib.rs` | 基于 DataFusion |
| InfluxQL 查询 | `core/iox_query_influxql/` | 转译为 DataFusion LogicalPlan |
| Line Protocol 解析 | `core/influxdb_line_protocol/src/lib.rs` | nom 组合子，零拷贝 |
| WAL 持久化 | `influxdb3_wal/src/object_store.rs` | diskless，对象存储 PUT |
| Parquet 落盘 | `influxdb3_write/src/persister.rs` | ZSTD 压缩，按 chunk_time 分区 |
| Last/Distinct Cache | `influxdb3_cache/src/last_cache/` + `distinct_cache/` | 内存缓存，<10ms 查询 |
| Catalog 元数据 | `influxdb3_catalog/src/catalog/versions/v3/catalog.rs` | 事件溯源，版本化 format |
| Python 插件/触发器 | `influxdb3_processing_engine/src/lib.rs` | PyO3 嵌入，WAL/Schedule/Request 触发 |
| Token 认证授权 | `influxdb3_authz/src/lib.rs` | SHA-512 + RBAC bitmap |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Rust 1.97.1 | 核心 | 主语言，零成本抽象 + 内存安全 |
| Apache Arrow 57.1 | 核心 | 列式内存格式，MutableBatch/RecordBatch |
| DataFusion | 核心 | SQL 查询引擎，CBO 优化器 + 向量化执行 |
| Parquet | 核心 | 列式持久化格式，ZSTD 压缩 |
| object_store | 核心 | S3/Azure/GCP/本地 对象存储抽象 |
| Tokio | 核心 | 异步运行时， DedicatedExecutor 线程池隔离 |
| hyper + Tower | 核心 | HTTP/gRPC 服务，Tower 中间件栈 |
| tonic + prost | 核心 | gRPC + Protobuf，FlightSQL 协议 |
| clap 4.5 | 核心 | CLI 参数解析（derive） |
| pyo3 | 可选 | 嵌入式 Python VM，插件与触发器 |
| rustls | 核心 | TLS，ring crypto provider |
| sqlparser | 核心 | SQL 解析（DataFusion 内部） |

### 版本历史

InfluxDB 经历了三次重大演进：**v1.x**（Go 编写，InfluxQL）、**v2.x**（Go，引入 Flux 查询语言）、**v3 Core**（Rust 重写，原名 IOx，2025 年 4 月 GA）。v3 的重写并非渐进迁移而是推倒重来——底层从自研存储引擎切换到 Apache Arrow/DataFusion/Parquet 列式栈，架构从"本地磁盘为主"转向"对象存储为主"的 diskless 模式。`core/` 目录下 69 个子 crate 是 IOx 遗产代码（约 21 万行），`influxdb3_*` 目录下 27 个 crate 是 v3 专有应用层（约 17.8 万行）。本系列解读基于 tag `v3.11.1`（commit `a95809c862`，2026-08-06）。

---

## 快速上手

```bash
# 需求：Rust 1.97.1（rustup）、python3、protoc
git clone https://github.com/influxdata/influxdb.git
cd influxdb
cargo build                  # 快速构建（默认 profile，未优化）
# 启动（node-id 是必填项，无子命令时自动 QuickStart 模式）
./target/debug/influxdb3 serve --node-id local-node --object-store file --data-dir /tmp/influxdb3
```

写入与查询验证：

```bash
# 写入 Line Protocol
curl -XPOST "http://localhost:8181/api/v3/write_lp?db=mydb" \
  -d 'cpu,host=server1 value=42i 1700000000000000000'
# SQL 查询
curl -G "http://localhost:8181/api/v3/query_sql" \
  --data-urlencode "db=mydb" --data-urlencode "q=SELECT * FROM cpu"
```

---

## 架构设计解析

### 系统架构

InfluxDB 3 Core 的架构思想是**"diskless + 列式端到端"**——把存储卸载到对象存储，让节点成为无状态的计算节点，同时用 Arrow 统一内存、网络、持久化三个层面的数据格式，避免序列化开销。这样设计解决两个矛盾：时序数据"写多读少但读要快"的矛盾（用 WAL 保持久性 + 内存缓存保查询延迟）、云原生"无状态可扩缩"与"数据库需要状态"的矛盾（把状态全部外置到对象存储）。

![InfluxDB 3 Core 分层架构](/vibe-reading/images/articles/influxdb3-internals/architecture.svg)

系统从上到下分 7 层（含 1 个横切层）+ 1 个对象存储基座。各层职责边界清晰：**接口层**隔离外部协议（HTTP/gRPC/CLI），**编排层**负责进程启动与子系统装配，**存储引擎层**是核心——写入、WAL、缓存、Parquet 落盘都在此层，**元数据层**（Catalog）与**查询引擎层**并列，被存储与查询共同依赖，**扩展层**（Python 处理引擎）以钩入方式横跨存储与查询，**横切关注点**（认证、可观测性、生命周期）贯穿所有层。最底层的对象存储是真正的"磁盘"——diskless 架构意味着 WAL 与 Parquet 都持久化于此。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接口层 | `influxdb3_server/`、`influxdb3`（CLI） | 隔离外部协议，保护核心不受接口变化影响；HTTP/gRPC 同端口复用 |
| 编排层 | `influxdb3`（serve_main）、`influxdb3_startup`、`influxdb3_clap_blocks` | 进程启动、配置、8 个子系统顺序装配 |
| 存储引擎层 | `influxdb3_write`、`influxdb3_wal`、`influxdb3_cache`、`core/parquet_file`、`core/object_store_mem_cache`、`core/line_protocol`、`core/mutable_batch`、`core/linear_buffer` | 写入、持久化、缓存——承载时序数据生命周期 |
| 元数据层 | `influxdb3_catalog` | 数据库/表/Parquet 文件元数据，事件溯源 + 版本化 |
| 查询引擎层 | `influxdb3_query_executor`、`core/iox_query` | DataFusion 查询，三语言统一，pruning 裁剪 |
| 扩展层 | `influxdb3_processing_engine`、`influxdb3_py_api` | Python 插件/触发器，钩入 WAL 与查询 |
| 横切关注 | `influxdb3_authz`、`core/authz`、`core/trace`、`core/metric`、`influxdb3_telemetry`、`influxdb3_shutdown` | 认证授权、可观测性、优雅关闭，跨所有层 |
| 对象存储基座 | （外部 S3/Azure/GCP/本地） | diskless 物理基座，WAL 与 Parquet 共用 |

### 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| 依赖注入（Arc<dyn Trait>） | `serve.rs:1330`、`serve.rs:1407` | 子系统通过 trait 对象共享，解耦实现；`NoAuthAuthenticator` vs `TokenAuthenticator` 是策略 |
| 事件溯源 | `influxdb3_catalog/src/format/apply.rs:339`（`apply_records`） | Catalog 状态由 Record 序列重建，支持 replay 与快照 |
| 装饰器（ObjectStore 包装链） | `serve.rs:1009-1038` | 基础 store → 指标装饰器 → 缓存装饰器，层层组合 |
| 观察者（WalFileNotifier） | `influxdb3_wal/src/lib.rs:123` + `influxdb3_write/src/write_buffer/queryable_buffer.rs:488` | WAL 持久化后异步通知缓存更新与缓冲，解耦 |
| 类型状态（Type State） | `influxdb3_write/src/write_buffer/validator.rs:82`（`WriteValidator<State>`） | 编译期保证写入流程状态机顺序正确 |
| Tower 中间件栈 | `influxdb3_server/src/lib.rs:517-521` | TraceLayer/RequestMetrics/RemoteAddr 可组合横切 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Catalog` | 元数据根，事件溯源 | 进程级，`serve_main` 构造 | 被 write/query/cache/authz 依赖 |
| `WriteBuffer`（`WriteBufferImpl`） | 写入缓冲，持有 WAL + 内存表 | 进程级 | 持有 catalog/wal/persister/cache |
| `IOxSessionContext` | 查询会话上下文 god node | 每查询 | 持有 DataFusion SessionContext + DedicatedExecutor |
| `WalObjectStore` | diskless WAL | 进程级 | 持有 object_store，通知 QueryableBuffer |
| `ParquetFile` | 持久化文件元数据 | 持久（catalog 记录） | 归属 TableId，含 chunk_time/min/max |
| `MutableBatch` | 列式内存格式（非生产写入路径） | 短暂 | 用于测试/protobuf 编解码 |
| `TableBuffer` | 生产写入内存缓冲（Arrow builders） | 短暂，snapshot 后清空 | 按 chunk_time 分桶 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Bufferer` / `WriteBuffer` | `influxdb3_write/src/lib.rs:66` | `WriteBufferImpl` | `serve.rs:1330` 构造 |
| `Wal` + `WalFileNotifier` | `influxdb3_wal/src/lib.rs:64` | `WalObjectStore`；`QueryableBuffer`（notifier） | WAL 构造时注入 notifier |
| `CatalogOp` trait | `influxdb3_catalog/src/catalog/versions/v3/ops/mod.rs:27` | 30+ Op（CreateDatabaseOp 等） | inventory 编译期注册 |
| `QueryExecutor` / `QueryDatabase` | `influxdb3_internal_api/src/query_executor.rs:42` | `QueryExecutorImpl` | `serve.rs:1346` 构造 |
| `AuthProvider` | `influxdb3_authz/src/lib.rs` | `TokenAuthenticator`/`NoAuthAuthenticator` | `serve.rs:1407` 策略选择 |
| `PythonEnvironmentManager` | `influxdb3_processing_engine/src/environment.rs` | `PipManager`/`DisabledPackageManager` | `serve.rs:1631` 策略选择 |
| `Authorizer`（IOx 层） | `core/authz/src/authorizer.rs` | `IoxAuthorizer` + upcast 桥接 | `AuthProvider::upcast()` |

---

## 代码目录

```
influxdb/
├── influxdb3/                  # 二进制入口（main.rs + lib.rs 的 startup + CLI commands）
├── influxdb3_server/           # HTTP API + FlightSQL gRPC（端口 8181）
├── influxdb3_write/            # 写入缓冲（WriteBuffer/TableBuffer/Persister）
├── influxdb3_wal/              # diskless WAL（WalObjectStore）
├── influxdb3_cache/            # Last/Distinct/Parquet 三缓存
├── influxdb3_catalog/          # Catalog 元数据（事件溯源，73K 行最大应用 crate）
├── influxdb3_query_executor/   # 查询入口（QueryExecutorImpl）
├── influxdb3_processing_engine/# Python VM 插件/触发器
├── influxdb3_py_api/           # PyO3 绑定（Python 侧 API）
├── influxdb3_authz/            # Token 认证 + RBAC 授权
├── influxdb3_clap_blocks/      # CLI 配置块（clap derive）
├── influxdb3_startup/          # env 兼容层、早期日志
├── influxdb3_commands/         # 共享 CLI 子命令
├── influxdb3_shutdown/         # 优雅关闭（ShutdownManager）
├── influxdb3_telemetry/        # 遥测（TelemetryStore）
├── influxdb3_internal_api/     # 内部 trait 定义（QueryExecutor 等）
├── influxdb3_types/            # HTTP 请求/响应类型
├── influxdb3_id/、influxdb3_process/、influxdb3_sys_events/、influxdb3_system_tables/  # 基础设施
├── core/                       # IOx 遗产库（69 子 crate，21 万行）
│   ├── iox_query/              # DataFusion 集成（IOxSessionContext/pruning）
│   ├── parquet_file/           # Parquet 文件抽象
│   ├── object_store_mem_cache/ # 对象存储 S3-FIFO 缓存
│   ├── mutable_batch/、influxdb_line_protocol/  # 列式内存 + LP 解析
│   ├── service_grpc_flight/    # FlightSQL gRPC 实现
│   ├── authz/                  # IOx 层通用授权框架
│   ├── datafusion_util/、executor/、trace/、metric/  # 查询/可观测性工具
│   └── ...                     # 其余 60 个子 crate
└── cli_types/、object_store_utils/、object_store_limit/  # 通用工具
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/influxdb3-internals/module-dependencies.svg)

模块间的依赖呈"serve_main 中心辐射 + 存储与查询对 Catalog 的共同依赖"结构。`serve_main`（编排层）装配全部子系统；`influxdb3_server` 是请求入口，向下调用写入与查询；存储引擎三模块（write/wal/cache）协作完成写入持久化；`influxdb3_catalog` 是被广泛依赖的元数据中心；`influxdb3_processing_engine` 以钩入方式挂到 WAL（触发器）与查询（in-process 端点）；`influxdb3_authz` 依赖 catalog 查权限。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 入口与启动 | CLI 解析、启动流程、serve 编排 | `influxdb3/src/lib.rs:172`（`startup`） | 装配顺序是系统正确性的前提，独立成章 | [入口与启动](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/01-entry-startup) |
| HTTP API 服务 | HTTP/gRPC 路由分发 | `influxdb3_server/src/http.rs:2609`（`route_request`） | 隔离外部协议，同端口复用 HTTP/gRPC | [HTTP API 服务](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/02-http-server) |
| 写入路径 | Line Protocol → WAL → 内存缓冲 | `influxdb3_write/src/lib.rs:66`（`WriteBuffer`） | 写入是 TSDB 生命线，与查询职责正交 | [写入路径](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/03-write-path) |
| WAL 与缓存 | diskless WAL + 三缓存 | `influxdb3_wal/src/object_store.rs` | 持久性与查询加速是两个独立关注点 | [WAL 与缓存](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/04-wal-cache) |
| Catalog 元数据 | 事件溯源 + 版本化元数据 | `influxdb3_catalog/src/catalog/versions/v3/catalog.rs` | 元数据一致性是数据库正确性根基 | [Catalog 元数据](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/05-catalog) |
| 查询执行 | DataFusion 查询，三语言统一 | `influxdb3_query_executor/src/lib.rs:60` | 查询引擎可独立演进，不耦合写入 | [查询执行](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/06-query-execution) |
| Parquet 与对象存储 | 列式持久化 + S3-FIFO 缓存 | `core/parquet_file/src/lib.rs` | diskless 架构的物理基座 | [Parquet 与对象存储](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/07-parquet-object-store) |
| 处理引擎 | Python VM 插件/触发器 | `influxdb3_processing_engine/src/lib.rs` | 扩展机制独立于核心引擎 | [处理引擎](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/08-processing-engine) |
| 认证授权 | Token 认证 + RBAC bitmap | `influxdb3_authz/src/lib.rs` | 安全策略横切，独立演进 | [认证授权](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/09-authz) |

---

## 运行时行为

### 启动流程

进程从 `influxdb3/src/main.rs:4` 的 `main()` 进入，调用 `influxdb3_lib::startup()`（`lib.rs:172`）。`startup` 先做启动前准备：安装 rustls crypto provider、`install_crash_handler`（SIGSEGV→栈迹）、`load_dotenv`、`env_compat::copy_env_aliases`（36 对旧环境变量别名，必须在 clap 解析前执行）。然后自定义 help 检查（禁用了 clap 内置 help，手写 `.txt` 帮助文件），再 `Config::command().get_matches_from(args)` 解析参数。

若用户显式 `serve` 子命令，进入 `serve_main`（`lib.rs:330`）→ `commands::serve::command()`（`serve.rs:937`）。`command()` 按 44 步顺序装配：先建 metric registry + shutdown token + time provider + SysEventStore，再建 object_store 包装链（基础 store → ObjectStoreMetrics → parquet_cache），然后 ParquetStorage + 双 DataFusion Executor（主查询 + 写路径，独立 metrics registry 避免共享 panic），接着 Catalog 初始化、table_index_cache、LastCache/DistinctCache、WriteBufferImpl、deleter、内存检查后台任务，再建 ProcessingEngine、TelemetryStore，最后 QueryExecutorImpl、HTTP listener、`ProcessingEngineManagerImpl`、authz（`TokenAuthenticator` 或 `NoAuthAuthenticator`）、HttpApi、Server，进入 `futures::select!` 四路等待（signal/frontend/backend/recovery）。

对象装配的关键：依赖通过 `Arc<dyn Trait>` 共享，`WriteBufferImplArgs`/`CreateQueryExecutorArgs`/`CreateServerArgs` 等 struct 封装多参数构造；配置来自 clap derive（`#[clap(flatten)]` 组合 `ObjectStoreConfig`/`TokioIoConfig` 等），环境变量经 `env_compat` 别名兼容。

### 核心运行流程

InfluxDB 3 Core 运行时有三条主链路：写入持久化、查询读取、WAL 触发器。写入与查询是用户可见的请求路径，触发器是后台异步钩子。

#### 写入链路：Line Protocol 到 Parquet 落盘

业务流程：HTTP 写入 → Line Protocol 解析 → 校验+建表+分区 → WAL 持久化 → 内存缓冲 → （snapshot 时）Parquet 落盘。

![写入与查询数据流](/vibe-reading/images/articles/influxdb3-internals/data-flow.svg)

文字描述：HTTP 请求经 `route_request` 分发到 `write_lp`，`parse_lines()` 用 nom 解析 Line Protocol 为 `ParsedLine`；`WriteValidator`（类型状态机 `Initialized → LinesParsed → CatalogChangesCommitted`）开启 catalog 事务、自动建表建列、计算 `chunk_time`（`Gen1Duration` 默认 600 秒），产出 `WriteBatch`；`wal.write_ops(WalOp::Write(write_batch))` 缓冲后由后台 `background_wal_flush`（每 `flush_interval` 默认 1s）序列化为 bitcode+CRC32 文件 PUT 到对象存储；持久化后回调 `WalFileNotifier::notify` → `QueryableBuffer` 更新 Last/Distinct 缓存并把数据载入 `TableBuffer`（Arrow builders）；当 WAL snapshot 触发时，`TableBuffer::snapshot` 移出旧 chunk，`sort_dedupe_persist` 去重排序后 `Persister::persist_parquet_file` 用 ArrowWriter+ZSTD 写 Parquet 到对象存储，并写 snapshot manifest。

#### 查询链路：SQL 到 RecordBatch

业务流程：HTTP 查询 → QueryExecutorImpl → Database 构造会话 → Planner 生成逻辑+物理计划 → TableProvider.scan 获取 chunks → DataFusion 执行 → RecordBatch 返回。

文字描述：`route_request` 分发到 `query_sql`，`QueryExecutorImpl::query_sql` 从 `catalog.db_schema` 取 `DatabaseSchema` 构造 `Database` 对象；`query_database_sql` 调 `db.new_query_context()` 构造 `IOxSessionContext`（注册 IOx analyzer/optimizer/UDTF），`Planner::sql` 在 `DedicatedExecutor`（独立 CPU 线程池，与 IO runtime 隔离）上生成逻辑计划（DataFusion `create_logical_plan`）+物理计划（`IOxQueryPlanner`）；物理计划执行时调 `QueryTable::scan` → `write_buffer.get_table_chunks`（含 retention period cutoff + `ChunkFilter`），`ChunkTableProvider` 构建 `DataSourceExec`（Parquet 读取经 pruning 裁剪 chunk），结果经 `CrossRtStream`（mpsc channel(1) 桥接 DedicatedExecutor 与 IO runtime）返回 `SendableRecordBatchStream`。Last-value 查询走 `last_cache` UDTF 快路径绕过 Parquet 扫描。

#### 触发器链路：WAL 文件通知到 Python 执行

业务流程：WAL 持久化 → add_file_notifier 通知 ProcessingEngine → Scheduler 调度 → Worker 执行 Python 插件。

文字描述：`serve.rs:1428` 的 `write_buffer.wal().add_file_notifier(&processing_engine)` 注册 ProcessingEngine 为 WAL 观察者；WAL 持久化后 `ProcessingEngineManagerImpl` 的 `WalFileNotifier::notify`（`wal.rs`）调用 `write_batch_to_wal_content` 转换数据，匹配注册的 WAL 触发器；`SchedulerRuntime`（单 tokio task 事件循环）将触发器状态 `TriggerState` 通过 `TriggerScheduler`/`TriggerWorker` trait 协议提交给 `PythonTriggerWorker`；Worker 在 `spawn_blocking` 中获取 GIL，`PyPluginCallApi` 调用 Python 插件函数，插件通过 `QueryEndpoint`/`WriteEndpoint` 回调 Rust（in-process，零 IPC）；取消通过 `CancellationToken` + Python 侧 `KeyboardInterrupt`（BaseException，不被 `except Exception` 吞噬）实现。

---

## 典型修改场景

#### 场景 1：新增一个 CLI 子命令（如 `influxdb3 backup`）

需修改 `influxdb3/src/lib.rs`：在 `Command` enum（`lib.rs:127`）加 `Backup` 变体，在 `maybe_print_help` 的 `SubCommand` enum 加对应分支，在 `non_serve_main`（`lib.rs:466`）的 match 加分发；新建 `influxdb3/src/commands/backup.rs` 定义 `Config` + `command()`；更新 `help/` 文本文件。

#### 场景 2：新增一个 HTTP API 端点

需修改 `influxdb3_server/src/all_paths.rs` 加路径常量；`influxdb3_server/src/http.rs` 在 `impl HttpApi` 加 handler 方法，在 `perform_routing`（`http.rs:2680`）match 块加新 arm。对应测试在 `http/tests.rs`。

#### 场景 3：新增一种缓存类型（如 Min/Max Cache）

需修改 `influxdb3_cache/src/lib.rs` 加 `pub mod minmax_cache`；新建 `cache.rs`（参考 `last_cache/cache.rs`）+ `provider.rs`（含 `new_from_catalog`、`write_wal_contents_to_cache`、`background_catalog_update`）+ `table_function.rs`（DataFusion `TableProvider`）；`influxdb3_write/src/write_buffer/queryable_buffer.rs` 在 `QueryableBuffer` 加字段，在 `write_wal_contents_to_caches`（行 147）加调用；`influxdb3_catalog` 加 `CatalogEvent::MinMaxCacheCreated/Deleted`。对应测试：`influxdb3_cache/src/minmax_cache/tests.rs`。

---

## 测试体系

InfluxDB 3 采用 Rust 内联测试惯例——每个模块的 `src/` 下放 `tests.rs` 或 `tests/` 子目录，共 169 个测试文件。测试分层与代码对应：

| 代码层 | 测试类型 | 示例路径 |
| --- | --- | --- |
| 核心 crate（`core/*`） | 单元 + 集成 | `core/mutable_batch/tests/`、`core/iox_query/src/physical_optimizer/` |
| 应用 crate（`influxdb3_*`） | 内联 `tests.rs` | `influxdb3_authz/src/authorizer/tests.rs`、`influxdb3_write/src/write_buffer/validator.rs` 内 `tests` mod |
| 端到端 | HTTP API 集成 | `influxdb3_server/src/http/tests.rs`、`influxdb3_server/src/tests.rs` |

`run-tests.sh` 提供测试编排。理解某模块时优先读其 `tests.rs`——Rust 测试是很好的"可执行文档"。修改某层代码时，参照上表找对应测试。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `influxdb3/src/main.rs`（6 行入口）→ `influxdb3/src/lib.rs:172` 的 `startup()` → `influxdb3/src/commands/serve.rs:937` 的 `command()`（44 步装配）→ `influxdb3_server/src/http.rs:2609` 的 `route_request`（路由分发）
- **第二遍：理解写入数据流**
  `core/influxdb_line_protocol/src/lib.rs:580` 的 `parse_lines` → `influxdb3_write/src/write_buffer/validator.rs:82` 的 `WriteValidator` → `influxdb3_write/src/write_buffer/queryable_buffer.rs:488` 的 `notify` → `influxdb3_write/src/persister.rs:924` 的 `persist_parquet_file`
- **第三遍：理解查询数据流**
  `influxdb3_query_executor/src/lib.rs:60` 的 `QueryExecutorImpl` → `lib.rs:625` 的 `new_query_context` → `core/iox_query/src/exec/context.rs:435` 的 `IOxSessionContext` → `influxdb3_query_executor/src/lib.rs:790` 的 `QueryTable::scan`
- **第四遍：理解元数据与扩展**
  `influxdb3_catalog/src/catalog.rs`（325 行 Catalog 主结构）→ `influxdb3_catalog/src/format/apply.rs:339` 的 `apply_records`（事件溯源 replay）→ `influxdb3_processing_engine/src/scheduler.rs`（触发器调度）

每遍聚焦一处，从入口追到落盘/返回，理解数据结构如何变化（`ParsedLine → WriteBatch → TableBuffer → Parquet`；`SQL → LogicalPlan → ExecutionPlan → RecordBatch`）。

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| TSDB | Time Series Database，时序数据库，优化按时间排序的数据写入与查询 |
| diskless | 节点不持有持久状态，WAL 与 Parquet 均存对象存储 |
| IOx | InfluxDB 3 的前称（原项目名），`core/` 目录是其遗产代码 |
| Line Protocol | InfluxDB 文本写入格式：`measurement,tag=val field=val timestamp` |
| chunk_time | 按 `Gen1Duration`（默认 10 分钟）分桶的时间键，用于 Parquet 分区 |
| UDTF | User Defined Table Function，DataFusion 表函数，last_cache/distinct_cache 通过它暴露 |
| DedicatedExecutor | IOx 自定义 tokio 线程池，隔离 CPU-bound 查询与 IO runtime |
| CatalogEvent | Catalog 领域事件，广播给 subscriber（cache/deleter/processing_engine） |
| gen1_duration | 第一代时间分桶粒度（10 分钟），`chunk_time_for_timestamp` 计算分区 |

### 参考资料

- [InfluxDB 3 Core 官方文档](https://docs.influxdata.com/influxdb3/core/)
- [InfluxDB 3 GA 博客](https://www.influxdata.com/blog/influxdb-3-oss-ga/)
- [Apache DataFusion](https://datafusion.apache.org/)
- [Apache Arrow](https://arrow.apache.org/)
- 仓库：[github.com/influxdata/influxdb](https://github.com/influxdata/influxdb) tag `v3.11.1`
