---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "Overlord 任务调度"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "Overlord", "任务调度", "Supervisor", "autoscaling"]
description: "Druid Overlord——TaskMaster leader 选举、TaskQueue 读写锁并发、HttpRemoteTaskRunner（37 默认全 HTTP）、Supervisor 生命周期、TaskLockbox 时间锁、autoscaling。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（`indexing-service/.../overlord/`）是 Druid 的"**摄入管家**"：接收摄入 task、调度到 worker（MiddleManager/Indexer/peon）、管理流摄入 Supervisor 生命周期、用时间区间锁保证 segment 版本顺序、按需 autoscale worker。它是 master 侧，与摄入引擎模块（worker 侧 task 执行）互补。职责边界：**task 从提交到派发到 worker 的调度**；task 内部如何写 segment 见摄入引擎模块。

## 模块架构

```
DruidOverlord（HTTP resource, /druid/indexer/v1/task）
  → TaskQueue（add/manageQueuedTasks，ReentrantReadWriteLock）
       │ managerExec 单线程串行 manageQueuedTasks
       ▼
  TaskMaster（leader 选举 + 调度循环）
       ├── TaskStorage（MetadataTaskStorage / HeapMemoryTaskStorage）
       ├── TaskLockbox / GlobalTaskLockbox（时间区间锁）
       └── TaskRunner（策略，由 TaskRunnerFactory 按 config 选择）
             ├── HttpRemoteTaskRunner（37 默认，全 HTTP，WorkerHolder）
             ├── RemoteTaskRunner（ZK 事件驱动，PathChildrenCache）
             └── ForkingTaskRunner（本地 fork 进程）
  SupervisorManager → SeekableStreamSupervisor（Kafka/Kinesis，周期生成 task）
  AutoScaler（@ExtensionPoint，EC2/GCE）+ ProvisioningStrategy
```

## 调用链路

```
POST task → DruidOverlord → TaskQueue.add
  → TaskStorage.insert → manageQueuedTasks()
  → TaskRunner.run(task) → ListenableFuture<TaskStatus>
     [HttpRemoteTaskRunner] 找/启 worker → POST /druid/worker/v1/task → worker(peon) 执行
     → worker 周期上报状态 → TaskRunner 触发 listener → TaskQueue.taskComplete 回调
Supervisor: SupervisorManager.start → supervisor 周期生成 SeekableStreamIndexTask → submit
  → checkpoint 回调推进 offset、建新 sequence
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `TaskQueue.add` | 入队 task | 读锁保护，不阻塞管理线程 |
| `TaskQueue.manageQueuedTasks` | 派发就绪 task | 单线程串行 |
| `TaskMaster` | leader + 调度 | 只 leader 调度 |
| `TaskRunner.run` | 执行 task 返回 future | 策略多实现 |
| `HttpRemoteTaskRunner` | 全 HTTP 派发 | 37 默认，弃 ZK |
| `TaskLockbox.lock` | 时间区间锁 | 保证 segment version 顺序 |
| `Supervisor.run` | 周期生成 task | 自愈、checkpoint |

</details>

## 核心实现

### TaskMaster 与 leader

`overlord/TaskMaster.java` 做 leader 选举（经 `DruidLeaderSelector`）与调度循环。only leader 调度，避免多 Overlord 重复派发。`becomeLeader` 启动 `TaskQueue` 与 `TaskRunner`，`stopBeingLeader` 清理。leader 切换时 `TaskQueue.syncFromStorage` 从 `TaskStorage` 恢复未完成 task。

### TaskQueue 并发

`overlord/TaskQueue.java` 用 `ReentrantReadWriteLock`（L139）：`start`/`stop` 取 WRITE lock（阻塞所有），`add`/`manageQueuedTasks`/`syncFromStorage` 取 READ lock（并发）。管理线程 `managerExec` 单线程（L143）保证 `manageQueuedTasks` 串行，task 完成回调用独立 `taskCompleteCallbackExecutor`（L158）不阻塞 `TaskRunner` 同步线程。`add` 写 `TaskStorage` 后入队，`manageQueuedTasks` 取就绪 task 交 `TaskRunner.run`。

### TaskRunner 三实现

`TaskRunner`（`overlord/TaskRunner.java`）接口多实现，经 `TaskRunnerFactory` + 配置 `druid.indexer.runner.type` 选择：

- **`HttpRemoteTaskRunner`**（`overlord/hrtr/HttpRemoteTaskRunner.java`，1980 行，模块最大文件）：37 默认，**摒弃 ZK、全 HTTP 通信**，经 `WorkerHolder`（L468）管理每 worker 连接，worker 主动上报状态。
- **`RemoteTaskRunner`**（`overlord/RemoteTaskRunner.java`）：ZK 事件驱动——worker 上下线经 `PathChildrenCache`（L237-327），task 状态由 worker 在 ZK status path 更新、RTR 监听，`runPendingTasks`（L747-768）多线程分配，`workersWithUnacknowledgedTask`（L878-889）保证一 worker 同时只有一个未确认 task。
- **`ForkingTaskRunner`**：本地 fork 进程执行，适合开发/单机。

37 选 HRTR 为默认是去 ZK 依赖、简化部署与可观测性。RTR 维护 `lazyWorkers`（空闲可终止）与 `blackListedWorkers`（黑名单）供 autoscaler 决策（`RemoteTaskRunner.java` L163-166）。

### Supervisor 生命周期

`overlord/supervisor/Supervisor.java` 接口 + `SupervisorManager` 管理流摄入 supervisor。`SeekableStreamSupervisor`（kafka/kinesis 基类）`start` 起定时调度循环，周期生成 `SeekableStreamIndexTask` 提交 `TaskQueue`，`checkpoint(taskGroupId, previousDataSourceMetadata)` 推进 offset。supervisor 自愈：task 失败重新生成，offset 由 task 的 `Committer` 快照保证 exactly-once（见摄入引擎模块）。`SupervisorSpec` 经 `@JsonSubTypes` 注册。

### TaskLockbox 时间锁

`overlord/TaskLockbox.java` + `GlobalTaskLockbox.java` 管理**时间区间锁**：摄入同 interval 的 task 须按序拿锁，保证 segment version 顺序、避免并发摄入覆盖。`LockRequest`/`LockResult`/`SpecificSegmentLockRequest`，`TaskLockboxSyncResult` 同步锁状态。流摄入 supervisor 经 `PendingSegmentAllocateAction` 分配 pending segment。

### autoscaling

`overlord/autoscaling/`：`ProvisioningStrategy`（`ProvisioningStrategy.java` L33）策略 + `AutoScaler`（`AutoScaler.java` L33，`@ExtensionPoint`）。`SimpleWorkerProvisioningStrategy`（L53-98）按空闲 worker 缩容，`PendingTaskBasedWorkerProvisioningStrategy`（520 行）按 pending task 积压精确扩容。EC2/GCE 在扩展模块实现。`CliOverlord.configureAutoscale`（L439-461）注册。RTR 的 `lazyWorkers`/`blackListedWorkers` 供决策。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `TaskRunner`/`TaskRunnerFactory` | 执行后端可换（HTTP/ZK/fork） |
| 单例/leader | `TaskMaster` | HA，防重复调度 |
| 观察者/生命周期 | `Supervisor`/`SupervisorManager` | 长流自愈 |
| 命令 | task + lock 请求 | 派发与锁可序列化 |
| SPI | `AutoScaler` | 云平台可插拔 |

## 模块间交互

依赖 `common/task`（`Task`）、`metadata`（`TaskStorage`）、`discovery`（发现 worker/MiddleManager）、`segment`/`timeline`（lock 发布、DataSegment）。与 `Coordinator` 协作（Coordinator 提交 compaction task 经 `OverlordClient`）。与摄入引擎（worker task 执行）是 master/worker 关系。

## 扩展方式

- **新增流摄入 supervisor**（仿 KafkaSupervisor）：建 `SupervisorSpec` 子类（`createSupervisor`）+ `Supervisor`（继承 `SeekableStreamSupervisor`，`start`/`checkpoint`）+ `SeekableStreamIndexTask` 子类 + `RecordSupplier`，注册 `@JsonSubTypes`/Guice。
- **新增 TaskRunner**：实现 `TaskRunner`（`run`/`start`/`stop`/`restore`/`shutdown`/`registerListener`）+ `TaskRunnerFactory`，在 `CliOverlord.runnerConfigModule`（L367-437）加 `addBinding("xxx")`，经 `druid.indexer.runner.type=xxx` 选择。
- **新增 Autoscaler**：实现 `AutoScaler<EnvConfig>`（`provision`/`terminate`/`ipToIdLookup`/`getMin/MaxNumWorkers`）+ 扩展 module 注册，可选实现 `ProvisioningStrategy` 在 `CliOverlord.configureAutoscale` 注册。
