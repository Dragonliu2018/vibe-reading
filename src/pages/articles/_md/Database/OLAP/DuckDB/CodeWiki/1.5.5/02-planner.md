---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Planner"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Planner", "Binder", "LogicalPlan"]
description: "DuckDB Planner 模块——AST 绑定与逻辑计划生成，Binder 将名称解析到 Catalog 并产出 LogicalOperator 树。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Planner 模块负责将 Parser 产出的 AST（`SQLStatement`）转换为逻辑执行计划（`LogicalOperator` 树）。这个过程包含两个深度交织的阶段：**绑定（Binding）**——将表名/列名解析到 Catalog 中的真实对象，进行类型推导；**逻辑规划（Logical Planning）**——将绑定后的表达式组装为逻辑算子树。DuckDB 将这两个阶段放在同一个 `Binder` 类中，因为绑定过程中需要即时生成部分逻辑算子（如 `LogicalGet` 在绑定 BaseTableRef 时生成），而逻辑算子的生成又依赖绑定结果。

## 模块架构

Planner 的核心是 `Binder` 类，它继承自 `enable_shared_from_this<Binder>`，通过 `parent` 指针形成栈式结构以支持嵌套子查询。三层状态共享是关键设计：`global_binder_state`（跨子查询/view 共享 table index 计数器、StatementProperties）、`query_binder_state`（跨同一查询内不同 clause 共享 active_binders 栈）、binder 本身（per-scope 的 BindContext）。

`LogicalOperator` 类层次包含 30+ 子类，覆盖投影（`LogicalProjection`）、过滤（`LogicalFilter`）、聚合（`LogicalAggregate`）、JOIN（`LogicalComparisonJoin`/`LogicalAnyJoin`/`LogicalDependentJoin`）、扫描（`LogicalGet`）、CTE（`LogicalCTERef`/`LogicalRecursiveCTE`）等。每个算子持有 `vector<unique_ptr<Expression>>` 表达式列表和 `vector<unique_ptr<LogicalOperator>>` 子算子。

`Expression`（BoundExpression）层次包含 18 种已绑定表达式——`BoundColumnRefExpression`（绑定后的列引用，携带 table_index + column_index）、`BoundFunctionExpression`（绑定后的函数调用）、`BoundAggregateExpression`、`BoundCastExpression` 等。

## 调用链路

```
Planner::CreatePlan(statement)                        [planner.cpp:46]
  ├→ binder->Bind(statement)                           — 核心绑定+逻辑规划
  │    └→ Binder::Bind(SQLStatement&)                   [binder.cpp:78] — switch 分派
  │         └→ Bind(SelectStatement&) → BindWithCTE → BindNode(QueryNode&)
  │              └→ BindNode(SelectNode&)                [bind_select_node.cpp]
  │                   ├→ Bind(TableRef&) — 绑定 FROM，查 Catalog → LogicalGet
  │                   ├→ WhereBinder 绑定 WHERE 表达式
  │                   ├→ GroupBinder 绑定 GROUP BY
  │                   ├→ HavingBinder 绑定 HAVING
  │                   ├→ SelectBinder 绑定 SELECT 列表
  │                   └→ BindModifiers (ORDER BY/LIMIT/DISTINCT)
  │              → 产出 BoundSelectNode
  │
  │    └→ Binder::CreatePlan(BoundSelectNode&)          [plan_select_node.cpp:18]
  │         按固定顺序组装 LogicalOperator 树：
  │         root = from_table.plan (LogicalGet)
  │           → LogicalFilter (WHERE) → LogicalAggregate (GROUP BY)
  │           → LogicalFilter (HAVING) → LogicalWindow → LogicalProjection (SELECT)
  │           → VisitQueryNode (DISTINCT/ORDER/LIMIT)
  │
  ├→ FlattenDependentJoins::DecorrelateIndependent()    — 子查询去关联
  └→ Planner::VerifyPlan()                              — 序列化验证（可选）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Binder::Bind(SQLStatement&)` | 按 StatementType switch 分派 | 不用虚函数——不侵入 parser 层 |
| `Binder::BindNode(SelectNode&)` | SELECT 语句绑定 | 先绑定产出 BoundSelectNode，再 CreatePlan 组装 |
| `Binder::CreatePlan(BoundSelectNode&)` | 组装逻辑算子树 | 固定顺序：FROM→WHERE→GROUP→HAVING→WINDOW→SELECT |
| `ExpressionBinder::BindExpression` | 表达式绑定分派 | 按 ExpressionClass switch，子类策略切换 |
| `BindContext::BindColumn` | 列名解析 | 多表同名列抛 Ambiguous 异常 |
| `PlanSubqueries` | 子查询展平 | correlated → LogicalDependentJoin |

</details>

## 核心实现

### 绑定与逻辑规划的交织

`Binder::BindNode(SelectNode&)` 先绑定所有表达式产出 `BoundSelectNode`——此时表名已解析为 Catalog 引用、列名已解析为 `BoundColumnRefExpression`（携带 table_index + column_index）、函数已通过 `FunctionBinder` 查找重载并绑定。然后 `Binder::CreatePlan(BoundSelectNode&)` 按固定顺序组装逻辑算子树：`FROM → WHERE → GROUP BY → HAVING → WINDOW → QUALIFY → UNNEST → SELECT → modifiers`。每一步都调用 `PlanSubqueries(expr, root)` 处理表达式内嵌的子查询。

### ExpressionBinder 策略模式

ExpressionBinder 有 15+ 子类，每个负责一个 SQL clause 的表达式绑定规则。通过 `PushExpressionBinder`/`PopExpressionBinder` 维护 active_binders 栈，在绑定不同 clause 时切换当前 ExpressionBinder。例如 `WhereBinder` 不能绑定别名，`SelectBinder` 可以解析别名，`HavingBinder` 只能引用 group 结果，`OrderBinder` 可引用别名和 ordinal。这种策略模式使得同一表达式在不同 clause 中有不同的绑定语义。

### 子查询处理

子查询处理分三步：绑定阶段创建子 Binder 独立绑定，correlated column 通过 `BindCorrelatedColumns` 沿 active_binders 栈向上尝试绑定并记录到 `correlated_columns`；计划生成阶段 `PlanSubqueries` 根据 scalar/exists/any/all 类型生成不同逻辑算子；去关联阶段 `FlattenDependentJoins::DecorrelateIndependent`（`planner.cpp:98`）将 `LogicalDependentJoin` 转换为常规 JOIN + Aggregate 组合。

### CTE 处理

`BindWithCTE` 模板方法处理 CTE：CTE 定义在 `StatementNode` 的 `cte_map` 中注册，`GetCTEBinding` 沿 binder 父链向上搜索（支持跨作用域引用）。Non-recursive CTE → `LogicalCTERef` + `LogicalMaterializedCTE`；Recursive CTE → `LogicalRecursiveCTE`（含初始查询和递归查询两部分）。`CTEBinding::CanBeReferenced()` 检测循环引用——recursive CTE 首次绑定时不可被自身引用。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Context/环境 | `BindContext` in `bind_context.cpp` | 跟踪当前作用域可见的表/列绑定，随 Binder 栈进出作用域 |
| 策略模式 | `WhereBinder`/`SelectBinder`/`HavingBinder`... | 同一表达式在不同 clause 有不同绑定语义 |
| 分派模式（switch） | `Binder::Bind(SQLStatement&)` in `binder.cpp:78` | 不用虚函数——不侵入 parser 层的 SQLStatement 类 |
| Visitor | `ExpressionIterator`/`LogicalOperatorVisitor` | 遍历表达式/算子树，给 optimizer 提供统一改写框架 |

## 模块间交互

Planner 从 Parser 获取未绑定的 `SQLStatement`（列名是字符串、函数名是字符串、类型未推导）。通过 `CatalogEntryRetriever` 查询 Catalog 获取表/列/函数定义——`TableCatalogEntry::GetColumns()` 提供列信息，`ScalarFunctionCatalogEntry` 提供函数签名。通过 `FunctionBinder::BindScalarFunction` 查找函数重载并绑定。产出 `unique_ptr<LogicalOperator>` 逻辑算子树交给 Optimizer。`BoundSubqueryExpression` 内部持有 `BoundQueryNode`，其 plan 是另一棵 LogicalOperator 子树——Expression 和 LogicalOperator 是组合关系。

## 扩展方式

新增一种逻辑算子：`src/include/duckdb/common/enums/logical_operator_type.hpp` 添加枚举 → 新建 `logical_xxx.hpp` 继承 LogicalOperator → `src/include/duckdb/planner/operator/list.hpp` include → 实现 `ResolveTypes()`/`GetColumnBindings()`/`Serialize/Deserialize` → 在 Binder 的某个 Bind 方法中创建该算子 → `src/common/enum_util.cpp` 添加枚举映射。
