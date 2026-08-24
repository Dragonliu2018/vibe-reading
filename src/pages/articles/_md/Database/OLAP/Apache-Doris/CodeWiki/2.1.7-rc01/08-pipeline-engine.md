---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Pipeline 引擎"
date: "2026-08-24T10:22:21+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.7-rc01"]
tags: ["Apache Doris", "Pipeline", "拉模型", "MLFQ", "Work Stealing", "Backpressure", "pipelineX"]
description: "Doris 2.1.7 Pipeline 引擎：Pull 拉模型 + MLFQ 多级反馈队列 + Work Stealing + 9 态 Operator 状态机，pipeline/pipelineX 双轨。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.7-rc01/00-overview)

---

## 模块定位

Pipeline 引擎是 `be/src/pipeline/`（~3.7 万行，151 文件）+ 部分 `exec/`，核心是 `TaskScheduler`（`pipeline/task_scheduler.cpp`）与 `PipelineXFragmentContext`（`pipeline_x/pipeline_x_fragment_context.cpp`）。它是 Doris BE 的执行调度核心，用 Pull 拉模型替代旧 Volcano push 模型：算子按需 pull `Block`，天然支持背压、公平调度、工作窃取。独立成文是因为执行模型与算子语义分离——调度策略（MLFQ + Work Stealing）与算子实现解耦，可独立调优。2.1 中 pipeline 与 pipelineX 双轨并存（`enablePipelineEngine`/`enablePipelineXEngine` 均默认 true，experimental），pipelineX 是更激进的下一代（Dependency 异步唤醒替代轮询）。

## 模块架构

```
FragmentMgr.exec_plan_fragment (runtime/fragment_mgr.cpp:653) ── RPC 入口
   │  [enable_pipeline_x_engine] (:953) 选 PipelineXFragmentContext
   ▼
PipelineXFragmentContext (pipeline_x/pipeline_x_fragment_context.cpp)
   ├─ _build_pipelines() (h:138)  ── PlanFragment → Pipeline DAG
   │    └─ _create_operator()  ── TPlanNode → OperatorX 递归构建
   ├─ _create_data_sink() (h:158)  ── TDataSink → SinkOperatorX
   └─ submit()  ── PipelineXTask::prepare + schedule_task
   │
   ▼
TaskScheduler (pipeline/task_scheduler.cpp:206) ── 固定线程池(=核数)
   ├─ start() (:206)  ── cores 个线程跑 _do_work(i)
   ├─ _do_work(index) (:264)  ── worker 主循环
   │    ├─ _task_queue->take(index)  ── 取任务
   │    ├─ task->execute(&eos)  ── 执行
   │    └─ 按 state: BLOCKED→blocked_scheduler / RUNNABLE→回队列 / eos→close
   └─ _blocked_task_scheduler  ── 单线程轮询解除阻塞（pipelineX 改用 Dependency）
   │
   ▼
TaskQueue (pipeline/task_queue.h)
   ├─ SubTaskQueue (:62)  ── vruntime = runtime/_level_factor
   ├─ PriorityTaskQueue (:92)  ── MLFQ, SUB_QUEUE_LEVEL=6 级 (:111)
   │    └─ _queue_level_limit (:114)  ── {1s,3s,10s,60s,300s} 阈值
   └─ MultiCoreTaskQueue (:129)  ── 每核一队列 + _steal_take 窃取
```

## 调用链路

Fragment → Pipeline → Operator 拓扑 → TaskScheduler 调度，Pull 模型数据驱动：

```
FragmentMgr::exec_plan_fragment [fragment_mgr.cpp:653]
  → PipelineXFragmentContext::prepare [pipeline_x_fragment_context.cpp:189]
    → _build_pipelines() (h:138)
      → 递归遍历 TPlanNode 树, _create_operator 创建 OperatorX
        → OLAP_SCAN → OlapScanOperatorX
        → EXCHANGE → ExchangeSourceOperatorX
        → AGGREGATION → 新建 Pipeline + Sink/Source 对
      → cur_pipe->set_sink_builder(child_sink_builder)
    → _build_pipeline_tasks()
      → pipeline->build_operators() + new PipelineXTask(pipeline, ...)
      → task->prepare(runtime_state)  ── 初始状态 RUNNABLE
  → context->submit()
    → TaskScheduler::schedule_task(task) [task_scheduler.cpp:223]
      → _task_queue->push_back(task)

[Worker]
TaskScheduler::_do_work(index) [task_scheduler.cpp:264]
  → _task_queue->take(index)  ── 本核 try_take, 空 _steal_take 偷别的核
  → task->execute(&eos) [pipeline_x_task.cpp:229]
    → _open() → 逐个 operator->open() + sink->open()
    → while (!canceled):  ← Pull 模型主循环
      → source_can_read()? 否 → BLOCKED_FOR_SOURCE break
      → sink_can_write()? 否 → BLOCKED_FOR_SINK break
      → time_spent > THREAD_TIME_SLICE(100ms)? → yield break
      → _root->get_block_after_projects(state, block, eos)  ← Pull 一个 Block
      → _sink->sink(state, block, eos)  ← Push 到下游
      → eos? → _finish_p_dependency() 唤醒下游
    → 按 state 决定: BLOCKED→blocked / RUNNABLE→回队列 / eos→close
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `PipelineXFragmentContext._build_pipelines` | Fragment→Pipeline DAG | 递归构建 Source→Operator→Sink |
| `PipelineXTask.execute` | Pull 执行循环 | get_block→sink，超 100ms yield |
| `TaskScheduler._do_work` | worker 主循环 | take→execute→按 state 分流 |
| `MultiCoreTaskQueue.take` | 取任务 | 本核优先，空则 _steal_take |
| `PriorityTaskQueue._compute_level` | MLFQ 分级 | 按 runtime 分级，vruntime 归一 |
| `BlockedTaskScheduler._schedule` | 解除阻塞 | 单线程轮询，pipelineX 改用 Dependency |

</details>

## 核心实现

### Pull 模型与背压

`PipelineXTask::execute` 核心行（`pipeline_x_task.cpp:229`）：
```cpp title="pipeline_x_task.cpp"
RETURN_IF_ERROR(_root->get_block_after_projects(_state, block, _data_state));
```
`_root` 是算子链末端，`get_block` 递归调用上游直到 Source 从存储/RPC 拉取数据。`source_can_read()` 为 false 时 `set_state(BLOCKED_FOR_SOURCE)` 挂起让出 CPU；`sink_can_write()` 为 false 时阻塞形成天然反压（避免内存暴涨）。`THREAD_TIME_SLICE`（100ms，`pipeline_task.h:201`）时主动 yield，长查询不独占线程。

### MLFQ 多级反馈队列

`PriorityTaskQueue`（`task_queue.h:92`）含 6 级 `SubTaskQueue`（`SUB_QUEUE_LEVEL=6` `:111`），`_queue_level_limit`（`:114`）= `{1s,3s,10s,60s,300s}` 累计运行时间阈值，`LEVEL_QUEUE_TIME_FACTOR=2`（`:110`）每级 `level_factor` 倍增，vruntime = runtime / level_factor。`_compute_level` 按 task 累计 runtime 计算应入哪级——长查询降级到低优先级，短查询不被饿死。空队列入队时 `adjust_runtime` 拉齐 vruntime 避免新 task 过度抢占。

### Work Stealing

`MultiCoreTaskQueue`（`task_queue.h:129`）每核一个 `PriorityTaskQueue`。`take(core_id)`（`task_queue.cpp`）先 `try_take(false)` 取本核，空则 `_steal_take(core_id)` 轮询其他核 `try_take(true)`。`push_back(task, core_id)` 优先放回同核（缓存亲和性），`get_previous_core_id` 记忆上次执行的核减少 cache miss。

### Operator 9 态状态机

`PipelineTaskState`（`pipeline_task.h:69`）定义 9 态：`NOT_READY → BLOCKED_FOR_DEPENDENCY/SOURCE/SINK/RF → RUNNABLE → PENDING_FINISH → FINISHED/CANCELED`。`BLOCKED_FOR_RF` 等 runtime filter；`PENDING_FINISH` 计算完成但持有异步资源（如未完成 RPC），需 `is_pending_finish` 返回 false 后才 close。状态转换在 `set_state`（`pipeline_task.cpp`）实现，附带 wait timer 统计。

### pipeline vs pipelineX

`FragmentMgr::exec_plan_fragment`（`fragment_mgr.cpp:953`）按 `enable_pipeline_x_engine` 选择：true → `PipelineXFragmentContext`（`OperatorX` + `PipelineXTask` + `Dependency` + `SharedState`），false → `PipelineFragmentContext`（`OperatorBase` + `PipelineTask`）。pipelineX 关键差异：`PipelineXTask::is_pending_finish`（`pipeline_x_task.h:95`）通过 `Dependency::set_ready` 异步唤醒（blocking queue），而非 `BlockedTaskScheduler` 轮询（pipelineX 直接返回不加入 blocked 队列）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Pull 模型 | `PipelineXTask.execute` get_block in `pipeline_x_task.cpp:229` | 按需拉数据，天然背压，避免空转 |
| Pipeline DAG | `add_dependency` in `pipeline.h` | HashJoin build/probe 依赖，finish_one_dependency 唤醒 |
| MLFQ | `PriorityTaskQueue` in `task_queue.h:92` | 长查询降级，短查询不饿死，vruntime 归一可比 |
| Work Stealing | `MultiCoreTaskQueue._steal_take` in `task_queue.cpp` | 负载均衡，缓存亲和 |

## 模块间交互

`pipeline` 被 `runtime` `ExecEnv` 初始化（`exec_env_init.cpp:308` `init_pipeline_task_scheduler`）、调用 `vec/` 向量化执行（`OperatorX` 内部调 `vectorized::Block`）、调用 `olap/` 读取存储（`OlapScanOperatorX` → `BlockReader`）。被 `FragmentMgr`（`runtime/fragment_mgr.cpp`）接收 FE Thrift RPC `exec_plan_fragment` 调用，由 `QueryContext::get_pipe_exec_scheduler()` 获取 scheduler。

## 扩展方式

**新增一个 Operator**（pipelineX）：在 `pipeline/exec/` 新建 `my_operator.h/.cpp` 继承 `OperatorX<MyOperatorLocalState>`（`pipeline_x/operator.h`），实现 `setup_local_state`/`get_block_after_projects`/`can_read`；在 `PipelineXFragmentContext._build_pipelines`（`pipeline_x_fragment_context.cpp`）的 switch 为对应 `TPlanNodeType` 加 `add_operator`；FE 端在 PlanNode 枚举生成该算子。**修改调度策略**：时间片改 `THREAD_TIME_SLICE`（`pipeline_task.h:201`）；MLFQ 级别/阈值改 `_queue_level_limit`（`task_queue.h:114`）和 `LEVEL_QUEUE_TIME_FACTOR`（`:110`）。对应测试：`be/test/pipeline/`、`regression-test/suites/pipeline/`。
