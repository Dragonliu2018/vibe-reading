---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Overview"
date: "2026-08-23T18:20:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "Java", "C++", "MPP", "OLAP", "向量化执行"]
description: "Apache Doris 4.1.3 源码架构解读：FE(Java) 元数据/优化/协调 + BE(C++) Pipeline 向量化执行/列存引擎的 MPP 分析型数据库。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v4.1.3 · **协议** Apache-2.0 · **语言** Java 17 / C++20 · **代码量** ~157 万行（FE ~89.6 万 Java + BE ~68 万 C++）· **仓库** [GitHub](https://github.com/apache/doris)

---

## 总览

### 项目简介

**Apache Doris** 是一个基于 MPP（Massively Parallel Processing）架构的易用、高性能、实时分析型数据库。它在海量数据下只需亚秒级响应即可返回查询结果，既能支撑高并发点查，也能支撑高吞吐复杂分析。这使得 Doris 适用于报表分析、Ad-hoc 查询、统一数据仓库、数据湖查询加速等场景，用户可在其上构建用户行为分析、AB 测试平台、日志检索、用户画像、订单分析等应用。

Doris 采用经典的 **FE（Frontend，Java）+ BE（Backend，C++）** 分离架构：FE 负责元数据管理、SQL 解析优化、查询协调调度、导入事务编排；BE 负责向量化执行引擎、列存存储引擎、表达式与函数求值、文件格式读写。FE 之间通过 BDB JE 复制实现元数据高可用，FE 与 BE 之间通过 gRPC/Thrift 通信下发执行计划、回传结果。

**项目边界**：Doris 负责分析型（OLAP）数据的存储与查询，**不**承担在线事务（OLTP）的强一致行级读写职责；它通过 Unique 模型 + MoW（Merge-on-Write）提供近实时的更新能力，但本质仍是面向分析的列存仓库，而非行存事务库。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| MySQL 协议接入 | `fe/.../mysql/MysqlServer.java` | 兼容 MySQL 协议，JDBC/BI 工具直连 |
| CBO 查询优化 | `fe/.../nereids/` | Nereids 新一代 Cascades 优化器 |
| Pipeline 向量化执行 | `be/src/exec/pipeline/` | Pull 模型 DAG、Block 批处理、SIMD |
| MergeTree 列存 | `be/src/storage/` | Tablet/Rowset/Segment 段存储 + MVCC |
| 实时导入 | `fe/.../load/` | Stream Load / Routine Load / Broker Load |
| 联邦查询 | `fe/.../datasource/` | Hive/Iceberg/Hudi/Paimon/JDBC 外部 Catalog |
| 存算分离 | `cloud/src/` | Cloud 模式 meta-service + 对象存储 |
| 副本自均衡 | `fe/.../clone/` | TabletScheduler + Rebalancer |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Java 17 | 核心（FE） | FE 全部逻辑，JVM 运行 |
| C++20 | 核心（BE） | BE 执行与存储引擎 |
| ANTLR4 | 核心 | Nereids SQL 词法/语法解析器生成 |
| BDB JE | 核心 | FE 元数据复制与选主（Paxos 变体） |
| Thrift / Protobuf | 核心 | FE↔BE RPC 接口定义与序列化 |
| brpc | 核心 | BE 间及 FE↔BE 高性能 RPC |
| Arrow / Parquet / ORC | 核心 | 外部数据湖格式读写 |
| Caffeine | 可选 | 外部 Catalog 元数据缓存 |

### 版本历史

Doris 4.x 是面向"统一分析"的重大演进线。4.0 系列确立了 Nereids 优化器为默认查询路径、Pipeline 拉模型执行引擎全面替代旧 Volcano push 模型；4.1 系列在此基础上持续打磨——4.1.0 引入存算分离 Cloud 模式的稳定能力，4.1.1/4.1.2 完善联邦数据源（Paimon/Iceberg）与 MoW Unique 表性能。**4.1.3**（解读基线 commit `7126cf65d96`，2026-07-08）是 4.1 线的维护版本，在优化器规则、Pipeline 调度、存储 Compaction 稳定性上做收敛。

---

## 快速上手

最快看到 Doris 跑起来的方式是 Docker：

```bash title="快速启动（Docker）"
docker run -itd \
  -p 8030:8030 -p 9030:9030 \
  -e FE_SERVERS="fe1:172.20.80.2:9010" \
  selectdb/doris.fe-ubuntu:4.1.3
docker run -itd \
  -p 8040:8040 \
  -e FE_SERVERS="fe1:172.20.80.2:9010" \
  selectdb/doris.be-ubuntu:4.1.3
```

端到端验证（MySQL 客户端连 9030）：

```sql title="验证示例"
mysql -h 127.0.0.1 -P 9030 -uroot
CREATE DATABASE demo;
USE demo;
CREATE TABLE t (id INT, name VARCHAR(32)) DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 1;
INSERT INTO t VALUES (1, "doris");
SELECT * FROM t;   -- 返回 (1, "doris") 即证明跑通
```

源码构建（开发）：根目录 `sh build.sh --fe --be --clean` 编译，`bin/start_fe.sh` / `bin/start_be.sh` 启动。

---

## 架构设计解析

### 系统架构

Doris 的架构思想是 **"协调与执行分离、元数据与数据分离、计算向量化"**：FE 只做调度不碰数据流，BE 只做执行不持元数据；元数据靠 EditLog/BDBJE 保证强一致，数据靠 Tablet 多副本保证可靠；执行引擎全链路以 `Block`（列式批）为单位流转，减少虚函数调用、利用 SIMD。

![Doris 分层架构](/vibe-reading/images/articles/doris-internals/architecture.svg)

系统自上而下分为三大块。**FE（Java）** 分四层：接入协议层（`MysqlServer` 基于 Xnio NIO 监听 9030、`HttpServer` 承载 Stream Load 与 REST、Arrow Flight SQL 提供列式高速通道）接收客户端请求；查询引擎层（`Nereids` 优化器做 SQL→物理计划、`Coordinator` 做两阶段 Fragment 调度、`StmtExecutor` 作为执行入口）把 SQL 编译成可分发计划；元数据与管控层（`Env` 服务定位器装配 80+ 子服务、`Catalog` 管理表/分区/Tablet、`Load` 编排导入事务、`TabletScheduler` 调度副本均衡）；持久化层（`EditLog` WAL + `BDBJE` 选主 + Image Checkpoint）。FE 与 BE 之间用 gRPC 通信，核心 RPC 为 `exec_plan_fragment`（下发计划）、`fetch_data`（流式拉取结果）、`cancel_plan_fragment`（取消）。

**BE（C++）** 也分四层：服务接入层（`InternalService` 基于 brpc 接收 Fragment、`BackendService` Thrift 心跳）；执行引擎层（`Pipeline`/`Operator` DAG 编译、`PipelineTask` 受 MLFQ 多核 Work Stealing 调度、`RuntimeFilter` 从 build 侧下推到 scan 侧）；表达式与运行时层（`VExpr`/`IFunction` 向量化求值、`Block`/`Column`（COW）列存载体、`ExecEnv`/`MemTracker` 服务定位与内存分级）；存储与 IO 层（`Tablet`/`Rowset`/`Segment` MergeTree 段存 + `Compaction`、`FileSystem` 抽象 S3/HDFS/本地 + `Parquet`/`ORC` Reader 谓词下推）。最底层是物理存储后端——本地磁盘、S3/HDFS 对象存储、或 Hive/Iceberg 等数据湖。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| FE 接入协议 | `fe/fe-core/.../mysql/`、`httpv2/` | 隔离外部协议，保护核心不受协议变化影响 |
| FE 查询引擎 | `fe/fe-core/.../nereids/`、`qe/` | 把 SQL 编译成可分发执行计划，协调多 BE |
| FE 元数据与管控 | `fe/fe-core/.../catalog/`、`load/`、`clone/` | 强一致元数据 + 导入/副本事务编排 |
| FE 持久化 | `fe/fe-core/.../persist/`、`journal/` | WAL + 快照二级持久化，Master-Follower HA |
| BE 服务接入 | `be/src/service/`、`cloud/` | 接收 RPC，反序列化计划，装配执行上下文 |
| BE 执行引擎 | `be/src/exec/`、`pipeline/` | 向量化 Pull 模型执行，时间片调度 |
| BE 表达式与运行时 | `be/src/exprs/`、`core/`、`runtime/` | 列存数据载体 + 表达式求值 + 内存管控 |
| BE 存储与 IO | `be/src/storage/`、`io/`、`format/` | 列存段存储 + 多后端文件读写 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Env.java`、`ExecEnv` | 无 DI 框架，全局单例 getter 简化跨模块依赖获取 |
| Cascades 优化器 | `nereids/memo/Memo.java`、`jobs/cascades/` | 等价计划探索 + 代价驱动选择，支撑复杂 Join Reorder |
| 拉模型 Pipeline | `be/src/exec/pipeline/pipeline_task.cpp` | 阻塞算子显式化为独立 Pipeline，支持时间片与异步等待 |
| 模板方法 | `io/fs/file_system.h`、`format/generic_reader.h` | 基类定骨架、子类填步骤，统一 IO/Reader 接口 |
| COW（写时复制） | `core/cow.h`、`core/column/column.h` | 共享只读零拷贝、独占改写才克隆，向量化批处理省内存 |
| WAL + Image | `persist/EditLog.java`、`master/Checkpoint.java` | 日志增量 + 快照全量，避免回放无限与重启慢 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Env` | FE 服务定位器，装配所有子服务 | FE 进程级单例 | 持有 CatalogMgr/LoadManager/TabletScheduler 等 |
| `OlapTable` | OLAP 表元数据（列/分区/分布/KeysType） | 元数据级，随 DDL 变更 | 含多个 `Partition` |
| `Tablet` | 数据分片，多副本分布在 BE | 表创建时生成，Drop 时删除 | 属于 `Partition`，含多个 `Rowset` |
| `Rowset` | 不可变版本数据集（一组 Segment） | 导入生成，Compaction 合并 | 属于 `Tablet`，带 `Version` |
| `Segment` | 列存段（一个 .dat 文件） | Rowset 写入时生成 | 属于 `Rowset`，含 `ColumnReader` |
| `Block` | 列式数据批（Column 集合） | 执行期临时，算子间流转 | BE 执行基本单位 |
| `PipelineTask` | Pipeline 一个并行实例 | 调度执行单元 | 属于 `Pipeline`，含 `Operator` 链 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `CatalogIf` | `datasource/CatalogIf.java` | `InternalCatalog`、`ExternalCatalog` 子类 | `CatalogMgr` 按 `logType` 实例化 |
| `Tablet` | `catalog/Tablet.java` | `LocalTablet`、`CloudTablet` | `EnvFactory` 按 Cloud 模式选择 |
| `VExpr` | `exprs/vexpr.h` | `VectorizedFnCall`、`VSlotRef`、`VLiteral` | `create_tree_from_thrift` 从 TExpr 构建 |
| `IFunction` | `exprs/function/function.h` | 各标量函数子类 | `SimpleFunctionFactory` 注册表 |
| `IAggregateFunction` | `exprs/aggregate/aggregate_function.h` | 各聚合函数子类 | `AggregateFunctionSimpleFactory` |
| `FileSystem` | `io/fs/file_system.h` | `LocalFileSystem`、`S3FileSystem` 等 | `FileFactory` 按 `TFileType` 创建 |
| `OperatorXBase` | `exec/operator/operator.h` | `OlapScanOperatorX`、`HashJoinProbeOperatorX` 等 | `PipelineFragmentContext._create_operator` switch |

---

## 代码目录

```
doris/
├── be/                     # Backend (C++)
│   └── src/
│       ├── storage/        # 存储引擎 (147k 行)：Tablet/Rowset/Segment/Compaction
│       ├── exec/           # 执行引擎 (106k)：pipeline/scan/sink/sort/exchange
│       ├── exprs/          # 表达式与函数 (117k)：VExpr/IFunction/IAggregateFunction
│       ├── core/           # 列存类型 (63k)：Block/Column/DataType
│       ├── runtime/        # 运行时 (27k)：ExecEnv/RuntimeState/MemTracker
│       ├── io/             # 文件系统 (30k)：Local/S3/HDFS/Broker
│       ├── format/         # 文件格式 (41k)：Parquet/ORC/CSV/JSON/Native
│       ├── service/        # 服务接入 (24k)：doris_main/internal_service/brpc
│       └── cloud/          # 云原生 (23k)：CloudStorageEngine
├── fe/
│   └── fe-core/src/main/java/org/apache/doris/
│       ├── nereids/        # Nereids 优化器 (381k)：parser/jobs/memo/rules
│       ├── catalog/        # 元数据 (50k)：Env/OlapTable/Tablet
│       ├── qe/             # 查询执行 (30k)：Coordinator/StmtExecutor
│       ├── datasource/     # 联邦数据源 (82k)：ExternalCatalog/ExternalTable
│       ├── load/           # 数据导入 (19k)：loadv2/routineload
│       ├── persist/        # 持久化 (13k)：EditLog/OperationType
│       └── mysql/          # MySQL 协议 (16k)：MysqlServer/MysqlProto
├── cloud/                 # Cloud meta-service (70k)：meta-service/recycler
├── regression-test/        # 回归测试套件
└── gensrc/                # Thrift/Protobuf IDL 定义
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/doris-internals/module-dependencies.svg)

Doris 的模块依赖呈"双枢纽"结构：FE 侧 `Catalog` 元数据是公共依赖（Nereids/QE/Load/DataSource 都要读表元数据），BE 侧 `列存类型与运行时`（Block/Column/ExecEnv）是公共依赖（执行/表达式/存储/IO 都基于它）。FE 与 BE 之间通过 gRPC 解耦——`QE` 调度计划到 `Pipeline 执行引擎`，`Load` 下发写入到 `存储引擎`，`DataSource` 的外部表 Scan 下推到 `文件格式与 IO`。这种分层让 FE/BE 可独立演进、独立部署。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Nereids 优化器 | SQL→物理计划，Cascades CBO | `NereidsPlanner.plan` | 优化是独立决策域，规则与代价模型自成体系 | [Nereids 优化器](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/01-nereids) |
| Catalog 元数据 | 元数据管理 + Env 服务定位 | `Env.getCurrentEnv` | 元数据需强一致，与执行逻辑关注点正交 | [Catalog 元数据](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/02-catalog) |
| 查询协调 QE | MySQL 协议 + Fragment 调度 | `StmtExecutor.execute` | 协议接入与分布式调度是独立关注点 | [查询协调 QE](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/03-qe) |
| 数据导入 Load | Stream/Routine/Broker 导入 | `LoadManager.createLoadJob` | 导入是独立事务编排域，与查询路径不同 | [数据导入 Load](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/04-load) |
| 联邦数据源 | 外部 Catalog 联邦查询 | `CatalogMgr.getCatalog` | 外部系统元数据/缓存策略与内部表不同 | [联邦数据源](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/05-datasource) |
| 存储引擎 | Tablet/Rowset/Segment 列存 | `StorageEngine.open` | 段存储 + Compaction 是独立存储域 | [存储引擎](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/06-storage) |
| Pipeline 执行引擎 | 向量化 Pull 模型 DAG | `PipelineFragmentContext.prepare` | 执行调度模型独立于算子实现 | [Pipeline 执行引擎](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/07-pipeline) |
| 表达式与函数 | VExpr 树 + 向量化函数 | `VExpr.create_tree_from_thrift` | 函数库与求值机制自成体系 | [表达式与函数](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/08-exprs) |
| 列存类型与运行时 | Block/Column/ExecEnv | `ExecEnv::GetInstance` | 数据载体与运行时基础设施为全 BE 共享 | [列存类型与运行时](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/09-core-runtime) |
| 文件格式与 IO | FileSystem + Parquet/ORC | `FileFactory.create_file_reader` | 多后端 IO 与格式解析独立于存储引擎 | [文件格式与 IO](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/10-format-io) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

FE 启动（`DorisFE.main` in `fe/.../DorisFE.java:98`）：

```
DorisFE.main → DorisFE.start
  ├─ Env 配置加载（Config.java + LdapConfig）
  ├─ Env.getCurrentEnv() 装配：构造函数 new CatalogMgr/Alter/TabletScheduler/EditLog... (Env.java:716)
  ├─ Env.startMeta()：loadImage 读 Image + replayJournal 回放 EditLog (Env.java:2285/3183)
  ├─ BDBEnvironment.setup：创建 ReplicatedEnvironment，选主 (BDBEnvironment.java:100)
  ├─ transferToMaster / transferToNonMaster：按角色启动 daemon 线程
  │    Master：publishVersionDaemon / TabletScheduler / Checkpoint / LoadScheduler
  │    Follower：Replayer 回放日志
  ├─ QeService.start → MysqlServer.start (监听 9030)
  └─ HttpServer.start (监听 8030)
```

BE 启动（`doris_main` in `be/src/service/doris_main.cpp`）：

```
doris_main
  ├─ Daemon::init：信号处理、配置加载
  ├─ ExecEnv::init()：装配 BE 全部子服务（exec_env_init.cpp）
  │    StorageEngine / FragmentMgr / TaskScheduler / ScannerScheduler / Brpc...
  ├─ StorageEngine::open()：加载磁盘 DataDir、恢复 Tablet、启动后台线程
  │    Compaction 生产 / unused_rowset GC / garbage_sweep
  ├─ BackendService::init：注册 Thrift 心跳回调
  └─ brpc 启动 internal_service / http_service 监听
```

对象装配的关键：FE 的 `Env` 是单例，构造函数集中 `new` 80+ 子服务，各模块通过 `Env.getCurrentEnv().getXxx()` 获取依赖；BE 的 `ExecEnv::GetInstance()` 同理，`init()` 时装配 `StorageEngine`、`FragmentMgr`、`TaskScheduler` 等。配置来自 `fe/conf/fe.conf` 与 `be/conf/be.conf`，覆盖优先级为配置文件 < 环境变量 < 命令行。

### 核心运行流程

下面三条链路覆盖了 Doris 最核心的运行模式：查询、导入、副本修复。

#### 查询：SELECT 端到端

业务流程：客户端发 SQL → FE 解析优化 → 分发 Fragment 到 BE → BE 向量化执行读列存 → 流式回传结果。

![SELECT 查询端到端数据流](/vibe-reading/images/articles/doris-internals/data-flow.svg)

数据流从 `StmtExecutor.executeByNereids` 出发：`NereidsParser` 把 SQL 文本经 ANTLR4 解析为 `LogicalPlan`（`UnboundRelation`/`UnboundSlot`）；`Analyzer` 绑定元数据（`UnboundRelation` → `LogicalOlapScan`）；`Rewriter` 跑 13 组启发式规则（谓词下推、列裁剪、子查询解嵌）；`Optimizer` 在 `Memo`/`Group`/`GroupExpression` 上做 Cascades CBO，基于统计与代价选 `PhysicalPlan`；`PhysicalPlanTranslator` + `DistributePlanner` 把物理计划翻译成 `PlanFragment` 树并分配到具体 BE（`DistributedPlan`）。随后 `Coordinator.toThrift` 序列化为 `TPipelineFragmentParams`，经 gRPC `exec_plan_fragment` 下发。

BE 侧 `InternalService` 接收后交给 `FragmentMgr`，`PipelineFragmentContext.prepare` 把 `TPlanNode` 树编译成 `Pipeline`/`Operator` DAG 并构建 `PipelineTask`，提交 `HybridTaskScheduler`。`PipelineTask.execute` 以 Pull 模型从 root 算子拉 `Block`：`OlapScanOperator` → `BlockReader` 读 `Rowset`/`Segment` 列存产出 `Block`（列式 4096 行），经中间算子（`Filter`/`Project`/`Agg`/`Join`）用 `VExpr` 向量化求值变换，最终由 `ResultSinkOperator` → `VMysqlResultWriter` 入 `ResultBlockBuffer`。FE 通过 `fetch_data` BRPC 流式拉取 `RowBatch`，`StmtExecutor` 循环 `sendOnePacket` 把行包发回 MySQL 客户端。关键设计：FE 不碰数据流只做调度，数据在 BE 间以 `Block` 列式流转，结果流式拉取而非一次性返回。

#### 导入：Stream Load 实时写入

业务流程：HTTP POST 数据 → FE 选 BE 并生成计划 → BE 直写 MemTable → flush Rowset → 事务提交可见。

Stream Load 走 HTTP 307 重定向——`LoadAction.streamLoad` 选一个 BE，重定向客户端数据流直连 BE（FE 不接触数据，避免成为瓶颈）。BE 收到数据后调 `streamLoadPut` RPC 回 FE，`StreamLoadHandler.generatePlan` 用 `NereidsStreamLoadPlanner` 生成 `TPipelineFragmentParams` 并把表注册到事务，返回给 BE。BE 执行写入：`DeltaWriter.write` → `MemTable.insert` 累积行，达阈值 `MemTable.to_block` 排序+聚合后 `RowsetWriter.flush_memtable` 刷成 `Segment` 文件。所有 MemTable flush 完成后 `Rowset::make_visible(version)` 设版本号、`Tablet.add_inc_rowset` 加入版本图，最后 BE 发 `commitTxn` 给 FE，`GlobalTransactionMgr` 提交事务，`LoadJob.afterCommitted` → `afterVisible` 推进状态到 FINISHED。关键设计：Label 幂等去重保证 at-least-once 下不重复导入。

#### 副本修复：TabletScheduler 调度

业务流程：TabletChecker 定期体检 → 不健康 Tablet 入队 → TabletScheduler 调度 Clone 任务 → BE 间拷数据。

`TabletChecker` 周期检查所有 Tablet 的 `TabletStatus`（`REPLICA_MISSING`/`VERSION_INCOMPLETE`/`REDUNDANT`/`COLOCATE_MISMATCH`），不健康的加入 `TabletScheduler` 优先级队列。`TabletScheduler` 按优先级和调度策略选 Tablet，通过 BE 的 clone 任务从健康副本拷数据到目标 BE 修复副本数；`Rebalancer`（`BeLoadRebalancer`/`PartitionRebalancer`/`DiskRebalancer`）负责跨 BE 负载均衡。`TabletInvertedIndex` 维护 `tabletId↔(backendId↔Replica)` 双向倒排，BE tablet report 时快速比对。

### 状态流

![核心状态机](/vibe-reading/images/articles/doris-internals/state-flow.svg)

Doris 有两个关键状态机。**LoadJob 状态机**（`loadv2/JobState.java`）：`PENDING` → `LOADING` → `COMMITTED` → `FINISHED`，由事务回调驱动——`afterCommitted`（txn 已提交）推进到 COMMITTED，`afterVisible`（txn 可见）推进到 FINISHED；任何阶段 `afterAborted` 或 `cancelJob` 转 `CANCELLED`。状态定义在 `loadv2/LoadJob.java` 的 `unprotectedUpdateState`，finalState 不可逆。

**PipelineTask 状态机**（`pipeline_task.h`）：`INITED` → `RUNNABLE` → `BLOCKED` → `FINISHED` → `FINALIZED`。`submit` 后进 RUNNABLE；执行中 `_is_blocked` 检查读写依赖未就绪则转 BLOCKED，上游 `Dependency.set_ready` 唤醒回 RUNNABLE（形成回环）；`eos` 后转 FINISHED，`close` 后 FINALIZED。状态由 `pipeline_task.cpp` 的 `_exec_state` 原子管理，三阶段阻塞检查（`_wait_to_start`/`_is_blocked`/`_is_pending_finish`）覆盖执行前/中/后。

---

## 典型修改场景

#### 场景 1：新增一条 Nereids 优化规则

需改：`nereids/rules/rewrite/` 新建 Rule 类实现 `RewriteRuleFactory`（DSL 定义 pattern+transform）；`nereids/rules/RuleType.java` 加枚举；`nereids/jobs/executor/Rewriter.java` 在合适 `topic()` 注册（位置很关键，规则间有依赖）。若是 CBO 探索规则则注册到 `RuleSet.EXPLORATION_RULES`。

#### 场景 2：新增一个 BE 物理算子

需改：`be/src/exec/operator/` 新建 `XxxOperatorX`（继承 `OperatorX`/`StreamingOperatorX`/`StatefulOperatorX`，实现 `get_block_impl`）；若是 blocking 算子还需 `XxxSinkOperatorX` + `SharedState`（`dependency.h`）；`be/src/exec/pipeline/pipeline_fragment_context.cpp` 的 `_create_operator` switch 加 `TPlanNodeType` 分支；`CMakeLists.txt` 加文件。对应测试：`regression-test/suites/`。

#### 场景 3：新增一种外部 Catalog（如 Delta Lake）

需改：`fe/.../datasource/InitCatalogLog.java` 加 `Type` 枚举；`CatalogFactory.createCatalog` switch 加分支；`ExternalCatalog.buildDbForInit` switch 加实例化；新建 `delta/` 子目录实现 `DeltaExternalCatalog`/`DeltaExternalDatabase`/`DeltaExternalTable`/`DeltaExternalMetaCache`；`ExternalMetaCacheMgr.registerBuiltinEngineCaches` 注册；`PhysicalPlanTranslator.visitPhysicalFileScan` 加 ScanNode 分支。对应测试：`regression-test/suites/external/`。

---

## 测试体系

```
regression-test/
├── suites/               # 端到端 SQL 回归测试（pytest 驱动）
│   ├── nereids_p0/       # Nereids 优化器规则
│   ├── query_p1/         # 查询正确性
│   ├── point_query_p0/   # 点查
│   ├── schema_change_p2/ # 表结构变更
│   ├── cloud_p1/         # 存算分离
│   └── ...
├── framework/            # 测试框架（连接、断言、数据生成）
└── data/                 # 测试数据与期望结果
be/test/                  # BE 单元测试（GTest）
fe/fe-core/src/test/      # FE 单元测试（JUnit）
```

| 代码层 | 测试类型 |
| --- | --- |
| Nereids 规则/优化 | `nereids_p0` SQL 回归 + FE JUnit |
| 存储引擎/Compaction | `be/test/storage` GTest + `schema_change_p2` |
| 执行算子 | `be/test/exec` GTest + `query_p1` |
| 导入 | `load_p0` / `routineload_p0` |

想理解某个算子或规则，优先看 `regression-test/suites/` 下对应用例——它们是可执行的规格说明。

---

## 阅读源码推荐路线

- **第一遍：理解查询主流程**
  `fe/.../qe/StmtExecutor.java` 的 `executeByNereids` → `nereids/NereidsPlanner.java` 的 `plan` → `qe/NereidsCoordinator.java` 的 `exec` → `be/src/exec/pipeline/pipeline_task.cpp` 的 `execute` → `be/src/exec/scan/olap_scanner.cpp` 的 `_get_block_impl`
- **第二遍：理解元数据与持久化**
  `fe/.../catalog/Env.java` 的字段定义与构造函数 → `catalog/OlapTable.java` → `persist/EditLog.java` 的 `logCreateTable` → `master/Checkpoint.java` 的 `doCheckpoint`
- **第三遍：理解存储引擎**
  `be/src/storage/storage_engine.h` → `be/src/storage/tablet/tablet.h` 的 `capture_rs_readers` → `be/src/storage/rowset/rowset.h` → `be/src/storage/segment/segment.h` → `be/src/storage/compaction/compaction.h`
- **第四遍：选择重点子模块深入阅读**（见上方模块地图的「深入阅读」链接）

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| FE / BE | Frontend（Java 调度）/ Backend（C++ 执行存储） |
| Tablet | 数据分片，Doris 数据分布与副本的基本单位 |
| Rowset | 一次导入产生的不可变数据集，带版本号 |
| Segment | Rowset 内的列存段，对应一个 .dat 文件 |
| MoW / MoR | Merge-on-Write（写时合并）/ Merge-on-Read（读时合并），Unique 表的两种实现 |
| EditLog | 元数据 WAL，先写日志再改内存 |
| Nereids | 新一代 Cascades CBO 优化器，替代旧 analysis/planner |
| Pipeline | 拉模型执行 DAG，把物理计划按阻塞点切分为可并行流水线 |

### 参考资料

- [Apache Doris 官方文档](https://doris.apache.org/docs/)
- [Cascades 优化器框架](https://15721.courses.cs.cmu.edu/spring2019/papers/15-optimizer1/p209-graefe.pdf)
- [ORCA 代价与 Enforcer 论文](https://15721.courses.cs.cmu.edu/spring2019/papers/15-optimizer2/p29-soliman.pdf)
