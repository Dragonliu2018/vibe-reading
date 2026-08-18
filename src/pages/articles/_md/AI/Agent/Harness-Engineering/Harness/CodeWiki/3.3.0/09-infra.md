---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "跨切面基础设施"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "job", "lock", "pubsub", "livelog", "ssh"]
description: "Harness 横切基础设施：DB 轮询 job 调度、interface+多实现 lock/pubsub/stream、Redis Streams 事件框架含 reclaiming、gliderlabs/ssh git over ssh"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/00-overview)

---

## 模块定位

本模块不是单一产品面，而是支撑四大产品面（代码托管、CI、Gitspace、制品仓库）的横切关注点集合——后台作业调度、分布式锁、发布订阅、流式传输、实时日志、SSH server、审计、blob 存储、缓存、加密。这些包的共性是**都遵循 interface + 多实现 + Wire DI 模式**：每个包定义抽象接口配 2+ 实现（InMemory 用于 dev/test，Redis/GCS 用于 production），`wire.go` 按 `config.Provider` switch 切换。这种设计让 Harness 能在"单机 `docker run`（内存实现）"与"生产集群（Redis/GCS 实现）"间零业务代码改动地切换，是单进程多部署形态的关键。

## 模块架构

```
job/          DB 轮询调度器（Priority/MaxRetries/Recurring cron/GroupID）
lock/         MutexManager（InMemory sync.Mutex / Redis go-redsync）
pubsub/       PubSub（InMemory channel / Redis Pub/Sub）
events/       事件框架（System 工厂 + GenericReporter/ReaderFactory，泛型 Event[T]）
stream/       Redis Streams 消费（XREADGROUP + reclaimer 回收 idle 消息）
livelog/      实时日志（LogStream interface，内存实现 + 5000 行 FIFO + subscriber fan-out）
ssh/          SSH server（gliderlabs/ssh，认证→授权→git operation）
audit/        审计（Service interface，Noop 实现 + Middleware 提取请求元数据）
blob/         大对象存储（Filesystem / GCS signed URL）
cache/        通用缓存（LRU/TTL/Redis/NoCache）
encrypt/      信封加密（AES-256-GCM，nonce 前缀 + Compat 兼容旧数据）
crypto/       纯函数（HMAC-SHA256 + 常量时间比较）
```

`events/` 和 `stream/` 是其中最复杂的——它不只是简单 pubsub，而是一套持久化、可重放、带消息回收的事件流系统。

## 调用链路

以后台作业执行为例（job 调度器内部循环）：

```
Scheduler.Run() in job/scheduler.go:84   blocking 循环
  └─ schedulerTimer 定时 → processReadyJobs()
        ├─ globalLock("jobs")  in job/lock.go         集群级互斥（防多实例重复调度）
        ├─ store.ListReady(now, availableCount+1)     从 DB 拉到期作业
        ├─ 对每个 job:
        │     ├─ executor.Lookup(jobType) → Handler   查注册表
        │     ├─ go runJob: handler.Handle(ctx, input, ProgressReporter)
        │     │     └─ ProgressReporter 回调上报进度到 DB + pubsub 广播 state change
        │     └─ postExec() in scheduler.go:620
        │           ├─ 成功 → 标记 finished
        │           └─ ConsecutiveFailures <= MaxRetries → 延迟 15s 重新入队
        └─ maxRunning 控制并发上限
跨实例取消：CancelJob() → pubsub.Publish(PubSubTopicCancelJob) → handleCancelJob()
```

<details>
<summary>方法速查表</summary>

| 方法/接口 | 路径 | 职责 | 关键设计 |
|------|------|------|---------|
| `Scheduler.Run` | `job/scheduler.go:84` | 调度循环 | DB 轮询 + globalLock |
| `Handler` interface | `job/executor.go:49` | 作业契约 | `Handle(ctx, input, ProgressReporter)` |
| `MutexManager.NewMutex` | `lock/lock.go:60` | 锁工厂 | key + Option |
| `Event[T]` | `events/events.go:28` | 泛型事件载体 | gob 编码 |
| `GenericReporter` | `events/reporter.go:32` | 事件发送 | StreamProducer.Send |
| `ReaderFactory[R].Launch` | `events/reader.go:36` | 事件消费 | 类型安全 handler |
| `RedisConsumer` | `stream/redis_consumer.go` | Stream 消费 | XREADGROUP + reclaimer |
| `LogStream` interface | `livelog/livelog.go:37` | 实时日志 | Create/Write/Tail |
| `ssh.Server` | `ssh/server.go:88` | SSH server | 共享 RepoCtrl 业务层 |

</details>

## 核心实现

### job 调度器

作业模型 `Job` in `job/types.go` 含 UID、Type、Priority（`JobPriorityNormal=0`/`JobPriorityElevated=1`）、MaxDurationSeconds（timeout）、MaxRetries、State（scheduled/running/finished/failed/canceled）、IsRecurring + RecurringCron（cron 表达式）、ConsecutiveFailures、GroupID。`Definition` in `job/definition.go` 是对外提交入口，`toNewJob()` 转 `Job` 入库。

调度是 **DB-backed 轮询模型**，非 cron 触发器：`Scheduler.Run()` in `job/scheduler.go:84` 是 blocking 循环，`schedulerTimer` 定时调 `processReadyJobs()`，用 `store.ListReady(now, availableCount+1)` 从 DB 拉到期作业，`globalLock()`（锁 key `"jobs"`）做集群级互斥防多实例重复调度，`maxRunning` 控制并发上限。Recurring 作业用 `cronexpr` 算下次执行时间。失败重试：`ConsecutiveFailures <= MaxRetries` 时延迟 15s 重新入队（`postExec()` in `scheduler.go:620`）。跨实例取消通过 pubsub topic `PubSubTopicCancelJob` 广播。`Handler` interface in `job/executor.go:49` 的 `Handle(ctx, input string, fn ProgressReporter) (result string, err error)` 是契约，`Executor` 持 `map[string]Handler` 在 boot 时注册、`finishRegistration()` 冻结。内置两个 job：overdue recovery（找回超时未完成）和 purge（清理过期）。

### lock / pubsub：可切换后端

`MutexManager` interface in `lock/lock.go:60`（`NewMutex(key, ...Option) (Mutex, error)`），`Mutex` interface（`Key`/`Lock`/`Unlock`）。两实现：`InMemory` in `lock/memory.go`（本地 `sync.Mutex` + `map[string]inMemEntry`，token-based 防误释放，TTL 过期，retry with `DelayFunc`，仅 dev）；`Redis` in `lock/redis.go`（封装 `go-redsync` 做分布式互斥，支持 Expiry/Tries/RetryDelay/DriftFactor）。`ProvideMutexManager` in `lock/wire.go` 按 `config.Provider` 返回对应实现。

`PubSub` interface in `pubsub/pubsub.go:25` = `Publisher`（`Publish`）+ `Subscribe` → `Consumer`。两实现：`InMemory` in `pubsub/inmem.go`（channel-based，带 send timeout 和 channel size）；`Redis` in `pubsub/redis.go`。Wire 按配置切换。使用方：`app/services/locker` 用 namespace `repo`/`registry` 做仓库/镜像锁；`app/pipeline/scheduler` 做队列锁；`job/scheduler` 的 `globalLock` 做 job 调度全局锁。

### events 框架：泛型 + Redis Streams + 消息回收

`events` 是比 `pubsub` 更高层的事件系统，建在 `stream` 包之上。`Event[T]` in `events/events.go:28` 是泛型事件载体。`System` in `events/system.go:21` 聚合 `StreamProducer` + `StreamConsumerFactoryFunc` + `Collector`，是创建 Reporter 和 ReaderFactory 的工厂。

发送 `GenericReporter` in `events/reporter.go:32` 经 `ReporterSendEvent[T]()` 把事件 gob 编码后 `StreamProducer.Send()` 写入 Redis Stream，streamID 格式 `events:{category}:{eventType}`。消费 `ReaderFactory[R]` in `events/reader.go:36` 的 `Launch()` 创建 stream consumer，`ReaderRegisterEvent[T]()` 注册类型安全 handler，gob 解码后调业务函数。

**持久化与重放**：事件存于 Redis Streams（非 DB），通过 consumer group 的 `XREADGROUP` 消费。`stream/redis_consumer.go` 实现完整的 message reclaiming——`reclaimer` 定时用 `XPENDING` + `XCLAIM` 找回 idle 超时未 ACK 的消息，stale consumer 清理，超过 `maxRetries` 的消息 `XACK` 丢弃（`DiscardedMessageError`）。消费端重启时先 `scanHistory` 扫历史实现无缝恢复。mode 可选 `redis`/`inmemory`。这套机制让 [领域服务层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/03-services)的 webhook 能可靠消费 PR/repo 事件，容忍消费者崩溃与重启。

### stream/livelog：实时日志

`stream` 包抽象层定义 `HandlerFunc` in `stream/stream.go:58`（`func(ctx, messageID string, payload map[string]any) error`）。`RedisConsumer` in `stream/redis_consumer.go` 是核心实现：`XREADGROUP` + consumer group 消费，多 worker goroutine（`Concurrency`）并行处理，reclaimer 回收 idle 消息，支持 retry/discard。

`livelog` 包 `LogStream` interface in `livelog/livelog.go:37`（`Create/Delete/Write/Tail/Info`），`Line` 含 Number/Message/Timestamp。唯一实现 `streamer` in `livelog/memory.go` 是纯内存：`map[int64]*stream` 按 step ID 管理，`stream` in `livelog/stream.go:28` 维护 5000 行 FIFO 历史缓冲 + subscriber fan-out，`Tail()` 返回 `<-chan *Line` 先 replay 历史再实时推送。Wire 只提供 `NewMemory()`，无 Redis/DB 实现——**实时推送仅内存，日志持久化由 [CI 引擎](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/06-pipeline)的 manager 写入 blob 存储**。前端经 `app/api/controller/logs/tail.go` 的 `Controller.Tail()` 返回 `<-chan *livelog.Line`（SSE 推送）。

### ssh server 与审计

`ssh.Server` in `ssh/server.go:88` 封装 `gliderlabs/ssh`，流程认证→授权→git operation：`publicKeyHandler()` in `:377` 调 `publickey.SSHAuthService.ValidateKey()` 验证公钥已注册，支持 SSH certificate（需配置 trusted CA keys），认证成功 principal 存入 ssh context；`sessionHandler()` in `:218` 解析命令，白名单只允许 `git-upload-pack`/`git-receive-pack`/`git-lfs-authenticate`/`git-lfs-transfer`，git 命令委托 `RepoCtrl.GitServicePack()`（复用 HTTP router 同一 controller），LFS 委托 `LFSCtrl.Authenticate()`，设 keepalive 防断连。**SSH 独立 listener 但共享 `RepoCtrl`/`LFSCtrl` 业务层**——传输层不同业务层统一。

审计 `audit.Service` interface in `audit/interface.go:23`（`Log(ctx, user, resource, action, spacePath, ...Option) error`），`Event` in `audit/audit.go:160` 记录 Action（created/updated/deleted/uploaded/downloaded/bypassed/forcePush）、Resource（13 种类型）、User、SpacePath、DiffObject（old/new）、ClientIP、RequestMethod。实现仅有 `Noop` in `audit/audit.go:189`，`Middleware()` in `audit/middleware.go:31` 是 HTTP 中间件从 header 提取 RealIP/path/method/requestID 存 context 供后续审计调用。调用方是 reposettings/githook（post-receive）/migrate/pullreq 等控制器在关键写操作时调 `Service.Log()`。

### blob/cache/encrypt

| 包 | 接口 | 实现 |
|---|---|---|
| **blob** | `Store` in `blob/interface.go:29`（Upload/GetSignedURL/Download/Move/Delete） | `Filesystem`（本地 FS）、`GCS`（signed URL） |
| **cache** | `Cache[K,V]` in `cache/cache.go:22`（Stats/Get/Evict），`ExtendedCache` 加 Map | `LRUCache`/`NoCache`/`RedisCache`/`TTLCache` |
| **encrypt** | `Encrypter` in `encrypt/encrypt.go:27`（Encrypt/Decrypt） | `Aesgcm`（AES-256-GCM，32-byte key，nonce 前缀，`Compat` 兼容未加密旧数据）、`None` |
| **crypto** | 纯函数 | `GenerateHMACSHA256`、`IsShaEqual`（常量时间比较，用于 [服务层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/03-services)webhook 签名验证） |

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| interface + 多实现 + DI 切换 | 所有包 | 单机内存↔生产 Redis/GCS 零改动切换 |
| Options pattern | `WithExpiry`/`WithNamespace` | 配置覆盖 |
| 泛型事件 | `Event[T]` + `ReaderFactory[R]` | 类型安全 handler |
| Redis Streams reclaiming | `reclaimer` XPENDING+XCLAIM | 消费者崩溃不丢消息 |
| DB 轮询 + 全局锁 | job scheduler | 简单可靠的集群调度 |

## 模块间交互

`job` → `lock`（globalLock）+ `pubsub`（cancel 广播 + state change）；`events` → `stream`（Redis Streams 传输层）；`livelog` → 被 [CI 引擎](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/06-pipeline) `manager` 写日志 + [API 层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/02-api)`controller/logs` tail；`ssh` → 复用 `app/api/controller/repo` + `lfs`；`audit` → 被多个 controller 调用；`lock` → 被 [服务层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/03-services)`locker`、[CI](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/06-pipeline)`scheduler`、`job/scheduler` 广泛使用；`blob` → 被 pipeline（artifact 存储）、log 持久化使用。

## 扩展方式

**新增 pubsub 后端（如 Kafka）**：实现 `PubSub` + `Consumer` 接口（`Publish`/`Subscribe`/`Close`），在 `pubsub/wire.go` 的 `ProvidePubSub` switch 加 `case ProviderKafka`，新增 `Config.Provider` 常量。无需改任何消费方代码。

**加一个后台 job handler**：实现 `Handler` interface（`Handle(ctx, input, ProgressReporter) → (result, err)`），在 app boot 阶段 `executor.Register(jobType, handler)`，用 `scheduler.RunJob(ctx, Definition{Type: jobType, Data: ...})` 提交。recurring 用 `scheduler.AddRecurring(uid, type, cronExpr, maxDur)`。

**换 lock 实现（如 etcd）**：实现 `MutexManager` + `Mutex` 接口，在 `lock/wire.go` 的 `ProvideMutexManager` switch 加 `case EtcdProvider`，新增 Config 字段。所有使用方（job scheduler、pipeline scheduler、locker service）自动切换。
