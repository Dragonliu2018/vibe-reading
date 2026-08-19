---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "TorchScript JIT"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "TorchScript", "JIT", "IR", "GraphExecutor"]
description: "SSA 风格 IR（Graph/Node/Value/Block）+ 分层 GraphExecutor + pass pipeline 优化 + 符号微分，可序列化部署的图编译器。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

TorchScript JIT 是 PyTorch 的图编译器，把 Python 模型转成可序列化、可优化的 SSA 风格 IR（`Graph`/`Node`/`Value`/`Block`），经 pass pipeline 优化后由 `GraphExecutor` 解释执行。它支持 `torch.jit.script`（从 Python 语法子集编译）和 `torch.jit.trace`（追踪实际执行录 op）两种前端，产物可 `torch.jit.save` 序列化部署。

JIT 位于 C++ 绑定层（紫框），调用 ATen 算子（通过 Dispatcher）、与 autograd 协作（`differentiate` 符号微分切可微子图）、提供序列化能力。在 v2.x 时代，TorchScript 前端逐渐被 `torch.compile`（Dynamo+Inductor）取代——后者避开"Python 子集"语法限制和 trace/script 不一致——但 `Graph` IR 仍是底层基础设施，且 TorchScript 的序列化/部署能力 torch.compile 尚未完全替代。

## 模块架构

```text
┌──────────────────────────────────────────────────────────────┐
│  前端                                                          │
│  torch.jit.script → parser → ir_emitter → GraphFunction       │
│  torch.jit.trace  → tracer::trace (录 op 成 Graph)             │
└──────────────────────────┬───────────────────────────────────┘
                           │ shared_ptr<Graph>
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  IR (ir.h)                                                     │
│  Graph ── Block ── Node (kind/inputs/outputs/blocks)           │
│         └── Value (SSA, 单一定义, use-def 链)                   │
│  循环双向链表 == 拓扑序 (next/prev)                              │
└──────────────────────────┬───────────────────────────────────┘
                           │ GraphExecutor(graph)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  GraphExecutor (分层)                                          │
│  ProfilingGraphExecutorImpl (默认: profile→specialize→fuse)    │
│  SimpleGraphExecutorImpl (mobile/固定 shape)                    │
│  GraphExecutorImpl (legacy: per-ArgumentSpec plan)             │
└──────────┬───────────────────────────────────────────────────┘
           │ getPlanFor → pass pipeline
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Pass Pipeline (graph_executor.cpp:1012)                      │
│  Inline → LowerGradOf → ConstantPooling → Peephole →          │
│  ShapeAnalysis → CreateAutodiffSubgraphs → differentiate →    │
│  FuseTensorExprs (NNC/NVFuser)                                │
└──────────┬───────────────────────────────────────────────────┘
           │ ExecutionPlan{Code, graph}
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Interpreter (interpreter.cpp:344)                            │
│  InterpreterState.run → operator_table_[inst.X](stack)        │
│  → Node.operator → Dispatcher → ATen kernel                   │
└──────────────────────────────────────────────────────────────┘
```

IR 是中心：`Graph` 持有 `Block`，`Block` 持有 `Node` 链表，`Node` 的 inputs/outputs 是 `Value`。`GraphExecutor` 分层选择编译策略，pass pipeline 在 `Graph` 上原地改写，最终 `Interpreter` 按 `Code` 指令逐条调 Dispatcher 执行 op。

## 调用链路

```text
torch.jit.script(model) ─┐ script_compile_function (script_init.cpp:556)
                          │ cu->define → parser → ir_emitter → GraphFunction
torch.jit.trace(fn,x) ───┘ tracer::trace (tracer.h:218) 录 op 成 Graph
                                     ▼
                       shared_ptr<Graph>
                                     ▼
        GraphExecutor(graph, name)   # graph_executor.cpp:835
        pImpl = Profiling | Simple | GraphExecutorImpl  # :839-851
                                     ▼
        GraphExecutor::run(stack)    # graph_executor.cpp:868 → :584
        └ getPlanFor(stack)
          ├ [Profiling] getOptimizedPlanFor (profiling_graph_executor_impl.cpp:620)
          │   ① runProfilingInsensitiveOptimizations (Inline/Peephole/CSE/Const)
          │   ② ProfilingRecord::instrumentGraph → 插 prim::profile
          │   ③ profiling_plan_ 跑若干次收集 shape/dtype
          │   ④ pr_->ready() → runProfilingOptimizations + runFinalOptimizations
          │   ⑤ bailout：remaining_bailout_depth-1 降级重编译
          └ [Legacy] GraphExecutorImpl::compileSpec (:691)
             Inline→LowerGradOf→specializeAutogradZero→LowerSimpleTuples
             →ConstantPooling→runRequiredPasses→ConstantPropagation
             →PropagateInputShapes/RequiresGrad→runOptimization
             →CreateAutodiffSubgraphs→differentiate→runNondiffOptimization
                                     ▼
        ExecutionPlan{Code, graph}
                                     ▼
        InterpreterState(plan.code).run(stack)   # graph_executor.cpp:585
        └ interpreter.cpp:344  case OP:
           frame.function->operator_table_[inst.X](stack)
                                     ▼
        Node.operator → getOperationForDispatchKey(dk)  # operator.h:143
        → c10::OperatorHandle::callBoxedForDispatchKey → Dispatcher → ATen kernel
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `script_compile_function` | `script_init.cpp:556` | script 前端编译 | AST→IR 映射 |
| `tracer::trace` | `tracer.h:218` | trace 前端录制 | 实际执行录 op |
| `GraphExecutor::run` | `graph_executor.cpp:868` | 执行入口 | 桥接到 Impl |
| `getOptimizedPlanFor` | `profiling_graph_executor_impl.cpp:620` | Profiling 优化 | profile→specialize→bailout |
| `runOptimization` | `graph_executor.cpp:1012` | pass pipeline 主 | 两调 Peephole |
| `PeepholeOptimize` | `passes/peephole.cpp` | 局部重写 | `x*1→x`/`t(t(x))→x` |
| `differentiate` | `runtime/autodiff.cpp` | 符号微分 | 切可微子图得 Gradient{f,df} |
| `FuseTensorExprs` | `passes/tensorexpr_fuser.cpp` | 算子融合 | NNC/tensorexpr CPU+GPU |
| `InterpreterState::run` | `interpreter.cpp:344` | 解释执行 | operator_table_ 派发 |
| `getOperationForDispatchKey` | `operator.h:143` | Node→Dispatcher | boxed 调用 ATen |

</details>

## 核心实现

### SSA IR：Node/Value/Block/Graph

`ir.h` 定义 SSA 风格 IR：

```cpp title="torch/csrc/jit/ir/ir.h"
struct Value {                   // SSA 值，单一定义
  Node* node_; size_t offset_; size_t unique_;
  use_list uses_; TypePtr type_;  // use-def 链挂在 Value 上
  Value* replaceAllUsesWith(Value* newValue);  // :258
};
struct Node {                    // IR 计算节点
  const NodeKind kind_;          // Symbol：aten::add / prim::If
  std::vector<Value*> inputs_, outputs_;
  std::vector<Block*> blocks_;   // If/Loop 的子块
  Node* next_in_graph[2];        // 循环双向链表 == 拓扑序 (:356)
  bool hasSideEffects() const;   // :560
};
struct Block { Node* output_; Node* input_; Node* owning_node_; };  // :1038
struct Graph { Block* block_; std::unordered_set<const Node*> all_nodes; };  // :1194
```

设计决策（`ir.h:629` 注释明说 block inputs "equivalents of phi-nodes in standard SSA form"）：`Value` 单一定义 + `replaceAllUsesWith` + use-def 链挂在 Value 上，使所有经典优化（CSE/DCE/constant folding）可证明正确。`next_in_graph[2]` 循环双向链表同时是拓扑序（`ir.h:571`），所有 pass 必须维护此不变量，简化 dominator/alias 分析。

### 分层 GraphExecutor

`GraphExecutor`（`graph_executor.cpp:839-851`）持 `GraphExecutorImplBase`，三实现可切换：

- **`ProfilingGraphExecutorImpl`**（默认）：profile→specialize→fuse，`bailout` 控制重编译次数（`profiling_graph_executor_impl.cpp:655`）。
- **`SimpleGraphExecutorImpl`**：跳 profile 直接静态优化，给 mobile/固定 shape 推理。
- **`GraphExecutorImpl`**（legacy）：按 `ArgumentSpec` 每 shape 一份 plan（内存高）。

分层动机：profile 是编译开销 vs 运行时收益的 trade-off，不同部署选不同档。`bailout` 降级（`:655`）：profile 不命中就 `remaining_bailout_depth-1` 重编译，避免无限循环，最终落 simple executor。

### Pass Pipeline 与 Fusion

`runOptimization`（`graph_executor.cpp:1012`）和 `runNondiffOptimization`（`:968`）是 pass 序列：

```cpp title="torch/csrc/jit/runtime/graph_executor.cpp (pass 顺序简化)"
// runNondiffOptimization (:993-1001)
if (tensorExprFuserEnabled()) FuseTensorExprs(graph);  // NNC/tensorexpr
else FuseGraph(graph);                                  // legacy ConcatFuser
```

设计决策：`tensorExprFuserEnabled()` → `FuseTensorExprs`（NNC/tensorexpr，CPU+GPU）；否则 `FuseGraph`（legacy ConcatFuser）。`codegen/cuda/` 目录 v2.13 只剩 `interface.cpp/h + README`——NVFuser 已从 PyTorch 仓库剥离为独立 `nvfuser` 包。fusion 前强制 `LowerSimpleTuples`+`DecomposeOps`+`BatchMM`，因为 fuser 不认 tuple。`getCustomPrePasses()`/`getCustomPostPasses()`（`:974`/`:1005`）允许 backend 注册外部 pass 而不改主干。

### Autograd 集成

`needsGradient(opt_graph)` 判定后 `CreateAutodiffSubgraphs`（`:747`）切可微子图，`differentiate(diff_graph)`（`runtime/autodiff.cpp`）做符号微分得 `Gradient{f, df}`，`packGradient` 把 df 包成 `DifferentiableGraphOp`（`:414`，含 `GraphExecutor f_ptr` 跑 forward、`autograd::Function` 跑 backward），依赖 `SavedVariable`/`Edge`。`PropagateRequiresGrad` 沿 IR 传播 requires_grad。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| IR + pass pipeline | `Graph` + `runOptimization`（`:1012`） | 编译器经典，pass 原地改写 Graph |
| Visitor/链表遍历 | `graph_node_list`（`ir.h:356`） | 前向/逆向遍历，拓扑序不变量 |
| Peephole | `PeepholeOptimize`（`passes/peephole.cpp`） | 局部重写 `x*1→x` |
| pImpl + 策略 | `GraphExecutor` → 三 Impl（`:839`） | 编译开销 trade-off 可切换 |
| 桥接 Dispatcher | `getOperationForDispatchKey`（`operator.h:143`） | JIT 不实现 op，解释成 boxed 调用 |

## 模块间交互

- **JIT → ATen/Dispatcher**：IR `Node` 绑 `Operator`，Code 生成时用 `getOperationForDispatchKey(dk)` 填 `operator_table_`，调用走 `c10::Dispatcher::singleton()` → 注册 kernel。JIT 不实现 op，只把 op 节点解释成 Dispatcher boxed 调用。
- **JIT ↔ autograd**：`CreateAutodiffSubgraphs` + `differentiate` 切可微子图符号微分，依赖 `SavedVariable`/`Edge`。
- **序列化**：`ExportModule`（`serialization/export.h:155`）经 `PyTorchStreamWriter` 写 zip；`FlatbufferSerializer` 写 mobile bytecode；`python_print.cpp` 反向把 IR 打印回 TorchScript 源码。注意 `torch.save` 走 pickle，与 JIT 路径不同。

## 扩展方式

**新增 IR pass**：在 `passes/` 加 `my_pass.cpp`，签名 `TORCH_API void MyPass(std::shared_ptr<Graph>&)`；遍历 `graph->nodes()` match `kind()`，用 `replaceAllUsesWith`/`replaceInput` 改写；挂入 `runOptimization`（`:1012`）或通过 `getCustomPrePasses()` 注册外部 pass 不改主干；配 `EliminateDeadCode` 收尾。

**扩展脚本支持 Python 特性**：`frontend/ir_emitter.cpp` 加 AST→IR 映射、`python/python_sugared_value.cpp:112 PythonValue::call` 加分发；类型推理在 `passes/shape_analysis.cpp`；序列化改 `export.cpp` + `mobile_bytecode.fbs`（带 `op_version_`）并由 `operator_upgraders` 处理旧模型。
