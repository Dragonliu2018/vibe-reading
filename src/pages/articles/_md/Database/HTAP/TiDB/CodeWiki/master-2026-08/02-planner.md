---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "查询优化器"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "查询优化"]
description: "TiDB 查询优化器解读：Volcano 与 Cascades 双框架、RBO/CBO 分层、三级 Plan Cache 与 SPM"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/planner/` 把名字解析后的 AST 编译为代价最优的物理计划。它是 TiDB 中"决策"与"执行"的分离点：物理计划（`base.Plan`）既是 executor 构建算子的输入，也是下推到 TiKV/TiFlash 的 `tipb.DAGRequest` 的来源。本快照的一个重要事实：**Cascades 已重构为多子包**（`pkg/planner/cascades/{memo,rule,task,impl,...}`），旧实现移入 `cascades/old/`，接口全部迁到 `pkg/planner/core/base/`——很多 2024 年前的资料已经过时。

## 模块架构

```
pkg/planner/
├── optimize.go               # Optimize 总入口（plan cache 三级路径都在这）
├── core/
│   ├── base/                 # Plan 三接口 + Task（跨包共享的接口层）
│   ├── preprocess.go         # ast.Visitor 名字解析/校验
│   ├── planbuilder.go        # AST → LogicalPlan（Build 大分发）
│   ├── logical_plan_builder.go  # buildSelect 等细粒度构建
│   ├── optimizer.go          # doOptimize 分叉：Volcano / Cascades
│   ├── find_best_task.go     # Volcano 物理搜索核心（memoization）
│   ├── rule_*.go             # 逻辑优化规则（谓词下推、列裁剪、join reorder...）
│   ├── plan_cache.go / plan_cache_lru.go   # 计划缓存命中与 LRU
│   └── cascades → ../cascades
├── cascades/                 # 新框架：memo/ rule/ task/ impl/（old/ 为旧实现）
├── memo/                     # Group / GroupExpression
├── cardinality/              # 行数估算（Selectivity，消费 statistics）
└── bindinfo/                 # SPM：SQL Binding（见统计篇附注）
```

## 调用链路

```
planner.Optimize                                    optimize.go:141
├─ OptimizeExecStmt → GetPlanFromPlanCache          # ① prepared plan cache
├─ getPlanFromNonPreparedPlanCache (optimize.go:68) # ② 常量参数化 → 复用 ①
├─ optimizeNoCache (optimize.go:223)                 # ③ 全新优化
│   ├─ hint.ParseStmtHints / TryFastPlan（PointGet 快路径）
│   ├─ bindinfo.MatchSQLBinding → hint.BindHint      # SPM 命中则注入 hint
│   └─ optimize (optimize.go:716)
│       ├─ buildAndOptimizeLogicalPlanRound          # PlanBuilder.Build → LogicalPlan
│       │   └─ alternativeRounds (optimize.go:652)   # 多轮逻辑构建按 cost 竞争
│       └─ core.DoOptimize → doOptimize (optimizer.go:333)
│           ├─ VolcanoOptimize (optimizer.go:375)     # tidb_enable_cascades_planner=off（默认）
│           │   ├─ logicalOptimize (:1073)            # RBO：规则列表+位 flag 迭代
│           │   ├─ physicalOptimize (:1114)           # CBO：RecursiveDeriveStats
│           │   │   └─ physicalop.FindBestTask        # find_best_task.go:604
│           │   └─ postOptimize (:463)                # 投影消除/runtime filter
│           └─ CascadesOptimize (optimizer.go:342)
│               ├─ normalizeOptimize → ExtractFD
│               ├─ cascades.NewOptimizer (cascades.go:35) → memo.Init
│               ├─ task 栈驱动：OptGroupTask → ApplyRuleTask
│               └─ impl.ImplementMemoAndCost (impl_and_cost.go:66)
```

| 阶段 | 输入 → 输出 | 关键决策 |
| --- | --- | --- |
| ①②③ cache 探测 | `[]ast.StmtNode` → `base.Plan` | 命中即跳过全部优化 |
| 逻辑优化 | `LogicalPlan` → `LogicalPlan` | 纯启发式（RBO），规则可重跑 |
| 物理优化 | `LogicalPlan` → `PhysicalPlan` | 代价驱动（CBO），taskMap 记忆化 |
| postOptimize | `PhysicalPlan` → `PhysicalPlan` | 投影消除、runtime filter 注入 |

## 核心实现

### Volcano：隐式 memoization 的自底向上搜索

`FindBestTask` in `pkg/planner/core/find_best_task.go:604` 是整个优化器的发动机：对每个逻辑节点按要求的 `PhysicalProperty`（排序等）穷举物理实现（`exhaustPhysicalPlans`），代价记忆化挂在逻辑节点自身的 taskMap 上，必要处加 Sort/Limit 等 enforcer。逻辑优化规则（`logicalOptimize` in `core/optimizer.go:1073`）用**位标志驱动**：`optRuleFlags`（`optimizer.go:88-160`）在 PlanBuilder 构建期按算子置位，优化循环只跑置位的规则——避免每条 SQL 全量跑几十条规则。RBO 与 CBO 的分工就在这一层：`logicalOptimize` 全是启发式改写（谓词下推、列裁剪），`physicalOptimize` 才查统计信息算代价。

物理搜索前还有一道**帕累托剪枝**：`skylinePruning`（`find_best_task.go`）对 `DataSource` 的多条访问路径按"所需扫描行数 / 回表代价 / 前缀匹配长度"三个维度做 skyline 比较（`compareCandidates`）——若路径 A 在所有维度都不劣于 B 且至少一维严格更优，B 直接淘汰，连代价模型都不用跑。这在索引众多的大表上是关键的性能护栏。另一条值得展开的规则是 **join reorder**：`JoinReOrderSolver`（`pkg/planner/core/rule_join_reorder.go`）按表数自动切换两档算法——小规模用贪心（`baseSingleGroupJoinOrderSolver`），大规模用 DP（`rule_join_reorder_dp.go`）；LEADING hint 不适用于 DP 档时会经 `SetHintWarning` 告警降级，而非静默忽略。

### Cascades：显式 memo 与 task 栈

Cascades 框架把逻辑等价类显式建模为 `Group`（`pkg/planner/cascades/memo/group.go:35`，持 `logicalExpressions` + `bestPhysicalMap`）与 `GroupExpression`（`group_expr.go:40`，内嵌 `LogicalPlan` + `Inputs []*Group`），`hash2GroupExpr` 去重形成森林式 `Memo`。搜索不再是递归调用栈，而是 `SimpleTaskScheduler` 驱动显式 `Stack`（`cascades/task/task.go`）上的任务序列：`OptGroupTask → OptGroupExprTask → ApplyRuleTask`（`ruleMask` BitSet 控制规则应用）。实现/ costing 阶段 `impl.ImplementMemoAndCost` 内部**复用 Volcano 的 `FindBestTask`**——两套框架共享物理算子与代价模型，差异只在逻辑空间的探索方式。当前由 `tidb_enable_cascades_planner`（`pkg/sessionctx/vardef/tidb_vars.go:548`）控制，默认关闭，实验特性；`normalizeOptimize` 先抽取"恒优"规则（如 always-good 的谓词处理），是旧规则向新框架迁移的中间态。

### Plan Cache 三级路径与非 prepared 参数化

`Optimize` in `optimize.go:141` 依次尝试三条路径：**prepared plan cache**（`GetPlanFromPlanCache`，以 `PlanCacheStmt` 为 key）→ **non-prepared plan cache**（`getPlanFromNonPreparedPlanCache`，`optimize.go:68`：对无占位符的普通 SQL 做**常量参数化**（`GetParamSQLFromAST`）生成参数化 SQL，miss 时重新解析生成新 AST——刻意不污染原 AST（`optimize.go:107` 注释）——再走同一套 prepared 命中机制）→ **全新优化**。命中后由 `core.GetPlanFromPlanCache`（`core/plan_cache.go:205`）重建参数并校验 binding 一致性。这套设计的动机：绝大多数业务 SQL 不用 prepared protocol，但字面量不同的相似 SQL 极多；参数化复用让它们也吃到计划缓存，受 `TiDBPlanCacheStrategyHintOnly` 策略管控。`alternativeRounds`（`optimize.go:652`）是本快照的新机制：decorrelate、order-aware join reorder 等可能负优化的改写，各构建一轮逻辑计划，最后按 cost 竞争择优。

### hint 与 SPM

hint 在 PlanBuilder 构建期消费（`ParseStmtHints` + QBHintHandler），hint 语法见 [01-parser](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/01-parser)。SPM（`pkg/bindinfo`）在 `optimizeNoCache` 早期介入：`MatchSQLBinding`（`bindinfo/binding.go:137`）按 normalize 后的 SQL digest 匹配 `mysql.bind_info`（系统表 + 内存缓存 + lease 轮询，与统计信息同构的双层架构），命中后以 `hint.BindHint` 注入再走完整优化——绑定即 hint，复用 hint 的全部执行机制。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Visitor | `preprocessor` in `core/preprocess.go:128` | 名字解析以遍历实现，复用 parser 的 Accept 契约 |
| 策略列表 + 位标志 | `optRuleList`/`optRuleFlags` in `core/optimizer.go:88/125` | 构建期标记哪些规则可能适用，优化期跳过无关规则 |
| Memo | `cascades/memo/group.go:35` | 逻辑等价类去重，支持共享子计划 |
| 对象池 | `planBuilderPool` in `optimize.go:464`、cascades `stackPool` | PlanBuilder/任务栈复用，降低热点路径分配 |

## 模块间交互

上游：parser（AST）；`core.Preprocess` + `core/resolve` 完成名字解析后交给 PlanBuilder。下游：物理计划两路输出——`ToPB` 转 `tipb`（下推 TiKV/TiFlash），`executorBuilder.build`（`pkg/executor/builder.go:193`）构本地算子。侧向：`RecursiveDeriveStats` 消费 `pkg/statistics`（行数估算见 [06-statistics](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/06-statistics)）；估算不齐时 `rule_collect_plan_stats.go` 的 `CollectPlanStats` 触发同步等统计加载；`bindinfo` 提供计划绑定。注意 statistics ↔ planner 的循环依赖靠函数指针解环：`statistics.GetRowCountByIndexRanges` 由 `cardinality` 包 `init()` 注册（`row_count_index.go:30`）。

## 扩展方式

- **新增逻辑优化规则**：新建 `pkg/planner/core/rule_xxx.go` 实现 `base.LogicalOptRule` → 在 `optRuleList` + `optRuleFlags` 注册 → `pkg/planner/core/rule` 加 `FlagXxx` 常量 → 构建处置位 `b.optFlag |= rule.FlagXxx`；若 Cascades 需同步，在 `cascades/old/transformation_rules.go` 加对应 XForm。
- **新增 hint**：hint 解析（`pkg/util/hint`）→ `StmtHints` 字段 → planbuilder 消费点；涉及访问路径则改 `exhaust_physical_plans.go`。
- **新增 Cascades 规则**：`cascades/rule/rule_type.go` 加类型 → 实现 `Rule.XForm` + pattern（`cascades/pattern/engine.go` 匹配）→ 注册规则表。
