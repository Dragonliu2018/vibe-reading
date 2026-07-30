---
title: "阿里开源 skill-up：让 Agent Skill 可评测可回归"
source:
  type: "article"
  project: "Alibaba"
  url: "https://mp.weixin.qq.com/s/lTdRNB3vTJoU0nAPBkHNtw"
  author: "阿里技术"
  site: "阿里技术 微信公众号"
date: "2026-07-30T17:30:00+08:00"
category: [AI, Agent, Evaluation, skill-up, Official]
tags: ["Agent Skill", "skill-up", "评测框架", "回归测试", "CI", "Alibaba", "开源"]
description: "阿里巴巴开源 skill-up——一个面向 Agent Skill 的命令行评测框架，用声明式 YAML 固化「加载用例→启动 Agent→发送输入→收集回复→判定→生成报告」全流程，支持本地与 CI 复用、跨引擎回放、多轮会话与重型端到端评测。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [阿里开源 skill-up：让 Agent Skill 可评测可回归](https://mp.weixin.qq.com/s/lTdRNB3vTJoU0nAPBkHNtw) · **作者** 阿里技术 · **来源** 阿里技术 微信公众号 · **原文发布** 2026-07-23 · **转载** 2026-07-30

---

## 为什么需要 Skill 评测

过去一年，Agent Skill 迅速成为 AI 应用领域的核心基础设施。一段 `SKILL.md`、几个脚本、一组工具声明，就能让 Agent 具备一项新的专业能力：写发布计划、做代码评审、升级依赖、跑数据分析。写一个能「跑起来」的 Skill 已经不难，难的是：怎么保证它在迭代中不退化、在换引擎后不走样、在多人协作下不失控。

对传统软件，我们有单元测试、集成测试、CI 门禁来回答「改动有没有破坏原有行为」。但 Skill 是 prompt、文件与工具配置的组合，它的行为对模型版本、引擎实现、输入措辞都高度敏感，长期以来却缺少一种「声明一次、随时回放」的方式来固化预期行为。

为此，阿里巴巴开源了 **skill-up**：一个专门面向 Agent Skill 开发者的命令行评测框架。它的目标是「让 Agent Skill 的每一次迭代都可被验证、可被回归」。

本文会讲清楚四件事：

1. skill-up 是什么；
2. 它解决了哪些真实痛点；
3. 它是如何设计的；
4. 它在集团内部真实落地场景。

项目开源地址：`github.com/alibaba/skill-up`
用户手册：`alibaba.github.io/skill-up/zh`

## 三个真实痛点

如果我们正在编写或维护 Agent Skill，大概率会遇到以下问题：

**场景一：Skill 悄悄退化，但没人在评审阶段察觉。** 你为团队的发布系统写了一个 `publish-plan` Skill，本地跑了几遍觉得「差不多了」就发布。两周后，同事改了 `SKILL.md` 里的一段描述，Skill 在某些输入下却不再调用预期工具，甚至输出结构都变了。PR review 时没人能察觉——因为没有可回放的评测，只有「再手动跑一遍」。

**场景二：换个引擎，行为就变了。** 你写了一个 `code-review` Skill，在某个 Agent 引擎上跑得不错。团队另一位同事换了另一个引擎，反馈说同样的提示语下输出结构完全不同。你想系统地验证 Skill 在两个引擎下的真实差异，但每次都要手动两边对照，成本极高。

**场景三：评测逻辑散落各处，无法复用。** 为了给一个复杂 Skill 做评测，你写了一堆脚本：安装 Skill、调用 Agent、解析输出、对比结果、生成报告。它能跑，但评测语义散落在多个脚本和中间文件里，本地一套、CI 又一套，新增一条用例要改好几处，谁也不敢动。

这三个场景的问题其实是同一个：Skill 缺少一个标准化的评测框架，把「加载用例 → 启动 Agent → 发送输入 → 收集回复 → 判定是否通过 → 生成报告」这一整套流程稳定地串起来，并且能被本地开发和 CI 流水线共同复用。

## skill-up 是什么

skill-up 是一个独立的命令行评测框架。你在 Skill 目录下放一份 `evals/eval.yaml` 和若干 `evals/cases/*.yaml`，用声明式的方式写清楚：评测在什么环境里跑、用哪个 Agent 引擎、跑哪些用例、用什么判定策略。

一份最小的 `eval.yaml` 大致长这样：

```yaml title="eval.yaml 最小配置"
schema_version: v1alpha1
environment:
  type: none            # 本地直跑；也可选择沙箱化隔离环境
engine:
  name: claude_code     # 内置多引擎
```

每一条用例是一份独立的 case YAML，描述输入、期望检查和判定方式：

```yaml title="case YAML 示例"
id: case_create_plan
title: 验证发布计划生成能力
input:
  prompt: "帮我为今天上午 10:30 的 web 系统发布生成一个发布计划"
expect:
  must_contain:
    - ...
```

声明完成后，运行：

```bash title="运行评测"
skill-up run ./evals/eval.yaml
```

它会逐用例执行，并产出三类结果：

1. 每条断言的通过情况与证据（工具是否被调用、输出是否包含关键字段、判定理由）；
2. 本次评测的汇总通过率与耗时/token 消耗；
3. 一个进程退出码：0 表示全部通过，非 0 表示存在失败用例，可以直接接入 CI 作为合并门禁。

除此之外，它还能同时输出 JUnit XML 和一份可视化的 HTML 报告。

![skill-up 评测流程与产物概览](/vibe-reading/images/articles/alibaba-official-skill-up-agent-skill-eval/eval-overview.png)

换句话说，skill-up 解决的核心问题是：Skill 已经写好了，怎么稳定地、自动化地、跨引擎地验证它在真实环境里的行为不会走样。

它的适用场景也很明确：会被多人协作迭代的 Skill、准备或已经接入 CI 的 Skill、需要在多个引擎上保持一致行为的 Skill。

可能有读者会问：做 LLM 或 Skill 评测的工具并不少，为什么还要再造一个？相较于其他 Skill 或 LLM 评测工具，skill-up 的定位有三点不同：

1. 它是 **framework-orchestrated 的独立 CLI**，整个评测过程不需要由某个 AI 会话来驱动，因此天然适合作为一个步骤嵌进 CI 流水线；
2. 它把断言拆成 **expect（本地零成本）+ judge（按需调模型）两层**，避免大模型偶发抖动直接阻断构建；
3. 它面向的是 **Agent Skill 这一具体对象**（安装被测 Skill、跨引擎回放、验证工具调用），而不是泛化的单轮 prompt 打分。

同时，对已经用 Anthropic 风格 `evals.json` 写过评测的项目，它保持兼容，迁移成本接近于零。

## 四个核心设计

skill-up 的能力可以拆成四个相互配合的设计。

**其一，声明式评测配置。** 评测的环境、引擎、模型、用例、判定策略全部写在 YAML 里，而不是散落在脚本的控制流中。这带来一个直接的好处：读者打开 `eval.yaml` 和对应的 case YAML，就能顺着结构看清「这条用例要做什么、整体怎么编排」，评测意图与执行细节不再耦合在难以追踪的脚本里。

**其二，expect + judge 分层判定，降低 LLM 抖动对流水线的影响。** skill-up 把断言拆成两层：`expect` 是本地零成本的确定性检查（文件是否存在、输出是否包含关键词、退出码是否为零），作为门槛先跑；只有通过之后，才执行昂贵的 `judge`（按需调用大模型做语义判定）。这样既保留了语义判断的灵活性，又避免了大模型偶发抖动直接阻断构建。

![expect + judge 分层判定](/vibe-reading/images/articles/alibaba-official-skill-up-agent-skill-eval/expect-judge.png)

**其三，多引擎支持，同一份用例可在不同 Agent 上回放。** skill-up 内置了对多种主流 Agent 引擎的适配（`claude_code` / `codex` / `qodercli` / `qwen_code`），切换引擎只是一个命令行参数的事：

```bash title="切换引擎回放"
skill-up run ./evals/eval.yaml --engine claude_code
skill-up run ./evals/eval.yaml --engine codex
skill-up run ./evals/eval.yaml --engine qwen_code
```

Skill 安装、CLI 调用、产物收集这些与引擎强相关的事情全部由框架处理；同一份评测集在三个引擎上跑完，取最大公约数，就是这个 Skill 真正稳定的行为边界；对于自研或第三方 Agent，也可以按标准化的自定义引擎契约接入，无需改动用例。

**其四，结构化报告，天生对 CI 友好。** skill-up 输出的报告在 Schema 上与 Anthropic 的评测产物兼容，同时额外提供 JUnit XML 和 HTML 报告。全流程通过退出码反馈结果，可以直接作为流水线的一个步骤接入；JUnit XML 让它能在 Jenkins、GitLab CI 等主流 CI 的测试面板里原生展示。

![多引擎回放与 CI 友好报告](/vibe-reading/images/articles/alibaba-official-skill-up-agent-skill-eval/multi-engine.png)

## 多轮会话评测

前面四个核心设计解决的是「能不能测、测完能不能进 CI」的问题。但要让评测真正贴近用户的使用方式，还差一步：早期的 Skill 评测大多是「一问一答」，给 Agent 一段 prompt，看它的回复是否合理；真实用户却是一句一句地说、Agent 一轮一轮地回，中间还会出现拒绝、确认、纠偏。

比如「必须先 Research 再 Implement、用户要求跳步时应该拒绝」这样的流程约束，或者「危险操作要先确认、用户点头后才执行」这样的安全行为，都需要「你一句、Agent 一句」来回多轮才能验证，单条 prompt 无能为力。下面看一个多轮用例的写法。

skill-up 支持在一个用例里定义多条连续的用户消息，逐条发送给 Agent，并在每条回复后检查结果：

```yaml title="多轮用例：危险操作需确认"
id: confirm-before-delete
title: 危险操作必须等用户确认
input:
  turns:
    - role: user
      content: "删除仓库里所有测试文件"
      post_condition:
        ...
```

这里体现了多轮评测的几个关键能力：

1. **真实的会话保持**（每轮都在同一个 Agent 会话中，Agent 能看到之前所有对话）；
2. **逐轮质量门控**（`post_condition` 在每轮回复后立即检查，不达标可以早停省 token）；
3. **跨轮值传递**（用正则从某轮回复里提取 token，自动填入后续消息）；
4. **精确到轮的最终判定**（既能断言「某轮回复必须包含某关键词」，也能验证「某轮是否调用了某个工具」）。

其中 `post_condition` 和 `judge` 的分工很清晰：前者是「过程门卫」，只看当前这一轮值不值得继续；后者是「最终裁判」，看完整对话记录、工具调用、产物文件后给出整场结论。对「跨轮逻辑是否一致」「语义是否达标」这类规则难以写死的判断，交给 judge。

| 维度 | post_condition（过程门卫） | judge（最终裁判） |
| --- | --- | --- |
| 运行时机 | 每轮回复后立即 | 所有轮次结束后一次 |
| 可见范围 | 仅当前这一轮的回复文本 | 全部轮次记录、工具调用、产物文件、退出码 |
| 独有价值 | `on_fail` 流程控制：早停省 token 或放弃后续 | 跨轮综合定性、工具与产物验证、语义评判 |
| 一句话 | 值不值得继续下一轮？ | 整场对话最终算不算通过？ |

这里需要额外注意：不要在 judge 里重复 `post_condition` 已经把关过的同一条断言，应该让门卫负责「能不能往下走」，让裁判负责「最后成不成」。

实现上，skill-up 借助各引擎的会话恢复机制做到了真正的多轮对话：每一轮都是在同一个会话里追加消息，而不是重新开始，因此 Agent 的记忆在轮次之间是完整的，就像真实用户在 IDE 里连续对话一样。

## 重型端到端评测

如果说多轮评测让 skill-up 更贴近真实交互，那么「重型端到端评测」则代表了它能承接的复杂度上限。

有一类 Skill 的评测和常见的「给一段 prompt、看回复像不像对的」有本质区别。以一个「代码工程升级」类 Skill 为例，它的评测有四个显著特征：

1. 依赖真实运行环境（需要完整的语言工具链和 Agent CLI 实际可用）；
2. 输入是代码仓库而非文本（每条用例的输入是一个具体的仓库快照，Skill 会对其做实际的文件修改）；
3. 判定在产物层面（不是看文本输出，而是把 Skill 改完的代码和一个"标准答案"做逐行 diff）；
4. 单条用例耗时长（一次完整执行可能涉及多轮构建，跑完需要几十分钟，对 CPU 和内存有真实要求）。

这类评测的核心难点不在「如何优化 prompt」，在于「怎么编排整个执行和验证流程」。skill-up 用一个逐层收窄的判定漏斗来承接它：

![逐层收窄的判定漏斗](/vibe-reading/images/articles/alibaba-official-skill-up-agent-skill-eval/e2e-funnel.png)

第一层是 expect，只检查最便宜、最确定的信号；一旦不达标，用例立刻失败，不必进入昂贵的产物对比。第二层是一个证据脚本，它只负责把实际结果和期望结果做过滤后的 diff，并输出结构化 JSON，它不做语义判断，只负责提供确定性证据。第三层才是 agent_judge，它基于证据脚本产出的材料判断「这些差异是否合理」。

这里有一个容易被误解的点：引入 `agent_judge` 并不是把判定交给模型「凭感觉」。评审 Agent 的输入首先来自证据脚本产出的确定性材料，它做的是「基于证据判断不同是否合理」，而不是重新猜测任务有没有成功。也正因如此，报告里会完整保留证据链，方便人工复核。

当评审规则越来越接近一份领域手册时，skill-up 进一步提供了「judge-agent with skill」能力：不把所有评审规则都塞进配置里的 `criteria` 字段，而是给评审 Agent 单独安装一个评测专用 Skill，复杂判据写在那个 Skill 里：

```yaml title="judge-agent with skill"
judge:
  type: agent_judge
  skills:
    - source: local_path
      path: evals/judge-skills/my-domain-judge
  criteria:
    ...
```

关键在于，judge Skill 只安装给评审 Agent，不会安装给被测 Agent。这保证了评测语义的隔离：被测 Agent 只拥有被测 Skill，评审 Agent 才拥有评审 Skill。我们比较的仍然是被测 Skill 的真实效果，而不是被测 Skill 加上评审 Skill 的效果。

需要强调的是，skill-up 在这类场景里并不替代 CI，而是接管「评测语义和执行框架」这一层。真实环境准备、代码仓库拉取、并发调度、报告发布这些工作，仍然交给 CI 平台；skill-up 负责被测 Skill 安装、用例执行、judge 判定与结构化报告产出。

迁移并非把所有 CI 工作都塞进 skill-up，而是把「评测应该怎么跑、怎么判、怎么产出报告」这部分从自研脚本里抽出来，让它变成一份本地和 CI 都能复用的声明。

## 集团内部落地案例

skill-up 已经在集团内部承接了真实业务 Skill 的评测落地，其中最能说明问题的，是一次「重型端到端评测」从手搓流水线到框架的迁移。

迁移之前，一位同学为了给自己的「工程升级」类 Skill 做评测，完全靠手搓：用一段配置解析脚本把用例清单展开成多个并行任务，每个任务里再依次调用几段 Shell 完成 Skill 安装、执行、产物对比，最后用一段内嵌脚本生成测试报告；本地能跑，但可读性差、难以维护，新增用例成本高。

迁移到 skill-up 之后，这套手搓流水线里最容易失控的通用编排逻辑被删除，Skill 安装、Agent 调用、用例执行、judge 判定、报告生成等通用动作全部交给框架；仓库里只保留业务特有的用例清单、评测声明、证据脚本和少量报告渲染逻辑。

![从手搓流水线到 skill-up 的迁移](/vibe-reading/images/articles/alibaba-official-skill-up-agent-skill-eval/migration-report.png)

其中体感变化最大的一步，其实不是评测本身，反而是报告。过去评测产物只是躺在 CI 制品里的原始文件，想看结果的人要进 CI、找构建、下载、解压、读 JSON，这个门槛对创建者本人还能接受，对团队其他成员（评审人、TL、协作方）来说太高，很多评测结果根本没人看。迁移后 HTML 报告可以直接分享，逐条断言、证据、判定理由一目了然，评测才真正进入了协作流程。

这个案例也修正了一个此前不太确定的判断：对于「真实代码仓库输入、真实环境执行、产物级 diff 验证、允许合理差异并需要语义评判」的重型 Skill 端到端评测，skill-up 已有的原语是可以承接的。它不是把 CI、业务镜像、标准答案这些重活都揽过来，而是把评测语义从自研脚本里解放出来。

## 如何上手

skill-up 提供两条上手路径。

**路径 A：让 Agent 帮你自动生成评测集（推荐）。** skill-up 随仓库开源了一个名为 `skill-upper` 的 Agent Skill，专门用来帮 Agent 读取 `SKILL.md` 和相关脚本、推断这个 Skill 适合怎么评测、自动生成 `eval.yaml` 和用例。

```bash title="安装 skill-upper 到 Claude Code"
# 以全局安装到 Claude Code 为例
npx skills add https://github.com/alibaba/skill-up/tree/main/skills/skill-upper -g -a claude-co
```

**路径 B：纯 CLI 上手。** 适合需要在 CI 中跑、对评测集有精细控制的场景。

```bash title="纯 CLI 上手"
# 安装
curl -fsSL https://raw.githubusercontent.com/alibaba/skill-up/main/install.sh | bash
skill-up --version
# 在 Skill 目录下初始化评测集、编写用例后运行
skill-up run ./evals/eval.yaml
```

无论哪条路径，产出都是同一套结构化结果：逐条断言的通过情况、汇总通过率、可接入 CI 的退出码，以及一份可视化 HTML 报告。

## 总结与边界

skill-up 的定位可以用一句话概括：用简单易懂的声明式配置，固化我们对 Agent Skill 的预期，让代码评审和 CI 流水线都能有效验证它。从「一问一答」的单轮断言，到贴近真实交互的多轮会话，再到承接真实业务的重型端到端评测，它覆盖了 Skill 评测的主要复杂度梯度。

它也有清晰的边界，值得先说在前面。如果你的判定就是「产物必须逐字节一致」，用 `script` judge 靠退出码硬判会更省成本，不必动用 `agent_judge`；skill-up 不替你解决真实环境的可复现问题，工具链、镜像、标准答案仍需你自己准备；它也不替代 CI 平台本身的调度与制品管理，只是把其中「评测语义」这一层标准化。

那么，最直接的上手方式，其实就是打开你自己的 Skill 仓库，装上 skill-upper，说一句「评测当前 Skill」，几分钟后你会拿到第一份 HTML 报告，然后围绕它继续迭代。

如果你也在编写或维护 Agent Skill，欢迎试用并参与共建：

- 开源仓库（欢迎 Star）：`github.com/alibaba/skill-up`
- 中文用户手册：`alibaba.github.io/skill-up/zh`
- 提 Issue / 反馈：`github.com/alibaba/skill-up/issues`
