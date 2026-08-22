---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "执行引擎"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "向量化执行", "Pipeline", "Processor"]
description: "Databend 执行引擎——借鉴 ClickHouse 的 push-pull 处理器模型，无锁 CAS 背压端口，StableGraph DAG。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

执行引擎模块（`src/query/pipeline/`，crate `databend-common-pipeline` + `databend-common-pipeline-transforms`，~25k 行）是 Databend 的向量化执行核心。它将物理计划编译为 **Processor DAG**，以 push-pull 混合数据流模型驱动数据在算子间流动。设计灵感来自 ClickHouse 的处理器模型（`processor.rs:49` 注释 "The design is inspired by ClickHouse processors"），核心创新是**三标志位无锁 CAS 背压协议**——仅靠一个 `AtomicPtr` 实现完整的流控，无 channel/buffer/mutex 开销。

## 模块架构

执行引擎围绕四个核心抽象：`Pipeline`（DAG 图容器）、`Processor`（处理器，事件驱动状态机）、`InputPort`/`OutputPort`（端口，背压机制）、`Transform`/`Sink`/`Source`（业务 trait，模板方法屏蔽端口管理）。

```
PhysicalPlan → [PipelineBuilder] Pipeline(StableGraph<Node,Edge>)
                    │
          Node{Processor, inputs[], outputs[]}
                    │
          InputPort ←→ OutputPort (共享 SharedStatus)
                    │
          Executor: schedule_queue() 任务调度循环
```

## 调用链路

```
PhysicalPlan::build_pipeline(builder)      [physical_plan.rs:186]
└── build_pipeline2(builder)              — 各算子递归构建
    └── builder.main_pipeline.add_transform/add_source/add_sink
        → add_pipe(pipe)                  [pipeline.rs:205]
           → graph.add_node(Node) + add_edge(上游→当前)

ExecutingGraph::init_graph()              [executor_graph.rs:284]
└── connect(input_port, output_port)      — 端口共享 SharedStatus

ExecutingGraph::schedule_queue()          [executor_graph.rs:397]
└── 循环: processor.event() → match Event
    → Sync: 当前线程 process()
    → Async: 异步运行时 async_process()
    → NeedData/NeedConsume: Idle 等待
    → Finished: 完成
```

数据类型变化：`PhysicalPlan`（计划树）→ `Pipeline`（Processor DAG）→ `DataBlock`（列式块在 Processor 间流动）→ `SendableDataBlockStream`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Processor::event` | 返回下一步事件 | 事件驱动，解耦数据流与控制流 |
| `Pipeline::add_pipe` | 添加 PipeItem 连接 DAG | `sinks` 队列自动连接上下游 |
| `InputPort::pull_data` | 拉取数据 | CAS 清除 HAS_DATA\|NEED_DATA |
| `OutputPort::push_data` | 推送数据 | CAS 写入指针+设 HAS_DATA |
| `OutputPort::can_push` | 是否可推 | `NEED_DATA && !HAS_DATA` |
| `schedule_queue` | 调度循环 | UpdateTrigger 版本号去重 |

</details>

## 核心实现

### Event 事件驱动模型

`Processor` trait（`processor.rs:50`）的核心是 `event()` 方法返回 `Event` 枚举，Executor 不关心 Processor 内部状态，只根据 Event 决定调度：

```rust title="processor.rs"
pub enum Event {
    NeedData,     // 需要输入数据（等待上游 push）
    NeedConsume,  // 需要下游消费输出（等待下游 pull）
    Sync,         // 请求执行同步 process()
    Async,        // 请求执行异步 async_process()
    Finished,     // 已完成
}
```

**为什么 push-pull 混合**：纯 pull 模型（Volcano iterator）在列式 DB 中每次 `next()` 有虚函数开销，且无法表达多输入/多输出算子（如 ResizeProcessor 多输入汇聚）；纯 push 难实现背压。Databend 混合模型：数据方向是 push（`push_data`），控制方向是双向的（`set_need_data` 是 pull 信号），`event()` 统一返回 Event 解耦数据流与控制流。

### InputPort / OutputPort 无锁背压

`SharedStatus`（`port.rs`）将数据指针和三个标志位编码在一个 `AtomicPtr` 中（低 3 位复用），实现**无锁零拷贝背压**：

```rust title="port.rs"
const HAS_DATA: usize = 0b1;      // 有数据待消费
const NEED_DATA: usize = 0b10;    // 下游需要数据
const IS_FINISHED: usize = 0b100; // 已结束

pub struct SharedStatus {
    data: AtomicPtr<SharedData>,  // 指针 + 3-bit flags 复用
}
```

背压机制：(1) 下游 `set_need_data()` 设 `NEED_DATA` → 触发 `UpdateTrigger::update_input` 调度唤醒上游；(2) 上游 `can_push()` = `NEED_DATA && !HAS_DATA`，满足才 `push_data()`；(3) `push_data()` CAS 写入数据指针（设 `HAS_DATA`）；(4) 下游 `pull_data()` CAS 取出（清 `HAS_DATA|NEED_DATA`）；(5) 下游不 `set_need_data()` → 上游 `can_push()` 返回 false → 上游返回 `NeedConsume` 让出 CPU → 背压形成。

`connect(input, output)`（`port_trigger.rs`）让 InputPort 和 OutputPort 共享同一 `SharedStatus`。每个端口持有 `*mut UpdateTrigger`，状态变更时调 `update_input/update_output`，UpdateTrigger 用版本号去重避免同周期重复触发。

### Pipeline DAG 构建

`Pipeline`（`pipeline.rs:104`）用 petgraph 的 `StableGraph<Node, Edge>` 维护 DAG（StableGraph 删除节点后索引不变，对 `NodeIndex` 作 Processor ID 引用至关重要，且 `Pipeline::merge` 合并多图时简化偏移计算）。

```rust title="pipeline.rs"
pub struct Pipeline {
    max_threads: usize,
    sinks: VecDeque<(NodeIndex, usize)>,  // 当前尾端"悬挂"输出端口
    pub graph: StableGraph<Node, Edge>,
    // ...
}
```

`add_pipe`（`pipeline.rs:205`）逐层构建：每个 `PipeItem` 的输入端口自动连接到前一个 Pipe 的输出（通过 `sinks` 队列 pop），新输出 push 回队列。三种 PipeBuilder：`SourcePipeBuilder`（只有输出）、`SinkPipeBuilder`（只有输入）、`TransformPipeBuilder`（1:1 直通）。

### Transform / Sink / Source 模板

业务 trait 屏蔽端口状态管理，业务代码只需实现核心逻辑：

```rust title="transform.rs"
pub trait Transform: Send {
    fn transform(&mut self, data: DataBlock) -> Result<DataBlock>;  // 1:1
}
pub trait AccumulatingTransform: Send {
    fn transform(&mut self, data: DataBlock) -> Result<Vec<DataBlock>>;  // 1:N
}
pub trait BlockingTransform: Send {
    fn consume(&mut self, block: DataBlock) -> Result<()>;
    fn transform(&mut self) -> Result<Option<DataBlock>>;  // None=需更多输入
}
```

泛型包装器 `Transformer<T>`/`Sinker<T>`/`SyncSourcer<T>` 实现 `Processor` trait 处理端口状态，业务只需实现 `transform()`/`consume()`/`generate()`。

### 向量化执行

数据单元是 `DataBlock`（列式内存格式），非单行。`Transformer::event()` 每次从 InputPort 拉取一个完整 DataBlock 调 `transform()` 批量处理。`SyncSourcer::generate()` 每次产生一个 DataBlock（如 8192 行）。大块可被 `split_by_rows_no_tail(max_block_size)` 切分控制批次大小。

### 同步执行与 async 桥接

`QueryPipelineExecutor::execute`（`query_pipeline_executor.rs:280`）是**同步函数**，`execute_threads(threads_num)` 启动 N 个 `PipelineExecutor-{n}` OS 线程，每个线程从 DAG steal 就绪 Processor 执行。SELECT 查询用 `PipelinePullingExecutor`——创建 `async_channel::bounded(N)`，pipeline 末端加 `PullingSink` 发送 DataBlock 到 channel，`start()` 启动独立 OS 线程运行同步 `PipelineExecutor::execute()`，主 async 上下文通过 `tokio::select!` 从 channel 异步接收。这桥接了"同步 pipeline 执行"和"异步结果消费"。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Processor DAG | `pipeline.rs:104` StableGraph | 支持多输入/多输出算子，可 merge |
| Push 背压 | `port.rs` 三标志位 CAS | 无 channel/buffer/mutex，零拷贝 |
| 事件驱动状态机 | `processor.rs:32` Event | Executor 与 Processor 解耦 |
| 模板方法 | `Transformer<T>` 包装 Transform | 业务不直接操作端口 |
| UpdateTrigger | `port_trigger.rs:140` 版本号去重 | 避免同周期重复调度 |

## 模块间交互

`databend-common-pipeline`（core）依赖 `databend-common-expression`（DataBlock 类型）、`databend-common-base`（runtime/profile）、`petgraph`。`databend-common-pipeline-transforms` 依赖 core + expression + functions。执行器（`ExecutingGraph`/`QueryPipelineExecutor`）在 service crate 中，依赖以上两个 crate。Fuse 存储通过 `PhysicalTableScan::build_pipeline2` 调 `FuseTable::read_data` 向 pipeline 注入 source/transform processor。

## 扩展方式

**新增一个 Transform 算子**：在 `transforms/src/processors/transforms/` 新建文件实现 `Transform` trait（1:1）或 `AccumulatingTransform`（1:N）→ 在 `physical_plans/` 新建 `physical_xxx.rs` 实现 `IPhysicalPlan::build_pipeline2` 调 `pipeline.add_transform`。

**选择 Transform 子类型**：1→1 用 `Transform`；1→N 累积用 `AccumulatingTransform`；可能阻塞用 `BlockingTransform`；需异步 IO 用 `AsyncTransform`；多输入/输出（Resize/Shuffle/Exchange）直接实现 `Processor` trait 手动管理多端口。

**新增一个 Source**：实现 `SyncSource`/`AsyncSource` trait 的 `generate()` → `SyncSourcer::create()` 包装 → `pipeline.add_source()`。
