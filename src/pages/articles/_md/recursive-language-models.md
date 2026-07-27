---
title: "Recursive Language Models"
source:
  type: "论文解读"
  project: "MIT"
  url: "https://arxiv.org/abs/2512.24601"
  pdf: "/vibe-reading/papers/recursive-language-models.pdf"
date: "2026-07-27"
category: [AI, Infra, Inference, Papers]
tags: ["LLM", "Long Context", "Recursive", "REPL", "Inference-Time Scaling", "Out-of-Core"]
description: "目的：让 LLM 处理远超上下文窗口的输入。手段：把 prompt 作为 Python REPL 环境中的变量，LLM 写代码查看、分解、递归调用自身。结论：扩展到 10M+ token，在四任务上大幅超越基线且成本相当。"
readingTime: "14 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/recursive-language-models.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Recursive Language Models](https://arxiv.org/abs/2512.24601) · **作者** Alex L. Zhang, Tim Kraska, Omar Khattab（MIT CSAIL）· **发表** arXiv 2512.24601v1, 2025-12 · **解读** 2026-07-27

---

## 1. 论文概览

**一句话**：RLM 把长 prompt 不再喂给 LLM 的神经网络，而是作为 Python REPL 环境里的一个变量——LLM 写代码 peek、用正则过滤、递归调用自身处理子任务，像 out-of-core 算法一样用小内存处理大数据，把有效输入扩展到上下文窗口的 100 倍（10M+ token）。

- **任务**：让 LLM 处理远超上下文窗口的长 prompt。现代 LLM 上下文窗口有限，且即使在内也受 context rot（上下文越长质量越差）困扰。
- **核心痛点**：现有方法要么是 context compaction（压缩，丢失细节），要么是 retrieval tool-use（检索，不够灵活），都无法让输入真正 scale 到上下文窗口之外。
- **核心方法**：RLM——prompt 作为 REPL 变量，LLM 写代码与之交互并递归调用自身（sub-LM call）。一个固定系统提示跨所有实验，GPT-5 做 root LM、GPT-5-mini 做 sub-LM。
- **take-home**：把"长 prompt"从"要塞进神经网络的 token"重新定义为"环境中的数据对象"，LLM 就能像数据库引擎处理磁盘数据一样，用有限上下文窗口处理任意长的输入——这是 inference-time scaling 的新范式。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We study allowing large language models (LLMs) to process arbitrarily long prompts through the lens of inference-time scaling. We propose Recursive Language Models (RLMs), a general inference strategy that treats long prompts as part of an external environment and allows the LLM to programmatically examine, decompose, and recursively call itself over snippets of the prompt. We find that RLMs successfully handle inputs up to two orders of magnitude beyond model context windows and, even for shorter prompts, dramatically outperform the quality of base LLMs and common long-context scaffolds across four diverse long-context tasks, while having comparable (or cheaper) cost per query.

> **译：** 我们从 inference-time scaling 的角度研究如何让大语言模型处理任意长的 prompt。我们提出 Recursive Language Models（RLMs），一种通用推理策略，将长 prompt 视为外部环境的一部分，允许 LLM 以编程方式查看、分解并递归调用自身来处理 prompt 的片段。我们发现 RLM 能成功处理超出模型上下文窗口两个数量级的输入，即使在较短的 prompt 上也大幅超越基础 LLM 和常见长上下文脚手架的质量，同时每次查询的成本相当或更低。

</details>

---

## 2. 研究背景

### 2.1 Context Rot：上下文越长，质量越差

尽管 LLM 的物理上下文窗口在增长（GPT-5 达到 272K token），但近期研究（Hong et al., 2025）表明，**有效上下文窗口**远小于物理窗口——模型在长上下文上会出现 context rot，即质量随输入长度增长而快速退化。论文进一步假设：有效上下文窗口不能脱离具体任务来理解——更"复杂"的问题在更短长度就开始退化。

### 2.2 任务复杂度随长度如何 scale

论文用 information density（信息密度）刻画任务的复杂度 scaling：

| 任务 | 复杂度 scaling | 说明 |
|------|-------------|------|
| S-NIAH（单针大海捞针） | 恒定 | needle 大小不随输入增长，前沿模型已能在 1M+ token 可靠解决 |
| BrowseComp-Plus | 恒定（但更复杂） | 需要跨多文档拼接信息，比 S-NIAH 复杂但仍只需常数文档 |
| OOLONG | 线性 | 需要检查并变换几乎所有行的语义，处理成本随输入线性增长 |
| OOLONG-Pairs | 二次 | 需要聚合几乎所有行的**对**，处理成本随输入二次增长 |
| CodeQA | 恒定 | 需要对固定数量文件推理 |

这解释了 Figure 1 的模式：GPT-5 在 S-NIAH 上随长度表现稳定，但在 OOLONG（线性复杂度）和 OOLONG-Pairs（二次复杂度）上退化越来越快。

![图1 GPT-5 与 RLM 在三个任务上随输入长度的表现：GPT-5 随长度和复杂度退化，RLM 保持稳定](/vibe-reading/images/articles/recursive-language-models/fig-01-gpt5-vs-rlm-scaling.png)

### 2.3 现有方法及其局限

- **Context compaction（压缩/摘要）**：反复摘要以腾出空间，但假设早期细节可以被遗忘——对需要密集访问 prompt 的任务不够表达。
- **Retrieval tool-use agents**：用 BM25 等检索器索引上下文，但检索不够灵活。
- **递归任务分解（ReDel, ConFolding, AgentFold 等）**：强调通过递归 LM 调用分解任务，但**无法处理超出基础 LM 上下文窗口的长输入**——这正是 RLM 的核心区别。

---

## 3. 方法详解

![图2 RLM 架构：把 prompt 作为 REPL 环境中的变量，LLM 写代码查看、分解、递归调用自身](/vibe-reading/images/articles/recursive-language-models/fig-02-rlm-architecture.png)

### 3.1 核心洞察：Prompt 是环境，不是输入

RLM 的关键洞察来自 **out-of-core 算法**：数据处理系统用小而快的内存处理远大于内存的数据集，靠的是巧妙管理数据如何被载入内存。RLM 把同样的思路用到 LLM：

- **传统方式**：长 prompt → 直接喂进 Transformer → 受上下文窗口限制 + context rot
- **RLM 方式**：长 prompt → 作为 Python REPL 环境中变量 `P` 的值 → LLM 写代码 peek `P`、分解 `P`、递归调用自身处理 `P` 的片段

RLM 对外暴露与 LLM 相同的接口：接受字符串 prompt、产生字符串响应。但内部，它初始化一个 REPL 环境，将 `P` 设为变量值，给 LLM 关于环境的信息（如 `P` 的长度），然后让 LLM 自由编写代码与之交互。

### 3.2 REPL 环境 + 递归 sub-call

RLM 的 REPL 环境提供两个核心能力：

1. **编程式访问 prompt**：LLM 可以写 Python 代码——用正则过滤、用字符串操作切片、用 `len()` 查看长度——以任意方式检查 prompt 的任意部分。
2. **递归调用自身**：REPL 中加载了一个 sub-LM 模块，LLM 可以在代码中构造子任务、调用 sub-LM 处理，并观察执行结果。这是"递归"的体现——root LM 调 sub-LM，sub-LM 还可继续递归（论文实验用 max recursion depth = 1，即 sub-call 就是 LM 调用）。

对于 GPT-5 实验：root LM 用 GPT-5（medium reasoning），sub-LM 用 GPT-5-mini——在能力和成本间取得平衡。系统提示在所有实验中固定，不针对任何 benchmark 调优。

### 3.3 涌现模式

论文观察到 RLM 在解决任务时展现出三种常见模式（Figure 4）：

![图4 RLM 的三种涌现模式：正则过滤、递归子调用分解、递归拼接长输出](/vibe-reading/images/articles/recursive-language-models/fig-05-emergent-patterns.png)

**(a) 通过代码过滤和交互**：RLM 频繁用正则等代码查询过滤上下文，而非把全部内容塞进 token。

**(b) 通过递归 sub-call 分解**：在 OOLONG 等信息密集任务上，RLM(Qwen3-Coder) 逐行通过 sub-call 做语义变换，而无 sub-call 的消融只能用关键词启发式。

**(c) 通过变量传递递归输出实现长输出**：RLM 在 REPL 变量中存储 sub-LM 调用结果，拼接成最终答案——产出本质上不受限长度的 token（远超基础 LM 的输出限制）。在 OOLONG-Pairs 上大量使用此策略。

---

## 4. 关键设计解读

### 4.1 与现有递归分解方法的区别

许多 agent（如 Anthropic 的 Claude、ReDel、ConFolding）也用多次 LM 调用，但 RLM 的本质区别是：

$$
\text{RLM} = \underbrace{\text{Prompt as Environment}}_{\text{输入可 scale 到窗口外}} + \underbrace{\text{Recursive sub-calls}}_{\text{任务分解 + 语义变换}}
$$

现有递归分解方法（ReDel、ConFolding）只做了第二部分——**它们的输入仍受限于基础 LM 的上下文窗口**。RLM 的第一部分（prompt 作为环境对象）才是让输入 scale 到窗口之外的关键。

### 4.2 成本-能力权衡

| 组件 | 模型选择 | 理由 |
|------|---------|------|
| Root LM | GPT-5（medium reasoning） | 需要强能力做上下文管理决策 |
| Sub-LM | GPT-5-mini | 递归调用频繁，用小模型控成本 |
| Summary agent 压缩 | GPT-5-nano | 处理大量 token，用最小模型 |

这种分层设计使 RLM 的中位数成本甚至**低于**基础模型直接调用（因为 RLM 选择性查看上下文，而基础模型必须吞入全部输入）。

---

## 5. 实验设置

| 维度 | 配置 |
|------|------|
| **前沿闭源模型** | GPT-5（medium reasoning，默认采样参数） |
| **前沿开源模型** | Qwen3-Coder-480B-A35B（Fireworks 提供商） |
| **任务 1** | S-NIAH（50 个单针大海捞针，RULER） |
| **任务 2** | BrowseComp-Plus 1K 文档（150 题，多跳 QA） |
| **任务 3** | OOLONG trec coarse（50 题，线性复杂度长推理） |
| **任务 4** | OOLONG-Pairs（20 题新构造，二次复杂度对推理） |
| **任务 5** | LongBench-v2 CodeQA（多选代码仓库理解） |
| **基线 1** | Base Model（直接调用） |
| **基线 2** | CodeAct + BM25（代码执行 agent + 检索器） |
| **基线 3** | Summary agent（迭代摘要压缩） |
| **消融** | RLM (no sub-calls)——有 REPL 但不能递归调用 |

---

## 6. 实验结果

### 6.1 主结果：RLM 全面领先

![图3 主结果表：RLM 在四任务上跨两模型全面领先，灰色为 API 成本](/vibe-reading/images/articles/recursive-language-models/fig-03-table1-results.png)

**观察 1：RLM 能扩展到 10M+ token 并超越所有基线。** 在所有任务上，RLM 在远超前沿 LM 有效上下文窗口的输入上表现强劲，性能最多达基线的 2×，同时 token 成本相当或更低。在 BrowseComp-Plus (1K) 上，GPT-5-mini 吞入 6-11M token 的成本是 $1.50-$2.75，而 RLM(GPT-5) 平均成本 $0.99，且超越摘要和检索基线超 29%。

**观察 2：即使 prompt 在上下文窗口内，RLM 也能大幅提升。** 在 OOLONG 上，RLM(GPT-5) 和 RLM(Qwen3-Coder) 分别比基础模型高 28.4% 和 33.3%。在 OOLONG-Pairs 上，GPT-5 和 Qwen3-Coder 基础模型 F1 < 0.1%，而 RLM 分别达 58.00% 和 23.11%——**这是 RLM 处理信息密集任务的涌现能力**。

**观察 3：REPL 环境处理长输入，递归 sub-call 处理信息密集输入。** 无 sub-call 的消融仍能超越上下文限制并在多数长上下文设置上超越基线——REPL 环境本身已足够处理长输入。但在信息密集任务上（OOLONG/OOLONG-Pairs），有 sub-call 的 RLM 比无 sub-call 消融高 10%-59%。无 sub-call 时被迫用关键词启发式，有 sub-call 时能做逐行语义变换。

### 6.2 成本分析

![图4 各方法 API 成本四分位数分布](/vibe-reading/images/articles/recursive-language-models/fig-04-cost-quartiles.png)

**观察 4：RLM 成本与基础模型相当但方差大。** RLM 迭代式交互直到找到合适答案，导致不同任务复杂度的迭代长度差异大。对 GPT-5，RLM 的中位数成本**低于**基础模型中位数，但许多异常 RLM 运行远比任何基础模型贵。然而对比摘要基线（吞入全部输入），RLM 便宜最多 3× 且性能更强——因为模型能选择性查看上下文。

**观察 5：RLM 是模型无关的推理策略，但不同模型行为不同。** GPT-5 和 Qwen3-Coder 都作为 RLM 表现强劲，但行为模式不同。在 BrowseComp-Plus 上，RLM(GPT-5) 几乎解决所有任务，而 RLM(Qwen3-Coder) 只解一半。两者唯一提示差异是 Qwen3-Coder 多一行"不要用太多 sub-call"的警告。

### 6.3 关键数值汇总

| 场景 | RLM 优势 |
|------|---------|
| 输入长度扩展 | 超上下文窗口 2 个数量级（10M+ token） |
| OOLONG 提升（vs base，GPT-5） | +28.4% |
| OOLONG-Pairs F1（GPT-5） | 58.00% vs base < 0.1% |
| BrowseComp-Plus（GPT-5） | 91.33% vs base 0.00% |
| 成本（vs summary agent） | 最多 3× 更便宜 |
| 中位数成本（GPT-5） | 低于 base model |

---

## 7. 消融实验

### 7.1 RLM vs RLM (no sub-calls)

| 任务 | RLM | RLM (no sub-calls) | 差异 |
|------|-----|-------------------|------|
| CodeQA (Qwen3) | 56.00 | **66.00** | 消融更高 17.9% |
| BrowseComp+ (Qwen3) | 44.66 | **46.00** | 消融更高 3% |
| OOLONG (GPT-5) | **56.50** | 36.00 | RLM 高 56.9% |
| OOLONG-Pairs (GPT-5) | **58.00** | 43.93 | RLM 高 32% |

- **REPL 环境是处理长输入的必要条件**：即使没有 sub-call，消融也能超越上下文限制和多数基线。
- **递归 sub-call 在信息密集任务上提供强收益**：在 OOLONG 和 OOLONG-Pairs 上，sub-call 带来 10%-59% 的提升。
- **在简单任务上 sub-call 可能有害**：CodeQA 和 BrowseComp+ (Qwen3) 上，无 sub-call 的消融反而更好——sub-call 的决策开销在简单任务上不划算。

### 7.2 涌现模式分析

论文 §3.1 分析了 RLM 的常见轨迹模式：

- **过滤模式**：RLM 用 regex 等代码查询过滤上下文，而非全量读取——这在 CodeQA 等需要定位特定代码的任务上特别有效。
- **逐行语义变换**：在 OOLONG 上，RLM(Qwen3-Coder) 为每行单独发一个 sub-LM call 做语义变换，而无 sub-call 的消融只能用关键词启发式近似。
- **变量拼接长输出**：在 OOLONG-Pairs 上，RLM 把多个 sub-call 的输出存进 REPL 变量、拼接成最终答案——产出长度不受限。

---

## 8. 总结与展望

### 8.1 贡献总结

1. **RLM 统一框架**：将长 prompt 从"喂给神经网络的 token"重新定义为"环境中的数据对象"，LLM 通过 REPL 编程式交互 + 递归 sub-call 处理——一个固定系统提示覆盖所有任务。
2. **输入 scale 到上下文窗口 100 倍**：在 10M+ token 上仍保持强劲性能，而基础模型和现有脚手架在远短于此的长度就开始退化。
3. **信息密集任务的涌现能力**：在 OOLONG-Pairs 等前沿模型 F1 < 0.1% 的任务上，RLM 达到 58%——这是通过递归 sub-call 实现的逐行语义变换能力。

更深层的贡献是一种**视角转换**：从 out-of-core 算法汲取灵感，把 LLM 的有限上下文窗口类比为"小而快的内存"，把长 prompt 类比为"磁盘上的大数据集"——于是 LLM 不再需要把所有东西塞进上下文，而是像数据库引擎一样按需加载、分块处理。

### 8.2 局限性（论文自述）

- **实现机制未充分探索**：只研究了同步 sub-call + Python REPL，异步 sub-call 和沙箱化 REPL 可能显著降低运行时和成本。
- **递归深度 = 1**：实验中 sub-call 就是 LM 调用，更深的递归层次未被探索。
- **未训练专用 RLM**：用现有前沿模型做实验，显式训练 root/sub-LM 可能带来额外提升——RLM 轨迹可视为一种 reasoning，可用 bootstrapping 训练。
- **模型间行为差异**：GPT-5 和 Qwen3-Coder 在 sub-call 策略上差异大（GPT-5 保守、Qwen3 逐行调用），暗示当前模型在上下文管理决策上不够高效。

### 8.3 未来方向（idea 三法）

**弥补缺陷**：

- 探索**异步 sub-call**——当前所有 LM 调用是阻塞/顺序的，异步并行可大幅降低运行时。结合沙箱化 REPL 还能提升安全性。
- 训练**专用 RLM 模型**——把 RLM 轨迹视为 reasoning trace，用 bootstrapping（Zelikman et al.）训练 root 和 sub-LM，让模型学会更高效的上下文管理决策。

**新型方案**：

- 把 RLM 的 out-of-core 思路推广到**多模态**——长视频、高分辨率图像也可作为 REPL 环境中的变量，LLM 写代码按帧/区域查看。
- 结合 RLM 的递归分解与 **process reward model**——用逐步正确性信号引导 sub-call 的分解策略，而非仅靠 LM 自主决策。

**减少约束**：

- 探索**更深的递归层次**（max depth > 1）——sub-LM 可以再调用 sub-sub-LM，形成层级化处理，可能对超复杂任务（如全库代码理解）有额外收益。
- 把 RLM 与 **continual learning** 结合——REPL 环境的持久变量可以跨 query 积累知识，使 RLM 从"一次性推理"进化为"持续学习的 agent"。

---

> **一句话收尾**：RLM 的胜利是"视角转换"的胜利——把长 prompt 从"要塞进神经网络的 token"重新定义为"环境中的数据对象"，LLM 就能像 out-of-core 算法一样用有限窗口处理无限输入，而递归 sub-call 让它在信息密集任务上涌现出基础模型完全没有的能力。
