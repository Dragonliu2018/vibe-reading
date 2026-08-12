---
title: "LongCat-Flash-Omni Technical Report"
source:
  type: "论文解读"
  project: "LongCat"
  url: "https://arxiv.org/abs/2511.00279"
  pdf: "/vibe-reading/papers/longcat-flash-omni-technical-report.pdf"
date: "2026-08-12T19:51:18+08:00"
category: [AI, Models, Omni Model, Papers]
tags: ["Omni-Modal", "MoE", "ScMoE", "Real-Time Interaction", "Audio-Visual", "Streaming", "DPO", "SFT", "Early Fusion"]
description: "目的：560B 开源全模态模型实现实时音视频交互。手段：课程式渐进预训练 + ScMoE 骨干 + 模态解耦并行 + 流式 pipeline。结论：开源全模态 SOTA，多模态训练保持 90% 纯文本吞吐。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/longcat-flash-omni-technical-report.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LongCat-Flash-Omni Technical Report](https://arxiv.org/abs/2511.00279) · **作者** Meituan LongCat Team · **发表** arXiv, 2025-11 · **项目** [GitHub](https://github.com/meituan-longcat/LongCat-Flash-Omni) / [HuggingFace](https://huggingface.co/meituan-longcat/LongCat-Flash-Omni) · **解读** 2026-08-12

## 1. 论文概览

LongCat-Flash-Omni 是美团 LongCat 团队开源的 **560B 参数（27B 激活）全模态模型**，在一个端到端框架内统一了离线多模态理解与实时音视频交互。它以 LongCat-Flash 的 Shortcut-connected MoE（ScMoE）为零计算专家的 LLM 骨干，外接轻量级视觉/音频编码器与音频解码器，在 128K 上下文窗口下实现毫秒级响应延迟。

**核心 take-home**：通过"课程式渐进预训练 + 模态解耦并行（MDP）+ 流式音视频特征交错"三件套，一个 560B 的 MoE 模型可以在不损失单模态性能的前提下获得跨模态理解与实时交互能力，且多模态训练吞吐保持纯文本训练的 90%+。

**关键数据**：在 OmniBench（61.4）、WorldSense（60.9）等全模态基准上达到开源 SOTA；VideoMME w/ audio 78.2 居全模态模型之首；实时音视频交互主观评分 1.37，开源阵营第一。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We introduce LongCat-Flash-Omni, a state-of-the-art open-source omni-modal model with 560 billion parameters, excelling at real-time audio-visual interaction. By adopting a curriculum-inspired progressive training strategy that transitions from simpler to increasingly complex modality sequence modeling tasks, LongCat-Flash-Omni attains comprehensive multimodal capabilities while maintaining strong unimodal capability. Building upon LongCat-Flash, which adopts a high-performance Shortcut-connected Mixture-of-Experts (MoE) architecture with zero-computation experts, LongCat-Flash-Omni integrates efficient multimodal perception and speech reconstruction modules. Despite its immense size of 560B parameters (with 27B activated), LongCat-Flash-Omni achieves low-latency real-time audio-visual interaction. For training infrastructure, we developed a modality-decoupled parallelism scheme specifically designed to manage the data and model heterogeneity inherent in large-scale multimodal training. This innovative approach demonstrates exceptional efficiency by sustaining over 90% of the throughput achieved by text-only training. Extensive evaluations show that LongCat-Flash-Omni achieves state-of-the-art performance on omni-modal benchmarks among open-source models. Furthermore, it delivers highly competitive results across a wide range of modality-specific tasks, including text, image, and video understanding, as well as audio understanding and generation. We provide a comprehensive overview of the model architecture design, training procedures, and data strategies, and open-source the model to foster future research and development in the community.

> **译：** 我们提出 LongCat-Flash-Omni，一个 5600 亿参数的开源全模态模型，擅长实时音视频交互。通过采用课程式渐进训练策略——从较简单逐步过渡到更复杂的模态序列建模任务——模型在保持强单模态能力的同时获得全面的多模态能力。基于采用零计算专家的 Shortcut-connected MoE 架构的 LongCat-Flash，LongCat-Flash-Omni 集成了高效的多模态感知与语音重建模块。尽管参数量高达 560B（激活 27B），仍实现了低延迟实时音视频交互。在训练基础设施方面，我们开发了模态解耦并行方案以应对大规模多模态训练中固有的数据与模型异构性，其保持了纯文本训练 90% 以上的吞吐。评测表明，LongCat-Flash-Omni 在开源全模态基准上达到 SOTA，并在文本、图像、视频理解及音频理解与生成等单模态任务上取得高度竞争力的结果。

</details>

## 2. 研究背景

构建一个同时具备**强离线多模态理解**与**实时音视频交互**能力的全模态模型，面临四重核心挑战：

1. **跨模态异构**：文本是高度压缩的符号表示，语音是语义密度更低的声学序列（12.5 Hz 语音 token vs 3-4 文本 token/秒），图像/视频则编码空间与时序结构。模态间结构差异巨大，需要有效的统一表示与融合策略，否则任一模态性能会相较同规模单模态模型退化。
2. **离线与流式统一**：流式交互场景需要离线处理不具备的能力——相对时间感知、音视频精确同步、多轮交互上下文管理。
3. **实时交互**：需同时支持流式音视频输入与流式语音输出，低延迟约束对模型架构与部署基础设施都提出严苛要求。
4. **训练效率**：模型与数据的异构性对分布式策略设计构成巨大挑战。

已有闭源方案如 Gemini-2.5、GPT-4o 率先将文本/音频/图像/视频统一进单模型；开源方向则有 Qwen2.5/3-Omni 等跟进。但开源模型在实时音视频交互质量、多模态训练效率、单模态性能保持等方面仍有明显差距。LongCat-Flash-Omni 正是面向这些缺口设计。

## 3. 方法详解

### 3.1 整体架构

LongCat-Flash-Omni 是一个完全端到端的全模态模型，可接收文本、音频、图像、视频及其任意组合作为输入，并直接由 LLM 骨干生成语音 token。

![Figure 2 LongCat-Flash-Omni 模型架构总览：视觉编码器与音频编码器将多模态输入投影到共享 latent token 空间，送入 LongCat-Flash LLM 骨干；LLM 并行生成文本 token 与多码本语音 token，语音 token 经音频解码器还原为波形；ScMoE 模块实现高效多模态融合，音视频特征按 chunk 交错以支持流式输入](/vibe-reading/images/articles/longcat-flash-omni-technical-report/fig-02-architecture-overview.png)

核心组件：

- **Vision Encoder（LongCat-ViT，637M）**：原生分辨率编码，2D-RoPE + SwiGLU + RMSNorm + LayerScale + QK-norm，2× pixel-unshuffle 降低高分辨率计算复杂度；统一处理图像与视频。
- **Audio Tokenizer / Decoder（LongCat-Audio-Codec）**：将波形离散化为 4 码本 token（1 语义 + 3 声学），帧率 16.67 Hz；解码器由 LSTM + 卷积 + 因果转置卷积组成，GAN 框架训练，支持仅 3 帧 look-ahead 的流式解码。
- **Audio Encoder（~600M）**：流式架构，输入 80 维 Fbank 特征，Pre-FFN 做 8× 帧拼接下采样（每帧 80ms），核心用 FSMN 层替代标准 self-attention 以在受限上下文窗口内高效处理，仅最后 6 层引入 1 帧 look-ahead，CTC loss 训练。
- **LLM Backbone（LongCat-Flash，560B/27B 激活）**：采用 Multi-head Latent Attention（MLA）、shortcut-connected MoE 与零计算专家，按 token 激活 18.6B–31.3B 参数（均值 27B）。

### 3.2 视频策略与流式音视频交互

**视频处理**采用三步层级压缩：① 按 patch 数上限缩放每帧；② 入 ViT 前用时间步长为 2 的 3D 卷积将 N 帧压缩为 N/2；③ 视觉 projector 输出后若 token 数超限再做插值下采样。默认 2 FPS 采样，短视频采更密以至少保证 16 帧；每帧前以纯文本时间戳 `Second{i}` 注入，增强时序感知。

**流式音视频特征交错**是实时交互的核心机制。不同于离线任务在序列级拼接音视频特征，实时交互要求用户查询到达后尽早 prefill。设计的时间同步 chunk 交错结构为：

```
<|timestamp|>:<|video-tokens|><|audio-start-token|><|audio-tokens|>
<|timestamp|>:<|video-tokens|><|audio-tokens|>...<|audio-end-token|>
```

**Sparse-Dense 采样策略**平衡计算成本与信息损失：用户输入期用 1 秒 chunk、2 FPS 密集采样保留尽量多音视频信息；模型响应期以 2 秒 chunk、0.5 FPS 稀疏采样缓冲视频帧并前置到下一轮用户输入。

推理侧的**异步流式 pipeline**进一步压缩首包延迟，由 VAD & Frame Sampling → Audio-Visual Encoding → LLM Prefilling & Decoding → Audio Decoding 四级流水线并发执行：

![Figure 11 异步流式 pipeline：VAD 检测用户说话→音视频编码→LLM prefill/decode→音频解码四级并发，speculative prefill-decode switching 在 t3 提前启动解码重叠 t2-t4 的端点检测延迟，用户在端点检测后 100ms 内收到响应](/vibe-reading/images/articles/longcat-flash-omni-technical-report/fig-11-streaming-pipeline.png)

其核心是 **speculative prefill-decode switching**：VAD 通常在静默段 [t2, t4] 后才判定用户轮次结束，若等到 t4 才切换 LLM 到 decode 会引入显著首包延迟。因此在更早的 speculative 点 t3 就启动 decode，把延迟从 t3 重叠到 t4；若用户随后恢复说话则触发 rollback，丢弃已生成内容并回退到 prefill 状态。叠加流式 prefill（每请求包 1 秒音频 + 2 帧视频立即 prefill），用户在端点检测后 100ms 内即可收到响应。

### 3.3 课程式渐进预训练

预训练采用 6 个阶段（Stage 0–5）的渐进式课程，从简单到复杂逐步引入模态：

![Figure 5 预训练六阶段：Stage-0 纯文本 → Stage-1 文本-语音 → Stage-2 多模态（加入视觉）→ Stage-3 多模态退火（加入视频）→ Stage-4 上下文扩展到 128K → Stage-5 音频编码器对齐（冻结 LLM）](/vibe-reading/images/articles/longcat-flash-omni-technical-report/fig-05-pretraining-stages.png)

| 阶段 | 名称 | 核心动作 | 数据量 |
|---|---|---|---|
| Stage-0 | Text Pre-Training | 同 LongCat-Flash 初始阶段，高质量文本语料，逐步增加推理/代码比例 | ~16T tokens |
| Stage-1 | Text-Speech Continued Pre-Training | 引入 4 码本语音 token，联合优化纯文本 NTP / 文本-语音交错 NTP / ASR 三目标；引入 4 个音频预测头，语义与声学 token 间一步时移 | ~5.1T tokens（文本:音频=2:1） |
| Stage-2 | Multimodal Continued Pre-Training | 加入图像 caption 与图文交错数据，ViT 与 projector 联合训练 | >3T tokens |
| Stage-3 | Multimodal Annealing Training | 加入视频、OCR、grounding、GUI、STEM 等高质量数据，退火学习率；PPL-gap 信号动态引导数据采样 | 0.33T tokens |
| Stage-4 | Context-Length Extension | 8K → 32K → 128K，RoPE base 从 1M → 5M → 10M；叠加 25% 长上下文多模态数据 | 120B tokens |
| Stage-5 | Audio Encoder Alignment | 冻结 LLM，仅训音频编码器，将连续音频特征对齐到 LLM 语义空间 | — |

Stage-1 的训练目标示意如下图，文本与音频 embedding 融合后送入 LLM，4 个音频预测头并行生成语义与声学 token：

![Figure 6 Stage-1 训练示意：文本与音频 embedding 融合送入 LLM Decoder，Text Head 生成文本 token，4 个 Audio Head 并行生成语义/声学 token，多头部预测](/vibe-reading/images/articles/longcat-flash-omni-technical-report/fig-06-stage1-schematic.png)

Stage-3 的退火阶段还引入了 **PPL-gap 信号**自动指导数据采样：将语料按语义/任务分桶，监控每桶 PPL 收敛，若某子集收敛滞后于参考水平则动态提高其采样权重；高价值样本隔离重标为独立子集，避免被聚合统计稀释。

## 4. 关键公式解读

### 4.1 Stage-1 联合训练目标

Stage-1 同时优化纯文本、音频、文本-语音交错与首音频 token 四项损失：

$$
\mathcal{L}_{total} = a\,\mathcal{L}_{pure\text{-}text} + b\,\mathcal{L}_{audio} + c\,\mathcal{L}_{audio\text{-}text} + d\,\mathcal{L}_{first\text{-}audio}
$$

其中 $a=1.75,\ b=0.25,\ c=1.5,\ d=0.1$。$\mathcal{L}_{pure\text{-}text}$ 保留纯文本能力，$\mathcal{L}_{audio}$ 与 $\mathcal{L}_{audio\text{-}text}$ 分别是文本-语音数据中的音频损失与文本损失，$\mathcal{L}_{first\text{-}audio}$ 是对语义音频 token 的额外损失。权重设计明显偏向文本（$a+c=3.25$ vs $b+d=0.35$），体现了"以文本为锚、逐步对齐语音"的策略，避免语音数据稀释 LLM 已有的文本能力。

### 4.2 跨模态联合 DPO

后训练 RL 阶段，论文将 DPO 扩展为文本头与多音频头的联合优化：

$$
\mathcal{L}_{DPO} = \alpha\,\mathcal{L}_{DPO}^{(text_{chosen}, text_{rejected})} + \beta\sum_{i=1}^{N}\mathcal{L}_{DPO}^{(audio_i^{chosen}, audio_i^{rejected})}
$$

$N$ 为音频头数量。文本头关注语义质量，每个音频头强调对应语音输出的语言学与发音稳定性。作者论证：将文本与语音解耦优化是次优的，联合优化才能保持两类响应的连贯性。训练取 $\alpha:\beta=1:1$，并加 0.1 权重的 KL 散度正则防止偏离 SFT 模型。

## 5. 实验设置

**预训练数据**：总计超过 2.5T tokens 的多模态语料，涵盖音频（数千万小时）、图文、OCR/grounding/GUI、STEM（15M 图文对）、多图、视频、长上下文多模态数据。数据清洗强调"多样性优先于过严质量过滤"——基于 MetaCLIP 的概念重采样 + 200K 中文词表扩展实现长尾平衡。

**SFT 数据**：约 3M 图文 + 700K 视频 + 音频理解 + Vision-Speech QA + 音视频理解数据。交互数据采用半自动化 pipeline（模型生成 + human-in-the-loop 修正），覆盖记忆/理解/分析/创作/应用/娱乐六维能力。

**评测基准**：视觉（MMBench、MMMU、DocVQA、RefCOCO、ScreenSpot-v2 等 18 项）、视频（MVBench、VideoMME、LongVideoBench、MMVU 等）、音频（LibriSpeech、AISHELL、MMAU、VoiceBench 等）、文本（MMLU、GPQA、MATH、HumanEval+ 等）、跨模态（OmniBench、WorldSense、DailyOmni、UNO-Bench）。

**对比模型**：Gemini-2.5-Pro/Flash、GPT-4o/GPT-4o-Audio、Qwen3-Omni/Qwen2.5-Omni、Qwen3-VL、Seed-1.6、Kimi-Audio、Step-Audio-2-mini、DeepSeek-V3.1、Kimi-K2 等。公平起见，Gemini-2.5-Pro 限制 thinking budget 为 128 tokens，支持 thinking 的模型统一配置为 non-thinking 模式。

**复现信息**：模型已开源（HuggingFace + GitHub），评测遵循各 benchmark 官方代码。

## 6. 实验结果

### 6.1 全模态与单模态主结果

LongCat-Flash-Omni 在开源全模态基准上全面领先：

![Figure 1 LongCat-Flash-Omni 在全模态（OmniBench/WorldSense）、视频（VideoMME/TempCompass）、图像（RealWorldQA/MuirBench）、音频（VoiceBench/Audio Understanding）等基准上的综合性能](/vibe-reading/images/articles/longcat-flash-omni-technical-report/fig-01-benchmark-performance.png)

| 基准 | LongCat-Flash-Omni | Qwen3-Omni | Gemini-2.5-Pro | GPT-4o |
|---|---|---|---|---|
| OmniBench | **61.4** | 58.5 | 66.8 | — |
| WorldSense | 60.9 | 52.0 | **64.0** | — |
| VideoMME w/ audio | **78.2** | 73.0 | 80.6 | 73.2 |
| VoiceBench (Avg) | **88.7** | 85.5 | 88.4 | 86.4 |
| Audio Understanding (Avg) | 74.8 | 65.7 | 63.5 | 54.2 |
| TempCompass | **82.2** | 73.5 | 80.8 | 76.4 |
| MuirBench | **77.1** | 62.1 | 74.0 | 70.5 |

关键发现：

- **全模态**：在 WorldSense、DailyOmni 等真实世界音视频理解基准上显著领先其他开源模型；OmniBench 超过 Qwen3-Omni 3 分。
- **视频**：短视频理解（MVBench 75.2、TempCompass 82.2）大幅领先所有对比模型；VideoMME w/ audio 78.2 居全模态模型之首。
- **音频**：ASR 在 AISHELL-1（0.63）、WenetSpeech 等中文基准上与 Qwen3-Omni、Step-Audio-2-mini 同档；音频理解（MMAU 75.90、TUT2017 65.43）多项 SOTA。
- **文本**：Instruct 模型在 MMLU（90.30）、CMMLU（89.39）、AIME24（72.92）等上与 DeepSeek-V3.1、Qwen3-235B 同档，**且相对 LongCat-Flash 基座在多数指标上不降反升**——证明多模态训练未侵蚀文本能力。

### 6.2 实时音视频交互

论文构建了专有的端到端实时音视频交互评测框架：10 位专业对话者与每个模型进行约 3 分钟多轮对话，共 200 场，覆盖问题解决/娱乐/自我提升/情感支持四类；250 位真实用户三重标注自然度与流畅度（0-3 分），专家做六维定性分析。

| 模型 | 评分 | 95% CI |
|---|---|---|
| Doubao | 1.92 | [1.85, 1.98] |
| GPT-4o | 1.79 | [1.72, 1.85] |
| **LongCat-Flash-Omni** | **1.37** | [1.30, 1.44] |
| Qwen3-Omni | 0.81 | [0.75, 0.87] |

LongCat-Flash-Omni 排名第三（仅次于 Doubao、GPT-4o），在开源阵营中比 Qwen3-Omni 高 0.56 分。定性分析中，副语言理解（91.5）、相关性（54.5）、记忆能力（94.5）表现突出，但在实时性、拟人度、准确性上仍有差距——例如对用户停顿过于敏感、偶发发音错误/电子音、对动态物体识别强但文本数字信息识别较弱。

## 7. 消融实验

### 7.1 预训练各阶段音频能力演进

论文追踪了 Stage-1 到 Stage-4 base model 在 ASR、TTS、语音延续三项任务上的表现：

| Base Model | SpeechIO02 ASR↓ | LibriSpeech test-clean ASR↓ | SpeechIO02 TTS↓ | CMMLU 语音延续（Audio In/Out）|
|---|---|---|---|---|
| Stage-1 | 2.93 | 1.98 | 4.12 | 84.80 |
| Stage-2 | 3.18 | 2.11 | 8.64 | 84.80 |
| Stage-3 | 3.01 | 1.93 | 3.68 | 92.00 |
| Stage-4 (32K) | 3.49 | 2.30 | 1.73 | 91.20 |
| Stage-4 (128K) | 3.46 | 2.12 | 2.62 | 90.40 |

观察：Stage-3 退火显著提升语音延续（84.8→92.0）与 TTS（8.64→3.68）；上下文扩展到 128K 后 ASR 略有回退但仍在可用范围。各阶段文本与语音输出准确率差异极小，验证了离散音频 token 在 next-token prediction 范式下的有效性。

### 7.2 训练基础设施效率

**模态计算异构性**（Table 2，每 micro-batch TFLOPs）：

| 模块 | min | max | mean | std |
|---|---|---|---|---|
| Audio Encoder | 0.01 | 109.96 | 3.29 | 7.94 |
| Vision Encoder | 0.08 | 400.37 | 89.85 | 61.02 |
| LLM Decoder | 1920.57 | 4667.74 | 3531.32 | 1111.11 |

LLM 计算量是视觉编码器的 ~40 倍、音频编码器的 ~1000 倍，且方差巨大——这正是模态解耦并行的动机。

**Modality-Decoupled Parallelism（MDP）**的核心思想是在分布式层面完全解耦模态编码器与 LLM 骨干，使两者可独立调度。模态编码器用 HSDP 降低静态内存、全激活重计算降低激活内存；LLM 骨干用 PP + ZeRO-1 DP + CP + EP 组合。引入 InnerDP 维度（`d_inner_dp = d_lm_cp × d_lm_pp`）使模态编码器的 DP rank 与 LLM 一一对应：

![Figure 8 MDP 执行总览：模态编码器（HSDP）与 LLM 骨干（PP+CP+EP）在分布式层面完全解耦，四阶段执行——数据加载→模态编码器前向→LLM 前向反向→模态编码器反向；ModalityBridge 作为通信层转换两侧不同并行策略的数据格式](/vibe-reading/images/articles/longcat-flash-omni-technical-report/fig-08-mdp-overview.png)

MDP 执行时间线分四阶段：① 数据加载（inner_dp=0 拉取全部 micro-batch 并广播元数据，按文本序列长度排序平衡 DP 组负载）；② 模态编码器前向（BalanceData 分发数据，各 rank 算 embedding，ModalityBridge 聚合到 inner_dp=0）；③ LLM 前向反向（embedding 在 CP rank 上分区送入 LLM，梯度回传给模态编码器）；④ 模态编码器反向。其中 **ModalityBridge** 作为通信层，负责 forward 时 embedding 的 gather/scatter 与 backward 时梯度的反向重分发，采用 chunk-based 处理将峰值内存降到原来的 1/num_chunk，同时保持 bitwise 数值一致。

**内存优化叠加效果**（Table 4，目标配置理论 ~72GB / 80GB 设备）：

| 优化项 | Static | Dynamic | Others | Total |
|---|---|---|---|---|
| Baseline | 20.4 | 103.2 | 13.4 | 137.0 |
| +HSDP for Modality Encoder | 17.5 | 103.2 | 13.4 | 134.1 |
| +V-half PP schedule | 17.5 | 58.6 | 13.4 | 89.4 |
| +Selective Recompute | 17.5 | 49.2 | 13.4 | 80.1 |
| +Memory Efficient Permute | 17.5 | 42.8 | 13.4 | 73.6 |
| +NCCL Memory Optimization | 17.5 | 42.8 | 8.9 | **69.1** |

从 137GB 压到 69.1GB，关键贡献来自 V 型 PP 调度（-44.6GB 动态）、选择性重计算（-9.4GB）、内存高效 permute（-6.4GB）。最终多模态训练吞吐保持纯文本训练的 **90%+**。

## 8. 总结与展望

### 贡献总结

LongCat-Flash-Omni 证明了三件事：① 大规模 MoE 模型可以在不牺牲任一单模态性能的前提下获得深度跨模态理解；② 课程式渐进预训练 + early fusion 是管理模态异构的有效范式；③ 模态解耦并行（MDP）让 560B 规模的多模态训练效率逼近纯文本训练。结合 human-in-the-loop 数据构造与 128K 上下文窗口，模型在多轮对话、时序推理、记忆保持上达到开源全模态 SOTA。

### 局限性（批判性）

论文坦诚指出几处不足：

- **实时性**：对用户停顿过于敏感，常过早发起响应并打断用户。
- **拟人度**：偶发发音错误、卡顿、电子音伪影。
- **准确性**：动态物体识别强，但文本与数字信息识别下降；存在过度附和用户而忽视视觉内容的倾向。
- **未评测 thinking 模式**：与 Gemini-2.5-Pro 对比时限制了 thinking budget，未在完整 thinking 模式下公平对比。
- **UNO-Bench 自评**：论文引入的新基准 UNO-Bench 由团队自建，虽声称防数据污染，但自建基准的自评优势需社区独立验证。

### 未来方向（idea 三法）

- **弥补缺陷**：优化 VAD 端点检测与 speculative prefill-decode 切换的协同，减少过早响应；引入发音/数字专项数据提升文本数字识别。
- **新型方案**：探索 adaptive thinking mode——在简单查询时保持低延迟流式，在复杂推理时动态切换到 thinking 模式，兼顾实时性与深度。
- **减少约束**：将流式音视频交互能力延伸到具身智能（embodied）与多智能体场景，探索 richer forms 的交互范式；将 modality-decoupled parallelism 推广到更多模态（如触觉、传感器流）。

## 相关阅读

- [LongCat-Image Technical Report](/vibe-reading/articles/longcat-image-technical-report) — **同家族**·图像生成姊妹模型，同栈 LongCat-ViT + RLHF 方法论对照
- [LongCat-Video Technical Report](/vibe-reading/articles/longcat-video-technical-report) — **同家族**·视频版同套方法论（13.6B DiT + 多奖励 GRPO），本篇视频能力的基石
- [LongCat Sparse Attention](/vibe-reading/articles/longcat-sparse-attention) — **背景知识**·LongCat 文本模型的长上下文稀疏注意力机制，本篇 128K 上下文的底座能力
- [LongCat-AudioDiT: High-Fidelity Diffusion TTS](/vibe-reading/articles/longcat-audiodit-waveform-latent-diffusion-tts) — **同家族**·音频生成侧的波形潜空间扩散 TTS，与本篇音频编解码互补
- [firered-image-edit](/vibe-reading/articles/firered-image-edit) — **方法论镜像**·扩散图像编辑 + 多阶段 RLHF/DPO，与本篇多阶段训练 + 联合 DPO 横向对照
