---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Overview"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "Java", "C++", "MPP", "OLAP", "Volcano 执行器", "向量化执行", "Catalog god class"]
description: "Apache Doris 1.1.5-rc01 源码架构解读：1.x 末代版本、唯一 legacy 优化器（CUP+Analyzer，无 Nereids）、Volcano pull 执行引擎（无 Pipeline）、alpha/beta rowset 迁移期、exec/exprs 行式与 vec/ 向量化双轨共存的 FE/BE 分离 MPP 数仓。"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 1.1.5-rc01 · **协议** Apache-2.0 · **语言** Java 8 / C++（GCC 11+）· **代码量** ~58.7 万行（FE ~27.3 万 Java + BE ~31.4 万 C++）· **解读基线** commit `0f85e8840ea`（2022-11-18）· **仓库** [GitHub](https://github.com/apache/doris)

---

## 总览

### 项目简介

**Apache Doris** 是一个基于 MPP（Massively Parallel Processing）架构的易用、高性能、实时分析型数据库。它的前身是百度 Palo，捐献给 Apache 软件基金会后更名为 Doris。Doris 在海量数据下提供高并发低延迟点查能力，同时支撑高吞吐的 Ad-hoc 分析，兼具批量与实时小批量数据导入，提供高可用、高可靠与水平扩展能力。其核心优势在于"开发、部署、使用都简单"，用单一系统满足多种数据服务需求。技术渊源上，Doris 主要融合了 **Google Mesa** 的列存与预聚合思想，以及 **Apache Impala** 的 MPP 执行模型，基于列式存储引擎，并通过 MySQL 协议对外提供服务。

Doris 采用经典的 **FE（Frontend，Java）+ BE（Backend，C++）** 分离架构：FE 负责元数据管理、SQL 解析优化、查询协调调度、导入事务编排、集群运维（副本均衡 / Schema Change / 备份）；BE 负责执行引擎、存储引擎、表达式与函数求值、文件读写。FE 之间通过 BDB JE 复制实现元数据高可用并选主，FE 与 BE 之间通过 Thrift/brpc 通信下发执行计划与任务、回传结果与状态。

**1.1.5-rc01 的版本定位**：这是 1.x 线的候选版本（解读基线 commit `0f85e8840ea`，2022-11-18）。1.x 线是 Doris 从"百度 Palo"走向"Apache 顶级项目"的奠基阶段——确立了 FE/BE 分离、Tablet/Rowset/Segment 列存、两阶段导入事务等延续至今的架构骨架，但许多 2.x/3.x 才成熟的能力此时**尚未引入或正在迁移中**：

- **唯一的 legacy 优化器**：SQL 用 CUP 语法（`fe/fe-core/src/main/cup/sql_parser.cup`）+ JFlex 词法器解析，经 `Analyzer`（2343 行）语义分析、`StmtRewriter` 改写、`SingleNodePlanner`/`DistributedPlanner` 生成计划。**没有 Nereids**（Cascades 优化器是 2.0 才引入），优化为启发式规则 + 有限 Cost-Based Join 重排。
- **Volcano pull 执行引擎**：BE 用 `ExecNode` 的经典 `open/get_next/close` 拉模型，按 `RowBatch` 行式处理。**没有 Pipeline 引擎**（2.x 才引入拉模型 Pipeline）。
- **Catalog god class**：`catalog/Catalog.java`（7424 行）是 FE 的服务定位器，集中 50+ 管理器。2.x 才将其拆分并重命名为 `Env.java`。
- **alpha/beta rowset 迁移期**：`olap/rowset/` 同时保留 `alpha_rowset`（旧 SegmentGroup 格式）与 `beta_rowset`（segment_v2 列存），FE 可通过心跳动态切默认 rowset 类型。
- **行式 / 向量化双轨**：`exec/`+`exprs/`（行式、Impala 血统）与 `vec/`（向量化、ClickHouse 血统）并行存在，由 `enable_vectorized_engine` 开关选择（`SessionVariable.java:169`，默认 true）。2.x 起统一向量化。
- FE 入口仍是 `PaloFe.java`（Palo 命名遗产，2.x 改名 `DorisFE.java`）。

**项目边界**：Doris 负责分析型（OLAP）数据的存储与查询，**不**承担在线事务（OLTP）的强一致行级读写职责；它通过 Unique 模型提供近实时更新能力，但本质仍是面向分析的列存仓库。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| MySQL 协议接入 | `fe/.../mysql/`、`PaloFe.java` | 兼容 MySQL 协议，JDBC/BI 直连，NIO 非阻塞（`mysql/nio/`） |
| Legacy CBO 优化 | `fe/.../analysis/`、`planner/` | CUP 解析 + Analyzer + ExprRewriter + Cost-Based Join 重排 |
| Volcano 行式执行 | `be/src/exec/` | `ExecNode` pull 模型，按 `RowBatch` 行式 |
| 向量化执行 | `be/src/vec/` | 源自 ClickHouse 的列式栈（columns/data_types/functions/exec/exprs） |
| 表达式与函数 | `be/src/exprs/` | `Expr` 树 + AnyVal 求值 + dlsym 函数加载 |
| olap 列存引擎 | `be/src/olap/` | Tablet/Rowset(alpha+beta)/Segment + 两级 Compaction |
| 实时导入 | `fe/.../load/`、`httpv2/` | Broker Load / Routine Load(Kafka) / Stream Load + 两阶段事务 |
| 副本自均衡 | `fe/.../clone/` | TabletScheduler + Rebalancer（BeLoad/Partition 策略） |
| 在线 Schema Change | `fe/.../alter/` | Shadow index + watershedTxn，在线不阻塞 |
| 备份恢复 | `fe/.../backup/` | BackupHandler + 仓库（Broker/本地/S3） |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Java 8 | 核心（FE） | FE 全部逻辑，JVM 运行 |
| C++ | 核心（BE） | BE 执行与存储引擎，需 GCC 11+ |
| CUP / JFlex | 核心 | SQL 词法/语法解析器生成（`sql_parser.cup` + `sql_scanner.flex`） |
| BDB JE | 核心 | FE 元数据复制与选主（EditLog/BDBJEJournal/BDBEnvironment） |
| Thrift | 核心 | FE↔BE RPC 接口定义（`gensrc/thrift/`：PaloInternalService/BackendService 等） |
| brpc / protobuf | 核心 | BE 间及 FE↔BE 高性能 RPC（`gensrc/proto/internal_service.proto`） |
| ANTLR（间接） | 可选 | 2.x Nereids 用，1.x 未引入 |
| Xnio | 核心 | MySQL NIO 多路复用（`mysql/nio/NMysqlServer`） |

### 版本历史

Doris 主线演进可粗分为：1.x 线确立 FE/BE 分离与列存骨架，引入向量化执行（源自 ClickHouse 集成）但与行式引擎双轨并存；2.0 线引入 **Nereids Cascades 优化器**与 **Pipeline 拉模型执行引擎**，将 god class `Catalog` 拆分重命名为 `Env`，统一向量化、完成 segment_v2 迁移；3.0/4.x 线引入云原生存算分离、完善 MoW Unique 表性能、联邦数据源。**1.1.5-rc01** 是 1.x 末代候选版本（2022-11-18），处于"legacy 优化器独存、行式/向量化双轨、alpha/beta rowset 迁移中"的过渡态——这是它与 2.x 的关键差异：2.x 已引入 Nereids（默认 + Legacy 回退）、Pipeline 引擎、`Env` 拆分，而 1.x 仍是单优化器 + Volcano + Catalog god class。

### 顶层上下文图

Doris 的外部交互方包括：**MySQL 客户端**（JDBC、BI 工具、调度系统）经查询端口（9030）接入；**数据导入方**经 HTTP REST（Stream Load，8040 端口）或 Routine Load（Kafka）推送数据；**外部数据源**（Elasticsearch、Iceberg）作为联邦查询对象（`external/`，能力尚弱）。BE 进程既是计算节点也是存储节点（1.x 无云模式，数据落本地磁盘）。

---

## 快速上手

```bash title="最小化部署验证"
# 1. 构建（需 Java 8 + C++ 工具链 GCC 11+ + thirdparty）
sh build.sh --fe --clean        # 构建 FE
sh build.sh --be --clean        # 构建 BE

# 2. 启动单节点（FE + BE 同机）
cd fe && bin/start_fe.sh --daemon   # FE 进程，监听 query/http/rpc/edit_log 端口
cd be && bin/start_be.sh --daemon   # BE 进程，监听 be_port/heartbeat_port/brpc_port

# 3. 用 MySQL 客户端连接并验证
mysql -h 127.0.0.1 -P 9030 -uroot
> ADD BACKEND "127.0.0.1:9050";          # 注册 BE
> CREATE DATABASE demo;
> CREATE TABLE t (k INT, v VARCHAR(32)) DISTRIBUTED BY HASH(k) BUCKETS 1 PROPERTIES("replication_num"="1");
> INSERT INTO t VALUES (1,'a');
> SELECT * FROM t;                       # 端到端验证：查询返回
```

> 构建依赖 `thirdparty/` 预编译库，首次需 `sh build.sh --thirdparty`。详细参数见仓库 `build.sh` 与 `CONTRIBUTING.md`。

---

## 架构设计解析

### 系统架构

Doris 的架构思想是**存算职责分离 + 主从元数据高可用**：把"想清楚要查什么"（FE 的解析/优化/协调）与"真正把数据捞出来算完"（BE 的执行/存储）拆成两类进程，用 RPC 解耦，使计算可横向扩展、存储可独立演进；元数据集中在 FE 用 BDB JE 复制保证高可用，避免单点。1.x 尚无云原生存算分离——元数据嵌在 FE 进程内的 BDB JE 中，segment 数据落 BE 本地磁盘。

![Doris 1.1.5 分层架构](/vibe-reading/images/articles/doris-115-internals/architecture.svg)

如上图，系统自上而下分为接入层、FE 规划层、FE 协调层、BE 执行层、BE 存储层。FE 与 BE 是分离进程，Thrift/brpc 通信；各层依赖方向自上而下，下层不感知上层。1.x 无 Cloud 层——BE 既计算又存储，数据落本地磁盘。注意 FE 规划层只有 legacy 优化器一条路径（无 Nereids），BE 执行层 `exec/`（行式）与 `vec/`（向量化）是双轨并存。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接入层 | `fe/.../mysql/`、`httpv2/`、`service/` | 隔离外部协议（MySQL/HTTP/Thrift），保护核心不受协议变化影响 |
| FE 规划层 | `fe/.../analysis/`、`planner/` | 把 SQL 翻译成可执行的物理计划，CUP 解析 + 启发式/代价优化 |
| FE 协调层 | `fe/.../catalog/`、`qe/`、`load/`、`clone/`、`alter/`、`backup/`、`transaction/` | 元数据管理、查询调度、导入事务、集群运维 |
| BE 执行层 | `be/src/exec/`、`exprs/`、`vec/`、`runtime/` | Volcano 拉模型/向量化双轨执行、表达式求值、运行时基础 |
| BE 存储层 | `be/src/olap/` | Tablet/Rowset(alpha+beta)/Segment 列存 + 两级 Compaction |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Catalog`（FE，`catalog/Catalog.java:301`）、`ExecEnv`（BE，`runtime/exec_env.h:81`） | 集中持有全局单例依赖，避免到处传参；`Catalog` 是 FE god class（7424 行），`ExecEnv::GetInstance()` 是 BE god class（30+ 管理器） |
| 状态机 | `LoadJob.JobState`、`TransactionStatus`、`AlterJobV2.JobState`、`BackupJobState`、`RowsetStateMachine` | 导入/事务/Schema Change/备份/Rowset 生命周期状态驱动，`run()` 按 state 分发 |
| 模板方法 | `ExecNode::open/get_next/close`（`exec_node.h:90`）、`Compaction::compact`（`compaction.cpp:51`）、`AlterJobV2.run` | 基类定义骨架，子类覆盖具体 `get_next`/`execute_compact_impl` |
| 工厂方法 | `ExecNode::create_node`（`exec_node.cpp:343`）、`RowsetFactory::create_rowset`（`rowset_factory.cpp:31`） | 按 `TPlanNodeType`/`rowset_type` 实例化具体子类，隐藏构造 |
| 策略 | `ExprRewriteRule`（`rewrite/`）、alpha/beta `Rowset`、`Rebalancer`（BeLoad/Partition）、CumulativeCompactionPolicy | 改写规则/rowset 格式/均衡策略/compaction 策略可插拔 |
| COW（Copy-on-Write） | `vec/common/cow.h`、`vec/columns/column.h` 的 `IColumn`/`ColumnPtr` | 列数据共享不可变，写时复制，避免深拷贝 |
| CRTP 静态多态 | `vec/functions/function.h`、`vec/aggregate_functions/aggregate_function.h` | 编译期消除虚函数开销，向量化热路径零成本抽象 |
| 两阶段提交 | `transaction/TransactionStatus` + `load/` | 导入先 COMMITTED 再 VISIBLE，发布版本号使数据原子可见 |
| 观察者 | `JournalObservable`（`qe/JournalObservable.java`）、`TxnStateChangeCallback` | journal 回放进度通知、事务状态变更回调 LoadJob |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Catalog`（FE） | 元数据/调度/事务总控 god class | FE 进程单例（`SingletonHolder`） | 持有 EditLog、GlobalTransactionMgr、TabletScheduler 等 50+ 管理器 |
| `Coordinator` | 单次查询的协调者 | 查询级（`qe/Coordinator.java:133`） | 两阶段调度 Fragment 下发 BE、拉取结果 |
| `Planner` | 计划生成入口（含优化逻辑） | 查询级（`planner/Planner.java`） | 持有 SingleNodePlanner、DistributedPlanner |
| `PlanNode` / `PlanFragment` | 计划节点 / 分布式 Fragment | 查询级 | PlanNode 树→Fragment 切分→Thrift 下发 |
| `ExecNode` | BE 执行节点基类（Volcano） | Fragment 级（`exec/exec_node.h:66`） | open/get_next/close 拉模型，含 `_children` 子树 |
| `Tablet` | 数据分片，副本管理单位 | 持久（`olap/tablet.h`） | 持有 `_rs_version_map` 版本链 + alpha/beta Rowset |
| `Rowset` | 不可变数据版本集 | 版本级（`olap/rowset/rowset.h`） | AlphaRowset（旧）/BetaRowset（segment_v2），参与 Compaction |
| `Block` | 列式批数据单元（向量化） | 执行期（`vec/core/block.h`） | 算子间传递，含 `ColumnWithTypeAndName` |
| `TransactionState` | 导入事务状态 | 事务级（`transaction/TransactionState.java`） | PREPARE→COMMITTED→VISIBLE，回调 LoadJob |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Journal` | `journal/Journal.java:23` | `BDBJEJournal`（1.x 唯一） | `EditLog` 构造时 `new BDBJEJournal` |
| `HAProtocol` | `ha/HAProtocol.java:23` | `BDBHA` | `BDBEnvironment.setup` 注入 Catalog |
| `ExprRewriteRule` | `rewrite/ExprRewriteRule.java` | `FoldConstantsRule`/`InferFiltersRule` 等 10+ | `Analyzer.GlobalState` 构造时注册到 `ExprRewriter` |
| `Rowset` | `olap/rowset/rowset.h:108` | `AlphaRowset`、`BetaRowset` | `RowsetFactory::create_rowset` 按 `rowset_type` 创建 |
| `Compaction` | `olap/compaction.h:50` | `CumulativeCompaction`、`BaseCompaction` | `Tablet::execute_compaction` 按类型创建 |
| `ExecNode` | `exec/exec_node.h:66` | `OlapScanNode`/`HashJoinNode`/`vec::V*Node` 等 | `ExecNode::create_node` 按 `TPlanNodeType` + `enable_vectorized_exec` 二选一 |
| `Expr` / `VExpr` | `exprs/expr.h:60`、`vec/exprs/vexpr.h` | `SlotRef`/`BinaryPredicate`/`VectorizedFnCall` 等 | `create_expr_tree` 从 Thrift `TExpr` 构建 |
| `IFunction` / `IAggregateFunction` | `vec/functions/function.h`、`vec/aggregate_functions/aggregate_function.h` | 各函数（CRTP 派生） | `SimpleFunctionFactory`/`AggregateFunctionSimpleFactory` 按名注册 |

---

## 代码目录

```
doris/
├── fe/                          # Frontend（Java 8）
│   └── fe-core/src/main/java/org/apache/doris/
│       ├── PaloFe.java         # FE 入口（Palo 命名遗产，2.x 改 DorisFE）
│       ├── analysis/           # SQL 解析与语义分析（~6.0 万行，CUP + Analyzer）
│       ├── planner/            # 计划生成与 CBO 优化（~1.9 万行，无独立 Optimizer）
│       ├── catalog/            # 元数据 Catalog god class（~3.5 万行，含 7424 行 Catalog.java）
│       ├── qe/                 # 查询协调 Coordinator + MySQL 协议（~1.7 万行）
│       ├── mysql/             # MySQL 协议（含 nio/ 非阻塞，~0.8 万行）
│       ├── load/               # 数据导入（loadv2/routineload/sync/update，~2.8 万行）
│       ├── transaction/        # 事务管理（~0.44 万行）
│       ├── task/               # FE→BE 任务派发 AgentBatchTask（~0.53 万行）
│       ├── clone/              # 副本调度与均衡（~0.72 万行）
│       ├── alter/              # Schema Change（~0.64 万行）
│       ├── backup/             # 备份恢复（~0.74 万行）
│       ├── master/             # Master 任务回报 MasterImpl（~0.23 万行）
│       ├── system/             # BE 节点管理 SystemInfoService（~0.33 万行）
│       ├── persist/ + journal/ # EditLog + BDBJE HA（~1.0 万行）
│       ├── external/           # 联邦数据源（ES/Iceberg，~0.37 万行，能力尚弱）
│       └── rewrite/            # 表达式改写规则 + MV 改写（~0.40 万行）
├── be/                          # Backend（C++）
│   └── src/
│       ├── olap/                # 存储引擎 Tablet/Rowset(alpha+beta)/Segment（~7.7 万行）
│       ├── vec/                 # 向量化执行子系统（ClickHouse 血统，~7.0 万行）
│       ├── runtime/             # 运行时基础 ExecEnv/RuntimeState/Block（~4.0 万行）
│       ├── exec/                # 行式执行引擎 ExecNode Volcano（~3.8 万行）
│       ├── exprs/               # 表达式引擎 Expr 树 + AnyVal（~2.6 万行）
│       ├── util/                # 工具（~3.7 万行）
│       ├── service/             # BE 守护进程 doris_main + brpc/thrift 服务（~0.25 万行）
│       ├── http/                # HTTP 服务（含 Stream Load action，~0.84 万行）
│       └── env/                 # 文件系统抽象（~0.20 万行）
├── gensrc/                      # IDL 定义
│   ├── thrift/                 # FE↔BE Thrift 接口（PaloInternalService/BackendService/AgentService 等）
│   └── proto/                  # protobuf（internal_service/olap）
├── regression-test/            # 回归测试
└── conf/                        # 默认配置
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/doris-115-internals/module-dependencies.svg)

模块间依赖以 FE 的 `Catalog` 为中心——它是 god class（7424 行，被 326 处 import），被优化器、协调器、导入、集群运维模块共同依赖；BE 侧 `exec`（行式）与 `vec`（向量化）通过 `enable_vectorized_engine` 开关双轨选择，共同读写 `olap` 存储引擎、依赖 `runtime` 运行时基础。`Catalog` 通过 Thrift/brpc 向 BE 的 `exec` 下发 Fragment，`load` 通过 Tablet Sink 向 `olap` 写 rowset。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 查询解析与优化 | SQL 解析→分析→改写→计划 | `Analyzer`、`Planner` | 1.x 唯一规划路径（无 Nereids），逻辑/分布式计划分层 | [01-analysis-planner](01-analysis-planner) |
| 元数据与 Catalog | 元数据/HA/事务状态 | `Catalog` god class、`EditLog` | 集中元数据避免多写源，BDB JE 复制保证高可用 | [02-catalog-metadata](02-catalog-metadata) |
| 查询协调与协议 | MySQL 接入 + Fragment 调度 | `Coordinator.exec` | 协调是 FE 与 BE 的桥，独立于优化与存储 | [03-query-coordinator](03-query-coordinator) |
| 数据导入与事务 | Stream/Broker/Routine + 两阶段事务 | `load/`、`transaction/` | 导入是写路径，与读路径分离编排，事务保证原子可见 | [04-data-load-txn](04-data-load-txn) |
| 集群管理与运维 | 副本均衡/Schema Change/备份/选主 | `TabletScheduler`、`SchemaChangeHandler` | 运维是 Master FE 的后台职责域，独立于查询 | [05-cluster-ops](05-cluster-ops) |
| 存储引擎 | Tablet/Rowset/Segment + Compaction | `StorageEngine`、`Tablet` | 列存与副本是 BE 核心资产，独立于执行 | [06-storage-engine](06-storage-engine) |
| 执行引擎 | Volcano pull 行式算子 | `ExecNode`、`create_node` | 1.x 行式执行路径，与向量化双轨对比 | [07-exec-engine](07-exec-engine) |
| 表达式引擎 | Expr 树 + AnyVal 求值 | `Expr`、`AggFnEvaluator` | 行式表达式路径，dlsym 函数加载 | [08-expression-engine](08-expression-engine) |
| 向量化执行 | 列式栈 + VExpr + IFunction | `vec/core/block.h`、`vec/exec/` | 向量化是性能基石，源自 ClickHouse，2.x 统一 | [09-vectorized-execution](09-vectorized-execution) |
| 运行时基础 | ExecEnv/RuntimeState/MemTracker/RPC | `ExecEnv`、`doris_main.cpp` | 跨模块共享的底层数据结构与资源管理 | [10-runtime-foundation](10-runtime-foundation) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

FE 启动入口在 `PaloFe.main()`（`PaloFe.java`），BE 启动入口在 `be/src/service/doris_main.cpp:257` 的 `main`。FE 启动按顺序装配如下对象：

```
PaloFe.main()
  → Config.init(fe.conf) + initCustom(fe_custom.conf)   // 配置：文件→自定义覆盖
  → tryLockProcess()                                      // 进程锁防多实例
  → Catalog.getCurrentCatalog().initialize(args)          // 装配 Catalog god class：
      → 加载 image / replay EditLog（BDBJE）               //   元数据恢复
      → transferToMaster/transferToNonMaster               //   BDBJE 选主，fencing 防脑裂
      → 启动各类 Daemon 线程（副本均衡、统计、导入、发布版本） //   后台对象
  → waitForReady()                                        // 等元数据就绪
  → new FeServer(rpc_port).start()                        // Thrift RPC 服务（FE↔BE）
  → new HttpServer().start()                              // HTTP REST（导入/管理）
  → SimpleScheduler.init()                               // FE 间调度器
  → new QeService(query_port).start()                     // MySQL 协议
```

关键装配点：`Catalog` 是通过 `Catalog.getCurrentCatalog()`（`catalog/Catalog.java:641`）拿到的进程级单例（`SingletonHolder`，`:519`）。`initialize()` 内完成 image 加载、EditLog 回放、BDBJE 选主、后台线程启动——**对象实例化顺序**是先恢复持久化元数据（`loadImage`→`replayJournal`），再启动依赖元数据的服务。选主由 BDBJE 内部自动完成，`Catalog` 经 `typeTransferQueue` 收到角色变更后异步 `transferToMaster()`（`:1238`，含 `haProtocol.fencing()` 脑裂防护）/`transferToNonMaster()`（`:1419`，启动 replayer 回放 journal）。配置优先级：命令行 > `fe_custom.conf` > `fe.conf`。

BE 启动：`doris_main`（`:257`）→ `config::init` 加载配置 → `Env::init`（文件系统）→ `Daemon::init/start`（硬件信息、UDF 缓存、函数注册）→ `ExecEnv::GetInstance()`（`:385`）+ `ExecEnv::init`（`exec_env_init.cpp:88` `_init`）装配 BE 侧 god class——`ExecEnv` 单例持有 `StorageEngine`、`FragmentMgr`、五级 `MemTracker`、`DataStreamMgr`/`VDataStreamMgr`、6 个线程池、client cache → `StorageEngine::open()`（`:393`）+ `start_bg_threads()`（`:403`）启动 Compaction/Flush 后台线程 → 启动 Thrift（`be_port`）、brpc（`brpc_port`）、HTTP（`webserver_port`，含 Stream Load）、Heartbeat（`heartbeat_service_port`）四类服务 → 主循环（`:458`）每秒刷新 mem tracker、清理过期任务 tracker。

### 核心运行流程

下面两条主链路覆盖了 Doris 1.1.5 最核心的运行模式：查询执行（读路径）与数据导入（写路径）。1.x 无云模式，故无第三条云元数据链路。

#### 读路径：SQL → 解析 → 计划 → 调度 → 执行 → 返回

业务流程：客户端发 SQL → FE 用 CUP 解析 + Analyzer 语义分析 + 改写 → Planner 生成 PlanFragment → Coordinator 两阶段下发 → BE 装配 ExecNode 拉模型执行 → 算子从 olap 存储引擎拉取数据 → 结果回传。

![查询执行数据流](/vibe-reading/images/articles/doris-115-internals/data-flow.svg)

文字描述：`ConnectProcessor.handleQuery()`（`qe/ConnectProcessor.java:171`）经 MySQL NIO 协议收到 SQL 后交给 `StmtExecutor.execute()`（`qe/StmtExecutor.java:331`），`analyze()`（`:557`）内先用 CUP 生成的 `SqlParser` 解析为 AST，再 `new Analyzer(catalog, context)` 做 `parsedStmt.analyze()` 语义分析（名字解析、类型推导、TupleDescriptor/SlotDescriptor 绑定、谓词注册到 `tuplePredicates`），随后 `StmtRewriter.rewrite()` 改写子查询（IN/EXISTS→Join）、`ExprRewriter.rewrite()` 循环应用规则（常量折叠 `FoldConstantsRule`、谓词规范化、等价类推断 `InferFiltersRule` 等），改写后 re-analyze。`Planner.plan()`（`planner/Planner.java`）调 `SingleNodePlanner.createSingleNodePlan()`（含 `createCheapestJoinPlan` Cost-Based Join 重排）生成单节点 PlanNode 树，再 `DistributedPlanner.createPlanFragments()`（`:79`）切分为 `PlanFragment` 列表（Colocate > Bucket Shuffle > Broadcast > Shuffle 策略选 Join 分布）。

`StmtExecutor.sendResult()`（`:980`）创建 `Coordinator`（`qe/Coordinator.java:133`），`coord.exec()`（`:476`）做两阶段调度：先 `computeScanRangeAssignment()`（`:1441`）将 scan range 分配到 BE（`SimpleScheduler.getHost` 轮询 + 黑名单），再 `computeFragmentExecParams()`（`:929`）为每个 fragment 选 host、分配 instanceId，最后 `sendFragment()`（`:567`）按 BE 分组下发——`fragments.size() >= 2` 时走两阶段 RPC（`execRemoteFragmentsAsync` 只 prepare，`execPlanFragmentStartAsync` 统一触发 start）。FE→BE 经 Thrift 序列化 `TExecPlanFragmentParams` 包装在 brpc protobuf `PExecPlanFragmentRequest` 中（`PaloInternalService.thrift`）。BE 侧 `PInternalServiceImpl::exec_plan_fragment`（`internal_service.cpp:175`）→ `FragmentMgr::exec_plan_fragment`（`fragment_mgr.cpp:501`）→ `PlanFragmentExecutor` 装配 `RuntimeState` + `ExecNode::create_tree`（`exec_node.cpp:282`，工厂按 `enable_vectorized_exec()` 选 legacy 或 `vec::V*Node`）→ 线程池提交执行：`_executor.open()` → 循环 `_plan->get_next(state, block/row_batch, &eos)`（Volcano pull 递归拉取）→ `OlapScanNode` 经 `TabletReader`/`BlockReader` 读 `Tablet` 的 `Rowset`/`Segment`，按列存 Page 解码。结果经 `ResultSink` → `BufferControlBlock`（`result_buffer_mgr.cpp`），FE 经 `Coordinator.getNext()`（`:834`）→ `ResultReceiver.getNext()`（brpc `fetch_data`）拉取 → `MysqlChannel.sendOnePacket` 返回客户端。

#### 写路径：Stream Load → MemTable → Rowset → 发布版本

业务流程：HTTP 推数据 → BE 转 FE 开事务（PREPARE）→ FE 生成导入计划返回 BE → BE 写 MemTable 刷盘成 Rowset → FE 提交事务（COMMITTED）→ 发布版本使其可见（VISIBLE）。

文字描述：`http/action/stream_load.cpp` 的 `StreamLoadAction::on_header`（`:209`）解析 HTTP 头，`_process_put`（`:373`）建 `StreamLoadPipe`，经 Thrift RPC 调 FE `FrontendServiceImpl.streamLoadPut()`（`:1077`）由 `StreamLoadPlanner.plan()` 生成含 `OlapTableSink` 的 fragment 返回 BE。此前 `begin_txn`（`stream_load_executor.cpp:134`）已调 FE `loadTxnBegin`（`FrontendServiceImpl.java:747`）由 `GlobalTransactionMgr.beginTransaction()` 创建 `TransactionState(PREPARE)` 并写 EditLog。BE `FragmentMgr::exec_plan_fragment`（`need_txn=true`）执行 fragment：ScanNode 从 `StreamLoadPipe` 读 CSV/JSON → `OlapTableSink::send`（`exec/tablet_sink.cpp`）→ `tablet_writer_add_batch` brpc → 目标 BE `DeltaWriter`（`olap/delta_writer.cpp:34`）写 `MemTable`，满后 `flush` 为 `BetaRowsetWriter` 的 Segment（`SegmentWriter.finalize` 写列存 Page + 多级索引）。完成后 BE 调 `loadTxnCommit`（`FrontendServiceImpl.java:951`），`DatabaseTransactionMgr.commitTransaction()`（`:575`）校验 quorum replica（`:508`）后将状态 PREPARE→COMMITTED 并写 EditLog。再由 `PublishVersionDaemon`（`:75`）异步下发 `PublishVersionTask` 到 BE，全部成功后 `finishTransaction()`（`:784`）转 VISIBLE——`updateCatalogAfterVisible()` 推进 `partition.visibleVersion` 保证版本原子可见。Kafka offset 在 `KafkaProgress.update()`（`:190`）按 `offset+1` 推进。

### 状态流

![导入事务与执行路径状态流](/vibe-reading/images/articles/doris-115-internals/state-flow.svg)

上图上半部是导入事务的完整状态机（`TransactionStatus.java:20`）：主链 `PREPARE → PRECOMMITTED → COMMITTED → VISIBLE` 是两阶段提交的正常路径（`precommit` 2PC 预提交、`commit` 正式提交、`publish` 发布版本使数据可见），`PREPARE`/`PRECOMMITTED`/`COMMITTED` 任一阶段均可 `abort` 进入终态 `ABORTED`。COMMITTED 与 VISIBLE 的分离设计让 commit 快速返回（数据安全写入），publish 异步进行不阻塞导入；查询只看 visibleVersion 保证一致性。`LoadJob` 自身还有 `PENDING→ETL→LOADING→COMMITTED→FINISHED/CANCELLED` 作业状态机，通过 `TxnStateChangeCallback` 与事务状态联动（`beforeCommitted` 设 `isCommitting` 阻止 cancel，`afterVisible` 设 FINISHED）。

下半部是执行路径选择：`StmtExecutor` 默认走向量化，由 `enable_vectorized_engine`（`SessionVariable.java:169`，默认 true，经 `VectorizedUtil.isVectorized()` 在 `Coordinator.java:316` 写入 `TQueryOptions` 下发 BE）决定。BE `ExecNode::create_node`（`exec_node.cpp:343`）工厂每个 case 内 `if (state->enable_vectorized_exec())` 二选一实例化 `vec::V*Node`（Block 列存路径）或 legacy 节点（RowBatch 行式路径）。1.x 双轨并存，2.x 起统一向量化并移除 legacy。

---

## 典型修改场景

#### 场景 1：新增一条表达式改写规则（如 LIKE 前缀改写）

需修改：新建 `fe/.../rewrite/LikePrefixRule.java` 实现 `ExprRewriteRule.apply()`；在 `analysis/Analyzer.java:350` 的 `GlobalState` 构造函数 `rules` 列表注册 `LikePrefixRule.INSTANCE`（须排在 `NormalizeBinaryPredicatesRule` 之后，确保 SlotRef 已在左侧）。无需改 `StmtRewriter` 或 `Planner`——`ExprRewriter.rewrite()` 会自动在 `SelectStmt.rewriteExprs()` 中被调用。对应测试：`fe/fe-core/src/test/java/org/apache/doris/rewrite/`。

#### 场景 2：新增一个向量化标量函数

需修改：在 `be/src/vec/functions/` 下新增函数实现（继承 `IFunction`，`function.h` 实现 `execute_impl` 与 `get_return_type`）；在 `vec/functions/simple_function_factory.h` 的注册入口调 `register_function<MyFunc>` 按名注册到 `SimpleFunctionFactory`；并在 FE 侧 `catalog/FunctionSet.java:73` `init()` 注册函数元信息。对应测试：`be/test/vec/function/`、`regression-test/suites/`。

#### 场景 3：新增一个 BE 执行算子类型

需修改：在 `be/src/exec/`（或 `vec/exec/`）下新增 `XxxNode.h/cpp` 继承 `ExecNode`，实现 `get_next(RowBatch*)`（legacy）与/或 `get_next(Block*)`（向量化）；在 `exec_node.cpp:343` 的 `create_node()` switch 添加 `case TPlanNodeType::XXX_NODE:` 分支（向量化版须同时在工厂开头白名单登记，否则报 `"V" + str + " not implemented"`）；在 `gensrc/thrift/PlanNodes.thrift` 的 `TPlanNodeType` 枚举新增值；FE 侧 `planner/SingleNodePlanner.java` 与 `DistributedPlanner.java` 新增构建与切分逻辑。对应测试：`be/test/exec/`、`regression-test/suites/`。

---

## 测试体系

```
regression-test/                  # 端到端回归（SQL 行为）
├── suites/                       # 按特性组织的 .groovy 测试
│   ├── load_p0/                  # 导入各形态
│   ├── alter/                   # Schema Change
│   ├── clone/                   # 副本均衡
│   └── ...                      # backup/external 等
├── data/                         # 测试数据
└── framework/                    # 测试框架
be/test/                          # BE 单元测试（C++）
fe/fe-core/src/test/             # FE 单元测试（Java）
run-fe-ut.sh / run-be-ut.sh      # 单测执行入口
```

| 代码层 | 测试类型 | 说明 |
| --- | --- | --- |
| FE 解析/优化/计划 | `fe-core` 单测 + `regression-test` 回归 | 规则与计划用单测，端到端用 groovy 回归 |
| BE 算子/函数 | `be/test/`（vec/exec/olap） | 向量化与存储行为单测 |
| 导入/事务 | `regression-test/load_p0` | 端到端各导入形态 + 事务可见性 |
| 副本/Schema Change | `regression-test/clone`、`alter` | 副本补齐与在线变更 |

修改某层代码时，参照上表找到对应测试优先阅读——Doris 的回归测试是很好的"可执行文档"。

---

## 阅读源码推荐路线

- 第一遍：理解 FE 启动与查询主流程
  `PaloFe.java` 的 `main` → `qe/StmtExecutor.java` 的 `execute`/`analyze` → `qe/ConnectProcessor.java` 的 `handleQuery` → `qe/Coordinator.java` 的 `exec`/`sendFragment`
- 第二遍：理解 legacy 优化流水线
  `fe/fe-core/src/main/cup/sql_parser.cup`（语法）→ `analysis/Analyzer.java` 的 `analyze` → `analysis/StmtRewriter.java` 的 `rewrite` → `planner/SingleNodePlanner.java` 的 `createCheapestJoinPlan` → `planner/DistributedPlanner.java` 的 `createPlanFragments`
- 第三遍：理解 BE 执行与存储双轨
  `be/src/service/doris_main.cpp` 的 `main` → `be/src/runtime/exec_env.h`（ExecEnv 服务定位器）→ `be/src/runtime/fragment_mgr.cpp` 的 `exec_plan_fragment` → `be/src/exec/exec_node.cpp` 的 `create_node`/`get_next` → `be/src/olap/storage_engine.h` + `rowset/beta_rowset.h`
- 第四遍：选择重点子模块深入（模块文档）
  向量化读者从 `be/src/vec/core/block.h` + `vec/columns/column.h` 的 IColumn 接口进 [09-vectorized-execution](09-vectorized-execution)；存储读者从 `be/src/olap/tablet.h` + `rowset/beta_rowset.h` 进 [06-storage-engine](06-storage-engine)；导入读者从 `fe/.../transaction/GlobalTransactionMgr.java` 进 [04-data-load-txn](04-data-load-txn)

---

## 附录

**术语表**：

| 术语 | 含义 |
| --- | --- |
| FE / BE | Frontend（元数据/优化/协调/运维）、Backend（执行/存储） |
| Palo | Doris 前身（百度），1.x 仍保留 Palo 命名（`PaloFe.java`、`PaloInternalService`） |
| Catalog（god class） | 1.x FE 元数据/调度总控单例（7424 行），2.x 拆分重命名为 `Env` |
| Tablet | 数据分片，Doris 副本与调度的基本单位 |
| Rowset | 一次导入/Compaction 产生的不可变数据版本集；1.x 有 alpha（旧）/beta（segment_v2）两代 |
| Segment | Rowset 内的列存段，含多个列式 Page + 多级索引 |
| Compaction | 后台合并多个 Rowset 减少读放大（Cumulative + Base 两级） |
| EditLog | FE 元数据变更日志，BDB JE 复制 |
| Volcano pull | `ExecNode` 的 `get_next` 拉模型，按 `RowBatch` 行式（2.x 才上 Pipeline） |
| enable_vectorized_engine | 1.x 行式/向量化双轨开关，默认 true（`SessionVariable.java:169`） |

**参考资料**：

- [Apache Doris 官方文档](https://doris.apache.org/docs)
- [Doris 1.1 Release Notes](https://doris.apache.org/docs/releasenotes/release-1.1.0)
- [Google Mesa 论文](https://research.google/pubs/pub42851/)（列存与预聚合理论基础）
- [Apache Impala](https://impala.apache.org/)（FE 优化器与行式执行引擎血统来源）
- [ClickHouse](https://github.com/ClickHouse/ClickHouse)（`vec/` 向量化执行栈来源）
