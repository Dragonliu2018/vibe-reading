---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "服务运行时与查询服务"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "Broker", "QueryLifecycle", "fan-out", "背压"]
description: "Druid 服务运行时——QuerySegmentWalker 按节点多态、QueryLifecycle 阶段化、CachingClusteredClient fan-out、DirectDruidClient 异步 HTTP+背压、QueryScheduler lanes、流式 Pusher。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（`server/.../server/` 核心，不含 coordinator/overlord 子目录）是 Druid 各节点（Broker/Historical/MM/Router）共享的**服务运行时**：HTTP/Jetty 接入、查询生命周期（QueryLifecycle）、查询调度（QueryScheduler lanes）、segment 管理与本地服务（ServerManager/SegmentManager）、Broker fan-out（CachingClusteredClient/DirectDruidClient）。它回答"**查询如何被服务**"。职责边界：从 HTTP 到 Sequence 产出的服务编排；查询引擎内部的 Sequence/聚合见查询引擎模块，segment 格式见 Segment 模块。

## 模块架构

```
                  QueryResource.doPost（HTTP /druid/v2/）
                         │
                  QueryLifecycle（init→authorize→execute→log）
                         │
              QueryPlus.run(QuerySegmentWalker)        ◄── 接口，按节点多态
                    ┌────┴─────┐
       [Broker] ClientQuerySegmentWalker   [Historical] ServerManager
              │                                       │
       CachingClusteredClient              getQueryRunnerForSegments
       (timeline/prune/merge)                  → ResourceManagingQueryRunner
              │                                       │
       DirectDruidClient ── HTTP fan-out ──►  per-segment QueryRunner（pool 并行）
              │                                       │
       MergeSequence/CombiningSequence ◄── stream ──┘
              │
       QueryResultPusher（流式输出）
```

关键是 `QuerySegmentWalker` 的**按节点多态**：同一份 `QueryLifecycle` 代码，Broker 注入 `ClientQuerySegmentWalker`（跨节点 fan-out+合并），Historical 注入 `ServerManager`（本地执行）——靠 Guice 绑定自动适配。

## 调用链路

![查询执行数据流](/vibe-reading/images/articles/druid-internals/query-flow.svg)

```
QueryResource.doPost → readQuery → queryLifecycle.initialize(query)
  → conglomerate.getToolChest(baseQuery)
  → queryLifecycle.authorize(req)
  → pusher.push → resultsWriter.start → queryLifecycle.execute()
    → QueryPlus.run(texasRanger, ctx)
      → BaseQuery.getRunner(walker) → spec.lookup → walker.getQueryRunnerForIntervals
      [Broker] ClientQuerySegmentWalker.getQueryRunnerForIntervals  [ClientQuerySegmentWalker.java:188]
        → conglomerate.getToolChest(query)
        → decorateClusterRunner(clusterClient.getQueryRunnerForIntervals)
           FluentQueryRunner.applyPreMergeDecoration().mergeResults().applyPostMergeDecoration()...
        → CachingClusteredClient.run  [CachingClusteredClient.java:329]
           ① serverView.getTimeline  ② computeSegmentsToQuery（filterSegments/prune）
           ③ pruneSegmentsWithCachedResults  ④ scheduler.prioritizeAndLaneQuery（分 lane）
           ⑤ groupSegmentsByServer  ⑥ LazySequence → addSequencesFromServer
        → DirectDruidClient.run  [DirectDruidClient.java:154]  # 同步触发 httpClient.go → ListenableFuture
        → merge（ParallelMergeCombiningSequence / MergeSequence）
        → scheduler.run（acquire Bulkhead lanes）
  → results.accumulate → QueryResultPusher（第一行触发 HTTP 200，逐行写出）
  → emitLogsAndMetrics
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `QueryLifecycle.execute` | 执行查询返回 Sequence | 阶段化，authorize 先 |
| `ClientQuerySegmentWalker.getQueryRunnerForIntervals` | Broker 取 runner | decorate 链 preMerge→merge→postMerge |
| `CachingClusteredClient.run` | fan-out 编排 | timeline+prune+lane+groupByServer |
| `DirectDruidClient.run` | 异步 HTTP | 返回 BaseSequence<JsonParserIterator> |
| `ServerManager.getQueryRunnerForSegments` | Historical 取 runner | ResourceManagingQueryRunner+closer |
| `ChainedExecutionQueryRunner.run` | per-segment 并行 | QueryProcessingPool + MergeIterable |
| `QueryScheduler.prioritizeAndLaneQuery` | 分 lane | Bulkhead 信号量 |
| `QueryResultPusher.push` | 流式输出 | accumulate 驱动，第一行开流 |

</details>

## 核心实现

### QuerySegmentWalker 多态（Broker vs Historical）

`processing/.../query/QuerySegmentWalker.java` 是核心接口。`CliBroker`（`services/.../cli/CliBroker.java` L173）绑定 `QuerySegmentWalker → ClientQuerySegmentWalker`，后者内部持 `clusterClient=CachingClusteredClient` 与 `localClient=LocalQuerySegmentWalker`；`CliHistorical`（L169）绑定 `QuerySegmentWalker → ServerManager`。`QueryLifecycleFactory` 注入 `QuerySegmentWalker texasRanger`，所以同一 `QueryLifecycle` 自动适配——Broker fan-out、Historical 本地。

### QueryLifecycle 阶段化

`server/.../QueryLifecycle.java` 是状态机（`NEW→INITIALIZED→AUTHORIZING→AUTHORIZED→EXECUTING→DONE`）：`initialize`（L214，取 toolChest）、`authorize`（L284，`AuthorizationResult.allowBasicAccess` 否则 `ForbiddenException`）、`execute`（L424，返回 `QueryResponse<T>` 含 `Sequence<T>`+`ResponseContext`）。**`execute` 返回 Sequence 后不立即求值**——真正驱动延迟到 `accumulate` 被调。`emitLogsAndMetrics`（L449-530）在 Sequence 完全消费或异常后经 `SequenceWrapper.after()` 触发，记 `query/time`/`query/bytes`/`success`。

### CachingClusteredClient fan-out 与 merge

`server/.../client/CachingClusteredClient.java`（`run` L329）是 Broker fan-out 核心：① `BrokerServerView.getTimeline` 取 segment timeline；② `computeSegmentsToQuery`（L346）走 timeline、`toolChest.filterSegments`（L439）、`SegmentPruner.prune`（L452）裁剪；③ `pruneSegmentsWithCachedResults`（L363）segment 级缓存；④ `scheduler.prioritizeAndLaneQuery`（L366）分配优先级+lane；⑤ `groupSegmentsByServer`（L371）按 server 分组；⑥ `LazySequence`（L375）惰性收集，`addSequencesFromServer`（L662-689）对每 server 调 `DirectDruidClient.run`。`merge`（L385-427）两路径：并行 `ParallelMergeCombiningSequence`（ForkJoinPool）或顺序 `MergeSequence`（`PriorityQueue<Yielder>`，`flatMerge` L423）。

### DirectDruidClient：异步 HTTP + 背压

`server/.../client/DirectDruidClient.java`（`run` L154）对每 Historical 构造 HTTP POST `scheme://host/druid/v2/`，`httpClient.go`（L465）返回 `ListenableFuture<InputStream>`（异步，HTTP 立即发出），包装为 `BaseSequence<JsonParserIterator>`。结果经 `JsonParserIterator` 从 `LinkedBlockingQueue<InputStreamHolder>`（L182）惰性反序列化。**背压**：`maxQueuedBytes` 按 server 数均分（L677），`queuedByteCount >= maxQueuedBytes` 时 `enqueue` 返 false、`TrafficCop` 暂停 Netty 读取，消费后 `trafficCop.resume` 恢复。超时由 `QUERY_FAIL_TIME`（绝对截止，L91）+ `queue.poll(checkQueryTimeout)`→`QueryTimeoutException`。

### ServerManager / SegmentManager：本地服务

`server/.../ServerManager.java`（Historical 的 `QuerySegmentWalker`）：`getQueryRunnerForSegments`（L182）→ `ResourceManagingQueryRunner.run`（L615-667）① `getLeafSegmentsBundle`（L633，`SegmentManager.getSegmentsBundle`→cached/loadable/missing）② `getOrLoadBundleSegments`（L637，`acquireSegment`→`Segment` via Future）③ `getQueryRunnersForSegments`（L644，`buildQueryRunnerForSegment` L478-555，factory.createRunner + Caching/BySegment/Metrics/CPUTime 装饰）④ `factory.mergeRunners`→`ChainedExecutionQueryRunner`（`processing/.../query/`，per-segment 提交 `QueryProcessingPool`、`Futures.allAsList`、`MergeIterable` 排序合并）⑤ `toolChest.mergeResults`→`ResultMergeQueryRunner`→`CombiningSequence` ⑥ `FinalizeResultsQueryRunner`+`CPUTimeMetricQueryRunner` ⑦ `withBaggage(closer)`——`Closer` 持所有 `SegmentReference`，Sequence 消费或异常时释放（`CloseableUtils.closeAndWrapInCatch`）。

### QueryScheduler lanes

`server/.../QueryScheduler.java` 用 Resilience4j `Bulkhead`（零等待信号量）。`prioritizeAndLaneQuery`（在 `CachingClusteredClient` L366 fan-out 前）分配 lane 写入 query context 传给 Historical；`run`（L382）包装合并 Sequence，`before()` 取 Bulkhead 许可、`after()` 释放。两级限制：lane-specific + total（`QueryScheduler.TOTAL`）。策略：`NoQueryLaningStrategy`（默认）、`HiLoQueryLaningStrategy`（priority<0 进 low lane）、`ManualQueryLaningStrategy`（从 context 读 lane）。Historical 端 `LocalQuerySegmentWalker.wrapQueryRunner` 也执行自己的 lane 限制。`cancelQuery`（L226-237）移除并 `future.cancel(true)` 中断 HTTP 与 parallel merge future。

### QueryResultPusher 流式输出

`server/.../QueryResultPusher.java`（`push` L124-222）调用 `results.accumulate`：第一行 → HTTP 200 + 响应头 + output stream 开 + JSON `[`；后续每行 `writer.writeRow`；末尾 `writeResponseEnd` 写 `]`。结果**流式**返回。异常分层捕获（`DruidException`/`QueryException`/`ForbiddenException`/其他→`QueryInterruptedException`），`handleDruidException`（L252-314）按"响应是否已开始"选不同策略（已开始写 `X-Error-Message`+`X-Druid-Response-Complete: false`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 多态（DI 绑定） | `QuerySegmentWalker` | 一份代码适配 Broker/Historical |
| 状态机 | `QueryLifecycle` | 阶段化，authz 先于 execute |
| 装饰器链 | `FluentQueryRunner`/QueryRunner 装饰 | 缓存/指标/后处理叠加 |
| 生产者-消费者 | DirectDruidClient + TrafficCop | fan-out 并发 + 背压 |
| 控制反转 | Sequence.accumulate + Pusher | 全链路流式，不物化 |
| 策略 | `QueryLaningStrategy` | lane 分配可换 |

## 模块间交互

依赖 `query/`（`QueryRunner`/`Sequence`/`QueryToolChest`/`FluentQueryRunner`/`ChainedExecutionQueryRunner`）、`segment/`（`Segment`/`SegmentManager` 加载）、`discovery`（`BrokerServerView` 发现 Historical）、`coordinator`（segment 视图）。`DirectDruidClient` HTTP 调用 Historical 的 `QueryResource`（同入口）。被 `CliBroker`/`CliHistorical` 装配。

## 扩展方式

- **新增查询限流策略**：实现 `QueryLaningStrategy`，Guice 绑定，经 `druid.query.laning.strategy` 选择；关键函数 `computeLane`。
- **新增 HTTP 端点**：JAX-RS `@Path` resource，在节点 module 注册；参考 `QueryResource`/`SqlResource`。
- **改 Broker 路由逻辑**：覆写/装饰 `ClientQuerySegmentWalker` 或 `CachingClusteredClient` 的 timeline/prune/group 逻辑；关键方法 `CachingClusteredClient.run`。
