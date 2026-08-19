---
source:
  type: "源码解读"
  project: "Jeandle-JDK"
  url: "https://github.com/jeandle/jeandle-jdk"
title: "代码生成"
date: "2026-08-19T17:50:32+08:00"
category: [Languages, Java, Jeandle-JDK, CodeWiki, "main-2025-12"]
tags: ["Jeandle", "ELF", "重定位", "Code Cache"]
description: "Jeandle 代码生成：LLVM ELF 产物解析、重定位、OopMap 与异常表装载入 Code Cache"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Jeandle-JDK/CodeWiki/main-2025-12/00-overview)

---

## 模块定位

代码生成模块是 **LLVM 与 HotSpot Code Cache 的接合部**。jeandle-llvm 把优化后的 IR 发射成 ELF 目标文件（二进制机器码 + 元数据段），但 HotSpot Code Cache 不认识 ELF——它要的是 `CodeBuffer`（指令 + 桩 + 重定位信息）、`OopMap`（GC 根位置）、异常处理表与隐式异常表。本模块的职责就是做这个"格式翻译"：解析 ELF 定位代码与各元数据段，用 JITLink 解析重定位，从 StackMap 还原 OopMap，把一切装配进 `CodeBuffer` 供 `install_code` 装入 Code Cache 生成 nmethod。它独立成文，是因为"把 LLVM 的产物语义忠实映射到 JVM 的代码缓存模型"有大量细节（调用点匹配、prolog 偏移修正、隐式检查表），是 Jeandle 区别于纯 LLVM JIT 的关键 JVM 适配层。

涉及文件：`jeandleCompiledCode.cpp/.hpp`、`jeandleReadELF.cpp/.hpp`、`jeandleAssembler.cpp/.hpp`、`jeandleCompiledCall.hpp`、`jeandleExceptionHandlerTable.cpp/.hpp`、`jeandleRegister.hpp`。

## 模块架构

![代码生成内部结构](/vibe-reading/images/articles/jeandle-jdk/codegen-architecture.svg)

模块以 `JeandleCompiledCode` 为中心容器，它持有编译产物（`_obj`/`_elf`/`_code_buffer`）与全部待解析的元信息（两类 call site 表、oop 句柄表、常量段缓存），并在 `finalize` 里串起装配流程。`ReadELF` 是无状态工具类，提供 `findFunc`（按符号名定位代码段 offset/size/对齐）与 `findSection`（按段名取 offset/size）——`finalize` 用前者定位 `.text`，用后者定位 `.llvm_stackmaps`/`.gcc_except_table`/`.llvm_faultmaps`。`JeandleAssembler` 封装 `MacroAssembler`，负责把指令/常量拷进 `CodeBuffer` 并发射各类重定位桩。模块内还有一组 `JeandleReloc` 子类（`JeandleConstReloc`/`JeandleCallReloc`/`JeandleOopReloc`），用多态统一"收集→排序→按 offset 顺序发射"的重定位处理。

## 调用链路

![finalize 调用链路](/vibe-reading/images/articles/jeandle-jdk/codegen-callchain.svg)

`finalize` 是模块的主流程：`install_obj` 先把对象缓冲解析成 `ELFObject` → `ReadELF::findFunc` 定位目标函数的代码段 → `setup_frame_size` 确定栈帧大小 → 初始化 `CodeBuffer`/`MacroAssembler`/`JeandleAssembler`，依次发射 IC 检查、verified entry、栈溢出检查、`.text` 指令 → `resolve_reloc_info` 是核心，分四步处理重定位（见下） → `build_exception_handler_table`/`build_implicit_exception_table` 构造两张表 → `finalize_stubs` 收尾。所有步骤产出写入 `CodeBuffer`，最终由编译驱动的 `install_code` → `register_method` 装入 Code Cache。数据流上，输入是 ELF object + 编译期记录的 call site/oop 句柄，输出是填满的 `CodeBuffer` + 两张异常表 + CodeOffsets。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `install_obj` | 接收并解析 ELF | `createELFObjectFile` 失败即报错；`_elf` 持有 ELF 对象 |
| `finalize` | 主装配流程 | 指令段 + 重定位 + 元数据表串起；含 IC 检查/栈溢出检查 |
| `setup_frame_size` | 确定栈帧 | 从 LLVM `emitStackSizeSection` 元信息解析 |
| `resolve_reloc_info` | 解析全部重定位 | 四步：JITLink 边 + StackMap record + 排序 + fixup+emit |
| `lookup_const_section` | 常量段缓存 | 首次见某 `.rodata` 段拷进 CodeBuffer 常量区，后续直接查地址 |
| `resolve_const_edge` | 算常量目标地址 | 段基址 + 段内偏移 |
| `build_oop_map` | StackMap→OopMap | 成对读 base/derived 位置，区分 oop 与派生指针 |
| `build_exception_handler_table` | 构造异常表 | 解码 `.gcc_except_table` 的 ULEB128 调用点表 |
| `build_implicit_exception_table` | 构造隐式异常表 | 解析 `.llvm_faultmaps` 的 faulting→handler PC 映射 |
| `ReadELF::findFunc` | 符号定位 | 遍历 ELF 符号表找 ST_Function，返回对齐/offset/size |
| `ReadELF::findSection` | 段定位 | 按名遍历段表 |

</details>

## 核心实现

### resolve_reloc_info：重定位的四步处理

这是模块最核心也最复杂的方法。LLVM 发射的 ELF 里，调用点、常量引用、oop 引用都以重定位边（JITLink edge）或 StackMap record 的形式存在；HotSpot 的 `CodeBuffer` 需要的是 `relocInfo` 与各类桩。方法分四步完成这个映射：

**Step 1 — 解析 JITLink 边**：`createLinkGraphFromObject` 把 ELF 重定位建成 `LinkGraph`，遍历 `.text` 段的边，按 `JeandleAssembler::is_*_reloc_kind` 分三类：

```cpp title="jeandleCompiledCode.cpp"
if (!target.isDefined() && JeandleAssembler::is_routine_call_reloc_kind(edge.getKind())) {
  // 例程调用：用边目标名查 _routine_entry，建 ROUTINE_CALL CallSiteInfo
  address target_addr = JeandleRuntimeRoutine::get_routine_entry(*target.getName());
  _routine_call_sites[inst_end_offset] = new CallSiteInfo(JeandleCompiledCall::ROUTINE_CALL, target_addr, -1);
} else if (target.isDefined() && JeandleAssembler::is_const_reloc_kind(edge.getKind())) {
  // 常量引用：resolve_const_edge 算地址，建 JeandleConstReloc
  relocs.push_back(new JeandleConstReloc(*block, edge, resolve_const_edge(*block, edge, assembler)));
} else if (!target.isDefined() && JeandleAssembler::is_oop_reloc_kind(edge.getKind())) {
  // oop 引用：用边目标名查 _oop_handles，建 JeandleOopReloc
  relocs.push_back(new JeandleOopReloc(..., _oop_handles[(*(target.getName()))]));
}
```

**Step 2 — 解析 StackMap**：读 `.llvm_stackmaps` 段，用 `StackMapParser` 遍历 record。每个 record 对应一个 statepoint 调用点，按 record ID 匹配编译期记录的 `CallSiteInfo`：ID < non_routine 数则取 `non_routine_call_sites[ID]`（Java 调用/VM stub 调用），否则按 offset 取 `routine_call_sites`（例程调用）。匹配后 `build_oop_map` 还原 OopMap，建 `JeandleCallReloc`。这套 ID/offset 双匹配是 Jeandle 区分"编译期已知 statepoint id"与"运行期重定位 offset"两类调用点的机制——前者用 id，后者用 offset，对应 `JeandleCompiledCall` 的四类调用策略。

**Step 3—4 — 排序与发射**：所有 `JeandleReloc` 按 offset 排序，`fixup_offset(_prolog_length)` 把相对偏移加上 prolog 长度（因为 Jeandle 在 LLVM 产出前插入了 IC 检查/verified entry/prolog），最后 `emit_reloc` 多态分派到 `JeandleAssembler` 的具体桩方法。这个"先收集后统一发射"避免了按段顺序混合处理两类来源（JITLink 边与 StackMap record）的复杂性。

### JeandleCallReloc：调用点与 debug info 装配

`JeandleCallReloc::emit_reloc` 是调用点的核心——它不仅要 patch 调用指令，还要为该调用点生成完整的 debug info（供 GC 与异常 unwind）。按 `JeandleCompiledCall::Type` 分派四类桩：`STATIC_CALL` 生成 static call stub 并 patch、`DYNAMIC_CALL` patch inline cache、`STUB_C_CALL` patch C 调用、`ROUTINE_CALL` 直接 patch 目标地址。`process_oop_map` 把 OopMap 通过 `DebugInformationRecorder` 登记为 safepoint，并 `describe_scope` 记录方法/bci/局部/表达式/monitor 的 scope 栈——这是 deopt 与栈回溯的依据（注释标注 `// No deopt support now`，目前 scope 信息为空占位）。

### OopMap 构建：成对的 base/derived 位置

`build_oop_map` 从 StackMap record 的 location 列表还原 GC 根位置。Jeandle 的 StackMap 用**成对编码**——每个对象引用用两个连续 location 表达：base（对象本身或派生它的基础指针）与 derived（实际指针）。解析时步进 2：

```cpp title="jeandleCompiledCode.cpp"
for (auto location = record->location_begin(); location != record->location_end(); location++) {
  auto base_location = *location;
  location++;
  auto derived_location = *location;
  VMReg reg_base = resolve_vmreg(base_location, base_kind);
  VMReg reg_derived = resolve_vmreg(derived_location, derived_kind);
  if (reg_base == reg_derived) {
    oop_map->set_oop(reg_base);          // 普通 oop
  } else {
    Unimplemented();                      // 派生指针（暂未支持）
  }
}
```

`resolve_vmreg` 把 StackMap 的 `LocationKind` 翻译成 HotSpot `VMReg`：`Register` 类用 DWARF 寄存器号经 `JeandleRegister::decode_dwarf_register` 转换，`Indirect` 类断言是栈指针并按偏移算栈槽。这是 LLVM StackMap 抽象位置→HotSpot 具体位置的标准桥接。派生指针（如 `int[]` 内部指针）目前 `Unimplemented`，是当前 GC 支持的已知边界。

### 异常表与隐式异常表

两张表分别从两个 ELF 段解码，都需 `_prolog_length` 偏移修正：

- `build_exception_handler_table`：解码 `.gcc_except_table`。该段由 jeandle-llvm 的 `EHStreamer::emitExceptionTable` 生成，编码为 ULEB128 的调用点表（start/length/landing_pad/action）。Jeandle 只用 start+length+landing_pad 三元组登记到 `JeandleExceptionHandlerTable`，action 表项读取后丢弃。运行期 `search_landingpad` 例程用此表把异常 PC 映射到 handler PC。
- `build_implicit_exception_table`：解码 `.llvm_faultmaps`。`FaultMapParser` 读 faulting PC→handler PC 映射——即每个隐式 null/除零检查的 trap 点与其对应 handler。这是与抽象解释器 `MD_make_implicit` 标记配套的：编译期标记隐式检查，LLVM 生成 fault map，本模块把它装入 `ImplicitExceptionTable` 供 JVM 在硬件 trap 时跳转。

### 帧大小与 verified entry

`setup_frame_size` 从 LLVM 的 `EmitStackSizeSection` 元信息（编译器初始化时开启 `options.EmitStackSizeSection = true`）解析栈帧大小。`finalize` 开头对非静态方法发 `emit_ic_check`（inline cache 校验，receiver 类型检查）、`emit_verified_entry`（verified entry 点），并按 `need_stack_overflow_check` 决定是否发栈溢出 bang——这个函数复刻 HotSpot 的"有 Java 调用或帧大于页/8 才检查"的逻辑，保证栈溢出能被 guard page 捕获。这些 JVM 特有的入口/安全机制在 LLVM 产出之外追加，是代码生成模块对 HotSpot ABI 的补全。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 容器 + 协作工具 | `JeandleCompiledCode` + `ReadELF`/`JeandleAssembler` | 容器持有产物与流程，无状态工具可复用 |
| 模板方法 | `finalize` 四步流程 | 固定顺序（定位→发射→重定位→建表），步骤内可变 |
| 多态重定位 | `JeandleReloc` 基类 + 三子类 | 统一"收集→排序→发射"管线，三类重定位各自 `emit_reloc` |
| 策略（调用类型） | `JeandleCompiledCall::Type` + `emit_reloc` switch | 四类调用各有桩/重定位策略 |

## 模块间交互

代码生成**向上**被编译驱动调用（`JeandleCompilation::compile_module` 调 `install_obj`、`compile_java_method` 末尾调 `finalize`、`install_code` 读其 `code_buffer`/`offsets`/表）；**向下**依赖运行时例程模块（`resolve_reloc_info` 用 `JeandleRuntimeRoutine::get_routine_entry` 解析例程调用目标）；**向上**接收抽象解释器的产出（`push_non_routine_call_site` 记录的调用点与 `oop_handles` 登记的 oop，在 `resolve_reloc_info` Step 2 匹配）。`JeandleRegister` 是 CPU 相关的寄存器抽象，被本模块（DWARF 寄存器→VMReg）与运行时例程模块（current_thread/stack_pointer 寄存器名）共用。

## 扩展方式

- **支持派生指针 OopMap**：在 `build_oop_map` 的 `Unimplemented` 分支实现 `derived_oop_slot` 登记，需配合 jeandle-llvm 的 StackMap 派生指针编码。
- **新增调用类型桩**：在 `JeandleAssembler`（CPU 相关 `.cpp`）加 `patch_*_call_site`，并在 `JeandleCompiledCall` 调整 `call_site_size`/`call_site_patch_size`。
- **deopt 支持**：填充 `JeandleCallReloc::process_oop_map` 当前为空的 scope 信息（locarray/exparray/monarray），并实现 `deoptimize_caller_frame`（多处 TODO）。
