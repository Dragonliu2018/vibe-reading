---
source:
  type: "源码解读"
  project: "LLVM"
  url: "https://github.com/llvm/llvm-project"
title: "Target 目标描述"
date: "2026-08-20T10:23:42+08:00"
category: ["Languages", "C/C++", "Tools", "LLVM", "CodeWiki", "24"]
tags: ["LLVM", "TableGen", "TargetMachine", "TargetLowering", "Subtarget"]
description: "LLVM 目标架构抽象——TableGen DSL 声明式描述、TargetLowering 合法化表、静态注册后端"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/00-overview)

---

## 模块定位

Target 模块是"加一个新架构只加一个目录"的关键——用 TableGen DSL 声明式描述目标（指令/寄存器/调用约定/选择 pattern），由 `llvm-tblgen` 编译生成大量 `.inc` 代码供 CodeGen 复用；`TargetMachine`/`TargetLowering`/`TargetInstrInfo` 等接口由各后端实现。30+ 后端（X86/AArch64/ARM/RISCV/AMDGPU/NVPTX…）共享同一套框架，代码量大（1.18M 行）但 90%+ 是各后端的重复结构。这是 LLVM 相对其他编译器最独特的设计：把目标描述从命令式 C++ 提升为声明式数据 + 代码生成。

## 模块架构

```
声明层（.td DSL）                        生成层（llvm-tblgen → .inc）           实现层（后端 C++）
┌──────────────────────┐   ┌──────────────────────────┐   ┌─────────────────────────┐
│ Target.td（根定义）    │   │ DAGISelEmitter            │   │ X86.td                  │
│  Register/Instruction │   │  ConvertPatternToMatcherList│   │ X86InstrInfo.td          │
│  Pattern/Target       │   │  → X86GenDAGISel.inc      │   │ X86ISelDAGToDAG.cpp      │
│  SubtargetFeature     │   │  (SelectCode)              │   │  #include GenDAGISel.inc  │
│  Predicate            │   │ InstrInfoEmitter          │   │ X86ISelLowering.cpp      │
│ TargetSelectionDAG.td │   │  → X86GenInstrInfo.inc    │   │  (setOperationAction)    │
│  SDNode/PatFrags/     │   │ RegisterInfoEmitter       │   │ X86Subtarget.h           │
│  ComplexPattern       │   │  → X86GenRegisterInfo.inc │   │  (继承 GenSubtargetInfo)  │
└──────────────────────┘   │ SubtargetEmitter           │   │ X86TargetInfo.cpp        │
        │                  │  → X86GenSubtargetInfo.inc │   │  (RegisterTarget 注册)    │
        ▼                  └──────────────────────────┘   └─────────────────────────┘
   utils/TableGen/（生成器）          #include 到后端 C++
```

## 调用链路

TableGen 从 `.td` 到 `.inc` 的生成流程：

```
.td 文件（Target.td + X86.td + X86InstrInfo.td...）
  │
  ▼ llvm-tblgen -gen-dag-isel（DAGISelEmitter）          [utils/TableGen/DAGISelEmitter.cpp:152]
  ├─ run(): 解析所有 Pattern
  ├─ PatternSortingPredicate                            # 按复杂度排序，复杂先匹配
  ├─ ConvertPatternToMatcherList()  # 每 pattern 转 Matcher 树  [:199]
  ├─ OptimizeMatcher()              # 合并共享前缀                       [:210]
  └─ EmitMatcherTable()             # 生成 C++ 代码表 → X86GenDAGISel.inc   [:215]
       │
       ▼ 被后端 #include
  X86ISelDAGToDAG.cpp:203 #include "X86GenDAGISel.inc"   # SelectCode 成为该类成员
  Select(SDNode*) → ... → SelectCode(Node)              [X86ISelDAGToDAG.cpp:7002]  # 回退到自动匹配
```

| 方法/类 | 一行职责 | 关键设计决策 |
|---------|---------|------------|
| `Target.td` DSL in `include/llvm/Target/Target.td` | 声明指令/寄存器/pattern 语法 | 声明式，一次描述多处生成 |
| `DAGISelEmitter` in `DAGISelEmitter.cpp:218` | Pattern→matcher 字节码 | 注册为 `gen-dag-isel` 后端 |
| `TargetMachine` in `TargetMachine.h:84` | 目标机器抽象 | `getSubtargetImpl`/`createPassConfig` 虚函数 |
| `TargetLowering` in `TargetLowering.h:218` | IR lower 接口 | `setOperationAction` 大开关表 |
| `RegisterTarget` in `TargetRegistry.h:1070` | 静态注册后端 | 链接期注册，零运行时开销 |

## 核心实现

### Target.td DSL 核心 def

```tablegen title="include/llvm/Target/Target.td"
class Register<string n> { list<Register> SubRegs = []; list<SubRegIndex> SubRegIndices = []; }
class RegisterClass<...> { dag MemberList = regList; }     // 支持集合运算 add/sub/sequence
class Instruction {
  dag OutOperandList;          // (outs R32:$dst)
  dag InOperandList;           // (ins R32:$src1, R32:$src2)
  string AsmString = "";       // "add{l}\t{$src2, $dst|$dst, $src2}"
  list<dag> Pattern;           // [(set R32:$dst, (add R32:$src1, R32:$src2))]
  list<Predicate> Predicates = [];
}
class SubtargetFeature<string n, string f, string v, string d, list<SubtargetFeature> i = []> {
  list<SubtargetFeature> Implies = i;   // 隐含特性，如 AVX implies SSE4.2
}
```

X86 实例（`lib/Target/X86/X86.td:82`）：

```tablegen title="lib/Target/X86/X86.td:82"
def FeatureAVX : SubtargetFeature<"avx", "X86SSELevel", "AVX", "Enable AVX", [FeatureSSE42]>;
def X86 : Target { let InstructionSet = X86InstrInfo; let AssemblyParserVariants = [ATT,Intel]; }
```

### TableGen 代码生成

`DAGISelEmitter`（`DAGISelEmitter.cpp:152`）解析所有 `.td` 的 Pattern，`ConvertPatternToMatcherList`（`:199`）把每 pattern 转 Matcher 树，`OptimizeMatcher`（`:210`）合并共享前缀，`EmitMatcherTable`（`:215`）生成 `X86GenDAGISel.inc` 的 `SelectCode`——一个巨大 switch/if-else 链。后端 `Select` 处理完自定义逻辑后调 `SelectCode(Node)`（`X86ISelDAGToDAG.cpp:7002`）回退到自动匹配。同理 `InstrInfoEmitter`/`RegisterInfoEmitter`/`SubtargetEmitter` 生成 `X86GenInstrInfo.inc`/`X86GenRegisterInfo.inc`/`X86GenSubtargetInfo.inc`，被后端 `#include`。

**为什么用 DSL 而非手写**：30+ 后端的指令集描述高度重复——每条指令需定义编码、操作数、汇编语法、选择 pattern、调度信息。手写每条数百行 C++ 样板。DSL 让开发者声明式描述一次，生成器自动产出所有消费方代码（选择器/编码器/汇编器/反汇编器/调度模型）——"前端描述，后端生成"。

### TargetLowering 合法化大开关表

`LegalizeAction` 枚举（`TargetLowering.h:222`：`Legal`/`Promote`/`Expand`/`LibCall`/`Custom`）把"目标不支持的操作如何处理"建模为有限策略集，`OpActions[MVT][Opcode]` 二维表是扩展点：

```cpp title="include/llvm/CodeGen/TargetLowering.h:2715"
void setOperationAction(unsigned Op, MVT VT, LegalizeAction Action) {
  OpActions[(unsigned)VT.SimpleTy][Op] = Action;   // 后端构造函数批量配置
}
virtual SDValue LowerOperation(SDValue Op, SelectionDAG &DAG) const;  // Custom hook
```

**为什么大开关表**：让 legalization 框架（`LegalizeDAG`/`LegalizeTypes`）目标无关——它查表知道该 promote 还是 expand，只有 `Custom` 才回调目标 `LowerOperation`，避免每后端重写整个框架。`Custom` 是逃生舱。

### RegisterTarget 静态注册

```cpp title="include/llvm/MC/TargetRegistry.h:1070"
template <Triple::ArchType TargetArchType, bool HasJIT = false>
struct RegisterTarget {
  RegisterTarget(Target &T, const char *Name, const char *Desc, const char *BackendName) {
    TargetRegistry::RegisterTarget(T, Name, Desc, BackendName, &getArchMatch, HasJIT);
  }
};
// lib/Target/X86/TargetInfo/X86TargetInfo.cpp:23
extern "C" void LLVMInitializeX86TargetInfo() {
  RegisterTarget<Triple::x86_64, true> Y(getTheX86_64Target(), "x86-64", "...", "X86");
}
```

**为什么静态注册**：C++ 静态初始化期间把后端注册到 `TargetRegistry` 全局链表。链接期注册——只有被链接进最终可执行文件的后端才注册（自动实现 `LLVM_TARGETS_TO_BUILD` 按需构建），运行时 `lookupTarget()` 只遍历已注册链表，零运行时开销，JIT 可运行时加载额外后端共享库。无 vtable 开销，用名字匹配 + `ArchType` 比较。

### Subtarget 多代 CPU 特性

`SubtargetFeature` 的 `Implies` 列表（如 AVX implies SSE4.2）形成特性依赖。TableGen 生成 `X86GenSubtargetInfo.inc` 的 `ParseSubtargetFeatures(CPU, TuneCPU, FS)`，`X86Subtarget`（`X86Subtarget.h:53`）继承它在 `initSubtargetFeatures` 解析 `-mcpu=skylake -mattr=+avx512f` 字符串设成员变量（如 `X86SSELevel=AVX512`）。`TargetMachine::getSubtargetImpl(const Function &F)` 支持**函数级 subtarget**（同一编译单元不同函数可有不同特性），指令 `Predicates` 引用特性作条件，`SelectCode` 只匹配当前特性满足的指令。分层查询 `hasSSE1()`/`hasAVX()`/`hasAVX512()`（`X86Subtarget.h:200`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 声明式代码生成 | `Target.td` + `DAGISelEmitter` → `.inc` | 声明一次，生成所有消费方 |
| 注册表宏 | `RegisterTarget` in `TargetRegistry.h:1070` | 链接期注册，零运行时开销 |
| Strategy | `TargetLowering::LegalizeAction` 表 in `TargetLowering.h:222` | 目标无关框架查表，`Custom` 是扩展点 |
| Subtarget 特性开关 | `SubtargetFeature` + `X86Subtarget` | 一 target 支持多代 CPU |
| Concept+Model | `MCTargetStreamer` 正交轴 | target×格式自由组合 |

## 模块间交互

依赖 `llvm/IR`（`Target.td` include `Intrinsics.td` 引入 intrinsic）、`llvm/CodeGen`（`TargetLowering`/`TargetInstrInfo`/`TargetRegisterInfo`/`TargetSubtargetInfo` 接口定义在 `include/llvm/CodeGen/`，各后端实现）、`llvm/MC`（`TargetMachine` 持 `MCAsmInfo`/`MCRegisterInfo`/`MCInstrInfo`/`MCSubtargetInfo`）、`llvm/Support`。"加一个新后端"的标准目录结构：`Foo.td` + `FooInstrInfo.td` + `FooRegisterInfo.td` + `FooTargetMachine` + `FooSubtarget` + `FooISelDAGToDAG`（继承 `SelectionDAGISel`，`#include GenDAGISel.inc`）+ `FooISelLowering` + `FooInstrInfo` + `FooRegisterInfo` + `AsmParser/` + `Disassembler/` + `MCTargetDesc/` + `TargetInfo/FooTargetInfo.cpp`（`RegisterTarget`）。

## 扩展方式

新增目标后端骨架：`lib/Target/Foo/Foo.td` 写 `def Foo : Target { let InstructionSet = FooInstrInfo; }` → `FooRegisterInfo.td` 定义 Register/RegisterClass → `FooInstrInfo.td` 定义 Instruction（含 Pattern）→ `TargetInfo/FooTargetInfo.cpp` 调 `RegisterTarget<Triple::foo>`（参考 `X86TargetInfo.cpp:23`）→ `FooISelLowering.cpp` 继承 `TargetLowering` 构造函数 `setOperationAction` 配置 → `FooISelDAGToDAG.cpp` 继承 `SelectionDAGISel` `#include "FooGenDAGISel.inc"` 实现 `Select` 回退 `SelectCode` → `CMakeLists.txt` 声明 .td 和 TableGen 后端。给后端加一条指令 pattern：`X86InstrInfo.td` 定义新 Instruction 含 `Pattern = [(set R32:$dst, (add R32:$src1, R32:$src2))]`，重新构建时 `llvm-tblgen -gen-dag-isel` 自动重新生成 `X86GenDAGISel.inc`（无需改工具），需 C++ 辅助匹配则定义 `ComplexPattern` 实现 `selectXxx` 函数。扩展 TableGen 后端：`utils/TableGen/DAGISelMatcherOpt.cpp` 改 `OptimizeMatcher` 优化 pass，注册新后端用 `OptClass<X>("gen-xxx", "...")` 模板（`DAGISelEmitter.cpp:218`）。
