---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "计算内核"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "Compute", "向量化"]
description: "Arrow 计算内核——Function/Kernel 分离调度、Expression AST 的 Bind/Execute 分离、SIMD 多版本分桶与四种 Null 处理策略"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

`cpp/src/arrow/compute/`（~131k 行）是 Arrow 的**运算层**：它定义"对一列或几列做什么运算"的统一框架——`Function`（逻辑函数如 `add`/`filter`/`sum`）、`Kernel`（该函数针对特定类型的实现）、`Expression`（可组合、可序列化的表达式 AST）。所有向量化运算（算术、比较、字符串、聚合）都注册在这里，由统一的 dispatch 机制按类型选 kernel、按 SIMD 级别选最优实现。Acero 执行引擎和 Dataset 的谓词下推都建立在这套框架上。

## 模块架构

```
┌─────────────────────── 用户入口 ───────────────────────┐
│  CallFunction(name, args)     ExecuteScalarExpression  │  exec.h / expression.h
└──────────────────────────┬────────────────────────────-┘
                           │ 查找
┌──────────────────────────▼────────────────────────────-┐
│  FunctionRegistry (registry.h)   name→Function 全局单例 │  首次访问惰性构建
│    └─ ScalarFunction / VectorFunction /                │
│       ScalarAggregateFunction / HashAggregateFunction  │  function.h:297-405
│           └─ 持有 vector<Kernel>                        │
└──────────────────────────┬────────────────────────────-┘
                           │ DispatchExact/DispatchBest
┌──────────────────────────▼────────────────────────────-┐
│  Kernel (kernel.h)    signature + exec 函数指针        │
│    ├─ ScalarKernel        exec + null_handling          │
│    ├─ VectorKernel        exec + finalize + chunked     │
│    ├─ ScalarAggregateKernel  consume/merge/finalize    │
│    └─ HashAggregateKernel    + resize                   │
└──────────────────────────┬────────────────────────────-┘
                           │ 选 executor
┌──────────────────────────▼────────────────────────────-┐
│  KernelExecutor (exec.cc)   ScalarExecutor/Vector/Agg  │
│    ├─ Init (建 KernelState)  ├─ Execute(ExecSpan)      │
│    └─ NullPropagator (按策略处理 validity bitmap)     │
└─────────────────────────────────────────────────────────-┘

┌──────────────── Expression AST (expression.h) ─────────┐
│  Expression = variant<Datum, Parameter(field_ref), Call>│
│    Bind() → 查 Function+选 Kernel+插隐式 cast → 缓存     │  expression.cc:539
│    ExecuteScalarExpression → 复用已绑定的 kernel 执行    │  expression.cc:722
│    Serialize/Deserialize → 经 IPC 编码为 RecordBatch    │  expression.cc:1504
└─────────────────────────────────────────────────────────-┘
```

## 调用链路

一次 `CallFunction("add", {arg1, arg2})` 的 dispatch 全流程（`exec.cc:1362`）：

```
CallFunction("add", args, opts, ctx)
  └─ ctx->func_registry()->GetFunction("add")      registry.cc:88   查 map
  └─ func->Execute(args, opts, ctx)                function.cc:348
       └─ GetBestExecutor(inputs)                   function.cc:316
            ├─ DispatchBest → DispatchExact          function.cc:298
            │    └─ 遍历 kernels_，signature->MatchesInputs  function.cc:159
            │    └─ 按 SimdLevel 分桶：AVX512 > AVX2 > NONE
            └─ new ScalarExecutor(kernel)
       └─ executor->Init(opts, ctx)                建 KernelState
       └─ executor->Execute(ExecBatch(args,len), &listener)   exec.cc:783
            ├─ span_iterator_.Init    处理 ChunkedArray 分块
            ├─ SetupPreallocation     按 null/mem_allocation 预分配
            └─ ExecuteSpans → ExecuteSingleSpan    exec.cc:880
                 ├─ PropagateNullsSpans (INTERSECTION 默认，框架求 bitmap 交)
                 └─ kernel->exec(kernel_ctx, input, out)  ← 实际函数指针
       └─ WrapResults → 多 chunk 出 ChunkedArray，单 chunk 出 Array
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `CallFunction` (`exec.cc:1362`) | 按名查函数并执行 | 顶层便捷入口 |
| `Function::DispatchExact` (`function.cc:298`) | 精确类型匹配 kernel | 遍历 kernels_ 做签名匹配 |
| `GetBestExecutor` (`function.cc:316`) | 选 executor 并按 SIMD 选 kernel | 运行时 CPU 特性检测 |
| `ScalarExecutor::Execute` (`exec.cc:783`) | 逐 span 执行 kernel | 支持 ChunkedArray 与预分配 |
| `Expression::Bind` (`expression.cc:539`) | 编译期查 Function+选 Kernel+插 cast | 缓存到 `Call::kernel`，执行期零 dispatch |
| `ExecuteScalarExpression` (`expression.cc:722`) | 递归求值 AST | 子参数递归求值后调 executor |
| `Expression::Serialize` (`expression.cc:1504`) | AST→字节流 | 复用 IPC 编码为 RecordBatch |
</details>

## 核心实现

### Function 与 Kernel 的分离

`Function`（`function.h:142`）是逻辑函数（如 `"add"`），管命名、`Arity`、`FunctionDoc`，持有多个 `Kernel`；`Kernel`（`kernel.h:510`）是某函数针对特定参数类型的实现，持 `KernelSignature` 与 `exec` 函数指针。**为什么分离**：一个逻辑操作要支持十几种类型组合（int8+int8、float+float、timestamp+duration、decimal+decimal…），单一类需巨大 switch/case。分离后新增类型只需 `AddKernel`，且 `SimdLevel`（`kernel.h` 的 `simd_level`）让同一签名可有多个不同 SIMD 级别的 kernel，运行时 `DispatchExact` 优先选 AVX512>AVX2>NONE（`function.cc:159`）。`Function::Kind` 枚举（SCALAR/VECTOR/SCALAR_AGGREGATE/HASH_AGGREGATE/META）对应五种子类（`function.h:297-405`），每个绑定一种 Kernel 类型，如 `ScalarAggregateKernel` 暴露四阶段 `consume`/`merge`/`finalize`（`kernel.h:680`）。

### Expression AST 与 Bind/Execute 分离

`Expression`（`expression.h:45`）是三选一 variant：`literal(Datum)` / `field_ref(Parameter)` / `call(function_name, args, options)`。`Call` 节点在 `Bind()` 后缓存 `function`/`kernel`/`kernel_state`/`type`。**为什么是 AST + 可序列化**：表达式需组合（`add(mul(a,b), c)`）、分析（`FieldsInExpression` 提引用字段）、变换（`Canonicalize`/`FoldConstants`/`SimplifyWithGuarantee`），AST 让这些可递归处理；可序列化让 Acero 查询计划能跨进程/网络传输（Substrait 集成、分布式执行），Arrow 选择复用 IPC——把 AST 编码为 RecordBatch 的 schema metadata + 列数据（`expression.cc:1504`），避免另定义格式。**Bind/Execute 分离**是关键性能设计：`Bind()`（`expression.cc:539`）在查询计划编译期完成 Function 查找、Kernel 匹配、隐式 cast 插入、KernelState 初始化，执行期 `ExecuteScalarExpression` 直接用已绑定的 kernel，批量执行同表达式零 dispatch 开销。

### Null 处理策略

`NullHandling` 枚举（`kernel.h:437`）定义四种策略，`NullPropagator`（`exec.cc:527`）按策略处理 validity bitmap：

- **INTERSECTION**（ScalarKernel 默认）：对输入 validity bitmap 求交，输出 valid 当且仅当所有输入都 valid。框架自动完成（`PropagateNullsSpans`），kernel exec 无需管 null。优化：全无 null 时 elide bitmap。
- **COMPUTED_PREALLOCATE**：框架预分配 bitmap，kernel 自填。
- **COMPUTED_NO_PREALLOCATE**（VectorKernel 默认）：kernel 全自理。
- **OUTPUT_NOT_NULL**：输出永非 null，不分配 bitmap。

`NullPropagator` 还做短路（任一输入全 null scalar 立即返回全 null）、单数组零拷贝 bitmap、多数组 `BitmapAnd` 批量求交。**为什么默认 INTERSECTION**：多数标量运算的 null 语义就是"任一输入 null 则输出 null"，让框架统一处理可让 kernel 只关注数值逻辑，且 SIMD 友好。

### 模板批量生成 kernel

算术 kernel 不用宏展开，而用 C++ 模板 + `switch(Type::type)`（`kernels/scalar_arithmetic.cc:525`）：用 functor（`struct Add { static T Call(T a,T b){...} }`）封装运算，`ScalarBinaryEqualTypes<ArrowType,Op>::Exec` 模板生成具体 exec，`MakeArithmeticFunction<Add>("add",doc)`（`scalar_arithmetic.cc:888`）一次循环注册所有数值类型 kernel。**为什么用模板**：算术算法对类型无关，手写每种类型会产生数百个几乎相同的函数；模板让逻辑写一次，类型靠 `NumericTypes()` 循环覆盖。对 SIMD 不直接生成指令，但通过 `SimdLevel` 分桶让手写 SIMD kernel 可选叠加。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Registry | `FunctionRegistry`（`registry.cc`，`unordered_map`+父子链） | 函数可扩展，内置集惰性构建 |
| Strategy | `KernelExecutorImpl<KernelType>`→`ScalarExecutor`/`VectorExecutor`/`ScalarAggExecutor`（`exec.cc:711`） | 不同 FunctionKind 不同执行策略 |
| Visitor | `ExecuteScalarExpression` 递归遍历 AST（`expression.cc:722`）；`ModifyExpression` 双 Visitor 做 AST 变换 | 表达式组合/分析/变换的基础 |
| Template 特化 | `GenerateArithmeticFloatingPoint`+`MakeArithmeticFunction`（`scalar_arithmetic.cc:525/888`） | 批量生成类型特化 kernel，避免重复 |
| PIMPL | `FunctionRegistryImpl`（`registry.cc:36`） | 头文件不暴露标准库容器 |

## 模块间交互

依赖**核心类型**（`Datum`/`DataType`/`ArrayData`/`ArraySpan`/`MemoryPool`，通过 `ExecContext` 传入）。被 **Acero** 在 filter/project/aggregate 节点大量调用 `CallFunction`/`ExecuteScalarExpression`（`map_node.cc`、`aggregate_node.cc`）；被 **Dataset** 做 predicate pushdown（`SimplifyWithGuarantee` 简化 filter）；被 **IPC** 序列化 Expression（`expression.cc:1504`）。Cython Python 绑定直接用这些 C++ 类（`function.h:64` 注释提及）。交互方式全是函数调用，无事件。与 Gandiva 的关系：定位互补——compute 是单函数向量化 kernel（解释执行），Gandiva 是复杂表达式树 JIT 编译。

## 扩展方式

- **新增 scalar kernel**（如 `bit_count`）：在 `kernels/scalar_arithmetic.cc` 实现 functor，`RegisterScalarArithmetic` 内 `MakeUnaryArithmeticFunction<BitCount>("bit_count", doc)` + `AddFunction`，确认 `CreateBuiltInRegistry()`（`registry.cc:282`）包含该注册函数。
- **新增聚合函数**（如 `median`）：实现 `KernelState` 子类 + 四阶段（`init`/`consume`/`merge`/`finalize`），`AddKernel({Type::INT64}, float64(), ...)`，参考 `kernels/aggregate_basic.cc`。
- **新增带 options 的函数**：继承 `FunctionOptions`，用 `OptionsWrapper<YourOptions>`（`codegen_internal.h:76`）从 `KernelInitArgs` 提取参数。
