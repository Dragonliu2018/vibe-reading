---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "DistTAE 引擎"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "存算分离", "logtail"]
description: "MatrixOne DistTAE 模块解读：CN 侧 workspace 内存写、logtail 增量订阅与 PartitionState CoW 缓存、三路合并 Reader。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/vm/engine/disttae/`（约 4.15 万行含子包）是 "distributed TAE"——CN 侧的事务缓存引擎。它让 CN 在**没有任何本地持久状态**的前提下提供数据库语义：读已提交数据靠订阅 TN 的 logtail 维护内存缓存（`PartitionState`），事务写缓存在内存 workspace，提交时整包 ship 给 TN。它是存算分离架构中"CN 数据面"的全部实现，也是执行器（`engine.Reader` 消费方）与事务系统（`Workspace` 接口实现方）之间的枢纽。

## 模块架构

![disttae 架构](/vibe-reading/images/articles/matrixone-internals/disttae-arch.svg)

四个核心角色：**Engine**（types.go:256，进程级单例，持 `partitions map[[2]uint64]*logtailreplay.Partition` 与 txn client）、**PushClient**（logtail_consumer.go，订阅状态机 + 常驻增量消费 goroutine）、**Transaction**（types.go:354，workspace，实现 txn client 的 `Workspace` 接口）、**txnTable**（types.go:1204，事务内打开的表，实现 `engine.Relation`）。读的汇聚点是 **LocalDisttaeDataSource**（local_disttae_datasource.go:96），合并三路数据。

```go title="pkg/vm/engine/disttae/types.go"
type Entry struct {            // L1094：workspace 中的一个写条目
    typ int                    // INSERT/DELETE/DDL
    bat *batch.Batch           // 内存批（或 dump 后为空）
    fileName string            // dump 到 S3 后的对象引用
    tnStore DNStore            // 目标 TN shard
}
```

## 调用链路

**读路径**（compile 触发）：`txnTable.BuildReaders`（txn_table.go:2310）← `txnTable.Ranges/doRanges`（696/995）——`getPartitionState` 取订阅缓存快照，`rangesOnePart` 用 zone map / bloom filter 裁剪出 BlockInfo 列表 → `buildLocalDataSource`（2247）构造 `LocalDisttaeDataSource` → `readutil.NewReader`（readutil/reader.go:400）按 `ds.Next()` 拉数 → `ApplyTombstones` 应用 4 处删除来源（txn_table.go:1097-1106 的经典注释枚举）。

`Ranges` 有条**对象级快速路径**：无 BlockFilters、`PreAllocBlocks > 128`、且 `!DontSupportRelData` 三个条件同时满足时走 `getObjList`（txn_table.go:697-699），直接返回对象列表而非块列表——`collectUnCommittedDataObjs` 收集的未提交对象与 `ForeachSnapshotObjects` 遍历的已提交对象分别追加到对象列表的两段，跳过逐块裁剪的开销。

`LocalDisttaeDataSource.Next`（local_disttae_datasource.go:380）是**三阶段状态机**（`iteratePhase`，:129/:447 的 switch）：`InMem` 阶段合并 workspace 未提交批与 logtail 内存行（`filterInMemUnCommittedInserts/filterInMemCommittedInserts`），产出空 batch 时切换到 `Persisted`；`Persisted` 阶段逐 block 从 S3 读（主键过滤不满足时直接跳过剩余块）；两阶段都完成进入 `End` 终止态。

**写路径**：`txnTable.Write/Delete`（1853/2006）→ `Transaction.WriteBatch`（txn.go:88）——INSERT 前插 rowid 向量、DELETE 按 rowid 排序，追加 `Entry`；提交时 `txnOperator.Commit` → `workspace.Commit` → `Transaction.Commit`（txn.go:2070）：`transferTombstonesByCommit`（txn.go:2086，把删除转移到 tombstone 对象）→ `mergeTxnWorkspaceLocked` 合并同表批 → dump 后 → `checkDup`（**仅当 `!hasS3Op` 且 `TxnOptions().CheckDupEnabled()`**，txn.go:2129-2130）→ `genWriteReqs`（tools.go:37）把 Entry 编码为 `api.PrecommitWriteCmd` 按 `OpPreCommit` 路由到 TN shard 走 2PC。

`WriteBatch` 有个精妙的锁序设计：`resolvePKCheckPosForWrite`（txn.go:124）**在取 `txn.Lock` 之前**解析 PK 列位置——因为它可能触达 `Engine.Database`、构造内部 SQL 并经 `UpdateSnapshotWriteOffset` **重入 txn.Lock**，先解析可避免死锁；INSERT 的 `pkCheckPos++` 是因为 rowid 随量随后会插到 attr 0，PK 位置整体后移一位（txn.go:135-137 注释）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Engine.New/Database`（engine.go:88/296） | 建 txn 与库句柄 | workspace 挂上 txnOperator |
| `txnTable.Ranges`（txn_table.go:696） | 裁剪 BlockInfo | zone map + bloom filter |
| `LocalDisttaeDataSource.Next`（local_disttae_datasource.go:380） | 三路合并拉数 | InMem/Persisted 两阶段 |
| `Transaction.WriteBatch`（txn.go:88） | workspace 追加写 | rowid 注入 + 排序 |
| `dumpBatchLocked`（txn.go:627） | 溢写 S3 | 双阈值 + 配额 |
| `PushClient.toSubscribeTable`（logtail_consumer.go:457） | 订阅状态机 | cache miss 触发 |
</details>

## 核心实现

### Lazy 订阅 + CoW 快照 = 无锁读

表首次被读才订阅，订阅状态机实际是**五态**（logtail_consumer.go:489 注释给出完整环）：`Unsubscribed → Subscribing → SubRspReceived → Subscribed → Unsubscribing → Unsubscribed`。`Subscribed` 后由 `receiveLogtails`（logtail_consumer.go:721）常驻 goroutine 持续消费增量；处于 `Unsubscribing` 时 `toSubscribeTable` 必须先 `waitUntilUnsubscribingChanged` 等退订完成（:508-511 注释：否则订阅/退订乱序执行，PartitionState 会泄漏 log tail）；完全 `Unsubscribed` 状态下直接返回（防重入）。每个事务经 `Partition.Snapshot`（logtailreplay/partition.go:125）拿不可变 `PartitionState` 指针，后台 logtail 应用在 `MutateState` 产出的新版本上——**读完全不加锁**。一致性边界由 `validLogtailMustApplied`/`waitCanServeTableSnapshot`（logtail_consumer.go:345/389）保证：事务 snapshotTS 之前的 logtail 已应用才允许读。

### workspace 双阈值溢写

`dumpBatchLocked`（txn.go:627）按调用场景分两种判断：非提交场景（`offset >= 0`，来自写路径）对比 `writeWorkspaceThreshold`（防 OOM 即时溢写）；提交场景（`offset < 0`，来自 Commit）对比 `commitWorkspaceThreshold` 并叠加 `insertEntryMaxCount × 2` 的条目数上限（减少 S3 小对象）。写入量小于阈值时，`scanInMemInsertSize`（txn.go）核算后配合 `AcquireQuota`（engine.go:277）配额机制临时提升限额，避免不必要的 dump。dump 出的对象以 `fileName` 引用进 Entry，提交后由 TN 重放保证原子性。

### PK 去重三层

workspace 内 `checkDup`（txn.go:407）查本事务 map；内存态 `PartitionState.PKExistInMemBetween`（partition_state.go:1077）；持久态 `txnTable.PKPersistedBetween`（txn_table.go:2602）用 changed objects 的 zone map + block bloom + commit_ts 精判——避免全对象扫描，是 SI 隔离下防脏写的关键路径。

### CN Merge

`cnMergeTask`（merge.go）让 CN 直接读 S3 对象重写合并成新对象，写 `MergeCommitEntry` 交 TN 提交——把 compaction 下推到有算力的 CN。调度入口 `txnTable.MergeObjects`（txn_table.go:3005）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Lazy 订阅状态机 | logtail_consumer.go:457 | 冷表不占内存 |
| Copy-on-Write | partition.go:125/133 `Snapshot/MutateState` | 无锁快照读 |
| 多级缓存 | `Transaction.tableCache` / `Engine.catalog`（CatalogCache）/ `Engine.snapshotMgr`（LRU 快照分区，db.go:502） | 热点对象复用 |
| Partition 感知 | `Engine.partitions` 按 `[dbID,tblID]`；`txn_table_combined_partition.go` 分区表路由 | 分区表透明 |

## 模块间交互

向 txn client 实现 `Workspace` 接口（commit 由 operator 驱动，operator.go:1136）；向 tae 经 morpc 订阅 logtail（`PartitionState.HandleLogtailEntry`，partition_state.go:367 增量应用）；objectio/fileservice 承担 workspace 溢写与 block 读；compile 是 Reader 的唯一消费方（scope.go:1134/1218）。CCPR 通过 `CCPRTxnCache`（ccpr_txn_cache.go）登记对象写入。

## 扩展方式

- **新增 Reader 类型**：改 `txn_table.go` 的 `BuildReaders`（2310）与 `buildLocalDataSource`（2247），在 `LocalDisttaeDataSource.Next` 新增 `iteratePhase` 分支——消费方 compile 走 `engine.Reader` 接口无感。
- **调整 flush 策略**：改 `txn.go` 的 `dumpBatchLocked`（627）与 `Engine.SetWorkspaceThreshold`（engine.go:243）及 `types.go:180-210` 的 EngineOptions。
- **调整订阅/GC 策略**：改 `logtail_consumer.go` 的 `doGCUnusedTable/doGCPartitionState`（1074/1180）与 `PartitionState.truncate`（partition_state.go:971）。
