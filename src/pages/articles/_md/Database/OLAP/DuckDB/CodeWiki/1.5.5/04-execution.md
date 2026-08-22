---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Execution"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Execution", "Vectorized", "PhysicalOperator"]
description: "DuckDB Execution 模块——向量化执行引擎，Pull-Push 混合流水线模型，PhysicalOperator 三角色（Source/Operator/Sink）。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Execution 模块负责将优化后的 `LogicalOperator` 树转换为可执行的 `PhysicalOperator` 树，并定义向量化执行的核心接口。它是 DuckDB 性能优势的核心——向量化执行（每次处理 2048 行的 DataChunk 批次）配合 Pull-Push 混合流水线模型，在高吞吐扫描场景下达到接近手写循环的性能。实际的并行调度由 Parallel 模块的 `PipelineExecutor` 驱动，Execution 模块定义算子接口和表达式执行器。

## 模块架构

`PhysicalOperator` 基类定义三组核心接口：**Operator**（中间算子，`Execute` 处理输入→输出）、**Source**（数据源，`GetData` 产出 DataChunk）、**Sink**（数据汇，`Sink` 消费 + `Combine` 合并 + `Finalize` 收尾）。一个 PhysicalOperator 可以同时扮演多种角色——`PhysicalHashJoin` 在 build 阶段是 Sink（构建哈希表），probe 阶段是 Operator（探测），内存不够做 external join 时还会变成 Source（溢出数据重探）。

`ExpressionExecutor` 负责向量化表达式求值，通过 `ExpressionState` 树镜像 Expression 的子表达式结构。`JoinHashTable` 和 `GroupedAggregateHashTable` 是两个核心哈希表实现，都使用线性探测 + Radix 分区支持外部 join/aggregate。

物理算子按功能分为 12 类（`src/execution/operator/` 下）：scan、aggregate、join、filter、projection、order、helper、persistent、schema、set、csv_scanner。物理计划生成由 `PhysicalPlanGenerator` 的 `CreatePlan(LogicalXxx&)` 重载完成，每种逻辑算子对应一个 `plan_xxx.cpp` 文件。

## 调用链路

```
PhysicalPlanGenerator::Plan(op)                       [physical_plan_generator.cpp:23]
  └→ ResolveAndPlan(op)
       ├→ op->ResolveOperatorTypes()                  — 类型推导
       ├→ ColumnBindingResolver::VisitOperator(op)    — 列绑定解析
       └→ PlanInternal(op) → CreatePlan(op)            [physical_plan_generator.cpp:70]
            └→ switch(LogicalOperatorType):
                 ├→ LOGICAL_AGGREGATE_AND_GROUP_BY → CreatePlan(LogicalAggregate&)
                 │    [plan_aggregate.cpp:235]
                 │    └→ 按统计选择: UngroupedAggregate / PerfectHash / Partitioned / Hash
                 ├→ LOGICAL_COMPARISON_JOIN → CreatePlan(LogicalComparisonJoin&)
                 │    └→ 按条件选择: HashJoin / NestedLoopJoin / PiecewiseMergeJoin / IEJoin
                 └→ ... (~40 种)

执行时（由 Parallel 模块驱动）:
PipelineExecutor::Execute(max_chunks)                  [pipeline_executor.cpp:188]
  └→ 循环:
       ├→ FetchFromSource(source_chunk)                — source->GetData() → DataChunk
       ├→ ExecutePushInternal(source_chunk)             — 推过算子链
       │    └→ Execute(input, final_chunk)              — 逐算子 Execute()
       │    └→ Sink(sink_chunk)                         — sink->Sink() 消费
       └→ PushFinalize()                                — sink->Combine() 合并 local→global
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `PhysicalPlanGenerator::CreatePlan` | 逻辑→物理 switch 分派 | Arena 分配器管理算子生命周期 |
| `PhysicalOperator::Execute` | 中间算子处理 | 返回 HAVE_MORE_OUTPUT 支持暂停/恢复 |
| `PhysicalOperator::GetData` | Source 产出 DataChunk | 通过 TableFunction 间接调存储层 |
| `PhysicalOperator::Sink/Combine/Finalize` | Sink 消费+合并+收尾 | Combine 是多线程汇聚点 |
| `ExpressionExecutor::Execute` | 表达式向量化求值 | switch on ExpressionClass 分派 |
| `CachingPhysicalOperator::Execute` | 小 chunk 缓冲 | CACHE_THRESHOLD=64，防止小 chunk 传播 |
| `JoinHashTable::ScanStructure::NextInnerJoin` | 哈希表探测 | 线性探测，每 join 类型一个方法 |

</details>

## 核心实现

### 向量化执行（DataChunk 批处理）

每次处理 `STANDARD_VECTOR_SIZE`（2048）行而非逐行。这减少了虚函数调用开销（一次 Execute 调用处理 2048 行），改善了 cache 局部性（DataChunk 中的 Vector 按列存储，列内连续），并允许 SIMD 指令利用。`CachingPhysicalOperator`（`CACHE_THRESHOLD = 64`）确保 Filter 等选择性算子产生的小 chunk 不会直接传播到下游——缓存后批量传递减少调用次数。

### Pull-Push 混合模型

DuckDB 不是传统 Volcano 的 `open()/next()/close()` 模型。`PipelineExecutor` 主动从 Source 拉 DataChunk（pull），然后推过算子链到 Sink（push）。`in_process_operators` 栈实现算子的"还有更多输出"暂停/恢复——当某算子返回 `HAVE_MORE_OUTPUT` 时，下次执行从该算子继续而非从头开始。这解决了 join 等需要先 build 再 probe 的场景。

### 聚合算子的多策略选择

`CreatePlan(LogicalAggregate&)`（`plan_aggregate.cpp:235-304`）根据统计信息选择最优策略：
- `PhysicalUngroupedAggregate`：无分组，直接累加（最快）
- `PhysicalPerfectHashAggregate`：分组列基数小（min/max 范围 < 2^32），用完美哈希（数组索引）
- `PhysicalPartitionedAggregate`：源头已按分组列分区，各分区独立聚合
- `PhysicalHashAggregate`：通用哈希聚合（兜底）

### JoinHashTable：线性探测 + Radix 分区

`JoinHashTable` 使用线性探测（linear probing）而非链式——对缓存友好，冲突时顺序扫描相邻内存。指针表与数据分离：`[POINTER]` 表 vs `[SERIALIZED ROW][NEXT POINTER]` 数据。`USE_SALT_THRESHOLD = 8192`：HT 小于 8192 entry 时不比较 salt，大于时才比较 salt 减少冲突链遍历。

外部 join 支持：数据超内存时用 Radix 分区多轮处理（`INITIAL_RADIX_BITS = 4`），`ProbeSpill` 结构存储溢出的 probe 侧数据，`PrepareExternalFinalize` 决定是否需要更多轮次。

### Arena 分配器

所有 PhysicalOperator 通过 `physical_plan->Make<T>(...)` 在 `ArenaAllocator` 上分配（`physical_plan_generator.hpp:38-44`）。Arena 分配是 bump pointer，O(1) 分配，减少 malloc 开销。析构时统一释放，子算子引用 (`ArenaLinkedList<reference<PhysicalOperator>>`) 也在 arena 上保证生命周期一致。

### ExpressionExecutor 字典优化

当输入是 `DICTIONARY_VECTOR` 且只依赖一个非 const 列时，`TryExecuteDictionaryExpression`（`execute_function.cpp:48-117`）只对字典部分执行函数一次，而非对每行执行。这避免了重复计算相同值。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Pull-Push 混合迭代器 | `PipelineExecutor::Execute` in `pipeline_executor.cpp:188` | Volcano 变体，批量 push 减少虚调用 |
| Strategy | `PhysicalPlanGenerator::CreatePlan` switch | 每种逻辑算子一种物理转换策略 |
| Template Method | `CachingPhysicalOperator::Execute` (final) | 固定缓存逻辑，子类实现 `ExecuteInternal` |
| Arena 分配器 | `PhysicalPlan::Make<T>()` in `physical_plan_generator.hpp:38` | O(1) 分配，统一释放 |

## 模块间交互

Execution 接收 Optimizer 产出的 `LogicalOperator` 树，由 `PhysicalPlanGenerator` 转换为 `PhysicalOperator` 树，交 Parallel 模块的 `Executor::Initialize` 构建 Pipeline 并调度。`PhysicalTableScan` 不直接读存储，而是通过 Function 模块的 `TableFunction` 间接调用——`function.function(context, data, chunk)` 是实际的扫描回调（`physical_table_scan.cpp:159-176`），对于内部表最终调用 `DataTable::Scan`，对于 CSV 文件调用 CSV scanner。UDF 执行通过 `BoundFunctionExpression` → `expr.function.GetFunctionCallback()`（`execute_function.cpp:197`）直接调用 function pointer。

## 扩展方式

新增一个物理算子：`src/include/duckdb/execution/operator/xxx/physical_xxx.hpp` 继承 PhysicalOperator → `src/execution/operator/xxx/physical_xxx.cpp` 实现 Execute/GetData/Sink → `src/execution/physical_plan/plan_xxx.cpp` 实现 `CreatePlan(LogicalXxx&)` → `src/execution/physical_plan_generator.cpp:70` switch 添加 case → `src/common/enums/physical_operator_type.hpp` 添加枚举。如果是 CachingPhysicalOperator 子类，state 需继承 `CachingOperatorState`。
