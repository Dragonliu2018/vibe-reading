---
source:
  type: "源码解读"
  project: "transformers"
  url: "https://github.com/huggingface/transformers"
title: "KV 缓存"
date: "2026-08-18T16:40:20+08:00"
category: [AI, Infra, transformers, CodeWiki, "5.15.0"]
tags: ["transformers", "KV Cache", "DynamicCache", "StaticCache", "torch.compile"]
description: "cache_utils 用两层抽象 CacheLayerMixin + Cache 统一 KV 缓存。DynamicLayer 动态追加用于标准生成，StaticLayer 预分配原位写用于 torch.compile。本文解读缓存策略的选择与编译友好设计。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/transformers/CodeWiki/5.15.0/00-overview)

---

## 模块定位

KV 缓存放 attention 层的历史 Key/Value 张量，让自回归生成每步只需算新 token 的 K/V 而非重算全部。`cache_utils.py` 用**两层抽象**——先抽象单层缓存行为（`CacheLayerMixin`），再用容器（`Cache`）持有所有层的缓存对象列表。它独立成模块，是因为缓存策略（动态/静态/量化/线性注意力）独立于模型结构，且要支持 `torch.compile`/`torch.export`/offloading 等运行时需求。它被约 430 个 modeling 文件 import，是 transformers 中被引用最广的模块之一。

边界：缓存只管"K/V 的存取与布局"，不管 attention 怎么算（建模原语/模型），也由 generation 创建并传递它。

## 模块架构

两层抽象：

- **层级抽象**：`CacheLayerMixin(ABC)` in L27，抽象方法 `update`/`lazy_initialization`/`get_seq_length`/`get_max_length`/`get_mask_sizes`，属性 `keys`/`values`/`is_initialized`/`is_compileable`/`supports_early_init`。另有 `LinearAttentionCacheLayerMixin(ABC)`（L886）给 Mamba/SSM 的 `conv_states`+`recurrent_states`。
- **容器级**：`Cache` in L1262，本质 `list[CacheLayerMixin]` 容器，`update(key_states, value_states, layer_idx)` 转发给 `self.layers[layer_idx].update`，还管 offloading 流水线（prefetch/offload）。

具体 Layer 子类（经 `_layer_type` + `__init_subclass__` 自动注册到 `*_LAYER_TYPE_MAPPING`）：

| Layer 类 | 行号 | 继承 | 用途 |
|----------|------|------|------|
| `DynamicLayer` | L113 | `CacheLayerMixin` | 动态追加（`torch.cat`），标准生成+训练 |
| `StaticLayer` | L398 | `CacheLayerMixin` | 预分配原位写（`index_copy_`），torch.compile 友好 |
| `DynamicSlidingWindowLayer` | L203 | `DynamicLayer` | 滑动窗口，只保留 window-1 个 |
| `DynamicIndexedLayer` | L319 | `DynamicLayer` | DSA 模型（DeepSeek V32），额外 `indexer_keys` |
| `StaticSlidingWindowLayer` | L504 | `StaticLayer` | 静态滑动窗口 |
| `QuantizedLayer` | L698 | `DynamicLayer` | KV 量化（KIVI），双存储 |
| `LinearAttentionLayer` | L998 | `LinearAttentionCacheLayerMixin` | Mamba/SSM 状态 |
| `LinearAttentionAndFullAttentionLayer` | L1089 | 多继承 | 混合层 |

容器子类：`DynamicCache`（L1730，默认生成）、`StaticCache`（L1822，必传 config+max_cache_len）、`QuantizedCache`（L1877）、`EncoderDecoderCache`（L1940，持有 self_attention+cross_attention 两个子 Cache）、`MtpCache`（L2095，MTP 偏移）、`DFlashCache`（L2107）。

## 调用链路

一次注意力层的缓存交互（以 Llama 为例）：

```
LlamaAttention.forward(hidden_states, past_key_values=Cache, layer_idx)   modeling_llama.py:241
├── q_proj/k_proj/v_proj → query/key/value states
├── apply_rotary_pos_emb(q, k, cos, sin)
└── key_states, value_states = past_key_values.update(key_states, value_states, self.layer_idx)
    └── Cache.update（L1349）→ self.layers[layer_idx].update(...)
        │
        [DynamicLayer.update]  L127
        ├── lazy_initialization（首次创建空 tensor）
        ├── self.keys = torch.cat([self.keys, key_states], dim=-2)  # 追加，每次增长
        └── return self.keys, self.values（完整历史）
        │
        [StaticLayer.update]  L455
        ├── lazy_initialization → 预分配 [B,H,max_cache_len,D] zeros
        ├── cache_position = arange(kv_length) + self.cumulative_length
        ├── self.keys.index_copy_(2, cache_position, key_states)  # 原位写，大小不变
        └── return self.keys, self.values（完整 buffer，未填位置为 0，由 mask 遮蔽）
```

数据流：`K,V tensor [B,H,new_len,D] → cache.update → 取出累积 K,V [B,H,total_len,D] → attention 计算`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `Cache.update` in L1349 | 转发给 layer + offloading | 懒扩展 layers + prefetch/offload 流水线 |
| `DynamicLayer.update` in L127 | 动态追加 | `torch.cat` 沿 seq_len 维，无上限 |
| `StaticLayer.update` in L455 | 原位写预分配 | `index_copy_`，固定大小，编译友好 |
| `lazy_initialization` in L417 | 首次分配 buffer | 避免 guess device/dtype，TP 时 num_heads 运行时知 |
| `Cache.early_initialization` in L1448 | 提前初始化 | torch.export/chunked prefill 需要 |
| `get_layer_types_and_kwargs` in L1694 | config→Layer 类型 | Dynamic/Static 共用的配置桥接 |

</details>

## 核心实现

### 为何抽象 CacheLayerMixin

一个模型有 N 层 attention，每层需独立 K/V 缓存。抽象 Layer 级接口后：Cache 容器只需 `self.layers[layer_idx].update(...)` 一个调用，不关心具体策略；不同 attention 类型（full/sliding/linear/hybrid/DSA）各自实现 Layer 子类；新增缓存类型只加 Layer 子类 + 注册到 mapping，不改 Cache 容器。`__init_subclass__`（L36）让子类设 `_layer_type` 即自动注册到 `DYNAMIC/STATIC_LAYER_TYPE_MAPPING`，无需手改 mapping 字典。

### DynamicCache vs StaticCache 权衡

| 维度 | DynamicLayer | StaticLayer |
|------|--------------|-------------|
| 内存 | 动态增长（`torch.cat` 追加） | 预分配固定（`index_copy_` 原位写） |
| 上限 | 无（`get_max_length` 返回 -1） | 固定 `max_cache_len` |
| torch.compile | 不支持（动态 shape 致 graph break） | 支持（`mark_static_address`+固定 shape） |
| 场景 | 标准生成、训练 | torch.compile/export/cudagraphs |
| 内存效率 | 只用实际长度 | 预分配可能浪费（未填为 0） |

StaticLayer 为编译友好刻意设计：`is_compileable=True`（L408）；`mark_static_address`（L449）标记 tensor 固定地址防 dynamo graph break；`cumulative_length` 用 `torch.tensor(0)`+`add_()` 原位更新（L476）而非 Python int——Python int 变化会触发重编译，cudagraphs 会因 Python int 被覆盖随机崩溃；`index_copy_` 原位写保持 buffer 地址不变；`early_initialization`（L1448）支持 `torch.export` 需要的前置初始化。

### offloading 层间流水线

`Cache.update`（L1371-1379）当 `offloading=True` 时额外执行：先 `wait_stream(self.prefetch_stream)`（等下一层 prefetch 完成）→ `update` 当前层 → `offload(layer_idx)`（搬到 CPU）+ `prefetch(layer_idx+1)`（单独 stream 异步把下一层从 CPU 搬回 GPU）。实现层间流水线——第 N 层在 GPU 做 attention 时，第 N+1 层缓存正被 prefetch，第 N-1 层已 offload。`OffloadedCache` 在 v5 不作为独立类，offloading 内建到 `Cache` 基类（`offloading` 参数 + `offload()`/`prefetch()` + `prefetch_stream = torch.Stream()` L1304）。

### indexer 与线性注意力

DSA 模型（DeepSeek V32）除常规 K/V 外还维护低维 indexer key（`[batch, seq_len, index_head_dim]`，3D 单头）用于稀疏注意力路由——`DynamicIndexedLayer`（L319）/`StaticIndexedLayer`（L631）有独立 `indexer_keys` buffer、独立累计长度、独立 `update_indexer`（L338/L664，由 `Cache.update_indexer` L1427 转发）。线性注意力（Mamba/SSM）用 `LinearAttentionLayer`（L998）管 `conv_states`+`recurrent_states`，经 `Cache.update_conv_state`/`update_recurrent_state`（L1383/L1405）交互。混合架构用 `LinearAttentionAndFullAttentionLayer`（L1089）多重继承组合。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `Cache.update`（L1349） | 固定 offloading+转发骨架，layer.update 是钩子 |
| 策略 | `*_LAYER_TYPE_MAPPING`（L1218/L1240） | 据 config layer_types 选 Layer 策略类 |
| ABC | `CacheLayerMixin(ABC)`（L27） | 强制子类实现 update/lazy_init |
| 自动注册 | `__init_subclass__` + `_layer_type`（L36） | 加 Layer 子类自动进 mapping，免手改 |
| Mixin 组合 | `LinearAttentionAndFullAttentionLayer`（L1089） | 多重继承组合线性注意力+动态 KV |

## 模块间交互

被约 430 个 modeling 文件 import，典型 `from ...cache_utils import Cache, DynamicCache`。attention 层经 `past_key_values.update(key, v, layer_idx)` 单一入口交互；线性注意力层经 `update_conv_state`/`update_recurrent_state`。`generation/utils.py` 在 `_prepare_cache_for_generation`（L1929）据 `cache_implementation` 创建缓存，`cache.is_compileable` 判可编译性，chunked prefill 调 `cache.early_initialization`，assisted decoding 调 `cache.activate_past_recording`/`crop`。`masking_utils` 通过 `Cache.get_seq_length` 取长度生成掩码。`StaticCache` 与 `torch.compile`/`torch.export` 协作（上文）。

## 扩展方式

新增 cache 类型（如新量化缓存）：新增 Layer 子类继承 `QuantizedLayer` 或 `DynamicLayer`/`StaticLayer` 实现 `update`/`_quantize`/`_dequantize`，可选设 `_layer_type` 利用 `__init_subclass__` 自动注册，在 `generation/utils.py` 的 `_prepare_cache` 加 cache_implementation 分支。新增滑动窗口变体：新增 Layer 子类（参考 `StaticSlidingWindowLayer` L504）调 `update`（L525）写入逻辑，注册到 `STATIC_LAYER_TYPE_MAPPING`，在 `get_layer_types_and_kwargs`（L1694）加识别。为新模型定制偏移（如 MTP）：继承 `DynamicCache` 覆写 `get_query_offset`（L1585）和 `get_mask_sizes`（L1555），参考 `MtpCache`（L2095）。
