---
title: 'RWKV-7 "Goose" with Expressive Dynamic State Evolution'
source:
  type: "论文解读"
  project: "RWKV"
  url: "https://arxiv.org/abs/2503.14456"
  pdf: "/vibe-reading/papers/rwkv-7-goose-expressive-dynamic-state-evolution.pdf"
date: "2026-08-04T19:00:00+08:00"
category: [AI, Models, Text Model, RWKV, Papers]
tags: ["RNN", "Generalized Delta Rule", "Matrix-Valued State", "Dynamic Recurrence", "State Tracking", "Regular Languages", "TC0", "NC1", "Linear Attention", "RWKV-7", "Data-Dependent Decay", "Value Residual", "LoRA", "Multilingual"]
description: "目的：提升 RNN 表达力超越 TC0。手段：广义 delta rule + 向量值门控 + 解耦移除/替换键 + 值残差。结论：RWKV-7 多语言 SOTA，可识别所有正则语言。"
readingTime: "18 min"
aiModel: "Claude Opus 5 (1M context)"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/rwkv-7-goose-expressive-dynamic-state-evolution.pdf" target="_blank" rel="noopener">预览</a> · **论文** [RWKV-7 "Goose" with Expressive Dynamic State Evolution](https://arxiv.org/abs/2503.14456) · **作者** Bo Peng, Ruichong Zhang, Daniel Goldstein 等 18 人（RWKV Project / EleutherAI / Tsinghua University / Recursal AI 等）· **发表** arXiv 2503.14456, 2025-03 (v2: 2025-03-30) · **项目** https://github.com/RWKV/RWKV-LM · **解读** 2026-08-04

---

## 1. 论文概览

**一句话**：RWKV-7 "Goose" 将 delta rule 从标量推广到向量值门控和上下文学习率，并解耦移除键与替换键，使 RNN 的状态转移矩阵变为非对角且输入依赖——理论证明其表达力超越 TC0（可识别所有正则语言），实验上以不到三分之一的数据量匹配 Qwen2.5 的英语性能并在多语言基准上大幅领先。

- **任务**：大规模语言模型预训练——在 3.1 万亿 token 的 RWKV World v3 语料上训练 0.19B 到 2.9B 参数的模型，保持 RNN O(1) 推理复杂度。
- **核心创新**：(1) 广义 delta rule——将状态更新推广为对角加秩一更新 $S_{t-1}(\text{diag}(w_t) + z_t^\top b_t) + v_t^\top k_t$，允许向量值门控和上下文学习率；(2) 解耦移除键 $\hat{\kappa}_t$ 和替换键 $\tilde{k}_t$——移除旧信息和添加新信息使用不同的键；(3) 理论突破——证明 RWKV-7 可用常数层识别所有正则语言，在标准复杂度假设 TC0 ≠ NC1 下超越 Transformer 的 TC0 上界；(4) 值残差学习——跨层值前驱插值，改善最终 loss。
- **结果**：RWKV-7-World3-2.9B 在多语言平均 61.1（超 Qwen2.5-3B 的 55.6 达 5.5pp），英语平均 71.5（匹配 Qwen2.5-3B 的 71.4），仅用 5.6T token（Qwen2.5 用 18T）；推理内核比 RWKV-6 快 3×。

**take-home**：RWKV 的进化从"向量→矩阵"（Eagle）和"静态→动态"（Finch）走到了"标量 delta→向量 delta"（Goose）。广义 delta rule 让 RNN 的状态转移矩阵首次具备非对角、输入依赖的特性——这是理论上超越 TC0 的关键，也是 RWKV 系列从工程优化走向表达力根本突破的标志。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We present RWKV-7 "Goose", a new sequence modeling architecture with constant memory usage and constant inference time per token. Despite being trained on dramatically fewer tokens than other top models, our 2.9 billion parameter language model achieves a new 3B SoTA on multilingual tasks and matches the current 3B SoTA on English language downstream performance. RWKV-7 introduces a newly generalized formulation of the delta rule with vector-valued gating and in-context learning rates, as well as a relaxed value replacement rule. We show that RWKV-7 can perform state tracking and recognize all regular languages, while retaining parallelizability of training. This exceeds the capabilities of Transformers under standard complexity conjectures, which are limited to TC0. To demonstrate RWKV-7's language modeling capability, we also present an extended open source 3.1 trillion token multilingual corpus, and train four RWKV-7 models ranging from 0.19 billion to 2.9 billion parameters on this dataset. To foster openness, reproduction, and adoption, we release our models and dataset component listing on Hugging Face, and our training and inference code on GitHub; all under the Apache 2.0 License.

> **译：** 我们提出 RWKV-7 "Goose"，一种具有常数内存使用和每 token 常数推理时间的新序列建模架构。尽管训练所用的 token 数量远少于其他顶级模型，我们的 29 亿参数语言模型在多语言任务上实现了新的 3B SoTA，并在英语下游性能上匹配当前 3B SoTA。RWKV-7 引入了广义 delta rule 公式，具有向量值门控和上下文学习率，以及松弛的值替换规则。我们证明 RWKV-7 可以执行状态跟踪并识别所有正则语言，同时保持训练的可并行性。在标准复杂度假设下，这超越了受 TC0 限制的 Transformer 的能力。为展示 RWKV-7 的语言建模能力，我们还提供了一个扩展的 3.1 万亿 token 开源多语言语料库，并在此数据集上训练了四个 RWKV-7 模型（0.19B 到 2.9B 参数）。为促进开放、复现和采用，我们在 HuggingFace 上以 Apache 2.0 许可证发布了模型和数据集组件列表，以及在 GitHub 上发布了训练和推理代码。

</details>

---

## 2. 研究背景

线性注意力的核心优势是可表述为 RNN（常数推理时间/内存），但其数值累加机制存在根本缺陷：旧状态内容永远不被移除，只通过衰减减小比例，最终导致不同键的值混合在一起。

| 架构 | 状态演化 | LS | FD | DD | GE |
|---|---|---|---|---|---|
| RWKV-4 | $s_t = e^{-w} \odot s_{t-1} + e^{k_t} \odot v_t$ | ✗ | ✓ | ✗ | ✗ |
| RetNet | $S_t = w S_{t-1} + v_t^\top k_t$ | ✓ | ✗ | ✗ | ✗ |
| RWKV-5 | $S_t = S_{t-1}\text{diag}(w) + v_t^\top k_t$ | ✓ | ✓ | ✗ | ✗ |
| Mamba | $S_t = S_{t-1} \odot \exp(-\exp(w_t) \odot \exp(A)) + (w_t \odot v_t)^\top k_t$ | ✓ | ✓ | ✓ | ✗ |
| RWKV-6 | $S_t = S_{t-1}\text{diag}(w_t) + v_t^\top k_t$ | ✓ | ✓ | ✓ | ✗ |
| Gated DeltaNet | $S_t = w_t S_{t-1}(I - a_t k_t^\top k_t) + a_t v_t^\top k_t$ | ✓ | ✗ | ✓ | ✗ |
| **RWKV-7** | $S_t = S_{t-1}(\text{diag}(w_t) - \hat{\kappa}_t^\top(a_t \odot \hat{\kappa}_t)) + v_t^\top \tilde{k}_t$ | **✓** | **✓** | **✓** | **✓** |

> LS=大状态（矩阵值），FD=灵活衰减（维度≥模型维度），DD=动态依赖（衰减随输入变化），GE=广义特征值（转移矩阵特征值可超出 [0,1]）。

DeltaNet 首次将 delta rule（误差校正规则）引入键值压缩状态——通过部分替换当前键存储的值来解决信息累积问题。但 DeltaNet 使用标量学习率 $a$ 和标量衰减 $w$，且移除键和添加键相同。RWKV-7 的核心动机是：**将 delta rule 的每个标量参数推广为向量值，并解耦移除与添加的键**，从而获得更强的表达力和更灵活的状态控制。

---

## 3. 方法详解

### 3.1 整体架构

![Figure 1：RWKV-7 整体架构。堆叠的残差块每块包含 Time Mix 和 ReLU² MLP 两个子层。Token Shift → Weight Prepare → WKV7 Kernel → Readout 构成时间混合的核心数据流。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-01-architecture-overview.png)

RWKV-7 的宏观架构与 RWKV-6 保持一致——堆叠的残差块，每块包含时间混合和 MLP 两个子层。关键改进集中在时间混合模块的状态演化公式中。

### 3.2 广义 Delta Rule

RWKV-7 将 delta rule 推广为**对角加秩一更新**：

$$
S_t = S_{t-1}(\text{diag}(w_t) + z_t^\top b_t) + v_t^\top k_t
$$

其中 $z_t$ 和 $b_t$ 是数据依赖的小向量，$w_t$ 是数据依赖的向量值衰减。这个形式仍然是"对角+秩一"更新，保留了高效的并行化能力。

在 RWKV-7 的具体参数化中：

- $z_t = -\hat{\kappa}_t$（移除方向）
- $b_t = \hat{\kappa}_t \odot a_t$（移除强度，$a_t \in (0,1)$ 逐通道）

这给出最终的状态演化公式：

$$
\text{wkv}_t = \text{wkv}_{t-1}\left(\text{diag}(w_t) - \hat{\kappa}_t^\top(a_t \odot \hat{\kappa}_t)\right) + v_t^\top \cdot \tilde{k}_t
$$

![Figure 2：RWKV-7 单头状态更新机制示意。实际每头状态大小为 64×64。状态通过衰减矩阵 diag(w_t) 和 Householder 近似更新项进行演化。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-02-state-update-mechanism.png)

### 3.3 解耦移除键与替换键

RWKV-7 的关键创新是**解耦**了 delta rule 中的移除键和替换键：

- **移除键** $\hat{\kappa}_t = \kappa_t / \|\kappa_t\|_2$（L2 归一化后的 key precursor）
- **替换键** $\tilde{k}_t = k_t \odot \text{lerp}(1, a_t, \alpha)$（带有替换率助推器 $\alpha$ 的 normalized key）

在 DeltaNet 中，移除和添加使用同一个键 $k_t$；在 RWKV-6 中，$\tilde{k}_t = k_t \odot (1 - w_t)$（与衰减耦合）。RWKV-7 将两者完全解耦，使模型可以独立控制"移除什么旧信息"和"添加什么新信息"。

### 3.4 权重准备

RWKV-7 大量使用低秩 MLP（loramlp）来实现数据依赖，同时最小化参数量：

$$
a_t = \text{sigmoid}(\text{loramlp}_a(\text{Identity}, x_t^a, \text{bias=True}))
$$

$$
w_t = \exp(-e^{-0.5} \text{sigmoid}(d_t))
$$

衰减 $w_t$ 的范围被限制在 $(\exp(-e^{-0.5}), 1) \approx (0.607, 1)$，这保证了更好的训练稳定性和更小的条件数。

### 3.5 值残差学习

RWKV-7 引入了值残差学习（受 Zhou et al. 2024 启发）：

$$
v_t = \begin{cases} v'_{t,0} & \text{layer } l = 0 \\ \text{lerp}(v'_{t,0}, v'_{t,l}, \nu_t) & \text{layer } l \geq 1 \end{cases}
$$

其中 $\nu_t$ 是值残差门，$v'_{t,0}$ 是第零层的值前驱，$v'_{t,l}$ 是当前层的值前驱。这使得深层网络可以保留浅层提取的值信息。

### 3.6 简化 MLP

RWKV-7 的 MLP 模块去除了 RWKV-4/5/6 的门控矩阵 $W_r$，变为简单的两层 MLP：

$$
o'_t = \text{ReLU}(k'_t)^2 W_{v'}
$$

隐藏维度从 RWKV-6 的 3.5D 扩展到 4D（为移除的门控参数腾出参数预算）。

---

## 4. 关键公式解读

### RWKV-7 状态演化（递推形式）

$$
\text{wkv}_t = \text{wkv}_{t-1}\left(\text{diag}(w_t) - \hat{\kappa}_t^\top(a_t \odot \hat{\kappa}_t)\right) + v_t^\top \cdot \tilde{k}_t
$$

**关键洞察**：转移矩阵 $G_t = \text{diag}(w_t) - \hat{\kappa}_t^\top(a_t \odot \hat{\kappa}_t)$ 不再是 Householder 矩阵，而是其**缩放近似**。这模仿了 Householder 反射但扩展了动力学——所有特征值在 $[-1, 1]$ 范围内稳定，允许网络在所有子空间中衰减信息。与 DeltaNet 的 Householder 矩阵（特征值全为 1 除最后一个为 $1-a$）相比，RWKV-7 的转移矩阵拥有更丰富的谱结构。

### 转移矩阵的并行形式

$$
\text{wkv}_t = \sum_{i=1}^{t} \left( v_i^\top \tilde{k}_i \prod_{j=i+1}^{t} G_j \right)
$$

**关键洞察**：由于 $G_j$ 是对角加秩一矩阵，这个乘积可以用 Yang et al. (2024c) 的 DPLR 并行化方法高效计算——使训练时可以沿时间维度并行。

### 理论结果：超越 TC0

RWKV-7 的转移矩阵 $G_t$ 是**非对角且输入依赖**的。Merrill et al. (2024) 证明了 Transformer 和对角转移矩阵 RNN 只能表示 TC0 类函数。RWKV-7 的非对角转移矩阵打破了这一限制——论文证明 RWKV-7 可以用**单层**解决 S5 状态跟踪问题（已知在 NC1 但不在 TC0 中），并用**常数层**识别所有正则语言。

---

## 5. 实验设置

### 模型配置

| 模型 | 语料 | 参数量 | 训练 token | 分词器 |
|---|---|---|---|---|
| RWKV7-Pile-0.1B | Pile (332B) | 0.1B | — | GPT-NeoX-20B |
| RWKV7-Pile-0.4B | Pile | 0.4B | — | GPT-NeoX-20B |
| RWKV7-Pile-1.4B | Pile | 1.4B | — | GPT-NeoX-20B |
| RWKV7-World3-0.1B | World v3 | 0.1B | 1.6T (从 RWKV-5 续训) | RWKV World |
| RWKV7-World3-0.4B | World v3 | 0.4B | 3.1T (从 RWKV-5 续训) | RWKV World |
| RWKV7-World3-1.5B | World v3 | 1.5B | 5.6T (从 RWKV-6 续训) | RWKV World |
| RWKV7-World3-2.9B | World v3 | 2.9B | 5.6T (从 RWKV-6 续训) | RWKV World |

### RWKV World v3 数据集

| 组成 | 占比 |
|---|---|
| 英语 | ~70% |
| 多语言 | ~15% |
| 代码 | ~15% |

总计 3.119 万亿 token，旨在缩小与现代 LLM（15-18T token）的数据差距。

### 评估基准

| 维度 | 基准 |
|---|---|
| 英语 | LAMBADA, HellaSwag, PIQA, ARC, Winogrande, SciQ, MMLU |
| 多语言 | LAMBADA Multilingual, XCOPA, XNLI, XStoryCloze, xWinogrande |
| 关联记忆 | MQAR |
| 架构能力 | MAD (Mechanistic Architecture Design) |
| 长序列 | PG19 (loss vs position), Pass-key retrieval |
| 状态跟踪 | 群乘法 (A5, A4×Z5, Z60) |
| 速度/内存 | H100 GPU, 对比 Flash Attention v3 |
| 多模态 | VisualRWKV-7, AudioRWKV-7 |

### 复现信息

- **代码开源**：https://github.com/RWKV/RWKV-LM
- **预训练权重**：https://huggingface.co/RWKV（Apache 2.0，全系列）
- **算力**：12×8 = 96 Nvidia H800 GPUs

---

## 6. 实验结果

### 多语言基准（核心优势）

![Figure 3：多语言基准——训练 FLOPs vs 平均准确率（左）和活跃参数 vs 平均准确率（右）。RWKV-7 在多语言任务上大幅推进 Pareto 前沿。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-03-multilingual-benchmarks.png)

| 模型 | Token (T) | lmb.m (ppl↓) | xcopa | xnli | xsClz | xwin | avg |
|---|---|---|---|---|---|---|---|
| RWKV7-World3-1.5B | 5.6 | 25 | 48.4 | 54.8 | 59.7 | 43.7 | 61.4 |
| Qwen2.5-1.5B | 18.0 | 49 | 40.0 | 55.3 | 57.4 | 40.6 | 54.5 |
| **RWKV7-World3-2.9B** | **5.6** | **18** | **52.9** | **58.2** | **63.1** | **45.4** | **61.1** |
| Qwen2.5-3B | 18.0 | 36 | 43.5 | 53.3 | 59.0 | 38.5 | 55.6 |
| Llama3.2-3B | 15.0 | 30 | 45.9 | 59.9 | 58.5 | 44.2 | 58.1 |

关键发现：
1. **多语言 SOTA**：RWKV-7-2.9B 多语言平均 61.1，超 Qwen2.5-3B 5.5pp——仅用不到三分之一的数据量。
2. **LAMBADA Multilingual 困惑度**：从 Qwen2.5-3B 的 36 降至 18——2× 改善。
3. **从 RWKV-6 跃升**：RWKV-7-1.5B 的多语言平均 61.4 已超 RWKV-6-3B 的 57.9——半参数量超越前代。

### 英语基准

![Figure 4：英语基准——训练 FLOPs vs 平均准确率（左）和活跃参数 vs 平均准确率（右）。RWKV-7 在英语上与同规模 Transformer 模型表现相当。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-04-english-benchmarks.png)

| 模型 | Token (T) | lmb.o | hella | piqa | mmlu | avg |
|---|---|---|---|---|---|---|
| **RWKV7-World3-2.9B** | **5.6** | **73.4** | **76.4** | **79.7** | **55.0** | **71.5** |
| Qwen2.5-3B | 18.0 | 67.1 | 73.5 | 78.6 | 65.7 | 71.4 |

关键发现：英语平均 71.5 匹配 Qwen2.5-3B 的 71.4——但 MMLU 仍有差距（55.0 vs 65.7），部分归因于训练数据量不足（5.6T vs 18T）。

### 关联记忆（MQAR）

RWKV-7 仅用 8192 维 WKV 状态在 256 KV 对设置下达到 72.93% 准确率——信息密度 0.547 bits/dimension，证明矩阵状态的高效信息存储。

### MAD 架构能力基准

| 模型 | Compress | Fuzzy | In-Context | Memorable | Noisy | Selective | Avg |
|---|---|---|---|---|---|---|---|
| **RWKV-7** | 44.5 | 43.2 | **100** | 89.1 | **100** | 98.8 | **79.3** |
| Transformer | 51.6 | 29.8 | 94.1 | 85.2 | 86.8 | 99.6 | 74.5 |
| DeltaNet | 42.2 | 35.7 | 100 | 52.8 | 100 | 100 | 71.8 |
| Mamba | 52.7 | 6.7 | 90.4 | 89.5 | 90.1 | 86.3 | 69.3 |

RWKV-7 在 MAD 基准上取得最高平均分，在 Fuzzy Recall 上设定新的 SOTA（43.2）。

### 长序列外推

![Figure 5：PG19 上 loss vs 序列位置（Pile 训练模型）。RWKV-7 在远超预训练上下文长度（4096）的位置上 loss 持续降低。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-05-pg19-pile-long-context.png)

关键发现：Pile 训练的 RWKV-7 展示了良好的长序列外推能力——loss 在远超 4096 预训练上下文的位置持续降低。

![Figure 6：PG19 loss vs 序列位置（World 数据集训练模型）。与 Pile 训练模型不同，World 训练的 RWKV-7 在超过 10k 时 loss 出现上升趋势——论文推测是更大数据集和模型尺寸产生的归纳偏置导致对特定上下文长度的过拟合。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-06-pg19-world-long-context.png)

这是一个值得注意的**反直觉发现**：更大的数据集和模型反而损害了长序列外推能力。微调可以恢复长序列能力。

### Pass-key 检索

![Figure 7：Pass-key 检索评估。RWKV7-World3-1.5B（上排）和 2.9B（下排）在原始模型（左）和长序列微调后（右）的检索准确率。2.9B 原始模型在 35k 内完美检索，微调后扩展至 50k。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-07-pass-key-retrieval.png)

RWKV7-World3-2.9B 在 35k token 内实现完美检索；经 128k 长序列微调后扩展至 50k token。

### 状态跟踪

![Figure 8：群乘法任务——达到 >95% 准确率所需的最少层数（越低越好）。RWKV-7 在 A5、A4×Z5、Z60 三种群结构上均优于 Transformer、Mamba 和 S4。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-08-state-tracking.png)

关键发现：RWKV-7 展现了比 Transformer、Mamba 和 S4 更强的状态跟踪能力——与理论预测一致（RWKV-7 可用常数层识别所有正则语言）。但略弱于经典 RNN（经典 RNN 单层即可识别所有正则语言，但存在梯度消失和不可并行的问题）。

### 速度与内存

![Figure 9：推理时间 vs 序列长度（H100 GPU）。RWKV-7 内核线性增长，Flash Attention v3 二次增长。RWKV-7 内核比 RWKV-6 快约 3×。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-09-speed-vs-seqlen.png)

| 指标 | Flash Attention v3 | RWKV-6 | RWKV-7 | RWKV-7 fp32 |
|---|---|---|---|---|
| 16k 前向 | 33.9ms | — | **7.9ms** | 11.2ms |
| 16k 前向+反向 | — | — | 22.5ms | — |
| 变量数 | 10 | 10 | 18 | 24 |

**关键洞察**：RWKV-7 的优化 bfloat16 内核比 RWKV-6 快约 3×。在 16k 序列长度上，前向仅 7.9ms（Flash Attention v3 需 33.9ms）——4.3× 加速。RWKV-7 使用更多变量（18 vs 10）因为状态演化需要存储 $\hat{\kappa}$、$a \odot \hat{\kappa}$ 等中间量。

### 多模态扩展

![Figure 10：VisualRWKV-7 架构。输入图像经 SigLIP + DINOv2 + SAM 三视觉编码器处理后，通过 MLP with Context Gating 对齐到 RWKV-7 维度，与文本嵌入拼接后输入 RWKV-7 LLM。](/vibe-reading/images/articles/rwkv-7-goose-expressive-dynamic-state-evolution/fig-10-visualrwkv-architecture.png)

VisualRWKV-7 用三视觉编码器（SigLIP + DINOv2 + SAM，支持 1024×1024 分辨率）替换了 RWKV-6 的 CLIP 编码器。结果令人瞩目：VisualRWKV-7 0.4B 在 VQAv2 和 GQA 上超越 VisualRWKV-6 1.6B——1/4 参数超越前代。

---

## 7. 消融实验

### 架构消融（Pile 数据集，170M 参数）

RWKV-7 的每个设计选择（向量值 $a$、解耦键、值残差、loramlp 等）都通过消融实验验证了其独立贡献。详见论文 Appendix K。

### 增量训练策略

| 模型 | World v1 | World v2 | World v2.1 | World v3 | Total |
|---|---|---|---|---|---|
| RWKV7-World3-2.9B | 1.1T (RWKV-6) | 1.4T (RWKV-6) | 3.1T (RWKV-7) | 5.6T |

**关键发现**：RWKV-7 展示了一种无需从头预训练的架构升级方法——将 RWKV-6 的检查点转换为 RWKV-7 格式后继续训练。这大幅降低了计算成本，但论文承认这可能限制了模型性能（vs 从头训练）。

### 训练损失曲线

论文 Appendix Figure 12 显示 RWKV-7 World 模型的训练 loss 曲线平滑下降，验证了架构的数值稳定性。

---

## 8. 总结与展望

### 贡献总结

| 贡献 | 意义 |
|---|---|
| 广义 delta rule | 将 delta rule 从标量推广到向量值，表达力根本性提升 |
| 解耦移除/替换键 | 允许模型独立控制信息移除和添加 |
| 理论突破：超越 TC0 | 证明 RNN 可识别所有正则语言，理论上超越 Transformer |
| 值残差学习 | 跨层值信息保留，改善 loss |
| RWKV World v3 语料 | 3.1T token 公开多语言数据 |
| 增量训练方法 | 从 RWKV-5/6 检查点升级到 RWKV-7，降低训练成本 |
| 全栈开源 | 7 个模型 + 代码 + 数据集组件列表 Apache 2.0 |

### 局限性

- **数值精度敏感**：WKV7 内核对实现精度敏感，不同内核间存在训练动态差异。
- **无指令微调**：所有模型均为 base 模型，未经过 SFT/RLHF——不具备指令遵循能力。
- **Prompt 敏感性**：缺少特殊 token $\backslash n$ 会导致性能退化（如无法记住输入首 token）。
- **算力受限**：仅 96 张 H800 GPU，远少于 DeepSeek-V3 等大规模训练。被迫从旧检查点续训而非从头训练。
- **MMLU 差距**：英语 MMLU 落后 Qwen2.5-3B 约 10pp——训练数据量不足是主因。

### 未来方向

- **弥补缺陷**：扩大训练语料规模；从头训练更大的 RWKV-7 模型（7B/14B）；引入 MoE 降低推理成本；添加 SFT/RLHF 指令微调。
- **新型方案**：将 RWKV 机制扩展到 encoder-decoder 架构；探索更大的 LoRA 权重矩阵（论文指出 7B+ 模型可加倍）；引入 Chain-of-Thought 推理能力。
- **减少约束**：进一步优化 CUDA 内核实现；集成 DeepSeek-V3 的 Dual Pipelining、Multi-Token Prediction、FP8 Training 等加速技术。

**与 RWKV 系列的关联**：RWKV-7 是 RWKV 架构进化的第三步跨越。RWKV-4 证明了 RNN 可在 LLM 规模竞争；Eagle 将状态从向量升级为矩阵；Finch 引入数据依赖衰减；Goose 则将 delta rule 从标量推广到向量——使 RNN 的状态转移矩阵首次具备非对角结构，在理论上超越了 Transformer 的 TC0 表达力上界。这条进化路径——标量 delta → 向量 delta → 解耦键 → 非对角转移矩阵——为 RNN 架构的表达力提升开辟了新的数学基础。
