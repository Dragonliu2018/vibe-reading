---
title: "τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains"
source:
  type: "论文解读"
  project: "Sierra"
  url: "https://arxiv.org/abs/2406.12045"
  pdf: "/vibe-reading/papers/tau-bench-tool-agent-user-interaction.pdf"
date: "2026-08-01T19:00:00+08:00"
category: [AI, Agent, Evaluation, Papers]
tags: ["LLM Agent", "Benchmark", "Tool Use", "Function Calling", "pass^k", "Reliability", "User Simulation"]
description: "目的：评测 agent 在真实场景中与人/工具交互并遵循领域规则的一致性。手段：LM 模拟用户 + 领域 API/策略 + 数据库终态对比奖励 + pass^k 指标。结论：gpt-4o pass^1<50%、pass^8<25%，agent 一致性与规则遵循仍远不够。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/tau-bench-tool-agent-user-interaction.pdf" target="_blank" rel="noopener">预览</a> · **论文** [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045) · **作者** Shunyu Yao, Noah Shinn, Pedram Razavi, Karthik Narasimhan（Sierra）· **发表** arXiv 2406.12045, 2024-06 · **项目** https://github.com/sierra-research/tau-bench · **解读** 2026-08-01

---

## 1. 论文概览

τ-bench（**T**ool-**A**gent-**U**ser interaction **bench**mark）是 Sierra 提出的 agent 评测基准，专门针对一个被既有工作忽略的缺口：agent 既要与**真实（被 LM 模拟的）人类用户**多轮交互、又要调用**领域 API**、还要严格**遵循领域策略文档**——三者必须同时发生，且在多次重复中保持一致。

一句话 take-home：**即便最强的 gpt-4o，单次任务成功率（pass¹）也不到 50%，连续 8 次都成功（pass⁸）更是跌到 25% 以下**——agent 的真正瓶颈不是"能不能做对一次"，而是"能不能每次都做对"。为此作者提出 **pass^k** 指标，把"可靠性"而非"单次峰值"作为核心评测维度。

- **任务**：在零售（τ-retail）与航空（τ-airline）两个客服域中，agent 通过数据库 API 工具 + 自然语言对话帮模拟用户完成订单/预订类任务，并全程遵守域策略规则。
- **评测**：对话结束后比对数据库写操作终态与标注的唯一正确终态，奖励 $r = r_{\text{action}} \times r_{\text{output}} \in \{0,1\}$——快、客观、忠实。
- **贡献**：① 一个模块化、可扩展的真实交互基准；② 一个衡量一致性的新指标 pass^k；③ 一套揭示当前 agent 失败模式的实证分析。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Existing benchmarks do not test language agents on their interaction with human users or ability to follow domain-specific rules, both of which are vital for deploying them in real world applications. We propose $\tau$-bench, a benchmark emulating dynamic conversations between a user (simulated by language models) and a language agent provided with domain-specific API tools and policy guidelines. We employ an efficient and faithful evaluation process that compares the database state at the end of a conversation with the annotated goal state. We also propose a new metric (pass^k) to evaluate the reliability of agent behavior over multiple trials. Our experiments show that even state-of-the-art function calling agents (like gpt-4o) succeed on < 50% of the tasks, and are quite inconsistent (pass^8 < 25% in retail). Our findings point to the need for methods that can improve the ability of agents to act consistently and follow rules reliably.

> **译：** 现有基准既不测试语言 agent 与人类用户的交互，也不测试其遵循领域规则的能力，而这两者对真实部署至关重要。我们提出 τ-bench，一个模拟用户（由 LM 模拟）与语言 agent（配备领域 API 工具与策略指南）之间动态对话的基准。我们采用高效且忠实的评测流程：将对话结束时的数据库状态与标注的目标状态进行比对。我们还提出新指标 pass^k，用于评估 agent 在多次试验中行为的可靠性。实验表明，即便最强的 function calling agent（如 gpt-4o）成功率也低于 50%，且相当不稳定（retail 域 pass^8 < 25%）。这些发现表明，亟需能提升 agent 行为一致性与规则遵循能力的方法。

</details>

---

## 2. 研究背景

把 agent 真正部署到生产系统，作者提出三个**desiderata（必要条件）**：

1. **长程多模态交互**：agent 必须既与人类、又与程序化 API 在长时域上交互，增量收集信息、消解意图；
2. **领域规则遵循**：必须精确遵守特定任务/域的策略与规则（如"基础经济舱不可改签"）；
3. **规模化一致性**：在百万级交互中保持一致与可靠。

一个 motivating 例子（Figure 1）：用户想把航班改到旧金山，agent 需查 reservation → 发现是基础经济舱不可改 → 但 24h 内可取消重订 → 向用户提议取消重订 → 用户同意 → 执行 cancel + book。这要求 agent 在数据库、规则、用户意图之间做长程零样本推理。

### 既有工作的盲区

| 基准类型 | 代表 | 不足 |
|---|---|---|
| **工具调用基准** | BFCL、ToolBench、MetaTool、ToolEmu | 只测**单步**交互——用户一次性给出全部信息，agent 无需多轮收集信息/授权 |
| **任务型对话** | 静态数据集（MultiWOZ 等）/ 规则/符号用户模拟器 | 要么静态离线、要么模拟器刻板，难以产生自然且多样的长对话 |
| **LM 用户模拟** | Generative Agents 等 | 用于展示模拟能力，**未用于评测 agent 可靠性** |

τ-bench 的定位：把**工具调用 + 对话 + 规则遵循**统一到真实设置下，用 SOTA LM 生成自然用户语、用数据库终态做客观评测、用 pass^k 量化一致性——填补"真实人机交互下的可靠性评测"空白。

---

## 3. 方法详解

### 3.1 POMDP 形式化

每个 τ-bench 任务建模为部分可观马尔可夫决策过程 $(S, A, O, T, R, U)$：状态空间 $S$、动作空间 $A$、观测空间 $O$、转移 $T: S \times A \to S \times O$、奖励 $R: S \to [0,1]$、指令空间 $U$。agent 同时与两类对象交互，因此状态/动作/观测都做分解：

$$
S = S_{\text{db}} \otimes S_{\text{user}}, \quad A = A_{\text{db}} \cup A_{\text{user}}, \quad O = O_{\text{db}} \cup O_{\text{user}}
$$

- **数据库侧**（$S_{\text{db}}, A_{\text{db}}, O_{\text{db}}$）：状态对 agent 和用户都**隐藏**，只能通过 `tool_name(**kwargs)` 形式的 API 读写；转移 $T_{\text{db}}$ 是**确定性**的 Python 函数。
- **用户侧**（$S_{\text{user}}, A_{\text{user}}, O_{\text{user}}$）：用户状态 = 初始指令 system prompt + 全部对话历史；转移 $T_{\text{user}}$ 是**随机**的（LM 采样）。用户看不到 agent↔tool 的交互历史。当用户输出 `###STOP###`，回合结束、进入评测。

### 3.2 四个模块化组件

![图2 τ-bench 的模块化组件：数据库 JSON、API 工具、域策略、任务实例](/vibe-reading/images/articles/tau-bench-tool-agent-user-interaction/fig-2-components.png)

如图 2，τ-bench 由四类组件构成：

1. **JSON 数据库**（Figure 2a）：如 τ-retail 的订单条目，含 `order_id`/`user_id`/`items`/`options` 等。agent 只能经 API 间接访问。
2. **Python API 工具**（Figure 2b）：如 `return_delivered_order_items(order_id, item_ids, payment_method_id)`，分 write / non-write 两类。
3. **Markdown 域策略**（Figure 2c）：解释数据库、流程、限制。部分限制硬编码进 API（如用不存在的 payment_id 会报错），部分靠 agent 自觉（如不同会员等级的行李额度）——给 agent 与真实客服同等自由度。
4. **任务实例**（Figure 2d）：含**用户指令**（隐藏于 agent，用于模拟用户）+ **ground truth 数据库写动作标注**（用于评测）。

关键设计：用户指令被构造为**在域策略下只可能有唯一正确的数据库终态**——这是客观评测的前提。

### 3.3 奖励：数据库终态对比

$$
r = r_{\text{action}} \times r_{\text{output}} \in \{0, 1\}
$$

- $r_{\text{action}}$：最终数据库是否与唯一 ground truth 终态一致（只看 write 动作）；
- $r_{\text{output}}$：agent 对用户的回复是否包含所有必要信息（如用户问总价，回复需含 `"54.04"`、`"41.64"` 子串）。

> 这种基于规则的奖励**快速且忠实**：对话过程允许随机变化（用户可换种说法），但只要终态对就算成功。代价是任务标注要慢工出细活——作者用"慢标注换快评测"的 trade-off。

### 3.4 三阶段构建流程

![图1 τ-bench 设置与航空域示例轨迹](/vibe-reading/images/articles/tau-bench-tool-agent-user-interaction/fig-1-setup-trajectory.png)

- **Stage I — 手工设计** schema / API / 策略：从真实对应物简化而来，求逻辑一致与标注便利。即便最简域也需数十种 schema/API/规则。
- **Stage II — LM 辅助数据生成**：给定示例条目，用 gpt-4 生成可扩展的采样代码，人工微调 bug。
- **Stage III — 手工任务标注 + agent 运行验证**：写初始用户指令 → 用 gpt-4-turbo FC agent 试跑 → 检查轨迹 → 修指令消除歧义 → 迭代到"零歧义"（每条 τ-retail 任务跑 40+ 次验证）。可直接复制/编辑 agent 的动作做 ground truth 标注。

---

## 4. 关键公式解读

τ-bench 的核心创新是 **pass^k** 指标，与代码生成中经典的 **pass@k** 形成对照。设某任务跑 $n$ 次试验、其中 $c$ 次成功：

$$
\text{pass}^k = \mathbb{E}_{\text{task}}\!\left[\frac{\binom{c}{k}}{\binom{n}{k}}\right], \quad \text{pass@k} = 1 - \mathbb{E}_{\text{task}}\!\left[\frac{\binom{n-c}{k}}{\binom{n}{k}}\right]
$$

$\underbrace{\text{pass@k}}_{\text{至少成功一次}}$ vs $\underbrace{\text{pass}^k}_{\text{每次都成功}}$

两者的本质区别：

- **pass@k**（pass *at* k）：$k$ 次里**至少成功一次**的概率——刻画"能否发现解"，适合代码生成（有单元测试兜底，发现一次解即可）。随 $k$ 增大**单调上升**，奖励 inference-time compute 的扩展。
- **pass^k**（pass *hat* k）：$k$ 次**全部成功**的概率——刻画"是否可靠"。随 $k$ 增大**单调下降**，直接暴露 agent 的不稳定性。

> 为什么客服场景需要 pass^k？真实部署里 agent 服务百万级用户，**每个用户只有一次机会**——"偶尔能做对"远不够，"每次都做对"才是底线。τ-bench 中同一任务的 user prompt 与数据库转移相同，仅 LM 采样带来随机性，因此 pass^k 能精准度量 agent 对"同语义不同说法"的鲁棒性。默认主指标 $k=1$：$\text{pass}^1 = \text{pass@1} = \mathbb{E}[c/n]$。

---

## 5. 实验设置

### 5.1 两个域

| 统计项 | τ-retail | τ-airline |
|---|---|---|
| 数据库 | 500 users / 50 products / 1,000 orders | 500 users / 300 flights / 2,000 reservations |
| API 工具 | 7 write + 8 non-write | 6 write + 7 non-write |
| 任务数 | 115 | 50 |

- **τ-retail**：客服处理取消/修改订单、退换货、改地址、信息查询。约束简化标注与 API 设计（每个 pending order 只能取消/修改一次、delivered order 只能退/换一次、不能跨产品类型换）。
- **τ-airline**：客服处理订/改/取消航班、退款。300 航班覆盖 20 个美国城市、含直飞与一停靠。策略更复杂、更 ad-hoc（支付方式组合、行李额度随会员等级与舱位变化、改签取消规则）——形成多跳推理谜题。

### 5.2 模型与方法

- **模型**（经 API 测试）：OpenAI（gpt-4o / gpt-4-turbo / gpt-4-32k / gpt-3.5-turbo）、Anthropic（claude-3-opus / sonnet / haiku）、Google（gemini-1.5-pro / flash）、Mistral（mistral-large / open-mixtral-8x22b）、AnyScale（meta-llama-3-70B）。仅后两者开源权重；不测 7/13B 小模型（基准太难）。
- **方法**：
  - **Function Calling（FC）**——主方法，所有模型除 Llama-3 原生支持；system prompt 设为域策略，每轮自主决定回复用户或调用工具。
  - **ReAct**——文本格式 `Thought: {...} Action: {...}` 零样本。
  - **Act**——ReAct 的消融，只输出 action。
  - 排除 self-reflection（真实客服只有一次机会）、planning（太慢）。
- **超参**：每任务最多 30 个动作（工具调用或用户回复）；主结果每任务 ≥3 次试验；agent 温度 0.0、用户温度 1.0。
- **复现**：代码与数据开源于 [github.com/sierra-research/tau-bench](https://github.com/sierra-research/tau-bench)。

---

## 6. 实验结果

### 6.1 主结果：模型对比

| 模型 | retail | airline | avg |
|---|---|---|---|
| **gpt-4o** | **61.2** | **35.2** | **48.2** |
| gpt-4-turbo | 57.7 | 32.4 | 45.1 |
| gpt-4-32k | 56.5 | 33.0 | 44.8 |
| gpt-3.5-turbo | 20.0 | 10.8 | 15.4 |
| claude-3-opus | 44.2 | 34.7 | 39.5 |
| claude-3-sonnet | 26.3 | 27.6 | 27.0 |
| claude-3-haiku | 19.0 | 14.4 | 16.7 |
| gemini-1.5-pro | 21.7 | 14.0 | 17.9 |
| gemini-1.5-flash | 17.4 | 26.0 | 21.7 |
| mistral-large | 30.7 | 22.4 | 26.6 |
| mixtral-8x22b | 17.7 | 31.6 | 24.7 |
| meta-llama-3-70B | 14.8 | 14.4 | 14.6 |

*Table 2：各模型 function calling 的 pass¹（Llama-3 为 text-ReAct）。avg 按域加权、非按任务。*

几个发现：

- gpt-4o 最强，但离"解决 τ-bench"仍很远——更难的 τ-airline 只有 35.2%。
- **开源权重模型与专有模型差距显著**：llama-3-70b（14.6）/ mixtral-8x22b（24.7）远落后于 gpt-4o（48.2）/ claude-3-opus（39.5）。
- 各模型性能谱系宽 + 各任务难度谱系宽（Figure 7）+ 距满分远——τ-bench 对未来模型有足够区分度。

### 6.2 方法对比：FC > ReAct > Act

![图3 τ-retail 上各模型/方法的 pass¹ 对比](/vibe-reading/images/articles/tau-bench-tool-agent-user-interaction/fig-3-method-comparison.png)

原生的 function calling 一致优于文本格式的 agent 方法（ReAct / Act）。对文本方法，加 reasoning trace 仍有帮助（ReAct > Act）——trace 能弥合观测与陌生格式动作之间的鸿沟。给 FC agent 加 "think" 函数则未提升，可能因 FC 模型未为此类推理训练过。

### 6.3 一致性：pass^k 急剧下降

![图4 τ-retail 上 pass^k（实线）与 pass@k（虚线）随 k 变化](/vibe-reading/images/articles/tau-bench-tool-agent-user-interaction/fig-4-passk-scaling.png)

这是全文最关键的结果：即便 gpt-4o 的平均成功率 >60%，其 **pass⁸ 跌到 25% 以下**。pass^k（实线，全部成功）随 $k$ 快速下降，而 pass@k（虚线，至少一次成功）随 $k$ 上升——两条曲线的分裂正是"单次峰值"与"持续可靠"的鸿沟。

### 6.4 成本分析

gpt-4o FC agent + gpt-4 用户模拟在 τ-retail 上：agent / 用户每任务各 $0.38 / $0.23，跑一次全量约 **$200**。agent 侧成本 **95.9% 来自输入 prompt**（域策略 + 函数定义很长）、仅 4.1% 来自输出——成本瓶颈在长 system prompt 而非生成。

---

## 7. 消融实验

### 7.1 失败模式分解

![图5 gpt-4o FC agent 在 τ-retail 上 36 个失败轨迹的分解](/vibe-reading/images/articles/tau-bench-tool-agent-user-interaction/fig-5-failure-breakdown.png)

作者采样 115 条 gpt-4o FC 轨迹（每任务 1 次），40 个失败任务中 4 个归因于用户指令笔误/歧义（已修），剩 36 个为 agent 问题，分三类：

| 失败类型 | 占比 | 根因 |
|---|---|---|
| **参数/信息错误**（Wrong argument/info） | ~55%（33.3% + 22.2%） | 复杂数据库推理 |
| **决策错误**（Wrong decision） | 25.0% | 领域理解与规则遵循 |
| **部分解决**（Partially resolve） | 19.4% | 复合请求未完成 |

- **Failure 1 — 复杂数据库推理**：agent 调对了工具类型，但参数填错（如灯泡换货时在复杂库存里找不到唯一选项），或漏掉/算错用户所需信息（如总价、tracking ID）。弱模型更严重——gpt-3.5-turbo FC / Act 每任务分别 2.08 / 6.34 次调用不存在的 ID，gpt-4o 仅 0.46 次。
- **Failure 2 — 规则未遵循**：调错工具类型。如用户换"a couple of items"，策略要求换货工具只能调一次、必须先收集成 list——gpt-4o 却逐个换，第二个换不了。
- **Failure 3 — 复合请求部分解决**：含多个 write 动作的任务更难（Figure 6）。agent 常遗漏隐性动作，如用户要"修正所有订单的地址"，agent 查一个就停——指向长程记忆与系统性的不足。

![图6 数据库写操作越多，retail 任务越难](/vibe-reading/images/articles/tau-bench-tool-agent-user-interaction/fig-6-writes-difficulty.png)

### 7.2 域策略消融：规则越复杂，移除伤害越大

| 模型 | τ-retail | τ-airline |
|---|---|---|
| gpt-4o | 61.2 → 56.8（−4.4） | 33.2 → 10.8（−22.4） |
| gpt-3.5-turbo | 20.0 → 14.5（−5.5） | 10.8 → 9.6（−1.2） |

*Table 3：从 FC agent system prompt 移除域策略后 pass¹ 的退化。*

- **τ-retail**（规则简单、接近常识）：移除策略 gpt-4o 仅降 4.4%——说明其成功多靠常识直觉，并未真正用满策略文档。
- **τ-airline**（规则复杂、ad-hoc，行李额度随会员/舱位变化）：移除策略 gpt-4o 暴跌 22.4%——说明它有时确实在用规则；gpt-3.5-turbo 几乎不动（−1.2%）——说明它**没有能力处理复杂航空规则**，给不给策略都一样差。

> 这组消融的关键启示：**策略文档被利用的程度，取决于模型本身的复杂推理能力**。弱模型即使有规则也用不上——这是 agent 在真实部署中的硬约束，指向领域微调或代码脚手架的可能 remedy。

---

## 8. 总结与展望

### 贡献总结

τ-bench 用 SOTA LM 模拟真实用户、用数据库终态做客观评测、用 pass^k 量化一致性，把"工具调用 + 对话 + 规则遵循"统一进真实场景。核心结论：**当前基于 function calling 的 agent 缺乏足够一致性与规则遵循能力，远未达到可规模部署的可靠水平**——解决这两个问题对真实自动化影响巨大。

### 局限性（批判性）

- **用户模拟的局限**：① 用户指令可能有笔误/歧义（标注者可修）；② 用户可能不具备全部领域知识（如不知"换货只能调一次"，从而授权了次优方案——但这恰是真实用户写照）；③ 用户模拟 LM 自身推理/计算/长上下文记忆/对齐能力有限（如不核对 agent 推荐的灯泡参数就授权）。
- **标注偏差**：人工标注困难且需深谙域与 agent 能力；用 gpt-4-turbo FC agent 调用户 system prompt，引入**隐式偏差**（任务难度可能朝该模型偏移）。
- **唯一性保证的人工代价**：靠人工迭代确保"唯一正确终态"成本高，难以规模扩展到医疗/税务/法律等更复杂域。

### 未来方向（idea 三法）

1. **弥补缺陷**：给模拟器加系统性检查确保唯一终态；引入 LM-based 规则核查作为补充奖励（$r_{\text{output}}$ 之外加 $r_{\text{rule}}$）；用非 gpt-4-turbo 的多模型做标注去偏。
2. **新型方案**：探索 LM 辅助的自动数据生成与用户模拟新范式；把 pass^k 扩展为加权变体（如近期 trial 权重更高，刻画漂移）；增加 voice 评测模态（τ³-bench 已沿此推进，新增 banking 域与 voice）。
3. **减少约束**：放宽"唯一终态"假设，研究多正确解下的评测；构造更复杂的 ad-hoc 策略域；专门评测 agent 的 long-horizon 信息追踪与"在冲突事实中聚焦正确信息"的能力——这是当前 agent 的关键短板。

> 相关阅读：本文是 Vibe Reading 博客 Agent 系列的一篇。agent 一致性与规则遵循还与 [[memgpt-llms-as-operating-systems]]（长程记忆管理）、[[toolformer-language-models-use-tools]]（工具使用学习）、[[react-synergizing-reasoning-and-acting]]（推理-行动协同）密切相关——τ-bench 正是把这些能力放进"真实人机交互"试金石的评测工作。
