---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Stream 流引擎"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "流计算", "增量计算", "actor 模型"]
description: "Stream 引擎解读：actor 拉模型执行、barrier 对齐、hash join degree table、增量聚合 state table、backfill 回填与 permit 背压"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

Stream crate 是 compute 节点上的**流计算执行引擎**——RisingWave 产品价值的本体。Meta 做全局编排，这里把 StreamPlan protobuf 物化为 actor 执行树，持续处理三种消息：`StreamChunk`（数据）、`Barrier`（控制/epoch）、`Watermark`（事件时间水位），全部状态读写经 hummock。

它的理论基础是经典 change propagation 框架：为每个物化视图建一棵 executor 树，上游更新从叶到根递归传播，每个 executor 只需保证自己的**增量语义正确**，组合起来就能维护任意 SQL 查询（streaming-overview.md 的表述）。

## 模块架构

```text
src/stream/src/
├── task/               # actor 管理与 barrier worker
│   ├── actor_manager.rs    # create_actor：递归物化执行树 + spawn
│   ├── barrier_worker/     # LocalBarrierWorker：CN 侧 barrier 收集与 sync
│   ├── env.rs              # StreamEnvironment（持 StateStore/DmlManager/MetaClient）
│   └── stream_manager.rs   # 对 meta 的公共 API 面
├── executor/           # 62 种执行器
│   ├── actor.rs            # Actor<C>：拉模型主循环
│   ├── mod.rs              # Message/Barrier/Mutation 定义 + Execute trait
│   ├── dispatch.rs         # DispatchExecutor：输出分发（Hash/Broadcast/RR）
│   ├── hash_join.rs 3940 行 # 最复杂 join（含 degree table）
│   ├── aggregate/          # hash_agg 等：AggGroup + state table
│   ├── mview/materialize.rs# MV 物化执行器
│   ├── backfill/           # 存量回填（arrangement/source/cdc）
│   ├── exchange/           # 跨 CN 传输 + permit 背压
│   ├── barrier_align.rs    # 双输入 barrier 对齐骨架
│   └── ...（source/sink/window/dedup/lookup...）
└── from_proto/         # proto → executor 的 builder（宏分发）
```

消息模型（executor/mod.rs:1342）——注意 **Mutation 是挂在 barrier 上传播的**：

```rust
// src/stream/src/executor/mod.rs
pub enum MessageInner<M> {
    Chunk(StreamChunk),
    Barrier(BarrierInner<M>),   // epoch + mutation + kind
    Watermark(Watermark),
}
pub enum Mutation {
    Stop(StopMutation), Update(UpdateMutation), Add(AddMutation),
    SourceChangeSplit(...), Pause, Resume, Throttle(...),
    StartFragmentBackfill { fragment_ids: ... }, ...
}
```

执行器抽象刻意把静态信息与可执行对象拆开：`Executor = ExecutorInfo + Box<dyn Execute>`，`Execute::execute()` 返回 `BoxedMessageStream`（futures::Stream）——**整个 actor 是一条嵌套的拉式 async 流水线**。

## 调用链路

构建期（`StreamActorManager`）：

```text
meta 经 control 流发 InjectBarrierRequest{actors_to_build}
 └ StreamActorManager::create_actor              task/actor_manager.rs:424
    └ create_nodes_inner（递归后序：先建 input）  :209
       └ create_executor! → from_proto builder（宏按 NodeBody 分发）
       └ wrap_executor（指标装饰器）               :341
    └ 根 executor 包 DispatchExecutor::new        dispatch.rs
    └ Actor::new → spawn_actor（tokio task）      :536
```

运行期（数据面）：

```text
Actor::run → run_consumer                  executor/actor.rs:253
 └ consumer.execute() 无限 loop try_next
    └ DispatchExecutor::execute             dispatch.rs:548
       ├ input.execute().peekable()（拉上游）
       ├ try_batch_barriers（连续 barrier 合批）   :580
       └ dispatch_message_batch → DispatcherImpl  :633
          （Hash/Broadcast/Simple/RoundRobin → 本地 channel 或 gRPC exchange）
 ├ barrier 到达：flush_data(epoch) → state_table.commit(epoch)
 └ 回到 Actor::run_consumer → barrier_manager.collect 上报
    └ LocalBarrierWorker 收齐全部 actor → state_store.sync（持久化 epoch）
       → BarrierCompleteResponse 回 meta
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `StreamActorManager::create_actor` in actor_manager.rs:424 | 物化执行树 | 递归后序 + 宏分发 |
| `Actor::run_consumer` in actor.rs:253 | actor 主循环 | 只收口 barrier 流 |
| `DispatchExecutor::execute` in dispatch.rs:548 | 输出分发 | barrier 合批优化 |
| `AlignedMessage`/`barrier_align` in barrier_align.rs:36 | 双输入对齐 | 随机 prefer_left 防饿死 |
| `HashJoinExecutor::flush_data` in hash_join.rs:737 | epoch flush | watermark 清理联动 |
| `ArrangementBackfillExecutor` in backfill/arrangement_backfill.rs:48 | 存量回填 | 进度持久化可恢复 |
| `LocalBarrierWorker::complete_barrier` in barrier_worker/mod.rs:747 | CN 收集 | 仅 checkpoint 才 sync |

</details>

## 核心实现

### 为什么自建 actor 拉模型而非 timely/differential-dataflow

每个 executor 的 `execute()` 返回 async Stream，actor 是嵌套拉式流水线——语义简单（每算子独立实现增量逻辑），配合 hummock 的 epoch MVCC 实现"流处理 + 物化表"统一模型。RisingWave 论文的论点在此落地：数据流框架（timely/differential）难以精确控制持久化/checkpoint 与状态表语义，而这里 **barrier 作为数据流内的控制消息**（Mutation 挂其上）实现 exactly-once 与配置变更传播，join/agg 的增量算法完全显式手写。代价是每个有状态算子都要正确处理 barrier——`expect_first_barrier` + 每 epoch flush 的样板遍布所有 executor。

### barrier 对齐而非全局协调

双输入 executor 用 `barrier_align`（barrier_align.rs:111）：收到左侧 barrier 后死等右侧同 epoch barrier，chunk/watermark 立即放行——保证"同 epoch 内所有输入处理完后才 flush"，这是 MVCC epoch 提交正确性的根基。顺序公平性用随机 `prefer_left`（:68）避免饿死。顶层再由 meta 做全局收集（`PartialGraphState`），CN 端 `LocalBarrierWorker` 收齐所有 actor 的 `ReportActorCollected` 才 sync state store——且**按 BarrierKind 分支**：只有 `BarrierKind::Checkpoint` 生成 sync_epoch 任务，`BarrierKind::Initial` 明确跳过（首个 barrier 无数据可封），普通 `BarrierKind::Barrier` 不同步（barrier_worker/mod.rs 的 `complete_barrier`）。

### HashDataDispatcher：vnode 分发与 U-/U+ 改写

`HashDataDispatcher`（dispatch.rs）持 `hash_mapping: ExpandedActorMapping`（vnode→actor id），`dispatch_data` 用 `VirtualNode::compute_chunk` 按行算 vnode，再为每个 output 构造 visibility bitmap（`hash_mapping[vnode] == output.actor_id()`）。一个精妙的正确性细节（dispatch.rs:997-1030）：**当一对 Update（U-/U+）的分布键发生变化时，把它改写成普通 Delete/Insert**——分布键是下游 stream key 的一部分，而 stream key 必须在 Update 对内保持一致（`Op` 语义要求 U-/U+ 两行同 key）。barrier/watermark 则广播到所有 outputs 不做 hash 分发。

### dispatcher 的 pre/post 两阶段变更

携带 `Add/Update` mutation 的 barrier 到达 DispatchExecutor 时，dispatcher 变更拆成两步（dispatch.rs:338/374）：`pre_mutate_dispatchers` 在 dispatch **之前**为 Add/Update 添加新 dispatcher 与 outputs（保证新输出在 barrier 发出前就绪）；`post_mutate_dispatchers` 在 dispatch **之后**移除旧 outputs、对 Hash dispatcher 更新 hash_mapping，最后 retain 掉 outputs 为空的 dispatcher。**一个 BarrierBatch 中只有第一个 barrier 可以携带 mutation**（dispatch.rs 注释）。barrier 合批的类型载体是 `MessageBatchInner`（mod.rs:1364）——专门用于 Dispatcher 与 Merger/Receiver 之间交换，把多个 barrier 打包为一条消息。

### actor 生命周期的收尾细节

`run_consumer`（actor.rs:253）收到 `barrier.is_stop(id)` 命中时 break；循环退出后先 `spawn_blocking_drop_stream`（actor.rs:350）——用 `tokio::task::spawn_blocking` 执行 drop，因为 executor 内存缓存大时 drop 是 CPU 密集操作，在当前线程会阻塞 runtime 调度其他 actor；**等 stream 资源释放完才把 stop barrier collect 给 barrier_manager**。actor 运行出错时 `spawn_actor`（actor_manager.rs:536）调 `barrier_manager.notify_failure(actor_id, err)` 上报——这正是 meta 侧 `failure_recovery` / per-database 隔离恢复的触发源。

### hash join：两侧缓存 + degree table

`JoinSide`（hash_join.rs:92）每侧一个 `JoinHashMap`：热数据在 `ManagedLruCache`，冷数据从 state_table 流式拉取（join/hash_join.rs:274）。**degree table**（hash_join.rs:180-210，注释极详尽）记录每行在另一侧的匹配数而非布尔——删除一条 rhs 行时必须知道 lhs 行还剩几个匹配才能正确决定是否补发 NULL，这是 retract 语义下 outer join 正确性的关键。watermark 到达时 `flush_data` 中 `update_watermark`（hash_join.rs:845-911）同时清理 state 与 degree table。

### 增量聚合：AggGroup + StateTable

`HashAggExecutor`（aggregate/hash_agg.rs:64）的 `apply_chunk`（:332）在内存 `AggGroup` 上增量聚合；`flush_data`（:412）把 dirty group 的中间态写入 state table——**group key 作 state table key，序列化 agg state 作 value**。聚合函数的 retract 能力（见 [07-expr] 的 `retract` 参数）在这里被消费：UpdateDelete 消息能"减掉"已聚合的值。

### backfill：历史与增量的无缝拼接

`ArrangementBackfillExecutor`（backfill/arrangement_backfill.rs:48）核心：**左输入是上游实时流（缓冲），右输入是上游 MV 的 state table snapshot 扫描**；每来一个 barrier 打断 snapshot、记录进度、重建 snapshot 流；snapshot 耗尽后 drain 上游缓冲——"旧数据 + 停顿期间增量"无缝衔接，且进度可恢复。meta 侧经 `AddMutation.backfill_nodes_to_pause` 控制回填节奏。

进度的持久化协议（backfill/utils.rs）：`BackfillProgressPerVnode`（:269）是三态枚举 `NotStarted`（不落库）/ `InProgress { current_pos, snapshot_row_count }` / `Completed { ... }`，每个 vnode 维护 committed 与 current 两份；状态表每行编码 `| vnode | pk | backfill_finished | row_count |` 四列，`persist_state_per_vnode` 只对有变化的 vnode 写入。快照读的批大小由 rate limit 与 chunk size 共同决定：`min(rate_limit, chunk_size)` 再 `max(2, ...)`——限速时把快照读切成小于 chunk size 的批次。

### permit 背压 + barrier 合批

exchange channel（exchange/permit.rs:52）用无界 mpsc + 手工信号量（records/barriers 两个 Semaphore）：消息携带 permits 数，下游处理后**原样归还**（:29-35 注释——上游版本可能与下游不同，数字由 sender 决定）。吞吐优化：`try_batch_barriers` 把连续无 mutation 的 checkpoint barrier 合批（dispatch.rs:575），一次 RPC 送多个 epoch。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Actor 模型 | `Actor<C>` in actor.rs:195 | 每 actor 独立 task，无共享可变状态 |
| Composite + 装饰器 | `create_nodes_inner` + `WrapperExecutor` in actor_manager.rs | 执行树组合 + 指标横切 |
| 工厂 + 宏注册 | `impl_stream_node_body!` in from_proto/mod.rs | 新增 executor 零手写 match |
| 状态门面 | `StateTable<S>` in common/table/state_table.rs | 算子不直接碰 StateStore |
| LRU + 回源 | `ManagedLruCache` in cache/ | join/agg 热数据缓存统一内存治理 |
| 对齐流 | `barrier_align` + `AlignedMessage` in barrier_align.rs:36 | 双输入复用同一对齐骨架 |

## 模块间交互

**↔ storage**：executor 不直接 KV 读写，经 `StateTable`（vnode 分片、`init_epoch`/`commit(epoch)`/`update_watermark`）；checkpoint 时 barrier_worker 直接 `state_store.sync`。**↔ common**：StreamChunk/EpochPair/VirtualNode/HashKey。**↔ expr**：`NonStrictExpression` 条件求值，错误经 `ActorContext::on_compute_error` 限频上报。**↔ connector**：source executor 用 `SplitImpl` reader stream 与 barrier 流 merge。**↔ meta**：`ComputeClientPoolRef` 做 gRPC exchange，barrier 上报走 control 流。

## 扩展方式

**新增一种 stream executor**：`executor/xxx.rs` 实现 `Execute`（`#[try_stream]` 流 + 首 barrier + 每 epoch flush）→ `from_proto/xxx.rs` 实现 `ExecutorBuilder` → `from_proto/mod.rs` 挂 mod + proto `NodeBody` oneof 加变体——`dispatch_stream_node_body!` 宏自动接线，**无需改中央注册表**。有状态经 `StateTable`，并在 actor_manager.rs:223 的 `is_stateful_executor` 评估。最小样板 `from_proto/filter.rs`，复杂样板 `from_proto/hash_join.rs`。
