---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "Overview"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "Java", "C++", "MPP", "向量化", "Cascades 优化器", "存算分离", "数据湖"]
description: "StarRocks 源码解读总览：FE/BE 双端架构、Cascades 优化器、向量化 Pipeline 执行、Tablet 存储与存算分离。"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** main-2026-08 · **解读基线** commit [`3d21fd1efbe`](https://github.com/StarRocks/starrocks/commit/3d21fd1efbea1197e729212c505e1d7c38713b3d)（2026-08-21，开发分支快照，无对应 release tag；最近 release tag 4.1.4 落后 1556 commits）· **协议** Apache-2.0（ELv2 部分附加条款）· **语言** Java（FE）+ C++（BE）· **代码量** FE ~155 万行 Java + BE ~123 万行 C++/H · **仓库** [GitHub](https://github.com/StarRocks/starrocks)

---

## 总览

### 项目简介

StarRocks 自称"the world's fastest open query engine for sub-second, ad-hoc analytics both on and off the data lakehouse"——面向湖仓之上与湖仓之外的亚秒级 ad-hoc 分析型查询引擎，Linux Foundation 项目。它脱胎于 Apache Doris（源码文件头仍保留 lineage 注释，`GlobalStateMgr.java` 与 `LocalMetastore.java` 等骨架类与 Doris 同源），但走出了一条差异化的技术路线：

- **全面向量化**：BE 从内存格式（`Column`/`Chunk`）到算子到文件格式全链路列式批量处理，README 宣称多维分析比上一代系统快 5-10 倍；
- **Cascades CBO**：FE 用 `sql/optimizer`（15.6 万行，全仓库最大 Java 包）实现了 Orca 风格的 Memo/Group 搜索框架，而不是 Doris 早期那种手工 rewrite + 有限规则的老 planner；
- **原生存算分离**：3.0 起 shared-data 架构成为一等公民——`LakeTable`/`LakeTablet` 与 StarOS 集成，数据与 tablet 元数据全部落对象存储，CN（Compute Node）无盘计算；
- **湖仓直查**：`connector/` 体系（FE 73k 行 + BE 26k 行）覆盖 Hive/Iceberg/Hudi/Delta/Paimon/Fluss 等 13 种数据源，parquet 读取栈自研向量化。

**项目边界**：StarRocks 负责查询引擎与表存储本身——不负责通用资源调度（依赖 K8s 等外部编排做弹性伸缩）、不负责数据集成 ETL（Routine Load 只做 Kafka/Pulsar 到内表的管道，湖仓数据由外部引擎写入）；事务模型是为导入设计的短事务（`TransactionState` 五态），不是 OLTP 级别的长事务。

### 功能矩阵

| 特性 | 实现文件（侧） | 说明 |
| --- | --- | --- |
| MySQL 协议兼容 | `fe/.../mysql/nio/`、`qe/QeService`（FE） | xnio NIO 实现，9030 端口，BI 工具可直连 |
| Cascades CBO | `sql/optimizer/`（FE） | Memo/Group + 约 219 个 RuleType，DP/Greedy join reorder 自适应 |
| 向量化执行 | `be/src/column/`、`exec/pipeline/`（BE） | pull 模型 Operator 状态机 + 8 级反馈队列调度 |
| 主键表 upsert/delete | `storage/tablet_updates.cpp`、`primary_index.h`（BE） | DelVector + PrimaryIndex LSM 风格写路径 |
| 物化视图 | `catalog/MaterializedView.java` + `sql/optimizer/rule/transformation/materialization/`（FE） | 异步 MV + 查询透明改写（单表/多表/聚合补偿） |
| 湖仓直查 | `connector/`（FE+BE）、`formats/`（BE） | 13 种 ConnectorType，自研 parquet reader |
| 存算分离 | `lake/`、`staros/`（FE）+ `storage/lake/`、`compute_env/`（BE） | TabletMetadata 文件链 + StarOS shard + 对象存储 |
| 实时导入 | `load/`、`transaction/`（FE）+ `data_workflows/load/`（BE） | Stream Load / Routine Load / 事务三阶段提交 |
| 多租户资源隔离 | `qe/QueryQueueManager`（FE）+ workgroup（BE） | 查询队列 slot 估算 + BE 资源组 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| ANTLR 4 | 核心（FE） | SQL 词法语法（`fe/fe-grammar` 的 `StarRocks.g4`），生成 `StarRocksParser` |
| BDB JE | 核心（FE） | 元数据 WAL 复制与 Leader 选举（`journal/bdbje/`） |
| brpc | 核心（BE） | FE↔BE 计划下发、BE↔BE chunk 传输（`internal_service.proto`） |
| Thrift | 核心 | 控制面协议（`BackendService.thrift` 计划序列化 `TExecPlanFragmentParams`） |
| protobuf | 核心 | 数据面消息 + lake 元数据（`lake_types.proto`） |
| StarOS（starlet） | 核心（shared-data） | shard 管理与对象存储寻址（`be/src/compute_env/staros/`） |
| glog / gflags / jemalloc | 核心（BE） | 日志 / 配置 / 内存分配（`mem_hook.cpp` 内存追踪挂钩） |
| Arrow C++（部分移植） | 可选（BE） | 仅移植 parquet FileMetaData 解析，运行时不依赖 libarrow |
| Apache ORC（vendor） | 核心（BE） | 完整 vendor 进 `formats/orc/apache-orc/` |
| Caffeine | 核心（FE） | MV plan context / 统计信息缓存 |

### 版本历史

StarRocks 版本主线是 1.x（共享 Doris 血统的向量化重写）→ 2.x（Cascades 优化器、主键表成熟）→ **3.0（shared-data 存算分离，架构分水岭）**→ 3.x/4.x（湖仓深化、异步 MV 改写、pipeline spill、Arrow Flight）。本解读基于 main 分支 2026-08 快照（`3d21fd1efbe`），它领先 4.1.4 release 约 1556 个 commit，包含若干未发布进行时重构：BE 侧拆出了 `exec_primitive`/`connector_primitive`/`storage_primitive` 原语层与 `orchestration`/`data_workflows` 新顶层目录，FE 侧 Coordinator 已重构为 `qe/scheduler/` 子包。

---

## 快速上手

源码阅读者的最快路径（Docker 开发环境，免本地装 thirdparty）：

```bash
git clone https://github.com/StarRocks/starrocks.git
cd starrocks

# 起一个带全套构建依赖的容器（挂载仓库与 maven 缓存）
docker compose -f docker-compose.dev.yml up -d starrocks-dev
docker exec -it starrocks-dev-env bash

# 容器内分别构建两端
./build.sh --fe          # FE（maven，产出 fe/output/metadatafe.tar.gz）
./build.sh --be          # BE（cmake + thirdparty，产出 be/output/
```

端到端验证（单机伪集群）：构建产物解压后，先 `sh bin/start_fe.sh daemon` 启动 FE，再 `sh bin/start_be.sh daemon` 启动 BE，用 `mysql -h 127.0.0.1 -P9030 -uroot` 连入后 `SHOW PROC / backends;` 确认 BE 心跳上报 alive 为 true，然后建表插数查询：

```sql
CREATE TABLE t (k INT, v DOUBLE) DISTRIBUTED BY HASH(k) BUCKETS 1 PROPERTIES ("replication_num"="1");
INSERT INTO t VALUES (1, 1.0);
SELECT sum(v) FROM t;    -- 返回 1.0，链路通了
```

单测入口：`./run-fe-ut.sh`（JUnit，`fe/fe-core/src/test` 2015 个文件）、`./run-be-ut.sh`（GTest，`be/test` 938 个文件）、SQL 回归测试在 `test/`（193 个用例目录，`python3 test/run.py -v`）。

---

## 架构设计解析

### 系统架构

StarRocks 的架构思想是"**用两个进程角色切分控制面与数据面，用存储模式切分部署形态**"：FE（Java）独占元数据、SQL 前端与全局协调，多个 FE 之间用 BDBJE 复制元数据并选主；BE/CN（C++）独占执行与存储，节点间用 brpc 直传数据。部署形态在两种 RunMode 间切换——shared-nothing（BE 带盘，三副本）与 shared-data（CN 无盘，数据在对象存储），**同一套 BE 二进制按 `RunMode` 走不同代码路径**（`be/src/storage/lake/tablet.h` 的 `lake::Tablet` 与本地 `OlapTablet` 同继承 `BaseTablet`）。

![StarRocks 分层架构](/vibe-reading/images/articles/starrocks-internals/architecture.svg)

自上而下四层。**客户端层**通过 MySQL 协议（9030）、HTTP（Stream Load）、Arrow Flight SQL 三种入口接入。**FE 层**内部按职责切成四块：协议接入（`QeService` + `ConnectProcessor`）、SQL 引擎（parser→analyzer→optimizer→plan 流水线）、元数据与 HA（`GlobalStateMgr` 聚合 + EditLog/BDBJE 复制）、Connector（外部 catalog 元数据）。**BE 层**依据仓库自己的 `be/module_boundary_manifest.json`（模块边界清单，CI 强制执行）分为服务层（`service/` RPC 入口与守护）、执行层（`exec/pipeline`）、数据层（`column`/`storage`/`formats`/`connector`）、基础层（`common`/`base`/`gutil`/`runtime`）。**存储层**按部署形态落在本地盘、对象存储或外部数据湖。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 客户端接入 | `fe/.../mysql/nio/`、`http/`、ArrowFlightSqlService | 隔离外部协议，让 SQL 引擎不感知 MySQL/HTTP/Flight 差异 |
| SQL 引擎 | `fe/.../sql/`（parser/analyzer/optimizer/plan） | 把文本变成最优物理计划，是 FE 的价值核心 |
| 元数据与 HA | `fe/.../server/`、`catalog/`、`persist/`、`journal/`、`ha/` | 单一真源的全局元数据 + 多 FE 副本一致性 |
| 外部数据接入 | `fe/.../connector/` + `be/src/connector/` | 把湖仓元数据映射成可查询对象 |
| BE 服务层 | `be/src/service/`、`agent/`、`http/` | 承接 RPC、心跳上报、生命周期装配 |
| BE 执行层 | `be/src/exec/`、`exec_primitive/`、`orchestration/` | 计划到算子的翻译与非阻塞调度 |
| BE 数据层 | `be/src/column/`、`storage/`、`formats/` | 列式内存格式、段存储与文件编解码 |
| BE 基础层 | `be/src/common/`、`base/`、`gutil/`、`runtime/` | Status/内存追踪/线程原语，被所有上层依赖 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `server/GlobalStateMgr.getCurrentState()`（被 import 676 次） | 单进程内存元数据模型下免 DI 框架，代价是 3484 行 god class（社区正逐步拆出 NodeMgr/LocalMetastore） |
| Memo + 显式任务栈 | `sql/optimizer/task/TaskScheduler.java` 的 `Stack<OptimizerTask>` | Cascades 递归展开改成可中断、可超时检查的迭代循环 |
| WAL Applier | `LocalMetastore.createTable` 的 `editLog.logCreateTable(info, wal -> db.registerTableUnlocked(table))` | 写路径与 Follower 回放共用同一 mutate lambda，消除双份代码漂移 |
| Copy-on-Write | `common/cow.h`（`Column` 基类）；`TransactionState` 状态变更 | 只读共享零拷贝，写时才 clone——查询中列共享是常态 |
| 非阻塞状态机 | `exec_primitive/pipeline/operator.h` 的 `has_output()/need_input()/pull_chunk/push_chunk` | 数千 driver 共享线程池，任何阻塞调用都会钉死线程 |
| 枚举注册表 + 反射工厂 | `connector/ConnectorType.java` + `ConnectorFactory`；BE 侧 `connector_bootstrap.cpp` | 新数据源接入面收敛到一处清单 |
| 状态机 + 回调 | `TransactionState.beforeStateTransform/afterStateTransform`；FE `StateChangeExecutor` | 事务与角色转换的正确性靠钩子强制而非散落的约定 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `GlobalStateMgr` | FE 全局状态聚合器，挂约 80 个 Manager | FE 进程级单例 | 聚合 LocalMetastore/NodeMgr/LoadMgr/TabletScheduler 等 |
| `TransactionState` | 一次导入事务 | PREPARE→（PREPARED）→COMMITTED→VISIBLE/ABORTED | 归属 `DatabaseTransactionMgr`，驱动 `PublishVersionDaemon` |
| `Memo`/`Group` | Cascades 搜索空间 | 单次 `Optimizer.optimize()` | 含 `GroupExpression`，被 `TaskScheduler` 驱动 |
| `ExecPlan` | 物理计划 + `PlanFragment` 列表 | 单次查询 | 由 `PlanFragmentBuilder` 产出，交 `DefaultCoordinator` 部署 |
| `Chunk`/`Column` | 列式内存批与列 | 单个算子间传递 | `NullableColumn` 组合 null 位图，COW 共享 |
| `Rowset` | 不可变数据版本单元 | 写入后生成，compaction 合并后回收 | 聚合 `Segment` 列表，三态机管理加载 |
| `TabletUpdates` | 主键表可变状态容器 | 随 tablet | 持 `EditVersionInfo` 链、驱动 `PrimaryIndex`/`DelVector` |
| `LakeTablet` | 存算分离 tablet（id 即 StarOS shard id） | 对象存储上的 TabletMetadata 文件链 | FE 侧虚拟 Replica，BE 侧经 `LocationProvider` 寻址 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Optimizer` | `sql/optimizer/Optimizer.java` | `QueryOptimizer`/`ShortCircuitOptimizer`/`SPMOptimizer` | `OptimizerFactory.create()` 按场景分发 |
| `Coordinator` | `qe/scheduler/Coordinator.java` | `DefaultCoordinator`、`FeExecuteCoordinator` | `DefaultCoordinator.Factory` 7 族产品方法 |
| `Connector` | `connector/Connector.java`（FE） | Hive/Iceberg/JDBC 等 13 个子包类 | `ConnectorType` 枚举 + 反射构造 |
| `Connector`（BE） | `connector_primitive/connector.h` | `HiveConnector` 等 | `connector_bootstrap.cpp` 编译期注册 |
| `Operator` | `exec_primitive/pipeline/operator.h` | 全部物理算子 | 各 ExecNode 的 `decompose_to_pipeline` 内 new factory |
| `BaseTablet` | `storage/base_tablet.h` | `OlapTablet`（本地）/ `lake::Tablet`（云原生） | 由 `TabletManager`/StarOS shard 创建 |
| `Daemon`/`LeaderDaemon` | `common/util/Daemon.java` | 全部 FE 后台线程 | `startLeaderOnlyDaemonThreads()` 等分层启动 |
| `Journal` | `journal/Journal.java` | `BDBJEJournal`、`StarOSBDBJEJournalSystem` | `JournalFactory.create(nodeName)` |

---

## 代码目录

```shell
starrocks/
├── fe/                          # Java 前端（~155 万行）
│   ├── fe-core/                 # 主体：src/main/java/com/starrocks/ 下约 60 个包
│   │   ├── sql/                 # 266k 行：optimizer(156k)/analyzer/ast/parser/plan
│   │   ├── connector/           # 73k 行：13 种数据源外表元数据
│   │   ├── catalog/             # 59k 行：元数据对象模型
│   │   ├── qe/                  # 53k 行：MySQL 协议、StmtExecutor、Coordinator
│   │   ├── alter/ load/ planner/ statistic/ scheduler/ lake/ ...
│   │   └── server/              # GlobalStateMgr 服务定位器
│   ├── fe-grammar/              # ANTLR .g4 文法（StarRocks.g4）
│   ├── fe-parser/ fe-spi/ fe-server/ fe-testing/ fe-type/ fe-utils/
│   └── StarRocksFEServer.java   # FE 启动入口（fe/ 根下）
├── be/                          # C++ 后端（~123 万行 .cpp/.h）
│   └── src/
│       ├── storage/             # 175k 行：tablet/rowset/segment/primary index/compaction
│       │   └── lake/            # 存算分离（60+ 文件）
│       ├── exec/                # 88k 行：pipeline 执行引擎 + 算子
│       ├── exec_primitive/      # Operator/OperatorFactory/ExecNode 原语（从 exec 前移）
│       ├── exprs/               # 72k 行：向量化表达式
│       ├── formats/             # 42k 行：自研 parquet / vendor orc
│       ├── column/              # 38k 行：Column/Chunk 列式内存格式
│       ├── compute_env/         # 32k 行：starlet/starcache 等无盘执行环境
│       ├── connector/           # 26k 行：数据源 DataSource 抽象
│       ├── orchestration/       # FragmentExecutor/FragmentMgr 入口（新拆出）
│       ├── data_workflows/      # load/routine_load 执行器（新拆出）
│       └── service/             # starrocks_main.cpp + internal_service(brpc)
├── gensrc/                      # thrift/proto + functions.py 函数注册表（双端生成）
├── test/                        # SQL 集成测试（193 个用例目录）
├── conf/                        # fe.conf / be.conf / cn.conf
├── handbook/                    # 仓库内部架构知识（含 be/module_boundary_manifest.json）
└── java-extensions/             # JNI / external source 集成
```

`fe/` 下的模块正在从 Maven（`pom.xml` 仍在）向 Gradle（`build.gradle.kts`）迁移，两套并存。BE 的 `module_boundary_manifest.json` 是官方模块分层清单，`build-support/check_be_module_boundaries.py` 在 CI 里强制执行 include 边界。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/starrocks-internals/module-dependencies.svg)

依赖方向总体自上而下：QE 协调层驱动 SQL 引擎，SQL 引擎与 Load/Connector/存算分离都落到底层元数据；BE 侧服务层承接 RPC 后进入执行引擎，执行引擎消费向量化数据结构与 Tablet 存储。跨进程交互（黄色虚线）只有三类：FE→BE 的计划下发与心跳、Load 的导入管道、存算分离 FE 对 BE lake 路径的元数据委托。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| FE 骨架与服务 | 进程启动、GlobalStateMgr 聚合、守护线程 | `StarRocksFEServer.start()` | 全部 Manager 的装配点，独立于任何业务域 | [01](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/01-fe-server) |
| 元数据与 HA | 元数据对象模型、EditLog 复制、选举 | `GlobalStateMgr.transferToLeader()` | 一致性域——写路径与回放共用是它的独特约束 | [02](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/02-catalog-ha) |
| SQL 优化器 | Cascades CBO：Memo 搜索、规则、cost | `QueryOptimizer.optimize()` | 15.6 万行的最大包，自成一套搜索引擎 | [03](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/03-optimizer) |
| QE 查询协调 | 协议、会话、Coordinator 部署 | `StmtExecutor.execute()` | 从字节流到计划部署的胶水层，状态最杂 | [04](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/04-qe) |
| Connector 外表 | 湖仓元数据与 BE 扫描 | `ConnectorMgr.createConnector()` | FE/BE 两侧对称的外部数据边界 | [05](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/05-connector) |
| 物化视图 | MV 模型、改写、刷新 | `MvRewritePreprocessor.prepare()` | "MV 即 OlapTable"+ 改写规则族，横跨 catalog 与 optimizer | [06](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/06-mv) |
| 存算分离 | shared-data 全链路 | `StorageVolumeMgr`、`lake/Utils.publishVersion()` | 删除"副本"概念的另一套存储语义 | [07](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data) |
| Load 导入 | 导入管道与事务 | `GlobalTransactionMgr.commitTransaction()` | 三阶段提交协议独立于查询路径 | [08](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/08-load) |
| Pipeline 执行引擎 | 算子翻译与非阻塞调度 | `FragmentExecutor._prepare_pipeline_driver()` | 执行模型（pull/Driver/队列）自成体系 | [09](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/09-pipeline) |
| 向量化数据结构 | Column/Chunk/表达式求值 | `ExprContext::evaluate()` | 全 BE 的内存格式底座，被所有算子依赖 | [10](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/10-vectorization) |
| Tablet 存储 | rowset/segment/主键/compaction | `StorageEngine::open()` | 持久化域——写路径 28 万行的 tablet_updates.cpp | [11](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/11-storage) |
| BE 服务与 RPC | 进程装配与 RPC 协议矩阵 | `starrocks_main.cpp` → `start_be()` | 与 FE 骨架对称的 BE 装配点 | [12](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/12-be-service) |

模块间的动态调用顺序见下方核心运行流程的各条链路。

---

## 运行时行为

### 启动流程

FE 侧（`StarRocksFEServer.start()`，`fe/StarRocksFEServer.java:87`）：

```text
main → new Config().init(fe.conf)          # 反射加载配置
     → ExecuteEnv.setup()                   # 网络与执行环境
     → GlobalStateMgr.getCurrentState().initialize(helpers)
         → NodeMgr.getClusterIdAndRoleOnStartup()   # 读 meta/image/ROLE 定角色
         → initJournal()                    # 建 BDBJE journal
         → loadImage()                     # 加载 image + 重放 edit log
         → 守护线程（labelCleaner/txnTimeoutChecker/...）
     → shared-data 时额外启动 StarMgrServer   # 第二个元数据域（starmgr_ 前缀 journal）
     → StateChangeExecutor.start() + waitForReady()  # 等角色稳定
     → QeService(9030) / FrontendThriftServer(9020) / HttpServer(8030) / ArrowFlightSqlService 依次拉起
```

对象装配的要点：**配置先于一切**（`ConfigBase.init` 反射读 `fe.conf`），**GlobalStateMgr 先于网络服务**（避免半初始化节点接流量），**`waitForReady()` 阻塞在端口打开之前**。`ConfigRefreshDaemon`（10s 周期）+ `ADMIN SET FRONTEND CONFIG` 支持热更新并持久化。角色转换失败直接 `System.exit(-1)`（`transferToLeader` 内注释明言"半完成的 activation 无法可靠回滚"），靠重启收敛。

BE 侧（`starrocks_main.cpp` → `start_be()`，实现在 `be/src/service/service_be/starrocks_be.cpp`）：gflags 解析 → `config::init(be.conf)` → 校验 storage 路径（坏盘按 `ignore_broken_disk` 剔除）→ `Daemon::init` → **`StorageEngine::open`**（打开全部 tablet）→ ExecEnv/ComputeEnv/StorageEnv 等环境装配 → `AgentServer::start()`（心跳与任务上报）→ `storage_engine->start_bg_threads()`（compaction/flush 等真正周期任务在此，不在 Daemon）→（CN 模式 `init_staros_worker`）→ 依次启动 thrift BackendService（9060）、brpc PInternalService+LakeService（8060）、HTTP（8040）、Arrow Flight、heartbeat ThriftServer（9050）→ 主线程挂起。退出按逆序逐层 stop/join，顺序注释固化了依赖（如 AgentServer 必须先于 StorageEngine 停）。

### 核心运行流程

以下三条链路覆盖了查询、导入、存算分离写入三种运行模式。

#### 查询链路：SELECT 从协议到结果

业务流程：客户端发 SQL → FE 解析/优化成物理计划 → 按片段部署到 BE → BE pipeline 执行 → 结果回流。

![查询数据流](/vibe-reading/images/articles/starrocks-internals/data-flow.svg)

文字描述：MySQL packet 在 xnio worker 线程被 `ConnectProcessor.handleQuery()` 分发，`SqlParser.parse()`（ANTLR 文法在 `fe-grammar` 模块）产出 AST，`StatementPlanner.plan()` 先 `QueryAnalyzer` 分析再 `Authorizer.check()` 授权，然后 `QueryOptimizer.optimize()` 跑 Cascades 搜索（含 MV 改写），物理 `OptExpression` 树经 `PlanFragmentBuilder.createPhysicalPlan()` 翻译成 `PlanFragment` 列表（按 Exchange 边切分）。`DefaultCoordinator.startScheduling()` 走 Pending→Prepare→Deploy 三步：`QueryQueueManager.maybeWait()` 申请 slot，`CoordinatorPreprocessor` 实例化 FragmentInstance 并分配 scan range，`Deployer.deployFragments()` 并行 brpc 推送 `TExecPlanFragmentParams`。BE 侧 `internal_service.cpp` 的 `exec_plan_fragment` → `FragmentExecutor._prepare_pipeline_driver()` 把计划折叠成 Pipeline/Driver，执行产出 Chunk 流，root fragment 的 `ResultSink` 把 chunk 攒进 `ResultBufferMgr`，FE 的 `ResultReceiver` 经 `fetch_data` 拉模式取回，`MysqlSerializer` 编码回客户端。数据形态演变：SQL text → AST → OptExpression → Memo/Group → 物理 OptExpression → TExecPlanFragmentParams → Pipeline → Chunk → RowBatch → MySQL row packet。

#### 导入链路：Stream Load 三阶段提交

业务流程：HTTP PUT 数据 → 重定向到 BE → BE 边收边算写入 rowset → FE 事务协调 → 发布可见。

文字描述：客户端 PUT `http://fe:8030/api/{db}/{tbl}/_stream_load`，`LoadAction`（`http/rest/LoadAction.java:100`）307 重定向到某 BE。BE `http/action/stream_load.cpp` 的 `on_header` 建 `StreamLoadContext`，`StreamLoadExecutor::begin_txn` 向 FE `beginTransaction`；FE 侧 `streamLoadPutImpl`（`service/FrontendServiceImpl.java:1725`）调 `LoadPlanner.plan()` 构造导入 fragment（含 `OlapTableSink`），BE 拉到计划后用与查询相同的 pipeline 引擎执行，`NodeChannel::add_chunk`（`tablet_sink_index_channel.cpp:537`）把数据经 `PTabletWriterAddBatch` 发给目标 BE 的 `DeltaWriter` 写 memtable/rowset。数据发完后 `commit_txn` 触发 FE `GlobalTransactionMgr.commitTransaction()`：BE 汇报 `TabletCommitInfo` → FE 按 partition 算 quorum → 置 COMMITTED（快速返回客户端）→ `PublishVersionDaemon` 异步向 BE 发 `PublishVersionTask`，BE 把 PREPARED rowset 挂到版本上（主键表在此跑 `_apply_rowset_commit` 生成 delete bitmap）→ 全部成功置 VISIBLE。**三阶段的动机**：COMMITTED 只保证多数副本刷盘，把慢 publish 移出导入关键路径。

#### 存算分离写入：对象存储上的版本提交

业务流程：CN 写数据与 TxnLog 到对象存储 → FE commit → FE 令 CN 执行 publish 重放日志生成新版本 TabletMetadata。

文字描述：CN 的 `lake::Tablet` 经 `LocationProvider`（从 StarOS worker 取 shard 存储路径）寻址，`new_writer()` 写 segment 文件、`put_txn_log()` 把 TxnLog（普通文件）落对象存储。FE commit 后调 `lake/Utils.publishVersion()`（批量时 `publishVersionBatch`），选一个聚合 CN（`LakeAggregator.chooseAggregatorNode()`，优先已持有该批某 tablet 的节点以避免 cache miss）由它重放整批 TxnLog、生成 `version+1` 的 `TabletMetadataPB` 写回对象存储——**可见性由元数据文件的版本号原子切换**，没有 shared-nothing 的 per-replica publish RPC。旧文件靠 `vacuum` RPC 清理，compaction 由 FE 经 `compact` RPC 触发 CN 执行（compaction 本身也是一个事务）。

### 状态流

![核心状态机](/vibe-reading/images/articles/starrocks-internals/state-flow.svg)

左区是导入事务状态机：枚举定义在 `transaction/TransactionStatus.java:25`，五个状态。PREPARED 仅在显式两阶段（`TxnPrepareMode.EXPLICIT_TWO_PHASE`）时持久化存在，供 transaction stream load 用户手动 commit/abort。转换由 `DatabaseTransactionMgr` 驱动——COMMITTED→VISIBLE 的推手是 `PublishVersionDaemon`（quorum + `quorum_publish_wait_time_ms` 容忍）；abort 路径在 writeLock 下重取 latest state 再转换，注释（`DatabaseTransactionMgr.java:646-666`）解释了对 stale 快照 abort 会把已 COMMITTED 的事务覆盖成 version=-1 的 ABORTED——这是修过的真实 bug。右区是 FE 节点角色：`ha/FrontendNodeType.java` 定义，启动时由 `NodeMgr.getClusterIdAndRoleOnStartup()` 读 ROLE 文件确定（Leader 本质是"被选出的 Follower"，`isElectable = role==FOLLOWER`），运行期由 BDBJE 事件经 `BDBStateChangeListener` → `StateChangeExecutor` 串行驱动 `transferToLeader()/transferToNonLeader()`，并用 epoch fencing（`BDBHA.java:90` 写 epochDB 单调递增 epoch）防脑裂。

---

## 典型修改场景

#### 场景 1：新增一条 Cascades transformation 规则

`sql/optimizer/rule/transformation/` 新建类（私有构造 + 单例，构造器声明 `Pattern`）→ `RuleType.java` 加枚举（注意 `NUM_RULES` 比特位）→ rewrite 型挂入 `RuleSet.java` 的 `CombinationRule` 并在 `QueryOptimizer.logicalRuleRewrite()` 固定序列选位插入（顺序敏感）；CBO 型在 `RuleSet` 加 `addXxxRule()` 由 `memoOptimize()` 按开关装入。对应测试在 `fe/fe-core/src/test/java/com/starrocks/sql/optimizer/`（PlanTestBase 体系）。

#### 场景 2：新增一个内建向量化函数

`gensrc/script/functions.py` 的 `vectorized_functions` 表加一行（fid 按模块编码规则分配）→ `be/src/exprs/<module>_functions.h/.cpp` 实现 `fn_impl`（用 `DEFINE_VECTORIZED_FN` 等模板宏）→ 重跑 `gen_functions.py` 双端生成（BE `.inc` 注册表 + FE `VectorizedBuiltinFunctions.java`）。对应测试：`be/test/exprs/` 同名 GTest。

#### 场景 3：新增一个 FE↔BE brpc 方法

`gensrc/proto/internal_service.proto` 加 message + rpc → `be/src/service/internal_service.cpp` 加 handler → FE 侧 `rpc/PBackendService.java`（手工维护的 Java stub）加方法与消息类。兼容性靠"FE 后升级"滚动升级约定（proto 注释有显式范例）。对应测试走 `test/` SQL 用例。

---

## 测试体系

```shell
fe/fe-core/src/test/java/com/starrocks/   # 2015 个 JUnit 文件（镜像 main 包结构）
be/test/                                  # 938 个 GTest 文件（镜像 be/src 结构）
test/sql/                                 # 193 个 SQL 集成用例目录（run.py 驱动，产物 golden output）
```

| 代码层 | 测试类型 | 入口 |
| --- | --- | --- |
| FE 优化器/analyzer/catalog | JUnit（`PlanTestBase`/`UtFrameUtils`/`StarRocksAssert`） | `./run-fe-ut.sh --test <FQCN>` |
| BE storage/exec/column | GTest 单测二进制 | `./run-be-ut.sh --build-target <test_binary> --module <test_binary>` |
| 端到端 SQL 行为 | SQL 回归（golden output 对比） | `cd test && python3 run.py -v` |
| 模块边界 | `check_be_module_boundaries.py --mode full` | CI 强制 |

想理解某个类，优先读它镜像位置的测试：例如要懂 `TabletUpdates` 就读 `be/test/storage/tablet_updates_test.cpp`——BE 的测试是"可执行文档"，`tablet_updates_test.cpp` 里几乎每个写路径竞态都有对应用例。

---

## 阅读源码推荐路线

- 第一遍：理解查询主流程
  `fe/.../qe/ConnectProcessor.java` 的 `handleQuery()` → `qe/StmtExecutor.java` 的 `execute()` → `sql/StatementPlanner.plan()` → `sql/optimizer/QueryOptimizer.java` 的 `optimize()` → `sql/plan/PlanFragmentBuilder.java` 的 `createPhysicalPlan()` → `qe/DefaultCoordinator.java` 的 `startScheduling()` → `be/src/service/internal_service.cpp` 的 `exec_plan_fragment` → `be/src/orchestration/fragment_executor.cpp` 的 `_prepare_pipeline_driver()`
- 第二遍：理解核心数据结构
  `be/src/column/column.h`（COW 基类）→ `column/chunk.h` → `column/nullable_column.h` → `fe/.../catalog/Table.java`（TableType 32 种与继承体系）→ `be/src/storage/rowset/rowset.h` → `storage/tablet_updates.h`
- 第三遍：理解两类持久化协议
  FE 元数据：`persist/EditLog.java` 的 `logEditGated()` → `journal/JournalWriter.java` → `journal/bdbje/BDBEnvironment.java`；导入事务：`transaction/DatabaseTransactionMgr.java` 的 `commitTransaction()` → `transaction/PublishVersionDaemon.java` → BE `storage/tablet_updates.cpp` 的 `_apply_rowset_commit()`
- 第四遍：选重点模块深入（模块文档；存算分离与优化器是 StarRocks 区别于 Doris 的两个最有阅读价值的方向，见 [07](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data) 与 [03](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/03-optimizer)）

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| FE / BE / CN | Frontend（Java 协调节点）/ Backend（带盘执行存储节点）/ Compute Node（无盘执行节点，shared-data） |
| EditLog | FE 元数据 WAL，经 BDBJE 复制到 Follower |
| RunMode | BE 二进制内的部署形态开关：shared-nothing vs shared-data（cloud_native） |
| Tablet / Rowset / Segment | 数据分片 / 不可变数据版本单元 / 列存文件 |
| DelVector | 每个 (segment, version) 一个 Roaring bitmap，记录逻辑删除的行 |
| StarOS / starlet | shared-data 下的 shard 管理与文件系统服务，BE 内集成于 `compute_env/staros/` |
| Morsel | scan range 转成的可调度工作单元，喂给 pipeline 并行 |
| quorum publish | 导入 VISIBLE 前的版本发布，多数副本成功即可（可配等待） |
| PCT | MV 的 partition-change-tracking 刷新模式（默认） |

### 参考资料

- 官方文档：[docs.starrocks.io](https://docs.starrocks.io/)（部署/共享数据/物化视图各章）
- 仓库内 `handbook/`：贡献者视角的架构地图与 BE 模块边界清单
- 本系列模块文档（见模块地图"深入阅读"列）
