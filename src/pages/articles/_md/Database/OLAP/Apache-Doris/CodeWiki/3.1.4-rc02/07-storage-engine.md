---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "存储引擎"
date: "2026-08-23T19:02:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "olap", "Tablet", "Rowset", "Compaction", "MoW", "Delete Bitmap"]
description: "Doris 3.1.4 存储引擎 olap：Tablet/Rowset/Segment 不可变列存 + 三级 Compaction + MoW Delete Bitmap。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

存储引擎是 `be/src/olap/`（~11.9 万行），3.1.4 仍用 `olap/` 旧命名（4.x 起更名 `storage/`）。它负责数据持久化：`Tablet`（数据分片）→ `Rowset`（不可变版本集）→ `Segment`（列存段）→ `Page`（编码页）。独立成文是因为列存与副本是 BE 的核心资产，存储模型（Duplicate/Unique/Aggregate 三种 keys_type）、Compaction、MoW（Merge-on-Write）构成独立决策域，与执行引擎正交。云模式由 `CloudStorageEngine` 替代部分职责（见 [11-cloud-metaservice](11-cloud-metaservice)）。

## 模块架构

```
BaseStorageEngine (olap/storage_engine.h:108, abstract)
   ├─ open() / start_bg_threads() / get_tablet() (:115)
   ├─ Compaction Registry (_tablet_submitted_cumu/base/full_compaction)
   │
   └─ StorageEngine final (storage_engine.h:226) ── 本地模式
         │  TabletManager / DataDir
         │
         ▼
Tablet final (olap/tablet.h:111) extends BaseTablet
   ├─ Rowset 列表（按版本排序）
   ├─ cumulative_layer_point (Compaction 分层)
   ├─ revise_tablet_meta (:132) ── 克隆时修订
   │
   ▼
Rowset (olap/rowset/rowset.h:120) ── enable_shared_from_this + MetadataAdder
   ├─ BetaRowset final (beta_rowset.h:47) ── segment_v2 实现
   ├─ keys_type() (:170) ── Duplicate/Unique/Aggregate
   ├─ _is_cumulative (:362) ── 是否累积层
   └─ RowsetStateMachine (:67)
         │
         ▼
Segment (olap/rowset/segment_v2/) ── 列式段
   ├─ column_reader / column_writer
   ├─ 编码页: binary_dict_page / binary_plain_page / bitshuffle_page
   ├─ 索引: bloom_filter / bitmap_index / zone_map
   └─ Delete Bitmap (MoW 标记被覆盖行)
```

## 调用链路

写入路径（导入）：

```
DeltaWriterV2.write(Block) (delta_writer_v2.h:73)
  └─ MemTableWriter → MemTable (内存排序)
  └─ flush → BetaRowsetWriterV2 → Segment (列式 Page 写盘)
  └─ close_wait → 产出 Rowset，挂到 Tablet
  └─ Tablet.revise_tablet_meta / publish version
```

读取路径（查询 scan）：

```
Pipeline scan 算子
  └─ StorageEngine.get_tablet(tablet_id) (:115)
  └─ Tablet 选定 Rowset 列表（按可见版本过滤）
  └─ RowsetReader → BetaRowsetReader → SegmentReader
       └─ column_reader 按 Page 解码 → Block
       └─ [MoW] 读 Delete Bitmap 过滤被覆盖行
```

Compaction 后台路径：

```
StorageEngine.start_bg_threads → Compaction 线程
  └─ pick_topn_tablets_for_compaction (storage_engine.h:213)
  ├─ base_compaction.cpp        ── 基线合并（累积层→基线）
  ├─ cumulative_compaction.cpp  ── 累积合并（新 Rowset→累积层）
  └─ cold_data_compaction.cpp    ── 冷数据合并（到对象存储）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `StorageEngine.open` (`:231`) | 打开引擎 | 装配 TabletManager/DataDir |
| `get_tablet` (`:115`/`:235`) | 取 Tablet | 副本定位入口 |
| `pick_topn_tablets_for_compaction` (`:213`) | 选 compaction 候选 | 按策略挑高收益 tablet |
| `Tablet.revise_tablet_meta` (`:132`) | 修订元数据 | 克隆场景恢复版本连续性 |
| `Rowset.comparator` (`:232`) | 版本排序 | 保证 Rowset 列表有序 |

</details>

## 核心实现

### 不可变 Rowset 与版本号

`Rowset`（`rowset.h:120`）是不可变数据版本集，一次导入或一次 Compaction 各产出一个。每个 Rowset 有 `[start_version, end_version]` 区间，`Rowset.comparator`（`:232`）按版本排序，`check_version_continuity`（`:383`）保证 Tablet 内 Rowset 版本连续无空洞。`_is_cumulative`（`:362`）标记它属累积层还是基线层——这是三级 Compaction 的分层依据。

设计决策：**为何 Rowset 不可变**——不可变使并发读无锁（读时无人在改）、Compaction 可后台异步进行而不阻塞查询、崩溃恢复只需按版本号重建可见集。代价是更新产生新 Rowset 而非原地改，靠 Compaction 合并减读放大。

### 三级 Compaction

`BaseStorageEngine` 持有三个提交注册表（`_tablet_submitted_cumu/base/full_compaction`，`:221-223`），`pick_topn_tablets_for_compaction`（`:213`）按收益挑候选。三类：`cumulative_compaction` 把新小 Rowset 合并成累积层；`base_compaction` 把累积层并入基线大 Rowset；`cold_data_compaction` 合并冷数据到对象存储。`cumulative_compaction_policy`（含 `time_series` 变体）决定何时提升累积层到基线（`set_cumulative_layer_point` `tablet.h:137`）。

设计决策：**为何分三级**——直接把每次导入的新 Rowset 全合并成大文件代价高（写放大）；分层使"频繁小合并（累积）+ 偶尔大合并（基线）"分离，平衡写放大与读放大。`cumulative_layer_point` 是分层分界点，policy 自适应调节。

### MoW Unique 表与 Delete Bitmap

Unique 模型启用 MoW 时，新版本导入会经 `calc_delete_bitmap_executor`（`olap/calc_delete_bitmap_executor.cpp`）计算 Delete Bitmap——标记"旧版本中哪些 key 被新数据覆盖"。查询读时用 `delete_bitmap_calculator`（`delete_bitmap_calculator.cpp`）过滤被覆盖行，使 MoW 读时无需 merge 多版本（快），代价是写时算 bitmap。`DeleteBitmap` 按版本存储，参与事务的可见性判定。

### 列存编码与索引

`segment_v2/` 下多种编码页适配不同列类型：`binary_dict_page`（字典编码，低基数字符串）、`binary_plain_page`/`binary_prefix_page`（有序前缀）、`bitshuffle_page`（bitshuffle 压缩，时序数据高效）。索引：`bloom_filter`（等值过滤）、`bitmap_index`（低基数等值）、`zone_map`（范围过滤）。`column_reader_cache` 缓存热 Page。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 不可变数据结构 | `Rowset`/`Segment` | 无锁读、异步合并、版本恢复 |
| 策略 | 三级 Compaction + policy | 分离小合并与大合并，平衡写读放大 |
| 模板方法 | `BaseStorageEngine` + `StorageEngine`/`CloudStorageEngine` | 本地/云存储共用接口，装配差异隔离 |
| COW | Rowset `enable_shared_from_this` | 共享所有权，引用计数管理生命周期 |

## 模块间交互

`olap/` **依赖** `runtime/`（`ExecEnv` 持 `StorageEngine`、`MemTracker`）、`io/`（FileSystem 抽象）、`vec/`（Block 读写）。**被** `pipeline/` scan 算子读、`DeltaWriterV2` 写、`agent/` 副本上报。云模式下 `CloudStorageEngine`（`be/src/cloud/`）替代 `StorageEngine`，元数据经 MetaService。

## 扩展方式

新增一种 Compaction 策略：继承 `Compaction`（`olap/compaction.h`）或实现 policy（`cumulative_compaction_policy.h`），在 `StorageEngine.pick_topn_tablets_for_compaction` 注册。新增列编码页：在 `segment_v2/` 加 page 类型，在 `column_writer`/`column_reader` 分派。对应测试：`be/test/olap/`、`regression-test/suites/compaction/`。
