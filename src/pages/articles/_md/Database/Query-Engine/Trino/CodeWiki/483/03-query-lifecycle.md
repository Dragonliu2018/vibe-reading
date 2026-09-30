---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "查询与任务生命周期"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "状态机", "查询生命周期", "TaskExecutor"]
description: "Trino 483 查询受理到任务执行的生命周期管理：StateMachine 模板、SqlQueryExecution 驱动链、OutputBuffer 与多级队列"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

这个模块回答"**一条查询/一个任务是怎么被管理起来的**"：受理、排队、状态推进、worker 侧任务驱动、输出缓冲、完成判定。它刻意与"做什么计算"解耦——所有状态转换都是事件驱动（HTTP 线程、调度线程、worker 回调、用户 cancel 并发触发），核心武器是一个通用 CAS 状态机模板。

范围：`execution/`（根包）+ `execution/buffer` + `execution/executor` + `dispatcher/`。注意 483 命名变化：旧 `SqlQueryManager` 已更名 **`QueryManager`**（JMX 名向后兼容）。

## 模块架构

三块拼图：**Coordinator 受理链**（QueuedStatementResource → DispatchManager → QueryExecutionFactory → SqlQueryExecution + QueryManager 注册表）、**Worker 任务链**（TaskResource → SqlTaskManager → SqlTask/SqlTaskExecution）、**输出缓冲与线程调度**（OutputBuffer 家族 + TaskExecutor）。DDL 走独立轻量路径 `DataDefinitionExecution`。

## 调用链路

```
（Coordinator）
POST /v1/statement → QueuedStatementResource.postStatement
 └─ DispatchManager.createQuery → createQueryInternal (:208)
     ├─ sessionSupplier.createSession / QueryPreparer.prepareQuery
     ├─ resourceGroupManager.selectGroup (:230)   # 准入
     └─ LocalDispatchQueryFactory.createDispatchQuery
         ├─ QueryStateMachine.begin（初始 QUEUED）+ queryCreatedEvent
         ├─ executor.submit: executionFactories.get(Statement.class)
         │   .createQueryExecution → new SqlQueryExecution（构造期完成 analyze）
         └─ resourceGroupManager.submit 入队
     ↓ 资源组选中
 InternalResourceGroup.run → query::startWaitingForResources
     ├─ transitionToWaitingForResources + ClusterSizeMonitor.waitForMinimumWorkers
     └─ startExecution (:147)：transitionToDispatching
         → QueryManager.createQuery → queryExecution.start()
             ├─ transitionToPlanning → doPlanQuery
             │   （LogicalPlanner.plan → PlanFragmenter.createSubPlans → InputExtractor）
             ├─ planDistribution (:523)：按 RetryPolicy 建
             │   PipelinedQueryScheduler 或 EventDrivenFaultTolerantQueryScheduler
             ├─ transitionToStarting → scheduler.start()
             ├─ [scheduler 回调] transitionToRunning
             └─ transitionToFinishing（autocommit 异步 commit）
                 → transitionToFinishedIfReady：必须 committed 且 resultsConsumed()

（Worker）
POST /v1/task/{taskId} → TaskResource.createOrUpdateTask (TaskResource.java:163)
 └─ SqlTaskManager.updateTask (:494) → SqlTask.updateTask (:511)
     ├─ QueryContext 初始化内存限额
     ├─ outputBuffer.setOutputBuffers（先于 execution——LazyOutputBuffer 需先配置）
     ├─ SqlTaskExecutionFactory.create (:81)
     │   └─ LocalExecutionPlanner.plan → new SqlTaskExecution
     ├─ addSplitAssignments → schedulePartitionedSource（按 sourceStartOrder 放行）
     │   → enqueueDriverSplitRunner → taskExecutor.enqueueSplits
     └─ 完成判定：remainingSplitRunners==0 或 buffer 终态
         （CheckTaskCompletionOnBufferFinish）→ TaskStateMachine.finished()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `createQueryInternal` in DispatchManager.java:208 | 受理+准入+建执行对象 | 构造期 analyze，start 期 plan |
| `start` in SqlQueryExecution.java:397 | 状态机驱动主链 | 每步 transitionToXxx 有 setIf 防倒退 |
| `startExecution` in LocalDispatchQuery.java:147 | 排队→派发切换 | waitForMinimumWorkers 防小集群空跑 |
| `updateTask` in SqlTask.java:511 | worker 任务增量化更新 | 首包全量 fragment，后续增量 split |
| `enqueueDriverSplitRunner` in SqlTaskExecution.java:393 | split 变成可执行 runner | taskExecutor.enqueueSplits |
| `trySet/compareAndSet` in StateMachine.java | CAS 状态转换 | 终态不可逆，listener 异步 fire |

</details>

## 核心实现

### StateMachine<T>：全引擎统一的状态机模板

```java title="execution/StateMachine.java（节选）"
public class StateMachine<T> {
    public T trySet(T newState);                            // 终态/同态返回旧值
    public boolean compareAndSet(T expectedState, T newState);
    public boolean setIf(T newState, Predicate<T> predicate);
    public ListenableFuture<T> getStateChange(T currentState);  // FutureStateChange 轮询等待
    public void addStateChangeListener(StateChangeListener<T> listener); // 异步 fire
}
```

`trySet` 进终态时 `stateChangeListeners.clear()` 防泄漏；listener 在专用 executor fire（每 query `BoundedExecutor` 限 `maxStateMachineCallbackThreads`），`checkState(!Thread.holdsLock(lock))` 显式防锁内回调死锁。`transitionToXxx` 全用 `setIf`（ordinal 比较）防状态倒退——枚举顺序即状态机前进方向。

三套状态：`QueryState`（QUEUED → WAITING_FOR_RESOURCES → DISPATCHING → PLANNING → STARTING → RUNNING → FINISHING，终态 FINISHED/FAILED/CANCELED）；`TaskState`（10 态，**初始即 RUNNING**——task 被 scheduler 选中才创建）；`StageState`（7 态）。

### SqlQueryExecution 的异步推进

932 行的查询执行对象，36 个注入依赖。关键节奏：**analyze 在构造器**（`analyze()` 调 `AnalyzerFactory.createAnalyzer().analyze(statement)`，跑在 dispatch 线程），**plan 在 start()**（`transitionToPlanning` 失败返回防重入）。RUNNING 由 scheduler 回调置位；FINISHED 有双闸门——`transitionToFinishedIfReady` 必须 **committed 且 `resultsConsumed()`**（客户端拉完输出由 ExecutingStatementResource 触发）才落终态，防止客户端还没取走结果查询就被回收。

### OutputBuffer：结果缓冲的版本化状态机

`OutputBuffers` 是带 `version` 的抽象类（`PipelinedOutputBuffers`/`SpoolingOutputBuffers`，`checkValidTransition` 保证版本单调）；实现有 `PartitionedOutputBuffer`（hash shuffle）、`BroadcastOutputBuffer`、`ArbitraryOutputBuffer`、`LazyOutputBuffer`（延迟建 buffer）、`SpoolingExchangeOutputBuffer`（FT 落盘）。每个下游消费者一个 `ClientBuffer` 子队列——`SerializedPageReference` 引用计数 + `PendingRead` 挂起长轮询，ack 之后才能真正释放页内存。

### TaskExecutor 与多级队列

483 的默认 TaskExecutor 已是 **`ThreadPerDriverTaskExecutor`**（`executor/dedicated/`，`thread-per-driver-scheduler-enabled=true`，ServerMainModule.java:292 条件绑定）——每 driver 一线程，省去时间片切换；TimeSharing + `MultilevelSplitQueue` 变为可选回退。Multilevel 的公平性设计仍值得读：`LEVEL_THRESHOLD_SECONDS={0,1,10,60,300}s` 按 task 累计调度时间升级，`pollSplit` 选 actual/target 比值最低的 level，升级时 Priority 设为该级当前最小值实现"瞬时公平"，`LEVEL_CONTRIBUTION_CAP=30s` 防一个慢 read 拖垮同 level。

### DDL 的独立通道

DDL 无需 plan/stage/调度，只是元数据+session 操作：`DataDefinitionExecution.start()` 直接 `transitionToRunning → task.execute(future) → FINISHING`，零调度开销，却复用同一 QueryStateMachine/监控/UI。`DataDefinitionTask.execute` 返回 future 支持异步 connector。按语句类型路由的工厂是 Guice `MapBinder<Class<? extends Statement>, QueryExecutionFactory>`（server/QueryExecutionFactoryModule.java）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| CAS 状态机模板 | `StateMachine` + 四套具体状态机 | 并发触发下单次生效、终态不可逆 |
| 工厂路由 | `QueryExecutionFactoryModule` 的 MapBinder | 语句类型 → 执行策略的开放注册 |
| 事件监听 | `io.trino.event.QueryMonitor`（queryCreatedEvent/queryCompletedEvent） | 生命周期事件外发（event-listener 插件的源头） |
| 装饰器 | `MemoryTrackingRemoteTaskFactory` 包装 RemoteTaskFactory | 内存统计无侵入叠加 |

## 模块间交互

- **上游**：dispatcher 包的 Query（内部类）持 `ListenableFuture<QueryExecution>` 桥到协议层；
- **下游**：`PipelinedQueryScheduler`（scheduler 包）由 `planDistribution` 构造并 start；
- **worker 入口**：`TaskResource`（server 包）经 SqlTaskManager 进来；`/v1/task/{taskId}/results/{bufferId}/{token}` → `SqlTaskManager.getTaskResults` → `ClientBuffer.get`，消费方是上游 stage 的 ExchangeOperator；
- **线程池注解**：dispatch 全链跑 `DispatchExecutor`；调度循环跑 `@ForQueryExecution`（固定池+1000 队列）；worker 状态回调跑 `task-notification-%s`。

## 扩展方式

**新增一种 DDL**（三处缺一不可）：① `XxxTask implements DataDefinitionTask<Xxx>`（execution/ 包）；② `StatementUtils.STATEMENT_QUERY_TYPES` 注册 `dataDefinitionStatement(Xxx.class, XxxTask.class)`（util/StatementUtils.java，isDataDefinitionStatement 白名单）；③ `QueryExecutionFactoryModule.bindDataDefinitionTask(...)` 加绑定行。

**新增查询状态**：改 `QueryState` 枚举（ordinal 顺序即前进方向）+ `QueryStateMachine` 加 `transitionToXxx` + `QueryStateTimer` 计时 + REST 序列化兼容。

**改任务优先级策略**：`TaskExecutor` 三种实现可换绑（ServerMainModule 条件绑定处）；或调 `MultilevelSplitQueue` 阈值/`levelTimeMultiplier`（TaskManagerConfig）。
