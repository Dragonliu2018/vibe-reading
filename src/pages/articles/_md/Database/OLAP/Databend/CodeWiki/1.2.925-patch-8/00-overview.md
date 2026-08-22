---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "Overview"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "OLAP", "云原生数仓", "向量化执行"]
description: "Databend 1.2.925——Rust 云原生企业级数据仓库，向量化执行 + Cascades 优化器 + Parquet 段存储 + Raft 元服务源码解读。"
readingTime: "75 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 1.2.925-patch-8 · **协议** Apache-2.0 / Elastic-2.0 · **Rust** edition 2024 · **代码量** ~86.2 万行 · **仓库** [GitHub](https://github.com/databendlabs/databend)

---

## 总览

### 项目简介

Databend 是一个用 **Rust** 编写的开源**云原生企业级数据仓库（cloud-native data warehouse）**，定位为"面向 AI Agent 的企业数据仓库"。它的核心设计目标是：在大规模云对象存储（S3/Azure/GCS）之上，提供弹性的存算分离架构、向量化查询执行、以及完整的分析能力（SQL 分析、向量检索、全文检索、自动 Schema 演进）。

Databend 解决的核心问题是：**在云对象存储上构建一个高性能、可弹性伸缩的分析型数据仓库**，同时保持部署简单（无独立存储节点，数据直接存于 S3）。与传统 MPP 数仓（如 Greenplum、ClickHouse）依赖本地盘不同，Databend 将存储与计算彻底分离——数据以 Parquet 列式格式存放在对象存储，元数据由独立的 Raft 元服务管理，计算节点无状态可随时增减。核心价值在于：存算分离带来弹性伸缩能力，向量化执行引擎在云存储上仍能保持高吞吐，MVCC 快照实现了 Time Travel 与并发控制。

核心使用场景：企业级 OLAP 分析查询、SaaS 数据云服务、AI Agent 数据编排（沙箱 UDF + SQL 编排 + 事务保证）、Git-like 数据分支（在生成数据快照上安全实验）。**项目边界**：Databend 面向分析型工作负载（批量扫描、聚合），**不**是 OLTP 引擎（非单行点查优化）；它依赖云对象存储而非本地 SSD 存储，**不**适合要求超低延迟本地访问的场景。

### 功能矩阵

| 特性 | 实现路径 | 说明 |
| --- | --- | --- |
| SQL 分析查询 | `src/query/sql/` + `src/query/pipeline/` | 完整 SQL 方言，Cascades 代价优化，向量化执行 |
| 多协议接入 | `src/query/service/src/servers/` | MySQL / HTTP REST / Arrow Flight SQL 三协议 |
| Parquet 段存储 | `src/query/storages/fuse/` | 原生 Fuse 引擎，Snapshot→Segment→Block 三层 |
| 存算分离 | `src/common/storage/` + `src/meta/` | OpenDAL 抽象对象存储 + Raft 元服务 |
| MVCC 与 Time Travel | `storages/fuse/src/operations/commit.rs` | 快照版本链 + 乐观锁 CAS 提交 |
| 向量检索 | `src/query/storages/fuse/src/pruning/` | 向量索引裁剪 |
| 全文检索 | tantivy 引擎集成 | 倒排索引裁剪 |
| 分布式执行 | `src/query/service/src/schedulers/` | Fragment 切分 + Exchange 数据交换 |
| Python UDF 沙箱 | `src/bendpy/` + `arrow-udf-runtime` | Lua/WASM 脚本 UDF |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Rust edition 2024 | 核心 | 主开发语言，零成本抽象 + 内存安全 |
| tokio | 核心 | 异步运行时，IO/查询/控制三线程池隔离 |
| Apache Arrow 58 | 核心 | 列式内存格式基础，Flight SQL 协议 |
| Parquet 58 | 核心 | 列式存储文件格式 |
| OpenDAL 0.54 | 核心 | 对象存储抽象（S3/GCS/Azure/OSS/OBS 等 12 后端）|
| tonic / prost | 核心 | gRPC 通信（meta client ↔ metasrv）|
| openraft（外部 databend-meta）| 核心 | Raft 共识协议（元服务高可用）|
| petgraph | 核心 | Pipeline DAG 图结构（StableGraph）|
| nom + pratt | 核心 | SQL 词法/语法分析（递归下降 + Pratt parser）|
| tantivy | 可选 | 全文检索倒排索引 |
| mlua | 可选 | Lua UDF 脚本引擎 |
| geozero | 可选 | 地理空间数据处理 |

### 版本历史

Databend 经历了从 "datafuse" 早期命名到成熟云原生数仓的演进。当前 1.2.x 版本线的一个重要架构变化是：**元服务（Meta Service）的 raft 核心被拆分到独立仓库** `github.com/databendlabs/databend-meta`（git 依赖 `v260512.4.0`），主仓库保留客户端 API 层、数据模型和二进制入口。这使得 raft 共识引擎可以独立于 query 版本节奏迭代，同时减少了 query 的编译依赖。存储格式方面，Fuse 引擎已统一到 Parquet（移除了早期的 native 格式）。

---

## 快速上手

```bash
# 方式 1：Python 本地模式（开发测试，需 Python 3.12+）
pip install "databend-driver[local]>=0.34.0"
```

```python title="quickstart.py"
from databend_driver import connect

conn = connect("databend+local:///./local-state")
print(conn.query_row("SELECT 'Hello, Databend!'").values())
```

```bash
# 方式 2：Docker 完整数仓
docker run -p 8000:8000 -p 3306:3306 \
  -v /tmp/databend-data:/var/lib/databend/data \
  datafuselabs/databend

# 用 MySQL 客户端连接验证
mysql -h127.0.0.1 -P3306 -uroot
```

预期输出：查询返回 `Hello, Databend!`，证明 query 服务与本地存储（Fuse 引擎）正常工作。Docker 模式下 meta 服务默认嵌入式运行（LocalMetaService）。

---

## 架构设计解析

### 系统架构

Databend 采用**严格的存算分离**架构思想：数据存储在云对象存储（S3 等），元数据由独立的 Raft 元服务管理，计算节点（query）无状态。这种设计让计算节点可以随负载弹性伸缩，而数据持久性由对象存储的 11 个 9 可靠性保证。

从查询处理视角，Databend 是一个经典的分层编译执行模型——SQL 文本经过词法/语法分析生成 AST，经 Binder 转为逻辑计划树（SExpr），经 Cascades 优化器选最优物理计划，最终编译为 Processor DAG 在向量化执行引擎中运行。各层职责清晰、单向依赖。

![Databend 分层架构](/vibe-reading/images/articles/databend-internals/architecture.svg)

系统分为六层，自上而下、上层依赖下层：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 协议接入层 | `src/query/service/src/servers/` | 隔离外部协议（MySQL/HTTP/Flight），编解码后统一转交执行路径 |
| 服务编排层 | `sessions/` `interpreters/` `schedulers/` | 会话管理、Interpreter 分发（178 种）、查询排队、分布式调度 |
| 编译优化层 | `src/query/ast/` `src/query/sql/` | SQL→AST→逻辑计划→Cascades 代价优化→物理计划 |
| 执行引擎层 | `src/query/pipeline/` | 向量化 Processor DAG，push-pull 背压数据流 |
| 存储引擎层 | `src/query/storages/` `src/query/catalog/` | Fuse Parquet 段存储 + Catalog/Table/Database 抽象 |
| 元数据与基础设施层 | `src/meta/` `src/common/` | Raft 元服务（外部仓库）+ 列式内核/Runtime/IO/哈希表 |

层间协作的关键在于**单向依赖**——编译层不感知执行细节，执行层不感知存储格式，存储层通过 `Table` trait 被上层调用。`expression`（表达式与列式内核）是全仓被 import 最多的模块（7187 次），是所有层共享的数据结构基础。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Interpreter 工厂 | `interpreter_factory.rs:148` `InterpreterFactory::get` | 178 种 SQL 语句类型按 `Plan` variant 分发，入口统一做权限检查与审计 |
| Cascades 框架 | `optimizer/ir/memo.rs` `Memo`/`Group`/`MExpr` | 搜索空间去重 + 任务驱动 + 代价下界剪枝，控制优化搜索预算 |
| Processor DAG + 背压 | `pipeline/src/core/port.rs` `InputPort`/`OutputPort` | 三标志位无锁 CAS 协议，数据 push 控制流 pull，实现零拷贝背压 |
| enum dispatch | `expression/src/types.rs` `DataType`/`Column` | 用 enum 替代 trait object，零开销虚函数，编译期类型展开 |
| Copy-on-Write 快照 | `storages/common/table_meta/.../snapshot.rs` | 写操作不修改已有数据，生成新快照，实现 MVCC 与 Time Travel |
| 全局单例 | `common/base/src/base/singleton_instance.rs` `GlobalInstance` | 按类型做 key 的注册表，替代 DI 容器，编译期类型安全 |
| KV/CRUD API 分层 | `meta/api/src/kv/` `KVApi`→`KVPbApi`→`KVPbCrudApi` | 四层 trait + blanket impl，新资源类型自动获得全部 CRUD 能力 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `SExpr` | 逻辑/优化后的计划树 | 查询级 | 被 `Plan::Query` 持有，`RelOperator` 为节点 |
| `PhysicalPlan` | 物理计划（trait object） | 查询级 | 由 `PhysicalPlanBuilder` 从 SExpr 构建 |
| `Pipeline` | Processor DAG 图 | 查询级 | `StableGraph<Node,Edge>`，由 `PipelineBuilder` 构建 |
| `DataBlock` | 列式数据块 | 查询执行期 | `Vec<BlockEntry>`，Processor 间流动的数据单元 |
| `TableSnapshot` | 存储快照（MVCC 版本） | 持久化 | 指向 `SegmentInfo` 列表，`prev_snapshot_id` 成链 |
| `MetaStore` | 元服务客户端 | 进程级 | 本地/远程 gRPC 双模式，impl `KVApi` |
| `QueryContext` | 查询上下文 | 查询级 | 持有 catalog/cluster/settings，每查询创建 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Table` trait | `catalog/src/table.rs:71` | `FuseTable`、`IcebergTable`、`ParquetTable` 等 | 存储引擎工厂 `try_create` |
| `Catalog` trait | `catalog/src/catalog/interface.rs:147` | `ImmutableCatalog`、`MutableCatalog` | `CatalogCreator::try_create` |
| `Interpreter` trait | `interpreters/interpreter.rs:71` | 178 个 `XxxInterpreter` | `InterpreterFactory::get` 按 Plan variant 分发 |
| `Processor` trait | `pipeline/src/core/processor.rs:50` | `Transformer`/`Sinker`/`Sourcer`/`ExchangeSource` | `PipelineBuilder` 按 PhysicalPlan 节点构建 |
| `Rule` trait | `optimizer/optimizers/rule/rule.rs:72` | ~40 条优化规则 | `RuleFactory::create_rule` + `DEFAULT_REWRITE_RULES` |
| `Optimizer` trait | `optimizer/optimizer_api.rs` | `CascadesOptimizer`/`RecursiveRuleOptimizer`/`DPhpyOptimizer` | `OptimizerPipeline::add` 链式编排 |
| `AggregateFunction` trait | `expression/src/aggregate/aggregate_function.rs` | `AggregateCountFunction`/`NumberSumState` 等 | `AggregateFunctionFactory` + Combinator |

---

## 代码目录

```
databend/
├── src/
│   ├── query/                    # 查询引擎主体 (~70 万行)
│   │   ├── service/              # 服务编排层 (201k) — servers/sessions/interpreters/schedulers
│   │   ├── storages/             # 存储引擎 (133k) — fuse(57k)/common(31k)/parquet/iceberg/delta
│   │   ├── sql/                  # SQL 编译 (109k) — planner/binder/optimizer/executor
│   │   ├── functions/            # 函数库 (65k) — scalars/aggregates/srfs
│   │   ├── expression/           # 表达式与列式内核 (65k) — DataType/Column/Block/Evaluator
│   │   ├── ast/                  # SQL 解析 (39k) — tokenizer/parser/AST
│   │   ├── pipeline/             # 执行引擎 (25k) — Processor/Pipeline/Port/transforms
│   │   ├── catalog/              # Catalog 抽象 (8.5k) — Catalog/Table/Database trait
│   │   ├── management/           # 管理服务 (10.8k) — user/role/procedure
│   │   └── config/ settings/     # 配置与设置
│   ├── meta/                     # 元服务 API/模型/入口 (82.5k，raft 核心在外部仓库)
│   ├── common/                   # 公共基础 (70.7k) — base/column/io/hashtable/exception/storage
│   ├── binaries/                 # 二进制入口 — databend-query (oss/ee main)
│   └── bendpy/                   # Python 绑定
├── tests/                        # 测试 — sqllogictests/meta-cluster/fuzz
└── Cargo.toml                    # workspace，含外部 databend-meta git 依赖
```

---

## 模块地图

Databend 的模块划分遵循查询处理的自然职责边界——从协议接入、SQL 编译、优化、执行到存储，再辅以共享的列式内核、函数库、元服务和基础设施。模块间单向依赖，`expression` 作为列式数据结构内核被几乎所有模块依赖。

![模块依赖关系](/vibe-reading/images/articles/databend-internals/module-dependencies.svg)

图中实线箭头表示主调用链（query-service 编排编译执行存储），虚线箭头表示基础设施依赖（各模块依赖 expression 列式内核和 common 基础设施）。`expression-columnar` 是全仓 fan-in 最高（7187 次 import）的模块，定义了 `DataType`/`Column`/`DataBlock` 等所有模块共享的核心数据结构。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 服务层 | 协议接入、会话、Interpreter 分发、调度 | `InterpreterFactory::get` | 协议与执行解耦，三协议复用执行路径 | [01-query-service](01-query-service) |
| SQL 解析 | 词法/语法分析→AST | `parse_sql` | 纯语法叶子，零内部依赖，可独立复用 | [02-sql-parser](02-sql-parser) |
| SQL 编译 | AST→逻辑计划（Binder+Planner） | `Planner::plan_stmt` | 语义分析与语法分离，Metadata 解耦 | [03-sql-planner](03-sql-planner) |
| 优化器 | Cascades CBO + DPhyp + 规则 | `Optimizer::optimize` | 搜索空间与代价模型独立于执行 | [04-optimizer](04-optimizer) |
| 执行引擎 | 向量化 Processor DAG | `PipelineBuilder::finalize` | push-pull 背压，借鉴 ClickHouse 处理器模型 | [05-execution-engine](05-execution-engine) |
| 存储引擎 | Parquet 段存储 + MVCC 快照 | `FuseTable::read_partitions` | 三层裁剪减 IO，Copy-on-Write 并发控制 | [06-fuse-storage](06-fuse-storage) |
| 表达式与列式 | DataType/Column/Block/Evaluator | `Evaluator::run` | 全仓数据结构基础，enum dispatch 零开销 | [07-expression-columnar](07-expression-columnar) |
| 函数库 | 标量/聚合/SRF 函数 | `FunctionRegistry` | 函数注册与求值解耦，三阶段分布式聚合 | [08-functions](08-functions) |
| 元数据服务 | schema/tenant 元数据 + KV API | `MetaStore` | raft 拆到独立仓库，API 层与实现解耦 | [09-meta-service](09-meta-service) |
| 公共基础 | Runtime/IO/hashtable/exception/对象存储 | `GlobalInstance` | 最底层依赖，被所有模块引用 | [10-common-base](10-common-base) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

Databend Query 进程启动由 `src/binaries/query/oss_main.rs` 的 `main()` 驱动：

```
main()                                          [oss_main.rs]
├── set_crash_hook + SignalListener::spawn       — 崩溃追踪与信号处理
├── ThreadTracker::init()                        — 初始化线程追踪
├── Runtime::with_default_worker_threads("main-worker")  — 创建主运行时
└── main_entrypoint()                            [oss_main.rs]
    ├── Cmd::parse()                             — 解析命令行
    └── init_services(conf, ee_mode)             [entry.rs:55]
         ├── set_panic_hook + set_alloc_error_hook
         ├── GlobalInstance::init_production()   — 全局实例注册表初始化
         ├── GlobalServices::init(conf)          [global_services.rs:79]
         │   ├── Config / Logger 加载
         │   ├── GlobalIORuntime::init()         — IO 线程池（对象存储 IO）
         │   ├── ClusterDiscovery                — 集群节点发现
         │   ├── CatalogManager::init()          — 创建 MetaStore 客户端
         │   ├── QueriesQueueManager             — 查询排队管理
         │   ├── DataExchangeManager             — 分布式 fragment 交换
         │   ├── SessionManager                  — 会话管理
         │   ├── UserApiProvider                 — 用户/角色 API
         │   ├── DataOperator::init()            — 对象存储初始化（OpenDAL）
         │   └── CacheManager                    — 缓存管理
         └── start_services(conf)                — 启动各协议 Server
              └── ShutdownHandle.add_service()    — MySQLHandler/HttpHandler/FlightSQLServer
```

对象装配采用全局单例模式（`GlobalInstance`）：`GlobalServices::init` 按严格顺序注册各组件到类型化全局注册表（注释标注 "The order of initialization is very important"）。`MetaStore` 客户端由 `CatalogManager::init` 创建，根据配置选择本地嵌入式（`LocalMetaService`）或远程 gRPC（`MetaGrpcClient`）模式。

### 核心运行流程

Databend 的运行时行为围绕**查询处理主链路**展开。下面三条链路覆盖了最重要的运行模式：SELECT 查询执行、数据写入（INSERT/Mutation）、分布式查询调度。

#### 查询处理：SELECT 执行主链路

业务流程：用户提交 SQL → 解析→绑定→优化→物理计划→构建 Pipeline→执行→返回列式数据流

![查询执行数据流](/vibe-reading/images/articles/databend-internals/data-flow.svg)

文字描述：从 `do_query`（`mysql_interactive_worker.rs:396`）出发，`interpreter_plan_sql` 创建 `Planner` 并依次调用 `parse_sql`（Tokenizer+parser→`Statement` AST）和 `plan_stmt`（`Binder::bind` 将 AST 绑定为 `SExpr` 逻辑计划树，`optimize` 经 `OptimizerPipeline` 多阶段优化含 Cascades CBO）。优化后的 `Plan` 经 `InterpreterFactory::get` 按 `Plan::Query` 分发到 `SelectInterpreter`。`SelectInterpreter::execute2` 调用 `PhysicalPlanBuilder::build` 将 SExpr 转为 `PhysicalPlan`，再经 `build_query_pipeline`→`PipelineBuilder::finalize` 递归构建 `Pipeline`（Processor DAG）。最后 `execute_built_pipeline` 用 `PipelinePullingExecutor` 启动同步线程池执行，通过 `async_channel` 桥接回异步结果流 `SendableDataBlockStream`。存储读路径在 `PhysicalTableScan::build_pipeline2` 中调用 `FuseTable::read_data`，沿 Snapshot→Segment→Block 三层裁剪读取 Parquet。

关键设计决策：(1) `plan_sql` 是独立函数而非 `Planner` 方法，内部创建 Planner 实例，使查询日志与计划逻辑解耦；(2) Pipeline 执行主体是**同步的**（`QueryPipelineExecutor::execute` 在 OS 线程中运行），通过 `async_channel` + `tokio::select!` 桥接到 async 世界，避免了 async runtime 在 CPU 密集执行上的开销；(3) 类型名为 `SelectInterpreter`（`name()` 返回 `"SelectInterpreterV2"`），不存在 `InterpreterSelectV2` 类型。

#### 数据写入：INSERT / Mutation 链路

业务流程：INSERT/UPDATE/DELETE → 追加数据→序列化 Parquet→提交新快照（CAS 乐观锁）

文字描述：`InterpreterFactory::get` 将 `Plan::Insert`/`Plan::DataMutation` 分发到对应 Interpreter。写路径调用 `FuseTable::append_data`（`fuse_table.rs:1003`）→ `do_append_data` 将 `DataBlock` 经 `TransformSerializeBlock` 序列化为 Parquet 块写入对象存储，生成 `BlockMeta` + 索引。随后 `commit_insertion`→`do_commit`（`commit.rs:81`）用 `AppendGenerator` 从前一个 `TableSnapshot` 克隆（Copy-on-Write），合并新旧 segments 生成新快照，再通过 `update_table_meta` 以 `MatchSeq::Exact(table_version)` CAS 更新元服务中的快照位置。版本冲突时自动重试合并并发追加的 segments（`commit_mutation` 的 backoff 循环）。

#### 分布式：Fragment 调度链路

业务流程：分布式计划→切分 Fragment→分发到各节点→Exchange 数据交换→汇聚

文字描述：当 `plan.is_distributed_plan()` 为真时，`build_distributed_pipeline`（`scheduler.rs:101`）用 `Fragmenter::build_fragment` 在 `Exchange` 节点处切分 `PhysicalPlan` 为多个 `PlanFragment`。每个 fragment 经 `get_actions` 生成执行节点分配，`ExchangeManager::commit_actions` 通过 Flight RPC 将 fragments 分发到远端节点（`init_query_fragments`）。数据交换通过 `ExchangeSink`→Flight do_exchange→`ExchangeSource` 实现，Exchange 类型决定数据流：`Merge`（汇聚）、`Broadcast`（广播）、`NodeToNodeExchange`（点对点 shuffle）、`GlobalShuffleExchange`（全局 hash shuffle）。

---

## 典型修改场景

#### 场景 1：新增一种 SQL 语句的 Interpreter

以新增 `CREATE MATERIALIZED VIEW` 为例：需在 `src/query/sql/src/planner/plans/plan.rs` 的 `Plan` 枚举添加 variant；在 `src/query/ast/` 添加 AST 与 parser 解析；在 `src/query/sql/src/planner/binder/` 添加 bind 逻辑；新建 `src/query/service/src/interpreters/interpreter_materialized_view_create.rs` 实现 `Interpreter` trait 的 `execute2`；在 `interpreter_factory.rs` 的 `get_inner` match 中添加分发 arm；在 `interpreters/mod.rs` 注册模块。对应测试：`tests/sqllogictests/suites/`。

#### 场景 2：新增一个执行算子（Transform）

需在 `src/query/pipeline/transforms/src/processors/transforms/` 新建文件实现 `Transform` trait（1:1）或 `AccumulatingTransform`（1:N）；在 `src/query/service/src/physical_plans/` 新建 `physical_xxx.rs` 实现 `IPhysicalPlan::build_pipeline2`，在其中调用 `pipeline.add_transform`；在 `PhysicalPlanBuilder::build_physical_plan` 的 match 中添加从 `RelOperator` 到新物理节点的转换。对应测试：`tests/sqllogictests/`。

#### 场景 3：新增一个标量函数

在 `src/query/functions/src/scalars/` 对应子模块的 `register` 函数内，用 Builder 模式注册：`registry.scalar_builder("name").function().typed_1_arg::<I,O>().passthrough_nullable().calc_domain(fn).each_row(fn).register()`。无需修改 expression evaluator 或 FunctionRegistry 本身。对应测试：`src/query/functions/src/scalars/*/tests/`。

---

## 测试体系

```
tests/
├── sqllogictests/     # 主测试体系 — SQL 逻辑正确性验证（srlt 格式）
│   ├── suites/        # 按功能分组的测试用例
│   └── scripts/       # 测试脚本
├── meta-cluster/      # 元服务集群测试（多节点 raft）
├── fuzz/              # 模糊测试（sqlsmith 生成随机 SQL）
├── compat/            # 版本兼容性测试
└── databend-test/     # 集成测试框架
```

| 代码层 | 测试类型 | 说明 |
| --- | --- | --- |
| SQL 语义/执行 | sqllogictests | 标准的 round-trip 结果比对，覆盖绝大部分功能 |
| 优化器 | `sql/src/tests/` + sqlsmith | 计划正确性 + 随机 SQL 压力测试 |
| Meta 服务 | meta-cluster + metaverifier | raft 集群一致性、故障恢复验证 |
| 存储 | `storages/fuse/benches/` + compat_fuse | 存储格式兼容性、性能基准 |

---

## 阅读源码推荐路线

- **第一遍：理解查询主流程**
  `src/binaries/query/oss_main.rs` 的 `main_entrypoint` → `entry.rs` 的 `init_services`/`start_services` → `mysql_interactive_worker.rs:396` 的 `do_query` → `interpreter.rs:303` 的 `plan_sql` → `interpreter_factory.rs:148` 的 `InterpreterFactory::get` → `interpreter_select.rs:296` 的 `execute2`
- **第二遍：理解编译流水线**
  `planner.rs` 的 `Planner::plan_stmt` → `binder.rs` 的 `Binder::bind`/`bind_statement` → `optimizer.rs:247` 的 `optimize_query` → `physical_plan_builder.rs:110` 的 `build_physical_plan`
- **第三遍：理解执行与存储**
  `pipeline/src/core/processor.rs` 的 `Processor` trait + `port.rs` 的 `InputPort`/`OutputPort` → `pipeline_builder.rs:86` 的 `PipelineBuilder::finalize` → `fuse_table.rs:962` 的 `read_partitions` → `fuse_table.rs:992` 的 `read_data`
- **第四遍：理解核心数据结构**
  `expression/src/types.rs` 的 `DataType` + `values.rs` 的 `Column`/`Scalar` → `block.rs` 的 `DataBlock` → `evaluator.rs` 的 `Evaluator::run` → 选择重点子模块深入阅读（模块文档）

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| Fuse | Databend 原生存储引擎，基于 Parquet 段存储 + 快照 MVCC |
| SExpr | Single Expression，逻辑/优化后的计划树（不可变，Arc 共享） |
| MExpr | Memo Expression，Cascades Memo 内部的表达式表示 |
| Snapshot/Segment/Block | Fuse 存储三层元数据：快照→段→块 |
| Exchange | 分布式执行中 fragment 间的数据交换节点 |
| Partitions | 存储裁剪后的数据分区（Part），pipeline 的数据单元 |
| Warehouse | Databend Cloud 的弹性计算资源组 |

### 参考资料

- [Databend 官方文档](https://docs.databend.com/)
- [Cascades 优化器论文](https://15721.courses.cs.cmu.edu/student/papers/1995-graefe.pdf) — Databend Cascades 框架的理论基础
- [Dynamic Programming Strikes Back](https://15721.courses.cs.cmu.edu/student/papers/p247-neumann.pdf) — DPhyp Join Reorder 算法
- [databend-meta 独立仓库](https://github.com/databendlabs/databend-meta) — Raft 元服务核心
