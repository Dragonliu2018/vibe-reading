---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "版本引擎"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "版本链", "VersionMap", "tombstone"]
description: "ArcticDB 版本引擎：不可变版本链、VersionMap 缓存、快照与 symbol list"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

版本引擎（`cpp/arcticdb/version/`，~25k 行，全库最大模块）是 ArcticDB 的业务逻辑核心。它定义了"什么是版本、版本如何链接、如何删除、如何缓存"。这层独立存在是因为**版本语义与并发正确性是 ArcticDB 区别于普通键值存储的根本**——不可变版本链 + last-writer-wins 让无服务器的多进程并发写成为可能，而这套语义需要一个集中模块来编排写键顺序、维护缓存、管理 tombstone。

## 模块架构

![版本链结构](/vibe-reading/images/articles/arcticdb-internals/version-chain.svg)

版本引擎的核心是三层结构：`PythonVersionStore`（`version_store_api.cpp`，pybind 入口）是 C++ API 边界，把 Python 调用转成内部操作；`LocalVersionedEngine`（`local_versioned_engine.cpp`，~2580 行）是核心引擎，实现 `write_versioned_dataframe_internal`/`append_internal`/`update_internal`/`read_modify_write_internal`/`delete_version`/`prune_previous_versions` 等全部版本操作；`VersionMap`（`version_map.hpp`）是版本链的内存缓存。版本链本身在存储里是"键树"：`VERSION_REF`（REF 键，快指针）→ `VERSION`（ATOM 键，链表节点，含 index 键引用 + prev 指针）→ `TABLE_INDEX` → 多个 `TABLE_DATA` 叶子。`VERSION` 段内还可能携带 `TOMBSTONE`/`TOMBSTONE_ALL` 虚拟键标记删除。这层把"数据段怎么切、怎么压"委托给[管道模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)，自己专注版本拓扑与键写入顺序。

## 调用链路

```text
write_versioned_dataframe_internal(symbol, frame, ...)     local_versioned_engine.cpp
  ├─ write_frame(IndexPartialKey, frame, slicing, store)    pipeline/write_frame.cpp → 写 TABLE_DATA + TABLE_INDEX
  ├─ write_version_and_prune_previous(index_key, prev)     写 VERSION 键（含 prev 链表指针）
  └─ update_ref_key(stream_id, version_id) → 写 VERSION_REF（最后写，last-writer-wins）

read:  get_version_to_read(symbol, VersionQuery)            version_functions
         └─ VersionMap::check_reload → 命中缓存或 storage_reload
       fetch_index_and_column_stats(version, store)         version_core.cpp → 并行拉 INDEX + COLUMN_STATS
       read_indexed_keys_to_pipeline → filter_index → read_frame
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `write_versioned_dataframe_internal` `local_versioned_engine.cpp:826` | 写一个新版本 | 按 precedence 顺序写键，最后更新 REF |
| `append_internal` `:2020` | 追加行到最新版本 | 读旧 index，新数据段链到尾部 |
| `update_internal` `:759` | 按索引区间更新行 | `read_modify_write_internal` + `flatten_and_fix_rows` 重排 5 类段 |
| `read_modify_write_internal` `:520` | append/update 共用的读改写骨架 | 先读现有版本 index 再走写入路径 |
| `delete_version`/`delete_all_versions` `:1199`/`:1327` | 惰性删除 | 在 VERSION 段内写 TOMBSTONE，不删数据 |
| `prune_previous_versions` `:1308` | 物理回收旧版本 | `write_version_and_prune_previous` 删段键 |
| `compact_data_internal` `:1311` / `defragment_symbol_data` `:1369` | 段合并/去碎片 | 把多个小段重写成大段 |

## 核心实现

### 版本链与键写入顺序

版本链的不可变性是并发的基石。`key_types_write_precedence()`（`entity/key.hpp`）用 `consteval` 定义了写入顺序：`LIBRARY_CONFIG → TABLE_DATA → TABLE_INDEX → MULTI_KEY → VERSION → VERSION_REF → SYMBOL_LIST → SNAPSHOT_REF → APPEND_REF...`。这个顺序的语义是——**先写所有不可变 ATOM 键（DATA/INDEX/VERSION），最后才写可变 REF 键（VERSION_REF）**。因为 ATOM 键是内容寻址的，两个并发写者各写各的 ATOM 键互不干扰；最后只有一个写者能成功把 `VERSION_REF` 指向自己的 VERSION——这就是 last-writer-wins，无需任何锁。`key_types_read_precedence()` 是其逆序，用于读时按依赖顺序解析。`write_version_and_prune_previous`（`:1614`）在写新 VERSION 的同时可选地物理删除旧版本。

### VersionMap 缓存与多进程行为

`VersionMapImpl`（`version_map.hpp`）用 `map_: {StreamId → VersionMapEntry}` 缓存版本链。`VersionMapEntry`（`version_map_entry.hpp`）含 `head_`（最新 VERSION 指针）、`keys_`（已加载版本 deque）、`tombstones_`（单版本删除 map）、`tombstone_all_`（批量删除标记）、`last_reload_time_`、`load_progress_`。`check_reload(store, stream_id, load_strategy)` 是缓存核心：判 `has_cached_entry`——条目存在且 `(now - last_reload_time) < reload_interval_`（默认 2 秒）且满足 load_strategy——则直接返回，否则 `storage_reload` 从存储 reload（`last_reload_time_ = now - clock_unsync_tolerance`，默认容忍 200ms 时钟偏移）。

多进程行为的关键区分：**读"最新"版本会返回缓存里的最新（可能滞后）**——这是预期行为不是 bug；**读特定版本号时若缓存没有会自动 bypass retry**（`flush_entry` 后从存储 reload），保证最终一致。写操作会更新缓存条目。配置：`VersionMap.ReloadInterval`（ns，默认 2s，设 0 禁用缓存）、`VersionMap.UnsyncTolerance`（默认 200ms）、`VersionMap.MaxReadRefTrials`（读 REF 重试次数，默认 2）。

### 删除：tombstone 与 prune

删除是两阶段的。`delete_version`（`:1199`）做软删——在 VERSION 段内追加 `TOMBSTONE` 虚拟键：被标记的版本在 `list_versions` 不可见、显式读报错，但数据段仍在存储里。`TOMBSTONE_ALL`（`:version_map_entry` 的 `tombstone_all_`）是优化：标记"某版本号之前的全部删除"，避免在 `tombstones_` map 里存上千条目。`prune_previous_versions`（`:1308`）做硬删——`write_version_and_prune_previous` 物理删除旧版本的段键、回收空间。快照（`SNAPSHOT_REF`）是旁路：`snapshot()`（`version_store_api.cpp:588`）写一个 REF 键，其段内含多个 symbol→index 键的映射，被快照引用的版本不会被 prune 回收。

### symbol list 与并发写

`symbol_list.cpp` 维护一个无锁并发数据结构，让 `list_symbols()` 不必扫描所有 `VERSION_REF` 键。结构是 `__symbols__`（压实的基础列表）+ `__add__`/`__delete__` 增量 delta 键，周期性 compact。`LOCK`/`ATOMIC_LOCK` 键**只用于 symbol list 的 compaction 阶段**（`storage_lock.hpp`/`reliable_storage_lock.hpp`），不用于 symbol 写——这是理解 ArcticDB 并发模型的关键：写无锁，只有 symbol list 压实用弱锁。`ATOMIC_LOCK` 利用 S3 的条件写（`IfNoneMatch`）做强保证，`Storage::test_atomic_write_support`（`storage.hpp`）会实测写两次验证后端是否真支持原子写（PURE/VAST 会静默忽略条件写）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 不可变值对象 + 链表 | `AtomKey` VERSION 链 | 版本一旦写入不可变，天然支持并发读与 time travel |
| 写时复制 | 任何修改都产出新版本 | 旧版本不被破坏，支持快照与回溯 |
| 缓存旁路 + retry | `check_reload` + `flush_entry` | 兼顾性能（缓存最新）与最终一致（特定版本 bypass） |
| 惰性删除 | tombstone → prune 两阶段 | 删除快（只写标记），物理回收可延后 |

## 模块间交互

版本引擎向下调度[读写管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)（`write_frame`/`read_frame`）做实际段读写，经 `Store` 抽象访问[存储后端](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage)，并行 I/O 走[异步模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/09-stream-async)的线程池。它依赖[核心类型](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/08-entity)的 `AtomKey`/`RefKey`/`KeyType` 构建键树。向上被[Python API 层](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/01-python-api)经 pybind11 调用。`IndexInformation`/`VersionIdentifier`（`version_tasks.hpp`）是版本引擎与管道之间的数据契约——`setup_pipeline_context()` 接受 `IndexInformation`（index 键/段 + 可选 column stats）或 `StreamId`（读 incomplete）等 variant。

## 扩展方式

新增一种版本操作（如 `merge`）：在 `local_versioned_engine.cpp` 实现 `merge_internal`（已有 `:2521`），复用 `read_modify_write_internal` 骨架 + `write_version_and_prune_previous`，在 `version_store_api.cpp` 的 `PythonVersionStore` 暴露给 pybind，在 `library.py`/`_store.py` 加 Python 方法。修改缓存策略：调 `VersionMap.ReloadInterval`/`UnsyncTolerance`（`set_config_int`，ns 单位），或 `version_map()->flush()`/`flush_entry(stream_id)` 强制刷新。`compact_data_internal`/`defragment_symbol_data` 提供段合并扩展点，可调 `segment_row_size` 改段粒度。
