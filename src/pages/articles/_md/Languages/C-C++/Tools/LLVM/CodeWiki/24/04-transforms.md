---
source:
  type: "源码解读"
  project: "LLVM"
  url: "https://github.com/llvm/llvm-project"
title: "Transforms 中端优化"
date: "2026-08-20T10:23:42+08:00"
category: ["Languages", "C/C++", "Tools", "LLVM", "CodeWiki", "24"]
tags: ["LLVM", "Transforms", "InstCombine", "Vectorize", "Inliner", "SCCP"]
description: "LLVM 中端优化 pass——InstCombine worklist 不动点、向量化四阶段、内联代价模型"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/00-overview)

---

## 模块定位

Transforms 是 LLVM 优化能力的主体——把 IR 变成"更优的等价形式"的 200+ 个 transformation pass，分布在 `lib/Transforms` 下 11 个子目录（Scalar/IPO/Vectorize/InstCombine/Instrumentation/Coroutines/…）。它本身不含调度逻辑（那是 Pass 管理与分析的事），每个 pass 只实现 `run()` 被 `PassManager` 调度。与调度框架分离使 pass 能独立演进、独立测试、按需组合进不同优化等级的管线。

## 模块架构

按优化粒度分三类 pass：

```
标量优化 Scalar（函数内单条路径）   过程间 IPO（跨函数）   向量化 Vectorize
├── InstCombine（指令化简）          ├── Inliner（代价内联）    ├── LoopVectorize（4 阶段）
├── SimplifyCFG（CFG 化简）          ├── AlwaysInliner（强制） ├── SLPVectorizer（基本块）
├── SCCP（稀疏条件常量传播）          ├── GlobalDCE / GlobalOpt  └── LoopUnroll
├── GVN（全局值编号）
├── LoopUnroll / LoopRotate
└── MemCpyOpt / DeadStoreElimination

工具 Utils（被多 pass 复用）：BasicBlockUtils（SplitBlock/MergeBlockIntoPredecessor）
```

每个新 PM pass 继承 `PassInfoMixin<T>`（或 `Optional`/`Required` 变体），按 IRUnit 分级：Function 级（`InstCombinePass`）、Module 级（`AlwaysInlinerPass`）、CGSCC 级（`InlinerPass`）。

## 调用链路

以 `InstCombine` 为例，看一个 pass 内部如何遍历 IR 并迭代到不动点：

```
InstCombinePass::run(Function &F, FunctionAnalysisManager &AM)    [InstructionCombining.cpp:6257]
  │  输入：Function → 输出：PreservedAnalyses
  ├─ AM.getResult<LastRunTrackingAnalysis>(F)  # 无变化则提前返回 all()
  ├─ AM.getResult<...>(F): AssumptionCache / DominatorTree / TargetLibraryInfo / TargetIRAnalysis / AA
  └─ combineInstructionsOverFunction(F, Worklist, ...)              [InstructionCombining.cpp:6179]
       ├─ ReversePostOrderTraversal 遍历 BB
       └─ while (true):                                            # 外层迭代直到不动点
            ├─ InstCombinerImpl IC(...).prepareWorklist(F)         # 逆序 push 指令、常量折叠、清死边
            ├─ IC.run()                                             # [InstructionCombining.cpp:5779]
            │    while (!Worklist.empty()):
            │      removeOne → 取 I → DCE 检查 → InstVisitor dispatch → visit<Opcode>(I)
            │        → 返回 Instruction*（null=无变化，I=有变化，其他=替换值）
            │      若有变化 → eraseInstFromFunction(I) + pushUsersToWorkList(I)  # 用户重入队
            └─ 若 !MadeChangeInThisIteration → break
       返回 PA: preserve<LastRunTrackingAnalysis>() + preserveSet<CFGAnalyses>()
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `InstCombinePass::run` in `InstructionCombining.cpp:6257` | 指令级化简到不动点 | 不改 CFG，保留 `CFGAnalyses` |
| `combineInstructionsOverFunction` in `:6179` | 外层迭代驱动 | 默认 `MaxIterations=1`，管线多次插 InstCombine |
| `processLoop` in `LoopVectorize.cpp:7874` | 向量化一个循环 | 合法性→代价→规划四阶段 |

## 核心实现

### InstCombine：Worklist 模式到不动点

`InstCombinerImpl` 继承 `InstVisitor<InstCombinerImpl, Instruction*>`（`InstCombineInternal.h:70`），为 30+ 种指令定义 `visitAdd`/`visitSub`/`visitMul`/`visitICmpInst`/`visitTrunc` 等。`InstructionWorklist`（`InstructionWorklist.h:25`）含 `SmallVector<Instruction*,256>` + `DenseMap` 去重 + `SmallSetVector` 延迟队列。

**为什么 worklist 反复迭代到不动点**：一条指令化简会改变其用户输入，为用户创造新化简机会（如 `add 1,%X` 消除后，其用户 `add 1,%Y` 可能变 `add 2,%X`）。单次遍历抓不住级联。Worklist 在每次化简后把所有用户重新入队（`pushUsersToWorkList`），天然处理级联；`WorklistMap` 去重防无限循环。

### 向量化四阶段

`LoopVectorizePass`（`LoopVectorize.h:131`）是 Function 级 pass，内部缓存大量分析（SE/LI/TTI/DT/AA），对每个内层循环走四阶段（头注释 `LoopVectorize.h:18`）：

```
processLoop(L)                                                  [LoopVectorize.cpp:7874]
  ├─ LoopVectorizationLegality LVL(...).canVectorize()    # 1. 合法性：内存依赖/归约/归纳/浮点重排安全
  ├─ InterleavedAccessInfo IAI.analyzeInterleaving()      #   交错访问
  ├─ LoopVectorizationCostModel CM(...)                    # 2. 代价：用 TTI 查后端代价，决定 VF（可能=1 只交错）
  ├─ LoopVectorizationPlanner LVP(...)                     # 3. 规划
  └─ InnerLoopVectorizer(...).                             # 4. 生成： widening 生成向量指令
```

**为什么分四阶段**：分离合法性（能不能向量化）和盈利性（值不值得）是编译器优化经典原则。合法性查内存依赖、归约变量、归纳变量、浮点重排序安全性；代价模型用 `TargetTransformInfo` 查后端代价，可能返回 VF=1（不值得向量化但可交错）。四阶段分离使各阶段独立测试，也允许 VPlan 等新基础设施逐步替换某一阶段。

### 内联代价模型 + AlwaysInliner 分离

`InlineCost`（`InlineCost.h:91`）用 `Cost < Threshold` 决策，哨兵值 `AlwaysInlineCost=INT_MIN`/`NeverInlineCost=INT_MAX` 表总是/永不，`operator bool()` 直接 `Cost < Threshold`。`InlinerPass`（`Inliner.h:36`）是 CGSCC 级，操作 `LazyCallGraph::SCC` 而非单个 `Function`，用 `InlineAdvisor` 策略模式封装决策（`DefaultInlineAdvisor` 基于 cost model，`ReplayInlineAdvisor` 重放，可插 ML-based inlining）。

**为什么 `AlwaysInlinerPass` 分离**：`always_inline` 属性是语义强制（头文件内联函数），不需 cost model 决策。分离出 `AlwaysInlinerPass`（Module 级，`RequiredPassInfoMixin` 总执行）在最早期就处理强制内联，逻辑极简——"看到就内联"。`InlinerPass` 处理基于 cost 的可选内联。**为什么 SCC 级**：内联决策需考虑调用图拓扑，bottom-up 先处理叶子函数再处理调用者（`Inliner.cpp:223` 注释解释为何用 in-order 而非 priority queue，防高度连通 SCC 超线性代码膨胀）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Visitor（InstVisitor） | `InstCombinerImpl` in `InstCombineInternal.h:70` | 按指令类型分发，CRTP 生成 switch 替代手写 |
| Worklist | `InstructionWorklist` in `InstructionWorklist.h:25` | 级联化简，去重防无限循环 |
| Cost Model | `LoopVectorizationCostModel` in `LoopVectorize.cpp:772`、`InlineCost` in `InlineCost.h:91` | 量化决策向量化/内联盈利性 |
| Strategy | `InlineAdvisor`/`DefaultInlineAdvisor`/`ReplayInlineAdvisor` in `Inliner.cpp:154` | 内联策略可插拔 |
| Template Method | `InnerLoopVectorizer` + `InnerLoopAndEpilogueVectorizer` in `LoopVectorize.cpp:535,645` | 主循环+epilogue vs 单循环策略 |

## 模块间交互

依赖 `llvm/IR`（Function/BasicBlock/Instruction/IRBuilder）、`llvm/Analysis`（DominatorTree/ScalarEvolution/LoopInfo/AssumptionCache/AAResults/TargetTransformInfo/InlineCost）、`llvm/Support`。每个 pass 通过 `AM.getResult<AnalysisT>(F)` 查分析（如 `LoopVectorizePass::run` 密集查 LI/SE/TTI/DT/LoopAccessAnalysis/DemandedBits，`LoopVectorize.cpp:8444`）。被 `PassBuilder`/`PassRegistry.def` 调度，被 `opt` 工具驱动。`PassRegistry.def` 用 `FUNCTION_PASS("instcombine", InstCombinePass)` 等宏注册 pass 名到类映射；`PassBuilderPipelines.cpp` 组合默认管线（如 `FPM.addPass(InstCombinePass())` in `:505`）。

## 扩展方式

新增一个 Scalar pass：`include/llvm/Transforms/Scalar/MyPass.h` 定义 `class MyNewPass : public OptionalPassInfoMixin<MyNewPass>` 实现 `run(Function&, FunctionAnalysisManager&)` → `lib/Transforms/Scalar/MyPass.cpp` 实现 → `lib/Passes/PassRegistry.def` 加 `FUNCTION_PASS("my-new-pass", MyNewPass())` → `PassBuilderPipelines.cpp` 在 `buildFunctionPipeline` 序列插 `FPM.addPass(MyNewPass())` → `lib/Transforms/Scalar/CMakeLists.txt` 加源文件。为向量化加代价规则：改 `LoopVectorizationCostModel`（`LoopVectorize.cpp:772`）的 `computeMaxVF`/`setCostBasedWideningDecision`，若需后端提供新代价接口则加 `TargetTransformInfo` 虚函数 + 各后端 TTI 实现（如 `lib/Target/X86/X86TargetTransformInfo.cpp`）。
