---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "存储引擎"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "olap", "Tablet", "Rowset", "alpha", "beta", "Segment", "Compaction"]
description: "Doris 1.1.5 存储引擎 olap：StorageEngine 单例、Tablet/Rowset(alpha+beta 迁移期)/Segment 列存、两级 Compaction(Cumulative+Base)、stale rowset 延迟删除、多级索引。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

`be/src/olap/`（~7.7 万行，319 文件）是 BE 的存储引擎：`Tablet`（数据分片）→ `Rowset`（不可变版本集）→ `Segment`（列存段）→ `Page`（编码页）。1.1.5 处于 rowset 迁移期——`olap/rowset/` 同时保留 `alpha_rowset`（旧 SegmentGroup 格式）与 `beta_rowset`（segment_v2 列存），FE 可经心跳动态切默认类型。存储模型有 Duplicate/Unique/Aggregate 三种 `keys_type`，两级 Compaction，stale rowset 延迟删除的 MoW 变体。

## 模块架构

```
StorageEngine (olap/storage_engine.h) ── 全局单例 (_s_instance, instance():77)
   ├─ TabletManager* _tablet_manager ── 分片锁管理 (shard 锁降竞争)
   ├─ TxnManager* _txn_manager
   ├─ ThreadPool _base_compaction / _cumu_compaction / _quick_compaction
   ├─ _alpha_rowset_scan_thread + _convert_rowset_thread_pool ── alpha→beta 后台转换
   ├─ default_rowset_type() ── 受 HeartbeatFlags::is_set_default_rowset_type_to_beta 动态切
   └─ submit_compaction_task / create_cumulative/base_compaction
       │
       ▼
TabletManager (olap/tablet_manager.h) ── _tablets_shards_size/mask 分桶锁
   └─ create_tablet / get_tablet / find_best_tablet_to_compaction (按 score)
       │
       ▼
Tablet final (olap/tablet.h) extends BaseTablet
   ├─ _rs_version_map (:692) ── 活跃版本链 Version→Rowset
   ├─ _stale_rs_version_map (:692) ── 过期版本链 (Compaction 替换, 延迟删)
   ├─ TimestampedVersionTracker (:673) ── VersionGraph 路径查找
   ├─ _cumulative_point (atomic, :340) ── Cumulative/Base 分界
   ├─ 4 锁: _meta_lock/_ingest_lock/_base_lock/_cumulative_lock
   ├─ add_rowset (:165) / modify_rowsets (:169) / capture_rs_readers (:202)
   ├─ pick_candidate_rowsets_to_cumulative/base_compaction
   ├─ calc_compaction_score (:226) / all_beta / find_alpha_rowsets (:277)
   │
   ▼
Rowset (olap/rowset/rowset.h:108) enable_shared_from_this
   ├─ RowsetStateMachine (:58) ── UNLOADED→LOADED→UNLOADING→UNLOADED
   ├─ create_reader (abstract) / _refs_by_reader (引用计数)
   ├─ AlphaRowset (alpha_rowset.h:38) ── 旧 _segment_groups, convert_from/to_old_files
   └─ BetaRowset (beta_rowset.h:36) ── segment_v2, load_segments, do_load 空(延迟)
       │  工厂: RowsetFactory::create_rowset (rowset_factory.cpp:31) 按 rowset_type
       │
       ▼
Segment (olap/rowset/segment_v2/segment.h) ── 列式段
   ├─ open() / new_iterator / new_column_iterator
   ├─ _footer (SegmentFooterPB) / _column_readers (每列一个) / _sk_index_decoder
   └─ SegmentWriter (segment_writer.h:82)
        └─ finalize (:118): _write_data/_write_ordinal_index/_write_zone_map/
           _write_bitmap_index/_write_bloom_filter_index/_write_short_key_index/_write_footer
```

## 调用链路

写入路径：

```
DeltaWriter::open()                       [olap/delta_writer.cpp:34]
  → RowsetFactory::create_rowset_writer() [rowset_factory.cpp:44] → BetaRowsetWriter
DeltaWriter::write(tuple) (:159) → MemTable::insert
  → [满] flush → MemTableFlushExecutor → BetaRowsetWriter::flush_single_memtable (:140)
    → SegmentWriter::append_row → finalize (:69) ── 写列存 Page + 多级索引
DeltaWriter::close_wait (:288) → BetaRowsetWriter::build → Tablet::add_inc_rowset (:390)
```

读取路径：

```
OlapScanNode → TabletManager::get_tablet → Tablet::capture_rs_readers(spec_version) (:662)
  → capture_consistent_versions → VersionGraph 路径查找 → rowset->create_reader
    → BetaRowset::load_segments → Segment::open (segment_v2/segment.h:62)
  → Segment::new_iterator → SegmentIterator (_init: segment_iterator.cpp:145)
    → _init_return_column_iterators (只初始化查询列)
    → _get_row_ranges_by_keys (短键索引过滤)
    → _get_row_ranges_by_column_conditions (zone_map/bloom_filter 过滤)
    → _vec_init_lazy_materialization (延迟物化)
    → next_batch(Block*) (:511) → ColumnIterator::seek_to_ordinal/next_batch → PageDecoder::decode
```

Compaction：

```
StorageEngine::start_bg_threads → _compaction_tasks_producer_callback (olap_server.cpp:422)
  → N 轮 cumulative + 1 轮 base (cumulative_compaction_rounds_for_each_base_compaction_round)
  → _generate_compaction_tasks → find_best_tablet_to_compaction (按 score)
  → Tablet::execute_compaction → create_cumulative/base_compaction
CumulativeCompaction::compact (compaction.h:52)
  → prepare_compact (cumulative_compaction.cpp:33): 获 _cumulative_lock, calculate_cumulative_point, pick_rowsets (policy->pick_candidate)
  → execute_compact_impl (:60): do_compaction_impl (compaction.cpp:126)
    → construct_output_rowset_writer (RowsetFactory) + construct_input_rowset_readers
    → Merger::merge_rowsets → _output_rs_writer->build → check_correctness (行数校验)
    → modify_rowsets (compaction.cpp:254): Tablet::modify_rowsets (原子替换, 旧入 stale)
    → policy->update_cumulative_point
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `StorageEngine.default_rowset_type` | 默认 rowset 类型 | 受 HeartbeatFlags 动态切 alpha/beta |
| `Tablet.add_rowset` | 加入版本链 | 不可变 Rowset，无锁读 |
| `Tablet.modify_rowsets` | Compaction 替换 | 旧 Rowset 入 stale map 延迟删 |
| `Tablet.capture_rs_readers` | 一致快照读 | VersionGraph 找连续版本路径 |
| `Tablet.calc_compaction_score` | Compaction 评分 | 按 score 选候选 tablet |
| `SegmentWriter.finalize` | 写 segment | 列存 Page + 多级索引 |
| `RowsetFactory.create_rowset` | 创建 rowset | 按 rowset_type 工厂分派 alpha/beta |

</details>

## 核心实现

### alpha vs beta rowset 迁移

`AlphaRowset`（`alpha_rowset.h:38`）用旧 `SegmentGroup`；`BetaRowset`（`beta_rowset.h:36`）用 segment_v2 列存，`do_load` 空实现延迟到 `load_segments`。`_parse_default_rowset_type`（`storage_engine.cpp:879`）若配 "ALPHA" 打 WARNING "alpha is not supported any more"，`default_rowset_type()`（`:159`）受 `HeartbeatFlags` 动态切。`_alpha_rowset_scan_thread`+`_convert_rowset_thread_pool`（`:379`）后台 alpha→beta 转换，`Tablet::find_alpha_rowsets`（`:277`）发现待转换 tablet。**为什么**：segment_v2 支持更丰富编码（dict/plain/bitshuffle/FOR/RLE）与索引（zone_map/bitmap/bloom_filter/short_key），压缩率与查询性能更优。

### Segment 列存

`Segment` 内部按列组织：`SegmentWriter` 持 `_column_writers`（每列一个），`Segment` 持 `_column_readers`。**为什么列存**：分析查询只读所需列（`_init_return_column_iterators` 只初始化查询列）减少 I/O；同列类型一致可列级编码（`EncodingInfo`）+ 压缩；支持列级索引（zone_map/bloom/bitmap）；延迟物化（`_vec_init_lazy_materialization`）先索引过滤 row range 再读数据列减少无谓 I/O。

### 两级 Compaction

`_cumulative_point`（`tablet.h:340`）将 rowset 分两部分：以下→Base 候选，以上→Cumulative 候选。`_compaction_tasks_producer_callback`（`olap_server.cpp:422`）以 N 轮 cumu + 1 轮 base 比例轮询。两种策略：`NumBasedCumulativeCompactionPolicy`（每 rowset compact 一次即升级，简单但写放大高）与 `SizeBasedCumulativeCompactionPolicy`（按 2 幂分大小层级，同层 compact，超 promotion_ratio 才升级，降写放大 trade 读放大）。**为什么两级**：读写放大平衡——cumu 高频小合并减少读时 rowset 数，base 低频大合并减少读放大。

### MoW 变体 + stale rowset 延迟删除

写入 `add_inc_rowset`（`tablet.cpp:390`）直接可见不 merge；读取多版本合并（`capture_rs_readers` 返回多 reader 由上层 merge）；Compaction 物理合并 `Merger::merge_rowsets`；旧 rowset 入 `_stale_rs_version_map`（`:328`）不立即删，`delete_expired_stale_rowset`（`:416`）按时间清理，保证进行中查询仍能读旧版；`modify_rowsets`（`:253`）原子替换（先删 to_delete 再加 to_add）。**为什么**：写入不阻塞读、吞吐高；查询只看一致版本快照。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例 | `StorageEngine::_s_instance` in `storage_engine.h:327` | 全局唯一，`instance()` 获取 |
| 策略 | `Rowset`→`AlphaRowset`/`BetaRowset`；`CumulativeCompactionPolicy`→`NumBased`/`SizeBased` in `cumulative_compaction_policy.h:50,122,170` | 两代 rowset/两种 compaction 策略可互换 |
| 工厂 | `RowsetFactory::create_rowset` in `rowset_factory.cpp:31`；`CumulativeCompactionPolicyFactory` in `:248` | 按 type 实例化，隐藏构造 |
| 状态机 | `RowsetStateMachine` in `rowset/rowset.h:58` | UNLOADED→LOADED→UNLOADING→UNLOADED，引用计数驱动 |
| 模板方法 | `Compaction::compact` in `compaction.cpp:51` | 骨架 prepare→execute，子类实现 pick/execute_impl |

## 模块间交互

被 `exec/olap_scan_node`（scan）、`vec/olap/block_reader.cpp`（向量化读）、`agent/`（create_tablet/clone 任务）调用，`runtime/load` `DeltaWriter`（写入）。依赖 `runtime`（Block/Column/Tuple/TupleRow）、`io`/`fs`（BlockManager）、`util`（MemTracker/ThreadPool/Cache）。

## 扩展方式

**新增列编码**（如 Delta）：`segment_v2/encoding_info.h/cpp` 注册 `EncodingTypePB::DELTA` 到 `_encoding_info_map`；新增 `DeltaPageDecoder`（`page_decoder.h`）+ `DeltaPageBuilder`（`page_builder.h`）；`column_writer.cpp` `init` 按 encoding 创建 builder，`column_reader.cpp` `init` 创建 decoder。**修改 Compaction 触发**：`cumulative_compaction_policy.h` 新增策略子类实现 `pick_input_rowsets`/`calc_cumulative_compaction_score`；`CumulativeCompactionPolicyFactory::create` 注册；`olap_server.cpp:422` 调度比例。**新增行数校验**：`compaction.cpp:314` `check_correctness` 增列级校验。
