---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "列存查询执行"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "向量化", "Arrow", "CustomScan"]
description: "TimescaleDB 列存扫描、向量化聚合、gapfill 补点与 skip_scan 自定义执行节点解读"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

压缩引擎把 chunk 存成列式压缩格式后，查询时不能再用 PG 原生行存扫描——那样要逐行解压，性能全无优势。这个模块（`tsl/src/nodes/`）提供一组专门针对压缩数据的 CustomScan 执行节点：ColumnarScan 批量解压 + 谓词下推、VectorAgg 向量化聚合、GapFill 时序补点、SkipScan distinct 优化、ColumnarIndexScan 稀疏索引扫描。它们是压缩态查询性能的执行侧保障，独立于行存执行路径。

## 模块架构

```
columnar_scan/      列存扫描主节点（3263 行 exec + planner + compressed_batch + qual_pushdown + batch_queue）
vector_agg/         向量化聚合（exec + plan + grouping_policy_batch/hash + hashing + function）
gapfill/            时序补点（gapfill_exec + gapfill_plan + locf + interpolate）
skip_scan/          distinct 跳过扫描（planner + exec）
columnar_index_scan/  列存稀疏索引扫描
```

核心数据：`ColumnarScanState`（columnar_scan/exec.h）含 `DecompressContext`、`BatchQueue`（FIFO 或 Heap）、向量化 quals；`DecompressBatchState`/`CompressedColumnValues`（compressed_batch.h）封装 ArrowArray 扁平化访问；`VectorAggState`（vector_agg/exec.h）含 `GroupingPolicy`；`GapFillState`（gapfill_internal.h）状态机驱动。

## 调用链路

### 列存扫描链

```
tsl_postprocess_plan (tsl/planner.c:203) 注入:
  plan 阶段: columnar_scan_path_create → columnar_scan_plan_create (planner.c:1032)
            构建 decompression_map / is_segmentby_column / bulk_decompression_column
exec 阶段:
  columnar_scan_exec_impl (exec.c:445) 主循环:
    ├─ bqfuncs->pop() 推进当前批次
    ├─ ExecProcNode(子扫描) 读压缩 tuple
    ├─ bqfuncs->push_batch() 压入队列
    └─ bqfuncs->top_tuple() 返回解压 tuple
  compressed_batch_set_compressed_tuple (compressed_batch.c:919):
    ├─ 读 COUNT_COLUMN 定 batch 行数
    ├─ SEGMENTBY_COLUMN 标量存
    ├─ vector_qual_compute() 在 Arrow 数据上向量化谓词（位图）
    ├─ NoRowsPass → compressed_batch_discard_tuples 跳过整 batch
    └─ 有行通过 → decompress_column() 解压剩余列
```

### 向量化聚合链

```
vector_agg_exec (exec.c:1475):
  ├─ grouping->gp_reset() 重置
  ├─ 循环 get_next_slot()（= compressed_batch_get_next_slot，直接操作 DecompressContext）
  │    └─ 对每 batch: 计算 FILTER 位图 + grouping->gp_add_batch() 整 batch 送分组策略
  └─ grouping->gp_should_emit() → gp_do_emit() 输出 partial 聚合
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `columnar_scan_exec_impl` (exec.c:445) | 列存扫描主循环 | batch 队列驱动 |
| `compressed_batch_set_compressed_tuple` (compressed_batch.c:919) | 解压+过滤 batch | 向量化谓词先于解压 |
| `qual_pushdown_mutator` (qual_pushdown.c:1533) | 谓词下推到压缩态 | 三级递进策略 |
| `vector_agg_exec` (exec.c:1475) | 向量化聚合 | 绕过 tuple-by-tuple 直接 batch 消费 |

## 核心实现

### 为什么向量化

向量化执行一次处理一批列数据（batch ~1000 行），核心是 `ArrowArray`（Apache Arrow 列式格式）。优势：缓存友好（`compressed_columns_to_postgres_data` 标 `pg_attribute_always_inline`，逐行访问同列连续内存）、减少分支（向量化谓词以 64 位字为单位处理位图，一次判断 64 行）、减少函数调用开销（PG `ExecQual` 每行每表达式都调用，向量化合并为批量操作）。

### 谓词下推到压缩态

`qual_pushdown.c` 的 `qual_pushdown_mutator` 递归遍历谓词树，按优先级三级递进：segmentby 列直接下推（值对整 batch 相同）、bloom1 稀疏索引（`pushdown_op_to_segment_meta_bloom1`，哈希等值检查代替解压）、minmax/firstlast 稀疏索引（`pushdown_op_to_orderby_range_metadata`，范围谓词转元数据列谓词）。核心动机：**避免解压无关 batch**——解压 1000 行 batch 需读所有列，谓词下推可在不解压时跳过整 batch（`compressed_batch_discard_tuples`）。

### batch_queue 堆合并多 chunk

排序输出时多 chunk 的压缩 batch 排序状态不同，`BatchQueueHeap`（batch_queue_heap.c）用 PG `binaryheap` 归并排序：每 chunk batch 内部已按 segmentby+orderby 有序，堆中每条目是一个 batch 当前行，`compare_heap_pos` 比较堆顶，`batch_queue_heap_pop` 输出最小并推进该 batch。`HeapEntryColumn` 只缓存排序键最小表示提高 cache 局部性。每时刻内存中只有每 chunk 一个 batch。

### GapFill 与 SkipScan

**GapFill**（gapfill_exec.c:987）解决时序数据缺失——传感器某时间桶无数据时自动插行，LOCF（Last Observation Carried Forward）用上一有效值、Interpolate 线性插值。状态机驱动：子计划 tuple 时间戳与 `next_timestamp` 不匹配时生成 gap tuple 填值。**SkipScan**（skip_scan）解决 `SELECT DISTINCT ON (column)` 全表扫描——利用索引有序性改 ScanKey 为 `WHERE column > [previous_value]` 跳到下一 distinct 值，O(N) 降 O(D)。多 key 用状态机 `SS_PREV_KEY` 实现 key relaxation。

### ColumnarScan 与 VectorAgg 的紧耦合

`VectorAggState` 的 `get_next_slot` 指向 `compressed_batch_get_next_slot`（exec.c:1356），直接操作 `ColumnarScanState` 的 `DecompressContext` 与 `BatchQueue`——VectorAgg **绕过** ColumnarScan 的 tuple-by-tuple `ExecProcNode` 接口，直接以 batch 粒度消费压缩数据，这是向量化聚合性能的关键。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| CustomScan | ColumnarScan/VectorAgg/GapFill/SkipScan | 复用 PG 执行器框架 |
| 向量化执行 | ArrowArray batch 列处理 | 缓存友好 + 减分支 |
| 谓词下推 | qual_pushdown.c 三级递进 | 不解压跳过无关 batch |
| 策略模式 | GroupingPolicy（batch/hash） | 按分组特征选策略 |
| 批次堆合并 | BatchQueueHeap | 多 chunk 全局有序 |
| 状态机 | GapFillFetchState / SkipScanStage | 补点/跳过流程驱动 |

## 模块间交互

columnar_scan 调压缩引擎的解压（`decompress_column`）；被 planner 的 `tsl_postprocess_plan`（`tsl/src/planner.c:203`，经 `ts_cm_functions->tsl_postprocess_plan`）注入计划树——`try_insert_vector_agg_node` 把 ColumnarScan 上的 partial Agg 替换为 VectorAgg；VectorAgg 与 ColumnarScan 紧耦合直接消费 batch；SkipScan 可穿透 ColumnarScan 访问内部压缩 IndexScan；columnar_index_scan 在 ColumnarScan 上方用稀疏索引聚合 min/max/first/last。

## 扩展方式

新增向量化谓词：在 `vector_predicates.c` 实现 `vector_const_newpred(arrow, arg, result)`（位图输出）+ `get_vector_const_predicate` 的 switch 注册（算术类型用 `pred_vector_const_arithmetic_type_pair.c` 模板生成 EQ/NE/LT/LE/GT/GE 六变体）+ `plan.c` 的 `is_vector_function` 支持。新增 gapfill 策略：`gapfill_internal.h` 加列类型枚举 + 新列状态结构 + `gapfill_state_gaptuple_create`（gapfill_exec.c:1187）加 case + walker 识别新 marker 函数。
