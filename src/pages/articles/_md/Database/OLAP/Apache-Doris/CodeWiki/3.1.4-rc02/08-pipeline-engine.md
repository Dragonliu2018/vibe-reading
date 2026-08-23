---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Pipeline 引擎"
date: "2026-08-23T19:03:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "Pipeline", "拉模型", "MLFQ", "Work Stealing", "Backpressure"]
description: "Doris 3.1.4 Pipeline 引擎：Pull 拉模型 + MLFQ 多级反馈队列 + Work Stealing，固定线程池背压调度。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

Pipeline 引擎是 `be/src/pipeline/`（~3.8 万行）+ 部分 `exec/`，核心是 `TaskScheduler`（`pipeline/task_scheduler.cpp`）与 `PipelineFragmentContext`（`pipeline_fragment_context.cpp`，1901 行）。它是 Doris BE 的执行调度核心，用 Pull 拉模型替代旧 Volcano push 模型：算子按需 pull `Block`，天然支持背压、公平调度、工作窃取。独立成文是因为执行模型与算子语义分离——调度策略（MLFQ + Work Stealing）与算子实现解耦，可独立调优，且这是 3.x 替代旧执行器的关键演进。

## 模块架构

```
FragmentMgr.exec_plan_fragment (RPC 入口)
   │
   ▼
PipelineFragmentContext (pipeline_fragment_context.cpp)
   ├─ build_pipelines ── PlanFragment → Pipeline DAG (Source→Operator→Sink)
   ├─ build_dependencies ── Pipeline 间依赖（Exchange）
   └─ submit_tasks
   │
   ▼
TaskScheduler (pipeline/task_scheduler.cpp)
   ├─ start() ── ThreadPool(cores) 固定线程池，每核一线程
   └─ _do_work(index) ── 每线程循环
        ├─ task_queue.take(index) ── 取任务
        ├─ task->execute(&eos) (pipeline_task.cpp) ── 执行
        ├─ eos + is_pending_finish → 阻塞队列等依赖
        ├─ eos + close → _close_task
        └─ 否则回队列
   │
   ▼
TaskQueue (pipeline/task_queue.h:36)
   ├─ SubTaskQueue ── vruntime = runtime/_level_factor (:73)
   ├─ PriorityTaskQueue ── MLFQ, SUB_QUEUE_LEVEL 级 (task_queue.h:89)
   │     └─ level 限: 1s/3s/10s/... (:112)
   └─ MultiCoreTaskQueue (:127) ── 每核一队列 + _steal_take 窃取
```

## 调用链路

```
FE gRPC exec_plan_fragment
  └─ FragmentMgr.exec_plan_fragment
       └─ PipelineFragmentContext (per fragment)
            ├─ build_pipelines ── 算子树 → Pipeline (Source/Operator/Sink)
            ├─ create_tasks ── 每个 Pipeline → PipelineTask
            └─ TaskScheduler.schedule_task(task) (task_scheduler.cpp:69)
                 └─ _task_queue->push_back(task)
  └─ TaskScheduler._do_work(index) (task_scheduler.cpp:93)
       ├─ task = _task_queue->take(index)
       ├─ task->set_running(true)
       ├─ status = task->execute(&eos) (pipeline_task.cpp)
       ├─ if canceled → _close_task
       ├─ if !status.ok → cancel fragment + _close_task
       ├─ if eos:
       │    ├─ if is_pending_finish → 阻塞队列等依赖就绪
       │    └─ else → _close_task + finalize
       └─ else → set_running(false), 回 MultiCoreTaskQueue
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `TaskScheduler.start` (`:53`) | 启动线程池 | 固定线程=核数，无队列上限(0)，cgroup 限 CPU |
| `_do_work` (`:93`) | 线程主循环 | take→execute→按 eos/cancel 分流 |
| `schedule_task` (`:69`) | 入队 | push 到 TaskQueue |
| `MultiCoreTaskQueue.take` | 取+窃取 | 本核空则 `_steal_take` 从他核偷 |
| `PipelineTask.execute` | 执行算子 | pull 一批 Block，eos 标志 |

</details>

## 核心实现

### Pull 拉模型与背压

`PipelineTask.execute(&eos)`（`pipeline_task.cpp`）的执行是**拉**式：Sink 向上游 Operator pull 一批 `Block`，上游再向 Source pull，链式驱动数据流动。当下游 Sink 阻塞（如 Exchange 缓冲满），上游 Operator 自然停止 pull——背压沿链向上传播，无需显式流控。

设计决策：**为何 pull 而非 push**——push 模型（旧 Volcano）数据由 Source 推向 Sink，需额外流控防止下游被压垮；pull 模型下游主动要多少上游给多少，背压是免费的，且任务可随时暂停回队列（协作式调度），天然适配多查询公平共享 CPU。

### MLFQ + Work Stealing 调度

`PriorityTaskQueue`（`task_queue.h:89`）是多级反馈队列（MLFQ）：`SUB_QUEUE_LEVEL` 级子队列，每级有运行时间上限（`:112` 的 1s/3s/10s/...）。任务按实际 runtime 越级，`vruntime = runtime / _level_factor`（`:73`）做归一化比较，`_try_take_unprotected`（`:59`）选 vruntime 最小的队列取任务。`MultiCoreTaskQueue`（`:127`）每核一队列，本核空时 `_steal_take` 从他核窃取最久没运行的任务。

设计决策：**为何 MLFQ**——长查询（CPU 密集）会沉到低优先级级，短查询（交互式点查）留在高级级优先响应，避免长查询饿死短查询。Work Stealing 解决负载不均：某核空闲就偷他核任务，提升整体利用率。两者结合既公平又高效。

### 固定线程池与 cgroup 限流

`start()`（`:53`）建固定线程池（`min=max=cores`，`max_queue_size=0` 即无界），每核一线程 `_do_work(i)`。`_cgroup_cpu_ctl`（`:59`）通过 cgroup 限制 BE 进程 CPU，使同机多 BE 或其他服务不被饿死。`pipeline_tracer_context`（`:141`）可选记录每个任务的执行 trace，供性能分析。

### Pipeline DAG 装配

`PipelineFragmentContext`（1901 行）把 `PlanFragment` 翻译成 Pipeline DAG：`build_pipelines` 按算子树建 Pipeline（每个含 Source/Operator/Sink），`build_dependencies` 连接 Pipeline 间 Exchange 依赖，`create_tasks` 把每个 Pipeline 实例化为可调度的 `PipelineTask`。`local_exchange/` 处理同 BE 内多 instance 的本地数据交换，`query_cache/` 缓存重复查询的中间结果。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 拉模型（Pull） | `PipelineTask.execute` | 背压免费、协作式调度 |
| MLFQ 调度 | `PriorityTaskQueue` | 长/短查询公平，防饿死 |
| Work Stealing | `MultiCoreTaskQueue._steal_take` | 负载均衡，提升利用率 |
| DAG 装配 | `PipelineFragmentContext` | 算子树→可调度任务，依赖显式 |

## 模块间交互

`pipeline/` **依赖** `vec/`（算子用向量化 Block/Column）、`runtime/`（`ExecEnv` 持 `TaskScheduler`、`FragmentMgr`、`MemTracker`）、`olap/`（scan 算子读存储）。`local_exchange`/依赖 `runtime/` 的数据流管理。被 `runtime/FragmentMgr` 调用入口。`dependency.h` 定义算子间依赖（阻塞/就绪）。

## 扩展方式

新增一个执行算子：在 `pipeline/exec/` 下加 Operator（继承对应 Source/Operator/Sink 基类），实现 `get_data`/`sink`/`pull` 等，在 `PipelineFragmentContext` 的算子翻译表注册。调整调度策略改 `task_queue.h` 的 `PriorityTaskQueue` 级限/level_factor。对应测试：`be/test/pipeline/`、`regression-test/suites/pipeline_p0/`。
