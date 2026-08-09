---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "Overview"
date: "2026-08-09T23:30:00+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.17"]
tags: ["SGLang", "Python", "LLM 推理", "RadixAttention", "推测解码", "服务框架"]
description: "SGLang 是高性能大模型推理服务框架。本文从系统架构、三进程运行时、RadixAttention 缓存到核心模块，全面解读 v0.5.17 的内部原理。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.5.17（解读基于 main HEAD，略新于该 release） · **协议** Apache-2.0 · **语言** Python ≥ 3.10（含 Rust 扩展 + CUDA C++ 算子） · **代码量** 核心运行时 srt ~58 万行 / 全仓库 ~110 万行 · **仓库** [GitHub](https://github.com/sgl-project/sglang)

---

## 总览

### 项目简介

SGLang（Structured Generation Language）是一个高性能的大语言模型与多模态模型推理服务框架，从单 GPU 到大规模分布式集群提供低延迟、高吞吐的推理能力。它由 LMSYS 维护，已在业界大规模生产部署，日处理万亿级 token，驱动全球 40 万+ GPU。

**核心价值**：把"高效服务一个 LLM"这件事工程化——前缀缓存复用、零开销 CPU 调度、连续批处理、推测解码、多种并行策略，让推理不再只是"跑一次 forward"，而是可编排、可缓存、可扩展的运行时系统。

**核心使用场景**：在线 LLM 服务（OpenAI/Anthropic/Ollama 兼容 API）、离线批量推理、RL/后训练 rollout 后端（被 AReaL、Miles、verl、Tunix 等框架采用）。

**项目边界**：负责推理运行时（调度、KV 缓存、批处理、并行、推测解码）与 API 服务层；不负责模型训练、不实现自研 CUDA kernel 之外的基础算子库（依赖 FlashInfer / sgl-kernel）。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|----------|------|
| RadixAttention 前缀缓存 | `srt/mem_cache/` | radix tree 自动共享任意长度公共前缀 KV |
| 零开销 CPU 调度器 | `srt/managers/scheduler.py` | overlap 模式 CPU 调度与 GPU forward 并行 |
| 连续批处理 | `srt/managers/schedule_policy.py` | prefill/decode 同 batch 交替，PrefillAdder 准入控制 |
| 推测解码 | `srt/speculative/` | EAGLE / DFlash / n-gram / FrozenKVMTP，注册表式扩展 |
| 多 API 兼容 | `srt/entrypoints/{openai,anthropic,ollama}/` | OpenAI / Anthropic / Ollama 客户端零改动接入 |
| PD 分离 | `srt/disaggregation/` | prefill 与 decode 分离部署 |
| 多种并行 | `srt/distributed/` + `managers/data_parallel_controller.py` | TP / PP / EP / DP / CP |
| CUDA Graph 加速 | `srt/model_executor/runner/` | decode 阶段整图捕获重放，分桶 padding |
| 结构化输出 | `srt/constrained/` | compressed FSM 加速 JSON/regex 约束采样 |
| 多 LoRA 批处理 | `srt/lora/` | 同 batch 多 adapter 推理 |
| 量化 | `srt/layers/quant` + `mem_cache/*FP4*` | FP4 / FP8 / MXFP8 / INT4 / AWQ / GPTQ |
| 多硬件后端 | `srt/hardware_backend/` | NVIDIA / AMD / Intel CPU / TPU / Ascend NPU |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| `fastapi` + `uvicorn` | 核心 | HTTP API 服务、ASGI 中间件 |
| `zmq`（pyzmq） | 核心 | 跨进程 IPC（PUSH/PULL/DEALER，asyncio 集成） |
| `msgspec` | 核心 | IPC 消息体结构与序列化 |
| `torch` | 核心 | 模型实现、autograd、CUDA Stream |
| `flashinfer` | 核心 | attention 后端、前缀缓存 kernel |
| `sgl-kernel`（CUDA C++） | 核心 | 底层 Triton/CUDA 算子（paged 分配、tree attention） |
| `transformers` | 核心 | HuggingFace 模型加载、tokenizer |
| `numpy` / `numba` | 核心 | CPU 侧索引、n-gram 推测解码 |
| `aiohttp` | 核心 | 异步 HTTP 客户端、bootstrap |
| `setuptools-rust` | 扩展 | 编译 Rust gRPC server 组件（`rust/`） |
| `ray` | 可选 | Ray 后端分布式（`sglang[ray]`） |
| `flash-attn-4` | 可选 | attention kernel |

---

## 快速上手

```bash
# 安装（含全部运行时依赖）
pip install "sglang[all]"

# 启动服务（OpenAI 兼容 API，默认端口 30000）
sglang serve --model-path meta-llama/Llama-3.1-8B-Instruct

# 另开一个终端发请求验证
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"meta-llama/Llama-3.1-8B-Instruct","messages":[{"role":"user","content":"用一句话介绍 SGLang"}]}'
```

预期返回一个 JSON，`choices[0].message.content` 为模型生成文本，证明服务跑起来了。流式加 `"stream": true` 即得 SSE。也可用 `openai` Python SDK，把 `base_url` 指向 `http://localhost:30000/v1`。

---

## 架构设计解析

### 系统架构

SGLang 的整体设计思想是**"运行时优先"**——把一次推理请求的生命周期拆成可独立优化的阶段（接入 → 调度 → 执行 → 缓存 → 出流），每阶段用进程隔离 + IPC 解耦，再用 radix tree 把跨请求的 KV 复用做成一等公民。这样 GPU 只管高密度 forward，CPU 管调度与 I/O，两者通过 overlap 重叠。

![系统架构图](/vibe-reading/images/articles/sglang-internals/architecture.svg)

系统分为五层，自上而下依赖：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 接口层 | `srt/entrypoints/` + `sgl-model-gateway/` | 隔离外部协议（HTTP/OpenAI/gRPC），保护核心运行时不受 API 变化影响 |
| 编排层 | `srt/managers/` | 编排请求生命周期：调度、批处理、tokenize/detokenize、数据并行路由 |
| 执行层 | `srt/model_executor/` + `speculative/` + `sampling/` | 承载一次 forward 的全部逻辑：批次装配、CUDA graph、推测解码、采样 |
| 缓存层 | `srt/mem_cache/` | 管理 KV 物理显存与逻辑前缀共享，是 RadixAttention 的实现所在 |
| 模型算子与硬件层 | `models/` + `layers/` + `sgl-kernel/` + `hardware_backend/` + `distributed/` | 模型实现、attention/MoE/量化算子、底层 CUDA op、多硬件适配、并行通信 |

一个关键设计：缓存层（mem_cache）横跨编排层与执行层——Scheduler 持有 `tree_cache` 做前缀匹配与准入预算，执行层的 attention 层则直接读写 `token_to_kv_pool` 物理张量。物理池与逻辑 radix tree 分离，使 evict/insert 只动索引不搬数据。

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Mixin 组合 | `Scheduler` 6 个 Mixin（`scheduler.py:370`）；`ForwardBatch(ForwardBatchDeepSeekMHAMixin)` | 避免巨型类，每个 Mixin 独立维护一个垂直特性（PD 分离、PP、多模态等），按需组合 |
| 策略模式 | `SchedulePolicy`（`schedule_policy.py:211`）`CacheAwarePolicy`/`CacheAgnosticPolicy`；`DataParallelController` 的 `LoadBalanceMethod` | 调度策略与 DP 路由策略可配置切换，队列 >128 自动降级 FCFS |
| 注册表 / 插件 | `speculative/spec_registry.py` 的 `@SpeculativeAlgorithm.register`；`mem_cache/registry.py` 的 `register_radix_cache_backend` | 推测算法与 cache 变体可不改源码扩展，注册时校验 duck-type 契约 |
| 模板方法 | `BaseSpecWorker`（`base_spec_worker.py`）骨架 + 子类覆盖 `forward_batch_generation`；`BaseCudaGraphBackend` 的 `capture_one`/`replay` | 统一 verify 骨架，子类只填 draft 差异 |
| 零开销 overlap（双流异步） | `event_loop_overlap`（`scheduler.py:1719`）`result_queue` 延迟一步处理 | CPU 调度与上一轮 GPU forward 并行，消除串行等待 |
| 全局上下文 | `ForwardContext`（`forward_context.py:35`）模块级单例 | 深层 attention 层经 `get_attn_backend()` 取 backend/pool，免去逐层传参 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `Engine` | 引擎，装配三进程并暴露 generate API | 进程级（主进程） | 持有 `TokenizerManager` |
| `TokenizerManager` | tokenize、请求分发、响应聚合（asyncio） | 进程级（主进程） | ZMQ 连 Scheduler/Detokenizer |
| `Scheduler` | 零开销批量调度，持有 KV cache 与 TpWorker | 子进程级（每 TP rank） | 调 TpModelWorker，管 tree_cache |
| `ScheduleBatch` / `Req` | 调度批次 / 单请求状态（CPU 侧） | 每 batch / 每请求 | `prepare_for_extend/decode` 转 ForwardBatch |
| `ForwardBatch` | 一次 forward 的全部 GPU 张量（~50 字段） | 每 batch | 由 `ScheduleBatch` 经 `init_new` 构建 |
| `ModelRunner` | 持有 `model: nn.Module`，驱动 forward + sample | 每 Scheduler | 调 `model.forward`，管 cuda graph |
| `RadixCache` / `TreeNode` | radix tree 前缀缓存 | 跨请求（节点常驻） | value 指向 `KVCache` slot 索引 |
| `MemoryPool`（`KVCache`） | KV 物理显存张量（per-layer） | 进程级常驻 | 被 allocator 分配、被 attention 层读写 |
| `SpeculativeAlgorithm` | 推测解码算法枚举 + 注册表 | 静态 | `create_worker` 选 Worker 类 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|-------------|----------|--------|----------|
| `EngineBase`(ABC) | `entrypoints/EngineBase.py:7` | `Engine` | 抽象方法 generate/flush_cache/shutdown |
| `BasePrefixCache`(ABC) | `mem_cache/base_prefix_cache.py` | `RadixCache`/`HiRadixCache`/`UnifiedRadixCache` | `registry.py` 工厂选择链 + `register_radix_cache_backend` |
| `BaseTokenToKVPoolAllocator`(ABC) | `mem_cache/allocator/base.py:27` | `TokenToKVPoolAllocator`/`PagedTokenToKVPoolAllocator`/`SWA...` | `kv_cache_configurator._build_token_to_kv_pool_allocator` 分支 |
| `BaseSpecWorker`(ABC) | `speculative/base_spec_worker.py` | `EAGLEWorkerV2`/`DFlashWorkerV2`/`NGRAMWorker`/`FrozenKVMTPWorkerV2` | `SpeculativeAlgorithm.create_worker` |
| `EagleDraftWorkerBase`(ABC) | `speculative/base_spec_worker.py` | `EagleDraftWorker`/`DFlashDraftWorker` | spec worker 内部持有 |
| `BaseCudaGraphBackend`(ABC) | `model_executor/runner_backend/base_cuda_graph_backend.py:28` | `FullCudaGraphBackend`/`BreakableCudaGraphBackend`/`TcPiecewiseCudaGraphBackend` | `CudaGraphConfig.Backend` 配置选择 |

---

## 代码目录

```shell
python/sglang/
├── srt/                    # SGLang Runtime 核心运行时
│   ├── entrypoints/        # HTTP/gRPC/OpenAI/Anthropic/Ollama API、Engine
│   ├── managers/           # Scheduler/TokenizerManager/DetokenizerManager/DPController
│   ├── model_executor/     # ModelRunner/ForwardBatch/CUDA Graph/Runner 体系
│   ├── mem_cache/          # RadixCache/MemoryPool/Allocator/HiRadixCache
│   ├── speculative/        # EAGLE/DFlash/n-gram 推测解码
│   ├── models/             # 各模型实现（Llama/Qwen/DeepSeek…）
│   ├── layers/             # Attention/MoE/Quant 算子层
│   ├── sampling/           # 采样参数与 batch info
│   ├── distributed/        # TP/PP/EP/DP/CP 并行
│   ├── disaggregation/     # PD 分离
│   ├── hardware_backend/   # CPU/GPU/NPU/XPU/MLX 多硬件后端
│   ├── model_loader/       # 模型权重加载
│   └── configs/ lora/ constrained/ ...  # 配置/LoRA/结构化输出等
├── lang/                   # 前端 DSL（结构化生成，已弱化）
├── cli/                    # sglang serve/killall/generate 命令行
├── kernels/                # Python 侧算子
└── multimodal_gen/         # 多模态生成
# 顶层
├── sgl-kernel/             # CUDA C++ 算子库
├── rust/                   # Rust gRPC server 组件（sglang-server/grpc/mm）
├── sgl-model-gateway/      # Rust 模型网关
├── docker/ docs/ benchmark/ test/ scripts/
```

`models/`（152k 行）与 `layers/`（138k 行）体量最大，但它们是"宽"目录——每模型/每层一个实现文件，架构密度低；架构密度集中在 `managers/`、`model_executor/`、`mem_cache/`、`speculative/`、`entrypoints/` 五个核心模块（见模块地图与各模块文档）。

---

## 模块地图

![模块依赖关系图](/vibe-reading/images/articles/sglang-internals/module-dependencies.svg)

模块间依赖沿请求流方向：`entrypoints`（接口层）经 ZMQ IPC 接入 `managers`（编排层），`managers` 调 `model_executor`（执行层）做 forward，`model_executor` 读写 `mem_cache`（缓存层）的 KV；`speculative`（推测解码）作为横切优化，由 `managers` 的 Scheduler 驱动、复用 `model_executor` 的 verify forward 与 `mem_cache` 的 draft KV。`model_executor` 向下调用 `models/`+`layers/` 的模型实现，底层落到 `sgl-kernel` 的 CUDA op 与 `hardware_backend`。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 | 参与的业务链路 |
|------|------|----------|------------|----------|--------------|
| 接口层 entrypoints | API 接入与进程装配 | `Engine.__init__`、`http_server.launch_server` | 隔离外部协议，装配三进程 | [01-entrypoints](./01-entrypoints) | 请求接入、启动流程 |
| 编排层 managers | 调度、批处理、tokenize/detokenize、DP 路由 | `Scheduler.event_loop`、`TokenizerManager.generate_request` | 持有调度状态机与 KV cache，是运行时大脑 | [02-managers](./02-managers) | 全部链路 |
| 执行层 model_executor | forward 装配与执行、CUDA graph、采样 | `ModelRunner.forward`、`ForwardBatch.init_new` | 封装"一次 forward 的全部张量与分发" | [03-model-executor](./03-model-executor) | forward、verify、sample |
| 缓存层 mem_cache | RadixAttention KV 物理池与逻辑前缀共享 | `RadixCache.match_prefix`/`insert`、`KVCache.set_kv_buffer` | 把跨请求 KV 复用做成可缓存一等公民 | [04-mem-cache](./04-mem-cache) | 前缀匹配、slot 分配、evict |
| 推测解码 speculative | draft 生成 + verify 接受 | `BaseSpecWorker.forward_batch_generation` | 算法多样但 verify 骨架统一，注册表式扩展 | [05-speculative](./05-speculative) | draft→verify→accept |

---

## 运行时行为

### 启动流程

![启动流程](/vibe-reading/images/articles/sglang-internals/startup-flow.svg)

启动是一次"进程装配"。`sglang serve`（`cli/serve.py`）解析 `ServerArgs`，调 `http_server.launch_server`（`entrypoints/http_server.py`），它复用 `Engine._launch_subprocesses`（`engine.py:1036`）装配三个组件：

1. **`PortArgs.init_new`** 分配四组 ZMQ ipc name（tokenizer/scheduler_input/detokenizer/rpc），单节点用 `ipc://` Unix socket，多节点用 `tcp://`。
2. **Scheduler 子进程**：`mp.Process(target=run_scheduler_process)`，每 TP rank 一个；DP>1 时先起 `DataParallelController` 再 fan-out。子进程内 `load_model` → `kv_cache_builder.build_kv_cache` → `init_cuda_graphs`，完成后经 `mp.Pipe` 回送 `{"status":"ready"}`。
3. **DetokenizerManager 子进程**：`mp.Process(target=run_detokenizer_process)`，worker_num>1 时起 N 个 + 一个 MultiDetokenizerRouter。
4. **TokenizerManager**：在主进程内 `init_tokenizer_manager` 直接实例化，初始化 ZMQ sockets，asyncio 事件循环。
5. `wait_for_ready()` 等所有子进程就绪，`SubprocessWatchdog` 监控存活，最后启动 FastAPI（HTTP 模式）或暴露 `generate()`（Python API 模式）。

**对象装配要点**：配置来自 `ServerArgs`（命令行 + 文件）；Scheduler 持有 `tree_cache`（由 `kv_cache_builder` 经 `KVCacheConfigurator` 探测显存后构建）与 `tp_worker`（持有 `ModelRunner`，`ModelRunner` 持有 `model: nn.Module`）；依赖通过手动 new + 工厂方法注入（`init_tokenizer_manager_func`/`run_scheduler_process_func` 可被子类覆盖以换 Ray 后端）。

### 核心运行流程

下面三条链路覆盖 SGLang 的主要运行模式：流式生成（请求主链路）、调度循环（continuous batching + overlap）、推测解码（draft→verify→accept）。每条链路的动态调用顺序与模块表里的"参与业务链路"一一对应。

#### 链路一：交互式流式生成（请求主链路）

业务流程：用户发 `/v1/chat/completions` → tokenize → 调度组批 → GPU forward + 采样 → detokenize → 流式回吐。

![请求数据流](/vibe-reading/images/articles/sglang-internals/data-flow.svg)

文字描述：HTTP handler（`http_server.openai_v1_chat_completions`）经 OpenAI serving 转成 `GenerateReqInput`，交主进程的 `TokenizerManager.generate_request`（`tokenizer_manager.py:754`）。它先 `_tokenize_one_request` 把 text→`input_ids`，再 `_dispatch_to_scheduler` 用 `sock_send` 经 **ZMQ PUSH** 把 `TokenizedGenerateReqInput` 发往 Scheduler 子进程；同时 `_wait_one_response` 起 async generator，靠 `asyncio.Event` 等待。

Scheduler（`scheduler.py:1684` `event_loop`）`request_receiver.recv_requests` 收到请求 → `process_input_requests` 入 `waiting_queue` → `get_next_batch_to_run` 用 `SchedulePolicy.calc_priority` 排序 + `PrefillAdder` 按 KV 预算准入，组 `ScheduleBatch` → `run_batch` 调 `TpModelWorker.forward_batch_generation`：先 `ForwardBatch.init_new` 把 CPU 侧 ScheduleBatch 展开成 GPU 张量，再 `ModelRunner.forward` 走 embed→attention→MLP→norm→lm_head→logits，最后 `ModelRunner.sample` 采样得 `next_token_ids`。结果经 `process_batch_result` → `output_streamer.stream_output`，以 `BatchTokenIDOutput` 经 **ZMQ PUSH** 发往 DetokenizerManager。

DetokenizerManager（`detokenizer_manager.py:166`）`event_loop` 收到 token id 批，`handle_batch_token_id_out` 做增量 `tokenizer.batch_decode` 并 `trim_matched_stop`，产出 `BatchStrOutput` 经 **ZMQ PUSH** 回主进程。`TokenizerManager.handle_loop`（asyncio task）`_handle_batch_output` 把结果存入 `state.out_list` 并 `state.event.set()`，唤醒 `_wait_one_response` yield 给上层，转为 OpenAI SSE chunk 推给客户端。整条链路的数据结构演化：`RawRequest → GenerateReqInput → TokenizedGenerateReqInput → Req → ScheduleBatch → ForwardBatch → LogitsProcessorOutput → next_token_ids → BatchTokenIDOutput → BatchStrOutput → SSE`。关键设计是三进程 ZMQ 解耦——Scheduler 独占 GPU、Tokenizer/Detokenizer 各司 I/O，互不阻塞。

#### 链路二：调度循环（continuous batching + overlap）

业务流程：多请求并发下，Scheduler 持续把 waiting 合入 running、prefill 与 decode 交替、CPU 调度与 GPU forward 重叠。

![调度循环](/vibe-reading/images/articles/sglang-internals/scheduling-loop.svg)

文字描述：`event_loop_overlap`（`scheduler.py:1719`）每轮：`recv_requests` 收新请求入队 → `get_next_batch_to_run` 决定本批（`SchedulePolicy` 排序 + `PrefillAdder` 按 `rem_total_tokens`/`rem_chunk_tokens` 预算准入）→ `run_batch` 启动 GPU forward（非阻塞）→ `batch.copy()` 浅拷贝后连同结果入 `result_queue` **延迟一步** → 紧接着 `process_batch_result` 处理**上一轮**的结果（output_streamer→ZMQ），与当前 GPU 计算并行。`disable_overlap` 在连续两个 prefill 或 grammar sync 时生效，退回串行。continuous batching 的核心在 `get_next_batch_to_run`：若上一批是 prefill，其请求经 `filter_batch`+`merge_batch` 并入 `running_batch`（decode），`mix_with_running` 让 decode 请求以 1-token extend 混入 prefill batch（MIXED 模式）；大请求走 chunked prefill（`self.chunked_req` 跟踪）。OOM 时 `retract_decode` 把请求逐出并从 radix cache evict。

#### 链路三：推测解码（draft → verify → accept）

业务流程：主模型解码时，spec worker 先用 draft 模型/n-gram 生成候选 token 树，主模型一次 forward 验证全部候选，按树形接受/拒绝，接受的多 token 一次性产出。

文字描述：`Scheduler.maybe_init_draft_worker`（`scheduler.py:904`）经 `SpeculativeAlgorithm.create_worker` 选 Worker（EAGLE/DFlash/NGRAM/FrozenKVMTP）。`run_batch` 调 `model_worker.forward_batch_generation`（即 spec worker 的入口）。以 EAGLE 为例（`eagle_worker_v2.py`）：decode 路径先 `draft_worker.draft` 多步自回归生成候选 token 树（CUDA graph 重放加速）→ `build_tree_kernel_efficient`（`eagle_utils.py:144`）构造 tree attention mask + `retrieve_index` 索引 → `verify` 调 `target_worker.forward_batch_generation(is_verify=True)` 一次 forward 验证所有 draft token → `eagle_sample` 树形贪心/sampling 得 accept 长度 → `move_accept_tokens_to_target_kvcache` 同步 KV → `draft_extend_for_decode` 用 verify 的 hidden states 更新 draft KV。spec_v2 的 `on_publish`（`FutureMap.publish`）回调让 verify 与下一轮 prep 重叠。详见 [05-speculative](./05-speculative)。

### 状态流

请求 `Req` 有两段式完成状态：`active → to_finish → finished_reason`。`to_finish` 是中间态——overlap 调度中一个请求可能在结果处理阶段被标记完成，但 forward 结果还在 `result_queue`，不能立即移除；待 `process_batch_result` 处理后才置 `finished_reason`，再由 `filter_batch` 移出 running_batch。`finished_reason` 取值 `None / "stop" / "length" / "abort" / "connection_close"`。`abort` 由客户端断连触发（`abort_request`→ZMQ→Scheduler 移除→Detokenizer 回 `finish_reason={"type":"abort"}`）。Scheduler 侧另有 running/waiting/queued 三类超时自动 abort（`_abort_on_running_timeout` 等），队列满直接 503。

---

## 典型修改场景

#### 场景 1：新增一个推测解码算法

需改 `speculative/spec_registry.py` 用 `@SpeculativeAlgorithm.register("MY_SPEC")` 注册 factory；新建 `MySpecWorker(BaseSpecWorker)` 实现 `forward_batch_generation`，有 draft model 则再建 `MyDraftWorker(EagleDraftWorkerBase)` 实现 `draft`/`draft_extend`；在 `spec_info.py` 的 `SpecInputType` 加新类型与对应 `SpecInput` 子类；如需接入内置 dispatch 分支，覆盖 `is_*()` 谓词。参考 `frozen_kv_mtp_worker_v2.py`（继承 EAGLEWorkerV2 只换 draft worker）。对应测试：`test/srt/test_specinfer.py`。

#### 场景 2：新增调度策略

需改 `schedule_policy.py`：`CacheAwarePolicy` 枚举加成员 + `calc_priority`（`:232`）加分支 + 新增 `_sort_by_*` 静态方法；`server_args.py` 的 `schedule_policy` 合法值扩展。`Scheduler.__init__` 自动支持，无需改 event loop。`PrefillAdder`（准入控制）与策略无关，也不需改。对应测试：`test/srt/test_srt_schedule_policy.py`。

#### 场景 3：换 KV cache evict 策略

需改 `mem_cache/evict_policy.py`：新增 `EvictionStrategy` 子类实现 `get_priority(node)`；`utils.py:55` 的 `_EVICTION_POLICY_FACTORIES` 注册。`RadixCache.evict()` 只调 `eviction_strategy.get_priority`，无需改 cache 本体。用户经 `--radix-eviction-policy` 启用。对应测试：`test/srt/test_srt_kv_cache.py`。

扩展点的契约定义见上文「核心概念 > 核心抽象」。

---

## 测试体系

```
test/
├── srt/              # 运行时核心测试（调度、KV cache、spec、模型）
├── kernels/          # 算子测试
├── ci/               # CI 脚本
├── ascend/ xpu/      # 硬件后端测试
├── kv_canary/        # KV cache 完整性巡检
├── observability/    # 可观测性
├── registered/       # 注册模型测试
├── manual/           # 手动/集成测试
└── run_suite.py      # 测试套件编排
```

| 代码层 | 测试类型 |
|--------|----------|
| managers（调度/IPC） | `test/srt/` 单元 + `manual/` 集成 |
| model_executor（forward/graph） | `test/srt/` + `test/kernels/` |
| mem_cache | `test/srt/test_srt_kv_cache.py` + `kv_canary/` |
| speculative | `test/srt/test_specinfer.py` |
| models | `test/srt/models/`（每模型一组） |

`kv_canary/` 是 SGLang 特色——对 KV cache 完整性做运行时巡检，是理解 cache 实现时的可执行参考。

---

## 阅读源码推荐路线

- 第一遍：理解请求主链路
  `cli/serve.py` → `entrypoints/http_server.py::launch_server` → `entrypoints/engine.py::_launch_subprocesses` → `managers/tokenizer_manager.py::generate_request`（`:754`）→ `managers/scheduler.py::event_loop_normal`（`:1684`）→ `managers/tp_worker.py::forward_batch_generation`（`:561`）
- 第二遍：理解调度与数据结构
  `managers/schedule_batch.py::ScheduleBatch.init_new`（`:2164`）与 `prepare_for_extend`/`prepare_for_decode` → `managers/schedule_policy.py::PrefillAdder`（`:490`）→ `managers/scheduler.py::event_loop_overlap`（`:1719`，看 `result_queue` 双流）
- 第三遍：理解执行与 KV
  `model_executor/forward_batch_info.py::ForwardBatch`（`:412`）→ `model_executor/model_runner.py::_forward_raw`（`:1593`）→ `model_executor/forward_context.py`（全局上下文）→ `mem_cache/radix_cache.py`（`match_prefix`/`insert`/`evict`）→ `mem_cache/memory_pool.py`（`KVCache`/`set_kv_buffer`）
- 第四遍：理解扩展与优化
  `speculative/spec_registry.py` + `base_spec_worker.py`（扩展点）→ `speculative/eagle_worker_v2.py` + `eagle_utils.py::build_tree_kernel_efficient`（`:144`）→ `model_executor/runner/decode_cuda_graph_runner.py`（分桶）→ 选一个模型实现 `models/llama.py` 看 `forward`

---

## 附录

**术语表**：

- **RadixAttention**：用 radix tree 组织 KV cache，使任意长度的公共前缀自动共享一份 KV，SGLang 的招牌前缀缓存机制。
- **continuous batching**：prefill 与 decode 请求在同一 batch 中交替执行，每步都可插入/移除请求，而非等整批完成。
- **overlap 调度**：CPU 调度逻辑与上一轮 GPU forward 并行执行，靠 `result_queue` 延迟一步处理结果实现。
- **PD 分离**（Prefill-Decode Disaggregation）：把 prefill 与 decode 部署到不同实例，分别优化吞吐与延迟。
- **spec_v2**：统一所有推测算法的 overlap 骨架，verify 与 draft_extend 可重叠。
- **ForwardBatch**：一次 forward 的全部输入张量打包成的 dataclass，是 ScheduleBatch（CPU 侧）到 GPU 侧的桥。

**参考资料**：

- [SGLang 官方文档](https://docs.sglang.io/)
- [SGLang 发布博客合集](https://lmsys.org/blog/)（v0.2~v0.4、GB200/GB300、推测解码 DFlash/Spec V2）
- RadixAttention 原始论文与 [v0.4 零开销调度器博客](https://lmsys.org/blog/2024-12-04-sglang-v0-4/)
- SGLang 致谢项目：[vLLM](https://github.com/vllm-project/vllm)、[FlashInfer](https://github.com/flashinfer-ai/flashinfer)、[Outlines](https://github.com/outlines-dev/outlines)、LightLLM、LMQL、Guidance
