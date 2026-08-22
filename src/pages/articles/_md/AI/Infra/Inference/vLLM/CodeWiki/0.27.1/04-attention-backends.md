---
source:
  type: "源码解读"
  project: "vLLM"
  url: "https://github.com/vllm-project/vllm"
title: "注意力后端"
date: "2026-08-22T18:02:27+08:00"
category: [AI, Infra, Inference, vLLM, CodeWiki, "0.27.1"]
tags: ["vLLM", "Attention Backend", "PagedAttention", "FlashAttention", "MLA", "selector"]
description: "解读 vLLM 注意力后端模块：统一 AttentionBackend 接口屏蔽多硬件/多 kernel，ForwardContext 桥接 worker 与 layer，PagedAttention 的 block_table 与 MLA 双路。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview)

---

## 模块定位

注意力后端模块（`vllm/v1/attention/`）是 vLLM 屏蔽多硬件/多 kernel 差异的关键。模型代码（如 `llama.py`）只写一行 `self.attn = Attention(...)`，背后是 FlashAttention、FlashInfer、TRTLLM、Triton、MLA 等 30+ 种后端在竞争——由 `selector` 根据硬件能力与模型特性自动选最优。PagedAttention 的 `block_table` 也在这一层传给具体 kernel，让分页 KV cache 真正被算起来。它和 layer 侧（`vllm/model_executor/layers/attention/`）分工：layer 侧是模型定义里的 `nn.Module`，backend 侧是可替换的执行实现。

## 模块架构

![注意力层 ↔ 后端 数据流](/vibe-reading/images/articles/vllm/04-attention-backends.svg)

模块分两侧：**layer 侧**（`Attention`/`MLAAttention`）在模型定义中实例化，`__init__` 时经 `selector.get_attn_backend()` 选定后端类，再 `backend.get_impl_cls()` 得到 `AttentionImpl`、`backend.get_builder_cls()` 得到元数据构建器；**backend 侧**（`AttentionBackend` ABC + 30+ 实现）。两侧通过 **`ForwardContext`** 桥接：worker 每步前调 `builder.build()` 构造 per-layer `AttentionMetadata` 并 `set_forward_context()` 设全局 `ForwardContext`（含 `attn_metadata` dict、`slot_mapping` dict、`kv_cache`）；layer forward 时经自定义算子 `unified_attention_with_output` 调 `get_attention_context(layer_name)` 取出 metadata + kv_cache + slot_mapping，再调 `impl.forward()`。

## 调用链路

一次 attention 计算：

```
模型 forward → Attention.forward(query, key, value)     # attention.py:488
├─ [若 backend.forward_includes_kv_cache_update=False]
│  └─ unified_kv_cache_update(key, value, layer_name)
│     └─ impl.do_kv_cache_update → ops.reshape_and_cache_flash
│        # slot_mapping[token] = block_id * block_size + offset
├─ unified_attention_with_output(query, output, layer_name)   # custom op
│  └─ get_attention_context(layer_name)        # 从 ForwardContext 取
│     ├─ attn_metadata = forward_context.attn_metadata[layer_name]
│     ├─ kv_cache = attn_layer.kv_cache
│     └─ slot_mapping = forward_context.slot_mapping[layer_name]
│  └─ attn_layer.impl.forward(layer, q, k, v, kv_cache, attn_metadata, output)
│     └─ FlashAttentionImpl.forward → flash_attn_varlen_func(block_table=...)
```

数据流：`query/key/value` 张量 + `attn_metadata`（含 `query_start_loc`、`seq_lens`、`block_table_tensor`、`slot_mapping`）→ `impl.forward` → `output`。`block_table` 形状 `[num_reqs, max_num_blocks_per_req]`，每元素是物理 block ID，kernel 内部 `block_table[req, blk_idx]` 索引 `kv_cache[block_id, :, offset, :]` 读 K/V。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Attention.forward` | layer 入口 | 注册为 `torch.ops.vllm.unified_attention_with_output` |
| `selector.get_attn_backend` | 选后端类 | platform.get_attn_backend_cls + 优先级列表 |
| `AttentionMetadataBuilder.build` | 构造 per-layer metadata | common → backend-specific |
| `AttentionImpl.forward` | 执行注意力 | 调具体 kernel |
| `MLAAttentionImpl.forward_mha` | MLA prefill 路径 | 展开 latent 为完整 K/V |
| `MLAAttentionImpl.forward_mqa` | MLA decode 路径 | latent cache 上直接 MQA |
| `Backend.validate_configuration` | 校验能力匹配 | 模板方法调所有 supports_* |

</details>

## 核心实现

### 统一 AttentionBackend 接口与能力声明

`AttentionBackend`（`backend.py:56`）是抽象基类，定义 `get_name`/`get_impl_cls`/`get_builder_cls`/`get_kv_cache_shape` 等工厂方法，以及 15+ 个 `supports_*` classmethod（`supports_sliding_window`、`supports_sink`、`supports_non_causal`、`is_mla` 等，默认全 False）。`validate_configuration`（`backend.py:319`）是模板方法：逐一调所有 `supports_*` 检查，返回 invalid_reasons 列表。这让模型代码完全不感知后端——同一个 `Attention` 可跑 FlashAttention/FlashInfer/Triton 等任意后端。

### PagedAttention 的 block_table 与 slot_mapping

PagedAttention 的核心是 KV cache 不连续、按 block 分页。`block_table` 来自 `v1/core` 的 block manager 为每请求分配的物理 block 序列，存入 `CommonAttentionMetadata.block_table_tensor`（`backend.py:437`）。`slot_mapping` 用于写入：`slot_mapping[token_idx] = block_id * block_size + in_block_offset`，`reshape_and_cache_flash` 据此把新 K/V 写入正确位置。FlashAttention 的 `flash_attn_varlen_func` 直接接收 `block_table` 参数（`flash_attn.py:1054`），kernel 内部按 block_table 索引 KV cache。

### MLA 的双路 forward

DeepSeek 的 MLA 不存完整 K/V，而存压缩的 latent（`kv_c_normed` + `k_pe`），decode 与 prefill 走不同 kernel，故定义独立的 `MLAAttentionImpl`（`backend.py:1009`）：`forward_mha`（prefill，展开 latent 为完整 K/V 再做标准 attention）与 `forward_mqa`（decode，直接在 latent cache 上做 MQA，不解压）。`MLAAttention.forward_impl`（`mla_attention.py:687`）按 `attn_metadata.num_decode_tokens` 与 `num_prefill_tokens` 分发到两路。MLA 的 `get_kv_cache_shape` 返回 `(num_blocks, block_size, kv_lora_rank + qk_rope_head_dim)`，不打包 K/V。

### Selector 的自动选择

`get_attn_backend`（`selector.py:101`）从 `VllmConfig` 读 `attention_config.backend`（用户显式指定）或 None（自动），构造 `AttentionSelectorConfig`（head_size/dtype/use_mla/has_sink 等），调 `current_platform.get_attn_backend_cls`。CUDA 平台（`cuda.py:397`）的逻辑：用户指定则校验用之；否则 `get_valid_backends` 按优先级列表逐一校验选最高优先级。优先级（`cuda.py:83` `_get_backend_priorities`）按 `use_mla` + `device_capability.major` 分组：如 MLA+SM100 给 `[FLASHINFER_MLA, CUTLASS_MLA, FLASHMLA, TRITON_MLA, ...]`，非 MLA+SM100 给 `[FLASHINFER, FLASH_ATTN, TRITON_ATTN, ...]`。`@cache` 装饰器缓存结果。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `AttentionBackend` + 30+ 子类 | 多后端运行时可替换 |
| 工厂 + 注册 | `AttentionBackendEnum` in `registry.py:34` + `resolve_obj_by_qualname` | 字符串名延迟 import，避免循环 |
| 模板方法 | `validate_configuration` in `backend.py:319` | 统一校验流程 + 钩子 |
| Protocol 解耦 | `AttentionLayer` in `backend.py:775` | impl 经 Protocol 访问 layer 的 scale，不硬编码依赖 |

## 模块间交互

backend 侧依赖 `v1/worker`（`CommonAttentionMetadata` 由 worker 构造）、`v1/core`（`block_table`/`slot_mapping` 经 `ForwardContext` 间接传）、`v1/kv_cache_interface`（`KVCacheSpec`/`KVQuantMode`）。被 `model_executor/layers/attention` 的 `Attention`/`MLAAttention` 调用。layer↔backend 的耦合点是 `ForwardContext`（`vllm/forward_context.py`）：worker `set_forward_context` 写、layer `get_attention_context` 读。`prefix caching` 在 attention 层体现为 cascade attention（`flash_attn.py:1069`）：`builder.build` 收 `common_prefix_len`，>0 时把 attention 拆 prefix（共享算一次）+ suffix（各请求独立），再 `merge_attn_states` 合并。

## 扩展方式

新增注意力后端：建 `vllm/v1/attention/backends/my_attn.py` 定义 `MyAttnBackend(AttentionBackend)`（override `get_name`/`get_impl_cls`/`get_builder_cls`/`get_kv_cache_shape` 与相关 `supports_*`）、`MyAttnMetadata`、`MyAttnMetadataBuilder`、`MyAttnImpl`；在 `backends/registry.py` 的 `AttentionBackendEnum` 加枚举；在 `platforms/cuda.py` 的 `_get_backend_priorities` 加优先级位置。为已有后端加能力（如 sliding window）：override 对应 `supports_*` 返回 True，在 `build` 写入 metadata、在 `forward` 传给 kernel。
