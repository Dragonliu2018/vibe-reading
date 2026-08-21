---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "Gandiva JIT 编译器"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "Gandiva", "LLVM", "JIT"]
description: "Gandiva LLVM 表达式 JIT 编译器——Node→Dex→IR→机器码编译流程、Validity/Value 分离、编译一次执行多次与三层缓存"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

`cpp/src/gandiva/`（~53k 行）是基于 LLVM 的 Arrow 表达式 JIT 编译器。它把一个 filter 条件或 projection 表达式树**编译成原生机器码函数**，对每个 `RecordBatch` 直接调用机器码求值，而非像 compute 模块那样逐函数解释执行。定位是 compute 的**重型替代**：compute 适合单函数向量化 kernel，Gandiva 适合复杂表达式树（多函数组合、if-else、boolean 短路）的高吞吐场景。对外只暴露 `Filter` 与 `Projector` 两个入口，被 Dremio、Spark 等集成。

## 模块架构

```
┌──────────── 对外入口 ────────────┐
│  Filter::Make/Evaluate            │  filter.h   编译条件 → 选行
│  Projector::Make/Evaluate         │  projector.h 编译投影 → 输出列
└────────────┬─────────────────────-┘
             │ 持有
┌────────────▼─────────────────────┐
│  LLVMGenerator (llvm_generator.h)│
│   ├─ ExprDecomposer (NodeVisitor)  Node 树 → Dex 树（validity/value 分离）
│   ├─ Visitor (DexVisitor)          Dex 树 → LLVM IR
│   ├─ Engine                       Engine::FinalizeModule 优化+JIT
│   └─ compiled_exprs_              CompiledExpr（含 EvalFunc 函数指针）
└────────────┬─────────────────────-┘
             │ 驱动
┌────────────▼─────────────────────┐
│  Engine (engine.h)                │
│   ├─ llvm::orc::LLJIT             │  JIT 引擎
│   ├─ IRBuilder / Module           │  IR 构造
│   ├─ LoadFunctionIRs             │  加载预编译 bitcode
│   └─ FinalizeModule              │  O3 优化 + InternalizePass 裁剪
└────────────┬─────────────────────-┘
             │ 查
┌────────────▼─────────────────────┐
│  FunctionRegistry (function_registry.h) │
│   ├─ 6 子注册表（arith/datetime/hash/│
│   │   math/string/dt_arith）         │  NativeFunction + pc_name
│   └─ FunctionHolderMakerRegistry    │  需运行时参数的函数 holder
└──────────────────────────────────-┘
  缓存：Cache<ExpressionCacheKey, MemoryBuffer>（LRU object code）
       GandivaObjectCache（桥接 LLVM ObjectCache）
```

## 调用链路

编译期（`Make`）与运行期（`Evaluate`）分离：

```
Filter::Make(schema, condition, config, &filter)   filter.cc:40
  └─ 查缓存: ExpressionCacheKey(schema,config,condition) → GetCache()  命中则跳过编译
  └─ LLVMGenerator::Make → Engine::Make
       ├─ llvm::InitializeNativeTarget (call_once)
       ├─ 检测 host CPU + 创建 TargetMachine (O3/PIC)
       └─ new LLJIT + AddGlobalMappings（注册 C 辅助函数）
  └─ ExprValidator::Validate (Visitor 校验类型/签名)   expr_validator.h
  └─ LLVMGenerator::Build({condition}, MODE_NONE)
       ├─ ExprDecomposer::Decompose(root, &value_validity)  Node→Dex
       │    └─ 按 result_nullable_type 分:
       │       kResultNullIfNull → NonNullableFuncDex（validity=子节点 AND）
       │       kResultNullInternal → NullableInternalFuncDex（+ local bitmap）
       ├─ CodeGenExprValue(value_expr, ...)  Dex→IR
       │    └─ LLVMGenerator::Visitor 遍历 Dex 树：
       │       VectorReadFixedLenValueDex → GEP+Load
       │       NonNullableFuncDex → BuildFunctionCall（调预编译 IR 函数）
       │       IfDex → 建 then/else/merge BasicBlock
       │       BooleanAnd/OrDex → 短路求值
       │    └─ 生成含 for 循环的 LLVM Function（签名 = EvalFunc）
  └─ Engine::FinalizeModule              engine.cc
       ├─ RemoveUnusedFunctions (InternalizePass+GlobalDCE)
       ├─ OptimizeModuleWithNewPassManager (O3: ModuleInliner/InstCombine/GVN/
       │   SimplifyCFG/LoopVectorize/SLPVectorizer)
       └─ lljit_->addIRModule  JIT 编译为机器码
  └─ engine_->CompiledFunction(name) → EvalFunc 函数指针  存入 CompiledExpr

filter->Evaluate(batch, out_selection)             filter.cc:91
  └─ Annotator::PrepareEvalBatch(batch, ...)  从 RecordBatch 提裸 buffer 指针 → EvalBatch
  └─ for each compiled_expr:
       jit_function(buffers, offsets, local_bitmaps, holder_ptrs,
                    selection_buffer, execution_ctx, num_rows)   ← 直接调机器码
  └─ ComputeBitMapsForExpr (BitMapAccumulator 合并 validity bitmaps)
  └─ out_selection->PopulateFromBitMap()  从 bitmap 提命中行号
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `Filter::Make` (`filter.cc:40`) | 编译条件表达式 | 查缓存，命中跳过编译 |
| `Filter::Evaluate` (`filter.cc:91`) | 执行 filter | 直接调 `EvalFunc` 机器码 |
| `LLVMGenerator::Build` (`llvm_generator.cc`) | 编译 expr | ExprDecomposer+IR Visitor 双层 |
| `ExprDecomposer` (`expr_decomposer.h:39`) | Node→Dex | validity/value 分离 |
| `Engine::FinalizeModule` (`engine.cc`) | 优化+JIT | O3 + InternalizePass 裁剪未用函数 |
| `CompiledFunction` (`engine.h`) | 取函数地址 | `lljit_->lookup` 返回机器码指针 |
| `Engine::LoadPreCompiledIR` (`engine.cc:408`) | 加载 bitcode | 内置函数 IR 预编译 |
</details>

## 核心实现

### 编译期：Node→Dex→IR→机器码

Gandiva 用**双层 Visitor**：第一层 `NodeVisitor`（`ExprDecomposer`，`expr_decomposer.h:39`）把语义树（`Node`：`FieldNode`/`LiteralNode`/`FunctionNode`/`IfNode`/`BooleanNode`/`InExpressionNode`）分解为中间表示 `Dex` 树（`ValueValidityPair`：validity 与 value 分离）；第二层 `DexVisitor`（`LLVMGenerator::Visitor`，`llvm_generator.h:104`）遍历 Dex 树生成 LLVM IR。生成的 IR 等价于一个含 for 循环的 C 函数（`llvm_generator.cc:229` 注释示例）：循环变量遍历行，从输入 buffer GEP+Load 取值、调预编译 IR 函数算、存入输出 buffer。`Engine::FinalizeModule`（`engine.cc`）用 O3 管线优化（`ModuleInlinerPass` 内联、`InstCombinePass`/`GVNPass` 消除冗余、`LoopVectorizePass`/`SLPVectorizerPass` 自动向量化），再 `lljit_->addIRModule` JIT 成机器码。**为什么 JIT 而非 compute 的解释执行**：把整个表达式编译成一个函数，LLVM 内联消除函数间调用开销、常量折叠、消除逐行 null 检查、自动向量化——对复杂表达式高吞吐场景优势显著。

### 运行期：直接调机器码

`Evaluate`（`filter.cc:91`）阶段不再有解释开销：`Annotator::PrepareEvalBatch` 从 `RecordBatch` 的 `ArrayData` 提裸 buffer 指针组装 `EvalBatch`，然后直接调用 `CompiledExpr` 的 `EvalFunc` 函数指针：

```cpp title="compiled_expr.h EvalFunc 签名"
using EvalFunc = int (*)(uint8_t** buffers, int64_t* offsets, uint8_t** local_bitmaps,
                         const void* const* holder_ptrs, const uint8_t* selection_buffer,
                         int64_t execution_ctx_ptr, int64_t record_count);
```

`Make` 时编译一次，`Evaluate` 可对任意多 batch 调用——**编译一次执行多次**，这正是 OLAP/SQL 引擎场景（同一 filter 对大量 batch 执行）的理想模型。

### Validity/Value 分离

`ExprDecomposer` 把每个 `Node` 分解为 `ValueValidityPair { DexPtr value_expr; DexVector validity_exprs }`。按 `NativeFunction::result_nullable_type`：`kResultNullIfNull` 类函数的 validity = 子节点 validity 的 AND 合并（不调函数算 validity，运行时 `BitMapAccumulator` 做 bitmap 交集）；`kResultNullInternal` 类（如除法除零）需自己算 validity，分配 local bitmap。**为什么分离**：避免逐行 null 检查——validity 用 SIMD 友好的 bitmap 操作批量算，value 计算时可跳过 null 检查，是 Gandiva 的核心优化。

### 三层缓存

1. **Object code 缓存**：`Cache<ExpressionCacheKey, shared_ptr<llvm::MemoryBuffer>>`（`cache.h:44`），LRU，容量由 `GANDIVA_CACHE_CAPACITY` 环境变量控制。命中直接加载 object file 跳过 IR 生成与 JIT。
2. **预编译 IR bitcode**：`Engine::LoadPreCompiledIR`（`engine.cc:408`）加载编译时预生成的 `kPrecompiledBitcode`，含所有内置函数 IR；`LoadExternalPreCompiledIR`（`engine.cc:437`）加载用户外部 bitcode。
3. **未用函数裁剪**：`RemoveUnusedFunctions`（`engine.cc:455`）用 `InternalizePass`+`GlobalDCE` 只保留实际用到的函数，减少编译时间（注释"Adapted from Apache Impala"）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 双层 Visitor | `NodeVisitor`(`expr_decomposer`)+`DexVisitor`(`llvm_generator.h:104`) | 语义树→IR→机器码分阶段处理 |
| Registry | `FunctionRegistry`+`FunctionHolderMakerRegistry`（`function_registry.h`） | 函数可扩展，6 子注册表分类 |
| JIT（Interpreter→Compiler） | `LLVMGenerator::Build`→`Engine::FinalizeModule` | 消除逐行解释开销 |
| Object Cache | `Cache<ExpressionCacheKey,MemoryBuffer>`+`GandivaObjectCache` | 相同表达式不重复编译 |
| Strategy | `result_nullable_type` 三策略 | 不同 null 语义不同处理 |

## 模块间交互

依赖 **Arrow 核心**（输入 `RecordBatch`/`ArrayData`/`Schema`/`Field`，输出 `ArrayVector`/`Buffer`/`MemoryPool`；`Annotator::PrepareEvalBatch` 从 `ArrayData` 提裸 buffer 指针）。**与 compute 的关系**：Gandiva 的 `Node` AST 是独立的，不复用 `compute::Expression`，两者定位互补（compute 单函数向量化，Gandiva 复杂表达式 JIT）。被 Dremio/Spark 等执行引擎集成。对外只暴露 `Filter`/`Projector`。

## 扩展方式

- **新增 runtime 函数**（如 `my_func_int32_int32`）：在 `function_registry_arithmetic.cc` 的 `GetArithmeticFunctionRegistry()` 用宏 `BINARY_SYMMETRIC_SAFE_NULL_IF_NULL(my_func, {})`（`function_registry_common.h:80`）生成 `NativeFunction`（`pc_name="my_func_int32_int32"` 必须与 IR 函数名一致），或用 `FunctionRegistry::Register(NativeFunction, c_function_ptr, holder_maker)`（`function_registry.h:67`）注册 C 函数到 LLJIT 符号表。
- **新增需运行时参数的函数**（如 `regexp_like(pattern)`）：创建 `FunctionHolder` 子类（参考 `LikeHolder`），在 `FunctionHolderMakerRegistry` 注册 maker（`function_holder_maker_registry.h:38`），`NativeFunction` 设 `kNeedsFunctionHolder` flag（`native_function.h:45`），JIT 代码经 `Visitor::BuildParams`（`llvm_generator.cc:1310`）通过 `arg_holder_ptrs_` 传 holder 指针。
- **自定义表达式集成**：用 `Node` 体系（`node.h`）+`tree_expr_builder.h` 构造 AST，`Projector::Make`+`Evaluate`；自定义函数经 `Configuration::set_function_registry`（`configuration.h:63`）注入。
