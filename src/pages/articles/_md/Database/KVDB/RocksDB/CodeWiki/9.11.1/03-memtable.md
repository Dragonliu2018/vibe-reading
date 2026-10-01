---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "MemTable"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "SkipList", "Copy-on-Write"]
description: "MemTable 双表设计（跳表 + range tombstone 表）、MemTableList 的乱序执行按序提交协议、WriteBufferManager 跨 DB 内存配额与 COW 快照一致性。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

LSM 的内存可变层：写入先落 MemTable（有序跳表 + 独立 range tombstone 表），写满后 seal 为 immutable 进 `MemTableList` 队列等 flush；`WriteBufferManager` 在所有 CF/所有 DB 实例间做内存配额与止速。涉及 `db/memtable.cc/h`（1821 行）、`db/memtable_list.cc/h`、`memtable/skiplist.h + inlineskiplist.h`（1178 行）、`memtable/write_buffer_manager.cc`。

## 模块架构

```
ColumnFamilyData
  mem_（活跃，可写）           imm_（MemTableList）
    ├─ table_（InlineSkipList，     ├─ MemTableListVersion（COW 快照）
    │   由 memtable_factory 决定）   │    memlist_（未 flush，front=最新）
    ├─ range_del_table_（恒 SkipList）│    memlist_history_（已 flush 保留，事务校验用）
    └─ arena_（ConcurrentArena，     └─ num_flush_not_started_ / commit_in_progress_ /
        经 AllocTracker 记账 WBM）       flush_requested_（调度信号）

写入：MemTableInserter → Add（internal key 编码）→ 跳表 CAS 插入
切表：ShouldScheduleFlush（CAS 去重）→ flush_scheduler_（无锁栈）
      → 下一个 leader 的 PreprocessWrite → SwitchMemtable → imm_->Add
flush：PickMemtablesToFlush → FlushJob → TryInstallMemtableFlushResults（按创建序提交）
```

## 调用链路

```
写入插入路径
  WriteBatchInternal::InsertInto（write_batch.cc:3246）
  → MemTableInserter::PutCFImpl（:2269）
  → mem->Add(seq, type, key, value, concurrent, post_process_info)
     （memtable.cc:909：arena 编码条目 → table_->InsertKey → UpdateFlushState）

memtable 满的流转（9.11.1 无 MakeRoomForWrite，拆成两半）
  写线程（免锁）：CheckMemtableFull（write_batch.cc:2934）
    → mem->ShouldScheduleFlush()（FLUSH_REQUESTED 状态）
    → MarkFlushScheduled（CAS FLUSH_REQUESTED→FLUSH_SCHEDULED，保证单线程响应）
    → flush_scheduler_->ScheduleWork(cfd)（侵入式无锁链表）
  下一轮写的 leader：PreprocessWrite → ScheduleFlushes（db_impl_write.cc:2322）
    → SwitchMemtable（:2392）
       ├─ seal 前预构建 range tombstone 片段（:2495）
       ├─ creating_new_log → NewFileNumber 分配新 WAL 号 → CreateWAL
       ├─ cfd->imm()->Add(cfd->mem())（memtable_list.cc:661：push_front + MarkImmutable）
       └─ cfd->SetMemtable(new_mem) + InstallSuperVersionAndScheduleWork

flush 消费
  BackgroundFlush → FlushMemTableToOutputFile
    ├─ SyncClosedWals（多 CF/2PC：先固化 WAL + 记录 max_memtable_id 截断快照）
    ├─ FlushJob::PickMemTable → imm()->PickMemtablesToFlush(max_memtable_id)
    ├─ WriteLevel0Table → BuildTable 落 L0 SST
    └─ TryInstallMemtableFlushResults（memtable_list.cc:517）
       按 memtable 创建序提交 manifest；失败则回滚全部状态标志
```

## 核心实现

### 条目编码与为什么是 internal key

```text title="db/memtable.cc:915（格式注释）"
entry := varint32(internal_key_len) + user_key + 8B(seq<<8|type) + varint32(vlen) + value
```

memtable 是 MVCC 的载体：同一条 user key 允许多版本共存（Put 三次 = 三条 entry），不加 seq 就无法区分新旧，也无法在写入时"覆盖"（那需要查找+删除，破坏 O(log n) 纯插入模型与无锁读）。排序规则"**user key 升序 + seq 降序**"（`InternalKeyComparator::Compare`，`dbformat.h:1083`）使 `Seek` 后第一条即最新版本。附带收益：与 SST 格式统一——memtable 迭代器 flush 时可直接与 L0 文件同级归并，无需转换层。range tombstone 独立一张 `range_del_table_`（恒为 SkipList，hash 类 rep 不支持 Seek 语义）：range del 的 key 是区间不是点，放主表会破坏版本降序查找模型；碎片化成不相交区间后在 seal 时预构建缓存（`ConstructFragmentedRangeTombstones`）。

### MemTableListVersion：COW 快照

头注释（`memtable_list.h:37`）："The list is immutable if refcount is bigger than one"。读线程无 DB mutex 经 SuperVersion 持有旧版本快照（长迭代器、进行中的 Get）；写线程 `InstallNewVersion`（`memtable_list.cc:736`）只在 `refs_==1` 时原地改，否则整表拷贝（拷贝构造对每个成员 Ref）——旧版本等最后一个读者 Unref 后才连带释放 memtable。`Add/Remove` 的 `assert(refs_ == 1)` 是不变量的强制执行。这与 Version/SuperVersion 的发布模式同构：**LSM 内存层的读时快照一致性靠引用计数而非锁**。

### flush 的乱序执行、按序提交协议

`MemTableList` 最大的复杂度不在数据结构，在这个协议：多个 imm 可以**乱序**完成 flush（并行 flush job），但 manifest 提交必须**按 memtable 创建序 FIFO**（`memtable_list.h:227` 类注释）。`TryInstallMemtableFlushResults`（`:517-658`）持 `commit_in_progress_` 单线程执行：从 `memlist_.back()`（最老）开始收集 `flush_completed_=true` 的**连续**批次提交；遇到中间未完成的 break（防并行 flush 回滚后挑出不连续区间）。失败路径 `RemoveMemTablesOrRestoreFlags`（`:749-831`）回滚三个状态标志并恢复计数——并行 flush + FIFO 提交 + 失败回滚的三处状态恢复是本模块最精密的部分。

### WriteBufferManager：跨 DB 配额

`ShouldFlush()`（`write_buffer_manager.h:101`）双限：软限 `mutable 内存 > 7/8 总额`、硬限 `总额满且 mutable ≥ 1/2`。计费三段式：`ReserveMem`（+used +active）→ `ScheduleFreeMem`（-active，seal 时）→ `FreeMem`（-used，析构时并 `MaybeEndWriteStall`）。`cost_to_cache` 模式经 `CacheReservationManager` 以 256KB dummy entry 记账进 block cache 配额——cache 之外的分配若不占 cache 容量，总内存会超预算。`ShouldStall` 触发的全局停写走 `BeginWriteStall` 把 DB 实例挂进 queue_，`FreeMem` 的 `MaybeEndWriteStall` Signal 全队列。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 接口 + 工厂多实现 | `MemTableRep`（skiplist/hash_skiplist/hash_linklist/vector 四种） | 存储结构与 workload 匹配 |
| 二级多实现 | `ReadOnlyMemTable` → `MemTable` / `WBWIMemTable`（WBWI 原子注入） | 直接摄入绕过写路径 |
| 一次性状态机 | `FlushStateEnum` + `MarkFlushScheduled` CAS | 多写线程同时发现"满了"只有一个去调度 |
| 侵入式回调 | `MemTableRep::Get(key, saver, SaveValue)` C 函数指针 | 值解析逻辑与存储结构解耦 |
| 分块记账 | `ConcurrentArena` block 级 + `AllocTracker` → WBM | 计费不进热路径 |

## 模块间交互

**write_thread**：并发模式（`concurrent_memtable_writes`）下 leader 与 follower 在 mutex 外并发 `Add(allow_concurrent=true)`（跳表 CAS 逐层链接，`inlineskiplist.h:1026`）。**version_set**：flush 完成 `TryInstallMemtableFlushResults → LogAndApply` 把 L0 文件追加进 Version 并推进 log_number（WAL 可回收边界在 `GetDBRecoveryEditForObsoletingMemTables` 跨 CF 计算）。**column_family**：每 CF 一个 imm list；flush 决策与 stall 重算都在 CF 层。**range_del_aggregator**：`MemTableListVersion::AddRangeTombstoneIterators` 把每个 imm 的碎片化 tombstone 迭代器喂进读路径聚合器。

## 扩展方式

**新增 memtable 数据结构**（如 ART）：实现 `MemTableRep`（重点：`InsertKey`/Get 的 callback 遍历语义/`GetIterator`/`MarkReadOnly`/`ApproximateMemoryUsage`）+ `MemTableRepFactory`，注册进 `CreateFromString`（`memtablerep.h:334`）；不能并发插入就不覆写 `IsInsertConcurrentlySupported`，自动回退 leader 串行模式。

**调整 flush 触发策略**：改 `MemTable::ShouldFlushNow`（`memtable.cc:177`——arena 块过分配 0.6 系数、末块 0.75 满即停的启发式有完整推导注释）；改"选哪些 imm 一起 flush"动 `PickMemtablesToFlush`（`:405`）与 `min_write_buffer_number_to_merge_`。

**WBM 新止速策略**：改 `ShouldFlush/ShouldStall` 与 `BeginWriteStall/MaybeEndWriteStall`（`write_buffer_manager.cc:118-164`）；选 CF 的启发式在 `HandleWriteBufferManagerFlush`（`db_impl_write.cc:2002`——挑 mutable 非空且 imm 不忙、创建 seq 最小的 CF）。
