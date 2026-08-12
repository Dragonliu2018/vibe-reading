---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "推理引擎"
date: "2026-08-12T15:53:09+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "推理", "Ragged Batch", "KV Cache", "Paged Attention"]
description: "DeepSpeed InferenceEngineV2 是全新推理引擎，以 Ragged Batch 无 padding 拼接、Paged KV-cache 动态分配、graphable forward 三大设计实现连续批处理与 CUDA Graph 兼容。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

InferenceEngineV2 是 DeepSpeed 推理系统的**全新重新设计**——不是 v1 的增量改进，而是从数据结构到 forward 执行图的彻底重构。v1 引擎基于固定 batch size 和 padding 对齐，无法支持 continuous batching（动态拼批）和 paged KV-cache（分页缓存），这两个能力正是高吞吐推理服务的关键。

v2 的设计目标可归纳为三条原则：

- **Graphable forward**：`forward()` 方法零 Python 控制流——所有分支逻辑在 forward 之前由 `prepare_batch` 预处理完成，forward 内部只有线性 GPU kernel 调用。这让整个 forward 可以被 CUDA Graph 捕获，消除 CPU launch 开销。
- **Ragged batch 无 padding**：多条不同长度的序列拼成一条 1D token 流，通过元数据映射回各自序列。相比 padding 对齐，显存利用率和吞吐显著提升。
- **Paged KV-cache**：KV-cache 以固定大小 block 为单位分配，序列按需动态获取 block，类似 vLLM 的 PagedAttention 思路。这让碎片浪费降到 block 粒度（默认 128 token）。

引擎模块的边界是"编排与执行分离"——`InferenceEngineV2` 负责调度检查、序列状态管理、batch 组装；`DSInferenceModelBase` 负责模型 forward 的具体执行。引擎不关心模型是什么架构，模型不关心 batch 是如何调度的。

## 调用链路

一次推理请求从 `engine.put()` 入口到 logits 输出的完整调用链：

```
engine.put(batch_uids, batch_tokens)          engine_v2.py L107
├── can_schedule(uids, lengths)                L184  ← 干跑调度检查
│   ├── get_kv_requirements(seq_desc, ...)     inference_transformer_base.py L336
│   └── return SchedulingResult
├── _batch.clear()                             ragged_wrapper.py L123
├── for uid, tokens in zip(uids, batch_tokens):
│   ├── get_or_create_sequence(uid)            ragged_manager.py L132
│   ├── maybe_allocate_kv(seq_desc, n_tokens)  inference_transformer_base.py L359
│   │   └── state_manager.allocate_blocks(n)   ragged_manager.py L205
│   ├── seq_desc.pre_forward(n_tokens)         sequence_descriptor.py L216
│   └── _batch.insert_sequence(seq_desc, tokens)  ragged_wrapper.py L134
├── _batch.finalize()                          ragged_wrapper.py L184
│   └── non_blocking H2D copy (shadow → device)
├── model.prepare_batch(_batch)                inference_transformer_base.py L389
│   └── attn.build_atoms(_batch)               dense_blocked_attention.py L139
├── model.forward(_batch)                      llama_v2/model.py L199
│   ├── _forward_embed → embed lookup
│   ├── norm (pre-norm)
│   ├── for layer in range(num_layers):
│   │   ├── qkv projection
│   │   ├── attn (kv_cache + RoPE)
│   │   ├── attn_out projection + all_reduce
│   │   ├── norm + mlp_1 + mlp_2 + all_reduce
│   │   └── next-layer norm fusion
│   └── _forward_unembed → logits [n_seqs, vocab]
└── for uid: seq_desc.post_forward() + maybe_free_kv()
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|---------|-------------|
| `put` | `engine_v2.py` L107 | 推理入口，执行一次 forward | 先 `can_schedule` 再组装 batch，非 final token 不计算 logits |
| `can_schedule` | `engine_v2.py` L184 | 干跑调度可行性检查 | 返回 `SchedulingResult` 枚举区分 5 种失败原因 |
| `query` | `engine_v2.py` L158 | 查询序列需要的 token/block 数 | 用 `PlaceholderSequenceDescriptor` 支持未注册序列 |
| `flush` | `engine_v2.py` L242 | 清除序列全部状态 | 委托 `state_manager.flush_sequence` |
| `insert_sequence` | `ragged_wrapper.py` L134 | 增量插入一条序列到 batch | 写 Python list 而非 tensor slice，避免逐次 copy |
| `finalize` | `ragged_wrapper.py` L184 | 批量 H2D 拷贝 | `non_blocking=True`，shadow buffer 用 pinned memory |
| `build_atoms` | `dense_blocked_attention.py` L139 | 构建 attention atoms `[n_atoms, 8]` | forward 前预处理，让 forward 无 Python 控制流 |
| `prepare_batch` | `inference_transformer_base.py` L389 | forward 前预处理入口 | 默认只调 `attn.build_atoms`，可覆写 |
| `forward` | `llama_v2/model.py` L199 | 模型 forward | 线性调用链，零分支控制流 |
| `maybe_allocate_kv` | `inference_transformer_base.py` L359 | 按需分配 KV block | 基于 `ceil_div(seen+new, block_size)` 计算需求 |
| `allocate_blocks` | `ragged_manager.py` L205 | 从 KV-cache 分配 block | 委托 `BlockedKVCache.reserve` |

</details>

## 核心实现

### Ragged Batch 无 padding 批处理

`RaggedBatchWrapper` 是 v2 的核心数据结构——它将多条不同长度的序列拼接成一条 1D token 流，零 padding 开销。假设 batch 有 3 条序列，长度分别为 [4, 1, 3]，则内部表示为：

```
input_ids:      [t0 t1 t2 t3 | t4 | t5 t6 t7]          ← 1D token 流，8 个 token
token_to_seq:   [0  0  0  0  | 1  | 2  2  2]          ← 每个 token 属于哪条序列
inflight_seq_descriptors: [[0, 4, H0, X],              ← [start, n_tokens, history, align]
                           [4, 1, H1, X],
                           [5, 3, H2, X]]
kv_ptrs:        [ptr_seq0, ptr_seq1, ptr_seq2]          ← 每条序列的 KV block 指针
```

关键设计是 **host shadow 双缓冲**——每个 GPU tensor 对应一个 host shadow tensor，insert 阶段写 Python list，finalize 阶段批量 copy：

```python title="ragged/ragged_wrapper.py L134-170（insert_sequence 节选）"
def insert_sequence(self, seq_descriptor, tokens, do_checks=True):
    # ... checks omitted ...
    seq_tokens = tokens.numel()

    # 写 Python list，不直接写 tensor slice
    self._batch_tokens.append(tokens)
    self._inflight_seq_descriptors_shadow_buf.append(self.current_tokens)  # start
    self._inflight_seq_descriptors_shadow_buf.append(seq_tokens)            # n_tokens
    self._inflight_seq_descriptors_shadow_buf.append(seq_descriptor.seen_tokens)  # history
    self._inflight_seq_descriptors_shadow_buf.append(0)                     # alignment

    self._token_to_seq_storage_shadow_buf.extend([self.current_sequences] * seq_tokens)
    self._kv_blocks_ptr_buf.append(seq_descriptor.kv_blocks_ptr)

    self._current_tokens += seq_tokens
    self._current_sequences += 1
```

**为什么用 Python list 而非直接写 tensor slice**：源码注释明确说明——"we found it inefficient to iterate over and substitute values into tensor slices or to use copy/fill calls for this purpose"。Python list 的 append 是 O(1) amortized，而 tensor slice 赋值每次都触发 PyTorch C++ dispatch 开销。在 `finalize` 中一次性 `torch.tensor()` + `copy_()` 批量转换，远快于逐次 tensor 更新。

`finalize` 的 H2D 拷贝使用 `non_blocking=True`：

```python title="ragged/ragged_wrapper.py L184-218（finalize 节选）"
def finalize(self, padding=False):
    cur_toks = self.current_tokens

    # 批量从 Python list → host shadow tensor
    self._input_ids_shadow[:cur_toks].copy_(torch.cat(self._batch_tokens, dim=0))
    self._token_to_seq_storage_shadow[:len(...)].copy_(torch.tensor(...))
    self._batch_metadata_storage_shadow.copy_(torch.tensor([cur_toks, self.current_sequences]))

    # non_blocking H2D copy
    def _noblock_copy(dst, src):
        dst.copy_(src, non_blocking=True)

    _noblock_copy(self._input_ids[:padded_toks], self._input_ids_shadow[:padded_toks])
    _noblock_copy(self._batch_metadata_storage, self._batch_metadata_storage_shadow)
    # ... 其余 tensor 同理 ...
```

**为什么 non_blocking 可行**：shadow buffer 在 `__init__` 中通过 `RaggedUtilsBuilder().load().allocate_fast_host_buffer` 分配，底层是 pinned memory（页锁定内存），支持异步 DMA 拷贝。GPU 拷贝与 CPU 计算可以重叠。

### Policy + Container 模型注册

v2 的模型扩展体系基于三层注册机制，让新增一种模型支持只需写三个文件：

**第一层：PolicyMeta 自动注册**

```python title="model_implementations/inference_policy_base.py L95-101"
POLICIES = {}

class PolicyMeta(ABCMeta):
    def __new__(cls, name, bases, dct):
        new_obj = super().__new__(cls, name, bases, dct)
        if name != "InferenceV2Policy":
            POLICIES[name] = new_obj
        return new_obj

class InferenceV2Policy(ABC, metaclass=PolicyMeta):
    ...
```

任何继承 `InferenceV2Policy` 的类在定义时，metaclass 自动将其注册到 `POLICIES` dict。`engine_factory.py` 的 `build_engine_from_ds_checkpoint` 通过 `POLICIES[metadata.policy]` 反序列化时按名查找——序列化 checkpoint 只存 Policy 类名，反序列化时从注册表恢复。

**第二层：LayerContainer + PARAM_MAPPING 声明式参数映射**

```python title="model_implementations/llama_v2/container.py L42-63"
class Llama2TransformerContainer(LayerContainer):
    qkv_w: UnfusedQKVParameter
    attn_out_w: AttentionOutputParameter
    mlp_1_w: GatedMLPParameter
    mlp_2_w: MLP2Parameter
    attn_norm_gamma: NormParameter
    mlp_norm_gamma: NormParameter

    PARAM_MAPPING = {
        "self_attn.q_proj.weight": "qkv_w.q_params",
        "self_attn.k_proj.weight": "qkv_w.k_params",
        "self_attn.v_proj.weight": "qkv_w.v_params",
        "self_attn.o_proj.weight": "attn_out_w.params",
        "mlp.gate_proj.weight": "mlp_1_w.gate_params",
        "mlp.up_proj.weight": "mlp_1_w.up_params",
        "mlp.down_proj.weight": "mlp_2_w.params",
        "input_layernorm.weight": "attn_norm_gamma.params",
        "post_attention_layernorm.weight": "mlp_norm_gamma.params",
    }
```

`PARAM_MAPPING` 是声明式映射——左边是 HuggingFace checkpoint 的参数名，右边是容器字段的内部依赖名。`LayerMetaclass.__new__` 在类定义时验证映射完整性：每个 `ParameterBase` 子类的每个 `Tensor` / `ParametrizedList` 依赖都必须被映射到，否则抛 `ValueError`。

**第三层：ContainerMap 前缀路由**

```python title="model_implementations/inference_policy_base.py L58-83（map_param 节选）"
def map_param(self, name, parameter):
    for unmapped_prefix in self._unmapped_prefixes:
        if name.startswith(unmapped_prefix):
            return                                    # 跳过不需要的参数

    for transformer_prefix in self._transformer_prefixes:
        if name.startswith(transformer_prefix):
            popped_name = name[len(transformer_prefix) + 1:]
            layer_idx = int(popped_name.split(".")[0])
            self._transformer_params[layer_idx].set_dependency(
                ".".join(popped_name.split(".")[1:]), parameter)
            return

    self._non_transformer_params.set_dependency(name, parameter)
```

`ContainerMap.map_param` 按 checkpoint 参数名的字符串前缀路由：以 `model.layers` 开头 → 去前缀取 layer_idx → 路由到对应 `Llama2TransformerContainer`；其余 → 路由到 `Llama2NonTransformerContainer`（embedding + unembedding + final_norm）。

Llama2 的 `build_container_map` 清晰展示了三组路由的划分：

```python title="model_implementations/llama_v2/policy.py L19-31"
def build_container_map(self):
    map = ContainerMap()
    transformer_containers = [Llama2TransformerContainer(self.model)
                              for _ in range(self.model.num_layers)]
    map.set_transformer_params(['model.layers'], transformer_containers)
    map.set_non_transformer_params(Llama2NonTransformerContainer(self.model))
    map.set_unmapped_params(
        [f'model.layers.{i}.self_attn.rotary_emb.inv_freq'
         for i in range(self.model.num_layers)])
    return map
```

**为什么用三层注册**：HuggingFace checkpoint 的参数命名因模型而异（`self_attn.q_proj` vs `attention.query`），但内部计算需要的参数结构是统一的（QKV 权重、MLP 权重、norm gamma）。`PARAM_MAPPING` 把"翻译表"声明化，新增模型只需写映射字典，不需要写遍历逻辑。`ContainerMap` 的前缀路由处理了"transformer 层重复 N 次"的模式——一个前缀 `model.layers` + N 个 container 实例，而非 N 条映射规则。

### Paged KV-cache 管理

`DSStateManager` 管理分页 KV-cache，核心组件是 `BlockedKVCache`（存储）+ `BlockedAllocator`（分配器）：

```
BlockedKVCache 存储结构:
  shape = [num_caches, num_blocks, block_size, 2, n_heads, head_size]
                          ↑           ↑          ↑
                       KV-cache    block大小   K/V 分量

BlockedAllocator:
  _blocks: int32[num_blocks]  ← 链表，_blocks[i] = next free block
  _head: int                  ← 链表头
  _free_blocks: int           ← 空闲计数
```

`BlockedAllocator` 用链表管理空闲 block——`allocate(n)` 从链表头取 n 个 block，`free(blocks)` 把 block 放回链表头：

```python title="ragged/blocked_allocator.py L50-72"
def allocate(self, num_blocks):
    allocated_blocks = torch.zeros(num_blocks, dtype=torch.int32)
    for i in range(num_blocks):
        allocated_blocks[i] = self._head
        self._head = self._blocks[self._head].item()
        self._blocks[allocated_blocks[i]] = -1   # 标记已用
        self._free_blocks -= 1
    return allocated_blocks
```

`BlockedKVCache.__init__` 支持两种内存分配模式：

```python title="ragged/kv_cache.py L83-117（节选）"
if AllocationMode(self._memory_config.mode) is AllocationMode.RESERVE:
    # 计算每个 block 的显存占用
    total_per_block_footprint = reduce(operator.mul, config.cache_shape, config.block_size) * 2
    # 先做一次 dummy all_reduce 排除 NCCL 占用
    get_accelerator().empty_cache()
    available_kv_memory = get_accelerator().available_memory() - self._memory_config.size
    num_blocks = available_kv_memory // total_per_block_footprint
    # 多 rank 取 min 保证所有 rank 容量一致
    if dist.get_world_size(group=mp_group) > 1:
        dist.all_reduce(reduce_tensor, op=ReduceOp.MIN, group=mp_group)
        num_blocks = reduce_tensor.item()
else:  # ALLOCATE
    num_blocks = self._memory_config.size
```

**为什么多 rank 取 min**：TP 组内各 rank 的模型参数和 KV-cache 分配必须对称——如果 rank 0 有 100 个 block、rank 1 只有 80 个，调度器按 rank 0 的容量批准的 batch 会在 rank 1 上 OOM。`all_reduce(MIN)` 保证所有 rank 使用最小容量者的 block 数。

`DSSequenceDescriptor` 跟踪单条序列的 KV-cache 状态——`seen_tokens`（已完成 forward 的 token 数）、`in_flight_tokens`（正在 forward 的 token 数）、`_kv_cache_ids`（分配到的 block ID 列表）：

```python title="ragged/sequence_descriptor.py L216-233"
def pre_forward(self, num_tokens):
    self._in_flight_tokens = num_tokens

def post_forward(self):
    self._seen_tokens += self._in_flight_tokens
    self._in_flight_tokens = 0
```

`pre_forward` / `post_forward` 的设计让引擎在 forward 前后精确更新序列状态——`post_forward` 在 `engine.put` 的循环中对每条序列调用，即使 GPU 上的 forward 尚未完成（异步特性），host 端的元数据已更新，可以立即响应下一次 `can_schedule` 查询。

`maybe_allocate_kv` 在 `put` 中为每条序列按需分配新 block：

```python title="model_implementations/inference_transformer_base.py L359-371"
def maybe_allocate_kv(self, sequence, n_new_tokens):
    free_block = self.state_manager.free_blocks[0]
    _, n_needed_blocks = self.get_kv_requirements(sequence, n_new_tokens, free_block)

    if n_needed_blocks > 0:
        new_blocks = self.state_manager.allocate_blocks(n_needed_blocks)
        sequence.extend_kv_cache(new_blocks)
```

**为什么支持连续生成动态分配**：生成式推理的序列长度是逐步增长的——每生成一个 token，可能需要新 block。`get_kv_requirements` 计算 `ceil_div(seen_tokens + new_tokens, block_size) - cur_allocated_blocks` 得到需要新增的 block 数。这个设计让不同序列可以在同一 batch 中处于不同生成长度，实现真正的 continuous batching。

### Attention Atoms：让 forward 零控制流

`prepare_batch` → `build_atoms` 是 v2 graphable forward 的关键——它把 ragged batch 的元数据预处理为 attention kernel 直接可用的 `[n_atoms, 8]` 格式：

```python title="modules/implementations/attention/dense_blocked_attention.py L139-150"
def build_atoms(self, ragged_batch):
    host_atoms, n_atoms = self._atom_builder(
        self._atoms_shadow, ragged_batch, self.q_block_size, self.kv_block_size)
    self._cur_atoms = n_atoms
    self._atoms[:n_atoms].copy_(host_atoms[:n_atoms], non_blocking=True)
```

`AtomBuilder` 是 C++/CUDA kernel（通过 `RaggedUtilsBuilder` 加载），它将 ragged batch 的 `token_to_seq`、`inflight_seq_descriptors`、`kv_ptrs` 转换为 atom 列表。每个 atom 描述一个 query block 对一个 KV block 的 attention 计算单元。`forward` 中直接用 `self._atoms[:self._cur_atoms]` 调 kernel：

```python title="modules/implementations/attention/dense_blocked_attention.py L152-180"
def forward(self, q_k_v, kv_cache, batch, inv_freqs=None):
    self._kv_copy(kv_cache, q_k_v, batch)          # KV 写入 cache + RoPE
    q = q_k_v[:, :self._config.head_size * self._config.n_heads_q]
    output = empty_from(self._output, q.shape)
    k_cache, v_cache = split_kv(kv_cache)
    self._attn_kernel(output, q, k_cache, v_cache,
                      self._atoms[:self._cur_atoms], self._softmax_scale)
    return output
```

**为什么 atoms 在 forward 前构建**：如果 attention kernel 在 forward 内部动态决定哪些 query block 对哪些 KV block 做 attention，就需要 Python 控制流或动态 kernel launch——两者都破坏 CUDA Graph 兼容性。`build_atoms` 把这个决策提前到 host 端，forward 内部只有一个 `BlockedFlashAttn` kernel 调用，参数全部是预分配 tensor 的 view。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `DSTransformerModelBase.__init__` in `inference_transformer_base.py` L193 | `__init__` 按 `make_norm → make_qkv → make_attn → make_attn_out → make_mlp_1 → make_mlp_2 → make_embedding → make_unembedding` 顺序调用，子类只覆写抽象属性（`num_layers` / `model_dim` / `n_heads` 等），构建骨架不变 |
| 注册表 | `PolicyMeta.__new__` in `inference_policy_base.py` L95 | metaclass 自动注册 Policy 子类到 `POLICIES` dict，`build_engine_from_ds_checkpoint` 按类名反序列化 |
| 声明式映射 | `PARAM_MAPPING` in `layer_container_base.py` L20 + `llama_v2/container.py` L53 | checkpoint 参数名 → 内部依赖名的翻译表声明为类属性，`LayerMetaclass` 定义时验证完整性 |
| 前缀路由 | `ContainerMap.map_param` in `inference_policy_base.py` L58 | 按 checkpoint 参数名字符串前缀分发到 transformer 层 container 或 non-transformer container，处理"N 层重复"模式 |
| 策略模式 | `InferenceV2Policy.build_model` in `inference_policy_base.py` L140 | `build_model` 定义骨架（`instantiate_model` → `populate_model_parameters`），具体模型在子类实现两个抽象方法 |
| 双缓冲 | shadow + device tensor in `ragged_wrapper.py` L41-72 | host shadow buffer（pinned memory）支持 `non_blocking` H2D copy，CPU 写与 GPU 算重叠 |
| 链表分配器 | `BlockedAllocator` in `blocked_allocator.py` L11 | O(n) 分配/释放 n 个 block，无碎片整理开销，简单可预测 |

## 模块间交互

推理引擎 v2 向下依赖四个子系统：

- **→ ops/kernels**：`RaggedUtilsBuilder` 提供 C++/CUDA 算子——`allocate_fast_host_buffer`（pinned memory 分配）、`AtomBuilder`（attention atoms 构建）、`BlockedFlashAttn`（blocked flash attention kernel）、`BlockedRotaryEmbeddings`（RoPE + KV copy）。这些算子通过 `op_builder` JIT 编译，是 v2 性能的底层保障。
- **→ module_inject**：v1 的 `module_inject` 通过替换 `nn.Module` 的 Linear 层实现 TP 注入；v2 不走 module_inject 路径，而是通过 `DSTransformerModelBase` 的 `make_*` 方法 + `heuristics.instantiate_*` 选择 DSModule 实现，参数在 `transform_*_param` 中按 TP rank sharding。
- **→ checkpoint**：`HuggingFaceCheckpointEngine`（`checkpoint/huggingface_engine.py`）遍历 HF checkpoint 参数，逐个调用 `container_map.map_param(name, parameter)` 路由到 container。`InferenceEngineV2.serialize` 支持将 flatten 后的参数序列化为 DeepSpeed 原生格式（`params_rank_{r}_of_{n}.pt` + `metadata_rank_{r}_of_{n}.json`），下次加载走 `build_engine_from_ds_checkpoint` 快速路径。
- **→ DSModule / heuristics**：`modules/heuristics.py` 根据 `DSSelfAttentionConfig` / `DSLinearConfig` 等配置，从 `DSModuleRegistry` 选择具体实现（如 `DSDenseBlockedAttention`）。`supports_config` 静态方法让 registry 自动匹配——新增一种 attention 实现只需注册并声明支持的配置范围。

### 新增模型的三文件模式

支持一种新模型（如 Qwen3）只需三个文件 + 一行工厂分支：

1. **`model.py`**：继承 `DSTransformerModelBase`，实现抽象属性（`num_layers`、`model_dim`、`n_heads`、`n_heads_kv` 等）+ `forward` 方法。Llama2 的 `forward` 是典型模板：

```python title="model_implementations/llama_v2/model.py L199-209"
def forward(self, wrapped_batch):
    residual = self._forward_embed(wrapped_batch)
    residual, hidden_states = self.norm(residual, None,
                                        self._transformer[0].attn_norm_gamma, beta=None)
    for layer_idx in range(self.num_layers):
        residual, hidden_states = self._forward_transformer_layer(
            layer_idx, residual, hidden_states, wrapped_batch)
    return self._forward_unembed(residual, wrapped_batch)
```

2. **`container.py`**：定义 `TransformerContainer` 和 `NonTransformerContainer`，声明 `PARAM_MAPPING` 把 HF 参数名映射到内部依赖。
3. **`policy.py`**：继承 `InferenceV2Policy`，实现 `instantiate_model`（返回模型实例）和 `build_container_map`（构建路由映射）。
4. **`engine_factory.py`**：在 `build_hf_engine` 的 `if/elif` 链中加一行 `elif model_config.model_type == "qwen3": policy = Qwen3Policy(...)`。

### Llama2 Transformer Layer Forward 细节

`_forward_transformer_layer` 实现了 lookahead norm fusion 优化——将下一层的 pre-norm 融合到当前层的末尾：

```python title="model_implementations/llama_v2/model.py L133-175"
def _forward_transformer_layer(self, layer_idx, residual, hidden_states, ragged_batch_info):
    cur_params = self._transformer[layer_idx]
    kv_cache = self.state_manager.get_cache(layer_idx)

    hidden_states = self.qkv(hidden_states, cur_params.qkv_w, b=None)
    hidden_states = self.attn(hidden_states, kv_cache, ragged_batch_info)
    hidden_states = self.attn_out(hidden_states, cur_params.attn_out_w, b=None)

    if self.tp_size > 1:
        dist.all_reduce(hidden_states, group=self._base_mp_group)

    residual, hidden_states = self.norm(residual, hidden_states,
                                        cur_params.mlp_norm_gamma, beta=None)
    hidden_states = self.mlp_1(hidden_states, cur_params.mlp_1_w, b=None)
    hidden_states = self.mlp_2(hidden_states, cur_params.mlp_2_w, b=None)

    if self.tp_size > 1:
        dist.all_reduce(hidden_states, group=self._base_mp_group)

    if layer_idx != self.num_layers - 1:
        # Lookahead: 把下一层的 attention pre-norm 融合到这里
        next_params = self._transformer[layer_idx + 1]
        residual, hidden_states = self.norm(residual, hidden_states,
                                            next_params.attn_norm_gamma, beta=None)
    else:
        residual.add_(hidden_states)   # 最后一层只做 residual add
    return residual, hidden_states
```

**为什么做 norm fusion**：`norm` 操作（RMSNorm）涉及一次 reduction（计算 RMS）和一次 element-wise 除法。把下一层的 pre-norm 融合到当前层末尾，减少了 kernel launch 次数（少一次 norm kernel launch），在 CUDA Graph 场景下也减少了 graph 中的 node 数量。这是 v2 "graphable forward" 设计哲学的微观体现——每个可合并的操作都合并。

### 参数 Flatten 与 TP Sharding

v2 在 `populate_model_parameters` 的末尾调用 `flatten_inference_model`，把所有 container 中的参数拷贝到一个连续 `uint8` buffer 中：

```python title="model_implementations/flat_model_helpers.py L100-222（节选）"
def flatten_inference_model(transformer_containers, non_transformer_container, policy_name):
    # 第一遍：计算总大小 + 收集 metadata
    for i, layer in enumerate(transformer_containers):
        total_size = process_layer(layer, f"transformer_layer_{i}", total_size)

    # 分配连续 buffer
    buffer = torch.empty(total_size, dtype=torch.uint8, device=get_accelerator().current_device())

    # 第二遍：copy 参数到 buffer，用 alloc_fn 创建 view
    for i, layer in enumerate(transformer_containers):
        copy_layer(layer, f"transformer_layer_{i}")

    return buffer, metadata
```

**为什么 flatten**：连续内存布局减少内存碎片，提升 memory bandwidth 利用率。每个 `InferenceParameter` 通过 `allocate_view_on` 成为 buffer 的 view——不持有独立存储，修改 view 即修改 buffer。序列化时只存一个 buffer + metadata（offset/shape/stride），反序列化时 `restore_inference_model` 只重建 view，零数据拷贝。

TP sharding 在 `transform_*_param` 方法中完成——每个参数在从 checkpoint 加载到 container 时，按 `tp_rank` 和 `tp_size` 切片：

```python title="model_implementations/inference_transformer_base.py L286-314（make_qkv_layer + transform_qkv_param）"
def make_qkv_layer(self):
    out_features = qkv_out_features(self.model_dim, self.tp_rank, self.tp_size,
                                    self.head_size, self.n_heads_q, self.n_heads_kv)
    linear_config = DSLinearConfig(
        max_tokens=self._engine_config.state_manager.max_ragged_batch_size,
        in_channels=self.model_dim,
        out_channels=out_features, ...)
    self.qkv = heuristics.instantiate_linear(linear_config, self._engine_config)

def transform_qkv_param(self, param):
    param = shard_qkv_param(param, self.tp_rank, self.tp_size,
                            self.head_size, self.n_heads_q, self.n_heads_kv)
    return self.qkv.transform_param(param)
```

`sharded_intermediate_dim` / `shard_unembed_param` / `shard_qkv_param` 等函数在 `model_implementations/sharding/` 中实现，按 head 维度切分 QKV、按 intermediate 维度切分 MLP、按 vocab 维度切分 unembedding——与 Megatron-LM 的 TP sharding 策略一致。
