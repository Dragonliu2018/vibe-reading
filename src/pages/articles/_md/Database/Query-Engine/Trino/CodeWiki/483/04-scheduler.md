---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "分布式调度"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "分布式调度", "数据本地性", "容错执行"]
description: "Trino 483 分布式调度：PipelinedQueryScheduler 全 stage 并行、NodeSelector 选点策略、HttpRemoteTask 双通道同步与容错调度"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

调度器把 `PlanFragment` 树变成**分布在 worker 集群上的 Task**：决定哪个 split 放哪个节点（数据本地性 vs 负载均衡的折中）、增量创建任务并与之保持状态同步、在反压与失败时做出正确反应。它是 coordinator "全局视野"的化身——节点清单、split 负载、拓扑距离只有它看得全。

范围：`execution/scheduler/`（含 `faulttolerant/` 子包）+ `node/`（发现与注册）+ `server/HttpRemoteTaskFactory.java` + `server/remotetask/`。

## 模块架构

三套调度器按 RetryPolicy 分派（`SqlQueryExecution.planDistribution`，SqlQueryExecution.java:538）：**PipelinedQueryScheduler**（QUERY/NONE，内存直连流式执行）与 **EventDrivenFaultTolerantQueryScheduler**（TASK，落盘 exchange + task 级重试）。Pipelined 的本体只管装配与 query 级重试，stage 树调度在内嵌的 `DistributedStagesScheduler`（含独立状态机：PLANNED→RUNNING→终态）与根 stage 的 `CoordinatorStagesScheduler`。

## 调用链路

```
SqlQueryExecution.planDistribution (:538)
 └─ PipelinedQueryScheduler.start() (:268)
     ├─ CoordinatorStagesScheduler.schedule (:719)
     │   └─ 根 stage 在 coordinator 本机 scheduleTask(selectCurrentNode, 0)
     │       （仍经 HttpRemoteTask 走 loopback HTTP——统一路径）
     └─ executor.submit(distributedStagesScheduler::schedule)  # @ForQueryExecution
         └─ DistributedStagesScheduler.schedule (:1290)
             ├─ createStageScheduler 按 partitioning handle 四选一：
             │   SOURCE_DISTRIBUTION → SourcePartitionedScheduler（单源）
             │                        / MultiSourcePartitionedScheduler（多源）
             │   SCALED_WRITER_ROUND_ROBIN → ScaledWriterScheduler
             │   纯 remote 源 → FixedCountScheduler
             │   本地源+bucket 约束 → FixedSourcePartitionedScheduler
             ├─ 全部 stageScheduler.start() 后进入循环：
             │   while (!executionSchedule.isFinished())
             │       getStagesToSchedule() 逐 stage 调 schedule() 得 ScheduleResult
             │       全 blocked → whenAnyComplete(futures) 挂起（≤1s 重扫）
             └─ SourcePartitionedScheduler.schedule (:228)
                 ├─ splitSource.getNextBatch(splitBatchSize)   # 异步批量
                 ├─ splitPlacementPolicy.computeAssignments
                 │   └─ NodeSelector.computeAssignments         # 选点
                 ├─ 节点已有 task → task.addSplits
                 │   否则 stageExecution.scheduleTask (:289)
                 │       → SqlStage.createTask → remoteTaskFactory
                 │         .createRemoteTask (HttpRemoteTaskFactory.java:139)
                 │       → new HttpRemoteTask + task.addSplits/task.start
                 └─ 反压：SPLIT_QUEUES_FULL blocked future（low watermark=50% 队容量）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `schedule` in DistributedStagesScheduler.java:1290 | stage 树调度主循环 | blocked future 挂起≤1s 重扫，事件唤醒 |
| `schedule` in SourcePartitionedScheduler.java:228 | split 批次→节点→task | 动态过滤就绪时 unblock 等待中的 scan |
| `scheduleTask` in PipelinedStageExecution.java:289 | 建 task 并接线上下游 | TaskLifecycleListener 是 stage 间接线索 |
| `computeAssignments` in UniformNodeSelector.java | 候选节点选择 | minCandidates 随机候选防热点 |
| `addSplits` in HttpRemoteTask.java | 增量推送 split | pendingRequestsCounter 单飞合并请求 |
| `createExchangeSplit` in PipelinedStageExecution | 上游 results URL 包成 RemoteSplit | exchange 只是 URL——task 间直连 |

</details>

## 核心实现

### HttpRemoteTask：双通道同步

推送通道：`triggerUpdate()` → `sendUpdateInternal()` POST `/v1/task/{id}`（TaskUpdateRequest：splits + outputBuffers + dynamic filter domains，**PlanFragment 仅首个请求携带**，响应 TaskInfo 用于移除已 ack 的 split）。拉取通道：`ContinuousTaskStatusFetcher` 长轮询 GET `/v1/task/{id}/status`（版本化长轮询），`TaskInfoFetcher` 周期取 info，`DynamicFiltersFetcher` 取动态过滤域。通信故障用 `RequestErrorTracker`+`Backoff` 限速，超 `maxErrorDuration` 本地判死。反压经 `whenSplitQueueHasSpace(lowWatermark)` 回传给 NodeScheduler。

### NodeSelector：本地性与均衡的同场博弈

`NodeScheduler` 本体极薄（只持 `NodeSelectorFactory`），策略在两个实现里：

- **UniformNodeSelector**：`chooseNodeForSplit` 取 queued weight 最小者；本地性规则——`!split.isRemotelyAccessible()` 时 host 精确匹配、`optimizedLocalScheduling` 优先亲和地址；
- **TopologyAwareNodeSelector**：`calculateMinPendingSplitsWeightPerTask`（:218）算 `queueFraction = 0.5*(1+splitAffinity/totalDepth)`——**零亲和 split 只能占半队列，满深度（同机架）可占满**，为本地性预留容量、防跨机架洪泛；选址从最深 NetworkLocation 逐层放宽。

防热点三件套：`minCandidates` 随机候选、`maxUnacknowledgedSplitsPerTask` 未 ack 上限（防推送雪崩）、`QueueSizeAdjuster` 动态调慢节点队列（满则 ×2、每秒缩 1/1.5）。选哪个策略由配置 `node-scheduler.policy`（UNIFORM/TOPOLOGY）在 CoordinatorModule.java:283 切换 Module 安装。

### 反压与死锁防御

pipelined 执行里全部 stage 同刻调度、exchange 是 task 间直连流式缓冲，反压链条：下游 `outputBufferStatus` overutilized → `anySourceTaskBlocked` → `SourcePartitionedScheduler.schedule`（:335）unblock 动态过滤 + `finalizeTaskCreationIfNecessary()`——**防 broadcast join 双侧互等死锁**（build 侧等 probe 建 buffer、probe 等 build 完成的经典环）。

### 容错调度：为什么必须 EventDriven + 落盘

`RetryPolicy.TASK` 要单 task 可重启，前提是中间结果不驻内存——exchange 落盘到 ExchangeManager（插件化的 `FileSystemExchangeManager`，存储后端 Local/S3/AzureBlob 三选一），task 可在任意节点重放分区数据。调度器是单线程事件循环：`Scheduler.run()` → `processEvents()` 批量 drain（≤100 事件）+ `SchedulingDelayer` 合并，避免昂贵的 `schedule()`（optimize→updateStageExecutions→scheduleTasks）被每事件触发。stage 满足 `isReadyForExecution`（子 stage 全完成）才建执行；split→partition 由 `SplitAssigner` 三实现（Hash/Arbitrary/Single）决定；节点经 `NodeAllocator`（BinPacking 按 NodeRequirements+内存装箱，含 EAGER_SPECULATIVE/SPECULATIVE 投机执行）；`TaskDescriptorStorage` 持久化 task 描述符使重试 task 免向 coordinator 取 plan。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略+工厂 | NodeSelectorFactory（CoordinatorModule.java:283）/ ExecutionPolicy MapBinder（:424） | 选点策略与执行策略都是配置期决策点 |
| 事件驱动 | 三层 StateMachine + TaskLifecycleListener | 状态变化沿 listener 链自动传播 |
| 装饰器 | MemoryTrackingRemoteTaskFactory | 内存统计叠加在 RemoteTask 外 |

## 模块间交互

- **上游**：`SqlQueryExecution.planDistribution` 构造调度器；ExecutionPolicy 由会话属性从 MapBinder 注册表按名取出（SqlQueryExecution.java:890）；
- **split 来源**：`SplitSourceFactory.createSplitSources` → `SplitSource`（io.trino.split，connector 供给，见[SPI 与连接器框架](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/07-spi-connector-framework)）；
- **负载回报**：`NodeTaskMap.PartitionedSplitCountTracker` 回写每节点 split 负载供 `NodeAssignmentStats` 决策；
- **节点发现**：`AnnounceNodeAnnouncer`（node/AnnounceNodeAnnouncer.java）每 5 秒 POST `/v1/announce` 向 coordinator 自注册（483 默认 ANNOUNCE 模式），`CoordinatorNodeManager.startPollingNodeStates` 每 5s 轮询 worker `/v1/state` 得五态。

## 扩展方式

**新增节点选择策略**：实现 NodeSelector + NodeSelectorFactory + Guice Module bind `NodeSelectorFactory`；`NodeSchedulerConfig.NodeSchedulerPolicy` 枚举增项并在 `CoordinatorModule.java:283` 的 switch 加分支。

**调整调度并发**：`NodeSchedulerConfig`（node-scheduler.min-candidates / max-splits-per-node / min-pending-splits-per-task / max-unacknowledged-splits-per-task / splits-balancing-policy）；split 批大小 `QueryManagerConfig` 的 `query.schedule-split-batch-size`（默认 1000）。

**新增 split source 类型**：connector 侧实现 `ConnectorSplitSource`，经 SplitSourceFactory 进 `SourcePartitionedScheduler.getNextBatch`；split 的 weight/addresses/remotelyAccessible 直接决定放置行为。
