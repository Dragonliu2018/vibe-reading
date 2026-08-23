---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "存储引擎"
date: "2026-08-23T18:32:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "Tablet", "Rowset", "Segment", "Compaction", "MergeTree"]
description: "Doris 存储引擎：Tablet/Rowset/Segment 列存段 + MergeTree 变体 + MVCC 版本图 + Compaction 合并。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

存储引擎（`be/src/storage/`，~14.7 万行 C++）是 Doris BE 的数据持久层。它管理 Tablet（数据分片）下的 Rowset（不可变版本数据集）、Segment（列存段），通过 MemTable 写入、Compaction 合并、VersionGraph 实现 MVCC。独立成文是因为段存储 + 版本管理 + 合并策略是独立于执行引擎的存储域——它回答"数据怎么落盘、怎么读出一致快照、怎么合并优化"。

## 模块架构

模块以 `BaseStorageEngine`/`StorageEngine` 为入口，下分 Tablet/Rowset/Segment/Compaction/SchemaChange 等子体系。`BaseStorageEngine` 区分 LOCAL/CLOUD 模式，`StorageEngine` 是本地模式实现。

```
BaseStorageEngine (抽象, Type: LOCAL/CLOUD)
  └─ StorageEngine (本地)
       ├─ TabletManager (管理所有 Tablet)
       ├─ TxnManager (导入事务)
       ├─ DataDir (磁盘路径管理)
       └─ 后台线程: compaction_producer / unused_rowset_monitor / garbage_sweeper

Tablet ── _rs_version_map (Version→Rowset) + _stale_rs_version_map
  └─ Rowset (不可变, 状态机 UNLOADED↔LOADED↔UNLOADING)
       └─ Segment (列存段, .dat 文件)
            ├─ ShortKeyIndex (前缀索引)
            ├─ PrimaryKeyIndex (主键索引)
            └─ ColumnReader (每列)

Compaction ── CumulativeCompaction / BaseCompaction / FullCompaction
MemTable ── ACTIVE→WRITE_FINISHED→FLUSH (排序+聚合后 flush)
```

## 调用链路

写入路径（Load → MemTable → flush Rowset → Segment）：

```
FE 发起 Load
  → BE: DeltaWriter::write (load/delta_writer/)
    → MemTableWriter::write → MemTable::insert(block, row_idxs) (memtable.cpp:197)
      → _input_mutable_block 合并行
    → if need_flush: MemTableWriter::_flush_memtable_async (memtable_writer.cpp:154)
      → FlushToken::_flush_memtable
        → MemTable::to_block (排序+聚合) (memtable.cpp)
        → RowsetWriter::flush_memtable(block, segment_id) (rowset_writer.h:133)
          → BetaRowsetWriterV2::flush_memtable → SegmentWriter::write_block → 生成 .dat
    → MemTableWriter::close → FlushToken::wait → RowsetWriter::build(rowset)
    → publish: Rowset::make_visible(version) → Tablet::add_inc_rowset (tablet.cpp:692)
      → _rs_version_map[version] = rowset + TimestampedVersionTracker.add_version
```

查询路径（Scan → 选 Rowset 版本 → 读 Segment 列）：

```
FE 下发 Scan
  → BE: OlapScanner (exec/scan/)
    → Tablet::capture_rs_readers(spec_version, &rs_splits) (tablet.cpp:959)
      → BaseTablet::capture_rs_readers_unlocked
        → VersionGraph::capture_consistent_versions(spec_version, &version_path)
          // 邻接矩阵版本图找覆盖 spec_version 的最短路径
        → for version in version_path: _rs_version_map[version]->create_reader
    → BetaRowsetReader::next_block
      → Segment::open (或从 SegmentCache) + new_iterator
        → load ShortKeyIndex / PrimaryKeyIndex + ColumnReader→ColumnIterator
      → SegmentIterator::next → 按列读 ColumnPage → 解码 → Block
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `StorageEngine::open` | 启动存储引擎 | 加载 DataDir/恢复 Tablet/起后台线程 |
| `Tablet::add_inc_rowset` | 新增可见版本 | `_rs_version_map[version]=rowset` |
| `Tablet::capture_rs_readers` | 查询选版本 | VersionGraph 最短路径 |
| `Rowset::make_visible` | publish 设版本号 | pending→visible |
| `Rowset::create_reader` | 创建 reader | 状态机 UNLOADED→LOADED |
| `Segment::open` | 打开列存段 | 加载 footer/索引 |
| `Compaction::prepare_compact` | 选 rowset | 策略 pick_input_rowsets |
| `Compaction::execute_compact` | 执行合并 | merge_rowsets + modify_rowsets |

</details>

## 核心实现

### MergeTree 段存储 vs LSM

Doris 的存储模型更接近 **ClickHouse MergeTree** 而非标准 LSM-Tree：无 Level 概念，Rowset 按版本号顺序排列，Compaction 的 Cumulative/Base 分界由 `_cumulative_point`（`tablet.h:584` 的 `std::atomic<int64_t>`）决定而非固定大小阈值；无 WAL，写入通过事务机制（`TxnManager`）保证可靠性，导入 publish 前 Rowset 为 pending（`Rowset::_is_pending`），publish 后才可见；排序在 MemTable（`MemTable::_sort`）和 Compaction（`Merger::merge_rowsets`）都做。

### Rowset 不可变 + Compaction

Rowset 一旦创建即不可变（`Rowset` 类只有 `load`/`create_reader`/`remove`）。更新和删除通过**新写 Rowset + Compaction 合并**实现。三种模型：**Duplicate**（追加，Compaction 仅物理合并）、**Aggregate**（MemTable 中聚合同 key，Compaction 归并聚合）、**Unique** 的 **MoW**（导入时算 `DeleteBitmap` 标记旧版本行被覆盖，查询跳过标记行，Compaction 物理删除）与 **MoR**（保留多版本，查询归并取最新，Compaction 物理合并）。

```cpp title="storage/tablet/tablet.h (MoW)"
Status save_delete_bitmap(const TabletTxnInfo* txn_info, int64_t txn_id,
                          DeleteBitmapPtr delete_bitmap, RowsetWriter* rowset_writer, ...);
// BitmapKey = (RowsetId, SegmentId, Version), 用 roaring::Roaring 标记删除行
```

为什么用不可变 Rowset：**读不加锁**（Segment 文件不可变可 mmap/缓存）、**Compaction 不阻塞写入**（新 Rowset 独立创建）、**崩溃恢复简单**（恢复 pending Rowset 或丢弃）。

### MVCC 版本图

每个 Rowset 有 `Version`（`start_version`~`end_version`），publish 时 `make_visible(version)` 设置。`_rs_version_map` 是 `Version → RowsetSharedPtr` 映射。`VersionGraph`（`storage/version_graph.h`）用邻接矩阵构建版本图，`capture_consistent_versions(spec_version)` 返回覆盖指定版本的最短路径。Compaction 后旧 Rowset 不立即删除，移入 `_stale_rs_version_map`，由 `delete_expired_stale_rowset` 延迟清理——保证正在进行的查询不受 Compaction 影响。Tablet 可见版本用 `atomic_shared_ptr<const VersionWithTime> _visible_version`（`tablet.h:623`）原子 CAS 单调递增，FE 同步 partition 的 visible version 到 BE。

### Compaction 体系

`Compaction`（`storage/compaction/compaction.h`）抽象基类有 `prepare_compact`（选 rowset）和 `execute_compact`（合并）。`CompactionMixin`（本地）的 `execute_compact` 走 `merge_input_rowsets`（`Merger::merge_rowsets` 多路归并）→ `modify_rowsets`（原子替换 input→output，旧 rowset 移入 stale）→ `update_delete_bitmap`（MoW 表）。三个子类：`CumulativeCompaction`（累积合并小 Rowset，`pick_rowsets_to_compact` 由 `CumulativeCompactionPolicy` 决定）、`BaseCompaction`（基线合并，推进累积区到基线区）、`FullCompaction`。`CloudCompactionMixin` 用于存算分离。

Compaction 由 `_compaction_tasks_producer_thread` 后台线程驱动：`_generate_compaction_tasks` → `CompactionSubmitRegistry::pick_topn_tablets_for_compaction`（按 `Tablet::calc_compaction_score` 选高分 tablet）→ `submit_compaction_task` → ThreadPool `_handle_compaction`。

### SchemaChange 三策略

`SchemaChange`（`storage/schema_change/schema_change.h:293`）有三种策略：**LinkedSchemaChange**（直接硬链接旧 Rowset 文件到新 Tablet，仅列元数据变化）、**VSchemaChangeDirectly**（直接转换 Block 格式写入新 Rowset，不做排序）、**VBaseSchemaChangeWithSorting/VLocalSchemaChangeWithSorting**（sorted-dump：读旧 Rowset→转换 Block→内存排序→超内存走 external sorting→写新 Rowset）。sorted-dump 的原因：SchemaChange 后新 Tablet 需保持排序键有序，但旧 Rowset 可能因列变更致排序键变化（如新排序键列），必须重排序。

### Segment 列存

`Segment`（`storage/segment/segment.h`）是不可变列存段，对应一个 `.dat` 文件。每列独立存储为 `ColumnPage`（多种编码：plain/dict/binary_prefix/bitshuffle），有 `ShortKeyIndex`（前缀索引，基于排序键的稀疏索引）、`PrimaryKeyIndex`（主键索引，B+Tree 或 Bloom Filter）、`InvertedIndex`（倒排索引）。列读取通过 `ColumnReader` → `ColumnIterator` 按需加载 Page。Segment 有状态机 `ROWSET_UNLOADED → ROWSET_LOADED → ROWSET_UNLOADING`（`RowsetStateMachine`），`DorisCallOnce` 保证 segment 元数据只加载一次。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| LSM 变体 | MemTable + Rowset + Compaction | 内存攒批+不可变段+后台合并 |
| MVCC | VersionGraph + Rowset 版本号 | 读不加锁，查询见一致快照 |
| 状态机 | `RowsetStateMachine` | UNLOADED↔LOADED，reader 引用计数 |
| 策略 | `CumulativeCompactionPolicy` 子类 | 可插拔 Compaction 选 rowset 策略 |
| 模板方法 | `Compaction::execute_compact` | 基类定骨架，子类填 prepare/modify |

## 模块间交互

被 `exec/`（`Tablet::capture_rs_readers` → `Segment::open/new_iterator` 读路径）、`load/`（`MemTableWriter`→`MemTable`→`RowsetWriter`→`Tablet::add_inc_rowset` 写路径）、`cloud/`（`CloudStorageEngine`→`CloudCompactionMixin`→`CloudTablet` 存算分离）、`io/fs/`（`Segment::_file_reader`→`io::FileReader`）、`runtime/`（`MemTracker`/`WorkloadGroup`）调用。`MemTable` 位于 `be/src/load/memtable/`（非 storage/ 目录）。

## 扩展方式

新增一种索引：`be/src/storage/tablet/tablet_schema.h` 加索引类型枚举；`segment.h` 加 `new_index_iterator` 分支 + `_open` 加载新索引；`be/src/storage/index/` 新增 IndexReader/IndexWriter/IndexIterator；`rowset_writer.h` 的 `create_index_file_writer` 支持新索引；`compaction.cpp` 加新索引 Compaction 逻辑；`beta_rowset_writer_v2.cpp` 写 Segment 时同步写新索引。

修改 Compaction 策略：新建 `CumulativeCompactionPolicy` 子类实现 `pick_input_rowsets`/`calc_cumulative_compaction_score`/`update_cumulative_point`；`tablet.cpp` 的 `_init_once_action` 通过 `_cumulative_compaction_type` 选策略；`storage_engine.cpp` 的 `_update_cumulative_compaction_policy` 注册策略名。
