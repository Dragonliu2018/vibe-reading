---
title: "MiMo-Audio: Audio Language Models are Few-Shot Learners"
source:
  type: "论文解读"
  project: "MiMo"
  url: "https://github.com/XiaomiMiMo/MiMo-Audio"
  pdf: "/vibe-reading/papers/mimo-audio-few-shot-learners.pdf"
date: "2026-07-26"
category: [AI, Models, MiMo, Papers]
tags: ["MiMo-Audio", "Audio Language Model", "Few-Shot Learning", "Audio Tokenizer", "Next-Token Prediction", "Speech Intelligence"]
description: "目的：音频语言模型的少样本泛化。手段：无损高保真 tokenizer + patch 架构 + 100M 小时 next-token 预训练 + thinking 后训练。结论：MiMo-Audio-7B 涌现 GPT-3 式少样本能力，多项音频基准开源 SOTA、逼近闭源。"
readingTime: "16 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/mimo-audio-few-shot-learners.pdf" target="_blank" rel="noopener">预览</a> · **论文** [MiMo-Audio: Audio Language Models are Few-Shot Learners](https://github.com/XiaomiMiMo/MiMo-Audio) · **作者** LLM-Core Xiaomi（Detai Xin, Shujie Hu, Chengzuo Yang 等）· **发表** 2025-09 · **项目** https://github.com/XiaomiMiMo/MiMo-Audio · **解读** 2026-07-26

---

## 1. 论文概览

**一句话**：MiMo-Audio 把 GPT-3 的"next-token prediction 规模换泛化"范式搬到语音域——在 100M+ 小时无损音频上预训练，让模型涌现出**少样本任务泛化**能力，无需任何任务特定微调。

- **任务**：通用音频语言模型——语音理解、生成、对话、推理一体化。
- **核心创新**：无损高保真 MiMo-Audio-Tokenizer + patch 编解码架构 + 两阶段预训练（理解 → 理解-生成联合）+ thinking 后训练。
- **结果**：MiMo-Audio-7B-Base 在 SpeechMMLU（S2S 69.1、modality gap 仅 3.4）与 MMAU（overall 66.0）上开源 SOTA；MiMo-Audio-7B-Instruct 在 MMAU（74.90）、Big Bench Audio、MultiChallenge Audio、instruct-TTS 上开源 SOTA，逼近甚至超越 GPT-4o-audio。代码与权重开源。

**take-home**：当预训练数据跨越约 0.7T tokens 的临界阈值，模型从近零基线发生**相变式涌现**——无需任何参数更新就能做语音转换、风格迁移、语音编辑等训练中从未见过的任务。这是语音域的"GPT-3 moment"。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Existing audio language models typically rely on task-specific fine-tuning to accomplish particular audio tasks. In contrast, humans are able to generalize to new audio tasks with only a few examples or simple instructions. GPT-3 has shown that scaling next-token prediction pretraining enables strong generalization capabilities in text, and we believe this paradigm is equally applicable to the audio domain. By scaling MiMo-Audio's pretraining data to over one hundred million of hours, we observe the emergence of few-shot learning capabilities across a diverse set of audio tasks. We develop a systematic evaluation of these capabilities and find that MiMo-Audio-7B-Base achieves SOTA performance on both speech intelligence and audio understanding benchmarks among open-source models. Beyond standard metrics, MiMo-Audio-7B-Base generalizes to tasks absent from its training data, such as voice conversion, style transfer, and speech editing. MiMo-Audio-7B-Base also demonstrates powerful speech continuation capabilities, capable of generating highly realistic talk shows, recitations, livestreaming and debates. At the post-training stage, we curate a diverse instruction-tuning corpus and introduce thinking mechanisms into both audio understanding and generation. MiMo-Audio-7B-Instruct achieves open-source SOTA on audio understanding benchmarks (MMSU, MMAU, MMAR, MMAU-Pro), spoken dialogue benchmarks (Big Bench Audio, MultiChallenge Audio) and instruct-TTS evaluations, approaching or surpassing closed-source models. Model checkpoints and full evaluation suite are available at https://github.com/XiaomiMiMo/MiMo-Audio.

> **译：** 现有音频语言模型通常依赖任务特定微调来完成特定音频任务。相比之下，人类只需少量示例或简单指令就能泛化到新的音频任务。GPT-3 表明扩展 next-token prediction 预训练能在文本域带来强泛化能力，我们相信这一范式同样适用于音频域。通过将 MiMo-Audio 的预训练数据扩展到超过一亿小时，我们观察到跨多种音频任务的少样本学习能力涌现。我们开发了系统能力评估，发现 MiMo-Audio-7B-Base 在语音智能与音频理解基准上达到开源 SOTA。除标准指标外，MiMo-Audio-7B-Base 还能泛化到训练数据中不存在的任务，如语音转换、风格迁移和语音编辑。MiMo-Audio-7B-Base 还展现强大的语音续写能力，能生成高度逼真的访谈、朗诵、直播和辩论。在后训练阶段，我们整理了多样化的指令微调语料，并将 thinking 机制引入音频理解与生成。MiMo-Audio-7B-Instruct 在音频理解基准（MMSU、MMAU、MMAR、MMAU-Pro）、口语对话基准（Big Bench Audio、MultiChallenge Audio）和 instruct-TTS 评估上达到开源 SOTA，逼近甚至超越闭源模型。模型权重与完整评估套件已开源。

</details>

## 2. 研究背景

人类对语音的理解高度灵活——整合说话人、口音、环境、社交场景等上下文，并按心境、意图调节自己的语调与韵律。但现有音频语言模型缺乏这种"vocal intelligence"与泛化性：做语音对话、翻译、风格迁移都得靠**任务特定微调**。

GPT-3 证明在文本域 scale next-token prediction 是通向任务泛化的可行路径。论文假设这一原则延伸到语音域——**在大规模语音语料上用 next-token prediction 预训练，能让模型获得跨任务的强泛化能力**。此前虽有 AudioLM、Voicebox 等尝试 next-token prediction 预训练语音，但都没能实现"广谱、通用的任务泛化"。

论文指出两个关键方面：

| 关键方面 | 含义 | MiMo-Audio 的做法 |
|---|---|---|
| **无损信息流** | 语音信号的全部信息（含副语言信息）要在模型内流通 | 不能用丢失副语言信息的语音表示 |
| **规模** | 持续扩大预训练数据 → 持续性能提升 + 涌现能力 | 扩展到 100M+ 小时，比最大开源语音模型大一个数量级 |

**隐表示的选择**是核心挑战。现有音频 tokenizer 在语义 token（与文本对齐好但丢高频声学细节）与声学 token（高保真重建但难与文本语义对齐）之间两难。SpeechTokenizer、Mimi 用语义蒸馏但受限于编码器规模；X-Codec、XY-Tokenizer 用双流架构但语义/声学来自不同表示空间。MiMo-Audio-Tokenizer 直接**从零训练、统一捕获语义与声学**，靠 scale up 缓解二者冲突。

> **缺口**：尚无工作证明"把无损、压缩式的语音预训练 scale 到 100M 小时"能解锁任务泛化。MiMo-Audio 即补此缺口。

## 3. 方法详解

MiMo-Audio = **MiMo-Audio-Tokenizer** + **MiMo-Audio**（patch 编解码 + MiMo-7B LLM）。两阶段从零训练 tokenizer，再用 tokenizer 产出的音频 token 预训练 LLM。

![Figure 1：预训练涌现行为与 SOTA 对比。上：5-shot SpeechMMLU T2S/S2S、16-shot Voice Conversion、16-shot Speech-to-Speech Translation 随训练 tokens 的性能曲线——约 0.7T tokens 处发生相变式涌现。下：MiMo-Audio-7B-Instruct 与 Step-Audio-2-mini、Kimi-Audio、Qwen2.5-Omni、Gemini-2.5-Flash、GPT4o-Audio 在 MMAU-Pro/MMAU/Big Bench Audio 上的对比。](/vibe-reading/images/articles/mimo-audio-few-shot-learners/fig-01-emergent-behavior-sota-comparison.png)

### 3.1 MiMo-Audio-Tokenizer：统一语义与声学

1.2B 参数的 tokenizer，目标：**重建保真度优先 + token 对下游语言建模友好**。

![Figure 2：MiMo-Audio-Tokenizer 框架。音频编码器（Transformer + 上下采样）、离散化（RVQ）、音频解码器、声码器。Stage 1 统一表示学习（A2T + 重建损失），Stage 2 对抗微调（判别器）提升细粒度波形重建。](/vibe-reading/images/articles/mimo-audio-few-shot-learners/fig-02-tokenizer-framework.png)

- **音频编码器**：32 层 Transformer（dim 1280、FFN 5120、20 heads、RoPE、GELU），输入/输出各加 2× 下采样。关键设计——**把第 3 层隐状态与末层输出逐元素相加**，缓解语义/声学信息冲突。
- **离散化**：20 层 RVQ，前 2 层 codebook 1024、其余 128；24kHz → mel-spectrogram 100Hz → 编码器输出 25Hz 连续表示 → RVQ 量化成离散索引矩阵 $A \in \mathbb{N}^{M \times R}$。
- **音频解码器**：编码器镜像结构，但用**因果 self-attention**（支持流式生成）。
- **声码器**：Vocos 设计但用 Transformer 主干（16 层、16 heads、dim 256、FFN 1024、滑动窗口 attention [40,10] → 感受野 [6.4s, 1.6s]），支持 sequence packing 高效训练。

**两阶段训练**：

1. **Stage 1 统一表示学习**：音频重建 + 音频到文本（A2T）任务联合训练，从零训练 tokenizer 与 LLM。A2T 损失用 LLM 文本输出的 next-token prediction，让表示空间对齐文本同时保留声学信息。在 11M+ 小时数据上训练。
2. **Stage 2 对抗微调**：冻结编码器与离散化模块（保 token 语义结构），训练解码器与声码器，引入 MPD + MS-STFT 判别器做 Hinge-GAN 对抗训练 + feature matching，提升细粒度波形重建、消除 vocoding 伪影。

### 3.2 MiMo-Audio：patch 编解码 + LLM

![Figure 3：MiMo-Audio 架构。中：整体架构（patch encoder → MiMo-7B LLM → patch decoder）。左：patch encoder 把 4 个连续 RVQ 时间步聚合成一个 patch。右：patch decoder 自回归生成 patch 内的 RVQ token，带延迟机制。](/vibe-reading/images/articles/mimo-audio-few-shot-learners/fig-03-mimo-audio-architecture.png)

模型接受文本 token 与音频 patch 的交错序列，自回归预测文本或音频——支持任意文本-音频组合任务。核心设计：把 4 个连续 RVQ 帧聚合成一个 patch，把 200 tokens/sec 降到 **6.25Hz 给 LLM**，缓解语音/文本的粒度失配、促进跨模态知识迁移。

- **Patch Encoder**（6 层、dim 1024、64 heads）：8 个 RVQ codebook 各有独立嵌入表，帧内跨 codebook 求和聚合 → 块内双向 self-attention 捕捉局部上下文 → 拼接投影到 LLM 维度。
- **LLM 主干**：MiMo-7B-Base（36 层、dim 4096、32 heads、FFN 11008）。AdaLN 注入 timestep；QK-Norm（RMSNorm）稳定训练；cross-attention 隐式学文本-语音对齐；RoPE 注入所有 attention。集成 DiTTo-TTS 的 long-skip connection + global AdaLN（省参数不降质）；REPA 把第 8 层输出对齐到 mHuBERT 语义空间——**不提质量但显著加速收敛**。
- **Patch Decoder**（16 层、dim 1024、64 heads）：块内因果 self-attention 自回归生成 patch 内音频 token。8 个 RVQ codebook 各有独立输出头。关键——**延迟机制**：跨 RVQ 层引入递增延迟 $D=[0,1,2,3,4,5,6,7]$，缓解跨层 token 依赖、提升生成质量。

### 3.3 双嵌入文本编码：多语言 + 低层线索

选 **UMT5-base**（支持 107 语言、子词分词器序列长度合理，规避 ByT5 字节级对中文过长的问题）。关键发现——**仅用 last hidden state 可懂度差**（高层语义抽象掉了低层词法/音素线索）。解决方案：

$$
q = \text{LayerNorm}(\text{last\_hidden\_state}) + \text{LayerNorm}(\text{raw\_word\_embedding})
$$

非参数 LayerNorm 平衡两表示空间再相加。策略模型无关、可推广到其他多语言大模型。文本表示再过 ConvNeXt v2 轻量卷积精炼模块加速对齐收敛。

### 3.4 两项推理改进

1. **修正训练-推理失配**（§4 详述）：推理时 prompt 区的 noisy latent 因无损失约束而漂移——每步用真值强行覆盖。
2. **APG 替代 CFG**（§4 详述）：大 CFG scale 引发 oversaturation 伪影，APG 把引导残差分解为平行/正交分量、抑制平行分量以消伪影。

## 4. 关键公式解读

**(1) CFM noisy latent 线性插值**（rectified flow）——训练时的真值轨迹：

$$
z_t = (1 - t)\,z_0 + t\,z_1
$$

**(2) CFM 优化目标**——只在被 mask 的目标区域算速度预测误差：

$$
\mathcal{L}_{\text{CFM}} = \mathbb{E}_{t, m, z_0, z_1}\!\left[(1 - m) \odot \left[(z_1 - z_0) - v(z_t, t, z_{\text{ctx}}, q;\, \theta_{\text{CFM}})\right]^2\right]
$$

其中 $m$ 为构造 $z_{\text{ctx}}$（随机遮蔽连续 span 得到的音频上下文 prompt）的二值掩码；训练时以 10% 概率同时丢弃 $z_{\text{ctx}}$ 与 $q$ 以学无条件分布、支持 CFG。$z_{\text{ctx}}$ 的遮蔽策略天然赋予模型**零样本语音克隆**能力。

**(3) 修正训练-推理失配**——推理每步用真值覆盖 prompt 区：

$$
z_{t}^{\text{ctx}} \leftarrow t\,z_{\text{ctx}} + (1 - t)\,z_{0}^{\text{ctx}}
$$

**关键洞察**：因 CFM 损失只在 mask 的生成区计算，模型对 prompt 区的速度预测本质无约束、推理时累积漂移。覆盖之即消除失配。其推论：要得到真正无条件的速度估计，**仅丢弃 $z_{\text{ctx}}$ 不够，还须丢弃显式构造的 $z_{t}^{\text{ctx}}$**（它本身泄漏 prompt 声学信息）。

**(4) APG**——把引导残差在样本域分解为平行/正交分量、抑制平行项：

$$
\mu_t^{\text{APG}} = \mu_t + \alpha\,\Delta\mu_t^{\perp} + \eta\,\Delta\mu_t^{\parallel}, \qquad v_t^{\text{APG}} = \frac{\mu_t^{\text{APG}} - z_t}{1 - t}
$$

其中 $\Delta\mu_t^{\parallel} = \frac{\langle \Delta\mu_t, \mu_t\rangle}{\langle \mu_t, \mu_t\rangle}\mu_t$、$\Delta\mu_t^{\perp} = \Delta\mu_t - \Delta\mu_t^{\parallel}$。APG 理论：平行分量是 oversaturation 主因，抑制之即可消伪影。默认 $\alpha$（CFG scale）=4.0、$\eta$（平行抑制）=0.5；再加反向动量 $\beta=-0.3$ 让引导聚焦当前更新方向而非累积过去动量。

## 5. 实验设置

- **数据**：MiMo-Audio-Tokenizer 用 11M+ 小时中英文（Stage 1 统一表示 + Stage 2 对抗微调）；MiMo-Audio 主干预训练基线/消融用 10 万小时，大规模扩展到 **100 万+ 小时**——比最大开源语音模型大一个数量级。全部 24 kHz，最长 60 秒。数据流水线含 VAD、说话人切分、ASR、音频质量评估；标注分语义维度（会话质量、知识密度、逻辑推理）与非语义维度（音色、情绪、环境）。
- **模型规模**：MiMo-Audio-Tokenizer 1.2B 参数（从零训练）。MiMo-Audio 主干两变体——1B（16 GPU，batch 256）与 3.5B（64 GPU，batch 1024）；AdamW（β₁=0.9, β₂=0.95），线性 LR 衰减 1e-4→1e-5（1K warmup）。Stage 1（理解训练）2.6T tokens（1.2T text + 1.4T speech），Stage 2（理解-生成联合）5T tokens（2.6T text + 2.4T audio），batch 16.8M，ctx 8192。后训练 100B tokens、6 种任务格式。
- **评价指标**：SpeechMMLU（modality-invariant 通用知识，4 splits T2T/S2T/T2S/S2S）；MMAU/MMSU/MMAR/MMAU-Pro（音频理解与推理）；Big Bench Audio、MultiChallenge Audio（口语对话）；CER/WER（ASR/TTS）；SIM（说话人相似度）；UTMOS（自然度）；DNSMOS（声学质量）；InstructTTSEval（指令 TTS）。
- **推理**：Euler 法解 ODE，**16 步 NFE**。

## 6. 实验结果

### 6.1 涌现能力（Figure 1）

如图 1 所示，在约 **0.7T tokens** 的临界阈值之前，模型在 5-shot SpeechMMLU（T2S/S2S）、16-shot Voice Conversion、16-shot Speech-to-Speech Translation 上的表现可忽略不计；一旦跨越阈值，性能发生**相变式跃升**，随后持续改善并趋于稳定。这种从近零基线而非渐进提升的涌现，直接证明模型自主发展出高级泛化能力——大规模无损压缩式预训练让模型自发学会解决从未见过的复杂任务。

### 6.2 语音智能（Table 6，SpeechMMLU + MMAU，Base 模型）

| 模型 | S2S | S2T | T2S | T2T | modality gap | MMAU overall |
|---|---|---|---|---|---|---|
| Baichuan-Audio-Base | 31.9 | 29.9 | 16.7 | 71.1 | 39.2 | 25.9 |
| Kimi-Audio-Base | 11.8 | 67.9 | 0.0 | 70.7 | 58.9 | 28.6 |
| Step-Audio2-mini-Base | 51.8 | 67.8 | 63.4 | 74.1 | 22.3 | 60.3 |
| **MiMo-Audio-7B-Base** | **69.1** | **69.5** | **71.5** | 72.5 | **3.4** | **66.0** |

MiMo-Audio 在 SpeechMMLU-S2S（69.1）、S2T（69.5）、T2S（71.5）上均最高，**modality gap 仅 3.4**（Step-Audio2 mini 22.3、Kimi-Audio 58.9、Baichuan-Audio 39.2）——架构设计有效保留了跨模态的推理连续性。MMAU overall 66.0（开源第一），speech/sound/music 三子域均衡高分（67.6/65.2/65.3）。

### 6.3 语音任务泛化与续写

MiMo-Audio-7B-Base 在**训练数据中不存在的任务**上也能 few-shot 泛化——只需在上下文中给几个示例，就能做语音转换、情感转换、语速转换、语音降噪、语音翻译。此外还有强大的**语音续写**能力：给定简短语音 prompt，能生成语义连贯的续写，并保留说话人身份/音色、韵律、环境声学及非语音元素（掌声、笑声、叹息）。覆盖脱口秀、演讲、辩论、播客、游戏解说、教学、朗诵、方言、歌唱等多场景。

## 7. 后训练结果

### 7.1 音频理解与对话（Table 8，Instruct 模型）

| 模型 | MMAU overall | MMAU-Pro | MMAR | MMSU | Big Bench S2T/S2S | MultiCh S2T/S2S |
|---|---|---|---|---|---|---|
| Gemini 2.5 Flash | 71.80 | **59.20** | **65.60** | 60.70 | — | — |
| Step-Audio2-mini | 72.73 | 47.91 | 55.80 | 57.18 | 50.90/47.50 | 13.64/8.08 |
| Kimi-Audio-Instruct | 68.20 | 46.60 | 48.00 | 59.78 | 59.40/51.00 | 7.07/1.01 |
| Qwen2.5-Omni | 71.50 | 52.20 | 56.70 | 58.10 | 54.20/53.60 | 11.11/8.08 |
| GPT-4o-Audio | — | 52.50 | 63.50 | — | **70.20/67.20** | — |
| **MiMo-Audio-7B-Instruct** | **74.90** | 53.35 | 63.60 | **61.70** | 72.90/60.20 | **15.15/10.10** |

- **音频理解**：MMAU overall 74.90（**开源 SOTA**，超越 Gemini 2.5 Flash）；MMSU 61.70（+Think 62.88）。MMAU-Pro/MMAR 接近 Gemini。
- **口语对话**：Big Bench Audio S2T 72.90 / S2S 60.20（开源第一，仅次于 GPT-4o）；MultiChallenge Audio S2T 15.15 / S2S 10.10（开源第一）。

### 7.2 ASR 与 TTS（Table 9）

| 模型 | Seed-TTS ZH/EN/Hard WER↓ | InstructTTS-EN overall | InstructTTS-ZH overall | ASR Libri/AISHELL WER↓ |
|---|---|---|---|---|
| MiMo-Audio-7B-Instruct | 1.96/5.37/14.14 | **72.59** | **70.52** | 3.76/1.78 |
| GPT-4o-mini-tts | — | 68.50 | 51.07 | — |
| Step-Audio2-mini | 2.13/3.18/16.31 | — | — | 1.87/0.95 |

在 InstructTTS 评估上，MiMo-Audio-7B-Instruct **在英文（72.59）和中文（70.52）子集上均超越 GPT-4o-mini-tts**（68.50/51.07），尤其中文优势明显——验证了可指令控制的 TTS 生成能力。ASR 与 Seed-TTS 上与 Step-Audio2-mini 相当。

## 8. 总结与展望

**贡献总结**：

1. 首次实证证明：把无损、压缩式语音预训练 scale 到 100M 小时，解锁涌现式任务泛化——语音域的"GPT-3 moment"，以强大少样本学习能力为证。
2. 提出可复制的生成式语音预训练蓝图：统一高保真 audio tokenizer、可扩展架构（patch 编解码 + LLM）、两阶段训练、完整评估套件。
3. 首次将 thinking 引入音频理解与生成的建模过程，桥接感知与复杂认知任务。
4. MiMo-Audio-7B-Instruct 在多个基准达开源 SOTA、比肩闭源。

**局限性（论文自述）**：

- **少样本 ICL 能力受限**：在带背景音乐的语音生成、复杂声音事件处理等场景表现欠佳，需增强通用音频生成。
- **口语对话不稳**：音色不连续、音质不稳、误读、系统提示遵从不一致，需用 **RL** 提升稳定性。
- **thinking 局限**：thinking 在语音相关理解任务上提升，但在声音/音乐理解任务上反降（思考过程引入幻觉），需增强音频理解能力以支撑可靠思考。

**未来方向**：alignment-free 强化学习（RLHF for audio）推高性能上限；知识蒸馏加速推理以支持实时部署。

**适用边界（批判性）**：MiMo-Audio 的少样本泛化**不**由"规模/无损"自动保证——其优势取决于预训练数据是否跨越了临界阈值（约 0.7T tokens）。在阈值之前性能可忽略不计，这说明"无损压缩 + 大规模"是必要但非充分条件。此外 thinking 机制的双面性（提升语音理解但损害声音/音乐理解）揭示了一个张力：**推理能力与感知保真度之间可能存在 trade-off**——模型在"思考"时引入的幻觉对非语音音频反而有害。可懂度上仍略逊于重度工程化的多阶段专有系统，说明端到端简洁性的代价在"对超大规模高质量标注的依赖转移到了架构/数据配比上"。
