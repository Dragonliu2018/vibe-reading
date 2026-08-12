---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "张量并行与通信"
date: "2026-08-12T15:52:23+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "通信", "Ulysses", "张量并行", "NCCL"]
description: "DeepSpeed 的通信层是所有分布式策略的共享基座——从 ZeRO 的 allgather/reduce-scatter 到 Ulysses 的 all-to-all 转置，再到 AMD MI300 的 SDMA 快速路径。本文解读通信后端抽象、cdb 全局分发、@timed_op 装饰器、Ulysses 序列并行核心机制，以及 TPConfig 的优先级链。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

通信是 DeepSpeed 多硬件适配的核心基座。ZeRO 的参数分片依赖 allgather/reduce-scatter，张量并行（TP）依赖 all-reduce，序列并行（SP）依赖 all-to-all——所有分布式策略最终都要通过通信原语落地。DeepSpeed 没有直接使用 `torch.distributed`，而是在其上构建了一层 `deepspeed.comm` 抽象：通过 `Backend` 基类 → `TorchBackend`/`CCLBackend` 子类的继承体系，配合 `cdb` 全局单例做运行时分发，实现对 NCCL、CCL（Intel GPU）、mori SDMA（AMD MI300）等多硬件后端的透明支持。

这层抽象的核心价值在于：上层代码（ZeRO、Engine、Pipe、Inference）只调 `deepspeed.comm.all_reduce()`，不需要知道底层跑在 NVIDIA NCCL 还是 Intel oneCCL 上；通信计时/日志通过 `@timed_op` 装饰器统一织入，不侵入业务逻辑。张量并行和序列并行则在这层通信原语之上，通过 `TPConfig` 配置和 `_SeqAllToAll` autograd Function 实现 GPU 间的维度转置与梯度对偶。

## 调用链路

### 通用通信调用流程

一次 `deepspeed.comm.all_reduce()` 调用的完整路径：

```
上层模块 (ZeRO/Engine/Pipe/Inference)
  │  deepspeed.comm.all_reduce(tensor, group=...)
  ▼
@timed_op 装饰器 (comm/comm.py L106)
  ├── comms_logger.enabled? → timers.start(log_name)
  ├── 调用被装饰函数
  │     └── cdb.all_reduce(tensor, op, group, async_op)
  │           └── TorchBackend.all_reduce (comm/torch.py L182)
  │                 └── @disable_compiler_collective → torch.distributed.all_reduce
  └── finally: synchronize + timers.stop + comms_logger.append
```

关键设计：`@timed_op` 不是简单的计时器——它在 `finally` 块中调用 `get_accelerator().synchronize()` 强制同步 GPU stream 才能拿到准确延迟。如果后端是 MPI 还需额外 `cdb.barrier()`，因为 MPI stream sync 不保证 CPU 侧完成。

### Ulysses all-to-all 流程

Ulysses 序列并行的核心思想：用 all-to-all 转置 sequence/head 维度，使每个 rank 持有完整序列但只含部分 attention head。通信量与序列长度无关，仅取决于 head 数和 hidden dim——这打破了传统 all-reduce 通信量随序列长度 O(P) 放大的瓶颈。

```
DistributedAttention.forward (sequence/layer.py L387)
  │
  ├── _SeqAllToAll.apply(spg, query, scatter_idx=2, gather_idx=0)   ← scatter heads, gather seq
  │     └── forward: single_all_to_all → dist.all_to_all_single     [s/p, h → s, h/p]
  │
  ├── _SeqAllToAll.apply(spg, key, scatter_idx=2, gather_idx=0)     ← 同上
  ├── _SeqAllToAll.apply(spg, value, scatter_idx=2, gather_idx=0)   ← 同上
  │
  >>> local_attn(query_layer, key_layer, value_layer)               ← 本地完整序列 attention
  │
  └── _SeqAllToAll.apply(spg, context, scatter_idx=0, gather_idx=2) ← gather seq, scatter heads
        └── forward: single_all_to_all → dist.all_to_all_single     [s, h/p → s/p, h]

backward (自动):
  _SeqAllToAll.backward → 交换 scatter_idx ↔ gather_idx 再调 _SeqAllToAll.apply
  即 forward 的对偶操作：forward scatter heads → backward gather heads
```

输入 shape `[s/p, b, h, d]`（每个 rank 持有 1/p 序列、全部 head），经 all-to-all 后变为 `[s, b, h/p, d]`（完整序列、1/p head）。backward 天然对偶——只需交换 scatter/gather 索引再次 all-to-all 即可。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `init_distributed` in `comm/comm.py` L792 | 初始化分布式后端 | 按 accelerator 探测后端名，找不到则 fallback TorchBackend |
| `timed_op` in `comm/comm.py` L106 | 通信操作计时/日志装饰器 | finally 块强制 sync 才拿准确延迟；MPI 额外 barrier |
| `set_backend` in `comm/comm.py` L203 | 按 backend name 切换 cdb 全局单例 | 四种 backend name 分发到对应实例 |
| `TorchBackend.all_reduce` in `comm/torch.py` L182 | all_reduce 包装 | `@disable_compiler_collective` 防 torch.compile 融合 |
| `TorchBackend.all_gather_into_tensor` in `comm/torch.py` L252 | all-gather 融合输出 | 先试 mori SDMA 快速路径，失败再 fallback NCCL |
| `CCLBackend.run_collective` in `comm/ccl.py` L63 | CCL collective 分发 | available_coll 有则走 ccl_comm_op，无则 super() 走 torch |
| `mori.allgather_into_tensor` in `comm/mori.py` L202 | AMD SDMA all-gather | best-effort：supports() 不过或调用失败返回 None |
| `single_all_to_all` in `sequence/layer.py` L241 | Ulysses all-to-all 核心逻辑 | 不均匀 head 走 uneven_heads_all2all 专用路径 |
| `_SeqAllToAll.forward` in `sequence/layer.py` L300 | autograd all-to-all forward | 保存 scatter/gather idx 供 backward 对偶 |
| `_SeqAllToAll.backward` in `sequence/layer.py` L344 | autograd all-to-all backward | 交换 scatter_idx ↔ gather_idx 再 apply |
| `DistributedAttention.forward` in `sequence/layer.py` L387 | Ulysses SP attention 前向 | 3 次 all-to-all (q/k/v) + local attn + 1 次 all-to-all (output) |
| `UlyssesSPAttentionHF.register_with_transformers` in `ulysses_sp.py` L394 | HF 集成入口 | 覆盖 ALL_ATTENTION_FUNCTIONS[key] 而非注册新 key |
| `mori.init` in `comm/mori.py` L116 | SDMA handle 初始化 | DS_SDMA_ALLGATHER=1 opt-in，失败静默 fallback |

</details>

## 核心实现

### 通信后端抽象与工厂

#### Backend 基类与 cdb 全局分发

`deepspeed.comm` 的设计哲学是"与 `torch.distributed` API 完全兼容"——用户可以把 `from deepspeed import comm as dist` 直接替换 `import torch.distributed as dist`，代码不改一行。这要求所有公共 API 签名与 `torch.distributed` 对齐。

实现上采用全局单例分发模式：

```python title="comm/comm.py L46-48"
# Current deepspeed.comm backend (cdb) global object for simple access by client code
cdb = None
```

`cdb` 是模块级全局变量，持有当前激活的 `Backend` 实例。所有公共函数（`all_reduce`、`all_gather`、`broadcast` 等）都是 `@timed_op` 装饰的薄包装，内部直接调 `cdb.method()`：

```python title="comm/comm.py L644-658"
@timed_op
def all_reduce(tensor,
               op=ReduceOp.SUM,
               group=None,
               async_op=False,
               prof=False,
               log_name='all_reduce',
               debug=get_caller_func()):
    global cdb
    return cdb.all_reduce(tensor, op, group, async_op)
```

`set_backend()` 根据 `get_accelerator().communication_backend_name()` 返回的后端名（`nccl`/`mpi`/`ccl`/`hccl`），将 `cdb` 指向已初始化的对应实例。`init_distributed()` 是最终装配入口——它先尝试 `init_deepspeed_backend` + `set_backend`，如果 `cdb` 仍为 None 但 `torch.distributed` 已初始化（用户自己初始化了），则直接创建 `TorchBackend` 包装它：

```python title="comm/comm.py L822-858"
if cdb is None:
    init_deepspeed_backend(get_accelerator().communication_backend_name(), timeout, init_method)
    set_backend()
if cdb is None and torch.distributed.is_initialized():
    # The user initialized torch.dist themselves, create cdb and short-circuit
    cdb = TorchBackend(dist_backend, timeout, init_method)
    return
# ...
cdb = TorchBackend(dist_backend, timeout, init_method, rank, world_size)
```

**为什么用全局单例而非依赖注入**：通信调用在代码各处（ZeRO、Engine、Pipe），如果每次都传 backend 对象，侵入性太大。全局单例让上层代码完全无感知后端切换——换硬件只改 accelerator 配置，`cdb` 自动指向正确后端，所有 `deepspeed.comm.*` 调用无需改动。

#### TorchBackend：torch.distributed 的轻量包装

`TorchBackend`（`comm/torch.py` L98）是默认且唯一正式支持的后端。它包装 `torch.distributed` 的子集 API，不重新实现 collective 算法。每个方法都加了 `@disable_compiler_collective` 装饰器：

```python title="comm/torch.py L25-28"
def disable_compiler_collective(func):
    if required_torch_version(min_version=2.3):
        return func
    return compiler.disable(func)
```

**为什么防止 torch.compile 融合 collective**：`torch.compile` 会尝试将多个 collective 操作融合优化，但这会破坏 DeepSpeed 的通信-计算 overlap 调度——ZeRO-3 的 prefetch pipeline 依赖各 collective 操作的独立 stream 控制和精确时序。PyTorch 2.3+ 已内置 `disable` 语义，旧版本才需显式 `compiler.disable`。

`TorchBackend.__init__` 还做了两件重要的事：

1. **API 版本兼容探测**：`get_all_gather_function()` 探测 `torch.distributed.all_gather_into_tensor`（新名）或 `_all_gather_base`（旧名），运行时绑定正确函数引用。
2. **SDMA 后端初始化**：`_init_sdma_backend()` 尝试加载 mori（AMD MI300 的 SDMA 快速路径），失败静默忽略。

#### CCLBackend：Intel GPU 适配

`CCLBackend`（`comm/ccl.py` L35）继承 `TorchBackend`，复用父类的 `torch.distributed` 基础设施，但覆盖了所有 collective 方法走 `ccl_comm_op`（Intel oneCCL 的 C++ binding）。核心分发逻辑在 `run_collective`：

```python title="comm/ccl.py L63-77"
def run_collective(self, name, **kwargs):
    if name in self.available_coll:
        if 'group' in kwargs:
            kwargs['group'] = self.get_all_ranks_from_group(kwargs['group'])
        func = "self.ccl_comm_op." + name
        eval(func)(*(kwargs.values()))
        return CCLHandler(self.ccl_comm_op)
    else:
        func = "super(CCLBackend, self)." + name
        eval(func)(*(kwargs.values()))
        return CCLHandler(self.ccl_comm_op)
```

**为什么用 `eval` 做分发**：oneCCL 的 C++ binding 按方法名暴露接口（`ccl_comm_op.all_reduce`、`ccl_comm_op.all_gather` 等），`available_coll` 动态查询后端支持哪些 collective——不支持的就 fallback 到父类（`TorchBackend`）的 torch.distributed 实现。这保证了 CCL 不支持的 collective 自动降级，用户不需要感知。

#### mori SDMA：AMD MI300 all-gather 快速路径

`mori` 模块（`comm/mori.py`）是 AMD MI300 上的 SDMA（Shared Direct Memory Access）快速路径，专门优化 `all_gather_into_tensor` 一个操作。它不是独立后端，而是嵌入 `TorchBackend.all_gather_into_tensor` 的透明加速层：

```python title="comm/torch.py L251-266"
@disable_compiler_collective
def all_gather_into_tensor(self, output_tensor, input_tensor, group=None, async_op=False):
    from . import mori as _mori
    sdma_work = _mori.allgather_into_tensor(input_tensor, output_tensor, group=group)
    if sdma_work is not None:
        return sdma_work
    if self.has_all_gather_into_tensor():
        return self.all_gather_function(output_tensor=output_tensor,
                                        input_tensor=input_tensor,
                                        group=group,
                                        async_op=async_op)
```

SDMA 的设计原则是 **best-effort + opt-in**：

- **opt-in**：必须设 `DS_SDMA_ALLGATHER=1` 才启用。默认关闭即使 mori 已安装——避免 DeepSpeed 的行为随外部依赖的安装状态静默变化，方便 A/B 对比测试。
- **best-effort**：`supports()` 预检查四项条件（handle 已初始化、WORLD process group、shard 不超 transit buffer、dtype 在支持列表），任一不满足返回 `None`，调用方透明 fallback 到 NCCL/RCCL。运行时调用失败也只 warn 一次再 fallback。

```python title="comm/mori.py L181-199"
def supports(input_tensor: torch.Tensor, group=None) -> bool:
    if _handle is None:
        return False
    if group is not None and group is not torch.distributed.group.WORLD:
        return False
    if input_tensor.numel() > _max_numel:
        return False
    if _dtype_map is None or input_tensor.dtype not in _dtype_map:
        return False
    return True
```

**为什么只优化 all-gather**：ZeRO-3 的 forward/backward 参数按需 allgather 是通信瓶颈——每层参数都要 allgather 一次。SDMA 在 MI300 的 intra-node 通信上比 RCCL 的 ring allgather 更快（直接共享内存拷贝，无协议栈开销），其他 collective 操作瓶颈不在此。

`_SdmaWork` 的 `wait()` 只注册 stream 依赖不阻塞 CPU——ZeRO-3 的 prefetch pipeline 依赖 CPU 不被阻塞才能提前排下一个 bucket：

```python title="comm/mori.py L54-59"
class _SdmaWork:
    def wait(self):
        get_accelerator().current_stream().wait_event(self._event)
```

### Ulysses all-to-all 与序列并行

#### _SeqAllToAll：autograd Function 的对偶性

`_SeqAllToAll`（`sequence/layer.py` L297）是 Ulysses SP 的核心——一个 `torch.autograd.Function`，其 forward 做 all-to-all 维度转置，backward 天然是 forward 的对偶操作（交换 scatter/gather 索引再 all-to-all 一次）。

```python title="sequence/layer.py L297-348"
class _SeqAllToAll(torch.autograd.Function):

    @staticmethod
    def forward(ctx, group, input, scatter_idx, gather_idx, batch_dim_idx,
                stream=None, handle=None, type=None, is_fwd=True):
        ctx.group = group
        ctx.scatter_idx = scatter_idx
        ctx.gather_idx = gather_idx
        # ... 保存上下文 ...
        if ctx.handle is None:
            res = single_all_to_all(input, scatter_idx, gather_idx, batch_dim_idx, group, False)
        else:
            # overlap communication path（q/k 的 forward/backward 可以 overlap）
            # ...
        return res

    @staticmethod
    def backward(ctx, *grad_output):
        return (None,
                _SeqAllToAll.apply(ctx.group, *grad_output, ctx.gather_idx, ctx.scatter_idx,
                                   ctx.batch_dim_idx, ctx.stream, ctx.handle, ctx.type, False),
                None, None, None, None, None, None, None)
```

**为什么 backward 天然对偶**：all-to-all 是对称操作——forward 把 `scatter_idx` 维度分散、`gather_idx` 维度聚合；backward 需要把梯度沿 forward 的聚合方向分散回来，等价于交换 scatter/gather 索引再做一次 all-to-all。这个数学对偶性让 backward 实现零额外代码——递归调用 `_SeqAllToAll.apply` 即可。

`single_all_to_all` 是实际执行 all-to-all 的函数，它先通过 `_generate_layout_params` 计算 pre/post all-to-all 的 reshape 和 permute 参数，然后调 `dist.all_to_all_single`：

```python title="sequence/layer.py L241-274"
def single_all_to_all(input, scatter_idx, gather_idx, batch_dim_idx, group, async_op=False, handle=None, type=None):
    seq_world_size = dist.get_world_size(group)
    num_heads = input.shape[2]

    if get_num_kv_heads() is not None or (num_heads % seq_world_size != 0 and not scatter_idx < 2):
        # GQA/MQA 不均匀 head 走专用路径
        return uneven_heads_all2all(input, scatter_idx, gather_idx, batch_dim_idx, group)

    pre_all2all_permute_idx, pre_all2all_inp_shape, post_all2all_permute_idx, post_all2all_res_shape = \
        _generate_layout_params(scatter_idx, batch_dim_idx, seq_world_size, input)

    input_t = pre_all2all_fun(pre_all2all_permute_idx, pre_all2all_inp_shape, input)
    post_all2all_fun = post_all2all(post_all2all_permute_idx, post_all2all_res_shape)
    output = torch.empty_like(input_t)
    work = dist.all_to_all_single(output, input_t, group=group, async_op=async_op)
    # ...
    res = post_all2all_fun(output)
    return res
```

当 head 数不能被 SP world size 整除（GQA/MQA 场景如 7 heads / 4 ranks），走 `uneven_heads_all2all` 专用路径——它按 `[2,2,2,1]` 不均匀切分 head，用 `output_split_sizes`/`input_split_sizes` 参数调 `dist.all_to_all_single`，再手动拼接 large/small chunk。

#### DistributedAttention：两次 all-to-all 的 attention

`DistributedAttention`（`sequence/layer.py` L351）是 Ulysses SP 的 attention 包装层。它的 forward 分两阶段：

1. **forward 前**：对 q/k/v 各做一次 `_SeqAllToAll`（scatter_idx=2 即 head 维，gather_idx=0 即 seq 维），把 `[s/p, b, h, d]` 转成 `[s, b, h/p, d]`——每个 rank 拿到完整序列、部分 head。
2. **local attention**：调 `self.local_attn(query_layer, key_layer, value_layer)` 在本地完整序列上做 attention。
3. **forward 后**：对 context_layer 做一次反向 `_SeqAllToAll`（scatter_idx=0 即 seq 维，gather_idx=2 即 head 维），把 `[s, b, h/p, d]` 转回 `[s/p, b, h, d]`。

```python title="sequence/layer.py L426-460"
query_layer = _SeqAllToAll.apply(self.spg, query, self.scatter_idx, self.gather_idx, ...)
key_layer = _SeqAllToAll.apply(self.spg, key, self.scatter_idx, self.gather_idx, ...)
value_layer = _SeqAllToAll.apply(self.spg, value, self.scatter_idx, self.gather_idx, ...)
# ...
context_layer = self.local_attn(query_layer, key_layer, value_layer, *args, **kwargs)
output = _SeqAllToAll.apply(self.spg, context_layer, self.gather_idx, self.scatter_idx, ...)
```

**为什么用两次 all-to-all 而非 all-reduce**：传统 TP 在 attention 后做 all-reduce 同步各 head 的输出，通信量 = hidden_size × batch × seq_len × sizeof(dtype)，随 seq_len 线性增长。Ulysses 的 all-to-all 通信量 = head_dim × num_heads / p × batch × seq_len / p——每个 rank 只收发自己那 1/p 的 head 和 1/p 的 seq，通信量与序列长度的关系被 p 级并行度稀释。序列越长，Ulysses 的优势越大。

#### UlyssesSPAttentionHF：HuggingFace 集成版

`UlyssesSPAttentionHF`（`runtime/sequence_parallel/ulysses_sp.py` L50）是 HF Transformers 的集成版本，比 `DistributedAttention` 更严格——强制输入 shape 为 `[sl, bs, hc, hs]`，通过 `register_with_transformers` 注入 HF 的 `ALL_ATTENTION_FUNCTIONS` 注册表。

注入策略被称为 "Being John Malkovich"——不注册新的 `"ulysses"` key，而是直接覆盖用户请求的 `core_attn_implementation`（如 `"flash_attention_2"`）对应的注册项：

```python title="runtime/sequence_parallel/ulysses_sp.py L552-559"
# We don't do: ALL_ATTENTION_FUNCTIONS.register("ulysses", uattn_wrapper)
# Instead we override the requested core implementation key in ALL_ATTENTION_FUNCTIONS
# with our wrapper. All other code paths relying on the original core attn_implementation
# will still be executed — we only intercept at the point of calling attention.
ALL_ATTENTION_FUNCTIONS[core_attn_implementation] = uattn_wrapper
```

**为什么不注册新 key**：HF Transformers 内部有很多 `if self.config._attn_implementation == "flash_attention_2"` 的特殊分支（如 packed sequence 处理、FlexAttention 路径选择）。注册新 key 会错过这些分支，导致 attention 行为不一致。直接覆盖原 key 则让 HF 以为在跑原始 attention，实际上 attention 调用被 SP wrapper 拦截，其余逻辑不变。

`UlyssesSPAttentionHF.forward` 的 all-to-all 使用 `_DimZeroAllToAll`（dim=0 转置），比 `_SeqAllToAll` 更简单——它直接对 dim 0 做 all-to-all，配合 `rearrange` 做 shape 变换，不需要 scatter_idx/gather_idx 参数。forward 还处理了 `position_ids` 的 all-gather（SP 要求 position_ids 在 all-to-all 后重建为全局位置，否则 causal masking 会错误地把 gathered 序列当成 packed sequence）。

#### TPConfig 与 TpTrainingManager

`TPConfig`（`runtime/tensor_parallel/config.py` L18）是张量并行的配置模型，核心字段：

| 字段 | 类型 | 默认值 | 含义 |
|------|------|--------|------|
| `tp_size` | int | 1 | TP 切分设备数 |
| `tp_grain_size` | int | 1 | MLP/lm_head 的 TP 粒度（DNN 库偏好 2 的幂） |
| `mpu` | object | None | 实现 `get_{model,data}_parallel_{rank,group,world_size}()` 的并行状态对象 |
| `tp_group` | object | None | TP process group |

`TpTrainingManager`（`runtime/tensor_parallel/tp_manager.py` L12）是 TP 训练的管理器。它调用 `AutoTP.tp_parser(model)` 解析模型结构，然后通过 `replace_transformer_layer` 替换线性层为 TP 版本。

DeepSpeedEngine 中的 TP 优先级链（`runtime/engine.py` L721 注释明确标注）：

```
custom partition_config > HF tp_plan > AutoTP parser
```

1. **Tier 1 custom config**：用户在 DS config 中指定 `partition_config`（自定义 `TPLayerSpec` 规则）或 `preset_model`（内置预设如 `"llama"`），直接构建 `AutoTPConfig` 替换模块。
2. **Tier 2 HF tp_plan**：从 HF model 的 `base_model_tp_plan`、class `_tp_plan`、instance `_tp_plan` 三处合并提取（`_get_hf_tp_plan` in `config.py` L149），经 `TPPlanConverter.convert()` 转成 `TPLayerSpec`。
3. **Tier 3 AutoTP parser**：`AutoTP.tp_parser(model)` 按层名模式匹配（`o_proj`/`down_proj` → row-parallel + AllReduce，`q_proj`/`k_proj`/`v_proj` → column-parallel）做启发式切分。

**为什么三级优先级**：HF 4.51+ 的模型自带 `tp_plan`（官方验证的切分方案），比 DeepSpeed 的启发式 parser 更可靠；但用户的自定义模型可能没有 `tp_plan`，此时退回启发式。用户显式配置的 `partition_config` 优先级最高——覆盖一切自动推断，保证对特殊模型架构的完全控制。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| **抽象工厂** | `Backend` 基类 → `TorchBackend`/`CCLBackend` (`comm/backend.py`, `comm/torch.py`, `comm/ccl.py`) | 统一 collective API 接口，隔离硬件差异。上层只调 `cdb.all_reduce()`，后端切换不改调用代码 |
| **全局单例 + 策略分发** | `cdb` 全局变量 + `set_backend()` (`comm/comm.py` L46, L203) | 避免每次通信调用都传 backend 对象。后端选择是进程级决策，全局单例是最简方案 |
| **装饰器** | `@timed_op` (`comm/comm.py` L106), `@disable_compiler_collective` (`comm/torch.py` L25) | 计时/日志/编译控制横切关注点与业务逻辑分离。所有 collective 统一织入，不侵入后端实现 |
| **autograd Function 对偶** | `_SeqAllToAll` (`sequence/layer.py` L297), `_DimZeroAllToAll` (L277) | all-to-all 的数学对称性让 backward 零额外实现——交换 scatter/gather 索引递归 apply。PyTorch autograd 的标准范式 |
| **best-effort 降级** | `mori.allgather_into_tensor` (`comm/mori.py` L202), `CCLBackend.run_collective` (`comm/ccl.py` L63) | 可选加速路径不保证可用，失败静默 fallback 到标准路径。保证功能正确性的前提下最大化利用硬件特性 |
| **覆盖注入（Being John Malkovich）** | `UlyssesSPAttentionHF.register_with_transformers` (`ulysses_sp.py` L559) | 覆盖已有注册项而非注册新 key，让 HF 以为在跑原始 attention，保持所有 `if _attn_implementation ==` 分支行为一致 |

## 模块间交互

通信模块是 DeepSpeed 的底层基座，被几乎所有上层模块依赖：

- **ZeRO**：`DeepSpeedZeroOptimizer_Stage3` 的 forward/backward 频繁调 `deepspeed.comm.all_gather_into_tensor`（参数按需 allgather）和 `reduce_scatter_tensor`（梯度分片 reduce）。mori SDMA 快速路径直接加速 ZeRO-3 的 allgather 瓶颈。`PartitionedParameterCoordinator` 的 prefetch pipeline 依赖 `_SdmaWork.wait()` 不阻塞 CPU 的特性。
- **Engine**：`DeepSpeedEngine` 在初始化时调 `init_distributed()` 装配 `cdb`，TP 优先级链（custom > HF tp_plan > AutoTP）在 `engine.py` L721-831 实现。Engine 的 gradient reduction hook 调 `deepspeed.comm.all_reduce`。
- **Pipeline**：`PipelineEngine` 的 stage 间通信调 `deepspeed.comm.send`/`recv`/`isend`/`irecv` 做 micro-batch 传递。
- **Inference**：`inference_all_reduce`（`comm/torch.py` L186）是推理专用优化路径——优先用 `torch.ops.deepspeed.inference_all_reduce_` 自定义算子，不可用时 fallback 到标准 `torch.distributed.all_reduce`。
- **序列并行**：`DistributedAttention` 和 `UlyssesSPAttentionHF` 通过 `deepspeed.comm.all_to_all_single` 做 head/seq 维度转置，`UlyssesSPDataLoaderAdapter` 用 `all_gather` 在 SP rank 间收集完整 batch 后按 seq 维分片。

通信模块本身不反向依赖上层——`cdb` 不知道调用者是 ZeRO 还是 Pipe，这种单向依赖是分层架构的核心约束。
