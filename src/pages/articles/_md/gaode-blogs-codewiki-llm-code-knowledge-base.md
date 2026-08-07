---
title: "CodeWiki: 为 LLM 自动生成代码知识库的工程实践"
source:
  type: "article"
  project: "高德"
  url: "https://mp.weixin.qq.com/s?__biz=MzE5ODQ3MDM4Mw==&mid=2247491618&idx=2&sn=ad7330c848794b2af7b8c54d6c8ea2db"
  author: "信息业务中心"
  site: "公众号 高德技术"
date: "2026-08-07T16:10:00+08:00"
category: [AI, Agent, AI Coding, CodeWiki, Blogs]
tags: ["CodeWiki", "LLM", "代码知识库", "交叉索引", "领域知识", "OpenSpec", "wiki-reading", "高德", "业务约束", "Merkle Tree", "tree-sitter", "Diamond"]
description: "高德技术团队 CodeWiki 工程实践：通过带证据的交叉索引提炼源码事实，用研发标注沉淀代码外规则，自底向上九阶段流水线生成供 LLM 消费的结构化知识库，在投放时段智能调控案例中将约束覆盖得分从 0.5 提升至 7.5。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [CodeWiki: 为 LLM 自动生成代码知识库的工程实践](https://mp.weixin.qq.com/s?__biz=MzE5ODQ3MDM4Mw==&mid=2247491618&idx=2&sn=ad7330c848794b2af7b8c54d6c8ea2db) · **作者** 信息业务中心 · **来源** 公众号 高德技术 · **原文发布** 2026-07-22 · **转载** 2026-08-07

---

>成熟系统中，LLM 真正难的不是写代码，而是理解散落在调用链、配置和研发经验里的业务约束。CodeWiki 用带证据的交叉索引提炼源码事实，用研发标注沉淀代码外规则。在"投放时段智能调控"单案例中，proposal 对 9 项关键约束的覆盖得分由 0.5 提升至 7.5。本文将介绍其生成流程、知识飞轮和验证结果。

## 一、LLM 需要知道现有代码里的业务规则
LLM 在已有系统上实现新需求时，经常会破坏现有逻辑。一个常见的场景是：LLM 新增了一个功能，但没有意识到它和已有功能存在互斥关系，或者绕过了已有的校验入口自己重写了一套，结果上线后影响了其他功能的正常运行。根源在于 LLM 不知道现有系统里有哪些业务约束，也就无法在实现新需求时正确地复用已有方法、遵守校验规则。但让 LLM 直接从源码中获取这些约束，面临三个问题：

痛点一：上下文不足。大型仓库的核心 Service 类动辄数千行，业务规则散落在条件分支、枚举判断、注解配置和多个方法的交叉调用中。一个完整的业务约束可能涉及 5-6 个方法的联动，而 LLM 的 context window 无法同时容纳所有相关代码。即使放得下，关键约束也容易被大量无关代码淹没。

痛点二：幻觉。LLM 在缺少充分上下文时，倾向于生成"看似合理但缺乏代码依据"的业务断言。例如声称某方法"用于风控校验"，但代码中并无对应逻辑。这类幻觉在业务约束密集的仓库中尤其危险。如果 LLM 基于错误的约束理解去实现需求，生成的代码可能破坏现有业务规则。

痛点三：有些业务规则根本不在代码里。即使 LLM 能读完所有源码，有些约束也找不到。例如"平滑投放与时段调控互斥"：平滑投放让预算在一天内均匀消耗，时段调控按时段分配预算比例，两者对投放节奏的控制逻辑会冲突。代码中已有平滑投放的校验逻辑，但当你新增时段调控功能时，代码里并不存在"新功能需要和平滑投放互斥"这条规则。这类跨功能的约束关系只存在于团队的经验中，LLM 无法从源码推断。

CodeWiki 针对这些问题提供解决方案：通过预先生成结构化的知识库，将源码中的业务约束、调用关系、配置语义提炼为 LLM 可以直接消费的摘要。 知识库的自动生成层（交叉索引）解决上下文问题，将数千行源码压缩为结构化摘要；evidence-based 的输出格式解决幻觉问题，每条业务断言必须附带代码证据和置信度评分；领域知识层解决"代码里找不到"的问题，通过飞轮机制在每次需求迭代中自动积累跨功能的约束关系和隐含的设计规则，供 LLM 在后续需求中消费。它是我们向 LLM 端到端实现需求迈进的第一步：先让 LLM 能准确理解现有代码的业务规则，再在此基础上尝试更完整的需求实现流程。

目标与 Cognition AI 的 DeepWiki 类似，都是一键为代码仓库生成文档。核心区别在于消费者不同：DeepWiki 生成的是供人阅读的文档页面，解决的是"人怎么快速了解一个仓库"；CodeWiki 生成的是供 LLM 消费的结构化知识库，解决的是"LLM 怎么在实现需求时理解现有代码的业务约束"。这个定位差异决定了两者在输出格式、知识粒度和质量控制上的不同设计选择。例如 CodeWiki 的输出需要包含每条业务断言的代码证据和置信度评分，因为 LLM 下游任务对幻觉的容忍度远低于人类阅读。

## 二、系统全景架构
整体链路为 Web UI 触发 → FastAPI 编排 → 九阶段生成流水线 → SQLite 持久化 → Wiki Bundle 导出。SQLite 保存任务状态和中间结果，最终产物则是一个可随代码仓库分发、供 LLM 工具读取的目录。

![整体架构](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/architecture-overview.png)

术语约定（后文统一使用）：

![术语约定](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/terminology-table.png)

## 三、核心生成流程

生成引擎采用自底向上（bottom-up）的九阶段流水线：先提取代码单元并生成函数级描述，再逐层聚合到文件、包、仓库和业务流。下图给出了各阶段及其依赖关系。

![九阶段生成流水线](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/pipeline-stages.png)

### 3.1 代码解析

系统基于 tree-sitter 进行抽象语法树（AST）解析，将源码拆解为结构化代码单元，每个单元包含签名、注解、参数、返回类型、import 依赖、docstring 和源码。目前支持 Java，能够提取类、接口、枚举、方法和注解；扩展其他语言时，主要需要补充对应的解析器和调用图提取器。

### 3.2 增量检测

全量构建需要处理大量代码单元，重复调用 LLM 的成本和耗时较高。文件级 hash 只能判断"文件是否变化"，无法定位具体变更的方法。因此，系统引入三层 Merkle Tree（root → file → code_unit）进行方法级变更检测。

![三层 Merkle Tree](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/merkle-tree.png)

比较算法自顶向下进行，哈希相同的子树直接跳过。

变更检测之后是级联失效：一个代码单元变化后，其所在的文件摘要、包摘要、仓库总览均需按需刷新。

![级联失效](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/cascade-invalidation.png)

Merkle 快照以 JSON 格式落盘。首次运行没有历史快照，需要全量生成；后续修改少量方法时，只重新处理变更单元及受其影响的上层摘要。在当前已验证的仓库中，日常小范围变更触发的 LLM 重新生成通常为个位数量级。

### 3.3 调用图构建

从 AST 中提取方法调用关系，构建双向调用图（caller ↔ callee）。解析策略涵盖构造器调用、this 引用、字段类型推断、局部变量推断、静态调用和按名称回退等模式。

这种静态调用图无法完整覆盖反射、动态代理和运行时分派，关系质量也会受到代码规范程度影响。因此，调用图用于缩小上下文范围，而不是替代编码阶段对关键源码的再次确认。

### 3.4 LLM 描述生成

这个阶段包含三个子问题：依赖上下文如何组装、prompt 如何约束 LLM 的输出质量、哪些代码不需要经过 LLM。

#### 依赖上下文组装

仅提供单个方法的源码时，LLM 的输出通常是代码的直译（"获取参数，调用方法，返回结果"），缺乏业务语义理解。将整个文件作为上下文会导致 token 浪费且引入无关代码的干扰。

最终方案是在调用图上做 BFS 遍历，精确收集关联函数的源码注入 prompt：

![调用图 BFS 遍历组装上下文](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/bfs-context-assembly.png)

#### 用代码证据约束业务断言

LLM 生成业务描述时，一个突出问题是断言看似合理却缺乏依据。例如，它可能声称某方法"用于风控校验"，而代码中并不存在对应逻辑。

为此，prompt 要求每条从源码提取的 business_rule 附带 evidence（field / type / quote / reason）；没有证据的断言必须标记为 candidate。confidence 用于结果排序和复核提示，不替代研发判断。

以下是一个实际生成结果片段：

```json
{
  "summary": "广告组创建时判断是否自动开启平滑投放",
  "business_domain": "投放域",
  "business_rules": [
    "仅 CPM 计费模式允许开启平滑投放",
    "flowMode 必须为 delivery"
  ],
  "evidence": [
    {
      "field": "business_rules",
      "type": "condition",
      "quote": "if (settleType != SettleType.CPM)",
      "reason": "存在显式的计费模式校验，非 CPM 时直接返回 false"
    },
    {
      "field": "business_rules",
      "type": "condition",
      "quote": "if (flowMode != FlowMode.DELIVERY)",
      "reason": "存在显式的流量模式校验"
    }
  ],
  "confidence": 0.85
}
```

evidence 约束不能消除幻觉，但可以减少无依据断言，并让错误更容易审查。当前示例保留的是代码片段级证据；要支持长期追溯，还需要进一步绑定文件、方法、代码版本等定位信息。

#### 模式化基础代码走规则引擎，业务代码走 LLM

DTO、VO、Config、Mapper 等结构类代码的描述模式相对固定，无需全部消耗 LLM 资源。系统根据包名关键词、类后缀和注解（如 @Data、@Getter）进行路由：模式化基础代码由规则引擎处理，业务核心代码交给 LLM。以一个中等规模的广告投放仓库为例，约 1200 个代码单元中，约 500 个由规则引擎处理，其余约 700 个进入 LLM 生成流程。

### 3.5 交叉索引：知识库的核心产物

函数级描述生成后，流水线继续聚合文件摘要、包摘要、仓库总览和业务流摘要。交叉索引（cross-ref）再将这些中间结果组织成适合 LLM 渐进读取的结构化文档，是 Wiki Bundle 中最核心的代码事实入口。

#### 文件组织：以类为单位

每个业务核心类生成一个交叉索引文件（如 `cross-ref-AdgroupService.md`）。不是所有类都会生成，系统过滤掉 DTO、VO、Config、Util 等公域类，只为 Service、Controller、Job、Consumer 等业务核心类生成。以类为单位的原因是：业务约束通常围绕核心类的方法组织，LLM 在实现需求时也是按类来定位需要关注的约束。

#### 文件结构：目录先行

每个交叉索引文件的核心设计是方法目录表放在文件开头：

```
# 交叉索引：AdgroupService
## 方法目录
| 方法 | 约束数 | 风险数 | 摘要 |
|------|--------|--------|------|
| shouldOpenSmoothOnCreate | 5 | 2 | 限制：CPM计费、delivery流量模式 |
| processDaypartSmartControl | 4 | 1 | 时段配置校验、预算下限 |
| directUpdate | 3 | 1 | 预算/出价直接更新 |
| ... | | | |
## 按方法的约束与风险
### shouldOpenSmoothOnCreate
> 广告组创建时判断是否自动开启平滑投放
**约束**
- 仅 CPM 计费模式允许开启 (confidence: 0.85)
- flowMode 必须为 delivery (confidence: 0.85)
...
```

示例中只展示能够从现有代码提取的 CPM 和 flowMode 约束。"平滑投放与新增时段调控是否互斥"属于跨功能判断，不应混入自动生成的交叉索引，而应在研发确认后进入领域知识，并在消费阶段与代码事实一起呈现。

方法目录表只有几十行，包含每个方法的约束数量和一行摘要。LLM 先读目录，根据方法名和摘要判断哪些方法与当前需求相关，然后只选读相关方法的详细约束段落。这个"先读目录、再选读详情"的策略，是 wiki-reading skill 四阶段流程的基础。

#### 截断策略：按方法限额而非全局截断

每个方法最多展示 3 条约束和 2 条风险（按置信度排序），超出的部分标注"还有 N 条约束，详见 30-rules/ 目录"。

早期版本采用过全局截断（全文只保留前 15 条约束 + 10 条风险），但效果不好：约束多的方法占满了预算，约束少但同样重要的方法被完全截掉。改为按方法限额后，每个方法至少保留其最重要的约束，不会因为其他方法约束多就被挤掉。

#### 方法排序

方法目录表按"约束数 + 风险数"降序排列，约束最密集的方法排在最前面，LLM 优先看到最关键的内容。

### 3.6 运行时配置语义注入

代码中广泛通过统一配置中心 Diamond 的 `getConfig(dataId, groupId)` 读取运行时配置，但仅凭调用语句无法知道配置的实际内容和业务含义。如果知识库只记录"读取了某项配置"，对约束发现的帮助有限。

当前流程分为四步：扫描 Diamond 调用 → 拉取配置并对 password、token 等字段脱敏 → 生成配置业务摘要 → 将摘要注入相关代码单元。信息按字段、getter 和监听链路传播，避免把整份配置无差别注入所有方法。

以某仓库的一个 Diamond 配置类为例：

| | 注入前 | 注入后 |
|---|---|---|
| 描述 | 读取 Diamond 配置并监听变更 | 通过 Diamond 获取点击日志过滤规则，包含无效渠道 ID 列表和 MD5 校验白名单，配置变更时自动刷新本地缓存 |

迭代过程：初始版本仅处理字面量和 `static final` 常量。第一个仓库验证时发现大量 `@Value` 注入的配置未被覆盖，补充了 `@Value → properties` 解析链路。第二个仓库暴露了混合参数模式（同一个调用中 dataId 用常量、groupId 走 `@Value`），进一步将参数解析改为逐参数独立解析并增加了局部变量遮蔽检查。每个仓库的验证都推动了新的模式支持。

截至目前在 4 个仓库的验证结果：
![Diamond 配置注入示例](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/diamond-config-example.png)


已知限制：动态拼接 dataId 或 groupId 的场景无法通过静态分析覆盖，需要手动补充引用；拉取结果还与 Diamond 环境和时间点相关，"扫描到"与"拉到"的差距不能直接等同于提取质量。用于生产环境时，还需要记录环境与更新时间，并通过字段白名单、访问控制和审计机制降低敏感配置进入模型上下文的风险。

## 四、知识消费：Spec + Wiki 飞轮
Wiki Bundle 生成后，需要接入 LLM 的需求实现流程才能发挥价值。本章介绍基于 OpenSpec 框架的适配方案及验证结果。

### 4.1 原始 OpenSpec 的不足

OpenSpec 是一个 Spec 驱动开发框架：`/opsx-propose`（生成方案）→ `/opsx-apply`（编码）→ `/opsx-archive`（归档）。每步产出对应的文件：`proposal.md`（方案和约束）、`design.md`（设计）、`tasks.md`（任务拆分）。研发在 proposal 阶段 review。

原始流程在 propose 阶段只根据需求做方案设计，并不会主动读取 CodeWiki。它能够给出配置模型、调度任务、通知流程等合理模块，但难以主动发现已有代码中的复用入口、字段条件和跨功能约束。具体案例见 4.5 节。

### 4.2 适配方案：在 OpenSpec 前后插入知识读写

适配时没有直接修改 OpenSpec 的框架文件，而是通过封装命令在 propose 前增加知识读取、在 archive 前增加知识归档：

![OpenSpec 适配方案](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/openspec-adaptation.png)

![扩展文件接入](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/openspec-extension-files.png)

框架侧通过 4 个扩展文件完成最小接入；实际落地还需要放置 Wiki Bundle，并配置仓库路径、模型和必要的访问权限。

### 4.3 wiki-reading skill 的设计

直接把整个 Wiki Bundle 注入上下文既浪费 token，也会让 LLM 难以判断重点。因此，wiki-reading skill 使用"先定位、再选读、后自查"的四阶段流程：

![wiki-reading 四阶段流程](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/wiki-reading-flow.png)

关键设计选择：

* 先读领域知识、再读交叉索引：领域知识中的同类功能和跨功能关系可以帮助 LLM 缩小代码事实的选读范围。
* 领域知识使用具体文件名（如 `runtime-bid-budget-tuning.md`）：LLM 会先依据文件名判断相关性，过度抽象的命名更容易漏检。
* 约束清单逐条标注来源：cross-ref 表示源码事实，domain-knowledge 表示已确认的领域规则，研发本轮新增的判断则使用 `[suggest-wiki]` 等待归档。

### 4.4 由研发标注驱动领域知识归档

领域知识的回写由研发添加的 `[suggest-wiki]` 标注触发，而不是让 LLM 自主判断。因为 LLM 很难稳定区分"代码中已有、应由交叉索引覆盖的事实"和"代码中没有、需要沉淀的跨功能规则"。引入研发确认，可以减少重复知识和错误经验被长期固化的风险。

归档 skill 只处理被标注的条目：读取已有领域知识，完成去重后写入新增内容；没有研发标注则跳过。换言之，飞轮自动化的是归档动作，不是领域规则的最终判断。

### 4.5 单案例验证：约束发现是否改善

我们选择"投放时段智能调控"作为单案例，在同一个仓库、同一套 OpenCode + GPT-5.4 环境下进行分层对照。这个案例用于观察知识层带来的变化，不代表跨仓库、跨需求的普遍结论。

研发在运行前预设 9 个检查点，覆盖方法复用、互斥关系和计费约束等内容。评分采用三级口径：未出现记 0 分，只给出方向但缺少关键条件记 0.5 分，完整命中记 1 分。下表摘列其中 3 个代表性检查点：

![检查点示例](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/checkpoint-table.png)

对照结果：

![对照结果](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/comparison-results.png)

纯 OpenSpec 的 proposal 在架构层面能够给出合理设计，但对 9 项既有业务约束只部分触及 1 项，得分为 0.5。要进入编码阶段，研发仍需补充完整的约束清单。

加入交叉索引后，LLM 能定位应该复用的方法和需要检查的字段，proposal 得分提升到 4.5；不足主要集中在跨方法、跨功能的适用关系上，例如知道需要校验计费模式，却无法仅凭旧代码确认新功能是否同样"仅 CPM 可用"。

经过一轮飞轮（propose → 研发 review 并标注 `[suggest-wiki]` → archive 回写领域知识）后，领域知识补上了"仅 CPM 计费""flowMode = delivery"等代码中不存在的业务规则，proposal 得分提升到 7.5/9（严格打分标准）。仍有少数检查点未精确命中（Tair 去重只提到"幂等处理"未指明具体方案，settleStatus 过滤始终未命中）。

proposal 阶段为 7.5/9，进入 apply 阶段后最终代码覆盖了 9 个检查点。这里不能把 9/9 全部归因于 CodeWiki：编码阶段仍会读取相关源码。更准确的解释是，proposal 中的约束为后续源码定位提供了方向，减少了在成熟系统中"从零寻找规则"的工作。

分层对照（非严格消融实验）：

![分层对照](/vibe-reading/images/articles/gaode-blogs-codewiki-llm-code-knowledge-base/layered-comparison.png)

在这个案例中，交叉索引和一轮领域知识归档分别带来了约 4 分和 3 分的增量，说明两层知识解决的问题不同。但本次验证只有一个需求、一次输出，并且归档后再次使用了同一需求，可能存在知识回放效应。因此，数字只能反映趋势。后续需要用新的相关需求、多次运行和研发耗时等指标验证泛化能力。

## 五、局限与未来方向

目前的结果说明"把业务约束显式化"能够改善单案例中的约束发现，但距离稳定支撑端到端需求实现仍有差距。下一阶段重点推进三个方向：

中间件资源接入：在配置中心语义注入的基础上，继续识别 Redis、Tair、MQ、RPC 等资源，让 Wiki 理解 key、topic、接口、缓存、幂等和分布式锁等运行时约束。

多仓库 Wiki：打通跨仓库依赖、配置引用和业务链路，形成产品级知识全景，补足单仓知识库难以回答的跨系统影响面。

端到端验证与知识治理：在新的真实需求上进行多次运行，补充约束覆盖率、研发耗时和返工轮数等指标；同时为领域知识增加版本、负责人、确认时间和冲突检测机制。

## 六、结语
在成熟系统中，LLM 面临的核心挑战不是"能不能写出代码"，而是"能不能在修改代码前理解并遵守已有业务约束"。CodeWiki 的作用也不是让模型一次读取更多源码，而是把分散的代码事实和隐性的领域规则转化为可追溯、可评审、可持续更新的知识资产。

交叉索引负责保持代码事实与源码同步，领域知识负责沉淀研发确认的跨功能规则，wiki-reading 流程再把两者带入方案设计和编码。当前单案例已经显示出约束发现能力的改善，但系统的长期价值仍需要通过更多新需求、跨仓库验证以及知识新鲜度治理来证明。只有当知识能够随着代码演进而更新，并在不确定时可靠地回退到源码，LLM 才可能从"生成一个看似可用的功能"进一步走向"在复杂系统中完成可信的需求实现"。
