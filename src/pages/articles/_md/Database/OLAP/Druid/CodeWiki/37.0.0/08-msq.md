---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "多阶段查询引擎 MSQ"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "MSQ", "DAG", "kernel", "shuffle"]
description: "Druid MSQ 多阶段查询引擎——ControllerQueryKernel 纯状态机 DAG 调度、ShuffleKind 四类、frame 流水线、ControllerStagePhase 状态机、容错重试、kernel/IO 分离。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（`multi-stage-query/.../msq/`）是 Druid 新一代**分布式 SQL 执行引擎**：把 SQL 编译为多 stage DAG，由 Controller kernel 调度到 worker 以 frame 流水线执行，支持 shuffle、join、INSERT/REPLACE，弥补旧 SQL 引擎（见 Druid SQL 模块）只能单段查询的不足。职责边界：**复杂 SQL 的多阶段分布式执行**；SQL 规划复用 Druid SQL 模块的 Calcite，task 框架复用摄入引擎/Overlord 的 indexing 基础设施。

## 模块架构

![MSQ 多阶段执行 DAG](/vibe-reading/images/articles/druid-internals/msq-dag.svg)

四层：规划层（SQL→`MSQSpec`→`QueryDefinition` DAG）、调度层（`ControllerImpl` + `ControllerQueryKernel` 纯状态机管 stage DAG 拓扑/并发/容错）、执行层（`MSQWorkerTask` + `WorkerImpl` + `WorkerStageKernel` 跑 `StageProcessor`，frame 流水线读写）、基础设施层（复用 indexing task 框架、processing frame 协议、segment 读写）。核心设计是**决策与 I/O 分离**：kernel 不做 RPC、不碰数据。

## 调用链路

```
SQL（sql 模块 Calcite 规划）→ MSQTaskSqlEngine.buildQueryMakerForSelect/Insert
  → MSQTaskQueryMaker.runQuery → buildLegacyMSQSpec → overlordClient.runTask(MSQControllerTask)
MSQControllerTask.runTask(toolbox)  [indexing/MSQControllerTask.java:267]
  → IndexerControllerContextFactory → new ControllerImpl
  → ControllerHolder.runAsync → ControllerImpl.run → runInternal  [ControllerImpl.java:398]
    1. initializeQueryDefAndState  [L724]
       → QueryKitBasedMSQPlanner.makeQueryDefinition（native query → QueryDefinition DAG）
       → QueryValidator.validateQueryDef → newWorkerManager
    2. RunQueryUntilDone.run()  [L2293] 主循环
       a. startStages（从 stageGroupQueue 取 ready → createWorkOrders → contactWorkersForStage 发送）
       b. fetchStatsFromWorkers（GLOBAL_SORT 拉 key statistics 合并）
       c. sendPartitionBoundaries（合并后发 workers）
       d. readQueryResults（final stage 可读 → ControllerQueryResultsReader）
       e. cleanUpEffectivelyFinishedStages（postCleanupStage → FINISHED）
       f. retryFailedTasks（容错重跑）
       g. runKernelCommands（处理 kernelManipulationQueue 回调）
    3. handleQueryResults（ingestion: 分配 segment id + publishAllSegments；export: writeMetadata）
MSQWorkerTask.runTask → WorkerImpl.run → runInternal  [WorkerImpl.java:168]
  → 收 WorkOrder → WorkerStageKernel.create → startReading → 读上游 frame
  → StageProcessor.execute（读写 frame）→ postResultsComplete → postCleanupStage
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ControllerImpl.runInternal` | 主循环 | 七步调度 |
| `ControllerQueryKernel.registerStagePhaseChange` | DAG 状态推进 | inflow/outflow/pending map |
| `ControllerQueryKernel.createWorkOrders` | 生成 worker 工单 | 按 stage + maxWorkerCount |
| `StageProcessor.execute` | worker 计算 | 返回 future，写 frame |
| `StageDefinition.createFrameWriterFactory` | frame writer | 按 shuffle kind 决定排序 |
| `MSQControllerTask.isReady` | 前置检查 | REPLACE 先取全 interval 锁 |

</details>

## 核心实现

### Controller + ControllerQueryKernel：DAG 状态机

`Controller`（`exec/Controller.java`）接口是 per-query 的，`ControllerImpl`（`exec/ControllerImpl.java`）持 `MSQSpec`、`ControllerContext`、`BlockingQueue<Consumer<ControllerQueryKernel>> kernelManipulationQueue`（**核心**：所有 kernel 操作经队列单线程执行保线程安全）、`WorkerManager`、`WorkerClient`。`ControllerQueryKernel`（`kernel/controller/ControllerQueryKernel.java`）是**纯状态机**，注释明确"Kernels do not do any RPC or deal with any data"。它持 `stageTrackers`、`inflowMap`（stage→输入 stage 集）、`outflowMap`、`pendingInflowMap`（运行时待完成 inflow，完成移入 `readyToRunStages`）、`stageGroupQueue`（`StageGroup` 分组，同组用 MEMORY 通信）、`effectivelyFinishedStages`。`registerStagePhaseChange`（L756）是 DAG 调度核心：stage 结果可读时从 pendingInflowMap 移除并标下游 ready，无下游依赖时标 effectively finished。

### StageDefinition / ShuffleKind / frame

`kernel/StageDefinition.java` 持 `StageId`、`List<InputSpec>`、`IntSet broadcastInputNumbers`、`StageProcessor`、`RowSignature`、`maxWorkerCount`、`ShuffleSpec`。`QueryDefinition`（`kernel/QueryDefinition.java`）持 `Map<StageId, StageDefinition>` 与唯一 `finalStage`（`create` 验证 DAG 只有一个 root）。`ShuffleKind` 四类：`MIX`（一 partition，不需统计）、`HASH`（hash 分区，**支持流水线**）、`HASH_LOCAL_SORT`（hash+partition 内排序，不支持流水线）、`GLOBAL_SORT`（需先收集 key statistics→controller 合并→生成分区边界→worker 按边界排序）。frame 是 stage 间统一数据格式（来自 processing 模块），`OutputChannelMode`：`MEMORY`（worker 间 RPC，支持流水线）/`DURABLE`（落盘，用于 GLOBAL_SORT 与容错）。背压：frame channel 有界，consumer 慢则 producer 阻塞。

### MSQControllerTask task 化 + SqlEngine 替换

`indexing/MSQControllerTask.java`（`@JsonTypeName("query_controller")`）继承 `AbstractTask`，实现 `ClientTaskQuery`/`PendingSegmentAllocatingTask`，本身就是 indexing task（由 Overlord 调度）。`runTask` 建 `IndexerControllerContext` 构造 `ControllerImpl` 经 `ControllerHolder.runAsync` 异步跑。`isReady` 对 REPLACE 的 INSERT 先取全 interval time chunk lock。`MSQWorkerTask`（`@JsonTypeName("query_worker")`）也继承 `AbstractTask`，由 `WorkerManager` 经 `MSQWorkerTaskLauncher` 动态启，复用 peon/indexer 基础设施。接入 SQL：`MSQTaskSqlEngine`（`sql/MSQTaskSqlEngine.java`）实现 `SqlEngine`，`MSQSqlModule`（`guice/MSQSqlModule.java`，`@LoadScope(BROKER)`）绑定它替换默认 `NativeSqlEngine`——**复用 sql 模块 Calcite 规划，但替换执行后端**（不再 Broker 单段执行，而包装 native query 为 `LegacyMSQSpec` 提交 `MSQControllerTask`）。`featureAvailable`（L150）声明 MSQ 支持 INSERT/REPLACE/WINDOW/UNNEST，不支持 TIMESERIES/TOPN（仍走旧引擎）。

### 容错重试与 durable storage

`ControllerQueryKernelConfig.isFaultTolerant()` 控制容错。`WorkerManager` 实现 `RetryCapableWorkerManager`，worker 失败（`WorkerFailedFault`/`WorkerRpcFailedFault`/`CanceledFault` 等 retriable fault）经 `addToRetryQueue`（`ControllerImpl.java:823`）重入队列，`retryFailedTasks`（L2390）重启 worker 重发 WorkOrder，stage 转 `RETRYING`。`RETRIABLE_ERROR_CODES`（kernel L154：`CanceledFault.CODE`/`UnknownFault.CODE`/`WorkerRpcFailedFault.CODE`）。durable storage（`isDurableStorage`）：stage 中间结果写持久存储（S3/HDFS），用于容错（worker 失败可重读上游输出）、GLOBAL_SORT（需写完所有输出再读）、大结果落盘；`cleanUpDurableStorageIfNeeded`（L1927）清理。

### kernel/IO 分离设计

两个 kernel（`ControllerQueryKernel`/`WorkerStageKernel`）都是纯状态机，所有 I/O（发 WorkOrder、拉 statistics、读 frame）由 `ControllerImpl`/`WorkerImpl` 在 kernel 外执行，经 `doWithStageTracker` 或 `kernelManipulationQueue` 把状态变更送入 kernel。ControllerImpl 注释："This ensures that all manipulations on ControllerQueryKernel, and all core logic, are run in a single-threaded manner." 这分离让决策逻辑集中可读、可测试，I/O 错误不污染状态机。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| DAG 调度 | `ControllerQueryKernel`（inflow/outflow/pending） | stage 依赖与拓扑序 |
| 状态机 | `ControllerStagePhase`/`WorkerStageKernel` | 决策与 I/O 分离 |
| 生产者-消费者 | `StageProcessor` + frame channel | stage 间流式数据 |
| Task 化 | `MSQControllerTask`/`MSQWorkerTask` 继承 `AbstractTask` | 复用 indexing 框架 |
| 策略 | `ShuffleKind`/`OutputChannelMode` | shuffle/通道模式可换 |

## 模块间交互

与 `sql`：复用 Calcite 规划（`MSQTaskSqlEngine` 替换 `SqlStatementFactory` 的 engine，`MSQSqlModule` L75）。与 `indexing-service`：task 继承 `AbstractTask`、经 `TaskActionClient` 执行 `SegmentAllocateAction`/`SegmentTransactionalInsertAction`/`LockListAction`，`WorkerManager` 经 `MSQWorkerTaskLauncher` 管 worker。与 `processing`：`FrameReader`/`FrameWriterFactory`/`FrameProcessorExecutor`/`ReadableFrameChannel`/`OutputChannel`。与 `segment`：ingestion final stage 用 `SegmentGeneratorStageProcessor` 生成 `DataSegment`，`publishAllSegments` 经 transaction action 发布。Controller 本身是 indexing task，由 Overlord 调度，与 Overlord 是 task/调度关系。

## 扩展方式

- **新增 stage 算子**：实现 `StageProcessor<R, ExtraInfoType>`（`execute(ExecutionContext)` 读输入 frame、计算、写输出 frame），注册 `@JsonTypeInfo` type，在 `MultiQueryKit` 接入算子映射；如需新 `ShuffleSpec` 实现接口注册 `@JsonSubTypes`（`kernel/ShuffleSpec.java:32`），可能改 `StageDefinition.createFrameWriterFactory` 排序逻辑。
- **改调度策略**：改 `ControllerQueryKernelUtils.computeStageGroups` 划分 / `ControllerQueryKernelConfig.getMaxConcurrentStages` 并发 / `WorkerAssignmentStrategy` worker 分配 / `registerStagePhaseChange` 清理时机 / `RETRIABLE_ERROR_CODES` 重试策略。
- **新增 frame 编码**：改 processing 的 `FrameWriterFactory`/`FrameReader`，MSQ 经 `StageDefinition.createFrameWriterFactory`（L399）使用；如需新通道模式实现 `OutputChannelFactory` 接入 `ControllerImpl.startQueryResultsReader` 与 `WorkerImpl`。
