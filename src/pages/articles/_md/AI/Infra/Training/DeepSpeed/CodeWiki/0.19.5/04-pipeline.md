---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "流水线并行"
date: "2026-08-12T15:35:32+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "Pipeline", "1F1B", "流水线并行"]
description: "DeepSpeed 流水线并行模块通过 PipelineEngine 覆写引擎三段式训练循环，以 1F1B 调度编排 stage 间通信，将峰值激活内存从 O(micro_batches) 降到 O(stages)。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

流水线并行模块位于 `runtime/pipe/`（3,272 行），是 DeepSpeed 中唯一**覆写引擎训练循环**的模块。`PipelineEngine` 继承 `DeepSpeedEngine`，但将父类引以为傲的 `forward()` → `backward()` → `step()` 三段式流程全部禁用（`raise PipelineError`），取而代之用 `train_batch()` 统一编排——因为流水线并行需要一个独立调度系统来编排 stage 间的 p2p 通信和 micro-batch 交错，单 stage 的 forward/backward 在流水线语境下没有意义。

这个模块独立存在的根本原因：**流水线并行改变了训练循环的拓扑结构**。普通引擎的训练循环是"一个 rank 跑完完整的 forward → backward → step"，而流水线引擎是"每个 rank 只跑模型的一段，micro-batch 在 stage 间流动，通信和计算必须交错"。这种时序约束无法通过在 `backward()` 里加 if-else 分支来解决——它需要一个全新的调度层（`PipeSchedule`）来生成指令序列，再由引擎逐条执行。因此 `PipelineEngine` 不是 `DeepSpeedEngine` 的简单扩展，而是一个"同壳不同魂"的变体——共享装配逻辑（继承 `__init__` 的配置/优化器/检查点装配），替换执行逻辑。

## 调用链路

`train_batch()` 替代了传统的 forward/backward/step 三步调用，其核心链路是"构造调度 → 逐指令执行"：

```
engine.train_batch(data_iter)                        engine.py L341
├── schedule.TrainSchedule(micro_batches, stages, stage_id)  schedule.py L189
│   └── 生成 2*(micro_batches + stages - 1) 步指令序列
│
├── _exec_schedule(sched)                            engine.py L1396
│   ├── _reserve_pipe_buffers(sched.num_pipe_buffers())  ← 按 stage 位置分配 buffer
│   └── for step_cmds in pipe_schedule:              ← 逐步迭代调度
│       └── for cmd in step_cmds:                    ← 每步可能含多条指令
│           └── _INSTRUCTION_MAP[type(cmd)](**cmd.kwargs)  ← 分发到对应 _exec_* 方法
│
├── _aggregate_total_loss()                          engine.py L596
│   └── last stage: scale_loss → DP all-reduce → bcast to all pipe stages
│
└── return agg_train_loss

指令分发表 (_INSTRUCTION_MAP):
  LoadMicroBatch   → _exec_load_micro_batch     ← 首/末 stage 加载数据
  ForwardPass      → _exec_forward_pass          ← 本地前向计算
  BackwardPass     → _exec_backward_pass         ← 本地反向计算
  SendActivation   → _exec_send_activations      → p2p.send → next_stage
  RecvActivation   → _exec_recv_activations      ← p2p.recv ← prev_stage
  SendGrad         → _exec_send_grads            → p2p.send → prev_stage
  RecvGrad         → _exec_recv_grads            ← p2p.recv ← next_stage
  ReduceTiedGrads  → _exec_reduce_tied_grads     ← 跨 stage tied 权重规约
  ReduceGrads      → _exec_reduce_grads          ← DP 组内梯度规约
  OptimizerStep    → _exec_optimizer_step        ← 参数更新
```

### 1F1B 调度示意

以 4 stage、4 micro_batch 为例，`TrainSchedule` 生成 `2*(4+4-1) = 14` 步。每个 stage 的执行序列（F=Forward, B=Backward, 数字=micro_batch_id）：

```
Stage 0:  F0 F1 F2 F3 .  .  B0 B1 B2 B3 .  .  .  .
Stage 1:  .  F0 F1 F2 F3 .  .  B0 B1 B2 B3 .  .  .
Stage 2:  .  .  F0 F1 F2 F3 .  .  B0 B1 B2 B3 .  .
Stage 3:  .  .  .  F0 B0 F1 B1 F2 B2 F3 B3 .  .  .

          ↑ warm-up (前向填充)    ↑ steady-state (1F1B 交替)    ↑ cool-down
```

关键观察：Stage 3（最后一个 stage）收到 F0 后立即做 B0，无需等待——这就是"1F1B"的核心。而 Stage 0 需要先做 4 个 Forward 才开始 Backward，因为梯度要从 Stage 3 逐级回传。**越靠后的 stage 需要缓存越少的激活值**，这正是内存优化的关键。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `train_batch` in `engine.py` L341 | 流水线训练主入口 | 构造 TrainSchedule 后委托 _exec_schedule |
| `_exec_schedule` in `engine.py` L1396 | 逐指令执行调度 | 通过 _INSTRUCTION_MAP 分发，MethodType 绑定 |
| `_exec_forward_pass` in `engine.py` L722 | 本地前向计算 | 末 stage 计算 loss，支持 PartitionedTensor |
| `_exec_backward_pass` in `engine.py` L815 | 本地反向计算 | 非末 stage 用 tensor.backward(grad)，释放 output buffer |
| `_exec_send_activations` in `engine.py` L1047 | 发送激活到下一 stage | 动态 shape 时先 _send_tensor_meta |
| `_exec_recv_activations` in `engine.py` L1139 | 接收上一 stage 激活 | 复用 recv_buf 避免反复分配 |
| `_exec_send_grads` in `engine.py` L1083 | 发送梯度到上一 stage | 发送后立即释放 input buffer |
| `_exec_recv_grads` in `engine.py` L1182 | 接收下一 stage 梯度 | 分配 grad_layer 作为 backward 的 grad_tensors |
| `_exec_reduce_grads` in `engine.py` L296 | DP 组梯度规约 | _force_grad_boundary 控制累积边界 |
| `_exec_optimizer_step` in `engine.py` L1244 | 参数更新 | 调 _take_model_step，覆写父类 step |
| `TrainSchedule.steps` in `schedule.py` L197 | 生成 1F1B 指令序列 | _step_to_micro_batch 映射步号到 micro-batch |
| `TrainSchedule.num_pipe_buffers` in `schedule.py` L247 | 计算 buffer 数量 | max(2, min(stages-stage_id, micro_batches)) |
| `PipelineModule._partition_layers` in `module.py` L396 | 模型切分 | 支持 uniform/parameters/type:layername |
| `PipelineModule.forward` in `module.py` L343 | 本地前向 + activation checkpointing | 按 interval 分块，checkpointable 逐块判断 |
| `p2p.send` in `p2p.py` L46 | 发送张量到相邻 stage | dist.send 优先，fallback dist.broadcast |
| `p2p.recv` in `p2p.py` L67 | 接收张量从相邻 stage | 复用预分配 buffer |

</details>

## 核心实现

### PipelineEngine 覆写策略

`PipelineEngine` 继承 `DeepSpeedEngine` 的装配逻辑，但**彻底替换执行逻辑**。覆写的三个方法全部 raise：

```python title="runtime/pipe/engine.py L1319-1329"
def forward(self, *args, **kwargs):
    """Disabled for pipeline parallel training. See ``train_batch()``."""
    raise PipelineError("Only train_batch() is accessible in pipeline mode.")

def backward(self, *args, **kwargs):
    """Disabled for pipeline parallel training. See ``train_batch()``."""
    raise PipelineError("Only train_batch() is accessible in pipeline mode.")

def step(self, *args, **kwargs):
    """Disabled for pipeline parallel training. See ``train_batch()``."""
    raise PipelineError("Only train_batch() is accessible in pipeline mode.")
```

**为什么禁用**：在流水线并行中，单个 rank 只持有模型的一段。调用 `forward()` 只会执行本 stage 的层，输出的是中间激活值而非最终 loss——没有 loss 就无法 `backward()`，没有完整梯度就无法 `step()`。整个训练循环必须由调度器编排：先让 micro-batch 逐 stage 流过前向（首 stage 加载输入，末 stage 计算 loss），再让梯度逆向流回（末 stage 发梯度，各 stage 反向计算），最后统一规约和更新。这个时序约束是流水线并行的本质，无法通过方法参数适配。

但 `PipelineEngine` 并非完全抛弃父类——它在 `__init__` 中调用 `super().__init__(*super_args, **super_kwargs)` 复用全部装配逻辑（配置解析、优化器创建、检查点装配），并且在 `_exec_forward_pass`、`_exec_backward_pass`、`_exec_optimizer_step` 内部**回调父类方法**：

```python title="runtime/pipe/engine.py L747（_exec_forward_pass 内部）"
outputs = super().forward(inputs)  # 委托父类 forward，但只在调度器安排的时机调用
```

```python title="runtime/pipe/engine.py L822（_exec_backward_pass 内部，末 stage）"
if self.is_last_stage():
    super().backward(self.loss)  # 末 stage 委托父类 backward
    return
```

这是**模板方法模式的变体**——父类定义"做什么"（forward/backward/step 的内部逻辑），子类定义"何时做"（调度器编排调用时机）。

### enable_backward_allreduce = False 与 ReduceGrads 指令

普通引擎在 `backward()` 内部自动触发梯度 all-reduce（通过 `enable_backward_allreduce = True`）。流水线引擎显式关闭这个机制：

```python title="runtime/pipe/engine.py L79-80"
# We schedule the all-reduces, so disable it in super().backward()
self.enable_backward_allreduce = False
```

**为什么关闭**：在 1F1B 调度中，每个 stage 的 backward 被拆成多个 micro-batch 的 BackwardPass 指令。如果在每次 BackwardPass 时都 all-reduce，同一 micro-batch 的梯度会在不同 stage 的不同时刻被多次规约——既浪费通信，又可能引入同步死锁（某个 stage 还在 forward，另一个 stage 已经 backward 要 all-reduce）。

正确的做法是：让每个 micro-batch 的 BackwardPass 只做本地梯度累积，等所有 micro-batch 都 backward 完毕后，在调度序列的最后统一执行 `ReduceTiedGrads` → `ReduceGrads` → `OptimizerStep`：

```python title="runtime/pipe/schedule.py L237-242（TrainSchedule.steps 末尾）"
# Model step at the end of the batch
if step_id == total_steps - 1:
    cmds.append(ReduceTiedGrads())
    cmds.append(ReduceGrads())
    cmds.append(OptimizerStep())
```

`_exec_reduce_grads` 通过 `_force_grad_boundary` 标志位控制 `is_gradient_accumulation_boundary()` 的返回值，确保 `_take_model_step` 只在调度末尾执行一次：

```python title="runtime/pipe/engine.py L296-304"
def _exec_reduce_grads(self):
    self._force_grad_boundary = True
    if self.pipeline_enable_backward_allreduce:
        if self.using_bf16_optimizer:
            self._bf16_reduce_grads()       # PP+BF16 work for ZeRO Stage 1
        else:
            self.allreduce_gradients(bucket_size=MEMORY_OPT_ALLREDUCE_SIZE)
    self._force_grad_boundary = False
```

### 1F1B 调度与内存优化

`TrainSchedule` 的核心是 `_step_to_micro_batch()` 方法——它将线性步号映射为 (micro_batch_id, is_forward) 二元组，实现 1F1B 交错：

```python title="runtime/pipe/schedule.py L258-278"
def _step_to_micro_batch(self, step_id):
    if _is_even(step_id) and _is_even(self.stage_id):
        micro_batch_id = self._even_step_forward_id(step_id)
        is_forward = True
    elif _is_odd(step_id) and _is_odd(self.stage_id):
        micro_batch_id = self._odd_step_forward_id(step_id)
        is_forward = True
    elif _is_even(step_id) and _is_odd(self.stage_id):
        micro_batch_id = self._even_step_backward_id(step_id)
        is_forward = False
    elif _is_odd(step_id) and _is_even(self.stage_id):
        micro_batch_id = self._odd_step_backward_id(step_id)
        is_forward = False
    return micro_batch_id, is_forward
```

奇偶交错的设计确保相邻 stage 在同一步内一个做 Forward、另一个做 Backward——前向和反向在流水线中同时推进，避免所有 stage 同时缓存所有 micro-batch 的激活值。

**峰值内存优化**：`num_pipe_buffers()` 方法是 1F1B 内存优化的数学核心：

```python title="runtime/pipe/schedule.py L247-256"
def num_pipe_buffers(self):
    """Return the number of pipeline buffers required for this stage.

    This is equivalent to the maximum number of in-flight forward passes,
    since we need to remember the activations of forward passes in order
    to run backpropagation. For synchronous 1F1B, this is equivalent to
    the index difference between this stage and the last stage.
    """
    buffers = min(self.stages - self.stage_id, self.micro_batches)
    return max(2, buffers)
```

**为什么 `stages - stage_id` 是所需 buffer 数**：在 1F1B 的稳态阶段，stage `i` 需要同时缓存 `stages - i` 个 micro-batch 的激活值。因为从 stage `i` 发出的前向激活要经过 `stages - i - 1` 个 stage 才到末 stage，末 stage 做 backward 后梯度又要回传 `stages - i - 1` 个 stage 才回到 stage `i`——这期间 stage `i` 又做了若干次 forward。具体地：

- Stage 0（首 stage）：需 `stages` 个 buffer（全量缓存）
- Stage `stages-1`（末 stage）：需 `max(2, 1)` = 2 个 buffer（几乎不缓存）

对比朴素的 GPipe 调度（所有 micro-batch 先全部 forward 再全部 backward），峰值内存从 `O(micro_batches)` 降到 `O(stages)`——当 `micro_batches >> stages` 时（如 64 micro-batch、4 stage），内存节省 16 倍。`max(2, ...)` 保证最少 2 个 buffer 用于 send/recv 的双缓冲交替。

### PipelineModule 切分

`PipelineModule` 是流水线并行的模型容器——它把用户的 `nn.Sequential` 或 `LayerSpec` 列表按某种策略切分到各 stage，每个 rank 只构建和持有自己那段层。切分逻辑在 `_partition_layers()`：

```python title="runtime/pipe/module.py L396-421"
def _partition_layers(self, method='uniform'):
    num_stages = self._topo.get_dim('pipe')
    stage_id = self._topo.get_coord(self.global_rank).pipe

    if method == 'uniform':
        num_layers = len(self._layer_specs)
        self.parts = ds_utils.partition_uniform(num_items=num_layers, num_parts=num_stages)
    elif method == 'parameters':
        param_counts = self._count_layer_params()
        self.parts = ds_utils.partition_balanced(weights=param_counts, num_parts=num_stages)
    elif method.startswith('type:'):
        layertype = method.split(':')[1]
        binary_weights = [0] * len(self._layer_specs)
        for idx in self._find_layer_type(layertype):
            binary_weights[idx] = 1
        self.parts = ds_utils.partition_balanced(weights=binary_weights, num_parts=num_stages)
    elif method == 'profile':
        raise NotImplementedError(f'Partitioning method {method} not implemented.')
```

三种切分策略各有适用场景：

| 策略 | 切分依据 | 适用场景 | 潜在问题 |
|------|---------|---------|---------|
| `uniform` | 层数均分 | 层大小均匀的模型（如纯 Transformer） | embedding 层参数量大时会不均衡 |
| `parameters` | 参数量均衡 | 层大小不均（含 embedding/lm_head） | 需逐层构建计数，初始化稍慢 |
| `type:layername` | 按层类型边界切分 | 要求 stage 间不拆散同类型层块 | 需要正则匹配类名，灵活性有限 |

切分后 `_set_bounds()` 设置 `_local_start` / `_local_stop`，`_build()` 只构建 `[start, stop)` 范围内的层。`forward()` 中的 `exec_range_func` 只遍历 `self.forward_funcs`（本地层列表），实现 stage 内的前向。

### activation checkpointing 与 PipelineModule.forward

`PipelineModule.forward()` 不是简单的逐层调用——它按 `activation_checkpoint_interval` 将本地层分块，对每个块判断是否可 checkpoint，再选择 checkpoint 或直接执行：

```python title="runtime/pipe/module.py L373-394"
if self.activation_checkpoint_interval == 0:
    func = exec_range_func(0, len(self.forward_funcs))
    x = func(forward_input)
else:
    num_layers = len(self.forward_funcs)
    x = forward_input
    for start_idx, is_checkpointable_result in \
        zip(range(0, num_layers, self.activation_checkpoint_interval),
            self.is_checkpointable_results):
        end_idx = min(start_idx + self.activation_checkpoint_interval, num_layers)
        if is_checkpointable_result:
            x = self.activation_checkpoint_func(exec_range_func(start_idx, end_idx), *x)
        else:
            x = exec_range_func(start_idx, end_idx)(*x)
```

**为什么逐块判断而非全局判断**：不同层的可 checkpoint 性不同。embedding 层的输入 `requires_grad=False`，reentrant checkpoint 无法处理（梯度不会回传），所以 `_is_checkpointable()` 会将含 embedding 的块标记为不可 checkpoint。`_precompute_checkpointable_values()` 在初始化时预计算每个块的判断结果并缓存——当 `set_checkpoint_interval()` 改变 interval 时才重新计算。

### p2p 通信

stage 间的激活值和梯度传递通过 `p2p.py` 的 `send()` / `recv()` 完成。这两个函数有两条路径——优先用 `dist.send/recv`，旧版 PyTorch（< 1.8）fallback 到 `dist.broadcast`：

```python title="runtime/pipe/p2p.py L46-64"
def send(tensor, dest_stage, async_op=False):
    assert async_op == False, "Doesn't support async_op true"
    src_stage = _grid.get_stage_id()
    _is_valid_send_recv(src_stage, dest_stage)       # 只允许相邻 stage
    dest_rank = _grid.stage_to_global(stage_id=dest_stage)
    if can_send_recv():                                # PyTorch >= 1.8
        return dist.send(tensor, dest_rank)
    else:
        group = _get_send_recv_group(src_stage, dest_stage)
        src_rank = _grid.stage_to_global(stage_id=src_stage)
        return dist.broadcast(tensor, src_rank, group=group, async_op=async_op)
```

**为什么 `async_op` 被硬编码为 False**：1F1B 调度中的 send/recv 必须严格配对——如果异步发送，后续的 ForwardPass/BackwardPass 可能在数据未到达时执行，导致计算结果错误或死锁。`_is_valid_send_recv()` 断言只允许相邻 stage 通信，因为流水线的拓扑是线性的——跳跃通信会打乱 1F1B 的时序。

`_exec_send_activations` 在动态 shape 或首次发送时，先通过 `_send_tensor_meta` 发送元数据（dtype、shape），让接收方预分配正确大小的 buffer：

```python title="runtime/pipe/engine.py L1061-1063"
if self.dynamic_shape or self.first_output_send:
    self.first_output_send = False
    self._send_tensor_meta(outputs, self.next_stage)
```

之后固定 shape 的发送复用预分配的 `pipe_recv_buf`，避免反复分配显存。元数据通过固定大小的 `TENSOR_META_SIZE = 256` int32 buffer 传输，编码了类型标记、dtype、ndims 和 shape。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 命令模式 | `PipeInstruction` 子类 + `_INSTRUCTION_MAP` in `engine.py` L1383-1394 | 调度器生成指令对象，引擎按类型分发执行——解耦调度策略与执行逻辑，新增指令类型只需加子类+映射条目 |
| 模板方法变体 | `PipelineEngine` 覆写 `forward/backward/step`，内部回调 `super().forward()` / `super().backward()` | 父类定义"做什么"，子类定义"何时做"——共享装配逻辑但替换执行时序 |
| 策略模式 | `TrainSchedule` / `InferenceSchedule` / `DataParallelSchedule` in `schedule.py` | 同一引擎支持不同调度策略（训练用 1F1B、推理用纯前向、退化到纯 DP），通过 `PipeSchedule` 抽象基类多态 |
| 生成器模式 | `PipeSchedule.__iter__` + `steps()` in `schedule.py` L125-132 | 调度器是 Python generator，逐步 yield 指令列表——天然支持"按步推进"的执行语义，内存中不需要同时保存全部指令 |
| 模板方法 | `_partition_layers` method dispatch in `module.py` L396 | 按方法名分发切分策略，`uniform`/`parameters`/`type:` 三种策略共享 `_set_bounds` 后续逻辑 |

## 模块间交互

流水线模块与 DeepSpeed 其他模块的交互关系：

- **← 继承 DeepSpeedEngine**：`PipelineEngine`（`engine.py` L60）继承 `DeepSpeedEngine`，复用 `__init__` 的全部装配逻辑（配置解析、优化器创建、检查点装配、数据加载器构建）。在 `deepspeed.initialize()` 的工厂分支中，当检测到 `isinstance(model, PipelineModule)` 时创建 `PipelineEngine` 而非 `DeepSpeedEngine`。

- **→ comm p2p**：`p2p.py` 封装了 stage 间的点对点通信。`init_process_groups()` 在 `PipelineEngine.__init__` 中调用（L174），为旧版 PyTorch 创建相邻 stage 的 process group。`send()` / `recv()` 通过 `_grid.stage_to_global()` 将 stage_id 转为 global rank，再用 `dist.send` / `dist.recv` 通信。

- **→ topology**：`ProcessTopology`（`topology.py` L12）管理 N 维坐标到 rank 的映射。`PipelineParallelGrid`（L251）在 `ProcessTopology` 之上构建通信组——`pp_group`（流水线组）、`dp_group`（数据并行组）、`p2p_groups`（相邻 stage 对）。`PipelineModule.__init__` 创建 grid 并从中获取 `stage_id`。

- **→ activation_checkpointing**：`PipelineModule.forward` 调用 `self.activation_checkpoint_func`（默认 `checkpointing.checkpoint`，可配置为 `non_reentrant_checkpoint`）。`PipelineEngine.__init__` 从 config 读取 `use_reentrant` 和 `activation_checkpoint_interval`，通过 `module.activation_checkpoint_func` 和 `module.activation_checkpoint_interval` 注入到 module。

- **→ PartitionedTensor**：当 model parallel（tensor slicing）与 pipeline 并行组合时，`_exec_forward_pass` 和 `_exec_backward_pass` 用 `PartitionedTensor` 在 stage 间传递分片后的激活值——只传本 rank 持有的部分，配合 metadata 重建完整张量，减少通信量。

- **→ BF16_Optimizer**：`PipelineEngine` 检测 `type(self.optimizer) == BF16_Optimizer`（L85），在 `_exec_backward_pass` 中手动调用 `optimizer.clear_lp_grads()` 和 `optimizer.update_hp_grads()`（L863/L885），因为非末 stage 不走 `super().backward()` 而是直接 `tensor.backward(grad)`，绕过了 BF16 optimizer 的梯度管理逻辑。

- **→ DeepSpeedEngine 的梯度累积边界**：`PipelineEngine.is_gradient_accumulation_boundary()`（L682）覆写为返回 `self._force_grad_boundary`——只有 `ReduceGrads` 和 `OptimizerStep` 指令执行时才为 True，其余时刻为 False。这让父类的梯度累积逻辑在流水线模式下"失效"，由调度器全权控制更新时机。

- **互斥约束**：`PipelineEngine.__init__` 断言 `self.zero_optimization_stage() < ZeroStageEnum.gradients`（L76）——ZeRO-2 和 ZeRO-3 与流水线并行不兼容。因为 ZeRO-2/3 需要在 backward 时即时 reduce-scatter 梯度，而流水线引擎已关闭 `enable_backward_allreduce`，两套机制冲突。只有 ZeRO-1（仅分片优化器状态）可与流水线并行共存。
