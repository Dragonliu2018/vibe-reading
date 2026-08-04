---
title: "xLLM Technical Report"
source:
  type: "论文解读"
  project: "JD.com"
  url: "https://arxiv.org/abs/2510.14686"
  pdf: "/vibe-reading/papers/xllm-technical-report.pdf"
date: "2026-08-04T16:00:00+08:00"
category: [AI, Infra, Inference, xLLM, Papers]
tags: ["LLM Inference", "Serving", "PD Disaggregation", "EPD", "KV Cache", "xTensor", "Ascend", "Qwen", "DeepSeek", "JD.com"]
description: "目的：企业级 LLM 推理框架。手段：服务-引擎解耦 + 动态 PD 分离 + EPD 多模态 + xTensor 内存。结论：Qwen/DeepSeek 多模型 SOTA。"
readingTime: "16 min"
aiModel: "Claude Opus 5 (1M context)"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/xllm-technical-report.pdf" target="_blank" rel="noopener">预览</a> · **论文** [xLLM Technical Report](https://arxiv.org/abs/2510.14686) · **作者** Tongxuan Liu, Tao Peng, Peijun Yang, Xiaoyang Zhao, Xiusheng Lu, Weizhe Huang 等 53 人（JD.com / Tsinghua / USTC / BUAA / PKU / TJU）· **发表** arXiv 2510.14686, 2025-10 (v2: 2026-03) · **项目** https://github.com/jd-opensource/xllm · **解读** 2026-08-04

---

## 1. 论文概览

**一句话**：xLLM 是京东开源的企业级 LLM 推理框架——通过"服务-引擎解耦"架构，在服务层解决混合负载调度、动态 PD 分离、多模态推理和容错恢复，在引擎层通过多层流水线、自适应图模式和 xTensor 内存管理榨干硬件算力，在 Qwen 和 DeepSeek 系列模型上实现显著优于 MindIE 和 vLLM-Ascend 的吞吐。

- **任务**：大规模企业级 LLM 推理服务——覆盖在线聊天、客服、推荐、商品理解等多场景，需同时满足 SLO 和高吞吐。
- **核心创新**：(1) 服务-引擎解耦架构——xLLM-Service 负责调度与集群管理，xLLM-Engine 负责计算加速；(2) 动态 PD 分离——基于 SLO 实时调整 Prefill/Decode 实例比例，零等待角色切换；(3) Hybrid EPD 分离——针对多模态请求的 Encode-Prefill-Decode 三阶段分离；(4) xTensor 内存管理——"逻辑连续、物理离散"的 KV Cache 存储。
- **结果**：在 Qwen3 系列上吞吐达 MindIE 的 1.7×、vLLM-Ascend 的 2.2×；在 DeepSeek-R1 上平均吞吐达 MindIE 的 1.7×。已部署于京东京研 AI 聊天、客服助手、营销推荐等核心业务。

**take-home**：推理框架的核心瓶颈不在单一环节，而在"调度-计算-存储"全栈的协同优化——服务层的弹性调度让集群利用率最大化，引擎层的流水线重叠让硬件气泡最小化，两者解耦但协同才能同时满足 SLO 和吞吐。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We introduce xLLM, an intelligent and efficient Large Language Model (LLM) inference framework designed for high-performance, large-scale enterprise-grade serving, with deep optimizations for diverse AI accelerators. Current mainstream inference frameworks face practical challenges. On the one hand, enterprise-grade serving struggles with hybrid and dynamic workloads, strict demand for high availability of services, and distributed storage management. On the other hand, inference execution is bottlenecked by underutilized AI accelerators due to new paradigms of hardwares, model architectures and inference algorithms. To address these challenges, xLLM builds a novel decoupled service-engine architecture. At the service layer, xLLM-Service features an intelligent scheduling module that efficiently processes multimodal requests and co-locates online and offline tasks through unified elastic scheduling to maximize cluster utilization. [...] Extensive evaluations demonstrate that xLLM delivers significantly superior performance and resource efficiency. Under identical TPOT constraints, xLLM achieves throughput up to 1.7× that of MindIE and 2.2× that of vLLM-Ascend with Qwen-series models, while maintaining an average throughput of 1.7× that of MindIE with Deepseek-series models. xLLM framework is publicly available at https://github.com/jd-opensource/xllm and https://github.com/jd-opensource/xllm-service.

> **译：** 我们介绍 xLLM，一个智能高效的 LLM 推理框架，专为高性能、大规模企业级服务设计，对多种 AI 加速器做了深度优化。当前主流推理框架面临实际挑战：一方面，企业级服务在混合和动态工作负载、高可用性严格要求以及分布式存储管理方面困难重重；另一方面，由于硬件、模型架构和推理算法的新范式，推理执行受制于 AI 加速器利用率不足。为解决这些挑战，xLLM 构建了新颖的服务-引擎解耦架构。在服务层，xLLM-Service 具有智能调度模块，高效处理多模态请求，通过统一弹性调度将在线和离线任务共置，最大化集群利用率。该模块还依赖工作负载自适应的动态 Prefill-Decode（PD）分离策略和针对多模态输入的新型 Encode-Prefill-Decode（EPD）分离策略。此外，它采用分布式架构提供全局 KV Cache 管理和强大的容错能力以确保高可用。在引擎层，xLLM-Engine 协同优化系统和算法设计以充分饱和计算资源。广泛评估表明，xLLM 在性能和资源效率上显著优越。在相同 TPOT 约束下，xLLM 在 Qwen 系列模型上吞吐达 MindIE 的 1.7×、vLLM-Ascend 的 2.2×，在 DeepSeek 系列模型上平均吞吐达 MindIE 的 1.7×。

</details>

---

## 2. 研究背景

LLM 推理框架在大规模商业部署中面临两层挑战：

**服务层挑战**：

| 挑战 | 具体问题 | 现有方案局限 |
|---|---|---|
| 混合负载调度 | 在线请求有潮汐特征，离线任务可抢占 | 现有调度系统无法在满足在线 SLO 的同时利用空闲资源 |
| PD 分离静态化 | Prefill/Decode 资源比例固定 | 输入/输出长度波动时，预设比例失配导致利用率低 |
| 多模态调度粗粒度 | 图像编码、Prefill、Decode 混合执行 | 无法按阶段做细粒度资源分配和批处理 |
| 大规模容错 | 节点/实例故障频发 | 现有 checkpoint-recovery 方案延迟过高，推理场景不可用 |

**引擎层挑战**：

| 挑战 | 具体问题 | 现有方案局限 |
|---|---|---|
| CPU-加速器气泡 | CPU 调度时加速器空闲 | 串行"准备-计算"流水线产生大量计算气泡 |
| 计算通信串行 | MoE All-to-All 通信中断计算 | 单流执行无法重叠通信与计算 |
| MoE 负载不均 | 专家路由不均衡，部分设备过载 | 静态专家冗余策略无法适应动态负载 |
| DP 负载不均 | 数据并行组间 KV Cache 差异大 | 简单轮询调度无法适应动态请求长度 |

**现有框架对比**：

| 框架 | 定位 | 局限 |
|---|---|---|
| vLLM | 开源通用推理引擎 | 企业级调度能力弱，Ascend 支持有限 |
| SGLang | 高性能推理引擎 | 缺乏大规模集群调度 |
| TensorRT-LLM | NVIDIA 专用引擎 | 硬件绑定，不支持国产加速器 |
| MindIE | 华为 Ascend 推理引擎 | 调度策略相对静态 |

xLLM 的核心动机：**从"单点优化"转向"全栈协同"**——服务层解决"如何分配资源"，引擎层解决"如何用好资源"，两者解耦但通过标准化接口协同。

---

## 3. 方法详解

xLLM 的方法分两大层：xLLM-Service（服务层）和 xLLM-Engine（引擎层）。

### 3.1 整体架构

![Figure 1：xLLM 整体架构。服务-引擎解耦设计：xLLM-Service 负责全局调度（在线/离线混部、动态 PD 分离、混合 EPD 分离、全局缓存管理、容错恢复），xLLM-Engine 负责计算加速（多层流水线、自适应图模式、xTensor 内存、推测解码、动态 EPLB）。](/vibe-reading/images/articles/xllm-technical-report/fig-01-architecture-overview.png)

xLLM-Service 包含三层：
1. **预处理层**：TTFT 预测器（文本请求）+ EPD Profiler（多模态请求）
2. **调度层**：在线-离线混部策略 + 动态 PD 分离策略 + 混合 EPD 分离策略
3. **资源层**：三个弹性实例池（Prefill Pool / Decode Pool / Encode Pool）

xLLM-Engine 包含两层：
1. **计算系统层**：多层流水线执行 + 自适应图模式 + xTensor 内存管理
2. **算法驱动层**：推测解码 + 动态 EPLB + 分层 DPLB

### 3.2 在线-离线混部调度

在线请求（聊天、代码补全）延迟敏感，离线请求（文档分析、数据标注）无严格 SLO。xLLM 的策略：

- **延迟约束解耦架构**：将集群资源分为延迟宽松池（原 Prefill 实例）和延迟严格池（原 Decode 实例）。离线请求的 Decode 阶段可在任一池执行，实现灵活的负载比例调整。
- **性能瓶颈分析**：基于 Roofline 模型构建推理性能模型，预测 Prefill/Decode 的延迟和利用率，选择合适的离线请求合并到 Decode 批次。
- **高效抢占机制**：在线请求可抢占离线请求——Prefill 用模型执行中断技术，Decode 用性能模型动态选择请求组合。

### 3.3 动态 PD 分离调度

传统 PD 分离的实例比例是静态的，无法适应动态负载。xLLM 的改进：

- **无状态实例**：实例不绑定 Prefill 或 Decode 角色，按请求类型动态切换——实现零等待角色切换（避免重启/重载模型）。
- **SLO 感知角色切换**：当 TTFT 无法满足时触发 D→P 转换；当 TPOT 超阈值或 P 实例空闲时触发 P→D 转换。始终保留至少两个 Decode 实例。
- **两级请求调度**：全局调度器贪心选最轻负载实例 + TTFT 预测验证；本地调度器用 Chunked Prefill + Continuous Batching 组合，优先 Decode 请求。

### 3.4 混合 EPD 分离调度

多模态推理有三个阶段：图像编码（Encode）、Prefill、Decode。现有引擎将 Encode 和 Prefill 合并执行，无法做阶段级优化。xLLM 提出 EPD 三阶段分离：

- **双流并行**：视觉模型和语言模型分到不同执行流——视觉流做图像编码，语言流做 Prefill/Decode，实现异构阶段的并发执行。
- **三种分离策略**：EP-D（编码+Prefill 合并，Decode 分离）、ED-P（编码+Decode 合并，Prefill 分离）、E-P-D（三阶段全分离）。EPD Profiler 用二分搜索找到最优策略。
- **阶段感知批处理**：每个迭代先加 Decode 请求，再加 Chunked Prefill，最后加 Encode——优先完成 Prefill 以降低 TTFT。

### 3.5 多层流水线执行引擎

![Figure 7：多层流水线执行引擎。三层重叠：框架层 CPU 调度与加速器执行重叠（消除气泡）、模型层双流微批次并行（计算与通信重叠）、算子层矩阵与向量单元重叠。](/vibe-reading/images/articles/xllm-technical-report/fig-02-multi-layer-pipeline.png)

三层流水线重叠：

1. **框架层**：CPU 异步调度——当加速器执行当前批次的前向传播时，CPU 并行准备下一批次的元数据。用占位 token 代替尚未计算的输出，实现无缝衔接。
2. **模型层**：双流微批次并行——将宏批次 B 拆为 n 个微批次，计算流执行 Attention/ExpertForward，通信流执行 MoE Dispatch/Combine，两流异步交替。
3. **算子层**：矩阵-向量单元重叠——动态分配 Cube（矩阵）和 Vector（向量）计算单元给并发算子，最小化执行时间差。

### 3.6 自适应图模式

传统 Eager Mode 每次 kernel 启动有 5-50µs 开销；Full Graph Mode 固定 shape 无法适应动态输入。xLLM 的 Adaptive Graph Mode：

- **Partial Graph Mode**：简单动态 shape 模块（FFN、LayerNorm）用图模式编译执行；复杂动态 shape 模块（MHA）用 Eager 模式。根据输入 shape 动态选择。
- **维度参数化**：batch size 和 sequence length 作为图输入参数，运行时动态传入。
- **共享 HBM 内存池**：图初始化时预分配大块 HBM，内部用偏移量管理地址——适应外部地址变化。

### 3.7 xTensor 内存管理

![Figure 9：xTensor 内存管理框架。"逻辑连续、物理离散"的 KV Cache 存储结构。虚拟地址空间预分配 MaxSeqLen，物理页按需映射。](/vibe-reading/images/articles/xllm-technical-report/fig-03-xtensor-memory.png)

传统方案的矛盾：连续分配内存利用率低，PagedAttention 计算效率低。xTensor 的方案：

- **虚拟连续 + 物理离散**：每个请求预分配逻辑连续的虚拟地址空间（范围 = MaxSeqLen），物理页按需映射。算子看到的是连续地址，底层物理页可分散。
- **按需映射**：序列生成新 token 时，调度器从物理页池取出空闲页映射到虚拟地址。短序列只占用少量物理页。
- **低开销分配**：请求完成后物理页标记为 Reusable 而非立即释放，新请求直接重映射虚拟地址；下一 token 的物理页异步预测映射。

| 策略 | 内存利用率 | 计算效率 | 大批次支持 | 算子开发复杂度 |
|---|---|---|---|---|
| 连续分配 | × | ✓ | × | ✓ |
| PagedAttention | ✓ | × | ✓ | × |
| **xTensor** | **✓** | **✓** | **✓** | **✓** |

### 3.8 全局 KV Cache 管理

基于 Mooncake Store 扩展到国产加速器：

- **三级混合存储**：HBM > DRAM > SSD，遵循"HBM 中的数据必在 DRAM 中"的一致性规则。
- **KV Cache 感知调度**：三步决策——(1) 前缀匹配检测计算 KV 重用率；(2) 性能估计预测各节点延迟；(3) 最优节点选择实现动态卸载和迁移。
- **ETCD 元数据管理**：各实例通过心跳上报缓存状态，全局调度器统一管理。

### 3.9 算法优化

- **推测解码**：异步框架——CPU 并行处理上一批输出解码和下一批输入准备；MLA 优化——重构 Q/K 矩阵计算过程，减少 K 矩阵加载次数，Q 矩阵驻留 L1 缓存。
- **动态 EPLB**：基于历史专家负载数据统计，异步更新专家权重路由表。双缓冲机制——新权重预加载到备用内存，地址切换实现无感更新。
- **分层 DPLB**：三层防御——(1) KV Cache 感知请求调度（预防）；(2) DP 组间负载迁移（宏观纠正）；(3) DP 组内 kernel 级优化（微观纠正）。

### 3.10 生成式推荐优化

针对 JD.com 核心业务——单阶段生成式推荐（beam search 解码）：

- **主机侧**：beam search 优化——用 min-heap 做部分排序 + 提前终止机制；资源复用——新候选序列复用旧序列资源空间。
- **设备侧**：有效物品过滤——前向传播中异步生成有效 mask，通过加法操作叠加到 logits，过滤无效 token 组合。
- **结果**：通过主机-设备操作重叠实现 **23% 性能提升**。

---

## 4. 关键公式解读

### 算子层动态资源分配

多层流水线的算子层需要动态分配 Cube（矩阵）和 Vector（向量）计算单元，使所有并发算子的执行时间差最小化：

$$
\arg\min_{x_i, y_j} L_{\text{align}} = \max_{i \in \mathcal{C}, j \in \mathcal{V}} |T_i - T_j|
$$

其中：

$$
T_i = \frac{W_i}{\gamma_{\text{Cube}} \cdot x_i}, \quad T_j = \frac{W_j}{\gamma_{\text{Vector}} \cdot y_j}
$$

约束条件：

$$
\sum_{i \in \mathcal{C}} x_i \leq N_{\text{Cube}}, \quad \sum_{j \in \mathcal{V}} y_j \leq N_{\text{Vector}}
$$

其中 $T$ 为算子执行时间，$W$ 为计算工作量，$\gamma$ 为单单元峰值性能，$N$ 为总可用单元数。**关键洞察**：最小化最大时间差使所有并行 kernel 的完成时间对齐——避免"一个 kernel 等其他 kernel"的资源碎片。

### xTensor 虚拟-物理地址映射

xTensor 的核心是虚拟地址到物理页的映射：

$$
\text{phypageidx} = \left\lfloor \frac{\text{virt\_addr} - \text{virt\_start}}{\text{page\_size}} \right\rfloor
$$

$$
\text{offset} = (\text{virt\_addr} - \text{virt\_start}) \bmod \text{page\_size}
$$

其中 $\text{virt\_addr}$ 为当前虚拟地址，$\text{virt\_start}$ 为起始虚拟地址，$\text{page\_size}$ 为物理页大小。**关键洞察**：这个映射对算子透明——算子只需传入虚拟起始地址和偏移量，系统自动关联物理页。这让 PagedAttention 的 block_table 逻辑不再需要，简化了算子开发。

---

## 5. 实验设置

### 模型与硬件

| 组件 | 配置 |
|---|---|
| 测试模型 | Qwen2/3 系列（0.6B ~ 32B）、DeepSeek-R1、DeepSeek-V3 |
| 硬件平台 | Ascend 910B / 910C |
| 基线框架 | MindIE (v2.1.rc1)、vLLM-Ascend (v0.10.rc1) |
| 数据集 | ShareGPT（基准测试）、Azure Code/Conversation（调度消融）、TextCaps（多模态消融） |
| SLO 约束 | TPOT = 50/80/100ms（不同场景）、E2E = 1s/10s |

### 评估场景

| 场景 | 模型 | 特点 |
|---|---|---|
| 基准吞吐 | Qwen3 系列、DeepSeek-R1 | 固定输入/输出长度，动态调整请求率匹配 TPOT |
| 京研 AI 聊天 | Qwen2/3、DeepSeek-V3 | 对话日志，长输入短输出 |
| 客服助手 | Qwen3-8B/32B | 交互对话，E2E = 10s |
| 商家助手 | Qwen2.5-14B、Qwen3-14B | 搜索词/排列/意图识别，E2E = 1s |
| 商品理解 | Qwen2-7B | 短输入短输出 |
| 生成式推荐 | Qwen-8B | beam search 解码，beam_width = 4~128 |

---

## 6. 实验结果

### Qwen3 系列基准吞吐

![Figure 14：Qwen3 系列吞吐对比。在 TPOT=50ms、输入/输出=2048 tokens 约束下，xLLM 在所有模型规模上均优于 MindIE 和 vLLM-Ascend，且随加速器数量增长保持近线性扩展。](/vibe-reading/images/articles/xllm-technical-report/fig-04-qwen3-throughput.png)

**7B 模型关键数值**：

| 加速器数 | xLLM | MindIE | vLLM-Ascend | xLLM 优势 |
|---|---|---|---|---|
| 1 | ~3500 | ~2200 | ~1800 | 1.6× / 1.9× |
| 2 | ~6000 | ~4000 | ~3000 | 1.5× / 2.0× |
| 4 | ~9500 | ~6000 | ~4500 | 1.6× / 2.1× |

关键发现：

1. **全规模领先**：从 0.6B 到 32B，xLLM 和 xLLM‡（910C）在所有配置下均优于基线。
2. **近线性扩展**：随加速器数量增加，xLLM 保持近线性吞吐增长，而 vLLM-Ascend 存在明显扩展瓶颈。
3. **910C 增益稳定**：xLLM‡ 在 910C 上比 910B 持续提升，验证软件栈对新硬件的适配能力。

### DeepSeek-R1 基准吞吐

![Figure 15：DeepSeek-R1 吞吐对比。在 16×910B / 8×910C 上，xLLM 在四种 TPOT/长度配置下均显著领先 MindIE 和 vLLM-Ascend。](/vibe-reading/images/articles/xllm-technical-report/fig-05-deepseek-throughput.png)

关键发现：

1. **MoE 模型优势更大**：xLLM 在 DeepSeek-R1 上平均吞吐达 MindIE 的 **1.7×**，vLLM-Ascend 的 **12×**（vLLM-Ascend 在 910C 上无法满足 TPOT 阈值而被排除）。
2. **PD 分离增益**：在 PD 分离架构下，xLLM 吞吐 11,352 tokens/s vs MindIE 8,476 tokens/s——**34% 提升**，请求率 5.54 vs 4.14 req/s。

### 业务场景结果

| 场景 | 模型 | xLLM 优势 |
|---|---|---|
| 京研聊天 | DeepSeek-V3 | 吞吐超 vLLM-Ascend **9×**，超 MindIE **36%** |
| 客服助手 | Qwen3-32B (8 卡) | 吞吐超 vLLM-Ascend **3.1×**，超 MindIE **1.2×** |
| 商家助手 | Qwen2.5-14B (4 卡) | 吞吐超 MindIE **34%**，超 vLLM-Ascend **3.4×** |
| 商品理解 | Qwen2-7B | 平均超 MindIE **25%**，超 vLLM-Ascend **56%** |
| 生成式推荐 | Qwen-8B (beam=128) | 延迟比 MindIE 降低 **23%** |

---

## 7. 消融实验

### MTP（多 Token 预测）的影响

在 DeepSeek-R1 上启用 MTP 后，TPOT 随并发数增加保持更低，吞吐在高并发（>32）时优势尤其显著——MTP 有效提升了高并发场景的计算效率和系统吞吐。

### 动态 PD 分离调度

在 Azure Code 数据集（突发流量）上，SLO 感知策略的请求服务率达 Minimal Load 策略的 **1.67×**；在 Azure Conversation（稳定流量）上达 **1.1×**。Minimal Load 比 Round Robin 的 SLO 达标率最多高 4.3%。

### 混合 EPD 分离调度

![Figure 22：混合 EPD 分离策略消融。移除 EPD 分离后 goodput 从 9.5 降至 7.2 req/s；进一步移除阶段级调度后降至 5.1 req/s。](/vibe-reading/images/articles/xllm-technical-report/fig-06-hybrid-epd-ablation.png)

8 个通用推理实例，TextCaps 数据集：

| 配置 | Goodput (req/s) | 变化 |
|---|---|---|
| 完整 EPD + 阶段调度 | 9.5 | 基线 |
| 移除 EPD 分离 | 7.2 | -24% |
| 移除 EPD 分离 + 阶段调度 | 5.1 | -46% |

**关键发现**：EPD 分离策略有效减少阶段间干扰，阶段级调度提供更细粒度的批次执行时间控制——两者共同贡献了 86% 的 goodput 提升。

### 在线-离线混部调度

xLLM-OOC 在自有数据集上吞吐达其他策略的 **3×**；在 Azure Code 上比 online priority 高 75%，比 baseline P/D 高 17%。关键：当离线 QPS 超过阈值时，基线策略的在线 SLO 违规率急剧上升，而 xLLM-OOC 保持稳定。

### 多层流水线执行

| 模型 | 异步调度 | 吞吐 (tokens/s) | 提升 |
|---|---|---|---|
| DS-Distill-Qwen-1.5B | × | 8,710 | — |
| DS-Distill-Qwen-1.5B | ✓ | 10,223 | **+17.4%** |
| DS-Distill-Qwen-7B | × | 3,184 | — |
| DS-Distill-Qwen-7B | ✓ | 3,202 | +0.6% |
| DS-Distill-Qwen-32B | × | 1,415 | — |
| DS-Distill-Qwen-32B | ✓ | 1,509 | +6.6% |

双流架构在 DeepSeek-R1 上：通信时间 12.4ms → 暴露 2.5ms（80% 被重叠），每层净节省 2.8ms，61 层共节省 **172.0ms**。

### 自适应图模式

| 模型 | 图模式 | 吞吐 (tokens/s) | TPOT (ms) |
|---|---|---|---|
| Qwen3-1.7B | × | 2,386 | 39.27 |
| Qwen3-1.7B | ✓ | 3,039 | 30.63 |
| Qwen3-4B | × | 1,540 | 55.44 |
| Qwen3-4B | ✓ | 1,671 | 50.58 |

Qwen3-1.7B 吞吐提升 **27.4%**，TPOT 降低 22.0%——小模型上 kernel 启动开销占比更大，图模式收益更显著。

---

## 8. 总结与展望

### 贡献总结

| 贡献 | 意义 |
|---|---|
| 服务-引擎解耦架构 | 首个将调度与计算分层解耦的企业级推理框架 |
| 动态 PD 分离 + 无状态实例 | 零等待角色切换，SLO 感知实时调整 |
| Hybrid EPD 三阶段分离 | 多模态推理的阶段级资源优化 |
| xTensor 内存管理 | "逻辑连续、物理离散"统一了内存利用率与计算效率 |
| 多层流水线执行 | 三层重叠消除 CPU/通信/算子气泡 |
| 全栈开源 | 已在 GitHub 开源，支持国产加速器 |

### 局限性

- **硬件生态有限**：当前深度优化针对 Ascend 910B/910C，对其他国产加速器的适配仍需扩展。
- **EPD Profiler 开销**：二分搜索寻找最优 EPD 策略需要预 profiling，对短生命周期的模型部署有额外开销。
- **容错恢复未量化**：论文描述了快速恢复架构但未给出具体的恢复时间数据。
- **生成式推荐场景特殊**：23% 提升是针对 JD.com 特定的 beam search 推荐流程，通用性有待验证。
- **Mooncake Store 依赖**：全局 KV Cache 管理基于 Mooncake Store，引入了额外的存储引擎依赖。

### 未来方向

- **弥补缺陷**：扩展硬件抽象层支持更多加速器（边缘侧、云芯片）；降低 EPD Profiler 开销——探索在线自适应策略选择。
- **新型方案**：从推理引擎演进为"AI 操作系统"——支持文本到图像/视频等多场景生成；实现新模型的"零日"集成（从周到小时级）；框架原生 AI 中间件封装分布式推理能力。
- **减少约束**：统一的硬件抽象层降低新硬件集成门槛；自动化编译优化减少手动算子适配。

**与同系列推理框架的关联**：xLLM 与 vLLM、SGLang 代表了推理框架的不同路线——vLLM 以 PagedAttention 为核心创新，SGLang 以 RadixAttention 为核心创新，xLLM 则以"服务-引擎解耦"为核心范式。三者的互补——调度策略、注意力优化、全栈协同——指向了未来更完整的推理基础设施。
