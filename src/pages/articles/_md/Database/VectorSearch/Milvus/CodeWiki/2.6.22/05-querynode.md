---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "QueryNode 查询执行"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "Go", "MVCC", "cgo"]
description: "Milvus QueryNode 解读——delegator 的 TSafe 等待与 MVCC 语义、growing/sealed 双 scope 协调、delete buffer 与 L0 转发、TargetVersion 门控、三层归并与零拷贝 cgo"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

`internal/querynodev2/`（134 文件 ~31K 行）是查询的执行节点：管理 loaded segment、消费 WAL 维护 growing 数据、接收 Search/Query 请求并经 cgo 调 C++ segcore。**Delegator 是本模块的灵魂**——一个 vchannel（shard）的统一查询入口，承担一致性读视图（TSafe/MVCC）、数据分布账本、流式数据原子应用三重职责。

## 模块架构

`QueryNode`（`server.go:95`）核心字段：统一 `segments.Manager`（CollectionManager + SegmentManager + DiskCache + Loader，v2.6 已无独立双管理器）、`clusterManager`（Worker 抽象——`nodeID == 本节点` 返回 LocalWorker 进程内直调，否则 gRPC 远端）、`pipelineManager`（每 channel 一条流水线）、`delegators ConcurrentMap`、`scheduler`（基于 NQ 的公平调度）、`dispClient`（WAL 消息分发，带 streaming 的 DelegatorMsgstreamFactory）。

启动（`Init` in `server.go:314`）：etcd session（含 index engine 版本协商）→ chunkManager → scheduler → cluster/delegators/Manager → `initcore.InitQueryNode`（**初始化 C++ segcore 与三级线程池**）→ segcore 配置热更新 watcher（`C.ResizeTheadPool` 运行时调线程池）。`Stop`：先 `session.GoingStop()` 让 QueryCoord 搬走数据，轮询等 segment/channel 清空（超时 GracefulStopTimeout）再关——优雅停机的协议。

`WatchDmChannels`（`services.go:198`）是装配核心：PutOrRef collection → `NewChannelQueryView`（以 channel checkpoint 为界的初始查询视图）→ `NewShardDelegator`（`delegator.go:1338`）→ pipelineManager.Add → 注册 excluded segments → loadL0 + loadGrowing → 消费 WAL 流 → delegator.Start。

## 核心实现

### Delegator：TSafe 与 MVCC（正确性核心）

**TSafe 的推进**：pipeline 的 `deleteNode.Operate` 末尾调用 `delegator.UpdateTSafe(timeRange.timestampMax)`（`pipeline/delete_node.go:101`）——关键顺序：同一 pipeline 里 `ProcessDeleteBatches`（入 delete buffer + bloom filter 转发）发生在 `UpdateTSafe` **之前**——TSafe 只在一个 msg pack 的所有 insert/delete 都被应用后才推到该 pack 的 max ts。这就是"服务可用时间戳"：**ts ≤ TSafe 的所有 WAL 消息保证已生效**。

**等待逻辑**：`waitTSafe`（`delegator/delegator.go:1052-1121`）——快路径直接读 `latestTsafe`；慢路径在 `tsCond`（ContextCond）上条件变量等待（`UpdateTSafe` 的 LockAndBroadcast 内 store+broadcast 防丢失唤醒）。防御性退出：(a) `DowngradeTsafe` 配置容忍降级直接返回旧值；(b) lag 超 `MaxTimestampLag` 报错；(c) **stall 检测**——`WaitTsafeStallTimeout` 内无 broadcast 返回可重试错误让 Proxy failover 到其他 replica（处理 WAL 消费卡死）。**澄清一个常见误解**：每 shard 各有独立 TSafe，Proxy 按请求的 GuaranteeTimestamp 逐 shard 等待——跨 shard 不取最小值，由每个 delegator 自己 `waitTSafe`。

**MVCC 时间戳**：`Search`（`delegator.go:447`）中先 `speedupGuranteeTS`（Strong 一致性下用 streaming WAL 的本地 MVCC 时间戳加速）→ `waitTSafe` 得到 tSafe → 若请求未带 `MvccTimestamp` 则**用 tSafe 作为 MVCC ts**（:491-493）下发——C++ segcore 据此过滤 `ts > mvcc` 的行（growing 段的 insert 可见性由这个时间戳控制，删除由已应用的 delete buffer 保证）。

### Search 的完整调用链

```
QueryNode.Search（services.go:827，单 channel）
└─ searchChannel（handlers.go:416，取 delegator）
   └─ shardDelegator.Search（delegator.go:447：speedupGuranteeTS → waitTSafe →
      PinReadableSegments → 剪枝 → organizeSubTask）
      ├─ organizeSubTask（delegator.go:858-907）：sealed 按 worker 分组打包
      │   DataScope_Historical 子任务；growing 固定本地 DataScope_Streaming
      ├─ executeSubTasks（:909）：errgroup 并发 worker.SearchSegments
      │   （partial result：数据占比 ≥ PartialResultRequiredDataRatio 可返回部分结果）
      └─ worker.SearchSegments（本地 LocalWorker / 远端 gRPC）
         └─ scheduler.Add(SearchTask)（tasks/search_task.go:139）
            ├─ segcore.NewSearchRequest（cgo 构建 C++ plan + placeholder）
            ├─ SearchHistorical / SearchStreaming（segments/search.go:206/221）
            │   └─ LocalSegment.Search（segment.go:654）→ cgo 进 C++ 段引擎
            └─ segcore.ReduceSearchResultsAndFillData（段间归并，零拷贝 SlicedBlob）
   ← 各 worker 结果 → segments.ReduceSearchOnQueryNode（shard 内归并）
```

**任务合并**：`SearchTask.Merge`（`search_task.go:322`）允许 scheduler 把同 collection/channel/segment 集/expr/MVCC 的多个请求合并 NQ 一次下推（TopK 差异受 `TopKMergeRatio` 限制），结果经 originNqs 切回各任务。`StreamingSearchTask`（:441）：Historical 段边搜边流式 reduce 降低峰值内存。

### 数据面：insert / delete / 加载

**ProcessInsert**（`delegator_data.go:93`）：lazy 创建 growing segment → `growing.Insert` 写入 C++ → `UpdateBloomFilter` 维护 PK bloom filter → 在 growingSegmentLock 下原子注册到 segmentManager + distribution（`TargetVersion = initialTargetVersion(0)`，growing 自身就是 pkoracle Candidate）。

**deleteNode**（`pipeline/delete_node.go:70`）把 DeleteMsg 按 `msg.EndTs()` 分组成 `deleteDataByTs`（保证 delete buffer 收到非递减时间戳批次）后调 **`ProcessDeleteBatches`**（`delegator_data.go:203`）：先 `deleteBuffer.Put`（按 ts 组织的 list delete buffer）再 `forwardStreamingDeletion`。删除转发两策略（`delta_forward.go`）：`FilterByBF`（默认——`BatchGetFromSegments` 对 pinned snapshot 的 sealed/growing Candidate 批量 bloom filter 判定，**命中才按 worker 转发 `worker.Delete`**，未命中段零开销）与 `Direct`（全量转发，v2.6 的批量 DeleteBatch RPC）；L0 侧另有 `L0ForwardPolicyRemoteLoad = "RemoteLoad"`（`delta_forward.go:51`——直接把 L0 deltalogs 塞进 LoadRequest 让 worker 自己重放），初始值来自 `QueryNodeCfg.LevelZeroForwardPolicy` 配置。**为什么 leader 转发而非各 worker 自算**：避免 N 倍 WAL 消费 + 顺序问题。

**L0 segment**：`LoadL0`（`delegator_data.go:637`）加载后注册进 `deleteBuffer.RegisterL0`——**不可查询**（`readableFilter` 排除，`distribution.go:637`），只作为删除记录源：新 segment 加载时 `forwardL0Deletion`（`delta_forward.go:56`）把 L0 中 bloom filter 命中的删除转发过去。**DeleteBuffer + L0 段统一了"内存 delete buffer"与"磁盘 L0 deltalog"两个来源**。

**LoadSegments**（`delegator_data.go:472`）的三阶段 `loadStreamDelete`（:812）：Phase0 L0 转发 → Phase1 RLock 快照 delete buffer → Phase2 无锁 BF 过滤+转发（#49435 教训：不能持锁做 RPC 否则饿死 ProcessDelete 冻结 tsafe）→ Phase3 锁外追赶最多 5 轮，最后仍不空则持 RLock 做最终 barrier 并原子 `addDistributionIfVersionOK`——**"删除已应用"与"segment 可见"原子化**。

### distribution 快照与 TargetVersion

`distribution`（`distribution.go:108`）每次变更 `genSnapshot`（:581）生成不可变 snapshot（nodeID→segments 分组），查询 `PinReadableSegments`（:174）先检查 `channelQueryView.Serviceable()` 再按 `readableFilter`（:634：`TargetVersion == targetVersion || == initialTargetVersion`）过滤。**TargetVersion 常量族**（:37-46）：`wildcardNodeID = int64(-1)`（匹配任意 nodeID 的强制分布纠正）；growing 消费产生=`initialTargetVersion(0)`；LoadSegments 的 sealed 初始 `unreadableTargetVersion(-2)`（等 SyncTargetVersion 才可读）；被 target 淘汰的 growing=`redundantTargetVersion(-1)`——保证**查询视图与 QueryCoord target 原子对齐**，避免读到已 balance 走的旧副本。

### pkoracle 与剪枝

`PkOracle` 接口（`pkoracle/pk_oracle.go:28`）：`Get(pk)/BatchGet(pks)` 返回 bloom filter 判定"可能含此 PK"的 segment 集。两种 Candidate：sealed 段的 `BloomFilterSet`（statslog 的 PK bloom + min/max，支持历史多版本合并判定）；growing 段的 LocalSegment 自身。实际用途三个：**删除路由**（`BatchGetFromSegments`）、**点查剪枝**（`PruneSealedSegmentsByPKFilter`，`delegator/pk_filter.go`——从 plan 抽 PK 谓词编译成 `PKFilterExpr` IR，对 sealed 段按 min/max 快速排除 + BF 精确判定，`pk in (1,2,3)` 只扫 BF 命中的段）、**partition stats 剪枝**（`segment_pruner.go`：PK 分布直方图按数据量比例裁剪）。

### cgo 零拷贝

`LocalWorker` 进程内直调（`local_worker.go:70-83` 注释揭示的精妙点：in-process 调用不走 gRPC codec，C++ pin 的零拷贝内存不会被 Marshal 触发释放，故须手动 unmarshal 并 `MsgPins.Release`）；`EnableResultZeroCopy`：SlicedBlob 直接引用 C++ 内存，靠 gRPC Marshal 时 MsgPins 释放。**为什么 cgo 而非进程间**：结果零拷贝 + growing 段高频小写入（cgo 百 ns 级 vs IPC 序列化）+ C++ 状态可直接持句柄；代价是 Go GC 与 C++ 内存手工管理，C++ 侧三级线程池兜底（cgo pin Go 线程，重活留在 C++ 线程跑）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Delegator（分片代表） | `delegator/delegator.go:135` | 一致性读视图 + 分布账本 + 流式原子应用 |
| 快照不可变 | `genSnapshot`（distribution.go:581） | 查询 pin 无锁读 |
| 双 scope 分治 | `organizeSubTask`（delegator.go:858） | growing/historical 拓扑与引擎路径差异 |
| 两层归并 | worker 内段间 + shard 内 + Proxy 跨 shard | top-k 归并代价 O(numSegments × topk) |
| Worker 门面 | `cluster/worker.go:39`（Local/Remote 双实现） | 位置透明的进程内/远端 |

## 模块间交互

上游消费 [Streaming](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/06-streaming) 层的 WAL 流（msgdispatcher）；下游 cgo 调 [Segcore](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/07-segcore)；分布对账上游是 [QueryCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/04-querycoord) 的 checker（LoadSegments/SyncTargetVersion）；partial result 失败段 `markSegmentOffline` 等待修复而非硬失败。

## 扩展方式

**新增一种查询类型**：proto 加 RPC → `ShardDelegator` 接口加方法（复用 `speedupGuranteeTS + waitTSafe + PinReadableSegments + organizeSubTask/executeSubTasks` 三件套，照 `Query` in `delegator.go:667` 骨架）→ Worker 双实现 → `tasks/` 新 Task（`MergeWith` 返回 false 即不参与合并）→ C++ 需要则加 cgo 封装 + segments 接口方法。**修改 TSafe 语义需极其谨慎**——`waitTSafe`/`UpdateTSafe` 的锁序和 pipeline 节点顺序是全局正确性锚点。
