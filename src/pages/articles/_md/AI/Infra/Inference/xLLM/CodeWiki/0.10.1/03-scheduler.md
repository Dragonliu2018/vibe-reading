---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "请求调度器"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "Scheduler", "连续批处理", "PD 分离", "Chunked Prefill"]
description: "xLLM 请求调度器解读：ContinuousScheduler 主循环、PD 分离调度、Chunked Prefill、调度重叠与 RL pause/resume。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

请求调度器（`core/scheduler/`）决定"何时算、算哪些请求"。它管理请求优先队列、显存配额分配、prefill/decode 混合批处理、中断与重排。这层独立是因为调度策略多变（连续批处理、PD 分离、分块预填、零驱逐等），需要可切换；同时调度逻辑与执行逻辑正交——调度器只组织 `Batch`，执行交给 `Engine::step`。`~12.9k` 行 C++。

## 模块架构

```
scheduler/
├── scheduler.h                  # SchedulerBase + Scheduler 抽象接口
├── scheduler_factory.h/.cpp     # select_scheduler_kind + create_continuous_scheduler 工厂
├── continuous_scheduler.h/.cpp  # 主调度器（含 step/schedule_request/schedule_overlap）
├── chunked_prefill_scheduler     # 分块预填（长 prompt 分多步）
├── disagg_pd_scheduler           # PD 分离调度
├── disagg_pd_chunked_prefill_scheduler  # PD + 分块预填
├── pd_ooc_scheduler              # PD Out-of-Capacity（显存不足驱逐）
├── prefill_only_scheduler        # 仅预填实例（PD 中 P 端）
├── zero_eviction_scheduler       # 零驱逐调度
├── mix_scheduler                 # 在线/离线混部
├── fixed_steps_scheduler         # 固定步数（评测/对齐）
├── dit_scheduler                 # DiT 动态批调度
├── request_priority_queue        # 请求优先队列（fcfs/priority/deadline）
├── async_response_processor     # 异步响应处理（PD 跨实例回调）
├── perf_model.h/.cpp            # 延迟预测模型（latency-aware 调度）
└── profile/                     # 性能采集（step time / token budget / KV blocks）
```

`scheduler.h` 定义两级抽象：`SchedulerBase`（`step(timeout)` + `generate()`）与 `Scheduler`（增加 `add_request`/`get_waiting_requests_num`/`get_latency_metrics`）。`ContinuousScheduler` 是核心实现，其余调度器多继承自它或复用其逻辑。

## 调用链路

`ContinuousScheduler::step()` 的两条路径（是否启用 schedule_overlap）：

```text
step(timeout)                              in continuous_scheduler.cpp
├─ [pause 检查] try_complete_pause()       # RL pause/resume 支持
├─ if !enable_schedule_overlap:
│    ├─ schedule_request(timeout) → Batch  # 从优先队列选请求构建批
│    ├─ engine_->step(batch)                # 同步执行
│    └─ process_batch_output(false)        # 处理输出写回 Sequence
└─ else: step_with_schedule_overlap(timeout)
     ├─ schedule_request(timeout) → batch  # 当前批
     ├─ engine_->step(batch)                # 执行当前批
     ├─ engine_->update_last_step_result(last_batch_)  # 更新上一步结果
     ├─ process_batch_output(true)          # 处理上一步输出（replace_fake_token）
     └─ last_batch_ = move(batch)           # 滑动窗口
```

设计决策：**`enable_schedule_overlap` 的生产者-消费者重叠**。普通模式下 `schedule → step → output` 串行，GPU 在调度期间空闲。overlap 模式下，当 `engine_->step(当前batch)` 在 GPU 执行时，主线程同时 `update_last_step_result(上一步) + process_batch_output(上一步)`，实现"执行当前步 + 处理上一步"的流水线重叠。`replace_fake_token` 机制：overlap 时先填 fake token 占位，下轮用真实 token 替换，保证 Sequence 状态一致性。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `step(timeout)` | 单步调度+执行 | 检查 pause，分支 overlap |
| `schedule_request` | 选请求构建 Batch | 优先级排序 + 显存配额分配 |
| `add_request` | 请求入队 | 写 RequestPriorityQueue |
| `process_batch_output` | 输出写回 Sequence | SampleOutput → append_token |
| `generate()` | 离线全量循环 | while pending → step，阻塞到完成 |
| `pause`/`resume` | RL pause/resume | 阻塞 step 循环，wait_until_paused |

</details>

## 核心实现

### 调度器工厂与策略选择

`select_scheduler_kind()`（`scheduler_factory.cpp`）按配置优先级选择调度策略：

```cpp title="scheduler/scheduler_factory.cpp"
SchedulerKind select_scheduler_kind(const Options& options) {
  if (use_mix_scheduler) return SchedulerKind::MIX;
  if (options.enable_disagg_pd) {
    if (options.enable_pd_ooc) return SchedulerKind::PD_OOC;
    if (options.enable_chunked_prefill) return SchedulerKind::DISAGG_PD_CHUNKED_PREFILL;
    return SchedulerKind::DISAGG_PD;
  }
  if (options.enable_chunked_prefill) {
    if (enable_prefill_sp || num_speculative_tokens > 0) return SchedulerKind::PREFILL_ONLY;
    return SchedulerKind::CHUNKED_PREFILL;
  }
  if (use_zero_evict) return SchedulerKind::ZERO_EVICTION;
  return SchedulerKind::CONTINUOUS;
}
```

策略叠加规则：PD 分离优先级最高，其次 chunked prefill，最后默认连续批处理。每种组合映射到一个具体调度器类。新增策略只需在 `SchedulerKind` 枚举与 switch 增加分支。

### 请求优先队列

`RequestPriorityQueue` 支持 `fcfs`/`priority`/`deadline` 三种策略。`priority_strategy` 配置决定排序方式。在线请求有 TTFT/TPOT SLO（`ttft_slo_ms`/`tpot_slo_ms`），`perf_model` 预测延迟辅助 latency-aware 调度。`enable_online_preempt_offline` 允许在线请求抢占离线请求，保障在线 SLO。

### Batch 构建与 prefill/decode 混合

`schedule_request` 从队列取请求时，会尝试构建 prefill + decode 混合批（受 `max_tokens_per_batch` 与 `max_seqs_per_batch` 约束）。`chunked_prefill` 模式下，长 prompt 分多块预填（每块 `max_tokens_per_chunk_for_prefill`），避免单步过长阻塞 decode。Sequence 的 `stage()` 方法（`PREFILL`/`CHUNKED_PREFILL`/`DECODE`）实时反映其在批中的角色。

### RL pause/resume

为支持异步 RL 训练（推理-训练交替），`ContinuousScheduler` 增加暂停机制。`LLMMaster::pause_scheduler(mode)` 调 `continuous_scheduler->pause(PauseMode)`，`PauseMode` 有 `KEEP`（保留请求与 KV）、`ABORT`（终止请求释放 KV）、`WAIT`（等所有在途请求完成）。`wait_until_paused()` 阻塞直到循环线程真正停下，确保安全更新权重。`resume()` 恢复调度。

```cpp title="scheduler/continuous_scheduler.cpp"
void ContinuousScheduler::step(const absl::Duration& timeout) {
  if (try_complete_pause()) return;
  if (pause_state_.load() == PauseState::PAUSED) {
    std::unique_lock lock(pause_mutex_);
    pause_cv_.wait_for(lock, 100ms, []{ return pause_state_ != PAUSED; });
    return;  // 有界等待，避免 shutdown 死锁
  }
  // ... 正常调度执行
}
```

`step` 注释指出：用有界 `wait_for` 而非无限等待，因 Master 析构时不调 `resume()` 直接 join 循环线程，无限等待会死锁 shutdown。

## 模块间交互

- **依赖 Engine**：`Scheduler` 持有 `Engine*`，`step` 内调 `engine_->step(batch)`。
- **依赖 Framework**：构建 `Batch`（`framework/batch/`）、管理 `Sequence`（`framework/request/`）、分配 `Block`（`framework/block/`）。
- **被 Master 持有**：`LLMMaster` 构造时 `create_continuous_scheduler`，循环调 `step()`。
- **与 distributed_runtime 协作**：PD 模式下 `async_response_processor` 跨实例回调，`XServiceClient` 注册实例信息到 etcd。

## 扩展方式

- 新增调度策略：继承 `ContinuousScheduler`（或 `Scheduler`），在 `scheduler_factory.cpp` 的 `select_scheduler_kind` 与 switch 增加分支。
- 新增优先级策略：在 `request_priority_queue` 增加比较器，配置 `priority_strategy` 字段。
