---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "Acero 执行引擎"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "Acero", "执行引擎"]
description: "Acero push-based 流式执行引擎——ExecNode 多输入单输出、单调 counter 背压、双线程池调度与 HashJoin 实现"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

`cpp/src/arrow/acero/`（~44k 行）是 Arrow 的**流式查询执行引擎**。它把一组 `compute` kernel 串成一条 push-based 流水线（filter→project→join→aggregate→sink），提供并行调度、背压与可组合性。Acero 取代了旧的 `compute::ExecPlan`，是 Dataset Scanner 的执行底座，也可被任何查询引擎（DataFusion）直接驱动。核心思想：用 **push 模型**替代经典 Volcano 的 `next()` pull 模型，以 batch 为单位流动数据，契合向量化计算与异步 I/O。

## 模块架构

```
┌─────────────── 用户高层 API ───────────────┐
│  Declaration 链 → DeclarationToTable       │  exec_plan.h:651-796
│    （自动建 plan + 追加 sink + Start）      │
└──────────────────┬─────────────────────────-┘
                   │ EmplaceNode
┌──────────────────▼─────────────────────────-┐
│  ExecPlan (exec_plan.h:54, pimpl:Impl)       │  节点所有权 + 拓扑序
│    ├─ nodes_  sorted_nodes_  finished_       │
│    └─ query_context_                          │
└──────────────────┬─────────────────────────-┘
                   │ 持有
┌──────────────────▼─────────────────────────-┐
│  QueryContext (query_context.h:36)            │
│    ├─ executor()  CPU 线程池                  │
│    ├─ io_context() I/O 线程池                 │
│    ├─ TaskScheduler + AsyncTaskScheduler     │
│    └─ memory_pool()                          │
└──────────────────┬─────────────────────────-┘
                   │ 装配节点
┌──────────────────▼─────────────────────────-┐
│  ExecNode (exec_plan.h:125)                  │  多输入(inputs_) 单输出(output_)
│   ├─ SourceNode    持 AsyncGenerator，pull   │  source_node.cc
│   ├─ MapNode       单输入无状态基类          │  map_node.h:44
│   │    ├─ FilterNode   执行 filter 表达式    │  filter_node.cc
│   │    └─ ProjectNode  执行 projection       │
│   ├─ HashJoinNode  build/probe 两输入        │  hash_join_node.h
│   ├─ AggregateNode 分组聚合                 │  aggregate_node.h
│   └─ SinkNode      PushGenerator 输出+背压   │  sink_node.cc:102
└─────────────────────────────────────────────-┘
   交互：InputReceived(push 数据) / Pause-Resume(背压) / StartProducing
```

## 调用链路

构建与执行两阶段：

```
构建：Declaration::AddToPlan(plan, registry)      exec_plan.cc:572
  └─ 递归构建 inputs → MakeExecNode(factory_name, plan, inputs, opts)  exec_plan.h:376
       └─ registry->GetFactory → factory(plan, inputs, opts) → EmplaceNode

执行：ExecPlan::StartProducing()                   exec_plan.cc:96
  └─ AsyncTaskScheduler::Make → ctx->Init
  └─ 各节点 n->Init()
  └─ ctx->scheduler()->StartScheduling
  └─ sorted_nodes_ = TopoSort                     exec_plan.cc:240
  └─ 逆拓扑序遍历，每节点 StartProducing()

数据流（push）：SourceNode → FilterNode → SinkNode
  SourceNode::StartProducing                      source_node.cc:166
    └─ Loop: generator_() 拉一个 morsel
       └─ SliceAndDeliverMorsel → output_->InputReceived(this, batch)   PUSH
  MapNode(Filter)::InputReceived(input, batch)     map_node.cc:71
    └─ ProcessBatch(batch)   子类执行 filter/project
    └─ output_->InputReceived(this, out_batch)     PUSH 下游
    └─ input_counter_.Increment → Finish()
  SinkNode::InputReceived                         sink_node.cc:224
    └─ RecordBackpressureBytesUsed → 可能 PauseProducing 上游
    └─ producer_.Push(batch)    消费者异步拉取
    └─ RecordBackpressureBytesFreed → 低水位则 ResumeProducing
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `ExecPlan::Make` (`exec_plan.cc:59`) | 建计划 | pimpl，`kMaxBatchSize=32768` |
| `MakeExecNode` (`exec_plan.h:376`) | 工厂建节点 | 从 `ExecFactoryRegistry` 取构造器 |
| `StartProducing` (`exec_plan.cc:96`) | 启动全图 | 逆拓扑序，producer 先于 consumer |
| `SourceNode::StartProducing` (`source_node.cc:166`) | 拉 generator | 异步 loop，背压 future 阻塞 |
| `MapNode::InputReceived` (`map_node.cc:71`) | 收 batch 处理转发 | 模板方法，子类实现 `ProcessBatch` |
| `SinkNode::InputReceived` (`sink_node.cc:224`) | 收集输出 | PushGenerator + 背压 reservoir |
| `PauseProducing`/`ResumeProducing` (`exec_plan.h:289`) | 背压控制 | 单调 counter 去竞态 |
</details>

## 核心实现

### Push 模型与 ExecNode 生命周期

`ExecNode`（`exec_plan.h:125`）有**多输入**（`inputs_` vector，支持 join）但**单输出**（`output_` 单指针，树形拓扑，构造时自动注册 `output_`，`exec_plan.cc:462`）。核心上游 API 是 `InputReceived(ExecNode* input, ExecBatch batch)`——上游主动 push 数据到本节点，而非下游 pull。**为什么 push 而非 Volcano pull**：pull 每行多次虚函数调用且难内联；push 以 batch（≤32768 行，`exec_plan.h:57`）为单位一次传递，分摊开销、契合 SIMD 向量化、数据到达即处理利于流水线；且对异步 I/O 友好（SourceNode 从 AsyncGenerator 拉到即可 push，I/O 与计算重叠）。生命周期状态：`Init`→`StartProducing`↔`PauseProducing`/`ResumeProducing`→`StopProducing`，由 `ExecPlan` 拓扑排序驱动。

### 背压机制

当 SinkNode 积累数据超限，需让上游暂停生产，否则内存爆炸。Acero 用**高低水位线 + 单调 counter**：

```cpp title="options.h:369 BackpressureOptions"
struct BackpressureOptions {
  int64_t resume_if_below = 256 /*MiB*/;   // 低水位
  int64_t pause_if_above  = 1024;         // 高水位
};
```

`BackpressureHandler`（`backpressure_handler.h:50`）在每次队列操作时检查是否跨越水位线：`start < high && end >= high`→Pause，`start > low && end <= low`→Resume。`BackpressureConcurrentQueue`（`concurrent_queue_internal.h:116`）用 `DoHandle` RAII 在锁范围内自动触发检查。**为什么用 counter 而非 boolean**（`exec_plan.h:278` 注释详述）：pause/resume 以不同速度穿越 plan，若 resume 比 pause 先到 source，source 会误判下游已满而停产出死锁。每个调用带单调递增 `int32_t counter`，`SourceNode::PauseProducing`（`source_node.cc:239`）忽略 `counter <= backpressure_counter_` 的旧调用，确保只有最新调用生效。

### 任务调度双线程池

`QueryContext`（`query_context.h:36`）提供两个独立线程池：CPU 池（`executor()`，Arrow 全局线程池）与 I/O 池（`io_context()`）。I/O 任务不占 CPU 线程，`SourceNode` 的 generator 调用通过 `CallbackOptions::should_schedule=IfDifferentExecutor`（`source_node.cc:186`）自动在两池间切换。`TaskScheduler`（`task_util.h:58`）管理 parallel-for 式 task group（`RegisterTaskGroup`/`StartTaskGroup`），HashJoin 的 build/probe 阶段即通过 task group 并行。`AsyncTaskScheduler`（`util`）在 `StartProducing` 创建（`exec_plan.cc:129`），管整个查询异步生命周期，`concurrent_tasks = 2 * num_threads`（`exec_plan.cc:164`）限在途任务。`use_threads=false` 时退化为 `SerialExecutor`。**为什么双池**：避免 I/O 阻塞吃掉 CPU 线程，让计算与 I/O 真正重叠。

### HashJoin

`HashJoinImpl`（`hash_join.h:40`）有两套实现：`MakeBasic()` 与 `MakeSwiss()`（Swiss table，更现代）。接口分 build/probe 两阶段：`BuildHashTable(thread_index, AccumulationQueue batches, on_finished)` 把 build 侧数据建成哈希表，`ProbeSingleBatch(thread_index, batch)` 用 probe 侧数据探测。build 阶段通过 task group 多线程并行，完成后才开始 probe。`HashJoinSchema`（`hash_join_node.h`）处理投影映射与 schema 对齐。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Push-based Pipeline | `InputReceived`（`exec_plan.h:225`） | 减少虚函数开销、契合向量化与异步 I/O |
| Backpressure | `BackpressureHandler`+counter（`backpressure_handler.h:50`、`exec_plan.h:289`） | 流控防内存爆炸，counter 去竞态 |
| Factory/Registry | `default_exec_factory_registry`+`ExecFactoryRegistry::AddFactory`（`exec_plan.cc:1108`） | 节点可扩展，内置集在首次访问注册 |
| Template Method | `MapNode::InputReceived`→`ProcessBatch`（`map_node.h:44`、`map_node.cc:71`） | 无状态单输入节点共用骨架 |
| TracedNode | `util.h:146`（多数节点继承） | OpenTelemetry span 自动追踪节点执行 |
| PIMPL | `ExecPlanImpl`（`exec_plan.cc:59`） | 公开头不暴露内部 vector/future |

## 模块间交互

依赖 **compute**（filter/project/aggregate 调 `CallFunction`/`ExecuteScalarExpression`，Expression 可序列化让计划跨进程传输）、**核心类型**（`Schema`/`Table`/`RecordBatch`/`Buffer`/`MemoryPool`）、**dataset**（`SourceNode` 的 generator 由 `Scanner` 产出）、**io**（`IOContext`）、**util**（`AsyncTaskScheduler`/`PushGenerator`/`ThreadPool`/`Future`）。被 **Dataset Scanner** 驱动（`scanner.cc` 把扫描编译成 Acero 计划）。高层用户通常不直接建 `ExecNode`，而用 `Declaration`+`DeclarationToTable` 等便捷方法（自动建 plan、加 sink、启动）。

## 扩展方式

- **新增 ExecNode 类型**（如 `SortNode`）：在 `options.h` 加 `SortNodeOptions`，新建 `sort_node.cc`（无状态单输入则继承 `MapNode` 实现 `ProcessBatch`，pipeline breaker 则直接继承 `ExecNode`），提供 `static Make` 工厂，在 `exec_plan_internal.h` 声明 `RegisterSortNode`，在 `DefaultRegistry`（`exec_plan.cc:1108`）注册。
- **自定义 Sink 消费者**：实现 `SinkNodeConsumer` 接口（`options.h:472`），配合 `ConsumingSinkNodeOptions` 用 `Declaration("consuming_sink", ...)`。无需新建节点类，`ConsumingSinkNode`（`sink_node.cc:287`）内部实现背压。
- **自定义工厂不改编码**：`default_exec_factory_registry()->AddFactory("my_node", MyNode::Make)`，即可在 `Declaration("my_node", ...)` 中用。
