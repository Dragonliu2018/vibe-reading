---
title: "Building effective agents"
source:
  type: "article"
  project: "Anthropic"
  url: "https://www.anthropic.com/engineering/building-effective-agents"
  author: "Erik S., Barry Zhang"
  site: "Anthropic Engineering"
date: "2026-07-30T16:10:00+08:00"
category: [AI, Agent, AI Coding, Claude Code, Official]
tags: ["LLM Agents", "Anthropic", "Workflows", "Agentic Systems", "Tool Use", "Prompt Engineering"]
description: "Anthropic 工程团队总结构建 LLM agent 的实践经验：从增强型 LLM 这一基础构件出发，介绍 prompt chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer 五种工作流，以及自主 agent 的适用场景与设计原则。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) · **作者** Erik S., Barry Zhang · **来源** Anthropic Engineering · **原文发布** 2024-12-19 · **中英对照·AI 译** 2026-07-30
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

## What are agents?

"Agent" can be defined in several ways. Some customers define agents as fully autonomous systems that operate independently over extended periods, using various tools to accomplish complex tasks. Others use the term to describe more prescriptive implementations that follow predefined workflows. At Anthropic, we categorize all these variations as agentic systems, but draw an important architectural distinction between workflows and agents:

- **Workflows** are systems where LLMs and tools are orchestrated through predefined code paths.
- **Agents**, on the other hand, are systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks.

Below, we will explore both types of agentic systems in detail. In Appendix 1 ("Agents in Practice"), we describe two domains where customers have found particular value in using these kinds of systems.

> **译：** "Agent" 有多种定义方式。一些客户把 agent 定义为长期独立运行的完全自主系统，使用各种工具完成复杂任务；也有人用它指代遵循预定义工作流、更规整的实现。在 Anthropic，我们把所有这些变体统称为 agentic systems，但在架构上区分 workflows 和 agents：
>
> - **Workflows**：LLM 与工具通过预定义的代码路径被编排起来的系统。
> - **Agents**：LLM 动态主导自身流程与工具使用的系统，由它掌控如何完成任务。
>
> 下文将详细探讨这两类 agentic systems。附录 1（"Agents in Practice"）描述了客户在两个领域中发现特别价值的用法。

## When (and when not) to use agents

When building applications with LLMs, we recommend finding the simplest solution possible, and only increasing complexity when needed. This might mean not building agentic systems at all. Agentic systems often trade latency and cost for better task performance, and you should consider when this tradeoff makes sense. When more complexity is warranted, workflows offer predictability and consistency for well-defined tasks, whereas agents are the better option when flexibility and model-driven decision-making are needed at scale. For many applications, however, optimizing single LLM calls with retrieval and in-context examples is usually enough.

> **译：** 用 LLM 构建应用时，我们建议先找最简单的方案，只在需要时才增加复杂度——这甚至可能意味着根本不构建 agentic system。Agentic systems 常以更高的延迟和成本换取更好的任务表现，你需要判断这种权衡何时才值得。当确实需要更多复杂度时，workflows 为定义良好的任务提供可预期性和一致性；而当大规模场景需要灵活性与模型驱动的决策时，agents 是更好的选择。不过对很多应用来说，仅仅优化单次 LLM 调用（配合检索和上下文示例）通常就足够了。

## When and how to use frameworks

There are many frameworks that make agentic systems easier to implement, including:

- The [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk);
- [Strands Agents SDK](https://github.com/strands-agents/sdk-python) by AWS;
- [Rivet](https://rivet.ironcladapp.com/), a drag and drop GUI LLM workflow builder; and
- [Vellum](https://www.vellum.ai/), another GUI tool for building and testing complex workflows.

These frameworks make it easy to get started by simplifying standard low-level tasks like calling LLMs, defining and parsing tools, and chaining calls together. However, they often create extra layers of abstraction that can obscure the underlying prompts and responses, making them harder to debug. They can also make it tempting to add complexity when a simpler setup would suffice.

We suggest that developers start by using LLM APIs directly: many patterns can be implemented in a few lines of code. If you do use a framework, ensure you understand the underlying code. Incorrect assumptions about what's under the hood are a common source of customer error.

See our [cookbook](https://github.com/anthropics/anthropic-cookbook) for some sample implementations.

> **译：** 有很多框架能让 agentic systems 更容易实现，包括：
>
> - [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)；
> - AWS 的 [Strands Agents SDK](https://github.com/strands-agents/sdk-python)；
> - [Rivet](https://rivet.ironcladapp.com/)，一个拖拽式 GUI LLM 工作流构建器；
> - [Vellum](https://www.vellum.ai/)，另一个用于构建和测试复杂工作流的 GUI 工具。
>
> 这些框架通过简化调用 LLM、定义和解析工具、串联调用等标准底层任务，降低了上手门槛。但它们常常引入额外的抽象层，遮蔽底层的 prompt 和响应，使其更难调试；也容易诱使人在本可用更简单配置时去堆砌复杂度。
>
> 我们建议开发者从直接使用 LLM API 开始：许多模式只需几行代码就能实现。若确要使用框架，务必理解其底层代码。对"黑盒里到底有什么"的错误假设，是客户错误的常见来源。
>
> 参考我们的 [cookbook](https://github.com/anthropics/anthropic-cookbook) 获取一些示例实现。

## Building blocks, workflows, and agents

In this section, we'll explore the common patterns for agentic systems we've seen in production. We'll start with our foundational building block—the augmented LLM—and progressively increase complexity, from simple compositional workflows to autonomous agents.

> **译：** 本节探讨我们在生产环境中见到的 agentic systems 常见模式。我们从基础构件——增强型 LLM——出发，逐步提升复杂度，从简单的组合式工作流一直到自主 agent。

### Building block: The augmented LLM

The basic building block of agentic systems is an LLM enhanced with augmentations such as retrieval, tools, and memory. Our current models can actively use these capabilities—generating their own search queries, selecting appropriate tools, and determining what information to retain.

![The augmented LLM](/vibe-reading/images/articles/anthropic-official-building-effective-agents/augmented-llm.png)

We recommend focusing on two key aspects of the implementation: tailoring these capabilities to your specific use case and ensuring they provide an easy, well-documented interface for your LLM. While there are many ways to implement these augmentations, one approach is through our recently released [Model Context Protocol](https://modelcontextprotocol.io/), which allows developers to integrate with a growing ecosystem of third-party tools with a simple client implementation.

For the remainder of this post, we'll assume each LLM call has access to these augmented capabilities.

> **译：** Agentic systems 的基本构件，是经过检索、工具、记忆等增强的 LLM。我们当前的模型能主动使用这些能力——自行生成搜索查询、选择合适的工具、决定保留哪些信息。
>
> 我们建议在实现上聚焦两点：把这些能力针对你的具体用例做裁剪，并确保它们为 LLM 提供一个易用、文档完善的接口。实现这些增强的方式很多，其中一种是通过我们近期发布的 [Model Context Protocol](https://modelcontextprotocol.io/)，它让开发者能用简单的客户端实现接入不断增长的第三方工具生态。
>
> 本文余下部分假设每次 LLM 调用都能访问这些增强能力。

### Workflow: Prompt chaining

Prompt chaining decomposes a task into a sequence of steps, where each LLM call processes the output of the previous one. You can add programmatic checks (see "gate" in the diagram below) on any intermediate steps to ensure that the process is still on track.

![The prompt chaining workflow](/vibe-reading/images/articles/anthropic-official-building-effective-agents/prompt-chaining.png)

When to use this workflow: This workflow is ideal for situations where the task can be easily and cleanly decomposed into fixed subtasks. The main goal is to trade off latency for higher accuracy, by making each LLM call an easier task.

Examples where prompt chaining is useful:

- Generating Marketing copy, then translating it into a different language.
- Writing an outline of a document, checking that the outline meets certain criteria, then writing the document based on the outline.

> **译：** Prompt chaining 把任务分解为一系列步骤，每次 LLM 调用处理前一次的输出。可以在任意中间步骤加程序化检查（见下图中的 "gate"），确保流程仍在正轨。
>
> **何时使用：** 当任务能轻松、干净地分解为固定子任务时理想。主要目标是用延迟换取更高准确率——让每次 LLM 调用都变成更简单的任务。
>
> **示例：**
>
> - 先生成营销文案，再翻译成另一种语言。
> - 先写文档大纲，检查大纲是否满足某些标准，再基于大纲撰写完整文档。

### Workflow: Routing

Routing classifies an input and directs it to a specialized followup task. This workflow allows for separation of concerns, and building more specialized prompts. Without this workflow, optimizing for one kind of input can hurt performance on other inputs.

![The routing workflow](/vibe-reading/images/articles/anthropic-official-building-effective-agents/routing.png)

When to use this workflow: Routing works well for complex tasks where there are distinct categories that are better handled separately, and where classification can be handled accurately, either by an LLM or a more traditional classification model/algorithm.

Examples where routing is useful:

- Directing different types of customer service queries (general questions, refund requests, technical support) into different downstream processes, prompts, and tools.
- Routing easy/common questions to smaller, cost-efficient models like Claude Haiku 4.5 and hard/unusual questions to more capable models like Claude Sonnet 4.5 to optimize for best performance.

> **译：** Routing 对输入做分类，再导向专门的后续任务。这种工作流实现了关注点分离，可以构建更专门的 prompt。若不这么做，针对某类输入的优化可能损害其他输入上的表现。
>
> **何时使用：** 当复杂任务存在若干明显类别、适合分开处理，且分类可被准确执行（由 LLM 或更传统的分类模型/算法完成）时效果良好。
>
> **示例：**
>
> - 把不同类型的客服查询（普通咨询、退款请求、技术支持）导向不同的下游流程、prompt 和工具。
> - 把简单/常见问题路由到更小、更具成本效益的模型（如 Claude Haiku 4.5），把困难/罕见问题路由到更强模型（如 Claude Sonnet 4.5），以优化整体表现。

### Workflow: Parallelization

LLMs can sometimes work simultaneously on a task and have their outputs aggregated programmatically. This workflow, parallelization, manifests in two key variations:

- **Sectioning**: Breaking a task into independent subtasks run in parallel.
- **Voting**: Running the same task multiple times to get diverse outputs.

![The parallelization workflow](/vibe-reading/images/articles/anthropic-official-building-effective-agents/parallelization.png)

When to use this workflow: Parallelization is effective when the divided subtasks can be parallelized for speed, or when multiple perspectives or attempts are needed for higher confidence results. For complex tasks with multiple considerations, LLMs generally perform better when each consideration is handled by a separate LLM call, allowing focused attention on each specific aspect.

Examples where parallelization is useful:

- **Sectioning**:
  - Implementing guardrails where one model instance processes user queries while another screens them for inappropriate content or requests. This tends to perform better than having the same LLM call handle both guardrails and the core response.
  - Automating evals for evaluating LLM performance, where each LLM call evaluates a different aspect of the model's performance on a given prompt.
- **Voting**:
  - Reviewing a piece of code for vulnerabilities, where several different prompts review and flag the code if they find a problem.
  - Evaluating whether a given piece of content is inappropriate, with multiple prompts evaluating different aspects or requiring different vote thresholds to balance false positives and negatives.

> **译：** LLM 有时可以同时处理一个任务，再由程序聚合它们的输出。这种 parallelization 工作流有两种关键变体：
>
> - **Sectioning**：把任务拆成可并行的独立子任务。
> - **Voting**：把同一任务运行多次以获得多样化输出。
>
> **何时使用：** 当拆分后的子任务可以并行以提速，或需要多视角/多次尝试以获得更高置信度时有效。对于有多个考量点的复杂任务，每个考量点由单独的 LLM 调用处理通常表现更好——能让每次调用聚焦于具体方面。
>
> **示例：**
>
> - **Sectioning**：
>   - 实现护栏：一个模型实例处理用户查询，另一个筛查不当内容或请求。这通常比让同一次 LLM 调用既管护栏又管核心回复表现更好。
>   - 自动化 eval：每次 LLM 调用评估模型在某 prompt 上表现的不同方面。
> - **Voting**：
>   - 代码漏洞审查：用多个不同 prompt 审查，发现问题就标记。
>   - 评估内容是否不当：多个 prompt 评估不同方面，或要求不同的投票阈值以平衡假阳性与假阴性。

### Workflow: Orchestrator-workers

In the orchestrator-workers workflow, a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results.

![The orchestrator-workers workflow](/vibe-reading/images/articles/anthropic-official-building-effective-agents/orchestrator-workers.png)

When to use this workflow: This workflow is well-suited for complex tasks where you can't predict the subtasks needed (in coding, for example, the number of files that need to be changed and the nature of the change in each file likely depend on the task). Whereas it's topographically similar, the key difference from parallelization is its flexibility—subtasks aren't pre-defined, but determined by the orchestrator based on the specific input.

Example where orchestrator-workers is useful:

- Coding products that make complex changes to multiple files each time.
- Search tasks that involve gathering and analyzing information from multiple sources for possible relevant information.

> **译：** 在 orchestrator-workers 工作流中，一个中央 LLM 动态拆解任务、委派给 worker LLM，再综合它们的结果。
>
> **何时使用：** 适合无法预测所需子任务的复杂任务（例如编码中需要改动的文件数量和每个文件的改动性质往往取决于任务）。虽然拓扑上与 parallelization 相似，但关键区别在于灵活性——子任务不是预定义的，而是由 orchestrator 根据具体输入决定。
>
> **示例：**
>
> - 每次都要对多文件做复杂改动的编码产品。
> - 需要从多个来源收集和分析信息以查找潜在相关内容的搜索任务。

### Workflow: Evaluator-optimizer

In the evaluator-optimizer workflow, one LLM call generates a response while another provides evaluation and feedback in a loop.

![The evaluator-optimizer workflow](/vibe-reading/images/articles/anthropic-official-building-effective-agents/evaluator-optimizer.png)

When to use this workflow: This workflow is particularly effective when we have clear evaluation criteria, and when iterative refinement provides measurable value. The two signs of good fit are, first, that LLM responses can be demonstrably improved when a human articulates their feedback; and second, that the LLM can provide such feedback. This is analogous to the iterative writing process a human writer might go through when producing a polished document.

Examples where evaluator-optimizer is useful:

- Literary translation where there are nuances that the translator LLM might not capture initially, but where an evaluator LLM can provide useful critiques.
- Complex search tasks that require multiple rounds of searching and analysis to gather comprehensive information, where the evaluator decides whether further searches are warranted.

> **译：** 在 evaluator-optimizer 工作流中，一次 LLM 调用生成响应，另一次在循环中提供评估和反馈。
>
> **何时使用：** 当有明确的评估标准、且迭代精修能带来可衡量的价值时特别有效。两个契合信号：一是当人类明确给出反馈时，LLM 的响应可被显著改进；二是 LLM 本身能给出这种反馈。这类似于人类作家打磨文档时的迭代写作过程。
>
> **示例：**
>
> - 文学翻译：翻译 LLM 起初可能捕捉不到的细微之处，由评估 LLM 提供有用的批评。
> - 复杂搜索任务：需要多轮搜索与分析以收集全面信息，由 evaluator 决定是否需要进一步搜索。

### Agents

Agents are emerging in production as LLMs mature in key capabilities—understanding complex inputs, engaging in reasoning and planning, using tools reliably, and recovering from errors. Agents begin their work with either a command from, or interactive discussion with, the human user. Once the task is clear, agents plan and operate independently, potentially returning to the human for further information or judgement. During execution, it's crucial for the agents to gain "ground truth" from the environment at each step (such as tool call results or code execution) to assess its progress. Agents can then pause for human feedback at checkpoints or when encountering blockers. The task often terminates upon completion, but it's also common to include stopping conditions (such as a maximum number of iterations) to maintain control.

Agents can handle sophisticated tasks, but their implementation is often straightforward. They are typically just LLMs using tools based on environmental feedback in a loop. It is therefore crucial to design toolsets and their documentation clearly and thoughtfully. We expand on best practices for tool development in Appendix 2 ("Prompt Engineering your Tools").

![Autonomous agent](/vibe-reading/images/articles/anthropic-official-building-effective-agents/autonomous-agent.png)

When to use agents: Agents can be used for open-ended problems where it's difficult or impossible to predict the required number of steps, and where you can't hardcode a fixed path. The LLM will potentially operate for many turns, and you must have some level of trust in its decision-making. Agents' autonomy makes them ideal for scaling tasks in trusted environments.

The autonomous nature of agents means higher costs, and the potential for compounding errors. We recommend extensive testing in sandboxed environments, along with the appropriate guardrails.

Examples where agents are useful:

The following examples are from our own implementations:

- A coding Agent to resolve [SWE-bench tasks](https://github.com/SWE-bench/SWE-bench), which involve edits to many files based on a task description;
- Our ["computer use" reference implementation](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo), where Claude uses a computer to accomplish tasks.

![High-level flow of a coding agent](/vibe-reading/images/articles/anthropic-official-building-effective-agents/coding-agent-flow.png)

> **译：** 随着 LLM 在理解复杂输入、推理与规划、可靠使用工具、从错误中恢复等关键能力上成熟，agents 正在生产中兴起。Agent 的工作始于人类的指令或交互式讨论；任务明确后，agent 独立规划并执行，可能在中途回头向人类寻求更多信息或判断。执行过程中，agent 必须在每一步从环境获取"ground truth"（如工具调用结果或代码执行结果）以评估进展。Agent 可以在检查点或遇到阻塞时暂停等待人类反馈。任务通常在完成时终止，但也常设置停止条件（如最大迭代次数）以保持控制。
>
> Agent 能处理复杂任务，但其实现往往很直接——通常就是 LLM 在循环中基于环境反馈使用工具。因此，清晰、周到地设计工具集及其文档至关重要。我们在附录 2（"Prompt Engineering your Tools"）展开工具开发的最佳实践。
>
> **何时使用：** Agent 适用于开放式问题——难以或无法预测所需步骤数、无法硬编码固定路径的场景。LLM 可能要运行很多轮，你必须对其决策有一定信任。Agent 的自主性使其非常适合在可信环境中规模化任务。
>
> Agent 的自主性也意味着更高成本和错误累积的风险。我们建议在沙箱环境中充分测试，并配以适当的护栏。
>
> **示例（来自我们自己的实现）：**
>
> - 用于解决 [SWE-bench 任务](https://github.com/SWE-bench/SWE-bench)的编码 Agent，需根据任务描述编辑多个文件；
> - 我们的["computer use" 参考实现](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo)，Claude 用计算机完成任务。

## Combining and customizing these patterns

These building blocks aren't prescriptive. They're common patterns that developers can shape and combine to fit different use cases. The key to success, as with any LLM features, is measuring performance and iterating on implementations. To repeat: you should consider adding complexity only when it demonstrably improves outcomes.

> **译：** 这些构件并非硬性规定，而是开发者可据不同用例塑造、组合的常见模式。与任何 LLM 特性一样，成功的关键是衡量表现并迭代实现。再说一遍：只有当复杂度能切实改善结果时，才应考虑增加它。

## Summary

Success in the LLM space isn't about building the most sophisticated system. It's about building the right system for your needs. Start with simple prompts, optimize them with comprehensive evaluation, and add multi-step agentic systems only when simpler solutions fall short.

When implementing agents, we try to follow three core principles:

- Maintain **simplicity** in your agent's design.
- Prioritize **transparency** by explicitly showing the agent's planning steps.
- Carefully craft your agent-computer interface (ACI) through thorough tool **documentation and testing**.

Frameworks can help you get started quickly, but don't hesitate to reduce abstraction layers and build with basic components as you move to production. By following these principles, you can create agents that are not only powerful but also reliable, maintainable, and trusted by your users.

> **译：** 在 LLM 领域，成功不在于构建最复杂的系统，而在于构建最符合你需要的系统。从简单的 prompt 开始，用全面的评估去优化它们，只有当更简单的方案力有不逮时才引入多步 agentic systems。
>
> 实现 agent 时，我们遵循三条核心原则：
>
> - 在 agent 设计上保持**简单**。
> - 通过显式展示 agent 的规划步骤来优先保证**透明性**。
> - 通过彻底的工具**文档与测试**，精心打造 agent-computer interface (ACI)。
>
> 框架能帮你快速起步，但在走向生产时，不要犹豫去掉抽象层、用基础组件来构建。遵循这些原则，你能造出不仅强大、而且可靠、可维护、被用户信任的 agent。

### Acknowledgements

Written by Erik S. and Barry Zhang. This work draws upon our experiences building agents at Anthropic and the valuable insights shared by our customers, for which we're deeply grateful.

> **译：** 本文由 Erik S. 和 Barry Zhang 撰写，基于我们在 Anthropic 构建 agent 的经验以及客户分享的宝贵洞察，对此深表感谢。

## Appendix 1: Agents in practice

Our work with customers has revealed two particularly promising applications for AI agents that demonstrate the practical value of the patterns discussed above. Both applications illustrate how agents add the most value for tasks that require both conversation and action, have clear success criteria, enable feedback loops, and integrate meaningful human oversight.

> **译：** 我们与客户的合作揭示了两个特别有前景的 AI agent 应用，印证了上述模式的实用价值。这两个应用都说明：agent 在那些既需要对话又需要行动、有明确成功标准、能形成反馈回路、并融入有意义的人工监督的任务上，价值最大。

### A. Customer support

Customer support combines familiar chatbot interfaces with enhanced capabilities through tool integration. This is a natural fit for more open-ended agents because:

- Support interactions naturally follow a conversation flow while requiring access to external information and actions;
- Tools can be integrated to pull customer data, order history, and knowledge base articles;
- Actions such as issuing refunds or updating tickets can be handled programmatically; and
- Success can be clearly measured through user-defined resolutions.

Several companies have demonstrated the viability of this approach through usage-based pricing models that charge only for successful resolutions, showing confidence in their agents' effectiveness.

> **译：** 客服把熟悉的聊天机器人界面与通过工具集成增强的能力结合起来。这天然契合更开放的 agent，因为：
>
> - 客服交互自然遵循对话流，同时需要访问外部信息和执行动作；
> - 可集成工具拉取客户数据、订单历史、知识库文章；
> - 退款、更新工单等动作可由程序化处理；
> - 成功与否可通过用户定义的"解决"标准清晰衡量。
>
> 已有若干公司通过"按成功解决计费"的用量定价模型证明了这种方式的可行性，显示出对自家 agent 有效性的信心。

### B. Coding agents

The software development space has shown remarkable potential for LLM features, with capabilities evolving from code completion to autonomous problem-solving. Agents are particularly effective because:

- Code solutions are verifiable through automated tests;
- Agents can iterate on solutions using test results as feedback;
- The problem space is well-defined and structured; and
- Output quality can be measured objectively.

In our own implementation, agents can now solve real GitHub issues in the SWE-bench Verified benchmark based on the pull request description alone. However, whereas automated testing helps verify functionality, human review remains crucial for ensuring solutions align with broader system requirements.

> **译：** 软件开发领域展现了 LLM 特性的巨大潜力，能力从代码补全演进到自主解决问题。Agent 尤为有效，因为：
>
> - 代码方案可通过自动化测试验证；
> - Agent 能用测试结果作为反馈来迭代方案；
> - 问题空间定义良好、结构清晰；
> - 输出质量可客观衡量。
>
> 在我们自己的实现中，agent 现在仅凭 PR 描述就能在 SWE-bench Verified benchmark 上解决真实的 GitHub issue。不过，虽然自动化测试有助于验证功能，人工 review 对于确保方案契合更广的系统需求仍至关重要。

## Appendix 2: Prompt engineering your tools

No matter which agentic system you're building, tools will likely be an important part of your agent. Tools enable Claude to interact with external services and APIs by specifying their exact structure and definition in our API. When Claude responds, it will include a tool use block in the API response if it plans to invoke a tool. Tool definitions and specifications should be given just as much prompt engineering attention as your overall prompts. In this brief appendix, we describe how to prompt engineer your tools.

There are often several ways to specify the same action. For instance, you can specify a file edit by writing a diff, or by rewriting the entire file. For structured output, you can return code inside markdown or inside JSON. In software engineering, differences like these are cosmetic and can be converted losslessly from one to the other. However, some formats are much more difficult for an LLM to write than others. Writing a diff requires knowing how many lines are changing in the chunk header before the new code is written. Writing code inside JSON (compared to markdown) requires extra escaping of newlines and quotes.

Our suggestions for deciding on tool formats are the following:

- Give the model enough tokens to "think" before it writes itself into a corner.
- Keep the format close to what the model has seen naturally occurring in text on the internet.
- Make sure there's no formatting "overhead" such as having to keep an accurate count of thousands of lines of code, or string-escaping any code it writes.

One rule of thumb is to think about how much effort goes into human-computer interfaces (HCI), and plan to invest just as much effort in creating good agent-computer interfaces (ACI). Here are some thoughts on how to do so:

- **Put yourself in the model's shoes.** Is it obvious how to use this tool, based on the description and parameters, or would you need to think carefully about it? If so, then it's probably also true for the model. A good tool definition often includes example usage, edge cases, input format requirements, and clear boundaries from other tools.
- **How can you change parameter names or descriptions to make things more obvious?** Think of this as writing a great docstring for a junior developer on your team. This is especially important when using many similar tools.
- **Test how the model uses your tools:** Run many example inputs in our workbench to see what mistakes the model makes, and iterate.
- **Poka-yoke your tools.** Change the arguments so that it is harder to make mistakes.

While building our agent for SWE-bench, we actually spent more time optimizing our tools than the overall prompt. For example, we found that the model would make mistakes with tools using relative filepaths after the agent had moved out of the root directory. To fix this, we changed the tool to always require absolute filepaths—and we found that the model used this method flawlessly.

> **译：** 无论构建哪种 agentic system，工具很可能都是 agent 的重要组成部分。工具通过在我们的 API 中指定其确切结构与定义，使 Claude 能与外部服务和 API 交互。当 Claude 响应时，若计划调用工具，会在 API 响应中包含一个 tool use block。工具的定义与规范，应和整体 prompt 一样受到同等的 prompt engineering 关注。本附录简述如何对工具做 prompt engineering。
>
> 同一动作往往有多种指定方式。例如，文件编辑可写成 diff，也可重写整个文件；结构化输出可把代码放在 markdown 里，也可放在 JSON 里。在软件工程里，这些差异是表面的，可无损互转。但对 LLM 而言，有些格式比另一些难写得多：写 diff 需要在写新代码前就知道 chunk header 里变动的行数；把代码放进 JSON（相比 markdown）需要对换行和引号做额外转义。
>
> **关于工具格式的建议：**
>
> - 给模型足够多的 token 去"思考"，别让它把自己写进死胡同。
> - 让格式贴近模型在互联网文本中自然见过的形式。
> - 确保没有格式"开销"——比如不必精确计数数千行代码，不必对所写代码做字符串转义。
>
> 一个经验法则：想想人机界面（HCI）投入了多少精力，就打算在打造良好的 agent-computer interface（ACI）上投入同等精力。一些具体做法：
>
> - **站在模型的立场**：仅看描述和参数，用法是否一目了然，还是得仔细琢磨？若你需要琢磨，模型大概率也需要。好的工具定义往往包含用法示例、边界情况、输入格式要求，以及与其他工具的清晰边界。
> - **如何改参数名或描述让用法更显眼？** 把这想象成给团队里的初级开发者写一份出色的 docstring。当使用许多相似工具时尤为重要。
> - **测试模型如何使用你的工具：** 在 workbench 里跑大量示例输入，看模型犯什么错，再迭代。
> - **对工具做 Poka-yoke（防呆）：** 调整参数，让错误更难发生。
>
> 在为 SWE-bench 构建 agent 时，我们花在优化工具上的时间其实比整体 prompt 还多。例如，我们发现 agent 离开根目录后，使用相对路径的工具会出错。为此我们把工具改成始终要求绝对路径——结果模型用这种方式毫无差错。
