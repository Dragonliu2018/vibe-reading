---
title: "沐曦芯生，开源共创——SGLang 技术交流meetup"
date: "2026-08-23T15:58:39+08:00"
category: [AI, Infra, Inference, SGLang, Meetups]
tags: ["SGLang", "Mooncake", "HiCache", "RadixAttention", "沐曦", "异构算力", "推理引擎", "PD 分离"]
description: "2026-06-06 沐曦股份主办的 SGLang 技术交流meetup 技术解读：SGLang Roadmap、HiCache 分层缓存、Mooncake 解耦架构、沐曦 GPU 适配与 AI 性能分析范式。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **活动** 沐曦芯生，开源共创——SGLang 技术交流meetup · **主办** 沐曦股份 · **时间** 2026-06-06 14:00–17:00 · **地点** 北京·融科资讯中心 B 座 · **议程** [developer.metax-tech.com/activities/15](https://developer.metax-tech.com/activities/15) · **本篇** 基于公开议程的技术解读，非主办方逐字实录

---

## 活动概览

2026 年 6 月 6 日，国产 GPU 厂商沐曦股份（MetaX）在北京主办了「沐曦芯生，开源共创——SGLang 技术交流meetup」。整场活动围绕 **SGLang 开源生态、沐曦 GPU 深度适配、Mooncake 推理架构、AI 性能分析工具** 四条主线，以六场主题演讲加一场圆桌收束。讲者阵容覆盖了 SGLang 核心维护方（RadixArk）、云厂商推理工程师（阿里云、腾讯云）以及沐曦自身推理引擎开发者——这条讲者链恰好把「开源框架 ↔ 云上落地 ↔ 国产硬件」三层串了起来。

主办方在活动简介里把这次聚会的定位写得很克制——「推动国产算力与开源系统在理性与热忱中协同演进」。换算成工程语言，它要回答的问题其实是：**当一个高性能推理引擎（SGLang）遇上一种新的硬件后端（沐曦 GPU），又叠加上一种解耦式缓存架构（Mooncake），这套组合如何在真实负载下把延迟、吞吐和显存三者的边界往前推。**

完整议程如下：

| 时间 | 议程 | 讲者（单位） |
| --- | --- | --- |
| 14:10–14:40 | SGLang Roadmap：面向大模型与多模态模型的高性能开源推理系统 | 童心源（SGLang / RadixArk Core Maintainer）|
| 14:40–15:10 | 从全链路可观测到智能分析：AI 性能分析范式的演进与实践 | 苏峰、常怀鑫（阿里云工程师、SGLang Developer）|
| 15:20–15:25 | 融科资讯中心科创生态分享 | 褚昱岑（融科资讯中心）|
| 15:25–15:55 | 记忆感知驱动：基于 Mooncake 的多智能体推理架构优化 | 马腾（阿里云高级技术专家）|
| 15:55–16:25 | 从社区到生产：基于 SGLang HiCache + Mooncake 的深度优化与企业级落地 | 陈凯悦（腾讯云高级工程师）|
| 16:25–16:55 | 沐曦 GPU 对 SGLang 的深度适配与工程实践 | 杨鑫（沐曦股份 SGL 推理引擎核心开发者）|
| 16:55–17:25 | 圆桌：异构算力下的推理效能革命——SGLang 前沿优化与企业落地实践 | 李兆石（沐曦股份 AI 研究院院长）主持 |

下面按议题拆解其中的技术脉络。需要说明的是，各场演讲的内部细节并未公开披露，本文对工程机制的解读基于 SGLang v0.5.18 源码、Mooncake 论文与公开技术资料，凡涉及具体讲者观点而无法核实处，均标注为议程主题推演。

---

## SGLang：高性能推理运行时的架构基石

童心源（SGLang / RadixArk Core Maintainer）的开场演讲定调了整场活动的技术基线——**SGLang 是一个「运行时优先」的推理服务框架**。它的目标不是「跑一次 forward」，而是把「高效服务一个大模型」这件事工程化：前缀缓存复用、零开销 CPU 调度、连续批处理、推测解码、多种并行策略，让推理变成一个可编排、可缓存、可扩展的运行时系统。

从 v0.5.18 的源码结构看，SGLang 把一次推理请求的生命周期拆成五个可独立优化的层，自上而下依赖：

| 架构层 | 目录 | 职责 |
| --- | --- | --- |
| 接口层 | `srt/entrypoints/` + `cli/` | 隔离外部协议（OpenAI / Anthropic / Ollama / gRPC），保护运行时 |
| 编排层 | `srt/managers/` | 调度、连续批处理、tokenize/detokenize、数据并行路由 |
| 执行层 | `srt/model_executor/` + `speculative/` | 一次 forward 的全部逻辑：批次装配、CUDA Graph、推测解码、采样 |
| 缓存层 | `srt/mem_cache/` | KV 物理显存与逻辑前缀共享，RadixAttention 所在 |
| 模型算子与硬件层 | `models/` + `layers/` + `sgl-kernel/` + `hardware_backend/` | 模型实现、attention/MoE/量化算子、多硬件适配、并行通信 |

![SGLang 系统架构图](/vibe-reading/images/articles/sglang-v0518/architecture.svg)

这五层里有两个设计决定了 SGLang 的性能上限，也是后续几场演讲反复引用的基础：

**一是 RadixAttention。** SGLang 用 radix tree 组织 KV cache，使任意长度的公共前缀自动共享一份 KV。多请求共享 system prompt / few-shot / 多轮上下文时，KV 既不重复计算也不重复存储。物理池（`KVCache` 持续 per-layer 张量）与逻辑树（`TreeNode` 只存 slot 索引）分离，使 evict/insert 只动索引不搬数据。

**二是 overlap 零开销调度。** `event_loop_overlap`（`scheduler.py:1754`）让 CPU 调度逻辑与上一轮 GPU forward 并行——`run_batch` 启动 GPU 计算后立即把批次浅拷贝连同结果入 `result_queue` **延迟一步**处理，紧接着的 `process_batch_result` 处理的是上一轮的结果，与当前 GPU 计算重叠。这是「CPU 调度几乎不占 GPU 时间」的关键。

Roadmap 演讲的标题已经把方向说清楚——「面向大模型与多模态模型」。SGLang 在 v0.5.x 已经把多模态生成（`multimodal_gen/`）与图像/音频扩散模型（LongCat-Image、LongCat-AudioDiT 等）纳入同一套调度框架，并支持 EAGLE / DFlash / DSpark / n-gram / FrozenKVMTP 多种推测解码（注册表式扩展，`speculative/spec_info.py` 的 `@SpeculativeAlgorithm.register`）。这条路线意味着 RadixAttention 与 overlap 调度不再只为文本 decode 服务，而是要兼容扩散采样的多步迭代与多模态前缀——后文 HiCache 与 Mooncake 的很多优化正是在这个更宽的工作负载下才有意义。

---

## HiCache：把 KV 缓存做成多级存储

陈凯悦（腾讯云）的「从社区到生产」演讲把焦点收拢到 SGLang 的招牌特性之一——**HiCache 分层缓存**。要理解它解决的问题，先看单级 KV cache 的瓶颈：显存有限，长上下文请求一多，radix tree 里的热点前缀会被 LRU 淘汰，下一次命中就得重算 prefill，TTFT（首 token 延迟）随之飙升。

SGLang 的 `HiRadixCache`（`hiradix_cache.py:48`）继承 `RadixCache`，把缓存扩展为三层：

| 层级 | 介质 | 实现 | 作用 |
| --- | --- | --- | --- |
| L1 | GPU 显存 | `KVCache` 物理 KV 张量 | 命中零开销，容量最小 |
| L2 | Host pinned CPU tensor | `HostKVCache` | 显存不够时的溢出层，`init_load_back` 异步回传 GPU |
| L3 | 远端 | `KVCacheEventMixin` 发出 `BlockStored` / `BlockRemoved` 事件 | 跨实例共享，与 Mooncake 这类全局 KV 池对接的钩子 |

![缓存层架构](/vibe-reading/images/articles/sglang-v0518/mem-cache-architecture.svg)

L2/L3 的引入把 KV cache 从「一块显存」变成了「一个多级存储系统」，于是写策略和淘汰策略都得重新设计。`HiRadixCache` 用 `write_through_threshold` 控制三种写策略：`write_through`（写穿到 host）、`write_back`（写回，延迟 staging）和默认的 `write_through_selective`——后者只备份热点（`hit_count >= 2` 才触发 `write_backup`），避免冷数据挤占 host 内存。被 evict 的前缀可以从 host `load_back` 恢复而非重算，这是降 TTFT 的核心机制。

淘汰策略则从单一带宽扩展到 7 种，由 `get_eviction_strategy`（`utils.py:67`）工厂注入，`RadixCache.evict` 只调 `eviction_strategy.get_priority` 建 min-heap，不改 cache 本体：

| 策略 | 优先级键 | 适用 |
| --- | --- | --- |
| LRU（默认）| `last_access_time` | 通用 |
| LFU | `(hit_count, last_access_time)` | 热点稳定 |
| FIFO / FILO | `creation_time` / `-creation_time` | 顺序敏感 |
| MRU | `-last_access_time` | 最近优先 |
| Priority | `(priority, last_access_time)` | 业务定制 |
| SLRU | `(is_protected, last_access_time)` | 双段防长前缀挤占热点 |

SLRU 尤其值得注意——它把缓存分成 protected / probationary 两段，`hit_count >= threshold` 才进入 protected 段，防止单次长前缀把真正的热点挤出去。这种策略多样性是「从社区到生产」的典型信号：社区版用一个 LRU 就够，生产环境面对混合负载必须让淘汰策略可插拔。

HiCache 的 L3 是后文与 Mooncake 合流的关键钩子——`KVCacheEventMixin` 在 KV 块存入或移除时发出事件，远端订阅者据此维护全局视图。这套事件机制正是 SGLang 接入全局 KV 池的入口。

---

## Mooncake：KVCache-centric 的解耦推理架构

马腾（阿里云）的演讲把视野从单实例缓存拉到集群层面——**Mooncake**。它是 Moonshot AI 为 Kimi 服务构建的推理平台，论文标题一句话点题：*A KVCache-centric Disaggregated Architecture for LLM Serving*（arXiv 2407.00079）。

Mooncake 的核心主张是**以 KVCache 为中心做架构解耦**，具体落到三件事上：

**1. Prefill / Decode 集群分离。** prefill（首计算长上下文 KV，compute-bound）与 decode（逐 token 自回归，memory-bound）的资源画像截然不同——前者吃算力，后者吃显存带宽。Mooncake 把它们部署到不同集群，分别优化吞吐与延迟，避免 decode 的显存抢占 prefill 的算力。这正是 SGLang 里 `srt/disaggregation/` 模块（PD 分离）在集群层面的对应物。

**2. Disaggregated KVCache。** Mooncake 利用 GPU 集群里被低估的 CPU、DRAM、SSD 资源，把 KVCache 做成跨层级的解耦缓存——显存放不下的 KV 可以沉到 CPU DRAM，再放不下沉到 SSD。这与 SGLang HiCache 的 L1→L2→L3 思路完全同构，区别在于 Mooncake 是面向集群规模设计的，把全局 KV 池当成一等公民。

**3. KVCache-centric scheduler。** Mooncake 的调度器以 KV 复用为调度核心——请求路由时优先复用已缓存的 KV 前缀，在最大化整体有效吞吐与满足延迟 SLO 之间平衡。论文特别强调一个被传统研究忽略的场景：**高度过载**。传统假设所有请求都会被处理，Mooncake 面对的是排队长龙，于是引入了基于预测的 early rejection（提前拒绝）策略——宁可早拒，不让请求排队到 SLO 破裂。

论文给出的数字很有说服力：在长上下文场景的模拟中，对比 baseline 最高可达 **525% 的吞吐提升**（同时满足 SLO）；在 Kimi 的真实负载下，这套架构让 Kimi 多承载了 **75% 的请求**。

马腾的演讲主题「记忆感知驱动：基于 Mooncake 的多智能体推理架构优化」指向一个更前沿的方向——当推理系统从「单轮问答」走向「多智能体协作」时，每个 agent 都带自己的长上下文与多轮记忆，KV 复用的收益被急剧放大。Mooncake 的全局 KV 池让 agent 间的共享前缀（共享工具定义、共享环境状态、共享对话历史）可以跨实例复用，而「记忆感知」调度则让系统知道哪些 agent 会复用哪些 KV，提前做 prefetch。这本质上是把 RadixAttention 的「前缀共享」从单实例 radix tree 推广到了集群规模。

---

## HiCache + Mooncake：从社区到生产的融合点

陈凯悦那场演讲的标题已经把工程命题说透——**「基于 SGLang HiCache + Mooncake 的深度优化与企业级落地」**。前两节分别讲了 SGLang 的多级缓存和 Mooncake 的全局 KV 池，这一场要回答的是：当两者在企业里合体时会遇到什么。

技术上，两者的对接点就是上节提到的 **HiCache L3 事件钩子**。SGLang 侧 `KVCacheEventMixin` 在 KV 块 `BlockStored` / `BlockRemoved` 时发事件，Mooncake 侧的全局调度器订阅这些事件维护集群级 KV 视图；反过来，当一个请求路由到新实例、本地 L1/L2 都 miss 时，Mooncake 调度器可以指明「这段 KV 在远端某节点」，SGLang 经 L3 `load_back` 拉回，避免重算 prefill。这套闭环让 radix tree 的前缀共享突破了单实例边界。

但「从社区到生产」真正的难处不在机制对接，而在工程化约束：

- **SLO 约束**：社区版追求吞吐，生产版要在 P99 延迟约束下取舍。Mooncake 的 early rejection 与 SGLang 的 `PrefillAdder` 准入控制（按 `rem_total_tokens` / `rem_chunk_tokens` 预算）必须在同一套预算模型里对齐。
- **高可用**：全局 KV 池本身要容错，远端节点失效时 L3 降级不能拖垮整条请求链路。
- **多租户**：不同租户的 KV 隔离与共享前缀的收益要在调度器里显式建模。
- **一致性**：KV 块在 L1/L2/L3 间的多副本，evict 与 load_back 不能产生幻读——这恰是 SGLang `inc_lock_ref` / `dec_lock_ref` 引用计数机制（从节点向 root 遍历）在集群规模下的延伸。

腾讯云作为既服务多模态又服务大规模文本推理的云厂商，其落地经验对「HiCache 三种写策略在生产里到底选哪个」「SLRU 的 protected_threshold 怎么调」这类问题最有发言权——这些细节超出了本文能从公开源码核实的范围，留待讲者分享。

---

## 沐曦 GPU 对 SGLang 的深度适配

杨鑫（沐曦股份 SGL 推理引擎核心开发者）的演讲是整场活动最「硬」的一场——**沐曦 GPU 对 SGLang 的深度适配与工程实践**。它回答的是一个关键问题：SGLang 的多硬件抽象能不能真正承载一种新的国产 GPU？

从 SGLang 源码看，多硬件适配的入口是 `srt/hardware_backend/`，v0.5.18 已支持 NVIDIA / AMD / Intel CPU / TPU / Ascend NPU。这套抽象把「硬件差异」收敛在几个扩展点上：

| 适配维度 | SGLang 扩展点 | 适配新 GPU 要做什么 |
| --- | --- | --- |
| 硬件后端 | `hardware_backend/` 的后端类 | 实现设备探测、显存查询、stream 管理 |
| Attention 后端 | `get_attn_backend()` 经 `ForwardContext` 全局取 | 提供该 GPU 上的 attention kernel（前缀缓存、tree attention） |
| 底层算子 | `sgl-kernel/`（CUDA C++ / Triton） | 移植 paged 分配、tree attention、采样等算子到新指令集 |
| CUDA Graph | `model_executor/runner/` 的 capture/replay | 新 GPU 需支持整图捕获重放与分桶 padding |
| 量化 | `srt/layers/quant` + `mem_cache/*FP4*` | FP8 / MXFP8 / INT4 等在该 GPU 上的实现 |
| 通信 | `srt/distributed/` | TP / PP / EP / DP 在该 GPU 互联拓扑上的实现 |

也就是说，把一种新 GPU 接入 SGLang，不是改一个配置开关，而是要沿着 attention → 算子 → CUDA Graph → 量化 → 通信这条链逐段适配，每一段都要保证与 overlap 调度、连续批处理、推测解码 verify forward 这些运行时机制兼容。沐曦 MX 系列 GPU 作为通用 GPGPU，适配工作的重点落在底层算子（`sgl-kernel` 对应层）与 attention 后端——这两段直接决定 RadixAttention 的前缀匹配 kernel 和 tree attention 能否在新硬件上跑出应有性能。

这场演讲的价值在于它把「开源框架 + 国产硬件」从口号落到了可核查的工程清单上：一个国产 GPU 要真正能用 SGLang 跑生产负载，上述六个维度缺一不可。圆桌环节李兆石主持的「异构算力下的推理效能革命」，很大程度上就是围绕这张清单展开的——国产算力要摆脱「能跑 demo」到「能上生产」的鸿沟，靠的正是把适配工作做到 attention/算子/CUDA Graph 这一层级。

---

## AI 性能分析范式：从全链路可观测到智能分析

苏峰、常怀鑫（阿里云工程师、SGLang Developer）的演讲跳出了单点优化，谈的是**方法论**——「从全链路可观测到智能分析：AI 性能分析范式的演进与实践」。

SGLang 的运行时天然暴露了一条足够长的可观测链路。一次请求要穿过：HTTP handler → OpenAI serving `handle_request` → `TokenizerManager.generate_request`（tokenize）→ ZMQ PUSH 到 Scheduler 子进程 → `event_loop_overlap` 调度 → `get_next_batch_to_run` 组批 → `ModelRunner.forward`（embed→attention→MLP→norm→lm_head→logits）→ `sample` 采样 → ZMQ PUSH 到 DetokenizerManager → 增量 detokenize → SSE 流式回吐。其中 overlap 模式下还有 `result_queue` 延迟一步、CUDA Graph 重放、推测解码的 draft→verify→accept 三段——每一处都是潜在瓶颈点。

![请求数据流](/vibe-reading/images/articles/sglang-v0518/data-flow.svg)

「全链路可观测」要做的是把这条链路打上 span，让任何一个慢请求都能定位到是 tokenize、调度、forward 还是 detokenize 卡住。SGLang 在 `test/observability/` 下已有可观测性相关基础设施。而「智能分析」则是更进一步——不做人工逐 span 翻查，而是让系统自动做瓶颈归因：比如把 overlap 下 `result_queue` 的延迟、CUDA Graph 重放的占比、推测解码的 accept 长度分布综合起来，自动指出「这一批 forward 慢是因为 verify 阶段 draft 接受率掉到了某阈值以下」。

这场演讲的「演进」二字是关键：性能分析从「事后 profile」走向「在线归因」，从「人看火焰图」走向「系统自动定位」。对于一个日处理万亿级 token、驱动数十万 GPU 的推理系统（SGLang 的生产规模），这种范式转变不是锦上添花，而是运维可行性的前提——靠人已经看不过来了。

---

## 圆桌：异构算力下的推理效能革命

李兆石（沐曦股份 AI 研究院院长）主持的圆桌把六场演讲的线索收束成一个问题——**异构算力下的推理效能革命**。

把各场演讲的结论拼起来，这条「革命」的路径其实相当清晰：

1. **运行时层**（SGLang）：RadixAttention 让 KV 可复用，overlap 让 CPU 不占 GPU 时间，连续批处理让 prefill/decode 同 batch 交替——单实例的效率被压到接近理论上限。
2. **缓存层**（HiCache）：单实例显存放不下时，L2 host / L3 remote 把 KV 变成多级存储，淘汰策略可插拔——延迟从「重算 prefill」降为「load_back」。
3. **集群层**（Mooncake）：prefill/decode 分离 + 全局 KV 池 + early rejection，把 KV 复用推广到集群规模，并在过载时主动保 SLO——吞吐在长上下文下成倍增长。
4. **硬件层**（沐曦 GPU）：把上述三层的扩展点（attention/算子/CUDA Graph/量化/通信）逐一适配到国产 GPU——让开源栈能跑在异构算力上。
5. **可观测层**（AI 性能分析）：全链路 span + 智能归因，让这套复杂系统可运维——这是规模化的前提。

这五层不是并列关系，而是层层放大：单实例优化到极限后，缓存层次化把瓶颈从显存推到 host/远端；集群解耦把瓶颈从单机推到全局调度；硬件适配让这套栈能落到非 Nvidia 算力；可观测则保证这套复杂系统在规模下不失控。SGLang 之所以成为这场活动的「公约数」，正是因为它的五层架构恰好同时承载了这五条优化线——RadixAttention 是缓存层的事，overlap 是编排层的事，`disaggregation/` 是 PD 分离的钩子，`hardware_backend/` 是多硬件的入口，`test/observability/` 是可观测的底座。

主办方说的「理性与热忱」放到这条路径里就有了着落：热忱是往每一条优化线深处钻，理性是承认每一层都有物理边界——显存带宽、互联时延、SLO、过载——然后在边界之间找全局最优。这场 Meetup 把五条线的实践者凑到一张圆桌上，本身就是这种「协同」的一次具象化。

---

## 相关阅读

- [SGLang CodeWiki · 概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.18/00-overview) — **背景知识**·本篇 SGLang 五层架构、三进程运行时与 RadixAttention 的完整源码解读，是 §2 与 §3 的技术底座
- [SGLang CodeWiki · 缓存层](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.18/04-mem-cache) — **工程实现**·HiRadixCache 三层缓存、三种写策略与 7 种 evict 策略的源码级实现，对应 §3
- [SGLang: Efficient Execution of Structured Language Model Programs](/vibe-reading/articles/sglang-efficient-structured-lm-programs) — **前序**·SGLang 原始论文，RadixAttention 与结构化生成的起源
- [FlashInfer: Efficient and Customizable Attention Engine for LLM Inference Serving](/vibe-reading/articles/flashinfer-attention-engine-llm-serving) — **方法论镜像**·SGLang 依赖的 attention 后端，前缀缓存 kernel 的另一面
- [vLLM CodeWiki · 概览](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview) — **同基准对照**·另一主流推理框架的 V1 引擎架构，可与 SGLang 五层横向对照
