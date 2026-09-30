---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Meta 元数据中枢"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "barrier", "checkpoint", "元数据"]
description: "Meta 模块解读：GlobalBarrierWorker reactor、Command→Mutation 命令模式、per-database checkpoint 控制、SQL 事务化 controller 层"
readingTime: "28 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

Meta 是集群唯一的"有状态大脑"：catalog/fragment/cluster 元数据、barrier 心跳的全局编排、流作业生命周期、hummock 版本提交、扩缩容决策全在这一个节点收敛。分布式系统的三大难题——一致性、可用性、分区容忍——RisingWave 的回答是把**一致性决策集中到 meta**（单点但持久化），把执行分散到 compute/compactor。

worker.rs 文件头注释（84-92 行）是整个模块的钥匙：

> Configuration change in our system is achieved by the mutation in the barrier. Thus, GlobalBarrierWorker provides a set of interfaces like a state machine, accepting [Command] that carries info to build [Mutation]. To keep the consistency between barrier manager and meta store, some actions like "drop materialized view" or "create mv on mv" must be done in barrier manager transactional using [Command].

即：**barrier 是全局逻辑时钟，一切配置变更都"寄生"在 barrier 上原子生效**。

## 模块架构

meta 分四层：`barrier/`（心跳核心，本模块的灵魂）、`controller/`（SQL 持久化状态）、`stream/`（流作业生命周期编排）、`manager/`（进程内组装）。另有独立子 crate `meta/service`（gRPC 服务面）与 `meta/model`（sea-orm 实体）。

一个重要的历史事实：v2.0 起**旧 manager 层（内存 HashMap + KV MetaStore）被 SQL-backed controller 层取代**——fragment 管理已并入 `CatalogController`（controller/fragment.rs 全是它的扩展块）。元数据存进 SQL 数据库（生产 Postgres，内存模式即 `sqlite::memory:`，controller/mod.rs:91），DDL 崩溃恢复从"清理不一致的 KV 残骸"退化为按 job_status 回滚几行。

```text
barrier/
├── worker.rs          GlobalBarrierWorker<C> —— reactor 事件循环（7 类事件源）
├── schedule.rs        BarrierScheduler / PeriodicBarriers —— 命令队列 + 定时器
├── command.rs         Command / PostCollectCommand —— 变更意图的两半
├── checkpoint/        CheckpointControl / BarrierWorkerState —— per-db 状态机
│   ├── control.rs     in_flight_barrier_nums 流水线限流
│   ├── state.rs       epoch 单调性唯一真源 + BarrierKind::Checkpoint 折叠
│   └── independent_job/  独立 checkpoint 周期的作业（backfill 等）
├── rpc.rs             ControlStreamManager —— 与 CN 的双向 gRPC 控制流
├── partial_graph.rs   PartialGraphManager —— per-graph barrier 收集账本
├── complete_task.rs   CompleteBarrierTask —— 收齐后的异步落库任务
└── notifier.rs        两阶段 oneshot 通知
```

## 调用链路

以 CREATE MATERIALIZED VIEW 为例的 barrier 完整闭环（`Command::CreateStreamingJob`）：

```text
阶段一 提交：DDL → DdlController::create_streaming_job    rpc/ddl_controller.rs:1102
 └ GlobalStreamManager::create_streaming_job              stream/stream_manager.rs:376
    └ discover_splits → BarrierScheduler::run_command      schedule.rs:270
       └ push 入 per-db 队列 → 调用方 await 挂起           （整个 barrier 完成前不返回）

阶段二 注入：GlobalBarrierWorker::run_inner                 worker.rs:525
 └ PeriodicBarriers::next_barrier（命令优先于定时器）        schedule.rs:480
    └ CheckpointControl::handle_new_barrier               checkpoint/control.rs:235
       └ BarrierWorkerState::next_barrier_info（epoch 单调断言）state.rs:126
       └ resolve_reschedule_intent → Mutation              worker.rs:209
    └ ControlStreamManager::inject_barrier                 rpc.rs:1257
       └ StreamingControlStream 双向流发 InjectBarrierRequest{barrier, actor_ids_to_collect, actors_to_build}

阶段三 收集：CN 侧 LocalBarrierManager 对齐 → BarrierCompleteResponse 回写同一条流
 └ PartialGraphManager::next_event → BarrierCollected      partial_graph.rs
    └ CheckpointControl::barrier_collected（Recovering 中丢弃）control.rs:189

阶段四 提交：CompletingTask::next_completed_barrier         complete_task.rs:254
 └ CompleteBarrierTask::complete_barrier（tokio::spawn）    complete_task.rs:98
    ├ context.commit_epoch → HummockManager::commit_epoch  hummock/manager/commit_epoch.rs:73
    ├ post_collect_command（SQL 事务更新 catalog/fragment） context_impl.rs:273
    ├ notifier.notify_collected（唤醒阶段一的调用方）
    └ context.finish_creating_job → frontend DDL 返回
 └ ack_completed → 推进 committed_epoch                    control.rs:1122
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `GlobalBarrierWorker::run_inner` in worker.rs:525 | reactor 主循环 | `select! { biased }` 免锁，shutdown 优先 |
| `PeriodicBarriers::next_barrier` in schedule.rs:480 | barrier 生产 | 命令队列优先 + 定时器重置 |
| `BarrierScheduler::run_command` in schedule.rs:270 | 提交命令并等完成 | push + watch 唤醒 + await |
| `BarrierWorkerState::next_barrier_info` in state.rs:126 | epoch 分配 | 单调断言 + checkpoint 折叠 |
| `ControlStreamManager::inject_barrier` in rpc.rs:1257 | 下发 barrier | 常驻双向流复用 |
| `CompleteBarrierTask::complete_barrier` in complete_task.rs:98 | 收齐落库 | commit_epoch + SQL 事务 + 唤醒 |
| `failure_recovery` in worker.rs:968 | 故障恢复 | 回滚到最后 committed epoch |

</details>

## 核心实现

### 命令模式：变更意图的两半

`Command`（command.rs:467，~20 个变体）是 barrier 的"意图"：`Flush / Pause / Resume / DropStreamingJobs / CreateStreamingJob / RescheduleIntent / SourceChangeSplit / Throttle / CreateSubscription...`。它的执行拆成两半——**注入期**把命令转成 `Mutation` protobuf 下发给 compute（挂在 barrier 上随数据流传播），**收集期**的 `PostCollectCommand`（command.rs:717）在 barrier 收齐后的 SQL 事务窗口落库。两半合起来才是一个原子变更：运行时 actor 图与 catalog 永远一致。`should_checkpoint()`（command.rs:750）决定哪些命令必须伴随 checkpoint。

### checkpoint 折叠：一个 checkpoint 覆盖多个 epoch

非 checkpoint barrier 只推进 epoch 不触发 hummock commit。`BarrierWorkerState`（state.rs:75）把期间所有非 checkpoint epoch 收进 `pending_non_checkpoint_barriers`，到 checkpoint barrier 时打包成 `BarrierKind::Checkpoint(epochs)` 一次提交（state.rs:140-147）——epoch 链仍连续但落盘开销摊薄。恢复语义因此极简：`in_flight_prev_epoch` 无需持久化，recovery 时从 hummock 最新 committed version 恢复（state.rs:78-80 注释）。

一个 barrier 是否 checkpoint 由两路判定（schedule.rs:538）：命令侧 `need_checkpoint()`（command.rs:710，除 `Command::Resume` 外**所有命令都强制 checkpoint**——变更必须落盘才安全）；周期侧 `try_get_checkpoint` 的公式 `num_uncheckpointed_barrier + 1 >= checkpoint_frequency`（每 N 个 barrier 一个 checkpoint），checkpoint 后计数器清零。另有 `force_checkpoint_databases`（FLUSH 命令触发）优先于定时器立即出 checkpoint。

### 调度队列的 Blocked 语义

database/cluster 进入恢复期间，命令队列转 `Blocked`：`validate_item`（schedule.rs:107）只放行 `Command::DropStreamingJobs` 与 `Command::DropSubscription`（用户 drop 不能因恢复而失败），其余命令直接返回 unavailable 错误。恢复时 `pre_apply_drop_cancel_scheduled` 把缓冲的 drop 命令排空直接注入——这是"恢复路径上也要能删作业"的保障。

### per-database 隔离 + 流水线 barrier

`CheckpointControl.databases` 按 DatabaseId 分治（control.rs:97）：`system_enable_per_database_isolation` 开启时单个 db 的 worker 故障只 reset 该 db，其余 db 的 barrier 不中断——多租户可用性的基础。同时 `in_flight_barrier_nums`（env.rs:110）允许同 db 多个 barrier 在途（`pending_barrier_num` 限流，control.rs:374），注入不必等上一个收齐；但 **commit 严格按 epoch 顺序**（`next_complete_barrier_task` 取最早收齐者，complete_task.rs:262）。

### Event-driven 调度

`PeriodicBarriers::next_barrier`（schedule.rs:495）的 biased select 让命令队列永远优先于 IntervalStream 定时器，且命令触发后 `reset_database_timer`（:459）重置该 db 定时器——避免"命令 barrier 后紧贴一个空 barrier"，又保证最坏情况按 interval 有心跳。整个 worker 无任何 sleep 轮询。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Reactor | `run_inner` in worker.rs:533 | 单线程事件循环天然免锁 |
| 生产者-消费者 | `Inner { queue, changed_tx }` in schedule.rs:52 | 命令入队 + watch 唤醒 |
| 命令模式 | `Command`/`PostCollectCommand` in command.rs | 变更的两阶段原子化 |
| 状态机（多层） | `DatabaseCheckpointControlStatus::{Running,Recovering}` control.rs:677；`PartialGraphStatus` partial_graph.rs:173 | 恢复期丢弃迟到响应 |
| 依赖注入 | `GlobalBarrierWorkerContext` trait in context/mod.rs:87 | 泛型化 worker，mock 测试 |
| 两阶段通知 | `Notifier → NotifierStarter` in notifier.rs:45 | 注入完成与收集完成分开唤醒 |

## 模块间交互

**↔ compute**：每 CN 一条常驻 `StreamingControlStream` 双向流（inject 与 collect 复用同一条流，断流即触发 recovery）；**↔ frontend**：DDL 走 gRPC ddl_service，元数据变更经 `CatalogController::notify_frontend` + NotificationManager 推送；**↔ hummock**：`commit_epoch` 直通 HummockManager，recovery 从 hummock committed epoch 起步；**↔ source**：`SourceManager` 注入前 `discover_splits`，split 变化随 `Command::SourceChangeSplit` 下发。

## 扩展方式

**新增一种 barrier Command**：command.rs:467 加变体 + `need_checkpoint()` + `PostCollectCommand` 变体 → state.rs 的 `apply_command` 转 Mutation → control.rs:291 补 match → info.rs 的 `apply_collected_command` → 调用方经 `run_command` 提交。

**新增一种流作业类型**（参考 `BatchRefresh`）：command.rs:452 的 `CreateStreamingJobType` 加变体 → stream_manager.rs:669 构造与校验 → 需要独立 checkpoint 周期则在 `independent_job/` 加 `IndependentCheckpointJobControl` 变体 → catalog 侧 `create_op.rs` + meta_model 新表 + migration。
