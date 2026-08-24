---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "数据导入与事务"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "load", "transaction", "BrokerLoad", "RoutineLoad", "两阶段提交", "PublishVersion"]
description: "Doris 1.1.5 数据导入与事务：LoadJob 状态机（PENDING→LOADING→COMMITTED→FINISHED）、Broker/Routine/Stream 导入、LoadingTaskPlanner 复用查询优化器、两阶段事务（COMMITTED→VISIBLE）保证原子可见、KafkaProgress offset 管理。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

本模块由 `fe/.../load/`（~2.8 万行）、`task/`（~0.53 万行）、`transaction/`（~0.44 万行）组成，是 Doris 的写路径：批量导入（loadv2）、流式导入（routineload Kafka）、同步导入（sync）、更新导入（update）；FE→BE 的 AgentTask 批量派发；以及两阶段提交事务管理。导入与查询（读路径）分离编排，但**复用查询执行框架**——`LoadingTaskPlanner` 生成 `BrokerScanNode`+`OlapTableSink` 的 fragment，由同一套 `Coordinator` 下发 BE 执行。

## 模块架构

```
LoadJob (load/loadv2/LoadJob.java) abstract ── extends AbstractTxnStateChangeCallback
   ├─ JobState: PENDING→ETL→LOADING→COMMITTED→FINISHED/CANCELLED
   ├─ idToTasks / finishedTaskIds / isCommitting
   ├─ beginTxn()/execute()→unprotectedExecuteJob()/updateState()/cancelJob()
   └─ TxnCallback: beforeCommitted/afterCommitted/afterAborted/afterVisible + replayOn*
       │
       ▼  子类
   BrokerLoadJob (extends BulkLoadJob) ── 三步: pending→loading→commit
   ├─ beginTxn() (:96) → GlobalTransactionMgr.beginTransaction (BATCH_LOAD_JOB)
   ├─ unprotectedExecuteJob() (:108) → BrokerLoadPendingTask
   ├─ onPendingTaskFinished() (:137) → createLoadingTask() (:186)
   │    └─ LoadLoadingTask.init() → LoadingTaskPlanner.plan() (:106)
   │         └─ BrokerScanNode + OlapTableSink + PlanFragment (parallelExecNum=loadParallelism)
   └─ onLoadingTaskFinished() (:231) → commitTransaction (LoadJobFinalOperation)
       │
       ▼
RoutineLoadScheduler (load/routineload/RoutineLoadScheduler.java) extends MasterDaemon
   └─ process() (:63) → updateRoutineLoadJob → getNeedSchedule → prepare/divideRoutineLoadJob
        └─ KafkaRoutineLoadJob.divideRoutineLoadJob() (:198) ── partition→N KafkaTaskInfo
             └─ KafkaProgress (KafkaProgress.java) partitionIdToOffset ── 下一个待消费 offset
       │
       ▼
AgentBatchTask (task/AgentBatchTask.java:149) implements Runnable
   └─ run() → 按 backendId 分组 → client.submitTasks (Thrift) ── 派发 BE
       │
       ▼
GlobalTransactionMgr (transaction/GlobalTransactionMgr.java)
   ├─ beginTransaction() (:125) ── 委托 DatabaseTransactionMgr
   ├─ commitTransaction() (:216)
   ├─ commitAndPublishTransaction() (:244) ── commit + 等待 publish
   └─ getReadyToPublishTransactions() (:310) ── 供 PublishVersionDaemon
       │
       ▼
DatabaseTransactionMgr (transaction/DatabaseTransactionMgr.java)
   ├─ beginTransaction() (:278) ── 检查 label 重复/数量限制, 创建 TransactionState(PREPARE)
   ├─ commitTransaction() (:575) ── 两阶段核心:
   │    ├─ checkCommitStatus() (:410) ── 校验 quorum (quorumReplicaNum=total/2+1, :508)
   │    ├─ beforeStateTransform(COMMITTED) → LoadJob.beforeCommitted (isCommitting=true)
   │    ├─ unprotectedCommitTransaction() ── PREPARE→COMMITTED, 写 EditLog
   │    └─ afterStateTransform(COMMITTED) → LoadJob.afterCommitted
   ├─ finishTransaction() (:784) ── publish 后: 检查 visibleVersion==commit-1, replica quorum, →VISIBLE
   └─ abortTransaction() (:1116) → ABORTED, ClearTransactionTask
       │
       ▼
PublishVersionDaemon (transaction/PublishVersionDaemon.java:75)
   └─ publishVersion() → 创建 PublishVersionTask → AgentBatchTask 派发 BE → finishTransaction → VISIBLE
```

## 调用链路

Broker Load 完整链路：

```
LOAD LABEL SQL
  → LoadManager.createLoadJobFromStmt → BulkLoadJob.fromLoadStmt (switch EtlJobType BROKER/SPARK)
  → LoadJobScheduler 调度
  → LoadJob.beginTxn() (:418) → BrokerLoadJob.beginTxn() (:96)
      → GlobalTransactionMgr.beginTransaction() → DatabaseTransactionMgr.beginTransaction (:278)
        ── TransactionState(PREPARE), 写 EditLog
  → LoadJob.execute() (:430) → unprotectedExecuteJob() (:108)
      → BrokerLoadPendingTask → 获取 broker 文件列表
      → onTaskFinished(BrokerPendingTaskAttachment) → onPendingTaskFinished (:137)
        → createLoadingTask (:186) ── 每 table 一个 LoadLoadingTask
          → LoadLoadingTask.init (:103) → LoadingTaskPlanner.plan (:106) [BrokerScanNode+OlapTableSink]
          → LoadLoadingTask.executeOnce (:127) → new Coordinator → coord.exec + join (阻塞)
            ── 收集 TabletCommitInfo
        → onLoadingTaskFinished (:231)
          → GlobalTransactionMgr.commitTransaction → DatabaseTransactionMgr.commitTransaction (:575)
            ── checkCommitStatus quorum; beforeCommitted(isCommitting); PREPARE→COMMITTED 写 EditLog
  → PublishVersionDaemon.publishVersion (:75)
      → getReadyToPublishTransactions (COMMITTED)
      → PublishVersionTask → AgentBatchTask → BE apply 版本
      → finishTransaction (:784) → COMMITTED→VISIBLE; updateCatalogAfterVisible (推进 partition.visibleVersion)
      → afterVisible → LoadJob.updateState(FINISHED)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `LoadJob.unprotectedUpdateState` | 状态机转换 | final state 自保护，已终态拒绝回退 |
| `BrokerLoadJob.beginTxn` | 开事务 | sourceType=BATCH_LOAD_JOB |
| `LoadingTaskPlanner.plan` | 导入计划 | 复用查询优化，BrokerScanNode+OlapTableSink |
| `LoadLoadingTask.executeOnce` | 执行导入 | 复用 Coordinator.exec+join |
| `DatabaseTransactionMgr.commitTransaction` | 两阶段提交 | checkCommitStatus quorum + 状态转 COMMITTED |
| `DatabaseTransactionMgr.finishTransaction` | publish 后 finish | 检查 visibleVersion 连续 + replica quorum → VISIBLE |
| `KafkaProgress.update` | offset 推进 | offset = consumed + 1（指向下一条） |
| `AgentBatchTask.run` | 派发 BE | 按 BE 分组 Thrift submitTasks |

</details>

## 核心实现

### 为什么导入走两阶段事务

Doris 是 MPP 列存库，数据以 tablet 多副本存储，一次导入涉及多 BE 多 replica，必须保证原子性与版本一致性。`commitTransaction`（`:575`）中 `checkCommitStatus()`（`:410`）检查 quorum（`quorumReplicaNum = totalReplicaNum/2+1`，`:508`），不足抛 `TabletQuorumFailedException`；commit 时分配 `nextVersion`（`:976`），publish 后 `updateVisibleVersionAndTime()`（`:1558`）。COMMITTED→VISIBLE 的窗口允许 BE 异步 publish、失败可重试不影响 commit；查询只看 visibleVersion 保证一致性。`isPreviousTransactionsFinished()`（`:1568`）保证同 partition 事务有序。

### LoadJob 状态机

`JobState`：PENDING→ETL→LOADING→COMMITTED→FINISHED，任意阶段可 CANCELLED。`unprotectedUpdateState()`（`:487`）含 final state 自保护——已 FINISHED/CANCELLED 拒绝回退（防止 LoadLoadingTask 设 LOADING 时 job 已超时 CANCELLED）。RoutineLoadJob 独立状态：NEED_SCHEDULE→RUNNING→PAUSED/STOPPED/CANCELLED。`LoadJob` 继承 `AbstractTxnStateChangeCallback`，事务状态变更经回调联动：`beforeCommitted` 设 `isCommitting=true` 阻止 cancel，`afterVisible` 设 FINISHED。

### Kafka offset 管理

`KafkaProgress`（`KafkaProgress.java`）`partitionIdToOffset` 存**下一个待消费 offset**。`update()`（`:190`）在事务提交后 `offset = consumed + 1`，ABORTED 不更新（保证 at-least-once）。特殊值 `-2`(OFFSET_BEGINNING)/`-1`(OFFSET_END)。`getLag()`（`:160`）= latestOffset - currentOffset。`modifyOffset()`（`:120`）支持 PAUSE/RESUME+ALTER 手动改。

### LoadingTaskPlanner 复用查询优化器

`LoadingTaskPlanner.plan()`（`:106`）生成 `BrokerScanNode`（scan 外部数据）+`OlapTableSink`（sink 到 OlapTable）的 fragment。**为什么**：导入本质是"scan 外部→sink OlapTable"的数据流，与查询"scan→agg→sink"同构。复用获得统一执行调度（`Coordinator.exec`）、并行度控制（`setParallelExecNum(loadParallelism)`）、内存限制（`setExecMemoryLimit`）、Profile 收集、fragment 重试（`updateRetryInfo` 生成新 loadId）。`OlapTableSink` 是导入专用 sink，在 BE 记录 commit info。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 | `LoadJob.JobState`/`TransactionStatus`/`AlterJobV2` | 生命周期状态驱动 |
| 策略 | `BulkLoadJob.fromLoadStmt` switch EtlJobType in `:114`；`AgentBatchTask.toAgentTaskRequest` switch TTaskType in `:188` | 不同导入类型/任务类型走不同实现 |
| 观察者/回调 | `AbstractTxnStateChangeCallback`/`TxnStateCallbackFactory`/`LoadTaskCallback` | 事务状态变更/Task 完成回调 LoadJob |
| 模板方法 | `LoadJob.execute→unprotectedExecuteJob` in `:430,468` | execute 骨架（writeLock→→），子类实现具体 |

## 模块间交互

依赖 `catalog`（Catalog/Database/OlapTable）、`qe`（Coordinator/QeProcessorImpl/ConnectContext/SessionVariable，导入复用查询框架）、`planner`（BrokerScanNode/OlapTableSink/PlanFragment）、`transaction`、`task`。BE 通过 AgentService 回报状态→`MasterImpl.finishTask`。`PublishVersionDaemon` 是 Master FE 后台 daemon，异步发布版本。

## 扩展方式

**新增导入源类型**（如 S3）：`EtlJobType` 加 `S3`；`BulkLoadJob.fromLoadStmt`（`:114`）switch 加分支建 `S3LoadJob`；`LoadingTaskPlanner.plan`（`:106`）替换 `BrokerScanNode` 为 `S3ScanNode`；`LoadJob.read/write` 加序列化；`AgentBatchTask.toAgentTaskRequest`（`:188`）加 task 类型。**修改事务可见性**：`PublishVersionDaemon.publishVersion`（`:75`）超时处理逻辑、`TransactionState.isPublishTimeout`（`:588`）阈值、`DatabaseTransactionMgr.finishTransaction`（`:784`）health replica 恢复逻辑。**修改 Kafka 消费策略**：`KafkaProgress.update`（`:190`）区分 COMMITTED/ABORTED 路径支持 exactly-once；`divideRoutineLoadJob`（`:198`）改 partition 分配策略。
