---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "执行流水线"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "IProcessor", "拉模型", "PipelineExecutor", "WorkStealing"]
description: "ClickHouse 拉模型执行流水线源码解读——IProcessor DAG、无锁 Port、PipelineExecutor work-stealing 调度与异步 I/O。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/Processors/` + `src/QueryPipeline/` 是 ClickHouse 的拉模型执行引擎——也是其最核心的架构创新。`IProcessor` 是流水线处理单元（pull-based，被上游 pull 后 `work()`），多个 processor 连成 DAG；`PipelineExecutor` 调度执行。它独立成模块因为执行模型独立于计划表示与存储——同一套调度器跑任意 step 树产出的 DAG。

## 模块架构

```text
src/Processors/
  ├─ IProcessor.h         ── 处理单元抽象基类 + Status 状态机
  ├─ Port.h               ── Port/InputPort/OutputPort（无锁 CAS push/pull）
  ├─ ISource.h            ── 源 processor 基类
  ├─ Executors/
  │  ├─ PipelineExecutor.h/.cpp     ── 推拉混合调度器（主入口）
  │  ├─ ExecutingGraph.h/.cpp      ── 执行图（Node+Edge，updateNode 核心）
  │  ├─ ExecutorTasks.h/.cpp       ── 任务队列（work stealing + upscale）
  │  ├─ TasksQueue.h                ── per-thread 队列模板
  │  ├─ ExecutionThreadContext.h   ── 每线程上下文（condition variable）
  │  └─ PollingQueue.h             ── 异步任务 epoll 队列
  └─ QueryPlan/QueryPlan.h         ── step 树（见查询计划器）
src/QueryPipeline/
  ├─ QueryPipeline.h       ── 流水线封装（pulling/pushing/completed 三模式）
  ├─ Pipe.h                ── Pipe = 一组 OutputPort + processor 集合
  └─ QueryPipelineBuilder.h── 建造者（init/addTransform/resize/setSinks/execute）
```

## 调用链路

从 QueryPlan 到 PipelineExecutor 执行：

```text
QueryPlan::buildQueryPipeline() in QueryPlan.h:128
  └─ 后序遍历 step 树，每 step 调 IQueryPlanStep::updatePipeline(pipelines, settings)
     └─ 每 step 把自己转成 IProcessor，通过 QueryPipelineBuilder::addTransform 加入
        └─ Pipe::addTransform → connect(OutputPort &, InputPort &) 建边
  → QueryPipelineBuilder::execute() in QueryPipelineBuilder.cpp:920
     └─ PipelineExecutor(pipe.processors, process_list_element) in PipelineExecutor.cpp:112
        └─ ExecutingGraph 构造：为每 processor 建 Node，为每端口连接建 Edge（正向+反向）
  → PipelineExecutor::execute(num_threads, concurrency_control) in PipelineExecutor.cpp:199
     └─ executeImpl → initializeExecution（graph->initializeExecution 找叶子节点 prepare）
        → spawnThreads 启动工作线程
        → 每线程 executeStepImpl 循环：
           1. tasks.tryGetTask（work stealing）
           2. context.executeTask → processor->work()
           3. graph->updateNode（processor->prepare 重新检查 + 传播端口变化给邻居）
           4. tasks.pushTasks（本地优化 + 唤醒空闲线程）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `IProcessor::prepare` in `IProcessor.h` | 轻量检查端口状态决定下一步 | O(1) 不阻塞 |
| `IProcessor::work` in `IProcessor.h` | CPU 密集计算 | 可在不同 processor 间并行 |
| `IProcessor::schedule` in `IProcessor.h` | 异步 I/O（返回 epollable fd） | 与 work 分离 |
| `Port::State::push/pull` in `Port.h` | 无锁 CAS 数据交换 | 原子指针低位存 flag |
| `ExecutingGraph::updateNode` in `ExecutingGraph.cpp:288` | 调度核心：prepare + 传播 | 沿边传播端口变化 |
| `PipelineExecutor::executeImpl` in `PipelineExecutor.cpp:706` | 主调度循环 | spawnThreads + processAsyncTasks |
| `ExecutorTasks::tryGetTask` in `ExecutorTasks.cpp:78` | 获取任务 | work stealing |
| `QueryPipelineBuilder::execute` | builder→executor | 建造者收口 |

</details>

## 核心实现

### IProcessor：状态机分离 prepare/work/schedule

```cpp title="src/Processors/IProcessor.h"
class IProcessor {
    InputPorts inputs;
    OutputPorts outputs;
public:
    enum class Status : uint8_t {
        NeedData,       // 需上游数据才能继续
        PortFull,       // 输出端口满或下游不需要数据
        Finished,       // 全部完成
        Ready,          // 可调 work() 做同步计算
        Async,          // 可调 schedule() 做异步操作（网络 I/O）
        UpdatePipeline, // 需动态修改 DAG（增删 processor）
    };
    virtual Status prepare() = 0;            // 轻量、不阻塞
    virtual void work() {}                   // 重量、CPU 密集
    virtual int schedule() { return 0; }     // 返回 epollable fd
    std::atomic<bool> is_cancelled{false};
    uint64_t elapsed_ns, input_wait_elapsed_ns, output_wait_elapsed_ns;
};
```

三方法严格分离：`prepare()` 是 O(1) 轻量方法（检查端口、决定下一步），`work()` 是重量方法（CPU 密集，可在不同 processor 间并行），`schedule()` 是异步方法（I/O 等待，返回 fd 给 epoll）。注释明确"method 'work' can be executed in parallel for different objects, even for connected processors"——拉模型让调度器清楚知道哪些 work() 可安全并行。

### Port：无锁 CAS push/pull

```cpp title="src/Processors/Port.h"
class Port {
    struct State {
        std::atomic<Data *> data;   // 原子指针，低位存 3 个 flag：IS_FINISHED|IS_NEEDED|HAS_DATA
        void push(DataPtr & data, uintptr_t & flags);  // CAS 写入
        void pull(DataPtr & data, uintptr_t & flags);  // CAS 取出
    };
    const SharedHeader header;        // 列结构契约
    std::shared_ptr<State> state;     // 连接的 InputPort/OutputPort 共享
    struct UpdateInfo {
        UInt64 version = 0, prev_version = 0;  // 版本号追踪
        void update() { if (version == prev_version) update_list->push_back(id); ++version; }
    };
};
```

`InputPort` 和 `OutputPort` 通过共享 `State` 连接，原子指针低位 3 flag 管理 `IS_FINISHED`/`IS_NEEDED`/`HAS_DATA`，实现无锁 push/pull。`UpdateInfo` 的版本号机制让调度器精确知道哪些相邻 processor 需要重新 `prepare()`——`update()` 递增 version，相邻 `prepare()` 结束 `trigger()` 记 prev_version，下次 version != prev_version 说明有变化。

### ExecutingGraph：DAG 调度核心

```cpp title="src/Processors/Executors/ExecutingGraph.h"
class ExecutingGraph {
    struct Edge {
        Node * to;
        bool backward;          // true=反向(input→output), false=正向(output→input)
        InputPort * input_port;
        OutputPort * output_port;
    };
    struct Node {
        Processors::iterator processor_iter;
        Edges direct_edges;     // 正向边：OutputPort→下游 InputPort
        Edges back_edges;       // 反向边：InputPort→上游 OutputPort
        ExecStatus status;      // Idle/Preparing/Executing/Finished/Async
        std::mutex status_mutex;
        std::exception_ptr exception;
        UpdatedInputPorts updated_input_ports;   // 自上次 prepare 变化的端口
        UpdatedOutputPorts updated_output_ports;
    };
    UpdateNodeStatus updateNode(Node * start, Queue & queue, Queue & async_queue);
};
```

每个端口连接生成正向边（output→input）和反向边（input→output）——`updateNode` 沿两个方向传播变化，形成"波"，直到所有受影响节点都被 `prepare()`。这支持任意拓扑（Join 2 输入、Union N 输入、Resize N→M、Fork 1→N），不仅线性 pipeline。

### PipelineExecutor：推拉混合调度

```cpp title="src/Processors/Executors/PipelineExecutor.h"
class PipelineExecutor {
    ExecutingGraphPtr graph;
    ExecutorTasks tasks;
    SlotAllocationPtr cpu_slots;   // CPU slot 分配（并发控制）
    std::unique_ptr<ThreadPool> pool;
    void execute(size_t num_threads, bool concurrency_control);
    void executeSingleThread(size_t thread_num, WorkloadResources &&);
};
```

`initializeExecution` 找无输出的叶子节点推入 stack，循环 `updateNode`。`spawnThreads` 启动工作线程。每线程循环：`tryGetTask`（work stealing）→ `executeTask`（调 `processor->work()`）→ `updateNode`（`prepare()` 重新检查）→ `pushTasks`（本地优化+唤醒）。

### Work stealing 与异步 I/O

```cpp title="src/Processors/Executors/TasksQueue.h"
template<typename Task> class TaskQueue {
    std::vector<Queue> queues;   // 每线程一个队列
    Task * pop(size_t thread_num) {
        auto t = getAnyThreadWithTasks(thread_num);  // 自己空了偷别人的
        return queues[t].pop();
    }
};
```

`ExecutorTasks` 有三队列：`task_queue`（常规）、`fast_task_queue`（异步完成的高优先任务）、`async_task_queue`（`PollingQueue`，epoll 等待）。`pushTasks` 第一个任务留给自己（避免全局队列竞争），但限 ≤128 次（`max_scheduled_local_tasks`）防饥饿。`upscale`/`downscale`/`preempt`/`resume` 根据任务量与 CPU 资源动态调活跃线程数。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 | `IProcessor::Status` + `ExecStatus` | 两层状态机，Owning vs Non-owning 避免忙等 |
| 管道/拉模型 | `IProcessor` + `Port` | 消费者驱动生产，天然背压 |
| 建造者 | `QueryPipelineBuilder` | 分离构建与执行，支持 pipeline 级优化 |
| 图调度 | `ExecutingGraph` + `updateNode` | 支持任意 DAG 拓扑 |
| Work stealing | `TaskQueue` | 负载均衡，快线程偷慢线程任务 |
| 策略 | `allocateCPU` 多 CPU 分配策略 | slot-based/lease/workload |

## 重要设计决策

### 为什么拉模型而非推模型（Volcano）

背压天然实现——下游 `isNeeded()==false` 时上游 `prepare()` 返回 `PortFull`，调度器不调其 `work()`，数据不堆积。调度器完全控制哪个 processor 何时/何线程执行，可优先调度靠近 source 的。`work()` 可在不同 processor 间并行（注释明确），拉模型让调度器清楚知道哪些可安全并行。避免推模型递归 push 的深调用栈与栈溢出。

### Status 状态机怎么避免忙等

版本号通知（端口 `UpdateInfo` 变化通知邻居重 `prepare`）+ 所有权语义（`ExecStatus` 区分 Owning/Non-owning，Idle 节点不被任何线程拥有，Edge 传播到才激活）+ 条件变量等待（全队列空时 `context.wait` 在 condition variable 阻塞，非忙等）+ epoll 异步等待（`Async` 状态的 fd 注册 `PollingQueue`，主线程 `processAsyncTasks` 在 epoll 阻塞）。

## 扩展方式

新增 processor：建 `src/Processors/Transforms/MyTransform.h` 继承 `IProcessor`，实现 `getName`/`prepare`/`work`；`prepare` 检查 input.isFinished/hasData，pull→push 变换数据，返回合适 Status。无需改调度器——`PipelineExecutor`/`ExecutingGraph` 通过 IProcessor 抽象处理任意 processor。新增异步 I/O source：继承 `ISource`，`prepare` 返回 `Async`，`schedule`/`scheduleForEvent` 返回 fd，调度器已完整支持 Async 流程（pushTasks 注册 epoll，完成推入 fast_task_queue）。

## 模块间交互

依赖 `Core`（Block/Chunk）、`Common`（ThreadPool、ConcurrencyControl、ISlotControl、MemorySpillScheduler）。被 `Interpreters` 通过 `QueryPipelineBuilder` 使用——Interpreter 构建 QueryPlan，`buildQueryPipeline` 得到 builder，`execute()` 得到 executor。IProcessor 之间通过 `connect(OutputPort &, InputPort &)` 连接共享 State。`CompletedPipelineExecutor` 驱动完整流水线（无外部端口），`PullingAsyncPipelineExecutor` 供 handler 拉结果块。
