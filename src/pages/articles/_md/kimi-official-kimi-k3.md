---
title: "Kimi K3: Open Frontier Intelligence"
source:
  type: "article"
  project: "Kimi"
  url: "https://www.kimi.com/blog/kimi-k3"
  author: "Moonshot AI"
  site: "Kimi 官方博客"
date: "2026-08-01T21:30:00+08:00"
category: [AI, Models, Text Model, Official]
tags: ["Kimi K3", "MoE", "KDA", "Attention Residuals", "Stable LatentMoE", "Agentic", "Open Weights", "1M Context"]
description: "首个开放 3T 级模型，2.8T 参数，基于 Kimi Delta Attention 与 Attention Residuals，原生视觉 + 1M token 上下文。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Kimi K3: Open Frontier Intelligence](https://www.kimi.com/blog/kimi-k3) · **作者** Moonshot AI · **来源** Kimi 官方博客 · **中英对照·AI 译** 2026-08-01
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

Today, we are introducing Kimi K3 — our most capable model. Kimi K3 is a 2.8T-parameter model built on our Kimi Delta Attention and Attention Residuals, with native vision capabilities and a 1-million-token context window. It is the world's first open 3T-class model, designed for frontier intelligence across long-horizon coding, knowledge work, and reasoning.

> **译：** 今天，我们推出 Kimi K3——我们最强大的模型。Kimi K3 是一个 2.8T 参数的模型，构建在我们的 Kimi Delta Attention 和 Attention Residuals 之上，具备原生视觉能力和 100 万 token 的上下文窗口。它是全球首个开放的 3T 级模型，旨在实现长程编码、知识工作和推理方面的前沿智能。

While its overall performance still trails the most powerful proprietary models, Claude Fable 5 and GPT 5.6 Sol, Kimi K3 demonstrated frontier-level performance across our evaluation suite, consistently outperforming other tested models.

> **译：** 尽管其整体性能仍落后于最强大的闭源模型 Claude Fable 5 和 GPT 5.6 Sol，但 Kimi K3 在我们的评测套件中展现了前沿级别的性能，持续超越其他受测模型。

![Kimi K3 benchmark comparison](/vibe-reading/images/articles/kimi-official-kimi-k3/fig-1.png)

![Kimi K3 benchmark comparison](/vibe-reading/images/articles/kimi-official-kimi-k3/fig-2.png)

![Kimi K3 showcase](/vibe-reading/images/articles/kimi-official-kimi-k3/fig-3.png)

![Kimi K3 showcase](/vibe-reading/images/articles/kimi-official-kimi-k3/fig-4.png)

Kimi K3 is available today on [Kimi.com](https://www.kimi.com/), [Kimi Work](https://www.kimi.com/products/kimi-work), [Kimi Code](https://www.kimi.com/code), and the [Kimi API](https://platform.kimi.ai/). At launch, Kimi K3 will use max thinking effort by default, with low- and high-effort modes to be introduced in subsequent updates. We are currently working closely with inference partners and open-source maintainers to align technical details and ensure a reliable rollout across the ecosystem. The full model weights will be released by July 27, 2026. Further details on the architecture, training, and evaluations will be released alongside the Kimi K3 technical report.

> **译：** Kimi K3 今日起在 [Kimi.com](https://www.kimi.com/)、[Kimi Work](https://www.kimi.com/products/kimi-work)、[Kimi Code](https://www.kimi.com/code) 和 [Kimi API](https://platform.kimi.ai/) 上线。发布时，Kimi K3 默认使用最大思考强度，低强度和高强度模式将在后续更新中推出。我们目前正与推理合作伙伴和开源维护者密切协作，对齐技术细节并确保在整个生态系统中可靠发布。完整模型权重将于 2026 年 7 月 27 日发布。关于架构、训练和评测的更多细节将随 Kimi K3 技术报告一同发布。

## An Open 3T-Class Model

Kimi K3 is the first open model to reach 2.8 trillion parameters. It marks the latest step in Kimi's sustained push at the scaling frontier: for nine of the past twelve months, Kimi models have set the upper bound of open-model sizes.

> **译：** Kimi K3 是首个达到 2.8 万亿参数的开放模型。这标志着 Kimi 在扩展前沿持续推进的最新一步：在过去十二个月中有九个月，Kimi 模型设定了开放模型规模的上限。

Kimi K3 is built on Kimi Delta Attention (KDA) and Attention Residuals (AttnRes), two architectural updates designed to improve how information flows across sequence length and model depth. We have also scaled up Mixture of Experts (MoE) sparsity, effectively activating 16 out of 896 experts when paired with a Stable LatentMoE framework. Together with refined training and data recipes, these structural changes yield an approximate 2.5× improvement in overall scaling efficiency compared to Kimi K2, allowing the model to convert compute into intelligence more effectively.

> **译：** Kimi K3 基于 Kimi Delta Attention（KDA）和 Attention Residuals（AttnRes）构建，这是两个旨在改善信息在序列长度和模型深度上流动方式的架构更新。我们还在 Mixture of Experts（MoE）稀疏性上进行了扩展，在与 Stable LatentMoE 框架配合时有效激活 896 个专家中的 16 个。结合改进的训练和数据配方，这些结构性变化使整体扩展效率相比 Kimi K2 提升约 2.5 倍，让模型能更有效地将算力转化为智能。

![Block Attention Residuals architecture diagram](/vibe-reading/images/articles/kimi-official-kimi-k3/fig-6.png)

## Coding

Kimi K3 has strong long-horizon coding performance. Operating with minimal human oversight, it can sustain long engineering sessions, navigate massive repositories, and orchestrate terminal tools.

> **译：** Kimi K3 具有强大的长程编码性能。在极少人工监督下运行，它能维持长时间的工程会话、导航大型代码仓库并编排终端工具。

Kimi K3 also excels in tasks blending software engineering with visual reasoning — it leverages screenshots and visuals to optimize game dev, frontend, and CAD.

> **译：** Kimi K3 在融合软件工程与视觉推理的任务上也表现出色——它利用截图和视觉内容来优化游戏开发、前端和 CAD。

The case studies below show how Kimi K3's coding capability translates into open-ended software creation and scientific research.

> **译：** 以下案例展示了 Kimi K3 的编码能力如何转化为开放式软件创作和科学研究。

### Kernel Optimization

We tested the models' capability to optimize GPU kernels. Each model works independently in an identical sandbox, with up to 24 hours to profile, rewrite, and benchmark four tasks spanning AttnRes, KDA, and a 512-head-dimension MLA kernel across NVIDIA Hopper GPUs and GPGPU from an alternative vendor. Kimi K3 performed competitively with Fable 5 (with fallback) and substantially outperformed Opus 4.8, GPT 5.6 Sol, and GPT 5.5.

> **译：** 我们测试了模型优化 GPU kernel 的能力。每个模型在相同的沙箱中独立工作，最多有 24 小时来分析、重写和基准测试四项任务，涵盖 AttnRes、KDA 和一个 512 头维度的 MLA kernel，在 NVIDIA Hopper GPU 和来自另一供应商的 GPGPU 上运行。Kimi K3 的表现与 Fable 5（带 fallback）相当，并大幅超越 Opus 4.8、GPT 5.6 Sol 和 GPT 5.5。

Claude Fable 5 was evaluated by a third party, and its results may include fallback behavior. Across most models, some trajectories include small, acceptable precision shortcuts that remain within our numerical tolerance. GPGPU denotes general-purpose GPUs used for computation beyond graphics rendering.

> **译：** Claude Fable 5 由第三方评估，其结果可能包含 fallback 行为。在大多数模型中，部分轨迹包含微小的、可接受的精度捷径，这些仍在我们的数值容差范围内。GPGPU 指用于图形渲染之外计算的通用 GPU。

In the late stages of Kimi K3 development, an early version of Kimi K3 handled the majority of the team's kernel optimization works.

> **译：** 在 Kimi K3 开发的后期阶段，Kimi K3 的早期版本处理了团队大部分的 kernel 优化工作。

### GPU Compiler Development

We further tested whether Kimi K3 could build a GPU programming system from scratch. Kimi K3 developed MiniTriton, a compact Triton-like compiler with its own tile-level IR layer over MLIR, optimization passes, and a PTX code-generation pipeline. Across supported roofline benchmarks, MiniTriton delivers performance on par with or better than Triton and torch.compile — beating Triton on certain workloads. Beyond microbenchmarks, MiniTriton sustains end-to-end nanoGPT training with stable convergence, the loss curve closely tracking the reference with only minor divergence — validating the full pipeline on a realistic workload. These results demonstrate that Kimi K3 can build a coherent end-to-end compiler — from DSL frontend and IR passes to PTX codegen and runtime — rather than isolated kernels; its from-scratch Tensor Core path already rivals Triton's extensively optimized stack.

> **译：** 我们进一步测试了 Kimi K3 能否从零构建 GPU 编程系统。Kimi K3 开发了 MiniTriton，一个紧凑的类 Triton 编译器，拥有自己的基于 MLIR 的 tile 级 IR 层、优化 pass 和 PTX 代码生成流水线。在支持的 roofline 基准测试中，MiniTriton 提供与 Triton 和 torch.compile 相当或更优的性能——在某些工作负载上超越 Triton。除微基准测试外，MiniTriton 还支持端到端 nanoGPT 训练，收敛稳定，损失曲线紧贴参考线，仅有轻微偏差——在真实工作负载上验证了整个流水线。这些结果表明 Kimi K3 能够构建一个连贯的端到端编译器——从 DSL 前端和 IR pass 到 PTX 代码生成和运行时——而非孤立的 kernel；其从零开始的 Tensor Core 路径已能与 Triton 经优化的栈相匹敌。

![MiniTriton CUDA-core roofline on NVIDIA L20](/vibe-reading/images/articles/kimi-official-kimi-k3/fig-7.png)

### Game Dev and Digital Creation

Kimi K3 combines strong 3D reasoning, coding, and vision capabilities to turn concepts, images, and videos into fully playable interactive experiences. Kimi K3 achieves true "vision in the loop" by seamlessly iterating between code and live screenshots—instantly seeing and refining outputs.

> **译：** Kimi K3 结合强大的 3D 推理、编码和视觉能力，将概念、图像和视频转化为完全可玩的交互式体验。Kimi K3 通过在代码和实时截图之间无缝迭代——即时查看和优化输出——实现了真正的"视觉在环"。

### Chip Design

As an early proof of concept, Kimi K3 designed a chip to serve a nano model built on its own architecture. In a single 48-hour autonomous run, K3 built, optimized, and verified the chip using open-source EDA tools on the Nangate 45nm library. Within 4 mm², the chip closes timing at 100 MHz and sustains over 8,700 tokens/s decode throughput in simulation, packing 1.46M standard cells, 0.277 MB of SRAM, and an INT4 MAC array with fused dequantization. A chip built by a model, for a model, reflects K3's long-horizon agentic capabilities.

> **译：** 作为早期概念验证，Kimi K3 设计了一款芯片，用于服务于基于其自身架构构建的 nano 模型。在一次 48 小时的自主运行中，K3 使用开源 EDA 工具在 Nangate 45nm 库上构建、优化并验证了该芯片。在 4 mm² 面积内，芯片在 100 MHz 下满足时序约束，在仿真中维持超过 8,700 tokens/s 的解码吞吐量，包含 1.46M 标准单元、0.277 MB SRAM 和带融合反量化的 INT4 MAC 阵列。一个由模型构建、为模型服务的芯片，体现了 K3 的长程 agentic 能力。

### Coding for Research

Kimi K3 bridges scientific literature and executable code, autonomously implementing, validating, and analyzing complex computational research workflows.

> **译：** Kimi K3 连接科学文献与可执行代码，自主实现、验证和分析复杂的计算研究工作流。

In one case, Kimi K3 completed in about two hours what would typically require one to two weeks of work by an experienced researcher. To reproduce the I–Love–Q universal relations in computational astrophysics, it reviewed and cross-validated 20+ papers, implemented the full numerical pipeline, evaluated 300+ equations of state, identified inconsistencies in published formulas, generated 3,000+ lines of Python code, and produced an interactive HTML dashboard for exploring the results.

> **译：** 在一个案例中，Kimi K3 在约两小时内完成了一位经验丰富的研究者通常需要一到两周才能完成的工作。为复现计算天体物理学中的 I–Love–Q 普适关系，它审阅并交叉验证了 20+ 篇论文，实现了完整的数值流水线，评估了 300+ 个状态方程，识别了已发表论文中的不一致之处，生成了 3,000+ 行 Python 代码，并制作了一个可交互的 HTML 仪表板来探索结果。

## Knowledge Work

Kimi K3 advances end-to-end knowledge work. Beyond public benchmarks, Kimi K3 (max) demonstrates consistent gains across our internal evaluations, which are derived from recurring patterns and challenges observed in real-world user-agent workflows. These consistent advantages across distinct production-oriented workflows reflect a broad improvement in Kimi K3's agentic knowledge work capabilities.

> **译：** Kimi K3 推进端到端的知识工作。除公开基准测试外，Kimi K3（max）在我们的内部评测中展现出持续提升，这些评测源自真实世界用户-agent 工作流中观察到的反复出现的模式和挑战。这些在不同面向生产的工作流中的一致优势反映了 Kimi K3 在 agentic 知识工作能力上的广泛提升。

![Internal Knowledge Work Bench](/vibe-reading/images/articles/kimi-official-kimi-k3/fig-5.png)

### Research with Interactive Visualization

Below are a few examples of what Kimi K3 in Kimi Work can produce across financial consulting and scientific research:

> **译：** 以下是 Kimi K3 在 Kimi Work 中能够产出的几个示例，涵盖金融咨询和科学研究：

### Case 1: Interactive 42 years of AI ASIC industry research website

An interactive research report you can drill into: 42 years of the ASIC industry, created through 120+ rounds of recursive self-improvement. Kimi K3 transforms evidence into bespoke charts, animated diagrams, and interactive visual narratives. It pulled data via 2.8k+ web searches/fetches and 1.1k+ terminal data pulls, across 11k+ pages spanning 87 quarterly reports and 99 original PDFs.

> **译：** 一份可深入钻取的交互式研究报告：ASIC 行业 42 年，通过 120+ 轮递归自改进创建。Kimi K3 将证据转化为定制图表、动画图示和交互式视觉叙事。它通过 2.8k+ 次网络搜索/抓取和 1.1k+ 次终端数据拉取，横跨 11k+ 页、87 份季度报告和 99 份原始 PDF 来获取数据。

### Case 2: Fusion Industry Research

A consulting-style industry report with interactive visualizations—including timelines, Funnel Chart, Range Bar Chart, Gantt Charts, and publication-quality slides.

> **译：** 一份咨询风格的行业报告，包含交互式可视化——包括时间线、漏斗图、范围条形图、甘特图和出版质量的幻灯片。

### Case 3: GWTC-5 Gravitational-wave Analysis

An analysis of 391 gravitational-wave events using 20+ concurrent subagents, producing 7 scientific visualizations, 2 tables, and a literature synthesis from 10+ papers.

> **译：** 使用 20+ 个并发子 agent 对 391 个引力波事件进行分析，产出 7 个科学可视化、2 个表格和一份基于 10+ 篇论文的文献综述。

Kimi K3 is also particularly effective at producing infographic-style presentations, such as the fully editable heatmap and annual report shown below:

> **译：** Kimi K3 在制作信息图式演示文稿方面也特别有效，例如下面展示的完全可编辑热力图和年度报告：

### Widgets and Dashboard

In Kimi Work, we introduce two new features - Widgets and Dashboard - which make interactions with Kimi K3 more visual and persistent. Widgets let you generate interactive components directly within a chat, with connections to local data or external plugins for continuous updates. Dashboard brings the widgets you care about most into one persistent, personalized view organized around a topic, project, or goal.

> **译：** 在 Kimi Work 中，我们引入了两个新功能——Widgets 和 Dashboard——使与 Kimi K3 的交互更加可视化和持久化。Widgets 让你在聊天中直接生成交互式组件，可连接本地数据或外部插件以持续更新。Dashboard 将你最关心的 widgets 汇集到一个围绕主题、项目或目标组织的持久化个性化视图中。

### Video Editing

Kimi K3 excels at motion design, animation, and video editing because its native multimodal architecture understands text, images, and video within the same model.

> **译：** Kimi K3 在动效设计、动画和视频编辑方面表现出色，因为其原生多模态架构在同一模型内理解文本、图像和视频。

In one example, K3 created a 3Blue1Brown-style motion-graphics explainer of its own architecture, translating technical ideas into animated diagrams and transitions.

> **译：** 在一个示例中，K3 创建了一个 3Blue1Brown 风格的动效图解，解释其自身架构，将技术概念转化为动画图示和转场。

In another, Kimi K3 edited its own teaser video from 56 source clips, handling clip selection, motion-matched cuts, frame-accurate beat synchronization, audio processing, and multiple rounds of revision. A high-density short video like this would typically take an experienced editor one to two working days, or a beginner three to five.

> **译：** 在另一个示例中，Kimi K3 从 56 个原始片段编辑了自己的预告片，处理片段选择、运动匹配剪辑、帧精确节拍同步、音频处理和多轮修改。这样一支高密度短视频通常需要一位经验丰富的剪辑师一到两个工作日，或初学者三到五天。

### Architecture and Infrastructure

Kimi K3 is built on Kimi Delta Attention (KDA) and Attention Residuals (AttnRes). KDA provides an efficient foundation for scaling attention, while AttnRes selectively retrieves representations across depth rather than accumulating them uniformly. Together, they form the architectural backbone of a model designed to scale well beyond the trillion-parameter regime.

> **译：** Kimi K3 基于 Kimi Delta Attention（KDA）和 Attention Residuals（AttnRes）构建。KDA 为扩展注意力提供了高效基础，而 AttnRes 选择性地跨深度检索表示，而非均匀累积。两者共同构成了一个旨在扩展到万亿参数级别以外的模型的架构骨干。

Kimi K3 uses Stable LatentMoE, effectively activating 16 of 896 experts. At this level of sparsity, routing and optimization become first-order challenges. Quantile Balancing derives expert allocation directly from router-score quantiles, eliminating heuristic updates and a sensitive balancing hyperparameter, while Per-Head Muon extends Muon by optimizing attention heads independently for more adaptive learning at scale. Sigmoid Tanh Unit (SiTU) and Gated MLA improve activation control and attention selectivity respectively. Together, these advances enable stable and efficient training at the 2.8-trillion-parameter scale.

> **译：** Kimi K3 使用 Stable LatentMoE，有效激活 896 个专家中的 16 个。在这种稀疏程度下，路由和优化成为一阶挑战。Quantile Balancing 直接从路由器分数分位数推导专家分配，消除了启发式更新和一个敏感的平衡超参数；Per-Head Muon 通过独立优化注意力头来扩展 Muon，以在大规模下实现更自适应的学习。Sigmoid Tanh Unit（SiTU）和 Gated MLA 分别改善激活控制和注意力选择性。这些进展共同使 2.8 万亿参数规模的稳定高效训练成为可能。

Kimi K3 applies quantization-aware training from the SFT stage onward, using MXFP4 weights with MXFP8 activations for broad hardware compatibility. To prevent expert imbalance from degrading throughput at large expert-parallel scales, we introduce a fully balanced expert-parallel training method with static shapes and no host synchronization on the critical path. Since inference efficiency likewise benefits from larger high-bandwidth communication domains, we recommend deploying Kimi K3 on supernode configurations with 64 or more accelerators. Finally, as KDA poses new challenges for conventional prefix caching, we have contributed a corresponding implementation to the vLLM community, to be released alongside the model. KDA with prefill cache allows us to serve Kimi K3 at a highly competitive token price despite its scale and long context.

> **译：** Kimi K3 从 SFT 阶段起应用量化感知训练，使用 MXFP4 权重和 MXFP8 激活值以实现广泛的硬件兼容性。为防止专家不平衡在大型专家并行规模下降低吞吐量，我们引入了一种完全平衡的专家并行训练方法，具有静态形状且关键路径上无主机同步。由于推理效率同样受益于更大的高带宽通信域，我们建议在配备 64 个或以上加速器的超节点配置上部署 Kimi K3。最后，由于 KDA 对传统前缀缓存提出了新挑战，我们已向 vLLM 社区贡献了相应实现，将随模型一同发布。KDA 与 prefill 缓存使我们能够以极具竞争力的 token 价格提供 Kimi K3 服务，尽管其规模庞大且上下文很长。

More technical details will be available in our coming report.

> **译：** 更多技术细节将在我们即将发布的报告中提供。

## Availability
- Kimi K3 Agents: Download or update to the latest Kimi app from your mobile app store, available on iOS, Android, and HarmonyOS, or visit [kimi.com](https://www.kimi.com/).
- Work with Kimi K3: Download the latest [Kimi Work desktop app](https://www.kimi.com/products/kimi-work), version 3.1.0 or later, available for Windows and Apple silicon Macs.
- Code with Kimi K3: Run [Kimi Code](https://www.kimi.com/code) in your terminal and select Kimi K3 using the `/model` command.
- Build with the Kimi API: Visit the [Kimi API Platform](https://platform.kimi.ai/) and select `kimi-k3`. Pricing is $0.30/MTok for cache-hit input, $3.00/MTok for cache-miss input, and $15.00/MTok for output. Powered by Mooncake's disaggregated inference architecture, the official Kimi API achieves a cache hit rate above 90% in coding workloads.
- Bring Kimi to your organization: [Kimi Enterprise](https://www.kimi.com/membership/pricing) provides enterprise-grade data privacy and member management, with complete separation between personal and organization accounts. Visit the pricing page and select "Get Kimi Enterprise" to subscribe for your team.

> **译：**
> - Kimi K3 Agents：从移动应用商店下载或更新至最新 Kimi 应用，支持 iOS、Android 和 HarmonyOS，或访问 [kimi.com](https://www.kimi.com/)。
> - 使用 Kimi K3 工作：下载最新的 [Kimi Work 桌面应用](https://www.kimi.com/products/kimi-work)，版本 3.1.0 或更高，支持 Windows 和 Apple 芯片 Mac。
> - 用 Kimi K3 编码：在终端运行 [Kimi Code](https://www.kimi.com/code) 并使用 `/model` 命令选择 Kimi K3。
> - 用 Kimi API 构建：访问 [Kimi API 平台](https://platform.kimi.ai/)并选择 `kimi-k3`。定价为缓存命中输入 $0.30/MTok、缓存未命中输入 $3.00/MTok、输出 $15.00/MTok。基于 Mooncake 的分离式推理架构，官方 Kimi API 在编码工作负载中实现 90% 以上的缓存命中率。
> - 将 Kimi 引入你的组织：[Kimi Enterprise](https://www.kimi.com/membership/pricing) 提供企业级数据隐私和成员管理，个人与组织账户完全分离。访问定价页面并选择"Get Kimi Enterprise"为你的团队订阅。

### Full Benchmark Table

## Footnotes

All Kimi K3 results reported below are obtained with the reasoning effort set to 'max', setting temperature = 1.0 and top-p = 1.0. Depending on the benchmark, each model is evaluated under one of three agentic harnesses — Kimi Code, Claude Code, or Codex — as specified in the notes below.

> **译：** 以下报告的所有 Kimi K3 结果均在推理强度设为 'max'、temperature = 1.0 和 top-p = 1.0 的条件下获得。根据基准测试的不同，每个模型在三种 agentic 测试框架之一——Kimi Code、Claude Code 或 Codex——下评估，如下方注释所述。

### Coding benchmarks

  1. **DeepSWE.** Kimi K3 is evaluated with the Kimi Code harness. The GLM-5.2 score is taken from the GLM-5.2 release blog (<https://z.ai/blog/glm-5.2>); all remaining scores are from the official DeepSWE leaderboard (<https://deepswe.datacurve.ai/>), under which Kimi K3 attains 67.3 with the mini-SWE-agent harness. We report the DeepSWE v1.1 tasks.

  > **译：** **DeepSWE。** Kimi K3 使用 Kimi Code 框架评估。GLM-5.2 分数取自 GLM-5.2 发布博客（<https://z.ai/blog/glm-5.2>）；其余所有分数来自官方 DeepSWE 排行榜（<https://deepswe.datacurve.ai/>），其中 Kimi K3 使用 mini-SWE-agent 框架获得 67.3 分。我们报告 DeepSWE v1.1 任务。

  2. **Terminal-Bench 2.1.** Kimi K3 is evaluated with the Kimi Code harness. For all other models, we report the best score across harnesses: GLM-5.2 with Claude Code (<https://z.ai/blog/glm-5.2>); Claude Opus 4.8 and Claude Fable 5 with Terminus 2 (<https://artificialanalysis.ai/evaluations/terminalbench-v2-1>); GPT 5.5 and GPT 5.6 Sol with Codex (<https://openai.com/index/previewing-gpt-5-6-sol/>).

  > **译：** **Terminal-Bench 2.1。** Kimi K3 使用 Kimi Code 框架评估。对于所有其他模型，我们报告跨框架的最佳分数：GLM-5.2 使用 Claude Code（<https://z.ai/blog/glm-5.2>）；Claude Opus 4.8 和 Claude Fable 5 使用 Terminus 2（<https://artificialanalysis.ai/evaluations/terminalbench-v2-1>）；GPT 5.5 和 GPT 5.6 Sol 使用 Codex（<https://openai.com/index/previewing-gpt-5-6-sol/>）。

  3. **Program Bench.** Kimi K3 is evaluated with the Kimi Code harness. The GLM-5.2 score is from <https://z.ai/blog/glm-5.2>; all other scores are from <https://www.vals.ai/benchmarks/programbench>.

  > **译：** **Program Bench。** Kimi K3 使用 Kimi Code 框架评估。GLM-5.2 分数来自 <https://z.ai/blog/glm-5.2>；所有其他分数来自 <https://www.vals.ai/benchmarks/programbench>。

  4. **SWE Marathon.** Kimi K3, Claude Opus 4.8, and Claude Fable 5 are evaluated with the Claude Code harness; GPT-5.6 Sol is evaluated with the Codex harness. The GLM-5.2 score is from <https://z.ai/blog/glm-5.2>. Our evaluation is based on an H20-calibrated branch of the official v1.1 tasks (<https://www.swe-marathon.org/>): the Docker images, performance gates, and reference oracles for the GPU tasks have been recalibrated for H20, while the correctness and anti-cheat validators remain unchanged. Additionally, Claude Fable 5 hit fallbacks on 35% of the tasks in our evaluation, which may have negatively impacted its measured performance.

  > **译：** **SWE Marathon。** Kimi K3、Claude Opus 4.8 和 Claude Fable 5 使用 Claude Code 框架评估；GPT-5.6 Sol 使用 Codex 框架评估。GLM-5.2 分数来自 <https://z.ai/blog/glm-5.2>。我们的评测基于官方 v1.1 任务的 H20 校准分支（<https://www.swe-marathon.org/>）：GPU 任务的 Docker 镜像、性能门控和参考 oracle 已为 H20 重新校准，而正确性和反作弊验证器保持不变。此外，Claude Fable 5 在我们评测中 35% 的任务上触发了 fallback，这可能对其测得性能产生了负面影响。

  5. **FrontierSWE.** Kimi K3 is evaluated with the Kimi Code harness and GPT-5.6 Sol with the Codex harness; all other results are from <https://www.frontierswe.com/>. Dominance scores are recomputed from the raw scores using the official evaluation script and are current as of July 16, 2026.

  > **译：** **FrontierSWE。** Kimi K3 使用 Kimi Code 框架评估，GPT-5.6 Sol 使用 Codex 框架；所有其他结果来自 <https://www.frontierswe.com/>。Dominance 分数使用官方评测脚本从原始分数重新计算，截至 2026 年 7 月 16 日。

  6. **PostTrain Bench.** Scores for GLM-5.2, GPT-5.5, and Claude Opus 4.8 are adopted from the official PostTrainBench (<https://posttrainbench.com/>) results. Kimi K3, Claude Fable 5, and GPT-5.6 Sol are evaluated with the official Harbor implementation at maximum reasoning effort, averaged over three runs on H20 GPU (instead of H100 in the official setting) — Kimi K3 and Claude Fable 5 with the Claude Code harness, and GPT-5.6 Sol with the Codex harness.

  > **译：** **PostTrain Bench。** GLM-5.2、GPT-5.5 和 Claude Opus 4.8 的分数采纳自官方 PostTrainBench（<https://posttrainbench.com/>）结果。Kimi K3、Claude Fable 5 和 GPT-5.6 Sol 使用官方 Harbor 实现在最大推理强度下评估，在 H20 GPU（而非官方设置中的 H100）上取三次运行的平均值——Kimi K3 和 Claude Fable 5 使用 Claude Code 框架，GPT-5.6 Sol 使用 Codex 框架。

  7. **MLS Bench Lite.** Kimi K3 is evaluated with the Kimi Code harness; GLM-5.2 and the Claude models with the Claude Code harness; GPT-5.5 and GPT-5.6 Sol with the Codex harness.

  > **译：** **MLS Bench Lite。** Kimi K3 使用 Kimi Code 框架评估；GLM-5.2 和 Claude 模型使用 Claude Code 框架；GPT-5.5 和 GPT-5.6 Sol 使用 Codex 框架。

  8. **KCB 2.0.** Kimi K3 is evaluated with both the Kimi Code and Claude Code harnesses; GLM-5.2, Claude Opus 4.8, and Claude Fable 5 with the Claude Code harness; GPT-5.5 and GPT-5.6 Sol with the Codex harness. All models are evaluated at maximum reasoning effort, except GPT-5.5, which uses the "xhigh" setting. We also note that on this in-house benchmark, 10% of the tasks entered GPT-5.6 Sol's cyber guard.

  > **译：** **KCB 2.0。** Kimi K3 同时使用 Kimi Code 和 Claude Code 框架评估；GLM-5.2、Claude Opus 4.8 和 Claude Fable 5 使用 Claude Code 框架；GPT-5.5 和 GPT-5.6 Sol 使用 Codex 框架。所有模型在最大推理强度下评估，GPT-5.5 除外，它使用"xhigh"设置。我们还注意到，在这个内部基准测试中，10% 的任务进入了 GPT-5.6 Sol 的 cyber guard。

### Productivity and agentic benchmarks

  1. For OfficeQA Pro, each test case provides the agent with the entire PDF corpus, with all PDFs rendered as images and no machine-readable text available.

  > **译：** 对于 OfficeQA Pro，每个测试用例为 agent 提供完整的 PDF 语料库，所有 PDF 渲染为图像，无机器可读文本。

  2. **OfficeQA Pro and SpreadsheetBench 2.** Kimi K3, GLM-5.2, Claude Opus 4.8, and Claude Fable 5 are evaluated with the Claude Code harness; GPT 5.5 and GPT 5.6 Sol are evaluated with the Codex harness.

  > **译：** **OfficeQA Pro 和 SpreadsheetBench 2。** Kimi K3、GLM-5.2、Claude Opus 4.8 和 Claude Fable 5 使用 Claude Code 框架评估；GPT 5.5 和 GPT 5.6 Sol 使用 Codex 框架评估。

  3. **MCP Atlas.** All models are evaluated on the 500-task public subset with a 100-turn limit, using Gemini 3.1 Pro as the judge.

  > **译：** **MCP Atlas。** 所有模型在 500 任务公开子集上评估，限制 100 轮，使用 Gemini 3.1 Pro 作为评判者。

  4. **AutomationBench.** All models are evaluated on the 600-task public subset, following the official GitHub setup in all other respects.

  > **译：** **AutomationBench。** 所有模型在 600 任务公开子集上评估，其余方面遵循官方 GitHub 设置。

  5. **BrowseComp.** We adopt the context-compaction strategy used in the Claude model cards, triggered at 300K tokens. When evaluated with a 1M-token context window and no context management, Kimi K3 achieves a score of 90.4. The results of Claude Fable 5, Claude Opus 4.8, GPT 5.6 Sol, and GPT 5.5 are cited from <https://www.anthropic.com/news/claude-fable-5-mythos-5> and <https://openai.com/index/gpt-5-6/>.

  > **译：** **BrowseComp。** 我们采用 Claude 模型卡中使用的上下文压缩策略，在 300K token 时触发。当使用 100 万 token 上下文窗口且无上下文管理进行评估时，Kimi K3 获得 90.4 分。Claude Fable 5、Claude Opus 4.8、GPT 5.6 Sol 和 GPT 5.5 的结果引用自 <https://www.anthropic.com/news/claude-fable-5-mythos-5> 和 <https://openai.com/index/gpt-5-6/>。

  6. **GDPval-AA, AA-Briefcase, and APEX-Agents** scores are cited from <https://artificialanalysis.ai/>.

  > **译：** **GDPval-AA、AA-Briefcase 和 APEX-Agents** 分数引用自 <https://artificialanalysis.ai/>。

### Multimodal benchmarks

  1. Except for ZeroBench, which follows the official setting and is run five times, all multimodal scores are averaged over three runs. MMMU-Pro is evaluated following the official protocol, preserving the original input order and prepending images to the text input.

  > **译：** 除 ZeroBench 遵循官方设置并运行五次外，所有多模态分数均为三次运行的平均值。MMMU-Pro 按照官方协议评估，保留原始输入顺序并在文本输入前预置图像。

  2. **PerceptionBench.** PerceptionBench (<https://www.kimi.com/blog/perception-bench>) is a benchmark that focuses on atomic visual perception capabilities.

  > **译：** **PerceptionBench。** PerceptionBench（<https://www.kimi.com/blog/perception-bench>）是一个专注于原子级视觉感知能力的基准测试。

## Limitations

  1. **Sensitivity to thinking history.** K3 was trained in the preserved thinking history mode. If the agent harness fails to pass back all the historical thinking content as required, or if an ongoing session with another model is switched over to K3, generation quality may become highly unstable. We recommend using a harness with verified compatibility, such as Kimi Code, and avoiding switching to K3 in the middle of a session.

  > **译：** **对思考历史的敏感性。** K3 在保留思考历史模式下训练。如果 agent 框架未能按要求传回所有历史思考内容，或者在另一个模型的进行中会话切换到 K3，生成质量可能变得高度不稳定。我们建议使用经验证兼容的框架（如 Kimi Code），并避免在会话中途切换到 K3。

  2. **Excessive proactiveness.** K3's training places particular emphasis on long-horizon, challenging tasks. As a result, when it encounters minor issues or ambiguous user intent during task execution, it may make unexpected decisions on the user's behalf. If your application requires the agent to operate within well-defined boundaries and refrain from excessive improvisation, please impose more explicit behavioral constraints on K3 in the system prompt or in `AGENTS.md`.

  > **译：** **过度主动。** K3 的训练特别强调长程、高难度任务。因此，当它在任务执行中遇到小问题或模糊的用户意图时，可能会代替用户做出意外决策。如果你的应用要求 agent 在明确定义的边界内运行并避免过度即兴发挥，请在 system prompt 或 `AGENTS.md` 中对 K3 施加更明确的行为约束。

  3. Despite being a highly competitive model overall, K3 nonetheless exhibits a noticeable gap in user experience compared with Claude Fable 5 and GPT 5.6 Sol.

  > **译：** 尽管总体上是一个极具竞争力的模型，但 K3 在用户体验方面与 Claude Fable 5 和 GPT 5.6 Sol 相比仍有明显差距。
