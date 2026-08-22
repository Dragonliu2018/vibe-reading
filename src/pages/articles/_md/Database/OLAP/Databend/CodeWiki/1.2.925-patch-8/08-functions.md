---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "函数库"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "函数", "聚合", "向量化"]
description: "Databend 函数库——标量函数 Builder 注册 + 聚合函数三阶段分布式设计 + Combinator 组合。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

函数库模块（`src/query/functions/`，crate `databend-common-functions`，~65k 行）提供 Databend 的全部内置函数实现——标量函数（scalar）、聚合函数（aggregate）、集合返回函数（SRF）。它采用**双层架构**：`expression` crate 定义抽象（`Function`/`FunctionRegistry`/`AggregateFunction` trait），`functions` crate 提供具体实现和注册。这种解耦使 `Evaluator`（expression crate）在求值 `Expr::FunctionCall` 时直接使用已注册的 trait object，无需知道 functions crate 的存在。

## 模块架构

标量函数通过 **Builder 模式 + 泛型擦除 + 自动向量化**注册；聚合函数通过 **Factory + Combinator + 三阶段设计**注册。两者均在启动时通过 `#[ctor]`/`LazyLock` 构建全局单例注册表，运行时只读。

```
标量: ScalarBuilder → typed_N_arg → passthrough_nullable → vectorized → register
         ↓ 泛型擦除 (EraseFunctionGeneric)
     dyn ScalarFunction → FunctionRegistry

聚合: aggregate_xxx_function_desc() → AggregateFunctionFactory.register()
         ↓ Combinator 后缀组合 (_if/_distinct/_state)
     AggregateFunction trait (accumulate/serialize+merge/merge_result)
```

## 调用链路

**标量函数**：`scalars::register()`（`scalars/mod.rs:57`）依次调各子模块 `register`（arithmetic/string/comparison 等）→ `registry.scalar_builder("name")` 链式构建 → `FunctionRegistry` 存储。

**聚合函数**：`Aggregators::register()`（`aggregator.rs:72`）逐个调 `factory.register("sum", aggregate_sum_function_desc())` → `AggregateFunctionFactory` 存储。

**执行**：`Evaluator::run` 匹配 `Expr::FunctionCall` → `eval_common_call` 递归求值参数 → 取 `function.eval.as_scalar()` 调 `eval(&args, &mut ctx)`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ScalarBuilder` 链 | 标量函数注册 | 编译期类型安全，自动注册 nullable 变体 |
| `vectorize_N_arg` | 逐元素→列级提升 | 自动处理 Scalar/Column 组合 |
| `AggregateFunctionFactory::get_or_null` | 聚合函数查找 | 后缀匹配 Combinator |
| `aggregate` / `batch_merge` | 聚合三阶段 | 支持分布式分阶段聚合 |
| `check_ambiguity` | 启动时检测重载歧义 | `try_unify_signature` 类型合一 |

</details>

## 核心实现

### Function struct 与 FunctionRegistry

`Function`（`expression/src/function.rs`）含 `signature`（name+args_type+return_type）和 `eval: FunctionEval`。`FunctionEval` 是 `Scalar`（含 `calc_domain`/`derive_stat`/`eval`）或 `SRF` 二选一。`ScalarFunction` trait 只有一个方法 `eval(&self, args: &[Value<AnyType>], ctx: &mut EvalContext) -> Value<AnyType>`——`Value` 是 Scalar 或 Column 二选一，函数同时支持标量和批量列式求值。

```rust title="function.rs"
pub struct FunctionRegistry {
    pub funcs: HashMap<String, Vec<(Arc<Function>, usize)>>,      // 按名注册的重载列表
    pub factories: HashMap<String, Vec<(FunctionFactory, usize)>>, // 参数化工厂
    pub aliases: HashMap<String, String>,
    pub default_cast_rules: Vec<(DataType, DataType)>,            // 自动类型转换
    // ...
}
```

`search_candidates` 按名+参数数搜索匹配候选，`check_ambiguity` 用 `try_unify_signature` 做类型合一检查重载歧义。

### 标量函数 Builder 注册与自动向量化

注册采用 Builder 模式链式调用，泛型擦除 + 向量化适配器让开发者只写逐元素逻辑：

```rust title="string.rs — upper 函数注册"
registry.scalar_builder("upper")
    .function()
    .typed_1_arg::<StringType, StringType>()
    .passthrough_nullable()                                    // 自动生成 Nullable 变体
    .vectorized(vectorize_with_builder_1_arg::<StringType, StringType>(
        |val, output, _| { /* 逐元素大写化 */ }
    ))
```

`vectorize_1_arg`/`vectorize_2_arg`（`register_vectorize.rs`）将逐元素标量函数自动提升为列级批量函数——自动处理 Scalar vs Column 的各种组合。`EraseFunctionGeneric1Arg<I1, F>`（`register.rs:779`）将具体类型闭包擦除为 `dyn ScalarFunction`。

**nullable 透传 vs 组合**：`passthrough_nullable` 自动生成 Nullable 变体（输入 Nullable→输出 Nullable，NULL 行跳过函数体）；`combine_nullable` 允许函数自身产生 NULL（如除法除以零）。大多数函数（`upper(NULL)`=NULL）透传即可，`try_cast` 等需组合。

### 聚合函数三阶段设计

`AggregateFunction` trait（`expression/src/aggregate/aggregate_function.rs`）将聚合分三阶段，支撑分布式聚合：

```rust title="aggregate_function.rs"
pub trait AggregateFunction: Send + Sync {
    // 阶段1: accumulate — 局部聚合
    fn accumulate(&self, place: AggrState, columns: ProjectedBlock, ...) -> Result<()>;
    fn accumulate_keys(&self, addrs: &[StateAddr], ...);  // GROUP BY 逐行写入

    // 阶段2: serialize + batch_merge — 跨节点合并
    fn batch_serialize(&self, places, loc, builders) -> Result<()>;
    fn batch_merge(&self, places, loc, state: &BlockEntry, filter) -> Result<()>;

    // 阶段3: merge_result — 最终结果提取
    fn merge_result(&self, place: AggrState, builder: &mut ColumnBuilder) -> Result<()>;
}
```

`AggrState` 是裸指针 wrapper，`place.get::<State>()` 获取具体状态结构体。状态分配由 `AggrStateRegistry` + `Layout` 管理，避免每行分配堆内存。

**为什么三阶段**：(1) 分布式聚合需序列化中间状态跨节点传输，`batch_serialize`/`batch_merge` 将状态转为列格式；(2) `is_decomposable` 标记决定是否可分阶段并行（SUM/COUNT 可以，DISTINCT 不行——去重需全局视图）；(3) `merge_result` 与 `accumulate` 分离使输出类型可与状态类型不同（如 AVG 状态是 sum+count，输出是 sum/count）。

以 `AggregateCountFunction`（`aggregate_count.rs`）为例：状态 `AggregateCountState { count: u64 }`，accumulate `state.count += (input_rows - nulls)`，batch_serialize `builder.push(state.count)`，batch_merge `state.count += other`，merge_result `builder.push(state.count)`。

### UnaryState 模板

`AggregateUnaryFunction<S, T, R>`（`aggregate_unary.rs`）是泛型模板，实现了 `AggregateFunction` trait 所有方法——只需实现 `UnaryState` trait（`add`/`merge`/`merge_result`/`add_batch`）即可获得完整实现。`NumberSumState`（`aggregate_sum.rs`）就是典型 `UnaryState` 实现，大幅减少样板代码。

### Combinator 后缀系统

聚合函数通过函数名后缀组合附加能力，`AggregateFunctionFactory::get_or_null`（`aggregate_function_factory.rs:249`）查找时自动按后缀组合叠加：

| 后缀 | Combinator | 作用 |
| --- | --- | --- |
| `_if` | `AggregateIfCombinator` | 添加 WHERE 条件过滤 |
| `_distinct` | `aggregate_combinator_distinct` | 去重聚合 |
| `_state` | `AggregateStateCombinator` | 返回中间状态而非最终结果 |

此外 `AggregateFunctionCombinatorNull`（NULL 参数适配）和 `AggregateFunctionOrNullAdaptor`（返回 Nullable 适配）在查找时自动叠加。`AggregateFunctionFeatures` 携带 `is_decomposable`/`returns_default_when_only_null`/`allow_sort` 等元信息。

**为什么 Combinator**：避免为每个聚合函数 × 每种组合（count_if、count_distinct、sum_if、sum_distinct...）写单独实现。`AggregateIfCombinator` 包装任意聚合函数自动过滤 WHERE 条件后的行。

### Domain 推导

每个标量函数注册时提供 `calc_domain` 闭包，从输入列 Domain（值域）推导输出列 Domain。`FunctionDomain` 三态：`Full`（全集）/`Domain(d)`（特定域）/`MayThrow`。优化器用 Domain 信息做常量折叠（`WHERE x > 5` 中 x 的 Domain 全部 >5 则结果恒 true）、谓词下推、列裁剪。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 注册表模式 | `FunctionRegistry`/`AggregateFunctionFactory` | HashMap 存储重载，启动时构建运行时只读 |
| Builder 模式 | `ScalarBuilder` 链 | 编译期类型安全，自动注册 nullable 变体 |
| 泛型擦除 | `EraseFunctionGeneric` | 具体类型闭包→dyn trait object |
| 装饰器/适配器 | `adaptors/` 6 个 Combinator | 后缀组合附加能力 |
| 模板方法 | `AggregateUnaryFunction<S,T,R>` | UnaryState trait 获得完整 AggregateFunction |
| 双层架构 | expression 定义 trait + functions 实现 | Evaluator 不依赖 functions crate |

## 模块间交互

`databend-common-functions` 依赖 `databend-common-expression`（Function/FunctionRegistry/AggregateFunction trait 均定义在 expression crate）。`Evaluator`（expression crate）执行 `Expr::FunctionCall` 时直接使用 `Function.eval`（已注册 trait object），无需知道 functions crate——解耦。部分标量函数已拆为独立 crate（`databend_functions_scalar_arithmetic`/`_decimal`/`_math`/`_geo`/`_datetime`），通过 `scalars/mod.rs` 的 `pub use` 引入。

## 扩展方式

**新增一个标量函数**：在 `scalars/` 对应子模块的 `register` 内用 Builder 链注册——`registry.scalar_builder("name").function().typed_1_arg::<I,O>().passthrough_nullable().calc_domain(fn).each_row(fn).register()`。无需修改 expression evaluator 或 FunctionRegistry。

**新增一个聚合函数**：在 `aggregates/` 新建文件定义状态 struct → 实现 `UnaryState` trait（简单路径）或直接实现 `AggregateFunction` trait → 导出 `xxx_function_desc()` → 在 `aggregator.rs` 的 `Aggregators::register` 调 `factory.register("name", desc())`。无需修改 `AggregateFunctionFactory`（除非需新 Combinator）。
