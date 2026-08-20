---
source:
  type: "源码解读"
  project: "LLVM"
  url: "https://github.com/llvm/llvm-project"
title: "Pass 管理与分析"
date: "2026-08-20T10:23:42+08:00"
category: ["Languages", "C/C++", "Tools", "LLVM", "CodeWiki", "24"]
tags: ["LLVM", "PassManager", "AnalysisManager", "PassBuilder", "AliasAnalysis"]
description: "LLVM 新 Pass Manager——类型擦除调度、AnalysisManager 按需缓存与精确失效、AA 聚合"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/00-overview)

---

## 模块定位

Pass 管理与分析框架是优化器的"引擎"——它不自己优化 IR，而是决定"按什么顺序跑哪些 pass、如何缓存分析结果、pass 之间如何精确失效分析"。`PassBuilder` 把文本管线（`-passes="instcombine,simplifycfg"`）解析成 `PassManager` pass 树，`AnalysisManager` 按需计算并缓存分析（支配树、循环信息、别名分析…）。`Transforms`/`CodeGen` 的每个 pass 都通过它查询分析、被它调度。它独立成模块是因为调度逻辑与分析缓存是"横切"所有 pass 的基础设施，不应耦合进任何单个 pass。

## 模块架构

```
PassBuilder（入口/注册中心）
  │  parsePassPipeline(text) → PipelineElement 树 → addPass
  │  registerModuleAnalyses / registerFunctionAnalyses（注册分析）
  ▼
PassManager<IRUnitT>（调度器，IRUnit=Module/Function/CGSCC/Loop）
  │  Passes: vector<unique_ptr<PassConcept>>   ← 类型擦除持有异构 pass
  │  run(IR, AM): for each Pass → Pass.run(IR,AM) → AM.invalidate(IR, PA)
  ▼
AnalysisManager<IRUnitT>（分析缓存）
  │  AnalysisPasses: {AnalysisKey* → AnalysisPassConcept}   注册的分析
  │  AnalysisResultLists: {IR* → list<(ID, ResultConcept)>} 每个IR单元的结果
  │  getResult(ID,IR): 查缓存 ─未命中→ lookUpPass→run→缓存
  │  invalidate(IR,PA): 遍历结果 → Result.invalidate(Inv) → 递归失效 → erase
  ▼
Analysis（分析实现，llvm/lib/Analysis）
  DominatorTree / LoopInfo / ScalarEvolution / AAResults（聚合 BasicAA/GlobalsAA/...）
```

类型擦除机制 `PassConcept`/`PassModel`（`PassManagerInternal.h:42,108`）是关键——`PassManager` 用 `vector<unique_ptr<PassConcept>>` 持有任意类型的 pass，无需公共基类继承。

## 调用链路

从文本管线到 pass 执行再到分析失效：

```
PassBuilder::parsePassPipeline(MPM, "module(function(instcombine,simplifycfg),dce)")
  │                                          [lib/Passes/PassBuilder.cpp:2714]
  ├─ parsePipelineText() → vector<PipelineElement>      # 栈解析嵌套括号
  ├─ isModulePassName() 自动包装非 module 层 pass         # function→{module,{function,...}}
  └─ parseModulePass() → MPM.addPass(CREATE_PASS)      # MODULE_PASS 宏匹配名字
       │
       ▼
PassManager<Module>::run(M, AM)                         [include/llvm/IR/PassManagerImpl.h:28]
  ├─ PI.runBeforePass(Pass, IR)                          # 回调可跳过
  ├─ Pass->run(IR, AM) → PassModel::runImpl → 实际 pass.run()
  ├─ AM.invalidate(IR, PassPA)                           # 用 PA 失效分析
  └─ PA.intersect(PassPA)                                # 累积保留集合
       │
       ▼
AnalysisManager::getResult<PassT>(IR)                    [PassManager.h:431]
  ├─ AnalysisResults.try_emplace({ID,&IR}) 缓存查
  ├─ 命中 → 返回缓存结果
  └─ 未命中 → lookUpPass(ID).run(IR,*this) → 缓存 → PI.runBeforeAnalysis
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `parsePassPipeline` in `PassBuilder.cpp:2714` | 文本管线→pass 树 | 嵌套括号语法，自动跨层包装 |
| `PassManager::run` in `PassManagerImpl.h:28` | 调度 pass + 失效分析 | 每 pass 后用 PA 精确失效 |
| `AnalysisManager::getResult` in `PassManager.h:431` | 按需计算+缓存分析 | 未命中才算，算一次缓存复用 |
| `AnalysisManager::invalidate` in `PassManagerImpl.h:165` | 失效分析 | Result.invalidate(Inv) 递归传播依赖 |

## 核心实现

### 类型擦除 Concept+Model

`PassConcept` 不用虚函数，而用函数指针成员做 dispatch（注释 `PassManagerInternal.h:38`："This doesn't use virtual functions to avoid vtables, which cost a fair amount of storage that needs to be relocated in PIC builds"）：

```cpp title="include/llvm/IR/PassManagerInternal.h:42"
class PassConcept {
  using RunTy = PreservedAnalyses (*)(PassConcept&, IRUnitT&, AnalysisManagerT&, ExtraArgTs...);
  StringRef Name; bool IsRequired;
  DestroyTy Destroy; RunTy Run; PrintPipelineTy PrintPipeline;
 public:
  PreservedAnalyses run(IRUnitT &IR, AnalysisManagerT &AM, ExtraArgTs... ExtraArgs) {
    return Run(*this, IR, AM, std::forward<ExtraArgTs>(ExtraArgs)...);
  }
};
template <typename PassT> class PassModel final : public PassConcept {
  PassT Pass;                                          // 持有实际 pass 对象
  static PreservedAnalyses runImpl(...) { return getPass(Self).run(IR, AM, ExtraArgs...); }
};
```

`PassManager::addPass()` 时 `PassModelT::create(std::move(Pass))` 把任意类型 pass 包成 `PassConcept` 存入向量。此模式遵循 Sean Parent "Value Semantics and Concept-based Polymorphism" 思想（`PassManager.h:28` 注释引用）——值语义 + concept 实现多态，避免继承层次。

### AnalysisManager 缓存与精确失效

分析用 `AnalysisKey *`（静态全局变量地址）作唯一标识，`DenseMap<AnalysisKey*,...>` 哈希查找（`PassManager.h:558`），比 RTTI 快且 `-fno-rtti` 可用。`PreservedAnalyses` 是贯穿框架的核心类型——pass 返回它声明哪些分析被保留：

```cpp title="include/llvm/IR/PassManagerImpl.h:165"
AM.invalidate(IR, PA):
  for each (ID, Result) in ResultsList:
    Result.invalidate(IR, PA, Inv)     # AnalysisResultModel 的 lambda 判断
      # 1) 若 ResultT 有 invalidate 方法 → 调用它
      # 2) 否则检查 PA 是否保留该分析
      # 内部可 Inv.invalidate<DepT>(IR, PA) 递归失效依赖分析
    if 失效 → erase
```

**为什么用 `PreservedAnalyses` 而非全部失效**：这是新 PM 的核心理念——失效精确化。`InstCombine` 不改 CFG，所以 `PA.preserveSet<CFGAnalyses>()`（`InstructionCombining.cpp:6286`）保留支配树/循环信息，下游 pass 无需重建昂贵分析，是编译速度关键。`Invalidator` 支持分析间依赖的递归失效（depth-first walk）。

### AA 聚合（Chain-of-Responsibility 变体）

`AAResults`（`AliasAnalysis.h:315`）持有 `vector<unique_ptr<Concept>> AAs`——多个 AA 实现（BasicAA 基于指针推导、GlobalsAA 基于全局变量、TypeBasedAA 基于 TBAA 元数据）按顺序注册，查询时依次调用取最精确结果：

```cpp title="include/llvm/Analysis/AliasAnalysis.h"
class AAResults {
  const TargetLibraryInfo &TLI;
  std::vector<std::unique_ptr<Concept>> AAs;
 public:
  template <typename AAResultT> void addAAResult(AAResultT &R) {
    AAs.emplace_back(new Model<AAResultT>(R, *this));   // Concept+Model 类型擦除
  }
  AliasResult alias(const MemoryLocation &A, const MemoryLocation &B);
};
class AAResultBase {  // 保守默认 MayAlias/ModRef，具体 AA 只 override 关心方法
  AliasResult alias(...) { return AliasResult::MayAlias; }
};
```

**为什么聚合**：不同 AA 有不同精度/代价，先跑快/精确的，不够再跑保守的；`AAResultBase` 提供"保守正确"默认，新 AA 只 override 关心方法。这是 Chain-of-Responsibility 变体——所有处理者都尝试，取最精确结果，而非停在第一个。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 类型擦除 Concept+Model | `PassConcept`/`PassModel` in `PassManagerInternal.h:42,108` | 持有异构 pass 不用 vtable |
| CRTP Mixin | `PassInfoMixin<DerivedT>` in `PassManager.h:89` | 编译期提供 `name()`/`ID()` |
| 注册表（X-macro） | `PassRegistry.def` + `registerModuleAnalyses` | 一份数据三处复用（注册/验证名/实例化） |
| Strategy + Chain | `AAResults` 聚合 AA in `AliasAnalysis.h:315` | 多 AA 取最精确结果 |
| Proxy | `InnerAnalysisManagerProxy` in `PassManager.h:601` | 跨层 AM 互访（FAM 从 Module pass 访问） |
| Observer | `PassInstrumentationCallbacks` + EP 回调 | 调试/计时/pass skip 钩子 |

## 模块间交互

向下依赖 `llvm/IR`（Module/Function 定义）、`llvm/Support`、`llvm/ADT`。向上被 `lib/Transforms` 的每个 pass（实现 `run()` 并通过 `AM.getResult<DominatorTreeAnalysis>(F)` 查分析）和 `lib/CodeGen`（`MachineFunctionPassManager` 复用同一框架，`PassBuilder.h:391` 有 `parsePassPipeline(MachineFunctionPassManager&)` 重载，`MachinePassRegistry.def` 独立注册）依赖。`opt` 工具直接调用 `PassBuilder::parsePassPipeline`。Analysis 层（`include/llvm/Analysis/`：DominatorTree/LoopInfo/ScalarEvolution/AAResults）作为 `AnalysisManager` 管理的分析 pass，通过 `registerFunctionAnalyses` 注册。

## 扩展方式

注册一个新 pass：编写类继承 `PassInfoMixin<MyPass>` 实现 `PreservedAnalyses run(IRUnitT&, AnalysisManagerT&)` → `lib/Passes/PassRegistry.def` 加 `MODULE_PASS("my-pass", MyPass())`（一处注册，`isModulePassName`/`parseModulePass`/`printPassNames` 共用）→ `PassBuilder.cpp` 顶部 `#include` 头文件。新增一个分析：继承 `AnalysisInfoMixin<MyAnalysis>` 提供 `static AnalysisKey Key` 实现 `Result run(...)` → `PassRegistry.def` 加 `FUNCTION_ANALYSIS("my-analysis", MyAnalysis())` 自动注册到 FAM；若有复杂失效逻辑，在 `Result` 类实现 `invalidate(...)`（`ResultHasInvalidateMethod` SFINAE 检测，有则调它精确失效，无则退化为查 `PreservedAnalyses`）。扩展默认 pipeline：推荐用 `PassBuilder::registerVectorizerStartEPCallback` 等 EP 回调（`PassBuilder.h:480`）在特定位置插 pass，无需改 `PassBuilder.cpp`。
