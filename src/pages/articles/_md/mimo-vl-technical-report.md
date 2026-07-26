---
title: "MiMo-VL Technical Report"
source:
  type: "论文解读"
  project: "MiMo"
  url: "https://github.com/XiaomiMiMo/MiMo-VL"
  pdf: "/vibe-reading/papers/mimo-vl-technical-report.pdf"
date: "2026-07-27"
category: [AI, Models, MiMo, Papers]
tags: ["MiMo-VL", "Vision-Language Model", "MORL", "GRPO", "RLVR", "RLHF", "Native-Resolution ViT", "GUI Agent"]
description: "目的：通用视觉语言模型。手段：原生分辨率 ViT + MLP projector + MiMo-7B + 四阶段预训练 2.4T tokens + MORL 混合在线强化学习（RLVR+RLHF）。结论：MiMo-VL-7B-RL 在 35/40 任务超 Qwen2.5-VL-7B，OlympiadBench 59.4、OSWorld-G 56.1、MMMU 66.7，开源 VLM Elo 第一。"
readingTime: "17 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/mimo-vl-technical-report.pdf" target="_blank" rel="noopener">预览</a> · **论文** [MiMo-VL Technical Report](https://github.com/XiaomiMiMo/MiMo-VL) · **作者** Xiaomi LLM-Core Team · **发表** 2025-06 · **项目** https://github.com/XiaomiMiMo/MiMo-VL · **解读** 2026-07-27

---

## 1. 论文概览

**一句话**：MiMo-VL 把"原生分辨率视觉编码 + 多阶段预训练 + 混合在线强化学习"三件事拼成一个 7B 视觉语言模型——在推理、GUI 智能体、通用视觉任务上同时打出开源 SOTA，甚至逼近闭源。

- **任务**：通用视觉语言模型（VLM）——图像理解、视频理解、多模态推理、GUI 智能体、文本推理一体化。
- **核心创新**：(1) 原生分辨率 ViT（Qwen2.5-ViT）+ MLP projector + MiMo-7B-Base 架构；(2) 四阶段预训练（projector warmup → VL 对齐 → 多模态预训练 1.4T → 长上下文 SFT 8K→32K，共 2.4T tokens）；(3) **MORL（Mixed On-policy RL）**——纯在线 GRPO 同时优化 RLVR + RLHF，统一 Reward-as-a-Service。
- **结果**：MiMo-VL-7B-RL 在 **35/40 任务**上超越 Qwen2.5-VL-7B；OlympiadBench **59.4**（超 Qwen2.5-VL-72B 37.2、QVQ-72B 20.4）、OSWorld-G **56.1**（超 UI-TARS 等 GUI 专用模型）、MMMU **66.7**、AIME24 **67.5**；开源 VLM 中 **Elo 评分第一**，逼近 Claude 3.7 Sonnet。代码权重开源。

**take-home**：VLM 的"推理能力"既不是靠堆视觉编码器规模、也不是靠单纯 SFT——而是在预训练里把"合成长推理数据"塞进最后阶段、再用**纯在线 RL（on-policy）**把奖励信号直接打到策略上。论文最反直觉的发现是：**vanilla GRPO 在约 2 万样本处早平台，而 on-policy RL 持续上升**——off-policy 与 on-policy 的 scaling 行为截然不同。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We introduce MiMo-VL, a series of vision-language models built on a native-resolution ViT and a 7B language model, designed to deliver strong performance across general vision-language tasks, reasoning, and GUI interaction. The pretrained model, MiMo-VL-7B-SFT, is trained through a four-stage pretraining pipeline with a total of 2.4T tokens, covering projector warm-up, vision-language alignment, multimodal pretraining, and long-context supervised fine-tuning. The post-trained model, MiMo-VL-7B-RL, leverages Mixed On-policy Reinforcement Learning (MORL), which unifies rule-based and model-based rewards within a single on-policy framework to simultaneously optimize both verifiable and human-preference objectives. MiMo-VL-7B-RL achieves 59.4 on OlympiadBench, surpassing models up to 78B parameters. It also attains 56.1 on OSWorld-G, outperforming the specialized GUI agent UI-TARS. Across 50+ evaluated tasks, MiMo-VL-7B-RL outperforms Qwen2.5-VL-7B on 35 of 40 public benchmarks and achieves the highest Elo rating among open-source VLMs. The model checkpoints and evaluation framework are released to support reproducible research.

> **译：** 我们提出 MiMo-VL，一系列基于原生分辨率 ViT 与 7B 语言模型的视觉语言模型，旨在通用视觉语言任务、推理与 GUI 交互上提供强性能。预训练模型 MiMo-VL-7B-SFT 通过四阶段预训练流水线训练，共 2.4T tokens，覆盖 projector 预热、视觉-语言对齐、多模态预训练与长上下文监督微调。后训练模型 MiMo-VL-7B-RL 采用混合在线强化学习（MORL），在单一在线框架内统一规则奖励与模型奖励，同时优化可验证目标与人类偏好目标。MiMo-VL-7B-RL 在 OlympiadBench 上取得 59.4，超越最高 78B 参数的模型；在 OSWorld-G 上取得 56.1，超越 GUI 专用智能体 UI-TARS。在 50+ 评估任务中，MiMo-VL-7B-RL 在 40 个公开基准的 35 个上超越 Qwen2.5-VL-7B，并在开源 VLM 中取得最高 Elo 评分。模型权重与评估框架已开源。

</details>

## 2. 研究背景

当前开源 VLM（Qwen2.5-VL、InternVL3、Gemma-3 等）在通用视觉任务上已具竞争力，但论文识别出三处未被同时解决的缺口：

| 缺口 | 现状 | MiMo-VL 的应对 |
|---|---|---|
| **多模态推理** | 多数 VLM 在 OlympiadBench、MathVision 等推理基准上远落后于闭源与专用推理模型（QVQ-72B） | 预训练阶段 4 注入合成长推理数据 + RL 阶段 RLVR 优化 |
| **GUI 智能体** | GUI 交互需细粒度 grounding（坐标定位），通用 VLM 常落后于 UI-TARS 等专用模型 | 图像 grounding 用 GIoU 奖励进 RLVR，OSWorld-G 56.1 超 UI-TARS |
| **训练范式** | SFT 后做 RLHF 或 RLVR 二选一，且常用 off-policy / 混合采样，scaling 不稳 | MORL：纯 on-policy GRPO，统一 RLVR + RLHF |

**关键观察**：VLM 的"视觉感知"与"推理"是两件事——前者靠视觉编码器 + 预训练对齐，后者靠推理数据 + RL。论文把两者拆开：预训练专攻感知与对齐，后训练专攻推理与偏好。而把推理"逼出来"的关键不是更多 SFT 数据，而是**让 RL 奖励直接作用在策略自身采样上**（on-policy）。

> **缺口**：尚无开源 VLM 同时做到"通用视觉 + 推理 + GUI + 人类偏好对齐"四项强。MiMo-VL 的动机正是用 MORL 把这四件事统一进一个 7B 模型。

## 3. 方法详解

MiMo-VL = **原生分辨率 ViT** + **MLP projector** + **MiMo-7B-Base LLM**；预训练产 MiMo-VL-7B-SFT，后训练（MORL）产 MiMo-VL-7B-RL。

![Figure 2：MiMo-VL 架构。原生分辨率 ViT（Qwen2.5-ViT）处理任意分辨率图像 → pooling → MLP projector 投影到 LLM 嵌入空间 → 与文本 token 拼接送入 MiMo-7B-Base LLM。](/vibe-reading/images/articles/mimo-vl-technical-report/fig-02-model-architecture.png)

### 3.1 架构：原生分辨率 ViT + MLP + MiMo-7B

- **视觉编码器**：**Qwen2.5-ViT**，原生分辨率（native-resolution）——不强制 resize 到固定尺寸，保留细粒度视觉信息（对 OCR、GUI grounding 关键）。图像被切成动态数量的 patch token。
- **Projector**：MLP 结构，把 ViT 的 pooled 视觉表示投影到 LLM 嵌入空间。这是 VL 对齐的桥梁。
- **LLM 主干**：**MiMo-7B-Base**（36 层、dim 4096、32 heads、FFN 11008），继承其强文本推理能力——这是 MiMo-VL 在 AIME24/25 等纯文本推理基准上甚至超越 Qwen2.5-72B 的根基。

视频输入：以 2 FPS 采样、最多 256 帧、总 token 上限 16384。

### 3.2 四阶段预训练（共 2.4T tokens）

| 阶段 | 目标 | 关键点 |
|---|---|---|
| **Stage 1 Projector warmup** | 单独训 projector | 冻结 ViT 与 LLM，让 projector 先学会视觉→语言空间的初步对齐 |
| **Stage 2 VL alignment** | ViT + projector + LLM 联合 | 浅层视觉-语言对齐，少量高质量数据 |
| **Stage 3 多模态预训练** | 全参数大规模训练 | **1.4T tokens**，图像/视频/文本交错，建立通用视觉能力 |
| **Stage 4 长上下文 SFT** | 长序列 + 推理数据 | 上下文 8K → 32K，**注入合成长 CoT 推理数据**——这是推理能力涌现的关键 |

**Stage 4 的核心作用**（Figure 6）：在合成长推理数据加入后，模型在 DynaMath、MMMU、MathVista、OlympiadBench、WeMath、OSWorld-G 等基准上随训练 tokens 持续上升——证明"推理"是在预训练最后阶段被显式注入而非自然涌现。

### 3.3 MORL：混合在线强化学习

后训练阶段，MiMo-VL-7B-RL 用 **MORL（Mixed On-policy RL）**同时优化 RLVR（可验证奖励）与 RLHF（人类偏好）。

![Figure 3：Mixed On-policy RL 框架。Seamless Rollout Engine 驱动纯在线采样；Reward Router 按任务类型路由到规则奖励（GIoU、Acc、IoU 等）或模型奖励（Bradley-Terry）；统一 Reward-as-a-Service，所有奖励归一化到 [0,1]。](/vibe-reading/images/articles/mimo-vl-technical-report/fig-03-morl-framework.png)

**三大组件**：

1. **纯在线 GRPO**：完全 on-policy 采样——每个问题的 G 条响应都从当前策略 $\pi_\theta$ 现采，不用 off-policy 重放。论文证明这比 vanilla GRPO（含 off-policy 成分）有更好的 scaling（Figure 7）。
2. **Reward-as-a-Service（RaaS）**：Reward Router 按任务类型动态选择奖励函数——规则奖励（GIoU、Accuracy、IoU）或模型奖励（Bradley-Terry）。奖励模型作为独立 HTTP 服务部署，近零延迟。**所有奖励归一化到 [0,1]，不引入任何 format reward**（防 reward hacking）。
3. **双奖励模型**：文本奖励模型（从 MiMo-7B 初始化）+ 多模态奖励模型（从 MiMo-VL-7B 初始化），都用 Bradley-Terry 目标训练。**关键防 hacking 设计**：奖励模型训练与 RLHF 用**同一批 query set**，确保偏好信号与可验证信号在同一分布上。

**RLVR 的五类可验证奖励**：

| 任务类型 | 奖励 | 计算 |
|---|---|---|
| 视觉推理（数学题） | Math-Verify | 规则判答，答案精确匹配 |
| 文本推理 | 规则判答 | 答案精确匹配 |
| 图像 grounding（RefCOCO、ScreenSpot） | **GIoU** | 预测框与真值框的广义交并比 |
| 视觉计数（PixmoCount、CountBench） | Accuracy | 计数精确匹配 |
| 时序视频 grounding | **IoU** | 预测时间段与真值的交并比 |

MORL 集成在 **verl 框架**上，配合 **Seamless Rollout Engine**（Xiaomi 自研）实现高效在线采样。

## 4. 关键公式解读

**(1) GRPO 目标**——纯在线变体，每个问题 $q$ 从策略 $\pi_\theta$ 采 $G$ 条响应 $\{o_1, ..., o_G\}$，按组相对优势更新策略：

$$
J_{\text{GRPO}}(\theta) = \mathbb{E}_{q \sim \mathcal{D},\; \{o_i\}_{i=1}^{G} \sim \pi_\theta(\cdot | q)} \left[ \frac{1}{\sum_{i=1}^{G} |o_i|} \sum_{i=1}^{G} \sum_{j=1}^{|o_i|} A_{i,j} \right]
$$

其中 $A_{i,j}$ 是响应 $o_i$ 中第 $j$ 个 token 的优势，由组内奖励 $\{r_1, ..., r_G\}$ 计算。

**(2) 组相对优势**——GRPO 的核心：不用 critic 估计 baseline，而是用**同一问题的组内奖励均值/归一化**作 baseline：

$$
A_i = \frac{r_i - \text{mean}(r_1, ..., r_G)}{\text{std}(r_1, ..., r_G)}
$$

这省掉了价值网络、降低训练成本，同时让策略聚焦"比组内平均更好"的响应。

**(3) 奖励归一化与统一**——所有奖励（规则 + 模型）归一化到 $[0, 1]$：

$$
r_{\text{final}} = \lambda_{\text{RLVR}} \cdot r_{\text{rule}} + \lambda_{\text{RLHF}} \cdot r_{\text{model}}
$$

**关键设计**：不引入 format reward（许多 RLVR 工作用 format reward 鼓励特定输出格式，但易被 hack）。MORL 靠 RLVR 与 RLHF 的天然分工——前者管"答案对不对"、后者管"回答好不好"——避免 reward hacking。

**(4) Bradley-Terry 奖励模型**——RLHF 用的偏好模型，对响应对 $(o_w, o_l)$（$w$ 胜 $l$）训练：

$$
\mathcal{L}_{\text{BT}} = -\log \sigma(r_{\text{model}}(o_w) - r_{\text{model}}(o_l))
$$

**关键洞察**：MORL 的"混合"不是 RLVR + RLHF 简单加权，而是**统一在 on-policy 框架内**——奖励模型与策略共享同一批在线采样的 query set，确保偏好信号与可验证信号在同一分布上对齐。这是它相对"分别跑 RLVR 与 RLHF 再合并"方案的本质优势。

## 5. 实验设置

- **数据**：预训练共 **2.4T tokens**（Stage 3 多模态预训练 1.4T，Stage 4 长上下文 SFT 含合成长推理数据）。后训练用 curated SFT 语料 + RLVR/RLHF query set。
- **模型规模**：MiMo-7B-Base LLM（36 层、dim 4096）；ViT 用 Qwen2.5-ViT；两发布模型——MiMo-VL-7B-SFT（预训练产物）与 MiMo-VL-7B-RL（MORL 后训练产物）。
- **评估**：**50+ 任务**，覆盖通用视觉语言、文档 OCR、GUI grounding、视频、多模态推理、纯文本推理。评估框架基于 LMMs-Eval 改造以适配 long-CoT 推理模型。
  - 图像：max pixels 4096×28×28，max new tokens 32768，greedy decoding。
  - 视频：2 FPS，最多 256 帧，总 token 16384。
  - 文本：max new tokens 32768，temperature 0.6，top-p 0.95。
- **Elo 评分**：自建中英文均衡用户 prompt 评估集，GPT-4o 评判、style-controlled，覆盖多模态推理、图像理解、GUI 交互。

## 6. 实验结果

### 6.1 通用视觉语言能力（Table 2，节选）

MiMo-VL-7B-SFT/RL 在通用 VLM 基准上开源领先，多项逼近 GPT-4o / Claude 3.7 Sonnet：

| 基准 | MiMo-VL-7B-SFT | MiMo-VL-7B-RL | Qwen2.5-VL-7B | InternVL3-8B | GPT-4o | Claude 3.7 |
|---|---|---|---|---|---|---|
| MMMU val | 64.6 | **66.7** | 58.6 | 62.7 | 70.7 | 69.8 |
| MMMU-Pro standard | 45.2 | **46.2** | 34.7 | 45.6 | 42.5 | 56.5 |
| MMBench-en | 84.5 | 84.4 | 83.5 | 83.4 | 84.6 | 84.8 |
| MME-RealWorld en | 57.4 | **59.1** | 57.4 | 56.1 | 57.5 | 50.8 |
| AI2D | 83.2 | 83.5 | 83.9 | **85.2** | 82.6 | 81.4 |
| V* | 80.6 | **81.7** | 73.8 | 72.8 | 73.9 | — |
| VLMs are Blind | 78.0 | **79.4** | 37.4 | 36.8 | 49.8 | 72.1 |
| PixmoCount | 79.4 | 79.4 | 60.7 | 62.0 | 54.4 | 53.5 |
| DocVQA val | 95.2 | **95.7** | 95.5 | 89.4 | 93.0 | 94.1 |
| InfoVQA val | 87.2 | **88.0** | 81.4 | 70.7 | 82.1 | 65.5 |

![Figure 1：MiMo-VL-7B 与代表性 VLM 在通用视觉语言基准上的性能对比。MiMo-VL-7B-RL 在多项指标上开源领先，逼近 GPT-4o 与 Claude 3.7 Sonnet。](/vibe-reading/images/articles/mimo-vl-technical-report/fig-01-benchmark-performance.png)

**关键发现**：MiMo-VL-7B-RL 在 **40 个公开基准的 35 个**上超越 Qwen2.5-VL-7B。视觉计数（PixmoCount 79.4 vs 60.7）、V*（81.7 vs 73.8）、VLMs are Blind（79.4 vs 37.4）等需要细粒度视觉感知的任务优势尤其明显——印证原生分辨率 ViT + RLVR grounding 奖励的价值。

### 6.2 多模态推理（Table 3）

推理是 MiMo-VL 的核心卖点——7B 模型在多项推理基准上超越 72B 乃至逼近闭源：

| 基准 | MiMo-VL-7B-SFT | MiMo-VL-7B-RL | QVQ-72B | Qwen2.5-VL-72B | GPT-4o | Gemini-2.5-Pro |
|---|---|---|---|---|---|---|
| OlympiadBench | **59.4** | **59.4** | 20.4 | 37.2 | 25.9 | 69.8 |
| MathVision | 57.9 | **60.4** | 35.9 | 38.1 | 31.2 | 69.1 |
| MathVerse | 67.1 | **71.5** | 45.1 | 57.6 | 49.9 | 76.7 |
| DynaMath | **46.9** | 45.9 | 30.7 | 38.1 | 48.5 | 56.3 |
| WeMath | 65.1 | **66.3** | 37.7 | 50.6 | 50.6 | 78.0 |
| MathVista mini | **81.8** | 81.5 | 71.4 | 74.8 | 63.8 | 80.9 |
| MATH500 | 95.0 | **95.4** | 83.8 | 83.0 | 78.2 | 95.2 |
| AIME24 | 66.4 | **67.5** | 25.2 | 16.7 | 10.9 | 92.0 |
| AIME25 | 50.9 | **52.5** | 18.1 | 10.8 | 8.7 | 86.7 |

**关键发现**：

- **OlympiadBench 59.4**——超越最高 78B 参数的开源模型（QVQ-72B 仅 20.4、Qwen2.5-VL-72B 37.2），仅次于 Gemini-2.5-Pro。
- **AIME24 67.5 / AIME25 52.5**——纯数学竞赛推理，7B 模型碾压 QVQ-72B（25.2/18.1）、Qwen2.5-VL-72B（16.7/10.8）、GPT-4o（10.9/8.7），甚至超越 Qwen2.5-72B（19.4/13.3）。这是预训练阶段 4 注入合成长推理数据 + RLVR 的直接成果。
- **RL 提升**：MiMo-VL-7B-RL 在 MathVision（57.9→60.4）、MathVerse（67.1→71.5）、WeMath（65.1→66.3）、MATH500/AIME24/AIME25 上均较 SFT 版提升——MORL 把推理能力进一步逼出。

### 6.3 GUI 智能体（Figure 4）

GUI grounding 是 MiMo-VL 的另一亮点——通用 VLM 在此常落后于专用 GUI 智能体：

| 模型 | ScreenSpot | ScreenSpot-v2 | ScreenSpot-Pro | OSWorld-G | VisualWebBench | WebSRC |
|---|---|---|---|---|---|---|
| **MiMo-VL-7B-RL** | **87.2** | **90.5** | **41.9** | **56.1** | **80.2** | **95.4** |
| Qwen2.5-VL-7B | 84.7 | 88.0 | 29.0 | 37.5 | 72.8 | 94.6 |
| UI-TARS-1.0 | 84.4 | 87.3 | 22.9 | 34.5 | 79.7 | 93.6 |
| Aguvis | 82.5 | 84.1 | 18.9 | 27.7 | 68.7 | 89.1 |
| OS-Atlas | 84.7 | 88.8 | 35.7 | 49.6 | 79.7 | 93.6 |

**关键发现**：MiMo-VL-7B-RL 在 OSWorld-G（**56.1**）上超越 UI-TARS-1.0（34.5）、Aguvis（27.7）等 GUI 专用模型——这是图像 grounding 的 GIoU 奖励进 RLVR 的直接成果。通用 VLM 在 GUI 上反超专用模型，是 MiMo-VL 的标志性成就之一。

### 6.4 Elo 评分（Figure 5）

![Figure 5：VLM Elo 评分对比。MiMo-VL-7B-RL 在开源 VLM 中取得最高 Elo，逼近 Claude 3.7 Sonnet 等闭源模型。](/vibe-reading/images/articles/mimo-vl-technical-report/fig-05-elo-ratings.png)

基于中英文均衡用户 prompt + GPT-4o 评判的 pairwise 比较：

- **MiMo-VL-7B-RL 在开源 VLM 中 Elo 第一**，超过 Qwen2.5-VL-72B、Qwen2.5-VL-32B、Gemma-3-27B-IT、InternVL3-8B 等所有开源对手（7B–72B）。
- 逼近闭源模型 Claude 3.7 Sonnet、GPT-4o。
- **MORL 给 MiMo-VL-7B-SFT 带来 +22 Elo 分**——RL 后训练对用户偏好的提升显著。

## 7. 讨论与关键发现

### 7.1 预训练阶段注入推理数据（Figure 6）

![Figure 6：MiMo-VL-7B-SFT 在 Stage 4（长上下文 SFT）的训练曲线。DynaMath、MMMU、MMMU-Pro、MathVista、OSWorld-G、OlympiadBench、WeMath 随训练 tokens 持续上升。](/vibe-reading/images/articles/mimo-vl-technical-report/fig-06-stage4-training-curves.png)

Stage 4 注入合成长 CoT 推理数据后，模型在推理基准上随训练 tokens 持续上升——证明"推理能力"是被显式注入而非自然涌现。这与 MiMo-Audio 的"涌现"叙事形成对照：MiMo-Audio 靠规模涌现，MiMo-VL 靠显式推理数据注入。

### 7.2 On-policy RL vs Vanilla GRPO（Figure 7，最反直觉）

![Figure 7：On-policy RL 与 vanilla GRPO 的 scaling 行为对比。On-policy RL 性能随训练样本持续上升，vanilla GRPO 在约 2 万样本处早平台。](/vibe-reading/images/articles/mimo-vl-technical-report/fig-07-onpolicy-vs-vanilla-grpo.png)

论文最反直觉的发现：在 AIME24-25 上对比 on-policy RL 与 vanilla GRPO（含 off-policy 成分）——

- **Vanilla GRPO**：在约 **2 万样本处早平台**（early plateau），继续加数据性能不再提升。
- **On-policy RL**：随训练样本**持续上升**，无平台迹象。

**关键洞察**：off-policy 数据的分布偏移会限制 RL 的 scaling——策略学到的是"旧分布上的优化"，而非"当前策略的真实改进"。纯 on-policy 让奖励信号直接作用在策略自身采样上，scaling 才持续。这解释了为何 MORL 坚持**完全 on-policy**。

### 7.3 任务干扰与奖励统一

MORL 同时优化 5 类 RLVR 奖励 + RLHF，潜在任务干扰是核心风险。论文的应对：

- **统一 on-policy 框架**：所有任务在同一批次内采样、同一策略更新，避免任务间分布漂移。
- **奖励归一化到 [0,1]**：不同任务的奖励幅度一致，避免某类任务主导梯度。
- **共享 query set**（奖励模型训练与 RLHF）：偏好与可验证信号同分布，减少冲突。
- **无 format reward**：避免模型钻格式奖励的空子。

实证上 MiMo-VL-7B-RL 在所有任务类别上均较 SFT 提升，未见明显干扰——证明这套统一方案有效。

## 8. 总结与展望

**贡献总结**：

1. 提出 MiMo-VL——原生分辨率 ViT + MLP + MiMo-7B 架构 + 四阶段预训练（2.4T tokens），最后阶段显式注入合成长推理数据，让 7B 模型在 OlympiadBench/AIME 上超越 72B 开源对手。
2. **MORL**：首个在单一 on-policy 框架内统一 RLVR（5 类规则奖励）+ RLHF（双 Bradley-Terry 奖励模型）的 VLM 后训练方案，用 Reward-as-a-Service 与奖励归一化化解任务干扰与 reward hacking。
3. **On-policy vs Vanilla GRPO 的 scaling 发现**：on-policy RL 持续上升、vanilla GRPO 早平台——为 VLM RL 训练提供可复制的实证指导。
4. 50+ 任务评估，35/40 超 Qwen2.5-VL-7B；OSWorld-G 56.1 反超 GUI 专用模型；开源 VLM Elo 第一；代码权重与评估框架开源。

**idea 三法落地（未来工作）**：

- **弥补缺陷**：当前 7B 规模，绝对分仍低于 Gemini-2.5-Pro 等闭源——需更大规模 + 更多推理数据；on-policy RL 的持续 scaling 上限尚未探明。
- **新型方案**：MORL 的"统一 on-policy"思路可扩展到更多模态（音频、具身）；双奖励模型（文本 + 多模态）架构可推广到其他多模态 RL 场景。
- **减少约束**：当前 RLVR 依赖规则判答（Math-Verify、GIoU、IoU、Accuracy），对开放式生成任务（创意写作、视觉创作）无有效可验证奖励——需探索更通用的自动判答机制。

**适用边界（批判性）**：MiMo-VL 的推理优势**不**由"7B + on-policy RL"自动保证，而取决于两个前提——(1) 预训练阶段 4 必须显式注入合成长推理数据（否则 RL 无推理信号可逼出）；(2) RLVR 必须有可靠规则判答（数学题、grounding 坐标可判，开放式任务不行）。Figure 7 的 on-policy vs vanilla 对比虽清晰，但仅在 AIME24-25 上验证——是否对所有任务类型都成立尚未覆盖。此外 OSWorld-G 反超 GUI 专用模型，部分得益于原生分辨率 ViT 对 GUI 截图的细粒度处理，而非单纯 RL 功劳——架构、数据、RL 三者协同才造就优势，单拎任一因素都会高估。Elo 评分依赖 GPT-4o 评判，存在风格偏置已用 style-controlled 缓解但未根除。
