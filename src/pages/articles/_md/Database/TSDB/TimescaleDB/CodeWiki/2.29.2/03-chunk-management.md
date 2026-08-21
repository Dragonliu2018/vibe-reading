---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "Chunk 管理"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "PostgreSQL", "chunk", "分区路由"]
description: "TimescaleDB 物理 chunk 的查找、创建、约束、索引与插入路由状态机解读"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

如果 hypertable 是"逻辑表"的抽象，chunk 就是它的物理化身——一张张标准的 PostgreSQL 子表。这个模块负责 chunk 的查找、创建、约束生成、索引继承与插入路由状态管理。它是数据模型层与执行层的接合部：插入时把行路由到正确的物理表，查询时按时间范围筛选物理表。chunk 之所以独立成模块，因为它有独立的物理生命周期（建表、加约束、建索引、压缩状态、冻结）和独立的并发控制。

## 模块架构

```
Chunk（物理子表，FormData_chunk + Hypercube* cube）
  ├─ chunk_constraint（CHECK 约束，让 PG 约束排除工作）
  ├─ chunk_index（继承自 hypertable 的索引）
  ├─ ChunkInsertState（每 chunk 的插入状态，执行期按需创建）
  └─ status flags: COMPRESSED / COMPRESSED_PARTIAL / FROZEN / OSM
ChunkTupleRouting（执行期路由状态）
  └─ SubspaceStore subspace（Point → ChunkInsertState 缓存）
```

`FormData_chunk`（`ts_catalog/catalog.h:393`）含 id、relid（PG 物理表 OID）、hypertable_id、status 位标志、osm_chunk、creation_time。`Chunk` 运行时结构（`chunk.h:63`）额外持有 `Hypercube *cube`（N 个 DimensionSlice）。`ChunkInsertState`（`chunk_insert_state.h`）持有 Relation、ResultRelInfo、`TupleConversionMap hyper_to_chunk_map`、压缩状态标志。

## 调用链路

### 插入路由到 chunk

```
ExecModifyTable 逐行 (modify_hypertable_exec.c:2253)
  └─ ts_chunk_tuple_routing_find_chunk (chunk_tuple_routing.c:72)
       ├─ ts_subspace_store_get（缓存命中直接返回 ChunkInsertState）
       ├─ ts_hypertable_find_chunk_for_point (hypertable.c:1046)
       │    └─ ts_chunk_find_for_point (chunk.c:1456) → ts_chunk_point_find_chunk_id (chunk.c:2010)
       │         每维度 ts_dimension_slice_scan_list 找匹配 slice，按 chunk_id 聚合
       └─ 未找到 → ts_chunk_create_for_point (chunk.c:1485)
            ├─ LockRelationOid(ShareUpdateExclusiveLock) 串行化
            ├─ 重新检查避免竞态
            ├─ ts_hypercube_calculate_from_point (hypercube.c:217)
            ├─ 建物理表 + 约束 + 索引
            └─ ts_chunk_insert_state_create (chunk_insert_state.c:423)
```

### chunk 创建的约束与索引

新建 chunk 时（`chunk.c` 的 `chunk_create_from_point_after_lock`）会：建一张与 hypertable 结构相同的 PG 表（在 `_timescaledb_internal` schema）；为每个维度生成 `CHECK (dim_col >= range_start AND dim_col < range_end)` 约束（`chunk_constraint.c`）——**这些 CHECK 约束让 PG 原生的约束排除（constraint exclusion）能自动剪枝无关 chunk**；继承/复制 hypertable 上的索引（`chunk_index.c`）。

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ts_chunk_find_or_create_for_point` (chunk.c) | 插入定位/创建 chunk | ShareUpdateExclusiveLock 串行化，加锁后重检查 |
| `ts_chunk_point_find_chunk_id` (chunk.c:2010) | Point → chunk_id | 多维度 slice 交集聚合 |
| `ts_chunk_insert_state_create` (chunk_insert_state.c:423) | 建 chunk 插入状态 | 按需创建，复用 ResultRelInfo |
| `foreach_chunk` (process_utility.c:962) | 遍历所有 chunk 执行回调 | DDL 传播的基础 |

## 核心实现

### chunk 是独立物理表而非 PG 原生分区

TimescaleDB 的 chunk 是独立的标准 PG 表，而非 PG 原生 declarative partitioning 的分区。原因：一是数据生命周期管理——chunk 是 retention/compression 策略的最小单位，`ts_dimension_slice_get_chunkids_to_compress` 直接按时间范围批量选 chunk 压缩/丢弃；二是绕过 PG 原生分区数上限（大量分区导致规划器性能下降）；三是 chunk 是标准 PG 表，继承索引/约束/触发器机制，无需改内核。

### 约束驱动的分区剪枝

`chunk_constraint.c` 给每个 chunk 加 CHECK 约束，让 PG 规划器的约束排除（`constraint_exclusion`）能跳过无关 chunk。TimescaleDB 进一步用 `HypertableRestrictInfo`（`hypertable_restrict_info.c`）在**展开前**就按 WHERE 范围排除 chunk（见查询规划器模块），比 PG 原生"先全展开再排除"高效。

### 按需创建的插入状态与 ATTACH 延迟

`ChunkTupleRouting`（`chunk_tuple_routing.h`）用 `SubspaceStore` 缓存 Point→ChunkInsertState，"每个 chunk 的 ResultRelInfo 按需创建，仅当实际需要路由元组到该 chunk 时"（chunk_tuple_routing.c 注释）。`SubspaceStore` 限制同时打开的 chunk 数（`ts_guc_max_open_chunks_per_insert`），超限触发 flush。

在 PG 原生分区模式下，`partition_chunk.c` 把 chunk 创建的 `ALTER TABLE ... ATTACH PARTITION` 延迟到 `ExecutorEnd_hook`（`ts_executor_end_hook`，partition_chunk.c:407）执行——因为 PG 不允许在 parent table 有打开引用时 ATTACH，而 `ModifyTable` 节点整个执行期持有 parent 引用。chunk OID 先入 `PartChunkCache`，执行结束才真正 ATTACH。

## 模块间交互

被 `process_utility.c`（DDL 传播：ALTER/DROP/TRUNCATE/CREATE INDEX 都要遍历 chunk）、`planner/expand_hypertable.c`（展开为子表）、`modify_hypertable_exec.c`（插入路由）调用；通过 TS Catalog 的 `_timescaledb_catalog.chunk`/`dimension_slice`/`chunk_constraint` 表持久化；插入到压缩 chunk 时经 ABI 桥调 `decompress_batches_for_insert`（见压缩引擎模块）。

## 扩展方式

修改 chunk 创建时的约束/索引：改 `chunk_create_from_point_after_lock` 及 `chunk_constraint.c`/`chunk_index.c`。修改 chunk 路由策略：改 `chunk_tuple_routing.c` 的 `ts_chunk_tuple_routing_find_chunk` 与 SubspaceStore 容量。新增 chunk 状态标志：在 `chunk.h` 加 `CHUNK_STATUS_*` 位，在 `ts_chunk_validate_chunk_status_for_operation`（chunk_insert_state.c:452）加校验分支。
