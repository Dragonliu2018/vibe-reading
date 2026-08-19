---
source:
  type: "源码解读"
  project: "OpenJDK"
  url: "https://github.com/openjdk/jdk"
title: "Overview"
date: "2026-08-19T23:29:36+08:00"
category: [Languages, Java, OpenJDK, CodeWiki, "28+11"]
tags: ["OpenJDK", "HotSpot", "JVM", "C++", "JIT", "C2", "GC"]
description: "OpenJDK HotSpot 虚拟机执行引擎源码解读——类加载、模板解释器、分层 JIT 编译（C1/C2）、对象模型与内存管理"
readingTime: "34 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** jdk-28+11 · **解读基线** commit [`90f142d6`](https://github.com/openjdk/jdk/commit/90f142d65372d2d0f0460b790404dda297336972)（master HEAD，2026-08-19，较 tag `jdk-28+11` 领先 71 commits）· **协议** GPL-2.0 + Classpath Exception · **语言** C++（HotSpot）· **代码量** ~98.6 万行（`src/hotspot/share/`）· **仓库** [GitHub](https://github.com/openjdk/jdk)

---

## 总览

### 项目简介

OpenJDK 是 Java 平台的参考实现，而 **HotSpot** 是其中的高性能虚拟机。一份 Java 源码经 `javac` 编译成字节码后，交给 HotSpot 执行：HotSpot 负责**加载类、解释或编译执行字节码、管理堆内存与对象生命周期、调度线程与同步**。它是一个用 C++ 写成的、与具体操作系统和 CPU 架构解耦的运行时引擎。

HotSpot 的核心价值在于**自适应优化**：程序启动时以解释器快速跑起来（零预热），运行期通过 profiling 识别热点方法，交由 JIT 编译器（C1/C2）逐级编译为本地机器码；当推测优化所依赖的假设被打破时，又能安全地反优化（deoptimization）回退到解释器。这使得 Java 在长期运行后能达到甚至超过提前编译（AOT）语言的峰值性能。

**项目当前边界**：本解读聚焦 HotSpot 的**执行引擎主线**——VM 生命周期与线程、对象模型、类加载、字节码解释、分层 JIT 编译（C1/C2 编译框架与 Sea-of-Nodes 优化器）、内存管理基础设施。**不覆盖**：GC 算法实现（G1/ZGC/Serial/Parallel/Shenandoah，是独立的 20 万行主题）、Java 标准库（`src/java.*/`）、工具链（`javac`/`jshell`/`jlink` 等，位于 `src/jdk.*/`）。GC 仅在内存模块中涉及堆与分配器的抽象基类。

### 功能矩阵

| 特性 | 实现目录 | 说明 |
| --- | --- | --- |
| VM 生命周期与线程 | `share/runtime/` | `Threads::create_vm` 启动；`JavaThread`/`VMThread` 线程模型；Safepoint 协作停止 |
| 对象表示 | `share/oops/` | Oop/Klass 二级模型；`markWord` 对象头；vtable/itable 多继承分发 |
| 类加载 | `share/classfile/` | `ClassFileParser` 解析；双亲委派；并行加载与循环检测；字节码验证 |
| 字节码解释 | `share/interpreter/` | `TemplateInterpreter` 模板解释器；dispatch 表；`LinkResolver` 符号解析 |
| 编译调度 | `share/compiler/` | `CompileBroker` 编译队列；`CompilationPolicy` 分层策略 |
| 编译接口 | `share/ci/` | `ciEnv`/`ciMethod` 适配 VM 给 JIT，隔离 GC 安全问题 |
| 代码缓存 | `share/code/` | `CodeCache` 分区存放 `nmethod`；`Dependencies` 推测优化依赖 |
| C2 优化器 | `share/opto/` | Sea-of-Nodes IR；Type lattice；逃逸分析；图着色寄存器分配 |
| C1 客户端编译器 | `share/c1/` | 线性 HIR/LIR；线性扫描寄存器分配；分层编译的 tier 1-3 |
| 内存基础设施 | `share/memory/` | `Universe` 全局；`Metaspace` 元数据区；`Arena` bump-pointer 分配 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++ | 核心 | HotSpot 全部实现（无 C++ 虚函数于对象头，见对象模型） |
| GNU make + `configure` | 构建 | OpenJDK 标准构建系统，`make images` 产出 JDK 镜像 |
| 平台汇编 | 核心 | `cpu/<arch>/` 下的模板解释器与 stub（x86/aarch64/arm/ppc/riscv/s390/zero） |
| ADLC | 工具 | `share/adlc/` 机器描述语言编译器，生成 C2 的 Matcher 规则表 |

---

## 快速上手

构建 OpenJDK 最简步骤（来自 `doc/building.md`）：

```bash title="构建（精简）"
git clone https://git.openjdk.org/jdk
cd jdk
bash configure            # 检测工具链、boot JDK、依赖
make images               # 构建出 build/<config>/images/jdk
```

端到端验证——确认构建出的 JVM 可运行，并观察分层编译行为：

```bash title="运行验证"
./build/*/images/jdk/bin/java -version
# 预期输出：openjdk version "28" ... (2026)

# 观察一个方法从解释到 JIT 的全过程
./build/*/images/jdk/bin/java -XX:+PrintCompilation -cp . Main
# 预期：先看到方法在 tier 3 (C1) 编译，热点后升到 tier 4 (C2)
```

> 内部启动链路（`Threads::create_vm` 装配各子系统）见「运行时行为 > 启动流程」。

---

## 架构设计解析

### 系统架构

HotSpot 执行引擎的架构思想是**分层解耦 + 适配器隔离**：底层是与平台相关的原始能力（CPU 指令、OS 线程），上层是语言无关的执行语义（字节码、类型、对象），中间靠抽象基类和适配接口（`ci`、`CollectedHeap`、`BarrierSet`）把"与 VM 内部耦合"和"与机器耦合"分别挡在两侧，使 JIT 编译器只面对稳定的 `ci*` 接口、GC 算法只实现 `CollectedHeap`/`BarrierSet` 的纯虚方法。

![HotSpot 分层架构](/vibe-reading/images/articles/openjdk-hotspot/architecture.svg)

自上而下分五层。**接口/入口层**（`prims`、`JavaCalls`）把外部 Java/native 调用接入 VM；**执行引擎层**（`interpreter`、`compiler`、`opto`）是核心——解释器负责冷启动，编译框架调度 C1/C2 产出机器码；**运行时层**（`runtime`、`classfile`）管理线程、锁、类加载等运行期状态；**内存/对象层**（`oops`、`memory`、`gc/shared`）定义对象表示与分配回收抽象；**平台适配层**（`cpu/`、`os/`、`os_cpu/`）屏蔽硬件与操作系统差异。依赖方向自上而下，上层依赖下层。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接口/入口层 | `prims/`、`runtime/javaCalls*` | 隔离 JNI/JVMTI 等外部协议，把调用转成内部入口，保护核心不受协议变化影响 |
| 执行引擎层 | `interpreter/`、`compiler/`、`c1/`、`opto/` | 把字节码变成可执行机器码，解释器管冷启动、编译器管峰值性能 |
| 运行时层 | `runtime/`、`classfile/` | 管理线程生命周期、safepoint、锁、类加载——执行所依赖的运行期状态 |
| 内存/对象层 | `oops/`、`memory/`、`gc/shared/` | 定义对象内存表示与堆/元空间/分配抽象，是所有模块的共同基础 |
| 平台适配层 | `cpu/`、`os/`、`os_cpu/` | 适配 CPU 指令与 OS 原语，让上层一份代码跑在多平台 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 适配器（Adapter） | `ci::ciEnv`/`ciMethod` (`ci/ciEnv.cpp`) | 隔离 JIT 与 VM 内部，编译器只见 `ci*` 接口，规避 GC 移动对象的安全问题，支持多前端（C1/C2/Graal） |
| 抽象基类 + 模板方法 | `CollectedHeap`/`BarrierSet` (`gc/shared/`) | 多 GC 共存：算法子类只实现分配/遍历/屏障纯虚方法，上层代码 `Universe::heap()->obj_allocate()` 无关具体 GC |
| 策略 | `CompilationPolicy` (`compiler/compilationPolicy.cpp`) | 分层编译阈值决策可替换，按队列长度动态调阈值 |
| 生产者-消费者 | `CompileBroker` + `CompileQueue`/`CompilerThread` (`compiler/compileBroker.cpp`) | 编译异步化，应用线程提交请求不阻塞，CompilerThread 串行消费 |
| 观察者 | `Dependencies` + `DependencyContext` (`code/dependencies.cpp`) | 推测优化假设注册到 `InstanceKlass`，类加载变化时通知失效、触发反优化 |
| Oop/Klass 二级分离 | `oops/oopDesc` + `Klass` (`oops/oopsHierarchy.hpp`) | 避免每个 Java 对象携带 C++ vtbl 指针，元数据单份存 Metaspace |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `JavaThread` | Java 线程的 C++ 表示 | 线程创建到退出 | 持有 `ResourceArea`/TLAB，被 `Threads` 列表管理 |
| `InstanceKlass` | 已加载类的元数据 | 类加载到卸载 | 持有 `ConstantPool`/`Method[]`/vtable/itable，存于 Metaspace |
| `Method` | Java 方法的元数据 | 随 `InstanceKlass` | 持有字节码、入口点（`_i2i_entry`/`_from_compiled_entry`）、`_code` 指向 nmethod |
| `nmethod` | JIT 编译产物 | 编译到失效回收 | 存于 `CodeCache`，注册依赖到 `InstanceKlass` |
| `markWord` | 64 位对象头 | 随对象 | 编码 hash/age/lock 状态，GC 时存转发指针 |
| `Universe` | VM 全局命名空间 | VM 全程 | 持有 `_collectedHeap`、基本类型 Klass、预分配异常 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `AbstractCompiler` | `compiler/abstractCompiler.hpp` | `C1Compiler`、`C2Compiler` | `CompileBroker::_compilers[0/1]`，启动期 `compileBroker.cpp` 注册 |
| `CollectedHeap` | `gc/shared/collectedHeap.hpp` | `G1CollectedHeap`/`ZCollectedHeap`/`SerialHeap`/... | `Universe::_collectedHeap`，`GCConfig::create_heap()` 运行期选 |
| `BarrierSet` | `gc/shared/barrierSet.hpp` | 各 GC 的 `BarrierSetXxx` | `BarrierSet::_barrier_set`，GC 子类 `initialize()` 安装 |
| `VM_Operation` | `runtime/vmOperations.hpp` | `VM_G1CollectFull`/`VM_Deoptimize`/... | `VMThread::execute(op)` 提交到单消费者队列 |

---

## 代码目录

```
src/hotspot/
├── cpu/              # 平台相关：模板解释器汇编、ADLC 生成的 Matcher
│   ├── x86/          #   x86/x86_64 后端
│   ├── aarch64/      #   ARM 64
│   ├── arm/ ppc/ riscv/ s390/
│   └── zero/         #   无汇编后端，用纯 C++ 解释器
├── os/               # OS 相关：线程、内存、文件、信号
│   ├── linux/ windows/ bsd/ aix/ posix/
├── os_cpu/           # OS×CPU 交叉：栈帧、原子操作
└── share/            # 跨平台核心（~98.6 万行 C++，本解读重点）
    ├── runtime/      #   VM 生命周期、线程、safepoint、锁、反优化 (~87k 行)
    ├── oops/        #   对象模型 Oop/Klass/markWord (~52k 行)
    ├── classfile/   #   类加载、验证、字段布局 (~51k 行)
    ├── interpreter/ #   模板解释器 (~18k 行)
    ├── compiler/     #   编译调度、分层策略 (~19k 行)
    ├── ci/          #   编译器接口 (~24k 行)
    ├── code/         #   CodeCache、nmethod、依赖 (~27k 行)
    ├── opto/         #   C2 优化器 Sea-of-Nodes (~202k 行)
    ├── c1/           #   C1 客户端编译器 (~43k 行)
    ├── memory/       #   堆/Metaspace/Arena 基础设施 (~22k 行)
    ├── gc/           #   GC 算法（G1/ZGC/...，~204k 行，不在本解读范围）
    └── utilities/ services/ jfr/ cds/ prims/ adlc/ ...
```

`src/` 下其余 `java.*/`（标准库）与 `jdk.*/`（工具模块）属 Java 层，不在本解读范围。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/openjdk-hotspot/module-dependencies.svg)

依赖方向从执行层（`interpreter`/`compiler`/`opto`）向下流到运行时（`runtime`/`classfile`），再到底层（`oops`/`memory`）。`oops` 定义对象内存表示，是几乎所有模块的共同基础；`memory` 提供分配方式控制与堆抽象。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 运行时 | VM 生命周期、线程、safepoint、锁 | `Threads::create_vm` | 线程模型与一致性（safepoint）是所有执行的前提 | [运行时](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/01-runtime) |
| 对象模型 | Oop/Klass、对象头、vtable/itable | `instanceKlass.cpp` | 对象表示是 GC/解释器/编译器的共同契约 | [对象模型](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/02-oop-model) |
| 类加载 | .class 解析、验证、双亲委派 | `SystemDictionary::resolve_or_null` | 类加载的安全性与并发协调自成体系 | [类加载](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/03-classfile) |
| 字节码解释器 | 模板解释器 dispatch | `TemplateInterpreter::initialize_code` | 冷启动执行入口，与 JIT 性能互补 | [解释器](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/04-interpreter) |
| JIT 编译框架 | 编译调度、ci、CodeCache、依赖 | `CompileBroker::compile_method` | 编译编排与产物管理独立于具体编译器 | [编译框架](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/05-compiler-framework) |
| C2 优化器 | Sea-of-Nodes IR 与全局优化 | `Compile::Compile` | 优化深度（EA/循环/寄存器分配）远超 C1 | [C2 优化器](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/06-opto-c2) |
| 内存管理 | Universe/Metaspace/Arena/分配控制 | `Universe::initialize_heap` | 分配方式与堆抽象是多 GC 共存的基础 | [内存管理](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/07-memory) |

---

## 运行时行为

### 启动流程

VM 启动由 `Threads::create_vm()`（`runtime/threads.cpp:448`）驱动，分阶段装配子系统并创建主线程：

```
Threads::create_vm(args)                       (threads.cpp:448)
├─ VM_Version::early_initialize()              # CPU 特性检测
├─ os::init() / os::init_2()                   # OS 层初始化
├─ Arguments::parse(args) → apply_ergo()      # 参数解析 + 人体工程学
├─ SafepointMechanism::initialize()           # safepoint polling page 准备
├─ JavaThread* main = new JavaThread()         # 创建主线程 (threads.cpp:560)
├─ ObjectMonitor::Initialize() / ObjectSynchronizer::initialize()
├─ universe_init() → Universe::genesis()       # 堆、基本类型 Klass、SystemDictionary (universe.cpp:409)
├─ VMThread::create()                          # 创建 VMThread 单消费者 (threads.cpp:638)
├─ initialize_java_lang_classes()              # 初始化 java.lang.*、创建 main Thread 对象
├─ CompileBroker::compilation_init()           # 启动编译器、创建 CompilerThread
├─ call_initPhase2/3()                         # 模块系统、SecurityManager、ClassLoader
└─ return JNI_OK
```

对象装配的关键点：配置来自命令行（`Arguments::parse`）+ 人体工程学默认值；`Universe::_collectedHeap` 在 `universe_init` 由 `GCConfig::create_heap()` 按参数选定 GC 子类；`CompileBroker::_compilers[0/1]`（C1/C2）在 `compilation_init` 注册；`CompilerThread` 数量动态可变。

### 核心运行流程

下面三条链路覆盖了 HotSpot 最核心的运行模式：分层编译、类加载、对象分配。

#### 分层编译：方法调用到 JIT 编译的生命周期

这是 HotSpot 自适应优化的主轴。一个 Java 方法首次调用时在解释器中执行并累积计数，超阈值后异步触发编译，产物安装后后续调用直接跳转编译代码，依赖失效时安全反优化。

![编译生命周期数据流](/vibe-reading/images/articles/openjdk-hotspot/data-flow.svg)

文字解读：入口是 `JavaCalls::call_helper`（`runtime/javaCalls.cpp:322`），取 `Method::_from_interpreted_entry` 进入模板解释器。解释器在 `generate_counter_incr`（`cpu/x86/templateInterpreterGenerator_x86.cpp:325`）递增 `InvocationCounter`，每约 128 次溢出一次，调 `InterpreterRuntime::frequency_counter_overflow`（`interpreterRuntime.cpp:1094`）。`CompilationPolicy::event`（`compilationPolicy.cpp:787`）按阈值决定下一 tier：常见 `0→3→4`，C2 队列拥塞时 `0→2→3→4`。`CompileBroker::compile_method`（`compileBroker.cpp:1206`）把 `CompileTask` 入队并唤醒 `CompilerThread`，**应用线程不阻塞**。`CompilerThread` 取任务后经 `ciEnv` 适配，调用 C1（`c1_Compiler.cpp`）或 C2（`opto/c2compiler.cpp:125` → `Compile::Compile`）编译。产物经 `ciEnv::register_method`（`ciEnv.cpp:977`）→ `nmethod::new_nmethod`（`nmethod.cpp:1090`）装入 `CodeCache`，`Method::set_code`（`method.cpp:1441`）把 `_from_interpreted_entry` 改写为 i2c 适配器，下次调用直接跳转 nmethod。若依赖（如"final 无子类"）被新类加载打破，`CodeCache::mark_dependents_on`（`codeCache.cpp:1494`）→ `Deoptimization::deoptimize_all_marked`（`deoptimization.cpp:1082`）经 pack/unpack 把栈帧恢复到解释器重新 profiling。

#### 类加载与首次解析

`SystemDictionary::resolve_or_null`（`classfile/systemDictionary.cpp:382`）协调加载：先查 `Dictionary` 缓存，再走双亲委派（boot loader 从 jimage 加载，user loader 经 JNI 调 `ClassLoader.loadClass`），用 `Placeholders` 三队列（`LOAD_INSTANCE`/`DEFINE_CLASS`/`DETECT_CIRCULARITY`）协调并行加载与循环检测。解析出的 `ClassFileStream` 经 `KlassFactory::create_from_stream`（`klassFactory.cpp:172`）→ `ClassFileParser::parse_stream`（`classFileParser.cpp:6024`）逐项解析常量池/字段/方法/属性，`FieldLayoutBuilder` 计算紧凑布局，`Verifier::verify`（`verifier.cpp:183`）用 StackMapTable 做类型验证，最终产出 `InstanceKlass`。链接阶段 `Method::link_method`（`method.cpp:1313`）设置解释器入口，`Rewriter` 改写常量池索引加速 invoke。详见 [类加载模块](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/03-classfile)。

#### 对象分配与 synchronized 锁升级

`new Foo()` → `InstanceKlass::allocate_instance`（`instanceKlass.cpp:1936`）→ `CollectedHeap::obj_allocate`（`collectedHeap.inline.hpp:36`）→ `MemAllocator` 优先走 TLAB 快路径（`mem_allocate_inside_tlab_fast`，`memAllocator.cpp:250`），TLAB 满则 retire 重分配，否则直接堆。`synchronized` 进入由 `ObjectSynchronizer::enter`（`synchronizer.cpp:1725`）多级升级：`LockStack` 递归（零开销）→ fast-lock CAS `markWord`（`fast_lock_try_enter`）→ fast-lock 自旋 → inflate 到 `ObjectMonitor::enter`（`objectMonitor.cpp:484`）重量级锁，`ObjectMonitor::try_spin`（`objectMonitor.cpp:2295`）做自适应自旋。详见 [运行时模块](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/01-runtime)。

---

## 典型修改场景

#### 场景 1：接入一个新 GC

需修改：`gc/shared/barrierSetConfig.hpp`（注册 `FOR_EACH_BARRIER_SET_DO` 枚举）；继承 `BarrierSet` 实现 `AccessBarrier` 特化与 `BarrierSetAssembler/C1/C2` 子类；继承 `CollectedHeap` 实现 `initialize`/`mem_allocate`/`collect` 等纯虚方法；`universe.cpp:964` `GCConfig::create_heap()` 中按 `-XX:+UseXxxGC` 实例化。对应测试：`test/hotspot/jtreg/gc/`。

#### 场景 2：新增一个 C2 intrinsic

需修改：`vmIntrinsics.hpp` 加枚举；`opto/c2compiler.cpp:232` `is_intrinsic_supported` 加 `case` 检查 `Matcher::match_rule_supported`；`.ad` 文件定义 `MachNode` 与 `match()` 规则；`opto/library_call.cpp:236` `LibraryCallKit::try_to_inline` 加 `case` 并用 `GraphKit` 构造 IR。对应测试：`test/hotspot/jtreg/compiler/intrinsic/`。

#### 场景 3：调整分层编译阈值

需修改：`compiler/compilationPolicy.cpp:1282` `standard_transition` 与 `transition_from_none`（`:1300`）/`transition_from_full_profile`（`:1326`）中的阈值比较，或调整 `compiler_globals.hpp` 的 `Tier3InvocationThreshold`/`Tier4InvocationThreshold` 等 JVM flag。对应测试：`test/hotspot/jtreg/compiler/tiered/`。

---

## 测试体系

OpenJDK 测试在 `test/` 下分层：

```
test/
├── hotspot/         # HotSpot 原生测试
│   ├── jtreg/       #   JTreg 回归测试（按子系统分目录：gc/ compiler/ runtime/ ...）
│   └── native/      #   C++ 单元测试（Unit-test framework）
└── jdk/             # JDK 库测试（不在本解读范围）
```

| 代码层 | 测试类型 | 目录 |
| --- | --- | --- |
| runtime / oops | JTreg + native | `test/hotspot/jtreg/runtime/`、`test/hotspot/native/` |
| compiler / opto / c1 | JTreg | `test/hotspot/jtreg/compiler/` |
| gc | JTreg | `test/hotspot/jtreg/gc/` |

`make test-tier1` 跑基础回归。修改某子系统时优先看对应目录——JTreg 测试常是最好的"可执行文档"。

---

## 阅读源码推荐路线

- 第一遍：理解 VM 启动与一次调用
  `runtime/threads.cpp` 的 `Threads::create_vm()` → `runtime/javaCalls.cpp` 的 `call_helper()` → `share/oops/method.hpp` 的 `_from_interpreted_entry` → `cpu/x86/templateInterpreterGenerator_x86.cpp` 的 `generate_normal_entry`
- 第二遍：理解对象表示
  `oops/oopsHierarchy.hpp`（Oop/Klass 层级）→ `oops/markWord.hpp`（64 位对象头）→ `oops/instanceKlass.cpp`（vtable/itable、`allocate_instance`）
- 第三遍：理解类加载到首次执行
  `classfile/systemDictionary.cpp` 的 `resolve_or_null` → `classfile/classFileParser.cpp` 的 `parse_stream` → `interpreter/rewriter.cpp` 的 `rewrite` → `interpreter/interpreterRuntime.cpp` 的 `resolve_invoke`
- 第四遍：理解分层编译
  `compiler/compilationPolicy.cpp` 的 `event` → `compiler/compileBroker.cpp` 的 `compile_method_base` + `compiler_thread_loop` → `opto/compile.cpp` 的 `Compile::Compile`/`Optimize`/`Code_Gen` → `code/nmethod.cpp` 的 `new_nmethod` → `oops/method.cpp` 的 `set_code`
- 第五遍：选择重点模块深入（C2 优化器优先 `opto/compile.cpp` → `opto/node.hpp` → `opto/matcher.cpp` → `opto/chaitin.cpp`；内存 `memory/allocation.hpp` → `memory/arena.hpp` → `memory/metaspace.cpp`）

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| Oop | Ordinary Object Pointer，Java 对象的 C++ 指针表示 |
| Klass | 类元数据，存于 Metaspace，每类一份 |
| markWord | 64 位对象头，编码 hash/age/lock 状态 |
| Safepoint | 所有 Java 线程停在一致状态的检查点，供 GC/反优化 |
| nmethod | JIT 编译后的方法，存于 CodeCache |
| Sea-of-Nodes | C2 的图 IR，数据流与控制流显式编码为节点边 |
| Tiered Compilation | 分层编译：解释器(0)→C1(1-3)→C2(4) |
| EA | Escape Analysis，逃逸分析，支持栈上分配/锁消除 |
| ci | Compiler Interface，JIT 与 VM 间的只读适配层 |
| OSR | On-Stack Replacement，栈上替换为编译代码 |

### 参考资料

- [OpenJDK 官方网站](https://openjdk.org/) · [HotSpot 组首页](https://openjdk.org/groups/hotspot/)
- [Building the JDK](https://git.openjdk.org/jdk/blob/master/doc/building.md)
- Cliff Click, *Modern MP: The Sea-of-Nodes IR*（C2 IR 设计来源）
- Choi et al., OOPSLA'98, *Escape Analysis for Java*（C2 EA 算法）
- [The Java Virtual Machine Specification](https://docs.oracle.com/javase/specs/)（class 文件格式、字节码语义）
