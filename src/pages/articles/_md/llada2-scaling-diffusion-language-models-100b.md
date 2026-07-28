---
title: "LLaDA2.0: Scaling Up Diffusion Language Models to 100B"
source:
  type: "论文解读"
  project: "Ant Group"
  url: "https://arxiv.org/abs/2512.15745"
  pdf: "/vibe-reading/papers/llada2-scaling-diffusion-language-models-100b.pdf"
date: "2026-07-28T11:20:00+08:00"
category: [AI, Models, Ant Group, Papers]
tags: ["Diffusion Language Model", "Masked Diffusion", "MoE", "AR-to-Diffusion", "Block Diffusion", "WSD", "DPO", "Parallel Decoding"]
description: "目的：把离散扩散语言模型扩到 100B。手段：从 AR 模型系统转换（WSD 三阶段 CPT + SFT/DPO + 置信度训练）。结论：性能追平同规模 AR，编码与智能体领域反超。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/llada2-scaling-diffusion-language-models-100b.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LLaDA2.0: Scaling Up Diffusion Language Models to 100B](https://arxiv.org/abs/2512.15745) · **作者** Tiwei Bie 等（Ant Group / Renmin University of China / Zhejiang University / 西湖大学 / HKUST）· **发表** arXiv 2512.15745v2, 2025-12 · **项目** https://hf.co/collections/inclusionAI/llada-20 · **解读** 2026-07-28

---

## 1. 论文概览

**一句话**：LLaDA2.0 不从零训练扩散语言模型，而是把已有的自回归（AR）大模型**系统性地转换**成离散掩码扩散模型（dLLM），一路推到 100B 总参数——这是扩散语言模型首次站上百亿–千亿级的前沿规模。

- **任务**：通用语言建模与指令跟随（知识、推理、编码、数学、智能体五大维度）。
- **核心创新**：一套 **Warmup–Stable–Decay（WSD）三阶段连续预训练**配方，平滑地把 AR 模型桥接到 masked diffusion；配合文档级注意力掩码、互补掩码、置信度并行训练（CAP）与基于 ELBO 的 DPO，完成从预训练到对齐的完整链路。
- **结果**：LLaDA2.0-mini（16B）平均 64.34，逼近 AR 同门 Ling-mini-2.0（65.77）并超过 Qwen3-8B（63.42）；LLaDA2.0-flash（100B）平均 73.18，与 Qwen3-30B-A3B-Instruct-2507（73.60）持平，在编码、智能体等结构化任务上反超 AR。两个模型均已开源。

**take-home**：扩散语言模型并非只能在 8B 以下"小打小闹"——借助 AR 知识继承与渐进式转换，它可以在前沿规模上与 AR 分庭抗礼，并在并行解码与结构化生成上展现独特优势。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

This paper presents LLaDA2.0 — a tuple of discrete diffusion large language models (dLLM) scaling up to 100B total parameters through systematic conversion from auto-regressive (AR) models — establishing a new paradigm for frontier-scale deployment. Instead of costly training from scratch, LLaDA2.0 upholds knowledge inheritance, progressive adaption and efficiency-aware design principle, and seamless converts a pre-trained AR model into dLLM with a novel 3-phase block-level WSD based training scheme: progressive increasing block-size in block diffusion (warm-up), large-scale full-sequence diffusion (stable) and reverting back to compact-size block diffusion (decay). Along with post-training alignment with SFT and DPO, we obtain LLaDA2.0-mini (16B) and LLaDA2.0-flash (100B), two instruction-tuned Mixture-of-Experts (MoE) variants optimized for practical deployment. By preserving the advantages of parallel decoding, these models deliver superior performance and efficiency at the frontier scale. Both models were open-sourced.

> **译：** 本文提出 LLaDA2.0——一组通过从自回归（AR）模型系统转换、总参数量扩到 100B 的离散扩散大语言模型（dLLM），为前沿规模部署确立了新范式。LLaDA2.0 不从零训练（代价高昂），而是秉持知识继承、渐进适应与效率感知的设计原则，用一种新颖的 3 阶段块级 WSD 训练方案把预训练 AR 模型无缝转换为 dLLM：在块扩散中渐进增大 block-size（warm-up）、大规模全序列扩散（stable）、再回到紧凑 block-size 的块扩散（decay）。配合 SFT 与 DPO 的后训练对齐，我们得到 LLaDA2.0-mini（16B）和 LLaDA2.0-flash（100B）两个面向实际部署优化的指令调优 MoE 变体。通过保留并行解码的优势，这些模型在前沿规模上提供了更优的性能与效率。两个模型均已开源。

</details>

---

## 2. 研究背景

AR 范式靠 next-token 预测从左到右生成，训练高效、与语言结构天然契合，但成功本身也带来了根本限制：**推理天然串行**（无法并行化、规模越大延迟越高），且**严格因果结构**对需要双向推理与全局理解的任务未必最优。

掩码扩散语言模型（MDLM）是替代路径：从随机掩码输入重建序列，天然支持并行生成与全双向上下文。但它仍处早期，已有工作几乎都 ≤8B：

| 路线 | 代表 | 规模 | 局限 |
|---|---|---|---|
| 从零训练 MDLM | LLaDA、LLaDA-MoE、Quakka、OpenMoE2 | ≤8B | 数据量与基础设施远不及 AR，整体仍落后 SOTA AR |
| AR 初始化 dLLM | DiffusionLLaMA、Dream-7B、RND1、BDLM/SDAR | 7B–30B | 规模有限，块扩散训练效率低，难推广到更大规模 |
| dLLM 后训练 | Dream-Coder、Seed-Diffusion、SPG、DPad、D2F | 多为 7B | SFT/RL/加速三者如何协同、如何扩到千亿，仍是开放问题 |

**缺口**：AR-initialized 扩散模型能否突破 30B 量级、走向前沿规模，此前是开放问题。LLaDA2.0 正面回答：**用 AR 稳定性的同时拿到扩散的并行性**——以 AR checkpoint 为起点，而非从零训练。

---

## 3. 方法详解

LLaDA2.0 的训练范式分两大阶段：**连续预训练（CPT）**把 AR 模型变成 MDLM，**后训练**把它对齐成可用助手。整体遵循"知识继承、渐进适应、效率感知"三原则。

![Figure 2：渐进式训练框架。CPT 阶段用 Warmup–Stable–Decay 调度 block size；右侧为文档级块扩散注意力掩码（MBD/MBC/MOBC + Doc Boundary），把多个 noisy/clean 样本拼成单条序列做向量化前向。](/vibe-reading/images/articles/llada2-scaling-diffusion-language-models-100b/fig-2-training-pipeline.png)

### 3.1 WSD 连续预训练

基座是 AR MoE 模型 Ling-mini-2.0 与 Ling-flash-2.0。关键观察：**AR 模型可视为 block size $L_B=1$ 的 BDLM**（块扩散语言模型）——这给了渐进转换一个统一坐标系。WSD 三阶段如下：

- **Warmup（渐进放大）**：block size 从 $L_B=1$ 逐步增大到 4 → 32 → 64 → 最终 $L_B=4096$。到 4096 时整条序列就是单个块，BDLM 等价于标准 MDLM（全掩码、全局 attention）。每个 block-size 过渡都在中等规模数据上训练，确保平滑适应。
- **Stable（大规模 MDLM 训练）**：到达 $L_B=4096$ 后，attention 中"clean"部分不再需要维护，attention 计算成本大降，数据效率大增。此阶段固定 $L_B=4096$，在大规模语料上深化对扩散动力学的理解，等价于经典 MDLM 设置。
- **Decay（回退到紧凑 BDLM）**：训练后再把 block size 从 4096 逐步降回小值（如 32），把全局知识"蒸馏"进紧凑的块级结构。逐步下降（如 4096→2048）而非骤降，让模型从全局条件平滑过渡到局部条件，保留语义理解的同时重获 BDLM 的推理优势（KV-cache 复用、变长生成）。

> **为什么是 WSD 而非直接切换目标函数？** AR 到扩散存在数据分布鸿沟：左到右生成 vs 双向去噪。直接切换常导致优化不稳与预训练知识崩塌。WSD 通过"逐步扩大感受野"平滑桥接，既保留 AR 先验，又稳步引入扩散式的全局上下文。

### 3.2 文档级注意力掩码

为提升吞吐，训练序列由多个异构文档拼接到固定长度。但全 attention 会让模型跨文档边界形成**伪依赖**，破坏双向建模的语义连贯性。LLaDA2.0 用块级文档掩码约束 attention 严格限于文档内部。

对拼接序列 $x^{full}$（长度 $2L$，由 $x_t$ 与 $x_0$ 组成），掩码 $M\in\{0,1\}^{2L\times 2L}$ 由三种模式组合（见 Figure 2 右侧）：

- **MBD**（block-diagonal）：$x_t$ 内部块对角，块内双向；
- **MBC**（block-causal）：$x_0$ 内部块因果，块可看自身及前序块；
- **MOBC**（offset block-causal）：$x_t$ 块可跨看 $x_0$ 中更早的块，但 $x_0$ 不能回看 $x_t$。

进入 Stable 的 MDLM 阶段后，掩码简化为"同文档才 attend"：

$$
M_{ij} = \begin{cases}1, & i,j \text{ 属于同一文档}\\\\ 0, & \text{otherwise}\end{cases}
$$

论文实测：文档级掩码比 random-length、CART 等技巧更**根本**，在 CPT 中持续取得更优表现。

### 3.3 Top-k Checkpoint Merge

预训练结束后，按验证 perplexity 选出表现最好的 $k$ 个 checkpoint，对其参数做算术平均，得到单一融合模型。该策略源自 WSM scheduler，能集成不同最优/近最优训练态的"知识"，平滑参数景观、缓解过拟合。它**与 EMA 不同**：EMA 是训练中持续平滑，merge 是离线显式挑选并平均多个独立高性能状态，而非仅平滑最后一步。

### 3.4 后训练：SFT、CAP 与 DPO

- **SFT with Block Diffusion**：把扩散目标改为条件于 prompt $c$，模型从 noisy 响应 $x_t$ 重建 clean $x_0$。
  - **mask ratio bandwidth**：标准离散扩散在 $[0,1]$ 全区间采样掩码率，但极端掩码（接近 0 或 1）梯度方差大、学习信号弱。LLaDA2.0 把噪声调度裁剪到 $[\alpha_{\min},\alpha_{\max}]$，聚焦于提供最有信息量梯度的噪声区间。
  - **complementary masking**：从一条 $x_0$ 用一个随机掩码生成 $x_t$，同时用其**逻辑反**生成互补序列 $x'_t$，两者进同一 batch。这保证序列每个位置在成对样本中恰好被见一次未 corrupted，**近乎 100% 数据利用**，消除 token 级采样偏差。[^cm]

[^cm]: 论文脚注：互补掩码在 CPT 中只在 <100B token 语料上有效，数据更多时不再有优势，故仅用于后训练。

- **Confidence-Aware Parallel（CAP）Training**：并行解码受限于模型预测的"置信度"——不够"锋利"就无法激进并行。CAP 引入辅助置信损失 $\mathcal{L}_{\text{conf}}$（受 dParallel 启发），**只对当前步已正确预测的 token**最小化输出分布熵，迫使模型在正确预测上更确定。总损失为 $\mathcal{L}_{\text{SFT}}+\lambda\mathcal{L}_{\text{conf}}$。CAP 在不损质量的前提下显著提升解码效率（见 §6）。

- **DPO**：构造 150 万偏好对（通用知识、数学、指令跟随）。标准 DPO 需要精确 log-likelihood，但 dLLM 的条件似然不可解析，故用 **Block Diffusion ELBO** $\mathcal{B}_{\text{BDLM}}$ 替代（见 §4）。参考模型由 post-SFT 模型初始化并冻结，$\beta=0.1$。

- **推理**：每个扩散步采样一个块，条件于已采样的前序块。采用**混合接受策略**：先接受所有采样概率超过阈值（0.95）的 token；若数量不足，触发低置信回退，接受固定数量的最高概率 token，保证生成稳步推进。

---

## 4. 关键公式解读

**BDLM 训练目标**（Warmup 与 Decay 阶段，块级重建）：

$$
\mathcal{L}_{\text{BDLM}}(\theta) = -\mathbb{E}_{t,x_0,x_t}\left[\underbrace{\frac{\alpha'_t}{1-\alpha_t}}_{\text{扩散时间权重}}\sum_{k=1}^{K}\sum_{i=1}^{L_B}\mathbf{1}[x^i_{t,k}=\langle M\rangle]\log p_\theta\!\left(x^i_{0,k}\mid x_{0,<k},\,x_{t,k}\right)\right]
$$

其中 $K=L_{\text{total}}/L_B$ 是块数，$L_B$ 是 block size，$\mathbf{1}[\cdot]$ 保证只对被掩码位置预测，$-\alpha'_t/(1-\alpha_t)$ 是扩散导出时间权重，条件 $x_{0,<k}$ 是前序 clean 块（块间 AR），$x_{t,k}$ 是当前 noisy 块（块内扩散）。

**MDLM 目标**（Stable 阶段，$K=1$，整条序列单块）：

$$
\mathcal{L}_{\text{MDLM}}(\theta) = -\mathbb{E}_{t,x_0,x_t}\left[\frac{\alpha'_t}{1-\alpha_t}\sum_{i=1}^{L}\mathbf{1}[x^i_t=\langle M\rangle]\log p_\theta(x^i_0\mid x_t)\right]
$$

**CAP 总损失**（SFT + 置信度）：

$$
\mathcal{L}(\theta) = \mathcal{L}_{\text{SFT}}(\theta) + \lambda\,\mathcal{L}_{\text{conf}}(\theta)
$$

**Block Diffusion ELBO**（用于 DPO，替代不可解析的条件 log-likelihood）：

$$
\mathcal{B}_{\text{BDLM}}(\theta, x\mid c) = \mathbb{E}_{t,x_t}\left[\frac{\alpha'_t}{1-\alpha_t}\sum_{k=1}^{K}\sum_{i=1}^{L_B}\mathbf{1}[x^i_{t,k}=\langle M\rangle]\log p_\theta(x^i_k\mid c, x_{<k}, x_{t,k})\right]
$$

**DPO 损失**（最大化 policy 相对 reference 的 ELBO 优势边际）：

$$
\mathcal{L}_{\text{DPO}}(\theta) = -\mathbb{E}_{(c,x_w,x_l)\sim\mathcal{D}}\left[\log\sigma\!\left(\beta\left[\Delta\mathcal{B}(x_w\mid c) - \Delta\mathcal{B}(x_l\mid c)\right]\right)\right]
$$

其中 $\Delta\mathcal{B}(x\mid c)=\mathcal{B}_{\text{BDLM}}(\theta,x\mid c)-\mathcal{B}_{\text{BDLM}}(\theta_{\text{ref}},x\mid c)$ 是 policy 对 reference 的 ELBO 优势。这套把 DPO 从 AR 的"精确似然"改写成扩散的"ELBO 估计 + 单样本 Monte Carlo"，是把偏好对齐迁移到 dLLM 的关键一步。

---

## 5. 实验设置

- **评测套件**：共 47 个基准，分五维——知识（MMLU/MMLU-Pro/GPQA/ARC/CMMLU/C-Eval 等）、推理（SQuAD 2.0、DROP、BBH、MuSR、HellaSwag 等）、编码（HumanEval/MBPP/MultiPL-E/LiveCodeBench/Spider 等）、数学（GSM8K/MATH/AIME 2025/OlympiadBench 等）、智能体与对齐（BFCL v3、IFEval、CodeIF-Bench 等）。
- **基线**：对比强开源 AR 模型。mini 对 Qwen3-8B、Ling-mini-2.0；flash 对 Qwen3-30B-A3B-Instruct-2507、Ling-flash-2.0。
- **LLaDA2.0 推理配置**：temperature 0.0、block size 32、解码阈值 0.95。
- **复现性**：两个模型（mini 16B、flash 100B，均为 MoE）已在 HuggingFace 开源，代码用 dFactory（后训练）与 dInfer（推理）。

---

## 6. 实验结果

![Figure 1：LLaDA2.0-flash 在 8 个代表基准上的主结果（MMLU-Pro、HellaSwag、HumanEval、AIME 2025、BFCL_Live、Spider、MBPP、LiveCodeBench v6）。](/vibe-reading/images/articles/llada2-scaling-diffusion-language-models-100b/fig-1-main-results.png)

### 6.1 主结果

**LLaDA2.0-mini（16B）** 平均 64.34，逼近 Ling-mini-2.0（65.77），超过 Qwen3-8B（63.42）。关键信号：在推理、编码、数学上已优于规模可比的 AR 同门，如 SQuAD 2.0 86.50（Ling 75.56）、IFEval 80.78（Ling 76.16）、HumanEval 86.59。

**LLaDA2.0-flash（100B）** 平均 73.18，与 Qwen3-30B-A3B-Instruct-2507（73.60）持平、超过 Ling-flash-2.0（72.15）。在结构化生成任务上展现清晰优势：

| 基准 | LLaDA2.0-flash | Qwen3-30B-A3B-Inst | Ling-flash-2.0 |
|---|---|---|---|
| HumanEval | **94.51** | 93.29 | 85.98 |
| MBPP | **88.29** | 86.65 | 85.01 |
| MultiPL-E | **74.87** | 70.67 | 65.76 |
| BFCL v3（智能体） | **75.43** | 73.19 | 67.57 |
| AIME 2025 | 60.00 | 61.88 | 55.89 |
| LiveCodeBench | 42.29 | 41.63 | 44.11 |

> **关键发现**：随规模增大，扩散架构在结构化生成（编码、工具使用）上的优势愈发明显——这暗示扩散范式在 agentic LLM 时代可能打开一扇新门。

### 6.2 推理速度与 CAP

![Figure 3：左/中为 LLaDA2.0-flash 有无 CAP 的平均分与 Tokens-Per-Forward（TPF）；右为 4 个代码/数学基准上的 Tokens-Per-Second（TPS），对比同规模 AR。](/vibe-reading/images/articles/llada2-scaling-diffusion-language-models-100b/fig-3-cap-inference-speed.png)

CAP 训练在不损质量的前提下大幅提升解码效率：LLaDA2.0-flash-CAP 达 **535 TPS**，标准版 383 TPS，相对 AR 基线（Ling-flash-2.0 256、Qwen3-30B 237 TPS）**最高 2.1× 加速**。验证了"置信度→激进并行解码"的因果链。

---

## 7. 消融与分析

### 7.1 推理超参权衡

![Figure 4：Score/TPF 随 denoising threshold 与 block size 变化（LLaDA2.0-mini 子集）。](/vibe-reading/images/articles/llada2-scaling-diffusion-language-models-100b/fig-4-inference-hyperparams.png)

- **denoising threshold**：固定 block size 32，阈值 0.95 质量最高（70.15 分，2.55 TPF）；降到 0.85 速度峰值（3.31 TPF）但质量掉到 67.90，不可接受。
- **block size**：固定阈值 0.95，size 16 质量最高（70.26）但最慢（2.44 TPF）；size 32 速度升到 2.55 TPF 且质量仅微降（70.15）；size 64 两方面都更差。
- **结论**：阈值 0.95 + block size 32 是质量与吞吐的最佳平衡，主评测配置有据可依。

### 7.2 上下文长度

![Figure 5：RULER 基准上 4k–64k 上下文长度的表现。](/vibe-reading/images/articles/llada2-scaling-diffusion-language-models-100b/fig-5-ruler-context-length.png)

原生 32k 窗口内两模型均稳健，flash 在 4k–32k 全程 >93；mini 从 4k 的 93.29 降到 32k 的 83.94。用 YaRN（缩放因子 2.0）外推到 64k 可用，但有可预期的性能下降——长上下文外推与精度存在权衡。

### 7.3 训练与推理基础设施

![Figure 6：并行策略总览（DP/PP/TP/CP/EP）。](/vibe-reading/images/articles/llada2-scaling-diffusion-language-models-100b/fig-6-parallelism-overview.png)

- **预训练**：Megatron-LM 后端，组合 DP/PP/TP/CP/EP。掩码 token 在单个 model-parallel rank 生成后广播，保证一致性；attention 用 cuDNN 后端，相对 TransformerEngine 非融合实现**端到端 1.3× 加速、attention 层 90% 显存节省**；对块扩散注意力掩码用 zig-zag 分区平衡 CP 组负载。
- **数值稳定性**：AR→扩散过渡期高掩码率下易梯度爆炸——AR 训练中掩码 token embedding 被置零、对应权重逐渐衰减到零。直接随机重初始化会扰乱其它训练好的参数、引发灾难性遗忘；LLaDA2.0 改为在训练初始迭代对每个掩码 token 的 embedding 输出**加独立高斯噪声**，维持其 L2 范数避免梯度爆炸，同时保留预训练知识。
- **后训练**：dFactory（基于 VeOmni 分布式框架），DP+EP，并用类 CPT 的数据 packing 提升吞吐。
- **推理**：dInfer 原生支持扩散 LLM 推理，并适配块扩散以复用 KV-cache；同时把块扩散推理支持合入 SGLang，享受为 AR 设计的系统级优化。

---

## 8. 总结与展望

**贡献总结**：LLaDA2.0 给出了一套把 AR 模型系统转换为 masked diffusion 模型、并扩到 100B 的完整配方——WSD 三阶段 CPT、文档级注意力掩码、Top-k checkpoint merge、SFT（互补掩码 + mask ratio bandwidth）、CAP、ELBO-DPO。验证了扩散语言模型在前沿规模上可行，且与 AR 同规模模型竞争，在编码、数学、智能体等结构化领域甚至反超。

**局限性（批判性）**：
- 知识密集基准（GPQA、SciBench、PHYBench）仍明显落后 AR 同门——AR→扩散的转换未必能无损保留所有知识，尤其深层科学推理。
- 长上下文原生仅 32k，64k 靠 YaRN 外推有掉点；与 AR 长文本能力仍有差距。
- HARDmath2 等极端数学基准上 mini/flash 都很低（0.47/4.27），前沿数学能力未到顶。
- 互补掩码只在 <100B token 时有效，说明其扩展性有上限，机制仍需厘清。
- 论文未报告完整 scaling law 曲线，"100B 是终点还是可继续外推"仍待验证。

**未来方向（创造性）**：
- *弥补缺陷*：探索更温和的 AR→扩散知识保留机制（如分层解冻、参数空间插值），缩小知识密集任务差距；把原生上下文扩到更长。
- *新型方案*：把 WSD 思路推广到连续隐空间扩散（如 Cola-DLM 的 latent prior transport），或混合 block-diffusion 与连续扩散，兼得效率与全局语义。
- *减少约束*：进一步推大参数、把 test-time scaling 与扩散的迭代去噪结合（扩散天然多步，可作 test-time compute 载体）、探索 RL/thinking 范式下的扩散推理。

> 一句话收尾：LLaDA2.0 把"扩散 vs AR"从"小规模 vs 大规模"的对立，改写成了"在前沿规模上共存互补"——并行解码与结构化生成，是它为 agentic 时代押注的两张牌。
