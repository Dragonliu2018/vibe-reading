---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "SQL 编译"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "Binder", "Planner", "SExpr"]
description: "Databend SQL 编译模块——Binder 语义绑定 + 不可变 SExpr 计划树 + Metadata 解耦。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

SQL 编译模块（`src/query/sql/`，crate `databend-common-sql`，~109k 行）负责从 AST 到逻辑计划再到物理计划的**编译核心**。它将语法层面的 `Statement` AST 经 Binder 绑定为语义化的 `SExpr`（逻辑表达式树），经优化器优化后由 `PhysicalPlanBuilder` 转为物理计划。优化器是本模块的子模块，因其复杂度独立成篇见 [04-optimizer](04-optimizer)。

## 模块架构

编译模块分三个核心阶段：**Binder**（AST→SExpr 语义绑定）、**Optimizer**（SExpr→优化后 SExpr）、**PhysicalPlanBuilder**（SExpr→PhysicalPlan）。三者通过 `MetadataRef` 共享元数据，通过 `BindContext` 栈管理作用域。

```
Statement(AST) → [Binder] SExpr(逻辑计划) → [Optimizer] SExpr(优化后) → [PhysicalPlanBuilder] PhysicalPlan
                     ↑                         ↑                              ↑
                  BindContext              OptimizerPipeline              match RelOperator
                  (作用域栈)              (多阶段管道)                    (递归构建)
```

## 调用链路

```
Planner::plan_stmt(stmt)                    [planner.rs:242]
├── Binder::bind(stmt)                      [binder.rs:148]
│   └── bind_statement → bind_query/select  → SExpr
├── optimize(opt_ctx, plan)                 [optimizer.rs:69]
│   └── optimize_query → OptimizerPipeline  → 优化后 SExpr
└── PhysicalPlanBuilder::build(s_expr)      [physical_plan_builder.rs:73]
    └── build_physical_plan → match RelOperator → PhysicalPlan
```

数据类型变化：`Statement`（AST）→ `Plan::Query{SExpr}`（逻辑计划）→ 优化后 `Plan::Query{SExpr}` → `PhysicalPlan`（trait object 树）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Planner::plan_sql` | parse + plan 完整入口 | 含 `replace_stmt` 语义预处理 |
| `Planner::plan_stmt` | bind + optimize | 前置 plan_cache 检查 |
| `Binder::bind` | AST→SExpr | `bind_statement` 按 Statement variant 分派 |
| `bind_query`/`bind_select` | 查询绑定 | `ScalarBinder` 绑定表达式→`ScalarExpr` |
| `PhysicalPlanBuilder::build` | SExpr→PhysicalPlan | `match RelOperator` 递归 |

</details>

## 核心实现

### SExpr 不可变计划树

`SExpr`（`optimizer/ir/expr/s_expr.rs:49`）是逻辑/优化后的计划树，采用**不可变 + Arc 共享**设计：

```rust title="s_expr.rs"
pub struct SExpr {
    pub plan: Arc<RelOperator>,           // 关系算子
    pub children: Vec<Arc<SExpr>>,        // 子树
    rel_prop: Arc<OnceLock<Arc<RelationalProperty>>>,  // 惰性缓存属性
    stat_info: Arc<OnceLock<Arc<StatInfo>>>,           // 惰性缓存统计
    pub(crate) applied_rules: AppliedRules,            // 已应用规则位图
}
```

构造方法 `create_leaf`（叶节点如 Scan）、`create_unary`（一元如 Filter）、`create_binary`（二元如 Join）。`rel_prop` 和 `stat_info` 用 `OnceLock` 惰性计算缓存，线程安全。`RelOperator`（`plans/operator.rs:149`）含 24 种关系算子（Scan/Join/Filter/Aggregate/Sort/Limit/Exchange/Window 等）。

**为什么用 SExpr 而非直接优化 AST**：AST 是面向语法的（`SELECT`/`FROM`/`WHERE` 子句分开存储，含语法糖），SExpr 是面向代数的——每个节点是 `RelOperator`，形成标准代数树。优势：(1) 结构化属性推导（`Operator` trait 的 `derive_relational_prop`/`derive_stats`）；(2) 规则匹配（`Matcher`/`PatternExtractor` 可对 SExpr 做模式匹配）；(3) Memo/Cascades 需要代数等价性；(4) `Arc` 共享避免深拷贝。

### BindContext 作用域栈

`BindContext`（`binder/bind_context.rs:145`）通过 `parent: Option<Box<BindContext>>` 形成栈结构，每进入一个子查询（subquery/CTE）push 新 context，退出时 pop：

```rust title="bind_context.rs"
pub struct BindContext {
    pub parent: Option<Box<BindContext>>,
    pub columns: Vec<ColumnBinding>,     // 当前作用域可见列
    pub aggregate_info: AggregateInfo,   // 聚合信息
    pub windows: WindowInfo,
    pub cte_context: CteContext,
    pub in_grouping: bool,
    // ...
}
```

**Binder 如何解耦语义与语法**：`bind_statement`（`binder.rs:163`）对每种 `Statement` 分派到 `bind_xxx`（如 `bind_query`→`bind_set_expr`→`bind_select`）。表达式绑定由 `ScalarBinder`/`TypeChecker` 完成，输出 `ScalarExpr`（语义化表达式），不依赖 AST 结构。Binder 在绑定时通过 `metadata.add_base_table_column`/`add_derived_column` 注册列到 Metadata，后续优化和物理构建通过 MetadataRef 访问，不再触碰 AST。

### Metadata 解耦

`Metadata`（`planner/metadata/metadata.rs:55`）通过 `MetadataRef = Arc<RwLock<Metadata>>` 在 Binder/Optimizer/PhysicalPlanBuilder 间共享。Binder 注册表和列，Optimizer 读取列信息优化，PhysicalPlanBuilder 读取表信息构建物理算子。列用全局唯一的 `Symbol(usize)` 标识，跨模块引用，解耦了绑定与后续阶段对列的访问。

`ColumnEntry` 是 4 变体枚举（`metadata.rs:681`）：`BaseTableColumn`/`DerivedColumn`/`InternalColumn`/`VirtualColumn`。

### PhysicalPlan 与逻辑/物理分离

`PhysicalPlan`（`service/src/physical_plans/physical_plan.rs:272`）不是 enum 而是 trait object 包装：`inner: Box<dyn IPhysicalPlan>`。`IPhysicalPlan` trait 含 ~40 个实现类型（`TableScan`/`HashJoin`/`AggregatePartial`/`Sort`/`Filter`/`Exchange` 等）。

```rust title="physical_plan_builder.rs"
pub struct PhysicalPlanBuilder {
    pub metadata: MetadataRef,
    pub ctx: Arc<dyn TableContext>,
    pub func_ctx: FunctionContext,
    // ...
}
```

`build_physical_plan`（`physical_plan_builder.rs:110`）对 `RelOperator` 做 match 分派到 `build_table_scan`/`build_join`/`build_aggregate` 等。逻辑层（`Operator` trait）关注关系代数语义和属性推导，物理层（`IPhysicalPlan` trait）关注执行管道构建（选择 HashJoin vs RangeJoin、决定 Shuffle vs Broadcast）。分离原因：优化器在逻辑层做等价变换不需关心物理实现，Cascades 在 Memo 中搜索最佳物理实现。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 三层 Visitor | AST 层（`Drive`/`DriveMut`）、SExpr 层（`SExprVisitor`/`AsyncSExprVisitor`）、ScalarExpr 层（`Visitor`/`VisitorMut`） | 不同抽象层各自遍历，关注点分离 |
| SExpr 不可变树 | `s_expr.rs:49` 全 `Arc` | 优化时安全共享子树，`replace_children` 创建新节点 |
| Metadata 解耦 | `metadata.rs:55` `MetadataRef` | 绑定/优化/物理构建共享列信息，不触碰 AST |
| Pipeline 模式 | `optimizer/pipeline/pipeline.rs:30` `OptimizerPipeline` | 优化器有序管道，`.add()` 链式构建 |
| Plan Cache | `planner.rs:252` | 重复 SQL 跳过 bind+optimize |

## 模块间交互

`databend-common-sql` 依赖 `databend-common-ast`（AST 类型）、`databend-common-expression`（`DataType`/`ScalarExpr`）、`databend-common-catalog`（`CatalogManager`/`TableContext`）、`databend-common-functions`（`BUILTIN_FUNCTIONS`）。被 `databend-query`（service）调用——service 调 `Planner::plan_stmt` 生成 `Plan`，再用 `PhysicalPlanBuilder` 转为 `PhysicalPlan`。

## 扩展方式

**新增一种 SQL 语句的 bind**：在 AST `Statement` 枚举添加 variant → 在 `binder.rs` 的 `bind_statement` match 添加分支调 `bind_xxx` → 新建 bind 文件构建 `Plan` variant → 在 `Plan` 枚举添加对应 variant。

**新增一个逻辑计划节点**：在 `plans/` 新建文件定义 struct 实现 `Operator` trait（`rel_op`/`arity`/`derive_relational_prop`/`derive_stats`）→ 在 `operator.rs` 的 `RelOperator` 枚举添加 variant → 在 `PhysicalPlanBuilder::build_physical_plan` match 添加物理构建分支。
