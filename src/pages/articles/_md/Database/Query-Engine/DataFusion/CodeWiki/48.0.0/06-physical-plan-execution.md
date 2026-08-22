---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "物理计划与执行"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "ExecutionPlan trait（trait object DAG）、pull 模型流式执行、HashJoin/Aggregate/Sort/Repartition 算子与内存/cancellation。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/physical-plan`（63k 行，最大算子 crate）+ `execution` 定义物理执行 IR 与运行时：`ExecutionPlan` trait（算子 DAG）、`SendableRecordBatchStream`（列式异步流）、所有物理算子（join/aggregate/sort/repartition/filter/projection/limit）与执行运行时（`TaskContext`/`RuntimeEnv`/内存池）。它是"计划怎么跑"的承载——逻辑计划关心算什么，物理计划关心怎么并行、怎么流式、怎么向量化。

## 模块架构

```text
physical-plan/
├── execution_plan.rs    # ExecutionPlan trait + PlanProperties + 入口函数 collect/execute_stream
├── stream.rs            # SendableRecordBatchStream / RecordBatchStreamAdapter / Receiver builder
├── joins/               # HashJoinExec / SortMergeJoinExec / NestedLoopJoinExec / SymmetricHashJoinExec
├── aggregates/          # AggregateExec + AggregateMode + AggregateStream/GroupedHashAggregateStream/TopK
├── sorts/               # SortExec + ExternalSorter + TopK（spill）
├── repartition/         # RepartitionExec（RoundRobin/Hash，N×M channel 矩阵）
├── filter.rs projection.rs limit.rs union.rs unnest.rs  # 基础算子
├── spill/ metrics/      # 磁盘 spill / 指标
└── visitor.rs display.rs  # 遍历与 EXPLAIN 输出
execution/
├── runtime_env.rs       # RuntimeEnv（memory_pool/disk_manager/cache_manager/object_store_registry）
├── task.rs              # TaskContext
└── stream.rs            # RecordBatchStream trait / SendableRecordBatchStream 定义
```

## 调用链路

执行入口 `collect(plan, context)`（`execution_plan.rs:944`）：0 分区返空流，1 分区直接 `plan.execute(0, ctx)`，>1 分区用 `CoalescePartitionsExec` 合并后执行。`execute_stream_partitioned`（`:1022`）对每分区调 `plan.execute(i, ctx)` 得独立流并行 poll。

```text
collect(plan, task_ctx)
 → execute_stream(plan, ctx) → plan.execute(0, ctx)  # 返回 SendableRecordBatchStream
 → stream.try_collect()  # poll 拉取所有 RecordBatch → Vec
```

算子 `execute(partition, context)` 同步返回 `Result<SendableRecordBatchStream>`（非 async），流在被 poll 时才增量计算。文档（`:228`）明确："Most ExecutionPlan's should not do any work before the first RecordBatch is requested."

## 核心实现

### ExecutionPlan trait：trait object DAG

```rust title="datafusion/physical-plan/src/execution_plan.rs:78"
pub trait ExecutionPlan: Debug + DisplayAs + Send + Sync {
    fn properties(&self) -> &PlanProperties;            // 缓存等价类/分区/排序/emission/boundedness
    fn required_input_distribution(&self) -> Vec<Distribution>;   // 对子节点的分布需求
    fn required_input_ordering(&self) -> Vec<Option<LexRequirement>>;  // 对子节点的排序需求
    fn benefits_from_input_partitioning(&self) -> Vec<bool>;
    fn children(&self) -> Vec<&Arc<dyn ExecutionPlan>>;
    fn with_new_children(self: Arc<Self>, children: Vec<Arc<dyn ExecutionPlan>>) -> Result<Arc<dyn ExecutionPlan>>;
    fn execute(&self, partition: usize, context: Arc<TaskContext>) -> Result<SendableRecordBatchStream>;
    fn supports_limit_pushdown(&self) -> bool;
    fn gather_filters_for_pushdown(&self, …) -> Result<FilterDescription>;
    // … metrics / partition_statistics / fetch / with_fetch
}
```

用 `Arc<dyn ExecutionPlan>`（trait object）而非 enum：支持用户自定义算子（UDF 数据源、自定义 join），第三方 impl 注册新算子无需改 DataFusion 源码；`as_any()` 提供 downcast（`need_data_exchange` 用 `downcast_ref::<HashJoinExec>()` 检查具体类型，`:892`）。`DisplayAs` 分离自 `Debug`（`Debug` 需 `Sized` 不能用于 trait object），支持 `Default`/`Verbose`/`TreeRender` 三种 EXPLAIN。

### pull 模型流：背压与 cancellation

`SendableRecordBatchStream = Pin<Box<dyn RecordBatchStream + Send>>`（`execution/src/stream.rs`），消费端 `StreamExt::next()` 拉取。pull 模型天然背压——不 poll 不推进，避免生产超消费。`RecordBatchReceiverStreamBuilder`（`:211`）用于多生产者单消费者：spawn 多 task 经 mpsc channel 发 batch。**cancellation**：返回的 stream 被 drop 时必须释放资源，后台 task 用 `SpawnedTask`（Drop 时 abort），`JoinSet` 在 stream drop 时自动 abort 所有 task——这是取消的核心机制（`:256`）。算子需定期 yield（`tokio::task::yield_now()` 或返回 `Pending`）避免长占 CPU 无法响应取消。

### HashJoinExec：build/probe 两阶段

`hash_join.rs:325`：**Build 阶段**把 left 所有 batch 读入内存建 `JoinHashMap`（LIFO 反向遍历保留顺序），`JoinLeftData` 封装 hash_map/batch/visited bitmap/MemoryReservation；**Probe 阶段**右 batch 流式到达，逐行 hash 查表，`build_batch_from_indices` 构建输出。`PartitionMode`（`joins/mod.rs:50`）：`CollectLeft`（左收单分区，`OnceAsync` 共享 build，所有输出流等同一 build）、`Partitioned`（左右同分区数，每分区独立 build+probe）、`Auto`（优化器选）。硬编码 `HASH_JOIN_SEED`（`:90`）确保 hash 与 RepartitionExec 不同避免碰撞。

### AggregateExec：Partial/Final 两阶段

`aggregates/mod.rs:377`，`execute_typed`（`:605`）按输入选三种流：无 GROUP BY→`AggregateStream`；有 GROUP BY + limit + 非 distinct→`GroupedTopKAggregateStream`；其他→`GroupedHashAggregateStream`。`AggregateMode`（`:69`）：`Partial`（并行，输出 state）、`Final`（单分区合并 state）、`FinalPartitioned`（按 group key hash 分区，各分区合并）、`Single`/`SinglePartitioned`。`required_input_distribution`（`:947`）精确表达每种模式需求。`CombinePartialFinalAggregate` 物理规则把相邻 Partial+Final 合并为 Single。

### SortExec 与 RepartitionExec：spill 与状态机

`SortExec`（`sorts/sort.rs:835`）的 `ExternalSorter`（`:195`）做外部排序：内存够缓冲，不够则排序已缓冲 batch 并 spill 到磁盘（Arrow IPC），输入耗尽合并内存 batch + spill 文件。`execute`（`:1089`）有四优化路径：排序已满足+有 fetch→`LimitStream`；排序已满足无 fetch→直接返输入流；不满足+有 fetch→`TopK` 堆只留前 N；不满足无 fetch→全量 `ExternalSorter`。`RepartitionExec`（`repartition/mod.rs:474`）状态机 `NotInitialized→InputStreamsInitialized→ConsumingInputStreams`，`execute` 建 N×M channel 矩阵，每输入分区 spawn `SpawnedTask`（`pull_from_input`）经 `BatchPartitioner`（RoundRobin/Hash）分发到输出 channel；`preserve_order=true` 用 `StreamingMergeBuilder` 保序合并。

### 内存管理

`TaskContext`（`execution/src/task.rs:36`）封 session 配置 + UDF 注册表 + `Arc<RuntimeEnv>`。`RuntimeEnv`（`runtime_env.rs:72`）管 `MemoryPool`/`DiskManager`/`CacheManager`/`ObjectStoreRegistry`。算子经 `MemoryConsumer::new(name).register(pool)` 得 `MemoryReservation`，`try_grow()` 不足返 Err 触发 spill。三种池：`GreedyMemoryPool`（有界先到先得）、`UnboundedMemoryPool`（测试）、`TrackConsumersPool`（包装器追最大消费者）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Strategy | 每算子 impl `ExecutionPlan`，`Arc<dyn ExecutionPlan>` 组 DAG | 算子多态 + 用户自定义算子 |
| Visitor | `ExecutionPlanVisitor`（`visitor.rs`）、`DisplayableExecutionPlan` | DFS 遍历 + EXPLAIN |
| Stream/Iterator | `SendableRecordBatchStream` poll 模型 | 背压 + async I/O 并发 |
| State Machine | `RepartitionExecState`（`repartition/mod.rs:89`） | 显式状态转换初始化 |
| Decorator | `ObservedStream`（`stream.rs:461`） | 包装流记 BaselineMetrics |

## 模块间交互

依赖 `physical-expr`（表达式求值、`EquivalenceProperties`/`Partitioning`/`Distribution`）、`execution`（TaskContext/RuntimeEnv/stream）、`common`。被 `core`（`physical_planner.rs` 构造 `DataSourceExec` 等、`collect` 执行）、`physical-optimizer`（`with_new_children` 重写）调用。`Filter Pushdown` 框架：`gather_filters_for_pushdown`/`handle_child_pushdown_result` 自顶向下收集 filter 自底向上处理，`HashJoinExec` 可推 bloom filter 到 scan，`DataSourceExec` 吸收 filter 做存储层下推。

## 扩展方式

- **新增自定义 ExecutionPlan 算子**：impl `ExecutionPlan` 六必需方法（`name`/`as_any`/`properties`/`children`/`with_new_children`/`execute`）+ `DisplayAs`，`execute` 用 `RecordBatchStreamAdapter::new(schema, stream)` 包装或 `RecordBatchReceiverStreamBuilder` 处理多生产者，正确设 `PlanProperties`（尤其 `partitioning`/`eq_properties`，优化器依赖），有内存需求经 `MemoryConsumer` 申请。参考 `execution_plan.rs:294-401` 三种 execute 示例。
- **新增 join 算法**：参考 `joins/hash_join.rs`，impl struct（left/right/on/filter/join_type）+ `compute_properties` + `execute` 返回自定义 stream + `required_input_distribution` + `maintains_input_order`，复用 `joins/utils.rs` 的 `build_batch_from_indices`/`build_join_schema`。
- **自定义分区策略**：在 `Partitioning` enum（`physical-expr/src/partitioning.rs:114`）加变体，更新 `partition_count`/`satisfy`/`project`/`Distribution::create_partitioning`，`RepartitionExec::BatchPartitionerState` 加对应逻辑，grep `match.*Partitioning` 更新所有位置。
