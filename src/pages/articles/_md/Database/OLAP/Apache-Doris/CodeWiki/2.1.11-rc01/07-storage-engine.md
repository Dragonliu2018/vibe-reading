---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "存储引擎"
date: "2026-08-23T20:04:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.11-rc01"]
tags: ["Apache Doris", "olap", "Tablet", "Rowset", "Segment", "Compaction", "MoW", "DeleteBitmap"]
description: "Doris 2.1.11 存储引擎 olap：Tablet/Rowset/Segment 不可变列存 + 三级 Compaction + MoW DeleteBitmap + 多级索引。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.11-rc01/00-overview)

---

## 模块定位

存储引擎是 `be/src/olap/`（~9.2 万行，320 文件），2.1 仍用 `olap/` 旧命名（4.x 起更名 `storage/`）。它负责数据持久化：`Tablet`（数据分片）→ `Rowset`（不可变版本集）→ `Segment`（列存段）→ `Page`（编码页）。独立成文是因为列存与副本是 BE 的核心资产，存储模型（Duplicate/Unique/Aggregate 三种 keys_type）、Compaction、MoW（Merge-on-Write）构成独立决策域，与执行引擎正交。

## 模块架构

```
StorageEngine (olap/storage_engine.h:83) ── 全局单例
   ├─ TabletManager* _tablet_manager  ── Tablet 增删查 + Compaction 候选
   ├─ TxnManager* _txn_manager
   ├─ ThreadPool _base_compaction / _cumu_compaction / _single_replica_compaction
   ├─ MemTableFlushExecutor / CalcDeleteBitmapExecutor
   └─ _tablet_submitted_cumu/base_compaction  ── Compaction Registry
   │
   ▼
TabletManager (olap/tablet_manager.h:48)
   └─ create_tablet / drop_tablet / get_tablet
      └─ find_best_tablets_to_compaction()  ── 按 score 选候选
   │
   ▼
Tablet final (olap/tablet.h:73) extends BaseTablet
   ├─ _rs_version_map (:702)           ── 活跃版本链 Version→Rowset
   ├─ _stale_rs_version_map (:706)     ── 过期版本链（Compaction 替换）
   ├─ TimestampedVersionTracker (:681) ── VersionGraph 路径查找
   ├─ _cumulative_point (:723)         ── Cumulative/Base 分界点
   ├─ _delete_bitmap                    ── MoW 标记被覆盖行
   ├─ add_rowset / modify_rowsets / capture_consistent_rowsets
   └─ calc_compaction_score / pick_candidate_rowsets_to_*
   │
   ▼
Rowset (olap/rowset/rowset.h:119) ── enable_shared_from_this
   ├─ BetaRowset final (olap/rowset/beta_rowset.h:58) ── segment_v2 实现
   ├─ keys_type() (:170)               ── Duplicate/Unique/Aggregate
   └─ RowsetStateMachine (:67)
        │
        ▼
Segment (olap/rowset/segment_v2/segment.h:82) ── 列式段
   ├─ ColumnIterator 逐列读取
   ├─ ShortKeyIndex / ZoneMapIndex / BloomFilter / PrimaryKeyIndex / OrdinalIndex
   └─ BitmapIndex / InvertedIndex
```

## 调用链路

写入路径（导入）：

```
FE 下发 load 任务 → BE LoadChannel/TabletsChannel 接收
  → TabletsChannel::open() [runtime/tablets_channel.h:83]
    → _open_all_writers() 创建 DeltaWriter [olap/delta_writer.h:120]
      → RowsetBuilder::init() [olap/rowset_builder.cpp:187]
        → Tablet::create_rowset_writer()
  → DeltaWriter::write(block) [olap/delta_writer.cpp:120]
    → MemTableWriter::write(block)  ── 写 MemTable（SkipList/SortBuffer）
    → [满] flush → MemTableFlushExecutor 异步刷盘
  → DeltaWriter::build_rowset() [:159]
    → BaseRowsetBuilder::build_rowset() [olap/rowset_builder.cpp:243]
      → BetaRowsetWriter::flush_single_block(block) → SegmentWriter::append_block()
        → SegmentWriter::finalize() [segment_v2/segment_writer.h:119]
          → _write_data / _write_ordinal_index / _write_zone_map
          → _write_short_key_index / _write_bloom_filter_index
          → _write_primary_key_index / _write_footer()
  → [MoW] submit_calc_delete_bitmap_task() [rowset_builder.cpp:254]
    → Tablet::calc_delete_bitmap()  ── 计算被覆盖行
  → [FE publish] Rowset::make_visible(version) [olap/rowset/rowset.cpp:83]
    → Tablet::add_rowset()  ── 加入 _rs_version_map
```

查询读取路径：

```
TabletReader (olap/tablet_reader.h:81)
  → BlockReader (vec/olap/block_reader.h:43)
    → Tablet::capture_rs_readers(spec_version, rs_splits, ...) (tablet.h)
      → capture_consistent_versions() → VersionGraph 路径查找
      → _rs_version_map 遍历 → Rowset::create_reader()
        → BetaRowsetReader → Segment::open() 加载 segment
    → VCollectIterator 管理多 RowsetReader 归并
      → Segment::new_iterator(schema, read_options, iter) [segment_v2/segment.h]
        → ColumnIterator 逐列读取
        → ShortKey/ZoneMap/BloomFilter 谓词过滤
    → BlockReader::next_block(block)  ── 向量化输出
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `StorageEngine.create_tablet` | 创建 Tablet | 下发 BE，分配 Replica |
| `Tablet.add_rowset` | 加入版本链 | 不可变 Rowset，无锁读 |
| `Tablet.modify_rowsets` | Compaction 替换 | 旧 Rowset 移入 stale map 延迟删除 |
| `Tablet.capture_consistent_rowsets` | 一致快照读取 | VersionGraph 找连续版本路径 |
| `Tablet.calc_compaction_score` | Compaction 评分 | 按 score 选候选 tablet |
| `SegmentWriter.finalize` | 写 segment | 多级索引 + 列存 Page |
| `Tablet.calc_delete_bitmap` | MoW 标记 | 写入时算被覆盖行，读时跳过 |

</details>

## 核心实现

### 不可变 Rowset + Compaction（LSM 变体）

`Rowset` 一旦写入即不可变——`make_visible()`（`rowset.cpp:83`）仅修改状态标志。`_rs_version_map`（`tablet.h:702`）存活跃版本链，`_stale_rs_version_map`（`:706`）存被 Compaction 替换但未物理删除的旧版本，`delete_expired_stale_rowset()`（`:189`）定期清理。

三级 Compaction（均继承 `Compaction` in `compaction.h:50`）：
- **CumulativeCompaction**（`cumulative_compaction.h:34`）：合并 `_cumulative_point` 之后的连续小 rowset，策略委托 `CumulativeCompactionPolicy`（支持 `CUMULATIVE_TIME_SERIES_POLICY`）
- **BaseCompaction**（`base_compaction.h:38`）：合并 base + cumulative，三条件触发（rowset 数量/大小比/时间间隔，`base_compaction.cpp:169-215`）
- **FullCompaction**（`full_compaction.h:33`）：全量合并 + 重算 DeleteBitmap

与标准 LSM 区别：Doris 不用多层（L0/L1/L2），用 `_cumulative_point`（`tablet.h:723`）逻辑分界——简化版 LSM，按需触发。

### MoW vs MoR

仅在 Unique 模型下生效，由 `TabletMeta::_enable_unique_key_merge_on_write`（`tablet_meta.h:323`）控制：
- **MoW**：写入时 `DeltaWriter::submit_calc_delete_bitmap_task()`（`delta_writer.cpp:169`）调 `Tablet::calc_delete_bitmap()` 计算被覆盖 rowid，`DeleteBitmap` 结构 `std::map<BitmapKey, roaring::Roaring>`（`tablet_meta.h:380`），BitmapKey = `(RowsetId, SegmentId, Version)`。读时直接跳过被标记行，**无需多版本归并**。
- **MoR**：写入轻量直接追加，读时 `VCollectIterator`（`vec/olap/vcollect_iterator.h`）多路归并去重，读放大大。

取舍：MoW 以写放大换读性能（推荐配置），MoR 以读放大换写性能。

### 多级索引

`SegmentWriter`（`olap/rowset/segment_v2/segment_writer.h:82`）在 `finalize()` 写入：
1. **Short Key Index**（`_write_short_key_index` `:152`）：前 N 列按 block 粒度，快速定位 key 范围
2. **ZoneMap Index**（`_write_zone_map` `:148`）：每列每 block min/max，谓词跳过
3. **Bloom Filter Index**（`_write_bloom_filter_index` `:151`）：等值/IN 高选择性过滤
4. **Primary Key Index**（`_write_primary_key_index` `:153`，仅 Unique）：支持 `Segment::lookup_row_key()` 点查
5. **Ordinal Index**（`_write_ordinal_index` `:147`）：列数据页索引
6. **Bitmap Index / Inverted Index**（`:149`/`:150`）：枚举列 / 全文检索

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| MergeTree 变体 | `KeysType` in `gensrc/proto/olap_file.proto:144` | Duplicate/Unique/Aggregate 三种表模型 |
| MoW/MoR | `_enable_unique_key_merge_on_write` in `tablet_meta.h:323` | 写时合并 vs 读时合并，写读放大取舍 |
| Version 链 | `_rs_version_map`/`_stale_rs_version_map` in `tablet.h:702/706` | 不可变 Rowset + MVCC，Compaction 延迟删除 |
| 三级 Compaction | `CumulativeCompaction`/`BaseCompaction`/`FullCompaction` | 简化版 LSM，按需触发减少读放大 |

## 模块间交互

`olap` 被 `vec/` 读取（`vec/olap/block_reader.cpp`、`vcollect_iterator.cpp`）、通过 `runtime` `TabletsChannel` 接收 FE 下发写入任务（`delta_writer.h:120`、`rowset_builder.h:122`）、被 `pipeline/exec/` ScanOperator 调用。Compaction 调用 `Merger::vmerge_rowsets()`（`olap/merger.h:46`）。SchemaChange 调用 RowsetReader/Writer（`schema_change.h:235`）。

## 扩展方式

**新增一种表模型**：在 `gensrc/proto/olap_file.proto:144` 的 `KeysType` 枚举新增值；在 `olap/tablet_schema.h:492` 的 `_keys_type` 处理；在 `segment_v2/segment_writer.h:132` 的 `is_unique_key()` 类似判断新增索引逻辑；在 `vec/olap/block_reader.h:115` 的 `_next_block_func` 函数指针新增聚合/去重策略；在 `olap/compaction.cpp:983` 的 `modify_rowsets()` DeleteBitmap 处理适配。对应测试：`be/test/olap/`、`regression-test/suites/`。
