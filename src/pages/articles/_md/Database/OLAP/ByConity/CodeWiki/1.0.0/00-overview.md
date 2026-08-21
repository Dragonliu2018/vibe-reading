---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "Overview"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "C++", "存算分离", "云原生数仓", "Cascades", "FoundationDB"]
description: "ByConity 源码解读：基于 ClickHouse 21.8 的云原生数据仓库，存算分离 + Cascades 优化器 + 无状态 Worker。"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 1.0.0（tag `3c5252ad53`，2024-08-14）· **协议** Apache 2.0 · **语言** C++（基于 ClickHouse 21.8）· **代码量** src ~133 万行（ByConity 自研云原生模块 ~16 万行）· **仓库** [GitHub](https://github.com/ByConity/ByConity)

---

## 总览

### 项目简介

**ByConity** 是字节跳动（火山引擎）开源的**云原生数据仓库**，源自 ClickHouse v21.8 代码库，但吸收了 Snowflake 的架构思想进行了深度改造。它面向大规模数据的交互式查询、Ad-Hoc 分析与批流一体接入，部署于 Kubernetes 或物理集群。

ByConity 的核心改造是把 ClickHouse 的单机一体化架构拆成**存算分离的多服务架构**：单一 `clickhouse` 二进制按 `cnch_type` 配置分离为 5 类服务——计算 Server、执行 Worker、后台编排 DaemonManager、资源调度 ResourceManager、时间戳 TSO。元数据集中存入 FoundationDB，数据存远端共享存储（S3/HDFS），计算节点无状态可弹性扩缩。此外 ByConity 自研了一套基于 Cascades 框架的代价优化器（CBO）——这是 ClickHouse 21.8 所不具备的。

**项目边界**：ByConity 负责云原生 OLAP 分析查询与批流数据接入；它**不**是流式数据库，也不提供行存/事务型 OLTP 能力。值得注意的是，项目已宣布进入退休过渡期（2026-06 起停止新功能，2026-08 仓库转为只读存档），但其存算分离与云原生数仓的工程实践仍具参考价值。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 存算分离 | `src/CloudServices/`、`src/Disks/` | 计算无状态，数据在 S3/HDFS，元数据在 FDB |
| Cascades 优化器 | `src/Optimizer/Cascades/` | 基于代价的 join reorder、规则改写、分布式属性 |
| 分布式执行 | `src/Interpreters/DistributedStages/` | PlanSegment 切分 + MPP 调度 |
| 事务与 MVCC | `src/Transaction/`、`src/TSO/` | 全局时间戳 + 多版本可见性 |
| 后台任务 | `src/DaemonManager/`、`src/WorkerTasks/` | merge/mutate/GC/dedup 编排与执行 |
| 资源管理 | `src/ResourceManagement/` | Virtual Warehouse、worker 借用 |
| 服务发现 | `src/ServiceDiscovery/` | Consul/DNS/Local + 一致性哈希 |
| 云存储引擎 | `src/Storages/StorageCnchMergeTree.cpp` | server 侧元数据引擎；worker 侧 `StorageCloudMergeTree` |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| ClickHouse 21.8 | 核心 | 继承的 SQL 解析/执行/存储引擎基座（src 大部分代码） |
| FoundationDB | 核心 | 元数据存储，提供 ACID 事务与 CAS |
| brpc | 核心 | 服务间 RPC（baidu rpc，协程模型 bthread） |
| HDFS / S3 | 核心 | 远端共享数据存储 |
| protobuf | 核心 | 元数据与 RPC 消息序列化 |
| Kubernetes | 可选 | 部署编排（也支持物理机） |
| Rust | 可选 | 仅 vendored 的 skim/prql/BLAKE3，非核心 |

### 版本历史

ByConity 演进脉络：以 ClickHouse 21.8 为基线 fork → 引入存算分离（Catalog/FDB、CloudServices、无状态 worker）→ 自研 Cascades 优化器 → 补齐事务（TSO + Transaction）→ 1.0.0 稳定发布。1.0.0 是仓库当前最新 release tag（2024-08-14）。本系列即基于该 tag 解读。项目后续进入 EOL 过渡，master 上 1.0.0 之后仍有约 600 次提交的演进，但架构骨架在 1.0.0 已稳定。

### 顶层上下文图

ByConity 对外暴露 HTTP（8123）、MySQL、TCP（9010）、gRPC（8124）协议供客户端接入；上游对接批处理与流式数据源；底层依赖 FoundationDB（元数据）与 HDFS/S3（数据）；可部署于 K8s 或物理机。

---

## 快速上手

最简路径是用官方 Docker Compose 起一个最小集群（含 FDB + tso + server + worker）：

```bash title="启动最小集群"
git clone https://github.com/ByConity/ByConity.git && cd ByConity
cd docker/docker-compose
# 准备 byconity-simple-cluster 配置后
docker compose -f docker-compose.simple.yml up -d
# 二进制依赖 libfdb_c.so（FoundationDB 客户端）
```

端到端验证（用 clickhouse client 连 server）：

```bash title="验证查询"
clickhouse client --host <server> --port 9000
# 默认 docker 部署会建好 default 库
CREATE TABLE t (id UInt64, v String) ENGINE = CnchMergeTree ORDER BY id;
INSERT INTO t VALUES (1,'a'),(2,'b');
SELECT * FROM t WHERE id > 0;
```

> 本地构建需 FoundationDB 客户端库；metal 机构建见 `doc/build_in_metal_machine.md`。

---

## 架构设计解析

### 系统架构

ByConity 的架构思想是**把"状态"从计算中剥离**：ClickHouse 单机里耦合在一起的元数据、计算、存储，被拆成三层可独立扩缩的平面——计算层（无状态）、协调服务层（控制面）、元数据/存储层（共享有状态）。这样计算节点可随负载弹性增缩而不搬数据，元数据由 FDB 强一致保证，数据由对象存储提供弹性容量。

![ByConity 存算分离架构](/vibe-reading/images/articles/byconity/architecture.svg)

整体分五层，自上而下：**客户端层**接入 SQL；**计算层**的 Server 负责解析/优化/编排、Worker 负责 PlanSegment 执行与读写 part，二者皆无状态；**协调服务层**的 DaemonManager 编排后台任务、ResourceManager 调度计算资源、TSO 提供全局时间戳，后两者多副本经 FDB CAS 选主；**元数据层** Catalog 作为 FDB 之上的访问代理，提供 MVCC 可见性；**共享存储层**的 `DiskByteS3`/`DiskByteHDFS` 直连对象存储（无本地元数据，worker 真正无状态），`DiskCacheWrapper` 用本地 SSD 缓存热文件。Server 与 Worker 间走 brpc，Worker 读 part 时经 Server 回访 Catalog 取元数据与可见性过滤。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 计算层 | `src/Server/`、`src/Interpreters/`、`src/Optimizer/`、`src/QueryPlan/` | 承载无状态计算：解析、优化、编排与执行 |
| 协调服务层 | `src/CloudServices/`、`src/DaemonManager/`、`src/ResourceManagement/`、`src/TSO/`、`src/ServiceDiscovery/` | 控制面：后台编排、资源调度、时间戳、服务发现 |
| 元数据层 | `src/Catalog/` | 把元数据从计算剥离，FDB 强一致 + MVCC |
| 存储层 | `src/Disks/`、`src/Storages/`（Cnch/Cloud） | 共享数据存储抽象与云存储引擎 |
| 基座 | ClickHouse 21.8 继承（`Functions`/`Processors`/`Parsers`/`DataTypes` 等） | SQL 能力基座，被上层复用 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `ICnchBGThread::run`（CloudServices）、`DaemonJob::execute`、`ManipulationTask::execute` | 后台任务骨架统一，子类只填 `executeImpl`/`runImpl` |
| Cascades Memo/TaskStack | `Optimizer/Cascades/` | 等价表达式去重共享 + push-based 任务调度 |
| 代理 | `MetastoreProxy`、`TSOProxy`、`ResourceManagerClient`(RpcLeaderClientBase) | 集中 key schema / leader 路由，屏蔽底层 |
| 装饰器 | `DiskCacheWrapper`、`DiskRestartProxy` | 给远端盘叠加缓存/重启能力，可组合 |
| 工厂+注册 | `DaemonFactory`、`DiskFactory`、`ServiceDiscoveryFactory` | 按配置/枚举创建实现，新增类型局部改动 |
| CAS 选主 | `ElectionController`/`StorageElector`（RM、TSO） | 多副本经 FDB CAS 选唯一 leader，无需外部选举服务 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `StorageCnchMergeTree` | server 侧云 MergeTree 引擎（仅元数据） | 表级 | 读 Catalog 元数据，不直接 IO |
| `StorageCloudMergeTree` | worker 侧云 MergeTree（执行 IO） | 查询级 | 经 Disks 读写 part |
| `PlanSegment` | 分布式执行计划分片 | 查询级 | 由 QueryPlan 切分，brpc 下发 worker |
| `Catalog` | 元数据访问入口 | 进程级单例 | 代理 FDB，被所有模块调用 |
| `VirtualWarehouse` | 计算资源池（读/写/任务） | 集群级 | 含多个 WorkerGroup，可借出/借入 |
| `TxnTimestamp` | 事务版本号（高 46 位物理 ms + 低 18 位逻辑） | 事务级 | TSO 全局分配，驱动 MVCC |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `IMetaStore` | `Catalog/IMetastore.h` | `MetastoreFDBImpl`（ByteKV 已禁用） | `MetastoreProxy::getMetastorePtr` 按 config.type |
| `IDisk` | `Disks/IDisk.h` | `DiskByteS3`/`DiskByteHDFS`/`DiskLocal` | `DiskFactory` + `registerDisks` |
| `IWorkerGroup` | `ResourceManagement/IWorkerGroup.h` | `PhysicalWorkerGroup`/`SharedWorkerGroup` | `WorkerGroupManager` |
| `IServiceDiscovery` | `ServiceDiscovery/IServiceDiscovery.h` | Consul/DNS/Local | `ServiceDiscoveryFactory` |
| `ICnchTransaction` | `Transaction/ICnchTransaction.h` | Server/Worker/Proxy/Explicit | `TransactionCoordinatorRcCnch::createTransaction` |

---

## 代码目录

```text
ByConity/
├── programs/          # 各服务入口（main.cpp 分发到 server/daemon-manager/tso/resource-manager 等）
│   └── server/        # Server.cpp（cnch_server/cnch_worker 入口）+ cnch_config.xml 服务发现配置
├── src/
│   ├── Server/            # HTTP/MySQL/gRPC handler、GRPCServer
│   ├── Interpreters/      # 查询解释执行、DistributedStages（PlanSegment/MPP 调度）
│   ├── Optimizer/         # ★ Cascades 优化器（79k 行，自研）
│   ├── QueryPlan/         # 逻辑/物理计划节点
│   ├── Catalog/           # ★ 元数据管理 → FDB（18k 行）
│   ├── CloudServices/     # ★ 云服务协调：BG 线程/RPC/去重/manifest（18k 行）
│   ├── Transaction/       # ★ 事务 + MVCC（9k 行）
│   ├── TSO/               # ★ 全局时间戳服务（2k 行）
│   ├── DaemonManager/     # ★ 后台任务编排（8k 行）
│   ├── WorkerTasks/       # ★ 后台任务执行（merge/mutate）（5k 行）
│   ├── ResourceManagement/# ★ VW/资源调度（8k 行）
│   ├── ServiceDiscovery/  # ★ 服务发现 + 一致性哈希（2.5k 行）
│   ├── Disks/             # ★ 存储抽象：DiskByteS3/HDFS + 缓存（12k 行）
│   ├── Storages/          # 存储引擎（含 Cnch/Cloud MergeTree，大量继承自 ClickHouse）
│   └── ...                # Functions/Processors/Parsers/DataTypes 等 ClickHouse 基座
├── rust/              # vendored skim/prql/BLAKE3（非核心）
├── docker/            # 部署 compose（simple/multi/multiworkers）
└── tests/             # 测试
```

★ 为 ByConity 相对 ClickHouse 的自研/重写模块。

---

## 模块地图

![核心模块依赖关系](/vibe-reading/images/articles/byconity/module-dependencies.svg)

依赖方向上，**Catalog、ServiceDiscovery、Disks 是高扇入基础层**，几乎所有模块都依赖；**CloudServices 是协调枢纽**，上承 DaemonManager 的编排，下接 WorkerTasks 的执行，旁连 Catalog/Transaction/Disks。Optimizer 独立于存储协调，只经 Catalog 取统计、经 QueryPlan 产出计划。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Catalog | 元数据访问 → FDB | `Catalog::getTable` | 元数据从计算剥离，独立强一致层 | [元数据管理](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/01-catalog) |
| Optimizer | Cascades CBO | `PlanOptimizer::optimize` | ClickHouse 无 CBO，自研子系统 | [查询优化器](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/02-optimizer) |
| CloudServices | 云服务协调 | `ICnchBGThread`、`CnchWorkerClient` | server↔worker 协作与后台线程框架 | [云服务协调](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/03-cloudservices) |
| Transaction/TSO | 事务 + 时间戳 | `TransactionCoordinatorRcCnch`、`TSOServer` | ACID 与 MVCC 是 ClickHouse 之外新增的能力 | [事务与时间戳](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/04-transaction) |
| ResourceManagement | VW/资源调度 | `ResourceManagerController` | Snowflake 风格计算资源弹性 | [资源管理与服务发现](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/05-resourcemanagement) |
| Disks | 共享存储抽象 | `IDisk`、`DiskCacheWrapper` | 存储层解耦，支持多后端 + 缓存 | [存储抽象](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/06-disks) |
| DaemonManager/WorkerTasks | 后台任务编排+执行 | `DaemonJob`、`ManipulationTask` | 全局编排与执行分离，避免重复调度 | [后台任务编排与执行](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/07-daemonmanager-workertasks) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

单一 `clickhouse` 二进制，`main.cpp` 按子命令分发到各服务入口。以 **cnch_server** 为例（`programs/server/Server.cpp` 的 `Server::main`）：

```text
mainEntryClickHouseServer → Server::main()
  ├─ register*()                 # 注册 functions/storages/disks/formats/serviceDiscovery
  ├─ Context::createGlobal       # 建全局上下文
  ├─ setServerType(cnch_type)    # 从配置读 cnch_server / cnch_worker / standalone
  ├─ BrpcApplication::initialize  # 初始化 brpc
  ├─ 若 cnch_server / cnch_worker:
  │    ├─ initCatalog(catalog_conf)            # 连 FDB
  │    ├─ initTSOClientPool                    # 连 TSO
  │    ├─ initDaemonManagerClientPool          # 连 DaemonManager
  │    ├─ initCnchServerClientPool             # server 互连
  │    ├─ initResourceManagerClient            # 连 RM（取 worker）
  │    ├─ initCnchWorkerClientPools            # worker 客户端池
  │    └─ addVirtualWarehouse(vw_read/write/task/default)  # 4 类 VW
  ├─ 若 cnch_worker: initGlobalDataManager()   # worker 初始化数据管理
  └─ initTSOElectionReader      # TSO leader 读取
```

对象装配的关键：配置来自 `cnch_config.xml`（服务发现的 server/tso/daemon_manager/resource_manager 的 PSM 与端口）；`cnch_type` 决定本进程扮演谁；Catalog 在进程内实例化并连共享 FDB；各类 RPC client pool 按服务发现结果建立；worker 还初始化 `GlobalDataManager`（管理本地 part 缓存）。

### 核心运行流程

下面三条链路覆盖查询、写入、后台任务三个核心场景。

#### 查询：SELECT 执行

业务流程：客户端发 SQL → Server 解析优化 → 切分 PlanSegment 下发 Worker → Worker 读 part 执行 → 结果回传聚合。

![查询执行数据流](/vibe-reading/images/articles/byconity/data-flow.svg)

文字描述：`HTTPHandler` 接收 SQL，经 `executeQuery` → `parseQuery` 得 AST，`InterpreterFactory` 判定走 `InterpreterSelectQueryUseOptimizer`。其 `buildQueryPlan` 依次执行 `QueryRewriter`→`QueryAnalyzer`→`QueryPlanner` 产出逻辑 `QueryPlan`，再由 `PlanOptimizer::optimize`（含 Cascades CBO + 30+ Rewriter）优化。`PlanSegmentSplitter::split` 按 Exchange 边界切成 `PlanSegment` 树，`MPPScheduler` 构建 DAG 后经 brpc 异步下发各 worker。Worker 的 `PlanSegmentExecutor` 构建 pipeline 执行，`StorageCloudMergeTree::read` 经 Disks 读 part（共享存储 + 本地缓存）；数据经 Exchange 回传，**final segment 在 server 本地执行聚合**后输出。Worker 不直连 FDB，而是经 `CnchServerClient` 回访 server 取元数据（server 做 `PartCacheManager` 缓存与可见性过滤）。

#### 写入：INSERT

`InterpreterInsertQuery` → `StorageCnchMergeTree::write` 返回 `CloudMergeTreeBlockOutputStream`。`write(Block)` 按 partition 拆分、`writeTempPart` 生成内存临时 part（UniqueKey 表还做 dedup + 生成 DeleteBitmap），`CnchDataWriter` 线程池并行 `dumpCnchParts` 把 part 写共享存储。`commitDumpedParts` 创建 `InsertAction`→`Catalog::writePartToKV` 写元数据→`txn->commitV2()`（取 TSO commit_ts、CAS 事务状态）使 part 可见。INSERT SELECT/INFILE 则转发 worker 执行（`writeInWorker`），worker dump 后 `precommitParts` RPC 回 server 提交。

#### 后台任务：merge

DaemonManager 周期 `DaemonJobServerBGThread::executeImpl` 遍历 Catalog 全表 → `TargetServerCalculator` 用一致性哈希定位每张表的 host server → `BackgroudJobExecutor` 经 `controlCnchBGThread` RPC 触发该 server 的 `CnchMergeMutateThread`。后者 `trySelectPartsToMerge`（6 步选 part + 建低优事务）→ `submitFutureManipulationTask` 经 `CnchWorkerClient` 下发 worker。Worker 的 `CloudMergeTreeMergeTask::executeImpl` 用 `MergeTreeDataMerger` 合并（`CnchMergePrefetcher` 异步预取 part 到本地），`dumpAndCommitCnchParts` 写新 part + 提交事务。任务状态全程持久化到 Catalog。

![后台任务三层管线](/vibe-reading/images/articles/byconity/bg-task-pipeline.svg)

### 状态流

事务有明确的生命周期状态机，由 FDB CAS 保证原子转换：

![事务生命周期状态流](/vibe-reading/images/articles/byconity/transaction-state.svg)

事务创建时从 TSO 取 `start_ts` 进入 **Running**，执行中 `appendAction` + `precommit` 把 part 写到 staging 并持锁（`LockManager` 的 IntentLock，每 5s 心跳续期）。`commit()` 取 `commit_ts` 做 CAS `Running→Finished`；冲突或超时则 `abort()` CAS `Running→Aborted`。`clean` 阶段：成功事务 `postCommit` 把 commit_ts 打到 part（MVCC 可见）并延时 TTL 删 record；失败事务 `applyUndos` 回滚中间 part 并立即删 record。`TransactionCleaner` 后台扫描过期事务（~24h）强制清理。

---

## 典型修改场景

#### 场景 1：新增一条优化规则

在 `src/Optimizer/Rewriter/` 或 `Rule/Transformation/` 新建类继承 `Rule`，实现 `getPattern()`/`transformImpl()`；若为 Cascades 规则在 `CascadesContext` 构造（`CascadesOptimizer.cpp:248`）`transformation_rules.emplace_back`。对应测试 `src/Optimizer/tests/`。

#### 场景 2：新增一种存储后端

继承 `IDisk`（参考 `DiskByteS3`），实现 `readFile`/`writeFile`/`removeRecursive`；写 `registerDiskXxx` 注册到 `DiskFactory`，在 `registerDisks.cpp` 调用。对应测试 `src/Disks/tests/`。

#### 场景 3：新增一种后台 DaemonJob

继承 `DaemonJob`（本地作业）或 `DaemonJobServerBGThread`（触发 server BG 线程），实现 `executeImpl()`；写 `registerXxxDaemon` 在 `registerDaemons.cpp` 调用，并在 `DaemonManager.cpp` 的 default_config 加 `{"XXX", interval_ms}`。对应测试 `src/DaemonManager/tests/`。

---

## 测试体系

```
tests/
├── queries/          # SQL 端到端测试（stateless + 参考结果 golden）
├── integration/      # 集成测试（需集群/FDB/HDFS）
└── ...
# 各模块自带 tests/：src/Optimizer/tests、src/Catalog/tests、src/Disks/tests 等
```

| 代码层 | 测试类型 |
| --- | --- |
| Optimizer 规则/Cascades | `src/Optimizer/tests` 单元 |
| Catalog/FDB 元数据 | `src/Catalog/tests` 单元 + 集成 |
| 存储引擎/Disks | `tests/queries` + `src/Disks/tests` |
| 全链路查询 | `tests/queries` 端到端 |

想理解某模块，优先读其 `tests/`——ByConity 的测试常兼作可执行文档。

---

## 阅读源码推荐路线

- **第一遍：理解服务分解与主流程**
  `programs/main.cpp`（子命令分发）→ `programs/server/Server.cpp` 的 `Server::main`（看 `cnch_type` 与各 `initXxx` 装配）→ `src/Interpreters/InterpreterSelectQueryUseOptimizer.cpp` 的 `execute`/`getPlanSegment`
- **第二遍：理解存算分离核心**
  `src/Catalog/Catalog.h` 的 `getTable`/`writeParts` → `src/CloudServices/CnchWorkerClient.cpp` + `CnchWorkerServiceImpl.cpp`（server↔worker RPC）→ `src/Disks/DiskCacheWrapper.cpp`（缓存回源）
- **第三遍：理解优化器**
  `src/Optimizer/PlanOptimizer.cpp`（Rewriter 链）→ `src/Optimizer/Cascades/CascadesOptimizer.cpp`（Memo + TaskStack）→ 深度附件 [Cascades 框架](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/02-optimizer-cascades)
- **第四遍：理解事务与后台任务**
  `src/Transaction/TransactionCoordinatorRcCnch.cpp` + `src/TSO/TSOImpl.cpp` → `src/DaemonManager/DaemonJobServerBGThread.cpp` → `src/WorkerTasks/CloudMergeTreeMergeTask.cpp`

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| 存算分离 | 计算节点无状态，数据在共享存储，元数据在 FDB |
| VW (Virtual Warehouse) | Snowflake 风格计算资源池，按读/写/任务/default 分 |
| TSO | Timestamp Oracle，全局单调递增时间戳服务 |
| MVCC | 多版本并发控制，ByConity 在 Catalog 用多版本 key 实现 |
| PlanSegment | 分布式执行计划分片，按 Exchange 边界切分 |
| CnchMergeTree / CloudMergeTree | server 侧元数据引擎 / worker 侧执行引擎 |
| brpc / bthread | 百度 RPC 框架及其协程模型 |
| host server | 一致性哈希确定的某表归属 server，只有它能写 |
| dedup | UniqueKey 表的去重，生成 DeleteBitmap |
| manifest checkpoint | 把 part 版本链合并成检查点，减少 FDB 元数据量 |

### 参考资料

- [ByConity GitHub 仓库](https://github.com/ByConity/ByConity)
- [ByConity 官方文档](https://byconity.github.io/docs/introduction/main-principle-concepts)
- ClickHouse v21.8 代码基线
- Snowflake 架构思想（存算分离、Virtual Warehouse、CBO）
- Cascades 优化框架（Goetz Graefe）
