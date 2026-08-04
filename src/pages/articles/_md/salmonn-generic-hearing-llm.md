---
title: "SALMONN: Towards Generic Hearing Abilities for Large Language Models"
source:
  type: "论文解读"
  project: "ByteDance"
  url: "https://arxiv.org/abs/2310.13289"
  pdf: "/vibe-reading/papers/salmonn-generic-hearing-llm.pdf"
date: "2026-08-04T14:00:00+08:00"
category: [AI, Models, Audio Model, Papers]
tags: ["Audio LLM", "Speech", "Multimodal", "Whisper", "BEATs", "Q-Former", "Emergent Abilities", "Instruction Tuning"]
description: "目的：赋予 LLM 通用听觉能力。手段：双编码器 + 窗口级 Q-Former + 三阶段训练（含激活调优）。结论：15 项音视频任务竞争力强，涌现跨模态能力。"
readingTime: "12 min"
aiModel: "Claude Opus 5 (1M context)"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/salmonn-generic-hearing-llm.pdf" target="_blank" rel="noopener">预览</a> · **论文** [SALMONN: Towards Generic Hearing Abilities for Large Language Models](https://arxiv.org/abs/2310.13289) · **作者** Changli Tang, Wenyi Yu, Guangzhi Sun, Xianzhao Chen, Tian Tan, Wei Li, Lu Lu, Zejun Ma, Chao Zhang（Tsinghua University / ByteDance）· **发表** ICLR 2024 · **项目** https://github.com/bytedance/SALMONN · **解读** 2026-08-04

---

## 1. 论文概览

**一句话**：SALMONN 是首个能感知并理解通用音频输入（语音、音频事件、音乐）的多模态 LLM——把 Whisper 语音编码器和 BEATs 音频编码器同时接入 Vicuna 文本 LLM，用一个窗口级 Q-Former 做对齐，再通过三阶段训练（预训练 → 指令微调 → 激活调优）让模型既会"听"又会"推理"。

- **任务**：通用音频理解——单一模型同时处理语音识别/翻译、音频事件描述、音乐理解，以及未训练的跨模态涌现任务。
- **核心创新**：(1) 双听觉编码器 + 窗口级 Q-Former 连接模块，实现高时间分辨率的音文对齐；(2) 发现并分析"任务过拟合"现象——指令微调后模型丧失跨模态涌现能力；(3) 提出激活调优（Activation Tuning），仅用 12 个样本、12 步训练即可恢复涌现能力。
- **结果**：在 15 项任务（3 个难度级别）上，训练任务达到竞争力水平；未训练的跨模态任务（如语音翻译到未训练语言、音频故事讲述、语音音频协同推理）经激活调优后显著恢复。

**take-home**：给 LLM 装"耳朵"不只是接一个编码器——指令微调会让模型"过度专注"训练任务而丧失泛化能力，而调低 LoRA 缩放因子就能激活被压制的涌现能力，揭示了跨模态对齐与 LLM 固有能力之间的微妙博弈。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Hearing is arguably an essential ability of artificial intelligence (AI) agents in the physical world, which refers to the perception and understanding of general auditory information consisting of at least three types of sounds: speech, audio events, and music. In this paper, we propose SALMONN, a speech audio language music open neural network, built by integrating a pre-trained text-based large language model (LLM) with speech and audio encoders into a single multimodal model. SALMONN enables the LLM to directly process and understand general audio inputs and achieve competitive performances on a number of speech and audio tasks used in training, such as automatic speech recognition and translation, auditory-information-based question answering, emotion recognition, speaker verification, and music and audio captioning etc. SALMONN also has a diverse set of emergent abilities unseen in the training, which includes but is not limited to speech translation to untrained languages, speech-based slot filling, spoken-query-based question answering, audio-based storytelling, and speech audio co-reasoning etc. The presence of cross-modal emergent abilities is studied, and a novel few-shot activation tuning approach is proposed to activate such abilities. To our knowledge, SALMONN is the first model of its type and can be regarded as a step towards AI with generic hearing abilities. The source code, model checkpoints and data are available at this https URL.

> **译：** 听觉可以说是物理世界中人工智能（AI）智能体的一项 essential 能力，指对一般听觉信息的感知和理解，包括至少三种声音：语音、音频事件和音乐。本文提出 SALMONN——一个语音音频语言音乐开放神经网络，通过将预训练的基于文本的大语言模型（LLM）与语音和音频编码器集成为单一多模态模型来构建。SALMONN 使 LLM 能够直接处理和理解一般音频输入，并在训练中使用的多项语音和音频任务上取得有竞争力的表现，如自动语音识别和翻译、基于听觉信息的问答、情感识别、说话人验证以及音乐和音频描述等。SALMONN 还具有一系列训练中未见的涌现能力，包括但不限于翻译到未训练语言的语音翻译、基于语音的槽位填充、基于口语查询的问答、基于音频的故事讲述以及语音音频协同推理等。本文研究了跨模态涌现能力的存在性，并提出了一种新的少样本激活调优方法来激活此类能力。据我们所知，SALMONN 是首个此类模型，可视为朝向具备通用听觉能力的 AI 的一步。源代码、模型检查点和数据已公开。

</details>

---

## 2. 研究背景

文本 LLM 在 NLP 任务中已展现出色甚至人类水平的表现，指令微调让 LLM 能跟随开放式指令。然而，给 LLM 装上多模态感知能力的工作主要集中在**视觉**模态（图像、视频），**听觉**模态——语音、音频事件、音乐——被大大忽略。

现有工作各有局限：

| 方向 | 代表工作 | 局限 |
|---|---|---|
| 语音 LLM | SpeechGPT、AudioPaLM、Whisper-LLM 级联 | 仅处理语音，不覆盖音频事件和音乐 |
| 音频事件 LLM | LTU、AudioGPT | 仅处理非语音音频事件，不支持语音 |
| 视觉多模态 LLM | MiniGPT-4、InstructBLIP、Video-LLaMA | Q-Former 结构已验证，但未用于音频 |
| 多模态融合 | PandaGPT、Macaw-LLM | 连接多种编码器，但音频对齐质量有限 |

**核心缺口**：尚无单一 LLM 能同时感知语音、音频事件和音乐三种基本声音类型。SALMONN 的动机正是补这个缺口——做第一个"能听"的 LLM。

**为什么难？** 语音需要细粒度的时间对齐（音素级），音频事件需要高层次语义理解，音乐需要结构和情感感知——三者的编码方式和对齐需求截然不同。用一个模型统一处理三种声音，需要精心设计的编码器组合和连接模块。

---

## 3. 方法详解

SALMONN 的方法分三部分：模型结构、三阶段训练方法、任务过拟合分析与激活调优。

### 3.1 模型结构

SALMONN 的架构由双听觉编码器、窗口级 Q-Former 连接模块、Vicuna LLM + LoRA 适配器组成：

![Figure 1：SALMONN 模型架构。窗口级 Q-Former 作为连接模块，融合 Whisper 语音编码器和 BEATs 音频编码器的输出为增强音频 token，与 LLM 输入空间对齐。LoRA 适配器进一步将增强的 LLM 输入空间与输出空间对齐。LLM 和编码器冻结，其余部分在训练中更新。](/vibe-reading/images/articles/salmonn-generic-hearing-llm/fig-01-architecture.png)

**双听觉编码器**：互补设计——

- **Whisper 编码器**（语音）：基于大规模弱监督数据训练，输出特征适合建模语音，且包含背景噪声信息。
- **BEATs 编码器**（非语音）：通过迭代自监督学习提取高层次非语音音频语义信息。

两个编码器输出帧率均为 50Hz，可直接沿特征维度逐帧拼接：

$$
Z = \text{Concat}\!\left(\text{Encoder}_{\text{whisper}}(X),\; \text{Encoder}_{\text{beats}}(X)\right)
$$

其中 $X$ 为变长通用音频输入，$Z$ 为拼接后的 $T$ 帧编码序列。

**窗口级 Q-Former**：标准 Q-Former 用固定数量查询将图像编码转为固定数量 token，但音频长度可变。SALMONN 的改进是**窗口级处理**——将变长编码序列按窗口分块，每个窗口用同一组查询生成增强音频 token，保持与输入的单调对齐。关键设计是输出序列 $H$ 与编码序列 $Z$ 的**单调对齐**，这对语音识别的时间分辨率至关重要。

**LLM 与 LoRA**：使用 Vicuna-13B 作为 LLM 主干，LoRA 适配器调整自注意力层的 query 和 value 权重矩阵。训练中 Vicuna 和编码器冻结，仅 Q-Former 和 LoRA 可更新。

### 3.2 三阶段训练

| 阶段 | 目标 | 训练模块 | 数据 |
|---|---|---|---|
| 预训练 | 建立音文对齐 | Q-Former + LoRA | ASR + 音频描述（大量、简单） |
| 指令微调 | 学习多种音频任务 | Q-Former + LoRA | 12 类任务（ASR/AST/AAC/PR/ER/MC/OSR/SV/GR/SQA/AQA/MQA） |
| 激活调优 | 恢复涌现能力 | Q-Former + LoRA | 12 个故事样本，12 步训练 |

### 3.3 任务过拟合与激活调优

仅用前两阶段训练的 SALMONN 虽然在训练任务上表现竞争力，但在**未训练的跨模态任务**上几乎无能力——模型违反指令，生成与训练任务相关的无关回复。论文将此现象称为**任务过拟合**（Task Over-fitting）。

**根因分析**：指令微调中使用的指令更简单、回复不如 LLM 训练数据复杂多样，而 ASR 和音频描述这类任务的输出高度确定性。这些因素导致内在条件语言模型 $P_\Lambda(Y|X)$ 偏向于与音频强对齐的简单短文本（如转录），从而使零样指令 $I'$ 的 $P_\Lambda(Y|X, I')$ 很小。

**激活调优的灵感**：作者发现，在测试时**降低 LoRA 缩放因子**可以激活问答和故事讲述能力，产生长而多样的回复——但也大幅损害训练任务性能。为兼顾两者，激活调优用降缩放因子生成的回复作为训练数据，进行第三阶段微调。

---

## 4. 关键公式解读

### Bayes 分解：任务过拟合的理论根源

对于测试输入 $X$ 和新指令 $I$，响应 $\hat{Y}$ 的生成目标为：

$$
P_\Lambda(Y \mid X, I) = \frac{P_\Lambda(Y \mid X) \cdot P_\Lambda(I \mid Y, X)}{P_\Lambda(I \mid X)}
$$

**关键洞察**：由于训练中只见过有限的文本响应，内在条件 LM $P_\Lambda(Y \mid X)$ 偏向于与 $X$ 强对齐的 $Y$ 序列（如 ASR 和 AAC 的简单短转录）。从公式可见，这使得具有更多样回复的零样本指令 $I'$ 对应的 $P_\Lambda(Y \mid X, I')$ 很小——这就是任务过拟合的数学根源。

### 激活调优的正则化原理

激活调优通过让 SALMONN 在长而多样的响应任务（如故事讲述）上微调，**正则化** $P_\Lambda(Y|X)$，使其不再过度偏向简单短文本。等效的替代方法是降低 LoRA 缩放因子——因为 Q-Former 和 LoRA 是训练中仅更新的模块，内在条件 LM 只能通过它们学习，调低 LoRA 的贡献等于减弱训练任务对条件分布的束缚。

---

## 5. 实验设置

### 模型配置

| 组件 | 配置 |
|---|---|
| 语音编码器 | Whisper-Large-v2 |
| 音频编码器 | BEATs（fine-tuned） |
| LLM 主干 | Vicuna-13B |
| LoRA | 适配 self-attention 的 query 和 value 权重 |
| 连接模块 | 窗口级 Q-Former |

### 训练数据

| 任务 | 数据源 | 小时数 | 样本数 |
|---|---|---|---|
| ASR | LibriSpeech + GigaSpeech | 960 + 220 | 280K + 200K |
| En2Zh 翻译 | CoVoST2-En2Zh | 430 | 290K |
| 音频描述 (AAC) | AudioCaps + Clotho | 130 + 24 | 48K + 4K |
| 语音问答 (SQA/AQA/MQA) | LibriSpeech / WavCaps+AudioCaps / MillionSong+MusicNet | ~1700 | ~400K |
| 其他（PR/ER/MC/OSR/SV/GR） | 多个专业数据集 | ~2500 | ~1.1M |
| **总计** | | **~4400h** | **~2.3M** |

### 任务分级

论文设计了 3 个难度级别的 15 项任务来评估"通用听觉能力"：

| 级别 | 任务 | 特点 |
|---|---|---|
| Level 1 | ASR、AST、AAC、PR、ER、MC、OSR、SV、GR、SQA、AQA、MQA（12 项） | 训练中见过 |
| Level 2 | En2De、En2Ja 翻译、关键词提取 (KE)、口语问答 (SQQA)、槽位填充 (SF)（5 项） | 未训练，基于语音的 NLP |
| Level 3 | 音频故事讲述 (Story)、语音音频协同推理 (SAC)（2 项） | 未训练，需跨模态推理 |

Level 3 的两个任务是本文**首次提出**的，要求模型同时感知语音和非语音音频并联合推理——如根据包含语音和环境音的音频讲述故事，或基于语音问题和音频信息协同回答。

### 评价指标

- Level 1/2：WER（↓）、BLEU4（↑）、METEOR/SPIDEr（↑）、Accuracy（↑）等标准指标
- Level 2/3 额外：**Following Rate (FR)**——模型成功跟随指令的百分比（因任务复杂时模型常因任务过拟合而违反指令）
- Story 任务：Diversity（不同词数，衡量故事丰富度）

---

## 6. 实验结果

### 主结果：15 项任务全表

![Figure 2：激活调优过程中 ASR & PR (a)、SQQA (b)、Story (c) 和 SAC (d) 的性能及跟随率随训练步数的变化。ASR/PR 几乎不变，而 SQQA/Story/SAC 呈涌现趋势。](/vibe-reading/images/articles/salmonn-generic-hearing-llm/fig-02-activation-tuning.png)

| 方法 | ASR↓ (3 sets) | En2Zh↑ | AAC↑ | PR↓ | ER↑ | MC↑ | OSR↓ | SV↑ |
|---|---|---|---|---|---|---|---|---|
| w/o Activation | (2.1, 4.9, 9.1) | 34.4 | 25.6\|47.6 | 4.2 | 0.63 | 3.5, 22.1 | 20.7 | 0.93 |
| w/ Activation | (2.1, 4.9, 10.0) | 33.1 | 24.0\|40.3 | 4.2 | 0.69 | 5.5, 21.8 | 23.0 | 0.94 |
| Reference | (2.2, 5.1, 9.2) | 38.9 | 25.0\|48.5 | 3.1 | 0.81 | 6.1, 21.5 | 7.6 | – |

Level 1 任务上，激活调优带来微小代价（ASR/AAC 略降），但 ER/MC/SV 有提升，整体保持竞争力。

### Level 2 & 3：涌现能力的激活

| 方法 | En2De↑ | En2Ja↑ | KE↑ | SQQA↑ | SF↑ | Story↑ | SAC↑ |
|---|---|---|---|---|---|---|---|
| w/o Activation | 19.7 | 22.0 | 0.30 | 0.19 (0.29) | 0.33 (0.77) | 7.77 (0.00) | 0.02 (0.04) |
| w/ Activation | 18.6 | 22.7 | 0.32 | 0.41 (0.98) | 0.41 (0.99) | **82.57** (1.00) | 0.50 (0.73) |

关键发现：

1. **任务过拟合严重**：无激活调优时，Story 的 FR=0.00（完全不跟随指令），SAC 的 FR=0.04——模型忽略指令，生成与训练任务相关的回复。
2. **激活调优效果惊人**：Story 的 Diversity 从 7.77 跃升至 82.57，FR 从 0.00 到 1.00；SQQA 的 FR 从 0.29 到 0.98；SAC 的 Accuracy 从 0.02 到 0.50。
3. **训练任务几乎无损**：ASR 和 PR 在激活调优过程中几乎不变（Figure 2a），证明激活调优不影响已学对齐。
4. **翻译能力的泛化**：只训练了 En2Zh，但 En2De 和 En2Ja 也能翻译——这是跨模态涌现能力的直接证据。

---

## 7. 消融实验

### 7.1 LoRA 缩放因子的影响

![Figure 3：测试时降低 LoRA 缩放因子对 ASR & PR (a)、SQQA (b)、Story (c) 和 SAC (d) 性能及跟随率的影响。](/vibe-reading/images/articles/salmonn-generic-hearing-llm/fig-03-lora-scaling.png)

当 LoRA 缩放因子降至约 2.0 时，SQQA/Story/SAC 的能力开始涌现，但 ASR/PR 性能下降。这证明 LoRA 中嵌入了内在条件 LM——降低其贡献等于减弱训练任务对条件分布的束缚，从而释放 LLM 的固有能力。

### 7.2 任务过拟合的 PPL 分析

![Figure 4：激活调优过程中 PPL 的变化。(a) 无指令时 AAC vs Story 的 PΛ(Y|X)；(b) 无指令时 AAC vs SAC 的 PΛ(Y|X)；(c) 有 Story 指令时的 PΛ(Y|X, I)；(d) 有 SAC 指令时的 PΛ(Y|X, I)。](/vibe-reading/images/articles/salmonn-generic-hearing-llm/fig-04-ppl-changes.png)

作者通过计算激活调优各步的 PPL 来验证内在条件 LM 的影响：

- **无指令时** $P_\Lambda(Y|X)$（图 a, b）：激活调优前，AAC 的 PPL 明显低于 Story/SAC——模型偏向 AAC 任务。调优过程中 PPL 差距缩小，偏见被纠正。
- **有指令时** $P_\Lambda(Y|X, I)$（图 c, d）：激活调优前，即使用 Story/SAC 指令，AAC 响应的 PPL 仍更低——模型无视指令。调优后，Story/SAC 响应的 PPL 逐渐低于 AAC，模型开始跟随指令。

### 7.3 激活调优方法对比

| 激活方法 | ASR↓ | PR↓ | SQQA↑ | Story↑ | SAC↑ | Repeat Rate↓ |
|---|---|---|---|---|---|---|
| w/o Activation | 2.1 | 4.2 | 0.19 (0.29) | 7.77 (0.00) | 0.02 (0.04) | 0.2% |
| **Story** | 2.1 | 4.2 | 0.41 (0.98) | **82.57** (1.00) | **0.50** (0.73) | 0.1% |
| QA (Long) | 2.1 | 4.3 | 0.40 (0.93) | 59.82 (1.00) | 0.34 (0.71) | 4.6% |
| ASR (Long) | 2.2 | 4.2 | 0.22 (0.28) | 7.87 (0.00) | 0.12 (0.03) | 0.1% |
| Story (Text based) | 2.1 | 4.2 | 0.23 (0.32) | 8.45 (0.03) | 0.11 (0.03) | 0.1% |
| Story (LoRA only) | 2.1 | 4.2 | 0.44 (0.96) | 82.29 (1.00) | 0.34 (0.65) | – |

**关键发现**：

1. **ASR(Long) 无法激活**：用长转录训练反而加剧对齐偏见，无法激活涌现能力。
2. **Story(Text based) 无效**：仅基于文本提示微调（不输入音频），影响的是 $P(Y|T_x, I)$ 而非 $P(Y|X, I)$，无法缓解任务过拟合。
3. **Story 最优**：故事任务的长而多样响应有效正则化 $P_\Lambda(Y|X)$，且重复率最低（0.1%）。
4. **QA(Long) 可用但有缺陷**：能激活但重复率高（4.6%），因 QA 答案不如故事多样。
5. **Q-Former 的作用**：Story(LoRA only) 在 SQQA/Story 上与 Story 相当，但 SAC 显著更差——说明 Q-Former 的参与对需要音视联合推理的任务更重要。

---

## 8. 总结与展望

### 贡献总结

| 贡献 | 意义 |
|---|---|
| 首个通用听觉 LLM | 单模型同时处理语音、音频事件、音乐三种基本声音 |
| 任务过拟合的分析与解决 | 发现指令微调导致涌现能力丧失，提出激活调优恢复 |
| 三级任务评估体系 | 15 项任务分 3 级难度，系统评估通用听觉能力 |
| 两个新任务 | 音频故事讲述、语音音频协同推理——首次提出 |

### 局限性

- **激活调优的代价**：恢复涌现能力的同时，部分训练任务（AAC、En2Zh）性能下降约 5-7%——并非完美正则化，存在 trade-off。
- **绝对性能仍低**：SAC 的 Accuracy 仅 0.50，Story 的质量仅用 Diversity 衡量（词数丰富度），缺乏语义质量评估。
- **依赖外部编码器**：Whisper 和 BEATs 编码器冻结，无法端到端优化音频表征——后续的 video-SALMONN 系列在此基础上演进。
- **13B 参数规模**：与更大规模模型相比，推理和复杂推理能力有上限。
- **SAC 召回率有限**：Level 3 任务 FR 仅 0.73，仍有 27% 的样本无法跟随指令。

### 未来方向

- **弥补缺陷**：探索不损害训练任务的激活方法——如自适应 LoRA 缩放（按任务类型动态调整），或更精细的正则化目标。
- **新型方案**：将激活调优推广到更多模态（视觉、视频），或用在线 RL 替代离线激活调优实现实时能力调控；探索无 rollout 的步级奖励估计。
- **减少约束**：放宽对特定编码器的依赖——探索端到端音频编码器训练或统一的音频-文本预训练；降低激活调优对故事数据的依赖，寻找更通用的正则化数据类型。

**与后续工作的关联**：SALMONN 是 SALMONN 系列的基础工作——后续的 video-SALMONN 2 将其扩展到视频模态，video-SALMONN-o1 进一步引入推理能力。理解 SALMONN 的双编码器和激活调优机制，是理解整个系列演进的关键起点。
