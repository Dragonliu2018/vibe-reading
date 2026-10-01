---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "函数库与表达式求值"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 函数库解读：BuiltinFunctions 注册目录与 65 个标量函数族、CastTable 代价矩阵驱动的重载解析、16 个模板入口的向量化求值、聚合 char* 状态三件套"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/function/`（1.2 万行）+ `src/executor/expression/`（求值器）实现 SQL 函数的**注册、解析、求值**三件事。`BuiltinFunctions` 是注册目录（god node：`RegisterScalarFunction` degree 65），函数按「名字 + 参数 LogicalType 签名」注册成重载集合；查询期 binder 走代价最小的重载解析；执行期经模板单态化的函数指针一次处理整列。

值得先澄清一个容易误判的点：v0.7.3 的 function 模块**没有**按 CPU 能力（AVX2/AVX-512）选择的函数指针表（全模块 grep 无 `__AVX/_mm256` 命中）。向量化靠三件事：(a) 模板单态化后编译器自动向量化紧凑 for 循环（`__restrict` 指针）；(b) `kConstant`/`kCompactBit` 存储格式特化分支；(c) REGEX/LIKE 常量模式的批量路径。SIMD 能力探测（`common/simd`）服务的是 HNSW/DiskANN 等索引侧的距离函数，不是标量函数。

---

## 模块架构

```text
src/function/
├── builtin_functions.cppm/_impl   BuiltinFunctions：注册目录（Init → 65 个 RegisterXxx）
├── function.cppm                  Function 基类 + FunctionType 枚举
├── function_set.cppm/_impl        FunctionSet：同名函数的重载集合
├── scalar_function.cppm           ScalarFunction + 16 个模板入口 + Wrapper 族（673 行，模块核心）
├── scalar_function_set.cppm/_impl 重载解析（GetMostMatchFunction）
├── aggregate_function.cppm        AggregateFunction + UnaryAggregate 工厂
├── aggregate_function_set.cppm/_impl
├── cast/                          cast_table（代价矩阵）+ cast_function（双 switch 绑定）
├── scalar/                         按功能分组的标量函数实现（abs/like/regexp/...）
├── aggregate/                      聚合 state 实现（sum/max/min/count/avg/first）
├── table/                          表函数（v0.7.3 为空实现）
└── special_function.cppm           SpecialFunction：ROW_ID/DISTANCE/SCORE 等 11 个内部函数
src/executor/expression/
├── expression_evaluator.cppm/_impl  表达式树解释器（按 ExpressionType switch）
├── expression_state.cppm/_impl      与表达式树同构的 state 树
└── expression_selector.cppm/_impl   WHERE 条件向量化选择
```

类层次的骨架：

```cpp
// Function → FunctionSet → 具体函数
export class Function {                        // function.cppm
    std::string name_;  FunctionType type_;   // kScalar/kAggregate/kTable/kSpecial
};
export class FunctionSet {                     // 同名函数的重载集合
    static std::shared_ptr<FunctionSet> GetFunctionSet(NewCatalog*, const FunctionExpr&);
};
export class ScalarFunction final : public Function {   // scalar_function.cppm
    std::vector<DataType> parameter_types_{}; // 参数签名（重载 key）
    DataType return_type_;
    ScalarFunctionTypePtr function_{};        // 整列进出的函数指针
};
```

---

## 调用链路

### 函数注册链（进程启动一次）

```text
Storage::NewCatalog (storage_impl.cpp:336)
  └─ BuiltinFunctions builtin_functions(new_catalog_.get()); builtin_functions.Init();
       └─ Init() (builtin_functions_impl.cpp:98)
            ├─ RegisterAggregateFunction() → Avg/Count/First/Max/Min/Sum
            ├─ RegisterScalarFunction()   → 65 个 RegisterXxxFunction
            ├─ RegisterTableFunction()    → 空
            └─ RegisterSpecialFunction()  → 11 个 AddSpecialFunction（ROW_ID/DISTANCE/SCORE/...）
每个 RegisterXxxFunction（以 abs_impl.cpp:49 为例）：
  1. make_shared<ScalarFunctionSet>("ABS")
  2. 逐个重载：ScalarFunction("ABS", {DataType(kTinyInt)}, DataType(kTinyInt),
        &ScalarFunction::UnaryFunctionWithFailure<TinyIntT, TinyIntT, AbsFunctionInt>) → AddFunction()
  3. NewCatalog::AddFunctionSet(catalog, function_set)   // name ToLower 入 catalog
```

函数目录就挂在 `NewCatalog` 上（`function_sets_` hash map），与表/索引同住一个 catalog——函数也是一等目录对象。

### 函数解析链（binder 阶段，每查询）

```text
Parser 产出 FunctionExpr（函数名 + 参数）
  └─ ExpressionBinder::BuildFuncExpr (expression_binder_impl.cpp:526)
       ├─ NewCatalog::GetFunctionSetByName(catalog, func_name)
       ├─ ScalarFunctionSet::GetMostMatchFunction(arguments)      scalar_function_set_impl.cpp:35
       │    对每个重载算 MatchFunctionCost：参数个数必须相等；
       │    每参数查 CastTable::GetCastCost(arg, param)，<0（不可转）淘汰，否则累加
       │    取最低 cost；0 候选报 FunctionNotFound，多候选报 MultipleFunctionMatched
       └─ 参数类型不等 → CastExpression::AddCastToType() 自动插 Cast 节点
```

### 求值链（executor 阶段，逐 DataBlock）

```text
PhysicalProject::Execute (physical_project_impl.cpp:60)
  ├─ expr_states[i] = ExpressionState::CreateState(expressions_[i])   // 递归建 state 树
  ├─ ExpressionEvaluator evaluator; evaluator.Init(input_data_block);
  └─ evaluator.Execute(expr, state, output_block->column_vectors_[i])
       switch (expr->type()):                                    expression_evaluator_impl.cpp:49
         kFunction → 逐参数递归 Execute(child_expr, child_state, child_state->OutputColumnVector())
                     组装 DataBlock → expr->func_.function_(input, output)   ← 一次处理整列
         kCast     → Execute(child) 后调 BoundCastFunc
         kAggregate → 按 agg_flag_ 状态机 init/update/finalize
         kValue    → 常量列广播
         kReference → output = input_data_block_->column_vectors_[idx]（零拷贝引用）

ScalarFunction::UnaryFunction 等模板入口 (scalar_function.cppm:350)
  └─ UnaryOperator::Execute<Input,Output,Wrapper> (unary_operator.cppm:33)
       switch (input->vector_type()):
         kConstant   → 只算 index 0，Finalize 广播（短路优化）
         kFlat       → for(i<count) Operator::Execute(in[i], out[i])   ← 紧凑循环
         kCompactBit → 按 u8 整字节处理布尔位图
         含 NULL    → Bitmask::RoaringBitmapApplyFunc 只遍历有效行
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `BuiltinFunctions::Init` | `builtin_functions_impl.cpp:98` | 注册链总入口 |
| `ScalarFunctionSet::GetMostMatchFunction` | `scalar_function_set_impl.cpp:35` | 最小代价重载解析 |
| `AggregateFunctionSet::GetMostMatchFunction` | `aggregate_function_set_impl.cpp:32` | 聚合版（单参数，排除 JSON） |
| `CastFunction::GetBoundFunc` | `cast_function_impl.cpp:39` | 双 switch 绑定特化函数 |
| `ExpressionEvaluator::Execute` | `expression_evaluator_impl.cpp:49` | 表达式树解释器 |
| `ExpressionState::CreateState` | `expression_state_impl.cpp:158` | state 树构建 + kConstant 推断 |
| `ExpressionSelector::Select` | `expression_selector_impl.cpp:36` | WHERE 过滤选择 |
| `UnaryOperator::Execute` | `unary_operator.cppm:33` | 最内层向量化循环 |

</details>

---

## 核心实现

### 重载解析 = CastTable 代价最小化

不用 C++ 模板推导，而是每个函数名注册多个「参数 LogicalType 签名」，运行时按代价打分选最优。代价矩阵 `CastTable`（`cast/cast_table.cppm:24`）是 ~40×40 的 `std::array` 二维矩阵 + Singleton，数值提升链体现为 tinyint→smallint=1 →…→ double=10，到 varchar ≈ 102~112（cast 代价远大于数值提升）。这让 `ABS(tinyint)`、`ABS(double)`、`1 + '2'` 各自解析到唯一实现，并在 binder 里自动包 `CastExpression`。Embedding/Tensor 是参数化类型，代价函数单独走 `EmbeddingInfo` 精确匹配（维度+元素类型），仅 FDE 函数允许维度差异（`scalar_function_set_impl.cpp:102-134`）。

### cast 双层结构

`CastTable` 只管「能不能转 + 代价多少」（服务重载解析，O(1) 数组读）；真正执行时 `CastFunction::GetBoundFunc` 按**源类型 switch → `BindXxxCast<SourceType>` → 目标类型**两级 switch 返回 `ColumnVectorCast::TryCastColumnVector<S,T,TryOp>` 特化函数指针。分离解析期查询与执行期绑定，避免 1600 个组合全量实例化。

### 模板入口族：16 个正交组合

`ScalarFunction` 的入口不是万能一个，而是按「元数 × varlen 语义 × 失败语义」正交组合出 ~16 个 static 模板入口（`scalar_function.cppm:333-671`）：`UnaryFunction`（定长无失败）、`UnaryFunctionWithFailure`（溢出等失败 → Try wrapper 置 NULL）、`BinaryFunctionWithBatch`（REGEX 常量模式批量优化）、`*ToVarlen`（返回 Varchar，需要结果列的 `ColumnVector*` 分配堆上 buffer）。这是把「函数签名形状」固化到类型系统的做法——每个 (类型签名×运算) 实例化一个模板函数，取函数指针存入 `ScalarFunction::function_`，运行时零虚调用。

Null 语义由 Wrapper 统一处理：`*TryOpWrapper` 在运算返回 false 时 `nulls_ptr->SetFalse(idx)` + 写 `NullValue<T>()`，单个函数实现无需感知 NULL。

### 聚合：裸 char* 状态三件套

```cpp
using AggregateInitializeFuncType = std::function<void(char *)>;              // state 是裸内存
using AggregateUpdateFuncType   = std::function<void(char *, const ColumnVector&)>;
using AggregateFinalizeFuncType = std::function<char *(char *)>;
```

聚合状态是裸 `char*` + init/update/finalize 三件套（`aggregate_function.cppm:32-34`），state 内存由上层（fragment_context 预分配的 `states_`、hash aggregate 的 group 数据）分配，`ExpressionEvaluator` 只借指针。为什么：分组聚合需要 state 与组生命周期绑定、可序列化到连续内存，且 `Finalize()` 返回 `char*` 避免 varlen 结果拷贝。`UnaryAggregate<AggregateState, InputType, ResultType>` 工厂把协议打包；`StateUpdate` 按 `ColumnVectorType`（kCompactBit/kFlat/kConstant）三分支循环，用 `if constexpr (requires { AggregateState::need_column_vector_; })` 给 Varchar 聚合传回 `ColumnVector*` 解引用 varlen 数据。

### ExpressionState：与表达式树同构的求值缓存

`ExpressionState`（`expression_state.cppm`）与表达式树镜像递归（`AddChild`），每个节点预分配 `DEFAULT_VECTOR_SIZE` 的输出列。三个收益：(a) 逐 DataBlock 重复求值同一表达式树时避免反复 malloc/free；(b) **kConstant 推断**——`CreateState(FunctionExpression)` 检查全部子 state 是否 kConstant，从而把输出列也初始化为 kConstant（常量折叠沿树下推，`NULL AND NULL` 只需算 1 行）；(c) 聚合把 `agg_state_` 与 `agg_flag_` 状态机（kUninitialized→kRunning→kFinish）挂在 state 上，使同一表达式树能跨多个 DataBlock 流式累计。

`ExpressionSelector`（WHERE 专用）求值条件得 bool 列后，用 Roaring bitmap 遍历有效行，true 的行号 Append 进 `Selection`，再按行号压缩输出块——`output_data_block->Init(input_data_block, output_true_select)`。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 函数注册表 | `BuiltinFunctions` → `NewCatalog::function_sets_` | 查询期 O(1) 按名查 |
| 重载解析（运行时模拟 C++ 重载决议） | `GetMostMatchFunction` 最小代价 | SQL 动态类型的必然 |
| 策略/模板分发（编译期单态化） | 每签名实例化模板、存函数指针 | 热路径零虚调用 |
| Wrapper 适配器族 | `UnaryOpDirectWrapper/UnaryTryOpWrapper/...` | 统一 NULL/varlen 语义 |
| State 策略（聚合） | `AggregateState` 实现 Initialize/Update/Finalize/Size 协议 | state 可放连续内存 |
| 表驱动 | `CastTable` 二维矩阵 | O(1) 代价查询 |
| Interpreter | `ExpressionEvaluator` 按 ExpressionType switch 递归 | 表达式树求值的经典形态 |
| Null Object/常量折叠 | kConstant 列只算 0 号位 | 常量传播免整列计算 |

---

## 模块间交互

- **parser → binder**：`FunctionExpr`（函数名 + 参数）经 catalog 查 FunctionSet；`BetweenExpr` 被 binder 重写为 `>` + `<` + `and` 三个 FunctionExpression。
- **binder → executor**：绑定好的表达式树进入算子。消费者（grep 实证）：PhysicalProject/Filter/Aggregate/HashAggregate/MergeHashAggregate/Top/Update/Insert/KnnScan/MatchSparseScan——Filter 用 `ExpressionSelector`，其余用 `ExpressionEvaluator`。
- **catalog**：`NewCatalog` 是函数注册表宿主；SpecialFunction（11 个）由 binder 单独走 `GetSpecialFunctionByNameNoExcept` 解析，用于 KNN/全文等内部表达式（`_row_id`/`_score` 列）。
- **storage/column_vector**：`UnaryOperator/BinaryOperator/TernaryOperator`（`storage/column_vector/operator/`）与 `ColumnVectorCast` 是列数据的最内层循环，被本模块复用——函数模板最终落在 ColumnVector 的裸指针上。

---

## 扩展方式

**新增一个标量函数**（如 `MY_FUNC(a)`）：`function/scalar/my_func.cppm`（声明）+ `my_func_impl.cpp`（运算 struct + 注册函数）→ `builtin_functions_impl.cpp` 顶部 import + `RegisterScalarFunction()` 加一行 → 可选在 `cast/cast_table_impl.cpp` 补矩阵条目 → 测试参照 `src/unit_test/function/scalar/*_ut.cpp`。**无需改 planner/executor**——binder 经 catalog 通用路径解析，executor 经 FunctionExpression 通用路径求值。

**新增一个聚合函数**：`aggregate/my_agg.cppm/_impl.cpp` 定义 state（协议：`Initialize()/Update(...)/ConstantUpdate()/Finalize()/static Size()`，参照 `SumState`；varlen 参与比较时加 `static constexpr bool need_column_vector_ = true;`）→ `RegisterMyAggFunction` 用 `UnaryAggregate<MyState<X,Y>, XT, YT>` 工厂 → `RegisterAggregateFunction()` 加一行。空输入语义（非 COUNT 置 NULL）在 `ExpressionEvaluator::AppendAggregateResult` 统一处理，新函数无需自己处理。
