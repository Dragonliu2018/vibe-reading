---
title: "LongCat Sparse Attention: Taming the Lightning via Streaming-aware Hierarchical Cross-Layer Indexing"
source:
  type: "论文解读"
  project: "LongCat"
  url: "https://arxiv.org/abs/2608.01662"
  pdf: "/vibe-reading/papers/longcat-sparse-attention.pdf"
date: "2026-08-05T20:00:00+08:00"
category: [AI, Models, Text Model, Papers]
tags: ["LongCat", "Sparse Attention", "Meituan", "长上下文", "LLM", "HBM", "Indexer"]
description: "美团 LongCat 团队提出 LSA，通过 SI/CLI/HI 三个正交机制解决 DSA 的输出不连续和高开销瓶颈，在 1024K 上下文实现 3.60× prefill 加速且质量无损。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/longcat-sparse-attention.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LongCat Sparse Attention (arXiv 2608.01662)](https://arxiv.org/abs/2608.01662) · **作者** Wen Zan, Jiaqi Zhang et al. · **发表** 2026-08-04 · **项目** [HuggingFace: LongCat-Flash-Lite-Sparse](https://huggingface.co/longcat) · **解读** 2026-08-05

---

## 1. 论文概览

**TL;DR**: 美团 LongCat 团队系统剖析了 DeepSeek Sparse Attention（DSA）的两个系统级瓶颈——Indexer 输出不连续导致的 HBM 带宽浪费、以及 Indexer 对全序列评分带来的 $O(L)$ 线性开销——并提出三个正交机制 **SI**（Streaming-Aware Indexing）、**CLI**（Cross-Layer Indexing）、**HI**（Hierarchical Indexing）组成 **LongCat Sparse Attention（LSA）**。在 1024K 上下文的 prefill 阶段实现 **3.60× 加速**，训练 forward 最高 **1.91× 加速**，且在 HELMET 基准上质量与 full attention 持平。

| 元信息 | 值 |
| --- | --- |
| 作者机构 | 美团 LongCat Team |
| 论文版本 | arXiv 2608.01662v2, 2026-08-04 |
| 模型规模 | 69B-A3B（Lite）、560B-A27B（Flash）、1.6T-A48B（2.0） |
| 开源 | LongCat-Flash-Lite-Sparse（69B-A3B）HuggingFace |
| 核心方法 | SI + CLI + HI，三机制正交，可独立组合 |

**Take-home**: 稀疏注意力的瓶颈不在"选哪些 token"而在"怎么高效选"。通过将固定流式区域（sink + sliding window）从动态选择中剥离、跨层复用 Indexer、以及粗到细的两阶段筛选，LSA 在不损失质量的前提下把 Indexer 开销从 $O(L^2)$ 压到近常数。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Sparse attention has emerged as a promising approach to extend the context window of large language models. The recent DeepSeek Sparse Attention (DSA) framework further advances this direction by introducing a learned Lightning Indexer that dynamically selects a sparse subset of KV tokens for each query, achieving both fine-grained token-level retrieval and training-inference consistency. However, as sequence lengths grow toward the million-token regime, we observe that DSA's efficiency gains are increasingly eroded by two system-level bottlenecks inherent to its design.

This paper presents LongCat Sparse Attention (LSA), a hardware-algorithm co-designed sparse attention framework that addresses these bottlenecks through three complementary mechanisms: Streaming-Aware Indexing (SI), which improves memory access locality by partitioning the attention budget into contiguous streaming and dynamic sparse components; Cross-Layer Indexing (CLI), which amortizes indexing overhead across model depth via inter-layer index reuse; and Hierarchical Indexing (HI), a training-free plug-and-play module that reduces per-query scoring cost through coarse-to-fine block-then-token selection. Experiments on models up to 1.6T parameters demonstrate that LSA matches full attention quality on HELMET while achieving up to 3.60× prefill speedup at 1024K context length.

> **译：** 稀疏注意力已成为扩展大语言模型上下文窗口的有前景方法。最近的 DeepSeek Sparse Attention（DSA）通过引入可学习的 Lightning Indexer——为每个查询动态选择 KV token 的稀疏子集——进一步推进了该方向，同时实现了细粒度 token 级检索和训练-推理一致性。然而，当序列长度向百万 token 量级增长时，我们观察到 DSA 的效率增益日益被其设计固有的两个系统级瓶颈所侵蚀。本文提出 LongCat Sparse Attention（LSA），一个硬件-算法协同设计的稀疏注意力框架，通过三个互补机制解决这些瓶颈：Streaming-Aware Indexing（SI）通过将注意力预算划分为连续流式分量和动态稀疏分量来改善内存访问局部性；Cross-Layer Indexing（CLI）通过层间索引复用跨模型深度摊销索引开销；Hierarchical Indexing（HI）是一个免训练的即插即用模块，通过粗到细的块-再-token 选择降低每查询评分成本。在最高 1.6T 参数模型上的实验表明，LSA 在 HELMET 上匹配 full attention 质量的同时在 1024K 上下文长度实现最高 3.60× prefill 加速。

</details>

---

## 2. 研究背景

### 2.1 稀疏注意力的演进

长上下文 LLM 面临的核心挑战：标准 attention 的 $O(L^2)$ 计算与 $O(L)$ KV cache 管理成本。稀疏注意力的发展经历了三个阶段：

| 阶段 | 代表方法 | 稀疏结构 | 局限 |
| --- | --- | --- | --- |
| 固定模式 | Sliding Window、StreamingLLM | 预定义 sink + window | 无法捕获远程依赖 |
| 块级检索 | Page Attention、Compressive Attention | 块级重要性排序 → 选 top 页 | 粒度粗，信息损失 |
| 细粒度学习检索 | **DSA**（DeepSeek Sparse Attention） | token 级动态 Top-K | 开销随 $L$ 线性增长 |

DSA 是当前最先进的细粒度稀疏注意力方案，它引入了独立的 **Lightning Indexer**——带有自己的 query/key 投影，为每个 query token 评分并选出 $K$ 个最相关的 KV token。然而论文发现，当序列长度推向百万 token 时，DSA 本身的效率瓶颈开始显现。

### 2.2 DSA 的两个系统级瓶颈

论文对 DSA 做了系统级 profiling，识别出两个关键瓶颈：

**瓶颈一：Indexer Output Discontiguity（输出不连续）**

DSA 的 Lightning Indexer 为每个 query 动态选出 $K$ 个 token，这些 token 在 KV cache 中的位置是不连续的。当 core sparse attention 读取这些 token 时，会产生 **非合并内存访问（non-coalesced memory access）**：

```
连续访问（理想）：  [KV0][KV1][KV2][KV3]...    → 1 次 cacheline 读取
DSA 动态选择：     [KV7][KV103][KV42][KV8]...  → 4 次随机访问
```

在美团自研 AI 加速器上，理想合并访问下单核可维持约 50 个在途 cacheline（每条 512B），内存窗口约 25.6KB。但 DSA 的随机索引导致实际 HBM 带宽利用率仅 **~4.5%**。

更严重的是 backward pass：梯度需按不连续索引写回 KV cache，不同 core 可能并发写同一梯度区域，引发写冲突和串行化。

**瓶颈二：Indexer High Overhead（索引开销线性增长）**

Lightning Indexer 对每个 query token 需评分全部 $L$ 个前缀 token，复杂度 $O(L)$；加上 Top-K 选择的 $O(L)$ 排序成本，每层每 query 的索引开销为 $O(L)$。在长上下文场景下，这一开销超过 core attention 本身的 $O(K)$ 成本：

```
短上下文 (4K):  SFA 主导开销，Indexer 占比小
长上下文 (1M):  Indexer 主导开销，SFA 反而变快（因为 K 固定）
```

### 2.3 关键观察

论文的两个实证发现是三个机制的立足点：

1. **注意力质量高度集中**：sink + sliding window 区域捕获约 **83.1%** 的注意力质量，中间动态区域仅占 ~17% → SI 的预算分配依据
2. **相邻层 Top-K 重叠率高**：相邻层共享 **57.4%** 的 Top-K token，且复用后仍保留 **~93%** 的注意力质量 → CLI 的跨层复用依据

---

## 3. 方法详解

LSA 的三个机制各自针对一个瓶颈维度，且正交可组合：

![图1：LSA 整体架构。SI 将预算分为固定流式区域（sink + sliding window）和动态稀疏区域；CLI 跨 N 层复用同一 Indexer；HI 用粗到细两阶段选择降低单次评分成本](/vibe-reading/images/articles/longcat-sparse-attention/fig-1-architecture.png)

### 3.1 SI：Streaming-Aware Indexing

**目标**：解决瓶颈一（输出不连续）。

**核心思路**：将注意力预算 $K$ 拆为三部分：

$$
S_t = \underbrace{S_{\text{sink}}}_{\text{固定 sink}} \cup \underbrace{S_{\text{swa}}}_{\text{固定滑窗}} \cup \underbrace{S_{\text{sparse}}}_{\text{动态稀疏}}
$$

其中 $K = K_{\text{sink}} + K_{\text{swa}} + K_{\text{sparse}}$：

| 分量 | 含义 | 大小 |
| --- | --- | --- |
| $S_{\text{sink}}$ | 开头 $K_{\text{sink}}$ 个 token（attention sink） | 16 |
| $S_{\text{swa}}$ | 当前 query 前方的 $K_{\text{swa}}$ 个 token（sliding window） | 1024 |
| $S_{\text{sparse}}$ | 中间区域动态选出的 $K_{\text{sparse}}$ 个 token | ~1024 |

固定区域（sink + SWA）占约 50% 预算，在内存中连续存放，可一次合并读取。Indexer 只需对中间区域（$s \notin S_{\text{sink}} \cup S_{\text{swa}}$）评分，有效评分范围从 $L$ 缩小到 $L - K_{\text{sink}} - K_{\text{swa}}$。

**三个收益**：

| 收益 | 说明 |
| --- | --- |
| (a) 合并 HBM 读取 | sink 和 SWA 作为连续块访问，恢复 HBM 吞吐 |
| (b) 缩小评分范围 | Indexer 有效评分范围减少 $K_{\text{sink}} + K_{\text{swa}}$ |
| (c) 确定 KV 布局 | 固定区域可独立 offload / 预取，支持 speculative decoding |

### 3.2 CLI：Cross-Layer Indexing

**目标**：解决瓶颈二（索引开销线性增长）。

**核心思路**：相邻层的 Top-K 高度重叠（57.4%），可将连续 $N$ 层分为一组，仅第一层（owner layer）运行 Indexer，后续 $N-1$ 层复用其索引。

```
DSA (N=1):  Layer l   → Indexer → Top-K → Attention
            Layer l+1 → Indexer → Top-K → Attention
            Layer l+2 → Indexer → Top-K → Attention

CLI (N=2):  Layer l   → Indexer → Top-K → Attention (owner)
            Layer l+1 → 复用 l 的 Top-K  → Attention
            Layer l+2 → Indexer → Top-K → Attention (owner)
            Layer l+3 → 复用 l+2 的 Top-K → Attention
```

**关键设计：跨层蒸馏**

直接复用索引会导致质量下降。CLI 引入跨层蒸馏损失：不再让每个 Indexer 只对齐自己层的注意力分布，而是让共享 Indexer 同时对齐组内所有层的注意力分布：

$$
\mathcal{L}_{\text{CLI}}^{(l)} = \sum_{i=0}^{N-1} \mathcal{L}_{\text{indexer}}^{(l+i)}
$$

其中 $\mathcal{L}_{\text{indexer}}^{(l+i)}$ 是第 $l+i$ 层的 KL 散度蒸馏损失。这样共享 Indexer 学到的是"组内所有层都能接受"的通用选择策略。

**MTP 扩展**：CLI 还扩展到 Multi-Token Prediction（MTP）维度——$D$ 个 MTP step 各自形成独立的 CLI 组，因为跨 MTP step 的注意力模式同样具有相关性。

### 3.3 HI：Hierarchical Indexing

**目标**：进一步降低每次 Indexer 评分的成本，**免训练、即插即用**。

**核心思路**：两阶段粗到细选择，将 $O(L)$ 的 token 级评分降为 $O(L/P + MP)$：

**Stage 1 — 块级粗筛**：将 $L$ 个 token 分为 $\lceil L/P \rceil$ 个页（每页 $P$ 个 token），每页再分为 $P/B$ 个子块（每子块 $B$ 个 token）。对每个子块预计算均值表示 $k^{\text{mean}}_n$，用与 Indexer 相同的评分公式计算页级显著性分数，选出 Top-$M$ 页。

**Stage 2 — token 级精筛**：仅对 Top-$M$ 页覆盖的 $M \times P$ 个 token 运行标准 Indexer 评分，选出最终 $K$ 个 token。

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| $P$ | 页大小 | 128 |
| $B$ | 子块大小 | 8 |
| $M$ | 候选页数 | 1024 |

复杂度对比：

| 方法 | 评分复杂度 | 说明 |
| --- | --- | --- |
| 标准 Indexer | $O(L)$ | 对全部 $L$ 个 token 评分 |
| HI Stage 1 | $O(L/B)$ | 对 $L/B$ 个子块评分 |
| HI Stage 2 | $O(MP)$ | 仅对 $M$ 页内 token 评分 |
| HI 总计 | $O(L/B + MP)$ | 远小于 $O(L)$ |

与 SI 和 CLI 不同，HI **仅在推理时启用**（prefill 且上下文 ≥ 256K），不需要额外训练。在短上下文时两阶段开销大于收益，因此有启用阈值。

---

## 4. 关键公式解读

### 4.1 Indexer 评分（Eq.1）

Lightning Indexer 为 query token $t$ 对每个前缀 token $s$ 计算显著性分数：

$$
I_{t,s} = \sum_{j=1}^{H_I} w^I_{t,j} \cdot \text{ReLU}\!\left(q^I_{t,j} \cdot k^I_s\right)
$$

其中 $H_I$ 是 Indexer 头数，$q^I_{t,j}$ 和 $w^I_{t,j}$ 由 query 隐状态 $h_t$ 通过学习投影得到，$k^I_s$ 是 token $s$ 的 Indexer key。注意输入从模型计算图中 detach，Indexer 参数仅通过蒸馏损失更新。

### 4.2 Top-K 选择与蒸馏（Eq.2 / Eq.4）

选出 $K$ 个最高分 token 后仅对这些 token 做 attention：

$$
S_t = \arg\text{topK}(\{I_{t,s}\}_{s \leq t},\ K)
$$

训练时通过 KL 散度将 Indexer 输出与全注意力分布对齐：

$$
\mathcal{L} = \sum_t D_{KL}\!\left(p_{t,:} \,\|\, \text{Softmax}(I_{t,:})\right)
$$

其中 $p_{t,:}$ 是所有 head 的注意力权重之和并归一化为分布。这个蒸馏确保 Indexer 学会模仿 full attention 的选择行为。

### 4.3 SI 预算分区

固定区域确定后，仅对中间区域做动态选择：

$$
S_{\text{sparse}} = \arg\text{topK}\!\left(\{I_{t,s}\}_{s \notin S_{\text{sink}} \cup S_{\text{swa}}},\ K_{\text{sparse}}\right)
$$

训练时蒸馏目标从全序列注意力分布变为**选集上的重归一化分布**，但刻意将 sink 和 SWA 纳入蒸馏目标（虽然推理时不评分），利用它们承载的大量注意力质量提供更丰富的监督信号。

### 4.4 HI 粗筛评分（Eq.9）

页级显著性分数复用 Indexer 的评分公式，但 key 换成子块均值：

$$
I^{\text{page}}_{t,p} = \sum_{j=1}^{H_I} w^I_{t,j} \cdot \text{ReLU}\!\left(q^I_{t,j} \cdot k^{\text{mean}}_n\right), \quad n \in \text{page}_p
$$

其中 $k^{\text{mean}}_n = \text{mean}_{s \in \text{sub-block}_n} k^I_s$ 是子块内 token key 的均值。query 和权重与 Eq.1 完全相同——HI 不引入新参数，只是复用 Indexer 的投影对聚合后的表示评分。

---

## 5. 实验设置

### 5.1 模型规模

| 模型 | 总参数 | 激活参数 | 用途 |
| --- | --- | --- | --- |
| LongCat-Flash-Lite | 69B | 3B (A3B) | 主实验 + 消融 + 开源 |
| LongCat-Flash | 560B | 27B (A27B) | 规模验证 |
| LongCat-2.0 | 1.6T | 48B (A48B) | 超大规模验证 |

### 5.2 评测基准

| 类别 | 基准 | 评测能力 |
| --- | --- | --- |
| 长上下文 | **HELMET**（含 RULER、RAG、LongQA 等） | 多跳检索、RAG、长文档理解 |
| 通用能力 | MMLU、GSM8K、HumanEval 等 | 知识、推理、编码 |
| 消融 | LongEval（n-shot needle-in-haystack） | 区分基础模型质量的敏感任务 |

### 5.3 基线对比

| 方法 | 说明 |
| --- | --- |
| **MLA** | Multi-head Latent Attention（full attention 基线） |
| **DSA** | DeepSeek Sparse Attention（无 SI/CLI/HI） |
| **LSA** | 本文方法（DSA + SI + CLI + HI） |

所有模型在相同数据、相同训练步数下训练，确保公平对比。

### 5.4 复现信息

LongCat-Flash-Lite-Sparse（69B-A3B）已在 HuggingFace 开源，支持 1024K 上下文推理。

---

## 6. 实验结果

### 6.1 质量结果：LSA 匹配 Full Attention

**HELMET 长上下文基准**（Table 7）：

| 模型规模 | MLA | DSA | LSA | LSA vs MLA |
| --- | --- | --- | --- | --- |
| 69B-A3B | 58.50 | 58.60 | **59.02** | +0.52 |
| 560B-A27B | 63.82 | — | **64.43** | +0.61 |

LSA 在两个规模上均超过 MLA 基线，证明稀疏化未损失长上下文能力。

**通用基准**（Table 8）：MMLU、GSM8K、HumanEval 等任务上 LSA、DSA、MLA 三者得分相当，无一致优劣方，确认 LSA 在通用能力上无退化。

### 6.2 推理效率：最高 3.60× prefill 加速

![图5：LSA vs DSA 的端到端推理延迟。左为 prefill TTFT（对数轴），右为 decode TPOT，横轴为上下文长度。箭头标注 1024K 处 3.60× 加速](/vibe-reading/images/articles/longcat-sparse-attention/fig-5-inference-latency.png)

| 上下文长度 | Prefill 加速 | Decode 加速 |
| --- | --- | --- |
| 32K | 1.42× | 1.25× |
| 128K | 2.15× | 1.40×（峰值） |
| 256K | 2.80× | 1.35× |
| 512K | 3.20× | 1.30× |
| 1024K | **3.60×** | 1.28× |

**关键发现**：prefill 加速随上下文增长而增大——因为 Indexer 开销随 $L$ 增长是主要瓶颈，LSA 的 CLI + HI 正好削减这部分。decode 加速在 128K 处峰值后略降，因为 KVP（KV Parallel）配置在 256K+ 启用后缩小了 LSA 的相对优势。

### 6.3 训练效率

![图4：LSA vs DSA 单注意力层训练延迟。柱状图展示 forward、backward、total 延迟；箭头标注 LSA 相对 DSA 的加速比](/vibe-reading/images/articles/longcat-sparse-attention/fig-4-training-latency.png)

| 上下文长度 | Forward 加速 | Backward 加速 | Total 加速 |
| --- | --- | --- | --- |
| 32K | 1.42× | 1.34× | **1.53×** |
| 1024K | 1.92× | 1.55× | **1.61×** |

**Core attention 内核**（Table 2，HFA vs SFA）：forward 最高 **1.91×**、backward 最高 **1.73×**。

训练收益来自 SI 和 CLI（HI 仅推理）：
- **CLI** 减少前向 Indexer 开销（$N=2$ 时每两层只跑一次 Indexer），仅受益 forward
- **SI** 同时加速 forward 和 backward，尤其 backward（消除 SFA 的梯度写冲突）

### 6.4 MTP 集成

LSA 与 speculative decoding 的 3-step MTP 模块兼容：

| 配置 | 平均接受长度（越高越好，理论最大 4） |
| --- | --- |
| Dense MLA | 3.15 |
| LSA (SI + CLI) | **3.11** |

差距仅 0.04，说明 LSA 的稀疏选择对 MTP 草稿质量影响可忽略。CLI 还支持异步预取进一步降低 reload 延迟：从 53.88µs 降至 15.23µs（原 DSA 的 28%）。

---

## 7. 消融实验

### 7.1 SI：固定预算比例

![图2：注意力质量分布。sink + SWA 区域平均捕获 83.1% 注意力质量，中间动态区域仅 ~17%](/vibe-reading/images/articles/longcat-sparse-attention/fig-2-attention-mass.png)

测试固定预算占比 0%、25%、50%、75%、100%（0% = 纯 DSA，100% = 纯固定窗口）：

| 固定比例 | HELMET 分数 | 结论 |
| --- | --- | --- |
| 0% (DSA) | 基线 | 纯动态选择 |
| 25% | ≈ 基线 | 可接受 |
| **50%** | **最优** | 最大化固定窗口且质量不降 |
| 75% | 明显下降 | 动态预算不足 |
| 100% | 严重下降 | 无动态选择 |

**结论**：50% 固定比例（$K_{\text{sink}} = 16$、$K_{\text{swa}} = 1024$、$K_{\text{sparse}} \approx 1024$）是最佳折中点。

### 7.2 CLI：跨层组大小 N

![图3：跨层 Top-K 重叠分析。(a) 相邻层 Top-K 集合的成对重叠率；(b) 复用一层 Top-K 时捕获的累积注意力质量；(c) 不同距离的层对重叠统计](/vibe-reading/images/articles/longcat-sparse-attention/fig-3-cross-layer-overlap.png)

| 组大小 N | 训练 loss gap | Needle 准确率 | HELMET | 结论 |
| --- | --- | --- | --- | --- |
| 1 (LI) | 基线 | 基线 | 基线 | 标准 DSA |
| **2** | < 0.002 | 持平 | 持平 | **推荐** |
| 4 | 略高 | 32K+ 明确下降 | 略低 | 过度复用 |

**关键发现**：$N=2$ 在训练 loss、长上下文检索、HELMET 上均与 $N=1$ 持平；$N=4$ 在短上下文可接受但 32K+ 出现明显退化。论文还测试了 $N=4$ + 扩大 $K$ 到 4K 的补偿策略，但仍无法恢复质量。

**跨层蒸馏的必要性**：不加蒸馏直接复用（CLI N=2 w/o distill）导致显著质量下降，验证了跨层蒸馏使共享 Indexer 学到通用选择策略的必要性。

### 7.3 HI：推理时两阶段选择

HI 的加速效果随上下文长度增大而显著增强（Table 4）：

| 上下文长度 | 标准 Indexer 延迟 | HI 两阶段延迟 | 加速比 |
| --- | --- | --- | --- |
| 32K | 5.2ms | 6.1ms | 0.85×（负收益） |
| 256K | 42.3ms | 28.5ms | 1.49× |
| 1024K | 167.8ms | 27.8ms | **4.11×** |

**关键发现**：HI 在短上下文有额外开销（两阶段维护成本 > 节省），256K 以上才有正收益。Stage 2 在 $M \times P$ 确定后延迟恒定（27.8ms），不随 $L$ 增长——这就是 HI 的核心价值：把线性开销变成近常数。

---

## 8. 总结与展望

### 8.1 贡献总结

| 贡献 | 机制 | 解决的瓶颈 | 训练/推理 |
| --- | --- | --- | --- |
| 连续内存访问 | SI | 输出不连续 → HBM 带宽浪费 | 两者 |
| 跨层索引复用 | CLI | Indexer $O(L)$ 线性开销 | 两者（forward） |
| 粗到细选择 | HI | Indexer $O(L)$ 线性开销 | 仅推理 |
| HFA 内核优化 | — | SFA backward 写冲突 | 两者 |

三机制正交：SI 改预算分配、CLI 改跨层调度、HI 改单次选择复杂度，可独立启用或组合。组合后在 1024K 实现 3.60× prefill 加速且 HELMET 质量反超 full attention。

### 8.2 局限性

1. **KV-cache 占用未减少**：LSA 优化的是"选哪些 token 做 attention"的效率，但全部 KV cache 仍需驻留 HBM。对于 1M+ token 的极端场景，KV cache 容量本身仍是瓶颈。
2. **HI 仅适用于 prefill**：decode 时单 query 的两阶段开销大于收益，HI 被禁用。因此 decode 加速主要依赖 SI + CLI（1.25–1.40×），低于 prefill 加速。
3. **CLI 复用上限**：$N=2$ 是质量安全的上限，$N \geq 4$ 在长上下文退化。更大的复用率需要更强的蒸馏或架构改进。
4. **硬件特异性**：SI 的设计（cacheline 合并、写冲突消除）与美团自研 AI 加速器的特性紧耦合，在其他硬件（如 NVIDIA GPU）上的收益可能不同。

### 8.3 未来方向

**弥补缺陷**：

- 结合 KV cache 压缩/驱逐策略，在 LSA 的稀疏选择基础上进一步减少 HBM 占用（如对未被选中的 KV block 做 page-level eviction）
- 探索 decode 阶段的 HI 替代方案（如基于历史选择模式的预测式预筛），消除 HI 在 decode 时的盲区

**新型方案**：

- 将 CLI 扩展到跨 **序列维度**（batch 内不同序列的注意力模式相似性）而非仅跨层维度
- 用轻量级神经网络替代 Indexer 的评分+Top-K 两步流程，实现端到端的不同可微稀疏选择

**减少约束**：

- 研究 $N > 2$ 的安全复用条件——如分组策略（非均匀分组、按注意力模式聚类分组）可能比均匀分组支持更大的 $N$
- 探索 HI 的训练感知版本，让粗筛阶段也参与梯度回传，可能进一步改善质量-效率权衡
