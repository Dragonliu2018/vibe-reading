---
title: "LongCat-Video Technical Report"
source:
  type: "论文解读"
  project: "LongCat"
  url: "https://arxiv.org/abs/2510.22200"
  pdf: "/vibe-reading/papers/longcat-video-technical-report.pdf"
date: "2026-08-01T11:30:00+08:00"
category: [AI, Models, Video Model, Papers]
tags: ["Video Generation", "DiT", "GRPO", "Block Sparse Attention", "World Model", "Coarse-to-Fine"]
description: "目的：用单模型统一 T2V/I2V/Video-Continuation 并高效生成分钟级长视频。手段：13.6B DiT + 多任务统一输入 + 多奖励 GRPO + 粗到细 + 块稀疏注意力。结论：性能比肩闭源，720p/30fps 视频分钟内出图。"
readingTime: "18 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/longcat-video-technical-report.pdf" target="_blank" rel="noopener">预览</a> · **论文** [LongCat-Video Technical Report](https://arxiv.org/abs/2510.22200) · **作者** Meituan LongCat Team（Xunliang Cai, Qilong Huang, Zhuoliang Kang 等）· **发表** arXiv 2510.22200, 2025-10 · **项目** https://github.com/meituan-longcat/LongCat-Video · **解读** 2026-08-01

---

## 1. 论文概览

**一句话**：LongCat-Video 把 Text-to-Video、Image-to-Video、Video-Continuation 三件事统一成"给定若干条件帧预测未来帧"的单一任务，用一个 13.6B 参数的 DiT 模型搞定，并通过**多奖励 GRPO + 粗到细生成 + 块稀疏注意力**把质量与效率同时拉满。

- **任务**：通用视频生成，尤其长视频（分钟级）。
- **核心创新**：将 GRPO 引入 Flow Matching 的视频生成后训练，并用 4 项工程化技巧（固定关键时间步、截断噪声调度、损失重加权、最大组标准差）解决收敛慢与奖励优化不稳的问题；同时用块稀疏注意力把高分辨率阶段的注意力算力压到标准稠密注意力的 10% 以下。
- **结果**：在内部 T2V MOS 评测中 Overall Quality（3.48）优于 PixVerse-V5（3.38）与 Wan2.2-T2V-A14B（3.35）；在 VBench 2.0 总分 62.11%，仅次于 Veo3（66.72%）与 Vidu Q1（62.70%），且在 Commonsense 维度全场最高（70.94%）。代码与权重已开源。

**take-home**：视频生成的"统一多任务 + 长视频原生 + 高效推理"可以靠一个模型同时做到，关键不在堆参数而在——**多奖励 RLHF 对齐人类偏好**、**粗到细分阶段生成**、**可训练的稀疏注意力**这三件事的协同。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Video generation is a critical pathway toward world models, with efficient long video inference as a key capability. Toward this end, we introduce LongCat-Video, a foundational video generation model with 13.6B parameters, delivering strong performance across multiple video generation tasks. It particularly excels in efficient and high-quality long video generation, representing our first step toward world models. Key features include: Unified architecture for multiple tasks: Built on the Diffusion Transformer (DiT) framework, LongCat-Video supports Text-to-Video, Image-to-Video, and Video-Continuation tasks with a single model; Long video generation: Pretraining on Video-Continuation tasks enables LongCat-Video to maintain high quality and temporal coherence in the generation of minutes-long videos; Efficient inference: LongCat-Video generates 720p, 30fps videos within minutes by employing a coarse-to-fine generation strategy along both the temporal and spatial axes. Block Sparse Attention further enhances efficiency, particularly at high resolutions; Strong performance with multi-reward RLHF: Multi-reward RLHF training enables LongCat-Video to achieve performance on par with the latest closed-source and leading open-source models. Code and model weights are publicly available to accelerate progress in the field.

> **译：** 视频生成是通向世界模型的关键路径，而高效的长视频推理是其核心能力。为此我们提出 LongCat-Video——一个 13.6B 参数的基础视频生成模型，在多任务上表现强劲，尤其在高效、高质量长视频生成上突出，这是我们迈向世界模型的第一步。关键特性包括：统一架构支持多任务——基于 DiT 框架，单一模型支持 T2V、I2V、Video-Continuation；长视频生成——在 Video-Continuation 任务上预训练，使其能在分钟级长视频生成中保持高质量与时序连贯；高效推理——沿时间轴与空间轴采用粗到细策略，在分钟内生成 720p/30fps 视频，块稀疏注意力在高分辨率场景进一步提效；强性能与多奖励 RLHF——多奖励 RLHF 训练使其性能比肩最新闭源与领先开源模型。代码与权重已公开。

</details>

## 2. 研究背景

视频生成在过去两年取得突破（Veo、Sora、Seedance、Kling、Hailuo、PixVerse 等闭源，Wan、HunyuanVideo、Step-Video、CogVideoX 等开源），但要同时做到"**统一多任务 + 长视频 + 高效推理 + 高质量对齐**"仍有缺口：

| 缺口 | 现状 | LongCat-Video 的切入点 |
|---|---|---|
| 多任务统一 | T2V / I2V / 长视频续写往往用不同模型或微调 | 单模型、单输入格式，按条件帧数量区分任务 |
| 长视频 | 误差随时间累积、色彩漂移 | 在 Video-Continuation 任务上**原生预训练** |
| 高效推理 | 高分辨率注意力复杂度平方增长 | 粗到细（480p→720p）+ 块稀疏注意力（<10% 算力） |
| 人类偏好对齐 | 生成质量与人类偏好脱节 | 多奖励 GRPO（视觉质量 / 运动质量 / 文本对齐） |

**为什么需要这篇**：它把"统一、长视频、高效、对齐"四件事在一个开源模型里一次性解决，并给出了 GRPO 用于视频 Flow Matching 的工程化方法论（这正是业界最缺的"怎么把 RLHF 落到视频生成"的实操指南）。

## 3. 方法详解

LongCat-Video 的方法由四块组成：统一架构、多奖励 GRPO 训练、高效视频生成。整体训练流程分三阶段。

### 3.1 模型架构与统一输入

网络采用标准 DiT 单流 transformer block，每块含 3D self-attention + 文本 cross-attention + SwiGLU FFN，用 AdaLN-Zero 调制、RMSNorm 做 QKNorm、3D RoPE 位置编码。规格：48 层、hidden 4096、FFN 16384、32 头。VAE 用 WAN2.1（时间 4×、空间 8×8 压缩），DiT 内 patchify 再 1×2×2 压缩，总压缩比 4×16×16；文本编码器用 umT5（中英双语）。

**统一输入表示**是核心设计——把 T2V / I2V / Video-Continuation 都定义为"给定条件帧预测未来帧"，区别只在条件帧数量：

- 输入 $X = [X_\text{cond}, X_\text{noisy}]$，条件帧 $X_\text{cond}$（无噪声）与待去噪帧 $X_\text{noisy}$ 沿时间轴拼接。
- 时间步 $t = [t_\text{cond}, t_\text{noisy}]$，条件帧 $t_\text{cond} = 0$（注入无损信息），$t_\text{noisy} \sim [0,1]$。
- 损失计算时跳过条件帧贡献。

![Figure 5：统一 transformer 与 Block Causal Attention。左：单一模型同时支持 T2V（零条件帧）、I2V（一帧）、Video-Continuation（多帧），时间步与输入一致、条件部分固定为 0。右：Block Causal Attention——条件 token 的更新独立于噪声 token，cross-attention 中条件 token 不参与。](/vibe-reading/images/articles/longcat-video-technical-report/fig-05-unified-transformer.png)

配套的 **Block Attention with KVCache** 让条件 token 不受噪声 token 影响，且条件 token 的 KV 特征可在所有采样步复用——这对长视频生成尤其关键（条件帧编码一次，后续全部复用）：

$$
X_\text{cond} = \text{Attention}(Q_\text{cond}, K_\text{cond}, V_\text{cond})
$$

$$
X_\text{noisy} = \text{Attention}(Q_\text{noisy}, [K_\text{cond}, K_\text{noisy}], [V_\text{cond}, V_\text{noisy}])
$$

### 3.2 多奖励 GRPO 训练

GRPO 用于 Flow Matching 的最大挑战是**收敛慢、奖励优化复杂**。论文的关键洞察是：**GRPO 本质上是在做随机噪声搜索**——用相对优势 $\hat{A}_t$ 和 SDE 采样噪声 $\epsilon$ 近似奖励对速度场的梯度。

$$
\nabla_\theta \mathcal{L}_\text{policy, reweighted}(\theta) = -\frac{3}{2}\, \hat{A}_t \cdot \epsilon \cdot \nabla_\theta v_\theta
$$

这源于链式分解 $dR/d\theta = (dR/dv_\theta) \cdot (dv_\theta/d\theta)$，GRPO 提供了 $dR/dv_\theta \approx -\frac{3}{2}\hat{A}_t \cdot \epsilon$。基于此，论文设计了 4 项工程化技巧：

| 技巧 | 解决的问题 | 做法 |
|---|---|---|
| 固定关键时间步 | 奖励被均匀分到所有时间步，信用分配模糊 | 同一 prompt 共享初始噪声，只在一个随机 $t'$ 用 SDE，其余用 ODE |
| 截断噪声调度 | 放大噪声系数 $a=1$ 在 $t\to1$ 时 $\sigma_t\sqrt{\Delta t}$ 过大导致不稳 | 扩散系数超过阈值 $\tau=0.45$ 时裁剪 |
| 损失重加权 | $t\to1$ 时梯度消失、$\Delta t$ 小进一步抑制 | $\lambda_\text{policy} = \sqrt{t/(\Delta t(1-t))}$ 抵消尺度依赖 |
| 最大组标准差 | 小标准差组的优势估计不可靠 | 用所有组的最大标准差替代组内标准差 |

**多奖励训练**用的是加权相对优势——多个奖励的梯度链式分解可合并为单项的加权和，因此策略损失变为：

$$
\mathcal{L}_\text{policy, multi}(\theta) = r_t^i(\theta) \cdot \sum_{k=1}^{n} w_k \cdot \hat{A}_{k,t}^i
$$

三个奖励模型各司其职，且**相互制约防止单一奖励被 hack**：

![Figure 9：单奖励 vs 多奖励。仅用 HPSv3 会出现 reward hacking（运动奖励被牺牲、模型倾向生成静态画面）；多奖励训练通过建立奖励间平衡来防止任一奖励被过度优化。](/vibe-reading/images/articles/longcat-video-technical-report/fig-09-reward-hacking.png)

- **视觉质量（VQ）**：HPSv3——HPSv3-general（通用 prompt 评视觉）+ HPSv3-percentile（用视频 caption 评文本对齐，取前 30% 帧均值）。
- **运动质量（MQ）**：VideoAlign 微调模型，**灰度视频**训练与推理以消除颜色偏好。
- **文本对齐（TA）**：VideoAlign 微调模型，保留 RGB 以评估文本-视频语义对应。

### 3.3 高效视频生成

推理效率靠三招叠加（Table 2）：LCM 蒸馏（50 步→16 步）+ 粗到细（480p/15fps→720p/30fps）+ 块稀疏注意力。组合后 720p×93 帧从 1429.5s 降到 116.5s，**12.3× 加速**。

![Figure 11：T2V / I2V / Video-Continuation 三任务的粗到细生成流程。绿箭头为低分辨率生成阶段，橙箭头为精化阶段。I2V 与 VC 在精化阶段额外处理条件帧。](/vibe-reading/images/articles/longcat-video-technical-report/fig-11-c2f-process.png)

**粗到细**不仅提效，还提质量——精化专家（LoRA）在 base 模型知识上微调，用 Flow Matching 学习"480p 上采样分布→720p 分布"的映射，$t_\text{thresh}=0.5$、只需 5 步：

![Figure 10：原生 480p、原生 720p 与粗到细 720p 生成对比。粗到细产出的纹理细节与质量超过原生 720p，还能修正局部畸变。](/vibe-reading/images/articles/longcat-video-technical-report/fig-10-c2f-comparison.png)

**块稀疏注意力（BSA）**是另一关键——3D 块划分后，用池化 query 对所有 key 块打分，选 top-r 块计算标准 attention，把算力压到 10% 以下且近无损。BSA 开源了前向与反向实现，支持 ring 版本的 context parallelism。

![Figure 12：3D 块稀疏注意力。(a) 将 query 与所有 key 划分为不重叠 3D 块，用均值计算 query 块与各 key 块的相似度；(b) 选 top-r 相似度最高的 key 块；(c) 只在选定块内计算标准 attention。](/vibe-reading/images/articles/longcat-video-technical-report/fig-12-block-sparse-attention.png)

### 3.4 整体训练流程

![Figure 13：整体训练流程。Base model 训练含渐进预训练 + SFT；RLHF 训练用 GRPO（LoRA）；加速训练含蒸馏 LoRA 与精化专家 LoRA。后两阶段都用 LoRA 以便叠加扩展。](/vibe-reading/images/articles/longcat-video-technical-report/fig-13-training-process.png)

三阶段：(1) **Base model 训练**——Flow Matching + 渐进预训练（256p 图像→256p 视频→480p/720p 多任务）+ SFT；(2) **RLHF 训练**——多奖励 GRPO，用 LoRA（仅 T2V 任务，泛化到 I2V/VC）；(3) **加速训练**——CFG 蒸馏 + CM 蒸馏（16 步）+ 精化专家 LoRA。后两阶段统一用 LoRA 机制，便于叠加。

## 4. 关键公式解读

**(1) Flow Matching 训练目标**——线性插值 + 速度场 MSE：

$$
x_t = (1-t)\,x_0 + t\,\epsilon, \qquad v_t = x_0 - \epsilon
$$

$$
\mathcal{L} = \mathbb{E}_{\epsilon, x_0, c, t}\, \left\| v_\text{pred}(x_t, c, t; \theta) - v_t \right\|^2
$$

**(2) GRPO 策略梯度（重加权后）**——揭示 GRPO 在 Flow Matching 中做随机噪声搜索：

$$
\nabla_\theta \mathcal{L}_\text{policy, reweighted} = -\underbrace{\frac{3}{2}}_{\text{链式系数}}\, \hat{A}_t \cdot \underbrace{\epsilon}_{\text{SDE 噪声}} \cdot \nabla_\theta v_\theta
$$

**(3) 多奖励合并**——链式分解后多奖励梯度等于单项加权和：

$$
\nabla_\theta J_\text{total} = -\frac{3}{2} \left(\sum_{k=1}^{n} w_k \cdot \hat{A}_{k,t}\right) \cdot \epsilon \cdot \nabla_\theta v_\theta
$$

**(4) 损失重加权系数**——抵消 $t\to1$ 的梯度消失与小步长抑制：

$$
\lambda_\text{policy}(t, \Delta t) = \sqrt{\frac{t}{\Delta t(1-t)}}
$$

## 5. 实验设置

- **内部 benchmark**：1,628 样本——1,228 T2V（500 人工 + 728 自动）、400 I2V。4 维评估（Text-Alignment / Visual Quality / Motion Quality / Overall Quality），I2V 额加 Image-Alignment。
- **评价协议**：人工（MOS 5 分制 + GSB 两两对比，最终分 = 人工:自动 2:1 加权）+ 自动（vision-language judge 模型，与人工相关性 >0.92）。
- **公开 benchmark**：VBench 2.0（Creativity / Commonsense / Controllability / Human Fidelity / Physics / Total）。
- **基线**：T2V 对比 Veo3、PixVerse-V5、Wan2.2-T2V-A14B；I2V 对比 Seedance 1.0、Hailuo-02、Wan2.2-I2V-A14B。
- **GRPO 设置**：group size 4、16 步采样、SDE 步范围 [0,6]、CFG=4、LR 1e-4、LoRA dim 128、仅 0.5k 迭代。
- **训练基础设施**：DeepSpeed-Zero2 + Context Parallelism + Ring Attention + 激活检查点，MFU 33–38%。
- **复现性**：代码与权重已开源（https://github.com/meituan-longcat/LongCat-Video），BSA 前向/反向实现一并开源。

## 6. 实验结果

### Text-to-Video

内部 MOS 评测（Figure 14）：LongCat-Video 在 Overall Quality（3.48）上超越 PixVerse-V5（3.38）与 Wan2.2-T2V-A14B（3.35），Visual Quality 近乎与 Wan2.2 持平，Text-Alignment 仅次于 Veo3。

![Figure 14：内部 benchmark 的 Text-to-Video MOS 评测结果。LongCat-Video 在 Overall Quality 上领先 PixVerse-V5 与 Wan2.2，Visual Quality 与 Wan2.2 接近。](/vibe-reading/images/articles/longcat-video-technical-report/fig-14-t2v-mos.png)

| 模型 | Text-Alignment | Visual Quality | Motion Quality | Overall Quality |
|---|---|---|---|---|
| Veo3 | **3.99** | 3.70 | 3.76 | 3.36 |
| PixVerse-V5 | 3.81 | 3.13 | 3.25 | 3.38 |
| Wan2.2-T2V-A14B | 3.70 | **3.26** | **3.78** | 3.35 |
| **LongCat-Video** | 3.76 | 3.23 | 3.74 | **3.48** |

GSB 两两对比（Figure 15）：vs PixVerse-V5 近乎打平（242 vs 246），vs Wan2.2 则有明显优势，尤其在 Text-Alignment 与 Motion Quality 上领先。

![Figure 15：内部 benchmark 的 Text-to-Video GSB 两两对比结果。LongCat-Video vs PixVerse-V5 总体近乎打平，Visual Quality 占优；vs Wan2.2-T2V-A14B 总体明显胜出。](/vibe-reading/images/articles/longcat-video-technical-report/fig-15-t2v-gsb.png)

### Image-to-Video

I2V MOS：LongCat 在 Visual Quality（3.27）最高，但 Image-Alignment（4.04）与 Motion Quality（3.59）低于 Seedance 1.0 / Hailuo-02 / Wan2.2-I2V，Overall（3.17）落后于 Seedance（3.35）——说明视觉保真度强，但时序一致性与源图对齐仍有提升空间。

### VBench 2.0

| 模型 | 类型 | Creativity | Commonsense | Controllability | Human Fidelity | Physics | Total |
|---|---|---|---|---|---|---|---|
| Veo3 | 闭源 | 60.85% | 69.48% | **47.04%** | **86.88%** | 69.35% | **66.72%** |
| Vidu Q1 | 闭源 | 56.54% | 65.98% | 38.13% | 81.24% | **71.63%** | 62.70% |
| **LongCat-Video** | 开源 | 54.73% | **70.94%** | 44.79% | 80.20% | 59.92% | 62.11% |
| Wan2.1 | 开源 | 55.25% | 63.98% | 37.32% | 81.60% | 62.84% | 60.20% |

LongCat-Video 总分第二（仅次于 Veo3 与 Vidu Q1），在 **Commonsense 维度全场最高（70.94%）**——运动合理性与物理规律理解突出，这与其长视频生成能力一脉相承，也是迈向世界模型的关键优势。

## 7. 消融与关键发现

**GRPO 技巧消融**（Figure 7）：损失重加权与最大组标准差都对训练稳定性有显著贡献。

![Figure 7：GRPO 消融。(a) 策略与 KL 损失重加权的效果；(b) 最大组标准差的效果。两者均显著提升训练稳定性。](/vibe-reading/images/articles/longcat-video-technical-report/fig-07-grpo-ablation.png)

**多奖励训练曲线**（Figure 8）：多奖励 GRHF 训练中各奖励曲线同步上升，印证多奖励协同提升。

![Figure 8：LongCat-Video 多奖励训练的 GRPO 奖励曲线。多奖励协同上升，各维度质量同步改善。](/vibe-reading/images/articles/longcat-video-technical-report/fig-08-reward-curves.png)

**最反直觉的发现**——**单奖励 hacking**：仅用 HPSv3 训练会让模型向静态画面偏移（运动奖励被牺牲），而多奖励训练通过建立奖励间平衡来防止 reward hacking。这印证了"多奖励互制即正则化"的设计直觉。

**粗到细的额外收益**：粗到细不仅省算力（720p×93 帧 16/5 步 10.1× 加速），还提升质量——精化阶段能修正低分辨率阶段的局部畸变，纹理细节甚至超过原生 720p。

**BSA 近无损**：93.75% 稀疏度下保持近无损生成质量；top-r 模式在可训练场景下优于 CDF-p 模式（后者因各 query 选的 key 块数不同带来时间成本）。

## 8. 总结与展望

**贡献总结**：

1. **统一多任务**：单模型 + 统一输入格式（按条件帧数量区分 T2V/I2V/VC），原生预训练 VC 任务实现分钟级长视频。
2. **GRPO 工程化方法论**：4 项技巧（固定关键时间步 / 截断噪声调度 / 损失重加权 / 最大组标准差）系统解决 GRPO 用于视频 Flow Matching 的收敛与稳定性问题，并开源。
3. **高效推理三件套**：粗到细 + BSA + 蒸馏，12.3× 加速，720p/30fps 分钟内出图。
4. **开源**：代码、权重、BSA 前向/反向实现全部开源。

**局限性（批判性）**：

- GRPO **仅用 T2V 任务**训练，I2V/VC 的提升靠泛化——论文也承认"为各任务设计专属奖励（如 VC 的质量退化惩罚）仍是未来工作"。
- BSA 稀疏度 93.75% 下"近无损"的声明主要在精化阶段验证，对极长序列的退化行为未充分讨论。
- I2V 的 Overall Quality 落后 Seedance 1.0，Image-Alignment 与 Motion Quality 不占优——说明条件帧对齐与时序一致性仍有差距。
- VBench Physics 维度（59.92%）偏低，物理模拟仍是短板（与 Commonsense 高分形成对比，提示"常识理解"强于"物理建模"）。

**未来方向（idea 三法）**：

- **弥补缺陷**：为 VC 任务引入"长视频质量退化惩罚"奖励、为 I2V 引入"源图对齐"专属奖励，做任务感知的多奖励 GRPO。
- **新型方案**：论文称"高效长视频生成解决了世界模型的渲染问题"——下一步是**多模态记忆整合**与**LLM/MLLM 知识注入**，让模型不仅"会画"还"懂物理"。
- **减少约束**：当前粗到细仍依赖固定 $t_\text{thresh}=0.5$；自适应确定精化起点、或将 BSA 稀疏度按内容动态调整，有望在质量-效率曲线上再前进一步。

**适用边界**：LongCat-Video 的优势不由"DiT/Flow Matching"自动保证，而取决于多奖励 RLHF 的对齐质量与 BSA 在目标分辨率下的稀疏度-质量权衡。若场景需极高物理一致性（如自动驾驶仿真），Physics 维度偏低的短板需额外补偿。

## 相关阅读

- [LongCat-Image Technical Report](/vibe-reading/articles/longcat-image-technical-report) — **同家族**·图像生成姊妹模型，同栈 DiT + 多奖励 RLHF（GRPO/DPO/MPO），横向对照"统一多任务 + 多奖励对齐"方法论在图像侧的落地
- [FireRed-Image-Edit-1.0 Technical Report](/vibe-reading/articles/firered-image-edit) — **方法论镜像**·扩散 Transformer + 多阶段 RLHF/DPO，与本篇多奖励 GRPO 的"奖励互制防 hacking"设计直觉直接对照
- [LongCat-AudioDiT: High-Fidelity Diffusion TTS](/vibe-reading/articles/longcat-audiodit-waveform-latent-diffusion-tts) — **同家族**·音频侧的波形潜空间扩散 TTS，同用 Flow Matching，与本篇共享扩散训练范式
- [LongCat Sparse Attention](/vibe-reading/articles/longcat-sparse-attention) — **背景知识**·同家族文本模型的长上下文稀疏注意力（LSA），与本篇 BSA（Block Sparse Attention）同名但机制不同——前者面向 LLM 长序列、后者面向视频 DiT 高分辨率，可对照两类稀疏注意力的设计取舍
