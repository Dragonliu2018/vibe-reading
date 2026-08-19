---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "TorchInductor 代码生成"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "TorchInductor", "Triton", "fusion", "codegen"]
description: "torch.compile 默认后端：GraphLowering FX→IR、Scheduler fusion 划分、TritonKernel/CppKernel codegen、MemoryPlanner 池化、AOTI 持久化部署。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

TorchInductor（`torch/_inductor`，250K 行）是 `torch.compile` 的默认后端——把 FX graph 调度成 fusion group，生成 Triton（GPU）或 C++（CPU）代码，做 memory planning 与 kernel fusion。它是 PyTorch 2.x 编译栈的产出端，将 Dynamo+AOTAutograd 产出的 FX `GraphModule` 转化为高效可执行 kernel。

Inductor 位于编译栈层（粉框），接收 Dynamo 经 `compile_fx` 传入的 FX graph（跨边界：`_dynamo → _functorch(aot_autograd) → _inductor`）。它的核心是 **scheduler-based codegen**：`GraphLowering` 用 FX Interpreter 把每个 `call_function` lower 成 IR（`ComputedBuffer`/`TemplateBuffer`），`Scheduler` 划分 fusion group，每个 group 生成一个 `TritonKernel`/`CppKernel`，最终 `PythonWrapperCodegen` 编排 host 代码。对 GEMM 等 op 用 CUTLASS/手写模板。

## 模块架构

```text
┌──────────────────────────────────────────────────────────────┐
│  compile_fx (compile_fx.py:2685)  主入口                       │
│  → aot_module_simplified (AOTAutograd 分解)                    │
│  → compile_fx_inner → fx_codegen_and_compile                  │
└──────────┬───────────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────────┐
│  GraphLowering (graph.py:362)  继承 torch.fx.Interpreter       │
│  graph.run(*inputs)  FX 遍历 → lower 成 IR (IRNode)            │
│  每个 call_function → ir.ComputedBuffer(Pointwise/Reduction)   │
└──────────┬───────────────────────────────────────────────────┘
           │ IR nodes
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Scheduler (scheduler.py:4028)                                 │
│  create_scheduler_node per IR node                             │
│  compute_dependencies → topological_sort_schedule              │
│  fuse_nodes() [迭代 10 轮] → FusedSchedulerNode                 │
│    group_fn: (numel, rnumel) 分类 pointwise/reduction          │
│    can_fuse / score_fusion 排序                                │
└──────────┬───────────────────────────────────────────────────┘
           │ fused nodes
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Codegen (codegen/triton.py / cpp.py)                         │
│  TritonScheduling.codegen_node → TritonKernel                 │
│  CppScheduling.codegen_node → CppKernel                       │
│  OpOverrides: aten op → tl.dot / 向量化表达式                   │
└──────────┬───────────────────────────────────────────────────┘
           │ kernel 源码
           ▼
┌──────────────────────────────────────────────────────────────┐
│  PythonWrapperCodegen (wrapper.py:1257)                       │
│  MemoryPlanner.plan()  池化分配 (live range 复用)               │
│  generate() → CompiledModule (Python wrapper 调 Triton JIT)    │
└──────────────────────────────────────────────────────────────┘
```

`GraphLowering` 是入口——作为 `torch.fx.Interpreter` 子类遍历 FX graph，每个 `call_function` 经 `lowering.py` 注册的 lower_fn 转成 IR。`Scheduler` 接管 IR，按 `(numel, rnumel)` 分组做 fusion，迭代 10 轮最大化融合。codegen 按 device 分发到 `TritonScheduling`（GPU）或 `CppScheduling`（CPU），生成 kernel 源码。`wrapper` 编排 host 代码，`MemoryPlanner` 池化中间 buffer。

## 调用链路

```text
compile_fx(model_, example_inputs_)             # compile_fx.py:2685
  → _compile_fx_main                            # :2873
    → aot_module_simplified(mod, args,          # _functorch/aot_autograd.py:1131
         fw_compiler=compile_fx_inner)          # ← 跨边界: _inductor → _functorch
      ├─ aot_dispatch_autograd_graph            # trace joint fw+bw → joint FX Graph
      └─ partition_fn (default_partition)       # 切 fw / bw 两个 FX Graph
         → fw_compiler(gm) = compile_fx_inner   # ← 跨边界: _functorch → _inductor

compile_fx_inner → _compile_fx_inner            # compile_fx.py:788 / 846
  → fx_codegen_and_compile                      # :1787
    → GraphLowering(gm, ...)                    # graph.py:362
       ├─ graph.run(*example_inputs)            # graph.py:1090  FX Interpreter → IR
       │    每个 call_function → ir.ComputedBuffer(Pointwise/Reduction)
       └─ graph.compile_to_module()             # graph.py:2662
            → graph.codegen()                   # graph.py:2603
               ├─ _update_scheduler() → Scheduler(nodes)
               │    ├─ create_scheduler_node() per IR node
               │    ├─ compute_dependencies()
               │    ├─ topological_sort_schedule()
               │    ├─ fuse_nodes() [迭代 10 轮]    # scheduler.py:4986
               │    │    └─ fuse_nodes_once()       # scheduler.py:5978
               │    │         ├─ get_possible_fusions() → can_fuse()  # simd.py:2002
               │    │         ├─ score_fusion_key()  # scheduler.py:8413
               │    │         └─ _try_fusion_pairs() → FusedSchedulerNode.fuse()
               │    └─ scheduler.codegen()       # scheduler.py:9203
               │         └─ codegen_node(node)   # simd.py:2943
               │              └─ codegen_node_schedule_with_kernel()  # simd.py:3150
               │                   ├─ kernel.split_and_set_ranges()
               │                   ├─ node.codegen(index_vars)  # scheduler.py:2481
               │                   │    └─ _body(*index_vars) → ops handler 生成代码
               │                   └─ kernel 拼接 prologue + loop + stores
               └─ wrapper_code.generate()       # wrapper.py:2125
                    ├─ run_wrapper_ir_passes()
                    ├─ MemoryPlanner.plan(lines)  # memory_planning.py:659
                    └─ 输出 wrapper Python 代码 → CompiledModule
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `compile_fx` | `compile_fx.py:2685` | 主入口 | 调 AOTAutograd 分解 |
| `GraphLowering.run` | `graph.py:1090` | FX→IR | FX Interpreter 遍历 |
| `GraphLowering.codegen` | `graph.py:2603` | IR→kernel | 触发 Scheduler |
| `Scheduler.fuse_nodes` | `scheduler.py:4986` | 融合迭代 10 轮 | `fuse_nodes_once` 单轮 |
| `can_fuse` | `simd.py:2002` | 融合可行性 | numel/rnumel 兼容检查 |
| `score_fusion` | `choices.py:671` | 融合优先级 | template>reduction>memory |
| `group_fn` | `simd.py:1995` | node 分类 | `(numel, rnumel)` 元组 |
| `Scheduler.codegen` | `scheduler.py:9203` | codegen 入口 | 按 device 分发 |
| `TritonKernel` | `triton.py:3083` | Triton kernel 生成 | tile 循环 + autotune |
| `MemoryPlanner.plan` | `memory_planning.py:659` | 内存规划 | live range 池化 |
| `PythonWrapperCodegen.generate` | `wrapper.py:2125` | host 代码 | 产出 CompiledModule |

</details>

## 核心实现

### GraphLowering：FX Interpreter → IR

`GraphLowering`（`graph.py:362`）继承 `torch.fx.Interpreter`，遍历 FX graph 把 `call_function` lower 成 IR：

```python title="torch/_inductor/graph.py"
class GraphLowering(torch.fx.Interpreter):  # graph.py:362
    """Lower an FX graph into Inductor IR and track compilation state."""
    graph_outputs: list[ir.IRNode]
    # 每个 call_function → ir.ComputedBuffer(Pointwise/Reduction)
    #   或 ir.TemplateBuffer (GEMM 等模板 op)
```

FX Interpreter 按 `placeholder → call_function → output` 顺序遍历，每个 op 经 `lowering.py` 注册的 lower_fn 转成 `ir.IRNode`。Pointwise op（逐元素）产出 `ComputedBuffer` 带 Pointwise body，Reduction op（归约）产出带 Reduction body。IR 是 Inductor 的中间表示，比 FX Node 更贴近 kernel 结构（显式表达 load/compute/store）。

### Scheduler：fusion 划分

`Scheduler`（`scheduler.py:4028`）接收 IR nodes，划分 fusion group：

```python title="torch/_inductor/scheduler.py"
class Scheduler:  # scheduler.py:4028
    """A Scheduler is a graph of BaseSchedulerNodes. It is responsible for
    optimizations such as fusion, reorder, and graph partition."""

class SchedulerNode(BaseSchedulerNode):  # scheduler.py:2182
    _sizes: tuple[Sequence[sympy.Expr], ...]  # (numel, rnumel)
    _body: LoopBody

class FusedSchedulerNode(BaseSchedulerNode):  # scheduler.py:2616
    snodes: list[BaseSchedulerNode]  # 一组待融合的 node
```

`group_fn`（`simd.py:1995`）把每个 node 的 sizes 简化为 `(numel, rnumel)`——`numel`=pointwise 维度元素数，`rnumel`=reduction 维度元素数。Pointwise node `rnumel=1`，Reduction node `rnumel>1`。`can_fuse`（`simd.py:2002`）检查两个 node 的 `numel`/`rnumel` 兼容性——融合后 kernel 只能有一个 tiling 结构，reduction 维度不同的两个 reduction 无法共享同一次 tile 遍历。`score_fusion`（`choices.py:671`）排序：template fusion > reduction-reduction > memory savings > graph proximity。`fuse_nodes`（`scheduler.py:4986`）迭代 10 轮最大化融合。

### TritonKernel：代码生成

`TritonKernel`（`triton.py:3083`）生成 Triton kernel：

```python title="torch/_inductor/codegen/triton.py"
class TritonKernel(SIMDKernel[TritonCSEVariable]):  # triton.py:3083
    """A class to represent a triton kernel and helpers to generate
    triton kernel programmatically"""
    # 持有 prologue/compute/stores 三个 IndentedBuffer
    # 通过 codegen_range_tree() 生成 tile 循环
```

设计决策（`triton.py:3083`）：Triton 提供 tile 级别并行抽象（`tl.programs`/`tl.store`），Inductor 只需生成 loop body 中的 elementwise 表达式，无需处理 shared memory/barrier/warp 同步。Triton 内置 autotune（`fixed_config`）自动搜索 block size。elementwise fusion 产出的 kernel 结构高度规律（load→compute→store），Triton 抽象刚好匹配。`OpOverrides`（`TritonOverrides` `triton.py:1270`）是 op 级模板——每个 aten op 对应一个方法（如 `def dot(a, b)` → `tl.dot(a, b)`），codegen 时通过 `V.set_ops_handler` 切换 handler。`CppKernel`（`cpp.py:1974`）同理生成 C++ 向量化代码。

### Memory Planning

`MemoryPlanner`（`memory_planning.py:649`）减少 `cudaMalloc` 调用：

```python title="torch/_inductor/codegen/memory_planning.py"
class MemoryPlanner:  # memory_planning.py:649
    def plan(self, lines):  # :659
        # 1. compute_live_ranges — 每个 buffer [first_use, last_use]
        # 2. allocate_groups — 不重叠 live range 放进同一 AllocationPool
        # 3. mark_first_last_usage()
```

设计决策（`:659`）：N 个中间 buffer 变成 1 个大 pool 的多个 offset（`AllocFromPoolLine.codegen` `:609` 生成 `buf = pool[offset]` 而非 `torch.empty(...)`），减少 `cudaMalloc`（CUDA malloc 同步且昂贵）。`TemporalSplit`（`:255`）时间维复用，`SpatialSplit`（`:336`）空间维复用。

### AOTI：Ahead-of-Time 编译

`compile_fx` 中 `V.aot_compilation=True` 时走 `codegen_with_cpp_wrapper()`，生成 C++ wrapper + Triton kernel 源码，通过 `CompiledAOTI`（`output_code.py:989`）返回 `.so` 文件路径。设计决策：(1) 部署环境可能无 Python/Triton JIT；(2) 首次 JIT 编译耗时数秒到数十秒，AOTI 在打包阶段完成；(3) `store_cubin` 可缓存 Triton 编译后的 CUDA binary，运行时直接 load。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| FX Interpreter lowering | `GraphLowering`（`graph.py:362`） | 复用 FX 遍历机制转 IR |
| Scheduler-based codegen | `Scheduler`（`scheduler.py:4028`） | fusion + codegen 统一调度 |
| Fusion heuristic | `group_fn`/`can_fuse`（`simd.py:1995/2002`） | numel/rnumel 分类决定 tiling |
| OpOverrides 模板 | `TritonOverrides`（`triton.py:1270`） | op 级代码模板，handler 切换 |
| 对象池 | `MemoryPlanner`（`memory_planning.py:649`） | live range 复用减 cudaMalloc |

## 模块间交互

```
Dynamo (torch._dynamo) → FX Graph ( aten ops )
  ▼
AOTAutograd → joint graph decomposition → forward/backward FX graphs  ← 跨边界 _functorch
  ▼
compile_fx (compile_fx.py:2685) → GraphLowering  ← 跨边界 _inductor
  ▼
Scheduler → FusedSchedulerNodes → TritonKernel/CppKernel
  ▼
PythonWrapperCodegen → CompiledModule (运行时 Python wrapper 调 Triton JIT kernel)
```

AOTAutograd（`torch/_functorch/aot_autograd.py:1131`）在 Dynamo 和 Inductor 之间做 joint graph 分解：trace 前向+反向联合图，`partition_fn`（`default_partition`）切成 fw/bw 两个 FX Graph 分别交 Inductor 编译。反向编译 lazy（`_LazyGraphModule` + `compile_fx_backward` `compile_fx.py:2558`），首次 backward 才编译。

## 扩展方式

**新增 fusion pattern**：在 `Scheduler._can_fuse`（`scheduler.py:7396`）或 `SIMDScheduling.can_fuse`（`simd.py:2002`）加条件；特殊 reduction 组合参考 `MixOrderReduction`（`scheduler.py:204`）创建新 `FusedXxxReduction` 类。

**改 memory planning**：`MemoryPlanner.plan()`（`memory_planning.py:659`）是入口，修改 `allocate_groups`（`:752`）分组逻辑或新增 `AllocationTreeNode` 子类。

**加自定义 kernel template**：继承 `TritonTemplateKernel`，在 `TritonScheduling.codegen_template` 注册；参考 `cpp_gemm_template.py`/`cpp_flex_attention_template.py`。
