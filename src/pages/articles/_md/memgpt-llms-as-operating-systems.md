---
title: "MemGPT: Towards LLMs as Operating Systems"
source:
  type: "论文解读"
  project: "UC Berkeley"
  url: "https://arxiv.org/abs/2310.08560"
  pdf: "/vibe-reading/papers/memgpt-llms-as-operating-systems.pdf"
date: "2026-08-01T16:00:00+08:00"
category: [AI, Agent, Memory & Context, Papers]
tags: ["LLM", "Context Window", "Virtual Memory", "Memory Hierarchy", "Agent", "Function Calling", "Long Context"]
description: "目的：让固定上下文窗口的 LLM 处理远超窗口的对话/文档。手段：借鉴操作系统虚拟内存分页，设计分层内存（main/external context）+ 函数调用自主管理内存 + 中断驱动控制流。结论：在多轮对话与文档分析两领域大幅超越固定上下文基线。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/memgpt-llms-as-operating-systems.pdf" target="_blank" rel="noopener">预览</a> · **论文** [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) · **作者** Charles Packer, Sarah Wooders, Kevin Lin, Vivian Fang, Shishir G. Patil, Ion Stoica, Joseph E. Gonzalez（UC Berkeley）· **发表** arXiv 2310.08560v2, 2024-02 · **项目** https://research.memgpt.ai · **解读** 2026-08-01

---

## 1. 论文概览

**一句话**：MemGPT 把操作系统的虚拟内存思想搬进 LLM——把固定上下文窗口当作"主存"，把外部存储当作"磁盘"，LLM 通过函数调用自主在两级内存间"分页"搬运数据，并用中断驱动控制流，从而在**不改动模型权重、不扩展 context 长度**的前提下，让固定上下文模型营造出"无限上下文"的假象。

- **任务**：让受限于固定上下文窗口的 LLM 处理远超窗口的长对话与长文档分析。
- **核心痛点**：直接扩展 transformer 的 context 长度带来 self-attention 的**二次计算/显存代价**；且长上下文模型存在 "lost in the middle" 问题——注意力分布不均，中间位置的 token 难以被有效召回（Liu et al., 2023a）。即便窗口够大，长上下文的边际收益也在递减。
- **核心方法**：**virtual context management**——OS 启发的分层内存（main context + external context）+ LLM 自主函数调用（搜索/编辑自己的内存）+ 事件中断驱动的控制流 + 函数链（function chaining）实现多步检索。
- **take-home**：把"长上下文"从"更大的窗口"重新定义为"由 LLM 自主调度的分层内存系统"——这是将 OS 经典抽象（虚拟内存、分页、中断）迁移到 LLM 系统设计的范式样本，开启了 "LLM as OS" 这一研究方向。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Large language models (LLMs) have revolutionized AI, but are constrained by limited context windows, hindering their utility in tasks like extended conversations and document analysis. To enable using context beyond limited context windows, we propose virtual context management, a technique drawing inspiration from hierarchical memory systems in traditional operating systems that provide the appearance of large memory resources through data movement between fast and slow memory. Using this technique, we introduce MemGPT (Memory-GPT), a system that intelligently manages different memory tiers in order to effectively provide extended context within the LLM's limited context window, and utilizes interrupts to manage control flow between itself and the user. We evaluate our OS-inspired design in two domains where the limited context windows of modern LLMs severely handicaps their performance: document analysis, where MemGPT is able to analyze large documents that far exceed the underlying LLM's context window, and multi-session chat, where MemGPT can create conversational agents that remember, reflect, and evolve dynamically through long-term interactions with their users.

> **译：** 大语言模型（LLM）革新了 AI，但受限于有限的上下文窗口，阻碍了其在长对话和文档分析等任务中的效用。为了能在有限上下文窗口之外使用上下文，我们提出**虚拟上下文管理**（virtual context management），这一技术从传统操作系统的分级内存系统汲取灵感——后者通过在快慢内存间搬运数据，提供"有更大内存资源"的假象。基于这一技术，我们提出 MemGPT（Memory-GPT），一个智能管理不同内存层级的系统，在 LLM 有限的上下文窗口内有效提供扩展上下文，并利用中断（interrupts）管理自身与用户之间的控制流。我们在两个现代 LLM 因有限上下文窗口而严重受限的领域评估了这一 OS 启发的设计：文档分析（MemGPT 能分析远超底层 LLM 上下文窗口的大文档）和多会话对话（MemGPT 能创造通过长期交互来记忆、反思、动态演化的对话 agent）。

</details>

---

## 2. 研究背景

### 2.1 问题：上下文窗口是硬瓶颈

LLM 的能力受限于固定 context 窗口。论文 Table 1 列举了当时主流模型的窗口规模：

| 模型 / API | 开源? | Context 窗口 | ≈ 消息数 |
|------|------|------------|---------|
| Llama (1) | ✓ | 2k | 20 |
| Llama 2 | ✓ | 4k | 60 |
| GPT-3.5 Turbo (release) | ✗ | 4k | 60 |
| Mistral 7B | ✓ | 8k | 140 |
| GPT-4 (release) | ✗ | 8k | 140 |
| GPT-3.5 Turbo | ✗ | 16k | 300 |
| GPT-4 | ✗ | 32k | ~600 |
| Claude 2 | ✗ | 100k | ~2000 |
| GPT-4 Turbo | ✗ | 128k | ~2600 |
| Yi-34B-200k | ✓ | 200k | ~4000 |

（*消息数按 1k 预提示 + 单条 ~50 token 估算*）

即便最强的 GPT-4 Turbo 也只有 128k token，而真实文档（如 SEC Form 10-K 年报）轻松突破百万 token，且许多文档分析任务需要**跨多篇长文档**建立联系——盲目堆大窗口既不现实也不够用。

### 2.2 现有路径及其局限

- **直接扩展 context 长度**：self-attention 的二次复杂度带来高昂计算/显存代价；且 Liu et al. (2023a) 发现长上下文模型存在 "lost in the middle"——对上下文首尾信息召回好、中间差。即便窗口够大，**有效上下文**远小于物理窗口。
- **检索增强（RAG）**：把检索器选出的片段塞进 context，但固定上下文基线的性能被检索器质量**封顶**——若 embedding 检索没把金文档排进前几名，基线永远看不到答案。
- **摘要压缩**：反复摘要以腾空间，但**假设早期细节可以被遗忘**，对需要密集回访 prompt 的任务不够表达。

### 2.3 关键洞察：向操作系统借抽象

传统 OS 让应用在远大于物理内存的数据集上工作，靠的是**虚拟内存**：把溢出数据 page out 到磁盘，访问时再 page fault 回内存。MemGPT 把同一思路用到 LLM——把 context 窗口当作"物理内存"，把外部存储当作"磁盘"，让 LLM 像应用一样"感知"到比物理窗口大得多的可用上下文。相关工作中，Generative Agents（Park et al., 2023）给 LLM 加记忆与规划、WebGPT（Nakano et al., 2021）用网页搜索 + 分页、ReAct（Yao et al., 2022）交错推理与行动——MemGPT 的差异在于聚焦"**给 agent 装备用户输入的长期记忆**"这一具体问题。

---

## 3. 方法详解

![图3 MemGPT 架构：固定上下文 LLM 处理器被分层内存与自管理函数增强；prompt tokens（main context）= system instructions + working context + FIFO queue，completion tokens 被 function executor 解析为在 main/external context 间搬运数据的函数调用](/vibe-reading/images/articles/memgpt-llms-as-operating-systems/fig-03-memgpt-architecture.png)

### 3.1 OS 类比：上下文窗口即内存

MemGPT 设计了与 OS 内存层级对应的**两级内存**：

| MemGPT 层 | OS 类比 | 内容 | 访问方式 |
|----------|--------|------|---------|
| **Main context**（prompt tokens） | 主存 / RAM | LLM 推理时直接可见 | 拼成单串喂给 LLM |
| └ System instructions | 只读段 | 控制流说明、各内存层用途、函数用法 | 静态、只读 |
| └ Working context | 读写数据段 | 自由文本，存关键事实/偏好/persona | 仅函数调用可写 |
| └ FIFO queue | 缓冲队列 | 滚动消息历史（agent-user、系统警告、函数 I/O）；首条是已驱逐消息的递归摘要 | queue manager 写入 |
| **External context** | 磁盘 | 上下文窗口之外的所有信息 | 必须显式搬进 main context 才可被 LLM 处理 |
| └ Recall storage | 对话日志库 | 全量消息数据库 | 函数检索 |
| └ Archival storage | 文档库 | 任意长度文本（文档等） | 函数检索 + 分页 |

关键约束：**外部数据不会自动进入推理**——必须由 LLM 主动发起函数调用把数据 page in 到 main context。

### 3.2 Queue Manager：溢出驱逐

queue manager 是 main context 与 recall storage 之间的"内存控制器"：

1. 新消息到达 → 追加到 FIFO queue → 拼接 prompt tokens → 触发 LLM 推理生成 completion。
2. 同时把入站消息与 LLM 输出写入 recall storage（全量对话历史库）。
3. 检索 recall storage 时，把结果追加到 queue 尾部重新进入上下文。

**驱逐策略**控制上下文溢出（见 §4 的形式化）：

- 当 prompt tokens 超过 **warning token count**（如 70% 上下文窗口）→ 插入 "memory pressure" 系统警告，**给 LLM 机会**用函数把 FIFO queue 里的重要信息存到 working context 或 archival storage，再由后续驱逐释放队列空间。
- 当 prompt tokens 超过 **flush token count**（如 100% 窗口）→ flush：驱逐约 50% 窗口的消息，并用旧递归摘要 + 被驱逐消息生成新递归摘要。被驱逐消息**离开 main context**，但无限期存于 recall storage，仍可由函数读回。

![图1 MemGPT（左）在收到"内存压力"系统警告后，将数据写入持久化内存（working context）](/vibe-reading/images/articles/memgpt-llms-as-operating-systems/fig-01-memory-pressure-write.png)

上图展示了"内存压力"触发自编辑的完整闭环：系统发出 `System Alert: Memory Pressure` 警告 → MemGPT 调用 `working_context.append("Boyfriend named James")` 把对话中的关键事实持久化到 working context（位于 prompt tokens 内）→ 随后即便 FIFO queue 中的原始消息被驱逐，这一信息仍随推理常驻。

### 3.3 Function Executor：自主内存管理

MemGPT 的内存编辑与检索是**完全自主（self-directed）**的——LLM 根据当前上下文自主决定何时在层级间搬运数据、如何修改 main context 以反映其演化中的理解。系统提示包含两部分：(1) 内存层级及其用途的详细描述；(2) 带自然语言说明的函数 schema。

每个推理周期：LLM 以 main context（拼成单串）为输入 → 生成输出串 → MemGPT 解析校验函数参数 → 执行函数 → 结果（含运行时错误，如"main context 已满还试图追加"）回灌给 processor。这一**反馈环**让系统从自身动作中学习调整。典型函数包括：

| 函数 | 作用 |
|------|------|
| `working_context.append` / `.replace` | 编辑 working context（增/改关键事实） |
| `recall_storage.search` | 在对话历史中分页检索 |
| `archival_storage.search(page=...)` | 在文档库中分页检索 |
| `archival_memory_insert` | 写入 archival storage |
| `send_message` | 向用户返回响应 |

对 context 上限的感知是自编辑机制有效的前提：MemGPT 主动提示 token 警告引导内存决策；检索机制实现**分页**以防止单次召回溢出窗口。

### 3.4 控制流与函数链

**事件触发推理**——事件是 MemGPT 的泛化输入：用户消息（对话）、系统消息（如容量警告）、用户交互（用户登录、文档上传完成警报）、定时事件（按计划运行，允许 MemGPT "无提示"主动执行）。事件经解析器转为纯文本消息追加进 main context。

**函数链（function chaining）**让 MemGPT 在交还控制权给用户前串行执行多步函数：函数可带特殊 flag `request_heartbeat=true` → 函数执行完后控制权**立即回到 processor** 继续推理（而非暂停）；若无此 flag（即 yield）→ 等待下一外部事件触发。这正是多步检索（翻页遍历结果、跨文档汇总）的基础。

![图6 MemGPT（左）解文档 QA 任务：Wikipedia 文档库上传到 archival storage，MemGPT 通过函数调用分页检索并把结果拉进 main context](/vibe-reading/images/articles/memgpt-llms-as-operating-systems/fig-06-document-qa-example.png)

上图展示函数链的典型轨迹：用户问"谁获得了首届诺贝尔物理学奖" → MemGPT 调 `archival_storage.search("nobel physics")` 翻到第 2 页 → 发现结果不够再 `archival_storage.search("nobel physics", page=2)` 翻页 → 多次分页检索后把金文档片段拉进 main context → 给出答案 "Wilhelm Conrad Rontgen"。系统警报 `System Alert: Archive Storage Upload Complete` 作为一个事件也注入了控制流。

---

## 4. 关键公式解读

MemGPT 不是数学密集型论文，但其内存预算与驱逐策略可以形式化为如下约束（论文用文字描述，此处为其策略的等价形式化）：

$$
\underbrace{|S|}_{\text{system instructions}} + \underbrace{|W|}_{\text{working context}} + \underbrace{|Q|}_{\text{FIFO queue}} \leq \underbrace{C}_{\text{context window}}
$$

main context 三段之和受限于固定上下文窗口 $C$。MemGPT 用两个阈值触发驱逐：

$$
|S| + |W| + |Q| \geq 0.7\,C \;\Longrightarrow\; \text{memory pressure 警告（软触发，给 LLM 自救机会）}
$$

$$
|S| + |W| + |Q| \geq C \;\Longrightarrow\; \text{flush：驱逐 } \approx 0.5\,C \text{ 的 } Q \text{ 到 recall storage（硬触发）}
$$

而"虚拟上下文"的假象正来自——通过函数调用按需 page in，有效上下文远超物理窗口：

$$
C_{\text{effective}} \;\approx\; C + |\text{recall storage}| + |\text{archival storage}| \;\gg\; C
$$

这套设计把 OS 的"小内存跑大数据"工程经验落到了 LLM 系统上：**不是让窗口变大，而是让调度变聪明**。

---

## 5. 实验设置

| 维度 | 配置 |
|------|------|
| **GPT-4 Turbo** | gpt-4-1106-preview，128,000 context |
| **GPT-4** | gpt-4-0613，8,192 context |
| **GPT-3.5 Turbo** | gpt-3.5-turbo-1106，16,385 context |
| **领域 1 · 对话** | Multi-Session Chat（MSC，Xu et al., 2021），每条 5 session，新增 session 6 |
| · 任务 1 DMR | deep memory retrieval（一致性）：问前序对话细节，ROUGE-L（R）+ LLM judge |
| · 任务 2 Opener | conversation opener（engagement）：CSIM 与 gold persona / 人工 opener 比较（SIM-1/3、SIM-H） |
| · 对话基线 | base LLM + 过去 5 轮对话的**有损摘要**（模拟递归摘要） |
| · MemGPT 设置 | 拥有全量对话历史，但须经**分页搜索 recall** 才能取回 |
| **领域 2 · 文档** | |
| · 任务 3 多文档 QA | NaturalQuestions-Open + Wikipedia 2018 dump，50 题，retriever-reader 设定 |
| · 检索器 | OpenAI `text-embedding-ada-002` 余弦相似度；MemGPT 用 PostgreSQL + pgvector + HNSW 索引 |
| · MemGPT retriever | 全量文档载入 archival storage，retriever **自然涌现**于 archival search |
| · 文档基线 | top-K 文档独立检索后塞入 context；超出窗口则**截断**文档 |
| · 任务 4 nested KV | 新任务：140 对 128-bit UUID（~8k tokens = GPT-4 baseline 窗口），nesting 0–4 级，30 种排序 |
| **评价** | accuracy / ROUGE-L / CSIM / GPT-4 作 LLM judge（与人工评估一致性高） |
| **复现** | 代码、增强 MSC 数据集、nested KV 数据集、20M Wikipedia embedding 均开源 |

---

## 6. 实验结果

### 6.1 对话：记忆一致性大幅提升

DMR 任务（Table 2）中，MemGPT 在三种基座模型上**全面碾压**固定上下文基线——基线只能看到过去 5 轮对话的有损摘要，而 MemGPT 通过分页搜索 recall 取回全量历史：

| 基座模型 | 基线 Accuracy | 基线 ROUGE-L | + MemGPT Accuracy | + MemGPT ROUGE-L |
|---------|--------------|-------------|-------------------|------------------|
| GPT-3.5 Turbo | 38.7% | 0.394 | **66.9%** | **0.629** |
| GPT-4 | 32.1% | 0.296 | **92.5%** | **0.814** |
| GPT-4 Turbo | 35.3% | 0.359 | **93.4%** | **0.827** |

对话 opener 任务（Table 3）中，MemGPT 生成的开场白在相似度上**达到甚至超越人工 opener**（Human SIM-1/3 = 0.800，MemGPT 多在 0.83–0.87）——MemGPT 倾向写更冗长、覆盖更多 persona 维度的 opener，且 working context 是生成吸引人 opener 的关键。

### 6.2 文档：不受 context 长度影响

![图5 文档 QA 任务性能：MemGPT 不随 context 长度退化，而截断/压缩方法随必要压缩量增长而退化；MemGPT(GPT-4) 与 MemGPT(GPT-4 Turbo) 在该任务上结果相当](/vibe-reading/images/articles/memgpt-llms-as-operating-systems/fig-05-document-qa-performance.png)

文档 QA（Figure 5）的关键观察：

- **固定上下文基线被检索器封顶**：它们只能用塞进窗口的文档，若 embedding 检索没把金文档排进前几名，基线永远看不到答案。随着检索文档数 K 增加，截断加剧导致退化。
- **MemGPT 不受 context 长度影响**：它能对 archival storage 多次分页检索，可用文档数不再受限于"窗口能装几篇"。曲线随 K 增长保持平稳。
- **基座依赖**：MemGPT(GPT-3.5) 因 function calling 能力弱而显著退化；MemGPT(GPT-4) 与 MemGPT(GPT-4 Turbo) 结果相当。

### 6.3 嵌套 KV：唯一能跨多跳稳定完成

![图7 嵌套 KV 检索性能：MemGPT 是唯一能在 >2 级嵌套上稳定完成的方法；GPT-4 Turbo 作为基线更强，但 MemGPT(GPT-4 Turbo) 反而比 MemGPT(GPT-4) 差](/vibe-reading/images/articles/memgpt-llms-as-operating-systems/fig-07-nested-kv-performance.png)

嵌套 KV 任务（Figure 7）是论文设计的**多跳检索**压力测试——值本身可能是 key，需要链式 lookup。结果极具信息量：

- **基线全线崩盘**：GPT-3.5 在 1 级嵌套就归零（失败模式是直接返回原值）；GPT-4 / GPT-4 Turbo 在 3 级嵌套归零。
- **MemGPT(GPT-4) 唯一稳定**：不受嵌套级数影响，靠函数反复查询 main context 中的 KV 对完成链式查找。
- **反直觉发现**：`MemGPT(GPT-4 Turbo)` **反而不如** `MemGPT(GPT-4)`——尽管 GPT-4 Turbo 作为基线更强，但套上 MemGPT 后表现更差。MemGPT(GPT-3.5) 与 MemGPT(GPT-4 Turbo) 都在 2 级开始退化。

![图8 MemGPT（左）解嵌套 KV 任务示例（UUID 已缩写）：两级嵌套 831..ea5 → 5b8..4c3 → f37..617，MemGPT 在最终查询只返回一个结果（说明该值不是 key）时给出答案](/vibe-reading/images/articles/memgpt-llms-as-operating-systems/fig-08-nested-kv-example.png)

上图的求解轨迹揭示了 MemGPT 的多跳策略：查 `831..ea5` 得值 `5b8..4c3` → 发现该值也是 key，继续查 → 查 `5b8..4c3` 得 `f37..617` → 再查 `f37..617` 只返回 1 条（说明它不是 key）→ 返回最终答案。终止条件"查询只返回一个结果"正是 function chaining 的自然涌现。

---

## 7. 消融与模块贡献分析

MemGPT 没有传统意义的逐模块消融，但实验中几个维度的对比同样能拆解贡献：

### 7.1 基座模型的 function calling 能力是关键

| 场景 | 基座影响 |
|------|---------|
| 文档 QA | GPT-3.5 因 function calling 弱显著退化；GPT-4 / GPT-4 Turbo 相当 |
| 嵌套 KV | GPT-3.5 在 1 级归零；GPT-4 全程稳定；GPT-4 Turbo 在 2 级开始退化 |

MemGPT 的上限**直接受限于基座模型执行函数调用的能力**——这印证了"自主内存管理"对 LLM agent 能力的强依赖。

### 7.2 虚拟上下文 vs 有损摘要

DMR 上 MemGPT 用"全量历史 + 分页搜索 recall"远超"有损摘要"基线（GPT-4：92.5% vs 32.1%）——证明**虚拟上下文**比**压缩**保留了更多可召回信息：摘要一旦丢弃细节就永久丢失，而 MemGPT 的驱逐只把消息移出 main context，仍无限期存于 recall storage 可被重新 page in。

### 7.3 检索器仍是瓶颈

文档 QA 对所有方法都难，根因是 embedding 相似度检索的噪声——金文档常落在前十几名之外。MemGPT 理论上**不受次优检索器限制**（只要完整排序里包含金文档，靠分页总能翻到），但实际观察到 **MemGPT 常在翻完检索库前就停止分页**——这是 §8 将讨论的局限。

### 7.4 GPT-4 Turbo 反直觉弱于 GPT-4

`MemGPT(GPT-4 Turbo) < MemGPT(GPT-4)` 是论文明确点出但**未充分解释**的反直觉现象[^err]。可能的推测：GPT-4 Turbo 尽管原始能力更强，但在"何时发起函数调用、何时停止分页"这类**上下文管理决策**上不如 GPT-4 高效——暗示当时模型在"内存管理元决策"上还不够成熟。

[^err]: 原文 Figure 7 caption 明确指出此现象，但正文未给出机制解释，属存疑处。

---

## 8. 总结与展望

### 8.1 贡献总结

1. **virtual context management 框架**：首次系统地把 OS 的虚拟内存/分页/中断抽象迁移到 LLM，把 context 窗口当作受约束的内存资源而非待扩展的参数。
2. **自主内存管理**：LLM 通过函数调用自己搜索、编辑自己的内存，无需用户干预——这是 "LLM as OS" 思路在 agent 长期记忆问题上的落地。
3. **两领域验证**：对话（DMR 一致性、opener 参与度）与文档（QA、嵌套 KV 多跳）双线证明固定上下文模型也能突破窗口限制。

更深层的贡献是**视角转换**：从"把更多 token 塞进神经网络"转向"让 LLM 像数据库引擎一样按需加载/驱逐数据"——这与后来 Recursive Language Models 的 out-of-core 思路遥相呼应（见 [Recursive Language Models](./recursive-language-models.md)）。

### 8.2 局限性（批判性）

- **强依赖 function calling**：GPT-3.5 因函数调用能力弱而显著退化，方法对基座模型的 agent 能力高度敏感。
- **检索器仍是瓶颈**：embedding 检索噪声大，MemGPT 理论可分页翻完，但**实际常提前停止**——"自主停止决策"成了新的失败模式。
- **GPT-4 Turbo 反直觉弱于 GPT-4**：未解释，暴露"内存管理元决策"在当时的模型上不可靠。
- **基座覆盖窄**：只测 GPT-3.5/GPT-4 family，无开源长上下文模型（如 Yi-200k）的 MemGPT 增强对比。
- **任务生态偏合成**：MSC 是人工 labeler 扮演 persona 的模拟对话，非真实长期对话；50 题文档 QA 样本小；嵌套 KV 是合成 UUID 任务，与真实多跳 QA 有差距。

### 8.3 未来方向（idea 三法）

**弥补缺陷**：

- 训练**专门强化 function-calling 与上下文管理决策**的小模型做 sub-operations，降低对单一基座的依赖；用 process reward model 引导"分页停止"决策，避免提前终止。
- 引入**混合检索**（BM25 + 向量 + 重排）降低 archival search 噪声，让金文档更靠前、减少翻页需求。

**新型方案**：

- 把 archival storage 从自由文本库换成**结构化数据库**（SQL/图），让 LLM 用精确查询而非向量近似召回——嵌套 KV 这类结构化多跳将直接受益。
- 探索**多 agent 共享 memory tier**：多个 MemGPT agent 共用同一 archival/recall 层，形成"有共享记忆的 agent 社会"。
- 把虚拟上下文推广到**多模态**：长视频、高分辨率图像也可作为 archival 中的可 page 对象，LLM 按帧/区域检索。

**减少约束**：

- 探索**更深递归**：sub-LLM 再调 sub-sub-LLM，形成层级化内存管理，可能对超复杂任务（全库代码理解）有额外收益。
- 结合 **continual learning**：让 memory tier 跨 query 积累知识，使 MemGPT 从"单次会话记忆"进化为"持续学习的 agent"。
- **异步函数调用**：当前函数链是阻塞/顺序的，异步并行可大幅降低多步检索的运行时与成本。

---

> **一句话收尾**：MemGPT 的贡献不在算法，而在抽象——它证明把 OS 的虚拟内存/分页/中断搬进 LLM 系统设计，就能让固定上下文模型在长对话与长文档上涌现出基线完全没有的能力，"LLM as OS" 由此成为一条独立的研究脉络。
