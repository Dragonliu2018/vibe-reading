---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "GC 与事务协调"
date: "2026-10-01T21:00:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "GC", "Deadlock", "ConcurrencyManager", "LockManager"]
description: "TiKV 事务善后三件套：GcWorker safe point 推进与分批限速 GC、中心化死锁检测 wait-for 图、ConcurrencyManager 内存锁表与 max_ts。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

事务提交之后还有三件善后事：删旧版本（GC）、解开互相等待的事务（死锁检测）、防止在途事务破坏快照隔离（内存锁表）。三者都是"事务生命周期的收尾与守门"，共同特点是异步后台线程 + 与 PD/其他 store 协作，因此独立于在线读写路径成模块。

## 模块架构

```text
src/server/gc_worker/
├── gc_worker.rs   GcWorker（:1194）+ GcRunnerCore（:397）
├── gc_manager.rs  GcManager（:230）safe point 循环
├── compaction_filter.rs   RocksDB compaction 时顺带 GC
src/server/lock_manager/
├── deadlock.rs    Detector + DetectTable（:613/:114）+ gRPC Service（:1047）
├── waiter_manager.rs      Waiter/WaitTable（:600）
src/storage/lock_manager/lock_waiting_queue.rs   v9 per-key 优先级队列
components/concurrency_manager/src/lib.rs   ConcurrencyManager + LockTable（:85）
src/storage/txn/txn_status_cache.rs   TxnStatusCache（:283）128 slot 分片 LRU
```

## 调用链路

### GC 一轮

```text
GcWorker::start_auto_gc（components/server/src/server.rs:1091 启动）
└─ GcManager::run_impl（gc_manager.rs:316）循环
   ├─ wait_for_next_safe_point → try_update_safe_point（PD 的 GcSafePointProvider）
   └─ gc_a_round（:441）
      ├─ seek_region：只扫本机为 leader 的 region
      └─ schedule_gc → GcTask::Gc → GcRunnerCore::gc（gc_worker.rs:397）
         ├─ need_gc：MVCC properties + ratio_threshold 跳过干净 region
         ├─ scan_keys 按 batch_keys 分批 → gc_keys → gc_key
         │   └─ actions::gc（gc.rs:13，三态状态机，见 04 篇）
         └─ flush_txn（:379）：limiter.blocking_consume 限速
            → engine.modify_on_kv_engine 直写 RocksDB【绕过 Raft！】
```

### 死锁检测

```text
Storage 遇锁 → LockManager::wait_for（mod.rs:254）
└─ Task::WaitFor → WaiterManager（waiter_manager.rs:600）挂 WaitTable
   └─ 非首锁 → detector_scheduler.detect
      └─ follower 的 Detector 经 gRPC Client::detect（client.rs:80）
         → leader region 的 DetectTable::detect（deadlock.rs:149）
            ├─ register_if_existed 去重
            └─ do_detect（:178）DFS 找 wait-for 回路
               → DeadlockResponse 回 follower → Waiter::cancel_for_deadlock
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `GcManager::run_impl` in gc_manager.rs:316 | safe point 循环 | 新 safe point 变小直接 panic |
| `gc_a_round` in gc_manager.rs:441 | 一轮 region 扫描 | 只扫 leader 防重复 GC |
| `GcRunnerCore::gc` in gc_worker.rs:397 | 单 region GC | need_gc 跳过干净 region |
| `flush_txn` in gc_worker.rs:379 | 限速落盘 | Limiter 背压防 IO 毛刺 |
| `DetectTable::do_detect` in deadlock.rs:178 | DFS 找环 | 边 TTL 清残留 |
| `ConcurrencyManager::lock_keys` in lib.rs:401 | 排序加内存锁 | 防 key 顺序自死锁 |
| `update_max_ts` + `read_key_check` | 快照前内存锁检查 | SI 线性一致的关键 |

</details>

## 核心实现

### GcWorker：限速与绕过 Raft

```rust
// src/server/gc_worker/gc_worker.rs:1194
pub struct GcWorker<E: Engine> {
    engine: E,
    worker: Arc<Mutex<LazyWorker<GcTask<...>>>>,   // GC 任务执行线程
    gc_manager_handle: Arc<Mutex<Option<GcManagerHandle>>>,
    refs: Arc<AtomicUsize>,   // 引用计数，归零 Drop 自动 stop
}
```

三个关键决策：**物理 GC 直写 RocksDB**（`modify_on_kv_engine`）绕过 Raft——被 GC 删掉的版本不会再被读到，无需复制保证，省一整条 raft 链路；**分批限速**（`limiter.blocking_consume` + 32KB 批 + `GC_MAX_PENDING_TASKS=4096` 背压）——GC 是大批量 delete，不限流会打满 LSM compaction 造成前台延迟毛刺；**compaction filter 双轨**——开启时由 RocksDB compaction 顺带删旧版本（`run_impl:329` 跳过物理 GC），filter 处理不过来的投 `GcTask::OrphanVersions` 兜底。`check_if_need_rewind`（:547）处理 safe point 推进导致的回卷。

### 死锁检测：中心化 leader region

```rust
// src/server/lock_manager/deadlock.rs:114
pub struct DetectTable {
    wait_for_map: HashMap<TimeStamp, HashMap<TimeStamp, Locks>>,  // wait-for DAG
    ttl: Duration,   // 每条边的存活期
}
```

wait-for 边散布全簇（事务 A 在 store1 等 B，B 在 store2 等 C...），本地检测无全局视图必漏检环——所以把所有边汇聚到**固定 region 的 leader**（`LEADER_KEY` region）统一 DFS。健壮性双保险：`RoleChangeNotifier`（deadlock.rs:529，raftstore observer）监听 leader 切换清表；每条边带 TTL 防 leader 迁移/节点宕机残留。首锁跳过检测（mod.rs:288 注释：事务的第一把锁不可能成环）省一次 RPC。

### ConcurrencyManager：内存锁的双层设计

```rust
// components/concurrency_manager/src/lib.rs:85
pub struct ConcurrencyManager {
    max_ts: Arc<AtomicU64>,
    lock_table: LockTable,
    max_ts_limit: Arc<AtomicCell<MaxTsLimit>>,   // + drift allowance
    tso: Option<Arc<dyn TSOProvider>>,
}
```

为什么需要内存锁（LockTable）而 storage 已有 CF_LOCK 持久锁：持久锁反映**已提交意图**（落盘后可见），LockTable 反映**在途**（未落盘）事务——若读只在 snapshot 上查持久锁，prewrite 与 snapshot 之间的窗口会漏锁破坏 SI。所以读路径 `prepare_snap_ctx`（storage/mod.rs:3359）在取 snapshot 前同步 `update_max_ts` + `read_key_check`（`Lock::check_ts_conflict`），scan 用 `read_range_check`。`max_ts` 是 async commit 的基石（所有在途读的最大 ts，commit_ts 必须 > 它）；`max_ts_limit` 防 TSO 跳变误 panic（超限先向 PD TSO `double_check`，lib.rs:262）。`lock_keys` 按 key 排序加锁防两个事务以相反顺序加锁互相自死锁。

### v9 新件：LockWaitQueues

`src/storage/lock_manager/lock_waiting_queue.rs`——per-key `KeyedPriorityQueue` 排队 `AcquirePessimisticLock` 请求，替代 legacy"唤醒即返回 WriteConflict"路径，是 pipelined DML 的基建（`wake_up_delay_duration` 平滑唤醒风暴）；配套 `TxnStatusCache`（128 slot 分片 LRU + 大事务独立缓存）缓存 check_txn_status 结果省重复点查。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 任务队列/Actor | `GcTask` enum + LazyWorker | 线程边界靠消息传递 |
| 依赖倒置 | `GcSafePointProvider`/`RegionInfoProvider`/`LockManagerTrait` | PD/storage 解耦可测 |
| RAII | `KeyHandleGuard` / GcWorker Drop 引用计数 | 异常路径也能释放 |
| Observer | `RoleChangeNotifier` 挂 CoprocessorHost | leader 切换感知 |
| 分片锁 | TxnStatusCache 128 slot、LockTable hash 桶 | 降低锁竞争 |

## 模块间交互

pd_client：GC safe point（`get_gc_safe_point` gc_worker.rs:77）、死锁 leader 查询（deadlock.rs:710）、TSO double check；storage/Scheduler：`LockManagerTrait::wait_for` 唤醒等待者（`ReleasedLock` 由 commit/rollback 产生于 mvcc/txn.rs）；tikv_kv：GC 直写引擎；tikv_util：Worker/Limiter。`ConcurrencyManager::new_dummy()`（gc_worker.rs:373）——GC 自身不需要内存锁。

## 扩展方式

- **调 GC 吞吐**：`GcConfig`（src/server/gc_worker/config.rs）的 `max_write_bytes_per_sec/num_threads/batch_keys`，`refresh_cfg` 每任务前热生效
- **死锁诊断增强**：kvproto `deadlock.proto` 的 `WaitForEntry`/`DeadlockResponse` 加字段（`resource_group_tag` 已是先例 deadlock.rs:59）
- **锁等待策略**：改 `lock_waiting_queue.rs` 的优先级与唤醒节奏
