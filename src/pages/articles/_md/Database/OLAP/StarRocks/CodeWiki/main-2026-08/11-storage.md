---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "Tablet 存储"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "Tablet", "Rowset", "Segment", "PrimaryIndex", "DelVector", "compaction"]
description: "StarRocks BE 存储引擎：Tablet/Rowset/Segment 分层、主键表 TabletUpdates 写路径、PersistentIndex、DelVector 与双策略 compaction。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`be/src/storage/`（17.5 万行，BE 最大包）+ `storage_primitive/`（1.7 万行谓词/编码原语层）。持久化域：Tablet 生命周期、不可变 Rowset、列存 Segment 格式、主键表的 LSM 风格 upsert（`tablet_updates.cpp` 28.2 万行，BE storage 最大单文件——这个数字本身就说明主键表写路径的复杂度）、compaction 与读路径。它独立成篇因为这是唯一"数据真正落盘"的模块。

> 实际布局提示：`storage/` 下**没有** `tablet/`、`primary_key/`、`rowset/segment_v2/` 子目录——`tablet.h`/`primary_index.h`/`persistent_index.h` 都在 storage 根目录，segment 格式代码在 `storage/rowset/` 下；`storage_primitive/` 含 `primary_key_encoder.cpp` 与 `edit_version.h`。

## 模块架构

```text
Tablet : BaseTablet                # 持 TabletMeta + rowset 列表，版本定位
  └─ TabletUpdates（主键表）       # 可变状态下放：EditVersionInfo 链 + apply/compaction
Rowset : BaseRowset                # 不可变数据版本单元（RowsetMeta + Segment 列表）
  └─ Segment                      # 列存文件（footer + 列 reader + 索引页）
PrimaryIndex                      # PK→rowid（HashIndex 或 PersistentIndex）
DelVector                         # (segment, version) → Roaring bitmap 逻辑删除
UpdateManager                     # 协调 apply 线程池与 delvec 存储（RocksDB KVStore）
```

非主键表的 Tablet 近只读（版本区间直接挂在 rowset meta 上）；主键表把所有可变状态下放给 `TabletUpdates`（`tablet_updates.h:108`）。

## 调用链路

### 存储分层与版本定位

- **Tablet**（`storage/tablet.h:84`）：`capture_consistent_rowsets(const Version&, ...)` 配合 `version_graph.cpp` 的版本图定位一致版本。
- **Rowset**（`rowset/rowset.h:143`）：聚合 `RowsetMetaSharedPtr`（版本区间 `[start_version, end_version]`、`num_segments`、KeysType）+ `std::vector<SegmentSharedPtr>`。**三态机** `RowsetStateMachine`（UNLOADED/LOADED/UNLOADING）+ `_refs_by_reader` 引用计数管理 segment 文件句柄懒加载/卸载——17.5 万行存储包的读路径不能常驻全部 footer 内存。转换规则：`on_load`（UNLOADED→LOADED）、`on_close`（refs==0 时直接→UNLOADED，否则→UNLOADING 等最后一个 reader 释放）、`on_release`（UNLOADING→UNLOADED，由释放回调完成）。PK 表 rowset 在 proto 里带 delete file/update file（`num_delete_files()`/`num_update_files()`，rowset.h:257-258）。
- **Segment**（`rowset/segment.h:85`）：`parse_segment_footer()` 解析 `SegmentFooterPB`（footer 在文件尾，带 `FooterPointerPB` 支持部分写入），按 unique_id 映射 `_column_readers`；列数据/索引页由 `rowset/column_reader.cpp`、`index_page.cpp`、各类 `*_page.cpp`（dict/plain/binary_prefix/bitshuffle/frame_of_reference）实现。footer field 11 是 full sort key index（segment.h:154-175，配套 `full_sort_key_codec.cpp`）。

### 主键表写路径（commit → apply → publish 生效）

```text
1. commit: rowset_commit(version, rowset, ...)（tablet_updates.h:157）
     追加 EditVersionInfo（version + rowsets/deltas/CompactionInfo）到 _edit_version_infos
     写 edit version log 持久化（_redo_edit_version_log 回放）
     ——版本是 (major, minor) 二元 EditVersion，非主键表是 int64 Version
2. apply（异步）: UpdateManager::apply_thread_pool() → do_apply() → _apply_rowset_commit()
     （tablet_updates.cpp:1306）
     RowsetUpdateState::load_upserts() 装载新 rowset 的 PK 列
     → PrimaryIndex::upsert(rssid, rowid_start, pks, &new_deletes, ...)（primary_index.h:74）
         把旧位置收集进 DeletesMap（rssid→rowids）
     → delete 文件走 PrimaryIndex::erase()（primary_index.cpp:1502）
     → 对每个受影响 segment 用 DelVector::add_dels_as_new_version()（del_vector.h:43）
         生成新版本 DelVec，经 UpdateManager::set_del_vec_in_meta() 存 RocksDB KVStore
3. 读时按读版本取 ≤version 的最新 DelVec 过滤
```

**DelVec 语义**：每个 (TabletSegmentId, version) 一个 Roaring bitmap 记录被逻辑删除的 rowid（del_vector.h:26-29），**segment 文件本身永不改写**——这是 COW 的 MVCC 基础。序列化格式为 1 字节 format version（当前 0x01）+ 序列化的 roaring bitmap（del_vector.h:29 的布局注释）；除 `add_dels_as_new_version`（快照式新增版本）外另有 `union_with(version, src)` 做原地 OR 合并（del_vector.h:59，immutable 场景），读取侧经 `DelvecLoader` 虚接口（del_vector.h:87）按 (TabletSegmentId, version) 加载。

### PrimaryIndex 双实现

`primary_index.h:38`：`upsert/erase/get/replace/try_replace` 语义齐全；`replace`/`try_replace` 专供 compaction publish 时把旧 rowid 原位改成新输出 segment rowid。底层两实现：

- 内存 `HashIndex`（`_pkey_to_rssid_rowid`）；
- **PersistentIndex**（`persistent_index.h:674`）：L0 `ShardByLengthMutableIndex`（按 key 长度分 shard 的 phmap + WAL，`CommitType::{kFlush,kSnapshot,kAppendWAL}`）+ L1/L2 不可变层（`_l1_vec/_l2_vec`，ImmutableIndex 的 shard/page/bucket 结构，`major_compaction()` 合并层级）。value 是 8 字节 `IndexValue`：高 32 位 rssid + 低 32 位 rowid（:118-126）。**动机**：把 PK→rowid 的巨型 hash map 落盘，避免 OOM 与重启全量重建。

### Compaction

- **非主键表（COW 列存合并）**：`cumulative_compaction.cpp` 只合并版本连续、且未越过 `cumulative_layer_point`（删除版本边界，:146-147）的小 rowset；base_compaction.cpp 合并剩余全部。**layer_point 的推进规则**：`_pick_input_rowsets` 只收 `start_version() == cumulative_layer_point()` 的候选 rowset，遇到 delete 版本时点前移到 `last_delete_version.first + 1`；compaction 成功后仅当点仍等于输入首个 rowset 的 start_version 才推进到 `end_version() + 1`——保证 base/cumulative 的分界单调前进。策略类 `DefaultCumulativeBaseCompactionPolicy::need_compaction()`（`default_compaction_policy.cpp:27`）同时算 `_cumulative_score`/`_base_score` 取大者；输入挑选受 `config::min/max_cumulative_compaction_num_singleton_deltas` 夹逼，base 侧按 `cumulative_base_ratio` 放大分数（:329），版本超限时直接 `+ tablet_max_versions` 提到最高优先（:337-338）。执行体由 `CompactionTaskFactory` 产出 horizontal（整行重写）或 vertical（按列分批，省内存）。
- **主键表**：`TabletUpdates::get_compaction_score()`（tablet_updates.h:163-189，**注释里有完整 cost-benefit 推导**：G = Σ((Rf+Wf)·d_i − Wf·r_i + Rf·C_seek)），compaction 后输出 rowset 经 `_commit_compaction`/`_light_apply_compaction_commit()`，用 `PrimaryIndex::replace()` 批量改指针而非重写 DelVec 全量。另有 size-tiered 可配策略与 PK 索引自身的 `PersistentIndex::major_compaction()`（`persistent_index_compaction_manager.cpp` 按 `major_compaction_score()` 调度）。
- **shared-data**：`lake/compaction_scheduler.cpp` + `lake/compaction_policy.cpp` 完全独立——无本地 rowset 列表，从 `TabletMetadataPB` 出发（详见 [07 存算分离](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data)）。

## 核心实现

### 读路径

- **Scan**：`TabletReader::prepare()` 按版本捕获 rowsets（非主键 `capture_consistent_rowsets`；主键 `get_applied_rowsets(version, ...)` 会 `_wait_for_version()` 等 apply 完成，tablet_updates.h:230）→ `Rowset::get_segment_iterators()`（无 overlap 用 `UnionIterator`，有则 `MaskMergeIterator`/`merge_iterator.cpp` 归并）→ `SegmentIterator`（`rowset/segment_iterator.cpp`）按列读 page + zone map/bloom/bitmap/dict 索引裁剪。PK 表读时叠加 DelVec 过滤 + DCG 增量列回填（`GetDeltaColumnContext`，tablet_updates.h:57）。
- **点查（short-circuit）**：`LocalTabletReader::multi_get()`（`local_tablet_reader.h:37`）直接 `TabletUpdates::get_rss_rowids_by_pk()`（一次索引定位）→ `get_column_values(column_ids, read_version, ..., rowids_by_rssid, ...)`（tablet_updates.h:308）按 rowid 直取列值，**完全绕开迭代器/归并**——主键表点查的"短路"路径。（`exec/short_circuit.cpp` 是查询级自适应短路，与此无关。）

### Schema Change 三条路线

`schema_change.h` 的 `SchemaChangeHandler` 分派：`LinkedSchemaChange`（hard link 数据文件 + `ChunkChanger` 改 meta，零拷贝，仅兼容 schema）、`SchemaChangeWithSorting`（COW 全量重写排序）、`SchemaChangeDirectly`（COW 不重排序）。主键表另有 `TabletUpdates::convert_from/reorder_from`（:242-248）。加列等轻量 schema change 在 BE 无专门类——疑似纯 FE 元数据操作（新 schema id + tablet_schema_map）；column 模式 partial update 时 BE 经 `DeltaColumnGroup`（`delta_column_group.cpp`）落增量列文件。待核实：仓库 grep 无 "lightning"，light schema change 的 FE 侧路径未展开。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 | `RowsetStateMachine`（三态）+ Rowset 引用计数 | 文件句柄懒加载/卸载的并发安全 |
| LSM + MVCC | `TabletUpdates` + DelVector + EditVersion 链 | upsert 高吞吐与读一致性的兼得 |
| 分层索引 | PersistentIndex L0/L1/L2 | 巨型 PK map 的内存可控 |
| 策略 | `DefaultCumulativeBaseCompactionPolicy` / size-tiered | 分数驱动、可替换 |
| 双实现 | HashIndex / PersistentIndex | 表大小阶段差异 |

## 模块间交互

- 写入口是 [08 Load](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/08-load) 的 `DeltaWriter`（memtable flush 成 rowset）与 publish 阶段的 `TabletUpdates::on_commit`。
- 读出口是 [09 Pipeline](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/09-pipeline) 的 scan 算子（`SegmentIterator` → Chunk，经 [10 向量化](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/10-vectorization) 的 Column）。
- 打开时机在 [12 BE 服务](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/12-be-service) 的 `StorageEngine::open`；后台线程由 `StorageEngine::start_bg_threads()` 拉起（compaction/flush 真正周期任务在此，不在 Daemon）。
- shared-data 的 lake/ 子树共享本模块的 `storage_primitive/` 原语，见 [07](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data)。

## 扩展方式

**新增排序键类型/存储格式特性**（仓库已有现成样板——full sort key index）：`full_sort_key_codec.h/.cpp` 定义编码 → `segment_writer.cpp` 写 footer field 11 的 sort key index page → `segment.h` 增加 `num_sort_key_columns()` 与 `_full_sk_index_decoder`（footer 解析期解析 presence，`open()` 不读 page）→ `segment_iterator.cpp` 用其做剪枝。**要点**：footer 先登记 presence 使旧版本文件零开销，读路径 lazy load 保证兼容。

**新 page 编码**：改 `encoding_info.cpp`（编码注册表）+ 新 `*_page.cpp`；新列级索引仿 `bitmap_index_writer/reader.cpp` 并在 segment_footer proto 加字段 + column_writer/reader 挂钩；lake 路径还需 `lake/index_file_writer.cpp` 对应支持。
