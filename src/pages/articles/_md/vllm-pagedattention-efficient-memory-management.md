---
title: "Efficient Memory Management for Large Language Model Serving with PagedAttention"
source:
  type: "论文解读"
  project: "vLLM"
  url: "https://arxiv.org/abs/2309.06180"
  pdf: "/vibe-reading/papers/vllm-pagedattention-efficient-memory-management.pdf"
date: "2026-07-27"
category: [AI, Infra, Inference, vLLM, Papers]
tags: ["LLM Serving", "PagedAttention", "vLLM", "KV Cache", "Virtual Memory", "Paging", "Inference"]
description: "目的：消除 LLM 推理 KV cache 的内存浪费。手段：把 OS 虚拟内存/分页思想搬进 attention，KV 按固定大小 block 非连续存储 + block table 映射 + copy-on-write 共享。结论：相比 FasterTransformer/Orca 吞吐提升 2-4×。"
readingTime: "16 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/vllm-pagedattention-efficient-memory-management.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180) · **作者** Woosuk Kwon, Zhuohan Li, Siyuan Zhuang, Ying Sheng, Lianmin Zheng, Cody Hao Yu, Joseph E. Gonzalez, Hao Zhang, Ion Stoica（UC Berkeley / Stanford / UC San Diego）· **发表** SOSP '23, 2023-10 · **项目** https://vllm.ai · **解读** 2026-07-27

---

## 1. 论文概览

**一句话**：vLLM 把操作系统里用了 60 年的虚拟内存与分页（paging）思想搬进 LLM 推理——KV cache 不再是"一个请求一大块连续显存"，而是被切成固定大小的 block、用 block table 做逻辑→物理映射、按需分配、按引用计数共享，从而把显存浪费压到接近零，并在同等延迟下把吞吐抬升 2–4×。

- **任务**：大语言模型（LLM）在线推理服务的显存管理。LLM 服务是显存瓶颈（memory-bound）的，batch 越大吞吐越高，但 KV cache 占满了显存、限制了 batch size。
- **核心问题**：现有系统（FasterTransformer、Orca）把每个请求的 KV cache 存在一块**连续**显存里，并按"最大可能长度"预分配，导致三类浪费——预留（reserved）、内部碎片（internal frag）、外部碎片（external frag），实际有效显存占比低到 20.4%。
- **核心方法**：**PagedAttention**——attention 算法改造，使 key/value 可存于非连续的 paged memory；之上构建 **vLLM**——block-level 显存管理 + 抢占式调度 + copy-on-write 共享。
- **take-home**：GPU 算力增长快于显存容量增长（A100→H100 FLOPS 翻倍、显存仍 80GB），显存会越来越是瓶颈；而 LLM 推理的"输出长度未知、动态增长、可共享"特性，正好与 OS 虚拟内存解决的问题同构——所以 OS 的解法（分页、copy-on-write、swap、recompute）可以整套搬过来，并按 LLM 语义做特化（all-or-nothing eviction、recomputation 代替 swap 回收）。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

High throughput serving of large language models (LLMs) requires batching sufficiently many requests at a time. However, existing systems struggle because the key-value cache (KV cache) memory for each request is huge and grows and shrinks dynamically. When managed inefficiently, this memory can be significantly wasted by fragmentation and redundant duplication, limiting the batch size. To address this problem, we propose PagedAttention, an attention algorithm inspired by the classical virtual memory and paging techniques in operating systems. On top of it, we build vLLM, an LLM serving system that achieves (1) near-zero waste in KV cache memory and (2) flexible sharing of KV cache within and across requests to further reduce memory usage. Our evaluations show that vLLM improves the throughput of popular LLMs by 2-4× with the same level of latency compared to the state-of-the-art systems, such as FasterTransformer and Orca. The improvement is more pronounced with longer sequences, larger models, and more complex decoding algorithms. vLLM's source code is publicly available at https://github.com/vllm-project/vllm.

> **译：** 高吞吐的 LLM 服务要求每次 batch 足够多的请求。但现有系统表现不佳，因为每个请求的 KV cache 巨大且动态增缩。管理不当时，这块显存会被碎片化和冗余复制大量浪费，进而限制 batch size。为此我们提出 PagedAttention——一个受操作系统经典虚拟内存与分页技术启发的 attention 算法。在其之上构建 vLLM，实现（1）KV cache 显存近零浪费，（2）请求内/跨请求的 KV cache 灵活共享以进一步降低显存。实验表明，在同等延迟下 vLLM 把主流 LLM 的吞吐提升 2–4×（对比 FasterTransformer、Orca 等最先进系统）。序列越长、模型越大、解码算法越复杂，提升越显著。vLLM 源码已开源。

</details>

---

## 2. 研究背景

### 2.1 LLM 推理为什么是显存瓶颈

LLM 推理分两阶段：

1. **Prompt 阶段**：吃下整个用户 prompt，并行算出所有 token 的 key/value（matrix-matrix 乘法），GPU 利用率高。
2. **自回归生成阶段**：一次只生成一个新 token，依赖之前所有 token 的 KV cache（matrix-vector 乘法），GPU 算力严重利用不足，变成 **memory-bound**——单个请求的延迟主要由这个阶段贡献。

提升吞吐的办法是 **batch 多个请求**（共享权重、摊销权重搬运开销）。但 batch 的规模受限于 GPU 显存，而显存里最大的一块动态占用就是 **KV cache**。

以 OPT-13B 为例：单个 token 的 KV cache 就要 $2 \times 5120 \times 40 \times 2 \approx 800\text{ KB}$（key+value × hidden size × layers × FP16 字节），一条最多 2048 token 的请求的 KV cache 可达 **1.6 GB**。GPU 显存只有几十 GB，能容纳的并发请求数本来就有限，管理再低效就更少。

![图1 13B 模型在 A100 上的显存分布，及 vLLM 与现有系统的吞吐曲线对比](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-01-memory-layout.png)

> 左图：13B 模型在 A100 40GB 上，参数占 65%（26GB）静态常驻，KV cache 占近 30%，activation 只占一小撮——所以 KV cache 的管理方式直接决定最大 batch size。右图：vLLM 把现有系统那条陡峭的 KV cache 增长曲线磨平，显著抬升吞吐。

论文还点出一个长期趋势：**GPU 算力增长快于显存容量**（A100→H100 FLOPS 翻倍多、显存仍 80GB 上限），所以显存只会越来越是瓶颈——这是这篇工作"值得做"的根本理由。

### 2.2 现有系统怎么管理 KV cache，又为什么低效

FasterTransformer、Orca 这类系统受深度学习框架约束（要求 tensor 存在**连续**显存），把一个请求的 KV cache 当成一整块连续 tensor，并按"该请求最大可能序列长度"**静态预分配**一整块。

这带来三类浪费（论文 Fig. 3 直观画出）：

- **Reserved（预留）**：为未来可能生成的 token 预留的槽位。虽然最终会被用，但整个请求生命周期都占着，别的短请求用不上。
- **Internal fragmentation（内部碎片）**：按最大长度（如 2048）预分配，但实际输出可能很短——多出来的空间请求结束后才发现没用过，是纯浪费。
- **External fragmentation（外部碎片）**：不同请求预分配大小不同，buddy allocator 之类的分配器产生的外部碎片，永远用不上，且服务请求前就知道。

![图3 现有系统的 KV cache 显存管理：reserved / internal frag / external frag 三类浪费](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-03-existing-mgmt.png)

profiling 结果触目惊心（Fig. 2）：在现有系统里，真正用来存 token states 的有效显存占比只有 **20.4%–38.2%**，剩下全是浪费。

![图2 不同系统平均显存浪费占比：现有系统有效显存仅 20.4%–38.2%，vLLM 达 96.3%](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-02-memory-wastes.png)

更糟的是，**连续存储使得 KV cache 共享不可能**：并行采样（一个 prompt 出多条采样）、beam search（多个候选共享前缀）这些场景本可共享 prompt 部分的 KV cache，但分属不同连续空间，无法共享，只能各自复制一份。

### 2.3 相关工作与定位

- **Orca**（OSDI '22）：提出 iteration-level scheduling，把 batch 粒度从"请求级"降到"迭代级"，让请求随到随进 batch、消除 padding。论文定位：Orca 与 vLLM **互补**——Orca 靠调度让更多请求并行，vLLM 靠显存让更多请求的 working set 装得下；而且 Orca 的细粒度调度反而让显存管理更难，更需要 vLLM。
- **FasterTransformer**（NVIDIA）：为延迟优化的分布式推理引擎，没有自己的调度器，无细粒度 batching。
- **FlashAttention**：用 tiling + kernel 优化降低 attention 的峰值显存与 I/O，但不做 block 级在线显存管理。
- **FlexGen**：研究 offload 权重/状态到 CPU/磁盘，但面向低显存离线推理，不是在线服务。

---

## 3. 方法详解

vLLM 的核心是 **PagedAttention 算法** + 围绕它重新设计的 **KV cache manager / scheduler / distributed execution**。整套设计的灵感来自 OS 虚拟内存：**block = page，token = byte，request = process**。

### 3.1 系统总览

![图4 vLLM 系统总览：centralized scheduler + KV cache manager + 分布式 GPU workers](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-04-vllm-overview.png)

vLLM 用一个**集中式 scheduler**协调分布式 GPU workers。KV cache manager 通过 scheduler 下发的指令，以 paged 方式管理 GPU worker 上的物理 KV cache。关键点：所有 worker 共享同一份 logical→physical block 映射（block table），但每个 worker 只存自己那份 attention head 对应的 KV cache。

### 3.2 PagedAttention：让 KV 存在非连续显存

传统 attention 要求 key/value 连续。PagedAttention 把一个序列的 KV cache 切成 **KV block**，每个 block 装固定数量 $B$ 个 token 的 key/value（$B$ 即 **block size**）。第 $j$ 个 key block $K_j = (k_{(j-1)B+1}, \dots, k_{jB})$，value block $V_j$ 同理。attention 被改写成 **block-wise** 计算：query 一次和一个 block 的 keys 算出该 block 的 attention 分数 $A_{ij}$，再用 $A_{ij}$ 加权该 block 的 values。kernel 按 block table 分别 fetch 不同 block。

![图5 PagedAttention：key/value 散落在三个非连续物理 block 中，kernel 按 block 读取计算](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-05-pagedattention.png)

结果是：**KV block 可以存在非连续物理显存**，从而解锁了类似 OS 虚拟内存的灵活管理。

### 3.3 KV Cache Manager：逻辑 block ↔ 物理 block

类比 OS 虚拟内存：

- 一个请求的 KV cache 表示成一串**逻辑 block**，从左到右随新 token 填充；最后一个 block 的空位预留给后续生成。
- GPU 上由 block engine 预分配一大块连续 DRAM，切成等大的**物理 block**（CPU RAM 上也有一份，用于 swap）。
- 每个请求维护一张 **block table**：记录每个逻辑 block 对应的物理 block 号 + 已填充位置数。逻辑上连续的 block，物理上可以不连续。

分离逻辑与物理后，vLLM **按需分配**物理 block——只有当上一个逻辑 block 填满、新 token 需要新 block 时才分配，从而把一个请求的显存浪费限制在**最后一个 block 内部**（最多浪费 $B-1$ 个槽位），消除外部碎片（所有 block 等大）。

### 3.4 解码过程走查

论文用 Fig. 6 走查了一个 7-token prompt（"Four score and seven years ago our"）的解码：

1. **Prefill**：vLLM 不预分配最大长度显存，只给 prompt 需要的 2 个逻辑 block（0、1）映射到物理 block 7、1。常规 self-attention 算出 prompt 的 KV，前 4 个 token 存逻辑 block 0、后 3 个存逻辑 block 1，最后一个空槽留给生成阶段。
2. **第 1 步生成**：新 token 的 KV 存进最后一个逻辑 block 的空槽，更新 block table 的 `#filled`。
3. **第 2 步生成**：最后一个逻辑 block 满了，分配新物理 block 3，写入映射。

![图6 vLLM block table 翻译：逻辑 block 经 block table 映射到非连续物理 block](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-06-block-table.png)

每个解码迭代，vLLM 先选 batch、为新逻辑 block 分配物理 block，把当前迭代所有输入 token 拼成一个序列喂给 LLM，PagedAttention kernel 按 block table 读写 KV。block size > 1 让 kernel 能并行处理更多位置、提高硬件利用率；但 block 太大又会增加碎片、降低共享概率（§7.2 研究，默认 16）。

两个请求共存时（Fig. 7），各自的逻辑 block 映射到不同物理 block，相邻逻辑 block 物理上不必连续，物理 block 空间被两个序列有效复用。

![图7 两个请求同时存在于 vLLM：逻辑 block 映射到不同物理 block，物理空间被有效复用](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-07-two-requests.png)

### 3.5 复杂解码：靠引用计数 + copy-on-write 共享

PagedAttention 真正的杀手锏是**跨序列共享 KV cache**。每个物理 block 带一个**引用计数**：

- **Parallel sampling**（一个 prompt 出多条采样，如 Copilot 给多个候选）：所有采样共享 prompt 的物理 block（引用计数 >1）。生成阶段各采不同 token，对需要写入的共享 block 触发 **copy-on-write**——分配新物理 block、拷贝内容、引用计数减一（和 OS fork 进程时一模一样）。只有最后一个逻辑 block 需要 CoW，其余 prompt KV 全程共享。

![图8 Parallel sampling：两个采样共享 prompt 的物理 block，写入时 copy-on-write](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-08-parallel-sampling.png)

- **Beam search**（机器翻译等要 top-k）：共享不仅限于 prompt，候选之间还能共享中间 block，且共享模式随解码动态演变（像 OS 里复合 fork 出的进程树）。被淘汰候选的 block 引用计数归零即释放；新候选复用幸存候选的 block，只在写入旧共享 block 时 CoW。这把以往"频繁大块 KV 拷贝"的开销降到"最多拷一个 block"。

![图9 Beam search：候选间动态共享物理 block，淘汰即释放、复用即引用](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-09-beam-search.png)

- **Shared prefix**（系统 prompt / few-shot 示例）：服务方可预先把共享前缀的 KV cache 存进一组物理 block（像 OS 的共享库），命中该前缀的请求直接把逻辑 block 映射过去（最后一个 block 标 CoW），prefill 只需算用户任务输入部分。
- **Mixed decoding**：不同解码偏好的请求可同 batch 处理——因为复杂共享被 block table 这层映射屏蔽了，LLM 与 kernel 只看到一串物理 block ID，无需感知跨序列共享。这扩大了 batching 机会。

### 3.6 调度与抢占：内存不够时怎么办

请求输出长度事先未知，显存可能耗尽。vLLM 用 **FCFS** 保公平、防饥饿；显存不足时**后到的先被抢占**。由于一个序列的所有 block 是一起被访问的，vLLM 用 **all-or-nothing eviction**（要么全留要么全逐出），同一请求内的多个序列（如 beam 候选）作为 sequence group **gang-scheduled**（一起抢占/一起重调）。恢复被逐出的 block 有两条路：

- **Swapping**：把逐出 block 拷到 CPU RAM（经典虚拟内存 swap），需要时再换回。CPU 上的 swap 空间不超过 GPU 上 KV cache 总量，有界。
- **Recomputation**：直接重算。把已生成 token 和原 prompt 拼成新 prompt 走一次 prefill，一次性算出所有位置的 KV——重算延迟可远低于原始延迟。

§7.3 比较两者：block 小时 swap 因大量小数据传输打不满 PCIe 带宽而低效；recompute 开销与 block size 无关，恒定且不超过 swap 的 20%。中等 block（16–64）两者端到端相当。

### 3.7 分布式执行

大模型要张量并行（Megatron-LM 风格）。关键观察：即便模型并行，每个 model shard 处理的是**同一批输入 token**，需要**同样位置**的 KV cache。所以 vLLM 用**单一 KV cache manager**（在 scheduler 内），所有 worker 共享同一份 logical→physical 映射——每个 worker 拿到相同的物理 block ID，但只存自己那份 attention head 的 KV。每步 scheduler 把 input token IDs + block table 广播给 workers，workers 在 attention 层按 block table 读 KV、用 all-reduce 同步中间结果，无需在显存管理上同步。

---

## 4. 关键公式解读

### 4.1 自回归分解与 attention

语言建模把序列概率分解为条件概率之积（自回归）：

$$
P(x) = P(x_1) \cdot P(x_2 \mid x_1) \cdots P(x_n \mid x_1, \dots, x_{n-1})
$$

对位置 $i$，self-attention 先线性变换得到 query/key/value，再算 attention 分数与输出：

$$
a_{ij} = \frac{\exp(q_i^\top k_j / \sqrt{d})}{\sum_{t=1}^{i} \exp(q_i^\top k_t / \sqrt{d})}, \quad o_i = \sum_{j=1}^{i} a_{ij} v_j
$$

这正是 KV cache 的来源：生成 $x_{n+t}$ 时，位置 $1 \dots n+t-1$ 的 $k, v$ 都要复用，所以缓存下来。

### 4.2 PagedAttention 的 block-wise 改写

把连续的 attention 改写成按 block 求和，是 PagedAttention 的数学核心（公式 4）：

$$
A_{ij} = \underbrace{\frac{\exp(q_i^\top K_j / \sqrt{d})}{\sum_{t=1}^{\lceil i/B \rceil} \exp(q_i^\top K_t \mathbf{1} / \sqrt{d})}}_{\text{第 } j \text{ 个 block 的 attention 分数行向量}}, \quad o_i = \sum_{j=1}^{\lceil i/B \rceil} V_j A_{ij}^\top
$$

其中 $K_j, V_j \in \mathbb{R}^{B \times d}$ 是第 $j$ 个 block 的 key/value 矩阵，$A_{ij} \in \mathbb{R}^{1 \times B}$ 是 query $q_i$ 对该 block 内各位置的 attention 分数行向量。**关键区别**：传统 attention 对整个连续序列求和，这里对每个 block 单独算分数、单独加权求和再累加——于是 kernel 可以**逐 block fetch**，KV 物理上不连续也无所谓。

### 4.3 显存浪费对比

现有系统一个请求的浪费上界≈最大长度对应的整块（internal frag 占大头）；vLLM 的浪费上界只有一个 block：

$$
\text{waste}_{\text{vLLM}} \le B - 1 \quad \text{（每个请求最多浪费最后一个 block 内的空槽）}
$$

配合 block 等大（无 external frag）+ 按需分配（无 reserved 长期占用），这就是 Fig. 2 里 vLLM 有效显存达 96.3% 的由来。

---

## 5. 实验设置

| 维度 | 配置 |
| --- | --- |
| **模型** | OPT-13B / OPT-66B / OPT-175B / LLaMA-13B |
| **硬件** | Google Cloud A2 实例，NVIDIA A100（13B 单卡 40GB，66B 4 卡 160GB，175B 8 卡 80GB 共 640GB） |
| **KV cache 显存** | 13B: 12GB / 66B: 21GB / 175B: 264GB |
| **工作负载** | ShareGPT（真实 ChatGPT 对话，输入均长 161、输出均长 338）+ Alpaca（GPT-3.5 自指令生成，输入均长 19、输出均长 58）。用泊松分布合成不同请求到达率，多数跑 1 小时 trace（175B 因成本跑 15 分钟） |
| **基线 1** | **FasterTransformer**——为延迟优化的引擎，无自带调度器，作者给它配了类 Triton 的动态 batching，batch size 拉满 |
| **基线 2** | **Orca**——SOTA 吞吐系统（未开源，作者自己复现，buddy allocator），按过度预留程度分三档：**Oracle**（已知真实输出长度，性能上界，实际不可达）/ **Pow2**（按 2× 上取整预留）/ **Max**（按模型最大长度 2048 预留） |
| **指标** | 吞吐——用 **normalized latency**（每请求端到端延迟 / 输出长度，单位 s/token）对请求率作图；高吞吐系统应在高请求率下仍保持低 normalized latency |
| **代码** | https://github.com/vllm-project/vllm （8.5K 行 Python + 2K 行 C++/CUDA，FastAPI 前端兼容 OpenAI API） |

---

## 6. 实验结果

### 6.1 基础采样：2–4× 吞吐提升

![图12 基础采样：OPT-13B/66B/175B 在 ShareGPT 与 Alpaca 上的 normalized latency vs 请求率](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-12-basic-sampling.png)

ShareGPT 上，vLLM 在同等延迟下能撑住 **1.7×–2.7×** 于 Orca(Oracle)、**2.7×–8×** 于 Orca(Max) 的请求率；对比 FasterTransformer 高达 **22×**（FT 无细粒度调度且显存管理同 Orca(Max)）。关键原因：vLLM 显存管理高效，能 batch 更多请求——OPT-13B 上同时 batch 的请求数 vLLM 是 Orca(Oracle) 的 2.2×、Orca(Max) 的 4.3×（Fig. 13）。

![图13 平均同时 batch 的请求数：vLLM 远超各 Orca 变体](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-13-batched-requests.png)

一个反直觉点：OPT-175B + Alpaca（短序列）时，vLLM 对 Orca(Oracle/Pow2) 优势变小——因为 175B 配置留给 KV cache 的显存很大、Alpaca 序列又短，Orca 也能 batch 很多请求，系统变成 **compute-bound 而非 memory-bound**。这恰好印证论文的论断：vLLM 的收益来自缓解显存瓶颈，瓶颈不在显存时收益自然减小。

### 6.2 并行采样与 beam search：共享带来更大收益

并行采样/beam search 暴露了 KV cache 共享的价值。vLLM 对 Orca(Oracle) 的优势从基础采样的 1.3× 涨到 beam search（width=6）的 **2.3×**——共享越多、收益越大。

![图15 KV block 共享带来的显存节省：beam search 高达 55.2%，ShareGPT 上更达 66.3%](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-15-memory-saving.png)

显存节省实测：Alpaca 上并行采样省 6.1%–9.8%、beam search 省 37.6%–55.2%；ShareGPT 上更高达并行采样 16.2%–30.5%、beam search 44.3%–66.3%。

### 6.3 共享前缀与 chatbot

- **共享前缀**（LLaMA-13B，WMT16 英德翻译）：1-shot 前缀时 vLLM 比 Orca(Oracle) 高 1.67× 吞吐；5-shot 前缀（共享更多）时高 **3.58×**。
- **Chatbot**（ShareGPT 合成，prompt 截断到 1024 token）：vLLM 能撑住 2× 于三个 Orca 变体的请求率。因为 ShareGPT 多长对话、prompt 都接近 1024 token，Orca 的 buddy allocator 一律按 1024 预留输出空间，三个变体表现接近；vLLM 靠 PagedAttention 解决碎片与预留问题胜出。

### 6.4 关键数值汇总

| 场景 | vLLM 优势（vs Orca Oracle / Max / FT） |
| --- | --- |
| 基础采样 ShareGPT | 1.7×–2.7× / 2.7×–8× / 最高 22× |
| beam search width=6（vs Oracle） | 2.3× |
| 5-shot 共享前缀（vs Oracle） | 3.58× |
| chatbot（vs 三 Orca 变体） | 2× |
| 显存有效占比 | 96.3%（vs 现有 20.4%–38.2%） |

---

## 7. 消融实验

### 7.1 kernel 微基准：PagedAttention 的代价

动态 block 映射带来额外开销——查 block table、额外分支、处理变长序列。相比高度优化的 FasterTransformer attention kernel，vLLM 的 attention kernel 延迟高 **20%–26%**。但作者论证这开销可接受：只影响 attention 算子，不影响 Linear 等其他算子；且端到端 vLLM 仍远胜 FT（§6）。

![图18 消融：attention kernel 延迟（左）与不同 block size 的端到端延迟（右）](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-18-ablation-kernel-blocksize.png)

### 7.2 block size 的影响

block size 是核心超参：

- **太小**：GPU 并行度不足，读/处理 KV cache 的硬件利用率低。
- **太大**：内部碎片增加、共享概率下降。

ShareGPT 上 block size 16–128 最佳；Alpaca（短序列）上 16/32 好，再大就因序列短于 block 而显著退化。实践折中——**默认 block size = 16**：大到能有效利用 GPU，小到在多数负载下避免显著内部碎片。

### 7.3 recompute vs swap

![图19 recompute 与 swap 在不同 block size 下的开销（左）与端到端性能（右）](/vibe-reading/images/articles/vllm-pagedattention-efficient-memory-management/fig-19-recompute-swap.png)

- block 小时 swap 低效（大量小数据传输打不满 PCIe 带宽）；recompute 开销与 block size 无关、恒定，且永远不超过 swap 延迟的 20%。
- block 大时 swap 更高效。
- 中等 block（16–64）两者端到端相当。

---

## 8. 总结与展望

### 8.1 贡献总结

1. **识别并量化**了 LLM 服务中 KV cache 显存管理的挑战——三类浪费让有效显存低到 20.4%。
2. **PagedAttention**：首个让 attention key/value 存于非连续 paged memory 的算法，灵感直接来自 OS 虚拟内存与分页。
3. **vLLM**：在 PagedAttention 之上的分布式推理引擎，block-level 显存管理 + 抢占式调度 + copy-on-write 共享，实现近零显存浪费。
4. **实测 2–4× 吞吐提升**（序列越长、模型越大、解码越复杂越显著），且不损失模型精度。

更深层的贡献是一种**方法论**：把成熟的 OS 技术（分页、虚拟内存、copy-on-write、swap、recompute）整套迁移到 LLM 推理，并按 LLM 语义做特化——all-or-nothing eviction（利用"一个请求的所有 token 状态要一起在显存里"）、recompute 代替 swap 回收（OS 里不可行，LLM 里因 prefill 可并行重算而可行）、kernel 融合掩盖内存间接寻址开销。

### 8.2 局限性（批判性）

- **attention kernel 20%–26% 开销**：动态 block 映射的代价真实存在，只是被端到端吞吐优势掩盖。对纯 compute-bound、序列极短的场景，vLLM 优势会缩小（§6.1 的 175B+Alpaca 已显示）。
- **适用边界**：论文自己指出，分页对"输出长度未知 + 显存是瓶颈"的负载有效，但**不是所有 GPU 负载都适用**——DNN 训练张量形状静态、可提前优化；非 LLM 的 DNN 服务多是 compute-bound，引入分页的内存间接寻址与非连续 block 反而可能拖慢性能。
- **swap 的局限**：block 小时 swap 低效，依赖 block size 调参；recompute 虽恒定但毕竟要重算、占 GPU 算力。
- **未触及的层面**：本文聚焦 KV cache 显存管理，不解决权重显存、量化、长上下文的注意力算法本身（如 FlashAttention 的 IO 优化是正交的，可叠加）。

### 8.3 未来方向（idea 三法）

**弥补缺陷**：

- 把 PagedAttention kernel 的 20%+ 开销通过更激进的 kernel 融合（如与 FlashAttention 的 tiling 思路结合）和硬件感知的 block layout 降下来。
- 自适应 block size：按工作负载的长度分布在线调整 block size，避免 Alpaca 类短序列场景的退化。

**新型方案**：

- 将 block-level 分页推广到**多层存储层级**（GPU HBM ↔ CPU RAM ↔ NVMe SSD）的统一管理，配合预取(prefetching)预测下一个要访问的 block，把 swap 从被动逐出变成主动预取。
- 结合 prefix caching 的热度信息做 LRU/LFU 混合淘汰，让共享前缀的命中率最大化。

**减少约束**：

- 当前 all-or-nothing eviction 假设"序列所有 block 一起访问"。若引入**部分重算 + 部分保留**的混合策略（只逐出远离当前生成位置的旧 block、需要时重算），可降低 swap/recompute 的瞬时开销，逼近更细粒度的 page replacement。
- 把分页管理下沉到**编译器/框架层**（如把 PagedAttention 集成进 PyTorch / x executor），让任意 attention 变体（GQA、MQA、滑动窗口）自动获得非连续显存能力，而非只在 vLLM 里手写 kernel。

---

> **一句话收尾**：vLLM 的胜利，是"把对的旧思想用在对的新问题 上"的胜利——OS 用 60 年证明分页能解决动态增长的内存管理，vLLM 发现 LLM 的 KV cache 有着完全同构的特征，于是整套搬来并按 LLM 语义改造，2–4× 的吞吐提升几乎是免费的。
