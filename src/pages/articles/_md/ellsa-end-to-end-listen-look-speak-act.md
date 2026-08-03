---
title: "End-to-end Listen, Look, Speak and Act"
source:
  type: "论文解读"
  project: "ByteDance"
  url: "https://arxiv.org/abs/2510.16756"
  pdf: "/vibe-reading/papers/ellsa-end-to-end-listen-look-speak-act.pdf"
date: "2026-08-03T18:00:00+08:00"
category: [AI, Models, Multimodal, Papers]
tags: ["ELLSA", "Full-duplex", "Multimodal", "SA-MoE", "VLA", "Speech Interaction", "Robot Manipulation", "MIMO", "MoE", "GLM-5.2", "DeepSeek-V4", "Embodied AI"]
description: "目的：构建首个全双工端到端多模态模型，同时感知与生成视觉/文本/语音/动作四模态。手段：SA-MoE 架构将不同模态路由至专门专家，通过统一自注意力融合；交错时间块序列实现流式 MIMO；三阶段训练（独立专家→SA-MoE 联合→语音合成器接入）。结论：在语音交互与机器人操作基准上匹配专用基线，并解锁边说边做、动作打断、缺陷指令拒绝等此前无法实现的交互能力。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/ellsa-end-to-end-listen-look-speak-act.pdf" target="_blank" rel="noopener">预览</a> · **论文** [End-to-end Listen, Look, Speak and Act](https://arxiv.org/abs/2510.16756) · **作者** Siyin Wang, Wenyi Yu, Xianzhao Chen, Xiaohai Tian, Jun Zhang, Lu Lu, Chao Zhang · **发表** ICLR 2026 · **项目** [github.com/bytedance/SALMONN/tree/ELLSA](https://github.com/bytedance/SALMONN/tree/ELLSA) · **解读** 2026-08-03

## 1. 论文概览

人类交互天然是多模态且全双工的：我们边听边看、边说边做，并流畅地适应轮替与打断。现有 AI 模型要么是"只会说不会做"的全双工语音对话模型，要么是"又聋又哑"的视觉-语言-动作（VLA）模型——两者割裂。

ELLSA（End-to-end Listen, Look, Speak and Act）是**据作者所知首个全双工、端到端的四模态统一模型**，在单一架构中同时感知并生成视觉、文本、语音、动作。其核心贡献有三：

1. **SA-MoE 架构**（Self-Attention Mixture-of-Experts）：将每种模态路由至专门专家，通过统一自注意力骨干融合，利用预训练组件的同时缓解模态干扰。
2. **ELLSA 模型**：首个统一视觉、语音、文本、动作的流式全双工框架，在语音交互与机器人操作基准上达到与专用模型相当的性能。
3. **新交互能力**：解锁了对话/动作轮替预测、缺陷指令拒绝、边说边做（speaking-while-acting）、动作打断（action barge-in）等此前无法实现的行为。

**Take-home**：ELLSA 证明了通过模型结构与系统工程的协同优化，可以在不损失模型能力的前提下，将全双工多模态交互落地为一个统一的端到端框架，向更自然、更通用的人机交互智能迈出关键一步。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Human interaction is inherently multimodal and full-duplex: we listen while watching, speak while acting, and fluidly adapt to turn-taking and interruptions. Realizing these capabilities is essential for building models simulating humans. We present ELLSA (End-to-end Listen, Look, Speak and Act), which, to our knowledge, is the first full-duplex, end-to-end model that simultaneously perceives and generates across vision, text, speech, and action within a single architecture, enabling interaction patterns previously out of reach, yielding more natural, human-like behaviors. At its core is a novel SA-MoE architecture (Self-Attention Mixture-of-Experts) that routes each modality to specialized experts and fuses them through a unified attention backbone. This provides a generalizable solution for joint multimodal perception and concurrent generation, leveraging strong pre-trained components while enabling efficient modality integration and mitigating modality interference. On speech-interaction and robot-manipulation benchmarks, ELLSA matches modality-specific baselines, while uniquely supporting advanced multimodal and full-duplex behaviors such as dialogue and action turn-taking, defective instruction rejection, speaking-while-acting, context-grounded visual question answering, and action barge-ins. We contend that ELLSA represents a step toward more natural and general interactive intelligence, contributing to the broader pursuit of artificial general intelligence. All data, code and model checkpoints will be released.

> **译：** 人类交互天然是多模态且全双工的：我们边听边看，边说边做，并流畅地适应轮替与打断。实现这些能力对于构建模拟人类的模型至关重要。我们提出 ELLSA（End-to-end Listen, Look, Speak and Act），据我们所知，这是首个在单一架构中同时感知与生成视觉、文本、语音与动作的全双工端到端模型， enabling previously out-of-reach interaction patterns, yielding more natural, human-like behaviors。其核心是新颖的 SA-MoE 架构（Self-Attention Mixture-of-Experts），将每种模态路由至专门专家，并通过统一注意力骨干融合。这为联合多模态感知与并发生成提供了可泛化的解决方案——在利用强预训练组件的同时实现高效模态集成并缓解模态干扰。在语音交互与机器人操作基准上，ELLSA 匹配模态专用基线，同时独特地支持对话与动作轮替、缺陷指令拒绝、边说边做、上下文视觉问答与动作打断等高级多模态全双工行为。我们认为 ELLSA 代表了向更自然、更通用的交互智能迈出的一步，贡献于更广泛的通用人工智能追求。所有数据、代码与模型检查点将公开发布。

</details>

## 2. 研究背景

### 2.1 问题定义

大模型从能力验证走向规模化应用后，系统关注点已从"能否完成任务"转向能否**稳定、低成本、自然地**服务真实业务。人类交互的全双工特性——持续处理多输入流、并行产生多输出、实时适应轮替与打断——是现有 AI 模型的关键缺口。

### 2.2 现有范式的割裂

当前两大范式各只覆盖整体挑战的一个侧面，产生"只会说的 disembodied talkers"与"只会做的 non-conversant doers"：

| 范式 | 能力 | 缺陷 |
|------|------|------|
| **全双工语音 LLM**（Moshi、Freeze-Omni、SALMONN-omni） | 能看、能听、能说，支持低延迟语音交互与轮替 | 无法将理解转化为物理动作，是无实体的观察者 |
| **VLA 模型**（RT-2、OpenVLA、π0） | 能将语言接地为操作任务 | "又聋又哑"，只能处理文本指令，半双工轮次制，无法处理语音输入/输出 |

半双工、轮次制的范式根本性地限制了交互性，无法处理轮替与打断等自然对话行为。VLAS 虽接受语音输入但仍半双工且仅输出动作；Unified-IO 2 虽尝试扩展多模态自回归但仍是轮次制、缺乏语音支持。

### 2.3 为什么需要这篇

ELLSA 首次在同一端到端框架中统一了听觉处理、视觉感知、语音生成与动作执行，将上述两条割裂的路线合并为一个全双工多模态交互系统。

## 3. 方法详解

ELLSA 的整体架构如 Figure 1 所示。核心由三部分组成：流式全双工 MIMO、SA-MoE 架构、三阶段训练策略。

![Figure 1: ELLSA 整体架构。不同模态由不同专家处理，专家在 SA-MoE 架构中集成以实现模态交互。右侧展示通过交错序列实现的流式全双工 MIMO 交互。](/vibe-reading/images/articles/ellsa-end-to-end-listen-look-speak-act/fig-01-ellsa-overview.png)

### 3.1 流式全双工 MIMO

ELLSA 通过**将多模态序列按交错时序排列**实现流式全双工交互（Figure 1b）。在每个时间块内，不同模态的输入输出按固定顺序组织：

$$
\langle\text{bos}\rangle \cdots \langle\text{eos}\rangle \;\langle\text{boi}\rangle \cdots \langle\text{eoi}\rangle \;\langle\text{bot}\rangle \cdots \langle\text{eot}\rangle \;\langle\text{boa}\rangle \cdots \langle\text{eoa}\rangle
$$

即 **语音输入 → 图像输入 → 文本输出 → 动作输出**，各段用模态专属 token（`<box>`/`<eox>`）包裹。语音输出由文本输出的 embedding 直接推导，不进入主序列。

ELLSA 有两种工作模式：
- **默认模式**：四模态全开（speech + vision + text + action）
- **Speech-only 模式**：仅 speech + text，产出 dummy action、占位视觉输入

每个时间块默认为 **1 秒**：处理 1 秒语音输入 + 1 帧视频，生成 8 个文本 token（或 1 个 `<silence>` token）及 1 秒的语音与动作输出。

### 3.2 SA-MoE：自注意力混合专家

开发多模态 LLM 的核心挑战是：组合多模态感知与生成往往**退化文本性能**，尤其多模态生成。训练单一 dense 模型平衡模态极难且需海量数据。

SA-MoE 的设计灵感来自 π0——VLM 骨干与动作专家通过注意力连接。ELLSA 将此思想扩展到交错多模态序列与跨专家交互。

![Figure 2: SA-MoE 工作机制。每种模态路由至指定专家，跨模态交互通过注意力机制实现。推理时所有专家共享统一 KV cache，每个专家可整合跨模态信息实现连贯的多模态理解。](/vibe-reading/images/articles/ellsa-end-to-end-listen-look-speak-act/fig-02-sa-moe-mechanism.png)

**两个视角理解 SA-MoE**：

- **模态处理视角**：每种模态由指定专家处理——Speech Expert 处理 speech + text（"嘴"），Action Expert 处理 vision + action（"手"）。这种分工减少多模态建模复杂度、缓解模态干扰、增强可控性与可解释性。
- **序列处理视角**：整个 MoE 模型是一个 transformer。从全序列看，信息流等价于 vanilla transformer；从单步看，除前序 KV 可能来自不同专家外，行为同标准 transformer。任一时刻仅一个专家权重被激活。

**关键设计**：ELLSA 采用 2 个专家（Speech + Action），而非 4 个（speech/vision/text/action 各一）。合并 speech+text、vision+action 是为了更好利用预训练知识。未来可轻松引入嗅觉、触觉等新模态的专门专家。

### 3.3 三阶段训练策略

![Figure 3: ELLSA 训练策略。先训练独立专家，再在 SA-MoE 框架中集成专家，最后接入语音合成器。各阶段训练任务与可训练参数随模型能力增长而演进。](/vibe-reading/images/articles/ellsa-end-to-end-listen-look-speak-act/fig-03-training-strategy.png)

**Stage 1：训练独立专家**
- **Speech Expert**：流式 Mamba 语音编码器 + LLaMA-3.1-8B-Instruct，训练 ASR 与语音 QA。仅训练 connector + LoRA（rank 256），编码器与 LLM 冻结。
- **Action Expert**：直接使用预训练 UniVLA（基于 Emu3-Base，经世界模型后训练 + 策略学习微调）。

**Stage 2：训练 SA-MoE**
- 在 SA-MoE 框架中集成两个专家，训练任务涵盖 ASR、语音 QA、语音条件机器人操作，以及 speaking-while-acting、缺陷指令拒绝、动作打断、上下文 VQA 等高级交互技能。两专家均以 LoRA 进一步微调。

**Stage 3：接入语音合成器**
- 将流式语音合成器（CosyVoice2-0.5B）以端到端方式接入。Speech Expert 最后隐状态经随机初始化的 connector 转换后送入可训练合成器。此阶段 ELLSA 获得说话能力，完成多模态交互闭环。

## 4. 关键公式解读

### 4.1 SLO Load：分别度量 P、D 压力

PD 分离系统中，GPU 利用率只反映设备繁忙度，无法判断负载是否已影响用户体验。ELLSA 以 TTFT/TPOT 相对 SLO 的背离程度统一度量两侧压力：

$$
\text{Load}_P = \frac{\max(\text{TTFT}_{\text{pred}},\; \text{TTFT}_{\text{actual}})}{\text{TTFT}_{\text{target}}}, \quad \text{Load}_D = \frac{\max(\text{TPOT}_{\text{pred}},\; \text{TPOT}_{\text{actual}})}{\text{TPOT}_{\text{target}}}
$$

$\text{Load}=1$ 表示达到目标边界，$\text{Load}>1$ 表示对应阶段存在容量压力。取预测值与真实值的上界以兼顾及时性与可靠性。

> 注：此公式来自 ELLSA 论文中引用的快手万擎推理优化实践（PD 分离相关），ELLSA 本身的 SLO 调度借鉴了这一思想。

### 4.2 交错时间块序列

每个时间块 $t$ 内的多模态序列结构：

$$
\mathbf{s}_t = [\text{bos},\, \mathbf{s}^{\text{speech}},\, \text{eos},\, \text{boi},\, \mathbf{s}^{\text{image}},\, \text{eoi},\, \text{bot},\, \mathbf{s}^{\text{text}},\, \text{eot},\, \text{boa},\, \mathbf{s}^{\text{action}},\, \text{eoa}]
$$

其中 $\mathbf{s}^{\text{speech}}$ 为 5 个语音 embedding（25Hz 降采样至 5Hz），$\mathbf{s}^{\text{text}}$ 为 8 个文本 token 或单个 `<silence>`。这一固定时序排列使模型能在每个时间块内自主决定何时开始/停止说话/动作——全双工的关键。

## 5. 实验设置

### 5.1 模型规格

| 组件 | 规格 |
|------|------|
| **Speech Expert** | Mamba 流式编码器（32 层，hidden 2048，25Hz→5Hz 降采样）+ LLaMA-3.1-8B-Instruct（LoRA rank 256） |
| **Action Expert** | Emu3-VisionTokenizer + FAST 动作 tokenizer；Emu3-Base 骨干（末 1024 token 替换为 FAST token），LoRA rank 256 |
| **Speech Synthesizer** | CosyVoice2-0.5B，仅微调 LM 部分（每 8 个文本 embedding 产生 25 个语音 codec） |
| **共享配置** | 两专家均 32 层 transformer，hidden 4096，32 注意力头，8 KV 头——无需额外参数构建 SA-MoE |

### 5.2 数据与任务

**基础任务**：ASR、语音 QA、语音条件机器人操作。

**高级任务**（ELLSA 独有）：
- **Speaking-while-acting**：执行动作时同时回答语音提问
- **Context-grounded VQA**：基于执行进度的上下文相关视觉问答（如"黑碗现在在哪？"）
- **Defective instruction rejection**：识别并拒绝视觉/语义/运动/上下文四类缺陷指令
- **Action barge-in**：听到打断命令（如"Pause here"）立即停止动作

### 5.3 评价

- 语音交互：Llama Questions / Web Questions / TriviaQA（Acc%），AlpacaEval（GPTScore）
- 机器人操作：LIBERO 基准（SPATIAL/OBJECT/GOAL/LONG 任务成功率）
- S2T/S2S 双路报告；复现信息：所有模型与数据集公开，代码与 checkpoint 承诺发布

## 6. 实验结果

### 6.1 基础能力：语音交互

| Model | Llama Q. S2T | S2S | Web Q. S2T | S2S | TriviaQA S2T | S2S | AlpacaEval S2T | S2S |
|-------|---|---|---|---|---|---|---|---|
| Moshi | 60.8 | 54.5 | 23.4 | 22.1 | 25.6 | 16.7 | 1.84 | 1.76 |
| Freeze-Omni | 74.2 | 56.2 | 40.8 | 27.9 | 45.1 | 28.5 | 3.90 | 2.46 |
| **ELLSA** | **74.7** | **70.0** | 39.5 | **36.5** | **45.2** | **41.7** | 3.09 | **2.80** |

ELLSA 达到与开源全双工模型可比的性能，**S2S 表现最优**，体现了端到端语音到语音交互的优势。

### 6.2 基础能力：语音条件机器人操作

| Model | SPATIAL | OBJECT | GOAL | LONG | Average |
|-------|---------|--------|------|------|---------|
| π0-FAST | 96.4 | 96.8 | 88.6 | 60.2 | 85.5 |
| OpenVLA | 84.9 | 88.4 | 79.2 | 53.7 | 76.5 |
| **ELLSA** | 90.8 | 95.8 | 86.4 | **84.4** | **89.4** |

ELLSA 取得 **LIBERO 平均最高性能**。值得注意的是，ELLSA 的评测设置更具挑战性——使用语音指令且需自主决定何时启动动作（而非文本指令、轮次制）。此前对语音陌生的 Action Expert 现在能基于语音指令执行动作，印证了 SA-MoE 的模态集成效果。

### 6.3 高级能力：全双工交互

![Figure 4: ELLSA 高级能力示例。从语音指令出发，模型执行动作、进行上下文 VQA、并支持动作打断。展示 MIMO 同时处理多模态输入输出的能力，以及管理轮替与打断的全双工能力。](/vibe-reading/images/articles/ellsa-end-to-end-listen-look-speak-act/fig-04-advanced-capabilities.png)

**对话/动作轮替**（Table 3a/b）：ELLSA 在所有基准上均 **100%** 成功预测对话与动作轮替，甚至超过 speech-only 模型（假设因 1 秒时间块比 0.16 秒更简化全双工动力学学习）。

**Speaking-while-acting**（Table 3c）：在动作执行中处理不同语音输入——一般问题继续动作并回答（100%）、打断命令停止动作（94.3%）、静音仅输出 `<silence>`（100%）。

**Context-grounded VQA**（Table 5）：人工准确率 82.5%，Gemini-2.5-Pro 评估 83.3%，两者高度一致。ELLSA 在更自然的交互设置下达约 80% 准确率。值得注意的是，从未训练过视觉数据的 Speech Expert 现在能解读视觉信息并准确回答——SA-MoE 有效链接专家实现模态集成。

## 7. 消融实验

### 7.1 SA-MoE vs Dense 模型

| Model | Llama Q. | Web Q. | TriviaQA | AlpacaEval |
|-------|----------|--------|----------|------------|
| Dense (from speech expert) | 62.7 | 23.6 | 29.7 | 2.12 |
| Dense (from action expert) | 32.7 | 3.9 | 9.1 | 1.25 |
| **SA-MoE** | **74.7** | **39.5** | **45.2** | **3.09** |

SA-MoE **显著优于** dense 模型。Dense 模型虽能部分继承初始化组件的能力，但在有限训练数据下难以有效学习陌生模态，且在其初始化模型对应模态上也不如 SA-MoE——证明 SA-MoE 有效解决了困扰 dense 模型的模态干扰问题。

SA-MoE vs 独立专家：Speech Expert 相对下降 10.3%，Action Expert 下降 6.4%。Speech Expert 下降更大可能因序列长度差异（单张图约 300 token，10 秒语音仅约 50 token，对齐更困难）。

### 7.2 时间块时长

| Time block | Llama Q. | Web Q. | SPATIAL | LONG |
|------------|----------|--------|---------|------|
| 1s | 74.7 | 39.5 | 90.8% | 84.4% |
| 0.48s | 71.7 | 38.4 | 81.0% | 71.6% |

1s 时间块整体更优。0.48s 时 Action Expert 明显退化（更短动作序列降低时序连贯性），而 Speech Expert 影响较小。延迟方面：1s 块 S2S 854ms、S2A 786ms；0.48s 块 455ms、428ms——两者均在各自时间块内完成推理。

### 7.3 专家数量

2 专家（Speech+Action）与 3 专家（拆分 vision/action 或 speech/text）性能相当，故采用更高效的 2 专家设计。

### 7.4 语音编码器升级

将 Mamba 编码器替换为更强的 SPEAR（zipformer，更大数据训练），不仅提升基线能力，还**显著缩小 speaking-while-acting 的性能差距**——如 LIBERO LONG 从 -13.3% 缩至 -2.9%，Web Questions 从 -17.0% 缩至 -7.0%。证明边说边做的性能退化主要源于模型容量限制而非架构本身。

## 8. 总结与展望

### 贡献总结

ELLSA 首次在单一端到端框架中统一了视觉、语音、文本、动作的流式全双工感知与生成。SA-MoE 架构通过注意力连接模态专属专家，在保留各专家预训练能力的同时实现高效模态融合与干扰缓解。在标准基准上匹配专用模型，并解锁了一系列此前无法实现的全双工多模态交互行为。

### 局限性（批判性）

1. **全双工场景覆盖有限**：虽能预测轮替与打断，但用户/助手 backchanneling 等许多自然通信方面尚未解决。
2. **仅在仿真环境验证**：尚未在真实世界部署中验证。未来需通过针对性微调适配真实场景。
3. **边说边做的性能退化**：在困难基准（LIBERO LONG、TriviaQA）上退化明显，主要受限于模型容量（消融显示更强编码器可大幅缓解）。

### 未来方向（创造性，idea 三法）

- **弥补缺陷**：引入更强语音编码器与更大骨干以缩小 speaking-while-acting 差距；扩展 backchanneling 等更细粒度的全双工动力学。
- **新型方案**：探索"brain-hand-mouth"架构——通用骨干作"脑"处理所有输入模态，专门编码器作"耳/眼"，text expert 作"嘴"，action expert 作"手"，更贴近人类信息流（论文附录已提出此设想）。
- **减少约束**：将调度单元从"单请求"提升到 Program（一次 agent 会话/工作流），做暂停/恢复调度 + 工具调用空窗资源回收，利用 agent 等待 tool-call 返回的 GPU 空闲窗口卸载/预取 KV。
