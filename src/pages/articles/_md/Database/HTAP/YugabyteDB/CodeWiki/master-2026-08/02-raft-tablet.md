---
source:
  type: "源码解读"
  project: "yugabyte-db"
  url: "https://github.com/yugabyte/yugabyte-db"
title: "Raft 共识与 Tablet"
date: "2026-09-23T00:05:00+08:00"
category: [Database, HTAP, YugabyteDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["YugabyteDB", "C++", "Raft", "WAL", "Tablet", "Leader Lease", "Auto Splitting"]
description: "YugabyteDB Raft 共识与 Tablet 层解读——per-tablet Raft 组、pre-election 与 leader 租约双时钟、WAL 只写 REPLICATE 的减半设计、Operation 状态机双面性、自动分裂的 OperationFilter 机制全解"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`src/yb/consensus/`（36k 行）+ `src/yb/tablet/`（50k 行）是 YugabyteDB 的复制与数据面内核——per-tablet 一个 Raft 组实现强一致复制，WAL 只写 REPLICATE 消息，tablet 层用 Operation 状态机驱动 apply。三份官方设计文档（`src/yb/consensus/consensus.txt` 148 行 Raft 变体总纲、`src/yb/consensus/README` 241 行 WAL group commit、`architecture/design/docdb-raft-enhancements.md`）与代码严格对照可读。**注意**：log 系列文件（log.cc/log_cache.cc 等）不在独立目录，全部在 consensus/ 内；split 的执行实现在 `src/yb/tserver/ts_tablet_manager.cc`。

## 模块架构

![Raft 副本角色与 tablet 分裂状态机](/vibe-reading/images/articles/yugabytedb-internals/state-flow.svg)

```
TSTabletManager (tserver, 拥有所有 TabletPeer, 实现 TabletSplitter 接口)
  └─ TabletPeer (tablet_peer.h:149)      一个 Raft 组在本节点的代表
       ├─ consensus::RaftConsensus       复制状态机
       ├─ log::Log                       WAL (segment 序列)
       ├─ RaftGroupMetadataPtr meta_     tablet 元数据
       └─ TabletPtr tablet_              数据面 (tablet.cc ~6400 行)
            ├─ regular_db_ / intents_db_ (两个 RocksDB: 主存储 + 事务意图)
            ├─ MvccManager (mvcc.h:84)
            └─ TransactionParticipant / TransactionCoordinator
```

`TabletPeer` 同时实现 4 个 context 接口（tablet_peer.h:149-153）：`consensus::ConsensusContext`（consensus 回调进 tablet 层的唯一通道）、`TransactionParticipantContext`、`TransactionCoordinatorContext`、`WriteQueryContext`——**依赖倒置：consensus 不依赖 tablet，tablet 也不依赖 consensus，TabletPeer 是桥**。

| 组件 | 文件 | 职责 |
|---|---|---|
| `RaftConsensus` | raft_consensus.cc（~3800 行） | 唯一生产实现，继承 Consensus + PeerMessageQueueObserver |
| `ReplicaState` | replica_state.h:96 | 与 RaftConsensus 1:1；pending/committed 双配置；按操作类型加锁并校验角色 |
| `PeerMessageQueue` | consensus_queue.h:112 | leader 侧每 peer 的 next_index/watermark + LogCache |
| `LeaderElection` + `VoteCounter` | leader_election.h:164/69 | 选丘认证（VoteCounter 数票在内存不落盘） |
| `LeaderLease`（模板） | leader_lease.h | 双时间源：CoarseTimePoint（wall）与 MicrosTime（hybrid-time） |
| `MultiRaftHeartbeatBatcher` | multi_raft_batcher.h:48 | 跨 tablet 心跳合并成一个 RPC |
| `Operation`/`OperationDriver`/`Preparer` | tablet/operations/ | 操作状态机与攒批 |

## 调用链路

一次写入的共识路径（leader 端，每步文件:函数）：

```
① RPC: TabletServiceImpl::Write (tserver/tablet_service.cc:2620)
② tablet.peer->WriteAsync(query) → TabletPeer::WriteAsync (tablet_peer.cc:752)
   └─ ★进 Raft 之前先做内存执行: Tablet::AcquireLocksAndPerformDocOperations
      (tablet.cc:2615) → WriteQuery::Execute (write_query.cc:733)
      —— 行锁获取、冲突检测、intent 生成都在复制前完成
③ TabletPeer::Submit (tablet_peer.cc:769) → NewLeaderOperationDriver (:1704)
   → Preparer::Submit (preparer.cc:189) 攒批（max_group_replicate_batch_size=16）
   → ReplicateBatch(rounds)
④ RaftConsensus::ReplicateBatch (raft_consensus.cc:1245) → DoReplicateBatch (:1260)
   ├─ state_->LockForReplicate()     校验角色与 bound_term
   ├─ RegisterRetryableRequest        WRITE_OP 幂等去重
   ├─ state_->NewIdUnlocked()         分配 OpId (term, index)
   └─ queue_->AppendOperations(...)   → LogCache → Log::AsyncAppendReplicates 写 WAL
⑤ peer_manager_->SignalRequest()     → UpdateConsensus RPC 推 follower
   （可被 MultiRaftHeartbeatBatcher 合并）
⑥ follower: RaftConsensus::Update (:1603) → UpdateReplica (:1966)
   函数头 40 行注释规定严格顺序:
   0 dedup → 1 EarlyCommit → 2 EnqueuePrepares (:2190) → 3 EnqueueWrites
   (WAL 写失败即 crash) → 4 MarkCommitted → 5 WaitForWrites (等 WAL durable 才 ACK)
⑦ 多数派 ACK → UpdateMajorityReplicated (:1450) 推进 committed index
   —— 通过写"空批"把 committed_op_id 广播给 follower
⑧ Apply: WriteOperation::DoReplicated → Tablet::ApplyRowOperations
   (intent 应用/合并进 regular RocksDB) → MVCC 提交、行锁释放 → 回执客户端
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
|---|---|---|
| `RaftConsensus::Update` | follower 处理 AppendEntries | consensus.h:150 注释明说 "equivalent to AppendEntries() in Raft terminology" |
| `RaftConsensus::StartElection` | 选举入口 | raft_consensus.cc:1073 |
| `RaftConsensus::BecomeLeaderUnlocked` | 上任 | :1135；复制 NO_OP 确立本 term 可提交性 |
| `RaftConsensus::StepDown` | 领导权交接 | :856；master 负载均衡入口，protege 机制 |
| `TabletPeer::RunLogGC` | WAL 回收 | tablet_peer.cc:907；LogGCOp 是 MaintenanceManager 的一个 op |
| `Log::AsyncAppendReplicates` | WAL 批量写 | Appender 线程 group commit |
| `TSTabletManager::ApplyTabletSplit` | 分裂执行 | ts_tablet_manager.cc:1243 |

</details>

## 核心实现

### Leader 选举：pre-election + 租约双时钟

完整路径：failure_detector 到期 → `ReportFailureDetected` → `StartElection`（raft_consensus.cc:1073）→ **`DoStartElection`（:609）的 pre-election**——以 term+1 但**不递增本地持久 term、不自投**的方式探测（`CreateElectionUnlocked`，:710 的 preelection 分支），票数过半后再发起正式选举。这是 Ongaro 论文 §4.2.3 的实现，避免被分区节点扰乱 term。胜出后 `BecomeLeaderUnlocked`（:1135）做四件事，其中关键是**复制一条 NO_OP 到本 term**——Raft §5.4.2 的"只有本 term 有已提交条目才能认为前任 term 条目 committed"（`leader_no_op_committed_` 标志，replica_state.cc:244）。

**租约双时钟**（docdb-raft-enhancements.md）：wall-clock 租约（默认 2s，raft_consensus.h:86）+ hybrid-time 租约（`FLAGS_ht_lease_duration_ms`）。投票响应携带旧 leader 租约剩余时长（`ElectionResult::old_leader_ht_leases`，leader_election.h:137），新 leader 必须等旧租约过期（`UpdateOldLeaderLeaseExpirationAfterElectionUnlocked`）。**hybrid-time 租约是 MVCC fencing**：`CheckLeasesUnlocked`（:1295）在每批操作入队时校验，保证 leader 失效后不会写入更低 hybrid_time 的数据。

### WAL：只写 REPLICATE，commit index 搭车

这是 YB 相对 Kudu 最重要的简化。`log.proto` 的 `LogEntryTypePB` 只有 `REPLICATE = 1`（加 marker），**没有 COMMIT entry**——提交状态搭载在 `LogEntryBatchPB.committed_op_id` 上。leader 推进 commit index 的方式是**写一个空批更新**（raft_consensus.cc:1510-1518）。WAL 写放大直接减半。

其他要点：`Log::Appender`（TaskStream）单线程批量取队、序列化在锁外、统一 Sync——`durable_wal_write` flag 默认**关闭**（依赖多数派复制而非本地 fsync，README:34-36）。Segment 异步预分配（新 segment 在独立线程预分配期间旧 segment 继续写）。崩溃恢复 `ReuseAsActiveSegment()`（log.h:304）复用无 footer 的 in-progress segment；孤儿 REPLICATE（有 replicate 无 committed）放进 `ConsensusBootstrapInfo::orphaned_replicates` 交回 consensus 继续。

### Operation 双面性：leader 与 follower 复用同一状态机

`Operation`（operation.h:82）的 `Prepare/Replicated/Aborted` + `OperationDriver`（operation.h:110）在 leader 与 follower 走同一代码路径，区别只在 `OperationDriver::Init(operation, term)`：`term == kUnknownTerm` 即 follower。10 种操作类型（Write/ChangeMetadata/UpdateTxn/Split/Snapshot/Truncate/HistoryCutoff/ChangeAutoFlagsConfig/Clone + consensus-only 的 NO_OP/CHANGE_CONFIG）。两个"全枚举强制表态"的决策点很精妙：`PreparerImpl::ShouldApplySeparately`（preparer.cc:272，漏 case 编译期 FATAL——ChangeMetadata 的 Prepare 拿 schema 锁，同批两个会死锁）与 `SplitOperation::ShouldAllowOpAfterSplitTablet`（split_operation.cc:60）。**group commit 在 tablet 层的实体就是 Preparer**——per-tablet 单线程 token，leader 侧攒批后一次 `ReplicateBatch()`。

### 与标准 Raft 的差异清单

1. **显式 learner 非投票角色**（consensus.txt:37；`CountVoters()` 只数 VOTER/PRE_VOTER）
2. **Leader lease 替代读路径 heartbeat**（读性能核心增强）
3. **Pre-election** 防分区节点扰动 term
4. **op id 三元组**：`(term, index)` 之上携带 hybrid_time + monotonic_counter
5. **成员变更**：文档说 joint consensus，实际 `ChangeConfig()`（:2657）是**单条 CAS 式变更**（不允许改变 majority 尺寸；ADD_SERVER 只接受 PRE_VOTER/PRE_OBSERVER）
6. `withhold_votes_until_`（raft_consensus.h:744）：被遗弃节点的拉票直接忽略
7. consensus.txt 中的 Spanner 式 commit-wait 与 anti-flapping 选举**均自注未实现**（KUDU-430/562）——文档愿望而非现状

### Tablet 自动分裂

四阶段（docdb-automatic-tablet-splitting.md + 代码对照）：

1. **识别**：master 经 heartbeat 下发阈值，tserver 上报超限 tablet
2. **发起**：master 注册**两个全新 tablet ID**（而非"旧 ID + 新 ID"——文档 55-58 行论证：key range per tablet ID 可被激进缓存且永不变）+ `partitions_version++` + `SplitTablet()` RPC
3. **执行**：`SplitOperation` 走普通 Raft 复制。**核心机制是 OperationFilter**：`AddedAsPending()` 调 `tablet->RegisterOperationFilter(this)`——**从 split 操作进入 Raft log 那一刻起（而非 apply 时），老 tablet 就拒绝新数据操作**（白名单仅 NO_OP/SNAPSHOT/CLONE/CHANGE_CONFIG），上层收到 `TABLET_SPLIT` 错误码后改投新 tablet；bootstrap 重放时同样注册，崩溃恢复后语义不变。执行时 `TSTabletManager::ApplyTabletSplit`（ts_tablet_manager.cc:1243）用**RocksDB 硬链接复制目录** + `BoundedRocksDbIterator` 过滤越界 key（等下次大 compaction 物理删除）、WAL `CopyTo` 只复制到 split op、子 tablet 复用同一 ConsensusMetadata 实例改 tablet_id 再 Flush
4. **收尾**：老 tablet 保留一段时间做 remote bootstrap 兜底；分裂记录被 log anchor 防 GC

intents DB 的分裂特殊处理：TxnId 反向索引不按原 key 排序，不能按 mid-key 切——只能整体复制 + 在 `docdb::PrepareApplyIntentsBatch` 按原 key 过滤（文档 117-132 行）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 依赖倒置 | TabletPeer 实现 4 个 Context 接口（tablet_peer.h:149） | consensus↔tablet 双向解耦 |
| 模板方法 | Operation/OperationDriver 的六步骨架（operation.h:72-109 注释） | leader/follower 共用一条状态机 |
| 观察者 | RaftConsensus 实现 PeerMessageQueueObserver | 多数派 watermark 回调驱动 commit |
| 状态机 | RaftGroupStatePB × TabletDataState + 角色 PRE_VOTER→VOTER 晋升 | 崩溃恢复语义精确 |
| 策略过滤 | OperationFilter（split_operation.cc:60） | 分裂期间白名单放行 |

## 模块间交互

- **上游**：tserver 的 `TabletServiceImpl::Write` 创建 WriteOperation 进入本层（见[TServer](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/03-tserver)）
- **下游**：apply 阶段进 DocDB（`Tablet::ApplyRowOperations` 写两个 RocksDB，见[DocDB 存储抽象](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/04-docdb)）
- **与 master**：分裂识别与 leader 均衡由 master 经 heartbeat 指令驱动（见[Master](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/01-master)）
- **与 CDC**：`log_index_needed_by_cdc` 软下限参与 WAL GC 决策（见[CDC 与 xCluster](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/07-cdc-xcluster)）
- **销毁顺序约束**（consensus.h:139-149）：先 quiesce Consensus → close Log → 析构 Consensus

## 扩展方式

**新增一种 Operation 类型**（照 CLONE_OP——最新加入的模板）：

1. `consensus_types.proto` 的 `OperationType` 加值 + `consensus.proto` 的 `ReplicateMsg` 加字段 + `consensus.messages.h` 的 LW 版本
2. 新建 `operations/foo_operation.h/.cc` 继承 `OperationBase<OperationType::kFoo, LWFooRequestPB>`；文件底部特化 `RequestTraits`（照抄 split_operation.cc:30-40）
3. `TabletPeer::CreateOperation`（tablet_peer.cc:1555）switch 加 case——**漏掉此处 follower 收到该 op 会 DFATAL**
4. 两个全枚举决策点表态：`ShouldApplySeparately`（preparer.cc:272）+ `ShouldAllowOpAfterSplitTablet`（split_operation.cc:60）
5. 若 consensus-only：改 `IsConsensusOnlyOperation`（raft_consensus.cc:1295 的租约豁免）
6. bootstrap 重放路径（`tablet_bootstrap.cc` 的 op 分发 switch）能重建软状态
7. 测试：`raft_consensus-test.cc` 模式
