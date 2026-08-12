---
title: "LongCat-Video-Avatar 1.5 Technical Report"
source:
  type: "论文解读"
  project: "LongCat"
  url: "https://arxiv.org/abs/2605.26486"
  pdf: "/vibe-reading/papers/longcat-video-avatar-1-5-technical-report.pdf"
date: "2026-08-12T20:06:36+08:00"
category: [AI, Models, Video Model, Papers]
tags: ["Talking Head", "Audio-Driven", "Digital Human", "DiT", "GRPO", "Whisper", "DMD2", "RLHF"]
description: "目的：开源生产级音驱数字人视频生成。手段：DiT + Whisper-large 音频编码 + 逐帧 GRPO + DMD2 八步蒸馏。结论：8 NFE 达到比肩闭源的人类相似度与稳定性。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/longcat-video-avatar-1-5-technical-report.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LongCat-Video-Avatar 1.5 Technical Report](https://arxiv.org/abs/2605.26486) · **作者** Meituan LongCat Team · **发表** arXiv, 2026-05 · **项目** [meigen-ai.github.io](https://meigen-ai.github.io/LongCat-Video-Avatar-1.5-Page/) · **代码** [github.com/meituan-longcat/LongCat-Video](https://github.com/meituan-longcat/LongCat-Video) · **解读** 2026-08-12

---

## 1. 论文概览

**TL;DR**：LongCat-Video-Avatar 1.5 是美团 LongCat 团队开源的音驱数字人视频生成框架，**主打"工程成熟度"而非架构新颖性**。它通过把音频编码器升级到 Whisper-large、把 LongCat-Video 的视频级 GRPO 下沉到**逐帧奖励**、并用 DMD2 蒸馏把推理压到 **8 NFE**，在 508 例人类评测基准上达到与 HeyGen / OmniHuman 1.5 / Kling Avatar 2.0 等闭源系统"竞争或更优"的水平。

- **任务**：audio-driven human animation——给一张肖像 + 一段语音，合成唇形、表情、头部姿态、身体动态都与语音对齐的写实数字人视频。
- **核心取舍**：论文开宗明义说"prioritizing systematic engineering and production-readiness over architectural novelty"——不追新架构，靠**数据精炼 + 训练 scaling + 端到端优化**把研究原型推到可部署。
- **take-home**：开源数字人要追上闭源，关键不在模型变大，而在**音频表征精度（Whisper）+ 奖励粒度（逐帧 GRPO）+ 蒸馏效率（单 backbone LoRA 切换）**三件事同时做对。

![图2 多场景生成示例：直播、表演、演唱、电商、多人对话、动画、动物](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-02-demo-scenarios.png)

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Despite advances in audio-driven video generation, achieving commercial-grade stability remains challenging. We present LongCat-Video-Avatar 1.5, an upgraded open-source framework prioritizing systematic engineering and production-readiness over architectural novelty. By upgrading the audio encoder to Whisper Large and meticulously scaling our training recipes, v1.5 achieves accurate lip-synchronization, full-body temporal stability, and robust long-video generation with strict identity consistency. Through rigorous data curation and RLHF Training, the model readily generalizes to stylized domains such as anime and animals, and natively handles complex real-world conditions—such as multi-person interactions and object handling. Furthermore, addressing the practical demands of industrial deployment, we employ advanced step distillation to accelerate inference to an optimal 8 NFE, achieving a favorable trade-off between serving efficiency and visual fidelity. The superiority of our approach is validated through extensive quantitative metrics and a rigorous human evaluation conducted on a comprehensive benchmark of over 500 diverse test cases. Results show that v1.5 achieves competitive or superior performance compared to leading closed-source systems (e.g., HeyGen, OmniHuman 1.5, Kling Avatar 2.0) across human-likeness ratings and expert-level quality assessments on our benchmark. With its open-source release, LongCat-Video-Avatar 1.5 narrows the gap between academic research prototypes and commercial-grade deployment.

> **译：** 尽管音驱视频生成已有显著进展，达到商业级稳定性仍极具挑战。我们提出 LongCat-Video-Avatar 1.5，一个升级的开源框架，优先系统性工程与生产就绪，而非架构新颖性。通过将音频编码器升级为 Whisper Large 并精心 scaling 训练配方，v1.5 实现了精确的唇形同步、全身时序稳定性、以及严格的身份一致性下的鲁棒长视频生成。通过严格的数据筛选与 RLHF 训练，模型可泛化到动漫、动物等风格化域，并原生处理多人交互、手持物体等复杂真实场景。此外，针对工业部署的实际需求，我们采用先进的步数蒸馏将推理加速到最优的 8 NFE，在服务效率与视觉保真度间取得有利折中。我们在超过 500 个多样测试案例的基准上进行了详尽的定量指标与严格的人类评估，结果表明 v1.5 在人类相似度评级与专家级质量评估上达到与领先闭源系统（如 HeyGen、OmniHuman 1.5、Kling Avatar 2.0）竞争或更优的性能。随着开源发布，LongCat-Video-Avatar 1.5 缩小了学术研究原型与商业级部署之间的差距。

</details>

---

## 2. 研究背景

**问题定义**：音驱数字人动画（audio-driven human animation）的输入是一张肖像图 + 一段驱动语音，输出是唇形、表情、头姿、身体动态都随语音连贯演化的写实视频。它是数字人、虚拟通信、具身交互的核心能力。

**现有方法的不足**——论文点出一个核心矛盾：

- 在精选 benchmark 上表现好的模型，在**长时段或开放域**条件下鲁棒性往往退化；
- 真实世界表现强的系统（HeyGen 等）通常是**闭源**的，社区无法复现。

商业部署要求的远不止"视觉上还行的短视频"：必须在长时段保持身份稳定、全身时序一致、在不同说话风格下精确唇同步，并在多人交互、手持物体、风格化角色、非理想源图等挑战场景下保持鲁棒，同时推理成本要够低。

**相关工作与关键人物**：论文引用的对比对象构成 v1.5 的主要竞品图谱——

| 系统 | 定位 | v1.5 对比角度 |
| --- | --- | --- |
| OmniHuman 1.5 | 闭源、Pseudo Frame 机制 | stability 维度对比（v1.5 用 reference skip attention 抑制误差传播） |
| HeyGen | 闭源商业 | 人类相似度 A/B 对比 |
| Kling Avatar 2.0 | 闭源 | A/B 中差距最大（v1.5 优势最显著） |
| InfiniteTalk | 开源 | single/multi-person human-likeness 对比 |
| MultiTalk | 开源、多人 | L-RoPE 机制来源，v1.5 在其上扩展 |
| OmniAvatar | 开源 | 基线之一 |

**为什么需要这篇**：v1.0（LongCat-Video-Avatar）已开源，但仍有局限——论文明确指出 v1.0 与 MultiTalk、OmniHuman 1.5 一起在**多人交互、静默非说话动作、情绪表达**三个场景仍不足。v1.5 的增量正是针对这三块加专用数据管线，再把音频编码、奖励粒度、推理加速三件事系统性升级。

---

## 3. 方法详解

### 3.1 架构：在 v1.0 的统一 DiT 上插入音频交叉注意力

v1.5 **继承 v1.0 的统一 DiT 视频扩散架构**，不换主干——这也是"工程优先"的体现。主干结构：

- **3D VAE** 把视频压到隐空间；
- 每个 **DiT block** = 3D self-attention + text cross-attention + FFN；
- 文本用 **UMT5** 编码，视觉 token 用 **3D RoPE** 编时空位置。

**统一输入配置**支持三种任务，靠 latent 拼接切换：

- **T2V（文生视频）**：只给 noise latent；
- **TI2V（图文生视频）**：reference latent 与 noise latent 时间维拼接；
- **Video Continuation（视频续写）**：context latent 与 noise latent 拼接作为额外条件。

**关键改造**——在每个 DiT block 的 text cross-attention 之后，**插入一个额外的 audio cross-attention 层**，让音频线索融入视觉生成。为防止训练不稳定与灾难遗忘，在音频交叉注意力前**保留 adaLN 模块**作为门控，渐进式引入音频控制：

![图5 LongCat-Video-Avatar 1.5 整体流水线：统一 DiT 主干 + 音频交叉注意力](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-05-architecture.png)

### 3.2 音频特征提取：从 Wav2Vec2 到 Whisper-large

这是 v1.5 **最关键的单一升级**。v1.0 用 94M 参数的 Wav2Vec2，v1.5 换成 **1.5B 参数、在 68 万小时多语言语音上预训练的 Whisper-large**，直接在原始音频波形的 Mel 频谱图上工作，带来更丰富的声学表征、更强的音素级表现力与多语言鲁棒性。

**处理流水线**（克服 Whisper 30 秒上下文限制）：

1. **滑动窗口**：把输入频谱图按时间切分，逐段送 Whisper 编码器；
2. 取 **33 个隐藏状态**（embedding 层 + 32 层 transformer），帧率 50 Hz；
3. **分组均值池化**：33 层分成 4 组（每组 8 层）+ 1 个单例层，每组 mean-pool 成 1 个通道，共得 **5 通道**特征；
4. **线性插值**：50 Hz → 视频帧率 25 FPS；
5. **audio projector**：聚合时间窗内邻域上下文并下采样，匹配视频 VAE 的 4× 时间下采样，最终得 `(T, 5, 1280)` 的音频 embedding，与视觉 latent 严格时间对齐后注入 audio cross-attention。

![图6 Wav2Vec2 与 Whisper-large 唇形同步对比：Whisper-large 音素级更精确、口型更自然](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-06-audio-encoder-lipsync.png)

### 3.3 逐帧 GRPO：把奖励从视频级标量下沉到时间结构化信号

v1.5 的 RLHF 训练**沿用 LongCat-Video 的多奖励 GRPO 框架**，核心扩展是：**从视频级奖励建模变为逐帧奖励建模**。

LongCat-Video 里每个奖励模型 $R_k$ 产出的是视频级标量；v1.5 把奖励沿时间分区分解。设 $r^i_{k,j}$ 为样本 $i$ 在奖励模型 $R_k$ 第 $j$ 个时间分区上的奖励，沿用 LongCat-Video 的组相对归一化：

### 3.4 少步生成：单 backbone + LoRA 切换的 DMD2 蒸馏

受 DMD2（Distribution Matching Distillation 2）启发，把多步扩散蒸馏成少步生成器。DMD2 通过最小化反向 KL 散率对齐生成器与教师分布，但标准实现需在显存中同时维护**三个同构模型**（generator、fake score、real score）。

v1.5 的参数高效改造：**单一 base DiT backbone + 多个 LoRA 适配器**——动态挂载 Generator LoRA 或 Fake Score LoRA 实现角色切换，base DiT 本身提供 real-score 引导。蒸馏到 **8 个去噪步**；为缓解蒸馏常见的过饱和，文本与音频的 CFG 都降到 4.0。

### 3.5 多人对话：静默音轨解决背景角色串扰

两人对话场景沿用 MultiTalk 的 **L-RoPE** 机制把每个说话人区域与其音频条件显式关联。但参考图含多人时存在"归属歧义"：背景人物与目标说话人在 reference attention 空间相似度极高，会被错误归入目标说话人区域、被语音驱动出不该有的唇部动作。

v1.5 的解法：引入额外 bounding box 标注，把非目标人物区域建模为独立类别；并在有额外人物框时**引入一条静默音轨**作为背景专用音频条件，把所有非目标区域映射到这个静默条件。

![图7 背景角色驱动策略：(a) 无静默条件背景角色被误驱动；(b) 有静默条件背景角色保持静止](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-07-multiperson-silent.png)

---

## 4. 关键公式解读

### 公式 1 与 2：逐帧组相对优势

**逐帧 GRPO 的核心**——把奖励从标量变成时间结构化信号：

$$
\hat{A}^{i}_{k,j} = \frac{r^{i}_{k,j} - \mu_{k,j}}{\sigma^{\max}_{k,j}}
$$

其中 $\mu_{k,j}$ 是奖励 $R_k$ 在时间分区 $j$ 上的组均值，$\sigma^{\max}_{k,j}$ 是组标准差的最大值（沿用 LongCat-Video 的稳定归一化）。

多奖励加权聚合：

$$
\hat{A}^{i}_{\text{total},j} = \sum_{k} w_k \, \hat{A}^{i}_{k,j}
$$

两项合起来把 advantage 从视频级标量扩展为**时间结构化信号**，使优化能聚焦于局部运动不一致、手部变形、短程结构坍塌等**时间局部化的瑕疵**。

### 公式 3 与 4：Flow Matching 训练目标

基础模型训练采用 flow matching。给定干净视频 latent $x_0$、噪声 $\epsilon \sim \mathcal{N}(0, I)$、时间步 $t \in [0, 1]$，噪声 latent 为线性插值：

$$
x_t = (1 - t) \cdot x_0 + t \cdot \epsilon
$$

网络预测速度 $v_{\text{pred}}(x_t, c, t; \theta)$，其中 $c$ 是任务条件（文本、音频、条件图/视频 latent），$\theta$ 为模型参数。训练目标是对真实速度 $v_t = x_0 - \epsilon$ 的 MSE：

$$
\mathcal{L} = \mathbb{E}_{\epsilon, x_0, c, t} \left\| v_{\text{pred}}(x_t, c, t; \theta) - v_t \right\|^2
$$

---

## 5. 实验设置

### 数据：四条专用管线 + 一条通用管线

v1.5 的数据系统由**一条通用管线 + 三条针对"欠处理场景"的专用管线**组成。通用管线把异质视频转成结构一致、质量受控、语义对齐的训练样本，按六类来源组织（近景人脸、访谈、表演、互动、音乐、动画风格化）。

![图3 两阶段数据精炼管线概览](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-03-data-pipeline.png)

三条专用管线补 v1.0 的短板：

| 管线 | 解决的问题 | 关键技术 |
| --- | --- | --- |
| **多人数据** | 多说话人建模、说话人歧义 | ByteTrack 跟踪 + ASD（TalkNet/UniTalk + YOLOv6）→ 非重叠单说话人段 |
| **静默数据** | 无语音时的自然静止、抑制误动嘴 | 两阶段多模态校验：Qwen3-Omni 初判 + Qwen3-VL 复核，两者一致才保留 |
| **情绪数据** | 情绪的时间演化、与语音/上下文的关系 | 6 类情绪分类 + EmotiEffLib 帧级识别（置信度 > 0.7）+ 三层上下文 caption |

![图4 情绪数据筛选与标注管线概览](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-04-emotion-pipeline.png)

### 训练：三阶段渐进

| 阶段 | 目标 | 关键设置 |
| --- | --- | --- |
| **Base Model** | 音驱生成基础能力 | flow matching + velocity 预测；256p→480p→+Ref→720p→+MultiTalk 五步渐进（Table 1），LR 2×10⁻⁵ |
| **RLHF** | 对齐人类偏好 | 逐帧 GRPO（§3.3），多奖励，multi-clip rollout（最多 5 段，仅末段参与优化）+ 首帧手部检测 |
| **Acceleration** | 推理加速 | DMD2 蒸馏 400 步，generator LR 2×10⁻⁵，fake score LR 4×10⁻⁶，update 比 1:5 |

### 评测：双轨人类评估

- **基准**：基于 EvalTalker（400+ 样本）+ 50 张风格化图（卡通、动物），共 **508 对图-音**，覆盖播音/教育/娱乐/商业等场景、中英语言、写实/动画风格，按音频（语速/流畅度/情绪/副语言）与视觉（人数/姿态/背景复杂度/遮挡）两维分难度。
- **主观轨**：770 名众包评估者，1–5 拟人度量表，共 13,240 条判断；
- **客观轨**：10 位领域专家，四维结构化质量分析——**Rationality（物理合理性）/ Harmony（音视和谐）/ Stability（时序稳定）/ Consistency（身份一致）**，量化为 100 − Issue Rate；
- **A/B 配对测试**：v1.5 与三个领先商业系统直接偏好对比。
- 唇同步在 0.5× 播放速度下评估以提高精度。

### 复现性

代码与权重开源在 [github.com/meituan-longcat/LongCat-Video](https://github.com/meituan-longcat/LongCat-Video)；论文报告了完整训练超参（Table 1 的 size bucket / batch / LR / iterations、蒸馏的步数与学习率比），数据管线各模块也给出所用模型名（ByteTrack、Qwen3-Omni、Qwen3-VL、EmotiEffLib、MediaPipe），可复现性在开源数字人工作里属较高水平。

---

## 6. 实验结果

### 人类相似度：v1.5 与 v1.0、InfiniteTalk 并列第一梯队

单说话人场景下，**LC-Video-Avatar 1.5、1.0、InfiniteTalk** 三者表现可比、领先；HeyGen、OmniHuman-1.5 紧随其后。多人场景复杂度更高，两个 LC 变体保持相近水平，均显著优于第三个支持多人的 InfiniteTalk。

![图8 单人与多人场景的人类相似度跨方法对比](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-08-human-likeness.png)

论文也坦承：**当前虚拟人模型离"高度写实的人类相似度"仍有相当距离**，主要归因于两点——物理合理性不足（结构畸变、解剖扭曲）与音视同步欠佳。

### 专家级客观质量：四维雷达图

以 `(100 − Issue Rate)` 量化（越高越好），LC-Video-Avatar 1.5 在 **stability 与 rationality 上行业领先**，identity consistency 也达 SOTA；但 **audio-visual harmony 仍是全行业开放挑战**。

![图1 人类评估： 专家级四维客观质量雷达图 + 与领先闭源系统的人类相似度对比](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-01-human-evaluation.png)

### 各维度关键发现

**Rationality（物理合理性）**——v1.5 领先，主要归因于 GRPO（奖励显式惩罚不自然/物理错误的生成）与 DMD 蒸馏（减少手部畸变、抑制夸张表情）。定性对比中，Kling-Avatar 2.0 与 HeyGen 手部生成严重结构变形，OmniHuman-1.5 出现严重深度排序与遮挡失败。

![图17 物理合理性视觉对比：Kling/HeyGen 手部变形，OmniHuman 深度错乱，Ours 更稳](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-17-rationality-comparison.png)

**Stability（时序稳定性）**——v1.5 的 Frame Jumpcut 最低（归功于数据管线里专门的跳切检测算子）；Tone Error Accumulation 略高于 v1.0，是 DMD2 蒸馏换速度的**刻意折中**。OmniHuman 1.5 因 Pseudo Frame 机制出现明显误差累积，而 v1.5 继承 v1.0 的 reference skip attention 抑制误差传播。

**Harmony（音视和谐）**——v1.5 相比 v1.0 在 face-body 同步与 lip-sync 上持续改善，归因于音频模块从 Wav2Vec 换成 Whisper-large，捕获更丰富的语音/韵律表征。OmniHuman-1.5 在面部表情自然度上单项最优。

**Consistency（身份一致性）**——LC-Video-Avatar 1.5 最优，1.0、InfiniteTalk、Hedra、HeyGen、Kling Avatar 2.0 依次其后；OmniHuman 1.5 与 OmniAvatar 较弱。

### A/B 配对偏好

v1.5 对三个商业系统均获多数偏好，**对 Kling Avatar 2.0 优势最显著**，其次 OmniHuman-1.5，再次 HeyGen。

### v1.5 vs v1.0：稳定性与唇同步的纵向对比

用时空切片可视化（固定空间截面沿时间轴拼接）对比：v1.5 相机稳定性更高、更不易跳帧；唇形动态更精确、音-唇对齐更紧。

![图24 与 v1.0 的稳定性时空切片对比](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-24-stability-slice.png)

![图25 v1.0 与 v1.5 唇形同步对比](/vibe-reading/images/articles/longcat-video-avatar-1-5-technical-report/fig-25-lipsync-v1-v15.png)

---

## 7. 消融实验

### Base vs Fast：8 NFE 的质量-速度折中

| 变体 | NFE | Human-likeness (single) ↑ | Human-likeness (multi) ↑ | Rationality ↓ | Harmony ↓ | Stability ↓ | Consistency ↓ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Base**（50 步 × 3 通道） | 150 | 3.389 | 2.676 | 51.5 | 44.2 | 12.3 | 6.2 |
| **Fast**（蒸馏，默认即此） | 8 | 3.336 | 2.730 | 32.4 | 45.0 | 4.3 | 5.9 |

> 注：human-likeness 越高越好，其余四列越低越好（为 issue rate）。

**折中画像**：Base 在人类相似度与唇同步上占优，且运动多样性、面部表情、相机动态更丰富；Fast 在**视觉稳定性上显著更优**（rationality 32.4 vs 51.5、stability 4.3 vs 12.3）——手/身体/脸的畸变率更低。这说明**蒸馏不仅加速，还"收敛"了生成——以表情丰富度换稳定性**。值得注意的是 multi-person human-likeness 上 Fast 反而略高（2.730 vs 2.676）。

### 各升级的贡献线索

论文通过定性对比与维度归因指明各模块贡献（非独立消融表，而是跨维度的机制归因）：

- **GRPO** → rationality 领先（奖励惩罚不自然生成）；
- **DMD 蒸馏** → rationality 进一步提升（减手部畸变、抑夸张表情），但引入轻微 tone error 累积；
- **Whisper-large 音频升级** → harmony 改善（更细音素/韵律表征 → 更紧音-视对齐）；
- **数据管线的 jumpcut 检测算子** → Frame Jumpcut 最低；
- **reference skip attention（继承 v1.0）** → 抑制 tone error 累积；
- **静默音轨** → 多人背景角色不被误驱动。

---

## 8. 总结与展望

### 贡献总结

1. **开源生产级框架**：靠数据精炼 + scaled 训练配方，在精确唇同步、全身时序稳定、严格身份一致、风格化泛化等多维度达到强表现；
2. **质量-效率最优折中**：8 NFE 步蒸馏管线 + GRPO 提升质量，兼顾生成速度与视觉保真；
3. **大规模严谨评测**：自动指标 + 508 例人类评测，证明高效模型在自然度、稳定性、视觉写实度上对比闭源系统竞争力甚至更优。

### 局限性（批判性）

- **harmony 仍是开放挑战**——即便 v1.5 改善，音视和谐在整个领域仍未解决，OmniHuman-1.5 在面部自然度单项上仍领先 v1.5；
- **DMD 蒸馏有代价**——Base 的表情丰富度与运动多样性优于 Fast，说明 8 NFE 以"表现力"换"稳定性"，对需要夸张表演的场景可能不够；
- **物理合理性不足仍是全行业瓶颈**——尤其是手部与解剖结构，即使 GRPO + DMD 已显著缓解；
- **评测基准自建**——508 例基准虽覆盖广，但非公认第三方标准，与竞品的可比性依赖团队自行复现竞品，存在潜在偏差。

### 未来方向（创造性，idea 三法）

论文自身点出方向：当前模型对**固定参考帧过度依赖**，导致运动重复与受参考视角约束的不自然相机转场。真正无界、无限长、内在保持身份且不僵依赖静态参考帧的生成框架是关键方向。

- **弥补缺陷**：把"reference skip attention"升级为**动态参考选择**——在长视频中按内容语义自动切换参考帧，减轻单帧依赖导致的运动重复；
- **新型方案**：引入**3D 一致性先验或神经辐射场约束**到 DiT 训练，从几何层面根治物理合理性与深度遮挡问题（OmniHuman 的 Pseudo Frame 失败正是几何约束不足）；
- **减少约束**：探索**参考帧自由**（reference-free）的身份保持机制，用 contrastive 身份损失或记忆库替代显式参考帧，打开无限长生成的可能。

---

## 相关阅读

- [LongCat-Video Technical Report](/vibe-reading/articles/longcat-video-technical-report) — **前序 / 同家族**·v1.5 直接继承其统一 DiT 架构与多奖励 GRPO，把视频级奖励下沉到逐帧是本篇的核心扩展起点
- [LongCat-Image Technical Report](/vibe-reading/articles/longcat-image-technical-report) — **方法论镜像**·同为多阶段 RLHF/GRPO 的扩散生成，可横向对照"多奖励 + 数据精炼 + 三阶段训练"的方法论落地
- [LongCat-Flash-Omni Technical Report](/vibe-reading/articles/AI/Models/Omni-Model/Papers/longcat-flash-omni-technical-report) — **同家族**·音视频全模态模型，与本文共享 LongCat 栈底座，理解模态解耦与流式交互的另一面
- [LongCat-AudioDiT: 波形隐空间扩散 TTS](/vibe-reading/articles/longcat-audiodit-waveform-latent-diffusion-tts) — **同家族 / 方法论镜像**·同为 LongCat 音频侧扩散模型，对照"波形隐空间建模 + DiT"与"Mel 频谱 + Whisper"两条音频表征路线
- [SGLang PR #22191: 接入 LongCat-AudioDiT](/vibe-reading/articles/sglang-pr-22191-support-longcat-audiodit) — **工程实现**·LongCat 音频侧在推理引擎中的落地，与本篇数字人视频的部署需求互补
