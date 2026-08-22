---
source:
  type: "源码解读"
  project: "vLLM"
  url: "https://github.com/vllm-project/vllm"
title: "GPU Worker 与模型执行"
date: "2026-08-22T18:02:27+08:00"
category: [AI, Infra, Inference, vLLM, CodeWiki, "0.27.1"]
tags: ["vLLM", "GPU Worker", "CUDA Graphs", "ModelRunner", "InputBatch", "采样"]
description: "解读 vLLM GPU Worker 与模型执行模块：Worker 管资源、GPUModelRunner 管执行，分段 CUDA Graph、地址稳定的 InputBatch、统一 prefill/decode 路径与异步 D2H。"
readingTime: "19 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview)

---

## 模块定位

GPU Worker 模块（`vllm/v1/worker/`）是 vLLM 把抽象的 `SchedulerOutput` 落实成一次真实 GPU 前向与采样的地方，也是性能最敏感的一层。它解决的核心问题是：**LLM 推理的 batch 大小每步都在变（请求动态增删、prefill/decode 混批），而 CUDA Graph 要求输入 shape 固定**——这对矛盾如何调和。模块给出三分级 CUDA Graph + 地址稳定 InputBatch 的方案。

## 模块架构

![GPU Worker 执行流水线](/vibe-reading/images/articles/vllm/03-gpu-worker.svg)

模块的核心分工是 **Worker 管资源，GPUModelRunner 管执行**：`Worker`（`gpu_worker.py`）负责 GPU 设备初始化、分布式环境、显存探测与分配、PP 通信、权重传输、显存休眠；`GPUModelRunner`（`gpu_model_runner.py` V1 / `gpu/model_runner.py` V2）负责消费 `SchedulerOutput`、组装输入、跑模型前向、采样。执行分两步调用：`execute_model`（更新请求 + 准备输入 + forward + 存 `ExecuteModelState`）与 `sample_tokens`（采样 + spec decode + 异步 D2H），状态靠 `ExecuteModelState` 跨两步传递。前向时分三种 CUDA Graph 模式 dispatch。

## 调用链路

从 `EngineCore.step` 到 Worker 的执行链：

```
EngineCore.step()
└─ model_executor.execute_model(scheduler_output) → Future
   └─ UniProcExecutor.collective_rpc("execute_model")
      └─ WorkerWrapperBase.execute_model
         └─ Worker.execute_model()                     # gpu_worker.py:1019
            └─ GPUModelRunner.execute_model()           # gpu_model_runner.py
               ├─ finish/add/update_requests           # 消费 SchedulerOutput
               ├─ prepare_inputs() → InputBatch
               ├─ prepare_attn() → block_tables, slot_mappings
               ├─ forward（FULL replay / PIECEWISE / NONE eager）
               └─ store ExecuteModelState, return None
└─ ... future.result() ...
└─ model_executor.sample_tokens(grammar_output)
   └─ Worker.sample_tokens()
      └─ GPUModelRunner.sample_tokens()                # gpu_model_runner.py
         ├─ apply_grammar_bitmask / sampler() / rejection_sampler()
         ├─ speculator.propose()                       # 推测解码
         └─ AsyncOutput（output_copy_stream D2H）
```

数据类型：`SchedulerOutput` → `InputBatch`（`InputBuffers` 持久 GPU buffer 的切片）→ 模型 `hidden_states` → `logits` → `SamplerOutput(sampled_token_ids)` → `ModelRunnerOutput`（D2H 后回传 EngineCore）。跨进程（EngineCore↔Worker）走共享内存 `MessageQueue`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Worker.init_device` | 设 CUDA device + 分布式初始化 | `init_distributed_environment` |
| `Worker.determine_available_memory` | 探测可用显存 | profile run + CUDA graph 估计 |
| `Worker.execute_model` | 执行入口，PP 通信 | `irecv`/`isend` `IntermediateTensors` |
| `GPUModelRunner.execute_model` | 消费 schedule + forward | 存 `ExecuteModelState` |
| `GPUModelRunner.prepare_inputs` | 重建 InputBatch | Triton kernel 填充 |
| `GPUModelRunner.sample_tokens` | 采样 + spec decode | 取出 `ExecuteModelState` |
| `CudaGraphManager.dispatch` | 选 CUDA graph 模式 | 按 `(num_tokens, loras)` 匹配 |
| `CudaGraphManager.capture` | 捕获图 | 先 PIECEWISE 后 FULL |

</details>

## 核心实现

### Worker 与 GPUModelRunner 的分工

`WorkerBase`（`worker_base.py`）是抽象基类，注释明确说"allows vLLM to cleanly separate implementations for different hardware"。`WorkerWrapperBase` 是生命周期包装器：先记 worker class 的 qualified name，等环境变量设好才在 `init_worker` 里用 `resolve_obj_by_qualname` 惰性实例化真正的 `Worker`，并通过 `__getattr__` 透明转发。V1/V2 `GPUModelRunner` 由 `use_v2_model_runner` 切换（`gpu_worker.py` L384）：V1（`gpu_model_runner.py`，继承 `LoRAModelRunnerMixin`/`KVConnectorModelRunnerMixin`/`ECConnectorModelRunnerMixin`）是当前主版本，V2（`gpu/model_runner.py`）渐进迁移中、`reload_weights` 等仍委托 V1。

### 分段 CUDA Graph（FULL/PIECEWISE/NONE）

标准 CUDA Graph 要求输入 shape 固定，而 LLM batch 每步变化。方案是三级（`cudagraph_utils.py` L108）：**FULL** 对 uniform decode batch（所有请求 query_len 相同）捕整图，dispatch 时按 `BatchExecutionDescriptor` 匹配，replay 整图，性能最优但灵活性最低；**PIECEWISE** 把模型分段（attention 层是天然 breakpoint），段内用图、段间 eager，经 `torch.compile` 的 piecewise cudagraph 或 `BreakableCUDAGraphWrapper` 处理变长 batch；**NONE** eager，用于 profile 等场景。Capture 顺序先 PIECEWISE 后 FULL（`cudagraph_utils.py` L312）——PIECEWISE 的 activation 更大，先 capture 让 FULL 复用已分配缓冲区。Dispatch（`cudagraph_utils.py` L365）按 `(num_tokens, effective_loras)` 查 `_candidates` 字典，找第一个 `_is_compatible` 的 desc。

### InputBatch 的地址稳定性

CUDA graph replay 要求指针不变。`InputBatch`（`input_batch.py`）是纯数据容器，`InputBuffers` 是预分配持久 GPU buffer。每次 `prepare_inputs` 把新数据写入 `InputBuffers` 的固定地址、`InputBatch` 字段切片引用——地址不变，只换内容。请求的动态增删不在 `InputBatch` 上做，而靠 `RequestState`（`gpu/states.py`）管持久状态：`finish_requests`/`add_requests`/`update_requests` 在 `req_states` 上用固定大小 tensor + `req_id_to_index` dict 映射，slot index 可复用。`BlockTables` 用 `StagedWriteTensor`：`append_block_ids` 先在 CPU 端 stage，`apply_staged_writes` 再一次性提交到 GPU，减少零散 H2H 拷贝。

### 统一 prefill/decode 路径

vLLM v1 不区分两个 kernel，把 prefill 与 decode 混在同一个 batch（chunked prefill）。`prepare_inputs` 同时处理两者，用 `is_prefilling_np` 标记区分；`prepare_prefill_inputs`（Triton kernel）处理 prefill token，`combine_sampled_and_draft_tokens` 处理 decode token，写入同一 `input_ids` 的不同区域。`sort_batch_req_ids`（`gpu/model_runner.py` L1717）把 decode 请求排前面（uniform decode 优先匹配 CUDA graph）、prefill 排后面，key 是 `(query_len != decode_query_len, query_len)`。

### 异步重叠

`AsyncOutput`（`gpu_model_runner.py` L259）在独立 `output_copy_stream` 上启动 D2H 拷贝 sampled token ids 与 logprobs，先 `wait_stream(default_stream)` 确保 GPU 计算完成，再立即 `postprocess_sampled()` 与 `speculator.propose()`，Executor 端 `AsyncOutputFuture.result()` 调 `get_output()` 时才真正等拷贝——D2H 与 speculator 前向完全重叠。`AsyncIntermediateTensors`（`gpu_worker.py` L96）包装 PP 的中间张量 + comm_handles，在 `__getattribute__` 拦截 `.tensors` 惰性 `wait_for_comm()`，让 Worker 等通信时能做 profiler 标注等其他准备。ubatch（`workspace.py` + `gpu_worker.py` L405）为 DBO（Decode Batch Optimization）预分配 2 组 workspace，使前一个 batch 采样时同时准备下一个 batch 前向。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `WorkerBase` → `Worker`/`CPUWorker`/`XpuWorker` | 硬件平台可替换 |
| Mixin | `LoRAModelRunnerMixin`/`KVConnectorModelRunnerMixin` | 给 runner 组合能力而不改继承树 |
| 委托 | `WorkerWrapperBase.__getattr__` in `worker_base.py` | 透明转发，上层无感 wrapper |
| 工厂 | `get_model_loader` / `WeightTransferEngineFactory` | 按配置选加载器/传输引擎 |

## 模块间交互

被 `v1/engine` 经 `v1/executor`（`UniProcExecutor`/`MultiprocExecutor`/Ray executor）调用：`EngineCore.step` 调 `model_executor.execute_model` 拿 `Future`，返回 None 时继续 `sample_tokens`。Executor 把调用经 `collective_rpc` 转发到 `WorkerWrapperBase` 再到 `Worker`。Worker 前向调 `model_executor/models` 下的模型（`self.model(**inputs)` 或 cudagraph replay），模型内部调 `model_executor/layers` 与 `v1/attention`。Worker 读 `v1/core` 的 `SchedulerOutput`（不直接调 Scheduler）。与 `distributed` 的关系：`init_worker_distributed_environment` 调 `init_distributed_environment` + `ensure_model_parallel_initialized`，TP 走 all-reduce、PP 走 `irecv`/`isend`、DP 走 `sync_cudagraph_and_dp_padding`、EP 走 `All2AllManager`。

## 扩展方式

新增硬件 runner：实现 `WorkerBase` 子类（`init_device`/`load_model`/`execute_model` 等）与对应 `ModelRunner`，在 `parallel_config.worker_cls` 配置 qualified name，`WorkerWrapperBase.init_worker` 经 `resolve_obj_by_qualname` 加载。修改采样逻辑：改 `vllm/v1/worker/gpu/sample/sampler.py` 的 `Sampler.__call__` 与 `gpu_model_runner.py` 的 `sample`。新增 CUDA graph 捕获尺寸：改 `vllm/config/compilation.py` 的 `cudagraph_capture_sizes` 与 `cudagraph_utils.py` 的 `_init_candidates`。
