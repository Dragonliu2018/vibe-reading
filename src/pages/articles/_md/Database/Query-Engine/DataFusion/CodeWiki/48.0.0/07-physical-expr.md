---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "物理表达式"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "PhysicalExpr 求值、等价类与排序/分布传播、Partitioning/Distribution 需求模型。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/physical-expr`（+ `physical-expr-common`）把逻辑 `Expr` 编译成可对 `RecordBatch` 求值的 `PhysicalExpr`，并维护物理优化器赖以推理的元数据：等价类（`EquivalenceProperties`）、排序等价（`OrderingEquivalenceClass`）、分区/分布（`Partitioning`/`Distribution`）与统计。它是逻辑表示到物理执行的桥梁——逻辑 Expr 用列名，物理 `Column` 用列索引；逻辑层做类型 coercion，物理层只管 Arrow kernel 分发。

## 模块架构

```text
physical-expr/
├── physical_expr.rs / physical-expr-common/src/physical_expr.rs  # PhysicalExpr trait（定义在 common）
├── planner.rs          # create_physical_expr：Expr→PhysicalExpr
├── expressions/        # Column/Literal/BinaryExpr/CaseExpr/CastExpr/ScalarFunctionExpr 实现
├── aggregate.rs        # AggregateFunctionExpr + AggregateExprBuilder（聚合状态）
├── scalar_function.rs  # ScalarFunctionExpr
├── equivalence/        # EquivalenceClass/Group + OrderingEquivalenceClass + properties/
├── partitioning.rs     # Partitioning（实际分区）/ Distribution（算子需求）
├── window/             # WindowExpr 实现
├── analysis.rs / statistics/  # 区间分析 + 统计约束传播
└── planner.rs          # 物理化入口
```

`PhysicalExpr` trait 定义在 `physical-expr-common/src/physical_expr.rs:69`，被 `physical-expr` 与 `physical-plan` 共享。

## 调用链路

```text
planner::create_physical_expr(e: &Expr, schema, props) → Arc<dyn PhysicalExpr>   # planner.rs:106
  match e {
    Expr::Column(c) → schema.index_of_column(c)? → Column::new(name, idx)     # 列名→索引
    Expr::Literal → Literal::new(value)
    Expr::BinaryExpr → 递归 left/right → binary(lhs,op,rhs,schema) → BinaryExpr
    Expr::ScalarFunction → 递归 args → ScalarFunctionExpr::try_new(...)
    Expr::Case/Between/IsTrue… → 重写为底层 BinaryExpr 组合
  }

执行期：PhysicalExpr::evaluate(batch) → ColumnarValue(Array | Scalar)
  Column::evaluate → batch.column(index)（零拷贝）
  BinaryExpr::evaluate → apply/apply_cmp 选 Arrow kernel（Array-Array 逐元素 / Array-Scalar 广播）
```

注释（`planner.rs:187`）明确：逻辑规划器负责类型 coercion，物理规划不做 coercion，确保求值时类型已统一，Arrow kernel 直接分发无运行时转换开销。

## 核心实现

### PhysicalExpr trait 与 DynEq/DynHash

```rust title="datafusion/physical-expr-common/src/physical_expr.rs:69"
pub trait PhysicalExpr: Send + Sync + Display + Debug + DynEq + DynHash {
    fn data_type(&self, input_schema: &Schema) -> Result<DataType>;
    fn evaluate(&self, batch: &RecordBatch) -> Result<ColumnarValue>;
    fn evaluate_selection(&self, batch, selection: &BooleanArray) -> Result<ColumnarValue>;
    fn children(&self) -> Vec<&Arc<dyn PhysicalExpr>>;
    fn with_new_children(self: Arc<Self>, children: Vec<Arc<dyn PhysicalExpr>>) -> Result<Arc<dyn PhysicalExpr>>;
    fn evaluate_bounds(&self, children: &[&Interval]) -> Result<Interval>;        // 区间传播
    fn evaluate_statistics(&self, children: &[&Distribution]) -> Result<Distribution>;
    fn propagate_constraints/propagate_statistics(…) -> …;                          // 约束传播
    fn get_properties(&self, children: &[ExprProperties]) -> Result<ExprProperties>;
}
```

trait 约束 `DynEq + DynHash` 是为支持 trait object 的相等比较与哈希——Rust trait object 不能直接约束 `Eq`/`Hash`（object safety），用 `DynEq`/`DynHash` + blanket impl 转发（`:352`），使 `Arc<dyn PhysicalExpr>` 可做 `==` 与 HashMap key。`PhysicalExprRef = Arc<dyn PhysicalExpr>`。`evaluate_selection` 先用 BooleanArray 过滤 batch 再求值，行数不变直接返回否则 `scatter()` 散射回原位置。

### 等价类与排序传播

```rust title="datafusion/physical-expr/src/equivalence/class.rs:227"
pub struct EquivalenceClass { exprs: IndexSet<Arc<dyn PhysicalExpr>> }
pub struct EquivalenceGroup { classes: Vec<EquivalenceClass> }
```

等价关系来源：等值 join on 条件、Filter 谓词（`a=b`）、Alias。`add_equal_conditions(left,right)`（`:363`）搜两表达式是否已在类中，分"都在不同类→合并 bridge/都在同类→无操作/一个在一个不在→加入/都不在→新建"四种，`remove_redundant_entries` 清单元素类，`bridge_classes` 合并有交集的类。`normalize_expr`（`:458`）把表达式替换为所在类 canonical（首个）成员——两个物理不同表达式归一化后可比较。

`EquivalenceProperties`（`equivalence/properties/mod.rs:138`）是顶层元数据容器：`eq_group`（值等价）+ `oeq_class`（排序等价）+ `constants`（已知常量）+ `constraints`（表约束）+ `schema`。`ordering_satisfy_requirement`（`:609`）检查现有排序是否满足需求；`discover_new_orderings`（`:367`）基于单调性推导新排序——`c=f(a,b)` 若 f 在 `[a ASC,b ASC]` 单调则推导 `[c ASC]` 去掉前缀的有效排序。这是排序等价传播，让 `EnforceSorting` 消除不必要 SortExec。

### Partitioning 与 Distribution 需求模型

```rust title="datafusion/physical-expr/src/partitioning.rs:114"
pub enum Partitioning { RoundRobinBatch(usize), Hash(Vec<Arc<dyn PhysicalExpr>>, usize), UnknownPartitioning(usize) }
pub enum Distribution { UnspecifiedDistribution, SinglePartition, HashPartitioned(Vec<Arc<dyn PhysicalExpr>>) }
```

`Partitioning` 描述**实际**数据分布，`Distribution` 描述算子**要求**的输入分布。`Partitioning::satisfy()`（`:153`）检查实际是否满足要求，Hash 分区表达式不完全匹配时用 `eq_group.normalize_expr()` 归一化后比较——`Hash(a)` 满足 `Hash(b)`（当 a=b），这是等价类在分区判断的直接用途。`EnforceDistribution` 据此插 `RepartitionExec`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Strategy | 每 `PhysicalExpr` impl evaluate | 多态分发，Column/BinaryExpr/ScalarFunctionExpr 各自求值 |
| Builder | `AggregateExprBuilder`（`aggregate.rs:63`） | 链式构造聚合表达式 |
| Visitor/DynTreeNode | `DynTreeNode for dyn PhysicalExpr`（`tree_node.rs:28`） | trait object 参与统一树遍历 |
| DynEq/DynHash | blanket impl（`:352`） | trait object 支持 `==`/Hash |
| Snapshot | `snapshot_physical_expr`（`:528`） | 捕获动态表达式状态用于远程序列化 |

## 模块间交互

依赖 `expr`（Expr 逻辑类型/Operator/UDF/Accumulator）、`physical-expr-common`（trait 定义/`LexOrdering`/`datum`）、`common`。被 `physical-plan`（算子求值表达式/构造 `AggregateFunctionExpr`）、`physical-optimizer`（用 `EquivalenceProperties` 推理排序/分区满足性消除 Sort/Repartition）、`physical-planner`（`create_physical_expr` 物理化）依赖。

## 扩展方式

- **新增物理表达式**：在 `expressions/` 新建文件 impl `PhysicalExpr`（`as_any`/`data_type`/`evaluate`/`children`/`with_new_children`/`fmt_sql`），`expressions/mod.rs` 加导出，`planner.rs::create_physical_expr` match 加 `Expr::MyVariant` 分支，参与区间传播则 impl `evaluate_bounds`/`propagate_constraints`，可序列化则 impl `snapshot`。
- **自定义聚合状态**：impl `AggregateUDFImpl`（expr crate）含 `accumulator`/`state_fields`/`groups_accumulator_supported`，物理层经 `AggregateExprBuilder::new(Arc::new(udf), args).order_by(…).alias(…).build()` 构 `AggregateFunctionExpr`（`aggregate.rs:82`），滑动窗口需 `create_sliding_accumulator` 且 Accumulator impl `supports_retract_batch`（`:533`），排序敏感则 impl `order_sensitivity` 返非 Insensitive。
- **扩展等价类推理**：改 `EquivalenceGroup::join`（`class.rs:625`）加新 JoinType 处理，涉排序改 `EquivalenceProperties::join_equivalence_properties`，涉分区检查 `Partitioning::satisfy`。
