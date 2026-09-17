---
title: "Demystifying evals for AI agents"
source:
  type: "article"
  project: "Anthropic"
  url: "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents"
  author: "Mikaela Grace, Jeremy Hadfield, Rodrigo Olivares, Jiri De Jonghe"
  site: "Anthropic Engineering"
date: "2026-09-14T17:40:00+08:00"
category: [AI, Agent, Evaluation, Anthropic, Official]
contentType: "Blogs"
tags: ["Anthropic", "Agent 评测", "Evals", "Graders", "pass@k", "LLM-as-judge", "Benchmark"]
description: "The capabilities that make agents useful also make them difficult to evaluate. The strategies that work across deployments combine techniques to match the complexity of the systems they measure."
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) · **作者** Mikaela Grace, Jeremy Hadfield, Rodrigo Olivares, Jiri De Jonghe · **来源** Anthropic Engineering · **原文发布** 2026-01-09 · **中英对照·AI 译** 2026-09-14
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

## Introduction

Good evaluations help teams ship AI agents more confidently. Without them, it's easy to get stuck in reactive loops—catching issues only in production, where fixing one failure creates others. Evals make problems and behavioral changes visible before they affect users, and their value compounds over the lifecycle of an agent.

> **译：** 良好的评测（eval）帮助团队更自信地发布 AI agent。没有评测，团队很容易陷入被动循环——只有在生产环境里才发现问题，而修复一个失败又会引入新的失败。评测让问题和行为变化在影响用户之前就变得可见，其价值会在 agent 的整个生命周期中不断复利累积。

As we described in [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), agents operate over many turns: calling tools, modifying state, and adapting based on intermediate results. These same capabilities that make AI agents useful—autonomy, intelligence, and flexibility—also make them harder to evaluate.

> **译：** 正如我们在 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 中所述，agent 在多轮交互中运行：调用工具、修改状态，并根据中间结果进行调整。正是这些让 AI agent 变得有用的能力——自主性、智能性和灵活性——也让它们更难被评测。

Through our internal work and with customers at the frontier of agent development, we've learned how to design more rigorous and useful evals for agents. Here's what's worked across a range of agent architectures and use cases in real-world deployment.

> **译：** 通过内部工作以及与处于 agent 开发前沿的客户合作，我们学会了如何为 agent 设计更严谨、更有用的评测。以下是我们在真实部署中、跨多种 agent 架构和用例验证有效的经验。

## The structure of an evaluation

An **evaluation** ("eval") is a test for an AI system: give an AI an input, then apply grading logic to its output to measure success. In this post, we focus on **automated evals** that can be run during development without real users.

> **译：** 一次**评测**（evaluation，简称 "eval"）是针对 AI 系统的测试：给 AI 一个输入，然后对其输出应用评分逻辑来衡量是否成功。本文聚焦**自动化评测**——在开发阶段无需真实用户即可运行的评测。

**Single-turn evaluations** are straightforward: a prompt, a response, and grading logic. For earlier LLMs, single-turn, non-agentic evals were the main evaluation method. As AI capabilities have advanced, **multi-turn evaluations** have become increasingly common.

> **译：** **单轮评测**很简单直接：一个 prompt、一个回复、一套评分逻辑。对早期 LLM 而言，单轮、非 agent 式的评测是主要的评测方法。随着 AI 能力的进步，**多轮评测**变得越来越普遍。

![In a simple eval, an agent processes a prompt, and a grader checks if the output matches expectations. For a more complex multi-turn eval, a coding agent receives tools, a task (building an MCP server in this case), and an environment, executes an "agent loop" (tool calls and reasoning), and updates the environment with the implementation. Grading then uses unit tests to verify the working MCP server.](/vibe-reading/images/articles/anthropic-official-demystifying-evals-for-ai-agents/simple-vs-multiturn-eval.png)

**Agent evaluations** are even more complex. Agents use tools across many turns, modifying state in the environment and adapting as they go—which means mistakes can propagate and compound. Frontier models can also find creative solutions that surpass the limits of static evals. For instance, Opus 4.5 solved a [𝜏2-bench](https://github.com/sierra-research/tau2-bench) problem about booking a flight by [discovering](https://www.anthropic.com/news/claude-opus-4-5) a loophole in the policy. It "failed" the evaluation as written, but actually came up with a better solution for the user.

> **译：** **Agent 评测**则更加复杂。Agent 会在多轮交互中使用工具、修改环境状态并随时调整——这意味着错误会传播和叠加。前沿模型还可能找到超越静态评测上限的创造性解法。例如，Opus 4.5 在解一道 [𝜏2-bench](https://github.com/sierra-research/tau2-bench) 订机票的题目时[发现](https://www.anthropic.com/news/claude-opus-4-5)了政策里的一个漏洞。按字面标准它"没通过"评测，但实际上它给出了对用户更好的解决方案。

When building agent evaluations, we use the following definitions:

> **译：** 构建 agent 评测时，我们使用以下定义：

A **task** (a.k.a **problem** or **test case**) is a single test with defined inputs and success criteria.

> **译：** **任务**（task，也称 problem 或 test case）是一次具有明确输入和成功标准的单个测试。

Each attempt at a task is a **trial**. Because model outputs vary between runs, we run multiple trials to produce more consistent results.

> **译：** 对任务的每一次尝试称为一次**试验**（trial）。由于模型输出在不同运行之间会变化，我们会运行多次试验以获得更稳定的结果。

A **grader** is logic that scores some aspect of the agent's performance. A task can have multiple graders, each containing multiple assertions (sometimes called **checks**).

> **译：** **评分器**（grader）是对 agent 表现某个方面进行打分的逻辑。一个任务可以有多个评分器，每个评分器包含多条断言（有时也称 **checks**）。

A **transcript** (also called a **trace** or **trajectory**) is the complete record of a trial, including outputs, tool calls, reasoning, intermediate results, and any other interactions. For the Anthropic API, this is the full messages array at the end of an eval run - containing all the calls to the API and all of the returned responses during the evaluation.

> **译：** **记录**（transcript，也称 trace 或 trajectory）是一次试验的完整记录，包括输出、工具调用、推理过程、中间结果及其他所有交互。对 Anthropic API 而言，这就是评测运行结束时的完整 messages 数组——包含评测期间对 API 的全部调用及全部返回响应。

The **outcome** is the final state in the environment at the end of the trial. A flight-booking agent might say "Your flight has been booked" at the end of the transcript, but the outcome is whether a reservation exists in the environment's SQL database.

> **译：** **结果**（outcome）是试验结束时环境的最终状态。订机票的 agent 可能在记录末尾说"您的航班已预订"，但结果要看环境的 SQL 数据库里是否真的存在一条预订记录。

An **evaluation harness** is the infrastructure that runs evals end-to-end. It provides instructions and tools, runs tasks concurrently, records all the steps, grades outputs, and aggregates results.

> **译：** **评测框架**（evaluation harness）是端到端运行评测的基础设施。它提供指令和工具、并发运行任务、记录所有步骤、为输出评分并汇总结果。

An **agent harness** (or **scaffold**) is the system that enables a model to act as an agent: it processes inputs, orchestrates tool calls, and returns results. When we evaluate "an agent," we're evaluating the harness *and* the model working together. For example, [Claude Code](https://claude.com/product/claude-code) is a flexible agent harness, and we used its core primitives through the [Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) to build our [long-running agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

> **译：** **Agent 框架**（agent harness，或称 scaffold）是让模型以 agent 方式运行的系统：处理输入、编排工具调用并返回结果。当我们评测"一个 agent"时，评测的是框架*与*模型协同工作的整体。例如 [Claude Code](https://claude.com/product/claude-code) 是一个灵活的 agent 框架，我们通过 [Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) 复用其核心原语构建了[长时间运行的 agent 框架](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)。

An **evaluation suite** is a collection of tasks designed to measure specific capabilities or behaviors. Tasks in a suite typically share a broad goal. For instance, a customer support eval suite might test refunds, cancellations, and escalations.

> **译：** **评测套件**（evaluation suite）是旨在衡量特定能力或行为的任务集合。套件中的任务通常共享一个宽泛的目标。例如，一个客服评测套件可能覆盖退款、取消和升级处理。

![Components of evaluations for agents.](/vibe-reading/images/articles/anthropic-official-demystifying-evals-for-ai-agents/eval-components.png)

## Why build evaluations?

When teams first start building agents, they can get surprisingly far through a combination of manual testing, [dogfooding](https://en.wikipedia.org/wiki/Eating_your_own_dog_food), and intuition. More rigorous evaluation may even seem like overhead that slows down shipping. But after the early prototyping stages, once an agent is in production and has started scaling, building without evals starts to break down.

> **译：** 团队刚开始构建 agent 时，靠手工测试、[内部试用](https://en.wikipedia.org/wiki/Eating_your_own_dog_food)（dogfooding）加直觉，往往能走得出乎意料地远。更严谨的评测甚至看起来像是拖慢发布节奏的额外开销。但过了早期原型阶段，一旦 agent 进入生产并开始扩量，没有评测的开发就会开始崩坏。

The breaking point often comes when users report the agent feels worse after changes, and the team is "flying blind" with no way to verify except to guess and check. Absent evals, debugging is reactive: wait for complaints, reproduce manually, fix the bug, and hope nothing else regressed. Teams can't distinguish real regressions from noise, automatically test changes against hundreds of scenarios before shipping, or measure improvements.

> **译：** 崩坏点常常出现在用户反馈"改完之后 agent 变差了"、而团队却在"盲飞"——除了瞎猜再验证没有任何办法。没有评测，调试就是被动的：等投诉、手工复现、修 bug、然后祈祷没把别的东西改坏。团队无法区分真实的退化与噪声，无法在发布前针对几百个场景自动测试变更，也无法度量改进。

We've seen this progression play out many times. For instance, Claude Code started with fast iteration based on feedback from Anthropic employees and external users. Later, we added evals—first for narrow areas like concision and file edits, and then for more complex behaviors like over-engineering. These evals helped identify issues, guide improvements, and focus research-product collaborations. Combined with production monitoring, A/B tests, user research, and more, evals provide signals to continue improving Claude Code as it scales.

> **译：** 这个演变过程我们见过很多次。例如 Claude Code 起初靠 Anthropic 员工和外部用户的反馈快速迭代。后来我们加入了评测——先覆盖简洁性和文件编辑这类窄域，再扩展到过度工程这类更复杂的行为。这些评测帮助定位问题、指引改进方向、聚焦研究与产品团队的协作。结合生产监控、A/B 测试、用户研究等手段，评测为 Claude Code 在规模化过程中持续改进提供了信号。

Writing evals is useful at any stage in the agent lifecycle. Early on, evals force product teams to specify what success means for the agent, while later they help uphold a consistent quality bar.

> **译：** 在 agent 生命周期的任何阶段写评测都有价值。早期，评测迫使产品团队明确"成功"对 agent 意味着什么；后期，评测则帮助守住一致的质量底线。

[Descript](https://www.descript.com/)'s agent helps users edit videos, so they built evals around three dimensions of a successful editing workflow: don't break things, do what I asked, and do it well. They evolved from manual grading to LLM graders with criteria defined by the product team and periodic human calibration, and now regularly run two separate suites for quality benchmarking and regression testing. The [Bolt](https://bolt.new/) AI team started building evals later, after they already had a widely used agent. In 3 months, they built an eval system that runs their agent and grades outputs with static analysis, uses browser agents to test apps, and employs LLM judges for behaviors like instruction following.

> **译：** [Descript](https://www.descript.com/) 的 agent 帮用户剪辑视频，所以他们围绕成功编辑工作流的三个维度构建评测：不搞坏东西、按我的要求做、做得好。他们从人工评分演进到由产品团队定义标准、定期人工校准的 LLM 评分器，如今常规运行两套独立的评测套件，分别做质量基准和回归测试。[Bolt](https://bolt.new/) 的 AI 团队则起步较晚——那时他们的 agent 已被广泛使用。三个月内，他们搭起了一套评测系统：运行 agent 并用静态分析给输出评分、用浏览器 agent 测试应用、用 LLM 裁判评估指令遵循等行为。

Some teams create evals at the start of development; others add them once at scale when evals become a bottleneck for improving the agent. Evals are especially useful at the start of agent development to explicitly encode expected behavior. Two engineers reading the same initial spec could come away with different interpretations on how the AI should handle edge cases. An eval suite resolves this ambiguity. Regardless of when they're created, evals help accelerate development.

> **译：** 有的团队在开发之初就写评测；有的等到规模化后、评测成为改进 agent 的瓶颈时才补上。在 agent 开发之初，评测对显式定义预期行为尤其有用。两位工程师读同一份初始规格文档，对 AI 应如何处理边界情况可能得出不同解读。一套评测套件能消除这种歧义。无论何时创建，评测都能加速开发。

Evals also shape how quickly you can adopt new models. When more powerful models come out, teams without evals face weeks of testing while competitors with evals can quickly determine the model's strengths, tune their prompts, and upgrade in days.

> **译：** 评测还决定你跟进新模型的速度。更强的模型发布时，没有评测的团队要面对数周的测试，而有评测的竞品能快速摸清模型的强项、调好 prompt，几天内完成升级。

Once evals exist, you get baselines and regression tests for free: latency, token usage, cost per task, and error rates can be tracked on a static bank of tasks. Evals can also become the highest-bandwidth communication channel between product and research teams, defining metrics researchers can optimize against. Clearly, evals have wide-ranging benefits beyond tracking regressions and improvements. Their compounding value is easy to miss given that costs are visible upfront while benefits accumulate later.

> **译：** 评测一旦存在，基线和回归测试就是白送的：延迟、token 用量、单任务成本、错误率都可以在一组固定任务上持续追踪。评测还能成为产品团队与研究团队之间带宽最高的沟通渠道，定义出研究人员可以针对性优化的指标。显然，评测的收益远不止追踪回归与改进。成本是一开始就可见的，收益却在后期才累积，因此这种复利价值很容易被低估。

## How to evaluate AI agents

We see several common types of agents deployed at scale today, including coding agents, research agents, computer use agents, and conversational agents. Each type may be deployed across a wide variety of industries, but they can be evaluated using similar techniques. You don't need to invent an evaluation from scratch. The sections below describe proven techniques for several agent types. Use these methods as a foundation, then extend them to your domain.

> **译：** 当前大规模部署的 agent 有几种常见类型：编码 agent、研究 agent、计算机操作 agent 和对话 agent。每类 agent 可能部署在各行各业，但都可以用相似的技术来评测。你不需要从零发明一套评测。下面几节描述了针对几类 agent 的、经过验证的技术。以这些方法为基础，再扩展到你的领域。

### Types of graders for agents

Agent evaluations typically combine three types of graders: code-based, model-based, and human. Each grader evaluates some portion of either the transcript or the outcome. An essential component of effective evaluation design is to choose the right graders for the job.

> **译：** Agent 评测通常组合三类评分器：基于代码的、基于模型的、人工的。每个评分器评估记录或结果的某个部分。有效评测设计的关键一环，是为任务选对评分器。

**Code-based graders**

> **译：** 基于代码的评分器

| Methods | Strengths | Weaknesses |
| --- | --- | --- |
| String match checks (exact, regex, fuzzy, etc.)<br>Binary tests (fail-to-pass, pass-to-pass)<br>Static analysis (lint, type, security)<br>Outcome verification<br>Tool calls verification (tools used, parameters)<br>Transcript analysis (turns taken, token usage) | Fast<br>Cheap<br>Objective<br>Reproducible<br>Easy to debug<br>Verify specific conditions | Brittle to valid variations that don't match expected patterns exactly<br>Lacking in nuance<br>Limited for evaluating some more subjective tasks |

> **译：**
>
> | 方法 | 优势 | 劣势 |
> | --- | --- | --- |
> | 字符串匹配检查（精确、正则、模糊等）<br>二进制测试（fail-to-pass、pass-to-pass）<br>静态分析（lint、类型、安全）<br>结果验证<br>工具调用验证（用了哪些工具、参数）<br>记录分析（轮数、token 用量） | 快<br>便宜<br>客观<br>可复现<br>易调试<br>验证具体条件 | 对不精确匹配预期模式的有效变体过于脆弱<br>缺乏细腻度<br>对一些更主观的任务评估能力有限 |

**Model-based graders**

> **译：** 基于模型的评分器

| Methods | Strengths | Weaknesses |
| --- | --- | --- |
| Rubric-based scoring<br>Natural language assertions<br>Pairwise comparison<br>Reference-based evaluation<br>Multi-judge consensus | Flexible<br>Scalable<br>Captures nuance<br>Handles open-ended tasks<br>Handles freeform output | Non-deterministic<br>More expensive than code<br>Requires calibration with human graders for accuracy |

> **译：**
>
> | 方法 | 优势 | 劣势 |
> | --- | --- | --- |
> | 基于 Rubric 的打分<br>自然语言断言<br>成对比较<br>基于参考答案的评测<br>多裁判共识 | 灵活<br>可规模化<br>能捕捉细微差别<br>处理开放式任务<br>处理自由格式输出 | 非确定性<br>比代码贵<br>需要与人工评分器校准才能保证准确性 |

**Human graders**

> **译：** 人工评分器

| Methods | Strengths | Weaknesses |
| --- | --- | --- |
| SME review<br>Crowdsourced judgment<br>Spot-check sampling<br>A/B testing<br>Inter-annotator agreement | Gold standard quality<br>Matches expert user judgment<br>Used to calibrate model-based graders | Expensive<br>Slow<br>Often requires access to human experts at scale |

> **译：**
>
> | 方法 | 优势 | 劣势 |
> | --- | --- | --- |
> | 领域专家（SME）评审<br>众包判断<br>抽检采样<br>A/B 测试<br>标注者间一致性 | 黄金标准质量<br>匹配专家用户的判断<br>用于校准基于模型的评分器 | 昂贵<br>慢<br>常需要大规模获取人类专家资源 |

For each task, scoring can be weighted (combined grader scores must hit a threshold), binary (all graders must pass), or a hybrid.

> **译：** 对每个任务，打分方式可以是加权制（各评分器得分之和须达到阈值）、二进制制（所有评分器都必须通过），或两者混合。

### Capability vs. regression evals

**Capability or "quality" evals** ask, "What can this agent do well?" They should start at a low pass rate, targeting tasks the agent struggles with and giving teams a hill to climb.

> **译：****能力评测**（capability/quality evals）问的是："这个 agent 能把什么做好？"它们应该从低通过率起步，瞄准 agent 的薄弱环节，给团队一座可以攀登的山。

**Regression evals** ask, "Does the agent still handle all the tasks it used to?" and should have a nearly 100% pass rate. They protect against backsliding, as a decline in score signals that something is broken and needs to be improved. As teams hill-climb on capability evals, it's important to also run regression evals to make sure changes don't cause issues elsewhere.

> **译：****回归评测**（regression evals）问的是："agent 是否还能搞定以前能搞定的所有任务？"其通过率应接近 100%。它们防止能力倒退——分数一下降就说明有东西坏了、需要修复。当团队在能力评测上攀登时，同时运行回归评测很重要，确保变更没有在别处引入问题。

After an agent is launched and optimized, capability evals with high pass rates can "graduate" to become a regression suite that is run continuously to catch any drift. Tasks that once measured "Can we do this at all?" then measure "Can we still do this reliably?"

> **译：** agent 上线并优化之后，通过率已高的能力评测可以"毕业"成回归套件，持续运行以捕捉任何漂移。当初衡量"我们到底能不能做到"的任务，此时衡量的是"我们还能不能稳定做到"。

### Evaluating coding agents

**Coding agents** write, test, and debug code, navigating codebases and running commands much like a human developer. Effective evals for modern coding agents usually rely on well-specified tasks, stable test environments, and thorough tests for the generated code.

> **译：****编码 agent** 编写、测试和调试代码，像人类开发者一样在代码库中导航并执行命令。针对现代编码 agent 的有效评测，通常依赖定义清晰的任务、稳定的测试环境，以及对生成代码的充分测试。

Deterministic graders are natural for coding agents because software is generally straightforward to evaluate: does the code run and do the tests pass? Two widely used coding agent benchmarks, [SWE-bench Verified](https://www.swebench.com/SWE-bench/) and [Terminal-Bench](https://www.tbench.ai/), follow this approach. SWE-bench Verified gives agents GitHub issues from popular Python repositories and grades solutions by running the test suite; a solution passes only if it fixes the failing tests without breaking existing ones. LLMs have progressed from 40% to >80% on this eval in just one year. Terminal-Bench takes a different track: it tests end-to-end technical tasks, such as building a Linux kernel from source or training an ML model.

> **译：** 确定性评分器对编码 agent 是天然之选，因为软件通常不难评测：代码能不能跑、测试过不过？两个广泛使用的编码 agent 基准——[SWE-bench Verified](https://www.swebench.com/SWE-bench/) 和 [Terminal-Bench](https://www.tbench.ai/)——都采用这个思路。SWE-bench Verified 给 agent 流行 Python 仓库的 GitHub issue，通过运行测试套件给方案打分；只有修复了失败的测试且不破坏既有测试才算通过。LLM 在这个评测上的得分仅一年就从 40% 提升到 >80%。Terminal-Bench 走的是另一条路：它测试端到端的技术任务，比如从源码构建 Linux 内核或训练一个 ML 模型。

Once you have a set of pass-or-fail tests for validating the key *outcomes* of a coding task, it's often useful to also grade the transcript. For instance, heuristics-based code quality rules can evaluate the generated code based on more than passing tests, and model-based graders with clear rubrics can assess behaviors like how the agent calls tools or interacts with the user.

> **译：** 有了一套验证编码任务关键*结果*的过/不过测试之后，对记录（transcript）本身评分往往也很有用。例如，基于启发式的代码质量规则可以从"测试通过"之外的角度评估生成的代码；带清晰 rubric 的模型评分器则可以评估 agent 调用工具的方式、与用户交互的方式等行为。

**Example: Theoretical evaluation for a coding agent**

> **译：** 示例：编码 agent 的理论化评测

Consider a coding task where the agent must fix an authentication bypass vulnerability. As shown in the illustrative YAML file below, one could evaluate this agent using both graders and metrics.

> **译：** 考虑一个让 agent 修复认证绕过漏洞的编码任务。如下面示意 YAML 所示，可以用评分器和指标组合来评测这个 agent。

```yaml title="fix-auth-bypass.yaml"
task:
  id: "fix-auth-bypass_1"
  desc: "Fix authentication bypass when password field is empty and ..."
  graders:
    - type: deterministic_tests
      required: [test_empty_pw_rejected.py, test_null_pw_rejected.py]
    - type: llm_rubric
      rubric: prompts/code_quality.md
    - type: static_analysis
      commands: [ruff, mypy, bandit]
    - type: state_check
      expect:
        security_logs: {event_type: "auth_blocked"}
    - type: tool_calls
      required:
        - {tool: read_file, params: {path: "src/auth/*"}}
        - {tool: edit_file}
        - {tool: run_tests}
  tracked_metrics:
    - type: transcript
      metrics:
        - n_turns
        - n_toolcalls
        - n_total_tokens
    - type: latency
      metrics:
        - time_to_first_token
        - output_tokens_per_sec
        - time_to_last_token
```

Note that this example showcases the full range of available graders for illustration. In practice, coding evaluations typically rely on unit tests for correctness verification and an LLM rubric for assessing overall code quality, with additional graders and metrics added only as needed.

> **译：** 注意这个示例是为了展示全部可用评分器而做的示意。实践中，编码评测通常依赖单元测试验证正确性、LLM rubric 评估整体代码质量，其他评分器和指标按需增加。

### Evaluating conversational agents

**Conversational agents** interact with users in domains like support, sales, or coaching. Unlike traditional chatbots, they maintain state, use tools, and take actions mid-conversation. While coding and research agents can also involve many turns of interaction with the user, conversational agents present a distinct challenge: the quality of the interaction itself is part of what you're evaluating. Effective evals for conversational agents usually rely on verifiable end-state outcomes and rubrics that capture both task completion and interaction quality. Unlike most other evals, they often require a second LLM to simulate the user. We use this approach in our [alignment auditing agents](https://alignment.anthropic.com/2025/automated-auditing/) to stress-test models through extended, adversarial conversations.

> **译：****对话 agent** 在客服、销售、教练等领域与用户交互。与传统聊天机器人不同，它们维护状态、使用工具、在对话中途执行动作。虽然编码和研究 agent 也会与用户多轮交互，但对话 agent 带来一个独特的挑战：交互本身的质量就是评测对象的一部分。对话 agent 的有效评测通常依赖可验证的终态结果，以及同时覆盖任务完成度和交互质量的 rubric。与大多数其他评测不同，它们常常需要第二个 LLM 来模拟用户。我们在[对齐审计 agent](https://alignment.anthropic.com/2025/automated-auditing/) 中就用这个方法，通过长时间的对抗性对话对模型做压力测试。

Success for conversational agents can be multidimensional: is the ticket resolved (state check), did it finish in <10 turns (transcript constraint), and was the tone appropriate (LLM rubric)? Two benchmarks that incorporate multidimensionality are [𝜏-Bench](https://arxiv.org/abs/2406.12045) and its successor, [τ2-Bench](https://arxiv.org/abs/2506.07982). These simulate multi-turn interactions across domains like retail support and airline booking, where one model plays a user persona while the agent navigates realistic scenarios.

> **译：** 对话 agent 的成功标准可以是多维的：工单是否解决了（状态检查）、是否在 10 轮内完成（记录约束）、语气是否得体（LLM rubric）？两个体现多维度的基准是 [𝜏-Bench](https://arxiv.org/abs/2406.12045) 及其续作 [τ2-Bench](https://arxiv.org/abs/2506.07982)。它们模拟零售客服、航空订票等领域的多轮交互：一个模型扮演用户角色，agent 则在真实场景中周旋。

**Example: Theoretical evaluation for a conversational agent**

> **译：** 示例：对话 agent 的理论化评测

Consider a support task where the agent must handle a refund for a frustrated customer.

> **译：** 考虑一个客服任务：agent 必须为一位不满的客户处理退款。

```yaml title="support-refund.yaml"
graders:
  - type: llm_rubric
    rubric: prompts/support_quality.md
    assertions:
      - "Agent showed empathy for customer's frustration"
      - "Resolution was clearly explained"
      - "Agent's response grounded in fetch_policy tool results"
  - type: state_check
    expect:
      tickets: {status: resolved}
      refunds: {status: processed}
  - type: tool_calls
    required:
      - {tool: verify_identity}
      - {tool: process_refund, params: {amount: "<=100"}}
      - {tool: send_confirmation}
  - type: transcript
    max_turns: 10
tracked_metrics:
  - type: transcript
    metrics:
      - n_turns
      - n_toolcalls
      - n_total_tokens
  - type: latency
    metrics:
      - time_to_first_token
      - output_tokens_per_sec
      - time_to_last_token
```

As in our coding agent example, this task showcases multiple grader types for illustration. In practice, conversational agent evaluations typically use model-based graders to assess both communication quality and goal completion, because many tasks—like answering a question—may have multiple "correct" solutions.

> **译：** 与编码 agent 示例一样，这个任务为了展示多种评分器类型而做了示意。实践中，对话 agent 评测通常用基于模型的评分器同时评估沟通质量和目标完成度，因为很多任务——比如回答一个问题——可能有多个"正确"解。

### Evaluating research agents

**Research agents** gather, synthesize, and analyze information, then produce outputs like an answer or report. Unlike coding agents where unit tests provide binary pass/fail signals, research quality can only be judged relative to the task. What counts as "comprehensive," "well-sourced," or even "correct" depends on context: a market scan, due diligence for an acquisition, and a scientific report each require different standards.

> **译：****研究 agent** 收集、综合和分析信息，然后产出答案或报告之类的结果。编码 agent 有单元测试提供二元通过/失败信号，研究 agent 则不同：研究质量只能相对于任务来评判。什么算"全面"、"信源充分"甚至"正确"都取决于上下文：市场扫描、并购尽职调查、科研报告各自需要不同的标准。

Research evals face unique challenges: experts may disagree on whether a synthesis is comprehensive, ground truth shifts as reference content changes constantly, and longer, more open-ended outputs create more room for mistakes. A benchmark like [BrowseComp](http://arxiv.org/abs/2504.12516), for example, tests whether AI agents can find needles in haystacks across the open web—questions designed to be easy to verify but hard to solve.

> **译：** 研究评测面临独特挑战：专家之间可能对一份综述是否全面意见不一；参考内容持续变化，真值（ground truth）随之漂移；更长、更开放的输出也留出了更多出错空间。比如 [BrowseComp](http://arxiv.org/abs/2504.12516) 这个基准测试 AI agent 能否在开放网络的大海里捞针——题目设计成易于验证但难以求解。

One strategy to build research agent evals is to combine grader types. Groundedness checks verify that claims are supported by retrieved sources, coverage checks define key facts a good answer must include, and source quality checks confirm the consulted sources are authoritative, rather than simply the first retrieved. For tasks with objectively correct answers ("What was Company X's Q3 revenue?"), exact match works. An LLM can flag unsupported claims and gaps in coverage but also verify the open-ended synthesis for coherence and completeness.

> **译：** 构建研究 agent 评测的一个策略是组合多种评分器。落地性检查（groundedness）验证论断是否有检索到的信源支撑；覆盖度检查定义一个好答案必须包含的关键事实；信源质量检查确认所查信源足够权威，而不只是排在前面的结果。对于有客观正确答案的任务（"X 公司 Q3 营收是多少？"），精确匹配即可。LLM 既能标记缺乏支撑的论断和覆盖缺口，也能对开放式综述做连贯性与完整性校验。

Given the subjective nature of research quality, LLM-based rubrics should be frequently calibrated against expert human judgment to grade these agents effectively.

> **译：** 鉴于研究质量的主观性，基于 LLM 的 rubric 应频繁对照人类专家判断做校准，才能有效评测这类 agent。

### Computer use agents

**Computer use agents** interact with software through the same interface as humans—screenshots, mouse clicks, keyboard inputs, and scrolling—rather than through APIs or code execution. They can use any application with a graphical user interface (GUI), from design tools to legacy enterprise software. Evaluation requires running the agent in a real or sandboxed environment where it can use software applications and checking whether it achieved the intended outcome. For instance, [WebArena](https://arxiv.org/abs/2307.13854) tests browser-based tasks, using URL and page state checks to verify the agent navigated correctly, along with backend state verification for tasks that modify data (confirming an order was actually placed, not just that the confirmation page appeared). [OSWorld](https://os-world.github.io/) extends this to full operating system control, with evaluation scripts that inspect diverse artifacts after task completion: file system state, application configs, database contents, and UI element properties.

> **译：****计算机操作 agent** 通过与人类相同的界面与软件交互——截图、鼠标点击、键盘输入和滚动——而非通过 API 或代码执行。它们可以使用任何带图形界面（GUI）的应用，从设计工具到老旧的企业软件。评测需要在真实或沙箱环境中运行 agent 让它使用软件应用，然后检查是否达成预期结果。例如 [WebArena](https://arxiv.org/abs/2307.13854) 测试浏览器任务，用 URL 和页面状态检查验证 agent 是否正确导航，并对修改数据的任务做后端状态验证（确认订单真的下了，而不只是出现了确认页）。[OSWorld](https://os-world.github.io/) 把这扩展到完整操作系统控制，其评测脚本在任务完成后检查各种痕迹：文件系统状态、应用配置、数据库内容和 UI 元素属性。

Browser use agents require a balance between token efficiency and latency. DOM-based interactions execute quickly but consume many tokens, while screenshot-based interactions are slower but more token-efficient. For example, when asking Claude to summarize Wikipedia, it is more efficient to extract the text from the DOM. When finding a new laptop case on Amazon, it is more efficient to take screenshots (as extracting the entire DOM is token-intensive). In our Claude for Chrome product, we developed evals to check that the agent was selecting the right tool for each context. This enabled us to complete browser-based tasks faster and more accurately.

> **译：** 浏览器操作 agent 需要在 token 效率和延迟之间做平衡。基于 DOM 的交互执行快但耗 token 多；基于截图的交互慢一些但更省 token。例如让 Claude 总结维基百科页面时，从 DOM 提取文本更高效；而在 Amazon 上找一个新笔记本内胆包时，截图更高效（提取整个 DOM 非常耗 token）。在 Claude for Chrome 产品中，我们开发了评测来检查 agent 是否为每个场景选对了工具，这让我们更快、更准确地完成浏览器任务。

### How to think about non-determinism in evaluations for agents

Regardless of agent type, agent behavior varies between runs, which makes evaluation results harder to interpret than they first appear. Each task has its own success rate—maybe 90% on one task, 50% on another—and a task that passed on one eval run might fail on the next. Sometimes, what we want to measure is how *often* (what proportion of the trials) an agent succeeds for a task.

> **译：** 无论哪类 agent，其行为在每次运行之间都有差异，这让评测结果比表面看起来更难解读。每个任务有自己的成功率——这个任务可能是 90%，那个可能是 50%——某次评测通过的任务，下一次可能就失败。有时候，我们真正想衡量的是 agent 在一个任务上*多经常*（试验中的多大比例）成功。

Two metrics help capture this nuance:

> **译：** 两个指标有助于刻画这种细微差别：

[**pass@k**](https://proceedings.neurips.cc/paper/2019/file/7298332f04ac004a0ca44cc69ecf6f6b-Paper.pdf) measures the likelihood that an agent gets at least one correct solution in *k* attempts. As *k* increases, pass@k score rises: more "shots on goal" means higher odds of at least 1 success. A score of 50% pass@1 means that a model succeeds at half the tasks in the eval on its first try. In coding, we're often most interested in the agent finding the solution on the first try—pass@1. In other cases, proposing many solutions is valid as long as one works.

> **译：** [**pass@k**](https://proceedings.neurips.cc/paper/2019/file/7298332f04ac004a0ca44cc69ecf6f6b-Paper.pdf) 衡量 agent 在 *k* 次尝试中至少得到一个正确解的可能性。*k* 越大，pass@k 越高："射门次数"越多，至少命中一次的概率越大。50% 的 pass@1 意味着模型首次尝试就能解决评测中一半的任务。在编码场景，我们往往最关心 agent 第一次就找到解——pass@1。在其他场景，只要有一个可行，提出多个方案也是合法的。

[**pass^k**](https://arxiv.org/abs/2406.12045) measures the probability that *all k* trials succeed. As *k* increases, pass^k falls since demanding consistency across more trials is a harder bar to clear. If your agent has a 75% per-trial success rate and you run 3 trials, the probability of passing all three is (0.75)³ ≈ 42%. This metric especially matters for customer-facing agents where users expect reliable behavior every time.

> **译：** [**pass^k**](https://arxiv.org/abs/2406.12045) 衡量 *k* 次试验全部成功的概率。*k* 越大，pass^k 越低——要求更多试验保持一致是更高的门槛。如果你的 agent 单次成功率 75%，跑 3 次试验，三次全过的概率是 (0.75)³ ≈ 42%。这个指标对面向用户的 agent 尤其重要——用户期望每次都可靠。

![pass@k and pass^k diverge as trials increase. At k=1, they're identical (both equal the per-trial success rate). By k=10, they tell opposite stories: pass@k approaches 100% while pass^k falls to 0%.](/vibe-reading/images/articles/anthropic-official-demystifying-evals-for-ai-agents/pass-at-k-vs-pass-hat-k.png)

Both metrics are useful, and which to use depends on product requirements: pass@k for tools where one success matters, pass^k for agents where consistency is essential.

> **译：** 两个指标都有用，选哪个取决于产品需求：对"一次成功就算数"的工具用 pass@k，对"一致性至关重要"的 agent 用 pass^k。

## Going from zero to one: a roadmap to great evals for agents

This section lays out our practical, field-tested advice for going from no evals to evals you can trust. Think of this as a roadmap for eval-driven agent development: define success early, measure it clearly, and iterate continuously.

> **译：** 本节给出从零到可信评测的、经实战检验的建议。把它当作评测驱动 agent 开发的路线图：尽早定义成功标准，清晰地度量，持续迭代。

### Collect tasks for the initial eval dataset

**Step 0. Start early**

We see teams delay building evals because they think they need hundreds of tasks. In reality, 20-50 simple tasks drawn from real failures is a great start. After all, in early agent development, each change to the system often has a clear, noticeable impact, and this large effect size means small sample sizes suffice. More mature agents may need larger, more difficult evals to detect smaller effects, but it's best to take the 80/20 approach in the beginning. Evals get harder to build the longer you wait. Early on, product requirements naturally translate into test cases. Wait too long and you're reverse-engineering success criteria from a live system.

> **译：****第 0 步：尽早开始**。很多团队推迟建评测，是因为以为需要几百个任务。实际上，从真实失败中提炼的 20-50 个简单任务就是很好的起点。毕竟在 agent 开发早期，系统的每次变更往往都有明显可见的影响，这种大效应量意味着小样本就够了。更成熟的 agent 可能需要更大、更难的评测来探测更小的效应，但起步阶段最好采取 80/20 策略。等得越久，评测越难建。早期，产品需求可以自然地转化为测试用例；等太久，你就得从一个已上线的系统里逆向工程成功标准。

**Step 1. Start with what you already test manually**

Begin with the manual checks you run during development—the behaviors you verify before each release and common tasks end users try. If you're already in production, look at your bug tracker and support queue. Converting user-reported failures into test cases ensures your suite reflects actual usage; prioritizing by user impact helps you invest effort where it counts.

> **译：****第 1 步：从你已经在手工测试的东西开始**。从开发过程中执行的手工检查入手——每次发布前验证的行为、终端用户常做的任务。如果已上线，翻一翻 bug 跟踪系统和客服工单。把用户报告的失败转成测试用例，能确保套件反映真实使用；按用户影响排优先级，把力气花在刀刃上。

**Step 2: Write unambiguous tasks with reference solutions**

Getting task quality right is harder than it seems. A good task is one where two domain experts would independently reach the same pass/fail verdict. Could they pass the task themselves? If not, the task needs refinement. Ambiguity in task specifications becomes noise in metrics. The same applies to criteria for model-based graders: vague rubrics produce inconsistent judgments.

> **译：****第 2 步：写无歧义的任务并附参考解**。把任务质量做对比想象中难。好任务的标准是：两位领域专家独立判断会得出相同的过/不过结论。他们自己能通过这个任务吗？不能，任务就需要打磨。任务描述里的歧义会变成指标里的噪声。模型评分器的标准同理：模糊的 rubric 带来不一致的判断。

Each task should be passable by an agent that follows instructions correctly. This can be subtle. For instance, auditing Terminal-Bench revealed that if a task asks the agent to write a script but doesn't specify a filepath, and the tests assume a particular filepath for the script, the agent might fail through no fault of its own. Everything the grader checks should be clear from the task description; agents shouldn't fail due to ambiguous specs. With frontier models, a 0% pass rate across many trials (i.e. 0% pass@100) is most often a signal of a broken task, not an incapable agent, and a sign to double-check your task specification and graders. For each task, it's useful to create a reference solution: a known working output that passes all graders. This proves that the task is solvable and verifies graders are correctly configured.

> **译：** 每个任务都应该是一个正确遵循指令的 agent 所能通过的。这一点可能很隐蔽。例如，对 Terminal-Bench 的审计发现：如果一个任务要求 agent 写一个脚本但不指定文件路径，而测试假设了特定的脚本路径，agent 可能会无辜失败。评分器检查的一切都应在任务描述里写清楚；agent 不应因模糊的规格而失败。对前沿模型来说，多次试验 0% 通过率（即 0% pass@100）往往是任务有问题的信号，而不是 agent 不行——这时该复查任务规格和评分器。为每个任务创建一个参考解（reference solution）很有用：一个已知可行、能通过所有评分器的输出。这证明任务可解，也验证评分器配置正确。

**Step 3: Build balanced problem sets**

Test both the cases where a behavior *should* occur and where it *shouldn't*. One-sided evals create one-sided optimization. For instance, if you only test whether the agent searches when it should, you might end up with an agent that searches for almost everything. Try to avoid [class-imbalanced](https://developers.google.com/machine-learning/crash-course/overfitting/imbalanced-datasets) evals. We learned this firsthand when building evals for web search in [Claude.ai](http://claude.ai/redirect/website.v1.6e71545d-da47-493b-afc0-3ea8ae6c1cff). The challenge was preventing the model from searching when it shouldn't, while preserving its ability to do extensive research when appropriate. The team built evals covering both directions: queries where the model should search (like finding the weather) and queries where it should answer from existing knowledge (like "who founded Apple?"). Striking the right balance between undertriggering (not searching when it should) or overtriggering (searching when it shouldn't) was difficult, and took many rounds of refinements to both the prompts and the eval. As more example problems come up, we continue to add to evals to improve our coverage.

> **译：****第 3 步：构建平衡的题集**。既要测行为*应该*发生的场景，也要测*不应该*发生的场景。单边的评测造就单边的优化。比如只测"该搜索时 agent 搜不搜"，最后可能得到一个什么都搜的 agent。尽量避免[类别失衡](https://developers.google.com/machine-learning/crash-course/overfitting/imbalanced-datasets)的评测。我们在为 [Claude.ai](http://claude.ai/redirect/website.v1.6e71545d-da47-493b-afc0-3ea8ae6c1cff) 构建网页搜索评测时切身学到了这一点：挑战在于既不让模型在不该搜的时候搜，又保住它在合适时做深入检索的能力。团队建了双向覆盖的评测：应该搜索的查询（比如查天气）和应该用已有知识回答的查询（比如"苹果公司是谁创立的？"）。在欠触发（该搜不搜）和过触发（不该搜乱搜）之间找平衡非常难，对 prompt 和评测都迭代了很多轮。随着新的问题案例出现，我们持续往评测里加题、扩大覆盖。

### Design the eval harness and graders

**Step 4: Build a robust eval harness with a stable environment**

It's essential that the agent in the eval functions roughly the same as the agent used in production, and that the environment itself doesn't introduce further noise. Each trial should be "isolated" by starting from a clean environment. Unnecessary shared state between runs (leftover files, cached data, resource exhaustion) can cause correlated failures due to infrastructure flakiness rather than agent performance. Shared state can also artificially inflate performance. For example, in some internal evals we observed Claude gaining an unfair advantage on some tasks by examining the git history from previous trials. If multiple distinct trials fail because of the same limitation in the environment (like limited CPU memory), these trials are not independent because they're affected by the same factor, and the eval results become unreliable for measuring agent performance.

> **译：****第 4 步：构建健壮的评测框架和稳定的环境**。评测中的 agent 必须与生产中的 agent 表现大体一致，环境本身也不能引入额外噪声。每次试验都应从干净环境启动，做到"隔离"。运行之间不必要的共享状态（残留文件、缓存数据、资源耗尽）会导致因基础设施抖动而非 agent 能力引起的关联性失败。共享状态也可能虚增性能。例如在一些内部评测中，我们观察到 Claude 通过查看前几次试验留下的 git 历史在某些任务上获得了不公平的优势。如果多个不同的试验因环境的同一限制（如 CPU 内存不足）而失败，这些试验就不是独立的——它们受同一因素影响，评测结果对衡量 agent 能力而言就不可信了。

**Step 5: Design graders thoughtfully**

As discussed above, great eval design involves choosing the best graders for the agent and the tasks. We recommend choosing deterministic graders where possible, LLM graders where necessary or for additional flexibility, and using human graders judiciously for additional validation.

> **译：****第 5 步：用心设计评分器**。如上所述，好的评测设计要为 agent 和任务选对评分器。我们的建议是：能用确定性评分器就用确定性评分器，必要时或需要灵活性时用 LLM 评分器，人工评分器审慎地用于补充验证。

There is a common instinct to check that agents followed very specific steps like a sequence of tool calls in the right order. We've found this approach too rigid and results in overly brittle tests, as agents regularly find valid approaches that eval designers didn't anticipate. So as not to unnecessarily punish creativity, it's often better to grade what the agent produced, not the path it took.

> **译：** 一种常见直觉是检查 agent 是否走了非常具体的步骤，比如按特定顺序的一串工具调用。我们发现这种方式过于僵硬，会产生过度脆弱的测试，因为 agent 经常会找到评测设计者没有预料到的合法路径。为了不无谓地惩罚创造力，更好的做法往往是评 agent 产出了什么，而不是它走了哪条路。

For tasks with multiple components, build in partial credit. A support agent that correctly identifies the problem and verifies the customer but fails to process a refund is meaningfully better than one that fails immediately. It's important to represent this continuum of success in results.

> **译：** 对多组成部分的任务，设计部分得分。一个正确识别了问题、验证了客户身份但没完成退款的客服 agent，明显好过一个立刻就失败的。在结果中体现这种成功的连续谱很重要。

Model grading often takes careful iteration to validate accuracy. LLM-as-judge graders should be closely calibrated with human experts to gain confidence that there is little divergence between the human grading and model grading. To avoid hallucinations, give the LLM a way out, like providing an instruction to return "Unknown" when it doesn't have enough information. It can also help to create clear, structured rubrics to grade each dimension of a task, and then grade each dimension with an isolated LLM-as-judge rather than using one to grade all dimensions. Once the system is robust, it's sufficient to use human review only occasionally.

> **译：** 模型评分往往需要反复迭代才能验证其准确性。LLM 裁判评分器应与人类专家紧密校准，确认人工评分与模型评分分歧很小。为避免幻觉，给 LLM 留退路——比如指示它在信息不足时返回"Unknown"。为任务的每个维度创建清晰、结构化的 rubric，然后每个维度用一个独立的 LLM 裁判去评，而不是用一个裁判评所有维度，也会有帮助。系统稳健之后，偶尔做一次人工复审就够了。

Some evaluations have subtle failure modes that result in low scores even with good agent performance, as the agent fails to solve tasks due to grading bugs, agent harness constraints, or ambiguity. Even sophisticated teams can miss these issues. For example, [Opus 4.5 initially scored 42% on CORE-Bench](https://x.com/sayashk/status/1996334941832089732?s=46&t=c5pEvnVdVbMkcR_rcCHplg), until an Anthropic researcher found multiple issues: rigid grading that penalized "96.12" when expecting "96.124991…", ambiguous task specs, and stochastic tasks that were impossible to reproduce exactly. After fixing bugs and using a less constrained scaffold, Opus 4.5's score jumped to 95%. Similarly, [METR discovered](https://x.com/metr_evals/status/2001473506442375645?s=46) several misconfigured tasks in their time horizon benchmark that asked agents to optimize to a stated score threshold, but the grading required exceeding that threshold. This penalized models like Claude for following the instructions, while models that ignored the stated goal received better scores. Carefully double-checking tasks and graders can help avoid these problems.

> **译：** 有些评测存在隐蔽的失败模式：agent 明明表现不错，分数却很低——因为评分 bug、agent 框架约束或任务歧义导致 agent 无法解题。再资深的团队也会漏掉这些问题。例如 [Opus 4.5 在 CORE-Bench 上最初只得 42%](https://x.com/sayashk/status/1996334941832089732?s=46&t=c5pEvnVdVbMkcR_rcCHplg)，直到一位 Anthropic 研究员发现了多个问题：僵硬的评分把"96.12"判错而期望"96.124991…"、任务规格有歧义、以及无法精确复现的随机性任务。修掉 bug、换用约束更少的 scaffold 后，Opus 4.5 的得分跳到了 95%。类似地，[METR 发现](https://x.com/metr_evals/status/2001473506442375645?s=46)他们的时间跨度基准里有多个配置错误的任务：任务要求 agent 优化到指定的分数阈值，评分却要求超过该阈值。这惩罚了像 Claude 这样遵循指令的模型，而无视目标的模型反而得分更高。仔细复核任务和评分器可以避免这些问题。

Make your graders resistant to bypasses or hacks. The agent shouldn't be able to easily "cheat" the eval. Tasks and graders should be designed so that passing genuinely requires solving the problem rather than exploiting unintended loopholes.

> **译：** 让评分器能抵御绕过和作弊。agent 不应该能轻易"骗过"评测。任务和评分器的设计要让通过真正来自解决问题，而不是钻意料之外的漏洞。

### Maintain and use the eval long-term

**Step 6: Check the transcripts**

You won't know if your graders are working well unless you read the transcripts and grades from many trials. At Anthropic, we invested in tooling for viewing eval transcripts and we regularly take the time to read them. When a task fails, the transcript tells you whether the agent made a genuine mistake or whether your graders rejected a valid solution. It also often surfaces key details about agent and eval behavior.

> **译：****第 6 步：读记录**。不读多次试验的记录和评分，你不会知道评分器是否工作正常。在 Anthropic，我们投入建设了查看评测记录的工具，并定期花时间阅读。任务失败时，记录会告诉你：是 agent 真的犯了错，还是你的评分器误杀了合法解。它还常常暴露 agent 和评测行为的关键细节。

Failures should seem fair: it's clear what the agent got wrong and why. When scores don't climb, we need confidence that it's due to agent performance and not the eval. Reading transcripts is how you verify that your eval is measuring what actually matters, and is a critical skill for agent development.

> **译：** 失败应当显得公道：能清楚看出 agent 错在哪、为什么错。分数上不去时，我们需要确信那是 agent 能力问题而不是评测问题。读记录就是验证评测确实在衡量真正重要之事的方法，这是 agent 开发的一项关键技能。

**Step 7: Monitor for capability eval saturation**

An eval at 100% tracks regressions but provides no signal for improvement. **Eval saturation** occurs when an agent passes all of the solvable tasks, leaving no room for improvement. For instance, SWE-Bench Verified scores started at 30% this year, and frontier models are now nearing saturation at >80%. As evals approach saturation, progress will also slow, as only the most difficult tasks remain. This can make results deceptive, as large capability improvements appear as small increases in scores. For example, the code review startup [Qodo](https://www.qodo.ai/) was initially unimpressed by Opus 4.5 because their one-shot coding evals didn't capture the gains on longer, more complex tasks. In response, they developed a new agentic eval framework, providing a much clearer picture of progress.

> **译：****第 7 步：警惕能力评测饱和**。满分评测只能追踪回归，对改进毫无信号。**评测饱和**（eval saturation）指 agent 已通过所有可解任务、不再有提升空间的状态。例如 SWE-Bench Verified 今年初得分 30%，前沿模型如今已逼近 >80% 的饱和。评测接近饱和时进展也会放缓，因为只剩最难的题。这会让结果产生误导——很大的能力提升只表现为分数的小幅上涨。例如代码评审创业公司 [Qodo](https://www.qodo.ai/) 起初对 Opus 4.5 印象平平，因为他们的一次性编码评测捕捉不到更长、更复杂任务上的提升。为此他们开发了新的 agentic 评测框架，才看清了进步的图景。

As a rule, we do not take eval scores at face value until someone digs into the details of the eval and reads some transcripts. If grading is unfair, tasks are ambiguous, valid solutions are penalized, or the harness constrains the model, the eval should be revised.

> **译：** 我们的规矩是：在有人深挖评测细节、读过一些记录之前，不把评测分数当真。如果评分不公、任务有歧义、合法解被惩罚、或框架限制了模型，就应该修订评测。

**Step 8: Keep evaluation suites healthy long-term through open contribution and maintenance**

An eval suite is a living artifact that needs ongoing attention and clear ownership to remain useful.

> **译：****第 8 步：通过开放贡献和维护让评测套件长期保持健康**。评测套件是活的工件，需要持续投入和明确归属才能保持有用。

At Anthropic, we experimented with various approaches to eval maintenance. What proved most effective was establishing dedicated evals teams to own the core infrastructure, while domain experts and product teams contribute most eval tasks and run the evaluations themselves.

> **译：** 在 Anthropic，我们尝试过多种评测维护方式。最有效的是设立专职评测团队负责核心基础设施，而领域专家和产品团队贡献大部分评测任务并自己运行评测。

For AI product teams, owning and iterating on evaluations should be as routine as maintaining unit tests. Teams can waste weeks on AI features that "work" in early testing but fail to meet unstated expectations that a well-designed eval would have surfaced early. Defining eval tasks is one of the best ways to stress-test whether the product requirements are concrete enough to start building.

> **译：** 对 AI 产品团队来说，拥有并迭代评测应当像维护单元测试一样日常。团队可能浪费数周去做早期测试"能用"、却满足不了未言明期望的功能——而一个设计良好的评测本可以更早暴露这些问题。定义评测任务是检验产品需求是否具体到可以动工的最好方式之一。

We recommend practicing eval-driven development: build evals to define planned capabilities before agents can fulfill them, then iterate until the agent performs well. Internally, we often build features that work "well enough" today but are bets on what models can do in a few months. Capability evals that start at a low pass rate make this visible. When a new model drops, running the suite quickly reveals which bets paid off.

> **译：** 我们推荐评测驱动开发：在 agent 尚未具备能力之前就建好评测来定义预期，然后迭代到 agent 表现良好。在内部，我们常构建今天"够用"的功能，实质是对模型几个月后能做到什么的押注。从低通过率起步的能力评测让这一点显性化——新模型发布时，跑一遍套件立刻知道哪些押注兑现了。

The people closest to product requirements and users are best positioned to define success. With current model capabilities, product managers, customer success managers, or salespeople can use Claude Code to contribute an eval task as a PR—let them! Or, even better, actively enable them.

> **译：** 离产品需求和用户最近的人，最适合定义成功。以当前模型的能力，产品经理、客户成功经理、销售人员都能用 Claude Code 以 PR 形式贡献评测任务——放手让他们做！或者更进一步，主动为他们创造条件。

![The process of creating an effective evaluation.](/vibe-reading/images/articles/anthropic-official-demystifying-evals-for-ai-agents/eval-creation-process.png)

## How evals fit with other methods for a holistic understanding of agents

Automated evaluations can be run against an agent in thousands of tasks without deploying to production or affecting real users. But this is just one of many ways to understand agent performance. A complete picture includes production monitoring, user feedback, A/B testing, manual transcript review, and systematic human evaluation.

> **译：** 自动化评测可以在不部署生产、不影响真实用户的前提下，对 agent 跑成千上万个任务。但这只是理解 agent 表现的众多方式之一。完整的图景还包括生产监控、用户反馈、A/B 测试、人工记录审查和系统性人类评估。

An overview of approaches for understanding AI agent performance:

> **译：** 理解 AI agent 表现的方法总览：

| Method | Pros | Cons |
| --- | --- | --- |
| **Automated evals**<br>*Running tests programmatically without real users* | Faster iteration<br>Fully reproducible<br>No user impact<br>Can run on every commit<br>Tests scenarios at scale without requiring a prod deployment | Requires more up-front investment to build<br>Requires ongoing maintenance as product and model evolves to avoid drift<br>Can create false confidence if it doesn't match real usage patterns |
| **Production monitoring**<br>*Tracking metrics and errors in live systems* | Reveals real user behavior at scale<br>Catches issues that synthetic evals miss<br>Provides ground truth on how agents actually perform | Reactive; problems reach users before you know about them<br>Signals can be noisy<br>Requires investment in instrumentation<br>Lacks ground truth for grading |
| **A/B testing**<br>*Comparing variants with real user traffic* | Measures actual user outcomes (retention, task completion)<br>Controls for confounds<br>Scalable and systematic | Slow; days or weeks to reach significance and requires sufficient traffic<br>Only tests changes you deploy<br>Less signal on the underlying "why" for changes in metrics without being able to thoroughly review the transcripts |
| **User feedback**<br>*Explicit signals like thumbs-down or bug reports* | Surfaces problems you didn't anticipate<br>Comes with real examples from actual human users<br>The feedback often correlates with product goals | Sparse and self-selected<br>Skews toward severe issues<br>Users rarely explain *why* something failed<br>Not automated<br>Relying primarily on users to catch issues can have negative user impact |
| **Manual transcript review**<br>*Humans reading through agent conversations* | Builds intuition for failure modes<br>Catches subtle quality issues automated checks miss<br>Helps calibrate what "good" looks like and grasp details | Time-intensive<br>Doesn't scale<br>Coverage is inconsistent<br>Reviewer fatigue or different reviewers can affect the signal quality<br>Typically only gives qualitative signal rather than clear quantitative grading |
| **Systematic human studies**<br>*Structured grading of agent outputs by trained raters* | Gold-standard quality judgements from multiple human raters<br>Handles subjective or ambiguous tasks<br>Provides signal for improving model-based graders | Relatively expensive and slow turnaround<br>Hard to run frequently<br>Inter-rater disagreement requires reconciliation<br>Complex domains (legal, finance, healthcare) require human experts to conduct studies |

> **译：**
>
> | 方法 | 优势 | 劣势 |
> | --- | --- | --- |
> | **自动化评测**<br>*无需真实用户、程序化运行测试* | 迭代更快<br>完全可复现<br>不影响用户<br>可在每次提交时运行<br>无需生产部署即可大规模测试场景 | 前期建设投入更大<br>产品和模型演进中需要持续维护以免漂移<br>与真实使用模式不符时会制造虚假信心 |
> | **生产监控**<br>*在真实系统中追踪指标和错误* | 大规模揭示真实用户行为<br>捕捉合成评测漏掉的问题<br>提供 agent 真实表现的真值 | 被动；问题先触达用户你才知道<br>信号可能嘈杂<br>需要埋点投入<br>缺少评分所需的真值 |
> | **A/B 测试**<br>*用真实流量对比多个变体* | 衡量真实用户结果（留存、任务完成）<br>控制混杂因素<br>可规模化、成体系 | 慢；需数天或数周才能显著、且需足够流量<br>只能测已部署的变更<br>无法详读记录时，对指标变化背后的"为什么"信号较弱 |
> | **用户反馈**<br>*点踩、bug 报告等显式信号* | 暴露你没想到的问题<br>附带真实用户实例<br>反馈常与产品目标相关 | 稀疏且自选择<br>偏向严重问题<br>用户很少解释*为什么*失败<br>非自动化<br>主要靠用户发现问题可能损害用户体验 |
> | **人工记录审查**<br>*人类通读 agent 对话* | 建立对失败模式的直觉<br>捕捉自动检查漏掉的细微质量问题<br>帮助校准"好"的样子、把握细节 | 耗时<br>不可规模化<br>覆盖不一致<br>审查者疲劳或不同审查者影响信号质量<br>通常只给定性信号而非清晰的定量评分 |
> | **系统性人类评估**<br>*受训评审对 agent 输出结构化打分* | 多个人类评审的黄金标准质量判断<br>处理主观或歧义任务<br>为改进基于模型的评分器提供信号 | 相对昂贵、周期长<br>难以频繁运行<br>评审间分歧需要仲裁<br>复杂领域（法律、金融、医疗）需要人类专家执行 |

These methods map to different stages of agent development. Automated evals are especially useful pre-launch and in CI/CD, running on each agent change and model upgrade as the first line of defense against quality problems. Production monitoring kicks in post-launch to detect distribution drift and unanticipated real-world failures. A/B testing validates significant changes once you have sufficient traffic. User feedback and transcript review are ongoing practices to fill the gaps: triage feedback constantly, sample transcripts to read weekly, and dig deeper as needed. Reserve systematic human studies for calibrating LLM graders or evaluating subjective outputs where human consensus serves as the reference standard.

> **译：** 这些方法对应 agent 开发的不同阶段。自动化评测在上线前和 CI/CD 中尤其有用，对每次 agent 变更和模型升级运行，是质量问题的第一道防线。生产监控在上线后介入，检测分布漂移和未预料的真实世界失败。A/B 测试在流量充足后验证重大变更。用户反馈和记录审查是填补空缺的日常实践：持续分诊反馈、每周抽样读记录、按需深挖。系统性人类评估则留给 LLM 评分器校准，或以人类共识为参照标准的主观输出评估。

![Like the Swiss Cheese Model from safety engineering, no single evaluation layer catches every issue. With multiple methods combined, failures that slip through one layer are caught by another.](/vibe-reading/images/articles/anthropic-official-demystifying-evals-for-ai-agents/holistic-understanding.png)

The most effective teams combine these methods: automated evals for fast iteration, production monitoring for ground truth, and periodic human review for calibration.

> **译：** 最有效的团队会组合这些方法：自动化评测做快速迭代，生产监控提供真值，定期人工审查做校准。

## Conclusion

Teams without evals get bogged down in reactive loops—fixing one failure, creating another, unable to distinguish real regressions from noise. Teams that invest early find the opposite: development accelerates as failures become test cases, test cases prevent regressions, and metrics replace guesswork. Evals give the whole team a clear hill to climb, turning "the agent feels worse" into something actionable. The value compounds, but only if you treat evals as a core component, not an afterthought.

> **译：** 没有评测的团队深陷被动循环——修好一个失败、引入另一个，无法区分真实退化与噪声。早投入的团队则恰恰相反：失败变成测试用例、测试用例防止回归、指标取代瞎猜，开发随之加速。评测给整个团队一座清晰可攀的山，把"agent 感觉变差了"变成可行动的结论。这种价值会复利累积——前提是你把评测当作核心组件，而不是事后补丁。

The patterns vary by agent type, but the fundamentals described here are constant. Start early and don't wait for the perfect suite. Source realistic tasks from the failures you see. Define unambiguous, robust success criteria. Design graders thoughtfully and combine multiple types. Make sure the problems are hard enough for the model. Iterate on the evaluations to improve their signal-to-noise ratio. Read the transcripts!

> **译：** 模式因 agent 类型而异，但这里讲的基本功是恒定的。尽早开始，别等完美套件。从你看到的失败里提取真实任务。定义无歧义、稳健的成功标准。用心设计评分器并组合多种类型。确保题目对模型来说足够难。持续迭代评测以提升信噪比。还有——去读记录！

AI agent evaluation is still a nascent, fast-evolving field. As agents take on longer tasks, collaborate in multi-agent systems, and handle increasingly subjective work, we will need to adapt our techniques. We'll keep sharing best practices as we learn more.

> **译：** AI agent 评测仍是一个新生、快速演进的领域。随着 agent 承担更长的任务、在多 agent 系统中协作、处理越来越主观的工作，我们的技术也需要随之演进。我们会随着认知的深入持续分享最佳实践。

### Acknowledgements

Written by Mikaela Grace, Jeremy Hadfield, Rodrigo Olivares, and Jiri De Jonghe. We're also grateful to David Hershey, Gian Segato, Mike Merrill, Alex Shaw, Nicholas Carlini, Ethan Dixon, Pedram Navid, Jake Eaton, Alyssa Baum, Lina Tawfik, Karen Zhou, Alexander Bricken, Sam Kennedy, Robert Ying, and others for their contributions. Special thanks to the customers and partners we have learned from through collaborating on evals, including iGent, Cognition, Bolt, Sierra, Vals.ai, Macroscope, PromptLayer, Stripe, Shopify, the Terminal Bench team, and more. This work reflects the collective efforts of several teams who helped develop the practice of evaluations at Anthropic.

> **译：** 本文由 Mikaela Grace、Jeremy Hadfield、Rodrigo Olivares 和 Jiri De Jonghe 撰写。同时感谢 David Hershey、Gian Segato、Mike Merrill、Alex Shaw、Nicholas Carlini、Ethan Dixon、Pedram Navid、Jake Eaton、Alyssa Baum、Lina Tawfik、Karen Zhou、Alexander Bricken、Sam Kennedy、Robert Ying 等人的贡献。特别感谢在评测协作中让我们受益的客户与伙伴，包括 iGent、Cognition、Bolt、Sierra、Vals.ai、Macroscope、PromptLayer、Stripe、Shopify、Terminal Bench 团队等。本文体现了多个团队在 Anthropic 发展评测实践的集体努力。

## Appendix: Eval frameworks

Several open-source and commercial frameworks can help teams implement agent evaluations without building infrastructure from scratch. The right choice depends on your agent type, existing stack, and whether you need offline evaluation, production observability, or both. [Harbor](https://harborframework.com/) is designed for running agents in containerized environments, with infrastructure for running trials at scale across cloud providers and a standardized format for defining tasks and graders. Popular benchmarks like Terminal-Bench 2.0 ship through the Harbor registry, making it easy to run established benchmarks along with custom eval suites. [Braintrust](https://www.braintrust.dev/) is a platform that combines offline evaluation with production observability and experiment tracking—useful for teams that need to both iterate during development and monitor quality in production. Its `autoevals` library includes pre-built scorers for factuality, relevance, and other common dimensions. [LangSmith](https://docs.langchain.com/langsmith/evaluation) offers tracing, offline and online evaluations, and dataset management with tight integration into the LangChain ecosystem. [Langfuse](https://langfuse.com/) provides similar capabilities as a self-hosted open-source alternative for teams with data residency requirements.

> **译：** 一些开源和商业框架可以帮助团队不必从零搭建基础设施就能实施 agent 评测。选型取决于 agent 类型、现有技术栈，以及你需要离线评测、生产可观测还是两者兼有。[Harbor](https://harborframework.com/) 为在容器化环境中运行 agent 而设计，提供跨云厂商大规模运行试验的基础设施和定义任务与评分器的标准格式。Terminal-Bench 2.0 等流行基准通过 Harbor registry 发布，方便在自定义评测套件之外运行成熟基准。[Braintrust](https://www.braintrust.dev/) 是将离线评测、生产可观测和实验跟踪结合在一起的平台——适合既要开发期迭代又要监控生产质量的团队。其 `autoevals` 库内置了事实性、相关性等常见维度的评分器。[LangSmith](https://docs.langchain.com/langsmith/evaluation) 提供追踪、离线与在线评测和数据集管理，与 LangChain 生态深度集成。[Langfuse](https://langfuse.com/) 提供类似能力，是满足数据驻留需求团队的自托管开源替代。

[Arize](https://arize.com/) offers Phoenix, an open-source platform for LLM tracing, debugging, and offline or online evaluations, and AX, a SaaS offering that extends Phoenix for scale, optimization and monitoring. Many teams combine multiple tools, roll their own eval framework, or just use simple evaluation scripts as a starting point. We find that while frameworks can be a valuable way to accelerate progress and standardize, they're only as good as the eval tasks you run through them. It's often best to quickly pick a framework that fits your workflow, then invest your energy in the evals themselves by iterating on high-quality test cases and graders.

> **译：** [Arize](https://arize.com/) 提供 Phoenix——一个开源的 LLM 追踪、调试和离线/在线评测平台，以及 AX——扩展 Phoenix 以支持规模化、优化和监控的 SaaS 产品。很多团队组合使用多个工具、自研评测框架，或仅以简单的评测脚本起步。我们发现框架固然能加速进展、促进标准化，但它的价值上限取决于你跑的评测任务。通常最好的做法是快速选定一个适配工作流的框架，然后把精力投入到评测本身——打磨高质量的测试用例和评分器。

## 相关阅读

- [《Agent 评测白皮书》系列01：Agent 评测全览](/vibe-reading/articles/AI/Agent/Evaluation/Meituan/Official/meituan-official-agent-evaluation-white-paper-01) —— 美团技术团队的 Agent 评测体系全景（本文 Task/Grader 概念被其引用）
- [Agent 评测漫谈 —— 由浅入深讲解Agent评测](/vibe-reading/articles/AI/Agent/Evaluation/Meituan/Official/meituan-official-agent-evaluation-guide) —— 美团图灵团队评测方法论
- [Building effective agents](/vibe-reading/articles/anthropic-official-building-effective-agents) —— 本文前置篇，Anthropic 官方 agent 构建实践
- [Multi-agent research system](/vibe-reading/articles/AI/Agent/Multi-Agent/Official/anthropic-official-multi-agent-research-system) —— Anthropic 多 agent 研究系统工程博客（中英对照）
