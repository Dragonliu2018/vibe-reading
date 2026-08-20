---
source:
  type: "源码解读"
  project: "LLVM"
  url: "https://github.com/llvm/llvm-project"
title: "Overview"
date: "2026-08-20T10:23:42+08:00"
category: ["Languages", "C/C++", "Tools", "LLVM", "CodeWiki", "24"]
tags: ["LLVM", "C++", "编译器", "IR", "CodeGen", "TableGen"]
description: "LLVM 24 编译器基础设施核心架构解读——从 IR 到目标代码的完整流水线"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** LLVM 24 · **协议** Apache-2.0 with LLVM Exception · **语言** C++20 · **代码量** ~348 万行（llvm 核心）· **仓库** [GitHub](https://github.com/llvm/llvm-project) · **解读基线** commit [`1c794fbafafe`](https://github.com/llvm/llvm-project/commit/1c794fbafafe)（2026-08-20，LLVM 24 开发主干，基于 `llvmorg-24-init` 之后 5093 个 commit）

---

## 总览

### 项目简介

LLVM 是一套**编译器基础设施（compiler infrastructure）**——不是一个单一的编译器，而是一组可复用的库与工具，用来"构造"高度优化的编译器、优化器和运行时环境。README 一句话定义：*"a toolkit for the construction of highly optimized compilers, optimizers, and run-time environments"*。

它解决的核心问题是：**把"源语言→目标机器"的编译过程标准化为一条以 LLVM IR 为中枢的流水线**。任何前端（Clang 处理 C/C++、Flang 处理 Fortran、前端把源码翻译成 LLVM IR）都共享同一套中端优化（Transforms）和后端代码生成（CodeGen），而同一套后端又能输出 ELF/MachO/COFF 等多种对象格式、支持 x86/ARM/RISC-V/AMDGPU 等 30+ 架构。这种"多前端共享中端、多后端共享框架"的设计，让新增一种语言或一种架构的成本从"重写整个编译器"降到"只写差量"。

**项目边界**：本文聚焦 llvm-project monorepo 中的 **LLVM 核心**（`llvm/` 子目录）——即 IR、Pass 管理、优化器、CodeGen、Target 描述、MC 层这些"编译器本体"。Clang 前端、LLD 链接器、LLDB 调试器、libc++ 标准库等是 monorepo 中的独立子项目，它们**消费** LLVM 核心但不属于其内部架构，本文只在顶层上下文中提及。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| LLVM IR 文本/二进制读写 | `lib/AsmParser`、`lib/Bitcode`、`lib/IRReader` | `.ll` 文本与 `.bc` bitcode 双格式 |
| 中端优化流水线 | `lib/Passes`、`lib/Transforms` | 新 Pass Manager + 200+ 优化 pass |
| 指令选择 | `lib/CodeGen/SelectionDAG`、`lib/CodeGen/GlobalISel` | DAG 模式匹配 + 新 GlobalISel |
| 寄存器分配 | `lib/CodeGen/RegAlloc*.cpp` | Greedy / Fast / PBQP 三策略 |
| 目标描述代码生成 | `lib/Target`、`lib/TableGen`、`utils/TableGen` | TableGen DSL → .inc 自动生成 |
| 汇编/反汇编 | `lib/MC` | MCStreamer 发射、MCDisassembler 反汇编 |
| 入口工具 | `tools/opt`、`tools/llc`、`tools/lli`、`tools/llvm-mc` | 优化器/后端编译器/JIT/汇编器 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C++20 | 核心语言 | 全项目实现语言，禁用异常与 RTTI（`-fno-exceptions -fno-rtti`） |
| CMake ≥ 3.20 | 构建 | monorepo 统一构建系统，TableGen 集成 |
| TableGen | 内部 DSL | 声明式描述指令集/寄存器/选择 pattern，生成 .inc |
| Python | 可选 | 测试脚本、`llvm-lit` 测试驱动 |
| Ninja / Make | 可选 | 构建后端 |

---

## 快速上手

最快验证"LLVM 跑起来了"——用 `opt` 跑一个优化 pass，再用 `llc` 把 IR 编成汇编。

```bash title="构建（最小化）"
cmake -S llvm -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_ENABLE_PROJECTS="" \
  -DLLVM_TARGETS_TO_BUILD="X86"
cmake --build build --target opt llc llvm-as
```

```bash title="端到端验证：IR → 优化 → 汇编"
# 1. 写一段 IR
cat > add.ll <<'EOF'
define i32 @add(i32 %a, i32 %b) {
  %r = add i32 %a, %b
  ret i32 %r
}
EOF

# 2. opt 跑指令化简 + CFG 化简
./build/bin/opt -passes=instcombine,simplifycfg add.ll -S -o add.opt.ll

# 3. llc 把 IR 编成 x86 汇编
./build/bin/llc add.opt.ll -mtriple=x86_64 -o add.s

# 预期：add.s 含 lea/mov 指令实现 %r = %a + %b
```

---

## 架构设计解析

### 系统架构

LLVM 的整体架构是一条**以 IR 为中枢的编译流水线**，设计思想是"统一中间表示 + 可复用阶段"。前端的多样性（C/C++/Fortran/Rust…）被 IR 收敛到同一种表示，后端的多样性（x86/ARM/RISC-V…）被"目标无关的 CodeGen 框架 + 目标具体的 TableGen 描述"吸收。这样每一层都可以独立替换：换前端不影响中后端，换后端只加一个 `lib/Target/<Arch>/` 目录，换对象格式只换 MCStreamer 子类。

整条流水线分五层（自上而下），外加纵向贯穿的基础设施：

![LLVM 编译流水线分层架构](/vibe-reading/images/articles/llvm-internals/architecture.svg)

数据自上而下流动：前端把源码变成 LLVM IR；IR 层持有 `Module`/`Function`/`Instruction` 数据模型；中端（`opt`）通过 Pass Manager 调度 Transforms 优化 IR；后端（`llc`/CodeGen）把 IR 翻译成 `MachineInstr`、做寄存器分配与调度；MC 层把机器指令编码并装配成对象文件。右侧的 Support/ADT 基础设施（SmallVector、StringRef、APInt、DenseMap、Error、raw_ostream）被所有层依赖——它是 LLVM 代码风格与内存效率的基石。目录到层的映射：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|------------------------|
| 前端层 | `clang/`、`flang/`（monorepo，本文不展开） | 把源码解析成 LLVM IR，隔离语言差异 |
| IR 层 | `llvm/lib/IR`、`lib/AsmParser`、`lib/Bitcode`、`lib/IRReader` | 提供编译器通用中间语言，是前后端的契约 |
| 中端层 | `llvm/lib/Passes`、`lib/Analysis`、`lib/Transforms` | 把 IR 变优，是编译器优化能力的主体 |
| 后端层 | `llvm/lib/CodeGen`、`lib/Target` | IR→机器指令，是目标相关的代码生成 |
| 机器码层 | `llvm/lib/MC` | 汇编/反汇编/对象文件，是发射出口 |
| 基础设施 | `llvm/lib/Support`、`include/llvm/ADT` | 数据结构与工具库，纵向贯穿 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 类型擦除 Concept+Model | `PassConcept`/`PassModel` in `llvm/IR/PassManagerInternal.h:42,108` | 让 `PassManager` 用 `vector<unique_ptr<PassConcept>>` 持有异构 pass，不用 vtable（PIC 重定位开销） |
| CRTP Mixin | `PassInfoMixin<DerivedT>` in `llvm/IR/PassManager.h:89` | 编译期为 pass 提供 `name()`/`ID()`，零运行时多态开销 |
| Visitor（InstVisitor） | `llvm/IR/InstVisitor.h:78` | pass 按指令类型分发，CRTP 生成 switch 替代虚函数 |
| Flyweight/Singleton | Type/Constant 单例 in `llvm/lib/IR/LLVMContextImpl.h:1673` | 类型相等性退化为指针比较，O(1) |
| 声明式代码生成 | `Target.td` + `llvm-tblgen` → `.inc` | 声明一次指令，自动生成选择器/编码器/汇编器 |
| Strategy | `RegAllocBase` 三策略 in `llvm/CodeGen/RegAllocBase.h:63` | 寄存器分配算法可替换（Greedy/Fast/PBQP） |
| Stream/Template Method | `MCStreamer` in `llvm/MC/MCStreamer.h:222` | 同一 CodeGen 代码既输出 `.s` 又输出 `.o` |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `Module` | 一个编译单元，持有全部全局对象 | 编译期，由 `LLVMContext` 拥有 | 持有 `Function`/`GlobalVariable`/`NamedMD` |
| `Function` | 一个函数，持有 `BasicBlock` | `Module` 拥有 | 持有 `Argument`/`BasicBlock` |
| `BasicBlock` | 一个基本块，持有 `Instruction` | `Function` 拥有 | ilist 节点，知其 parent |
| `Instruction` | 一条 IR 指令 | `BasicBlock` 拥有 | 继承 `User`，持 `Use` 操作数链 |
| `Value` | 所有值的单根基类 | — | `User`/`BasicBlock`/`Argument` 的公共祖先 |
| `MachineFunction` | 机器级函数 | `MCContext`/MMI 关联 | 持有 `MachineBasicBlock`、`MachineRegisterInfo` |
| `MachineInstr` | 一条机器指令 | `MachineFunction` 池式分配 | 持 `MCInstrDesc`（TableGen 生成） |
| `MCInst` | 编码用纯指令 | `MCContext` 分配 | AsmPrinter 把 `MachineInstr` 降级为此 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|---------|--------|---------|
| `SelectionDAGISel` | `llvm/CodeGen/SelectionDAGISel.h:45` | `X86DAGToDAGISel` 等 | 各后端子类，`#include GenDAGISel.inc` |
| `TargetLowering` | `llvm/CodeGen/TargetLowering.h:218` | `X86TargetLowering` 等 | `setOperationAction` 配置合法化表 |
| `TargetMachine` | `llvm/Target/TargetMachine.h:84` | `X86TargetMachine` 等 | `RegisterTarget` 静态注册 |
| `RegAllocBase` | `llvm/CodeGen/RegAllocBase.h:63` | `RAGreedy`/`RegAllocFast`/`RegAllocPBQP` | `RegisterRegAlloc` + `cl::opt` 选择 |
| `MCStreamer` | `llvm/MC/MCStreamer.h:222` | `MCELFStreamer`/`MCMachOStreamer`/`MCAsmStreamer` | `createMCObjectStreamer` 工厂 |

---

## 代码目录

LLVM 核心（`llvm/`）的关键目录：

```shell
llvm/
├── lib/                  # 实现库（按子系统分目录）
│   ├── IR/               # LLVM IR 数据模型（Module/Function/Instructions...）
│   ├── AsmParser/        # .ll 文本解析器（LLParser）
│   ├── Bitcode/          # .bc 二进制读写
│   ├── IRReader/         # 统一读取入口（自动判断 .ll/.bc）
│   ├── Support/          # 基础设施（Error/raw_ostream/内存...）
│   ├── Analysis/         # 分析 pass（AA/ScalarEvolution/DominatorTree...）
│   ├── Passes/           # 新 Pass Manager（PassBuilder/PassRegistry.def）
│   ├── Transforms/       # 中端优化 pass（Scalar/IPO/Vectorize/InstCombine...）
│   ├── CodeGen/          # 后端框架（SelectionDAG/GlobalISel/RegAlloc...）
│   ├── Target/           # 30+ 目标后端（X86/AArch64/RISCV/AMDGPU...）
│   ├── MC/               # 机器码层（MCStreamer/MCAssembler/MCDisassembler）
│   └── TableGen/         # TableGen 库
├── include/llvm/         # 公共头文件（结构与 lib/ 对称）
│   ├── ADT/              # 抽象数据类型（SmallVector/StringRef/APInt/DenseMap/ilist）
│   ├── IR/               # IR 公共接口
│   └── ...
├── tools/                # 可执行入口
│   ├── opt/              # 中端优化器（IR→IR）
│   ├── llc/              # 后端编译器（IR→目标代码）
│   ├── lli/              # JIT/解释器
│   ├── llvm-as/          # .ll→.bc 汇编器
│   ├── llvm-dis/         # .bc→.ll 反汇编器
│   └── llvm-mc/          # 独立汇编器
├── utils/TableGen/       # TableGen 编译器（.td→.inc）
└── test/                 # 测试（llvm-lit 驱动）
```

---

## 模块地图

LLVM 核心按职责分化为 7 个模块，单层结构（不强制分层）。模块间依赖关系如下：

![LLVM 核心模块依赖关系](/vibe-reading/images/articles/llvm-internals/module-dependencies.svg)

依赖方向：箭头 A→B 表示 A 依赖 B。`Support/ADT` 是地基（被所有模块 include，扇入最高）；`IR` 是中枢（被中后端共同操作）；`Pass 管理与分析` 为 Transforms/CodeGen 提供 pass 调度与分析查询；`CodeGen` 依赖 `Target` 查询目标信息、依赖 `MC` 发射机器码；`Target` 经 TableGen 描述目标、为 `MC` 提供目标描述。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| IR 中间表示 | 编译器通用中间语言数据模型与读写 | `parseIR` in `lib/IRReader/IRReader.cpp:68` | 是前后端的契约，单独存在才能"多前端共享中后端" | [IR 中间表示](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/01-ir) |
| Support 与 ADT | 基础数据结构与工具库 | `SmallVector`/`StringRef`/`Error` 头文件 | 扇入最高、是代码风格基石，独立成库控制 ABI | [Support 与 ADT](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/02-support-adt) |
| Pass 管理与分析 | pass 调度框架与分析缓存 | `PassBuilder::parsePassPipeline` in `lib/Passes/PassBuilder.cpp:2714` | 决定"按什么顺序跑哪些 pass"，是优化器的引擎 | [Pass 管理与分析](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/03-pass-analysis) |
| Transforms 优化 | 中端优化 pass 集合 | `InstCombinePass`/`LoopVectorizePass` in `lib/Transforms/` | 是"优化能力"主体，与调度框架分离利于 pass 独立演进 | [Transforms 中端优化](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/04-transforms) |
| CodeGen 后端 | IR→机器指令的代码生成 | `SelectionDAGISel::runOnMachineFunction` in `lib/CodeGen/SelectionDAG/SelectionDAGISel.cpp:605` | 目标无关的后端框架，与目标具体描述（Target）分离 | [CodeGen 后端](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/05-codegen) |
| Target 目标描述 | 目标架构抽象与后端 | `Target.td` + `RegisterTarget` in `lib/Target/X86/TargetInfo/` | 用 TableGen 描述目标，是"加一个架构只加一个目录"的关键 | [Target 目标描述](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/06-target) |
| MC 机器码层 | 汇编/反汇编/对象文件 | `MCStreamer::emitInstruction` in `llvm/MC/MCStreamer.h:500` | 是 CodeGen 的发射出口 + 反汇编工具基础，解耦目标与对象格式 | [MC 机器码层](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/07-mc) |

> 模块间的动态调用顺序见运行时行为 > 核心运行流程。

---

## 运行时行为

### 启动流程

`llc`（后端编译器）的启动与对象装配，从 `main()` 出发（`tools/llc/llc.cpp:371`）：

```
main()                                                          [llc.cpp:371]
├─ InitializeAllTargets() / InitializeAllAsmPrinters()         # 静态注册的 Target 进链表
├─ cl::ParseCommandLineOptions()                                # 解析 -mtriple/-mcpu/-O 等
└─ compileModule()                                              [llc.cpp:498]
   ├─ parseIRFile() → unique_ptr<Module>                       [IRReader.cpp:95]
   │     └─ isBitcode()? → BitcodeReader / : LLParser            # 统一读取入口
   ├─ TargetRegistry::lookupTarget(Triple) → Target*            [llc.cpp:643]
   ├─ Target->createTargetMachine(Triple, CPU, Features, ...)  [llc.cpp:651]
   │     → X86TargetMachine（子类，注入 DataLayout/MCAsmInfo 等）
   ├─ new MachineModuleInfoWrapperPass(Target)                   [llc.cpp:787]
   │     └─ 内部构造 MCContext（共享于整个后端管线）
   ├─ Target->addPassesToEmitFile(PM, OS, FileType, ...)        [CodeGenTargetMachineImpl.cpp:232]
   │     ├─ addPassesToGenerateCode()                           [CodeGenTargetMachineImpl.cpp:117]
   │     │     └─ TM.createPassConfig(PM) → TargetPassConfig*   # 目标 pass 流水线配置
   │     └─ addAsmPrinter() + createMCStreamer()                [CodeGenTargetMachineImpl.cpp:145,167]
   └─ PM.run(*M)                                                [llc.cpp:884]
```

**对象装配**：`TargetMachine` 由 `Target::createTargetMachine` 工厂创建（注入 Triple/CPU/Features），它持有 `MCAsmInfo`/`MCRegisterInfo`/`MCInstrInfo`/`MCSubtargetInfo`（TableGen 生成）；`MachineModuleInfo` 持有 `MCContext`，作为 IR 层与 MC 层的桥梁对象，传给 `MCStreamer`/`AsmPrinter`/`MCAssembler` 共享。后端 pass 通过 `TargetPassConfig` 的虚函数钩子（`addPreISel`/`addPreRegAlloc`/`addPreEmitPass`）注入目标特定 pass。

### 核心运行流程

LLVM 有两条主链路：`opt`（中端，IR→优化后 IR）和 `llc`（后端，IR→目标代码）。下面分别展开。

#### 中端优化：opt 主链路

`opt` 的核心是 `PassBuilder` 把文本管线（`-passes="default<O2>"` 或 `"instcombine,simplifycfg"`）解析成 `ModulePassManager` pass 树，再 `run` 起来。

```
opt main() → optMain()                                          [tools/opt/optdriver.cpp:402]
  ├─ parseIRFile() → Module                                      [optdriver.cpp:595]
  ├─ PassBuilder PB(TM, PTO, PGOOpt, &PIC)                      [NewPMDriver.cpp:460]
  ├─ PB.registerModuleAnalyses(MAM) / registerFunctionAnalyses(FAM)  # 注册分析
  ├─ PB.crossRegisterProxies(LAM,FAM,CGAM,MAM)                  # 各级 AM 互查代理
  ├─ PB.parsePassPipeline(MPM, PassPipeline)                     [NewPMDriver.cpp:506]
  │     → buildPerModuleDefaultPipeline(O2) 等                   # 默认管线
  └─ MPM.run(M, MAM)                                             [NewPMDriver.cpp:579]
       → 逐 pass 执行：Pass.run(IR,AM) → AM.invalidate(IR, PA)  # 每个 pass 后精确失效分析
```

`opt` 不创建 MCStreamer/AsmPrinter，输出始终是 IR（`.ll`/`.bc`）。pass 通过 `AM.getResult<DominatorTreeAnalysis>(F)` 等查询分析，pass 返回 `PreservedAnalyses` 声明保留哪些分析，避免下游重复计算支配树等昂贵分析。

#### 后端编译：llc 主链路

`llc` 把 IR 编成目标代码，数据类型沿流水线逐级变换：

![LLVM 端到端编译数据流](/vibe-reading/images/articles/llvm-internals/data-flow.svg)

文字描述：`TargetPassConfig` 驱动后端 pass 序列——`addIRPasses`（IR 级准备）→ `addCoreISelPasses`（指令选择：SelectionDAG 经 Combine→LegalizeTypes→LegalizeVectors→Legalize→Select 多轮，或 GlobalISel 经 IRTranslator→Legalizer→RegBankSelect→InstructionSelect 四步），把 `Module`/`Function` 变成 `MachineFunction`/`MachineInstr`（SSA 虚拟寄存器）。随后 `addMachinePasses`：`addMachineSSAOptimization`（MachineLICM/CSE/Peephole）→ `addOptimizedRegAlloc`（LiveIntervals 计算→Greedy 分配→VirtRegRewriter 把 vreg 换成物理寄存器）→ PrologEpilog 插入 → PostRA 调度 → BlockPlacement。最后 `addAsmPrinter` 创建 `MCStreamer`，`AsmPrinter::emitFunctionBody`（`AsmPrinter.cpp:2050`）遍历 `MachineInstr`，经 `X86MCInstLower::Lower`（`lib/Target/X86/X86MCInstLower.cpp:406`）降级成 `MCInst`，`MCStreamer::emitInstruction` → `MCObjectStreamer::emitInstToData`（`MCObjectStreamer.cpp:451`）用 `MCCodeEmitter` 编码成字节存入 `MCFragment`。所有指令发射完后 `MCAssembler::Finish`（`MCAssembler.cpp:801`）做 `layout`（含 relaxation 迭代收敛）→ `writeObject` 写出对象文件。

#### 状态流

LLVM 后端用 `MachineFunctionProperties`（`MachineFunction.h:188`）建模机器级 IR 的状态契约——不是显式状态机，而是 pass 间的状态门：

| 状态属性 | 含义 | 谁设置/要求 |
|---------|------|------------|
| `IsSSA` | 处于 SSA 形态（含 PHI） | 指令选择后设，PHI 消除前要求 |
| `NoPHIs` | 已消除 PHI | PHI Elimination pass 设置 |
| `TracksLiveness` | 已计算 liveness | LiveIntervals 后设置 |
| `Legalized` | 类型/操作已合法化 | Legalizer pass 设置（`Legalizer.h:65` 要求 `IsSSA`） |
| `RegBankSelected` | 已分配寄存器 bank | RegBankSelect 设置 |
| `Selected` | 已选定目标指令 | InstructionSelect 设置 |
| `FailedRegAlloc` | 寄存器分配失败 | 供 fallback |

每个 pass 声明 required/set/cleared properties，框架据此保证 pass 执行顺序正确（如 `Legalizer` 要求 `IsSSA`、设置 `Legalized`）。GlobalISel 失败时（`FailedISel`）可 fallback 到 SelectionDAG 路径。

---

## 典型修改场景

#### 场景 1：新增一个 Scalar 优化 pass

- 新建 `include/llvm/Transforms/Scalar/MyPass.h`，类继承 `OptionalPassInfoMixin<MyPass>`，实现 `PreservedAnalyses run(Function &F, FunctionAnalysisManager &AM)`
- `lib/Passes/PassRegistry.def` 加 `FUNCTION_PASS("my-pass", MyPass())`（一处注册，名字验证/实例化/打印共用）
- `lib/Passes/PassBuilderPipelines.cpp` 在 `buildFunctionPipeline` 序列中插入 `FPM.addPass(MyPass())` 加入默认管线
- 对应测试：`llvm/test/Transforms/MyPass/`

#### 场景 2：新增一个目标后端骨架

- `lib/Target/Foo/Foo.td`：`def Foo : Target { let InstructionSet = FooInstrInfo; }`
- `lib/Target/Foo/TargetInfo/FooTargetInfo.cpp`：调用 `RegisterTarget<Triple::foo>(getTheFooTarget(), "foo", ...)`（参考 `X86TargetInfo.cpp:23`）
- `FooISelLowering.cpp`：继承 `TargetLowering`，构造函数中 `setOperationAction` 配置合法化表
- `FooISelDAGToDAG.cpp`：继承 `SelectionDAGISel`，`#include "FooGenDAGISel.inc"`，`Select` 回退到 `SelectCode`
- 对应测试：`llvm/test/CodeGen/Foo/`

#### 场景 3：给某后端加一条指令的指令选择 pattern

- `lib/Target/X86/X86InstrInfo.td` 定义新 `Instruction`，`Pattern = [(set R32:$dst, (add R32:$src1, R32:$src2))]`
- 重新构建时 `llvm-tblgen -gen-dag-isel` 自动重新生成 `X86GenDAGISel.inc`（无需改 TableGen 工具）
- 若需 C++ 辅助匹配，定义 `ComplexPattern` 并实现 `selectXxx` 函数（`X86ISelDAGToDAG.cpp`）
- 对应测试：`llvm/test/CodeGen/X86/`

> 扩展点的契约定义见架构设计解析 > 核心抽象。

---

## 测试体系

```
llvm/test/
├── Transforms/      # 中端 pass 测试（按 pass 子目录）
├── CodeGen/         # 后端测试（按目标架构子目录）
├── MC/              # MC 层汇编/反汇编测试
├── Bitcode/         # bitcode 兼容性测试
├── Feature/         # 端到端特性测试
└── Analysis/        # 分析 pass 测试
```

| 代码层 | 测试类型 | 形式 |
|--------|---------|------|
| Transforms | FileCheck | `.ll` 输入 + `; CHECK:` 验证优化后 IR |
| CodeGen | FileCheck | `.ll` + `-mtriple` 验证生成的汇编/指令 |
| MC | FileCheck | `llvm-mc` 汇编/反汇编往返验证 |
| Bitcode | 往返 | `.bc` 跨版本读写兼容性 |

`llvm-lit` 驱动所有测试。理解某个 pass 优先读 `llvm/test/Transforms/<Pass>/` 的用例——它们是该 pass 的"可执行文档"。

---

## 阅读源码推荐路线

- **第一遍：理解 IR 数据模型**
  `llvm/include/llvm/IR/Value.h` 的 `Value`（use-list）→ `User.h`（操作数）→ `Instruction.h` + `Instructions.h`（具体指令）→ `Module.h`（顶层容器）。理解"Value→User→Instruction"的单根继承树与 `Use` 双向链表。
- **第二遍：理解一次中端优化**
  `tools/opt/opt.cpp` 的 `main` → `NewPMDriver.cpp:runPassPipeline` → `lib/Passes/PassBuilder.cpp:2714` 的 `parsePassPipeline` → `PassManager.h:184` 的 `PassManager::run`（看 pass 如何调度、`PreservedAnalyses` 如何失效分析）→ 任选一个 pass 如 `lib/Transforms/InstCombine/InstructionCombining.cpp:6257` 的 `InstCombinePass::run`。
- **第三遍：理解后端代码生成**
  `tools/llc/llc.cpp` 的 `compileModule` → `CodeGenTargetMachineImpl.cpp:117` 的 `addPassesToGenerateCode` → `TargetPassConfig.cpp:991` 的 `addCoreISelPasses` → `SelectionDAGISel.cpp:605` 的 `runOnMachineFunction` → `SelectionDAGISel.cpp:947` 的 `CodeGenAndEmitDAG`（Combine→Legalize→Select 多轮）。
- **第四遍：理解目标描述与发射**
  `include/llvm/Target/Target.td`（TableGen DSL 根）→ `lib/Target/X86/X86.td`（一个具体后端）→ `X86ISelDAGToDAG.cpp` 的 `Select` → `AsmPrinter.cpp:2050` 的 `emitFunctionBody` → `MCObjectStreamer.cpp:451` 的 `emitInstToData` → `MCAssembler.cpp:801` 的 `Finish`（layout+relaxation）。

---

## 附录

**术语表**：

- **IR**：Intermediate Representation，LLVM 中间表示，分文本（`.ll`）与二进制（`.bc` bitcode）两种格式
- **Pass**：编译流水线的一个变换步骤，输入 IR 输出 IR，声明保留哪些分析（`PreservedAnalyses`）
- **SelectionDAG**：基于 DAG 的指令选择框架，把 IR 翻译成目标指令
- **GlobalISel**：新的指令选择框架，直接在 MachineInstr 上操作，可增量、快速
- **Legalization（合法化）**：把目标不支持的操作/类型转成支持的，分 Promote/Expand/Custom 等动作
- **TableGen**：LLVM 的声明式 DSL，描述指令集/寄存器/选择 pattern，由 `llvm-tblgen` 编译成 `.inc` C++ 代码
- **MC 层**：Machine Code 层，汇编/反汇编/对象文件发射
- **Relaxation**：变长指令布局迭代收敛，先假设最短编码再按目标距离放大

**参考资料**：

- [LLVM 官方文档](https://llvm.org/docs/)（GettingStarted / WritingAnLLVMPass / WritingAnLLVMBackend / NewPassManager）
- LLVM 源码内注释（如 `PassManagerInternal.h:38` 对类型擦除的设计说明、`MCStreamer.h:212` 对流式接口的语义说明）
