---
title: "LLaDA2.1: Speeding Up Text Diffusion via Token Editing"
source:
  type: "论文解读"
  project: "Ant Group"
  url: "https://arxiv.org/abs/2602.08676"
  pdf: "/vibe-reading/papers/llada2-1-speeding-up-text-diffusion-token-editing.pdf"
date: "2026-07-28T15:30:00+08:00"
category: [AI, Models, Ant Group, Papers]
tags: ["Diffusion Language Model", "Token Editing", "Mask-to-Token", "Token-to-Token", "EBPO", "Reinforcement Learning", "Parallel Decoding", "MoE"]
description: "目的：打破扩散语言模型速度与质量的取舍。手段：在 M2T 上编织 T2T 编辑 + 双阈值可配置解码（S/Q 模式）+ 首个大规模 dLLM RL（EBPO）。结论：100B 编码达 892 TPS，Q 模式反超 2.0。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/llada2-1-speeding-up-text-diffusion-token-editing.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LLaDA2.1: Speeding Up Text Diffusion via Token Editing](https://arxiv.org/abs/2602.08676) · **作者** Tiwei Bie 等（Ant Group / Zhejiang University / 西湖大学 / Southern University of Science and Technology）· **发表** arXiv 2602.08676v3, 2026-02 · **解读** 2026-07-28

---

## 1. 论文概览

**一句话**：LLaDA2.1 不靠堆参数，而是给扩散语言模型装上"**先打草稿、再回头改**"的能力——把 Token-to-Token（T2T）编辑织进传统 Mask-to-Token（M2T）方案，用一个双阈值可配置解码把"快"与"准"解耦，并配套首个面向 dLLM 的大规模强化学习框架。

- **任务**：通用语言建模与指令跟随（知识、推理、编码、数学、智能体五大维度，33 个基准）。
- **核心创新**：① **Editable State Evolution**——在吸收态扩散之外引入"编辑"操作，由双概率阈值 $\tau_{\text{mask}}$、$\tau_{\text{edit}}$ 控制；② **S/Q 双模式**——Speedy Mode 激进降低 M2T 阈值、靠 T2T 兜底修正；Quality Mode 保守阈值保精度；③ **EBPO**——用 ELBO 代理不可解析的序列似然，配合向量化似然估计，把策略梯度 RL 扩到 dLLM 的长上下文与大规模。
- **结果**：模型规模与 2.0 持平（mini 16B / flash 100B，MoE），数据改动极小，却换来闪电级速度——flash 在 HumanEval+ 上 892 TPS；Q 模式平均分 73.54 反超 LLaDA2.0（72.43）与 Qwen3-30B（73.09）。

**take-home**：可编辑性不只是"纠错机制"，更是**加速并行解码的根本杠杆**——这让 dLLM 第一次把"极快"与"高质量"放在同一套可配置框架里。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

While LLaDA2.0 showcased the scaling potential of 100B-level block-diffusion models and their inherent parallelization, the delicate equilibrium between decoding speed and generation quality has remained an elusive frontier. Today, we unveil LLaDA2.1, a paradigm shift designed to transcend this trade-off. By seamlessly weaving Token-to-Token (T2T) editing into the conventional Mask-to-Token (M2T) scheme, we introduce a joint, configurable threshold-decoding scheme. This structural innovation gives rise to two distinct personas: the Speedy Mode (S Mode), which audaciously lowers the M2T threshold to bypass traditional constraints while relying on T2T to refine the output; and the Quality Mode (Q Mode), which leans into conservative thresholds to secure superior benchmark performances with manageable efficiency degrade. Furthering this evolution, underpinned by an expansive context window, we implement the first large-scale Reinforcement Learning (RL) framework specifically tailored for dLLMs, anchored by specialized techniques for stable gradient estimation. This alignment not only sharpens reasoning precision but also elevates instruction-following fidelity, bridging the chasm between diffusion dynamics and complex human intent. We culminate this work by releasing LLaDA2.1-Mini (16B) and LLaDA2.1-Flash (100B). Across 33 rigorous benchmarks, LLaDA2.1 delivers strong task performance and lightning-fast decoding speed. Despite its 100B volume, on coding tasks it attains an astounding 892 TPS on HumanEval+, 801 TPS on BigCodeBench, and 663 TPS on LiveCodeBench.

> **译：** 虽然 LLaDA2.0 展示了 100B 级块扩散模型及其内在并行化的扩展潜力，但解码速度与生成质量之间的微妙平衡始终是一个难以企及的前沿。今天，我们推出 LLaDA2.1——一种旨在超越这一取舍的范式转变。通过将 Token-to-Token（T2T）编辑无缝织入传统的 Mask-to-Token（M2T）方案，我们引入了一种联合的、可配置的阈值解码方案。这一结构性创新催生了两种不同人格：Speedy Mode（S 模式）大胆降低 M2T 阈值以绕过传统约束，同时依赖 T2T 精炼输出；Quality Mode（Q 模式）则采用保守阈值，以可接受的效率下降换取更优的基准表现。在此演进基础上，依托广阔的上下文窗口，我们实现了首个专门为 dLLM 定制的大规模强化学习（RL）框架，以稳定梯度估计的专门技术为锚。这一对齐不仅锐化了推理精度，还提升了指令遵循的保真度，弥合了扩散动力学与复杂人类意图之间的鸿沟。我们以发布 LLaDA2.1-Mini（16B）和 LLaDA2.1-Flash（100B）作为本工作的顶点。在 33 个严谨基准上，LLaDA2.1 交付了强大的任务表现与闪电般的解码速度。尽管体量达 100B，在编码任务上它于 HumanEval+ 达到惊人的 892 TPS、BigCodeBench 801 TPS、LiveCodeBench 663 TPS。

</details>

---

## 2. 研究背景

dLLM 用并行解码与全双向上下文挑战 AR，但并行生成天然带**暴露偏差（Exposure Bias）**：模型条件于自身不完美的预测，错误会累积。更糟的是，dLLM 一旦在并行解码中出错，后续步骤会**愈发保守**，显著拖慢生成——这与 AR 能靠长链思维自纠错形成对比。

标准**吸收态（absorbing-state）**框架是这一困境的根源：它强制从 `[MASK]` 到固定 token 的**刚性、单调**转移——一旦某位置被"解锁"成具体 token，就**不可再改**（Error Locked）。若早期并行解码填错了一个词，它就被永久冻结，污染后续生成。

| 范式 | 机制 | 局限 |
|---|---|---|
| 吸收态 M2T | mask → token，单调不可逆 | 已解锁 token 锁死，错误无法回溯 |
| 置信度重掩码 | 用置信度决定哪些位置重掩 | 仍是 mask→token 单向，不直接改 token |
| 外部引导模型 | 引入外部模型修正 | 额外模型开销，非内生能力 |
| 广义插值扩散 | 超越吸收态，支持非单调转移 | 缺乏面向大模型的可配置解码与训练范式 |

**缺口**：如何在**不增加模型规模**的前提下，让 dLLM 能"先草拟、再纠错"，把速度与质量从零和博弈变成可配置连续体。LLaDA2.1 正面回答。

---

## 3. 方法详解

LLaDA2.1 的核心是 **"Draft-and-Edit"（草拟-编辑）** 范式：在标准扩散的去噪过程中引入一个"编辑"操作，让模型能**回溯修正**并行生成中引入的错误。

![Figure 2：训练与推理框架总览。CPT/SFT 阶段统一使用 M2T 与 T2T 的混合目标 + 多轮前向（MTF）；RL 阶段用 SGLang 双模式做 rollout，混合 M2T/T2T 轨迹进 EBPO 策略更新。](/vibe-reading/images/articles/llada2-1-speeding-up-text-diffusion-token-editing/fig-2-training-inference-framework.png)

### 3.1 可编辑状态演化

论文定义时间步 $t$ 的两个**活跃更新集**：

- **Unmasking Set（解掩集）$\Gamma_t$**：仍是 `[MASK]` 且 top-candidate 置信度超过 $\tau_{\text{mask}}$ 的位置——执行"解掩"动作（填入最高概率 token）；
- **Editing Set（编辑集）$\Delta_t$**：当前 token 与新 argmax 不同、且新 argmax 置信度超过 $\tau_{\text{edit}}$ 的位置——执行"替换"动作（改写为更合适的 token）。

转移算子严格在 $\Gamma_t \cup \Delta_t$ 上施加更新（见 §4 公式 1–3）。两个阈值 $\tau_{\text{mask}}, \tau_{\text{edit}} \in [0,1]$ 配置解码动力学，由此衍生两种人格：

- **Speedy Mode（S Mode）**：**激进降低** $\tau_{\text{mask}}$，接受低置信 token 快速出草稿，靠 T2T 编辑兜底修正。吞吐优先。
- **Quality Mode（Q Mode）**：**保守**阈值，最大化推理严谨度。质量优先，效率可接受地下降。

> **关键洞察**：可编辑性把"延迟 vs 保真"的刚性取舍变成了**用户可配置的连续体**。因为模型能事后纠错，所以初始 M2T 阶段可以放心降低置信阈值而不崩质量——编辑能力因此既是纠错机制，也是加速并行解码的**根本杠杆**。

![Figure 1：传统 M2T（吸收态，错误锁死）vs 可编辑 M2T+T2T（草拟-迭代精炼）。以赫拉克利特名言 "No man ever steps in the same river twice" 为例：M2T 因 early commit 把 walks 冻结成误引；T2T 在新上下文出现后触发修正（p(steps|x_t) > ω_edit），把 walks 替换为 steps，恢复正确引文。](/vibe-reading/images/articles/llada2-1-speeding-up-text-diffusion-token-editing/fig-1-m2t-t2t-paradigm.png)

### 3.2 训练对齐：M2T & T2T 混合目标

要让模型在推理时既会草拟又会编辑，训练必须同时暴露这两种能力。LLaDA2.1 在 CPT 与 SFT 全程采用**统一的 M2T & T2T 混合目标**：

- **Drafting Stream（M2T）**：在掩码位置预测正确 token，建立基础草拟能力；
- **Editing Stream（T2T）**：从随机噪声扰动中恢复原 token（纠错），赋予识别并改写瑕疵的能力。

此外用 **Multi-turn Forward（MTF）**数据增强，让模型接触更丰富的编辑场景。从 CPT 到 SFT 一致施加双流监督，使 LLaDA2.1 在单一参数空间内同时具备"快起草者"与"精编辑者"两种人格。

### 3.3 强化学习：EBPO

策略梯度方法用于扩散模型的根本障碍：序列级 log-likelihood $\log \pi_\theta(x)$ 不可解析，而它是计算策略更新的关键。已有 RL 工作（SPG、TraceRL、ESPO）受高方差与高算力困扰，长期限于小规模。

LLaDA2.1 用 **ELBO-based Block-level Policy Optimization（EBPO）** 突破：以 ELBO 作为精确似然的原则性代理，并实现**向量化似然估计（Vectorized Likelihood Estimation）**并行化界限计算，获得数量级加速，从而把 dLLM 的 RL 扩到前所未有的上下文长度与训练规模。EBPO 显式支持 T2T 与 M2T 两种模式（见 §4 公式 4–5）。

### 3.4 推理：阈值解码 + 编辑 + MBE

- **单块编辑**：在一个块内，阈值约束下生成 token，并在块定稿前施加局部编辑修正中间输出。
- **Multiple Block Editing（MBE）**：允许模型基于新解码块的内容，**回访并修订此前已生成的块**——跨块迭代精炼，修正局部错误、提升全局一致性。

---

## 4. 关键公式解读

**解掩集 $\Gamma_t$**（mask → token，置信度超过 $\tau_{\text{mask}}$）：

$$
\Gamma_t = \left\{i \;\middle|\; x^i_t = \langle M\rangle \;\text{and}\; p_\theta(v^i_t \mid x_t) > \tau_{\text{mask}}\right\}
$$

**编辑集 $\Delta_t$**（当前 token 与新 argmax 不同且置信度超过 $\tau_{\text{edit}}$）：

$$
\Delta_t = \left\{i \;\middle|\; x^i_t \neq v^i_t \;\text{and}\; p_\theta(v^i_t \mid x_t) > \tau_{\text{edit}}\right\}
$$

其中 $v^i_t = \arg\max_v p_\theta(v \mid x_t)$ 是 top-candidate。**转移算子**严格在并集上更新：

$$
x^i_{t-1} = \begin{cases} v^i_t & \text{if } i \in \Gamma_t \cup \Delta_t, \\ x^i_t & \text{otherwise.} \end{cases}
$$

**EBPO 裁剪代理目标**（$\rho$ 为概率比，$\hat{A}$ 为优势估计）：

$$
J_{\text{EBPO}}(\theta) = \mathbb{E}_{x,y\sim\pi_{\theta_{\text{old}}}}\!\left[\min\!\left(\rho(y\mid x)\hat{A},\; \text{clip}\!\left(\rho(y\mid x),\, 1-\epsilon_{\text{low}},\, 1+\epsilon_{\text{high}}\right)\hat{A}\right)\right]
$$

**对数概率比的 ELBO 近似**（$z_n = y_{t_n} \oplus y_0$ 为复合输入，$M$ 为块因果掩码，单次前向聚合所有块贡献）：

$$
\log \rho(y\mid x) \approx \sum_{n=1}^{N} w_n \sum_{b=1}^{B}\left(\log p_\theta(y_b \mid z_n, x; M) - \log p_{\theta_{\text{old}}}(y_b \mid z_n, x; M)\right)
$$

> 第一个求和 $\sum_n$ 遍历离散时间步，第二个 $\sum_b$ 在每个时间步的**单次前向**内聚合所有块级条件概率——这是把 RL 扩到长上下文扩散生成的计算可行性的关键。

---

## 5. 实验设置

- **评测套件**：33 个基准，分五维——知识（MMLU-Pro、GPQA、C-Eval、PHYBench、TriviaQA）、推理（SQuAD 2.0、DROP、BBH/BBEH、MuSR、ZebraLogic、HellaSwag 等）、编码（HumanEval+、MBPP+、MultiPL-E、LiveCodeBench、BigCodeBench、CRUXEval、Spider、BIRD）、数学（AIME 2025、OlympiadBench、Omni-MATH、GSM-Plus、CMATH）、智能体与对齐（BFCL v3、IFEval、Nexus FC）。
- **基线**：Qwen3-8B/30B-A3B、Ling-mini/flash-2.0、以及前作 LLaDA2.0。
- **指标**：扩散模型报 Score | TPF（tokens per forward，越高越快）；AR 模型 TPF 恒为 1，只报 Score。
- **复现**：训练沿用 LLaDA2.0 的 dFactory 基础设施（+ MTF 专用优化）；RL 扩展 AReaL 框架，ASystem 做分布式编排，定制版 SGLang 做 rollout；推理用定制版 SGLang + Alpha-MoE 超核 + per-block FP8 量化。

---

## 6. 实验结果

![Figure 3：九个基准上的 TPS 对比（mini 左 / flash 右），LLaDA2.1 S 模式（含量化）vs LLaDA2.0/Ling/Qwen3。](/vibe-reading/images/articles/llada2-1-speeding-up-text-diffusion-token-editing/fig-3-tps-comparison.png)

### 6.1 主结果（flash，Table 1）

| 基准 | Qwen3-30B | Ling-flash | LLaDA2.0 (Score\|TPF) | 2.1 S (Score\|TPF) | 2.1 Q (Score\|TPF) |
|---|---|---|---|---|---|
| **Average** | 73.09 | 71.52 | 72.43 \| 3.08 | 72.34 \| **5.93** | **73.54** \| 3.64 |
| HumanEval+ | 87.88 | 87.58 | 88.41 \| 6.45 | 89.63 \| 13.81 | 89.63 \| 9.18 |
| AIME 2025 | 61.88 | 55.89 | 60.00 \| 4.57 | **63.33** \| 5.36 | **63.33** \| 3.46 |
| LiveCodeBench | 46.42 | 52.48 | 42.51 \| 4.23 | 44.05 \| 6.48 | **45.37** \| 3.80 |
| BFCL v3 | 73.41 | 67.69 | 74.94 \| 4.87 | 74.86 \| 9.24 | **75.61** \| 6.76 |
| TriviaQA | 65.61 | 69.76 | 66.88 \| 1.94 | 72.55 \| 4.30 | **72.93** \| 2.92 |
| BBExtraHard | 37.80 | 23.24 | 27.86 \| 4.60 | 33.51 \| 5.04 | **35.77** \| 3.17 |

> **关键发现**：① **Q 模式全面反超 2.0**——平均 73.54 > 72.43，且在 AIME、LiveCodeBench、TriviaQA、BBExtraHard 等上明显提升；② **S 模式牺牲极小质量换近 2× TPF**（平均 TPF 5.93 vs 2.0 的 3.08）；③ 即便 S 模式平均分略降，在结构化任务（HumanEval+、AIME）上仍**超过 2.0**。编辑能力让"激进草拟"不再以质量崩塌为代价。

### 6.2 极致速度（Table 3，S 模式）

| 基准 | flash w/o quant (TPS) | flash w/ quant (TPS \| ΔScore) | mini w/ quant (TPS \| ΔScore) |
|---|---|---|---|
| HumanEval+ | 746.66 | **891.74** \| -3.04 | **1586.93** \| -0.61 |
| BigCodeBench | 691.14 | 801.48 \| +1.06 | 1307.45 \| -0.09 |
| LiveCodeBench | 571.60 | 663.39 \| -1.76 | 1102.92 \| +1.98 |
| IFEval（最慢） | 219.37 | 248.25 \| +1.48 | 365.52 \| -1.29 |
| PrOntoQA（推理） | 770.88 | 912.16 \| -1.00 | 938.93 \| -1.50 |

- flash S 模式 + 量化在 HumanEval+ 峰值 **891.74 TPS**，mini 达 **1586.93 TPS**。
- **速度因领域差异显著**：编码最快、指令遵循最慢——论文推测与模型对结构化数据的偏好或训练数据分布特性有关。

### 6.3 MBE 消融（Table 4）

| 指标 | flash w/o MBE | flash w/ MBE | mini w/o MBE | mini w/ MBE |
|---|---|---|---|---|
| Average | 70.69 \| 5.82 | **72.67** \| 5.14 | 57.63 \| 5.25 | **58.24** \| 4.59 |
| AIME 2025 | 63.33 | **70.00** | 36.67 | 36.67 |
| ZebraLogic | 84.20 | **88.20** | 68.50 | 70.00 |
| LiveCodeBench | 44.05 | **46.48** | 28.85 | 29.74 |

MBE 在推理与编码上增益尤为明显（flash AIME +6.67、ZebraLogic +4.0），以适度 TPF 下降为代价——跨块迭代精炼有效修正局部错误、提升全局一致性。

---

## 7. 总结与展望

**贡献总结**：LLaDA2.1 证明了一个反直觉的事实——**不堆参数、不动数据规模**，仅靠"可编辑解码 + 双阈值可配置 + 大规模 RL"这套组合拳，就能让 dLLM 既快又准。T2T 编辑把吸收态扩散的"一次性、不可逆"变成"草拟-精炼"的迭代过程；EBPO 让 RL 第一次能稳定地训进百亿级 dLLM；S/Q 双模式把速度-质量取舍交还给用户按领域配置。

**局限性（批判性）**：
- 速度-精度取舍**仍未消除**，且领域差异大：S 模式在代码/数学上几乎无损，但在通用对话中可能产生不理想输出——需按领域调阈值。
- dLLM 的高并行度伴随**更高错误率**（比 AR），错误降低模型后续推理置信度、反而拖慢——及时编辑纠错是维持速度的关键，但编辑能力研究仍处早期。
- 激进降低 $\tau_{\text{mask}}$ 会生成"粗糙草稿"，自纠正只能**部分**缓解独立并行采样导致的 n-gram 重复（"口吃"瑕疵）；草拟速度与初始结构质量的平衡仍是运营前沿。
- BigCodeBench 上 2.1 S/Q 模式均低于 2.0——编辑范式并非在所有基准上单调受益。
- LLaDA2.1 仍处实验阶段，罕见 edge case 可能出现。

**未来方向（创造性）**：
- *弥补缺陷*：把编辑能力**集成进强化学习**（论文明确指出这是未来方向），让 RL 直接奖励"好的编辑"而非仅奖励终态；研究编辑能力与领域偏好（代码 vs 对话）的内在关联。
- *新型方案*：探索 T2T 编辑与 test-time scaling 的结合——扩散天然多步迭代，编辑让每步都能回溯，是 test-time compute 的天然载体。
- *减少约束*：进一步推大上下文窗口与参数规模，把 EBPO 扩到更长序列与更强模型；把"思考范式"（thinking）引入 dLLM，让扩散的多步去噪成为显式推理链。

> 一句话收尾：LLaDA2.1 把 dLLM 的叙事从"能跑多大"推进到"能多快、能多灵活"——可编辑性，是它为下一阶段下的注脚。
