---
title: "Scaling Embeddings Outperforms Scaling Experts in Language Models"
source:
  type: "论文解读"
  project: "LongCat"
  url: "https://arxiv.org/abs/2601.21204"
  pdf: "/vibe-reading/papers/scaling-embeddings-outperforms-scaling-experts.pdf"
date: "2026-08-12T20:12:00+08:00"
category: [AI, Models, Text Model, Papers]
tags: ["LongCat", "N-gram Embedding", "MoE", "Sparse Parameters", "Pareto Frontier", "Speculative Decoding", "Inference Optimization", "Meituan"]
description: "目的：突破 MoE 专家扩展的边际递减。手段：用 N-gram Embedding 在正交维度扩展稀疏参数并配系统优化。结论：68.5B 模型超 30B 参数分给 embedding 优于等参 MoE，agentic/coding 任务领先同量级模型。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/scaling-embeddings-outperforms-scaling-experts.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Scaling Embeddings Outperforms Scaling Experts in Language Models](https://arxiv.org/abs/2601.21204) · **作者** Hong Liu, Jiaqi Zhang et al. · **机构** Meituan LongCat Team · **发表** arXiv, 2026-02 · **项目** [HuggingFace](https://huggingface.co/meituan-longcat/LongCat-Flash-Lite) · **解读** 2026-08-12

## 1. 论文概览

MoE 已经成为大模型稀疏扩展的事实标准，但专家数增加带来的收益正加速递减，并撞上通信与显存带宽的系统瓶颈。美团 LongCat 团队这篇技术报告提出一个正交的扩展维度——**Embedding Scaling**：把参数从 FFN 专家挪到 embedding 表，用 $O(1)$ 的查表代价换取容量扩展，无需路由开销。

文章通过系统性 scaling 实验定位了"embedding scaling 优于 expert scaling"的 Pareto 区间，刻画了决定其有效性的全部架构因子（集成时机、参数预算、hash 碰撞、宽度/深度交互），并配以 N-gram Cache、kernel fusion、speculative decoding 把稀疏红利真正转成推理加速。最终产物是 **LongCat-Flash-Lite**：68.5B 总参、~3B 激活、从零训练，把超 30B 参数分给 N-gram Embedding，在 agentic 与 coding 任务上显著领先等参 MoE 基线及同量级竞品。

**一句话 take-home**：当 MoE 稀疏度足够高时，把新增参数投到 embedding 而非专家，是更高效的稀疏扩展正交维度。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

While Mixture-of-Experts (MoE) architectures have become the standard for sparsity scaling in large language models, they increasingly face diminishing returns and system-level bottlenecks. In this work, we explore embedding scaling as a potent, orthogonal dimension for scaling sparsity. Through a comprehensive analysis and experiments, we identify specific regimes where embedding scaling achieves a superior Pareto frontier compared to expert scaling. We systematically characterize the critical architectural factors governing this efficacy—ranging from parameter budgeting to the interplay with model width and depth. Moreover, by integrating tailored system optimizations and speculative decoding, we effectively convert this sparsity into tangible inference speedups. Guided by these insights, we introduce LongCat-Flash-Lite, a 68.5B parameter model with ~3B activated trained from scratch. Despite allocating over 30B parameters to embeddings, LongCat-Flash-Lite not only surpasses parameter-equivalent MoE baselines but also exhibits exceptional competitiveness against existing models of comparable scale, particularly in agentic and coding domains.

> **译：** 虽然 MoE 架构已成为大语言模型稀疏扩展的标准范式，但它日益面临边际递减与系统级瓶颈。本文探索 embedding scaling 作为一个有力的、正交的稀疏扩展维度。通过全面的分析与实验，我们识别出 embedding scaling 相较 expert scaling 取得更优 Pareto 前界的特定区间。我们系统刻画了支配该有效性的关键架构因子——从参数预算到与模型宽度/深度的交互。进一步，通过集成定制系统优化与投机解码，我们有效将这种稀疏性转化为实在的推理加速。基于这些洞察，我们提出 LongCat-Flash-Lite：一个 68.5B 参数、~3B 激活、从零训练的模型。尽管把超过 30B 参数分配给 embedding，LongCat-Flash-Lite 不仅超越等参 MoE 基线，还在可比规模现有模型面前展现出卓越竞争力，尤其在 agentic 与编码领域。

</details>

## 2. 研究背景

**问题定义**：LLM 稀疏扩展当前几乎等价于 MoE——通过路由把 token 送到少量专家，解耦参数容量与计算成本。但随着专家数与稀疏度提升，两个问题浮现：

1. **边际递减**：loss 与专家参数呈严格对数线性关系，低稀疏度时加专家收益大，高稀疏度时同等 loss 降幅需多得多的专家参数，逼近效率饱和点。
2. **系统瓶颈**：专家扩张受通信开销与显存带宽压力制约，分布式训练/推理代价陡增。

**Embedding 作为被忽视的正交维度**：与 MoE 不同，embedding 层是天然稀疏的——查表复杂度 $O(1)$，可大规模扩参数而无路由开销。理论支撑来自 vocabulary scaling laws（更大模型应配更大词表以最大化计算效率）。已有两条路线：

- **结构扩展**：Per-Layer Embedding (PLE)，给每层独立 embedding 参数。
- **词表扩展**：用 n-gram densify 每 token 信息，从 RNN 时代的 lookup-table LM 到近期 LLM 工作（Over-Encoding / BLT / Engram）。

**本文要补的四个缺口**：

| 缺口 | 本文回答 |
|------|---------|
| 专家参数 vs embedding 参数的 scaling 效率谁更优？ | 在特定稀疏度区间 embedding 更优（§3.1） |
| 扩 embedding 的约束条件是什么？ | 参数预算、hash 碰撞、宽度/深度交互（§3.2–3.3） |
| 哪种 embedding 扩展策略最稳？ | N-gram Embedding 最鲁棒（§3、§5） |
| 改了输入/输出特性后端到端推理如何？ | N-gram Cache + 同步 kernel + 投机解码（§4） |

## 3. 方法详解

### 3.1 N-gram Embedding 层

N-gram Embedding 在 base embedding 之外加一个 vocabulary-free 的 n-gram 表，用前 $N-1$ 个 token 的 hash 组合增强当前 token 的表示。架构见下图：

![Figure 1: N-gram Embedding 层架构。每个 token 的 embedding 由 base 表与 N-gram 子表经 hash + projection 聚合而成](/vibe-reading/images/articles/scaling-embeddings-outperforms-scaling-experts/fig-1-ngram-embedding-architecture.png)

对第 $i$ 个 token $t_i$，增强 embedding $e_i$ 的基础形式为：

$$
e_i = \frac{1}{N}\left( E_0(t_i) + \sum_{n=2}^{N} E_n(H_n(t_{i-n+1}, \dots, t_i)) \right), \quad t_j = 0 \text{ if } j \le 0
$$

其中 $E_0 \in \mathbb{R}^{V_0 \times D}$ 是 base 表，$E_n \in \mathbb{R}^{V_n \times D}$ 是 n-gram 扩展表，$H_n$ 是多项式 rolling hash。为进一步降碰撞，每个 n-gram 表被分解为 $K$ 个不同词表大小的子表，并加线性投影映射回原空间（即 Over-Encoding）。最终形式见 §4 公式 (3)。该设计让 N-gram Embedding 参数量与 $N$、$K$ 无关——子表隐藏维设为反比于子表数。

### 3.2 关键发现：何时该引入 N-gram Embedding

论文最核心的实验是 Figure 2 的 scaling 曲线对比：在 280M 激活的 MoE 上，对比三条路线——纯 MoE baseline、低稀疏度引入 NE、高稀疏度引入 NE。

![Figure 2: MoE 与 N-gram Embedding 的 scaling 曲线。横轴为总参/激活比（稀疏度代理）。高稀疏度引入 NE（红）显著低于 MoE baseline（蓝）](/vibe-reading/images/articles/scaling-embeddings-outperforms-scaling-experts/fig-2-scaling-curve.png)

关键观察：MoE 曲线严格对数线性——低稀疏度时加专家 loss 降得多，高稀疏度时同等降幅需巨量专家参数。因此：

- **低稀疏度引入 NE**：优势不足以压过加专家的收益。
- **高稀疏度引入 NE**：优势显著放大。

> **设计原则**：N-gram Embedding 应在专家数超过"sweet spot"后引入。这说明 embedding scaling 是与 expert scaling 正交的扩展维度。

### 3.3 集成策略：四条原则

**原则一 · 参数预算上限**：Figure 2 中蓝红曲线有交点——NE 参数占比过高时反被等参 MoE 超过（与并发工作 Engram 的 U 型 scaling 一致）。交点在 ratio≈20，此时 NE 参数约占总参 50%。

> Allocate no more than 50% of the total parameter budget to N-gram Embedding.

**原则二 · 规避 hash 碰撞**：2-gram hashing 在词表大小接近 base 词表整数倍时碰撞数骤增（Figure 3b），且与是否为质数无关。

![Figure 3: (a) 不同 n-gram 的词表命中率；(b) 2-gram hashing 碰撞数随词表大小的非线性关系——整数倍处骤增](/vibe-reading/images/articles/scaling-embeddings-outperforms-scaling-experts/fig-3-vocab-hitrate-collision.png)

> N-gram Embedding 的词表大小应显著偏离 base 词表的整数倍。

**原则三 · 超参鲁棒**：对 $N$（n-gram 阶数）与 $K$（子表数）做消融（Figure 4），$N{=}2, K{=}1$ 明显差；$N \ge 3, K \ge 2$ 后各组合差异很小。经验上 $N \in [3,5]$ 近最优。

![Figure 4: 不同 N、K 组合的训练/验证 loss。N≥3 且 K≥2 后性能方差很小](/vibe-reading/images/articles/scaling-embeddings-outperforms-scaling-experts/fig-4-N-K-hyperparameter.png)

**原则四 · Embedding Amplification**：初始化不当会让 embedding 信号被残差流淹没。Figure 5 显示首个 attention 输出的 L2 norm 比对应 identity 分支大约 10×，求和后 embedding 信号被"drown out"。

![Figure 5: 各层 module 输出与 identity 分支的 L2 norm 及比值。首个 attention 输出比 embedding 大一个数量级](/vibe-reading/images/articles/scaling-embeddings-outperforms-scaling-experts/fig-5-l2-norm-layer-analysis.png)

两种缓解（合称 Embedding Amplification，源自 Takase et al. 2025）：

- **Scaling Factor**：给 embedding 输出乘 $\sqrt{D}$。
- **Normalization**：合并前对 embedding 输出做 LayerNorm（早期强制单位方差）。

应用后训练 loss 与两个验证 loss 一致降 0.02。

### 3.4 宽度与深度的反向作用

在 790M、1.3B 两个更宽配置下（Figure 6），NE 优势随宽度增加而扩大——交点从 280M 的 ratio≈30 推到 1.3B 的 ratio≈50。

![Figure 6: (a) 790M (b) 1.3B 激活规模的 scaling 曲线。越宽的模型 NE 优势窗口越大](/vibe-reading/images/articles/scaling-embeddings-outperforms-scaling-experts/fig-6-scaling-curve-wider.png)

但深度是反向的（Figure 7b）：pre-norm 架构下 NE 经 identity 连接的贡献随深度衰减，超 20 层后优势明显收缩。好在当前实用模型多在 40 shortcut 层以内，宽度红利仍主导。

> Increasing model width confers a greater advantage to N-gram Embedding; increasing model depth diminishes it.

## 4. 关键公式解读

N-gram Embedding 的最终形式（Over-Encoding）：

$$
e_i = \frac{1}{(N-1)K + 1}\left( E_0(t_i) + \sum_{n=2}^{N}\sum_{k=1}^{K} W_{n,k}\, E_{n,k}\!\left(H_{n,k}(t_{i-n+1}, \dots, t_i)\right) \right)
$$

$$
\underbrace{E_0(t_i)}_{\text{base embedding}} \;+\; \underbrace{\sum_{n,k} W_{n,k} E_{n,k}(\cdot)}_{\text{n-gram 子表 + 投影}}
$$

其中 $E_{n,k} \in \mathbb{R}^{V_{n,k} \times D/((N-1)K)}$ 是子表，$W_{n,k} \in \mathbb{R}^{D \times D/((N-1)K)}$ 是投影矩阵。子表隐藏维反比于 $(N-1)K$，使总参数量对 $N, K$ 不变。

hash 函数为多项式 rolling hash：

$$
H_n(t_{i-n+1}, \dots, t_i) = \left( \sum_{j=0}^{n-1} t_{i-j} \cdot V_0^{\,j} \right) \bmod V_n
$$

> 大 $N$ 时先取模再幂运算可避免数值溢出。

## 5. 实验设置

**Scaling 实验**：集成进 LongCat-Flash 架构，从零预训练，激活规模 280M / 790M / 1.3B；base 稀疏度 35%–98%，逐级引入 NE 并与等参 MoE baseline 配对；300B tokens 语料；监控训练 loss 与中英文验证 loss。

**架构对比（§5）**：对比 NE、PLE（Per-Layer Embedding，替换 SwiGLU 的 up-projection输出）、PLNE（Per-Layer N-gram Embedding）。PLE 直接用 embedding 替换 FFN 的 up-projection 输出：

$$
\text{FFN}^{(l)}(x_i) = W_d^{(l)}\!\left( \text{SiLU}(W_g^{(l)} x_i^{(l)}) \odot E_0^{(l)}(t_i) \right)
$$

**LongCat-Flash-Lite 训练**：11T tokens 预训练（8k 序列）→ 1.5T tokens mid-training（扩到 128k）→ SFT；32k 阶段引入 YARN，支持到 256k 上下文。

**基线**：LongCat-Flash-Lite-Vanilla——把所有 NE 参数转成额外专家，同数据同策略训练，做严格对照。

**Chat 评测基线**：Qwen3-Next-80B-A3B-Instruct、Gemini 2.5 Flash-Lite、Kimi-Linear-48B-A3B。

## 6. 实验结果

### 6.1 Base 模型：NE 胜过等参 MoE

训练全程 LongCat-Flash-Lite 的 loss 低于 Vanilla（Figure 10）：

![Figure 10: LongCat-Flash-Lite 与 Vanilla 的训练 loss 曲线。420B 处的跌降对应 batch size 增大](/vibe-reading/images/articles/scaling-embeddings-outperforms-scaling-experts/fig-10-training-loss-curve.png)

下游 base benchmark（Table 1，@1.3T tokens）：

| Benchmark | Vanilla | Flash-Lite | Δ |
|---|---|---|---|
| MMLU-Pro | 34.43 | 35.89 | +1.46 |
| CEval | 64.09 | 67.21 | +3.12 |
| CMMLU | 67.08 | 69.55 | +2.47 |
| BBH | 38.54 | 43.67 | +5.13 |
| GPQA | 25.37 | 29.66 | +4.29 |
| DROP | 47.92 | 52.43 | +4.51 |
| HumanEval+ | 28.66 | 31.10 | +2.44 |
| BigCodeBench | 33.42 | 36.05 | +2.63 |

仅在 MMLU（-0.80）与 MultiPL-E（-0.17）上微弱落后，其余全面领先——验证了"高稀疏度下把参数投给 embedding 优于加专家"。

### 6.2 Chat 模型：agentic 与 coding 大幅领先

Table 2 核心对比（LongCat-Flash-Lite 68.5B / 2.9B–4.5B 激活）：

| Benchmark | Kimi-Linear-48B | Qwen3-Next-80B | Gemini 2.5 FL | **Flash-Lite** |
|---|---|---|---|---|
| **Tau2-Telecom** | 15.68 | 13.2* | 21.93 | **72.80** |
| **Tau2-Retail** | 18.86 | 57.3* | 37.50 | **73.10** |
| **SWE-Bench** | 32.80 | 37.60 | 41.3* | **54.40** |
| **TerminalBench** | 20.00 | 15.19 | 20.00 | **33.75** |
| PRDBench | — | 15.36 | — | **39.63** |
| MMLU | 79.91 | 89.28 | 84.68 | 85.52 |
| AIME25 | 59.58 | 68.44 | 50.1* | 63.23 |

Agentic tool use（τ²-Bench 三个子场景）与 agentic coding（SWE-Bench / TerminalBench / PRDBench）上 Flash-Lite 全面领先，SWE-Bench 54.4 比次高 Gemini 高 13 个点。通用与数学任务与同量级模型互有胜负，整体竞争力强。

### 6.3 推理加速

NE 把参数从 MoE 挪到 embedding，降低解码时 MoE 激活参数——这在 memory I/O bound 的大 batch 解码场景直接省显存带宽。Figure 8a 显示 Flash-Lite 随 batch 增大激活专家数远低于 Vanilla；Figure 8b 是 8×H800 上 ISL=4K/OSL=1K 的实测吞吐。

![Figure 8: (a) 不同 batch size 下激活专家数对比；(b) 8×H800 解码吞吐（DP1TP8 / DP8TP1）](/vibe-reading/images/articles/scaling-embeddings-outperforms-scaling-experts/fig-8-inference-speedup.png)

## 7. 消融实验

**N、K 敏感性（Figure 4）**：$N{=}2, K{=}1$ 显著差；$N \ge 3, K \ge 2$ 后性能方差很小，模型对该区间超参鲁棒。经验取 $N \in [3,5]$。

**宽度 vs 深度（Figure 7）**：固定深度增宽度——NE 相对 MoE 的 loss 降幅随宽度扩大（6.4B→25B→34B 逐级加深）；固定宽度增深度（10→20→40 层，NE 参数占比恒定 50%）——超 20 层优势收缩。这指向 NE 应优先沿宽度扩展。

**PLE / PLNE 对比（Figure 9）**：PLE 学习效率不如 NE（标准 embedding 不及 n-gram 的信息密度）；PLNE（每层独立 n-gram）相对 NE 仅微弱提升，但引入每层投影矩阵导致激活参数上升，且在更宽/更深时无一致优势——故大模型未采用 PLNE。

**Embedding Amplification**：scaling factor 与 LayerNorm 两种手段均使训练/验证 loss 一致降 0.02；对训练稳定性无明显影响，主要是放大 embedding 对残差流的贡献。

## 8. 总结与展望

**贡献总结**：

1. **定位 Pareto 优势区间**——在 MoE 稀疏度足够高时，embedding scaling 比 expert scaling 更高效，是正交的稀疏扩展维度。
2. **完整刻画架构因子**——集成时机、≤50% 参数预算、hash 碰撞规避、$N \ge 3 / K \ge 2$ 鲁棒区、Embedding Amplification、宽度增益与深度衰减。
3. **系统侧闭环**——N-gram Cache + 同步 kernel + speculative decoding 把参数稀疏性转成实测加速。
4. **LongCat-Flash-Lite 开源**——68.5B / ~3B 激活，超 30B 参数给 embedding，agentic/coding 领先同量级。

**局限性（批判性）**：

- **深度衰减未根治**：NE 经 identity 的贡献随深度衰减是 pre-norm 架构的固有特性，论文只给出"40 层内仍有效"的经验边界，未提出结构性修复。超深模型（如 80+ 层）上 NE 优势是否存续存疑。
- **hash 碰撞的经验性**：碰撞与词表大小的关系靠实验观察而非理论刻画，换 base 词表或语料分布时需重新校准。
- **PLE/PLNE 探索不充分**：论文自己指出 PLNE 的跨层参数最优分配（集中 vs 均匀）待研究，但未给出实验。
- **N-gram Cache 的开销未量化**：cache 命中率、额外显存、与 KV cache 的争用在文中只定性提及。
- **通用任务未全面碾压**：MMLU、AIME 等与同量级模型互有胜负，agentic/coding 优势部分来自数据配方而非纯架构。

**未来方向（idea 三法）**：

- *弥补缺陷*：设计跨层 embedding 注入机制（如每若干层重新接入 NE 输出）以对抗深度衰减；为 hash 碰撞建理论模型，给出给定语料的词表下界。
- *新型方案*：把 N-gram Embedding 直接做成 draft model——论文已指出 NE 隐含局部上下文，可挂轻量线性投影做超快 draft，或用 NE 表示对外部 draft token 做 early rejection。
- *减少约束*：探索 NE 与 PLE 的混合分配（在深网络底部集中放 NE、上部放 PLE），在固定激活参数预算下最大化收益。

## 9. 相关阅读

- [LongCat-2.0 正式发布](/vibe-reading/articles/longcat-official-2-0-release) — **后续**·LongCat-2.0 直接继承了本篇的 N-gram Embedding，在 135B N-gram 参数规模上验证了该设计
- [LongCat-Flash-Omni Technical Report](/vibe-reading/articles/AI/Models/Omni%20Model/Papers/longcat-flash-omni-technical-report) — **同家族**·Flash 系列全模态版，同栈 ScMoE 骨干 + 流式 pipeline
- [LongCat Sparse Attention](/vibe-reading/articles/longcat-sparse-attention) — **同家族**·LongCat 团队长上下文稀疏注意力，与本篇同属 LongCat 文本模型栈
- [Patterns behind Chaos: Forecasting Data Movement for MoE Inference](/vibe-reading/articles/AI/Infra/Inference/Papers/moe-data-movement-forecasting) — **方法论镜像**·同样关注 MoE 推理的显存带宽/数据搬运瓶颈，可对照本篇的系统优化思路
