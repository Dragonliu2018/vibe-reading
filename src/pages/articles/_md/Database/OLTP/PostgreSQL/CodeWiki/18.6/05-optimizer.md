---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "查询优化器"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "optimizer", "planner", "GEQO", "代价模型", "EquivalenceClass"]
description: "PostgreSQL optimizer 模块——Path/Plan 两阶段架构、代价模型 GUC、DP+GEQO 连接枚举、等价类约束传播、Hook 扩展"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`src/backend/optimizer/` 是基于代价的查询优化器。接收重写后的 `Query` 树，生成最优执行计划（`Plan` 树）。核心挑战是多表连接顺序是 NP-hard——需在可接受时间内找到近似最优计划。PostgreSQL 的解法是 Path/Plan 两阶段：先轻量探索大量 Path（代价估算），仅最优 Path 转重量级 Plan。

---

## 模块架构

5 个子目录：`plan/`（`planner.c` 9276 行 + `createplan.c` + `setrefs.c` 等）、`path/`（`allpaths.c` 5151 行 + `costsize.c` 6807 行 + `equivclass.c` + `joinpath.c`/`joinrels.c`）、`geqo/`（`geqo_main.c` + 遗传算子）、`prep/`（`prepjointree.c` 子查询上拉等）、`util/`（`pathnode.c`/`clauses.c`/`plancat.c`）。

---

## 调用链路

```
[tcop/postgres.c] pg_plan_queries → planner()
  → [planner.c:300] planner() → standard_planner()
      → [planner.c:664] subquery_planner()   # 预处理 + 主规划
          ├── pull_up_sublinks / pull_up_subqueries   # 子查询上拉
          ├── reduce_outer_joins                          # 外连接降级
          └── grouping_planner()
                → [planmain.c:54] query_planner()
                    → [allpaths.c] make_one_rel()   # 生成所有访问路径
                        ├── set_baserel_pathlists()
                        └── make_rel_from_joinlist()
                              ├── standard_join_search()  # DP（表数<geqo_threshold）
                              └── geqo()                    # 遗传算法（表数>=12）
      → create_plan()   # 最优 Path → Plan
      → set_plan_references()
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `planner`/`standard_planner` | 优化总入口 | hook 可替换整个 planner |
| `subquery_planner` | 预处理 + 调度 | 10 步预处理（子查询上拉/外连接降级等） |
| `query_planner` | scan/join 层规划 | 等价类构建 + 路径生成 |
| `make_one_rel` | 生成所有访问路径 | 基表路径 + 连接枚举 |
| `create_plan` | Path→Plan 转换 | 仅最优 Path 转 Plan |
| `add_path` | Path 多维支配 | 代价/pathkeys/param/rows 四维比较 |

---

## 核心实现

### Path/Plan 两阶段架构

**Path 是轻量探索对象**，只记元信息：代价（`startup_cost`/`total_cost`）、排序顺序（`pathkeys`）、参数化（`param_info`）、并行属性、行数估计。**Plan 是重量级可执行对象**，含完整 targetlist、qual 表达式、左右子树、运行时状态。

```c
// src/include/nodes/pathnodes.h:1964
typedef struct Path {
    NodeTag type;
    NodeTag pathtype;         // 扫描/连接方法
    RelOptInfo *parent;       // 所属关系
    PathTarget *pathtarget;   // 输出表达式
    Cost startup_cost;        // 获取第一行前代价
    Cost total_cost;          // 总代价
    List *pathkeys;           // 排序键
    int disabled_nodes;        // 被禁用节点计数
} Path;
```

为什么分两层：优化器为同一关系可能生成数十上百条 Path（不同扫描/连接/参数化），若每条都生成完整 Plan 规划时间不可接受。只有最终 `get_cheapest_fractional_path` 选出最优 Path 后，才 `create_plan`（`createplan.c:337`）递归转 Plan。

### 代价模型

代价参数全 GUC 可调（`costsize.c:130-142`）：

```c
double seq_page_cost = 1.0;            // 顺序读页代价
double random_page_cost = 4.0;         // 随机读页代价
double cpu_tuple_cost = 0.01;          // 每元组 CPU
double cpu_index_tuple_cost = 0.005;   // 每索引元组
double cpu_operator_cost = 0.0025;     // 每运算符
int   effective_cache_size = 4GB;       // 有效缓存大小（影响随机 IO 估算）
```

每条 Path 算两个独立代价：`startup_cost`（获取第一行前）和 `total_cost`（全部行）。LIMIT/EXISTS 场景通过插值估算部分结果代价：`actual_cost = startup + (total-startup)*tuples_to_fetch/rows`。

**disabled_nodes 计数**替代旧版「加 `disable_cost=1e10` 常数」方案（`costsize.c:53` 注释解释旧方案扭曲后续比较）。`enable_xxx` GUC（`enable_seqscan`/`enable_nestloop` 等）维护 `disabled_nodes` 计数，比较时 `disabled_nodes` 差异优先于一切代价（`pathnode.c:70`）。

### 连接顺序枚举

**动态规划** `standard_join_search`（`allpaths.c:3461`）：经典自底向上——Level 1 所有单表，Level N 从 Level-(N-1)+Level-1 组合，每层 `set_cheapest` 选最优。

**GEQO 遗传算法**（`geqo_main.c:74`）触发条件 `levels_needed >= geqo_threshold`（默认 12，`allpaths.c:3915`）。DP 复杂度 O(3^n) 在 n>12 不可行，GEQO 将连接顺序建模为类 TSP 排列优化：基因编码=关系编号排列，交叉用 ERX（Edge Recombination Crossover），适应度=`geqo_eval` 解码为实际 join 树算代价。池大小/迭代数按关系数自适应。

### 等价类与约束传播

`EquivalenceClass`（`pathnodes.h:1653`）是优化器核心。`deconstruct_jointree` 对每个 `a.x = b.y` 等值约束调 `process_equivalence`（`equivclass.c:179`）将两侧加入同一 EC 或合并 EC。`generate_base_implied_equalities`（`equivclass.c:1188`）推导隐含约束——若 `a.x=b.y` 且 `b.y=c.z`，自动推导 `a.x=c.z`，让优化器选原本不可见的 join 路径。

等价类的价值：**连接条件推导**（选不可见 join 路径）、**消除冗余排序**（canonical pathkeys 使 `ORDER BY a.x` 与 `ORDER BY b.y`（当 a.x=b.y）产生相同 pathkey）、**外连接降级**（`reduce_outer_joins`）、**消除无用连接**（`remove_useless_joins`）。

### Path 选择：add_path 多维支配

`add_path`（`pathnode.c:464`）当新 Path 加入时与已有 Path 在四维比较：代价（fuzzy `STD_FUZZ_FACTOR=1.01`）、pathkeys、required_outer、rows。只有一 Path 在所有维度不劣于另一才支配；各有优势则都保留——确保 LIMIT vs 全量物化等不同场景都有最优选择。

### 关键数据结构

- **PlannerInfo**（`pathnodes.h:302`）：全局优化上下文，每 Query 级一个。含 `simple_rel_array[]`（RelOptInfo 数组）、`eq_classes`、`canon_pathkeys`、`join_info_list`（外连接顺序约束）。
- **RelOptInfo**（`pathnodes.h:1009`）：每关系优化信息。含 `pathlist`（所有 Path）、`cheapest_startup_path`/`cheapest_total_path`、`baserestrictinfo`、`indexlist`、`pages`/`tuples`（统计）。
- **Plan**（`plannodes.h`）：执行计划节点，与 Path 一一对应但含完整执行细节。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两阶段探索 | Path→Plan | 轻量探索大量路径，仅最优转 Plan |
| 多维支配 | `add_path` 四维 | 不同场景（LIMIT/全量）各有最优 |
| 遗传算法 | GEQO | NP-hard 连接顺序可控代价近似最优 |
| 钩子 | `planner_hook`/`join_search_hook`/`set_rel_pathlist_hook` | 第三方（Citus 等）替换优化环节 |

---

## 模块间交互

optimizer 依赖 `nodes`（Path/Plan 定义）、`utils`（代价 GUC）、`catalog`（`plancat.c` 查 `pg_class` pages/tuples + `pg_statistic` 直方图/MCV/相关性统计）、`selfuncs.h`（选择性估算 `eqsel`/`eqjoinsel`）。被 tcop `pg_plan_queries`→`pg_plan_query`→`planner` 调用。代价估算引用 executor 常量（`nodeAgg.h`/`nodeHash.h`）。

---

## 扩展方式

**新增 Join Path 类型**（如 BroadcastJoin）：`pathnodes.h` 加 `BroadcastPath` 继承 `JoinPath` → `joinpath.c add_paths_to_joinrel` 加路径生成 → `costsize.c` 加 `initial/final_cost_broadcastjoin` → `createplan.c create_plan_recurse` 加 `T_BroadcastJoin` case → `plannodes.h` 加 Plan 节点 → executor 侧加执行节点。

**调整代价模型**：全局改 `costsize.c:130-142` 默认值或 `postgresql.conf` GUC；per-tablespace 覆盖用 `get_tablespace_page_costs()`（SSD 可降 `random_page_cost`）。

**新增优化规则**：`subquery_planner` 加预处理步骤（如条件下推到 CTE）→ 涉及等值推导则扩展 `equivclass.c process_equivalence`/`generate_base_implied_equalities` → 涉及 join 消除则 `analyzejoins.c` 加逻辑 → 可插件化则用 `set_rel_pathlist_hook`/`create_upper_paths_hook` 注入。
