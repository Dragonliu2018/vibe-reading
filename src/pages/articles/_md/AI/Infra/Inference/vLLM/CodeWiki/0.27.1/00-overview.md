---
source:
  type: "源码解读"
  project: "vLLM"
  url: "https://github.com/vllm-project/vllm"
title: "Overview"
date: "2026-08-22T18:02:27+08:00"
category: [AI, Infra, Inference, vLLM, CodeWiki, "0.27.1"]
tags: ["vLLM", "Python", "LLM 推理", "PagedAttention", "连续批处理", "CUDA Graph", "PD 分离"]
description: "vLLM 是高性能 LLM 推理与服务平台，以 PagedAttention、连续批处理与多进程 V1 引擎为核心。本文全面解读 v0.27.1 的分层架构、调度器、KV Cache、执行运行时与核心数据结构。"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.27.1 · **协议** Apache-2.0 · **语言** Python ≥ 3.10 / C++/CUDA · **代码量** ~91 万行（Python ~809k + C++/CUDA ~98k）· **仓库** [GitHub](https://github.com/vllm-project/vllm)

---

## 总览

### 项目简介

vLLM 是一个高吞吐、低延迟的大语言模型（LLM）推理与服务库。它最初诞生于 UC Berkeley Sky Computing Lab，如今已是开源 AI 领域最活跃的项目之一，由两千多名贡献者共同维护。vLLM 的核心价值在于：让用户能够用**接近裸金属的性能**把任意 Hugging Face 模型跑成生产级服务。

支撑这一价值的关键技术包括：用 **PagedAttention** 把 KV cache 像操作系统虚拟内存一样分页管理，消除碎片化；用**连续批处理（continuous batching）+ chunked prefill** 把 prefill 与 decode 混批，让每一步 GPU 都打满；用 **piecewise/full CUDA Graphs** 降低 kernel launch 开销；并支持 FP8/INT4/GPTQ/AWQ 等多种量化、FlashAttention/FlashInfer 等多种注意力 kernel、EAGLE/n-gram 等推测解码。

**项目当前边界**：vLLM 负责推理与 serving——把已训练好的权重高效地跑起来并对外提供 API。它**不负责训练**，也**不自带权重**（权重来自 HF Hub 等外部仓库）。它支持的并行策略（TP/PP/EP/CP/DP）面向推理吞吐而非训练。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| OpenAI 兼容 API | `vllm/entrypoints/openai/` | `/v1/chat/completions`、`/v1/completions`、`/v1/embeddings` 等，外加 Anthropic Messages API |
| CLI 入口 | `vllm/entrypoints/cli/` | `vllm serve`、`vllm chat`、`vllm complete`、`vllm bench` |
| 连续批处理 | `vllm/v1/core/sched/scheduler.py` | 无 prefill/decode 阶段划分，每步给每个请求分配 token 预算 |
| PagedAttention | `vllm/v1/core/` + `vllm/v1/attention/` | KV cache 按 block 分页，block_table 映射物理地址 |
| Prefix Caching | `vllm/v1/core/kv_cache_utils.py` | 链式 BlockHash 自动命中相同前缀 |
| Chunked Prefill | `vllm/v1/core/sched/scheduler.py` | 长 prefill 切分到 token 预算内，与 decode 混批 |
| CUDA Graphs | `vllm/v1/worker/gpu/cudagraph_utils.py` | FULL/PIECEWISE/NONE 三级，分段图支持变长 batch |
| 量化 | `vllm/model_executor/layers/quantization/` | FP8、GPTQ、AWQ、compressed-tensors、MXFP4 等 27+ 种 |
| 推测解码 | `vllm/v1/spec_decode/` + `vllm/v1/worker/gpu/` | EAGLE、n-gram、suffix 等 |
| 分布式推理 | `vllm/distributed/parallel_state.py` | TP/PP/EP/CP/DP 五种并行 |
| 多模态 | `vllm/multimodal/` | LLaVA、Qwen-VL 等图像/视频/音频输入 |
| 结构化输出 | `vllm/v1/structured_output/` | xgrammar/guidance 约束生成 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| PyTorch | 核心 | 模型定义、自动求导、`torch.compile` 分段图 |
| CUDA / HIP | 核心 | `csrc/` 下 C++/CUDA kernel（PagedAttention、quantized GEMM、rotary 等） |
| Triton | 核心 | 手写 GPU kernel（attention、MoE、input 准备等） |
| ZMQ | 核心 | AsyncLLM 与 EngineCore 子进程间 IPC |
| msgspec / msgpack | 核心 | 跨进程请求/输出序列化 |
| FastAPI / Uvicorn / uvloop | 核心 | OpenAI 兼容 API server |
| xgrammar | 可选 | 结构化输出的语法约束 |
| Ray | 可选 | 多节点分布式 executor |
| CUTLASS / FlashInfer / FlashMLA | 可选 | 高性能 GEMM 与 attention kernel |

### 版本历史

vLLM 的演进以 **V0 → V1 引擎重构**为分水岭。V0（`vllm/engine/llm_engine.py` 原版）是单进程架构，asyncio 事件循环会被持有 GIL 的 GPU forward 阻塞。V1 把引擎核心拆进独立进程（`EngineCoreProc`），用 ZMQ 与前端通信，彻底解耦 IO 与计算。到 **v0.27.1**，V1 已成为默认路径——`vllm/engine/llm_engine.py` 仅剩一行别名：

```python title="vllm/engine/llm_engine.py"
from vllm.v1.engine.llm_engine import LLMEngine as V1LLMEngine
LLMEngine = V1LLMEngine  # type: ignore
```

本文基于解读基线 commit `6e448d0ea9`（2026-08-11，`v0.27.1` tag）。

---

## 快速上手

最简方式是把一个 HF 模型跑成 OpenAI 兼容服务：

```bash title="终端"
vllm serve Qwen/Qwen3-0.6B
```

启动后用 OpenAI SDK 或 curl 验证：

```bash title="验证"
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3-0.6B","messages":[{"role":"user","content":"hi"}]}'
```

离线批量推理则用 Python API：

```python title="离线推理"
from vllm import LLM, SamplingParams
llm = LLM(model="Qwen/Qwen3-0.6B")
out = llm.generate(["Hello, ", "vLLM is "], SamplingParams(temperature=0.8))
```

---

## 架构设计解析

### 系统架构

vLLM v0.27.1 的设计思想可以概括为：**把推理引擎当成一个"分页式虚拟内存 + 多进程 actor"系统来设计**。PagedAttention 把 KV cache 从"每请求连续预留"变成"按 block 按需分配"，解决了显存碎片化与浪费；V1 把引擎核心（调度 + 执行）放进独立进程，让前端的 asyncio 服务循环不被 GPU 计算阻塞，从而能在吞吐最大化的同时维持低延迟的流式响应。

![vLLM 分层架构](/vibe-reading/images/articles/vllm/architecture.svg)

系统自顶向下分六层：**入口与服务层**（CLI + OpenAI API + 渲染）把外部协议适配成引擎输入；**V1 引擎层**（`AsyncLLM` + 独立进程的 `EngineCoreProc` + `OutputProcessor`）做请求生命周期管理与跨进程通信；**调度与 KV Cache 层**（`Scheduler` + `KVCacheManager` 分层体系 + `BlockPool`）决定"每步跑谁、KV cache 怎么分"；**执行运行时层**（`Worker` + `GPUModelRunner` + CUDA Graphs）把 schedule 落实成一次模型前向与采样；**模型与算子层**（并行 Linear/Embedding/MoE + 注意力后端 + 200+ 模型定义）是真正"算"的地方；**分布式与平台层**（`GroupCoordinator` + `DeviceCommunicator` + `Platform`）屏蔽硬件与通信差异。各层只依赖下方层，`VllmConfig` 作为全局配置贯穿所有层。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 入口与服务 | `vllm/entrypoints/` | 隔离外部协议（OpenAI/Anthropic/CLI），保护引擎不受接口变化影响 |
| V1 引擎 | `vllm/v1/engine/` | 编排请求生命周期，用多进程解耦 IO 与 GPU 计算 |
| 调度与 KV Cache | `vllm/v1/core/` | 决定每步调度哪些请求、如何分配分页 KV cache |
| 执行运行时 | `vllm/v1/worker/`、`vllm/v1/executor/` | 把调度结果落实成 GPU 前向与采样 |
| 模型与算子 | `vllm/model_executor/layers/`、`vllm/v1/attention/`、`vllm/model_executor/models/` | 并行化/量化/分页化的层与 kernel |
| 分布式与平台 | `vllm/distributed/`、`vllm/platforms/` | 屏蔽 N 种硬件与通信后端 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Actor / 多进程 | `EngineCoreProc` in `vllm/v1/engine/core.py:1008` | 引擎核心独占进程，GPU 计算不阻塞前端 asyncio |
| 策略 | `AttentionBackend`、`Platform`、`SingleTypeKVCacheManager` 子类 | 同一接口下可替换多种硬件/kernel/attention 类型 |
| 工厂 + 注册 | `AttentionBackendEnum` in `backends/registry.py`、`get_quantization_config` in `quantization/__init__.py` | 按字符串名延迟加载实现，避免循环 import |
| 对象池 | `BlockPool` in `vllm/v1/core/block_pool.py:143` | 预分配 KVCacheBlock，运行时零分配 |
| 适配器 | `OpenAIServingChat` in `entrypoints/openai/chat_completion/serving.py` | OpenAI 协议 ↔ vLLM `EngineClient` 接口 |
| Mixin | `LoRAModelRunnerMixin`、`KVConnectorModelRunnerMixin` in `vllm/v1/worker/` | 给 `GPUModelRunner` 组合 LoRA/KV 传输能力而不改继承树 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Request` | 一次推理请求（prompt + 采样参数 + 状态） | 入队 → waiting → running → finished | 由 `Scheduler` 管理，映射到 KV cache block |
| `KVCacheBlock` | 一块固定大小的 KV cache（block_size 个 token） | 池化分配，LRU 淘汰 | 组成 `block_table`，传给 attention kernel |
| `SchedulerOutput` | 一步调度的产出（哪些请求参与、各分多少 token） | 每 step 重建 | EngineCore → Worker 的数据契约 |
| `InputBatch` | 一步 GPU 前向的输入张量集合 | 每 step 重建（写持久 `InputBuffers`） | `GPUModelRunner` 消费 |
| `EngineCoreRequest`/`EngineCoreOutputs` | 跨进程的请求/输出消息体 | ZMQ 序列化传输 | AsyncLLM ↔ EngineCoreProc |
| `VllmConfig` | 全局配置（模型/缓存/并行/调度等子配置） | 进程生命周期 | 所有模块共享 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `AttentionBackend` | `vllm/v1/attention/backend.py:56` | `FlashAttentionBackend`、`FlashInferBackend`、`TritonMLABackend` 等 30+ | `AttentionBackendEnum` + `platform.get_attn_backend_cls()` 选择 |
| `Platform` | `vllm/platforms/interface.py:134` | `CudaPlatformBase`、`RocmPlatform`、`CpuPlatform` 等 | `builtin_platform_plugins` 检测 + OOT entry point |
| `DeviceCommunicatorBase` | `vllm/distributed/device_communicators/base_device_communicator.py:162` | `CudaCommunicator`、`XPUCommunicator` 等 | `Platform.get_device_communicator_cls()` |
| `LinearMethodBase` | `vllm/model_executor/layers/quantization/base_config.py` | `Fp8LinearMethod`、`AwqLinearMethod` 等 | `QuantizationConfig.get_quant_method(layer)` |
| `WorkerBase` | `vllm/v1/worker/worker_base.py` | `Worker`、`CPUWorker`、`XpuWorker` | `parallel_config.worker_cls` 字符串 + `resolve_obj_by_qualname` |

---

## 代码目录

```shell
vllm/
├── v1/                      # V1 架构（默认引擎）
│   ├── engine/              # AsyncLLM、EngineCore、IPC
│   ├── core/                # 调度器与 KV Cache 管理（sched/、block_pool 等）
│   ├── worker/              # GPU/CPU/TPU Worker 与 ModelRunner
│   ├── attention/           # 注意力后端抽象与多后端实现
│   ├── executor/            # 单/多进程 executor
│   ├── spec_decode/         # 推测解码
│   ├── sample/              # 采样
│   └── structured_output/   # 语法约束输出
├── model_executor/
│   ├── layers/              # 并行层框架（linear、fused_moe、quantization、rotary_embedding）
│   ├── models/              # 200+ HF 模型定义（Llama、Qwen、DeepSeek…）
│   ├── model_loader/        # 权重加载（default_loader、sharded_state_loader 等）
│   └── kernels/             # 算子
├── entrypoints/             # CLI + OpenAI/Anthropic API server
├── distributed/             # 并行状态与设备通信器（TP/PP/EP）
├── platforms/                # 硬件平台抽象（CUDA/ROCm/CPU/TPU/XPU）
├── config/                  # VllmConfig 及各子配置
├── multimodal/              # 多模态输入处理
├── lora/                    # LoRA 适配器
├── transformers_utils/      # HF 工具（chat template、config、processor）
└── compilation/             # torch.compile 编译 passes
csrc/                        # C++/CUDA kernel（PagedAttention、quantized GEMM…）
```

`vllm/engine/` 只剩 V1 别名（见上文）。`tests/` 是分层测试目录（unit/integration/e2e/kernels），`benchmarks/` 是性能基准。`csrc/` 的 kernel 通过 Python 侧的 `vllm._custom_ops` 调用。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/vllm/module-dependencies.svg)

模块间的依赖方向整体自上而下：入口层依赖 `EngineClient` 抽象接口（不感知引擎内部）；引擎层调用调度器产出 `SchedulerOutput`，再经 executor 调度 Worker；Worker 前向时调用模型执行层与注意力后端；执行层与注意力后端都依赖分布式层的 all-reduce/all-gather，而分布式层最终落到 `Platform` 选出的通信器。`VllmConfig` 作为全局配置被所有模块共享（图中虚线）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| V1 引擎 | 异步接口 + 独立进程引擎核心 + 请求生命周期 | `AsyncLLM` / `EngineCoreProc` | 用多进程把 IO 与 GPU 计算解耦，是 V1 的立身之本 | [V1 引擎](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/01-v1-engine) |
| 调度器与 KV Cache | 连续批处理 + PagedAttention 分页 KV + prefix cache | `Scheduler` / `KVCacheManager` | KV cache 的分页分配与命中率是 vLLM 性能的核心 | [调度器与 KV Cache](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/02-scheduler-kv-cache) |
| GPU Worker | GPU 执行单元 + CUDA Graphs + 输入组装 | `Worker` / `GPUModelRunner` | 把抽象的 schedule 落实成一次真实前向，是性能最敏感的一层 | [GPU Worker 与模型执行](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/03-gpu-worker) |
| 注意力后端 | 统一 AttentionBackend 接口 + 多 kernel 实现 | `AttentionBackend` / `selector` | 屏蔽多硬件/多 kernel 差异，模型代码只写 `Attention(...)` | [注意力后端](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/04-attention-backends) |
| 模型执行层 | 并行 Linear/Embedding/MoE + 可插拔量化 | `ColumnParallelLinear` / `FusedMoE` / `QuantizationConfig` | 让"任意 HF 模型"在 TP/EP 下跑起来的框架层 | [模型执行层](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/05-model-layers) |
| 入口与 API 服务 | CLI + OpenAI/Anthropic API + serving handler | `vllm serve` / `OpenAIServingChat` | 隔离外部协议，是用户接触 vLLM 的门面 | [入口与 API 服务](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/06-entrypoints) |
| 分布式与平台 | 并行状态 + 设备通信 + 硬件平台抽象 | `GroupCoordinator` / `Platform` | 屏蔽 N 种硬件与通信后端的差异 | [分布式推理](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/07-distributed) |

> 模块间的动态调用顺序见下文「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

以 `vllm serve` 为例，启动是一连串对象装配：

```
vllm serve <model>                                    # vllm/entrypoints/cli/main.py:28
└─ ServeSubcommand.cmd()                              # cli/serve.py:50
   └─ uvloop.run(run_server(args))                   # serve.py:91
      └─ build_async_engine_client(args)             # api_server.py:110
         └─ AsyncLLM.from_vllm_config(vllm_config)   # async_llm.py:206
            ├─ Renderer / InputProcessor / OutputProcessor   # 前端进程内组件
            └─ AsyncMPClient → launch_core_engines()  # core_client.py:516
               └─ CoreEngineProcManager               # engine/utils.py:120
                  └─ multiprocessing.Process(run_engine_core)  # fork EngineCore 子进程
      └─ build_app(args) → FastAPI + register routes  # api_server.py:189
      └─ init_app_state() → OpenAIServingChat 等 handler  # api_server.py:355
      └─ serve_http(app) → Uvicorn                    # launcher.py:26
```

**对象装配**的关键：`AsyncLLM.__init__`（前端进程）持有 `InputProcessor`、`OutputProcessor` 与 `EngineCoreClient`；后者通过 `CoreEngineProcManager` 用 `multiprocessing.Process` fork 出 `EngineCoreProc` 子进程，子进程内构造 `Scheduler` 与 `model_executor`（后者再 spawn Worker 子进程）。配置来自 `EngineArgs.create_engine_config()` 产出的 `VllmConfig`，覆盖优先级是命令行参数 > 配置文件 > 默认值。serving handler 在 `init_app_state` 中实例化并挂到 `app.state`，注入同一个 `engine_client`（`AsyncLLM`）。

### 核心运行流程

vLLM 最核心的运行模式有三条主链路：在线流式服务、离线批量推理、以及 EngineCore 的 step 循环。它们共享同一套调度-执行-输出机制，差别在进程模型与同步/异步。

#### 在线服务：一次流式请求

![请求处理数据流](/vibe-reading/images/articles/vllm/data-flow.svg)

数据流横跨三个进程：**API Server 进程**收到 `ChatCompletionRequest`，经 `OnlineRenderer` 渲染 + `InputProcessor` 构造 `EngineCoreRequest`，通过 ZMQ（`AsyncMPClient` ROUTER → `EngineCoreProc` DEALER，msgpack 编码）发给 **EngineCore 子进程**；EngineCore 的 busy loop 调用 `scheduler.schedule()` 产出 `SchedulerOutput`，经共享内存 `MessageQueue` 发给 **Worker 子进程**执行；Worker 前向 + 采样得到 `ModelRunnerOutput`，原路经共享内存回到 EngineCore，`scheduler.update_from_output()` 产出 `EngineCoreOutputs`，再经 ZMQ（PUSH → PULL）回到 API Server；`OutputProcessor` 做**增量 detokenize**（`IncrementalDetokenizer.update`）并检测 stop string，产出 `RequestOutput` 推入 per-request 队列，最终由 `AsyncLLM.generate()` 的协程 yield 成 SSE 流。关键设计决策是：detokenize 放前端进程、`output_handler` 按块处理并 `await asyncio.sleep(0)` 让出事件循环、EngineCore 的两个 IO 线程在等 ZMQ 时释放 GIL 从而与 GPU 重叠。

#### 离线推理：vllm.LLM.generate()

离线模式用 `LLMEngine`（`vllm/v1/engine/llm_engine.py:48`），通过 `EngineCoreClient.make_client()` 选 `InprocClient`（同进程）或 `SyncMPClient`（多进程）。同进程模式下 `get_output()` 直接调 `engine_core.step_fn()`，`OutputProcessor` 不用 per-request queue 而是直接返回 `list[RequestOutput]`。`LLM.generate()` 在循环里反复 `LLMEngine.step()` 直到所有请求 finished。

#### EngineCore：step 循环

EngineCore 的 `step()`（`vllm/v1/engine/core.py:584`）是性能心脏：

```
EngineCore.step()
├─ scheduler.schedule()            → SchedulerOutput
├─ model_executor.execute_model(scheduler_output, non_block=True) → Future
├─ scheduler.get_grammar_bitmask(scheduler_output)
├─ future.result()                 → ModelRunnerOutput   # 阻塞等 GPU
└─ scheduler.update_from_output()  → dict[int, EngineCoreOutputs]
```

`execute_model(non_block=True)` 返回 `Future`，让 EngineCore 在等 GPU 的间隙做 `get_grammar_bitmask` 等 CPU 工作；PP>1 时切换到 `step_with_batch_queue` 用 `batch_queue` 异步调度多 batch 消除 pipeline bubble。

### 状态流

![运行时状态流](/vibe-reading/images/articles/vllm/state-flow.svg)

请求在 `Scheduler` 中有三个主状态：`WAITING`（在 waiting 队列，未分配 KV cache）、`RUNNING`（已分配 KV block，正在执行）、`FINISHED`（token 生成完成）。状态转换由调度器驱动：`schedule()` 在 KV cache 有空余时把 WAITING 请求分配 block 升为 RUNNING；当显存不足时 `_preempt_request()` 释放 RUNNING 请求的 block 降回 WAITING（recompute 模式）；请求生成完毕或被取消时转入 `FINISHED`/`ABORTED`。相关代码：请求状态在 `Request.num_computed_tokens` 与 `RequestStatus` 上流转，转换方法 `_preempt_request` in `vllm/v1/core/sched/scheduler.py`，调度器在 `schedule()` 与 `update_from_output()` 中触发转换。

---

## 典型修改场景

#### 场景 1：新增一种量化方法

在 `vllm/model_executor/layers/quantization/__init__.py` 的 `QuantizationMethods` 与 `method_to_config` 注册名称；新建 `quantization/<my_quant>/` 目录实现 `MyQuantConfig`（`get_quant_method` 按 layer 类型返回 Method）与 `MyQuantLinearMethod`（实现 `create_weights`/`apply`）。模型代码无需改动——`LinearBase` 持有 `quant_method`，forward 调 `quant_method.apply()`。

#### 场景 2：新增一个 API 端点

在 `vllm/entrypoints/openai/<endpoint>/` 下建 `protocol.py`（Pydantic 模型）、`serving.py`（继承 `GenerateBaseServing`，内部调 `engine_client.generate()`）、`api_router.py`（FastAPI `APIRouter` + `attach_router`）；在 `generate/api_router.py` 的 `register_generate_api_routers()` 挂载；在 `generate/factories.py` 的 `init_generate_state()` 实例化 handler 挂到 `app.state`。

#### 场景 3：新增一种硬件平台

实现 `Platform` 子类（`platforms/<new>.py`，覆写 `device_name`、`dist_backend`、`get_device_communicator_cls`、`get_attn_backend_cls` 等能力声明）；若通信需要自定义后端，继承 `DeviceCommunicatorBase` 覆写 `all_reduce` 等；在 `platforms/__init__.py` 的 `builtin_platform_plugins` 加检测函数或用 OOT entry point 注册。

---

## 测试体系

```
tests/
├── unit/            # 单元测试（纯逻辑、无 GPU）
├── integration/     # 集成测试（引擎 + 调度）
├── e2e/             # 端到端（API server → 推理）
├── kernels/        # CUDA/Triton kernel 正确性
├── models/         # 各模型架构正确性
└── distributed/    # 多卡并行
```

| 代码层 | 测试类型 |
| --- | --- |
| 调度器 / KV cache | unit + integration |
| Worker / ModelRunner | integration + kernels |
| API server / serving handler | e2e |
| 模型定义 | models |
| 通信 / 平台 | distributed |

理解某个模块时优先读对应测试——如调度策略改动看 `tests/v1/test_scheduler.py`，attention 后端看 `tests/v1/attention/`。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `vllm/entrypoints/cli/main.py` 的 `main()` → `cli/serve.py` 的 `ServeSubcommand.cmd()` → `vllm/v1/engine/async_llm.py` 的 `AsyncLLM.generate()` → `vllm/v1/engine/core.py` 的 `EngineCore.step()`
- **第二遍：理解核心数据结构**
  `vllm/v1/core/kv_cache_utils.py` 的 `KVCacheBlock`/`BlockHash` → `vllm/v1/core/block_pool.py` 的 `BlockPool` → `vllm/v1/core/sched/scheduler.py` 的 `Scheduler.schedule()`
- **第三遍：理解执行与算子**
  `vllm/v1/worker/gpu_worker.py` 的 `Worker.execute_model()` → `vllm/v1/worker/gpu_model_runner.py` 的 `GPUModelRunner.execute_model()` → `vllm/model_executor/layers/linear.py` 的 `ColumnParallelLinear` → `vllm/v1/attention/backend.py` 的 `AttentionBackend`
- **第四遍：选择重点子模块深入阅读**（见模块地图的"深入阅读"链接）

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| PagedAttention | 把 KV cache 按 block 分页管理，类比 OS 虚拟内存 |
| Continuous Batching | 每步动态重组 batch，请求随到随走 |
| Chunked Prefill | 长 prefill 切分到 token 预算内，与 decode 混批 |
| Prefix Caching | 相同前缀的 KV cache block 跨请求复用 |
| MLA | Multi-head Latent Attention，DeepSeek 的压缩 KV 注意力 |
| TP/PP/EP/CP/DP | Tensor/Pipeline/Expert/Context/Data Parallelism |

### 参考资料

- [vLLM 官方文档](https://docs.vllm.ai)
- [PagedAttention 论文（SOSP'23）](https://arxiv.org/abs/2309.06180)
- [vLLM 博客](https://blog.vllm.ai)
