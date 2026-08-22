---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Optimizer"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Optimizer", "JoinOrder", "Dphyp"]
description: "DuckDB Optimizer 模块——27+ pass 规则链优化器，含 Dphyp DP Join Order 算法和表达式重写规则引擎。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Optimizer 模块接收 Planner 产出的 `LogicalOperator` 树，应用一系列优化规则后返回优化后的 `LogicalOperator` 树给 `PhysicalPlanGenerator`。优化目标是在逻辑计划层面减少中间结果大小和计算量——Filter 下推减少扫描数据、Join Order 优化减少中间结果、列裁剪减少 I/O、CSE 消除重复计算。

## 模块架构

Optimizer 采用**规则链（pipeline）架构**——27+ 个独立优化 pass 按严格顺序执行，而非单一优化器遍历。每个 pass 有 `OptimizerType` 枚举标识，可通过 `PRAGMA disabled_optimizers` 跳过。核心组件包括 `ExpressionRewriter`（21 条表达式重写规则的规则引擎）、`JoinOrderOptimizer`（Dphyp DP 算法）、`FilterPushdown`（14 个 Pushdown 方法）、`ColumnLifetimeAnalyzer`（列生命周期分析/裁剪）、`StatisticsPropagator`（统计传播+空结果消除）。

## 调用链路

```
Optimizer::Optimize(plan)                              [optimizer.cpp:326]
  ├→ Verify(plan)                                      — ColumnBindingResolver::Verify
  ├→ [扩展钩子] pre_optimize_function()
  ├→ RunBuiltInOptimizers()                            [optimizer.cpp:116]
  │    ├→ 1. ExpressionRewriter (21 条规则)
  │    ├→ 2. CTEInlining
  │    ├→ 3. SumRewriter
  │    ├→ 4. FilterPullup → 5. FilterPushdown
  │    ├→ 6. CTEFilterPusher → 7. RegexRangeFilter
  │    ├→ 8. InClauseRewriter → 9. Deliminator
  │    ├→ 10. CTEInlining (2nd) → 11. EmptyResultPullup
  │    ├→ 12. WindowSelfJoin → 13. JoinOrderOptimizer (Dphyp DP)
  │    ├→ 14. JoinElimination → 15. UnnestRewriter
  │    ├→ 16. RemoveUnusedColumns → 17. RemoveDuplicateGroups
  │    ├→ 18. CommonSubExpressionOptimizer
  │    ├→ 19. ColumnLifetimeAnalyzer (1st)
  │    ├→ 20. BuildProbeSideOptimizer
  │    ├→ 21. CommonSubplan → 22. LimitPushdown
  │    ├→ 23. RowGroupPruner → 24. SamplingPushdown
  │    ├→ 25. TopN → 26. LateMaterialization
  │    ├→ 27. StatisticsPropagation
  │    ├→ 28. TopNWindowElimination → 29. CommonAggregate
  │    ├→ 30. ColumnLifetimeAnalyzer (2nd)
  │    ├→ 31. ExpressionHeuristics (ReorderFilter)
  │    └→ 32. JoinFilterPushdown
  ├→ [扩展钩子] optimize_function()
  └→ Planner::VerifyPlan()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Optimizer::Optimize` | 主入口，协调扩展钩子和内置 pass | 扩展钩子在 builtin 前后注入 |
| `RunBuiltInOptimizers` | 27+ pass 顺序执行 | 顺序精心设计（FilterPullup 在 Pushdown 前） |
| `RunOptimizer` | 模板方法封装单个 pass | 检查中断→检查 disabled→profiler→执行→Verify |
| `ExpressionRewriter::ApplyRules` | 21 条规则尝试匹配 | 不动点迭代（递归直到无变化） |
| `JoinOrderOptimizer::Optimize` | Dphyp DP join order | relation ≥12 或 pair ≥10000 降级贪心 |
| `FilterPushdown::Pushdown*` | 14 种算子的 filter 下推 | 针对不同 operator 类型不同策略 |
| `ColumnLifetimeAnalyzer` | 列引用分析→projection map | 执行两次（BuildProbeSide 翻转前后） |

</details>

## 核心实现

### JoinOrderOptimizer：Dphyp DP 算法

DuckDB 实现了 "Dynamic Programming Strikes Back"（Moerkotte & Neumann）的 **Dphyp 算法**。`QueryGraphManager::Build` 从 LogicalPlan 提取可重排序 relation，`PlanEnumerator::SolveJoinOrder` 执行 DP：

- **DP 表**：`reference_map_t<JoinRelationSet, unique_ptr<DPJoinNode>> plans`，key 是 relation 集合的 bitmap
- **精确 DP**（`SolveJoinOrderExactly`）：逆序遍历每个 relation 作为 start_node，`EmitCSG` 递归枚举连通子图，对每对 (left, right) 调用 `EmitPair` 计算代价保留更优解
- **降级条件**：relation 数 ≥ 12（`THRESHOLD_TO_SWAP_TO_APPROXIMATE`）或尝试的 pair 数 ≥ 10000 时切换到贪心算法（Greedy Operator Ordering，O(r³)）
- **代价函数极简**：`cost = join_cardinality + left.cost + right.cost`（`cost_model.cpp:13-18`），仅考虑基数，注释标注未来可扩展 join 类型和算法

### ExpressionRewriter 规则引擎

`ExpressionRewriter` 继承 `LogicalOperatorVisitor`，持有 21 条 `Rule` 子类。每条 Rule 持有 `ExpressionMatcher` 树做模式匹配。`ApplyRules` 方法（`expression_rewriter.cpp:13-45`）按顺序尝试每条规则，匹配成功后递归 `ApplyRules` 重新从第一条规则开始——**不动点迭代**确保规则间的连锁效应被完全捕获（如 ConstantFolding 产出常量后 DistributivityRule 可能匹配）。

21 条规则包括：`ConstantFoldingRule`（常量折叠）、`DistributivityRule`（分配律）、`ArithmeticSimplificationRule`（算术简化）、`CaseSimplificationRule`（CASE 简化）、`LikeOptimizationRule`（LIKE 优化）、`JoinDependentFilterRule`、`PredicateFactoringRule`（谓词分解）等。

### ColumnLifetimeAnalyzer 执行两次

ColumnLifetimeAnalyzer 在第 19 步和第 30 步各执行一次。第一次生成 projection map 后，`BuildProbeSideOptimizer`（第 20 步）可能翻转 join children 导致 projection map 失效。第二次重新计算以反映翻转后的实际列需求。`BuildProbeSideOptimizer` 代码中明确注释 "They will be set in the 2nd round of ColumnLifetimeAnalyzer"。

### FilterPushdown 与 FilterPullup 配合

FilterPullup（第 4 步）先将 Filter 上提，FilterPushdown（第 5 步）再下推。这种"先打散再重组"的模式实现了 filter 的重新组合——原本绑定在不同位置的 filter 经过 pullup 后可以在 pushdown 阶段尝试下推到更接近数据源的位置。FilterPushdown 有 14 个 `Pushdown*` 方法，针对不同 operator 类型（Get/Join/Aggregate/Projection/SetOperation/Window）有不同策略。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 管道/规则链 | `RunBuiltInOptimizers` in `optimizer.cpp:116` | 27+ pass 可独立禁用/调试，顺序依赖明确 |
| 策略模式 | `Rule::Apply` in `rule.hpp` | 21 条规则各自实现 Apply，模式匹配+不动点 |
| Visitor | `LogicalOperatorVisitor` | 统一的树遍历框架，给 optimizer 提供改写接口 |
| 模板方法 | `RunOptimizer` in `optimizer.cpp:94` | 固定骨架：检查→执行→Verify |

## 模块间交互

Optimizer 在 `ClientContext::CreatePreparedStatementInternal`（`client_context.cpp:435-436`）中被调用，输入是 Planner 产出的 `LogicalOperator` 树。Optimizer 持有 `Binder&` 引用（用于生成新 table index）和 `ClientContext&`（用于查 disabled_optimizers、QueryProfiler 阶段计时、间接访问 Catalog 查表统计）。产出优化后的 `LogicalOperator` 树给 `PhysicalPlanGenerator`。`StatisticsPropagator` 通过 `LogicalOperator::EstimateCardinality` 查询表级统计，可检测空结果并替换为 `LogicalEmptyResult`。

## 扩展方式

新增一条表达式重写规则：在 `src/optimizer/rule/` 下新建继承 `Rule` 的类，实现 `Apply` 方法并在构造函数中设置 `ExpressionMatcher` 模式 → `src/include/duckdb/optimizer/rule/list.hpp` include → `src/optimizer/optimizer.cpp` 构造函数中 `rewriter.rules.push_back(make_uniq<MyRule>(rewriter))`。无需修改 ExpressionRewriter 本身——策略模式保证开闭原则。
