---
source:
  type: "源码解读"
  project: "Jeandle-LLVM"
  url: "https://github.com/jeandle/jeandle-llvm"
title: "编译流水线"
date: "2026-08-19T19:41:28+08:00"
category: [Languages, Java, Jeandle-LLVM, CodeWiki, "main-2025-11"]
tags: ["Jeandle", "LLVM", "PassManager", "Pipeline"]
description: "Jeandle 6 阶段编译流水线的编排机制与 PassBuilder/opt 集成"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/00-overview)

---

## 模块定位

编译流水线模块是 Jeandle-LLVM 对外的总入口与对内的总调度。它回答两个问题：**外部怎么调用 Jeandle？**（`jeandle::optimize()` C++ 接口与 `opt --jeandle` 命令行）和**Jeandle 的 pass 按什么顺序跑？**（`buildJeandlePipeline` 的 6 阶段编排）。其余四个模块——GC 基础设施、三个降级 pass、目标适配——都只是被这条流水线调度的"零件"。流水线模块本身不变换 IR，它只装配 pass、注册分析、把 Module 喂给 `ModulePassManager`。代码集中在 `llvm/lib/Jeandle/`（69 行实现）加 `PassBuilder.cpp`/`optdriver.cpp` 中各十几行注册代码。

## 模块架构

```
jeandle::optimize(Module*, Level)        ← 对外入口（jeandle-jdk 调用）
        │
        ▼
   Pipeline(Level)                       ← 栈对象，持有 PM + 4 个 AnalysisManager
        │
        ├── PassBuilder PB                ← 复用上游 PassBuilder
        ├── registerModuleAnalyses(MAM)
        ├── registerCGSCCAnalyses(CGAM)
        ├── registerFunctionAnalyses(FAM)
        ├── registerLoopAnalyses(LAM)
        ├── crossRegisterProxies(...)     ← 让四类分析互相可达
        └── buildJeandlePipeline(PM, PB, level)
                 │
                 ▼
          ModulePassManager.run(M, MAM)   ← 真正执行 pass
```

流水线模块内部只有一个类 `Pipeline`，外加一个自由函数 `optimize()`。它**不持有任何 Java 语义知识**——JavaOp 怎么内联、TLS 怎么改写、屏障怎么插，全部委托给被它装配进来的 pass。`Pipeline` 的职责纯粹是"建好分析管理器 + 装好 pass 序列 + run"。这种"编排与执行分离"的设计让流水线可以独立于任何单个 pass 演进——加 pass 只动 `buildJeandlePipeline` 一行，不动 `Pipeline` 类本身。

`opt --jeandle` 路径走另一条入口但殊途同归：`optdriver.cpp` 把 `-jeandle` 映射为 `"jeandle<O3>"` 文本，`PassBuilder::parsePassPipeline` 解析到 `jeandle` 别名时（`PassBuilder.cpp:1743`）调用同一个 `buildJeandlePipeline`。两条入口装配出的 pass 序列完全一致，`opt-option.ll` 测试专门守护这一点。

## 调用链路

一次 `optimize()` 调用的方法链：

```
optimize(M, Level)                         // Jeandle.cpp:16
  └─ Pipeline P(Level)                     // 构造，装分析+pass
       └─ Pipeline::Pipeline(Level)        // Pipeline.cpp:19
            ├─ PassBuilder PB              // Pipeline.cpp:24
            ├─ PB.registerModuleAnalyses(MAM)        // :27
            ├─ PB.registerCGSCCAnalyses(CGAM)        // :28
            ├─ PB.registerFunctionAnalyses(FAM)      // :29
            ├─ PB.registerLoopAnalyses(LAM)          // :30
            ├─ PB.crossRegisterProxies(LAM,FAM,CGAM,MAM)  // :31
            └─ buildJeandlePipeline(PM, PB, level)   // :33
  └─ P.run(*M)                             // Jeandle.cpp:18
       └─ PM.run(M, MAM)                   // Pipeline.cpp:46
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `optimize` in `Jeandle.cpp:16` | 创建 Pipeline 并 run | 栈对象 Pipeline，无全局状态；Level 默认 O3 |
| `Pipeline::Pipeline` in `Pipeline.cpp:19` | 装分析管理器 + 装配 pass | 分析注册必须在 `buildJeandlePipeline` 前——pass 依赖分析 |
| `buildJeandlePipeline` in `Pipeline.cpp:36` | 定义 6 阶段 pass 序列 | 静态方法，opt 别名路径也调它，保证两条入口一致 |
| `Pipeline::run` in `Pipeline.cpp:46` | 把 Module 喂给 PM | 单行委托 `PM.run(M, MAM)` |

</details>

## 核心实现

### optimize() 入口与 Pipeline 装配

`Jeandle.cpp` 是整个 Jeandle-LLVM 对 jeandle-jdk 暴露的唯一入口，只有 5 行有效代码：

```cpp title="llvm/lib/Jeandle/Jeandle.cpp"
void optimize(Module *M, OptimizationLevel Level) {
  Pipeline P(Level);
  P.run(*M);
}
```

这个极简入口是有意为之——jeandle-jdk 的 `JeandleCompilation` 只需 `#include "llvm/Jeandle/Jeandle.h"` 并链接 `LLVMJeandle` 库，调用 `jeandle::optimize(M, O3)` 即可。`Pipeline` 是栈对象：构造时装好一切，`run` 后随栈析构，不留任何全局状态。这意味着 Jeandle 编译是**可重入**的——多个编译任务可并行调用 `optimize`，互不干扰。

`Pipeline` 构造函数（`Pipeline.cpp:19`）的装配顺序是严格依赖驱动的：

```cpp title="llvm/lib/Jeandle/Pipeline.cpp"
Pipeline::Pipeline(OptimizationLevel level) {
  PassBuilder PB;
  PB.registerModuleAnalyses(MAM);
  PB.registerCGSCCAnalyses(CGAM);
  PB.registerFunctionAnalyses(FAM);
  PB.registerLoopAnalyses(LAM);
  PB.crossRegisterProxies(LAM, FAM, CGAM, MAM);
  buildJeandlePipeline(PM, PB, level);
}
```

四类 `AnalysisManager`（Loop/CGSCC/Function/Module）必须先注册，再 `crossRegisterProxies` 让它们能互相查询（如 Function pass 能取到 Module 级的 `ProfileSummaryAnalysis`），最后才能装配 pass——因为 `JavaOperationLower::run` 内部就要 `MAM.getResult<FunctionAnalysisManagerModuleProxy>` 取 FAM。颠倒顺序会导致 pass 取不到分析结果而崩溃。

### buildJeandlePipeline 的 6 阶段编排

这是流水线模块的"心脏"，也是整个 Jeandle-LLVM 设计意图最集中的体现：

```cpp title="llvm/lib/Jeandle/Pipeline.cpp"
void Pipeline::buildJeandlePipeline(ModulePassManager &PM, PassBuilder &PB,
                                    OptimizationLevel level) {
  PM.addPass(JavaOperationLower(0));                              // 阶段1: 早期降级
  PM.addPass(std::move(PB.buildPerModuleDefaultPipeline(level))); // 阶段2: O3
  PM.addPass(createModuleToFunctionPassAdaptor(InsertGCBarriers())); // 阶段3: GC屏障
  PM.addPass(JavaOperationLower(1));                              // 阶段4: 晚期降级
  PM.addPass(createModuleToFunctionPassAdaptor(TLSPointerRewrite())); // 阶段5: TLS改写
  PM.addPass(RewriteStatepointsForGC());                          // 阶段6: statepoint
}
```

6 个阶段不是随意排列，而是一条**降级相位递进**的设计：

- **阶段 1 在 O3 之前**：`JavaOperationLower(0)` 展开早期 JavaOp，让 O3 看到真实代码做优化。若放在 O3 之后，优化器只能对着"模板调用"干瞪眼。
- **阶段 3/4 夹住屏障**：先 `InsertGCBarriers` 插入 `jeandle.card_table_barrier` 调用（phase=1 的 JavaOp），再 `JavaOperationLower(1)` 把它内联展开。这样屏障逻辑经历了阶段 2 的 O3 优化机会，又在阶段 4 被具体化——既优化又落地。
- **阶段 5/6 在最后**：TLS 改写与 statepoint 重写是对 IR 的最终具体化，必须在所有优化与降级之后，否则后续 pass 会破坏它们的产物。

`buildJeandlePipeline` 是 `static` 方法——这让它能被 `PassBuilder` 的 `jeandle` 别名路径直接调用（`PassBuilder.cpp:1744`），不必先构造 `Pipeline` 对象。两条入口（`optimize()` 与 `opt --jeandle`）共用同一函数，保证 pass 序列一致。

### PassBuilder 与 opt 的别名注册

Jeandle 流水线要被 `opt` 的文本 pass 解析器识别，需在上游 `PassBuilder` 注册一个别名。改动分三处：

```cpp title="llvm/lib/Passes/PassBuilder.cpp（Jeandle 改动片段）"
// 1. 别名正则加入 "jeandle"
static const Regex DefaultAliasRegex(
    "^(default|thinlto-pre-link|thinlto|lto-pre-link|lto|jeandle)<(O[0123sz])>$");

// 2. 前缀识别
static bool startsWithDefaultPipelineAliasPrefix(StringRef Name) {
  return Name.starts_with("default") || Name.starts_with("thinlto") ||
         Name.starts_with("lto") || Name.starts_with("jeandle");
}

// 3. 别名展开
} else if (Matches[1] == "jeandle") {
  jeandle::Pipeline::buildJeandlePipeline(MPM, *this, L);
}
```

上游 `PassBuilder` 用正则匹配 `default<O3>`、`lto<O2>` 等别名并展开成对应流水线。Jeandle 把 `jeandle` 加进同一机制——`jeandle<O3>` 被解析时调 `buildJeandlePipeline`。这样 `opt -passes="jeandle<O3>"` 与 `opt --jeandle`（后者在 `optdriver.cpp` 里把 `Pipeline` 设为 `"jeandle<O3>"`）走同一条路。

`optdriver.cpp` 的改动仅两行——加一个 `cl::opt<bool> RunJeandle("jeandle", ...)`，命中时把 pipeline 文本设为 `"jeandle<O3>"`：

```cpp title="llvm/tools/opt/optdriver.cpp（Jeandle 改动片段）"
static cl::opt<bool> RunJeandle("jeandle",
                                cl::desc("Run Jeandle pass pipeline"));
// ...
if (RunJeandle)
  Pipeline = "jeandle<O3>";
```

`LLVMJeandle` 库通过 `CMakeLists.txt` 链接 `JeandleTransforms`（三个降级 pass）与 `Passes`、`Core`、`Analysis`、`Support`：

```cmake title="llvm/lib/Jeandle/CMakeLists.txt"
add_llvm_component_library(LLVMJeandle
  Jeandle.cpp
  Pipeline.cpp
  ADDITIONAL_HEADER_DIRS ${LLVM_MAIN_INCLUDE_DIR}/llvm/Jeandle
  LINK_COMPONENTS Analysis JeandleTransforms Core Passes Support)
```

jeandle-jdk 构建时链接 `LLVMJeandle`，即可调用 `jeandle::optimize()`。`opt` 工具因已链接 `LLVMJeandle`（通过 `LLVM_DYLIB_COMPONENTS=all`），自动获得 `-jeandle` 标志。

## 扩展方式

新增一个 pass 到流水线：在 `buildJeandlePipeline` 中 `PM.addPass(YourPass())` 插入合适相位。函数级 pass 用 `createModuleToFunctionPassAdaptor(YourPass())` 包装。若需新增一个像 `jeandle` 这样的顶层别名，改 `PassBuilder.cpp` 的正则与前缀识别（三处）+ `optdriver.cpp` 加 `cl::opt`。新增 pass 的头文件放 `llvm/include/llvm/Transforms/Jeandle/`，实现放 `llvm/lib/Transforms/Jeandle/`，在 `llvm/lib/Transforms/Jeandle/CMakeLists.txt` 加源文件名。
