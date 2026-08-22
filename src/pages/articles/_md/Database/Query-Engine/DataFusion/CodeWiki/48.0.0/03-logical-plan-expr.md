---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "逻辑计划与表达式"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "LogicalPlan DAG（26 变体）与 Expr 表达式树（30+ 变体），Arc 共享子计划，UDF trait 契约层。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/expr` 是 DataFusion 的**逻辑 IR 与扩展契约层**。它定义查询的逻辑表示（`LogicalPlan` DAG 与 `Expr` 表达式树），以及所有 UDF 的 trait 契约（`ScalarUDF`/`AggregateUDF`/`WindowUDF`）。它是 SQL 规划器（产出 LogicalPlan）、逻辑优化器（重写 LogicalPlan）、物理计划器（消费 LogicalPlan 产 ExecutionPlan）三方共用的"公共语言"，独立于任何具体执行方式。

## 模块架构

expr 内部围绕两个核心 enum 与一组 UDF 抽象组织：

- **`LogicalPlan`**（`logical_plan/plan.rs:203`）：26 变体 enum（`Projection`/`Filter`/`Aggregate`/`Join`/`TableScan`/`Sort`/`Limit`/`Union`/`Subquery`/`Values`/`RecursiveQuery`/`Extension`/`Dml`/`Ddl`/`Copy`/`Explain`/`Analyze`/`Distinct`/`Unnest`/`EmptyRelation`/`Repartition`/`Window`/`Statement`/`SubqueryAlias`/`DescribeTable` 等）。每个持子计划的字段都是 `Arc<LogicalPlan>`。
- **`Expr`**（`expr.rs:278`）：30+ 变体 enum，子表达式一律 `Box<Expr>`。`ScalarFunction` 持 `Arc<ScalarUDF>` + `Vec<Expr>`。
- **UDF 三对**（`udf.rs`/`udaf.rs`/`udwf.rs`）：struct 内持 `Arc<dyn XxxUDFImpl>`，trait 定义接口。
- **`LogicalPlanBuilder`**（`logical_plan/builder.rs:126`）：链式构建 DAG。
- **`UserDefinedLogicalNode`**（`logical_plan/extension.rs:32`）：自定义逻辑节点扩展点。

## 调用链路

逻辑计划的重写流转——优化器在 `LogicalPlan`/`Expr` 两层用 `TreeNode` 做变换：

```text
plan.transform_up(|node| rule.rewrite(node, config))   # TreeNode::transform_up
  → 对每个节点调 rewrite，返回 Transformed<LogicalPlan>
    → node.map_expressions(|e| rewrite_expr(e))         # 节点级 Expr 重写
      → e.transform(|sub| …)                             # Expr 的 TreeNode::transform 递归子表达式
  → 若 transformed=true，用 with_new_exprs/with_new_children 重建节点
```

`LogicalPlan::expressions()`（`plan.rs:407`）经 `apply_expressions` 收集节点级 Expr；`with_new_exprs()`（`:777`）反向重建节点。`schema()`（`:319`）按变体分发：透传型（Filter/Sort/Limit）返回 `input.schema()`，自计算型（Projection/Aggregate/Window/Join）持有 `DFSchemaRef` 在构造时由 `try_new()` 推导。`ExprSchemable` trait（`expr_schema.rs:41`）给 Expr 做类型推导，`get_type` 对 `ScalarFunction` 委托 `func.return_field_from_args()`。

## 核心实现

### LogicalPlan：DAG 而非树（Arc 共享）

```rust title="datafusion/expr/src/logical_plan/plan.rs:2116（Projection 示例）"
pub struct Projection { pub expr: Vec<Expr>, pub input: Arc<LogicalPlan>, pub schema: DFSchemaRef }
// Join: left/right 均为 Arc<LogicalPlan>（plan.rs:3690）
// Union: inputs: Vec<Arc<LogicalPlan>>
```

用 `Arc<LogicalPlan>` 而非 `Box` 是为了让同一子计划被多父节点共享——Optimizer 的 CSE（公共子表达式消除）让两个 Filter 共享同一 TableScan；Union 引用相同计划；优化器重写时未改动子树直接共享 Arc 无需 clone。`Box` 是独占所有权会强制树结构，`Arc` 允许 DAG。

### Expr：enum + 不可变值语义

`#[derive(Clone, PartialEq, Eq, PartialOrd, Hash)]`（`expr.rs:278`）让 Expr 可按值比较/哈希，支持 CSE 去重与等价类分析。enum 允许 exhaustive match，optimizer 精确处理每种类型。子表达式 `Box<Expr>` + 修改须 `TreeNode::transform` 重建整棵树，保证优化器不误改被其他计划引用的表达式。对比 `Box<dyn Expr>` 会丧失 PartialEq/Hash 与模式匹配能力。

### UDF：struct 包裹 trait object 的双分离

```rust title="datafusion/expr/src/udf.rs:56"
pub struct ScalarUDF { inner: Arc<dyn ScalarUDFImpl> }
```

注释（`udf.rs:48`）说明是为**向后兼容**旧 API（早期 `ScalarUDF` 是直接 struct）。三重收益：(1) struct 是稳定具体类型，trait 加方法时 struct 加委派方法即可，不破坏下游；(2) 手动 impl `PartialEq`/`Hash`（`:60`）经 `ScalarUDFImpl::equals()`/`hash_value()` 自定义相等性——两个不同实例但逻辑相同的 UDF 视为相等，对 optimizer 表达式去重关键；(3) `From<F> where F: ScalarUDFImpl + 'static`（`:285`）让 `ScalarUDF::from(MyImpl::new())` 自动装箱。`AggregateUDF`/`WindowUDF` 同构。

### UserDefinedLogicalNode：逻辑层扩展点

```rust title="datafusion/expr/src/logical_plan/extension.rs:32"
pub trait UserDefinedLogicalNode: fmt::Debug + Send + Sync {
    fn inputs(&self) -> Vec<&LogicalPlan>;
    fn expressions(&self) -> Vec<Expr>;
    fn with_exprs_and_inputs(&self, exprs: Vec<Expr>, inputs: Vec<LogicalPlan>) -> Result<Arc<dyn UserDefinedLogicalNode>>;
    // ...
}
```

经 `LogicalPlan::Extension(Extension { node })` 嵌入，optimizer 可经 `with_exprs_and_inputs` 重写。下游（如自定义查询语言）可直接构建含 Extension 节点的 LogicalPlan，绕过 SQL。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Builder | `LogicalPlanBuilder`（`builder.rs:126`） | 链式建 DAG，每方法消费 self 移入 Arc 子计划 |
| Visitor/Transformer | `TreeNode` impl（`logical_plan/tree_node.rs:56`、`expr/src/tree_node.rs`） | 统一递归重写，`Transformed<T>` 短路 |
| Extension（插件） | `UserDefinedLogicalNode`（`extension.rs:32`） | 自定义逻辑节点不经改 expr 源码 |
| Interpreter | `ScalarUDF::invoke_with_args` 等 | 逻辑层持 trait object，执行时委托具体实现 |

## 模块间交互

被 `sql`（产出 LogicalPlan/Expr）、`optimizer`（重写）、`physical-plan`（消费 Accumulator 等）、`core`（re-export 全量 API）依赖。`functions` crate impl `ScalarUDFImpl`/`AggregateUDFImpl`/`WindowUDFImpl`（如 `functions/src/crypto/sha256.rs:78`），经 `make_udf_function!` 宏生成单例与 `Expr` 构造函数。`ContextProvider` trait（`expr/src/planner.rs:40`）定义在 expr，由 core 的 `SessionState` 实现，解耦 sql 规划器与 catalog。

## 扩展方式

- **新增 LogicalPlan 节点**：在 enum 加变体 + struct，同步 `schema()`/`inputs()`/`expressions()`/`with_new_exprs()`/`recompute_schema()`/`tree_node map_children`/display/invariants 分支，并在 `LogicalPlanBuilder` 加方法。改动面较大，优先考虑用 `UserDefinedLogicalNode` Extension 节点替代。
- **新增 ScalarUDF**：在 `functions` crate impl `ScalarUDFImpl`，无需改 expr——契约已支持外部注册。
- **自定义 Expr 重写**：直接用 `plan.transform`/`expr.transform` + `Transformed::yes/no`，不改 expr。
