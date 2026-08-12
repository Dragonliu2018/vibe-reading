---
source:
  type: "源码解读"
  project: "TensorRT-LLM"
  url: "https://github.com/NVIDIA/TensorRT-LLM"
title: "attention_backend"
date: "2026-08-12T12:04:11+08:00"
category: [AI, Infra, Inference, TensorRT-LLM, CodeWiki, "1.3.0"]
tags: ["TensorRT-LLM", "attention", "FlashInfer", "TRTLLM", "Paged KV Cache"]
description: "attention_backend 是注意力 kernel 适配层——AttentionBackend 抽象 + TRTLLM/FlashInfer/Vanilla 多后端，prefill/decode 分支，paged KV cache 适配。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/TensorRT-LLM/CodeWiki/1.3.0/00-overview)

---

## 模块定位

attention_backend 是算子层与底层 kernel 之间的适配层——把 `Attention` 算子的 `forward(q, k, v, metadata)` 调用转成具体的 attention kernel 调用（TRTLLM C++ kernel、FlashInfer 库、或 PyTorch 原生）。模块独立存在是因为**注意力是推理性能热点，需要多 kernel 可切换**：不同 GPU 架构、不同场景（prefill/decode/MLA/sparse）最优 kernel 不同，统一抽象让上层算子与下层 kernel 解耦。

## 模块架构

```
AttentionBackend (interface.py:995)          ← 抽象策略，Generic[TMetadata]
  ├── TrtllmAttention (trtllm.py:1276)       ← TRT-LLM 自研 C++ kernel（fmha_libs）
  ├── FlashInferAttention (flashinfer.py:1903) ← FlashInfer 库
  ├── VanillaAttention (vanilla.py)          ← PyTorch 原生（参考实现）
  └── StarAttention                          ← Star Attention（FlashInfer 扩展）

get_attention_backend(name) (utils.py:18)    ← 工厂，配置驱动
AttentionMetadata (interface.py:65)          ← 运行时上下文（seq_lens, page table, ...）
```

## 调用链路

从抽象 `forward` 到具体 kernel：

```
Attention.forward_impl()                      [modules/attention.py:922]
  → self.attn.forward(q, k, v, metadata, forward_args=...)
      ↑ self.attn 是 AttentionBackend 子类实例

[FlashInfer 后端]
FlashInferAttention.forward()                 [flashinfer.py:2423]
  → forward_impl()                            [flashinfer.py:2191]
      ├─ 若 MLA: _mla_forward_context() / _mla_forward_generation()
      └─ 标准: _append_paged_kv_cache() → metadata.plan() → prefill/decode_forward()

[TRTLLM 后端]
TrtllmAttention.forward()                     [trtllm.py:1576]
  → 遍历 self.fmha_libs:
      for fmha in fmha_libs:
          if fmha.is_supported(q,k,v,metadata): fmha.forward(...); break
```

| 组件 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `AttentionBackend` | 抽象 forward + 能力声明 | Generic[TMetadata] 类型绑定 |
| `AttentionMetadata` | 运行时上下文容器 | 携带 page table、seq_lens、spec metadata |
| `get_attention_backend()` | 工厂选择后端 | 配置时静态决定，运行时不切换 |

## 核心实现

### 策略模式与能力声明

`AttentionBackend` in `interface.py:995` 是抽象策略，使用 `Generic[TMetadata]`——每个后端绑定自己的 `Metadata` 类型（`Metadata = XxxAttentionMetadata`）。子类通过 `support_fused_rope()` / `support_fused_qkv()` / `support_mla()` / `support_multi_item_scoring()` 声明能力，默认 False。

`get_attention_backend()` in `utils.py:18` 是工厂：`"TRTLLM"` → `TrtllmAttention`，`"FLASHINFER"`（且可用）→ `FlashInferAttention`，不可用时 fallback 到 `TrtllmAttention`。后端选择是**配置时静态决定**的（`config.attn_backend` 字符串，模型初始化时一次性创建），运行时不切换。**Why**：不同 GPU 架构最优 kernel 不同，FlashInfer 不可用时需 fallback，多后端让用户按场景选最优。

### prefill vs decode 分支

注意力在 prefill（多 token）和 decode（单 token）的计算模式根本不同——prefill 是 compute-bound，decode 是 memory-bound。

**FlashInfer**（`flashinfer.py:2191`）通过 `metadata.num_contexts` 和 `num_generations` 分流：prefill 用 `BatchPrefillWithPagedKVCacheWrapper`（Q 是多 token 变长序列，需 `qo_indptr`），decode 用 `BatchDecodeWithPagedKVCacheWrapper`（Q 每序列单 token，需 `paged_kv_indptr`/`paged_kv_indices`/`paged_kv_last_page_len`）。mixed 场景两者都执行。

**TRTLLM** 通过 `fmha_libs` 列表中多个 `Fmha` 子类的 `is_supported()` 自动选择——不同 FMHA 实现支持不同场景（context FMHA、generation XQA kernel、MLA generation 等）。

### Paged KV Cache 适配

Paged KV cache 是两种后端共享的核心机制，但适配方式不同。公共层 `AttentionMetadata.kv_cache_manager` 持有 `KVCacheManagerV2`，`kv_cache_params` 携带 `block_ids_per_seq`、`num_cached_tokens_per_seq`。

**FlashInfer 适配**：`prepare()` 构建 `paged_kv_indices`/`paged_kv_indptr`/`paged_kv_last_page_len`（FlashInfer API 要求的 page table 格式），`_append_paged_kv_cache` 调 `flashinfer.page.append_paged_kv_cache` 写入新 KV。head 数超 CUDA CTA 限制时分批（`_slice_paged_kv_cache_heads`）。

**TRTLLM 适配**：`TrtllmAttentionMetadata` 携带 `kv_cache_block_offsets`（C++ kernel 期望的格式），`host_kv_cache_pool_pointers` / `host_kv_cache_pool_mapping` 直接传给 C++ THOP。

**VSWA**（Variable Sliding Window Attention，Gemma4 等）：FlashInfer 为不同 sliding window pool 维护独立 `paged_kv_indices` 缓冲区，每层 forward 前 `swap_paged_kv_indices_for_layer()` 切换。

### MLA 支持

MLA（Multi-head Latent Attention，DeepSeek 系列）需要特殊处理：FlashInfer 用 `BatchMLAPagedAttentionWrapper` + ragged prefill（`_mla_forward_context`）；TRTLLM 用 `compute_flash_mla_metadata` + 专门的 MLA generation kernel。`MLAParams` in `interface.py:1083` 携带 MLA 参数，`support_mla()` 声明能力。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略 | `AttentionBackend` + 多子类 in `interface.py:995` | 多 kernel 可切换 |
| 工厂 | `get_attention_backend()` / `create_attention()` in `utils.py:18,44` | 配置驱动选择 |
| 泛型类型绑定 | `Generic[TMetadata]` + `Metadata = Xxx` | 类型安全的 metadata 绑定 |

## 模块间交互

attention_backend 向上被 `modules/attention.py` 调用——`Attention.__init__` 调 `create_attention()` 创建 `self.attn`，`forward_impl()` 调 `self.attn.forward(q,k,v,metadata,forward_args)`。`AttentionForwardArgs`（从 `attention_backend` 导入）封装 `out_scale`、`kv_scale`、`attention_mask` 等后端无关参数。

向下调用底层 kernel：FlashInfer 调 `flashinfer` Python 库 API（`BatchPrefillWithPagedKVCacheWrapper` 等）；TRTLLM 通过 `tensorrt_llm.bindings.internal.thop` 调 C++ attention op。

被 `pyexecutor/model_engine.py` 调用——`PyTorchModelEngine._set_up_attn_metadata()` in `model_engine.py:2997` 构建对应后端的 `AttentionMetadata`，传入模型 forward。`metadata.prepare()` 在 forward 前由 runtime 调用，准备 paged KV indices 等缓冲区。

## 扩展方式

**新增注意力后端 `MyCustomAttention`**：

1. 新建 `attention_backend/my_custom.py`：定义 `MyCustomAttentionMetadata(AttentionMetadata)` + `MyCustomAttention(AttentionBackend[MyCustomAttentionMetadata])`，设置 `Metadata`，实现 `forward()`，声明 `support_*()` 能力
2. 修改 `utils.py:18` `get_attention_backend()` 添加分支
3. 处理 metadata 创建（runtime 层通过 `AttentionBackend.Metadata` 反射实例化）
4. 若需 CUDA graph，实现 `create_cuda_graph_metadata()`（`interface.py:358`，所有 tensor 预分配且地址稳定）
5. 可选：sparse attention 适配在 `sparse/` 添加 `get_my_custom_sparse_attn_attention_backend()`

**约束**：`forward()` 的 q/k/v 输入格式由 `AttentionForwardArgs.is_fused_qkv` 和 `has_unfused_kv` 决定，新后端必须处理这些变体；`metadata.prepare()` 可能需 override 来准备自己的缓冲区。
