---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "LogService 与 HAKeeper"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "Raft", "WAL", "集群调度"]
description: "MatrixOne LogService 模块解读：dragonboat multi-raft 共享 WAL、HAKeeper 0 号 shard 心跳黑盒调度与 raft snapshot 截断 GC。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/logservice/`（约 8.6k 行非测试 Go）+ `pkg/hakeeper/`（约 5.8k 行）是 MatrixOne 全部持久状态的底座：LogService 为每个 TN shard 提供共享 WAL（multi-raft 复制），HAKeeper 作为 0 号 shard 内嵌其中，承载集群元数据与调度（CN/TN/Log 副本分配、锁表 allocator 可达性、TSO、ID 分配）。它独立的原因很直接：**复制与调度是所有其他组件正确性的前提**，必须与业务引擎完全解耦，且自身要极简——复杂度全部外包给成熟的多 raft 库。

先纠一个常见误解：logservice **不直接依赖 etcd raft**。`go.mod` 中无任何 etcd 依赖；raft 能力来自 `github.com/lni/dragonboat/v4`，并 replace 到 matrixorigin 的 fork（go.mod:268）。dragonboat 是 multi-raft 库（其内嵌 raft 状态机与 etcd/raft 的渊源在 fork 内部，本仓库无 etcd import，待核实于 dragonboat 源码）。

## 模块架构

```go title="pkg/logservice/store.go:132"
type store struct {
    nh                *dragonboat.NodeHost   // 多 shard 共用一个 NodeHost
    haKeeperReplicaID uint64                 // 本节点上的 HAKeeper 副本
    checker           hakeeper.Checker       // checkers.Coordinator
    alloc             hakeeper.IDAllocator   // ID 批量分配
    taskScheduler     hakeeper.TaskScheduler
    snapshotMgr       *snapshotManager
    onReplicaChanged  func(shardID, replicaID uint64, typ ChangeType)  // 通知 datasync
}
```

`Service`（service.go:67）是 morpc RPC 层；TN 侧消费的 `Client` 接口（client.go:54）提供 `Append/Read/Truncate/GetTSOTimestamp` 等日志 API。Log shard 的状态机是 `pkg/logservice/rsm.go:91` 的 `stateMachine`（实现 dragonboat `sm.IStateMachine`），HAKeeper shard 用 `pkg/hakeeper/rsm.go:66` 的独立 stateMachine。关键常量：`DefaultHAKeeperShardID = 0`（hakeeper/rsm.go:57）、`firstLogShardID = 1`（logservice/rsm.go:32，TSO 所在 shard）；`NewStateMachine` 中 shardID≠0 直接 panic（hakeeper/rsm.go:364）——一个 raft 组承载全集群元数据。

## 调用链路

![LogService 架构](/vibe-reading/images/articles/matrixone-internals/logservice-arch.svg)

**TN 写 WAL 链**：tae logstore driver（`pkg/vm/engine/tae/logstore/driver/logservicedriver/driver.go:73`）→ `pkg/tnservice/factory.go:103` `newLogServiceClient` → `managedClient.Append`（client.go:220，失败 `resetClient` 重连）→ morpc → `Service.handleAppend`（service.go:445）→ `store.append`（store.go:744）→ `l.nh.SyncPropose`（store.go:679 `propose`，ErrShardNotReady 重试）→ raft 复制 → `stateMachine.handleUserUpdate`（rsm.go:154）校验 leaseholder 并返回 Lsn。写入前 TN 先 `handleConnect` → `store.getOrExtendTNLease`（store.go:720）拿 shard 租约。`Service.onAppend` 同时把 payload 副发给 `dataSync.Append`（datasync，跨集群 CDC）。

**HAKeeper 调度链**：各服务心跳（`tnservice/store_heartbeat.go:61` `SendTNHeartbeat` 等）→ propose 进 HAKeeper RSM → `store.ticker`（store.go:1187）双频驱动：`hakeeperTick`（1239，推逻辑时钟）+ `hakeeperCheck`（store_hakeeper_check.go:156）→ `healthCheck` → `checker.Check`（checkers.Coordinator，pkg/hakeeper/checkers/coordinator.go:56）→ `syshealth.Check` 系统级熔断 → Log/TN/CN/Proxy 四个 ModuleChecker → `OperatorController.Dispatch` → `addScheduleCommands`（store.go:868）写回 RSM → 各服务在**下一次心跳响应**中收到 `CommandBatch` 并 `handleCommands`（tnservice/store_heartbeat.go:81，处理 AddReplica/RemoveReplica/ShutdownStore/CreateTaskService）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `store.append/propose`（store.go:744/679） | WAL 提交 | SyncPropose + 租约校验 |
| `store.ticker`（store.go:1187） | 双频驱动 | tick 推逻辑时钟 + check 调度 |
| `checkers.Coordinator.Check`（coordinator.go:56） | 集群健康检查 | 单线程假设（coordinator.go:33 注释），无锁 |
| `addScheduleCommands`（store.go:868) | 命令落盘 RSM | 宕机重启不丢调度决议 |
| `store.truncateLog`（store.go:728） | 截断 WAL | 经 raft propose 保证各副本一致 |
| `store.tsoUpdate`（store.go:771） | TSO 推进 | 对 1 号 shard propose |
</details>

## 核心实现

### 共享多租户 WAL 而非 per-tablet raft

一个 TN shard 对应一个 Log shard（`metadata.TNShard.LogShardID`）。为什么不分数据分区切 raft 组：HTAP 的 checkpoint 已把数据落到 S3，WAL 只需短期保留（required lsn 之前可删、之后读 S3，client.go:98 注释），无需为持久性维护成千上万 raft 组的成员管理开销。

租约与截断的容错语义值得注意：`handleUserUpdate`（rsm.go:154）在 LeaseHolderID 非零且与命令携带的不一致时，返回 `Result{Value: 当前 leaseholder ID}` 表示拒绝——`store.append`（store.go:744）检测到 `result.Data` 非空即返回 `NotLeaseHolder`；成功路径的 Lsn 来自 `Result{Value: s.state.Index}`，**`result.Value == 0` 直接 panic**（apply 时还没分配 index 的 bug 信号）。`store.truncateLog`（store.go:728）用 NoOP session propose `getSetTruncatedLsnCmd`；`handleTruncateLsn`（rsm.go:141）仅在 `lsn > TruncatedLsn` 时前进并同时 `truncateLeaseHistory`，否则返回当前 TruncatedLsn——store 层据此报 `moerr.NewInvalidTruncateLsn`（store.go:739），**截断只能前进**是各副本一致性的底线。

### truncationWorker 与 escape valve

`truncationWorker`（truncation.go:98）的两个 ticker 分别驱动 `processTruncateLog`（TruncateInterval）与 `processHAKeeperTruncation`（HAKeeperTruncateInterval）——前者**跳过 HAKeeper shard**（0 号 shard 的日志由后者单独处理，节奏不同）。`processShardTruncateLogWithReplica`（truncation.go:431）对 `getTruncatedLsn` 设 3 秒超时；超时且导出快照 quota 已满（`snapshotMgr.Count >= MaxExportedSnapshot`）时走 **`dropNewestOnTimeout`（truncation.go:390，issue #24315）**——丢弃最新快照腾出 quota，防止一个卡死的 quiescent shard 把截断循环永久楔死（WAL 会一直增长直到 SyncRead 恢复）。

### HAKeeper 与 LogService 同进程

HAKeeper 就是 LogService 节点上的 0 号 shard（`startHAKeeperReplica`，store.go:444），复用同一 NodeHost/网络/WAL 栈，不引入独立组件。CN/TN/Log 全部以客户端身份心跳进来，HAKeeper 是"黑盒"——输入纯 `pb.CheckerState`，不见各服务内部状态。

### Truncate/GC 走 raft snapshot

`processShardTruncateLog` → `nh.SyncRequestSnapshot(CompactionIndex: lsn-1)`（truncation.go:527），截断点经 raft propose（store.go:728）保证各副本一致；另有 zombie replica 清理（`checkZombieReplicas`，store.go:297）。

### 命令经 RSM 落盘 + 心跳拉取

`addScheduleCommands` 把调度命令写进 HAKeeper 状态机再由心跳响应携带下发，命令不主动推送。好处是宕机重启不丢调度决议；代价是命令延迟最多一个心跳周期。

`Coordinator.Check`（coordinator.go:56）的两条路径：先 `OperatorController.RemoveFinishedOperator` 清理已完成的算子；**teardown 路径**——`syshealth.Check` 判定系统不健康时置 `c.teardown = true` 并只 dispatch teardownOps，此后每次 Check 直接走 teardown 分支**不再运行各模块 checker**（集群已被判死，只发停机命令）；**keep-alive 路径**——健康时依次跑 Log/TN/CN/Proxy 四个 ModuleChecker 做副本维持与均衡。判活不用真实时间：`hakeeperTick` 推逻辑 tick，`cfg.LogStoreExpired(start, current)`（hakeeper/config.go:65）按 tick 差判死。

`logServiceChecker.Check`（checkers/logservice/check.go:458）串行运行七类 operatorChecker：`checkToBootstrap / checkToAdd / checkToRemove / checkToStart / checkZombie / checkTaskService / checkAddShard`。`checkToAdd`（check.go:192）在 `toAdd[shardID] == numOfLogReplicas`（要补的副本数等于配置副本数，即 shard 尚未 bootstrap）时跳过——该场景归 `checkToBootstrap` 管；生成多个算子时对 working 副本深拷贝并 `delete(working, bestStore)`（check.go:260），避免同一轮重复选中同一 store。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Sharded multi-raft | 单 NodeHost 管全部 shard（store.go:70/485） | 复用一套网络与 WAL 栈 |
| 策略模式 checker 组合 | `logServiceChecker.Check`（checkers/logservice/check.go:458）串七类 operatorChecker | 调度策略可组合扩展 |
| 黑盒心跳 + 逻辑 tick | store.go:1239 + config.go:65 | 不依赖各服务内部状态与时钟 |
| 薄 RSM | logservice/rsm.go 仅 239 行 | 复杂度压进 dragonboat |

## 模块间交互

tae logstore 经 `LogServiceDriver`/`WalClientFactory` 注入（Truncate 反向驱动 tae GC checkpoint）；TSO 供 txn 的 TNTimestamp 校准；lockservice allocator 不直接调 HAKeeper——可达性依赖 TN 心跳上报 `LockServiceAddress`，绑活性靠 KeepBindDuration 超时重绑；ID 分配走 `AllocateIDByKey`（hakeeper_client.go:431）批量领号（defaultIDBatchSize=10240）；datasync 消费 `Service.onAppend` 的副本流量做跨集群同步。

## 扩展方式

- **新增一种心跳**（如 proxy 心跳模式）：`pkg/pb/logservice` 加消息 → `hakeeper/rsm.go` 加 parse/Update 分支 → `hakeeper_client.go` 加接口方法 → `service.go` 路由 + `store.go` addXxxHeartbeat → 新建 `pkg/hakeeper/checkers/xxx/` 实现 ModuleChecker 并注册进 coordinator → 服务侧仿 `store_heartbeat.go` 的 heartbeatTask/handleCommands。
- **调整 Log 副本调度策略**（如 locality 感知）：改 `checkers/logservice/check.go:192` 的 `checkToAdd.check()` 选目标处与 `parse.go` 的 `parseLogShards`，必要时加 `filter.go` 约束。
- **调整 WAL GC/truncate 策略**：改 `truncation.go` 的 `shouldDoExport/shouldDoImport`（:280/:340）与 `processTruncateLog`（:130），注意保持 dragonboat `SyncRequestSnapshot` 的 CompactionIndex 语义。

> 待核实：dragonboat fork 内嵌 raft 与 etcd/raft 的渊源；standby TN 的 master 选举路径（store_heartbeat.go:72 注释称 master TN，未在本模块内确认）。
