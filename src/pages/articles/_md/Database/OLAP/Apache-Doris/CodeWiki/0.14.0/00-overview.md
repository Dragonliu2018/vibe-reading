---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Overview"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "Java", "C++", "MPP", "OLAP", "Volcano 执行器", "行式执行", "Catalog god class"]
description: "Apache Doris 0.14.0 源码架构解读：孵化器时期（incubating）的奠基版本、唯一的 legacy 优化器（CUP+Analyzer，无 Nereids）、纯行式 Volcano pull 执行引擎（无向量化、无 Pipeline）、alpha/beta rowset 迁移期、4 态两阶段事务、FE/BE 分离的 MPP 数仓。"
readingTime: "34 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 0.14.0 · **协议** Apache-2.0 · **语言** Java 8 / C++（GCC 4.8.2+）· **代码量** ~50.0 万行（FE ~23.3 万 Java + BE ~26.7 万 C++）· **解读基线** commit `4c1e52261fc`（2021-05-10，0.14.0 release）· **仓库** [GitHub](https://github.com/apache/doris)

---

## 总览

### 项目简介

**Apache Doris**（本版本仓库自述写作 "Apache Doris (incubating)"）是一个基于 MPP（Massively Parallel Processing）架构的易用、高性能、实时分析型数据库。它的前身是百度 Palo，捐献给 Apache 软件基金会后更名为 Doris。Doris 在海量数据下提供高并发低延迟点查能力，同时支撑高吞吐的 Ad-hoc 分析，兼具批量与近实时小批量数据导入，提供高可用、高可靠与水平扩展能力。其核心优势在于"开发、部署、使用都简单"，用单一系统满足多种数据服务需求。技术渊源上，Doris 主要融合了 **Google Mesa** 的列存与预聚合思想，以及 **Apache Impala** 的 MPP 执行模型，基于列式存储引擎，并通过 MySQL 协议对外提供服务。

Doris 采用经典的 **FE（Frontend，Java）+ BE（Backend，C++）** 分离架构：FE 负责元数据管理、SQL 解析优化、查询协调调度、导入事务编排、集群运维（副本均衡 / Schema Change / 备份）；BE 负责执行引擎、存储引擎、表达式与函数求值、文件读写。FE 之间通过 BDB JE 复制实现元数据高可用并选主，FE 与 BE 之间通过 Thrift + brpc 双协议通信——下发执行计划走 brpc（protobuf，热路径低延迟），FE 暴露给 BE 的导入事务/管理接口走 Thrift（`FrontendService`）。

**0.14.0 的版本定位**：这是 Apache 孵化器时期的正式发布版（解读基线 commit `4c1e52261fc`，2021-05-10）。0.14.0 处在 Doris 从"百度 Palo"走向"Apache 顶级项目"的奠基阶段——确立了 FE/BE 分离、Tablet/Rowset/Segment 列存、两阶段导入事务等延续至今的架构骨架，但许多 1.x/2.x 才成熟的能力此时**尚未引入或正在迁移中**：

- **唯一的 legacy 优化器**：SQL 用 CUP 语法（`fe/fe-core/src/main/cup/sql_parser.cup`）+ JFlex 词法器解析，经 `Analyzer`（Impala 血统的语义分析器）做名字解析/类型推导/谓词注册、`StmtRewriter` 改写、`SingleNodePlanner`/`DistributedPlanner` 生成计划。**没有 Nereids**（Cascades 优化器是 2.0 才引入），优化为启发式规则 + 有限 Cost-Based Join 重排。
- **纯行式 Volcano pull 执行引擎**：BE 用 `ExecNode` 的经典 `open/get_next/close` 拉模型，按 `RowBatch` 行式处理。**既没有向量化引擎也没有 Pipeline 引擎**——`be/src/` 下不存在 `vec/` 目录，`ExecNode::create_node`（`exec_node.cpp:329`）的 switch 每个 case 直接实例化具体节点，没有 `enable_vectorized_exec()` 二选一分支。向量化栈（源自 ClickHouse）是 1.x 才集成，Pipeline 是 2.x 才引入。**这是 0.14.0 与后续版本最本质的差异：它是纯 Impala 血统、纯行式的 Doris。**
- **Catalog god class**：`catalog/Catalog.java`（6888 行）是 FE 的服务定位器，集中 40+ 管理器。2.x 才将其拆分并重命名为 `Env.java`。
- **alpha/beta rowset 迁移期**：`olap/rowset/` 同时保留 `alpha_rowset`（旧 SegmentGroup 格式，segment v1）与 `beta_rowset`（segment_v2 列存），`StorageEngine::default_rowset_type()`（`storage_engine.h:156`）可由心跳动态切默认 rowset 类型——`_default_rowset_type` 字段注释明言 "Used to control the migration from segment_v1 to segment_v2, can be deleted in future"。
- **4 态两阶段事务**：`TransactionStatus`（`transaction/TransactionStatus.java:20`）只有 `PREPARE / COMMITTED / VISIBLE / ABORTED` 四态，比 1.x 的五态少了 `PRECOMMITTED`（预提交）——0.14.0 的导入两阶段提交更简练。
- Palo 命名遗产遍布全仓：FE 入口 `PaloFe.java`、Thrift 服务 `PaloInternalService.thrift`/`PaloService.thrift`、鉴权 `PaloAuth`、Broker `PaloBrokerService.thrift`。HTTP v2（`httpv2/`）仍是 opt-in（`Config.enable_http_server_v2` 默认走老版 `HttpServer`）。

**项目边界**：Doris 负责分析型（OLAP）数据的存储与查询，**不**承担在线事务（OLTP）的强一致行级读写职责；它通过 Unique 模型与 delete handler 提供近实时更新能力，但本质仍是面向分析的列存仓库。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| MySQL 协议接入 | `fe/.../mysql/`、`PaloFe.java` | 兼容 MySQL 协议，JDBC/BI 直连，NIO 非阻塞（`mysql/nio/`） |
| Legacy CBO 优化 | `fe/.../analysis/`、`planner/` | CUP 解析 + Analyzer + ExprRewriter + Cost-Based Join 重排 |
| 行式 Volcano 执行 | `be/src/exec/` | `ExecNode` pull 模型，按 `RowBatch` 行式（无向量化） |
| 表达式与函数 | `be/src/exprs/` | `Expr` 树 + `AnyVal` 求值 + dlsym 函数加载 |
| olap 列存引擎 | `be/src/olap/` | Tablet/Rowset(alpha+beta)/Segment + 两级 Compaction |
| 实时导入 | `fe/.../load/`、`httpv2/` | Broker Load / Routine Load(Kafka) / Stream Load + 两阶段事务 |
| 副本自均衡 | `fe/.../clone/` | TabletScheduler + TabletChecker + Rebalancer |
| 在线 Schema Change | `fe/.../alter/` | Shadow index + watershedTxn，在线不阻塞 |
| 备份恢复 | `fe/.../backup/` | BackupHandler + 仓库（Broker/本地） |
| 联邦数据源 | `fe/.../external/` | ES / ODBC / MySQL 外表（`EsScanNode`/`OdbcScanNode`/`MysqlScanNode`） |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Java 8 | 核心（FE） | FE 全部逻辑，JVM 运行 |
| C++ | 核心（BE） | BE 执行与存储引擎 |
| CUP / JFlex | 核心 | SQL 词法/语法解析器生成（`sql_parser.cup` + `sql_scanner.flex`） |
| BDB JE | 核心 | FE 元数据复制与选主（EditLog/BDBJEJournal/BDBEnvironment） |
| Thrift | 核心 | FE 暴露给 BE 的服务（`FrontendService.thrift`：loadTxn* 等）、BackendService、AgentService、HeartbeatService |
| brpc / protobuf | 核心 | FE→BE 下发执行计划热路径（`PExecPlanFragment`）、BE 间数据流（`gensrc/proto/internal_service.proto`） |
| Xnio | 核心 | MySQL NIO 多路复用（`mysql/nio/NMysqlServer`） |
| Boost | 核心（BE） | 线程/并发原语（doris_main 启动依赖 boost::thread） |
| TCMalloc | 核心（BE） | BE 内存分配，启动设 aggressive decommit |

### 版本历史

Doris 主线演进可粗分为：0.x 线（孵化器时期）确立 FE/BE 分离与列存骨架、alpha→beta rowset 迁移、纯行式 Impala 血统执行；1.x 线引入向量化执行（源自 ClickHouse 集成，`vec/` 与行式 `exec/` 双轨并存）、补 `PRECOMMITTED` 预提交态；2.0 线引入 **Nereids Cascades 优化器**与 **Pipeline 拉模型执行引擎**，将 god class `Catalog` 拆分重命名为 `Env`，统一向量化、完成 segment_v2 迁移；3.0/4.x 线引入云原生存算分离、完善 MoW Unique 表性能、联邦数据源。**0.14.0** 是 0.x 线的正式发布版（2021-05-10），处于"legacy 优化器独存、纯行式执行（无向量化）、alpha/beta rowset 迁移中、4 态两阶段事务"的奠基态——这是它与 1.x/2.x 的关键差异：1.x 已集成向量化双轨（`vec/` + `exec/`），2.x 已引入 Nereids、Pipeline、`Env` 拆分，而 0.14.0 仍是纯 legacy 优化器 + 纯行式 Volcano + Catalog god class。

### 顶层上下文图

Doris 的外部交互方包括：**MySQL 客户端**（JDBC、BI 工具、调度系统）经查询端口（9030）接入；**数据导入方**经 HTTP REST（Stream Load，webserver 端口）或 Routine Load（Kafka）推送数据；**外部数据源**（Elasticsearch、ODBC、MySQL）作为联邦查询对象（`external/`，经 `EsScanNode`/`OdbcScanNode`/`MysqlScanNode` 扫描）；**Broker**（`fs_brokers/`，`PaloBrokerService.thrift`）作为 Broker Load 的外部文件读取代理。BE 进程既是计算节点也是存储节点（0.x 无云模式，数据落本地磁盘），并通过 `agent/` 的 HeartbeatService 向 FE 上报心跳与 tablet 报告。

---

## 快速上手

```bash title="最小化部署验证"
# 1. 构建（需 Java 8 + C++ 工具链 + thirdparty）
sh build.sh --fe --clean        # 构建 FE
sh build.sh --be --clean        # 构建 BE

# 2. 启动单节点（FE + BE 同机）
cd fe && bin/start_fe.sh --daemon   # FE 进程，监听 query/http/rpc/edit_log 端口
cd be && bin/start_be.sh --daemon   # BE 进程，监听 be_port/brpc_port/heartbeat_port/webserver_port

# 3. 用 MySQL 客户端连接并验证
mysql -h 127.0.0.1 -P 9030 -uroot
> ADD BACKEND "127.0.0.1:9050";          # 注册 BE（heartbeat_service_port）
> CREATE DATABASE demo;
> CREATE TABLE t (k INT, v VARCHAR(32)) DISTRIBUTED BY HASH(k) BUCKETS 1 PROPERTIES("replication_num"="1");
> INSERT INTO t VALUES (1,'a');
> SELECT * FROM t;                       # 端到端验证：查询返回
```

> 构建依赖 `thirdparty/` 预编译库。详细参数见仓库 `build.sh` 与 `CONTRIBUTING.md`。

---

## 架构设计解析

### 系统架构

Doris 的架构思想是**存算职责分离 + 主从元数据高可用 + 双协议 RPC 解耦**：把"想清楚要查什么"（FE 的解析/优化/协调）与"真正把数据捞出来算完"（BE 的执行/存储）拆成两类进程，用 RPC 解耦，使计算可横向扩展、存储可独立演进；元数据集中在 FE 用 BDB JE 复制保证高可用，避免单点。0.x 尚无云原生存算分离——元数据嵌在 FE 进程内的 BDB JE 中，segment 数据落 BE 本地磁盘。FE↔BE 用 **brpc + Thrift 双协议**：执行计划下发与数据流走 brpc（protobuf 序列化、低延迟），导入事务/心跳/管理走 Thrift（`FrontendService.thrift` 等）。

![Doris 0.14.0 分层架构](/vibe-reading/images/articles/doris-0140-internals/architecture.svg)

如上图，系统自上而下分为接入层、FE 规划层、FE 协调层、BE 执行层、BE 存储层。FE 与 BE 是分离进程，Thrift+brpc 通信；各层依赖方向自上而下，下层不感知上层。0.x 无 Cloud 层——BE 既计算又存储，数据落本地磁盘。注意 FE 规划层只有 legacy 优化器一条路径（无 Nereids），BE 执行层 `exec/` 是**唯一**的执行路径——0.14.0 没有 `vec/`，纯行式 Volcano，没有向量化双轨。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接入层 | `fe/.../mysql/`、`http`+`httpv2/`、`service/` | 隔离外部协议（MySQL/HTTP/Thrift/brpc），保护核心不受协议变化影响 |
| FE 规划层 | `fe/.../analysis/`、`planner/` | 把 SQL 翻译成可执行的物理计划，CUP 解析 + 启发式/代价优化 |
| FE 协调层 | `fe/.../catalog/`、`qe/`、`load/`、`clone/`、`alter/`、`backup/`、`transaction/` | 元数据管理、查询调度、导入事务、集群运维 |
| BE 执行层 | `be/src/exec/`、`exprs/`、`runtime/` | Volcano 拉模型行式执行、表达式求值、运行时基础（无向量化） |
| BE 存储层 | `be/src/olap/` | Tablet/Rowset(alpha+beta)/Segment 列存 + 两级 Compaction |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Catalog`（FE，`catalog/Catalog.java:267`）、`ExecEnv`（BE，`runtime/exec_env.h`） | 集中持有全局单例依赖，避免到处传参；`Catalog` 是 FE god class（6888 行，`SingletonHolder` at `:471`），`ExecEnv::GetInstance()` 是 BE god class |
| 状态机 | `TransactionStatus`（4 态）、`LoadJob.JobState`、`AlterJobV2.JobState`、`BackupJobState` | 导入/事务/Schema Change/备份生命周期状态驱动 |
| 模板方法 | `ExecNode::open/get_next/close`（`exec_node.h:84/99/131`）、`Compaction::compact`、`AlterJobV2.run` | 基类定义骨架，子类覆盖具体 `get_next`/`execute_compact_impl` |
| 工厂方法 | `ExecNode::create_node`（`exec_node.cpp:329`）、`RowsetFactory::create_rowset` | 按 `TPlanNodeType`/`rowset_type` 实例化具体子类，隐藏构造 |
| 策略 | `ExprRewriteRule`（`rewrite/`）、alpha/beta `Rowset`、`Rebalancer`、`CumulativeCompactionPolicy` | 改写规则/rowset 格式/均衡策略/compaction 策略可插拔 |
| 两阶段提交 | `TransactionStatus` + `load/` | 导入先 COMMITTED 再 VISIBLE，发布版本号使数据原子可见 |
| 观察者 | `JournalObservable`（`qe/JournalObservable.java`）、`TxnStateChangeCallback` | journal 回放进度通知、事务状态变更回调 LoadJob |
| 单例 + Checkpoint 副本 | `Catalog.getCurrentCatalog()`（`catalog/Catalog.java:574`） | 普通线程用 `SingletonHolder.INSTANCE`，checkpoint 线程用独立 `CHECKPOINT` 实例避免污染主内存 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Catalog`（FE） | 元数据/调度/事务总控 god class | FE 进程单例（`SingletonHolder`） | 持有 EditLog、GlobalTransactionMgr、TabletScheduler 等 40+ 管理器 |
| `Coordinator` | 单次查询的协调者 | 查询级（`qe/Coordinator.java`） | 两阶段调度 Fragment 下发 BE、拉取结果 |
| `Planner` | 计划生成入口（含优化逻辑） | 查询级（`planner/Planner.java`） | 持有 SingleNodePlanner、DistributedPlanner |
| `PlanNode` / `PlanFragment` | 计划节点 / 分布式 Fragment | 查询级 | PlanNode 树→Fragment 切分→Thrift/brpc 下发 |
| `ExecNode` | BE 执行节点基类（Volcano 行式） | Fragment 级（`exec/exec_node.h:60`） | open/get_next(RowBatch)/close 拉模型，含 `_children` 子树 |
| `Tablet` | 数据分片，副本管理单位 | 持久（`olap/tablet.h`） | 持有版本链 + alpha/beta Rowset |
| `Rowset` | 不可变数据版本集 | 版本级（`olap/rowset/rowset.h`） | AlphaRowset（segment v1）/BetaRowset（segment_v2），参与 Compaction |
| `TransactionState` | 导入事务状态 | 事务级（`transaction/TransactionState.java`） | PREPARE→COMMITTED→VISIBLE（4 态），回调 LoadJob |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Journal` | `journal/Journal.java` | `BDBJEJournal`（0.x 唯一） | `EditLog` 构造时 `new BDBJEJournal` |
| `HAProtocol` | `ha/HAProtocol.java` | `BDBHA` | `BDBEnvironment.setup` 注入 Catalog |
| `ExprRewriteRule` | `rewrite/ExprRewriteRule.java` | `BetweenToCompoundRule`/`NormalizeBinaryPredicatesRule`/`FoldConstantsRule` + MV 规则 | `Analyzer.GlobalState` 构造时注册到 `ExprRewriter`（`analysis/Analyzer.java:246`） |
| `Rowset` | `olap/rowset/rowset.h` | `AlphaRowset`、`BetaRowset` | `RowsetFactory::create_rowset` 按 `rowset_type` 创建 |
| `Compaction` | `olap/compaction.h` | `CumulativeCompaction`、`BaseCompaction` | `StorageEngine::create_cumulative_compaction`/`create_base_compaction`（`storage_engine.h:172/174`） |
| `ExecNode` | `exec/exec_node.h:60` | `OlapScanNode`/`HashJoinNode`/`SortNode`/`ExchangeNode` 等 | `ExecNode::create_node` 按 `TPlanNodeType` 实例化（无向量化分支） |
| `Expr` | `exprs/expr.h:63` | `SlotRef`/`BinaryPredicate`/`FunctionCallExpr` 等 | `create_expr_tree` 从 Thrift `TExpr` 构建 |

---

## 代码目录

```
doris/
├── fe/                          # Frontend（Java 8）
│   └── fe-core/src/main/java/org/apache/doris/
│       ├── PaloFe.java         # FE 入口（Palo 命名遗产）
│       ├── analysis/           # SQL 解析与语义分析（~5.0 万行，CUP + Analyzer）
│       ├── catalog/            # 元数据 Catalog god class（~2.9 万行，含 6888 行 Catalog.java）
│       ├── load/               # 数据导入（loadv2/routineload/sync/update，~2.3 万行）
│       ├── common/             # 通用工具与配置（~1.9 万行）
│       ├── planner/            # 计划生成与 CBO 优化（~1.4 万行，无独立 Optimizer）
│       ├── qe/                 # 查询协调 Coordinator + 查询执行（~1.4 万行）
│       ├── alter/              # Schema Change（~1.0 万行）
│       ├── http / httpv2/      # HTTP 服务（v1 默认 / v2 opt-in，~1.5 万行）
│       ├── mysql/             # MySQL 协议（含 nio/ 非阻塞，~0.77 万行）
│       ├── backup/             # 备份恢复（~0.71 万行）
│       ├── persist/ + journal/ # EditLog + BDBJE HA（~0.94 万行）
│       ├── clone/              # 副本调度与均衡（~0.66 万行）
│       ├── task/               # FE→BE 任务派发 AgentBatchTask（~0.51 万行）
│       ├── transaction/        # 事务管理（~0.38 万行，4 态）
│       ├── system/             # BE 节点管理 SystemInfoService（~0.30 万行）
│       ├── external/           # 联邦数据源（ES/ODBC/MySQL，~0.22 万行）
│       └── rewrite/            # 表达式改写规则 + MV 改写（~0.40 万行）
├── be/                          # Backend（C++）
│   └── src/
│       ├── olap/                # 存储引擎 Tablet/Rowset(alpha+beta)/Segment（~7.1 万行）
│       ├── runtime/             # 运行时基础 ExecEnv/RuntimeState/RowBatch（~4.8 万行）
│       ├── exec/                # 行式执行引擎 ExecNode Volcano（~3.8 万行，唯一执行路径）
│       ├── util/                # 工具（~3.3 万行）
│       ├── gutil/               # Google 工具（~3.3 万行）
│       ├── exprs/               # 表达式引擎 Expr 树 + AnyVal（~2.2 万行）
│       ├── http/                # HTTP 服务（含 Stream Load action，~0.78 万行）
│       ├── agent/               # BE↔FE 心跳与任务代理（~0.40 万行）
│       ├── service/             # BE 守护进程 doris_main + brpc/thrift 服务（~0.16 万行）
│       ├── common/              # 通用（~0.30 万行）
│       └── env/                 # 文件系统抽象（~0.12 万行）
├── gensrc/                      # IDL 定义
│   ├── thrift/                 # FE↔BE Thrift 接口（PaloInternalService/FrontendService/AgentService/HeartbeatService 等）
│   └── proto/                  # protobuf（internal_service/olap/segment_v2）
├── fs_brokers/                  # Broker（外部文件读取代理，PaloBrokerService.thrift）
├── regression-test/            # 回归测试
└── conf/                        # 默认配置
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/doris-0140-internals/module-dependencies.svg)

模块间依赖以 FE 的 `Catalog` 为中心——它是 god class（6888 行），被优化器、协调器、导入、集群运维模块共同依赖；BE 侧 `exec`（行式执行）与 `exprs`（表达式）紧密协作，共同读写 `olap` 存储引擎、依赖 `runtime` 运行时基础。**0.14.0 没有 `vec/` 模块**——`exec` 是唯一执行路径，不存在向量化双轨。`Catalog` 通过 brpc 向 BE 的 `exec` 下发 Fragment，`load` 通过 Tablet Sink 向 `olap` 写 rowset。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 查询解析与优化 | SQL 解析→分析→改写→计划 | `Analyzer`、`Planner` | 0.x 唯一规划路径（无 Nereids），逻辑/分布式计划分层 | [01-analysis-planner](01-analysis-planner) |
| 元数据与 Catalog | 元数据/HA/事务状态 | `Catalog` god class、`EditLog` | 集中元数据避免多写源，BDB JE 复制保证高可用 | [02-catalog-metadata](02-catalog-metadata) |
| 查询协调与协议 | MySQL 接入 + Fragment 调度 | `Coordinator.exec` | 协调是 FE 与 BE 的桥，独立于优化与存储 | [03-query-coordinator](03-query-coordinator) |
| 数据导入与事务 | Stream/Broker/Routine + 两阶段事务 | `load/`、`transaction/` | 导入是写路径，与读路径分离编排，4 态事务保证原子可见 | [04-data-load-txn](04-data-load-txn) |
| 集群管理与运维 | 副本均衡/Schema Change/备份/选主 | `TabletScheduler`、`SchemaChangeHandler` | 运维是 Master FE 的后台职责域，独立于查询 | [05-cluster-ops](05-cluster-ops) |
| 存储引擎 | Tablet/Rowset/Segment + Compaction | `StorageEngine`、`Tablet` | 列存与副本是 BE 核心资产，独立于执行 | [06-storage-engine](06-storage-engine) |
| 执行引擎 | Volcano pull 行式算子 | `ExecNode`、`create_node` | 0.x **唯一**执行路径，纯 Impala 血统（无向量化） | [07-exec-engine](07-exec-engine) |
| 表达式引擎 | Expr 树 + AnyVal 求值 | `Expr`、`ExprContext` | 行式表达式路径，dlsym 函数加载 | [08-expression-engine](08-expression-engine) |
| 运行时基础 | ExecEnv/RuntimeState/MemTracker/RPC | `ExecEnv`、`doris_main.cpp` | 跨模块共享的底层数据结构与资源管理 | [09-runtime-foundation](09-runtime-foundation) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

FE 启动入口在 `PaloFe.main()`（`PaloFe.java:59`）→ `start()`（`:64`），BE 启动入口在 `be/src/service/doris_main.cpp:80` 的 `main`。FE 启动按顺序装配如下对象：

```
PaloFe.start()
  → Config.init(fe.conf) + initCustom(fe_custom.conf)   // 配置：文件→自定义覆盖
  → createAndLockPidFile()                              // pid 文件锁防多实例
  → Catalog.getCurrentCatalog().initialize(args)        // 装配 Catalog god class：
      → loadImage(this.imageDir)                        //   元数据 image 恢复
      → replayJournal / BDBJE 选主                       //   journal 回放 + fencing 防脑裂
      → transferToMaster/transferToNonMaster             //   角色切换，启动后台 Daemon
  → waitForReady()                                      // 等元数据就绪
  → new FeServer(rpc_port).start()                      // Thrift RPC 服务（FE 暴露给 BE）
  → HttpServer/httpv2.start()                           // HTTP REST（导入/管理，v1 默认）
  → new QeService(query_port).start()                   // MySQL 协议
```

关键装配点：`Catalog` 是通过 `Catalog.getCurrentCatalog()`（`catalog/Catalog.java:574`）拿到的进程级单例——普通线程返回 `SingletonHolder.INSTANCE`（`:471`），**checkpoint 线程**返回独立 `CHECKPOINT` 实例（`:578`）避免污染主内存。`initialize()`（`:718`）内完成 image 加载（`loadImage` at `:1462`）、EditLog 回放（`replayJournal` at `:2419`）、BDBJE 选主、后台线程启动——**对象实例化顺序**是先恢复持久化元数据，再启动依赖元数据的服务。选主由 BDBJE 自动完成，`Catalog` 经 `typeTransferQueue` 收到角色变更后异步 `transferToMaster()`（`:1136`，含脑裂防护）/`transferToNonMaster()`（`:1310`，启动 replayer 回放 journal）。配置优先级：命令行 > `fe_custom.conf` > `fe.conf`。

BE 启动：`doris_main`（`:80`）→ `config::init` 加载配置（`be.conf`+`be_custom.conf`）→ TCMalloc 设 aggressive decommit → 解析存储路径并校验磁盘可读写 → `Daemon.init/start`（硬件信息、UDF 缓存、函数注册）→ `ResourceTls::init` + `BackendOptions::init` → `StorageEngine::open(options, &engine)`（`:200`）→ `ExecEnv::GetInstance()`（`:207`）+ `ExecEnv::init(exec_env, paths)`（`:208`）装配 BE 侧 god class 并 `set_storage_engine` → `engine->start_bg_threads()`（`:214`，**必须在 ExecEnv 初始化之后**）启动 Compaction/Flush/GC 后台线程 → 依次启动四类服务：Thrift `be_server`（`be_port`，`:222`）、brpc `brpc_service`（`brpc_port`，`:231`）、HTTP `http_service`（`webserver_port`，`:239`，含 Stream Load）、heartbeat（`heartbeat_service_port`，`:251`）→ 主循环 `while (!k_doris_exit) sleep(10)`（`:268`）。

### 核心运行流程

下面两条主链路覆盖了 Doris 0.14.0 最核心的运行模式：查询执行（读路径）与数据导入（写路径）。0.x 无云模式，故无第三条云元数据链路。

#### 读路径：SQL → 解析 → 计划 → 调度 → 执行 → 返回

业务流程：客户端发 SQL → FE 用 CUP 解析 + Analyzer 语义分析 + 改写 → Planner 生成 PlanFragment → Coordinator 两阶段下发 → BE 装配 ExecNode 拉模型执行 → 算子从 olap 存储引擎拉取数据 → 结果回传。

![查询执行数据流](/vibe-reading/images/articles/doris-0140-internals/data-flow.svg)

文字描述：`ConnectProcessor.handleQuery()`（`qe/ConnectProcessor.java:158`）经 MySQL NIO 协议收到 SQL，`new StmtExecutor(ctx, parsedStmt)`（`:197`）后交 `StmtExecutor.execute()`（`qe/StmtExecutor.java:240`），`analyze()`（`:404`）内先用 CUP 生成的 `SqlParser` 解析为 AST，再 `new Analyzer(catalog, context)` 做 `parsedStmt.analyze()` 语义分析（名字解析、类型推导、TupleDescriptor/SlotDescriptor 绑定、谓词注册到 `tuplePredicates`/`slotPredicates`），随后 `StmtRewriter.rewrite()` 改写子查询（IN/EXISTS→Join）、`ExprRewriter.rewrite()` 循环应用规则（常量折叠 `FoldConstantsRule`、`BetweenToCompoundRule`、`NormalizeBinaryPredicatesRule`，规则在 `Analyzer.GlobalState` 构造时注册，`analysis/Analyzer.java:246`），改写后 re-analyze。`Planner.plan()` 调 `SingleNodePlanner.createSingleNodePlan()`（含 `createCheapestJoinPlan` Cost-Based Join 重排）生成单节点 PlanNode 树，再 `DistributedPlanner.createPlanFragments()` 切分为 `PlanFragment` 列表。

`StmtExecutor.handleQueryStmt()`（`:720`）创建 `Coordinator`（`qe/Coordinator.java`，`coord = new Coordinator(context, analyzer, planner)` at `:680`），`coord.exec()` 做两阶段调度：先 `computeScanRangeAssignment()` 将 scan range 分配到 BE，再 `computeFragmentExecParams()` 为每个 fragment 选 host、分配 instanceId，最后 `execRemoteFragmentAsync()`（`:1814`）经 `BackendServiceProxy.getInstance().execPlanFragmentAsync(brpcAddress, rpcParams)`（`:1823`）下发——返回 `Future<PExecPlanFragmentResult>`（brpc protobuf，`Coordinator.java:472`），`fragments.size() >= 2` 时走两阶段（先 prepare 全部，再统一触发 start）。BE 侧 brpc `PInternalServiceImpl::exec_plan_fragment` → `FragmentMgr::exec_plan_fragment`（`runtime/fragment_mgr.cpp:445`）→ `FragmentExecState::execute()`（`:214`）→ `PlanFragmentExecutor::prepare()`（`runtime/plan_fragment_executor.cpp:71`，装配 `RuntimeState` + `ExecNode::create_tree`，`exec/exec_node.cpp:261`，工厂按 `TPlanNodeType` 直接实例化具体节点，**无 `enable_vectorized` 分支**）→ 线程池提交执行：`open()`（`:236`）→ 循环 `get_next(state, &row_batch, &eos)`（`:450`，Volcano pull 递归拉取 `RowBatch`）→ `OlapScanNode` 经 `TabletReader` 读 `Tablet` 的 `Rowset`/`Segment` 按列存 Page 解码。结果经 `ResultSink` → `BufferControlBlock`，FE 经 `Coordinator.getNext()` → `ResultReceiver.getNext()`（brpc `fetch_data`）拉取 → `MysqlChannel.sendOnePacket` 返回客户端。

#### 写路径：Stream Load → MemTable → Rowset → 发布版本

业务流程：HTTP 推数据 → BE 转 FE 开事务（PREPARE）→ FE 生成导入计划返回 BE → BE 写 MemTable 刷盘成 Rowset → FE 提交事务（COMMITTED）→ 发布版本使其可见（VISIBLE）。

文字描述：`http/action/stream_load.cpp` 的 `StreamLoadAction` 解析 HTTP 头，建 `StreamLoadPipe`，经 Thrift RPC 调 FE `FrontendServiceImpl.streamLoadPut` 由 `StreamLoadPlanner.plan()`（`planner/StreamLoadPlanner.java:98`）生成含 `OlapTableSink`（`:137`）的 fragment 返回 BE。此前 `begin_txn` 已调 FE `loadTxnBegin`（`service/FrontendServiceImpl.java:707` → `loadTxnBeginImpl` at `:737`）由 `GlobalTransactionMgr.beginTransaction()`（`transaction/GlobalTransactionMgr.java:97`）委托 `DatabaseTransactionMgr.beginTransaction()` 创建 `TransactionState(PREPARE)` 并写 EditLog。BE `FragmentMgr::exec_plan_fragment` 执行 fragment：ScanNode 从 `StreamLoadPipe` 读 CSV/JSON → `OlapTableSink::send` → 目标 BE `DeltaWriter`（`olap/delta_writer.h:54`，持有 `_mem_table` at `:108`）写 `MemTable`，满后 `flush` 为 `BetaRowsetWriter` 的 Segment（`SegmentWriter.finalize` 写列存 Page + 多级索引）。完成后 BE 调 `loadTxnCommit`（`FrontendServiceImpl.java:773` → `loadTxnCommitImpl` at `:800`），`DatabaseTransactionMgr.commitTransaction()`（`transaction/DatabaseTransactionMgr.java:353`）校验 quorum replica（`quorumReplicaNum = replicationNum / 2 + 1` at `:493`，`successReplicaNum < quorumReplicaNum` at `:527` 即失败）后将状态 PREPARE→COMMITTED 并写 EditLog。再由 `PublishVersionDaemon`（`Catalog` 持有）异步下发 `PublishVersionTask` 到 BE，全部成功后 `finishTransaction()` 转 VISIBLE——推进 `partition.visibleVersion` 保证版本原子可见。

### 状态流

![导入事务状态流](/vibe-reading/images/articles/doris-0140-internals/state-flow.svg)

上图是导入事务的完整状态机（`TransactionStatus.java:20`）：主链 `PREPARE → COMMITTED → VISIBLE` 是两阶段提交的正常路径（`commit` 正式提交、`publish` 发布版本使数据可见），`PREPARE` 或 `COMMITTED` 阶段均可 `abort` 进入终态 `ABORTED`。`isFinalStatus()`（`:55`）判定 VISIBLE 与 ABORTED 为终态。**0.14.0 只有 4 态，没有 1.x 的 `PRECOMMITTED` 预提交态**——这是 0.x 事务更简练的标志。COMMITTED 与 VISIBLE 的分离设计让 commit 快速返回（数据安全写入），publish 异步进行不阻塞导入；查询只看 visibleVersion 保证一致性。`LoadJob` 自身还有作业状态机（PENDING→ETL→LOADING→COMMITTED→FINISHED/CANCELLED），通过 `TxnStateChangeCallback` 与事务状态联动。

---

## 典型修改场景

#### 场景 1：新增一条表达式改写规则（如 LIKE 前缀改写）

需修改：新建 `fe/.../rewrite/LikePrefixRule.java` 实现 `ExprRewriteRule.apply()`；在 `analysis/Analyzer.java:246` 的 `GlobalState` 构造函数 `rules` 列表注册 `LikePrefixRule.INSTANCE`（须排在 `NormalizeBinaryPredicatesRule` 之后，确保 SlotRef 已在左侧）。无需改 `StmtRewriter` 或 `Planner`——`ExprRewriter.rewrite()` 会自动在 `SelectStmt.rewriteExprs()` 中被调用。对应测试：`fe/fe-core/src/test/java/org/apache/doris/rewrite/`、`regression-test/suites/`。

#### 场景 2：新增一个 BE 执行算子类型

需修改：在 `be/src/exec/` 下新增 `XxxNode.h/cpp` 继承 `ExecNode`，实现 `get_next(RowBatch*, bool* eos)`（`exec/exec_node.h:99` 的纯虚）；在 `exec_node.cpp:329` 的 `create_node()` switch 添加 `case TPlanNodeType::XXX_NODE:` 分支直接 `*node = new XxxNode(...)`（0.14.0 无向量化分支，无需二选一）；在 `gensrc/thrift/PlanNodes.thrift` 的 `TPlanNodeType` 枚举新增值；FE 侧 `planner/SingleNodePlanner.java` 与 `DistributedPlanner.java` 新增构建与切分逻辑。对应测试：`be/test/exec/`、`regression-test/suites/`。

#### 场景 3：新增一个标量函数

需修改：在 `be/src/exprs/` 下新增函数实现（继承 `Expr`，`exprs/expr.h:63`，实现 `get_next`/求值）；通过 dlsym 动态加载或 `FunctionSet` 注册函数符号；FE 侧 `catalog/FunctionSet.java` `init()` 注册函数元信息；`gensrc/thrift/Exprs.thrift` 补 `TFunction` 描述。对应测试：`be/test/exprs/`、`regression-test/suites/`。

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
| BE 算子/函数 | `be/test/`（exec/exprs/olap） | 行式算子与存储行为单测 |
| 导入/事务 | `regression-test/load_p0` | 端到端各导入形态 + 4 态事务可见性 |
| 副本/Schema Change | `regression-test/clone`、`alter` | 副本补齐与在线变更 |

修改某层代码时，参照上表找到对应测试优先阅读——Doris 的回归测试是很好的"可执行文档"。

---

## 阅读源码推荐路线

- 第一遍：理解 FE 启动与查询主流程
  `PaloFe.java:59` 的 `main`/`start` → `qe/StmtExecutor.java:240` 的 `execute`/`:404` 的 `analyze` → `qe/ConnectProcessor.java:158` 的 `handleQuery` → `qe/Coordinator.java` 的 `exec`/`execRemoteFragmentAsync`(:1814)
- 第二遍：理解 legacy 优化流水线
  `fe/fe-core/src/main/cup/sql_parser.cup`（语法）→ `analysis/Analyzer.java:83` 的 `Analyzer`（`GlobalState` at `:167`，规则注册 at `:246`）→ `analysis/StmtRewriter.java` 的 `rewrite` → `planner/SingleNodePlanner.java` 的 `createCheapestJoinPlan` → `planner/DistributedPlanner.java` 的 `createPlanFragments`
- 第三遍：理解 BE 执行与存储
  `be/src/service/doris_main.cpp:80` 的 `main` → `be/src/runtime/exec_env.h`（ExecEnv 服务定位器）→ `be/src/runtime/fragment_mgr.cpp:445` 的 `exec_plan_fragment` → `be/src/runtime/plan_fragment_executor.cpp:71` 的 `prepare`/`:450` 的 `get_next` → `be/src/exec/exec_node.cpp:329` 的 `create_node`（注意：纯 switch，无向量化分支）→ `be/src/olap/storage_engine.h` + `rowset/rowset.h`
- 第四遍：选择重点子模块深入（模块文档）
  存储读者从 `be/src/olap/tablet.h` + `rowset/rowset.h` 进 [06-storage-engine](06-storage-engine)；执行读者从 `be/src/exec/exec_node.h:60` + `exec_node.cpp:329` 进 [07-exec-engine](07-exec-engine)；导入读者从 `fe/.../transaction/GlobalTransactionMgr.java` + `TransactionStatus.java:20` 进 [04-data-load-txn](04-data-load-txn)

---

## 附录

**术语表**：

| 术语 | 含义 |
| --- | --- |
| FE / BE | Frontend（元数据/优化/协调/运维）、Backend（执行/存储） |
| Palo | Doris 前身（百度），0.x 仍遍布 Palo 命名（`PaloFe.java`、`PaloInternalService`、`PaloAuth`） |
| incubating | 孵化器时期，0.14.0 自述 "Apache Doris (incubating)"，尚未毕业为顶级项目 |
| Catalog（god class） | 0.x FE 元数据/调度总控单例（6888 行），2.x 拆分重命名为 `Env` |
| Tablet | 数据分片，Doris 副本与调度的基本单位 |
| Rowset | 一次导入/Compaction 产生的不可变数据版本集；0.x 有 alpha（segment v1）/beta（segment_v2）两代 |
| Segment | Rowset 内的列存段，含多个列式 Page + 多级索引 |
| Compaction | 后台合并多个 Rowset 减少读放大（Cumulative + Base 两级） |
| EditLog | FE 元数据变更日志，BDB JE 复制 |
| Volcano pull | `ExecNode` 的 `get_next` 拉模型，按 `RowBatch` 行式（0.x 唯一执行模型，无向量化无 Pipeline） |
| alpha/beta rowset 迁移 | `StorageEngine::default_rowset_type()`（`storage_engine.h:156`）由心跳动态切默认，迁移 segment v1→v2 |

**参考资料**：

- [Apache Doris 官方文档](https://doris.apache.org/docs)
- [Doris GitHub 仓库](https://github.com/apache/doris)（0.14.0 tag）
- [Google Mesa 论文](https://research.google/pubs/pub42851/)（列存与预聚合理论基础）
- [Apache Impala](https://impala.apache.org/)（FE 优化器与行式执行引擎血统来源——Analyzer/ExecNode/Planner 的设计渊源）
- [Doris Overview Wiki](https://github.com/apache/incubator-doris/wiki/Doris-Overview)（0.x 时期项目自述）
