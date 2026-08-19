---
source:
  type: "源码解读"
  project: "Jeandle-LLVM"
  url: "https://github.com/jeandle/jeandle-llvm"
title: "调用约定与目标适配"
date: "2026-08-19T19:41:28+08:00"
category: [Languages, Java, Tools, Jeandle-LLVM, CodeWiki, "main-2025-11"]
tags: ["Jeandle", "LLVM", "CallingConv", "X86", "AArch64"]
description: "Hotspot_JIT 调用约定、线程寄存器预留、栈帧保存与 statepoint 调用点对齐"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Tools/Jeandle-LLVM/CodeWiki/main-2025-11/00-overview)

---

## 模块定位

调用约定与目标适配模块是 Jeandle-LLVM 与 LLVM 后端代码生成的耦合点。它解决"LLVM 后端怎么按 Java 的 ABI 约定生成机器码"——具体包括：`Hotspot_JIT` 调用约定定义 Java 方法的寄存器传参顺序；后端预留线程寄存器与 compressed-oops 基址寄存器（不许分配器占用）；栈帧强制保存 RBP/LR+FP 供栈回溯；statepoint 调用点对齐 4 字节供运行时 patching；ShrinkWrap pass 对 Java 方法禁用（避免破坏返回值）。这些改动散布在 X86 与 AArch64 两个后端及 `CodeGen` 目录，每处几行到几十行，但合起来构成了"让 LLVM 给 Java 生成正确机器码"的完整适配。这个模块独立，因为后端适配与其他模块正交——它不碰 IR、不碰 GC 策略，只在 `CallingConv::Hotspot_JIT` 命中时改后端行为。

## 模块架构

```
CallingConv::Hotspot_JIT = 112          ← 调用约定 ID（CallingConv.h）
        │
        ├──── X86 后端 ────────────────────────────────┐
        │  X86CallingConv.td  CC_X86_64_Hotspot_JIT     │
        │    args: [RSI,RDX,RCX,R8,R9,RDI] (j_rarg序)  │
        │    CSR_64_Hotspot_JIT: 只保留 RBP            │
        │  X86RegisterInfo.cpp  预留 R15(rthread)      │
        │    + R12(rheapbase, 若 use-compressed-oops)  │
        │  X86FrameLowering.cpp  强制 SavedRegs.set(RBP)│
        │  X86MCInstLower.cpp  statepoint 调用点 4B 对齐│
        │  ShrinkWrap.cpp  命中 Hotspot_JIT 直接 return │
        ├──── AArch64 后端 ───────────────────────────┐
        │  AArch64CallingConvention.td  CC_AArch64_Hotspot_JIT
        │    args: [X1..X7,X0] (j_rarg 序，rotate)     │
        │    CSR_AArch64_Hotspot_JIT: 保留 LR,FP       │
        │  AArch64RegisterInfo.cpp  预留 X28(rthread)  │
        │    + X27(rheapbase, 若 compressed-oops)      │
        │    + X8/X9 (scratch)                          │
        │  AArch64FrameLowering.cpp  保存 LR & FP       │
        └──── 共用 ─────────────────────────────────┘
           CallingConv.h  Hotspot_JIT=112
           AsmParser/AsmWriter  hotspotcc 文本（见 GC 基础设施模块）
```

所有适配都以 `CallingConv::Hotspot_JIT` 为开关——后端代码里反复出现 `if (MF.getFunction().getCallingConv() == CallingConv::Hotspot_JIT)`，命中才特化。这把 Java 适配严格隔离：非 Java 函数（C/C++ 编译）走上游默认路径，行为完全不变。

## 调用链路

以 X86 编译一个 Java 方法为例，后端各环节按调用约定工作的链路：

```
llc / JeandleCompilation → IR 函数标 hotspotcc
  └─ ISel: 按 CC_X86_64_Hotspot_JIT 分配参数寄存器
       └─ X86RegisterInfo::getReservedRegs(): 预留 R15 (+R12 if compressed-oops)
            └─ X86FrameLowering::determineCalleeSaves(): 强制保留 RBP
                 └─ ShrinkWrap::runOnMachineFunction(): 命中 Hotspot_JIT → return false（跳过）
                      └─ X86MCInstLower: statepoint 调用点 emitCodeAlignment(4) + nops
```

<details>
<summary>方法速查表</summary>

| 方法/定义 | 位置 | 一行职责 |
|-----------|------|---------|
| `CC_X86_64_Hotspot_JIT` | `X86CallingConv.td:1060` | X86 Java 参数寄存器顺序 |
| `CC_AArch64_Hotspot_JIT` | `AArch64CallingConvention.td:578` | AArch64 Java 参数寄存器顺序 |
| `getReservedRegs` | `X86RegisterInfo.cpp:661` / `AArch64RegisterInfo.cpp:496` | 预留线程/堆基址/scratch 寄存器 |
| `determineCalleeSaves` | `X86FrameLowering.cpp:3189` / `AArch64FrameLowering.cpp:3679` | 强制保存 RBP / LR+FP |
| `ShrinkWrap::runOnMachineFunction` | `ShrinkWrap.cpp:922` | Java 方法直接跳过 |
| `X86MCInstLower` (statepoint) | `X86MCInstLower.cpp:800` | 调用点 4 字节对齐 + nops |

</details>

## 核心实现

### Hotspot_JIT 调用约定与寄存器分配

`Hotspot_JIT = 112` 是一个调用约定 ID，定义在上游头文件里：

```cpp title="llvm/include/llvm/IR/CallingConv.h（Jeandle 改动片段）"
/// Calling convention which is compatible with Hotspot JIT compiler's
Hotspot_JIT = 112,
```

调用约定的真正规则用 TableGen 的 `.td` 描述，编译期生成 C++ 代码。X86 的定义：

```cpp title="llvm/lib/Target/X86/X86CallingConv.td"
def CC_X86_64_Hotspot_JIT : CallingConv<
  // C       | rdi rsi rdx rcx r8  r9     (C 的 c_rarg 顺序)
  // Java    | rsi rdx rcx r8  r9  rdi    (Java 的 j_rarg 顺序)
  // j_rarg0  j_rarg1 ... j_rarg5 映射到 RSI RDX RCX R8 R9 RDI
[
  CCIfType<[i32], CCAssignToReg<[ESI, EDX, ECX, R8D, R9D, EDI]>>,
  CCIfType<[i64], CCAssignToReg<[RSI, RDX, RCX, R8, R9, RDI]>>,
  CCDelegateTo<CC_X86_64_C>     // 其余同 C 调用约定
]>;

// 入口路由
CCIfCC<"CallingConv::Hotspot_JIT", CCDelegateTo<CC_X86_64_Hotspot_JIT>>,
```

Java 调用约定的寄存器顺序与 C **不同**——这是适配 HotSpot 的关键。HotSpot 的 `j_rarg0..5` 映射到 `RSI, RDX, RCX, R8, R9, RDI`，而 C 的 `c_rarg0..5` 是 `RDI, RSI, RDX, RCX, R8, R9`。`.td` 文件顶部画出了这个对照表，注释指明唯一文档是 OpenJDK 的 `assembler_x86.hpp`。`X86/calling-conv.ll` 测试验证：6 个 i32 参数 `a1..a6` 落在 `esi, edx, ecx, r8d, r9d, edi`，求和时的寄存器使用与约定一致。

AArch64 同理但寄存器是"旋转"排列：

```cpp title="llvm/lib/Target/AArch64/AArch64CallingConvention.td"
//  | X0 X1 X2 X3 X4 X5 X6 X7 |  (C)
//  | c_rarg0 ... c_rarg7     |
//  | X1 X2 X3 X4 X5 X6 X7 X0 |  (Java，rotate by 1)
//  | j_rarg0 ... j_rarg7     |
let Entry = 1 in
def CC_AArch64_Hotspot_JIT : CallingConv<
[
  CCIfType<[i32], CCAssignToReg<[W1, W2, W3, W4, W5, W6, W7, W0]>>,
  CCIfType<[i64], CCAssignToReg<[X1, X2, X3, X4, X5, X6, X7, X0]>>,
  CCIfType<[f32], CCAssignToReg<[S0, S1, S2, S3, S4, S5, S6, S7]>>,
  CCIfType<[f64], CCAssignToReg<[D0, D1, D2, D3, D4, D5, D6, D7]>>,
  CCDelegateTo<CC_AArch64_AAPCS>
]>;
```

AArch64 上 Java 的 `j_rarg0` 是 X1 而非 C 的 X0——整个序列左旋一位，`j_rarg7` 落到 X0。浮点参数仍按 AAPCS（S0-S7/D0-D7），与 C 一致。这种"整数寄存器旋转、浮点不变"的设计匹配 HotSpot AArch64 的约定（见 `assembler_aarch64.hpp`）。

被调用者保存寄存器（callee-saved）也按 Java 约定收窄：X86 的 `CSR_64_Hotspot_JIT` 只保留 RBP，AArch64 的 `CSR_AArch64_Hotspot_JIT` 保留 LR 与 FP。这给了寄存器分配器更多 caller-saved 寄存器——JIT 编译的 Java 方法调用频繁，减少 callee-saved 能降低保存/恢复开销。

### 线程寄存器与 compressed-oops 预留

HotSpot 运行时要求若干物理寄存器全程持有固定值：线程寄存器（`rthread`）指向当前线程对象，compressed-oops 基址寄存器（`rheapbase`）持有堆基址。这些寄存器绝不能被 LLVM 分配器挪用。Jeandle 在 `getReservedRegs` 里预留它们：

```cpp title="llvm/lib/Target/X86/X86RegisterInfo.cpp"
if (MF.getFunction().getCallingConv() == CallingConv::Hotspot_JIT) {
  for (MCRegAliasIterator AI(X86::R15, this, true); AI.isValid(); ++AI)
    Reserved.set(*AI);                          // rthread = R15（含所有别名寄存器）
  if (MF.getFunction().hasFnAttribute("use-compressed-oops")) {
    for (MCRegAliasIterator AI(X86::R12, this, true); AI.isValid(); ++AI)
      Reserved.set(*AI);                        // rheapbase = R12（仅压缩指针模式）
  }
}
```

R15（`rthread`）无条件预留——所有 Java 方法都要访问线程局部数据。R12（`rheapbase`）仅当函数有 `use-compressed-oops` 属性时预留——没有开压缩指针时 R12 可正常分配。`MCRegAliasIterator` 遍历 R15/R12 的所有别名子寄存器（如 R15 → RH15 等），全部置预留，防止分配器通过别名"绕过"。`X86/calling-conv.ll` 的 `test_reserved_regs` 用例验证：开 `use-compressed-oops` 时 R12 与 R15 都不被分配器用作临时寄存器（`CHECK-NOT: movq ... %r12` / `%r15`）。

AArch64 上的等价实现：

```cpp title="llvm/lib/Target/AArch64/AArch64RegisterInfo.cpp"
if (MF.getFunction().getCallingConv() == CallingConv::Hotspot_JIT) {
  if (MF.getFunction().hasFnAttribute("use-compressed-oops")) {
    markSuperRegs(Reserved, AArch64::X27);     // rheapbase = X27（仅压缩模式）
    markSuperRegs(Reserved, AArch64::W27);
  }
  markSuperRegs(Reserved, AArch64::X28);       // rthread = X28（无条件）
  markSuperRegs(Reserved, AArch64::W28);
  markSuperRegs(Reserved, AArch64::X8);         // scratch = X8/X9
  markSuperRegs(Reserved, AArch64::X9);
  markSuperRegs(Reserved, AArch64::W8);
  markSuperRegs(Reserved, AArch64::W9);
}
```

除了线程寄存器（X28）与堆基址（X27，条件性），AArch64 还预留 X8/X9 作 scratch——HotSpot 运行时调用约定需要保留 scratch 寄存器给运行时例程使用。寄存器映射的架构对照：X86 用 R15/R12，AArch64 用 X28/X27，两者都把"线程寄存器无条件预留 + 堆基址条件预留"的模式一致地落地。

### 栈帧保存与 ShrinkWrap 禁用

Java 方法需要可被栈回溯（GC、异常、profiling 都要遍历栈帧），所以栈帧必须按固定格式保存帧指针。X86 强制保留 RBP：

```cpp title="llvm/lib/Target/X86/X86FrameLowering.cpp"
if (MF.getFunction().getCallingConv() == CallingConv::Hotspot_JIT) {
  SavedRegs.set(X86::RBP);
}
```

配合调用约定 CSR 只保留 RBP，这意味着每个 Java 方法都 `pushq %rbp` / `popq %rbp`，并配 CFI unwind 信息——`X86/frame-pointer.ll` 测试验证了 `.cfi_def_cfa_offset` / `.cfi_offset %rbp` 序列。AArch64 对应：

```cpp title="llvm/lib/Target/AArch64/AArch64FrameLowering.cpp"
// Hotspot always save LR & FP for stack unwinding
if (MF.getFunction().getCallingConv() == CallingConv::Hotspot_JIT) {
  // ... 保存 LR & FP（见 determineCalleeSaves）
}
```

`ShrinkWrap` pass 会把 prolog/epilog 从函数入口/出口移到更靠内的位置以省栈帧，但这会破坏 Java 方法的栈回溯——它假设帧指针在入口就绪。Jeandle 直接对 Java 方法禁用它：

```cpp title="llvm/lib/CodeGen/ShrinkWrap.cpp（Jeandle 改动片段）"
if (skipFunction(MF.getFunction()) || MF.empty() || !isShrinkWrapEnabled(MF))
  return false;

if (MF.getFunction().getCallingConv() == CallingConv::Hotspot_JIT) {
  return false;   // Java 方法不跑 ShrinkWrap
}
```

PR #8 的提交信息解释了更具体的动机：ShrinkWrap 移动 epilog 后，`pop` 指令可能覆盖被 RBP 临时存放的返回值，破坏返回——这是 Java 方法栈帧约定与 ShrinkWrap 优化的根本冲突，禁用是最稳妥的解。

### Statepoint 调用点对齐

HotSpot 在运行时可能把 statepoint 调用点 patch 成其他指令（如 safepoint 轮询），这要求调用点的 nop 填充区按 4 字节对齐，且 patch 在多线程下安全。Jeandle 在 `X86MCInstLower` 特化 statepoint 的 lowering：

```cpp title="llvm/lib/Target/X86/X86MCInstLower.cpp"
StatepointOpers SOpers(&MI);
if (unsigned PatchBytes = SOpers.getNumPatchBytes()) {
  if (SOpers.getCallingConv() == CallingConv::Hotspot_JIT) {
    // Make the end of the nops to be 4 byte aligned.
    // This is required to make call site patching multi-thread safe.
    OutStreamer->emitCodeAlignment(Align(4), &getSubtargetInfo());
    emitX86Nops(*OutStreamer, 4 - (PatchBytes % 4), Subtarget);  // 补齐到 4 字节倍
    emitX86Nops(*OutStreamer, PatchBytes, Subtarget);           // 再发 PatchBytes 个 nop
  } else {
    emitX86Nops(*OutStreamer, PatchBytes, Subtarget);          // 非 Java：直接 nop
  }
}
```

`getNumPatchBytes()` 来自 statepoint 的 `statepoint-num-patch-bytes` 属性——jeandle-jdk 指定要预留多少可 patch 字节。Java 路径先 `emitCodeAlignment(4)` 把当前位置对齐到 4 字节边界，再补 `4 - (PatchBytes % 4)` 个 nop 凑齐，最后发 `PatchBytes` 个 nop。这样 nop 区起点和终点都 4 字节对齐，运行时原子 patch 一个 4 字节指令不会撕裂——这是 x86 多线程安全的 patching 要求。`X86/call-site-align.ll` 验证输出含 `.p2align 2`（4 字节对齐）与两组 `nopl`。这条逻辑只对 `Hotspot_JIT` 调用约定的 statepoint 生效，非 Java statepoint 走上游默认的单纯 nop 填充。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 特性开关（调用约定守卫） | 所有后端文件的 `if (...== CallingConv::Hotspot_JIT)` | 把 Java 适配严格隔离到调用约定命中时，非 Java 函数零行为变化 |
| TableGen 声明式描述 | `X86CallingConv.td` / `AArch64CallingConvention.td` | 复用上游 TableGen 框架生成寄存器分配代码，不必手写 C++ 分配逻辑 |
| 寄存器别名全预留 | `MCRegAliasIterator` / `markSuperRegs` | 预留一个物理寄存器必须连所有子寄存器别名一起，否则分配器从别名绕过 |

## 模块间交互

目标适配层与 GC 基础设施层共享 `Hotspot_JIT` 调用约定 ID 与 `use-compressed-oops` 属性名——前者定义在 `CallingConv.h`，后者在 `Attributes.h`，后端读它们决定行为。它依赖 IR 层的函数属性（`getCallingConv()`、`hasFnAttribute`），这些由 jeandle-jdk 抽象解释器在产出 IR 时贴上。与流水线层无直接交互——后端适配发生在 IR 全部降级之后的 CodeGen 阶段，由 `llc` 或 jeandle-jdk 的代码生成阶段触发。X86 与 AArch64 两套适配是平行的，各自独立维护，CI 默认只测 X86，AArch64 靠 PR label 触发。

## 扩展方式

适配新架构（如 RISC-V）的范式参考 X86/AArch64：在 `RISCVCallingConv.td` 定义 `CC_RISCV_Hotspot_JIT`（Java 寄存器顺序）、在 `RISCVRegisterInfo.cpp` 预留线程寄存器（参考 HotSpot RISC-V 端口约定）、在 `RISCVFrameLowering.cpp` 强制保存帧指针、在 `RISCVMCInstLower.cpp` 处理 statepoint 对齐（若该架构需要）。`CallingConv::Hotspot_JIT = 112` 可复用——它跨架构通用。CI 已在 `jeandle-llvm-test.yml` 预留 `HAS_RISCV` 分支，打 `RISC-V` label 即开启该 target 构建。
