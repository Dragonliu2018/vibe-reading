---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "数据导入 Load"
date: "2026-08-23T18:28:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "StreamLoad", "RoutineLoad", "BrokerLoad", "事务"]
description: "Doris 数据导入：Stream Load 直写 BE、Routine Load 消费 Kafka、Broker Load 批量编排，Job/Task 两级模型。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

数据导入模块（`fe/fe-core/.../load/`）负责把外部数据写入 Doris 表。它支持 Stream Load（HTTP 实时）、Routine Load（Kafka 常驻消费）、Broker Load（HDFS 批量）、Insert Into Select 等多种方式，统一用 Job/Task 两级模型 + 导入事务编排。独立成文是因为导入是独立于查询的事务编排域——数据流路径、错误处理、幂等保证都与查询执行不同。

## 模块架构

模块以 `LoadManager` 为入口，下挂 `LoadJob`（抽象）和 `LoadTask`（抽象）两级模型。Stream Load 走 `StreamLoadHandler` 生成计划，Routine Load 走 `RoutineLoadManager`+`RoutineLoadJob`。

```
LoadManager (loadv2/)
  ├─ LoadJob (抽象基类) ── BrokerLoadJob / BulkLoadJob / InsertLoadJob ...
  │    └─ LoadTask ── BrokerPendingTask / LoadLoadingTask / CommitTask
  ├─ StreamLoadHandler ── generatePlan (NereidsStreamLoadPlanner)
  └─ RoutineLoadManager (routineload/)
       └─ RoutineLoadJob ── KafkaRoutineLoadJob
            └─ RoutineLoadTaskInfo
```

`LoadJob` 继承 `AbstractTxnStateChangeCallback`，自身作为事务回调对象注册到 `GlobalTransactionMgr`，事务状态变化时被回调驱动状态机。

## 调用链路

Stream Load（HTTP 接入 → FE 选 BE → BE 直写 → 事务提交）：

```
LoadAction.streamLoad (LoadAction.java:102)
  → handleStreamLoadRedirect → selectRedirectBackend (round-robin 选 BE)
  → createRedirectResponse  // HTTP 307 重定向到 BE，客户端数据流直连 BE
[BE 收到数据后回 FE 取计划]
BE → FE thrift: streamLoadPut(TStreamLoadPutRequest)
  → StreamLoadHandler.generatePlan (StreamLoadHandler.java:274)
    → setCloudCluster → setDbAndTable
    → generatePlan(table) → NereidsStreamLoadPlanner.plan  // 产 TPipelineFragmentParams
    → TransactionState.addTableIndexes(table)  // 注册到事务
  → 返回 fragmentParams 给 BE
[BE 执行写入: DeltaWriter → MemTable → flush Rowset]
BE 发 commitTxn RPC → FE GlobalTransactionMgr 提交
  → LoadJob.afterCommitted → state=COMMITTED
  → LoadJob.afterVisible → state=FINISHED
```

Routine Load 调度（`RoutineLoadScheduler` 定时 daemon + `RoutineLoadTaskScheduler` 1ms 轮询）：

```
RoutineLoadScheduler.runAfterCatalogReady (RoutineLoadScheduler.java:54)
  → routineLoadManager.updateRoutineLoadJob
    → routineLoadJob.update  // 检查 db/table 存在性 + refreshKafkaPartitions
  → getNeedScheduleRoutineJobs → divideRoutineLoadJob(n)  // 按并发分配分区
RoutineLoadTaskScheduler.runAfterCatalogReady (1ms 轮询)
  → needScheduleTasksQueue.take → allocateTaskToBe
  → routineLoadTaskInfo.beginTxn → createRoutineLoadTask
  → submitTask(beId, tRoutineLoadTask)  // Thrift 发给 BE
[BE 消费 Kafka → commitTxn(attachment)]
  → RoutineLoadJob.afterCommitted → updateProgress(attachment)  // 更新 offset
  → afterVisible → unprotectRenewTask  // 创建新 task 循环
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `LoadManager.createLoadJob` | 创建 Job | 注册 txn callback + Label 去重 |
| `LoadJob.execute` | 调度入口 | unprotectedExecuteJob |
| `LoadJob.afterCommitted/afterVisible` | txn 回调 | 驱动状态机 COMMITTED/FINISHED |
| `StreamLoadHandler.generatePlan` | 生成导入计划 | NereidsStreamLoadPlanner |
| `RoutineLoadJob.divideRoutineLoadJob` | 分拆任务 | 按并发轮询分配 Kafka 分区 |
| `KafkaRoutineLoadJob.updateProgress` | 更新 offset | txn COMMITTED 后才前移 |
| `LoadManager.checkLabelUsed` | Label 幂等 | 双层 Map dbId→label→jobs |

</details>

## 核心实现

### Stream Load 走 BE 直写

`LoadAction.streamLoad`（`load/LoadAction.java:102`）选 BE 后 HTTP 307 重定向，客户端数据流直连 BE，**FE 不接触数据**——因为 Stream Load 是实时导入、数据量大且延迟敏感，FE 作为调度节点资源有限，数据流过 FE 会成瓶颈。FE 只负责选 BE + 生成计划（通过 `streamLoadPut` RPC）。云模式有 Group Commit Forward 二次转发（`handleStreamLoadRedirect` in `LoadAction.java:851`）保持同表亲和性。

### Broker Load 走 FE 编排

Broker Load 是批量导入 HDFS/S3 数据，延迟不敏感，需 FE 全局编排。三步走（`BrokerLoadJob.java:80` 注释）：`BrokerPendingTask`（扫文件列表 via Broker）→ `LoadLoadingTask`（按表分拆生成计划下发 BE）→ `CommitAndPublishTxn`。每步通过 `onTaskFinished(attachment)` 驱动下一步。事务的 begin/commit 都由 FE 主导。

### Job/Task 两级模型

`LoadJob`（`loadv2/LoadJob.java`）是调度和事务的单元，`LoadTask`（`loadv2/LoadTask.java`）是执行单元。一个 Job 挂多个 Task（`idToTasks`），Task 完成后通过 `LoadTaskCallback` 回调 Job（`onTaskFinished`/`onTaskFailed`）。`LoadJob` 继承 `AbstractTxnStateChangeCallback` 注册到 `GlobalTransactionMgr.getCallbackFactory()`（`LoadManager.java:186`），事务状态变化时由 transaction 模块回调：`beforeCommitted` → `afterCommitted` → `afterVisible`（或 `afterAborted`）。

### Label 幂等去重

`LoadManager.checkLabelUsed`（`loadv2/LoadManager.java:682`）用双层 Map `dbIdToLabelToLoadJobs: dbId → label → List<LoadJob>`。创建 Job 时检查同 label 下是否有未 CANCELLED 的 Job，有则抛 `LabelAlreadyUsedException`。已完成（FINISHED/CANCELLED）的 Label 保留 `label_keep_max_second` 秒后清理（`LoadJob.isExpired` in `LoadJob.java:1137`）允许复用。这保证 at-least-once 语义下的幂等性——网络重试不会重复导入。

### Routine Load 的 offset 管理

`KafkaProgress.partitionIdToOffset`（`routineload/KafkaProgress.java:58`）存的是**下一个待消费的 offset**。offset 更新时机是**事务 COMMITTED 后**才更新（`RoutineLoadJob.afterCommitted` → `updateProgress`）；若 txn ABORTED，offset 不前移（`KafkaRoutineLoadJob.checkCommitInfo` in `KafkaRoutineLoadJob.java:324`），保证不丢数据。Task 超时由 `processTimeoutTasks` 丢弃、创建新 task、对应 txn 被中止——旧 task 的 commit 不被接受。`unprotectNeedReschedule` 定期检查 Kafka 分区数变化重新调度。

### 状态机

`LoadJob` 状态机（`loadv2/JobState.java`）：`PENDING → LOADING → COMMITTED → FINISHED`，异常转 `CANCELLED`/`RETRY`/`UNKNOWN`。`unprotectedUpdateState`（`LoadJob.java:420`）做状态守卫，finalState 不可逆。`RoutineLoadJob` 状态机：`NEED_SCHEDULE → RUNNING → PAUSED/STOPPED/CANCELLED`，`executePause` 清空 task 列表，`executeNeedSchedule` 重新调度。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Job/Task 两级 | `LoadJob`/`LoadTask` | 解耦调度单元与执行单元，支持多 Task 并行 |
| 事务回调 | `AbstractTxnStateChangeCallback` | 导入状态由事务驱动，解耦导入与事务模块 |
| Label 幂等 | `LoadManager.checkLabelUsed` | at-least-once 下防重复导入 |
| 异步轮询 | `LoadJobScheduler`/`RoutineLoadTaskScheduler` | 常驻消费的周期调度与 slot 分配 |
| 状态机 | `JobState` 枚举 | 守卫合法转换，finalState 不可逆 |

## 模块间交互

调 `catalog`（`Env.getCurrentInternalCatalog().getDbOrDdlException` 取 Database，`StreamLoadHandler.setDbAndTable`）、`transaction`（`GlobalTransactionMgr.beginTransaction`/`getCallbackFactory().addCallback`，txn 提交/中止回调 LoadJob）、`rpc`（Stream Load 经 `TStreamLoadPutResult` 返回 `TPipelineFragmentParams`；Broker Load `LoadLoadingTask.executeOnce` → `Coordinator.exec` Thrift 下发；Routine Load `submitTask` → `BackendService.Client.submitRoutineLoadTask`）。BE 回调 FE 经 `streamLoadPut`/`commitTxn`/`reportLoadTxn` Thrift RPC。

## 扩展方式

新增导入方式（如 Pulsar Routine Load）：新建 `PulsarRoutineLoadJob extends RoutineLoadJob`（实现 `divideRoutineLoadJob`/`unprotectRenewTask`/`updateProgress`/`checkCommitInfo`）、`PulsarTaskInfo`、`PulsarProgress`；`LoadDataSourceType.java` 加 `PULSAR` 枚举；`RoutineLoadManager.createRoutineLoadJob` switch 加分支；`RoutineLoadDataSourcePropertyFactory` 加属性解析。

新增导入格式：`datasource/property/fileformat/` 加 `XxxFileFormatProperties`；BE 侧 `NereidsBrokerFileGroup` 支持 format 映射；`TFileFormatType` Thrift 加枚举；`BulkLoadJob.checkAndSetDataSourceInfoByNereids` 解析格式。

修改错误处理策略：`LoadJob.checkDataQuality`（`LoadJob.java:677`，Broker Load 错误率检查 `dpp.abnorm.ALL` vs `max_filter_ratio`）、`RoutineLoadJob.updateNumOfData`（`RoutineLoadJob.java:906`，`currentErrorRows > maxErrorNum || errorRate > maxFilterRatio` 时暂停）、`FailMsg`/`CancelType`（`load/FailMsg.java`）。
