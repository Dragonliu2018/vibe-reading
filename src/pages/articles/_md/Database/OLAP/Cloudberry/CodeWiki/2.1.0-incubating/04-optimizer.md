---
source:
  type: "源码解读"
  project: "Cloudberry"
  url: "https://github.com/apache/cloudberry"
title: "查询优化器"
date: "2026-08-20T11:29:59+08:00"
category: [Database, OLAP, Cloudberry, CodeWiki, "2.1.0-incubating"]
tags: ["Cloudberry", "C/C++", "MPP", "并行查询", "物化视图", "优化器"]
description: "Cloudberry optimizer 模块——PostgreSQL 标准 planner 之上叠加两项原创能力：CBDB 风格并行查询（所有 worker 平等协作）与 AQUMV（planning 期物化视图改写）。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/00-overview)

---

## 模块定位

`src/backend/optimizer/` 是 Cloudberry 的查询优化器层，包含三个层次：**PostgreSQL 标准 planner**（路径生成 + 代价估计 + 计划创建，继承自 PG 14 上游）、**CBDB 风格并行查询**（Cloudberry 独创——所有 worker 平等协作、按 `parallel_workers` 扩展 Gang）、**AQUMV**（Answer Query Using Materialized Views，Cloudberry 独创——planning 期用增量物化视图改写查询）。

后两项是 Cloudberry 区别于 Greenplum 的核心原创能力，各有设计文档 `README.cbdb.parallel` 与 `README.cbdb.aqumv`。本模块与 GPORCA（`gporca/`，经 `gpopt/` 桥接入）是**互斥选择**关系：`optimizer=on` 时 QD 先尝试 ORCA，失败才 fallback 到 PG planner；CBDB 并行与 AQUMV 都在 PG planner 路径内。子目录：`path/`（路径生成 + 代价）、`plan/`（计划创建 + AQUMV + ORCA 桥 `orca.c`）、`prep/`（预处理）、`geqo/`（遗传算法优化 join 顺序）、`util/`（工具）。

## 模块架构

```text
planner.c
  └─ standard_planner()                              入口
       ├─[optimizer=on & QD]─ optimize_query()  ─── orca.c ──→ gpopt ──→ gporca(ORCA)
       │                         └─ 失败 fallback ↓
       └─ subquery_planner()                           PG planner 路径
            ├─ pull_up_sublinks/queries, preprocess    prep/
            └─ grouping_planner()                      planner.c
                 ├─ preprocess_targetlist/aggrefs
                 ├─ query_planner() ─── planmain.c     底层 join 路径生成
                 │    └─ make_one_rel() ─── allpaths.c
                 │         ├─ set_base_rel_pathlists() (compute_parallel_worker → CBDB 并行度)
                 │         └─ make_rel_from_joinlist() (cdbpath_motion_for[_parallel]_join)
                 ├─ answer_query_using_materialized_views() ── AQUMV ──→ gp_matview_aux
                 ├─ create_grouping/window/distinct/ordered_paths()
                 ├─ cdbllize_adjust_top_path()         调整最终路径 Locus
                 ├─ create_plan()                      Path→Plan
                 └─ set_plan_references()
```

PG planner 主线是标准的 `subquery_planner → grouping_planner → query_planner → make_one_rel`，Cloudberry 的加法穿插其中：`make_one_rel` 生成 base rel 路径时调 `compute_parallel_worker` 算 CBDB 并行度并写入 `CdbPathLocus`；join 路径生成时用 `cdbpath_motion_for_parallel_join` 在并行侧插入 Motion；`query_planner` 之后调 `answer_query_using_materialized_views` 做 AQUMV 改写；最终 `cdbllize_adjust_top_path` 调整顶层路径 Locus。

## 调用链路

### 标准 planner 主链

```text
planner() in planner.c:326                          [Query*]
  └─ standard_planner() in planner.c:356
       ├─ optimize_query() in orca.c:202   [optimizer=on & QD → gpopt → ORCA, 失败 fallback]
       └─ subquery_planner() in planner.c:889        [PlannerInfo*]
            ├─ pull_up_sublinks/queries, preprocess_expression()
            └─ grouping_planner() in planner.c:1610
                 ├─ preprocess_targetlist/aggrefs()
                 ├─ query_planner() in planmain.c:63  [RelOptInfo*]
                 │    └─ make_one_rel() in allpaths.c:182
                 │         ├─ set_base_rel_pathlists()  (compute_parallel_worker → Locus)
                 │         └─ make_rel_from_joinlist()  (cdbpath_motion_for_join)
                 ├─ answer_query_using_materialized_views() in planner.c:1937  [AQUMV]
                 ├─ create_grouping/window/distinct/ordered_paths()
                 ├─ cdbllize_adjust_top_path() in planner.c:615
                 ├─ create_plan() in planner.c:618    [Plan*]
                 └─ set_plan_references()
```

### CBDB 并行：parallel_workers 如何设置与 Gang 扩展

```text
compute_parallel_worker(rel) in allpaths.c:4696    [int 并行度]
  ├─ 表有 rel_parallel_workers reloption? → 用它
  ├─ heap? → 按 pages 对数计算
  └─ AO/AOCO 表? → 按 pg_appendonly.segfilecount 计算  in allpaths.c:4710-4737

create_plain_partial_paths(rel) in allpaths.c:1083
  └─ compute_parallel_worker(rel) > 1? → add_partial_path(并行 seqscan)

create_seqscan_path(...) in pathnode.c:1026        [Path*]
  ├─ pathnode->parallel_aware = (parallel_workers > 0)
  ├─ pathnode->locus = cdbpathlocus_from_baserel(root, rel, parallel_workers)
  └─ pathnode->parallel_workers = pathnode->locus.parallel_workers

cdbpathlocus_from_baserel() in cdbpathlocus.c:383 → cdbpathlocus_from_policy() in cdbpathlocus.c:323
  ├─ Hashed 分布 & parallel_workers > 1 → CdbPathLocus_MakeHashedWorkers  in cdbpathlocus.c:345
  ├─ Replicated & parallel_workers > 1 → CdbPathLocus_MakeSegmentGeneralWorkers  in cdbpathlocus.c:368
  └─ parallel_workers <= 1            → 普通 Hashed / SegmentGeneral

并行 join：pathnode.c:3891
  ├─ isParallel = (outer_path->locus.parallel_workers > 1 || inner_path->locus.parallel_workers > 1)
  ├─ !isParallel → cdbpath_motion_for_join(...)
  └─ isParallel  → cdbpath_motion_for_parallel_join(...) in cdb/cdbpath.c:2978
                    └─ cdbpathlocus_parallel_join() in cdbpathlocus.c:1227  (两侧 parallel_workers 不同→Redistribute)
```

Gang 扩展总量由宏 `CdbPathLocus_NumSegmentsPlusParallelWorkers`（`cdbpathlocus.h:172`）表达：`numsegments * parallel_workers`。例如 README 例子中 `t1(parallel_workers=3)` 在 3 segments 上 → 9 个 worker 进程，`t2(parallel_workers=2)` → 6 个，Gather Motion 6:1 汇聚。深入机制见 [CBDB 并行查询机制详解](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer-cbdb-parallel)。

### AQUMV：planning 期物化视图改写

```text
grouping_planner() in planner.c:1928-1941
  ├─ Gp_role == GP_ROLE_DISPATCH && enable_answer_query_using_materialized_views?
  │    └─ answer_query_using_materialized_views(root, ctx) in aqumv.c:133   [单表]
  │         ├─ 排除：非SELECT/rowMarks/scatterClause/cteList/setOperations/WindowFuncs/SubLinks  in aqumv.c:164-177
  │         ├─ 限定单关系 (fromlist 长度1且 RangeTblRef)  in aqumv.c:179-189
  │         ├─ 扫描 gp_matview_aux 系统表(OID 7153)  in aqumv.c:220-226
  │         ├─ MV 有效性：RelationIsPopulated && (RelationIsIVM || MatviewIsGeneralyUpToDate)  in aqumv.c:251-253
  │         ├─ 反序列化 view_query = stringToNode(gp_matview_aux.view_query)  in aqumv.c:258-265
  │         ├─ 同一关系：mvrte->relid == origin_rel_oid  in aqumv.c:320
  │         ├─ Construct Rows：差集 {mv_quals - query_quals} 非空→false  in aqumv.c:774
  │         ├─ Construct Columns：aqumv_process_targetlist + aqumv_adjust_sub_matched_expr_mutator  in aqumv.c:868
  │         └─ Cost-based：query_planner(subroot) → 比 cheapest_total_path->total_cost  in aqumv.c:571-578
  └─ 单表未改写? → （2.1.0 的 AQUMV 到此为止；多表 Join 精确匹配 `answer_query_using_materialized_views_for_join` 为 `main` 分支后续新增，2.1.0 未含）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `standard_planner` in `planner.c:356` | PG planner 入口，选 ORCA 或 PG 路径 | ORCA 失败 fallback，保证可用性 |
| `grouping_planner` in `planner.c:1610` | 预处理 + 路径生成 + AQUMV 改写 | AQUMV 嵌在 query_planner 之后 |
| `compute_parallel_worker` in `allpaths.c:4696` | 算 CBDB 并行度 | AO 表按 segfilecount，区别于 PG 按 pages |
| `cdbpathlocus_from_policy` in `cdbpathlocus.c:323` | 由分布策略+并行度设 Locus 类型 | `parallel_workers>1` → HashedWorkers 等 |
| `answer_query_using_materialized_views` in `aqumv.c:133` | 单表 MV 改写 | MVP0 清空 eq_classes，只做逻辑转换 |
| `aqumv_process_from_quals` in `aqumv.c:750` | 验证 Construct Rows（差集判空） | 用 list_difference，不用等价类 |

</details>

## 核心实现

### 标准 planner 与 Locus 抽象

PG planner 把查询优化成 Plan 树，中间用 `Path`（路径）描述一种执行方式、`RelOptInfo` 维护每个关系的 `pathlist`（完整路径）和 `partial_pathlist`（并行路径）。Cloudberry 给每个 `Path` 加了一个 `CdbPathLocus` 字段（`src/include/cdb/cdbpathlocus.h:154`）描述元组在 segment 间的分布：

```c title="src/include/cdb/cdbpathlocus.h"
typedef struct CdbPathLocus
{
    CdbLocusType locustype;
    List     *distkey;          /* 分布键 */
    int       numsegments;     /* segment 数 */
    int       parallel_workers; /* 并行 worker 数 */
} CdbPathLocus;
```

这是 CBDB 并行的根基——并行度不是只在 `Path.parallel_workers` 上，而是**嵌进 Locus 类型**里。`CdbPathLocus_NumSegmentsPlusParallelWorkers` 宏（`:173`）算总进程数 `numsegments * parallel_workers`。关键并行 Locus 类型：`CdbLocusType_Hashed`（hash 分布在所有 segment）、`CdbLocusType_HashedWorkers`（hash 分布在 segment，但每个 segment 的 M 个 worker 间再分区）、`CdbLocusType_SegmentGeneralWorkers`、`CdbLocusType_ReplicatedWorkers`。`cdbpathlocus.c:100-102` 注释强调"HashedWorkers will never be equal"——两个 HashedWorkers locus 永不判等，强制走 Motion 协调，避免数据错配。

### CBDB 风格并行查询

`README.cbdb.parallel` 开宗明义：PostgreSQL 的 Gather/GatherMerge 会"launch any number of workers to execute a plan as a leader process"，而 **Apache Cloudberry doesn't have that——treats all workers equally**。CBDB 的 worker 像启动非并行计划一样启动，只是当顶层路径节点的 `parallel_workers > 1` 时按因子扩展 Gang 规模。worker 间用同步机制协作（如建共享哈希表）。具体机制与"为什么不用 PG Gather leader"的三条原因见 [深度解读附件](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer-cbdb-parallel)。

代码上 CBDB 关掉了 PG 风格的 Gather 路径生成：`planner.c:8436` 的 `gather_grouping_paths` 直接 `Assert(false)`；`planner.c:8623-8626` 的 `generate_useful_gather_paths` 被 `#if 0` 包裹；`planner.c:603-609` 则把 partial_pathlist 保留到最终阶段才与 pathlist 合并选最优（注释 "Unlike upstream, partial_path is valid in GP without Gather nodes"）。这让 partial path 能在后续 join 中作为 parallel_aware hash join 的 outer，而 PG 在 `apply_scanjoin_target_to_paths` 就清空了它。

### AQUMV：基于代价的等价转换

`README.cbdb.aqumv` 给出 MV 能改写查询的三个条件：**Construct Rows**（MV 含查询所需的全部行）、**Construct Columns**（查询输出可从 MV 输出计算）、**Cost-based Equivalent Transformation**（可能有多个合法 MV 候选，或从 MV 查不一定比从原表查便宜，让 planner 选最优）。`aqumv.c` 是 MVP0 实现，只用 Query 树做逻辑转换，不用等价类/约束（`aqumv.c:345` 显式 `subroot->eq_classes = NIL`）——简化实现、避免误导性 filter、防止引用 MV 不存在的列。

核心数据来自系统表 `gp_matview_aux`（OID 7153，`src/include/catalog/gp_matview_aux.h:40-51`），存每个 MV 的序列化 `view_query` 和数据状态 `datastatus`（`u`/`e`/`r`/`i`）。`Construct Rows` 用 `list_difference({mv_quals}, {query_quals})` 判空——MV 的 WHERE 必须比查询的 WHERE 更松（差集为空说明 MV 含查询所需全部行）；`post_quals` 取反向差集 `{query_quals - mv_quals}` 作为加到 MV 上的额外过滤（`aqumv.c:776`）。`Construct Columns` 用 `aqumv_adjust_sub_matched_expr_mutator` 递归改写表达式，把查询输出列映射到 MV 的列。最后调 `query_planner(subroot)` 生成 MV 路径，比较 `total_cost` 决定是否采纳——这是真正的"基于代价的等价转换"，不是无脑改写。要求 IMV（`aqumv.c:251-253`）是因为 planning 期改写成 `SELECT FROM mv`，若 MV 数据过期结果就错了；IMV 在基表写入时自动增量更新保证实时。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| CBDB "all workers equal" 并行 | `planner.c:603-609` 保留 partial_pathlist；`cdbpathlocus.c` HashedWorkers | 让 worker 拥有完整 QE 上下文（分布式事务/快照/角色），避免 PG Gather leader 缺上下文问题 |
| 基于代价的等价转换 | `aqumv.c:571-578` 比 `total_cost` | 多个合法 MV 候选或原表有索引更便宜时，让 planner 选最优，不无脑改写 |
| Locus 驱动的计划改写 | `CdbPathLocus` + `cdbpath_motion_for_join` | 用分布属性抽象统一决定何时插 Motion，MPP 并行性集中表达 |
| 策略回退（fallback） | `standard_planner` ORCA 失败→PG planner | ORCA 不支持某些语句/场景，回退保证可用性 |
| 遗传算法优化（GEQO） | `geqo/` 表数超 `geqo_threshold` 时 | 穷举 join 顺序组合爆炸，遗传算法近似求解 |

## 模块间交互

`optimizer` 与四个模块协作：**`cdb`**——Locus 概念定义在 `cdbpathlocus.h`（属 cdb），optimizer 通过 `cdbpathlocus_from_baserel`/`cdbpath_motion_for_join`/`cdbllize_adjust_top_path` 与 cdb 协作插 Motion、定 Locus；**`gpopt`+`gporca`**——`orca.c:202` 的 `optimize_query` 经 gpopt 桥调 ORCA，互斥选择；**`executor`**——`create_plan` 产 Plan 树（含 `flow` 字段由 `cdbpathtoplan_create_flow` 设）交执行器，`parallelModeNeeded` 标志决定是否并行模式；**`catalog`**——AQUMV 读 `gp_matview_aux` 系统表的 `view_query`/`datastatus`，`InsertMatviewAuxEntry`（`gp_matview_aux.c:168`）在创建 MV 时写入。CBDB 并行与 ORCA 完全独立——ORCA 有自己的并行计划生成（`CPhysicalMotionGather` 等），不走 CBDB 的 Locus/parallel_workers 机制。

## 扩展方式

- **新增一种 AQUMV 改写规则**（如支持 Sublink/Join MV）：放宽 `aqumv.c:164-177` 的排除条件（移除 `hasSubLinks` 排除）；在 `aqumv_process_from_quals`（`:750`）增加跨关系 qual 比较（当前注释说明只支持单关系）；在 `aqumv_adjust_sub_matched_expr_mutator`（`:785`）处理 `makeVar` 的 varno（当前硬编码 `1`，`:805`）。
- **调整 parallel_workers 计算**：改 `allpaths.c:4696` 的 `compute_parallel_worker`（如对特定存储格式调整）；改 `cdbpathlocus.c:323` 的 `cdbpathlocus_from_policy` 改 `parallel_workers > 1` 分支；改 `costsize.c:364` 的并行代价估计。
- **新增并行路径类型**（如并行 IndexOnlyScan）：在 `pathnode.c` 仿 `create_seqscan_path`（`:1026`）新建 `create_xxxscan_path` 设 `parallel_aware`/`parallel_workers`/`locus`；在 `allpaths.c` 的 `set_rel_pathlist` 调用；必要时改 `cdb/cdbpath.c:2978` 的 `cdbpath_motion_for_parallel_join`。
