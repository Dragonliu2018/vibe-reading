---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "函数体系"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "ScalarUDF/AggregateUDF/WindowUDF 的 struct+trait 双分离、Accumulator/PartitionEvaluator 状态机与注册宏。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/functions`（+ `functions-aggregate`/`-window`/`-nested`/`-table`/`-aggregate-common`/`-window-common`）实现 UDF 框架的内置函数库。trait 契约定义在 `expr` crate（`ScalarUDF`/`AggregateUDF`/`WindowUDF`），实现分散在 `functions*` 各 crate——这种"契约在 expr、实现在 functions*"的分离是 DataFusion 扩展性的基石。按函数类别分 crate 既控制二进制体积（feature flag 按需启用），又支持方言可替换（Spark vs Postgres）。

## 模块架构

```text
expr/（trait 契约层）
├── udf.rs       # ScalarUDF struct + ScalarUDFImpl trait
├── udaf.rs      # AggregateUDF struct + AggregateUDFImpl trait
├── udwf.rs      # WindowUDF struct + WindowUDFImpl trait
├── partition_evaluator.rs  # PartitionEvaluator trait（窗口状态机）
└── expr-common/accumulator.rs  # Accumulator trait（聚合状态机）

functions/（标量实现层）
├── src/lib.rs     # all_default_functions() + register_all()
├── src/macros.rs  # make_udf_function! / export_functions! / make_math_unary_udf!
└── src/{core,math,crypto,datetime,encoding,regex,string,unicode}/
functions-aggregate/  # Avg/Count/Sum/Stddev/... + make_udaf_expr_and_func!
functions-window/    # Rank/RowNumber/LeadLag/NthValue/... + define_udwf_and_expr!
functions-nested/    # 嵌套类型函数
functions-table/     # 表函数
```

## 调用链路

UDF 从定义到执行的生命周期：

```text
定义：impl ScalarUDFImpl for MyFunc { name/signature/return_type/invoke_with_args }
包装：ScalarUDF::from(MyFunc::new())  或  make_udf_function!(MyFunc, my_func)  # 生成 LazyLock 单例
注册：SessionContext::register_udf(udf)  或  register_all(registry)  # functions/src/lib.rs:181
计划引用：ScalarUDF::call(args) → Expr::ScalarFunction(ScalarFunction{func, args})  # udf.rs:126
物理求值：planner create_physical_expr → ScalarFunctionExpr::try_new(fun, args)
执行：ScalarFunctionExpr::evaluate(batch) → UDF.invoke_with_args(ScalarFunctionArgs) → ColumnarValue
```

聚合多一阶段：`AggregateUDFImpl::accumulator()` 工厂返 `Box<dyn Accumulator>`，执行期 `update_batch`（Partial）→ `state`（序列化中间状态）→ `merge_batch`（Final 合并）→ `evaluate`（最终值）。

## 核心实现

### UDF 双分离：struct 包裹 trait object

```rust title="datafusion/expr/src/udf.rs:56"
pub struct ScalarUDF { inner: Arc<dyn ScalarUDFImpl> }
```

注释（`:48`）说明是为**向后兼容**旧 API（早期 `ScalarUDF` 是直接 struct 存 name/signature/return_type）。三重收益：(1) struct 是稳定具体类型，trait 加方法时 struct 加委派方法不破坏下游；(2) 手动 impl `PartialEq`/`Hash`（`:60`）经 `ScalarUDFImpl::equals()`/`hash_value()` 自定义相等性——两个不同实例但逻辑相同的 UDF 视为相等，对 optimizer 表达式去重关键；(3) `From<F> where F: ScalarUDFImpl + 'static`（`:285`）让 `ScalarUDF::from(MyImpl::new())` 自动装箱。`AggregateUDF`/`WindowUDF` 同构。`ScalarUDFImpl` 必须实现 `as_any`/`name`/`signature`/`return_type`/`invoke_with_args`，可选 `simplify`/`short_circuits`/`evaluate_bounds`/`coerce_types`/`output_ordering` 等——区间分析与类型 coercion 是 trait 一等公民。

### Accumulator/PartitionEvaluator 状态机

```rust title="datafusion/expr-common/src/accumulator.rs:51"
pub trait Accumulator: Send + Sync + Debug {
    fn update_batch(&mut self, values: &[ArrayRef]) -> Result<()>;   // Partial 更新
    fn evaluate(&mut self) -> Result<ScalarValue>;                    // 最终值
    fn state(&mut self) -> Result<Vec<ScalarValue>>;                  // 序列化中间状态
    fn merge_batch(&mut self, states: &[ArrayRef]) -> Result<()>;     // Final 合并
    fn retract_batch(&mut self, values: &[ArrayRef]) -> Result<()>;   // 撤回（窗口用）
    fn supports_retract_batch(&self) -> bool { false }
}
```

`state()`+`merge_batch()` 直接支持 Partial→Repartition→Final 三阶段并行分组（`accumulator.rs:98` 有 ASCII 图解）。Avg 的 state 返 `[count, sum]` 而非单值，因中间状态类型不同于输出类型——这是 trait 方法分离的原因。`retract_batch` 专为滑动窗口设计（撤销离开帧的行），`supports_retract_batch()` 默认 false，仅需窗口聚合的函数 impl（如 Avg，`average.rs:369`）。`PartitionEvaluator`（`expr/src/partition_evaluator.rs:89`）多方法设计对应不同窗口函数类型：`uses_window_frame`/`supports_bounded_execution`/`include_rank` 三标志选 `evaluate`/`evaluate_all`/`evaluate_all_with_rank` 路径。

### 内置函数实现：Avg 与 Rank

`Avg`（`functions-aggregate/src/average.rs:99`）impl `AggregateUDFImpl`，`accumulator()` 工厂按类型分发 `AvgAccumulator`/`DecimalAvgAccumulator<Decimal128Type>`/`<Decimal256Type>`/`DurationAvgAccumulator`（`:116`）；`state_fields` 返 count+sum 两中间状态字段（`:131`）。还有高性能路径 `GroupsAccumulator`（`groups_accumulator_supported` 返 true 时用 `create_groups_accumulator`，`:192`）经 `AvgGroupsAccumulator<T,F>` 批量管所有 group 状态，避免逐 group 虚函数开销。`Rank`（`functions-window/src/rank.rs:198`）impl `WindowUDFImpl`，`partition_evaluator` 工厂创 `RankEvaluator`，同时支持流式（`evaluate` 逐行比 ORDER BY 维护 `RankState`）与批量（`evaluate_all_with_rank` 基于预计算 rank 分区生成结果），`include_rank()→true`/`supports_bounded_execution()→true` 选最优路径。

### 注册宏：消除样板

`make_udf_function!`（`functions/src/macros.rs:74`）生成 `LazyLock` 单例包装函数（`static INSTANCE: LazyLock<Arc<ScalarUDF>>`，`:79`）；`export_functions!`（`:44`）生成 `expr_fn` 模块便捷函数（接受 `Vec<Expr>`/变参调 `.call(args)`）；`make_math_unary_udf!`/`make_math_binary_udf!`（`:155`）为数学函数自动生成 struct+impl+单例。聚合用 `make_udaf_expr_and_func!`（`functions-aggregate/src/macros.rs:39`）组合 `make_udaf_expr!`+`create_func!`，窗口用 `define_udwf_and_expr!`（`functions-window/src/macros.rs:663`）组合 `get_or_init_udwf!`+`create_udwf_expr!`。所有宏用 `LazyLock` 确保只创建一次。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Wrapper/Facade | `ScalarUDF` 包 `Arc<dyn ScalarUDFImpl>`（`:56`） | 委派 + 稳定 API + 自定义 PartialEq/Hash |
| Strategy | 每函数 impl trait，trait object 多态分发 | 函数库可扩展 |
| Registry | `FunctionRegistry` + `register_all`（`:181`） | 注册到 SessionContext |
| Template Method | `Accumulator` 生命周期骨架（update→state→merge→evaluate） | 各实现填具体逻辑 |
| Factory Method | `accumulator()`/`partition_evaluator()` 按类型分发（`average.rs:116`） | 同一 UDF 多类型多实现 |
| Decorator | `AliasedScalarUDFImpl`（`udf.rs:729`）包 inner 覆盖 `aliases` 其余委托 | 函数别名 |
| Singleton | `LazyLock` 单例（所有宏） | UDF 只创建一次 |

## 模块间交互

依赖方向：`expr`（trait 定义）← `functions*`（实现）← `core`（注册与组装）。`physical-expr` 在执行阶段消费 trait object（`invoke_with_args`/`accumulator`/`partition_evaluator`）。`sql` 在 SQL 解析时引用已注册 UDF 查找函数。`functions-aggregate-common` 提取 `DecimalAverager`/`NullState`/`GroupsAccumulatorAdapter` 共享工具，`functions-window-common` 提取 field/partition 共享工具。

## 扩展方式

- **新增标量 UDF**：在 `functions/src/{core,math,...}/` 新建文件定义 struct + impl `ScalarUDFImpl`（`name`/`signature`/`return_type`/`invoke_with_args`/`documentation`），调 `make_udf_function!` 生成单例，加到 `core/mod.rs` 的 `functions()` 返回列表，可选 `export_functions!` 暴露 `expr_fn`，SQL 函数在 `planner.rs` 注册解析规则。
- **新增聚合 UDF**：在 `functions-aggregate/src/` 新建文件，impl `AggregateUDFImpl` + 定义 `XxxAccumulator` impl `Accumulator`，调 `make_udaf_expr_and_func!`，加到 `all_default_aggregate_functions()`，可选高性能 `GroupsAccumulator` 路径。
- **注册第三方函数包**：自己 crate impl `ScalarUDFImpl`，`ScalarUDF::from(MyFunc::new())` 构造，`SessionContext::register_udf` 注册，需 SQL 语法则实现 `sql_planner` 或用 `FunctionRegistry::register_udf` 自动注册函数名查找表。
