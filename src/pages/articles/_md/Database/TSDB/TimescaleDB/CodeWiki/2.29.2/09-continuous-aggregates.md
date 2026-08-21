---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "连续聚合"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "物化视图", "连续聚合", "失效日志"]
description: "TimescaleDB 连续聚合——三层视图、两级失效日志、两阶段聚合与透明查询重写机制解读"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

连续聚合（Continuous Aggregates，cagg）是 TimescaleDB 的实时增量物化视图——它预聚合时序数据到更粗粒度（如小时/天），并在后台增量刷新，使聚合查询从"扫原始数据"变成"扫预聚合数据"。这个模块（`tsl/src/continuous_aggs/`，约 11k 行）独立存在因为它是一个完整子系统：创建（三层视图）、失效追踪（两级日志）、刷新（三事务流程）、查询重写（透明改写）、两阶段聚合。它不是 PG 原生 matview——它支持增量刷新、real-time 合并、压缩，是时序分析的核心加速器。

## 模块架构

```
create.c（创建）—— cagg_create (行 599) 建三层视图 + 物化 hypertable
refresh.c（刷新）—— continuous_agg_refresh_batched (行 641) 三事务流程 + 批次拆分
invalidation.c（失效）—— 两级日志 + 切割/合并/搬移
materialize.c（物化）—— continuous_agg_update_materialization DELETE+INSERT/MERGE
rewrite_with_caggs.c（查询重写）—— rewrite_query_with_caggs (行 744) 透明改写查 raw ht 的查询
common.c（公共）—— bucket 验证、UNION 查询构建、watermark
finalize.c（两阶段聚合）—— partialize/finalize
planner.c（planner 钩子）—— constify_cagg_watermark / cagg_sort_pushdown
insert.c（DML 失效追踪）—— continuous_agg_xact_invalidation_callback 事务回调
```

## 调用链路

### 创建链

```
CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) AS SELECT time_bucket(...) ...
  └─ process_cagg_viewstmt (create.c:779)
       └─ cagg_create (create.c:599)
            Step1 create_materialization_table → DefineRelation + cagg_create_hypertable (行 267)
            Step2 finalizequery_get_select_query (finalize.c:132) → build_union_query（real-time UNION）
            Step3 get_partial_select_query → partial 视图（查 raw ht，partialize 包装聚合）
            Step4 create_cagg_catalog_entry → 写 CONTINUOUS_AGG + BUCKET_FUNCTION catalog
       └─ ts_cagg_watermark_insert 初始化 watermark=0
       └─ invalidation_threshold_initialize 初始化失效阈值
       └─ 若 WITH DATA: continuous_agg_refresh_internal 首次刷新
```

### 刷新链（三事务）

```
continuous_agg_refresh_batched (refresh.c:641)
  └─ continuous_agg_split_refresh_window 按 invalidation log 拆批次
  └─ continuous_agg_refresh_internal (refresh.c:996)
       Txn1: 注册刷新窗口 + 推进失效阈值 + 搬移 hyper→cagg 失效日志
       Txn2: invalidation_process_cagg_log 切割失效条目
       Txn3: collect_and_delete + continuous_agg_refresh_with_window
            └─ continuous_agg_update_materialization (materialize.c:137)
                 └─ execute_materializations DELETE+INSERT 或 MERGE
                 └─ update_watermark (materialize.c:716)
```

### 查询重写链

```
SELECT ... FROM raw_ht WHERE ...
  └─ continuous_agg_apply_rewrites (rewrite_with_caggs.c:980)
       └─ rewrite_query_with_caggs (行 744)
            ├─ match_query_to_cagg (行 288) 匹配 cagg（bucket 函数 + GROUP BY + WHERE + 聚合）
            │    安全条件: raw ht 无未处理失效 + cagg 无未处理失效 + 无 pending + 无 schema 变更
            └─ 替换 rtable 为 cagg view RTE → QueryRewrite 触发 PG 视图规则展开
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `cagg_create` (create.c:599) | 创建 cagg | 三层视图一次性建立 |
| `continuous_agg_refresh_internal` (refresh.c:996) | 刷新 | 三事务保证一致性 |
| `move_invalidations_from_hyper_to_cagg_log` (invalidation.c:730) | 搬移失效 | 按 bucket 扩展+合并相邻 |
| `rewrite_query_with_caggs` (rewrite_with_caggs.c:744) | 透明改写 | 安全条件检查避免读到未刷新数据 |

## 核心实现

### 三层视图架构

cagg 不是 PG 原生 matview，而是三层视图：**User View**（用户查的视图，real-time 模式是 `UNION ALL`(物化数据 + 原始数据)，materialized-only 模式直接查物化表）、**Partial View**（`_partial_view_<id>`，查 raw ht，用 `partialize()` 包装聚合函数存中间状态）、**Direct View**（`_direct_view_<id>`，存用户原始查询，用于 real-time 切换与 schema 变更恢复）。三层在 `cagg_create` 一次性建立。

### 两级失效日志与增量刷新

采用两级日志：**Hypertable Invalidation Log**（raw ht 级，所有 cagg 共享，DML 触发器写）→ **Cagg Invalidation Log**（每 cagg 独立，刷新时从 hyper log 搬移）。搬移时三步（`move_invalidations_from_hyper_to_cagg_log` invalidation.c:730）：按 bucket 边界扩展失效范围、合并相邻/重叠条目、每 cagg 独立复制。刷新时再按窗口切割失效条目。增量刷新只刷新失效范围，大幅减少 I/O。

### watermark：real-time 聚合的可见性边界

刷新涉及多事务，期间 raw ht 可能继续收新数据。watermark 是物化数据的上界标记：UNION 查询 `WHERE time < watermark` 查物化表，`WHERE time >= watermark` 查原始表。watermark 只在物化完成后更新（`update_watermark` materialize.c:716）保证一致性，**只增不减**，用 tuple-level locking 处理并发。`Invalidation Threshold` 解决写入放大——热数据区频繁插入，阈值之后不记失效（本来就要刷新），阈值在刷新时推进。

### 两阶段聚合（finalize）

`finalize.c` 把聚合分两阶段：**partialize**（partial view 中把 `agg(x)` 包装为 `partialize(agg(x))`，存中间 transition state 而非最终结果）→ **finalize**（user view 从物化表读中间状态用 `finalize()` 完成聚合）。原因：raw ht 一个数据点变更只需删/重算受影响 bucket 的中间状态而非整个范围。注意限制：物化数据不允许再聚合（groupClause 必须匹配），因为 finalize 后结果不能再 partialize。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 物化视图（三层） | create.c | 支持 real-time + 增量刷新 + schema 恢复 |
| 失效日志（两级） | invalidation.c | 增量刷新，只算变更范围 |
| 查询重写（透明改写） | rewrite_with_caggs.c | 用户查 raw ht 自动改写查 cagg |
| 两阶段聚合 | finalize.c partialize/finalize | 增量更新只需重算受影响 bucket |
| 水位线 | continuous_aggs_watermark | real-time 可见性边界 |

## 模块间交互

经 `CrossModuleFunctions` 的 `process_cagg_viewstmt`/`continuous_agg_refresh`/`continuous_agg_invalidate_raw_ht`/`continuous_agg_invalidate_mat_ht`/`continuous_agg_dml_invalidate`/`continuous_agg_apply_rewrites_tsl` 暴露；依赖 `ts_catalog` 的 `continuous_agg`/`continuous_aggs_watermark`/`*_invalidation_log`/`*_invalidation_threshold`/`*_bucket_function`/`*_jobs_refresh_ranges` 表；依赖 BGW 的 refresh policy（`policy_refresh_cagg_proc`）调度刷新；依赖 planner 的 `constify_cagg_watermark`/`cagg_sort_pushdown` 优化；`insert.c` 注册事务回调在 `PRE_COMMIT` 把内存失效缓存写 hyper log。

## 扩展方式

新增 bucket 函数：`common.c` 的 `function_allowed_in_cagg_definition`（行 112）允许 + `process_timebucket_parameters`（行 253）处理参数 + `create_bucket_function_catalog_entry`（create.c:186）写 catalog + `refresh.c` 的 `cagg_current_bucket_start`/`next_bucket_start` dispatch + `invalidation.c` 的 `invalidation_expand_to_bucket_boundaries` 处理边界。修改刷新策略：改 `continuous_agg_refresh`（refresh.c:735）解析 jsonb options（`buckets_per_batch`/`max_batches_per_execution`/`refresh_newest_first`）与 `continuous_agg_split_refresh_window`（行 1229）批次拆分。
