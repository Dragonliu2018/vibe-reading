---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Nereids 优化器"
date: "2026-08-23T18:22:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "Nereids", "Cascades", "CBO", "ANTLR4"]
description: "Doris Nereids 优化器：ANTLR4 解析 + 启发式重写 + Cascades CBO，SQL 文本到物理计划的全流水线。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

Nereids 是 Doris 的新一代查询优化器，灵感来自 Spark（Parser/Expression）和 CMU NoisePage（Cascades Optimizer）。它把一条 SQL 文本经过「解析 → 分析 → 重写 → CBO → 物理计划 → 分布式计划」六阶段流水线，产出可分发到 BE 的 `PlanFragment` 树。Nereids 是 FE 中最大的模块（~38 万行 Java），独立成文是因为优化是自成一体的决策域——规则、代价模型、Memo 数据结构构成完整闭环，与执行调度正交。

## 模块架构

Nereids 内部分四层：**解析层**（`NereidsParser` + ANTLR4 生成 `DorisLexer`/`DorisParser`，把 SQL 文本转 `LogicalPlan`）、**计划树层**（`trees/plans/` 下 logical/physical 节点，如 `LogicalOlapScan`/`PhysicalHashJoin`）、**规则层**（`rules/` 下 RewriteRuleFactory/Implementation rule DSL + `RuleSet` 容器）、**Cascades 引擎层**（`memo/` 的 `Memo`/`Group`/`GroupExpression` + `jobs/cascades/` 的 Job 调度）。

```
SQL 文本
   │  NereidsParser (ANTLR4)
   ▼
LogicalPlan (UnboundRelation, UnboundSlot)
   │  Analyzer  ── BindRelation/BindExpression (analysis jobs)
   ▼
LogicalPlan (LogicalOlapScan, SlotReference)  ── bound
   │  Rewriter  ── 13 组启发式规则 (whole_tree/children rewrite jobs)
   ▼
LogicalPlan (rewritten)
   │  Optimizer  ── Cascades: Memo + Group + GroupExpression
   ▼
PhysicalPlan (PhysicalOlapScan, PhysicalHashJoin...)
   │  PlanPostProcessors  ── PushDownFilter/RuntimeFilterGenerator/FragmentProcessor
   ▼
PlanFragment 树  ── 交给 Coordinator 调度
```

核心是 `NereidsPlanner`（`nereids/NereidsPlanner.java`）编排这六阶段，它持有五个 `Plan` 字段（`parsedPlan`/`analyzedPlan`/`rewrittenPlan`/`optimizedPlan`/`physicalPlan`）对应流水线各阶段产物。

## 调用链路

`StmtExecutor.executeByNereids` 创建 `NereidsPlanner` 并调 `plan`：

```
StmtExecutor.executeByNereids (StmtExecutor.java:671)
  └─ new NereidsPlanner(statementContext)
  └─ planner.plan(parsedStmt, queryOptions) (NereidsPlanner.java:138)
       ├─ preprocess ── PlanPreprocessors (PullUpSubqueryAliasToCTE)
       ├─ initCascadesContext ── CascadesContext.initContext
       ├─ collectAndLockTable ── TableCollector 获取表锁
       └─ planWithoutLock (NereidsPlanner.java:278)
            ├─ analyze()  ── Analyzer 按 ANALYZE_JOBS 绑定
            ├─ rewrite() ── Rewriter 执行 WHOLE_TREE_REWRITE_JOBS
            ├─ preMaterializedViewRewrite()  ── RBO 物化视图改写
            ├─ optimize()  ── new Optimizer(cascadesContext).execute()
            │    ├─ cascadesContext.toMemo()  ── plan 转入 Memo
            │    ├─ DeriveStatsJob  ── 递归推导统计
            │    ├─ [可选] dpHypOptimize()  ── DPHyp Join Reorder
            │    └─ OptimizeGroupJob(root) ── Cascades 自顶向下
            │         ├─ OptimizeGroupExpressionJob ── 应用 exploration+implementation rules
            │         │    └─ ApplyRuleJob ── rule.transform() → memo.copyIn()
            │         └─ CostAndEnforcerJob ── 代价+Enforcer (ORCA 论文 Figure 7)
            ├─ chooseBestPlan(root, requireProperties)  ── 从 Memo 提取最优
            ├─ postProcess() ── PlanPostProcessors (RuntimeFilterGenerator/FragmentProcessor)
            └─ distribute() ── splitFragments + doDistribute (DistributePlanner)
```

数据类型流转：`String` SQL → `LogicalPlan`（`UnboundRelation`/`UnboundSlot`）→ bound `LogicalPlan`（`LogicalOlapScan`/`SlotReference`）→ rewritten `LogicalPlan` → `PhysicalPlan`（`PhysicalOlapScan`/`PhysicalHashJoin`）→ `PlanFragment` 树 + `DescriptorTable`。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `NereidsParser.parseSQL` | ANTLR4 解析 SQL | SLL→LL 两阶段，失败回退 |
| `Analyzer.analyze` | 绑定元数据 | 按 ANALYZE_JOBS 固定顺序，直接改 plan 树 |
| `Rewriter.getWholeTreeRewriter` | 启发式重写 | AdaptiveTopDown/BottomUp 按深度选 Visitor/Stack |
| `Optimizer.execute` | Cascades CBO | Memo + Job 栈调度，fixpoint 循环 |
| `CostAndEnforcerJob` | 代价+属性强制 | 参考 ORCA，gap 检测加 Enforcer |
| `chooseBestPlan` | 提取最优物理计划 | 按 PhysicalProperties 递归选 lowestCost |
| `PhysicalPlanTranslator` | 物理→PlanFragment | visit 每个 PhysicalXxx 翻译为旧 PlanNode |
| `DistributePlanner.plan` | 分布式分配 | Fragment→DistributedPlan 含 BE 目标 |

</details>

## 核心实现

### Cascades Memo 数据结构

`Memo`（`nereids/memo/Memo.java`）是等价计划的存储结构，用 `Map<GroupId, Group>` + `Map<GroupExpression, GroupExpression>` 管理。`copyIn()` 把规则产生的新计划合并进 Memo 并自动合并等价 Group（`mergeGroup`）。`Group` 含 `logicalExpressions`/`physicalExpressions`/`enforcers` 三类等价表达式列表，以及 `lowestCostPlans`（按 `PhysicalProperties` 索引的最优计划映射）。`GroupExpression` 用 `ruleMasks`（BitSet）跟踪已应用 rule，`Rule.isInvalid` 检查 `groupExpression.notApplied(this)` 避免重复。

Memo 只在 optimize 阶段创建——`CascadesContext.toMemo()`（`CascadesContext.java:272`）把 rewrite 阶段的 plan 树 copy in。这让 exploration rules 自由产生等价计划而不影响原计划，最终由 CBO 选最优。

### 规则应用机制与 Fixpoint

规则分三类，注册在 `RuleSet`（`nereids/rules/RuleSet.java`）：`IMPLEMENTATION_RULES`（逻辑→物理映射）、`EXPLORATION_RULES`（等价逻辑探索）、`PUSH_DOWN_FILTERS`、`MATERIALIZED_VIEW_IN_CBO_RULES`、多种 Join Reorder 策略（ZigZag/Bushy/LeftZigZag/DPHyp）。

规则编写用声明式 DSL，以 `EliminateFilter`（`rules/rewrite/EliminateFilter.java`）为例：

```java title="rules/rewrite/EliminateFilter.java"
logicalFilter()
    .when(filter -> filter.getConjuncts().isEmpty() || ...)
    .thenApply(ctx -> { /* 返回新 plan */ })
    .toRule(RuleType.ELIMINATE_FILTER)
```

重写阶段规则按 `RewriteJob` 列表顺序执行，`AbstractBatchJobExecutor.execute`（`jobs/executor/AbstractBatchJobExecutor.java:165`）对非 `once` 的 job 用 `do-while` 循环直到不再产生变换（fixpoint）。Cascades 阶段则通过 `GroupExpression.ruleMasks` BitSet 记录每个 rule 是否已应用，`ApplyRuleJob.execute`（`jobs/cascades/ApplyRuleJob.java:67`）开头检查 `groupExpression.hasApplied(rule)` 跳过。

### 启发式 + CBO 混合优化

Nereids 把优化分三阶段：**Analysis**（`Analyzer` 按 `ANALYZE_JOBS` 固定顺序执行绑定规则，不做等价探索，直接在 plan 树变换）、**Rewrite**（`Rewriter` 跑 ~200 条重写规则，支持 `costBased()` 标记的 `CostBasedRewriteJob` 条件执行，直接操作 plan 树不用 Memo）、**Cascades CBO**（`Optimizer` 将 plan 转入 Memo，做 exploration + implementation 枚举，基于统计代价选最优）。

自适应遍历（`AdaptiveTopDownRewriteJob` in `jobs/rewrite/`）根据 plan 深度动态选 Visitor（递归，高效）或 Stack（显式栈，避免栈溢出）——深度 ≤ 阈值用 Visitor，否则 Stack。

### 统计与代价驱动

`DeriveStatsJob`（`jobs/cascades/DeriveStatsJob.java:75`）递归推导子节点统计后，调 `StatsCalculator.estimate` 或 `HboStatsCalculator.estimate`（HBO 基于历史查询统计）计算当前节点统计，存入 `Group.statistics`。`CostAndEnforcerJob` 的 `CostCalculator.calculateCost` 消费这些统计。

当列统计未知（`isHasUnknownColStats`），`Optimizer.isDpHyp` 把 join 表数量阈值翻倍（`maxTableCount * 2`），允许更多表走 Cascades 探索而非精确 DPHyp；`OptimizeGroupExpressionJob.getJoinRules` 在统计不可靠时选 `LeftZigZagTreeJoinReorder`（仅左深树）减少搜索空间。`CostAndEnforcerJob` 参考 ORCA 论文 4.1.4 节：`RequestPropertyDeriver` 算子节点属性请求 → 递归优化子 Group → `ChildrenPropertiesRegulator` 调整 → `EnforceMissingPropertiesHelper` 在属性不满足时加 Enforcer（如 `DistributionEnforcer`），代价超 upper bound 直接剪枝。

### MV 两阶段改写

物化视图改写分 RBO 和 CBO 两阶段（`NereidsPlanner.preMaterializedViewRewrite` in `NereidsPlanner.java:479`）：rewrite 后、optimize 前先跑 `PreMaterializedViewRewriter.rewrite` 做 RBO 改写，改写结果存 `statementContext.getRewrittenPlansByMv()`；Cascades 阶段 `OptimizeGroupExpressionJob.getExplorationRules` 根据 `isPreMvRewritten()` 决定加 `MATERIALIZED_VIEW_IN_RBO_RULES` 还是 `MATERIALIZED_VIEW_IN_CBO_RULES`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Cascades 框架 | `memo/Memo.java`、`jobs/cascades/` | 等价计划探索 + 代价剪枝，支撑复杂 Join Reorder |
| 规则工厂 DSL | `rules/RuleFactory.java`、`RewriteRuleFactory` | 声明式 pattern+transform，降低规则编写门槛 |
| Job 栈调度 | `CascadesContext.jobPool`、`SimpleJobScheduler` | push job→execute→递归 push 子 job，自然表达优化递归 |
| 自适应遍历 | `AdaptiveTopDownRewriteJob` | 按深度切 Visitor/Stack，兼顾效率与防溢出 |
| DPHyp+Cascades 混合 | `Optimizer.isDpHyp` | join 多走精确 DP，少走启发式探索 |

## 模块间交互

Nereids import `catalog`（表/列/分区元数据、表锁，`NereidsPlanner` 持 `Env`/`TableIf`）、`qe`（`ConnectContext`/`SessionVariable`/`OriginStatement`）、`planner`（输出 `PlanFragment`/`ScanNode`/`RuntimeFilter`）、`statistics`（`Statistics`/`ColumnStatistic`，`CostCalculator` 用）、`analysis`（旧层 `DescriptorTable`/`StatementBase` 兼容，`LogicalPlanAdapter` 适配）、`datasource`（外部表 ScanNode 创建，`PhysicalPlanTranslator` 引各 `XxxScanNode`）、`thrift`（`TQueryOptions`）。

被调用方是 `qe.StmtExecutor`（`StmtExecutor.java:812`）：`new NereidsPlanner(statementContext)` + `planner.plan()`，之后从 planner 取 `PlanFragment` 列表/`ScanNode`/`DescriptorTable`/`RuntimeFilter` 交给 `Coordinator`。`NereidsParser.parseSQL` 在 `StmtExecutor` 解析阶段（`StmtExecutor.java:912` `parseByNereids`）被调用，产 `LogicalPlanAdapter` 包装为旧 `StatementBase`。

## 扩展方式

新增一条优化规则：在 `rules/rewrite/` 建 Rule 类实现 `RewriteRuleFactory`（DSL 定义 `logicalXxx().when(...).thenApply(...).toRule(RuleType.XXX)`）；在 `rules/RuleType.java` 加枚举；在 `jobs/executor/Rewriter.java` 的某 `topic()` 注册（位置很重要——`ReorderJoin` 依赖 `PUSH_DOWN_FILTERS` 先执行）。CBO 探索规则注册到 `RuleSet.EXPLORATION_RULES`；物理实现规则建 `rules/implementation/LogicalXxxToPhysicalXxx` 注册到 `IMPLEMENTATION_RULES` 并在 `cost/CostModel.java` 加 `visitPhysicalXxx`、`stats/StatsCalculator.java` 加统计推导、`glue/translator/PhysicalPlanTranslator.java` 加 `visitPhysicalXxx` 翻译。
