---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "内存与资源管理"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "内存管理", "spill", "资源组"]
description: "Trino 483 内存治理：MemoryPool 记账、revocable memory 与 spill、LowMemoryKiller 策略、资源组公平排队"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

Trino 是内存计算引擎，但"内存"在它这里被精确治理：**逐层记账（算子→driver→task→query→池）、两类语义（user vs revocable）、三条退路（阻塞、spill、杀查询）**。这个模块是所有这些机制的家，外加 coordinator 侧的资源组排队（多租户公平准入）。

范围：`memory/` + `spiller/` + `execution/resourcegroups/` + `execution/ClusterSizeMonitor.java` + `lib/trino-memory-context`（独立 Maven 模块的记账树）。

一个重要的 483 实况修正：**worker 只有单池**。`LocalMemoryManager` 构造仅建一个 `MemoryPool(maxHeap - heapHeadroom)`；历史上的 reserved/system 双池已移除（`NodeMemoryConfig` 的 `@DefunctConfig` 列出 `experimental.reserved-pool-disabled`）。真正的二元划分是 **user / revocable 两类记账**，而非两池。

## 模块架构

四块：**记账树**（lib/trino-memory-context 的 AggregatedMemoryContext 链）汇入 **每查询 QueryContext** 再入 **每节点 MemoryPool**；coordinator 的 **ClusterMemoryManager** 周期拉取全集群内存并驱动 **LowMemoryKiller**；worker 的 **MemoryRevokingScheduler** 触发 spill；**resourcegroups** 在查询诞生前做准入。

## 调用链路

```
算子 reserve 内存：
OperatorContext（构造时从 Driver 传入 MemoryTrackingContext 建两层 context）
 └─ 算子调 localUserMemoryContext.setBytes(bytes)
     └─ SimpleLocalMemoryContext → ChildAggregatedMemoryContext.updateBytes
         → …逐层上传… → RootAggregatedMemoryContext.updateBytes
             └─ QueryMemoryReservationHandler.reserveMemory(tag, delta)
                 （QueryContext.addTaskContext :252 注册的 lambda）
                 └─ QueryContext.updateUserMemory (:164)
                     ├─ enforceUserMemoryLimit：超 maxUserMemory 抛
                     │   exceededLocalUserMemoryLimit（错误信息附 Top-3 Consumers，
                     │   来自池的 taggedMemoryAllocations）
                     └─ MemoryPool.reserve(taskId, tag, delta)
                         ├─ 记账；池满 → NonCancellableMemoryFuture（禁 cancel）
                         │   返回 blocked future（算子阻塞）
                         └─ onMemoryReserved() 通知 CopyOnWriteArrayList<MemoryPoolListener>

集群 OOM（coordinator，QueryManager 1s 周期）：
ClusterMemoryManager.process
 ├─ updateNodes()：每节点 RemoteNodeMemory（HTTP GET /v1/memory，节流 1s；
 │   worker 端 MemoryResource @Path("/v1/memory") 返回 MemoryInfo）
 ├─ ClusterMemoryPool.update 聚合得 blockedNodes
 ├─ isClusterOutOfOOM 判定 && isLastKillTargetGone()
 │   └─ callOomKiller：按 [taskKiller, queryKiller] 顺序 chooseTargetToKill
 │       → failTask / query.fail(CLUSTER_OUT_OF_MEMORY)，记 lastKillTarget 防重复杀
 └─ ClusterMemoryLeakDetector + 全局 maxQueryMemory 超限 fail

spill（worker）：
MemoryPool.reserve 池使用率 > memory-revoking-threshold(0.9) 且 reservedRevocableBytes>0
 └─ MemoryPoolListener.onMemoryReserved
     └─ MemoryRevokingScheduler.onMemoryReserved（另有 1s 周期兜底）
         └─ requestMemoryRevoking：目标回收量 = -freeBytes + max*(1-0.5)
             用 TraversingQueryContextVisitor 遍历 OperatorContext
             （扣除回收中字节）→ operatorContext.requestMemoryRevoking()
             → 置标志 + 触发 memoryRevocationRequestListener
                 → Driver.initialize 注册的 listener 置 driverBlockedFuture 唤醒
                 → 可 spill 算子检查 isMemoryRevokingRequested() → Spiller.spill(...)
                    完成后 resetMemoryRevokingRequested()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `reserve` in MemoryPool.java | user 内存记账 | 池满返回 blocked future 而非拒绝 |
| `reserveRevocable` in MemoryPool.java | revocable 记账 | 允许 over-commit（freeBytes 可为负） |
| `updateUserMemory` in QueryContext.java:164 | per-query 限额执行 | 超限抛错带 Top-3 Consumers |
| `chooseTargetToKill` in LowMemoryKiller.java | OOM 时选牺牲者 | 返回 KillTarget（整查询或 task 集合） |
| `requestMemoryRevoking` in MemoryRevokingScheduler.java | 触发 spill | 算回收量时扣除进行中的回收 |

</details>

## 核心实现

### user vs revocable：把"能否让出"编进类型系统

user memory 满池即阻塞（future），不可撤销；revocable 允许池 over-commit（freeBytes 为负）——因为算子有 spill 退路，可被 `MemoryRevokingScheduler` 回收。总量由 `maxQueryTotalMemory`（默认 2× maxQueryMemory）封顶防滥用。这个划分让"可牺牲的内存"有了显式预算语义，而不是隐式的"尽量别用太多"。

### LowMemoryKiller：四种杀法

```java title="memory/LowMemoryKiller.java"
public interface LowMemoryKiller {
    Optional<KillTarget> chooseTargetToKill(List<RunningQueryInfo> runningQueries,
                                            List<MemoryInfo> nodes);
}
// KillTarget: wholeQuery(QueryId) 或 selectedTasks(Set<TaskId>)
```

四个实现的取舍：`TotalReservationLowMemoryKiller`（总量最简单但会误杀接近完成的大查询）、`LeastWastedEffortTaskLowMemoryKiller`（以 `memoryUsed/max(wallTime,30s)` 杀"单位工作量最耗内存"者——保留已投入大量计算的查询）、`TotalReservationOnBlockedNodesQueryLowMemoryKiller`（只看真正缺内存节点的占用——避免杀掉占内存但不在瓶颈节点上的查询）、`NoneLowMemoryKiller`。fault-tolerant（RetryPolicy.TASK）查询杀单个 task 可重试，故 **task killer 先于 query killer**。绑定在 `CoordinatorModule.java` L235-263 按配置 enum 经 `@ForQueryLowMemoryKiller`/`@ForTaskLowMemoryKiller` 限定注入。

### 资源组：查询诞生前的第一道闸

`DispatchManager.createQueryInternal`（L230 `selectGroup(SelectionCriteria)` 选组 → L256 `resourceGroupManager.submit`）——查询在生成执行计划**之前**入组排队。`InternalResourceGroup`：`canQueueMore/canRunMore` 自叶向根聚合判断，`enqueueQuery`/`startInBackground`（后者才触发 `query::startWaitingForResources` 真正调度），队列满抛 `QueryQueueFullException`。配额含 `softMemoryLimitBytes`、soft/hard concurrency、`maxQueuedQueries`、soft/hard CpuLimit。队列策略可插拔 `UpdateablePriorityQueue`：FAIR→`FifoQueue`、WEIGHTED→`StochasticPriorityQueue`、WEIGHTED_FAIR→`WeightedFairQueue`（子组）+`IndexedPriorityQueue`（查询）、QUERY_PRIORITY（`InternalResourceGroup.setSchedulingPolicy` L572）。`updateGroupsAndProcessQueuedQueries` 用两阶段（无锁 staging→持 root 锁 delta 传播）聚合 `ResourceUsage`。

### spill 的落盘实现

`FileSingleStreamSpiller`：`SpillFile`（java.nio `Files`/`OutputStreamSliceOutput` 直接写本地盘，**不经 lib/trino-filesystem**）；`FileSingleStreamSpillerFactory` 多 spill 路径轮询、独立 binary-spiller 线程池、可选压缩/加密、磁盘水位检查。预算双闸：per-query `QueryContext.reserveSpill`（query-max-spill-per-node）与 per-node `SpillSpaceTracker.reserve`（`LocalSpillManager`，max-spill-per-node，超限抛 `exceededLocalLimit`）。

### 记账树的防泄漏纪律

`OperatorContext.destroy` 发现非零内存即抛 `GENERIC_INTERNAL_ERROR`——泄漏在第一个查询就暴露而不是慢慢吃光集群。`TraversingQueryContextVisitor` 自上而下遍历整棵 context 树（泄漏检测、revoking 扫描复用同一遍历器）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | LowMemoryKiller 4+1 实现 / 资源组 4 种队列 | OOM 杀谁、怎么排队都是可插拔决策点 |
| 观察者 | `MemoryPoolListener.onMemoryReserved` | 池→revoking scheduler 的解耦 |
| 组合树记账 | MemoryTrackingContext（user+revocable 双树） | 逐层汇总 O(1)、任意粒度诊断 |
| Visitor | TraversingQueryContextVisitor | 全树遍历操作复用 |

## 模块间交互

- **记账树根**由 `QueryContext.addTaskContext` 植入 TaskContext（SqlTaskManager 建 task 时初始化限额）；
- **cluster 拉取**：`RemoteNodeMemory.asyncRefresh` → `GET /v1/memory`（worker 的 `MemoryResource`，INTERNAL_ONLY）；
- **准入位置**：DispatchManager 的 `selectGroup`（见[查询与任务生命周期](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/03-query-lifecycle)）；`ClusterSizeMonitor.waitForMinimumWorkers`（LocalDispatchQuery.java:124 调用）按 session `execution_min_workers` 等最小 worker 数，超时抛 `GENERIC_INSUFFICIENT_RESOURCES`——避免小集群上必然失败的分布式查询空跑；
- **spill 消费方**：算子侧协作点见[执行引擎 Operator](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/06-operator-engine) 的 spill 一节。

## 扩展方式

**新增 killer 策略**：实现 `chooseTargetToKill` → `MemoryManagerConfig.LowMemoryQueryKillerPolicy/LowMemoryTaskKillerPolicy` enum 加值 → `CoordinatorModule.java` 对应 switch 加 case 绑定。零侵入，策略间互不知晓。

**关键配置**（MemoryManagerConfig/NodeMemoryConfig/NodeSpillConfig）：`query.max-memory`（默认 20GB，集群级 per-query user memory）、`query.max-total-memory`（默认 2×，含 revocable）、`query.max-memory-per-node`（默认堆 30%）、`memory.heap-headroom-per-node`（默认 30%，留给未跟踪分配）、`query.low-memory-killer.policy`（默认 total-reservation-on-blocked-nodes）、`memory-revoking-threshold` 0.9 / `memory-revoking-target` 0.5、`max-spill-per-node`/`query-max-spill-per-node` 100GB。

**给新算子接 spill**：revocable 记账 + 工厂注入 `Optional<SpillerFactory>`（spillEnabled 时必须存在）+ 处理循环检查 `isMemoryRevokingRequested()`（模板参照 `OrderByOperator`）。
