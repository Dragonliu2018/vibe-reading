---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "异步运行时"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "main-2026-08"]
tags: ["FoundationDB", "C++", "Future", "Promise", "协程", "事件循环"]
description: "flow 模块——FoundationDB 协作式异步运行时，SAV/Future/Promise + C++20 协程三层架构 + Net2 事件循环 + FastAlloc + Arena + 确定性随机。"
readingTime: "40 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`flow/`（~70k 行 C++）是整个 FDB 的基石——一套**单线程协作式异步运行时**。FDB 的所有上层角色（事务、日志、存储、协调）都基于它构建：不抢占、不加锁、靠协程在 I/O 等待时主动让出。它同时是 FDB 确定性模拟测试的根基——单线程 + 确定性随机让并发 bug 可复现。任何不基于 flow 的异步代码在 FDB 里都不存在。

## 模块架构

flow 内部是一个三层结构，自底向上：

- **核心层**（`flow/include/flow/flow.h`）：`SAV<T>` 单赋值变量、`Future<T>`、`Promise<T>`、`Callback<T>` 侵入式回调链表、`Actor<T>`。这是预存的 Future/Promise 体系，双重引用计数，回调链表。
- **协程适配层**（`flow/include/flow/Coroutines.h` + `CoroutinesImpl.h`）：`coroutine_traits` 把返回 `Future<T>` 的函数特化为 C++20 协程，`CoroPromise` 内嵌 `CoroActor`（继承 `Actor<T>` 继承 `SAV<T>`）在协程帧内一次分配；`AwaitableFuture` 继承 `Callback<T>`，使等待者本身成为回调节点。
- **工具层**（`flow/genericactors.cpp` + `genericactors.h`）：`race()`、`waitForAll()`、`quorum()`、`timeout()`、`choose`、`FlowLock`、`AsyncVar`、`NotifiedInt` 等组合算子，既有协程版（`co_await`）也有回调版，因共享 SAV/Callback 基础设施而共存。

`Net2`（`flow/Net2.cpp:139`）是生产环境的事件循环实现，基于 Boost.Asio 的 `epoll`/`kqueue`，搭配 `TaskQueue` 优先级任务队列。`FastAllocator` 与 `Arena` 提供高频小对象与网络消息的内存管理。`DeterministicRandom` 提供确定性随机数，`FaultInjection`/`SimBugInjector`/`Buggify` 是模拟测试的故障注入原语。

## 调用链路

从 `Net2::run()` 出发的事件循环——一次 actor 等待→恢复：

```text
Net2::run() [flow/Net2.cpp:1563]  主事件循环
  ├─ ASIOReactor::sleep()  按下一个定时器时间阻塞处理一个 I/O 事件
  │    └─ I/O 完成回调 (BindPromise::operator()) → SAV::send() → Callback::fire()
  ├─ ASIOReactor::react()  非阻塞 poll 所有就绪 I/O
  ├─ taskQueue.processReadyTimers(now)  到期定时器进就绪队列
  ├─ taskQueue.processThreadReady()  跨线程 onMainThread() 投递的任务
  └─ while (hasReadyTask())  按优先级执行就绪任务
       (*task)() → promise.send() → SAV::send() → Callback::fire()
            → coroutine_handle::resume()  恢复协程
                 ├─ 执行后续代码
                 ├─ 遇 co_await → 注册 Callback 到 SAV，协程挂起
                 └─ co_return → CoroPromise 设置返回值 → SAV::send()
       check_yield()  检查栈深/TSC 时间片/更高优先级，必要时让出
```

以 `co_await delay(1.0)` 为例：`Net2::delay()`（`Net2.cpp:1910`）new 一个 `PromiseTask` 加入定时器最小堆，返回关联 `Future`；`co_await` 的 `await_suspend` 把 `AwaitableFuture`（继承 `Callback<T>`）注册到 SAV 回调链，协程挂起；1 秒后定时器到期，`PromiseTask` 进就绪队列，主循环取出执行 `promise.send(Void())` → `SAV::send()` → `Callback::fire()` → `AwaitableFuture::resume_coro` → `coroutine_handle::resume()`，协程从 `co_await` 后继续。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `Net2::run` | `flow/Net2.cpp:1563` | 主事件循环，驱动 I/O 与就绪任务 |
| `Net2::delay` | `flow/Net2.cpp:1910` | 注册定时器，返回 Future |
| `Net2::check_yield` | `flow/Net2.cpp:1861` | 栈深/时间片/优先级检查，决定让出 |
| `SAV::send` | `flow/include/flow/flow.h:729` | 设置值，遍历回调链 fire |
| `SAV::addCallbackAndDelFutureRef` | 同上 | 注册回调（协程恢复入口） |
| `TaskQueue::addReady` | `flow/include/flow/TaskQueue.h:34` | 按 `(priority<<32)|FIFO` 入队 |
| `FastAllocator<Size>::allocate` | `flow/FastAlloc.cpp:373` | 线程本地 freelist 分配 |
| `ArenaBlock::create` | `flow/Arena.cpp:421` | 区域分配，整块回收 |
| `DeterministicRandom::random01` | `flow/DeterministicRandom.cpp:36` | mt19937 确定性随机 |
</details>

## 核心实现

### SAV<T> — 单赋值变量

`SAV<T>`（`flow.h:729`）是 Future 和 Promise 共享的底层状态对象，继承 `Callback<T>` 和 `FastAllocated<SAV<T>>`。它维护 `promises`/`futures` 双引用计数，以及一个 `Callback<T>` 侵入式双向环形链表——`SAV<T>` 自身继承 `Callback<T>` 并作为链表头。`send()` 设置值后遍历链表依次 `fire()`；引用计数归零自动销毁。`error_state` 用三个哨兵码区分未设/永不完成/已设/出错。

关键设计：**多 Future 订阅**——多个消费者可 `getFuture()` 共享同一 SAV，与 `std::future` 只能单消费不同，这是 FDB 异步组合的基础（一个结果可扇出给多个等待者）。

### Future<T> / Promise<T> — 消费者与生产者

`Future<T>`（`flow.h:972`）仅持一个 `SAV<T>*` 指针（8 字节），是 SWIFT_SENDABLE；`Promise<T>`（`flow.h:1091`）持写权限。`Promise` 构造时 `new SAV<T>(0,1)`（零 Future 一个 Promise），`getFuture()` 增引用计数返回 Future。`Future::addCallbackAndClear` 把回调注册到 SAV 并 relinquish Future 引用——这是协程挂起的底层机制。

### CoroPromise — C++20 协程的 Promise

`flow/include/flow/Coroutines.h:325` 特化 `coroutine_traits<Future<ReturnValue>, Args...>`，把任何返回 `Future<T>` 的函数变成协程。`CoroPromise` 内嵌一个 `CoroActor`（继承 `Actor<T>` 继承 `SAV<T>`）在协程帧内——一次帧分配同时获得 SAV、Actor 和协程状态机。`await_transform` 把每个 `Future<T>` 包装为 `AwaitableFuture`（继承 `Callback<T>`），使等待者本身成为回调节点：被等待的 SAV 完成时直接 `resume()` 协程，无需间接调度。

三个标记类型（`Uncancellable`、`NoThrowOnCancel`、`ExplicitVoid`）通过 `Args...` 参数包在编译期选择不同 Promise 变体，实现编译期策略选择。`genericactors.cpp` 里的组合算子全部直接用 `co_await`/`co_return`（如 `allTrue` at line 25）。

### Net2 与 TaskQueue — 事件循环与优先级调度

`Net2`（`Net2.cpp:139`）实现 `INetwork` 与 `INetworkConnections`，核心是 `ASIOReactor reactor` 和 `TaskQueue<PromiseTask> taskQueue`。约 50 个 `TaskPriority`（`TaskPriority.h:26`，从 `Zero`(0) 到 `Max`(1000000)），覆盖网络 I/O、TLog、Proxy、数据分布等。`TaskQueue` 用 64 位排序键 `(priority << 32) | FIFO_counter` 保证同优先级 FIFO。`check_yield`（`Net2.cpp:1861`）在时间片用完（TSC 检查）、栈深不足、或有更高优先级就绪时让出。`NetworkMetrics::starvationBins`（`network.cpp:427`）追踪各优先级区间的饥饿时间。

### FastAlloc 与 Arena — 内存管理

`FastAllocator<Size>`（`FastAlloc.cpp:373`）是三级对象池：线程本地 freelist（无锁）→ 备用 magazine → 全局 magazine 池（临界区，低竞争）。12 个固定大小特化（16~16384 字节）。FDB 高频分配小对象（SAV、PromiseTask、ArenaBlock、Callback），通用 `malloc` 的锁竞争与碎片不可接受。

`ArenaBlock`（`Arena.cpp:421`）是区域分配器：一块内存内所有分配只移动指针，区域销毁时整块回收。`dependsOn()` 建立 Arena 间依赖图，子 Arena 跟随父 Arena 生命周期。`Standalone<T>` 继承 `Arena` 和 `T`，绑定数据与其内存的生命周期——FDB 网络消息大量用 `StringRef`/`VectorRef` 指向 Arena 内数据，避免逐个 free。Tiny 模式（≤64 字节）直接走 `FastAllocator<32>/<64>`。

### 确定性随机与故障注入

`DeterministicRandom`（`DeterministicRandom.cpp:36`）用 `boost::mt19937_64` 保证跨平台一致。`bindDeterministicRandomToOpenssl()`（`flow.cpp:354`）甚至把 OpenSSL 的 `RAND_bytes` 替换为确定性随机——让涉及加密的模拟也完全可复现。`FaultInjection.h` 的 `INJECT_FAULT` 宏通过全局函数指针 `should_inject_fault`（模拟模式下设为 `simulator_should_inject_fault`）注入 io_timeout/io_error。`SimBugInjector`（`SimBugInjector.h`）注入实际 bug 做负面测试——验证测试能否发现它该发现的 bug。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Promise/Future 单赋值 | `SAV<T>` in `flow.h:729` | 协作式异步通用粘合剂，支持多订阅 |
| 协作式调度 + 协程状态机 | `Net2::run`、`CoroPromise` | 非抢占、单线程，保证模拟可复现 |
| 对象池 FastAlloc | `FastAlloc.cpp:373` | 高频小对象无锁分配 |
| 区域分配 Arena | `Arena.cpp:421` | 网络消息批量分配+回收 |
| 优先级调度 | `TaskQueue.h:34`、`TaskPriority.h:26` | I/O 与计算分优先级，防饥饿 |
| 确定性测试 | `DeterministicRandom.cpp:36` | 种子固定→bug 可复现 |
| RAII 释放器 | `FlowLock::Releaser` in `genericactors.h:2025` | 异步代码里的自动释放 |

## 模块间交互

flow 被几乎所有模块依赖：`g_network->now()` 取时间、`delay()` 定时、`yield()` 让出、`Future/Promise` 作通用异步接口、`Arena` 作网络消息内存、`FlowLock` 限流（如 TLS 握手并发，`network.cpp:495`）、`AsyncVar` 订阅-通知（如配置变更）、`NotifiedInt` 等待单调版本（`whenAtLeast(version)`）。`fdbrpc` 的 `FlowTransport` 基于 `INetwork`：`connect/listen` 调 `g_network->connect/listen` → `Net2::connect`。`Sim2`（`fdbrpc/sim2.cpp`）替代 `Net2` 作为 `g_network`，但**复用** `TaskQueue`/`PromiseTask` 调度原语——只是网络连接换成进程内模拟，时间换成虚拟时钟。

## 扩展方式

新增 `TaskPriority`：在 `TaskPriority.h:26` 枚举按数值顺序插入，可能需更新 `NetworkMetrics::starvationBins`（`network.cpp:427`）确保被饥饿追踪覆盖；`TaskQueue::getFIFOPriority` 自动组合排序键，无需改 `TaskQueue`。新增 actor 组合算子：在 `genericactors.cpp` 参照 `shortCircuitAny`（line 101）用 `co_await` + `race()/waitForAll()` 原语编写。新增 `FastAllocator` 大小类：在 `FastAlloc.cpp:699-710` 模板实例化列表加 `template class FastAllocator<NewSize>;`，注意大小须是 `sizeof(void*)` 倍数。
