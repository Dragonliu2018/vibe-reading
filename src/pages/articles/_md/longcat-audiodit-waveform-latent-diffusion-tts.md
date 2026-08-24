---
title: "LongCat-AudioDiT: High-Fidelity Diffusion Text-to-Speech in the Waveform Latent Space"
source:
  type: "论文解读"
  project: "LongCat"
  url: "https://github.com/meituan-longcat/LongCat-AudioDiT"
  pdf: "/vibe-reading/papers/longcat-audiodit-waveform-latent-diffusion-tts.pdf"
date: "2026-07-26"
category: [AI, Models, Audio Model, Papers]
tags: ["LongCat-AudioDiT", "TTS", "Diffusion", "Wav-VAE", "Flow Matching", "Zero-shot Voice Cloning"]
description: "目的：高保真扩散 TTS。手段：直接在波形隐空间建模（Wav-VAE + DiT），修正训练-推理失配，用 APG 替代 CFG。结论：Seed 基准 SOTA，SIM 0.818（ZH）/0.797（Hard），超越 Seed-TTS。"
readingTime: "16 min"
aiModel: "Claude Opus 4.8"
reviewed: false
pinned: true
---

> **PDF** <a href="/vibe-reading/papers/longcat-audiodit-waveform-latent-diffusion-tts.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LongCat-AudioDiT: High-Fidelity Diffusion Text-to-Speech in the Waveform Latent Space](https://github.com/meituan-longcat/LongCat-AudioDiT) · **作者** Meituan LongCat Team（Detai Xin, Shujie Hu, Chengzuo Yang 等）· **发表** 2026-03 · **项目** https://github.com/meituan-longcat/LongCat-AudioDiT · **解读** 2026-07-26

---

## 1. 论文概览

**一句话**：LongCat-AudioDiT 把扩散 TTS 的建模目标从"中间表示（mel-spectrogram）"换到"波形隐空间"——**端到端只用 Wav-VAE + DiT 两个组件**，既消除级联误差，又省掉辅助 vocoder。

- **任务**：非自回归（NAR）扩散式文本到语音合成（TTS），含零样本语音克隆。
- **核心创新**：直接在波形隐空间建模 + 两项推理改进——(1) 识别并修正长期被忽视的 **训练-推理失配**；(2) 用 **Adaptive Projection Guidance (APG)** 替代 CFG 提升生成质量。
- **结果**：LongCat-AudioDiT-3.5B 在 Seed 基准上 **SIM 0.818（Seed-ZH）、0.797（Seed-Hard）**，超越前 SOTA Seed-TTS（0.809 / 0.776），且无需复杂多阶段训练或高质量人工标注数据。代码与权重开源。

**take-home**：在扩散 TTS 里，"建模目标的表示空间"比"堆叠多阶段流程"更重要——直接在波形隐空间生成，让脆弱的高频细节（零样本克隆音色的关键）不再被中间转换损失掉。更反直觉的是，**Wav-VAE 重建保真度越高，TTS 整体质量未必越好**——表示学习与生成建模之间存在非平凡的权衡。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We present LongCat-AudioDiT, a novel, non-autoregressive diffusion-based text-to-speech (TTS) model that achieves state-of-the-art (SOTA) performance. Unlike previous methods that rely on intermediate acoustic representations such as mel-spectrograms, the core innovation of LongCat-AudioDiT lies in operating directly within the waveform latent space. This approach effectively mitigates compounding errors and drastically simplifies the TTS pipeline, requiring only a waveform variational autoencoder (Wav-VAE) and a diffusion backbone. Furthermore, we introduce two critical improvements to the inference process: first, we identify and rectify a long-standing training-inference mismatch; second, we replace traditional classifier-free guidance with adaptive projection guidance to elevate generation quality. Experimental results demonstrate that, despite the absence of complex multi-stage training pipelines or high-quality human-annotated datasets, LongCat-AudioDiT achieves SOTA zero-shot voice cloning performance on the Seed benchmark while maintaining competitive intelligibility. Specifically, our largest variant, LongCat-AudioDiT-3.5B, outperforms the previous SOTA model (Seed-TTS), improving the speaker similarity (SIM) scores from 0.809 to 0.818 on Seed-ZH, and from 0.776 to 0.797 on Seed-Hard. Finally, through comprehensive ablation studies and systematic analysis, we validate the effectiveness of our proposed modules. Notably, we investigate the interplay between the Wav-VAE and the TTS backbone, revealing the counterintuitive finding that superior reconstruction fidelity in the Wav-VAE does not necessarily lead to better overall TTS performance. Code and model weights are released to foster further research within the speech community.

> **译：** 我们提出 LongCat-AudioDiT，一种新颖的非自回归扩散式文本到语音（TTS）模型，达到 SOTA 性能。不同于以往依赖 mel-spectrogram 等中间声学表示的方法，LongCat-AudioDiT 的核心创新在于**直接在波形隐空间内操作**——这一方法有效缓解级联误差、极大简化 TTS 流水线，只需一个波形变分自编码器（Wav-VAE）和一个扩散主干。此外我们引入两项关键推理改进：其一，识别并修正一个长期存在的训练-推理失配；其二，用自适应投影引导（APG）替代传统 classifier-free guidance 以提升生成质量。实验表明，LongCat-AudioDiT 在不依赖复杂多阶段训练流水线或高质量人工标注数据集的情况下，在 Seed 基准上取得 SOTA 零样本语音克隆性能并保持有竞争力的可懂度。具体地，我们最大的变体 LongCat-AudioDiT-3.5B 超越前 SOTA 模型（Seed-TTS），将 Seed-ZH 的说话人相似度（SIM）从 0.809 提升到 0.818，Seed-Hard 从 0.776 提升到 0.797。最后，通过综合消融与系统分析，我们验证了所提模块的有效性。值得注意的是，我们研究了 Wav-VAE 与 TTS 主干之间的相互作用，揭示了一个反直觉的发现：Wav-VAE 更高的重建保真度未必带来更好的整体 TTS 性能。代码与模型权重已开源。

</details>

## 2. 研究背景

TTS 的两条主流生成范式——自回归（AR）与非自回归（NAR）——都已逼近人类自然度。其中 **NAR 扩散式 TTS** 在生成质量、架构简洁性与推理效率上优势突出：直接在连续声学表示上操作、绕过离散音频 tokenizer；整段语音并行生成，随序列变长相对 AR 速度优势更明显。

但 SOTA 榜单长期被 **AR/NAR 混合架构**主导（如 Seed-TTS、CosyVoice 等）。一个例外是 Seed-DiT 的扩散变体据称在 Seed 框架内超越其混合对应物 Seed-ICL，但其架构细节未公开——**"如何构造一个高性能的纯扩散 TTS 系统"仍是开放问题**。

LongCat-AudioDiT 正面回答这个问题，核心论点落在**隐表示的选择**上：

| 隐表示 | 做法 | 问题 |
|---|---|---|
| 原始 mel-spectrogram | 多数扩散 TTS 的建模目标 | 需辅助 vocoder 反演回波形，存在级联误差 |
| Mel-VAE（DiTTo-TTS） | 用 VAE 把 mel 压到更低维加速推理 | 仍是 mel 域，latent→mel→waveform 多级转换仍有级联误差 |
| **Wav-VAE（本文）** | 直接把原始波形编码进连续隐空间 | 统一声学建模与波形生成，**绕过中间转换** |

**关键观察**：mel-spectrogram 固有地丢弃相位与高频细节，而这些细节正是零样本语音克隆音色保真的关键——在 latent→mel→waveform 的级联转换里它们"脆弱且易失"。Wav-VAE 用连续 VAE 表示保留这些细节同时压缩冗余，是更高保真生成的潜力所在。

> **缺口**：现有范式要么依赖中间表示、要么级联多阶段——尚无系统工作验证"直接在波形隐空间端到端建模"能否达到 SOTA。LongCat-AudioDiT 即补此缺口。

## 3. 方法详解

LongCat-AudioDiT = **Wav-VAE**（波形变分自编码器）+ **DiT 主干**（扩散 Transformer），两组件端到端协同。

![Figure 1：LongCat-AudioDiT 概览。直接生成连续波形隐变量，避免预测再转换中间表示（如 mel-spectrogram）为波形时固有的级联误差。](/vibe-reading/images/articles/longcat-audiodit-waveform-latent-diffusion-tts/fig-01-overview-compounding-errors.png)

### 3.1 Wav-VAE：波形域连续隐空间

Wav-VAE 是全卷积音频自编码器，把原始波形 $x \in \mathbb{R}^{1 \times T}$ 经编码器 $E$ 压成隐序列 $z \in \mathbb{R}^{D \times (T/R)}$（$D$ 为隐维度、$R$ 为时间下采样因子），再由解码器 $D$ 重建 $\hat{x} = D(z)$。

- **编码器**：1D 卷积投影到高维特征 → $N$ 个级联 Oobleck block，每块步长 $s_i$ 降时间分辨率、扩通道 $C_i \to C_{i+1}$，累计下采样比 $R = \prod_{i=1}^N s_i$。块内用带 Snake 激活的膨胀残差单元捕捉多尺度时间依赖。
- **非参数 shortcut**：为在激进下采样下稳定训练，每块加一条 space-to-channel 重整的无参数旁路（把时间维折进通道再做 channel-wise averaging），建立绕过非线性主干的线性残差通路。
- **VAE 瓶颈**：投影到目标隐维度 $D$ 后产出 $\mu$ 与 $\log \sigma^2$，用重参数化 $z = \mu + \sigma \odot \epsilon$ 采样。
- **解码器**：编码器的镜像（channel-to-space 上采样 + 对称 shortcut）。

**训练目标**（两阶段对抗训练，含 warmup 阶段先关对抗项稳住重建）：

$$
\mathcal{L}_{\text{gen}} = \lambda_{\text{spec}}\mathcal{L}_{\text{spec}} + \lambda_{\text{mel}}\mathcal{L}_{\text{mel}} + \lambda_{\text{time}}\mathcal{L}_{\text{time}} + \lambda_{\text{KL}}\mathcal{L}_{\text{KL}} + \lambda_{\text{adv}}\mathcal{L}_{\text{adv}} + \lambda_{\text{fm}}\mathcal{L}_{\text{fm}}
$$

其中 $\mathcal{L}_{\text{spec}}$（多分辨率 STFT）、$\mathcal{L}_{\text{mel}}$（多尺度 mel）、$\mathcal{L}_{\text{time}}$（L1 时域）、$\mathcal{L}_{\text{KL}}$（KL 散度规整到标准高斯），后两项来自多尺度 STFT 判别器的对抗损失与 feature matching。

### 3.2 DiT 主干：CFM + 双嵌入文本编码

TTS 主干采用 **Conditional Flow Matching (CFM)** 把生成过程建模为 ODE $dz_t = v_t\,dt$，确定性地把高斯噪声 $z_0$ 沿速度场 $v_t$ 传输到目标语音隐变量 $z_1$。架构基于 **Diffusion Transformer (DiT)**：

![Figure 2：LongCat-AudioDiT 架构。中：整体架构；左：DiT block 结构（AdaLN 注入 timestep、cross-attention 学文本-语音对齐）；右：文本编码器（UMT5 last hidden state + raw word embedding 双路融合 + ConvNeXt v2 精炼）。](/vibe-reading/images/articles/longcat-audiodit-waveform-latent-diffusion-tts/fig-02-architecture-dit-text-encoder.png)

- **DiT block**：标准 Transformer 主干 + **Adaptive LayerNorm (AdaLN)** 注入 timestep $t$；QK-Norm（RMSNorm）稳定训练；cross-attention 隐式学文本-语音对齐；RoPE 注入所有 attention 层。还集成 DiTTo-TTS 的 **long-skip connection**（输入直加到末层）与 **global AdaLN**（共享全局块替代逐层 AdaLN，省参数不降质）。
- **REPA**：用 Representation Alignment 把 DiT 第 8 层输出对齐到预训练 mHuBERT 的自监督语义空间——**不提升生成质量但显著加速收敛**。
- **多语言文本编码**：选 **UMT5-base**（支持 107 语言、子词分词器序列长度合理，规避 ByT5 字节级对中文过长的问题）。关键设计——**双嵌入融合**：仅用 last hidden state 可懂度差（高层语义抽象掉了低层词法/音素线索），故融合最后一层隐状态与原始词嵌入：

$$
q = \text{LayerNorm}(\text{last\_hidden\_state}) + \text{LayerNorm}(\text{raw\_word\_embedding})
$$

非参数 LayerNorm 平衡两表示空间的尺度再相加。该策略模型无关、可推广到其他多语言大模型。文本表示 $q$ 再过一个 ConvNeXt v2 轻量卷积精炼模块加速对齐收敛。

### 3.3 两项推理改进

**(1) 修正训练-推理失配**（§4.3 详述）：推理时 prompt 区的 noisy latent 因无损失约束而漂移，偏离训练时的真值轨迹——论文每步用真值强行覆盖。

**(2) APG 替代 CFG**（§4.4 详述）：大 CFG scale 引发 oversaturation 类伪影，APG 把引导残差分解为平行/正交分量、抑制平行分量以消伪影。

## 4. 关键公式解读

**(1) 线性插值构造 noisy latent**（rectified flow）——训练时的真值轨迹：

$$
z_t = (1 - t)\,z_0 + t\,z_1
$$

**(2) CFM 优化目标**——只在被 mask 的目标区域算速度预测误差：

$$
\mathcal{L}_{\text{CFM}} = \mathbb{E}_{t, m, z_0, z_1}\!\left[(1 - m) \odot \left[(z_1 - z_0) - v(z_t, t, z_{\text{ctx}}, q;\, \theta_{\text{CFM}})\right]^2\right]
$$

其中 $m$ 为构造 $z_{\text{ctx}}$（随机遮蔽连续 span 得到的音频上下文 prompt）的二值掩码；训练时以 10% 概率同时丢弃 $z_{\text{ctx}}$ 与 $q$ 以学无条件分布、支持 CFG。

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

- **数据**：Wav-VAE 用 20 万小时中英文（切片约 3 秒）；DiT 基线/消融用 10 万小时，大规模扩展到 100 万小时；全部 24 kHz 采样，最长 60 秒。转录由语音识别模型生成（非人工标注）。
- **模型规模**：Wav-VAE 157M 参数（32×H800，batch 384），默认隐维度 64、帧率 11.72 Hz。DiT 两个变体——1B（16 GPU，batch 256）与 3.5B（64 GPU，batch 1024）；AdamW（β₁=0.9, β₂=0.95），线性 LR 衰减 1e-4→1e-5（1K warmup）。
- **评价指标**：
  - Wav-VAE 重建：PESQ（感知质量）、STOI（可懂度）。
  - TTS 生成四维——可懂度（CER/WER，英文 Whisper-large-v3、中文 Paraformer）、说话人相似度（SIM，WavLM 提取说话人嵌入余弦相似）、自然度（UTMOS）、整体声学质量（DNSMOS）。
- **推理**：Euler 法解 ODE，**16 步 NFE**。

## 6. 实验结果

### 6.1 主结果（Table 1，Seed 基准）

LongCat-AudioDiT 在 SIM 上尤其突出，Seed-ZH 与 Seed-Hard 创 SOTA，Seed-EN 第二：

| 模型 | 类型 | ZH CER↓ | ZH SIM↑ | EN WER↓ | EN SIM↑ | ZH-Hard SIM↑ |
|---|---|---|---|---|---|---|
| GT | — | 1.26 | 0.755 | 2.14 | 0.734 | — |
| Seed-DiT | NAR | 1.18 | 0.809 | 1.73 | 0.790 | — |
| F5-TTS | NAR | 1.56 | 0.741 | 1.83 | 0.647 | 8.67 |
| Seed-ICL | Hybrid | 1.12 | 0.796 | 2.25 | 0.762 | 7.59 |
| MiniMax-Speech | Hybrid | 0.99 | 0.799 | 1.90 | 0.738 | — |
| CosyVoice3.5 | Hybrid | 0.87 | 0.797 | 1.57 | 0.738 | 5.71 |
| VoxCPM | AR | 0.93 | 0.772 | 1.85 | 0.729 | 8.87 |
| **LongCat-AudioDiT-1B** | NAR | 1.18 | 0.812 | 1.78 | 0.762 | 6.33 |
| **LongCat-AudioDiT-3.5B** | NAR | 1.09 | **0.818** | 1.50 | 0.786 | **0.797** |

**关键发现**：相比 Seed-DiT，SIM 在 Seed-ZH 从 0.809→0.818、Seed-Hard 从 0.776→0.797（注：Seed-Hard SIM 取自 Table 1 EN/Hard 列对照）。更重要的是——**端到端框架决定性地超越所有依赖 mel-spectrogram 的扩散基线**（如 F5-TTS），强证核心假设：直接在波形隐空间建模有效绕过级联误差、提升克隆保真度。

可懂度（CER/WER）方面，LongCat-AudioDiT 在开源基线中有竞争力；略逊于重度工程化的专有系统（Qwen3-TTS、CosyVoice3.5），但那些依赖复杂多阶段训练与海量人工标注——**LongCat-AudioDiT 以极简端到端架构、单阶段训练达到此性能**。

### 6.2 Wav-VAE 重建质量（Table 2，LibriTTS）

| 模型 | 类型 | Nq | FPS | PESQ↑ | STOI↑ | UTMOS↑ |
|---|---|---|---|---|---|---|
| GT | — | – | – | 4.644 | 1.0 | 4.056 |
| DAC | 离散 | 9 | 900 | 3.908 | 0.970 | 3.910 |
| WavTokenizer | 离散 | 1 | 75 | 2.373 | 0.914 | 4.049 |
| VibeVoice | 连续 VAE | 1 | 7.50 | 3.068 | 0.828 | 4.181 |
| **Ours Wav-VAE** | 连续 VAE | 1 | 7.81 | 3.089 | 0.963 | 4.116 |
| **Ours Wav-VAE** | 连续 VAE | 1 | 11.72 | **3.237** | **0.967** | 4.013 |

同等帧率下，本文 Wav-VAE 重建保真度优于 VibeVoice 的 Wav-VAE；相比 SOTA 离散 codec，连续 Wav-VAE 在多数声学质量指标上更优且**序列长度大幅更短**——印证连续隐表示相对离散 token 的容量与表达效率优势。

## 7. 消融实验

论文围绕三个研究问题（RQ1–RQ3）系统消融。

### RQ1：Wav-VAE vs Mel-VAE（Table 3）

| TTS 隐表示模型 | ZH CER↓ | ZH SIM↑ | EN WER↓ | EN SIM↑ | ZH-Hard SIM↑ |
|---|---|---|---|---|---|
| Mel-VAE | 1.29 | 0.706 | 2.20 | 0.714 | 0.696 |
| **Wav-VAE** | **1.18** | **0.812** | **1.78** | **0.762** | **0.787** |

Wav-VAE 全面显著优于 Mel-VAE，**SIM 提升尤其剧烈**。这精准印证假设：零样本克隆所需的细粒度高频声学细节，在 latent→mel→waveform 的级联转换里本就脆弱、易失——直接波形隐空间建模保住了它们。

### RQ2：Wav-VAE 重建 vs TTS 生成的非平凡关系（反直觉，Figure 3 & 4）

论文训练多个不同隐维度 $\{64, 128, 256\}$ 与帧率 $\{7.81, 11.72, 23.44\}$ Hz 的 Wav-VAE，并为每个 VAE 配一个 TTS 主干，分四组对应指标对比（intelligibility / similarity / naturalness / quality 的 VAE 版 vs TTS 版）：

![Figure 3：不同隐维度下 Wav-VAE 重建与 TTS 生成的对比。随隐维度增大，VAE 重建持续改善但 TTS 生成反而退化——直接挑战"更好 VAE 必带来更好 TTS"的朴素假设。](/vibe-reading/images/articles/longcat-audiodit-waveform-latent-diffusion-tts/fig-03-latent-dim-ablation.png)

![Figure 4：不同帧率下 Wav-VAE 重建与 TTS 生成的对比。低帧率改善 VAE 的可懂度与自然度但损害相似度与质量；而对 TTS，低帧率反而大幅提升整体合成质量。](/vibe-reading/images/articles/longcat-audiodit-waveform-latent-diffusion-tts/fig-04-frame-rate-ablation.png)

**观察 1（维度-容量权衡）**：固定 TTS 参数预算下，**增大隐维度持续提升 Wav-VAE 重建保真度，却同时降低 TTS 生成质量**——直接证伪"更好 VAE 必带来更好 TTS"的朴素假设。论文试过把 TTS 主干扩到 3.5B、配 128 维 Wav-VAE，虽有边际 SIM 增益，整体仍劣于配 64 维 Wav-VAE 的 3.5B——说明**过高维连续隐变量给扩散主干施加的建模负担，靠堆参数也难克服**。

**观察 2（帧率甜点）**：存在最优帧率平衡 VAE 与 TTS，但两者甜点不必相同。对 Wav-VAE：低帧率反而可懂度与自然度更好（激进下采样迫使丢高频细节、保全局音素结构→伤 SIM/PESQ 但助 STOI）；对 TTS：低帧率大幅提升整体合成质量——扩散主干难精确建模高帧率隐变量间复杂、强相关的时间动态，导致生成不稳。

**综合**：论文实证锁定 **64 维、11.72 Hz 的 Wav-VAE 为最优建模目标**，作为所有 LongCat-AudioDiT 模型的默认配置。

### RQ3：推理改进的有效性（Table 4，Seed-ZH）

| 配置 | CER↓ | SIM↑ | UTMOS↑ | DNSMOS↑ |
|---|---|---|---|---|
| LongCat-AudioDiT-1B（完整） | 1.18 | 0.812 | 3.16 | 3.40 |
| 训练-推理失配（不覆盖 prompt 真值） | 1.21 | 0.769 | 2.83 | 3.34 |
| 去掉 APG（退回标准 CFG） | 1.18 | 0.812 | 3.06 | 3.38 |

- **失配修正**：完整模型显著优于不解失配的版本——SIM 从 0.769 跃到 0.812，UTMOS/DNSMOS 同步提升，证实失配确为真问题、覆盖法有效。
- **APG**：与标准 CFG 相比，CER/SIM 持平，但 UTMOS 与 DNSMOS 更优——APG 有效缓解高 scale CFG 的 oversaturation 伪影，提升感知自然度与整体声学质量（而非可懂度/克隆保真）。

## 8. 总结与展望

**贡献总结**：

1. 提出端到端扩散 TTS LongCat-AudioDiT——直接在波形隐空间建模，**消除中间声学表示引入的级联误差**，流水线简化为 Wav-VAE + DiT 两组件、无需辅助 vocoder。
2. 两项推理改进：识别并修正长期训练-推理失配（prompt 区 noisy latent 漂移）；用 APG 替代 CFG 抑制 oversaturation 伪影。
3. 系统消融给出**反直觉的实证洞察**：Wav-VAE 重建保真度与下游 TTS 生成质量存在非平凡权衡——隐维度↑未必 TTS↑；帧率甜点 VAE 与 TTS 不必一致。
4. 1B/3.5B 两变体 + 100 万小时数据训练，在 Seed 基准零样本 SIM 创 SOTA，**不依赖多阶段训练或高质量人工标注**；代码权重开源。

**idea 三法落地（未来工作）**：

- **弥补缺陷**：当前推理 16 步 NFE，实时部署受限——论文明确指向**知识蒸馏**加速推理以达实时；可懂度仍略逊重度工程化的专有系统，需更强文本-对齐建模。
- **新型方案**：用 **alignment-free 强化学习（RLHF for audio）** 推高性能上限——把人类偏好对齐从文本/视觉扩展到音频生成。
- **减少约束**：当前最优配置（64 维 / 11.72 Hz）是在 1B 参数预算下实证锁定；更大主干下维度-容量权衡是否会变化值得再探；双嵌入文本编码策略已声称模型无关，可推广到其他多语言大模型验证。

**适用边界（批判性）**：LongCat-AudioDiT 的优势**不**由"扩散/波形隐空间"自动保证，而取决于 workload 是否受益于连续表示的高频保真——RQ2 直接证明：更高维 Wav-VAE 重建更好但 TTS 更差，说明"表示容量"与"生成建模负担"是一对张力，简单堆 VAE 容量反噬生成质量。此外 APG 的收益集中在自然度/质量而非可懂度/SIM——对纯克隆保真场景，APG 的边际价值有限；可懂度上仍不及多阶段专有系统，说明端到端简洁性的代价在"对超大规模高质量标注的依赖转移到了架构/数据配比上"。

---

## 相关阅读

- [在 SGLang 中接入 LongCat-AudioDiT](/vibe-reading/articles/sglang-pr-22191-support-longcat-audiodit) — **工程实现**·本论文模型在 SGLang `multimodal_gen` 框架的落地（PR #22191），把论文里耦合在 `forward` 的 ODE/CFG/APG 拆解为框架 hooks + 标准 DenoisingStage 三段式，并新增 OpenAI 兼容 `/v1/audio/speech` API
