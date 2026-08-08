---
title: "HPC-Ops × SGLang: High-Performance Attention, Router GEMM, and MoE Kernels from Tencent Hunyuan"
source:
  type: "article"
  project: "SGLang"
  url: "https://www.lmsys.org/blog/2026-08-07-hpc-ops-sglang"
  author: "Tencent Hunyuan AI Infra and the SGLang Team"
  site: "LMSYS Blog"
date: "2026-08-07T18:00:00+08:00"
category: [AI, Infra, Inference, SGLang, Official]
tags: ["HPC-Ops", "Attention", "Router GEMM", "MoE", "Tencent Hunyuan", "H20", "H200", "Kernel Optimization"]
description: "HPC-Ops is an open-source operator library for LLM inference, deployed in Tencent's large-scale production serving. Its core operators — Dynamic Attention, Router GEMM, and Fused MoE — reduce Hy3 TPOT by up to 48.8% and are now integrated into SGLang's main branch."
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [HPC-Ops × SGLang: High-Performance Attention, Router GEMM, and MoE Kernels from Tencent Hunyuan](https://www.lmsys.org/blog/2026-08-07-hpc-ops-sglang) · **作者** Tencent Hunyuan AI Infra and the SGLang Team · **来源** LMSYS Blog · **原文发布** 2026-08-07 · **中英对照·AI 译** 2026-08-07
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

[HPC-Ops](https://github.com/Tencent/hpc-ops) is an open-source operator library for LLM inference, deployed in Tencent's large-scale production serving. Its core operators, including Dynamic Attention and Fused MoE, play a critical role in Hunyuan's online inference, reducing TPOT of Hy3 model by up to 48.8%. HPC-Ops Attention, Router GEMM, and MoE are now integrated into SGLang's main branch, bringing these production-proven optimizations to the open-source serving community.

> **译：** [HPC-Ops](https://github.com/Tencent/hpc-ops) 是一个用于 LLM 推理的开源算子库，部署于腾讯大规模生产 serving 系统。其核心算子包括 Dynamic Attention 和 Fused MoE，在混元的在线推理中发挥关键作用，将 Hy3 模型的 TPOT 最高降低 48.8%。HPC-Ops 的 Attention、Router GEMM 和 MoE 现已集成进 SGLang 主分支，将这些经生产验证的优化带入开源 serving 社区。

In this blog, we introduce the design of three important operators in HPC-Ops and their integration with SGLang. We then present operator benchmarks and serving results on H20 together with the H200 validation results. The integrations target NVIDIA Hopper GPUs (SM90) and have been validated with Qwen3, Hy3, and LongCat workloads.

> **译：** 在本博文中，我们介绍 HPC-Ops 中三个重要算子的设计及其与 SGLang 的集成。随后展示 H20 上的算子基准测试和 serving 结果，以及 H200 验证结果。这些集成面向 NVIDIA Hopper GPU（SM90），已用 Qwen3、Hy3 和 LongCat 工作负载验证。

## Highlights

- **Attention:** On H20, HPC-Ops dynamic scheduling reaches **2.95×** over its static split-KV schedule and is on average **2.25× faster** than the best of FlashInfer and FlashAttention in each measured case. In upstream H200 validation, the integrated Hy3-FP8 path with FP8 KV cache improves output throughput by **3.7–5.9%** over FlashAttention.
- **Router GEMM:** On H20, HPC-Ops is **1.30–3.22× faster than FP32 cuBLAS**, while its maximum absolute error relative to FP32 cuBLAS is **0.00177**, versus **0.06464** for TF32 cuBLAS. In the upstream H200 LongCat-Flash kernel validation, it delivers a **4.31× speedup** over the existing FP32 path.
- **MoE:** On H20, HPC-Ops delivers mean per-batch speedups of **1.08× at TP8 / EP1** and **1.21× at TP1 / EP8** over the best of the SGLang and vLLM baselines on Hy3. In the upstream Qwen3/H200 kernel benchmark, it reaches up to **4.21× over Triton** at eight tokens.
- **End-to-end serving:** On 8× H20 with Hy3-FP8, enabling HPC-Ops Attention and MoE together reduces TPOT by **15.1–48.8% at batch sizes 4–64** and TTFT by **3.3–6.0% at batch sizes 4–16**. On 8× H20 with LongCat-Flash-Lite-FP8, enabling HPC-Ops Router GEMM improves input throughput by **5.5–6.1% at batch sizes 4–64**.

> **译：** **亮点：**
>
> - **Attention：** 在 H20 上，HPC-Ops 动态调度相对其静态 split-KV 调度达到 **2.95×**，在每个测试用例中平均比 FlashInfer 和 FlashAttention 的最佳值快 **2.25×**。在上游 H200 验证中，集成的 Hy3-FP8 路径配合 FP8 KV cache，输出吞吐比 FlashAttention 提升 **3.7–5.9%**。
> - **Router GEMM：** 在 H20 上，HPC-Ops 比 FP32 cuBLAS 快 **1.30–3.22×**，而相对 FP32 cuBLAS 的最大绝对误差为 **0.00177**，TF32 cuBLAS 则为 **0.06464**。在上游 H200 LongCat-Flash 内核验证中，相对既有 FP32 路径加速 **4.31×**。
> - **MoE：** 在 H20 上，HPC-Ops 在 Hy3 上相对 SGLang 和 vLLM 基线的最佳值，TP8 / EP1 平均每 batch 加速 **1.08×**，TP1 / EP8 平均 **1.21×**。在上游 Qwen3/H200 内核基准中，8 token 时达到 **4.21× over Triton**。
> - **端到端 serving：** 在 8× H20 + Hy3-FP8 上，同时启用 HPC-Ops Attention 和 MoE，batch size 4–64 下 TPOT 降低 **15.1–48.8%**，batch size 4–16 下 TTFT 降低 **3.3–6.0%**。在 8× H20 + LongCat-Flash-Lite-FP8 上，启用 HPC-Ops Router GEMM，batch size 4–64 下输入吞吐提升 **5.5–6.1%**。

## Attention, routing, and experts: three hot paths in MoE model serving

Production MoE serving rarely resembles the uniform workloads measured in isolated kernel benchmarks. It combines mixed-length Attention work, precision-sensitive routing, and sparse expert execution within the same latency-sensitive path; long-context, multi-turn, and agentic workloads further widen the distribution of live KV lengths. Serving performance therefore depends not only on raw matrix-multiplication throughput, but also on workload balance, numerical fidelity, and overhead control.

> **译：** 生产环境下的 MoE serving 很少像隔离内核基准测试中测量的均匀工作负载。它在同一延迟敏感路径内混合了变长 Attention 工作、精度敏感的路由和稀疏专家执行；长上下文、多轮和 agentic 工作负载进一步拉宽了活跃 KV 长度的分布。因此 serving 性能不仅取决于原始矩阵乘法吞吐，还取决于工作负载均衡、数值保真度和开销控制。

These constraints surface in three performance-critical stages of MoE model serving. During decode, Attention work scales with each request's live KV length, making mixed-length batches a load-balancing problem. Router GEMM produces the scores used for top-k selection, where small numerical changes can alter expert choices. The selected experts then process small and uneven token groups, allowing metadata construction, token movement, intermediate storage, and launch overhead to rival the expert GEMMs themselves.

> **译：** 这些约束在 MoE 模型 serving 的三个性能关键阶段中浮现。Decode 期间，Attention 工作量随每个请求的活跃 KV 长度扩展，使变长 batch 成为负载均衡问题。Router GEMM 产生用于 top-k 选择的分数，其中微小的数值变化可能改变专家选择。被选中的专家随后处理小而不均匀的 token 组，使元数据构建、token 搬运、中间存储和 launch 开销可与专家 GEMM 本身相当。

HPC-Ops addresses each stage with a dedicated operator: workload-aware scheduling for Attention, a precision-aware formulation for Router GEMM, and a fused pipeline for MoE that eliminates the standalone gather and reduces launch and intermediate traffic. The upstream integration pairs these operators with SGLang's serving runtime through its native backend and dispatch interfaces. The following sections explain how each operator is designed.

> **译：** HPC-Ops 用专用算子分别应对每个阶段：Attention 的负载感知调度、Router GEMM 的精度感知公式、MoE 的融合流水线（消除独立 gather、降低 launch 和中间流量）。上游集成通过 SGLang 的原生后端和分发接口将这些算子与 serving 运行时配对。以下章节解释每个算子的设计。

## Attention: load balancing for mixed-length decode

During decode, each new token attends over the request's full KV cache, so Attention work scales with the live sequence length. A request with 16K cached tokens therefore carries roughly 16× the KV work of one with 1K. In production, prompt and output lengths vary widely, and continuous batching places requests at different stages of generation in the same launch; a batch therefore routinely mixes short KV caches with sequences tens of thousands of tokens long.

> **译：** Decode 期间，每个新 token 对请求的完整 KV cache 做 attention，因此 Attention 工作量随活跃序列长度扩展。一个缓存 16K token 的请求因此承载约 16 倍于 1K 请求的 KV 工作。在生产中，prompt 和输出长度差异很大，连续批处理将不同生成阶段的请求放在同一次 launch 中；因此一个 batch 经常混合短 KV cache 和数万 token 长的序列。

A static split-KV schedule maps work to a fixed launch grid over KV heads, requests, and KV chunks, with one partitioning policy shared across the batch. A static split-KV scheduler generally follows one of two policies, neither of which performs well for mixed-length batches. (1) Fix the split count, and long requests produce much heavier chunks: short-request CTAs finish early while a few long-running CTAs determine the kernel tail. (2) Fix the chunk size instead, and the grid must reserve enough splits for the longest request, leaving shorter requests with empty or nearly empty chunks that still consume scheduling slots. One policy creates uneven work; the other schedules nonexistent work.

> **译：** 静态 split-KV 调度将工作映射到 KV head、请求和 KV chunk 上的固定 launch 网格，全 batch 共享一种分区策略。静态 split-KV 调度器通常遵循两种策略之一，两者在变长 batch 上表现都不好。(1) 固定 split 数量：长请求产生重得多的 chunk，短请求 CTA 提前完成而少数长运行 CTA 决定内核尾部。(2) 固定 chunk 大小：网格必须为最长请求预留足够 split，使较短请求有空或近乎空的 chunk 仍占用调度槽。一种策略造成不均匀工作；另一种调度不存在的工作。

### Scheduling around live KV work

HPC-Ops replaces the static per-request split with a persistent kernel that dynamically balances KV tiles across CTAs according to the batch's actual length distribution. For each decode batch, an assign kernel builds a global task map from live KV lengths: it slices every sequence into uniform 64-token tiles, sums the tile count across all heads and requests, and divides the total by the number of persistent CTAs to set a per-CTA tile budget. The assignment kernel fills each CTA's bin up to that budget before spilling into the next, so long sequences span multiple CTAs in proportion to their length while short sequences contribute only the tiles they actually have. A minimum-work floor prevents over-partitioning when total work is small, keeping the downstream combine inexpensive. The task map is generated once per decode step from device-side sequence lengths and reused across Transformer layers, amortizing its cost.

> **译：** HPC-Ops 用一个 persistent kernel替代静态逐请求 split，该内核根据 batch 的实际长度分布动态跨 CTA 均衡 KV tile。对每个 decode batch，一个 assign 内核从活跃 KV 长度构建全局任务映射：将每条序列切分为统一 64-token tile，汇总所有 head 和请求的 tile 数，除以 persistent CTA 数设定每 CTA tile 预算。assign 内核在溢出到下一个之前将每个 CTA 的 bin 填至该预算，因此长序列按其长度比例跨多个 CTA，而短序列只贡献实际拥有的 tile。最小工作地板防止总工作量小时的过度分区，保持下游 combine 低开销。任务映射每 decode 步从设备端序列长度生成一次，跨 Transformer 层复用以摊薄成本。

At execution time, each CTA drains its assigned bin. For every descriptor, it computes Attention over one or more contiguous KV tiles and writes a partial output with its log-sum-exp statistic; the same resident CTA continues to the next descriptor until its bin is empty. Because each CTA produces only a subset of the partials for a given request, a final combine kernel reads the actual chunk count per request and head and merges the partials under the correct global softmax normalization. The near-equal bin sizes ensure that CTAs finish at roughly the same time, eliminating the kernel tail that a few unusually long requests would otherwise cause.

> **译：** 执行时，每个 CTA 排空其分配的 bin。对每个描述符，它对一个或多个连续 KV tile 计算 Attention 并写入带 log-sum-exp 统计量的部分输出；同一驻留 CTA 继续到下一个描述符直到 bin 为空。由于每个 CTA 只产生给定请求的部分 partial，一个最终 combine 内核读取每请求和 head 的实际 chunk 数，在正确的全局 softmax 归一化下合并 partial。近乎相等的 bin 大小确保 CTA 大致同时完成，消除少数异常长请求本会导致的内核尾部。

### A fused attention prologue

For Hy3 FP8, HPC-Ops fuses the Attention prologue after the QKV projection: it applies QK-Norm before RoPE, emits Q in FP8 with a per-token, per-head scale, and writes K and V directly into the paged FP8 cache. It passes the quantized Q and its scale directly to the main Attention kernel, avoiding requantization. The fused path eliminates intermediate tensors and their associated HBM round-trips and separate kernel launches in both prefill and decode.

> **译：** 对于 Hy3 FP8，HPC-Ops 将 QKV 投影后的 Attention 前言融合：在 RoPE 前应用 QK-Norm，以 FP8 配合 per-token、per-head scale 输出 Q，并将 K 和 V 直接写入 paged FP8 cache。它将量化后的 Q 及其 scale 直接传给主 Attention 内核，避免重量化。融合路径消除了中间张量及其 HBM 往返和 prefill 与 decode 中的独立内核 launch。

## Router GEMM: balancing routing precision and throughput

Router precision directly affects MoE model quality. At each MoE layer, the router projects hidden states into expert scores, and a top-k selection over these scores determines which experts execute. The score differences between the k-th and (k+1)-th expert can be small, so the arithmetic precision of this projection determines whether the correct experts are selected.

> **译：** 路由精度直接影响 MoE 模型质量。在每个 MoE 层，路由器将隐藏状态投影为专家分数，基于这些分数的 top-k 选择决定哪些专家执行。第 k 和第 (k+1) 个专家之间的分数差异可能很小，因此此投影的算术精度决定是否选中正确的专家。

To preserve router precision, some production models retain FP32 router weights even when hidden states are BF16. Casting those weights to BF16 enables BF16 Tensor Core throughput but discards low-order mantissa bits that can flip a top-k decision. A full FP32 GEMM preserves all weight precision, but with lower Tensor Core throughput.

> **译：** 为保留路由精度，一些生产模型即使隐藏状态为 BF16 也保留 FP32 路由器权重。将这些权重转为 BF16 可启用 BF16 Tensor Core 吞吐，但丢弃可能翻转 top-k 决策的低位 mantissa bit。完整 FP32 GEMM 保留全部权重精度，但 Tensor Core 吞吐更低。

### A precision-aware BF16 formulation

HPC-Ops resolves this by decomposing the FP32 weight into two BF16 components. It extracts a BF16 high part $W_{\mathrm{high}}$ by direct truncation, then forms a second BF16 component from the scaled residual $(W - W_{\mathrm{high}}) \times 256$. The original weight is approximated as $W \approx W_{\mathrm{high}} + W_{\mathrm{low}} / 256$, so the matrix product becomes two BF16 GEMMs whose results are combined with a scale correction to recover the low-order mantissa contribution. A single kernel executes both BF16 multiplications: it loads activation tiles once from shared memory, accumulates both partial results in FP32 registers, applies the $1/256$ scaling in the epilogue, and writes the final FP32 router scores to global memory. This formulation recovers precision close to a full FP32 GEMM while running the main arithmetic on BF16 Tensor Cores.

> **译：** HPC-Ops 通过将 FP32 权重分解为两个 BF16 分量来解决此问题。它通过直接截断提取 BF16 高位部分 $W_{\mathrm{high}}$，然后从缩放残差 $(W - W_{\mathrm{high}}) \times 256$ 构成第二个 BF16 分量。原始权重近似为 $W \approx W_{\mathrm{high}} + W_{\mathrm{low}} / 256$，因此矩阵乘积变为两个 BF16 GEMM，其结果经 scale 校正合并以恢复低位 mantissa 贡献。单个内核执行两次 BF16 乘法：从共享内存一次性加载 activation tile，在 FP32 寄存器中累加两个 partial 结果，在 epilogue 中应用 $1/256$ 缩放，将最终 FP32 路由分数写入全局内存。此公式在 BF16 Tensor Core 上运行主要运算的同时恢复接近完整 FP32 GEMM 的精度。

On the framework side, SGLang caches the decomposed weight pair at model load time and reuses it across requests and CUDA graph replays. A shape-aware dispatch selects between the HPC-Ops kernel and the default path at measured crossover points. Below these points, the single FP32 path is faster because the two-product overhead exceeds the Tensor Core gain.

> **译：** 在框架侧，SGLang 在模型加载时缓存分解后的权重对，跨请求和 CUDA graph replay 复用。形状感知分发在测量的交叉点选择 HPC-Ops 内核或默认路径。低于这些点时，单 FP32 路径更快，因为两乘积开销超过 Tensor Core 增益。

## MoE: reducing overhead around small expert GEMMs

During decode, each expert in an MoE layer receives only a handful of tokens. The resulting expert GEMMs are small and memory-bound, and the GPU's SMs are underutilized at these shapes. The problem is compounded by load imbalance: the number of tokens routed to each expert varies across experts and shifts from step to step, making it difficult to spread these small, uneven tiles evenly across the available SMs.

> **译：** Decode 期间，MoE 层中的每个专家只接收少量 token。由此产生的专家 GEMM 小且 memory-bound，GPU 的 SM 在这些形状下利用率不足。负载不均加剧了问题：路由到每个专家的 token 数跨专家变化且每步漂移，使这些小而不均匀的 tile 难以均匀分布到可用 SM 上。

Beyond the expert GEMMs themselves, the operations surrounding them introduce substantial overhead. A conventional MoE path chains separate kernels for routing, gathering tokens into per-expert buffers, Gate-Up GEMM, activation and quantization, Down GEMM, and top-k weighted reduction back to token positions. The gather step materializes a full token tensor in HBM before any matmul begins, and each subsequent stage pays its own kernel launch and HBM round-trip for intermediates. When the GEMMs are small, this surrounding overhead consumes a comparable fraction of the stage's wall time.

> **译：** 除了专家 GEMM 本身，其周围的操作引入大量开销。传统 MoE 路径串联独立内核用于路由、将 token gather 到 per-expert buffer、Gate-Up GEMM、activation 和量化、Down GEMM、以及 top-k 加权归约回 token 位置。gather 步骤在 matmul 开始前在 HBM 中物化完整 token 张量，每个后续阶段为其中间量付出自己的内核 launch 和 HBM 往返。当 GEMM 小时，这些周围开销消耗该阶段 wall time 的可观比例。

### A fused, latency-oriented MoE pipeline

For low-batch-size inference, the HPC-Ops MoE backend coordinates routing and index preprocessing, Gate-Up, activation and requantization, Down, and top-k weighted reduction in a low-latency pipeline built around task-map-driven persistent expert GEMMs.

> **译：** 对于低 batch size 推理，HPC-Ops MoE 后端在围绕任务映射驱动的 persistent 专家 GEMM 构建的低延迟流水线中协调路由和索引预处理、Gate-Up、activation 和重量化、Down、以及 top-k 加权归约。

- **Routing and index build.** Starting from the selected top-k expert IDs, a shared-memory counting pass organizes token–expert assignments into contiguous per-expert output ranges, reducing global atomic pressure and building the routing indices and per-tile task maps consumed directly by the persistent expert GEMMs.
- **Gate-Up and activation.** The Gate-Up GEMM reads original tokens directly through the routing indices, skipping the standalone gather and its extra HBM traffic. SiLU-and-mul and FP8 requantization then run as one fused kernel whose output the Down GEMM reads directly.
- **Occupancy-first, without warp specialization.** A single warp group handles both data movement and matrix math rather than reserving separate producer and consumer groups. This raises CTA residency and shifts memory-latency hiding from an intra-CTA software pipeline to cross-CTA hardware scheduling. Persistent grids then consume these task maps and spread the small, uneven expert tiles across the SMs.
- **PDL-chained stages.** Programmatic Dependent Launch overlaps each downstream kernel launch with the tail of the preceding stage, reducing gaps across Gate-Up, activation, Down, and the final top-k weighted reduction, which restores expert outputs to token order.

> **译：**
>
> - **路由和索引构建。** 从选定的 top-k 专家 ID 出发，一个共享内存计数 pass 将 token-专家分配组织为连续的 per-expert 输出范围，降低全局 atomic 压力，构建路由索引和 per-tile 任务映射，直接被 persistent 专家 GEMM 消费。
> - **Gate-Up 和 activation。** Gate-Up GEMM 通过路由索引直接读取原始 token，跳过独立 gather 及其额外 HBM 流量。SiLU-and-mul 和 FP8 重量化随后作为单一融合内核运行，其输出被 Down GEMM 直接读取。
> - **占用优先，无 warp 专用化。** 单一 warp group 同时处理数据搬运和矩阵计算，而非预留独立的 producer 和 consumer group。这提升 CTA 驻留率，将内存延迟隐藏从 intra-CTA 软件流水线转移到跨 CTA 硬件调度。Persistent 网格随后消费这些任务映射，将小而不均匀的专家 tile 分布到 SM 上。
> - **PDL 链接阶段。** Programmatic Dependent Launch 将每个下游内核 launch 与前驱阶段尾部重叠，减少 Gate-Up、activation、Down 和最终 top-k 加权归约（将专家输出恢复到 token 顺序）之间的间隙。

Together, these optimizations reduce intermediate traffic and kernel-launch overhead on the critical path.

> **译：** 这些优化共同减少关键路径上的中间流量和内核 launch 开销。

## From HPC-Ops kernels to SGLang

Through SGLang's native backend and dispatch interfaces, HPC-Ops operates directly on the serving runtime's existing state while remaining an independently maintained operator library. Attention consumes paged KV storage and live device-side sequence metadata without an additional layout conversion; Router GEMM reuses preprocessed weights and workspace across requests and CUDA graph replays; and MoE follows SGLang's expert IDs and partitions without additional remapping. These integrations preserve each operator's intended data path while fitting SGLang's existing execution model.

> **译：** 通过 SGLang 的原生后端和分发接口，HPC-Ops 直接操作 serving 运行时的既有状态，同时保持为独立维护的算子库。Attention 消费 paged KV 存储和设备端活跃序列元数据，无需额外布局转换；Router GEMM 跨请求和 CUDA graph replay 复用预处理权重和工作区；MoE 遵循 SGLang 的专家 ID 和分区，无需额外重映射。这些集成在适配 SGLang 既有执行模型的同时保留每个算子的预期数据路径。

The three integrated operator paths are summarized below:

> **译：** 三个集成的算子路径汇总如下：

| HPC-Ops operator | What it optimizes | Precision | Upstream PRs |
| --- | --- | --- | --- |
| Attention | Load-balanced mixed-length decode and a fused QK-Norm, RoPE, quantization, and KV-write prologue | BF16 activations; BF16 or FP8 E4M3 KV cache | [#30540](https://github.com/sgl-project/sglang/pull/30540), [#32304](https://github.com/sgl-project/sglang/pull/32304) |
| Router GEMM | Precision-aware router projection using BF16 Tensor Cores while retaining FP32 weight information | BF16 activations × FP32 weights → FP32 scores | [#30247](https://github.com/sgl-project/sglang/pull/30247), [#31943](https://github.com/sgl-project/sglang/pull/31943) |
| MoE | Low-overhead execution around small and uneven expert GEMMs | BF16 hidden states; FP8 E4M3 expert weights | [#30541](https://github.com/sgl-project/sglang/pull/30541) |

## Getting started

This guide describes how to use the [HPC-Ops](https://github.com/Tencent/hpc-ops) Attention, Router GEMM, and MoE operators in SGLang.

> **译：** 本指南描述如何在 SGLang 中使用 [HPC-Ops](https://github.com/Tencent/hpc-ops) 的 Attention、Router GEMM 和 MoE 算子。

### Install

To install HPC-Ops from source:

> **译：** 从源码安装 HPC-Ops：

```bash
git clone https://github.com/Tencent/hpc-ops.git
cd hpc-ops
make wheel
python3 -m pip install dist/*.whl
```

HPC-Ops is already included in SGLang's official `x86_64` development images (`lmsysorg/sglang:dev`, or `lmsysorg/sglang:dev-cu12` for CUDA 12.9), so no separate installation is required when using these images.

> **译：** HPC-Ops 已包含在 SGLang 官方 `x86_64` 开发镜像中（`lmsysorg/sglang:dev`，或 CUDA 12.9 的 `lmsysorg/sglang:dev-cu12`），使用这些镜像时无需单独安装。

### Attention and MoE

Attention and MoE are independent backend choices in SGLang and can be enabled separately or together for compatible models such as Qwen3 and Hy3. The following example selects both HPC-Ops backends and enables the FP8 KV-cache Attention path:

> **译：** Attention 和 MoE 是 SGLang 中独立的后端选择，可对 Qwen3 和 Hy3 等兼容模型分别或一起启用。以下示例同时选择两个 HPC-Ops 后端并启用 FP8 KV-cache Attention 路径：

```bash
python3 -m sglang.launch_server \
  --model tencent/Hy3-FP8 \
  --tp-size 8 \
  --attention-backend hpc_ops \
  --kv-cache-dtype fp8_e4m3 \
  --page-size 64 \
  --moe-runner-backend hpc_ops
```

For BF16 KV cache, omit `--kv-cache-dtype fp8_e4m3`. To use only one HPC-Ops operator, specify only the corresponding backend option.

> **译：** 对于 BF16 KV cache，省略 `--kv-cache-dtype fp8_e4m3`。如只使用一个 HPC-Ops 算子，仅指定对应的后端选项。

### Router GEMM

In SGLang, HPC-Ops Router GEMM retains low-order information from FP32 router weights while executing the matrix math on BF16 Tensor Cores. The integrated path has been validated on LongCat-Flash Chat and Lite and is selected automatically for supported model and router shapes. Once HPC-Ops is installed, a standard LongCat-Flash launch can use it:

> **译：** 在 SGLang 中，HPC-Ops Router GEMM 在 BF16 Tensor Core 上执行矩阵运算的同时保留 FP32 路由器权重的低位信息。集成路径已在 LongCat-Flash Chat 和 Lite 上验证，对支持的模型和路由器形状自动选择。安装 HPC-Ops 后，标准 LongCat-Flash launch 即可使用：

```bash
python3 -m sglang.launch_server \
  --model meituan-longcat/LongCat-Flash-Lite-FP8
```

## Performance evaluation

The HPC-Ops backends currently support NVIDIA Hopper-architecture GPUs and deliver their best performance on H20. The evaluation below covers operator benchmarks on H20, end-to-end SGLang serving on 8× H20, and the H200 results reported in the upstream SGLang pull requests.

> **译：** HPC-Ops 后端目前支持 NVIDIA Hopper 架构 GPU，在 H20 上性能最佳。以下评估涵盖 H20 算子基准测试、8× H20 端到端 SGLang serving，以及上游 SGLang PR 中报告的 H200 结果。

### H20 operator benchmarks

**Attention.**

The Attention scheduler's headline benefit appears in mixed-length decode, where requests in the same batch can have very different KV-cache lengths. We evaluate FP8 KV-cache decode from uniform to highly skewed distributions; in the table, A×B denotes A requests with KV length B. To isolate the scheduling effect, we compare HPC-Ops dynamic scheduling with its static split-KV counterpart, while FlashInfer and FlashAttention provide additional baselines. The dynamic-vs-static gain grows with skew, from parity on the uniform 64×0.5K batch to **2.95×** on the 1×128K + 31×4K mix. Across all six cases, dynamic scheduling is on average **2.25× faster** than the best of FlashInfer and FlashAttention in each case.

> **译：** Attention 调度器的主要收益体现在变长 decode 中——同一 batch 中的请求可能具有差异很大的 KV cache 长度。我们评估从均匀到高度倾斜分布的 FP8 KV-cache decode；表中 A×B 表示 A 个请求 KV 长度为 B。为隔离调度效果，我们将 HPC-Ops 动态调度与其静态 split-KV 对应版本对比，FlashInfer 和 FlashAttention 提供额外基线。动态 vs 静态增益随倾斜增长，从均匀 64×0.5K batch 的持平到 1×128K + 31×4K 混合的 **2.95×**。全部六个用例中，动态调度平均比每个用例中 FlashInfer 和 FlashAttention 的最佳值快 **2.25×**。

*Table 1: Decode latency across KV-length distributions on H20. Lower is better.*

| Decode scenario | HPC-Ops dynamic | HPC-Ops static | FlashInfer | FlashAttention | Dynamic vs. static |
| --- | --- | --- | --- | --- | --- |
| 64×0.5K | 0.013 ms | 0.013 ms | 0.050 ms | 0.025 ms | 1.00× |
| 64×4K | 0.033 ms | 0.043 ms | 0.221 ms | 0.095 ms | **1.32×** |
| 32×0.125K + 32×4K | 0.020 ms | 0.033 ms | 0.119 ms | 0.053 ms | **1.59×** |
| 2×32K + 30×4K | 0.032 ms | 0.056 ms | 0.169 ms | 0.094 ms | **1.76×** |
| 1×64K + 15×4K | 0.042 ms | 0.097 ms | 0.118 ms | 0.065 ms | **2.32×** |
| 1×128K + 31×4K | 0.063 ms | 0.186 ms | 0.220 ms | 0.097 ms | **2.95×** |

![Dynamic scheduling becomes increasingly effective as live KV work grows more skewed. Lower is better.](/vibe-reading/images/articles/sglang-official-hpc-ops-kernels/fig-01-attention-dynamic-scheduling.png)

**Router GEMM.**

We evaluate Router GEMM first with a generic $K = 4096, N = 192$ sweep. Across the measured M values, HPC-Ops is **1.30–3.22× faster than FP32 cuBLAS** and **1.25–1.78× faster than TF32 cuBLAS**. Using FP32 cuBLAS as the numerical reference, the maximum absolute error remains at or below **0.00177**, compared with **0.06464** for TF32.

> **译：** 我们首先用通用 $K = 4096, N = 192$ 扫描评估 Router GEMM。在测量的 M 值范围内，HPC-Ops 比 FP32 cuBLAS 快 **1.30–3.22×**，比 TF32 cuBLAS 快 **1.25–1.78×**。以 FP32 cuBLAS 为数值参考，最大绝对误差保持在不高于 **0.00177**，TF32 为 **0.06464**。

*Table 2: BF16 × FP32 Router GEMM latency at K = 4096, N = 192 on H20. Lower is better.*

| M | HPC-Ops | FP32 cuBLAS | TF32 cuBLAS | Speedup vs. FP32 | Speedup vs. TF32 |
| --- | --- | --- | --- | --- | --- |
| 1 | 11.200 µs | 14.576 µs | 14.048 µs | **1.30×** | **1.25×** |
| 16 | 11.744 µs | 23.808 µs | 18.752 µs | **2.03×** | **1.60×** |
| 48 | 12.144 µs | 31.008 µs | 20.064 µs | **2.55×** | **1.65×** |
| 96 | 13.904 µs | 31.760 µs | 24.720 µs | **2.28×** | **1.78×** |
| 208 | 17.088 µs | 39.280 µs | 28.928 µs | **2.30×** | **1.69×** |
| 512 | 26.992 µs | 86.976 µs | 44.736 µs | **3.22×** | **1.66×** |
| 1024 | 50.640 µs | 110.480 µs | 68.544 µs | **2.18×** | **1.35×** |
| 2048 | 76.688 µs | 198.576 µs | 100.800 µs | **2.59×** | **1.31×** |
| 4096 | 141.120 µs | 403.728 µs | 205.760 µs | **2.86×** | **1.46×** |

![Router GEMM numerical error relative to FP32 cuBLAS (left) and latency versus FP32 and TF32 cuBLAS (right). Lower is better.](/vibe-reading/images/articles/sglang-official-hpc-ops-kernels/fig-02-router-gemm-cublas.png)

We then retest the two router shapes used by LongCat-Flash. Within SGLang's model-aware dispatch ranges, HPC-Ops delivers **1.06–2.83×** speedup for the Chat shape and **1.09–2.46×** for the Lite shape over the SGLang default.

> **译：** 我们随后重新测试 LongCat-Flash 使用的两个路由器形状。在 SGLang 的模型感知分发范围内，HPC-Ops 对 Chat 形状相对 SGLang 默认加速 **1.06–2.83×**，对 Lite 形状加速 **1.09–2.46×**。

*Table 3: LongCat-Flash Router GEMM latency over the SGLang dispatch ranges on H20. Lower is better.*

| M | Chat default | Chat HPC-Ops | Speedup | Lite default | Lite HPC-Ops | Speedup |
| --- | --- | --- | --- | --- | --- | --- |
| 64 | 39.19 µs | 37.01 µs | **1.06×** | — | — | — |
| 128 | 74.18 µs | 59.36 µs | **1.25×** | 25.83 µs | 23.72 µs | **1.09×** |
| 256 | 100.03 µs | 82.47 µs | **1.21×** | 41.87 µs | 34.01 µs | **1.23×** |
| 512 | 190.37 µs | 141.73 µs | **1.34×** | 71.89 µs | 41.95 µs | **1.71×** |
| 1024 | 380.68 µs | 207.00 µs | **1.84×** | 108.64 µs | 74.09 µs | **1.47×** |
| 2048 | 961.15 µs | 339.04 µs | **2.83×** | 235.81 µs | 106.81 µs | **2.21×** |
| 4096 | 1469.70 µs | 670.14 µs | **2.19×** | 423.52 µs | 172.44 µs | **2.46×** |
| 8192 | 2881.00 µs | 1333.84 µs | **2.16×** | 835.22 µs | 339.66 µs | **2.46×** |

![Router GEMM latency on the LongCat-Flash Chat (left) and Lite (right) shapes over SGLang's dispatch ranges. Lower is better.](/vibe-reading/images/articles/sglang-official-hpc-ops-kernels/fig-03-router-gemm-longcat.png)

**MoE.**

For MoE, we benchmark the full fused operation under Hy3 shapes at TP8 / EP1 and TP1 / EP8 against SGLang, vLLM Triton, and vLLM CUTLASS. Taking the lowest latency among the three baselines in each row, HPC-Ops delivers a mean per-batch speedup of **1.08× at TP8 / EP1** and **1.21× at TP1 / EP8**, with the largest gains at the small-to-mid batch sizes common in low-latency decode.

> **译：** 对于 MoE，我们在 Hy3 形状下以 TP8 / EP1 和 TP1 / EP8 对完整融合操作做基准测试，与 SGLang、vLLM Triton 和 vLLM CUTLASS 对比。取每行三个基线中最低延迟，HPC-Ops 在 TP8 / EP1 平均每 batch 加速 **1.08×**，TP1 / EP8 平均 **1.21×**，最大增益出现在低延迟 decode 常见的小到中 batch size。

*Table 4: Hy3 MoE latency at TP8 / EP1 on H20. Lower is better.*

| Batch | HPC-Ops | SGLang | vLLM Triton | vLLM CUTLASS | Speedup vs. best |
| --- | --- | --- | --- | --- | --- |
| 16 | 85.7 µs | 88.6 µs | 124.2 µs | 209.2 µs | **1.03×** |
| 32 | 124.0 µs | 137.2 µs | 184.3 µs | 275.6 µs | **1.11×** |
| 64 | 147.2 µs | 164.4 µs | 374.9 µs | 330.3 µs | **1.12×** |
| 128 | 161.5 µs | 179.9 µs | 302.9 µs | 345.3 µs | **1.11×** |
| 256 | 170.1 µs | 191.5 µs | 310.9 µs | 351.6 µs | **1.13×** |
| 512 | 194.5 µs | 230.1 µs | 331.6 µs | 369.2 µs | **1.18×** |
| 1024 | 281.4 µs | 300.5 µs | 652.7 µs | 438.3 µs | **1.07×** |
| 2048 | 491.8 µs | 522.5 µs | 731.5 µs | 794.4 µs | **1.06×** |
| 4096 | 872.0 µs | 899.2 µs | 1366.0 µs | 1230.7 µs | **1.03×** |
| 8192 | 1695.0 µs | 1712.7 µs | 2216.8 µs | 2362.9 µs | **1.01×** |
| 16384 | 3241.9 µs | 3257.1 µs | 4329.1 µs | 4364.4 µs | **1.00×** |

*Table 5: Hy3 MoE latency at TP1 / EP8 on H20. Lower is better.*

| Batch | HPC-Ops | SGLang | vLLM Triton | vLLM CUTLASS | Speedup vs. best |
| --- | --- | --- | --- | --- | --- |
| 4 | 118.6 µs | 183.1 µs | 147.4 µs | 140.4 µs | **1.18×** |
| 8 | 136.7 µs | 231.5 µs | 192.8 µs | 170.7 µs | **1.25×** |
| 16 | 149.8 µs | 234.2 µs | 198.4 µs | 263.5 µs | **1.32×** |
| 32 | 153.6 µs | 475.3 µs | 214.6 µs | 264.4 µs | **1.40×** |
| 64 | 166.5 µs | 477.3 µs | 358.1 µs | 266.8 µs | **1.60×** |
| 128 | 213.5 µs | 482.3 µs | 251.7 µs | 272.6 µs | **1.18×** |
| 256 | 386.2 µs | 494.3 µs | 454.9 µs | 493.5 µs | **1.18×** |
| 512 | 705.5 µs | 970.7 µs | 691.7 µs | 741.7 µs | 0.98× |
| 1024 | 1342.6 µs | 1476.8 µs | 1369.1 µs | 1359.1 µs | **1.01×** |
| 2048 | 2513.9 µs | 2871.2 µs | 2668.7 µs | 2530.4 µs | **1.01×** |

![Hy3 MoE latency across TP8 / EP1 and TP1 / EP8 configurations. Lower is better.](/vibe-reading/images/articles/sglang-official-hpc-ops-kernels/fig-04-hy3-moe.png)

### H200 operator validation

The upstream PRs also include H200 serving results, confirming that the performance gains generalize across Hopper GPUs.

> **译：** 上游 PR 还包含 H200 serving 结果，确认性能增益跨 Hopper GPU 泛化。

*Table 6: Operator validation reported in the upstream SGLang pull requests.*

| Operator | Upstream validation workload | Comparison | Result |
| --- | --- | --- | --- |
| FP8 Attention | Hy3-FP8 with FP8 KV cache; mixed-length decode | HPC-Ops dynamic scheduling vs. HPC-Ops static split-KV | Output throughput **+2.0%**; total throughput **+2.0%**; median TTFT **−5.3%** |
| BF16 Attention | Qwen3 with BF16 KV cache; mixed-length decode | HPC-Ops dynamic scheduling vs. HPC-Ops static split-KV | Output throughput **+3.0%**; mean E2E latency **−2.8%**; mean TPOT **−2.8%** |
| Router GEMM | LongCat-Flash Chat and Lite router shapes | HPC-Ops Router GEMM vs. SGLang default | Kernel speedup: **1.56–4.31×** |
| MoE | Qwen3 FP8 MoE workloads from 1 to 4,096 tokens | HPC-Ops MoE vs. SGLang Triton fused experts | Kernel speedup: **0.89–4.21×** |

### End-to-end performance

The end-to-end evaluation runs on 8× NVIDIA H20 GPUs against the corresponding default SGLang implementations. On Hy3-FP8 at TP8 with FP8 KV cache, we measure the combined serving impact by enabling HPC-Ops Attention and MoE together. On LongCat-Flash-Lite-FP8, only Router GEMM is measured. We also summarize the H200 serving validation reported in the upstream SGLang pull requests.

> **译：** 端到端评估在 8× NVIDIA H20 GPU 上针对对应的 SGLang 默认实现运行。在 Hy3-FP8 TP8 配 FP8 KV cache 上，我们通过同时启用 HPC-Ops Attention 和 MoE 测量组合 serving 影响。在 LongCat-Flash-Lite-FP8 上，仅测量 Router GEMM。我们还汇总上游 SGLang PR 中报告的 H200 serving 验证。

**Hy3-FP8: Attention and MoE.**

With an 8K input and 4K output, HPC-Ops reduces TPOT by **3.3% at batch size 1**. Across batch sizes 4–64, the reduction grows to **15.1–48.8%**.

> **译：** 8K 输入 4K 输出下，HPC-Ops 在 batch size 1 降低 TPOT **3.3%**。batch size 4–64 范围内，降幅增长到 **15.1–48.8%**。

*Table 7: Hy3-FP8 TPOT with FP8 KV cache and HPC-Ops Attention and MoE enabled together. Lower is better.*

| Batch | SGLang default | HPC-Ops | Improvement |
| --- | --- | --- | --- |
| 1 | 7.56 ms | 7.31 ms | **3.3%** |
| 4 | 11.10 ms | 9.42 ms | **15.1%** |
| 8 | 14.29 ms | 10.76 ms | **24.7%** |
| 16 | 22.90 ms | 13.09 ms | **42.8%** |
| 32 | 35.33 ms | 18.09 ms | **48.8%** |
| 64 | 40.70 ms | 23.81 ms | **41.5%** |

With an 8K input, HPC-Ops improves TTFT by **3.3–9.0% across batch sizes 1–16**.

> **译：** 8K 输入下，HPC-Ops 在 batch size 1–16 范围内改善 TTFT **3.3–9.0%**。

*Table 8: Hy3-FP8 TTFT with FP8 KV cache for an 8K input. Positive improvements mean lower latency.*

| Batch | SGLang default | HPC-Ops | Improvement |
| --- | --- | --- | --- |
| 1 | 460.67 ms | 419.43 ms | **9.0%** |
| 4 | 1612.47 ms | 1533.66 ms | **4.9%** |
| 8 | 3210.93 ms | 3018.68 ms | **6.0%** |
| 16 | 5810.53 ms | 5619.48 ms | **3.3%** |

At batch size 16, we also sweep the input length from 2K to 8K with chunked prefill and prefix caching disabled. HPC-Ops improves TTFT by **2.3–8.9%** across the three input lengths.

> **译：** 在 batch size 16 下，我们还关闭 chunked prefill 和 prefix caching，从 2K 扫到 8K 输入长度。HPC-Ops 在三个输入长度上改善 TTFT **2.3–8.9%**。

*Table 9: Hy3-FP8 TTFT with FP8 KV cache across input lengths at batch size 16. Positive improvements mean lower latency.*

| Input length | SGLang default | HPC-Ops | Improvement |
| --- | --- | --- | --- |
| 2K | 1509.98 ms | 1375.95 ms | **8.9%** |
| 4K | 2779.46 ms | 2715.18 ms | **2.3%** |
| 8K | 5810.53 ms | 5619.48 ms | **3.3%** |

**LongCat-Flash-Lite-FP8: Router GEMM.**

Router GEMM is evaluated separately with a 1,024-token input and a 128-token output. Input throughput remains near parity at batch size 1, with a **0.5% improvement**, and improves by **5.5–6.1%** across batch sizes 4–64.

> **译：** Router GEMM 以 1,024-token 输入和 128-token 输出单独评估。batch size 1 时输入吞吐接近持平，提升 **0.5%**，batch size 4–64 范围内提升 **5.5–6.1%**。

*Table 10: LongCat-Flash-Lite-FP8 input throughput with HPC-Ops Router GEMM. Higher is better.*

| Batch | SGLang default | HPC-Ops Router GEMM | Improvement |
| --- | --- | --- | --- |
| 1 | 16,612.11 tok/s | 16,695.77 tok/s | **0.5%** |
| 4 | 54,466.27 tok/s | 57,810.27 tok/s | **6.1%** |
| 8 | 60,425.93 tok/s | 63,833.96 tok/s | **5.6%** |
| 16 | 61,995.23 tok/s | 65,539.10 tok/s | **5.7%** |
| 32 | 62,833.85 tok/s | 66,306.52 tok/s | **5.5%** |
| 64 | 62,841.93 tok/s | 66,422.92 tok/s | **5.7%** |

![End-to-end SGLang results. The three Hy3-FP8 panels use FP8 KV cache with HPC-Ops Attention and MoE enabled together; the bottom-right panel isolates Router GEMM.](/vibe-reading/images/articles/sglang-official-hpc-ops-kernels/fig-05-sglang-end-to-end.png)

### H200 serving validation

The upstream pull requests also evaluated the integrated operators in the SGLang serving loop on H200, providing a model-level integration check beyond the primary H20 tuning target.

> **译：** 上游 PR 还在 H200 上的 SGLang serving 循环中评估了集成算子，提供超越 H20 主调优目标的模型级集成检查。

*Table 11: Model-level serving validation reported in the upstream SGLang pull requests.*

| Operator | Upstream validation workload | Comparison | Result |
| --- | --- | --- | --- |
| Attention | Hy3-FP8 with FP8 KV cache serving workloads | HPC-Ops Attention vs. FlashAttention | Output throughput: **+3.7–5.9%** |
| Router GEMM | LongCat-Flash Lite prefill serving workloads | HPC-Ops Router GEMM vs. SGLang default | Input throughput: **+2.8–5.4%** |
| MoE | Qwen3 and Hy3 FP8 MoE serving workloads | HPC-Ops MoE vs. SGLang default | Output throughput: Qwen3 from parity to **+2.7%**; Hy3 **−4.2% to +6.3%** |

The upstream integrations were also checked for numerical and model-level fidelity. Attention tests passed across BF16 and FP8, and the evaluated Hy3 FP8 greedy outputs matched the BF16 path token for token. Router GEMM passed comparisons against the FP32 reference and preserved greedy outputs. For Qwen3, the HPC-Ops MoE path matched Triton's error against FP32, with a cosine similarity of **0.99974** and a maximum relative error of **0.024**. Full configurations and per-case results are available in the upstream PRs.

> **译：** 上游集成还检查了数值和模型级保真度。Attention 测试在 BF16 和 FP8 上通过，评估的 Hy3 FP8 greedy 输出逐 token 匹配 BF16 路径。Router GEMM 通过了与 FP32 参考的比较并保留 greedy 输出。对于 Qwen3，HPC-Ops MoE 路径匹配 Triton 相对 FP32 的误差，余弦相似度 **0.99974**，最大相对误差 **0.024**。完整配置和逐用例结果见上游 PR。

## What's next

This work is part of a broader collaboration between HPC-Ops and the SGLang community. We will continue working with SGLang maintainers and contributors to improve and extend these operators and upstream additional HPC-Ops capabilities as they mature. Feedback, issues, and benchmarks are very welcome, and we look forward to advancing open, high-performance LLM inference together.

> **译：** 这项工作是 HPC-Ops 与 SGLang 社区更广泛合作的一部分。我们将继续与 SGLang 维护者和贡献者合作改进和扩展这些算子，并在成熟时上游更多 HPC-Ops 能力。欢迎反馈、issue 和基准测试，期待共同推进开放、高性能的 LLM 推理。

## Acknowledgments

We would like to thank the many people across teams who worked together to bring these operators to SGLang:

> **译：** 我们感谢跨团队协力将这些算子带入 SGLang 的众多同仁：

- **Tencent Hunyuan AI Infra** — for building and optimizing the HPC-Ops Attention, Router GEMM, and MoE operators and contributing them to SGLang. Sethran Liu, Chase Shao, Shengy Wei, Theo Cheng, Ryann Xue, Lando Jiang, Looper Zhao, Haank Lin, Aiden Ren, Lehua Ding, Chengv Jiang, Steven Kuang, Liqi He, Kipper Gong, Reedlau Liu, Raccoon Liu, Dick Zhu.
- **Tencent Network Platform Department** — for the close collaboration on communication optimization. Xuan Zhang, Haoran Zhao, Yuanyuan Gong, Yadong Liu, Jinzhu Wang, Yinben Xia, Xiang Li, Quan Wen, Zekun He.
- **SGLang** — for the open backend interfaces, reviews, and design discussions. Xiaoyu Zhang (BBuf), Xinyuan Tong, Ke Bao, and the entire SGLang team.
- **NVIDIA** — for the close collaboration on kernel and performance optimization. Yuanhang Sun, Perkz Zheng, Yuxi Chi, Jiang Shao, Jun Gu, Meng Wang, River Liu, Gary Ji, Chandler Zhou.

> **译：**
>
> - **腾讯混元 AI Infra** — 构建和优化 HPC-Ops Attention、Router GEMM 和 MoE 算子并贡献给 SGLang。Sethran Liu, Chase Shao, Shengy Wei, Theo Cheng, Ryann Xue, Lando Jiang, Looper Zhao, Haank Lin, Aiden Ren, Lehua Ding, Chengv Jiang, Steven Kuang, Liqi He, Kipper Gong, Reedlau Liu, Raccoon Liu, Dick Zhu。
> - **腾讯网络平台部** — 通信优化的紧密合作。Xuan Zhang, Haoran Zhao, Yuanyuan Gong, Yadong Liu, Jinzhu Wang, Yinben Xia, Xiang Li, Quan Wen, Zekun He。
> - **SGLang** — 开放的后端接口、审查和设计讨论。Xiaoyu Zhang (BBuf), Xinyuan Tong, Ke Bao, 以及整个 SGLang 团队。
> - **NVIDIA** — 内核和性能优化的紧密合作。Yuanhang Sun, Perkz Zheng, Yuxi Chi, Jiang Shao, Jun Gu, Meng Wang, River Liu, Gary Ji, Chandler Zhou。

We also thank the broader open-source kernel community whose work this builds on and measures against, including NVIDIA CUTLASS/CuTe, TensorRT-LLM, FlashInfer, FlashAttention, and Triton.

> **译：** 我们还感谢更广泛的开源内核社区，这些工作建立在其之上并以其为测量基准，包括 NVIDIA CUTLASS/CuTe、TensorRT-LLM、FlashInfer、FlashAttention 和 Triton。
