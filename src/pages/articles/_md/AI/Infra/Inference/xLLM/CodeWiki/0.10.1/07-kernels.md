---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "算子内核"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "Kernels", "PageAttention", "MoE", "国产算子"]
description: "xLLM 算子内核解读：各硬件后端（NPU/CUDA/MLU/DCU/ILU/MUSA）的 Attention/MatMul/MoE dispatch-combine 算子。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

算子内核（`core/kernels/`）是硬件级算子适配层。它把各硬件厂商的算子库（昇腾 CANN 的 `aclnn`、CUDA 的 FlashInfer/cutlass、寒武纪 MLU 等）封装为统一接口，供 `layers/` 调用。这层与 layers 分离是因为：算子实现紧耦合硬件 SDK，更新频率与硬件驱动同步，而层逻辑随模型结构变化——分离后硬件升级只改 kernels 不动 layers。`~24.8k` 行 C++/CUDA。

## 模块架构

```
kernels/
├── npu/     (~8.5k 行)  # 昇腾 NPU 算子（最多，主力硬件）
│   ├── attention.cpp            # npu_fused_infer_attention（paged attention）
│   ├── matmul.cpp               # 矩阵乘
│   ├── npu_moe_*_dispatch/combine  # MoE 专家分发与合并
│   ├── npu_grouped_matmul       # 分组矩阵乘（MoE）
│   ├── npu_moe_gating_topk_softmax  # 门控 topk
│   ├── fused_layernorm / active # 融合算子
│   ├── npu_causal_conv1d        # 因果卷积（Mamba 类）
│   ├── npu_recurrent_gated_delta_rule  # 线性注意力递归
│   └── aclnn/                   # CANN aclnn 算子封装
├── cuda/    (~4.3k 行)  # CUDA 算子
│   ├── batch_decode/prefill     # 批解码/预填 attention
│   ├── attention_runner         # attention 执行器
│   ├── cutlass_extensions/      # cutlass 矩阵乘扩展
│   ├── cutlass_w8a8             # W8A8 量化
│   ├── fp8_quant / fp8_scaled_matmul  # FP8 量化算子
│   └── block_copy.cu            # 块拷贝（KV cache 迁移）
├── mlu/     (~3.6k 行)  # 寒武纪 MLU 算子
├── dcu/     (~0.9k 行)  # 海光 DCU 算子
├── ilu/     (~0.9k 行)  # 芯擎 ILU 算子
└── musa/    (~0.1k 行)  # 摩尔线程 MUSA 算子
```

NPU 是代码量最大的后端（京东主力部署硬件），包含 MoE 全链路算子（dispatch→topk→grouped_matmul→combine）、线性注意力递归、因果卷积等。CUDA 作为参考实现与 NVIDIA GPU 支持。

## 核心实现

### Paged Attention 算子

各后端的 attention 算子实现 paged KV cache 的注意力计算。NPU 用 `npu_fused_infer_attention`（封装 CANN `aclnn` 算子），CUDA 用 FlashInfer 的 `batch_decode`/`batch_prefill`。输入是 `AttentionMetadata`（含 block_table、seq_lens、cu_seq_lens），输出 attention 输出。这是推理性能的核心算子，各后端都做了深度优化（融合 softmax、融合 RoPE）。

### MoE dispatch-combine 链路

MoE 的 token 路由是一组协作算子，NPU 实现最完整：

```text
npu_moe_gating_topk_softmax  # 门控→topk→softmax（选专家）
  → npu_moe_init_routing_v2   # 初始化路由（token→专家映射）
  → npu_moe_distribute_dispatch_v2  # 分发 token 到各专家
  → npu_grouped_matmul         # 各专家分组矩阵乘
  → npu_moe_distribute_combine_v2  # 合并各专家输出
  → npu_moe_token_unpermute   # 还原 token 顺序
```

这组算子实现 MoE 的完整前向，与 `EPLB` 配合可动态调整专家分布。

### 量化算子

CUDA 后端的 `cutlass_w8a8`/`fp8_quant`/`fp8_scaled_matmul` 实现 W8A8 与 FP8 量化推理，降低显存与加速计算。NPU 后端通过 `aclnn` 量化算子支持。`kv_cache_dtype` 控制是否对 KV cache 量化（`quantized_kv_cache_impl`）。

### 线性注意力算子

`npu_causal_conv1d` 与 `npu_recurrent_gated_delta_rule` 支撑 Mamba/线性注意力类模型（DeepSeek-V4 等）。这类模型无显式 KV cache，用递归状态（SSM）替代，算子实现状态更新。

## 模块间交互

- **被 Layers 依赖**：`layers/{backend}/` 的各层调用对应后端 kernels。
- **依赖硬件 SDK**：NPU 调 CANN `aclnn`、CUDA 调 FlashInfer/cutlass、MLU 调寒武纪 SDK。
- **与 Framework 配合**：`block_copy` 算子服务于 KV cache 块迁移（PD 分离时跨实例拷贝）。

## 扩展方式

- 新增算子：在对应后端目录新增 `.cpp`/`.cu`，在 `*_ops_api.h` 暴露 C 接口，在 `layers/` 调用。
- 新增硬件后端：在 `kernels/` 新建后端目录，实现各层所需算子的等价物。
