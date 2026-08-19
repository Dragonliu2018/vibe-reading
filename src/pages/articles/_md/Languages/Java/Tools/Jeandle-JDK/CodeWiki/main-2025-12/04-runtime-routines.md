---
source:
  type: "源码解读"
  project: "Jeandle-JDK"
  url: "https://github.com/jeandle/jeandle-jdk"
title: "运行时例程"
date: "2026-08-19T17:50:32+08:00"
category: ["Languages", "Java", "Tools", "Jeandle-JDK", "CodeWiki", "main-2025-12"]
tags: ["Jeandle", "运行时", "JavaOp", "statepoint"]
description: "Jeandle 运行时例程：编译期生成供编译代码回访 JVM 的 C/汇编/Hotspot 例程与模板 JavaOp"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Tools/Jeandle-JDK/CodeWiki/main-2025-12/00-overview)

---

## 模块定位

运行时例程模块定义了 **Jeandle 编译产物与 HotSpot JVM 运行时之间的契约**。编译出的本地代码不是自给自足的——它需要在运行期回访 JVM 做 safepoint 轮询、分配对象、解析调用、加锁、抛异常、配合 GC。本模块在**编译期**就把这些回访路径准备好：把 C/汇编/Hotspot 三类例程编译成可调用的入口、为 C 例程生成 VM 调用桩、把若干高频操作（取当前线程、safepoint 轮询、card table 屏障）做成模板内联 IR（JavaOp）注入全局 bitcode。它独立成文，因为这一层是 Jeandle 区别于"纯 LLVM JIT"的关键——没有它，编译出的代码无法 safepoint、无法 GC、无法分配，只是孤立的机器码。

涉及文件：`jeandleRuntimeRoutine.cpp/.hpp`、`jeandleCallVM.cpp/.hpp`、`templatemodule/jeandleRuntimeDefinedJavaOps.cpp/.hpp`、`jeandleRegister.hpp`。

## 模块架构

![运行时例程内部结构](/vibe-reading/images/articles/jeandle-jdk/runtime-architecture.svg)

模块围绕三类例程与两个生成器组织。`JeandleRuntimeRoutine`（AllStatic 静态类）是例程注册表，启动期 `generate` 把所有例程入口登记进 `_routine_entry` 字典，编译期 `get_routine_entry(name)` 查询。三类例程各走不同路径：**C 例程**（safepoint_handler、new_instance、new_array、multianewarray2..5/N）经 `JeandleCallVM` 编一个 runtime stub 包装后再登记；**汇编例程**（exceptional_return、exception_handler）直接由 CPU 相关汇编生成；**Hotspot 例程**（dsin/dcos/dtan、drem/frem、monitor lock/unlock、throw_NPE）直接登记 `SharedRuntime`/`StubRoutines` 的地址。`JeandleCallVM` 是 C 例程的 stub 生成器，负责包装 C 函数调用并维护 `last_Java_sp`；`RuntimeDefinedJavaOps` 是模板内联 IR 的定义器，启动期把 `jeandle.current_thread`/`safepoint_poll`/`card_table_barrier`/`new_instance` 等 JavaOp 注入模板 bitcode。三张 X-Macro 表（`ALL_JEANDLE_C_ROUTINES`/`ALL_JEANDLE_ASSEMBLY_ROUTINES`/`ALL_HOTSPOT_ROUTINES`）是单一真源——同时驱动 LLVM callee 声明、stub 编译、地址注册。

## 调用链路

![运行期回访](/vibe-reading/images/articles/jeandle-jdk/runtime-callchain.svg)

运行期，编译产物在 Code Cache 中执行时通过四条路径回访 JVM：循环回跳处的 `jeandle.safepoint_poll` 轮询 TLS poll word，命中则调 `safepoint_handler` 例程；对象分配走 `jeandle.new_instance` JavaOp→`new_instance` 例程→`InstanceKlass::allocate_instance`，结果经 TLS `vm_result` 回传；方法调用经编译期装配的 static/dynamic stub 由 `SharedRuntime` 解析目标；GC 依赖 statepoint 在调用点驻留的 StackMap 重建 OopMap。注意 C 例程与 Hotspot 例程的"调用约定"差异：C 例程走 `Hotspot_JIT` 约定（经 stub），Hotspot 例程走 `C` 约定（直接调），这决定了抽象解释器 `call_jeandle_routine` 传哪个 `CallingConv`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `JeandleRuntimeRoutine::generate` | 启动期生成全部例程 | 三张 X-Macro 表各走 GEN_C_ROUTINE_STUB/GEN_ASSEMBLY/REGISTER_HOTSPOT |
| `get_routine_entry` | 查例程入口 | StringMap 查找，编译期与重定位期都用 |
| `safepoint_handler` | 处理 safepoint | `JRT_ENTRY`，校验来自 jeandle 帧，`process_if_requested_with_exit_check` |
| `new_instance`/`new_array` | 对象分配 | 复刻 OptoRuntime，结果经 TLS `vm_result` 回传（GC 可能移动） |
| `multianewarray2..5/N` | 多维数组 | 按维度数分派，调 `ArrayKlass::multi_allocate` |
| `search_landingpad` | 异常 handler 定位 | 读 `JeandleExceptionHandlerTable` 把异常 PC 映射到 handler PC |
| `JeandleCallVM::generate_call_VM` | C 例程 stub 生成 | 设 last_Java_sp→调 C→清 last_Java_sp/pc→oop 从 vm_result 取 |
| `RuntimeDefinedJavaOps::define_all` | 注入模板 JavaOp | define_metadata/global_variables + 四个 JavaOp |
| `define_safepoint_poll` | safepoint 轮询 IR | 读 TLS poll word，命中调 safepoint_handler |
| `define_card_table_barrier` | GC 卡表屏障 | 按 card_shift 算卡地址写 dirty 值，支持 UseCondCardMark |

</details>

## 核心实现

### X-Macro 例程表：单一真源

模块最优雅的设计是三张 X-Macro 表。以 C 例程为例，`ALL_JEANDLE_C_ROUTINES(def)` 是一张宏，每行 `def(name, return_type, arg_types...)`。这张表被三个不同宏展开，分别生成：LLVM callee 声明（`DEF_LLVM_CALLEE`，设 `Hotspot_JIT` 调用约定）、stub 编译调用（`GEN_C_ROUTINE_STUB`，用 `JeandleCompilation` 第二构造函数编 stub）、与具体 C 函数体（在 cpp 里手写 `JRT_ENTRY`）。

```cpp title="jeandleRuntimeRoutine.hpp"
#define DEF_LLVM_CALLEE(c_func, return_type, ...)                                  \
  static llvm::FunctionCallee c_func##_callee(llvm::Module& target_module) {        \
    llvm::FunctionType* func_type = llvm::FunctionType::get(return_type, {__VA_ARGS__}, false); \
    llvm::FunctionCallee callee = target_module.getOrInsertFunction(#c_func, func_type); \
    llvm::cast<llvm::Function>(callee.getCallee())->setCallingConv(llvm::CallingConv::Hotspot_JIT); \
    return callee;                                                                  \
  }
ALL_JEANDLE_C_ROUTINES(DEF_LLVM_CALLEE);   // 一次性生成所有 callee 声明
```

为什么用 X-Macro：新增一个 C 例程只需在表里加一行 + 在 cpp 实现 `JRT_ENTRY` 函数体，callee 声明、stub 编译、地址注册自动到位——三类处理永远不漂移。这是"表格驱动"对"散落三处的重复"的胜利。

### 三类例程的三条路径

`generate` 串起三类例程的不同生成方式：

```cpp title="jeandleRuntimeRoutine.cpp"
bool JeandleRuntimeRoutine::generate(llvm::TargetMachine* target_machine, llvm::DataLayout* data_layout) {
  ALL_JEANDLE_C_ROUTINES(GEN_C_ROUTINE_STUB);          // C 例程：每个编一个 stub
  ALL_JEANDLE_ASSEMBLY_ROUTINES(GEN_ASSEMBLY_ROUTINE_BLOB);  // 汇编例程
  ALL_HOTSPOT_ROUTINES(REGISTER_HOTSPOT_ROUTINE);     // Hotspot 例程：直接登记地址
  return true;
}
```

C 例程的 `GEN_C_ROUTINE_STUB` 用 `JeandleCallVM::generate_call_VM`（经 `JeandleCompilation` 第二构造函数）为每个 C 函数编一个 runtime stub——stub 的 IR 由 `JeandleCallVM` 生成，不是抽象解释器（因为 stub 不是 Java 方法）。汇编例程由 CPU 相关代码生成（`generate_exceptional_return`/`generate_exception_handler`）。Hotspot 例程最简单——直接把 `SharedRuntime::dsin` 等地址登记进 `_routine_entry`，编译期抽象解释器直接用这些地址生成调用。三类的差别在注释里点明：C/C++ 例程需 stub 调整 VM 状态（仿 C2 的 `GraphKit::gen_stub`），汇编/Hotspot 例程可直接用地址生成调用。

### JeandleCallVM：VM 调用桩的生成

`generate_call_VM` 为单个 C 函数生成 stub IR。它的核心职责是**围绕 C 调用维护 JVM 栈 unwind 状态**——调用前设 `last_Java_sp`（让 GC/异常能回溯 Java 栈），调用后清 `last_Java_sp`/`last_Java_pc`：

```cpp title="jeandleCallVM.cpp"
// 设 last_Java_sp 启用栈 unwind
llvm::Value* sp_value = ir_builder.CreateIntrinsic(llvm::Intrinsic::read_register, intptr_type, read_sp_args);
ir_builder.CreateStore(sp_value, last_Java_sp_ptr);
// 调 C 函数
llvm::CallInst* call_c_func = ir_builder.CreateCall(func_type, c_func_ptr, args);
call_c_func->setCallingConv(llvm::CallingConv::C);
// statepoint 属性（GC 驻留）
call_c_func->addFnAttr(id_attr); call_c_func->addFnAttr(patch_bytes_attr);
// 清 last_Java_sp/pc
ir_builder.CreateStore(ir_builder.getInt64(0), last_Java_sp_ptr);
```

`read_register` intrinsic 用 `JeandleRegister::get_stack_pointer()` 元数据读栈指针——这是把 JVM 的寄存器约定嵌入 LLVM IR 的方式（寄存器名经 `CurrentThread`/`StackPointer` 命名元数据传入）。返回值若是 Java 对象，从 TLS `vm_result` 取而非直接用 C 返回值——因为 C 例程可能阻塞触发 GC，oop 在 C 返回寄存器里会被 GC 移动，必须经 TLS 中转（`new_instance` 等例程 `set_vm_result`）。这套机制与 HotSpot 既有 runtime stub 语义一致，是 JVM JIT 调用 C 运行时的标准范式。

### RuntimeDefinedJavaOps：模板内联 IR

`RuntimeDefinedJavaOps::define_all` 在启动期向模板 bitcode 注入若干 `jeandle.*` 函数，这些函数体由 jeandle-llvm 在 lowering 期展开（由 `lower-phase` 属性控制时机）。四个 JavaOp 各有用途：

- `jeandle.current_thread`：用 `read_register` + `CurrentThread` 元数据读当前线程指针。几乎所有需要 TLS 的操作都先调它取线程。抽象解释器用 `call_java_op("jeandle.current_thread", {})` 调用。
- `jeandle.safepoint_poll`：读 TLS poll word，与 `~poll_bit` 比较，命中（非 safepoint）直接返回，未命中调 `safepoint_handler`。这是 Jeandle 的 safepoint 实现——轮询点插在循环回跳，命中时几乎零开销。
- `jeandle.card_table_barrier`：按 `CardTable::card_shift` 右移对象地址算卡索引，写 dirty 值。支持 `UseCondCardMark`（先读卡值，已脏则跳过写）。这是 GC 写屏障。
- `jeandle.new_instance`：慢路径分配，调 `new_instance` 例程。注释标注快路径未实现。

`define_global_variables` 还注入若干编译期常量（`arrayOopDesc.base_offset_in_bytes.int`、`Klass.super_check_offset_offset` 等）——这些是 JVM 对象布局的硬编码偏移，编译期固化为 LLVM 全局常量，让 IR 直接用数值寻址而不必运行期查。`define_metadata` 注入 `CurrentThread`/`StackPointer` 命名元数据，登记寄存器名供 `read_register` 用。

### JRT 宏与帧校验

C 例程用 `JRT_ENTRY`/`JRT_LEAF`/`JRT_BLOCK` 等宏包裹——这是 HotSpot 的标准运行时例程入口宏，处理 `JavaThread` 状态切换、句柄、异常检查等。`check_jeandle_compiled_frame` 在 ASSERT 下校验调用者确是 jeandle 编译帧（`caller.is_jeandle_compiled_frame()`），防止例程被错误调用。例程内大量 `// It's a copy of OptoRuntime::xxx_C` 注释表明这些例程直接复刻自 C2 的对应运行时——这是务实的复用，JVM 运行时例程语义成熟稳定。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| X-Macro 表 | `ALL_JEANDLE_C_ROUTINES` in `jeandleRuntimeRoutine.hpp` | 单一真源驱动声明/编译/注册，杜绝三处漂移 |
| 静态注册表 | `JeandleRuntimeRoutine`（AllStatic）+ `_routine_entry` | 启动期生成、编译期查询，无实例 |
| 模板方法 | `generate` 三步 | 固定顺序生成三类例程，每类用不同宏 |
| 桥接（Bridge） | `JeandleCallVM` 包装 C 调用 | 把"C 调用"与"JVM 栈状态维护"两维变化解耦 |

## 模块间交互

运行时例程**向上**被编译驱动在启动期调用（`JeandleCompiler::initialize` 调 `generate`）、被抽象解释器在编译期调用（`call_jeandle_routine`/`call_java_op` 生成对例程/JavaOp 的调用 IR）、被代码生成在重定位期调用（`resolve_reloc_info` 用 `get_routine_entry` 解析例程调用边目标）。它**向下**复用 HotSpot 运行时（`SharedRuntime`、`StubRoutines`、`InstanceKlass::allocate_instance` 等）。`JeandleRegister`（CPU 相关）被本模块与代码生成共用——本模块用它取 current_thread/stack_pointer 寄存器名，代码生成用它做 DWARF 寄存器→VMReg 转换。`RuntimeDefinedJavaOps` 产出的 JavaOp 存在模板 bitcode 里，被抽象解释器 `call_java_op` 引用。

## 扩展方式

- **新增 C 例程**：在 `ALL_JEANDLE_C_ROUTINES` 加一行 `def(name, ret, args...)`，在 cpp 实现 `JRT_ENTRY` 函数体，在抽象解释器用 `name_callee(_module)` 调用。X-Macro 自动生成其余。
- **新增 Hotspot 例程**：在 `ALL_HOTSPOT_ROUTINES` 加一行 `def(name, func_entry, ret, args...)`，自动登记地址。
- **新增模板 JavaOp**：在 `jeandleRuntimeDefinedJavaOps.cpp` 用 `DEF_JAVA_OP` 定义函数体，在 `define_all` 调 `define_##name`。注意 `lower-phase` 属性控制 jeandle-llvm 的展开时机。
- **新增 CPU 后端**：实现 `cpu/<arch>/jeandleRegister_<arch>.hpp`（寄存器名 + DWARF 映射）与汇编例程生成，`jeandleRegister.hpp` 的 `CPU_HEADER` 宏自动分派。
