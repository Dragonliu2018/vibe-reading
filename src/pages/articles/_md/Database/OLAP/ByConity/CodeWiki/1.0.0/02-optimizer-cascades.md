---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "Cascades 框架"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "Cascades", "优化器", "Memo", "CBO"]
description: "ByConity Cascades 优化器深度解读：Memo 数据结构、TaskStack 搜索、规则匹配与代价剪枝。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回查询优化器](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/02-optimizer)

---

## 主题定位

本附件深入 ByConity Cascades 优化器的内部机制——`Memo` 数据结构、`TaskStack` 搜索循环、规则匹配与 apply、代价剪枝与 copy-out。在[查询优化器](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/02-optimizer)模块文件中，Cascades 是作为 Rewriter 链一环被调用的；这里展开它内部"如何把一棵逻辑计划树搜索成最优物理计划"。

---

## 核心原理

Cascades 的核心思想是：把所有**逻辑等价**的表达式归入同一个 `Group`，把所有**物理实现**也挂在 Group 上，用一个 `Memo`（记忆表）去重共享，避免子表达式被重复探索；然后用一个任务栈驱动"探索等价表达式（transformation）"+"物化物理算子并算代价（implementation）"两阶段，最终按所需 `Property` 选出 cost 最低的物理表达式（Winner）。

![Cascades 优化器搜索流程](/vibe-reading/images/articles/byconity/cascades-flow.svg)

流程：`initMemo` 把 `QueryPlan` 树转成 `GroupExpression` 树插入 `Memo`；根节点要求 `Property{Partitioning::Handle::SINGLE, Component::COORDINATOR}`（单节点收集结果）。`optimize` 把 `OptimizeGroup(root)` 压入 `TaskStack`，循环 `while (!stack.empty()) { pop; execute; }`（`CascadesOptimizer.cpp:106-137`），直到栈空，从 root group 的 Winner 提取最优 plan。

### Memo：去重共享的等价表达式图

`Memo`（`Memo.h`）维护 `vector<GroupPtr> groups`（按 id 索引）和 `group_expressions` hashmap（`GroupExprPtr → GroupId`，用于去重）：

```cpp title="Cascades/Memo.h"
std::vector<GroupPtr> groups;
std::unordered_map<GroupExprPtr, GroupId, GroupExprPtrHash, GroupExprPtrEq> group_expressions;
// 上限 10000 个 group（Memo.cpp:59）
```

`insertGroupExpr`（`Memo.cpp:24`）是核心插入逻辑：先查 hashmap 去重（`operator==` 比较 step + child_groups），相同表达式返回已有 GroupExpr，不同表达式加入新 Group 或指定 target group。这保证子表达式只被探索一次——这是 Cascades 比朴素穷举高效的根本。

### Group / GroupExpression

`Group`（`Group.h`）是等价表达式集合，分 `logical_expressions`（待探索）与 `physical_expressions`（已物化）：

```cpp title="Cascades/Group.h"
std::vector<GroupExprPtr> logical_expressions;
std::vector<GroupExprPtr> physical_expressions;
std::unordered_map<Property, WinnerPtr, PropertyHash> lowest_cost_expressions; // 按 Property 记最优
std::optional<PlanNodeStatisticsPtr> statistics;   // 基数统计
SymbolEquivalencesPtr equivalences;                 // 符号等价类
```

`GroupExpression`（`GroupExpression.h`）包装一个 `QueryPlanStep` + 子 Group id 列表 + `rule_mask`（bitset 记录已应用规则）。`hasRuleExplored`/`setRuleExplored` 防止同一规则对同一表达式重复 apply。`Winner` 记录最优物理表达式及其 cost、remote/local exchange、CTE 属性。

### 四类 Task 与栈式调度

搜索由四类 task 驱动（注释见 `Task.h:33-44`），任务可互相压栈：

- **`OptimizeGroup`**：检查 cost lower bound / 已有 winner；压入 `OptimizeExpression`（探索逻辑表达式）和 `OptimizeInput`（优化物理表达式）。若 `cost_lower_bound >= cost_upper_bound` 直接跳过（`Task.cpp:53`）。
- **`OptimizeExpression`**：构造 valid rules（transformation + implementation），压入 `ApplyRule` 和子 group 的 `ExploreGroup`。
- **`ExploreGroup`/`ExploreExpression`**：仅探索逻辑等价类（transformation rules），不算 cost。
- **`ApplyRule`**（`Task.cpp:185`）：用 `GroupExprBindingIterator`（`GroupExpression.h:286`）做 pattern matching，调用 `rule->transform(before, rule_context)` 生成新表达式。`TransformResult` 支持 `eraseOld`（删原表达式）和 `eraseAll`（清空 Group）。新表达式经 `CascadesContext::recordPlanNodeIntoGroup` 插入 target group——新 logical expr 压 `OptimizeExpression`，新 physical expr 压 `OptimizeInput`。

### 代价计算与 Property 强制

`OptimizeInput`（`Task.cpp:705`）是代价核心：`CostCalculator::calculate()` 算当前算子 cost → 递归优化子 group（传递 `cost_upper_bound - cur_total_cost` 作为上界）→ `enforcePropertyAndUpdateWinner`：先 `PropertyDeriver::deriveProperty` 推导输出 property，再 `PropertyMatcher::matchNodePartitioning/matchStreamPartitioning` 判断是否满足 required，不满足则 `PropertyEnforcer::enforceNodePartitioning`（插 remote Exchange）/ `enforceStreamPartitioning`（插 local Exchange）并累加 cost，最后更新 `Group::lowest_cost_expressions`。

### Copy-out：从 Winner 提取计划

`buildPlanNode`（`CascadesOptimizer.cpp:140`）从 root group 的 Winner 递归构建 `PlanNode`：`Winner::buildPlanNode()` 组装最终 PlanNode（含 remote/local exchange）。CTE 单独处理：遍历 `winner->getCTEActualProperties()`，为每个 CTE 递归构建 plan。

---

## 实现细节

### Transformation vs Implementation 规则

Transformation rule（如 `InnerJoinCommutation`、`JoinEnumOnGraph`、`LeftJoinToRightJoin`）在逻辑空间探索等价表达式；Implementation rule（1.0.0 仅 `SetJoinDistribution`，`CascadesOptimizer.cpp:246`）将逻辑算子转为物理算子（如为 Join 设置分布策略）。`ApplyRule::execute()` 按新表达式 `isLogical()`/`isPhysical()` 分别压入 `OptimizeExpression` 或 `OptimizeInput`。

### 代价剪枝

`OptimizationContext` 持有 `cost_upper_bound`。`OptimizeInput` 中若 `group_expr->getCost() > cost_upper_bound` 直接剪枝（`Task.cpp:311`）；子 group 优化时传递 `cost_upper_bound - cur_total_cost`（`Task.cpp:386`）。这是 branch-and-bound——一旦当前路径代价已超已知最优，立即停止深入。

### 规则 mask 与上限

`GroupExpression::rule_mask` 避免重复 apply 同一规则；搜索有超时（`cascades_optimizer_timeout`）和任务数上限（100000）双重保护，防止 pathological 查询爆炸。`enable_cbo=false` 时 cost 恒 0，整个搜索退化为规则驱动（不剪枝、不选最优，只 apply 规则）。

---

## 性能与权衡

Cascades 的代价是搜索空间随 join 数指数增长。ByConity 的控制手段：Memo 去重（避免子表达式重复探索）、`rule_mask`（避免规则重复 apply）、cost upper-bound 剪枝（branch-and-bound）、Group/task 数量上限与超时硬保护、`SimpleReorderJoin` 启发式在 Cascades 前做初步 join 重排缩小空间、`QueryUseOptimizerChecker` 灰度开关让复杂查询回退旧路径。权衡点是：CBO 能选出更优计划但耗时不可控，故用多重护栏把不可控性限制在可接受范围。worker 节点不走优化器（由 server 统一优化后下发），避免重复优化与计划不一致。
