---
title: "video-SALMONN 2: Caption-Enhanced Audio-Visual Large Language Models"
source:
  type: "论文解读"
  project: "ByteDance"
  url: "https://arxiv.org/abs/2506.15220"
  pdf: "/vibe-reading/papers/video-salmonn-2-caption-enhanced-audio-visual-llm.pdf"
date: "2026-08-03T19:00:00+08:00"
category: [AI, Models, Multimodal, Papers]
tags: ["video-SALMONN 2", "Audio-Visual LLM", "MrDPO", "DPO", "Video Captioning", "Video QA", "LoRA", "RL", "Caption Quality", "Knowledge Distillation", "SOTA"]
description: "目的：提升音视频大语言模型的视频字幕质量并转移至视频问答。手段：MrDPO 通过周期性合并并重新初始化 LoRA 代理刷新 DPO 参考策略，配合基于原子事件的字幕质量目标（完整度+事实准确度），实现持续改进；用 MrDPO 模型生成高质量字幕语料蒸馏到新模型。结论：生成的字幕在细节与准确性上超越 GPT-4o 和 Gemini-1.5 Pro，3B/7B/72B 模型在多个音视频与纯视觉基准上达到 SOTA，72B 超越所有其他开源系统。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/video-salmonn-2-caption-enhanced-audio-visual-llm.pdf" target="_blank" rel="noopener">预览</a> · **论文** [video-SALMONN 2: Caption-Enhanced Audio-Visual Large Language Models](https://arxiv.org/abs/2506.15220) · **作者** Changli Tang, Yixuan Li, Yudong Yang, Jimin Zhuang, Guangzhi Sun, Wei Li, Zejun Ma, Chao Zhang · **发表** Preprint, 2025-09 · **项目** [github.com/bytedance/video-SALMONN-2](https://github.com/bytedance/video-SALMONN-2) · **解读** 2026-08-03

## 1. 论文概览

视频字幕是训练多模态 LLM 的基础——高质量、低幻觉、紧贴输入的字幕对鲁棒的多模态理解至关重要。然而视频字幕面临三大瓶颈：可靠的量化指标缺失、训练策略有限、以及普遍丢弃音频流。

video-SALMONN 2 提出了一套完整的解决方案，核心贡献有三：

1. **MrDPO（多轮直接偏好优化）**：通过周期性合并并重新初始化 LoRA 代理来刷新 DPO 参考策略，避免参考过时，实现字幕质量的持续提升。
2. **基于原子事件的字幕质量目标**：将字幕评估分解为 LLM 友好的子步骤，用纯文本 LLM 估计缺失事件与幻觉事件，实现指标驱动的 RL 自动训练。
3. **字幕增益的跨任务转移**：用 MrDPO 增强的字幕模型重新标注视频数据，生成更高质量的 SFT 语料训练新模型，将字幕优化收益转移至视频问答。

**Take-home**：MrDPO 证明了通过周期性刷新参考策略，DPO 可以实现持续的自我改进而非单轮优化——生成的视频字幕在细节和准确性上**超越 GPT-4o 和 Gemini-1.5 Pro**，且这一增益可通过数据蒸馏转移至通用视频理解。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We present video-SALMONN 2, a family of audio-visual large language models that set new state-of-the-art (SOTA) results in video description and question answering (QA). Our core contribution is multi-round direct preference optimisation (MrDPO), paired with a caption-quality objective that jointly rewards completeness and factual accuracy. Unlike standard DPO with a fixed reference policy, MrDPO periodically refreshes the reference by bootstrapping from a newly re-initialised lightweight adapter trained on the latest preferences, avoiding reference staleness and enabling continual improvement. This strategy produces captions that are consistently more detailed and accurate than those from proprietary systems such as GPT-4o and Gemini-1.5 Pro. We further distil these gains by using our model to generate a high-quality video-caption corpus for supervised fine-tuning of new models, transferring benefits beyond captioning to strong performance on complex video-QA tasks. Across widely used audio-visual and visual-only understanding benchmarks (including Video-MME, WorldSense, AVUT, Video-Holmes, DailyOmni, MLVU, and LVBench), our 3B and 7B models achieve SOTA results at comparable scales, while the 72B model surpasses all other open-source systems. Our source code, models, and data are released at https://github.com/bytedance/video-SALMONN-2.

> **译：** 我们提出 video-SALMONN 2，一族在视频描述与问答（QA）上取得新的最优（SOTA）结果的音频-视觉大语言模型。我们的核心贡献是多轮直接偏好优化（MrDPO），配合一个同时奖励完整性和事实准确性的字幕质量目标。与使用固定参考策略的标准 DPO 不同，MrDPO 通过从最新偏好训练的新初始化轻量级适配器进行引导式刷新，周期性更新参考策略，避免参考过时并实现持续改进。这一策略生成的字幕在细节和准确性上始终优于 GPT-4o 和 Gemini-1.5 Pro 等专有系统。我们进一步通过使用模型生成高质量视频字幕语料库来蒸馏这些收益，用于新模型的监督微调，将字幕之外的收益转移到复杂视频 QA 任务的强劲表现上。在广泛使用的音视频和纯视觉理解基准上（包括 Video-MME、WorldSense、AVUT、Video-Holmes、DailyOmni、MLVU 和 LVBench），我们的 3B 和 7B 模型在同等规模下达到 SOTA，72B 模型超越所有其他开源系统。

</details>

## 2. 研究背景

### 2.1 问题定义

视频字幕的挑战在于：视频结合了丰富的帧内空间内容与随时间演变的音视频事件。现有系统的局限体现在：

- **量化指标不可靠**：BLEU、ROUGE-L 等经典指标无法衡量详细视频字幕的质量
- **训练策略有限**：缺乏针对字幕质量的专门优化方法
- **丢弃音频流**：尽管音频提供互补信息，但多数系统仍仅处理视觉帧

### 2.2 现有方法的不足

| 方向 | 代表模型 | 局限 |
|------|---------|------|
| 视觉 LLM | Qwen2.5-VL, LLaVA-Video | 无音频感知，字幕细节不足 |
| 音频感知 | SALMONN, Qwen-Audio | 缺乏音视频联合理解 |
| 音视频联合 | video-SALMONN, VideoLLaMA 2 | 字幕质量有限，半双工 |
| 全模态 | Qwen2.5-Omni, Qwen3-Omni | 仍主要聚焦视觉，常遗漏语音和声音事件 |

GPT-4o 的视觉版本缺乏音频理解，导致事件遗漏率高。现有开源模型中，很少有能提供详细且准确的视频描述的。

## 3. 方法详解

### 3.1 模型架构

![Figure 1: video-SALMONN 2 架构。输入视频经独立的视觉和音频分支处理，提取视觉和音频 token 后同步交错排列，与文本 prompt 的 token 组合形成 LLM 输入。MrDPO 阶段，LoRA 代理在每轮训练结束时合并进 LLM 骨干。](/vibe-reading/images/articles/video-salmonn-2-caption-enhanced-audio-visual-llm/fig-01-architecture.png)

模型在预训练视觉 LLM 基础上添加并行音频分支，使模型能同时"看"和"听"：

- **视觉分支**：视频帧经视觉编码器提取特征，视觉对齐器映射到 LLM 输入空间
- **音频分支**：音频波形经 Whisper-Large-v3 编码器提取特征，window-level Q-Former（0.5 秒窗口）映射到 LLM 输入空间
- **交错同步**：同一秒的音频 token 和视觉 token 相邻排列，确保时刻对齐

$$
\hat{Y} = \arg\max_Y P(Y \mid P, H)
$$

给定用户文本 prompt $P$ 和音视频 token 序列 $H$，LLM 生成文本响应 $\hat{Y}$。

### 3.2 多阶段训练

![Figure 2: 训练流程概览，包括音频模态对齐、音视频 SFT 和 MrDPO。音视频 SFT 阶段引入 LoRA。MrDPO 每轮添加新 LoRA 代理并将旧 LoRA 合并进 LLM，模型始终只含一个激活的 LoRA。](/vibe-reading/images/articles/video-salmonn-2-caption-enhanced-audio-visual-llm/fig-02-training-pipeline.png)

训练分为四个阶段，骨干 LLM、视觉编码器和音频编码器始终冻结以防灾难性遗忘：

| 阶段 | 训练对象 | 数据 | 目标 |
|------|---------|------|------|
| **1. 音频模态对齐** | 仅音频对齐器 | LibriSpeech-960h（ASR）+ AudioCaps（音频字幕） | 语音识别 + 音频字幕 |
| **2. 音视频 SFT** | LoRA 适配器 + 音频对齐器 | FineVideo + CinePile + LLaVA-Video-178k | 音视频字幕 + 视频 QA |
| **3. MrDPO** | 每轮新 LoRA 代理 | SFT 数据集上的字幕对 | 字幕质量优化 |
| **4. 数据标注** | MrDPO 模型 | 100k 视频 | 生成高质量字幕用于新模型 SFT |

### 3.3 MrDPO：多轮直接偏好优化

MrDPO 的核心创新在于**周期性刷新参考策略**，解决标准 DPO 单轮训练因参考模型固定而无法有效优化的"参考过时"问题。

**基于原子事件的指标**：训练前，用 GPT-4o 将 ground-truth 字幕分解为原子事件。模型用 nucleus sampling 生成字幕对后，用 GPT-3.5 评估：
- **缺失事件**（missing）：ground-truth 中有但字幕中未描述的事件
- **幻觉事件**（hallucination）：字幕中描述错误或 ground-truth 中不存在的事件
- **总错误率** = 缺失率 + 幻觉率

每对字幕中总错误率较低者为 DPO 的优选样本。差异过小的对被排除以减少评估噪声。

**LoRA 代理的多轮机制**（每轮 $t$）：

1. **合并旧 LoRA**：将上一轮的 LoRA $\Delta_{t-1}$ 合并进 LLM 骨干 $\Lambda_{t-1}$，得到新骨干 $\Lambda_t$

$$
W_t = W_{t-1} + \alpha A_{t-1} B_{t-1}
$$

2. **初始化新 LoRA**：在新骨干上添加新初始化的 LoRA $\tilde{\Delta}_t$，仅训练该 LoRA（"LoRA 代理"），以 $\Lambda_t$ 作为本轮参考模型

3. **gDPO 训练**：使用引导 DPO 损失训练 $\tilde{\Delta}_t$：

$$
\mathcal{L}_{\text{gDPO}} = -\mathbb{E}_{(x,y_{\text{win}},y_{\text{lose}})} \left[\log \sigma\left(\beta \log \frac{\pi_\theta(y_{\text{win}}|x)}{\pi_{\text{ref}}(y_{\text{win}}|x)} - \beta \log \frac{\pi_\theta(y_{\text{lose}}|x)}{\pi_{\text{ref}}(y_{\text{lose}}|x)}\right)\right] + \lambda \mathbb{E}_{(x,y_{\text{gt}})} \log \pi_\theta(y_{\text{gt}}|x)
$$

其中第二项是对 ground-truth 字幕的交叉熵正则项（$\lambda=0.1$），用于稳定多轮训练。与 Iterative RPO 不同，gDPO 使用 ground-truth 而非 chosen 样本作为引导，目的是稳定训练而非避免概率下降。

### 3.4 字幕增益转移至视频问答

MrDPO 显著提升了字幕质量，但仅优化字幕的 RL 训练**并未直接提升**通用视频理解能力——后者主要由音视频 SFT 阶段决定。

论文的关键洞察：**视频字幕数据比视频 QA 数据更本质**。高质量字幕让模型建立对视频的整体理解（内容、细节、主题、情感），QA 数据则是将字幕知识精炼到具体任务。

因此，用 MrDPO 模型重新标注现有视频数据，生成更高质量的字幕语料，再用新字幕 + 原 QA 数据对新模型进行音视频 SFT——将字幕优化收益转移至通用视频理解。

## 4. 关键公式解读

### 4.1 LoRA 合并

$$
W_t = W_{t-1} + \alpha A_{t-1} B_{t-1}, \quad A_{t-1} \in \mathbb{R}^{d \times r},\; B_{t-1} \in \mathbb{R}^{r \times d}
$$

其中 $W_{t-1} \in \mathbb{R}^{d \times d}$ 为 LLM 骨干参数，$\alpha$ 为 LoRA 缩放因子（$r=128$, $\alpha=2.0$）。每轮结束时将训练好的 LoRA 合并进骨干，使模型始终只含一个激活的 LoRA——避免多轮累积导致参数膨胀。

### 4.2 gDPO 损失

gDPO 在标准 DPO 损失基础上增加 ground-truth 交叉熵正则项。消融显示：$\lambda > 1$ 时正则项过强阻碍 DPO 优化；$\lambda < 0.01$ 时正则项太弱无法稳定多轮训练；$\lambda = 0.1$ 为最佳平衡点。

## 5. 实验设置

### 5.1 模型规格

| 模型 | 基座 | 帧率 | 最大帧数 | 分辨率 |
|------|------|------|---------|--------|
| video-SALMONN 2 (7B) | 内部视觉 LLM + LLaVA-OneVision-7B | 1 FPS | 110 | 384×384 |
| video-SALMONN 2F-16 (7B) | F-16 | 16 FPS | 1760 | 384×384 |
| video-SALMONN 2+ (3B/7B/72B) | Qwen2.5-VL 系列 | 10 FPS | 768 | 61250 像素/帧 |

音频分支统一使用 Whisper-Large-v3 编码器 + window-level Q-Former（0.5 秒窗口，30 秒输入产生 60 个音频 token）。

### 5.2 数据与评价

- **训练数据**：LibriSpeech-960h（ASR）、AudioCaps（音频字幕）、FineVideo + CinePile + LLaVA-Video-178k（音视频 SFT）
- **字幕评价**：自建 483 视频人工标注基准（事件缺失率 Miss% + 幻觉率 Hall% + 总错误率 Total%）+ VDC Detailed + Video-MME Captioning
- **QA 评价**：Video-MME、WorldSense、AVUT、Video-Holmes、DailyOmni（音视频）；MLVU、LVBench（纯视觉）
- **MrDPO 设置**：6 轮 gDPO，前 5 轮仅训练字幕，第 6 轮加入 QA 数据；$\lambda = 0.1$

### 5.3 复现信息

代码、模型、数据全部开源（[GitHub](https://github.com/bytedance/video-SALMONN-2)）。7B 模型训练成本：音频对齐 3 小时（32×H800）、音视频 SFT 14 小时（32×H800）、MrDPO 每 5 轮约 2 小时（8×H800）。

## 6. 实验结果

### 6.1 字幕质量

| Model | Miss%↓ | Hall%↓ | Total%↓ | VDC Detailed↑ | VMME↑ |
|-------|--------|--------|---------|---------------|-------|
| GPT-4o | 17.0 | 14.2 | 31.2 | 46.3\|2.5 | 64.3 |
| Qwen2.5-VL (7B) | 21.9 | 17.4 | 39.2 | 44.5\|2.4 | 55.0 |
| Qwen2.5-Omni (7B) | 26.7 | 21.7 | 48.1 | 39.7\|2.2 | 52.7 |
| **video-SALMONN 2 (7B)** | **10.0** | **12.9** | **22.9** | 46.1\|2.5 | **65.9** |

video-SALMONN 2 在自建字幕基准上**全面领先**——总错误率 22.9% 远低于 GPT-4o 的 31.2%。三项指标高度相关，验证了字幕基准的有效性。

### 6.2 整体视频 QA 结果

| Model | Video-MME | WorldSense | AVUT | Video-Holmes | DailyOmni | MLVU | LVBench |
|-------|-----------|------------|------|--------------|-----------|------|---------|
| Qwen2.5-VL (3B) | 61.5 | - | - | - | 37.4 | 68.2 | 43.3 |
| **video-SALMONN 2+ (3B)** | **68.3** | **48.3** | **66.2** | **42.2** | **67.7** | **70.5** | **48.6** |
| Qwen2.5-VL (7B) | 65.1 | - | - | 27.8 | 40.7 | 70.2 | 45.3 |
| **video-SALMONN 2+ (7B)** | **73.4** | **50.9** | **69.5** | **46.9** | **71.8** | **73.6** | **49.7** |
| GPT-4o | 71.9 | 42.6 | 56.6 | 42.0 | 56.5 | 64.6 | 30.8 |
| Gemini-1.5 Pro | 75.0 | 48.0 | 78.3 | 41.2 | - | - | 33.1 |
| Qwen3-Omni-Flash | 71.4 | 54.1 | - | 57.3 | 76.2 | 75.5 | 51.1 |
| Qwen2.5-VL (72B) | 73.3 | - | - | 50.2 | 61.8 | 74.6 | 47.3 |
| **video-SALMONN 2+ (72B)** | **79.7** | **56.5** | **72.2** | **57.8** | **79.4** | **80.4** | **55.5** |

关键发现：
- **3B 超越所有 7B 模型**，7B 与 72B 模型竞争力相当
- **72B 在大多数音视频 QA 基准上超越 GPT-4o 和 Qwen3-Omni-Flash**，并在多数基准上超越 Gemini-1.5 Pro
- 在纯视觉基准（MLVU、LVBench）上仍保持强竞争力

## 7. 消融实验

### 7.1 MrDPO 组件消融

| Method | Total%↓ | 改进幅度 |
|--------|---------|---------|
| Visual（基座） | 50.7 | - |
| + SFT | 41.8 | +17.6% |
| + DPO | 37.8 | +9.6% |
| + gDPO（替 DPO） | 39.7 | -5.0% |
| + LoRA Proxy（替直接微调） | 33.7 | +15.1% |
| **+ MrDPO（完整）** | **22.9** | **+32.0%** |

![Figure 3: MrDPO 消融实验。(a) gDPO 与标准 DPO 在六轮训练中的对比——gDPO 从第二轮起持续优于 DPO。(b) LoRA 代理与直接微调现有 LoRA 的对比——代理方式在早期优势显著。](/vibe-reading/images/articles/video-salmonn-2-caption-enhanced-audio-visual-llm/fig-03-mrdpo-ablation.png)

**gDPO vs DPO**（Figure 3a）：经典 DPO 在第一轮略有优势，但 gDPO 从第二轮起**持续优于** DPO——其交叉熵正则项在多轮训练中发挥稳定作用。

**LoRA Proxy vs Direct**（Figure 3b）：每轮重新初始化 LoRA 代理优于直接在上一轮 LoRA 上继续微调，尤其在早期。合并旧 LoRA 逐步强化模型基础，重新初始化则允许模型灵活探索与当前偏好信号对齐的新低秩子空间。

### 7.2 SFT 数据消融

| Model | SFT 数据来源 | Video-MME Avg↑ |
|-------|-------------|----------------|
| F-16 (7B) | 原始 SFT | 69.2 |
| F-16 (7B) | video-SALMONN 2 生成 | **70.2** |
| Qwen2.5-VL (72B) | 原始 SFT | 78.8 |
| Qwen2.5-VL (72B) | video-SALMONN 2+ 7B 生成 | **79.7** |

使用 MrDPO 模型生成的字幕数据训练的模型**一致优于**使用原始 SFT 数据的模型——证明字幕优化增益可通过数据蒸馏有效转移。

### 7.3 评估器可替换性

用 Qwen3-4B 替代 GPT-3.5 作为训练时的字幕质量评估器，结果几乎相同（Total% 33.7 vs 33.7）——评估器可替换，降低了对特定大模型的依赖。

## 8. 总结与展望

### 贡献总结

video-SALMONN 2 通过 MrDPO 解决了 DPO 参考过时问题，实现字幕质量的持续自我改进，生成的字幕超越 GPT-4o 和 Gemini-1.5 Pro。通过将增强的字幕器用于数据重新标注，将字幕收益转移至通用视频理解，在多个基准上达到开源 SOTA。

### 局限性（批判性）

1. **MrDPO 仅优化字幕**：RL 训练聚焦字幕，模型通用视频理解能力几乎完全由 SFT 决定，需通过数据蒸馏间接转移。
2. **评估依赖 LLM**：原子事件评估依赖 GPT-3.5/GPT-4o，虽可替换为更小模型但仍引入外部依赖。
3. **6 轮为经验值**：消融未展示更多轮次是否带来持续收益或过拟合。

### 未来方向（创造性，idea 三法）

- **弥补缺陷**：将 MrDPO 扩展至同时优化字幕与 QA，而非仅字幕；探索更多轮次的收益曲线与早停策略。
- **新型方案**：将原子事件评估从离线 LLM 调用替换为可微的奖励模型，实现端到端 RL 而非依赖外部 LLM 评估。
- **减少约束**：将 MrDPO 的 LoRA 代理刷新机制推广至其他模态（如纯文本 LLM 的对齐），验证其作为通用 RL 训练范式的潜力。
