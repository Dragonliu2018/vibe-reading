---
title: "快手万擎大模型推理成本和性能优化实践"
source:
  type: "article"
  project: "Kuaishou"
  url: "https://www.6aiq.com/article/kuai-shou-wan-qing-da-mo-xing-tui-li-cheng-ben-he-xin-neng-you-hua-shi-jian-1785484680329"
  author: "快手系统软件中心 AI Infra 训推引擎团队"
  site: "快手技术"
date: "2026-08-03T16:30:00+08:00"
category: [AI, Infra, Inference, Blogs]
tags: ["kLLM", "推理优化", "PD分离", "MLA", "DP Attention", "Ring Attention", "KV Cache", "投机解码", "DSpark", "MoE", "EP", "SLO调度", "GLM-5.2", "DeepSeek-V4", "长上下文"]
description: "目的：在不损失模型能力的前提下降低新一代大模型（GLM-5.2、DeepSeek-V4）的单位 Token 推理成本并保障 TTFT/TPOT SLO。手段：MLA+DP Attention 解耦 Attention 按请求并行/MoE 按专家并行（节点有效 KV 容量 7.3×）；Ring Attention 分块流水替代 All-Gather CP（吞吐 +16.9%）；DSpark 半自回归投机解码（TPOT -15%）；GPU/CPU/SSD 三级 KV Cache + Cache-Aware 路由（命中率 +20PP，吞吐 +30%）；SLO Load 驱动的大 PD 弹性 + 10 秒级实例启动（扩容生效 60×）；长请求 Chunk 公平调度与 Decode KV 高水位保护。结论：将模型侧理论降本转化为实际的吞吐、时延与单位 Token 成本收益，Provider Uptime 99%+。"
readingTime: "33 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [快手万擎大模型推理成本和性能优化实践](https://www.6aiq.com/article/kuai-shou-wan-qing-da-mo-xing-tui-li-cheng-ben-he-xin-neng-you-hua-shi-jian-1785484680329) · **作者** 快手系统软件中心 AI Infra 训推引擎团队 · **来源** 快手技术 · **原文发布** 2026-07-31 · **转载** 2026-08-03

---

## 一、推理优化：大模型规模化落地的关键

大模型从能力验证走向规模化应用后，系统关注点已从"能否完成任务"转向能否稳定、低成本地服务真实业务。训练决定能力上限，推理则直接影响吞吐、时延和单位调用成本。

与传统互联网内容不同，大模型每次请求都需持续计算并占用 GPU。Agent 多轮规划与工具调用、百万级长上下文及长推理输出进一步放大了 Token 消耗，使成本、吞吐和时延成为规模化落地的主要约束。

快手系统软件围绕 GLM-5.2、DeepSeek-V4 等新一代模型，从并行执行、算子与通信、KV Cache、量化、调度及弹性服务等方面开展全链路优化，构建高性价比推理方案。

## 二、不以模型能力损失为代价做优化

推理服务的价值不能只看 Token 单价。过度量化、精度裁剪或推理参数调整虽然能降低成本，却可能损害复杂推理、工具调用和长上下文能力。快手关注的不是绝对低价，而是在模型能力基本保持的前提下降低单位 Token 成本。

StreamLake 是快手万擎大模型平台对外提供推理服务的官方 Provider。推理引擎 kLLM 包含并行执行、PD 弹性、分级 KV Cache、算子与编译等能力，是支撑高性能、低成本推理服务的底层系统能力。

在 OpenRouter 的 Provider 级能力对比中，StreamLake 的 GPQA Diamond 和 TAU-Bench Airline 表现与模型官方及其他头部 Provider 处于相近水平；同时计入 Prompt Cache 后，StreamLake 仍保持具有竞争力的实际 Token 价格。这表明优化并非通过牺牲模型能力换取低价，而是通过系统级推理优化实现能力与成本的兼顾。

## 三、模型结构演进与推理挑战

以 GLM-5.2 和 DeepSeek-V4 为代表的新一代大模型，在巨量参数与稀疏激活、稀疏/压缩注意力、百万级上下文三个方向同步演进。模型结构在降低理论计算与存储成本的同时，也改变了推理系统的执行形态。

从系统视角看，这些结构演进重新分配了计算、通信、显存和调度压力：

1. **巨量参数与稀疏激活**：通过更大总参数量提升容量，单 Token 激活参数控制在较小比例。但动态专家路由引入了专家负载不均、小矩阵计算和跨卡 All-to-All 通信。

2. **稀疏注意力与百万上下文**：降低长序列 Attention 理论计算成本，但超长上下文仍会放大长 Prefill、KV cache 容量、不规则访存和数据搬运压力。

推理瓶颈已从单一算力问题转化为计算、通信、显存与调度相互耦合的系统问题。模型侧降本并不等于系统侧同比提效。

## 四、核心技术全景图

快手系统软件团队建设的推理引擎 **kLLM**，是一个覆盖业务接入、调度、推理引擎、硬件资源全链路的高性能推理平台。核心引擎层关键技术包括：

- PD/AF 解耦分离
- TP/PP/EP/CP 多维并行策略
- DeepEP/Mooncake 高效异构通信
- FlashAttention-4/FlashInfer 高性能算子
- L1 GPU/L2 CPU/L3 Remote 三级 KV Cache 体系
- FP8/INT8/NVFP4 多精度量化压缩
- MTP/EAGLE-3/DSpark 投机解码
- SLO 感知调度、Prefix 亲和路由、弹性伸缩
- 全链路 Metrics/Trace 监控与灰度降级机制
- 兼容国产 GPU 与网络生态

## 五、关键技术攻坚

2025 年 DeepSeek R1 发布时，团队通过自研时分 PD 分离、DeepEP Auto 通信模式（Prefill 采用 Normal、Decode 采用 Low Latency）、无精度损失的 FP8 KV cache 及调度优化等技术，获得了行业极致的 Token 推理成本。今年进一步将能力扩展到 GLM、DeepSeek、KIMI 等新一代模型。

### 5.1 MLA + DP Attention：Attention DP 与 MoE EP 的混合并行

#### 5.1.1 从降低单 Token 开销到扩展节点有效 KV 容量

在百万级长上下文场景中，Attention 计算量与 KV Cache 占用随上下文长度快速增长。GLM-5.2 通过 DSA 从历史上下文中筛选 Top-k Token 参与 Attention，降低计算量；同时利用 MLA 的压缩表示 cKV 减少单 Token 缓存开销。

然而 DSA 和 MLA 主要优化计算量与单 Token KV 大小，未解决多卡部署中的状态分布问题。随着上下文和并发持续增长，瓶颈转向节点内多张 GPU 显存能否共同扩展有效 KV 容量。

#### 5.1.2 纯 TP：切分了 Attention 计算，却复制了 cKV

GQA 包含多个独立 KV Head，可沿 Head 维度进行 TP 切分；MLA 的 cKV 则是跨 Head 共享的压缩状态，无法采用相同方式切分。

当 Attention 直接沿用 TP Group 时，各 Rank 虽共同完成计算，却需处理相同请求并保存相同的 cKV。以 TP=8 为例，同一批请求的 KV Cache 会在节点内复制 8 份。增加 GPU 只能扩展计算能力，无法等比例提升有效 KV 容量。

在长上下文、高并发场景下，即使系统仍有剩余算力，也可能因 KV Cache 空间不足而无法扩大 Batch 或接收新请求。真正瓶颈已从 Attention 算力转为 TP Group 内重复存储的请求状态。

#### 5.1.3 并行策略重构：Attention 按请求并行，MoE 按专家并行

针对 MLA 与 MoE 不同的结构特征，团队重新划分了 Attention 与 MoE 之间的并行边界：

- **Attention 采用 Request DP**：不同 Rank 处理不同请求，仅保存所属请求的 cKV、Token 历史和索引状态；Attention 阶段不再进行跨 DP Rank 的结果同步。
- **MoE 采用 EP**：Router 为每个 Token 选择 Top-k Experts，通过 All-to-All Dispatch 将 Token 发送至专家所在 Rank，专家计算完成后再通过 All-to-All Combine 将结果返回原 Request Rank。
- **Dense/Shared FFN 按需保留 TP**：非路由计算按模型维度切分时，只在对应子路径执行 Gather/Reduce-Scatter。

核心不是选择一种并行方式覆盖整个模型，而是让不同状态遵循各自最合适的分布方式。Attention 从 TP8 调整为 Request DP8，每张 GPU 只保存所属请求的 cKV；MoE 继续采用 EP8。

#### 5.1.4 收益与边界

在 8 卡配置中，DP Attention 使节点有效 KV 容量由纯 TP 的 2.9M Tokens 提升至 21.2M Tokens，增长约 **7.3 倍**，平均 TTFT 下降 **25%**。

优化后系统瓶颈转向 Request DP 的负载均衡以及 EP 阶段的专家负载与 All-to-All 通信。DP Attention 更适合长上下文、大 Batch 和 KV 容量受限的高吞吐场景；在小 Batch、低并发下，数据布局转换和 EP 通信的额外开销可能抵消收益。

### 5.2 Ring Attention：将同步聚合改造成分块流水

#### 5.2.1 百万上下文下的 CP 扩展

当上下文长度从 200K 扩展到 1M，KV cache 容量随序列长度线性增长，Prefill 阶段的 Attention 计算和显存压力快速上升。团队引入 Context Parallelism（CP），沿序列维度将 Context Token 切分到多个 CP Rank，使每张 GPU 只处理部分 Query 并持有对应 KV 分片。

#### 5.2.2 分块式 Ring Attention 实现

在 CP 执行路径中实现了分块式 Ring Attention。对于 CP Rank i，本地 Query Q_i 在整个计算过程中保持不动，本地 KV 分片 K_i,V_i 与其他 Rank 的 KV Block 沿 Ring 拓扑逐跳传递。每一轮中，GPU 使用当前 KV Block 计算一部分 Block Attention，同时异步接收下一轮 KV Block；当前计算结束后直接切换到已到达的下一 Block。

经过 N 轮后，每个 Q_i 都完成了对全部有效 KV Block 的 Attention，KV 分片也恰好沿 Ring 轮转一周。

为在分块计算下保持与完整 Attention 相同的数值结果，使用 Online Softmax 跨轮维护最大值、归一化分母和输出累积状态（m,ℓ,O）。每处理一个 KV Block 更新一次局部状态；全部有效 Block 处理完成后得到本地 Query 的最终输出 O_i，不需要物化完整 Attention Matrix。

#### 5.2.3 与 All-Gather CP 的执行路径对比

原有 All-Gather CP 在每层 Attention 计算前先将各 Rank 的 KV 分片汇总到每张 GPU，需要临时物化完整 K/V，并等待 All-Gather 完成后才能启动 Attention。

Ring Attention 改变的不是 Attention 的数学结果，而是 K/V 的组织方式和通信时序：每张 GPU 只保留本地 KV 分片及单块通信缓冲，将一次性全量同步聚合拆解为连续的分块传输，并与 Block Attention 形成流水。Ring Attention 在显存节省、通信计算重叠方面相对更有优势。

#### 5.2.4 实际收益

在相同模型、Batch、CP Degree、KV 精度和硬件配置下，ISL 512K，Ring Attention CP 相比 All-Gather CP 吞吐提升 **16.9%**。

### 5.3 DSpark：从前沿架构到在线收益

#### 5.3.1 主流投机解码架构的性能权衡

投机解码正从单一草稿模型竞争走向草稿生成、目标验证与硬件调度的系统协同。围绕 DeepSeek V4 Flash 的生成时延优化，团队跟进 Eagle3、DFlash 和 DSpark 等技术路线，不把离线接受率作为唯一选型指标，而是同时考察草稿延迟、接受长度以及动态负载下的验证成本。

Eagle3 和 DFlash 分别代表自回归与并行草稿的两端：前者依赖建模充分但草稿成本随推测长度增加；后者一次产生整块候选、延迟更低但后缀质量容易衰减。DSpark 通过半自回归结构在两者间建立平衡，并以置信调度控制目标模型验证开销，更符合长输入在线服务的成本结构。

#### 5.3.2 从草稿模型到完整解码链路

DSpark 首先通过并行网络一次产生多个位置的 logits，再由轻量序列模块逐位置采样。每个位置在采样前根据前一个已采样 token 计算 Bias 并修正当前位置的 logits。串行部分只执行 Bias 修正与采样，不重复完整模型前向，因此能在保留并行草稿低延迟的同时缓解后缀质量衰减。

#### 5.3.3 端到端性能收益

在 DeepSeek V4 Flash 的线上典型场景中，ISL 约为 3K–6K、OSL 约为 0.5K。相较基线，接入 DSpark 后平均 TPOT 降低 **15%**。

### 5.4 分级 KV Cache：从容量扩展到高效复用

#### 5.4.1 L1 容量限制与缓存失效

长上下文场景下 KV Cache 随序列长度线性增长，而 GPU 显存还需承载模型权重和运行时状态。仅依赖 L1 时，缓存因容量不足频繁淘汰，使系统提示词、工具定义和历史对话等重复前缀无法稳定复用，同类请求仍需重新执行 Prefix Prefill。

为此构建了由 GPU HBM、CPU DRAM 和 SSD/分布式存储组成的三级 KV Cache。

#### 5.4.2 分级缓存、前缀复用与 Cache-Aware 路由

三级缓存承担不同数据角色：

- **L1 · GPU HBM**：保存实例内最热的 KV，命中后可直接参与计算
- **L2 · CPU DRAM**：承接从 L1 下沉的数据，在实例内提供低延迟回填
- **L3 · SSD/分布式存储**：跨实例共享 Prefix KV，根据容量和系统压力持久化全部数据或高复用前缀

首次 Prefill 生成的 Prefix KV 由 L1 下沉至 L2/L3，通过 Cache Event 同步缓存位置。后续同前缀请求由网关结合匹配长度、缓存位置和负载进行 Cache-Aware 路由；命中后将 KV 回填至 L1，仅计算未命中后缀。对于 Chunked Prefill，复用上一轮前缀树状态，仅处理新增 Token，避免重复扫描完整前缀。

#### 5.4.3 分级 KV Cache 优化效果

线上生产窗口显示，L1 仍承担主要命中流量；当 L1 因容量压力出现命中率下降时，L2/L3 能承接被淘汰的 Prefix KV，使总命中率保持相对稳定。图示窗口内总命中率平均约 **87.6%**，其中 L1、L2、L3 的平均命中贡献分别约 **77.5、9.6 和 0.6 个百分点**。在典型场景下 L3 最高能将命中率提升 15PP，有了 L3 后命中率基本能到理论上限。

与仅使用 L1 的基线相比，完整的分级缓存与 Cache-Aware 路由使缓存命中率提升 **20 个百分点**，SLO 约束下吞吐提升 **30%**。

#### 5.4.4 前缀树关键路径优化

在长输入场景下开启分级 Cache 过程中，前缀相关操作存在严重性能问题，产生了明显的 GPU Bubble。通过火焰图分析热点并深入分析前缀树源码，发现根源在于总是使用全量 token 序列进行前缀匹配和插入，对分块请求而言存在相当大冗余。

例如对新请求"这个前缀有点长"进行 Prefill，ChunkSize 为 4 则需分成 2 个 Chunk：第一轮匹配前缀、执行 Prefill 并插入前缀树；第二轮再次全量前缀匹配和插入。

团队提出基于中间状态缓存的增量前缀匹配/插入优化算法，消除了这部分冗余计算。

#### 5.4.5 前缀复用优化效果

优化后，GPU Bubble 从平均 **400ms 锐减至 30ms**，长请求端到端 Prefill 性能提升约 **40%**。

### 5.5 PD 分离：从固定配比到 SLO 驱动

PD 分离使 Prefill 和 Decode 可以独立配置资源，但生产环境中更关键的是如何持续维持合理的 P/D 配比。同样的 QPS 下，ISL 变长主要增加 Prefill 压力，OSL 和并发增长则更多消耗 Decode 容量，静态 P/D 比例难以适应不断变化的请求形态。

早期固定 xPyD 服务组只能整组扩缩，容易出现一侧排队、另一侧空闲；分钟级实例启动使资源调整难以及时生效。

团队将 PD 系统设计为以 TTFT、TPOT SLO 为目标的在线资源控制系统：通过 SLO Load 感知两侧压力，结合 10 秒级实例启动和 P/D 全局资源池，形成动态调整 P/D 容量配比的闭环。

#### 5.5.1 SLO Load：分别度量 P、D 压力

GPU 利用率只能反映设备是否繁忙，无法判断负载是否已影响用户体验。以 Prefill 和 Decode 分别主要决定的 TTFT 和 TPOT 相对 SLO 的背离程度来统一度量两侧压力。

真实指标反映已发生的性能退化但存在观测滞后；根据队列积压和实际服务率计算的预测指标能提前发现拥塞但可能存在估计误差。为兼顾及时性与可靠性，取预测值和真实值的上界：

```
Load_P = max(TTFT_pred, TTFT_actual) / TTFT_target
Load_D = max(TPOT_pred, TPOT_actual) / TPOT_target
```

经过 SLO 归一化后，Load=1 表示达到目标边界，Load>1 表示对应阶段存在容量压力。

#### 5.5.2 10 秒级启动：让扩缩容真正跟得上负载

传统推理实例启动需依次完成权重加载、JIT 编译、显存初始化和运行时预热，完整冷启动通常达分钟级。团队针对启动关键路径进行了三项优化：

1. 通过 RDMA 直接从运行中实例加载模型权重，避免重复从远端存储读取
2. 共享 JIT Cache，复用已完成的算子编译结果
3. 基于 CUDA VMM 复用显存布局，通过 unmap/remap 减少显存重新分配和初始化

最终将推理实例启动时间由约 10 分钟降低到 **10 秒以内**，使 P、D 扩容能够及时作用于当前负载变化。

#### 5.5.3 大 PD：解除固定组绑定

固定 xPyD 部署中，扩容 P 仍需同步增加完整的 xPyD 组。团队升级为大 PD 架构：P、D 实例分别组成全局 Prefill Pool 和 Decode Pool，可独立加入或退出资源池。每个请求由 Global Router 即时选择 P_i 和 D_j 完成请求级动态组对：

- 请求到达后，根据 KV cache-aware 和负载均衡策略选择 P 实例
- Prefill 完成后，结合 D 侧负载、KV cache 位置和传输成本选择 D 实例
- P、D 实例生命周期相互独立，可根据两侧压力分别扩缩

大 PD 使容量调整能直接作用于瓶颈侧：P 侧压力高时只扩 Prefill Pool，D 侧压力高时只扩 Decode Pool。

#### 5.5.4 最终效果

SLO Load、10 秒级启动和 P/D 全局资源池共同构成 PD 弹性闭环。系统以单实例粒度独立扩缩，新增容量在 10 秒内投入服务，相比传统约 10 分钟的实例启动，容量生效速度提升约 **60 倍**。

OpenRouter 公开监测显示，StreamLake 的 GLM-5.2 服务近 30 天 Provider Uptime 达到 **99%+**。

### 5.6 长请求稳定性优化

长输入和长输出请求在实际业务中占比通常不足 5%，但单个请求消耗的计算时间、KV Cache 和资源驻留时间远高于普通请求，容易将局部阻塞放大为全局排队，显著抬高主流请求的 TTFT。

团队从引擎和全局调度两个层面建立了长请求调度闭环：实例内避免单个请求长期霸占资源，实例间避免流量继续向过载节点堆积。

#### 5.6.1 长输入引擎调度改造：Chunk Prefill 公平调度

长输入主要通过两条路径影响 TTFT：

- **Chunk Prefill 阻塞**：长请求被拆成多个 Chunk，连续执行时后到的短请求需等待多轮，TTFT 被显著拉高
- **KV 准入阻塞**：Decode 实例需为请求预留 KV 空间，余量不足时长请求停在准入阶段并可能阻塞后续短请求

团队以 Chunk 为调度粒度，结合 KV 预算分配执行配额：可在单个 Chunk 内完成的短请求优先执行；长请求在配额耗尽后于 Chunk 边界让出资源，同时保留已计算完成的前缀 KV。再次获得执行机会时直接从断点恢复，无需重复计算。

为避免长请求长期得不到执行机会，其恢复配额会随让出次数逐步增加，在保护短请求 TTFT 的同时保证长请求最终完成。

**优化效果**：在混合流量测试中，公平调度使平均 TTFT 下降 **17.8%**，P50 下降 **26.0%**，P95 下降 **12.1%**。整体 P99 上升 **2.7%**，体现了"短请求提前、长请求小幅延后"的公平调度权衡。

#### 5.6.2 长输出治理：Decode KV 高水位保护

长输出请求长期驻留在 Decode 实例并持续增加 KV 占用。高并发下，少量长输出可能将 KV Cache 推至高水位，使新请求无法准入并引发持续排队。采用两层保护：

- **调度侧分流**：持续感知 Decode 实例负载，停止向高负载实例继续加压，等待存量请求完成并释放 KV
- **引擎侧保护**：KV 达到高水位时暂停新请求准入；必要时释放循环输出等异常长请求占用的 KV，并将请求重新调度到资源更充足的实例

通过公平执行、状态感知、负载分流和高水位保护，少量长请求对主流请求 TTFT 与系统稳定性的影响被限制在可控范围内。

## 六、未来演进

### 6.1 异构 PD 架构升级

现有同构 PD 集群无法精准匹配 Prefill 密集计算、Decode 高访存迭代的差异化特征。后续将落地异构 PD 协同架构：以高性能算力承载 Prefill 批量预处理任务（如国产卡），以大显存高带宽算力承载 Decode 生成任务（如 N 卡），搭建异构算力统一调度中台。

### 6.2 Program-Aware 全生命周期调度

把调度单元从"单请求"提升到 Program（一次 agent 会话/工作流），做暂停/恢复调度+工具调用空窗资源回收。核心机制：容量紧张时"最短程序优先"驱逐、全局 BFD 装箱恢复、请求边界准入；同时利用 agent 等待 tool-call 返回的 GPU 空闲窗口卸载/预取 KV。

### 6.3 SLO 感知调度（请求分优先级）

多租户/多业务混跑时，长请求阻塞短请求会严重伤害尾延迟。引入紧急度优先级调度：预测 prefill 完成时间，动态选择请求最大化 SLO 达成；对延迟敏感请求做 QoS 保护与限流。

### 6.4 全栈智能化自适应调优和 Kernel 优化

引入 AI 全栈智能调优体系，通过强化学习模型实时感知业务流量、序列特征与硬件负载，自适应优化 PD 配比、弹性阈值、长短流量调度、CP 分片粒度。同时结合时序预测预热热点缓存、优化淘汰策略，实现全链路动态最优。另外，通过 Agentic RL 训练大模型写 Kernel 算子也是重点研究方向。

## 七、总结

本文面向 GLM-5.2、DeepSeek-V4 等新一代大模型，构建了覆盖并行执行、运行时调度、KV Cache、算子编译、量化与投机解码的全栈推理优化体系。围绕 Ring Attention、DP Attention+EP、大 PD、分级 KV Cache 和 DSpark 等技术，结合 SLO 感知调度、弹性扩缩及长短请求治理，系统缓解长上下文、动态负载和大规模部署下的计算、通信与显存瓶颈。通过模型结构与系统工程的协同优化，将模型侧理论降本转化为实际的吞吐、时延、资源利用率和单位 Token 成本收益，为大模型服务的规模化部署提供可复用的工程实践。

---

> **关于团队**：系统软件中心是快手核心的技术引擎，深耕 JVM/JDK、编译器、构建系统等传统系统软件核心能力，同时全面打造 AI Infra——大模型训练与推理引擎。AI Infra 训推引擎团队支撑公司基模与 MaaS 平台核心引擎，自主研发优化 SFT/RL 训练框架，深度优化推理引擎、调度与运营体系。
