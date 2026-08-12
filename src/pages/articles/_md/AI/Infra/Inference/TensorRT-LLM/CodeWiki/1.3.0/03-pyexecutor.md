---
source:
  type: "源码解读"
  project: "TensorRT-LLM"
  url: "https://github.com/NVIDIA/TensorRT-LLM"
title: "执行引擎"
date: "2026-08-12T12:04:11+08:00"
category: [AI, Infra, Inference, TensorRT-LLM, CodeWiki, "1.3.0"]
tags: ["TensorRT-LLM", "PyExecutor", "连续批处理", "KV Cache", "调度器"]
description: "pyexecutor 是 Torch 后端执行引擎——PyExecutor 主循环、KVCacheV2Scheduler 两阶段调度、TorchSampler 分组采样、KVCacheManagerV2 分页缓存。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/TensorRT-LLM/CodeWiki/1.3.0/00-overview)

---

## 模块定位

pyexecutor 是 Torch 后端的心脏——每秒数十次 iteration 的"调度 → forward → 采样 → 更新"主循环在此运转。它持有 scheduler、model_engine、sampler、KV cache manager 四大组件，把 `executor` 提交的请求变成 token 输出。模块独立存在是因为**推理运行时是一个有状态的循环系统**：调度策略、KV cache 生命周期、CUDA graph 复用、overlap 并行这些复杂逻辑需要一个集中的编排者。

## 模块架构

```
PyExecutor (py_executor.py:520)
├── scheduler: KVCacheV2Scheduler      ← 两阶段调度（gen 先于 ctx）
├── model_engine: PyTorchModelEngine   ← 模型 forward + CUDA graph
├── sampler: TorchSampler              ← 分组采样（FlashInfer kernel）
├── kv_cache_manager: KVCacheManagerV2 ← 分页 KV cache 分配/驱逐
├── drafter: SpecWorkerBase            ← 投机解码（可选）
├── kv_cache_transceiver               ← PD 分离 KV 传输（可选）
└── guided_decoder                     ← 语法约束解码（可选）
```

## 调用链路

一次 iteration 的核心循环（`_executor_loop_overlap()` in `py_executor.py:4626`，默认 overlap 模式）：

```
_executor_loop_overlap()
├─ _prepare_and_schedule_batch()       [py_executor.py:3758]
│   ├─ _fetch_new_requests()           → 从 ExecutorRequestQueue 取请求
│   ├─ _prepare_draft_requests()       → 投机解码 draft 准备
│   └─ _schedule()                     [py_executor.py:5629]
│       └─ scheduler.schedule_request()
│           └─ KVCacheV2Scheduler._schedule_loop()  [scheduler_v2.py:252]
│               ├─ Phase 1: _try_schedule_generation()  → try_allocate_generation()
│               └─ Phase 2: _try_schedule_context()     → prepare_context() + resize_context()
├─ _forward_step(scheduled_batch)      [py_executor.py:6938]
│   └─ model_engine.forward()          [model_engine.py:6972]
│       ├─ _set_up_attn_metadata()
│       ├─ cuda_graph_runner.maybe_get_cuda_graph()
│       └─ model.forward() → {"logits": Tensor}
├─ _sample_async(batch, outputs)       [py_executor.py:7064]
│   ├─ HandleLogits()                  → 写回 context/generation logits
│   └─ sampler.sample_async()          → SampleState (GPU tensors + event)
├─ _update_requests(sample_state)      [py_executor.py:7110]
│   └─ sampler.update_requests()       → 回写 token，检查 stop
├─ _process_previous_batch()           [py_executor.py:5018]  ← overlap：处理上一 batch
│   └─ _handle_responses()             → LlmResponse → response_queue
└─ kv_cache_manager.update_context_resources()
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `_executor_loop_overlap()` | 主循环 | 当前 batch forward 与上一 batch 后处理并行 |
| `_schedule()` | 调度请求 | 两阶段：gen 先于 ctx，确保 gen 优先获 budget |
| `_forward_step()` | 模型前向 | 在独立 execution_stream 上执行 |
| `_sample_async()` | 采样 | 按 strategy 分组，FlashInfer grouped kernel |
| `_handle_responses()` | 产出响应 | 完成请求生成 LlmResponse |

## 核心实现

### 连续批处理与两阶段调度

`KVCacheV2Scheduler._schedule_loop()` in `scheduler_v2.py:252` 每次 iteration 把不同阶段的请求混合进一个 batch：context 请求（prefill，`LlmRequestState.CONTEXT_INIT`）处理 prompt tokens，generation 请求（decode，`GENERATION_IN_PROGRESS`）逐 token 生成。

两阶段调度是关键设计——**先调度 generation，再调度 context**。generation 每 req 仅 ~1 token，KV 开销小；context 是 prefill，token 开销大。先 gen 确保 decode 请求优先获得 budget，避免被大 prefill 挤占。`_try_evict_for_gen()` in `scheduler_v2.py:1015` 在 KV cache 不足时从 active_requests 尾部反向搜索可驱逐请求，suspend 释放页后重试分配。

### KVCacheManagerV2 分页缓存

`KVCacheManagerV2` in `kv_cache_manager_v2.py:743` 基于 C++ 绑定的 `KVCacheManager`，Python 层做请求级状态管理：

- **Paged KV Cache**：KV cache 分为固定大小 block（`tokens_per_block`），按需分配
- **Block Reuse / Prefix Sharing**：`prepare_context()` 检查前缀匹配，跳过重复计算
- **Suspend/Resume**：`suspend_request()` 释放 GPU 页到 host cache tier，`resume()` 恢复
- **Multi-tier Cache**：GPU → Host → Disk 三级缓存，`AttnLifeCycle` 管理页迁移
- **Inline Allocation**：V2 在调度循环内直接 `resize_context()` 分配，而非 V1 延迟到 `prepare_resources()`

### scheduler_v2 vs scheduler (V1)

V1（`scheduler.py`）：`CapacityScheduler` 抽象 + 多子类，调度与 KV cache 分配分离。V2（`scheduler_v2.py`）：`KVCacheV2Scheduler` 把调度和 KV cache 分配**合并到一个循环**（inline allocation），引入 `BudgetTracker` 统一管理 token/request/PEFT 预算，支持两阶段调度、eviction、prefix-aware scheduling。V2 是新路径，限制：不支持 beam search（`assert max_beam_width == 1`）。

### CUDA Graph 复用

`PyTorchModelEngine.forward()` in `model_engine.py:6972` 通过 `CUDAGraphRunner` 选择预捕获的 CUDA graph：按 batch_size、num_tokens、是否 greedy 等维度选 key。支持 context 请求提升为 decode graph（`_make_single_token_context_graph_batch()`），piecewise CUDA graph 支持 prefill 阶段部分图捕获。**Why**：decode 阶段每 iteration 计算图结构固定，CUDA graph 捕获重放消除 kernel launch 开销。

### PyExecutor 为何 7800+ 行

`PyExecutor` 是 Torch 后端的 **God Object**，承担远超"调度执行"的职责：单 GPU/TP/PP 三种路径（PP 有独立 `_executor_loop_pp()` `:2650`）、disaggregated serving KV 传输（~800 行）、speculative decoding drafter 管理、统计监控（~600 行）、sleep/wakeup MPI 通信（~400 行）、KV cache rebalance、错误处理。这是一个已知的架构债务——多职责集中在一个类，未来可能拆分。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 连续批处理 | `_schedule_loop()` in `scheduler_v2.py:252` | prefill/decode 混合，提升 GPU 利用率 |
| 策略 | V1/V2 scheduler 选择 | 不同 KV cache 版本可切换 |
| 模板方法 | `Sampler.sample_async()` + `update_requests()` | 采样器抽象，TorchSampler/EarlyStopSampler 实现 |
| Overlap | `_process_previous_batch()` 与当前 forward 并行 | 隐藏 CPU 侧采样后处理延迟 |

## 模块间交互

pyexecutor 是依赖枢纽：向 `models/` 调用 `model.forward()`（`model_engine.py` 通过 `ModelLoader` 加载 `DecoderModelForCausalLM`），向 `attention_backend/` 构建 `AttentionMetadata`（`_set_up_attn_metadata()` in `model_engine.py:2997`），向 `sampler/` 调用采样。`speculative/` 的 drafter 和 `disaggregation/` 的 transceiver 作为可选组件注入 `PyExecutor.__init__`。

请求队列分两层：`ExecutorRequestQueue`（`executor_request_queue.py`，外部入队通道）和 `active_requests`（已激活列表，`_fetch_new_requests()` 取出加入）。`WaitingQueue`（`waiting_queue.py`）用于 context 请求的 batch waiting——无 generation 时延迟执行避免空跑。`inflight_req_ids` 防止 overlap 场景重复调度正在采样的请求。

## 扩展方式

**新增调度策略**：修改 `KVCacheV2Scheduler._schedule_loop()` 的排序逻辑 → 可能扩展 `BudgetTracker`（`scheduler_v2.py:43`）添加预算维度 → 若涉及新 eviction，改 `_try_evict_for_gen()`。

**新增采样方法**：在 `sampler/sampler_strategy.py` 定义新 `Strategy` → 在 `sampler/ops/` 实现 kernel → 在 `TorchSampler._sample_batched_by_strategy()` 添加分支 → 新 stop criteria 改 `_handle_stop_criteria()`（`sampler.py:1783`）。
