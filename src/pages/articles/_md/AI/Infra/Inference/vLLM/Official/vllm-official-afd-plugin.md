---
title: "Announcing vLLM AFD Plugin: Disaggregating Attention and FFN for Flexible MoE Serving"
source:
  type: "article"
  project: "vLLM"
  url: "https://vllm.ai/blog/2026-07-23-vllm-afd-plugin"
  author: "AFD Plugin Contributors"
  site: "vLLM Blog"
date: "2026-08-07T21:00:00+08:00"
category: [AI, Infra, Inference, vLLM, Official]
tags: ["AFD", "Attention-FFN Disaggregation", "MoE", "vLLM", "Ascend NPU", "DeepSeek-V3"]
description: "An experimental external plugin that brings Attention-FFn Disaggregation (AFD) to vLLM — separating Attention and FFN into independently deployed services for flexible MoE serving on GPU and Ascend NPU."
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Announcing vLLM AFD Plugin: Disaggregating Attention and FFN for Flexible MoE Serving](https://vllm.ai/blog/2026-07-23-vllm-afd-plugin) · **作者** AFD Plugin Contributors · **来源** vLLM Blog · **原文发布** 2026-07-23 · **中英对照·AI 译** 2026-08-07
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

We are excited to introduce [**vLLM AFD Plugin**](https://github.com/vllm-project/afd-plugin), an experimental external plugin that brings **Attention-FFN Disaggregation (AFD)** to vLLM.

> **译：** 我们很高兴地介绍 [**vLLM AFD Plugin**](https://github.com/vllm-project/afd-plugin)，一个将 **Attention-FFN 解耦（AFD）** 引入 vLLM 的实验性外部插件。

vLLM AFD Plugin brings AFD into Mixture-of-Experts (MoE) models by separating Attention and FFN into independently deployed services. The plugin preserves vLLM's existing request lifecycle and OpenAI-compatible serving interface, while allowing the Attention and FFN paths to scale independently.

> **译：** vLLM AFD Plugin 通过将 Attention 和 FFN 分离为独立部署的服务，将 AFD 引入混合专家（MoE）模型。该插件保留 vLLM 既有的请求生命周期和 OpenAI 兼容 serving 接口，同时允许 Attention 和 FFN 路径独立扩展。

The project currently supports NVIDIA GPUs and Ascend NPUs, synchronous and asynchronous connectors, DeepSeek V2/V3-family model wrappers, and eager, graph, and dual-batch execution paths within clearly validated limits.

> **译：** 该项目目前支持 NVIDIA GPU 和 Ascend NPU、同步和异步连接器、DeepSeek V2/V3 系列模型封装，以及 eager、graph 和 dual-batch 执行路径（在明确验证的范围内）。

> **Note:** This project is still experimental and needs more large-scale testing across different hardware backends.

> **译：** **注：** 此项目仍处于实验阶段，需要在不同硬件后端上进行更多大规模测试。

## Why Attention-FFN Disaggregation?

Mixture-of-Experts (MoE) inference combines two very different kinds of work inside every transformer layer. Attention is stateful and closely coupled to request scheduling and the KV cache, while the FFN or expert path is dominated by routed expert computation and all-to-all communication. When both paths share the same worker topology, the serving system must make one set of scaling and execution choices for workloads with very different requirements.

> **译：** 混合专家（MoE）推理在每个 transformer 层内组合了两种截然不同的工作。Attention 是有状态的，与请求调度和 KV cache 紧密耦合，而 FFN 或专家路径主要由路由专家计算和 all-to-all 通信主导。当两条路径共享同一 worker 拓扑时，serving 系统必须为需求截然不同的工作负载做出一套统一的扩展和执行选择。

Making this separation practical requires addressing several system design challenges:

> **译：** 使这种分离切实可行需要解决若干系统设计挑战：

1. **Attention and FFN have different scaling requirements.** Attention capacity follows request state, sequence length, and KV-cache pressure. Expert capacity follows token routing and expert load. The serving system should support independent scaling by allowing both paths to use different rank topologies, instead of requiring one shared layout.
2. **Attention and FFN have different runtime responsibilities.** Attention needs scheduling, KV-cache coordination, and sampling. FFN execution only needs activations, routing metadata, and a way to return expert outputs. Splitting the services lets the FFN side run as a lightweight connector-driven daemon.
3. **Communication is backend-specific.** CUDA and Ascend expose different collective libraries, graph runtimes, and optimized MoE operators. A common connector contract keeps the model-facing flow stable while allowing each backend to own its data path.
4. **Communication and computation benefit from overlap.** Asynchronous dispatch and MoE ubatching can overlap independent stages instead of serializing all expert work behind the Attention path.

> **译：**
>
> 1. **Attention 和 FFN 有不同的扩展需求。** Attention 容量跟随请求状态、序列长度和 KV-cache 压力。专家容量跟随 token 路由和专家负载。Serving 系统应通过允许两条路径使用不同的 rank 拓扑来支持独立扩展，而非要求一套共享布局。
> 2. **Attention 和 FFN 有不同的运行时职责。** Attention 需要调度、KV-cache 协调和采样。FFN 执行只需要 activation、路由元数据和返回专家输出的方式。拆分服务使 FFN 侧可作为轻量级连接器驱动的守护进程运行。
> 3. **通信是后端特定的。** CUDA 和 Ascend 暴露不同的集合通信库、graph 运行时和优化 MoE 算子。通用的连接器契约保持模型侧流程稳定，同时允许每个后端拥有自己的数据路径。
> 4. **通信和计算受益于重叠。** 异步分发和 MoE ubatching 可以重叠独立阶段，而非将所有专家工作串行在 Attention 路径之后。

Together, these challenges define the core design goal of AFD: keep vLLM's request-facing Attention path intact, while moving FFN execution behind a narrow connector interface that can scale, communicate, and execute independently.

> **译：** 这些挑战共同定义了 AFD 的核心设计目标：保持 vLLM 面向请求的 Attention 路径完整，同时将 FFN 执行移到一条可以独立扩展、通信和执行的窄连接器接口之后。

## Inside the Architecture

![vLLM AFD Plugin runtime architecture](/vibe-reading/images/articles/vllm-official-afd-plugin/fig-01-afd-architecture.svg)

The plugin integrates through vLLM's `vllm.general_plugins` entry point and the standard `--additional-config` channel. It does not require edits to the vLLM source tree.

> **译：** 该插件通过 vLLM 的 `vllm.general_plugins` 入口点和标准 `--additional-config` 通道集成。不需要修改 vLLM 源码树。

The runtime has three main parts:

> **译：** 运行时有三个主要部分：

- **Attention service.** The Attention worker retains vLLM's scheduler, KV cache, batching, model lifecycle, and sampling path. A plugin-owned model runner installs AFD metadata into the forward context and publishes data-parallel, ubatch, layer, and graph state to the FFN side.
- **FFN service.** The FFN worker has no request traffic, scheduler, or KV cache. A background loop receives metadata and activations, invokes `compute_ffn_output()` on the plugin-owned model wrapper, and sends the result back to Attention. Requests are always sent to the Attention API server.
- **Connector layer.** At each split layer, the connector transfers Attention hidden states together with the execution metadata required by the FFN service, then returns the computed FFN outputs. A backend-neutral connector interface defines this exchange while allowing each backend to implement its own communication and runtime optimizations.

> **译：**
>
> - **Attention 服务。** Attention worker 保留 vLLM 的调度器、KV cache、批处理、模型生命周期和采样路径。插件拥有的 model runner 将 AFD 元数据安装到 forward context 中，并向 FFN 侧发布 data-parallel、ubatch、layer 和 graph 状态。
> - **FFN 服务。** FFN worker 没有请求流量、调度器或 KV cache。后台循环接收元数据和 activation，在插件拥有的 model wrapper 上调用 `compute_ffn_output()`，并将结果发回 Attention。请求始终发送到 Attention API server。
> - **连接器层。** 在每个 split layer，连接器将 Attention hidden state 连同 FFN 服务所需的执行元数据一起传输，然后返回计算出的 FFN 输出。后端中立的连接器接口定义此交换，同时允许每个后端实现自己的通信和运行时优化。

This integration surface is designed to be intentionally small. vLLM continues to own the serving control plane where its existing abstractions fit, while the plugin provides the implementations of AFD workers, model runners, connectors, metadata, model split points, and a small set of version-scoped compatibility patches.

> **译：** 此集成面设计为有意保持小。vLLM 继续在既有抽象适合的地方拥有 serving 控制面，而插件提供 AFD worker、model runner、连接器、元数据、模型 split point 和一小组版本范围的兼容补丁的实现。

### Connector and backend support

| Connector | Backend | Execution | Recommended stage | Graph support |
| --- | --- | --- | --- | --- |
| `P2pNcclAFDConnector` | GPU | Synchronous P2P | Decode | `FULL_DECODE_ONLY` CUDA graph |
| `CAMP2pAFDConnector` | NPU | Synchronous CAMP2P/HCCL | Decode | `FULL_DECODE_ONLY` ACL graph |
| `CAMAsyncAFDConnector` | NPU | Asynchronous CAM | Prefill | Not currently supported |

The same high-level exchange - Attention output to FFN, FFN output back to Attention - is shared across connectors. Backend packages remain separate so CUDA graph behavior, ACL graph behavior, NCCL communication, and Ascend custom operators do not leak into one another.

> **译：** 所有连接器共享相同的高层交换——Attention 输出到 FFN、FFN 输出回 Attention。后端包保持分离，使 CUDA graph 行为、ACL graph 行为、NCCL 通信和 Ascend 自定义算子不会互相泄漏。

### Supported features

- **Native vLLM serving surface.** Existing vLLM users still launch with `vllm serve`, send requests to an OpenAI-compatible endpoint, and configure the runtime through `--additional-config`.
- **GPU and NPU implementations.** GPU workers extend vLLM v1 classes, while NPU workers extend vLLM-Ascend classes directly. Shared behavior lives in configuration, topology, metadata, and connector contracts rather than cross-device inheritance.
- **Synchronous AFD for decode throughput.** `P2pNcclAFDConnector` and `CAMP2pAFDConnector` synchronously exchange Attention activations and FFN outputs, allowing the two roles to scale independently in throughput-oriented decode deployments. Their current graph paths use `FULL_DECODE_ONLY` semantics on CUDA and ACL, respectively.
- **Asynchronous AFD for prefill.** `CAMAsyncAFDConnector` uses CAM asynchronous dispatch and combine operators to decouple prefill Attention ranks from expert workers. Together with AFD-managed MoE ubatching, it overlaps independent Attention and FFN stages to reduce pipeline stalls. This path currently targets the prefill stage in a prefill/decode-disaggregated deployment and does not yet support graph execution.
- **MoE model integration.** The plugin registers wrappers for DeepSeek V2/V3-family architectures, including DeepSeek V3.2, and GLM MoE DSA. The wrapper exposes separate Attention and FFN computations while reusing upstream layer implementations.
- **Graph and ubatching paths.** The synchronous GPU and NPU connectors support decode-only graph capture. Dual Batch Overlap is supported with exactly two ubatches, and CAM async provides AFD-managed MoE ubatching for its prefill path.

> **译：**
>
> - **原生 vLLM serving 面。** 既有 vLLM 用户仍用 `vllm serve` 启动，向 OpenAI 兼容端点发送请求，通过 `--additional-config` 配置运行时。
> - **GPU 和 NPU 实现。** GPU worker 扩展 vLLM v1 类，NPU worker 直接扩展 vLLM-Ascend 类。共享行为存在于配置、拓扑、元数据和连接器契约中，而非跨设备继承。
> - **面向 decode 吞吐的同步 AFD。** `P2pNcclAFDConnector` 和 `CAMP2pAFDConnector` 同步交换 Attention activation 和 FFN 输出，允许两个角色在面向吞吐的 decode 部署中独立扩展。它们当前的 graph 路径分别在 CUDA 和 ACL 上使用 `FULL_DECODE_ONLY` 语义。
> - **面向 prefill 的异步 AFD。** `CAMAsyncAFDConnector` 使用 CAM 异步分发和 combine 算子将 prefill Attention rank 与专家 worker 解耦。配合 AFD 管理的 MoE ubatching，它重叠独立的 Attention 和 FFN 阶段以减少流水线停顿。此路径目前面向 prefill/decode 解耦部署中的 prefill 阶段，尚不支持 graph 执行。
> - **MoE 模型集成。** 插件为 DeepSeek V2/V3 系列架构（包括 DeepSeek V3.2）和 GLM MoE DSA 注册封装。封装暴露分离的 Attention 和 FFN 计算，同时复用上游 layer 实现。
> - **Graph 和 ubatching 路径。** 同步 GPU 和 NPU 连接器支持 decode-only graph 捕获。Dual Batch Overlap 支持恰好两个 ubatch，CAM async 为其 prefill 路径提供 AFD 管理的 MoE ubatching。

## A Performance Snapshot

### Synchronous AFD Decode Throughput with `CAMP2pAFDConnector`

The synchronous decode recipe in [vllm-project/afd-plugin#67](https://github.com/vllm-project/afd-plugin/pull/67) compares a conventional EP64 deployment with `CAMP2pAFDConnector`-based AFD deployments for DeepSeek-V3.2 W8A8 on Ascend 910C. The benchmark measures saturated decode throughput rather than online-serving latency.

> **译：** [vllm-project/afd-plugin#67](https://github.com/vllm-project/afd-plugin/pull/67) 中的同步 decode 配方将传统 EP64 部署与基于 `CAMP2pAFDConnector` 的 AFD 部署在 Ascend 910C 上对 DeepSeek-V3.2 W8A8 进行比较。基准测量的是饱和 decode 吞吐而非在线 serving 延迟。

| Deployment | Physical topology | Total dies |
| --- | --- | --- |
| EP64 | DP64, EP64, TP1 | 64 |
| 48A16F | 48 Attention ranks, 16 FFN ranks | 64 |
| 64A16F | 64 Attention ranks, 16 FFN ranks | 80 |

> **Note:** These are controlled performance results, not accuracy or production-serving results. Due to limited machine availability, the physical 48A16F and 64A16F deployments simulate logical 192A64F and 256A64F scales. The experiment replaces natural routed expert IDs with a deterministic forced-balancing cycle, which changes model outputs. `AFDDecodeBenchConnector` supplies the decode-only KV state, and DBO is enabled for AFD.

> **译：** **注：** 这些是受控性能结果，非精度或生产 serving 结果。由于机器有限，物理 48A16F 和 64A16F 部署模拟逻辑 192A64F 和 256A64F 规模。实验用确定性强制均衡循环替换自然路由专家 ID，这会改变模型输出。`AFDDecodeBenchConnector` 提供 decode-only KV 状态，AFD 启用 DBO。

Throughput is normalized by the total number of deployed dies:

> **译：** 吞吐按总部署 die 数归一化：

```
tokens/s/die = aggregate output token throughput / total deployed dies
```

Both workloads use fixed-length inputs and uniformly distributed outputs from 512 to 1,536 tokens.

> **译：** 两个工作负载使用固定长度输入和 512 到 1,536 token 均匀分布的输出。

#### 16K fixed input

![DeepSeek-V3.2 16K decode throughput per die](/vibe-reading/images/articles/vllm-official-afd-plugin/fig-02-throughput-16k.png)

EP64 achieves **232.6 tokens/s/die**, 48A16F achieves **220.3 tokens/s/die**, and 64A16F achieves **258.9 tokens/s/die**. Relative to EP64, the AFD results are **-5.3%** for 48A16F and **+11.3%** for 64A16F.

> **译：** EP64 达到 **232.6 tokens/s/die**，48A16F 达到 **220.3 tokens/s/die**，64A16F 达到 **258.9 tokens/s/die**。相对 EP64，AFD 结果为 48A16F **-5.3%**、64A16F **+11.3%**。

#### 32K fixed input

![DeepSeek-V3.2 32K decode throughput per die](/vibe-reading/images/articles/vllm-official-afd-plugin/fig-03-throughput-32k.png)

EP64 achieves **168.2 tokens/s/die**, 48A16F achieves **151.4 tokens/s/die**, and 64A16F achieves **183.3 tokens/s/die**. Relative to EP64, the AFD results are **-10.0%** for 48A16F and **+9.0%** for 64A16F.

> **译：** EP64 达到 **168.2 tokens/s/die**，48A16F 达到 **151.4 tokens/s/die**，64A16F 达到 **183.3 tokens/s/die**。相对 EP64，AFD 结果为 48A16F **-10.0%**、64A16F **+9.0%**。

Across both input lengths, 48A16F is below the EP64 baseline, while 64A16F delivers the highest normalized throughput: **+11.3% at 16K** and **+9.0% at 32K**. This result shows that the Attention-to-FFN allocation matters; disaggregation alone does not guarantee a throughput gain.

> **译：** 跨两种输入长度，48A16F 低于 EP64 基线，而 64A16F 提供最高归一化吞吐：16K 下 **+11.3%**、32K 下 **+9.0%**。此结果表明 Attention 与 FFN 的分配比例很重要；解耦本身不保证吞吐增益。

Due to limited machine availability, we did not evaluate deployments with higher Attention-to-FFN ratios. The observed trend suggests that, at the ratios tested, the FFN ranks still have compute headroom rather than being compute-bound. Increasing the proportion of Attention ranks may therefore reveal further throughput gains.

> **译：** 由于机器有限，我们未评估更高 Attention-to-FFN 比例的部署。观察到的趋势表明，在测试的比例下，FFN rank 仍有计算余量而非计算受限。增加 Attention rank 比例可能揭示进一步的吞吐增益。

### Asynchronous AFD Prefill Performance with `CAMAsyncAFDConnector`

The repository includes an early CAM async experiment on two Ascend 910C nodes using a DeepSeek V3.2 W8A8 model reduced to 10 layers. The comparison uses forced expert balancing and contrasts a `DP4PCP8 TP1` baseline with an AFD layout consisting of Attention `DP3PCP8 TP1` plus FFN `EP8`.

> **译：** 仓库包含一个早期 CAM async 实验，在两个 Ascend 910C 节点上使用缩减为 10 层的 DeepSeek V3.2 W8A8 模型。比较使用强制专家均衡，将 `DP4PCP8 TP1` 基线与 Attention `DP3PCP8 TP1` 加 FFN `EP8` 的 AFD 布局对比。

![Median TTFT comparison for the CAM async experiment](/vibe-reading/images/articles/vllm-official-afd-plugin/fig-04-ttft-comparison.png)

Across the measured request rates, the AFD configuration lowers median/P50 time to first token. At 12 requests per second, median TTFT decreases from **15.1 seconds to 8.0 seconds**, a reduction of approximately **47%**. At both 10 and 12 requests per second, the measured gap is about 7.2 seconds.

> **译：** 在测量的请求速率下，AFD 配置降低了中位数/P50 首 token 时间。在 12 请求/秒时，中位数 TTFT 从 **15.1 秒降至 8.0 秒**，降低约 **47%**。在 10 和 12 请求/秒时，测量差距约为 7.2 秒。

**Note**: These numbers are a focused validation of the CAM async execution path, not a general performance claim for full DeepSeek V3.2 or every AFD topology. The performance gains may also vary across workloads.

> **译：** **注：** 这些数字是对 CAM async 执行路径的专项验证，非对完整 DeepSeek V3.2 或每个 AFD 拓扑的通用性能声明。性能增益可能因工作负载而异。

## Getting Started

The current implementation requires Python 3.10–3.13 and targets vLLM `0.19.1`.

> **译：** 当前实现需要 Python 3.10–3.13，面向 vLLM `0.19.1`。

### Install

Check out the installation steps in our [README](https://github.com/vllm-project/afd-plugin#install) for details.

> **译：** 安装步骤详见我们的 [README](https://github.com/vllm-project/afd-plugin#install)。

### Deployment Recipes

Deployment commands depend on the backend, connector, model, and rank topology. Instead of duplicating configurations here, use the maintained [AFD Plugin recipes](https://github.com/vllm-project/afd-plugin/tree/main/recipe):

> **译：** 部署命令取决于后端、连接器、模型和 rank 拓扑。此处不重复配置，请使用维护中的 [AFD Plugin recipes](https://github.com/vllm-project/afd-plugin/tree/main/recipe)：

- **GPU synchronous AFD:** the [DeepSeek V2 Lite P2P NCCL recipes](https://github.com/vllm-project/afd-plugin/tree/main/recipe/gpu/p2p_nccl/deepseek_v2_lite) cover decode-oriented colocated and prefill/decode-disaggregated deployments, eager and CUDA graph execution, and multiple DP/TP layouts.
- **NPU asynchronous prefill AFD:** the [DeepSeek V3.2 CAM async recipe](https://github.com/vllm-project/afd-plugin/blob/main/recipe/npu/cam_async/DeepSeek-V3.2.md) documents the required environment, topology, AFD configuration, benchmark setup, and current limitations.

> **译：**
>
> - **GPU 同步 AFD：** [DeepSeek V2 Lite P2P NCCL recipes](https://github.com/vllm-project/afd-plugin/tree/main/recipe/gpu/p2p_nccl/deepseek_v2_lite) 覆盖面向 decode 的 colocated 和 prefill/decode 解耦部署、eager 和 CUDA graph 执行、以及多种 DP/TP 布局。
> - **NPU 异步 prefill AFD：** [DeepSeek V3.2 CAM async recipe](https://github.com/vllm-project/afd-plugin/blob/main/recipe/npu/cam_async/DeepSeek-V3.2.md) 记录所需环境、拓扑、AFD 配置、基准设置和当前限制。

Refer to the repository README and recipe directory for the latest supported connector matrix, configuration fields, and complete launch commands.

> **译：** 最新支持的连接器矩阵、配置字段和完整启动命令请参考仓库 README 和 recipe 目录。

## Current Scope and Roadmap

The project intentionally exposes its current boundaries: exact vLLM version pinning, model runner v1 only, full weights on both roles, decode-only graph modes, exactly two ubatches for DBO, and hardware-gated end-to-end testing.

> **译：** 项目有意暴露其当前边界：精确的 vLLM 版本锁定、仅 model runner v1、两个角色上的完整权重、decode-only graph 模式、DBO 恰好两个 ubatch、以及硬件门控的端到端测试。

The next phase of development will focus on:

> **译：** 下一阶段开发将聚焦于：

- **Broader vLLM compatibility and upstream alignment:** track newer vLLM releases, evaluate model runner v2, keep compatibility patches minimal, and contribute generally useful abstractions upstream as they mature.
- **More flexible execution:** extend graph modes, ubatch counts, asynchronous stages, and validated rank topologies.
- **Production-scale validation:** publish repeatable accuracy, latency, throughput, stability, and multi-node results on full models and realistic workloads.
- **Expanded model and connector coverage:** add MoE architectures and backend transports through the existing model-wrapper and connector interfaces, together with corresponding deployment recipes for each newly supported model and connector.
- **Multimodal and vLLM-Omni integration:** explore how AFD can integrate with [vLLM-Omni](https://github.com/vllm-project/vllm-omni) and heterogeneous multimodal pipelines, including its application within autoregressive (AR), Diffusion Transformer (DiT), and other stages that can benefit from independently scaled Attention and FFN execution.
- **Heterogeneous hardware and low-latency serving:** explore deploying Attention and FFN roles across different accelerator types and interconnects, together with connector, scheduling, placement, and computation-communication overlap optimizations that reduce time to first token and inter-token latency.

> **译：**
>
> - **更广泛的 vLLM 兼容性和上游对齐：** 跟踪更新的 vLLM 发布、评估 model runner v2、保持兼容补丁最小化，并在成熟时将有用的抽象贡献上游。
> - **更灵活的执行：** 扩展 graph 模式、ubatch 数量、异步阶段和验证的 rank 拓扑。
> - **生产规模验证：** 在完整模型和真实工作负载上发布可重复的精度、延迟、吞吐、稳定性和多节点结果。
> - **扩展模型和连接器覆盖：** 通过既有 model-wrapper 和连接器接口添加 MoE 架构和后端传输，并为每个新支持的模型和连接器提供对应部署 recipe。
> - **多模态和 vLLM-Omni 集成：** 探索 AFD 如何与 [vLLM-Omni](https://github.com/vllm-project/vllm-omni) 和异构多模态流水线集成，包括其在自回归（AR）、Diffusion Transformer（DiT）等可受益于独立扩展 Attention 和 FFN 执行的阶段中的应用。
> - **异构硬件和低延迟 serving：** 探索跨不同加速器类型和互连部署 Attention 和 FFN 角色，配合连接器、调度、放置和计算-通信重叠优化以降低首 token 时间和 inter-token 延迟。

## Join the Community

vLLM AFD Plugin is at an early stage, and feedback from model, serving, and hardware communities will shape its direction.

> **译：** vLLM AFD Plugin 处于早期阶段，来自模型、serving 和硬件社区的反馈将塑造其方向。

- **Code and documentation:** [github.com/vllm-project/afd-plugin](https://github.com/vllm-project/afd-plugin)
- **Runtime design docs:** [GPU Attention/FFN and Ascend Attention/FFN designs](https://github.com/vllm-project/afd-plugin/tree/main/docs)
- **Issues and feature requests:** [GitHub Issues](https://github.com/vllm-project/afd-plugin/issues)

> **译：**
>
> - **代码和文档：** [github.com/vllm-project/afd-plugin](https://github.com/vllm-project/afd-plugin)
> - **运行时设计文档：** [GPU Attention/FFN 和 Ascend Attention/FFN 设计](https://github.com/vllm-project/afd-plugin/tree/main/docs)
> - **Issue 和功能请求：** [GitHub Issues](https://github.com/vllm-project/afd-plugin/issues)

Let's build a more composable and hardware-aware future for MoE serving together.

> **译：** 让我们共同为 MoE serving 构建一个更具组合性和硬件感知的未来。
