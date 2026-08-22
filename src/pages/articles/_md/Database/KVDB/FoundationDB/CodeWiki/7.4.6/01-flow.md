---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "异步运行时"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "7.4.6"]
tags: ["FoundationDB", "C++", "Future", "Promise", "协程", "事件循环"]
description: "flow 模块——FoundationDB 协作式异步运行时，SAV/Future/Promise + C++20 协程与旧 actor 编译器并存 + Net2 事件循环 + FastAlloc + Arena + 确定性随机。"
readingTime: "40 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/7.4.6/00-overview)

---

## 模块定位

`flow/`（~70k 行 C++）是整个 FDB 的基石——一套**单线程协作式异步运行时**。FDB 的所有上层角色（事务、日志、存储、协调）都基于它构建：不抢占、不加锁、靠协程在 I/O 等待时主动让出。它同时是 FDB 确定性模拟测试的根基——单线程 + 确定性随机让并发 bug 可复现。7.4.6 处于 C++20 协程与旧 actor 编译器并存的过渡期，两者共用 SAV/Future/Promise 底层机制。

## 模块架构

flow 内部是三层结构，自底向上：

- **核心层**（`flow/include/flow/flow.h`）：`SAV<T>` 单赋值变量、`Future<T>`、`Promise<T>`、`Callback<T>` 侵入式回调链表、`Actor<T>`。这是预存的 Future/Promise 体系，双重引用计数，回调链表。
- **协程适配层**（`flow/include/flow/CoroutinesImpl.h` + `Coroutines.h`）：`coroutine_traits` 把返回 `Future<T>` 的函数特化为 C++20 协程，`CoroPromise` 内嵌 `CoroActor`（继承 `Actor<T>` 继承 `SAV<T>`）在协程帧内一次分配；`AwaitableFuture` 继承 `Callback<T>`，使等待者本身成为回调节点。
- **工具层**（`flow/genericactors.actor.cpp` + `genericactors.actor.h`）：`race()`、`waitForAll()`、`quorum()`、`timeout()`、`choose`、`FlowLock`、`AsyncVar`、`NotifiedInt` 等组合算子，既有协程版（`co_await`）也有旧 actor 版，因共享 SAV/Callback 基础设施而共存。

`Net2`（`flow/Net2.actor.cpp:129`）是生产环境的事件循环实现，基于 Boost.Asio 的 `epoll`/`kqueue`，搭配 `TaskQueue` 优先级任务队列。`FastAllocator` 与 `Arena` 提供高频小对象与网络消息的内存管理。`DeterministicRandom` 提供确定性随机数，`FaultInjection`/`SimBugInjector`/`Buggify` 是模拟测试的故障注入原语。

## 调用链路

从 `Net2::run()` 出发的事件循环——一次 actor 等待→恢复：

```text
Net2::run()  [flow/Net2.actor.cpp L1579]
  ├─ 计算 sleepTime = taskQueue.getSleepTime(now) → reactor.sleep()  Boost.Asio 阻塞
  ├─ reactor.react()  非阻塞 poll_one 处理就绪 I/O
  ├─ updateNow() 更新 currentTime
  ├─ taskQueue.processReadyTimers(now)  到期定时器进就绪队列
  ├─ taskQueue.processThreadReady()  跨线程 onMainThread() 投递的任务
  └─ while (hasReadyTask())  按优先级执行就绪任务
       (*task)() → promise.send() → SAV::send() → Callback::fire()
            → coroutine_handle::resume()  恢复协程
       check_yield(Max)  TSC 超时或高优先级入队则 break
```

以 `co_await someFuture` 为例（旧 actor 编译器生成的代码结构类似）：协程执行 `co_await` → `await_ready()` false → `await_suspend(handle)`：`pt->setHandle(h)` 存协程句柄到 `CoroActor`，`future.addCallbackAndClear(this)` 把 `AwaitableFuture` 注册为 SAV callback，协程挂起；时间流逝、网络 I/O 完成后 `SAV::send(value)` 遍历 callback 链 `fire()` → `AwaitableFuture::fire` → `pt->resume()` → `coroActor->handle.resume()` 恢复协程 → `await_resume()` 返回值或抛错 → `co_return` 触发 `final_suspend` → `finishSendAndDelPromiseRef` 给返回值 SAV 赋值。取消路径：`Future::cancel` → `SAV::cancel` → `CoroActor::cancel`，`actor_wait_state` 置 -1，若 `prev_wait_state > 0` 则 resume 协程抛 `actor_cancelled`。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `Net2::run` | `flow/Net2.actor.cpp:1579` | 主事件循环 |
| `Net2::delay` | `flow/Net2.actor.cpp` | 注册定时器返回 Future |
| `Net2::yield` | `flow/Net2.actor.cpp:1899` | 让出 CPU |
| `Net2::check_yield` | `flow/Net2.actor.cpp` | TSC/栈深/优先级检查 |
| `SAV::send` | `flow/include/flow/flow.h:742` | 赋值并触发 callback 链 |
| `SAV::addCallbackAndDelFutureRef` | 同上 | 注册回调（协程恢复入口） |
| `TaskQueue::addReady` | `flow/include/flow/TaskQueue.h:34` | `(taskId<<32)-(++seq)` 入队 |
| `FastAllocator::allocate` | `flow/FastAlloc.cpp:375` | 线程本地 freelist 分配 |
| `ArenaBlock::create` | `flow/include/flow/Arena.h:171` | 区域分配 bump+引用计数 |
| `DeterministicRandom::random01` | `flow/DeterministicRandom.h:38` | std::mt19937 确定性随机 |
</details>

## 核心实现

### SAV<T> — 单赋值变量

`SAV<T>`（`flow.h:742`）是 Future 和 Promise 共享的底层状态对象，继承 `Callback<T>` 和 `FastAllocated<SAV<T>>`。维护 `promises`/`futures` 双引用计数，以及 `Callback<T>` 侵入式双向环形链表——`SAV<T>` 自身继承 `Callback<T>` 并作为链表头。`send()` 赋值后遍历链表依次 `fire()`；引用计数归零自动销毁。`error_state` 用三个哨兵码区分未设/永不完成/已设/出错。**关键**：多 Future 订阅——多个消费者可 `getFuture()` 共享同一 SAV，与 `std::future` 只能单消费不同，这是 FDB 异步组合的基础。

### Future<T> / Promise<T> — 消费者与生产者

`Future<T>`（`flow.h:984`）仅持一个 `SAV<T>*` 指针，拷贝时 `addFutureRef`、析构时 `delFutureRef`。`Promise<T>`（`flow.h:1102`）持写权限，构造时 `new SAV<T>(0,1)`（零 Future 一个 Promise），`getFuture()` 增引用返回 Future。`addCallbackAndClear` 把回调注册到 SAV 并 relinquish Future 引用——协程挂起的底层机制。

### CoroPromise — C++20 协程的 Promise

`flow/include/flow/Coroutines.h:156` 特化 `coroutine_traits<Future<T>>`，把任何返回 `Future<T>` 的函数变成协程。`CoroPromise`（`CoroutinesImpl.h:304`）内嵌一个 `CoroActor`（`CoroutinesImpl.h:91`，继承 `Actor<T>` 继承 `SAV<T>`）在协程帧内——一次帧分配同时获得 SAV、Actor 和协程状态机。`await_transform` 把每个 `Future<T>` 包装为 `AwaitableFuture`（`CoroutinesImpl.h:201`，继承 `Callback<T>`），使等待者本身成为回调节点：被等待的 SAV 完成时直接 `resume()` 协程，无需间接调度。`Uncancellable` 标记类型（`Coroutines.h:41`）通过模板在编译期决定 `IsCancellable`，不可取消的 actor 不响应 cancel。7.4.6 中协程与旧 actor 编译器共存——`CoroActor` 继承 `Actor<T>` 即 `SAV<T>`，协程可 `co_await` 旧 actor 返回的 Future，旧 actor 也可等待协程返回的 Future。

### Net2 与 TaskQueue — 事件循环与优先级调度

`Net2`（`Net2.actor.cpp:129`）实现 `INetwork` 与 `INetworkConnections`，核心是 `ASIOReactor reactor` 和 `TaskQueue<PromiseTask> taskQueue`。约 50 个 `TaskPriority`（`TaskPriority.h`），从 `Zero` 到 `Max`。`TaskQueue`（`TaskQueue.h:34`）用 `priority_queue` 排序，`getFIFOPriority` 将 `taskId` 左移 32 位减去递增序号，保证同优先级 FIFO。`check_yield` 基于 TSC（`tscEnd = tscBegin + TSC_YIELD_TIME`）防止单任务饿死，也检查栈深（`g_stackYieldLimit`）与更高优先级就绪。

### FastAlloc 与 Arena — 内存管理

`FastAllocator<Size>`（`FastAlloc.h:117`、`FastAlloc.cpp:375`）是三级对象池：线程本地 freelist（无锁）→ 备用 magazine → 全局 magazine 池（临界区，低竞争）。双 magazine 设计（freelist + alternate）：freelist 满时交换到 alternate，alternate 也满则归还一个到全局。固定大小分桶（16~16384 字节），`kFastAllocMagazineBytes=128KB`。FDB 高频分配小对象（SAV、PromiseTask、ArenaBlock、Callback），通用 `malloc` 的锁竞争与碎片不可接受。

`ArenaBlock`（`Arena.h:171`）是 bump 分配器：一块内存内所有分配只移动指针，区域销毁时整块回收，`ThreadSafeReferenceCounted` 引用计数。`dependsOn()` 建立 Arena 间依赖，子 Arena 跟随父生命周期。`Standalone<T>` 继承 Arena + T 绑定数据与内存生命周期。小块（≤64B）用 tiny header（6 字节），`secure` 位标记敏感数据用后清零。

### 确定性随机与故障注入

`DeterministicRandom`（`DeterministicRandom.h:38`、`DeterministicRandom.cpp:27`）用 `std::mt19937` 保证跨平台一致。`gen64()` 返回预计算 `next` 再生成下一值，`peek()` 不消耗地窥探下一值，所有方法可写 `randLog` 供回放。`deterministicRandom()` 全局实例模拟中用固定种子，驱动故障注入、网络延迟、消息重排。`Buggify`（`Buggify.h:79`）用 `deterministicRandom()->random01()` 决定激活 section，确保模拟中确定性注入故障。`FaultInjection.h` 的 `INJECT_FAULT` 宏通过全局函数指针 `should_inject_fault` 注入 io_timeout/io_error。`SimBugInjector`（`SimBugInjector.h`）注入实际 bug 做负面测试——验证测试能否发现它该发现的 bug。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Promise/Future 单赋值 | `SAV<T>` in `flow.h:742` | 协作式异步通用粘合剂，支持多订阅 |
| Actor 模型 + 协程并存 | `Actor<T>` in `flow.h:1496`、`CoroActor` in `CoroutinesImpl.h:91` | 旧 actor 编译器与 C++20 协程共享 SAV 机制 |
| Reactor 事件循环 | `Net2` in `Net2.actor.cpp:129` | Boost.Asio poll_one/run_one 非阻塞 I/O |
| 优先级调度 | `TaskQueue` in `TaskQueue.h:34` | `(priority<<32)-seq` 同优先级 FIFO，TSC 防饥饿 |
| 对象池 FastAlloc | `FastAlloc.h:117` | 高频小对象无锁分配，双 magazine |
| 区域分配 Arena | `Arena.h:171` | 网络消息 bump 分配+整体回收 |
| RAII 释放器 | `FlowLock::Releaser` in `genericactors.actor.h:1602` | 异步代码里的自动释放 |

## 模块间交互

flow 被几乎所有模块依赖：`g_network->now()` 取时间、`delay()` 定时、`yield()` 让出、`Future/Promise` 作通用异步接口、`Arena` 作网络消息内存、`FlowLock` 限流、`AsyncVar` 订阅-通知、`NotifiedInt` 等待单调版本。flow → Boost.Asio：`ASIOReactor` 封装 `io_service`，网络操作 `async_*` 回调写入 `BindPromise` 后 `send` 到 Promise 触发 actor 恢复。flow → TLS：`SSLConnection` 封装 `boost::asio::ssl::stream`，`SSLHandshakerThread` 在独立线程池握手经 `ThreadReturnPromise<Void>` 跨线程返回。`SimulatedNetwork` 替代 `Net2` 作 `g_network` 用于确定性测试，复用 `TaskQueue`/`PromiseTask` 调度原语。`INetwork::global(id)`/`setGlobal(id,v)` 提供 23 个全局槽位注册（`enumGlobal`），`FlowTransport` 经 `enFlowTransport` 槽注册为全局单例。

## 扩展方式

新增 `TaskPriority`：在 `TaskPriority.h` 枚举按数值顺序插入，`TaskQueue::getFIFOPriority` 自动组合排序键无需改 `TaskQueue`。新增异步操作：新增 `ACTOR` 函数或 C++20 协程返回 `Future<T>`，用 `wait()`/`co_await` 等待（参考 `genericactors.actor.cpp` 的 `timeout`/`waitForAll`）。新增 `FastAllocator` 大小类：在 `nextFastAllocatedSize()`（`FastAlloc.h:255`）添加，注意须是 `sizeof(void*)` 倍数。新增故障注入点：用 `BUGGIFY` 宏（`Buggify.h:79`）或 `INJECT_FAULT`（`FaultInjection.h:26`）或 `SimBugInjector`。
