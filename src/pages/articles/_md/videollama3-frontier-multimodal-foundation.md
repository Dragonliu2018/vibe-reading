---
title: "VideoLLaMA 3: Frontier Multimodal Foundation Models for Image and Video Understanding"
source:
  type: "论文解读"
  project: "Alibaba"
  url: "https://arxiv.org/abs/2501.13106"
  pdf: "/vibe-reading/papers/videollama3-frontier-multimodal-foundation.pdf"
date: "2026-08-04T15:00:00+08:00"
category: [AI, Models, Multimodal, Papers]
tags: ["Vision LLM", "Multimodal", "Video Understanding", "Image Understanding", "AVT", "DiffFP", "Qwen2.5", "SigLIP", "Vision-Centric"]
description: "目的：统一图像与视频理解。手段：视觉中心四阶段训练 + AVT 动态分辨率 + DiffFP 帧压缩。结论：图像视频双模态 SOTA。"
readingTime: "14 min"
aiModel: "Claude Opus 5 (1M context)"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/videollama3-frontier-multimodal-foundation.pdf" target="_blank" rel="noopener">预览</a> · **论文** [VideoLLaMA 3: Frontier Multimodal Foundation Models for Image and Video Understanding](https://arxiv.org/abs/2501.13106) · **作者** Boqiang Zhang, Kehan Li, Zesen Cheng, Zhiqiang Hu, Yuqian Yuan 等（DAMO Academy, Alibaba Group / Hupan Lab）· **发表** arXiv 2501.13106, 2025-01 (v4: 2025-06) · **项目** https://github.com/DAMO-NLP-SG/VideoLLaMA3 · **解读** 2026-08-04

---

## 1. 论文概览

**一句话**：VideoLLaMA 3 提出了一种"视觉中心"（vision-centric）的多模态基础模型——通过大规模高质量图文数据而非海量视频数据来驱动视频理解，配合任意分辨率视觉分词（AVT）和差分帧剪枝（DiffFP）两个框架设计，在图像和视频理解基准上同时达到 SOTA。

- **任务**：统一图像与视频理解——单一模型同时处理文档/图表/场景文本理解、数学推理、多图推理、视频问答、长视频理解、时序推理等。
- **核心创新**：(1) 视觉中心训练范式——四阶段训练，前三阶段聚焦图像理解，最后阶段才引入视频；(2) AVT（Any-resolution Vision Tokenization）——用 2D-RoPE 替换固定位置编码，让视觉编码器处理任意分辨率；(3) DiffFP（Differential Frame Pruner）——基于相邻帧像素差异剪枝冗余 token，使视频表征更精确紧凑。
- **结果**：在 VideoMME、PerceptionTest、MLVU 等视频基准和 DocVQA、MathVista 等图像基准上达到 SOTA；7B 模型在多个基准上超越 Qwen2-VL-7B、InternVL2.5-8B、LLaVA-OneVision 等。

**take-home**：给视频模型装"眼睛"不需要海量视频数据——高质量图文数据加上精心设计的视觉编码器适配，就能建立足够强的视觉基础，最后一阶段微调即可获得出色的视频理解能力。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

In this paper, we propose VideoLLaMA 3, a more advanced multimodal foundation model for image and video understanding. The core design philosophy of VideoLLaMA3 is vision-centric. The meaning of "vision-centric" is two-fold: the vision-centric training paradigm and vision-centric framework design. The key insight of our vision-centric training paradigm is that high-quality image-text data is crucial for both image and video understanding. Instead of preparing massive video-text datasets, we focus on constructing large-scale, high-quality image-text datasets. VideoLLaMA3 has four training stages: 1) Vision Encoder Adaptation, which enables the vision encoder to accept images of variable resolutions as input; 2) Vision-Language Alignment, which jointly tunes the vision encoder, projector, and LLM with large-scale image-text data covering multiple types (including scene images, documents, and charts) as well as text-only data. 3) Multi-task Fine-tuning, which incorporates image-text SFT data for downstream tasks and video-text data to establish a foundation for video understanding. 4) Video-centric Fine-tuning, which further improves the model's capability in video understanding. As for the framework design, to better capture fine-grained details in images, the pretrained vision encoder is adapted to encode images of varying sizes into vision tokens with corresponding numbers, rather than a fixed number of tokens. For video inputs, we reduce the number of vision tokens according to their similarity so that the representation of videos will be more precise and compact. Benefiting from vision-centric designs, VideoLLaMA3 achieves compelling performances in both image and video understanding benchmarks.

> **译：** 本文提出 VideoLLaMA 3，一个更先进的多模态基础模型，面向图像和视频理解。VideoLLaMA 3 的核心设计理念是"视觉中心"（vision-centric）。"视觉中心"有两层含义：视觉中心训练范式和视觉中心框架设计。视觉中心训练范式的关键洞察是，高质量图文数据对图像和视频理解都至关重要。我们不准备海量视频文本数据集，而是专注于构建大规模、高质量的图文数据集。VideoLLaMA 3 有四个训练阶段：1）视觉编码器适配，使视觉编码器能接受可变分辨率图像作为输入；2）视觉-语言对齐，用大规模图文数据（包括场景图像、文档和图表）以及纯文本数据联合微调视觉编码器、投影器和 LLM；3）多任务微调，引入图文 SFT 数据用于下游任务和视频文本数据以建立视频理解基础；4）视觉中心微调，进一步提升模型的视频理解能力。在框架设计方面，为更好捕捉图像中的细粒度细节，预训练视觉编码器被适配为将不同大小的图像编码为对应数量的视觉 token，而非固定数量的 token。对于视频输入，我们根据相似性减少视觉 token 数量，使视频表征更精确紧凑。得益于视觉中心设计，VideoLLaMA 3 在图像和视频理解基准上均取得了有竞争力的表现。

</details>

---

## 2. 研究背景

文本 LLM 的成功推动了多模态 LLM（MLLM）的发展。现有 MLLM 分为两大方向：

| 方向 | 代表工作 | 特点 |
|---|---|---|
| 图像中心 MLLM | LLaVA、InstructBLIP、Qwen2-VL | 图文数据易获取、质量高，图像理解强 |
| 视频中心 MLLM | Video-LLaMA、LLaVA-Video、Apollo | 需处理时间维度，视频数据质量低、标注难 |

**核心缺口**：视频 MLLM 受限于视频文本数据的质量和规模。而图像 MLLM 已证明——高质量图文数据可以建立强大的视觉理解基础。VideoLLaMA 3 的核心动机：**用图像理解的强大基础来驱动视频理解**，而非依赖海量低质量视频数据。

**为什么难？** 图像和视频的视觉编码需求截然不同——图像需要细粒度的分辨率适配（文档、图表中的小字），视频需要时序冗余压缩（相邻帧高度相似）。用一个模型统一处理，需要同时解决分辨率灵活性和时序效率两个问题。

VideoLLaMA 3 继承自 VideoLLaMA 和 VideoLLaMA 2 系列，是第三代——前两代建立了视频理解的基础架构，第三代则回归"视觉中心"理念，从图像理解出发重新设计训练范式和框架。

---

## 3. 方法详解

VideoLLaMA 3 的方法分三部分：视觉中心训练范式（四阶段）、AVT 框架设计、DiffFP 框架设计。

### 3.1 模型结构

![Figure 3：VideoLLaMA 3 整体流程。两个关键技术点：❶ AVT 将任意分辨率图像/视频转换为一组 1-D token 序列；❷ DiffFP 作为视频压缩器，消除相邻帧间差异最小的视频内容，提升长视频处理效率。](/vibe-reading/images/articles/videollama3-frontier-multimodal-foundation/fig-03-pipeline.png)

模型由四个组件构成：视觉编码器（SigLIP 初始化）、视频压缩器（DiffFP）、投影器（两层 MLP + GELU）、LLM 主干（Qwen2.5）。视觉编码器提取视觉 token，视频压缩器减少视频 token 数量，投影器桥接视觉编码器与 LLM 的特征空间。

### 3.2 视觉中心训练范式

![Figure 2：VideoLLaMA 3 训练范式。四个阶段的数据量：Stage 1 视觉编码器适配（15.57M）→ Stage 2 视觉-语言对齐（21.97M）→ Stage 3 多任务微调（19.05M）→ Stage 4 视频中心微调（5.71M）。前三阶段聚焦图像，最后阶段聚焦视频。](/vibe-reading/images/articles/videollama3-frontier-multimodal-foundation/fig-02-training-paradigm.png)

| 阶段 | 目标 | 训练模块 | 数据规模 | 数据类型 |
|---|---|---|---|---|
| 1. 视觉编码器适配 | 动态分辨率 + 特征对齐 | 视觉编码器 + 投影器（LLM 冻结） | 15.57M | 场景图像 + 文档 + 场景文本 |
| 2. 视觉-语言对齐 | 引入多模态知识 | 全部参数可训 | 21.97M | 场景图像 + 文档 + 图表 + 细粒度 + 纯文本 |
| 3. 多任务微调 | 指令跟随 + 视频基础 | 全部参数 + 引入视频压缩器 | 19.05M | 图文 QA + 视频 caption + 纯文本 |
| 4. 视频中心微调 | 视频专家能力 | 全部参数可训 | 5.71M | 视频 QA + 流式视频 + 时序定位 + 图文/纯文本 |

**关键设计理念**：前三阶段聚焦图像理解——Stage 1 建立动态分辨率能力，Stage 2 注入多模态知识，Stage 3 学习指令跟随；最后阶段才大量引入视频数据。这种"先图像后视频"的顺序，使得模型在进入视频训练时已具备强大的视觉理解基础。

### 3.3 AVT：任意分辨率视觉分词

传统方法用固定分辨率（如 336×336 或 384×384）处理图像，导致信息丢失。AnyRes 技术将图像分割为固定分辨率的 patch，但仍不够灵活。VideoLLaMA 3 的 AVT 方案：

- 用 **2D-RoPE**（Rotary Position Embedding）替换 ViT 中的绝对位置编码
- 微调视觉编码器使其适应动态分辨率输入
- 不同分辨率的图像编码为**对应数量的 vision token**——大图多 token、小图少 token

这使模型能处理高分辨率图像（文档中的小字）和不寻常宽高比的图像，且信息损失最小。

### 3.4 DiffFP：差分帧剪枝

![Figure 4：DiffFP 计算流程。在像素空间计算帧间差异，移除与前帧距离较小的 patch（冗余内容）。](/vibe-reading/images/articles/videollama3-frontier-multimodal-foundation/fig-04-difffp-flow.png)

视频的相邻帧内容高度重叠，逐帧堆叠 vision token 会导致冗余。DiffFP 的设计方案：

1. 对每帧做 2×2 空间下采样（双线性插值），限制上下文长度
2. 计算时间上连续帧之间的 **1-norm 像素距离**
3. 剪枝距离低于阈值（默认 0.1）的 patch——这些 patch 与前帧几乎相同

**双重收益**：(1) 视频表征更精确紧凑，模型聚焦于动态部分；(2) 节省训练和推理的计算开销，尤其对长视频。

### 3.5 高质量图像重标注数据集

为支撑视觉中心训练，作者构建了 VL3-Syn7M 数据集（700 万图像-标注对），来自 COYO-700M，经五步清洗：

1. **宽高比过滤**——去除极端宽高比图像
2. **美学评分过滤**——去除视觉质量低的图像
3. **文本-图像相似度计算**——BLIP2 生成初始 caption + CLIP 计算相似度，去除低相似度
4. **视觉特征聚类**——CLIP 特征 + KNN 聚类，确保语义类别多样性
5. **图像重标注**——InternVL2-8B 生成简短 caption、InternVL2-26B 生成详细 caption

---

## 4. 关键公式解读

### AVT 的位置编码替换

VideoLLaMA 3 将 ViT 中的绝对位置编码替换为 2D-RoPE。对于二维位置 $(x, y)$，2D-RoPE 在 attention 中对 query/key 施加旋转：

$$
\text{RoPE}_{2D}(q, x, y) = R(x, \theta) \cdot R(y, \theta) \cdot q
$$

其中 $R(\cdot, \theta)$ 为旋转矩阵，$\theta$ 为频率参数。2D-RoPE 的核心优势是**外推性**——训练时见过的分辨率可以泛化到未见过的分辨率，使视觉编码器能处理任意大小的输入。

### DiffFP 的剪枝准则

对于时间上连续的帧 $F_t$ 和 $F_{t-1}$，计算 patch 级 1-norm 距离：

$$
d(p_t^{(i)}, p_{t-1}^{(j)}) = \| p_t^{(i)} - p_{t-1}^{(j)} \|_1
$$

其中 $p_t^{(i)}$ 为第 $t$ 帧的第 $i$ 个 patch。剪枝准则为：

$$
\text{Prune}(p_t^{(i)}) = \begin{cases} \text{true} & \text{if } d(p_t^{(i)}, p_{t-1}^{(\text{nearest})}) < \tau \\ \text{false} & \text{otherwise} \end{cases}
$$

其中 $\tau = 0.1$ 为默认阈值。**关键洞察**：低差异 patch 意味着该区域在相邻帧间几乎不变（如静态背景），对视频理解的贡献有限——剪枝后模型聚焦于动态变化区域。

---

## 5. 实验设置

### 模型配置

| 组件 | 配置 |
|---|---|
| 视觉编码器 | SigLIP（2B 模型用预训练权重，7B 用 Stage 1 微调后的权重） |
| LLM 主干 | Qwen2.5-2B / Qwen2.5-7B |
| 投影器 | 两层 MLP + GELU |
| 视频压缩器 | DiffFP（阈值 0.1，2×2 空间下采样） |
| 最大 token 长度 | 16384（视觉 token 上限 10240） |
| 视频帧采样 | 1 fps，最多 180 帧 |
| 学习率 | LLM $1\times10^{-5}$, 投影器 $1\times10^{-5}$, 视觉编码器 $2\times10^{-6}$ |
| 评估视频 token | 扩展至 16K |

### 训练数据总览

四阶段合计约 62M 数据样本，覆盖：

- **图像数据**：VL3-Syn7M（自建）、LLaVA-Pretrain、Objects365、SA-1B、ShareGPT4o/V、COCO、DocVQA、ChartQA 等
- **视频数据**：LLaVA-Video-178K、ShareGPT4o-Video、FineVideo、CinePile、VideoRefer、Panda-70M 合成数据
- **流式视频**：ActivityNet、YouCook2、Ego4D
- **时序定位**：8 个数据集（ActivityNet、YouCook2、ViTT、QuerYD、HiREST、Charades-STA、Moment-10M、COIN）
- **纯文本**：Magpie、Tulu 3、Evol-Instruct 等

### 评估基准

| 维度 | 基准 |
|---|---|
| 文档/图表/场景文本 | DocVQA、ChartQA、InfoVQA、OCRBench |
| 数学推理 | MathVista、MathVision |
| 多图理解 | MMMU-Pro、MMMU、BLINK |
| 通用知识 QA | RealWorldQA、AI2D、GQA、MME |
| 视频通用理解 | VideoMME、MVBench、EgoSchema、PerceptionTest、ActivityNet-QA、MMVU |
| 长视频理解 | MLVU、LongVideoBench、LVBench |
| 时序推理 | TempCompass、NextQA、Charades-STA（mIoU） |

### 基线模型

- **2B**：SmolVLM-2B、InternVL2.5-2B、Qwen2-VL-2B、Apollo-2B
- **7B**：Molmo-7B-D、InternVL2.5-8B、LLaVA-OneVision-7B、NVILA-8B、Qwen2-VL-7B、LLaVA-Video-7B、Apollo-7B、VideoLLaMA 2.1-7B

---

## 6. 实验结果

### 图像理解主结果

![Figure 1：VideoLLaMA 3 与各主流 MLLM 在代表性基准上的性能对比。在视频理解（VideoMME、PerceptionTest、MLVU）和图像理解（DocVQA、MathVista）上均表现突出。](/vibe-reading/images/articles/videollama3-frontier-multimodal-foundation/fig-01-performance-comparison.png)

**7B 模型关键数值**（加粗为最优）：

| 基准 | VideoLLaMA 3 | Qwen2-VL | InternVL2.5 | LLaVA-OV |
|---|---|---|---|---|
| DocVQA↑ | **94.9** | 94.5 | 93.0 | 87.5 |
| InfoVQA↑ | **78.9** | 76.5 | 77.6 | 68.8 |
| MathVista↑ | **67.1** | 58.2 | 64.4 | 63.2 |
| MathVision↑ | **26.2** | 16.3 | 19.7 | — |
| RealWorldQA↑ | **72.7** | 70.1 | 70.1 | 66.3 |
| ChartQA↑ | 86.3 | 83.0 | **86.1** | 80.0 |

关键发现：

1. **文档/图表理解最强**：DocVQA 94.9%、InfoVQA 78.9%——AVT 的动态分辨率让模型能读取文档中的小字。
2. **数学推理大幅领先**：MathVista 67.1% 超 Qwen2-VL 8.9 个点，MathVision 26.2% 超 InternVL2.5 6.5 个点——视觉中心训练建立的强视觉基础有助于数学图表理解。
3. **通用 QA 竞争力强**：RealWorldQA 72.7% 超所有基线。

### 视频理解主结果

**7B 模型关键数值**：

| 基准 | VideoLLaMA 3 | Qwen2-VL | InternVL2.5 | LLaVA-Video |
|---|---|---|---|---|
| VideoMME w/o sub↑ | **66.2** | 63.3 | 64.2 | 63.3 |
| VideoMME w/ sub↑ | **70.3** | 69.0 | 66.9 | 69.7 |
| PerceptionTest↑ | **72.8** | 62.3 | 68.9 | 67.9 |
| MLVU↑ | **73.0** | 69.8 | 69.0 | 70.8 |
| ActivityNet-QA↑ | **61.3** | 57.4 | 58.9 | 56.5 |
| NextQA↑ | 84.5 | 81.2 | **85.0** | 83.2 |
| Charades-STA (mIoU)↑ | **60.7** | — | — | — |

关键发现：

1. **视频理解全面领先**：VideoMME w/o sub 66.2、PerceptionTest 72.8、MLVU 73.0——视觉中心训练范式在视频基准上反而比纯视频训练的方法更强。
2. **PerceptionTest 大幅领先**：72.8% 超 Qwen2-VL 10.5 个点——DiffFP 的帧压缩让模型聚焦动态部分，提升感知能力。
3. **长视频理解最强**：MLVU 73.0 超所有基线——DiffFP 对长视频的效率提升尤为关键。
4. **时序定位首次具备**：Charades-STA mIoU 60.7——前代 VideoLLaMA 无此能力。

---

## 7. 消融实验

### 视觉编码器选择

| 视觉编码器 | GQA | AI2D | ChartQA | DocVQA | MME |
|---|---|---|---|---|---|
| CLIP-ViT-Large-336 | 61.5 | 56.3 | 18.3 | 24.9 | 1668 |
| DFN5B-CLIP-ViT-H-378 | 62.7 | 56.9 | 16.4 | 23.1 | 1665 |
| **SigLIP-SO400M-384** | **62.9** | **57.1** | **22.4** | **31.3** | **1668** |

SigLIP 在所有基准上最优，尤其在涉及文字的细粒度理解任务（ChartQA +6.1、DocVQA +6.6）上优势明显——因此选择 SigLIP 作为基础视觉编码器。

### 视觉中心范式的设计验证

论文未对四阶段训练做独立消融，但通过实验结果间接验证了设计选择的正确性：

1. **视觉中心训练范式的有效性**：VideoLLaMA 3 在 Stage 3 引入少量视频 caption 数据后，**图像理解性能反而提升**——这表明视频数据不仅不损害图像能力，反而通过提供更多视觉场景增强了泛化能力，验证了"先图像后视频"路线的正确性。

2. **AVT 动态分辨率的必要性**：7B 模型在 DocVQA（94.9%）和 InfoVQA（78.9%）上大幅领先固定分辨率的基线模型——高分辨率文档中的小字需要动态分辨率才能有效读取。

3. **DiffFP 帧压缩的效果**：VideoLLaMA 3 在长视频理解（MLVU 73.0）和感知测试（PerceptionTest 72.8）上领先——DiffFP 让模型在有限 token 预算内聚焦于视频中的动态变化部分。

4. **2B → 7B 的扩展性**：7B 模型在大多数基准上超越 2B 模型 5-10 个百分点，说明视觉中心范式具有良好的规模扩展性——更大的 LLM 主干能更好地利用强视觉基础。

---

## 8. 总结与展望

### 贡献总结

| 贡献 | 意义 |
|---|---|
| 视觉中心训练范式 | 用高质量图文数据驱动视频理解，验证"先图像后视频"路线 |
| AVT 任意分辨率分词 | 2D-RoPE 替换固定位置编码，支持动态分辨率输入 |
| DiffFP 差分帧剪枝 | 基于帧间像素差异剪枝冗余 token，提升视频处理效率 |
| VL3-Syn7M 数据集 | 700 万高质量重标注图像，五步清洗确保数据质量 |
| 统一图像+视频 SOTA | 单一模型在两类模态上同时达到先进水平 |

### 局限性

- **视频数据质量仍是瓶颈**：尽管视觉中心范式减少了对视频数据的依赖，但视频文本数据的质量和多样性仍是约束——Stage 4 的视频数据仍来自有限的开源数据集。
- **实时处理未优化**：当前架构未针对实时视频处理优化，对自动驾驶、直播分析等低延迟场景不适用。
- **多模态扩展有限**：模型仅处理图像和视频，未集成音频、语音等模态——与 video-SALMONN 系列的音视觉能力仍有差距。
- **时序定位精度有限**：Charades-STA mIoU 60.7 虽是首次具备，但与专门的时序定位模型相比仍有提升空间。
- **2B 模型能力上限**：小规模模型在复杂推理任务上的绝对性能仍有限。

### 未来方向

- **弥补缺陷**：优化模型架构以支持实时推理——如模型加速、并行处理、高效 tokenization 策略；提升时序定位精度——可能需要更精细的时序标注数据。
- **新型方案**：扩展到更多模态（音频、语音、传感器数据）——实现更全面的多模态智能；引入 RLHF 等后训练技术——更好地对齐人类偏好。
- **减少约束**：放宽对特定视觉编码器的依赖——探索端到端视觉编码器训练或统一的视觉-文本预训练；降低对高质量标注数据的依赖——探索弱监督或自监督方法。

**与 SALMONN 系列的关联**：VideoLLaMA 3 和 SALMONN 分别代表了多模态 LLM 的两条路线——VideoLLaMA 3 以"视觉中心"理念统一图像和视频，SALMONN 以"通用听觉"理念统一语音、音频和音乐。两者的互补——视觉+听觉——指向了未来更完整的多模态智能。
