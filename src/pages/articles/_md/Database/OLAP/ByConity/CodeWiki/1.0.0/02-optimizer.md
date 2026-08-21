---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "查询优化器"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "C++", "Cascades", "CBO", "查询优化"]
description: "ByConity 自研 Cascades 代价优化器：Rewriter 链 + Memo/TaskStack 搜索 + Property 驱动物理算子选择。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/00-overview)

---

## 模块定位

ClickHouse 21.8 只有基于规则的优化（谓词下推、投影裁剪），**没有代价优化器（CBO）**，join reorder 能力极弱。ByConity 自研了一套完整的查询优化器（`src/Optimizer/`，约 79k 行），基于 Cascades 框架实现基于代价的 join 重排、多 join 枚举、分布式属性感知。这是 ByConity 相对 ClickHouse 最大的自研增量。

优化器是查询执行的中间环节：上游接收 `QueryPlan`（逻辑计划树），下游产出优化后的 `QueryPlan`，再由 `PlanSegmentSplitter` 切分为分布式执行计划。它与存储/协调模块解耦——只经 Catalog 取表统计、经 QueryPlan 产出计划。

---

## 模块架构

```text
PlanOptimizer::optimize(plan, context)
  │
  ├─ 入口判断: PlanPattern::isSimpleQuery → 选 SimpleRewriters 或 FullRewriters
  │
  ├─ Rewriter 链（责任链，顺序敏感）:
  │    HintsPropagator → ColumnPruning → UnifyNullableType
  │    → 表达式规范化 / 子查询消解 / Set 操作 / 谓词下推 / JoinGraph
  │    → SimpleReorderJoin（启发式）→ MaterializedViewRewriter → TopN
  │    → CascadesOptimizer（CBO 核心）   ★
  │    → AddRuntimeFilters → AddCache ...
  │
  └─ CascadesOptimizer（作为 Rewriter 链一环）
       ├─ initMemo: QueryPlan → Memo(Group/GroupExpression)
       ├─ TaskStack 搜索: OptimizeGroup → OptimizeExpression → ApplyRule → OptimizeInput
       └─ buildPlanNode: Winner → 优化后 PlanNode
```

优化器把"规则改写"与"代价搜索"统一进同一条 Rewriter 责任链——`CascadesOptimizer` 本身也是 `Rewriter` 的子类（`PlanOptimizer.cpp:282`），与 rule-based rewriter 无缝衔接。这种设计让 Cascades 可与前后任意规则组合，灰度可控。

---

## 调用链路

```text
InterpreterSelectQueryUseOptimizer::buildQueryPlan
  └─ QueryRewriter().rewrite(query_ptr)            → ASTPtr（改写）
  └─ QueryAnalyzer::analyze(query_ptr)             → AnalysisPtr（列/表/类型解析）
  └─ QueryPlanner().plan(query_ptr, analysis)      → QueryPlanPtr（逻辑计划树）
  └─ PlanOptimizer::optimize(*query_plan, context)  [PlanOptimizer.cpp:331]
       └─ 选 rewriters（Simple / Full）
       └─ for each rewriter: rewritePlan(plan)
            └─ CascadesOptimizer::rewrite(plan, context)
                 ├─ initMemo()：QueryPlan → GroupExpression 树插入 Memo（CascadesOptimizer.cpp:158）
                 ├─ root 要求 Property{SINGLE, COORDINATOR}
                 ├─ optimize()：OptimizeGroup 压入 TaskStack，循环 pop&execute
                 └─ buildPlanNode()：从 root Winner 递归提取物理 PlanNode
  └─ PlanSegmentSplitter::split(plan, ctx)          → PlanSegmentTree（分布式分片）
```

数据类型变化：`ASTPtr` → `AnalysisPtr` → `QueryPlanPtr`（逻辑）→ `Memo`（等价表达式图）→ 优化后 `QueryPlan`（物理）→ `PlanSegmentTree`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `PlanOptimizer::optimize` | 编排 Rewriter 链 | Simple/Full 分流 |
| `CascadesOptimizer::rewrite` | 把 plan 喂进 Memo 搜索 | 作为 Rewriter 一环 |
| `CascadesOptimizer::optimize` | TaskStack 搜索最优 plan | 栈式 push/pop，超时+任务数上限 |
| `CascadesOptimizer::buildPlanNode` | 从 Winner 提取物理 plan | 递归 copy-out |
| `CostCalculator::calculate` | 算单算子代价 | Visitor 模式 |
| `CardinalityEstimator::estimate` | 估算输出行数/统计 | 基于 Histogram |
| `PropertyMatcher::match*` | 判断 actual 是否满足 required | 不满足则 enforce |
| `PropertyEnforcer::enforce*` | 插入 Exchange 算子 | remote/local |
| `QueryUseOptimizerChecker::check` | 判断是否走新优化器 | 灰度回退 |

</details>

---

## 核心实现

### Rewriter 责任链

`getFullRewriters()`（`PlanOptimizer.cpp`）返回一条顺序敏感的 Rewriter 列表，`optimize` 依次调用每个 `rewriter->rewritePlan`（内部先 `isEnabled()` 再 `rewrite()`）。链序不可随意变更——例如 `MaterializedViewRewriter` 必须在 `CascadesOptimizer` 之前执行以避免 MV 匹配失败；`AddRuntimeFilters` 在 Cascades 之后生成动态过滤器。超时抛 `OPTIMIZER_TIMEOUT`。这条链把 30+ 规则与 CBO 编排成一条可灰度的管道。

### Cascades 搜索

Cascades 是优化器的核心，深入机制见 [Cascades 框架深度解读](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/02-optimizer-cascades)。要点：`Memo` 用 `group_expressions` hashmap 对 `GroupExpression` 去重（避免子表达式重复计算）；`TaskStack` 以 push-based 方式调度四类 task（`OptimizeGroup`→`OptimizeExpression`→`ApplyRule`→`OptimizeInput`）；`OptimizeInput` 用 `CostCalculator` 算代价、`PropertyMatcher` 判断属性满足度、不满足则 `PropertyEnforcer` 插入 Exchange 并累加 cost，更新 `Group::lowest_cost_expressions`。上限 10000 个 Group / 100000 个 task，超时由 `cascades_optimizer_timeout` 控制。

### Property 驱动物理算子选择

`Property`（`Property/Property.h`）描述物理属性：`node_partitioning`（跨节点分布）、`stream_partitioning`（跨线程）、`sorting`、`cte_descriptions`。`Partitioning::Handle` 枚举含 `SINGLE`/`FIXED_HASH`/`FIXED_BROADCAST`/`BUCKET_TABLE` 等。

`OptimizeInput::enforcePropertyAndUpdateWinner`（`Task.cpp:705`）先 `PropertyDeriver::deriveProperty` 推导输出属性，再 `PropertyMatcher` 判断是否满足 required——不满足则 `PropertyEnforcer::enforceNodePartitioning`（插 remote Exchange）/ `enforceStreamPartitioning`（插 local Exchange）并累加 cost。`PropertyDeterminer::determineRequiredProperty` 为每个算子推导对子节点的属性需求（如 Join 需要 hash-partitioned 或 broadcast）。这是 Cascades 把"分布式执行感知"内建进优化器的关键——Exchange 算子由属性匹配自动插入，而非事后手工加。

### 基数与代价估算

`CardinalityEstimator`（`CardinalityEstimate/`）是 Visitor，自底向上为每个 Step 估算输出行数与符号统计（`SymbolStatistics`）。`SymbolStatistics` 提供 `estimateEqualFilter`/`estimateInFilter` 等 selectivity 估算，基于等深直方图（`Statistics::Histogram`）与 ndv。`TableScan` 节点从 Catalog 取真实表级统计（`Group::addExpression` 中 `CardinalityEstimator::estimate`，`Group.cpp:111`）。`CostCalculator`（`CostModel/`，Visitor）结合统计与 `worker_size` 算每个算子代价。`enable_cbo=false` 时 cost 恒 0（`Task.cpp:810`），退化为纯规则驱动——这是灰度开关。

### 灰度切换与查询改写

`QueryUseOptimizerChecker::check`（`QueryUseQueryChecker.cpp:105`）检查 `enable_optimizer` setting、server 类型（worker 不走优化器）、存储引擎是否 `supportsOptimizer()`、SQL 特性兼容性（子查询/table function/external table 等），不支持则 `turnOffOptimizer` 回退旧 `InterpreterSelectQuery` 路径。`executeQueryImpl` 捕获优化器异常，对部分错误码（TIMEOUT 等）不降级直接抛出。

`MaterializedViewRewriter` 基于 Goldstein & Larson 论文实现 MV 改写；`AddRuntimeFilters` 在 Cascades 之后生成 runtime filter，从 join build 侧收集值发往 probe 侧，做动态分区裁剪与减少 exchange shuffle。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Memo/Group | `Cascades/Memo.h`、`Group.h` | 等价表达式去重共享 |
| 规则驱动 Strategy | `Rule/Rule.h` | 每条 Rule 声明 pattern + transform |
| 任务栈调度 | `Cascades/Task.h` | Cascades 经典 push-based 调度 |
| Visitor | `CostVisitor`/`CardinalityVisitor`/`DeriverVisitor` | 按 Step 类型分发 |
| 责任链 | `Rewriter/Rewriter.h` | Rewriter 顺序执行，可 enable/disable |
| Property 匹配策略 | `PropertyMatcher.h`/`PropertyEnforcer.h` | 自动插入 Exchange |

---

## 模块间交互

Optimizer import：`QueryPlan`（PlanNode/Step/CTEInfo）、`Parsers`（AST）、`Statistics`（Histogram）、`Interpreters/Context`（Settings、WorkerGroup）、`Storages`（取 worker_size）。被 `InterpreterSelectQueryUseOptimizer` 调用。统计信息来自 Statistics 模块（经 Catalog 查表级统计，`DaemonJobAutoStatistics` 周期采集）。优化后 plan 经 `PlanSegmentSplitter` 切分，交 DistributedStages 调度。

---

## 扩展方式

**新增 transformation rule**：在 `Rule/Transformation/` 新建类继承 `Rule`，实现 `getType()`/`getPattern()`（用 `Pattern` DSL 匹配 plan 结构）/`transformImpl()`（返回 `TransformResult`），在 `CascadesContext` 构造（`CascadesOptimizer.cpp:248-281`）`transformation_rules.emplace_back`。

**新增物理算子的 Property 支持**：在 `PropertyDeterminer::visit##Step` 推导 required property、`PropertyDeriver::visit##Step` 推导输出 property、`PropertyEnforcer` 实现 exchange enforcement、`CostVisitor::visit##Step` 实现代价、`CardinalityVisitor::visit##Step` 实现基数估算——五处配套。

**接入新统计类型**：在 `SymbolStatistics` 新增字段，`TableScanEstimator` 从 Catalog 读取，各 `FilterEstimator`/`JoinEstimator` 使用。
