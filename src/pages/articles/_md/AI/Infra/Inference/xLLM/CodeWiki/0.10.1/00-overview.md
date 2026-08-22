---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "Overview"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "C++", "LLM 推理", "国产加速器", "PD 分离", "KV Cache"]
description: "xLLM 是京东开源的高效 LLM 推理框架，专为国产 AI 加速器优化，采用服务-引擎解耦架构。本文全面解读 v0.10.1 的分层架构、调度器、执行运行时与核心数据结构。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.10.1 · **协议** Apache-2.0 · **语言** C++20 / Python ≥ 3.10 · **代码量** ~37 万行（C++ ~357k + Python ~11.5k + Proto ~2.9k）· **仓库** [GitHub](https://github.com/jd-opensource/xllm)

---

## 总览

### 项目简介

**xLLM** 是京东（JD.com）开源的**高效大语言模型推理框架**，专为**国产 AI 加速器**（华为昇腾 NPU、寒武纪 MLU、海光 DCU、摩尔线程 MUSA、芯擎 ILU 等）做深度优化，支撑企业级生产部署。它已在京东核心零售业务（智能客服、风控、供应链优化、广告推荐等）全面落地。

xLLM 的核心设计理念是**服务-引擎解耦**（service-engine decoupled）：服务层负责请求调度、动态 PD 分离、多模态 EPD 容错；引擎层负责多流并行计算、图融合优化、推测解码、动态负载均衡与全局 KV Cache 管理。两层通过 `Engine::step(batch)` 这一单一接口衔接，职责边界清晰——服务层决定"何时算、算哪些请求"，引擎层决定"怎么算得快"。

框架已支持 DeepSeek-V3.1/V4、Qwen2/3、GLM-4.5/4.6/5 等主流大模型在国产加速器上的高效部署，并提供 OpenAI 兼容 API 与 Anthropic 兼容 API。**项目边界**：xLLM 是推理服务框架，不负责模型训练；权重需外部训练后加载。

### 功能矩阵

| 特性 | 实现目录 | 说明 |
| --- | --- | --- |
| OpenAI/Anthropic 兼容 API | `api_service/` | Chat/Completion/Embed/ImageGen/AudioGen/VideoGen/Rerank |
| 连续批处理调度 | `core/scheduler/` | ContinuousScheduler + ChunkedPrefill |
| PD 分离（Prefill-Decode Disaggregation） | `core/scheduler/disagg_pd_*` | 跨实例 KV 传递，弹性 P/D 分离 |
| 推测解码（Speculative Decoding） | `core/distributed_runtime/speculative_engine` | MTP / Suffix 算法 |
| 全局 KV Cache 管理 | `core/framework/kv_cache_transfer/` | 基于 Mooncake 的层级缓存卸载与预取 |
| 图融合优化 | `core/runtime/*graph_executor*` | CUDA Graph / ACL Graph 多图缓存 |
| 多流并行 | `core/layers/` + `core/kernels/` | 计算与通信重叠 |
| MoE 动态负载均衡 | `core/framework/eplb/` | EPLB 专家重映射 |
| xTensor 内存管理 | `core/framework/xtensor/` | 离散物理页→连续虚拟内存映射 |
| 多模态处理 | `processors/` | 图像/视频/音频 pre-processing |
| 工具调用解析 | `function_call/` | DeepSeek/GLM/Qwen 等格式检测 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++20 | 核心 | 引擎与运行时主体语言 |
| Python 3.10+ | 核心 | 启动器、pybind 高层 API |
| LibTorch (PyTorch C++) | 核心 | 张量运算与 autograd 图 |
| brpc + protobuf | 核心 | RPC 通信与序列化（服务层与分布式） |
| gflags/glog/folly | 核心 | 命令行解析、日志、异步框架 |
| pybind11 | 核心 | Python↔C++ 绑定 |
| Mooncake | 可选 | 全局 KV Cache 存储引擎 |
| CANN (Ascend) | 可选 | NPU 算子库与驱动 |
| FlashInfer | 可选 | CUDA Attention 算子 |

### 版本历史

xLLM 由京东推理团队开发，2025-10 在 arXiv 发布[技术报告](https://arxiv.org/abs/2510.14686)。v0.10.1 是当前稳定版本（2026-07），主要演进脉络：早期聚焦昇腾 NPU 推理 → 引入服务-引擎解耦与连续批处理 → 加入 PD 分离与推测解码 → v0.10 系列集成 Mooncake 全局 KV Cache、xTensor 内存管理、多模态 DiT 支持，并 day-0 支持 DeepSeek-V4 与 GLM-5。

---

## 快速上手

xLLM 以预构建 Docker 镜像分发，最简启动方式如下（以昇腾 NPU 为例）：

```bash title="拉取镜像并启动容器"
docker pull quay.io/jd_xllm/xllm-ai:xllm-dev-a2-x86-cann9-20260605
docker run -it --ipc=host --privileged --network=host \
  --device=/dev/davinci0 --device=/dev/davinci_manager \
  -v /usr/local/Ascend/driver:/usr/local/Ascend/driver \
  quay.io/jd_xllm/xllm-ai:xllm-dev-a2-x86-cann9-20260605 /bin/bash
```

```bash title="启动推理服务"
xllm --model /path/to/qwen3 --devices npu:0 \
  --host 0.0.0.0 --port 8000
```

启动后即可用 OpenAI 兼容 API 发起请求验证：

```bash title="端到端验证"
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3","messages":[{"role":"user","content":"你好"}]}'
```

> 内部启动细节（配置加载、Master/Engine 装配）见「运行时行为 > 启动流程」。

---

## 架构设计解析

### 系统架构

xLLM 采用**纵向分层 + 服务-引擎解耦**的架构思想。这样设计的动机是：推理服务的瓶颈同时存在于调度层（请求并发、显存碎片、PD 资源不均）与算子层（通信气泡、访存瓶颈），将两者解耦后可各自独立演进——调度策略变更不影响算子优化，硬件后端替换不波及服务逻辑。`Engine::step(batch)` 是两层之间的唯一契约：上层把"要算什么"打包成 `Batch`，下层返回 `ForwardOutput`，数据流单向流动，无反向依赖。

![xLLM 分层架构](/vibe-reading/images/articles/xllm/architecture.svg)

系统自顶向下分六层。**服务接口层**通过 brpc/HTTP 暴露 OpenAI 与 Anthropic 兼容 API，将外部请求转化为统一的 `RequestParams`；**主从编排层**的 `Master` 持有 `Engine` 与 `Scheduler`，在循环线程中驱动 `scheduler->step()`，多节点时由 `DistManager` 协调 worker 通信；**调度层**将待处理请求组织为 `Batch`（prefill/decode 混合），决定每步执行内容；**执行运行时层**的 `Worker`（每设备一个）与 `Executor` 完成单步前向；**框架核心层**提供 `Batch`/`Sequence`/`KVCache`/`Block`/`Sampler` 等贯穿全栈的数据结构；**模型与算子层**包含 `CausalLM` 模型定义、`layers` 层实现与 `kernels` 硬件算子。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 服务接口层 | `api_service/` `server/` `c_api/` `cc_api/` `pybind/` | 隔离外部协议（HTTP/brpc/C/Python），保护引擎不受接口变化影响 |
| 主从编排层 | `core/distributed_runtime/` | 编排多 worker 协作，抽象 Master/Engine 双角色，屏蔽分布式细节 |
| 调度层 | `core/scheduler/` | 决定"何时算、算哪些请求"，管理显存配额与请求生命周期 |
| 执行运行时层 | `core/runtime/` | 单设备执行封装，图执行器策略，worker 异步调度 |
| 框架核心层 | `core/framework/` | 承载批处理、KV Cache、块管理、采样等贯穿全栈的核心数据结构 |
| 模型与算子层 | `models/` `core/layers/` `core/kernels/` | 模型架构定义 + 层实现 + 硬件算子，多后端可切换 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 + 类型擦除 | `CausalLMImpl<Model>` in `framework/model/causal_lm.h` | 编译期绑定具体模型，运行期通过 `CausalLM*` 虚接口统一调度，兼顾性能与扩展 |
| 工厂方法 | `create_master()` / `create_continuous_scheduler()` in `distributed_runtime/master.cpp` `scheduler/scheduler_factory.cpp` | 按后端/配置产出正确的 Master/Engine/Scheduler 子类，隔离创建逻辑 |
| 注册表 + 宏注册 | `ModelRegistry` + `REGISTER_CAUSAL_MODEL` in `models/model_registry.h` | 模型按名注册，运行时按 `model_type` 查表创建，新增模型零侵入 |
| 策略模式 | 调度器族（Continuous/DisaggPD/PDOOC/ChunkedPrefill…） | 同一 `Scheduler` 接口，按部署形态切换批处理策略 |
| 代理/远程 | `WorkerClient` → `Worker`(本地) / `RemoteWorker`(远程) in `core/runtime/worker_client.h` | 统一本地与多节点 worker 的访问代码，Engine 无感知 |
| 生产者-消费者 | `step_with_schedule_overlap()` in `scheduler/continuous_scheduler.cpp` | 调度与执行重叠，当前步调度下一步执行，消除流水线气泡 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Master` | 编排者，持有 Engine + Scheduler，驱动 step 循环 | 进程级单例 | 聚合 Engine、Scheduler、ChatTemplate |
| `Engine` | 执行抽象，`step(batch)→ForwardOutput` | Master 持有 | 持有 WorkerClient 列表、KVCacheManager |
| `Scheduler` | 调度抽象，`add_request`/`step`/`generate` | Master 持有 | 持有 RequestPriorityQueue、引用 Engine |
| `Worker` | 单设备执行单元 | Engine 创建，每设备一个 | 持有 Executor、模型、KVCache |
| `Batch` | 一批 Sequence 的执行单元 | 每 step 创建 | 包含 Sequence 列表 |
| `Sequence` | 单条请求的生成状态机 | Request 内，可被中断/重排 | 持有 tokens、KVCacheState、Block |
| `Request` | 用户请求，含多条 Sequence | 从接收到完成 | 持有 RequestState、callback |
| `KVCache` | 每层 K/V 张量抽象 | Worker 分配 | 由 BlockManager 管理物理块 |
| `Block` | KV Cache 物理块句柄（引用计数） | Sequence 持有 | 由 BlockManager 分配/释放 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `CausalLM` | `framework/model/causal_lm.h` | `CausalLMImpl<Model>` + 各模型类 | `REGISTER_CAUSAL_MODEL` 宏 |
| `Scheduler` / `SchedulerBase` | `scheduler/scheduler.h` | ContinuousScheduler 等 8 种 | `create_continuous_scheduler` 工厂 |
| `Engine` | `distributed_runtime/engine.h` | LLMEngine/VLMEngine/DiTEngine/SpeculativeEngine | `create_master` 内构造 |
| `Master` | `distributed_runtime/master.h` | LLMMaster/VLMMaster/DiTMaster/RecMaster | `create_master` 工厂 |
| `ExecutorImpl` | `runtime/executor_impl.h` | CudaGraphExecutorImpl/AclGraphExecutorImpl 等 | WorkerImpl 内按后端构造 |
| `WorkerClient` | `runtime/worker_client.h` | Worker(本地)/RemoteWorker(远程) | Engine 在 setup_workers 创建 |

---

## 代码目录

```text
xllm/
├── xllm.cpp                 # 主二进制入口（gflags→初始化配置→create_master→APIService）
├── api_service/             # HTTP/brpc 服务实现（OpenAI/Anthropic 兼容）
├── server/                  # HttpServer 注册与生命周期
├── c_api/ cc_api/           # C / C++ 编程接口
├── pybind/                  # Python 绑定（bind.cpp + llm.py 等）
├── proto/                   # protobuf 通信协议定义
├── core/
│   ├── common/             # Options/Types/Macros 等基础设施
│   ├── distributed_runtime/ # Master/Engine 多节点编排与 PD 服务
│   ├── scheduler/          # 连续批处理/PD 分离/分块预填等调度器
│   ├── runtime/            # Worker/Executor/GraphExecutor 单设备执行
│   ├── framework/          # batch/kv_cache/block/request/sampling/tokenizer 核心数据结构
│   ├── layers/             # 模型层（attention/mlp/norm）+ 各硬件后端
│   ├── kernels/            # 算子内核（PageAttention/AllReduce 等）按硬件分目录
│   ├── platform/           # 设备名解析与平台适配
│   └── util/              # 线程池/网络/工具函数
├── models/                 # 模型定义（llm/vlm/dit/rec）
├── processors/             # 多模态 pre-processing（图像/视频/音频）
├── function_call/          # 工具调用格式检测与解析
├── parser/                 # 推理内容解析（reasoning parser）
└── tests/                  # 测试
```

---

## 模块地图

xLLM 按职责分化为 9 个模块，模块间依赖关系如下：

![模块依赖关系](/vibe-reading/images/articles/xllm/module-dependencies.svg)

依赖方向总体自顶向下：服务接口层 → 主从编排层 → 调度层/引擎 → 执行运行时 → 框架核心 + 模型与算子层。`框架核心` 被 scheduler/runtime/layers 共同依赖，是全栈的共享数据结构层；`模型与算子层` 处于依赖链底端，被 runtime 调用。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 服务接口层 | 对外暴露 HTTP/brpc/C/Python API | `APIService` in `api_service/api_service.h` | 隔离协议变化，保护引擎 | [服务接口层](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/01-service-layer) |
| 分布式主从运行时 | Master/Engine 编排与多节点协调 | `Master::run()` in `distributed_runtime/llm_master.cpp` | 调度与执行的编排枢纽，屏蔽分布式 | [分布式主从运行时](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/02-distributed-runtime) |
| 请求调度器 | 批处理组织与请求生命周期 | `ContinuousScheduler::step()` in `scheduler/continuous_scheduler.cpp` | 决定"算哪些请求"，策略多变 | [请求调度器](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/03-scheduler) |
| 执行运行时 | 单设备前向执行与图策略 | `Worker::step()` in `runtime/worker.h` | 封装设备级执行，隔离图优化 | [执行运行时](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/04-execution-runtime) |
| 框架核心 | Batch/Sequence/KVCache/Block/Sampler | `Batch` in `framework/batch/batch.h` | 贯穿全栈的共享数据结构 | [框架核心](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/05-framework-core) |
| 模型层 | Attention/MLP/Norm 层实现 + 硬件后端 | `LlmModelImplBase` in `models/llm/llm_model_base.h` | 多硬件后端的抽象边界 | [模型层](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/06-model-layers) |
| 算子内核 | PageAttention/AllReduce 等底层算子 | `core/kernels/{npu,cuda,...}/` | 硬件级算子适配，与层解耦 | [算子内核](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/07-kernels) |
| 模型定义 | LLM/VLM/DiT/Rec 模型架构 | `models/model_registry.h` | 按模型族组织，注册表扩展 | [模型定义](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/08-model-definitions) |
| 多模态与工具调用 | 多模态预处理与工具调用解析 | `processors/` + `function_call/` | 与模型推理正交的前后处理 | [多模态与工具调用](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/09-multimodal-functioncall) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

进程入口在 `xllm.cpp` 的 `main()`，启动调用链如下：

```text
main() in xllm.cpp
├── google::ParseCommandLineFlags  # gflags 解析
├── initialize_configs()            # 注册 17 个 Config 单例（ModelConfig/KVCacheConfig/SchedulerConfig...）
└── run() in xllm.cpp
    ├── get_model_backend()         # 从 model 路径推断后端（llm/vlm/dit）
    ├── validate_config()           # 校验配置合法性（如 NPU 限制 block_size=16）
    ├── create_options()            # 从各 Config 组装 Options 对象（建造者模式链式赋值）
    ├── create_master(backend, options) in distributed_runtime/master.cpp
    │   └── new LLMMaster(options)  # 按 backend 选 LLM/VLM/DiT/Rec Master
    ├── master->run() in llm_master.cpp
    │   ├── engine_->init()         # Engine 初始化（setup_workers + init_model + allocate_kv_cache）
    │   ├── create_continuous_scheduler(engine, options)  # 选调度器策略
    │   └── loop_thread: while(!stoped) scheduler_->step(500ms)  # 调度循环
    └── APIService(master, model_names) + ServerRegistry::register_server("HttpServer")->start()
        # 启动 brpc HTTP 服务，开始接收请求
```

**对象装配**：配置来自 gflags 命令行（优先级最高），`initialize_configs()` 将 17 个 `XxxConfig` 单例注册到全局，`create_options()` 用建造者模式把各 Config 字段汇入 `Options`。`Master` 构造时先 `engine_->init()`（内部 `setup_workers` 创建本地 `Worker`/远程 `RemoteWorker`，`init_model` 加载权重，`allocate_kv_cache` 分配缓存），再 `create_continuous_scheduler` 按配置选择调度策略。最终 `APIService` 持有 `Master*`，HTTP 请求经由 `APIService` 转发到 `Master::handle_request`。

### 核心运行流程

xLLM 有三条核心业务链路：**在线连续批处理**（默认）、**PD 分离推理**（弹性扩缩容）、**离线批量生成**（评测/数据合成）。三者共享 Engine/Worker 执行路径，差异在调度层。

#### 在线服务：连续批处理主链路

用户经 HTTP 发起 Chat 请求后，数据流贯穿服务→编排→调度→执行→模型各层：

![请求处理数据流](/vibe-reading/images/articles/xllm/data-flow.svg)

数据流解读：`APIService::ChatCompletionsHttp` 解析 HTTP body 为 `ChatRequest`，转交 `LLMMaster::handle_request`；Master 在 threadpool 中 tokenize prompt（`tokenizer_->encode`）、组装 `RequestState`/`Request` 并 `scheduler_->add_request` 入优先队列。调度循环线程 `scheduler->step()` 从队列取请求构建 `Batch`（prefill 与 decode 混合），调 `engine_->step(batch)`。Engine 的 `prepare_inputs` 生成 `ForwardInput`，分发到各 `WorkerClient`（本地走 `Worker::step_async`，远程走 `RemoteWorker` RPC）；Worker 内 `Executor::forward` 调 `CausalLM::forward` 逐层前向（每层更新 `KVCache`），输出 `ModelOutput`（hidden_states）。经 `Sampler` 采样得 token，`process_batch_output` 写回 `Sequence`，通过 callback 流式返回 HTTP 响应。关键设计：`enable_schedule_overlap` 时采用生产者-消费者模式，当前步执行时下一步已调度，`update_last_step_result` 衔接两步。

#### 弹性扩缩容：PD 分离链路

当 `enable_disagg_pd=true` 时，Prefill 实例与 Decode 实例分离部署：Prefill 实例完成预填后将 KV Cache 通过 `transfer_kv_blocks` 传到 Decode 实例（基于 Mooncake 或直接 RDMA），Decode 实例接收后 `allocate_kv_cache_with_transfer_async` 装载。`DisaggPDScheduler` 协调两端的请求交接。`PDOOCScheduler`（Out-of-Capacity）进一步在显存不足时将 decode 请求驱逐到对端。这条链路解决单实例 P/D 资源争抢问题，实现弹性扩缩容。

#### 离线批量：generate 链路

`LLMMaster::generate()` 走 `scheduler_->generate()`，与在线 `step` 不同：它是一个 while 循环，阻塞直到 `pending_requests` 耗尽且队列空，适用于离线评测与数据合成。内部仍调 `engine_->step` + `process_batch_output`，但不做 HTTP 流式回调，结果通过 `RequestOutput` 批量返回。

### 状态流

xLLM 运行时有两组核心状态：**Sequence 阶段状态机**（单条请求的生成生命周期）与 **Master 状态**（实例级的休眠/唤醒）。

![运行时状态流](/vibe-reading/images/articles/xllm/state-flow.svg)

**Sequence 阶段**定义于 `framework/request/sequence.h` 的 `SequenceStage` 枚举：`PREFILL`（无 KV cache 全量预填）→ `CHUNKED_PREFILL`（分块预填，已有部分 KV）→ `DECODE`（逐 token 解码，每步自循环）。`stage()` 方法依据 `kv_cache_tokens_num` 与 `num_prompt_tokens` 的比较实时判定。显存不足时序列被 ABORT/中断（释放全部 Block 但保留已生成 token），重排队后以"已生成 token 视为 prompt"重新预填。`FINISH` 在 `StoppingChecker` 命中 EOS/stop/max_tokens 时触发。

**Master 状态**定义于 `common/types.h` 的 `MasterStatus`：`WAKEUP`（正常服务）↔ `SLEEP`（休眠释放显存，支持热扩缩容）。`engine_->sleep()`/`engine_->wakeup()` 在两态间切换。此外为支持异步 RL 训练，`ContinuousScheduler` 增加 `PAUSED` 态——`LLMMaster::pause_scheduler()` 阻塞调度循环，`wait_until_paused()` 确保安全后可更新权重，`resume_scheduler()` 恢复。

---

## 典型修改场景

#### 场景 1：新增一个 LLM 模型支持

- 在 `models/llm/` 新建 `xxx.h`，继承 `LlmModelImplBase<DecoderLayerType>`，实现 `forward` 与 `load_state_dict`
- 在 `models/llm/npu/`（或 cuda/）下定义该模型的 decoder layer（如 `npu_xxx_decoder_layer_impl`）
- 用 `REGISTER_CAUSAL_MODEL(xxx, XxxModel)` 宏注册到 `ModelRegistry`（`models/model_registry.h`）
- 用 `REGISTER_MODEL_ARGS` / `REGISTER_TOKENIZER_ARGS` 注册参数加载器
- 对应测试：`tests/` 下新增模型加载测试

#### 场景 2：新增一种调度策略

- 在 `core/scheduler/` 新建 `xxx_scheduler.h/.cpp`，继承 `ContinuousScheduler`（或直接实现 `Scheduler` 接口）
- 在 `scheduler_factory.cpp` 的 `select_scheduler_kind()` 增加分支，`create_continuous_scheduler` switch 增加对应 `SchedulerKind`
- 在 `common/types.h` 的 `SchedulerKind` 枚举增加成员
- 对应测试：`tests/core/` 下调度器测试

#### 场景 3：新增一种硬件后端

- 在 `core/layers/` 新建后端目录（如 `core/layers/newhw/`），实现 `attention.h`/`linear.h` 等层接口
- 在 `core/kernels/` 新建 `core/kernels/newhw/` 实现算子
- 在 `core/platform/` 增加设备名解析支持（`device_name_utils`）
- 在 CMakeLists 增加编译宏 `USE_NEWHW` 与条件编译分支
- `core/runtime/` 增加 `newhw_graph_executor_impl.h` 图执行器
- 对应测试：CI workflow（`.github/workflows/`）

---

## 测试体系

```text
tests/
├── api_service/      # API 层测试（HTTP 接口、流式）
├── core/            # 核心模块测试（scheduler/kv_cache/block）
└── function_call/   # 工具调用解析测试
```

| 代码层 | 测试类型 |
| --- | --- |
| api_service | 接口集成测试 |
| core/scheduler, core/framework | 单元测试 |
| models, layers, kernels | 硬件 CI（`.github/workflows/` 各后端 workflow） |

> CI 在 `.github/workflows/` 按 NPU/CUDA 等硬件分 workflow 运行，理解某模块时可先看对应测试。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `xllm.cpp` 的 `main()` → `run()` → `core/distributed_runtime/llm_master.cpp` 的 `LLMMaster::run()`（调度循环）→ `LLMMaster::handle_request()`（请求接入）→ `core/scheduler/continuous_scheduler.cpp` 的 `step()`（批处理调度）
- **第二遍：理解执行路径**
  `core/distributed_runtime/llm_engine.h` 的 `LLMEngine::step()` → `core/runtime/worker.h` 的 `Worker::step()` → `core/runtime/executor.h` 的 `Executor::forward()` → `core/framework/model/causal_lm.h` 的 `CausalLM::forward()`（纯虚接口）
- **第三遍：理解核心数据结构**
  `core/framework/request/sequence.h` 的 `Sequence`（阶段状态机）→ `core/framework/batch/batch.h` 的 `Batch` → `core/framework/block/block.h` 的 `Block`（引用计数块）→ `core/framework/kv_cache/kv_cache.h` 的 `KVCache`
- **第四遍：理解扩展机制**
  `models/model_registry.h` 的 `REGISTER_CAUSAL_MODEL` 宏 → `core/scheduler/scheduler_factory.cpp` 的 `create_continuous_scheduler()` → `core/layers/common/attention.h`（按 `USE_NPU`/`USE_CUDA` 条件编译选后端）
- **第五遍：选择重点模块深入阅读**（见下方模块文档）

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| PD 分离 | Prefill-Decode Disaggregation，预填与解码分离到不同实例 |
| EPD | 弹性 PD（Elastic PD）+ 多模态容错机制 |
| MTP | Multi-Token Prediction，推测解码的一种算法 |
| EPLB | Expert-Parallel Load Balancing，MoE 专家动态负载均衡 |
| xTensor | xLLM 的离散物理页→连续虚拟内存映射管理 |
| TTFT / TBT / TPOT | Time To First Token / Time Between Tokens / Time Per Output Token |
| Mooncake | KV Cache 中心化分布式存储引擎（third_party） |

### 参考资料

- [xLLM 技术报告](https://arxiv.org/abs/2510.14686)（arXiv 2510.14686）
- [xLLM 文档站](https://docs.xllm-ai.com/)
- [DeepWiki: jd-opensource/xllm](https://deepwiki.com/jd-opensource/xllm)
