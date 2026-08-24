---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "集群管理与运维"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "clone", "TabletScheduler", "SchemaChange", "backup", "MasterImpl", "BDBJE 选主"]
description: "Doris 1.1.5 集群管理与运维：TabletScheduler 副本补齐+均衡、SchemaChangeHandler Shadow Index 在线变更、BackupHandler 备份恢复、MasterImpl 任务回报、SystemInfoService BE 管理、BDBJE 选主。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

本模块由 `fe/.../clone/`（~0.72 万行）、`alter/`（~0.64 万行）、`backup/`（~0.74 万行）、`master/`（~0.23 万行）、`system/`（~0.33 万行）组成，是 Master FE 的后台运维职责域：Tablet 副本补齐与负载均衡、在线 Schema Change、备份恢复、BE 节点管理、Master 任务回报处理。所有调度器继承 `MasterDaemon`，经 `runAfterCatalogReady()` 周期驱动，**只在 Master FE 运行**。

## 模块架构

```
Catalog (god class) ── 持有全局元数据 + 50+ 管理器
   │
   ├─ SystemInfoService (system/SystemInfoService.java) ── BE 节点管理
   │    ├─ idToBackendRef (ImmutableMap, CopyOnWrite)
   │    ├─ addBackends / dropBackend (DECOMMISSION)
   │    ├─ updateBackendReportVersion / checkBackendAlive / checkBackendScheduleAvailable
   │    └─ getClusterBackendIds(needAlive)
   │
   ├─ TabletChecker (clone/TabletChecker.java:65) extends MasterDaemon ── 健康检查(生产者)
   │    └─ checkTablets() (:228) → handlePartitionTablet (:334) → tablet.getHealthStatusWithPriority
   │         → tabletScheduler.addTablet() ── 加入待调度队列
   │         (ADMIN REPAIR TABLE → addPrios 提升优先级 VERY_HIGH)
   │
   ├─ TabletScheduler (clone/TabletScheduler.java:93) extends MasterDaemon ── 调度(消费者)
   │    ├─ pendingTablets (PriorityQueue) / runningTablets / schedHistory
   │    ├─ backendsWorkingSlots (Map<BE,PathSlot>, 默认 2 并发) ── 并发控制
   │    ├─ statisticMap (集群负载统计, 每 20s 更新)
   │    ├─ rebalancer (Rebalancer 策略: BeLoad/Partition)
   │    ├─ runAfterCatalogReady (:279) → schedulePendingTablets (:367)
   │    │    → handleTabletByTypeAndStatus (:578)
   │    │         ├─ REPAIR: handleReplicaMissing (选目标 BE+源副本, createCloneReplicaAndTask)
   │    │         └─ BALANCE: doBalance (rebalancer.selectAlternativeTablets :1177)
   │    └─ finishCloneTask (:1379) ── BE 回报
   │
   ├─ SchemaChangeHandler (alter/SchemaChangeHandler.java) extends AlterHandler
   │    ├─ SHADOW_NAME_PRFIX = "__doris_shadow_"
   │    ├─ schemaChangeThreadPool (max 10 并发)
   │    ├─ process (:1465) → processAdd/Drop/ModifyColumn
   │    ├─ createJob (:996) ── 创建 SHADOW index + shadow tablet + ReplicaState.ALTER
   │    │    ── olapTable.setState(SCHEMA_CHANGE); EditLog.logAlterJob
   │    └─ runAlterJobV2 (:1412) → AlterJobV2.run()
   │         (SchemaChangeJobV2:194 runPendingJob→CreateReplicaTask;
   │          :354 runWaitingTxnJob→watershedTxnId 等前序事务;
   │          :433 runRunningJob→AlterReplicaTask;
   │          :513 onFinished→shadow 替换 origin, 删旧 tablet, setState(NORMAL))
   │
   ├─ BackupHandler (backup/BackupHandler.java:81) extends MasterDaemon
   │    ├─ repoMgr (RepositoryMgr)
   │    ├─ process (:255) → backup (:288)/restore (:378)
   │    └─ runAfterCatalogReady (:179) → job.run() 状态机
   │         (BackupJob: PENDING→SNAPSHOTING→UPLOAD_SNAPSHOT→UPLOADING→SAVE_META→UPLOAD_INFO→FINISHED)
   │
   └─ MasterImpl (master/MasterImpl.java) ── 任务回报
        ├─ finishTask (:83) → finishClone/finishAlterTask/finishCreateReplica/finishPublishVersion
        └─ report → ReportHandler (tablet/task/disk report, BlockingQueue 异步)
```

## 调用链路

副本补齐：

```
TabletChecker.runAfterCatalogReady (:197) → checkTablets (:228)
  → handlePartitionTablet (:334) → tablet.getHealthStatusWithPriority
  → tabletScheduler.addTablet(tabletCtx) ── 加入优先级队列

TabletScheduler.runAfterCatalogReady (:279)
  → updateClusterLoadStatisticsAndPriorityIfNecessary (每 20s)
  → schedulePendingTablets (:367) → getNextTabletCtxBatch (最多 50)
  → scheduleTablet (:465) → handleTabletByTypeAndStatus (:578)
    → handleReplicaMissing ── chooseProperTag + chooseAvailableDestPath(低负载) + chooseSrcReplica + createCloneReplicaAndTask
  → AgentTaskExecutor.submit(batchTask) ── 下发 BE

BE 完成 → MasterImpl.finishTask (:83) → finishClone (:703)
  → TabletScheduler.finishCloneTask (:1379) → finalizeTabletCtx(FINISHED)
```

Schema Change：

```
Alter.processAlterOlapTable → SchemaChangeHandler.process (:1465)
  → createJob (:996) ── 创建 __doris_shadow_ index + shadow tablet (ReplicaState.ALTER); setState(SCHEMA_CHANGE)
  → runAlterJobV2 (:1412) → AlterJobV2.run (:155) switch:
    PENDING → runPendingJob (:194): 发 CreateReplicaTask; addShadowIndexToCatalog; watershedTxnId=getNextTransactionId; →WAITING_TXN
    WAITING_TXN → runWaitingTxnJob (:354): isPreviousLoadFinished(分水岭前事务); 发 AlterReplicaTask; →RUNNING
    RUNNING → runRunningJob (:433): 等 alter task 完成; 检查 shadow 健康度≥quorum; onFinished (:513)
    onFinished: shadow 替换 origin; replica.setState(NORMAL); 删旧 tablet; setState(NORMAL) →FINISHED
```

## 核心实现

### 副本补齐与均衡在 FE

FE 持全局元数据视图（Catalog），能感知所有 tablet 副本分布、版本、BE 存活。副本补齐需选源副本与目标 BE，涉及跨 BE 决策，必须中心化协调。`TabletScheduler.handleReplicaMissing`（`:640`）`chooseAvailableDestPath`（`:1206`）遍历 BE 负载选低负载路径；`TabletChecker.checkTablets`（`:228`）遍历全库 tablet 检查健康。

### TabletScheduler 优先级 + 均衡 + 双重角色

`Priority`（VERY_HIGH/HIGH/NORMAL/LOW）入 `PriorityQueue`，`adjustPriorities`（`:339`）防高优先级长占队列。均衡 `selectTabletsForBalance`（`:1177`）调 `rebalancer.selectAlternativeTablets`，受 `max_balancing_tablets` 限制。`BeLoadRebalancer` 按 BE 负载分 low/mid/high 三档，high 挑 tablet 迁 low。`PathSlot`（默认 2）限每 BE 路径并发 clone 数。同一 `TabletScheduler` 兼 REPAIR（TabletChecker 产出）与 BALANCE（Rebalancer 产出），共享基础设施，REPAIR 优先级高于 BALANCE。

### Schema Change 用 Shadow Index

不直接改原 index schema，而创建 `__doris_shadow_` 前缀的 SHADOW index，在 BE 建新副本转换数据，完成后替换。**为什么**：在线 DDL（原表期间可读写）、原子切换（一次替换用户无感）、回滚安全（失败只删 shadow）。**watershedTxnId**（`SchemaChangeJobV2.java:316`）作为分水岭事务 ID，shadow 创建后必须等分水岭前所有导入事务完成才发 alter task，保证数据一致。

### Master 选举用 BDBJE

`HAProtocol` 接口→`BDBHA`（`BDBHA.java:44`）实现，`getMasterNodeName()` 获取 master，`Catalog.transferToMaster`（`:1238`）`haProtocol.fencing()` 脑裂防护。FOLLOWER 参与选举，OBSERVER 不参与只读。BDBJE 内部 Raft-like 选举，EditLog 直接存 BDBJE，日志复制与选举一体化。详见 [02-catalog-metadata](02-catalog-metadata)。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 | `AlterJobV2.JobState`/`BackupJobState`/`TabletSchedCtx.State` | Job 生命周期 `run()` switch 驱动 |
| 调度器 | `TabletScheduler`/`TabletChecker`/`BackupHandler`/`SchemaChangeHandler` extends MasterDaemon | `runAfterCatalogReady` 周期驱动，只 Master |
| 策略 | `Rebalancer`→`BeLoadRebalancer`/`PartitionRebalancer` in `clone/` | 均衡策略可插拔（`rebalancerType` 选择） |
| Master-Slave | `HAProtocol`+`BDBHA`/`FrontendNodeType` | BDBJE 共识层，FOLLOWER 可选主，OBSERVER 只读 |
| 生产者-消费者 | `TabletChecker`→`pendingTablets`→`TabletScheduler` | Checker 发现不健康 tablet 入队，Scheduler 消费 |
| 模板方法 | `AlterJobV2.run` in `:155`，`runPendingJob/...` 抽象钩子 | 基类骨架，子类实现步骤 |

## 模块间交互

依赖 `catalog`（tablet/partition/replica 元数据，`TabletScheduler.java:132`）、`task`（AgentTaskExecutor.submit 下发 BE）、`journal`（EditLog.logAlterJob/logBackupJob/logAddBackend 持久化）。BE 通过 Thrift `MasterImpl.finishTask` 回报任务完成、`report` 回报 tablet/disk/task 状态（`ReportHandler` 异步处理更新 `TabletInvertedIndex`）。BE 心跳→`HeartbeatMgr`→`SystemInfoService` 更新状态。

## 扩展方式

**新增均衡策略**（如磁盘容量均衡）：建 `clone/DiskCapacityRebalancer extends Rebalancer`，实现 `selectAlternativeTabletsForCluster`/`completeSchedCtx`；`TabletScheduler` 构造函数（`:147-160`）加 `else if(rebalancerType.equalsIgnoreCase("disk_capacity"))` 分支。**修改副本数**：副本数由 `ReplicaAllocation` 建表指定存 `PartitionInfo`，影响 `TabletChecker.handlePartitionTablet` 的 `getHealthStatusWithPriority` 与 `handleReplicaMissing` 补齐。**修改 Schema Change 超时**：`Config.alter_table_timeout_second`；`AlterJobV2.run`（`:156`）`isTimeout()` 后 `cancelImpl("Timeout")`。
