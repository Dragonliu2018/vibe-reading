---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "共识层"
date: "2026-10-01T20:35:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "时序数据库", "共识协议", "Raft", "Ratis"]
description: "IConsensus 可插拔共识体系：Simple/Ratis/IoTConsensus(V2) 三实现对比、LogDispatcher 异步复制引擎、DataRegion 与 SchemaRegion 的默认协议分野。"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

IoTDB 把"多个副本如何对一条数据达成一致"从存储与元数据引擎中剥离出来，做成一个**可插拔的共识层**（`iotdb-core/consensus`，约 2 万行 + datanode 侧适配约 1 万行）。它对上以 `write(ConsensusGroupId, IConsensusRequest)` / `read(...)` 两个方法屏蔽协议差异，对下以 `IStateMachine` 回调把协议与业务引擎解耦。

这一层最值得读的设计是**默认协议的分野**（`IoTDBConfig.java:911/918`）：

- `dataRegionConsensusProtocolClass = IOT_CONSENSUS`（默认）——数据面高吞吐，用"本地写成功即返回 + WAL 异步分发"换吞吐，接受最终一致；
- `schemaRegionConsensusProtocolClass = RATIS_CONSENSUS`（默认）——元数据强结构化、低吞吐、错一个即全局错，用 Raft 多数派同步复制保强一致。

同一套接口同时服务 DataRegion、SchemaRegion、ConfigRegion 三种共识组，协议实现完全不知道上层是时序数据还是元数据。

## 模块架构

![共识层架构](/vibe-reading/images/articles/iotdb-2.0.10/consensus-architecture.svg)

核心抽象只有两个：`IConsensus`（协议契约）和 `IStateMachine`（业务回调）。StorageEngine 与 SchemaEngine 各自通过 `DataRegionConsensusImpl` / `SchemaRegionConsensusImpl` 这两个单例 holder 拿到共识实例——它们其实**不是路由器**，而是配置组装器：把 60+ 个 `iotdb-datanode.properties` 配置项翻译成 `IoTConsensusConfig` / `IoTConsensusV2Config` / `RatisConfig`，再交给 `ConsensusFactory.getConsensusImpl()` 用 `Class.forName` 反射实例化协议类（构造器签名固定为 `(ConsensusConfig, IStateMachine.Registry)`）。每个 DataNode 只有全局一个 DataRegion 共识实例，组内路由由协议实现内部的 `stateMachineMap<ConsensusGroupId, ...>` 完成。

`ConsensusGroupId` 是共识组的统一寻址体系（node-commons `commons/consensus/`）：抽象基类 + `DataRegionId` / `SchemaRegionId` / `ConfigRegionId` 三个子类，磁盘目录按 `type_id` 命名（`IoTConsensus.buildPeerDir()`），节点重启时扫目录即恢复全部共识组。

## 调用链路

![IoTConsensus 写入路径](/vibe-reading/images/articles/iotdb-2.0.10/consensus-write-path.svg)

以默认协议 IoTConsensus 的一条写入为主线：`IoTConsensusServerImpl.write()` 先做 WAL 节流检查（`needBlockWrite()`：searchIndex 与 minSyncIndex 差值超 `walThrottleThreshold` 时阻塞等待，超时返回 `WRITE_PROCESS_REJECT`），再赋单调 searchIndex、写本地状态机（DataRegion + WAL），**成功即返回客户端**——复制完全异步。右列是每个 follower 一个 `LogDispatcherThread` 的复制引擎：组批（内存不足/重启产生 gap 时 `constructBatchFromWAL` 回 WAL 补齐防日志空洞）→ `SyncStatus` 滑动窗口控制在途批次 → `sendBatchAsync` 异步发送、重试在回调里。关键细节：`logDispatcher.offer()` 与 `searchIndex.incrementAndGet()` 在同一个 `synchronized(searchIndex)` 块内完成——源码注释解释 why：index 与入队若不同事务，dispatcher 会回 WAL 找日志拖慢批组装。

RatisConsensus 的写路径则走标准 Raft：leader 本地 `submitClientRequest`，非 leader 经 RatisClient 转发 leader，多数派 commit 后返回。读路径有个值得注意的权衡（`read()` Javadoc 原话 "linearizable can be violated in some extreme cases"）：默认先做一次 linearizable 读探测，成功后置 `canServeStaleRead=true` 转 stale read 提升吞吐，直到异常再重新探测；可配 `Read.Option.LINEARIZABLE` 强制线性一致。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `IConsensus.write(groupId, request)` | 数据面写入入口 | 返回统一 `TSStatus`，协议对上层无感 |
| `IConsensus.read(groupId, request)` | 数据面读取入口 | 返回统一 `DataSet` |
| `createLocalPeer` / `addRemotePeer` / `deleteLocalPeer` | 副本组生命周期 | 接口 Javadoc 规定调用顺序契约 |
| `IoTConsensusServerImpl.write()` | IoT 协议本地写 | WAL 节流 + searchIndex 原子入队 |
| `LogDispatcher.getBatch()` | 复制批组装 | gap 时回 WAL 补齐防空洞 |
| `IoTConsensus.addRemotePeer()` | 副本变更七步 | 快照分片传输 + 限速 + KillPoint 混沌注入 |
| `ApplicationStateMachineProxy.applyTransaction()` | Ratis 日志应用 | leader 从内存取对象、follower 才反序列化 |
| `DataRegionStateMachine.write()` | 数据状态机执行 | `DataExecutionVisitor` 访问者模式；REJECT 重试 5 次 |
| `SchemaRegionStateMachine.write()` | 元数据状态机执行 | 成功后通知 pipe 监听 schema 变更 |
| `ConsensusFactory.getConsensusImpl()` | 协议工厂 | 反射加载，新增协议零侵入 |
</details>

## 核心实现

### 三种协议实现的对比

| | SimpleConsensus | RatisConsensus | IoTConsensus |
| --- | --- | --- | --- |
| 一致性 | 无（单机单副本） | Raft 强一致 | 单写多读、异步复制、最终一致 |
| `write` 路径 | `SimpleConsensusServerImpl.write` 直写状态机 | leader 提交，非 leader 转发 | 本地 WAL + 状态机即返回 |
| `isLeader` | 恒 true | 真实 Raft 选举 | **恒 true**（`IoTConsensus.isLeader()` 直接 `return true`） |
| `transferLeader` | 不支持 | 支持 | 抛 `NOT_SUPPORT_LEADER_TRANSFER` |

IoTConsensus 的 `isLeader()` 恒真是最容易误读的一处：每个持有该共识组的节点在本地视角都是"leader"，可本地读写——这是"单写多读"的写 side（写入总是打到创建该 region 的节点），副本靠 LogDispatcher 收敛。它不支持 leader transfer 也源于此：副本没有独立的日志复制状态机，换主需要 region migration（走 ConfigNode 的 Procedure）。

### LogDispatcher：异步复制引擎

`iot/logdispatcher/LogDispatcher.java` 是 IoTConsensus 的心脏。每个远端 Peer 一个 `LogDispatcherThread`（cached pool，线程数 = 副本数 - 1），循环做三件事：

1. `getBatch()` 组批：`drainTo` 从 `pendingEntries` 拉取；队列满/内存不足/重启产生 gap 时 `constructBatchFromWAL` 从 WAL 补齐，保证日志序列无空洞；
2. `syncStatus.addNextBatch(batch)`：滑动窗口控制在途批次数（`maxPendingBatchesNum`），防止 follower 慢时 leader 内存被未确认批次撑爆；
3. `sendBatchAsync(batch, DispatchLogHandler)`：异步发送，重试逻辑全部在回调里。

内存侧由 `IoTConsensusMemoryManager` 全局管控（`offer()` 前先 `reserve()`），配额不足时写入路径被节流——这就是 `needBlockWrite()` 的第二重含义。内存计费用**请求引用计数避免重复计费**：`reserve(IndexedConsensusRequest)` 以 `request.incRef()` 返回值为准——首次（prevRef == 0）才真正分配，`free()` 则在 decRef 后归零（prevRef == 1）才释放；两侧分配策略不同：来自队列的走 `allocateIfSufficient(size, maxMemoryRatioForQueue)`（默认 0.6 比率软限制），在途 batch 走无条件 `allocate`——队列里的请求还有 WAL 兜底可丢，在途 batch 丢不起。`IndexController` 每 3 分钟 `checkAndFlushIndex()` 把 minFlushedSyncIndex 写 checkpoint，并 `reader.setSafelyDeletedSearchIndex()` 通知 WAL 可以安全删除旧日志——**WAL 的 GC 上界由复制进度决定**。

副本变更（`IoTConsensus.addRemotePeer()`）是七步流程：inactivatePeer → notifyPeersToBuildSyncLogChannel → takeSnapshot → transmitSnapshot（`SnapshotFragmentReader` 分片 + `IoTConsensusRateLimiter` 限速）→ triggerSnapshotLoad → activePeer → cleanupRemoteSnapshot。全程埋了 `KillPoint` 注入点（`DataNodeKillPoints` / `IoTConsensusRemovePeerCoordinatorKillPoints`）供混沌测试在任意一步注入故障。**V2 的对应协议**（`IoTConsensusV2.addRemotePeer()`）是四步：`setRemotePeerActive(peer, false, false)` 先失活新 peer → `notifyPeersToCreateConsensusPipes(peer)` → `waitPeersToTargetPeerTransmissionCompleted(peer)` → 激活；中途失败捕获 `ConsensusGroupModifyPeerException` 后 `notifyPeersToDropConsensusPipe(peer)` 回滚。V2 同样不支持 leader 切换：`transferLeader` 直接抛 `ConsensusException`，`isLeader` 恒返回 true。

### IoTConsensusV2：复用 Pipe 基础设施

`pipe/IoTConsensusV2.java`（前身 `PipeConsensus`，工厂保留 `LEGACY_IOT_CONSENSUS_V2` 兼容映射）的关键改进是**不再自建复制通道**：`DataRegionConsensusImpl.buildConsensusConfig()` 直接指定 pipe 插件链——`BuiltinPipePlugin.IOTDB_EXTRACTOR` → `IOT_CONSENSUS_V2_PROCESSOR` → `IOT_CONSENSUS_V2_ASYNC_CONNECTOR`，接收端是 `ConsensusPipeSink` / `ConsensusPipeReceiver`。复制模式 `ReplicateMode` 支持 `batch` / `stream` 两档（`CONF.getIotConsensusV2Mode()`）。请求带 `ComparableConsensusRequest` / `IoTProgressIndex` 进度索引，follower 侧经 `writeOnFollowerReplica()` 落地。

> ⚠️ 待核实：V2 截至该版本是否默认启用——`ConsensusFactory` 中 V2 需手动 `IoTV2GlobalComponentContainer.build()` 初始化，非默认配置项值。

### Ratis 状态机桥接

`ratis/ApplicationStateMachineProxy.java` 继承 Ratis `BaseStateMachine` 并实现 IoTDB `IStateMachine.EventApi`。`applyTransaction()` 有一个精细优化：**leader 直接从 `trx.getClientRequest().getMessage()` 拿内存中的请求对象，follower 才从 log 字节反序列化**（`ByteBufferConsensusRequest`）——省掉 leader 一次序列化 + 反序列化往返。`Utils.stallApply()` 决定写异常时是否停住 apply：DataRegion 停住保一致（数据不能默默丢），SchemaRegion 继续走（元数据靠 Raft 重放兜底）。

Raft 日志的磁盘占用由 **`DiskGuardian`** 以"标记-执行"两阶段守护：`registerChecker(Predicate<RaftLogSummary>, TimeDuration)` 按间隔注册 checker；checkerDaemon 对每个 RaftGroupId 求值 checker，任一为真则 `getSnapshotFlag(groupId).set(true)`（`Map<RaftGroupId, AtomicBoolean>` 的 snapshotFlag 就是两个守护任务间的状态传递通道）；snapshotDaemon 只对 flag 为真的组调 `triggerSnapshot(...)` 并 `compareAndSet(true, false)` 清除标记。两个守护共用单线程 `newSingleThreadScheduledExecutor` 的 workerThread。

`DataRegionStateMachine.write()` 用 `planNode.accept(new DataExecutionVisitor(), region)` 执行写入计划；`WRITE_PROCESS_REJECT` 在状态机层重试最多 5 次（每次 sleep 1s）——`needRetry()` 注释解释 why：只有系统拒绝需要状态机层重试补原子性，readonly 类错误由共识层重试。`read()` 特判 `GetConsensusReqReaderPlan` 返回 WALNode——这是 LogDispatcher 读 WAL 的入口，读请求被复用为复制通道的内部 RPC。`SchemaRegionStateMachine.write()` 成功后会调 `PipeDataNodeAgent.runtime().schemaListener().tryListenToNode()`，把 schema 变更通知 pipe（数据订阅/同步的事件源）。

### ConfigNode 共识

ConfigNode 侧（`confignode/manager/consensus/ConsensusManager.java`）是全局唯一的 ConfigRegion Raft 组（`DEFAULT_CONSENSUS_GROUP_ID`），种子节点首启时 `createPeerForConsensusGroup(仅自己)` 建单成员组。协议二选一：`config_node_consensus_protocol_class` 默认 `RATIS_CONSENSUS`，单机测试可退化 `SIMPLE_CONSENSUS`（WAL 由 `writelog/io/SingleFileLogReader` 回放）。状态机 `ConfigRegionStateMachine` 处理独立的 `ConfigPhysicalPlan` 请求体系，写路径经 `ConfigPhysicalPlanVisitor`。含 leader epoch 机制——"epoch is bumped eagerly on the consensus thread"，防 leader 切换窗口期脑裂。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂 + 反射策略 | `ConsensusFactory.getConsensusImpl()` | 新增协议只需新包 + 配置类名，DataRegion/SchemaRegion 侧零改动 |
| 策略 + 注册表 | `IConsensus` / `IStateMachine` 双抽象，`IStateMachine.Registry` 按 `ConsensusGroupId` 惰性创建 | 协议不依赖 DataRegion/SchemaRegion 具体类型 |
| 访问者 | `DataExecutionVisitor` / `SchemaExecutionVisitor` / `ConfigPhysicalPlanVisitor` | plan 执行与状态机解耦，新增 plan 类型不动状态机骨架 |
| 代理 | `ApplicationStateMachineProxy` 桥接 Ratis `StateMachine` API 与 IoTDB `IStateMachine` | 适配第三方 Raft 库的接口形状 |
| 生产者-消费者 | `LogDispatcher` + `pendingEntries` + 每 Peer 一线程 | 写路径与复制路径解耦，各自背压 |

## 模块间交互

共识层向上被 StorageEngine（数据）与 SchemaEngine（元数据）调用——它们各持 `DataRegionConsensusImpl` / `SchemaRegionConsensusImpl` 单例；向下经 `IStateMachine.Registry` 回调 datanode 的 `DataRegionStateMachine` / `SchemaRegionStateMachine`（`datanode/.../db/consensus/statemachine/`）。PlanNode 类型定义在 node-commons（因为 `IConsensus` 签名里有它，放 datanode 会循环依赖）。与 pipe 的关系是 IoTConsensusV2 直接复用其插件链；与 ConfigNode 的关系是 region 迁移（`RegionMigrateProcedure` 驱动 `addRemotePeer`/`removeRemotePeer`）。无循环依赖。

## 扩展方式

新增一个共识协议实现的最短路径：

1. 在 `iotdb-core/consensus` 新包下实现 `IConsensus`，构造器签名固定 `(ConsensusConfig, IStateMachine.Registry)`；
2. 在 `ConsensusFactory` 加协议常量；
3. 配置 `data_region_consensus_protocol_class` / `schema_region_consensus_protocol_class` 指向新类名——`getConsensusImpl` 反射加载，DataRegion/SchemaRegion 侧无需改动。

调整 IoTConsensus 复制行为（批大小 `maxLogEntriesNumPerBatch`、在途窗口 `maxPendingBatchesNum`、节流阈值 `walThrottleThreshold`）都经 `IoTConsensusConfig.Replication` 可配，且 `reloadConsensusConfig` 支持热更新。
