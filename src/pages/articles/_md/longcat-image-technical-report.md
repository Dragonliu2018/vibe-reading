---
title: "LongCat-Image Technical Report"
source:
  type: "论文解读"
  project: "LongCat"
  url: "https://arxiv.org/abs/2512.07584"
  pdf: "/vibe-reading/papers/longcat-image-technical-report.pdf"
date: "2026-08-11T11:37:36+08:00"
category: [AI, Models, Image Model, Papers]
tags: ["Image Generation", "DiT", "RLHF", "Chinese Text Rendering", "Image Editing", "DPO", "GRPO", "MPO"]
description: "目的：6B 双语图像生成与编辑。手段：MM-DiT 混合架构 + 三阶段数据精炼 + 多奖励 RLHF + 字符级中文渲染。结论：性能比肩 20B+ MoE，中文渲染行业领先，全链路开源。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/longcat-image-technical-report.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LongCat-Image Technical Report](https://arxiv.org/abs/2512.07584) · **作者** Meituan LongCat Team（Hanghang Ma, Haoxian Tan, Jiale Huang, Jie Hu 等）· **发表** arXiv 2512.07584, 2025-12 · **项目** https://github.com/meituan-longcat/LongCat-Image · **解读** 2026-08-11

---

## 1. 论文概览

**一句话**：LongCat-Image 用一个 6B 参数的紧凑扩散模型，挑战"参数堆叠换性能"的行业惯例——通过**混合 MM-DiT 架构 + 三阶段数据精炼 + 多奖励 RLHF（DPO/GRPO/MPO）+ 字符级中文渲染**，在文本渲染、摄影真实感、图像编辑三个方向同时达到 SOTA 级别，且全链路开源（权重 + 中间 checkpoint + 训练代码）。

- **任务**：双语（中英）文生图与图像编辑。
- **核心创新**：① 6B 参数挑战 20B+ MoE 的效率-性能平衡点；② AIGC 检测作为 RL 奖励信号对抗"塑料感"；③ 字符级 tokenizer 替代专用编码器（如 GlyphByT5）做中文渲染；④ 提出 **MPO（Monolithic Policy Optimization）** 消除 GRPO 的组内同步瓶颈。
- **结果**：ChineseWord 90.7%（领先 Seedream 4.0 的 58.5 三十多个百分点），GenEval 0.87（持平 Qwen-Image），ImgEdit-Bench 4.50（全场最高），MOS Visual Realism 优于 Qwen-Image 和 Seedream 4.0。

**take-home**：扩散模型的"高质量"不靠暴力堆参数，而靠**数据纯度（剔 AIGC）+ 架构继承（FLUX.1-dev 双流/单流混合）+ RL 精调三件套（DPO 去坏例 / GRPO 组内对比 / MPO 单轨迹高效优化）**的协同——6B 足够好，且能开源给社区复现。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We introduce LongCat-Image, a pioneering open-source and bilingual (Chinese-English) foundation model for image generation, designed to address core challenges in multilingual text rendering, photorealism, deployment efficiency, and developer accessibility prevalent in current leading models. 1) We achieve this through rigorous data curation strategies across the pre-training, mid-training, and SFT stages, complemented by the coordinated use of curated reward models during the RL phase. This strategy establishes the model as a new state-of-the-art (SOTA), delivering superior text-rendering capabilities and remarkable photorealism, and significantly enhancing aesthetic quality. 2) Notably, it sets a new industry standard for Chinese character rendering. By supporting even complex and rare characters, it outperforms both major open-source and commercial solutions in coverage, while also achieving superior accuracy. 3) The model achieves remarkable efficiency through its compact design. With a core diffusion model of only 6B parameters, it is significantly smaller than the nearly 20B or larger Mixture-of-Experts (MoE) architectures common in the field. This ensures minimal VRAM usage and rapid inference, significantly reducing deployment costs. Beyond generation, LongCat-Image also excels in image editing, achieving SOTA results on standard benchmarks with superior editing consistency compared to other open-source works. 4) To fully empower the community, we have established the most comprehensive open-source ecosystem to date. We are releasing not only multiple model versions for text-to-image and image editing, including checkpoints after mid-training and post-training stages, but also the entire toolchain of training procedure. We believe that the leading performance, high efficiency, and openness of LongCat-Image will provide robust support for developers and researchers, collectively pushing the frontiers of multilingual visual content creation.

> **译：** 我们推出 LongCat-Image——一个开源、中英双语的图像生成基础模型，旨在解决当前领先模型在多语言文字渲染、摄影真实感、部署效率和开发者可及性方面的核心挑战。1）通过在预训练、中间训练和 SFT 阶段的严格数据筛选策略，配合 RL 阶段精心调校的奖励模型，使模型成为新的 SOTA，在文字渲染和真实感上表现卓越。2）特别地，它为中文汉字渲染树立了新的行业标准——覆盖复杂和稀有汉字，在覆盖率和准确率上均超越主流开源和商业方案。3）仅 6B 参数的紧凑设计远小于常见的 20B+ MoE 架构，确保极低显存占用和快速推理。4）建立了迄今最全面的开源生态：不仅发布多个模型版本（含中间和后训练 checkpoint），还公开了从预训练到 RL 的完整训练代码。

</details>

---

## 2. 研究背景

图像生成领域近年来沿"参数越大越好"的路径狂奔：从 PixArt-α 的 0.6B、Stable Diffusion 3.0 的 8B，到 Qwen-Image 的 20B、HunyuanImage-3.0 的 80B MoE。但作者观察到一个关键问题——**无节制的参数增长并未带来预期的质变**，反而引发计算成本飙升、部署门槛抬高、推理延迟增大。

| 现有缺口 | 行业现状 | LongCat-Image 的切入点 |
|---|---|---|
| 参数效率 | 20B–80B MoE 才能达到 SOTA | 6B 紧凑模型，VRAM 极低 |
| 中文渲染 | 稀有字覆盖差、准确率低 | SynthDoG 合成 + 字符级编码 + 动态采样 |
| 摄影真实感 | AIGC 污染数据导致"塑料感" | 预训练剔除 AIGC + RL 阶段 AIGC 检测奖励 |
| 图像编辑一致性 | 编辑后原图区域易漂移 | 从 mid-training checkpoint 初始化 + 严格人工过滤 |

**为什么需要这篇**：它把"高效、高质量、开源"三件事在一个 6B 模型里一次性解决，并给出了 RLHF 落到图像生成的工程化方法论——这正是业界最缺的实操指南。

![图5 训练数据总览（1.2B 样本的组成分布）](/vibe-reading/images/articles/longcat-image-technical-report/fig-05-training-data.png)

---

## 3. 方法详解

LongCat-Image 的方法由四块组成：模型架构、数据策略、多阶段训练、图像编辑适配。整体训练流程分三阶段。

### 3.1 模型架构

网络采用 FLUX.1-dev 的双流/单流混合结构：前段使用 **MM-DiT（双流注意力）**，后段过渡到 **Single-DiT（单流）**，双流与单流块的比例约 **1:2**（10 个 MM-DiT 块 + 20 个 Single-DiT 块）。VAE 沿用 FLUX.1-dev 实现，输入图像经 **8× 空间压缩**，再经 **2×2 token 合并**，最终序列长度为 $H \times W / (16 \times 16)$。

![图12 LongCat-Image T2I 模型架构总览：MM-DiT × 10 + Single-DiT × 20，VAE Encoder、Qwen2.5VL 文本编码器、M-RoPE 位置编码](/vibe-reading/images/articles/longcat-image-technical-report/fig-12-t2i-architecture.png)

三个关键设计决策：

- **文本编码器**：采用 Qwen2.5VL-7B 作为统一文本编码器，替代传统的 CLIP + T5 组合，确保中英双语能力。同时**放弃将文本 embedding 注入 timestep embedding 做 adaLN 调制**——实验表明这步操作性能增益可忽略。
- **字符级 tokenizer**：对 prompt 中引号 `""` 标记的待渲染文本，使用字符级编码。这避免了 GlyphByT5 等专用编码器的计算开销和内存占用，同时提升数据效率、加速收敛。
- **3D MRoPE**：采用原版多模态旋转位置编码（不做几何约束修改）。第一维用于模态区分（T2I 区分噪声 latent 与文本 latent；编辑任务额外区分参考图 latent），后两维编码 2D 空间坐标。

### 3.2 数据策略

模型在 **1.2B 样本**上训练，数据精炼流水线分四阶段：

![图6 数据精炼流水线四阶段：Filtering → Meta Info Extraction → Multi-Granularity Captioning → Stratification](/vibe-reading/images/articles/longcat-image-technical-report/fig-06-data-curation.png)

**Filtering（过滤）** 的核心是 **AIGC 检测**——作者发现训练数据中哪怕只有少量 AI 生成内容，也会导致模型过早收敛到狭窄的局部最优，生成图像呈现"塑料感/油腻感"。因此在预训练和中间训练阶段**严格排除所有 AIGC 数据**，SFT 阶段引入的合成数据也经过精心人工筛选。RL 阶段更进一步：**将 AIGC 检测模型作为奖励模型之一**，用对抗信号引导模型生成具有真实物理世界纹理的图像。

**Multi-Granularity Captioning（多粒度标题）** 将语义抽象组织为四个层级——Entity（实体）、Phrase（短语）、Composition（构图）、Photographic（摄影级），采样概率分别为 $[0.05, 0.1, 0.2, 0.65]$。Photographic Level Captioner 基于 Qwen2.5-VL + LoRA 微调，在保留世界知识的同时提升信息密度。

**中文文字渲染数据**用 SynthDoG 工具生成超 1000 万样本，将古典文学、诗词、复杂字符渲染到纸张、玻璃、黑板等多样纹理上：

![图11 中文文字渲染数据合成流程：从语料到渲染图](/vibe-reading/images/articles/longcat-image-technical-report/fig-11-text-synthesis.png)

### 3.3 多阶段训练

训练分三阶段，核心超参如下表：

| 阶段 | 学习率 | 调度器 | 训练步数 | Global Batch | 分辨率 |
|---|---|---|---|---|---|
| PT 256px | 1e-4 | Constant | 900K | 4608 | 256 |
| PT 512px | 5e-5 | Constant | 300K | 4608 | 512 |
| PT 512-1024px | 2e-5 | Constant | 200K | 3072 | 动态 |
| Mid-training | 1e-5 | Constant | 70K | 3072 | — |
| SFT | 1e-5 | Cosine | 20K | 128 | — |
| DPO | 1e-5 | Cosine | 4K | 64 | — |
| GRPO | 1e-5 | Cosine | 300 | 32 | — |

![图13 多阶段训练流水线：T2I（Pre-training → Mid-training → SFT → GRPO → DPO）与 Image Editing（Pre-training → SFT → DPO）](/vibe-reading/images/articles/longcat-image-technical-report/fig-13-training-pipeline.png)

三个阶段各有侧重：

- **Pre-training**：渐进式多分辨率（256→512→512-1024px），用 bucket sampling 适配可变宽高比。对中文合成数据采用**基于实时字符准确率的动态采样**——高频错误字符增加采样概率，已掌握的字符减少合成数据比重，最终阶段完全停用合成数据。
- **Mid-training**：严格数据筛选（美学评分 + 人工验证），产出 **Developer Version**（高可塑性，避免 RL 导致的 mode collapse），开源给社区做下游微调。
- **Post-training（RLHF）**：三种 RL 策略配合使用——DPO 做大规模离线偏好学习，GRPO/MPO 做小规模在线精细 RL。SFT 阶段从 Logit-Normal 采样切换为 Uniform 采样，增加高频去噪步的权重。

### 3.4 图像编辑适配

LongCat-Image-Edit 在 T2I 基础架构上增加图像条件分支：参考图经 VAE 编码后，通过 3D RoPE 第一维与噪声 latent 区分，沿序列维度拼接送入 DiT。源图与编辑指令同时送入 Qwen2.5-VL，用不同 system prompt 区分编辑与生成任务。

![图20 LongCat-Image-Edit 架构：双 VAE Encoder（输入图 + 参考图）、MM-DiT × 10 + Single-DiT × 20、Qwen2.5VL](/vibe-reading/images/articles/longcat-image-technical-report/fig-20-edit-architecture.png)

编辑模型有两个关键设计决策：

- **从 mid-training checkpoint 初始化**（而非 SFT/RL 后的高度优化状态）——后者处于狭窄状态空间，不利于编辑任务的学习和泛化。
- **多任务联合训练**——编辑数据与 T2I mid-training 数据混合训练，避免生成知识灾难性遗忘。

作者在 Discussion 中坦言：最初尝试统一 T2I + 编辑为单模型，但编辑预训练大量使用合成数据，**会明显降低 T2I 的摄影真实感**。最终决定分开——这是数据驱动问题而非架构缺陷，未来用大规模 interleaved corpora 可能实现统一。

---

## 4. 关键公式解读

### DPO 损失

Direct Preference Optimization 用于去除模型的常见结构缺陷。每个 prompt 生成 6 张候选图，人工打 1–5 分，丢弃中性分（3 分），4–5 分为正例、1–2 分为负例：

$$
\mathcal{L}_{\text{DPO}}(\theta) = -\mathbb{E}_{(x_0^w, x_0^l) \sim \mathcal{D},\; t \sim \mathcal{U}(0,T)} \left[ \log \sigma \left( \underbrace{-\beta T \omega(\lambda_t)}_{\text{温度加权}} \left( \underbrace{\|v_w - v_\theta(x_t^w, t)\|_2^2 - \|v_w - v_{\text{ref}}(x_t^w, t)\|_2^2}_{\text{正例策略 vs 参考}} - \underbrace{\|v_l - v_\theta(x_t^l, t)\|_2^2 - \|v_l - v_{\text{ref}}(x_t^l, t)\|_2^2}_{\text{负例策略 vs 参考}} \right) \right) \right]
$$

其中 $v_\theta$ 是策略速度场，$v_{\text{ref}}$ 是参考速度场，$\omega(\lambda_t)$ 是噪声水平加权函数。

### GRPO 组内优势

GRPO 基于 Dance-GRPO 框架，每个 prompt 采样一组 $G$ 张图，组内优势归一化：

$$
A_i = \frac{R(x_0^i, h) - \text{mean}(\{R(x_0^i, h)\}_{i=1}^G)}{\text{std}(\{R(x_0^i, h)\}_{i=1}^G)}
$$

训练时将 flow-matching 的确定性 ODE 重构为 SDE 以增加探索性：

$$
dx_t = \left( v_t + \frac{\sigma_t^2}{2t}(x_t + (1-t)v_t) \right) dt + \sigma_t\, dw
$$

### MPO 策略更新（本文创新）

**Monolithic Policy Optimization** 是本文提出的核心 RL 创新——每个 prompt 仅生成**单条轨迹**做一次梯度更新，消除 GRPO 的组内同步瓶颈。策略更新采用优势加权回归：

$$
\mathcal{L}_{\text{MPO}}(\theta) = \mathbb{E}_{t, z_t \sim \tau} \left[ \text{stop\_grad}(w_c \cdot \tilde{A}) \cdot \| v_\theta(z_t, c, t) - u(z_t, z_0) \|_2^2 \right]
$$

其中 $w_c = 1 + \gamma \cdot |r - \mu_c| / (\sigma_c + \epsilon)$ 是惊喜重加权因子，$\tilde{A}$ 是经全局 EMA 归一化的优势值。MPO 通过三个组件实现稳定的方差控制：① Kalman 滤波的高斯值跟踪器；② 全局优势归一化（EMA）；③ 不确定性驱动的课程学习。

---

## 5. 实验设置

### 数据集与基准

| 评测维度 | 基准 | 评测内容 |
|---|---|---|
| 文图对齐 | GenEval、DPG-Bench、WISE | 属性绑定、语义对齐、世界知识推理 |
| 英文文字渲染 | CVTG-2K | 多区域英文（2–5 regions） |
| 中文文字渲染 | GlyphDraw2、ChineseWord（8,105 字）、Poster&SceneBench | 海报、复杂字、真实场景 |
| 图像编辑 | CEdit-Bench（自建）、GEdit-Bench、ImgEdit-Bench | 15 类编辑任务，SQ/PQ/O 指标 |
| 人类评估 | MOS（400 prompt） | 对齐、合理性、真实感、美学 |

### 基线方法

对比对象包括 Seedream 4.0、Qwen-Image、HunyuanImage-3.0（开源 20B+），以及 FLUX.1 Kontext、Nano Banana（Gemini-2.5-flash-image）、GPT Image 1（商业闭源）。

### 复现信息

代码与权重已开源：https://github.com/meituan-longcat/LongCat-Image ；HuggingFace 模型：https://huggingface.co/meituan-longcat/LongCat-Image ；CEdit-Bench 数据集：https://huggingface.co/datasets/meituan-longcat/CEdit-Bench 。不仅发布最终模型，还公开 mid-training checkpoint（Developer Version）和完整训练代码。

---

## 6. 实验结果

### 文生图主结果

| 基准 | LongCat-Image | Seedream 4.0 | Qwen-Image | Hunyuan 3.0 | 要点 |
|---|---|---|---|---|---|
| GenEval Overall | **0.87** | 0.84 | 0.87 | 0.72 | 持平 Qwen-Image |
| DPG Overall | 86.80 | 88.25 | 88.32 | 86.10 | 竞争力强 |
| WISE Overall | **0.65** | 0.78 | 0.62 | 0.57 | 开源 T2I SOTA |
| GlyphDraw2 Avg | 0.95 | 0.97 | 0.93 | 0.78 | 仅次于 Seedream |
| **ChineseWord Overall** | **90.7** | 58.5 | 56.6 | 49.3 | **碾压级领先** |
| Poster&Scene Avg | 91.5 | 91.6 | 89.2 | 87.1 | SOTA 级 |

**ChineseWord 是最亮眼的结果**：LongCat-Image 在 L1（常用字）98.7%、L2（次常用）90.8%、L3（稀有字）70.3%，总 90.7% 远超所有对手。这得益于 SynthDoG 合成数据 + 字符级编码 + 动态采样的协同。

人类评估（MOS）中，LongCat-Image 在 **Visual Realism 维度优于 Qwen-Image 和 Seedream 4.0**——这正是 AIGC 检测奖励模型的功劳：

![图14 人类评估 MOS 四维对比：Alignment / Plausibility / Realism / Aesthetics](/vibe-reading/images/articles/longcat-image-technical-report/fig-14-mos-human-eval.png)

### 图像编辑结果

| 基准 | LongCat-Image-Edit | Qwen-Image-Edit [2509] | FLUX.1 Kontext [Pro] | Nano Banana | Seedream 4.0 |
|---|---|---|---|---|---|
| CEdit-Bench EN G_O | **7.67** | 7.48 | 6.53 | 7.20 | 7.58 |
| CEdit-Bench CN G_O | **7.65** | 7.37 | 1.43 | 7.36 | 7.57 |
| ImgEdit-Bench Overall | **4.50** | 4.35 | 4.00 | 4.35 | 4.18 |
| GEdit-Bench EN G_O | 7.64 | 7.54 | 6.56 | 7.54 | 7.68 |

**ImgEdit-Bench Overall 4.50 为全场最高**，超越所有开源和商业模型。CEdit-Bench 上开源 SOTA，仅次于 GPT Image 1。

人类 SBS 评估的胜率（公式 `(#Win + 0.5 × #Tie)/#Total`）：

![图22 图像编辑人类评估胜率对比：Consistency 与 Comprehensive Quality 两维度](/vibe-reading/images/articles/longcat-image-technical-report/fig-22-win-rates.png)

LongCat-Image-Edit 在一致性和综合质量上均优于 Qwen-Image-Edit [2509] 和 FLUX.1 Kontext [Pro]，但与 Nano Banana 和 Seedream 4.0 仍有差距。

编辑能力的代表性证据——多轮编辑 + 复合指令（6 个操作一次执行）：

![图23 多轮编辑 vs 一步复合编辑对比（6 操作全部准确执行）](/vibe-reading/images/articles/longcat-image-technical-report/fig-23-multi-turn-editing.png)

---

## 7. 消融与设计决策

论文没有独立的消融表格章节，但全文贯穿了关键设计决策的实验论证：

| 设计决策 | 实验观察 | 结论 |
|---|---|---|
| **AIGC 数据剔除** | 少量 AIGC 污染 → 模型过早收敛到局部最优，"塑料感"纹理 | 预训练/中间训练严格排除；RL 阶段 AIGC 检测作奖励 |
| **字符级 tokenizer** | vs GlyphByT5 专用编码器 | 提升数据效率 + 加速收敛，无额外计算/内存开销 |
| **编辑模型初始化点** | SFT/RL 后的模型处于狭窄状态空间 | 从 mid-training checkpoint 初始化，可塑性强 |
| **统一 vs 分离模型** | 编辑合成数据降低 T2I 真实感 | 分离——数据驱动问题，非架构缺陷 |
| **MPO vs GRPO** | GRPO 需组内同步，训练效率受限 | MPO 单轨迹单更新，Kalman 滤波稳定方差 |
| **渐进式分辨率** | 256→1024 直接跳变不稳定 | 保留 512px 中间阶段做平滑过渡 |
| **timestep 采样切换** | SFT 聚焦高频细节 | Logit-Normal → Uniform，增加高频步权重 |
| **文本 embedding 注入** | 注入 timestep adaLN | 增益可忽略，弃用 |

其中 **MPO** 的三组件协同值得展开：Kalman 滤波器维护每个 prompt 的奖励估计 $\mathcal{N}(\mu_c, \sigma_c^2)$，$Q_t = \alpha \cdot D_{\text{KL}}(\pi_{\theta'} \| \pi_\theta)$ 自适应缩放过程噪声——策略漂移越大，过程噪声越大，探索越充分。课程采样概率 $p(c) \propto \sigma_c + \eta/\sqrt{n_c}$ 优先高不确定性 prompt。

---

## 8. 总结与展望

### 贡献总结

1. **高效性能**：6B 参数在多基准上超越数倍大的开源模型。
2. **摄影真实感**：AIGC 检测奖励 + 数据策略，生成真实物理纹理。
3. **中文渲染**：SynthDoG + 字符级编码，覆盖率与准确率行业领先。
4. **编辑 SOTA**：从 mid-training 初始化 + 严格数据过滤，开源编辑模型最优。
5. **全链路开源**：中间 checkpoint + 完整训练代码，降低社区复现门槛。

### 局限性（批判性）

- **多字符序列渲染稳定性下降**：单字渲染碾压级领先（ChineseWord 90.7%），但多字符序列因真实文字训练数据不足，稳定性明显下降——作者承认并计划扩充 text-rich 数据集。
- **编辑与商业系统仍有差距**：Nano Banana 和 Seedream 4.0 在 SBS 胜率上仍领先。
- **统一 T2I + 编辑未实现**：合成编辑数据降低 T2I 真实感，被迫分模型——这是当前数据工程瓶颈，非架构限制。
- **CVTG-2K 的"SOTA"说法需审慎**：LongCat 在 2-region Word Accuracy 和 CLIPScore 上领先，但平均 Word Accuracy 和 NED 低于 Seedream 4.0——论文称"SOTA"略有夸大。

### 未来方向（idea 三法）

- **弥补缺陷**：扩充 text-rich 真实数据集，提升多字符序列稳定性；扩大 interleaved corpora 规模，解决编辑合成数据降低 T2I 真实感的问题，实现统一模型。
- **新型方案**：用视频帧的时序一致性（已有的编辑数据来源之一）构建更大规模的自然编辑对，替代合成数据；探索 AIGC 检测奖励在视频生成中的应用。
- **减少约束**：MPO 已消除 GRPO 的组内同步瓶颈，未来可进一步消除对参考模型的依赖，探索无参考的在线 RL 方案。

**一句话收尾**：LongCat-Image 证明了一件事——在扩散模型领域，**6B 做对了数据纯度、架构继承和 RL 精调三件事，就能比肩甚至超越 20B+ MoE**，而开源全链路让"高效高质量"不再是闭源巨头的专利。

---

## 相关阅读

- [SGLang PR #23274：接入 LongCat-Image](/vibe-reading/articles/sglang-pr-23274-support-longcat-image) — **工程实现**·本篇 MM-DiT 架构在 SGLang 中的全栈落地（MMDiT TP 并行 + 3D RoPE）
- [xLLM PR #849：LongCat-Image CUDA 支持](/vibe-reading/articles/xllm-pr-849-longcat-image-cuda) — **工程实现**·本篇 T2I 模型的 CUDA 适配（Qwen2.5-VL 文本编码 + FlashInfer FA2 bit-packing 掩码）
- [xLLM PR #957：LongCat-Image-Edit CUDA 支持](/vibe-reading/articles/xllm-pr-957-longcat-image-edit-cuda) — **工程实现**·本篇 §3.4 图像编辑分支的 CUDA 适配（双流 latent 拼接 + 双 VAE Encoder）
- [LongCat-Video Technical Report](/vibe-reading/articles/longcat-video-technical-report) — **同家族**·视频版同套方法论（13.6B DiT + 多奖励 GRPO + 块稀疏注意力）
- [FireRed-Image-Edit-1.0 Technical Report](/vibe-reading/articles/firered-image-edit) — **方法论镜像**·扩散图像编辑 + 多阶段 RLHF/DPO，ImgEdit/GEdit-Bench 直接对标
