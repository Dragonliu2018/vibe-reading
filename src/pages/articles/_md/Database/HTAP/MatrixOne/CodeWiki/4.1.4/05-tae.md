---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "TAE 存储引擎"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "MVCC", "checkpoint", "LSM"]
description: "MatrixOne TAE 模块解读：TN 侧 MVCC 引擎、logtail 有序发布、checkpoint 单一 GC 水位、append-only 段与后台 merge。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/vm/engine/tae/`（约 9.3 万行：db 2.2 万 / txn 1.2 万 / logtail 1.1 万 / catalog 8.4k / rpc 8k / logstore 7.5k / tables 7k）是 TN 节点上的 **Transactional Analytic Engine**（设计文档见 `docs/rfcs/20220503_tae_design.md`）：MVCC 多版本数据、事务协调的 participant、logtail 服务（把变更推给订阅 CN）、checkpoint（全量+增量）、后台 merge/compaction。它是持久化正确性的唯一现场——CN 的所有写最终经它落 WAL 与 S3，所有读缓存最终由它的 logtail 反哺。

## 模块架构

```go title="pkg/vm/engine/tae/db/db.go:86"
type DB struct {
    TxnMgr *txnbase.TxnManager; Catalog *catalog.Catalog
    LogtailMgr *logtail.Manager; Wal wal.Store
    BGCheckpointRunner checkpoint.Runner; BGFlusher checkpoint.Flusher
    MergeScheduler *merge.MergeScheduler; DiskCleaner *gc2.DiskCleaner
    Controller *Controller; Runtime *dbutils.Runtime; CronJobs *tasks.CancelableJobs
}
```

装配链：`db.Open()`（db/open.go:61）→ WAL（`wal.NewLogserviceHandle`，底层 logservicedriver 连 LogService）→ task scheduler → `catalog.OpenCatalog()` → `Controller.AssembleDB()`（db/controller.go:602）依次构建 TxnMgr、LogtailMgr、checkpoint Runner/Flusher、DiskCleaner → `replayFromCheckpoints()`（controller.go:806）+ `db.ReplayWal()` 双段恢复 → 启动 MergeScheduler 与 CronJobs。对外入口是 `Handle`（rpc/handle.go:74），实现 `rpchandle.Handler`：`HandleCommit`（485）、`HandleWrite`（814）、`HandleGetLogTail`（599）及 DDL 系列、2PC 的 `HandlePrepare/HandleCommitting`（rpc/handle_2pc.go）。

## 调用链路

![TAE 架构](/vibe-reading/images/articles/matrixone-internals/tae-arch.svg)

**写入链**：CN→TN RPC `HandleCommit` → `handleRequests`（handle.go:202 逐 entry 分发）→ `txnStore.Append`（txnimpl/store.go:312）→ appendable object 的 `memoryNode.ApplyAppendLocked`（tables/mnode.go:243，内存 Batch + PK index）→ `txn.Commit` → **logtail 发布**：`LogtailMgr.OnEndPrepareWAL` → `orderedCollectAndPublish`（logtail/mgr.go:147）→ 回调 → `LogtailServer.publishEvent`（service/server.go:575，Waterliner 保序）→ `session.Publish` 推给各订阅 CN → apply 生效。2PC 时 TN 是 participant：`HandlePrepare`→Prepared、`HandleCommitting`→`commit2PC`。

**TxnManager 是三队列流水线**（txnbase/txnmgr.go:191-195）：`preWalQueue`（绑 `onPreWalStage`）→ `walQueue`（绑 `onWalStage`）→ `applyQueue`（绑 `onApply`），各为 SafeQueue(20×1000, 1000)；`OnOpTxn`（:474）把事务操作入 `preWalQueue`，队列回调里走 `onPrePrepare`（冲突检查、MVCC node 入链）→ `onBindPrepareTimeStamp`（分配 PrepareTS）→ `store.PrepareCommit`（WAL 序列化）。`onApply`（:708）把 apply 任务提交到 ants `workers` 池**异步执行**，执行前先 `op.Txn.WaitWalAndTail`（:716，等 WAL 落盘与 logtail 发布完成，Rollback 时 no-op）——apply 的生效顺序由此与 WAL/logtail 解耦。

`HandleCommit`（rpc/handle.go:485）对 `moerr.ErrTAENeedRetry` 有**重试循环**（handle.go:561-578）：先释放 `releaseF` 资源，用 `StartTxnWithStartTSAndSnapshotTS` 以**原 snapshotTS** 开新事务重新 `handleRequests`，直到不再 NeedRetry 或出现其他错误；2PC 事务先 `txn.SetCommitTS(TimestampToTS(meta.GetCommitTS()))`（handle.go:547）把协调者的 commitTS 写入事务元数据，保证跨 shard 一致。

**checkpoint 链**：`BGFlusher`（checkpoint/flusher.go:185）按 dirty collector 定期扫描 → `fireFlushTabletail`（714）→ `FlushTableTailTask`（tables/jobs/flushTableTail.go）投到 Scheduler——memoryNode 数据经 objectio 写盘 → Runner 走软/硬两条 ICKP 调度路径（见核心实现）→ `doIncrementalCheckpoint`（ickp_exec.go:229）写 S3 → GCKP 合并 ICKP → GC：CronJobs 用 `MaxIncrementalCheckpoint().GetEnd()-55s` 调 `LogtailMgr.GCByTS` 截断 logtail、`Catalog.GCByTS` 清内存、DiskCleaner 删 S3 对象并截断 WAL。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Handle.HandleCommit`（rpc/handle.go:485） | CN→TN 提交入口 | 逐 entry 分发 |
| `TxnManager`（txn/txnbase/txnmgr.go:126） | 单 goroutine 状态机队列 | 1PC/2PC 在 `onPrepare1PC/onPrepare2PC` 分叉 |
| `orderedCollectAndPublish`（logtail/mgr.go:147） | 并行收集按序发布 | PrepareTS 全序 |
| `LogtailServer.publishEvent`（service/server.go:575） | 推送订阅 CN | Waterliner 跨 session 单调 |
| `doIncrementalCheckpoint`（ickp_exec.go:229） | 增量 CKP | `IncrementalCheckpointDataFactory` |
| `MemoryNode.ApplyAppendLocked`（tables/mnode.go:243） | 内存追加 | Batch + PK index |
</details>

## 核心实现

### logtail 推送而非 CN 轮询

发布回调织入 commit 流水线（`AddTxnCommitListener(db.LogtailMgr)`，controller.go:650），每事务增量发布。`orderedCollectAndPublish` 用 ants collectPool **并行收集、按 PrepareTS 严格有序发布**，`Waterliner` 保证跨 session 单调——既避免轮询风暴，又维持 CN 一致性序。`collectOneTxn` 对回滚事务的防御：CollectLogtail 后还要检查 `GetTxnState`，状态非 Committed 时返回 nil 不发布（收集与状态变更之间的竞态窗口）。mgr.go:112-122 的注释明确了底线：**collect 失败即 crash**——事务已 apply 到存储但 logtail 未发布会破坏 CN 一致性，宁可进程崩溃，ants 池的 `WithPanicHandler` 因此直接 re-panic。

订阅建立的服务端行为在 `onSubscription`（logtail/service/server.go:282）：`session.Register` 返回 `repeated=true`（同一表重复订阅）时记日志直接 return nil，不重复投递；`subReqChan`（容量 100）满塞不进去时进入循环——`select` 里 `time.After(time.Second)` 每秒打错误日志重试，直到 rootCtx/sendCtx Done 或入队成功（:317-328），不丢弃任何订阅请求。会话对象由 `ssmgr.GetSession` 创建（携带 ResponseSendTimeout、RPCStreamPoisonTime、LogtailCollectInterval 配置）。

### checkpoint 的软硬两条调度路径

ICKP（增量 checkpoint）调度分软硬：**软路径** `softScheduleCheckpoint`（ickp_exec.go:66）需同时满足三类条件——`incrementalPolicy.Check(start)` 时间间隔到位、`ScanInRange` 脏条目数达到 `cfg.MinCount`（ickp_exec.go:119/150）、`IsAllDirtyFlushed`（runner.go:485）确认窗口内全部脏块已刷盘；**硬路径** `force=true` 的 `TryScheduleCheckpoint`（ickp_exec.go:28-31）直接绕过检查强制执行。intent.end 落后于请求 ts 时报错拒绝（防倒退）。

### checkpoint 是 GC 的唯一坐标

logtail、catalog、WAL、S3 对象四类 GC 全部锚定 `MaxIncrementalCheckpoint().GetEnd()`（cronjobs.go:209-216）与 DiskCleaner 对 CKP entry 的判定——单一水位避免各组件各自 GC 造成不一致。这条水位线同时被 Publication 的 sync protection 借用（注册 bloom 保护复制中的对象不被误删，见 [Publication 与 Git for Data](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/10-publication-git4data)）。

### append-only 段 + tombstone

数据对象不可变：appendable object 的 `memoryNode` 满/冻结后 `FreezeAppend` 转 persisted；删除走独立 tombstone 对象（handle.go:449-451 区分 `DataObjectStats/TombstoneStats`），物理回收交给 merge——匹配 S3 不可变对象模型，也让"快照 = 冻结对象集合"零拷贝成立。

### 内存 catalog 与双段恢复

启动时空 catalog，先 `replayFromCheckpoints` 读三表（object list），再 `ReplayWal` 补尾部——恢复量由 checkpoint 周期控制，TN 重启时间可控。catalog entry 带 `CreateAt/DeleteAt` 双 MVCC 时间戳（`GenericSortedDList` 双索引），删除即置 DeleteAt，读侧按快照过滤。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| MVCC version chain | `txnbase/mvccchain.go`、catalog entry 双时间戳 | 快照读零拷贝判断 |
| Task framework | `tasks/` 的 `BaseScheduler`+`Dispatcher`（io/async 双 worker 池） | 后台任务统一调度与观测 |
| 事件驱动 merge | `MergeScheduler.handleMainLoop/handleIOLoop`（db/merge/scheduler.go:726/689）+ 优先级堆 | merge 时机由对象统计驱动（statOverlap/statLayerZero/statVacuum 策略） |
| 命令模式 | `db/controller.go` 的 `controlCmd` 队列 + `stepFuncs` 回滚 | Write/Replay 模式切换可回退 |

## 模块间交互

经 `pkg/txn/storage/tae/storage.go` 适配成 `storage.TxnStorage`（Commit/Prepare/Committing/Rollback）挂上 txn service；WAL 经 `logservicedriver` 连 LogService（`pkg/tnservice/factory.go:218` 的 `WalClientFactory` 注入）；flush/merge/checkpoint 全部产出到 fileservice（`Runtime.Fs/LocalFs`）；CN 侧经 LogtailServer 的 morpc 流消费（两阶段拉取：`pullLogtailsPhase1` 先发 checkpoint 位置，phase2 增量）。

## 扩展方式

- **新增后台任务**：`tasks/types.go` 加 TaskType + Dispatcher → `db/open.go` 注册 → 仿 `tables/jobs/flushTableTail.go` 写 `TaskFactory` → `db/cronjobs.go` 挂触发。
- **新增列存编码**：`containers/`（向量编码）+ objectio 写路径 + `flushTableTail.go` 与 `mergeobjects.go` 读写两端 + `mergesort/merger.go` 泛型 `dataFetcher`。
- **新增 DDL RPC**：`rpc/handle.go` 加 `HandleXxx` → cmd_util EntryType → txnimpl/txn.go 入口 → catalog 新 entry 类型（含 checkpoint 三表 schema 扩展，logtail/ckp_writer.go）。

> 待核实：GCKP 触发 WAL 截断的内部细节（gc/v3）与 transfer table（merge 时 rowid 迁移）协议未逐行核实。
