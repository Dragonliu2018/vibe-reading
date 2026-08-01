---
title: "ReAct: Synergizing Reasoning and Acting in Language Models"
source:
  type: "论文解读"
  project: "Brain Team"
  url: "https://arxiv.org/abs/2210.03629"
  pdf: "/vibe-reading/papers/react-synergizing-reasoning-and-acting.pdf"
date: "2026-07-31T10:30:00+08:00"
category: [AI, Agent, Papers]
tags: ["LLM Agent", "Reasoning", "Chain-of-Thought", "Prompting", "ReAct"]
description: "目的：让 LLM 交错生成推理与动作以协同解题。手段：扩展动作空间纳入语言推理轨迹，推理引导行动、行动获取外部信息。结论：在 QA 与决策任务上显著优于纯推理或纯行动，且更可解释。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/react-synergizing-reasoning-and-acting.pdf" target="_blank" rel="noopener">预览</a> · **论文** [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) · **作者** Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, Yuan Cao（Princeton University / Google Research, Brain team）· **发表** ICLR 2023 · **项目** https://react-lm.github.io/ · **解读** 2026-07-31

---

## 1. 论文概览

**一句话**：ReAct 让大语言模型在解决任务时**交错生成推理轨迹（thought）和任务相关动作（action）**——推理帮助模型制定、跟踪、调整行动计划，动作让模型与外部环境（如 Wikipedia）交互获取信息——两者协同，比单独推理或单独行动都更强。

**take-home**：把"想"和"做"放进同一个闭环里。纯推理（CoT）是"闭门造车"，容易幻觉；纯行动（Act）是"盲目操作"，缺乏规划。ReAct 用推理指导行动、用行动为推理提供事实依据，形成正反馈。

**元信息**：

| 维度 | 内容 |
|------|------|
| 任务 | 知识密集推理（QA、事实验证）+ 交互式决策（文本游戏、网页导航） |
| 核心创新 | 提出通用范式 ReAct，将推理轨迹作为语言空间中的"内部动作"纳入动作空间 |
| 基座模型 | PaLM-540B（主），GPT-3（附录补充，性能更优） |
| 关键结果 | ALFWorld +34%、WebShop +10% 绝对成功率；CoT 幻觉率 56% → ReAct 0% |
| 代码 | https://react-lm.github.io/ |

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

While large language models (LLMs) have demonstrated impressive performance across tasks in language understanding and interactive decision making, their abilities for reasoning (e.g. chain-of-thought prompting) and acting (e.g. action plan generation) have primarily been studied as separate topics. In this paper, we explore the use of LLMs to generate both reasoning traces and task-specific actions in an interleaved manner, allowing for greater synergy between the two: reasoning traces help the model induce, track, and update action plans as well as handle exceptions, while actions allow it to interface with and gather additional information from external sources such as knowledge bases or environments. We apply our approach, named ReAct, to a diverse set of language and decision making tasks and demonstrate its effectiveness over state-of-the-art baselines in addition to improved human interpretability and trustworthiness. Concretely, on question answering (HotpotQA) and fact verification (Fever), ReAct overcomes prevalent issues of hallucination and error propagation in chain-of-thought reasoning by interacting with a simple Wikipedia API, and generates human-like task-solving trajectories that are more interpretable than baselines without reasoning traces. Furthermore, on two interactive decision making benchmarks (ALFWorld and WebShop), ReAct outperforms imitation and reinforcement learning methods by an absolute success rate of 34% and 10% respectively, while being prompted with only one or two in-context examples.

> **译：** 大语言模型在语言理解和交互式决策等任务上展现了出色性能，但其推理能力（如 chain-of-thought 提示）和行动能力（如行动计划生成）此前主要被作为独立课题研究。本文探索让 LLM 以交错方式同时生成推理轨迹和任务相关动作，使两者产生更强的协同：推理轨迹帮助模型诱导、跟踪、更新行动计划并处理异常，而动作让模型与外部知识库或环境交互以获取额外信息。我们将该方法命名为 ReAct，应用于多样化的语言和决策任务，展示了其相对最先进基线的有效性，以及更好的可解释性和可信度。具体而言，在问答（HotpotQA）和事实验证（Fever）上，ReAct 通过与简单 Wikipedia API 交互，克服了 chain-of-thought 推理中普遍的幻觉和错误传播问题；在两个交互式决策基准（ALFWorld 和 WebShop）上，ReAct 分别以 34% 和 10% 的绝对成功率优势超越模仿学习和强化学习方法，且仅使用一到两个上下文示例进行提示。

</details>

---

## 2. 研究背景

### 人类智能的启发

人类在解决任务时会**无缝结合"行动"和"语言推理"（内心独白）**。以做菜为例：在两个具体动作之间，我们用语言推理来跟踪进度（"现在所有食材都切好了，我该烧水了"）、处理异常（"没有盐，用酱油和胡椒代替"）、判断何时需要外部信息（"面团怎么发？搜一下"）。这种"做"与"想"的紧密协同，让人类能快速学习新任务、在未见过的情境下做出稳健决策。

### 现有方法的不足

ReAct 之前，LLM 的"推理"和"行动"被割裂研究：

| 方向 | 代表工作 | 做法 | 局限 |
|------|---------|------|------|
| 纯推理 | Chain-of-Thought (CoT, Wei et al. 2022) | 让 LLM 生成中间推理步骤得出答案 | **静态黑盒**：用自身内部表示生成思考，不与外部世界交互，无法反应性更新知识 → 幻觉与错误传播（Figure 1(1b)） |
| 纯行动 | SayCan (Ahn et al. 2022)、WebGPT (Nakano et al. 2021) | 用 LLM 预测动作、与环境交互 | **不显式推理**：不利用语言进行高层目标推理或维护工作记忆，难以分解目标、跟踪进度（Figure 1(2a)） |
| 半推理 | Inner Monologue (Huang et al. 2022b) | 注入环境反馈作为"内心独白" | **思考受限**：只复述空间事实和当前需完成的目标，缺乏灵活的高层推理（如目标分解、常识推理、异常处理） |

**缺口**：尚无工作系统性地研究推理与行动如何**协同**用于通用任务求解，以及这种协同是否能带来相比单独推理或单独行动的系统性收益。

### 关键人物与相关工作

- **CoT 系列**：Jason Wei 等（Google）的 Chain-of-Thought 提示，揭示 LLM 的"思考程序"能力；后续有 Self-Consistency (Wang et al. 2022a)、Least-to-Most (Zhou et al. 2022)、Zero-shot-CoT (Kojima et al. 2022)。
- **LLM 决策**：WebGPT 用 LM 与浏览器交互回答 ELI5 问题，但依赖昂贵的 RLHF；SayCan 用 LLM 规划机器人动作，用 affordance 模型重排。
- **本文作者**：Shunyu Yao（Princeton，第一作者，Google 实习期间完成）、Karthik Narasimhan（Princeton，通讯作者，此前有 CALM 等文本游戏工作）、Yuan Cao（Google Brain）。后续 Yao 等还提出了 WebShop 基准。

---

## 3. 方法详解

### 核心思想：扩展动作空间

ReAct 的思想极其简洁：**把"推理"本身作为一种动作纳入动作空间**。

考虑一个与环境交互求解任务的通用 agent 设定：在时刻 $t$，agent 收到观测 $o_t$，依据策略 $\pi(a_t \mid c_t)$ 采取动作 $a_t$，其中上下文 $c_t = (o_1, a_1, \ldots, o_{t-1}, a_{t-1}, o_t)$。

当映射 $c_t \mapsto a_t$ 高度隐式、需要大量计算时（如 Figure 1(1c) 的 Act-only agent 无法从轨迹上下文中推理出正确的最终动作），直接学习策略很困难。ReAct 的解法：

**将动作空间从 $\mathcal{A}$ 扩展为 $\hat{\mathcal{A}} = \mathcal{A} \cup \mathcal{L}$**，其中 $\mathcal{L}$ 是语言空间。语言空间中的动作 $\hat{a}_t \in \mathcal{L}$ 称为**思考（thought / reasoning trace）**——它不影响外部环境（不产生观测反馈），而是通过对当前上下文 $c_t$ 进行推理来组合有用信息，更新上下文 $c_{t+1} = (c_t, \hat{a}_t)$ 以支持后续推理或行动。

### ReAct 的思考类型

![Figure 1：ReAct 与 4 种 prompting 方法对比。左侧为 HotpotQA 问题，对比 (a) Standard、(b) CoT (Reason Only)、(c) Act-only、(d) ReAct (Reason+Act)；右侧为 ALFWorld 游戏，对比 (a) Act-only 与 (b) ReAct。两种场景均省略 prompt 中的上下文示例，仅展示模型生成的轨迹（Act、Thought）与环境反馈（Obs）。](/vibe-reading/images/articles/react-synergizing-reasoning-and-acting/fig-01-prompting-comparison.png)

如图 1 所示，ReAct 的思考多种多样：

- **目标分解与计划制定**：将高层目标拆解为子目标序列（Figure 1(2b), Act 1; 1d, Thought 1）
- **注入常识知识**：利用 LLM 预训练知识推断物品可能位置（如"胡椒摇罐更可能出现在柜子、台面"）
- **从观测中提取关键信息**：从 Wikipedia 检索结果中摘取关键事实（Figure 1(1d), Thought 2, 4）
- **跟踪进度与切换子目标**：标记当前子目标完成、确定下一步（Figure 1(2b), Act 8）
- **异常处理与计划调整**：当搜索失败时重新表述查询、当预期落空时调整策略（Figure 1(1d), Thought 3）

### 两种思考密度：Dense vs Sparse

ReAct 针对不同任务类型采用不同的思考-动作交替策略：

| 任务类型 | 思考密度 | 轨迹结构 | 示例 |
|---------|---------|---------|------|
| 知识密集推理（QA、事实验证） | **Dense thought** | thought → action → observation → thought → action → ... 多轮交替 | Figure 1(1d)：每一步搜索前后都有思考 |
| 交互式决策（ALFWorld、WebShop） | **Sparse thought** | thought 稀疏出现在最关键位置，模型自主决定何时思考 | Figure 1(2b)：在关键决策点插入少量思考 |

### ReAct 的独特优势

- **A) 直观易设计**：人工标注者只需在动作之上写下自己的思考，无需特殊格式选择或示例选择策略。
- **B) 通用灵活**：灵活的思考空间和思考-动作交替格式适配多样任务（QA、事实验证、文本游戏、网页导航）。
- **C) 高性能与鲁棒性**：仅从 1–6 个上下文示例学习，即在不同领域一致超越基线。
- **D) 人类可对齐可控**：生成可解释的顺序决策与推理过程，人类可轻松检查推理与事实正确性，甚至通过**编辑思考**来实时纠正 agent 行为（见 §7）。

---

## 4. 关键公式解读

ReAct 的形式化非常简洁，核心只有两个表达式：

$$
\hat{\mathcal{A}} = \mathcal{A} \cup \mathcal{L}
$$

$$
\pi(a_t \mid c_t), \quad c_t = (o_1, a_1, \ldots, o_{t-1}, a_{t-1}, o_t)
$$

**逐项解读**：

- $\mathcal{A}$：原始动作空间（与环境交互的外部动作，如 `search[entity]`、`go to cabinet 1`）
- $\mathcal{L}$：语言空间（自由形式的自然语言推理轨迹）
- $\hat{\mathcal{A}} = \mathcal{A} \cup \mathcal{L}$：**扩展后的动作空间**——这是 ReAct 的核心创新。思考被提升为与外部动作并列的一等公民
- $\hat{a}_t \in \mathcal{L}$（thought）：语言空间中的动作，**不产生环境观测**，仅更新内部上下文
- $a_t \in \mathcal{A}$（action）：外部动作，**产生环境观测** $o_{t+1}$
- $\pi(a_t \mid c_t)$：策略，本文为冻结的 LLM（PaLM-540B）通过 few-shot prompting 实现

**关键含义**：思考 $\hat{a}_t$ 虽不直接改变环境，但改变了后续动作的条件概率 $\pi(a_{t+1} \mid c_{t+1})$——它"重塑"了上下文，使原本隐式的 $c_t \mapsto a_t$ 映射变得显式可计算。这等价于在上下文中进行**计算**（类似 Scratchpad），但更灵活——因为思考内容不受固定格式约束。

> 语言空间 $\mathcal{L}$ 理论上无限，因此 ReAct 要求 LLM 具备强语言先验。本文聚焦 frozen LLM + few-shot prompting 的设定，后续微调实验（§7）验证了 ReAct 的可扩展性。

---

## 5. 实验设置

### 数据集

| 任务 | 数据集 | 输入 | 目标 | 特点 |
|------|--------|------|------|------|
| 多跳问答 | HotpotQA (Yang et al. 2018) | 问题 | 答案 (EM) | 需推理 2+ 篇 Wikipedia 文章 |
| 事实验证 | FEVER (Thorne et al. 2018) | 声明 | SUPPORTS/REFUTES/NOT ENOUGH INFO | 声明间差异可能极小，需精确检索 |
| 文本游戏 | ALFWorld (Shridhar et al. 2020b) | 文本环境描述 | 完成家务目标 (成功率) | 6 类任务，>50 位置，专家策略 >50 步 |
| 网页导航 | WebShop (Yao et al. 2022) | 购物指令 | 购买满足所有要求的产品 (SR) | 1.18M 真实产品，12k 人类指令 |

### 动作空间设计

**知识密集任务**（HotpotQA、FEVER）——设计极简 Wikipedia API：

| 动作 | 行为 | 设计意图 |
|------|------|---------|
| `search[entity]` | 返回对应 wiki 页前 5 句，或建议 top-5 相似实体 | 模拟人类查 Wikipedia |
| `lookup[string]` | 返回页面中包含该串的下一句（模拟 Ctrl+F） | 精确定位关键句 |
| `finish[answer]` | 结束任务并给出答案 | 终止条件 |

> 这个动作空间**显著弱于** SOTA 词法/神经检索器——只能基于精确页面名检索片段。目的是强制模型通过显式语言推理来检索。

**决策任务**（ALFWorld、WebShop）——使用环境原生动作：
- ALFWorld：`go to X`、`take Y from Z`、`clean Y with Z`、`put Y in/on Z` 等
- WebShop：`search[query]`、`click[item_id]`、`click[option]`、`click[Buy Now]`

### 基线方法

通过对 ReAct 轨迹系统性消融构建基线：

| 基线 | 构建方式 | 角色 |
|------|---------|------|
| Standard | 移除 ReAct 中所有 thoughts、actions、observations | 直接回答 |
| CoT | 移除 actions 和 observations | 纯推理 |
| CoT-SC | 对 CoT 采样 21 条轨迹，取多数答案 | CoT + 自洽性 |
| Act | 移除 thoughts，仅保留 actions 和 observations | 纯行动（类似 WebGPT 的交互方式） |
| ReAct→CoT-SC | ReAct 在给定步数内无答案时回退到 CoT-SC | 内外部知识结合（策略 A） |
| CoT-SC→ReAct | CoT-SC 多数答案出现 < n/2 次时回退到 ReAct | 内外部知识结合（策略 B） |

### 模型与提示

- **主模型**：PaLM-540B（frozen，greedy decoding）
- **few-shot 示例**：HotpotQA 6 个、FEVER 3 个（更多不提升性能）、ALFWorld 每任务类型 3 个、WebShop 1 个（one-shot）
- **微调**：用 ReAct 生成的 3,000 条正确答案轨迹微调 PaLM-8B/62B（类似 STaR 的 bootstrap 方法）

---

## 6. 实验结果

### 主结果：知识密集任务

![Table 1 与 Figure 2：PaLM-540B 在 HotpotQA 和 FEVER 上的 prompting 结果。左表为各方法的 EM/Acc；右图为不同 CoT-SC 采样数下的性能曲线。](/vibe-reading/images/articles/react-synergizing-reasoning-and-acting/fig-02-results-and-cotsc-samples.png)

**Table 1 关键数值**：

| 方法 | HotpotQA (EM) | FEVER (Acc) |
|------|:---:|:---:|
| Standard | 28.7 | 57.1 |
| CoT | 29.4 | 56.3 |
| CoT-SC (21 samples) | 33.4 | 60.4 |
| Act | 25.7 | 58.9 |
| **ReAct** | 27.4 | **60.9** |
| CoT-SC→ReAct | 34.2 | **64.6** |
| **ReAct→CoT-SC** | **35.1** | 62.0 |
| Supervised SoTA | 67.5 | 89.5 |

**关键发现**：

1. **ReAct 一致优于 Act**：在两个任务上均成立，证明推理对行动的指导价值——尤其在合成最终答案时。
2. **ReAct vs CoT 因任务而异**：FEVER 上 ReAct (60.9) > CoT (56.3)，因为事实验证需要精确、最新的知识检索；HotpotQA 上 ReAct (27.4) 略低于 CoT (29.4)，因为 ReAct 受限于 Wikipedia API 的检索能力。
3. **ReAct + CoT-SC 结合最优**：两种结合策略各自在一个任务上领先，且都**一致优于** CoT-SC——这说明内部知识（CoT）与外部知识（ReAct）互补。Figure 2 显示，结合策略用仅 3–5 个样本即可达到 CoT-SC 21 个样本的性能。
4. **与监督 SoTA 差距仍大**：prompting 方法远未达到领域特定的 SOTA（67.5 / 89.5），暗示微调有巨大空间。

### 失败模式深度分析

论文对 HotpotQA 随机抽取 200 个轨迹（ReAct/CoT 各 100 对正误样本）进行人工标注，结果极具洞察力：

| 类型 | 定义 | ReAct | CoT |
|------|------|:---:|:---:|
| **成功** | True positive（正确推理+正确事实） | 94% | 86% |
| 成功 | False positive（幻觉推理或事实但碰巧答对） | 6% | 14% |
| **失败** | 推理错误（含重复循环） | 47% | 16% |
| 失败 | 搜索结果错误（空/无有用信息） | 23% | — |
| 失败 | 幻觉（编造推理或事实） | **0%** | **56%** |
| 失败 | 标签歧义（预测正确但未精确匹配） | 29% | 28% |

**三大洞察**：

- **A) 幻觉是 CoT 的致命伤**：CoT 56% 的失败来自幻觉，假阳性率 14% 远高于 ReAct 的 6%。ReAct 借助外部知识库，轨迹更 grounded、更可信。
- **B) ReAct 付出"灵活性"代价**：交错推理-行动-观测的结构约束降低了推理步骤的灵活性，导致推理错误率 (47%) 高于 CoT (16%)。ReAct 有一个特有的失败模式——**重复生成先前的思考和动作**陷入循环（归入"推理错误"，疑因贪心解码次优）。
- **C) 搜索质量至关重要**：23% 的 ReAct 失败由无信息检索导致，会误导后续推理且难以恢复。这 motivates 了 ReAct + CoT-SC 的结合策略。

### 关键发现：ReAct 获取最新知识

![Figure 4：一个 HotpotQA 标签过时的例子。原标签为 2885（酒店旧房间数），只有 ReAct 通过实时网络交互+推理找到最新答案 3147（2887 间客房+260 套房）。Standard 和 CoT 因幻觉答错，Act 虽能联网但缺乏推理引导也无法答对。](/vibe-reading/images/articles/react-synergizing-reasoning-and-acting/fig-04-outdated-label-example.png)

Figure 4 展示了一个引人注目的案例：问题问某酒店房间数，HotpotQA 构建时的标签 2885 已过时（酒店扩建后为 2887 间客房+260 套间）。**只有 ReAct** 能检索到最新信息并正确推理出答案 3147——Standard 和 CoT 依赖过时参数知识答错，Act 虽能联网但缺乏推理引导也无法有效利用搜索结果。这预示了 ReAct 对互联网增强 LLM 的价值。

### 主结果：决策任务

**ALFWorld**（134 个未见游戏，task-specific 评估）：

| 方法 | Pick | Clean | Heat | Cool | Look | Pick 2 | All |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Act (best of 6) | 88 | 42 | 74 | 67 | 72 | 41 | 45 |
| **ReAct (best of 6)** | **92** | **58** | **96** | **86** | 78 | 41 | **71** |
| ReAct-IM (best of 6) | 62 | 68 | 87 | 57 | 39 | 33 | 53 |
| BUTLER (best of 8, 模仿学习) | 46 | 39 | 74 | 100 | 22 | 24 | 37 |

- ReAct 最佳试验达 71% 平均成功率，**以 34 个百分点绝对优势**碾压 Act (45%) 和 BUTLER (37%)
- 即便 ReAct 最差的试验 (48%) 也超过 Act 和 BUTLER 的最佳试验
- ReAct 相对 Act 的优势在 6 次受控试验中一致，相对增益 33%–90%，平均 62%

**WebShop**（500 条测试指令）：

| 方法 | Score | SR (成功率) |
|------|:---:|:---:|
| Act | 62.3 | 30.1 |
| **ReAct** | **66.6** | **40.0** |
| IL（模仿学习） | 59.9 | 29.1 |
| IL+RL | 62.4 | 28.7 |
| Human | 82.1 | 59.6 |

- One-shot ReAct 即比 IL/IL+RL 高 10 个绝对百分点成功率
- ReAct 更擅长通过推理**桥接噪声观测与动作**（如"For 'space-saving ottoman bench', the item has options '39x18x18inch' and 'blue' and seems good to buy"）
- 但仍远低于人类 (59.6%)——人类做了更多产品探索和查询重述

### ReAct vs Inner Monologue：内部推理 vs 外部反馈

ReAct 与 Inner Monologue (IM) 的消融对比（Table 3）直接回答了一个核心问题：**灵活的内部推理 vs 简单的外部反馈复述，哪个更重要？**

ReAct-IM 使用与 ReAct 相同的专家轨迹，但将思考重标注为**密集的外部反馈**——仅限(1)分解当前目标和(2)当前需完成的子目标，**缺乏**：判断子目标何时完成、确定下一子目标、调用预训练常识知识推断物品位置。

结果：ReAct (71) 大幅优于 ReAct-IM (53)，在 6 个任务中 5 个领先。ReAct-IM 常因缺乏高层目标分解而误判子目标完成时机，或因缺乏常识推理而找不到物品。**这证明了灵活、稀疏的内部推理的价值——不仅仅是复述环境状态。**

---

## 7. 消融实验

### 微调的 Scaling 效应

![Figure 3：HotpotQA 上 prompting 与 finetuning 的 scaling 结果。左图为 prompting（8B/62B/540B），右图为 finetuning（用 3,000 条 ReAct 生成轨迹）。prompting 时 ReAct 在小模型上最差（难以从上下文示例学会同时推理+行动），但 finetuning 后 ReAct 跃升为最优——PaLM-8B finetuned ReAct 超越所有 PaLM-62B prompting，PaLM-62B finetuned ReAct 超越所有 PaLM-540B prompting。](/vibe-reading/images/articles/react-synergizing-reasoning-and-acting/fig-03-scaling-prompt-finetune.png)

Figure 3 揭示了一个重要的 scaling 故事：

- **Prompting 阶段**（左图）：小模型 (8B/62B) 上 ReAct 表现最差——同时学习推理和行动对上下文学习来说负担太重。540B 时 ReAct 才具备竞争力。
- **Finetuning 阶段**（右图）：仅用 3,000 条轨迹微调后，ReAct **反超所有方法**：
  - PaLM-8B finetuned ReAct > 所有 PaLM-62B prompting 方法
  - PaLM-62B finetuned ReAct > 所有 PaLM-540B prompting 方法
- **为何微调后 ReAct 最优**：微调 Standard/CoT 本质是教模型**记忆**（可能幻觉的）知识事实；微调 ReAct/Act 是教模型**如何（推理和）行动**来从 Wikipedia 获取信息——后者是更可泛化的技能。

> 这暗示：prompting 的瓶颈在于"上下文学习同时学推理+行动"的难度，而非方法本身。更多高质量人工标注数据的微调可能是释放 ReAct 潜力的更好路径。

### Human-in-the-Loop：思考编辑纠正行为

![Figure 5：ALFWorld 中 human-in-the-loop 行为纠正示例。(a) ReAct 轨迹因一个幻觉思考（Act 17）而失败；(b) 人类仅编辑两个思考（Act 17、23），ReAct 轨迹即产生正确的推理与动作并成功完成任务。这种"策略即时编辑"对 Act 和 RL 方法几乎不可能——人类无法改模型参数，改几个动作也难以影响后续行为。](/vibe-reading/images/articles/react-synergizing-reasoning-and-acting/fig-05-human-thought-edit.png)

Figure 5 展示了 ReAct 独有的**人类对齐新范式**：

- **问题**：(a) 中 ReAct 在 Act 17 产生幻觉（误以为找到了第二个钥匙链），导致后续动作全部偏离。
- **纠正**：人类仅删除 Act 17 中的幻觉句子，并在 Act 23 添加提示（"第二个钥匙链更可能在 dresser、garbagecan、safe、sidetable、sofa、shelf 1-2"）。
- **效果**：(b) 中 ReAct 立即根据编辑后的思考调整行为，前往 dresser 1 找到钥匙链并成功完成任务。

**意义**：对人类而言，从"输入几十个动作"简化为"只编辑两个思考"，开启了新的人机协作形式。这超越了 Inner Monologue 的对话式目标更新——编辑思考可以修改模型的内部信念、推理风格，乃至思考空间支持的任何内容。

---

## 8. 总结与展望

### 贡献总结

1. **提出 ReAct 范式**：首个系统性地将推理与行动协同用于 LLM 通用任务求解的提示范式。
2. **跨领域实证**：在 4 个多样化基准（QA、事实验证、文本游戏、网页导航）上展示 ReAct 的一致优势。
3. **系统消融与分析**：深入分析了行动对推理的价值、推理对决策的价值，以及 ReAct 的失败模式。
4. **微调与可控性验证**：初步微调实验展示 ReAct 的可扩展性；human-in-the-loop 思考编辑展示新的对齐范式。

### 局限性（批判性）

- **Prompting 瓶颈**：复杂任务、大动作空间需要大量 demonstrations 才能学好，容易超出上下文长度限制。小模型上 prompting ReAct 表现最差（Figure 3 左图），方法对模型规模有较高要求。
- **重复循环问题**：ReAct 有特有的失败模式——重复生成先前的思考和动作陷入死循环，疑因贪心解码次优（论文推测 beam search 可能有帮助，但未验证）。
- **检索能力受限**：23% 的失败由无信息检索导致，简单的 Wikipedia API 限制了 ReAct 在 HotpotQA 上的表现（低于 CoT）。这本质上是"弱检索器"的代价——论文刻意如此设计以强制显式推理，但实际应用中需要更强的检索工具。
- **与监督 SoTA 差距大**：prompting 方法在 HotpotQA (35.1 vs 67.5) 和 FEVER (64.6 vs 89.5) 上与领域特定 SOTA 差距巨大，提示 prompting 的天花板可能有限。
- **评估范围有限**：决策任务仅测试了 ALFWorld 和 WebShop 两个环境，未覆盖更复杂的真实世界场景（如多 agent 协作、长期规划）。

### 未来方向（idea 三法）

**弥补缺陷**：
- 用更好的解码策略（beam search、constrained decoding）解决重复循环问题
- 用更强的检索器（神经检索、BM25）替代简单 Wikipedia API，同时保留 ReAct 的推理引导
- 用更长上下文窗口的模型 + 更多 demonstrations 突破 prompting 瓶颈

**新型方案**：
- **ReAct + RL**：用强化学习在 ReAct 轨迹上训练，而非仅靠模仿正确答案的 bootstrap 微调——RL 可以探索更优的推理-行动策略
- **多 agent ReAct**：多个 ReAct agent 协作，各自负责不同子任务，通过语言通信协调——ReAct 的思考天然适合作为 agent 间通信协议
- **ReAct + 工具增强**：将动作空间从 Wikipedia API 扩展到计算器、代码解释器、数据库查询等更多工具，形成通用 tool-use agent

**减少约束**：
- 从 frozen LLM + few-shot prompting 走向大规模多任务微调，释放 ReAct 的泛化潜力
- 探索 ReAct 在多模态（视觉、音频）环境中的扩展——思考仍为语言，但动作和观测可为多模态
- 将 ReAct 的"思考即动作"思想推广到其他认知架构（如 Tree of Thoughts、Graph of Thoughts），形成更丰富的推理结构

> **历史定位**：ReAct 是 LLM Agent 领域的奠基性工作之一。它确立了"推理与行动协同"的基本范式，直接影响了后世无数的 agent 框架（LangChain、AutoGPT、Toolformer 等）。"Thought → Action → Observation"的轨迹格式已成为 agent 领域的事实标准。论文发表于 2022 年 10 月（ICLR 2023），截至 2026 年已被引用数万次，是理解现代 LLM Agent 不可绕过的里程碑。
