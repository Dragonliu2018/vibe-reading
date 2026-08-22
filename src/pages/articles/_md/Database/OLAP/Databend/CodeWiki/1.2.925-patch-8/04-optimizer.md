---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "优化器"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "Cascades", "优化器", "DPhyp"]
description: "Databend 查询优化器——Cascades 框架 + Memo/Group 搜索空间 + DPhyp Join Reorder + 代价模型。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

优化器模块（`src/query/sql/src/planner/optimizer/`，属 `databend-common-sql` crate）负责将 Binder 产出的逻辑计划树 `SExpr` 优化为代价最优的执行计划。它基于经典 **Cascades 框架**（Memo/Group/MExpr 搜索空间 + 任务驱动），结合**启发式规则重写**（30+ 条）、**DPhyp Join Reorder**（基于代价的连接顺序枚举）和**可配置代价模型**。

## 模块架构

优化器以 `OptimizerPipeline` 编排多个有序优化器，从启发式重写到 Cascades CBO 依次执行：

```
SExpr → [RecursiveRuleOptimizer: 30+ 重写规则]
      → [DPhpyOptimizer: Join Reorder]
      → [CascadesOptimizer: CBO 搜索最优物理计划]
      → 优化后 SExpr
```

Cascades 内部以 `Memo`/`Group`/`MExpr` 组织搜索空间，`TaskManager` 任务队列驱动探索，`CostModel` 计算代价，`Rule` 系统做等价变换。

## 调用链路

```
optimize(opt_ctx, plan)                     [optimizer.rs:69]
└── optimize_query(opt_ctx, s_expr)         [optimizer.rs:247]
    └── OptimizerPipeline::new().add(...).execute()
        ├── SubqueryDecorrelatorOptimizer   — 子查询去关联
        ├── CollectStatisticsOptimizer      — 收集叶子统计
        ├── RecursiveRuleOptimizer(DEFAULT_REWRITE_RULES)  — 30+ 启发式
        ├── DPhpyOptimizer                  — DPhyp Join Reorder
        ├── CascadesOptimizer               — Cascades CBO（核心）
        └── CleanupUnusedCTEOptimizer
```

Cascades 内部：`optimize_internal`（`cascade.rs:173`）→ `Memo::init` 插入 SExpr → `TaskManager` 调度 `OptimizeGroupTask`→`OptimizeExprTask`→`ApplyRuleTask` → `find_best_plan` 从 root Group 的 `best_props` 提取最优 MExpr 重建 SExpr。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `OptimizerPipeline::execute` | 顺序执行所有优化器 | 每个 optimizer 独立，memo 传递 |
| `CascadesOptimizer::optimize_internal` | Memo 初始化+任务调度 | `StrategyFactory` 按是否 dphyp 选规则集 |
| `TaskManager::run` | 任务队列循环 | `DEFAULT_TASK_LIMIT=1_250_000`（~5s 上限） |
| `Memo::init` | SExpr→Memo 递归插入 | `m_expr_lookup_table` 去重 |
| `Group::update_best_cost` | 更新最优代价 | `best_props: RequiredProperty→CostContext` |
| `DefaultCostModel::compute_cost` | 代价计算 | 按算子类型分派，行数×因子 |
| `DPhpyOptimizer` | Join Reorder | DPhyp 退化到 Greedy（emit>10000） |

</details>

## 核心实现

### Memo / Group / MExpr 搜索空间

**`Memo`**（`ir/memo.rs`）是 Cascades 搜索空间容器，`init()` 递归插入 SExpr 时通过 `m_expr_lookup_table`（`HashMap<(plan, children), index>`）去重。**`Group`**（`ir/group.rs`）是逻辑等价表达式集合，含 `best_props: HashMap<RequiredProperty, CostContext>` 记录每个物理属性需求下的最优表达式，状态机 `Init→Explored`。**`MExpr`**（`ir/expr/m_expr.rs`）是 Group 内表达式，通过 `children: Vec<IndexType>` 引用子 Group 而非子树。

```rust title="group.rs"
pub struct Group {
    pub m_exprs: Vec<MExpr>,                                    // 逻辑等价表达式集
    pub best_props: HashMap<RequiredProperty, CostContext>,     // 物理属性→最优代价
    pub stat_info: Arc<StatInfo>,
    pub state: GroupState,  // Init | Explored
}
```

### 任务驱动执行

`TaskManager`（`optimizers/cascades/tasks/`）用 `VecDeque<Task>` 任务队列驱动搜索，`DEFAULT_TASK_LIMIT = 1_250_000`（约 5 秒上限）。任务类型链：`OptimizeGroupTask`→`ExploreGroupTask`/`OptimizeExprTask`→`ExploreExprTask`→`ApplyRuleTask`。

**代价下界剪枝**（`optimize_expr.rs:204`）：`OptimizeExprTask` 维护 `cost_lower_bound`，子 Group 优化完后更新下界，超过当前最优则直接跳过。`SharedCounter` 实现父子任务引用计数，父任务在子任务完成前被 requeue。

### 规则系统

`Rule` trait（`optimizers/rule/rule.rs:72`）定义 `matchers()`（匹配模式）和 `apply()`（变换），`RuleFactory::create_rule()` 按 `RuleID` 创建实例。`RuleID` 枚举列出 ~40 条规则，分 Rewrite 规则（PushDownFilterJoin/MergeLimit）和 Exploration 规则（CommuteJoin/LeftExchangeJoin/EagerAggregation）。`AppliedRules` 用 `RoaringBitmap` 记录已应用规则防重复。

`MExpr::apply_rule()` 使用 `PatternExtractor` 从 Memo 按 `Matcher` 提取匹配的 SExpr 候选，调用 `rule.apply_matcher()`，结果经 `insert_from_transform_state()` 插回 Memo。

### 代价模型

`DefaultCostModel`（`optimizers/cascades/cost/model.rs`）按算子类型分派计算，**基于行数的线性模型**——代价 = `cardinality * per_row_factor`：

```rust title="model.rs"
pub struct DefaultCostModel {
    compute_per_row: f64,       // 固定 1.0
    hash_table_per_row: f64,    // 从 settings 读取
    aggregate_per_row: f64,
    network_per_row: f64,
    cluster_peers: usize,
    degree_of_parallelism: usize,
}
```

关键代价：`Scan` = card×compute；`Join` = build_card×hash_table + probe_card×compute；`Exchange::Merge` 极高代价（×cluster_peers×DOP×100，因破坏并行度）；`Exchange::Broadcast` = network×(peers-1)。代价因子从 session settings 读取，可运行时调整。

### DPhyp Join Reorder

`DPhpyOptimizer`（`optimizers/hyper_dp/dphyp.rs`）基于论文 "Dynamic Programming Strikes Back"（注释 `dphyp.rs:46`）。**自适应策略**：先尝试 DPhyp 动态规划，当 `emit_count > EMIT_THRESHOLD(10000)` 时退出 fallback 到 Greedy（`find_minimum_cost_pair` 选最小代价连接对）。

`RELATION_THRESHOLD = 10`，超过时限制邻居枚举数量减少 clone 开销。DPhyp 与 Cascades 协作：DPhyp 先运行设置 `opt_ctx.set_flag("dphyp_optimized", true)`，Cascades 的 `StrategyFactory` 检查此 flag——已优化则用 `DPhypStrategy`（仅 EagerAggregation，不重排 join 顺序），否则用 `RSL1Strategy`（含 CommuteJoin 等生成左深树）。

### 统计信息与选择率

`CollectStatisticsOptimizer` 在 Cascades 前收集叶子节点精确统计（表行数、列统计、histogram）。`SelectivityEstimator`（`ir/stats/selectivity.rs`）用 `ConstantFolder` 做表达式折叠后计算选择率——比较谓词基于 min/max/ndv/histogram 估，`AND` 取最小选择率（非独立假设乘积，避免低估），`OR` 用独立假设累加公式 `acc += (1-acc)*n`。默认选择率 `DEFAULT_SELECTIVITY = 1/5`。

`ColumnStat`（`ir/stats/column_stat.rs`）含 `min`/`max`/`ndv`（distinct 值数）/`null_count`/`histogram`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Cascades 框架 | `ir/memo.rs` Memo/Group | 搜索空间去重 + 增量探索 + 代价下界剪枝 |
| 任务驱动 | `tasks/task_manager.rs` | 替代递归，支持任务预算限制，超限优雅降级 |
| 规则系统 | `rule/rule.rs` Rule + Matcher | Pattern 匹配 + apply 变换，`RuleFactory` 工厂创建 |
| 策略模式 | `rule/explore_strategy.rs` StrategyFactory | 按是否 dphyp 优化选不同规则集 |
| 代价模型可配置 | `cost/model.rs` 从 settings 读因子 | 运行时调整代价权重 |

**为什么用 Cascades 而非 Volcano**：(1) Memo 去重避免重复搜索；(2) 任务驱动支持搜索预算（Volcano 是递归难控制）；(3) Group 状态机 `Init→Explored` 支持增量优化新加入的 MExpr；(4) 代价下界剪枝。**失败 fallback**：`optimize_sync`（`cascade.rs:89`）捕获错误回退到 `DistributedOptimizer` 或原表达式，保证查询不因优化器 bug 失败。

## 模块间交互

优化器依赖 `databend-common-expression`（`ScalarExpr`/`ConstantFolder`/`Domain`/`StatEvaluator`）、`MetadataRef`（表/列元数据）、`TableContext`（表统计/集群配置/settings）。被 sql planner 调用，入口 `optimize(opt_ctx, plan)` 接收 binder 产出的 `Plan` 返回优化后 `Plan`。

## 扩展方式

**新增一条优化规则**：在 `optimizers/rule/rule.rs` 的 `RuleID` 枚举添加 ID → 新建规则文件实现 `Rule` trait（`matchers`+`apply`）→ 在 `factory.rs` 的 `RuleFactory::create_rule` 注册 → 加入 `DEFAULT_REWRITE_RULES`（启发式）或 `explore_strategy.rs` 的 `RSL1Strategy`（Cascades 探索）。

**新增一个 Cost 因子**：在 `DefaultCostModel` struct 添加字段 → `new()` 从 settings 读取 → `compute_cost_impl` 对应算子分支使用 → 在 settings crate 注册配置项。
