---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "Coprocessor 下推计算"
date: "2026-10-01T21:05:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "Coprocessor", "向量化", "RPN", "火山模型"]
description: "TiKV 下推计算引擎：DAG 向量化火山模型、RPN 表达式栈求值、chunk 列式内存、Analyze 统计与三档读池并发控制。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

TiDB 的 SQL 执行是拉模式火山迭代器，数据从 TiKV 拉回 TiDB 计算——网络成为瓶颈。Coprocessor 把**过滤、投影、聚合、TopN** 下推到数据所在地执行，只回传最终结果。本模块（src/coprocessor + tidb_query 五件套 ~135k 行）是 TiKV 中最大的子系统，自成体系：向量化执行器、表达式求值、数据类型系统三件套一应俱全，与在线 KV 服务的负载形态完全不同（CPU 密集 vs IO 密集），故独立。

## 模块架构

```text
src/coprocessor/
├── endpoint.rs        入口：parse_and_handle_unary_request（:587）
├── dag/               DAG 请求处理（DagHandlerBuilder）
├── statistics/        Analyze（直方图/CMSketch 采样）+ Checksum
└── interceptors/      限流/中断拦截
components/tidb_query_executors/   执行器（BatchExecutor trait 树）
components/tidb_query_expr/        RPN 表达式（#[rpn_fn] 宏）
components/tidb_query_datatype/    Chunk/VectorValue/Datum/codec
components/tidb_query_common/      Storage trait 抽象 + 执行统计
components/tidb_query_aggr/        聚合函数
components/tidb_query_codegen/     过程宏（rpn_function）
```

## 调用链路

### DAG 请求全路径

```text
gRPC coprocessor 流
└─ parse_and_handle_unary_request（src/coprocessor/endpoint.rs:587）
   └─ parse_request_and_check_memory_locks_impl（:192）
      ├─ 按 REQ_TYPE_DAG / ANALYZE / CHECKSUM 分派
      ├─ async_in_memory_snapshot（:399，SnapContext{start_ts, key_ranges}）
      └─ builder 闭包：SnapshotStore + dag::DagHandlerBuilder
         → BatchDAGExecutor = BatchExecutorsRunner::from_request（runner.rs:423）
            └─ build_executors（:179）：tipb::Executor 描述符自底向上
               包装成 Box<dyn BatchExecutor> 树（table_scan→selection→aggr...）
   └─ read_pool.spawn（endpoint.rs:897）投 yatp FuturePool
      └─ handle_request（runner.rs:500）循环
         └─ internal_handle_request（:643）
            └─ out_most_executor.next_batch(scan_rows)   # 火山拉模型
               批大小 32 起步 ×2 增长到 BATCH_MAX_SIZE
            → encode_chunk 编码回 TiDB
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `parse_request_and_check_memory_locks_impl` in endpoint.rs:192 | 解析+内存锁预检 | 下推前保 SI |
| `async_in_memory_snapshot` in endpoint.rs:399 | 取一致性快照 | start_ts+key_ranges |
| `build_executors` in runner.rs:179 | tipb 树转执行器树 | 自底向上构造 |
| `internal_handle_request` in runner.rs:643 | 批式驱动 | 批指数增长 |
| `check_busy_threshold` in endpoint.rs:599 | 排队快速拒绝 | 防慢请求积压 |
| `map_expr_node_to_rpn_func` in expr lib.rs:408 | sig→函数注册 | 新函数单点注册 |

</details>

## 核心实现

### BatchExecutor：向量化火山模型

```rust
// components/tidb_query_executors/src/interface.rs:21
#[async_trait]
pub trait BatchExecutor: Send {
    type StorageStats;
    fn schema(&self) -> &[FieldType];
    async fn next_batch(&mut self, scan_rows: usize) -> BatchExecuteResult;
    fn collect_exec_stats(&mut self, dest: &mut ExecuteStats);
}
// :153
pub struct BatchExecuteResult {
    physical_columns: LazyBatchColumnVec,
    logical_rows: Vec<usize>,        # 物理列上的行选择
    is_drained: Result<BatchExecIsDrain>,
}
```

注释明言 "similar to the Volcano Iterator model, but pulls data **in batch and stores data by column**"（interface.rs:31）。为什么向量化：runner.rs:40 注释直接引用 MonetDB/X100 研究——行式逐行处理 cache miss 高、函数调用开销大；列式连续内存对 CPU cache/SIMD 友好，且无中间 Datum 装箱。批从 `BATCH_INITIAL_SIZE=32` 按 `BATCH_GROW_FACTOR=2` 增长——小请求低延迟、大吞吐摊薄。`logical_rows` 让过滤不需要物化拷贝列。

### RPN 表达式：栈求值零分发

```rust
// components/tidb_query_expr/src/types/expr.rs:90
pub struct RpnExpression(Vec<RpnExpressionNode>);   // FnCall/Constant/ColumnRef
```

旧 "VL"（vector-loop）框架（tidb_query_vec，已删）需逐列物化中间结果；RPN 用单个求值栈（`eval_decoded` expr_eval.rs:264），操作数以 `RpnStackNode::Scalar/Vector` 引用零拷贝传递，`RpnFnMeta.fn_ptr` 是裸函数指针（types/function.rs:48）——`#[rpn_fn(nullable)]` 过程宏（tidb_query_codegen/src/rpn_function.rs）按参数类型**特化生成循环**，无 per-row dyn dispatch；常量折叠为 Scalar 节点避免整列展开。`LazyBatchColumn::Raw/Decoded`（lazy_column.rs:28）：table_scan 只在表达式引用列时才解码——惰性解码省大量 codec 开销。

### Chunk 列式内存

```rust
// components/tidb_query_datatype/src/codec/data_type/vector.rs:15
pub enum VectorValue {
    Int(ChunkedVecSized<Int>), Real(...), Bytes(ChunkedVecBytes), /* Dec/Time/Json... */
}
```

每列一个类型化连续容器（`ChunkedVec*` 支持 chunk 内分段存储），整批以 Chunk 协议编码回 TiDB。`Datum`（datum.rs:53）是通用行式表示，仅在边界（参数/常量）出现。

### 并发与资源控制

三档读池 `build_read_pool`（readpool_impl.rs:28）：cop-low/normal/high 三个 yatp FuturePool，gRPC 线程先 `check_busy_threshold`（endpoint.rs:599）快速拒绝排队任务；`read_pool_spawn_with_memory_quota_check`（endpoint.rs:878）限内存 + `MaxPendingTasksExceeded` 限积压；`QuotaLimiter` 对 CPU/读字节配额限流（runner.rs:509-527，资源管控）；`Deadline` 贯穿每轮 next_batch（runner.rs:653）防长查询占用。

### Analyze：不走 DAG 的旁路

`AnalyzeContext`（statistics/analyze_context.rs:49）复用 RequestHandler/TikvStorage 框架但走 `SampleBuilder`/`RowSampleBuilder`（Reservoir 采样 + `Histogram`/`CmSketch`/`FmSketch`），不走执行器树——统计聚合是特殊形态，硬套 DAG 反而别扭。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 火山模型 + 向量化 | `BatchExecutor::next_batch` interface.rs:31 | cache 友好 |
| 装饰器 | `WithSummaryCollector`（interface.rs:103） | 统计与逻辑分离 |
| Builder | `DagHandlerBuilder`（dag/mod.rs:22） | 快照/上下文多参数 |
| codegen 注册 | `#[rpn_fn]` + `map_expr_node_to_rpn_func` | 特化代码生成 |
| 惰性求值 | `LazyBatchColumn` lazy_column.rs:28 | 用到才解码 |
| 适配器 | `TikvStorage`（dag/storage_impl.rs:14）实现 `tidb_query_common::storage::Storage` | 执行器与底层快照解耦 |

## 模块间交互

storage：endpoint 经 `kv::in_memory_snapshot(engine, snap_ctx)` 拿快照包成 `SnapshotStore`（含内存锁检查）；`RangesScanner` 遍历 Region snapshot 喂 table_scan。tipb：请求/执行器/表达式/FieldType 全 proto 定义——TiDB 与 TiKV 的下推契约，新函数须双端同步。read pool 与 02 篇共享。

## 扩展方式

- **新增下推标量函数**：`tidb_query_expr/src/impl_*.rs` 用 `#[rpn_fn(nullable)]` 写实现 → `lib.rs:408` 注册 sig 映射 → TiDB 侧加 sig（双端 proto 同步）
- **新增执行器**：新建 `xxx_executor.rs` 实现 `BatchExecutor` → `check_supported`（runner.rs:89）与 `build_executors`（:179）match 加分支
- **新增统计回传**：实现 `collect_exec_stats` → `handle_request` 汇总为 `ExecutorExecutionSummary`（runner.rs:563）
