---
title: "RWKV: Reinventing RNNs for the Transformer Era"
source:
  type: "论文解读"
  project: "RWKV"
  url: "https://arxiv.org/abs/2305.13048"
  pdf: "/vibe-reading/papers/rwkv-reinventing-rnns-transformer-era.pdf"
date: "2026-08-04T17:00:00+08:00"
category: [AI, Models, Text Model, Papers]
tags: ["RNN", "Linear Attention", "Language Model", "WKV", "Token Shift", "Scaling Laws", "Parallelizable Training", "Inference Efficiency"]
description: "目的：统一 Transformer 训练效率与 RNN 推理效率。手段：线性注意力 WKV + token shift + 双模式切换。结论：14B 参数 SOTA，推理 O(d) 内存。"
readingTime: "15 min"
aiModel: "Claude Opus 5 (1M context)"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/rwkv-reinventing-rnns-transformer-era.pdf" target="_blank" rel="noopener">预览</a> · **论文** [RWKV: Reinventing RNNs for the Transformer Era](https://arxiv.org/abs/2305.13048) · **作者** Bo Peng, Eric Alcaide, Quentin Anthony 等 31 人（EleutherAI / Tsinghua / PKU 等）· **发表** arXiv 2305.13048, 2023-05 (v2: 2023-12) · **项目** https://github.com/BlinkDL/RWKV-LM · **解读** 2026-08-04

---

## 1. 论文概览

**一句话**：RWKV 提出了一种名为 Receptance Weighted Key Value 的新架构——通过线性注意力机制将 Transformer 的并行训练能力与 RNN 的常数推理复杂度统一在同一模型中，训练时按 Transformer 模式并行展开，推理时按 RNN 模式逐步递推，在 14B 参数规模上达到与同规模 Transformer 相当的性能。

- **任务**：大规模语言模型预训练——在 Pile 数据集上训练 169M 到 14B 参数的模型，验证 RNN 架构在 LLM 规模上的可行性。
- **核心创新**：(1) WKV 算子——将注意力的 $QK^\top V$ 替换为通道级时间衰减加权的线性形式，推理复杂度 $O(d)$；(2) 双模式统一——同一模型可表述为 Transformer（训练并行）或 RNN（推理递推），无需近似；(3) Token Shift——用当前与上一时间步的线性插值替代位置编码，实现时间信息传递。
- **结果**：在 12 项 NLP 基准上与 Pythia/OPT/BLOOM FLOP 匹配对比中表现相当；遵循与 Transformer 相同的 scaling law（$r^2=0.994$）；推理内存复杂度 $O(d)$（Transformer 为 $O(T^2+Td)$）；长文本微调可将上下文扩展至 8192 且 loss 持续降低。

**take-home**：RNN 没有死——它只是需要一次"架构重设计"：把注意力的二次 QK 运算换成通道级线性衰减，把位置编码换成 token shift，把串行限制变成推理优势。RWKV 证明了 RNN 可以在 14B 规模上与 Transformer 平起平坐。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Transformers have revolutionized almost all natural language processing (NLP) tasks but suffer from memory and computational complexity that scales quadratically with sequence length. In contrast, recurrent neural networks (RNNs) exhibit linear scaling in memory and computational requirements but struggle to match the same performance as Transformers due to limitations in parallelization and scalability. We propose a novel model architecture, Receptance Weighted Key Value (RWKV), that combines the efficient parallelizable training of transformers with the efficient inference of RNNs. Our approach leverages a linear attention mechanism and allows us to formulate the model as either a Transformer or an RNN, thus parallelizing computations during training and maintains constant computational and memory complexity during inference. We scale our models as large as 14 billion parameters, by far the largest dense RNN ever trained, and find RWKV performs on par with similarly sized Transformers, suggesting future work can leverage this architecture to create more efficient models.

> **译：** Transformer 革命性地改变了几乎所有 NLP 任务，但其内存和计算复杂度随序列长度二次增长。相比之下，RNN 的内存和计算需求呈线性增长，但由于并行化和可扩展性的限制，难以达到 Transformer 同等的性能。我们提出了一种新架构 RWKV（Receptance Weighted Key Value），将 Transformer 的高效并行训练与 RNN 的高效推理相结合。我们的方法利用线性注意力机制，允许将模型表述为 Transformer 或 RNN，从而在训练时并行计算，在推理时保持常数计算和内存复杂度。我们将模型扩展到 140 亿参数——迄今为止训练的最大稠密 RNN——发现 RWKV 的性能与同等规模的 Transformer 相当，表明未来工作可以利用这一架构创建更高效的模型。

</details>

---

## 2. 研究背景

LLM 推理框架在大规模部署中面临两层核心矛盾：

| 架构 | 训练 | 推理 | 核心瓶颈 |
|---|---|---|---|
| Transformer | ✓ 并行高效（$O(BTd^2)$） | ✗ 二次复杂度（$O(T^2d)$ 时间，$O(T^2+Td)$ 空间） | 长序列内存爆炸 |
| 传统 RNN | ✗ 不可并行（时间串行依赖） | ✓ 线性复杂度（$O(Td)$ 时间，$O(d)$ 空间） | 梯度消失 + 无法并行训练 |
| Linear Transformer | ✓ 并行 | ✓ 线性 | 性能不如标准 Transformer |
| AFT | ✓ 并行 | ✓ 线性（local）/ 二次（full） | 未在大规模验证 |

**现有高效 Transformer 对比**：

| 方法 | 时间复杂度 | 空间复杂度 | 局限 |
|---|---|---|---|
| Transformer | $O(T^2d)$ | $O(T^2+Td)$ | 二次瓶颈 |
| Reformer | $O(T\log T \cdot d)$ | $O(T\log T + Td)$ | 哈希近似损失精度 |
| Performer | $O(Td^2\log d)$ | $O(Td\log d + d^2\log d)$ | 核近似损失表达力 |
| Linear Transformer | $O(Td^2)$ | $O(Td + d^2)$ | 性能下降 |
| MEGA | $O(cTd)$ | $O(cd)$ | 含二次 chunk，$c$ 为 chunk size |
| **RWKV** | **$O(Td)$** | **$O(d)$** | **无近似，最优于以上所有** |

RWKV 的核心动机：**不是修补 Transformer，而是重新设计 RNN**——从 AFT（Attention Free Transformer）的通道级位置偏置出发，将成对位置矩阵简化为通道级时间衰减向量，使模型既可以像 Transformer 一样并行训练，又可以像 RNN 一样常数复杂度推理。

---

## 3. 方法详解

### 3.1 核心设计：RWKV 四元素

RWKV 的名称来自四个核心元素，它们在每个时间步进行乘性交互：

- **R**（Receptance）：接收过去信息的"接收器"，类似传统注意力中的 Q 角色。
- **W**（Weight）：位置权重衰减向量，是模型的可训练参数——控制每个通道的信息衰减速率。
- **K**（Key）：键向量，与传统注意力中的 K 角色类似。
- **V**（Value）：值向量，与传统注意力中的 V 角色类似。

![Figure 2：RWKV 块的内部元素（左）和完整的残差块结构（右）。每个块包含时间混合（Time Mixing）和通道混合（Channel Mixing）两个子块，LayerNorm 贯穿其中。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-01-rwkv-block.png)

### 3.2 整体架构

![Figure 3：RWKV 语言模型架构。输入嵌入经 LayerNorm 后进入残差块堆叠，每个块包含时间混合和通道混合，最终通过 LM Head 输出概率。注意 Token Shift 贯穿所有层。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-02-architecture-lm.png)

模型由堆叠的残差块组成，每个块包含：
1. **时间混合子块**（Time Mixing）：核心 WKV 算子 + 输出门控
2. **通道混合子块**（Channel Mixing）：平方 ReLU 激活 + 输出门控

### 3.3 Token Shift：替代位置编码

RWKV 不使用绝对或相对位置编码，而是用 **token shift**——当前与上一时间步输入的线性插值——来实现时间信息传递：

$$
r_t = W_r \cdot (\mu_r \odot x_t + (1 - \mu_r) \odot x_{t-1})
$$

其中 $\mu$ 是可训练的混合系数，$x_t$ 和 $x_{t-1}$ 分别是当前和上一时间步的输入。这个简单的时间偏移在 PyTorch 中实现为 `nn.ZeroPad2d((0,0,1,-1))`。

### 3.4 WKV 算子：线性注意力的核心

传统注意力的核心是 $QK^\top$ 的二次运算。RWKV 借鉴 AFT，将成对位置偏置矩阵 $w_{t,i} \in \mathbb{R}^{T \times T}$ 简化为**通道级时间衰减向量**：

$$
w_{t,i} = -(t-i) \cdot w, \quad w \in \mathbb{R}_{\geq 0}^d
$$

其中 $w$ 是非负的通道级衰减向量——每个通道独立控制信息衰减速率。WKV 算子定义为：

$$
\text{wkv}_t = \frac{\sum_{i=1}^{t-1} e^{-(t-1-i)w+k_i} \odot v_i + e^{u+k_t} \odot v_t}{\sum_{i=1}^{t-1} e^{-(t-1-i)w+k_i} + e^{u+k_t}}
$$

其中 $u$ 是"bonus"向量，单独控制当前 token 的权重——防止 $W$ 衰减影响当前步信息。**关键洞察**：这个公式本质是一个**带 softmax 归一化的指数加权移动平均**——每个通道独立衰减历史信息，且归一化确保数值稳定。

### 3.5 RNN 递推形式：常数复杂度推理

WKV 算子的核心优势是**可以递推**——当前状态只需依赖上一时间步的状态：

$$
a_t = e^{-w} \odot a_{t-1} + e^{k_t} \odot v_t
$$

$$
b_t = e^{-w} \odot b_{t-1} + e^{k_t}
$$

$$
\text{wkv}_t = \frac{a_{t-1} + e^{u+k_t} \odot v_t}{b_{t-1} + e^{u+k_t}}
$$

![Figure 8：RWKV 时间混合块的 RNN 递推形式。隐藏状态 $h$ 是分子-分母对 $(a, b)$。颜色编码：黄色（µ）为 token shift，红色（1）为分母，蓝色（2）为分子，粉色（3）为分数计算。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-07-rnn-cell.png)

**数值稳定性**：为避免 $e^{k_t}$ 溢出，实际实现中使用共享指数技巧——存储 $a'_t, b'_t$ 和共享指数 $p_t$，每次更新取最大值做减法：

$$
q := \max(p_{t-1}, u + k_t)
$$

$$
\text{wkv}_t = \frac{e^{p_{t-1}-q} \odot a'_{t-1} + e^{u+k_t-q} \odot v_t}{e^{p_{t-1}-q} \odot b'_{t-1} + e^{u+k_t-q}}
$$

每层内部状态仅 5 个 $D$ 维向量（当前输入 $x_t$、通道混合输入 $y_t$、分子 $a'_t$、分母 $b'_t$、辅助指数 $p_t$），总大小 $5DL$（$D$ 为模型维度，$L$ 为层数）。在无限精度下可简化为 $4DL$。

### 3.6 Transformer 并行训练

训练时，RWKV 切换到 **time-parallel mode**：矩阵乘法 $W_\lambda$（$\lambda \in \{r, k, v, o\}$）的复杂度为 $O(BTd^2)$，与 Transformer 的 $W_Q, W_K, W_V, W_O$ 完全一致。WKV 的逐元素计算虽然时间依赖，但可以沿 batch 和 channel 两个维度并行——总训练复杂度 $O(BTd^2)$，与 Transformer 相同。

### 3.7 输出门控与通道混合

时间混合和通道混合都使用 sigmoid 接收率 $\sigma(r)$ 做输出门控：

$$
o_t = W_o \cdot (\sigma(r_t) \odot \text{wkv}_t)
$$

通道混合采用**平方 ReLU** 激活（受 So et al. 2021 启发）：

$$
o'_t = \sigma(r'_t) \odot (W'_v \cdot \max(k'_t, 0)^2)
$$

### 3.8 训练优化

- **Small Init Embedding**：嵌入矩阵用小值（$U(\pm 10^{-4})$）初始化 + 额外 LayerNorm，加速模型脱离初始噪声状态。

![Figure 9：Small Init Embedding 效果。小初始化（橙色）的 loss 下降和收敛速度显著快于标准初始化（蓝色）。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-08-small-init.png)

- **Custom Initialization**：大部分权重初始化为零，$W$（时间衰减）按层深度递变——浅层衰减快（局部操作），深层衰减慢（长程信息保留），形成"分层时间感受野"。
- **Custom CUDA Kernel**：WKV 的串行扫描用自定义 CUDA 内核加速，其余部分（矩阵乘法、逐元素运算）天然可并行。
- **Exponential LR Decay**：学习率指数衰减（非 Transformer 常用的 cosine），配合 PaLM 的辅助 loss 鼓励 softmax 归一化趋近零。

---

## 4. 关键公式解读

### WKV 算子（并行形式）

WKV 算子是 RWKV 的核心——将传统注意力的 $QK^\top V$ 替换为通道级时间衰减加权的线性形式：

$$
\text{wkv}_t = \frac{\sum_{i=1}^{t-1} e^{-(t-1-i)w+k_i} \odot v_i + e^{u+k_t} \odot v_t}{\sum_{i=1}^{t-1} e^{-(t-1-i)w+k_i} + e^{u+k_t}}
$$

其中 $w \in \mathbb{R}_{\geq 0}^d$ 是**通道级时间衰减向量**，$u$ 是当前 token 的 bonus 权重，$k_i$ 和 $v_i$ 是第 $i$ 步的 key 和 value。**关键洞察**：分子是历史 value 的指数加权求和（每个通道独立衰减），分母是归一化项——整个公式是一个 **channel-wise softmax-weighted moving average**，且不含任何近似。

### WKV 递推形式（推理模式）

$$
a_t = e^{-w} \odot a_{t-1} + e^{k_t} \odot v_t, \quad b_t = e^{-w} \odot b_{t-1} + e^{k_t}
$$

$$
\text{wkv}_t = \frac{a_{t-1} + e^{u+k_t} \odot v_t}{b_{t-1} + e^{u+k_t}}
$$

**关键洞察**：递推形式将 $O(T)$ 的求和变成 $O(1)$ 的增量更新——这是 RWKV 推理复杂度从 $O(Td)$ 降到 $O(d)$ 的数学根源。每个时间步只需维护 $(a, b)$ 两个 $D$ 维向量，与序列长度 $T$ 无关。

### 梯度稳定性证明

RWKV 证明了时间混合块的梯度有界性——对 $W_k$ 和 $W_v$ 的梯度不随 $T$ 爆炸：

$$
\left|\frac{\partial (\text{wkv}_T)_i}{\partial (W_v)_{i,j}}\right| = \left|E_i[(x_t)_j]\right| \leq \max_t |(x_t)_j|
$$

$$
\frac{\partial (\text{wkv}_T)_i}{\partial (W_k)_{i,j}} = \text{cov}_i((x_t)_j, (v_t)_i)
$$

**关键洞察**：$W_v$ 的梯度被输入的绝对值上界约束（不爆炸），$W_k$ 的梯度是输入与 value 的协方差（有界且不退化——因为 softmax 至少有两个非零项 $u$ 和 $w$）。时间衰减 $w$ 自然控制每个 $x_t$ 对梯度的贡献，按通道独立衰减——**不爆炸也不消失**（除非模型主动学习让某通道衰减为 0）。

---

## 5. 实验设置

### 模型配置

| 组件 | 配置 |
|---|---|
| 测试模型 | 169M / 430M / 1.5B / 3B / 7B / 14B（6 个规模） |
| 层数 / 维度 | 12/768 → 40/5120（随规模递增） |
| 训练数据 | Pile（330B tokens，1 epoch） |
| 上下文长度 | 1024 tokens（预训练）；扩展至 8192（长文本微调） |
| 优化器 | Adam（无 weight decay），bfloat16 |
| 学习率 | 指数衰减（非 cosine） |
| 基线框架 | Pythia / OPT / BLOOM（FLOP 匹配对比） |

### 评估基准

| 维度 | 基准 |
|---|---|
| NLP 零样本 | ARC (Easy/Challenge)、BoolQ、COPA、HeadQA、HellaSwag、LAMBADA、OpenBookQA、PIQA、ReCoRD、SciQ、Winogrande |
| 长序列 | Long Range Arena (LRA)、Enwik8 |
| 推理效率 | CPU (x86) + GPU (A100 80GB)，float32 |
| Scaling Laws | 45 个模型的 loss vs compute 拟合 |

### 复现信息

- **代码开源**：https://github.com/BlinkDL/RWKV-LM
- **预训练权重**：https://huggingface.co/RWKV（169M ~ 14B 全系列）
- **数据可得**：Pile 为公开数据集
- **StabilityAI** 提供训练算力支持

---

## 6. 实验结果

### NLP 基准主结果

![Figure 1：RWKV 与 Transformer 在 12 项 NLP 任务上的平均性能对比（按 FLOP 匹配）。RWKV（橙色）与 Pythia、OPT、BLOOM 在相同计算量下表现相当。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-03-scaling-laws.png)

![Figure 5：RWKV 在 6 项代表性基准上的零样本性能（按 FLOP 匹配）。ARC Challenge、HellaSwag、LAMBADA、OpenBookQA、ReCoRD、Winogrande——RWKV 与同规模 Transformer 水平相当。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-04-zero-shot-performance.png)

关键发现：

1. **FLOP 匹配下表现相当**：在 12 项 NLP 基准上，RWKV 与 Pythia/OPT/BLOOM 在相同 FLOP 预算下性能相当——部分任务（如 LAMBADA、ReCoRD）甚至更优。
2. **不是"RNN 差一点"**：这打破了"RNN 在大规模 LM 上不如 Transformer"的固有认知——关键在于架构设计而非 RNN 本身的限制。
3. **Prompt 敏感性**：RWKV 对 prompt 顺序更敏感（因 RNN 无法"回头看"），调整 prompt 顺序后 F1 可从 44.2% 提升到 74.8%（RTE 任务）。

### Scaling Laws

![Figure 4：RWKV 的 scaling law 曲线。Loss vs Compute 呈 log-log 线性关系，Pareto 最优拟合 $r^2=0.994$，外推一个数量级仍保持 $r^2=0.875$。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-03-scaling-laws.png)

关键发现：

1. **遵循 Transformer 的 scaling law**：RWKV 的 loss-compute 关系与 Transformer 相同的 log-log 线性形式——这是 RNN 首次被验证遵循标准 scaling law。
2. **外推可靠**：外推一个数量级仍保持 $r^2=0.875$，表明 scaling law 可以指导更大规模的投资决策。
3. **此前 LSTM 不遵循**：Kaplan et al. (2020) 发现 LSTM 不遵循标准 scaling law——RWKV 的突破在于架构设计消除了传统 RNN 的 scaling 障碍。

### 长文本微调

![Figure 6：RWKV 在 Pile 上的测试 loss 随上下文长度增加而持续降低。7B 和 14B 模型从 1024 扩展到 8192 tokens，loss 单调下降。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-05-context-length-loss.png)

关键发现：通过渐进式扩展上下文长度（1024 → 2048 → 4096 → 8192），RWKV 能有效利用长上下文信息——loss 持续降低，证明 RNN 架构不受预训练上下文长度的固有限制。

### 推理效率

![Figure 7：文本生成推理时间累积曲线。Transformer（各色线）呈二次增长，RWKV（深色线）呈线性增长——长序列优势随长度增大而增大。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-06-inference-time.png)

| 指标 | Transformer | RWKV |
|---|---|---|
| 时间复杂度 | $O(T^2d)$ | $O(Td)$ |
| 空间复杂度 | $O(T^2 + Td)$ | $O(d)$ |
| 长序列优势 | 随 $T$ 增大恶化 | 随 $T$ 增大优势增大 |

**关键洞察**：RWKV 的推理时间随序列长度**线性增长**，而 Transformer 是**二次增长**——在长文本生成场景（如代码补全、长文档摘要），RWKV 的优势随序列长度增大而指数级扩大。

### 模型行为可视化

![Figure 10：RWKV-169M 各层的时间衰减（$e^{-w}$，按通道排序）。浅层衰减快（接近 0，聚焦局部），深层衰减慢（接近 1，保留长程信息）——形成分层时间感受野。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-09-time-decay.png)

关键发现：时间衰减模式部分来自学习、部分来自初始化设计。浅层的快速衰减对应文本解析和词法分析等局部操作；深层的慢衰减对应长程信息保持——这模仿了 Transformer 中浅层关注局部、深层关注全局的模式。

![Figure 11：RWKV 的信息检索与传播路径（Eiffel Tower 示例）。事实在 layer 4 被检索，通过时间维度传播到 layer 20，最终在 token "of" 处传至最后一层输出。](/vibe-reading/images/articles/rwkv-reinventing-rnns-transformer-era/fig-10-information-propagation.png)

关键发现：不同于 Transformer 的注意力头直接"跳转"到相关 token，RWKV 依赖**时间维度的递推传播**——信息在层间向下传递的同时沿时间轴流动。这种"沿时间流"的传播方式是 RNN 的本质特征。

---

## 7. 消融实验

### Small Init Embedding

| 初始化方式 | 收敛速度 | 最终 loss |
|---|---|---|
| 标准正态（$\sigma=0.02$） | 慢 | 高 |
| 小初始化（$U(\pm 10^{-4})$ + LayerNorm） | 快 | 低 |

小初始化让嵌入矩阵在初始阶段快速脱离噪声状态——微小的单步变化经 LayerNorm 放大后产生显著的方向变化，加速训练收敛。

### 自适应图模式（后续 RWKV-6 的启示）

论文中 RWKV-4 的 Partial Graph Mode 思想——简单动态 shape 模块用图模式、复杂模块用 Eager 模式——为后续版本的自适应图模式奠定了基础。维度参数化（batch size 和 sequence length 作为图输入参数）使模型能动态适配不同输入 shape。

### LRA 长序列基准

| 模型 | LISTOPS | TEXT | RETRIEVAL | IMAGE | PATHFINDER | AVG |
|---|---|---|---|---|---|---|
| Transformer | 36.37 | 64.27 | 57.46 | 42.44 | 71.40 | 53.66 |
| S4 | 59.60 | 86.82 | 90.90 | 88.65 | 94.20 | 86.09 |
| RWKV | 55.88 | 86.04 | 88.34 | 70.53 | 58.42 | 72.07 |

RWKV 在 LRA 上仅次于 S4，在自然语言和代码处理任务上接近 S4——但在视觉任务（Image/Pathfinder）上差距较大，反映其架构更适配序列语义而非空间结构。

### Enwik8 压缩

| 方法 | 层数 | 维度 | Test bpc | 复杂度 |
|---|---|---|---|---|
| Transformer | 12 | 512 | 1.137 | $O(T^2d)$ |
| Linear Transformer | 12 | 512 | 1.207 | $O(Td^2)$ |
| RWKV-RNN | 12 | 512 | 1.178 | $O(Td)$ / $O(d)$ |

RWKV 在 Enwik8 上以 $O(Td)$ 时间和 $O(d)$ 空间达到 1.178 bpc——优于 Linear Transformer（1.207）和 Reformer（1.195），仅略逊于标准 Transformer（1.137）但复杂度远优。

---

## 8. 总结与展望

### 贡献总结

| 贡献 | 意义 |
|---|---|
| WKV 线性注意力算子 | 无近似地将注意力从 $O(T^2)$ 降到 $O(T)$（推理 $O(1)$ 增量） |
| 双模式统一 | 同一模型训练时并行（Transformer 模式）、推理时递推（RNN 模式） |
| Token Shift | 用简单线性插值替代位置编码，实现时间信息传递 |
| 14B 规模验证 | 迄今最大稠密 RNN，证明 RNN 可在 LLM 规模与 Transformer 竞争 |
| Scaling Law 验证 | 首次验证 RNN 遵循与 Transformer 相同的 scaling law |
| 梯度稳定性证明 | 数学证明 $W_k, W_v$ 梯度有界——不爆炸不消失 |
| 全栈开源 | 代码 + 169M~14B 全系列预训练权重公开 |

### 局限性

- **长程回忆受限**：线性注意力将历史信息"漏斗"到单一向量——信息经过多时间步后会不可避免地损失，无法像 Transformer 那样"精确回看"某个历史 token。虽然时间衰减机制减缓了信息损失，但机制上无法与完整自注意力匹敌。
- **Prompt 工程更关键**：RNN 无法"回头看"已处理的 prompt——信息的顺序直接影响模型能获取多少上下文。精心设计的 prompt（将关键信息放在问题之后）可能将 F1 从 44.2% 提升到 74.8%——但这要求用户理解 RNN 的工作方式。
- **数学推理弱**：在 MathQA 上仅 5.43% 准确率——需要中间结果的链式推理对 RNN 尤其困难，因为中间计算结果的位置在 prompt 中可能不利于 RNN 的顺序处理。
- **LRA 视觉任务弱**：在 Image 和 Pathfinder 上大幅落后于 S4——RWKV 的通道级衰减更适合序列语义而非空间结构。
- **上下文 1024 偏短**：预训练上下文仅 1024 tokens（同期 Pythia 亦如此），需额外微调才能利用长上下文。

### 未来方向

- **弥补缺陷**：增强时间衰减公式（如后续 RWKV-5/6 的 data-dependent decay 和矩阵化 state）；探索更大的内部状态（从向量到矩阵）提升长程记忆容量；优化数学推理——可能需要结合思维链 prompt 工程。
- **新型方案**：将 RWKV 机制扩展到 encoder-decoder 架构（替代 cross-attention）；应用于多模态场景（seq2seq）；利用 RNN 状态做可解释性分析和安全控制——操纵隐藏状态可引导模型行为。
- **减少约束**：并行扫描可将 WKV 的计算从 $O(BTd)$ 降到 $O(B\log(T)d)$；统一硬件抽象层降低新硬件适配门槛；自动化编译优化减少手动算子开发。

**与线性注意力/SSM 系列的关联**：RWKV 与 Linear Transformer、S4、Mamba 等代表了"高效序列建模"的不同路线——Linear Transformer 用核近似、S4 用状态空间模型、Mamba 用数据依赖选择机制、RWKV 用通道级时间衰减。四者的共同目标是打破 Transformer 的二次瓶颈，但 RWKV 的独特之处在于它是第一个在大规模 LLM（14B）上验证可行的 RNN 架构，且完全开源——为后续 RWKV-5（架构升级）、RWKV-6（矩阵化状态 + 数据依赖衰减）奠定了基础。
