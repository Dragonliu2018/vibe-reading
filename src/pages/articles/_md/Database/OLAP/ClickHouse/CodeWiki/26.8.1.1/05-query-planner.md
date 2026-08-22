---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "查询计划器"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "Planner", "QueryPlan", "优化器"]
description: "ClickHouse 查询计划器源码解读——QueryTree→QueryPlan step 树、18+ 优化 pass、子规划器与 ActionsDAG。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/Planner/` + `src/Processors/QueryPlan/` 把 Analyzer 的 QueryTree 转为 `QueryPlan`（由 `IQueryPlanStep` 组成的 N 叉树），并做计划优化。它独立成模块因为"计划生成与优化"和"语义分析"是不同阶段——Planner 专注正确性构建，优化器专注性能变换，分离使两者可独立演进。

## 模块架构

```text
src/Planner/
  ├─ Planner.h/.cpp           ── 主类（建造者），buildPlanForQueryNode 按 SQL 语义加 step
  ├─ PlannerActionsVisitor.h  ── QueryTree 表达式→ActionsDAG（访问者）
  ├─ PlannerAggregation.h     ── 聚合子规划（提取 AggregateDescriptions）
  ├─ PlannerJoins.h           ── JOIN 子规划（chooseJoinAlgorithm）
  ├─ PlannerSorting.h         ── 排序子规划
  ├─ PlannerWindowFunctions.h ── 窗口函数子规划
  ├─ ActionsChain.h           ── 跨阶段表达式链（消除重复计算）
  └─ PlannerContext.h         ── 列标识符、表表达式数据
src/Processors/QueryPlan/
  ├─ QueryPlan.h/.cpp         ── QueryPlan step 树（std::list<Node>）
  ├─ IQueryPlanStep.h         ── step 抽象基类（updatePipeline 转换为 processor）
  ├─ ITransformingStep.h      ── 单入单出 step 中间抽象
  └─ Optimizations/           ── 18+ first-pass 优化 + second-pass 优化
```

## 调用链路

```text
Planner(query_tree, options, planner_context) in Planner.cpp:1920
  └─ buildQueryPlanIfNeeded() in Planner.cpp:1952
     ├─ UNION → buildPlanForUnionNode()
     └─ otherwise → buildPlanForQueryNode() in Planner.cpp:2133
        ├─ collectSets/collectMaterializedCTEs/collectTableExpressionData
        ├─ buildJoinTreeQueryPlan → JoinTreeQueryPlan（JOIN 树计划）
        ├─ buildExpressionAnalysisResult（分析 WHERE/HAVING/聚合/窗口/排序/投影）
        └─ 按 QueryProcessingStage 分阶段 add*Step：
           ├─ isFirstStage: addFilterStep(WHERE) → addExpressionStep → addAggregationStep
           ├─ isIntermediateStage: addMergingAggregatedStep
           └─ isSecondStage: addMergingAggregated → addFilterStep(HAVING) → addWindowSteps
              → addSortingStep → addLimitStep → addOffsetStep
  → QueryPlan::optimize() in QueryPlan.cpp:792
     ├─ tryRemoveRedundantSorting（零阶段）
     ├─ optimizeTreeFirstPass（18 种优化：filter_push_down/liftUpUnion/removeRedundantDistinct...）
     └─ optimizeTreeSecondPass（read-in-order/prewhere/lazy materialization/join 优化...）
  → QueryPlan::buildQueryPipeline() in QueryPlan.cpp:223
     └─ 后序遍历 step 树：子 pipeline → step->updatePipeline → IProcessor
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Planner::buildPlanForQueryNode` in `Planner.cpp:2133` | 按 SQL 语义加 step | 按 QueryProcessingStage 分阶段 |
| `PlannerActionsVisitor::visit` | QueryTree→ActionsDAG | Facade，实际在 Impl |
| `QueryPlan::addStep` in `QueryPlan.h` | 线性追加到树根 | 单输入 step |
| `QueryPlan::unitePlans` | 多输入合并 | Union/Join 用 |
| `QueryPlan::optimize` in `QueryPlan.cpp:792` | 18+ 优化 pass | 三遍遍历到不动点 |
| `QueryPlan::buildQueryPipeline` | step 树→pipeline | 后序遍历 |
| `IQueryPlanStep::updatePipeline` | step→processor | 策略接口 |

</details>

## 核心实现

### QueryPlan：step N 叉树

```cpp title="src/Processors/QueryPlan/QueryPlan.h"
class QueryPlan {
    struct Node {
        QueryPlanStepPtr step;
        std::vector<Node *> children = {};
    };
    using Nodes = std::list<Node>;          // list 非 vector：优化时频繁插入删除，指针稳定
    Nodes nodes;                            // 节点内存池
    Node * root = nullptr;
public:
    void addStep(QueryPlanStepPtr step);     // 单输入：挂到 root 下
    void unitePlans(QueryPlanStepPtr step, std::vector<QueryPlanPtr> plans);  // 多输入
    void optimize(const QueryPlanOptimizationSettings &);
    QueryPipelineBuilderPtr buildQueryPipeline(...);   // 后序遍历
};
```

`std::list<Node>` 而非 `std::vector`：优化过程频繁插入/删除节点，list 保证 `Node*` 不因扩容失效。`extractSubplan`（`QueryPlan.h:185`）抽取子计划用于分布式查询分阶段。

### IQueryPlanStep：策略接口

```cpp title="src/Processors/QueryPlan/IQueryPlanStep.h"
class IQueryPlanStep {
    virtual String getName() const = 0;
    virtual QueryPipelineBuilderPtr updatePipeline(
        QueryPipelineBuilders pipelines, const BuildQueryPipelineSettings &) = 0;
    SharedHeaders input_headers;
    SharedHeader output_header;
    Processors processors;
};
```

`updatePipeline` 是核心：接收子节点 pipeline，返回包含本 step processor 的 pipeline。70+ step 子类（`AggregatingStep`/`FilterStep`/`SortingStep`/`JoinStep`/`UnionStep`/`ReadFromMergeTreeStep`...）各是具体策略。

### 优化器：18+ pass 后处理

优化独立于 Planner（`QueryPlan::optimize`，不在 `buildPlanForQueryNode`）——关注点分离：Planner 专注语义正确性，优化器专注性能。三遍遍历：

```cpp title="src/Processors/QueryPlan/Optimizations/Optimizations.h"
// getOptimizations() 返回 18 个 first-pass 优化
{liftUpArrayJoin, "lift_up_array_join"},
{pushDownLimit, "push_down_limit"},
{splitFilter, "split_filter"},
{mergeFilters, "merge_filters"},
{filter_push_down, "filter_push_down"},
{convertOuterJoinToInnerJoin, ...},
{removeRedundantDistinct, ...},
{tryOptimizeTopK, ...},
// ... 共 18 个
```

每个优化有独立 `QueryPlanOptimizationSettings::*` 开关，用户可 `SET optimize_plan=0` 控制。Second-pass 含 `optimizeReadInOrder`、`optimizePrewhere`、`optimizeLazyMaterialization2`、`optimizeAggregationInOrder` 等。

### 子规划器：纯函数式提取器

`PlannerAggregation`/`PlannerJoins`/`PlannerSorting`/`PlannerWindowFunctions` 不创建 step，只提取描述符（`AggregateDescriptions`/`SortDescription`/`WindowDescriptions`）——签名是输入 QueryTreeNodes+PlannerContext、输出描述符。step 创建逻辑集中在 `Planner.cpp` 的 `add*Step` 函数，保持一处定义。JOIN 的 `chooseJoinAlgorithm`（`PlannerJoins.h:282`）按类型/settings 选 hash/direct/partial_sort/merge join。

### ActionsChain：跨阶段消除重复

`ActionsChain`（`src/Planner/ActionsChain.h`）把 WHERE/Before GROUP BY/Projection/Before ORDER BY 各阶段的 `ActionsDAG` 串联，`finalize()` 反向传播所需列，裁剪冗余输入与计算。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 访问者 | `PlannerActionsVisitor` | 按 QueryTreeNodeType 分派 |
| 组合 | `QueryPlan::Node` step 树 | N 叉树支持多输入 |
| 建造者 | `Planner` | 接收 QueryTree 逐步加 step |
| 策略 | `IQueryPlanStep::updatePipeline` | 70+ step 各自转换为 processor |
| 责任链 | `ActionsChain` | 跨阶段列传递 |

## 重要设计决策

### QueryPlan 为什么用 step 树而非线性指令序列

多输入 step（Join/Union/Intersect）需多子 pipeline；分布式查询分阶段执行需 `extractSubplan` 抽子树；优化器需局部性对子树变换；`buildQueryPipeline` 后序遍历依赖树结构组织。

### Plan 优化在 Planner 还是后处理

后处理（`QueryPlan::optimize`）。分离使优化可组合（迭代到不动点）、可独立开关（每 pass 有 settings 开关）、Planner 只做正确性构建不被优化逻辑污染。

## 扩展方式

新增 plan step `CacheStep`：建 `src/Processors/QueryPlan/CacheStep.h` 继承 `ITransformingStep`，实现 `updatePipeline` 创建对应 processor；`Planner.cpp::buildPlanForQueryNode` 适当位置 `addCacheStep`。需优化器感知则建 `Optimizations/optimizeXxx.cpp` 注册到 `getOptimizations()` 数组。新增 JOIN 算法 `SkewJoin`：实现 `IJoin` 接口，在 `PlannerJoins::chooseJoinAlgorithm` 按 settings 返回。新增优化 pass：建 `Optimizations/optimizeXxx.cpp`，签名 `size_t tryOptimizeXxx(QueryPlan::Node *, Nodes &, ExtraSettings)`，注册到 `getOptimizations()` 并加 settings 开关。

## 模块间交互

Planner 接收 Analyzer 的 QueryTree，输出 QueryPlan 给 `QueryPipelineBuilder`。import `Interpreters`（Context、ActionsDAG、PreparedSets、Aggregator::Params）、`Storages`（IStorage 用于 filter 下推与并行副本）。`QueryPlan::buildQueryPipeline` 后序遍历调用 `IQueryPlanStep::updatePipeline` 把 step 转 `IProcessor`，交执行引擎。
