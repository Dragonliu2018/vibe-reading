---
title: "FlashInfer: Efficient and Customizable Attention Engine for LLM Inference Serving"
source:
  type: "论文解读"
  project: "FlashInfer"
  url: "https://arxiv.org/abs/2501.01005"
  pdf: "/vibe-reading/papers/flashinfer-attention-engine-llm-serving.pdf"
date: "2026-07-27"
category: [AI, Infra, Inference, FlashInfer, Papers]
tags: ["LLM Serving", "Attention", "FlashInfer", "KV Cache", "Block-Sparse", "JIT", "CUDAGraph", "vLLM", "SGLang"]
description: "目的：为 LLM 推理提供统一高效的 attention 引擎。手段：block-sparse 统一 KV cache 格式 + 可定制 attention 模板 JIT 编译 + 负载均衡调度兼容 CUDAGraph。结论：相比 Triton 后端 inter-token 延迟降 29-69%，长上下文降 28-30%，并行生成加速 13-17%。"
readingTime: "16 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/flashinfer-attention-engine-llm-serving.pdf" target="_blank" rel="noopener">预览</a> · **论文** [FlashInfer: Efficient and Customizable Attention Engine for LLM Inference Serving](https://arxiv.org/abs/2501.01005) · **作者** Zihao Ye, Lequn Chen, Ruihang Lai, Wuwei Lin, Yineng Zhang, Stephanie Wang, Tianqi Chen, Baris Kasikci, Vinod Grover, Arvind Krishnamurthy, Luis Ceze（UW / NVIDIA / Perplexity AI / CMU）· **发表** MLSys '25, 2025 · **项目** http://flashinfer.ai · **解读** 2026-07-27

---

## 1. 论文概览

**一句话**：FlashInfer 把 LLM 推理里五花八门的 KV cache 存储格式（PageAttention 的 page table、SGLang 的 radix tree、tree attention 的 mask、importance mask）统一成一个**block-sparse 矩阵**抽象，再配上一套可定制的 attention 模板（JIT 编译变体）和一个与 CUDAGraph 兼容的负载均衡调度器，从而用一个引擎覆盖了 vLLM / SGLang / MLC-Engine 三大主流服务框架的 attention 需求。

- **任务**：LLM 在线推理的 attention kernel——既要高性能，又要能适配多样的工作负载（prefill / decode / parallel sampling / beam search / tree decoding）和多样的硬件（Turing→Hopper）与 attention 变体（MHA / GQA / sliding window / soft-cap / FlashSigmoid）。
- **核心痛点**：现有系统各自实现一套专用 attention 方案，覆盖子集、维护成本高、效率参差。两大挑战是 **workload diversity**（输入长度动态、batch 内长短不一、负载不均）和 **hardware heterogeneity**（存储格式各异、GPU 架构各异、attention 变体层出不穷）。
- **核心方法**：三件套——(1) **block-sparse 统一格式 + composable formats**；(2) **可定制 attention 模板 + JIT 编译**；(3) **动态负载均衡调度 + CUDAGraph 兼容**。
- **take-home**：把"分页/基数树/树形 mask"统统看成稀疏矩阵的稀疏块，attention kernel 就只需处理一种数据结构；把"变体差异"收敛成几个可插拔 functor（QueryTransform/LogitsTransform/...），JIT 生成 CUDA；把"动态调度"和"静态图捕获"用 Inspector-Executor 模式分离——plan 在 CPU 动态算，run 落进 CUDAGraph 静态回放。这套抽象让 FlashInfer 被三大框架采纳。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Transformers, driven by attention mechanisms, form the foundation of large language models (LLMs). As these models scale up, efficient GPU attention kernels become essential for high-throughput and low-latency inference. Diverse LLM applications demand flexible and high-performance attention solutions. We present FlashInfer: a customizable and efficient attention engine for LLM serving. FlashInfer tackles KV-cache storage heterogeneity using block-sparse format and composable formats to optimize memory access and reduce redundancy. It also offers a customizable attention template, enabling adaptation to various settings through Just-In-Time (JIT) compilation. Additionally, FlashInfer's load-balanced scheduling algorithm adjusts to dynamism of user requests while maintaining compatibility with CUDAGraph which requires static configuration. FlashInfer have been integrated into leading LLM serving frameworks like SGLang, vLLM and MLC-Engine. Comprehensive kernel-level and end-to-end evaluations demonstrate FlashInfer's ability to significantly boost kernel performance across diverse inference scenarios: compared to state-of-the-art LLM serving solutions, FlashInfer achieve 29-69% inter-token-latency reduction compared to compiler backends for LLM serving benchmark, 28-30% latency reduction for long-context inference, and 13-17% speedup for LLM serving with parallel generation.

> **译：** Transformer 以 attention 机制为核心，构成了大语言模型的基础。模型规模扩大时，高效 GPU attention kernel 对高吞吐低延迟推理至关重要。多样的 LLM 应用需要灵活且高性能的 attention 方案。我们提出 FlashInfer：一个可定制、高效的 LLM 服务 attention 引擎。FlashInfer 用 block-sparse 格式与 composable formats 解决 KV cache 存储异构问题，优化访存、消除冗余；提供可定制 attention 模板，通过 JIT 编译适配各种设定；其负载均衡调度算法适应请求动态性，同时保持与要求静态配置的 CUDAGraph 兼容。FlashInfer 已集成进 SGLang、vLLM、MLC-Engine 等主流框架。kernel 级与端到端评测表明：相比 SOTA LLM 服务方案，FlashInfer 在 LLM serving benchmark 上 inter-token 延迟降低 29–69%（对比编译器后端），长上下文推理延迟降低 28–30%，并行生成加速 13–17%。

</details>

---

## 2. 研究背景

### 2.1 FlashAttention 与算子强度

FlashAttention 用 **online-softmax** 技巧把 attention 的中间矩阵挡在片上常数显存里，避免在 GPU global memory 物化注意力矩阵。其算子强度为 $O\!\left(\frac{1}{1/l_{qo}+1/l_{kv}}\right)$，其中 $l_{qo}$、$l_{kv}$ 分别是 query 和 KV cache 长度。LLM 服务里 query 长度 ≤ KV cache 长度（prefill 相等、decode 更短），算子强度简化为 $O(l_{qo})$。

- **MQA/GQA** 把多个 query head 共享同一组 KV，group size $g = H_{qo}/H_{kv}$，算子强度提升到 $O(g \cdot l_{qo})$——这是现代 LLM（Llama 系等）省 KV cache 又保算子强度的标准做法。
- **FlashAttention2/3** 进一步优化 loop 顺序与流水线，分别针对 Ampere 与 Hopper。FlashInfer 在此之上构建。

### 2.2 Attention 的可组合性（composability）

Block-Parallel Transformer 证明：**同一个 query 对不同 key/value 集合的 attention 输出可以组合**——只要保留 attention 输出 $O(I)$ 和它的 scale $LSE(I)$（log-sum-exp），就能把两个集合的结果合并。定义 attention state 为 $[O(I), LSE(I)]$，组合算子 $\opl$ 满足结合律与交换律：

$$
\begin{bmatrix} O(I \cup J) \\ LSE(I \cup J) \end{bmatrix}
= \begin{bmatrix} O(I) \\ LSE(I) \end{bmatrix} \oplus \begin{bmatrix} O(J) \\ LSE(J) \end{bmatrix}
$$

Ring-Attention、Flash-Decoding 都利用这一性质把 attention 拆到不同设备/不同 chunk 上并行算再合并。**FlashInfer 把 attention state 作为 attention 运算的标准输出、$\oplus$ 作为标准归约算子**（类比 GEMM 里的求和），这是其调度器能做 chunk 划分与合并的基础。

### 2.3 Block/Vector 稀疏

Block Compressed Sparse Row（BSR）把非零元聚成 $(b_r, b_c)$ 的连续小块，比 CSR 更适合 GPU 的 tensor core（mma 指令最小维度 16）。传统 block-sparse kernel 用 $(128,128)$ 或 $(16,16)$ 块。但近期工作（vector sparse）证明：先 gather 到连续 shared memory 再用 dense tensor core，可以用 $(16,1)$ 或 $(1,16)$ 这种向量级小块，对细粒度稀疏更友好。**FlashInfer 把这一技术推广到 FlashAttention，支持任意 $(B_r, B_c)$ 块大小**——这是它能统一 page table（$B_c=1$，page=1 token）等细粒度格式的前提。

### 2.4 现有系统的问题

- **存储格式碎片化**：vLLM 的 PageAttention 用 page table，SGLang 的 RadixAttention 用基数树，speculative decoding 用 tree attention mask，KV cache 压缩用 importance mask——每类都需专用 kernel。
- **attention 变体爆炸**：GQA、sliding window、logits soft-cap（Grok/xAI）、FlashSigmoid、ALiBi bias……每个变体手写专用 CUDA 不可持续。
- **动态性与静态图矛盾**：LLM 服务每步序列长度都在变，负载不均需动态调度；但 CUDAGraph 要求配置静态。现有方案难以兼顾。

---

## 3. 方法详解

![图1 FlashInfer 系统总览：attention 变体规格 + 任务信息 + KV cache 布局在编译期给 JIT；序列长度信息在运行时给调度器](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-01-system-overview.png)

FlashInfer 分三块：**KV cache 存储**（§3.1，统一格式）、**计算抽象**（§3.2，模板与 JIT）、**动态感知运行时**（§3.3，调度）。

### 3.1 KV Cache 存储：block-sparse 作为统一格式

#### 3.1.1 把 page table 看成 BSR 矩阵

PageAttention 的 page table、RadixAttention 的基数树、tree attention 的 mask、importance mask——论文证明这些看似不同的数据结构，都能统一成 **block-sparse 矩阵**。直觉：page table 里"哪些物理 page 被该请求的 query 访问"正是一个稀疏关系——query 为行、KV block 为列，被访问的块是非零块。

![图2 Page table 在 BSR (Br=4, Bc=1) 格式下的表示：列块数等于 page table 分配的总块数，非零块代表 query 访问的 KV cache page](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-02-pagetable-bsr.png)

具体实现：

- **Query / Output**：用 ragged tensor（jagged array）无 padding 紧凑存放多个请求的 query/output。
- **KV cache**：BSR 格式。块大小 $(B_r, B_c)$ 中，$B_r$ = query tile size，$B_c$ 由 KV cache 管理算法决定（page table 场景 $B_c=1$，即一个 page = 一个 token 的 KV）。FlashInfer kernel 支持任意 $(B_r, B_c)$。
- 这一抽象与 SPGrid（用 TLB 硬件索引稀疏结构）思想相通，但 FlashInfer 落在 attention kernel 层。

#### 3.1.2 Composable Formats：多种块大小组合存

单一 BSR 格式受限于固定 $B_r$：$B_r$ 大 → 同块内请求能共享 KV，shared memory/寄存器复用好，但碎片增加；$B_r$ 小 → 灵活但只能走 global memory/L2。

**Composable formats** 允许用**多个** block-sparse 矩阵存同一份 KV cache，按先验知识拆分：

![图3 Composable formats：共享前缀用大块 (3,1) 存进高带宽 shared memory，独有后缀用小块 (1,1) 走 global memory](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-03-composable-formats.png)

- **共享前缀**（多个请求共有的 prompt 前缀）：用大 $B_r$（如 $(3,1)$）的 block-sparse 矩阵存，让多个 query 在同一 threadblock 内通过 shared memory/寄存器共享访问 KV。
- **独有后缀**（各请求不同的生成部分）：用小 $B_r$（如 $(1,1)$）的 block-sparse 矩阵存，每个 query 在自己 threadblock 走 global memory/L2。
- **无需数据搬运**：只是计算稀疏子矩阵的 indices 和 index pointer 数组，KV cache 数据本身不动。

这比 RelayAttention / Hydragen / Parrot 等"前后缀分离管理"方案更通用——FlashInfer 支持多级、多前缀，且统一在 page table 管理下，无需改动服务框架的内存管理。

### 3.2 计算抽象：模板 + JIT

#### 3.2.1 从 global 到 shared memory 的数据搬运

FlashInfer 支持任意块大小，但 tensor core 的 mma 指令要求固定形状，所以要把稀疏 tile 从 global memory 搬到连续 shared memory 再做 dense 计算：

![图4 稀疏/稠密 KV cache 从 global 到 shared memory 的数据搬运：稀疏用 BSR indices 寻址，稠密用仿射变换](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-04-global-shared.png)

- 稀疏 KV cache：用 BSR 的 indices 数组算地址 `j = indices[(offset+i)/b_c] + (offset+i)%b_c`。
- 稠密 KV cache：直接仿射 `j = offset+i`。
- 两者都用 128B 宽的 `LDGSTS` 异步拷贝最大化带宽。Hopper 的 TMA 虽更快但不支持非仿射访问，故只对连续 KV cache 用 TMA，其余回退 Ampere 风格异步拷贝。
- 搬到 shared memory 后，稀疏与稠密的 FlashAttention 实现收敛，仅数据加载模块不同。

#### 3.2.2 多 tile size 适配算子强度

传统 FA2 只有少量 tile size（如 $(128,64)$），对 A100 prefill 最优但对短 query 的 decode 低效；Ada（sm89）shared memory 小，大 tile 进一步降低占用。FlashInfer 提供 tile size 组合 $(1,16,32,64,128) \times (32,64,128)$，按启发式选：

1. 按 batch 平均 query 长度（GQA 时融合 head group 维，见附录 A）选最小够用的 query tile size。
2. 把寄存器/shared memory 约束写成 K/V tile size 的函数，最大化 SM 资源占用。
3. query tile size 1 用 CUDA Cores（因 mma 最小 m=16）；其余用 Tensor Cores；FA3 在 Hopper 上用 64 倍数的 row tile 对齐 WGMMA。$B_r$ 对齐 query tile size $T_q$。

#### 3.2.3 JIT 编译 attention 变体

现代 LLM 的 attention 变体越来越多（sliding window、soft-cap、FlashSigmoid、ALiBi……）。每个手写专用 CUDA 不可持续。但绝大多数变体与 vanilla attention 结构相同，只是局部修改。受 FlexAttention 启发，FlashInfer 设计**可定制 CUDA 模板 + JIT 编译器**：

变体用一组 **functor** 描述：

- `QueryTransform` / `KeyTransform` / `ValueTransform`：attention 计算前对 Q/K/V 的变换（可融合 RoPE、normalization、projection）。
- `LogitsTransform` / `LogitsMask`：softmax 前对 logits 的变换/掩码（custom mask、logits soft-cap、sliding window）。
- `OutputTransform`：返回前对输出的变换。
- 可选 `use_softmax=false`，支持不用 softmax 的变体（如 FlashSigmoid）。

![图5 JIT 编译器：FlashSigmoid 的 CUDA 代码字符串定义变体 functor，填入模板生成 kernel，注册为 PyTorch custom op](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-05-jit-compiler.png)

用户用一段 CUDA 代码字符串定义这些 functor（如 FlashSigmoid 的 `LogitsTransform` 返回 `1/(1+exp(-(score*scale+bias)))`），JIT 编译器把变体类与类型信息填进模板生成 CUDA，用 PyTorch JIT 编译并注册为 custom op。也支持 DLPack 接口编译到其他运行时。相比 FlexAttention（用 Triton），FlashInfer 选 CUDA/CUTLASS 是因为 Triton 在不少场景仍不及 CUDA。

### 3.3 动态感知运行时

#### 3.3.1 负载均衡调度

LLM 服务每步序列长度都变，naive 实现会负载不均。FlashInfer 的调度器（Algorithm 1）目标是最小化 SM 空闲，把工作均匀分到所有 SM：

```
输入：各请求 {lqo(i), lkv(i)}，query tile size Tq
1. 定义 tile 代价 cost(lq,lkv) = α·lq + β·lkv
2. 算最大 KV chunk 大小 Lkv = Σ⌈lqo(i)/Tq⌉·lkv(i) / #CTA
3. 把每个 query tile 的 KV 切成 ≤ Lkv 的 chunk，每个 chunk 一个 work index w
4. W = {(w, lkv(w))}，按长度降序排
5. Q = 优先队列 {(cta_idx, 0)}
6. while W 非空：
7.   弹出当前 cost 最小的 CTA c
8.   从 W 弹出最长 chunk w
9.   new_cost = current_cost + cost(Tq, lkv(w))
10.  把 chunk w 分给 CTA c
11.  把 (c, new_cost) 推回 Q
```

灵感来自 Stream-K，但 LLM 服务要求**确定性输出**，所以不用 Stream-K 的原子聚合（会非确定），而是生成确定的聚合顺序。长 KV 被切成多 chunk，最终输出是所有 chunk 部分输出经 attention composition（§2.2 的 $\opl$）的归约。

![图6 FlashInfer 运行时调度器：序列长度信息输入，产出 (1) 每个 CTA 的 work 队列 (2) partial→final 输出的索引映射，缓存在 GPU 侧供 persistent kernel 使用](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-06-runtime-scheduler.png)

调度器每个生成步在 CPU 上跑一次产 plan 信息，异步拷到 GPU workspace 的特定区域，供 persistent attention/contraction kernel 使用。开销可被多层 amortize——同一 plan 信息能复用于所有层。

#### 3.3.2 与 CUDAGraph 兼容

CUDAGraph 要求 kernel grid size 等配置静态。FlashInfer 的解法：

- attention 与 contraction 两阶段都用 **persistent kernel**，grid size 编译后固定，每步用同样 grid size launch。
- workspace buffer 各区段（partial outputs、plan info）用**固定偏移**，保证传给 kernel 的指针每步相同。
- 两阶段合并成一个 persistent kernel，消除 intra-kernel 开销。

#### 3.3.3 编程接口（Inspector-Executor 模式）

```python title="FlashInfer PyTorch 接口（简化）"
workspace = torch.empty(...)
seqlen_info.init()
# Init: 按规格 JIT 编译 kernel
attn = AttentionWrapper(attn_spec, task_info, workspace)
graphs = []
for task_info in task_infos:
    g = torch.cuda.CUDAGraph()
    attn.plan(seqlen_info)           # dummy plan
    with torch.cuda.graph(g):        # 捕获
        for layer in layers:
            attn.run(...)
    graphs.append(g)
# Runtime: 选最佳 CUDAGraph
while not finished:
    seqlen_info.update()
    attn.plan(seqlen_info)           # CPU 动态算 plan（不被 graph 捕获）
    g = select_graph(graphs)
    g.replay()                       # 回放静态图
```

`plan`（CPU 动态算调度）与 `run`（GPU 静态执行）分离，正是 **Inspector-Executor** 模式——plan 不被 CUDAGraph 捕获（在 CPU），run 被捕获回放。composable formats 时为不同 block size 各建一个 wrapper、各捕获一张 graph，运行时按当前 KV 配置选最优 graph。

---

## 4. 关键公式解读

### 4.1 Attention 可组合性（核心代数基础）

对 query $q$ 和索引集 $I$，定义 attention scale 与输出：

$$
LSE(I) = \log \sum_{i \in I} \exp(q \cdot k_i), \quad O(I) = \sum_{i \in I} \frac{\exp(q \cdot k_i)}{\exp(LSE(I))} v_i
$$

两集合 $I, J$ 的 state 可组合：

$$
\begin{bmatrix} O(I \cup J) \\ LSE(I \cup J) \end{bmatrix}
= \begin{bmatrix} O(I) \\ LSE(I) \end{bmatrix} \oplus \begin{bmatrix} O(J) \\ LSE(J) \end{bmatrix}
= \begin{bmatrix} \frac{\exp(LSE(I))O(I)+\exp(LSE(J))O(J)}{\exp(LSE(I))+\exp(LSE(J))} \\ \log(\exp(LSE(I))+\exp(LSE(J))) \end{bmatrix}
$$

$\oplus$ 结合且交换，所以多块可任意顺序合并。**这是 FlashInfer 调度器能把长 KV 切 chunk 分给不同 CTA、最后归约的数学保证**。

### 4.2 BSR 寻址

稀疏 KV cache 的 shared memory 加载地址由 BSR indices 数组决定：

$$
j = \text{indices}\!\left[\left\lfloor \frac{\text{offset}+i}{B_c} \right\rfloor\right] + ((\text{offset}+i) \bmod B_c)
$$

稠密情况退化为仿射 $j = \text{offset}+i$。两者加载到 shared memory 后 attention 计算一致。

### 4.3 算子强度与 GQA group size

FlashAttention 算子强度 $O\!\left(\frac{1}{1/l_{qo}+1/l_{kv}}\right)$，LLM 服务里 $l_{qo} \le l_{kv}$ 简化为 $O(l_{qo})$。GQA 下 group size $g = H_{qo}/H_{kv}$ 把算子强度提到 $O(g \cdot l_{qo})$——解释了为何 GQA 不仅是省 KV cache，还提升了 kernel 计算密度。

---

## 5. 实验设置

| 维度 | 配置 |
| --- | --- |
| **GPU** | NVIDIA A100 40GB SXM、H100 80GB SXM |
| **软件** | CUDA 12.4、PyTorch 2.4.0、f16 存储与计算 |
| **模型** | Llama 3.1 8B（1×H100）、Llama 3.1 70B（4×H100）、Vicuna-13B |
| **工作负载** | ShareGPT（真实 ChatGPT 对话）、Alpaca（指令）、合成 Variable（长度 512–2048 均匀）、WMT16 英德翻译（共享前缀）、MT-Bench（chatbot） |
| **基线** | SGLang + Triton v3.0 后端；kernel 级对比 FlashAttention（main 分支，含 FA2+FA3） |
| **指标** | TTFT（time-to-first-token）、ITL（inter-token-latency）、normalized latency；带宽利用率、FLOPs 利用率 |
| **集成** | 已集成进 SGLang v0.3.4、vLLM、MLC-Engine |

---

## 6. 实验结果

### 6.1 端到端服务性能

![图7 SGLang+FlashInfer vs SGLang+Triton 的 ITL 与 TTFT：8B/70B 在 ShareGPT/Variable 上全程领先](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-07-e2e-itl-ttft.png)

SGLang 集成 FlashInfer 后端，对比 Triton 后端在 Llama 3.1 8B/70B、ShareGPT/Variable 负载下 **ITL 与 TTFT 全场景一致领先**。论文宣称相比编译器后端 inter-token 延迟降低 **29–69%**。

### 6.2 输入动态性下的 kernel 性能

![图8 decode 与 prefill kernel 的带宽/FLOPs 利用率：FlashInfer 在 uniform/skewed 分布下显著优于 FlashAttention](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-08-kernel-perf.png)

固定 batch=16，测 constant/uniform/skewed 三种序列长度分布：

- **uniform 与 skewed 下 FlashInfer 显著优于 FlashAttention**——归功于负载均衡动态调度器（§3.3.1）。FlashAttention 在变长 batch 上负载不均。
- **decode 下 FlashInfer 优于 FlashAttention**——归功于灵活 tile size 选择（§3.2.2），FlashAttention 用了次优 tile size。
- constant 分布下两者接近（本就无负载不均问题）。

### 6.3 长上下文可定制性：Streaming-LLM

![图9 Streaming-LLM 端到端 ITL 与 fused RoPE kernel 带宽利用率：FlashInfer fused kernel 降 28-30% 延迟、1.6-3.7× 带宽](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-09-streaming-llm.png)

Streaming-LLM（百万 token 推理、常量显存）需要 RoPE 与 attention 融合的专用 kernel。FlashInfer 只用 **~20 行** QueryTransform/KeyTransform 代码就 JIT 出该 fused kernel：

- 端到端 ITL 比 FlashAttention 未融合方案降 **28–30%**（不同 recent window size 下）。
- kernel 级带宽利用率比 FlashAttention 未融合高 **1.6–3.7×**——证明 attention 可定制性的必要性（不融合就要多一次显存往返）。

### 6.4 并行生成的 composable formats

![图10 MLC-Engine 开/关 composable formats 的 ITL/TTFT：中等并行度(4≤n≤32)一致加速，n=4 峰值 ITL 降 13.73%、TTFT 降 16.41%](/vibe-reading/images/articles/flashinfer-attention-engine-llm-serving/fig-10-parallel-gen.png)

在 MLC-Engine 的 prefix-caching 配置下，对比开/关 composable formats，并行度 $n \in \{1,2,4,8,16,32,64\}$：

- 中等并行度（$4 \le n \le 32$）一致加速。峰值在 $n=4$：8B 模型 ITL 降 13.73%、70B 降 17.42%；TTFT 8B 降 16.41%、70B 降 22.86%。
- $n$ 太小：block size 增益不足，无收益。
- $n$ 太大：计算不再由 attention 主导（ShareGPT 短序列），优势趋平。
- 整体并行生成加速 **13–17%**。

### 6.5 关键数值汇总

| 场景 | FlashInfer 优势 |
| --- | --- |
| 端到端 ITL（vs Triton 后端） | 降 29–69% |
| 长上下文推理延迟 | 降 28–30% |
| 并行生成 | 加速 13–17% |
| Streaming-LLM fused RoPE 带宽 | 1.6–3.7× |
| 集成框架 | SGLang / vLLM / MLC-Engine |

---

## 7. 消融实验

### 7.1 kernel 微基准：动态调度的代价与收益

负载均衡调度带来额外开销——查 block table、额外分支、处理变长序列。相比高度优化的 FasterTransformer attention kernel，FlashInfer 的 attention kernel 延迟高 **20–26%**。但作者论证可接受：只影响 attention 算子不影响 Linear；端到端仍远胜（§6）。

### 7.2 block size 影响（默认 16）

- 太小：GPU 并行度不足，读/处理 KV cache 硬件利用率低。
- 太大：内部碎片增加、共享概率下降。
- ShareGPT 上 16–128 最佳；Alpaca（短序列）16/32 好，再大退化。
- 实践折中——**默认 block size = 16**。

### 7.3 composable formats 的设计权衡

composable formats 收益依赖工作负载：共享前缀越长、并行度适中，收益越大；无共享或极高并行度时优势消失（§6.4）。

---

## 8. 总结与展望

### 8.1 贡献总结

1. **block-sparse + composable formats** 统一 KV cache 存储异构——page table、radix tree、tree attention、importance mask 统统一种数据结构，外加多块大小组合存以兼顾共享与灵活。
2. **可定制 attention 模板 + JIT** 适配变体爆炸——几个 functor 描述变体差异，JIT 生成 CUDA，支持 FlexAttention 接口的超集（含 Q/K 变换、非 softmax 变体）。
3. **动态负载均衡调度 + CUDAGraph 兼容**——Inspector-Executor 模式把动态 plan（CPU）与静态 run（GPU graph）分离，persistent kernel 固定 grid，既适应动态性又兼容静态图。
4. **实测 29–69% ITL 降低**，被三大主流框架采纳。

更深层的贡献是**抽象层次的选择**：把"分页/基数树/树形 mask"下沉成稀疏矩阵的稀疏块，把"变体差异"收敛成可插拔 functor，把"动态/静态矛盾"用 plan/run 分离化解——三道抽象边界画对了，复杂度就被吃掉了。

### 8.2 局限性（批判性）

- **kernel 20–26% 开销**：动态 block 映射的代价真实存在，只是被端到端吞吐掩盖。对纯 compute-bound、序列极短场景优势会缩小。
- **仅支持 forward**：论文明说目前只支持 attention 前向，扩展到训练需开发可定制 backward 模板，留作未来工作。
- **CUDA/CUTLASS 绑定**：为追求性能选 CUDA 而非 Triton，可移植性受限（非 NVIDIA GPU 难以受益）。
- **composable formats 收益有条件**：需要先验知识（哪些是共享前缀），且对极短序列或极高并行度收益消失。
- **调度确定性约束**：为确定性输出放弃了 Stream-K 的原子聚合，某些场景可能非最优负载均衡。

### 8.3 未来方向（idea 三法）

**弥补缺陷**：

- 把 kernel 20%+ 开销通过更激进的 kernel 融合（与 FlashAttention 的 IO-aware tiling 深度结合）和硬件感知 block layout 降下来。
- 开发可定制 backward 模板，让 FlashInfer 从推理引擎扩展为训推一体的 attention 引擎。

**新型方案**：

- 把 block-sparse 统一格式推广到**异构存储层级**（GPU HBM ↔ CPU ↔ SSD）的统一调度，配合 block 预取预测，把 swap 从被动逐出变主动预取。
- 结合 FlashDecoding++ 用 attention scale 统计把 composition 转成求和、用 TMA Store Reduce 异步更新全局 state，与 FlashInfer 的调度正交可叠加。

**减少约束**：

- 把可定制模板下沉到**编译器层**（集成进 PyTorch/TorchInductor 或 Triton 后端），让任意 attention 变体自动获得非连续显存能力，而非只在 FlashInfer 手写。
- 用 vAttention 的 GPU 虚拟内存做地址翻译，FlashInfer 生成连续 KV cache 的 kernel，两者结合可兼顾动态稀疏与硬件 TLB 加速——论文已指出可组合。

---

> **一句话收尾**：FlashInfer 的胜利是"统一抽象"的胜利——把 page table、radix tree、tree mask 统一成稀疏矩阵的稀疏块，把变体差异收敛成 functor，把动态与静态的矛盾用 plan/run 分离——三道抽象边界画对，一个引擎就吃下了三大框架。
