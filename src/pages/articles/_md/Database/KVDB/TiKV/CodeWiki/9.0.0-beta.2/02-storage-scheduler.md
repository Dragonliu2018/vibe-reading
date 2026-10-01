---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "Storage 与事务调度器"
date: "2026-10-01T20:45:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "TxnScheduler", "Latch", "ReadPool", "yatp"]
description: "Storage 门面与 TxnScheduler 事务调度器：latch 序列化、SchedPool 流水线、命令对象模式与 ReadPool 读路径编排。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

Storage 层回答一个问题：**几百个 gRPC 线程并发提交的事务命令，怎么有序地落到 Raft 上**。它是对 gRPC 层暴露的统一门面（RawKV + TxnKV + Coprocessor 的入口），内部用 TxnScheduler 做 per-key latch 序列化、用命令对象（Command）封装每种事务命令的执行逻辑、用 ReadPool 承接读流量。调度与事务语义（MVCC）、复制细节（raftstore）三者正交，这是它独立成层的原因。

## 模块架构

```text
src/storage/mod.rs            Storage<E, L, F>（门面，605 get / 1918 raw_get / 1748 sched_txn_command）
src/storage/txn/scheduler.rs  TxnScheduler（523 run_cmd / 562 schedule_command / 718 execute）
src/storage/txn/sched_pool.rs SchedPool（yatp priority future pool）
src/storage/txn/latch.rs      Latches + Lock（slot 分片 latch 表）
src/storage/txn/commands/     命令对象：prewrite/commit/rollback/acquire_pessimistic_lock...
src/storage/read_pool.rs      ReadPool（unified yatp 或三分池）
components/tikv_kv/src/lib.rs Engine trait + Modify + SnapContext + WriteData
```

核心分工：Storage 只做协议转换与流量分发；TxnScheduler 持有 latch 表与任务上下文；命令对象自带 `process_write` 逻辑（访问 MVCC 层产出 `Vec<Modify>`）；tikv_kv 定义 `Engine` trait——Storage 与具体引擎（RaftKv）之间的契约。

## 调用链路

### 事务命令全路径（prewrite）

```text
Storage::sched_txn_command（mod.rs:1748）
└─ TxnScheduler::run_cmd（scheduler.rs:523）
   └─ schedule_command（:562）
      ├─ Latches::acquire（slot 哈希取 lock 链）──失败→ 挂 wakeup 队列
      └─ execute（:718）spawn 到 SchedPool
         ├─ with_tls_engine(kv::snapshot)        # 取 E::Snap（TLS 引擎句柄）
         ├─ process → process_write（:1806）      # Command::Prewrite::process_write
         │   └─ actions::prewrite → MvccTxn 积累 Vec<Modify>
         ├─ handle_async_write（:1585）
         │   └─ engine.async_write(ctx, WriteData, subscribed, on_applied)
         └─ on_write_finished → release_latches（:547）→ 唤醒等待者
```

### 读路径（get）

`Storage::get`（mod.rs:605）→ `read_pool_spawn_with_busy_check`（:3244，busy 拒绝）→ `prepare_snap_ctx`（:3359，内存锁 `read_key_check` + `update_max_ts`）→ `engine.async_snapshot` → 快照上跑 MvccReader → 回调。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `Storage::sched_txn_command` in mod.rs:1748 | 命令入调度器 | api_version/key size 前置校验 |
| `Storage::get` in mod.rs:605 | 点读入口 | busy_threshold 快速拒绝 |
| `run_cmd` in scheduler.rs:523 | run/schedule 分流 | 大事务走独立慢通道 |
| `schedule_command` in scheduler.rs:562 | latch 排队 | TaskContext 计时打点 |
| `execute` in scheduler.rs:718 | spawn 到 worker | TLS engine 避免传参 |
| `process_read` in scheduler.rs:1266 | 读命令处理 | 共享 sched_pool 跑读 |
| `release_latches` in scheduler.rs:547 | 释放并唤醒 | keep_latches_for_next_cmd 复用 |
| `early_response` in scheduler.rs:1192 | 1PC 提前响应 | proposed 即返回省等待 |

</details>

## 核心实现

### TxnScheduler：单线程事件循环 + worker 池

```rust
// src/storage/txn/scheduler.rs（模块文档，:18-33）
//! TxnScheduler runs in a single-thread event loop, but command executions
//! are delegated to a pool of worker thread.
//! ... uses latches to ensure serialized access to the overlapping rows
```

架构精髓在文档注释里写明：调度循环单线程（latch 排队、唤醒、超时管理），执行重活（MVCC 读写、raft 提交）丢给 SchedPool。latch 不是全局锁——`Latches::new(scheduler_concurrency)` 按 key hash 分 slot（`lock_latch` 的 `hash & (size-1)` 定位 `CachePadded<Mutex<Latch>>` 槽，size 取 2 的幂），每个 slot 一条等待链（`Latch.waiting: VecDeque<Option<(key_hash, cid)>>`），命令需**同时持有全部涉及 key 的 latch** 才能执行（`Lock` 结构），冲突只发生在 key 交集上。防死锁的关键在 `Lock::new`（latch.rs:121-123）：`required_hashes` 先 `sort_unstable` 再 `dedup`——所有命令按同一顺序 acquire，消除相反顺序持锁成环。acquire 时队首同 hash 命令即持有，否则 `wait_for_wakeup` 入队；release `pop_front` 后收集 `wakeup_list` 逐个 `try_to_wake_up`。v9 引入 `keep_latches_for_next_cmd`（:551）：同 key 连续命令直接移交 latch 免一次释放/重取（`push_preemptive` 抢占式插入），pipelined DML 的基建。运行中的命令按 cid 存进 `task_slots`（`TASKS_SLOTS_NUM = 1<<12 = 4096` 个槽，`cid % 4096` 定位）。

### 准入控制：三层过载防线

`run_cmd`（:523）在调度前先过三道闸：`too_busy`（`running_write_bytes >= sched_pending_write_threshold || flow_controller.should_drop`，in-flight 写字节超过阈值或 flow control 判丢）→ `fail_with_busy` 返回 `StorageErrorInner::SchedTooBusy` 快速拒绝；`Task::allocate` 内存配额（`MemoryQuota`）不足同样 `fail_with_busy`；通过后才进 latch 排队。`running_write_bytes` 是 `CachePadded<AtomicUsize>`，new/dequeue task context 时 fetch_add/sub 维护。

### 命令对象模式

```rust
// src/storage/txn/commands/prewrite.rs（结构示意）
pub struct Prewrite { /* data, mutations, primary, start_ts, ... */ }
impl CommandExt for Prewrite { ... }
impl<S: Snapshot> WriteCommand<S> for Prewrite {
    fn process_write(self, snapshot: S, context: WriteContext {...}) -> Result<WriteResult> {
        // 调 actions::prewrite → MvccTxn
        Ok(WriteResult { to_be_write: WriteData, pr: ProcessResult::PrewriteResult, ... })
    }
}
```

每种 gRPC 事务命令一个 struct（prewrite/commit/rollback/check_txn_status/acquire_pessimistic_lock/...），实现统一 trait。`process_write` 的输出 `WriteResult` 携带 `WriteData(Vec<Modify>, TxnExtra)`——Modify 是 MVCC 层到引擎层的通用写单元。这样调度器完全不需要理解事务语义，新命令类型零侵入调度层。

### Modify 与 Engine 契约

```rust
// components/tikv_kv/src/lib.rs:81
pub enum Modify {
    Delete(CfName, Key),
    Put(CfName, Key, Value),
    PessimisticLock(Key, PessimisticLock),
    DeleteRange(CfName, Key, Key, bool),
    Ingest(Box<SstMeta>),
}
// :341
pub trait Engine: Send + Clone + 'static {
    type Snap: Snapshot;
    fn async_snapshot(&mut self, ctx: SnapContext<'_>) -> Self::SnapshotRes;
    fn async_write(&self, ctx: &Context, batch: WriteData, subscribed: u8,
                   on_applied: Option<OnAppliedCb>) -> Self::WriteRes;
    ...
}
```

`async_write` 返回 `WriteEvent` **stream**（:295）——订阅 `EVENT_PROPOSED`/`EVENT_COMMITTED` 事件让 1PC 和 async commit 能在日志提议/提交即响应客户端，不必等 apply。这是 trait 层支持协议优化的例子。trait 还提供同步便捷方法 `Engine::write`（默认实现 `block_on_timeout` 包装 `async_write`，超时 5s），以及 `precheck_write_with_ctx`（默认 `Ok(())`，被 `fail_fast_or_check_deadline` 用于 deadline 预检）。

### 提前响应与不可回滚的失败

`early_response`（scheduler.rs:1192）在 `Proposed`/`Committed` 事件到来时 `take_task_cb` 提前回调客户端但**不释放 latch**（写还要继续）。三条触发路径：**pipelined 悲观锁**——`PessimisticLockMode` 三档（`Sync`/`Pipelined`/`InMemory`，InMemory 需 pipelined+in_memory 且 feature_gate 允许 `IN_MEMORY_PESSIMISTIC_LOCK`），Pipelined 档在锁提议即响应；**async apply prewrite**——`WriteEvent::Committed` 且 `ResponsePolicy::OnCommitted` 时置 `is_async_apply_prewrite`，提交即回。两条安全兜底：响应通道在非 shutdown 时关闭会 **panic**（无法安全释放 latch，宁死不脏）；`ErrorInner::Undetermined`（不确定写是否成功）同样 panic——这类错误一旦出现进程状态已不可信。

### ReadPool 与 SchedPool 分离

读走 `read_pool.rs`（unified yatp 池或 storage 三分池），写走 `sched_pool.rs`（`build_priority_future_pool`，带 `TaskPriorityProvider` 资源组优先级）。分离的 why：读是无副作用可并行的（快照即一致性边界），写有 latch 序列化且要等 Raft 往返——负载形态完全不同，池参数（线程数/队列容量/优先级）各自调优；且读池还有 coprocessor 的高/中/低优先级复用（见 06 篇）。

SchedPool 内部是**双队列**：`Vanilla` 模式（未开资源控制）下高优先级命令走 `high_worker_pool`（规模 `max(1, pool_size/2)`，`CommandPri::High` 进该池，其余进普通池）；`resource_ctl` 存在时切 `QueueType::Dynamic`，`can_use_priority` 依 `resource_ctl.is_customized()` 决定走 PriorityQueue 还是 vanilla——PriorityQueue 把 `CommandPri` 映射 fixed_level（High→0 / Normal→无 / Low→2）并经 `with_resource_limiter` 包 `ControlledFuture` 实现资源组限流。池线程经 `after_start` 钩子 `set_tls_engine` + `set_io_type(IoType::ForegroundWrite)` 装载 TLS 引擎、`before_stop` 里 `destroy_tls_engine` + `tls_flush` 卸载——TLS 引擎的生命周期与池线程绑定。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 命令对象 | `commands/` 全部 struct + `WriteCommand` trait | 调度与事务语义解耦 |
| 分片锁 | `Latches` slot 表 in latch.rs | 并发度从全局降到 key 粒度 |
| TLS 引擎 | `with_tls_engine` in kv/mod.rs | worker 线程免传参访问引擎 |
| 背压 | `Scheduler::schedule` 容量检查 + read pool busy | 过载快速失败防雪崩 |
| 内存配额 | `MemoryQuota`（Task 进入调度器前检查） | OOM 防护 |

## 模块间交互

向下依赖 `tikv_kv`（Engine trait）与 MVCC 层（actions/mvcc）；向旁依赖 lock_manager（`LockManagerTrait::wait_for`，悲锁等待走死锁检测）与 concurrency_manager（`update_max_ts`、内存锁 guard）；被 server/service 依赖（gRPC 直接调 Storage 方法）。与 raftstore 的唯一接口是 `Engine` trait 的两个 async 方法——测试时换 MockEngine 即可全链路单测（`TestStorageBuilder` mod.rs:3582）。

## 扩展方式

- **新增一种事务命令**：`commands/` 新建 struct 实现 `WriteCommand`（或 `ReadCommand`）→ 在 `storage/txn/mod.rs` 的 Command 枚举加变体 → `sched_txn_command` 入口加 From 转换
- **调整调度并发**：`scheduler_concurrency`（latch slot 数）与 `scheduler_worker_pool_size` 配置，热更走 `DynamicConfigs`
- **接入 pipelined DML 类特性**：参考 `lock_waiting_queue.rs`（v9 新增）的 `LockWaitQueues`——per-key 优先级队列替代"唤醒即 WriteConflict"
