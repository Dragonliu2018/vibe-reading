---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "数据同步 Pipe"
date: "2026-10-01T21:05:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "时序数据库", "数据同步", "Disruptor", "at-least-once"]
description: "source→processor→sink 三段插件流水线：EnrichedEvent 引用计数、commitId 区间推进位点、内嵌 Disruptor 事件捕获，一套引擎同时服务用户 pipe、订阅与 IoTConsensusV2 复制。"
readingTime: "28 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

Pipe（`datanode/.../db/pipe` 约 7 万行 + node-commons `commons/pipe` 2.3 万行 + `iotdb-api/pipe-api`）是 IoTDB 的**数据流转引擎**：SQL `CREATE PIPE ... WITH SOURCE (...) WITH PROCESSOR (...) WITH SINK (...)` 声明一条从本集群到外部系统的同步管道。但它远不只是"数据同步功能"——本模块最重要的架构事实是**一套引擎三用**：`PipeType` 枚举区分 `USER`（用户 pipe）、`SUBSCRIPTION`（客户端订阅，见订阅与协议篇）、`CONSENSUS`（IoTConsensusV2 的副本复制通道）三种管道，三者复用同一套事件采集、位点、线程模型，只换 sink stage。

每个 pipe 在 DataNode 侧不是一条全局流水线，而是**按 DataRegion 粒度复制成多个 PipeDataNodeTask**——pipe 是 database 级声明，任务是 region 级执行。为什么：region 迁移/leader 切换只需 drop/create 单个 task，不扰动其他 region。

## 模块架构

![Pipe 引擎架构](/vibe-reading/images/articles/iotdb-2.0.10/pipe-architecture.svg)

装配在 `PipeDataNodeTaskBuilder.build()`：先建 `PipeTaskSourceStage` 与 `PipeTaskSinkStage`，再用 source 的 `getEventSupplier()` 和 sink 的 `getPipeSinkPendingQueue()` 把两者接到 `PipeTaskProcessorStage`（源码注释 "The processor connects the source and sink"），组装为 `PipeDataNodeTask`。入口门面是 `PipeDataNodeAgent`（Holder 单例，四个子 agent：task/plugin/runtime/receiver）。

插件 API 三接口在 `iotdb-api/pipe-api`：`PipeSource`（validate → customize → start → supply → close）、`PipeProcessor`（onEvent + collector 回写）、`PipeConnector`（transfer(TabletInsertionEvent/TsFileInsertionEvent/Event) + heartbeat）。控制面是**声明式调和**：ConfigNode 是 coordinator 持有 PipeMeta，DataNode 的 `PipeTaskAgent.handlePipeMetaChanges()` 对比期望 meta 与本地 meta（静态参数变了→drop+重建；region 组 leader 变了→drop/重建该 region 的 task；多出的本地 pipe→drop），插件加载顺序依赖通过外层 while 多轮重试解决。

## 调用链路

![事件捕获点位](/vibe-reading/images/articles/iotdb-2.0.10/pipe-capture-points.svg)

事件捕获点全部挂在存储引擎写入路径上，且**捕获先于/伴随持久化**——这是"不丢"的第一层防线：插入事件的位点（`SimpleProgressIndexAssigner` 分配 `SimpleProgressIndex(rebootTimes, 单调递增序号)`）在 memtable 写入**前**分配；删除事件**同步等待** `DeletionResource.waitForResult()`——删除先持久化到 Deletion DAL 才继续写（删除不像插入有 TsFile 兜底重扫，若不落盘直接放行，可能源端删了、目的端漏删）；TsFile 事件在 `tsFileManager.add()` **之前**监听（源码注释："Listen before the tsFile is added into tsFile manager to avoid it being compacted"）。SchemaRegion 变更走 `SchemaRegionListeningQueue` 产出 `PipeWritePlanEvent`。

事件进入流水线后被 `EnrichedEvent` 装饰（`commons/pipe/event/EnrichedEvent.java`）：附加引用计数（AtomicInteger）、pipeName/creationTime/pipeTaskMeta、committerKey+commitId、treePattern/tablePattern 惰性过滤、时间范围过滤。`shallowCopySelfAndBindPipeTaskMetaForProgressReport()` 让同一底层事件被多条 pipe 引用时浅拷贝绑定各自 meta——**多 pipe 共享一次捕获**。

数据面线程模型：source 段的 `PipeInsertionDataNodeListener` 为每个 DataRegion 懒创建 `PipeDataRegionAssigner`，内嵌一条 **vendored 的 LMAX Disruptor** ring buffer（代码在 `pipe/source/dataregion/realtime/disruptor/`，含 MultiProducerSequencer/RingBuffer）扇出到各 source 的 `EnrichedDeque`；processor 段全局单线程池轮询所有 subtask 并**自适应休眠**（忙碌率 ≥0.25 休眠减半、≤0.05 翻倍，上限 1000ms——用户插件无需线程安全的前提）；sink 段每 pipe 一个 `PipeSinkSubtask.executeOnce()`：从 `UnboundedBlockingPendingQueue` 取事件 `transfer()`，成功后释放引用计数，**失败保留 lastEvent 重试**（at-least-once），并注入 cron 心跳事件驱动纯 batch 模式出队。

assigner 的分发有两个值得读的细节（`PipeDataRegionAssigner.assignToSource()`）：事件 `isGeneratedByPipe()` 且 source `isForwardingPipeRequests()` 为 false 时（pipe 自身生成的写回事件不再回环），构造 `ProgressReportEvent(pipeName, creationTime, pipeTaskMeta)` 并 `bindProgressIndex(event.getProgressIndex())`——只推进位点不转发数据；matcher 未匹配的 source 对 TabletInsertionEvent/TsFileInsertionEvent 同样发 ProgressReportEvent 保证其位点不落后。`publishToAssign()` 加 synchronized 的原因写在源码注释里：close 时**完全防止引用计数泄漏**（disruptor 已关闭时转走 `onAssignedHook`——`gcSchemaInfo()` + `decreaseReferenceCount`）。哪些 region 被监听由 `DataRegionListeningFilter.shouldDataRegionBeListened()` 门控：`parseInsertionDeletionListeningOptionPair()` 把 inclusion/exclusion 参数按 `data.insert`/`data.delete` 两个 PartialPath 的 `overlapWithFullPathPrefix` 匹配增删监听选项，两者皆无时直接不监听；树模型用 `treePattern.mayOverlapWithDb()`（库名补 root. 前缀）、表模型用 `tablePattern.matchesDatabase()`（去掉 root. 前缀），OR 关系。

实时 source 还有一个内存压力下的**降级机制**（`PipeRealtimeDataRegionHybridSource.extractTabletInsertion()`）：`canNotUseTabletAnymore()` 判断 `floatingMemoryUsageInByte * pipeCount >= totalFloatingMemorySizeInBytes`（浮存内存 × pipe 数超总量；强制降级开关开启且事件不容许纯 tablet 时总量按比例下调）时，把事件 `TsFileEpoch` 迁移到 `USING_TSFILE` 状态——tablet 直接转成 TsFile 传输以释放内存；`USING_TSFILE` 状态下 tablet 事件被忽略（减引用后不入队），`USING_BOTH` 状态则 `skipReportOnCommit()` 后入队。sink 批处理侧（`PipeTransferBatchReqBuilder.onEvent()`）：开启 leader cache 时按 `endPointToBatch: Map<TEndPoint, PipeTabletEventPlainBatch>` 拆批（tsfile 传输不返回重定向信息故仅 plain batch 使用）；`PipeTabletEventBatch.shouldEmit()` 的发射条件是 `totalBufferSize >= maxBatchSizeInBytes || (now - firstEventProcessingTime) >= maxDelayInMs`；批次创建时 `PipeDataNodeResourceManager.memory().forceAllocate(requestMaxBatchSizeInBytes)` 预留内存；offer 失败时 `decreaseReferenceCount(...)` 后抛异常触发重试。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `PipeDataNodeTaskBuilder.build()` | 装配三段流水线 | 三分支换 sink stage 实现"一套引擎三用" |
| `PipeInsertionDataNodeListener.listenToInsertNode` | 插入事件捕获 | 位点先于 memtable 分配 |
| `DataRegion.listenToDeleteData` + waitForResult | 删除事件捕获 | 同步等待 DAL 持久化防漏删 |
| `EnrichedEvent.decreaseReferenceCount` | 引用归零触发提交 | 多 pipe 共享一次捕获 |
| `PipeSinkSubtask.executeOnce()` | sink 执行 | 失败保留 lastEvent，at-least-once |
| `PipeCommitQueue.offer()` | 位点推进 | 区间连续才出队 |
| `PipeTaskAgent.handlePipeMetaChanges()` | 控制面调和 | 声明式 diff，ConfigNode 推 DataNode 调 |
| `PipePluginConstructor.reflect()`（L63-101） | 插件反射加载 | 每插件独立 ClassLoader |
| `PipeHistoricalDataRegionTsFileAndDeletionSource.supply()` | 历史同步 | greaterThanStartIndex 按位点过滤（833 行） |
</details>

## 核心实现

### 位点：commitId 区间 + 引用计数双重确认

`PipeEventCommitManager` 给事件打 `(CommitterKey, commitId)`；事件处理完（引用计数归零）→ `commitSingleId()` → `PipeEventCommitter.commit()` 入 `PipeCommitQueue`（基于 `IntervalManager` 维护 commitId 区间）。**队列的 offer 只有在 `interval.start == lastCommitted + 1` 时才出队**，触发 `PipeCommitInterval.onRemoved()`：`pipeTaskMeta.updateProgressIndex(currentIndex)` + onCommittedHooks；区间合并时取保守小值。即：**只有某 commitId 之前的所有事件全部完成，位点才前进**——乱序完成的 sink 不影响正确性。重启恢复靠 `PipeTaskMeta` 序列化持久化 progressIndex，historical source 按位点续传，realtime 位点因含 rebootTimes 天然单调。

### 一套引擎三用的分叉点

`PipeDataNodeTaskBuilder.build()` 的三分支：SUBSCRIPTION 换 `SubscriptionTaskSinkStage extends PipeTaskSinkStage`（数据落 `SubscriptionBroker` 的 prefetch 队列供客户端 poll）；CONSENSUS 走 `getConsensusExecutor()`——`IoTConsensusV2SubtaskExecutor extends PipeSinkSubtaskExecutor`，接收端 `IoTConsensusV2Receiver`，`EnrichedEvent` 专门加了 `replicateIndexForIoTV2` 和 `equalsInIoTConsensusV2()`（仅凭 committerKey+commitId+rebootTimes 判等去重——接收端幂等补上"不重"）。删除走独立的 `DeletionResourceManager` + `DeletionBuffer` WAL。

### 典型 sink：IoTDB→IoTDB THRIFT 同步

发送端 `IoTDBDataRegionSyncSink`（27.2k 行，公共基类 `IoTDBSink`）：batch 模式经 `PipeTransferBatchReqBuilder` 攒批；TsFile 事件按 `PipeTransferTsFilePieceReq/SealWithModReq` 分片+封口传输（支持 mod 文件携带删除）；可选压缩与限速（`PipeEndPointRateLimiter`）；连接管理三层（`CacheLeaderClientManager` 对 Cluster 部署做 leader 缓存）。同步/异步两实现（`IoTDBDataRegionAsyncSink` 36.5k 行）+ SSL 变体。接收端 `IoTDBDataNodeReceiver.receive()`（L215）是按 req 类型分派的大 dispatcher，事件转执行靠 visitor 栈：`PipePlanToStatementVisitor` 把传输的 plan 还原为 statement，再转批量插入执行。文件类接收端 `IoTDBFileReceiver`（node-commons）的握手有防呆设计：**V2 握手三重拒绝**——从 config node 取不到 clusterId、请求缺 clusterId、双方 clusterId 相同（同集群自环）均拒绝；V1 握手校验时间精度一致，重连（会话重启）时先 `resetCurrentWritingFileState()` 再对旧接收目录 `FileUtils.deleteDirectory` 删除重建（磁盘不足返回 DISK_SPACE_INSUFFICIENT）。另有 `airgap/`（物理单向隔离网闸的文件摆渡变体）。内置 sink 全集见 `BuiltinPipePlugin`：iotdb-thrift-sink、iotdb-airgap-sink、opcua/opcda、websocket、writeback、do-nothing-sink。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 | `PipeDataNodeAgent` 四入口 | 模块边界清晰 |
| Builder | `PipeDataNodeTaskBuilder` | 三段装配 + 类型分叉 |
| 装饰器 | `EnrichedEvent` 包装用户 Event | 引用计数/位点/pattern 透明附加 |
| 观察者 + 引用计数 | Listener + increase/decreaseReferenceCount | 多 pipe 共享捕获，归零提交 |
| 模板方法 | `PipeTaskAgent` 的 create/drop/start/stop 骨架 | ConfigNode/DataNode 两侧子类化 |
| 声明式调和 | meta diff | pipe 永不阻塞存储引擎启动 |
| 内嵌 Disruptor | lock-free 生产者-消费者 | 无界队列 + 零拷贝扇出 |

## 模块间交互

与存储引擎的耦合在写入热路径（捕获点）；与 ConfigNode 的控制面（pipe meta 下发、jar 分发——`PipeAgentLauncher.launchPipePluginAgent()` 比对本地 jar 与 ConfigNode 版本，缺失批量拉取，**单个插件损坏只 markPluginLoadFailure 不阻塞 DataNode 启动**）；IoTConsensusV2 直接复用本模块做复制；订阅模块寄生在本模块之上。插件加载：内置插件直接取类，用户插件 `Class.forName(className, true, PipePluginClassLoaderManager 的独立 ClassLoader)`——每插件隔离依赖冲突。

## 扩展方式

新增协议 sink（如 Kafka）：实现 `PipeConnector`（pipe-api），在 `BuiltinPipePlugin` 注册枚举项或走 CREATE PIPEPLUGIN jar 上传——只动 `sink/protocol/` 一层，source/位点/线程模型全部复用。新增事件类型要动四处：捕获点（listener）、`event/` 下新 EnrichedEvent 子类（实现 `getProgressIndex()`/`shallowCopySelf...`/`mayEventPathsOverlappedWithPattern`）、传输 payload（`sink/payload/evolvable/request/` 新 req + receiver `receive()` 分派分支 + visitor 还原）。调整位点推进策略改 `PipeCommitQueue.offer()` 的连续性判断——但需同步评估 historical source 的重扫正确性（历史/实时衔接处最易出错）。

> ⚠️ 待核实：异步 sink 的 callback 与 lastEvent 重试交互细节；`IoTDBThriftAsyncSink` 在 commons 侧为占位符。
