---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "Hypertable 数据模型"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "PostgreSQL", "hypertable", "分区"]
description: "TimescaleDB hypertable 逻辑表、Dimension 维度、DimensionSlice 区间与 Hyperspace 分区空间模型解读"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

Hypertable 是 TimescaleDB 的核心抽象——一张用户视角的逻辑表，背后由多个按时间/空间维度切分的物理 chunk 表组成。这个模块定义了"如何描述分区结构"：维度（Dimension）、区间（DimensionSlice）、分区空间（Hyperspace）、坐标点（Point）。它处在数据模型层，向上被 DDL 拦截器和 planner 调用，向下通过 TS Catalog 持久化。理解了这个模块，就理解了 TimescaleDB "为什么是一张表却由多个物理表组成"。

## 模块架构

模块内核心对象及其关系：

```
Hypertable（逻辑表，按 relation OID 缓存）
  ├─ Hyperspace（N 维分区空间）
  │    └─ Dimension[]（open 时间维度在前，closed 空间维度在后）
  │         ├─ DIMENSION_TYPE_OPEN    有 interval_length，按时间区间动态切
  │         └─ DIMENSION_TYPE_CLOSED  有 num_slices，按 hash 等分
  ├─ SubspaceStore chunk_cache（Point → Chunk 快速查找）
  └─ ChunkRangeSpace range_space（chunk skipping 统计）
DimensionSlice（区间 [range_start, range_end)，int64）
  └─ 多个 slice 组成 chunk 的 Hypercube
```

Hypertable 运行时结构（`src/hypertable.h:58`）持有元数据 `FormData_hypertable fd`、主表 OID、`Hyperspace *space`、`SubspaceStore *chunk_cache` 和 `ChunkRangeSpace *range_space`。元数据 `FormData_hypertable`（`ts_catalog/catalog.h:126`）含 schema/table 名、维度数 `num_dimensions`、`status` 位标志（OSM/COMPRESSION）等。

## 调用链路

### 创建 hypertable

```
SQL: create_hypertable('metrics','time') 或 WITH (tsdb.hypertable)
  └─ ts_hypertable_create (hypertable.c:1546)
       └─ ts_hypertable_create_internal (hypertable.c:1452)
            └─ ts_hypertable_create_from_info (hypertable.c:1712)
                 ├─ table_open(AccessExclusiveLock) 串行化
                 ├─ ts_dimension_info_validate (dimension.c:1488)
                 ├─ hypertable_insert → 写 _timescaledb_catalog.hypertable
                 ├─ ts_dimension_add_from_info (dimension.c:1587) → 加 NOT NULL + 写 dimension 表
                 └─ ts_indexing_create_default_indexes
```

### 查询时按 OID 查找

```
planner/executor → ts_hypertable_cache_pin (hypertable_cache.c:250)
  └─ ts_hypertable_cache_get_entry(cache, relid) (hypertable_cache.c:189)
       └─ ts_cache_fetch → hash_search(htab, &relid)
            ├─ cache hit: 返回缓存 Hypertable
            └─ cache miss: hypertable_cache_create_entry → 扫 catalog 表 + ts_dimension_scan 建 Hyperspace
```

### 插入时按 Point 定位 chunk

```
INSERT → ts_hyperspace_calculate_point (dimension.c:974)
  ├─ 遍历每个 Dimension：slot_getattr 取列值
  │    ├─ 有 partitioning: ts_partitioning_func_apply_slot (partitioning.c:286)
  │    ├─ OPEN: ts_time_value_to_internal 转微秒 int64
  │    └─ CLOSED: DatumGetInt32 取 hash
  └─ 返回 Point { coordinates[] }
  → ts_hypertable_find_chunk_for_point (hypertable.c:1046)
       ├─ ts_subspace_store_get（先查内存缓存）
       └─ ts_chunk_find_for_point → ts_dimension_slice_scan_list (dimension_slice.c:482)
            构造 ScanKey[3]: dimension_id=, range_start<=coord, range_end>coord
            用 (dimension_id, range_start, range_end) 复合 B-tree + BackwardScanDirection
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ts_hypertable_create` (hypertable.c:1546) | 建 hypertable 元数据 | AccessExclusiveLock 串行化防并发创建 |
| `ts_hyperspace_calculate_point` (dimension.c:974) | tuple → N 维坐标 | 所有维度坐标统一 int64 |
| `ts_dimension_slice_scan_list` (dimension_slice.c:482) | 按坐标查区间 | 三键复合 B-tree + BackwardScan |
| `ts_hypertable_cache_get_entry` (hypertable_cache.c:189) | oid → Hypertable | dynahash + 负缓存（非 hypertable 也缓存） |

## 核心实现

### 维度抽象：open 与 closed

`DimensionType` 枚举（`dimension.h:63`）统一了时间维度与空间维度：

- **OPEN（时间维度）**：有 `interval_length`（如 7 天），chunk 按时间区间划分，范围动态增长。第一个 chunk 的 `range_start = INT64_MIN`（覆盖所有历史），最后一个的 `range_end = INT64_MAX`（覆盖所有未来）。`calculate_open_range_default`（dimension.c:292）用 `(value / interval) * interval` 对齐到区间边界。
- **CLOSED（空间维度）**：有 `num_slices`（如 4），整个 hash 空间 `[0, INT32_MAX)` 被 N 等分。必须有 partitioning func（默认 `get_partition_hash`）。`calculate_closed_range_default`（dimension.c:362）将空间均分为 N 段。

`dimension_type`（dimension.c:165）通过 tuple 中 `interval_length` 与 `num_slices` 哪个非 null 自动判断类型——优雅的持久化设计。

### dimension_slice 的 int64 统一表示

`FormData_dimension_slice`（catalog.h:261）的 `range_start`/`range_end` 都是 `int64`。原因有三：一是 `ts_time_value_to_internal`（dimension.c:1009）把所有时间类型（TIMESTAMP/TIMESTAMPTZ/DATE/UUID）和整数类型统一转 int64（TIMESTAMP 转微秒、DATE 转天数），使所有维度坐标用同一套比较逻辑；二是 closed dim 的 hash 值是 int32 但用 int64 存，第一个 slice `range_start = INT64_MIN`、最后一个 `range_end = INT64_MAX`，与 open dim 共用数据结构和索引；三是统一 int64 让 `(dimension_id, range_start, range_end)` 用单一 B-tree，ScanKey 操作符统一为 `F_INT4EQ`/`F_INT8LE`/`F_INT8GT`。

`REMAP_LAST_COORDINATE`（dimension_slice.h:15）把 `PG_INT64_MAX` 映射为 `PG_INT64_MAX - 1`——因为 range_end 是 exclusive，若坐标恰为 `INT64_MAX`，`coord >= range_end` 会把它排除在最后一个 slice 外。

### 对象缓存与负缓存

`hypertable_cache` 是基于 PG dynahash 的全局缓存，key 为 relation OID。设计要点（`src/cache.c`）：pin/release 引用计数，事务结束自动释放未释放的 pin 防泄漏；**负缓存**——非 hypertable 的表也缓存（`hypertable = NULL`），避免重复扫 catalog；planner 用栈式管理（`planner_hcaches`）支持递归查询。两层缓存：Hypertable 级（oid→Hypertable）+ Chunk 级（SubspaceStore，Point→Chunk）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 对象缓存（pin/release） | `hypertable_cache` in `cache.h:38` | 高频 oid 查询，避免重复扫 catalog |
| 分区映射（B-tree 区间扫描） | `ts_dimension_slice_scan_limit` (dimension_slice.c:440) | 三键索引操作符 `=,<=,>` 配 BackwardScan |
| 维度抽象 | `DimensionType` (dimension.h:63) | 时间/空间维度统一处理 |

## 模块间交互

被 `process_utility.c`（DDL 判断是否 hypertable）、`planner.c`（展开/剪枝）、`chunk.c`（chunk 创建定位）高频调用；通过 TS Catalog 的 `_timescaledb_catalog.hypertable`/`dimension`/`dimension_slice` 表持久化；缓存失效由 `ts_hypertable_cache_invalidate_callback`（hypertable_cache.c:167）在 DDL 后触发整缓存重建。

## 扩展方式

新增一种分区维度类型（参考已定义的 `DIMENSION_TYPE_STATS`）：在 `dimension.h` 枚举加类型 → 改 `dimension_type`（dimension.c:165）的判定 → 在 `ts_hyperspace_calculate_point` 的 switch 加 case → 加 `calculate_*_range_default` 与 `dimension_info_validate_*`。修改时间分区算法则改 `calculate_open_range_default`（dimension.c:292）并调 `ts_hypertable_cache_invalidate_callback` 失效缓存。
