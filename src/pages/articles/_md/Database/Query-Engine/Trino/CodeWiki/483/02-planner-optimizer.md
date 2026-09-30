---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "查询规划与优化器"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "查询优化器", "Cascades", "CBO"]
description: "Trino 483 查询规划器：LogicalPlanner、IterativeOptimizer 规则引擎、PlanFragmenter 切片与自适应重规划"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

规划器把 `Analysis` 变成**可分布执行的 `PlanFragment` 树**：先生成逻辑计划（PlanNode DAG），再经约 65 个优化 pass 改写（规则 + 代价），最后按分区边界切片。这是 Trino 查询智能的核心——join 重排、谓词下推、分布选择、列裁剪全部发生在这里。

范围：`sql/planner/`（96K 行，含 `optimizations/`、`iterative/`、`plan/`、`planprinter/`、`sanity/`）+ `sql/ir`（Row IR）+ `cost/`（统计与代价模型）。注意 483 的实际布局：`IterativeOptimizer` 与规则在 `planner/iterative/`（与 `optimizations/` 平级），`iterative/rule/` 下 232 个规则文件。

## 模块架构

内部是四段流水：**建树（RelationPlanner/QueryPlanner）→ 优化（PlanOptimizers 装配的 pass 序列）→ 切片（PlanFragmenter）→ 代价与统计（cost/）**。表达式层并行演进为 `sql/ir` 的 sealed Row IR——规划后全程只见 IR，不再碰语法级 AST。

## 调用链路

```
SqlQueryExecution.doPlanQuery (SqlQueryExecution.java:489)
 └─ LogicalPlanner.plan (LogicalPlanner.java:244)
     ├─ planStatement：RelationPlanner/QueryPlanner 生成初始 PlanNode 树
     │   └─ PlanBuilder.rewrite：tree.Expression → sql.ir.Expression
     │      （TranslationMap.translate/rewrite :380/:392 + coerceIfNecessary 插 Cast）
     ├─ planSanityChecker.validateIntermediatePlan
     ├─ runOptimizer 循环（:311）跑 planOptimizers 列表
     │   └─ IterativeOptimizer.optimizeAndMarkPlanChanges (:83)
     │       ├─ 整树装入 Memo（GroupReference 编组去重）
     │       ├─ exploreGroup(root) → exploreNode(:171)
     │       │   ├─ ruleIndex.getCandidates(node)  # 按根类型分桶 O(1) 筛选
     │       │   ├─ rule.getPattern().match(node, lookup) 迭代 Match
     │       │   └─ rule.apply() 命中 → memo.replace(group, newPlan)
     │       ├─ exploreChildren(:264) 子 group 递归；子变则回上来重试本组
     │       └─ 全局不动点 → memo.extract() 还原树（每步 checkTimeout）
     ├─ validateFinalPlan
     └─ StatsAndCosts.create(root, statsProvider, costProvider) 包装 Plan
 └─ PlanFragmenter.createSubPlans (PlanFragmenter.java:126)
     └─ Fragmenter extends SimplePlanRewriter<FragmentProperties> 自顶向下：
         ├─ visitTableScan (:362)：metadata.getTableProperties 取 connector 分区
         │   → addSourceDistribution 记入 FragmentProperties
         ├─ visitExchange (:508)：REMOTE scope 即切分边界
         │   GATHER→setSingleNodeDistribution；REPARTITION→setDistribution(handle, count)
         ├─ 每 source 递归 buildSubPlan 生成子 SubPlan
         └─ buildRootFragment + reassignPartitioningHandleIfNecessary
            （系统 handle 换成真实 connector handle）+ sanityCheckFragmentedPlan
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `plan` in LogicalPlanner.java:244 | Analysis → 优化后 Plan | Stage 枚举控制 OPTIMIZED/OPTIMIZED_AND_VALIDATED 两档 |
| `optimizeAndMarkPlanChanges` in IterativeOptimizer.java:83 | 规则迭代到不动点 | Memo 分组共享 + 返回变更节点集（供 AdaptivePlanner 复用判断） |
| `apply` in Rule.java | 单条局部变换 | 只声明 pattern + Result，不写遍历 |
| `createSubPlans` in PlanFragmenter.java:126 | Plan → SubPlan 树 | visitExchange 是切分边界的唯一裁决点 |
| `rewrite` in TranslationMap.java:392 | AST 表达式 → Row IR | 建树时同步完成，优化器全程只见 IR |

</details>

## 核心实现

### PlanOptimizers：65 个 pass 的编排

`PlanOptimizers.java` 34 处 `builder.add`，共约 65 个 pass：约 40 个命名 IterativeOptimizer 阶段（DesugarLambdaExpressions → InitialPlanCleanup → Phase1 → MergeSetOperations → DecorrelateSubqueries → … → EliminateCrossJoins → **ReorderJoins（CBO，用 CostComparator）** → DetermineJoinDistributions → **AddExchanges** → AddLocalExchanges → PushPartialAggregations → AddDynamicFilterSources）+ 少量 legacy pass（UnaliasSymbolReferences、PredicatePushDown、LimitPushDown、IndexJoinOptimizer、MetadataQueryOptimizer、CheckSubqueryNodesAreRewritten）。

三个代表规则：**AddExchanges**（`PlanVisitor<PlanWithProperties, PreferredProperties>` + PropertyDerivations 推导实际数据分布 vs 期望分布，不足处插 ExchangeNode——分布式边界的决定者）；**PredicatePushDown**（谓词沿树推进 Join/Agg/Project/TableScan，并为 dynamic filtering 标注等值条件）；**LimitPushDown**（SimplePlanRewriter 把 LimitNode 推过 Sort/Project/Union 减少中间行数）。

### Row IR：表达式的一次性降维

```java title="sql/ir/Expression.java"
public sealed interface Expression permits Array, Bind, Call, Case, Cast, Coalesce,
        Constant, FieldReference, In, IsNull, Lambda, Let, Logical, Match, Reference, Row {
    Type type();   // 每个节点自带类型
}
```

旧 `tree.Expression` 是纯语法（Identifier/Dereference 糖、无类型、可能未解析名字）；规划需要的其实是"符号引用/typed 常量/已解析函数调用"。483 已完成统一：planner 侧的 RowExpression 并入 `sql.ir.Expression`（sealed + 每节点带 `type()`），`Reference` 指向 Symbol、`Call` 持 `ResolvedFunction`——类型安全、不可变、可 JSON 序列化到 worker。转换发生在 RelationPlanner/QueryPlanner 建树时（`PlanBuilder.rewrite`），此后优化器、代码生成、执行全程只见 IR。旧 `RowExpressionTranslator` 类已不存在。

### PlanFragmenter：物理分布的落点

切分不是"按层切"，而是**按数据分布边界切**：`visitExchange` 遇 REMOTE scope 即断开生成子 fragment；每个 fragment 携带 `PartitioningScheme`（输出怎么分区：SINGLE/FIXED_HASH/broadcast…）与 `partitionedSources`（源表调度顺序）。connector 自带分区（如 Hive 分区桶）经 `reassignPartitioningHandleIfNecessary` 从系统 handle 换成真实 `PartitioningHandle`——下游 worker 据此决定输出分区函数。stage 数超 `query_max_stage_count` 会直接报错（防御深嵌套查询打爆集群）。

### AdaptivePlanner：用运行时数据纠正统计

静态 CBO 依赖统计，统计缺失/低估时计划次优。FTE（容错执行）下按 stage 边界能拿到真实运行时数据（`RuntimeInfoProvider` 提供 exchange 统计）：AdaptivePlanner 把未完成 stage 的 RemoteSourceNode 还原成 Exchange、合并回单棵 PlanNode 树，用 `adaptivePlanOptimizers`（AdaptivePartitioning + AdaptiveReorderPartitionedJoin，含 skew 缓解）重优化再 re-fragment。`optimizeAndMarkPlanChanges` 返回变更的 PlanNodeId 集合，**未变的 stage 复用旧 fragment id**——避免无谓重启已完成的算子。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Pattern 组合子 DSL | `io.trino.matching.Pattern`（lib/trino-matching，sealed：TypeOf/With/Filter/Capture/Or…） | 规则声明"匹配什么形状"，`match()` 产 Stream<Match>+Captures |
| 规则索引 | `RuleIndex.java` 按 `typeOfPattern.expectedClass()` 分桶 | 候选筛选 O(1)，每节点只试相关规则 |
| Memo/GroupReference | `planner/iterative/Memo.java` | 仿 Cascades 的分组共享，重复子树只算一次 |
| Visitor 双层 | `RelationPlanner extends AstVisitor` / `SimplePlanRewriter` | 建树与改写共用遍历协议 |
| 组合代价模型 | `ComposableStatsCalculator` 聚合 40+ `*StatsRule` | 每种 PlanNode 一个统计规则，新增节点即插即用 |

## 模块间交互

- **输入**：analyzer 的 `Analysis`（scope/coercion/resolvedFunction 全取自它）；
- **Metadata 真实调用**：`metadata.getTableProperties(session, node.getTable())`（PlanFragmenter.visitTableScan L364）、`metadata.applyFilter(...)`（谓词下推进 connector）、`metadata.getTableStatistics`（统计）；
- **输出**：`SqlQueryExecution.planDistribution`（L539）把 SubPlan 树交给 `PipelinedQueryScheduler` 或 `EventDrivenFaultTolerantQueryScheduler`（后者构造时 new `AdaptivePlanner`，L579）；
- **执行侧闭环**：PlanFragment 经 JSON 序列化进 `TaskUpdateRequest` 下发 worker，`LocalExecutionPlanner` 翻译为算子（见[执行计划落地与代码生成](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/05-local-execution-gen)）。

## 扩展方式

**新增优化规则**：`planner/iterative/rule/MyRule implements Rule<FilterNode>`——`getPattern()` 用 `PlanNodeType.filter().with(...)` 组合，`apply()` 返回 `Result.ofPlanNode(...)`；在 `PlanOptimizers.java` 对应阶段 ImmutableSet 注册。测试仿各 `Prune*Columns` 的 BaseRuleTest 派生。

**新增 PlanNode 类型**：继承 PlanNode + `PlanNode.java` 的 `@JsonSubTypes` 加条目（注释要求同步 `planprinter/.../utils.js`）+ `plan/PlanVisitor.java` 加 `visitXxx` + `planprinter/` 渲染与行数估算 + `LocalExecutionPlanner.Visitor` 映射算子。sanity 的 `ValidateDependenciesChecker` 等走泛化 `getSources()` 通常无需改，但 `PlanSanityChecker` 新增专项 Checker 需在其 Multimap<Stage,Checker> 注册。

**改分区策略**：动 `AddExchanges`（PreferredProperties/ActualProperties/PropertyDerivations 三件套决定插哪种 Exchange）与 `NodePartitioningManager`/`SystemPartitioningHandle`；connector 侧分区经 `PartitioningHandle` 落到 fragment。
