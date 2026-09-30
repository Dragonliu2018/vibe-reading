---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Batch 批引擎"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "火山模型", "批查询", "spill"]
description: "Batch 模块解读：Stream 即拉取的 Executor trait、linkme 编译期注册表、Local/Distributed 双模式、spill 分区递归与三层取消传播"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

批引擎回答"用户 SELECT 时数据从哪来"。RisingWave 的答案很省事：**MV 已被流引擎物化进 hummock，批查询只需按 query_epoch 读快照**——纯一次性、无状态、可任意重试的拉取树，无需重放计算。这就是"流数据库"服务模型的另一半。

它服务于两类负载：高并发点查（走 Local 模式，frontend 进程内执行）与 ad-hoc 分析（走 Distributed 模式，多 stage 多 CN shuffle）。

## 模块架构

双 crate 拆分：`src/batch/`（框架：trait、task 生命周期、channel、rpc、spill 基建 ~5.3k 行）+ `src/batch/executors/`（38 个具体执行器 ~19k 行，**依赖前者**）。拆分动机：重依赖（iceberg、mysql_async、parquet、foyer）被隔离在 executors crate 不污染框架；注册用 linkme 跨 crate 链接，框架侧无需知道任何具体执行器——依赖倒置。

```rust
// src/batch/src/executor/mod.rs —— Stream 即拉取
pub trait Executor: Send + 'static {
    fn schema(&self) -> &Schema;
    fn identity(&self) -> &str;
    fn execute(self: Box<Self>) -> BoxedDataChunkStream;  // futures::Stream
}
// 注释"Refactoring of Executor using Stream"：早期 open/next/close 三段式火山接口
// 改为一次性 execute() 返回 Stream——next() 即火山 next()，且能被 select! 组合实现取消

#[linkme::distributed_slice]
pub static BUILDER_DESCS: [ExecutorBuilderDescriptor];   // 编译期注册表
// 用法（executors/src/executor.rs，38 处）：
register_executor!(HashAgg, HashAggExecutorBuilder);
```

`BatchTaskContext` trait 双实现是双模式的地基：`ComputeNodeContext`（CN 分布式执行，包装全局 `BatchEnvironment`）与 `FrontendBatchTaskContext`（frontend 本地执行，多出 catalog_reader/metrics_reader）。

## 调用链路

一条分布式 SELECT：

```text
frontend QueryManager::schedule                        scheduler/distributed/query_manager.rs:189
 ├ pinned_snapshot.fill_batch_query_epoch（绑 Hummock 快照）
 └ QueryExecution::start → 按 stage 拓扑序
    └ schedule_task → compute_client.create_task（gRPC；叶子 stage 先下发）
       ▼ compute 节点
       BatchServiceImpl::create_task                   batch/src/rpc/service/task_service.rs:67
       └ mgr.fire_task → BatchManager                  task/task_manager.rs:109
          ├ create_output_channel（Fifo/HashShuffle/Broadcast/ConsistentHash）  task/channel.rs:101
          ├ 注册 + spawn 60s 心跳（防 FE 失联僵尸任务）
          └ task.async_execute                         task/task_execution.rs:378
             ├ ExecutorBuilder::try_build（递归构建整棵树 + ManagedExecutor 包装）
             ├ change_state_notify(Running)（通知 FE 调下一 stage）
             └ runtime.spawn(run)：select!(shutdown, data_chunk_stream.next())
                （每个 chunk 经 sender.send() 写入 shuffle channel）
消费：跨 CN 走 GenericExchangeExecutor → GrpcExchangeSource::get_data
      同 CN 走 LocalExchangeSource（直取 channel receiver，零序列化）
```

**Local 模式**（点查/小查询）：`LocalQueryExecution::run_inner`（frontend/scheduler/local.rs:93）在 frontend 自己的 `compute_runtime` 上直接构建执行树。scan 仍要打 CN——方案是 `PbExchangeSource.local_execute_plan`：把剩余子计划序列化进 exchange source 描述，CN 端 `BatchServiceImpl::execute` 即席执行不走 task 状态机，单 RPC 流式回数据（task_service.rs:237）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `ExecutorBuilder::try_build` in executor/mod.rs:170 | proto→执行树 | linkme 查表构建 |
| `BatchTaskExecution::run` in task_execution.rs:517 | 拉取主循环 | select 取消 + 心跳 |
| `create_output_channel` in task/channel.rs:101 | shuffle channel | 四种分布策略 |
| `LocalQueryExecution::run_inner` in scheduler/local.rs:93 | 进程内执行 | local_execute_plan 短路 |
| `GrpcExchangeSource::create` in execution/grpc_exchange.rs:42 | 跨 CN 取数 | 失败时 mask serving worker |

</details>

## 核心实现

### 批/流两套 executor 为什么正交

流执行器是长驻 push 算子带水位线/barrier 语义；批执行器是一次性无状态 pull 树。两者共享 common 的 DataChunk 与 expr 求值层，但执行模型完全不同——**MV 直接物化换来了批侧的极简**：`RowSeqScanExecutor`（row_seq_scan.rs:128）按 query_epoch + vnode_bitmap + ScanRange 直接读 hummock 就完事。

### spill：分区递归 + 换哈希函数

HashAgg 为例（hash_agg.rs:578-599，RFC #89）：hash map 用 `mem_context.global_allocator()` 分配（配额由分配器计量）；超限时 hash 表 + 剩余输入按 `hash % 20` 分区写到 20 对文件，然后**递归**用子 `HashAggExecutor` 逐分区重算；递归 spill 用 uuid 种子的 `SpillBuildHasher`（:339）换哈希函数防数据倾斜。底层 `SpillOp` 基于 opendal，RAII Drop 清理目录。

### 取消/失败传播的三层设计

`ShutdownToken`（watch channel）从 task 级（`run` 的 `select!` biased 分支）→ executor 级（`ManagedExecutor::execute` 的 select）全程传递；`Abort`（错误传播）与 `Cancel`（正常取消）语义分开；心跳 `Ping` 保证 FE 崩溃/RPC 失败时 CN 侧任务最终被取消（task_manager.rs:186-209 注释）。`run` 还处理了 limit executor 提前断流导致 receiver 关闭的边界（SenderError → Finished，:557-563）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Volcano/pull | `Executor::execute() -> BoxedDataChunkStream` | Stream 即拉取，天然可取消 |
| 静态注册表 | `BUILDER_DESCS` + `register_executor!` in executor/mod.rs:135 | 零运行时查找成本 |
| Decorator | `ManagedExecutor` in executor/managed.rs | shutdown/tracing 横切 |
| 策略 | `create_output_channel` 四种 channel in task/channel.rs:101 | 分布模式可枚举 |
| 泛型特化 | `HashKeyDispatcher` 按 group key 类型编译期特化 `HashAggExecutor<K>` | 消除 key 反序列化 |
| RAII | `SpillOp::drop` 异步清理 spill 目录 | 无泄漏 |

## 模块间交互

**↔ frontend**：gRPC TaskService，状态经 `StateReporter` 双向流回推；**↔ storage**：`RowSeqScanExecutor` 经 `dispatch_state_store!` → `BatchTable::new_partial`；**↔ rpc_client**：`BatchEnvironment.client_pool` 连接池复用；**↔ DML**：`FastInsertExecutor` 与 `ingest_dml` 经 `DmlManager` 转流侧 barrier 写入。

## 扩展方式

**新增一种批执行器**：proto `batch_plan.proto` 加 `FooJoinNode` 入 `NodeBody` oneof → frontend planner 加逻辑/物理节点 + `to_batch_prost` → `executors/src/executor/foo_join.rs` 实现 `Executor` + builder → `executors/src/executor.rs` 挂 mod + `register_executor!(FooJoin, ...)`——**框架侧零改动**（linkme 自动注册）。spill 复用 `SpillOp`，参照 `AggSpillManager` 分区模式。

**新增一种 shuffle 分布模式**：proto `DistributionMode` 加枚举值 → `task/` 新建 foo_channel.rs（实现 ChanSender/ChanReceiver）→ `channel.rs` 的 Impl 枚举 + `create_output_channel` 加 arm → frontend plan_fragmenter 适配。
