---
title: "LLMForge: Multi-Backend Hardware-Aware Neural Architecture Search with Infinite-Head Attention for Edge Language Models"
source:
  type: "论文解读"
  project: "Brown University"
  url: "https://arxiv.org/abs/2605.17653"
  pdf: "/vibe-reading/papers/llmforge-hardware-aware-nas-edge-lm.pdf"
date: "2026-09-14T10:36:52+08:00"
category: [AI, Models, Text Model, Papers]
tags: ["NAS", "Hardware-Aware", "Edge LLM", "Attention", "IHA", "NSGA-II", "Surrogate Model", "Pareto Front", "rDXE", "Sub-Billion"]
description: "目的：为边缘设备搜索亚十亿参数 LLM 架构。手段：IHA 解耦注意力四参数（空间扩 400×）+ Forge-Former 编码器代理 + Forge-DSE 多后端 NSGA-II 联合搜架构与芯片。结论：300M 档三个变体全面超越 SmolLM2-360M/Qwen-0.5B 基线：精度最优 val loss 2.798、能耗省 40%、延迟降 43%。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/llmforge-hardware-aware-nas-edge-lm.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LLMForge: Multi-Backend Hardware-Aware Neural Architecture Search with Infinite-Head Attention for Edge Language Models](https://arxiv.org/abs/2605.17653) · **作者** Xinting Jiang, Junyi Luo, Ruichen Qi, Kauna Lei, Ben Laurie, Gregory Kielian, Mehdi Saligane · **机构** Brown University / University of Michigan / Google Research · **发表** arXiv 2605.17653, 2026-05 · **代码** [anonymous.4open.science/r/llmforge_code-6838](https://anonymous.4open.science/r/llmforge_code-6838/llmforge) · **解读** 2026-09-14

---

## 1. 论文概览

亚十亿参数的 Transformer 语言模型正在大规模走向端侧部署——隐私、延迟、运营成本都在吸引 on-device 推理，但移动端实测表明这条路是 **memory-bound + energy-limited** 的：自回归解码每一步都要重付 weight 与 KV-cache 的访存代价，量化/剪枝这类后训练压缩只能修修补补，架构本身的设计自由度从未被系统性探索过。

Brown University 联合 Michigan、Google Research 的这篇论文提出 **LLMForge**，一个硬件感知神经架构搜索（NAS）框架，把三个可组合的贡献拼进同一个 NSGA-II 进化搜索回路：

1. **Infinite-Head Attention（IHA）**：把 $n_h$、$n_{kv}$、$d_{qk}$、$d_v$ 四个注意力形状参数解耦为逐层独立变量，砍掉 MHA 的整除约束与 Q/K–V 耦合约束，逐层可行配置数从 GQA 的 27 个扩到 **11,250 个（约 400×）**；
2. **Forge-Former**：一个 20 万参数的 Transformer 编码器代理模型，用"架构即 token 序列"的方式给候选打分，排序保真度（Spearman $\rho$ = 0.75）比 MLP / 随机森林基线高 1.4–2.5×；
3. **Forge-DSE**：多后端设计空间探索引擎，硬件成本模型横跨 GPU（ZEUS 实测）、脉动阵列（Timeloop 建模的 Gemmini / Eyeriss / FLAT）和多芯片环形数据流边缘加速器（rDXE 模拟器），并可在搜索中**联合演化芯片配置**。

**TL;DR**：不同硬件基底的成本瓶颈不同（GPU 卡带宽、脉动阵列卡 KV 读、环形加速器卡流水线级），所以"最优架构"必须是硬件条件的函数。LLMForge 在四种基底上各自收敛到形态迥异的架构；在 rDXE 环形基底上联合搜出的 300M 档三个变体，同配方重训后分别拿下最低验证损失（2.798）、最低能耗（每 token 省 40%）、最低延迟（TTFT/TPOT 双降 43%）。

**一句话 take-home**：端侧 LLM 的"最优架构"不是一个点而是一条硬件条件化的 Pareto 前沿——把注意力形状参数解耦 + 多后端成本建模 + 进化搜索，就能系统地走到这条前沿上。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Sub-billion-parameter Transformer language models are increasingly deployed on edge devices, where the privacy, latency, and operating-cost advantages of on-device inference are constrained by tight memory-bandwidth, energy, and thermal budgets that make architectural choice and accelerator-specific cost central to efficient inference. We present LLMForge, a hardware-aware neural architecture search (NAS) framework whose three composable contributions together make edge-LM architecture search hardware-conditioned, since different substrates impose different hardware cost bottlenecks. Infinite-Head Attention (IHA) decouples the number of query heads, KV groups, and per-head query/key and value dimensions, expanding the feasible per-layer attention configuration space by ~400× over grouped-query attention within our search-space ranges. Forge-Former, an encoder-based surrogate for ranking architectural candidates, outperforms MLP and random-forest baselines. Forge-DSE, an NSGA-II-based design-space-exploration engine, pairs Forge-Former with a multi-backend hardware cost model spanning GPUs, systolic accelerators, and ring-dataflow edge accelerators. Across four different hardware substrates, the searches converge to visibly different architectures whose shapes track each substrate's cost bottleneck. On the multi-chip ring substrate, our co-search returns three 300M-scale deployment-aware variants on the Pareto front. Each is re-trained on FineWeb-Edu-10BT under matched recipe against SmolLM2-360M and Qwen-0.5B architecture baselines. The accurate variant has the lowest validation loss 2.798 and competitive benchmark performance with fewer parameters, the energy-optimized variant lowers energy per token by 40%, and the latency-optimized variant lowers TTFT and TPOT by 43%.

> **译：** 亚十亿参数 Transformer 语言模型越来越多地部署在边缘设备上，端侧推理在隐私、延迟和运营成本上的优势，受制于紧张的内存带宽、能耗与散热预算——这使得架构选择与加速器特定的成本成为高效推理的核心。我们提出 LLMForge，一个硬件感知神经架构搜索（NAS）框架，其三项可组合的贡献共同使端侧 LM 架构搜索以硬件为条件，因为不同基底施加不同的硬件成本瓶颈。Infinite-Head Attention（IHA）解耦查询头数、KV 组数及每头 query/key 与 value 维度，在我们的搜索空间范围内将逐层可行注意力配置空间较 GQA 扩大约 400 倍。Forge-Former 是一个基于编码器的架构候选排序代理，优于 MLP 与随机森林基线。Forge-DSE 是基于 NSGA-II 的设计空间探索引擎，将 Forge-Former 与横跨 GPU、脉动加速器和环形数据流边缘加速器的多后端硬件成本模型配对。在四种硬件基底上，搜索收敛到形态明显不同的架构，其形状随各基底的成本瓶颈而变。在多芯片环形基底上，联合搜索在 Pareto 前沿返回三个 3 亿参数级的部署感知变体，均在 FineWeb-Edu-10BT 上以匹配配方与 SmolLM2-360M 和 Qwen-0.5B 架构基线重训对比：精度最优变体取得最低验证损失 2.798 且参数更少、benchmark 表现有竞争力；能耗优化变体每 token 能耗降低 40%；延迟优化变体 TTFT 与 TPOT 均降低 43%。

</details>

---

## 2. 研究背景

**问题定义**：给定 ≤500M 参数预算和一块目标边缘硬件（GPU / 脉动阵列 / 专用加速器），找一个 Transformer 架构，使验证损失、每 token 能耗（$E_{tok}$）、首 token 延迟（TTFT）、每 token 生成时间（TPOT）四目标同时最优。输入是架构与硬件的联合配置，输出是一条 Pareto 前沿而非单点。

**现有方法的三个缺口**（论文引言里点得很清楚）：

| 缺口 | 现状 | LLMForge 的回应 |
| --- | --- | --- |
| 注意力参数化过窄 | NAS 工作沿用 MHA/GQA，整除约束 + Q/K–V 耦合使逐层注意力形状基本由头数一个变量决定 | IHA 四参数解耦，空间 ×400 |
| 评估后端是成本瓶颈 | 每个候选从头训练太贵 | Forge-Former 编码器代理 + 搜索中共演化精化 |
| 硬件成本建模粗糙 | 单一加速器类别，或用参数量/KV 大小做粗代理，掩盖了候选的基底相关重排序 | 多后端成本模型（实测 GPU / 解析脉动阵列 / 环形模拟器） |

**相关工作脉络**：注意力侧有 MQA（单 K/V 共享）→ GQA（$n_{kv}$ 组插值）→ MLA（DeepSeek 的低秩共享隐变量，但隐维度是全局超参）；替换注意力原语的有 Falcon-H1（混合 SSM 头）、Jet-Nemotron 的 JetBlock（线性注意力+动态卷积）。层形状层面，MobileLLM 和 OpenELM 用启发式验证了"薄而深 + 渐进宽度分配"在亚十亿规模有效，但都是人肉规则。硬件感知 NAS 侧，HAT 用超网络+逐设备延迟查表、TransCODE 把 ASIC 当搜索空间一部分做贝叶斯联合优化、STAR 用参数量和 KV 大小做粗代理、HW-GPT-Bench 提供了 GPT-2 式固定空间的硬件感知基准。LLMForge 的差异点：**更宽的逐层注意力空间 × 多后端成本模型 × 编码器代理，产出的是逐基底的 Pareto 前沿而不是每次搜索一个架构**。

---

## 3. 方法详解

LLMForge 整体是一条 NSGA-II 多目标进化回路：种群里的每个个体是一个 IHA 参数化的架构，Forge-Former 预测其验证损失（软件成本），可插拔的硬件后端报告部署成本（能耗/TTFT/TPOT），四目标非支配排序 + 拥挤度生存驱动进化；每 $K$ 代触发一次代理精化事件，把 Forge-Former 拉回与种群分布对齐。

![图 1 Forge-DSE 流水线：上为带 Forge-Former 共演化反馈的四阶段外循环；下为前三阶段放大——编码、子代生成、适应度评估](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-01-forge-dse-pipeline.png)

### 3.1 Infinite-Head Attention（IHA）

标准多头注意力（MHA）有两条隐性约束：

- **整除约束** $d_{model} = n_h \cdot d_h$：加头必减每头维度，头数与单头表达力纠缠；
- **Q/K–V 耦合** $d_h = d_{qk} = d_v$：value 侧容量被绑死在 query/key 侧，尽管输出投影回 $d_{model}$ 并不要求两者相等。

IHA 把 $n_h$、$n_{kv}$、$d_{qk}$、$d_v$ 全部当作**逐层独立变量**，唯一保留的对齐要求是 GQA 分组条件 $n_{kv} \mid n_h$。注意力在 $n_{kv}$ 个 K/V 组上计算，每组服务 $R = n_h / n_{kv}$ 个查询头。

![图 2 Infinite-Head Attention：nh、nkv、dqk、dv 逐层独立变化；各头输出拼接后投影回 dmodel](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-02-infinite-head-attention.png)

搜索空间（Table 3）的其他维度同样逐层化：层门控（剪枝）、注意力门控（identity 旁路）、MLP 宽度 $d_{mlp} \in [512{:}256{:}4096]$；全局共享 $d_{model}=768$、块长 1024、最大层数 40。这个空间里，**层数、每层是否有注意力、每层多少头/多宽的 MLP 全都是被搜索的决策**。

### 3.2 Forge-Former：编码器代理

搜索最大的成本是"每个候选都要真训一遍才知道好坏"。Forge-Former 的做法是把**架构本身编码成 token 序列**：

- 每个活跃层是一个 token，拼接该层的 7 个逐层字段 + 2 个广播的全局字段（$d_{model}$、$T$），共 9 个标量；
- 每个标量字段经各自的线性层升维到 $d_{enc}$，求和后加可学习位置编码——和 NLP 里 token embedding + position embedding 的做法同构；
- 变深度用 padding + mask 处理，被剪掉的层不参与 attention 和池化；
- 4 层 pre-LN Transformer 编码器（$d_{enc}=64$，4 头，FFN 256，共 **203,713 参数**）捕捉层内字段交互（FFN 子层）与跨层交互（self-attention）；
- masked mean pooling + 线性回归头输出预测验证损失 $\hat{y}(x)$。

![图 3 Forge-Former 架构：逐层 IHA 字段各自线性升维求和加位置编码，编码器后 masked mean pooling 出标量预测](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-03-forge-former-architecture.png)

训练语料是 **1,642 个均匀随机采样的 IHA 架构**，每个在 MiniPile 上以固定 655M token 预算从头训练并记录验证损失作标签（每架构单卡 H100 约 1.5–2 小时）。损失用 L1 而非 MSE——搜索空间可行性边界附近的残差重尾，L1 更稳。

### 3.3 Forge-DSE：多后端搜索引擎

每个硬件后端实现统一接口 $HW(x, W) \rightarrow (E_{tok}, TTFT, TPOT)$，把 IHA 架构 $x$ 在固定 prefill+decode 负载 $W$ 下映射为逐 token 成本。三个后端：

- **Backend A — ZEUS 实测 GPU**：A100 上端到端实测（NVML 能耗计数器，prefill 256 / decode 256，bf16，生产式 KV-cache 单查询 SDPA 解码循环），做 GPU 基底的测量基准；
- **Backend B — Timeloop 建模基底**：解析成本模型，实例化四种 16nm 脉动阵列模板——Gemmini（16×16 weight-stationary）、Eyeriss（14×12 row-stationary）、FLAT（32×32 flexible，支持 QK/PV 片上融合）、单芯片 DXE（8 DXT tile × 16 core，2048 MAC）；
- **Backend C — rDXE 多芯片环形基底**：把 DXE 芯片连成环、权重驻留芯片、token 级流水线。这是论文最有意思的部分——**芯片配置也进搜索空间**：对每个候选架构，后端在 $3\times3\times5=45$ 格的芯片模板网格上扫描（每核 MAC 数、每核 weight memory、最大环深），做平衡连续装箱（二分搜索每级 decode-ops 预算，最小化最慢级延迟），再由环形模拟器返回成本。

![图 4 Backend C 的环形数据流联合搜索流水线：左为逐层资源画像（WMEM/KV$/MACs），中为多资源平衡装箱求分区与共享 DXE 配置，右为 rDXE 模拟器返回 TTFT/TPOT/每 token 能耗](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-04-rdxe-co-search-pipeline.png)

**搜索算子**设计也针对架构编码做了定制：二元锦标赛选择 → 单点交叉 → 四算子顺序变异（**删除**层 / **复制**层复用已优化的结构 / **旋转反射**重排层序 / 数值扰动），再过可行性修复。

**共演化机制**：每 5 代触发一次精化事件——从当前种群挑 8 个架构（4 个 exploit：第一非支配前沿上 $\mu(x)$ 最低；4 个 explore：其余种群中 $\sigma(x)$ 最高，不确定性由 10 次 MC-dropout 前向估计），真训打标后，从**冻结的基线 checkpoint** 出发（避免误差累积）以 5:1 的旧新重放比微调代理。40 代搜索共产生 64 次真训采集，8 卡池并行下每次事件的墙钟时间等于单架构训练时间。

---

## 4. 关键公式解读

**GQA 分组映射**——IHA 保留的唯一约束：

$$
g(h) = 1 + \left\lfloor \frac{h-1}{R} \right\rfloor, \quad R = \frac{n_h}{n_{kv}}
$$

查询头 $h$ 被映射到 K/V 组 $g(h)$，每组服务连续的 $R$ 个查询头。这是 GQA 的标准映射，IHA 只是把 $n_h$、$n_{kv}$ 连同 $d_{qk}$、$d_v$ 一起逐层独立化。

**配置空间扩张**——400× 的来源：

$$
\underbrace{\sum_{n=1}^{16} d(n)}_{=50\ \text{个合法}\,(n_h, n_{kv})\ \text{对}} \times \underbrace{|d_{qk}|}_{=15} \times \underbrace{|d_{v}|}_{=15} = 11{,}250
\ \text{个/层} \quad\text{vs GQA 的}\ 27\ \text{个/层}
$$

GQA 要求 $n_h \mid d_{model}$、$n_{kv} \mid n_h$ 且 $d_{qk} = d_{v} = d_{model}/n_h$（$d_{model}=768$ 时仅 27 种）；IHA 的 $(n_h, n_{kv})$ 合法对数是 1–16 内所有整数的因子数之和（恰为 50），$d_{qk}, d_v \in \{64, 96, \ldots, 512\}$ 各 15 档独立取值。

**多目标适应度**——NSGA-II 的四目标向量：

$$
\mathbf{F}(x) = \bigl(\hat{y}(x),\ E_{tok},\ TTFT,\ TPOT\bigr) \leftarrow HW(x, W), \quad \text{全部最小化}
$$

其中 $\hat{y}(x)$ 是 Forge-Former 预测的验证损失。生存选择用约束支配排序 + 拥挤度距离：不可行个体（如超出可行性修复范围）被可行个体支配，多样性由拥挤度维护。

---

## 5. 实验设置

**两组实验**：

1. **代理驱动的四基底搜索**（§4.2）：ZEUS A100 / Gemmini / Eyeriss / FLAT，Forge-Former + 共演化，种群 24、子代 48、40 代，prefill/decode 256/256；
2. **rDXE 联合搜索**（§4.3）：每个候选**真训评估**（非代理），架构与芯片配置联合优化，两个种子规模（SmolLM2-135M 档 ~100M、SmolLM2-360M 档 ~300M），种群 24、子代 12、20 代，prefill/decode 512/256。

**代理训练/验证语料**：IHA 空间 2,053 个架构（1,642 训练 / 411 测试），每个 MiniPile 655M token 固定预算从头训练；另外在 HW-GPT-Bench 发布的 gpt_l 数据集上与它的 Net 代理对齐比较。

**缩放验证**：5 个 Pareto 前沿选株在 **FineWeb-Edu-10BT**（13.1B token）上从头预训练，与四个基线（SmolLM2-135M / 360M、Pythia-160M、Qwen-0.5B）**同配方重训**——统一用 GPT-2 BPE tokenizer（50,257 词表）、AdamW、cosine 调度 3e-4→3e-5、13.1B token，消除 tokenizer/语料/算力混淆因子。评测用 zero-shot：ARC-Easy/Challenge、BoolQ、HellaSwag、SciQ（长度归一化对数似然打分）；硬件指标在 rDXE 环形基底上按各自联合搜出的芯片配置评估。

**复现性**：代码、Forge-Former 权重、各基底 Pareto 前沿架构配置全部发布（anonymous.4open.science 匿名仓库）；所有数据集公开。硬件评估的测量噪声也有交代——SmolLM2-360M 锚点 10 次独立测量，TPOT 相对标准误 0.19%、能耗 0.25%、TTFT 最大也只 ~3%。

---

## 6. 实验结果

### 6.1 Forge-Former 代理质量

在 IHA 测试集上，Forge-Former 的排序保真度大幅领先：Spearman $\rho$ = **0.754** vs MLP 0.345 / RF 0.538；MAE@5%（只看真实 top-5% 的误差，即"Pareto 保真度"）为 **0.057**，比两个基线低约 5×。在 HW-GPT-Bench 的固定空间上则与它的 Net 代理打平全局排序、MAE@5% 和 k@5% 领先——说明优势来自编码器结构对跨层交互的归纳偏置，而非空间本身。

![图 5 留出集架构嵌入的 t-SNE 投影（按验证损失着色）：Forge-Former 嵌入的 kNN MAE 0.218，把高损失尾巴拉成紧簇而非弥散](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-05-tsne-embeddings.png)

t-SNE 分析很直观：raw features / RF 邻近度 / MLP 倒数第二层的 kNN MAE 都在 0.42–0.46，而 Forge-Former 的嵌入降到 **0.218**——几何邻近真正反映了性能相似，高损失架构被拉成紧簇。

### 6.2 四基底搜索：形态随瓶颈而变

四个基底各自收敛到**肉眼可见不同**的架构，且每个基底都有一个 Pareto 选株在全部四目标上严格支配 SmolLM2-135M 锚点：验证损失 −5%~−7%、$E_{tok}$ −16%~−63%、TTFT −21%~−59%、TPOT −16%~−63%。

![图 6 四个 Forge-Former 驱动基底上的 Pareto 前沿：颜色编码 TTFT、大小编码 TPOT，空心星为各基底实测的 SmolLM2-135M 锚点](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-06-pareto-fronts-four-substrates.png)

**基底条件化的架构指纹**是论文最有洞察力的结果（Figure 8，top-50 非支配架构的逐层均值±1σ）：

- **A100 GPU**：带宽富余 + 稠密 GEMM 单元，逐层成本近乎均匀 → 搜索响应为**平坦的 MLP 宽度 + 四个基底中最宽的注意力头**；
- **Eyeriss / Gemmini**（空间数据流）：decode 成本由 KV-cache 读主导，随深度、$n_{kv}$、$d_v$ 线性增长 → 搜索**把 $n_{kv}$ 压到激进的 GQA 甚至 MQA 边缘，用更宽的 MLP 补容量**——MLP 权重跨 token 可复用，KV 却每 token 都要重读；
- **FLAT**：足够灵活，所有维度均匀收缩 → **最小的模型、浅深度、窄头**。

![图 8 各基底 top-50 非支配架构的逐层架构指纹（均值±1σ）：不同硬件瓶颈拉出形态迥异的架构](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-08-architectural-fingerprints.png)

关键结论：**硬件感知联合搜索重塑的是逐层宽度/深度 profile，而不只是总参数量**——不同基底的架构可以落在相近的参数量上，但深度剖面形状截然不同。

### 6.3 rDXE 联合搜索：三变体对基线

两个种子规模的联合（架构 × 芯片）Pareto 前沿如下；每个模型都在**自己联合搜出的芯片配置**上评估：

![图 9 rDXE 多芯片环形基底、逐候选真训评估的联合 Pareto 前沿：(a) ~100M 档（TTFT 为主轴以凸显 prefill 主导型态）、(b) ~300M 档](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-09-rdxe-pareto-fronts.png)

同配方重训后的核心数值（FineWeb-Edu-10BT，13.1B token）：

| 档位 | 模型 | 参数 (M) | val_loss ↓ | HS ↑ | SciQ ↑ | $E_{tok}$ (µJ) ↓ | TTFT (ms) ↓ | TPOT (ms) ↓ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ~100M | SmolLM2-135M | 135 | 3.010 | 31.32 | 68.90 | 56.6 | 4.00 | 3.21 |
| ~100M | Pythia-160M | 160 | 3.044 | 29.99 | 69.70 | 55.4 | 2.68 | 1.70 |
| ~100M | **LLMForge-Acc-123M** | 123 | **3.003** | 31.43 | 68.20 | **17.9** | **1.24** | **0.48** |
| ~100M | **LLMForge-Compact-106M** | 106 | 3.037 | 30.34 | **70.70** | **14.3** | **1.13** | **0.38** |
| ~300M | SmolLM2-360M | 362 | 2.831 | 36.22 | 72.10 | 143.0 | 6.71 | 5.65 |
| ~300M | Qwen-0.5B | 402 | 2.821 | 36.37 | 71.60 | 135.6 | 7.07 | 4.08 |
| ~300M | **LLMForge-Acc-347M** | 347 | **2.798** | **36.95** | **74.70** | 124.8 | 6.40 | 5.46 |
| ~300M | **LLMForge-Eco-294M** | 294 | 2.833 | 36.33 | 71.10 | **84.9** | 5.38 | 4.74 |
| ~300M | **LLMForge-Fast-365M** | 365 | 3.162 | 36.50 | 71.90 | 149.6 | **3.80** | **3.22** |

三个 300M 档变体的定位：

- **LLMForge-Acc-347M**：全表最低 val_loss **2.798**、最高 HellaSwag/SciQ，参数比两个基线都少，$E_{tok}$ 还低 13%——注意它逐层几乎全是 15 头 / 5 KV 组 / $d_{qk}=64$ 的均匀薄头配置，和 SmolLM2 的常规形状差别很大；
- **LLMForge-Eco-294M**：val_loss 2.833 与 SmolLM2-360M 几乎持平，但 $E_{tok}$ **84.9 µJ vs 143.0 µJ（−40%）**；
- **LLMForge-Fast-365M**：牺牲精度（3.162）换 TTFT **3.80 ms（−43%）**、TPOT **3.22 ms（−43%）**。

~100M 档同样成立：Acc-123M 以更少参数拿下最低 val_loss 和 ~3× 能耗优势；Compact-106M 用 0.034 的 val_loss 换 ~4× 能耗优势和全档最低的 TTFT/TPOT。

三个变体的逐层 IHA 参数化（Figure 13）展示了"部署感知家族"的内部结构——Acc 是均匀 15 头深窄配置，Eco 在后段收缩头数，Fast 是全程 8 头大 $d_{model}$ 的深架构：

![图 13 ~300M 档三个选株的逐层 IHA 参数化：Acc-347M（精度最优）、Eco-294M（最低能耗）、Fast-365M（最低延迟）；颜色为字段归一化值，红框为 identity-attention 层](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-10-300m-tier-picks.png)

诚实的地方：SmolLM2 基线在 ARC-Challenge 和 BoolQ（多选问答簇）两个 scale 上都保持领先，论文没有回避这一点。产物是一组架构-芯片配置对而非单一最优模型——部署时按需选。

---

## 7. 消融实验

**搜索配方消融**（一次变一个因子，40 代 hypervolume，目标为 (val loss, model size)）：

| 配方 | 最终 Hypervolume | 贡献拆解 |
| --- | --- | --- |
| **NSGA + IHA**（完整配方） | **1.05** | — |
| Random + IHA（随机采样替代 NSGA-II 定向子代） | 0.97 | 定向搜索贡献 **+0.08** |
| NSGA + GQA（限制在 GQA 可行子空间） | 1.02 | IHA 空间扩张贡献 **+0.03** |

![图 7 搜索配方消融：(val loss, model size) 空间的 hypervolume 随 NSGA-II 代数演化（5 种子均值±1σ）](/vibe-reading/images/articles/llmforge-hardware-aware-nas-edge-lm/fig-07-search-recipe-ablation.png)

两个因子都有效，但**定向进化的贡献（0.08）大于空间扩张（0.03）**——好空间还要配好搜索才能兑现。

**代理侧消融**（Table 1 的隐式消融）：同一训练数据上，MLP（HW-GPT-Bench 的 Net 基线迁移）与 RF 在 IHA 空间上的 Spearman 只有 0.345 / 0.538，Forge-Former 的 0.754 是结构带来的，不是数据量。另外 HW-GPT-Bench 固定空间上 MLP/RF 反而接近满秩（0.998/0.999），说明**空间越宽、平面代理越不够用**——恰是 IHA 这种宽空间需要编码器代理的原因。

---

## 8. 总结与展望

**贡献总结**：

1. IHA 把逐层注意力形状从"一个头数变量"解放为四个独立变量，搜索空间 ×400，且是即插即用的参数化——任何 Transformer 训练代码改几行投影形状就能用；
2. Forge-Former 证明"架构即序列"的编码器归纳偏置在宽设计空间上碾压平面代理，排序保真度 2× 以上；
3. Forge-DSE 首次（就我所读范围）把 GPU 实测、脉动阵列解析模型、多芯片环形模拟器统一到一个 NAS 接口下，并做了架构-芯片联合搜索，产出的三个 300M 变体在同配方下全面突破 SmolLM2-360M / Qwen-0.5B 锚点；
4. 方法论层面最有价值的观察是**基底条件化**：KV 读受限的基底自动学出激进 GQA + 宽 MLP，带宽富余的 GPU 学出宽头均匀架构——硬件瓶颈直接写进了架构形状里。

**局限性**（论文自陈 + 我的补充）：

- Forge-Former 只在附录 A 的 IHA 空间内可靠，遇到训练语料外的注意力原语（MLA、线性注意力、SSM 混合）或超范围形状就要重新造标签语料——每个架构 1.5–2 小时 H100 的标注成本会随空间宽度线性涨；
- 所有搜索限于 ≤500M 档，论文明说十亿参数级的主要障碍是代理语料的生产成本；
- rDXE 结果来自解析模拟器而非流片实测（虽然单芯片 DXE 有并行硅验证工作背书），模拟-实测 gap 在环形流水线场景下可能放大；
- 基准评测覆盖 ARC/BoolQ/HS/SciQ 五件套，没有 MMLU、指令遵循或端侧真实负载（长上下文、多轮会话）——SmolLM2 在 ARC-C/BoolQ 上的持续领先提示这些多选任务上架构搜索的收益有限。

**未来方向**（idea 三法）：

- *弥补缺陷*：代理零样本迁移——用少量新空间标签微调冻结的 Forge-Former，或用学习曲线外推（训练 1% 步数早期即预测终值）把每架构标注成本压一个量级，直接解锁十亿级搜索；
- *新型方案*：把量化精度（每层 INT8/INT4）和稀疏度并入染色体做"架构-精度-芯片"三方联合搜索；代理本身换成在小模型上预训练、按字段 schema 迁移的通用架构预测器；
- *减少约束*：扩展到混合注意力原语（前几层 MHA、后几层线性注意力/SSM 的 Falcon-H1 式混合头也进搜索空间）；负载从单一 prefill/decode 固定 profile 换成多租户混合；rDXE 环形基底的结论拿真实芯片复验。

---

## 9. 相关阅读

- [Scaling Embeddings Outperforms Scaling Experts in Language Models](/vibe-reading/articles/AI/Models/Text-Model/Papers/scaling-embeddings-outperforms-scaling-experts) — **同域对照**·同为亚十亿-数十亿参数档的"正交扩展维度"研究：本篇搜注意力形状参数，该篇把参数投给 N-gram Embedding，可横向对照两条非常规架构扩展路线
- [VecInfer: Efficient LLM Inference with Low-Bit KV Cache](/vibe-reading/articles/AI/Infra/Inference/Papers/vecinfer-kv-cache-vq) — **方法论镜像**·同一条 KV-cache 带宽瓶颈的另一半解法：本文用架构搜索压 $n_{kv}/d_v$ 削减 KV 流量，该篇用离群抑制+向量量化压缩 KV 表示，正交互补
- [Patterns behind Chaos: Forecasting Data Movement for Efficient Large-Scale MoE LLM Inference](/vibe-reading/articles/AI/Infra/Inference/Papers/moe-data-movement-forecasting) — **背景知识**·大规模 LLM 推理中数据移动开销主导的系统级 profiling，为"为什么不同基底的成本瓶颈会把架构拉向不同形态"提供实证背景
