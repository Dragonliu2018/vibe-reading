---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "执行运行时"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "Worker", "Executor", "GraphExecutor", "运行时"]
description: "xLLM 执行运行时解读：Worker/Executor 单设备执行封装、多后端图执行器、异步调度与 KV Cache 分配。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

执行运行时（`core/runtime/`）是单设备级的执行封装。`Worker` 是每设备一个的执行单元，`Executor` 负责单步前向，`ExecutorImpl` 按硬件后端切换图执行策略。这层独立是因为：硬件执行细节（图捕获/算子流/共享内存）多变，把它收敛在一层后，上层 Engine 只需 `Worker::step(ForwardInput)`，下层模型代码不感知图优化。`~26.2k` 行 C++。

## 模块架构

```
runtime/
├── worker.h/.cpp               # Worker 对外接口（init_model/step_async/estimate_kv_cache）
├── worker_impl.h               # WorkerImpl 基类（Status: UNINITIALIZED→LOADED→READY）
├── llm_worker_impl             # LLM worker 实现
├── vlm_worker_impl / dit_worker_impl / embed_worker_impl  # 多任务变体
├── eagle3_worker_impl / mtp_worker_impl / suffix_worker_impl  # 推测解码 worker
├── executor.h                  # Executor 门面（prepare_inputs + forward）
├── executor_impl.h             # ExecutorImpl 抽象（prepare_inputs + run）
├── base_executor_impl          # 基础实现
├── cuda_graph_executor_impl    # CUDA Graph 图执行器
├── acl_graph_executor_impl     # 昇腾 ACL Graph 图执行器
├── dcu_graph_executor_impl     # DCU 图执行器
├── forward_params.h            # ForwardInput/ForwardOutput 数据结构
├── worker_client.h             # WorkerClient 抽象（本地 Worker / RemoteWorker）
├── options.h                   # runtime::Options
├── xservice_client.h           # 服务路由客户端（etcd 注册/查询）
├── worker_rendezvous.h         # worker 间同步
└── cp_input_partition.h        # context-parallel 输入切分
```

核心是 **Worker-Executor 两级**：`Worker`（`worker.h`）是设备级调度单元，内部有单线程 `ThreadPool`（保证设备上串行执行），持有 `WorkerImpl*`；`Executor`（`executor.h`）是模型执行门面，持有 `CausalLM*` 模型指针与 `ExecutorImpl*`，`forward()` 调 `impl_->run()`。

## 调用链路

Engine 到模型前向的执行链：

```text
LLMEngine::step(batch)                    in distributed_runtime/llm_engine.cpp
├─ prepare_inputs(batch) → vector<ForwardInput>   # 按 dp 切分
├─ for each worker_client_:
│    └─ worker_client->step_async(ForwardInput)    # 本地 Worker 或远程 RemoteWorker
│         └─ Worker::step_async(inputs)             in runtime/worker.h
│              └─ threadpool_.schedule(            # 单线程池，设备串行
│                   impl_->step(inputs)             # WorkerImpl::step
│                    ├─ executor_->prepare_inputs(batch) → ForwardInput
│                    ├─ executor_->forward(tokens, positions, kv_caches, params)
│                    │    └─ impl_->run(...)         # ExecutorImpl::run（图执行器）
│                    │         └─ model_->forward(tokens, positions, kv_caches, params)
│                    │              in framework/model/causal_lm.h   # CausalLM::forward
│                    └─ sampler_->sample(logits)    # 采样
│                 )
└─ collect SemiFuture<optional<ForwardOutput>>
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Worker::init_model` | 加载权重 + 分配 KV cache | 阻塞调用，完成后 Status=READY |
| `Worker::step_async` | 异步执行一步 | SemiFuture，单线程池保证设备串行 |
| `Worker::estimate_kv_cache_capacity` | 估算可用 KV 容量 | 返回 (free, total) |
| `Worker::allocate_kv_cache` | 分配 KV cache 张量 | 按 KVCacheShape 创建 |
| `Executor::prepare_inputs` | Batch→ForwardInput | 处理 position/embedding/cu_seq_lens |
| `Executor::forward` | 模型前向 | tokens+positions→ModelOutput(hidden) |
| `ExecutorImpl::run` | 后端特化执行 | CUDA/ACL/DCU 图执行器 |
| `WorkerImpl` Status | UNINITIALIZED→LOADED→READY | 状态机管理生命周期 |

</details>

## 核心实现

### Worker 的异步单线程池

`Worker`（`worker.h`）内部持有一个**单线程 ThreadPool**：

```cpp title="runtime/worker.h"
class Worker {
  ThreadPool threadpool_{/*num_threads=*/1, /*cpu_binding=*/false, /*pool_name=*/"Worker.async"};
};
```

设计决策：每设备一个单线程池，保证同一设备上的操作串行（init_model / step / allocate_kv_cache 不并发），避免设备上下文竞争。`step_async` 把任务投递到这个池，返回 `SemiFuture`，Engine 端聚合多个 worker 的 future 实现跨设备并行。

### 图执行器策略

`ExecutorImpl`（`executor_impl.h`）是执行策略抽象，各硬件后端有图执行器实现：

- `cuda_graph_executor_impl`：CUDA Graph 捕获与回放，多图缓存适配动态 shape
- `acl_graph_executor_impl`：昇腾 ACL Graph，含持久化参数（`acl_graph_persistent_param`）
- `dcu_graph_executor_impl`：海光 DCU 图执行

图执行器负责把 `prepare_inputs` 的张量喂入预捕获的图，回放而非重新执行，消除框架开销。`enable_graph` 控制是否启用，`max_tokens_for_graph_mode` 限制图模式适用范围。动态 shape 通过参数化 + 多图缓存（`enable_prefill_piecewise_graph`）适配。

### Worker 状态机

`WorkerImpl`（`worker_impl.h`）定义三态：`UNINITIALIZED` → `LOADED`（权重加载完）→ `READY`（KV cache 分配完）。`init_model` 完成后 `LOADED`，`allocate_kv_cache` 后 `READY`。sleep 时释放回 `LOADED` 以下，wakeup 时重新分配。

### ForwardInput/ForwardOutput

`forward_params.h` 定义步执行的数据契约：`ForwardInput` 含 token ids、positions、kv_cache 引用、attention metadata、dp 切分信息；`ForwardOutput`（`RawForwardOutput`）含 logits/embeddings、采样结果。这是 Engine 与 Worker 之间的数据边界，跨设备/跨节点传递的就是这个结构。

## 模块间交互

- **被 Engine 调用**：`LLMEngine` 经 `WorkerClient` 调 `Worker::step_async`。
- **依赖 Framework**：`Executor` 持有 `CausalLM*`（`framework/model/`），`forward` 的参数类型 `KVCache`/`ModelInputParams` 来自 `framework/`。
- **依赖 Layers/Kernels**：`CausalLM::forward` 内部逐层调 `layers_`，每层调硬件算子（`core/kernels/`）。
- **依赖 Platform**：设备管理（`core/platform/device.h`）、`ParallelState`（`framework/parallel_state/`）。

## 扩展方式

- 新增图执行器：继承 `ExecutorImpl`，实现 `prepare_inputs`/`run`，在 `WorkerImpl` 内按编译宏选择。
- 新增 worker 类型（如新推测算法）：继承 `WorkerImpl`，在 `worker.h` 增加 `WorkerType` 枚举。
