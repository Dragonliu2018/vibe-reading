---
source:
  type: "源码解读"
  project: "Jeandle-JDK"
  url: "https://github.com/jeandle/jeandle-jdk"
title: "Overview"
date: "2026-08-19T17:50:32+08:00"
category: [Languages, Java, Jeandle-JDK, CodeWiki, "main-2025-12"]
tags: ["Jeandle", "Java", "JIT", "LLVM", "OpenJDK"]
description: "基于 OpenJDK 与 LLVM 的 Java JIT 编译器 Jeandle 源码解读"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** main-2025-12 · **解读基线** commit [`4793dc28a4b`](https://github.com/jeandle/jeandle-jdk/commit/4793dc28a4b76f5fd4584e05bce8f20aa9ff1b76)（2025-12-07，开发分支快照，无 release tag）· **协议** GPL v2（OpenJDK）· **语言** C++（HotSpot 风格）· **代码量** ~5,900 行（Jeandle 专有）· **仓库** [GitHub](https://github.com/jeandle/jeandle-jdk)

---

## 总览

### 项目简介

Jeandle 是一个面向 Java 的 **Just-in-Time（JIT）编译器**，构建在 OpenJDK 之上，借助 **LLVM** 编译基础设施生成机器码，目标是提供强大的编译优化能力并输出高性能的本地代码。它作为 HotSpot 虚拟机的第三套 JIT 后端存在（与 C1、C2 并列），通过 `-XX:+UseJeandleCompiler` 启用：`CompileBroker` 在启动时调用 `JeandleCompiler::create()` 将其注册为 `_compilers[1]`，运行期把解释执行热点过的方法派发给 Jeandle 编译。

Jeandle 的核心定位是**用 LLVM 生态替代 HotSpot 自研的机器码生成后端**：运行时以 Java 字节码为输入，经抽象解释器翻译成 LLVM IR，交给 jeandle-llvm 的优化与代码生成流水线产出 ELF 目标文件，再解析重定位并装入 HotSpot 的 Code Cache。其核心价值在于——复用 LLVM 成熟的多后端（X86/AArch64）、标准优化 pass 与 statepoint GC 基础设施，让 JVM 后端站在 LLVM 生态之上。

**项目当前边界**：Jeandle 仍是 work-in-progress。它负责把可解析的 Java 方法编译为本地代码并装入 Code Cache；**不负责**分层编译调度（由 `CompileBroker` 统一）、解释执行（由模板解释器负责）、以及尚未实现的 deoptimization / on-stack replacement（OSR）。`JeandleCompilation` 构造函数显式拒绝 OSR：`if (entry_bci != InvocationEntryBci) env->record_method_not_compilable("OSR not supported")`。源码中大量 `// TODO: Uncommon trap`、`// TODO: deoptimize_caller_frame` 标注了未完成的回退路径。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| JIT 编译入口 | `jeandleCompiler.cpp` | 继承 `AbstractCompiler`，`compile_method` 派发单次编译 |
| 编译上下文与编排 | `jeandleCompilation.cpp` | RAII 对象，装配 CI 环境 → 翻译 → 优化 → 发射 → 装载 |
| 字节码→LLVM IR | `jeandleAbstractInterpreter.cpp` | 逐基本块抽象解释，IRBuilder 生成 IR + Phi 合并 |
| 基本块构建 | `jeandleAbstractInterpreter.hpp` | `BasicBlockBuilder` 构块、连控制流、标循环 |
| JVM 状态追踪 | `jeandleAbstractInterpreter.hpp` | `JeandleVMState` 模拟操作数栈/局部变量/锁 |
| IR 优化 | `jeandleCompilation.cpp` | `llvm::jeandle::optimize` O3 + statepoint RS4GC |
| 代码生成 | `jeandleCompilation.cpp` | `compile_module` 经 `addPassesToEmitMC` 发射 ELF |
| ELF 解析与装载 | `jeandleCompiledCode.cpp` | `ReadELF` 取段、JITLink 重定位、`OopMap`、异常表 |
| 运行时例程 | `jeandleRuntimeRoutine.cpp` | C/汇编/Hotspot 例程，编译期生成桩 |
| VM 调用桩 | `jeandleCallVM.cpp` | 包装 C 函数调用，维护 `last_Java_sp` |
| 模板 JavaOp | `templatemodule/jeandleRuntimeDefinedJavaOps.cpp` | `current_thread`/`safepoint_poll`/GC 屏障等内联 IR 模板 |
| 类型映射 | `jeandleType.cpp` | `java2llvm` 把 `BasicType` 映射到 LLVM `Type` |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| OpenJDK（HotSpot） | 核心 | 宿主 JVM，提供 `ciEnv`/`ciMethod`/`CompileBroker`/`CodeCache`/`AbstractCompiler` |
| LLVM（jeandle-llvm 分支） | 核心 | IR/IRBuilder、`jeandle::optimize`、`addPassesToEmitMC`、JITLink、StackMap、statepoint GC |
| C++（HotSpot 风格） | 语言 | 全部 Jeandle 专有代码 |
| GNU make | 构建 | OpenJDK 标准 `configure` + `make images` |

---

## 快速上手

Jeandle 由 [jeandle-llvm](https://github.com/jeandle/jeandle-llvm) 与 [jeandle-jdk](https://github.com/jeandle/jeandle-jdk) 两个仓库组成，需分别构建，配置时用 `--with-jeandle-llvm=<目录>` 指定 LLVM 安装路径。最小验证用例（来自官方 getting-started）：

```bash title="构建（精简）"
# 1) 构建 jeandle-llvm
cd jeandle-llvm && mkdir build && cd build
cmake -G "Unix Makefiles" -DLLVM_TARGETS_TO_BUILD=X86 \
      -DCMAKE_BUILD_TYPE="Release" \
      -DCMAKE_INSTALL_PREFIX="$HOME/jeandle-llvm-install" \
      -DLLVM_BUILD_LLVM_DYLIB=On -DLLVM_DYLIB_COMPONENTS=all ../llvm
cmake --build . --target install --parallel

# 2) 配置并构建 jeandle-jdk
cd /path/to/jeandle-jdk
bash configure --with-boot-jdk=/path/to/jdk-21 \
               --with-debug-level=release \
               --with-jeandle-llvm=$HOME/jeandle-llvm-install
make images
```

端到端验证——跳过解释、强制编译 `fibonacci` 并启用 Jeandle：

```bash title="运行验证"
javac Main.java
java -XX:-TieredCompilation -Xcomp \
     -XX:CompileCommand=compileonly,Main::fibonacci \
     -XX:+UseJeandleCompiler Main
# 预期输出：0 1 1 2 3 5 8 13 21 34
```

> 内部装配链路（模板模块初始化、例程桩生成等）见「运行时行为 > 启动流程」。

---

## 架构设计解析

### 系统架构

Jeandle 的架构思想是**把 JVM 后端嫁接到 LLVM 流水线上**。HotSpot 已有成熟的编译调度（`CompileBroker`）、CI 抽象（`ciEnv`/`ciMethod`，屏蔽了运行时与编译期的差异）、Code Cache 管理与 GC；Jeandle 不重造这些轮子，而是作为一个"翻译器 + 装载器"插入其中：前端用抽象解释器把字节码翻成 LLVM IR，后端把 LLVM 产出的 ELF 解析、重定位后塞进 Code Cache。这样分层把"语言语义"（Jeandle 自己管）与"机器码生成/GC"（交给 LLVM）彻底解耦——Jeandle 只需正确表达 Java 语义，优化与寄存器分配由 LLVM 世代积累的能力承担。

![Jeandle 分层架构](/vibe-reading/images/articles/jeandle-jdk/architecture.svg)

五层自上而下构成编译流水线，依赖方向单向向下，每一层只与相邻层及外部 LLVM 交互：

- **调度层**（青）：`CompileBroker` 从任务队列取编译任务，按 `-XX:+UseJeandleCompiler` 调 `JeandleCompiler::compile_method`。Jeandle 自身不参与调度。
- **编译驱动层**（蓝）：`JeandleCompilation` 以 RAII 对象承载单次编译的全部上下文（CI 环境、arena、LLVMContext/Module、`JeandleCompiledCode`），在构造函数里串起"装配→翻译→优化→发射→装载"。`JeandleCompiler` 还在 `initialize` 阶段一次性生成所有运行时例程桩并加载模板 bitcode。
- **前端层**（粉）：抽象解释器把字节码流切成基本块，逐块模拟 JVM 栈帧（`JeandleVMState`），用 `IRBuilder` 生成 LLVM IR，并在基本块边界合并 Phi 节点构造 SSA。
- **后端层**（黄）：`JeandleCompiledCode` 接收 LLVM 发射的 ELF，用 `ReadELF` 定位段，经 JITLink 解析重定位、从 StackMap 还原 `OopMap`、构造异常表，最终把指令与元数据装入 `CodeBuffer`。
- **运行时支持层**（紫）：定义编译期生成的运行时例程（`JeandleRuntimeRoutine`，C/汇编/Hotspot 三类）、VM 调用桩（`JeandleCallVM`）与模板内联 IR（`RuntimeDefinedJavaOps`，如 safepoint 轮询、card table 屏障）。这些是编译产物在运行期回访 JVM 的契约。

右侧虚线框是外部 `jeandle-llvm`：IR 构造、O3 优化（含 statepoint RS4GC 重写）、MC 发射、JITLink/StackMap 解析均由其提供。Jeandle-jdk 仓库只包含上述五层中 Jeandle 专有的约 5,900 行代码。

| 架构层 | 包含目录/文件 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 调度层 | `src/hotspot/share/compiler/compileBroker.cpp` | 统一编译调度，Jeandle 作为可插拔后端 |
| 编译驱动层 | `jeandleCompiler.cpp` · `jeandleCompilation.cpp` · `jeandleUtils.cpp` | 装配编译上下文，编排流水线，对接 CI 与 Code Cache |
| 前端层 | `jeandleAbstractInterpreter.cpp/.hpp` | 把 Java 字节码语义表达为 LLVM IR |
| 后端层 | `jeandleCompiledCode.cpp` · `jeandleReadELF.cpp` · `jeandleAssembler.cpp` · `jeandleCompiledCall.hpp` · `jeandleExceptionHandlerTable.cpp` | 把 LLVM 产物解析重定位后装入 JVM Code Cache |
| 运行时支持层 | `jeandleRuntimeRoutine.cpp` · `jeandleCallVM.cpp` · `templatemodule/jeandleRuntimeDefinedJavaOps.cpp` | 编译期生成运行期回访 JVM 的例程/桩/模板 IR |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| RAII 编译上下文 | `JeandleCompilation` 构造函数 in `jeandleCompilation.cpp` | 栈对象构造即完成整条编译链，析构自动回收 arena 资源，调用方 `compile_method` 一行搞定 |
| X-Macro 例程表 | `ALL_JEANDLE_C_ROUTINES`/`ALL_HOTSPOT_ROUTINES` in `jeandleRuntimeRoutine.hpp` | 一张宏表同时生成 LLVM callee 声明、stub 编译、地址注册，三类处理共享单一真源，避免漂移 |
| 模板方法 + 钩子 | `interpret_block` 的 `switch(code)` in `jeandleAbstractInterpreter.cpp` | 主循环固定（取块→遍历字节码→接后继），各字节码处理为独立钩子方法，新增字节码只加 `case` |
| 依赖注入（CI 环境） | `JeandleCompilation::initialize` 设 `compiler_data`/`oop_recorder`/`debug_info` | 编译对象把 `ciEnv` 注入自身，模块内函数用 `JeandleCompilation::current()` 取当前上下文，避免参数穿透 |
| 策略（调用类型） | `JeandleCompiledCall::Type` in `jeandleCompiledCall.hpp` | STATIC/DYNAMIC/ROUTINE/STUB_C 四种调用各有不同桩与重定位策略，`emit_reloc` 内 `switch` 分派 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `JeandleCompilation` | 单次编译上下文 | 一次 `compile_method` 调用（栈对象） | 持有 `JeandleCompiledCode`、`llvm::Module`、`ciEnv` |
| `JeandleAbstractInterpreter` | 字节码→IR 翻译器 | 编译内（栈对象） | 持有 `BasicBlockBuilder`、`JeandleVMState`、`IRBuilder` |
| `JeandleVMState` | 抽象栈帧（操作数栈/局部变量/锁） | 基本块级，可 copy/合并 | 包含 `SmallVector<TypedValue>` 栈与局部 |
| `JeandleBasicBlock` | 字节码基本块 + 对应 LLVM block | 编译内（arena） | 持有前驱/后继集、`JeandleVMState`、header/tail LLVM block |
| `JeandleCompiledCode` | 编译产物容器 | 编译内 | 持有 ELF 对象、`CodeBuffer`、call site 表、OopMap |
| `CallSiteInfo` | 单个调用点元信息 | 编译内 | 记录类型/目标/bci/statepoint_id，供重定位匹配 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `AbstractCompiler` | OpenJDK `compiler/abstractCompiler.hpp` | `JeandleCompiler` | `CompileBroker` 启动期 `_compilers[1] = JeandleCompiler::create()` |
| `ExceptionHandlerTableInterface` | OpenJDK `code/exceptionHandlerTable.hpp` | `JeandleExceptionHandlerTable` | `JeandleCompiledCode` 持有，`finalize` 时 `copy_to` 进 nmethod |
| `JeandleCompiledCall::Type`（枚举契约） | `jeandleCompiledCall.hpp` | （无子类，策略分派） | 抽象解释器在 `invoke` 按字节码决定类型 |

---

## 代码目录

Jeandle 专有代码集中在 `src/hotspot/share/jeandle/`，是 OpenJDK 源码树的一个子目录：

```
src/hotspot/share/jeandle/
├── jeandleCompiler.cpp/.hpp          # 编译器入口（AbstractCompiler 子类）
├── jeandleCompilation.cpp/.hpp        # 编译上下文与流水线编排
├── jeandleAbstractInterpreter.cpp/.hpp  # 字节码→LLVM IR（核心，~2600 行）
├── jeandleCompiledCode.cpp/.hpp       # ELF 解析/重定位/装载
├── jeandleRuntimeRoutine.cpp/.hpp     # 运行时例程（C/汇编/Hotspot）
├── jeandleCallVM.cpp/.hpp            # VM 调用桩生成
├── jeandleReadELF.cpp/.hpp           # ELF 段/符号查找
├── jeandleAssembler.cpp/.hpp         # 指令/重定位发射到 CodeBuffer（CPU 相关分派在 .cpp）
├── jeandleExceptionHandlerTable.cpp/.hpp  # 异常处理表
├── jeandleType.cpp/.hpp              # Java↔LLVM 类型映射 + TypedValue
├── jeandleUtils.cpp/.hpp             # JeandleFuncSig（方法命名/函数签名）
├── jeandleCompiledCall.hpp           # 调用类型枚举与桩尺寸契约
├── jeandleRegister.hpp               # CPU 相关寄存器抽象（include CPU_HEADER）
├── jeandleResourceObj.cpp/.hpp       # arena 分配基类
├── jeandle_globals.hpp               # JVM flag 声明（JeandleDumpIR 等）
├── __llvmHeadersBegin__.hpp / __hotspotHeadersBegin__.hpp  # 头文件包含顺序隔离
└── templatemodule/
    └── jeandleRuntimeDefinedJavaOps.cpp/.hpp  # 模板内联 IR（current_thread/safepoint/屏障）
```

> 两个 `__*HeadersBegin__.hpp` 是包含顺序隔离器：Jeandle 代码同时引用 LLVM 与 HotSpot 两套头文件，二者宏/类型会冲突，故用这两个文件划定"先 LLVM 后 HotSpot"的边界，所有 `.cpp` 顶部先 include `__llvmHeadersBegin__.hpp` 再 include LLVM 头，中间夹 `__hotspotHeadersBegin__.hpp` 切回 HotSpot。`jeandleRegister.hpp` 用 `CPU_HEADER(jeandleRegister)` 把寄存器抽象按 CPU 分派到 `cpu/x86/` 或 `cpu/aarch64/`。

---

## 模块地图

![Jeandle 模块依赖关系](/vibe-reading/images/articles/jeandle-jdk/module-dependencies.svg)

依赖方向以编译驱动层为枢纽：`CompileBroker` 创建并调用编译驱动；驱动向下串起抽象解释器与代码生成，自身在 `initialize` 阶段生成运行时例程；前端与后端都回访运行时例程（解释器生成对例程/JavaOp 的调用，代码生成在重定位时解析例程调用目标）。`JeandleType`/`TypedValue` 是横切的类型映射，被前端、驱动、后端共用。右侧 `jeandle-llvm` 与 `Code Cache` 是外部依赖——LLVM 提供 IR/优化/发射能力，Code Cache 是最终装载目的地。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 编译驱动 | 装配上下文、编排流水线、对接 CI 与 Code Cache | `JeandleCompiler::compile_method` | 编排者角色——不产出 IR 也不解析 ELF，只把两者串起来并管生命周期 | [编译驱动](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main-2025-12/01-compilation-driver) |
| 抽象解释器 | 字节码→LLVM IR，模拟栈帧构造 SSA | `JeandleAbstractInterpreter` 构造 | 承载全部 Java 语义表达，是项目最大最复杂的 god 模块（~2600 行） | [抽象解释器](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main-2025-12/02-abstract-interpreter) · [VM 状态与 SSA](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main-2025-12/02-abstract-interpreter-vm-state-ssa) |
| 代码生成 | 解析 LLVM 产出的 ELF，重定位/构造 OopMap/异常表并装载 | `JeandleCompiledCode::finalize` | 把 LLVM 二进制产物翻译回 JVM 能理解的 CodeBuffer 元数据，是 LLVM 与 JVM 的接合部 | [代码生成](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main-2025-12/03-code-generation) |
| 运行时例程 | 编译期生成运行期回访 JVM 的例程/桩/模板 IR | `JeandleRuntimeRoutine::generate` | 定义编译产物与 JVM 运行时的契约——离开它，编译出的代码无法 safepoint、无法 GC、无法分配 | [运行时例程](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main-2025-12/04-runtime-routines) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

JVM 启动时 `CompileBroker` 初始化编译器，触发 `JeandleCompiler` 的初始化（`should_perform_init` 守卫保证只跑一次）。这一阶段完成三件事：解析 LLVM 命令行选项、生成全部运行时例程桩、加载模板 bitcode。

```text title="启动期初始化调用链"
JeandleCompiler::create()                              # 构造 LLVM TargetMachine (PIC/Small/Aggressive/JIT)
  └─ CompileBroker::_compilers[1] = JeandleCompiler::create()   # in compileBroker.cpp:651

JeandleCompiler::initialize()                          # in jeandleCompiler.cpp:67
  ├─ initialize_commandline_options()                  # 注册 implicit null check + page size
  ├─ JeandleRuntimeRoutine::generate(target_machine, data_layout)  # 编译所有例程桩 + 注册 Hotspot 例程
  │    ├─ ALL_JEANDLE_C_ROUTINES(GEN_C_ROUTINE_STUB)  # 每个 C 函数经 JeandleCompilation 编一个 stub
  │    ├─ ALL_JEANDLE_ASSEMBLY_ROUTINES(...)          # 汇编例程（exceptional_return/exception_handler）
  │    └─ ALL_HOTSPOT_ROUTINES(REGISTER_HOTSPOT_ROUTINE)  # 直接登记 SharedRuntime/StubRoutines 地址
  └─ initialize_template_buffer()                      # 解析模板 IR 文件 → RuntimeDefinedJavaOps::define_all → 序列化 bitcode
       └─ _template_buffer = SmallVectorMemoryBuffer   # 全局只读，多线程编译共享，保证线程安全
```

对象装配的关键决策：**模板模块序列化为 bitcode 全局只读缓冲**（`initialize_template_buffer`）。模板 `.ll` 文件在启动期被解析、注入 `RuntimeDefinedJavaOps::define_all` 定义的 `jeandle.current_thread`/`jeandle.safepoint_poll` 等 JavaOp 与全局常量，再 `WriteBitcodeToFile` 成 `SmallVectorMemoryBuffer`。此后每次方法编译都从这个只读缓冲 `parseBitcodeFile` 出一个独立 Module——避免重复解析 IR 文本、且保证多线程编译互不干扰。运行时例程桩则在启动期一次性编译好，`_routine_entry` 字典登记入口地址供编译期与重定位期查询。

### 核心运行流程

Jeandle 的运行期行为本质是**单条方法编译流水线**，由 `JeandleCompilation` 构造函数驱动。下面这条主链路覆盖了"从编译任务到装入 Code Cache"的完整过程；运行时例程调用、异常分发等子链路见对应模块文档。

![Jeandle 编译数据流](/vibe-reading/images/articles/jeandle-jdk/data-flow.svg)

文字描述：`compile_method` 用 `ResourceMark` 标记资源作用域后构造栈上 `JeandleCompilation` 对象，其构造函数即为完整编译链。先 `initialize` 把 `ciEnv` 的 `compiler_data`/`oop_recorder`/`debug_info` 装配到自身（依赖注入），`setup_llvm_module` 从全局 bitcode 缓冲解析出独立 Module 并设 DataLayout、挂 `JavaMethodCompilation` 元数据。随后 `compile_java_method` 先用 `check_can_parse` 前置剔除不可编译方法（native/abstract/流分析失败等），再构造 `JeandleAbstractInterpreter`——其构造函数内完成全部字节码→IR 翻译（构块、建 `JeandleVMState`、RPO 工作表遍历、逐字节码 `switch` 生成 IR、Phi 合并）。翻译产物经 `verifyModule` 校验后交给 `llvm::jeandle::optimize(O3)`——这是 jeandle-llvm 的定制优化器，在标准 pass 之外跑 statepoint RS4GC 重写（为 GC 在调用点插入驻留点）。`compile_module` 经 `addPassesToEmitMC` 把优化后 IR 发射为 ELF 二进制。最后 `_code.finalize()` 用 `ReadELF` 定位 `.text`/`.llvm_stackmaps`/`.gcc_except_table`/`.llvm_faultmaps` 等段，经 JITLink 解析重定位、从 StackMap 还原 `OopMap`、构造异常表与隐式异常表，把指令与元数据写入 `CodeBuffer`，由 `install_code` → `register_method` 装入 Code Cache 生成 nmethod。

#### 编译期：方法编译主链路

如上 SVG 与文字所述，这是 Jeandle 唯一的核心运行模式。`JeandleCompilation` 还提供第二个构造函数，用于在启动期把单个 C/汇编例程编译成 `RuntimeStub`（见「运行时例程」模块）。

#### 运行期：编译产物回访 JVM

编译装入 Code Cache 的 nmethod 在运行期会回访运行时支持层：循环回跳处插入的 `jeandle.safepoint_poll` 轮询 TLS poll word 触发 safepoint；对象分配走 `jeandle.new_instance` JavaOp→`new_instance` 例程→`InstanceKlass::allocate_instance`；`invoke` 生成的调用点经重定位装配为 static/dynamic stub，由 `SharedRuntime` 解析目标；`monitorenter`/`monitorexit` 经 `SharedRuntime::complete_monitor_locking_C` 完成。GC 则依赖 statepoint 在调用点驻留的 StackMap 记录重建 `OopMap`。

---

## 典型修改场景

#### 场景 1：新增一种字节码的内联 intrinsic

需修改 `jeandleAbstractInterpreter.cpp` 的 `inline_intrinsic`（`switch(target->intrinsic_id())` 加 `case`），通常生成一条 `llvm::Intrinsic` 调用。参考已有的 `_dabs`/`_iabs`/`_dsin` 实现。对应测试：`test/jtreg/compiler/jeandle/`。

#### 场景 2：新增一个运行时例程（C 函数）

需改三处共享同一 X-Macro 真源：在 `jeandleRuntimeRoutine.hpp` 的 `ALL_JEANDLE_C_ROUTINES` 宏表加一行 `def(name, return_type, arg_types...)`；在 `jeandleRuntimeRoutine.cpp` 实现 `JRT_ENTRY` 函数体；在抽象解释器中用 `call_jeandle_routine(name_callee(_module), args, CallingConv::Hotspot_JIT)` 调用。X-Macro 会自动为其生成 callee 声明与 stub 编译。对应测试：`test_check_can_parse.sh` 与 `TEST_CHECK_CAN_PARSE.md`。

#### 场景 3：新增一个模板 JavaOp（内联 IR 模板）

需在 `templatemodule/jeandleRuntimeDefinedJavaOps.cpp` 用 `DEF_JAVA_OP(name, phase, return_type, args...)` 宏定义函数体（用 IRBuilder 写 IR），并在 `define_all` 中调用 `define_##name`。模板在启动期注入全局 bitcode，编译期由 `call_java_op("jeandle.name", args)` 调用。参考 `define_safepoint_poll`/`define_card_table_barrier`。注意 `lower-phase` 属性决定 jeandle-llvm 在哪个 lowering 阶段展开它。

---

## 测试体系

Jeandle 的测试在仓库根的 `test/` 与若干 `.md`/`.sh` 文档中：

```
test/
└── jtreg/compiler/jeandle/   # JTreg 测试，验证编译产物行为正确性
```

| 文档/脚本 | 类型 | 用途 |
| --- | --- | --- |
| `CHECK_CAN_PARSE_PRINCIPLE.md` / `CHECK_CAN_PARSE_DETAILED_EXPLANATION.md` | 设计文档 | 阐述 `check_can_parse` 的判定原则 |
| `test_check_can_parse.sh` / `TEST_CHECK_CAN_PARSE.md` | 可执行测试 | 验证哪些方法应被判定为不可编译 |
| `HOTSPOT_VS_JEANDLE_COMPARISON.md` | 对照 | HotSpot C2 与 Jeandle 的机制对比 |
| `JAVA_TEST_SUMMARY.md` | 汇总 | 已支持/未支持的 Java 特性矩阵 |

`check_can_parse` 本身是很好的"可执行规格"——它列出了 Jeandle 当前编译能力的边界（native/abstract/不平衡 monitor/流分析失败的方法一律不编），修改编译能力时优先同步更新它与其测试。

---

## 阅读源码推荐路线

- 第一遍：理解编译主链路
  `jeandleCompiler.cpp` 的 `compile_method` → `jeandleCompilation.cpp` 的构造函数与 `compile_java_method` → `compile_module` → `install_code`。这条路径让你看清一次编译如何被串起。
- 第二遍：理解前端如何把字节码变成 IR
  `jeandleAbstractInterpreter.cpp` 的 `interpret`/`interpret_block`（主循环与 `switch`）→ `BasicBlockBuilder::generate_blocks`/`setup_control_flow`/`mark_loops`（构块）→ `JeandleVMState` 的 push/pop/load/store（栈帧模拟）。
- 第三遍：理解 SSA 与状态合并（最微妙的部分）
  `JeandleBasicBlock::merge_VM_state_from` 与 `initialize_VM_state_from` → `JeandleVMState::update_phi_nodes` → 留意 `_initial_jvm` 在循环头的作用。配读 [VM 状态与 SSA 深度解读](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main-2025-12/02-abstract-interpreter-vm-state-ssa)。
- 第四遍：理解后端如何把 ELF 装回 JVM
  `jeandleCompiledCode.cpp` 的 `finalize` → `resolve_reloc_info`（JITLink 重定位 + StackMap→OopMap）→ `build_exception_handler_table`/`build_implicit_exception_table` → `jeandleReadELF.cpp` 的 `findFunc`/`findSection`。
- 第五遍：选择运行时支持深入
  `jeandleRuntimeRoutine.hpp` 的三张 X-Macro 表（看清例程全貌）→ `jeandleRuntimeRoutine.cpp` 的 `generate` 与若干 `JRT_ENTRY` → `jeandleCallVM.cpp` 的 `generate_call_VM` → `templatemodule/jeandleRuntimeDefinedJavaOps.cpp` 的 `define_safepoint_poll`。

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| CI（Compiler Interface） | HotSpot 编译接口，`ciEnv`/`ciMethod` 屏蔽运行时与编译期差异 |
| Code Cache | HotSpot 存放编译后 nmethod 的全局代码缓存 |
| nmethod | Code Cache 中的编译方法单元（CompiledMethod 子类） |
| statepoint / RS4GC | LLVM 的 GC 驻留点机制，在调用点记录足够信息让 GC 移动对象 |
| StackMap | LLVM 记录运行时栈帧位置的数据，Jeandle 用来还原 `OopMap` |
| JavaOp | Jeandle 模板模块中预定义的内联 IR 函数（`jeandle.*`），由 jeandle-llvm 在 lowering 期展开 |
| OopMap | 记录栈帧中 oop（对象指针）位置，供 GC 扫描根 |
| OSR | On-Stack Replacement，栈上替换（Jeandle 暂不支持） |
| RPO | Reverse Post-Order，逆后序，基本块遍历顺序 |

### 参考资料

- Jeandle 官方文档：`jeandle-docs/system-design.md`、`getting-started.md`、`jeandle-flags.md`
- LLVM statepoint：[GarbageCollection](https://llvm.org/docs/GarbageCollection.html)、[Statepoints](https://llvm.org/docs/Statepoints.html)
- JVM 规范字节码：[JVMS §7](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-7.html)（`interpret_block` 的 switch 即按此组织）
