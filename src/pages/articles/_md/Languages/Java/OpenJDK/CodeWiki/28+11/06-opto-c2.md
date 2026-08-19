---
source:
  type: "源码解读"
  project: "OpenJDK"
  url: "https://github.com/openjdk/jdk"
title: "C2 优化编译器"
date: "2026-08-19T23:29:36+08:00"
category: [Languages, Java, OpenJDK, CodeWiki, "28+11"]
tags: ["OpenJDK", "HotSpot", "C2", "opto", "Sea-of-Nodes", "Matcher", "Chaitin", "逃逸分析"]
description: "HotSpot C2 优化编译器——Sea-of-Nodes IR、Type lattice、Phase 优化流水线、Matcher 指令选择、图着色寄存器分配、逃逸分析"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/00-overview)

---

## 模块定位

C2 优化编译器模块（`share/opto/`，~202k 行）是 HotSpot 的服务端峰值编译器。它以字节码为输入，构造 **Sea-of-Nodes** 图 IR（数据流与控制流显式编码为节点边），经多阶段优化（逃逸分析、循环优化、内联、常量传播），最后用 Matcher 树形规则匹配到机器指令，Chaitin 图着色做寄存器分配，emit 机器码。C2 是分层编译的 tier 4，基于 tier 3 的 profile 数据做全局优化。与 C1 对比：C1 用线性 HIR/LIR + 线性扫描寄存器分配，无 EA/无 Sea-of-Nodes；C2 优化更激进但编译时间更长。

## 模块架构

![C2 编译流水线](/vibe-reading/images/articles/openjdk-hotspot/opto-flow.svg)

`Compile`（`compile.hpp:228`，继承 `Phase`）是编译主控制器，构造函数即主流程。流水线分两大段：`Optimize()`（`compile.cpp:3005`）做与机器无关的图优化——IGVN、增量内联、逃逸分析（标量替换/锁消除）、循环优化、CCP；`Code_Gen()`（`:3790`）做与机器相关的代码生成——Matcher 指令选择、PhaseCFG 全局代码运动、Chaitin 寄存器分配、PhaseOutput emit。`Node` 是所有 IR 节点基类，`Type` 提供 lattice 类型推断驱动优化，`Matcher` 用 ADLC 生成的规则表把 ideal 节点匹配到 `MachNode`。

## 调用链路

### C2 编译主流程

```
C2Compiler::compile_method(env, target, entry_bci)     (c2compiler.cpp:125)
  → Compile C(env, target, entry_bci, options)         (compile.cpp:659)  [构造即主流程]
     ├─ Init / CallGenerator::generate → Parse         (parse1.cpp:447)
     │    do_all_blocks → do_one_block → do_one_bytecode (parse2.cpp:2950)  # 逐字节码构 IR
     ├─ Optimize()                                       (compile.cpp:3005)
     │    ├─ PhaseIterGVN::optimize                     # 全局值编号+Ideal
     │    ├─ inline_incrementally / inline_boxing_calls  # 增量内联+装箱消除
     │    ├─ ConnectionGraph::do_analysis                # 逃逸分析 (escape.cpp:106)
     │    ├─ PhaseMacroExpand::eliminate_macro_nodes    # 标量替换/锁消除
     │    ├─ PhaseIdealLoop::optimize (LoopOptsDefault) # 循环 peel/unroll/RCE
     │    ├─ PhaseCCP::do_transform                      # 条件常量传播
     │    └─ final_graph_reshaping
     └─ Code_Gen()                                       (compile.cpp:3790)
          ├─ Matcher::match                              # 指令选择 (matcher.cpp:216)
          ├─ PhaseCFG::do_global_code_motion             # 全局代码运动 (gcm.cpp)
          ├─ PhaseChaitin::Register_Allocate             # 寄存器分配 (chaitin.cpp:356)
          └─ PhaseOutput::Output → install              # emit 机器码 (output.cpp:253/3302)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `Compile::Compile` (`compile.cpp:659`) | 编译主流程 | 构造即流程，栈上对象 |
| `Parse::do_one_bytecode` (`parse2.cpp:2950`) | 字节码→Node | 经 GraphKit 构 IR |
| `PhaseIterGVN::transform_old` (`phaseX.hpp:481`) | Ideal+Identity+GVN | 哈希去重+图重写 |
| `ConnectionGraph::compute_escape` (`escape.cpp:137`) | 逃逸分析 | 连接图+EscapeState |
| `PhaseIdealLoop::optimize` (`loopnode.hpp:1343`) | 循环优化 | build_and_optimize |
| `Matcher::ReduceInst` (`matcher.hpp:95`) | 生成 MachNode | DFA 树形规则匹配 |
| `PhaseChaitin::Register_Allocate` (`chaitin.cpp:356`) | 寄存器分配 | 图着色+spill-split |

</details>

## 核心实现

### Sea-of-Nodes IR

`Node`（`node.hpp:254`）注释明示"Nodes are both vertices in a directed graph and program primitives"。`_in`/`_out` 数组同时编码数据依赖与控制依赖，节点既是顶点也是程序原语。死代码消除用 `PhaseRemoveUseless`（`phaseX.hpp:151`）做 root 可达性分析。对比 LLVM 的基本块+线性 SSA 指令（需 def-use chains 遍历与 MemorySSA 处理内存依赖），C2 的图表示让依赖天然显式，`PhaseIdealLoop::get_early_ctrl`/`get_late_ctrl`（`loopnode.hpp:1051`）按 PIE 原则确定节点放置。代价是增量编译更难。关键 Node 子类：`MachNode`(机器指令，`machnode.hpp:222`)、`PhiNode`/`RegionNode`(控制流合并，`cfgnode.hpp`)、`MemNode`/`LoadNode`/`StoreNode`(内存，`memnode.hpp`)、`CmpNode`/`BoolNode`/`IfNode`(分支)、`AllocateNode`/`CallNode`、`CountedLoopNode`(`loopnode.hpp:240`)。

### Type lattice 驱动优化

`Type`（`type.hpp:86`）定义 lattice：`meet()`(下降，`:263`)/`join()`(上升)/`dual()`(对偶) 构成格。`Node::Value()`（`node.hpp:1283`）按输入 Type 计算输出 Type = 数据流分析。`PhaseCCP`（`phaseX.hpp:708`）乐观从 `Top` 单调下降（`saturate` 做 widen）收敛后证死分支；`PhaseGVN` 悲观从 `Bottom` 单调上升（narrow）。两者互补（`phaseX.hpp:369` 注释：CCP 的 deadly loop 恰是 GVN 快速解决的）。类型收敛使投机优化可行——如分支概率已知后可删死路径。子类：`TypeInt`/`TypeLong`(整数 RSD)、`TypePtr`(含 `TypeOopPtr`/`TypeRawPtr`)、`TypeTuple`/`TypeFunc`。

### intrinsic 内联

`LibraryCallKit`（`library_call.hpp:70`）的 `try_to_inline`（`library_call.cpp:236`）是巨大 switch 按 `vmIntrinsics::ID` 分发。intrinsic 内联的原因：避免调用开销（栈帧/寄存器保存），内联后 IR 节点参与 GVN/IGVN/EA/循环优化整体优化。`C2Compiler::is_intrinsic_supported`（`c2compiler.cpp:232`）用 `Matcher::match_rule_supported` 检查平台指令支持（如 `Math.sqrt→sqrtsd`）。

### Matcher 指令选择

`Matcher`（`matcher.hpp:44`，继承 `PhaseTransform`）把 ideal 节点匹配到 `MachNode`。`match()`（`matcher.cpp:216`）：`find_shared`(标记共享节点) → `Label_Root`(DFA 自顶向下匹配规则表) → `ReduceInst`(`:95`，按 rule 号创建 MachNode)。规则表 `_reduceOp`/`_leftOp`/`_rightOp`（`:104`）由 ADLC 编译 `.ad` 文件生成，`C->swap_old_and_new()` 把 ideal 节点移 old-space、MachNode 在 new-space 创建。

### 图着色寄存器分配

`PhaseChaitin`（`chaitin.hpp`）`Register_Allocate`（`chaitin.cpp:356`）：`de_ssa`(`:763`，Union-Find 合并 Phi 相关 live range)→`build_ifg`(构建干涉图)→`Simplify`(`:1259`，移除低度数节点入栈，trivially colorable)→`Select`(`:1610`，逆序着色)。溢出策略：选 `LRG::score` 最低的 potential spill，`Split`(`:494`) 在使用点分裂短活跃范围，spill-split-recycle 循环（`:570`）最多 24 次，支持 rematerialization（简单常量重算而非溢出）。

### 逃逸分析 EA

`ConnectionGraph::do_analysis`（`escape.cpp:106`，基于 Choi99 OOPSLA）`compute_escape`(`:137`) 构造连接图：三类节点（JavaObject/LocalVar/Field）、三类边（PointsTo/Deferred/Field），计算 `EscapeState{NoEscape, ArgEscape, GlobalEscape}`（`escape.hpp:156`）。NoEscape 的 `AllocateNode` 标 `ScalarReplaceable`（`:166`），`PhaseMacroExpand::eliminate_macro_nodes`（`compile.cpp:3171`）展开为标量字段变量消除堆分配；NoEscape 对象的 Lock/Unlock 一并消除（锁消除）。EA 迭代（`compile.cpp:3154`），每轮若消除分配取得进展则继续。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Sea-of-Nodes | `Node` (`node.hpp:254`) | 数据/控制流显式，依赖天然可见，利于 DCE/循环不变量外提 |
| Phase 流水线（Visitor） | `Phase`/各 Phase 子类 (`phase.hpp:44`) | 构造即分析，析构即清理，`transform()` 纯虚多态 |
| 树形 Pattern 匹配 | `Matcher` (`matcher.hpp:44`) | ADLC 规则把机器无关 IR 映射到机器相关 MachNode |
| 图着色寄存器分配 | `PhaseChaitin` (`chaitin.hpp`) | 经典 Chaitin，spill-split-recycle 处理溢出 |

## 模块间交互

`opto` 依赖 `ci`（`Compile::_env` 持 `ciEnv`/`ciMethod`/`ciField`）、`code`（`PhaseOutput::install_code` 调 `ciEnv::register_method`，`output.cpp:3348`）、`oops`（`MethodData`/`Method` profiling）。被 `CompileBroker` 调度（`C2Compiler::compile_method`）。与 C1 对比：C1 线性 HIR/LIR + 线性扫描，无 EA/无 lattice/无图着色，优化保守但编译快，作 tier 1-3。

## 扩展方式

新增 intrinsic（如 `Math.fma`）：`vmIntrinsics.hpp` 加枚举；`c2compiler.cpp:232` `is_intrinsic_supported` 加 case 检查 `match_rule_supported`；`.ad` 定义 `MachFmaNode` 与 `match(Set result (FmaD a b c))` 规则；`library_call.cpp:236` `try_to_inline` 加 case 并用 `GraphKit` 构造 IR。新增 Matcher 规则（如 POPCNT）：`.ad` 定义 `instruct popCountI(dst, src) %{ match(Set dst (PopCountI src)); %}`；运行 ADLC 重生成规则表；`countbitsnode.hpp` 定义 `PopCountINode` 实现 `Ideal()/Value()`。新增循环优化 pass：`PhaseIdealLoop`(`loopnode.hpp:879`) 声明方法，`build_and_optimize`(`loopnode.cpp:5225`) 插入调用，用 `get_early_ctrl`/`set_ctrl` 确定节点放置。
