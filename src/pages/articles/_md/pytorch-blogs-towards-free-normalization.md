---
title: "Towards Free Normalization: Fusing Normalization into GEMM and Attention Kernels"
source:
  type: "article"
  project: "PyTorch"
  url: "https://pytorch.org/blog/towards-free-normalization-fusing-normalization-into-gemm-and-attention-kernels/"
  author: "Jacky (Junqing) Zhou, Hongtao Yu, Jackie (Jiaqi) Xu, Menglu Yu, Ethan Che, Han Xu, Darren Liu, Peng Chen (Dev Infra), Daohang Shi, Max Leung"
  site: "PyTorch Blog"
date: "2026-08-02T15:00:00+08:00"
category: [AI, Infra, Inference, Blogs]
tags: ["Normalization", "Kernel Fusion", "GEMM", "FlashAttention", "RMSNorm", "LayerNorm", "Triton", "GPU", "CUDA", "B200"]
description: "PyTorch 官方博客：通过 Lazy Pre-Norm、Multi-CTA Norm Fusion 等内核融合技术，将 LayerNorm/RMSNorm 融入 GEMM 与 Attention 内核，可隐藏高达 90% 的归一化延迟；FlashNormAttention 在 GDPA 内核上融合多个归一化，实现最高 35% 加速。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Towards Free Normalization: Fusing Normalization into GEMM and Attention Kernels](https://pytorch.org/blog/towards-free-normalization-fusing-normalization-into-gemm-and-attention-kernels/) · **作者** Jacky (Junqing) Zhou 等 · **来源** PyTorch Blog · **原文发布** 2026-07-10 · **中英对照·AI 译** 2026-08-02
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

## TL;DR

In this blog post, we present various novel kernel fusion techniques for common normalization ops like LayerNorm and RMSNorm, which provide significant speedup by reducing the memory-IO overhead of these highly memory-bound kernels. We start with a brief overview of the modeling importance as well as performance challenges of normalization ops common in both LLMs and ads recommendation models, then present the novel strategies in tackling the performance bottlenecks, including Lazy Pre-Norm and Multi-CTA Norm Fusion. We show that such techniques can hide as much as **90%** of a normalization kernel's latency by fusing with GEMMs. In the end, we present the FlashNormAttention algorithm where we apply fusion for multiple normalizations around an attention kernel like GDPA [1], achieving up to 35% kernel speedup.

> **译：** 在这篇博文中，我们介绍了几种针对 LayerNorm、RMSNorm 等常见归一化算子的全新内核融合技术，它们通过降低这些高度访存受限（memory-bound）内核的访存 IO 开销来带来显著加速。我们先简要梳理归一化算子在建模上的重要性，以及它在 LLM 和广告推荐模型中普遍存在的性能挑战；随后提出应对这些性能瓶颈的新策略，包括 Lazy Pre-Norm 和 Multi-CTA Norm Fusion。我们表明，这类技术通过与 GEMM 融合，最多可隐藏归一化内核 **90%** 的延迟。最后，我们提出 FlashNormAttention 算法，在 GDPA [1] 这类 attention 内核周围对多个归一化进行融合，实现最高 35% 的内核加速。

This work is done with primarily two kernel DSLs: [TLX](https://arxiv.org/abs/2605.10905), a set of Triton DSL extensions with lower-level, hardware-aware support for GPU execution control; and [Helion](https://pytorch.org/blog/helion/), a high-level DSL that excels at developer velocity, portability, and comprehensive autotuning. Benchmarks are performed with data type bfloat16, on NVIDIA B200 GPUs in Meta's data centers with a 750 W power cap.

> **译：** 这项工作主要使用两种内核 DSL 完成：[TLX](https://arxiv.org/abs/2605.10905)——一组 Triton DSL 扩展，提供更底层、硬件感知的 GPU 执行控制支持；以及 [Helion](https://pytorch.org/blog/helion/)——一种高层 DSL，在开发效率、可移植性和全面的自动调优（autotuning）方面表现出色。基准测试使用 bfloat16 数据类型，在 Meta 数据中心 750 W 功耗封顶的 NVIDIA B200 GPU 上进行。

Code available at: [https://github.com/facebookresearch/ads_model_kernel_library/tree/main/multi_cta_norm_fusion](https://github.com/facebookresearch/ads_model_kernel_library/tree/main/multi_cta_norm_fusion) and [https://github.com/facebookresearch/ads_model_kernel_library/tree/main/gdpa_megakernel](https://github.com/facebookresearch/ads_model_kernel_library/tree/main/gdpa_megakernel)

> **译：** 代码地址：[https://github.com/facebookresearch/ads_model_kernel_library/tree/main/multi_cta_norm_fusion](https://github.com/facebookresearch/ads_model_kernel_library/tree/main/multi_cta_norm_fusion) 和 [https://github.com/facebookresearch/ads_model_kernel_library/tree/main/gdpa_megakernel](https://github.com/facebookresearch/ads_model_kernel_library/tree/main/gdpa_megakernel)

## Introduction

Normalization techniques have become indispensable in most deep learning architectures due to their excellent effectiveness in stabilizing training and accelerating convergence. In particular, traditional normalization across the innermost embedding dimension (e.g. LayerNorm, RMSNorm) has been the most common and ubiquitous type in modern Large Language Models as well as recsys models like Meta's ads models. For example, in the [Kunlun](https://arxiv.org/abs/2602.10016) [2] architecture deployed on Meta's largest Recsys training foundation model, the [Generative Ads Model (GEM)](https://engineering.fb.com/2025/11/10/ml-applications/metas-generative-ads-model-gem-the-central-brain-accelerating-ads-recommendation-ai-innovation/) [3], LayerNorm/RMSNorm exists in nearly all key components, such as Multi-Head Attention, Hierarchical Seed Pooling, and GDPA-enhanced [1] PFFN.

> **译：** 归一化技术因其稳定训练、加速收敛的出色效果，已成为大多数深度学习架构中不可或缺的一环。尤其是沿最内层 embedding 维度做归一化的传统做法（如 LayerNorm、RMSNorm），是现代大语言模型以及 Meta 广告模型这类推荐系统模型中最常见、最普遍的形式。例如，在部署于 Meta 最大推荐系统训练基础模型——[Generative Ads Model (GEM)](https://engineering.fb.com/2025/11/10/ml-applications/metas-generative-ads-model-gem-the-central-brain-accelerating-ads-recommendation-ai-innovation/) [3]——的 [Kunlun](https://arxiv.org/abs/2602.10016) [2] 架构中，LayerNorm/RMSNorm 几乎存在于所有关键组件里，如 Multi-Head Attention、Hierarchical Seed Pooling 以及 GDPA 增强 [1] 的 PFFN。

However, the ubiquity of normalization also brings a difficult performance challenge: it's highly memory-bound with no TensorCore utilization. This hinders us from saturating hardware compute capabilities in model training. Using Kunlun [2] as an example, normalization takes up roughly 20% of the total training latency there. This means we immediately lose 20% of our hardware's compute throughput without optimization. In a typical LLM which is more compute-bound, normalization could still take roughly 10% of total latency.

> **译：** 然而，归一化的普遍性也带来了一个棘手的性能挑战：它高度访存受限，且不利用 TensorCore。这妨碍我们在模型训练中打满硬件算力。以 Kunlun [2] 为例，归一化大约占其总训练延迟的 20%。这意味着不做优化的话，我们直接就损失了 20% 的硬件算力吞吐。在更偏计算受限（compute-bound）的典型 LLM 中，归一化仍可能占总延迟约 10%。

To address this, we must design our normalization kernels in an IO-aware way, carefully saving memory IO costs without compromising computation accuracy via kernel fusion, and also overlapping these memory-/CUDACore-heavy ops with TensorCore-intensive ops. Since most normalization operations follow or precede matmul operations (e.g. MLP, Attention), our work focuses on how to efficiently fuse norms with matmuls. We start by describing multiple strategies in efficiently fusing norms with single GEMMs, and in the end present the FlashNormAttention algorithm, fusing both a LayerNorm and an RMSNorm into attention.

> **译：** 为此，我们必须以 IO 感知的方式设计归一化内核，通过内核融合在不牺牲计算精度的前提下仔细节省访存 IO 开销，同时把这些访存/CUDA Core 负载重的算子与 TensorCore 密集型算子重叠起来。由于大多数归一化操作都紧跟在 matmul 操作前后（如 MLP、Attention），我们的工作聚焦于如何高效地将归一化与 matmul 融合。我们先描述多种将归一化与单个 GEMM 高效融合的策略，最后提出 FlashNormAttention 算法，把一个 LayerNorm 和一个 RMSNorm 都融合进 attention。

**Note**: In the following benchmark results, we disable [elementwise affines](https://docs.pytorch.org/docs/2.12/generated/torch.nn.LayerNorm.html) unless otherwise specified, as we find those to incur significant performance overhead with marginal model quality effects in our models. Also, unless otherwise specified, the core optimization and algorithmic ideas presented are applicable regardless of whether elementwise affines exist, although the performance results may differ.

> **译：** **注**：在以下基准结果中，除非特别说明，我们都关闭了 [elementwise affines](https://docs.pytorch.org/docs/2.12/generated/torch.nn.LayerNorm.html)，因为我们发现在我们的模型里它带来显著性能开销，但对模型质量的影响微乎其微。另外，除非特别说明，文中介绍的核心优化与算法思想无论是否存在 elementwise affines 都适用，只是性能结果可能不同。

## 1. Challenges of Normalization Fusion

**Overview:** In this section we discuss the challenges of fusing normalization with compute-intensive kernels like GEMMs in the typical way, which fundamentally stem from different tiling strategies. We then present a "naive" fusion solution that forces the GEMM algorithm to obey the same tiling as the normalization algorithm, and observe that it performs well for super small N, but becomes suboptimal or even infeasible as N increases due to tiling constraints and inefficiencies.

> **译：****概述：** 本节讨论以常规方式将归一化与 GEMM 等计算密集型内核融合时所面临的挑战，这些挑战根本上源于两者分块（tiling）策略的不同。随后我们提出一个"朴素"融合方案，强制 GEMM 算法服从归一化算法的分块方式，并观察到当 N 很小时它表现不错，但随着 N 增大，由于分块约束和效率低下，会变得次优甚至不可行。

Compared with standard activation fusion (e.g. GEMM+ReLU), the fundamental challenge with normalization fusion is the difference in tiling. Normalization is by nature a reduction operation that requires access to data along an entire dimension to compute the correct result. In particular, for LayerNorm and RMSNorm, a typical kernel tiles the input along the outer dimension(s), but not the inner, meaning each CTA always needs to load entire rows of data. By comparison, a typical GEMM is tiled in both dimensions, meaning each tile does not span an entire row, making a following row-wise normalization impossible.

> **译：** 与标准激活融合（如 GEMM+ReLU）相比，归一化融合的根本挑战在于分块方式不同。归一化本质上是一个归约（reduction）操作，需要访问沿整个维度的数据才能算出正确结果。具体而言，对于 LayerNorm 和 RMSNorm，典型内核沿外层维度分块输入，但不分块内层，意味着每个 CTA 都需要加载整行数据。相比之下，典型 GEMM 在两个维度上都分块，意味着每个 tile 并不跨越整行，这使得其后紧跟的按行归一化无法进行。

![Figure 1: Normalization vs GEMM tiling — normalization reduces across full rows while GEMM tiles don't span entire rows](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-1.png)

> **译：** 图 1：归一化与 GEMM 的分块对比——归一化沿整行归约，而 GEMM 的 tile 不跨越整行。

The most straightforward workaround for this would be to stretch the tile size of the GEMM so that each tile spans the entire inner dimension. For a typical (MxK) @ (KxN) GEMM, this means that the tile size along the N dimension must be larger than N (usually the next power of 2 from N). The high-level algorithm is illustrated in the following diagram:

> **译：** 最直接的变通办法是拉伸 GEMM 的 tile 大小，使每个 tile 覆盖整个内层维度。对于一个典型的 (MxK) @ (KxN) GEMM，这意味着沿 N 维度的 tile 大小必须大于 N（通常取大于 N 的下一个 2 的幂）。其高层算法如下图所示：

![Figure 2: Naive fusion algorithm — GEMM tile size stretched to span the entire inner dimension N](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-2.png)

> **译：** 图 2：朴素融合算法——GEMM 的 tile 大小被拉伸到覆盖整个内层维度 N。

There are two primary issues with this approach:

> **译：** 这种做法有两个主要问题：

- It deviates from the would-be optimal tiling strategy for a pure GEMM, which would degrade the performance of the GEMM itself due to suboptimal cache behavior, pipelining behavior, etc.
- It places a hard limit on the input shapes; specifically, on how large N could be. Too large an N would not be able to fit into shared memory.

> **译：**
> - 它偏离了纯 GEMM 本该采用的最优分块策略，会因次优的缓存行为、流水线行为等损害 GEMM 自身的性能。
> - 它对输入形状施加了硬性上限；具体来说就是 N 能有多大。N 太大就无法装进共享内存（shared memory）。

Here's some napkin math to get a sense of how large N can be. Assume a Blackwell GPU with 228KB shared memory size, a dtype of bfloat16, and a minimum number of 2 pipelining stages for efficient pipelining/overlap. Further assume a minimum tile size of 32 for M dimension and 32 for K dimensions. Then we have:

> **译：** 下面做点粗略估算，感受 N 能到多大。假设 Blackwell GPU 有 228KB 共享内存，dtype 为 bfloat16，最少 2 个流水线 stage 以实现高效流水线/重叠。再假设 M 维和 K 维的最小 tile 大小为 32。则有：

```text title="共享内存容量约束估算"
2 stages x 2 bytes / element x (tile_m x tile_k + tile_k x tile_n + tile_m x tile_n) < 228KB
=> 32 x 32 + 32 x tile_n + 32 x tile_n < 228KB / 4
=> 512 < tile_n < 1024
```

Since tile size should usually be a power of 2, this restricts tile_n, and therefore N, to being at most 512 for this kernel to even be able to run.

> **译：** 由于 tile 大小通常应是 2 的幂，这就把 tile_n，进而把 N，限制在最多 512，该内核才能跑得起来。

We will discuss ways to work around these limitations in the following sections. But despite them, we've found that such fusion strategies can still produce significant gains for small values of N. For this experiment, we used [Helion](https://pytorch.org/blog/helion/) because of its high developer efficiency and exhaustive autotuning which helps in uncanonical cases like this where one of the tile sizes is hard-constrained.

> **译：** 我们将在后续章节讨论绕过这些限制的方法。但尽管有这些限制，我们发现这类融合策略在 N 较小时仍能带来可观收益。本实验中我们使用 [Helion](https://pytorch.org/blog/helion/)，因为其开发效率高且自动调优全面，在像这种某个 tile 大小被硬性约束的非标准场景下很有帮助。

Below are the benchmark results on the typical input shapes observed in ads models. Note that the latency saving is calculated as the percentage of the torch inductor's normalization kernel's latency. We do this so that the metric becomes independent of the latency of the base GEMM kernel (and how it compares to that of the normalization kernel), and inherently captures the headroom of fusion attempts of this sort (i.e. 100% is the best we could do and would require completely overlapping the normalization with the GEMM).

> **译：** 下面是广告模型中典型输入形状下的基准结果。注意，延迟节省按 torch inductor 的归一化内核延迟的百分比来计算。我们这样做是为了让该指标与基础 GEMM 内核的延迟（以及它与归一化内核延迟的对比）无关，从本质上反映这类融合尝试的优化空间（即 100% 是我们能达到的最好情况，需要把归一化与 GEMM 完全重叠）。

![Figure 3: Naive fusion benchmark — latency saving (%) of the normalization kernel on typical ads model shapes](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-3.png)

> **译：** 图 3：朴素融合基准——在广告模型典型形状下归一化内核的延迟节省（%）。

For small shapes like 64 and 128, this fusion strategy can yield a significant 17%-32% latency saving for the LayerNorm kernel. However, as K/N grows larger beyond 128, the gain starts disappearing and even turns into huge regression. This is because as N grows, the enforcement that tile_n = N becomes a larger deviation from the would-be optimal tile size for an unfused GEMM kernel, and the benefit of saving memory IO gradually becomes overshadowed by the harm of distorting the base GEMM algorithm.

> **译：** 对于 64、128 这样的小形状，该融合策略能给 LayerNorm 内核带来 17%–32% 的可观延迟节省。但随着 K/N 增大超过 128，收益开始消失，甚至变成大幅退化。这是因为随着 N 增大，强制 tile_n = N 相对未融合 GEMM 内核本该的最优 tile 大小偏离越来越大，节省访存 IO 的收益逐渐被扭曲基础 GEMM 算法带来的损害所盖过。

## 2. Lazy Pre-Norm: A Novel Technique of Fusing Pre-Norm with Linear Layers

**Overview:** In this section we introduce a novel prologue fusion technique for fusing pre-RMSNorm into a GEMM kernel. We discuss the motivations as well as challenges of such prologue fusion, and present a novel algorithm named **Lazy Pre-Norm** that tackles these challenges via strategically delaying part of the pre-norm computation until after completing the GEMM using a mathematical trick, and yields good performance speedup.

> **译：****概述：** 本节介绍一种新的 prologue 融合技术，把 pre-RMSNorm 融合进 GEMM 内核。我们讨论这种 prologue 融合的动机与挑战，并提出了一个名为 **Lazy Pre-Norm** 的新算法，它通过一个数学技巧策略性地把一部分 pre-norm 计算延迟到 GEMM 完成之后，从而解决这些挑战，并带来不错的性能加速。

The first idea we present gets around the aforementioned issue by fusing pre-norms with following GEMMs, as a prologue fusion. Although prologue fusion should generally be avoided, there are a few reasons it's still worth exploring:

> **译：** 我们提出的第一个思路，是通过把 pre-norm 与后续 GEMM 融合（作为 prologue 融合）来绕过前述问题。虽然一般应避免 prologue 融合，但仍有几个值得探索的理由：

1. Prologue fusion bypasses the tiling issue encountered in epilogue fusion, where each CTA in a GEMM kernel doesn't have access to entire rows of the output tensor. In contrast, each CTA does scan through entire rows of the input tensor A just by the algorithm!
1. Realistically, pre-norm has become much more prevalent in post-norm, especially in Large Language Models.

> **译：**
> 1. Prologue 融合绕过了 epilogue 融合中遇到的分块问题——在 epilogue 融合中，GEMM 内核里每个 CTA 无法访问输出张量的整行。相比之下，每个 CTA 本来就会沿输入张量 A 的整行扫描！
> 2. 实际上，pre-norm 已经比 post-norm 普遍得多，尤其是在大语言模型中。

For prologue fusion to work well, we devised an optimization technique called **Lazy Pre-Norm** for a special case of pre-norm: RMSNorm without elementwise affines. Specifically we are looking to fuse:
`C = rmsnorm(A) @ B`

> **译：** 为让 prologue 融合工作良好，我们为 pre-norm 的一种特例——不带 elementwise affines 的 RMSNorm——设计了一种名为 **Lazy Pre-Norm** 的优化技术。具体我们要融合：
> `C = rmsnorm(A) @ B`

`where rmsnorm(A) = A * rstd(A)[:, None]`
`and rstd(A) = rsqrt((A ** 2).sum(dim=-1) / A.shape[-1] + 1e-5)`

> **译：** `其中 rmsnorm(A) = A * rstd(A)[:, None]`
> `且 rstd(A) = rsqrt((A ** 2).sum(dim=-1) / A.shape[-1] + 1e-5)`

Here's the key difficulty of this fusion that Lazy Pre-Norm aims to resolve: in a typical tiled GEMM, although we eventually have access to entire rows (which is what allows us to compute the reduction result rstd), we access them tile by tile, and we actually need rstd in order to process each tile! This creates a cyclic dependency: we need to wait until the end of the k-loop to be able to compute rstd, but we need rstd to even start working on the loop!

> **译：** 这里是这个融合的关键难点，也是 Lazy Pre-Norm 要解决的：在典型的分块 GEMM 中，尽管我们最终能访问到整行（这让我们能算出归约结果 rstd），但我们是逐 tile 访问的，而处理每个 tile 又需要 rstd！这就形成了循环依赖：要等 k-loop 结束才能算 rstd，但要开始处理这个 loop 又需要 rstd！

To resolve this, the first key observation here is that the two inter-dependent parts are in essence different types of computation: reduction and elementwise application.

> **译：** 为解决它，第一个关键观察是：这两个相互依赖的部分本质上是不同类型的计算——归约和逐元素应用。

1. The rstd computation part is a **reduction** over the entire rows.
1. Using rstd to apply normalization is an **elementwise** computation on each individual element of A

> **译：**
> 1. rstd 的计算部分是对整行的**归约**。
> 1. 用 rstd 应用归一化是对 A 中每个元素的**逐元素**计算。

Let's tackle these two components separately. For the reduction part, the first thing to notice is that it's not blocking anything itself, which is a nice property because it means we can compute it in parallel to the TensorCore computation. Since each CTA naturally scans along the inner dimension of A, we can just accumulate the square sum of A alongside, and in parallel to, the matmuls.

> **译：** 让我们分别处理这两个部分。对于归约部分，首先要注意它本身并不阻塞任何东西，这是个好性质，意味着我们可以让它与 TensorCore 计算并行。由于每个 CTA 天然沿 A 的内层维度扫描，我们可以在 matmul 的同时、与之并行地累加 A 的平方和。

The elementwise part is more problematic as it depends on the result of the reduction, which causes cyclical dependency. The rescue here is a mathematical trick based on the key observation that the elementwise multiplication in an affine-free RMSNorm is actually **row-wise multiplication**, where all elements in the same row of A are multiplied by the same rstd. This implies the following key property:

> **译：** 逐元素部分更麻烦，因为它依赖归约的结果，从而造成循环依赖。这里的救命稻草是一个数学技巧，基于一个关键观察：无 affine 的 RMSNorm 中的逐元素乘法实际上是**按行乘法**——A 同一行的所有元素都乘以同一个 rstd。由此可推出以下关键性质：

`(A * rstd[:, None]) @ B = (A @ B) * rstd[:, None]`

> **译：** `(A * rstd[:, None]) @ B = (A @ B) * rstd[:, None]`

`Proof:`
`Row-wise multiplication is equivalent to M @ A where for some diagonal matrix M. So we have (A * rstd) @ B = (M @ A) @ B = M @ (A @ B) = (A @ B) * rstd`

> **译：** `证明：`
> `按行乘法等价于 M @ A（M 为某个对角矩阵）。故 (A * rstd) @ B = (M @ A) @ B = M @ (A @ B) = (A @ B) * rstd`

This is great because it means the elementwise computation can be "lazily computed" and delayed until after the whole k-loop is done, and effectively becomes an epilogue! Putting it all together, below is the kernel pseudocode for the Lazy Pre-Norm algorithm:

> **译：** 这太棒了，因为它意味着逐元素计算可以被"惰性计算"，延迟到整个 k-loop 完成之后，实际上变成了一个 epilogue！综合起来，下面是 Lazy Pre-Norm 算法的内核伪代码：

```text title="Lazy Pre-Norm 内核伪代码"
def GEMM_norm_fusion_kernel(A, B, C):
	compute the m_tile and n_tile of this CTA
	square_sum = zeros(m_tile)
	acc = zeros(m_tile, n_tile)
	for each k_tile:
		tile_A = A[m_tile][k_tile]
		tile_B = B[k_tile][n_tile]
		acc += tile_A @ tile_B
		square_sum += (tile_A * tile_A).sum(-1) # computed in parallel to the GEMM!
	rstd = rsqrt(square_sum / A.shape[-1] + 1e-5)
	acc *= rstd[:, None]
	C[m_tile][n_tile] = acc
```

Note that while some additional computation is still incurred in each k iteration, it can be overlapped with the matmul computation. With warp specialization, the kernel's warp partitioning and execution would look like:

> **译：** 注意，虽然每个 k 迭代仍会引入一些额外计算，但它可以与 matmul 计算重叠。在 warp specialization 下，内核的 warp 划分与执行如下图：

![Figure 4: Lazy Pre-Norm warp specialization execution pipeline](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-4.png)

> **译：** 图 4：Lazy Pre-Norm 的 warp specialization 执行流水线。

Notice that this algorithm still features a key disadvantage of prologue fusion: the RMSNorm computation is redundantly done across many CTAs (think about all CTAs computing the same rows but different columns of the output tensor; more on this in Section 3). However, since Lazy Pre-Norm makes sure that most of this computation is fully overlapped with TensorCore, the redundancy is acceptable and still yields good performance gains.

> **译：** 注意，该算法仍带有 prologue 融合的一个关键缺点：RMSNorm 计算在多个 CTA 间冗余进行（想想所有计算输出张量相同行但不同列的 CTA；第 3 节详述）。不过，由于 Lazy Pre-Norm 确保了这部分计算绝大部分与 TensorCore 完全重叠，冗余是可以接受的，仍能带来不错的性能收益。

![Figure 5: Lazy Pre-Norm performance benchmark results](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-5.png)

> **译：** 图 5：Lazy Pre-Norm 性能基准结果。

A few limitations to note about the Lazy Pre-Norm algorithm:

> **译：** 关于 Lazy Pre-Norm 算法，有几个局限需要注意：

1. It cannot easily support elementwise affines, which work as a column-wise multiplication. It would break our precondition that the elementwise operation must be a row-wise multiplication.
1. It does not work with LayerNorm, because the elementwise part of LayerNorm involves subtraction and is not a simple row-wise multiplication.
1. The backward implementation for this fusion would be tricky, because we never materialize rmsnorm(A) anywhere in forward. As such, we'd need to reconstruct rmsnorm(A) from A and rstd on the fly in computing both dA and dB.

> **译：**
> 1. 它无法轻易支持 elementwise affines，因为后者相当于按列乘法，会破坏"逐元素操作必须是按行乘法"的前提条件。
> 1. 它不适用于 LayerNorm，因为 LayerNorm 的逐元素部分涉及减法，不是简单的按行乘法。
> 1. 该融合的 backward 实现会比较棘手，因为 forward 中我们从未物化 rmsnorm(A)。因此计算 dA 和 dB 时需要在现场用 A 和 rstd 重建 rmsnorm(A)。

## 3. Multi-CTA Norm: Fusing Post-Norm with Linears as Epilogue

**Overview:** Despite the good speedup, the Lazy Pre-Norm prologue fusion still has its limitations and cannot be generalized to most norm use cases. In this section we discuss a more general technique for fusing post-norms with GEMMs, and come back to the realm of epilogue fusion, directly tackling the tiling mismatch issue presented in Section 1, using **CTA clusters** and **Distributed Shared Memory**.

> **译：****概述：** 尽管加速不错，Lazy Pre-Norm 的 prologue 融合仍有局限，无法推广到大多数 norm 用例。本节讨论一种更通用的、把 post-norm 与 GEMM 融合的技术，回到 epilogue 融合的路子上，直接用 **CTA clusters** 和 **Distributed Shared Memory** 解决第 1 节提出的分块不匹配问题。

We borrow an idea from [Quack](https://github.com/Dao-AILab/quack/blob/main/media/2025-07-10-membound-sol.md) and extend it beyond standalone norm kernels to the fused kernels. The Quack norm kernels leverage [CTA clusters](https://docs.nvidia.com/cuda/parallel-thread-execution/#cluster-of-cooperative-thread-arrays) to partition large N among different CTAs in the same cluster, and let them collaborate on a single reduction across N by communicating necessary data with each other via **distributed shared memory**. This allows us to have multiple CTAs collaboratively divide and work on the same rows of data, and communicate with each other as needed by normalization, without incurring the cost of global memory IO.

> **译：** 我们借鉴了 [Quack](https://github.com/Dao-AILab/quack/blob/main/media/2025-07-10-membound-sol.md) 的思路，并将其从独立的 norm 内核扩展到融合内核。Quack 的 norm 内核利用 [CTA clusters](https://docs.nvidia.com/cuda/parallel-thread-execution/#cluster-of-cooperative-thread-arrays) 把较大的 N 划分给同一 cluster 内的不同 CTA，让它们通过 **distributed shared memory** 互相通信必要的数据，协作完成一次跨 N 的归约。这让我们能让多个 CTA 协作地分工处理相同行的数据，并按归一化的需要彼此通信，而不产生全局内存 IO 的开销。

![Figure 6: Multi-CTA norm using CTA clusters and distributed shared memory](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-6.png)

> **译：** 图 6：使用 CTA clusters 和 distributed shared memory 的 multi-CTA norm。

As mentioned above, most normalization ops can be decomposed into a reduction part (e.g. rstd for RMSNorm, mean and variance for LayerNorm), and a following elementwise part that utilizes the reduction result. Only the reduction part requires scanning through the entire N dimension, which we divide and conquer within a CTA cluster. Because the reduction result is usually small (because, well, it's a reduction), a quite minimal DSMEM communication overhead is needed to send/receive it to/from other CTAs.

> **译：** 如前所述，大多数归一化算子可分解为一个归约部分（如 RMSNorm 的 rstd，LayerNorm 的均值和方差）和一个利用归约结果的后续逐元素部分。只有归约部分需要扫描整个 N 维度，我们在一个 CTA cluster 内分治它。由于归约结果通常很小（毕竟它是归约），与其他 CTA 收发它所需的 DSMEM 通信开销相当小。

![Figure 7: Multi-CTA norm decomposition — reduction part divided across cluster, elementwise part applied locally](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-7.png)

> **译：** 图 7：multi-CTA norm 的分解——归约部分在 cluster 内分治，逐元素部分在本地应用。

Note that this idea tackles the exact same problem that we are facing with norm fusion – simply that N is too large! (although the reason and threshold for N being too large differ). This means that we can simply take this multi-CTA algorithm and put it in the epilogue of our GEMM, and the fusion is done!

> **译：** 注意，这个思路解决的正是我们在 norm 融合中面临的同一个问题——N 太大！（尽管 N 太大的原因和阈值有所不同）。这意味着我们可以直接把这个 multi-CTA 算法放进 GEMM 的 epilogue，融合就完成了！

```text title="Multi-CTA Norm 融合内核伪代码"
def GEMM_norm_fusion_kernel(A, B, C):
	compute the m_tile and n_tile of this CTA
	acc = zeros(m_tile, n_tile)
	for each k_tile:
		tile_A = A[m_tile][k_tile]
		tile_B = B[k_tile][n_tile]
		acc += tile_A @ tile_B
	acc = multi_cta_norm(acc) # where DSMEM communication happens
	C[m_tile][n_tile] = acc
```

Note that this fusion is by no means free and places a few constraints on the kernel other than introducing DSMEM overhead, which could potentially cause regression on the base GEMM kernel we are fusing norm into:

> **译：** 注意，这种融合绝非免费，除了引入 DSMEM 开销外，还对内核施加了几点约束，可能在我们融合 norm 的基础 GEMM 内核上造成退化：

1. It puts strong restrictions on CTA scheduling. In particular, adjacent CTAs in a cluster must share the same m_tile but different n_tile's.
1. Because of #1, [paired-CTA](https://docs.nvidia.com/cuda/parallel-thread-execution/#tcgen05-cta-pair) matmul is difficult
1. Similarly, because of #1, [tile super-grouping](https://triton-lang.org/main/getting-started/tutorials/03-matrix-multiplication.html#l2-cache-optimizations) [5] cannot be done
1. This still doesn't unlock N from being indefinitely large. We are still bounded by the single-CTA limit (around 512) multiplied by the max cluster size. On Blackwell, the portable max cluster size is [8](https://docs.nvidia.com/cuda/blackwell-tuning-guide/index.html#thread-block-clusters). This limits N to be at most 4096.

> **译：**
> 1. 它对 CTA 调度施加了强限制。特别是，cluster 内相邻的 CTA 必须共享同一个 m_tile，但 n_tile 不同。
> 1. 由于 #1，[paired-CTA](https://docs.nvidia.com/cuda/parallel-thread-execution/#tcgen05-cta-pair) matmul 变得困难。
> 1. 同样由于 #1，[tile super-grouping](https://triton-lang.org/main/getting-started/tutorials/03-matrix-multiplication.html#l2-cache-optimizations) [5] 无法进行。
> 1. 这仍不能让 N 无限大。我们仍受限于单 CTA 上限（约 512）乘以最大 cluster size。在 Blackwell 上，可移植的最大 cluster size 是 [8](https://docs.nvidia.com/cuda/blackwell-tuning-guide/index.html#thread-block-clusters)，这把 N 限制在最多 4096。

Nonetheless, the benefit of saving significant memory IO still far outweighs the limitations. We chose [TLX](https://pytorch.org/blog/enabling-cluster-launch-control-with-tlx/) for this kernel which strikes a good balance between flexibility / dev efficiency and lower-level hardware control, both of which are critical in this case study. We built the fused kernel on top of the [TLX GEMM kernel](https://github.com/facebookexperimental/triton/blob/main/third_party/tlx/tutorials/blackwell_gemm_ws.py) with warp specialization. We benchmarked it against some common shapes in ads modelling (M = 256k, K = O(512), N = O(512)), and achieved the following performance result.

> **译：** 尽管如此，节省可观访存 IO 的收益仍远超这些局限。我们为这个内核选择 [TLX](https://pytorch.org/blog/enabling-cluster-launch-control-with-tlx/)，它在灵活性/开发效率与底层硬件控制之间取得了不错的平衡，这两点在本案例中都至关重要。我们在带 warp specialization 的 [TLX GEMM 内核](https://github.com/facebookexperimental/triton/blob/main/third_party/tlx/tutorials/blackwell_gemm_ws.py)之上构建了融合内核。我们在广告建模的一些常见形状上（M = 256k, K = O(512), N = O(512)）做了基准测试，得到以下性能结果。

![Figure 8: Multi-CTA norm fusion benchmark results](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-8.png)

> **译：** 图 8：multi-CTA norm 融合基准结果。

Note that we capped K and N at 2048, because as they reached 4096, the latency became completely dominated by the GEMM and the normalization takes less than 5% of the total latency.

> **译：** 注意，我们把 K 和 N 上限定在 2048，因为到 4096 时，延迟完全被 GEMM 主导，归一化占总延迟不到 5%。

### What about backward? Fusion regrouping.

**Overview:** In this subsection, we discuss the additional challenge with implementing the same fusion idea for backward: **forward epilogue fusion naturally becomes prologue fusion in backward**. We discuss the key issues with prologue fusion, and present a novel workaround solution which fuses norm with different GEMMs in forward v.s. in backward, **resulting in efficient epilogue fusion in both**.

> **译：****概述：** 本小节讨论在 backward 中实现同样融合思路的额外挑战：**forward 的 epilogue 融合在 backward 中天然变成 prologue 融合**。我们讨论 prologue 融合的关键问题，并提出一种新的变通方案——在 forward 与 backward 中把 norm 与不同的 GEMM 融合，**最终在两者中都实现高效的 epilogue 融合**。

The backward of LayerNorm and RMSNorm also involves reduction, which wouldn't be a big issue as we can resolve it in a similar fashion as in forward. Efficient backward computation would also need the intermediate reduction result stored from forward, which also wouldn't be a big issue since the reduction result is 1-dimensional and results in minimal IO. The real issue is that epilogue fusion in forward becomes prologue fusion in backward.

> **译：** LayerNorm 和 RMSNorm 的 backward 也涉及归约，这不算大问题，因为我们可以用与 forward 类似的方式解决。高效的 backward 计算还需要 forward 中存储的中间归约结果，这也不是大问题，因为归约结果是一维的，IO 很小。真正的问题在于：forward 的 epilogue 融合在 backward 中变成了 prologue 融合。

```text title="forward 与 backward 公式对比"
# forward formula
C = norm(A @ B)

# backward formula
dA = norm_backward(dC) @ B.T
dB = A.T @ norm_backward(dC)
```

Notice how in backward, the norm_backward computation happens before the GEMM, making a potential fusion prologue fusion. We've discussed some general drawbacks of prologue fusion in Section 2, but in this specific case, let's look at a potential prologue fusion solution to understand more why it's an issue.

> **译：** 注意在 backward 中，norm_backward 计算发生在 GEMM 之前，使潜在融合成为 prologue 融合。我们在第 2 节讨论过 prologue 融合的一般缺点，但在这个具体场景下，让我们看一个潜在的 prologue 融合方案，更好理解它为什么是问题。

```text title="backward prologue 融合内核伪代码"
def GEMM_norm_bwd_fusion_kernel(dC, BT, dA):
	compute the m_tile and n_tile of this CTA
	acc = zeros(m_tile, n_tile)
	for each k_tile:
		tile_dC = dC[m_tile][k_tile]
		tile_dC = multi_cta_norm_bwd(tile_dC) # where DSMEM communication happens
		tile_BT = BT[k_tile][n_tile]
		acc += tile_dC @ tile_BT
	dA[m_tile][n_tile] = acc
```

There are several performance issues with this approach:

> **译：** 这种做法有几个性能问题：

1. The norm bwd computation is on the critical path blocking the GEMM computation for every iteration! Compare this to epilogue fusion where a single computation is done at the end of the main loop.
1. Redundant computation is being done for the norm backward. Remember that each row of dC is loaded separately by different CTAs that compute different tiles of dA that share the same m_tile but different n_tile's. Each of those CTAs would need to do the same norm backward computation on the same dC tiles.
1. This fusion kernel only computes dA, but we'd also need to compute dB as well, where we'd compute norm_backward(dC) again, leading to more redundant computation.

> **译：**
> 1. norm bwd 计算在关键路径上，每个迭代都阻塞 GEMM 计算！对比 epilogue 融合只在主循环末尾做一次计算。
> 1. norm backward 存在冗余计算。记住 dC 的每一行被不同 CTA 分别加载——这些 CTA 计算共享同一 m_tile 但 n_tile 不同的 dA tile。每个 CTA 都要对相同 dC tile 做同样的 norm backward 计算。
> 1. 该融合内核只计算 dA，但我们还需要计算 dB，那里又要再算一次 norm_backward(dC)，导致更多冗余计算。

What's the solution here? Well, there isn't much we can do unless it's some specialized cases like the one discussed in Section 2. So just avoid prologue fusion. To do that we have to be a bit more flexible in our fusion strategy: since normalization layers usually stand between linear layers, what if we fuse the normalization op with different linears in forward v.s. in backward?

> **译：** 解决办法是什么？嗯，除非像第 2 节那种特化场景，否则我们能做的不多。那就避免 prologue 融合。为此我们得在融合策略上更灵活一些：既然归一化层通常位于线性层之间，如果我们让归一化算子在 forward 和 backward 中分别与不同的线性层融合呢？

![Figure 9: Fusion regrouping — backward becomes epilogue fusion by fusing norm with a different linear](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-9.png)

> **译：** 图 9：融合重组——通过把 norm 与另一个线性层融合，backward 也变成了 epilogue 融合。

It's easy to see that now backward is also epilogue fusion, and that there's no longer any redundant computation for the norm backward. Also more importantly, the fusion becomes structurally identical to the forward fusion! Just replace `multi_cta_norm` with `multi_cta_norm_bwd` in the forward kernel, and you've got your backward kernel. Below are the benchmark results on the same shapes as forward.

> **译：** 容易看出，现在 backward 也成了 epilogue 融合，且 norm backward 不再有冗余计算。更重要的是，融合在结构上与 forward 融合完全相同！只需把 forward 内核里的 `multi_cta_norm` 换成 `multi_cta_norm_bwd`，就得到了 backward 内核。下面是与 forward 相同形状下的基准结果。

![Figure 10: Backward fusion benchmark results (fusion regrouping)](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-10.png)

> **译：** 图 10：backward 融合基准结果（融合重组）。

Note that for this idea to work, the linears do not have to be linears exactly. For example, in LLM architectures, we might see a pattern like attention -> norm -> linear, or vice versa. These could still adopt the same optimization technique, as long as what sandwiches the norm is compute-intensive ops which are beneficial (and feasible) to fuse norms into.

> **译：** 注意，要让这个思路成立，这些线性层不必非得是严格的线性层。例如在 LLM 架构中，我们可能看到 attention -> norm -> linear，或反过来这样的模式。只要夹住 norm 的是计算密集型算子、且融合 norm 进去有益且可行，它们就能采用同样的优化技术。

The next section discusses an example of fusing norms into attention.

> **译：** 下一节讨论把 norm 融合进 attention 的例子。

## 4. FlashNormAttention: Fusing both Pre-Norm and Post-Norm into FlashAttention-variant kernels

**Overview:** In this section we look at a case study of applying the aforementioned fusion ideas to the [GDPA kernel](https://pytorch.org/blog/generalized-dot-product-attention-tackling-real-world-challenges-in-gpu-training-kernels/) [1], and present the **FlashNormAttention **algorithm. The GDPA kernel is heavily used in Meta ads models and specifically the [Kunlun](https://arxiv.org/abs/2602.10016) [2] architecture, and is a generalized attention kernel redesigned from [FlashAttention](https://github.com/Dao-AILab/flash-attention/tree/main/flash_attn/cute) [6]. As such, most of the optimization ideas discussed below are generalizable to other attention kernels like FlashAttention. The algorithm uses the exact same algorithmic trick as the multi-CTA GEMM+norm fusion from above, but is at a higher level of complexity (attention v.s. GEMM, fusing two norms v.s. one). Many optimization techniques are adopted to make it performant and discussed below, including:

> **译：****概述：** 本节我们把前述融合思路应用到 [GDPA 内核](https://pytorch.org/blog/generalized-dot-product-attention-tackling-real-world-challenges-in-gpu-training-kernels/) [1] 上做一个案例研究，并提出 **FlashNormAttention** 算法。GDPA 内核在 Meta 广告模型尤其是 [Kunlun](https://arxiv.org/abs/2602.10016) [2] 架构中被大量使用，是从 [FlashAttention](https://github.com/Dao-AILab/flash-attention/tree/main/flash_attn/cute) [6] 重新设计的通用 attention 内核。因此，下面讨论的大部分优化思路可推广到 FlashAttention 等其他 attention 内核。该算法使用了与上面 multi-CTA GEMM+norm 融合完全相同的算法技巧，但复杂度更高（attention 对 GEMM，融合两个 norm 对一个）。为使其高效，采用了多种优化技术，下面会讨论，包括：

- SMEM / TMEM reuse to reduce memory pressure
- Register subtiling to reduce register pressure
- Fine-tuned warp specialization to parallelize heavy CUDACore operations
- Norm recomputation in backward to avoid IO costs of saving additional tensors in forward
- Using advanced hardware features like [TMA_REDUCE_ADD](https://github.com/NVIDIA/cutlass/blob/main/include/cute/arch/copy_sm90_tma.hpp#L1278) and TensorCore Accumulate for better pipeline efficiency

> **译：**
> - SMEM / TMEM 复用以降低显存压力
> - 寄存器子分块（register subtiling）以降低寄存器压力
> - 精细调校的 warp specialization 以并行化繁重的 CUDA Core 操作
> - backward 中 norm 重计算以避免 forward 保存额外张量的 IO 开销
> - 使用 [TMA_REDUCE_ADD](https://github.com/NVIDIA/cutlass/blob/main/include/cute/arch/copy_sm90_tma.hpp#L1278) 和 TensorCore Accumulate 等高级硬件特性以提升流水线效率

The typical PFFN block in Kunlun [2] uses a GDPA kernel as the backbone, but also surrounds it with a couple of normalization and residual connections. The diagram below shows how data flows inside a PFFN block.

> **译：** Kunlun [2] 中典型的 PFFN 块以 GDPA 内核为主干，但在其周围还有若干归一化和残差连接。下图展示 PFFN 块内的数据流。

![Figure 11: PFFN block data flow in Kunlun — GDPA kernel surrounded by LayerNorm, RMSNorm and residual connections](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-11.png)

> **译：** 图 11：Kunlun 中 PFFN 块的数据流——GDPA 内核被 LayerNorm、RMSNorm 和残差连接包围。

Notice how IO-heavy this is with reduction and elementwise kernels scattered both before and after the GDPA kernel. Our goal is to fuse all of these operations into one single kernel, that we call the **FlashNormAttention**. This is like a "megakernel" performing all operations in a module, but it differs, in intention and meaning, from the original [megakernel](https://hazyresearch.stanford.edu/blog/2025-05-27-no-bubbles) [7] in that it aims not just to save kernel launch costs, but to **save the total amount of data transfer to/from HBM**, which is usually more of a bottleneck.

> **译：** 注意这有多吃 IO——GDPA 内核前后都散布着归约和逐元素内核。我们的目标是把所有这些操作融合进一个单一内核，称之为 **FlashNormAttention**。这像一个执行模块内所有操作的"megakernel"，但它在意图和含义上不同于最初的 [megakernel](https://hazyresearch.stanford.edu/blog/2025-05-27-no-bubbles) [7]：它的目标不仅是节省内核启动开销，更要**节省与 HBM 之间总的数据搬运量**，后者通常更是瓶颈。

The overall fusion plan here stays the same: leveraging CTA clusters and distributed shared memory to collaboratively compute normalization. Note that the GDPA here is multi-head, and the norms are done across all heads. So even though in the typical GDPA/FA kernel, a single CTA has access to the full head dimension, it still needs data from the other heads for normalization, necessitating the multi-CTA norm algorithm.

> **译：** 这里的整体融合方案不变：利用 CTA clusters 和 distributed shared memory 协作计算归一化。注意此处的 GDPA 是多头（multi-head）的，norm 是跨所有头进行的。所以即使在典型 GDPA/FA 内核中单个 CTA 能访问完整的 head 维度，它仍需要其他头的数据来做归一化，这就需要 multi-CTA norm 算法。

Let's start with the original GDPA kernel algorithm which we describe in pseudocode below. For simplicity only the bare bones relevant to fusion are included. For the detailed, optimized algorithm, refer to the original [GDPA blog](https://pytorch.org/blog/generalized-dot-product-attention-tackling-real-world-challenges-in-gpu-training-kernels/).

> **译：** 让我们从原始 GDPA 内核算法开始，下面用伪代码描述。为简化只包含与融合相关的骨架。详细优化算法请参考原 [GDPA 博客](https://pytorch.org/blog/generalized-dot-product-attention-tackling-real-world-challenges-in-gpu-training-kernels/)。

```text title="原始 GDPA forward 内核伪代码"
# input: Q: [batch_size, seq_len_q, H, head_dim], K/V: [batch_size, seq_len_kv, H, head_dim]
# metaparam: BLOCK_M (tile size of m_tile on seq_len_q), BLOCK_N (tile size of n_tile on seq_len_kv)
# grid on (batch_size, seq_len_q // BLOCK_M, H)
def gdpa_fwd_kernel(Q, K, V, output):
	compute the batch_idx, m_tile and head_idx for this CTA
	q = Q[batch_idx, m_tile, head_idx, :] # [BLOCK_M, head_dim], B and H dimensions are indexed 
	acc = zeros(BLOCK_M, head_dim)
	for n_tile over entire seq_len_kv:
		k = K[batch_idx, n_tile, head_idx, :] # [BLOCK_N, head_dim], B and H dimensions are indexed 
		v = V[batch_idx, n_tile, head_idx, :] # [BLOCK_N, head_dim]
		p = elementwise_activation(q @ k.T) # [BLOCK_M, BLOCK_N]
		acc += p @ v # [BLOCK_M, head_dim]
	output[batch_idx, m_tile, head_idx, :] = acc
```

Even before getting into fusion work, let's start with a key tweak on this algorithm. In Kunlun's [2] use case, we observed that seq_len_q is usually large (O(1k)) while seq_len_kv is usually small (O(128)). This makes the inner loop's pipelining very shallow and exposes prologue and epilogue overhead. To improve the performance for this case, we swap the role of Q and K/V in the kernel, gridding on KV and looping over Q. Notice that this algorithm is only numerically correct when we do not tile on seq_len_kv.

> **译：** 在进入融合工作之前，先对这个算法做一个关键调整。在 Kunlun [2] 的用例中，我们观察到 seq_len_q 通常较大（O(1k)）而 seq_len_kv 通常较小（O(128)）。这使内层循环的流水线很浅，暴露出 prologue 和 epilogue 开销。为改善此情况性能，我们在内核中交换 Q 和 K/V 的角色，grid 在 KV 上、循环遍历 Q。注意该算法仅当我们不对 seq_len_kv 分块时数值上才正确。

```text title="短 KV 场景的 GDPA forward 内核"
# input: Q: [batch_size, seq_len_q, H, head_dim], K/V: [batch_size, seq_len_kv, H, head_dim]
# metaparam: BLOCK_M (tile size of m_tile on seq_len_q)
# grid on (batch_size, H)
def gdpa_fwd_kernel_short_kv(Q, K, V, output):
	compute the batch_idx and head_idx for this CTA
	k = K[batch_idx, :, head_idx, :] # [seq_len_kv, head_dim], B and H dimensions are indexed 
	v = V[batch_idx, :, head_idx, :] # [seq_len_kv, head_dim]
	for m_tile over entire seq_len_q:
		q = Q[batch_idx, m_tile, head_idx, :] # [BLOCK_M, head_dim], B and H dimensions are indexed
		p = elementwise_activation(q @ k.T) # [BLOCK_M, BLOCK_N]
		output[batch_idx, m_tile, head_idx, :] = p @ v # [BLOCK_M, head_dim]
```

Although this optimization is not directly related to our topic, we still include it here because we built our fusion kernel on top of this version, and benchmarks were done against this version. We include it for completeness as it was not mentioned in the original GDPA blog.

> **译：** 尽管该优化与我们的主题不直接相关，我们仍在此包含它，因为我们的融合内核构建在这个版本之上，基准也是与之对比。为完整性我们收录它，原 GDPA 博客未提及。

Now we fuse the norms and residuals into the kernel. The idea is the same as above with multi-CTA reduction. The only caveat is that here CTAs in the same cluster should share the same batch_idx and process different head_idx. Also, notice that the layernorm here is a prologue fusion. While the pipelining and the matmuls' dependency on it are still an issue (which we address below), fortunately we don't have the problem of redundant layernorm computation thanks to K/V being short. Since we don't tile over K/V's length, every tile of Q will only be loaded and processed by one single CTA.

> **译：** 现在我们把 norm 和残差融合进内核。思路与上面 multi-CTA 归约相同。唯一要注意的是，此处同一 cluster 内的 CTA 应共享相同 batch_idx，处理不同 head_idx。另外注意此处的 layernorm 是 prologue 融合。虽然流水线和 matmul 对它的依赖仍是问题（我们下面解决），但幸好由于 K/V 很短，我们没有冗余 layernorm 计算的问题。因为我们不对 K/V 的长度分块，每个 Q tile 只会被一个 CTA 加载和处理。

```text title="FlashNormAttention forward 融合内核（短 KV）"
# input: Q: [batch_size, seq_len_q, H, head_dim], K/V: [batch_size, seq_len_kv, H, head_dim]
# metaparam: BLOCK_M (tile size of m_tile on seq_len_q)
# grid on (batch_size, H)
def gdpa_fwd_fusion_kernel_short_kv(Q, K, V, output):
	compute the batch_idx and head_idx for this CTA
	k = K[batch_idx, :, head_idx, :]
	v = V[batch_idx, :, head_idx, :]
	for m_tile over entire seq_len_q:
		q = Q[batch_idx, m_tile, head_idx, :]
		ln_q = multi_cta_layernorm(q) # multi-CTA norm 1
		p = elementwise_activation(ln_q @ k.T)
		gdpa_out = p @ v
		gdpa_out += ln_q # residual connection 1 
		out = multi_cta_rmsnorm(gdpa_out) # multi-CTA norm 2
		out += q # residual connection 2
		output[batch_idx, m_tile, head_idx, :] = out
```

Although this all looks nice and great, there are two critical issues hidden behind this pseudocode:

> **译：** 虽然这一切看起来美好，但伪代码背后隐藏着两个关键问题：

1. **Memory pressure:** This massive fusion brings high pressure on registers and shared memory usage. We need to keep many more things that didn't exist before, such as ln_q and rmsnorm(gdpa_out). If the execution is purely sequential, this would be fine because as we produce the output for an op, its input can immediately be freed. But this is not the case here due to residual connections. Notice how the lifetime of q and ln_q spans across a large region because we need to keep them for later residual connection computation. This means we most definitely have to dedicate some shared memory for these variables, increasing the total memory needed. In fact, with this naive algorithm version, we observed the shared memory usage to double, significantly exceeding the limit.
1. **CUDA Core dominance & pipeline stalls:** Even though we eliminated most of the memory IO with the fusion, the CUDA core computation for the norms and residual connections still remains, and blocks Tensor Core utilization. Fine-tuned warp specialization and pipelining are needed to hide as much CUDA core latency as possible.

> **译：**
> 1. **显存压力：** 这种大规模融合给寄存器和共享内存使用带来很高压力。我们需要保留许多之前没有的东西，如 ln_q 和 rmsnorm(gdpa_out)。如果执行纯粹是顺序的，这没问题，因为一个算子的输出产生后其输入可立即释放。但这里由于残差连接并非如此。注意 q 和 ln_q 的生命周期跨越很大区域，因为我们要留它们给后续残差连接计算。这意味着我们几乎肯定要为这些变量专门分配一些共享内存，增加总内存需求。事实上，在这个朴素算法版本下，我们观察到共享内存使用翻倍，显著超出上限。
> 1. **CUDA Core 主导与流水线停顿：** 尽管融合消除了大部分访存 IO，但 norm 和残差连接的 CUDA Core 计算仍然存在，并阻塞 Tensor Core 利用率。需要精细调校的 warp specialization 和流水线，尽可能隐藏 CUDA Core 延迟。

For memory pressure, we applied 3 main optimization ideas

> **译：** 对于显存压力，我们应用了 3 个主要优化思路

- **Memory buffer reuse:** A key technique for saving memory usage is to let non-overlapping data share the same memory buffers. A good example in our case is the shared memory buffer for out. In the last line of code above, it looks like we are directly storing out from registers to HBM, but in reality what happens is we first put it in a SMEM buffer, and then invoke TMA to asynchronously perform the store from SMEM to HBM. It's obvious that this buffer has a short lifespan, and we reuse this buffer to temporarily store q after computing ln_q but before needing it for the second residual connection.
- **Leverage Tensor Memory and TensorCore's accumulate:** Notice how ln_q is added immediately to the result of a matmul p @ v. Instead of keeping ln_q in SMEM and reading it out after the matmul is done, notice how this is exactly the [MMA](https://docs.nvidia.com/cuda/parallel-thread-execution/#tcgen05-mma) semantic supported by tcgen05 in TMEM. Therefore, we can directly keep ln_q in the TMEM buffer allocated for p @ v, and offload the ln_q addition to TensorCore! This helps save both SMEM footprint and computation time.
- **Register subtiling:** Especially in a CUDA-core-heavy kernel like ours, registers are a scarcer resource than SMEM/TMEM. Besides careful register allocation tuning, we use register subtiling to mitigate the register pressure. We cut the tensor in SMEM/TMEM into chunks and load to registers one chunk at a time for normalization computation (both reduction and elementwise). This helps prevent register spilling which would cause significant performance degradation.

> **译：**
> - **内存缓冲复用：** 节省内存使用的一个关键技巧是让不重叠的数据共享同一内存缓冲。我们这里一个好例子是 out 的共享内存缓冲。上面代码最后一行看起来像是直接把 out 从寄存器存到 HBM，但实际发生的是我们先把它放进 SMEM 缓冲，再调用 TMA 异步地从 SMEM 存到 HBM。显然该缓冲生命周期很短，我们在算完 ln_q 后、需要它做第二次残差连接前，复用这个缓冲临时存 q。
> - **利用 Tensor Memory 与 TensorCore 的累加：** 注意 ln_q 是立即加到 matmul p @ v 的结果上。与其把 ln_q 留在 SMEM 等 matmul 完再读出，不如注意这恰好是 tcgen05 在 TMEM 中支持的 [MMA](https://docs.nvidia.com/cuda/parallel-thread-execution/#tcgen05-mma) 语义。因此我们可以直接把 ln_q 存在为 p @ v 分配的 TMEM 缓冲里，把 ln_q 的加法下放给 TensorCore！这既省 SMEM 占用又省计算时间。
> - **寄存器子分块：** 尤其在像我们这样 CUDA Core 负载重的内核里，寄存器是比 SMEM/TMEM 更稀缺的资源。除了仔细的寄存器分配调优，我们用寄存器子分块来缓解寄存器压力。我们把 SMEM/TMEM 中的张量切成块，一次一块加载到寄存器做归一化计算（归约和逐元素都如此）。这有助于防止寄存器溢出（spilling），否则会造成显著性能退化。

For pipeline stalls, we used the following techniques to improve pipeline efficiency:

> **译：** 对于流水线停顿，我们用以下技术提升流水线效率：

- **Warp specialization:** In the original GDPA design, we have 4 main specialized warp partitions (load, mma, activation, and epilogue). In FlashNormAttention, we put the RMSNorm computation on the activation warp, while adding a fifth partition dedicated to prologue Layernorm computation, in order to better overlap it with TensorCore as well as other CUDA Core operations (e.g. RMSNorm computation for the previous iteration). The execution pipeline looks like the following. We use 8 warps (0-7) for the activation partition and 4 warps (8-11) for Layernorm. We maximize register allocation for the activation warps while limiting that for the Layernorm warps, using register subtiling to strike an optimal register-latency tradeoff.** ![Figure 12: FlashNormAttention warp specialization execution pipeline](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-12.png) **

> **译：**
> - **Warp specialization：** 原始 GDPA 设计有 4 个主要专用 warp 分区（load、mma、activation 和 epilogue）。在 FlashNormAttention 中，我们把 RMSNorm 计算放在 activation warp 上，同时新增第五个分区专门做 prologue Layernorm 计算，以便更好地将其与 TensorCore 及其他 CUDA Core 操作（如上一迭代的 RMSNorm 计算）重叠。执行流水线如下所示。activation 分区用 8 个 warp（0-7），Layernorm 用 4 个 warp（8-11）。我们为 activation warp 最大化寄存器分配，同时限制 Layernorm warp 的分配，用寄存器子分块在寄存器-延迟间取得最优折中。** ![图 12：FlashNormAttention 的 warp specialization 执行流水线](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-12.png) **

- **Register pre-loading:** A key factor stalling the execution pipeline is the complex data dependency introduced by residual connections. Both q and ln_q need to be held in memory for a long time, blocking the prefetching and precomputing of these tensors for the next iteration. Since prefetching with TMA utilizes SMEM, Optimization #2 for memory pressure discussed above effectively moves ln_q off the critical path. As for q, we let the activation warps preload q from SMEM as soon as it's ready, and hold on to it until the very end where the second residual connection happens. By doing this, we can immediately free up the SMEM for q so that the next iteration's q can be loaded as we work on the current iteration. As we allocate a maximum number of registers to the activation warps, the register pressure is still fine.

> **译：**
> - **寄存器预加载：** 阻塞执行流水线的一个关键因素是残差连接引入的复杂数据依赖。q 和 ln_q 都需要长时间留在内存中，阻塞下一迭代对这些张量的预取和预计算。由于用 TMA 预取要占用 SMEM，上文讨论的显存压力优化 #2 有效地把 ln_q 移出了关键路径。至于 q，我们让 activation warp 在 q 就绪后立即从 SMEM 预加载，一直持有到最后第二次残差连接发生。这样我们能立即释放 q 的 SMEM，使下一迭代的 q 在我们处理当前迭代时就能加载。由于我们为 activation warp 分配了最大数量的寄存器，寄存器压力仍然 OK。

Below we present the benchmark results for the typical GDPA shapes we use. K/V are dense sequences with length exactly 128. Q is a sparse sequence with average sparsity 0.5 and varied max lengths. The batch size is 768. Head dimension is set to 128, and the number of heads is also varied to reflect the different performance behaviors under different normalization dimensions and different CTA cluster size. Due to the complex fusion, we present the latency saving as a percentage of the total baseline latency instead of just the normalization / elementwise kernels' latency. The baseline is taken with inductor compilation.

> **译：** 下面给出我们使用的典型 GDPA 形状下的基准结果。K/V 是长度恰为 128 的稠密序列。Q 是平均稀疏度 0.5、最大长度可变的稀疏序列。batch size 为 768。head 维度设为 128，head 数量也变化，以反映不同归一化维度和不同 CTA cluster size 下的不同性能表现。由于融合复杂，我们把延迟节省表示为相对总基线延迟的百分比，而非仅相对 norm/逐元素内核的延迟。基线用 inductor 编译取。

![Figure 13: FlashNormAttention forward kernel latency saving vs baseline (inductor), across varied head counts and cluster sizes](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-13.png)

> **译：** 图 13：FlashNormAttention forward 内核相对基线（inductor）的延迟节省，跨不同 head 数量和 cluster size。

### Backward implementation

As for backward, we skip the detailed algorithm for brevity, and only note the interesting optimizations and similarities/differences compared to forward.

> **译：** 至于 backward，为简洁跳过详细算法，只指出有趣的优化点及与 forward 的异同。

- **Algorithm:** First notice that the backward fusion very much resembles forward, because the backward of a reduction op like normalization is also a reduction op, and the backward of a residual connection is also a residual connection
- **Recompute:** The original GDPA backward kernel recomputes q@k to save memory IO for forward. We follow the same idea for our fusion. First, the q@k becomes ln(q)@k in our kernel, so we recompute ln(q) first. We avoid incurring DSMEM overhead here by storing mean and variance in the forward (which is cheap because they are 1D) so that backward can use them to derive ln(q) easily. Second, we need the output of rmsnorm for its backward computation, which we recompute by rmsnorm_out = kernel_out – q. Lastly, we need the input of rmsnorm as well for residual connection backward, which we recompute by rmsnorm_in = rmsnorm_out / rstd.
- **Warp specialization:** The original GDPA backward kernel has 4 warp partitions: mma, activation, load, and reduction (for atomic-adding dQ). We use the same structure and put all new computation except Layernorm backward in the activation partition. We put the Layernorm backward computation in the reduction partition to facilitate better pipelining (similar to how we put the prologue Layernorm in a separate partition in forward).
- **Memory pressure:** Backward faces an even more severe memory pressure than forward, simply due to how much more data it needs to store and compute. For mitigation we applied aggressive SMEM/TMEM reuse similar to forward, but also had to shrink the tile sizes.
- **Pipeline efficiency:** Similar to forward, the long lifecycle of the residuals blocks the pipelining. For the inner residual, we can still use TMEM and TensorCore accumulate to break the lifecycle. But for the outer residual, we can't afford register preloading in backward due to the higher pressure. Instead our approach is to use [TMA_REDUCE_ADD](https://github.com/NVIDIA/cutlass/blob/main/include/cute/arch/copy_sm90_tma.hpp#L1278) to directly add the residual from SMEM to HBM as soon as it's ready.  It may seem counterintuitive at first to do this because the whole point of FlashNormAttention is to reduce memory IO, but this actually makes good sense. With the fusion the memory IO is no longer the bottleneck of the kernel, so we are happy to go back and trade a little more memory IO for mitigating the current bottleneck – the computation and pipeline stalls.

> **译：**
> - **算法：** 首先注意 backward 融合与 forward 非常相似，因为归一化这类归约算子的 backward 也是归约算子，残差连接的 backward 也是残差连接。
> - **重计算：** 原始 GDPA backward 内核重计算 q@k 以节省 forward 的访存 IO。我们的融合沿用此思路。首先，q@k 在我们内核中变成 ln(q)@k，所以我们先重计算 ln(q)。这里我们通过在 forward 中存下均值和方差（因它们是一维的，开销很小）来避免引入 DSMEM 开销，backward 可用它们轻松推出 ln(q)。其次，rmsnorm 的 backward 计算需要其输出，我们用 rmsnorm_out = kernel_out – q 重计算。最后，残差连接 backward 还需要 rmsnorm 的输入，我们用 rmsnorm_in = rmsnorm_out / rstd 重计算。
> - **Warp specialization：** 原始 GDPA backward 内核有 4 个 warp 分区：mma、activation、load 和 reduction（用于原子加 dQ）。我们用相同结构，把除 Layernorm backward 外的所有新计算放进 activation 分区。我们把 Layernorm backward 计算放进 reduction 分区以利于更好流水线（类似 forward 中我们把 prologue Layernorm 放进单独分区）。
> - **显存压力：** backward 面临比 forward 更严峻的显存压力，仅因它要存储和计算的数据多得多。为缓解，我们像 forward 一样做了激进的 SMEM/TMEM 复用，但也不得不缩小 tile 大小。
> - **流水线效率：** 与 forward 类似，残差的长生命周期阻塞流水线。对于内层残差，我们仍能用 TMEM 和 TensorCore 累加来打破生命周期。但对外层残差，由于压力更高，backward 中我们负担不起寄存器预加载。我们的做法是用 [TMA_REDUCE_ADD](https://github.com/NVIDIA/cutlass/blob/main/include/cute/arch/copy_sm90_tma.hpp#L1278)，在残差就绪后直接从 SMEM 加到 HBM。乍看这样做有悖直觉，因为 FlashNormAttention 的全部意义在于减少访存 IO，但这其实很合理。有了融合，访存 IO 已不再是内核瓶颈，所以我们乐于回过头来用一点更多访存 IO 换取缓解当前瓶颈——计算和流水线停顿。

The chart below shows the performance improvement of the backward fusion. The exact same shapes as in forward are used.

> **译：** 下图展示 backward 融合的性能提升。使用与 forward 完全相同的形状。

![Figure 14: FlashNormAttention backward kernel latency saving vs baseline, same shapes as forward](/vibe-reading/images/articles/pytorch-blogs-towards-free-normalization/fig-14.png)

> **译：** 图 14：FlashNormAttention backward 内核相对基线的延迟节省，形状与 forward 相同。

## Acknowledgements

We thank Tri Dao, Markus Hoehnerbach, Jay Shah, Ted Zadouri, Vijay Thakkar, Wentao Guo for their open-source work in [Flash Attention](https://github.com/Dao-AILab/flash-attention) and [Quack](https://github.com/Dao-AILab/quack), which laid the foundation and provided inspiration for many optimization techniques discussed in this blog. We thank the Pytorch and Triton teams for their development and maintenance of [Helion](https://github.com/pytorch/helion) and [TLX](https://github.com/facebookexperimental/triton/tree/main), which made the exploration of the presented ideas efficient and fruitful.

> **译：** 我们感谢 Tri Dao、Markus Hoehnerbach、Jay Shah、Ted Zadouri、Vijay Thakkar、Wentao Guo 在 [Flash Attention](https://github.com/Dao-AILab/flash-attention) 和 [Quack](https://github.com/Dao-AILab/quack) 上的开源工作，它们为本博客讨论的许多优化技术奠定了基础并提供了灵感。我们感谢 Pytorch 和 Triton 团队开发和维护 [Helion](https://github.com/pytorch/helion) 和 [TLX](https://github.com/facebookexperimental/triton/tree/main)，使本文所述思路的探索高效而富有成果。

## References

> **译：** 参考文献

- [1] Generalized Dot-Product Attention: Tackling Real-World Challenges in GPU Training Kernels. https://pytorch.org/blog/generalized-dot-product-attention-tackling-real-world-challenges-in-gpu-training-kernels/
- [2] Kunlun: Establishing Scaling Laws for Massive-Scale Recommendation Systems through Unified Architecture Design. https://arxiv.org/abs/2602.10016
- [3] Meta's Generative Ads Model (GEM): The Central Brain Accelerating Ads Recommendation AI Innovation. https://engineering.fb.com/2025/11/10/ml-applications/metas-generative-ads-model-gem-the-central-brain-accelerating-ads-recommendation-ai-innovation/
- [4] Quack: Getting Memory-bound Kernels to Speed-of-Light. https://github.com/Dao-AILab/quack/blob/main/media/2025-07-10-membound-sol.md
- [5] Triton Tutorials: 03 Matrix Multiplication. https://triton-lang.org/main/getting-started/tutorials/03-matrix-multiplication.html
- [6] FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision. https://arxiv.org/pdf/2407.08608
- [7] Look Ma, No Bubbles! Designing a Low-Latency Megakernel for Llama-1B. https://hazyresearch.stanford.edu/blog/2025-05-27-no-bubbles

