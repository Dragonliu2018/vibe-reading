---
title: "Video Understanding with Large Language Models: A Survey"
source:
  type: "论文解读"
  project: "Vid-LLM"
  url: "https://arxiv.org/abs/2312.17432"
  pdf: "/vibe-reading/papers/video-understanding-llm-survey.pdf"
date: "2026-08-01T22:00:00+08:00"
category: [AI, Models, Video Model, Papers]
tags: ["Video Understanding", "Vid-LLM", "Multimodal LLM", "Survey", "Video-Language", "LLM"]
description: "目的：综述用 LLM 做视频理解（Vid-LLM）的方法。手段：按视频处理方式分 3 主类（Analyzer×LLM / Embedder×LLM / 混合）×5 子类（LLM 作摘要器/管理器/解码器/回归器/隐藏层）。结论：Vid-LLM 具备多粒度推理+常识，但细粒度/长视频/多模态对齐仍有挑战。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/video-understanding-llm-survey.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Video Understanding with Large Language Models: A Survey](https://arxiv.org/abs/2312.17432) · **作者** Yunlong Tang, Jing Bi, Siting Xu 等 20 位（University of Rochester / HKU / SUSTech）· **发表** arXiv 2312.17432, 2023-12（v8 2025-11）· **项目** https://github.com/yunlong10/Awesome-LLMs-for-Video-Understanding · **解读** 2026-08-01

---

## 1. 论文概览

这是一篇**综述**（survey），系统梳理「用大语言模型做视频理解」（Vid-LLM）这一新兴方向。视频已成为最主要的媒体形态，人工处理海量视频不可行，而 LLM 在语言与多模态任务上的惊人能力为视频理解打开了新路径——Vid-LLMs 展现出**开放式多粒度推理（抽象 / 时序 / 时空）+ 常识知识**的能力，逼近人类水平的视频解读。

一句话 take-home：**作者提出一个 3×5 的分类法**——按「视频如何被处理」分 3 主类（Video Analyzer×LLM、Video Embedder×LLM、(Analyzer+Embedder)×LLM），按「LLM 在系统中的功能」分 5 子类（LLM as Summarizer / Manager / Text Decoder / Regressor / Hidden Layer）——把上百个 Vid-LLM 工作纳入统一框架，并覆盖任务、数据集、基准、评测、应用与未来方向。

- **任务**：综述 Vid-LLM 的方法、训练、评测、应用。
- **贡献**：① 一个覆盖 200+ 工作的分类法；② 任务/数据集/基准/评测方法的系统对比；③ 应用场景与未决挑战的梳理；④ 维护的 GitHub 资源库 [Awesome-LLMs-for-Video-Understanding](https://github.com/yunlong10/Awesome-LLMs-for-Video-Understanding)。
- **意义**：作为视频理解×LLM 交叉领域的入口综述，为研究者提供全景地图。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

With the burgeoning growth of online video platforms and the escalating volume of video content, the demand for proficient video understanding tools has intensified markedly. Given the remarkable capabilities of large language models (LLMs) in language and multimodal tasks, this survey provides a detailed overview of recent advancements in video understanding that harness the power of LLMs (Vid-LLMs). The emergent capabilities of Vid-LLMs are surprisingly advanced, particularly their ability for open-ended multi-granularity (general, temporal, and spatiotemporal) reasoning combined with commonsense knowledge, suggesting a promising path for future video understanding. We examine the unique characteristics and capabilities of Vid-LLMs, categorizing the approaches into three main types: Video Analyzer x LLM, Video Embedder x LLM, and (Analyzer + Embedder) x LLM. Furthermore, we identify five sub-types based on the functions of LLMs in Vid-LLMs: LLM as Summarizer, LLM as Manager, LLM as Text Decoder, LLM as Regressor, and LLM as Hidden Layer. Furthermore, this survey presents a comprehensive study of the tasks, datasets, benchmarks, and evaluation methodologies for Vid-LLMs. Additionally, it explores the expansive applications of Vid-LLMs across various domains, highlighting their remarkable scalability and versatility in real-world video understanding challenges. Finally, it summarizes the limitations of existing Vid-LLMs and outlines directions for future research.

> **译：** 随着在线视频平台的蓬勃发展与视频内容量的激增，对高效视频理解工具的需求显著增强。鉴于大语言模型（LLM）在语言与多模态任务上的卓越能力，本综述详细梳理了利用 LLM 进行视频理解（Vid-LLM）的最新进展。Vid-LLM 涌现的能力出人意料地先进，尤其是其开放式多粒度（一般 / 时序 / 时空）推理结合常识知识的能力，预示着未来视频理解的有前景路径。我们考察 Vid-LLM 的独特特征与能力，将方法分为三大类：Video Analyzer×LLM、Video Embedder×LLM、(Analyzer+Embedder)×LLM；并按 LLM 在系统中的功能识别出五种子类型：LLM 作 Summarizer、Manager、Text Decoder、Regressor、Hidden Layer。本综述还对 Vid-LLM 的任务、数据集、基准与评测方法做了全面研究，并探讨了 Vid-LLM 在各领域的广泛应用，凸显其在真实视频理解挑战中的可扩展性与通用性。最后总结了现有 Vid-LLM 的局限并指出未来研究方向。

</details>

---

## 2. 研究背景

### 视频理解方法的四阶段演进

![图1 视频理解方法的四个发展阶段：传统方法 → 早期神经视频模型 → 自监督预训练 → Vid-LLM](/vibe-reading/images/articles/video-understanding-llm-survey/fig-1.png)

作者把视频理解方法的发展分为四阶段（Figure 1）：

1. **传统方法（Conventional）**：手工特征——SIFT/SURF/HOG 描述关键信息，背景减除/光流/IDT 建模运动，HMM 做时序分析，SVM/决策树/随机森林/PCA 做分类与降维。
2. **早期神经视频模型（Early Neural）**：DeepVideo 引入 CNN；two-stream 结合 CNN+IDT；LSTM/TSN 处理长视频；3D CNN（C3D/I3D）开启 3D 分支；ViT 衍生 TimeSformer/ViViT/MViT。
3. **自监督预训练（Self-supervised Pretraining）**：VideoBERT 开端，沿「预训练-微调」范式，出现 VideoMAE/MotionMAE/MaskFeat/All-in-One 等架构与训练策略。
4. **LLM for Video Understanding（Vid-LLM）**：ChatGPT 等展现出上下文学习与工具调用能力，LLM 集成视频能力后成为更通用的任务求解器，能对视觉内容做类人推理。

![图2 Vid-LLM 发展时间线（综述覆盖至 2024 年 6 月）](/vibe-reading/images/articles/video-understanding-llm-survey/fig-2.png)

### 综述定位与前人差距

前人综述要么只覆盖特定子任务（视频字幕、动作识别），要么聚焦视频扩散模型/通用多模态基础模型而非「以 LLM 为核心的视频理解」。本文填补「**基于 LLM 的通用视频理解任务**」这一综述空白，并维护一个持续更新的资源库。

---

## 3. 分类法详解（核心）

这是综述的核心贡献。分类沿两个正交维度：**视频如何被处理**（3 主类）× **LLM 起什么作用**（5 子类）。

### 3.1 三大主类（按视频处理方式）

![图4 三种 Vid-LLM 框架：Analyzer×LLM（文本分析喂给 LLM）、Embedder×LLM（向量 embedding 喂给 LLM）、混合（两者兼有）](/vibe-reading/images/articles/video-understanding-llm-survey/fig-4.png)

| 主类 | 视频处理 | 信息流 | 典型代表 |
|---|---|---|---|
| **Video Analyzer × LLM** | Video Analyzer 把视频转成**文本分析**（字幕、dense caption、跟踪结果、ASR/OCR）喂给 LLM | 单向 / 复杂 | VLog、AntGPT、ViperGPT、VideoAgent |
| **Video Embedder × LLM** | Video Embedder（ViT/CLIP 等视觉骨干）把视频编码为**向量 embedding**，经 adapter 映射到 LLM 文本空间 | LLM 直接处理 embedding | Video-LLaMA、Video-ChatGPT、VideoLLaMA 2、InternVideo2 |
| **(Analyzer + Embedder) × LLM** | 同时用 Analyzer 取文本分析 + Embedder 取 embedding，LLM 接收两者 | 混合（较罕见） | VideoChat、Vid2Seq、MM-VID、Merlin |

> 关键区别：Analyzer 路线把视频理解**转化为文本理解任务**（多可 training-free）；Embedder 路线让 LLM 直接在 embedding 空间推理（需 adapter 对齐视觉与文本语义空间）。Embedder 路线是当前主流，模型数量最多。

### 3.2 五大子类（按 LLM 功能）

![图5 Vid-LLM 完整分类树：3 主类 × 5 子类，列出全部模型；字体颜色标注支持的理解粒度（黑=抽象、红=时序、蓝=时空）](/vibe-reading/images/articles/video-understanding-llm-survey/fig-5.png)

Figure 5 是一张覆盖全部 200+ 模型的分类树，字体颜色标注每个模型支持的理解粒度（黑=抽象、红=时序、蓝=时空）。5 子类如下：

**① LLM as Summarizer（摘要器）**——LLM 对 Analyzer 产出的文本分析做摘要/总结。信息流通常**单向**（视频→Analyzer→LLM）。例：LLoVi、VLog、AntGPT、IG-VLM、Video ReCap。

**② LLM as Manager（管理器）**——LLM 充当系统协调者，主动生成命令调用各 Video Analyzer，可多轮交互。比 Summarizer 更灵活，信息流更复杂。例：ViperGPT、HuggingGPT、VideoAgent（Stanford/PKU）、DrVideo、OmAgent、AssistGPT。

**③ LLM as Text Decoder（文本解码器）**——LLM 接收 Embedder 的 embedding 作输入，按提示解码成文本输出（QA/字幕），行为类似标准 LLM，不需细粒度定位。例：Video-LLaMA、Video-ChatGPT、VideoLLaMA 2、InternVideo2、MiniGPT4-Video、LLaVA、Chat-UniVi。**这是模型最多的一类。**

**④ LLM as Regressor（回归器）**——LLM 既能输出文本，也能预测**连续值**（时间戳定位、bbox 坐标），虽本质是分类但起回归作用。例：VTimeLLM、TimeChat、LITA、SeViLA、GroundingGPT、Holmes-VAD。

**⑤ LLM as Hidden Layer（隐藏层）**——LLM 接收 embedding 但不直接输出文本，而是接一个**任务专用头**做回归（事件时间定位、bbox），同时保留文本输出能力。例：VTG-LLM、Momentor、VITRON、GPT4Video、OneLLM。

> 子类与主类的对应：Analyzer×LLM 主要是 Summarizer/Manager；Embedder×LLM 横跨 Text Decoder/Regressor/Hidden Layer；(Analyzer+Embedder)×LLM 可灵活落在任一子类。

### 3.3 训练策略

![图6 四种 Vid-LLM 微调策略：LLM 全量微调、连接式 adapter、插入式 adapter、混合方法](/vibe-reading/images/articles/video-understanding-llm-survey/fig-6.png)

- **Training-free**：多数 Analyzer×LLM 系统无需训练——视频已被解析为文本，任务退化为文本理解，依赖 LLM 的零样本/上下文/CoT 能力。
- **四种微调策略**（Figure 6）：① LLM 全量微调；② 连接式 adapter（在 LLM 输入前接 adapter 对齐 embedding）；③ 插入式 adapter（在 LLM 内部插入）；④ 混合方法。

---

## 4. 任务与理解粒度

![图3 视频理解任务按所需粒度与语言参与度分类，均可统一为问答范式由生成式大模型求解](/vibe-reading/images/articles/video-understanding-llm-survey/fig-3.png)

视频理解任务按**粒度**分三层（Figure 3）：

- **抽象理解（Abstract）**：Video Classification、Action Recognition、Text-Video Retrieval、Video-to-Text Summarization、Video Captioning——抓取视频整体语义。
- **时序理解（Temporal）**：定位事件发生的时间段、理解事件先后与因果关系。
- **时空理解（Spatiotemporal）**：在时间维度上定位空间对象/动作（如某时刻某物体的位置与轨迹）。

> 一个统一视角（Figure 3）：所有任务都可归约为**问答范式**，由生成式大模型统一求解——这正是 Vid-LLM 通用性的根基。

---

## 5. 模型对比与基准

### 5.1 模型规模与资源对比

论文 Table I 详列了各 Vid-LLM 的关键细节（按发布日期排序）：训练帧数、Video Embedder、是否用音频/语音、adapter 类型、硬件、所用 LLM 及其规模。几个观察：

- **LLM 规模跨度大**：从 0.2B（T5）到 20B（ChatGPT）再到 7B（StableVicuna/Llama 系列）。
- **训练资源差异显著**：从 1 张 V100 到 128 张 V100、64 TPU v4——Embedder×LLM 路线尤其耗资源。
- **音频利用普遍不足**：多数模型仅用视觉，少数（VLog/ChatVideo/ChatBridge）引入音频/语音。

### 5.2 评测方法

Section IV 把评测分为三类：

| 评测类型 | 特点 | 方法 |
|---|---|---|
| **Closed-ended（封闭式）** | 预定义答案/格式（选择题） | 直接打分 |
| **Open-ended（开放式）** | 无预设答案，需复杂评估 | GPT 辅助评分、人工评估 |
| **其他** | 过程级评估 | Attention 可视化、推理过程洞察 |

> 评测的局限：开放式评测用 GPT 打分时，**分数会随 GPT 版本变化**——评测方法本身的稳定性是个未决问题。

---

## 6. 应用场景

Vid-LLM 的应用横跨四大领域：

1. **媒体与娱乐**：在线视频检索、智能推荐、字幕生成与翻译、视频摘要与剪辑、广告编辑。
2. **交互与用户中心系统**：虚拟教育/无障碍/手语翻译、游戏动态剧情与程序化内容、AR/VR/VR 沉浸式叙事、状态感知人机交互与机器人规划（SayCan 类 3D 场景图导航）。
3. **医疗与安全**：医疗文献处理与诊断辅助、安防监控异常行为检测、网络安全钓鱼识别、自动驾驶（路标理解、自然语言交互）。
4. **其他**：视频生成模型的评估与 prompt 精炼、边缘计算部署、联邦学习隐私保护。

---

## 7. 局限与未来方向（批判性）

作者总结了 Vid-LLM 面临的**五大挑战**：

| 挑战 | 症结 |
|---|---|
| **细粒度理解** | 逐帧分析算力高、深层语义（情绪/场景动态）难、相关数据集不足 |
| **长视频理解** | 长时段事件识别与注意力维持困难，尤其复杂剧情 |
| **多模态对齐** | 视觉+音频+文本的时空同步对齐缺乏研究与数据集 |
| **幻觉** | 特征提取不足、视觉-语言域差、LLM 固有幻觉叠加 |
| **工业部署与可扩展性** | 模型压缩、token 合并、领域微调、模块化架构、缓存与集成框架 |

**伦理层面**：Vid-LLM 需访问敏感视频内容，带来隐私风险；可能被滥用于监控或生成误导内容；训练数据多样性不足会引入偏见。需数据治理、同意机制与伦理部署。

> 综述的批判性视角值得肯定：作者既指出 Vid-LLM 在多粒度推理上的涌现能力（乐观），也明确点出评测指标、长视频处理、视觉-文本模态对齐三大遗留短板（务实）——并强调扩展数据集与基准是推进关键。

---

## 8. 总结与展望

### 贡献总结

本综述把 LLM 集成进视频理解这一方向做了系统化梳理：**3 主类 × 5 子类的分类法**覆盖了 Analyzer/Embedder/混合三种视频处理路径与 Summarizer/Manager/Decoder/Regressor/Hidden-Layer 五种 LLM 角色，配以训练策略、任务粒度、数据集基准、评测方法与应用场景的全面对比，并维护持续更新的资源库。Vid-LLM 在从抽象到时空的多粒度推理上展现出潜力，但在评测、长视频、模态对齐上仍有局限。

### 作为领域入口的价值（综述定位）

这是视频理解×LLM 交叉领域的一篇**入口综述**——对刚进入该方向的研究者，3×5 分类法是快速定位相关工作全貌的高效地图；对已身处其中的研究者，Table I 的资源/规模对比与五大挑战的梳理提供了技术选型与课题选择的参考。配以持续更新的 [Awesome 仓库](https://github.com/yunlong10/Awesome-LLMs-for-Video-Understanding)，是这一快速演进方向的有效锚点。

### 未来方向（idea 三法）

1. **弥补缺陷**：构建细粒度时空对齐数据集；设计评测指标稳定、不依赖 GPT 版本的开放式评测协议；针对长视频的事件提取与注意力机制。
2. **新型方案**：探索 Analyzer+Embedder 混合路线的更多可能（当前罕见但潜力大）；用 LLM 作 Hidden Layer 接任务头的「即插即用」视频理解骨干；把 Vid-LLM 与 agent 框架结合做长视频的多轮工具调用。
3. **减少约束**：放宽「视觉为主」假设，统一视觉+音频+文本+深度等多模态；推动边缘部署与模型压缩让 Vid-LLM 走出实验室；在联邦学习框架下保护隐私地训练。

> 相关阅读：本文属 Vibe Reading 博客综述系列。Vid-LLM 的核心思路——用 LLM 统一多粒度任务为问答范式——与 [[rag-retrieval-augmented-generation]]（检索增强，把外部知识喂给 LLM）、[[react-synergizing-reasoning-and-acting]]（推理-行动协同，LLM 作 Manager 调用工具）、[[generative-agents]]（LLM 模拟智能体）紧密相关：Analyzer×LLM 路线本质是 RAG 的视频版本，Manager 子类则是 ReAct 式 agent 在视频领域的实例。
