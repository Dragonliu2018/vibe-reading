---
title: "LLM Powered Autonomous Agents"
source:
  type: "article"
  project: "LilianWeng"
  url: "https://lilianweng.github.io/posts/2023-06-23-agent/"
  author: "Lilian Weng"
  site: "Lil'Log"
date: "2026-07-31T15:00:00+08:00"
category: [AI, Agent, Blogs]
tags: ["LLM Agents", "Planning", "Memory", "Tool Use", "ReAct", "Reflexion", "Prompt Engineering", "Lilian Weng"]
description: "Lilian Weng 系统梳理 LLM 自主 agent 架构：以 LLM 为大脑，配合规划（任务分解与自我反思）、记忆（短期/长期、向量检索 MIPS）、工具使用三大组件，并解析 ChemCrow、Generative Agents、AutoGPT、GPT-Engineer 等案例与当前挑战。"
readingTime: "31 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [LLM Powered Autonomous Agents](https://lilianweng.github.io/posts/2023-06-23-agent/) · **作者** Lilian Weng · **来源** Lil'Log · **原文发布** 2023-06-23 · **中英对照·AI 译** 2026-07-31
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

Building agents with LLM (large language model) as its core controller is a cool concept. Several proof-of-concepts demos, such as [AutoGPT](https://github.com/Significant-Gravitas/Auto-GPT), [GPT-Engineer](https://github.com/AntonOsika/gpt-engineer) and [BabyAGI](https://github.com/yoheinakajima/babyagi), serve as inspiring examples. The potentiality of LLM extends beyond generating well-written copies, stories, essays and programs; it can be framed as a powerful general problem solver.

> **译：** 以 LLM（large language model，大语言模型）作为核心控制器来构建 agent，是一个很酷的想法。已有若干概念验证 demo 给出了启发性示例，如 [AutoGPT](https://github.com/Significant-Gravitas/Auto-GPT)、[GPT-Engineer](https://github.com/AntonOsika/gpt-engineer) 和 [BabyAGI](https://github.com/yoheinakajima/babyagi)。LLM 的潜力远不止生成文笔优美的文案、故事、散文和程序——它可以被塑造成一个强大的通用问题求解器。

## Agent System Overview

In a LLM-powered autonomous agent system, LLM functions as the agent's brain, complemented by several key components:

- **Planning**
  - Subgoal and decomposition: The agent breaks down large tasks into smaller, manageable subgoals, enabling efficient handling of complex tasks.
  - Reflection and refinement: The agent can do self-criticism and self-reflection over past actions, learn from mistakes and refine them for future steps, thereby improving the quality of final results.
- **Memory**
  - Short-term memory: I would consider all the in-context learning (See [Prompt Engineering](https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/)) as utilizing short-term memory of the model to learn.
  - Long-term memory: This provides the agent with the capability to retain and recall (infinite) information over extended periods, often by leveraging an external vector store and fast retrieval.
- **Tool use**
  - The agent learns to call external APIs for extra information that is missing from the model weights (often hard to change after pre-training), including current information, code execution capability, access to proprietary information sources and more.

> **译：** 在 LLM 驱动的自主 agent 系统中，LLM 充当 agent 的大脑，并由若干关键组件辅助：
>
> - **规划（Planning）**
>   - 子目标与分解（Subgoal and decomposition）：agent 将大任务拆解为更小、可管理的子目标，从而高效处理复杂任务。
>   - 反思与修正（Reflection and refinement）：agent 能对过往行动进行自我批评与自我反思，从错误中学习并在后续步骤中修正，进而提升最终结果的质量。
> - **记忆（Memory）**
>   - 短期记忆（Short-term memory）：我会把所有的上下文学习（in-context learning，参见 [Prompt Engineering](https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/)）都视为利用模型的短期记忆来学习。
>   - 长期记忆（Long-term memory）：它赋予 agent 在长时间内保留并回忆（无限）信息的能力，通常借助外部向量存储与快速检索实现。
> - **工具使用（Tool use）**
>   - agent 学会调用外部 API，以获取模型权重中缺失（且预训练后往往难以更改）的额外信息，包括当前信息、代码执行能力、对专有信息源的访问等。

![Overview of a LLM-powered autonomous agent system.](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/agent-overview.png)

## Component One: Planning

A complicated task usually involves many steps. An agent needs to know what they are and plan ahead.

> **译：** 一项复杂任务通常涉及多个步骤。agent 需要知道这些步骤是什么，并提前规划。

### Task Decomposition

[Chain of thought](https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/#chain-of-thought-cot) (CoT; Wei et al. 2022) has become a standard prompting technique for enhancing model performance on complex tasks. The model is instructed to "think step by step" to utilize more test-time computation to decompose hard tasks into smaller and simpler steps. CoT transforms big tasks into multiple manageable tasks and shed lights into an interpretation of the model's thinking process.

> **译：** [思维链](https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/#chain-of-thought-cot)（Chain of thought，CoT；Wei et al. 2022）已成为增强模型在复杂任务上表现的标准 prompting 技术。模型被指示"一步步思考"（think step by step），以利用更多测试期计算把困难任务分解为更小、更简单的步骤。CoT 将大任务转化为多个可管理的任务，并为理解模型的思考过程提供了线索。

Tree of Thoughts (Yao et al. 2023) extends CoT by exploring multiple reasoning possibilities at each step. It first decomposes the problem into multiple thought steps and generates multiple thoughts per step, creating a tree structure. The search process can be BFS (breadth-first search) or DFS (depth-first search) with each state evaluated by a classifier (via a prompt) or majority vote.

> **译：** Tree of Thoughts（Yao et al. 2023）在每个步骤探索多种推理可能性，以此扩展 CoT。它先把问题分解为多个思考步骤，再为每一步生成多个"想法"（thought），形成树状结构。搜索过程可以是 BFS（广度优先）或 DFS（深度优先），每个状态由一个分类器（通过 prompt）或多数投票来评估。

Task decomposition can be done (1) by LLM with simple prompting like `"Steps for XYZ.\n1."`, `"What are the subgoals for achieving XYZ?"`, (2) by using task-specific instructions; e.g. `"Write a story outline."` for writing a novel, or (3) with human inputs.

> **译：** 任务分解可以通过以下方式完成：（1）用 LLM 配合简单 prompt，如 `"Steps for XYZ.\n1."`、`"What are the subgoals for achieving XYZ?"`；（2）使用任务专用指令，例如写小说时用 `"Write a story outline."`；或（3）借助人工输入。

Another quite distinct approach, LLM+P (Liu et al. 2023), involves relying on an external classical planner to do long-horizon planning. This approach utilizes the Planning Domain Definition Language (PDDL) as an intermediate interface to describe the planning problem. In this process, LLM (1) translates the problem into "Problem PDDL", then (2) requests a classical planner to generate a PDDL plan based on an existing "Domain PDDL", and finally (3) translates the PDDL plan back into natural language. Essentially, the planning step is outsourced to an external tool, assuming the availability of domain-specific PDDL and a suitable planner which is common in certain robotic setups but not in many other domains.

> **译：** 另一种截然不同的方法 LLM+P（Liu et al. 2023）则依赖外部的经典规划器（classical planner）来做长时程规划（long-horizon planning）。该方法以规划域定义语言（Planning Domain Definition Language，PDDL）作为中间接口来描述规划问题。过程中，LLM（1）把问题翻译成"Problem PDDL"，再（2）请求经典规划器基于已有的"Domain PDDL"生成一份 PDDL 规划，最后（3）把 PDDL 规划翻译回自然语言。本质上，规划步骤被外包给了外部工具，其前提是具备领域专用 PDDL 与合适的规划器——这在某些机器人设置中常见，但在许多其他领域并不可得。

### Self-Reflection

Self-reflection is a vital aspect that allows autonomous agents to improve iteratively by refining past action decisions and correcting previous mistakes. It plays a crucial role in real-world tasks where trial and error are inevitable.

> **译：** 自我反思（self-reflection）是让自主 agent 通过精炼过往行动决策、纠正先前错误来实现迭代改进的关键能力。在试错不可避免的真实任务中，它扮演着至关重要的角色。

ReAct (Yao et al. 2023) integrates reasoning and acting within LLM by extending the action space to be a combination of task-specific discrete actions and the language space. The former enables LLM to interact with the environment (e.g. use Wikipedia search API), while the latter prompting LLM to generate reasoning traces in natural language.

> **译：** ReAct（Yao et al. 2023）通过把动作空间扩展为"任务专用离散动作"与"语言空间"的组合，在 LLM 内部融合了推理（reasoning）与行动（acting）。前者使 LLM 能与环境交互（如调用 Wikipedia 搜索 API），后者则促使 LLM 用自然语言生成推理轨迹。

The ReAct prompt template incorporates explicit steps for LLM to think, roughly formatted as:

> **译：** ReAct 的 prompt 模板为 LLM 引入了显式的思考步骤，大致格式如下：

```text title="ReAct prompt template"
Thought: ...
Action: ...
Observation: ...
... (Repeated many times)
```

![Examples of reasoning trajectories for knowledge-intensive tasks (e.g. HotpotQA, FEVER) and decision-making tasks (e.g. AlfWorld Env, WebShop). (Image source: Yao et al. 2023).](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/react.png)

In both experiments on knowledge-intensive tasks and decision-making tasks, `ReAct` works better than the `Act`-only baseline where `Thought: …` step is removed.

> **译：** 在知识密集型任务与决策任务的实验中，`ReAct` 都优于去掉了 `Thought: …` 步骤的 `Act`-only 基线。

Reflexion (Shinn & Labash 2023) is a framework to equip agents with dynamic memory and self-reflection capabilities to improve reasoning skills. Reflexion has a standard RL setup, in which the reward model provides a simple binary reward and the action space follows the setup in ReAct where the task-specific action space is augmented with language to enable complex reasoning steps. After each action $a_t$, the agent computes a heuristic $h_t$ and optionally may decide to reset the environment to start a new trial depending on the self-reflection results.

> **译：** Reflexion（Shinn & Labash 2023）是一个为 agent 配备动态记忆与自我反思能力以提升推理技能的框架。Reflexion 采用标准 RL 设置：奖励模型提供简单的二元奖励，动作空间沿用 ReAct 的设置——任务专用动作空间被语言增强以支持复杂推理步骤。在每次动作 $a_t$ 之后，agent 计算一个启发式 $h_t$，并可能根据自我反思结果决定重置环境、开启新一轮试验。

![Illustration of the Reflexion framework. (Image source: Shinn & Labash, 2023)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/reflexion.png)

The heuristic function determines when the trajectory is inefficient or contains hallucination and should be stopped. Inefficient planning refers to trajectories that take too long without success. Hallucination is defined as encountering a sequence of consecutive identical actions that lead to the same observation in the environment.

> **译：** 该启发式函数判断轨迹何时变得低效或出现幻觉、应当终止。低效规划指耗时过长却未成功的轨迹。幻觉则被定义为遇到一连串相同的连续动作，却在环境中得到相同的观测结果。

Self-reflection is created by showing two-shot examples to LLM and each example is a pair of (failed trajectory, ideal reflection for guiding future changes in the plan). Then reflections are added into the agent's working memory, up to three, to be used as context for querying LLM.

> **译：** 自我反思通过向 LLM 展示 two-shot 示例来生成，每个示例是一对（失败的轨迹，用于指导后续计划修改的理想反思）。随后这些反思被加入 agent 的工作记忆（最多三条），作为查询 LLM 的上下文。

![Experiments on AlfWorld Env and HotpotQA. Hallucination is a more common failure than inefficient planning in AlfWorld. (Image source: Shinn & Labash, 2023)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/reflexion-exp.png)

Chain of Hindsight (CoH; Liu et al. 2023) encourages the model to improve on its own outputs by explicitly presenting it with a sequence of past outputs, each annotated with feedback. Human feedback data is a collection of $D_h = \{(x, y_i , r_i , z_i)\}_{i=1}^n$, where $x$ is the prompt, each $y_i$ is a model completion, $r_i$ is the human rating of $y_i$, and $z_i$ is the corresponding human-provided hindsight feedback. Assume the feedback tuples are ranked by reward, $r_n \geq r_{n-1} \geq \dots \geq r_1$ The process is supervised fine-tuning where the data is a sequence in the form of $\tau_h = (x, z_i, y_i, z_j, y_j, \dots, z_n, y_n)$, where $\leq i \leq j \leq n$. The model is finetuned to only predict $y_n$ where conditioned on the sequence prefix, such that the model can self-reflect to produce better output based on the feedback sequence. The model can optionally receive multiple rounds of instructions with human annotators at test time.

> **译：** Chain of Hindsight（CoH；Liu et al. 2023）通过显式地向模型呈现一串过往输出（每个都标注了反馈），鼓励模型改进自身的输出。人类反馈数据是一组 $D_h = \{(x, y_i , r_i , z_i)\}_{i=1}^n$，其中 $x$ 是 prompt，每个 $y_i$ 是一次模型补全，$r_i$ 是对 $y_i$ 的人类评分，$z_i$ 是相应由人提供的 hindsight 反馈。假设这些反馈元组按奖励排序，即 $r_n \geq r_{n-1} \geq \dots \geq r_1$。该过程是监督微调，数据是形如 $\tau_h = (x, z_i, y_i, z_j, y_j, \dots, z_n, y_n)$ 的序列，其中 $\leq i \leq j \leq n$。模型被微调为仅在给定该序列前缀的条件下预测 $y_n$，从而能基于反馈序列进行自我反思、产出更好的输出。在测试期，模型还可选择性地接受人工标注员多轮指令。

To avoid overfitting, CoH adds a regularization term to maximize the log-likelihood of the pre-training dataset. To avoid shortcutting and copying (because there are many common words in feedback sequences), they randomly mask 0% - 5% of past tokens during training.

> **译：** 为避免过拟合，CoH 增加了一个正则项以最大化预训练数据集的对数似然。为避免走捷径与复制（因为反馈序列中有大量常见词），训练时他们随机 mask 掉 0%–5% 的过往 token。

The training dataset in their experiments is a combination of [WebGPT comparisons](https://huggingface.co/datasets/openai/webgpt_comparisons), [summarization from human feedback](https://github.com/openai/summarize-from-feedback) and [human preference dataset](https://github.com/anthropics/hh-rlhf).

> **译：** 他们实验中的训练数据集是 [WebGPT comparisons](https://huggingface.co/datasets/openai/webgpt_comparisons)、[来自人类反馈的摘要](https://github.com/openai/summarize-from-feedback) 与 [人类偏好数据集](https://github.com/anthropics/hh-rlhf) 的组合。

![After fine-tuning with CoH, the model can follow instructions to produce outputs with incremental improvement in a sequence. (Image source: Liu et al. 2023)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/CoH.png)

The idea of CoH is to present a history of sequentially improved outputs  in context and train the model to take on the trend to produce better outputs. Algorithm Distillation (AD; Laskin et al. 2023) applies the same idea to cross-episode trajectories in reinforcement learning tasks, where an algorithm is encapsulated in a long history-conditioned policy. Considering that an agent interacts with the environment many times and in each episode the agent gets a little better, AD concatenates this learning history and feeds that into the model. Hence we should expect the next predicted action to lead to better performance than previous trials. The goal is to learn the process of RL instead of training a task-specific policy itself.

> **译：** CoH 的思路是把一段按序改进的输出历史呈现在上下文中，训练模型顺应这一趋势产出更好的输出。Algorithm Distillation（AD；Laskin et al. 2023）把同样的想法应用到强化学习任务的跨 episode 轨迹上——其中一个算法被封装在一条以长历史为条件的策略里。考虑到 agent 与环境多次交互，且在每个 episode 中都略微变好，AD 把这条学习历史拼接起来喂给模型。因此我们应期望下一个预测动作带来优于此前试验的表现。其目标是学习 RL 的过程本身，而非训练一个任务专用策略。

![Illustration of how Algorithm Distillation (AD) works. (Image source: Laskin et al. 2023).](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/algorithm-distillation.png)

The paper hypothesizes that any algorithm that generates a set of learning histories can be distilled into a neural network by performing behavioral cloning over actions. The history data is generated by a set of source policies, each trained for a specific task. At the training stage, during each RL run, a random task is sampled and a subsequence of multi-episode history is used for training, such that the learned policy is task-agnostic.

> **译：** 该论文假设：任何能生成一组学习历史的算法，都可以通过对动作进行行为克隆（behavioral cloning）蒸馏进一个神经网络。历史数据由一组源策略生成，每个源策略针对一个特定任务训练。在训练阶段，每次 RL 运行中随机采样一个任务，并使用一段多 episode 历史的子序列用于训练，使学到的策略与任务无关（task-agnostic）。

In reality, the model has limited context window length, so episodes should be short enough to construct multi-episode history. Multi-episodic contexts of 2-4 episodes are necessary to learn a near-optimal in-context RL algorithm. The emergence of in-context RL requires long enough context.

> **译：** 实际上，模型的上下文窗口长度有限，因此 episode 必须足够短以构造多 episode 历史。2–4 个 episode 的多 episode 上下文是学到近似最优的 in-context RL 算法所必需的。in-context RL 的涌现需要足够长的上下文。

In comparison with three baselines, including ED (expert distillation, behavior cloning with expert trajectories instead of learning history), source policy (used for generating trajectories for distillation by [UCB](https://lilianweng.github.io/posts/2018-01-23-multi-armed-bandit/#upper-confidence-bounds)), RL^2 (Duan et al. 2017; used as upper bound since it needs online RL), AD demonstrates in-context RL with performance getting close to RL^2 despite only using offline RL and learns much faster than other baselines. When conditioned on partial training history of the source policy, AD also improves much faster than ED baseline.

> **译：** 与三条基线对比——包括 ED（expert distillation，用专家轨迹而非学习历史做行为克隆）、源策略（用于生成蒸馏轨迹的 [UCB](https://lilianweng.github.io/posts/2018-01-23-multi-armed-bandit/#upper-confidence-bounds)）、RL^2（Duan et al. 2017；因需要在线 RL 而用作上界）——AD 展示了 in-context RL 能力：尽管仅用离线 RL，性能却接近 RL^2，且比其他基线学得快得多。当以源策略的部分训练历史为条件时，AD 也比 ED 基线提升快得多。

![Comparison of AD, ED, source policy and RL^2 on environments that require memory and exploration. Only binary reward is assigned. The source policies are trained with A3C for "dark" environments and DQN for watermaze.(Image source: Laskin et al. 2023)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/algorithm-distillation-results.png)

## Component Two: Memory

(Big thank you to ChatGPT for helping me draft this section. I've learned a lot about the human brain and data structure for fast MIPS in my [conversations](https://chat.openai.com/share/46ff149e-a4c7-4dd7-a800-fc4a642ea389) with ChatGPT.)

> **译：** （特别感谢 ChatGPT 帮我起草本节。在与 ChatGPT 的[对话](https://chat.openai.com/share/46ff149e-a4c7-4dd7-a800-fc4a642ea389)中，我学到了很多关于人脑与快速 MIPS 数据结构的知识。）

### Types of Memory

Memory can be defined as the processes used to acquire, store, retain, and later retrieve information. There are several types of memory in human brains.

> **译：** 记忆可定义为我们用来获取、存储、保留并随后检索信息的过程。人脑中有若干种记忆类型。

- **Sensory Memory**: This is the earliest stage of memory, providing the ability to retain impressions of sensory information (visual, auditory, etc) after the original stimuli have ended. Sensory memory typically only lasts for up to a few seconds. Subcategories include iconic memory (visual), echoic memory (auditory), and haptic memory (touch).
- **Short-Term Memory (STM) or Working Memory**: It stores information that we are currently aware of and needed to carry out complex cognitive tasks such as learning and reasoning. Short-term memory is believed to have the capacity of about 7 items (Miller 1956) and lasts for 20-30 seconds.
- **Long-Term Memory (LTM)**: Long-term memory can store information for a remarkably long time, ranging from a few days to decades, with an essentially unlimited storage capacity. There are two subtypes of LTM:
  - Explicit / declarative memory: This is memory of facts and events, and refers to those memories that can be consciously recalled, including episodic memory (events and experiences) and semantic memory (facts and concepts).
  - Implicit / procedural memory: This type of memory is unconscious and involves skills and routines that are performed automatically, like riding a bike or typing on a keyboard.

> **译：**
>
> - **感觉记忆（Sensory Memory）**：这是记忆的最早阶段，提供在原始刺激结束后保留感官信息印象（视觉、听觉等）的能力。感觉记忆通常只持续几秒。子类包括 iconic memory（视觉）、echoic memory（听觉）和 haptic memory（触觉）。
> - **短期记忆（Short-Term Memory, STM）/ 工作记忆（Working Memory）**：存储我们当前意识到、且为执行学习与推理等复杂认知任务所需的信息。短期记忆据信容量约为 7 项（Miller 1956），持续 20–30 秒。
> - **长期记忆（Long-Term Memory, LTM）**：长期记忆能存储信息相当长时间，从几天到数十年不等，存储容量几乎无限。LTM 有两个子类型：
>   - 外显/陈述性记忆（Explicit / declarative memory）：关于事实与事件的记忆，指那些能有意识回忆的记忆，包括 episodic memory（事件与经历）和 semantic memory（事实与概念）。
>   - 内隐/程序性记忆（Implicit / procedural memory）：这种记忆是无意识的，涉及自动执行的技能与例行操作，如骑自行车或在键盘上打字。

![Categorization of human memory.](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/memory.png)

We can roughly consider the following mappings:

- Sensory memory as learning embedding representations for raw inputs, including text, image or other modalities;
- Short-term memory as in-context learning. It is short and finite, as it is restricted by the finite context window length of Transformer.
- Long-term memory as the external vector store that the agent can attend to at query time, accessible via fast retrieval.

> **译：** 我们可以粗略地考虑如下映射关系：
>
> - 感觉记忆 → 为原始输入（包括文本、图像或其他模态）学习 embedding 表示；
> - 短期记忆 → 上下文学习（in-context learning）。它短促且有限，受限于 Transformer 有限的上下文窗口长度。
> - 长期记忆 → 外部向量存储，agent 在查询时可对其做注意力访问，并能通过快速检索获取。

### Maximum Inner Product Search (MIPS)

The external memory can alleviate the restriction of finite attention span.  A standard practice is to save the embedding representation of information into a vector store database that can support fast maximum inner-product search ([MIPS](https://en.wikipedia.org/wiki/Maximum_inner-product_search)). To optimize the retrieval speed, the common choice is the approximate nearest neighbors (ANN)​ algorithm to return approximately top k nearest neighbors to trade off a little accuracy lost for a huge speedup.

> **译：** 外部记忆可以缓解注意力跨度有限的限制。一种标准做法是把信息的 embedding 表示存入支持快速最大内积搜索（[MIPS](https://en.wikipedia.org/wiki/Maximum_inner-product_search)）的向量存储数据库。为优化检索速度，常见选择是近似最近邻（approximate nearest neighbors，ANN）算法——返回近似 top-k 最近邻，以少许精度损失换取大幅加速。

A couple common choices of ANN algorithms for fast MIPS:

> **译：** 用于快速 MIPS 的几种常见 ANN 算法：

- [LSH](https://en.wikipedia.org/wiki/Locality-sensitive_hashing) (Locality-Sensitive Hashing): It introduces a hashing function such that similar input items are mapped to the same buckets with high probability, where the number of buckets is much smaller than the number of inputs.
- [ANNOY](https://github.com/spotify/annoy) (Approximate Nearest Neighbors Oh Yeah): The core data structure are random projection trees, a set of binary trees where each non-leaf node represents a hyperplane splitting the input space into half and each leaf stores one data point. Trees are built independently and at random, so to some extent, it mimics a hashing function. ANNOY search happens in all the trees to iteratively search through the half that is closest to the query and then aggregates the results. The idea is quite related to KD tree but a lot more scalable.
- [HNSW](https://arxiv.org/abs/1603.09320) (Hierarchical Navigable Small World): It is inspired by the idea of [small world networks](https://en.wikipedia.org/wiki/Small-world_network) where most nodes can be reached by any other nodes within a small number of steps; e.g. "six degrees of separation" feature of social networks. HNSW builds hierarchical layers of these small-world graphs, where the bottom layers contain the actual data points. The layers in the middle create shortcuts to speed up search. When performing a search, HNSW starts from a random node in the top layer and navigates towards the target. When it can't get any closer, it moves down to the next layer, until it reaches the bottom layer. Each move in the upper layers can potentially cover a large distance in the data space, and each move in the lower layers refines the search quality.
- [FAISS](https://github.com/facebookresearch/faiss) (Facebook AI Similarity Search): It operates on the assumption that in high dimensional space, distances between nodes follow a Gaussian distribution and thus there should exist clustering of data points. FAISS applies vector quantization by partitioning the vector space into clusters and then refining the quantization within clusters. Search first looks for cluster candidates with coarse quantization and then further looks into each cluster with finer quantization.
- [ScaNN](https://github.com/google-research/google-research/tree/master/scann) (Scalable Nearest Neighbors): The main innovation in ScaNN is anisotropic vector quantization. It quantizes a data point $x_i$ to $\tilde{x}_i$ such that the inner product $\langle q, x_i \rangle$ is as similar to the original distance of the $\angle q, \tilde{x}_i$ as possible, instead of picking the closet quantization centroid points.

> **译：**
>
> - [LSH](https://en.wikipedia.org/wiki/Locality-sensitive_hashing)（Locality-Sensitive Hashing，局部敏感哈希）：引入一个哈希函数，使相似的输入项以高概率被映射到同一桶中，其中桶的数量远小于输入数量。
> - [ANNOY](https://github.com/spotify/annoy)（Approximate Nearest Neighbors Oh Yeah）：核心数据结构是随机投影树——一组二叉树，每个非叶节点代表一个把输入空间一分为二的超平面，每个叶节点存储一个数据点。树独立且随机地构建，故在某种程度上模拟了哈希函数。ANNOY 搜索在所有树中进行，迭代地搜索离查询最近的半空间并聚合结果。其思路与 KD 树颇为相关，但可扩展性强得多。
> - [HNSW](https://arxiv.org/abs/1603.09320)（Hierarchical Navigable Small World）：受[小世界网络](https://en.wikipedia.org/wiki/Small-world_network)思想启发——大多数节点都能在少量步数内被任何其他节点到达，例如社交网络的"六度分隔"特征。HNSW 构建这些小世界图的分层结构，底层包含实际数据点，中间层创建捷径以加速搜索。搜索时，HNSW 从顶层一个随机节点出发向目标导航；当无法再靠近时，就下移到下一层，直到抵达底层。上层的每一步都可能覆盖数据空间中的较大距离，下层的每一步则细化搜索质量。
> - [FAISS](https://github.com/facebookresearch/faiss)（Facebook AI Similarity Search）：其运行假设是：在高维空间中节点间距离服从高斯分布，因此数据点应存在聚类。FAISS 通过把向量空间划分为簇、再在簇内细化量化来应用向量量化。搜索先用粗量化寻找候选簇，再用更精细的量化深入每个簇。
> - [ScaNN](https://github.com/google-research/google-research/tree/master/scann)（Scalable Nearest Neighbors）：ScaNN 的主要创新是各向异性向量量化（anisotropic vector quantization）。它把数据点 $x_i$ 量化为 $\tilde{x}_i$，使得内积 $\langle q, x_i \rangle$ 与原始距离 $\angle q, \tilde{x}_i$ 尽可能相似，而不是选取最近的量化质心点。[^err-closet]

[^err-closet]: 原文如此（"closet"），疑为 "closest"（最近）。

![Comparison of MIPS algorithms, measured in recall@10. (Image source: Google Blog, 2020)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/mips.png)

Check more MIPS algorithms and performance comparison in [ann-benchmarks.com](https://ann-benchmarks.com/).

> **译：** 在 [ann-benchmarks.com](https://ann-benchmarks.com/) 可查看更多 MIPS 算法及性能比较。

## Component Three: Tool Use

Tool use is a remarkable and distinguishing characteristic of human beings. We create, modify and utilize external objects to do things that go beyond our physical and cognitive limits. Equipping LLMs with external tools can significantly extend the model capabilities.

> **译：** 工具使用是人类一项显著且独特的特征。我们创造、修改并利用外部物体，去做超越自身体能与认知极限的事。为 LLM 配备外部工具可显著扩展模型能力。

![A picture of a sea otter using rock to crack open a seashell, while floating in the water. While some other animals can use tools, the complexity is not comparable with humans. (Image source: Animals using tools)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/sea-otter.png)

MRKL (Karpas et al. 2022), short for "Modular Reasoning, Knowledge and Language", is a neuro-symbolic architecture for autonomous agents. A MRKL system is proposed to contain a collection of "expert" modules and the general-purpose LLM works as a router to route inquiries to the best suitable expert module. These modules can be neural (e.g. deep learning models) or symbolic (e.g. math calculator, currency converter, weather API).

> **译：** MRKL（Karpas et al. 2022）是"Modular Reasoning, Knowledge and Language"的缩写，一种用于自主 agent 的神经-符号（neuro-symbolic）架构。MRKL 系统被提议包含一组"专家"模块，通用 LLM 充当路由器，把查询路由到最合适的专家模块。这些模块可以是神经的（如深度学习模型），也可以是符号的（如数学计算器、货币换算器、天气 API）。

They did an experiment on fine-tuning LLM to call a calculator, using arithmetic as a test case. Their experiments showed that it was harder to solve verbal math problems than explicitly stated math problems because LLMs (7B Jurassic1-large model) failed to extract the right arguments for the basic arithmetic reliably. The results highlight when the external symbolic tools can work reliably, knowing when to and how to use the tools are crucial, determined by the LLM capability.

> **译：** 他们做了一个微调 LLM 调用计算器的实验，以算术为测试用例。实验表明，文字数学题比显式陈述的数学题更难求解，因为 LLM（7B Jurassic1-large 模型）无法可靠地为基本算术提取正确参数。结果凸显：当外部符号工具能可靠工作时，知道何时以及如何使用工具至关重要——这由 LLM 能力决定。

Both TALM (Tool Augmented Language Models; Parisi et al. 2022) and Toolformer (Schick et al. 2023) fine-tune a LM to learn to use external tool APIs. The dataset is expanded based on whether a newly added API call annotation can improve the quality of model outputs. See more details in the ["External APIs" section](https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/#external-apis) of Prompt Engineering.

> **译：** TALM（Tool Augmented Language Models；Parisi et al. 2022）与 Toolformer（Schick et al. 2023）都通过微调让 LM 学会使用外部工具 API。数据集依据"新加入的 API 调用标注是否能提升模型输出质量"来扩展。更多细节见 Prompt Engineering 的["External APIs" 一节](https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/#external-apis)。

[ChatGPT Plugins](https://openai.com/blog/chatgpt-plugins) and [OpenAI API  function calling](https://platform.openai.com/docs/guides/gpt/function-calling) are good examples of LLMs augmented with tool use capability working in practice. The collection of tool APIs can be provided by other developers (as in Plugins) or self-defined (as in function calls).

> **译：** [ChatGPT Plugins](https://openai.com/blog/chatgpt-plugins) 与 [OpenAI API function calling](https://platform.openai.com/docs/guides/gpt/function-calling) 是 LLM 增强工具使用能力并实际运作的好例子。工具 API 集合可由其他开发者提供（如 Plugins），也可自定义（如 function calls）。

HuggingGPT (Shen et al. 2023) is a framework to use ChatGPT as the task planner to select models available in HuggingFace platform according to the model descriptions and summarize the response based on the execution results.

> **译：** HuggingGPT（Shen et al. 2023）是一个用 ChatGPT 作为任务规划器、根据模型描述选择 HuggingFace 平台上的可用模型、并基于执行结果汇总响应的框架。

![Illustration of how HuggingGPT works. (Image source: Shen et al. 2023)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/hugging-gpt.png)

The system comprises of 4 stages:

> **译：** 该系统包含 4 个阶段：

(1) Task planning: LLM works as the brain and parses the user requests into multiple tasks. There are four attributes associated with each task: task type, ID, dependencies, and arguments. They use few-shot examples to guide LLM to do task parsing and planning.

> **译：** （1）任务规划（Task planning）：LLM 充当大脑，把用户请求解析为多个任务。每个任务关联四个属性：任务类型、ID、依赖项和参数。他们用 few-shot 示例引导 LLM 完成任务解析与规划。

Instruction:

```text title="HuggingGPT — Task planning instruction"
The AI assistant can parse user input to several tasks: [{"task": task, "id", task_id, "dep": dependency_task_ids, "args": {"text": text, "image": URL, "audio": URL, "video": URL}}]. The "dep" field denotes the id of the previous task which generates a new resource that the current task relies on. A special tag "-task_id" refers to the generated text image, audio and video in the dependency task with id as task_id. The task MUST be selected from the following options: {{ Available Task List }}. There is a logical relationship between tasks, please note their order. If the user input can't be parsed, you need to reply empty JSON. Here are several cases for your reference: {{ Demonstrations }}. The chat history is recorded as {{ Chat History }}. From this chat history, you can find the path of the user-mentioned resources for your task planning.
```

(2) Model selection: LLM distributes the tasks to expert models, where the request is framed as a multiple-choice question. LLM is presented with a list of models to choose from. Due to the limited context length, task type based filtration is needed.

> **译：** （2）模型选择（Model selection）：LLM 把任务分发给专家模型，请求被构造成一道多选题。LLM 面前有一列模型可供选择。由于上下文长度有限，需要按任务类型做过滤。

Instruction:

```text title="HuggingGPT — Model selection instruction"
Given the user request and the call command, the AI assistant helps the user to select a suitable model from a list of models to process the user request. The AI assistant merely outputs the model id of the most appropriate model. The output must be in a strict JSON format: "id": "id", "reason": "your detail reason for the choice". We have a list of models for you to choose from {{ Candidate Models }}. Please select one model from the list.
```

(3) Task execution: Expert models execute on the specific tasks and log results.

> **译：** （3）任务执行（Task execution）：专家模型在具体任务上执行并记录结果。

Instruction:

```text title="HuggingGPT — Task execution instruction"
With the input and the inference results, the AI assistant needs to describe the process and results. The previous stages can be formed as - User Input: {{ User Input }}, Task Planning: {{ Tasks }}, Model Selection: {{ Model Assignment }}, Task Execution: {{ Predictions }}. You must first answer the user's request in a straightforward manner. Then describe the task process and show your analysis and model inference results to the user in the first person. If inference results contain a file path, must tell the user the complete file path.
```

(4) Response generation: LLM receives the execution results and provides summarized results to users.

> **译：** （4）响应生成（Response generation）：LLM 接收执行结果并向用户提供汇总结果。

To put HuggingGPT into real world usage, a couple challenges need to solve: (1) Efficiency improvement is needed as both LLM inference rounds and interactions with other models slow down the process; (2) It relies on a long context window to communicate over complicated task content; (3) Stability improvement of LLM outputs and external model services.

> **译：** 要把 HuggingGPT 落到实际使用，需解决若干挑战：（1）需提升效率，因为 LLM 推理轮次以及与其他模型的交互都会拖慢流程；（2）依赖长上下文窗口来沟通复杂的任务内容；（3）需提升 LLM 输出与外部模型服务的稳定性。

[API-Bank](https://arxiv.org/abs/2304.08244) (Li et al. 2023) is a benchmark for evaluating the performance of tool-augmented LLMs. It contains 53 commonly used API tools, a complete tool-augmented LLM workflow, and 264 annotated dialogues that involve 568 API calls. The selection of APIs is quite diverse, including search engines, calculator, calendar queries, smart home control, schedule management, health data management, account authentication workflow and more. Because there are a large number of APIs, LLM first has access to API search engine to find the right API to call and then uses the corresponding documentation to make a call.

> **译：** [API-Bank](https://arxiv.org/abs/2304.08244)（Li et al. 2023）是一个评估工具增强 LLM 性能的基准。它包含 53 个常用 API 工具、一套完整的工具增强 LLM 工作流，以及 264 段涉及 568 次 API 调用的标注对话。API 的选择相当多样，包括搜索引擎、计算器、日历查询、智能家居控制、日程管理、健康数据管理、账号认证流程等。由于 API 数量众多，LLM 先要访问 API 搜索引擎找到正确的 API，再用相应文档发起调用。

![Pseudo code of how LLM makes an API call in API-Bank. (Image source: Li et al. 2023)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/api-bank-process.png)

In the API-Bank workflow, LLMs need to make a couple of decisions and at each step we can evaluate how accurate that decision is. Decisions include:

> **译：** 在 API-Bank 工作流中，LLM 需要做出若干决策，每一步我们都能评估该决策的准确性。决策包括：

- Whether an API call is needed.
- Identify the right API to call: if not good enough, LLMs need to iteratively modify the API inputs (e.g. deciding search keywords for Search Engine API).
- Response based on the API results: the model can choose to refine and call again if results are not satisfied.

> **译：**
>
> - 是否需要发起一次 API 调用。
> - 识别要调用的正确 API：若不够好，LLM 需迭代修改 API 输入（例如为搜索引擎 API 决定搜索关键词）。
> - 基于 API 结果作出响应：若结果不令人满意，模型可选择精炼后再次调用。

This benchmark evaluates the agent's tool use capabilities at three levels:

> **译：** 该基准在三个层级评估 agent 的工具使用能力：

- Level-1 evaluates the ability to call the API. Given an API's description, the model needs to determine whether to call a given API, call it correctly, and respond properly to API returns.
- Level-2 examines the ability to retrieve the API. The model needs to search for possible APIs that may solve the user's requirement and learn how to use them by reading documentation.
- Level-3 assesses the ability to plan API beyond retrieve and call. Given unclear user requests (e.g. schedule group meetings, book flight/hotel/restaurant for a trip), the model may have to conduct multiple API calls to solve it.

> **译：**
>
> - Level-1 评估调用 API 的能力。给定某 API 的描述，模型需判断是否调用该 API、正确调用，并妥善响应 API 返回。
> - Level-2 考察检索 API 的能力。模型需搜索可能满足用户需求的 API，并通过阅读文档学会使用。
> - Level-3 评估超越"检索与调用"的 API 规划能力。给定模糊的用户请求（如安排小组会议、为一次旅行预订机票/酒店/餐厅），模型可能不得不执行多次 API 调用来解决。

## Case Studies

### Scientific Discovery Agent

[ChemCrow](https://arxiv.org/abs/2304.05376) (Bran et al. 2023) is a domain-specific example in which LLM is augmented with 13 expert-designed tools to accomplish tasks across organic synthesis, drug discovery, and materials design. The workflow, implemented in [LangChain](https://github.com/hwchase17/langchain), reflects what was previously described in the ReAct and MRKLs and combines CoT reasoning with tools relevant to the tasks:

> **译：** [ChemCrow](https://arxiv.org/abs/2304.05376)（Bran et al. 2023）是一个领域专用示例：LLM 被增强以 13 个专家设计的工具，以完成有机合成、药物发现与材料设计等任务。该工作流用 [LangChain](https://github.com/hwchase17/langchain) 实现，呼应了前文 ReAct 与 MRKLs 所述，并将 CoT 推理与任务相关的工具结合：

- The LLM is provided with a list of tool names, descriptions of their utility, and details about the expected input/output.
- It is then instructed to answer a user-given prompt using the tools provided when necessary. The instruction suggests the model to follow the ReAct format - `Thought, Action, Action Input, Observation`.

> **译：**
>
> - 向 LLM 提供工具名称列表、用途描述，以及预期输入/输出的细节。
> - 随后指示它在必要时使用所提供的工具来回答用户给定的 prompt。该指示建议模型遵循 ReAct 格式——`Thought, Action, Action Input, Observation`。

One interesting observation is that while the LLM-based evaluation concluded that GPT-4 and ChemCrow perform nearly equivalently, human evaluations with experts oriented towards the completion and chemical correctness of the solutions showed that ChemCrow outperforms GPT-4 by a large margin. This indicates a potential problem with using LLM to evaluate its own performance on domains that requires deep expertise. The lack of expertise may cause LLMs not knowing its flaws and thus cannot well judge the correctness of task results.

> **译：** 一个有趣的观察是：虽然基于 LLM 的评估认为 GPT-4 与 ChemCrow 表现几乎相当，但由专家（面向解决方案的完整性与化学正确性）进行的人工评估表明 ChemCrow 大幅优于 GPT-4。这揭示了一个潜在问题——在需要深专长的领域用 LLM 评估自身表现。专长的缺失可能使 LLM 不自知其缺陷，从而无法很好判断任务结果的正确性。

[Boiko et al. (2023)](https://arxiv.org/abs/2304.05332) also looked into LLM-empowered agents for scientific discovery, to handle autonomous design, planning, and performance of complex scientific experiments. This agent can use tools to browse the Internet, read documentation, execute code, call robotics experimentation APIs and leverage other LLMs.

> **译：** [Boiko et al. (2023)](https://arxiv.org/abs/2304.05332) 也研究了用于科学发现的 LLM 赋能 agent，以处理复杂科学实验的自主设计、规划与执行。该 agent 能用工具浏览互联网、阅读文档、执行代码、调用机器人实验 API，并利用其他 LLM。

For example, when requested to `"develop a novel anticancer drug"`, the model came up with the following reasoning steps:

> **译：** 例如，当被要求 `"develop a novel anticancer drug"`（研发一种新型抗癌药物）时，模型给出了如下推理步骤：

- inquired about current trends in anticancer drug discovery;
- selected a target;
- requested a scaffold targeting these compounds;
- Once the compound was identified, the model attempted its synthesis.

> **译：**
>
> - 询问当前抗癌药物发现的趋势；
> - 选择一个靶点；
> - 请求针对这些化合物的骨架（scaffold）；
> - 一旦确定了化合物，模型便尝试其合成。

They also discussed the risks, especially with illicit drugs and bioweapons. They developed a test set containing a list of known chemical weapon agents and asked the agent to synthesize them. 4 out of 11 requests (36%) were accepted to obtain a synthesis solution and the agent attempted to consult documentation to execute the procedure. 7 out of 11 were rejected and among these 7 rejected cases, 5 happened after a Web search while 2 were rejected based on prompt only.

> **译：** 他们还讨论了风险，尤其是非法药物与生物武器方面。他们构建了一个包含已知化学武器制剂清单的测试集，并要求 agent 合成它们。11 次请求中有 4 次（36%）被接受并获得合成方案，agent 还尝试查阅文档来执行流程。11 次中有 7 次被拒绝；在这 7 次拒绝中，5 次发生在 Web 搜索之后，2 次仅基于 prompt 即被拒绝。

### Generative Agents Simulation

[Generative Agents](https://arxiv.org/abs/2304.03442) (Park, et al. 2023) is super fun experiment where 25 virtual characters, each controlled by a LLM-powered agent, are living and interacting in a sandbox environment, inspired by The Sims. Generative agents create believable simulacra of human behavior for interactive applications.

> **译：** [Generative Agents](https://arxiv.org/abs/2304.03442)（Park, et al. 2023）是一个超级有趣的实验：25 个虚拟角色，每个由一个 LLM 驱动的 agent 控制，在一个受《模拟人生》（The Sims）启发的沙盒环境中生活并互动。生成式 agent 为交互式应用创造了令人信服的人类行为模拟物。

The design of generative agents combines LLM with memory, planning and reflection mechanisms to enable agents to behave conditioned on past experience, as well as to interact with other agents.

> **译：** 生成式 agent 的设计把 LLM 与记忆、规划和反思机制相结合，使 agent 能以过往经验为条件行动，并能与其他 agent 交互。

- **Memory stream**: is a long-term memory module (external database) that records a comprehensive list of agents' experience in natural language.
  - Each element is an observation, an event directly provided by the agent.
  - Inter-agent communication can trigger new natural language statements.
- **Retrieval model**: surfaces the context to inform the agent's behavior, according to relevance, recency and importance.
  - Recency: recent events have higher scores
  - Importance: distinguish mundane from core memories. Ask LM directly.
  - Relevance: based on how related it is to the current situation / query.
- **Reflection mechanism**: synthesizes memories into higher level inferences over time and guides the agent's future behavior. They are higher-level summaries of past events (<- note that this is a bit different from self-reflection above)
  - Prompt LM with 100 most recent observations and to generate 3 most salient high-level questions given a set of observations/statements. Then ask LM to answer those questions.
- **Planning & Reacting**: translate the reflections and the environment information into actions
  - Planning is essentially in order to optimize believability at the moment vs in time.
  - Prompt template: `{Intro of an agent X}. Here is X's plan today in broad strokes: 1)`
  - Relationships between agents and observations of one agent by another are all taken into consideration for planning and reacting.
  - Environment information is present in a tree structure.

> **译：**
>
> - **记忆流（Memory stream）**：一个长期记忆模块（外部数据库），以自然语言记录 agent 经历的完整清单。
>   - 每个元素是一个观测（observation），即由 agent 直接提供的事件。
>   - agent 之间的通信可触发新的自然语言陈述。
> - **检索模型（Retrieval model）**：根据相关性（relevance）、近期性（recency）与重要性（importance），调出上下文以指导 agent 行为。
>   - 近期性：越近的事件得分越高。
>   - 重要性：区分琐碎与核心记忆。直接询问 LM。
>   - 相关性：基于与当前情形/查询的关联程度。
> - **反思机制（Reflection mechanism）**：随时间将记忆综合为更高层次的推断，并指导 agent 的后续行为。它们是对过往事件更高层次的摘要（<- 注意这与前文的 self-reflection 略有不同）。
>   - 用 100 条最近的观测 prompt LM，给定一组观测/陈述，生成 3 个最显著的高层次问题。再请 LM 回答这些问题。
> - **规划与反应（Planning & Reacting）**：把反思与环境信息转化为行动。
>   - 规划本质上是为了在"当下"与"按时"之间优化可信度（believability）。
>   - prompt 模板：`{Intro of an agent X}. Here is X's plan today in broad strokes: 1)`
>   - agent 之间的关系以及一个 agent 对另一个 agent 的观测，都会纳入规划与反应的考量。
>   - 环境信息以树状结构呈现。

![The generative agent architecture. (Image source: Park et al. 2023)](/vibe-reading/images/articles/lilianweng-informal-llm-powered-autonomous-agents/generative-agents.png)

This fun simulation results in emergent social behavior, such as information diffusion, relationship memory (e.g. two agents continuing the conversation topic) and coordination of social events (e.g. host a party and invite many others).

> **译：** 这个有趣的模拟产生了涌现的社会行为，例如信息扩散、关系记忆（如两个 agent 延续对话话题）以及社会事件的协调（如举办一场聚会并邀请许多其他人）。

### Proof-of-Concept Examples

[AutoGPT](https://github.com/Significant-Gravitas/Auto-GPT) has drawn a lot of attention into the possibility of setting up autonomous agents with LLM as the main controller. It has quite a lot of reliability issues given the natural language interface, but nevertheless a cool proof-of-concept demo. A lot of code in AutoGPT is about format parsing.

> **译：** [AutoGPT](https://github.com/Significant-Gravitas/Auto-GPT) 让"以 LLM 作为主控制器搭建自主 agent"的可能性备受关注。鉴于自然语言接口，它有相当多的可靠性问题，但仍是一个很酷的概念验证 demo。AutoGPT 中大量代码都在做格式解析。

Here is the system message used by AutoGPT, where `{{...}}` are user inputs:

> **译：** 以下是 AutoGPT 使用的 system message，其中 `{{...}}` 为用户输入：

```text title="AutoGPT system message"
You are {{ai-name}}, {{user-provided AI bot description}}.
Your decisions must always be made independently without seeking user assistance. Play to your strengths as an LLM and pursue simple strategies with no legal complications.

GOALS:

1. {{user-provided goal 1}}
2. {{user-provided goal 2}}
3. ...
4. ...
5. ...

Constraints:
1. ~4000 word limit for short term memory. Your short term memory is short, so immediately save important information to files.
2. If you are unsure how you previously did something or want to recall past events, thinking about similar events will help you remember.
3. No user assistance
4. Exclusively use the commands listed in double quotes e.g. "command name"
5. Use subprocesses for commands that will not terminate within a few minutes

Commands:
1. Google Search: "google", args: "input": "<search>"
2. Browse Website: "browse_website", args: "url": "<url>", "question": "<what_you_want_to_find_on_website>"
3. Start GPT Agent: "start_agent", args: "name": "<name>", "task": "<short_task_desc>", "prompt": "<prompt>"
4. Message GPT Agent: "message_agent", args: "key": "<key>", "message": "<message>"
5. List GPT Agents: "list_agents", args:
6. Delete GPT Agent: "delete_agent", args: "key": "<key>"
7. Clone Repository: "clone_repository", args: "repository_url": "<url>", "clone_path": "<directory>"
8. Write to file: "write_to_file", args: "file": "<file>", "text": "<text>"
9. Read file: "read_file", args: "file": "<file>"
10. Append to file: "append_to_file", args: "file": "<file>", "text": "<text>"
11. Delete file: "delete_file", args: "file": "<file>"
12. Search Files: "search_files", args: "directory": "<directory>"
13. Analyze Code: "analyze_code", args: "code": "<full_code_string>"
14. Get Improved Code: "improve_code", args: "suggestions": "<list_of_suggestions>", "code": "<full_code_string>"
15. Write Tests: "write_tests", args: "code": "<full_code_string>", "focus": "<list_of_focus_areas>"
16. Execute Python File: "execute_python_file", args: "file": "<file>"
17. Generate Image: "generate_image", args: "prompt": "<prompt>"
18. Send Tweet: "send_tweet", args: "text": "<text>"
19. Do Nothing: "do_nothing", args:
20. Task Complete (Shutdown): "task_complete", args: "reason": "<reason>"

Resources:
1. Internet access for searches and information gathering.
2. Long Term memory management.
3. GPT-3.5 powered Agents for delegation of simple tasks.
4. File output.

Performance Evaluation:
1. Continuously review and analyze your actions to ensure you are performing to the best of your abilities.
2. Constructively self-criticize your big-picture behavior constantly.
3. Reflect on past decisions and strategies to refine your approach.
4. Every command has a cost, so be smart and efficient. Aim to complete tasks in the least number of steps.

You should only respond in JSON format as described below
Response Format:
{
    "thoughts": {
        "text": "thought",
        "reasoning": "reasoning",
        "plan": "- short bulleted\n- list that conveys\n- long-term plan",
        "criticism": "constructive self-criticism",
        "speak": "thoughts summary to say to user"
    },
    "command": {
        "name": "command name",
        "args": {
            "arg name": "value"
        }
    }
}
Ensure the response can be parsed by Python json.loads
```

[GPT-Engineer](https://github.com/AntonOsika/gpt-engineer) is another project to create a whole repository of code given a task specified in natural language. The GPT-Engineer is instructed to think over a list of smaller components to build and ask for user input to clarify questions as needed.

> **译：** [GPT-Engineer](https://github.com/AntonOsika/gpt-engineer) 是另一个项目：给定一段自然语言描述的任务，创建一整个代码仓库。GPT-Engineer 被指示先思考一系列要构建的小组件，并按需向用户请求输入以澄清问题。

Here are a sample conversation for task clarification sent to OpenAI ChatCompletion endpoint used by GPT-Engineer. The user inputs are wrapped in `{{user input text}}`.

> **译：** 以下是 GPT-Engineer 发往 OpenAI ChatCompletion 端点的任务澄清示例对话。用户输入用 `{{user input text}}` 包裹。

```json title="GPT-Engineer task clarification conversation"
[
  {
    "role": "system",
    "content": "You will read instructions and not carry them out, only seek to clarify them.\nSpecifically you will first summarise a list of super short bullets of areas that need clarification.\nThen you will pick one clarifying question, and wait for an answer from the user.\n"
  },
  {
    "role": "user",
    "content": "We are writing {{a Super Mario game in python. MVC components split in separate files. Keyboard control.}}\n"
  },
  {
    "role": "assistant",
    "content": "Summary of areas that need clarification:\n1. Specifics of the Super Mario game (e.g. level design, characters, gameplay mechanics)\n2. Details about the MVC components (e.g. which components are in each file)\n3. Keyboard control implementation (e.g. which keys to use, how to handle input)\n\nClarifying question:\nCan you provide more details about the Super Mario game, such as level design, characters, and gameplay mechanics?"
  },
  {
    "role": "user",
    "content": "{{There are 10 levels in total. The main character is a plumber named Mario, who can walk and jump. It is a classical platform game just like Super Mario. The main character moves from left to right, trying to get to the destination, where there are many obstacles and attacks from enemies in the process.}}\n\nIs anything else unclear? If yes, only answer in the form:\n{remaining unclear areas} remaining questions.\n{Next question}\nIf everything is sufficiently clear, only answer \"Nothing more to clarify.\"."
  },
  {
    "role": "assistant",
    "content": "Remaining unclear areas: 2 remaining questions.\nCan you provide more information about how the MVC components are split into separate files?"
  },
  {
    "role": "user",
    "content": "{{Make your own assumptions and state them explicitly before starting}}"
  }
]
```

Then after these clarification, the agent moved into the code writing mode with a different system message.

> **译：** 在这些澄清之后，agent 进入代码编写模式，使用一条不同的 system message。

System message:

> **译：** System message（系统消息）：

````text title="GPT-Engineer code-writing system message"
You will get instructions for code to write.
You will write a very long answer. Make sure that every detail of the architecture is, in the end, implemented as code.
Make sure that every detail of the architecture is, in the end, implemented as code.

Think step by step and reason yourself to the right decisions to make sure we get it right.
You will first lay out the names of the core classes, functions, methods that will be necessary, as well as a quick comment on their purpose.

Then you will output the content of each file including ALL code.
Each file must strictly follow a markdown code block format, where the following tokens must be replaced such that
FILENAME is the lowercase file name including the file extension,
LANG is the markup code block language for the code's language, and CODE is the code:

FILENAME
```LANG
CODE
```

You will start with the "entrypoint" file, then go to the ones that are imported by that file, and so on.
Please note that the code should be fully functional. No placeholders.

Follow a language and framework appropriate best practice file naming convention.
Make sure that files contain all imports, types etc. Make sure that code in different files are compatible with each other.
Ensure to implement all code, if you are unsure, write a plausible implementation.
Include module dependency or package manager dependency definition file.
Before you finish, double check that all parts of the architecture is present in the files.

Useful to know:
You almost always put different classes in different files.
For Python, you always create an appropriate requirements.txt file.
For NodeJS, you always create an appropriate package.json file.
You always add a comment briefly describing the purpose of the function definition.
You try to add comments explaining very complex bits of logic.
You always follow the best practices for the requested languages in terms of describing the code written as a defined
package/project.

Python toolbelt preferences:
- pytest
- dataclasses
````

Conversatin samples:[^err-conv]

> **译：** 对话示例（Conversation samples）：[^err-conv]

[^err-conv]: 原文如此（"Conversatin"），疑为 "Conversation"（对话）。

```json title="GPT-Engineer code-writing conversation"
[
  {
    "role": "system",
    "content": "You will get instructions for code to write.\nYou will write a very long answer. Make sure that every detail of the architecture is, in the end, implemented as code.\nMake sure that every detail of the architecture is, in the end, implemented as code.\n\nThink step by step and reason yourself to the right decisions to make sure we get it right.\nYou will first lay out the names of the core classes, functions, methods that will be necessary, as well as a quick comment on their purpose.\n\nThen you will output the content of each file including ALL code.\nEach file must strictly follow a markdown code block format, where the following tokens must be replaced such that\nFILENAME is the lowercase file name including the file extension,\nLANG is the markup code block language for the code's language, and CODE is the code:\n\nFILENAME\n```LANG\nCODE\n```\n\nYou will start with the \"entrypoint\" file, then go to the ones that are imported by that file, and so on.\nPlease note that the code should be fully functional. No placeholders.\n\nFollow a language and framework appropriate best practice file naming convention.\nMake sure that files contain all imports, types etc. Make sure that code in different files are compatible with each other.\nEnsure to implement all code, if you are unsure, write a plausible implementation.\nInclude module dependency or package manager dependency definition file.\nBefore you finish, double check that all parts of the architecture is present in the files.\n\nUseful to know:\nYou almost always put different classes in different files.\nFor Python, you always create an appropriate requirements.txt file.\nFor NodeJS, you always create an appropriate package.json file.\nYou always add a comment briefly describing the purpose of the function definition.\nYou try to add comments explaining very complex bits of logic.\nYou always follow the best practices for the requested languages in terms of describing the code written as a defined\npackage/project.\n\n\nPython toolbelt preferences:\n- pytest\n- dataclasses\n"
  },
 #  … same conversation as earlier, ended with "Make your own assumptions and state them explicitly before starting".
  {
    "role": "assistant",
    "content": "Assumptions:\n1. Model: The model will contain the game's data, such as level information, character states, and enemy positions.\n2. View: The view will handle the game's visuals, including rendering the game objects, backgrounds, and updating the display.\n3. Controller: The controller will manage user input, such as keyboard controls, and update the model accordingly.\n\nWith these assumptions in mind, is there any specific aspect of the keyboard control implementation you would like me to clarify?"
  },
  {
    "role": "user",
    "content": "Please now remember the steps:\n\nThink step by step and reason yourself to the right decisions to make sure we get it right.\nFirst lay out the names of the core classes, functions, methods that will be necessary, As well as a quick comment on their purpose.\n\nThen you will output the content of each file including ALL code.\nEach file must strictly follow a markdown code block format, where the following tokens must be replaced such that\nFILENAME is the lowercase file name including the file extension,\nLANG is the markup code block language for the code's language, and CODE is the code:\n\nFILENAME\n```LANG\nCODE\n```\n\nPlease note that the code should be fully functional. No placeholders.\n\nYou will start with the \"entrypoint\" file, then go to the ones that are imported by that file, and so on.\nFollow a language and framework appropriate best practice file naming convention.\nMake sure that files contain all imports, types etc. The code should be fully functional. Make sure that code in different files are compatible with each other.\nBefore you finish, double check that all parts of the architecture is present in the files.\n"
  }
]
```

## Challenges

After going through key ideas and demos of building LLM-centered agents, I start to see a couple common limitations:

> **译：** 在梳理了构建以 LLM 为中心的 agent 的关键思路与 demo 之后，我开始看到若干共同的局限：

- **Finite context length**: The restricted context capacity limits the inclusion of historical information, detailed instructions, API call context, and responses. The design of the system has to work with this limited communication bandwidth, while mechanisms like self-reflection to learn from past mistakes would benefit a lot from long or infinite context windows. Although vector stores and retrieval can provide access to a larger knowledge pool, their representation power is not as powerful as full attention.
- **Challenges in long-term planning and task decomposition**: Planning over a lengthy history and effectively exploring the solution space remain challenging. LLMs struggle to adjust plans when faced with unexpected errors, making them less robust compared to humans who learn from trial and error.
- **Reliability of natural language interface**: Current agent system relies on natural language as an interface between LLMs and external components such as memory and tools. However, the reliability of model outputs is questionable, as LLMs may make formatting errors and occasionally exhibit rebellious behavior (e.g. refuse to follow an instruction). Consequently, much of the agent demo code focuses on parsing model output.

> **译：**
>
> - **有限的上下文长度（Finite context length）**：受限的上下文容量限制了历史信息、详细指令、API 调用上下文与响应的纳入。系统设计必须在这种有限的通信带宽下运作，而诸如自我反思以从过往错误中学习的机制，则会从长或无限上下文窗口中大幅受益。尽管向量存储与检索可提供对更大知识池的访问，其表示能力仍不及完整的注意力机制。
> - **长期规划与任务分解的挑战（Challenges in long-term planning and task decomposition）**：在冗长历史上做规划并有效探索解空间仍具挑战。LLM 在面对意外错误时难以调整计划，使其相比从试错中学习的人类不够鲁棒。
> - **自然语言接口的可靠性（Reliability of natural language interface）**：当前 agent 系统依赖自然语言作为 LLM 与外部组件（如记忆和工具）之间的接口。然而模型输出的可靠性存疑，因为 LLM 可能犯格式错误，偶尔还表现出叛逆行为（如拒绝遵循指令）。因此，agent demo 代码中有很大一部分聚焦于解析模型输出。

## Citation

Cited as:

> **译：** 引用格式：

> Weng, Lilian. (Jun 2023). "LLM-powered Autonomous Agents". Lil'Log. https://lilianweng.github.io/posts/2023-06-23-agent/

Or

> **译：** 或：

```bibtex title="Citation (BibTeX)"
@article{weng2023agent,
  title   = "LLM-powered Autonomous Agents",
  author  = "Weng, Lilian",
  journal = "lilianweng.github.io",
  year    = "2023",
  month   = "Jun",
  url     = "https://lilianweng.github.io/posts/2023-06-23-agent/"
}
```

## References

> **译：** 参考文献（论文标题等引文信息保留原文，不作翻译）：

1. Wei et al. "Chain of thought prompting elicits reasoning in large language models." NeurIPS 2022. [https://arxiv.org/abs/2201.11903](https://arxiv.org/abs/2201.11903)
2. Yao et al. "Tree of Thoughts: Dliberate Problem Solving with Large Language Models."[^err-dlib] arXiv preprint arXiv:2305.10601 (2023). [https://arxiv.org/abs/2305.10601](https://arxiv.org/abs/2305.10601)
3. Liu et al. "Chain of Hindsight Aligns Language Models with Feedback" arXiv preprint arXiv:2302.02676 (2023). [https://arxiv.org/abs/2302.02676](https://arxiv.org/abs/2302.02676)
4. Liu et al. "LLM+P: Empowering Large Language Models with Optimal Planning Proficiency" arXiv preprint arXiv:2304.11477 (2023). [https://arxiv.org/abs/2304.11477](https://arxiv.org/abs/2304.11477)
5. Yao et al. "ReAct: Synergizing reasoning and acting in language models." ICLR 2023. [https://arxiv.org/abs/2210.03629](https://arxiv.org/abs/2210.03629)
6. Google Blog. "Announcing ScaNN: Efficient Vector Similarity Search" July 28, 2020. [https://ai.googleblog.com/2020/07/announcing-scann-efficient-vector.html](https://ai.googleblog.com/2020/07/announcing-scann-efficient-vector.html)
7. [https://chat.openai.com/share/46ff149e-a4c7-4dd7-a800-fc4a642ea389](https://chat.openai.com/share/46ff149e-a4c7-4dd7-a800-fc4a642ea389)
8. Shinn & Labash. "Reflexion: an autonomous agent with dynamic memory and self-reflection" arXiv preprint arXiv:2303.11366 (2023). [https://arxiv.org/abs/2303.11366](https://arxiv.org/abs/2303.11366)
9. Laskin et al. "In-context Reinforcement Learning with Algorithm Distillation" ICLR 2023. [https://arxiv.org/abs/2210.14215](https://arxiv.org/abs/2210.14215)
10. Karpas et al. "MRKL Systems A modular, neuro-symbolic architecture that combines large language models, external knowledge sources and discrete reasoning." arXiv preprint arXiv:2205.00445 (2022). [https://arxiv.org/abs/2205.00445](https://arxiv.org/abs/2205.00445)
11. Nakano et al. "Webgpt: Browser-assisted question-answering with human feedback." arXiv preprint arXiv:2112.09332 (2021). [https://arxiv.org/abs/2112.09332](https://arxiv.org/abs/2112.09332)
12. Parisi et al. "TALM: Tool Augmented Language Models" [https://arxiv.org/abs/2205.12255](https://arxiv.org/abs/2205.12255)
13. Schick et al. "Toolformer: Language Models Can Teach Themselves to Use Tools." arXiv preprint arXiv:2302.04761 (2023). [https://arxiv.org/abs/2302.04761](https://arxiv.org/abs/2302.04761)
14. Weaviate Blog. Why is Vector Search so fast? Sep 13, 2022. [https://weaviate.io/blog/why-is-vector-search-so-fast](https://weaviate.io/blog/why-is-vector-search-so-fast)
15. Li et al. "API-Bank: A Benchmark for Tool-Augmented LLMs" arXiv preprint arXiv:2304.08244 (2023). [https://arxiv.org/abs/2304.08244](https://arxiv.org/abs/2304.08244)
16. Shen et al. "HuggingGPT: Solving AI Tasks with ChatGPT and its Friends in HuggingFace" arXiv preprint arXiv:2303.17580 (2023). [https://arxiv.org/abs/2303.17580](https://arxiv.org/abs/2303.17580)
17. Bran et al. "ChemCrow: Augmenting large-language models with chemistry tools." arXiv preprint arXiv:2304.05376 (2023). [https://arxiv.org/abs/2304.05376](https://arxiv.org/abs/2304.05376)
18. Boiko et al. "Emergent autonomous scientific research capabilities of large language models." arXiv preprint arXiv:2304.05332 (2023). [https://arxiv.org/abs/2304.05332](https://arxiv.org/abs/2304.05332)
19. Joon Sung Park, et al. "Generative Agents: Interactive Simulacra of Human Behavior." arXiv preprint arXiv:2304.03442 (2023). [https://arxiv.org/abs/2304.03442](https://arxiv.org/abs/2304.03442)
20. AutoGPT. [https://github.com/Significant-Gravitas/Auto-GPT](https://github.com/Significant-Gravitas/Auto-GPT)
21. GPT-Engineer. [https://github.com/AntonOsika/gpt-engineer](https://github.com/AntonOsika/gpt-engineer)

[^err-dlib]: 原文如此（"Dliberate"），疑为 "Deliberate"（审慎的）。
