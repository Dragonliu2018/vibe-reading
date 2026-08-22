---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Function"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Function", "ScalarFunction", "AggregateFunction", "Cast"]
description: "DuckDB Function 模块——Scalar/Aggregate/Table/Pragma 函数注册，function pointer 策略模式 + 重载代价选择。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Function 模块负责所有 SQL 函数的注册、查找和执行调度——标量函数（`ScalarFunction`）、聚合函数（`AggregateFunction`）、表函数（`TableFunction`）、Pragma 函数（`PragmaFunction`）、Cast 规则（`CastFunctionSet`）和用户宏（`MacroFunction`）。DuckDB 的函数系统核心设计是用 **function pointer 而非虚函数**——这让编译器更好内联优化，特别是 `UnaryExecutor`/`BinaryExecutor` 模板展开后的循环。

## 模块架构

继承层次：`Function` → `SimpleFunction`（增加参数类型列表）→ `SimpleNamedParameterFunction` / `BaseScalarFunction`（增加 return_type/stability/null_handling）→ `ScalarFunction` / `AggregateFunction`。`TableFunction` 和 `PragmaFunction` 继承自 `SimpleNamedParameterFunction`。

`FunctionSet<T>` 模板类管理同名函数重载集合——`ScalarFunctionSet`/`AggregateFunctionSet`/`TableFunctionSet`/`PragmaFunctionSet`。`FunctionBinder` 负责函数重载选择——按 cast 代价累加选总代价最低的重载。`CastFunctionSet` 管理类型转换函数，`CastRules::ImplicitCast` 返回转换代价（-1 表示不可转换）。

内置函数注册表是 `function_list.cpp` 中的 `StaticFunctionDefinition function[]` 静态数组（由 `scripts/generate_functions.py` 生成），通过 `RegisterFunctionList` 模板方法遍历注册到 catalog。

## 调用链路

### 函数注册到 Catalog

```
DuckCatalog::Initialize()
  ├→ BuiltinFunctions::Initialize()                   [function.cpp:95]
  │   ├→ RegisterTableScanFunctions()  — read_csv, table_scan, range...
  │   ├→ RegisterPragmaFunctions()
  │   ├→ RegisterCopyFunctions()
  │   └→ AddCollation("nocase", ...)
  └→ FunctionList::RegisterFunctions(*this, data)
       └→ 遍历 function_list.cpp 的 function[] 数组
            对每个 StaticFunctionDefinition:
            ├→ get_function() → ScalarFunction → ScalarFunctionSet → CreateScalarFunctionInfo
            │   → catalog.CreateFunction()
            └→ get_aggregate_function() → AggregateFunction → AggregateFunctionSet
                → CreateAggregateFunctionInfo → catalog.CreateFunction()
```

### Planner 通过 FunctionBinder 绑定函数

```
ExpressionBinder::BindFunctionExpression()             — planner 层
  → FunctionBinder::BindScalarFunction(schema, name, children, error, ...)  [function_binder.cpp:311]
       ├→ Catalog::GetSystemCatalog(context).GetEntry<ScalarFunctionCatalogEntry>(...)
       ├→ BindFunction(func.name, func.functions, children, error)  [:219]
       │    └→ BindFunctionsFromArguments<ScalarFunction>()  [:83]
       │         遍历 FunctionSet 中所有重载
       │         对每个调用 BindFunctionCost() 累加 cast 代价
       │         ├→ CastFunctionSet::ImplicitCastCost(context, arg_type, func_arg_type)
       │         │    └→ CastRules::ImplicitCast(from, to)  — 代价矩阵查表
       │         └→ 选择代价最低的重载（多个相同 → 报歧义错误）
       └→ BindScalarFunction(bound_function, children, ...)  [:645]
            ├→ ResolveTemplateTypes()  — 推断 TEMPLATE 类型参数
            ├→ [有 bind callback] → bound_function.GetBindCallback()(context, bound_function, children)
            ├→ CastToFunctionArguments()  — 添加隐式 cast
            └→ 创建 BoundFunctionExpression(return_type, bound_function, children, bind_info)
```

### Execution 调用 ScalarFunction

```
ExpressionExecutor::Execute(BoundFunctionExpression &expr, state, sel, count, result)  [execute_function.cpp:176]
  ├→ 对每个子表达式 Execute(*expr.children[i], ...) → 填充 arguments (DataChunk)
  ├→ TryExecuteDictionaryExpression()  — 字典编码优化
  │    若命中 → expr.function.GetFunctionCallback()(input_chunk, state, output_intermediate)
  └→ expr.function.GetFunctionCallback()(arguments, *state, result)
       — 即 scalar_function_t function(DataChunk&, ExpressionState&, Vector&)
       — 直接调用 function pointer，无虚函数分派
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `BuiltinFunctions::Initialize` | 注册所有内置函数 | 分类别注册（TableScan/Pragma/Copy...） |
| `FunctionBinder::BindScalarFunction` | 查找+绑定标量函数 | 按 cast 代价选最优重载 |
| `BindFunctionsFromArguments` | 重载选择 | 代价累加，多候选报歧义 |
| `CastRules::ImplicitCast` | 隐式转换代价 | 直接代价矩阵查表，非图遍历 |
| `ScalarFunction::UnaryFunction<TA,TR,OP>` | 模板工厂 | 委托给 UnaryExecutor::Execute |
| `AggregateFunction::UnaryAggregate<STATE,INPUT,RESULT,OP>` | 聚合模板工厂 | 自动生成 5 个 function pointer |

</details>

## 核心实现

### function pointer 而非虚函数

`scalar_function_t` 定义为 `std::function<void(DataChunk&, ExpressionState&, Vector&)>`（`scalar_function.hpp:98`）。一次处理一整个 chunk（2048 行），函数内部循环处理上千行。虚函数的间接调用开销在单次调用中可忽略，但 function pointer 让编译器更好内联优化——特别是 `UnaryExecutor`/`BinaryExecutor` 的模板展开后，标量操作 `OP::Operation(left, right)` 可能被内联到循环中。不在热路径上的对象（如 `FunctionData` 的 `Copy()`/`Equals()`）仍使用虚函数。

### ScalarFunction 的向量化签名

`void(DataChunk &input, ExpressionState &state, Vector &result)`——输入是 `DataChunk`（多列 Vector），输出是单个 `Vector`。一次处理 2048 行，调用开销摊薄到可忽略。模板工厂 `UnaryFunction<TA,TR,OP>` 委托给 `UnaryExecutor::Execute<TA,TR,OP>(input.data[0], result, input.size())`，内部循环展开向量化处理。

### AggregateFunction 的 5 个 function pointer

聚合 state 是**裸内存块**（`data_ptr_t`），由 5 个 function pointer 管理：`state_size`（返回 state 字节数）、`initialize`（初始化 state）、`update`（更新 state）、`combine`（合并两个 state）、`finalize`（输出结果）。state 直接存在 `RadixPartitionedHashTable` 的聚合槽位中，连续排列，cache 友好。`update` 签名 `void(Vector inputs[], AggregateInputData&, idx_t input_count, Vector &state, idx_t count)` 一次更新多个 state（分组聚合中每个分组一个 state）。`combine` 支持并行——将多线程的 state 合并，向量化处理。

模板工厂 `UnaryAggregate<STATE,INPUT_TYPE,RESULT_TYPE,OP>` 自动生成 5 个 function pointer：`StateSize<STATE>()` 返回 `sizeof(STATE)`，`StateInitialize<STATE,OP>()` 调用 `OP::Initialize(*reinterpret_cast<STATE*>(state))`——注册时获得类型安全，运行时是裸内存操作。

### Cast 规则的代价矩阵

`CastRules::ImplicitCast(from, to)` 不是图遍历找最短路径，而是**直接的代价矩阵查表**。按 source type 的 switch 分派到 `ImplicitCastTinyint(to)` 等函数，每个内部再 switch target type 返回 `TargetTypeCost(to)`。代价设计：数值类型按宽度递增（BIGINT=101 < INTEGER=102 < HUGEINT=103 < DOUBLE=104 < DECIMAL=105），VARCHAR 代价高（149），TEMPLATE 代价极高（1000000）。DuckDB 的隐式 cast 只支持直接转换，不组合多步——若需从 INT → VARCHAR → DATE，用户需显式写 CAST。

### TEMPLATE 类型推断

v1.5 引入 `LogicalTypeId::TEMPLATE`，允许函数声明泛型参数（如 `LIST($T)` 中的 `$T`）。`ResolveTemplateTypes`（`function_binder.cpp:437-643`）从实际参数推断 `$T` 的具体类型并传播到返回类型。之前用 `ANY` 类型处理泛型会丢失类型信息——`TEMPLATE` 保留了类型关系。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略模式（function pointer） | `ScalarFunction::function` in `scalar_function.hpp:98` | 便于编译器内联，向量化热路径 |
| 模板工厂 | `UnaryFunction`/`UnaryAggregate` in `scalar_function.hpp:234` | 自动生成 function pointer，类型安全 |
| 注册表 | `FunctionSet<T>` + `function_list.cpp` | 管理同名重载，静态注册表 |
| 代价矩阵 | `CastRules::ImplicitCast` in `cast_rules.cpp:357` | O(1) 查表选最优重载 |
| 扩展点 | `BindExtensionFunction` in `built_in_functions.cpp:99` | 占位符函数自动触发扩展加载 |

## 模块间交互

Function 被 Planner 的 `ExpressionBinder` 通过 `FunctionBinder::BindScalarFunction` 查找和绑定——依赖 Catalog 查找 `ScalarFunctionCatalogEntry`，依赖 `CastFunctionSet`/`CastRules` 计算重载选择代价。绑定结果为 `BoundFunctionExpression`（内含 `ScalarFunction` 对象和 `FunctionData`）。Execution 的 `ExpressionExecutor::Execute(BoundFunctionExpression&)` 直接调用 `expr.function.GetFunctionCallback()`——无虚函数分派。聚合函数的 5 个回调被 `PhysicalUngroupedAggregate` 和 `RadixPartitionedHashTable` 调用。扩展通过 `ExtensionLoader::RegisterFunction` 向 catalog 注册新函数。

## 扩展方式

新增一个标量函数（如 `my_func(VARCHAR) → INTEGER`）：定义 `struct MyFuncFun` 含 `static ScalarFunction GetFunction()` → 实现 `scalar_function_t` 或用模板 `ScalarFunction::UnaryFunction<TA,TR,OP>` → 在 `function_list.cpp` 添加 `DUCKDB_SCALAR_FUNCTION(MyFuncFun)` → 更新 CMakeLists。函数 struct 参考 `LowerFun`（`src/function/scalar/string/caseconvert.cpp`）。

新增一个聚合函数：定义 state struct（如 `struct MyAggState { double sum; idx_t count; };`）→ 定义 operator struct（含 `Initialize`/`Update`/`Combine`/`Finalize` 静态方法）→ 用 `AggregateFunction::UnaryAggregate<MyAggState, double, double, MyAggBind>()` 构造 → 在 `function_list.cpp` 添加 `DUCKDB_AGGREGATE_FUNCTION_SET(MyAggFun)`。
