---
title: "Pair-In, Pair-Out: Latent Multi-Token Prediction for Efficient LLMs"
source:
  type: "论文解读"
  project: "RedAI"
  url: "https://arxiv.org/abs/2605.27255"
  pdf: "/vibe-reading/papers/pipo-pair-in-pair-out-latent-multi-token-prediction.pdf"
date: "2026-07-27"
category: [AI, Infra, Inference, Papers]
tags: ["LLM Inference", "Multi-Token Prediction", "Latent Compression", "Speculative Decoding", "On-Policy Distillation", "Reasoning"]
description: "目的：统一输入侧压缩与输出侧多 token 预测并去掉昂贵 verifier。手段：compressor/MTP 镜像对称的 pair-in/pair-out 接口 + 用 OPD 教师分布免费训练的轻量 confidence head 替代 verifier。结论：pass@4 提升 +7.15pp，TTFT 2.64×、TPOT 2.07× 加速。"
readingTime: "15 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/pipo-pair-in-pair-out-latent-multi-token-prediction.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Pair-In, Pair-Out: Latent Multi-Token Prediction for Efficient LLMs](https://arxiv.org/abs/2605.27255) · **作者** Wenhui Tan, Minghao Li, Xiaoqian Ma, Siqi Fan, Xiusheng Huang, Liujie Zhang, Ruihua Song, Weihang Chen（中国人民大学 / 小红书 AI 平台 / 电子科大 / 中科院自动化所）· **发表** arXiv 2605.27255v2, 2026-05 · **项目** GitHub.com/RedAI-Infra/PIPO · **解读** 2026-07-27

---

## 1. 论文概览

**一句话**：PIPO 把"输入侧 latent 压缩"和"输出侧多 token 预测（MTP）"看成围绕 backbone 的一对镜像操作——compressor 把两个输入 token 折成一个 latent，MTP head 把一个 hidden state 展开成一个额外输出 token，合起来既是 pair-in 又是 pair-out，每步既砍半输入长度又翻倍输出；再用一个轻量 confidence head（靠 on-policy distillation 的教师分布"免费"训练）替代 speculative decoding 里昂贵的 verifier 前向。

- **任务**：高效 LLM 推理解码。长链式推理（long CoT）让自回归解码成为现代推理 LLM 的主要成本瓶颈——每步一个 token，每步依赖前面所有 token。
- **核心痛点**：现有加速方法分两条独立路线——输出侧（speculative decoding / MTP）每步多出 token 但需昂贵 verifier 验证；输入侧（latent 压缩）缩有效序列长度但不改变每步输出数。两条线割裂，且输出侧加速仍受 verifier 前向开销封顶。
- **核心方法**：两个观察 → (1) compressor 与 MTP head 是镜像，组合得 pair-in/pair-out 对称接口；(2) OPD 的教师与 speculative decoding 的 verifier 扮演同一角色，于是 confidence head 能用拒绝采样接受概率 `min(p_t/p_s, 1)` 当免费标签训练，推理时替代 verifier。
- **take-home**：把"压缩"和"展开"配成一对镜像，把"蒸馏教师"和"验证器"认成同一个角色——两道抽象对应画对，输入输出两侧的收益同时拿到，verifier 这个反复推理成本被摊成一次性训练信号。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Long chain-of-thought reasoning has made autoregressive decoding the dominant inference cost of modern large language models. Existing methods target either the input side (latent compression) or the output side (speculative decoding and multi-token prediction, MTP), but the two lines of work have been pursued independently. Moreover, output-side methods must incur an expensive verifier pass to validate the unreliable draft tokens predicted by MTP. To address these issues, we propose Pair-In, Pair-Out (PIPO), which unifies both sides by viewing a latent compressor and an MTP head as mirror-image operations: the compressor folds two input tokens into one latent representation, while the MTP head unfolds one hidden state into one additional output token. To remove the verifier cost without sacrificing reliability, PIPO trains a lightweight confidence head that decides whether draft tokens should be accepted. We observe that On-Policy Distillation (OPD) naturally matches the rejection-sampling criterion of speculative decoding, so the confidence head can be trained alongside OPD with negligible extra cost. Experiments on AIME 2025, GPQA-Diamond, LiveCodeBench v6, and LongBench v2 with Qwen3.5-4B and 9B backbones show that PIPO improves pass@4 over regular decoding by up to +7.15 points, while delivering up to 2.64× first-token-latency and 2.07× per-token-latency speedups.

> **译：** 长 CoT 推理使自回归解码成为现代 LLM 的主要推理成本。现有方法或攻输入侧（latent 压缩），或攻输出侧（speculative decoding 与多 token 预测 MTP），但两条线各自为战。且输出侧方法必须付出昂贵 verifier 前向以验证 MTP 预测的不可靠 draft token。为此我们提出 PIPO，把 latent compressor 与 MTP head 看作镜像操作来统一两侧：compressor 把两个输入 token 折成一个 latent 表示，MTP head 把一个 hidden state 展开成一个额外输出 token。为在不牺牲可靠性的前提下消除 verifier 成本，PIPO 训练一个轻量 confidence head 决定 draft 是否被接受。我们观察到 on-policy distillation（OPD）天然匹配 speculative decoding 的拒绝采样准则，故 confidence head 可与 OPD 一同训练且额外开销可忽略。在 AIME 2025、GPQA-Diamond、LiveCodeBench v6、LongBench v2 上用 Qwen3.5-4B/9B 的实验表明，PIPO 相比常规解码 pass@4 最多提升 +7.15 分，同时 TTFT 加速 2.64×、TPOT 加速 2.07×。

</details>

---

## 2. 研究背景

### 2.1 长推理的成本瓶颈

LLM 作为推理器（reasoner）在数学、代码任务上先生成一段中间推理 token 再给答案。这种范式提升精度，但也让推理昂贵：标准自回归解码每步一个 token、每步依赖前面所有 token，长推理轨迹直接转化为长解码延迟。**每 token 成本成为现代推理 LLM 的主要推理瓶颈。**

### 2.2 两条割裂的加速路线

| 路线 | 代表方法 | 做法 | 局限 |
| --- | --- | --- | --- |
| **输出侧** | speculative decoding（Leviathan 2023）、EAGLE、MTP | 每步多预测 token，用大模型 verifier 拒绝采样验证 | 每步都要跑一遍大 backbone verifier，长上下文下 verifier 成本可能吃掉多 token 的增益 |
| **输入侧** | Coconut、Soft Thinking、CoLaR | 把多 token 压成连续 latent 表示，缩有效序列长度 | 只改变模型关注什么，不改变每步输出多少 token，输出侧瓶颈原封不动 |

两条线被独立研究，缺乏统一设计。且输出侧加速仍受 verifier 前向成本封顶——每个被接受的 token 仍要过完整 backbone。

### 2.3 两个关键观察

**观察 1：compressor 与 MTP head 是镜像。** compressor 在输入侧把两个 token embedding 折成一个 latent；MTP head 在输出侧把一个 hidden state 展开成一个额外 token。组合即对称的 pair-in / pair-out 接口，**同时砍半有效输入长度、翻倍每步输出**。且现代强 LLM（DeepSeek-V3、Qwen3.5 等）已内置 MTP head，PIPO 大部分组件是现成的。

**观察 2：OPD 教师就是 speculative decoding 的 verifier。** speculative decoding 里，强 LLM 作 verifier，以概率 $\min(p_v(x)/p_d(x), 1)$ 接受 draft token $x$。OPD 里，强模型作教师驱动 reverse-KL 蒸馏 $D = KL(p_s \| p_t)$。**两个角色功能相同：都判断 student/draft 是否与更强的 teacher/verifier 一致。** PIPO 据此用 $\min(p_t/p_s, 1)$ 当 confidence head 的标签——$(p_t, p_s)$ 本就是 OPD 算好的，监督几乎免费。

---

## 3. 方法详解

![图1 输入侧方法、输出侧方法与 PIPO 的对比：PIPO 把 compressor 与 MTP head 当镜像，用 confidence head 替代 verifier](/vibe-reading/images/articles/pipo-pair-in-pair-out-latent-multi-token-prediction/fig-01-methods-comparison.png)

### 3.1 概览与记号

PIPO 把解码单元从单 token 改成 **token pair**。在 pair step $i$：

- 输入：压缩 latent $z_i$，代表两个连续 token $(x_{2i}, x_{2i+1})$
- 输出：backbone token 分布 $p_b^{2i+2}$ + draft token 分布 $p_d^{2i+3}$ + confidence 分数 $c_i \in (0,1)$
- 若 $c_i \ge \tau_c$，接受 draft，下一输入对是 $(x_{2i+2}, x_{2i+3})$；否则拒绝 draft，用 padding 替换，下一对是 $(x_{2i+2}, x_{pad})$——**保持 pair 级接口不变**，提供单 token 解码的安全回退。

### 3.2 Pair-In / Pair-Out 架构

![图3 PIPO 架构：compressor（pair-in）+ backbone + MTP head（pair-out）+ confidence head；右图为 SFT 与 OPD 训练流程](/vibe-reading/images/articles/pipo-pair-in-pair-out-latent-multi-token-prediction/fig-03-architecture.png)

**Pair-in 压缩。** compressor 把每两个连续 token embedding 映成一个 latent 输入：

$$
z_i = f_\theta([x_{2i}; x_{2i+1}])
$$

其中 $[\cdot;\cdot]$ 是拼接，$f_\theta$ 是 MLP。初始化为 $f_\theta([a;b]) \approx a+b$，使训练初期 backbone 输入分布接近预训练分布（§4.4 消融证明此初始化极关键）。

**Pair-out 预测。** backbone 产生 hidden state 与下一 backbone token 分布：

$$
h_i^b = \text{Backbone}(z_{\le i}), \quad p_b^{2i+2} = \text{LMHead}(h_i^b)
$$

draft token 由 MTP head 基于 backbone hidden state 与 backbone token embedding 预测：

$$
h_i^d = \text{MTPHead}(h_i^b, x_{2i+2}), \quad p_d^{2i+3} = \text{LMHead}(h_i^d)
$$

压缩与 MTP 预测是镜像：一个折两个 embedding 成一个 latent，一个展开一个 hidden state 成一个额外 token。因 MTP head 已内置在现代 LLM，PIPO 唯一新增模块是 MLP compressor 与 confidence head。

**Confidence-guided draft 接受。** 不用大 verifier，而用轻量 confidence head 直接估计 draft 是否该用：

$$
c_i = g_\phi([h_i^b; h_i^d])
$$

$g_\phi$ 是小 MLP，输出 $(0,1)$ 标量。$c_i \ge \tau_c$ 则下一对含 draft token，否则用 padding。**这只多一个 MLP 前向，而非整次 backbone 前向。**

### 3.3 监督微调（SFT）

SFT 用 next-pair prediction 目标训练 PIPO。每 pair step 预测 ground-truth backbone token 与 draft token：

$$
L_{tok} = CE(p_b^{2i+2}, x_{2i+2}) + CE(p_d^{2i+3}, x_{2i+3})
$$

同时在 SFT 阶段 bootstrap confidence head——用 ground-truth draft token 概率作 BCE 标签：

$$
L_{conf}^{SFT} = BCE(c_i, p_d^{2i+3}(x_{2i+3}))
$$

让 $c_i$ 在 OPD 提供更锐利监督前就与 draft 可靠性相关。总目标 $L_{SFT} = L_{tok} + \lambda_{conf} L_{conf}^{SFT}$。为匹配推理行为，训练时随机把一部分 draft 位置输入替换成 padding embedding，让模型见过拒绝场景。

### 3.4 On-Policy Distillation（OPD）

SFT 从未暴露 PIPO 自身的解码分布，存在 train-inference gap。OPD 闭合此 gap：PIPO 在当前策略下 rollout，记录接受的 draft、拒绝位的 padding、每步 student 分布 $p_s$ 与 confidence $c$；去掉 padding 后喂给未压缩教师，得 token 级教师分布 $p_t$。reverse-KL 蒸馏：

$$
L_{distill} = KL(p_s \| p_t)
$$

**教师即 verifier。** speculative decoding 以 $\min(p_t(x)/p_s(x), 1)$ 接受 draft token $x$，用强目标模型作每步 verifier。OPD 里同一 $(p_t, p_s)$ 对本就在每步算好了——正是 verifier 准则所需量。**OPD 教师与 speculative decoding verifier 扮演同一角色。**

PIPO 据此用拒绝采样接受概率作 confidence head 标签：

$$
y_c = \min\!\left(\frac{p_t(x)}{p_s(x)}, 1\right), \quad L_{conf}^{OPD} = BCE(c, y_c)
$$

**监督几乎免费**：$(p_t, p_s)$ 已为 $L_{distill}$ 算好，confidence head 复用它们，无额外前向、无额外标签。推理时 trained confidence head 完全替代 verifier 前向，**把反复推理成本变成一次性训练信号**。总 OPD 目标 $L_{OPD} = L_{distill} + \lambda_{conf} L_{conf}^{OPD}$。

---

## 4. 关键公式解读

### 4.1 Pair-in 压缩

$$
z_i = f_\theta([x_{2i}; x_{2i+1}]) \approx x_{2i} + x_{2i+1} \text{（初始化）}
$$

用加性初始化让 backbone 输入分布在训练初期接近预训练分布——附录 E.1 证明训练后的 compressor 保留了加性几何，同时学到了非对称、位置感知的投影。

### 4.2 Pair-out 与 confidence

$$
p_b^{2i+2} = \text{LMHead}(\text{Backbone}(z_{\le i})), \quad p_d^{2i+3} = \text{LMHead}(\text{MTPHead}(h_i^b, x_{2i+2})), \quad c_i = g_\phi([h_i^b; h_i^d])
$$

一个 backbone 前向同时产出 backbone token 与 draft token，每步两个 token，配一个 confidence 标量决定 draft 去留。

### 4.3 核心洞察：OPD 教师 = speculative verifier

$$
\underbrace{\min\!\left(\frac{p_v(x)}{p_d(x)}, 1\right)}_{\text{speculative decoding 接受率}} \quad \equiv \quad \underbrace{\min\!\left(\frac{p_t(x)}{p_s(x)}, 1\right)}_{\text{OPD 里的同一量，免费拿来训 confidence head}}
$$

这是 PIPO 去掉 verifier 的数学根据——两个看似不同的角色（蒸馏教师、验证器）所需的量完全一致。

---

## 5. 实验设置

| 维度 | 配置 |
| --- | --- |
| **Backbone** | Qwen3.5-4B、Qwen3.5-9B（含内置 MTP head） |
| **训练数据** | DAPO-Math（17.4k 数学题）+ Codeforces（16.1k 代码题），90/10 SFT/OPD 划分；SFT 轨迹来自 Qwen3.5-9B 采样 4 条/题留正确，约 90k 条均长 24.4K token（截 64K） |
| **训练** | 两阶段：2 epoch SFT（draft 位 25% 随机 padding）+ 1 epoch OPD；LoRA + AdamW，lr 1e-4，5% warmup + cosine；$\lambda_{conf}=1.0$ |
| **评测** | AIME 2025（30 数学竞赛）、GPQA-Diamond（198 研究生多选）、LiveCodeBench v6（131 竞赛编程）、LongBench v2 short（178 长上下文 >10K） |
| **解码参数** | temp=1.0, top-p=0.95, top-k=20, repetition penalty=1.5，32K-slot 响应预算，每题采样 4 条报 avg@4 / pass@4 |
| **基线** | (i) Regular 自回归；(ii) MTP（用预训练 MTP head 出 draft 不验证）；(iii) EAGLE-2（MTP head 起草 + 一遍 backbone 验证 draft tree） |
| **PIPO 变体** | PIPO-SFT（仅 SFT）、PIPO+OPD（SFT 后 OPD） |

---

## 6. 实验结果

### 6.1 主结果：PIPO 是最强 pass@4 方法

![图4 主结果表：PIPO+OPD 在 4B/9B 两 backbone 上 pass@4 全面领先，AIME 2025 上 9B 提升 +16.66pp](/vibe-reading/images/articles/pipo-pair-in-pair-out-latent-multi-token-prediction/fig-04-table1-main-results.png)

- **PIPO 在两 backbone 上都是最强 pass@4 方法。** 即使无 OPD，PIPO-SFT 已超所有基线 pass@4：4B 上比最强基线（Regular）+1.53pp，9B 上 +3.55pp。加 OPD 后增益扩大到 4B +3.83pp、9B +7.15pp，除 4B LongBench 外每个任务列都是最佳 pass@4。
- 归因：pair-in 接口在固定 32K-slot 预算下，翻倍每步输出 = 砍半每 token 的有效长度成本，让 PIPO 在同预算里塞下更完整推理链。**AIME 2025 上效果最显著**：PIPO+OPD 在 4B/9B 上 pass@4 分别 +13.34 / +16.66pp。
- **OPD 恢复 avg@4 同时保住 pass@4 增益。** PIPO-SFT 用一些 avg@4 换更高 pass@4（draft 位翻倍增不确定性）；OPD 闭合此 gap：4B +1.24 avg@4 / +2.30 pass@4，9B +6.16 avg@4 / +3.60 pass@4。9B 上 PIPO+OPD 的 avg@4 与 Regular 持平（57.34 vs 57.67）且 pass@4 +7.15pp。**SFT→OPD 增益随模型规模增长**，暗示更大 backbone 从 OPD 获益更多。
- **现有加速器仍付出精度代价。** MTP 无验证全盘接受 draft，pass@4 掉超 11pp，证实未验证 draft 会传播错误。EAGLE-2 有 verifier 在环，接近 Regular 但 pass@4 仍差 3–5pp（注：EAGLE-2 的无损保证只在精确 speculative sampling 下成立，本文用的 top-p/top-k/repetition penalty 截断采样脱离该保证，draft 与 verifier 分布失配，小漂移在数千 token 推理链上累积）。

![图2 不同 context budget 下各方法 pass@4：PIPO 优势随预算增大而扩大](/vibe-reading/images/articles/pipo-pair-in-pair-out-latent-multi-token-prediction/fig-02-pass4-context-budget.png)

### 6.2 效率分析

![图5 TTFT 与 TPOT 随输入长度变化：PIPO 在长上下文 regime 收益最大（128K 时 TTFT 2.64×）](/vibe-reading/images/articles/pipo-pair-in-pair-out-latent-multi-token-prediction/fig-05-ttft-tpot.png)

- **TTFT（首 token 延迟）**：Regular prefill 处理全 prompt，TTFT 随输入长度从 2K 的 0.139s 涨到 128K 的 20.3s。PIPO 把每两个输入 token 压成一个，**砍半有效 prefill 长度**，2K 时 1.65× 加速，128K 时 **2.64× 加速**（20.3s → 7.69s）。相对增益随输入长度增大——长上下文 regime prefill 成本主导，正是推理负载所在。
- **TPOT（每 token 延迟）**：单 token 成本由一次 backbone 前向主导；MTP 与 PIPO 都每步出两 token，TPOT 约为 Regular 一半。PIPO 在 2K 时 **2.07×**（12.7 vs 26.3）、128K 时 1.98×（14.1 vs 27.9），且始终最快——因压缩 prefix 同时缩小了 KV cache。
- **Slot 效率**：slot = 方法原生粒度的一个输出单位（Regular/EAGLE-2/MTP 是一个 token，PIPO 是一个 token pair）。PIPO 的 tokens-per-slot 在 1×–2× 间随 confidence 接受率变化。共享 32K-slot 预算下，PIPO+OPD 仍比基线用更少 slot（比 Regular 少 ~3%、比 EAGLE-2 少 ~10%、比 MTP 少 ~13%），且每 slot 贡献更多推理内容。

### 6.3 关键数值汇总

| 指标 | PIPO 优势 |
| --- | --- |
| pass@4（vs Regular，9B） | +7.15pp |
| pass@4（AIME 2025，9B） | +16.66pp |
| TTFT 加速（128K） | 2.64× |
| TPOT 加速（2K） | 2.07× |
| Slot 用量（vs MTP） | 少 ~13% |

---

## 7. 消融实验

![图6 架构与训练数据消融：compressor 非线性、加性初始化、响应多样性都重要](/vibe-reading/images/articles/pipo-pair-in-pair-out-latent-multi-token-prediction/fig-06-table3-ablation.png)

- **compressor 需要非线性。** 用单线性层替 MLP，pass@4 掉 4.63pp（65.01→60.38）——两个异质 token embedding 融合成一个可消费 latent 需非线性变换。
- **compressor 初始化极关键。** 加性初始化 $f_\theta(a,b) \approx a+b$ 保 backbone 输入分布接近预训练分布；随机初始化造成表中最大跌幅（−6.54 avg@4，−7.28 pass@4）——喂 OOD 输入会破坏早期 SFT 稳定性。
- **SFT 受益于响应多样性。** 用"最短正确响应"替默认"所有正确响应"，pass@4 掉 5.14pp——即使答案相同，保留多条正确轨迹为 next-pair 目标提供有用多样性。

### 7.1 OPD 数据过滤阈值 $\rho$

![图7 OPD 数据按教师正确率 ρ 过滤：avg@4 单调增，pass@4 在 ρ=0.5 达峰](/vibe-reading/images/articles/pipo-pair-in-pair-out-latent-multi-token-prediction/fig-07-opd-filter.png)

只保留教师 4 次 rollout 中至少解出 $\rho \in \{0\%,25\%,50\%,75\%,100\%\}$ 的题重训。avg@4 随 $\rho$ 单调增（教师更准→监督更可靠），但 **pass@4 在 $\rho=0.5$ 达峰后下降**——激进过滤移除最难题，让学生对答案空间覆盖最关键的难例曝光不足。故主表用 $\rho=0.5$：足够稳定可学，又保留学生终须解决的难题。

### 7.2 confidence head 的"甜蜜点"

扫接受阈值 $\tau_c \in \{0,0.5,0.8,0.9,0.95,0.98,1.0\}$（对应 pad ratio 0→1），对比 Confidence 曲线与同平均 pad ratio 的 Random 基线（无条件掷硬币）：

![图8 pad ratio 扫描：Confidence 全程碾压 Random，峰值在 τ_c=0.95（pad 0.665）超过 pad=1 的纯单 token 解码](/vibe-reading/images/articles/pipo-pair-in-pair-out-latent-multi-token-prediction/fig-08-pad-ratio.png)

- **Confidence 全程碾压 Random**：如 pad ~0.6 时 61.93 vs 59.64 pass@4。排除"head 只是接受率旋钮"的假说——同等接受预算下它始终拒绝该拒的 draft、留该留的。
- **峰值在中间 $\tau_c$**：pass@4 在 $\tau_c=0.95$（pad 0.665）达 65.01，随 $\tau_c \to 1$（退化为单 token 解码）降到 64.55。**此峰值超过 pad=1 基线**，意味着调好的 head 下被接受的 draft 不只是保住常规解码质量，还贡献了额外有用推理。avg@4 则随 pad ratio 单调增（常规精度-覆盖权衡）。主表默认 $\tau_c=0.95$。

---

## 8. 总结与展望

### 8.1 贡献总结

1. **PIPO 统一输入侧 latent 压缩与输出侧 MTP**——compressor 与 MTP head 镜像对称，组合得 pair-in/pair-out 接口，同时砍半输入、翻倍输出。
2. **观察到 OPD 教师与 speculative verifier 同角色**，据此用教师-学生拒绝采样比作免费标签训轻量 confidence head，把每步 verifier 成本摊成一次性训练信号。
3. **四基准上 pass@4 最多 +7.15pp**，TTFT 2.64×、TPOT 2.07× 加速。

更深层的贡献是**两道抽象对应的识别**：把"压缩/展开"配成镜像，把"蒸馏教师/验证器"认成同一角色——对应画对，两侧收益同时拿到，昂贵反复成本被一次性训练信号替代。

### 8.2 局限性（论文自述）

- **只研究 pair-in/pair-out 设定**。更大压缩因子可能更强加速，但更难建模。
- **实验限于 4B–9B**。但 PIPO 在更大 9B 上增益更高，暗示对更大模型可能更有效。
- **聚焦可验证答案任务**，未评开放生成（对话、创意写作）。
- **仅文本模型**。扩展到多模态可能需模态特定 compressor。

### 8.3 未来方向（idea 三法）

**弥补缺陷**：

- 把 pair 推广到更大压缩因子（如 4-in/2-out），研究如何稳定训练更深的 compressor 层级——可能需要层级化加性初始化或渐进式压缩课程。
- 在开放生成任务上评估 PIPO，研究 confidence head 是否能在不损失多样性的前提下接受 draft（可能需把 confidence 从二元阈值扩展为基于温度的软接受）。

**新型方案**：

- 把 confidence head 的 supervision 从 OPD 教师扩展到 **process reward model**——用逐步正确性信号而非仅最终答案，给 draft 接受更细粒度的监督，可能进一步提升 pass@k。
- 结合 §3 的 composable formats 思路：对共享前缀的并行采样用大块压缩、对独有后缀用小块，在 PIPO 的 pair 接口上叠加多级压缩。

**减少约束**：

- 当前 confidence head 是事后训练的独立模块。若能把它与 backbone **联合预训练**（在预训练阶段就注入 pair 接口与 confidence 监督），可能让 backbone 从一开始就适应 pair 解码，消除 SFT 阶段的分布漂移。
- 把 pair-in 接口与 **vAttention 的 GPU 虚拟内存**结合，让压缩 latent 直接走硬件 TLB 加速地址翻译，进一步降 KV cache 管理开销。

---

> **一句话收尾**：PIPO 的胜利是"识别抽象对应"的胜利——compressor 与 MTP head 是镜像，OPD 教师与 speculative verifier 是同一角色——两道对应画对，输入输出两侧的加速收益同时拿到，verifier 这个反复推理成本被一次性训练信号替代。
