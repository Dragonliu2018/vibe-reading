---
title: "ELF: Embedded Language Flows"
source:
  type: "论文解读"
  project: "MIT"
  url: "https://arxiv.org/abs/2605.10938"
  pdf: "/vibe-reading/papers/elf-embedded-language-flows.pdf"
date: "2026-08-01T20:00:00+08:00"
category: [AI, Models, MIT, Papers]
tags: ["Diffusion Language Model", "Flow Matching", "Continuous Embedding", "Classifier-Free Guidance", "ELF", "Language Modeling"]
description: "目的：用连续 embedding 空间的 flow matching 做扩散语言模型。手段：全程停留连续空间、末步映射离散 token、共享权重 unembedding + training-time CFG。结论：105M 模型用 32 步/45B token 超越 MDLM/Duo/FLM/LangFlow。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/elf-embedded-language-flows.pdf" target="_blank" rel="noopener">预览</a> · **论文** [ELF: Embedded Language Flows](https://arxiv.org/abs/2605.10938) · **作者** Keya Hu, Linlu Qiu, Yiyang Lu, Hanhong Zhao, Tianhong Li, Yoon Kim, Jacob Andreas, Kaiming He（MIT）· **发表** arXiv 2605.10938, 2026-05 · **项目** https://github.com/lillian039/ELF · **解读** 2026-08-01

---

## 1. 论文概览

ELF（**E**mbedded **L**anguage **F**lows）是 MIT（Kaiming He 团队）提出的连续扩散语言模型（continuous DLM）。它针对一个核心开放问题：**当前连续 DLM 落后于离散 DLM，到底是因为语言本质上离散，还是算法设计未到位？** ELF 用一个极简设计回答——后者。

一句话 take-home：**只在最后一步把连续 embedding 映射回离散 token，其余全程停留在连续空间**，从而能直接搬用图像扩散里成熟的 Flow Matching + classifier-free guidance（CFG）。结果：105M 的 ELF-B 用 32 步采样、45B 训练 token（baselines 的 1/12）、且**不做蒸馏**，就在生成质量上超过 170M 的离散 DLM（MDLM/Duo）与连续 DLM（FLM/LangFlow）。

- **任务**：无条件生成（OWT）、机器翻译（WMT14 De-En）、摘要（XSum）。
- **方法**：基于连续时间 Flow Matching，在 token embedding 空间做去噪；t=1 末步用**共享权重**网络 + 可学习 unembedding 矩阵做离散化，无需独立 decoder。
- **贡献**：① 一个把"连续→离散"接口最小化的 DLM 框架；② 让 CFG 等"图像域技巧"自然可用；③ 在质量-效率-数据三维度全面超越主流 DLM。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Diffusion and flow-based models have become the de facto approaches for generating continuous data, e.g., in domains such as images and videos. Their success has attracted growing interest in applying them to language modeling. Unlike their image-domain counterparts, today's leading diffusion language models (DLMs) primarily operate over discrete tokens. In this paper, we show that continuous DLMs can be made effective with minimal adaptation to the discrete domain. We propose Embedded Language Flows (ELF), a class of diffusion models in continuous embedding space based on continuous-time Flow Matching. Unlike existing DLMs, ELF predominantly stays within the continuous embedding space until the final time step, where it maps to discrete tokens using a shared-weight network. This formulation makes it straightforward to adapt established techniques from image-domain diffusion models, e.g., classifier-free guidance (CFG). Experiments show that ELF substantially outperforms leading discrete and continuous DLMs, achieving better generation quality with fewer sampling steps. These results suggest that ELF offers a promising path toward effective continuous DLMs.

> **译：** 扩散与基于流的模型已成为生成连续数据（如图像与视频）的事实标准，其成功激发了将其用于语言建模的兴趣。与图像域对应物不同，当今领先的扩散语言模型（DLM）主要在离散 token 上运作。本文证明，只需对离散域做极小适配，连续 DLM 即可变得有效。我们提出 Embedded Language Flows（ELF），一类基于连续时间 Flow Matching、在连续 embedding 空间中运作的扩散模型。与现有 DLM 不同，ELF 在几乎所有时间步都停留在连续 embedding 空间，仅在最后一步用共享权重网络映射回离散 token。这一表述使我们能直接搬用图像域扩散模型的成熟技术，如 classifier-free guidance（CFG）。实验表明 ELF 大幅超越领先的离散与连续 DLM，以更少采样步数获得更好生成质量。这些结果表明 ELF 为有效的连续 DLM 提供了一条有前景的路径。

</details>

---

## 2. 研究背景

扩散语言模型（DLM）分两条路线：

- **离散 DLM**：直接在 token 空间建扩散。D3PM（吸收/均匀转移）、MDLM（吸收态 + 迭代 unmasking）、Duo（向均匀分布扩散、可反复修订 token）。**目前是主流且经验性能更强**，并已扩展到代码、多模态与规模化。
- **连续 DLM**：把 token 映到连续空间再去噪。Diffusion-LM / CDCD / DiffuSeq（在 embedding 上加噪）、SSD-LM / TESS（simplex）、LD4LG 系列（latent diffusion on 冻结 encoder 表征）。

连续 DLM 长期落后的一个嫌疑是"语言本质上离散"。但本文作者质疑：**这究竟是本质问题，还是算法设计欠开发？** 连续 DLM 现有做法的一个共性问题是——它们通过 rounding loss、simplex 约束、token 级 cross-entropy 等**让轨迹仍绑在离散 token 空间**，并依赖独立训练的 decoder。

ELF 的切入点正是**连续-离散接口的最小化**：

| 维度 | 现有连续 DLM | ELF |
|---|---|---|
| 离散化 | 每步 token 级 CE / rounding / simplex | **仅在 t=1 末步** |
| decoder | 独立训练一个 | **共享权重，无额外模块** |
| 时间 | DDPM 离散步 | **连续时间 Flow Matching** |
| CFG | 离散域基本不适用 | **自然可用（连续速度场）** |

并发的 DFM / CFM / FLM / LangFlow 也探索流式语言建模，但都在轨迹上加 token 级 CE 监督；ELF 把去噪轨迹完全留在无约束连续 embedding 空间，仅末步解码——这是关键差异。

---

## 3. 方法详解

### 3.1 ELF 框架

**从离散 token 到连续 embedding。** token 序列 $s = [s_1, \dots, s_L] \in \mathcal{V}^L$ 经 encoder 映到连续表示。默认用**冻结的预训练 T5 encoder**（双向上下文 embedding）；也支持联合训练 / 随机权重 encoder（见消融）。encoder **仅训练时用**，推理不引入额外模块。

**embedding 空间上的 Flow Matching。** 用线性插值（rectified flow）定义从噪声到数据的流：

$$
z_t = t\,x + (1-t)\,\epsilon, \quad t \in [0,1], \quad z_0 \sim p_{\text{noise}},\ z_1 \sim p_{\text{data}}
$$

速度场 $v = dz/dt = x - \epsilon$。ELF 不直接预测 $v$，而采用 **x-prediction**（预测干净 embedding）：

$$
\mathcal{L}_{\text{MSE}} = \mathbb{E}_{t,x,\epsilon}\!\left[\frac{1}{(1-t)^2}\,\lVert x_\theta(z_t, t) - x \rVert^2\right]
$$

利用关系 $v(z_t,t) = (x - z_t)/(1-t)$ 把 x-prediction 转成速度。**为何用 x-prediction？** ① 在高维（768-d per-token）表征上 Flow Matching 更稳；② 预测干净 embedding 与末步"预测干净 token"目标天然对齐，**支撑权重共享**。实测 v-prediction 在与末步离散化共享权重时表现很差。

**末步回到离散 token。** 在 $t=1$，把"末步去噪"自然视为"连续→离散解码"，从而**不需要独立 decoder**——可理解为一个与去噪器共享权重的 decoder。由于 $z_t \to x$（当 $t\to 1$），末步输入会退化，故引入 token 级 corruption 构造非平凡输入 $\tilde{z}$；同一网络 $net_\theta$ 映射 $\tilde{z} \to x_\theta(\tilde{z})$，再经可学习 **unembedding 矩阵 $W$** 投影成 logits，对 ground-truth token $s$ 做 cross-entropy：

$$
\mathcal{L}_{\text{CE}} = \mathbb{E}_{\tilde{z}}\!\left[\text{CrossEnt}(W\,x_\theta(\tilde{z}),\ s)\right]
$$

网络除时间条件 $t$ 外，还以一个二元 **"mode" token**（denoise / decode）为条件。推理时仅在 $t=1$ 评估 $W x_\theta(z_t)$ 并 argmax 得 token。

![图2 ELF 概念图：橙色为连续 embedding 空间数据点，紫色为从高斯噪声到干净 embedding 的去噪轨迹；仅在末步 t=1 离散化](/vibe-reading/images/articles/elf-embedded-language-flows/fig-2-conceptual.png)

![图3 ELF 训练与采样：训练时 token→encoder→corrupt→ELF 预测 x̂；推理时从高斯噪声迭代去噪，仅末步切到 decode 模式经 unembedding 投影回 token](/vibe-reading/images/articles/elf-embedded-language-flows/fig-3-architecture.png)

### 3.2 训练与推理流程

```python title="ELF 训练（Alg.1 简化）— 双分支批处理，无额外训练成本"
# net(z, t, mode): ELF 网络；s: 离散 token 序列
x = encode(s)
if uniform(0, 1) < threshold:        # 去噪分支
    t = sample_t(); e = randn_like(x)
    z = t * x + (1 - t) * e
    v = x - e
    x_pred = net(z, t, mode="denoise")
    v_pred = (x_pred - z) / (1 - t)
    loss = mse_loss(v_pred, v)
else:                                 # 解码分支 (t=1)
    z = corrupt(x)
    x_pred = net(z, t=1, mode="decode")
    s_pred = unembed(x_pred)
    loss = ce_loss(s_pred, s)
```

```python title="ELF 推理（Alg.2 简化）— ODE Euler 求解，末步 decode"
z = randn(shape)                     # 起点为高斯噪声
for i in range(len(ts) - 1):
    t = ts[i]; dt = ts[i + 1] - ts[i]
    x_pred = net(z, t, mode="denoise")
    v = (x_pred - z) / (1 - t)       # x 预测转速度
    z = z + dt * v
h = net(z, t=1, mode="decode")       # 末步：解码模式
tokens = argmax(unembed(h))
```

训练时两分支在同一 batch 内用 mask 选择性施加 corruption / unembedding 与对应 loss。推理用 ODE Euler 求解 $dz_t/dt = v_\theta$；也支持一个 **SDE-inspired 采样器**——每步注入小噪声并相应把 $t$ 往噪声侧偏移（近似真正的 SDE）。

### 3.3 条件与引导：CFG 的自然回归

> 图像扩散里 CFG 是控制生成的利器。但因 CFG 原本是给连续量（score / 速度场）定义的，**在离散 DLM 上基本不适用**——这恰是 ELF 连续表述的一大优势。

**Self-conditioning。** 标准 Flow Matching 每步只前向一次得 $\hat{x}'$；self-conditioning 做第二次前向、以 $\hat{x}'$ 为条件：$\hat{x} = net_\theta(z_t \mid \hat{x}', t)$，实现为拼接 $[z_t, \hat{x}']$。训练时 50% 概率给 $\hat{x}'$、否则给 null $0$；**推理时用上一步预测作条件，不增加前向次数**。$\hat{x}'$ 即可作为 CFG 的条件信号 $c$。

**Training-time CFG。** 给定条件 $c$：

$$
v_{\text{cfg}}(z_t \mid c) = \omega\, v(z_t \mid c) + (1 - \omega)\, v(z_t \mid \varnothing)
$$

$\varnothing$ 为无条件对应、$\omega$ 为 guidance scale。原始 CFG 每步需两次前向；ELF 借鉴图像生成的 training-time CFG 技巧（[Mean Flows] 等），用**单次前向**直接建模 $x_{\text{cfg}}$——因 ELF 与图像生成同构，迁移很直接。

**条件生成。** 把条件序列的干净 embedding 前置拼接、训练与推理全程不 corruption，模型经 self-attention 条件化——可视为"text-to-text"生成，CFG 同样有效（条件 $c$ = self-conditioning + 前缀 clean embedding，无条件对应把 $c$ 置零）。

---

## 4. 关键公式解读

ELF 的核心是**两段式目标**：连续去噪（MSE）+ 末步离散化（CE），靠共享权重与 mode token 统一。

**① rectified flow 插值与速度**（连续时间、连续空间的基础）：

$$
z_t = \underbrace{t\,x}_{\text{数据}} + \underbrace{(1-t)\,\epsilon}_{\text{噪声}}, \quad \underbrace{v = \frac{dz}{dt} = x - \epsilon}_{\text{目标速度}}
$$

**② x-prediction 的 MSE 损失**（去噪分支，占训练 80%）——通过 $(x-z_t)/(1-t)$ 把 x-prediction 等价为速度预测：

$$
\mathcal{L}_{\text{MSE}} = \mathbb{E}_{t,x,\epsilon}\!\left[\underbrace{\frac{1}{(1-t)^2}}_{\text{末步权重小，保护}}\,\lVert x_\theta(z_t, t) - x \rVert^2\right]
$$

**③ 末步离散化的 CE 损失**（解码分支，占训练 20%）——共享权重 $x_\theta$ + 可学习 unembedding $W$：

$$
\mathcal{L}_{\text{CE}} = \mathbb{E}_{\tilde{z}}\!\left[\text{CrossEnt}\!\left(\underbrace{W\,x_\theta(\tilde{z})}_{\text{embedding→logits}},\ s\right)\right]
$$

**④ CFG 外推**（条件速度 = 有条件 × ω + 无条件 × (1−ω)）：

$$
v_{\text{cfg}}(z_t \mid c) = \omega\, v(z_t \mid c) + (1-\omega)\, v(z_t \mid \varnothing)
$$

> 四个公式串起 ELF 的全部设计：①定义流的几何；②训练去噪器；③用共享权重把"预测干净 embedding"自然延展为"预测干净 token"；④把连续速度场的好处（CFG）拿来用。x-prediction 是让 ② 与 ③ 能共享权重的关键纽带。

---

## 5. 实验设置

**数据与评测。**

| 任务 | 数据集 | 序列长 | 评测指标 |
|---|---|---|---|
| 无条件生成 | OWT（~9B tokens） | L=1024 | Gen. PPL（GPT-2 Large 对生成样本的困惑度）+ unigram 熵（多样性） |
| 机器翻译 | WMT14 De-En | L=128（cond 64 / target 64） | BLEU |
| 摘要 | XSum | L=1088（cond 1024 / target 64） | ROUGE-1/2/L |

> 不用 validation perplexity：flow-based 模型的似然评测需额外 likelihood-specific 训练。Gen. PPL 用 GPT-2 Large 衡量生成文本的"自然度"。

**模型。** 冻结预训练 T5-small encoder（35M，dim 512），bottleneck 线性投影到 128 再回 hidden。三档规模：

| 模型 | 参数 |
|---|---|
| ELF-B（默认消融用） | 105M |
| ELF-M | 342M |
| ELF-L | 652M |

**训练与推理。** Muon 优化器，lr 0.002，batch 512。OWT 上 5 epoch（~95K 步）；WMT14 / XSum 各 100 epoch（~880K / ~40K 步）。网络按 mode 采 **MSE 80% / CE 20%** 训练。推理用 ODE 或 SDE 采样器。代码开源于 [github.com/lillian039/ELF](https://github.com/lillian039/ELF)。

---

## 6. 实验结果

### 6.1 主结果：质量-效率-数据三维领先

![图1 ELF 用更少采样步数获得更低 Gen. PPL（且无蒸馏），训练 token 仅 baselines 的 1/10](/vibe-reading/images/articles/elf-embedded-language-flows/fig-1-genppl-comparison.png)

![图7 系统级对比：(a) 同设置下超离散/连续 DLM；(b) 少步 regime 超蒸馏变体；(c) 训练 token 仅 45B vs baselines 500B+](/vibe-reading/images/articles/elf-embedded-language-flows/fig-7-system-comparison.png)

ELF-B（105M）对比 ~170M 的离散 DLM（MDLM、Duo）与连续 DLM（FLM、LangFlow），全部在 OWT 上训练。ELF 最佳配置：SDE 采样 + self-conditioning CFG scale=3。

- **质量 + 步数**：ELF 仅用 **32 步**就达到 **Gen. PPL ≈ 24**，远低于 baselines（少步即胜）。
- **抗蒸馏**：即使对比 baselines 的**蒸馏变体**（MDLM+SDTT、Duo+DCD、FMLM——需额外训练轮次做少步生成），ELF 在少步 regime 仍更优，且**自身不做蒸馏**。
- **数据效率**：baselines 普遍用 500B+ 训练 token（12-13×），ELF 仅用 **45B**——1/12 的数据预算。作者也试过加更多 token，未观察到进一步提升。

### 6.2 规模化

![图6 ELF-B/M/L 的 Gen. PPL-熵前沿：放大模型持续改善；SDE 一致优于 ODE](/vibe-reading/images/articles/elf-embedded-language-flows/fig-6-scaling.png)

ELF-B → M(342M) → L(652M)：等熵下大模型 Gen. PPL 更低、等 PPL 下熵更高——前沿持续外推。SDE 采样的优势跨规模一致。

### 6.3 条件生成：翻译与摘要双最优

| 模型 | 规模 | De-En BLEU↑ | XSum R-1↑ | R-2↑ | R-L↑ |
|---|---|---|---|---|---|
| AR | 99M | 25.2 | 30.5 | 10.2 | 24.4 |
| MDLM | 99M | 18.4 | 33.4 | 11.6 | 25.8 |
| Duo | 170M(+35M) | 21.3 | 31.4 | 10.1 | 25.0 |
| E2D2 | 99M | 24.8 | 28.4 | 8.3 | 22.0 |
| SeqDiffuSeq | - | 21.3 | 19.3 | 1.7 | 14.1 |
| CDCD | - | 24.9 | - | - | - |
| **ELF-B** | 105M(+35M) | **26.4** | **36.0** | **12.2** | **27.8** |

*Table 1：WMT14 翻译与 XSum 摘要，ELF-B 在两项全部指标上超越所有同规模基线。*

ELF 在条件生成上同样领先——BLEU 26.4、ROUGE-1 36.0，全部最优。最佳采样配置：64 步 ODE、self-conditioning CFG=1、input-condition CFG=2。定性示例（论文 Fig.8）显示生成文本语义对齐参考、且能遵循输入上下文。

---

## 7. 消融实验

均在 OWT 上用默认 ELF-B + 64 步 ODE Euler 采样器（除另说明）。

### 7.1 CFG：质量-多样性 trade-off

![图4 扫 CFG scale：增大 scale 降低 Gen. PPL 但降低熵——质量-多样性权衡](/vibe-reading/images/articles/elf-embedded-language-flows/fig-4-cfg-ablation.png)

增大 CFG scale 降低 Gen. PPL（更高质量）但也降低 entropy（多样性减少）。理想方向是右下（低 PPL + 高熵）。后续消融均以"扫 CFG scale 画前沿"的方式呈现，每个点为某 CFG scale 下 1000 个生成样本。

### 7.2 三项关键设计选择

![图5 三项消融：(a) embedding 选择；(b) 解码策略；(c) 采样器](/vibe-reading/images/articles/elf-embedded-language-flows/fig-5-design-ablation.png)

**① Embedding 选择（Fig.5a）。** 沿两条轴消融：上下文 vs 非上下文、固定 vs 可学习。结论：**预训练上下文 embedding（T5 encoder）最佳**；从零训练的 encoder 接近但略差；非上下文里预训练 token embedding > 冻结高斯；**可学习 embedding 最差**（ jointly 优化 embedding 与去噪器困难）。

**② 解码策略（Fig.5b）。** 共享权重 denoiser-decoder vs 两阶段独立 decoder（先冻结 encoder 训 decoder，再冻结 encoder+decoder 训独立 denoiser）。两者前沿相近，但**共享权重向更低 PPL 区域延伸更远，且省一个训练阶段**——简化流程还更强。

**③ 采样器（Fig.5c）。** ODE vs SDE-inspired。**SDE 在少步 regime 一致更低 Gen. PPL**——采样时引入随机性可有效减少误差累积，提供更好的质量-效率折中。

---

## 8. 总结与展望

### 贡献总结

ELF 把连续 DLM 的"连续→离散"接口压到最小——**全程连续去噪、仅末步离散化、共享权重无独立 decoder、连续时间 Flow Matching**。这一表述让图像扩散的成熟工具（CFG、training-time guidance、ODE/SDE 采样）自然可用。实验上以 105M 小模型 + 32 步 + 45B token + 无蒸馏，在质量-效率-数据三维度超越主流离散与连续 DLM，并验证了规模化与条件生成的有效性。结论：**连续 DLM 落后不是语言本质离散所致，而是设计未到位**——ELF 提供了一条可行路径。

### 局限性（批判性）

- **规模上限 652M**：尚未验证更大规模（>1B）下连续 DLM 是否仍持优势、能否逼近自回归大模型。当前结论仅在小-中规模成立。
- **Gen. PPL 的评测依赖**：以 GPT-2 Large 的困惑度为代理指标，本身是个有偏的"自然度"度量；论文未做大规模人工评测。
- **x-prediction + 权重共享是经验选择**：作者说明 v-prediction 在共享权重下"表现很差"但仅给实证，缺机制级解释；$(1-t)^{-2}$ 在 $t\to 1$ 时数值稳定性需谨慎（论文用 corruption 避开退化输入，但未给收敛性分析）。
- **SDE 采样器是近似**：所谓 "SDE-inspired" 实为每步注噪 + 时间偏移的工程近似，并非严格从 Flow Matching 推导的 SDE。
- **依赖预训练 encoder**：默认冻结 T5-small——虽消融显示从零训 encoder 也可，但最佳仍依赖外部预训练表征，引入了对 T5 的依赖。

### 未来方向（idea 三法）

1. **弥补缺陷**：扩大到 >1B 规模验证可扩展性；引入 LM-based 评测或人工评测去 Gen. PPL 之偏；对 x-prediction 与权重共享的耦合做机制分析（如不同 prediction target 在末步信息流中的作用）。
2. **新型方案**：因 ELF 与图像生成同构，可直接嫁接 Flow Matching 新进展（如 [Mean Flows]、一步生成 distillation）——既然 ELF 已用 training-time CFG，把一步 / 少步流式生成迁移到语言是自然下一步；探索"纯随机 encoder + 大模型"能否摆脱对 T5 的依赖。
3. **减少约束**：放宽"唯一终态/固定 vocab"假设，研究 ELF 在开放词表或子词-字节级连续空间的表现；把"text-to-text CFG"扩展到指令跟随、代码生成等多模态条件，验证连续 DLM 在真实生成任务中的上限。

> 相关阅读：本文属 Vibe Reading 博客扩散语言模型系列。ELF 的连续 embedding 思路与 [[cola-dlm-continuous-latent-diffusion]]（连续潜空间扩散 LM）、[[llada2-scaling-diffusion-language-models-100b]]（规模化离散 DLM）、[[pipo-pair-in-pair-out-latent-multi-token-prediction]]（多 token 潜预测）同主题——ELF 与它们的关键差异是**把离散化压到末步、让流式训练原生可用 CFG**，为连续 DLM 路线补上了一块关键拼图。
