---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Parallel"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Parallel", "Morsel-Driven", "Pipeline", "TaskScheduler"]
description: "DuckDB Parallel 模块——Morsel-Driven 并行执行，Pipeline 5-Event 状态机，无锁队列工作窃取。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Parallel 模块负责 DuckDB 的并行执行框架——Pipeline 构建、Task 调度和 Morsel-Driven 并行。它将 Execution 模块的 `PhysicalOperator` 树拆分为可并行执行的 Pipeline，通过 5-Event 状态机管理 Pipeline 生命周期，用无锁队列实现工作窃取。DuckDB 的并行不是按数据分区分配线程，而是创建 `max_threads` 个 `PipelineTask` 共享同一个 Pipeline——每个任务处理一个 morsel（最多 50 个 chunk），空闲线程从全局队列窃取任务。

## 模块架构

![Pipeline 执行模型与事件状态机](/vibe-reading/images/articles/duckdb-internals/pipeline-execution.svg)

核心组件：`Executor`（并行执行器主入口，持有 pipelines/events/producer）、`Pipeline`（流水线抽象，source → operators[] → sink 三段式）、`PipelineExecutor`（单线程流水线执行器，每个 PipelineTask 持有一个）、`TaskScheduler`（线程池 + 无锁队列）、`Event` 类层次（5 种 Event 组成 DAG）。

每个 Pipeline 对应 5 个 Event 形成固定链：`PipelineInitializeEvent → PipelineEvent → PipelinePrepareFinishEvent → PipelineFinishEvent → PipelineCompleteEvent`。`MetaPipeline` 是共享同一 sink 的 Pipeline 组。`InterruptState` 支持 Operator 级异步阻塞（TASK/BLOCKING 两种模式）。

## 调用链路

### 查询执行入口

```
Executor::Initialize(physical_plan)                    [executor.cpp:377]
  ├→ TaskScheduler::CreateProducer()                    — 创建 ProducerToken
  ├→ MetaPipeline::Build(*physical_plan)                — 构建 Pipeline DAG
  ├→ MetaPipeline::Ready()                              — 反转 operators 顺序
  └→ ScheduleEvents(to_schedule)                        [executor.cpp:270]
       → ScheduleEventsInternal()                       [executor.cpp:179]
         ├→ 为每个 MetaPipeline: SchedulePipeline()     [executor.cpp:75]
         │    创建 5 个 Event + 依赖链
         ├→ 设置跨 Pipeline 依赖（pipeline.dependencies）
         ├→ 设置 JOIN_BUILD 的内存排序依赖
         └→ 无依赖的 Event 立即 Schedule()

Executor::ExecuteTask(dry_run)                          [executor.cpp:554]
  ├→ TaskScheduler::GetTaskFromProducer(producer, task)  — 从 ConcurrentQueue 拿 Task
  ├→ task->Execute(PROCESS_PARTIAL)                      [pipeline.cpp:33]
  │    → PipelineExecutor::Execute(PARTIAL_CHUNK_COUNT=50)  [pipeline_executor.cpp:188]
  │         循环:
  │           ├→ FetchFromSource(source_chunk)  — source->GetData → DataChunk
  │           ├→ ExecutePushInternal(source_chunk)  — 推过算子链
  │           │    → Execute(input, final_chunk)  — 逐算子 Execute()
  │           │    → Sink(sink_chunk)  — sink->Sink() 消费
  │           └→ PushFinalize()  — sink->Combine() 合并 local→global
  └→ 返回: TASK_NOT_FINISHED→重新入队; TASK_BLOCKED→Deschedule; TASK_FINISHED→清理
```

### Event 状态机推进

```
Event::CompleteDependency()                             [event.cpp:14]
  → ++finished_dependencies == total_dependencies?
    → Schedule()  — 子类创建 Task 并 SetTasks
    → 若 total_tasks == 0: Finish()

Task 执行完成:
  → Event::FinishTask()                                 [event.cpp:56]
    → ++finished_tasks == total_tasks?
      → Finish()                                        [event.cpp:27]
        → FinishEvent()  — 子类钩子
        → for each parent: parent->CompleteDependency()  — 传播到后续 Event
        → FinalizeFinish()  — PipelineCompleteEvent 在此递增 completed_pipelines
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Executor::Initialize` | 构建 Pipeline + 调度 Event | MetaPipeline::Build 递归遍历物理算子树 |
| `Executor::SchedulePipeline` | 为 Pipeline 创建 5-Event 链 | JOIN_BUILD 内存排序依赖 |
| `Executor::ExecuteTask` | 主线程取/执行 Task | PROCESS_PARTIAL 模式，每次 50 chunk |
| `Pipeline::ScheduleParallel` | 并行度计算+Task 创建 | max_threads = min(source/sink/operator MaxThreads) |
| `Pipeline::LaunchScanTasks` | 创建 max_threads 个 PipelineTask | 所有 Task 放入全局 ConcurrentQueue |
| `PipelineExecutor::Execute` | 单线程流水线执行 | in_process_operators 栈支持暂停/恢复 |
| `TaskScheduler::ExecuteForever` | 工作线程主循环 | 信号量等待+内存刷新 |
| `Event::CompleteDependency` | 依赖完成推进 | atomic 计数器无锁推进 |

</details>

## 核心实现

### Morsel-Driven 并行

DuckDB 不按数据分区分配线程，而是创建 `max_threads` 个 `PipelineTask` 共享同一个 Pipeline。每个任务处理一个 morsel（最多 `PARTIAL_CHUNK_COUNT = 50` 个 chunk），任务放入全局 `ConcurrentQueue`，任何空闲线程都可以 dequeue 执行——这就是隐式工作窃取，不需要显式的 per-thread 队列+偷取逻辑。Source 的 `GlobalSourceState` 负责协调多线程拉取（如 TableScan 的 scan ranges 分配），避免数据倾斜。`PARTIAL_CHUNK_COUNT = 50` 限制单次执行量，确保公平调度和及时响应中断。

### Pull-Push 模型的多线程工作

每个 `PipelineExecutor` 独立从 source 拉取 DataChunk，通过 `ExecutePushInternal` 推过算子链到 sink。多个 PipelineExecutor 共享 `source_state`/`sink_state`（全局状态），但各自有 `local_source_state`/`local_sink_state`（线程私有）。Sink 的 `Combine` 将 local state 合并到 global state——这是线程安全的汇聚点。`in_process_operators` 栈实现了算子的"还有更多输出"暂停恢复——当某算子返回 `HAVE_MORE_OUTPUT` 时，下次执行从该算子继续。

### 5-Event 状态机

每个 Pipeline 有 5 个 Event，按顺序构成 DAG。不同阶段有不同并行度：`PipelineEvent` 多线程执行 morsel，`PipelineFinishEvent` 单线程收尾。Event 之间通过 `finished_dependencies`/`finished_tasks` 原子计数器推进——当所有依赖完成时自动触发 `Schedule()`，当所有 task 完成时调用 `Finish()` 通知 parent Event。

**内存协调**：`PipelinePrepareFinishEvent` 在所有 join build 的 Combine 完成后触发，让算子通过 `TemporaryMemoryManager`（TMM）报告内存使用量。TMM 据此做全局内存分配决策——所有 join build 的内存使用量先汇总，然后 `PipelineFinishEvent` 阶段做全局分配。Event 依赖链精确控制了这一顺序（`executor.cpp:225-227`）。

### 无锁队列工作窃取

`ConcurrentQueue` 基于 moodycamel::ConcurrentQueue（无锁队列），所有任务放入单一全局队列。工作线程通过 `LightweightSemaphore` 唤醒——有任务时 `semaphore.signal`，空闲线程 `semaphore.wait`。`DequeueFromProducer` 允许主线程优先从自己的 ProducerToken 队列取任务（局部性优化），后台线程通过 `Dequeue` 从全局队列取。

### 中断/取消机制

两级中断：**Operator 级异步阻塞**——`InterruptState` 持有 `weak_ptr<Task>`，operator 返回 `BLOCKED` 后 task 被 `Deschedule` 加入 `to_be_rescheduled_tasks`，异步操作完成时 `Callback()` → `task->Reschedule()` 重新入队。**查询级取消**——`Executor::CancelTasks` 设置 `cancelled = true`，清空阻塞任务，排干正在执行的任务。`context.client.interrupted` 在每次 `StartOperator` 时检查，抛出 `InterruptException` 实现协作式中断。

### 线程空闲内存回收

`TaskScheduler::ExecuteForever`（`task_scheduler.cpp:271-338`）中集成内存刷新逻辑：线程空闲 0.5s 后触发 `ThreadFlush`，继续空闲则触发 `Allocator::ThreadIdle()` 将缓冲内存归还给 BufferManager。这使得空闲线程不持有不必要的内存。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Pipeline | `Pipeline` source→operators→sink | 流水线抽象，三段式 |
| Producer-Consumer | `ProducerToken` + `ConcurrentQueue` | Pipeline 间数据就绪信号传递 |
| Event-Driven | `Event` 类 + `CompleteDependency` | DAG 依赖管理，异步 I/O 支持 |
| Morsel-Driven | `LaunchScanTasks` + `PipelineExecutor::Execute` | 按数据批分配线程，自然工作窃取 |

## 模块间交互

Parallel 的 `PipelineExecutor` 直接调用 Execution 模块的 `PhysicalOperator` 虚函数：`GetData`/`Execute`/`Sink`/`Combine`/`Finalize`。Pipeline 的 source/sink/operators 都是指向 `PhysicalOperator` 的指针。`PipelineExecutor` 构造时用 `BufferAllocator::Get(context.client)` 初始化 intermediate chunks。`ClientContext::ExecuteTaskInternal`（`client_context.cpp:646`）调用 `executor->ExecuteTask()` 驱动执行——主线程既是提交者也是工作者。`PrepareFinalize` 阶段让算子通过 `TemporaryMemoryManager` 报告内存使用量，与 Storage 的 BufferManager 协调内存。

## 扩展方式

修改并行度策略：`src/parallel/pipeline.cpp` 的 `ScheduleParallel`（`:101-139`）修改 max_threads 计算逻辑 → `LaunchScanTasks`（`:179-193`）修改 task 切分方式 → `src/parallel/pipeline_executor.hpp` 的 `PARTIAL_CHUNK_COUNT` 修改 partial 执行的 chunk 数量。

新增一种 Event 类型：新建头文件继承 `BasePipelineEvent` 或 `Event` → 实现 `Schedule()`/`FinishEvent()` → `src/parallel/executor.cpp` 的 `SchedulePipeline`（`:75-177`）在 5-Event 链中插入新 Event 设置依赖 → `src/parallel/CMakeLists.txt` 添加源文件。仿照 `pipeline_finish_event.cpp`。
