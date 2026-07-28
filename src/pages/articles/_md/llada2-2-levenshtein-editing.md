---
title: "LLaDA2.2: Enabling Agentic Diffusion Language Models via Levenshtein Editing"
source:
  type: "论文解读"
  project: "Ant Group"
  url: "https://hf.co/collections/inclusionAI/llada-20"
  pdf: "/vibe-reading/papers/llada2-2-levenshtein-editing.pdf"
date: "2026-07-28T16:00:00+08:00"
category: [AI, Models, Ant Group, Papers]
tags: ["Diffusion Language Model", "Levenshtein Editing", "Agentic", "L-EBPO", "Block Routing", "128K Context", "MoE"]
description: "目的：让扩散语言模型在多轮 agentic 场景下稳定运行。手段：引入 KEEP/SUBSTITUTE/DELETE/INSERT 四操作 Levenshtein 编辑 + LCS 训练标签 + L-EBPO agentic RL + 128K 上下文 + block routing。结论：7 个 agentic 基准上与 AR 持平，吞吐 1.64× 提升。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/llada2-2-levenshtein-editing.pdf" target="_blank" rel="noopener">预览</a> · **技术报告** LLaDA2.2 · **作者** Tiwei Bie 等（Inclusion AI / Ant Digital Technologies / Zhejiang University / 西湖大学 / Westlake Scitrain）· **发表** 技术报告, 2026 · **项目** https://hf.co/collections/inclusionAI/llada-20 · **解读** 2026-07-28

---

## 1. 论文概览

**一句话**：LLaDA2.2 把扩散语言模型从"单轮静态生成"推向"多轮动态 agentic"场景——用 Levenshtein 编辑（KEEP/SUBSTITUTE/DELETE/INSERT 四操作）打破 2.1 的固定长度替换瓶颈，用 L-EBPO 在环境反馈中学习纠错策略，并把上下文扩到 128K、用 block routing 压住 MoE 推理开销。

- **任务**：长 horizon agentic 工具调用与软件工程（SWE-bench 系列、τ²-Bench、Claw-Eval、PinchBench、MCP-Atlas、BFCL v4）。
- **核心创新**：① **Levenshtein Editing**——在 dLLM 去噪过程中引入 DELETE/INSERT 控制令牌，通过 LCS 对齐动态生成编辑标签，使序列长度与位置可在并行解码中动态变化；② **L-EBPO**——把 Levenshtein 编辑决策建模为两层控制层次（外层 EBPO 轨迹决策、内层块内 splice 编辑），用统一扩展动作空间 $\mathcal{A} = V \cup \{\text{DELETE}, \text{INSERT}\}$ 优化；③ **Block Routing**——block 级先准入 top-C 专家（C=48/E=256），再在池内做 token-wise routing，把 MoE 块扩散的专家足迹从 $O(Bk)$ 压到 $O(C)$；④ **128K 上下文**——渐进式长上下文 CPT（8K→64K→128K）。
- **结果**：LLaDA2.2-flash 在 7 个 agentic 基准上平均 53.83（vs Ling-2.6-flash 55.74），在 τ²-Bench、PinchBench、MCP-Atlas 上反超 AR；BF16 吞吐平均 1.64× 于 Ling-2.6-flash；Levenshtein 编辑在 SWE-bench Verified 上带来 +8.6 分绝对增益。

**take-home**：扩散语言模型要真正"agentic"，不能只做 token 级替换——必须能灵活地增删序列，并从环境反馈中学习何时何处编辑。Levenshtein editing + L-EBPO 是这条路径的第一步。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Diffusion language models (dLLMs) demonstrate strong performance and high efficiency across general tasks, yet their block-parallel decoding process makes them susceptible to error accumulation in multi-turn, long-horizon agentic settings. LLaDA2.1 partially mitigates this via token-to-token (T2T) editing, but its fixed-length substitution mechanism remains a critical bottleneck in agentic workflows. To address this, we present LLaDA2.2, which equips dLLMs with flexible Levenshtein editing through four primitive edit operations—KEEP, SUBSTITUTE, DELETE, and INSERT—with training labels derived via longest common subsequence (LCS) alignment between intermediate drafts and ground-truth sequences. We further propose L-EBPO, an agentic RL algorithm that optimizes editing decisions based on environmental feedback. For practical long-horizon deployment, LLaDA2.2 extends the context window to 128K tokens and introduces a block-routing mechanism to mitigate MoE inference overhead. Empirical results demonstrate that LLaDA2.2 achieves performance competitive with autoregressive baselines on long-horizon agentic benchmarks.

> **译：** 扩散语言模型在通用任务上展现了强性能与高效率，但其块并行解码过程使其在多轮、长 horizon agentic 场景中易受错误累积影响。LLaDA2.1 通过 token-to-token（T2T）编辑部分缓解了这一问题，但其固定长度替换机制在 agentic 工作流中仍是关键瓶颈。为此，我们提出 LLaDA2.2，通过四种原始编辑操作——KEEP、SUBSTITUTE、DELETE 和 INSERT——为 dLLM 配备灵活的 Levenshtein 编辑，训练标签通过中间草稿与 ground-truth 序列之间的最长公共子序列（LCS）对齐导出。我们进一步提出 L-EBPO，一种基于环境反馈优化编辑决策的 agentic RL 算法。面向实际长 horizon 部署，LLaDA2.2 将上下文窗口扩展至 128K token，并引入 block routing 机制以缓解 MoE 推理开销。实证结果表明，LLaDA2.2 在长 horizon agentic 基准上达到与自回归基线竞争的性能。

</details>

---

## 2. 研究背景

LLaDA2.1 用 T2T 编辑缓解了速度-质量取舍，但当应用从"单轮静态生成"转向"多轮动态 agentic 环境"时，问题发生了根本变化。论文识别出两个关键挑战：

**Challenge I：结构刚性与推理路径坍缩。** 块并行生成中，同一块内的 token 在无显式顺序条件下解码，常导致 n-gram 重复、畸形 JSON 和模糊的工具调用边界。这些错误难以修复，因为 LLaDA2.1 的一对一替换固定了输出长度，阻止了 token 的插入或删除。此外，任意顺序去噪会降低推理多样性：推迟高不确定性的分叉 token 而先解决简单位置，会让周围上下文过早决定关键决策，从而修剪替代推理路径，诱发解空间坍缩。

**Challenge II：错误累积破坏长 horizon agentic 轨迹。** 在多轮交互中，早期生成步骤的错误输出作为硬约束被纳入后续去噪块的上下文。与常规暴露偏差（训练-推理失配降低质量）不同，这些错误直接破坏任务状态本身，导致目标漂移和级联失败。相比 AR 模型能在遇到异常时隐式条件化于先前上下文并自我纠正，块扩散模型在结构上更脆弱于此类错误累积。

| 维度 | LLaDA2.1（T2T） | LLaDA2.2（Levenshtein） |
|---|---|---|
| 编辑操作 | KEEP, SUBSTITUTE | **KEEP, SUBSTITUTE, DELETE, INSERT** |
| 序列长度 | 固定（一对一替换） | **动态可变** |
| RL 对齐 | EBPO（轨迹级） | **L-EBPO（轨迹 + 编辑决策统一空间）** |
| 上下文窗口 | 8K | **128K（渐进扩展）** |
| MoE 路由 | token 级（专家足迹 $O(Bk)$） | **block 级准入（$O(C)$, C=48）** |

---

## 3. 方法详解

LLaDA2.2 从 LLaDA2.1 基座初始化，通过 CPT、SFT、RL 三阶段训练建立 agentic 能力。三大组件紧密协同：高效基础设施（128K 上下文 + block routing）、Levenshtein 编辑范式、环境感知 agentic RL。

![Figure 2：训练与推理框架总览。CPT 阶段渐进式扩展上下文（8K→64K/300B→128K/200B）并切换 block routing；SFT 阶段用 LCS 派生的 Levenshtein 编辑标签做监督；RL 阶段用 SGLang 端点做 rollout，黑盒 agentic runtime 生成轨迹，L-EBPO 做策略更新。](/vibe-reading/images/articles/llada2-2-levenshtein-editing/fig-2-framework-overview.png)

### 3.1 渐进式长上下文扩展

从 LLaDA2.1 的 8K 基座出发，先在 64K 上下文长度上用 300B token 训练，再扩展到 128K 用另外 200B token。渐进式调度避免了从短到超长的骤变，让模型逐步适应位置编码、注意力模式和块扩散去噪行为。数据以长文档和仓库级代码为主（有效长度 64K–128K），并保留 document-aware packing 与 attention 边界。最终 128K 阶段引入 agentic 数据（长软件工程上下文、工具调用轨迹、浏览轨迹），使长上下文能力适配交互式 agent 工作流。

### 3.2 Block Routing for MoE Block Diffusion

标准 MoE transformer 中每个 token 独立选 top-k 专家。AR 解码每步只处理少量新 token，但块扩散解码每步处理一整块（32 或 64 token）。若每个 token 独立路由，一个块触及的专家集是所有 token 级选择的并集，活跃专家足迹可从 AR 的 $k$ 个膨胀到 $\min(Bk, E)$ 个——造成 HBM 流量激增、专家权重复用下降、专家并行通信成本上升。

![Figure 3：Block Routing 示意。左侧 token 级路由下每 token 独立选专家，块级足迹膨胀；右侧 block routing 先在块级准入 top-C 专家形成固定容量池，再在池内做 token 级 routing。](/vibe-reading/images/articles/llada2-2-levenshtein-editing/fig-3-block-routing.png)

**Block routing** 对齐路由单元与扩散生成单元：先用 **token racing 策略**在块级准入专家，再在准入池内做 token-wise top-k 路由：

$$
g_j = \max_{i \in \{1, \ldots, B\}} s_{i,j}, \quad j = 1, \ldots, E
$$

每个 token 有机会提名其强局部偏好的专家，块再按 $g$ 选 top-C 形成固定容量专家池 $\mathcal{P}$（默认 $C=48$ for $E=256$）。token-wise top-k 路由仅在 $\mathcal{P}$ 内执行，池外分数被 mask。block routing 给每块一个可预测的专家工作集上界 $O(C)$，改善内存规划与专家并行执行，同时保留 token 级特化。

### 3.3 Levenshtein 编辑范式

不同于 T2T 的位置级 keep/substitute，LLaDA2.2 支持 **四操作**：KEEP、SUBSTITUTE、DELETE、INSERT。DELETE 移除当前 token $x_i$，INSERT 在 $x_i$ 前创建新的可编辑位置。

**LCS 标签构造。** 设草稿 $x$ 和目标 $y$ 是块内有效 token 序列（长度 $m=n \leq B$），计算其 LCS 并用匹配作为锚点，得到操作标签 $a = (a_1, \ldots, a_m) \in \{K, S, D, I\}^m$。锚点匹配位置标 keep；锚点前 gap 中对齐位置标 substitute，草稿多余标 delete，目标多余标 insert（每 gap 最多一个 insert，后续轮次补齐）。监督标签见 §4 公式 2–3。

**固定长度块约束。** 编辑独立施加于 $m$ 个有效位置：delete 左移后续 token，insert 将 $x_i$ 扩展为 $(\langle M\rangle, x_i)$ 供后续轮填充。结果用 $\langle M\rangle$ padding 或尾部截断恢复 $m$ 个位置，保持块长度固定。

![Figure 4：Levenshtein 编辑消融。在相同 SWE 轨迹上微调，开启 Levenshtein 编辑后 SWE-bench Verified 从 35.8 提升到 44.4，+8.6 分绝对增益。](/vibe-reading/images/articles/llada2-2-levenshtein-editing/fig-4-levenshtein-ablation.png)

### 3.4 L-EBPO：Agentic RL

把 agentic RL 建模为 **两层控制层次**：外层（EBPO）优化跨 agent 交互轮的轨迹级决策，内层管理单步块内 splice 编辑（何时何处施加 DELETE/INSERT）。L-EBPO 通过单一扩展动作空间统一两层：

$$
\mathcal{A} = V \cup \{\text{DELETE}, \text{INSERT}\}
$$

DELETE/INSERT 是瞬态的——解码时存在但从输出序列中消失，因此必须通过 LCS 对齐恢复编辑轨迹以做似然估计。在多轮 agentic 轨迹中，块内若有多轮模型输出与工具调用响应，除第一轮外均被 mask（防止 intra-block 全 attention 信息泄漏）。

**训练环境。** rollout 由 SGLang 处理，执行环境由 AKernel 管理的大规模沙盒集群提供，ASystem 做分布式编排。奖励信号来自环境反馈，含三个加性分量：工具调用执行正确性、输出格式有效性、任务完成度。采用异步训练方案（rollout 收集、沙盒服务、环境执行、策略优化并发）。

---

## 4. 关键公式解读

**块级专家准入分数**（token racing，取块内 max 作为每个专家的块级提名）：

$$
g_j = \max_{i \in \{1, \ldots, B\}} s_{i,j}, \quad j = 1, \ldots, E
$$

**LCS 对齐派生的操作标签**：

$$
a = (a_1, \ldots, a_m) \in \{K, S, D, I\}^m
$$

**监督标签**（$\sigma(i)$ 为 keep/substitute 操作分配的目标索引）：

$$
\ell_i = \begin{cases} y_{\sigma(i)} & \text{if } a_i \in \{K, S\}, \\ \text{DELETE} & \text{if } a_i = D, \\ \text{INSERT} & \text{if } a_i = I. \end{cases}
$$

**L-EBPO 扩展动作空间**：

$$
\mathcal{A} = V \cup \{\text{DELETE}, \text{INSERT}\}
$$

**对数概率比的 ELBO 近似**（$a_b$ 为块 $b$ 的动作向量，含 token 预测与编辑决策；$z_n = y_{t_n} \oplus y_0$ 复合输入，$M$ 块因果掩码）：

$$
\log \rho(y \mid x) \approx \sum_{n=1}^{N} w_n \sum_{b=1}^{B} \left[ \log p_\theta(a_b \mid z_n, x; M) - \log p_{\theta_{\text{old}}}(a_b \mid z_n, x; M) \right], \quad a_b \in \mathcal{A}^{L_B}
$$

> DELETE/INSERT 是瞬态的——它们在解码时存在但不出现在最终输出序列中，因此编辑轨迹必须通过对齐 noised rollout 与原始动作序列来恢复，使梯度信号能流经结构性决策（增删位置）。

---

## 5. 实验设置

- **基准套件**：17 个基准，分 7 agentic + 10 general。Agentic：SWE-bench Verified/Pro/Multilingual、τ²-Bench、Claw-Eval、PinchBench、MCP-Atlas。General：AIME 2026、OlympiadBench、LiveCodeBench、IFBench、Multi-IF、KOR-Bench、GPQA-Diamond、LongBench v2、BFCL v3/v4。
- **基线**：Ling-2.6-flash（AR），并对比 LLaDA2.1-flash（10 个 general 基准）。
- **效率指标**：11 个代表工作负载上的 BF16 与 FP8 量化吞吐（TPS），Ling-2.6-flash 启用 MTP（4 draft tokens）。
- **SWE-bench 评测脚手架**：LLaDA2.2 使用 Claude Code，Ling-2.6-flash Verified 分数来自文献（OpenHands 评估），Pro 与 Multilingual 用相同 Claude Code 脚手架。

---

## 6. 实验结果

![Figure 1：LLaDA2.2-flash vs Ling-2.6-flash 在 7 个 agentic 基准上的表现与吞吐。(a) 基准性能；(b) 吞吐（TPS）。](/vibe-reading/images/articles/llada2-2-levenshtein-editing/fig-1-agent-benchmarks.png)

### 6.1 Agentic 基准（Table 1）

| 基准 | Ling-2.6-flash | LLaDA2.2-flash | 优势方 |
|---|---|---|---|
| **平均** | **55.74** | 53.83 | Ling |
| SWE-bench Verified | 61.20* | 49.28 | Ling |
| SWE-bench Pro | 31.88 | 30.10 | Ling |
| SWE-bench Multilingual | 33.73 | 25.00 | Ling |
| τ²-Bench | 76.36 | **80.33** | LLaDA2.2 |
| Claw-Eval | 64.56 | 64.22 | ~持平 |
| PinchBench | 81.30 | **81.66** | LLaDA2.2 |
| MCP-Atlas | 41.12 | **46.21** | LLaDA2.2 |

> **关键发现**：LLaDA2.2 在交互式工具调用任务上竞争力强（τ²-Bench +3.97、PinchBench +0.36、MCP-Atlas +5.09 均反超 AR），但仓库级软件工程仍是短板（SWE-bench 系列均落后）。后者需注意两者用了不同评测脚手架。

### 6.2 General 基准（Table 2）

| 基准 | Ling-2.6-flash | LLaDA2.1-flash | LLaDA2.2-flash |
|---|---|---|---|
| **平均** | **65.90** | 59.23 | 56.81 |
| LongBench v2 | 42.94 | 33.80 | **45.13** |
| Multi-IF | 74.80 | 76.41 | 73.67 |
| BFCL v4 | 66.81 | 41.04 | 60.78 |
| AIME 2026 | 73.65 | 74.01 | 62.24 |

> LongBench v2 的 45.13 vs 42.94 与 128K 上下文扩展目标一致。LLaDA2.2 在结构化函数调用、代码生成、指令遵循、知识密集推理上仍有差距。

### 6.3 推理吞吐（Table 3）

| 基准 | Ling-2.6-flash (BF16) | LLaDA2.2-flash (BF16) | LLaDA2.2-flash (FP8) |
|---|---|---|---|
| SWE-bench Verified | 303.20 | 519.00 | 601.50 |
| BFCL-v4 | 331.50 | **703.82** | 846.60 |
| LiveCodeBench | 354.90 | 599.00 | 721.30 |
| LongBench-v2 | 145.50 | 281.20 | 320.80 |

LLaDA2.2-flash BF16 在 11 个工作负载上平均 **1.64×** 于 Ling-2.6-flash（含 MTP）；FP8 量化额外提升 18.6% 平均吞吐。

### 6.4 Levenshtein 编辑消融（Figure 4）

在相同 SWE 轨迹上微调，仅切换是否启用 Levenshtein 编辑：35.8 → 44.4，**+8.6 分绝对增益**。这证明允许增删操作大幅提升了仓库级软件工程任务的性能。

---

## 7. 总结与展望

**贡献总结**：LLaDA2.2 把 dLLM 从固定长度 token 替换推进到灵活 Levenshtein 编辑，配合 L-EBPO 在环境反馈中学习纠错决策、128K 上下文与 block routing 保障长 horizon 部署效率。在 agentic 交互任务上达到与 AR 竞争的水平，并在吞吐上保持 dLLM 固有的并行优势。

**局限性（批判性）**：
- **块扩散解码的局部不一致**：多位置并行预测，直到后续精炼步才能互相条件化——在嵌套 JSON、复杂 SQL、多参数工具调用等顺序敏感任务上仍弱于 AR。Levenshtein 编辑能事后修补，但无法完全恢复 AR 的逐 token 前缀约束。
- **不对称编辑学习**：DELETE 对应局部可见冗余（易学），INSERT 需检测遗漏、确定位置、与后续精炼协调（难学）。未纠正的错误进入上下文并随时间复合，导致目标漂移。
- **RL 训练效率与 MoE 训练-推理失配**：dLLM 轨迹含多轮块级去噪与编辑决策，精确序列似然难以高效计算；ELBO 估计与置信度解码之间、MoE 训练与推理路由行为之间存在两类失配。
- SWE-bench 系列仍明显落后 AR，通用基准上与 Ling-2.6-flash 有 9 分差距。

**未来方向**：
- 编辑可集成 **verify-while-decode** 目标，持续确保与已生成 token 的一致性（I-DLM 内省建模视角）。
- **连续扩散范式**（超越离散 mask-and-edit 转换）提供一条可行路径。
- **在线对齐**：更低方差的似然估计、更有针对性的探索、更细粒度的信用分配。
- 数据混合与课程设计（general vs agentic）的最优策略尚待建立——过多 agentic 数据有损基础能力，过少则限制工具熟练度与长 horizon 执行。
