---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "事务与锁服务"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "分布式事务", "SI", "死锁检测"]
description: "MatrixOne 事务模块解读：HLC 时钟 + Clock-SI、1PC/2PC 混合提交、分片锁表 allocator 与集中式死锁检测。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/txn/`（约 1.9 万行：client / service / rpc / storage / trace）+ `pkg/lockservice/`（约 1.1 万行）承担跨节点正确性：CN 侧 txn client 管理 `TxnOperator` 生命周期，TN 侧 txn service 协调提交（1PC/2PC、时钟排序），`TxnStorage` 接口把 TAE 适配成事务参与者；lockservice 提供分布式悲观锁（分片锁表 + 死锁检测）。它独立于存储与计算的原因：隔离级别与提交协议的正确性证明需要独立演化，且横跨 CN/TN 两端，不能塞进任何一端。

## 模块架构

```go title="pkg/txn 与 pkg/lockservice 核心类型"
type txnClient struct {           // pkg/txn/client/client.go
    clock, sender rpc.TxnSender, generator TxnIDGenerator
    lockService, timestampWaiter, activeTxns [16]activeTxnShard
}
type txnOperator struct {         // pkg/txn/client/operator.go
    sender, clock, lockService, timestampWaiter
    mu{txn txn.TxnMeta, cachedWrites, lockTables []lock.LockTable, callbacks}
    reset{workspace Workspace}
}
type service struct {             // pkg/txn/service/service.go（TN 侧）
    shard metadata.TNShard, storage storage.TxnStorage
    sender rpc.TxnSender, allocator lockservice.LockTableAllocator
    transactions sync.Map   // txnID -> txnContext
}
type lockTableAllocator struct {  // pkg/lockservice/lock_table_allocator.go:41
    services map[string]*serviceBinds
    lockTables map[uint32]map[uint64]pb.LockTable   // {Table→ServiceID, Version}
    ctl sync.Map
}
```

锁表有本地/远程两种实现（`lock_table_local.go` / `lock_table_remote.go`），按 bind 归属选择；`waiterQueue` 是每 LockKey 一条 FIFO（`sliceBasedWaiterQueue`，公平锁）。

## 调用链路

![事务生命周期与锁链](/vibe-reading/images/articles/matrixone-internals/txn-lifecycle.svg)

**事务全生命周期**：frontend session 调 `txnClient.New`（内部 `doCreateTxn→openTxn→determineTxnSnapshot→op.UpdateSnapshot`；`openTxn` 内 maxActiveTxn FIFO 排队）→ disttae workspace 挂到 operator（`AddWorkspace`）→ 写缓存 `maybeCacheWrites` 实现 read-your-write → `Commit`（operator.go:847）调 `workspace.Commit` 打包 payload，追加 `TxnMethod_Commit` 请求经 `rpc/sender.go` 发往 TN → TN `service.Commit`（service_cn_handler.go:171）：先 `allocator.Valid` 校验锁表 bind；单 TNShard 走 1PC fast path（`storage.Commit`），多 shard 并行 `Prepare`，全部成功后 `startAsyncCommitTask` 异步发 `CommitTNShard`，协调者最后自身 commit → CN 收到响应 `closeLocked` → `unlock`（operator.go:1575，RC 下先等 logtail 应用再 `lockService.Unlock`）。Rollback 走 `startAsyncRollbackTask` 重试发 `RollbackTNShard`；TN 侧 `gcZombieTxn` 定期清僵尸。

**悲观锁链**：`service.Lock`（service.go:133）先过**前置校验**（service.go:142/183/188）：CN 滚动重启中返回 `NewNewTxnInCNRollingRestart`、事务已被死锁检测中止返回 `ErrDeadLockDetected`、锁表 bind 已变返回 `ErrLockTableBindChanged`；然后 `applyLockWaitTimeoutCeiling`（service.go:231）把缺失或超限的 `LockWaitTimeout` 钳制到 `MaxLockWaitDuration` 上限（亚秒向上取整、caller 的 `LockWaitDeadline` 更早则取较小者，超限打点 `TxnLockWaitTimeoutCeilingClampedCounter`），并写入 `LockWaitDeadline` 绝对截止时间——锁请求按值传递且本地→远程/转发多跳，绝对 deadline 让整条链共用一个预算。之后 `getLockTableWithCreate`（本地无 bind 则 RPC `Method_GetBind` 向 allocator 申请；`Sharding_ByRow` 用 crc64 将行散列为虚拟表 ID）→ 本地 `localLockTable.lock` 或远程转发 → `doLock→doAcquireLock→handleLockConflictLocked`（lock_table_local.go:572）：FastFail 直接报冲突，否则建 waiter 入 FIFO、`waiterEvents.add` 触发死锁检测 → `detector.check`（deadlock.go:93）沿 `fetchTxnWaitingList`（本地 `fetchWhoWaitingMe` / 远程 `Method_GetWaitingList`）递归构建等待树，成环则 `abortDeadlockTxn` 中止 youngest。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `txnClient.New`（client.go） | 创建事务 | HLC snapshot + FIFO 排队 |
| `txnOperator.Commit`（operator.go:847） | 提交驱动 | workspace 打包 → TN |
| `service.Commit`（service_cn_handler.go:171） | TN 协调 | 1PC/2PC 分叉 + bind 校验 |
| `waitClockTo`（service_cn_handler.go:498） | Clock-SI 读等待 | 等本地物理时钟越过 SnapshotTS |
| `service.Lock`（service.go:133） | 悲观锁入口 | bind 路由本地/远程 |
| `LockTableAllocator.Get/Valid/tryRebindLocked`（lock_table_allocator.go） | 锁表归属管理 | 版本化 bind 迁移 |
| `detector.check`（deadlock.go:93） | 死锁检测 | 4 goroutine + busy 限流 |
</details>

## 核心实现

### SI + HLC 而非中心 TSO

`pkg/txn/clock/hlc.go` 的 `HLCClock` 实现标准 HLC（论文 Figure 5）：`now()`（:223）在 `PhysicalTime >= 新物理时间` 时递增 `LogicalTime`，否则重置物理时间；`update()`（:238）三分支——本地 wall time 最大则保留物理时间重置逻辑时间、物理相等取较大逻辑时间、远端物理更大直接采用远端值。时钟跳变监控：`maxClockForwardOffset = maxOffset/2`，探测间隔 `clockOffsetMonitoringInterval = maxClockForwardOffset/3`（:149-155）；`handleClockJump`（:203）发现跳变量超过 `maxClockForwardOffset + clockOffsetMonitoringInterval` 时 **`logutil.Fatalf` 直接杀死进程**——时钟大幅跳变下 HLC 无法保证正确性，宁可崩溃。读路径 `waitClockTo` 只需等本地物理时钟越过 SnapshotTS 即可读，无集中授时点；commit TS 取 `max(各 shard PreparedTS)`（service_cn_handler.go:335-337）实现提交排序。注意 LogService 的 1 号 shard 仍有 `GetTSOTimestamp` 供全局时钟（TNTimestamp）校准——HLC 为主、TSO 为辅的混合方案。

### Commit 的只读快路径与 unlock 的 RC 等待

`txnOperator.Commit`（operator.go:847）开头先 `CancelAndWaitRunningSQLWithSQL` 等在跑 SQL 结束；`tc.opts.options.ReadOnly()` 时走**快路径**：直接置 `TxnStatus_Committed` 并 `closeLocked` 本地关闭，不产生任何网络请求（operator.go:880-886）。非只读路径依次：分配 `commitSeq` → 触发 CommitEvent → `doWrite` 打包发 TN。`unlock`（operator.go:1575）在 RC 隔离下先 `timestampWaiter.GetTimestamp(ctx, CommitTS)` **等 logtail 应用到 commitTS 之后**再 `lockService.Unlock`——保证悲观锁释放的瞬间，本 CN 的后续 RC 读事务已经能看到已提交数据，避免"锁放了但数据还看不见"的窗口。`needUnlockLocked`（:1625）决定是否需要解锁：乐观模式返回 false，悲观模式要求 `lockService != nil`。

### 1PC/2PC 混合与异步尾提交

单 TNShard 事务直接 `storage.Commit` 一步完成（service_cn_handler.go:263）；多 shard 并行 Prepare 后，"全部 Prepare 成功即向客户端返回已提交"，剩余 shard 的 `CommitTNShard` 异步化——用协调者的本地 commit 兜底正确性，降低尾延迟。

### 锁表分片 + 版本化 bind

锁表按 table（或 row crc64 分桶）散布在 CN，`LockTableAllocator`（挂在 TN，tnservice/store.go:414）维护 `Table→Service` 单一归属；CN 心跳 `KeepLockTableBind` 保活，`checkInvalidBinds` 超时验证后 disable 并 `tryRebindLocked` 迁移——避免单 CN 锁热点，也保证 CN 宕机后锁可迁移。**提交时 `allocator.Valid` 复核 bind**（lock_table_allocator.go:192）：bind 不存在或 `current.Changed(b)` 时返回失效表列表（调用方据此回 `LockTableBindChanged` 重取锁）；serviceID 命中 `inactiveService` 时返回 `CannotCommitOnInvalidCN`。

`ctl sync.Map` 里的 `commitCtl`（:1099）是提交护栏状态机：`beginCommit`（:1111）遇 `cannotCommitState` 返回孤儿态（allocator 返回 `CannotCommitOrphan` 禁止提交），否则置 `committingState` 并递增 `inflight` 计数、分配新 `generation`；`finishCommit` 归零 inflight，`tryCannotCommit` 在 CN 失联时把该 service 的所有事务标记为孤儿——**inflight 计数区分"正在提交"与"已无人认领"，generation 区分同一事务的多次提交尝试**，防止重绑窗口期的旧提交复活。

### 集中式死锁检测 + owner 本地快路径

detector 不与每次 Lock 同步执行（types.go:89-94 注释），由 waiter 入队事件异步触发：`check` 用 `activeCheckTxn` map 去重（同事务在检则跳过），检测队列容量 `maxWaitingCheckCount = 10240`，满时 `select default` 返回 `ErrDeadlockCheckBusy` 降级（本轮不查，等下次事件）；4 个 `doCheck` goroutine 拼等待图，跨 CN 环靠 `Method_GetWaitingList` 远程拼图。发现死锁后对 deadlockTxn 做两件事：`ignoreTxns.Store` 防重复中止 + 调 `waitTxnAbortFunc` 通知外部 abort；被中止事务由 detector 持有至 `txnClosed` 防干扰。另有 `localLockTable.detectOwnerLocalDeadlockLocked`（deadlock_owner_local.go:64）的**owner 本地快路径**：同一把锁的持有者集合内部互相等待形成的环完全可见于 owner CN，同步判定即可，无需走全局异步检测。

### Freshness 可牺牲的一致性换延迟

`WithEnableSacrificingFreshness`（client.go:57-79 注释）用"已收 logtail 时间戳+1"做 snapshot 免等待，再用 `updateLastCommitTS` 保证同 CN 后续事务可见先前提交——同 CN 语义保持，跨 CN 新鲜度可配置降级。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| RPC 消息驱动 | `store_rpc_handler.go:35-47` 按 `TxnMethod` 注册 handler | 协议全异步，天然支持重试/超时 |
| Allocator 分片 | `createBindLocked/tryRebindLocked` + `Version++` 与 `oldBind.Changed(newBind)` 检测 | 单写者分配，迁移可检测 |
| Waiter queue | `sliceBasedWaiterQueue` + `beginChange/commitChange`（range lock 合并 `mergeContext`） | 公平锁 + 对象池化（`common/reuse`） |
| Functional options | `TxnClientCreateOption/TxnOption` 贯穿 client 与 operator | session 级参数（lock wait timeout 等）透传 |

## 模块间交互

frontend session 持 `pu.TxnClient`（frontend/session.go:713），经 `WithTxnCreateBy/WithTxnLockWaitTimeout` 传会话参数；disttae workspace 实现 `client.Workspace`（operator.go:1136-1158 回调 Commit/Rollback/FinalizeCommit）；TAE 经 `storage.TxnStorage`（pkg/txn/storage/tae/）承接 Prepare/Commit/Rollback；allocator 的可达性依赖 TN 心跳上报 `LockServiceAddress`（store_heartbeat.go:71），lockservice/rpc.go:167+ 据此路由；CN 重启用 `uuid+时间戳` 作 serviceID 防心跳混淆。

## 扩展方式

- **新增隔离级别**：`pkg/pb/txn` 的 `TxnIsolation` 枚举 → `txnClient.getTxnIsolation`（client.go:524）默认值与 `WithTxnIsolation` → 读可见性在 `service.Read` 与 operator `unlock` 的 RC logtail 等待（operator.go:1583）。
- **新增锁模式**（如意向锁）：`pkg/pb/lock` 的 `LockMode` + `LockOptions` → `localLockTable.acquireRowLockLocked/hasConflictWithLock`（lock_table_local.go:463/1028）冲突矩阵 + `Lock.value` 位编码（types.go:268）。
- **调整锁表迁移策略**：`lock_table_allocator.go` 的 `tryRebindLocked/checkInvalidBinds` + CN 侧 `handleBindChanged→fenceByBindChanged` fencing。

> 待核实：多 TN 部署下 allocator 一致性依赖 hakeeper 元数据收敛（GetBind 请求发往 `GetAllTNServices()[0]`，rpc.go:217），未深查选主路径。
