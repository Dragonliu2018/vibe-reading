---
title: "CodeWiki: Evaluating AI's Ability to Generate Holistic Documentation for Large-Scale Codebases"
source:
  type: "论文解读"
  project: "FPT Software AI Center"
  url: "https://arxiv.org/abs/2510.24428"
  pdf: "/vibe-reading/papers/codewiki-holistic-documentation.pdf"
category: [AI, Agent, AI Coding, CodeWiki, Papers]
date: "2026-08-07T18:00:00+08:00"
tags: ["CodeWiki", "CodeWikiBench", "文档生成", "仓库级文档", "层次分解", "多智能体", "LLM-as-Judge", "tree-sitter", "ACL 2026"]
description: "CodeWiki 提出半智能体框架，通过层次分解、递归多智能体处理和多模态合成，为 7 种编程语言自动生成仓库级文档。配套 CodeWikiBench 基准采用层次化评分细则和智能体评估协议，CodeWiki 以 68.79% 的质量分超越闭源 DeepWiki 基线 4.73 个百分点。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/codewiki-holistic-documentation.pdf" target="_blank" rel="noopener">预览</a> · **论文** [CodeWiki: Evaluating AI's Ability to Generate Holistic Documentation for Large-Scale Codebases](https://arxiv.org/abs/2510.24428) · **作者** Anh Nguyen Hoang, Minh Le-Anh, Bach Le, Nghi D. Q. Bui · **发表** ACL 2026 · **项目** https://github.com/FSoft-AI4Code/CodeWiki · **解读** 2026-08-07

---

## §1 论文概览

**TL;DR**: CodeWiki 是一个开源的半智能体（semi-agentic）框架，通过层次分解、递归多智能体处理和多模态合成，为 7 种编程语言自动生成仓库级文档。配套发布的 CodeWikiBench 基准采用层次化评分细则（hierarchical rubrics）和智能体评估协议（agentic assessment）。在 7 个仓库的评测中，CodeWiki 以 68.79% 的质量分超越了闭源 DeepWiki 基线 4.73 个百分点，在脚本语言上优势尤为明显（+10.47%）。

| 维度 | 内容 |
|------|------|
| 论文标题 | CodeWiki: Evaluating AI's Ability to Generate Holistic Documentation for Large-Scale Codebases |
| 作者机构 | FPT Software AI Center（越南）；University of Melbourne（澳大利亚） |
| 发表会议 | ACL 2026 |
| 核心贡献 | CodeWiki 框架 + CodeWikiBench 基准 + 7 语言多语种评测 |
| 代码开源 | https://github.com/FSoft-AI4Code/CodeWiki |
| 生成模型 | Claude Sonnet 4 |
| 评测模型 | Gemini 2.5 Flash、GPT OSS 120B、Kimi K2 Instruct |
| 关键结果 | 68.79% 质量分，较 DeepWiki（64.06%）提升 4.73% |

<details>
<summary><strong>Abstract（原文）</strong></summary>

> Given a large and evolving codebase, the ability to automatically generate a holistic, architecture-aware documentation that captures not only individual functions but also their cross-file, cross-module, and system-level interactions remains an open challenge. Comprehensive documentation is essential for long-term software maintenance and team collaboration, yet current automated approaches still fail to model the rich semantic dependencies and architectural structures that define real-world software systems. We present CodeWiki, a unified framework for automated repository-level documentation across seven programming languages. CodeWiki introduces three key innovations: (i) hierarchical decomposition that preserves architectural context across multiple levels of granularity, (ii) recursive multi-agent processing with dynamic task delegation for scalable generation, and (iii) multi-modal synthesis that integrates textual descriptions with visual artifacts such as architecture diagrams and data-flow representations. To enable rigorous evaluation, we introduce CodeWikiBench, a comprehensive benchmark featuring multi-dimensional rubrics and LLM-based assessment protocols. Experimental results demonstrate that CodeWiki achieves a 68.79% quality score with proprietary models, outperforming the closed-source DeepWiki baseline (64.06%) by 4.73%, with particularly strong improvements on high-level scripting languages (+10.47%). We open-source CodeWiki to foster future research and community adoption.

</details>

<details>
<summary><strong>Abstract（中文翻译）</strong></summary>

> 面对大型且不断演进的代码库，自动生成能够捕捉跨文件、跨模块和系统级交互的整体性架构感知文档，仍然是一个开放性挑战。全面的文档对于长期软件维护和团队协作至关重要，然而当前的自动化方法仍无法建模真实世界软件系统中定义性的丰富语义依赖和架构结构。我们提出了 CodeWiki——一个跨 7 种编程语言的自动化仓库级文档统一框架。CodeWiki 引入了三项关键创新：（i）保持多粒度架构上下文的层次分解，（ii）支持动态任务委派的递归多智能体处理，以实现可扩展生成，（iii）整合文本描述与架构图、数据流图等视觉产物的多模态合成。为实现严格评估，我们引入了 CodeWikiBench——一个配备多维评分细则和 LLM 评估协议的综合基准。实验结果表明，CodeWiki 在使用专有模型时达到 68.79% 的质量分，超越闭源 DeepWiki 基线（64.06%）4.73 个百分点，在高级脚本语言上提升尤为显著（+10.47%）。我们将 CodeWiki 开源以促进未来研究和社区采用。

</details>

## §2 研究背景

### 2.1 问题定义

行业调查显示，约 31% 的开发者已在代码文档任务中重度依赖 AI，25% 大量使用 AI 创建和维护文档。文档已成为未来 3-5 年 AI 集成优先级最高的领域之一。然而当前自动化文档生成面临两个根本性限制。

### 2.2 现有方法的不足

**可扩展性限制**：现有方法在函数级和文件级文档生成上取得了进展，但扩展到仓库级时面临巨大挑战。仓库级文档需要捕捉架构模式、跨模块交互、数据流和系统级设计决策——这些远超单个函数的范畴。层次化的软件系统要求文档能同时服务于不同受众：高层利益相关者需要架构概览，开发者需要实现细节。

**评估景观的限制**：函数级和文件级工作依赖 BLEU、ROUGE 等通用指标，无法捕捉文档质量的细微差别。仓库级评估尤其困难，因为文档存在多种有效结构，需要超越表面相似度的鲁棒评估方法。

**多语言支持的限制**：大多数代码文档生成研究主要关注 Python，很少考虑 Java、JavaScript、C、C++ 等其他广泛使用的编程语言。这种狭窄的范围限制了泛化能力，忽略了真实世界软件项目固有的结构多样性。

### 2.3 相关工作

- **代码智能与 LLM**：从 CodeBERT、GraphCodeBERT 到 CodeT5/CodeT5+ 等专用代码模型，再到最近的 LLM（如 Claude、GPT 系列）在代码理解任务上的应用。
- **自动化文档生成**：RepoAgent 利用静态分析和增量处理；DocAgent 提出多智能体系统（Reader、Searcher、Writer、Verifier 协作）。两者在扩展到大型仓库和维持跨文件一致性方面仍有困难。
- **多智能体系统**：AutoGen、MetaGPT、ChatDev 等框架展示了多智能体协作的潜力，但现有方法在系统性依赖管理和大规模一致性维护方面仍有不足。

## §3 方法详解

CodeWiki 是一个半智能体框架，通过层次分解解决上下文限制问题。如图 1 所示，整个框架分三个阶段运行。

![CodeWiki 框架架构总览](/vibe-reading/images/articles/codewiki-holistic-documentation/fig-1-framework-overview.png)

### 3.1 阶段一：仓库分析与层次化模块分解

**依赖图构建**：使用 Tree-Sitter 解析器提取 AST，系统性地识别函数、方法、类、结构体、模块及其依赖关系——函数调用、类继承、属性访问和模块导入。所有关系被归一化为统一的 `depends_on` 关系，构建有向图 $G = (V, E)$，其中边 $(u, v) \in E$ 表示组件 $u$ 依赖于 $v$。这一归一化设计是跨语言泛化的关键。

**入口点识别与分解**：通过拓扑排序识别零入度组件——即用户交互的独立入口点（main 函数、API 端点、CLI、公共接口）。高级组件通过递归分区被层次化分解为可管理的模块，分区过程综合考虑组件间依赖关系和语义连贯性。出于可扩展性考虑，仅组件 ID 作为输入，最终形成一棵面向特征的模块树（module tree）。

### 3.2 阶段二：递归文档生成

这是 CodeWiki 的核心创新——递归智能体处理，使框架能处理任意大小的仓库，同时保持有界复杂度和架构连贯性。

**智能体架构**：每个叶子模块被分配一个专用智能体，配备：(1) 完整源码访问权限，(2) 用于跨模块理解的完整模块树，(3) 文档工作区工具（查看、创建、编辑），(4) 依赖图遍历能力。智能体的工作流为：分析组件以理解功能和接口 → 遍历依赖探索上下文 → 生成包含描述、用法示例、API 规格和架构洞察的 Markdown 文档。

**动态委派**：当模块复杂度超出单次处理能力时，智能体将子模块委派给专用子智能体。委派标准包括：代码复杂度指标（圈复杂度、嵌套深度）、语义多样性（功能上不同的子组件）、上下文窗口利用率。递归过程遵循自底向上处理（见论文 Algorithm 1）：委派后，智能体提供子模块规格，模块树更新，新创建的叶子递归处理。这使得框架能处理任意大小的模块，同时保持质量。

**跨模块引用管理**：当智能体在遍历中遇到外部组件时，智能解析系统创建交叉引用而非复制内容。全局注册表追踪已文档化的组件及其位置，确保简洁性的同时保持完整性，创建反映实际代码库结构的互联文档。

### 3.3 阶段三：层次化组装与文档合成

叶子文档完成后，层次化组装通过递归处理父模块，将组件级细节合成为架构概览。

父模块接受 LLM 合成，LLM 接收：子模块文档、模块树结构、依赖信息，以及用于架构模式和特征交互的合成指令。合成涉及多个阶段：分析子模块文档以发现主题和模式 → 生成解释模块协作的架构概览 → 创建精炼能力的特征摘要 → 为公共接口开发使用指南 → 生成可视化关系和数据流的架构图。

## §4 关键公式解读

CodeWikiBench 的评分聚合采用自底向上的加权聚合方法，同时通过标准差传播追踪可靠性。

### 4.1 叶子节点评估

对于叶子节点 $\ell$，多个评估结果 $s_1, s_2, \ldots, s_m$ 聚合为均值：

$$S(\ell) = \bar{s} = \frac{1}{m} \sum_{i=1}^{m} s_i$$

可靠性通过标准差量化：

$$\sigma_\ell = \sqrt{\frac{1}{m-1} \sum_{i=1}^{m} (s_i - \bar{s})^2}$$

标准差越低，表示评判者共识越高、评估越可靠。论文使用多个不同模型家族的评判智能体（Gemini 2.5 Flash、GPT OSS 120B、Kimi K2 Instruct）分别评估每个叶子需求，取均值降低单一模型偏差。

### 4.2 层次化传播

对于内部节点 $n$，其子节点集合 $C(n) = \{c_1, \ldots, c_k\}$，各子节点有评分 $S(c_i)$、权重 $w(c_i)$ 和标准差 $\sigma_{c_i}$：

$$S(n) = \frac{\sum_{i=1}^{k} w(c_i) \cdot S(c_i)}{\sum_{i=1}^{k} w(c_i)}$$

$$\sigma_n = \frac{\sqrt{\sum_{i=1}^{k} w(c_i)^2 \cdot \sigma_{c_i}^2}}{\sum_{i=1}^{k} w(c_i)}$$

权重 $w(c_i)$ 反映组件的重要性（基于关键性和复杂度），标准差的传播确保不确定性适当向上传递。这一双指标方法提供了带置信边界的质量评估，使结果解读更加细致。

### 4.3 最终评估

最终仓库评分 $S(R) \in [0, 1]$ 及其偏差 $\sigma_R$ 代表了从叶子到根的全面加权聚合。较低的 $\sigma_R$ 表明方法论可靠性更高。

## §5 实验设置

### 5.1 研究问题

实验围绕三个核心研究问题展开：

- **RQ1**：文档质量与覆盖——CodeWiki 与现有系统在整体文档质量和需求覆盖方面相比如何？
- **RQ2**：跨语言泛化——CodeWiki 在不同编程语言上是否表现一致？高级脚本语言（Python、JavaScript、TypeScript）与系统编程语言（C、C++、C#、Java）之间有何差异？
- **RQ3**：可扩展性与可靠性——层次分解方法在不同规模和复杂度的仓库上表现如何？评估方法论的可靠性如何？

### 5.2 基线系统

| 基线 | 类型 | 说明 |
|------|------|------|
| OpenDeepWiki | 开源 | 将 LLM 应用于整个仓库生成文档 |
| deepwiki-open | 开源 | 开源仓库级文档生成系统 |
| DeepWiki | 闭源 | 商业系统，工业应用中已证明有效 |

论文未与 RepoAgent、DocAgent 等函数级文档系统直接定量比较，因为它们生成的是 N 个独立组件文档，与 CodeWiki 的层次化合成模块级文档属于不同范式。

### 5.3 仓库选择

7 个开源仓库覆盖多样编程语言、项目规模和应用领域：

| 仓库 | 语言 | LOC |
|------|------|-----|
| All-Hands-AI/OpenHands | Python | 229,909 |
| sveltejs/svelte | JavaScript | 124,576 |
| puppeteer/puppeteer | TypeScript | 136,302 |
| Unity-Technologies/ml-agents | C# | 86,106 |
| elastic/logstash | Java | 117,485 |
| wazuh/wazuh | C | 1,446,730 |
| electron/electron | C++ | 184,234 |

选择标准：(1) 语言多样性，(2) 代码规模从 86K 到 1.4M LOC，(3) 有高质量官方文档用于评分细则构建，(4) 覆盖 Web 框架、自动化工具、ML 平台等多个领域。

### 5.4 防数据泄露的时间分离

为确保评估完整性，使用 2025 年 8-9 月的仓库快照，晚于所有实验模型的知识截止日期（Claude Sonnet 4 的截止日期为 2025 年 3 月）。这一时间差为防止数据泄露提供了有力证据。

### 5.5 模型配置

| 角色 | 模型 |
|------|------|
| 文档生成 | Claude Sonnet 4 |
| 评分细则生成 | Claude Sonnet 4、Gemini 2.5 Pro、Kimi K2 Instruct（多模型减少偏差） |
| 评判评估 | Gemini 2.5 Flash、GPT OSS 120B、Kimi K2 Instruct（三模型独立评估） |

## §6 实验结果

### RQ1：文档质量与覆盖

下表展示了 7 个仓库上的完整评测结果：

| 仓库 | 语言 | 系统 | 质量分 (%) | 覆盖 | 提升 (%) |
|------|------|------|-----------|------|---------|
| OpenHands | Python | OpenDeepWiki | 58.12 ± 3.21 | 42/67 | — |
| | | deepwiki-open | 61.35 ± 2.98 | 45/67 | — |
| | | DeepWiki | 73.04 ± 2.54 | 54/67 | — |
| | | **CodeWiki** | **82.45 ± 2.65** | **59/67** | **+9.41** |
| svelte | JavaScript | OpenDeepWiki | 55.23 ± 3.85 | 61/96 | — |
| | | deepwiki-open | 57.89 ± 3.62 | 64/96 | — |
| | | DeepWiki | 68.51 ± 3.31 | 76/96 | — |
| | | **CodeWiki** | **71.96 ± 3.73** | **80/96** | **+3.45** |
| puppeteer | TypeScript | OpenDeepWiki | 51.82 ± 4.15 | 48/82 | — |
| | | deepwiki-open | 54.67 ± 3.94 | 51/82 | — |
| | | DeepWiki | 64.46 ± 3.72 | 60/82 | — |
| | | **CodeWiki** | **83.00 ± 3.37** | **74/82** | **+18.54** |
| ml-agents | C# | OpenDeepWiki | 62.45 ± 4.28 | 32/46 | — |
| | | deepwiki-open | 65.12 ± 4.05 | 34/46 | — |
| | | DeepWiki | 74.80 ± 3.69 | 39/46 | — |
| | | **CodeWiki** | **79.78 ± 5.02** | **42/46** | **+4.98** |
| logstash | Java | OpenDeepWiki | 41.25 ± 4.52 | 28/57 | — |
| | | deepwiki-open | 44.18 ± 4.31 | 31/57 | — |
| | | DeepWiki | 54.80 ± 4.10 | 38/57 | — |
| | | **CodeWiki** | **57.90 ± 3.43** | **38/57** | **+3.10** |
| wazuh | C | OpenDeepWiki | 32.56 ± 5.82 | 18/46 | — |
| | | deepwiki-open | 35.89 ± 5.45 | 21/46 | — |
| | | DeepWiki | 68.68 ± 4.74 | 39/46 | — |
| | | CodeWiki | 64.17 ± 5.44 | 34/46 | -4.51 |
| electron | C++ | OpenDeepWiki | 28.45 ± 3.95 | 35/92 | — |
| | | deepwiki-open | 31.22 ± 3.78 | 38/92 | — |
| | | DeepWiki | 44.10 ± 3.12 | 54/92 | — |
| | | CodeWiki | 42.30 ± 3.26 | 48/92 | -1.80 |
| **平均** | | OpenDeepWiki | 47.13 ± 4.25 | | |
| | | deepwiki-open | 50.05 ± 4.02 | | |
| | | DeepWiki | 64.06 ± 3.60 | | |
| | | **CodeWiki** | **68.79 ± 3.84** | | **+4.73** |

**关键发现**：

- CodeWiki 在 7 个仓库中的 5 个上超越所有基线
- 在 TypeScript（puppeteer）上取得最大提升：83.00% vs DeepWiki 的 64.46%，提升 **18.54** 个百分点
- 在 Python（OpenHands）上提升 9.41 个百分点
- 相比开源方案，提升更为显著：较 OpenDeepWiki 提升 21.66%，较 deepwiki-open 提升 18.74%
- 开源替代方案在更复杂的代码库上性能明显下降，表明简单的全仓库提示方法不能有效扩展

### RQ2：跨语言泛化

![按编程语言类别比较性能](/vibe-reading/images/articles/codewiki-holistic-documentation/fig-3-performance-by-language.png)

| 语言类别 | CodeWiki 平均分 | DeepWiki 平均分 | 提升 |
|---------|----------------|----------------|------|
| 脚本语言（Python/JS/TS） | 79.14% | 68.67% | **+10.47%** |
| 托管语言（C#/Java） | 68.84% | 64.80% | +4.04% |
| 系统语言（C/C++） | 53.24% | 56.39% | -3.15% |

CodeWiki 在脚本语言上表现强劲，在托管语言上保持稳定提升。系统编程语言对两种框架都构成挑战——指针操作、手动内存管理和模板元编程等低级构造的固有复杂性使得这一差距主要源于分析阶段的能力限制，而非次要问题。

### RQ3：可扩展性与可靠性

**可扩展性**：框架处理了从 86K LOC 到 1.4M LOC 的仓库，在同语言类别内性能一致，与仓库大小无关。Unity ML-Agents（86K LOC）达到 79.78%，更大的 OpenHands（230K LOC）达到 82.45%，证明层次化方法成功解决了大规模文档生成的上下文限制。动态委派机制自动适应不同复杂度，通过层次分解保持有界处理需求。

**可靠性**：CodeWiki 的平均标准差为 3.84%，DeepWiki 为 3.60%，表明评估可靠性相当。试点人类研究（3 名参与者、3 个仓库、9 项评估）显示，人类偏好与自动评估结果一致——CodeWiki 在 9 项评估中的 7 项被偏好。

## §7 深入分析

### 7.1 层次化评分细则

![RAGFlow 仓库的层次化评分细则示例](/vibe-reading/images/articles/codewiki-holistic-documentation/fig-2-hierarchical-rubric.png)

CodeWikiBench 的评分细则从项目官方文档中层次化解析为结构化 JSON 格式，利用目录结构和 Markdown 语法捕捉从架构概览到实现细节的多级技术文档。评分细则生成智能体处理每个结构，生成镜像仓库功能层次结构的评分细则。为增强可靠性，使用多个不同模型家族独立生成，最终从多视角综合，减少单一模型偏差。分析显示，生成的评分细则具有高一致性：73.65% 的语义可靠性和 70.84% 的结构可靠性。

### 7.2 智能体评估协议

评判智能体接收结构化 JSON 格式的生成文档（隐藏详细内容）和仓库特定评分细则。系统性方法论为：分析文档结构和内容 → 全面搜索需求覆盖 → 做出二元充分性决策 → 提供简明推理。关键设计是评判者仅评估叶子级需求，确保评估基于具体标准而非抽象概念。例如，评估"复杂布局的 DeepDoc 可视化解析器"而非宽泛的"文档处理引擎"。

### 7.3 生成的文档示例

![OpenHands 仓库的生成文档示例](/vibe-reading/images/articles/codewiki-holistic-documentation/fig-4-example-docs.png)

CodeWiki 生成的文档包含架构图、使用模式和跨模块依赖可视化，涵盖组件描述、API 规格和架构洞察等多种内容类型。

### 7.4 局限性

论文诚实地讨论了三方面局限：

1. **系统编程语言**：在 C/C++ 上效果降低（53.24% vs 79.14%），根源在于指针操作、手动内存管理和模板元编程等低级构造的固有复杂性。
2. **评分细则生成**：自动生成的评分细则虽然达到 73.65% 语义和 70.84% 结构可靠性，但未经全面人工验证，部分细则可能难以解读。
3. **评估方法论**：依赖 LLM 评估与多模型共识，可能引入模型特定偏差。试点人类研究提供了初步验证，但更广泛的人工评估仍有待完成。

## §8 总结与展望

### 核心贡献

CodeWiki 通过三项关键创新解决了仓库级文档生成的核心挑战：

1. **层次分解**受动态规划原理启发，将复杂仓库分解为可管理模块，同时保持架构连贯性——这使框架能处理从 86K 到 1.4M LOC 的任意规模仓库。
2. **递归多智能体处理**配合动态委派，使框架能自适应模块复杂度，在保持质量的同时实现可扩展性。
3. **CodeWikiBench** 提供了首个配备层次化评分细则和智能体评估协议的仓库级文档基准，通过标准差传播提供质量评估与置信边界。

### 关键结论

- CodeWiki 以 68.79% 的质量分超越所有基线，较闭源 DeepWiki 提升 4.73%
- 性能差异主要与语言特征相关，而非仓库大小——脚本语言提升 +10.47%，系统语言两者均面临挑战
- 层次分解成功解决了上下文限制，在不同规模上保持性能一致性
- 试点人类研究与自动评估结果一致（7/9 偏好 CodeWiki）

### 未来方向

- **系统语言专用解析模块**：开发利用语言特定特征的专用解析器，改善 C/C++ 文档质量
- **多版本文档追踪**：扩展到追踪代码库演进的多版本文档
- **下游任务应用**：利用全面文档服务于代码迁移等下游任务
- **更广泛的人工评估**：补充更多参与者和系统化评分细则评估

### 对社区的启示

CodeWiki 的开源为社区提供了一个可复现、可扩展的仓库级文档生成基线。其层次分解 + 递归智能体的设计范式，以及 CodeWikiBench 的层次化评估方法论，对更广泛的代码智能任务（如代码搜索、程序理解、缺陷修复）也具有参考价值。论文诚实地指出了系统语言的局限性和评估方法论的潜在偏差，这种科学态度有助于社区在此基础上继续推进。
