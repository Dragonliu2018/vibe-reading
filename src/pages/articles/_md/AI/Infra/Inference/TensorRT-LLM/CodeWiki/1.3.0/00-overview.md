---
source:
  type: "源码解读"
  project: "TensorRT-LLM"
  url: "https://github.com/NVIDIA/TensorRT-LLM"
title: "Overview"
date: "2026-08-12T12:04:11+08:00"
category: [AI, Infra, Inference, TensorRT-LLM, CodeWiki, "1.3.0"]
tags: ["TensorRT-LLM", "Python", "C++", "CUDA", "LLM 推理", "连续批处理", "投机解码", "PD 分离"]
description: "TensorRT-LLM 是 NVIDIA 的高性能 LLM 推理引擎。本文从双后端架构、PyExecutor 执行引擎、模型/算子/注意力后端到投机解码与 PD 分离，全面解读 v1.3.0 的内部原理。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.3.0rc25（解读基于 main HEAD） · **协议** Apache-2.0 · **语言** Python ≥ 3.10 / C++ / CUDA 13.2.1 · **代码量** Python ~66 万行 / C++CUDA ~74 万行 · **仓库** [GitHub](https://github.com/NVIDIA/TensorRT-LLM)

---

## 总览

### 项目简介

TensorRT-LLM 是 NVIDIA 开源的大语言模型（LLM）与视觉生成模型推理优化引擎。它通过**专用 kernel、高效运行时和可扩展的 Python 框架**三个支柱，把"在 NVIDIA GPU 上高性能跑一个 LLM"这件事工程化——从单卡调试到多节点大规模分布式服务，覆盖 prefill/decode、连续批处理、投机解码、PD 分离、量化等全部主流推理场景。

**核心价值**：推理不是单纯"跑一次 forward"，而是一个可调度、可缓存、可并行、可验证的运行时系统。TensorRT-LLM 把模型定义（`modeling_*.py`）、执行引擎（`PyExecutor`）、注意力后端（TRTLLM/FlashInfer）和 kernel 层分层解耦，让用户能在一个 `LLM.generate()` 调用背后，精确控制调度策略、KV cache 布局、采样参数与并行拓扑。

**核心使用场景**：在线 LLM 服务（OpenAI 兼容 API）、离线批量推理、RL/后训练 rollout 后端、多模态与视觉生成推理。

**项目边界**：负责推理运行时（调度、KV 缓存、批处理、并行、投机解码、服务层）；不负责模型训练。自研 CUDA kernel 聚焦注意力（FMHA/xQA）与 MoE 等推理热点，通用算子依赖 PyTorch / FlashInfer / Cutlass。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|----------|------|
| 高层 LLM API | `llmapi/llm.py` | `LLM` / `AsyncLLM` 统一入口，同步/异步/流式 |
| 请求编排 | `executor/executor.py` | `GenerationExecutor` 抽象，支持单进程/多进程 IPC/Ray |
| Torch 执行引擎 | `_torch/pyexecutor/py_executor.py` | `PyExecutor` 连续批处理主循环 |
| 连续批处理 | `_torch/pyexecutor/scheduler/scheduler_v2.py` | prefill+decode 混合 batch，两阶段调度 |
| Paged KV Cache | `_torch/pyexecutor/kv_cache_manager_v2.py` | 分页块分配、前缀复用、驱逐/挂起、多级缓存 |
| 模型定义 | `_torch/models/modeling_*.py` | 80+ 模型家族，注册表 + 懒加载 |
| 神经网络算子 | `_torch/modules/` | Attention / MLP / MoE / RMSNorm，含融合路径 |
| 注意力后端 | `_torch/attention_backend/` | TRTLLM / FlashInfer / Vanilla 可切换 |
| 投机解码 | `_torch/speculative/` | Eagle3 / MTP / Ngram / PARD / DFlash 等 15+ 算法 |
| PD 分离 | `_torch/disaggregation/` | NIXL RDMA 传输 KV cache，prefill/decode 分离部署 |
| CUDA Graph | `_torch/pyexecutor/cuda_graph_runner.py` | decode 阶段整图捕获重放 |
| 量化 | `quantization/` + modules 融合路径 | FP4 / FP8 / NVFP4 / INT4 AWQ GPTQ |
| OpenAI 服务 | `serve/openai_server.py` | OpenAI 兼容 HTTP API |
| Agent 脚手架 | `scaffolding/` | agentic 负载生成与 trace replay |
| C++ Plugin 后端 | `cpp/tensorrt_llm/` | TRT 插件路径（thop）+ C++ runtime + kernel |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| `torch` | 核心 | 模型实现、autograd、CUDA Stream、torch.compile |
| `flashinfer` | 核心 | 注意力后端、分组采样 kernel |
| `tensorrt` | 核心 | C++ Plugin 后端的图编译与执行 |
| `transformers` | 核心 | HuggingFace 模型 config / tokenizer 加载 |
| `pydantic` | 核心 | `LlmArgs` 配置 schema 校验 |
| `mpi4py` / MPI | 核心 | 多 GPU tensor parallel 通信 |
| `nixl` | 核心 | PD 分离 KV cache RDMA 传输 |
| `cutlass` / `cute_dsl` | 核心 | 融合 GEMM/MoE kernel 生成 |
| `fastapi` / `uvicorn` | 可选 | OpenAI 兼容 HTTP 服务 |
| `ray` | 可选 | Ray 编排分布式 executor |

---

## 快速上手

```bash title="最小推理示例"
pip install tensorrt-llm

# Python API：一行加载模型并生成
python -c "
from tensorrt_llm import LLM, SamplingParams
llm = LLM(model='TinyLlama/TinyLlama-1.1B-Chat-v1.0')
out = llm.generate('Hello, what is AI?', sampling_params=SamplingParams(max_tokens=32))
print(out[0].outputs[0].text)
"
```

```bash title="OpenAI 兼容服务"
trtllm-serve serve TinyLlama/TinyLlama-1.1B-Chat-v1.0
# 预期：启动 OpenAI 兼容 HTTP 服务，curl /v1/chat/completions 可返回生成结果
```

> 上述是用户视角操作。内部从 `LLM.generate()` 到 token 返回经过了 executor → pyexecutor → scheduler → model_engine → model → attention_backend → sampler 的完整链路，详见「运行时行为」。

---

## 架构设计解析

### 系统架构

TensorRT-LLM 的核心架构思想是**分层解耦 + 双后端**。分层让每一层可独立替换（如切换注意力后端不需改模型代码），双后端让用户在 PyTorch 原生路径（Torch 后端，主力开发）和 TensorRT 插件路径（C++ 后端，历史成熟）间选择。依赖方向自上而下：上层依赖下层，下层不反向依赖。

![分层架构](/vibe-reading/images/articles/tensorrt-llm/architecture.svg)

从上到下五层 + 一个横切特性层：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ------ | -------- | ---------------------- |
| 接口层 | `llmapi/` · `serve/` · `commands/` | 隔离外部协议（Python API / HTTP / CLI），让用户无需接触引擎内部 |
| 编排层 | `executor/` | 编排请求生命周期与进程拓扑，把"提交请求"和"执行推理"解耦 |
| 执行引擎层 | `_torch/pyexecutor/` | Torch 后端核心——调度、KV cache、采样、CUDA graph，每 iteration 的主循环 |
| 模型层 | `_torch/models/` | 每个模型家族的 forward 定义与权重加载 |
| 算子层 | `_torch/modules/` | Attention / MLP / MoE 等可组合 NN 算子，封装 TP/CP/量化 |
| 注意力与 Kernel 层 | `_torch/attention_backend/` · `custom_ops/` · `cute_dsl_kernels/` · `cpp/kernels/` | 底层 attention kernel 与 CUDA 算子，跨后端可切换 |
| 横切特性 | `_torch/speculative/` · `_torch/disaggregation/` · `scaffolding/` | 投机解码 / PD 分离 / Agent，hook 进执行引擎而非垂直分层 |

**双后端说明**：`tensorrt_llm/_torch/` 是 Torch 后端（PyTorch 原生，~54 万行 Python），`cpp/tensorrt_llm/` 是 C++ 后端（TRT 插件 + kernel，~74 万行 C++/CUDA）。本文重点解读 Torch 后端——它是 v1.3.0 的主力开发路径，也是 `LLM` API 的默认后端。C++ 后端通过 `tllm.bindings`（nanobind）暴露给 Python，在 `executor/base_worker.py` 的 `setup_engine()` 中按 `backend` 配置切换。

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `BaseLLM.__init__` → `_build_model()` in `llmapi/llm.py:277` | 后端无关的初始化骨架，子类只覆写钩子 |
| 策略 | `get_attention_backend()` in `attention_backend/utils.py:18` | 多注意力后端可切换，配置驱动 |
| 注册表 + 懒加载 | `@register_auto_model` + `_arch_index.py` in `models/` | 80+ 模型按需导入，避免启动时加载全部 |
| 抽象工厂 | `GenerationExecutor.create()` in `executor/executor.py:539` | 按部署拓扑（单进程/IPC/Ray）创建 executor 子类 |
| 生产者-消费者 | `ExecutorRequestQueue` + `response_cv` in `pyexecutor/` | 请求提交与执行解耦，支持并发与 overlap |
| Future/Promise | `GenerationResult` in `executor/result.py:983` | 异步提交、批量等待、流式消费 |
| 委托 | `ConfigurableMoE` 包装 backend in `modules/fused_moe/` | MoE 调度/通信横切逻辑与 kernel 实现分离 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `LlmRequest` | 一次推理请求的运行时表示 | submit→生成完成 | 持有 token、sampling params、KV cache blocks |
| `ScheduledRequests` | 一个 iteration 的调度产出 | 单 iteration | 含 context/generation/paused 四组请求 |
| `AttentionMetadata` | 注意力计算的运行时上下文 | 单 forward | 携带 seq_lens、KV cache page table、spec metadata |
| `KVCacheManagerV2` | 分页 KV cache 分配器 | 引擎级 | 管理 block 分配/驱逐/多级迁移 |
| `GenerationResult` | 请求的 future 对象 | submit→result() | 持有 response queue，支持流式迭代 |
| `SpecMetadata` | 投机解码运行时状态 | 单 forward | 携带 draft_tokens、draft_probs、tree 拓扑 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `AttentionBackend` | `attention_backend/interface.py:995` | `TrtllmAttention` / `FlashInferAttention` / `VanillaAttention` | `get_attention_backend()` 工厂按名映射 |
| `ModelEngine` | `pyexecutor/model_engine.py:148` | `PyTorchModelEngine` | 硬编码（Torch 后端唯一实现） |
| `Sampler` | `pyexecutor/sampler/sampler.py:193` | `TorchSampler` / `EarlyStopSampler` | 按 `Args` 选择 |
| `RequestScheduler` | `pyexecutor/scheduler/scheduler.py` | `KVCacheV2Scheduler` / V1 CapacityScheduler | 版本选择（`get_preferred_kv_cache_manager_version`） |
| `MoE` | `modules/fused_moe/interface.py:224` | `CutlassFusedMoE` / `MarlinFusedMoE` / `TritonFusedMoE` | `get_moe_cls()` 工厂 |
| `SpecWorkerBase` | `speculative/interface.py:1063` | `Eagle3OneModelWorker` / `MTPWorker` / `NgramWorker` 等 | `get_spec_worker()` 工厂 |
| `BaseTransferAgent` | `disaggregation/base/agent.py:93` | `NixlTransferAgent`（C++/Python） | `_create_nixl_agent()` 工厂 |

---

## 代码目录

```shell
TensorRT-LLM/
├── tensorrt_llm/              # Python 框架主体
│   ├── llmapi/                # 高层 LLM/AsyncLLM API（用户入口）
│   ├── executor/              # 请求编排（GenerationExecutor + Worker/Proxy/Ray）
│   ├── serve/                 # OpenAI 兼容服务
│   ├── scaffolding/           # Agent 脚手架与 trace replay
│   ├── _torch/                # Torch 后端（主力）
│   │   ├── pyexecutor/        # 执行引擎（PyExecutor/scheduler/sampler/KV cache）
│   │   ├── models/            # 80+ 模型定义（modeling_*.py）
│   │   ├── modules/           # 神经网络算子（attention/MLP/MoE/norm）
│   │   ├── attention_backend/ # 注意力后端（TRTLLM/FlashInfer/Vanilla）
│   │   ├── custom_ops/        # 自定义 CUDA 算子注册
│   │   ├── cute_dsl_kernels/  # CUTE DSL 生成的融合 kernel
│   │   ├── speculative/       # 投机解码（Eagle3/MTP/Ngram/...）
│   │   ├── disaggregation/    # PD 分离（NIXL KV cache 传输）
│   │   ├── auto_deploy/       # 自动部署与编译
│   │   └── visual_gen/        # 视觉生成（diffusion/video）
│   ├── quantization/          # 量化配置
│   └── inputs/                # 输入数据结构
├── cpp/                       # C++ 后端 + CUDA kernel
│   ├── tensorrt_llm/
│   │   ├── kernels/           # CUDA kernel（FMHA/xQA/...，~37 万行）
│   │   ├── batch_manager/     # C++ 批管理（TRT 后端）
│   │   ├── thop/              # TensorRT 自定义插件算子
│   │   ├── runtime/           # C++ runtime
│   │   └── executor/          # C++ executor
│   └── include/               # C++ 头文件
├── triton_backend/            # Triton Inference Server 后端
└── examples/                  # 使用示例
```

---

## 模块地图

本文聚焦 Torch 后端的 7 个核心模块（C++ 后端作为参考层在概览提及）。模块间的静态依赖关系：上层模块调用下层模块，`pyexecutor` 是依赖枢纽。

![模块依赖关系](/vibe-reading/images/articles/tensorrt-llm/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 高层 API | LLM/AsyncLLM 统一入口 | `llmapi/llm.py` `LLM.generate()` | 隔离用户与引擎，后端可切换 | [llmapi](01-llmapi) |
| 请求编排 | 请求生命周期与进程拓扑 | `executor/executor.py` `GenerationExecutor` | 解耦提交与执行，支持多种部署 | [executor](02-executor) |
| 执行引擎 | 调度/KV cache/采样主循环 | `pyexecutor/py_executor.py` `_executor_loop()` | Torch 后端心脏，每 iteration 的核心 | [pyexecutor](03-pyexecutor) |
| 模型定义 | 80+ 模型 forward 与权重加载 | `models/modeling_auto.py` `AutoModelForCausalLM` | 每模型特化的权重转换，注册表式扩展 | [models](04-models) |
| 神经网络算子 | Attention/MLP/MoE 可组合组件 | `modules/attention.py` `Attention` | 计算逻辑与 kernel 实现分离 | [modules](05-modules) |
| 注意力后端 | TRTLLM/FlashInfer kernel 适配 | `attention_backend/interface.py` `AttentionBackend` | 多 kernel 可切换，prefill/decode 分支 | [attention_backend](06-attention-backend) |
| 高级推理特性 | 投机解码 + PD 分离 | `speculative/interface.py` + `disaggregation/transceiver.py` | hook 进引擎而非垂直分层 | [speculative & disaggregation](07-speculative-disaggregation) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

从 `LLM(model=...)` 到引擎就绪的对象装配链：

```
LLM.__init__()                              [llmapi/llm.py:1838]
  → super().__init__() → BaseLLM.__init__() [llm.py:277]
    ├─ 按 backend 选择 llm_args_cls         # TorchLlmArgs（策略）
    ├─ self.args = TorchLlmArgs(**kwargs)    # pydantic 校验
    └─ self._build_model()                   # 模板方法钩子
         → _TorchLLM._build_model()          [llm.py:1740]
           ├─ 加载 tokenizer + HF config
           ├─ create_input_processor()
           └─ self._executor = GenerationExecutor.create(...)  # 工厂
               → 按 world_size/orchestrator 选子类
               → BaseWorker.setup_engine()    [base_worker.py:147]
                   → _create_py_executor()    [base_worker.py:216]
                       → PyExecutor(...)       # 装配 scheduler/model_engine/sampler
                           ├─ ModelLoader 加载模型（MetaInit → load_weights）
                           ├─ KVCacheManagerV2 分配 paged KV pool
                           ├─ KVCacheV2Scheduler
                           ├─ PyTorchModelEngine(model)
                           └─ TorchSampler
               → start_worker()              # 启动 event loop 线程
```

配置来自 `TorchLlmArgs`（pydantic 模型），覆盖优先级：kwargs > generation_config > 默认。对象实例化顺序：args → tokenizer → input_processor → executor → worker → pyexecutor（scheduler/engine/sampler）→ model。

### 核心运行流程

TensorRT-LLM 运行时有三条核心链路：离线批量生成、在线连续批处理服务、PD 分离服务。它们共享 executor → pyexecutor → model_engine 的主干，差异在调度策略与 KV cache 流转。

#### 离线批量：LLM.generate() 端到端

用户调用 `LLM.generate(prompts)` 后，请求经 llmapi 预处理（tokenize）→ executor 提交（入队）→ pyexecutor event loop 调度执行 → 采样 → detokenize 返回。

![推理请求数据流](/vibe-reading/images/articles/tensorrt-llm/data-flow.svg)

文字描述：`BaseLLM.generate()` 把每个 prompt 经 `_preprocess()` 转为 token IDs，调 `executor.generate_async()` 构造 `GenerationRequest` 并 `submit()`。请求进入 `ExecutorRequestQueue`（线程安全队列），被 event loop worker 线程的 `_fetch_new_requests()` 取出。`KVCacheV2Scheduler._schedule_loop()` 做**两阶段调度**——先调度 generation（token 开销小），再调度 context（prefill），混合成一个 `ScheduledRequests`。`PyTorchModelEngine.forward()` 在独立 `execution_stream` 上构建 `AttentionMetadata` → 选 CUDA graph → `model.forward()` 产出 logits。`TorchSampler.sample_async()` 按 strategy 分组采样（FlashInfer grouped kernel），D2H 拷贝 token。`update_requests()` 把 token 写回 `LlmRequest` 并检查 stop criteria。完成的请求生成 `LlmResponse`，经 `response_cv` 唤醒 `await_responses()`，最终 `GenerationResult.result()` 返回 `RequestOutput`（含 detokenize 后的 text）。

**overlap scheduler**（默认）：当前 batch 的 GPU forward 与上一 batch 的采样后处理（CPU 侧 `_process_previous_batch()`）并行，隐藏采样延迟。

#### 在线服务：连续批处理

`serve/openai_server.py` 接收 HTTP 请求后转成 `LLM.generate_async(streaming=True)`。与离线的区别：请求持续到达、流式返回。每 iteration scheduler 重新调度全部 active requests——新请求加入 context 队列，已完成 token 的请求继续 generation，KV cache 不足时 `_try_evict_for_gen()` 挂起尾部请求。chunked prefill 把长 prompt 分块逐步处理，避免单个长请求阻塞 batch。

#### PD 分离：KV cache 跨节点传输

disaggregated serving 把 prefill worker 与 decode worker 分离部署。prefill 完成后 `KvCacheTransceiverV2.respond_and_send_async()` 通过 NIXL（RDMA，GPU-direct）异步发送 KV cache；decode worker `request_and_receive_async()` 接收后开始正常 decode。`check_context_transfer_status()` / `check_gen_transfer_status()` 在每 iteration 轮询推进，TP/PP rank 间 `_ctx_consensus()` allgather 达成共识。

---

## 典型修改场景

#### 场景 1：新增一个模型架构

1. 新建 `_torch/models/modeling_foo.py`：定义 `FooForCausalLM(DecoderModelForCausalLM)`，加 `@register_auto_model("FooForCausalLM")`，实现 `load_weights()`
2. 修改 `_torch/models/_arch_index.py`：`MODEL_ARCH_TO_MODULE` 添加 `"FooForCausalLM": "modeling_foo"`
3. 修改 `_torch/models/__init__.py`：`__all__` 添加导出
4. 若用新 attention 类型，在 `modules/` 新增算子
5. 对应测试：`tests/unit/test_lazy_model_zoo.py`（校验注册表一致性）

#### 场景 2：新增一种注意力后端

1. 新建 `_torch/attention_backend/my_custom.py`：定义 `MyCustomAttention(AttentionBackend[MyCustomMetadata])`，实现 `forward()`
2. 修改 `attention_backend/utils.py:18` `get_attention_backend()` 添加分支
3. 实现 `support_fused_rope()` 等能力声明方法
4. 若需 CUDA graph，实现 `create_cuda_graph_metadata()`

#### 场景 3：新增一种投机解码算法

1. 在 `speculative/interface.py:326` `SpeculativeDecodingMode` 添加枚举值 + `is_*()` 谓词
2. 新建 worker 类继承 `SpecWorkerBase`，实现 `_forward_impl()` 和 `max_draft_len`
3. 修改 `speculative/utils.py:482` `get_spec_worker()` 添加分支
4. 修改 `get_spec_metadata()` 添加对应 metadata 创建

---

## 测试体系

```
tests/
├── unit/                # 单元测试（kernel、算子、调度逻辑）
├── integration/         # 集成测试（端到端推理）
├── perf/                # 性能基准
cpp/tests/unit_tests/    # C++ 后端单元测试
```

| 代码层 | 测试类型 |
|--------|----------|
| `modules/` 算子 | Unit Test（kernel 正确性） |
| `models/` 模型 | Integration Test（权重加载 + forward） |
| `pyexecutor/` 引擎 | Integration Test（调度、采样、KV cache） |
| `llmapi/` API | E2E Test（`LLM.generate()` 端到端） |

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `llmapi/llm.py` 的 `BaseLLM.generate()` → `executor/executor.py` 的 `GenerationExecutor.generate_async()` → `pyexecutor/py_executor.py` 的 `_executor_loop_overlap()` → `model_engine.py` 的 `forward()` → `sampler/sampler.py` 的 `sample_async()`
- **第二遍：理解调度与 KV cache**
  `pyexecutor/scheduler/scheduler_v2.py` 的 `KVCacheV2Scheduler._schedule_loop()` → `kv_cache_manager_v2.py` 的 `prepare_context()` / `try_allocate_generation()` / `_try_evict_for_gen()`
- **第三遍：理解模型加载与算子组装**
  `models/modeling_auto.py` 的 `AutoModelForCausalLM._resolve_class()` → 选一个 `modeling_deepseekv3.py` 看 `DeepseekV3DecoderLayer` 如何组装 `MLA` + `MoE` → `modules/attention.py` 的 `Attention.forward_impl()` 委托给 `attention_backend/`
- **第四遍：选择重点子模块深入阅读**
  [llmapi](01-llmapi) · [executor](02-executor) · [pyexecutor](03-pyexecutor) · [models](04-models) · [modules](05-modules) · [attention_backend](06-attention-backend) · [speculative & disaggregation](07-speculative-disaggregation)

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| Torch 后端 | PyTorch 原生执行路径（`_torch/`），v1.3.0 主力 |
| TRT/Plugin 后端 | TensorRT 插件路径（`cpp/`），历史成熟 |
| continuous batching | 连续批处理——prefill/decode 混合，每 iteration 重新调度 |
| overlap scheduler | 当前 batch forward 与上一 batch 采样后处理并行 |
| MLA | Multi-head Latent Attention，DeepSeek 系列的低秩注意力 |
| PD 分离 | Prefill 与 Decode 分离部署，KV cache 跨节点传输 |
| NIXL | NVIDIA Inference Transfer Library，RDMA KV cache 传输 |
| paged KV cache | KV cache 分页块管理，按需分配 |
| spec decoding | 投机解码——draft model 预测 + target model 验证 |

### 参考资料

- [TensorRT-LLM 官方文档](https://nvidia.github.io/TensorRT-LLM/)
- [Architecture 指南](https://nvidia.github.io/TensorRT-LLM/developer-guide/overview.html)
- [DeepWiki: NVIDIA/TensorRT-LLM](https://deepwiki.com/NVIDIA/TensorRT-LLM)
