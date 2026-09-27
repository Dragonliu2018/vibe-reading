---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "查询优化器"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "Cascades", "CBO", "Memo", "Rule", "统计信息", "join reorder"]
description: "StarRocks Cascades 优化器：Memo/Group 结构、显式任务栈、约 219 条规则、rewrite 阶段绕过 Memo 的设计、统计信息体系。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`fe/.../sql/optimizer/`（约 15.6 万行，FE 最大包）是 Orca/Cascades 风格的 CBO。它独立成篇不止因为体量，更因为它是 StarRocks 与母项目 Doris 拉开差距的第一现场——Doris 的 Nereids 也是 Cascades，但 StarRocks 这套在两处做了显著变形：**rewrite 阶段绕过 Memo 直接在 OptExpression 树上跑**（只有 CBO 阶段进 Memo），以及**显式 `Stack<OptimizerTask>` 替代递归**。

## 模块架构

入口是抽象类 `Optimizer`（唯一方法 `optimize(OptExpression, PhysicalPropertySet, ColumnRefSet)`），`OptimizerFactory` 按场景选三种实现：`QueryOptimizer`（常规查询）、`ShortCircuitOptimizer`、`SPMOptimizer`（Plan Management 的 plan 重放）。主体 `QueryOptimizer.optimize()`（`QueryOptimizer.java:197`）编排以下子包：

| 子包 | 职责 |
| --- | --- |
| `Memo`/`Group`/`GroupExpression` | 搜索空间数据结构 |
| `task/` | 11 个 OptimizerTask 子类 + TaskScheduler |
| `rule/transformation/`（166 文件） | CBO 转换规则 |
| `rule/implementation/`（43 文件） | 逻辑→物理实现规则 |
| `cost/`、`statistics/`、`property/` | 代价模型、统计估计、物理属性 enforce |
| `rewrite/` | MV 改写相关（见 [06](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/06-mv)） |

## 调用链路

### 优化主流程（`optimizeByCost`，`QueryOptimizer.java:251`）

```text
1. prepareMvRewrite() (:338) + 文本匹配改写       # MV 预处理
2. logicalRuleRewrite() (:525)                    # Phase 2：树上直接跑 40+ 组规则
     CTE inline → subquery unnest → 谓词下推 → 列裁剪
     → logicalJoinReorder() (:917) → pruneSubfield() → skewJoinOptimize()
3. memo.init(tree) + deriveAllGroupLogicalProperty()   # 树 copyIn Memo
4. memoOptimize() (:974)                          # Phase 3：CBO 搜索
     按需装 join reorder 规则 → push OptimizeGroupTask → executeTasks
     → extractBestPlan(requiredProperty, rootGroup) (:1110)
5. physicalRuleRewrite() (:1030) → dynamicRewrite() (:1085)
   → PlanValidator.validatePlan()                 # 后处理与校验
```

规则经 `scheduler.rewriteIterative/rewriteOnce/rewriteDownTop` 驱动在 `LogicalTreeAnchorOperator` 锚定的树上迭代。

### Memo 与任务栈

```java title="sql/optimizer/Memo.java（核心字段）"
List<Group> groups;
Map<GroupExpression, GroupExpression> groupExpressions;   // HashSet 式去重
Group rootGroup;
```

`Group`（`Group.java:48`）：`logicalExpressions`/`physicalExpressions` 分列、`lowestCostExpressions: Map<PhysicalPropertySet, Pair<Double, GroupExpression>>`（按 required property 记最优）、`costLowerBounds`（剪枝下界）。`GroupExpression`（:50）：`op + List<Group> inputs`、`ruleMasks/appliedRuleMasks`——**BitSet 按 `RuleType.NUM_RULES` 记已应用规则**，防重复展开。

任务族在 `task/TaskScheduler.java`（`public final Stack<OptimizerTask> tasks`，`executeTasks()` 循环 pop 并 `task.execute()`，每轮 `checkTimeout()`）：`OptimizeGroupTask` → `OptimizeExpressionTask` → `ApplyRuleTask`（bind pattern、`rule.transform()`、结果 copyIn）→ `DeriveStatsTask` → `EnforceAndCostTask`（成本 + property enforce）。

## 核心实现

### 规则体系

`Rule` 基类 = `RuleType + Pattern` 二元组 + 四个钩子：`check()`（结构匹配后的语义检查）、`transform()`（返回等价表达式列表，空=无变化）、`promise()`（implementation rule 优先级更高、先调度）、`exhausted()`（best-effort 规则超时放弃）。`RuleType` 枚举约 219 项（TF_ transformation / IMPL_ implementation / GP_ 组合规则三类前缀）。`RuleSet` 三层组织：

- **rewrite 规则**：`CombinationRule` 打包成 `PUSH_DOWN_PREDICATE_RULES`、`PRUNE_COLUMNS_RULES` 等 30+ 组，由 `logicalRuleRewrite()` 手工排序调用（多处注释标前置依赖）；
- **transformation 规则**：默认不装，`memoOptimize()` 按 join 数动态 `addJoinTransformationRules()`/`addOuterJoinTransformationRules()`；
- **implementation 规则**：`ALL_IMPLEMENT_RULES` 静态全装（`RuleSet.java:191`），每个逻辑算子→物理算子（各 external catalog 一个 ScanImplementationRule；HashJoin/MergeJoin/NestLoopJoin 三种 join 实现）。

典型规则 `JoinCommutativityRule`：私有构造+单例 `INSTANCE`，构造器 `Pattern.create(OperatorType.LOGICAL_JOIN).addChildren(PATTERN_LEAF, PATTERN_LEAF)`，`check()` 校验无 join hint，`transform()` 交换输入并翻转 join 类型。

### Join Reorder 自适应

`rule/join/JoinReorderFactory.createJoinReorderAdaptive()` 按 join 数在 DP/Greedy/LeftDeep/DrivingTable 间切换，阈值在 `SessionVariable`（`cbo_max_reorder_node`、`cbo_max_reorder_node_use_exhaustive`）。

### 统计信息

`DeriveStatsTask` → `StatisticsCalculator`（visitor 逐算子估计）。数据源全在 catalog 侧缓存：`CachedStatisticStorage` + `ColumnBasicStatsCacheLoader`（行数/NDV/NULL 数）、`ColumnHistogramStatsCacheLoader`（等宽直方图做 range join 估计）、`PartitionStatsCacheLoader`、`CacheDictManager`（字典编码列精确 NDV）。**无运行时反馈闭环**——runtime filter 的 join 侧裁剪在 BE/物理计划层，不回灌 FE 优化器。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Memo + 动态规划 | `Memo.java`（merge/剪枝下界） | 表达"同一子树多个等价形式"的枚举空间 |
| 解释器栈 | `TaskScheduler` + 11 个 task 子类 | 递归展开改为可中断、可超时检查的迭代循环 |
| Visitor | `OptExpressionVisitor`（10.9K，双分派） | 统计/打印/校验共用遍历骨架 |
| 单例 + 静态注册表 | `JoinCommutativityRule.INSTANCE`、`RuleSet.PUSH_DOWN_PREDICATE_RULES` | 规则无状态，全局共享 |
| Strategy | `JoinReorderFactory` | join 数量级差异太大，单一策略不划算 |

## 模块间交互

- **上游**：`qe/StmtExecutor` 经 `sql/StatementPlanner` 调入（见 [04 QE](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/04-qe)）；统计与表元数据来自 [02 元数据](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/02-catalog-ha)。
- **内部**：`prepareMvRewrite` 与 MV 体系的交互全部委托 `sql/optimizer/MvRewritePreprocessor`（见 [06 物化视图](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/06-mv)）。
- **下游**：物理 `OptExpression` 树交 `sql/plan/PlanFragmentBuilder` 翻译成 PlanFragment。

## 扩展方式

**新增 transformation 规则**：`rule/transformation/` 新建类（继承 `TransformationRule`）→ `RuleType.java` 加枚举（注意 `NUM_RULES` 比特位）→ rewrite 型挂入 `RuleSet` 的 `CombinationRule` 并在 `logicalRuleRewrite()` 固定序列选位（顺序敏感）；CBO 型在 `RuleSet` 加 `addXxxRule()` 由 `memoOptimize()` 按开关调用。

**新增物理算子**：`rule/implementation/` 加 `XxxImplementationRule` → 入 `ALL_IMPLEMENT_RULES` → `cost/CostModel.java` 实现其 `visit()` cost 函数 → property 走 `RequiredPropertyDeriver`/`OutputPropertyDeriver`（还需 BE 侧算子配合，见 [09 Pipeline](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/09-pipeline)）。

**新增 join reorder 策略**：`rule/join/` 实现 `JoinReorder` 接口（参照 `JoinReorderDP`/`JoinReorderGreedy`），`JoinReorderFactory` 注册选择逻辑。

> **Why 要点**：rewrite 不进 Memo 是因为 rewrite 规则多为 must-apply 的规范化（列裁剪、谓词下推），进 Memo 反而引发组爆炸与 merge 复杂度；`appliedRuleMasks` + `promise` + `costLowerBounds` 三者共同控制搜索空间不爆炸。
