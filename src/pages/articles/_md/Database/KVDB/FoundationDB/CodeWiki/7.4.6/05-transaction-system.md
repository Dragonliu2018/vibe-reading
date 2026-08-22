---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "事务系统"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "7.4.6"]
tags: ["FoundationDB", "C++", "CommitProxy", "Resolver", "ConflictSet", "OCC", "Sequencer"]
description: "事务系统——CommitProxy 批量提交 + GRVProxy 授予读版本 + Resolver OCC 冲突检测 + Sequencer 单点版本分配，FDB ACID 严格可串行化的引擎。"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/7.4.6/00-overview)

---

## 模块定位

`CommitProxyServer.actor.cpp` + `GrvProxyServer.actor.cpp` + `Resolver.actor.cpp` + `masterserver.actor.cpp` + `SkipList.cpp` 是 FDB ACID 的引擎。Sequencer（master）单点分配全局单调递增 commit version；GRVProxy 向客户端授予读版本；CommitProxy 批量接收提交、分配 version、写 TLog；Resolver 用 OCC 检测写写冲突。四者协作完成一次提交，是 FDB 严格可串行化的关键。

## 模块架构

- **MasterData**（`fdbserver/include/fdbserver/MasterData.actor.h:89`）——Sequencer 状态：`version`（最后分配 commit version）、`liveCommittedVersion`（`NotifiedVersionValue`，proxy 报告的最大已提交版本）、`lastEpochEnd`/`recoveryTransactionVersion`、`lastCommitProxyVersionReplies`（per-proxy 去重+排序）、`ResolutionBalancer`、`ssVersionVector`。入口 `masterServer()` 启动 `provideVersions`/`serveLiveCommittedVersionCxx`/`updateRecoveryDataCxx`。
- **ProxyCommitData**（`fdbserver/include/fdbserver/ProxyCommitData.actor.h:199`）——CommitProxy 状态：`master`、`resolvers`、`logSystem`、`txnStateStore`（每 proxy 独立副本）、`committedVersion`/`version`、`keyResolvers`、`keyInfo`（key→storage server tags）、`commitVersionRequestNumber`、`latestLocalCommitBatchResolving/Logging`、`rangeLock`。
- **CommitBatchContext**（`fdbserver/CommitProxyServer.actor.cpp:628`）——单个提交批次：`trs`、`LogPushData toCommit`、`commitVersion`/`prevVersion`、`resolution`、`committed[]`、`stage`（UNSET→INITIALIZE→PRE_RESOLUTION→RESOLUTION→POST_RESOLUTION→TRANSACTION_LOGGING→REPLY→COMPLETE）、`tpcvMap`（version vector）。
- **Resolver**（`fdbserver/Resolver.actor.cpp:125`）——冲突检测器：`version`、`neededVersion`、`recentStateTransactionsInfo`、`proxyInfoMap`、`ConflictSet*`、`txnStateStore`（`PROXY_USE_RESOLVER_PRIVATE_MUTATIONS` 时）。
- **ConflictSet / ConflictBatch / SkipList**（`fdbserver/include/fdbserver/ConflictSet.h:31` 接口 + `fdbserver/SkipList.cpp` 实现）——SkipList（`SkipList.cpp:222`）存所有已提交 write conflict range + per-node max version；`ConflictBatch`（`SkipList.cpp:831`）批量检测。
- **GrvProxyData**（`fdbserver/GrvProxyServer.actor.cpp:187`）——GRVProxy 状态：`master`、`version`/`minKnownCommittedVersion`、`ssVersionVectorCache`、`lastCommitTime`、`tagThrottler`。

## 调用链路

完整 commit 流程（5 阶段流水线）：

```text
Client CommitTransactionRequest → CommitProxy.commit (stream)
  └→ commitBatcher()  [CommitProxyServer.actor.cpp:377]  按字节数/数量/超时聚合成 batch
    └→ commitBatch 5 阶段:
      1. preresolutionProcessing()  [:943]
         ├→ 等 latestLocalCommitBatchResolving（batch 顺序）
         ├→ master.getCommitVersion → getVersionCxx()  [masterserver.actor.cpp:133] → figureVersion() [:52]
         └→ 更新 keyResolvers（resolver 负载均衡变更）
      2. getResolution()  [:1096]
         ├→ ResolutionRequestBuilder  [:108]  addTransaction() [:203] 拆分 read/write conflict ranges
         └→ resolver.resolve → resolveBatch()  [Resolver.actor.cpp:247]
             ├→ versionReady() 等 version>=prevVersion  [:222]
             ├→ ConflictBatch.addTransaction()  [SkipList.cpp:831]
             └→ detectConflicts()  [SkipList.cpp:934]
                 ├→ checkIntraBatchConflicts()  [:899]
                 ├→ combineWriteConflictRanges()  [:1021]
                 ├→ checkReadConflictRanges()  [:983]
                 └→ mergeWriteConflictRanges()  [:1014]
      3. postResolution()  [:2304]
         ├→ applyMetadataEffect()  [:1608]  应用其他 proxy 的 stateMutations
         ├→ determineCommittedTransactions()  [:1695]  合并各 resolver 结果
         ├→ applyMetadataToCommittedTransactions()  [:1740]
         ├→ assignMutationsToStorageServers()  [:2070]  分配 tag 写 toCommit
         └→ logSystem->push() 推送到 TLog
      4. transactionLogging()  [:2595]  等 TLog 持久化
      5. reply()  [:2637]
         ├→ master.reportLiveCommittedVersion（先报告 Master 再更新本地 committedVersion，保证 invariant）
         └→ 回复客户端 Committed/Conflict/TooOld
```

GRV 流程：`grvProxyServerCore()`（`:1097`）→ `queueGetReadVersionRequests()`（`:497`）按优先级入 system/default/batch 队列 → `transactionStarter()`（`:849`）`GRVTimer` 触发按优先级+限速选取 → `getLiveCommittedVersion()`（`:642`）调 `master.getLiveCommittedVersion` + `logSystem->confirmEpochLive` → `sendGrvReplies()`（`:719`）。`getRate()`（`:389`）周期从 RateKeeper 获取 `transactionRate`/`batchTransactionRate`，`GrvTransactionRateInfo`（`GrvTransactionRateInfo.actor.cpp:36`）用 Smoother 平滑 rate + budget 允许小批量超发。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `getVersionCxx` | `masterserver.actor.cpp:133` | 按 requestNum 顺序分配 version |
| `figureVersion` | `masterserver.actor.cpp:52` | wall-clock 对齐 + clamp |
| `serveLiveCommittedVersionCxx` | `masterserver.actor.cpp:393` | 返回 liveCommittedVersion |
| `commitBatcher` | `CommitProxyServer.actor.cpp:377` | 批收集提交请求 |
| `preresolutionProcessing` | `:943` | 请求 commit version |
| `getResolution` | `:1096` | 发给 resolver 检测冲突 |
| `postResolution` | `:2304` | 分配 tag + push TLog |
| `determineCommittedTransactions` | `:1695` | 合并 resolver 结果 |
| `assignMutationsToStorageServers` | `:2070` | 分配 tag 写 toCommit |
| `reply` | `:2637` | 回复客户端 + 报告 Master |
| `resolveBatch` | `Resolver.actor.cpp:247` | 冲突检测主逻辑 |
| `detectConflicts` | `SkipList.cpp:934` | SkipList + MiniConflictSet 检测 |
| `queueGetReadVersionRequests` | `GrvProxyServer.actor.cpp:497` | GRV 优先级入队 |
| `getLiveCommittedVersion` | `GrvProxyServer.actor.cpp:642` | 向 master + confirmEpochLive |
| `resolutionBalancing_impl` | `ResolutionBalancer.actor.cpp:115` | resolver 间迁移 key range |
</details>

## 核心实现

### CommitProxy 水平扩展（无共享）

每 proxy 维护自己的 `txnStateStore` 副本（内存 `KeyValueStoreMemory`，经 `LogSystemDiskQueueAdapter` 与 TLog 交互），独立处理客户端提交，无需与其他 proxy 通信。commit version 由 master 统一分配，proxy 间不争抢；`determineCommittedTransactions()`（`:1695`）合并各 resolver 的 committed 结果；per-proxy `latestLocalCommitBatchResolving`/`Logging` 保证本 proxy 内 batch 顺序。**txnStateStore 一致性**：所有 commit proxy 内存中维护相同副本，metadata mutations 经 resolver 中转（`Resolver.actor.cpp:373` 收集 `recentStateTransactions`，在 `ResolveTransactionBatchReply.stateMutations` 返回给 proxy 含其他 proxy 的 state mutations），每 proxy 只将自己 batch 的 metadata mutations 写入 TLog（避免重复）——状态机复制：相同初始状态 + 相同操作序列 = 一致结果。

### OCC 冲突检测（非 2PL）

`ConflictBatch::detectConflicts()`（`SkipList.cpp:934`）用乐观并发控制：流程 `addTransaction` → `checkIntraBatchConflicts` → `combineWriteConflictRanges` → `mergeWriteConflictRanges` → `checkReadConflictRanges`。SkipList 是无锁并发结构，`detectConflicts`（`SkipList.cpp:443`）批量检测不持锁。客户端声明 read/write conflict range，resolver 只检测 write-write 冲突（read range 内是否有更高 version 的 write），比 2PL 轻量。`checkIntraBatchConflicts`（`:899`）快速检测同 batch 内冲突，避免逐事务查 SkipList。冲突的事务标 `TransactionConflict`，客户端重试——2PL 需死锁检测和锁管理，分布式代价更高，而 FDB 面向短事务低冲突场景，OCC 无锁特性在高吞吐下优于 2PL。`newOldestVersion = req.version - MAX_WRITE_TRANSACTION_LIFE_VERSIONS`（`Resolver.actor.cpp:339`）清理过期 read version。

### Master 单点分配 Version

`getVersionCxx()`（`masterserver.actor.cpp:133`）按 `requestNum` 顺序分配 version——全局唯一 master 分配单调递增 version，完全避免时钟同步问题，保证 strict serializability。`figureVersion()`（`:52`）让 version 粗略跟随 wall-clock（`now * VERSIONS_PER_SECOND`），用 `std::clamp` 限制漂移（`MAX_VERSION_RATE_MODIFIER`/`OFFSET`）；`commitVersionRequestNumber` 保证每 proxy 请求按序处理避免乱序。`prevVersion` 随 `GetCommitVersionReply` 返回，resolver 经 `versionReady()`（`:222`）等 `version >= prevVersion` 保证所有 version < prevVersion 的事务先被解决。单点风险靠 recovery 缓解——Master 崩溃时 CC 触发新 generation recovery 从 `lastEpochEnd` 恢复。

### Batching

`commitBatcher()`（`:377`）按字节数/数量/超时聚合成 batch——一次 `GetCommitVersionRequest` 为整批事务获取一个 commit version，多个事务的 mutation 合并到一次 `logSystem->push()`，一次 `ResolveTransactionBatchRequest` 含多事务。batch interval 动态调整：延迟高时缩短 interval 降延迟，延迟低时增大提吞吐（`reply()` `:2824`）。内存超限拒绝（`commit_proxy_memory_limit_exceeded`）。`commitBatchByteLimit` 基于 proxy 数量幂函数缩放（`:4086`）。

### 先报告 Master 再更新 committedVersion

`reply()`（`:2675`）先向 Master 发 `ReportRawCommittedVersionRequest` 再更新本地 `committedVersion`——保证 invariant `master.committedVersion >= self.committedVersion`。若先更新本地，GRV proxy 可能在 Master 尚未知晓时从本地返回该 version，导致下一个 GRV 得到比 Master 更小的 version。

### Resolver 负载均衡

`ResolutionBalancer`（`ResolutionBalancer.actor.cpp`）`resolutionBalancing_impl()`（`:115`）周期查询各 resolver 的 `ResolutionMetricsReply`，若最大/最小负载差 > `MIN_BALANCE_DIFFERENCE` 调 `findRange()`（`:48`）找迁移范围经 `ResolutionSplitRequest` 切分，变更经 `GetCommitVersionReply.resolverChanges` 传给 commit proxy（`setChangesInReply()` `:36`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Commit Batching | `CommitProxyServer.actor.cpp:377` | 摊薄 Master/resolver/TLog RPC，interval 动态调整 |
| OCC 冲突检测 | `SkipList.cpp:934` | 无锁，适合短事务高吞吐 |
| Version 单点分配 | `masterserver.actor.cpp:133` | 全局唯一单调递增，避时钟同步 |
| Proxy 水平分流 | `CommitProxyServer.actor.cpp:3967` | 每 proxy 独立 txnStateStore，无共享状态 |
| RateKeeper 限速 | `GrvProxyServer.actor.cpp:389` + `GrvTransactionRateInfo.actor.cpp:36` | Smoother 平滑 rate + budget 累积，三优先级独立 |
| Resolver 负载均衡 | `ResolutionBalancer.actor.cpp:115` | 定期迁移 key range 分担冲突检测 |

## 模块间交互

CommitProxy 依赖：Master（`getCommitVersion`）、Resolver（`resolve`）、LogSystem/TLog（`push`）、txnStateStore。GRVProxy 依赖：Master（`getLiveCommittedVersion`）、LogSystem（`confirmEpochLive`）、RateKeeper（`getRate`）。Resolver 依赖：ConflictSet/SkipList、可选 txnStateStore（`PROXY_USE_RESOLVER_PRIVATE_MUTATIONS`，`Resolver.actor.cpp:749`）。Master 无依赖（单点，经 ServerDBInfo 获知 proxy/resolver）。被 ClusterController 招募经 ServerDBInfo 广播。客户端经 loadBalance 选 commit/grv proxy。

## 扩展方式

调整 commit batch：改 `ServerKnobs` 的 `COMMIT_TRANSACTION_BATCH_BYTES_MAX/MIN`/`COMMIT_TRANSACTION_BATCH_INTERVAL_MIN/MAX`（注意不能让 batch 处理时间超 `MAX_READ_TRANSACTION_LIFE_VERSIONS / VERSIONS_PER_SECOND`）。新增冲突检测策略：改 `SkipList.cpp:831` `addTransaction`（range 对齐粒度）与 `ResolutionRequestBuilder`（`CommitProxyServer.actor.cpp:108`）的 `addReadConflictRanges`/`addWriteConflictRanges`。增加 resolver：`ResolutionBalancer.actor.cpp:115` 已有自动均衡，`findRange()`（`:48`）找边界；resolver 间需 `stateMutations` 同步。调整 version 速率：改 `figureVersion()`（`masterserver.actor.cpp:52`）的 `VERSIONS_PER_SECOND`/`MAX_VERSION_RATE_MODIFIER`。
