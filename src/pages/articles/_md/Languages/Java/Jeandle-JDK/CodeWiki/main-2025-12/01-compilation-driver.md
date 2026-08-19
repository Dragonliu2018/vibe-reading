---
source:
  type: "源码解读"
  project: "Jeandle-JDK"
  url: "https://github.com/jeandle/jeandle-jdk"
title: "编译驱动"
date: "2026-08-19T17:50:32+08:00"
category: [Languages, Java, Jeandle-JDK, CodeWiki, "main-2025-12"]
tags: ["Jeandle", "JIT", "OpenJDK"]
description: "Jeandle 编译驱动：JeandleCompiler 与 JeandleCompilation 的装配与流水线编排"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main-2025-12/00-overview)

---

## 模块定位

编译驱动模块是 Jeandle 与 HotSpot 编译子系统对接的**门面与编排者**。它向上以 `AbstractCompiler` 子类身份被 `CompileBroker` 调度，向下把单次编译任务串成一条确定性流水线（装配 → 翻译 → 优化 → 发射 → 装载），自身既不生成 IR 也不解析 ELF——这两端分别委托给抽象解释器与代码生成模块。它的独立价值在于**生命周期与编排**：用一个 RAII 栈对象承载一次编译的全部上下文，让 `compile_method` 退化为单行构造，资源回收与错误传播都由栈语义兜底。

涉及文件：`jeandleCompiler.cpp/.hpp`、`jeandleCompilation.cpp/.hpp`、`jeandleUtils.cpp/.hpp`（`JeandleFuncSig`）、`jeandle_globals.hpp`、`jeandleResourceObj.cpp/.hpp`。

## 模块架构

![编译驱动内部结构](/vibe-reading/images/articles/jeandle-jdk/driver-architecture.svg)

模块内部三个核心抽象职责清晰：`JeandleCompiler` 是**编译器单例**，持有 LLVM `TargetMachine`/`DataLayout` 与全局只读模板 bitcode 缓冲，负责一次性的 `initialize`（例程桩生成 + 模板加载）与每次编译的 `compile_method` 派发；`JeandleCompilation` 是**单次编译上下文**（栈对象），编排流水线并持有产物 `JeandleCompiledCode` 与 `llvm::Module`；`JeandleFuncSig` 是**方法签名工具**，把 `ciMethod` 转成 LLVM Function（命名、参数类型、GC/调用约定元信息）。三者用"单例编译器 + 栈上下文"的经典分层——编译器长期存活、上下文随编译生灭，避免线程间共享可变状态。

`JeandleCompilationResourceObj` 是模块内的 arena 分配基类：所有编译期临时对象（`JeandleVMState`、`JeandleBasicBlock` 等）继承它，`operator new` 走 `Thread::current()->resource_area()` 的 arena，编译结束 `ResourceMark` 析构即整体回收，免逐个释放。

## 调用链路

![编译驱动调用链路](/vibe-reading/images/articles/jeandle-jdk/driver-callchain.svg)

调用链有两条主线：**启动期初始化**（`JeandleCompiler::initialize`，见概览启动流程）与**运行期单次编译**（上图）。运行期主路径从 `compile_method` 进入，构造 `JeandleCompilation` 栈对象后由其构造函数顺序驱动 `initialize → setup_llvm_module → compile_java_method → install_code`。`compile_java_method` 内部串起翻译、校验、优化、发射、装载五步，并把翻译委托给抽象解释器、装载委托给 `JeandleCompiledCode::finalize`（代码生成模块）。错误处理是贯穿的旁路：任何一步 `report_jeandle_error` 后，主链路在关键检查点 `if (error_occurred()) return`，最终由 `JeandleCrashOnError` 决定 debug 版直接 `fatal` 还是 release 版降级为 `record_method_not_compilable`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `JeandleCompiler::create` | 构造 LLVM TargetMachine | 固定 PIC + Small code model + Aggressive + JIT，匹配 JVM 代码缓存要求 |
| `JeandleCompiler::initialize` | 一次性初始化 | `should_perform_init` 守卫幂等；三步任一失败即 `set_state(failed)` |
| `JeandleCompiler::compile_method` | 派发单次编译 | 仅 `ResourceMark rm` + 构造 `JeandleCompilation`，全部工作在栈对象构造里 |
| `initialize_template_buffer` | 加载模板 bitcode | 序列化为 `SmallVectorMemoryBuffer` 全局只读，线程安全共享 |
| `JeandleCompilation::initialize` | 装配 CI 环境 | 把 `compiler_data`/`oop_recorder`/`debug_info`/`dependencies` 注入 ciEnv |
| `setup_llvm_module` | 从 bitcode 解析 Module | `parseBitcodeFile` 独立 Module + DataLayout + JavaMethodCompilation 元数据 |
| `compile_java_method` | 编译 Java 方法 | `check_can_parse` 前置 + 构造抽象解释器 + optimize + compile_module + finalize |
| `compile_module` | 发射 ELF | `addPassesToEmitMC` 不支持则报错；产物装 `SmallVectorMemoryBuffer` |
| `install_code` | 装入 Code Cache | 调 `ciEnv::register_method`，多数参数为临时占位 0/false |
| `JeandleFuncSig::method_name` | 方法命名 | `类名_方法名`，`/` 替换为 `_`，作 ELF 符号名 |
| `JeandleFuncSig::create_llvm_func` | 生成 LLVM Function | receiver 作首参，按签名映射参数类型，`setup_description` 加 GC/调用约定 |
| `JeandleCompilation::current` | 取当前编译上下文 | 经 `ciEnv::current()->compiler_data()`，供模块内全局访问 |

</details>

## 核心实现

### JeandleCompiler：编译器单例与一次性初始化

`JeandleCompiler` 继承 `AbstractCompiler`，类型标记为 `compiler_jeandle`。`create()` 用宿主三元组查 LLVM Target 并强制 PIC + Small + Aggressive + JIT 创建 TargetMachine——这套配置是 Jeandle 装入 HotSpot Code Cache 的前提（PIC 适配代码缓存重定位，Small 适配 JVM 代码布局）。

```cpp title="jeandleCompiler.cpp"
JeandleCompiler* JeandleCompiler::create() {
  llvm::Triple target_triple = llvm::Triple(llvm::sys::getProcessTriple());
  const llvm::Target* target = llvm::TargetRegistry::lookupTarget(target_triple.getTriple(), err_msg);
  // ...
  llvm::TargetMachine* target_machine = target->createTargetMachine(
      target_triple.getTriple(), ""/* CPU */, features.getString(), options,
      llvm::Reloc::Model::PIC_, llvm::CodeModel::Model::Small,
      llvm::CodeOptLevel::Aggressive, true/* JIT */);
  return new JeandleCompiler(target_machine);
}
```

`initialize()` 是关键设计点：它**在启动期一次性完成所有重资产的 LLVM 准备**，避免每次编译重复。三步顺序执行，任一失败即 `set_state(failed)` 退出：

```cpp title="jeandleCompiler.cpp"
void JeandleCompiler::initialize() {
  if (should_perform_init()) {
    if (!initialize_commandline_options()) { set_state(failed); return; }   // 注册 implicit null check
    if (!JeandleRuntimeRoutine::generate(target_machine(), data_layout()))   // 编译所有例程桩
      { set_state(failed); return; }
    if (!initialize_template_buffer()) { set_state(failed); return; }        // 加载模板 bitcode
    set_state(initialized);
  }
}
```

`initialize_template_buffer` 的 why 值得展开：模板 `.ll` 文件包含 `jeandle.current_thread`、`jeandle.safepoint_poll`、`jeandle.card_table_barrier`、`jeandle.new_instance` 等 JavaOp 的声明与若干全局常量（如 `arrayOopDesc.base_offset_in_bytes.int`）。启动期由 `RuntimeDefinedJavaOps::define_all` 注入函数体与常量初值，再用一个临时 `LLVMContext` `parseIRFile` + `WriteBitcodeToFile` 序列化为 bitcode。此后每次方法编译从这个**全局只读** `SmallVectorMemoryBuffer` `parseBitcodeFile` 出独立 Module——只读保证多编译线程并发安全，bitcode 格式比文本 IR 解析更快。这是"启动期重活一次、运行期复制只读副本"的典型权衡。

### JeandleCompilation：RAII 编译上下文

`JeandleCompilation` 是整个模块的灵魂——它用构造函数即完成整条编译链，调用方 `compile_method` 因此只有一行：

```cpp title="jeandleCompiler.cpp"
void JeandleCompiler::compile_method(ciEnv* env, ciMethod* target, int entry_bci,
                                      bool install_code, DirectiveSet* directive) {
  ResourceMark rm;
  JeandleCompilation compilation(target_machine(), data_layout(), env, target,
                                 entry_bci, install_code, _template_buffer.get());
}
```

`ResourceMark rm` 划定本次编译的 arena 作用域，`JeandleCompilation` 作为栈对象构造即跑完 `initialize → setup_llvm_module → compile_java_method`，若 `should_install` 则 `install_code`，析构时 arena 整体回收。**为什么用 RAII 而非显式 `compile()` 方法**：栈对象的生命周期天然对齐单次编译，资源回收与异常路径都由 C++ 栈语义保证，不必手写 try/finally，也杜绝了忘记释放。

`JeandleCompilation` 有两个构造函数对应两种编译模式：Java 方法编译（主路径）与运行时例程 stub 编译（第二个构造函数，由 `JeandleRuntimeRoutine::generate` 在启动期调用，见运行时例程模块）。两者共享 `initialize`/`compile_module`/dump 等私有方法，差别在中间步骤——stub 路径用 `JeandleCallVM::generate_call_VM` 生成 IR 而非抽象解释器，最终装成 `RuntimeStub` 而非 nmethod。

错误传播是另一设计重点。模块用 `_error_msg` 字符串指针表达错误态（`nullptr` 即无错），并提供静态访问器让下游模块上报：

```cpp title="jeandleCompilation.hpp"
static void report_jeandle_error(const char* msg) { JeandleCompilation::current()->report_error(msg); }
static bool jeandle_error_occurred() { return JeandleCompilation::current()->error_occurred(); }
```

`current()` 经 `ciEnv::current()->compiler_data()` 取当前编译上下文——这是依赖注入的回退通道，让抽象解释器、代码生成等下游模块不必接收 `JeandleCompilation*` 参数即可上报错误。主链路在关键节点检查 `error_occurred()` 提前返回，debug 版受 `JeandleCrashOnError`（默认 true）控制直接 `fatal` 暴露问题，release 版降级为 `record_method_not_compilable` 让方法回退解释执行。

### compile_java_method：编排与前置校验

`compile_java_method` 是流水线的编排骨架，把翻译、校验、优化、发射、装载五步串起来：

```cpp title="jeandleCompilation.cpp"
void JeandleCompilation::compile_java_method() {
  const char* parse_check_result = JeandleAbstractInterpreter::check_can_parse(_method);
  if (parse_check_result != nullptr) { report_error(parse_check_result); return; }

  { JeandleAbstractInterpreter interpret(_method, _entry_bci, *_llvm_module, _code); }  // 翻译

  if (JeandleDumpIR) dump_ir(false);
  if (error_occurred()) return;
#ifdef ASSERT
  if (llvm::verifyModule(*_llvm_module, &llvm::errs())) { report_error("module verify failed"); return; }
#endif
  llvm::jeandle::optimize(_llvm_module.get(), llvm::OptimizationLevel::O3);   // 优化
  if (JeandleDumpIR) dump_ir(true);
  compile_module();                                                             // 发射
  if (error_occurred()) return;
  _code.finalize();                                                            // 装载（重定位/OopMap/异常表）
}
```

`check_can_parse` 是有意的**前置能力声明**：在投入完整翻译前先判断方法是否在 Jeandle 当前能力边界内（native/abstract/不平衡 monitor/流分析失败一律不编）。这是一个快速失败设计——避免花完整翻译的代价才发现某特性不支持。模块边界判定集中在 `jeandleAbstractInterpreter.cpp` 的 `check_can_parse`，与 `CHECK_CAN_PARSE_PRINCIPLE.md` 文档互为规格。

`setup_llvm_module` 从全局 bitcode 缓冲 `parseBitcodeFile` 出独立 Module，设 `JeandleFuncSig::method_name` 作标识、设 DataLayout、挂 `JavaMethodCompilation` 命名元数据。这个命名元数据是 jeandle-llvm 识别"这是 Java 方法编译"的标记，决定其 lowering 行为（如展开 JavaOp）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| RAII 编译上下文 | `JeandleCompilation` 栈对象 in `jeandleCompilation.cpp` | 构造即编译、析构即回收，`compile_method` 单行，资源/异常由栈语义兜底 |
| 门面（Facade） | `JeandleCompiler::compile_method` | 对 `CompileBroker` 隐藏整条流水线，只暴露一个方法 |
| 依赖注入 | `JeandleCompilation::initialize` 设 `compiler_data` on `ciEnv` | 下游用 `current()` 反查上下文，避免参数穿透每层调用 |
| 策略（双构造函数） | `JeandleCompilation` 两构造函数 | Java 方法 vs 运行时 stub 共享基础设施，差别隔离在构造路径 |

## 模块间交互

驱动模块是系统的枢纽。它被 `CompileBroker` 创建调用（`_compilers[1] = JeandleCompiler::create()` in `compileBroker.cpp:651`）；启动期 `initialize` 调 `JeandleRuntimeRoutine::generate`（运行时例程模块）生成所有桩；运行期 `compile_java_method` 构造 `JeandleAbstractInterpreter`（抽象解释器模块）完成翻译，`_code.finalize()` 委托 `JeandleCompiledCode`（代码生成模块）完成装载。`JeandleFuncSig` 被自身与抽象解释器共用（`invoke` 用 `method_name` 生成被调函数）。交互方式均为直接函数调用，无循环依赖——驱动单向依赖三个下游模块。

## 扩展方式

新增编译能力通常不动本模块，而是扩展下游（如新增字节码处理在抽象解释器、新增例程在运行时例程）。需要改本模块的典型场景：

- **新增 JVM flag**：在 `jeandle_globals.hpp` 的 `JEANDLE_FLAGS` 宏表加一行 `product(bool, JeandleXxx, false, "...")`，OpenJDK 的 flag 机制会自动生成声明与访问器。
- **调整 Code Cache 装入参数**：`install_code` 当前多数参数是临时占位（`0`/`false`），随 deopt/OSR 等特性落地逐步填实。
- **新增编译产物 dump**：仿 `dump_ir`/`dump_obj`，在 `compile_java_method` 相应阶段加 dump 调用，受 `JeandleDump*` flag 控制。
