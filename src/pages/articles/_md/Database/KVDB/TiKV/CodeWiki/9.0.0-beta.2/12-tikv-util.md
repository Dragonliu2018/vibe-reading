---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "tikv_util 基础设施"
date: "2026-10-01T21:35:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "tikv_util", "Worker", "yatp", "mpsc"]
description: "TiKV 公共地基：Worker/Scheduler 后台任务框架、yatp 池封装（多级/优先级队列）、批量 mpsc、VersionTrack 配置热更与全局 timer。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

tikv_util 被 49 个 crate 依赖——全仓库的地基。它回答的问题是：**一个以同步阻塞为主（RocksDB FFI、raft ready 处理）的存储系统，需要什么样的并发与任务原语**。tokio 的异步生态不合适（大量同步调用、需要任务时长分级），所以 TiKV 自建了三层：Worker（同步 Runnable + 队列）、yatp 池（FuturePool + 多级/优先级队列）、批量 mpsc。外加配置热更框架与观测内嵌。

## 模块架构

```text
components/tikv_util/src/
├── worker/
│   ├── pool.rs     Worker / Scheduler（627 行）/ Runnable trait
│   └── future.rs   FutureWorker（LazyWorker 的底层）
├── yatp_pool/
│   ├── mod.rs      YatpPoolRunner / YatpPoolBuilder
│   └── future_pool.rs  FuturePool
├── mpsc/
│   ├── mod.rs      新类型 Sender（补 crossbeam close 语义）+ LooseBoundedSender
│   ├── future.rs   BatchReceiver（批量 poll）
│   └── priority_queue.rs
├── config.rs       VersionTrack + ConfigManager trait（2841 行）
├── timer.rs / time.rs   GLOBAL_TIMER_HANDLE（全局 timer）
├── logger.rs / metrics.rs / codec.rs / ...   28 个子模块
components/online_config/    OnlineConfig derive + ConfigValue
```

## 调用链路

### Worker::spawn 到执行

```text
Builder::create()（pool.rs:340）
└─ YatpPoolBuilder::new(DefaultTicker).thread_count(min, core, max)
   .build_future_pool()
└─ Worker::start_with_timer（:383）
   └─ start_with_timer_impl（:513）：pool 上 spawn async loop
      while let Some(msg) = receiver.next().await
        Msg::Task(t) → handle.inner.run(t)    # 同步执行，单 runner 串行
        Msg::Timeout → on_timeout() + 重排下轮
Scheduler::schedule（pool.rs 145-168）
   ├─ counter >= pending_capacity → ScheduleError::Full(task)   # 背压
   └─ schedule_force 无视容量直接入队
stop() = sender.close_channel() → 循环退出 → RunnableWrapper::drop
   → runner.shutdown()    # RAII 清理
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `Worker::start_with_timer` in pool.rs:383 | 起 runner + 周期 tick | 延迟任务复用 timer |
| `Scheduler::schedule` in pool.rs | 带容量检查入队 | Full 错误即背压信号 |
| `Scheduler::schedule_force` | 无视容量 | 紧急任务插队 |
| `YatpPoolBuilder::build_priority_future_pool` | 带优先级池 | 外部 TaskPriorityProvider |
| `YatpPoolBuilder::build_multi_level_pool` | 多级降级池 | 长任务自动下沉 |
| `BatchReceiver::poll_next` in mpsc/future.rs:254 | 批量收 | 摊薄 waker 开销 |
| `VersionTrack::tracker` in config.rs:1302 | 惰性发现新配置 | copy-on-read |

</details>

## 核心实现

### Worker：同步任务的 Actor 封装

`Worker` 提供"同步 `Runnable::run` 逐条处理 + mpsc 单消费者 + 定时 tick"原语。模块文档明确单 runner 内任务**串行**（mpsc 单消费者模型）——这是 Actor 语义：调用方（如 GcWorker 的各 store 任务、PdWorker 的心跳）天然要求串行，用 Worker 一行拿到。背压三件套：`pending_capacity` + `ScheduleError::Full` + `is_busy()` 让上层（raftstore）感知积压反压。延迟任务不用定时器线程——`Worker::delay_notify`（:450）经 `GLOBAL_TIMER_HANDLE.delay(now+timeout)` 发 `Msg::Timeout`，周期任务在循环里重排。

### yatp：为什么不用 tokio 池

两个 tokio 没有的能力：**Multilevel 队列**（`build_multi_level_pool`，按任务运行时长自动降级防长任务饿死短任务 + `CleanupMethod` 定期清理 task-elapsed map）和 **Priority 队列**（外部 `TaskPriorityProvider`——资源管控的优先级插入点）。弹性线程数 min/core/max。`YatpPoolRunner` 在 yatp Runner 生命周期钩子里植入 TiKV 专属逻辑（mod.rs:176-226）：线程内存统计（`tikv_alloc::add_thread_memory_accessor`）、thread_group、schedule wait duration 直方图——**观测内嵌于调度层**，每个用池的模块免费拿到指标。

### 批量 mpsc：补 crossbeam 的两个洞

`mpsc::Sender` 新类型（mod.rs:23-77）用 `State{sender_cnt, connected}` 补 crossbeam #236 缺失的 close 语义（所有 sender drop 自动 close）。`BatchReceiver::poll_next`（future.rs:254）：唤醒一次后最多再 poll `max_batch_size-1` 次非阻塞收，N 个消息合成一批返回——摊薄每消息一次 waker 的开销，gRPC batch commands 响应（server/service/kv.rs）与 raftstore-v2 apply 都靠它。`LooseBoundedSender`（mod.rs:208）每 8 次才查一次长度做"宽松"背压。

### VersionTrack：copy-on-read 配置热更

不订阅推送，而是"写方 bump AtomicU64 版本 + 读方 `Tracker::any_new()` 惰性发现"——避免配置消费方（如 SnapManager，src/server/snap.rs:42）注册监听器的生命周期管理；代价是 value/version 非原子可能有 false positive（config.rs:1347 注释自认）。配套 `ConfigManager` trait（online_config/src/lib.rs 的 `dispatch(ConfigChange)`）+ `OnlineConfig` derive 宏，status server 收到 UPDATE_CONFIG 后派发到各 dispatcher（`LogConfigManager`/`DbConfigManger` src/config/mod.rs:2300）。

### 全仓库使用例

1. raftstore：`pd_worker: LazyWorker<PdTask>`（fsm/store.rs:1624）、refresh_config_worker（:1642）
2. storage/txn：`sched_pool.rs` 用 `build_priority_future_pool`（资源组优先级）
3. server/service：`mpsc::future::BatchReceiver` 聚合 batch commands
4. raftstore-v2 apply：同样 BatchReceiver
5. 配置热更：`src/config/mod.rs:3469` LogConfigManager

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Builder | `worker::Builder`（:301）/ `YatpPoolBuilder`（:249） | 多参数池装配 |
| RAII | `RunnableWrapper::drop` → shutdown（:84） | 异常路径也清理 |
| 装饰器 | `NoTimeoutRunnableWrapper`（:96）/ `TickerWrapper`（mod.rs:106） | trait 适配 + 1s 节流 |
| 新类型 + Drop 计数 | mpsc `Sender` | 补第三方库语义 |
| 版本追踪 | `VersionTrack` config.rs:1302 | 惰性热更免监听器 |

## 模块间交互

被全仓库依赖（上述 5 例）；依赖外部 yatp/crossbeam/tikv_alloc；`async-channel` 底层。它必须保持零业务依赖（只有 codec/collections 等同级 util），否则循环依赖。

## 扩展方式

- **新增后台任务**：`enum XxxTask` + `impl Runnable`（run/shutdown）→ `LazyWorker::new("xxx")` + `scheduler().schedule(task)` → 销毁 `stop_worker()`——参考 raftstore pd_worker
- **给池加优先级/多级**：`YatpPoolBuilder::new(ticker).thread_count(min,core,max).build_priority_future_pool(provider)`，钩子挂 `after_start/before_stop`
- **模块配置热更**：derive `OnlineConfig`（skip/submodule 属性）+ `ReadableDuration/ReadableSize` 的 `From<ConfigValue>` + 注册 `impl ConfigManager` dispatcher——参考 src/server/config.rs
