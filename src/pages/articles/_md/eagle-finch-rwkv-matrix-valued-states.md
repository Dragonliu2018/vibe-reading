---
title: "Eagle and Finch: RWKV with Matrix-Valued States and Dynamic Recurrence"
source:
  type: "论文解读"
  project: "RWKV"
  url: "https://arxiv.org/abs/2404.05892"
  pdf: "/vibe-reading/papers/eagle-finch-rwkv-matrix-valued-states.pdf"
date: "2026-08-04T18:00:00+08:00"
category: [AI, Models, Text Model, RWKV, Papers]
tags: ["RNN", "Matrix-Valued State", "Dynamic Recurrence", "Linear Attention", "RWKV-5", "RWKV-6", "Data-Dependent Decay", "Token Shift", "Multilingual", "LoRA"]
description: "目的：提升 RWKV 架构表达力。手段：矩阵值状态 + 数据依赖衰减 + DDLerp token shift + 多语言语料。结论：Eagle/Finch 多语言 SOTA，推理 O(d) 内存。"
readingTime: "16 min"
aiModel: "Claude Opus 5 (1M context)"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/eagle-finch-rwkv-matrix-valued-states.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Eagle and Finch: RWKV with Matrix-Valued States and Dynamic Recurrence](https://arxiv.org/abs/2404.05892) · **作者** Bo Peng, Daniel Goldstein, Quentin Anthony 等 31 人（RWKV Project / EleutherAI / Recursal AI 等）· **发表** arXiv 2404.05892, 2024-04 (v4: 2024-09) · **项目** https://github.com/RWKV/RWKV-LM · **解读** 2026-08-04

---

## 1. 论文概览

**一句话**：Eagle（RWKV-5）和 Finch（RWKV-6）在 RWKV-4 的基础上引入多头矩阵值状态和数据依赖动态递归，在保持 RNN O(1) 推理复杂度的同时显著提升了模型表达力——Eagle 将向量状态升级为矩阵状态并引入 SiLU 门控，Finch 进一步让时间衰减和 token shift 都变成数据依赖的，在多语言基准上大幅推进 Pareto 前沿。

- **任务**：大规模语言模型预训练与多语言建模——在 1.12 万亿 token 的 RWKV World v2 多语言语料上训练 0.4B 到 7.5B 参数的模型。
- **核心创新**：(1) 多头矩阵值状态——将 RWKV-4 的向量状态 $s \in \mathbb{R}^d$ 升级为矩阵 $s \in \mathbb{R}^{(d/h) \times (d/h)}$，表达力提升一个量级；(2) 数据依赖动态递归（Finch）——时间衰减 $w_t$ 不再是静态学习参数，而是由 LoRA 模块根据输入动态生成；(3) RWKV World Tokenizer——基于 Trie 的贪心匹配分词器，65536 词表，多语言高效；(4) RWKV World v2 数据集——1.12T token，70% 英语 + 15% 多语言 + 15% 代码。
- **结果**：在多语言基准上 Eagle/Finch 大幅推进 Pareto 前沿；Finch 在 MQAR 上超越所有已知非 Transformer 架构；推理速度在 16k 序列长度上比 Flash Attention 快 4.2×，内存少 40%。

**take-home**：RWKV 的进化路径清晰——从向量到矩阵（Eagle），从静态到动态（Finch）。矩阵值状态将 RNN 的信息存储能力从 $O(dL)$ 提升到 $O(d^2L/h)$，数据依赖衰减则让模型能根据内容自适应地控制遗忘速率，这两步升级让 RNN 在多语言和长序列任务上首次系统性超越同规模 Transformer。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We present Eagle (RWKV-5) and Finch (RWKV-6), sequence models improving upon the RWKV (RWKV-4) architecture. Our architectural design advancements include multi-headed matrix-valued states and a dynamic recurrence mechanism that improve expressivity while maintaining the inference efficiency characteristics of RNNs. We introduce a new multilingual corpus with 1.12 trillion tokens and a fast tokenizer based on greedy matching for enhanced multilinguality. We trained four Eagle models, ranging from 0.46 to 7.5 billion parameters, and two Finch models with 1.6 and 3.1 billion parameters and find that they achieve competitive performance across a wide variety of benchmarks. We release all our models on HuggingFace under the Apache 2.0 license.

> **译：** 我们提出 Eagle（RWKV-5）和 Finch（RWKV-6），改进 RWKV（RWKV-4）架构的序列模型。我们的架构设计进步包括多头矩阵值状态和动态递归机制，在保持 RNN 推理效率特征的同时提升表达力。我们引入了一个包含 1.12 万亿 token 的新多语言语料库和基于贪心匹配的快速分词器，以增强多语言能力。我们训练了四个 Eagle 模型（0.46 到 7.5B 参数）和两个 Finch 模型（1.6 和 3.1B 参数），发现它们在各种基准上实现了有竞争力的性能。我们在 HuggingFace 上以 Apache 2.0 许可证发布了所有模型。

</details>

---

## 2. 研究背景

RWKV-4 证明了 RNN 可以在 14B 规模上与 Transformer 竞争，但其向量值状态 $s \in \mathbb{R}^d$ 限制了信息存储容量，且静态时间衰减 $w$ 无法根据输入内容自适应调整。

| 架构 | 推理时间 | 推理内存 | 训练并行 | 状态类型 | 衰减方式 |
|---|---|---|---|---|---|
| Transformer | $O(N)$ | $O(N)$ | ✓ | — | — |
| LSTM/LMU | $O(1)$ | $O(1)$ | ✗ | 向量 | 固定 |
| Linear Transformer | $O(1)$ | $O(1)$ | ✓ | 向量 | 固定 |
| H3/S4 | $O(1)$ | $O(1)$ | ✓ | 向量 | 固定 |
| RWKV-4 | $O(1)$ | $O(1)$ | ✓ | 向量 | 静态学习 |
| Mamba | $O(1)$ | $O(1)$ | ✓ | 向量 | 数据依赖 |
| **Eagle (RWKV-5)** | **$O(1)$** | **$O(1)$** | **✓** | **矩阵** | **静态学习** |
| **Finch (RWKV-6)** | **$O(1)$** | **$O(1)$** | **✓** | **矩阵** | **数据依赖** |

RWKV-4 → Eagle → Finch 的进化逻辑：

1. **向量 → 矩阵**：RWKV-4 的状态 $s \in \mathbb{R}^d$ 只能存储 $d$ 个标量；Eagle 将其升级为 $h$ 个头，每头 $s \in \mathbb{R}^{(d/h) \times (d/h)}$，存储容量从 $O(d)$ 提升到 $O(d^2/h)$。
2. **静态 → 动态**：RWKV-4 和 Eagle 的衰减 $w$ 是静态学习参数；Finch 引入 LoRA 模块，让 $w_t$ 根据当前输入动态生成——类似 Mamba 的选择性机制，但应用于矩阵值状态。
3. **固定 token shift → 数据依赖 token shift**：RWKV-4/Eagle 的 token shift 系数 $\mu$ 是固定学习向量；Finch 用 DDLerp 让混合比例也随输入变化。

---

## 3. 方法详解

### 3.1 整体架构

![Figure 1：RWKV 架构总览。左侧为时间混合和通道混合块；右上为 RNN 递推形式；中下为 Eagle/Finch 的 token shift 模块。虚线表示 Finch 独有的连接。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-01-architecture-overview.png)

Eagle 和 Finch 的核心架构与 RWKV-4 保持一致——堆叠的残差块，每块包含时间混合（Time Mixing）和通道混合（Channel Mixing）两个子层。关键改进集中在时间混合模块。

### 3.2 Eagle（RWKV-5）：矩阵值状态

Eagle 的核心改动是将 RWKV-4 的标量 WKV 运算升级为矩阵运算。每个头的状态 $s$ 从向量 $\mathbb{R}^{d/h}$ 变为矩阵 $\mathbb{R}^{(d/h) \times (d/h)}$：

$$
\square_t = \text{lerp}_\square(x_t, x_{t-1}) W_\square, \quad \square \in \{r, k, v, g\}
$$

$$
w = \exp(-\exp(\omega))
$$

$$
\text{wkv}_t = \text{diag}(u) \cdot k_t^\top \cdot v_t + \sum_{i=1}^{t-1} \text{diag}(w)^{t-1-i} \cdot k_i^\top \cdot v_i
$$

其中 $w = \exp(-\exp(\omega))$ 确保衰减率在 $(0,1)$ 区间内，$\text{diag}(w)$ 是收缩矩阵。输出门控从 RWKV-4 的 Sigmoid 改为 SiLU：

$$
o_t = \text{concat}\left(\text{SiLU}(g_t) \odot \text{LayerNorm}(r_t \cdot \text{wkv}_t)\right) W_o
$$

Eagle 相对 RWKV-4 的四项关键改进：
1. **矩阵值状态**：$k^\top v$ 是外积，产生矩阵状态，信息容量大幅提升
2. **SiLU 门控**：替换 Sigmoid，梯度更稳定
3. **LayerNorm over heads**：等价于 GroupNorm，稳定多头训练
4. **去除 Sigmoid 接收率**：$r$ 直接作为线性注意力中的 query 角色

### 3.3 Finch（RWKV-6）：数据依赖动态递归

Finch 在 Eagle 基础上引入两个数据依赖机制：

**DDLerp（数据依赖 token shift）**：

$$
\text{lora}_\square(x) = \lambda_\square + \tanh(x A_\square) B_\square
$$

$$
\text{ddlerp}_\square(a, b) = a + (b - a) \odot \text{lora}_\square(a + (b - a) \odot \mu_x)
$$

其中 $A_\square \in \mathbb{R}^{D \times 32}$, $B_\square \in \mathbb{R}^{32 \times D}$ 是 LoRA 权重矩阵。这使得 token shift 的混合比例不再固定，而是由当前和上一时间步的输入共同决定。

**数据依赖时间衰减**：

$$
d_t = \text{lora}_d(\text{ddlerp}_d(x_t, x_{t-1}))
$$

$$
w_t = \exp(-\exp(d_t))
$$

在 Eagle 中 $w$ 是静态的；在 Finch 中 $w_t$ 随每个时间步动态变化——模型可以根据输入内容自适应地决定遗忘速率。这是 Finch 的核心创新，也是与 Mamba 选择性机制的关键区别：Finch 的选择性作用于矩阵值状态，而非向量状态。

![Figure 10：Eagle 详细架构。展示完整的 RWKV Block 结构，包括 WKV 头部的矩阵状态递推（dim 64×64）、LayerNorm、SiLU 门控等组件。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-10-eagle-detailed-architecture.png)

### 3.4 RWKV World Tokenizer

针对 BPE 分词器在非欧洲语言上的效率问题，RWKV World Tokenizer 采用 Trie（前缀树）+ 贪心最长匹配：

- **词表大小**：$V = 65536$
- **多语言覆盖**：合并 GPT-NeoX-20B、GPT-2、cl100k_base、Llama2、Bloom 的词表，手动选取非欧洲语言 token
- **速度**：Rust 实现 90.32 MB/s，比 Tiktoken 快 9.6×

| 分词器 | 类型 | 速度 (MB/s) |
|---|---|---|
| RWKV (Rust) | 贪心匹配 | 90.32 |
| Tiktoken o200k | BPE | 9.34 |
| RWKV (Python) | 贪心匹配 | 5.31 |
| BERT | WordPiece | 3.44 |
| Llama2 | BPE | 2.40 |

### 3.5 RWKV World v2 数据集

| 组成 | 占比 | 来源 |
|---|---|---|
| 英语 | ~70% | SlimPajama, peS2o, OpenWebText2, Books 等 |
| 多语言 | ~15% | OSCAR23.01, TED2020, EuroParl, BELLE 10M Chinese 等 |
| 代码 | ~15% | StarCoder (≥10 stars) |

总计 1.12 万亿 token，强调事实知识和文化作品（故事、书籍、字幕、对话）。

### 3.6 通道混合

通道混合模块与 RWKV-4 基本一致，仅将隐藏维度从 $4D$ 降至 $3.5D$（为时间混合的新门控权重腾出参数预算）：

$$
r'_t = \text{lerp}_{r'}(x'_t, x'_{t-1}) W_{r'}
$$

$$
o'_t = \sigma(r'_t) \odot v'_t
$$

---

## 4. 关键公式解读

### Eagle WKV（矩阵状态递推形式）

$$
\text{wkv}' = s + \text{diag}(u) \cdot k^\top \cdot v
$$

$$
s' = \text{diag}(w) \cdot s + k^\top \cdot v
$$

**关键洞察**：状态 $s$ 是一个 $(d/h) \times (d/h)$ 矩阵——本质是历史 $k^\top v$ 外积的指数加权累积。每个通道独立衰减，当前 token 通过 $u$ 获得特殊权重。与 RWKV-4 相比，矩阵状态的信息存储容量提升了 $d/h$ 倍（即每头 64 倍）。

### Finch WKV（数据依赖衰减）

$$
\text{wkv}_t = \text{diag}(u) \cdot k_t^\top \cdot v_t + \sum_{i=1}^{t-1} \text{diag}\left(\prod_{j=i+1}^{t} w_j\right) \cdot k_i^\top \cdot v_i
$$

**关键洞察**：衰减因子从 $w^{t-1-i}$（Eagle 的指数衰减）变为 $\prod_{j=i+1}^{t} w_j$（Finch 的乘积衰减）——每一步的衰减率 $w_j$ 都由输入动态决定。这使得模型可以对重要信息降低衰减率（"记住"），对无关信息提高衰减率（"遗忘"），实现了类似 Mamba 的选择性但作用于矩阵状态。

### DDLerp（数据依赖线性插值）

$$
\text{ddlerp}_\square(a, b) = a + (b - a) \odot \text{lora}_\square(a + (b - a) \odot \mu_x)
$$

**关键洞察**：标准 lerp 的混合系数 $\mu$ 是固定的；DDLerp 用 LoRA 模块根据输入生成混合系数。直觉上，重要信息可以"标记自己"被更多纳入数据流，不重要信息可以"回避"进入数据流——为 induction head 的形成提供了更灵活的机制。

---

## 5. 实验设置

### 模型配置

| 模型 | 层数 | 维度 | 头数 | 参数量 | 训练 FLOPs |
|---|---|---|---|---|---|
| Eagle 0.4B | 24 | 1024 | 16 | 4.62×10⁸ | 2.80×10⁹ |
| Eagle 1.5B | 24 | 2048 | 32 | 1.58×10⁹ | 9.52×10⁹ |
| Eagle 3B | 32 | 2560 | 40 | 3.06×10⁹ | 1.85×10¹⁰ |
| Eagle 7B | 32 | 4096 | 64 | 7.52×10⁹ | 4.53×10¹⁰ |
| Finch 1.6B | 24 | 2048 | 32 | 1.60×10⁹ | 9.66×10⁹ |
| Finch 3B | 32 | 2560 | 40 | 3.10×10⁹ | 1.87×10¹⁰ |

### 评估基准

| 维度 | 基准 |
|---|---|
| 多语言 | LAMBADA Multilingual, xStoryCloze, xWinoGrande, xCOPA, PAWS-X, XNLI |
| 英语 | LAMBADA, HellaSwag, PIQA, ARC, Winogrande, SciQ, COPA 等 |
| 关联记忆 | MQAR (Multi-Query Associative Recall) |
| 长序列 | PG19 (loss vs position), Bamboo |
| 速度/内存 | A100 80GB, 对比 Flash Attention v2 和 Mamba |
| 多模态 | VisualRWKV (GQA, ScienceQA-IMG, Text-VQA, POPE), AudioRWKV |

### 复现信息

- **代码开源**：https://github.com/RWKV/RWKV-LM（训练）、https://github.com/RWKV/ChatRWKV（推理）
- **预训练权重**：https://huggingface.co/RWKV（Apache 2.0，全系列）
- **数据集**：RWKV World v2（公开数据组成）
- **算力**：Stability AI 提供 A100/H800

---

## 6. 实验结果

### 多语言基准（核心优势）

![Figure 2：多语言基准平均准确率 vs 训练 FLOPs。Eagle 和 Finch 在多语言任务上大幅推进 Pareto 前沿，显著优于 Pythia、Mamba 等同规模模型。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-02-multilingual-benchmarks.png)

| 模型 | lmb.m (ppl↓) | xcopa (acc↑) | xnli (acc↑) | xsClz (acc↑) | xwin (acc↑) | avg |
|---|---|---|---|---|---|---|
| RWKV-4-1.5b | 72.5 | 55.4 | 39.3 | 56.0 | 67.7 | 51.8 |
| Eagle-1.5b | 43.2 | 57.9 | 40.4 | 57.9 | 73.0 | 54.3 |
| Finch-1.6b | 37.5 | 58.0 | 41.4 | 57.9 | 74.9 | 55.0 |
| RWKV-4-7b | 33.1 | 60.1 | 41.2 | 60.9 | 76.5 | 56.4 |
| **Eagle-7B** | **21.0** | **62.2** | **44.0** | **63.3** | **80.4** | **58.2** |
| Llama-2-7b | 30.4 | 56.7 | 39.9 | 57.5 | 79.5 | 54.3 |

关键发现：
1. **多语言 SOTA**：Eagle-7B 在多语言平均分上超越 Llama-2-7B 3.9 个百分点，LAMBADA Multilingual 困惑度从 30.4 降至 21.0。
2. **矩阵状态增益显著**：Eagle-1.5b 的多语言 ppl 从 RWKV-4-1.5b 的 72.5 降至 43.2——矩阵状态对多语言建模的提升远超英语。
3. **Finch 持续改进**：Finch-1.6b 在所有多语言指标上均优于 Eagle-1.5b，数据依赖衰减对跨语言泛化有实质帮助。

### 英语基准

![Figure 3：英语基准平均准确率 vs 训练 FLOPs。Eagle 和 Finch 在英语任务上与同规模 Transformer 模型表现相当。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-03-english-benchmarks.png)

| 模型 | lmb.o | hella | piqa | arcC | avg |
|---|---|---|---|---|---|
| RWKV-4-1.5b | 60.1 | 51.6 | 71.5 | 27.1 | 59.2 |
| Eagle-1.5b | 65.7 | 55.0 | 71.1 | 28.7 | 62.4 |
| Finch-1.6b | 66.8 | 57.3 | 72.6 | 29.8 | 62.9 |
| Eagle-7B | 74.2 | 70.9 | 77.0 | 39.5 | 71.5 |
| Mistral-7B | 75.5 | 81.0 | 80.5 | 50.1 | 75.8 |

关键发现：英语任务上 Eagle/Finch 与同规模模型竞争，但与 Mistral-7B 仍有差距——这部分归因于训练数据量（1.12T vs 更大）和 RNN 架构在精确回看上的固有限制。

### 关联记忆（MQAR）

![Figure 4：MQAR 任务准确率。序列长度增加表示任务难度提升。Finch 在 MQAR 上超越所有已知非 Transformer 架构。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-04-mqar-tasks.png)

关键发现：Finch 在 MQAR 上达到极高准确率，超越所有已知非 Transformer 架构——矩阵值状态 + 数据依赖衰减的组合显著增强了关联记忆能力。尽管 Mamba 也有矩阵值状态和数据依赖机制，Finch 的不同组合方式表现更优。

### 长序列外推

![Figure 5：PG19 上 loss 随序列位置的变化。所有模型预训练上下文长度为 4096，但 Eagle 和 Finch 在远超训练长度的位置上 loss 持续降低。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-05-long-context-loss.png)

关键发现：尽管仅以 4096 上下文长度训练，Eagle 在 PG19 上的长序列 loss 大幅优于 RWKV-4，Finch 进一步改进——RNN 架构天然无上下文长度限制，矩阵状态和数据依赖衰减有效提升了长程信息保持。

### 速度与内存

![Figure 6：内存使用 vs 序列长度。Finch 在所有序列长度上均优于 Flash Attention v2 和 Mamba。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-06-memory-usage.png)

![Figure 7：推理时间 vs 序列长度。Finch 在 16k 序列长度上比 Flash Attention v2 快 4.2×。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-07-time-vs-seqlen.png)

| 指标 | Flash Attention v2 | Mamba | Finch |
|---|---|---|---|
| 16k 推理速度 | 基线 | 略快 | **4.2× 更快** |
| 内存使用 | 基线 | 少 17% | **少 40%** |

**关键洞察**：Finch 的训练时间随序列长度线性增长（与 Mamba 相同），在长序列上远超 Flash Attention 的二次增长——这是 RNN 架构在长序列场景的结构性优势。

### 多模态扩展

![Figure 9：VisualRWKV 架构。使用 CLIP 作为视觉编码器，Eagle 作为语言模型，通过两阶段指令微调实现视觉语言理解。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-09-visualrwkv-architecture.png)

VisualRWKV 用 CLIP-L (0.4B) + Eagle (1.5B/3B) 在 4 项基准上达到与 CLIP-G (1.0B) + 7B/13B LLM 组合可比的水平——证明了 RWKV 架构在多模态场景的泛化能力。

### 音乐建模

![Figure 8：RWKV-4-Music 与 RWKV-5-Music 的 loss 随序列位置变化。RWKV-5 在乐谱部分的 loss 约低 2%。](/vibe-reading/images/articles/eagle-finch-rwkv-matrix-valued-states/fig-08-music-modelling-loss.png)

RWKV-5-Music 的 loss 比 RWKV-4-Music 低约 2%，改进主要体现在乐谱部分——Eagle 架构对序列模式建模有更强能力。

---

## 7. 消融实验

### 架构消融（Pile 数据集，170M 参数）

| 模型 | ppl ↓ | avg acc ↑ |
|---|---|---|
| RWKV-4-Pile | 29.2 | 47.7 |
| Pythia | 24.4 | 47.9 |
| Mamba | 16.0 | 50.1 |
| **RWKV-6-Pile** | **16.1** | **50.7** |

**关键发现**：在相同数据集和分词器下，RWKV-6 的 ppl 与 Mamba 相当（16.1 vs 16.0），但平均准确率更高（50.7 vs 50.1）——纯架构改进（矩阵状态 + 动态递归）确实贡献了性能提升，不依赖于数据集或分词器优势。

### DDLerp 消融

| 配置 | Final Validation Loss |
|---|---|
| Finch（完整 DDLerp） | 2.91 |
| Finch（DDLerp 仅用于衰减） | 2.923 |
| Finch（无 DDLerp） | 2.926 |

**关键发现**：DDLerp 的贡献虽小但一致——完整 DDLerp 比无 DDLerp 低 0.016 loss。数据依赖 token shift 的主要价值在于与数据依赖衰减的协同。

### Bamboo 长上下文基准

| 模型 | meetingqa | paperqa | senhallu | abshallu | avg |
|---|---|---|---|---|---|
| Eagle-1.5b | 21.0% | 19.0% | 13.2% | 23.5% | 9.2% |
| Finch-1.6b | 19.0% | 22.0% | 10.7% | 17.3% | 8.9% |
| Eagle-7b-Hermes | 31.0% | 23.0% | 50.3% | 46.9% | 16.8% |
| LLaMA2-Chat-7b | 6.0% | 17.0% | 64.7% | 63.4% | 24.1% |

Eagle-7B 在 Bamboo 上平均超 Pythia 13.5%，在多项任务上超 LLaMA2-Chat-7B——但在幻觉检测任务上与指令微调的 LLaMA2 仍有差距。

---

## 8. 总结与展望

### 贡献总结

| 贡献 | 意义 |
|---|---|
| 多头矩阵值状态 | 将 RNN 状态存储从 $O(d)$ 提升到 $O(d^2/h)$，信息容量提升一个量级 |
| 数据依赖动态递归（Finch） | 让时间衰减随输入动态变化，实现选择性记忆/遗忘 |
| DDLerp token shift | 数据依赖的 token 混合，增强 induction head 形成能力 |
| RWKV World Tokenizer | Trie 贪心匹配，多语言效率高，速度比 Tiktoken 快 9.6× |
| RWKV World v2 数据集 | 1.12T token 多语言语料，公开可用 |
| 全栈开源 | 6 个模型（0.4B~7.5B）Apache 2.0，训练/推理代码全开源 |

### 局限性

- **英语仍有差距**：Eagle-7B 在英语基准上落后 Mistral-7B 约 4.3 个百分点——训练数据量（1.12T）小于当代模型，且 RNN 无法精确回看历史 token。
- **嵌入模型表现弱**：在 MTEB 基准上未获得强力嵌入性能——矩阵状态是高质量的上下文嵌入，但缺乏合适的聚合方法。
- **训练数据偏见**：语料含 GPT-3.5/ChatGPT 合成数据，模型会模仿 ChatGPT 的对话风格——这不是架构问题而是数据问题。
- **MoE 未探索**：论文未尝试 Mixture of Experts，更大的 Finch（7B/14B）和 MoE 是未来方向。
- **DDLerp 增益有限**：消融显示 DDLerp 的独立贡献较小（0.016 loss），主要价值在于与动态衰减的协同。

### 未来方向

- **弥补缺陷**：扩大训练语料规模和多样性；探索更大的 Finch 模型（7B/14B）；引入 MoE 降低推理成本；研究矩阵状态的高效嵌入聚合方法。
- **新型方案**：将 RWKV 机制扩展到 encoder-decoder 架构；探索更大的 LoRA 权重矩阵（论文指出 7B+ 模型可加倍）；将数据依赖机制应用于更多模块。
- **减少约束**：进一步优化 CUDA 内核实现（论文承认当前 Finch CUDA 实现仍有优化空间）；统一硬件抽象层降低新硬件适配门槛。

**与 RWKV 系列的关联**：Eagle 和 Finch 是 RWKV 架构进化的关键一步。RWKV-4 证明了 RNN 可以在 LLM 规模竞争；Eagle 将状态从向量升级为矩阵，解决了信息容量瓶颈；Finch 引入数据依赖机制，解决了静态衰减的限制。这三代架构的进化路径——向量→矩阵、静态→动态——与 Mamba（S4→选择性 SSM）的进化逻辑平行，但 RWKV 的独特之处在于完全开源、矩阵状态更大（$64 \times 64$ vs Mamba 的向量状态），以及在多语言基准上的系统性优势。
