---
title: "SGLang: Efficient Execution of Structured Language Model Programs"
source:
  type: "论文解读"
  project: "SGLang"
  url: "https://arxiv.org/abs/2312.07104"
  pdf: "/vibe-reading/papers/sglang-efficient-structured-lm-programs.pdf"
date: "2026-07-26"
category: [AI, 推理, SGLang, Papers]
tags: ["SGLang", "LLM Serving", "KV Cache", "RadixAttention", "Constrained Decoding", "LM Programs"]
description: "目的：高效编程与执行结构化 LM 程序。手段：Python 嵌入式 DSL + RadixAttention 基数树 KV 缓存复用 + 压缩 FSM 约束解码 + API 投机执行。结论：相比 vLLM/Guidance/LMQL 吞吐最高 6.4×、延迟降 3.7×。"
readingTime: "16 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/sglang-efficient-structured-lm-programs.pdf" target="_blank" rel="noopener">预览</a> · **论文** [SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104) · **作者** Lianmin Zheng, Liangsheng Yin, Ying Sheng 等（Stanford / UC Berkeley / SJTU / Texas A&M）· **发表** arXiv 2312.07104v2, 2024-06 · **项目** https://github.com/sgl-project/sglang · **解读** 2026-07-26

---

## 1. 论文概览

**一句话**：SGLang 把"用 LLM 写程序"这件事的系统开销拆成两半——前端用 Python 嵌入式 DSL 写清楚、后端用三个 runtime 优化跑得快，而**贯穿两者的核心是"显式利用多调用结构"**。

- **任务**：高效编程与执行结构化语言模型程序（LM Programs）——多调用、带控制流、结构化输入/输出。
- **核心创新**：前端 `gen` / `select` / `fork` / `join` 原语 + 后端 **RadixAttention**（基数树 LRU 自动复用 KV cache）+ **压缩 FSM**（多 token 一步解码）+ **API speculative execution**（黑盒 API 投机执行）。
- **结果**：在 Llama-7B/70B、Mixtral-8x7B、LLaVA 图像/视频、GPT-3.5 等 12 类工作负载上，相比 Guidance / vLLM / LMQL，**吞吐最高 6.4×、延迟最低降 3.7×**；在 Chatbot Arena 生产部署中 RadixAttention 缓存命中率 52.4%–74.1%。

**take-home**：当 LLM 调用从"单轮 chat"演变成"程序化调度多次生成"，推理引擎的优化对象也应从"单请求延迟"升级为"**跨调用、跨实例的共享结构复用**"——RadixAttention 把 KV cache 当成一个被基数树索引的传统缓存来管，是这套思路最典型的落地。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Large language models (LLMs) are increasingly used for complex tasks that require multiple generation calls, advanced prompting techniques, control flow, and structured inputs/outputs. However, efficient systems are lacking for programming and executing these applications. We introduce SGLang, a system for efficient execution of complex language model programs. SGLang consists of a frontend language and a runtime. The frontend simplifies programming with primitives for generation and parallelism control. The runtime accelerates execution with novel optimizations like RadixAttention for KV cache reuse and compressed finite state machines for faster structured output decoding. Experiments show that SGLang achieves up to 6.4× higher throughput compared to state-of-the-art inference systems on various large language and multi-modal models on tasks including agent control, logical reasoning, few-shot learning benchmarks, JSON decoding, retrieval-augmented generation pipelines, and multi-turn chat. The code is publicly available at https://github.com/sgl-project/sglang.

> **译：** 大型语言模型（LLM）正越来越多地被用于需要多次生成调用、高级提示技术、控制流以及结构化输入/输出的复杂任务。然而，尚缺乏用于编程与执行这些应用的高效系统。我们提出 SGLang，一个高效执行复杂语言模型程序的系统。SGLang 由前端语言和 runtime 两部分组成：前端用生成与并行控制原语简化编程；runtime 用 RadixAttention（KV cache 复用）和压缩有限状态机（加速结构化输出解码）等新颖优化加速执行。实验表明，相比 state-of-the-art 推理系统，SGLang 在 agent 控制、逻辑推理、few-shot 学习基准、JSON 解码、检索增强生成流水线、多轮聊天等多种大语言与多模态模型任务上取得最高 6.4× 的吞吐提升。代码已开源。

</details>

## 2. 研究背景

LLM 的使用范式正从"简单聊天"转向"程序化调度"——agent 工作流、few-shot、self-consistency、tree-of-thought 等都依赖**多次、往往相互依赖的 LLM 调用**。论文把这类程序称为 **LM Programs**[^lmprog]，并归纳出两个共性：

[^lmprog]: LM Programs 概念引自论文 [4, 20]（Beurer-Kellner 的 LMQL、Khattab 的 DSPy）。SGLang 把"高级提示技术与 agent 工作流"统一视为 LM 程序的实例。

1. **多次 LLM 调用，夹杂控制流**——为完成复杂任务、提升整体质量所必需。
2. **结构化输入 / 结构化输出**——让 LM 程序可组合、可集成进现有软件系统所必需。

现有系统却接不住这两个共性。论文指出两层瓶颈：

| 瓶颈 | 现象 | 根因 |
|---|---|---|
| 编程繁琐 | 字符串拼装、prompt 调参、脆弱的输出解析、手写并行 | LLM 非确定性 + 缺乏原语 |
| 执行低效 | 重复 prefill、重复付输入 token 费、token-by-token 约束解码 | 引擎对 workload 一无所知 |

执行低效的两大典型：(1) **KV cache 复用缺失**——同 prefix 的请求本可共享中间张量，但 vLLM / TGI / TensorRT-LLM 等通用引擎为保通用稳健，处理完即丢 KV cache；(2) **约束解码只能逐 token**——JSON 等 schema 约束在现有系统里靠逐 token mask 非法 token，明明只有一条合法路径也走多步。

**关键观察**：KV cache 的计算**只依赖前缀 token**——这是 RadixAttention 能跨调用复用的物理基础。论文在 Appendix A 给出四类典型共享模式（Figure 9），现有系统**没有一个能自动覆盖全部**，SGLang 的 RadixAttention 可以。

![Figure 9：KV cache 共享的四种典型模式。蓝色为可共享的 prompt 片段，绿色为不可共享部分，黄色为不可共享的模型输出。可共享元素涵盖 few-shot 示例、self-consistency 中的问题、多轮对话历史、tree-of-thought 的搜索历史。](/vibe-reading/images/articles/sglang-efficient-structured-lm-programs/fig-09-kv-cache-sharing-patterns.png)

> **缺口**：尚无系统同时做到"前端易写 LM 程序 + runtime 识别多调用共享结构自动加速"。SGLang 的动机正是补这个缺口。

## 3. 方法详解

SGLang = **前端语言** + **后端 runtime**，两部分可协同、也可独立工作。

![Figure 1：SGLang 系统架构。前端解释器执行语言原语，runtime 提供 RadixAttention（§3）、压缩 FSM（§4）、API speculative execution（§5）三项优化。](/vibe-reading/images/articles/sglang-efficient-structured-lm-programs/fig-01-architecture.png)

### 3.1 前端：Python 嵌入式 DSL

SGLang 是嵌入 Python 的领域专用语言，提供控制 prompt 状态、生成、并行的原语，可随 Python 控制流与库一起用：

| 原语 | 作用 |
|---|---|
| `gen` | 调模型生成，结果存入具名变量；支持 `regex` 约束输出服从正则（如 JSON schema） |
| `select` | 调模型从选项列表里选概率最高项 |
| `+=` / `extend` | 向 prompt 状态追加字符串 |
| `[variable_name]` | 取回某次生成的结果 |
| `fork` / `join` | 创建并行分叉 / 汇合 prompt 状态 |
| `image` / `video` | 多模态输入 |

论文用 `branch-solve-merge` 评图打分的例子（Figure 2）展示这些原语如何组合——`fork` 三路并行评估不同维度、`select` 判相关性、`gen` 带 `regex` 输出 JSON。等价的 OpenAI API 写法要多写 2.1× 代码，主要耗在字符串拼装与并行控制上。

执行有两种模式：**解释器**（默认，prompt 作异步流，原语异步提交、取结果时阻塞同步，类似 CUDA kernel 的异步启动）与**编译器**（编译为计算图，可做更多静态优化，本文默认用解释器，编译模式见 Appendix D）。SGLang 既支持开源模型（自有 SGLang Runtime / SRT），也支持 OpenAI、Anthropic 等 API 模型。

### 3.2 后端优化一：RadixAttention

RadixAttention 的核心思路：**把 KV cache 当成一个被基数树索引的传统缓存来管**。

- **基数树**（radix tree）是经典 trie 的空间高效变体——边可标注任意长度的 token 序列，而非单 token。系统用一棵基数树维护"token 序列 → KV cache 张量"的映射。
- KV cache 张量存于**非连续、分页布局**（每页 = 1 token）。GPU 显存易满，故采用 **LRU 淘汰**：**优先淘汰叶子，再淘汰祖先**——这样公共祖先能被其他分支继续复用，直到它们自己变成叶子。
- 连续 batching 下，**正在被运行批次使用的节点不能淘汰**；每个节点维护引用计数，引用计数归零才可淘汰。
- 不预分配固定大小缓存池——**缓存 token 与运行请求共享同一显存池**，等请求多时系统会自动淘汰缓存以换更大 batch size。

Figure 3 用 9 个时间点演示基数树如何随请求动态演化（两个 chat 会话 + 一批 few-shot 查询 + self-consistency 采样）：

![Figure 3：带 LRU 淘汰的 RadixAttention 操作示例，跨 9 个时间点。绿色为新增节点，蓝色为本时间点访问的缓存节点，红色为被淘汰节点。涵盖两个聊天会话、一批 few-shot 查询与一次 self-consistency 采样。](/vibe-reading/images/articles/sglang-efficient-structured-lm-programs/fig-03-radix-tree-lru.png)

两个配套设计：

1. **cache-aware scheduling**——请求多时按"最长共享前缀优先"排序执行，而非先来先服务，避免 cache thrashing。论文证明（Theorem 3.1，见 §4）这在离线场景是**最优**的。
2. **Frontend Hint**——执行 `fork` 时，前端先把 prefix 作为 hint 发给 runtime，确保 prefix 正确插入树，再发剩余 prompt。这种"前端-runtime 协同设计"简化了调度与匹配。

RadixAttention 兼容 continuous batching、paged attention、tensor parallelism；且在无命中时仅引入可忽略开销（见 §7）。

### 3.3 后端优化二：压缩 FSM

约束解码（如 JSON schema 用正则）现有做法把正则转成有限状态机（FSM），解码时维护当前 FSM 状态、屏蔽非法 token——**逐 token**。但当存在唯一合法下一 token 的"单条转移链"时，整条链本可一次 forward 走完。

SGLang 的做法：分析 FSM，把**相邻的 singular-transition 边压缩成单边**，于是能识别"哪些多 token 序列可一起解码"。

![Figure 4：普通 FSM 与压缩 FSM 的解码过程对比（下划线 _ 表示空格）。(a) 普通 FSM 对正则 \{"summary": "；(b) 压缩 FSM 把多 token 路径压成单步；(c) 普通 FSM 逐 token 解码；(d) 压缩 FSM 一次 forward 解码多个 token。](/vibe-reading/images/articles/sglang-efficient-structured-lm-programs/fig-04-compressed-fsm.png)

该机制通用，适用于所有正则表达式。

### 3.4 后端优化三：API speculative execution

针对 OpenAI GPT-4 这类**只能调黑盒 API** 的模型，SGLang 用投机执行省一次 API 调用：对形如 `s += context + "name:" + gen("name", stop="\n") + "job:" + gen("job", stop="\n")` 的多调用程序，在第一次调用开启投机、忽略 stop 条件继续生成几个 token，解释器保留额外输出并尝试与后续原语匹配复用。配合精心设计的 prompt，模型能高准确率匹配模板，**省掉一次 API 调用的延迟与输入 token 费**。

## 4. 关键公式解读

**(1) KV cache 的前缀单调性**——RadixAttention 复用的物理基础。KV cache 只依赖前缀 token，故共享前缀即可复用：

$$
\mathrm{KVCache}(x_{1:i}) = f(x_{1:i}), \qquad \mathrm{KVCache}(x_{1:i}) \subseteq \mathrm{KVCache}(x_{1:j}) \;\; \text{for } i < j
$$

**(2) 缓存命中率**——cache-aware scheduling 的直接优化目标：

$$
\text{Cache Hit Rate} \;=\; \frac{\text{number of cached prompt tokens}}{\text{number of prompt tokens}}
$$

**(3) Theorem 3.1（离线最优调度）**——对一批请求，按 radix tree 的 **DFS 序**访问、且 cache 大小 ≥ 最大请求长度，即可达最优命中率；longest-shared-prefix-first 序等价于 DFS 序：

$$
\sigma^{\star} \in \arg\max_{\sigma}\; \mathrm{HitRate}(\sigma) \quad\Longleftrightarrow\quad \sigma \text{ is a DFS order on the radix tree}
$$

> 论文在 Appendix A.3 给出证明：对 radix tree 每条边 $e$，其 KV cache 至少要算一次，设 $|e|$ 为其大小；DFS 序在 cache 容量足够时能保证每条边只算一次。在线场景下 DFS 序会被新请求打乱，但调度算法在"增广后的 radix tree"上仍近似 DFS 行为（见 §A.3）。

**关键洞察**：SGLang 把"多调用结构"从"应用层隐式约定"下沉为"runtime 显式数据结构"——基数树让共享前缀成为一等公民，命中率从"碰运气"变成"可证明最优 + 可调度逼近"。

## 5. 实验设置

- **模型**：dense Llama-2（7B/70B）、sparse MoE Mixtral-8x7B、多模态 LLaVA-v1.5-7B（图像）/ LLaVA-NeXT-34B（视频）、API 模型 GPT-3.5；开源模型 7B–70B，float16。
- **硬件**：主要 AWS EC2 G5（NVIDIA A10G 24GB）——7B 单卡、更大模型多卡 tensor parallelism；部分补充实验在 A100（80GB）。
- **基线**（除非特别说明，不开影响计算结果的优化，保证各系统算同样结果）：
  - **Guidance** v0.1.8 + llama.cpp 后端；
  - **vLLM** v0.2.5 默认 API server（注：RadixAttention 后来被部分集成为 vLLM 可选实验特性，故对比用更早版本）；
  - **LMQL** v0.7.3 + HF Transformers 后端。
- **工作负载**（12 类）：5-shot MMLU、20-shot HellaSwag、ReAct agent、generative agents、tree-of-thought（GSM-8K）、skeleton-of-thought、LLM judge（branch-solve-merge）、JSON 解码、多轮 chat（短/长输出）、DSPy RAG pipeline。
- **指标**：吞吐（programs/s，p/s，跑足够大批量取最大吞吐）与延迟（单程序串行执行，多次平均）。

## 6. 实验结果

### 6.1 端到端性能

在 Llama-7B 上（Figure 5、6），**SGLang 吞吐最高 6.4×、延迟最低降 3.7×**，增益来自 KV cache 复用、单程序内并行挖掘、加速约束解码三者叠加：

![Figure 5：Llama-7B 上归一化吞吐（越高越好）。SGLang 在 MMLU、ReAct、generative agents、tree/skeleton-of-thought、LLM judge、HellaSwag、JSON 解码、多轮 chat、DSPy RAG 等 12 类工作负载上对比 vLLM、Guidance、LMQL。](/vibe-reading/images/articles/sglang-efficient-structured-lm-programs/fig-05-throughput-llama7b.png)

![Figure 6：Llama-7B 上归一化延迟（越低越好）。SGLang 通过减少 prefill 计算与共享 KV cache 降低首 token 延迟与总延迟。](/vibe-reading/images/articles/sglang-efficient-structured-lm-programs/fig-06-latency-llama7b.png)

各基准的加速来源拆解：

| 工作负载 | 加速来源 |
|---|---|
| MMLU | 复用 5-shot 示例 KV cache——省显存换更大 batch、省 prefill 降首 token 延迟 |
| HellaSwag | 两级共享：few-shot 示例 + 多选项公共问题前缀 |
| ReAct / generative agents | 复用 agent 模板与历史调用 |
| Tree/Skeleton-of-thought | 单程序内并行化生成调用 + 尽量复用 KV cache |
| JSON 解码 | 压缩 FSM 多 token 一次解码 |
| 多轮 chat（短输出） | 复用历史 KV cache——短输出时 prefix 时间占比大，收益明显 |
| 多轮 chat（长输出） | 几乎无加速——会话间共享少、解码时间主导 |
| DSPy RAG | 复用公共 context 示例 |

缓存命中率范围 **50%–99%**；cache-aware scheduling 平均达到**最优命中率的 96%**。

### 6.2 更大模型与多模态

更大模型（Mixtral-8x7B、Llama-70B，tensor parallelism）的加速趋势与小模型一致（Figure 7），说明优化对大模型泛化良好。

![Figure 7：Mixtral-8x7B 上 tensor parallelism 的归一化吞吐（越高越好）。Guidance / LMQL 因缺高效 tensor parallelism 实现而略过。](/vibe-reading/images/articles/sglang-efficient-structured-lm-programs/fig-07-throughput-mixtral.png)

多模态（Table 2）原生支持图像/视频原语，RadixAttention 对输入图像取哈希作为基数树 key，同一图的 image token 可复用：

| 模型 | 作者原始实现 | SGLang |
|---|---|---|
| LLaVA-v1.5-7B（图像） | 0.18 image/s | **1.15 image/s** |
| LLaVA-NeXT-34B（视频） | 0.02 frame/s | **0.10 frame/s** |

### 6.3 生产部署

SGLang 已部署于 **Chatbot Arena** 服务开源模型。一个月观测：LLaVA-Next-34B 命中率 **52.4%**、Vicuna-33B 命中率 **74.1%**（来自公共 system message、常用示例图、多轮聊天历史），Vicuna-33B 首 token 延迟平均降 **1.7×**。

API 模型方面：用 few-shot prompting 从维基百科页面抽取 3 个字段，API speculative execution 准确率高，因抽取 3 字段而**省约 3× 输入 token 费**。

## 7. 消融实验

**缓存命中率 vs 性能**（Figure 8a/b，在 tree-of-thought 上部分禁用命中 token 测得）：命中率越高 → batch size 越大、吞吐越高、延迟越低。

**RadixAttention 各组件**（Figure 8c）依次关闭：No Cache、No Tree Structure（改简单表缓存）、FCFS Schedule、Random Schedule、No Frontend Parallelism、No Frontend Hint、Full Optimization——**每个组件都不可或缺**，关掉任一都退化。尤其关闭前端并行与 hint 也会导致 runtime 次优，印证**前后端协同设计**的必要性。

![Figure 8：(a)(b) 缓存命中率与首 token 延迟、总延迟、batch size、吞吐的关系；(c) RadixAttention 消融——No Cache / No Tree / FCFS / Random / No Frontend Parallelism / No Frontend Hint / Full Optimization。](/vibe-reading/images/articles/sglang-efficient-structured-lm-programs/fig-08-ablation.png)

**RadixAttention 开销**（无任何 KV 复用机会的 ShareGPT 基准）：100 请求 74.3s，管基数树结构仅 0.2s，**< 0.3%** 开销——因树操作复杂度线性且小，故可默认开启。

**压缩 FSM**（JSON 解码基准）：吞吐 **1.6×** 提升，因多 token 一次解码。此外需预处理 FSM 并对一批请求复用；否则每请求重做预处理会让吞吐 **2.4× 更低**。

## 8. 总结与展望

**贡献总结**：

1. 提出 SGLang——前端 DSL（`gen`/`select`/`fork`/`join` 等原语）+ 后端 SRT runtime，把"写 LM 程序"与"跑 LM 程序"统一为一个协同系统。
2. **RadixAttention**：首个把 KV cache 当基数树 LRU 缓存管的方案，支持多级共享、cache-aware 调度、前后端协同调度、分布式场景，并给出离线最优调度的理论证明（Theorem 3.1）。
3. **压缩 FSM**：把 singular-transition 链压成单步，多 token 一次解码，通用适用于所有正则。
4. **API speculative execution**：为黑盒 API 模型设计的投机执行，省多调用程序的延迟与输入 token 费。
5. 12 类工作负载 × 多模型 × 多硬件的系统评测 + 生产部署数据，验证"显式利用多调用结构"的有效性。

**idea 三法落地（未来工作）**：

- **弥补缺陷**：cache-aware scheduling 的贪心会**导致 starvation**[^starve]，需与公平调度方法（如 [42]）整合；当前 RadixAttention 缓存只在单 GPU 显存层，未跨**内存层级**（DRAM、Disk）[43]；匹配仍是精确前缀，未支持**模糊语义匹配**。
- **新型方案**：增强 SGLang 编译器做高级静态优化（调度、内存规划）；在 SGLang 之上提供**更高层原语**（让 DSPy 这类高级系统可编译到 SGLang，论文已示范 DSPy 后端集成）。
- **减少约束**：当前主要面向文本与图像/视频；可扩展到更多**输出模态**；前端语言与 Python 控制流已弱化"专用 DSL"的约束，进一步可探索与 AutoGen / LangChain 等框架的兼容加速。

[^starve]: 论文明确把 starvation 的修复列为 future work——贪心 longest-shared-prefix-first 会让短前缀请求长时间排不上。

**适用边界（批判性）**：SGLang 的收益**高度依赖 workload 是否有共享结构**——多轮 chat 长输出、会话间无共享时"几乎无加速"是直接证据。RadixAttention 的 0.3% 开销虽低，但若 workload 本身无 prefix 共享（如每请求独立长 prompt），其相对增益趋近于零；压缩 FSM 只对存在长 singular-transition 链的 schema 有效，对高度非确定性的约束增益有限。换言之，**SGLang 不是"通用推理加速器"，而是"LM 程序结构感知加速器"**——它的优势与 workload 的结构化程度正相关。
