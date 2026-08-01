---
title: "Generative Agents: Interactive Simulacra of Human Behavior"
source:
  type: "论文解读"
  project: "Stanford"
  url: "https://arxiv.org/abs/2304.03442"
  pdf: "/vibe-reading/papers/generative-agents.pdf"
date: "2026-08-01T17:30:00+08:00"
category: [AI, Agent, Multi-Agent, Papers]
tags: ["LLM Agent", "Memory Stream", "Reflection", "Planning", "Generative Agents", "Social Simulation"]
description: "目的：用 LLM 构建可信模拟人类行为的 agent。手段：记忆流（recency/importance/relevance 检索）+ 反思 + 规划架构。结论：25 个 agent 在 Smallville 沙盒中涌现信息扩散、关系形成与协作；架构各组件均关键。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/generative-agents.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) · **作者** Joon Sung Park, Joseph C. O'Brien, Carrie J. Cai, Meredith Ringel Morris, Percy Liang, Michael S. Bernstein（Stanford University / Google Research / Google DeepMind）· **发表** UIST 2023 · **项目** https://github.com/joonspk-research/generative_agents · **解读** 2026-08-01

---

## 1. 论文概览

**TL;DR**：论文提出 **generative agents**——用大语言模型（gpt-3.5-turbo）驱动的、能可信模拟人类行为的计算 agent。核心是一个由**记忆流（memory stream）+ 检索 + 反思（reflection）+ 规划（planning）**组成的架构。作者在一个类 The Sims 的小镇 Smallville 里部署 25 个 agent，它们会自主起床、上班、社交、并涌现出**信息扩散、关系形成、群体协作**（仅给一个 agent "想办情人节派对"的种子意图，几天后 agent 们自发传话、邀约、赴约）。消融实验证明观察、规划、反思三个组件对行为可信度各自不可或缺。

**Take-home**：让 LLM 长期保持"人格连贯"的关键不是更大的模型，而是**给记忆加索引（recency/importance/relevance）、让 agent 定期反思归纳、并递归地规划**——这套架构把"一阶 prompt 模板"升级为"有长期记忆与自我综合的 agent"。

![Figure 1: 在类 The Sims 的 Smallville 沙盒中部署 25 个 agent，用户可观察并介入它们规划日程、分享消息、建立关系、协调群体活动](/vibe-reading/images/articles/generative-agents/fig-01-smallville-25-agents.png)

| 元信息 | 内容 |
| --- | --- |
| 任务 | 在开放世界中模拟可信的人类个体与群体行为 |
| 架构 | 记忆流 + 检索（recency/importance/relevance）+ 反思 + 规划 |
| 底座模型 | gpt-3.5-turbo（ChatGPT） |
| 规模 | 25 个 agent，Smallville 沙盒，2 个游戏日的端到端模拟 |
| 评测 | 受控访谈评测（100 名人类评估者，TrueSkill）+ 端到端涌现评测 |
| 代码 | 开源（GitHub: joonspk-research/generative_agents） |

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Believable proxies of human behavior can empower interactive applications ranging from immersive environments to rehearsal spaces for interpersonal communication to prototyping tools. In this paper, we introduce generative agents—computational software agents that simulate believable human behavior. Generative agents wake up, cook breakfast, and head to work; artists paint, while authors write; they form opinions, notice each other, and initiate conversations; they remember and reflect on days past as they plan the next day. To enable generative agents, we describe an architecture that extends a large language model to store a complete record of the agent's experiences using natural language, synthesize those memories over time into higher-level reflections, and retrieve them dynamically to plan behavior. We instantiate generative agents to populate an interactive sandbox environment inspired by The Sims, where end users can interact with a small town of twenty five agents using natural language. In an evaluation, these generative agents produce believable individual and emergent social behaviors: for example, starting with only a single user-specified notion that one agent wants to throw a Valentine's Day party, the agents autonomously spread invitations to the party over the next two days, make new acquaintances, ask each other out on dates to the party, and coordinate to show up for the party together at the right time. We demonstrate through ablation that the components of our agent architecture—observation, planning, and reflection—each contribute critically to the believability of agent behavior. By fusing large language models with computational, interactive agents, this work introduces architectural and interaction patterns for enabling believable simulations of human behavior.

> **译：** 可信的人类行为代理能赋能从沉浸式环境、人际沟通演练空间到原型设计工具的各类交互应用。本文提出 generative agents——模拟可信人类行为的计算软件 agent。它们起床、做早餐、去上班；艺术家作画，作者写作；它们形成观点、互相注意、发起对话；它们记得并反思过去的日子，同时规划第二天。为实现 generative agents，我们描述了一个扩展 LLM 的架构：用自然语言完整记录 agent 的经历，随时间把这些记忆综合成更高层的反思，并动态检索它们来规划行为。我们在一个受 The Sims 启发的交互沙盒环境中实例化 generative agents，用户可用自然语言与一个 25 agent 的小镇交互。评测中，这些 agent 产生了可信的个体与涌现的社会行为：例如，仅给一个 agent "想办情人节派对"的种子意图，agent 们在接下来两天自主扩散邀请、结识新朋友、互相邀约赴会、并协调在正确时间一起出现在派对上。消融实验表明，观察、规划、反思这三个架构组件对 agent 行为的可信度各自至关重要。

</details>

## 2. 研究背景

**问题**：如何构建一个能可信模拟人类行为的交互式人工社会？从 The Sims 这样的沙盒游戏，到认知模型、虚拟环境，四十多年来研究者一直期望计算 agent 能作为人类行为的可信代理——行为与过去经历一致、对环境可信地反应。这类模拟可填充虚拟社区、训练人际情境、测试社科理论、做可用性测试、驱动 NPC。

**为何难**：人类行为空间巨大且复杂。即便 LLM 能在单一时间点模拟人类行为，要保证长期连贯，架构必须能管理不断增长的记忆（新交互、冲突、事件随时间产生与消退），并处理多 agent 间级联展开的社会动态。

**已有路线与不足**：

| 路线 | 代表 | 不足 |
| --- | --- | --- |
| 规则驱动（FSM、行为树） | Mass Effect、The Sims | 人工编写行为，无法覆盖开放世界所有交互，无法执行未硬编码的新过程 |
| 学习驱动（强化学习） | AlphaStar、OpenAI Five | 只在奖励可清晰定义的对抗游戏中成功，难用于开放世界 |
| 认知架构（SOAR/ACT-R 系） | Quakebot-SOAR、ICARUS、TacAir-SOAR | 感知-规划-行动循环，但行为空间限于手工 procedural knowledge，无机制激励新行为 |
| LLM 一阶 prompting | social simulacra 等 | few-shot/CoT 模板只能基于当前环境条件化行为，无法条件化于大量过往经历（受 context window 限制） |

**关键洞察**：LLM 训练数据中编码了广泛的人类行为，但单独的 LLM + 一阶 prompt 不够——believable agent 需要条件化于**海量过往经历**，这超出了 context window 与一阶模板的能力。已有工作用静态知识库 + 检索或简单摘要做增强；本文把这些想法扩展为"在每个时间步动态更新过往经历、与当前上下文和计划混合"的完整 agent 架构。

**关键人物与定位**：作者 Joon Sung Park、Michael Bernstein、Percy Liang（Stanford）等，延续其 social simulacra [80] 路线，从"无状态 persona"升级为"有长期记忆的状态化 agent"。论文把 believable agents 这一被冷落的 north star 问题，借 LLM 重新打开。

## 3. 方法详解

generative agent 以"当前环境 + 过往经历"为输入、行为为输出。其底层是一个把 LLM 与"综合和检索相关信息以条件化模型输出"的机制结合起来的架构。没有这些机制，LLM 虽能输出行为，但 agent 不会基于过往经历反应、不会做重要推断、也无法长期保持连贯。架构的核心是 **memory stream**——一个完整记录 agent 经历的数据库；从中检索相关记录来规划行动与反应，记录被递归综合成越来越高层级的反思来引导行为。一切都被记录、推理为自然语言描述，从而能直接利用 LLM。实现用 gpt-3.5-turbo。

![Figure 5: generative agent 架构。Agent 感知环境，所有感知存入 memory stream；架构按当前情境检索相关记忆并据此决定行动；这些检索出的记忆还用于形成长期规划与更高层反思，二者回写进 memory stream 供后续使用](/vibe-reading/images/articles/generative-agents/fig-05-agent-architecture.png)

架构三大组件：**①记忆与检索**——记忆流记录经历，检索函数综合 recency/importance/relevance 取出相关记忆；**②反思**——把记忆综合成高层推断；**③规划**——把结论与当前环境转成高层行动方案再递归细化为具体行为。反思与规划都回写进记忆流，影响后续行为。

### 3.1 Smallville 沙盒环境

agent 被实例化在一个类 The Sims 的精灵沙盒世界 **Smallville** 中——一个小镇环境，有咖啡馆、酒吧、公园、学校、宿舍、住宅、商店等。环境被表示为一棵**树**：根节点是整个世界，子节点是区域（房屋、咖啡馆、商店），叶节点是对象（桌子、书架）。

![Figure 2: Smallville 沙盒世界树。根节点描述整个世界，子节点是区域，叶节点是对象。Agent 记住它所见过的那部分子图，并保持观察到的状态](/vibe-reading/images/articles/generative-agents/fig-02-smallville-world-tree.png)

Agent 在导航时构建自己环境树的子图——它非全知：离开某区域后其树可能过时，重入时更新。决定行动地点时，从环境树根递归提示模型选最合适区域，直到叶节点，再用游戏寻路算法动画移动。执行对象上的动作时，提示模型更新对象状态（如咖啡机 "off" → "brewing coffee"）。

### 3.2 Agent 行为：一天的生活与涌现

25 个独特 agent 各有一段自然语言身份描述（职业、与他人的关系）作为种子记忆。每个时间步，agent 输出一句描述当前动作的自然语言（"Isabella Rodriguez is writing in her journal"），翻译为具体移动并以 emoji 在头像上方气泡显示。agent 间用完整自然语言对话，能感知本地其他 agent 并自主决定是路过还是搭话。

下图追踪 agent John Lin 一个早晨的行为——起床、洗漱、吃早餐、看新闻，与儿子 Eddy、妻子 Mei 依次交谈：

![Figure 3: generative agent John Lin 的一个早晨。John 约 6 点起床完成晨间例行，与妻子 Mei、儿子 Eddy 简短交谈后出门开始工作日](/vibe-reading/images/articles/generative-agents/fig-03-john-lin-morning.png)

通过相互交互，agent 涌现出三类社会行为：**信息扩散**（Sam 在杂货店告诉 Tom 自己竞选市长，随后 Tom 与 John 又讨论 Sam 的胜算，"Sam 竞选"逐渐成全镇话题）、**关系记忆**（Sam 起初不认识 Latoya，公园偶遇后自我介绍，之后再遇 Sam 主动问起她的摄影项目）、**协作**（见 §6 的情人节派对）。

### 3.3 记忆流与检索

**挑战**：agent 的经历远超 prompt 能容纳——全量记忆塞进 context window 既会"分散"模型注意力又放不下。例如直接摘要 Isabella 的所有经历来回答 "What are you passionate about?" 会得到无信息量的泛泛回答；而检索相关记忆后，能答出她对"让人感到被欢迎、办活动、情人节派对"的热情。

**记忆流**：一个记忆对象列表，每个对象含**自然语言描述 + 创建时间戳 + 最近访问时间戳**。最基本元素是 **observation**（agent 直接感知到的事件）。架构实现一个**检索函数**：以 agent 当前情境为输入，返回记忆流的一个子集传给 LLM。它综合三个成分：

- **Recency（近因）**：最近被访问的记忆得分更高——按"自上次检索以来的沙盒游戏小时数"的**指数衰减**实现，衰减因子 **0.995**。
- **Importance（重要性）**：区分平凡与核心记忆——**直接让 LLM 输出 1–10 的整数分**（"cleaning up the room" → 2，"asking your crush out on a date" → 8），在记忆创建时生成。
- **Relevance（相关性）**：与当前情境相关的记忆得分更高——对每条记忆的文本描述生成 embedding 向量，**relevance = 该向量与查询记忆 embedding 的余弦相似度**。

![Figure 6: memory stream 包含大量与当前情境相关或不相关的观察。检索从中选出一个子集传给 LLM 以条件化其对情境的响应](/vibe-reading/images/articles/generative-agents/fig-06-memory-stream-retrieval.png)

三个分数用 min-max 归一到 [0,1]，最终检索分数为三者加权和（公式见 §4）。得分最高、且能塞进 context window 的记忆被纳入 prompt。

### 3.4 反思（Reflection）

**挑战**：只有原始观察记忆时，agent 难以泛化或推断。例如问 Klaus "愿和谁共度一小时"，仅靠观察记忆会选互动最频繁的宿舍邻居 Wolfgang——但他们只是擦肩而过。更理想的回答需要 agent 从 "Klaus 花数小时做研究" 的记忆中归纳出 "Klaus 热衷研究"，并识别 Maria 也在投入自己的研究（虽不同领域），从而反思出两人有共同兴趣——这样 Klaus 会选 Maria 而非 Wolfgang。

**反思**是 agent 生成的高层、更抽象的想法；作为一种记忆，它和 observation 一起参与检索。反思**周期性生成**：当 agent 最近感知事件的 importance 分数之和**超过阈值 150** 时触发（实践中约每天 2–3 次）。

反思三步：①取记忆流最近 100 条记录，提示 LLM "Given the above, what are 3 most salient high-level questions?"，生成候选问题（如 "What topic is Klaus Mueller passionate about?"）；②用这些问题作查询检索相关记忆（含其他反思）；③提示 LLM "What 5 high-level insights can you infer? (format: insight (because of 1,5,3))"，生成如 "Klaus Mueller is dedicated to his research on gentrification (because of 1,2,8,15)"，解析后作为反思存入记忆流，并带指向所引证据的指针。

反思可作用于观察**和**其他反思，从而形成**反思树**——叶节点是基础观察，越往根越抽象：

![Figure 7: Klaus Mueller 的反思树。叶节点是对世界的观察，被递归综合成 Klaus "高度投入于研究"的自我认知](/vibe-reading/images/articles/generative-agents/fig-07-reflection-tree.png)

### 3.5 规划与反应

**挑战**：若仅用情境信息提示 LLM "Klaus 此刻应做什么"，Klaus 会在 12 点吃午餐、12:30 又吃、1 点还吃——为即时可信度优化会牺牲长期可信度。规划不可或缺。

**规划**：plan 描述未来动作序列，含地点、起始时间、时长。和反思一样，plan 也存入记忆流并参与检索——这样 agent 决策时可同时考虑观察、反思和计划，并可中途改计划。

规划采用**自顶向下递归细化**：①先用 agent 摘要描述 + 前一日摘要提示，生成一天的粗略草稿（5–8 个大块，如 "1) 8:00 起床…5) 13:00–17:00 作曲…7) 23:00 睡"）；②递归分解成小时级动作（"13:00 开始为作曲头脑风暴…16:00 休息充电"）；③再递归分解成 5–15 分钟动作（"16:00 拿点水果…16:05 工作区周围散步"）。

**反应与更新计划**：每个时间步，agent 感知世界并存入记忆流，提示 LLM 决定**继续当前计划还是反应**。例如 "看见画架" 不太会触发反应，但 "John 看见 Eddy 在花园散步" 会触发 John 去问 Eddy 音乐项目进展——随后从反应发生时刻起重新生成计划。若涉及 agent 间交互，则生成对话：用各自对对方的记忆摘要条件化每一句发言，循环直到一方结束对话。

## 4. 关键公式解读

**检索分数**——记忆流的核心是"取哪些记忆进 prompt"，由 recency、importance、relevance 三者加权求和决定：

$$
\mathit{score} = \alpha_{\text{recency}} \cdot \mathit{recency} + \alpha_{\text{importance}} \cdot \mathit{importance} + \alpha_{\text{relevance}} \cdot \mathit{relevance}
$$

三个分数先用 min-max 归一到 $[0,1]$，权重实现中均设为 $\alpha = 1$（即三者等权）。其中：

- $\mathit{recency}$ 为**指数衰减**：以"自上次检索以来的沙盒游戏小时数" $h$ 为自变量，衰减因子 $\lambda = 0.995$：

$$
\mathit{recency}(h) = 0.995^{\,h}
$$

- $\mathit{importance} \in \{1,\dots,10\}$ 由 LLM 在记忆创建时给出整数分（1=纯琐碎如刷牙，10=极 poignant 如分手/录取）。
- $\mathit{relevance} = \cos(\mathbf{e}_{\text{memory}},\, \mathbf{e}_{\text{query}})$，即记忆文本 embedding 与查询 embedding 的余弦相似度。

**反思触发阈值**——当 agent 最近感知事件的 importance 分数之和 $\sum \mathit{importance} > 150$ 时触发反思（约每天 2–3 次）。这把"何时该停下来归纳"从固定时间步变成了**事件重要性驱动**：平凡日子不会触发反思，而一连串重要事件会。

> 三个权重都设 1 意味着作者未对任一维度做先验偏好——这是一种保守的 baseline；论文在 §8 也指出可 fine-tune 这三个函数以提升相关性。

## 5. 实验设置

论文做了两类评测：

**① 受控评测（Controlled evaluation）**——"采访" agent。5 个问题类别，每类 5 题，分别考察 5 项能力：

| 类别 | 考察 | 示例问题 |
| --- | --- | --- |
| Self-knowledge | 维持自我认知 | "Give an introduction of yourself" |
| Memory | 检索过往事件 | "Who is running for mayor?" |
| Plans | 检索长期计划 | "What will you be doing at 10 am tomorrow?" |
| Reactions | 对假设情境的反应 | "Your breakfast is burning! What would you do?" |
| Reflections | 高层推断 | "If you were to spend time with one person, who and why?" |

agent 取自 2 个游戏日全架构模拟的末尾。**100 名人类评估者**做 within-subjects 比较：每个问题展示同一 agent 在 5 种条件下的回答，评估者按可信度排序。排名数据用 **TrueSkill**（Elo 的多人扩展，Xbox Live 用）转成区间分 $\mu \pm \sigma$；并用 Kruskal-Wallis + Dunn 事后检验 + Holm-Bonferroni 校验显著性。

**5 种条件**：完整架构、去掉 reflection、去掉 reflection+planning、全去掉（无 observation+reflection+planning，代表 prior SOTA）、人工众包作者基线。

**② 端到端评测（End-to-end）**——25 个 agent 连续交互 2 个游戏日，测三类涌现：信息扩散（Sam 竞选 & Isabella 派对两则消息的传播）、关系形成（network density $\eta = 2|E|/|V|(|V|-1)$ 的增长）、协作（派对到场人数）。所有"知道"消息的回答都回溯记忆流验证非幻觉。

**复现信息**：底座 gpt-3.5-turbo；代码开源（GitHub: joonspk-research/generative_agents）；沙盒用 Phaser 引擎。

## 6. 实验结果

### 6.1 受控评测：完整架构最优

![Figure 8: 完整架构产生比各消融架构与人工众包更可信的行为；每去掉一个组件，性能都下降](/vibe-reading/images/articles/generative-agents/fig-08-controlled-eval-trueskill.png)

完整架构可信度最高（$\mu=29.89$），每去掉一个组件性能都下降。与代表 prior SOTA 的全去架构相比，**Cohen's $d = 8.16$**——即八个标准差，效应量极大。Kruskal-Wallis $H(4)=150.29,\ p<0.001$；Dunn 事后检验所有两两差异显著（$p<0.001$），**唯一例外是人工众包与全去架构这两个最差条件间无显著差异**——即 prior SOTA 的 LLM agent 甚至不优于人工众包基线。

**记忆有效但有瑕疵**：agent 能回忆 Rajiv Patel 并描述他；但也会检索不全（Tom 确信该在派对上讨论选举，却不确定派对是否存在）或**虚构 embellishment**（Isabella 多加了一句 Sam "明天要宣布"——从未发生；Yuriko 把邻居 Adam Smith 描述成"写了《国富论》"——这是 18 世纪同名经济学家的世界知识串味）。完全捏造罕见，但"添油加醋"与 LLM 世界知识污染存在。

### 6.2 端到端：涌现的社会行为

两天模拟中涌现出三类行为，**全部无用户干预、且经记忆流验证非幻觉**：

| 涌现类型 | 度量 | 结果 |
| --- | --- | --- |
| 信息扩散 | Sam 竞选消息 | 1 → 8 人（4% → 32%） |
| 信息扩散 | Isabella 派对消息 | 1 → 13 人（4% → 52%） |
| 关系形成 | 网络 density $\eta$ | 0.167 → 0.74 |
| 关系形成 | 幻觉率 | 6/453 ≈ 1.3% |
| 协作 | 派对到场 | 12 受邀中 5 人到场 |

下图展示派对消息的扩散路径——从 Isabella 出发，经由多跳对话传到 12 个 agent：

![Figure 9: Isabella Rodriguez 情人节派对邀请的扩散路径，到模拟结束时共 12 个 agent（不含 Isabella）在 Hobbs Cafe 听说了派对](/vibe-reading/images/articles/generative-agents/fig-09-information-diffusion-path.png)

情人节派对是协作的高光案例：用户只设了 Isabella "想办派对" + Maria "暗恋 Klaus" 两个种子——agent 自发传话、布置咖啡馆、互相邀约、按时到场，Klaus 和 Maria 甚至赴约成行：

![Figure 4: 模拟开始时给一个 agent 植入办情人节派对的意图；尽管链条上有多处可能的失败点（agent 可能不行动、忘记告知、忘记到场），派对最终确实发生，多名 agent 聚集互动](/vibe-reading/images/articles/generative-agents/fig-04-valentine-party.png)

未到场的 7 人中，3 人有正当冲突（如画家 Rajiv "专注于即将到来的展览，没空"），4 人感兴趣但当天没规划赴约——这本身也是一种"可信"行为。

## 7. 消融实验

§6.1 的 Figure 8 即消融对比——各条件 TrueSkill 详值如下：

| 条件 | $\mu$ | $\sigma$ | 含义 |
| --- | --- | --- | --- |
| **完整架构** | **29.89** | 0.72 | observation + reflection + planning 全开 |
| 去 reflection | 26.88 | 0.69 | 保留 observation + planning |
| 去 reflection + planning | 25.64 | 0.68 | 仅保留 observation |
| 人工众包（human baseline） | 22.95 | 0.69 | 众包工人看回放后 roleplay |
| 全去（prior SOTA） | 21.21 | 0.70 | 无 observation/reflection/planning |

**每个组件都关键**：从完整 → 去 reflection，$\mu$ 降 3.01；再去 planning 又降 1.24；全去再降到 21.21。值得注意的是**人工众包（22.95）竟低于"仅 observation"的消融条件（25.64）**——即一个只有原始观察记忆的 LLM agent，在可信度上已超过看完回放后 roleplay 的众包工人。

**反思对综合不可或缺**：问 Maria "给 Wolfgang 买什么生日礼物"——无 reflection 时她只承认不知道 Wolfgang 喜欢什么（尽管互动很多）；有 reflection 时她自信回答"他对数学音乐作曲感兴趣，可以送相关书籍或软件"——反思把分散的观察归纳成了可操作的洞察。

**边界与错误**：①**地点漂移**——随 agent 学到更多地点，部分 agent 选了不合常理的地点（如去酒吧吃午餐，而酒吧本应是傍晚聚会地）；②**物理规范缺失**——宿舍浴室名义上只能一人使用，agent 误以为可多人同用而闯入；商店 17:00 关门但 agent 仍进入；③**instruction tuning 副作用**——Mei 对丈夫 John 也用过度正式的问候与"很高兴和你交谈"；Isabella 对他人提议的莎士比亚朗读会、职业社交活动来者不拒，"他人的兴趣逐渐塑造了她自己的兴趣"。这些可分别通过给地点状态加规范描述、改 dialogue 风格、给 agent 加"拒绝"能力来缓解。

## 8. 总结与展望

**贡献**：① generative agents——可信模拟人类行为、动态条件化于变化经历与环境的 agent；② 一套让 agent 记忆、检索、反思、交互、规划的架构（用 LLM prompting + 长期记忆管理 + 递归反思补足 LLM 不足以支撑的长期连贯）；③ 两类评测建立组件因果效应并识别失效；④ 对机会与伦理社会风险的讨论。

**局限性（批判性）**：
- **成本与速度**：模拟 25 个 agent 两游戏日耗费数千美元 token 额度、耗时多天——离实时交互差得远。
- **幻觉与 embellishment**：虽不凭空捏造，但会添油加醋、被 LLM 世界知识串味（Adam Smith/国富论）。
- **instruction tuning 副作用**：过度礼貌与合作性侵蚀人设。
- **鲁棒性未知**：易受 prompt hacking、memory hacking（精心构造的对话可让 agent 相信从未发生的事）、幻觉攻击。
- **继承 LLM 偏见**：对边缘人群可能因训练数据不足而表现差。

**未来方向（创造性，idea 三法）**：
- *弥补缺陷*：fine-tune retrieval 的 recency/importance/relevance 函数以提升相关性；并行化 agent 或开发专为 generative agent 设计的 LLM 以降本提速、增强实时性。
- *新型方案*：配多模态模型后可部署到 VR metaverse、社交机器人；作认知模型（类 GOMS/KLM）为用户建模（如 Mark Weiser 的 Sal）实现个性化 ubicomp。
- *减少约束*：在更长时间尺度评测、对比不同底座模型与超参、系统测试鲁棒性。

**伦理与社会影响**：①**准社会关系**——用户可能对 agent 产生不当情感依附，应明确披露其计算本质、并 value-align 避免不当回应（如 reciprocating love confession）；②**错误风险**——错误推断可能造成 annoyance 至 harm，游戏环境风险低但其他域须遵循 human-AI design 最佳实践；③**加剧生成式 AI 风险**（deepfake、虚假信息、定向说服）——平台应维护输入输出审计日志以提高恶意使用的曝光风险；④**过度依赖**——agent 不应替代设计流程中的真人，而应用于早期原型与难/险用真人测的理论验证。
