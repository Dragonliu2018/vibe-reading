---
source:
  type: "源码解读"
  project: "Jeandle-LLVM"
  url: "https://github.com/jeandle/jeandle-llvm"
title: "Overview"
date: "2026-08-19T19:41:28+08:00"
category: [Languages, Java, Jeandle-LLVM, CodeWiki, "main-2025-11"]
tags: ["Jeandle", "LLVM", "Java", "JIT", "GC"]
description: "Jeandle Java JIT 编译器的 LLVM 侧支持——在 LLVM 20.1.0 上添加 Java 专用编译流水线、GC 策略与后端适配"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** main-2025-11 · **解读基线** commit [`65b5a7a98762`](https://github.com/jeandle/jeandle-llvm/commit/65b5a7a98762441db787bbc02478fd6707af5da9)（2025-11-05，开发分支快照，无 release tag）· **协议** Apache-2.0 WITH LLVM-exception · **语言** C++ · **Jeandle 专有代码** ~750 行（17 个文件）+ 对上游 LLVM 的散布式修改 · **仓库** [GitHub](https://github.com/jeandle/jeandle-llvm)

---

## 总览

### 项目简介

**Jeandle** 是一个面向 Java 的 JIT 编译器，构建在 OpenJDK 之上，借助 LLVM 编译基础设施生成机器码，目标是提供强大的编译优化能力并交付高性能代码。Jeandle 由两个仓库组成：

- **[jeandle-jdk](https://github.com/jeandle/jeandle-jdk)**（OpenJDK 侧）：承载抽象解释器（字节码 → LLVM IR）、编译驱动、代码生成（ELF 解析重定位入 Code Cache）与运行时例程。
- **jeandle-llvm**（本仓库，LLVM 侧）：在 LLVM 20.1.0 上添加 Java 专用的**编译流水线**、**GC 策略**、**降级 pass** 和**后端适配**，使 LLVM 能正确优化和降低 Java 语义的 IR。

本仓库解决的核心问题是：**上游 LLVM 不懂 Java**。Java 的对象指针需要 GC 管理、线程局部数据通过线程寄存器访问、方法调用遵循 HotSpot 的寄存器约定、写堆操作需要 card-table 屏障、safepoint 支持需要在编译期插入轮询点。jeandle-llvm 通过一组小而精的扩展把这一切接入 LLVM，与 jeandle-jdk 的抽象解释器协同——后者把 Java 字节码翻译成带 Java 语义标记的 LLVM IR（如 `addrspace(1)` 标记 Java 堆指针、`hotspotcc` 标记 Java 调用约定、`lower-phase` 属性标记 JavaOp 模板函数），再交给本仓库的流水线优化与降低。

**项目边界**：本仓库只负责 LLVM 侧。Java 字节码到 LLVM IR 的翻译、Code Cache 的装入、运行时例程的实现都在 jeandle-jdk 仓库。两个仓库需配合构建——jeandle-jdk 的 `src/hotspot/share/jeandle/` 调用本仓库编译出的 `LLVMJeandle` 库的 `jeandle::optimize()` 入口。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| Jeandle 编译流水线 | `llvm/lib/Jeandle/Pipeline.cpp` | 6 阶段 pass 流水线，以 `jeandle<O3>` 别名注册到 PassBuilder |
| 优化入口 | `llvm/lib/Jeandle/Jeandle.cpp` | `jeandle::optimize(Module*, OptimizationLevel)` 供 jeandle-jdk 调用 |
| Java GC 策略 | `llvm/lib/IR/Jeandle/GCStrategy.cpp` | `HotspotGC` 策略（`"hotspotgc"`），启用 statepoint 与 RS4GC |
| IR 元数据与属性 | `llvm/include/llvm/IR/Jeandle/{Metadata,Attributes}.h` | 地址空间、元数据名、属性名常量 |
| JavaOp 两阶段降级 | `llvm/lib/Transforms/Jeandle/JavaOperationLower.cpp` | 按相位内联并擦除 JavaOp 模板函数 |
| TLS 指针改写 | `llvm/lib/Transforms/Jeandle/TLSPointerRewrite.cpp` | 把 addrspace(2) 指针改为相对线程寄存器基址 |
| Card-table 屏障 | `llvm/lib/Transforms/Jeandle/InsertGCBarriers.cpp` | Java 堆写后插入 card-table 屏障调用 |
| Hotspot_JIT 调用约定 | `X86CallingConv.td` / `AArch64CallingConvention.td` | Java 寄存器传参顺序，调用约定 ID = 112 |
| IR 文本语法 | `llvm/lib/AsmParser/LLLexer.cpp` 等 | `hotspotcc` 关键字，可手写 Jeandle IR |
| opt 集成 | `llvm/tools/opt/optdriver.cpp` | `-jeandle` 标志触发 `jeandle<O3>` 流水线 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| LLVM 20.1.0 | 核心 | 本仓库即 LLVM 的 fork，在其上添加 Jeandle 扩展 |
| C++17 | 核心 | 全部 Jeandle 代码用 C++ 编写，遵循 LLVM 编码规范 |
| CMake | 核心 | 构建系统，复用 LLVM 的 `add_llvm_component_library` |
| TableGen | 核心 | 生成调用约定（`.td` → `.inc`），X86/AArch64 共用 |
| jeandle-jdk | 可选（运行时） | 提供 Java 运行时与抽象解释器，与本仓库协同完成端到端编译 |

### 版本历史

Jeandle-LLVM 无 release tag，解读基线为 `main` 分支 commit [`65b5a7a98762`](https://github.com/jeandle/jeandle-llvm/commit/65b5a7a98762441db787bbc02478fd6707af5da9)（2025-11-05，开发分支快照）。上游基础是 LLVM 20.1.0 final。Jeandle 的演进以 GitHub PR 驱动，关键里程碑：

- `ca1956b` Introduce Jeandle compiler —— 初始提交，确立 `Hotspot_JIT` 调用约定与 GC 策略
- `ecfd7da9` feat: Support safepoint poll —— 引入 safepoint 轮询、TLS 改写与 `lower-phase` 两阶段降级
- `2536f8389` feat: Initial support for AArch64 —— 扩展到 AArch64 后端
- `65b5a7a9` feat: Insert GC barriers —— 加入 card-table 写屏障


## 快速上手

本仓库是 LLVM fork，构建方式与上游 LLVM 一致。最简方式是用 `opt` 工具跑 Jeandle 流水线验证 IR 变换，无需 jeandle-jdk：

```bash title="构建与验证（最简）"
# 构建（默认只编 X86 后端，与 CI 一致）
mkdir build && cd build
cmake -G "Unix Makefiles" -DLLVM_TARGETS_TO_BUILD=X86 \
      -DCMAKE_BUILD_TYPE=Release -DLLVM_ENABLE_ASSERTIONS=ON ../llvm
make -j$(nproc) opt

# 用 opt 的 -jeandle 标志跑流水线，验证 pass 注册
./bin/opt -S --jeandle --print-pipeline-passes test/Jeandle/opt-option.ll
# 预期输出含：java-operation-lower<phase=0> ... java-operation-lower<phase=1>
#              ... tls-pointer-rewrite ... rewrite-statepoints-for-gc
```

端到端验证（card-table 屏障插入 + 两阶段降级）：

```bash title="验证 GC 屏障与 JavaOp 降级"
./bin/opt -S --passes="-S,java-operation-lower<phase=0>,default<O3>,\
insert-gc-barriers,java-operation-lower<phase=1>" \
  ../llvm/test/Jeandle/lately-use-cross-default-opt.ll
# 预期：phase 0 内联早期 JavaOp → O3 优化 → 插入 card_table_barrier 调用
#        → phase 1 内联 card_table_barrier 并擦除函数定义
```

> 完整端到端（真正编译并执行 Java 方法）需配合 jeandle-jdk，用 `-XX:+UseJeandleCompiler` 启动 HotSpot。详见 jeandle-jdk 仓库。

## 架构设计解析

### 系统架构

Jeandle-LLVM 的设计思想是**最小侵入式扩展**：不 fork 一个独立的 Java 后端，而是把 Java 语义作为一组可组合的 LLVM 扩展叠加上游 LLVM。这些扩展分四层，每层解决一个正交的问题：

- **编译流水线层**解决"按什么顺序跑 pass"——把 Java 语义降级需要的 pass 编排成一条 `jeandle<O3>` 流水线，夹在上游默认 O3 流水线前后。
- **降级变换层**解决"把 Java 语义标记翻译成具体 IR"——JavaOp 模板内联、TLS 基址改写、card-table 屏障插入。
- **GC/IR 基础设施层**解决"让 LLVM 识别哪些是指针、谁管 GC"——`HotspotGC` 策略、地址空间划分、元数据/属性命名、`hotspotcc` IR 文本语法。
- **目标适配层**解决"让后端按 Java 约定生成机器码"——`Hotspot_JIT` 调用约定的寄存器分配、线程寄存器预留、栈帧与调用点对齐。

这样分层的好处是**关注点分离**：GC 策略不关心寄存器分配，降级 pass 不关心后端代码生成，流水线只负责编排。每一层都可以独立测试（`llvm/test/Jeandle/` 下按特性分文件），新增一个 Java 语义扩展通常只动一层。

![Jeandle-LLVM 分层架构](/vibe-reading/images/articles/jeandle-llvm/architecture.svg)

上图展示 Jeandle-LLVM 的四层扩展叠在 LLVM Core 之上。上层依赖下层：流水线层编排降级变换层与 GC 基础设施层的 pass，降级变换层消费 GC 基础设施层定义的地址空间与元数据，目标适配层依据调用约定与属性决定寄存器/栈帧行为。`jeandle-jdk` 通过 `LLVMJeandle` 库的 C++ 接口 `jeandle::optimize()` 调入流水线层。

| 架构层 | 包含目录/文件 | 层职责（为什么这层存在） |
|--------|--------------|------------------------|
| 编译流水线层 | `llvm/lib/Jeandle/`、`llvm/tools/opt/optdriver.cpp`、`llvm/lib/Passes/PassBuilder.cpp` | 编排 pass 顺序，对外暴露 `jeandle::optimize()` 入口与 `opt --jeandle` 选项 |
| 降级变换层 | `llvm/lib/Transforms/Jeandle/` | 把抽象解释器产出的 Java 语义 IR 翻译为具体可执行的 LLVM IR |
| GC/IR 基础设施层 | `llvm/lib/IR/Jeandle/`、`llvm/lib/IR/GCStrategy.cpp`、`llvm/lib/AsmParser/`、`llvm/lib/IR/AsmWriter.cpp` | 定义 GC 策略、地址空间、元数据/属性常量与 IR 文本语法，供上层引用 |
| 目标适配层 | `llvm/lib/Target/X86/`、`llvm/lib/Target/AArch64/`、`llvm/lib/CodeGen/ShrinkWrap.cpp` | 让后端按 Java 调用约定与寄存器约定生成机器码 |
| LLVM Core | `llvm/lib/IR/`、`llvm/lib/CodeGen/`、`llvm/lib/MC/` 等（上游） | 提供标准 IR、CodeGen、MC 基础设施，Jeandle 不改动其核心逻辑 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 策略模式（GC Strategy） | `HotspotGC` in `llvm/lib/IR/Jeandle/GCStrategy.cpp` | 把 Java GC 策略注入 LLVM 的 GC 框架，通过 `GCRegistry` 注册，运行时按 `"hotspotgc"` 名查找，可插拔 |
| 模板方法（两阶段降级） | `JavaOperationLower(Phase)` in `Pipeline.cpp:38,41` | 同一个 pass 类用构造参数 `Phase` 区分执行时机，流水线控制"何时跑"，pass 控制"做什么" |
| 注册表模式 | `GCRegistry::Add<HotspotGC>` in `GCStrategy.cpp:41`、PassBuilder 别名注册 | 通过静态对象构造完成注册，链接进哪个库就启用哪个策略/pass |
| 管道-过滤器（Pass Pipeline） | `buildJeandlePipeline` in `Pipeline.cpp:36` | 6 个 pass 像过滤器串联，Module/Function IR 流经每个 pass 被逐步变换，阶段间数据通过 IR 本身传递 |
| 预留扩展点（属性驱动） | `lower-phase`、`use-compressed-oops` 等属性 in `Attributes.h` | 不改 pass 逻辑，靠函数属性标记驱动行为——jeandle-jdk 抽象解释器只贴属性，jeandle-llvm 按 属性决定内联相位/寄存器预留 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|----------|
| `Pipeline` | Jeandle pass 流水线与各 AnalysisManager 持有者 | 一次 `optimize()` 调用期间 | 持有 `ModulePassManager` 与四个 AnalysisManager，调用 `PassBuilder` |
| `HotspotGC` | Java GC 策略，告诉 LLVM 哪些指针受 GC 管理 | 编译单元内，按 `"hotspotgc"` 名查表 | 实现 `GCStrategy`，被 `RewriteStatepointsForGC` 查询 |
| `JavaOperationLower` | JavaOp 模板函数内联器 | 流水线两次实例化（phase 0/1） | 调 `InlineFunction` 内联，操作 `Module` |
| `TLSPointerRewrite` | TLS 指针基址改写器 | 函数级 pass，每函数一次 | 读 `current_thread` 元数据取线程寄存器，改写 addrspace(2) 指针 |
| `InsertGCBarriers` | Card-table 写屏障插入器 | 函数级 pass，每函数一次 | 检测 addrspace(1) 原子写，插入 `jeandle.card_table_barrier` 调用 |
| `Hotspot_JIT` | Java 调用约定（ID=112） | 编译期，绑定到函数 | 在 `.td` 定义寄存器分配规则，被 X86/AArch64 后端消费 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `llvm::GCStrategy` | `llvm/include/llvm/IR/GCStrategy.h`（上游） | `HotspotGC` | `GCRegistry::Add<HotspotGC> A(JeandleGC, ...)` 静态对象注册 |
| `PassInfoMixin<T>`（pass 基类） | `llvm/include/llvm/IR/PassManager.h`（上游） | `JavaOperationLower`、`TLSPointerRewrite`、`InsertGCBarriers` | `PassBuilder` 解析 `jeandle<O3>` 别名时 `addPass` 加入流水线 |
| `CallingConv`（调用约定枚举） | `llvm/include/llvm/IR/CallingConv.h`（上游） | `Hotspot_JIT = 112` | TableGen `.td` 生成寄存器分配规则，函数标 `hotspotcc` 触发 |

扩展点的契约：jeandle-jdk 抽象解释器产出 IR 时贴属性/元数据（`lower-phase`、`use-compressed-oops`、`java_method_compilation`、`current_thread`、`gc "hotspotgc"`），jeandle-llvm 的 pass 与后端按这些标记决定行为。新增一种 Java 语义降级，通常新增一个 pass + 一组属性常量即可，无需动后端。


## 代码目录

```
llvm/
├── include/llvm/
│   ├── Jeandle/                  # 流水线层头文件
│   │   ├── Jeandle.h             # optimize() 入口声明
│   │   └── Pipeline.h           # Pipeline 类与 buildJeandlePipeline()
│   ├── IR/Jeandle/               # GC/IR 基础设施头文件
│   │   ├── GCStrategy.h         # "hotspotgc" 名与 isJeandleGC()
│   │   ├── Metadata.h           # 元数据名与 AddrSpace 枚举
│   │   └── Attributes.h        # 属性名常量
│   └── Transforms/Jeandle/      # 降级 pass 头文件
│       ├── JavaOperationLower.h # 两阶段 JavaOp 内联
│       ├── TLSPointerRewrite.h  # TLS 指针基址改写
│       └── InsertGCBarriers.h   # card-table 屏障插入
├── lib/
│   ├── Jeandle/                 # 流水线实现
│   │   ├── Jeandle.cpp          # optimize() → Pipeline.run()
│   │   ├── Pipeline.cpp         # buildJeandlePipeline() 6 阶段编排
│   │   └── CMakeLists.txt       # 链 LLVMJeandle 库
│   ├── IR/Jeandle/
│   │   └── GCStrategy.cpp       # HotspotGC 策略实现 + 注册
│   ├── Transforms/Jeandle/      # 三个降级 pass 实现
│   ├── Passes/PassBuilder.cpp   # 注册 "jeandle" 流水线别名
│   ├── AsmParser/               # hotspotcc 关键字词法/语法
│   ├── IR/AsmWriter.cpp         # hotspotcc 文本打印
│   └── Target/{X86,AArch64}/   # 调用约定 .td + 寄存器/栈帧修改
├── tools/opt/optdriver.cpp      # -jeandle 命令行标志
└── test/Jeandle/                # .ll 端到端测试
    ├── opt-option.ll            # 流水线注册验证
    ├── java-operation-lower.ll  # JavaOp 两阶段降级
    ├── thread-local-storage.ll  # TLS 指针改写
    ├── card-table-barrier.ll    # GC 屏障插入
    ├── landingpad-type.ll       # RS4GC landingpad 改 token
    ├── X86/                     # X86 调用约定/栈帧/对齐测试
    └── AArch64/                 # AArch64 调用约定/栈帧测试
```

> Jeandle 专有代码约 750 行集中在上述 17 个文件。其余修改（X86/AArch64 后端、AsmParser、Passes、ShrinkWrap、RS4GC）是在上游文件中插入 `Hotspot_JIT` 分支或 Jeandle 引用，每处改动通常只有几行到几十行。

## 模块地图

![Jeandle-LLVM 模块依赖关系](/vibe-reading/images/articles/jeandle-llvm/module-dependencies.svg)

上图展示五个模块间的依赖方向：**编译流水线**编排一切，依赖三个降级 pass 与 GC 基础设施；降级 pass 依赖 GC 基础设施定义的地址空间/元数据/属性；目标适配层依据调用约定与属性工作，与 GC 基础设施共享 `Hotspot_JIT` 标识；`jeandle-jdk` 通过 `LLVMJeandle` 库接口调用流水线层。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 编译流水线 | 编排 6 阶段 pass，对外暴露 optimize 入口 | `jeandle::optimize()` in `Jeandle.cpp` | 解决"何时跑什么 pass"——其他模块只定义单个 pass 的行为，流水线决定它们协同的顺序与相位 | [编译流水线](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/01-pipeline) |
| GC 基础设施 | 定义 GC 策略、地址空间、元数据/属性常量、IR 文本语法 | `HotspotGC` in `GCStrategy.cpp` | 解决"LLVM 怎么识别 Java 指针与 GC 约定"——纯定义与注册层，不主动变换 IR | [GC 基础设施](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/02-gc-infrastructure) |
| Java 操作降级 | 两阶段内联并擦除 JavaOp 模板函数 | `JavaOperationLower::run()` in `JavaOperationLower.cpp` | 解决"抽象解释器的模板函数怎么变成具体代码"——是 JDK 抽象解释器与优化流水线的关键桥梁，机制最独特 | [Java 操作降级](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/03-java-operation-lower) |
| 运行时降级 | TLS 指针基址改写 + card-table 屏障插入 | `TLSPointerRewrite::run()`、`InsertGCBarriers::run()` | 解决"Java 运行时语义怎么落到具体 IR"——两者都是晚期函数级 pass，把抽象的 addrspace 指针与写操作具体化 | [运行时降级](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/04-runtime-lowering) |
| 调用约定与目标适配 | X86/AArch64 的 Java 寄存器分配、栈帧、对齐 | `CC_X86_64_Hotspot_JIT` in `X86CallingConv.td` | 解决"后端怎么按 Java 约定生成机器码"——与 LLVM 后端代码生成深度耦合，是 Java 与硬件 ABI 的边界 | [调用约定与目标适配](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/05-target-adaptation) |

> 模块间的动态调用顺序见下文「运行时行为 > 核心运行流程」。

## 运行时行为

### 启动流程

Jeandle-LLVM 不是一个独立进程，而是被 jeandle-jdk 作为库加载。一次编译的入口调用链如下：

```
jeandle-jdk: JeandleCompilation::compile()
  → jeandle::optimize(Module*, OptimizationLevel)        // Jeandle.cpp:16
    → Pipeline::Pipeline(Level)                           // Pipeline.cpp:19
      → PassBuilder PB                                     // 构建分析管理器
      → PB.registerModuleAnalyses(MAM)                    // 注册四类 AnalysisManager
      → PB.crossRegisterProxies(LAM,FAM,CGAM,MAM)
      → buildJeandlePipeline(PM, PB, level)               // 装配 6 阶段 pass
    → Pipeline::run(M)                                    // PM.run(M, MAM)
```

对象装配要点：

- **配置来自 Module 自身**：Jeandle 不读外部配置文件。优化级别 `OptimizationLevel` 由调用方（jeandle-jdk）传入，默认 `O3`。Java 语义开关全部编码在 IR 的属性与元数据里（`gc "hotspotgc"`、`use-compressed-oops`、`java_method_compilation`、`current_thread`），pass 按需读取——配置即 IR。
- **AnalysisManager 装配顺序**：`Pipeline` 构造函数先注册 Module/CGSCC/Function/Loop 四类分析，再 `crossRegisterProxies` 让它们互相可达，最后才 `buildJeandlePipeline` 装配 pass。顺序不可交换——pass 可能依赖分析结果。
- **Pass 实例化**：`buildJeandlePipeline` 直接 `PM.addPass(...)` 把 pass 对象加入 `ModulePassManager`。`JavaOperationLower` 用构造参数 `0`/`1` 区分相位，同一类跑两次。函数级 pass（`InsertGCBarriers`、`TLSPointerRewrite`）用 `createModuleToFunctionPassAdaptor` 包装后加入模块流水线。
- **无单例/全局状态**：`Pipeline` 是栈对象，`optimize()` 调用结束即析构。`HotspotGC` 通过 `GCRegistry` 的静态对象在链接期注册，运行时按名查找，不需要显式 `new`。

### 核心运行流程

Jeandle 流水线最核心的运行模式是**6 阶段 pass 流水线**。下面这条链路把一份带 Java 语义标记的 Module 变换为可交给后端代码生成的 LLVM IR。

#### 主链路：Jeandle 编译流水线

业务流程：jeandle-jdk 抽象解释器产出带 JavaOp 模板与 addrspace 标记的 IR → 早期降级内联 JavaOp → LLVM O3 优化 → 插入 GC 屏障 → 晚期降级内联剩余 JavaOp → TLS 指针具体化 → statepoint 重写

![Jeandle 编译流水线](/vibe-reading/images/articles/jeandle-llvm/pipeline.svg)

文字描述：流水线在 `buildJeandlePipeline`（`Pipeline.cpp:36`）中装配为 6 个阶段。**阶段 1** `JavaOperationLower(0)` 扫描带 `lower-phase=0` 属性的 JavaOp 函数，把它们内联到调用点并擦除定义——这是早期降级，把抽象解释器产出的"模板调用"展开成具体 IR，让后续 O3 能看见真实代码做优化。**阶段 2** `PB.buildPerModuleDefaultPipeline(O3)` 跑上游标准 O3 优化（内联、GVN、循环优化等）。**阶段 3** `InsertGCBarriers` 对每个含 `java_method_compilation` 元数据的模块，在 addrspace(1) 原子写后插入 `jeandle.card_table_barrier` 调用。**阶段 4** `JavaOperationLower(1)` 内联 `lower-phase=1` 的 JavaOp（如刚插入的屏障函数），此时屏障逻辑已展开为 `ptrtoint → lshr 9 → getelementptr → store` 的 card 写入。**阶段 5** `TLSPointerRewrite` 把 addrspace(2) 指针改为相对线程寄存器基址的偏移访问。**阶段 6** `RewriteStatepointsForGC` 把 GC 管理指针的调用点改写为 statepoint，并在异常路径上把 landingpad 类型改为 `token`。整个流水线的关键设计是**两阶段降级**：屏障这类运行时逻辑先以模板函数形式插入（阶段 3），让 O3 优化它，再在阶段 4 内联展开——既给了优化器机会又保证了最终代码的具体性。

#### 辅链路：opt 命令行路径

当用 `opt --jeandle` 而非 jeandle-jdk 调用时，路径略有不同：

```
optdriver.cpp: RunJeandle 标志
  → Pipeline = "jeandle<O3>"            // optdriver.cpp:728
  → PassBuilder::parsePassPipeline()
  → 匹配 "jeandle" 别名                  // PassBuilder.cpp:1743
  → jeandle::Pipeline::buildJeandlePipeline()
```

这条路径复用同一套 `buildJeandlePipeline`，区别只在入口：jeandle-jdk 直接调 `jeandle::optimize()`，opt 经 `PassBuilder` 文本解析走别名。两者最终装配的 pass 序列一致，`opt-option.ll` 测试专门验证这条路径的 pass 顺序。


## 典型修改场景

#### 场景 1：新增一个 JavaOp 降级相位

jeandle-jdk 抽象解释器若需要三阶段降级（而非两阶段），需修改：
- `llvm/include/llvm/IR/Jeandle/Attributes.h`：`LowerPhase` 常量不变（属性名通用）
- `llvm/lib/Jeandle/Pipeline.cpp` 的 `buildJeandlePipeline`：在合适位置 `PM.addPass(JavaOperationLower(2))` 插入第三次调用
- jeandle-jdk 侧：JavaOp 函数标 `lower-phase=2` 属性
- 对应测试：在 `llvm/test/Jeandle/java-operation-lower.ll` 加三阶段用例

#### 场景 2：新增一种 GC 屏障

若 Java GC 需要新的写屏障（如引用计数屏障），需修改：
- `llvm/lib/Transforms/Jeandle/InsertGCBarriers.cpp` 的 `run()`：在 `isJavaHeapStore` 之外或之内插入新屏障调用，或在 `java-operation-lower<phase=1>` 跑之前由 jeandle-jdk 贴一个 phase=1 的屏障模板函数
- jeandle-jdk 侧：声明对应的屏障模板函数并标 `lower-phase=1`
- 对应测试：`llvm/test/Jeandle/card-table-barrier.ll`（card-table 屏障的范式）

#### 场景 3：适配新架构后端（如 RISC-V）

若要支持 RISC-V，需修改：
- `llvm/lib/Target/RISCV/`：新增 `CC_RISCV_Hotspot_JIT` 调用约定（参考 `X86CallingConv.td:1060` 的 `CC_X86_64_Hotspot_JIT`），定义 Java 寄存器传参顺序
- `llvm/lib/Target/RISCV/RISCVRegisterInfo.cpp`：预留线程寄存器与 compressed-oops 基址寄存器（参考 `X86RegisterInfo.cpp:661` 预留 R15/R12）
- `llvm/lib/Target/RISCV/RISCVFrameLowering.cpp`：保证栈帧可解栈（参考 `X86FrameLowering.cpp:3189` 强制保存 RBP）
- `llvm/include/llvm/IR/CallingConv.h`：复用 `Hotspot_JIT = 112`
- CI：`.github/workflows/jeandle-llvm-test.yml` 已支持按 `RISC-V` label 开启 target（`HAS_RISCV` 分支）
- 对应测试：`llvm/test/Jeandle/AArch64/calling-conv.ll` 的范式，新建 `llvm/test/Jeandle/RISCV/`

## 测试体系

```
llvm/test/Jeandle/
├── opt-option.ll              # 流水线 pass 顺序验证
├── java-operation-lower.ll     # JavaOp 两阶段降级
├── thread-local-storage.ll     # TLS 指针改写
├── card-table-barrier.ll      # GC 屏障插入
├── lately-use-cross-default-opt.ll  # 跨 default<O3> 的 llvm.used 处理
├── landingpad-type.ll         # RS4GC landingpad 改 token
├── X86/
│   ├── calling-conv.ll        # X86 Hotspot_JIT 寄存器传参
│   ├── frame-pointer.ll       # X86 栈帧（pushq %rbp + CFI）
│   └── call-site-align.ll     # statepoint 调用点 4 字节对齐
└── AArch64/
    ├── calling-conv.ll        # AArch64 Hotspot_JIT 寄存器传参
    └── frame-pointer.ll       # AArch64 栈帧（保存 LR/FP）
```

| 代码层 | 测试文件 | 验证方式 |
|--------|---------|---------|
| 流水线层 | `opt-option.ll` | `opt --jeandle --print-pipeline-passes` 核对 pass 序列 |
| 降级变换层 | `java-operation-lower.ll`、`thread-local-storage.ll`、`card-table-barrier.ll` | `opt -S --passes=...` + `FileCheck` 核对 IR 变换前后 |
| GC 基础设施层 | `landingpad-type.ll` | `opt -S --passes=rewrite-statepoints-for-gc` 核对 landingpad 类型 |
| 目标适配层 | `X86/*.ll`、`AArch64/*.ll` | `llc -mtriple=...` + `FileCheck` 核对生成的汇编寄存器/对齐 |

测试均为 LLVM `lit` 驱动的 `.ll` 端到端测试，用 `FileCheck` 断言。CI 默认只编 `X86`，`AArch64`/`RISC-V` 靠 PR label 触发（见 `jeandle-llvm-test.yml`）。理解某个 pass 的行为，优先读其对应的 `.ll` 测试——它们是最直接的"可执行文档"。

## 阅读源码推荐路线

- 第一遍：理解流水线编排
  `llvm/lib/Jeandle/Jeandle.cpp` 的 `optimize()` → `llvm/lib/Jeandle/Pipeline.cpp` 的 `buildJeandlePipeline()`（6 阶段一目了然）→ `llvm/lib/Passes/PassBuilder.cpp:1743` 的 `jeandle` 别名注册
- 第二遍：理解 JavaOp 两阶段降级机制
  `llvm/include/llvm/Transforms/Jeandle/JavaOperationLower.h`（Phase 构造参数）→ `llvm/lib/Transforms/Jeandle/JavaOperationLower.cpp` 的 `runImpl()`（`shouldInline` + `InlineFunction`）→ `llvm/test/Jeandle/java-operation-lower.ll`（看调用树降级前后对比）
- 第三遍：理解 GC 与运行时降级
  `llvm/lib/IR/Jeandle/GCStrategy.cpp`（`HotspotGC` 的 `isGCManagedPointer`）→ `llvm/lib/Transforms/Jeandle/InsertGCBarriers.cpp`（card-table 屏障）→ `llvm/lib/Transforms/Jeandle/TLSPointerRewrite.cpp`（TLS 基址改写）→ `llvm/test/Jeandle/card-table-barrier.ll` 与 `thread-local-storage.ll`
- 第四遍：理解后端适配
  `llvm/include/llvm/IR/CallingConv.h:277`（`Hotspot_JIT = 112`）→ `llvm/lib/Target/X86/X86CallingConv.td:1060`（`CC_X86_64_Hotspot_JIT` 寄存器顺序）→ `llvm/lib/Target/X86/X86RegisterInfo.cpp:661`（预留 R15/R12）→ `llvm/lib/Target/X86/X86MCInstLower.cpp:800`（调用点对齐）

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| JavaOp | jeandle-jdk 抽象解释器产出的模板函数，用 `lower-phase` 属性标记，在流水线特定相位被内联展开 |
| statepoint | LLVM 的 GC 安全点机制，把含 GC 管理指针的调用点改写为可在 GC 移动对象后更新指针的形式 |
| RS4GC | Rewrite Statepoints For GC，LLVM 上游 pass，把隐式 statepoint 改写为显式 statepoint + relocate |
| card-table | 分代 GC 的写屏障数据结构，按卡片（card）记录堆中跨代引用，写堆时标记对应卡 |
| compressed oops | HotSpot 的压缩指针优化，用 32 位偏移 + 基址寄存器（rheapbase）表示 64 位堆指针 |
| hotspotcc | Jeandle 在 LLVM IR 文本里标记 Java 调用约定的关键字，对应 `CallingConv::Hotspot_JIT` |
| addrspace(1)/addrspace(2) | Jeandle 用 LLVM 地址空间区分指针来源：1=Java 堆，2=线程局部存储，0=C 堆 |

### 参考资料

- [Jeandle-LLVM 仓库](https://github.com/jeandle/jeandle-llvm)（本仓库）
- [jeandle-jdk 仓库](https://github.com/jeandle/jeandle-jdk)（OpenJDK 侧，含抽象解释器与运行时）
- [LLVM Statepoint 文档](https://llvm.org/docs/Statepoints.html)（statepoint 与 RS4GC 机制）
- [LLVM GCStrategy 文档](https://llvm.org/docs/GarbageCollection.html)（GC 策略框架）
- Jeandle-JDK CodeWiki：[jeandle-jdk 源码解读](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main/00-overview)（OpenJDK 侧的五层 JIT 流水线）

### 工具推荐

- `opt --jeandle --print-pipeline-passes`：打印完整 pass 序列，验证流水线装配
- `opt -S --passes=... -debug-only=java-operation-lower`：开启 JavaOp 降级的 debug 输出，追踪内联过程
- `llc -mtriple=x86_64-linux-gnu`：把 Jeandle IR 编为汇编，核对寄存器分配与调用约定
