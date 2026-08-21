---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "查询规划器与自定义节点"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "PostgreSQL", "planner", "CustomScan"]
description: "TimescaleDB planner 钩子、hypertable 展开剪枝、ChunkAppend/ConstraintAwareAppend/ModifyHypertable 自定义 scan 节点解读"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

查询规划器模块负责把"对逻辑 hypertable 的查询/写入"翻译成"对物理 chunk 的扫描/写入计划"。它通过 PG 的 `set_rel_pathlist_hook`/`create_upper_paths_hook`/`planner_hook` 介入规划，用约束排除在**展开前**剪掉不相关 chunk，并用三个自定义 CustomScan 节点（ChunkAppend、ConstraintAwareAppend、ModifyHypertable）替换原生 Append/ModifyTable。这个模块决定了 TimescaleDB 查询性能的上限——chunk 数量再多也能快速剪枝。

## 模块架构

模块分两部分：planner 钩子层（`src/planner/`）与 Apache 自定义执行节点（`src/nodes/`）。

```
planner.c —— 钩子注册与拦截入口
  ├─ timescaledb_planner (planner.c:629)        preprocess_query + 链到 standard_planner
  ├─ timescaledb_set_rel_pathlist (planner.c:1477)  分类 RTE + 展开 + 路径优化
  └─ timescaledb_create_upper_paths_hook (planner.c:1946)  替换 ModifyTablePath + FIRST/LAST 优化
expand_hypertable.c —— hypertable → chunk 子表展开 + 范围排除
constify_now.c —— now() 常量化（时间查询剪枝前提）
agg_bookend.c —— FIRST/LAST 聚合优化
nodes/
  ├─ chunk_append/        ChunkAppend（并行扫描 + 启动/运行时排除 + LIMIT 下推）
  ├─ constraint_aware_append/  CAA（PG 约束排除的回退包装）
  └─ modify_hypertable.c / modify_hypertable_exec.c  ModifyHypertable（插入按行路由）
```

## 调用链路

### 查询规划链（SELECT）

```
timescaledb_planner (planner.c:629)
  ├─ preprocess_query (planner.c:395)
  │    ├─ ts_constify_now (constify_now.c:281)  now() → 常量
  │    └─ ts_cm_functions->continuous_agg_apply_rewrites_tsl（CAGG 透明改写）
  └─ standard_planner → 内部调 set_rel_pathlist_hook:
timescaledb_set_rel_pathlist (planner.c:1477)
  ├─ ts_classify_relation 判断 RTE 类型
  ├─ expand_all_hypertables (planner.c:1199)
  │    └─ ts_plan_expand_hypertable_chunks (expand_hypertable.c:1305)
  │         ├─ collect_quals_walker 收集 WHERE
  │         ├─ get_chunks (expand_hypertable.c:1110)
  │         │    └─ ts_hypertable_restrict_info_get_chunks  范围排除 → 命中 chunk
  │         └─ ts_expand_single_inheritance_child  逐 chunk 加 RTE
  └─ apply_optimizations (planner.c:1316)
       └─ 遍历 rel->pathlist:
            should_chunk_append? → ts_chunk_append_path_create
            should_constraint_aware_append? → ts_constraint_aware_append_path_create
```

### 插入执行链（INSERT）

```
create_upper_paths_hook → replace_modify_hypertable_paths (planner.c:1843)
  └─ ts_modify_hypertable_path_create (modify_hypertable.c:786)  CustomPath 包裹 ModifyTablePath
→ modify_hypertable_exec.c 的 ExecModifyTable 逐行:
  ts_hyperspace_calculate_point → chunk_tuple_routing_find_chunk → 写入
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `timescaledb_set_rel_pathlist` (planner.c:1477) | 拦截 RTE | 分类 hypertable/chunk/普通表 |
| `ts_plan_expand_hypertable_chunks` (expand_hypertable.c:1305) | 展开为 chunk | 展开前范围排除，避免全展开 |
| `ts_constify_now` (constify_now.c:281) | now() 常量化 | 时间查询剪枝前提，安全余量 |
| `chunk_append_exec` (chunk_append/exec.c:569) | ChunkAppend 执行 | 启动/运行时排除 + 并行协调 |

## 核心实现

### 为什么自己实现 ChunkAppend 而非用 PG 原生 Append

`expand_hypertable.c:7` 注释明确：PG 的 `expand_inherited_tables` 会展开所有 chunk 再对每个调 `get_relation_info`（打开文件取统计），chunk 多时极慢。TimescaleDB 方案是**先范围排除再展开**，只展开命中 chunk。此外 ChunkAppend 还提供：执行时动态排除（`do_runtime_exclusion` exec.c:473，对 join 参数驱动查询逐次剪枝）、并行协调（`ParallelChunkAppendState` 共享内存原子取子计划）、有序扫描与 LIMIT 下推（`should_order_append` 检测 ORDER BY 对齐时间维度则 chunk 按序排避免全局排序）。

### constify_now 优化

时间序列查询最常见模式 `WHERE time > now() - interval '1 hour'`。`now()` 是 stable 而非 immutable，PG 不在规划期求值，导致无法做 chunk 范围排除。`ts_constify_now`（constify_now.c:281）把它变换为 `time > now() AND time > <常量>`，常量部分供 `HypertableRestrictInfo` 剪枝。安全保证（constify_now.c:243）："宁可排除不够，不可排除过多"——留 4 小时夏令时余量，执行时用精确值再排除。

### 两级约束排除

- **规划时排除**：`expand_hypertable.c` 的 `get_chunks` 用 `HypertableRestrictInfo` 范围排除（非 PG 原生 `constraint_excluded_by_constraints`），展开前就排除。
- **执行时排除**（ChunkAppend 独有）：启动排除（`do_startup_exclusion` exec.c:216，mutable 函数常量化后排除）+ 运行时排除（参数变化时动态排除）。

`ConstraintAwareAppend` 是 ChunkAppend 不适用时（无 mutable 函数但仍可能受益）的后备，包装 PG 原生 Append 用 `relation_excluded_by_constraints` 排除。

### ModifyHypertableExec 的按需路由

`ChunkTupleRouting` 用 SubspaceStore 缓存 Point→ChunkInsertState，"每个 chunk 的 ResultRelInfo 按需创建，仅当实际路由元组到该 chunk 时"（chunk_tuple_routing.c 注释）。单行 `ExecInsert`（modify_hypertable_exec.c:658）逐行路由；批量 `ExecBatchInsert` 支持，SubspaceStore 限同时打开 chunk 数。`should_use_direct_compress`（modify_hypertable.c:264）检测直写压缩 chunk 路径。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| CustomScan 自定义节点 | ChunkAppend/CAA/ModifyHypertable | 复用 PG 执行器框架注入自定义逻辑 |
| 上层规划钩子 | `create_upper_paths_hook` | 替换 ModifyTablePath、FIRST/LAST 优化 |
| 两级约束排除 | 规划时 + 执行时 | 展开前 + 参数变化时双重剪枝 |
| 并行协调 | `ParallelChunkAppendState` | 多 worker 原子取子计划 |

## 模块间交互

planner 调 hypertable（`ts_planner_get_hypertable`）、chunk（`ts_chunk_get_hypertable_id_by_reloid`）、dimension_slice（剪枝）；nodes 在 executor 层被调用，调 chunk_tuple_routing 路由；通过 `ts_cm_functions` 委托 TSL 的 planner 增强（`set_rel_pathlist_query` 处理压缩 chunk 路径、`create_upper_paths_hook` TSL 上层路径、`tsl_postprocess_plan` 注入 ColumnarScan/VectorAgg、`decompress_target_segments` DML 前解压）。

## 扩展方式

新增自定义 scan 节点：继承 `CustomPath`/`CustomScanState`，实现三层方法（`CustomPathMethods`/`CustomScanMethods`/`CustomExecMethods`），在 `apply_optimizations` 的 pathlist 遍历中对合适 AppendPath 调 `*_path_create` 替换。新增 planner 重写规则：在 `preprocess_query`（planner.c:395）或 `timescaledb_create_upper_paths_hook`（行 1946）加调用，TSL 需要支持则加 `cross_module_fn` 函数指针。
