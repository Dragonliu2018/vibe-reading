---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "Managers"
date: "2026-08-09T23:30:00+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.17"]
tags: ["SGLang", "managers", "Scheduler", "continuous batching", "overlap 调度", "ZMQ IPC"]
description: "SGLang 编排层：Scheduler 零开销双流调度、TokenizerManager/DetokenizerManager 三进程协作、SchedulePolicy 准入控制。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.17/00-overview)

---

## 模块定位

managers 是 SGLang 运行时的大脑。它把"收请求 → 组批 → 调度 → forward → 处理结果 → 出流"完整编排起来，是唯一同时持有调度状态机、KV cache 句柄与 TpModelWorker 的模块。`Scheduler` 子进程独占 GPU 与 NCCL 通信域，`TokenizerManager` 在主进程做 asyncio I/O，二者经 ZMQ 解耦——这个边界是整个系统能"CPU 调度与 GPU forward 重叠"的前提。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-internals/managers-architecture.svg)

模块围绕 `Scheduler`（`scheduler.py:370`）组织，但它不是单一大类，而是 **6 个 Mixin 组合**：`SchedulerDisaggregationDecodeMixin`、`SchedulerDisaggregationPrefillMixin`（PD 分离）、`SchedulerMultiplexMixin`（prefill/decode 多路复用）、`SchedulerPPMixin`（流水线并行）、`SchedulerDllmMixin`（扩散 LLM）、`SchedulerMlxOverlapMixin`（MLX 硬件 overlap）。`__init__`（`:392`）被刻意约束为"只编排 init_*/maybe_init_* 调用"，每个 Mixin 独立维护一个垂直特性的逻辑，避免巨型类。

围绕 Scheduler 有四组协作：**数据结构**（`ScheduleBatch`/`Req`/`NextBatchPlan`，CPU 侧批次与请求状态）、**策略**（`SchedulePolicy`（`:211`）排序 + `PrefillAdder`（`:490`）按 KV 预算准入）、**组件**（`scheduler_components/` 子包拆出 IpcChannels/RequestReceiver/BatchResultProcessor/OutputStreamer/MetricsReporter 等 ~12 个组件）、**进程协作**（`TokenizerManager` 接入、`DataParallelController` DP 路由、`DetokenizerManager` 出流、`TpModelWorker` 桥接执行层）。这种"核心类 + Mixin + Component 子包"的拆分，让一个 5000 行的调度核心仍可分域阅读。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-internals/managers-call-chain.svg)

核心是 `event_loop_normal`（`:1684`）/`event_loop_overlap`（`:1719`）的 while-True 循环。每轮：`request_receiver.recv_requests`（ZMQ PULL）收请求 → `process_input_requests`（`:1842`）`handle_generate_request` 把 `TokenizedGenerateReqInput` 封装成 `Req` 入 `waiting_queue` → `get_next_batch_to_run`（`:2962`）决定本批。

组批分两条路径。**prefill 路径**（`get_new_batch_prefill` `:3104`）：`SchedulePolicy.calc_priority` 排序 waiting_queue（cache-aware LPM/DFS-weight，队列>128 降级 FCFS 省排序开销）→ `PrefillAdder.add_one_req`（`:1187`）按 `rem_total_tokens`/`rem_chunk_tokens` 预算逐个准入 → `ScheduleBatch.init_new`（`:2164`）→ `prepare_for_extend`（`:2343`）调 `alloc_for_extend` 分配 KV slot 并做 `match_prefix` 前缀匹配。**decode 路径**：`filter_batch` 移除已完成 + `merge_batch` 把上轮 prefill 并入 running_batch + `mix_with_running`（chunked prefill+decode 混合，MIXED 模式）→ `prepare_for_decode`（`:3004`）`alloc_for_decode` 每 req 分 1 slot、`seq_lens+1`。

两路径汇入 `run_batch`（`:3573`）→ `TpModelWorker.forward_batch_generation`（`tp_worker.py:561`）→ `ForwardBatch.init_new` + `ModelRunner.forward` + `ModelRunner.sample` 返回 `GenerationBatchResult`。最后 `process_batch_result`（`:3861`）经 `batch_result_processor` + `output_streamer.stream_output` 把 `BatchTokenIDOutput` 经 ZMQ PUSH 发往 DetokenizerManager。overlap 模式下 `run_batch` 的结果不立即处理，而是 `batch.copy()` 浅拷贝后入 `result_queue` **延迟一步**，与当前 GPU forward 并行处理上一轮结果。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|--------------|
| `event_loop_normal` (`:1684`) | 串行调度循环 | recv→组批→forward→process 串行 |
| `event_loop_overlap` (`:1719`) | overlap 双流循环 | result_queue 延迟一步，CPU/GPU 并行 |
| `get_next_batch_to_run` (`:2962`) | 决定本批 + last_batch 合并 | continuous batching 的 prefill/decode 交替 |
| `run_batch` (`:3573`) | 调 TpModelWorker forward | overlap 时 forward_stream.wait(schedule_stream) |
| `process_batch_result` (`:3861`) | 结果处理 + 输出 | 经 output_streamer → ZMQ |
| `process_input_requests` (`:1842`) | 新请求入队 | handle_generate_request 封 Req |
| `ScheduleBatch.prepare_for_extend` (`:2343`) | prefill 张量准备 | alloc_for_extend + match_prefix |
| `ScheduleBatch.prepare_for_decode` (`:3004`) | decode 张量准备 | alloc_for_decode, seq_lens+1 |
| `ScheduleBatch.retract_decode` | OOM 驱逐请求 | 从 radix cache evict |
| `SchedulePolicy.calc_priority` (`:232`) | 排序 waiting_queue | 队列>128 降级 FCFS |
| `PrefillAdder.add_one_req` (`:1187`) | 准入控制 | 按 KV 预算 + chunked 预算 |
| `TokenizerManager.generate_request` (`:754`) | tokenize+分发+等待 | async generator + asyncio.Event |
| `DetokenizerManager.event_loop` (`:166`) | 增量 detokenize | batch_decode + trim_matched_stop |
| `DataParallelController.event_loop` (`:801`) | DP 路由 | dispatch_lookup 策略分发 |

</details>

## 核心实现

### Scheduler 双流 overlap 调度

`event_loop_overlap`（`:1719`）是 SGLang"零开销调度器"的核心。串行模式下 CPU 调度（请求排队、prefix matching、张量准备）与 GPU forward 串行：`[CPU 5ms][GPU 20ms][CPU 3ms][CPU 5ms][GPU 20ms]`。overlap 模式用 `result_queue: Deque` 暂存上一步结果，本批 forward 一启动（非阻塞）就回头处理上一批：`[CPU 5ms][GPU 20ms ─────][CPU 5ms][GPU 20ms]` 下方并行 `[CPU process 3ms]`。实现要点：`batch.copy()` 浅拷贝防 forward 改张量影响结果处理；`self._forward_isolation(batch, overlap=True)`（`:3620`）做张量隔离；`resolve_forward_inputs(batch, self.future_map)`（`:3618`）消费 staging buffer 实现 H2D 与计算重叠；`disable_overlap`（`:1793`）在连续两个 prefill 或 grammar sync 时退回串行。`@DynamicGradMode()`（`:1718`）管理梯度上下文。

### 连续批处理与 prefill/decode 切分

continuous batching 的核心在 `get_next_batch_to_run`（`:2962`）：prefill 与 decode 可在同 batch 交替。若 `last_batch.forward_mode.is_extend()`，其请求经 `filter_batch`+`merge_batch` 并入 `running_batch`（`:3014-3039`）；有新 prefill 优先执行 prefill，否则 decode。chunked prefill 用 `self.chunked_req` 跟踪分块请求（`:2988`），大请求分多次 extend。`prepare_for_extend` vs `prepare_for_decode` 的差异：前者 `input_ids=r.get_fill_ids()[prefix_len:]`（多 token）、`alloc_for_extend`；后者 `input_ids`=上步 1 token、`alloc_for_decode(token_per_req=1)`、`seq_lens+1`。MIXED 模式（`mix_with_running`）把 decode 请求以 1-token extend 混入 prefill batch。

### 三进程协作与 IPC

`SchedulerIpcChannels`（`ipc_channels.py:17`）frozen dataclass 管 ZMQ sockets：`recv_from_tokenizer`(PULL)、`recv_from_rpc`(DEALER)、`send_to_detokenizer`(PUSH)、`send_metrics`(PUSH)。仅 rank 0 的 Scheduler 创建接收 socket，rank>0 的 TP worker 只通过 NCCL 通信。`TokenizerManager` 与 `Engine` 同进程（直接引用），与 Scheduler/Detokenizer 经 ZMQ。`DataParallelController`（`data_parallel_controller.py:132`）DP>1 时路由请求，`dispatch_lookup`（`:158`）按 `LoadBalanceMethod`（ROUND_ROBIN/FOLLOW_BOOTSTRAP_ROOM/TOTAL_REQUESTS/TOTAL_TOKENS）选策略函数，`DPBudget`（`:96`）从共享内存负载快照更新预算。`DetokenizerManager`（`:90`）`event_loop` 收 `BatchTokenIDOutput`，`_decode_batch_token_id_output`（`:290`）增量 `tokenizer.batch_decode` + `trim_matched_stop`，产 `BatchStrOutput` 回 PUSH。消息分发用 `TypeBasedDispatcher`（`:156`）按消息类型路由，避免 if-elif 链。

### 两段式请求完成状态

`Req`（`schedule_batch.py:802`）的完成状态是两段式：`active → to_finish → finished_reason`。`to_finish` 是中间态——overlap 调度中请求可能在结果处理阶段被标记完成，但 forward 结果还在 `result_queue`，不能立即移除；待 `process_batch_result` 处理后才置 `finished_reason`（`None/stop/length/abort/connection_close`），再由 `filter_batch` 移出 batch。`abort` 由客户端断连触发，超时（running/waiting/queued 三类，`_abort_on_running_timeout` 等）与队列满（503）也走这条路。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Mixin 组合 | Scheduler 6 Mixin (`:370`) | 每个垂直特性独立，避免 5000 行巨型类 |
| 策略 | `SchedulePolicy` LPM/DFS/FCFS (`:211`)；`DataParallelController` `dispatch_lookup` (`:158`) | 调度与 DP 路由策略可配置切换 |
| 双流异步（零开销 overlap） | `event_loop_overlap` + `result_queue` (`:1719`) | CPU 调度与上轮 GPU forward 并行 |
| Component 拆分 | `scheduler_components/` 12 个组件 | 辅助功能独立维护（IPC/接收/输出/指标/…） |
| TypeBasedDispatcher | Detokenizer/DPController (`:156`/`:345`) | 按消息类型路由，替代 if-elif 链 |

## 模块间交互

向上与 `entrypoints`：`TokenizerManager` 被 `Engine` 主进程直接持有（同进程 asyncio），经 ZMQ PUSH/PULL 与 Scheduler/Detokenizer 子进程通信。向下与 `model_executor`：`Scheduler` 持有 `TpModelWorker`（`tp_worker.py:298`），后者持有 `ModelRunner`，`run_batch` → `forward_batch_generation` → `ModelRunner.forward`+`sample`。与 `mem_cache`：Scheduler 经 `kv_cache_builder.build_kv_cache` 持有 `tree_cache`/`token_to_kv_pool_allocator`/`req_to_token_pool`，调度时 `match_prefix` 前缀匹配，预算时 `allocator.available_size`，完成时 `release_kv_cache`→`cache_finished_req`。与 `speculative`：`maybe_init_draft_worker`（`:904`）创建 spec worker，`run_batch` 调 `model_worker.forward_batch_generation`（spec worker 覆盖了它），`on_publish` 回调让 verify 与下一轮 prep 重叠。进程拓扑与 ZMQ 细节见概览「运行时行为」。

## 扩展方式

新增调度策略：改 `schedule_policy.py` 的 `CacheAwarePolicy` 枚举 + `calc_priority`（`:232`）加分支 + 新增 `_sort_by_*`；`server_args.py` 扩 `schedule_policy` 合法值。event loop 与 PrefillAdder 不需改（准入与策略无关）。改 prefill/decode 比例：调 `PrefillAdder`（`:491`）的 `rem_total_tokens`/`rem_chunk_tokens` 预算计算与 `add_one_req`（`:1187`）阈值，或 `get_new_batch_prefill`（`:3104`）的 `max_prefill_bs` 衰减系数。新增 cache-aware DP 负载均衡：改 `data_parallel_controller.py` 的 `LoadBalanceMethod` 枚举 + `dispatch_lookup` + 新增 `*_scheduler` 方法 + `DPBudget.dispatch`，若需新负载数据则扩 `LoadSnapshot` 字段并在 `publish_load_snapshot` 上报。扩展点契约见概览「核心概念」。
