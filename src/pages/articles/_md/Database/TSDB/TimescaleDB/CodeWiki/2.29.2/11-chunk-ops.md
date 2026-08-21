---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "Chunk 运维操作"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "chunk", "merge", "split", "reorder"]
description: "TimescaleDB chunk 合并/拆分/重排与 chunkwise 聚合下推的迁移式重构与并发控制解读"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

随着时间推移，hypertable 的 chunk 可能过多（每个太小，扫描开销大）或过大（压缩效率/管理问题），或物理顺序与查询模式不匹配（压缩率低、局部性差）。这个模块（`tsl/src/chunk_merge.c`/`chunk_split.c`/`reorder.c`/`chunkwise_agg.c`/`chunk_api.c`）提供 chunk 的合并、拆分、重排与聚合下推等运维操作。它独立成模块因为这些操作本质是"建新表→迁数据→删旧表"的迁移式重构，复用 PG CLUSTER/VACUUM FULL 的 heap rewrite 机制，有独立的并发控制与 catalog 一致性更新逻辑。

## 模块架构

```
chunk_merge.c（1601 行）—— merge_chunks: 合并相邻 chunk
  RelationMergeInfo / RelationMergeStats / SessionLockInfo
chunk_split.c（1259 行）—— split_chunk: 拆分大 chunk
  SplitPoint / CompressedSplitPoint / RelationWriteState / SplitContext
reorder.c（930 行）—— reorder_chunk: 按列重排
  复用 PG CLUSTER: make_new_heap + copy_heap_data + finish_heap_swap
chunkwise_agg.c（810 行）—— 聚合下推到 chunk 级
chunk_api.c（606 行）—— chunk 对外 SQL API
```

## 调用链路

### merge_chunks

```
chunk_merge_chunks (chunk_merge.c:1007)
  ├─ Step1 健全性检查+锁定: deconstruct_array 解析 chunk OID, qsort 排序避免死锁
  │    每 chunk: ts_chunk_get_by_relid_locked, CheckTableNotInUse, 权限检查
  ├─ Step2 排序+可行性: cmp_relations 按分区范围排序, validate_merge_possible（仅单维度相邻）
  │    merge_cubes 扩展合并 hypercube, 检查压缩设置一致性 ts_compression_settings_equal
  ├─ Step3 创建临时 heap + 拷贝: merge_relinfos → make_new_heap + table_relation_copy_for_cluster
  ├─ [concurrently] 事务切换: 会话锁跨事务, SPI_commit_and_chain
  ├─ Step4 heap swap: merge_chunks_finish → ts_finish_heap_swap + update_stats
  └─ Step5 更新分区元数据: chunk_update_constraints 删旧 slice/约束 建新
```

### split_chunk

```
chunk_split_chunk (chunk_split.c:937)
  ├─ 解析拆分维度+点: hyperspace_get_open_dimension, 未提供则中点拆分
  ├─ 更新旧 chunk约束 (range_end=split_at), 创建新 chunk ts_chunk_find_or_create_without_cuts
  ├─ SplitPoint 初始化 (route_next_tuple 函数指针)
  ├─ 若已压缩: 先拆分压缩关系（CompressedSplitPoint, 按 min/max 路由, 跨边界解压-重压缩）
  └─ split_relation 非压缩: make_new_heap + copy_tuples_for_split（route 路由到 2 份）+ finish_heap_swap
```

### reorder_chunk

```
tsl_reorder_chunk (reorder.c:85)
  └─ reorder_rel → rebuild_relation
       ├─ chunk_get_reorder_index（优先级: 显式 > chunk CLUSTER 索引 > hypertable 索引）
       ├─ make_new_heap（按 indexOid 排序）+ copy_heap_data
       └─ ts_finish_heap_swap + reindex
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `chunk_merge_chunks` (chunk_merge.c:1007) | 合并相邻 chunk | 单维度相邻 + 压缩设置一致 |
| `chunk_split_chunk` (chunk_split.c:937) | 拆分大 chunk | 二路拆分（SPLIT_FACTOR=2），压缩段跨边界解压-重压缩 |
| `reorder_rel` (reorder.c) | 按列重排 | 复用 PG CLUSTER，BTREE 用 sort 重建 |
| `tsl_pushdown_partial_agg` (chunkwise_agg.c) | 聚合下推 | 每 chunk partial agg + 上层 finalize |

## 核心实现

### 迁移式重构模式

三个操作均用"创建临时表→拷贝数据→heap swap→删旧表"，这是 PG CLUSTER/VACUUM FULL 标准做法：`make_new_heap` 建临时接收表，`table_relation_copy_for_cluster`/`copy_table_data` 迁数据，`ts_finish_heap_swap`/`finish_heap_swap` 物理文件交换。**为什么**：保证 MVCC 可见性——旧数据对持旧快照事务仍可见，同时新数据已物理有序/合并。比原地修改安全但代价更高。

### 策略模式：split 的路由

`SplitPoint` 结构体的函数指针 `route_next_tuple`（chunk_split.c:59）实现策略：非压缩用 `route_next_non_compressed_tuple`（逐行按 split point 比较）；压缩用 `route_next_compressed_tuple`（按 min/max 元数据路由，若 split point 落在压缩段内则解压→逐行路由→重新压缩为子段）。

### merge 的并发模式与约束

merge 独有 `concurrently` 参数，两阶段事务设计：第一阶段 ExclusiveLock + 建临时表 + 拷数据 + 记 `chunk_rewrite` 映射；事务提交释放非会话锁；第二阶段升级 AccessExclusiveLock + heap swap + 删旧 chunk。Session lock 跨事务保持防并发修改。设计约束：仅沿单一维度相邻合并（`validate_merge_possible`，多维度因 routing cache bug 默认禁用 `merge_chunks_multidim_allowed`）；压缩 chunk 须相同 `CompressionSettings`。

### chunkwise_agg 聚合下推

`tsl_pushdown_partial_agg`（tsl/src/planner.c:87）在 `UPPERREL_GROUP_AGG` 阶段，把聚合下推到 chunk 级：每 chunk 做 partial aggregate（`AGGSPLIT_INITIAL_SERIAL`），Append 之上做 finalize aggregate（`AGGSPLIT_FINAL_DESERIAL`）。减少 Append 向上传递的行数，压缩 chunk 上可与 columnar scan 协作做向量化 partial 聚合。由 `enable_chunkwise_aggregation` GUC（默认 on）控制。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 迁移式重构 | merge/split/reorder 共用 | MVCC 安全的物理重组 |
| 策略模式 | `SplitPoint.route_next_tuple` | 压缩/非压缩不同路由 |
| catalog 一致性更新 | 先改物理再改元数据最后约束 | 保持 chunk 元数据一致 |
| 两阶段事务（并发） | merge concurrently | 跨事务会话锁 |

## 模块间交互

调 hypertable/chunk 的创建逻辑（`ts_chunk_find_or_create_without_cuts`/`ts_chunk_get_by_relid_locked`）；更新 `ts_catalog` 元数据（`ts_dimension_slice_delete_by_id`/`insert`、`ts_compression_chunk_size_update`、`ts_chunk_rewrite_*` 并发恢复映射）；经 `CrossModuleFunctions` 的 `merge_chunks`/`split_chunk`/`reorder_chunk`/`move_chunk`/`compact_chunk`/`detach_chunk`/`attach_chunk` 暴露；与压缩模块交互（检查 `CompressionSettings` 一致性、压缩段拆分解压-重压缩）；chunkwise_agg 与 planner（`tsl/src/planner.c`）协作。

## 扩展方式

新增 chunk 运维操作：在 `tsl/src/` 新建文件实现 `chunk_xxx_chunk(PG_FUNCTION_ARGS)` 遵循迁移式重构（`make_new_heap`+`copy_table_data`+`ts_finish_heap_swap`+更新 catalog），在 `cross_module_fn.h` 加字段 + `cross_module_fn.c` 加 `CROSSMODULE_WRAPPER` + `tsl/src/init.c` 注册 + `.sql` 封装。修改 merge 合并策略（如支持多维度）：放宽 `validate_merge_possible`（chunk_merge.c:359）的 `follow_edges==1` 约束 + 修复 chunk_append routing cache 对非对齐多维度合并的处理 + 改 `merge_chunks_multidim_allowed`（chunk_merge.c:498）默认。
