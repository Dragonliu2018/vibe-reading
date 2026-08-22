---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "事务系统"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "main-2026-08"]
tags: ["FoundationDB", "C++", "CommitProxy", "Resolver", "ConflictSet", "OCC", "Sequencer"]
description: "事务系统——CommitProxy 批量提交 + GRVProxy 授予读版本 + Resolver OCC 冲突检测 + Sequencer 单点版本分配，FDB ACID 严格可串行化的引擎。"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`commitproxy/` + `grvproxy/` + `resolver/` + `sequencer/`（合计 ~10k 行但逻辑密集）是 FDB ACID 的引擎。Sequencer（master）单点分配全局单调递增 commit version；GRVProxy 向客户端授予读版本；CommitProxy 批量接收提交、分配 version、写 TLog；Resolver 用 OCC 检测写写冲突。四者协作完成一次提交，是 FDB 严格可串行化的关键。详见概览「事务提交数据流」图。

## 模块架构

- **MasterData / MasterInterface**（`sequencer/MasterData.h:50` / `core/MasterInterface.h:47`）——Sequencer 状态与接口：`version`（最后分配 commit version）、`liveCommittedVersion`（`NotifiedVersionValue`，commit proxy 报告的最大已提交版本）、`lastEpochEnd`/`recoveryTransactionVersion`、`lastCommitProxyVersionReplies`（per-proxy 去重+排序）、`ResolutionBalancer`、`ssVersionVector`。入口 `masterServer()`（`masterserver.cpp:369`）启动 `provideVersions`/`serveLiveCommittedVersion`/`updateRecoveryData`。
- **ProxyCommitData**（`commitproxy/ProxyCommitData.h:227`）——CommitProxy 状态：`master`、`resolvers`、`logSystem`、`txnStateStore`（每 proxy 独立副本）、`committedVersion`/`version`、`keyResolvers`（key→resolver 映射）、`keyInfo`（key→storage server tags）、`commitVersionRequestNumber`、`latestLocalCommitBatchResolving/Logging`、`rangeLock`。
- **CommitBatchContext**（`CommitProxyServer.cpp:500`）——单个提交批次：`trs`（事务列表）、`LogPushData toCommit`、`commitVersion`/`prevVersion`、`resolution`（各 resolver 回复）、`committed[]`（每事务状态）、`stage`（UNSET→INITIALIZE→PRE_RESOLUTION→RESOLUTION→POST_RESOLUTION→TRANSACTION_LOGGING→REPLY→COMPLETE）。
- **Resolver**（`Resolver.cpp:129`）——冲突检测器：`version`（当前已解决版本）、`neededVersion`、`recentStateTransactionsInfo`（跨 proxy state txn 历史）、`proxyInfoMap`（per-proxy 追踪）、`ConflictSet*`、`txnStateStore`（可选）。
- **ConflictSet**（`ConflictSet.cpp:753`）——26 级 SkipList 存所有已提交 write conflict range + per-node max version，`CheckMax`（`:629`）状态机检测 read range 是否与已有 write range 版本冲突。
- **GrvProxyData**（`GrvProxyServer.cpp:187`）——GRVProxy 状态：`master`、`version`/`minKnownCommittedVersion`、`ssVersionVectorCache`、`lastCommitTime`。

## 调用链路

完整提交流程（Commit + GRV）见概览数据流图，此处展开关键方法：

```text
Client tryCommit() → CommitProxyServer.commit (stream)
  └→ commitBatcher()  [CommitProxyServer.cpp:234]  按 count/bytes/time/firstInBatch 批收集
    └→ serveBatchedCommits() → commitBatch()  [~1570]
      ├→ preresolutionProcessing()  [:826]
      │   ├→ 等 latestLocalCommitBatchResolving（本 proxy batch 排序）
      │   ├→ master.getCommitVersion → getVersion()  [masterserver.cpp:74]
      │   │   └→ figureVersion() 分配 commitVersion + prevVersion
      │   └→ 更新 keyResolvers 映射（如有 resolver 重分配）
      ├→ getResolution()  [:934]
      │   ├→ ResolutionRequestBuilder 拆分事务到 per-resolver 请求
      │   └→ resolver.resolve.getReply() → resolveBatch()  [Resolver.cpp:263]
      │       ├→ versionReady() 等 version>=prevVersion  [:226]
      │       ├→ ConflictBatch.addTransaction() per txn  [ConflictSet.cpp:799]
      │       ├→ detectConflicts()  [ConflictSet.cpp:948]
      │       │   ├→ sortPoints() 基数排序
      │       │   ├→ checkReadConflictRanges() → SkipList.detectConflicts()
      │       │   ├→ checkIntraBatchConflicts() → MiniConflictSet bitmap
      │       │   ├→ combineWriteConflictRanges()
      │       │   └→ removeBefore() 清理旧版本
      │       └→ self->version.set(req.version)
      ├→ determineCommittedTransactions()  [:1144]  合并各 resolver 结果（min()）
      ├→ applyMetadataToCommittedTransactions()  [:1197]
      ├→ assignMutationsToStorageServers()  [:1384]  分配 tag，写 toCommit
      ├→ logSystem->push(toCommit)  [:1832]
      ├→ transactionLogging() 等 TLog 持久化  [:1881]
      └→ reply()  [:1921]
          ├→ master.reportLiveCommittedVersion → updateLiveCommittedVersion()  [:225]
          └→ 回复客户端 Committed/Conflict/TooOld
```

GRV 流程：`getConsistentReadVersion()` → `queueGetReadVersionRequests()`（`GrvProxyServer.cpp:537`）按 priority 入 systemQueue/defaultQueue/batchQueue → `transactionStarter()`（`:936`）`GRVTimer` 触发按优先级+限速选取 → `getLiveCommittedVersion()`（`:694`）调 `master.getLiveCommittedVersion` + `logSystem->confirmEpochLive` → `sendGrvReplies()`（`:779`）分发 version。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `masterServer` | `masterserver.cpp:369` | Sequencer 入口，启 3 子 actor |
| `getVersion` | `masterserver.cpp:74` | 按 requestNum 顺序分配 version |
| `figureVersion` | `masterserver.cpp:43` | wall-clock 对齐 + clamp |
| `serveLiveCommittedVersion` | `masterserver.cpp:252` | 返回 liveCommittedVersion |
| `commitBatcher` | `CommitProxyServer.cpp:234` | 批收集提交请求 |
| `preresolutionProcessing` | `:826` | 请求 commit version |
| `getResolution` | `:934` | 发给 resolver 检测冲突 |
| `determineCommittedTransactions` | `:1144` | min() 合并各 resolver 结果 |
| `resolveBatch` | `Resolver.cpp:263` | 冲突检测主逻辑 |
| `detectConflicts` | `ConflictSet.cpp:948` | SkipList + MiniConflictSet 检测 |
| `queueGetReadVersionRequests` | `GrvProxyServer.cpp:537` | GRV 优先级入队 |
| `getLiveCommittedVersion` | `GrvProxyServer.cpp:694` | 向 master + confirmEpochLive |
</details>

## 核心实现

### CommitProxy 水平扩展（无共享）

每 proxy 维护自己的 `txnStateStore` 副本（通过 `LogSystemDiskQueueAdapter` 从 TLog 恢复，`CommitProxyServer.cpp:3193`），独立处理客户端提交，无需与其他 proxy 通信。commit version 由 master 统一分配，proxy 间不争抢；resolver 结果可合并——`determineCommittedTransactions()` 用 `min()` 合并各 resolver 的 committed 状态（`:1144-1158`），天然支持多 resolver；per-proxy `latestLocalCommitBatchResolving`/`Logging` 保证本 proxy 内 batch 顺序。resolver 跨 proxy 状态同步经 `RecentStateTransactionsInfo` 和 `proxyInfoMap`（`Resolver.cpp:62`），追踪每 proxy 的 `lastVersion`，在回复中附带其他 proxy 的 state mutations。

### OCC 冲突检测（非 2PL）

`ConflictBatch::detectConflicts()`（`ConflictSet.cpp:948`）用乐观并发控制：SkipList 是无锁并发结构，`detectConflicts()` 用 `CheckMax` 状态机批量检测，不持锁。客户端声明 read/write conflict range，resolver 只检测 write-write 冲突（read range 内是否有更高 version 的 write），比 2PL 轻量。`checkIntraBatchConflicts()` 用 `MiniConflictSet`（bitmap）快速检测同 batch 内冲突，避免逐事务查 SkipList。冲突的事务标 `TransactionConflict`，客户端重试即可——2PL 需死锁检测和锁管理，分布式代价更高，而 FDB 面向短事务低冲突场景，OCC 无锁特性在高吞吐下优于 2PL。

### Master 单点分配 Version

`getVersion()`（`masterserver.cpp:74`）按 `requestNum` 顺序分配 version——全局唯一 master 分配单调递增 version（注释 `:45`："Only one process serves as master. Thus the commit version is unique"），完全避免时钟同步问题。`prevVersion` 随 `GetCommitVersionReply` 返回，resolver 经 `versionReady()` 等 `version >= prevVersion`（`Resolver.cpp:226`）保证所有 version < prevVersion 的事务先被解决，实现严格可串行化。`figureVersion()`（`:43`）让 version 粗略跟随 wall-clock（`now * VERSIONS_PER_SECOND - reference`），但 `std::clamp` 限制弹性范围；`MAX_READ_TRANSACTION_LIFE_VERSIONS`（`:118`）限制最大 version gap，保证读事务 snapshot 不会太旧。

### Batching

`commitBatcher()`（`:234`）按 count/bytes/time/firstInBatch 批收集——一个 batch 只需一次 master RPC、一次 resolver RPC（per resolver）、一次 TLog push，size 越大开销摊薄到越多事务。`computeReleaseDelay()`（`:821`）基于历史计算时间估算延迟，在 preresolution 阶段延迟释放 `latestLocalCommitBatchResolving`，让下个 batch 的计算与当前 batch 的 I/O 重叠。intra-batch 用 `MiniConflictSet` bitmap O(1) 检测冲突。GRV proxy 根据回复延迟动态调整 batch interval（`GrvProxyServer.cpp:645`），空闲时缩短降延迟，繁忙时增大提吞吐。

### Resolver 负载均衡

`ResolutionBalancer::resolutionBalancing()`（`ResolutionBalancer.cpp:113`）定期收集各 resolver 指标，迁移 key range，通过 `GetCommitVersionReply` 通知 commit proxy 关于 resolver 重分配（`masterserver.cpp:141` `setChangesInReply`）。`CommitProxyServer.cpp:917` `keyResolvers.modify()` 更新 key range→resolver 映射。`findRange()`（`ResolutionBalancer.cpp:46`）在 resolver 间寻找迁移边界。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Commit Batching | `CommitProxyServer.cpp:234` | 摊薄 RPC 开销，计算与 I/O 重叠 |
| OCC 冲突检测 | `ConflictSet.cpp:948` | 无锁，适合短事务高吞吐 |
| Version 单点分配 | `masterserver.cpp:74` | 全局唯一单调递增，避时钟同步 |
| Proxy 水平分流 | `CommitProxyServer.cpp:3019` | 每 proxy 独立 txnStateStore，无共享状态 |
| RateKeeper 限速 | `GrvProxyServer.cpp:375` + `GrvTransactionRateInfo.cpp:26` | 平滑速率差+budget 累积，三优先级独立 |
| Resolver 负载均衡 | `ResolutionBalancer.cpp:113` | 定期迁移 key range 分担冲突检测 |

## 模块间交互

CommitProxy 依赖：Master（`getCommitVersion`）、Resolver（`resolve`）、LogSystem/TLog（`push`）、txnStateStore（从 TLog 恢复副本）。GRVProxy 依赖：Master（`getLiveCommittedVersion`）、LogSystem（`confirmEpochLive`）、RateKeeper（`getRate`）。Resolver 依赖：ConflictSet、可选 txnStateStore、LogSystem（private mutations push）。Master 无依赖（单点，经 ServerDBInfo 获知 proxy/resolver）。被 ClusterController 招募，经 ServerDBInfo 广播地址。客户端经 loadBalance 选 commit proxy/grv proxy。

## 扩展方式

修改冲突检测粒度：改 `ConflictSet.cpp:799` `addTransaction()`（range 对齐粒度）与 `CommitProxyServer.cpp:154/167` `addRead/WriteConflictRanges`。调整 batching：改 `CommitProxyServer.cpp:234` 的 `COMMIT_TRANSACTION_BATCH_COUNT_MAX`/`BYTES_MAX/MIN`/`MAX_COMMIT_BATCH_INTERVAL` knob（`ServerKnobs.cpp`），注意不能让 batch 处理时间超 `MAX_READ_TRANSACTION_LIFE_VERSIONS / VERSIONS_PER_SECOND`（`:1736`）。增加 resolver：`ResolutionBalancer.cpp:113` 已有自动均衡，`findRange()` 找迁移边界；注意 resolver 间需 `stateMutations` 同步 metadata 变更。
