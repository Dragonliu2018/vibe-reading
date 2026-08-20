---
source:
  type: "源码解读"
  project: "LLVM"
  url: "https://github.com/llvm/llvm-project"
title: "CodeGen 后端"
date: "2026-08-20T10:23:42+08:00"
category: ["Languages", "C/C++", "Tools", "LLVM", "CodeWiki", "24"]
tags: ["LLVM", "CodeGen", "SelectionDAG", "GlobalISel", "RegAlloc", "MachineInstr"]
description: "LLVM 后端——SelectionDAG/GlobalISel 指令选择、Greedy 寄存器分配、MachineInstr 机器级 IR"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/00-overview)

---

## 模块定位

CodeGen 是目标无关的后端框架——把优化后的 IR 翻译成机器指令、做寄存器分配与调度。它与 Target 模块分工：CodeGen 提供"后端怎么干"的通用框架（`MachineFunction`/`MachineInstr` 容器、`SelectionDAGISel` 选择骨架、`RegAllocBase` 分配框架、`MachineScheduler` 调度），Target 提供"目标具体信息"（`TargetLowering` 决定哪些操作合法、`TargetInstrInfo` 描述指令、`TargetRegisterInfo` 描述寄存器）。这种分离让"加一个新架构"只需实现 target-specific 部分而复用整个框架。

## 模块架构

```
IR Function ──指令选择──► MachineFunction/MachineInstr（机器级 IR，SSA 虚拟寄存器）
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │  SelectionDAG 路径（经典）        GlobalISel 路径（新）  │
   │  SelectionDAGBuilder→SDNode DAG   IRTranslator→G_* MI │
   │  →Combine→LegalizeTypes→          →Legalizer→          │
   │   LegalizeVectors→Legalize→        RegBankSelect→       │
   │   Combine→Select(SelectCode)       InstructionSelect   │
   │  →Schedule→MachineInstr           →target-specific MI  │
   └──────────────────────────┬───────────────────────────┘
                              ▼
              MachineInstr（vreg, SSA）──MachineFunctionProperties 状态契约──►
              PHI Elimination → LiveIntervals → RegAlloc(Greedy/Fast/PBQP) →
              VirtRegRewriter(vreg→phys) → PrologEpilog → Scheduling → BlockPlacement
                              ▼
              MachineInstr（phys reg）→ AsmPrinter → MC 层
```

两套指令选择共享同一套 `MachineFunction`/`MachineInstr` 机器级 IR 与后续 reg alloc/schedule 框架，`MachineFunctionProperties` 用状态属性（`IsSSA`/`Legalized`/`Selected`）保证 pass 顺序。

## 调用链路

SelectionDAG 路径（`SelectionDAGISel::runOnMachineFunction` in `SelectionDAGISel.cpp:605`）：

```
runOnMachineFunction(MF)
  └─ SelectAllBasicBlocks(Fn)                                [SelectionDAGISel.cpp:1659]
       └─ 对每 BB: SelectBasicBlock → CodeGenAndEmitDAG()      [SelectionDAGISel.cpp:947]
            ├─ CurDAG->Combine(BeforeLegalizeTypes)            # DAG 合并 1
            ├─ CurDAG->LegalizeTypes()                        # 类型合法化
            ├─ CurDAG->Combine(AfterLegalizeTypes)            # 合并 2
            ├─ CurDAG->LegalizeVectors() → (if changed) LegalizeTypes()
            ├─ CurDAG->Combine(AfterLegalizeVectorOps)        # 合并 3
            ├─ CurDAG->Legalize()                             # 操作合法化
            ├─ CurDAG->Combine(AfterLegalizeDAG)              # 合并 4
            ├─ DoInstructionSelection() → Select(SDNode*)    # [virtual] SelectCodeCommon 解释 TableGen 字节码
            └─ CreateScheduler()->schedule() → MachineInstr
```

寄存器分配流程：

```
LiveIntervals::analyze(MF)  [SlotIndexes 编号→计算每 vreg 的 LiveInterval]
  → VirtRegMap::init(MF)    [建 vreg→preg / vreg→stackslot 映射]
  → RegAllocBase::allocatePhysRegs()  [RegAllocBase.h:103]
      循环: enqueue → dequeue → selectOrSplit
      ├─ RAGreedy::selectOrSplitImpl  [RegAllocGreedy.cpp:2650]  贪心+live range splitting+recoloring
      ├─ RegAllocFast（线性扫描，-O0/debug）
      └─ RegAllocPBQP（PBQP 图着色）
  → VirtRegRewriter（按 VirtRegMap 把 vreg 换 preg）
  → MachineInstr（全部物理寄存器）
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `CodeGenAndEmitDAG` in `SelectionDAGISel.cpp:947` | DAG 选择骨架 | Combine/Legalize 多轮交替，每层间有优化机会 |
| `SelectCodeCommon` in `SelectionDAGISel.h:485` | 解释 TableGen matcher table | 字节码 VM，`OPC_Scope`/`OPC_RecordNode` 等 |
| `RegAllocBase::allocatePhysRegs` in `RegAllocBase.h:103` | reg alloc driver | 策略可替换，共用同一 driver |
| `RAGreedy::selectOrSplitImpl` in `RegAllocGreedy.cpp:2650` | 贪心分配+splitting | -O2 默认 |

## 核心实现

### MachineFunction / MachineInstr 机器级 IR

```cpp title="include/llvm/CodeGen/MachineFunction.h:295"
class MachineFunction {
  Function &F;                          // 回指 IR Function（供调试信息关联）
  const TargetMachine &Target;
  const TargetSubtargetInfo &STI;
  MCContext &Ctx;
  MachineRegisterInfo *RegInfo;
  MachineFrameInfo *FrameInfo;
  BumpPtrAllocator Allocator;           // 池式分配
  Recycler<MachineInstr> InstructionRecycler;      // MachineInstr 池式管理
  ilist<MachineBasicBlock> BasicBlocks;
  MachineFunctionProperties Properties;  // SSA/NoPHIs/Legalized/Selected 状态契约
};
```

`MachineInstr`（`MachineInstr.h:72`）持 `MCInstrDesc*`（TableGen 生成，含操作数约束/隐式 def-use/调度模型）、`MachineOperand*` 数组（可表示寄存器/立即数/帧索引/全局地址）、`DebugLoc`。

**为什么用 MachineInstr 而非直接复用 IR**：IR 只有虚拟寄存器且语义硬编码在 opcode；`MachineInstr` 需要物理寄存器、指令编码信息（`MCInstrDesc`：tied operands/early clobber）、bundle 支持（VLIW 打包，`BundledPred`/`BundledSucc`）、机器语义操作数（帧索引/跳转表索引）。`MachineOperand` 联合体 `Contents` 可存 `RegNo+SubReg` 或立即数等。`MachineInstr` 由 `Recycler` 池式管理避免频繁分配。

### 两套指令选择

**SelectionDAG**（老）：`CodeGenAndEmitDAG` 固定 Combine→LegalizeTypes→LegalizeVectors→Legalize→Select 顺序，优势是成熟全面（所有后端支持、向量/类型合法化处理细），劣势是构建/销毁 DAG 开销大。**GlobalISel**（新）：`IRTranslator→Legalizer→RegBankSelect→InstructionSelect` 四步独立 pass，直接在 `MachineInstr` 上操作不需 DAG 中间表示，可增量、快速（适合 JIT/-O0），用 `MachineFunctionProperties` 声明依赖（`LegalizerLegacy` 要求 `IsSSA`、设置 `Legalized`，`Legalizer.h:65`），失败时 `FailedISel` 可 fallback 到 SelectionDAG。

### 寄存器分配多 pass 分离

`RegAllocBase`（`RegAllocBase.h:63`）抽象策略接口，`selectOrSplit` 返回可用物理寄存器或需 split 的新 vreg 列表。**为什么分多 pass**：`LiveIntervals` 计算需全局数据流分析，不能与分配混合（分配中 live range 会变）；`VirtRegMap` 维护 `Virt2PhysMap`/`Virt2StackSlotMap`，分配器只填表不直接改 MI；最后 `VirtRegRewriter` 据表把 vreg 换 preg——分离 rewrite 是因分配可能多次 split/溢出同一 vreg，直接改 MI 会不一致。

### 合法化（Legalization）多动作

`TargetLowering::LegalizeAction`（`TargetLowering.h:222`）：`Legal`/`Promote`（提升类型）/`Expand`（展开为多条指令或 libcall）/`LibCall`/`Custom`（`LowerOperation` hook）。`setOperationAction(Op, MVT, Action)` 写入 `[MVT][Opcode]→Action` 二维表。类型合法化 `LegalizeTypeAction`（`TargetLowering.h:232`）：`TypePromoteInteger`/`TypeExpandInteger`/`TypeSoftenFloat`/`TypeSplitVector`/`TypeWidenVector` 等。GlobalISel 的 `LegalizeAction`（`LegalizerInfo.h:44`）更细：`NarrowScalar`/`WidenScalar`/`FewerElements`/`MoreElements`/`Bitcast`/`Lower`/`Libcall`/`Custom`。

**为什么分多种动作**：不同操作有不同最优 lowering（i8 加法在 x86 promote 到 i32 更快，i64 除法在 32-bit 机 expand 成多条 32-bit 或 libcall）；`Custom` 是逃生舱让目标自定义；分层合法化（LegalizeTypes→Combine→LegalizeVectors→Combine→Legalize→Combine）每层间插 Combine 让优化更充分。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Strategy | `RegAllocBase` 三策略 in `RegAllocBase.h:63` | reg alloc 算法可替换，共用 driver |
| Template Method | `SelectionDAGISel` 骨架 + `Select()` 钩子 in `SelectionDAGISel.h:45` | 固定流程，子类只覆盖选择 |
| TableGen DAG Pattern | `SelectCodeCommon` 解释字节码 in `SelectionDAGISel.h:485` | .td Pattern 自动生成 matcher |
| Visitor | `SelectionDAGBuilder` in `SelectionDAG/SelectionDAGBuilder.cpp` | IR→DAG 按 opcode 分发 |
| Pipeline of Passes | `MachineFunctionPass` 链 + `MachineFunctionProperties` | 状态契约保证 pass 顺序 |
| Delegate | `MachineFunction::Delegate` in `MachineFunction.h:499` | MI 增删事件通知 LiveIntervals 增量更新 |

## 模块间交互

依赖 `llvm/IR`（MachineFunction 持 `Function&` 引用，指令选择从 IR 翻译）、`llvm/Analysis`（`MachineDominatorTree`/`MachineLoopInfo`/`AAResults`/`BatchAAResults`）、`llvm/CodeGen` 自身、`llvm/Target`（`getSubtarget()` 获取 `TargetLowering`/`TargetInstrInfo`/`TargetRegisterInfo`）、`llvm/MC`（持 `MCContext&`，AsmPrinter 经 MCStreamer 发射）。与 Target 分工：CodeGen 是目标无关框架，Target 提供目标具体信息。`MachineFunction` 通过 `getSubtarget()` 取 `TargetSubtargetInfo` 再取各 `Target*Info`。

## 扩展方式

新增一个后端 `MachineFunctionPass`：新建类继承 `MachineFunctionPass`（或新 PM `PassInfoMixin`）实现 `runOnMachineFunction(MF)`，需声明 properties 则覆盖 `getRequiredProperties`/`getSetProperties`/`getClearedProperties`（参考 `LegalizerLegacy` in `Legalizer.h:53`）→ 在目标 `TargetMachine.cpp` 的 `addPreRegAlloc`/`addPostRegAlloc` 等 hook 注册。加一种 reg alloc 策略：新建类继承 `RegAllocBase` 实现 `selectOrSplit`/`enqueueImpl`/`dequeue`/`spiller`，用 `RegisterRegAlloc` 注册（参考 `RegAllocGreedy.cpp:148`），可复用 `LiveIntervals`/`LiveRegMatrix`/`VirtRegMap`/`Spiller` 只改启发式。扩展 GlobalISel Legalizer 规则：目标 `FooLegalizerInfo.cpp` 用 `getActionDefinitionsBuilder(G_XXX).legalFor({s32}).clampScalar(...)` 等 DSL 声明（`LegalizerInfo.h`），需 Custom 则在 `InstructionSelector` 或 `LegalizerHelper` 实现。对应测试：`llvm/test/CodeGen/<Target>/`。
