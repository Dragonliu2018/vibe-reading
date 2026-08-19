---
title: "Towards Blackwell-Native 8-bit and 4-bit RL: End-to-End MXFP8 and NVFP4 RL in Miles"
source:
  type: "article"
  project: "LMSYS"
  url: "https://www.lmsys.org/blog/2026-07-29-mxfp8-nvfp4-rl/"
  author: "Ziang Li, humans& and Miles Team"
  site: "LMSYS Blog"
date: "2026-07-30T17:00:00+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "Official"]
tags: ["MXFP8", "NVFP4", "Low-Precision", "Reinforcement Learning", "Blackwell", "Miles", "SGLang", "Megatron", "MoE"]
description: "LMSYS Miles 团队在 Blackwell 上实现端到端 MXFP8 与 per-token NVFP4 强化学习：覆盖 rollout、前向、权重梯度与数据梯度 GEMM，精细精度控制贯穿 checkpoint 转换、训练、rollout 与在线权重更新。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Towards Blackwell-Native 8-bit and 4-bit RL: End-to-End MXFP8 and NVFP4 RL in Miles](https://www.lmsys.org/blog/2026-07-29-mxfp8-nvfp4-rl/) · **作者** Ziang Li, humans& and Miles Team · **来源** LMSYS Blog · **原文发布** 2026-07-29 · **中英对照·AI 译** 2026-07-30
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

## TL;DR

The post describes two Blackwell-native RL recipes implemented in Miles: end-to-end MXFP8 and per-token NVFP4 for MoE experts. Both feature fine-grained precision control across checkpoint conversion, Megatron training, SGLang rollout, and live weight updates. MXFP8 covers rollout, forward propagation, weight-gradient GEMMs, and data-gradient GEMMs. NVFP4 uses online per-token activation scaling for its MoE expert path, and both formats support high-precision or dequantized backward modes. In a Qwen3-30B-A3B recipe ablation on 8x B200, "BF16 and all five low-precision configurations have closely overlapping raw reward curves," while MXFP8 and NVFP4 reduce rollout time.

> **译：** 本文介绍在 Miles 中实现的两套 Blackwell 原生 RL 配方：端到端 MXFP8，以及面向 MoE 专家的 per-token NVFP4。两者都在 checkpoint 转换、Megatron 训练、SGLang rollout 和在线权重更新之间提供精细的精度控制。MXFP8 覆盖 rollout、前向传播、权重梯度 GEMM 和数据梯度 GEMM。NVFP4 在其 MoE 专家路径上使用在线 per-token 激活缩放，两种格式都支持高精度或反量化（dequantized）反向模式。在 8x B200 上对 Qwen3-30B-A3B 的配方消融中，"BF16 与全部五种低精度配置的原始 reward 曲线高度重合"，同时 MXFP8 和 NVFP4 缩短了 rollout 时间。

## Introduction

In low-precision RL, rollout, training, checkpoint conversion, and live weight updates must agree on one precision contract, or the sampler and trainer policies will diverge. Miles and the SGLang RL ecosystem have already incorporated low-precision recipes: the LMSYS FP8 RL post showed that using FP8 across training and sampling reduces mismatch relative to BF16 training with FP8 rollout; the INT4 QAT post showed that fake quantization during training and W4A16 rollout can make INT4 practical. This work extends to Blackwell-native formats by implementing MXFP8 and NVFP4 recipes in Miles and contributing supporting components across SGLang, TransformerEngine, FlashInfer, Megatron, and cuDNN frontend. The public roadmap is tracked in miles#615.

> **译：** 在低精度 RL 中，rollout、训练、checkpoint 转换和在线权重更新必须就同一份精度契约达成一致，否则采样策略与训练策略会发散。Miles 与 SGLang RL 生态已纳入低精度配方：LMSYS FP8 RL 文章表明，在训练和采样中统一使用 FP8 相比"BF16 训练 + FP8 rollout"能降低不匹配；INT4 QAT 文章表明，训练时用伪量化、rollout 时用 W4A16 可以让 INT4 落地可行。本工作将其扩展到 Blackwell 原生格式——在 Miles 中实现 MXFP8 与 NVFP4 配方，并在 SGLang、TransformerEngine、FlashInfer、Megatron 和 cuDNN frontend 中贡献配套组件。公开路线图在 miles#615 跟踪。

The main contributions are:

> **译：** 主要贡献为：

1. End-to-end MXFP8 RL, where rollout, forward propagation, weight-gradient GEMMs, and data-gradient GEMMs all use MXFP8.
2. Per-token NVFP4 RL for MoE expert weights, using online per-token activation scaling.
3. Fine-grained precision control, so selected tensors such as final layers can remain BF16 consistently.
4. A bit-exact quantizer contract between TransformerEngine and FlashInfer, so weight updates do not introduce avoidable train-inference mismatch.

> **译：**
>
> 1. 端到端 MXFP8 RL，其中 rollout、前向传播、权重梯度 GEMM 和数据梯度 GEMM 全部使用 MXFP8。
> 2. 面向 MoE 专家权重的 per-token NVFP4 RL，使用在线 per-token 激活缩放。
> 3. 精细精度控制，使选定张量（如最后几层）能一致地保持 BF16。
> 4. TransformerEngine 与 FlashInfer 之间的逐位精确量化器契约，使权重更新不引入可避免的训练-推理不匹配。

## Why Blackwell-Native Recipes?

Previous low-precision approaches were not designed around MXFP8 or NVFP4. The existing Miles path follows a DeepSeek-V3-style block-scaled FP8 recipe: weights use 128x128 block scaling, activations use 1x128 tile scaling, and scales are computed online for each tile or block. This is a strong Hopper-era recipe, but on Blackwell its FP32 scales are still applied in software around the Tensor Core path rather than through native microscaling hardware.

> **译：** 此前的低精度方案并非围绕 MXFP8 或 NVFP4 设计。现有 Miles 路径遵循 DeepSeek-V3 风格的分块缩放 FP8 配方：权重使用 128x128 块缩放，激活使用 1x128 平铺缩放，每个 tile 或块的缩放因子在线计算。这是一套强有力的 Hopper 时代配方，但在 Blackwell 上，其 FP32 缩放仍是在 Tensor Core 路径周围以软件方式施加，而非通过原生 microscaling 硬件完成。

INT4 QAT solves a different problem. Training uses fake quantization to adapt the model to INT4 weights, while rollout uses W4A16. Although memory efficient, the compute path still effectively uses BF16 activations with dequantized INT4 weights. The table below normalizes NVIDIA's HGX platform dense Tensor Core specs to per-GPU throughput: B200 and B300 from 8-GPU HGX systems, Rubin from the HGX Rubin NVL8 table.

> **译：** INT4 QAT 解决的是另一个问题。训练用伪量化让模型适应 INT4 权重，rollout 用 W4A16。虽然显存高效，但计算路径实际上仍使用 BF16 激活配合反量化后的 INT4 权重。下表将 NVIDIA HGX 平台的稠密 Tensor Core 规格归一化为单 GPU 吞吐：B200 和 B300 取自 8-GPU HGX 系统，Rubin 取自 HGX Rubin NVL8 表。

| GPU | BF16 dense Tensor Core | FP8 dense Tensor Core | FP4 dense Tensor Core |
|-----|----------------------|---------------------|---------------------|
| B200 | 2.25 PFLOPS | 4.5 PFLOPS | 9 PFLOPS |
| B300 | 2.25 PFLOPS | 4.5 PFLOPS | 13.5 PFLOPS |
| Rubin GPU (NVL8) | 4 PFLOPS | 17.5 PFLOPS | 35 PFLOPS |

For RL systems, the precision contract spans:

> **译：** 对于 RL 系统，精度契约涵盖：

- SGLang rollout.
- Megatron and TransformerEngine training.
- Hugging Face checkpoint conversion.
- Megatron-to-Hugging Face live weight export.
- Fine-grained high-precision exceptions.

> **译：**
>
> - SGLang rollout。
> - Megatron 与 TransformerEngine 训练。
> - Hugging Face checkpoint 转换。
> - Megatron 到 Hugging Face 的在线权重导出。
> - 精细的高精度例外。

## Format Background

### MXFP8

MXFP8 is a microscaling FP8 format. TransformerEngine's MXFP8 documentation describes it as a Blackwell-native blockwise scaling recipe: every 32 consecutive E4M3 values share one local E8M0 scale, and the block is one-dimensional.

> **译：** MXFP8 是一种 microscaling FP8 格式。TransformerEngine 的 MXFP8 文档将其描述为 Blackwell 原生的分块缩放配方：每 32 个连续的 E4M3 值共享一个局部 E8M0 缩放因子，且该块是一维的。

Because E8M0 scales represent powers of two, the decoded scale is usually rounded up so the maximum value in the block is not clipped.

> **译：** 由于 E8M0 缩放因子表示 2 的幂，解码后的缩放通常向上取整，使块内最大值不被截断。

### NVFP4

NVFP4 is Blackwell's native FP4 format. As described in NVIDIA's NVFP4 introduction, it stores FP4 E2M1 values with one FP8 E4M3 scale per 16-value block. Because E4M3 has finer resolution than UE8M0, its scale is typically rounded to the nearest representable value. A standard NVFP4 recipe also adds one FP32 scale for the larger tensor scope, creating a two-level hierarchy:

> **译：** NVFP4 是 Blackwell 的原生 FP4 格式。如 NVIDIA NVFP4 介绍所述，它存储 FP4 E2M1 值，每 16 个值一个 FP8 E4M3 缩放因子。由于 E4M3 比 UE8M0 分辨率更高，其缩放通常四舍五入到最近的可表示值。标准 NVFP4 配方还为更大的张量范围额外加一个 FP32 缩放，形成两级层次：

- A coarse FP32 scale that maps the tensor or token into the NVFP4 representable range.
- A fine E4M3 scale that adapts each 1x16 block.

> **译：**
>
> - 一个粗粒度 FP32 缩放，将张量或 token 映射到 NVFP4 可表示范围。
> - 一个细粒度 E4M3 缩放，适配每个 1x16 块。

![NVFP4 two-level scaling with FP32 tensor scale and E4M3 block scales](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/nvfp4-two-level-scaling.png)

The FP32 scale can be chosen over different tensor scopes. That choice is a recipe decision rather than a property of the format itself, and it becomes especially important for RL.

> **译：** FP32 缩放可以在不同的张量范围内选取。这是一个配方决策，而非格式本身的属性，对 RL 尤为重要。

## Recipe 1: End-to-End MXFP8 RL

The MXFP8 recipe is the most direct Blackwell-native extension of the earlier end-to-end FP8 work. Rollout, forward propagation, weight-gradient GEMMs, and data-gradient GEMMs all use MXFP8, while selected tensors remain BF16 through the precision-control rules described below.

> **译：** MXFP8 配方是此前端到端 FP8 工作最直接的 Blackwell 原生扩展。rollout、前向传播、权重梯度 GEMM 和数据梯度 GEMM 全部使用 MXFP8，而选定张量通过下文所述精度控制规则保持 BF16。

![End-to-end MXFP8 RL recipe](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/MXFP8-E2E.drawio.png)

### Training

TransformerEngine and Megatron implement MXFP8 as a performance-optimized, first-class Blackwell training path, including the GB200 DeepSeek-V3 optimizations described in the Megatron-LM documentation. In the Miles integration, this path serves as the training-side foundation for end-to-end MXFP8 RL.

> **译：** TransformerEngine 和 Megatron 将 MXFP8 实现为性能优化的、一等公民的 Blackwell 训练路径，包括 Megatron-LM 文档中所述的 GB200 DeepSeek-V3 优化。在 Miles 集成中，该路径作为端到端 MXFP8 RL 的训练侧基础。

One difference from the DeepSeek-V3 FP8 recipe is how backward activations are represented. DeepSeek-V3 stores forward activations in 1x128 FP8 tiles and converts them to the backward orientation before the backward GEMM. That approach stores less FP8 data, but it introduces dequantization plus requantization before the backward GEMM. TransformerEngine's MXFP8 docs note that rowwise 1x32 blocks and columnwise 32x1 blocks are numerically different and must be quantized independently from full-precision data. TransformerEngine therefore materializes both row-wise and column-wise quantized copies during quantization. This uses more memory, but it avoids an extra requantization step and reduces additional quantization error in the backward path.

> **译：** 与 DeepSeek-V3 FP8 配方的一个区别在于反向激活的表示方式。DeepSeek-V3 将前向激活存为 1x128 FP8 tile，并在反向 GEMM 前转换到反向朝向。该方式存储的 FP8 数据更少，但在反向 GEMM 前引入了反量化再加量化。TransformerEngine 的 MXFP8 文档指出，按行的 1x32 块与按列的 32x1 块在数值上不同，必须从全精度数据独立量化。因此 TransformerEngine 在量化时会物化行向和列向两份量化副本。这占用更多显存，但避免了额外的再量化步骤，并减少了反向路径中的额外量化误差。

This is a typical systems trade-off for RL. The TransformerEngine path is used to preserve one end-to-end MXFP8 contract without adding another source of mismatch.

> **译：** 这是 RL 中典型的系统权衡。采用 TransformerEngine 路径是为了维持单一端到端 MXFP8 契约，不引入新的不匹配来源。

### Rollout

On the rollout side, SGLang uses Blackwell MXFP8 kernels from FlashInfer and Triton. The rollout path was implemented and upstreamed across FlashInfer and SGLang (flashinfer#2581, sglang#17449, sglang#19537, sglang#21576, and sglang#28459).

> **译：** 在 rollout 侧，SGLang 使用来自 FlashInfer 和 Triton 的 Blackwell MXFP8 kernel。rollout 路径在 FlashInfer 和 SGLang 中实现并上游（flashinfer#2581、sglang#17449、sglang#19537、sglang#21576 和 sglang#28459）。

Almost all major GEMMs can be quantized to MXFP8, including attention projections and MoE experts. The main exceptions are explicitly controlled high-precision layers, such as the BF16 MLA projections described below.

> **译：** 几乎所有主要 GEMM 都可量化为 MXFP8，包括 attention 投影和 MoE 专家。主要例外是显式控制的高精度层，如下文所述的 BF16 MLA 投影。

## Recipe 2: Per-Token NVFP4 RL

NVFP4 is more aggressive than MXFP8, so it is applied selectively. MoE experts are quantized because they dominate model size and rollout memory traffic, while the rest of the model remains BF16 unless explicitly configured otherwise.

> **译：** NVFP4 比 MXFP8 更激进，因此选择性地应用。MoE 专家被量化，因为它们主导模型规模和 rollout 显存流量；其余部分除非显式配置，否则保持 BF16。

For example, DeepSeek-V3 has about 671B total parameters. Its MoE experts account for:

> **译：** 例如，DeepSeek-V3 约有 671B 总参数。其 MoE 专家占：

```text title="DeepSeek-V3 MoE expert parameter count"
(61 - 3) * (256 + 1) * 3 * 7168 * 2048 / 1e9 = 656.5B parameters
```

That is about 97.8% of the model. Targeting MoE experts therefore captures most of the memory benefit without forcing every layer into the most aggressive precision format.

> **译：** 约占模型的 97.8%。因此，针对 MoE 专家能捕获大部分显存收益，而无需迫使每一层都采用最激进的精度格式。

### Why not directly use the NVFP4 pretraining recipe?

The original NVFP4 pretraining recipe is designed for large-scale pretraining, where the goal is preserving a coarse optimization direction over many tokens while still using FP4 GEMMs. It combines FP4 linear-layer GEMMs with several stabilizers: selected layers remain in higher precision, weight scaling is consistent across forward and backward, and the training path uses stochastic rounding (SR) and Random Hadamard Transforms (RHT). In the paper, SR is applied to gradients to reduce quantization bias and produce unbiased quantized gradients, while RHT disperses large-magnitude block-level outliers, especially for weight-gradient GEMM inputs.

> **译：** 原始 NVFP4 预训练配方为大规模预训练设计，目标是在大量 token 上保持粗粒度优化方向的同时仍使用 FP4 GEMM。它将 FP4 线性层 GEMM 与若干稳定器结合：选定层保持更高精度，权重缩放在前向与反向间一致，训练路径使用随机舍入（SR）和随机 Hadamard 变换（RHT）。论文中，SR 施加于梯度以减少量化偏差并产生无偏的量化梯度，而 RHT 分散大幅值的块级异常值，尤其针对权重梯度 GEMM 的输入。

![Original NVFP4 pretraining recipe](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/NVFP4-pretrain.png)

That is a good starting point, but RL has a different failure surface:

> **译：** 这是一个好的起点，但 RL 有不同的失效面：

| Setting | Numerical situation | Bottom line |
|---------|-------------------|-------------|
| Pre-training | Gradient signals are stable, weight updates are substantial, model weights are adaptive, and activations and gradients are precision-sensitive with high dynamic range. | Preserve the coarse optimization direction and convergence. |
| RL | Gradients are noisy, rewards are high-variance, and useful updates are small and delicate. | Keep quantization noise below the true update signal; otherwise it can overwrite fragile capabilities and lead to performance collapse. |

> **译：**
>
> | 场景 | 数值情况 | 底线 |
> |---------|---------|------|
> | 预训练 | 梯度信号稳定、权重更新可观、模型权重具适应性、激活与梯度对精度敏感且动态范围大。 | 保持粗粒度优化方向与收敛。 |
> | RL | 梯度噪声大、reward 高方差、有效更新小而脆弱。 | 让量化噪声低于真实更新信号；否则会覆盖脆弱能力并导致性能崩溃。 |

The NVFP4 RL recipe does not incorporate every part of the pretraining recipe. It targets MoE expert weight quantization, per-token activation scaling, consistent precision control, and BF16 backward GEMMs with selectable original or dequantized operands.

> **译：** NVFP4 RL 配方并未纳入预训练配方的每个部分。它针对 MoE 专家权重量化、per-token 激活缩放、一致的精度控制，以及 BF16 反向 GEMM（可选原始或反量化操作数）。

### Per-token activation scaling

The two-level NVFP4 hierarchy is powerful, but the scope of the FP32 activation scale must be chosen carefully. As discussed in the Cursor Composer 2 technical report, per-tensor NVFP4 scaling can make training batch-variant, and inter-token scale sharing can leak future-token information into past-token representations. If a token shares its scale with other tokens, its quantized representation depends on the batch composition. This is especially problematic for RL, where rollout scheduling and sequence lengths vary.

> **译：** NVFP4 的两级层次很强大，但 FP32 激活缩放的范围必须谨慎选择。如 Cursor Composer 2 技术报告所述，per-tensor NVFP4 缩放会使训练对 batch 变化敏感，而 token 间共享缩放可能将未来 token 的信息泄漏到过去 token 的表示中。若一个 token 与其他 token 共享缩放，其量化表示就依赖于 batch 组成。这对 RL 尤其成问题，因为 rollout 调度和序列长度是变化的。

The recipe therefore computes one FP32 activation scale per token online. This localizes activation outliers to one token, removes the static activation calibration artifact, and lets SGLang rollout and Megatron training use the same activation-scale scope.

> **译：** 因此该配方在线地为每个 token 计算一个 FP32 激活缩放。这将激活异常值局部化到单个 token，消除了静态激活校准 artifact，并让 SGLang rollout 与 Megatron 训练使用相同的激活缩放范围。

On the rollout side, the per-token FP32 scale computation is fused into FlashInfer's activation quantization kernel path: the same call that emits packed FP4 activations and E4M3 block scales also returns the per-token FP32 scales. As a result, per-token activation scaling does not require a separate calibration-scale pass.

> **译：** 在 rollout 侧，per-token FP32 缩放计算被融合进 FlashInfer 的激活量化 kernel 路径：同一次调用在产出打包的 FP4 激活和 E4M3 块缩放的同时，也返回 per-token FP32 缩放。因此 per-token 激活缩放不需要单独的校准-缩放 pass。

Train-inference consistency also requires matching parallelism. If the FP32 scale is computed per token within an expert-tensor-parallel partition, SGLang and Megatron should use the same ETP size. Otherwise, each side may see a different partition of the tensor and compute a different scale.

> **译：** 训练-推理一致性还要求并行度匹配。若 FP32 缩放在 expert-tensor-parallel 分区内按 token 计算，SGLang 与 Megatron 应使用相同 ETP 大小。否则双方可能看到张量的不同分区并算出不同缩放。

SwiGLU MoE layers add another key contract. SGLang and Megatron commonly fuse the gate and up projections into one GEMM, so both tensors must share the same FP32 scale during conversion and live weight update even when the Hugging Face checkpoint stores them separately. Miles enforces this by quantizing gate/up pairs together in the NVFP4 export path.

> **译：** SwiGLU MoE 层增加了另一个关键契约。SGLang 和 Megatron 通常将 gate 和 up 投影融合为一个 GEMM，因此即使 Hugging Face checkpoint 将两者分开存储，它们在转换和在线权重更新时也必须共享同一 FP32 缩放。Miles 在 NVFP4 导出路径中将 gate/up 对一起量化来强制这一点。

The per-token NVFP4 recipe was implemented and upstreamed across the entire stack:

> **译：** per-token NVFP4 配方在整个栈中实现并上游：

- TransformerEngine training recipe: TransformerEngine#2931
- cuDNN frontend training kernels: cudnn-frontend#251
- FlashInfer rollout kernels: flashinfer#3027
- SGLang integrations and weight-update fixes: sglang#22918, sglang#22204

> **译：**
>
> - TransformerEngine 训练配方：TransformerEngine#2931
> - cuDNN frontend 训练 kernel：cudnn-frontend#251
> - FlashInfer rollout kernel：flashinfer#3027
> - SGLang 集成与权重更新修复：sglang#22918、sglang#22204

### High-precision and dequantized backward

In the high-precision-backward NVFP4 variant, the forward pass and rollout use NVFP4 for MoE experts, while the backward GEMMs use the original BF16 operands.

> **译：** 在高精度反向的 NVFP4 变体中，前向和 rollout 对 MoE 专家使用 NVFP4，而反向 GEMM 使用原始 BF16 操作数。

![NVFP4 with high-precision backward](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/NVFP4-hp.drawio.png)

Dequantized backward is a second selectable mode. The backward GEMMs still run in BF16, but consume BF16 dequantizations of the exact low-precision operands produced in forward instead of the original BF16 values.

> **译：** 反量化反向是第二种可选模式。反向 GEMM 仍在 BF16 下运行，但消费的是前向产出的低精度操作数的 BF16 反量化结果，而非原始 BF16 值。

![NVFP4 with dequantized backward](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/NVFP4-dq.drawio.png)

Both modes avoid low-precision backward GEMMs, so these configurations do not use RHT or stochastic rounding from the original NVFP4 pretraining recipe. They trade backward throughput for higher-precision computation, but RL is often rollout-bound, and long-context attention and communication further reduce the end-to-end impact.

> **译：** 两种模式都避免了低精度反向 GEMM，因此这些配置不使用原始 NVFP4 预训练配方中的 RHT 或随机舍入。它们以反向吞吐换取更高精度计算，但 RL 通常受 rollout 瓶颈，长上下文 attention 与通信进一步降低了端到端影响。

The same backward-mode selection also applies to MXFP8:

> **译：** 同样的反向模式选择也适用于 MXFP8：

![MXFP8 with high-precision backward](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/MXFP8-hp.drawio.png)

![MXFP8 with dequantized backward](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/MXFP8-dq.drawio.png)

The `NVTE_BACKWARD_OVERRIDE` interface was implemented and upstreamed as a reusable TransformerEngine interface for selecting high-precision or dequantized backward operands (TransformerEngine#2644), then exposed through the Miles recipe configuration. The companion humans& post covers the algorithmic motivation and additional backward-mode ablations.

> **译：** `NVTE_BACKWARD_OVERRIDE` 接口作为可复用的 TransformerEngine 接口实现并上游，用于选择高精度或反量化反向操作数（TransformerEngine#2644），随后通过 Miles 配方配置暴露。配套的 humans& 文章涵盖了算法动机与更多反向模式消融。

#### Backward cost and memory

Dequantized backward adds a training-side dequantization step. Overhead was reduced in collaboration with NVIDIA in TransformerEngine#2865.

> **译：** 反量化反向增加了一个训练侧反量化步骤。该开销在与 NVIDIA 合作下于 TransformerEngine#2865 中降低。

High-precision and dequantized backward can also reduce peak memory relative to TransformerEngine's default low-precision backward paths. Neither mode needs to generate and retain the second column-wise quantized copy used by the low-precision backward GEMMs described in the MXFP8 training section above.

> **译：** 相比 TransformerEngine 默认的低精度反向路径，高精度与反量化反向还可降低峰值显存。两种模式都不需要生成并保留上文 MXFP8 训练节所述低精度反向 GEMM 使用的第二份列向量化副本。

Memory measurements were taken while validating the TransformerEngine backward-mode implementation in TransformerEngine#2644. The `alloc` columns report allocated memory, the `resrv` columns report reserved memory, and all values are in MB.

> **译：** 以下显存测量在验证 TransformerEngine 反向模式实现（TransformerEngine#2644）时取得。`alloc` 列为已分配显存，`resrv` 列为预留显存，所有值以 MB 为单位。

**MXFP8 linear memory**, `dtype=torch.bfloat16`, `input_shape=(2048, 2048)`, `out_features=8192`:

| mode | fwd_alloc | bwd_alloc | e2e_alloc | fwd_resrv | bwd_resrv | e2e_resrv | delta_fwd | delta_bwd | delta_e2e |
|------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|
| default | 73.75 | 73.02 | 94.14 | 474.00 | 474.00 | 474.00 | +0.00 (+0.00%) | +0.00 (+0.00%) | +0.00 (+0.00%) |
| high precision | 53.12 | 40.02 | 53.12 | 474.00 | 474.00 | 474.00 | -20.62 (-27.97%) | -33.00 (-45.20%) | -41.02 (-43.57%) |
| dequantized | 53.25 | 80.02 | 84.64 | 474.00 | 474.00 | 474.00 | -20.50 (-27.80%) | +7.00 (+9.59%) | -9.50 (-10.09%) |

**NVFP4 linear memory**, `dtype=torch.bfloat16`, `input_shape=(2048, 2048)`, `out_features=8192`:

| mode | fwd_alloc | bwd_alloc | e2e_alloc | fwd_resrv | bwd_resrv | e2e_resrv | delta_fwd | delta_bwd | delta_e2e |
|------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|
| default | 55.75 | 146.02 | 150.27 | 478.00 | 478.00 | 478.00 | +0.00 (+0.00%) | +0.00 (+0.00%) | +0.00 (+0.00%) |
| high precision | 44.50 | 40.02 | 44.50 | 478.00 | 478.00 | 478.00 | -11.25 (-20.18%) | -106.00 (-72.60%) | -105.77 (-70.39%) |
| dequantized | 44.50 | 80.02 | 75.27 | 478.00 | 478.00 | 478.00 | -11.25 (-20.18%) | -66.00 (-45.20%) | -75.00 (-49.91%) |

## Bit-Exact Quantizer Contract

In RL, quantization mismatch can accumulate across weight updates. If the training and rollout sides quantize a tensor differently, the policies used for sampling and learning are no longer the same low-precision model. An explicit contract between both sides of the RL stack is therefore needed.

> **译：** 在 RL 中，量化不匹配会跨权重更新累积。若训练侧与 rollout 侧对同一张量量化方式不同，采样与学习所用的策略就不再是同一个低精度模型。因此需要 RL 栈两侧之间的显式契约。

The FlashInfer and TransformerEngine quantizers are aligned to the same MXFP8 and NVFP4 bit-level contract. FlashInfer unit tests check exact byte-level agreement against a TransformerEngine-style reference across random data, quantization-boundary data, all-zero tensors, and maximum-value tensors, corresponding to `init_data = ["random", "boundary", "zeros", "maxes"]`. This quantizer alignment was implemented and upstreamed in flashinfer#3387.

> **译：** FlashInfer 与 TransformerEngine 量化器对齐到同一份 MXFP8 与 NVFP4 逐位契约。FlashInfer 单元测试在随机数据、量化边界数据、全零张量和最大值张量上，对照 TransformerEngine 风格的参考实现检查逐字节一致性，对应 `init_data = ["random", "boundary", "zeros", "maxes"]`。该量化器对齐在 flashinfer#3387 中实现并上游。

There is one practical distinction between serving and RL. For serving-only workloads, FlashInfer may use fast math in parts of the FP4 quantization path for performance. This is a reasonable serving default, but RL weight updates benefit from exact agreement with the training-side quantizer. For this recipe:

> **译：** serving 与 RL 之间有一个实际区别。对于纯 serving 工作负载，FlashInfer 可能在 FP4 量化路径的部分环节使用 fast math 以提升性能。这是合理的 serving 默认，但 RL 权重更新受益于与训练侧量化器的精确一致。对于本配方：

```text title="禁用 FlashInfer FP4 fast math"
FLASHINFER_DISABLE_FP4_QUANT_FAST_MATH=1
```

Every backend that touches rollout weights should either implement this quantization contract exactly or make approximate behavior opt-in.

> **译：** 每个触及 rollout 权重的后端都应要么精确实现该量化契约，要么将近似行为设为 opt-in。

## Fine-Grained Precision Control

In practice, a single global precision switch is insufficient for low-precision RL. Some tensors should remain in BF16, but selecting them is only part of the problem: the same decision must be enforced across Hugging Face checkpoint conversion, Megatron training, SGLang rollout, and live weight export.

> **译：** 实践中，单一全局精度开关对低精度 RL 是不够的。某些张量应保持 BF16，但选定它们只是问题的一部分：同一决策必须在 Hugging Face checkpoint 转换、Megatron 训练、SGLang rollout 和在线权重导出间一致执行。

Tensor-level precision control was implemented in Miles through count-based and name-based BF16 exceptions across checkpoint conversion, training, rollout, and live export (miles#614, miles#1054, and miles#1261). SGLang support for the resulting mixed-precision checkpoints was also implemented (sglang#18742 and sglang#20214). Concretely, conversion uses `--num-layers-at-start-in-bf16` and `--num-layers-at-end-in-bf16`; Megatron training combines those counts with `--first-last-layers-bf16`; and SGLang serves the resulting mixed-precision checkpoints.

> **译：** Miles 通过跨 checkpoint 转换、训练、rollout 和在线导出的基于计数与基于名称的 BF16 例外，实现了张量级精度控制（miles#614、miles#1054 和 miles#1261）。SGLang 对所得混合精度 checkpoint 的支持也已实现（sglang#18742 和 sglang#20214）。具体而言，转换使用 `--num-layers-at-start-in-bf16` 和 `--num-layers-at-end-in-bf16`；Megatron 训练将这些计数与 `--first-last-layers-bf16` 结合；SGLang 则 serving 所得的混合精度 checkpoint。

### Layer Precision Choices

As recommended in the NVIDIA NVFP4 pretraining paper, a small fraction of final layers are kept in higher precision. In experiments, keeping the last 15% of layers in BF16 meaningfully reduces train-inference mismatch and stabilizes gradients.

> **译：** 如 NVIDIA NVFP4 预训练论文所建议，最后一小部分层保持更高精度。实验中，将最后 15% 的层保持 BF16 能显著降低训练-推理不匹配并稳定梯度。

![Effect of keeping final layers in BF16](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/mxfp8-last-2-4-8.png)

Turning on BF16 for early layers does not lead to meaningful train-inference mismatch reduction:

> **译：** 对早期层开启 BF16 不会带来有意义的训练-推理不匹配降低：

![First-layer BF16 versus last-layer BF16](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/mxfp8-f1l6-vs-l6.png)

Keeping shared experts in high precision also reduces train-inference mismatch with little performance or memory overhead. Routed experts are selected sparsely, and their outputs pass through a high-precision weighted reduction. Shared experts are always active, so their precision errors affect every token passing through the block.

> **译：** 将共享专家保持高精度也能降低训练-推理不匹配，且几乎无性能或显存开销。路由专家被稀疏选中，其输出经过高精度加权归约。共享专家始终激活，因此其精度误差影响流经该块的每个 token。

![Shared expert high-precision ablation](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/mxfp8-se.png)

#### Case Study: MXFP8 MLA

For MLA models, `kv_b_proj` is an important MXFP8 case. Absorbed and non-absorbed MLA modes can use different contraction axes, while MXFP8 uses one-dimensional microscaling blocks. Changing the contraction axis can therefore change which elements share a scale. The same concern applies to other one-dimensional formats, including NVFP4. The original DeepSeek-V3 FP8 recipe does not have this exact weight-side issue because it uses 128x128 weight-scale blocks rather than one-dimensional blocks. These projection tensors are kept in BF16 to avoid hidden requantization and preserve train-inference consistency.

> **译：** 对于 MLA 模型，`kv_b_proj` 是一个重要的 MXFP8 案例。吸收与非吸收 MLA 模式可能使用不同的收缩轴，而 MXFP8 使用一维 microscaling 块。因此改变收缩轴会改变哪些元素共享缩放。同一问题也适用于其他一维格式，包括 NVFP4。原始 DeepSeek-V3 FP8 配方没有这个确切的权重侧问题，因为它使用 128x128 权重缩放块而非一维块。这些投影张量保持 BF16，以避免隐藏的再量化并保持训练-推理一致性。

```yaml title="MLA kv_b_proj BF16 例外配置"
configs:
  bf16:
    transformer_engine_config_type: "TEQuantizationParams"
    training_recipe: {}
matchers:
  mla_kv_up_proj_bf16:
    type: "glob"
    enabled: true
    pattern: "*.self_attention.linear_kv_up_proj"
    config: "bf16"
  absorbed_k_up_proj_bf16:
    type: "glob"
    enabled: true
    pattern: "*.self_attention.linear_k_up_proj"
    config: "bf16"
  absorbed_v_up_proj_bf16:
    type: "glob"
    enabled: true
    pattern: "*.self_attention.linear_v_up_proj"
    config: "bf16"
```

The matching name-based conversion-time and rollout-time arguments are:

> **译：** 匹配的、基于名称的转换时与 rollout 时参数为：

```text title="MLA 高精度层参数"
--extra-high-precision-layers-hf .kv_b_proj.
--extra-high-precision-layers-megatron .linear_kv_up_proj .linear_k_up_proj .linear_v_up_proj
```

For DeepSeek-V3-style MLA, this BF16 exception is small. A `kv_b_proj` tensor of shape `32768 x 512`, stored in BF16 across 61 layers, occupies about 1.90625 GB.

> **译：** 对于 DeepSeek-V3 风格的 MLA，这一 BF16 例外规模很小。一个形状为 `32768 x 512` 的 `kv_b_proj` 张量，跨 61 层以 BF16 存储，约占 1.90625 GB。

## Results: Qwen3-30B-A3B Recipe Ablation on 8x B200

For consistent comparison, all experiments use synchronous Qwen3-30B-A3B RL with the default Miles setup on 8x B200. The fixed workload uses GRPO-style training on `dapo-math-17k`, with 8 rollout samples per prompt and a maximum response length of 8192 tokens. This is only a recipe ablation setup, not a fully tuned training or serving benchmark. The KL path is enabled for diagnostics, but its coefficient is 0.0, so KL is not an optimization penalty in this ablation.

> **译：** 为一致比较，所有实验使用 8x B200 上默认 Miles 设置的同步 Qwen3-30B-A3B RL。固定工作负载在 `dapo-math-17k` 上做 GRPO 风格训练，每个 prompt 8 个 rollout 样本，最大响应长度 8192 token。这仅是配方消融设置，非充分调优的训练或 serving 基准。KL 路径为诊断启用，但其系数为 0.0，因此 KL 在本消融中不是优化惩罚项。

The hardware split is 4 GPUs for rollout and 4 GPUs for training.

> **译：** 硬件划分为 4 个 GPU 用于 rollout，4 个 GPU 用于训练。

For all low-precision recipes:

> **译：** 对所有低精度配方：

- MoE rollout-routing replay is enabled.
- The last 15% of layers are kept in BF16.
- Low-precision weights use 0 weight decay for stability.
- SGLang rollout uses BF16 KV cache and the FlashInfer TRTLLM routed MoE backend for the low-precision MoE path.

> **译：**
>
> - 启用 MoE rollout-routing replay。
> - 最后 15% 的层保持 BF16。
> - 低精度权重使用 0 weight decay 以保持稳定。
> - SGLang rollout 使用 BF16 KV cache，并对低精度 MoE 路径使用 FlashInfer TRTLLM routed MoE 后端。

Six configurations are compared:

> **译：** 比较六种配置：

1. BF16 training + BF16 rollout.
2. End-to-end MXFP8 training + MXFP8 rollout.
3. MXFP8 rollout and forward with high-precision backward.
4. MXFP8 rollout and forward with dequantized backward.
5. Per-token NVFP4 MoE rollout and forward with high-precision backward.
6. Per-token NVFP4 MoE rollout and forward with dequantized backward.

> **译：**
>
> 1. BF16 训练 + BF16 rollout。
> 2. 端到端 MXFP8 训练 + MXFP8 rollout。
> 3. MXFP8 rollout 与前向 + 高精度反向。
> 4. MXFP8 rollout 与前向 + 反量化反向。
> 5. per-token NVFP4 MoE rollout 与前向 + 高精度反向。
> 6. per-token NVFP4 MoE rollout 与前向 + 反量化反向。

### Train-inference mismatch

As expected, both low-precision formats show higher train-inference mismatch than BF16, while the two backward choices behave similarly within each format. The values remain in a reasonable range for this ablation.

> **译：** 如预期，两种低精度格式的训练-推理不匹配都高于 BF16，而每种格式内两种反向选择表现相似。数值在本消融的合理范围内。

![Train-rollout logprob difference across backward modes](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/hp-logprob.png)

![KL loss comparison across backward modes](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/hp-kl.png)

NVFP4 begins with a higher reference KL than BF16 or MXFP8. Miles computes this diagnostic against a Megatron BF16 reference model, so the metric includes the difference between each low-precision policy and the BF16 reference in addition to policy evolution during RL. It should not be read as a standalone optimization penalty.

> **译：** NVFP4 起始的 reference KL 高于 BF16 或 MXFP8。Miles 对照 Megatron BF16 参考模型计算该诊断，因此该指标既包含每个低精度策略与 BF16 参考的差异，也包含 RL 过程中的策略演化。不应将其当作独立的优化惩罚来解读。

### Reward

Despite the higher diagnostic mismatch, all five low-precision reward curves closely track the BF16 reward curve.

> **译：** 尽管诊断不匹配更高，全部五条低精度 reward 曲线仍紧密贴合 BF16 reward 曲线。

![Raw reward comparison across backward modes](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/hp-raw-reward.png)

This is the key result of the recipe ablation: in this Qwen3-30B-A3B B200 setup, Blackwell-native low precision preserves the observed learning curve while improving rollout efficiency.

> **译：** 这是本配方消融的关键结果：在此 Qwen3-30B-A3B B200 设置下，Blackwell 原生低精度在保持观测到的学习曲线的同时提升了 rollout 效率。

### Performance

MXFP8 and NVFP4 both reduce rollout time compared with BF16:

> **译：** 与 BF16 相比，MXFP8 和 NVFP4 都缩短了 rollout 时间：

![Rollout time comparison across backward modes](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/hp-rollout-time.png)

For NVFP4 rollout, FlashInfer computes the online per-token FP32 scale directly inside the activation quantization kernel path rather than as a separate preprocessing step. The reported rollout performance therefore includes the cost of online scale computation.

> **译：** 对于 NVFP4 rollout，FlashInfer 直接在激活量化 kernel 路径内部计算在线 per-token FP32 缩放，而非作为单独预处理步骤。因此所报告的 rollout 性能已包含在线缩放计算的开销。

On the training side, the MXFP8 variants are faster than BF16, while the NVFP4 backward-override variants are slower in the implementation measured here:

> **译：** 在训练侧，MXFP8 变体快于 BF16，而 NVFP4 backward-override 变体在此处测量的实现中更慢：

![Training time comparison across backward modes](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/hp-train-time.png)

The training-side gap comes from the implementation used in this ablation, not an inherent FP4 Tensor Core limit. The TransformerEngine path applies per-token FP32 scaling as a separate PyTorch operation (TransformerEngine#2931) instead of a native per-token NVFP4 GEMM path with scaling fused into the kernel epilogue. Fused cuDNN frontend kernels have been implemented and upstreamed (cudnn-frontend#251); TransformerEngine integration remains pending. Dequantized backward adds the dequantization step described above. Because this RL workload is rollout-heavy, the rollout speedup remains meaningful even before the training path is fully accelerated.

> **译：** 训练侧差距来自本消融所用的实现，而非 FP4 Tensor Core 的固有上限。TransformerEngine 路径将 per-token FP32 缩放作为单独的 PyTorch 操作施加（TransformerEngine#2931），而非将缩放融合进 kernel epilogue 的原生 per-token NVFP4 GEMM 路径。融合的 cuDNN frontend kernel 已实现并上游（cudnn-frontend#251）；TransformerEngine 集成仍待完成。反量化反向增加了上述反量化步骤。由于该 RL 工作负载 rollout 密集，即便训练路径尚未充分加速，rollout 加速仍有意义。

Beyond this ablation, humans& uses the same recipe family and components in production for large-scale, long-context, multi-agent asynchronous RL research.

> **译：** 在本消融之外，humans& 在生产中使用同一配方族与组件进行大规模、长上下文、多 agent 的异步 RL 研究。

## Future Work

### Dropping the extra BF16 weight copy

Although rollout and training execute the same low-precision recipe, Megatron still saves an additional BF16 weight copy. This increases memory consumption and limits the practical memory benefit of the low-precision path.

> **译：** 尽管 rollout 与训练执行同一低精度配方，Megatron 仍保存一份额外的 BF16 权重副本。这增加了显存消耗，限制了低精度路径的实际显存收益。

Megatron has `--fp8-param-gather` and `--fp4-param-gather`, but the Blackwell-native path is still maturing. The Megatron-Bridge tracking issue Megatron-Bridge#3801 reflects ongoing work needed for robust low-precision parameter gather. NVFP4 `--fp4-param-gather` does not yet support the 1D 1x16 weight layout used by this recipe.

> **译：** Megatron 有 `--fp8-param-gather` 和 `--fp4-param-gather`，但 Blackwell 原生路径仍在成熟中。Megatron-Bridge 跟踪 issue Megatron-Bridge#3801 反映了实现稳健低精度 parameter gather 所需的 ongoing 工作。NVFP4 `--fp4-param-gather` 尚不支持本配方使用的 1D 1x16 权重布局。

### Occasional gradient spikes

The high-precision-backward NVFP4 variant can still show occasional gradient spikes:

> **译：** 高精度反向的 NVFP4 变体仍可能出现偶发梯度尖峰：

![Occasional NVFP4 gradient spike](/vibe-reading/images/articles/lmsys-official-mxfp8-nvfp4-rl/nvfp4-hp-spike.png)

Dequantized backward reduces the largest spikes in this ablation but does not eliminate them. More advanced techniques, including 4/6 and chain-rule-consistent backward choices, are discussed in the companion humans& post.

> **译：** 反量化反向在本消融中减少了最大尖峰，但未完全消除。更先进的技术，包括 4/6 与 chain-rule-consistent 反向选择，在配套的 humans& 文章中讨论。

### Refactoring the weight-update interface

Low-latency FlashInfer backends often require padding, swizzling, shuffling, and backend-specific weight layouts. Those transformations are natural for serving, but they complicate live RL weight update and RDMA because the training side usually owns a different canonical tensor layout.

> **译：** 低延迟 FlashInfer 后端通常需要 padding、swizzling、shuffling 和后端特定的权重布局。这些转换对 serving 是自然的，但它们使在线 RL 权重更新与 RDMA 复杂化，因为训练侧通常持有不同的规范张量布局。

Work in Miles and SGLang aims to preserve high-performance serving layouts while making each weight transformation explicit, verifiable, and less dependent on backend-private details.

> **译：** Miles 与 SGLang 中的工作旨在保持高性能 serving 布局，同时使每次权重转换显式、可验证，并减少对后端私有细节的依赖。

## Try the NVFP4 Recipe in Miles

The following environment settings reproduce the per-token NVFP4 high-precision-backward setup:

> **译：** 以下环境设置可复现 per-token NVFP4 高精度反向配置：

```text title="NVFP4 高精度反向环境变量"
NVTE_NVFP4_ROW_SCALED_ACTIVATION=1
NVTE_BACKWARD_OVERRIDE=high_precision
NVTE_NVFP4_DISABLE_2D_QUANTIZATION=1
NVTE_NVFP4_DISABLE_RHT=1
NVTE_NVFP4_DISABLE_STOCHASTIC_ROUNDING=1
TRTLLM_DISABLE_FP4_QUANT_FAST_MATH=1
FLASHINFER_DISABLE_FP4_QUANT_FAST_MATH=1
SGLANG_FLASHINFER_NVFP4_PER_TOKEN_ACTIVATION=1
```

Set `NVTE_BACKWARD_OVERRIDE=dequantized` to select the dequantized-backward variant without changing the rest of the recipe.

> **译：** 设置 `NVTE_BACKWARD_OVERRIDE=dequantized` 即可选择反量化反向变体，而无需更改配方其余部分。

For Miles launch scripts, the recipe pairs these environment variables with `--fp4-format e2m1`, `--fp4-recipe nvfp4`, the same BF16 first/last-layer controls used during checkpoint conversion, and the following TransformerEngine precision config:

> **译：** 对于 Miles 启动脚本，该配方将这些环境变量与 `--fp4-format e2m1`、`--fp4-recipe nvfp4`、与 checkpoint 转换时相同的 BF16 首尾层控制，以及以下 TransformerEngine 精度配置配对：

```yaml title="NVFP4 TransformerEngine 精度配置"
configs:
    nvfp4:
        transformer_engine_config_type: "TEQuantizationParams"
        training_recipe:
            fp4_quantization_recipe: "nvfp4"
    bf16:
        transformer_engine_config_type: "TEQuantizationParams"
        training_recipe: {}
matchers:
    routed_experts_fc1_nvfp4:
        type: "glob"
        enabled: true
        pattern: "*.mlp.experts.linear_fc1"
        config: "nvfp4"
    routed_experts_fc2_nvfp4:
        type: "glob"
        enabled: true
        pattern: "*.mlp.experts.linear_fc2"
        config: "nvfp4"
    default_bf16:
        type: "glob"
        enabled: true
        pattern: "*"
        config: "bf16"
```

## Acknowledgements

The recipe design and the majority of the implementation described in this post were done by Ziang Li at humans&.

> **译：** 本文所述配方设计与大部分实现由 humans& 的 Ziang Li 完成。

The following collaborators are thanked for engineering support, integration help, and review:

> **译：** 感谢以下合作者提供的工程支持、集成帮助与 review：

- SGLang team & Miles team.
- NVIDIA DevTech Compute Team (Siyuan Fu, Yigong Qin, Zhongbo Zhu), TransformerEngine Team, and FlashInfer Team.

> **译：**
>
> - SGLang 团队与 Miles 团队。
> - NVIDIA DevTech Compute 团队（Siyuan Fu、Yigong Qin、Zhongbo Zhu）、TransformerEngine 团队与 FlashInfer 团队。

The Cursor team is also thanked for the per-token NVFP4 activation-scaling idea.

> **译：** 同时感谢 Cursor 团队提供 per-token NVFP4 激活缩放的思路。

## 相关阅读

- [Miles v0.1: Production-level Post-training](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/Official/lmsys-official-miles-v0-1) — **同系列·配对原文**·本篇所属 Miles 系列的最新总览，将本篇 MXFP8/NVFP4 配方作为 [9] 引用并纳入"Low-precision Training"一节，可对照低精度配方在完整 RL 循环中的位置
- [FlashInfer: Efficient and Customizable Attention Engine for LLM Inference Serving](/vibe-reading/articles/flashinfer-attention-engine-llm-serving) — **工程依赖**·本篇 bit-exact 量化器契约横跨 TransformerEngine 与 FlashInfer，FlashInfer 侧 kernel 是 rollout 量化路径的执行基础
- [SGLang: Efficient Execution of Structured Language Model Programs](/vibe-reading/articles/sglang-efficient-structured-lm-programs) — **背景知识**·Miles 低精度 RL 配方的 rollout 侧由 SGLang 承载，RadixAttention 与前缀缓存是量化 rollout 的底座
