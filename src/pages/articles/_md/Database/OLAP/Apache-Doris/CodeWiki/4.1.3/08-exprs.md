---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "表达式与函数"
date: "2026-08-23T18:36:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "VExpr", "向量化", "SIMD", "CRTP"]
description: "Doris 表达式与函数：VExpr 表达式树 + IFunction 向量化批处理 + IAggregateFunction CRTP 去虚化。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

表达式与函数模块（`be/src/exprs/`，~11.7 万行）是 Doris BE 的表达式求值与函数库。它借鉴 ClickHouse 设计，以列式批处理（向量化）为核心——`VExpr` 表达式树、`IFunction` 标量向量化函数、`IAggregateFunction` 聚合函数。独立成文是因为函数库与求值机制自成体系——它回答"表达式怎么对一整列数据批量求值、函数怎么注册分发、NULL 怎么处理"。

## 模块架构

模块按职责分四层：顶层 `VExpr` 表达式树基类与具体节点（`VectorizedFnCall`/`VSlotRef`/`VLiteral`/`VCastExpr`）、`function/` 标量函数实现 + `SimpleFunctionFactory` 注册表、`aggregate/` 聚合函数实现 + `AggregateFunctionSimpleFactory`、`lambda_function/` 高阶函数、`table_function/` 表函数。

```
VExpr (表达式树基类, execute_column 纯虚)
  ├─ VectorizedFnCall (函数调用, 持 FunctionBasePtr _function)
  ├─ VSlotRef (列引用)
  ├─ VLiteral (字面量)
  └─ VCastExpr / VCaseExpr / VInPredicate / VMatchPredicate ...

IFunction (三合一: IPreparedFunction + IFunctionBase + PreparedFunctionImpl)
  └─ execute_impl (子类实现真正的列计算)

IAggregateFunction (聚合状态外部操作接口)
  └─ IAggregateFunctionDataHelper<Data, Derived> (placement new on Arena, CRTP 去虚化)
```

## 调用链路

标量表达式树对 Block 批量求值（`SELECT a + b*2`，树为 `VectorizedFnCall(plus, [VSlotRef(a), VectorizedFnCall(multiply, [VSlotRef(b), VLiteral(2)])])`）：

```
pipeline 算子 (OlapScanOperator/ProjectOperator)
  → VExprContext::execute(block, &result_column_id) (vexpr_context.h:254)
    → VExpr::execute → VectorizedFnCall::execute_column (vectorized_fn_call.cpp:303)
      → _do_execute (vectorized_fn_call.cpp:212)
        ├─ 常量缓存检查: is_const_and_have_executed → get_result_from_const
        ├─ 快速路径: fast_execute (索引/runtime filter)
        ├─ 递归执行子表达式: for each child → child->execute_column → temp_block.insert
        └─ 调用函数: _function->execute(fn_ctx, temp_block, args, result_idx, count)
             → IFunctionBase::execute (function.h:188)
               → prepare->execute → PreparedFunctionImpl::execute (function.cpp:249)
                 → default_execute → default_implementation_for_constants → default_implementation_for_nulls
                   → execute_impl  ← 子类实现真正计算
```

聚合函数 init/add/merge/finalize（`AggregationSinkOperator` 调）：

```
AggFnEvaluator::execute_single_add (vectorized_agg_fn.cpp:283)  // 无 GROUP BY
  ├─ _calc_argument_columns: _input_exprs_ctxs[i]->execute(block, &column_id)
  └─ _function->add_batch_single_place(batch_size, place, columns, arena)
       → IAggregateFunctionHelper<Derived>::add_batch (aggregate_function.h:398)  // CRTP 去虚化
         → for i: derived->add(place, columns, i, arena)
           → AggregateFunctionAvg::add (aggregate_function_avg.h:197)  // data(place).sum += ...
// 合并阶段
_function->merge(place, rhs, arena)  // data(place).sum += data(rhs).sum
// 输出
_function->insert_result_into(place, column)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `VExpr.create_tree_from_thrift` | 从 TExpr 构建表达式树 | 静态工厂 |
| `VExpr.execute_column` | 对 Block 批量求值 | 纯虚，返回 ColumnPtr |
| `VectorizedFnCall._do_execute` | 递归子表达式+调函数 | 常量缓存+快速路径 |
| `IFunction.execute_impl` | 真正列计算 | 子类实现，SIMD |
| `IFunctionBase.execute` | 函数执行入口 | 先处理常量/NULL 再 execute_impl |
| `IAggregateFunction.add_batch` | 批量聚合 | CRTP derived->add 去虚化 |
| `IAggregateFunction.merge` | 合并状态 | 两阶段聚合/分布式 |
| `SimpleFunctionFactory.get_function` | 查函数 | 函数名+类型键 |
| `AggFnEvaluator.execute_batch_add` | 有 GROUP BY 聚合 | places[i] 指向分组状态 |

</details>

## 核心实现

### VExpr 表达式树（解释器模式）

`VExpr`（`exprs/vexpr.h`）是纯虚基类，`_children` 构成递归结构。核心接口 `execute_column(VExprContext*, const Block*, Selector*, count, ColumnPtr&)` 对 Block 批量求值，结果 `ColumnPtr` 插入 Block 返回 `column_id`。另有 `execute_filter`（直接输出 uint8 filter 数组）、`evaluate_inverted_index`（倒排索引评估）。生命周期 `prepare → open → execute → close`。`create_tree_from_thrift` 从 FE 序列化的 `TExprNode` 静态构建整棵树。

### IFunction 三合一与向量化批处理

`IFunction`（`exprs/function/function.h`）同时继承 `IPreparedFunction`/`IFunctionBase`/`PreparedFunctionImpl` 三者，简化注册——子类只需实现 `execute_impl` 做真正列计算。`DefaultFunction` 包装器把 `IFunction` 包装为 `IFunctionBase`，`prepare` 时直接返回自身。

向量化批处理不是逐行调函数，而是以 `Block` 为单位一次性处理 `input_rows_count` 行。`FunctionMathUnary::execute_impl`（`function_math_unary.h:55`）直接操作 `ColumnFloat64` 裸指针数组 `src_data.data()`，循环可被编译器自动 SIMD 向量化。`BinaryArithmetic` 模板对整型/浮点/Decimal 特化，产生 `vector_vector`/`vector_constant`/`constant_vector`/`constant_constant` 四种路径。

### NULL 自动处理与常量优化

`use_default_implementation_for_nulls()`（`function.h:139`）默认 true：若任一参数 NULL 结果 NULL。实现是自动解包 `Nullable` 列→用嵌套列执行→用 `wrap_in_nullable`（`function.cpp:45`）重包装，NULL map = 所有参数 NULL map 的 OR。需自定义 NULL 处理的函数（如 `is_null`/`coalesce`）override 返回 false。

`use_default_implementation_for_constants()`（`function.h:120`）：若所有参数是 `ColumnConst`，函数只对单行求值再包装回 `ColumnConst(input_rows_count)`，避免重复计算 N 行。三层 default 逻辑（`function.cpp`）：`execute → default_execute → default_implementation_for_constants + default_implementation_for_nulls → execute_impl`，层层过滤后才调真正计算。

### IAggregateFunction 与 CRTP 去虚化

`IAggregateFunction`（`exprs/aggregate/aggregate_function.h`）定义聚合状态生命周期：`create`（placement new）/`destroy`/`add`/`add_batch`/`merge`/`serialize`/`deserialize`/`insert_result_into`。`AggregateDataPtr = char*`，聚合状态直接在 `Arena` 内存池上分配，避免每行堆分配——这是聚合性能关键。

`IAggregateFunctionHelper<Derived>`（`aggregate_function.h:314`）用 CRTP：`add_batch` 等批量方法在基类通过 `assert_cast<const Derived*>(this)->add()` 调用，当 `Derived` 标记 `final` 时编译器可去虚化（devirtualize），对热路径至关重要。约束 `static_assert(std::is_final_v<Derived> || ...)`。`IAggregateFunctionDataHelper<Data, Derived>` 自动管理 `Data` 的 create/destroy/size。`is_trivial()` 返回 true 的函数（如 sum/count/avg）可用 `memset(0)` 代替 `create()` 跳过构造函数。

### 函数注册表与 Combinator

`SimpleFunctionFactory`（`function/simple_function_factory.h:130`）用 `phmap::flat_hash_map<string, Creator>` 注册函数，单例 `instance()` 用 `call_once` 初始化所有函数。非 variadic 用函数名作 key，variadic（如 `array_map`）用 `函数名+参数类型 family name` 组合作 key。`AggregateFunctionSimpleFactory`（`aggregate/aggregate_function_simple_factory.h:56`）分 `nullable/非nullable` 两表，并提供 Combinator——`register_distinct_function_combinator` 自动为所有已注册函数生成 `multi_distinct_` 前缀版本，`register_foreach_function_combinator` 生成 `_foreach` 后缀版本。

`be_exec_version` 版本兼容（`simple_function_factory.h:258` `temporary_function_update`）：BE 升级时函数行为可能变更，通过 `BeExecVersionManager` 为旧版本注册带后缀别名，FE 按 `be_exec_version` 选正确版本，保证新旧 BE 混合部署兼容。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 解释器模式 | `VExpr` + `_children` | 表达式树递归求值 |
| 向量化批处理 | `IFunction::execute_impl` | 减少虚函数调用，SIMD 友好 |
| 工厂+注册表 | `SimpleFunctionFactory`/`AggregateFunctionSimpleFactory` | 函数创建与使用解耦 |
| State Pattern | 聚合状态 `AggregateDataPtr` on Arena | 状态外部操作，避免堆分配 |
| CRTP 去虚化 | `IAggregateFunctionHelper<Derived>` | 热路径去虚函数，final 类编译期优化 |
| Combinator | `register_distinct/foreach_combinator` | 自动生成变体函数 |

## 模块间交互

被 `exec`（pipeline 算子）调用：`OlapScanOperator` 调 `VExprContext::execute_filter` 谓词过滤、`ProjectOperator` 调 `execute` 计算投影列、`AggregationSinkOperator`（`exec/operator/aggregation_sink_operator.cpp:185`）调 `AggFnEvaluator::execute_single_add`/`execute_batch_add`、`HashJoinProbeOperator` 用 `VExprContextSPtrs probe_exprs_ctxs` 求值 join 键。与 `core` 关系：表达式求值输入输出都是 `Block`（`core/block/block.h`），函数通过 `block.get_by_position(arguments[i]).column` 取参数列、`block.get_by_position(result).column = ...` 写回，类型系统 `DataTypePtr` 贯穿全链路，FE 下推返回类型在 `FunctionBuilderImpl::build` 校验。与 `nereids` 交互：FE 把 SQL 表达式编译为 Thrift `TExprNode` 下推，`VExpr::create_tree_from_thrift` 构建 BE 表达式树，`TFunction` 含函数名/参数类型/返回类型/`binary_type`（BUILTIN/JAVA_UDF/PYTHON_UDF/RPC/AGG_STATE）。与 `storage`：`VExpr::evaluate_inverted_index` 谓词下推倒排索引，`evaluate_ann_range_search` 向量搜索，`can_push_down_to_index` 判断可否下推。

## 扩展方式

新增标量函数（如 `my_func(int, string) -> int`）：新建 `be/src/exprs/function/function_my_func.h` 实现 `IFunction` 子类（`static constexpr auto name`、`get_number_of_arguments`、`get_return_type_impl`、`execute_impl` 从 block 取参数列计算写回）；在对应类别文件 `factory.register_function<FunctionMyFunc>()`；在 `simple_function_factory.h` 声明 `register_function_my_func` 并在 `instance()` 的 `call_once` 调用；FE 侧 nereids 函数目录注册对应签名。

新增聚合函数（如 `my_agg(double) -> double`）：新建 `be/src/exprs/aggregate/aggregate_function_my_agg.h`——定义 `AggregateFunctionMyAggData`（`sum` 字段 + `write`/`read`）、`AggregateFunctionMyAgg final : IAggregateFunctionDataHelper<Data, Derived>, UnaryExpression, NullableAggregateFunction`（实现 `add`/`merge`/`serialize`/`deserialize`/`insert_result_into`）；新建 `.cpp` 调 `factory.register_function_both("my_agg", creator)`；在 `aggregate_function_simple_factory.cpp` 声明注册。

修改函数签名解析：BE 侧改 `get_return_type_impl`/`get_variadic_argument_types`，`simple_function_factory.h` 的 `get_function` 更新类型键逻辑；FE 侧 nereids `FunctionRegistry`/`ScalarFunction` 注册新签名；如改变已有函数行为经 `BeExecVersionManager` 注册版本兼容映射。
