---
title: "How we built our multi-agent research system"
source:
  type: "article"
  project: "Anthropic"
  url: "https://www.anthropic.com/engineering/multi-agent-research-system"
  author: "Jeremy Hadfield, Barry Zhang, Kenneth Lien, Florian Scholz, Jeremy Fox, Daniel Ford"
  site: "Anthropic Engineering"
date: "2026-08-24T17:35:00+08:00"
category: [AI, Agent, Multi-Agent, Official]
tags: ["Multi-Agent", "Anthropic", "Research System", "Orchestrator-Worker", "Subagents", "Prompt Engineering", "Agent Evaluation", "Production Reliability"]
description: "Anthropic 工程团队分享 Claude Research 多 Agent 系统的构建过程：orchestrator-worker 架构、八条 prompt 工程原则、Agent 评估方法论与生产可靠性工程实践，多 Agent 系统在内部研究评测上比单 Agent 高 90.2%。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · **作者** Jeremy Hadfield, Barry Zhang, Kenneth Lien, Florian Scholz, Jeremy Fox, Daniel Ford · **来源** Anthropic Engineering · **原文发布** 2025-06-13 · **中英对照·AI 译** 2026-08-24
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

Published Jun 13, 2025

> **译：** 发布于 2025 年 6 月 13 日

Our Research feature uses multiple Claude agents to explore complex topics more effectively. We share the engineering challenges and the lessons we learned from building this system.

> **译：** 我们的 Research 功能使用多个 Claude Agent 来更有效地探索复杂主题。我们分享构建这一系统时遇到的工程挑战和经验教训。

Claude now has Research capabilities that allow it to search across the web, Google Workspace, and any integrations to accomplish complex tasks.

> **译：** Claude 现在具备 Research 能力，可以搜索网络、Google Workspace 及任何集成来完成复杂任务。

The journey of this multi-agent system from prototype to production taught us critical lessons about system architecture, tool design, and prompt engineering. A multi-agent system consists of multiple agents (LLMs autonomously using tools in a loop) working together. Our Research feature involves an agent that plans a research process based on user queries, and then uses tools to create parallel agents that search for information simultaneously. Systems with multiple agents introduce new challenges in agent coordination, evaluation, and reliability.

> **译：** 这个多 Agent 系统从原型到生产的历程，让我们学到了关于系统架构、工具设计和 prompt 工程的关键教训。多 Agent 系统由多个协同工作的 Agent（在循环中自主使用工具的 LLM）组成。我们的 Research 功能涉及一个 Agent，它根据用户查询规划研究流程，然后使用工具创建并行的 Agent 来同时搜索信息。多 Agent 系统在 Agent 协调、评估和可靠性方面引入了新的挑战。

This post breaks down the principles that worked for us—we hope you'll find them useful to apply when building your own multi-agent systems.

> **译：** 这篇文章拆解了对我们有效的原则——我们希望你在构建自己的多 Agent 系统时能发现它们的用处。

## Benefits of a multi-agent system

Research work involves open-ended problems where it's very difficult to predict the required steps in advance. You can't hardcode a fixed path for exploring complex topics, as the process is inherently dynamic and path-dependent. When people conduct research, they tend to continuously update their approach based on discoveries, following leads that emerge during investigation.

> **译：** 研究工作涉及开放式问题，很难预先预测所需步骤。你无法为探索复杂主题硬编码一条固定路径，因为这个过程本质上是动态的、路径依赖的。当人们进行研究时，他们倾向于根据发现不断更新方法，追随调查过程中出现的线索。

This unpredictability makes AI agents particularly well-suited for research tasks. Research demands the flexibility to pivot or explore tangential connections as the investigation unfolds. The model must operate autonomously for many turns, making decisions about which directions to pursue based on intermediate findings. A linear, one-shot pipeline cannot handle these tasks.

> **译：** 这种不可预测性使 AI Agent 特别适合研究任务。研究要求在调查展开时能够灵活转向或探索旁支关联。模型必须自主运行多轮，根据中间发现决定追踪哪些方向。线性的、一次性的管道无法处理这些任务。

The essence of search is compression: distilling insights from a vast corpus. Subagents facilitate compression by operating in parallel with their own context windows, exploring different aspects of the question simultaneously before condensing the most important tokens for the lead research agent. Each subagent also provides separation of concerns—distinct tools, prompts, and exploration trajectories—which reduces path dependency and enables thorough, independent investigations.

> **译：** 搜索的本质是压缩：从海量语料中提炼洞见。子 Agent 通过使用各自的上下文窗口并行运作来促进压缩——在为首席研究 Agent 浓缩最重要的 token 之前，同时探索问题的不同方面。每个子 Agent 还提供了关注点分离——不同的工具、prompt 和探索轨迹——这减少了路径依赖，使彻底的、独立的调查成为可能。

Once intelligence reaches a threshold, multi-agent systems become a vital way to scale performance. For instance, although individual humans have become more intelligent in the last 100,000 years, human societies have become exponentially more capable in the information age because of our collective intelligence and ability to coordinate. Even generally-intelligent agents face limits when operating as individuals; groups of agents can accomplish far more.

> **译：** 一旦智能达到某个阈值，多 Agent 系统就成为扩展性能的重要方式。例如，尽管单个智人在过去 10 万年中变得更聪明，但人类社会在信息时代因集体智能和协调能力而呈指数级提升。即使是通用智能的 Agent 在单独运作时也面临限制；Agent 群体能完成远超个体的工作。

Our internal evaluations show that multi-agent research systems excel especially for breadth-first queries that involve pursuing multiple independent directions simultaneously. We found that a multi-agent system with Claude Opus 4 as the lead agent and Claude Sonnet 4 subagents outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval. For example, when asked to identify all the board members of the companies in the Information Technology S&P 500, the multi-agent system found the correct answers by decomposing this into tasks for subagents, while the single agent system failed to find the answer with slow, sequential searches.

> **译：** 我们的内部评估表明，多 Agent 研究系统特别擅长广度优先查询——即同时追踪多个独立方向。我们发现，以 Claude Opus 4 作为主 Agent、Claude Sonnet 4 作为子 Agent 的多 Agent 系统，在内部研究评测上比单 Agent Claude Opus 4 高出 90.2%。例如，当被要求识别标普 500 信息技术公司所有董事会成员时，多 Agent 系统通过将任务分解给子 Agent 找到了正确答案，而单 Agent 系统在缓慢的顺序搜索中未能找到答案。

Multi-agent systems work mainly because they help spend enough tokens to solve the problem. In our analysis, three factors explained 95% of the performance variance in the BrowseComp evaluation (which tests the ability of browsing agents to locate hard-to-find information). We found that token usage by itself explains 80% of the variance, with the number of tool calls and the model choice as the two other explanatory factors. This finding validates our architecture that distributes work across agents with separate context windows to add more capacity for parallel reasoning. The latest Claude models act as large efficiency multipliers on token use, as upgrading to Claude Sonnet 4 is a larger performance gain than doubling the token budget on Claude Sonnet 3.7. Multi-agent architectures effectively scale token usage for tasks that exceed the limits of single agents.

> **译：** 多 Agent 系统之所以有效，主要因为它们帮助投入足够的 token 来解决问题。在我们的分析中，三个因素解释了 BrowseComp 评测（测试浏览 Agent 定位难以找到的信息的能力）中 95% 的性能差异。我们发现 token 使用量本身解释了 80% 的差异，工具调用次数和模型选择是另外两个解释因素。这一发现验证了我们的架构——通过将工作分配给拥有独立上下文窗口的 Agent 来增加并行推理能力。最新的 Claude 模型对 token 使用起到了巨大的效率乘数作用——升级到 Claude Sonnet 4 带来的性能提升，比在 Claude Sonnet 3.7 上翻倍 token 预算还要大。多 Agent 架构有效地扩展了超出单 Agent 限制的任务的 token 使用。

There is a downside: in practice, these architectures burn through tokens fast. In our data, agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats. For economic viability, multi-agent systems require tasks where the value of the task is high enough to pay for the increased performance. Further, some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit for multi-agent systems today. For instance, most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating to other agents in real time. We've found that multi-agent systems excel at valuable tasks that involve heavy parallelization, information that exceeds single context windows, and interfacing with numerous complex tools.

> **译：** 但也有缺点：实践中，这些架构会快速消耗 token。在我们的数据中，Agent 通常比聊天交互使用约 4 倍的 token，而多 Agent 系统比聊天使用约 15 倍的 token。为了经济可行性，多 Agent 系统要求任务的价值足够高，能支付增加的性能开销。此外，一些需要所有 Agent 共享相同上下文或涉及 Agent 间大量依赖的领域，目前不适合多 Agent 系统。例如，大多数编码任务比研究任务涉及更少的真正可并行化任务，而 LLM Agent 尚不擅长实时协调和委托其他 Agent。我们发现多 Agent 系统在涉及大量并行化、超出单个上下文窗口的信息、以及与众多复杂工具交互的高价值任务上表现出色。

## Architecture overview for Research

Our Research system uses a multi-agent architecture with an orchestrator-worker pattern, where a lead agent coordinates the process while delegating to specialized subagents that operate in parallel.

> **译：** 我们的 Research 系统使用多 Agent 架构的 orchestrator-worker 模式，主 Agent 协调流程，同时委托给并行的专业化子 Agent。

![Architecture overview: user queries flow through a lead agent that creates specialized subagents searching in parallel](/vibe-reading/images/articles/anthropic-official-multi-agent-research-system/architecture-overview.png)

When a user submits a query, the lead agent analyzes it, develops a strategy, and spawns subagents to explore different aspects simultaneously. As shown in the diagram above, the subagents act as intelligent filters by iteratively using search tools to gather information, in this case on AI agent companies in 2025, and then returning a list of companies to the lead agent so it can compile a final answer.

> **译：** 当用户提交查询时，主 Agent 分析查询、制定策略，并生成子 Agent 来同时探索不同方面。如上图所示，子 Agent 充当智能过滤器——迭代使用搜索工具收集信息（本例中是 2025 年的 AI Agent 公司），然后将公司列表返回给主 Agent 以编译最终答案。

Traditional approaches using Retrieval Augmented Generation (RAG) use static retrieval. That is, they fetch some set of chunks that are most similar to an input query and use these chunks to generate a response. In contrast, our architecture uses a multi-step search that dynamically finds relevant information, adapts to new findings, and analyzes results to formulate high-quality answers.

> **译：** 使用检索增强生成（RAG）的传统方法采用静态检索——即获取与输入查询最相似的一组块，用这些块生成响应。相比之下，我们的架构使用多步搜索，动态发现相关信息，适应新发现，并分析结果以构建高质量答案。

![Complete process diagram of the multi-agent Research system workflow](/vibe-reading/images/articles/anthropic-official-multi-agent-research-system/research-process-diagram.png)

## Prompt engineering and evaluations for research agents

Multi-agent systems have key differences from single-agent systems, including a rapid growth in coordination complexity. Early agents made errors like spawning 50 subagents for simple queries, scouring the web endlessly for nonexistent sources, and distracting each other with excessive updates. Since each agent is steered by a prompt, prompt engineering was our primary lever for improving these behaviors. Below are some principles we learned for prompting agents:

> **译：** 多 Agent 系统与单 Agent 系统有关键差异，包括协调复杂性的快速增长。早期 Agent 会犯诸如为简单查询生成 50 个子 Agent、无休止地在网络上搜索不存在的来源、以及用过多更新互相干扰等错误。由于每个 Agent 由 prompt 驱动，prompt 工程是我们改进这些行为的主要杠杆。以下是我们学到的 prompt Agent 原则：

1. **Think like your agents.** To iterate on prompts, you must understand their effects. To help us do this, we built simulations using our Console with the exact prompts and tools from our system, then watched agents work step-by-step. This immediately revealed failure modes: agents continuing when they already had sufficient results, using overly verbose search queries, or selecting incorrect tools. Effective prompting relies on developing an accurate mental model of the agent, which can make the most impactful changes obvious.

   > **译：** 1. **像你的 Agent 一样思考。** 要迭代 prompt，你必须理解它们的效果。为此，我们使用 Console 构建了模拟环境，配置与系统完全相同的 prompt 和工具，然后逐步观察 Agent 工作。这立即暴露了失败模式：Agent 在已有足够结果时继续搜索、使用过于冗长的搜索查询、或选择错误的工具。有效的 prompt 工程依赖于建立对 Agent 的准确心智模型，这能让最具影响力的改进变得显而易见。

2. **Teach the orchestrator how to delegate.** In our system, the lead agent decomposes queries into subtasks and describes them to subagents. Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries. Without detailed task descriptions, agents duplicate work, leave gaps, or fail to find necessary information. We started by allowing the lead agent to give simple, short instructions like 'research the semiconductor shortage,' but found these instructions often were vague enough that subagents misinterpreted the task or performed the exact same searches as other agents. For instance, one subagent explored the 2021 automotive chip crisis while 2 others duplicated work investigating current 2025 supply chains, without an effective division of labor.

   > **译：** 2. **教会 orchestrator 如何委派。** 在我们的系统中，主 Agent 将查询分解为子任务并描述给子 Agent。每个子 Agent 需要一个目标、输出格式、工具和来源使用指南，以及清晰的任务边界。没有详细的任务描述，Agent 会重复工作、留下缺口或无法找到必要信息。我们最初允许主 Agent 给出简单的短指令如"研究半导体短缺"，但发现这些指令往往过于模糊，子 Agent 会误解任务或与其他 Agent 执行完全相同的搜索。例如，一个子 Agent 探索 2021 年汽车芯片危机，而另外两个子 Agent 重复调查 2025 年的供应链，没有有效的分工。

3. **Scale effort to query complexity.** Agents struggle to judge appropriate effort for different tasks, so we embedded scaling rules in the prompts. Simple fact-finding requires just 1 agent with 3-10 tool calls, direct comparisons might need 2-4 subagents with 10-15 calls each, and complex research might use more than 10 subagents with clearly divided responsibilities. These explicit guidelines help the lead agent allocate resources efficiently and prevent overinvestment in simple queries, which was a common failure mode in our early versions.

   > **译：** 3. **根据查询复杂度调整投入。** Agent 难以判断不同任务的适当投入，所以我们在 prompt 中嵌入了扩展规则。简单的事实查找只需 1 个 Agent 和 3-10 次工具调用；直接比较可能需要 2-4 个子 Agent，每个 10-15 次调用；复杂研究可能使用超过 10 个子 Agent，职责明确划分。这些显式指南帮助主 Agent 高效分配资源，防止在简单查询上过度投入——这是早期版本中常见的失败模式。

4. **Tool design and selection are critical.** Agent-tool interfaces are as critical as human-computer interfaces. Using the right tool is efficient—often, it's strictly necessary. For instance, an agent searching the web for context that only exists in Slack is doomed from the start. With MCP servers that give the model access to external tools, this problem compounds, as agents encounter unseen tools with descriptions of wildly varying quality. We gave our agents explicit heuristics: for example, examine all available tools first, match tool usage to user intent, search the web for broad external exploration, or prefer specialized tools over generic ones. Bad tool descriptions can send agents down completely wrong paths, so each tool needs a distinct purpose and a clear description.

   > **译：** 4. **工具设计和选择至关重要。** Agent-工具接口与人机接口同样关键。使用正确的工具是高效的——通常也是必需的。例如，在网络上搜索只存在于 Slack 中的上下文，从一开始就注定失败。随着 MCP 服务器为模型提供外部工具访问，这个问题更加复杂——Agent 会遇到描述质量参差不齐的未知工具。我们给 Agent 提供了显式启发式规则：例如，先检查所有可用工具，将工具使用与用户意图匹配，搜索网络进行广泛的外部探索，或优先使用专用工具而非通用工具。糟糕的工具描述会让 Agent 走上完全错误的道路，所以每个工具都需要明确的目的和清晰的描述。

5. **Let agents improve themselves.** We found that the Claude 4 models can be excellent prompt engineers. When given a prompt and a failure mode, they are able to diagnose why the agent is failing and suggest improvements. We even created a tool-testing agent—when given a flawed MCP tool, it attempts to use the tool and then rewrites the tool description to avoid failures. By testing the tool dozens of times, this agent found key nuances and bugs. This process for improving tool ergonomics resulted in a 40% decrease in task completion time for future agents using the new description, because they were able to avoid most mistakes.

   > **译：** 5. **让 Agent 自我改进。** 我们发现 Claude 4 模型可以成为优秀的 prompt 工程师。当给定 prompt 和失败模式时，它们能诊断 Agent 失败的原因并提出改进建议。我们甚至创建了一个工具测试 Agent——当给定一个有缺陷的 MCP 工具时，它会尝试使用该工具，然后重写工具描述以避免失败。通过数十次测试工具，这个 Agent 发现了关键的细节和 bug。这种改进工具人体工程学的过程使使用新描述的后续 Agent 任务完成时间减少了 40%，因为它们能够避免大多数错误。

6. **Start wide, then narrow down.** Search strategy should mirror expert human research: explore the landscape before drilling into specifics. Agents often default to overly long, specific queries that return few results. We counteracted this tendency by prompting agents to start with short, broad queries, evaluate what's available, then progressively narrow focus.

   > **译：** 6. **先广后窄。** 搜索策略应模仿专家级人类研究：先探索全貌再深入细节。Agent 往往默认使用过长、过于具体的查询，返回很少结果。我们通过提示 Agent 从简短、宽泛的查询开始，评估可用内容，然后逐步缩小焦点来抵消这种倾向。

7. **Guide the thinking process.** Extended thinking mode, which leads Claude to output additional tokens in a visible thinking process, can serve as a controllable scratchpad. The lead agent uses thinking to plan its approach, assessing which tools fit the task, determining query complexity and subagent count, and defining each subagent's role. Our testing showed that extended thinking improved instruction-following, reasoning, and efficiency. Subagents also plan, then use interleaved thinking after tool results to evaluate quality, identify gaps, and refine their next query. This makes subagents more effective in adapting to any task.

   > **译：** 7. **引导思考过程。** 扩展思考模式（引导 Claude 在可见的思考过程中输出额外 token）可作为可控的草稿本。主 Agent 使用思考来规划方法——评估哪些工具适合任务、确定查询复杂度和子 Agent 数量、定义每个子 Agent 的角色。我们的测试表明，扩展思考改善了指令遵循、推理和效率。子 Agent 也会规划，然后在工具结果后使用交错思考来评估质量、识别差距并优化下一次查询。这使子 Agent 在适应任何任务时更加有效。

8. **Parallel tool calling transforms speed and performance.** Complex research tasks naturally involve exploring many sources. Our early agents executed sequential searches, which was painfully slow. For speed, we introduced two kinds of parallelization: (1) the lead agent spins up 3-5 subagents in parallel rather than serially; (2) the subagents use 3+ tools in parallel. These changes cut research time by up to 90% for complex queries, allowing Research to do more work in minutes instead of hours while covering more information than other systems.

   > **译：** 8. **并行工具调用变革速度和性能。** 复杂研究任务自然涉及探索许多来源。我们早期的 Agent 执行顺序搜索，速度慢得令人痛苦。为了提速，我们引入了两种并行化：(1) 主 Agent 并行启动 3-5 个子 Agent 而非串行；(2) 子 Agent 并行使用 3+ 个工具。这些更改将复杂查询的研究时间最多减少 90%，使 Research 能在几分钟而非几小时内完成更多工作，同时覆盖比其他系统更多的信息。

Our prompting strategy focuses on instilling good heuristics rather than rigid rules. We studied how skilled humans approach research tasks and encoded these strategies in our prompts—strategies like decomposing difficult questions into smaller tasks, carefully evaluating the quality of sources, adjusting search approaches based on new information, and recognizing when to focus on depth (investigating one topic in detail) vs. breadth (exploring many topics in parallel). We also proactively mitigated unintended side effects by setting explicit guardrails to prevent the agents from spiraling out of control. Finally, we focused on a fast iteration loop with observability and test cases.

> **译：** 我们的 prompt 策略专注于灌输良好的启发式规则而非僵化的规则。我们研究了熟练的人类如何处理研究任务，并将这些策略编码到 prompt 中——诸如将困难问题分解为更小的任务、仔细评估来源质量、根据新信息调整搜索方法、以及识别何时聚焦深度（深入调查一个主题）vs. 广度（并行探索多个主题）等策略。我们还通过设置显式护栏来主动缓解意外副作用，防止 Agent 失控。最后，我们专注于带有可观测性和测试用例的快速迭代循环。

## Effective evaluation of agents

Good evaluations are essential for building reliable AI applications, and agents are no different. However, evaluating multi-agent systems presents unique challenges. Traditional evaluations often assume that the AI follows the same steps each time: given input X, the system should follow path Y to produce output Z. But multi-agent systems don't work this way. Even with identical starting points, agents might take completely different valid paths to reach their goal. One agent might search three sources while another searches ten, or they might use different tools to find the same answer. Because we don't always know what the right steps are, we usually can't just check if agents followed the "correct" steps we prescribed in advance. Instead, we need flexible evaluation methods that judge whether agents achieved the right outcomes while also following a reasonable process.

> **译：** 良好的评估对于构建可靠的 AI 应用至关重要，Agent 也不例外。然而，评估多 Agent 系统面临独特挑战。传统评估通常假设 AI 每次遵循相同步骤：给定输入 X，系统应遵循路径 Y 产生输出 Z。但多 Agent 系统并非如此运作。即使起点相同，Agent 可能采取完全不同的有效路径来达到目标。一个 Agent 可能搜索三个来源而另一个搜索十个，或它们可能使用不同工具找到相同答案。因为我们不总是知道正确的步骤是什么，通常无法检查 Agent 是否遵循了我们预设的"正确"步骤。相反，我们需要灵活的评估方法，判断 Agent 是否达到了正确的结果，同时遵循了合理的流程。

**Start evaluating immediately with small samples.** In early agent development, changes tend to have dramatic impacts because there is abundant low-hanging fruit. A prompt tweak might boost success rates from 30% to 80%. With effect sizes this large, you can spot changes with just a few test cases. We started with a set of about 20 queries representing real usage patterns. Testing these queries often allowed us to clearly see the impact of changes. We often hear that AI developer teams delay creating evals because they believe that only large evals with hundreds of test cases are useful. However, it's best to start with small-scale testing right away with a few examples, rather than delaying until you can build more thorough evals.

> **译：** **立即用小样本开始评估。** 在早期 Agent 开发中，变更往往产生巨大影响，因为有大量唾手可得的改进。一个 prompt 调整可能将成功率从 30% 提升到 80%。在如此大的效果量下，你只需几个测试用例就能发现变更。我们从约 20 个代表真实使用模式的查询开始。测试这些查询通常能让我们清楚地看到变更的影响。我们经常听说 AI 开发团队推迟创建评估，因为他们认为只有包含数百个测试用例的大型评估才有用。然而，最好立即用几个例子开始小规模测试，而不是等到能构建更全面评估时才行动。

**LLM-as-judge evaluation scales when done well.** Research outputs are difficult to evaluate programmatically, since they are free-form text and rarely have a single correct answer. LLMs are a natural fit for grading outputs. We used an LLM judge that evaluated each output against criteria in a rubric: factual accuracy (do claims match sources?), citation accuracy (do the cited sources match the claims?), completeness (are all requested aspects covered?), source quality (did it use primary sources over lower-quality secondary sources?), and tool efficiency (did it use the right tools a reasonable number of times?). We experimented with multiple judges to evaluate each component, but found that a single LLM call with a single prompt outputting scores from 0.0-1.0 and a pass-fail grade was the most consistent and aligned with human judgements. This method was especially effective when the eval test cases did have a clear answer, and we could use the LLM judge to simply check if the answer was correct (i.e. did it accurately list the pharma companies with the top 3 largest R&D budgets?). Using an LLM as a judge allowed us to scalably evaluate hundreds of outputs.

> **译：** **LLM 作为评判者的评估在做得好时可以扩展。** 研究输出难以通过编程评估，因为它们是自由格式文本，很少有唯一正确答案。LLM 天然适合对输出评分。我们使用 LLM 评判器，根据评分标准评估每个输出：事实准确性（声明是否与来源匹配？）、引用准确性（引用的来源是否与声明匹配？）、完整性（是否覆盖了所有请求的方面？）、来源质量（是否使用一手来源而非低质量的二手来源？）和工具效率（是否以合理的次数使用正确的工具？）。我们尝试了多个评判器来评估每个组件，但发现使用单次 LLM 调用和单个 prompt 输出 0.0-1.0 的分数及通过/不通过评级最为一致，且与人类判断最为吻合。这种方法在评估测试用例确实有明确答案时特别有效——我们可以用 LLM 评判器简单地检查答案是否正确（例如，它是否准确列出了研发预算前三大的制药公司？）。使用 LLM 作为评判器使我们能够可扩展地评估数百个输出。

**Human evaluation catches what automation misses.** People testing agents find edge cases that evals miss. These include hallucinated answers on unusual queries, system failures, or subtle source selection biases. In our case, human testers noticed that our early agents consistently chose SEO-optimized content farms over authoritative but less highly-ranked sources like academic PDFs or personal blogs. Adding source quality heuristics to our prompts helped resolve this issue. Even in a world of automated evaluations, manual testing remains essential.

> **译：** **人工评估能捕获自动化遗漏的问题。** 测试 Agent 的人会发现评估遗漏的边缘案例，包括异常查询上的幻觉答案、系统故障或微妙的来源选择偏差。在我们的案例中，人工测试者注意到早期 Agent 始终选择 SEO 优化的内容农场，而非权威但排名较低的来源如学术 PDF 或个人博客。在 prompt 中添加来源质量启发式规则有助于解决此问题。即使在一个自动化评估的世界里，手动测试仍然不可或缺。

Multi-agent systems have emergent behaviors, which arise without specific programming. For instance, small changes to the lead agent can unpredictably change how subagents behave. Success requires understanding interaction patterns, not just individual agent behavior. Therefore, the best prompts for these agents are not just strict instructions, but frameworks for collaboration that define the division of labor, problem-solving approaches, and effort budgets. Getting this right relies on careful prompting and tool design, solid heuristics, observability, and tight feedback loops. See the open-source prompts in our [Cookbook](https://platform.claude.com/cookbook/patterns-agents-basic-workflows) for example prompts from our system.

> **译：** 多 Agent 系统具有涌现行为——这些行为无需特定编程就会出现。例如，对主 Agent 的小改动可能不可预测地改变子 Agent 的行为。成功需要理解交互模式，而不仅仅是个体 Agent 行为。因此，这些 Agent 的最佳 prompt 不仅仅是严格的指令，而是定义分工、问题解决方法和投入预算的协作框架。做好这一点依赖于精心设计的 prompt 和工具、可靠的启发式规则、可观测性和紧密的反馈循环。参见我们 [Cookbook](https://platform.claude.com/cookbook/patterns-agents-basic-workflows) 中的开源 prompt，了解我们系统的示例 prompt。

## Production reliability and engineering challenges

In traditional software, a bug might break a feature, degrade performance, or cause outages. In agentic systems, minor changes cascade into large behavioral changes, which makes it remarkably difficult to write code for complex agents that must maintain state in a long-running process.

> **译：** 在传统软件中，一个 bug 可能破坏一个功能、降低性能或导致中断。在 Agent 系统中，微小的变更会级联成巨大的行为变化，这使得为必须在长时间运行过程中维护状态的复杂 Agent 编写代码变得非常困难。

**Agents are stateful and errors compound.** Agents can run for long periods of time, maintaining state across many tool calls. This means we need to durably execute code and handle errors along the way. Without effective mitigations, minor system failures can be catastrophic for agents. When errors occur, we can't just restart from the beginning: restarts are expensive and frustrating for users. Instead, we built systems that can resume from where the agent was when the errors occurred. We also use the model's intelligence to handle issues gracefully: for instance, letting the agent know when a tool is failing and letting it adapt works surprisingly well. We combine the adaptability of AI agents built on Claude with deterministic safeguards like retry logic and regular checkpoints.

> **译：** **Agent 是有状态的，错误会叠加。** Agent 可以长时间运行，跨多次工具调用维护状态。这意味着我们需要持久化执行代码并沿途处理错误。没有有效的缓解措施，微小的系统故障对 Agent 可能是灾难性的。当错误发生时，我们不能从头重启——重启对用户来说既昂贵又令人沮丧。相反，我们构建了能从错误发生时 Agent 所在位置恢复的系统。我们还利用模型的智能来优雅地处理问题：例如，让 Agent 知道工具何时失败并让它适应，效果出奇地好。我们将基于 Claude 的 AI Agent 的适应性与确定性保障措施（如重试逻辑和定期检查点）相结合。

**Debugging benefits from new approaches.** Agents make dynamic decisions and are non-deterministic between runs, even with identical prompts. This makes debugging harder. For instance, users would report agents "not finding obvious information," but we couldn't see why. Were the agents using bad search queries? Choosing poor sources? Hitting tool failures? Adding full production tracing let us diagnose why agents failed and fix issues systematically. Beyond standard observability, we monitor agent decision patterns and interaction structures—all without monitoring the contents of individual conversations, to maintain user privacy. This high-level observability helped us diagnose root causes, discover unexpected behaviors, and fix common failures.

> **译：** **调试得益于新方法。** Agent 做动态决策，即使使用相同 prompt，不同运行之间也是非确定性的。这使得调试更加困难。例如，用户报告 Agent"找不到明显的信息"，但我们无法看到原因。是 Agent 使用了糟糕的搜索查询？选择了差的来源？还是遇到了工具故障？添加完整的生产追踪让我们能诊断 Agent 失败的原因并系统地修复问题。除标准可观测性外，我们监控 Agent 决策模式和交互结构——所有这些都不监控单个对话的内容，以维护用户隐私。这种高层可观测性帮助我们诊断根因、发现意外行为并修复常见故障。

**Deployment needs careful coordination.** Agent systems are highly stateful webs of prompts, tools, and execution logic that run almost continuously. This means that whenever we deploy updates, agents might be anywhere in their process. We therefore need to prevent our well-meaning code changes from breaking existing agents. We can't update every agent to the new version at the same time. Instead, we use rainbow deployments to avoid disrupting running agents, by gradually shifting traffic from old to new versions while keeping both running simultaneously.

> **译：** **部署需要精心协调。** Agent 系统是高度有状态的 prompt、工具和执行逻辑网络，几乎持续运行。这意味着每当我们部署更新时，Agent 可能处于其流程的任何位置。因此，我们需要防止善意的代码变更破坏现有 Agent。我们不能同时将每个 Agent 更新到新版本。相反，我们使用彩虹部署（rainbow deployments）来避免中断运行中的 Agent——通过逐步将流量从旧版本转移到新版本，同时保持两者并行运行。

**Synchronous execution creates bottlenecks.** Currently, our lead agents execute subagents synchronously, waiting for each set of subagents to complete before proceeding. This simplifies coordination, but creates bottlenecks in the information flow between agents. For instance, the lead agent can't steer subagents, subagents can't coordinate, and the entire system can be blocked while waiting for a single subagent to finish searching. Asynchronous execution would enable additional parallelism: agents working concurrently and creating new subagents when needed. But this asynchronicity adds challenges in result coordination, state consistency, and error propagation across the subagents. As models can handle longer and more complex research tasks, we expect the performance gains will justify the complexity.

> **译：** **同步执行制造瓶颈。** 目前，我们的主 Agent 同步执行子 Agent——等待每组子 Agent 完成后再继续。这简化了协调，但在 Agent 之间的信息流中制造了瓶颈。例如，主 Agent 无法引导子 Agent，子 Agent 之间无法协调，整个系统可能在等待单个子 Agent 完成搜索时被阻塞。异步执行将实现额外的并行化：Agent 并发工作并在需要时创建新子 Agent。但这种异步性在结果协调、状态一致性和跨子 Agent 的错误传播方面增加了挑战。随着模型能够处理更长更复杂的研究任务，我们期望性能提升将证明复杂性的合理性。

## Conclusion

When building AI agents, the last mile often becomes most of the journey. Codebases that work on developer machines require significant engineering to become reliable production systems. The compound nature of errors in agentic systems means that minor issues for traditional software can derail agents entirely. One step failing can cause agents to explore entirely different trajectories, leading to unpredictable outcomes. For all the reasons described in this post, the gap between prototype and production is often wider than anticipated.

> **译：** 构建 AI Agent 时，最后一英里往往成为旅程的大部分。在开发者机器上运行的代码库需要大量工程才能成为可靠的生产系统。Agent 系统中错误的叠加性意味着，对传统软件来说是微小问题的东西可能完全使 Agent 偏离轨道。一个步骤失败可能导致 Agent 探索完全不同的轨迹，导致不可预测的结果。由于本文所述的所有原因，原型和生产之间的差距往往比预期的更大。

Despite these challenges, multi-agent systems have proven valuable for open-ended research tasks. Users have said that Claude helped them find business opportunities they hadn't considered, navigate complex healthcare options, resolve thorny technical bugs, and save up to days of work by uncovering research connections they wouldn't have found alone. Multi-agent research systems can operate reliably at scale with careful engineering, comprehensive testing, detail-oriented prompt and tool design, robust operational practices, and tight collaboration between research, product, and engineering teams who have a strong understanding of current agent capabilities. We're already seeing these systems transform how people solve complex problems.

> **译：** 尽管有这些挑战，多 Agent 系统已证明对开放式研究任务很有价值。用户表示 Claude 帮助他们发现了未曾考虑的商业机会、导航复杂的医疗保健选项、解决棘手的技术 bug，并通过揭示他们独自无法发现的研究关联节省了数天的工作。多 Agent 研究系统可以通过精心工程、全面测试、注重细节的 prompt 和工具设计、稳健的运维实践，以及研究、产品和工程团队之间的紧密协作（这些团队对当前 Agent 能力有深刻理解），在大规模上可靠运行。我们已经看到这些系统正在改变人们解决复杂问题的方式。

![Clio embedding plot showing common Research use cases: software systems, professional/technical content, business growth strategies, academic research, and verifying information](/vibe-reading/images/articles/anthropic-official-multi-agent-research-system/clio-use-cases.png)

## Acknowlegements[^err]

Written by Jeremy Hadfield, Barry Zhang, Kenneth Lien, Florian Scholz, Jeremy Fox, and Daniel Ford. This work reflects the collective efforts of several teams across Anthropic who made the Research feature possible. Special thanks go to the Anthropic apps engineering team, whose dedication brought this complex multi-agent system to production. We're also grateful to our early users for their excellent feedback.

> **译：** 由 Jeremy Hadfield、Barry Zhang、Kenneth Lien、Florian Scholz、Jeremy Fox 和 Daniel Ford 撰写。这项工作反映了 Anthropic 多个团队的集体努力，他们使 Research 功能成为可能。特别感谢 Anthropic 应用工程团队，他们的奉献将这个复杂的多 Agent 系统推向生产。我们也感谢早期用户的出色反馈。

[^err]: 原文节标题为 "Acknowlegements"，疑为 "Acknowledgements" 之笔误，原文如此。

## Appendix

Below are some additional miscellaneous tips for multi-agent systems.

> **译：** 以下是多 Agent 系统的一些额外杂项提示。

**End-state evaluation of agents that mutate state over many turns.** Evaluating agents that modify persistent state across multi-turn conversations presents unique challenges. Unlike read-only research tasks, each action can change the environment for subsequent steps, creating dependencies that traditional evaluation methods struggle to handle. We found success focusing on end-state evaluation rather than turn-by-turn analysis. Instead of judging whether the agent followed a specific process, evaluate whether it achieved the correct final state. This approach acknowledges that agents may find alternative paths to the same goal while still ensuring they deliver the intended outcome. For complex workflows, break evaluation into discrete checkpoints where specific state changes should have occurred, rather than attempting to validate every intermediate step.

> **译：** **对多轮变更状态的 Agent 进行终态评估。** 评估在多轮对话中修改持久状态的 Agent 面临独特挑战。与只读研究任务不同，每个动作都会改变后续步骤的环境，创建传统评估方法难以处理的依赖关系。我们发现专注于终态评估而非逐轮分析是成功的。不是判断 Agent 是否遵循了特定流程，而是评估它是否达到了正确的最终状态。这种方法承认 Agent 可能找到通往同一目标的替代路径，同时仍确保它们交付了预期的结果。对于复杂工作流，将评估分解为离散的检查点——特定的状态变更应该在这些点发生——而不是试图验证每个中间步骤。

**Long-horizon conversation management.** Production agents often engage in conversations spanning hundreds of turns, requiring careful context management strategies. As conversations extend, standard context windows become insufficient, necessitating intelligent compression and memory mechanisms. We implemented patterns where agents summarize completed work phases and store essential information in external memory before proceeding to new tasks. When context limits approach, agents can spawn fresh subagents with clean contexts while maintaining continuity through careful handoffs. Further, they can retrieve stored context like the research plan from their memory rather than losing previous work when reaching the context limit. This distributed approach prevents context overflow while preserving conversation coherence across extended interactions.

> **译：** **长程对话管理。** 生产 Agent 经常进行跨越数百轮的对话，需要精心设计的上下文管理策略。随着对话延长，标准上下文窗口变得不够用，需要智能压缩和记忆机制。我们实现了这样的模式：Agent 在进入新任务之前，总结已完成的工作阶段并将重要信息存储在外部记忆中。当上下文限制逼近时，Agent 可以生成具有干净上下文的新子 Agent，同时通过精心设计的交接保持连续性。此外，它们可以从记忆中检索存储的上下文（如研究计划），而不是在达到上下文限制时丢失之前的工作。这种分布式方法防止了上下文溢出，同时在扩展交互中保持对话连贯性。

**Subagent output to a filesystem to minimize the 'game of telephone.'** Direct subagent outputs can bypass the main coordinator for certain types of results, improving both fidelity and performance. Rather than requiring subagents to communicate everything through the lead agent, implement artifact systems where specialized agents can create outputs that persist independently. Subagents call tools to store their work in external systems, then pass lightweight references back to the coordinator. This prevents information loss during multi-stage processing and reduces token overhead from copying large outputs through conversation history. The pattern works particularly well for structured outputs like code, reports, or data visualizations where the subagent's specialized prompt produces better results than filtering through a general coordinator.

> **译：** **子 Agent 输出到文件系统以最小化"传话游戏"。** 对于某些类型的结果，子 Agent 的直接输出可以绕过主协调器，同时改善保真度和性能。不要要求子 Agent 通过主 Agent 传递所有信息，而是实现工件系统（artifact systems），让专业化 Agent 创建独立持久化的输出。子 Agent 调用工具将工作存储在外部系统中，然后将轻量级引用传回给协调器。这防止了多阶段处理中的信息丢失，并减少了通过对话历史复制大输出的 token 开销。这种模式对结构化输出（如代码、报告或数据可视化）特别有效——在这些场景中，子 Agent 的专业化 prompt 比通过通用协调器过滤产生更好的结果。

## 相关阅读

- [Building effective agents](/vibe-reading/articles/anthropic-official-building-effective-agents) — 同为 Anthropic 工程团队出品，从增强型 LLM 出发介绍五种工作流模式（prompt chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer）及自主 agent 设计原则，本文的 multi-agent Research 系统正是 orchestrator-workers 模式的生产级实践。
- [靠这10个优化点，我们把Multi-Agent工作流成本降了50%以上](/vibe-reading/articles/AI/Agent/Harness-Engineering/Blogs/tencent-blogs-multi-agent-cost-optimization) — 腾讯团队的多 Agent 工作流 token 成本优化实践，与本文互为补充：本文讲架构设计与评估，该文讲成本治理与上下文工程。
- [Generative Agents: Interactive Simulacra of Human Behavior](/vibe-reading/articles/generative-agents) — Stanford 的多 Agent 社会模拟论文，探索 25 个 agent 在沙盒中涌现的信息扩散、关系形成与协作，从学术视角补充本文的工程视角。
