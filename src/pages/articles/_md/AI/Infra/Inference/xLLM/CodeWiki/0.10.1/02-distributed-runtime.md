---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "分布式主从运行时"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "Master", "Engine", "分布式", "PD 分离"]
description: "xLLM 分布式主从运行时解读：Master/Engine 双角色编排、多节点 DistManager 协调、PD 分离与推测解码引擎。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

分布式主从运行时（`core/distributed_runtime/`）是 xLLM 的编排枢纽。`Master` 是对外门面，持有 `Engine` 与 `Scheduler`，在循环线程中驱动调度；`Engine` 是执行抽象，把 `Batch` 分发到各 `Worker`。这层独立存在的理由是**解耦调度与执行、屏蔽分布式细节**：上层（APIService）只看到 `Master::handle_request`，下层（Worker）只收到 `ForwardInput`，多节点通信、PD 跨实例 KV 传递、推测解码的多模型协调都封装在此层。`~12.8k` 行 C++。

## 模块架构

```
distributed_runtime/
├── master.h/.cpp              # Master 基类（持有 Engine，定义 run/sleep/wakeup）
├── llm_master.h/.cpp           # LLMMaster（在线循环 + 请求接入 + RL pause/resume）
├── vlm_master / dit_master / rec_master   # 多模态/DiT/推荐变体
├── engine.h                    # Engine 基类（step→ForwardOutput + KV 传递接口）
├── llm_engine.h/.cpp           # LLMEngine（多 worker 协调 + EPLB）
├── vlm_engine / dit_engine / rec_engine / speculative_engine  # 引擎变体
├── dist_manager.h/.cpp         # 多节点进程组协调（brpc 建连 + UniqueId 交换）
├── worker_server / worker_service  # worker brpc 服务端
├── remote_worker.h/.cpp        # 远程 worker 代理（RPC 调远端 step）
├── comm_channel / shm_channel  # 通信通道（brpc / 共享内存）
├── disagg_pd_service / pd_ooc_service  # PD 分离 KV 传输服务
└── spawn_worker_server/        # 子进程 worker 拉起
```

核心是 **Master-Engine 双角色**：`Master`（`master.h`）是编排者，职责是驱动 `scheduler->step()` 循环、处理请求接入、管理实例状态（sleep/wakeup）；`Engine`（`engine.h`）是执行者，职责是 `step(batch)` 执行前向、管理 KV Cache、跨实例 KV 传递。`Master` 持有 `unique_ptr<Engine> engine_`，调度循环里调 `engine_->step(batch)`。

## 调用链路

Master 启动与请求处理的调用链：

```text
LLMMaster(options)                         in llm_master.cpp
├─ engine_->init(master_status_)           # setup_workers + init_model + allocate_kv_cache
├─ create_continuous_scheduler(engine_, options)  # 选调度策略
├─ ChatTemplate::create(...)                # 组装对话模板
└─ threadpool_(num_request_handling_threads)

LLMMaster::run()                            # 主循环
└─ loop_thread: while(!stoped)
     └─ scheduler_->step(500ms timeout)    # 每轮调度+执行

LLMMaster::handle_request(messages, prompt_tokens, sp, call, callback)
└─ threadpool_->schedule(                  # 异步处理，不阻塞 HTTP 线程
     ├─ tokenizer_->encode(prompt)         # → token_ids
     ├─ generate_request(...)               # 组装 RequestState + Request
     └─ scheduler_->add_request(request)    # 入队，等待下个 step 调度
   )

# 执行侧（Engine 内）
LLMEngine::step(batch)                     in llm_engine.cpp
├─ prepare_inputs(batch) → ForwardInput     # 按 dp 切分 token/position
├─ for each worker_client_: step_async(ForwardInput)  # 并行下发各设备
├─ collect SemiFuture<ForwardOutput>        # folly 异步聚合
└─ process_eplb_data(results)              # MoE 专家负载均衡后处理
```

`Engine::step` 的并发模型：`prepare_inputs` 把 Batch 按 `dp_size` 切分到各 data-parallel 组，每组经 `WorkerClient`（本地 `Worker` 或远程 `RemoteWorker`）异步下发 `step_async`，用 folly `SemiFuture` 聚合结果。`WorkerClient` 抽象是关键——它统一了本地直调与远程 RPC，Engine 无需感知 worker 在本地还是远端。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Master::run` | 启动调度循环 | 子类实现（LLMMaster 用 loop_thread） |
| `LLMMaster::handle_request` | 接入并 tokenize 请求 | threadpool 异步，不阻塞 HTTP |
| `LLMMaster::generate_request` | 组装 Request | 容量预算（prompt+max_tokens+spec tokens） |
| `Engine::step` | 执行一批前向 | 多 worker 异步聚合 |
| `Engine::pull_kv_blocks` / `transfer_kv_blocks` | PD 跨实例 KV 传输 | Mooncake 或 RDMA |
| `Engine::sleep`/`wakeup` | 实例休眠/恢复 | 释放/重建显存与权重 |
| `Engine::get_xtensor_info` | xTensor 模式下查询物理页 | etcd 注册全局内存 |
| `DistManager` | 多节点进程组建立 | UniqueId 交换 + brpc 建连 |

</details>

## 核心实现

### Master 子类族与后端分发

`create_master(backend, options)` 工厂按 `backend` 字符串（`"llm"`/`"vlm"`/`"dit"`）选择 Master 子类。主节点创建 `LLMMaster`/`VLMMaster`/`DiTMaster`，从节点创建对应的 `AssistantMaster`（仅循环等待，不启 HTTP）：

```cpp title="distributed_runtime/llm_master.cpp"
LLMMaster::LLMMaster(const Options& options)
    : Master(options, should_use_ssm_engine(options) ? EngineType::SSM
                                                      : EngineType::LLM) {
  CHECK(engine_->init(master_status_));        // Engine 初始化
  scheduler_ = create_continuous_scheduler(engine_.get(), scheduler_options);
  chat_template_ = ChatTemplate::create(engine_->tokenizer_args(), ...);
  tokenizer_ = engine_->tokenizer()->clone();
  threadpool_ = std::make_unique<ThreadPool>(options_.num_request_handling_threads(), ...);
}
```

`should_use_ssm_engine()` 判断逻辑：若配置了 `draft_model` 或 Suffix 算法，则 EngineType 为 `SSM`（推测解码引擎），否则为 `LLM`。这决定 Engine 内部是否用 `SpeculativeEngine` 包装。

### 请求容量预算与容错

`generate_request`（`llm_master.cpp`）在组装 `Request` 时做容量预算：`capacity = prompt_tokens + max_tokens + num_speculative_tokens + 1`，schedule_overlap 时再 `+ num_speculative_tokens + 1`（预调度多一步）。这确保 BlockManager 预留足够块。请求参数校验（`sp.verify_params`）与 prompt 长度检查在 threadpool 内完成，超长直接 `CALLBACK_WITH_ERROR`，不进入调度。

### 多节点 DistManager

`DistManager`（`dist_manager.cpp`）负责多节点进程组建立：主节点的 Engine 启 brpc server，等待 worker 连接；worker 连上后交换 `UniqueId`（用于 NCCL/HCCL 进程组），并将自己的 worker brpc 地址发给 Engine；Engine 据此为每个 worker 创建 `WorkerClient`。这套握手完成后，Engine 就能像调用本地 Worker 一样调远程 worker。

### PD 分离 KV 传输

`Engine` 的 `pull_kv_blocks`/`transfer_kv_blocks`/`prefetch_from_storage` 接口支撑 PD 分离：Prefill 实例算完后，通过这些接口把 KV Cache 块传到 Decode 实例。传输方式由 `kv_cache_transfer_mode`（`"PUSH"`/`"PULL"`）控制，底层走 `comm_channel`（brpc）或 `shm_channel`（共享内存），或经 Mooncake 全局存储。`disagg_pd_service` 与 `pd_ooc_service` 是暴露给对端实例的 brpc 服务端。

## 模块间交互

- **依赖 Scheduler**：`Master` 持有 `scheduler_`，循环调 `step()`；`Scheduler` 反向持有 `Engine*`，在 `step` 内调 `engine_->step(batch)`。两者是双向持有但职责分明。
- **依赖 Runtime**：`Engine` 通过 `WorkerClient` 调 `Worker`/`RemoteWorker`（`core/runtime/`）。
- **依赖 Framework**：`Engine` 持有 `KVCacheManager`、`ModelArgs`、`Tokenizer`；`step` 的输入输出类型 `Batch`/`ForwardInput`/`ForwardOutput` 来自 `core/framework/`。
- **被 APIService 依赖**：`Master*` 传入 `APIService`，HTTP 请求经 `Master::handle_request` 接入。

## 扩展方式

- 新增后端 Master/Engine：在 `distributed_runtime/` 新建 `xxx_master.h/.cpp` 与 `xxx_engine.h/.cpp`，继承 `Master`/`Engine`，在 `create_master` 工厂增加分支。
- 新增 KV 传输方式：实现 `Engine::transfer_kv_blocks` 的 override，增加 `comm_channel` 子类。
