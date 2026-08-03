---
title: "Cola: Continuous Latent Diffusion Language Model"
source:
  type: "论文解读"
  project: "Seed"
  url: "https://arxiv.org/abs/2605.06548"
  pdf: "/vibe-reading/papers/cola-dlm-continuous-latent-diffusion.pdf"
date: "2026-07-25"
category: [AI, Models, Text Model, Papers]
tags: ["Diffusion", "Language Model", "Non-Autoregressive", "Latent Variable", "VAE", "Flow Matching"]
description: "目的：突破自回归固定顺序局限。手段：Text VAE + block-causal DiT 在连续隐空间学语义先验 + 条件解码。结论：8 基准上扩展性优于匹配的 ~2B AR/LLaDA。"
readingTime: "15 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/cola-dlm-continuous-latent-diffusion.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Cola: Continuous Latent Diffusion Language Model](https://arxiv.org/abs/2605.06548) · **作者** Hongcan Guo, Qinyu Zhao 等（ByteDance Seed / HKU / ANU / PKU / RUC）· **发表** arXiv 2605.06548, 2026-05 · **项目** https://hongcanguo.github.io/Cola-DLM/ · **解读** 2026-07-25

---

## 1. 论文概览

**一句话**：Cola-DLM 把文本生成拆成两层——在连续隐空间用扩散学一个"全局语义先验"，再用条件解码器把隐变量落回 token；扩散在这里**不是恢复 token，而是搬运隐先验**。

- **任务**：非自回归语言建模（文本生成）。
- **核心创新**：从统一的马尔可夫路径视角，把扩散路径的角色从"观测恢复"（observation-recovery）改为"先验搬运"（prior-transport），从而把"全局语义组织"和"局部文本实现"解耦。
- **结果**：在 8 个基准、严格匹配的 ~2B 参数 AR（LLaMA）与 LLaDA 基线上、扩展到约 2000 EFLOPs 的曲线上，Cola-DLM 展现出更强的高算力扩展性，最终 Task Average 最优。

**take-home**：连续隐空间 + 分层隐变量 + 扩散学先验，是一条"有原则地替代纯 token 级语言建模"的路径——而且生成质量比似然更能反映模型能力。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Large language models have achieved remarkable success under the autoregressive paradigm, yet high-quality text generation need not be tied to a fixed left-to-right order. Existing alternatives still struggle to jointly achieve generation efficiency, scalable representation learning, and effective global semantic modeling. We propose Cola DLM, a hierarchical latent diffusion language model that frames text generation through hierarchical information decomposition. Cola DLM first learns a stable text-to-latent mapping with a Text VAE, then models a global semantic prior in continuous latent space with a block-causal DiT, and finally generates text through conditional decoding. From a unified Markov-path perspective, its diffusion process performs latent prior transport rather than token-level observation recovery, thereby separating global semantic organization from local textual realization. This design yields a more flexible non-autoregressive inductive bias, supports semantic compression and prior fitting in continuous space, and naturally extends to other continuous modalities. Through experiments spanning 4 research questions, 8 benchmarks, strictly matched ~2B-parameter autoregressive and LLaDA baselines, and scaling curves up to about 2000 EFLOPs, we identify an effective overall configuration of Cola DLM and verify its strong scaling behavior for text generation. Taken together, the results establish hierarchical continuous latent prior modeling as a principled alternative to strictly token-level language modeling, where generation quality and scaling behavior may better reflect model capability than likelihood, while also suggesting a concrete path toward unified modeling across discrete text and continuous modalities.

> **译：** 大型语言模型在自回归范式下取得了显著成功，但高质量文本生成未必非要绑定固定的从左到右顺序。现有替代方案仍难以同时兼顾生成效率、可扩展的表示学习与有效的全局语义建模。我们提出 Cola-DLM，一种分层隐空间扩散语言模型，通过分层信息分解来刻画文本生成。Cola-DLM 首先用 Text VAE 学习稳定的 text-to-latent 映射，再用 block-causal DiT 在连续隐空间建模全局语义先验，最后通过条件解码生成文本。从统一的马尔可夫路径视角看，其扩散过程执行的是**隐先验搬运**（latent prior transport）而非 token 级观测恢复，从而把全局语义组织与局部文本实现分离开来。这一设计带来更灵活的非自回归归纳偏置，支持连续空间中的语义压缩与先验拟合，并能自然扩展到其他连续模态。通过涵盖 4 个研究问题、8 个基准、严格匹配的约 2B 参数自回归与 LLaDA 基线、以及约 2000 EFLOPs 的扩展曲线的实验，我们确定了 Cola-DLM 的有效整体配置，并验证了其在文本生成上的强扩展性。综合来看，这些结果将分层连续隐先验建模确立为严格 token 级语言建模的一条有原则的替代路径——其中生成质量与扩展行为可能比似然更能反映模型能力——同时指明了跨离散文本与连续模态统一建模的具体方向。

</details>

## 2. 研究背景

现有三类语言建模范式各有硬伤：

| 范式 | 做法 | 不足 |
|---|---|---|
| 自回归（AR） | 链式分解 token 条件概率 | 固定从左到右顺序、推理天然串行、归纳偏置强 |
| 离散扩散（如 LLaDA） | 离散 token 空间加噪–去噪 | 多步采样慢；中间离散态不稳，难承载全局语义 |
| 连续扩散（token 级 / Plaid） | 在 token embedding / one-hot 上做连续扩散 | 仍是"观测恢复"，缺显式隐变量与统一边际似然视角 |

**缺口**：尚无框架同时做到"非自回归生成 + 连续表示 + 概率化文本建模"。Cola-DLM 的动机正是补这个缺口——把扩散搬到**连续隐空间**，让它学先验而非恢复 token。

## 3. 方法详解

Cola-DLM 是一个**分层隐变量语言模型**：先验 $p_\psi(z_0)$ 生成全局连续语义，解码器 $p_\theta(x \mid z_0)$ 实现局部 token。整体由两个训练阶段 + 一个推理阶段组成。

![Figure 1：Cola-DLM 整体工作流。训练 Stage 1 为 Text VAE 预训练（重建 + KL + BERT mask loss）；训练 Stage 2 为 Text VAE 与 Text DiT 联合预训练，DiT 内采用 block-causal 机制；推理阶段带 KV cache 解码。](/vibe-reading/images/articles/cola-dlm-continuous-latent-diffusion/fig-01-workflow.png)

- **Stage 1（Text VAE 预训练）**：建立稳定的 text↔latent 对应；损失 = 重建 + KL（到 base 先验）+ BERT mask loss（防语义塌缩）。编解码器严格 causal，不压缩序列长度。
- **Stage 2（block-causal DiT 先验学习）**：在稳定隐空间上学条件先验；Flow Matching + reference-encoder 正则防隐空间漂移；block-causal = 块内双向 attention、块间 causal。
- **推理**：prefix 编码为 clean 条件 → DiT 逐块搬运噪声生成 latent 块 → 条件解码器输出文本（带 KV cache）。

**三个关键设计**：

1. **扩散 = 先验搬运，不是 token 恢复**：扩散路径只把 $z_1 \sim \mathcal{N}(0,I)$ 搬到隐先验 $p_\psi(z_0)$，解耦了"全局语义"与"局部实现"。
2. **block-causal DiT**：块内双向（并行计算）、块间 causal（保跨块因果），既高效又保留顺序结构。
3. **两阶段协同**：Stage 1 的 `base 先验` 只稳住隐–文接口、**不是最终生成先验**；Stage 2 的 DiT 才学最终先验，且 VAE 仍在重建/mask/reference 正则下可训——是"受控的协同演化"，而非 VAE→DiT→decoder 的机械级联。

## 4. 关键公式解读

**(1) 分层联合分布**——先验生成全局语义，解码器实现 token：

$$
p(x, z_0) = p_\theta(x \mid z_0)\, p_\psi(z_0)
$$

**(2) 连续流先验**——扩散路径搬运隐先验（不是恢复观测）：base 分布 $z_1 \sim \mathcal{N}(0, I)$ 经流映射得到先验 $p_\psi = (\Phi_\psi)_\sharp\, p_1$。

$$
\frac{dz_t}{dt} = v_\psi(z_t, t), \qquad z_0 = \Phi_\psi(z_1)
$$

**(3) ELBO**——训练下界（$q_\phi(z_0 \mid x)$ 仅训练期变分推断用，不属于生成模型）：

$$
\log p(x) \geq \mathbb{E}_{z_0 \sim q_\phi}\!\left[\log p_\theta(x \mid z_0) + \log p_\psi(z_0) - \log q_\phi(z_0 \mid x)\right]
$$

**(4) ELBO 分解**——把文本建模拆成三件事：条件重建 / 信息压缩 / 先验匹配：

$$
\mathbb{E}[\mathcal{L}_{\text{ELBO}}] = \underbrace{\mathbb{E}[\log p_\theta(x \mid z_0)]}_{\text{条件重建}} - \underbrace{I_q(X;\, Z_0)}_{\text{信息压缩}} - \underbrace{\mathrm{KL}\!\left(\bar{q}_\phi(z_0) \,\|\, p_\psi(z_0)\right)}_{\text{先验匹配}}
$$

**关键洞察**：$z_0$ 不是离散文本的连续替身，而是显式的**边际中间变量**——全局语义被压缩进 $z_0$，局部 token 实现交给解码器。`Flow Matching` 只是求解这个先验搬运的实现手段，**模型本身是分层隐变量语言模型**。

## 5. 实验设置

- **数据**：外部开源预训练数据；评估用 LAMBADA（续写）+ MMLU、SIQA（多选），外加 SQuAD、Story Cloze、OBQA、RACE、HellaSwag，共 **8 基准**。
- **基线**：严格匹配的 ~2B 参数 **AR（LLaMA 官方实现）** 和 **LLaDA（离散扩散）**，随机初始化、同 OLMo 2 tokenizer、同种子、最大序列长 512。
- **模型规模**：Cola-DLM = VAE 500M + DiT 1.8B；基线 embedding 400M + backbone 1.8B。三方总规模都约 2B。
- **评估口径**：**不用 perplexity**，而用**统一的 few-shot 生成式评估**（多选任务也转成生成式严格字符串匹配）。原因见 §7——PPL 与生成质量结构性不匹配。

## 6. 实验结果

论文围绕 4 个研究问题（RQ1–RQ4）展开：

| RQ | 问题 | 结论 |
|---|---|---|
| RQ1 | 隐空间里**是否**存在全局语义结构？ | 存在——最优 timeshift 随隐维度系统漂移（d=16→1.0，d=64→1.7，d=128→2.3），且与理论预测一致，跨多语义指标稳定 |
| RQ2 | 哪种隐空间最优？ | 从稳定预训练 VAE 出发、与 DiT 联合演化（Joint DiT x1）最优；d=128 容量最好；加 BERT loss、可学 VAE logSNR 最佳 |
| RQ3 | 哪种扩散过程最有效？ | block size **16** 最佳；噪声调度 **loc=1.0** 最佳；推理 **8–10 步**去噪即收敛（相对 AR 有 1.6–2.0× 串行深度缩减）；**中等 CFG≈3–6** 最佳，过强则崩 |
| RQ4 | 为何用连续隐扩散？ | 在高算力区扩展性最强、Task Average 最终最优；在 MMLU/RACE/Story Cloze/OBQA 等推理–全局语义任务上优势尤其明显 |

RQ1 的关键证据（Figure 2）：最优 timeshift 随隐维度系统漂移（d=16→1.0、d=64→1.7、d=128→2.3），且跨 LAMBADA/MMLU/SIQA 多语义指标一致、与理论预测吻合——反证隐空间存在跨维度共享的全局语义结构。

![Figure 2：隐空间存在全局语义结构的证据。随隐维度增大，最优 timeshift 系统性漂向更大位置（左），且多个语义指标一致偏好更大 loc（右），与理论预测吻合。](/vibe-reading/images/articles/cola-dlm-continuous-latent-diffusion/fig-02-global-semantic-evidence.png)

**最终扩展性**（Figure 10，8 基准 + Task Average）：Cola-DLM 在高 compute 区持续上升并取得最佳 Task Average；AR 在小算力区有竞争力，LLaDA 早期有增益但曲线后劲不足。在生成式任务（LAMBADA/SQuAD）上 Cola-DLM 与 AR 接近、SQuAD 上随规模反超 AR。

![Figure 10：统一 few-shot 生成式评估下的整体扩展性能。8 个基准与 Task Average 上，Cola-DLM 展现强扩展动态，最终达到最佳平均性能；AR（LLaMA）与离散扩散 LLaDA 为严格匹配的 ~2B 基线。](/vibe-reading/images/articles/cola-dlm-continuous-latent-diffusion/fig-10-scaling.png)

## 7. 消融与关键发现

**隐空间策略（RQ2）**：固定 VAE 早期稳但封顶低；从 scratch 联合训最差（隐空间塌缩）；从稳定初始化出发联合演化最优。隐空间维度提升部分缓解塌缩但不彻底：

| All Scratch 策略 | LAMBADA | MMLU | SIQA | Avg |
|---|---|---|---|---|
| d=16, loc=1 | 14.3 | 6.9 | 4.9 | 8.7 |
| d=64, loc=1 | 20.9 | 5.4 | 7.6 | 11.3 |
| d=128, loc=1 | 18.5 | 8.1 | 8.9 | 11.8 |

隐空间可视化（Figure 4）也印证：从 scratch 训出的隐空间塌缩、轨迹单一；从稳定初始化出发联合演化的隐空间更结构化、轨迹更丰富——这正是 Joint DiT 占优的几何原因。

![Figure 4：不同训练策略下的隐空间可视化。稳定初始化 + 联合演化产出更结构化、语义更有组织的隐空间；从 scratch 训练则塌缩、轨迹单一；提升隐维度（16→128）部分缓解但不彻底。](/vibe-reading/images/articles/cola-dlm-continuous-latent-diffusion/fig-04-latent-space-visualization.png)

**VAE logSNR（隐空间平滑度）**：可学 logSNR（≈4.5）总体最强，固定 1.5 是最强固定替代：

| VAE logSNR（116.78 EFLOPs） | LAMBADA | MMLU | SIQA | Avg |
|---|---|---|---|---|
| 固定 1.0 | 30.4 | 7.7 | 18.4 | 18.83 |
| 固定 1.5 | 33.8 | 8.0 | 23.6 | 21.80 |
| 固定 2.0 | 32.7 | 9.7 | 19.5 | 20.63 |
| 可学（≈4.5） | 34.6 | 10.1 | 21.6 | 22.10 |

**推理超参（RQ3）**：去噪步数与 CFG 都呈"先升后饱和/非单调"——1–2 步不够，4–8 步大幅提升，约 8–10 步即拿到大部分收益（block=16 时相当于相对 AR 的 1.6–2.0× 串行深度缩减），16 步后饱和；CFG 在 3–6 最佳，过强（>10）则扭曲去噪轨迹。

![Figure 9：推理超参影响。左：去噪步数早期增益大、约 8–10 步后饱和；右：CFG 中等值（3–6）最佳，过强则退化。](/vibe-reading/images/articles/cola-dlm-continuous-latent-diffusion/fig-09-inference-hyperparams.png)

**首块条件策略（§5.2，Table 5）**——首块是"已知 prompt 隐 + 待生成隐"的混合区，四种处理方式差距巨大：

| 策略 | LAMBADA | MMLU | SIQA | Avg |
|---|---|---|---|---|
| **Clean condition repaint（已知区固定为干净条件）** | **37.1** | **11.9** | **24.8** | **24.6** |
| Right padding | 24.7 | 11.5 | 13.8 | 16.7 |
| Left padding | 24.6 | 8.4 | 14.9 | 16.0 |
| Partial repaint（m=1, t=1） | 8.5 | 7.9 | 8.8 | 8.4 |

→ **强、持续的条件约束对首块混合去噪最优**，部分 repaint 大幅退化。

**最反直觉的发现（§5.1）**：**似然（PPL）与生成质量结构性不匹配**。Token 级证据（Table 4）：固定 logSNR 让 PPL 从 1.15e6 暴降到 245，但生成 token 却从 `on` 退化到 `in` 再到逗号。原因：生成只需先验质量覆盖"解码器有效区"，而似然估计额外要求在真值后验邻域做精确局部密度标定——两者目标不同。**这正是论文不用 PPL 评估、改用生成式评估的根据**。

![Figure 11：似然导向估计与生成质量的错配（局部视图）。上图：真值 token 邻域的局部隐几何；下图：对应先验密度景观。解码器探针成功率与后验命中高，但先验命中与密度对齐波动剧烈——生成靠覆盖"解码器有效区"，似然还要在真值后验邻域精确标定。](/vibe-reading/images/articles/cola-dlm-continuous-latent-diffusion/fig-11-likelihood-gen-mismatch.png)

## 8. 总结与展望

**贡献总结**：

1. 提出 Cola-DLM，从分层信息分解视角把文本生成拆成"全局语义建模 + 局部文本实现"，用连续隐空间的扩散先验把两者连起来——**新范式**。
2. 从统一马尔可夫路径视角刻画 Cola-DLM 相对 AR / LLaDA / Plaid 的优势（Table 1：唯一有"显式隐变量 + 先验搬运路径"的方法）。
3. 4 RQ、8 基准、~2B 匹配基线、~2000 EFLOPs 扩展曲线，系统验证核心主张并给出最佳配置（d=16、block=16、Joint DiT x1、BERT loss、可学 logSNR、loc=1、推理 16 步、CFG=7）。
4. 核心框架之外的分析：似然–生成不匹配、首块条件、隐压缩，并给出通往视觉等连续模态的初步证据。

**idea 三法落地（未来工作）**：

- **弥补缺陷**：当前 VAE **不压缩序列长度**（效率收益主要来自 block 去噪的并行，而非长度压缩）——做真正的隐压缩是下一个增益点；仅 ~2B 规模、单种子、绝对分低（多选题受生成式评估影响），需更大规模 + 多种子验证。
- **新型方案**：把"隐先验搬运"从文本扩展到视觉等连续模态（论文已给初步证据）——指向**离散文本与连续模态统一建模**的具体路径。
- **减少约束**：block-causal 已弱化从左到右的强偏置（块内并行、块间因果）；进一步放宽顺序约束（更大块 / 块内全并行）有望再提效。

**适用边界（批判性）**：Cola-DLM 的优势**不**由"扩散/连续"自动保证，而取决于数据是否具备"低维全局语义 + 高维局部实现"的结构（Eq. 3.35 三条曲线：表示率失真 $D(R)$、先验近似、推断 gap 皆可控）。若数据需高信息率才能高质量重建，激进压缩反而有害——**这是它相对 AR 不一定占优的场景**。
