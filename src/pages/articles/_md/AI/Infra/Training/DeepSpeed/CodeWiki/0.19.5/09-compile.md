---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "编译优化"
date: "2026-08-12T15:35:32+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "DeepCompile", "torch.compile", "FX Graph", "编译优化"]
description: "DeepCompile 是 DeepSpeed 基于 torch.compile 的自定义编译后端，通过 FX Graph 变换在计算图中插入 ZeRO 通信 op，实现参数 allgather/release/reduce 的细粒度调度与内存优化。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

DeepCompile 是 DeepSpeed 对 `torch.compile` 的深度定制——它注册一个自定义 backend 函数，在 PyTorch Dynamo trace 出 FX GraphModule 后、AOT Autograd 分割出 forward/backward 子图时拦截编译过程，插入 ZeRO-3 的 `allgather_param`/`release_param`/`reduce_grad` 等通信 op，再通过内存感知的 list schedule 重排节点顺序，最小化峰值显存。

传统 ZeRO-3 的参数 allgather/release 由 `pre_forward_module_hook`/`post_forward_module_hook` 在模块层级管理——粒度粗、无法跨模块重叠通信与计算。DeepCompile 将这一逻辑下沉到 FX Graph 的 op 级别：每个参数的 gather 和 release 都成为 graph node，可以被精确地插入到"最后一个使用该参数的算术 op 之后"，也可以被调度器重排到"计算空闲窗口"中与 GPU kernel 并行执行。这种细粒度控制还使预取融合（prefetch fusion）、参数常驻（selective gather）、优化器状态 offload 等优化成为可能。

模块位于 `deepspeed/compile/`（6,200 行），核心是 `backend.py` 的 `make_backend()` 工厂函数和 `run_opt_passes()` 管道执行器。`passes/` 子目录包含各优化 pass，每个 pass 声明 `PassContract` 描述依赖关系，由 `validate_schedule()` 在编译前校验。

## 调用链路

### 编译全流程

```
engine.compile()                           engine.py
├── init_z3(engine, backend, ...)          init_z3.py L87
│   ├── dc.init(group, config, bucket_size)       — 初始化 C++ DeepCompile handle
│   ├── DeepCompileZ3EagerFallback(engine)         — 创建 Z3 eager fallback 追踪器
│   ├── optimizer._remove_module_hooks()           — 移除 ZeRO runtime hooks（编译后由 graph op 接管）
│   ├── dc.register_z3_param(ds_id, ...)           — 注册每个 Z3 参数的分片信息
│   ├── init_schedule(schedule)                     — 解析 [(step, [passes])] 调度表
│   ├── patch_fake_tensor()                         — 让 fake tensor mode 识别 ds tensor
│   └── make_backend(backend, config, ...) → backend_fn    L194
│
├── module.compile(backend=backend_fn)     torch.compile 入口
│   └── Dynamo trace → FX GraphModule
│       └── AOT Autograd (aot_module_simplified / AotAutograd)
│           ├── partition_fn → min_cut_rematerialization_partition
│           │   └── get_wrapped_partitioner(z3_partition, ...)   — 标记 needs_backward
│           ├── fw_compiler → make_fw_graph(gm, sample_inputs)
│           │   ├── DSGraphParamManager(gm.graph, real_inputs, param_indices)
│           │   └── run_opt_passes(next_passes, gm, ..., bwd=False)    L358
│           │       └── for each pass_fn: gm = pass_fn(gm, ...); gm.lint(); gm.recompile(); reprofile
│           └── bw_compiler → make_bw_graph(gm, sample_inputs)
│               └── run_opt_passes(next_passes, gm, ..., bwd=True)     L397
│
└── 每步训练: launch_compile_passes(global_steps)    backend.py L121
    ├── global_steps == schedule[0][0] ?
    │   └── YES → torch._dynamo.reset()              — 清空旧编译缓存
    │            → dc.reset() / graph_order.clear() / param_manager.clear()
    │            → next_passes = remaining_schedule.popleft()
    └── 下一次 forward 触发重新编译，用新 pass 列表
```

### Pass 执行管道

`run_opt_passes` 是 pass 管道的核心执行器（`backend.py` L242）。每个 pass 接收 `GraphModule` 返回变换后的 `GraphModule`，pass 之间自动执行 lint → recompile → reprofile 三步，保证下一个 pass 看到的是合法且 metadata 完整的图：

```python title="run_opt_passes — backend.py L242"
for i, opt_pass_fn in enumerate(opt_passes):
    gm_new = opt_pass_fn(gm, graph_id, graph_order, profiling_results,
                         create_inputs_fn, mem_budget, param_manager, bwd)
    if gm_new is not None:
        gm = gm_new
        gm.graph.lint()           # FX 图合法性检查
        gm.recompile()            # 重新生成 Python forward 代码
        # 重新 profiling：运行 MemoryProfilingInterpreter 获取变换后图的内存足迹
        mem_prof = MemoryProfilingInterpreter(gm, debug_log=debug_log)
        mem_prof.run(*create_inputs_fn())
        set_time_and_tensor_size(graph_id, gm.graph, mem, bwd, profiling_results, ...)
```

**Why 逐 pass reprofile**：每个 pass 变换图后，节点顺序和 tensor 生命周期都变了。后续 pass（如 `schedule_prefetch`）依赖 `profiling_results` 中的内存峰值和 tensor size 做调度决策，如果用旧 profile 数据会导致错误的内存预算计算。

<details>
<summary>方法速查表</summary>

| 函数 | 位置 | 一行职责 | 关键设计 |
|------|------|---------|---------|
| `make_backend` | `backend.py` L284 | 工厂函数，返回 `backend_fn` 闭包 | Closure 捕获 `compile_config`/`owned_frames`，避免全局状态 |
| `backend_fn` | `backend.py` L296 | torch.compile 自定义 backend 入口 | 区分 eager/inductor 两条路径 |
| `make_fw_graph` | `backend.py` L337 | forward graph 编译器 | 运行 opt passes + 注册 backward frame |
| `make_bw_graph` | `backend.py` L377 | backward graph 编译器 | 运行 opt passes + free activation |
| `run_opt_passes` | `backend.py` L242 | pass 管道执行器 | 逐 pass lint+recompile+reprofile |
| `launch_compile_passes` | `backend.py` L121 | 按 global_steps 切换 pass 调度 | 每步 `torch._dynamo.reset()` 重新编译 |
| `init_schedule` | `backend.py` L109 | 解析 schedule 列表为 deque | `[(step, [passes])]` 格式 |
| `fast_free_schedule` | `list_schedule.py` L283 | 内存感知的 allgather 调度 | 优先选不需额外 allgather 就能释放的任务 |
| `add_z3_gather_release` | `passes/zero3_compile.py` L222 | 插入 allgather/release/reduce op | forward+backward 分别处理，后接 `fast_free_schedule` |
| `schedule_prefetch` | `passes/prefetch.py` L41 | 预取融合 allgather | 反向遍历图，在内存允许时提前发起 allgather |
| `selective_gather` | `passes/selective_gather.py` L78 | 选择性参数常驻 GPU | 基于通信代价和可用显存决定哪些参数不 release |
| `move_opt_states` | `passes/offload_adam_states.py` L572 | Adam 状态 offload 调度 | 在图中插入 `offload_opt_launch`/`reload_opt` op |
| `apply_autosp` | `passes/sp_compile.py` L235 | 序列并行图变换 | 7 个子 pass：shard seq dim → all-to-all → shape propagate |
| `patch_create_aot_dispatcher_function` | `inductor.py` L145 | monkey-patch AotAutograd | 注入 fw/bw compiler，用后即恢复 |
| `DeepCompileZ3EagerFallback` | `z3_eager_fallback.py` L56 | Z3 eager gather 追踪器 | forward_context 释放未 claim 参数，record_forward_graph 跟踪配对 |

</details>

## 核心实现

### make_backend 与 pass 管道

`make_backend()` 是一个工厂函数，它返回的 `backend_fn` 闭包被直接传给 `torch.compile(backend=backend_fn)`。这个闭包捕获了 `compile_config`、`owned_frames` 等状态，使每个编译上下文拥有独立的 frame 跟踪：

```python title="make_backend — backend.py L284"
def make_backend(backend, compile_config, compile_kwargs={}, owned_frames=None):
    register_custom_ops()                    # 注册 dc.* 自定义 op 到 inductor lowering
    debug_log = compile_config.debug_log
    free_activation = compile_config.free_activation and not is_backend_inductor(backend)
    owner_token = object()                   # 唯一标识本 backend 实例

    def backend_fn(gm: GraphModule, real_inputs):
        graph_id = id(gm.graph)
        frame_id = gm.meta["dynamo_compile_id"].frame_id
        frame_key = (owner_token, frame_id)  # 防止不同编译上下文的 frame 串扰

        # 判断是否 ZeRO-3（参数有 ds_id 属性）
        z3_partition = any(hasattr(v, "ds_id") for v in real_inputs)
        if z3_partition:
            param_indices = [(i, v.ds_id, v.ds_shape) for i, v in enumerate(real_inputs)
                             if isinstance(v, torch.nn.Parameter)]
        # ... 创建 InputStorage, 初始化 profiling_results ...

        def make_fw_graph(gm, sample_inputs):
            needs_backward = frame_id in frames_partitioned
            # 注册 backward frame（用于 patch_compiled_func 拦截 backward 输入）
            if needs_backward:
                if len(frames_needing_bwd) == 0:
                    patch_compiled_func()
                frames_needing_bwd.add(frame_key)

            param_manager[graph_id] = DSGraphParamManager(gm.graph, real_inputs, param_indices)

            run_opt_passes(opt_passes=next_passes, gm=gm, graph_id=graph_id,
                           graph_order=graph_order_with_frame_id.get_graph_order(),
                           profiling_results=profiling_results, ..., bwd=False)
            return gm.graph

        def make_bw_graph(gm, sample_inputs):
            # ... 同结构，bwd=True，额外处理 free_activation ...
            run_opt_passes(opt_passes=next_passes, gm=gm, ..., bwd=True)
            return gm.graph

        # 两条路径：eager backend 直接用 aot_module_simplified，inductor 需 patch
        if backend == "eager":
            partition_fn = get_wrapped_partitioner(z3_partition, ...)
            aot_mod = aot_module_simplified(gm, real_inputs,
                                            fw_compiler=make_compiler_fn(make_fw_graph),
                                            bw_compiler=make_compiler_fn(make_bw_graph),
                                            partition_fn=partition_fn)
            return torch._dynamo.optimize(**compile_kwargs)(aot_mod)
        elif backend == "inductor":
            restore = patch_create_aot_dispatcher_function(graph_id, z3_partition,
                                                           make_fw_graph, make_bw_graph, ...)
            try:
                return torch._inductor.compile(gm, real_inputs)
            finally:
                restore()    # 进程级 patch，必须立即恢复
```

**两条编译路径的本质差异**：eager backend 用 `aot_module_simplified` 直接构造 AOT Autograd，fw/bw compiler 是 DeepCompile 的 pass 管道，最终执行的是变换后的 Python forward（`make_boxed_func`）。inductor backend 则需要 monkey-patch `AotAutograd.__init__` 来注入 DeepCompile 的 fw/bw compiler，因为 inductor 自己会创建 AotAutograd 实例——DeepCompile 必须在 inductor 的 AOT 分割完成后插入变换，再让 inductor 做后续 codegen。

### schedule 机制与渐进优化

`init_schedule()` 接收一个 `[(step, [pass_list])]` 列表，`launch_compile_passes()` 在每个训练步检查 `global_steps` 是否匹配下一个 schedule entry，匹配则 `torch._dynamo.reset()` 触发重新编译：

```python title="launch_compile_passes — backend.py L121"
def launch_compile_passes(global_steps: int, owned_frames=None):
    global next_pass_step, next_passes
    if len(remaining_schedule) > 0 and global_steps == remaining_schedule[0][0]:
        _, next_passes = remaining_schedule.popleft()
        torch._dynamo.reset()          # 清空 Dynamo 编译缓存
        get_deepcompile_handle().reset()  # 清空 C++ handle 状态
        graph_order_with_frame_id.clear()
        profiling_results.clear()
        param_manager.clear()
        cleanup_compiled_backward_state(owned_frames=owned_frames)
        frames_partitioned.clear()
```

`init_z3()` 中的默认 schedule 体现了渐进优化策略（`init_z3.py` L138）：

```python title="默认 Z3 schedule — init_z3.py L138"
schedule = []
# 基础：仅 Z3 gather/release
schedule.append((0, [zero3_compile.add_z3_gather_release]))
# 预热后（WARMUP=5 步）：加入预取融合 + 选择性常驻
schedule.append((WARMUP,
    [zero3_compile.add_z3_gather_release, prefetch.schedule_prefetch, selective_gather.selective_gather]))
```

**Why 两阶段**：前 5 步只有 `add_z3_gather_release`，用于收集准确的 memory profile 和 tensor size。到第 5 步，`profiling_results` 已经积累了足够的数据，`schedule_prefetch` 和 `selective_gather` 才能基于真实内存足迹做调度决策。提前启用会导致基于不准确的 profile 做错误的内存预算。

### PassContract 声明式依赖

每个 pass 通过 `PassContract` 声明它 `provides`（产出）和 `requires`（依赖）的能力标签。`validate_schedule()` 在编译前校验 schedule 是否满足所有依赖：

```python title="PassContract — passes/contract.py L14"
CAP_Z3_GATHER_RELEASE = "z3_gather_release"

@dataclass(frozen=True)
class PassContract:
    provides: FrozenSet[str] = frozenset()
    requires: FrozenSet[str] = frozenset()
    conflicts_with: FrozenSet[str] = frozenset()
    phase: str = "both"
```

各 pass 的 contract 声明：

```python title="Pass Contract 声明"
# zero3_compile.py L25 — 产出 Z3 gather/release 能力
CONTRACT = PassContract(provides=frozenset({CAP_Z3_GATHER_RELEASE}))

# prefetch.py L21 — 依赖 Z3 gather/release 已存在
CONTRACT = PassContract(requires=frozenset({CAP_Z3_GATHER_RELEASE}))

# selective_gather.py L23 — 同样依赖 Z3 gather/release
CONTRACT = PassContract(requires=frozenset({CAP_Z3_GATHER_RELEASE}))

# offload_adam_states.py L37 — 不依赖任何 pass，独立工作
CONTRACT = PassContract()
```

`validate_schedule()` 的校验逻辑（`passes/contract.py` L71）逐 step 检查：每个 pass 的 `requires` 必须在同一 step 内被更早的 pass `provides`；`conflicts_with` 双向对称检查。**跨 step 不继承能力**——因为每步 `torch._dynamo.reset()` 重新编译，上一步的图变换不保留。

### Z3 gather/release pass 与内存调度

`add_z3_gather_release` 是 DeepCompile 的核心 pass，它在 FX Graph 中为每个 Z3 参数插入三组 op：

```python title="add_z3_gather_release — passes/zero3_compile.py L222"
def add_z3_gather_release(gm, graph_id, graph_order, profiling_results,
                          create_inputs_fn, mem_budget, param_manager, bwd):
    if bwd:
        return add_z3_gather_release_bw(gm, ...)
    return add_z3_gather_release_fw(gm, ...)
```

forward 路径（`add_z3_gather_release_fw` L137）的流程：

1. **插入 allgather + wait**：对每个参数 placeholder，在其后插入 `dc.allgather_param(graph_id, ds_id, dtype)` 和 `dc.wait_allgather(graph_id, ds_id)`。allgather 是异步的，wait 阻塞到通信完成。
2. **插入 release**：在参数的最后一个使用者之后插入 `dc.release_param(graph_id, ds_id, n_users)`，释放聚合后的完整参数，回收显存。
3. **类型转换融合**：如果参数的唯一使用者是一个降精度 cast（如 FP32→FP16），则将 cast 融合进 allgather，跳过中间 cast 节点。
4. **profiling**：运行 `ProfilingInterpreter` 收集每个节点的 `tensor_size` 和 `device_time`，供调度器使用。
5. **fast_free_schedule**：基于 profiling 数据重排 graph 节点，最小化峰值内存。

backward 路径额外插入 `dc.reduce_grad(graph_id, ds_id)` op，在梯度计算完成后发起 reduce_scatter 将梯度分片写回。

#### fast_free_schedule：内存感知调度器

`fast_free_schedule`（`list_schedule.py` L283）是 DeepCompile 的调度核心。它不是简单按拓扑序执行节点，而是以 `AllgatherTask` 为单位，优先选择"不需要额外 allgather 就能完成释放"的参数，从而最小化峰值内存：

```python title="AllgatherTask — list_schedule.py L261"
@dataclass
class AllgatherTask:
    node: Node                    # allgather 节点
    allgather_cost: float         # 到 allgather 节点的累计计算时间
    free_cost: float              # 到 release 节点的累计计算时间
    allgathered_mem: int          # 本参数聚合后的内存
    allgather_acc_mem: int        # 路径上其他 allgather 的累计内存
    free_acc_mem: int             # 从 ag 到 release 路径上的额外 allgather 内存
    last_use: Node                # 参数最后一次使用的节点
    n_scheduled_ags: int          # 路径上 allgather 总数
    schedule_until_ag: List[Node] # 从当前位置到 allgather 的节点序列
    schedule_until_free: List[Node] # 从当前位置到 release 的完整序列
```

调度策略的关键决策（L376）：

```python title="fast_free_schedule 选任务策略 — list_schedule.py L376"
# 优先选择：free_acc_mem == 0 的任务
# 即从 allgather 到 release 的路径上不需要任何额外 allgather
ags_with_no_additional_ag = [ag for ag in runnable_ags if ag.free_acc_mem == 0]
if len(ags_with_no_additional_ag) > 0:
    # 选 (n_scheduled_ags, allgather_acc_mem, free_cost) 最小的
    sorted_ags = sorted(ags_with_no_additional_ag, key=_free_path_allgather_key)
    next_ag = sorted_ags[0]
    nodes_to_schedule = next_ag.schedule_until_free   # 一直调度到 release
else:
    # 没有理想的，选 free_acc_mem 最小的 fallback
    sorted_ags = sorted(runnable_ags, key=_fallback_allgather_key)
    next_ag = sorted_ags[0]
    nodes_to_schedule = next_ag.schedule_until_ag      # 只调度到 allgather
```

**Why 优先 `free_acc_mem == 0`**：如果一个参数从 allgather 到 release 的路径上需要先 allgather 另一个参数，那么这两个参数的聚合内存会同时驻留。选择 `free_acc_mem == 0` 的任务意味着可以"allgather → 用完 → release"一气呵成，不需要同时持有其他参数，从而最小化并发内存。

调度完成后，reduce 节点和 output 节点也会在依赖满足时尽早调度，以释放梯度内存和激活内存。

### Z3 Eager Fallback

ZeRO-3 的参数在运行时是分片的——当 Dynamo guard 检查参数形状时，会触发参数的 eager allgather，导致 guard 看到的形状与编译时不一致。`DeepCompileZ3EagerFallback` 解决这个"trace 时副作用破坏 guard"的问题。

```python title="DeepCompileZ3EagerFallback — z3_eager_fallback.py L56"
class DeepCompileZ3EagerFallback:
    """Track eager-only ZeRO-3 gathers and restore partitioned state around compiled forwards."""

    @contextmanager
    def forward_context(self):
        """Enable fallback lookup for the outermost forward and restore nested state on exit."""
        global _ACTIVE_FALLBACK
        previous = _ACTIVE_FALLBACK
        self._depth += 1
        if self._depth == 1:
            self._last_gathered_param_ids.clear()
            self._current_forward_param_ids.clear()
            self.release_available_params_for_next_forward()  # 释放未被 claim 的参数
            self._enable_forward_fallback()   # 设置 module._parameters._in_forward = True
        _ACTIVE_FALLBACK = self
        try:
            yield
        finally:
            _ACTIVE_FALLBACK = previous
            self._depth -= 1
            if self._depth == 0:
                self._disable_forward_fallback()
```

核心机制分三层：

1. **forward_context 释放未 claim 参数**（L179 `release_available_params_for_next_forward`）：在每次 forward 开始前，将所有未被 graph claim 的已聚合参数重新 partition，恢复 Dynamo guard 期望的分片状态。`is_dynamo_guard_evaluation()` 通过检查调用栈判断当前参数访问是否来自 guard 评估——如果是，则抑制 gather，让 guard 看到分片形状。

2. **record_forward_graph 跟踪配对**（L163）：编译后的 forward 开始执行时，调用 `record_forward_graph()` 为当前 forward 分配一个 `graph_id`，记录哪些参数被这个 graph claim。这些参数的 gather 必须保持到对应的 backward 完成。

3. **complete_backward 释放**（L215）：backward 完成后调用，释放已完成 forward graph 的 claim，触发参数 partition。

```python title="record_forward_graph — z3_eager_fallback.py L163"
def record_forward_graph(self):
    """Record a grad-bearing forward whose fallback gathers must survive until backward."""
    graph_id = self._next_forward_graph_id
    self._next_forward_graph_id += 1
    self._outstanding_forward_graph_ids.add(graph_id)
    param_ids = set(self._current_forward_param_ids)
    self._graph_claim_param_ids[graph_id] = param_ids
    for ds_id in param_ids:
        self._param_graph_claim_ids.setdefault(ds_id, set()).add(graph_id)
    return graph_id
```

**Why graph claim 机制**：一个参数可能被多个 forward graph 使用（梯度累积场景）。`_param_graph_claim_ids` 记录每个参数被哪些 graph claim，只有当所有 claim 它的 graph 都完成 backward 后才能安全释放。这避免了梯度累积中提前释放导致后续 backward 读到未聚合的参数。

### Inductor 集成

当 backend 为 `"inductor"` 时，DeepCompile 需要 monkey-patch `AotAutograd.__init__` 来注入自定义 fw/bw compiler。因为 inductor 自己创建 AotAutograd 实例，DeepCompile 无法通过参数传递 compiler：

```python title="patch_create_aot_dispatcher_function — inductor.py L145"
def patch_create_aot_dispatcher_function(graph_id, z3_partition, make_fw_graph, make_bw_graph,
                                         real_inputs, param_indices, param_manager, frame_id,
                                         frames_partitioned):
    from torch._dynamo.backends.common import AotAutograd
    import functools

    # 进程级 patch：先恢复前一个 patch，再安装自己的
    if hasattr(AotAutograd, "__original_init"):
        AotAutograd.__init__ = AotAutograd.__original_init
        delattr(AotAutograd, "__original_init")
    original_init = AotAutograd.__init__

    @functools.wraps(original_init)
    def patched_init(self, **kwargs):
        _patch_deepcompile_aot_kwargs(kwargs,
                                      graph_id=graph_id, z3_partition=z3_partition,
                                      make_fw_graph=make_fw_graph, make_bw_graph=make_bw_graph, ...)
        original_init(self, **kwargs)

    AotAutograd.__original_init = original_init
    AotAutograd.__init__ = patched_init

    def restore_aotautograd():
        """Restore only this invocation's patch without clobbering a newer owner."""
        if AotAutograd.__init__ is patched_init:
            AotAutograd.__init__ = original_init
            ...

    return restore_aotautograd
```

`_patch_deepcompile_aot_kwargs`（L117）替换 kwargs 中的 `fw_compiler`、`bw_compiler`、`inference_compiler` 和 `partition_fn`，用 `patch_compiler` wrapper 包裹原始 inductor compiler——先运行 DeepCompile 的 pass 管道变换 graph，再交给 inductor codegen。

**禁用 inductor DCE**（`inductor.py` L278）：

```python title="禁用 inductor 死代码消除 — inductor.py L278"
if not hasattr(Scheduler, "is_dc_patched") or not Scheduler.is_dc_patched:
    Scheduler.is_dc_patched = True
    Scheduler.dead_node_elimination = lambda _: None
```

**Why**：`dc.*` op（allgather/release/reduce）没有输出消费者，inductor 的 DCE 会认为它们是死代码而删除。但这些 op 有 side effect（通信和内存释放），必须保留。同时，`register_custom_ops` 通过 `register_fallback_no_reuse` 为每个 dc.* op 注册 inductor lowering，标记 `never_reuse_input`/`never_reuse_output`/`force_free_input` 防止 buffer 复用导致数据竞争。

## 设计模式

| 模式 | 实现位置 | 如何使用 | Why |
|------|---------|---------|-----|
| **Factory + Closure** | `make_backend` L284 | 工厂函数返回 `backend_fn` 闭包，捕获 `compile_config`/`owned_frames`/`owner_token` | torch.compile 的 backend 接口要求一个 `(gm, inputs) → compiled_fn` 的可调用对象。闭包让每个编译上下文拥有独立状态，`owner_token` 防止不同上下文的 frame 串扰 |
| **Pipeline** | `run_opt_passes` L242 | 顺序执行 pass 列表，每个 pass 接收 `GraphModule` 返回变换后的 | pass 间自动 lint+recompile+reprofile，保证每个 pass 看到合法图。pass 可返回 `None` 表示不变换（如 `offload_adam_states_for_init`） |
| **Visitor** | `add_gather_and_release` L75 等 | 遍历 FX Graph 的 `graph.nodes`，按 `node.target`/`node.op` 匹配后插入/替换节点 | FX Graph 的 `Node` 列表既是 IR 又是操作对象，Visitor 模式自然适配。`get_real_uses`/`get_last_uses` 等 helper 处理 use-def chain |
| **Declarative Contract** | `PassContract` + `validate_schedule` | pass 声明 `provides`/`requires`/`conflicts_with`，调度器编译前校验 | 解耦 pass 间的隐式依赖。新 pass 只需声明 contract，不需要硬编码 pass 名。`CAP_Z3_GATHER_RELEASE` 能力标签让 `prefetch`/`selective_gather` 不需要知道 `zero3_compile` 的名字 |
| **Monkey-Patch + Restore** | `patch_create_aot_dispatcher_function` L145 | 运行时替换 `AotAutograd.__init__`，用后立即恢复 | inductor 内部创建 AotAutograd，无法通过参数注入。patch 是进程级的，必须 `try/finally` 恢复以防泄漏到后续编译 |
| **Schedule Queue** | `init_schedule` + `launch_compile_passes` | `deque([(step, [passes])])` 按 `global_steps` 弹出 | 支持多阶段渐进优化——前几步用简单 pass 收集 profile，后续步骤基于 profile 启用复杂优化。每步 `torch._dynamo.reset()` 保证从头编译 |
| **Registry** | `register_compile_pass` L101 + `register_custom_ops` L188 | pass 注册到 `opt_passes` dict + contract 注册到 `_pass_contracts` dict；dc.* op 注册到 inductor lowering | 解耦注册与使用。schedule 用名字引用 pass，contract 用名字查找依赖 |

## 模块间交互

- **← Engine**：`engine.compile()` 调用 `init_z3()`/`init_z1()` 启动编译；`engine.forward()` 中 `deepcompile_z3_forward_context` 包裹 forward 执行；`engine.step()` 后 `launch_compile_passes(global_steps)` 推进 schedule。引擎在 `init_z3` 中移除 ZeRO runtime hooks（`optimizer._remove_module_hooks()`），将参数管理权从 runtime hook 交给 graph op。

- **→ ZeRO-3**：DeepCompile 取代了 ZeRO-3 的 `pre_forward_module_hook`/`post_forward_module_hook` 机制。`dc.register_z3_param(ds_id, ds_shape, ds_tensor, grad_buffer, ...)` 将参数分片信息注册到 C++ handle；`dc.allgather_param`/`dc.release_param`/`dc.reduce_grad` op 在执行时调用 handle 的通信方法。`DeepCompileZ3EagerFallback` 处理编译外（eager）路径的参数 gather，保证 Dynamo guard 稳定性。

- **→ Accelerator**：`get_accelerator().synchronize()`/`empty_cache()`/`available_memory()` 在 pass 间清理 GPU 缓存；`get_accelerator().Stream()` 创建 `copy_stream` 用于 Adam 状态 offload 的异步拷贝；`get_accelerator().Event()` 做流同步。offload pass 的 `move_key`/`move_back_key` 用独立 stream 实现 offload/reload 与计算重叠。

- **→ torch.compile / Dynamo**：`make_backend` 返回的 `backend_fn` 是 torch.compile 自定义 backend；`patch_fake_tensor` 让 fake tensor mode 识别 ds tensor 的零大小形状；`_allow_dynamo_dynamic_parameter_shapes_for_z3` 关闭 `force_parameter_static_shapes` Dynamo config，允许 Z3 参数动态形状（分片→聚合变化）；`torch._dynamo.reset()` 在每次 schedule 切换时清空编译缓存。

- **→ torch._inductor**：`register_custom_ops` 为 dc.* op 注册 inductor lowering（`FallbackKernel` + `never_reuse` 标记）；`Scheduler.dead_node_elimination = lambda _: None` 禁用 DCE；`patch_compiler` wrapper 在 inductor codegen 前插入 DeepCompile pass 管道；`torch._inductor.config.size_asserts = False` 关闭 size 断言（Z3 参数形状从 0 变为完整形状会触发断言失败）。

- **→ AOT Autograd**：`get_wrapped_partitioner` 包裹 `min_cut_rematerialization_partition`，在分割后标记 `frames_partitioned`（记录哪些 frame 需要 backward）；`wrap_partition_fn` 在 Z3 场景下修正 placeholder 的 `meta["val"]` 为零大小，使 inductor 的输入验证通过。
