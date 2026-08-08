---
title: "Patterns behind Chaos: Forecasting Data Movement for Efficient Large-Scale MoE LLM Inference"
source:
  type: "论文解读"
  project: "UCSD"
  url: "https://arxiv.org/abs/2510.05497"
  pdf: "/vibe-reading/papers/moe-data-movement-forecasting.pdf"
date: "2026-08-08T17:00:00+08:00"
category: [AI, Infra, Inference, Papers]
tags: ["MoE", "Data Movement", "Wafer-Scale GPU", "Profiling", "LLM Serving"]
description: "大规模 MoE LLM 的随机专家选择带来主导性的数据移动开销；对 4 个 200B-1000B SOTA 模型做数据移动中心 profiling，提炼 6 条系统无关 insight，在晶圆级 GPU 上 6.6×、在现有 8×H100 上 1.25× 加速。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/moe-data-movement-forecasting.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Patterns behind Chaos: Forecasting Data Movement for Efficient Large-Scale MoE LLM Inference](https://arxiv.org/abs/2510.05497) · **作者** Zhongkai Yu, Yue Guan, Zihao Yu, Chenyang Zhou, Zhengding Hu, Shuyi Pei, Yangwook Kang, Yufei Ding, Po-An Tsai · **发表** ISCA 2026 / arXiv, 2025-10 · **项目** [MoE expert selection trace (HuggingFace)](https://huggingface.co/datasets/core12345/MoE_expert_selection_trace) · **解读** 2026-08-08

---

## 1. 论文概览

**TL;DR**：2025 年的大规模 MoE LLM（200B-1000B、100+ 专家）已成本前沿开权重的标配，但其**随机专家选择**带来巨大数据移动开销——在多卡 serving 系统里已成主导瓶颈（DeepSeek V3 上占 60%-90% 延迟）。更糟的是，此前**无人系统刻画过这一规模的规律**：旧研究只看一两个小模型、停留在表面观察。本文对 2025 年四个 SOTA MoE 模型（DeepSeek V3 671B、Llama4-Maverick 402B、Qwen3-235B、Kimi K2 1000B）做**数据移动中心 profiling**，跨 24,000+ 请求、>2000 GPU 小时、>150 GB JSON trace，从时序与空间双视角提炼**六条系统无关 insight**。在**未来晶圆级 GPU** 上，基于这些 insight 的轻量架构改动带来 **6.6× 平均吞吐加速**；在**现有 8×H100** 上，prefill-aware 专家放置算法带来 **up to 1.25× MoE 计算加速**。

**一句话 take-home**：MoE 的"随机"专家选择背后有强可预测性——跨层/跨 token/跨 prefill-decode 都有相关，专家激活严重倾斜且受任务类型驱动；把这套规律喂给硬件（两级 command processor + 硬件管理 HBM）或软件（prefill 预测 decode 放置），就能把混沌变成秩序。

**元信息**：作者来自 UCSD、Indiana University、Columbia、Samsung Semiconductor、NVIDIA（Po-An Tsai）；ISCA 2026 录用；17 页；开源 70,000+ 专家选择 trace（>150 GB）+ 多 chiplet 模拟器。这是**首个对 200B-1000B MoE 做数据移动中心系统分析**的工作，且给出了落地设计案例。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Large-scale Mixture of Experts (MoE) Large Language Models (LLMs) have recently become the frontier open-weight models, achieving remarkable model capability similar to proprietary ones. But their random expert selection mechanism introduces significant data movement overhead that becomes the dominant bottleneck in multi-unit LLM serving systems. To understand the patterns underlying this data movement, we conduct comprehensive data-movement-centric profiling across four state-of-the-art large-scale MoE models released in 2025 (200B-1000B) using over 24,000 requests spanning diverse workloads. We perform systematic analysis from both temporal and spatial perspectives and distill six key insights to guide the design of diverse serving systems. We verify these insights on both future wafer-scale GPU architectures and existing GPU systems. On wafer-scale GPUs, lightweight architectural modifications guided by our insights yield a 6.6× average speedup across four 200B–1000B models. On existing GPU systems, our insights drive the design of a prefill-aware expert placement algorithm that achieves up to 1.25× speedup on MoE computation. Our work presents the first comprehensive data-centric analysis of large-scale MoE models together with a concrete design study applying the learned lessons.

> **译：** 大规模 MoE LLM 已成为前沿开权重模型，能力媲美专有模型。但其随机专家选择机制带来显著数据移动开销，在多单元 serving 系统中成为主导瓶颈。为理解数据移动背后的规律，我们对 2025 年发布的四个 SOTA 大规模 MoE 模型（200B-1000B）做以数据移动为中心的全面 profiling，用 24,000+ 跨多负载的请求。我们从时序与空间双视角做系统分析，提炼六条关键 insight 指导多样 serving 系统设计。我们在未来晶圆级 GPU 架构与现有 GPU 系统上验证这些 insight。在晶圆级 GPU 上，由 insight 引导的轻量架构改动在四个 200B-1000B 模型上取得 6.6× 平均加速。在现有 GPU 系统上，我们的 insight 驱动一个 prefill-aware 专家放置算法设计，在 MoE 计算上取得 up to 1.25× 加速。我们的工作首次对大规模 MoE 模型做全面数据中心分析，并给出应用所得经验的落地设计研究。

</details>

---

## 2. 研究背景：MoE 数据移动为何是瓶颈

### MoE 随机选专家带来数据移动税

与稠密 LLM 激活全部权重不同，MoE 把每个 token 动态路由到一小部分专家，引入巨大**数据移动开销**。这个开销在 Mixtral 8x7B 这种"小"模型、2-4 卡的系统上就**已超执行时间 50%**；到了 DeepSeek V3（32× 专家、15× 参数、32+ 卡多节点）只会更严重。而且趋势在加速——DeepSeek V4、GLM-5 继续推高规模，数据移动规律愈发关键却无人系统刻画。

![图1 DeepSeek V3 不同 serving 配置下的延迟分解：MoE 相关数据移动（All-to-All + Weight）在 4K 序列下占 60%-90% 总延迟](/vibe-reading/images/articles/moe-data-movement-forecasting/fig-01-latency-breakdown.png)

上图把 DeepSeek V3 在三种配置（SGLang 16×H20、SGLang 72×H100、Default 256×H800）下的延迟分解：**MoE All-to-All + MoE Weight 两项就占 60%-90%**，远超注意力相关的 KV Cache / All-Reduce / Weight。这从动机上说明了：优化 MoE 数据移动是当前大规模 serving 的头号杠杆。

### 若"真随机"会怎样

如果专家选择真完全随机，多卡部署会面临两个灾难：**时序上**无法 prefetch/cache/replicate 专家（DeepSeek V3 有 $C_{256}^8 \approx 4.4\times10^9$ 种组合），host-offload 系统专家在 GPU-host 间反复迁移；**空间上**各卡负载严重不均，多数卡空等重载卡。幸好——这正是本文的起点——MoE 专家选择**确实有可预测的规律**。

### 与既有工作的区分

既有 MoE serving 研究（MoE-Lightning、CoServe、Comet、MegaScale-Infer、Duplex）用**系统中心**方法论：聚焦某一平台（CPU-GPU、多 GPU、PIM），提出部署特定的优化，难以跨平台泛化。本文**翻转视角**：用**模型中心**策略做系统无关 profiling，提炼系统无关的 insight——它们适用于多 GPU 集群、CXL/CPU 内存解耦、flash 多层系统、PIM 架构等任何平台。旧研究要么只看小模型、要么只报告表面统计（如 Mixtral 报告重复路由比例、OLMoE 报告共激活与领域特化、SGLang 博客报告 DeepSeek V3 专家分布），**没有**一个做到跨多个 >200B 模型的全面 profiling + 数据移动中心方法论。

---

## 3. Profiling 方法论：时序 × 空间

本文的核心贡献是**一套系统无关的 profiling 框架**。它把 MoE 专家选择的规律分成**时序关系（temporal）**与**空间关系（spatial）**两大类：

![图2 MoE LLM 推理过程与数据移动中心 profiling 的分类法：时序关系（层级 Ob1 / token 级 Ob2 / prefill-decode 级 Ob3）和空间关系（单专家 Ob4 / 专家对 Ob5）](/vibe-reading/images/articles/moe-data-movement-forecasting/fig-02-categorization.png)

**时序关系**——当前选择如何预示未来选择，支撑**单单元策略**（prefetch / cache / 迁移），分三个时间尺度：
- **层级（Ob1）**：相邻两层的专家选择关系；
- **token 级（Ob2）**：同一层相邻两 token 的关系；
- **prefill-decode 级（Ob3）**：prefill 阶段与 decode 阶段的关系。

**空间关系**——给定时间窗内专家激活如何跨计算单元分布，支撑**多单元策略**（放置与负载均衡），分两类：
- **单专家激活不均（Ob4）**：统计倾斜与影响因子；
- **专家对共激活亲和（Ob5）**：两专家组合的共激活性质。

被 profiling 的四个模型：DeepSeek V3（671B）、Llama4-Maverick-128E（402B）、Qwen3-235B（235B）、Kimi K2（1000B），各跑 24,000+ 请求，收集所有层所有 token 的专家选择 trace，形成 >150 GB JSON 数据库，耗 >2000 GPU 小时。这套 trace 已开源。

---

## 4. 六大关键 Insight

### 时序关系 → Insight 1-2

**层级（Ob1）**：相邻层的联合共激活热图显示**清晰的跨层相关**——白点标出显著高于背景的专家对，还有贯穿全行的亮竖线（"大众专家"，无论上层选谁都被频繁选中）。用条件 CDF 量化：前 20% 的下一层候选已覆盖 DeepSeek V3/Qwen3/Llama4/Kimi K2 分别 50%/65%/77%/56% 的条件概率质量，Llama4 最强、DeepSeek 最弱。

**token 级（Ob2）**：跨 token 热图除白点/竖线外，还有一个跨所有模型的共性——**亮对角线**，即相邻 token 倾向选同一专家，且**主要出现在高层（17、43）而非低层（1、3）**。前 20% 下一 token 候选覆盖 47%/62%/80%/53%。

**prefill-decode 级（Ob3）**：prefill 与 decode 的热图分布**高度相似**（Spearman ρ ≥ 0.7，多数层强相关）；top-5 prefill 专家覆盖约 60% 的 top-5 decode 专家，扩到 top-10/top-20 升到 75%/90%。

★ **Insight 1 · Prefill-data-driven prediction（Ob3）**：用 prefill 阶段的专家选择 trace 预测 decode 阶段的选择。两者相似性强，尤其在 decode 刚开始、历史 token 稀少时最有价值——现代 PD 解耦 serving（prefill/decode 分机器跑）里正好可用。§6 的 prefill-aware 放置就基于此。

★ **Insight 2 · Cross-hierarchy memory management（Ob1, Ob2）**：层级（短重用距离）与 token 级（长重用距离）自然映射到多级存储层级。多 chiplet 里 LLC（快而小）管理层级关系，本地 DRAM（大而慢）管 token 级关系；CXL/SSD/PIM 系统同理——快层管层级、慢层管 token 级。

### 空间关系 → Insight 3-6

**单专家不均（Ob4）**：以 Llama4 第 7 层为例，部分专家被激活的频率**高出均值 16 倍以上**。MMLU 57 个学科分析显示：无论学科，总有一批专家恒定热门（横向亮线），其余热门专家因学科而异。更关键——中文版 MMLU（同题不同语言）呈现**截然不同**模式：仅 5-6 个专家跨语言恒定热门，与英文 MMLU 的热门专家只重合 2 个。这证明**任务特征（含语言）显著影响专家选择**。

**专家对共激活（Ob5）**：共激活热图出现概率达理论值 20-40 倍的亮点的专家对；前 10% 专家对占总激活的 60-80%。DeepSeek 的热图因路由限制（只路由到相邻节点）呈现亮方块结构。

★ **Insight 3 · Expert-placement-aware workload distribution（Ob4, Ob5）**：分配任务到单元时把专家放置纳入考量。传统多 GPU 倾向把专家放本地 GPU 避免跨卡通信，但多 chiplet 的卡间通信变快后，可考虑把任务分到远端 die 以求更好的负载均衡。

★ **Insight 4 · Popular expert decentralization（Ob4）**：复制或分散热门专家以均衡负载；避免把多个热门专家放在同一单元。

★ **Insight 5 · Expert-pair separation（Ob5）**：把频繁共激活的专家对分到不同计算单元以最大化并行，但要权衡跨单元通信开销（依赖系统拓扑与 batch size）。

★ **Insight 6 · Workload-aware serving（Ob4）**：用任务类型/语言等工作负载信息做专家迁移。英文查询激活的专家子集不同于中文；离线一次性 profiling 每个模型的"任务→专家"映射即可在部署期间复用——当负载以英文为主，预先复制/重配英文相关专家。

---

## 5. 案例 1：晶圆级 GPU 架构设计

### 未来 GPU 的趋势与挑战

单 die 受光罩尺寸限制（800-1000 mm²），多 chiplet 封装（TSMC CoWoS、Samsung X-Cube、Intel EMIB）已成主流——AMD MI300 八 chiplet、NVIDIA Blackwell 两 chiplet、Rubin 预计四 chiplet。趋势进一步走向**晶圆级**：TSMC System-on-Wafer（SoW）单晶圆可容纳 24 个计算 die + 96 HBM die、>200,000 mm²、>3 TB HBM。

晶圆级 GPU 用**单 GPU 式编程模型**（把整片晶圆暴露成一个统一 GPU，抽象多 die 拓扑）——与 Blackwell/Rubin 对齐，且免去 NCCL/NVSHMEM 的显式跨 die 通信管理。但优化负担全转给硬件：本地 vs 远端 HBM 访问成本差 **15×**，软件却无法控制跨 die 数据移动。

### 两个关键缺陷

当前 GPU 架构在晶圆级有两个不足：**(1) 任务分配太朴素**——SoC 里的 CPU 命令处理器把所有 SM 视为等同、忽略物理位置与数据放置，导致过多 D2D 流量、无视 MoE 倾斜；**(2) 本地 HBM 管理缺失**——GPU 把所有 HBM 视为均匀地址空间，不区分本地/远端，无法把高频访问的远端专家缓存到本地。

### 本文架构：两级 command processor + 硬件管理 HBM

针对上述缺陷，本文（遵循 Insight 3 设计任务分配、Insight 1/2 构建数据驱动预测器）做轻量架构改动：

![图3 晶圆级多 chiplet GPU 架构：(a) 含两级 command processor（全局 CP + 本地 CP）、硬件管理本地 HBM（PDU 预测表 + ATU 地址翻译）的架构；(b) TSMC SoW 封装技术剖面；(c) 全局 CP 内存中的专家分布表与跨 token 预测热图](/vibe-reading/images/articles/moe-data-movement-forecasting/fig-03-waferscale-arch.png)

- **两级 data-placement-aware command processor**：全局 CP 跨 die 平衡负载并做数据驱动预测；本地 CP 在每个 die 内按预测做硬件管理的本地 HBM。
- **硬件管理的本地 HBM**：预测数据单元（PDU）维护 `cp_en / is_local` 预测表；地址翻译单元（ATU）把远端地址重定向到本地缓存副本。SM 读远端数据时，若已缓存本地，ATU 重定向到 LLC。
- **任务分配算法**（Algorithm 1）：NP-hard，用两个启发式——候选机制（只看专家所在 die 及相邻 die）+ 块粒度分配（块大小 50 平衡效率/精度），用成本模型（DRAM 访问 + 计算 + D2D 通信）选每块的最优 die。
- **数据驱动预测器**：用当前 token 的专家选择查跨 token 热图，预测下一 token 的热门专家并复制到本地 DRAM。

### 结果：6.6× 平均吞吐加速

在自研多 chiplet GPU 模拟器（建模 LLC/HBM/计算单元/D2D 链路，8×H100 DGX 实测验证）上，对四个模型 decode 阶段 MoE 层吞吐：四个模型分别取得显著加速，**平均 6.6×**。关键 hop 数（远端访问跳数）大幅下降。这一结果直接来自把 6 条 insight 落到硬件——任务分配（Insight 3）+ 数据驱动预测（Insight 1/2）+ 本地缓存（Insight 4 的分散热门专家思想）。

---

## 6. 案例 2：prefill-aware 专家放置（现有 8×H100）

### 动机：prefill 能预测 decode

§4 的 Insight 1 已证明 prefill 与 decode 的专家选择高度相关。把它落到现有系统：用 prefill 阶段采集的专家选择信息**预测 decode 阶段的热门专家**，在 decode 开始前重排或复制专家以降低负载不均。

### 两种算法：Remap 与 Dup

- **Remap**：根据 prefill 预测的 decode 热门专家**重排**专家到各 GPU（EP8，每 GPU 16 专家/层），让热专家均匀分散；
- **Dup**：不搬动，而是给热 GPU **额外复制**热门专家——用每 GPU 多一个槽，即 128+8=136 专家/层。

### 结果：up to 1.25× MoE 计算加速

![图4 prefill-aware 专家放置性能：横轴 batch size（4K/8K/16K/24K），四种策略（Default / Worst / Best / Remap(Ours) / Dup(Ours)）的 MoE 加速比](/vibe-reading/images/articles/moe-data-movement-forecasting/fig-04-placement-results.png)

| 策略 | 说明 | vs Default |
|---|---|---|
| Default | Qwen/SGLang 的标准连续放置（expert 0-15 在 GPU-0…） | 1.00× |
| Best | 用 oracle decode 选择生成的理论最优放置 | 基准上限 |
| Worst | oracle 生成的最差放置 | <1× |
| **Remap（本文）** | prefill 引导重排 | **+15.5%** |
| **Dup（本文）** | prefill 引导复制（128+8） | **+12.5%** |

Remap 与 Dup 分别比 Default 快 15.5% 和 12.5%，**比 Worst 快 2× 以上**，且都落在理论最优 Best 的 10% 以内——而 Best 用了实践中不可得的 oracle decode 信息。两者表现相当，可按内存/系统约束选择。作者指出 EP8 规模天然限制了改进空间（每 GPU 16 专家已自然混合冷热，max/min 执行时间比仅约 1.3×），预计更大 EP 规模下倾斜更严重、加速更明显。

---

## 7. 讨论与局限

### 两个 case study 只是冰山一角

晶圆级 GPU 设计（Insight 3 任务分配 + Insight 1/2 预测）和 prefill 引导放置（Insight 1）只是 profiling insight 的两个具体落地。这些 insight 远超这两个场景，可惠及：多 GPU 集群（Multi-Node DGX、MegaScale-Infer、NVL72）、CXL/CPU 内存解耦（MoE-Lightning、CoServe）、flash 多层系统、PIM 架构（Duplex）等任何 MoE serving 平台。

### 局限性

- **加速与可加窗份额成正比**：专家选择倾斜更小、可优化份额更小的模型/配置拿更小增益（但仍可观）。
- **晶圆级结果靠模拟**：自研事件驱动模拟器（现有工具 Gem5/gpgpusim 对 20+ die + 15,000 batch 太慢，ASTRA-sim 缺微架构建模且不支持单 GPU 式编程模型），已用 8×H100 DGX 实测验证；但真晶圆硬件尚未量产。
- **case study 2 的 EP8 天花板**：每 GPU 16 专家的天然混合限制了可改善空间，更大 EP 规模潜力更大。
- **case study 2 复现**：真实 GPU 执行有小幅时序变化（热扰动、系统负载、NCCL 非确定性、SGLang 微批处理），run-to-run 变化通常 ±5%，高层结果稳定：prefill-aware 放置比默认放置快约 5-25%。

---

## 8. 总结与展望

### 贡献总结

1. **首个大规模、系统无关的数据移动中心 profiling**：跨四个 2025 SOTA MoE 模型（235B-1000B）、24,000+ 请求、>2000 GPU 小时、>150 GB trace，从时序与空间双视角覆盖。
2. **六条可操作 insight**：prefill 预测 decode、跨存储层级管理、放置感知负载分配、热门专家分散、专家对分离、工作负载感知迁移——系统无关，适用于任何 MoE serving 平台。
3. **两个落地 case study**：晶圆级 GPU 架构（两级 CP + 硬件管理 HBM，6.6×）+ 现有多 GPU prefill-aware 放置（Remap/Dup，up to 1.25×）。
4. **开源工件**：70,000+ 专家选择 trace（>150 GB JSON）+ 多 chiplet 模拟器 + 两个 case study 的复现包（CPU 可跑的模拟器 + 8×H100 真机实验）。

### 局限性（批判性）

- 晶圆级 GPU 依赖模拟器而非真硬件；真硬件表现待 SoW 量产后验证。
- EP8 的改善幅度有限，更大 EP 规模的实证留给未来。
- profiling 的四模型虽代表 2025 SOTA，但 MoE 架构（路由机制、专家粒度、是否加 dense FFN 层）仍在演化，规律的普适性需持续跟踪。

### 未来方向（创造性，idea 三法）

**① 弥补缺陷**：把 prefill-aware 放置从 EP8 推到更大 EP 规模（NVL72 等大集群）实证更显著的倾斜收益；把晶圆级架构的两级 CP + 硬件管理 HBM 在真实 SoW 硬件上落地（待量产）。

**② 新型方案**：把六条 insight 组合——用 Insight 1（prefill 预测）+ Insight 6（工作负载感知）做**在线自适应专家迁移**（prefill 指导 decode 放置 + 任务类型预复制热专家，二者协同）；把跨层级/token 级时序关系（Insight 2）喂给一个**学习型缓存策略**（替代固定 LLC/DRAM 分层，按实时重用距离动态调度）。

**③ 减少约束**：把 profiling 框架推广到 2026 年新出的 MoE 架构（DeepSeek V4、GLM-5 等论文发布后的模型），验证六条 insight 是否仍成立；对 block-diffusion 草稿器这类新型 MoE 变体做数据移动 profiling（其注入上下文可能带来不同的 O(d·S) 税）。
