---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "写入路径"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "Group Commit", "Lock-free"]
description: "WriteBatch 编码、WriteThread 无锁 group commit（leader 代写全组 WAL+memtable）、三段 sequence 发布、WriteController 写止速令牌。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

写入路径是 RocksDB 吞吐的来源：所有并发写请求汇入 `WriteThread` 的无锁队列，被选出的 **leader 代表全组完成一次 WAL append + 一次可选 fsync + 统一 memtable 插入 + sequence 发布**——这是经典的 group commit，把 N 次写折叠成一次临界区。模块覆盖 `db/write_thread.cc/h`（933+503 行）、`db/db_impl/db_impl_write.cc`（2859 行）、`db/write_batch.cc`（3498 行）、`db/write_controller.cc/h`、`db/pre_release_callback.h`。

## 模块架构

```
用户线程                          WriteThread（无锁队列）
   │ DB::Put                          │ newest_writer_（Treiber stack）
   ▼                                  ▼
WriteBatch ──JoinBatchGroup──> [follower]..[leader]..[新来者]
（12B 头+record）                   │ EnterAsBatchGroupLeader：
                                    │ 吸收兼容 writer 成 WriteGroup
                                    ▼
                     leader 独占执行：
                     1. PreprocessWrite（写止速/切 WAL/WBM 检查）
                     2. WriteToWAL（MergeBatch 纯 memcpy → AddRecord 32KB 分段）
                        ├─ 可选 fsync（覆盖全组）
                        └─ PreReleaseCallback（WAL 后、memtable 前）
                     3. InsertInto（组内每个 batch 逐 record 进 memtable）
                        （Merge 例外时 LaunchParallelMemTableWriters）
                     4. SetLastSequence（发布可见性）
                     5. ExitAsBatchGroupLeader（COMPLETED 唤醒 follower，
                        leader 角色移交下一个 writer）
```

## 调用链路

```
DBImpl::Write（db_impl_write.cc:151）
→ DBImpl::WriteImpl（:315）
   ├─ 参数校验（sync+disableWAL 非法；pipelined 与 two_write_queues/unordered 互斥）
   ├─ 分流：WriteImplWALOnly（2PC prepare）/ PipelinedWriteImpl / 主路径
   ├─ WriteThread::JoinBatchGroup（write_thread.cc:401）
   │    └─ LinkOne（:226）CAS 压栈；链空则直接成 leader
   ├─ follower 视角（:491-543）：STATE_PARALLEL_MEMTABLE_WRITER → 自写 memtable
   │    最后完成者发布 sequence；STATE_COMPLETED → 读 w.sequence 返回
   └─ leader 视角（:545 起）：
        ├─ PreprocessWrite（:1403）停写检查/WAL 过大切轮/触发 flush
        ├─ EnterAsBatchGroupLeader（write_thread.cc:440）成组
        ├─ WriteToWAL（:1609）MergeBatch → log_writer->AddRecord（:1594）
        │    need_log_sync → Sync 全部 logs_ + 首次目录 fsync（:1694）
        ├─ PreReleaseCallback 循环（:749-777）逐 writer 赋 sequence
        ├─ InsertInto（write_batch.cc:3212）MemTableInserter 逐 record 插 memtable
        ├─ versions_->SetLastSequence（:876）★ 刻意在 memtable 之后
        └─ ExitAsBatchGroupLeader（write_thread.cc:751）：
             CAS 摘头 → SetState(last_writer, STATE_GROUP_LEADER) 移交 leader
             → 反向遍历 SetState(COMPLETED) 唤醒 follower
```

方法速查：

<details>
<summary>关键方法速查表</summary>

| 方法 | 位置 | 一行职责 |
| --- | --- | --- |
| `JoinBatchGroup` | `write_thread.cc:401` | CAS 入队；follower 自适应等待（自旋→yield→阻塞） |
| `EnterAsBatchGroupLeader` | `write_thread.cc:440` | 从队头吸收兼容 writer 成组 |
| `ExitAsBatchGroupLeader` | `write_thread.cc:751` | 完成组、唤醒 follower、移交 leader |
| `AwaitState` | `write_thread.cc:64` | 三段自适应等待（pause 200 次→yield≤100μs→真阻塞） |
| `LaunchParallelMemTableWriters` | `write_thread.cc:680` | 组内并行插 memtable（Merge 例外） |
| `WriteToWAL` | `db_impl_write.cc:1609` | 组合并 + AddRecord + 可选 sync |
| `InsertInto` | `write_batch.cc:3212` | 组内 batch 逐 record 插 memtable |
| `GetDelay` | `write_controller.cc:51` | 信用制令牌桶算应睡微秒数 |
| `DelayWrite` | `db_impl_write.cc:2105` | 解锁后分片睡眠（1ms 粒度） |
| `PipelinedWriteImpl` | `db_impl_write.cc:888` | WAL 阶段与 memtable 阶段解耦成两级队列 |

</details>

## 核心实现

### Writer 状态机与无锁队列

```cpp title="db/write_thread.h:34-82"
enum State : uint8_t {
  STATE_INIT = 1,                     // 已在 JoinBatchGroup 排队
  STATE_GROUP_LEADER = 2,             // 成为 group leader
  STATE_MEMTABLE_WRITER_LEADER = 4,   // pipelined：memtable 写组 leader
  STATE_PARALLEL_MEMTABLE_WRITER = 8, // 并行 memtable 写者
  STATE_COMPLETED = 16,               // 终态：写已生效
  STATE_LOCKED_WAITING = 32,          // 阻塞在 StateMutex 上
  STATE_PARALLEL_MEMTABLE_CALLER = 64 // 帮 leader 唤醒其他 parallel writer
};
```

`newest_writer_` 是无头结点的 Treiber stack：任何人可无锁 `LinkOne`（CAS 压栈），**只有 leader 能摘除**——这个单删除者约束免掉了 ABA 与标记清除的复杂度（`write_thread.h:301-305` 注释明说所有方法不依赖 DB mutex，只靠"同一时刻最多一个 leader"这一不变量）。`AwaitState` 的三段等待值得细看：pause 自旋 200 次（~1μs）→ `std::this_thread::yield()` 循环至多 100μs（连续 3 次 slow yield 即放弃回退阻塞；`yield_credit` 以 1/256 采样率自适应，成功时 +256、失败时按 `v - v/1024` 指数衰减）→ 惰性构造 per-Writer mutex/cv 真阻塞——`STATE_LOCKED_WAITING` 作为"我已建好锁"的协议位。

### group commit 的收益机制

**为什么 leader 帮全组写 WAL**（`db_impl_write.cc:690-700`）：

1. **fsync 摊薄**：入组规则只禁止"sync writer 跟随 non-sync leader"（`write_thread.cc:510`），反方向允许——leader 的 `sync=true` 一次 fsync 覆盖全组，后续 sync 写全免（`:1650-1688`）。
2. **syscall 摊薄**：合并后一次 `AddRecord` 一条 log record、一次 `Append`；`MergeBatch`（`:1526-1535`）组大小为 1 时直接复用 leader batch 零拷贝，多批时 `WriteBatchInternal::Append` 纯 memcpy 拼接（`write_batch.cc:3448`）——**group merge 无记录级重新编码**。
3. **memtable 局部性**：单 leader 串行插表天然免并发冲突。统计直接体现：`WRITE_DONE_BY_OTHER` 按 `group.size - 1` 计（`:676-681`）。

组上限的精妙规则（`write_thread.cc:451-455`）：默认 1 MiB（`max_write_batch_group_size_bytes`，options.h:1238），但 **leader 自身 batch ≤ 1/8 上限（128 KiB）时组上限收紧为 `size + max/8`**——防大组把小写延迟放大；大 leader 才允许吃满。入组的互斥谓词（`write_thread.cc:510-529`）共八种：sync 请求不得加入非 sync 组（反方向允许——leader 的 sync=true 一次 fsync 覆盖全组）、`no_slowdown` 不一致、`disable_wal` 不一致、`protection_bytes_per_key` 不一致、`rate_limiter_priority` 不一致、`batch == nullptr`、callback 不允许 batching（`AllowWriteBatching`）、超 max_size；`ingest_wbwi`（WriteBatchWithIndex 摄入）必须自成一组。并行 memtable 写的唤醒开销也有专门设计（`LaunchParallelMemTableWriters`，`write_thread.cc:680`）：组 ≥20（`MinParallelSize`）时 stride 取 `sqrt(group_size)`，leader 只直接唤醒 √n 个（含 `STATE_PARALLEL_MEMTABLE_CALLER`），由它们再各唤醒 stride 间隔的成员——总唤醒代价 ≤ 2√n，避免大组串行 SetState 成为瓶颈。

### 三段 sequence 发布：allocated ≠ published

`VersionSet` 维护三个原子量（`version_set.h:1662`）：`last_sequence_ ≤ last_published_sequence_ ≤ last_allocated_sequence_`。**为什么 `SetLastSequence` 刻意放在 memtable 插完之后**（`db_impl_write.cc:876`）：reader 以 seq 为快照上界，若在 WAL 后立刻发布，reader 拿到新快照却查不到数据（数据还在 WAL 没进 memtable）——产生"空洞读"。`two_write_queues` 场景（第二队列 WAL-only prepare 在锁内 `FetchAddLastAllocatedSequence` 取号）这个窗口永久存在，所以 published 变量单独维护；`PreReleaseCallback` 卡在这道缝上——WritePrepared 事务正是要在"已分配未发布"的时刻把 commit-seq 写进 CommitCache。

### WriteController：信用制令牌桶与三级停写

```cpp title="db/write_controller.h:24-110（节选）"
class WriteController {          // 全部方法需持 DB mutex 调用
  std::atomic<int> total_stopped_;              // StopWriteToken 计数
  std::atomic<int> total_delayed_;              // DelayWriteToken 计数
  uint64_t credit_in_bytes_;     // 令牌桶：当前可用字节配额
  uint64_t delayed_write_rate_;  // 当前限速
};
```

停写触发源在 `ColumnFamilyData::SetupStop/SetupDelay`（`column_family.cc:1009`）：memtable 数触顶（`max_write_buffer_number`）、L0 文件数触顶（stop=36/slowdown=20 默认）、pending compaction bytes 超限分别对应 stop；soft limit 对应 delay 并按比例降速。`DelayWrite`（`:2105`）的关键细节：**delay 期间 `BeginWriteStall` 把 `write_stall_dummy_` 哨兵压进 writer 队列**——已排队且 `no_slowdown` 的 writer 被就地 fail 成 `Incomplete("Write stall")`，其余睡 `stall_cv_`；释放 DB mutex 后按 1ms 分片睡眠，期间反复检查条件解除。

### WriteBatch 的 rep_ 编码

```text title="db/write_batch.cc:10-36（格式注释）"
rep_ := sequence: fixed64 | count: fixed32 | data: record[count]
record :=
   kTypeValue varstring varstring              // Put
 | kTypeDeletion varstring
 | kTypeMerge varstring varstring
 | kTypeColumnFamilyValue varint32 varstring varstring   // 带 cf_id 前缀变体
 | kTypeBeginPrepareXID ... kTypeCommitXID ...（2PC 标记也是 record 类型）
varstring := len: varint32, data: uint8[len]
```

头长 `kHeader = 12`（`write_batch_internal.h:81`）：偏移 0 是 8 字节 fixed64 起始 seq（leader 写 WAL 前回填），偏移 8 是 4 字节 fixed32 count；`ContentFlags` 惰性分类支撑 `HasPut()/HasMerge()` 等快速判断——`HasMerge()` 直接决定能否并行写 memtable（`db_impl_write.cc:617`，merge 无法保证同 key 不重复出现）。`wal_term_point_` 支持 2PC 的 commit batch 只写 commit 点之前的部分。合并 batch 时 `WriteBatchInternal::Append`（`write_batch.cc:3407`）**从偏移 12 开始拷贝 src 的 record 流**（剥掉头）、count 相加——`AppendedByteSize` 在两 batch 字节之和上减去 kHeader 去重头部，所以 group merge 是纯 memcpy 无记录级重新编码。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Lock-free Treiber stack | `write_thread.cc:255` 的 CAS 压栈 | 入队零锁；单删除者免 ABA |
| Leader-follower 委托 | `ExitAsBatchGroupLeader` | N 次写折叠一次临界区 |
| 自适应两级等待 | `AwaitState`（`:64-210`） | 短组免 syscall，长组不烧 CPU |
| 位图状态 + 掩码等待 | `state` 是 uint8_t 位标志 | 一次等待多个可达状态 |
| 哨兵对象 | `write_stall_dummy_`（`write_thread.h:446`） | 停写条件无锁侵入队列 |
| RAII 令牌 | StopWriteToken/DelayWriteToken | 析构即释放，CFD 持有 |
| 回调钩子分层 | WriteCallback（写前可否决）/PreReleaseCallback（WAL 后）/PostMemTableCallback | 事务层挂进写管线的三个缝 |

## 模块间交互

**memtable/flush**：`MemTableInserter` 经 `ColumnFamilyMemTables::Seek(cf_id)` 找活跃 memtable 插入；插完 `CheckMemtableFull()`（`write_batch.cc:2934`）→ `flush_scheduler_->ScheduleWork(cfd)`——侵入式无锁链表，下一轮 `PreprocessWrite` 的 `ScheduleFlushes` 真正 seal。**WAL**：`log_writer->AddRecord` 一次成帧；`total_log_size_` 超 `max_total_wal_size` 触发 `SwitchWAL`（`:1416`）。**2PC**：`log_number_ref_ > 0` 时 `RefLogContainingPrepSection` 登记，`LogsWithPrepTracker` 决定 WAL 可删下界。**versions_**：三段 seq 原子量是读路径 `GetLastPublishedSequence` 的来源。

## 扩展方式

**新增 record 类型**：`write_batch.cc` 顶部格式注释 + `ReadRecordFromWriteBatch`（`:372`）+ `ContentFlags` 位（`:80-168`）+ `MemTableInserter` Handler 重载（`:1981`）+ `WriteBatchInternal::Iterate` tag dispatch——历史先例 `kTypeValuePreferredSeqno`（0x18）走的就是这条路。

**调整 group commit 策略**：改 `EnterAsBatchGroupLeader` 的互斥谓词列表（`write_thread.cc:510-529`）与 max_size 计算；`protection_bytes_per_key`、`rate_limiter_priority` 历史上就是这么加进互斥维度的。

**新增限速/停写策略**：仿 `CompactionPressureToken`（`write_controller.h:141`）加 token；消费点 `PreprocessWrite`/`DelayWrite`；要求"入队即失败"语义走 `BeginWriteStall` 哨兵机制（`no_slowdown` 自动被 fail）——WriteBufferManager 全局停写（`:1474-1484`）是现成范例。
