---
title: "Forge: 大规模原生 Agent RL 系统"
source:
  type: "article"
  project: "MiniMax"
  url: "https://minimaxi.com/news/forge-大规模原生-agent-rl-系统"
  author: "MiniMax"
  site: "minimaxi.com"
date: "2026-07-28T20:14:27+08:00"
category: [AI, Agent, RL, MiniMax, Official]
tags: ["Agent RL", "Forge", "MiniMax M2.5", "CISPO", "Windowed FIFO", "Prefix Tree Merging", "Prefix Cache", "PD 分离", "强化学习", "RLHF"]
description: "目的：在大规模 Agent RL 中平衡吞吐量、训练稳定性与 Agent 灵活性。手段：原生异步 Agent RL 系统 Forge——标准化 Agent-LLM 交互协议解耦引擎与脚手架 + Windowed FIFO 混合调度 + Prefix Tree Merging 40× 训练加速 + 全局 L3 KV Cache + Dense/Process Reward。结论：数十万 Agent 脚手架 + 200K 上下文下日吞吐百万级样本，造就 MiniMax M2.5 性能突破。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Forge: 大规模原生 Agent RL 系统](https://minimaxi.com/news/forge-大规模原生-agent-rl-系统) · **作者** MiniMax · **来源** minimaxi.com · **原文发布** 2026-02-13 · **转载** 2026-07-28

---

大家好！随着 MiniMax M2.5 的发布并在社区引发热烈反响，我们很高兴借此机会，分享在模型训练背后关于 Agent RL 系统的一些思考。

在大规模、复杂的真实世界场景中跑 RL 时，始终面临一个核心难题：如何在**系统吞吐量**、**训练稳定性**与 **Agent 灵活性**这三者之间取得平衡。为了解决这个问题，我们设计了一个异步的原生 Agent RL 系统—— Forge。在 **Forge** 中，我们通过实现标准化的 Agent-LLM 交互协议，支持了对任意 Agent 脚手架进行训练，并且通过极致的工程优化和稳定的算法与奖励设计，实现了超大规模的强化学习。

在面对数十万个真实的 Agent 脚手架和环境以及 200k 的上下文长度时，我们的 RL 系统做到了每天百万级样本量的吞吐，并实现持续稳定的 Reward 上涨和真实的模型能力提升，并最终造就了 **MiniMax M2.5** 模型的性能突破。

---

## 1. 问题建模

在深入探讨架构设计之前，我们首先将 Agent 强化学习系统的优化目标形式化为"最大化有效训练收益(_J_)"：

![Agent RL 优化目标公式：有效训练收益 J = Throughput × Sample Efficiency × Stability](/vibe-reading/images/articles/minimax-official-forge-agent-rl-system/fig-1-objective-formula.png)

其中，Throughput 是指每秒处理的原始 Token 数量，其主要受 RL 系统中的四部分控制：Rollout、Training、Data Processing 和 I/O。Sample Efficiency 则是指每个样本带来的平均性能提升，由数据分布、数据质量、算法效率以及 Off-policy 程度决定。而稳定性和收敛性则能够基于训练过程中监测指标来判定。

要实现的最大化，我们需要克服以下三类挑战：

### 1.1 Agent 可扩展性与框架灵活性

当前常见的 RL 框架和范式对 Agent 的复杂度限制很大，主要体现在：

- **Agent 自由度受限**：将 Agent 视为白盒就要求在 Agent 和 RL Framework 之间共享和传递状态。这种设计难以对复杂的 Agent 架构（如动态上下文管理、Multi-Agent RL 等）进行建模，导致模型能力无法在复杂的黑盒 Agent 上有效泛化。
- **Token 一致性问题**：现有的 TITO（Token-In-Token-Out）模式迫使 Agent 与底层的 Tokenizer 逻辑深度耦合。在复杂的上下文管理机制下，要想维持 Agent 和 RL 之间的严格一致性，其工程成本是非常大的。

### 1.2 系统效率与计算冗余

Rollout 的完成时间存在极大的方差——短则几秒长则数小时。这带来了一个异步调度问题：

- **训推异步调度逻辑**：跑过异步 RL 的同学都知道，在 MFU 和 RL 算法稳定性之间权衡是非常复杂的。严格的 FIFO（First In First Out）/同步调度会被长尾样本 block；而 Greedy/FFFO（First Finish First Out）虽然最大化了吞吐量，却带来了不可控的 distribution shift，极易导致 RL 中途崩掉。
- **前缀冗余**：在多轮 Agent 请求和 group-level 的 Rollout 中，Tokenizer 的 encode-decode 不一致性和上下文管理机制，会导致请求间共享了大量的前缀，这种冗余在训练期间造成了巨大的计算浪费。

### 1.3 Credit Assignment 与优化稳定性

- **稀疏奖励问题**：复杂的 Agent 任务的 trajectory 通常包括长达数千步，使得基于稀疏奖励的 credit assignment 在数学上非常不稳定。这种稀疏性导致回报计算中的信噪比极低，引起高梯度方差，破坏了大规模模型训练的稳定性。
- **Long CoT 的负面影响**：在 R1 出来之后大家的 RL 都很关注 response length 的增长。但在真实的 Agent 场景中，用户其实对执行时间非常关注，如果不加以限制可能会导致训出来的模型虽然刷榜很强，但用户体验很差。

---

## 2. 系统架构与 Agent RL 范式

### 2.1 RL 系统设计

为了实现真正可扩展的架构，我们不再局限于具体的 Agent，而是转向了通用的抽象层设计，将 Agent 的执行逻辑与底层的训推引擎彻底解耦。我们的 RL 系统由 3 个核心模块组成：

- **1. Agent**：该层抽象了通用 Agent（涵盖白盒和黑盒架构）及其运行环境。它负责协调环境交互，使 Agent 成为一个纯粹的 **Trajectory Producer**。通过将环境交互与 LLM generation 解耦，Agent 可以专注于核心业务逻辑（如 context management 和复杂的环境交互等），而无需关心底层的训练和推理细节。

- **2. 中间件抽象层**：作为桥梁，该层在物理上将 Agent 侧与训练/推理引擎隔离。
  - **Gateway Server**：充当标准化通信网关，处理 Agent 与 LLM 之间的交互请求。通过通用标准协议，它有效地将底层模型的复杂性与 Agent 的高层行为逻辑隔离开来。
  - **Data Pool**：作为分布式数据存储，异步收集 trajectory 和 process signal。它充当生成和训练解耦的缓冲区，允许灵活的数据处理和批处理策略。

- **3. 训练与推理引擎**：
  - **Rollout Engine**：专用于高吞吐量 Token 生成，响应 Agent 的生成请求。
  - **Train Engine**：通过 Scheduler 从 Data Pool 中 fetch 数据，更新 Agent model，并与采样引擎保持同步，确保 Agent 使用最新的策略分布进行探索。

我们在离线评估中发现，不同 Agent 脚手架会导致显著的性能偏差。借助该模块化设计，我们在无需修改 Agent 内部代码的情况下，使用大量的 Agent 框架进行了训练。这种"引擎与 Agent 完全解耦"的架构确保了模型能在各类环境中泛化，目前我们已集成了数百种框架和数千种不同的工具调用格式。

### 2.2 白盒 Agent RL：以上下文管理为例

对于白盒 Agent，我们可以通过充分的脚手架设计和增广，以直接观测和优化模型在特定类型 Agent 上的表现。在 M2.5 中，我们特别优化了过去模型在带上下文管理的长程任务（如 DeepSearch）中出现的一些问题：

- **上下文场景性能退化**：随着交互轮次增加，中间推理和冗余观察的积累会产生"注意力稀释"。这种噪声会导致模型在绝对上下文窗口内对关键信息失去焦点。
- **训推不一致**：虽然上下文管理可以延长交互周期，提升 Agent 在长上下文场景的表现，但仅在推理时使用会由于偏离 RL 训练的数据分布，迫使模型在推理时被迫接受上下文变迁，处理不常见的长下文，从而影响模型表现。

为了解决这些问题，我们将上下文管理（Context Management, CM）机制直接整合到 RL 交互循环中，将其视为驱动状态转换的功能性动作：

- **CM 驱动的状态转换**：我们将 CM 建模为 agent action，而上下文变迁则蕴含在环境的 dynamics 中。状态从 _St_ 到 _St+1_ 的转换隐式包含了上下文切换的逻辑，将上下文适应包含在了模型的训练目标中。
- **自适应推理模式**：通过在此框架内优化策略 _π_，模型学会了内化分布偏移，涌现出优先关注 State-critical Token 的鲁棒推理模式。
- **感知上下文管理策略**：在该策略下，模型在 RL 生成过程中就需要学会预见可能的上下文管理和改变，模型通过主动保留与目标任务相关的信息和减少无关上下文信息，大幅提升了在 Context-Management Agent 下的性能。

### 2.3 黑盒 Agent RL：跨框架的鲁棒性

许多用户的真正在用的 Agent 实际上是闭源的，我们完全无法感知内部的 Agent loop 逻辑。为了确保模型在不透明架构上也能对脚手架针对性优化，我们采用了以下方案：

- **非侵入式集成**：Forge 不感知 Agent 内部的实现细节，内部只需要将请求打到 RL 服务的 GateWay，框架内部即可进行数据收集和训练，因此在实际 RL 训练时可以兼容任意上下文操作（如记忆压缩、历史重写），任意内部的 Agent Loop（例如 Deep Think、Multi-Agent 等等）。
- **多框架泛化**：通过将训练循环与 Agent 内部状态解耦，Minimax-M2.5 广泛适配大量黑盒 Agent——无论是以沙盒+MCP 环境为主的代码 Agent（例如我们将 Opencode Agent 直接视为一个黑盒 Agent 来训练），还是使用激进上下文缩减策略的 Agent（如 Truncate BC）。实验表明，该方法在完全不透明的黑盒系统上依然能带来稳定的提升。

![黑盒 Agent RL 跨框架泛化](/vibe-reading/images/articles/minimax-official-forge-agent-rl-system/fig-2-blackbox-agent-rl.png)

---

## 3. 工程优化

### 3.1 混合调度策略：Windowed FIFO

为了解决吞吐量与数据分布一致性之间的冲突，我们提出了 Windowed FIFO 调度策略。该策略介于 FIFO 和 Greedy 之间，即可以保证系统的吞吐，也控制了样本的 off-policyness。

假设当前达到了最大的生成并发量（如 _N_ = 8192），生成队列为 _Q_ ，当前头部位于索引 _H_ 。训练调度器受限于一个大小为 _W_ （如 _W_ = 4096）的可见窗口：

- **受限可见性**：调度器只能从 _[H, H+W]_ 范围内获取已完成的轨迹。
- **局部贪婪（窗口内）**：在活动窗口内，调度器可立即提取任何已完成轨迹，避免了队头阻塞（HoL），快速任务无需等待头部任务完成。
- **全局严格阻塞（窗口外）**：即使索引为 _H+W+k_ 的任务已完成，调度器也**禁止**获取它。
- **约束推进**：只有当头部的任务被消费时，窗口才向前滑动（_H_ ← _H_ + 1）。这迫使调度器必须等待当前窗口内的"长周期落后任务"，防止训练分布向"快而简单"的样本严重偏移。

![Windowed FIFO 调度策略](/vibe-reading/images/articles/minimax-official-forge-agent-rl-system/fig-3-windowed-fifo.png)

### 3.2 Prefix Tree Merging

Agent 的多轮请求间存在很高的上下文前缀重合度，传统方法将每个请求视为独立样本，重复计算公共前缀，浪费了大量的训练算力。

我们提出了 Prefix Tree Merging 方案，将训练样本从"线性序列"重构为"树形结构"，下面是具体的数据处理和训练策略：

- 只要共享基础前缀，Completions 就能在样本级别合并到一棵前缀树中（即使后续响应或采样分支不同）。
- 通过利用 Attention Mask 原语（如 Magi Attention）表示不同 branch 之间的依赖关系，可以保证前向计算在数学上与 naive 方案完全一致，在计算 loss 时，我们会把前缀树 unmerge 为序列的格式，不影响后续的 loss 计算和指标统计。
- 该方案消除了冗余的前缀，相比于 naive 方案实现了约 **40 倍训练加速**，且显著降低了显存开销。

![Prefix Tree Merging 方案](/vibe-reading/images/articles/minimax-official-forge-agent-rl-system/fig-4-prefix-tree-merging.png)

### 3.3 推理加速

引入异步 RL 之后虽然 Rollout 阶段算力占比降低到了 60% 左右，但推理本身还有很大优化空间，我们通过下面的几项优化来加速 LLM 推理：

- **Dynamic MTP**：首先我们引入 MTP 进行推理加速，同时为了保证训练过程中维持 draft model 的高接受率，我们通过 Top-K KL Loss 在 RL 过程中持续训练 detached MTP Head，与 RL policy 保持对齐。
- **Rollout 侧的 PD 分离**：PD 分离可以消除 MoE 调度中的 PD 干扰，为每个实例提供独立的并行和生成策略，在最大化吞吐量的同时优化长尾样本的延迟，防止极端样本阻塞 FIFO scheduler，并带来较高的 off-policy。
- **全局 L3 KV Cache Pool**：在多轮和超长上下文的 Agent 场景下，请求间拥有极高的共享前缀比例，但是局部的 kv cache 受容量限制，无法达到满意的 prefix cache 命中率，甚至在 RL batch size 极大的情况下，会发生大量由于驱逐导致的重计算，因此需要支持全局的 L3 KV cache。同时，Forge 还通过 scheduler cost-aware 的调度机制，权衡排队延迟和缓存传输时间来动态路由请求，在不使实例超载的前提下最大化缓存局部性。

---

## 4. Scalable Agent RL 算法

在 M2 系列中我们整体上沿用了 M1 时期提出的 **CISPO** 算法，尽管场景发生了**显著变化**——从**几十 k Token** 的 Long CoT 到 **200k Context** 的 Agent 场景，CISPO 依然提供了很强的 baseline。在此基础上，我们也针对**Long-horizon Agent** 的特性进行了专门的适配与优化。同时在 Windowed FIFO 的基础上，我们采用了**Multi-Domain 混合训练策略**。我们将 Reasoning、General QA、Code Agent、General Agent 等多个领域的任务同时混合训练。这缓解了分阶段训练中的遗忘问题，显著增强了模型的泛化能力。

![Scalable Agent RL 算法总览](/vibe-reading/images/articles/minimax-official-forge-agent-rl-system/fig-5-scalable-agent-rl.png)

### 4.1 Dense & Process Reward

为了解决超长轨迹的信用分配问题并确保稳定，我们设计了一个由三部分组成的复合奖励：

- **过程奖励（Process Reward）**：监督 Agent 的中间行为（如惩罚语言混合或特定工具调用错误），提供密集反馈，而不只依赖最终结果。
- **任务完成时间奖励**：将相对完成时间作为奖励信号。因为真实延迟不仅取决于 Token 生成，还受工具执行和子 Agent 调用影响，这能激励 Agent 主动利用并行策略、选择最短的执行路径来加速任务。
- **用于降低方差的后续奖励（Reward-to-go）**：长周期任务的稀疏奖励容易引发高梯度方差。我们使用 Reward-to-go 来标准化回报，大幅提高了信用分配的精度，稳定了优化过程。

**在 MiniMax M2.5 的训练过程中，在面对数十万个真实的 Agent 脚手架和环境以及 200k 的上下文长度时，我们的 RL 系统做到了每天百万级样本量的吞吐，并实现持续稳定的 Reward 上涨和真实的模型能力提升。**
