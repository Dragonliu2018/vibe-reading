---
title: "Kimi K3: Open Frontier Intelligence"
source:
  type: "论文解读"
  project: "Kimi"
  url: "https://github.com/MoonshotAI/Kimi-K3"
  pdf: "/vibe-reading/papers/kimi-k3-technical-report.pdf"
date: "2026-07-28T14:30:00+08:00"
category: [AI, Models, Text Model, Papers]
tags: ["Kimi K3", "MoE", "KDA", "Attention Residuals", "Stable LatentMoE", "Agentic RL", "1M Context", "Open Weights"]
description: "目的：开源 3T 级前沿模型。手段：2.8T MoE + KDA/AttnRes/Stable LatentMoE 架构三轴扩展 + 1M 上下文多努力度 agentic RL + 系统协同设计。结论：综合效率较 Kimi K2 提升 2.5×，在编码/智能体/知识/推理/视觉全面逼近闭源前沿，开源权重全面开放。"
readingTime: "28 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/kimi-k3-technical-report.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Kimi K3: Open Frontier Intelligence](https://github.com/MoonshotAI/Kimi-K3) · **作者** Kimi Team (Moonshot AI) · **发表** 2026-07 · **项目** https://github.com/MoonshotAI/Kimi-K3 · **解读** 2026-07-28

---

## 1. 论文概览

**一句话**：Kimi K3 把"预训练参数规模"与"测试时计算"两条 scaling 轴同时推向开源前沿——首个开源 3T 级（2.8T 总参 / 104B 激活）原生多模态 MoE，配 1M token 上下文的多努力度 agentic RL，在编码、智能体、知识、推理、视觉五大轴上逼近 Claude Fable 5 与 GPT-5.6 Sol，并全面开放权重。

- **任务**：开放前沿基础模型——长程编码、通用智能体、知识工作、推理、视觉一体化，1M 上下文窗口内的长程 agentic 执行。
- **核心创新**：(1) 架构三轴扩展——Kimi Delta Attention（KDA）+ Attention Residuals（AttnRes）+ Stable LatentMoE（896 专家 / 16 激活）；(2) 多努力度 agentic RL——9 个领域×努力度专家模型经多教师在线蒸馏（MOPD）合并为统一模型；(3) 3T 级 + 1M 上下文的系统协同设计（MoonEP、KCP、AgentENV 微 VM 沙箱、KDA-aware 前缀缓存）。
- **结果**：整体 scaling 效率较 Kimi K2 提升约 **2.5×**；在所评基准上紧随 Claude Fable 5、GPT-5.6 Sol，稳超 Claude Opus 4.8、GPT-5.5、GLM-5.2；WebDev Arena 开源模型首次登顶（1678 Elo）。完整权重开放。

**take-home**：开源社区在"第二轴"（测试时推理/RL）进展迅速，却长期停留在 1T 级"第一轴"。Kimi K3 同时押注两条轴：把预训练底座推到 3T，并把 RL 从单域单努力度扩展到跨域多努力度再蒸馏合一——其工程量不在算法 novelty，而在**让 2.8T MoE + 1M 上下文 + 百万 token agentic trajectory 在有限 GPU 预算下训得动、推得起**。整篇报告本质是一份"算法-系统协同设计"的工程答卷。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We introduce Kimi K3, a 2.8T parameter Mixture-of-Experts model with 104 billion activated parameters, native vision capabilities, and a 1-million-token context window. Kimi K3 is built on Kimi Delta Attention and Attention Residuals, which improve information flow across sequence length and model depth. Together with Stable LatentMoE, which effectively activates 16 of 896 routed experts per token, and refined training and data recipes, these advances yield an approximately 2.5× improvement in overall scaling efficiency over Kimi K2. Post-training highlights reinforcement learning across general, agentic, and coding domains and multiple reasoning-effort levels, enabling compositional generalization and robust long-horizon execution. At 2.8T scale, Kimi K3 is supported by infrastructure advances in multiple areas: algorithm–system co-design for KDA, perfectly balanced expert-parallel training with efficient memory management, million-token agentic RL with persistent rollout and sandbox states, and deployment innovations. Extensive evaluations show that Kimi K3 achieves frontier-level performance across long-horizon coding, agentic, knowledge, reasoning, and vision tasks. While its overall performance still trails the most powerful proprietary models, namely Claude Fable 5 and GPT-5.6 Sol, Kimi K3 consistently outperforms other open and proprietary models evaluated in our suite. We release the full Kimi K3 model weights to facilitate future research and accelerate the broader deployment and adoption of frontier intelligence.

> **译：** 我们提出 Kimi K3，一个 2.8T 参数的 Mixture-of-Experts 模型，激活参数 104B，具备原生视觉能力与 1M token 上下文窗口。Kimi K3 构建于 Kimi Delta Attention 与 Attention Residuals 之上，二者分别改善了跨序列长度与跨模型深度的信息流。配合 Stable LatentMoE（每 token 激活 896 路由专家中的 16 个）以及精炼的训练与数据配方，这些进展使整体 scaling 效率较 Kimi K2 提升约 2.5×。后训练阶段在通用、智能体、编码三大域及多个推理努力度级别上开展强化学习，赋予模型组合泛化与稳健的长程执行能力。在 2.8T 规模下，Kimi K3 得益于多方面基础设施进展：KDA 的算法-系统协同设计、完美均衡的专家并行训练与高效内存管理、带持久 rollout 与沙箱状态的百万 token agentic RL，以及部署侧创新。广泛评估表明 Kimi K3 在长程编码、智能体、知识、推理与视觉任务上达到前沿水平。尽管整体性能仍略逊于最强闭源模型（Claude Fable 5 与 GPT-5.6 Sol），Kimi K3 在所评开源与闭源模型中稳居第一梯队。我们发布完整的 Kimi K3 模型权重，以推动未来研究并加速前沿智能的广泛部署与采用。

</details>

## 2. 研究背景

LLM 的 scaling 长期被理解为两条轴：**第一轴**是部署前的训练规模（更大模型 + 更多数据），**第二轴**是测试时计算（RL + 推理 effort）。开源生态在第二轴上突飞猛进——o-series、DeepSeek-R1、Kimi K1.5、Kimi K2.5 Agent Swarm 相继把测试时 scaling 推到前沿；但在第一轴上，多数开源模型仍停留在 1T 级附近。

| 维度 | 开源现状 | Kimi K3 的应对 |
|---|---|---|
| **预训练规模** | 多数模型 ≤1T 参数，把更强的 RL 套在相近规模底座上 | 把底座推到 2.8T / 104B 激活，1M 上下文 |
| **架构信息流** | 单一注意力机制，深度方向仅靠顺序残差累积 | KDA（序列轴）+ AttnRes（深度轴）+ LatentMoE（宽度轴）三轴扩展 |
| **极端稀疏 MoE** | 专家数与激活数同时增大，激活爆炸 + 负载失衡 | Stable LatentMoE：归一化 + SiTU-GLU + Quantile Balancing |
| **长程 agentic RL** | 单域单努力度，trajectory 短 | 跨 3 域 × 3 努力度 = 9 专家，MOPD 合并；百万 token trajectory |
| **3T + 1M 工程可行性** | 训练内存爆炸、推理双缓存难管 | MoonEP 完美均衡、KCP、AgentENV、KDA-aware 前缀缓存 |

论文的核心论点：**当开源在第二轴趋同、第一轴停滞时，与闭源的差距会重新拉开**。Kimi K3 选择同时押注两轴——而真正难的不是堆参数，而是让 2.8T MoE + 1M 上下文在训练与推理两端都"算得动"。

## 3. 方法详解

Kimi K3 架构围绕**信息流的三轴扩展**设计：序列长度（Hybrid KDA-MLA）、网络深度（Attention Residuals）、模型宽度（Stable LatentMoE），并接入原生视觉通路（MoonViT-V2）与 Per-Head Muon 优化器。

![Figure 2：Kimi K3 架构。围绕 token / channel / layer 三轴混合组织，输入端有原生视觉通路。每个 block 含 3 层 KDA + 1 层 Gated MLA，每层注意力后接 Stable LatentMoE 前馈网络。AttnRes 用可学习伪查询 w 在 embedding 与先前 block 输出上推导注意力权重 α，实现跨深度的选择性信息流。左上：Stable LatentMoE 的共享/路由专家结构；左下：KDA 模块；右下：原生视觉通路。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-02-architecture.png)

### 3.1 Hybrid Attention：3 KDA + 1 Gated MLA

每个 block 由 **3 层 KDA + 1 层 Gated MLA** 组成（3:1 混合比），骨干末尾再加一层 Gated MLA 保证最终层为全局注意力。

- **KDA（Kimi Delta Attention）**：把 delta-rule 递推 [105, 138] 扩展一个 channel-wise 遗忘门 [63]。对单头，状态递推为：

  $$
  S_t = \underbrace{\left(I - \beta_t k_t k_t^\top\right)}_{\text{delta write}} \operatorname{Diag}(\alpha_t)\, S_{t-1} + \beta_t k_t v_t^\top,\quad \tilde{o}_t = S_t^\top q_t
  $$

  其中 $\alpha_t \in (0,1)^{d_k}$ 是 channel-wise 一步保留因子，$\beta_t \in (0,1)$ 控制 delta-rule 写入强度。KDA 在 chunk 内并行、chunk 间递推，用固定大小 recurrent state $S \in \mathbb{R}^{d_k \times d_v}$ 取代 softmax 注意力不断增长的 KV cache——状态固定，传输与复用都很便宜。

- **Gated MLA**：DeepSeek-V2 [28] 引入的多头 latent attention，把每 token 的 KV 压缩成低维 latent $c_t = W_c x_t$，只在 cache 里存 $c_t$。Kimi K3 在周期性全局注意力层保留 MLA，并对 MLA 层施加 **NoPE（无显式位置编码）**——位置信息由 KDA 层的递推门控隐式编码，MLA 只负责无约束的全局内容交互。好处：扩展上下文时无需调 RoPE 频率基或套 YaRN。此外给 MLA 加了 input-dependent 全秩输出门。

### 3.2 Lower-Bounded Decay：让 KDA 的对角块也能用 Tensor Core

KDA chunkwise 形式里，chunk 内 token 要按累积衰减 $\Gamma_{1\to C}$ 重缩放 keys。由于 $\Gamma$ 是 $(0,1)$ 内保留因子的乘积，其倒数会无界增长、在有限精度下溢出。Kimi Linear 用对数空间 + 16-token 二级分块控制；但**对角块仍需显式 position-pair 计算**，成为 chunk 内主瓶颈。

Kimi K3 的解法：把 decay logit $z$ 到 log-decay $g$ 的映射从无下界的负 Softplus 换成**有下界的缩放 sigmoid**：

$$
g_t^h = g_{\min} \operatorname{Sigmoid}(e^{A_h} z_t^h) \in (g_{\min}, 0)^{d_k},\quad \alpha_t^h = \exp(g_t^h) \in (e^{g_{\min}}, 1)^{d_k}
$$

取 $g_{\min}=-5$，则每个保留因子 $\alpha > e^{-5} \approx 6.7\times10^{-3}$，16-token tile 的累积 log-decay 落在 $(-80, 0)$，倒数重缩放因子小于 $e^{80}$，仍在 BF16 动态范围内。**这一有限范围让对角块与 off-diagonal 块都能用 dense Tensor Core 矩阵乘**，消除了 position-pair 对角路径。

![Figure 3：下界衰减及其对 chunkwise KDA 计算的影响。(a) Kimi Linear 用无下界的负 Softplus 映射，Kimi K3 用缩放 sigmoid 限定 log-decay 下界；曲线展示 A=0、gmin=−5。(b) Kimi Linear 的对角块需显式 position-pair 计算，而 Kimi K3 的有界范围让所有因果块都能用 dense Tensor Core 矩阵乘。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-03-lower-bounded-decay.png)

> **工程意义**：这是一个"改数学映射以换 kernel 形态"的典型协同设计——不是为了精度，而是为了让递推形式能塞进 GPU 偏好的宽而均匀的并行形态。

### 3.3 Attention Residuals（AttnRes）：把"深度"也变成注意力

标准残差连接把所有先前信息压缩进单一状态 $h_l$——一个 reminiscent of RNN-over-time 的瓶颈。Transformer 用注意力取代了时间维的递推，让每个位置选择性访问所有先前位置；AttnRes 把同一思路用到**深度维**：每层选择性从所有先前层检索表示，而非均匀累加。

- **Full AttnRes**：对层 $l$，定义层特定可学习伪查询 $q_l = w_l$，keys/values 取自 embedding（$h_1$）与各先前层输出 $f_i(h_i)$。注意力用 softmax 核 $\phi(q,k)=\exp(q^\top \operatorname{RMSNorm}(k))$，RMSNorm 防止大范数层主导权重。
- **Block AttnRes**：为降低 $O(Ld)$ 内存与流水线通信开销，把 $L$ 层分成 $N$ 个 block（每 block $S=L/N$ 层）。block 内做求和压缩 $b_n$，跨 block 做注意力。最终输出层聚合所有 $N$ 个 block 表示。Kimi K3 取 $N=8$、block 大小 12（含 embedding 层共 9 个 block）。Block 结构还约束了推理时状态，使 block 间并行结果能与 block 内顺序部分和通过 online softmax 合并。

### 3.4 Stable LatentMoE：极端稀疏下的稳定化

LatentMoE [32] 把全模型宽度与路由专家宽度解耦：共享专家保留全宽路径，路由专家在紧凑 latent 空间（宽度 $\ell$）操作。这让 Kimi K3 能扩到 **896 路由专家 / 16 激活**（稀疏度 56）。但极端稀疏放大了两个失效模式：

1. **激活爆炸**：路由路径是 $W_\downarrow$ → 门控多分支 FFN → $W_\uparrow$ 近四连乘，在 2.8T 规模下内部激活爆炸。
2. **负载失衡**：平衡近 $10^3$ 个专家超出 auxiliary-loss-free bias 更新的良好行为区间。

Stable LatentMoE 用三个组件应对：上投影前插 **RMSNorm**、**SiTU-GLU** 激活、**Quantile Balancing（QB）** 负载均衡。

![Figure 4：GLU、SwiGLU、SiTU-GLU 的门控分支与上分支及其标量响应，σ 为 sigmoid。所有曲线共享 x∈[−10,100] 定义域，插图为原点附近放大。SiTU-GLU（红，β1=4、β2=25）在原点附近紧贴 SwiGLU，在大正输入处趋近界 |f(x)|≤β1β2=100，而 SwiGLU 无界。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-04-situ-glu.png)

**SiTU-GLU**：SwiGLU 的两个乘法因子都无界，重合的大坐标会产生激活异常点、增加低精度溢出风险。SiTU-GLU 对 Swish 门控的线性因子与上分支各施加 smooth cap $\operatorname{softcap}(x,\beta)=\beta\tanh(x/\beta)$：

$$
\operatorname{SiTU-GLU}(x) = \left[\beta_1 \tanh\!\left(\frac{W_g x}{\beta_1}\right) \odot \operatorname{Sigmoid}(W_g x)\right] \odot \left[\beta_2 \tanh\!\left(\frac{W_u x}{\beta_2}\right)\right]
$$

Kimi K3 取 $\beta_1=4$（gate 分支）、$\beta_2=25$（up 分支）。缩放 tanh 在原点附近近似线性、大范数处有界，既保留 SwiGLU 的局部与正侧响应，又控制了乘积两因子。

**Quantile Balancing（QB）**：Kimi K3 采用 auxiliary-loss-free 路由 [30]——给 router score 加专家偏置 $b$ 做 Top-k，但 $b$ 不进 mixture 权重。原方法用固定步长 $b^{(t+1)}_j = b^{(t)}_j + \gamma\,\operatorname{sign}(\bar\ell - \ell^{(t)}_j)$ 更新偏置，$\gamma$ 在慢适应与负载震荡间取舍；专家数到 896 时已难维持平衡。QB 从单次前向的 router-score 分位数推导每个专家偏置：用 Top-$(k+1)$ 路由取 cutoff $\alpha^{(t)}_i$，令专家 $j$ 的目标负载 $q=mk/n$ 对应 margin $s_{i,j}-\alpha^{(t)}_i$ 的 $(1-k/n)$ 分位数：

$$
\tilde b^{(t+1)}_j \leftarrow -\operatorname{quantile}_{1-k/n}\!\left(s_{:,j} - \alpha^{(t)}\right),\quad b^{(t+1)} \leftarrow \tilde b^{(t+1)} - \operatorname{mean}(\tilde b^{(t+1)})\mathbf{1}
$$

大规模下用直方图估计分位数（一次 all-reduce 汇总 bin 计数，通信成本仅每专家几百 bin），推理时偏置冻结。

![Figure 5：Quantile Balancing 示意，m=8 tokens、n=4 路由专家、k=1。(a) token-wise Top-k 路由产生负载 (4,3,1,0)，深色圆为过热专家、虚线为欠利用/濒死专家。(b) 每个灰条是当前偏置下 margin si,j+b(t)j−α(t)i，列内虚红线是偏置调整量，置于第 (q+1) 大 margin 处使恰好 q=2 个 margin 超过它。(c) ⋆ 为减去列调整后的行内 Top-k 选择，得到均衡负载 (2,2,2,2)，红边为被 QB 改变的分配。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-05-quantile-balancing.png)

### 3.5 原生视觉：MoonViT-V2 从零训练

Kimi K3 原生多模态：文本、图像、视频由单一共享 backbone 在同一上下文内处理，无事后模态对齐阶段。视觉编码器 **MoonViT-V2**（27 层 ViT，约 0.4B 参数）的一个关键 departure 是**完全从零用 next-token prediction 训练**，而非像 Kimi K2.5 那样从 SigLIP 等对比预训练初始化。原因在于训练稳定性：SigLIP 初始化的 MoonViT-3D 接到 LLM 后联合优化不稳定，梯度范数持续偏高且频繁尖刺；从零训练的 MoonViT-V2 全程稳定。且 next-token prediction 让编码器表示直接由语言建模目标塑形，而非偏向全局语义的对比损失。实验表明 MoonViT-V2 在视觉评估上与 SigLIP 初始化基线相当——说明对比预训练作为多模态 LLM 初始化并非必要。

![Figure 6：预训练消融中的视觉塔梯度范数。与 SigLIP 初始化的 MoonViT-3D 相比，从零训练的 MoonViT-V2 维持更低梯度范数、更少尖刺，优化更稳定。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-06-vision-gradient-norm.png)

### 3.6 Per-Head Muon 优化器

Kimi K3 沿用 Kimi K2 的 Muon [53] 作为矩阵参数优化器，并细化为 **per-head 变体**：对 Q/K/V 投影矩阵，沿 head 维切分动量矩阵、对每个 head 块分别做 Newton–Schulz 正交化，而非整矩阵正交化。直觉：整矩阵正交化把所有 head 当成耦合块，大梯度/大动量 head 主导共享更新方向，小 scale head 归一化不足；per-head 正交化均衡各 head 更新尺度，提升大尺度下训练稳定性，并略微降低优化器开销。

## 4. 关键公式解读

KDA 的 chunkwise 并行形式（论文式 4）是理解 KDA 效率的核心：

$$
\underbrace{O[t] = (\Gamma_{1\to C}[t] \odot Q[t])\,S[t]}_{\text{inter-chunk}} + \underbrace{A[t]\, eV[t]}_{\text{intra-chunk}}
$$

- **inter-chunk 项**：携带前序 chunk 的信息，通过累积衰减 $\Gamma_{1\to C}$ 与查询 $Q$ 作用到入态 $S[t]$ 上。
- **intra-chunk 项**：当前 chunk 内 token 间交互，$A[t]=\operatorname{Tril}((Q\odot\Gamma)(K/\Gamma)^\top)$ 是因果掩码的注意力矩阵，$eV[t]=U[t]-W[t]S[t]$ 是伪值项。

这一分解使 KDA **chunk 内并行、chunk 间串行**，配合 §3.2 的下界衰减，整条对角路径都能上 Tensor Core。

KDA Context Parallelism（KCP，论文式 17）则解决跨设备并行。KDA 的 delta-rule 让状态更新 $S_t = M_t S_{t-1} + \beta_t k_t v_t^\top$ 不可简单相加（$M_t$ 依赖入态），KCP 把每段效应分解为**对入态的累积转移** $M_{t\leftarrow 1}$ 与**从零生成的局部态** $\tilde S_t$：

$$
S_t^{[i+1]} = \tilde S_t^{[i+1]} + M_{t\leftarrow 1}^{[i+1]}\, S_{T_i}^{[i]} = \tilde S_t^{[i+1]} + M_{t\leftarrow 1}^{[i+1]} \sum_{j=1}^{i}\!\left(\prod_{l\leftarrow j+1}^{i} M_{T_l\leftarrow 1}^{[l]}\right)\tilde S_{T_j}^{[j]}
$$

每个 rank 只需本地 token 算出 $M_{T_i\leftarrow 1}^{[i]}$ 与 $\tilde S_{T_i}^{[i]}$，一次 all-gather 交换，再按 prefix scan 还原各 rank 入态——**只需固定大小的 all-gather 同步 recurrent state，计算线性扩展**。

## 5. 实验设置

- **基准**：四轴覆盖——推理 & 知识（GPQA Diamond、CritPt、AA-LCR、HLE-Full）、编码（DeepSWE、ProgramBench、Terminal-Bench 2.1、FrontierSWE、SWE-Marathon、PostTrainBench、MLS-Bench-Lite、SciCode）、智能体（BrowseComp、DeepSearchQA、ResearchRubrics、GDPval-AA v2、Toolathlon、MCPMark、MCP-Atlas、AutomationBench、JobBench、AA-Briefcase、ALE、APEX-Agents、OfficeQA Pro、SpreadsheetBench 2、OSWorld 等 20+）、视觉（WorldVQA、OmniDocBench、PerceptionBench、Video-MME、MMVU、BabyVision、MMMU-Pro、CharXiv、Math-Vision、ZeroBench）。
- **基线**：闭源 Claude Fable 5（含 fallback）、GPT-5.6 Sol（含 cyberguard）、Claude Opus 4.8、GPT-5.5（xhigh）；开源 GLM-5.2。所有模型最大努力度，GPT-5.5 用 xhigh。
- **评测配置**：Kimi K3 一律 reasoning effort max、temperature=1.0；推理/知识任务 top-p=0.95，编码与 agentic 任务 top-p=1.0。视觉基准平均 3 次（ZeroBench 5 次）。部分第三方结果引自 Artificial Analysis、Vals AI、Arena 官榜（截至 2026-07-23）。
- **复现性**：**完整模型权重开源**（https://github.com/MoonshotAI/Kimi-K3），RTL 代码（nano-kpu）、MiniTriton 编译器、AgentENV 沙箱、MoonEP 均开源。

## 6. 实验结果

![Figure 1：Kimi K3 主结果。所有模型均在最大思考努力度（max 或 xhigh）下评测。Coding（DeepSWE、Terminal-Bench 2.1、Kimi Code Bench 2.0、ProgramBench、FrontierSWE、SWE-Marathon、AutomationBench、Zerobench）、General & Visual Agents（GDPval-AA v2、JobBench、BrowseComp、CharXiv RQ w/ tool）等分项对比。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-01-main-results.png)

### 6.1 主结果（Table 2 节选）

| 基准 | Kimi K3 | Fable 5 | GPT-5.6 Sol | Opus 4.8 | GPT-5.5 | GLM-5.2 |
|---|---|---|---|---|---|---|
| GPQA Diamond | 93.5 | 92.6 | 94.1 | 91.0 | 93.5 | 91.2 |
| HLE-Full（无/有工具） | 43.5 / 56.0 | 53.3 / 63.0 | 44.5 / 58.0 | 49.8 / 57.9 | 41.4 / 52.2 | — |
| DeepSWE | 67.5 | 70.0 | 73.0 | 59.0 | 67.0 | 46.2 |
| ProgramBench | **77.8** | 76.8 | 77.6 | 71.9 | 70.8 | 63.7 |
| SWE-Marathon | **42.0** | 35.0 | 39.0 | 40.0 | 14.0 | 13.0 |
| FrontierSWE | 81.2 | 86.6 | 71.3 | 66.7 | 64.9 | 67.3 |
| BrowseComp | **91.2** | 88.0 | 90.4 | 84.3 | 84.4 | — |
| MCPMark-Verified | **94.5** | 87.4 | 92.9 | 76.4 | 92.9 | — |
| AutomationBench | **30.8** | 29.1 | 29.7 | 27.2 | 22.7 | 12.9 |
| OSWorld-Verified | 84.8 | 85.0 | 83.0 | 83.4 | 79.0 | — |
| Math-Vision（无/有 Py） | 94.3 / 97.8 | 94.8 / 98.6 | 95.8 / 97.8 | 86.7 / 97.1 | 92.2 / 96.8 | — |
| OmniDocBench | **91.1** | 89.8 | 85.8 | 87.9 | 89.4 | — |

**关键发现**：

- **编码**：ProgramBench（77.8%）与 GPU-kernel 导向的 SWE-Marathon（42.0%，领先 Fable 5 整 7 分）夺魁；Terminal-Bench 2.1（88.3%）几乎追平 GPT-5.6 Sol；FrontierSWE 长程基准 81.2% 仅次于 Fable 5。
- **智能体**：BrowseComp 91.2%、DeepSearchQA 95.0% F1、MCPMark 94.5%、AutomationBench 30.8%、Harvey Lab-AA 94.6% 等多项 SOTA；主要例外是 Elo 评级的知识工作套件（GDPval-AA v2、AA-Briefcase）由 Fable 5 领先。
- **视觉**：Math-Vision 97.8%（带 Python 工具）、ZeroBench 41.0%（带工具，与 Fable 5 并列）、OmniDocBench 91.1% 夺魁；Python 工具进一步放大视觉推理能力。
- **研究级推理短板**：CritPt 23.4% 落后 Fable 5 / GPT-5.6 Sol / GPT-5.5，HLE-Full 也落后——研究级推理仍是待补方向。

### 6.2 第三方评测与成本效率

| 榜单 | Kimi K3 | Fable 5 | GPT-5.6 Sol | Opus 4.8 | GPT-5.5 | GLM-5.2 |
|---|---|---|---|---|---|---|
| Artificial Analysis Intelligence Index v4.1 | 57.1 (#4/580) | 59.9 | 58.9 | 55.7 | 55.0 | 51.1 |
| Vals AI Vals Index | 74.7 (#2/39) | 75.1 | 73.1 | 70.4 | 68.0 | 65.0 |
| WebDev Arena (Elo) | **1678 (#1/99)** | 1634 | 1630 | 1565 | 1507 | 1592 |
| Text Arena (Elo) | 1486 (#8/200) | 1507 | 1485 | 1484 | 1482 | 1469 |
| Agent Arena | 9.1 (#4/37) | 12.7 | 10.1 | 9.8 | 8.8 | 6.5 |

![Figure 13：Kimi Code Bench 2.0、BrowseComp、GDPval-AA v2、AA-Briefcase 四套基准上分数与每任务推理成本对比。Kimi K3 以星标标记，处于或接近成本效率前沿。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-13-cost-efficiency.png)

![Figure 7：Kimi K2 与 Kimi K3 的拟合 scaling-law 曲线。Kimi K3 实现 2.5× 的 scaling 效率提升。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-07-scaling-law.png)

**成本效率**：四套基准上 Kimi K3 都处于或接近成本效率前沿——Kimi Code Bench 2.0 以 Fable 5 的 38% 成本落后 4.0 分；BrowseComp 以 $2.03/任务取得 91.2%，是 GPT-5.6 Sol 的一半、比 Claude 最大努力度便宜一个数量级；GDPval-AA v2 在 GPT-5.6 Sol 的 50 Elo 内、成本低 13%、比 Fable 5 便宜 2.6×。

### 6.3 RL FLOPs 扩展

![Figure 8：RL 过程中多种公开与内部评测的分数及平均助手步数随 RL FLOPs 的变化。扩大 RL FLOPs，工具调用步数一致增长，模型整体能力全面提升。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-08-rl-scaling.png)

RL FLOPs 扩大带来工具调用步数的一致增长与全面能力提升——编码经验、通用工具使用、Web 开发、agentic 搜索、专业工作流、office 交付、agentic 图表理解、agentic 视觉谜题等曲线普遍上行。这印证了"测试时计算是可扩展的第二轴"。

## 7. 后训练与基础设施（消融与系统视角）

### 7.1 后训练：SFT → 多努力度 RL → MOPD

后训练三段式：SFT 冷启动 → RL 培养领域专家 → Multi-Teacher On-Policy Distillation（MOPD）合并。

- **RL 跨域跨努力度**：3 域（通用、通用智能体、编码智能体）× 3 努力度（low/high/max）= 9 个专家模型。**Partial rollout**：每轮采样 K×N 条 trajectory，当 λ 比例完成即推进策略优化，暂停的 rollout 入队优先在下一轮续跑（靠 §7.2 沙箱基础设施），天然容忍极端 off-policy 的 per-token 正则化维持稳定。
- **Reasoning Effort RL**：每问题关联初始 token 预算 $b_0(x)$，超出 $\tau\cdot b_0(x)$ 的 trajectory 给 −1 奖励，按 $\tau$ 阶段式课程先训 max 再退火到 high/low。
- **Agentic GRM**：不可验证任务用锦标赛式两两比较的生成式奖励模型，强制裁判走"读产出→生成 rubric→打分→记分"协议，并用预算式冗长控制抑制 verbose reward hacking。
- **MOPD**：9 个专家作为教师，对学生 $\pi_\theta$ 做 per-token OPD 奖励 $r_{\text{opd}} = \operatorname{clip}(\operatorname{sg}(\log \pi^{(d,e)}_{\text{teacher}} - \log \pi_\theta), -R_{\max}, R_{\max})$，密集信号无缝融入 RL 框架，天然支持 partial rollout。
- **部署感知**：全程 QAT（MoE 专家权重 MXFP4、激活 MXFP8，非专家组件高精度）， rollout 与训练共享量化方案消除 train-inference mismatch；预训练 MTP 层微调为 EAGLE-3 风格 draft 模型，直接优化基于接受率的 LK 损失而非 KL 代理。

### 7.2 RL 任务合成与 agentic 环境

![Figure 9：知识图谱引导的任务合成概览。分层组织的知识图谱表示从宽域到细粒度概念的多层节点；采样相关节点联合形成关键词集，引导检索公开素材；每个合成实例选择一种任务类型（编码/知识/视觉等）产出对应任务。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-09-kg-task-synthesis.png)

- **统一白盒 RL 环境**：把 agent harness 表示为可配置可组合模块（工具接口、系统提示、上下文管理、技能、记忆、子 agent 等），通过配置实例化 Kimi Code、Claude Code、Codex、OpenClaw、Hermes 等主流 harness 及全新 harness，避免模型过拟合单一 harness 约定。
- **知识图谱引导任务合成**：自演化的分层 DAG 知识图谱，agent 递归扩展节点；采样节点组合成关键词集、检索真实素材、合成任务——控制粒度与覆盖。
- **可验证 agentic 任务**：多步复杂信息搜索、专业工作日（投行/数据分析/法律）、多步可验证视觉推理（沙箱内 Python 解释器迭代写码裁剪/缩放/变换图像）。
- **Kernel 优化任务**：从 Flash Linear Attention 等高质量仓库构建单算子到融合 mega-kernel 任务，覆盖 CUDA/Triton/CuTe DSL/Gluon/ThunderKittens/TileLang 与 BF16/FP8/FP4；奖励评正确性（超数值误差阈值零分）与性能（对标专家实现 0.5、趋近 roofline 趋 1），配 hacking 检测系统惩罚 CUDA graph replay、输入缓存、精度降级。
- **个人助理任务**：Gmail/Notion/Slack/Canvas 的 mock 实现，跨模拟多日、数十互联事件，单 rollout 最多数千次工具调用、百万上下文 token。
- **Autonomous Execution Tasks（AET）**：verify-in-the-loop 优化，agent 只见目标/上下文/约束/验证接口，自主分解、选工具、规划、纠错、终止；奖励基于验证器对最终环境态的评估而非 agent 自报。

![Figure 10：Camera Repair Management System（黑盒系统复制任务）上的完成曲线。agent 通过 oracle 查询重建一个隐藏的 3D 相机维修系统为 Web 应用。横轴为归一化执行器工具调用进度，纵轴为验证器评估的完成度。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-10-completion-curves.png)

### 7.3 3T 级预训练基础设施

![Figure 11：不同 PP 阶段中计算、通信与 offload 的重叠调度。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-11-infra-schedule.png)

- **MoonEP 完美均衡专家并行**：传统 EP 各 rank token 负载不均、动态形状致内存碎片。MoonEP 证明每 rank 预留 $E/R$ 个冗余专家槽即可保证可行解总存在（且该界基本紧），在线规划近最优、零拷贝通信、静态形状（消除每层 MoE host 同步），shared 专家 GEMM 用 workload-aware 调度器。
- **内存高效训练**：统一激活管理器（recompute/quantize/offload 可在 tensor 粒度自由组合）、SonicMoE 式 MoE 梯度重写省激活、Block AttnRes 的 cache-based pipeline 通信、PP rank 间激活远程 offload 均衡、Pipeline ZeRO-2 梯度分片与 offload、P2P Muon 正交化。
- **多模态编码器优化**：大图/长视频 patch 维 CP、子 CP 组负载均衡、ViT 计算塞进 PP bubble。

### 7.4 1M Agentic RL 基础设施

- **外部 KV cache 池**：write-back 设计——活跃解码块留 GPU，可复用空闲前缀仅在被驱逐时写回 CPU DRAM，下次复用前预取；KDA 状态与 MLA KV cache 块生命周期对齐一同 offload/preFetch。训练态 offload 到 NVMe 腾 DRAM。
- **Rollout 自动节流调度**：基于活跃请求数/队列数/KV 利用率动态控制并发，早期高并发、后期 KV 压力上升时降并发。
- **非策略模型前向的梯度缓冲复用**：参考模型权重流式载入策略模型的 FP32 梯度缓冲，双槽流水隐藏拷贝开销。
- **AgentENV 微 VM 沙箱**：Firecracker 微 VM 提供容器无法比拟的隔离与保真度（agent 可挂盘、跑容器、甚至起 VM）；增量 checkpoint 只存脏页（checkpoint 133ms、resume 49ms）；Pause/Fork/Snapshot 三高级操作；OverlayBD + ublk + P2P 实现亚秒级大规模启动，COW 内存页缓存实现 6.5× 内存超分。整个训练与评估共创建 **51,219,741 个沙箱**、跨 1,505,678 个镜像。

### 7.5 推理与在线服务：KDA-aware 前缀缓存

![Figure 12：物理缓存块（6144 token）内的细粒度前缀缓存。一个 6144-token 物理块含 12 个 512-token 哈希块，蓝色为已缓存 MLA 块、浅灰为空。下方标记为各哈希边界处的 KDA checkpoint 状态。◦ 表示无存储 checkpoint，• 表示已持久化，橙色 • 为 B=2560 处的命中。持久化 checkpoint 稀疏且通常对应对话轮边界。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-12-prefix-cache.png)

混合 KDA-MLA 架构让前缀缓存复杂化：MLA KV cache 随序列长度增长、按 token 分页；KDA recurrent state 固定大小、每请求一份。Kimi K3 把 KDA 状态打包进与 MLA KV 相同的分页块池（统一页大小），前缀哈希在细粒度 512-token hash block 上跑，KDA checkpoint 只在 MLA hash 端点稀疏保存；查找两阶段——MLA 阶段按链式哈希匹配整物理块并在首个缺失块回退到块内 hash 端点，KDA 阶段要求候选边界每个 KDA cache group 都有 checkpoint。一致性靠共享 free list + 跨 group pin + GPU 立即拷贝 + checkpoint 跨 group 原子失效保证。

### 7.6 案例研究：从优化内核到设计芯片

- **GPU 内核优化**：4 个代表内核（AttnRes/DSA/KDA/MLA），Kimi K3 把 AttnRes 延迟从 283.6ms 降到 114.4ms，DSA/KDA 运行时降 55.1%/73.6%，MLA 达峰值 TFLOPS 一半以上；整体匹配 Fable 5（含 fallback）、显著超 Opus 4.8/GPT-5.6 Sol/GPT-5.5。早期 checkpoint 已在后期开发中承担大部分内核优化工作。

![Figure 14：案例研究——AttnRes 上的 GPU 内核优化。横轴为活跃小时数，纵轴为相对 FLA Triton 基线的加速比。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-14-kernel-optimization.png)

- **GPU 编译器开发**：Kimi K3 独立开发 MiniTriton——一个紧凑的 Triton-like 编译器（自定义 tile 级 Python 前端 + 布局系统、轻量 warp 级 MLIR 层、PTX codegen），外加双模张量库（eager + 前向编译共享 DSL）。在 L20 上 core 基准几何均值超 PyTorch eager 与 torch.compile，from-scratch tensor-core matmul 接近 cuBLAS（约机器峰值的 90%），DSL 级 KDA prefill 内核超 matched Triton 参考；端到端训练 GPT 的 loss 曲线紧贴 PyTorch 参考，全模型梯度与 torch autograd 差异不超过 fp32 舍入误差（$10^{-4}$）。

![Figure 15：案例研究——MiniTriton GPU 编译器开发。(a) CUDA-core roofline；(b) tensor-core rooflines (tf32/bf16)；(c) 与 torch eager 的训练 loss 收敛对比；(d) 两 GPU DDP vs 单 GPU。](/vibe-reading/images/articles/kimi-k3-technical-report/fig-15-minitriton.png)

- **芯片设计**：单次 48 小时自主运行，用 Nangate45 标准单元库为同架构 nano 模型设计推理芯片原型，4mm² 面积预算内 100MHz 闭时序、RTL 仿真解码吞吐超 8700 tokens/s，集成 1.46M 标准单元、0.277 MiB SRAM、INT4 MAC 阵列（融合反量化）。RTL 代码开源。
- **科研编码**：复现计算天体物理 I–Love–Q 普适关系，审阅 20+ 论文交叉验证、实现完整数值管线、评估 300+ 状态方程、发现已发表公式不一致、写 3000+ 行 Python、产出交互式 HTML dashboard——约 2 小时，对比熟练研究者通常 1–2 周。

## 8. 总结与展望

**贡献总结**：

1. **开源预训练前沿**：2.8T 参数 / 104B 激活 / 1M 上下文的原生多模态 MoE；KDA + AttnRes + Stable LatentMoE + 数据/训练配方综合使 scaling 效率较 Kimi K2 提升 2.5×。
2. **多努力度测试时 scaling 的 RL**：跨通用/智能体/编码三域 × 多努力度开展 RL，再合并为统一模型。
3. **3T + 1M 的基础设施**：KDA 系统协同设计、MoonEP 完美均衡、内存高效训练、co-located RL + 可恢复沙箱、KDA-aware 前缀缓存与舰队调度。
4. **开放前沿模型**：完整权重开放。

**局限性（批判性）**：

- **研究级推理短板**：CritPt 23.4%、HLE-Full 落后 Fable 5 / GPT-5.6 Sol——这是与最强闭源模型最明显的差距，论文坦诚指出"研究级推理仍是关键改进方向"。
- **Elo 知识工作套件落后**：GDPval-AA v2、AA-Briefcase、MIRA Bench、Agent Behavior Bench 等仍由 Fable 5 领先，说明在过程质量、行为恰当性上仍有差距。
- **网络安全 Tier 2**：36 任务解 14（38.9%），内核提权仅 4/20；与人类专家（约 540 专家小时）仍有差距，4 类失败模式（exploit 链收尾、缓解下策略选择、调试死循环、提交前验证不足）明确。
- **成本 vs 闭源**：虽在成本效率前沿，但绝对分数仍落后 Fable 5 / GPT-5.6 Sol；当闭源进一步推高上限时，开源需持续追赶。
- **评测条件不对等**：Fable 5 含 fallback、GPT-5.6 Sol 含 cyberguard，部分基准的对比并非纯模型能力对比，论文虽注明但仍影响可比性。

**未来方向（创造性，idea 三法）**：

- *弥补缺陷*：研究级推理（CritPt/HLE）短板可能源于 RL 奖励信号偏 agentic/可验证、对开放式研究推理覆盖不足——可引入"研究问题分解 + 多步自验证"的合成 RL 环境，并用 hidden verifier 提升反作弊。
- *新型方案*：AttnRes 的 block 结构当前固定 8 块，可探索**自适应深度路由**——让不同 token/任务动态选择检索哪些历史层，把深度维也变成 data-dependent 稀疏检索，进一步降推理成本。SiTU-GLU 的 softcap β 目前手调，可纳入 QB 式自适应。
- *减少约束*：1M 上下文 agentic RL 的 trajectory 跨迭代续跑引入数据陈旧，靠 per-token 正则容忍；可探索**异步策略更新 + 重要性采样修正**的更激进 off-policy 框架，把 partial rollout 的等待彻底消除，提升 GPU 利用率。

Kimi K3 的真正意义不在某个单项 SOTA，而在于证明了**开源能在两条 scaling 轴上同时与闭源前沿掰手腕**——只要愿意把算法、训练、推理、沙箱、调度当作一个整体来协同设计。它把"开放前沿"从一个口号，变成了一份可复现的工程答卷。
