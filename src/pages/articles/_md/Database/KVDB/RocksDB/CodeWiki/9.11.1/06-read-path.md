---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "读路径"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "Iterator", "Heap Merge"]
description: "GetImpl 逐层点查（FilePicker 剪枝 + bloom 提前终止）、MergingIterator 堆合并（含 range tombstone 处理）、DBIter 多版本去重与 merge 链、PinnedIteratorsManager 生命周期。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

读路径与写路径完全解耦：**point read**（`DBImpl::GetImpl`）逐层手写查找，**range scan**（DBIter 包装 MergingIterator）堆合并全层迭代器。涉及 `db/db_impl/db_impl.cc` 的 GetImpl/NewInternalIterator、`db/db_iter.cc`（1810 行）、`table/merging_iterator.cc`（1755 行）、`db/table_cache.cc`、`db/pinned_iterators_manager.h`。

勘误（9.11.1 核实）：`db_impl_read.cc` 不存在（读路径全在 `db_impl.cc`）；LevelDB 时代的 `FindSmallest/FindNextEqualKey` 已演进为 `FindNextVisibleKey/SkipNextDeleted`；`Iterator::kPersistedTxnSeq` 不存在于本版本。

## 模块架构

```
GetImpl（点查）                        NewIterator（扫描）
  snapshot seq                           DBIter（方向转换+去重+merge 链）
  ├─ active memtable Get（跳表直查）       └─ ArenaWrappedDBIter（外壳，支持 Refresh）
  ├─ imm 队列逐个 Get                       └─ MergingIterator（最小堆）
  └─ Version::Get                             ├─ active memtable 迭代器
      ├─ FilePicker 按层挑候选文件             ├─ 每个 imm 迭代器
      │   （L0 按 largest_seq 新→旧；          ├─ L0 每文件一个迭代器
      │    L1+ FileIndexer 二分剪枝）          └─ L1+ 每层一个 LevelIterator（惰性）
      ├─ 每文件 TableCache::Get               （range tombstone 也伪装成 HeapItem 进堆）
      │   ├─ bloom filter 整文件裁决
      │   ├─ index 定位 → block 读 → 块内搜索  TableCache（LRU 缓存 TableReader）
      │   └─ GetContext::SaveValue 裁决        （charge=1：容量语义是文件数）
      └─ merge → TimedFullMerge
```

## 调用链路

```
GetImpl（db_impl.cc:2289）
├─ GetAndRefSuperVersion 先拿引用再取 seq（:2345/:2359——顺序不能反：
│   否则中间的 flush/compaction 可能恰好搬走 snapshot 可见数据）
├─ LookupKey(key, snapshot)（lookup_key.h:20）：栈上一次编码三视图
│   memtable_key()（varint 前缀）/internal_key()/user_key()（200B 内免堆分配）
├─ sv->mem->Get（memtable.cc:1356）：先 MaxCoveringTombstoneSeqnum
│   再跳表直查（构造时 key-compare 回调，不建迭代器）
├─ sv->imm->Get 逐个 immutable
└─ sv->current->Get（version_set.cc:2379）
    ├─ GetContext 状态机（kNotFound/kFound/kDeleted/kMerge...）
    ├─ 有 merge operator 时 pinned_iters_mgr->StartPinning（:2421）
    ├─ FilePicker（:2425）按层挑候选：L0 按 largest_seqno 新→旧、
    │   L1+ 经 FileIndexer 二分跳过无关层
    ├─ 每候选文件 TableCache::Get（table_cache.cc:430）
    │   → FindTable → t->Get → 块内 Seek 到 (user_key, snapshot_seq,
    │     kValueTypeForSeek)——首个命中必是最新可见版本
    │   → GetContext::SaveValue 裁决：
    │       seq 不可见 → 继续更老版本
    │       Put 系 → kFound
    │       Delete → kDeleted，Version::Get 直接 return NotFound
    │                （内部序下这条已是最新可见版本，老层无需再看）
    │       Merge → kMerge，继续向更老文件收 operand
    └─ 循环外 kMerge → MergeHelper::TimedFullMerge（:2558）

扫描 NewIterator（db_impl.cc:3798）
└─ NewInternalIterator（:2046）
    MergeIteratorBuilder 依次 AddPointAndTombstoneIterator：
    active memtable → imm 队列 → L0 每文件 → L1+ 每层 LevelIterator
    → RegisterCleanup(CleanupSuperVersionHandle)（:2106）
    （SuperVersion 引用计数挂在迭代器生命周期上）
MergingIterator::Seek（merging_iterator.cc:313）→ SeekImpl（:766）
    逐层 Seek + cascading seek（改自 CockroachDB Pebble：
    某层 tombstone 覆盖 target 时把搜索键推进到 tombstone end）
    → FindNextVisibleKey（:1619）弹出被覆盖的堆顶
DBIter::Next → FindNextUserEntryInternal（db_iter.cc:345）
    IsVisible(seq) 过滤 → Delete 置 skipping → Put 存 saved_key 返回
    Merge → MergeValuesNewToOld（:605）从新到老收 operand 链
```

## 核心实现

### 为什么 point read 逐层手写而不用 MergingIterator

直查只需 O(1) 跳表定位 + FilePicker 挑中的少数 SST seek；MergingIterator 要求**所有** child（memtable + 每个 imm + L0 每文件 + 每层）先 Seek 再建堆——成本 O(levels + L0 文件数) 次 seek，而 FileIndexer + bloom 能整层整文件剪掉，大多数 Get 只碰 1-2 个文件。且**提前终止**是点查的灵魂：kFound/kDeleted/`max_covering_tombstone_seq` 立刻返回；堆必须持续维持全局有序没有对应表达。

### 相同 user key 时谁胜出：排序规则的必然

不是靠额外机制，而是 `InternalKeyComparator::Compare`（`dbformat.cc`）：**user key 升序、seq 降序、type 降序**。min-heap 中同 user key 的 `(user_key, max_seq, max_type)` 排最小最先出堆——最新版本天然排最前。MergingIterator 只管按序吐出（`merging_iterator.h:31` 明确不做去重），DBIter 按 user key 跳过余下旧版本。seek 端同样利用此序：目标键取 `(user_key, snapshot_seq, kValueTypeForSeek)`（type 取最大值，`dbformat.cc:28`）保证落在"最新可见版本"上。附带优化 `is_key_seqnum_zero_`（`db_iter.cc:383`）：bottommost compaction 把唯一版本 seq 归零，seq==0 意味着后面必是别的 user key，可省比较。

### MergingIterator 的堆与 range tombstone

```cpp title="table/merging_iterator.cc:489（节选）"
struct HeapItem {
  IteratorWrapper iter;
  size_t level;                        // 层级索引（越小越新——SkipNextDeleted 用它判新旧）
  ParsedInternalKey tombstone_pik;
  enum class Type { ITERATOR, DELETE_RANGE_START, DELETE_RANGE_END };
  Type type;
};
```

range tombstone 的 start/end key **伪装成 HeapItem 塞进同一个堆**——删除范围与点键在全局序里统一比较。`SkipNextDeleted` 用 `i < current->level` 判断 tombstone 是否来自更新层（`:1028`）。`LevelIterator` 的文件边界以 sentinel key 表示（`IsDeleteRangeSentinelKey` 分支）——与 tombstone end key 的堆内交错（`:958-1020`）是最容易踩坑的分支。

### DBIter 的 ReSeek 优化

同 user key 连续跳过超过 `max_sequential_skip_in_iterations` 时改用 seek（`db_iter.cc:539-580`）：`skipping_saved_key` 场景 seek 到 `(user_key, 0, kTypeDeletion)`（该 user key 所有版本的末尾）；不可见版本堆积场景 seek 到 `(user_key, sequence_, kValueTypeForSeek)`；`reseek_done` 限一次防死循环。

### PinnedIteratorsManager：三种 pin 时机

迭代器契约要求 `key()/value()` 的 Slice 在下一次 `Next()` 前有效，而 value 指向的块住在 block cache——不 pin 的话换块时旧块引用释放，cache 一踢、内存复用，value 悬垂。(a) **迭代器生命周期 pin**：`ReadOptions::pin_data=true` → DBIter 构造即 `StartPinning`，`BlockBasedTableIterator::ResetDataBlock` 换块时 `DelegateCleanupsTo(pinned_iters_mgr_)`——块活到迭代器析构，顺带使零拷贝 value 成为可能；(b) **临时 pin**：`MergeValuesNewToOld` 收 operand 时 TempPinData，Next/Seek 开头释放；(c) **point read pin**：GetImpl 栈上声明 manager 传入 Version::Get，保证 Get 返回后 merge operand 仍可读。

### TableCache：charge=1 的文件数缓存

`FindTable`（`table_cache.cc:186-216`）双检锁 + 分段锁：Lookup miss → `loader_mutex_.Get(key)` 条带锁 → 二次 Lookup → open → Insert（**charge=1**）——cache 容量语义是"打开文件数"而非字节数（对应 `max_open_files`）；`immortal_tables_`（max_open_files=-1）时 reader 永驻可走 mmap 快路径；错误结果不缓存（transient error 可自愈）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 组合 | MergingIterator 组合任意 InternalIterator | 层来源无关的统一堆 |
| 方向反转 | MinHeapItemComparator vs MaxHeapItemComparator；kValueTypeForSeek vs ForPrev | 同一组 children 支持双向扫描 |
| Builder | `MergeIteratorBuilder`（`:1665`）处理单 child 直通、tombstone 对齐、指针延迟回填 | 装配的三个微妙点各自收敛 |
| Cleanable 责任链 | SuperVersion 引用、cache handle、block 引用全部收敛到"迭代器析构" | 三个生命周期一个事件 |
| Arena 池化 + 访问序布局 | 整棵迭代树从同一 Arena 按访问顺序分配（`db_impl.cc:3894` ASCII 图） | cache locality |

## 模块间交互

**memtable**：点查走跳表直查（带 MaxCoveringTombstoneSeqnum 协同）；扫描走 `AddIterators`，tombstone 以 `TruncatedRangeDelIterator` 进堆。**table reader**：`TableCache::NewIterator/Get`；附带 row cache 读写（replay log 机制）。**snapshot**：seq 贯穿三层（GetImpl 决定 → LookupKey 编码 → SaveValue/IsVisible 过滤）；`ArenaWrappedDBIter::Refresh` 支持扫描中途换 SuperVersion。**compaction/flush**：迭代器析构时 `CleanupSuperVersionHandle` Unref，必要时触发 obsolete 清理。

## 扩展方式

**新增 value type**：五处同步——`ValueType` 枚举（`dbformat.h:41`）、`DBIter::FindNextUserEntryInternal` 的 switch（`db_iter.cc:433`）、`MergeValuesNewToOld`（`:646`）、`GetContext::SaveValue` 的 switch、**`kValueTypeForSeek` 是否要更新为新的最大 type 值**（`dbformat.cc:28`）——漏最后一处会破坏 seek 落点正确性。

**调整 merge 语义**：必须同时动两条路径保持一致——scan 的 `MergeValuesNewToOld` 与 point 的 `SaveValue` + `TimedFullMerge`；现成先例 `read_options.merge_operand_count_threshold`。

**MergingIterator 堆改动**：`SeekImpl`/`SkipNextDeleted` 的 range tombstone 逻辑——文件头注释的不变式 (1)-(4)（`merging_iterator.cc:31-48`）与 `SeekImpl` 的完整证明（`:693-765`）是验收基准。
