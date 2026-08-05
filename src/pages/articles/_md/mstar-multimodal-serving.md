---
title: "M*: A Modular, Extensible, Serving System for Multimodal Models"
source:
  type: "论文解读"
  project: "Stanford & UW"
  url: "https://arxiv.org/abs/2606.12688"
  pdf: "/vibe-reading/papers/mstar-multimodal-serving.pdf"
date: "2026-08-05T20:00:00+08:00"
category: [AI, Infra, Inference, Papers]
tags: ["M*", "多模态模型", "模型服务", "Walk Graph", "vLLM", "SGLang", "数据流图", "分布式推理"]
description: "将多模态复合模型统一抽象为数据流图上的 Walk，用四种组合原语解耦模型架构与运行时，在 BAGEL、Qwen3-Omni、V-JEPA 2 等模型上实现 day-zero 部署并超越专用系统。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/mstar-multimodal-serving.pdf" target="_blank" rel="noopener">预览</a> · **论文** [M*: A Modular, Extensible, Serving System for Multimodal Models](https://arxiv.org/abs/2606.12688) · **作者** Atindra Jha, Naomi Sagan, Keisuke Kamahori, Irmak Sivgin 等（Stanford University & University of Washington）· **发表** arXiv, 2026-06 · **项目** [github.com/mstar-project/mstar](https://github.com/mstar-project/mstar) · **解读** 2026-08-05

---

## 1. 论文概览

多模态 AI 模型正在从"语言模型 + 视觉编码器"的简单拼接，走向**复合架构**（composite architecture）：视觉编码器、语言骨干、扩散头、音频编解码器、动作生成器、世界模型预测器等异构组件，以循环、并行、流水线等复杂模式组合在一起。现有推理服务框架（vLLM、SGLang）基于"单一自回归循环"的假设设计，无法干净地表达这些复杂执行结构。

M* 的核心洞察是：**尽管模型架构千差万别，每个多模态模型都是一个异构组件的有向计算图，每个用户请求是对图中组件的一次遍历（Walk）**。基于这一洞察，M* 设计了 **Walk Graph** 抽象——用四种可组合原语（Sequential / Parallel / Loop / DynamicLoop）和流式边，将模型架构与系统运行时彻底解耦，使开发者只需声明图结构和遍历路径，运行时自动处理调度、批处理、张量传输和优化。

在五个代表性模型上的实验表明，M* 实现了 day-zero 部署，且性能达到或超过专用系统：BAGEL 文生图延迟降低 ~20%，Qwen3-Omni 语音吞吐提升 2.7×，V-JEPA 2 机器人规划加速 12.5×。

**take-home**：多模态推理不再是一个自回归循环，而是一次图遍历；把模型声明为图、把请求声明为 Walk，系统就能自动发现并利用并行、流水线和批处理机会。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We are entering a new era of composite model architectures that integrate diverse components such as vision encoders, language backbones, diffusion and flow heads, audio codecs, action generators, and world-model predictors. Such architectures underpin a broad class of multimodal models, including unified multimodal models, omni models, speech-language models, vision-language-action policies, and world models. However, existing model serving frameworks were built on narrow assumptions about model structure, making them ill-suited to accommodate this new architectural diversity. Here we present M*, a universal serving system for efficient serving of composite AI models. M* represents models as dataflow graphs, processing requests spanning diverse modalities and tasks as traversals over these graphs. The core insight is a modular abstraction that supports arbitrary composition of model components, flexible placement onto a physical cluster, and model-agnostic optimizations within a distributed runtime. We call this abstraction the Walk Graph and show how it can concisely capture composite models from a broad range of families. We instantiate M* on representative models and find that it achieves, on average, 20% lower end-to-end latency than vLLM-Omni for text-to-image workloads on BAGEL, while delivering up to 2.9× lower real-time factor and 2.7× higher throughput for text-to-speech workloads on Qwen3-Omni. M* also outperforms the V-JEPA 2-AC rollout baseline for robotic planning by up to 12.5×.

> **译：** 我们正在进入复合模型架构的新时代——视觉编码器、语言骨干、扩散/流匹配头、音频编解码器、动作生成器和世界模型预测器等异构组件被集成在一起。这类架构支撑着一大类多模态模型，包括统一多模态模型、Omni 模型、语音语言模型、视觉-语言-动作策略和世界模型。然而，现有模型服务框架基于对模型结构的狭窄假设构建，难以适应这种新的架构多样性。我们提出 M*，一个面向复合 AI 模型高效服务的通用推理系统。M* 将模型表示为数据流图，将跨越不同模态和任务的请求处理为对这些图的遍历。核心洞察是一个模块化抽象——Walk Graph，支持组件的任意组合、到物理集群的灵活放置，以及分布式运行时中的模型无关优化。我们在代表性模型上实例化 M*，发现它在 BAGEL 文生图上比 vLLM-Omni 平均降低 20% 端到端延迟，在 Qwen3-Omni 语音合成上实现最高 2.9× 更低 RTF 和 2.7× 更高吞吐，在 V-JEPA 2 机器人规划上比基线加速 12.5×。

</details>

## 2. 研究背景

### 复合多模态模型的五大族系

论文识别了五类代表性的复合模型架构，它们的共同特点是：**推理不再归结为单一自回归循环**。

| 模型族系 | 代表模型 | 结构特点 | 复杂执行模式 |
| --- | --- | --- | --- |
| 统一多模态模型（UMM） | BAGEL | 共享 MoT 骨干 + 文本/视觉编解码器 | 不同任务走不同组件路径 |
| 语音语言模型（SpeechLM） | Orpheus, CosyVoice | AR Transformer + 神经音频编解码器 | 流式输出需实时 |
| Omni 模型 | Qwen3-Omni | Thinker + Talker 双 Transformer + 音频解码器 | 流水线并行 + 隐藏状态流式传输 |
| 视觉-语言-动作模型（VLA） | π0.5 | 文本编码器 + ViT + Transformer + 动作解码器 | 多组件顺序执行 |
| 世界模型 | V-JEPA 2 | 视频编码器 + 迭代潜在预测器 | 变长度非 AR 循环 |

![Figure 1: BAGEL 与 Qwen3-Omni 的模型架构，展示复合模型的计算图结构](/vibe-reading/images/articles/mstar-multimodal-serving/fig-1-model-architectures.png)

### 现有系统的三大不足

论文将复合模型对服务系统的挑战总结为三点：

* **（C1）架构多样性**：不同模态和任务触发同一模型内不同的执行路径。例如 BAGEL 的文生图、图生文、图编辑分别使用不同的编码器/解码器组合，还涉及非 AR 循环（如扩散迭代）。vLLM-Omni 和 SGLang-Omni 的固定 DAG 阶段抽象无法表达循环、阶段内并行和跨路径共享。
* **（C2）高性能模块化**：HuggingFace Transformers 提供灵活性但牺牲效率；vLLM 等专用系统高效但不跨模态泛化。现有系统无法同时兼顾两者。
* **（C3）物理拓扑**：异构组件可能顺序、流水线或并行执行，张量可能跨节点（InfiniBand）或节点内（NVLink）传输。系统需要灵活的组件放置和数据传输策略。

**关键人物**：论文由 Stanford（Mark Horowitz、Jure Leskovec、Baris Kasikci）和 UW（Luke Zettlemoyer、Stephanie Wang）联合完成。Stephanie Wang 也是 FlashInfer 的作者之一，Baris Kasikci 是 VoxServe 的共同作者——这些系统是 M* 的直接对比基线。

## 3. 方法详解

### Walk Graph：一个抽象，四种原语

M* 的核心是 **Walk Graph**——一个模型计算图 $G = (N, E)$ 加上一组命名遍历 $W = \{w_1, \ldots, w_n\}$。每个 Walk 是 $G$ 的一个标记子图，对应模型行为的一个阶段（如 `prefill_text`、`decode`、`image_gen`）。每个请求是一系列 Walk 的序列。

![Figure 2: M* 系统总览。左：模型作者定义计算图和 Walk；右：运行时将组件子图放置到不同 GPU Worker](/vibe-reading/images/articles/mstar-multimodal-serving/fig-2-mstar-overview.png)

图的构建块是两种原子类型——**GraphNode**（计算单元，输入到达即触发）和 **GraphEdge**（节点间流动的张量）——以及四种组合原语：

| 原语 | 语义 | 典型用途 |
| --- | --- | --- |
| **Sequential** | 链式：一节的输出馈入下一节 | 编码器 → 骨干 → 解码器 |
| **Parallel** | 扇出：子图可并发执行 | BAGEL 的 CFG 三分支并行 |
| **Loop** | 有界迭代，每轮输出独立或累积 | 扩散去噪 49 步 |
| **DynamicLoop** | 带每请求提前退出的循环 | AR 解码直到 EOS、世界模型变长 rollout |

此外，**StreamingGraphEdge** 支持流式输出：生产者逐个发射张量，消费者按 **ChunkPolicy**（固定块 / 滑动窗口 / 左上下文）累积到足够量后触发。三种策略覆盖了论文评估的所有流式连接。

### Walk Graph 解锁的能力

**模态感知调度**：调度器只需跟踪每个请求的类型和当前执行的 GraphNode + Walk，用模型作者提供的状态机选择下一个 Walk。系统**只执行完成请求所需的最小组件集**，而非强制所有请求执行所有组件。

**灵活并行**：作者用 `Parallel` 原语直接在图中表达并行（如 BAGEL 的 CFG 三分支），运行时统一支持。相比之下，vLLM-Omni 需要专门的 CFG 插件和 glue code。张量并行（TP）也在节点级声明，系统自动处理不同 TP world size 间的同步和 KV-cache 传输。

**灵活放置**：部署者声明 GraphNode → GPU rank 的映射，无需修改模型或运行时代码。同一逻辑节点在不同 Walk 中可放置在不同 GPU 上，表达预填充-解码分离、编码器独立扩展等模式。当多个 Walk 的同一节点映射到相同 GPU 时，系统自动复用同一物理副本。

**循环优化**：`Loop` / `DynamicLoop` 将循环提升为图级一等公民，使 CUDA graph 捕获和连续批处理对循环不可知。调度器可以像调度普通组件一样调度循环迭代——例如在 BAGEL 中交替调度流匹配步骤和自回归解码步骤。

### 运行时架构

运行时由三部分组成：

* **HTTP 服务器**：接收请求
* **Conductor**（每服务器一个）：维护每请求的 Walk 状态，通过 ZeroMQ 将工作分发给 Worker
* **Worker**（每 GPU rank 一个单进程）：执行本地子图，通过共享内存 / RDMA / TCP（Mooncake）直接路由张量到下游 Worker

每个 GraphNode 由一个**引擎**执行。目前有两种引擎：

| 引擎 | 适用场景 | 特性 |
| --- | --- | --- |
| `KVCacheEngine` | 有状态 Transformer | FlashInfer 分页注意力 KV-cache + CUDA graph 兼容采样 |
| `StatelessEngine` | 无状态节点 | 更简单的执行路径 |

两种引擎均支持连续批处理、CUDA graph replay 和 `torch.compile`。Worker 异步调度：在批次 N 执行时，同时调度批次 N+1——遍历 Walk Graph 确定下一批就绪的节点，或调度无关的已就绪批次以避免队头阻塞。

### 代码示例：BAGEL 图像生成 Walk

```python title="BAGEL image_gen Walk（简化版，无 CFG）"
image_gen = Sequential([
    Loop(
        section=GraphNode(name="LLM",
            input_ids={"latents", "time_index"},
            outputs=[
                GraphEdge(next_node="LLM", name="latents"),
                GraphEdge(next_node="LLM", name="time_index")
            ]),
        n_iters=49,
        outputs=[GraphEdge(next_node="vae_decoder", name="latents")]
    ),
    GraphNode(name="vae_decoder",
        input_ids={"latents"},
        outputs=[GraphEdge(next_node=EMIT_TO_CLIENT, name="image_output")])
])
```

49 次迭代的 `Loop` 内含一个 `GraphNode`（LLM 骨干），每轮将 latents 和 time_index 回环。循环结束后，最终 latents 流入 `vae_decoder` 解码并输出图像。带 CFG 的完整版本用 `Parallel` 包裹三个 LLM 分支，`combine_cfg` 节点应用 CFG 公式和 Euler 步后回环。

## 4. 关键公式解读

M* 的理论核心不是数学公式，而是图论抽象。但有一个关键的等价关系值得形式化：

$$
\text{Model} \equiv (G, W), \quad G = (N, E), \quad W = \{w_1, \ldots, w_n\}
$$

$$
\underbrace{w_i}_{\text{一个 Walk}} \subseteq G, \quad \text{Request} = [w_{i_1} \to w_{i_2} \to \cdots \to w_{i_k}]
$$

其中 $G$ 是有向计算图（节点 $N$ 为异构组件，边 $E$ 为张量流），$W$ 是有限命名 Walk 集合，每个 $w_i$ 是 $G$ 的标记子图。一个请求是一个 Walk 序列，由模型作者提供的状态机根据请求模态和前一个 Walk 的输出来选择下一个 Walk。

这个抽象的关键性质是**封闭性**：四种原语（Sequential、Parallel、Loop、DynamicLoop）的任意嵌套组合仍然产生合法的 Section（子图），因此可以递归构建任意复杂的模型架构。现有的 stage-DAG 抽象（vLLM-Omni、SGLang-Omni）是 Walk Graph 的一个受限子集——它们对应于无环、扁平、无循环的 Walk。

## 5. 实验设置

### 模型与基线

| 模型 | 规模 | 任务 | 基线 |
| --- | --- | --- | --- |
| BAGEL | 7B | 文生图（T2I）、图编辑（I2I）、图生文（I2T） | vLLM-Omni（两种配置） |
| Qwen3-Omni | 30B-A3B | 文本转语音（TTS） | vLLM-Omni、SGLang-Omni |
| Orpheus | 3B | TTS | VoxServe（语音专用系统） |
| V-JEPA 2 | ViT-g AC | 机器人规划 rollout | Meta 原生实现 |

### 硬件与数据

* **硬件**：4×H100 单节点 或 8×H200 单节点
* **数据集**：VBench（图像生成）、Food101（图像理解）、Seed-TTS（语音）、DROID 前 50 个 episode（机器人）
* **指标**：TTFT（首 token 延迟）、吞吐量（req/s 或 token/s）、端到端延迟、RTF（实时因子，<1 表示流式可行）

### 复现信息

代码开源于 [github.com/mstar-project/mstar](https://github.com/mstar-project/mstar)，模型检查点使用 HuggingFace 上的官方发布版本。

## 6. 实验结果

### BAGEL：一套配置覆盖三种工作负载

![Figure 3: BAGEL T2I/I2I 端到端延迟对比（3-GPU CFG 并行，B=1）](/vibe-reading/images/articles/mstar-multimodal-serving/fig-3-bagel-t2i-i2i-latency.png)

在 3-GPU CFG 并行配置下，M* 相比 vLLM-Omni 单阶段配置，T2I 延迟降低 1.25×，I2I 降低 1.22×；相比默认配置（Thinker + DiT 分离阶段），I2I 优势扩大到 2.64×——因为默认配置需要昂贵的 KV-cache 跨阶段传输。

![Figure 4: BAGEL I2T 吞吐量与延迟（单 H100，输出 64-256 token）](/vibe-reading/images/articles/mstar-multimodal-serving/fig-4-bagel-i2t-throughput.png)

图像理解方面，M* 在 B=16 时吞吐量提升 32.7%，TTFT 降低 14%-33%。关键发现是：**vLLM-Omni 的两种配置各有短板**——默认配置 I2I 差（KV-cache 传输开销），单阶段配置 I2T 差（失去连续批处理和 token 流式）。M* 用**同一套配置**同时优化了三种工作负载。

### Qwen3-Omni：语音吞吐提升 2.7×

![Figure 5: Qwen3-Omni TTS 性能对比（2-GPU）](/vibe-reading/images/articles/mstar-multimodal-serving/fig-5-qwen3-omni-tts.png)

在 B=16 时，M* 相比 vLLM-Omni 吞吐提升 2.7×，相比 SGLang-Omni 提升 4.0×。RTF（实时因子）降低 2.9×。性能提升主要来自：

* CUDA graph 按子模块级别捕获，整个 Talker（含多 token 预测器循环）作为一个 CUDA graph 运行——而 vLLM-Omni 显式禁用了 Code Predictor 的 CUDA graph
* Talker 和 Code2Wav 共置在同一 Worker 进程，消除了进程间通信——而 vLLM-Omni 和 SGLang-Omni 每个阶段是独立进程

### V-JEPA 2：机器人规划加速 12.5×

![Figure 8: V-JEPA 2 AC rollout 延迟对比（单 H100，B=1）](/vibe-reading/images/articles/mstar-multimodal-serving/fig-8-vjepa2-rollout.png)

M* 将 rollout 编码为 `DynamicLoop`，应用分页注意力 KV-cache 避免重复预填充。Meta 原生实现用手写 Python 循环，每次迭代都对增长序列做完整 prefill。随 rollout 长度 H 增加，加速比从 2.08×（H=4）增长到 12.5×（H=30）。

### 结果汇总

| 模型 | 任务 | M* vs 基线 | 关键加速因素 |
| --- | --- | --- | --- |
| BAGEL | T2I 延迟 | ↓20%（1.25×） | 分页 KV-cache 管理 CFG 上下文 |
| BAGEL | I2I 延迟 | ↓2.64× | 消除跨阶段 KV-cache 传输 |
| BAGEL | I2T 吞吐 | ↑32.7%（B=16） | 统一配置优化所有工作负载 |
| Qwen3-Omni | TTS 吞吐 | ↑2.7× vs vLLM-Omni | 子模块级 CUDA graph + 共置 |
| Qwen3-Omni | RTF | ↓2.9× | 同上 |
| Orpheus | TTS RTF | ↓13.6% vs VoxServe | 继承模型级优化 + 推测性 FlashInfer 规划 |
| V-JEPA 2 | Rollout 延迟 | ↓12.5×（H=30） | DynamicLoop + KV-cache 避免重复 prefill |

## 7. 消融实验

### Walk Graph vs 现有抽象的九轴对比

论文附录给出了 Walk Graph 与 vLLM-Omni、SGLang-Omni、VoxServe 在九个维度上的详细对比：

| 维度 | vLLM-Omni / SGLang-Omni | M* |
| --- | --- | --- |
| 图粒度 | Stage = 引擎实例 / Worker 池 | **Node = 一次前向传播** |
| 每模型 Walk | 冻结的一条管线 | **一等公民（BAGEL 6 个 Walk 共享同一节点集）** |
| 跨 Walk 节点共享 | 不支持 | **支持（LLM 节点出现在所有 BAGEL Walk 中）** |
| 循环作为图结构 | 隐藏在引擎内部 | **图级 Loop / DynamicLoop** |
| CUDA graph + 循环 | 不兼容（`enforce_eager: true`） | **兼容（每轮前向形状静态）** |
| 流式策略 | 单一 `async_chunk` 开关 / 每模型定制 | **三种可复用 ChunkPolicy 覆盖所有场景** |
| 放置粒度 | 每阶段 | **每（节点, Walk）** |

### KV-cache 管理对 BAGEL 的影响

M* 将 BAGEL 的三个 CFG 上下文表示为**单一分页 KV 池上的三个标签**，而非 vLLM-Omni 的每上下文独立 NaiveCache。这意味着分页注意力可以直接读取页表，而 vLLM-Omni 需要在每层每步拼接 key/value 张量。标签是一个通用 cache-key 轴，继承了分页、卸载、引用传递和连续批处理——而 NaiveCache 是模型特定的，无法直接获得这些优化。

### 推测性调度的取舍

对于 DynamicLoop，M* 将终止检查推迟到下一轮迭代，因此每次终止最多浪费一步。对于浪费不可接受的模型，可以在节点级禁用推测性调度。

## 8. 总结与展望

### 贡献总结

M* 的贡献是**抽象层面**的：它不是又一个推理引擎，而是一个让任意复合模型都能被高效服务的**统一框架**。Walk Graph 用极少的原语（两种原子类型 + 四种组合原语 + 流式边）覆盖了五大类多模态模型的全部执行模式，同时通过将循环和并行提升为图级一等公民，使 CUDA graph、连续批处理、分页注意力等优化自动适用于所有模型族。

### 局限性

* **分布式并行策略有限**：当前仅支持张量并行（TP），未支持 DiT 的序列并行（如 xDiT、PipeFusion）和流水线并行。论文承认这是未来工作。
* **调度策略简单**：Worker 使用轮询调度，未实现跨模态的智能批处理或优先级调度。
* **评估范围**：虽然覆盖了五类模型，但每类只测了一个模型。在更多模型上的泛化性有待验证。
* **运维复杂度**：作为分布式系统，M* 比单机数据库有更高的运维门槛——论文建议可使用 SelectDB 托管版缓解。

### 未来方向

用论文末尾的 idea 三法展开：

1. **弥补缺陷**：将序列并行（SP）和流水线并行（PP）纳入 Walk Graph 的放置策略，使 DiT 等大模型推理也能受益。集成 FastVideo 的稀疏注意力和 Inferix 的块扩散解码。
2. **新型方案**：探索跨模态的联合批处理——当语音和图像请求共享同一 LLM 节点时，能否在一次 batch 中混合处理？自动放置搜索（给定集群拓扑和负载特征，自动优化 GraphNode → GPU 映射）也是自然延伸。
3. **减少约束**：将 Walk Graph 抽象推广到训练场景——复合模型的训练同样涉及多组件图遍历，M* 的抽象可能降低训练框架的开发成本。探索与编译器（如 TorchDynamo）的集成，将 Walk Graph 编译为更底层的执行计划。
