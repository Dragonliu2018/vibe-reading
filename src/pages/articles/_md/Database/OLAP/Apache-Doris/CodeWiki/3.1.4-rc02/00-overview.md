---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Overview"
date: "2026-08-23T18:55:05+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "Java", "C++", "MPP", "OLAP", "向量化执行", "Cascades 优化器"]
description: "Apache Doris 3.1.4-rc02 源码架构解读：双优化器过渡版（Nereids 默认 + Legacy 回退）、Pipeline 拉模型、vec 统一向量化、olap 存储引擎的 FE/BE 分离 MPP 数仓。"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 3.1.4-rc02 · **协议** Apache-2.0 · **语言** Java 17 / C++20 · **代码量** ~170 万行（FE ~103 万 Java + BE ~57.9 万 C++ + Cloud ~8.8 万）· **仓库** [GitHub](https://github.com/apache/doris)

---

## 总览

### 项目简介

**Apache Doris** 是一个基于 MPP（Massively Parallel Processing）架构的易用、高性能、实时分析型数据库。它在海量数据下只需亚秒级响应即可返回查询结果，既能支撑高并发点查，也能支撑高吞吐复杂分析，适用于报表分析、Ad-hoc 查询、统一数据仓库、数据湖查询加速、用户行为分析、AB 测试平台、日志检索等场景。

Doris 采用经典的 **FE（Frontend，Java）+ BE（Backend，C++）** 分离架构：FE 负责元数据管理、SQL 解析优化、查询协调调度、导入事务编排；BE 负责向量化执行引擎、列存存储引擎、表达式与函数求值、文件格式读写。FE 之间通过 BDB JE 复制实现元数据高可用，FE 与 BE 之间通过 Thrift/gRPC 通信下发执行计划、回传结果。

**3.1.4-rc02 的版本定位**：这是 3.1 线的候选版本（解读基线 commit `7f5ba43de6c`，2025-12-26），处于架构过渡期——新一代 **Nereids 优化器** 已成为默认查询路径（`enable_nereids_planner=true` in `SessionVariable.java:1498`），但旧版 `analysis/Analyzer` + `planner/DistributedPlanner` 路径仍完整保留作为**回退安全网**（见 `StmtExecutor.executeByLegacy()`）；BE 侧向量化执行与函数统一聚合在 `vec/` 目录（~21 万行），存储引擎仍用 `olap/` 旧命名（4.x 起更名为 `storage/`）。云原生存算分离（Cloud 模式）已内置但属可选增强。

**项目边界**：Doris 负责分析型（OLAP）数据的存储与查询，**不**承担在线事务（OLTP）的强一致行级读写职责；它通过 Unique 模型 + MoW（Merge-on-Write）+ Delete Bitmap 提供近实时更新能力，但本质仍是面向分析的列存仓库。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| MySQL/Arrow Flight 协议接入 | `fe/.../mysql/`、`DorisFE.java` | 兼容 MySQL 协议 + Arrow Flight SQL，JDBC/BI 直连 |
| Cascades CBO 优化 | `fe/.../nereids/` | Nereids 优化器：Memo + 规则 + 代价模型 + DPHyp join reorder |
| 旧版优化器回退 | `fe/.../analysis/`、`planner/` | Analyzer + DistributedPlanner，Nereids 不支持时回退 |
| Pipeline 向量化执行 | `be/src/pipeline/` | Pull 拉模型 + MLFQ + Work Stealing |
| 向量化与函数 | `be/src/vec/` | VExpr + IFunction + IAggregateFunction(CRTP)，源自 ClickHouse |
| olap 列存引擎 | `be/src/olap/` | Tablet/Rowset/Segment + Compaction + Delete Bitmap(MoW) |
| 实时导入 | `fe/.../load/`、`httpv2/rest/` | Stream Load / Routine Load / Broker Load + 两阶段事务 |
| 联邦查询 | `fe/.../datasource/` | ExternalCatalog 懒加载：Hive/Iceberg/Hudi/JDBC |
| 存算分离 | `cloud/src/` | Cloud 模式 MetaService(FoundationDB) + Recycler |
| 副本自均衡 | `fe/.../clone/`、`scheduler/` | TabletScheduler + Rebalancer |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Java 17 | 核心（FE） | FE 全部逻辑，JVM 运行 |
| C++20 | 核心（BE） | BE 执行与存储引擎，向量化 |
| ANTLR4 | 核心 | Nereids SQL 词法/语法解析器生成（`NereidsParser`） |
| BDB JE | 核心 | FE 元数据复制与选主（EditLog） |
| Thrift / Protobuf | 核心 | FE↔BE RPC 接口定义（`gensrc/thrift/`、`gensrc/proto/`） |
| brpc | 核心 | BE 间及 FE↔BE 高性能 RPC（`internal_service.proto`） |
| FoundationDB | 核心（Cloud） | 云模式元数据存储（MetaService 后端） |
| Arrow / Parquet / ORC | 核心 | 外部数据湖格式读写（`be/src/vec/io/`） |
| Caffeine | 可选 | 外部 Catalog 元数据缓存 |

### 版本历史

Doris 的主线演进可粗分为：2.x 线确立 segment_v2 列存与向量化执行基础；3.0 线将 **Nereids Cascades 优化器**推为默认路径、**Pipeline 拉模型执行引擎**替代旧 Volcano push 模型；3.1 线在此之上持续收敛——完善 MoW Unique 表性能（Delete Bitmap）、联邦数据源（Iceberg/Paimon）、云原生存算分离稳定性。**3.1.4-rc02** 是 3.1 线的候选版本（2025-12-26），仍保留旧版优化器作为回退路径——这是它与 4.x 的关键差异：4.x 线已大幅移除 legacy 优化器代码，而 3.1.x 处于"Nereids 默认、Legacy 兜底"的过渡态。

### 顶层上下文图

Doris 的外部交互方包括：**MySQL/Arrow Flight 客户端**（JDBC、BI 工具、调度系统）经查询端口接入；**数据导入方**经 HTTP REST（Stream Load）或 Routine Load（Kafka）推送数据；**外部数据源**（Hive Metastore、Iceberg/Hudi/Paimion 表、JDBC 数据库）作为联邦查询对象；**云存储**（对象存储 S3/OSS）在 Cloud 模式下承载 segment 数据，FoundationDB 承载元数据。BE 进程既是计算节点也是存储节点（非云模式）。

---

## 快速上手

```bash title="最小化部署验证"
# 1. 构建（需 Java 17 + C++20 工具链 + thirdparty）
sh build.sh --fe --clean        # 构建 FE
sh build.sh --be --clean        # 构建 BE

# 2. 启动单节点（FE + BE 同机）
cd fe && bin/start_fe.sh --daemon   # FE 进程，监听 query/http/rpc/edit_log 端口
cd be && bin/start_be.sh --daemon   # BE 进程，监听 be_port/heartbeart_port

# 3. 用 MySQL 客户端连接并验证
mysql -h 127.0.0.1 -P 9030 -uroot
> ADD BACKEND "127.0.0.1:9050";          # 注册 BE
> CREATE DATABASE demo;
> CREATE TABLE t (k INT, v VARCHAR(32)) DISTRIBUTED BY HASH(k) BUCKETS 1 PROPERTIES("replication_num"="1");
> stream load ...                        # 或 INSERT INTO t VALUES (1,'a');
> SELECT * FROM t;                       # 端到端验证：查询返回
```

> 构建依赖 `thirdparty/` 预编译库，首次需 `sh build.sh --thirdparty`。详细参数见仓库 `build.sh` 与 `CONTRIBUTING.md`。

---

## 架构设计解析

### 系统架构

Doris 的架构思想是**存算职责分离 + 主从元数据高可用**：把"想清楚要查什么"（FE 的解析/优化/协调）与"真正把数据捞出来算完"（BE 的执行/存储）拆成两类进程，用 RPC 解耦，使计算可横向扩展、存储可独立演进；元数据集中在 FE 用 BDB JE 复制保证高可用，避免单点。云模式进一步把元数据从 FE 进程内嵌的 BDB JE 移到独立的 MetaService（FoundationDB），把 segment 数据移到对象存储，实现**存算彻底分离**。

![Doris 3.1.4 分层架构](/vibe-reading/images/articles/doris-314-internals/architecture.svg)

如上图，系统自上而下分为接入层、FE 层、BE 层、列式存储层，右侧为可选的 Cloud 层。FE 与 BE 是分离进程，gRPC 通信；云模式时 BE 的元数据访问经 MetaService 走 FoundationDB，数据读写走对象存储。各层依赖方向自上而下，下层不感知上层。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接入层 | `fe/.../mysql/`、`httpv2/`、`service/` | 隔离外部协议（MySQL/Arrow Flight/HTTP/Thrift），保护核心不受协议变化影响 |
| FE 规划层 | `fe/.../nereids/`、`analysis/`、`planner/` | 把 SQL 翻译成可执行的物理计划，Cascades 代价优化 |
| FE 协调层 | `fe/.../catalog/`、`qe/`、`load/`、`datasource/` | 元数据管理、查询调度、导入事务、联邦数据源 |
| BE 执行层 | `be/src/pipeline/`、`vec/`、`runtime/` | 拉模型执行、向量化算子与函数、运行时基础 |
| BE 存储层 | `be/src/olap/` | Tablet/Rowset/Segment 列存 + Compaction + MoW |
| Cloud 层 | `cloud/src/` | 存算分离元数据服务（MetaService）+ 资源回收 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器（Service Locator） | `Env`（FE）、`ExecEnv`（BE） | 集中持有全局单例依赖，避免到处传参；`Env` 是 FE god class，`ExecEnv::GetInstance()` 是 BE god class |
| Cascades 搜索 | `nereids/jobs/executor/Optimizer.java` | 用 Memo 记录等价计划空间，基于代价剪枝搜索最优计划，比启发式规则更准 |
| 拉模型（Pull/Volcano 变体） | `pipeline/PipelineTask::execute` | 算子按需 pull 数据（Block），天然支持背压、MLFQ 公平调度、Work Stealing |
| CRTP 静态多态 | `vec/functions/function.h`、`vec/aggregate_functions/` | 编译期消除虚函数开销，向量化热路径零成本抽象 |
| COW（Copy-on-Write） | `vec/core/block.h`、`ColumnPtr` | 列数据共享不可变，写时复制，避免深拷贝 |
| 懒加载 | `datasource/ExternalCatalog::initLocalObjects` | 外部 Catalog 连接昂贵，首次访问才初始化，缓存失效可重置 |
| 两阶段提交 | `transaction/TransactionStatus` + `load/` | 导入先 COMMITTED 再 VISIBLE，发布版本号使数据原子可见 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Env`（FE） | 元数据/调度/事务总控 god class | FE 进程单例 | 持有 CatalogMgr、EditLog、GlobalTransactionMgr 等 |
| `Coordinator` | 单次查询的协调者 | 查询级 | 调用 NereidsPlanner、下发 Fragment 到 BE |
| `NereidsPlanner` | Nereids 优化入口 | 查询级 | 持有 CascadesContext、Memo、PhysicalPlan |
| `PipelineFragmentContext` | BE 单 Fragment 装配 | Fragment 级 | 构建 Source→Operator→Sink 的 Pipeline DAG |
| `PipelineTask` | 可调度执行单元 | 任务级 | 从 TaskQueue 拉取、execute(eos)、回队列 |
| `Tablet` | 数据分片，副本管理单位 | 持久 | 持有多个 Rowset |
| `Rowset` | 不可变数据版本集 | 版本级 | 由 Segment 组成，参与 Compaction |
| `Block` | 列式批数据单元 | 执行期 | 算子间传递，含 ColumnWithTypeAndName |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Planner` | `planner/Planner.java` | `NereidsPlanner`、`legacy Planner` | `StmtExecutor` 按开关选择 |
| `ExternalCatalog` | `datasource/ExternalCatalog.java` | `HMSExternalCatalog`、`JdbcExternalCatalog` 等 | `CatalogMgr` 按 type 创建 |
| `IPreparedFunction` | `vec/functions/function.h` | 各具体函数（CRTP 派生） | `FunctionFactory` 按名查找 |
| `IAggregateFunction` | `vec/aggregate_functions/` | 各聚合函数（CRTP） | `AggregateFunctionFactory` 注册 |
| `BaseStorageEngine` | `olap/storage_engine.h` | `StorageEngine`、`CloudStorageEngine` | `ExecEnv` 按云模式选择 |
| `Source/Sink/Operator` | `pipeline/exec/` | 各算子实现 | `PipelineFragmentContext` 装配 |

---

## 代码目录

```
doris/
├── fe/                          # Frontend（Java）
│   ├── fe-core/                 # FE 核心
│   │   └── src/main/java/org/apache/doris/
│   │       ├── DorisFE.java     # FE 入口
│   │       ├── nereids/         # 新一代 Cascades 优化器（~24.6 万行）
│   │       ├── analysis/        # 旧版语句分析与 Analyzer（~9 万行）
│   │       ├── planner/         # 旧版物理计划 DistributedPlanner（~2.5 万行）
│   │       ├── catalog/         # 元数据 Env god class + 副本（~5 万行）
│   │       ├── qe/              # 查询协调 Coordinator + MySQL 协议（~3 万行）
│   │       ├── load/            # 数据导入 + 事务（~2.1 万行）
│   │       ├── datasource/      # 联邦数据源 ExternalCatalog（~6.6 万行）
│   │       ├── cloud/           # FE 侧云模式逻辑（~2 万行）
│   │       └── persist/journal/ # 元数据持久化 EditLog + BDBJE
│   └── fe_plugins/              # FE 插件
├── be/                          # Backend（C++20）
│   └── src/
│       ├── vec/                 # 向量化执行+函数+列存类型（~21.2 万行，统一）
│       ├── olap/                # 存储引擎 Tablet/Rowset/Segment（~11.9 万行）
│       ├── pipeline/            # Pipeline 拉模型执行引擎（~3.8 万行）
│       ├── runtime/             # 运行时基础 ExecEnv/FragmentMgr/MemTracker（~3.4 万行）
│       ├── io/                  # FileSystem 抽象 + 文件缓存（~2.4 万行）
│       ├── exec/                # 部分执行算子（~1.6 万行）
│       ├── cloud/               # BE 侧云模式（~1.7 万行）
│       └── service/             # BE RPC 服务 internal_service
├── cloud/                       # 存算分离 MetaService（C++ ~8.8 万行）
│   └── src/meta-service/        # MetaService(FoundationDB) + Recycler
├── gensrc/                      # IDL 定义
│   ├── thrift/                  # FE↔BE Thrift 接口（FrontendService 等）
│   └── proto/                   # protobuf（internal_service/cloud/olap）
├── regression-test/             # 回归测试
└── conf/                        # 默认配置
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/doris-314-internals/module-dependencies.svg)

模块间依赖以 FE 的 `Catalog/Env` 为中心——它是 god class，被优化器、协调器、导入、联邦模块共同依赖；BE 侧 `Pipeline` 调用向量化算子、读写 `olap` 存储引擎，`运行时基础`（Block/Column/MemTracker）贯穿全链路。Nereids 与旧版优化器是两条并行规划路径，汇入同一个 `Coordinator`。云模式下 `olap` 存储引擎与 Cloud `MetaService` 双向交互。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Nereids 优化器 | Cascades CBO 代价优化 | `NereidsPlanner.plan` | 新一代优化范式，逻辑/物理分离，规则+代价独立演进 | [01-nereids-optimizer](01-nereids-optimizer) |
| 旧版优化器 | Analyzer 分析 + 计划生成 | `DistributedPlanner.createPlanFragments` | 3.1.x 过渡期保留的回退安全网，Impala 式分析器 | [02-legacy-planner](02-legacy-planner) |
| Catalog 元数据 | 元数据/副本/HA/事务状态 | `Env` | 集中元数据避免多写源，BDB JE 复制保证高可用 | [03-catalog-metadata](03-catalog-metadata) |
| 查询协调 | Fragment 调度与结果汇总 | `Coordinator.exec` | 协调是 FE 与 BE 的桥，独立于优化与存储 | [04-query-coordinator](04-query-coordinator) |
| 数据导入 | Stream/Broker/Routine + 事务 | `load/`、`httpv2/rest/` | 导入是写路径，与读路径（查询）分离编排 | [05-data-load](05-data-load) |
| 联邦数据源 | 外部 Catalog 懒加载 | `ExternalCatalog` | 外部元数据获取昂贵且异构，需独立缓存与抽象 | [06-federated-datasource](06-federated-datasource) |
| 存储引擎 | Tablet/Rowset/Segment + Compaction | `StorageEngine`、`Tablet` | 列存与副本是 BE 的核心资产，独立于执行 | [07-storage-engine](07-storage-engine) |
| Pipeline 引擎 | 拉模型执行 + MLFQ 调度 | `TaskScheduler::_do_work` | 执行模型与算子语义分离，调度策略可独立调优 | [08-pipeline-engine](08-pipeline-engine) |
| 向量化与函数 | VExpr + IFunction + 聚合 | `vec/exprs/`、`vec/functions/` | 向量化是性能基石，3.1.x 统一在 vec/ 便于内联 | [09-vectorized-execution](09-vectorized-execution) |
| 运行时基础 | ExecEnv/Block/MemTracker/IO | `ExecEnv`、`vec/core/block.h` | 跨模块共享的底层数据结构与资源管理 | [10-runtime-foundation](10-runtime-foundation) |
| Cloud MetaService | 存算分离元数据 + 回收 | `MetaServiceImpl` | 云模式元数据独立于 FE 进程，FoundationDB 持久化 | [11-cloud-metaservice](11-cloud-metaservice) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

FE 启动入口在 `DorisFE.main()`（`DorisFE.java:93`），BE 启动入口在 `daemon.cpp` 的 `main`。FE 启动按顺序装配如下对象：

```
DorisFE.main()
  → Config.init(fe.conf) + initCustom(fe_custom.conf)   // 配置：文件→自定义覆盖
  → tryLockProcess()                                      // 进程锁防多实例
  → Env.getCurrentEnv().initialize(args)                  // 装配 Env god class：
      → 加载 image / replay EditLog（BDBJE）               //   元数据恢复
      → 启动各类 Daemon 线程（副本均衡、统计、回收）        //   后台对象
  → Env.waitForReady()                                    // 等元数据就绪
  → new FeServer(rpc_port).start()                        // Thrift RPC 服务（FE↔BE）
  → new HttpServer().start()                              // HTTP REST（导入/管理）
  → SimpleScheduler.init()                                // FE 间调度器
  → new QeService(query_port, arrow_flight_port).start()  // MySQL + Arrow Flight 协议
  → startMonitor() (DeadlockMonitor)                      // 死锁检测
```

关键装配点：`Env` 是通过 `Env.getCurrentEnv()` 拿到的进程级单例，`initialize()` 内完成元数据镜像加载、EditLog 回放、后台线程启动——**对象实例化顺序**是先恢复持久化元数据，再启动依赖元数据的服务（RPC/HTTP/QeService 都在 `waitForReady()` 之后）。配置优先级：命令行 > `fe_custom.conf` > `fe.conf`。云模式由 `Config.isCloudMode()`（`cloud_unique_id` 非空判定）切换，影响 `Env` 是否走 Cloud 路径。

BE 启动：`daemon.cpp` → `ExecEnv::init()` 装配 BE 侧 god class（`ExecEnv` 单例持有 `StorageEngine`、`FragmentMgr`、各 `MemTrackerLimiter`、client cache）→ 启动 gRPC 服务（`internal_service`）→ `StorageEngine::start_bg_threads()` 启动 Compaction/Flush 等后台线程。

### 核心运行流程

下面三条主链路覆盖了 Doris 最核心的运行模式：查询执行（读路径）、数据导入（写路径）、云模式元数据访问。

#### 查询执行：SQL → 优化 → 调度 → 执行 → 返回

业务流程：客户端发 SQL → FE 解析优化生成物理计划 → Coordinator 切分 Fragment 两阶段下发 → BE 装配 Pipeline 拉模型执行 → 算子从 olap 存储引擎拉取 Block → 结果回传。

![查询执行数据流](/vibe-reading/images/articles/doris-314-internals/data-flow.svg)

文字描述：`ConnectProcessor` 经 MySQL 协议收到 SQL 后交给 `StmtExecutor.executeByNereids()`，由 `NereidsParser` 解析为 `LogicalPlan`，`NereidsPlanner.planWithLock()` 依次执行 preprocess→analyze→rewrite→optimize→postProcess→distribute，产出 `PhysicalPlan` 与 Fragment 切分（`DistributePlanner`）。`Coordinator` 据此做两阶段调度：先 `computeFragmentExecParams` 完成 scanRange 到 BE 的分配（含 RuntimeFilter 注册），再经 gRPC `exec_plan_fragment` 下发到 BE。BE 侧 `FragmentMgr` 收到后由 `PipelineFragmentContext` 装配 Source→Operator→Sink 的 DAG，`TaskScheduler` 用固定线程池从 `MultiCoreTaskQueue`（MLFQ + Work Stealing）拉取 `PipelineTask` 执行 `execute(&eos)`。Scan 算子最终调用 `StorageEngine` 读取 `Tablet` 的 `Rowset`/`Segment`，按列存 Page 解码为 `Block`，经算子链流转回 Sink，结果经 exchange `send_report` 回 Coordinator。若 Nereids 解析失败或不支持，`StmtExecutor` 捕获 `NereidsException`/`MustFallbackException` 回退 `executeByLegacy()`。

#### 数据导入：Stream Load → MemTable → Rowset → 发布版本

业务流程：HTTP 推数据 → FE 开事务（PREPARE）→ 转发到 BE → BE 写 MemTable 刷盘成 Rowset → FE 提交事务（COMMITTED）→ 发布版本使其可见（VISIBLE）。

文字描述：`httpv2/rest/UploadAction` 收到 Stream Load 请求，`LoadAction` 在 FE 侧 `GlobalTransactionMgr` 开启事务（状态 PREPARE），把请求转发给选定 BE。BE 侧 `DeltaWriterV2`（`delta_writer_v2.cpp`）将收到的 `Block` 写入 `MemTable`（`MemTableWriter`），MemTable 满后 flush 为 `BetaRowsetWriterV2` 的 Segment，生成不可变 `Rowset`。导入完成后 FE 提交事务（COMMITTED），再由发布版本流程将 Rowset 版本号写入 Tablet 元数据使数据对查询可见（VISIBLE）。云模式与 Unique MoW 表在此阶段额外经 `update_delete_bitmap` 更新 Delete Bitmap。

#### 云模式元数据：BE → MetaService → FoundationDB

业务流程：BE 启动云模式 → 元数据读写经 MetaService RPC → FoundationDB 持久化 → Recycler 回收过期资源。

文字描述：当 `Config.isCloudMode()` 时，BE 的 `CloudStorageEngine`（`be/src/cloud/`）替代本地 `StorageEngine`，Tablet 元数据不再落本地磁盘而是经 gRPC 调用 `MetaServiceImpl`（`cloud/src/meta-service/meta_service.cpp`）——`create_tablets`、`commit_txn`、`get_delete_bitmap` 等方法以 FoundationDB 为后端持久化。`TxnLazyCommitter` 实现事务的延迟提交以降低云上小事务开销，`recycler/` 负责回收已删除/过期 segment 的对象存储空间。

### 状态流

![导入事务与优化器回退状态流](/vibe-reading/images/articles/doris-314-internals/state-flow.svg)

上图上半部是导入事务的完整状态机（`TransactionStatus.java`）：主链 `PREPARE → PRECOMMITTED → COMMITTED → VISIBLE` 是两阶段提交的正常路径（`precommit` 预提交、`commit` 正式提交、`publish` 发布版本使数据可见），任何阶段均可 `abort`/`rollback` 进入终态 `ABORTED`。状态枚举定义在 `fe/.../transaction/TransactionStatus.java`，转换由 `GlobalTransactionMgr` 驱动。

下半部是优化器回退状态：`StmtExecutor` 默认走 `executeByNereids`，若 Nereids 抛出 `MustFallbackException` 或遇到不支持的 Command，则回退 `executeByLegacy()` 走旧版 `Analyzer`+`DistributedPlanner` 路径。回退判定见 `StmtExecutor.java:642-669`。

---

## 典型修改场景

#### 场景 1：新增一条 Nereids 优化规则

需修改：在 `fe/.../nereids/rules/` 下新增规则类（实现 `Rule` 接口），在 `nereids/jobs/executor/Rewriter.java`（重写阶段）或 `Optimizer.java`（Cascades 阶段）的规则集中注册。若涉及 join reorder，注意 `nereids/jobs/joinorder/`。对应测试：`regression-test/suites/nereids_p0/`。

#### 场景 2：新增一个向量化标量函数

需修改：在 `be/src/vec/functions/` 下新增函数实现（CRTP 继承 `PreparedFunctionImpl`），在 `function_util.h` 注册名称到 `FunctionFactory`，并在 FE 侧 `BuiltinScalarFunctions.java` 注册函数元信息。对应测试：`be/test/vec/function/`。

#### 场景 3：新增一个联邦数据源 Catalog 类型

需修改：在 `fe/.../datasource/` 下新增 `XxxExternalCatalog extends ExternalCatalog`，实现 `initLocalObjectsImpl()`、`listTableNames()` 等抽象方法，在 `CatalogFactory` 按 type 注册。对应测试：`regression-test/suites/external/`。

---

## 测试体系

```
regression-test/                  # 端到端回归（SQL 行为）
├── suites/                       # 按特性组织的 .groovy 测试
│   ├── nereids_p0/               # Nereids 优化器行为
│   ├── external/                 # 联邦数据源
│   ├── load/                     # 导入各形态
│   └── ...
be/test/                          # BE 单元测试（C++）
fe/fe-core/src/test/             # FE 单元测试（Java）
run-fe-ut.sh / run-be-ut.sh      # 单测执行入口
```

| 代码层 | 测试类型 | 说明 |
| --- | --- | --- |
| Nereids 规则/优化 | `fe-core` 单测 + `nereids_p0` 回归 | 规则匹配用单测，端到端计划用回归 |
| BE 算子/函数 | `be/test/vec` | 向量化行为单测 |
| 导入/事务 | `regression-test/load` | 端到端各导入形态 |
| 联邦数据源 | `regression-test/external` | 真实外部元数据交互 |

修改某层代码时，参照上表找到对应测试优先阅读——Doris 的回归测试是很好的"可执行文档"。

---

## 阅读源码推荐路线

- 第一遍：理解 FE 启动与查询主流程
  `DorisFE.java` 的 `main`/`start` → `qe/StmtExecutor.java` 的 `executeByNereids`/`executeByLegacy` → `qe/ConnectProcessor.java` → `qe/Coordinator.java` 的 `exec`
- 第二遍：理解 Nereids 优化流水线
  `nereids/NereidsPlanner.java` 的 `planWithoutLock` → `nereids/jobs/executor/Optimizer.java` 的 `execute` → `nereids/memo/Memo.java` → `nereids/CascadesContext.java`
- 第三遍：理解 BE 执行与存储
  `be/src/runtime/exec_env.h`（ExecEnv 服务定位器）→ `be/src/runtime/fragment_mgr.cpp` → `be/src/pipeline/task_scheduler.cpp` 的 `_do_work` → `be/src/pipeline/pipeline_task.cpp` 的 `execute` → `be/src/olap/storage_engine.h`
- 第四遍：选择重点子模块深入（模块文档）
  向量化读者从 `be/src/vec/functions/function.h` 的 CRTP 接口进 [09-vectorized-execution](09-vectorized-execution)；存储读者从 `be/src/olap/tablet.h` + `rowset/rowset.h` 进 [07-storage-engine](07-storage-engine)；云模式读者从 `cloud/src/meta-service/meta_service.h` 进 [11-cloud-metaservice](11-cloud-metaservice)

---

## 附录

**术语表**：

| 术语 | 含义 |
| --- | --- |
| FE / BE | Frontend（元数据/优化/协调）、Backend（执行/存储） |
| Nereids | 新一代 Cascades 代价优化器 |
| Memo | Cascades 中记录等价计划空间的记忆结构 |
| Tablet | 数据分片，Doris 副本与调度的基本单位 |
| Rowset | 一次导入/Compaction 产生的不可变数据版本集 |
| Segment | Rowset 内的列存段，含多个 Page |
| MoW | Merge-on-Write，Unique 表写时合并，依赖 Delete Bitmap |
| Compaction | 后台合并多个 Rowset 减少读放大 |
| EditLog | FE 元数据变更日志，BDB JE 复制 |

**参考资料**：

- [Apache Doris 官方文档](https://doris.apache.org/docs)
- [Cascades Framework for Query Optimization](https://15721.courses.cs.cmu.edu/spring2019/papers/16-optimizer1/xu-columbia-1998.pdf)（Nereids 理论基础）
- [ClickHouse IFunction](https://github.com/ClickHouse/ClickHouse)（向量化函数设计来源）
