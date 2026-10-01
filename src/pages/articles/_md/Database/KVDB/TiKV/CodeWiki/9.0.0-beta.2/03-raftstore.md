---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "RaftStore v1"
date: "2026-10-01T20:50:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "Raft", "FSM", "BatchSystem", "Multi-Raft"]
description: "TiKV Multi-Raft 复制状态机：PeerFsm/ApplyFsm 双池分离、BatchSystem 批量轮转、propose→ready→apply 流水线、lease read 与 ReadIndex。"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

RaftStore 是 TiKV 强一致性的根基：把单机 KV 引擎变成上万 Region 的 Multi-Raft 集群。它的工程难题不是 Raft 算法本身（raft-rs crate 提供），而是**单机几万个 Raft 组的调度**——每个组是一个独立状态机，轮询会饿死、线程会爆。解法是 FSM + BatchSystem：每个 Region 的 Peer 是一个有限状态机，消息进 mailbox，调度线程一次批量拉多个 FSM 处理。73k 行的体量与独立复杂度使它成为全仓库最大模块。

## 模块架构

```text
components/raftstore/src/
├── store/
│   ├── fsm/
│   │   ├── peer.rs   PeerFsm（7682 行）：region 级消息处理
│   │   ├── store.rs  StoreFsm + RaftBatchSystem（3592 行）
│   │   └── apply.rs  ApplyFsm（8198 行）：日志应用到引擎
│   ├── peer.rs       Peer（6972 行）：raft 状态机封装（与 FSM 解耦）
│   ├── peer_storage.rs / entry_storage.rs   raft 日志与状态持久化
│   ├── msg.rs        PeerMsg/StoreMsg/CasualMessage/SignificantMsg
│   ├── util.rs       RequestPolicy 检查（2847 行）
│   └── worker/       pd.rs / read.rs / split_check.rs / region.rs ...
├── coprocessor/      Observer 注册点（CDC/GC/IME 挂钩）
└── router.rs         RaftRouter（发消息给 FSM）
components/batch-system/src/batch.rs   BatchSystem 通用轮转框架
```

关键拆分思想写在 raftstore-v2 的 lib.rs 注释里（同样适用 v1）：**不依赖 batch system 细节的字段放 `Peer`（raft 模块），依赖的放 `PeerFsm`（fsm 模块）**——换并发方案时只改 fsm 层。

## 调用链路

### propose → apply 完整链

```text
RaftKv::async_write
└─ RaftRouter::send_command（router.rs:54）
   └─ PeerMsg::RaftCommand 进 mailbox
      └─ PeerFsm 分派（fsm/peer.rs:674）
         ├─ cmd_batch 开启时批量合并（BatchReqBuilder）
         └─ propose_raft_command_internal（:5896）
            └─ Peer::propose（peer.rs:3875）
               ├─ inspect → RequestPolicy::ProposeNormal
               └─ propose_normal（:4667）：write_to_bytes → raft propose
                  【quorum 提交】
                  └─ handle_raft_committed_entries（peer.rs:3117）
                     └─ Apply::new(...) → apply_router.schedule_task
                        └─ ApplyFsm::handle_apply（fsm/apply.rs:4051）
                           ├─ apply_raft_cmd（:1465）逐 entry 解码 → kv_wb
                           ├─ flush（:746）→ write_to_db（:576）写 RocksDB
                           └─ ApplyTaskRes::Apply → PeerFsm::on_apply_res
                              （fsm/peer.rs:2494）→ 回调唤醒客户端
```

### ready 驱动（batch 循环内）

`StoreFsmDelegate` 处理完一批消息后调 `collect_ready`（fsm/peer.rs:2199）→ `Peer::handle_raft_ready_append`（peer.rs:2802，raft-rs ready 拆出 entries/messages/snapshot）→ `post_raft_ready_append`（fsm/peer.rs:2125）推进 apply。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `BatchSystem::poll` in batch.rs:382 | 批量拉 FSM 循环 | 每轮重取 batch 防热点饿死 |
| `PeerFsm::on_raft_message` in fsm/peer.rs:2669 | 收到 raft 消息 | 缓存 peer 元信息 |
| `propose_raft_command_internal` in fsm/peer.rs:5896 | 提议前校验 | epoch/term 检查防陈旧命令 |
| `Peer::propose` in peer.rs:3875 | 按 policy 提议 | inspect 决定读写路径 |
| `Peer::read_index` in peer.rs:4198 | ReadIndex 线性一致读 | lease 可合并则免提议 |
| `handle_raft_ready_append` in peer.rs:2802 | ready 拆解 | snapshot/entry/消息三分 |
| `ApplyFsm::handle_apply` in fsm/apply.rs:4051 | 日志应用 | entries 批量组 proposal |
| `ApplyContext::write_to_db` in fsm/apply.rs:576 | 落盘 | ingest 先于 kv_wb 保序 |
| `on_apply_res` in fsm/peer.rs:2494 | apply 结果回执 | 触发 split/心跳 tick 重排 |

</details>

## 核心实现

### BatchSystem：通用 FSM 轮转框架

```rust
// components/batch-system/src/batch.rs:522
pub struct BatchSystem<N: Fsm, C: Fsm> {
    router: BatchRouter<N, C>,
    receiver: Receiver<FsmTypes<N, C>>,
    pool_size: usize,
    max_batch_size: usize,
    low_priority_pool_size: usize,
    /* workers / reschedule ... */
}
```

`poll`（:382）主循环：每轮 `fetch_fsm` 拉一批（`max_batch_size` 上限，但"有 region 等着就必须处理完"防饿死）→ `handler.handle_normal` 逐个处理。handler 钩子顺序（trait 文档）：`begin → handle_control → handle_normal* → light_end → end`；`HandleResult::StopAt{progress, skip_end}` 控制单个 FSM 本轮处理到哪（progress 是消费进度，skip_end 决定是否跳过 end 钩子留到下轮）。`max_batch_size` 在 `handler.begin` 回调中经 config 更新——热更 `raftstore.max-batch-size` 即时生效。两个 raftstore 特化：**reschedule**——FSM 处理超 `reschedule_duration` 被标记 hot，只迁移一半到别的 poller（防下轮又全聚一起）；**优先级池**——低优先级 FSM（如非热点 region）分到 low pool。这个 crate 是 v1/v2 共用的通用件，也证明了"消息驱动 FSM"框架本身的可移植性。

Router 侧（batch-system/router.rs）：`Router.normals` 是 `Arc<DashMap<u64, BasicMailbox<N>>>` 地址簿（region_id → mailbox）；`try_send` 经 `check_do` 产生三态（`NotExist`/`Invalid`/`Valid`），`force_send` 在 `TrySendError::Full` 时绕过邮箱容量直接投递（容量语义：try_send 尊重背压、force_send 用于不可丢消息）。`broadcast_shutdown` 置 shutdown 标志并关闭全部邮箱。

### 双池分离：PeerFsm vs ApplyFsm

```rust
// components/raftstore/src/store/fsm/store.rs:1647
pub struct RaftBatchSystem<EK: KvEngine, ER: RaftEngine> {
    system: BatchSystem<PeerFsm<EK, ER>, StoreFsm<EK>>,
    apply_system: ApplyBatchSystem<EK>,   // fsm/apply.rs:5050
}
```

Raft 日志的 append（网络+盘 IO）与 apply（CPU 密集解码+写 RocksDB）分成两个 BatchSystem 线程池，中间靠 `apply_router` 传任务、`ApplyTaskRes` 回执。why：apply 慢（大 WriteBatch）会阻塞同池其他 region 的消息处理与选举心跳，分离后 append 延迟不受 apply 抖动影响；且 apply 池可以独立调线程数。

### PeerMsg 消息分类

```rust
// components/raftstore/src/store/msg.rs:837（节选）
pub enum PeerMsg<EK: KvEngine> {
    RaftMessage(Box<InspectedRaftMessage>, Option<Instant>), // 跨机 raft 消息
    RaftCommand(Box<RaftCommand<EK::Snapshot>>),             // 客户端命令（不可丢）
    Tick(PeerTick),                                          // 周期 tick
    ApplyRes(Box<ApplyTaskRes<EK::Snapshot>>),               // apply 回执（不可丢）
    SignificantMsg(Box<SignificantMsg<...>>),                // 关键消息（不可丢）
    Persisted { peer_id: u64, ready_number: u64 },           // 持久化完成通知
    CasualMessage(Box<CasualMessage<EK>>),                   // 可丢的次要消息
    /* Start / Noop / HeartbeatPd / Destroy ... */
}
```

消息按**可丢性**显式分级——RaftCommand/ApplyRes 丢了会挂起客户端，CasualMessage（如 split 建议）丢了只是晚点生效。`is_send_failure_ignorable`（msg.rs:908）进一步标注哪些发送失败可容忍（如 CaptureChange）。这种分级让 mailbox 满时的丢弃策略有据可依。

### Lease Read 与 ReadIndex

```rust
// components/raftstore/src/store/peer.rs:4198（read_index 节选）
if self.is_leader() {
    let lease_state = self.inspect_lease();
    if can_amend_read(self.pending_reads.back(), &req, lease_state, ...) {
        // 租约内的读请求可合并到前一个，免再提议
        read.push_command(req, cb, commit_index);
        return false;
    }
}
```

读一致性分三档：**lease read**（leader 租约有效 + applied 到当前 term，`inspect` peer.rs:6191 判 `RequestPolicy::ReadLocal`）直接本地快照读；**ReadIndex**（lease 过期或 follower）发 `MsgReadIndex` 确认，`ReadIndexQueue` 挂 pending 等 `MsgReadIndexResp`；`can_amend_read` 把同租约内的多个读合并成一个 ReadIndex 提议——高并发读的关键摊薄。`LeaseState`（util.rs）三态：`Valid`（租约有效可本地读）/`Expired`（确定过期）/`Suspect`（不确定——raft-rs `in_lease()` 为假时 `inspect_lease` 返回，此时必须走 ReadIndex 兜底）。租约续约有豁免条件：`should_renew_lease = is_leader && !is_splitting && !is_merging && !has_force_leader`，flashback 期间（`region().is_in_flashback`）也不续约；发起 transfer leader（`MsgTimeoutNow`）时主动 `leader_lease.suspect(monotonic_raw_now())` 把租约置疑——新 leader 的读不能再依赖旧租约。`Lease.max_drift = max_lease / 3` 容忍节点间时钟漂移。LocalReader（worker/read.rs:1270）把本地读分流到读线程，不占 raft 池。

### EntryStorage 与 entry cache 预热

`EntryStorage`（entry_storage.rs，1948 行）在 raft-rs 与 RaftEngine 之间维护内存 entry cache。异步写盘引入后 cache **不能按条数截断**：条目未持久化到 raft db 前必须留在缓存（raft-rs 可能还要读——如 leader 发 `MsgAppend`）；`compact_to` 把下标钳制到 `persisted + 1`，只有已持久化条目可 compact。内存超限时 `evict_entry_cache(half=true)` 只驱逐一半（温和回收）。TransferLeader 触发 `CacheWarmupState` 预热：`pre_transfer_leader` 在 `MsgTransferLeader` 里设置 index 为 entry_cache_first_index（告诉候选人预热范围），`async_warm_up_entry_cache` 异步拉日志——两个超时各有分工：`task_timeout_at`（等待拉取完成）与 `election_timeout_at`（防 compact 使预热失效的陈旧判定）。

### Region hibernation：空闲省电

大量 region 长期无流量时，`GroupState`（hibernate_state.rs：Ordered/PreChaos/Chaos/Idle）让 FSM 进入 Idle 省资源：leader 侧 `LeaderState::Awaken/Poll/Hibernated` 三态，经 `MsgHibernateRequest`/`MsgHibernateResponse` 两个 ExtraMessage 与 follower **协商**（`NEGOTIATE_HIBERNATE = Feature::require(5,0,0)` 版本门槛——旧版本不识别协商协议）。follower 在 `has_uncommitted_log`/`wait_data`/发送者非 leader 或未开 `hibernate_regions` 时不回复（隐式拒绝）；leader 的 `maybe_hibernate` 计票，仅当**全部** follower 投票才置 Hibernated。进入 Idle 后 `reset_hibernate_state` 调 `raft.maybe_free_inflight_buffers()` 释放 raft 侧资源；follower 在 Idle 期间用 `missing_ticks` 累计跳过的 tick，转为 Chaos 后补齐以便快速发起竞选。

### write_to_db 的细节

```rust
// components/raftstore/src/store/fsm/apply.rs:576（节选）
if !self.pending_ssts.is_empty() {
    self.importer.ingest(&self.pending_ssts, &self.engine)?;  // SST 先 ingest
}
if !self.kv_wb_mut().is_empty() {
    let seq = self.kv_wb_mut().write_opt(&write_opts)?;       // 再写 kv
    // 超过 APPLY_WB_SHRINK_SIZE 时收缩 WriteBatch 控内存
}
```

同一批次里 put/delete 与 ingest SST 的顺序保证：**必须先 ingest 再写 kv_wb**，否则 SST 里的旧数据会盖住新写入。seqno 回传供 IME 等组件做一致性对齐（见 11 篇）。

落盘时机与同步策略由两个判定函数控制：`should_write_to_engine` 在特定命令前强制先把当前 write batch 刷盘——`ComputeHash`/`CommitMerge`/`RollbackMerge`、`DeleteRange`、已有 pending writes 时的 `IngestSst`；`should_sync_log` 决定 WAL 同步——`CompactLog`/`ComputeHash`/`VerifyHash`/`TransferLeader` 豁免，`IngestSst` 必须同步。**apply_state 必须与 KV 数据写在同一个 KV RocksDB write batch**（`ApplyDelegate.apply_state` 字段注释）：若分离到 Raft RocksDB，断电时 apply_index 已同步而 KV 数据丢失，重启会跳过未应用条目。`finish_for` 里 kv_wb 非空时 `uncommitted_res_count += 1`、记录 `unfinished_write_seqno`——异步写盘未完成期间的回调暂存计数，写完成后统一结算。`has_high_latency_operation`（DeleteRange/IngestSst）触发 delegate 降优先级，防慢命令霸占 apply 池。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| FSM + mailbox | `PeerFsm`/`ApplyFsm` + `BatchRouter` | 锁竞争变队列串行 |
| 批处理轮转 | `BatchSystem::poll` in batch.rs:382 | 摊薄调度开销 |
| 策略枚举 | `RequestPolicy` in util.rs | 读路径决策集中可测 |
| 命令回执 | `ApplyTaskRes` → `on_apply_res` | 异步 apply 完成通知 |
| Observer 挂钩 | `coprocessor/` registry | CDC/GC/IME 寄生不侵入 |

## 模块间交互

向下依赖 engine_traits（KvEngine/RaftEngine 泛型）、raft-rs（状态机）；向旁依赖 pd_client（心跳/split worker）、server transport（RaftClient 发消息）；被 RaftKv（router 写入）、CDC/backup（observer）、IME（observer）依赖。`TxnExt`（store/txn_ext.rs:17）暴露内存悲观锁表给 MVCC 读路径——raftstore 与 storage 层的唯一共享可变状态。

## 扩展方式

- **新增一种 raft admin 命令**：`AdminCmdType` 加变体 → fsm/apply.rs 的 `exec_admin_cmd` 加分支 → fsm/peer.rs 的 `on_ready_xxx` 处理结果 → msg.rs 加对应 CasualMessage（若需异步触发）
- **新增周期 tick**：`PeerTick` 枚举加变体（msg.rs 同文件 tick_registry）→ `register_xxx_tick` + `on_xxx_tick` 两处
- **挂新 observer**：实现 raftstore coprocessor 的 `CmdObserver`/`RoleObserver` 等 trait → `CoprocessorHost::registry` 注册（参考 CdcObserver::register_to observer.rs:47）
