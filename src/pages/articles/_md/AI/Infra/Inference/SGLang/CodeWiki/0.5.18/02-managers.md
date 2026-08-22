---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "编排层"
date: "2026-08-22T22:29:54+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.18"]
tags: ["SGLang", "managers", "Scheduler", "continuous batching", "overlap 调度", "ZMQ IPC"]
description: "SGLang 编排层：Scheduler 零开销双流调度、TokenizerManager/DetokenizerManager 三进程协作、SchedulePolicy 准入控制。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.18/00-overview)

---

## 模块定位

managers 是 SGLang 运行时的大脑。它把"收请求 → 组批 → 调度 → forward → 处理结果 → 出流"完整编排起来，是唯一同时持有调度状态机、KV cache 句柄与 TpModelWorker 的模块。`Scheduler` 子进程独占 GPU 与 NCCL 通信域，`TokenizerManager` 在主进程做 asyncio I/O，二者经 ZMQ 解耦——这个边界是整个系统能"CPU 调度与 GPU forward 重叠"的前提。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-v0518/managers-architecture.svg)

模块围绕 `Scheduler`（`scheduler.py:383`）组织，但它不是单一大类，而是 **6 个 Mixin 组合**：`SchedulerDisaggregationDecodeMixin`、`SchedulerDisaggregationPrefillMixin`（PD 分离）、`SchedulerMultiplexMixin`（prefill/decode 多路复用）、`SchedulerPPMixin`（流水线并行）、`SchedulerDllmMixin`（扩散 LLM）、`SchedulerMlxOverlapMixin`（MLX 硬件 overlap）。`__init__`（`:393`）被刻意约束为"只编排 init_*/maybe_init_* 调用"（编排器模式，`:405` 注释明确要求），每个 Mixin 独立维护一个垂直特性的逻辑，避免巨型类。

围绕 Scheduler 有四组协作：**数据结构**（`ScheduleBatch`/`Req`/`NextBatchPlan`，CPU 侧批次与请求状态）、**策略**（`SchedulePolicy`（`:216`）排序 + `PrefillAdder`（`:504`）按 KV 预算准入）、**组件**（`scheduler_components/` 子包拆出 IpcChannels/RequestReceiver/BatchResultProcessor/OutputStreamer/MetricsReporter 等 ~12 个组件）、**进程协作**（`TokenizerManager` 接入、`DataParallelController` DP 路由、`DetokenizerManager` 出流、`TpModelWorker` 桥接执行层）。这种"核心类 + Mixin + Component 子包"的拆分，让一个 5000 行的调度核心仍可分域阅读。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-v0518/managers-call-chain.svg)

`event_loop_overlap`（`scheduler.py:1754`）每轮的步骤：`recv_requests`（`:1770`，ZMQ PULL）→ `process_input_requests`（`:1877`，`TypeBasedDispatcher` 路由到 `handle_generate_request`）→ `get_next_batch_to_run`（`:3015`，`SchedulePolicy.calc_priority` 排序 + `PrefillAdder` 按 KV 预算准入）→ `run_batch`（`:3626`，`TpModelWorker.forward_batch_generation` 启动 GPU forward）→ `result_queue.append(batch.copy(), result)`（`:1804`，延迟一步）→ `process_batch_result`（`:3922`，处理**上一轮**结果，output_streamer→ZMQ）。CPU 处理上一轮与 GPU 执行当前轮并行，是 overlap 的核心。

`dispatch_event_loop`（`:4902`）根据 `disaggregation_mode`、`pp_size`、`enable_overlap`、`enable_pdmux` 选择 10 种 event_loop 变体。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `event_loop_overlap` (`:1754`) | overlap 调度主循环 | `result_queue` 延迟一步，CPU/GPU 并行 |
| `event_loop_normal` (`:1719`) | 非 overlap 调度主循环 | 串行 forward + process |
| `get_next_batch_to_run` (`:3015`) | 选 prefill/decode 批次 | `NextBatchPlan` 封装结果 |
| `get_new_batch_prefill` (`:3157`) | 从 waiting_queue 选 prefill | `_get_new_batch_prefill_raw` + `PrefillAdder` |
| `run_batch` (`:3626`) | 调用 GPU forward | overlap 路径用 forward_stream + copy_stream |
| `process_batch_result` (`:3922`) | 处理 forward 结果 | 按 forward_mode 分发 decode/prefill/idle |
| `process_input_requests` (`:1877`) | 接收并路由请求 | `TypeBasedDispatcher` 按消息类型 |
| `handle_generate_request` (`:2368`) | 创建 `Req` 并入队 | `waiting_queue.append` |
| `is_disable_overlap_for_batch` (`:1828`) | 判断是否禁用 overlap | 连续 prefill 或 grammar sync |
| `calc_priority` (`schedule_policy.py:237`) | 排序 waiting_queue | 队列>128 自动降级 FCFS |
| `add_one_req` (`schedule_policy.py:1201`) | PrefillAdder 准入 | KV 预算 + chunked + lock_node |
| `prepare_for_extend` (`schedule_batch.py:2369`) | 准备 prefill 前向张量 | 计算 input_ids/extend_lens |
| `prepare_for_decode` (`schedule_batch.py:3038`) | 准备 decode 前向 | 分配 1 token KV cache |
| `merge_batch` (`schedule_batch.py:3211`) | 合并两个批次 | continuous batching 核心 |
| `mix_with_running` (`schedule_batch.py:2749`) | prefill+decode 混合 | ForwardMode.MIXED |
| `retract_decode` (`schedule_batch.py:2816`) | KV 不足时驱逐 | evict + backup |

</details>

## 核心实现

### Scheduler 与 overlap 双流

`event_loop_overlap`（`scheduler.py:1754`）是 overlap 调度的核心。关键机制：`result_queue: Deque`（`:1756`）延迟一步处理。第 N 步 `run_batch(batch_N)` 启动 GPU 前向，结果入 `result_queue` 不立即处理；第 N+1 步 `run_batch(batch_{N+1})` 的同时 `pop_and_process()` 处理 batch_N 的结果。CPU 侧的 `process_batch_result`（检查完成状态、增量解码、ZMQ 发送）与 GPU 侧下一个 forward 并行执行，**零开销**。

`batch.copy()`（`:1804`）做浅拷贝是因为后续 `filter_batch`/`merge_batch` 会改变 `reqs` 列表。三个 CUDA stream：`forward_stream`（模型前向）、`schedule_stream`（调度逻辑）、`copy_stream`（D2H 结果拷贝）。`FutureMap`（`:1463`）中继下一迭代的 input_ids，因为 `process_batch_result` 修改的 `output_ids` 还没准备好。

禁用 overlap 的场景（`is_disable_overlap_for_batch` `:1828`）：连续两个 prefill batch（优化 TTFT）或 grammar 需要同步（FSM 需要上一批次结果）。

### SchedulePolicy 与 PrefillAdder

`SchedulePolicy`（`schedule_policy.py:216`）含两类策略：`CacheAwarePolicy`（LPM 最长前缀匹配 / DFS_WEIGHT 深度优先加权）和 `CacheAgnosticPolicy`（FCFS / LOF / RANDOM / ROUTING_KEY）。`calc_priority`（`:237`）排序逻辑：当 waiting_queue > 128 时 LPM 降级为 FCFS（避免昂贵的前缀匹配）；Cache-aware 策略先 `_compute_prefix_matches`（`:314`）做 in-batch 前缀匹配，维护独立 `waiting_queue_radix_tree`。

`PrefillAdder`（`:504`）是 prefill 请求的准入控制器。`add_one_req`（`:1201`）逐请求决策：计算 `total_tokens = extend_input_len + max_new + page_size + mamba_gap` → 检查 `rem_total_tokens` → `_lock_node` 锁定 radix 节点 → 三条路径（DLLM / 非 chunked / chunked）→ 返回 `AddReqResult`（CONTINUE / NO_TOKEN / OTHER）。

### ScheduleBatch 与 Req

`ScheduleBatch`（`schedule_batch.py:2002`）是 CPU 侧批次数据。`init_new`（`:2190`）从 reqs 列表构建。`prepare_for_extend`（`:2369`）准备 prefill 前向：计算 `input_ids`/`extend_num_tokens`/`seq_lens`/`prefix_lens`。`prepare_for_decode`（`:3038`）准备 decode 前向：分配 1 token 的 KV cache、`seq_lens += 1`。`merge_batch`（`:3211`）合并两个批次（continuous batching）。`retract_decode`（`:2816`）KV 内存不足时驱逐 decode 请求并从 radix cache evict。

`Req`（`schedule_batch.py:803`）是单请求状态：`rid`/`origin_input_ids`/`output_ids`（append-only）/`prefix_indices`/`last_node`/`sampling_params`/`finished_reason`/`to_finish`。

### DataParallelController 路由

`DataParallelController`（`data_parallel_controller.py:132`）在多 DP worker 场景下充当路由器。`LoadBalanceMethod`（`:79`）枚举：ROUND_ROBIN / FOLLOW_BOOTSTRAP_ROOM / TOTAL_REQUESTS / TOTAL_TOKENS。`DPBudget`（`:96`）通过共享内存 `load_snapshot_reader` 读取各 scheduler 负载快照。`refresh_load_budget`（`:300`）节流到 20ms 一次避免突发请求全落同一 rank。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
|------|----------------------|----------|
| Mixin 组合 | `Scheduler` 6 Mixin（`scheduler.py:383`） | 每个垂直特性独立，按需组合 |
| 策略模式 | `SchedulePolicy`（`schedule_policy.py:216`）；`DataParallelController.LoadBalanceMethod` | 调度/路由策略可配置切换 |
| 观察者模式 | `Watchdog`（`scheduler.py:414`）；`PoolStatsObserver`（`:646`）；`InvariantChecker`（`:648`） | idle/busy 时检查内存泄漏 |
| 工厂模式 | `ScheduleBatch.init_new`（`:2190`）；`dispatch_event_loop`（`:4902`） | 类方法创建批次；选择 event_loop 变体 |
| 命令模式 | `io_struct.py` 消息类继承 `BaseReq(msgspec.Struct)` | IPC 消息经 msgspec 序列化经 ZMQ 传输 |

## 模块间交互

`SchedulerIpcChannels`（`scheduler_components/ipc_channels.py:17`）管理 4 条 ZMQ 通道：`recv_from_tokenizer`（PULL）、`send_to_tokenizer`（PUSH）、`send_to_detokenizer`（PUSH）、`recv_from_rpc`（DEALER）。Scheduler 调 `TpModelWorker.forward_batch_generation`（`tp_worker.py:574`）桥接执行层。`TokenizerManager` 在主进程 asyncio：`handle_loop`（`:2199`）async ZMQ PULL 接收 DetokenizerManager 回传，`_handle_batch_output`（`:2214`）用 `state.event.set()` 唤醒 `_wait_one_response`。

## 扩展方式

#### 新增调度策略

1. 在 `CacheAwarePolicy`/`CacheAgnosticPolicy` 枚举中加成员（`schedule_policy.py:200/207`）
2. 在 `calc_priority`（`:237`）的 if-else 链中加分支
3. 实现对应 `_sort_by_*` 静态方法
4. 在 `ServerArgs` 中添加 `schedule_policy` 选项

#### 新增 Mixin

1. 定义 `SchedulerXxxMixin`，包含需要的 event_loop 变体和辅助方法
2. 在 `Scheduler` 基类列表中添加（`:383`），注意 MRO 顺序
3. 在 `__init__` 中添加 `init_xxx()` 调用
4. 在 `dispatch_event_loop`（`:4902`）中添加条件分支
