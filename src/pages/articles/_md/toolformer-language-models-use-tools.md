---
title: "Toolformer: Language Models Can Teach Themselves to Use Tools"
source:
  type: "论文解读"
  project: "Meta AI"
  url: "https://arxiv.org/abs/2302.04761"
  pdf: "/vibe-reading/papers/toolformer-language-models-use-tools.pdf"
date: "2026-08-01T14:40:00+08:00"
category: [AI, Agent, MCP, Papers]
tags: ["Tool Use", "Language Model", "Self-Supervised", "GPT-J", "API"]
description: "目的：让 LM 克服算术/事实/时效等短板。手段：自监督地让模型自己标注并筛选有用的 API 调用再微调。结论：6.7B GPT-J 在多个零样本任务上超过 175B GPT-3，且不损害语言建模能力。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/toolformer-language-models-use-tools.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Toolformer: Language Models Can Teach Themselves to Use Tools](https://arxiv.org/abs/2302.04761) · **作者** Timo Schick, Jane Dwivedi-Yu, Roberto Dessì, Roberta Raileanu, Maria Lomeli, Luke Zettlemoyer, Nicola Cancedda, Thomas Scialom（Meta AI Research / Universitat Pompeu Fabra）· **发表** arXiv 2302.04761, 2023-02 · **项目** 未公开官方代码 · **解读** 2026-08-01

---

## 1. 论文概览

**一句话**：Toolformer 让语言模型在**自监督**方式下学会自己决定何时、如何调用外部工具（计算器、QA、搜索引擎、翻译、日历）的 API——只靠少量人工示范，模型自己标注"哪些调用有用"、再微调自身，从而把 6.7B 的 GPT-J 推到多个零样本任务上**超过 175B 的 GPT-3**。

- **任务**：赋予语言模型自主使用外部工具的能力（零样本设置下）。
- **核心创新**：用 LM 自身的困惑度作为筛选信号——让模型给大量文本标注候选 API 调用，只保留"加入后能降低未来 token 预测损失"的那些，再用筛选后的数据微调模型本身。
- **结果**：在 LAMA、数学、QA、时间等任务上，Toolformer 大幅超越同规模基线，并在 LAMA/数学上超过 GPT-3（175B）；同时 WikiText/CCNet 困惑度不升反稳，**核心语言建模能力未受损**。

**take-home**：让 LM 当自己的"老师"——它自己标注工具调用是否有用，再把这些有用样本喂回自己微调；自监督的判据是"调用是否真的帮我预测了后面的 token"。这是早期"工具使用"从"人工示范 / 任务特定 prompt"走向"模型自主决策"的关键一跃。

![图1 Toolformer 自主调用不同 API 的预测示例（自上而下：问答系统、计算器、机器翻译、维基百科搜索引擎）](/vibe-reading/images/articles/toolformer-language-models-use-tools/fig-1-exemplary-predictions.png)

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Language models (LMs) exhibit remarkable abilities to solve new tasks from just a few examples or textual instructions, especially at scale. They also, paradoxically, struggle with basic functionality, such as arithmetic or factual lookup, where much simpler and smaller models excel. In this paper, we show that LMs can teach themselves to use external tools via simple APIs and achieve the best of both worlds. We introduce Toolformer, a model trained to decide which APIs to call, when to call them, what arguments to pass, and how to best incorporate the results into future token prediction. This is done in a self-supervised way, requiring nothing more than a handful of demonstrations for each API. We incorporate a range of tools, including a calculator, a Q&A system, two different search engines, a translation system, and a calendar. Toolformer achieves substantially improved zero-shot performance across a variety of downstream tasks, often competitive with much larger models, without sacrificing its core language modeling abilities.

> **译：** 语言模型（LM）在只需少量示例或文本指令即可解决新任务方面展现出惊人能力，尤其在规模扩大后。但矛盾的是，它们在算术或事实查找这类基础功能上却很挣扎——而这些恰恰是更简单、更小的模型所擅长的。本文证明 LM 可以**自我学习使用外部工具**（通过简单的 API），从而鱼与熊掌兼得。我们提出 Toolformer，一个被训练来决定**调用哪些 API、何时调用、传什么参数、如何把结果整合进后续 token 预测**的模型。这一切以**自监督**方式完成，每个 API 只需少量人工示范。我们集成了一组工具：计算器、问答系统、两种搜索引擎、翻译系统和日历。Toolformer 在多种下游任务的零样本性能上大幅提升，常与大得多的模型不相上下，且**不牺牲其核心语言建模能力**。

</details>

---

## 2. 研究背景

大语言模型在少样本/指令下表现惊艳，但有若干**靠 scaling 难以根治的固有短板**：

1. **无法获取最新信息**：训练数据有截止日期，对近期事件无知。
2. **事实幻觉**：易编造看似合理但错误的事实。
3. **低资源语言理解差**：在训练数据稀少的语言上表现不佳。
4. **缺乏数学能力**：做不了精确算术（更小的计算器反而会）。
5. **对时间无感知**：不知道"今天"是哪天、星期几。

一个直观的解法是**给 LM 配外部工具**（搜索引擎、计算器、日历…）。但当时的已有做法各有掣肘：

- **依赖大量人工标注**：如 Internet-augmented dialogue（Komeili et al., 2022）、LaMDA（Thoppilan et al., 2022）、WebGPT（Nakano et al., 2021）需要海量人工监督来教模型何时用工具。
- **任务特定 prompt**：如 PAL（Gao et al., 2022）、few-shot 检索增强（Lazaridou et al., 2022）只在某个具体任务的 few-shot 提示里用工具，无法迁移。
- **TALM**（Parisi et al., 2022）最接近本文——也用自监督目标，但只在下游任务微调时探索工具使用，而非让模型自己决定何时用哪个工具。

Toolformer 想要的是两条**desiderata**：

- **自监督、不依赖大量人工标注**——既省钱，也因为"对模型有用的"未必等于"人类觉得有用的"。
- **不损失通用性**——模型自己决定何时、用哪个工具，不绑定具体任务。

---

## 3. 方法详解

核心思路三步走：**采样 → 执行 → 筛选 → 微调**。整条流水线如下图，以 QA 工具为例：给定文本 $x$，先在若干位置采样候选 API 调用 $c_i^1, c_i^2, \dots$；执行得到结果；再用困惑度过滤掉"不帮忙"的调用；最后把保留下来的调用与原文交错合并成增强数据集 $C^*$ 微调模型。

![图2 方法关键步骤：采样候选 API 调用 → 执行 → 按损失过滤，最终得到带 API 调用的增强数据集](/vibe-reading/images/articles/toolformer-language-models-use-tools/fig-2-method-steps.png)

### 3.1 API 调用的文本化表示

关键设计：**每个 API 的输入输出都表示成文本序列**，从而可以无缝插进任意文本。一次调用 $c=(a_c, i_c)$（API 名 + 输入）带结果 $r$ 的线性化形式为：

$$
e(c, r) = \langle\text{API}\rangle\ a_c(i_c) \to r\ \langle/\text{API}\rangle
$$

其中 $\langle\text{API}\rangle$、$\langle/\text{API}\rangle$、$\to$ 是特殊 token。实践中用 `[`、`]`、`->` 这几个已有 token 序列来表示，**不修改 LM 词表**即可工作。下图是给 QA 工具写的一个示范 prompt $P(x)$，靠 few-shot 引导模型给文本插入 API 调用。

![图3 用于给 QA 工具生成 API 调用的示范 prompt P(x)](/vibe-reading/images/articles/toolformer-language-models-use-tools/fig-3-qa-prompt.png)

### 3.2 采样 API 调用（Sample）

对每个 API 写一个 prompt $P(x)$。对文本 $x=x_1,\dots,x_n$ 的每个位置 $i$，计算模型在该位置**开始一次 API 调用**的概率：

$$
p_i = p_M(\langle\text{API}\rangle \mid P(x),\, x_{1:i-1})
$$

保留 $p_i$ 超过采样阈值 $\tau_s$ 的位置（最多 $k$ 个）；每个位置再采样最多 $m$ 条候选调用 $c_i^1,\dots,c_i^m$。

### 3.3 执行 API 调用（Execute）

实际调用各 API 得到响应 $r_i$（单条文本序列）。这一步对工具完全黑盒——可以是调另一个神经网络、跑 Python、做检索。

### 3.4 筛选 API 调用（Filter）

**这是整篇方法的灵魂**：用"加入调用后是否降低未来 token 的损失"来判断调用是否有用。定义加权交叉熵损失（$z$ 为给模型的前缀）：

$$
L_i(z) = -\sum_{j=i}^{n} w_{j-i}\cdot \log p_M(x_j \mid z,\, x_{1:j-1})
$$

比较两种情形：

$$
L_i^{+} = L_i(e(c_i, r_i)),\qquad L_i^{-} = \min\bigl(L_i(\varepsilon),\ L_i(e(c_i, \varepsilon))\bigr)
$$

- $L_i^{+}$：把"调用 + 结果"都给模型当前缀时，预测后续 token 的损失。
- $L_i^{-}$：取"不调用"和"调用但不给结果"两者中的较小值——即**基线**。

只有当 $L_i^{-} - L_i^{+} \geq \tau_f$ 时才保留这次调用：即"有调用+结果"比"无调用/只调用不给结果"至少降低 $\tau_f$ 的损失。直觉上，这筛掉了模型自己都不信的调用，留下真正帮模型预测未来的那些。

权重函数让损失聚焦在调用点附近：

$$
\tilde{w}_t = \max(0,\ 1 - 0.2\,t),\qquad w_t = \frac{\tilde{w}_t}{\sum_{s\in\mathbb{N}} \tilde{w}_s}
$$

### 3.5 微调与推理

把各 API 筛选后的调用与原文交错合并成 $C^*$，用**标准语言建模目标**微调 $M$。关键性质：$C^*$ 除插入的 API 调用外与原 $C$ 文本完全相同，所以微调不改变模型接触的内容，只多了"何时何处调用工具"的自监督信号。

**推理**时正常解码，直到模型产出 `->` token——此时中断解码，调用对应 API 拿响应，插入响应和 `</API>` 后继续解码。

---

## 4. 关键公式解读

把上面的几个核心式集中看，理解"自监督筛选"的数学本质。

**① 采样：模型自己在哪里想发起调用？**

$$
p_i = p_M\bigl(\langle\text{API}\rangle \mid P(x),\, x_{1:i-1}\bigr)
$$

$$
\underbrace{p_i}_{\text{位置 }i\text{ 起调用的概率}} = \underbrace{p_M(\cdot)}_{\text{LM 在上下文后的条件概率}}\bigl(\overbrace{\langle\text{API}\rangle}^{\text{API 起始 token}} \mid \underbrace{P(x),\, x_{1:i-1}}_{\text{prompt + 已见前缀}}\bigr)
$$

阈值 $\tau_s$ 控制采样的位置数——太低则噪声多、算力贵，太高则漏掉候选。

**② 筛选：这次调用真的有用吗？** 这是论文的判据核心：

$$
L_i(z) = -\sum_{j=i}^{n} w_{j-i}\cdot \log p_M(x_j \mid z,\, x_{1:j-1})
$$

$$
L_i^{+} = L_i(e(c_i, r_i)),\quad L_i^{-} = \min\bigl(L_i(\varepsilon),\ L_i(e(c_i, \varepsilon))\bigr),\quad \text{保留当}\ L_i^{-} - L_i^{+} \geq \tau_f
$$

$$
\underbrace{L_i^{-} - L_i^{+}}_{\text{调用带来的损失下降}} \;\geq\; \underbrace{\tau_f}_{\text{过滤阈值}}
$$

直觉：$\varepsilon$（空）表示"啥也不给"，$e(c_i,\varepsilon)$ 表示"只给调用不给结果"。取二者最小作基线，是为了防住两种作弊——"光插个调用占位就降损失"或"不调用反而更好"。只有**真正吃到结果红利**的调用才留下。

**③ 权重衰减：损失只看调用点附近的 token**

$$
w_t = \frac{\max(0,\, 1 - 0.2\,t)}{\sum_{s} \max(0,\, 1 - 0.2\,s)}
$$

$t=0$（紧邻调用点）权重最大 $1.0$，线性衰减到 $t=5$ 处归零并截断。这确保"调用提供的信息确实在邻近 token 上被用到"，而非被远处的无关 token 稀释。

---

## 5. 实验设置

| 维度 | 配置 |
| --- | --- |
| **基础模型** | GPT-J（6.7B），基于 CCNet 子集微调 |
| **数据集** | CCNet 子集 $C$；按 API 设启发式子集（如 calculator 只看含 ≥3 个数字的文本）以省算力 |
| **5 个工具** | QA（Atlas，在 NQ 上微调的检索增强 LM）、Calculator（四则运算，结果保留两位小数）、Wikipedia Search（BM25 over KILT Wikipedia dump）、Machine Translation（NLLB 600M，200 语言，fastText 检测源语言，目标恒为英语）、Calendar（返回当前日期，无输入） |
| **微调** | batch 128，lr $1\times10^{-5}$，前 10% 线性 warmup |
| **基线** | GPT-J / GPT-J+CC（在 $C$ 上微调无 API）/ Toolformer / Toolformer(disabled)（推理时把 $\langle$API$\rangle$ 概率设 0）；另对比 OPT(66B)、GPT-3(175B) |
| **评估** | 零样本（不给 in-context 示例，更难）；greedy 解码但放宽——当 $\langle$API$\rangle$ 是 top-$k$（$k=10$）最可能 token 时即发起调用；**每输入至多一次调用**防死循环 |
| **复现** | 论文未公开官方代码/数据；工具所用第三方模型（Atlas、NLLB）公开可得 |

筛选阈值 $\tau_f$ 越大留的样本越少越精。下表是 $C^*$ 中各工具在不同 $\tau_f$ 下的样本数——可见 calculator/MT 极度样本稀缺（百万文档只产出几千条有用调用），这也是论文局限之一。

| API | $\tau_f=0.5$ | $\tau_f=1.0$ | $\tau_f=2.0$ |
| --- | ---: | ---: | ---: |
| Question Answering | 51,987 | 18,526 | 5,135 |
| Wikipedia Search | 207,241 | 60,974 | 13,944 |
| Calculator | 3,680 | 994 | 138 |
| Calendar | 61,811 | 20,587 | 3,007 |
| Machine Translation | 3,156 | 1,034 | 229 |

---

## 6. 实验结果

### 6.1 知识型事实（LAMA）

| 模型 | SQuAD | Google-RE | T-REx |
| --- | ---: | ---: | ---: |
| GPT-J | 17.8 | 4.9 | 31.9 |
| GPT-J + CC | 19.2 | 5.6 | 33.2 |
| Toolformer (disabled) | 22.1 | 6.3 | 34.9 |
| **Toolformer** | **33.8** | **11.5** | **53.5** |
| OPT (66B) | 21.6 | 2.9 | 30.1 |
| GPT-3 (175B) | 26.8 | 7.0 | 39.8 |

Toolformer 比最佳同规模基线分别提升 **11.7 / 5.2 / 18.6** 个点，并**超过 10× 规模的 OPT(66B) 和 25× 规模的 GPT-3(175B)**。98.1% 的例子它选择调用 QA 工具——模型自己学会了"不懂就问"。

### 6.2 数学（ASDiv / SVAMP / MAWPS）

| 模型 | ASDiv | SVAMP | MAWPS |
| --- | ---: | ---: | ---: |
| GPT-J | 7.5 | 5.2 | 9.9 |
| GPT-J + CC | 9.6 | 5.0 | 9.3 |
| Toolformer (disabled) | 14.8 | 6.3 | 15.0 |
| **Toolformer** | **40.4** | **29.4** | **44.0** |
| OPT (66B) | 6.0 | 4.9 | 7.9 |
| GPT-3 (175B) | 14.0 | 10.0 | 19.8 |

这是最戏剧性的结果：Toolformer 在 ASDiv 上 **40.4 vs GPT-3 的 14.0**，几乎 3 倍。97.9% 的例子用 calculator。有趣的是，即便 disabled（不让调用 API），Toolformer 仍比 GPT-J 强——因为微调时见过大量"调用+结果"的算术文本，顺带把模型自己的数学能力也练上去了。

### 6.3 问答（WebQS / NQ / TriviaQA）

| 模型 | WebQS | NQ | TriviaQA |
| --- | ---: | ---: | ---: |
| GPT-J | 18.5 | 12.8 | 43.9 |
| GPT-J + CC | 18.4 | 12.2 | 45.6 |
| Toolformer (disabled) | 18.9 | 12.6 | 46.7 |
| **Toolformer** | **26.3** | **17.7** | **48.8** |
| OPT (66B) | 18.6 | 11.4 | 45.7 |
| GPT-3 (175B) | 29.0 | 22.6 | 65.9 |

这里 Toolformer 超过同规模基线，但**落后于 GPT-3(175B)**。99.3% 靠 Wikipedia Search。作者归因：搜索引擎太简单（BM25 常返回不相关结果），且模型**不能交互式改写 query 或浏览多条结果**——这正是论文局限性之一，也为后来的检索增强/Agent 多轮搜索留下了空间。

### 6.4 多语言问答（MLQA）与时间（TEMPLAMA / DATESET）

MLQA 上各语言用 MT 工具都有提升（63.8%–94.9% 的例子调用翻译，印地语例外仅 7.3%），但因 CCNet 微调导致部分语言退化，**未稳定超过 GPT-J**。

时间任务上 Toolformer 全面领先：

| 模型 | TEMPLAMA | DATESET |
| --- | ---: | ---: |
| GPT-J | 13.7 | 3.9 |
| GPT-J + CC | 12.9 | 2.9 |
| Toolformer (disabled) | 12.7 | 5.9 |
| **Toolformer** | **16.3** | **27.3** |
| OPT (66B) | 14.5 | 1.3 |
| GPT-3 (175B) | 15.5 | 0.8 |

但 TEMPLAMA 的提升**主要靠 Wiki/QA 工具而非 calendar**（calendar 仅 0.2%）——因为这些时间相关事实太具体，光知道日期没用。DATESET 的提升则**完全归功 calendar**（54.8%），因为这类问题（"30 天前是星期几"）只需知道今天即可。

### 6.5 语言建模能力是否受损？

| 模型 | WikiText (PPL) | CCNet (PPL) |
| --- | ---: | ---: |
| GPT-J | 9.9 | 10.6 |
| GPT-J + CC | 10.3 | 10.5 |
| Toolformer (disabled) | 10.3 | 10.5 |

关键结论：**训练时插入 API 调用不损害无 API 调用时的语言建模能力**——Toolformer(disabled) 的困惑度与 GPT-J+CC 完全一致。这正是 §2 desiderata 里"不损失通用性"的实证验证。

---

## 7. 消融实验

### 7.1 解码策略：放宽 $k$ 的影响

把 greedy（$k=1$）放宽到"$\langle$API$\rangle$ 是 top-$k$ 即发起"会怎样？

| $k$ | T-REx (All / AC / NC / %) | WebQS (All / AC / NC / %) |
| --- | --- | --- |
| 0 | 34.9 / – / 34.9 / 0.0 | 18.9 / – / 18.9 / 0.0 |
| 1 | 47.8 / 53.0 / 44.3 / 40.3 | 19.3 / 17.1 / 19.9 / 8.5 |
| 3 | 52.9 / 58.0 / 29.0 / 82.8 | 26.3 / 26.5 / 6.6 / 99.3 |
| 10 | 53.5 / 54.0 / 22.5 / 98.1 | 26.3 / 26.4 / – / 100.0 |

（All=总体；AC=模型选择调用的子集；NC=选择不调用的子集；%=调用比例）

$k$ 越大调用越频繁（T-REx 从 40.3% → 98.1%）。有趣的是 $k=1$ 时模型**有一定自我校准**：它在"不调用会做得很差"的例子上才选择调用（不调用子集 44.3/19.9 高于平均 34.9/18.9）。但这种校准随 $k$ 增大而**失真**——$k$ 一大就几乎逢题必调，不再区分该不该调。

### 7.2 规模律：工具使用是涌现能力

把方法也用到 GPT-2 家族的 124M/355M/775M/1.6B 上（只用 QA/calculator/Wiki 三个工具），观察规模效应：

![图4 不同规模 GPT-2 + GPT-J 在 LAMA/数学/QA 上的平均表现，启用 vs 禁用 API 调用；小模型用不用工具差不多，约 775M 起工具使用才涌现，且规模越大用 API 与不用的差距越大](/vibe-reading/images/articles/toolformer-language-models-use-tools/fig-4-scaling-laws.png)

**关键发现**：

- **工具使用能力约在 775M 参数才涌现**——更小模型有无工具表现相近（Wiki 搜索例外，因其 API 较易用）。
- 随模型变大，无 API 能力变强，但**用 API 的能力也同步提升**，所以即使最大模型两者仍有明显差距——"学会用好工具"是一条持续爬升的曲线，不是一次到位。

### 7.3 数据质量：筛选分数与有用性正相关

Table 10 按 $L_i^{-} - L_i^{+}$ 降序排列的样例显示：高分对应人类直觉上有用的调用（如 Wiki 查战争纪念窗、QA 查尼罗河长度），低分对应无用甚至负分的调用（如对"迪士尼乐园火警事件"插日历、对"上次我和…一起"插无意义 QA）。有少数反例——"Fast train success" 搜索返回不相关却仍降困惑度。作者指出**少量噪声反而有益**：迫使微调后的模型不盲信 API 结果。

---

## 8. 总结与展望

### 贡献总结

Toolformer 是"工具使用"从**人工示范/任务特定 prompt** 走向**自监督、模型自主决策**的里程碑式工作：它证明了只需少量人工示范，LM 就能靠自己（困惑度作判据）学会在合适的时机调用合适的工具，并在 6.7B 体量上反超 25× 规模的 GPT-3，且不伤及语言建模本职。其"用 LM 自身反馈筛数据再微调自身"的范式，也直接启发了后来的 self-improvement、constitutional AI 等方向。

### 局限性（批判性）

论文 §7 坦陈若干硬伤，值得在读时记牢：

1. **不能链式使用工具**——一个工具的输出不能喂给另一个工具。根因是各 API 调用独立采样，训练数据里没有链式例子，且每输入至多一次调用。
2. **不能交互式使用**——搜索引擎返回多条结果时无法浏览/改写 query 再搜，限制了复杂检索任务（§6.3 落后 GPT-3 的主因）。
3. **对输入措辞敏感**——是否触发调用受 prompt 措辞影响大，与 LM 本身的脆弱性一脉相承。
4. **样本效率低**——calculator/MT 处理百万文档只产出几千条有用调用，算力开销大。
5. **决策时不计工具成本**——模型不知道某次调用多贵，无法在"值不值得"上权衡。
6. **每输入只允许一次调用**——人为上界，直接堵死了多步推理/链式调用。

### 未来方向（idea 三法）

- **弥补缺陷**：在训练数据中显式构造链式/多轮交互式调用样本（如让模型先查日历再据日期查事实），并在筛选阶段允许一次输入多调用、形成调用链；迭代应用本方法（类似 bootstrapping）解决样本效率。
- **新型方案**：把工具调用的计算成本纳入筛选损失（$L_i^{-} - L_i^{+} - \lambda \cdot \text{cost}$）；用强化学习/self-play 让模型学会多轮改写 query、在多条结果间取舍；引入"工具失败"信号，让模型学会何时放弃调用。
- **减少约束**：去掉"每输入至多一次调用"限制，允许模型自主决定调用次数；扩展到更多工具（代码执行器、浏览器、数据库 SQL），逼近通用 Agent 的能力边界。

> **回看意义**：Toolformer 之后，"LM + 工具"基本成了 LLM 的标配能力（后来的 GPT-4 function calling、各类 Agent 框架都沿此脉络）。它把"何时用、用哪个、怎么用结果"三件事压进了一次自监督微调——这份简洁，正是其被广泛引用的原因。
