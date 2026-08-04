---
title: "video-SALMONN-o1: Reasoning-enhanced Audio-visual Large Language Model"
source:
  type: "论文解读"
  project: "ByteDance"
  url: "https://arxiv.org/abs/2502.11775"
  pdf: "/vibe-reading/papers/video-salmonn-o1.pdf"
date: "2026-08-04T10:30:00+08:00"
category: [AI, Models, Video Model, Papers]
tags: ["Audio-visual LLM", "Reasoning", "pDPO", "Video Understanding", "Benchmark", "DPO"]
description: "目的：将推理优化引入通用视频理解。手段：推理密集型 SFT 数据 + pDPO 步级偏好优化 + RivaBench 基准。结论：较 LLaVA-OneVision 基线提升 3-8%，pDPO 在 RivaBench 上提升 6-8%。"
readingTime: "12 min"
aiModel: "Claude Opus 5 (1M context)"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/video-salmonn-o1.pdf" target="_blank" rel="noopener">预览</a> · **论文** [video-SALMONN-o1: Reasoning-enhanced Audio-visual Large Language Model](https://arxiv.org/abs/2502.11775) · **作者** Guangzhi Sun, Yudong Yang, Jimin Zhuang, Changli Tang, Yixuan Li, Wei Li, Zejun Ma, Chao Zhang（Cambridge / ByteDance / Tsinghua）· **发表** arXiv 2502.11775, 2025-02 · **项目** https://github.com/BriansIDP/video-SALMONN-o1 · **解读** 2026-08-04

---

## 1. 论文概览

**一句话**：video-SALMONN-o1 是首个开源的推理增强音视频大语言模型——把 o1 式的"链式推理"从数学题搬到了通用视频理解，通过推理密集型 SFT 数据 + 步级偏好优化（pDPO）两步走，让模型学会"先想再答"。

- **任务**：通用视频理解（含音频），涵盖学术讲座、单口喜剧、合成视频检测等场景。
- **核心创新**：(1) 推理密集型 SFT 数据集，用 Gemini-1.5-pro 生成 + GPT-4o 质检；(2) pDPO——一种通过对比步选择实现步级奖励建模的 DPO 变体；(3) RivaBench——首个推理密集型视频理解基准，4000+ 专家标注 QA 对。
- **结果**：在 VideoMME、NExT-QA 和 RivaBench 上较 LLaVA-OneVision 基线提升 3-8%；pDPO 在 RivaBench 上较 SFT 模型提升 6-8%；还涌现出零样本合成视频检测能力。

**take-home**：推理不只属于数学题——视频理解同样需要"想清楚再回答"，而步级偏好优化比预测绝对分数更适合音视频多模态场景。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

While recent advancements in reasoning optimization have significantly enhanced the capabilities of large language models (LLMs), existing efforts to improve reasoning have been limited to solving mathematical problems and focusing on visual graphical inputs, neglecting broader applications in general video understanding. This paper proposes video-SALMONN-o1, the first open-source reasoning-enhanced audio-visual LLM designed for general video understanding tasks. To enhance its reasoning abilities, we develop a reasoning-intensive dataset featuring challenging audio-visual questions with step-by-step solutions. We also propose process direct preference optimization (pDPO), which leverages contrastive step selection to achieve efficient step-level reward modelling tailored for multimodal inputs. Additionally, we introduce RivaBench, the first reasoning-intensive video understanding benchmark, featuring over 4,000 high-quality, expert-curated question-answer pairs across scenarios such as standup comedy, academic presentations, and synthetic video detection. video-SALMONN-o1 achieves 3-8% accuracy improvements over the LLaVA-OneVision baseline across different video reasoning benchmarks. Besides, pDPO achieves 6-8% improvements compared to the supervised fine-tuning model on RivaBench. Enhanced reasoning enables video-SALMONN-o1 zero-shot synthetic video detection capabilities.

> **译：** 尽管推理优化的最新进展显著增强了大语言模型的能力，但现有的推理改进工作局限于求解数学问题和关注视觉图形输入，忽略了在通用视频理解中更广泛的应用。本文提出 video-SALMONN-o1，首个开源的推理增强音视觉大语言模型，面向通用视频理解任务。为增强推理能力，我们开发了推理密集型数据集，包含具有挑战性的音视觉问题和逐步解答。我们还提出了过程直接偏好优化（pDPO），利用对比步选择实现针对多模态输入的高效步级奖励建模。此外，我们引入了 RivaBench——首个推理密集型视频理解基准，包含超过 4000 个高质量、专家策划的问答对，涵盖单口喜剧、学术演讲和合成视频检测等场景。video-SALMONN-o1 在不同视频推理基准上较 LLaVA-OneVision 基线实现 3-8% 的准确率提升。此外，pDPO 在 RivaBench 上较监督微调模型实现 6-8% 的提升。增强的推理能力使 video-SALMONN-o1 具备零样本合成视频检测能力。

</details>

---

## 2. 研究背景

推理优化（如 o1 式 CoT）在文本 LLM 上已大获成功——数学题、代码任务成绩突飞猛进。但把这套范式搬到**多模态**场景时，现有工作几乎只盯着"从图片里提取数学信息再解题"这一条路（LLaVA-CoT、Virgo、MAmmoTH-VL），**通用视频理解**被忽略了。

这带来一个核心缺口：

| 现有推理优化方向 | 局限 |
|---|---|
| 文本 LLM 推理（o1 / DeepSeek-R1） | 仅限文本输入，不处理音视频 |
| 多模态推理（LLaVA-CoT / Virgo） | 聚焦数学题 + 图片输入，不涉及视频中的音频 |
| 视频理解 LLM（VideoMME 等） | 直接给答案，不做链式推理 |

**为什么视频推理更难？** 视频中的推理需要在不同时间点反复引用音频和视觉信息——喜剧的笑点需要理解表演者的手势 + 语气 + 台词的错位；学术讲座需要把图表讲解和口语推理串联。这比"看图做数学题"复杂得多。

video-SALMONN-o1 的动机正是补这个缺口：让音视频 LLM 也学会"先推理、再回答"。

---

## 3. 方法详解

video-SALMONN-o1 的方法分三部分：模型结构、推理密集型 SFT 数据、pDPO 训练。

### 3.1 模型结构

模型沿用 video-SALMONN 2 的架构，在预训练视觉 LLM 基础上增加音频编码器分支：

![Figure 1：video-SALMONN-o1 模型结构。输入视频经视觉和音频分支分别处理，两路编码以交错同步方式合并后送入 LLM。](/vibe-reading/images/articles/video-salmonn-o1/fig-01-model-structure.png)

关键设计是**交错同步模块**（Interleaved Synchronization）：每帧视觉编码之间插入对应时间段内的音频编码，使时间维度对齐：

$$
H_{AV} = \text{Concat}(\ldots, H^V_{t_1}, H^A_{t_1:t_2}, H^V_{t_2}, \ldots)
$$

其中 $H^A \in \mathbb{R}^{m \times d}$ 和 $H^V \in \mathbb{R}^{n \times d}$ 分别为音频和视觉编码组。训练采用多阶段 SFT：先训练音频对齐器（其他部分冻结），再联合训练模态对齐器和 LoRA 模块。

### 3.2 推理密集型 SFT 数据

论文发现一个关键现象：**视频理解模型在给定视频后会"忘记"逐步推理，直接跳到最终答案**。为恢复推理能力，作者构建了专门的推理密集型数据：

![Figure 2：推理密集型 SFT 数据获取流程。Gemini-1.5-pro 生成问题、答案和推理路径，GPT-4o 进行质量检查，不合格的重新生成。](/vibe-reading/images/articles/video-salmonn-o1/fig-02-sft-data-pipeline.png)

流程为：Gemini-1.5-pro 生成带推理步骤的 QA 对 → GPT-4o 质检 → 不合格则重新生成。一个重要细节是：**原始训练集也被 augment 了推理路径**，避免模型学到"推理"和"直接回答"两套互斥机制。

### 3.3 pDPO：过程直接偏好优化

pDPO 是本文的核心方法创新。其动机是：在音视频场景中，预测绝对分数（PRM）受歧义影响严重，而**成对偏好**更稳健。

pDPO 的工作流如下图所示：

![Figure 3：对比步选择（上）与成对 rollout（下）。通过给输入视频施加微小扰动，计算每步的长度归一化 KL 散度，选取 susceptibility 最高的 Top-T 步进行成对偏好训练。](/vibe-reading/images/articles/video-salmonn-o1/fig-03-contrastive-step-selection.png)

**对比步选择**（Contrastive Step Selection）是 pDPO 的关键效率优化：不是对所有步骤都做 rollout，而是先找到"最容易出错"的步骤。具体做法是对输入视频施加微小扰动，计算每步输出的长度归一化 KL 散度——散度越大说明该步越依赖视频内容、越容易出错。论文发现超过 70% 的推理错误发生在模型误读或幻觉视频内容的步骤上。

---

## 4. 关键公式解读

### pDPO 的奖励函数

pDPO 借鉴 DPO 框架，将每步的隐式奖励定义为策略比率的对数：

$$
r(s_k) = \beta \log \frac{\pi_\theta(s_k \mid s_{<k}, H_{AV})}{\pi_{\text{ref}}(s_k \mid s_{<k}, H_{AV})} + \beta \log Z(s_{<k}, H_{AV})
$$

其中 $\pi_\theta$ 为当前策略、$\pi_{\text{ref}}$ 为参考策略、$\beta$ 控制偏离程度、$Z(\cdot)$ 为配分函数。

### Bradley-Terry 偏好模型

对于每个选定步骤 $s_k$，生成一个替代步骤 $s'_k$，两者共享相同前缀。用 Bradley-Terry 模型定义偏好概率：

$$
p(s_k \succ s'_k) = \sigma\!\left(r(s_k) - r(s'_k)\right)
$$

### pDPO 损失

$$
\mathcal{L} = -\mathbb{E}\!\left[\alpha_k \log p(s_k \succ s'_k) + (1 - \alpha_k) \log p(s'_k \succ s_k)\right]
$$

其中 $\alpha_k = \mathbf{1}(p_{s_k} > p_{s'_k})$ 为硬标签，也可用软标签 $\alpha_k = \sigma\!\left(\frac{p_{s_k} - p_{s'_k}}{\mu}\right)$ 以适应有限 rollout 数带来的标注噪声。这里 $p_{s_k}$ 是通过 Monte Carlo rollout 近似的期望正确率：

$$
p_{s_k} \approx \frac{1}{N} \sum_{n=1}^{N} \mathbf{1}(A_n = A_{\text{ref}})
$$

**关键洞察**：pDPO 保留了 PPRM（成对偏好奖励模型）"比较优于评分"的优势，同时将粒度从整条推理路径细化到**单个步骤**，实现对特定错误步骤的精准优化。

---

## 5. 实验设置

### 模型配置

| 组件 | 配置 |
|---|---|
| 视觉编码器 | SigLIP，2 fps，最多 60 帧 |
| 音频编码器 | Whisper-Large-v3，窗口级 Q-Former（0.2s 窗口，150 tokens / 30s） |
| LLM 主干 | Qwen 2 (7B)，LoRA r=64, α=256 |
| 视觉对齐器 | 两层 GELU 线性网络 |
| SFT 训练 | 16×A100, 48 小时 |
| pDPO 训练 | 8×A100, 24 小时 |

### 数据

- **SFT 数据**：13k 音视频丰富的视频 → 150k 普通 QA + 30k 推理密集 QA（均带推理步骤）
- **pDPO 数据**：从推理密集子集采样 10 条路径/QA → 保留错误样本做 rollout → 约 100k 完整解路径对 + 100k 步级部分解对
- **对比步选择**：每 QA 选 Top-3 步，每步 6 次 rollout

### RivaBench 基准

![Figure 4：SFT 数据中推理步数的分布。左：全部 SFT 数据；右：推理密集子集。推理密集子集因难度更高，通常需要更多推理步骤。](/vibe-reading/images/articles/video-salmonn-o1/fig-04-sft-data-distribution.png)

RivaBench 包含三个推理密集型场景：

| 分区 | QA 数 | 平均时长 | 格式 | 特点 |
|---|---|---|---|---|
| Academic | 1,912 | 47.2±66.1s | 五选一 | M3AV 学术讲座，覆盖数学/工程/医学 |
| StandUp | 2,128 | 43.2±15.1s | 五选一 | 理解笑点为何好笑（手势+语气+台词） |
| SynthDec | 200 | 8.1±3.2s | 是/否 | 100 合成 + 100 真实视频，零样本检测 |

所有 QA 均由人类专家（含医学博士）手工标注，视频均来自 YouTube。

### 评价指标

- Academic / StandUp / VideoMME / NExT-QA：准确率
- SynthDec：F1-score（Precision/Recall）

---

## 6. 实验结果

### 主结果

![Figure 6：主结果。video-SALMONN-o1（pDPO）与视觉（V）和音视觉（A+V）LLM 对比。SFT 为带推理数据的 SFT 模型，pDPO 为在 SFT 基础上进一步训练的模型。](/vibe-reading/images/articles/video-salmonn-o1/fig-06-main-results-table.png)

关键发现：

1. **音频的价值在 RivaBench 更突出**：GPT-4o（无音频）在 StandUp 和 Academic 上逊于 Gemini-1.5-pro（有音频），说明 RivaBench 的问题确实需要音视觉联合理解。
2. **pDPO 是主要提升来源**：SFT 后的模型在 VideoMME 上已优于 LLaVA-OneVision（因能理解语音），但其他基准的提升主要来自 pDPO——在 NExT-QA、StandUp、Academic 上分别提升 4.1%、8.1%、5.8%。
3. **零样本合成视频检测**：所有其他开源模型输出全"real"（F1=0%），而 video-SALMONN-o1 达到 17.8% F1（87% 精度 / 13% 召回），是首个展现此能力的开源模型。
4. **推理在 RivaBench 上更重要**：对 GPT-4o 和 Gemini-1.5-pro 做推理后，StandUp 和 Academic 的提升远大于 VideoMME 和 NExT-QA，验证了 RivaBench 的推理密集特性。

### 与专有模型对比

video-SALMONN-o1（pDPO）在 StandUp 上甚至超过了不带推理的 Gemini-1.5-pro（76.7% vs 75.8%），展现了开源模型的竞争力。

---

## 7. 消融实验

### SFT 数据的效果

| 训练数据 | 推理 | VideoMME | NExT-QA | Academic | StandUp |
|---|---|---|---|---|---|
| Full SFT | ✗ | 63.7% | 80.7% | 45.2% | 72.3% |
| Full SFT | ✓ | 62.9% | 78.2% | 42.5% | 68.6% |
| w/o reasoning-intensive | ✗ | 63.2% | 81.0% | 44.1% | 71.1% |
| w/o reasoning-intensive | ✓ | 61.6% | 76.6% | 42.3% | 67.5% |
| reasoning-intensive only | ✓ | 58.8% | 75.2% | 40.1% | 63.5% |
| Full SFT + pDPO | ✓ | **65.6%** | **82.3%** | **48.3%** | **76.7%** |

**反直觉发现**：SFT 后直接给答案反而比做推理更好！这是因为 teacher forcing 的 exposure bias 对长推理序列影响更大。但 pDPO 通过在自身生成样本上学习，有效缓解了 exposure bias，最终超越直接回答。

### 奖励建模方法对比

| 方法 | 推理 | VideoMME | NExT-QA | StandUp | Academic |
|---|---|---|---|---|---|
| SFT (1-best) | ✓ | 62.9% | 78.2% | 68.6% | 42.5% |
| SFT (Major@20) | ✓ | 63.5% | 81.5% | 73.5% | 45.3% |
| SFT + ORM (RM@20) | ✓ | 62.7% | 78.5% | 69.0% | 42.6% |
| SFT + PRM (RM@20) | ✓ | 63.5% | 79.3% | 72.1% | 43.9% |
| SFT + pDPO (1-best) | ✓ | **65.6%** | **82.3%** | **76.7%** | **48.3%** |

ORM 和 PRM 的训练损失仅下降约 5%，反映了在通用视频 QA 上学习原始分数的困难。而 pDPO 用 1-best（无需 best-of-n 采样）就超越了 ORM/PRM 的 RM@20，效率与效果兼得。

### 对比步选择的效果

![Figure 5：不同 Top-T 步选择对 pDPO 的效果对比。完整路径对（Full Paths）始终使用，在此基础上分别加入：无中间步、Top-3 步、全部步。](/vibe-reading/images/articles/video-salmonn-o1/fig-05-pdpo-step-comparison.png)

使用中间步骤（Top-3）比仅用完整路径有持续提升，尤其在需要频繁引用视频/音频信息的中间推理步骤上。这验证了对比步选择策略的有效性——聚焦于视频依赖型错误，同时由 PPRM 的完整路径比较来覆盖文本逻辑错误。

---

## 8. 总结与展望

### 贡献总结

| 贡献 | 意义 |
|---|---|
| 首个开源推理增强音视觉 LLM | 将 o1 式推理引入通用视频理解 |
| pDPO + 对比步选择 | 步级偏好优化，无需外部奖励模型或两阶段重排 |
| RivaBench | 首个推理密集型视频理解基准，4000+ 专家标注 |
| 零样本合成视频检测 | 推理增强带来的涌现能力 |

### 局限性

- **合成视频检测召回率仍低**（13%）：即便推理增强后，大多数合成视频仍无法被检测到——当前 SOTA 视频 LLM 对物理规则违反的感知能力有限。
- **SFT 阶段的 exposure bias**：推理路径越长，teacher forcing 的偏差越大，导致 SFT 后"直接回答"反而优于"推理"——这并非理想状态，而是训练范式的固有问题。
- **规模限制**：7B 参数的主干 LLM，与 GPT-4o / Gemini-1.5-pro 等专有模型仍有差距。
- **对比步选择偏向视频依赖型错误**：文本逻辑错误需依赖 PPRM 补充，两套机制并行增加了系统复杂度。

### 未来方向

- **弥补缺陷**：提升合成视频检测的召回率——可能需要更精细的物理一致性推理训练数据。
- **新型方案**：探索在线 RL（如 RLHF/PPO）替代离线 pDPO，实现推理过程中的实时纠错；或引入树搜索（MCTS）在推理时寻找更优路径。
- **减少约束**：将对比步选择的自适应机制推广到更多模态（如 3D、触觉），降低对特定扰动方式的依赖；探索无需 rollout 的步级奖励估计方法。
