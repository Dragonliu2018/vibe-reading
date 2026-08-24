---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "数据导入"
date: "2026-08-24T10:22:21+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.7-rc01"]
tags: ["Apache Doris", "StreamLoad", "RoutineLoad", "2PC", "Transaction", "PublishVersion"]
description: "Doris 2.1.7 数据导入：Stream/Broker/Routine Load + GlobalTransactionMgr 两阶段提交（COMMITTED→VISIBLE）+ PublishVersionDaemon 异步发布。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.7-rc01/00-overview)

---

## 模块定位

数据导入是 `fe/fe-core/src/main/java/org/apache/doris/load/`（~2.9 万行）+ `transaction/`（~6 千行）+ `task/`（~5 千行），负责写路径——Stream Load（HTTP 推）、Routine Load（Kafka 消费）、Broker Load（HDFS 读取）、Insert。核心是 `GlobalTransactionMgr` 的两阶段提交：先 COMMITTED（数据安全写入）再 VISIBLE（发布版本使数据对查询可见）。独立成文是因为导入与查询是分离的编排路径——导入走事务状态机，查询走 Fragment 调度，两者通过版本号解耦。

## 模块架构

```
LoadManager (load/loadv2/LoadManager.java) ── Broker/Spark Load 调度
   ├─ idToLoadJob / dbIdToLoadJobs
   └─ LoadJobScheduler loadJobScheduler

GlobalTransactionMgr (transaction/GlobalTransactionMgr.java:75) ── 全局事务管理器
   └─ Map<dbId, DatabaseTransactionMgr> dbIdToDatabaseTransactionMgrs  ── per-db 隔离
       └─ DatabaseTransactionMgr (transaction/DatabaseTransactionMgr.java:107)
            ├─ beginTransaction() (:342)     ── 创建 TransactionState(PREPARE)
            ├─ commitTransaction() (:712)     ── 校验 quorum + 状态→COMMITTED
            ├─ finishTransaction() (:1026)    ── publish 完成→VISIBLE
            └─ abortTransaction() (:1605)

TransactionState (transaction/TransactionStatus.java:20)
   └─ PREPARE(1) → PRECOMMITTED(5) → COMMITTED(2) → VISIBLE(3) / ABORTED

RoutineLoadJob (load/routineload/RoutineLoadJob.java) ── Kafka 消费作业
   └─ JobState: NEED_SCHEDULE → RUNNING → PAUSED/STOPPED/CANCELLED

AgentBatchTask (task/AgentBatchTask.java) ── 按 BE 分组下发
   └─ run() 遍历 backendId → Thrift client.submitTasks() 批量下发
```

## 调用链路

Stream Load 完整流程（HTTP → BE 写入 → 事务提交 → 发布版本）：

```
HTTP PUT /api/{db}/{table}/_stream_load
  → LoadAction.streamLoad() [httpv2/rest/LoadAction.java:90]
    → selectRedirectBackend() (:365)  ── BeSelectionPolicy 选 BE
    → redirectTo(redirectAddr)         ── HTTP 307 重定向到 BE
      ─── BE 通过 Thrift RPC 回调 FE ───
  → loadTxnBegin() [service/FrontendServiceImpl.java:1137]
    → GlobalTransactionMgr.beginTransaction() [:118]
      → DatabaseTransactionMgr.beginTransaction() [:342]
        → idGenerator.getNextTransactionId() + 创建 TransactionState(PREPARE)
        → unprotectUpsertTransactionState()  ── 持久化到 EditLog
  → streamLoadPut() [FrontendServiceImpl.java:1928]
    → StreamLoadPlanner.plan() [planner/StreamLoadPlanner.java:121]
      → 生成 TExecPlanFragmentParams（ScanNode + OlapTableSink）
  → [BE 执行 fragment：DeltaWriter → MemTable → flush Rowset]
  → loadTxnCommit() [FrontendServiceImpl.java:1546]
    → commitAndPublishTransaction() [GlobalTransactionMgr.java:267]
      → commitTransactionWithoutLock()  ── 状态→COMMITTED
        → DatabaseTransactionMgr.commitTransaction() [:712]
          → checkCommitStatus()  ── 校验 TabletCommitInfo quorum
          → updateCatalogAfterCommitted() [:1987]  ── partition.setNextVersion()
      → [异步] PublishVersionDaemon.runAfterCatalogReady() [transaction/PublishVersionDaemon.java:55]
        → genPublishTask() → AgentBatchTask → 下发 PublishVersionTask 到 BE
        → tryFinishOneTxn()  ── 全部 BE 成功后
          → finishTransaction() [:1026]  ── 状态→VISIBLE
            → updateCatalogAfterVisible() [:2046]  ── partition.updateVisibleVersion()
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `GlobalTransactionMgr.beginTransaction` | 开事务 | per-db 隔离，requestId 幂等去重 |
| `DatabaseTransactionMgr.commitTransaction` | 提交校验 | quorum 副本校验，COMMITTED 不改 visibleVersion |
| `DatabaseTransactionMgr.finishTransaction` | publish 完成 | 统一推进 visibleVersion 保证原子可见 |
| `PublishVersionDaemon.runAfterCatalogReady` | 异步发布 | 独立 daemon 周期扫描 COMMITTED 事务 |
| `RoutineLoadJob.processTimeoutTasks` | 超时重建 | failover：超时任务重建 + 旧 txn abort |
| `AgentBatchTask.run` | 批量下发 | 按 backendId 分组，一个 BE 一个 RPC |

</details>

## 核心实现

### 两阶段提交与 COMMITTED/VISIBLE 分离

`TransactionStatus`（`transaction/TransactionStatus.java:20`）定义 5 状态：`PREPARE(1) → PRECOMMITTED(5) → COMMITTED(2) → VISIBLE(3)` + `ABORTED`。两阶段（2PC）通过 HTTP header `txn_operation` 控制（`LoadAction.streamLoad2PC()` in `LoadAction.java:229`）：BE 先 `loadTxnBegin`，写入后 `loadTxnCommit`；显式 2PC 场景 BE 先请求 precommit（`preCommitTransaction2PC()` in `DatabaseTransactionMgr.java:428`，PREPARE→PRECOMMITTED），客户端确认后再 commit（PRECOMMITTED→COMMITTED）。

COMMITTED 与 VISIBLE 分离设计：commit 阶段只 `partition.setNextVersion()`（预分配版本号，`updateCatalogAfterCommitted()` in `:1987`），不改 visibleVersion；publish 阶段由 `PublishVersionDaemon` 异步下发 `PublishVersionTask` 到 BE 让 replica apply 版本，全部成功才 `updateVisibleVersion()`（`updateCatalogAfterVisible()` in `:2046`）。commit 快速返回（用户知道数据已安全），publish 异步不阻塞；publish 失败可重试不影响 commit；查询只看 visibleVersion 保证一致性。

### Routine Load failover

`RoutineLoadJob.JobState`（`load/routineload/RoutineLoadJob.java`）：`NEED_SCHEDULE → RUNNING → NEED_SCHEDULE`（循环消费），可 `PAUSED`（错误暂停，可 resume）/`STOPPED`/`CANCELLED`（终态）。failover 机制：
- **任务超时重建**：`processTimeoutTasks()` 超时任务 `unprotectedRenewTask()` 创建新任务，旧 txn 超时 abort
- **BE 宕机 abort**：`GlobalTransactionMgr.abortTxnWhenCoordinateBeDown()` 主动 abort 该 BE 上所有 PREPARE 事务
- **进度持久化**：`updateProgress()`（`load/loadv2/LoadJob.java:224`）将 Kafka offset 持久化到 `RLTaskTxnCommitAttachment`，txn commit 时 replay 保证不丢消费位点

### Callback 模式与 requestId 幂等

`LoadJob extends AbstractTxnStateChangeCallback`（`loadv2/LoadJob.java:83`）。`AbstractTxnStateChangeCallback`（`transaction/AbstractTxnStateChangeCallback.java:22`）定义 `beforeCommitted()`/`afterCommitted()`/`afterAborted()`/`afterVisible()` 等 hook。事务状态变更时 `TransactionState.afterStateTransform()` 触发回调，通知 LoadJob 更新状态。

`DatabaseTransactionMgr.beginTransaction()`（`:342`）检查 requestId 匹配，若重复则抛 `DuplicatedRequestException` 返回已有 txnId——保证 BE 网络超时重试不重复开事务。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两阶段提交 | `DatabaseTransactionMgr.preCommitTransaction2PC` in `:428` | 多副本要么全可见要么全不可见 |
| 状态机 | `RoutineLoadJob.JobState` in `load/routineload/RoutineLoadJob.java` | Routine Load 持续消费，失败需自动恢复 |
| Callback | `AbstractTxnStateChangeCallback` in `transaction/AbstractTxnStateChangeCallback.java:22` | 事务状态变更通知 LoadJob 更新 |
| 任务分发 | `AgentBatchTask.run` in `task/AgentBatchTask.java` | 按 BE 分组，18 种 TTaskType switch 分发 |

## 模块间交互

`load` 调用 catalog 元数据（`Env.getCurrentInternalCatalog().getDb()`）、通过 task 下发 BE（`AgentBatchTask` + `AgentTaskExecutor.submit()`）、`transaction` 协调多表事务（`GlobalTransactionMgr` 持有 per-db `DatabaseTransactionMgr`，`commitTransaction` 遍历多表校验每个 Tablet quorum）。被调用方：`LoadAction`（HTTP）、`FrontendServiceImpl`（Thrift BE 回调）、SQL `InsertStmt`、`RoutineLoadScheduler`（MasterDaemon）。

## 扩展方式

**新增一种导入方式**：参照 `BrokerLoadJob.java`，继承 `BulkLoadJob`（`loadv2/BulkLoadJob.java`），实现 `beginTxn()`（调 `beginTransaction` 传 `BATCH_LOAD_JOB` sourceType）和 `unprotectedExecuteJob()`（创建对应 PendingTask）；在 `TransactionState.LoadJobSourceType`（`TransactionState.java:71`）新增枚举；在 `LoadManager.createLoadJobFromStmt()` 添加创建分支。对应测试：`regression-test/suites/load/`。
