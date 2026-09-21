---
title: "CodeMidas: Scaling Agentic Coding RL Environments from Code Itself"
source:
  type: "论文解读"
  project: "MiMo"
  url: "https://arxiv.org/abs/2609.22068"
  pdf: "/vibe-reading/papers/codemidas-agentic-coding-rl.pdf"
date: "2026-09-21T17:07:31+08:00"
category: [AI, Agent, AI Coding, Papers]
contentType: "Papers"
tags: ["Agentic Coding", "RL Environment", "GRPO", "SWE-bench", "CodeMidas", "MiMo-V2.5", "RLHF", "Test Synthesis", "Post-rollout Filtering"]
description: "目的：为 coding agent 的 RL 训练规模化构造可验证环境。手段：CodeMidas 智能体流水线，仅以源代码为任务特定输入——移除已实现功能造任务、以原始代码执行为据造测试、执行一致性 + 三重 post-rollout 过滤。结论：3,185 个开源库产出 5,545 任务（23 语言），GRPO 训练 MiMo-V2.5 后五个外部基准全部提升（DeepSWE +11.7、ProgramBench +17.0）。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/codemidas-agentic-coding-rl.pdf" target="_blank" rel="noopener">预览</a> · **论文** [CodeMidas](https://arxiv.org/abs/2609.22068) · **作者** Bowen Ye, Lei Li, Shicheng Li, et al.（Xiaomi LLM Core · PKU · HKU · RUC，19 人）· **发表** arXiv 2609.22068, 2026-09 · **项目** 暂未公开（论文未附代码/数据链接） · **解读** 2026-09-21

---

## 1. 论文概览

**TL;DR**：训练 coding agent 做 RL 需要两样东西——多样的任务和可靠的验证器，而现有流水线都从开发工件（issue、PR、commit、已有测试、文档）里造任务，任务供给被"代码库里发生过什么"锁死。本文提出 **CodeMidas**：一条只以**源代码**为任务特定输入的智能体流水线——从已有代码库的**已实现功能**反向构造 RL 环境：agent 探索代码库提炼行为规范、以原始代码的执行为依据构造测试、用执行一致性与 post-rollout 过滤保证环境质量。产出 **5,545 个训练任务**（来自 3,185 个开源代码库、23 种语言、15 个技术领域），用 GRPO 训练 MiMo-V2.5 后**五个外部基准全部提升**：DeepSWE 10.0% → 21.7%（+11.7）、ProgramBench 4.5 → 21.5（+17.0）、Terminal-Bench v2.1 63.7% → 72.2%。消融显示高质量任务越多越好，且 5k 精选任务胜过 8k 未过滤任务；轨迹分析显示 RL 后 agent 更会探索代码库、自我验证更多样。

**一句话 take-home**：**已实现的代码本身就是 RL 环境的可扩展矿藏**——移除功能即得任务，执行原始代码即得测试 oracle，论文给这套"点石成金"（Midas touch）配上了完整的质量过滤流水线。

| 维度 | 内容 |
|------|------|
| 作者机构 | Xiaomi LLM Core（一作实习）· 北京大学 · 香港大学 · 中国人民大学 |
| 基座模型 | MiMo-V2.5（Xiaomi） |
| 训练算法 | GRPO + 二值执行奖励 |
| 数据规模 | 5,545 任务 / 3,185 代码库 / 23 语言 / 15 领域 |
| 评测 | SWE-bench Pro、DeepSWE v1.1、ProgramBench、RepoZero C2Rust、Terminal-Bench v2.1 + 自建 CodeMidas Val（200 任务） |

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Training capable coding agents via reinforcement learning (RL) requires diverse tasks with reliable verifiers. Open-source codebases offer a rich source of such tasks, while existing methods typically rely on development artifacts such as issues and commits, limiting the range of tasks that can be extracted. To better scale RL environments, we present CodeMidas, an agentic pipeline that turns implemented functionality in existing codebases into executable RL environments using source code as its only task-specific input. CodeMidas allocates agentic compute to every stage of environment construction: agents explore implemented functionality to formulate behavioral specifications, construct tests grounded in execution of the original code, and validate and filter candidate tasks through execution checks and repeated solution rollouts. The resulting dataset has 5,545 training tasks from 3,185 open-source codebases spanning 23 programming languages and 15 technical domains. Training MiMo-V2.5 on these tasks with GRPO improves performance on all five diverse benchmarks, covering issue repair (DeepSWE + 11.7%), whole-program construction (ProgramBench +17%), and terminal work (Terminal-Bench v2.1 +8.5%). Ablations show that increasing the number of high-quality training tasks improves performance. Trajectory analysis shows the RL-trained agent demonstrates better behaviors like increasing codebase exploration and more diverse self-verification. These results establish source code as a scalable foundation for constructing RL environments that improve coding agents across diverse software tasks.

> **译：** 通过强化学习（RL）训练有能力的 coding agent 需要多样的任务与可靠的验证器。开源代码库提供了此类任务的丰富来源，而现有方法通常依赖 issue 和 commit 等开发工件，限制了可提取任务的范围。为了更好地扩展 RL 环境，我们提出 CodeMidas——一条智能体流水线，仅以源代码作为任务特定输入，将现有代码库中已实现的功能转化为可执行的 RL 环境。CodeMidas 在环境构造的每个阶段都投入智能体算力：agent 探索已实现功能以制定行为规范，以原始代码的执行为依据构造测试，并通过执行检查与重复的解答 rollout 来验证和过滤候选任务。最终数据集包含来自 3,185 个开源代码库的 5,545 个训练任务，覆盖 23 种编程语言和 15 个技术领域。用 GRPO 在这些任务上训练 MiMo-V2.5，在全部五个多样化基准上均有提升，覆盖 issue 修复（DeepSWE +11.7%）、整程序构造（ProgramBench +17%）和终端工作（Terminal-Bench v2.1 +8.5%）。消融显示增加高质量训练任务数量能提升性能。轨迹分析显示 RL 训练后的智能体展现出更好的行为：更多代码库探索和更多样的自我验证。这些结果确立了源代码作为构造 RL 环境的可扩展基础的地位，能跨多样软件任务提升 coding agent。

</details>

---

## 2. 研究背景

**问题定义**：LLM 正在获得 agentic coding 能力——长时程自主完成实质性软件工作。RL 是已验证的路径（SWE-RL、SWE-Universe 等），而有效 RL 的两个前提是：**任务多样性**（支撑泛化）与**奖励可靠性**（只强化正确的工作）。核心挑战由此变为：**如何把真实代码库变成大批量、带可信验证器的训练任务。**

**现有方法为什么不够**：主流流水线全部从**开发工件**出发造任务，论文 Table 1 做了一张很清晰的对比（✓ = 不需要、♦ = 部分需要、✗ = 必需）：

| 方法 | 无需 issue | 无需 PR | 无需 commit | 无需已有测试 | 无需书面描述 | 语言数 |
| --- | --- | --- | --- | --- | --- | --- |
| SWE-rebench V2 | ♦ | ✗ | ✗ | ✗ | ✓ | 20 |
| daVinci-Env | ✗ | ✗ | ✗ | ✗ | ✓ | 1 |
| R2E-Gym | ✓ | ✓ | ✗ | ♦ | ✓ | 1 |
| SWE-smith | ✓ | ♦ | ♦ | ✗ | ✓ | 1 |
| SWE-Flow | ✓ | ✓ | ✓ | ✗ | ✓ | 1 |
| SWE-Hub | ✓ | ✓ | ✓ | ✗ | ♦ | 11 |
| R2E | ✓ | ✓ | ✓ | ✓ | ✗ | 1 |
| MindForge | ✓ | ✓ | ✓ | ✓ | ✗ | 15 |
| **CodeMidas** | ✓ | ✓ | ✓ | ✓ | ✓ | **23** |

每一类都把任务创建**绑死**在某个工件上：从 issue/PR/commit 派生任务陈述（SWE-bench、SWE-rebench、R2E-Gym），围绕已有测试合成故障（SWE-smith、SWE-Flow、SWE-Hub），或用文档指定功能（R2E、MindForge）。任务的覆盖范围 ≤ 开发记录、测试与文档的覆盖范围。

**本文的切入观察**：开源代码库本身（The Stack v2 等大型代码语料覆盖数百种语言）才是更大的矿藏。一段**已实现的功能**同时提供任务的两面——它的公共接口与可观察行为定义了 agent 应该实现什么；**执行原始代码**为测试期望提供了依据。周围的代码库可以改造成保留真实项目结构与依赖的开发起点。这些元素合起来支持从代码直接构造任务陈述、开发环境与可执行验证器。

**三个技术难点**（作者借前人工作点明）：

1. **规范要显式而实现要开放**——任务陈述必须把要求的行为讲清楚，但把内部实现选择留给 solver（Badertdinov et al.）；
2. **测试要拒错纳对**——测试必须拒绝错误解答，同时接受替代性的正确实现（oracle problem，Barr et al. 经典综述；EvalPlus 与 PatchDiff 都记录过弱测试放过错误代码的案例）；
3. **验证器本身要被验证**——SWE-bench Pro 与 SWE-rebench V2 都讨论过规范缺口与过度限制的测试。

**相关工作坐标系**（§2.2）：奖励侧，CodeRL 用单元测试反馈 + 学习的 critic，SWE-RL 用参考补丁相似度，SWE-Shepherd 用过程奖励模型，Agentic Rubrics 用不用测试执行的代码库接地 rubric——CodeMidas 走最朴素的路线：**GRPO + 合成测试的执行奖励，无奖励模型、无学习型验证器**，把全部复杂度放在环境构造侧。

---

## 3. 方法详解

CodeMidas 的每个任务由三部分组成：**任务陈述**、**容器化开发环境**、**隐藏的可执行验证器**。solver 收到陈述与改造后的代码库（含依赖）；验证器保持在 solver 环境之外，只在评分时注入，对完成的实现执行并返回二值执行奖励。

![Fig. 1 CodeMidas 总览：四个模块覆盖任务设计、测试构造、执行一致性与 post-rollout 过滤；金字塔标注各级保留的任务数（22,575 → 16,027 → 12,746 → 11,930 → 8,173 → 5,545）。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-1-overview.png)

流水线四个模块，每个模块都是 **agent 干活**——这是标题里"agentic pipeline"的含义：把智能体算力投到环境构造的每一阶段。

### 3.1 任务设计与代码库改造

Agent 检查代码库结构与构建元数据，识别**有公共入口点和可观察结果**的功能。优先选需要跨代码库推理的任务。支持的接口类型：

| 接口类型 | 可观察行为 |
| --- | --- |
| 命令行工具（CLI） | 进程输出 |
| 纯库函数 | 返回值 |
| 有状态库 API | 跨调用的状态变化 |

对每个候选，agent 追踪公共入口点与共享依赖划定任务范围，**删除选定的核心实现**，调整剩余代码形成连贯的开发起点；任务陈述与代码边界**协同修订**，保留共享组件与项目上下文。原始实现单独保留，作为任务的参考解答。陈述定义输入、可观察行为与要求的公共接口——solver 自己选内部 helper 与算法。

Figure 1 左上给了个具体例子：`serialize(data, pretty)` 函数被移除（右侧 "Remove & refine" 后只剩调用方），任务就是把这个功能补回来。

### 3.2 以执行为据的测试构造

Agent 把任务陈述的行为需求映射为测试输入与边界情况，在**参考副本**上调用公共入口点并记录结果：

- CLI 工具 → 命令执行；
- 纯函数 → 输入-输出用例；
- 有状态 API → 调用序列（含依赖顺序与清理行为）；
- 每条测试记录它覆盖的具体需求。

关键设计在断言的松紧：**陈述固定的**（输出、属性）用参考执行确立期望值；**陈述未固定的**只检查声明的约束——例如强制要求的异常类型，但不固定未指定的报错文案。不同期望输出的用例探测输入依赖行为。

然后一个 agent **复查每条断言**，寻找陈述不支持的约束（精确措辞、偶然顺序、内部结构），替换为行为检查；若断言依赖私有符号且无行为替代，整个任务拒绝。修订后的测试在参考解答上重跑确认兼容。审完后测试输入与断言固定，评分时对提交实现执行。

### 3.3 环境准备与执行一致性

**环境准备**：从统一基础镜像出发，agent 按项目声明安装依赖、准备构建与运行时资源。**清理**会删除可能暴露被删实现的痕迹——编译产物、缓存副本、构造 agent 留下的文件、与目标功能相关的原始测试；保留构建完成的实现所需的包、fixture 与构建包装器。

**执行一致性**：每个任务在训练运行时设定下用**六个新容器**检查——两个放起始代码库、四个放参考解答。要求：起始状态两次**全失败**、参考四次**全通过**（即 fail-to-pass 转移），同时筛掉不稳定的执行结果。

### 3.4 Post-rollout 环境过滤

执行检查只覆盖起点与参考解答；RL 训练前还要用 **agent rollout 的结果**过滤环境，三道关卡：

1. **泄漏过滤**：对抗 rollout 中，一个 agent 专门尝试利用残留泄漏不走正道恢复解答——搜遍 solver 可见的全部环境（编译产物、缓存、构造 agent 的文件、目标项目的已安装副本），记录支撑每个疑似利用的命令与输出；另一个 review 对照参考解答与验证器核查证据，确认可绕过实现工作的任务拒绝。
2. **解答审计**：一个 coding agent 每任务尝试 4 次，reviewing agent 检查 rollout 轨迹（提交代码 + 测试输出）与任务陈述、验证器、参考解答，标记 **FN**（判对却失败）与 **FP**（判错却通过），有验证器缺陷的任务拒绝。
3. **Rollout 结果过滤**：前沿模型每任务多次尝试，由验证器打分。全通过或全失败可能反映任务难度或残留缺陷（弱测试、陈述缺需求）——无法区分原因，只保留**既有成功又有失败**的任务。

### 3.5 数据集概览

![Fig. 2 训练集语言覆盖（Top 10）：Python 21.37%、TypeScript 18.30%、Go 16.18%、C++ 12.53%、JavaScript 11.25%……前十语言覆盖 98.2%，全数据集 23 种语言。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-2-language-coverage.png)

![Fig. 3 训练集技术领域覆盖：Systems 17.42%、Web 14.61%、Dev Tools 13.56% 为三大领域，合计 45.6%。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-3-domain-coverage.png)

最终保留 **5,545 任务 / 3,185 代码库 / 23 语言 / 15 领域**。Python（21.4%）、TypeScript（18.3%）、Go（16.2%）最多，C++（12.5%）与 JavaScript（11.3%）随后；Systems（17.4%）、Web（14.6%）、Dev Tools（13.6%）三大领域合计 45.6%。语言覆盖的广度正是"只以代码为输入"的直接红利——不需要 issue/测试工件，任何语言的开源库都是候选。

![Fig. 4 参考解答规模：任务百分比按等宽 log 区间分组，虚线标中位数 142 行（分段对数 x 轴把 1–10 区间压缩为后续十分之一的宽度）。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-4-solution-size.png)

**参考解答规模**（计入参考补丁中增删的全部源码行，含注释与空行）：中位数 **142 行**，四分位距 66–305 行；**65.9% 的任务参考补丁触及至少两个源文件**——这不是单行 bugfix 级别的任务，而是实打实的跨文件功能实现。

---

## 4. 关键公式解读

CodeMidas 全文刻意保持了"零重型数学"——它的贡献在环境工程而非算法创新。仅有的形式化对象是奖励与优势计算。

**二值执行奖励**。每个任务的验证器对一次 rollout 的提交实现返回通过/不通过：

$$
r_i \;=\; \mathbb{1}\!\left[\,\text{verifier}(\text{submission}_i)\;=\;\text{pass}\,\right] \;\in\; \{0, 1\}
$$

没有奖励模型、没有学习型验证器、没有参考补丁相似度——奖励的全部语义就是"隐藏测试是否通过"。这是把可靠性问题从奖励侧（易被 hack）整体搬到了**环境构造侧**（本文的主战场）。

**GRPO 组相对优势**。同任务的 32 个 rollout 组成一组，优势由组内相对表现计算：

$$
A_i \;=\; r_i - \frac{1}{n}\sum_{j=1}^{n} r_j,
\qquad n = 32
$$

一个值得注意的配置细节（Table A1）：**按标准差做优势归一化被显式关闭**（"Advantage normalization by standard deviation: Disabled"）。二值奖励下组内 std 只取少数几个值（取决于组内通过数），除以它会放大小通过率组别的梯度——关闭它是让不同难度任务的信号强度更可比的朴素选择。

**fail-to-pass 一致性条件**。执行一致性检查的形式化表述——任务 $(T, V)$ 被保留当且仅当：

$$
\forall k \in \{1,2\}:\; V\!\left(s_k^{\text{start}}\right) = \text{fail}
\;\;\wedge\;\;
\forall k \in \{1,\dots,4\}:\; V\!\left(s_k^{\text{ref}}\right) = \text{pass}
$$

即起点状态在两次独立容器执行中稳定失败、参考解答在四次执行中稳定通过——**漏斗从 22,575 个候选任务筛到 5,545 个**（Fig. 1 金字塔），每一级的保留数就是这些检查的量化 footprint。

---

## 5. 实验设置

**训练**：MiMo-V2.5 初始策略，5,545 个 CodeMidas 任务，GRPO，配置摘自 Table A1：

| 设置 | 值 |
| --- | --- |
| 奖励 | 二值验证器结果（0/1），std 归一化关闭 |
| Batch size | 32 |
| 每任务 rollouts | 32 |
| 最大 prompt 长度 | 8,192 tokens |
| **最大响应长度** | **516,096 tokens**（~50 万 token 的交互预算） |
| 每 rollout 最大轮次 | 500 |
| 最大 staleness | 8 |
| 优化器 | Adam，lr 5×10⁻⁶，β=(0.95, 0.95)，ε=10⁻¹⁵ |
| 梯度裁剪 / 权重衰减 | 1 / 0 |

50 万 token 的响应上限与 500 轮交互是全篇最"重"的数字——这是长时程 agentic RL 的真实成本结构。

**评测**：五个外部基准 + 一个自建验证集，初始策略与 RL checkpoint 用**完全相同的评测设置**：

| 基准 | 考核 | 指标 |
| --- | --- | --- |
| SWE-bench Pro | 仓库级 issue 修复（长时程） | pass rate |
| DeepSWE v1.1 | issue 修复 | pass rate |
| ProgramBench | 整程序从零构造 | Almost Solved（≥95% 测试通过） |
| RepoZero C2Rust | 代码翻译 | pass rate |
| Terminal-Bench v2.1 | 终端工作 | pass rate |
| CodeMidas Val | 自建 held-out（200 任务，3 次尝试） | pass rate |

已验证训练集与 CodeMidas Val 及全部五个外部基准任务集**不相交**。

**复现性**：论文未附代码或数据集发布链接（arXiv 页亦无项目链接），训练/评测配置在附录 Table A1 完整给出，行为度量定义在附录 B。相比同域的 SWE-smith / R2E-Gym / SWE-rebench（均开源），这是当前的明显短板。

---

## 6. 实验结果

### 6.1 五个外部基准全部提升

![Fig. 5 RL 在 CodeMidas 上的性能提升：初始 MiMo-V2.5 分数（灰）vs CodeMidas RL 分数（金）。ProgramBench 报 Almost Solved，其余报 pass rate；右侧标注相对初始策略的绝对提升（百分点）。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-5-benchmark-gains.png)

| 基准 | Base | CodeMidas RL | 增益 |
| --- | --- | --- | --- |
| SWE-bench Pro | 50.3 | 54.4 | **+4.1** |
| DeepSWE | 10.0 | 21.7 | **+11.7** |
| ProgramBench (Almost Solved) | 4.5 | 21.5 | **+17.0** |
| RepoZero C2Rust | 40.5 | 51.8 | **+11.3** |
| Terminal-Bench v2.1 | 63.7 | 72.2 | **+8.5** |

这是主结果：提升**横跨 issue 修复、整程序构造、代码翻译与终端工作**四种截然不同的软件工作形态。注意任务形态与评测形态并不同构——训练任务全是"补回被移除的功能"，却迁移到了修复、翻译、终端操作上，说明源码派生任务提供的是**跨形态泛化的训练信号**。ProgramBench 的 +17 尤其有意思：从零重建整程序与"在既有代码库里补功能"相距甚远，增益最大。

### 6.2 学习动态

![Fig. 6 CodeMidas Val 上的学习曲线：RL 期间的 pass rate（绿，左轴）与平均总长度（灰蓝虚线，右轴，千 token）。水平点线标初始策略的 pass rate。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-6-learning-curve.png)

CodeMidas Val 上 pass rate 从 **35.0% 升至 44.7%**，从 step 40 起稳定高出初始策略 8–10 个百分点；同时轨迹变长——agent 更充分地使用可用交互预算。

---

## 7. 消融与分析

### 7.1 任务规模与质量

![Fig. 7 CodeMidas Val 上的学习曲线对比：高质量 1k/3k/5k（实线圆点）vs 过滤清洗前的 vanilla 8k 采样（虚线菱形）。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-7-task-scale-curves.png)

四组对照：高质量池的随机 1k / 3k / 全量 5k 子集，加一个 **vanilla 8k**——从过滤前采样、不含环境清理、执行一致性检查与任何 post-rollout 过滤的对照组。训练配置与 checkpoint 范围完全一致。

![Fig. 8 任务规模与质量：SWE-bench Pro、DeepSWE、CodeMidas Val 上的分数。圆点连线为高质量 1k/3k/5k；菱形为 vanilla 8k。三个面板 y 轴范围不同。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-8-scale-quality.png)

| 训练池 | SWE-bench Pro | DeepSWE | CodeMidas Val |
| --- | --- | --- | --- |
| 高质量 1k | 52.86 | 17.57 | 41.30 |
| 高质量 3k | 54.02 | 19.05 | 43.22 |
| 高质量 5k（全量） | **54.40** | **21.70** | **44.73** |
| vanilla 8k | 53.81 | 17.11 | 40.24 |

三个结论：

1. **性能随高质量任务规模单调上升**（1k → 3k → 5k 在三项评测上全部递增），支持继续扩展；
2. **5k 高质量 > 8k vanilla**（SWE-bench Pro +0.59、DeepSWE +4.59、Val +4.49）——数量被质量压制；
3. **连 3k 高质量子集都在全部三项上胜过 8k vanilla**。环境可靠性（清理 + 执行检查）与训练适配性（post-rollout 过滤）的价值被干净地隔离出来。

### 7.2 行为变化与泛化

![Fig. 9 一次 rollout 中的代码库探索、代码起草与自我验证：三列配对展示推理与工具调用——读调用方、起草隐藏文件过滤逻辑并用 Edit 应用、用 .secret.csv 测试两种 flag 设置。diff 标注新增；Passed 表示与期望行为一致。](/vibe-reading/images/articles/codemidas-agentic-coding-rl/fig-9-behavior-example.png)

训练早期 vs 晚期的 rollout 对比（Table 2）：

| 行为 | 度量 | Early | Late | 变化 |
| --- | --- | --- | --- | --- |
| 代码库探索 | 首次编辑前 read/search 调用数 | 27.2 | 40.1 | +12.9 |
| 代码起草 | drafting ratio（写入代码片段出现在先前推理中的比例） | 0.358 | 0.629 | +0.271 |
| 自我验证 | 最终编辑后不同验证命令数 | 2.03 | 2.53 | +0.50 |

三个度量定义（附录 B）都做得很扎实：探索去重（同文件同行号的读、同查询的搜索只计一次，shell 等价调用算重复）；drafting ratio 用 16 字符片段、步长 4 采样，数在先前推理中出现过的片段比例；验证命令去重计数（项目测试命令、内联检查、临时测试程序、本地程序运行）。

**自我验证与更高通过率相关**：同一任务同一 checkpoint 内，带 agent 自写检查的 rollout 比不带的平均高 **4.2 个百分点**（95% CI：1.8–6.6；置信区间按整任务重采样）。探索与起草按 checkpoint 中位数拆分的差异分别为 +0.7（CI −1.9~3.7）与 +1.95（CI −0.04~3.96）——相关但不显著。

**行为变化泛化到 held-out 任务**（Table 3，首→末三个观察 checkpoint 的均值）：

| 评测 | 探索 (read/search) | 起草比 | 自我验证 (命令数) | 交互长度 (轮次) |
| --- | --- | --- | --- | --- |
| SWE-bench Pro | 23.1 → 35.5 | 0.304 → 0.653 | 0.80 → 0.96 | 37.3 → 50.1 |
| ProgramBench | 55.7 → 83.6 | 0.106 → 0.361 | 0.93 → 0.99 | **155.1 → 122.8** |
| Terminal-Bench v2.1 | 11.9 → 16.8 | N/A | 2.01 → 2.61 | 59.2 → 69.5 |

探索在三个基准上全部上升。最有信息量的是 ProgramBench 的交互长度**下降**（155 → 123 轮）而探索上升（56 → 84 次调用）——更多探索换来更少的无效往返，即"看得多、走得直"。

---

## 8. 总结与展望

**贡献总结**：

1. **环境构造范式的切换**——从"开发工件驱动"转向"源代码驱动"，任务供给上限从 issue/测试/文档覆盖面解放为代码库总量（Table 1 中五项工件全部打 ✓ 的唯一方法，23 语言覆盖最多）；
2. **agentic 环境构造流水线**——四个模块全部由 agent 执行，配三重 post-rollout 过滤（泄漏、解答审计、rollout 结果），22,575 → 5,545 的漏斗把"验证器要被验证"落到了实处；
3. **实证结论三条**：高质量任务可扩展（1k<3k<5k）、质量压数量（5k>8k vanilla、3k>8k vanilla）、行为改善可泛化（探索/起草/自验证的变化出现在外部基准上）。

**局限性**（论文未设专门小节，以下为批判性阅读归纳）：

- **未发布代码与数据**——摘要与正文均未提及开源计划，同域的 SWE-smith / R2E-Gym / SWE-rebench 均已开源，复现只能靠 Table A1 的配置描述；这是当前最实质的短板；
- **单基座模型**——全部训练与消融只在 MiMo-V2.5 上完成，规模/家族敏感性未知；
- **无跨流水线对照**——没有与同等规模的 R2E-Gym / SWE-smith 数据直接对训（vanilla 8k 是自家过滤前采样，不是他家数据），"代码驱动优于工件驱动"的强主张只有间接证据（语言覆盖、任务规模）；
- **对对抗性 solver 的假设较弱**——泄漏过滤是一次性的对抗 rollout + review，训练中 policy 若学会利用残留泄漏，二值奖励会强化它（reward hacking 的经典回路），论文未报告训练后泄漏复检；
- **CodeMidas Val 是自建指标**——与训练任务同分布，Val 提升部分反映分布内拟合，外部五基准才是硬证据（好在它们全都涨了）。

**未来方向**（idea 三法）：

- *弥补缺陷*：训练后泄漏复检（用 RL 后的 policy 跑对抗 rollout——它比构造期的 screening model 更懂找漏洞）；发布数据与代码以支持社区复现与跨流水线对照；
- *新型方案*：把环境构造流水线本身做成可学习/在线的过程——任务池随训练动态生长，探索 agent 发现 policy 已掌握的邻域后自动开采新领域；引入非二值的分项奖励（行为规范逐条核对）保留更多信用分配信号；
- *减少约束*：放宽"公共入口点 + 可观察行为"的任务形态，覆盖没有稳定接口的内部重构类工作；扩展到跨库任务（多代码库组合的功能移植）。

**读后感**：这篇论文的聪明之处在于把一个被动的约束变成了主动的设计——"没有 issue 和测试的代码库造不了任务"被翻转成"已实现的功能本身就是任务 + oracle"。全文工程感很重、数学几乎为零，但每一步质量把关（六容器 fail-to-pass、三重 post-rollout、FN/FP 审计）都在回应 SWE 数据合成领域真实踩过的坑。5k 精选胜 8k vanilla 的消融值得所有做合成训练数据的人记住：**在可验证环境里，一个可靠的样本顶两个不可靠的样本，而过滤的成本远低于训练的浪费**。

---

## 9. 相关阅读

- [Recursive Synthesis: Terminal-Tasks](/vibe-reading/articles/AI/Agent/Papers/recursive-synthesis-terminal-tasks) — **同基准对照**·同样瞄准 Terminal-Bench 的 agentic 训练方法，与本篇的终端工作评测直接对标
- [Kimi K3 Technical Report](/vibe-reading/articles/kimi-k3-technical-report) — **方法论镜像**·同样以 GRPO + agentic 训练提升长时程软件工程能力，可横向对照训练配方与规模
- [slime CodeWiki：概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview) — **工程实现**·本篇 GRPO + 32 rollouts + 大响应预算的训练形态，在 RL 后训练框架 slime 中的落地实现（rollout/权重同步/编排）
- [MiMo-VL Technical Report](/vibe-reading/articles/mimo-vl-technical-report) — **同家族**·同属 Xiaomi MiMo 系列，从多模态模型侧补充基座模型谱系
- [CodeWiki: Holistic Documentation](/vibe-reading/articles/AI/Agent/AICoding/CodeWiki/Papers/codewiki-holistic-documentation) — **同域**·同在 AI Coding Papers 分类下，代码库级文档生成的姊妹议题
