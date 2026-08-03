---
title: "LongCat-2.0 正式发布"
source:
  type: "article"
  project: "LongCat"
  url: "https://longcat.chat/blog/longcat-2.0/"
  author: "LongCat Team"
  site: "longcat.chat"
date: "2026-07-27"
category: [AI, Models, Text Model, Official]
tags: ["LongCat", "MoE", "稀疏注意力", "国产算力", "长上下文", "Agent"]
description: "LongCat-2.0 正式发布：1.6 万亿参数 MoE、480 亿激活、百万上下文，LongCat 稀疏注意力 + N-gram Embedding + 国产算力训练，深度适配 Claude Code 等 Harness。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **原文** [LongCat-2.0 正式发布](https://longcat.chat/blog/longcat-2.0/) · **作者** LongCat Team · **来源** longcat.chat · **原文发布** 2026-06-30 · **转载** 2026-07-27

---

[GitHub](https://github.com/meituan-longcat/LongCat-2.0) [HuggingFace](https://huggingface.co/meituan-longcat/LongCat-2.0) [在线体验](https://longcat.chat) [API 接入](https://longcat.chat/platform/docs/)

我们正式发布并开源 LongCat-2.0，它是一个总参数量达 **1.6 万亿**、每个 token 激活约 480 亿参数的 MoE 语言模型。LongCat-2.0 相比此前的 LongCat 系列引入了多项架构改进，实现了模型能力的显著跃升。

LongCat-2.0 的完整训练流程与大规模部署均全部使用 **国产算力集群**。预训练在 5 万余国产算力芯片上耗时月余完成，消费了超过 35 万亿 tokens，全程无回滚、无不可恢复的 loss 突刺。这一结果验证了我们有能力在国产算力平台上进行前沿级大规模模型训练。

为强化模型在长程任务上的能力，我们引入 LongCat 稀疏注意力机制，并在数千亿 tokens 的 **百万上下文长度** 数据上训练 LongCat-2.0。结合专门的后训练，LongCat-2.0 在编程与智能体任务上表现强劲。

LongCat-2.0 深度适配 Claude Code、OpenClaw、Hermes 等主流 Harness，在代码理解、仓库级修改、自动化任务执行及 Agentic Workflow 等多元场景中表现出色，能够为开发者带来更稳定、更高效的智能协作体验。

---

![LongCat-2.0 架构总览](/vibe-reading/images/articles/longcat-official-2-0-release/fig-0-architecture-chart.png)

## 架构升级

LongCat-2.0 的模型架构设计继承自 [LongCat-Flash](https://arxiv.org/abs/2509.01322)，在参数效率以及长上下文训练与推理速度上更进一步。在注意力机制方面，我们提出 LongCat 稀疏注意力 (LSA)：该机制由 DeepSeek 稀疏注意力 (DSA) 演进而来，通过引入更轻量化的索引器（Indexer），在无损模型质量的前提下显著加速长上下文处理。同时，为了让每个参数发挥更大价值，我们加入 N-gram Embedding 模块，通过 N-gram token 组合将 embedding 空间扩展超过 100 倍，以更充分地建模局部上下文信息，并提升 token 级表示能力。

---

## LongCat 稀疏注意力

智能体应用的兴起对大语言模型的高效长输入处理能力提出了极高要求。尽管 [DSA](https://huggingface.co/deepseek-ai/DeepSeek-V3.2-Exp) 通过细粒度稀疏注意力缓解了这一压力，但我们的性能分析表明，受限于不连续的索引输出形式和二次方的索引评分开销，DSA 中的轻量索引器 (Lightning Indexer) 成为制约端到端延迟的核心瓶颈。为此，LongCat 稀疏注意力（LSA）针对索引器引入了三项相互正交的效率优化策略：

- **流感知索引（Streaming-aware Indexing, SI）**：重塑了索引器选择 Token 的预算分配，将硬件对齐的连续访问与动态随机选择相结合。该策略将部分原本碎片化的显存访问转化为可预知的顺序读取，从而实现合并的 HBM 访问并最大化有效带宽。
- **跨层索引（Cross-Layer Indexing, CLI）**：利用注意力中重要 Token 在相邻层间分布的高度一致性来摊薄索引开销。得益于训练阶段引入的跨层蒸馏，推理时单次索引计算可由多个连续的注意力层复用。
- **层级化索引（Hierarchical Indexing, HI）**：采用由粗到细的两阶段打分机制，先通过 block 级近似打分进行粗召回，再在召回的候选中进行细粒度 token 选择，从而缩小索引器每次检索需处理的候选空间。在 LongCat-2.0 中，层级化索引（HI）以可插拔的组件形式在部分超长上下文任务上按需启用。

这三个组件在设计上相互正交，支持独立开启或关闭。系统的整体架构如以下总览图所示：

![LongCat 稀疏注意力设计总览（为清晰起见省略了 Sink tokens）](/vibe-reading/images/articles/longcat-official-2-0-release/fig-1-lsa-overview.svg)

我们将上述三项策略扩展至用于加速投机解码（Speculative Decoding）的 3-step MTP 模块。跨层索引（CLI）在 Target 模型与 Draft 模型中的应用方式略有不同：在 Target 模型中，每两个连续层共享一次索引结果；而在多步 MTP 中，全部三个 Draft 步的计算共用一次索引——具体而言，Step 2 与 Step 3 完全复用 Step 1 所生成的索引结果。

---

## N-gram Embedding

LongCat-2.0 继承了 [LongCat-Flash-Lite](https://arxiv.org/abs/2601.21204) 的 N-gram Embedding，在同 MoE 正交的稀疏维度上扩展参数，从而提升参数利用效率。为适配 LongCat-2.0 的庞大规模，n-gram size 被设为 5；模型中包含 135B N-gram Embedding 参数，并遵循以下扩展原则：

- **MoE 的稀疏度已越过甜点区。** 即便不考虑 N-gram Embedding，LongCat-2.0 的稀疏度就接近 97%，此时再增加 135B 专家参数所带来的性能收益较少。相比之下，增加同等参数量的 N-gram Embedding 所带来的收益远超标准 MoE。
- **N-gram Embedding 的占比被约束在最优区间。** 实验表明，当 N-gram Embedding 参数在总参中占比过高（超过 50%）时，其相对于扩增专家的优势会消失。在 LongCat-2.0 中，该占比被控制在 10% 以内，处于安全比例内。

这两条原则保证了 N-gram Embedding 相较同等规模的纯 MoE 模型的稳健优势。除此之外，在推理阶段，将参数从专家转移到 N-gram Embedding 可降低大 batch 解码时的显存 I/O，从而加速解码过程。

![N-gram Embedding 总览](/vibe-reading/images/articles/longcat-official-2-0-release/fig-2-ngram-embedding.svg)

---

## 大规模国产算力基建

LongCat-2.0 的训练与部署构建在数万张国产算力芯片组成的大规模集群之上。与成熟的 Nvidia GPU 生态相比，其配套的软件社区仍欠发达。为此，我们投入了大量精力来打造稳定、安全且可扩展的基础设施。

---

## 训练

LongCat-2.0 在超过 5 万片国产算力芯片上完成预训练，模型规模与集群规模均带来显著的系统级挑战。为此，我们进行了一系列系统化优化，相比朴素实现将训练吞吐提升超过 35%，同时进一步增强了可靠性。

### 确定性与可靠性

为保证生产环境的可复现性，我们在通信与计算两条路径上均保证确定性，自研覆盖 Embedding、FA、LSA、MoE 等多个确定性算子和模块。

在数值可靠性方面，我们重写一系列基础算子以提升精度——例如所有规约类算子均采用二叉树分段累加，以减少浮点误差累积。在真实 LLM 负载下，我们以严格的高精度基线为对照验证国产算力芯片的计算精度，确认其数值正确性与生产可用性。同时在部分计算密集型算子上加入比特翻转检测，及时发现硬件比特翻转引发的数值异常。

在故障恢复方面，端到端监控驱动链路故障的识别、切流与恢复，可以做到全程无需人工介入。故障链路隔离对训练无可感知影响，修复后的链路需通过压测方可重新投入使用。

### 大规模训练

国产算力芯片单片显存显著小于 H800 的 80GB，显存成为大规模训练的主要瓶颈。我们从并行策略与显存管理两个维度做针对性优化：

- **6D 并行：** 在常规 TP/CP/EP/DP/PP 之外，额外引入 EMBP 对 N-gram Embedding 做并行加速。
- **超节点：** 训练运行在物理超节点上，每个超节点最多 48 台机器，节点内全互联高带宽、节点间走 RoCE 网络。超节点把高带宽通信域扩展到数百张卡，支撑带宽敏感的并行策略（TP/CP/EP）。相比同规模下，超节点额外带来约 30% 的预训练吞吐提升。逻辑超节点同时是亲和调度的基本单元，在通信局部性与可调度性之间取得平衡。
- **显存优化：** 采用 ZeRO-1、选择性重计算、分配器层的显存超限（OOM）时自动卸载，并将填充词元路由至零计算专家等。
- **Muon 优化器：** 在国产算力芯片上大规模部署 Muon 优化器，围绕 TP 并行、DP 状态去冗余及高效对称矩阵乘核函数等关键路径做专项优化。

### 长上下文训练

我们从三个方面应对大规模长上下文训练的挑战：

- **LSA 算子与前向优化：** 为 LSA 预热和稀疏两阶段训练自研确定性注意力算子及 KL 损失算子。LSA 预热采用 forward-only 训练策略，仅需一次前向即可同时得到 KL 损失与梯度，从而提升训练效率。
- **百万上下文长度扩展：** 采用 all-gather 的上下文并行方式，可将上下文并行扩展至 512 路以上，实现原生百万上下文长度数据的训练。数据在预取阶段重新打散，并采用均衡的序列切分策略以保持负载均衡。
- **计算通信重叠：** 我们精心设计了计算与通信的重叠，例如 ScMoE 结构使 MoE 通信与并行分支计算重叠，同时 LSA 的 top-k 索引计算与 KV all-gather 重叠，降低同步开销。

---

## 推理

在显存容量、显存 I/O 带宽与互联带宽都较为受限的条件下，在万亿参数大模型上跑百万上下文的推理是一项不小的挑战。为此，我们在模型、设备与部署三个层面进行了一系列优化。

### 模型层面优化

- **Attention:** 为了高效应对超长上下文带来的 I/O、计算及显存瓶颈，我们通过三种方式对系统进行了优化。(1) 引入 absorb 计算模式应用于 prefill 和 decode 阶段；(2) 将 indexer 与 MLA prolog 做了并行处理，使 indexer 的一部分开销可以被 MLA 计算所掩盖；(3) 借助 KV-cache 并行 (KVP) 将 KV-cache 切分到多片卡上。
- **ScMoE:** 基于 [LongCat-Flash](https://arxiv.org/abs/2509.01322) 中 dense 与 MoE 分支的计算-通信重叠机制，LongCat-2.0 利用国产计算芯片的控核能力做了进一步的调度优化——通过主动分配 dense 流和 MoE 流的核心数量，使得 dense 与 MoE 的执行可以完全并行，而不局限于计算与通信的并行。

### 面向国产算力芯片的优化

- **Super Kernel:** 开启图模式后，算子之间的空隙得以消除，但每个算子内部的启动开销依然存在。为此，我们引入 super kernel 来减小算子数量，从而降低算子的总启动开销。
- **Weight Prefetch:** Longcat-2.0 使用的国产算力芯片的显存带宽有限，但 L2 cache 相对较大。我们正是利用这块较大的 L2 cache 提前预取权重，将 I/O 延迟隐藏在前一个算子的计算之中。
- **Scale Up 与 Scale Out:** 使用国产算力芯片内置的 200 Gbps 网卡按 layer-wise 方式进行 prefill 与 decode 节点之间的 KV-cache 传输，KV-cache store 则构建在主机的 RDMA 网卡之上，TP/SP/KVP 则均在 scale-up 互联域内完成。

### 部署与服务

- **最优并行：** LongCat-2.0 采用 prefill–decode (PD) 分离式部署来兼顾 TTFT 与 TPOT。
  - **Prefill 节点：** Prefill 节点在处理长序列时主要受限于节点间通信带宽，MoE 的 dispatch/combine 耗时占比很高。为此，我们采用多节点 Chunked Pipeline Parallel (CPP) 来缩小 Expert-Parallel (EP) 域；在每个 pipeline stage 内，再以 Attention Sequence Parallelism (SP) 分担长序列的计算压力。
  - **Decode 节点：** Decode 节点主要受限于显存与 KV-cache I/O。我们以 KVP 切分 KV-cache、降低单片显存占用，并辅以较大的 EP 并行度 (EP128)，同时压低单片的权重显存与 Expert I/O。
  - 在这两个阶段中，上述并行方案 (CPP/SP 与 KVP) 均适配了 constrained decoding、multi-step scheduling、MTP 等推理优化特性，保证了推理性能。
- **Expert-Parallel 负载均衡：** Decode 节点上较大的 EP 并行度更容易引发专家之间的负载不均，我们通过 Expert-Parallel Load Balancing (EPLB) 加以应对，并且将统计采集与分布计算的过程进行了异步化处理。

---

## 多教师在线蒸馏

为了全面提升模型的综合表现与应用边界，我们在后训练架构上引入了高度专业化的专家组机制，将其系统性划分为三大核心阵列：Agent 能力专家组、推理能力专家组以及交互体验专家组。

- **Agent 能力专家组** 致力于在复杂真实场景下深化模型的自主执行能力。该组专家在代码、办公以及检索等细分垂直领域均已达到业界 SOTA 水平。在训练目标上，我们不仅关注端到端的任务成功率，更深度优化了决定系统鲁棒性的关键"原子能力"——例如复杂工具调用的精准度、多轮 API 交互中的参数解析能力，以及有效规避死循环或重复调用的自我纠错机制。
- **推理能力专家组** 的核心愿景是拓展模型的逻辑演进深度，并实现基于问题难度的自适应推理计算。我们的推理专家模型在数学、STEM 学科复杂问题求解，以及多跳知识推理任务上，均稳居行业第一梯队。
- **交互体验专家组** 则聚焦于人机对齐与底层用户感知的优化。交互专家主要负责攻克模型在多变应用场景下的细粒度指令遵循难题，通过先进的对齐技术显著抑制事实性幻觉，并构建了在不牺牲有用性的前提下、边界清晰的安全防御机制。

最后，我们采用 MOPD 架构方案，在数万卡的国产算力集群上将上述三大维度的顶尖能力进行无缝融合，使得最终产出的模型不仅具备了极强的智能体思维能力，更能够精准解构并洞察用户的复杂需求，在各种极具挑战的真实场景中稳定、高效地执行并交付结果。

![基于 MOPD 的多专家后训练架构总览](/vibe-reading/images/articles/longcat-official-2-0-release/fig-3-mopd-architecture.svg)

---

## 模型能力演示

上述架构与基础设施的改进转化为实打实的能力。凭借长上下文推理增强与精细的后训练，LongCat-2.0 在完成真实任务上表现出色。演示覆盖多种场景：

- **软件工程**：代码库迁移、Web 应用开发
- **智能体任务**：数据分析、Agentic 研究、知识库搭建
- **内容生成**：演示文稿生成、创意写作

### 代码库迁移

LongCat-2.0 同时读取你的完整代码库与迁移文档，梳理出整体架构，并将整个插件重写到新的 SDK——既保留全部既有功能，又能发现潜藏的 bug，且首次构建即编译通过。

> 演示视频：[代码库迁移](https://s3.meituan.net/static-prod01/com.sankuai.friday.longcat.next2/assets/codebase-migration-DoQu36uY.mp4)

---

## 评测

我们在代码、通用 Agent 与基础能力等维度上，将 LongCat-2.0 与领先的闭源模型进行对比。除标注 \* 者外，所有分数均在统一的评测框架下由内部测得。

|  | LongCat-2.0 | Gemini 3.1 Pro | GPT-5.5 | Claude Opus 4.6 | Claude Opus 4.7 | Claude Opus 4.8 |
| --- | --- | --- | --- | --- | --- | --- |
| **Code Agent** |
| Terminal-Bench 2.1 | 70.8 | 70.7\* | 73.8\* | - | 71.7\* | 78.9\* |
| SWE-bench Pro | 59.5 | 54.2\* | 58.6\* | 57.3\* | 64.3\* | 69.2\* |
| SWE-bench Multilingual | 77.3 | 76.9\* | - | 77.8\* | 80.5\* | 84.8\* |
| **General Agent** |
| FORTE † | 73.2 | 70.3 | 77.8 | 73.2 | 77.6 | 77.2 |
| BrowseComp | 79.9 | 85.9\* | 84.4\* | 84.0\* | 79.3\* | 84.3\* |
| RWSearch | 78.8 | 76.3 | 85.3 | 81.3 | 79.3 | 77.3 |
| **Foundational** |
| IFEval | 90.0 | 96.1 | 95.0 | 92.2 | 88.7 | 86.0 |
| Writing Bench | 83.8 | 83.7 | 84.7 | - | 85.3 | 85.2 |
| IMO-AnswerBench | 81.8 | 90.0 | 79.5 | 75.3\* | 81.8 | 75.3 |
| GPQA-diamond | 88.9 | 94.3\* | 93.6\* | 91.3\* | 94.2\* | 92.4 |

标注 \* 的数值为外部（公开报告）指标，其余均为内部测得。"-" 表示暂无结果。分数已归一化到 0–100 区间。

- Terminal-Bench 2.1：通过 Claude Code 评测；沙盒单实例资源 8c16g；推理参数 temperature=1.0、top_k=-1、top_p=0.95；agent 超时 6 小时。
- SWE-Bench Series：通过 Claude Code 评测；沙盒单实例资源 4c8g；推理参数 temperature=1.0、top_k=-1、top_p=1；已修正有问题的任务。
- [FORTE](https://github.com/AGI-Eval-Official/FORTE)：FORTE（Full-cycle Office Real-world Task Evaluation）是面向 15 类企业职业、评估 AI Agent 日常办公生产力的通用 Agent 评测集，支持 OpenClaw / Hermes / Claude Code 等框架。所有任务限时 45 分钟；单实例 2 CPU / 4GB 内存；单轮 API 调用超时 500s，最多重试 10 次。标注为 †。
- [RW-Search](https://github.com/AGI-Eval-Official/RW-Search)：自建的搜索智能体客观评测基准。RW-Search 采用裸模型评测（配置基础的 Search 与 Browse 工具），不使用上下文管理策略。
- Foundational：数学推理类（如 IMO-AnswerBench）推理参数 temperature=1.0、top_k=-1、top_p=0.95；其余为 temperature=0.7、top_k=-1、top_p=0.95。
