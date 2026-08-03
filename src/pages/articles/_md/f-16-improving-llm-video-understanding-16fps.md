---
title: "Improving LLM Video Understanding with 16 Frames Per Second"
source:
  type: "论文解读"
  project: "ByteDance"
  url: "https://arxiv.org/abs/2503.13956"
  pdf: "/vibe-reading/papers/f-16-improving-llm-video-understanding-16fps.pdf"
date: "2026-08-03T20:00:00+08:00"
category: [AI, Models, Multimodal, Papers]
tags: ["F-16", "Video LLM", "High Frame Rate", "Video Understanding", "LLaVA-OneVision", "SigLIP", "Qwen2", "Token Compression", "Variable Frame Rate", "Sports Understanding", "SOTA", "ICML 2025"]
description: "目的：突破视频 LLM ≤2 FPS 的帧率瓶颈，用 16 FPS 捕捉快速运动细节。手段：高帧率 aligner（3 层 MLP 压缩 w 帧/窗口）+ 块矩阵分解从图像 LLM 初始化 + 空间 2×2 池化实现 ~4× token 压缩 + 可变帧率解码（帧重复/参数裁剪）。结论：7B 模型在 Video-MME（65.0）、TemporalBench（37.2）、MotionBench（54.5）达 SOTA，体育任务超越 GPT-4o 和 Gemini-1.5-Pro。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/f-16-improving-llm-video-understanding-16fps.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Improving LLM Video Understanding with 16 Frames Per Second](https://arxiv.org/abs/2503.13956) · **作者** Yixuan Li, Zhaoyang Liu, Chen-Wei Xie, Xizhou Zhu, Jiankai Chen, Xiangyu Yue, Lewei Lu, Yu Qiao · **发表** ICML 2025 · **项目** [github.com/LLaVA-VL/F-16](https://github.com/LLaVA-VL/F-16) · **解读** 2026-08-03

## 1. 论文概览

视频大语言模型普遍采用 **≤2 FPS** 的低帧率采样——这足以描述"谁在哪里做什么"，却无法捕捉体操翻腾、足球射门、篮球快攻等快速运动中的细节。根本矛盾在于：帧率越高，视觉 token 越多，推理成本与训练显存随帧数线性膨胀。

F-16 是**首个高帧率视频 LLM**，将采样帧率提升至 **16 FPS**，同时通过高帧率 aligner 与空间池化将视觉 token 压缩到与低帧率模型可比的水平。其核心贡献有三：

1. **高帧率 aligner**：3 层 MLP（两层线性 + GELU），将每 $w$ 帧的特征压缩为一个 token，实现 $w$ 倍时序压缩。
2. **块矩阵分解初始化**：从预训练图像 LLM（LLaVA-OneVision）的 aligner 权重分解出高帧率 aligner 的初始权重，继承图像理解能力。
3. **可变帧率解码**：推理时通过帧重复（training-free）或参数裁剪降低 aligner 的窗口大小 $w$，在不重训的情况下适配不同帧率需求。

**Take-home**：高帧率并非简单"多采样几帧"——直接堆叠高帧率 token 会导致训练不稳定且推理昂贵。F-16 证明了通过 aligner 压缩 + 空间池化 + 块矩阵分解初始化，可以在 token 开销与低帧率模型相当的前提下，让 7B 模型在体育等快速运动任务上**超越 GPT-4o 和 Gemini-1.5-Pro**。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Video Large Language Models (Video LLMs) are increasingly optimized for richer frame rates to better capture fast-motion events. However, increased frame rates present a significant challenge for efficient training and inference by substantially expanding the number of visual tokens. In this work, we introduce F-16, the first high-frame-rate Video LLM that encodes videos at 16 FPS. Central to F-16 is a high-frame-rate aligner that compresses visual tokens from $w$ frames into one token, followed by a spatial pooling layer to reduce the token count further. We employ block matrix decomposition to initialize the high-frame-rate aligner from a pre-trained image LLM, effectively preserving its image understanding capabilities. Our experiments show that F-16, built on a 7B LLM, achieves state-of-the-art performance among 7B Video LLMs across general video understanding (Video-MME, MVBench, EgoSchema), temporal understanding (TemporalBench), and motion understanding (MotionBench). Notably, F-16 outperforms GPT-4o and Gemini-1.5-Pro on sports-related tasks, including gymnastics, diving, NBA, and soccer. Furthermore, we introduce a variable frame rate decoding method that allows F-16 to dynamically adjust its frame rate during inference, enabling a smooth trade-off between performance and efficiency.

> **译：** 视频大语言模型（Video LLM）正越来越多地通过提升帧率来更好地捕捉快速运动事件。然而帧率提升会大幅增加视觉 token 数量，对高效训练和推理构成挑战。本工作提出 F-16，首个以 16 FPS 编码视频的高帧率 Video LLM。F-16 的核心是一个高帧率 aligner，将 $w$ 帧的视觉 token 压缩为一个 token，后接空间池化层进一步减少 token 数量。我们采用块矩阵分解从预训练图像 LLM 初始化高帧率 aligner，有效保留其图像理解能力。实验表明，基于 7B LLM 的 F-16 在通用视频理解（Video-MME、MVBench、EgoSchema）、时序理解（TemporalBench）和运动理解（MotionBench）上均达到 7B Video LLM 的 SOTA。值得注意的是，F-16 在体操、跳水、NBA、足球等体育任务上超越 GPT-4o 和 Gemini-1.5-Pro。此外，我们提出可变帧率解码方法，允许 F-16 在推理时动态调整帧率，实现性能与效率之间的平滑权衡。

</details>

## 2. 研究背景

### 2.1 问题定义

视频 LLM 的帧率-精度-成本三角矛盾：

| 维度 | 低帧率（≤2 FPS） | 高帧率（16 FPS） |
|------|-----------------|-----------------|
| **运动捕捉** | 快速动作丢帧（体操、球类） | 完整捕捉运动轨迹 |
| **Token 数量** | 可控（如 32 帧 = 32×256 token） | 爆炸（110s = 1760 帧 = 1760×256 token） |
| **训练成本** | 低 | 高，且易不稳定 |
| **推理延迟** | 低 | 高 |

### 2.2 现有方法的局限

| 方向 | 代表方法 | 局限 |
|------|---------|------|
| 低帧率采样 | LLaVA-Video, Qwen2.5-VL | 快速运动信息丢失 |
| Token 压缩 | TokenPacker, LLaVA-PruMerge | 在低帧率模型上压缩，未解决帧率瓶颈 |
| 高帧率直接训练 | 无 | token 爆炸，训练不稳定 |

关键矛盾：现有 token 压缩方法都是"先低帧率采样再压缩"，而非"先高帧率采样再压缩"。F-16 首次提出在 aligner 阶段同时完成高帧率采样与 token 压缩。

## 3. 方法详解

### 3.1 整体架构

![Figure 1: F-16 架构对比。左：传统低帧率模型（≤2 FPS），每帧独立编码后拼接；右：F-16 高帧率模型（16 FPS），每 w 帧经 aligner 压缩为一个 token，再经空间池化。](/vibe-reading/images/articles/f-16-improving-llm-video-understanding-16fps/fig-01-architecture.png)

F-16 基于 LLaVA-OneVision 结构构建：

- **视觉编码器**：SigLIP（384×384 分辨率，每帧 256 token）
- **LLM 骨干**：Qwen2-7B
- **高帧率 aligner**：3 层 MLP，窗口大小 $w=16$
- **空间池化**：2×2 max pooling，token 数再减 4×

### 3.2 高帧率 Aligner

传统 aligner 对每帧独立编码后直接拼接。高帧率 aligner 将**连续 $w$ 帧的特征沿通道维度拼接**，再通过 MLP 压缩：

$$
\mathbf{F}_{\text{cat}} = [\mathbf{f}_1;\, \mathbf{f}_2;\, \cdots;\, \mathbf{f}_w] \in \mathbb{R}^{(w \cdot d) \times N}
$$

其中 $\mathbf{f}_i$ 为第 $i$ 帧经视觉编码器后的特征，$d$ 为单帧特征维度，$N$ 为每帧 token 数。

$$
\mathbf{h} = \text{GELU}(\mathbf{W}_2 \cdot \text{GELU}(\mathbf{W}_1 \cdot \mathbf{F}_{\text{cat}} + \mathbf{b}_1) + \mathbf{b}_2)
$$

aligner 输出 $\mathbf{h}$ 将 $w$ 帧压缩为 1 个 token 序列，维度恢复到 $d \times N$。以 $w=16$ 为例，16 帧的特征被压缩为 1 帧等价长度的 token。

### 3.3 Aligner 结构对比

![Figure 2: Aligner 对比。左：单帧 aligner（传统），每帧独立经过 MLP；右：高帧率 aligner，w 帧拼接后经 MLP 压缩为一个 token。](/vibe-reading/images/articles/f-16-improving-llm-video-understanding-16fps/fig-02-aligner-comparison.png)

### 3.4 块矩阵分解初始化

高帧率 aligner 从零训练困难——需要大量数据学习时序压缩。F-16 利用预训练图像 LLM（LLaVA-OneVision）的单帧 aligner 权重进行分解初始化。

设预训练 aligner 的第一层权重为 $\mathbf{W}_1^{\text{img}} \in \mathbb{R}^{d \times d}$。高帧率 aligner 的第一层权重 $\mathbf{W}_1 \in \mathbb{R}^{d \times (w \cdot d)}$ 通过块矩阵分解构造：

$$
\mathbf{W}_1 = \underbrace{[\mathbf{W}_1^{\text{img}},\, \mathbf{W}_1^{\text{img}},\, \cdots,\, \mathbf{W}_1^{\text{img}}]}_{w \text{ blocks}} \cdot \text{diag}(\mathbf{s}_1, \mathbf{s}_2, \cdots, \mathbf{s}_w)
$$

每个块初始化为 $\mathbf{W}_1^{\text{img}}$，乘以可学习的缩放因子 $\mathbf{s}_i$。第二层同理。这一初始化策略使高帧率 aligner 在训练初期就具备单帧理解能力，仅需学习时序融合。

### 3.5 空间池化

aligner 输出后接 2×2 max pooling，将每帧的 $N$ 个 token 压缩为 $N/4$ 个。结合 aligner 的 $w$ 倍时序压缩，总压缩比为 $4w$（$w=16$ 时为 64×）。

**池化位置至关重要**：消融显示，post-pooling（aligner 后池化）在 Video-MME 上达 65.0，而 pre-pooling（aligner 前池化）仅 60.8。原因是 aligner 需要在完整空间分辨率上融合多帧信息，先池化会丢失细粒度空间特征。

### 3.6 可变帧率解码

F-16 训练时使用 $w=16$（16 FPS），推理时可动态降低帧率：

- **帧重复法**（training-free）：将每帧重复 $k$ 次后输入 aligner，等效窗口大小变为 $w/k$。例如每帧重复 2 次，则 16 FPS 降为 8 FPS，token 数减半。
- **参数裁剪法**：直接裁剪 aligner 权重的对应块，将 $w=16$ 的 aligner 转为 $w=8$ 或 $w=4$，无需重训。

两种方法均可实现帧率-性能的平滑权衡。

## 4. 关键公式解读

### 4.1 帧编码

$$
\mathbf{f}_t = \text{Encoder}(\mathbf{x}_t), \quad t = 1, 2, \cdots, T
$$

视频以 16 FPS 采样 $T$ 帧，每帧 $\mathbf{x}_t$ 经 SigLIP 编码为特征 $\mathbf{f}_t \in \mathbb{R}^{d \times N}$。

### 4.2 高帧率 Aligner 输出

$$
\mathbf{h}_j = \text{Aligner}(\mathbf{f}_{(j-1)w+1},\, \mathbf{f}_{(j-1)w+2},\, \cdots,\, \mathbf{f}_{jw}), \quad j = 1, \cdots, T/w
$$

每 $w$ 帧经 aligner 压缩为 1 组 token $\mathbf{h}_j$，$T/w$ 组 token 组成压缩后的视觉序列。

### 4.3 LLM 响应

$$
\hat{Y} = \arg\max_Y P(Y \mid \text{LLM}([\mathbf{H}_{\text{pool}};\, \mathbf{P}_{\text{text}}]))
$$

池化后的视觉 token $\mathbf{H}_{\text{pool}}$ 与文本 prompt token $\mathbf{P}_{\text{text}}$ 拼接后输入 LLM，生成响应 $\hat{Y}$。

## 5. 实验设置

### 5.1 模型规格

| 组件 | 规格 |
|------|------|
| **视觉编码器** | SigLIP-SO400M，384×384，每帧 256 token |
| **LLM** | Qwen2-7B-Instruct |
| **Aligner** | 3 层 MLP（线性→GELU→线性→GELU），$w=16$ |
| **空间池化** | 2×2 max pooling（post-aligner） |
| **最大帧数** | 1760 帧（110s @ 16 FPS） |
| **总 token 压缩** | 64×（$w=16$ × 4× 池化） |

### 5.2 训练数据与流程

| 阶段 | 数据 | 训练对象 |
|------|------|---------|
| **Stage 1：Aligner 预训练** | 图像-文本对（LLaVA-OneVision 数据） | Aligner + 池化层 |
| **Stage 2：视频微调** | 视频-文本对（含高帧率标注） | Aligner + 池化层 + LoRA |

### 5.3 评价基准

| 类别 | 基准 |
|------|------|
| 通用视频理解 | Video-MME, MVBench, EgoSchema |
| 时序理解 | TemporalBench |
| 运动理解 | MotionBench |
| 体育专项 | 体操（acc）、跳水（acc）、NBA（F1）、足球（F1） |

## 6. 实验结果

### 6.1 通用视频理解

| Model | Video-MME (avg) | MVBench | EgoSchema |
|-------|----------------|---------|-----------|
| LLaVA-OneVision-7B | 60.8 | 67.0 | 60.4 |
| Qwen2.5-VL-7B | 65.1 | 73.3 | 66.3 |
| **F-16 (7B)** | **65.0** | **75.2** | **66.8** |
| GPT-4o | 71.9 | - | - |
| Gemini-1.5-Pro | 75.0 | - | - |

F-16 在 7B 模型中达到 Video-MME SOTA（65.0），在 MVBench 和 EgoSchema 上也领先。虽仍低于 GPT-4o 和 Gemini-1.5-Pro 等大模型，但差距已很小。

### 6.2 时序与运动理解

| Model | TemporalBench | MotionBench |
|-------|--------------|-------------|
| LLaVA-OneVision-7B | 33.4 | 48.7 |
| Qwen2.5-VL-7B | 35.1 | 52.0 |
| **F-16 (7B)** | **37.2** | **54.5** |
| GPT-4o | 37.9 | 53.8 |

F-16 在 TemporalBench 和 MotionBench 上均达 7B SOTA，**MotionBench 甚至超越 GPT-4o**（54.5 vs 53.8）——高帧率带来的运动细节捕捉优势在这类基准上尤为突出。

### 6.3 体育专项任务

![Figure 3: 可变帧率分析。左：不同帧率下的性能与推理时间；右：帧重复法与参数裁剪法的性能对比。](/vibe-reading/images/articles/f-16-improving-llm-video-understanding-16fps/fig-03-variable-framerate.png)

| Model | 体操 (acc) | 跳水 (acc) | NBA (F1) | 足球 (F1) |
|-------|-----------|-----------|----------|----------|
| GPT-4o | 58.3 | 82.1 | 88.5 | 52.0 |
| Gemini-1.5-Pro | 61.7 | 84.3 | 90.1 | 54.6 |
| **F-16 (7B)** | **64.1** | **86.5** | **92.9** | **57.7** |

F-16 在全部四项体育任务上**超越 GPT-4o 和 Gemini-1.5-Pro**——7B 模型击败顶级闭源模型，这在视频理解领域极为罕见。高帧率（16 FPS）是关键：体操翻腾和跳水动作在 2 FPS 下仅 1-2 帧，几乎无法分析。

### 6.4 可变帧率

Figure 3 展示了帧重复法和参数裁剪法在不同帧率下的表现：

- **帧重复法**：从 16 FPS 降到 8 FPS 时性能几乎无损，降到 4 FPS 时在体育任务上退化明显
- **参数裁剪法**：整体趋势与帧重复法一致，在部分任务上略优
- **推理时间**：帧率每减半，推理时间近似减半

## 7. 消融实验

### 7.1 池化策略

| 池化位置 | 池化方式 | Video-MME |
|---------|---------|-----------|
| Pre-pooling | 2×2 max pool | 60.8 |
| Post-pooling | 2×2 max pool | **65.0** |
| Post-pooling | 2×2 avg pool | 63.7 |

Post-pooling 显著优于 pre-pooling（+4.2），max pooling 优于 avg pooling（+1.3）。这说明 aligner 需在完整空间分辨率上融合多帧信息。

### 7.2 窗口大小

| 窗口 $w$ | 等效帧率 | Video-MME | 体育 avg |
|----------|---------|-----------|---------|
| 1 | 16 FPS（无压缩） | 62.1 | 68.2 |
| 8 | 2 FPS | 64.3 | 72.1 |
| **16** | 1 FPS | **65.0** | **75.3** |
| 32 | 0.5 FPS | 63.8 | 71.4 |

$w=16$ 最优。$w=1$（无压缩）最差——直接堆叠 16 FPS 的 token 训练不稳定，证明 aligner 压缩的必要性。

### 7.3 块矩阵分解初始化

| 初始化方式 | Video-MME | 体育 avg |
|-----------|-----------|---------|
| 随机初始化 | 61.2 | 66.8 |
| 复制初始化 | 63.5 | 70.1 |
| **块矩阵分解** | **65.0** | **75.3** |

块矩阵分解大幅优于其他初始化方式（体育 +5.2），验证了从图像 LLM 继承先验知识的重要性。

### 7.4 余弦相似度分析

论文通过分析 aligner 输出 token 与对应帧原始特征的余弦相似度，发现 max pooling 会**抑制细粒度空间特征**——池化后 token 与原始特征的相似度下降，且运动越快的区域下降越明显。这解释了为何 pre-pooling 性能较差：空间细节在 aligner 融合前就已被丢弃。

## 8. 总结与展望

### 贡献总结

F-16 首次将视频 LLM 的采样帧率提升至 16 FPS，通过高帧率 aligner（$w$ 帧压缩为 1 token）、块矩阵分解初始化和空间池化，在 token 开销与低帧率模型相当的前提下实现了高帧率理解。7B 模型在体育任务上超越 GPT-4o 和 Gemini-1.5-Pro，在通用与时序基准上达 7B SOTA。可变帧率解码进一步提供了推理时的效率-性能权衡。

### 局限性（批判性）

1. **110s 上限**：最大处理 1760 帧（110s），长视频仍需分段处理。
2. **体育偏向**：高帧率的优势集中在快速运动场景，对静态场景（如监控、讲座）的增益有限。
3. **压缩信息损失**：$w=16$ 的时序压缩不可避免地损失部分帧间细节，余弦相似度分析已揭示 max pooling 对细粒度特征的抑制。

### 未来方向（创造性，idea 三法）

- **弥补缺陷**：引入自适应窗口大小——对运动剧烈片段用小 $w$（高帧率保真），对静态片段用大 $w$（高效压缩），实现内容感知的动态压缩。
- **新型方案**：将 aligner 从固定 MLP 替换为轻量时序 Transformer（如 2 层），用注意力替代拼接实现帧间交互，可能更好地保留运动细节。
- **减少约束**：将块矩阵分解初始化推广到其他模态适配器（如音频、深度图），验证其作为通用跨模态迁移工具的潜力。
