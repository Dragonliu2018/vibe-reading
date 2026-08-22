---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "模型层"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "Layers", "Attention", "MoE", "硬件后端"]
description: "xLLM 模型层解读：common 共享层 + 各硬件后端（NPU/CUDA/MLU/DCU/ILU/MUSA）的 Attention/MLP/MoE 实现。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

模型层（`core/layers/`）是模型的"积木"——Attention、MLP、Norm、Embedding 等可组合的层实现。它与 `core/kernels/`（算子内核）共同构成硬件抽象层：layers 组织层的计算逻辑，kernels 提供底层算子。这层独立是因为多硬件后端（NPU/CUDA/MLU/DCU/ILU/MUSA）的实现差异巨大，用条件编译 + 共享 common 层来收敛。`~58.8k` 行 C++，与 framework 并列最大。

## 模块架构

```
layers/
├── common/                # 硬件无关的共享层与元数据
│   ├── attention.h           # 条件编译 → 各后端 attention.h
│   ├── attention_metadata*   # Attention 元数据（seq_lens/cu_seq_lens/block_table）
│   ├── linear.h / dense_mlp  # 线性层与 MLP
│   ├── fused_moe.h           # 融合 MoE（公共基类 fused_moe_base）
│   ├── rms_norm / activation # 归一化与激活
│   ├── lm_head / word_embedding  # 输出头与嵌入
│   ├── rotary_embedding*     # RoPE（含 deepseek_v4 变体）
│   └── dsa_metadata*         # DeepSeek SP 元数据
├── npu/                   # 昇腾 NPU 后端
│   ├── npu_base_layer        # NPU 层基类
│   ├── multi_head_attention  # NPU Attention 实现
│   ├── npu_*_decoder_layer_impl  # 各模型 decoder layer（deepseek_v2/v32/glm4/eagle3...）
│   ├── loader/               # 权重加载器（rolling_load_manager）
│   └── buffer/               # NPU buffer 管理
├── cuda/                  # CUDA 后端
│   ├── attention / flashinfer_attention   # FlashInfer / xAttention
│   └── fused_moe
├── mlu/ dcu/ ilu/ musa/  # 其他国产加速器后端
└── npu_torch/            # NPU 上基于 torch 的层实现
```

核心设计是 **common 共享 + 后端特化**：`layers/common/` 定义硬件无关的逻辑与元数据结构，`attention.h` 等头文件用 `#if defined(USE_NPU)`/`#elif defined(USE_CUDA)` 条件编译包含对应后端的实现。这样模型代码（`models/llm/`）只需 `#include "layers/common/attention.h"`，编译期自动链接到正确后端。

## 调用链路

模型前向中层调用的链路：

```text
CausalLM::forward(tokens, positions, kv_caches, params)  in models/llm/llm_model_base.h
├─ embed_tokens_(tokens) → hidden_states          # 词嵌入
├─ AttentionMetadataBuilder::build(params)          # 构建 attn 元数据
├─ for i in layers_:
│    └─ layers_[i](h, residual, positions, attn_metadata, kv_caches[i], params)
│         ├─ attention(hidden, positions, attn_metadata, kv_cache)   in layers/{backend}/attention
│         ├─ mlp / fused_moe(hidden)                in layers/common/dense_mlp / fused_moe
│         └─ norm_(h, residual)                     in layers/common/rms_norm
└─ norm_(h, residual) → ModelOutput(hidden, residual)
```

`LlmModelImplBase<DecoderLayerType>`（`llm_model_base.h`）是 LLM 模型基类模板，`DecoderLayerType` 是模板参数——不同模型注入不同的 decoder layer 类型，实现编译期多态。

<details>
<summary>层速查表</summary>

| 层 | common 位置 | 职责 | 后端实现 |
| --- | --- | --- | --- |
| `Attention` | `common/attention.h` | 自注意力（PagedAttention） | npu/cuda/mlu/dcu/... |
| `AttentionMetadata` | `common/attention_metadata.h` | seq_lens/block_table/cu_seq_lens | 共享 |
| `Linear` | `common/linear.h` | 线性变换（ColumnParallel 等） | 各后端 impl |
| `DenseMLP` / `FusedMoE` | `common/dense_mlp`/`fused_moe` | MLP 与 MoE | fused_moe 各后端 |
| `RMSNorm` | `common/rms_norm` | RMS 归一化 | 共享 |
| `RotaryEmbedding` | `common/rotary_embedding*` | RoPE 位置编码 | deepseek_v4 变体 |
| `LmHead` / `WordEmbedding` | `common/lm_head`/`word_embedding` | 输出头/嵌入 | NPU 特化 |

</details>

## 核心实现

### 条件编译后端选择

`attention.h` 是典型的后端分发头文件：

```cpp title="core/layers/common/attention.h"
#if defined(USE_MLU)
#include "layers/mlu/attention.h"
#elif defined(USE_NPU)
#include "layers/npu_torch/attention.h"
#elif defined(USE_CUDA)
#include "layers/cuda/attention.h"
#elif defined(USE_ILU)
#include "layers/ilu/attention.h"
// ...
#endif
```

设计决策：用编译宏而非运行时 dispatch，因为算子性能敏感，虚函数开销不可接受。同一份模型代码编译出六个二进制，各链接对应后端。`USE_NPU`/`USE_CUDA` 等宏由 CMakeLists 根据目标硬件设置。

### AttentionMetadata 与 paged KV

`AttentionMetadata`（`common/attention_metadata.h`）封装 paged attention 所需的全部上下文：`seq_lens`（每序列长度）、`cu_seq_lens`（前缀和）、`block_table`（块表，指向物理块）、`kv_caches`（K/V 张量）、`max_seq_len`。`AttentionMetadataBuilder::build()` 从 `ModelInputParams` 构建。这是 layers 与 scheduler 之间的契约——scheduler 分配 Block，layers 经 `block_table` 访问。

### NPU decoder layer 特化

`layers/npu/` 下每个模型族有独立的 decoder layer 实现（`npu_deepseek_v2_decoder_layer_impl`/`npu_glm4_decoder_layer_impl`/`npu_eagle3_decoder_layer_impl` 等）。这是因为各模型的层结构差异大（MoE 路由、MLA、linear attention 混合），且 NPU 算子库（CANN）对各结构的优化点不同，需要针对性实现。`npu_base_layer` 是公共基类。

### FusedMoE 与 EPLB

`common/fused_moe.h` 是 MoE 融合算子基类，`fused_moe_base.h` 定义公共接口。MoE 层的专家分布可动态调整（EPLB，`framework/eplb/`）：`EplbManager` 定期统计专家负载，`process_eplb_data` 重映射专家到均衡分布。`prepare_expert_weight`/`update_expert_weight` 在 `CausalLM` 接口中定义，支撑运行期专家重排。

## 模块间交互

- **被 Models 依赖**：`models/llm/` 的各模型继承 `LlmModelImplBase`，注入 decoder layer 类型。
- **依赖 Kernels**：层内调硬件算子（`core/kernels/{npu,cuda,...}/`）。
- **依赖 Framework**：`KVCache`/`AttentionMetadata`/`ModelInputParams` 来自 `framework/`。

## 扩展方式

- 新增硬件后端：在 `layers/` 新建后端目录实现 `attention.h`/`linear.h` 等，在 CMakeLists 增加 `USE_NEWHW` 宏，在 `common/attention.h` 条件编译增加分支。
- 新增模型层结构：在 `layers/npu/` 新建 `npu_xxx_decoder_layer_impl`，在对应 `models/llm/xxx.h` 作为 `DecoderLayerType` 注入。
