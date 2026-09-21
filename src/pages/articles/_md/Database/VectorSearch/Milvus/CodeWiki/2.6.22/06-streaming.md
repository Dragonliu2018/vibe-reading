---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "Streaming 流式层"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "WAL", "Woodpecker", "流式架构"]
description: "Milvus v2.6 流式层解读——StreamingNode 的 WAL 抽象与五拦截器链、WriteAheadBuffer 免打穿 MQ、flusher 复用 flushcommon、woodpecker 自研对象存储 WAL 与 term 防脑裂"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

v2.6 流式改造的落地层：`internal/streamingcoord/`（嵌入 MixCoord 进程）+ `internal/streamingnode/`（~21K 行）+ `pkg/streaming/` 公共层。**为什么 WAL 要一层 StreamingNode 而不是各组件直连 MQ**：(1) 流式语义必须在"写 WAL 的那一瞬间"决定——shard 拦截器在 append 前写 SegmentAssignment、lock 拦截器在 append 前锁 vchannel，做在客户端或消费端都无法保证 exactly-once；(2) **单写者 + term**——每个 pchannel 同一 term 只有一个 RW streamingnode（`Channel.Term` 校验 + `ErrFenced` + woodpecker 条件写围栏），从根上防脑裂/双写，通用 MQ 的共享 topic 做不到 per-channel fencing；(3) 解耦 MQ 实现——walimpls 接口 + registry + 动态 opener，checkpoint 携带 WALName 支持运行时换后端。

**角色接线**：StreamingNodeRole = EnableStreamingNode + **EnableQueryNode**（`cmd/milvus/util.go:139-142`——每个 StreamingNode 进程内嵌一个 QueryNode，growing 数据就在本机内存，查询消掉跨机拉取）。职责边界（`openRWWAL` 的组装可见）：WAL append + 流式 flush + segment 分配/seal + 事务 + MVCC/timeTick + 跨集群复制 + 恢复——**没有 compaction、没有 import**（留在 datanode）。

## 模块架构

![v2.6 流式架构](/vibe-reading/images/articles/milvus-internals/streaming-wal.svg)

## 核心实现

### WAL 两级接口与动态 opener

**框架级 `WAL`**（`wal/wal.go`）：`Append/AppendAsync/Read/GetLatestMVCCTimestamp` + Channel/Metrics——注释明确"Don't implement it directly, implement walimpls.WAL instead"。**实现级 `WALImpls`**（`pkg/streaming/walimpls/wal.go`）：只有 `Append/Read/Truncate`，无拦截器无 flusher；`ErrFenced` 语义：底层写入被永久围栏（woodpecker writer 锁丢失），必须换新实例。

`NewOpenerAdaptor`（`adaptor/opener.go`）是**动态 opener**：构造时不绑 MQ 类型，Open 时由 `determineWALName` 决定——优先从 etcd 的 pchannel checkpoint 取 `MessageID.WALName()`（**为运行时切换 WAL 后端/升级迁移服务**，`handleAlterWAL` 两阶段排干旧 WAL 推 checkpoint 到新 WAL）。RW 打开的组装：`RecoverRecoveryStorage`（从 etcd checkpoint 恢复）→ `determineLastConfirmedMessageID`（last confirmed 取所有未提交事务消息的最小值，保证事务性读承诺）→ TxnManager/ShardManager/ReplicateManager → **flusher**（`opt.DisableFlusher` 为 false 时 `flusherimpl.RecoverWALFlusher`——测试可关）→ 挂拦截器链。

**Append 路径**（`wal_adaptor.go:147`）：`isFenced` 检查（term 失效拒绝一切写）→ 等拦截器 `Ready()` → `msg.WithWALTerm(channel.Term)` → **`contextutil.MergeContext(WithoutCancel(ctx), availableCtx)`——append 不可被调用方取消**（防止"内存状态已改但日志没落"的不一致：写日志要么成功要么节点关闭）→ 拦截器链 → 最内层 `WALImpls.Append`。

### 五拦截器链：redo → lock → replicate → timetick → shard

洋葱模型（`interceptors/interceptor.go`，DoAppend 的 append 后操作永不返回 error）：

- **redo**：`ErrRedo` 重做循环——segment 分配发现 timeTick 过老/分区被围栏时回环刷新 timetick 重走一遍链；
- **lock**：pchannel 全局写锁 + per-vchannel 锁；排他消息（ManualFlush）会 `FailTxnAtVChannel` 使在途事务失败——防止事务消息跨排他消息乱序（注释给了完整例子）；
- **replicate**：active-active 跨集群复制（与 broadcaster 的 primary/secondary 角色呼应）；
- **timetick**：流式 timeTick 由 streamingnode 周期产生并写入 WAL——**替代旧架构 datanode/querynode/proxy 各自的 timeTick**；`GetLatestMVCCTimestamp` 消费它实现"读己之写"一致读；
- **shard**（`shard/shard_interceptor.go`）：写路径上的 **segment 分配器**——`handleInsertMessage`（:144）对每 partition 调 `shardManager.AssignSegment`，把 `SegmentAssignment` 写进消息 header 再落 WAL：**segment 归属在写 WAL 前就确定**，消费侧无需再分配。错误分档：`ErrTimeTickTooOld/ErrWaitForNewSegment/ErrFencedAssign` 返回 redo.ErrRedo（回环重走链）；`ErrTooLargeInsert/ErrPartitionNotFound/ErrCollectionNotFound` 返回不可恢复错误（shard_interceptor.go:177）。`StatsManager` + `policy/seal_policy.go` 提供 seal 触发（capacity/binlog 数/lifetime/idle/growing 水位/node memory/blocking L0）。

**WriteAheadBuffer**（`interceptors/wab/`）：append 成功的消息按 timetick 有序进内存 ring buffer，消费端 `ReadFromExclusiveTimeTick` 直接读内存——**querynode 的 growing 订阅大多不用打穿到 MQ**，消除旧架构"每个 querynode 独立订阅 Pulsar"的重复拉取。

### Flusher：复用 flushcommon 的实时落盘

`WALFlusherImpl.Execute`（`wal_flusher.go:59`）：从 recovery checkpoint（所有 vchannel 的最小值）起 `l.Read` 扫 WAL，`dispatch` 每条消息——非持久化的空 TimeTick 按 `FlushEmptyTimeTickMaxFilterInterval` 阈值节流过滤（wal_flusher.go:222，省 CPU）；TruncateCollection 先 ObserveMessage 再处理，其余消息 defer 观察。`buildFlusherComponents` 按 snapshot 的 vchannels 从 DataCoord 取 `VchannelInfo` 恢复信息——内含 **per-vchannel 的 dataSyncServiceWrapper**，底层复用从 datanode 抽出的 `internal/flushcommon/pipeline.DataSyncService`（flowgraph + writebuffer + syncmgr 原班人马）。`WhenCreateCollection`（`flusher_components.go:36`）收到建表消息才建 sync service，`SeekPosition` 用消息的 `LastConfirmedMessageID`——**exactly-once 消费**（重复消息靠 checkpoint 幂等跳过）。增量 flush：不是定时全量，writebuffer 按水位持续同步增量 binlog；seal 由 shard 拦截器的 seal policy 驱动。**RecoveryStorage** 把每条消息的效果观察进内存并周期持久化 etcd——流式 exactly-once 的账本，崩溃后重建快照。

### StreamingCoord：balancer + broadcaster

**Balancer**（`balancer_impl.go:308`）：单后台任务模型（所有 API 变 request 排队串行）。均衡循环：取 `CurrentPChannelsView` → 收集节点状态 → `policy.Balance`（默认 `vchannelfair`：新 channel 按全局不平衡分最低分配；挑 `RebalanceMaxStep` 个 channel 摘下 DFS 搜索更优布局，仅当改善超过 `RebalanceTolerance` 才应用——防抖动）→ `applyBalanceResultToStreamingNode`（:612）**逐 channel 并发**执行：先对历史节点发 Remove 再向新节点发 Assign（**term 递增**），直到不动点。`AllocVirtualChannels` 为新建 collection 分配 vchannel（取代旧 rootcoord 的 hash 到 pchannel）。升级门槛 `checkIfAllNodeGreaterThan260AndWatch`——全集群 ≥2.6 才启用（灰度开关）。

**Broadcaster**（DDL 广播，[RootCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/02-rootcoord) 的回调注册处）：`broadcastTask` 是持久化状态机（PENDING → WAIT_ACK → TOMBSTONE），带 `AckedVchannelBitmap` 逐 vchannel 记 ack，**崩溃后从 etcd 恢复**——每 vchannel 由 broadcast_worker 向该 channel 所在 pchannel 的 WAL append 一份。ack 回调按 broadcastID 排序调度，保证同一资源键上广播的**全局有序**——DDL 排他性的来源。还承担跨集群复制角色检查（只允许 primary 广播）。

### Woodpecker：自研对象存储 WAL

`zilliztech/woodpecker`（v0.1.14-dev）——**云原生共享日志存储**：数据放对象存储（S3/MinIO 或 local），元数据放 etcd；segment 滚动（256M/10min）、写缓冲批量 sync（200ms）、后台 compaction 合并小文件、TTL 保留（72h）、**fence policy（条件写实现单写者围栏，`ErrLogWriterLockLost` → `walimpls.ErrFenced`）**。消息 ID 是 `(SegmentId, EntryId)` 二元组。**为什么自研**（configs/milvus.yaml:167-172 注释）：Milvus 部署必须自带或外接 MQ，Pulsar/Kafka 运维重成本高；Milvus 本就有 S3+etcd——**Woodpecker 用既有基础设施提供专为 WAL 语义设计**（append+围栏+truncate+顺序读）的日志，不需要通用 pubsub 的复杂度。集群模式限制：local storage 不能用于集群（`wal_selector.go` 显式 panic——日志必须跨节点共享）。

### 与 Datanode 的关系

v2.6 的 datanode **完全不再消费 WAL**：`WatchDmChannels is not in use`（`services.go:53` 空壳）；原实时链路（flowgraph/writebuffer/syncmgr）整体迁到 `internal/flushcommon/` 被 streamingnode 的 flusher 复用——**驱动源从"MQ 订阅"换成"streamingnode 内 WAL 扫描"**，落盘代码两节点共享一套。职责切分：**StreamingNode = 写路径（WAL+flush+segment 分配+growing 查询），DataNode = 离线重活（compaction/import/index）**。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 裸/语义两级接口 | `WALImpls` vs `WAL`（adaptor 装配） | 裸日志与流式语义分层 |
| 拦截器洋葱 | `interceptors/` 五种 | append 瞬间的横切语义可插拔 |
| 动态 opener | `adaptor/opener.go` | 运行时换 WAL 后端 |
| term 防脑裂 | `Channel.Term` + ErrFenced | 单写者围栏 |
| 持久化状态机 | broadcastTask / RecoveryStorage | 崩溃恢复的 exactly-once |

## 模块间交互

上游：Proxy 的 `streaming.WAL().AppendMessages`（`ResumableProducer` 断线重连）；RootCoord 的 DDL 经 broadcaster（回调注册在 [RootCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/02-rootcoord)）。下游：flusher 经 [flushcommon](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/09-datanode) 落盘并上报 DataCoord；内嵌 QueryNode 经 snmanager 被 QueryCoord 当资源组管理。

## 扩展方式

**新增一种 WAL 后端**（woodpecker 模板，五步不触碰框架）：`walimpls/impls/<name>/` 实现 `OpenerBuilderImpls` + `WALImpls`（**Append 必须在永久失锁时返回被 `errors.Mark(err, ErrFenced)` 标记的错误**）+ `ScannerImpls` + `MessageID` → init 里 `registry.RegisterBuilder`（重名 panic）→ `wal_name.go` 加常量 → `wal_selector.go` 加启用探测 → 跑 `test_framework.go` 统一一致性测试。
