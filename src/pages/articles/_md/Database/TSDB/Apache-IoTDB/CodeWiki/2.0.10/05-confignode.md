---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "ConfigNode 协调节点"
date: "2026-10-01T20:45:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "时序数据库", "分布式", "Raft", "分区表"]
description: "集群元数据与协调中心：ConfigManager 门面 + 单一 Raft 共识组 + 两级分区表 + HBase 血统 Procedure 框架，全部元数据纯内存 + Raft 日志持久化。"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

ConfigNode 是 IoTDB 集群的元数据与协调中心（`iotdb-core/confignode`，约 13 万行），自身**不存任何时序数据**。它管的是：节点注册（DataNode/ConfigNode/AINode）、分区表（谁的数据在哪个 Region）、集群级 schema、负载与再平衡、权限/TTL/配额、pipe 与订阅的元数据、UDF/Trigger 注册。

两个容易想当然但代码里不是这样的事实：**v2.0.10 没有 `ConfigEntry` 这个分发类**——Thrift 入口实际由 `service/thrift/ConfigNodeRPCServiceProcessor.java`（约 1500 行）承担，每个 Thrift 方法一个 public 方法直接转调 `configManager`；**persistence/ 下没有 RocksDB**——持久化是纯内存 Info 对象 + Ratis (Raft) 日志 + Snapshot 三层组合（`writelog/io/` 的 `BatchLogReader`/`SingleFileLogReader` 只服务于单机 SimpleConsensus 的 WAL 回放）。

## 模块架构

![ConfigNode 架构](/vibe-reading/images/articles/iotdb-2.0.10/confignode-architecture.svg)

`ConfigManager`（`manager/ConfigManager.java`，3058 行）是全部门面：构造函数（L356）先建全部 15 个 Info 对象 → `ConfigPlanExecutor`（依赖注入这些 Info）→ 状态机 → 各子 Manager。子 Manager 按域拆分：`NodeManager`（注册）、`PartitionManager`（分区表）、`ClusterSchemaManager`（集群 schema）、`LoadManager`（负载与分配）、`ProcedureManager`（两阶段过程）、`PermissionManager`/`TTLManager`/`ClusterQuotaManager`、pipe/订阅的 coordinator、UDF/Trigger/CQ 管理器。

架构上最重要的一个决定是**单共识组**：全部读写经 `ConsensusManager.write()/read()`（L366/375）走全局唯一的 ConfigRegion Raft 组（`DEFAULT_CONSENSUS_GROUP_ID`，`ConsensusManager.java:80`），写请求以 `ConfigPhysicalPlan`（`consensus/request/`，`ConfigPhysicalPlanType` 枚举定义全部计划类型）形式复制到全部 ConfigNode。结果是：**计算逻辑只在 leader，状态机在所有副本**——子 Manager 在 leader 上算出结果，follower 靠重放同一 plan 收敛。为什么不分域分片？元数据低吞吐，简单性优先。

初始化顺序有明确注释（L412）：PipeManager 必须先于 LoadManager（后者把前者注册为 listener）；`ConsensusManager` 用 `AtomicReference` 延迟初始化（L302）——非 Seed 节点要等 leader 分配 nodeId 后才能启动共识。

## 调用链路

![分区创建链路](/vibe-reading/images/articles/iotdb-2.0.10/confignode-partition-flow.svg)

以最核心的"DataNode 写入触发分区创建"为例。`PartitionManager.getOrCreateSchemaPartition()`（L227）**不是 Procedure**，而是"先读后 synchronized 双检 + 共识写"的轻量路径——读已存在分区（读共识）；不全则进 `synchronized(this)` 双检（注释解释 why：无事务机制，需重查 database 是否已被删）；`filterUnassignedSchemaPartitionSlots()` 找未分配槽；`extendRegionGroupIfNecessary()`（L577）按 AUTO 策略判断是否要新建 RegionGroup（三条规则：不足 `minRegionGroupNum`、每 Region 平均槽数将超期望值、该库全部 RegionGroup Disabled）。**只有需要扩 RegionGroup 时才升级为 Procedure**：`generateAndAllocateRegionGroups()`（L711）→ `RegionBalancer.genRegionGroupsAllocationPlan()`（含 scatter-width 分散度保证）→ `ProcedureManager.createRegionGroups()`；否则直接 `PartitionBalancer.allocateSchemaPartition`（轮转选 leader 优先的 RegionGroup）→ `consensusWritePartitionResult()`（L546）写回共识。

启动流程三分支（`service/ConfigNode.java` `active()` L159）：**重启**（`initConsensusManager` → `upgrade` → `waitForLeaderElected` → 写版本信息也要过 Raft）；**Seed 首启**（建单成员 Raft 组 → `NodeManager.applyConfigNode()` 写自己 → **最后**才 `setUpRPCService()`，注释明说 why：确保外部服务可见时节点已完全就绪）；**非 Seed 加入**（**先**开 RPC 后建共识——顺序由扩容 Procedure 回调新节点的需求决定）→ `sendRegisterConfigNodeRequest()`（L373）处理重定向与 `CONFIG_NODE_LEADER_WARMING_UP` 重试 → 轮询 `getAllConsensusGroupIds()` 非空判断日志已同步。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ConfigManager` 构造（L356） | 装配 15 Info + 全部子 Manager | protected createXxx() 工厂方法供测试子类覆写 |
| `ConsensusManager.write()/read()`（L366/375） | 全部元数据读写的唯一通道 | 单 ConfigRegion Raft 组 |
| `PartitionManager.getOrCreateSchemaPartition()`（L227） | 分区创建 | synchronized 双检轻量路径，不全程 Procedure |
| `PartitionManager.getSeriesPartitionSlot()`（L1111） | 设备 → hash 槽 | 4 种 hash Executor 策略可选 |
| `ProcedureExecutor.recover()`（L127） | 过程恢复 | 重建 rollback 栈、处理 WAITING 孤儿 |
| `CreateRegionGroupsProcedure`（L100） | 建 RegionGroup | 五状态；ACTIVATE 注入心跳样本免等待 |
| `RegionMigrateProcedure` | 副本迁移 | PREPARE→ADD→CHECK→REMOVE，先加后删保多数 |
| `ConfigRegionStateMachine.takeSnapshot()`（L229） | 快照 | 遍历 snapshotProcessorList 让每个 Info 各自序列化 |
| `HeartbeatService.heartbeatLoopBody()`（L123） | 心跳 | ConfigNode 主动拉，写入 LoadCache |
</details>

## 核心实现

### 两级分区表

分区键在 node-commons `commons/partition/`：**SeriesPartitionSlot**（设备 → hash 槽，`PartitionManager.setSeriesPartitionExecutor()`（L174）按配置实例化，实现在 `executor/hash/` 下四种：`BKDRHashExecutor`/`APHashExecutor`/`JSHashExecutor`/`SDBMHashExecutor`，核心即 `hash % seriesPartitionSlotNum`）和 **TimePartitionSlot**（时间对 `timePartitionInterval` 取整，`TimePartitionUtils` 用 BigInteger 防溢出）。SchemaPartition 粒度是 `Database → Map<SlotId, RegionId>`（`SchemaPartitionTable.java`），DataPartition 是 `Database → SlotId → TimeSlotList → RegionId`（`DataPartitionTable.java`）——同一套共识组分配，时间维度只对数据分区生效。

### Procedure 框架（HBase Procedure v2 血统）

`procedure/Procedure.java` 约定 `execute()`/`rollback()` **必须幂等**（javadoc 明说机器故障中途会重放），内置 parentProcId/childrenLatch/状态机/自写二进制序列化。`StateMachineProcedure` 泛型 `<Env, TState>`——`executeFromState()` 每步返回 `Flow.HAS_MORE_STATE/NO_MORE_STATE`，rollback 按已执行状态**逆序**回滚。`ProcedureExecutor`（`WorkerThread` 池 :769）的 `recover()`（:127）处理"子过程全成功但 master 被杀"的 WAITING 孤儿（强制置 RUNNABLE）。

最值得读的是**Procedure 持久化决策**：`ConfigProcedureStore.update()` 把每个状态变更包装成 `UpdateProcedurePlan` **经 Raft 共识写**——过程日志即共识日志，天然多副本容错，而 HBase 原版是本地 WAL。典型五状态过程 `CreateRegionGroupsProcedure`（L100）：CREATE_REGION_GROUPS（异步 RPC 各 DataNode 建 region）→ SHUNT_REGION_REPLICAS（成功副本过半则保留+建补偿任务，否则全删）→ REBALANCE_DATA_PARTITION_POLICY → ACTIVATE_REGION_GROUPS（**直接注入 `RegionHeartbeatSample` 让 LoadCache 立即可用**，避免等心跳采样）→ CREATE_INITIAL_CONSENSUS_PIPES。

### 再平衡与维护任务队列

`RouteBalancer`（`manager/load/balancer/`，34.6K）实现 `IClusterStatusSubscriber` 订阅心跳负载事件，`balanceRegionLeaderAndPriority()`（L589）做 region leader 迁移。副本迁移走 `RegionMigrateProcedure` 四状态（PREPARE → ADD_REGION_PEER → CHECK → REMOVE_REGION_PEER，先加后删保多数）。一个精细设计：失败的副本创建不直接重试，而是作为 `RegionCreateTask` 提交 `OfferRegionMaintainTasksPlan`，存入 `PartitionInfo.regionMaintainTaskList`（L222），由 `PartitionManager.maintainRegionReplicas()`（L1329）单线程定时消费——**维护任务队列本身也过共识**（poll 也要 `PollRegionMaintainTaskPlan`），leader 切换后队列不丢。

### 元数据持久化（无本地数据库）

`persistence/` 下 15 个 `*Info` 类全部 `implements SnapshotProcessor`；schema 树为 `ConfigMTree`（`ClusterSchemaInfo.java:157` 持有 tree/table 双 MTree）。Ratis 触发 `ConfigRegionStateMachine.takeSnapshot()`（L229）→ `ConfigPlanExecutor.takeSnapshot(File)`（L711）让每个 Info 各自序列化到快照目录（要求目录为空否则整体失败）；恢复走 `loadSnapshot()` / `ConfigNodeSnapshotParser`。**Why**：元数据量小，内存 + 快照足够快；一致性全部外包给 Raft，避免再引入嵌入式 KV 的双份一致性问题。

### 心跳与 DataNode 交互

ConfigNode leader **主动拉**心跳：`HeartbeatService`（`heartbeatLoopBody` L123）用三套 Async 心跳 client pool 周期 ping DataNode/ConfigNode/AINode，结果写入 `LoadCache`（NodeHeartbeatSample/RegionHeartbeatSample），驱动 RouteBalancer 与 `confirmLeader()` 的 `isLoadReady()` 检查（`ConsensusManager.java:478`——leader 必须等负载采样就绪才服务，期间返回 `CONFIG_NODE_LEADER_WARMING_UP`）。下行通道是 `client/async/` 的 `CnToDnInternalServiceAsyncRequestManager` 批量并发下发（CREATE_SCHEMA_REGION 等）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 + 分层管理器 | `ConfigManager` | Thrift 层零业务，全转发 |
| 命令 | 全部操作统一为 `ConfigPhysicalPlan` 子类 | plan 即复制单元，follower 重放收敛 |
| 状态机 | `StateMachineProcedure`、`ConfigRegionStateMachine`（实现 Ratis EventApi，leader 切换时启停仅 leader 服务） | 跨节点过程步骤化 |
| 策略 | 4 种 hash Executor、`RegionGroupExtensionPolicy`（AUTO/CUSTOM）、`RegionGroupAllocatePolicy` | 分配算法可插拔 |
| 观察者 | `IClusterStatusSubscriber`（RouteBalancer 订阅负载） | 负载事件驱动再平衡 |
| 工厂方法 | `ConfigManager` 的 protected createXxx() | 集成测试可替换子 Manager |

## 模块间交互

ConfigNode 依赖 node-commons（分区类型、ConsensusGroupId、PartialPath 模式匹配）与 consensus 模块（Ratis）。与 DataNode 的交互三通道：Thrift RPC（10710，客户端转发的 DDL 与注册）、内部心跳（主动拉）、Procedure 的异步 RPC 下发。ConfigMTree 只是集群级 schema 骨架——设备级海量元数据在 DataNode 的 SchemaRegion（Ratis 分片），列 schema/模板这类跨 database 全局对象存在 ConfigNode 单一真源（见元数据引擎篇）。

## 扩展方式

新增一种集群元数据操作（如新的 schema 变更）要动 6 处：`ConfigPhysicalPlanType` 枚举 → 新 `ConfigPhysicalPlan` 子类 → `ConfigPlanExecutor.executePhysicalPlan()` 的 switch 分支 → `ConfigNodeRPCServiceProcessor` 新 Thrift 方法 → `ConfigManager` 门面方法 → 若跨节点则新增 `StateMachineProcedure` + `ProcedureType` 编号 + `ProcedureFactory` 反序列化分支。这条链是理解"计划即复制单元"的最短路径。修改 RegionGroup 分配策略的入口集中在 `RegionBalancer.genRegionGroupsAllocationPlan()` 与 `PartitionBalancer`，扩容触发条件在 `PartitionManager.autoExtendRegionGroupIfNecessary()`（:642）的三条规则。

> ⚠️ 待核实：Ratis `read()` 的线性一致性语义细节；`ConfigMTree` snapshot 的版本兼容机制；`ProcedureWAL` 标注 `@TestOnly`，生产恢复是否完全依赖 `ProcedureInfo.oldLoad()`。
