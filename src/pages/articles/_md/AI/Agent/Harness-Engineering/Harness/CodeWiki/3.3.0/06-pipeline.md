---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "CI 流水线引擎"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "Drone", "CI", "Docker", "流水线"]
description: "Harness CI 引擎：Drone 衍生，Pipeline→Execution→Stage→Step 四级模型，DB 轮询调度，embedded client 进程内调用 drone-runner-docker，双层取消"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/00-overview)

---

## 模块定位

CI 引擎是 Harness 的第二大产品面——把 YAML 写的流水线变成在 Docker 容器里执行的 step 序列。它的特殊性在于**不是从零写的**，而是 Drone 的衍生：Harness 收购 Drone 后，把 Drone 的 YAML 解析（drone-yaml）、执行 runtime（drone-runner-docker）、poller 框架（runner-go）直接复用，在外面包了一层 `embedded` client 把 Drone 原生的 server/agent HTTP 网络调用改成进程内直接调用，并加了 V1 YAML 格式、events/checks 集成、netrc 凭证等 Gitness 原生能力。它解决的核心问题是：CI 执行的可靠性与生态成熟度——复用 Drone 经过实战检验的执行 runtime，避免重写容器编排，同时融入 Harness 的统一认证与事件总线。

## 模块架构

```
app/pipeline/
  triggerer/    事件→execution 触发（解析 YAML → DAG → 建 stage）
  converter/    YAML 预处理（jsonnet/starlark 分派）
  scheduler/    stage 调度（queue.go DB 轮询 + canceler 内存 pubsub）
  runner/       执行器（嵌入 drone-runner-docker）
  manager/      ExecutionManager + embedded client（进程内桥接 Drone）
  canceler/     取消（execution 级 Killed）
  file/         pipeline 文件获取（从 git 读 yaml）
  resolver/     plugin/template 查找（注入 drone runner）
  commit/ checks/ logger/  git clone / status check / 日志
```

`triggerer`、`scheduler`、`runner`、`manager` 是四个核心角色，对应 CI 的"触发—调度—执行—桥接"四阶段。

## 调用链路

一次 push 触发 CI 的完整链路：

```
webhook 事件 → triggerer.Trigger(ctx, pipeline, hook) in triggerer/trigger.go:132
  ├─ fileService.Get() in file/service.go:37          从 git 取 YAML
  ├─ converterService.Convert() in converter/converter.go:46
  │     按扩展名分派：.drone.jsonnet→jsonnet / .drone.star→starlark / 其余透传
  ├─ isV1Yaml() in triggerer/trigger.go:504            判断 spec: 开头=V1 / 否则 Drone 遗
  ├─ [Drone 路径] yaml.ParseString → linter.Manifest → build DAG → skip.go 过滤
  ├─ [V1 路径]  parseV1Stages() in triggerer/trigger.go:401
  │     specresolver.Resolve 展开 plugin/template → script.ExpandConfig → 按序链接 stage
  ├─ createExecutionWithStages()  in triggerer/trigger.go:511   事务写 execution+stages
  └─ scheduler.Schedule(ctx, pendingStage) in scheduler/queue.go:30

scheduler.queue.signal()  → store.ListIncomplete → matchResource + 平台匹配 + Label
  └─ Request 返回 Stage 给等待的 worker（runner poller）

runner.NewExecutionPoller() in runner/poller.go:32  → poller.Poller 循环 client.Request
  └─ client.Request = embedded.Request in manager/client.go:39
        └─ manager.Request → scheduler.Request（进程内，无 HTTP）
  └─ runner.Run(stage)  执行（drone-runner-docker 容器内跑 step）
        ├─ Detail = manager.Details（取 repo/execution/stage/secrets/config/netrc）
        ├─ Update = BeforeStage/AfterStage
        └─ Batch = manager.Write → livelog.LogStream.Write（实时日志）
```

<details>
<summary>方法速查表</summary>

| 方法/类型 | 路径 | 职责 | 关键设计 |
|------|------|------|---------|
| `Triggerer.Trigger` | `triggerer/trigger.go:132` | 触发入口 | V1/Drone 双路径 |
| `dag.Dag` | `triggerer/dag/dag.go` | stage 依赖图 | DependsOn DAG |
| `queue.Schedule` | `scheduler/queue.go:30` | 调度 | DB 轮询 + `ready` channel |
| `queue.Request` | `scheduler/queue.go` | 分发 stage 给 worker | matchResource+Limit |
| `embedded` client | `manager/client.go:39` | Drone client 桥接 | 进程内调用，无 HTTP |
| `ExecutionManager` | `manager/manager.go:96` | runner↔server 抽象 | Request/Write/Watch |
| `canceler.Cancel` | `canceler/canceler.go:67` | execution 级取消 | SSE 广播 |
| `NewExecutionRunner` | `runner/runner.go:73` | 执行器 | 嵌 drone-runner-docker |

</details>

## 核心实现

### 四级执行模型与 DAG

数据结构层级 `Pipeline → Execution → Stage → Step`（定义在 `types/`）：`types.Pipeline`（配置实体，含 `ConfigPath`、`Seq`）；`types.Execution` in `types/execution.go:28`（一次触发一次执行，含 `Status`/`Event`/`Ref`/`After`/`Stages`）；`types.Stage` in `types/stage.go:19`（执行单元，含 `DependsOn` DAG 依赖、`OnSuccess`/`OnFailure` 条件执行、`Kind`/`Type` 默认 `pipeline`/`docker`、`Limit`/`LimitRepo` 并发限制、`Machine` 分配的 runner、`Steps`）；`types.Step` in `types/step.go:24`（最小执行单元，含 `Image`/`ExitCode`/`Schema`）。

分解逻辑在 `triggerer.Trigger()`：解析 YAML 后每个 `yaml.Pipeline` 生成一个 `types.Stage`，通过 `dag.Dag` in `triggerer/dag/dag.go` 管理 `DependsOn` 构成 DAG。无依赖的 Stage 状态 `Pending`，有依赖的 `WaitingOnDeps`。支持并行（DAG 无依赖关系的 Stage 同时调度）和串行（V1 YAML 路径 `parseV1Stages` 把 stage 按序号链接为链式依赖 in `triggerer/trigger.go:401`）。

### 调度器：DB 轮询队列

`Scheduler` 接口 in `scheduler/scheduler.go:38`（`Schedule`/`Request`/`Cancel`/`Cancelled`），实现为 `queue` + `canceler` 组合。`queue` in `scheduler/queue.go:30` 是基于数据库的轮询队列：`Schedule` 往 `ready` channel 发信号（非阻塞）；`Request` 注册一个 worker（含平台过滤条件 Kind/Type/OS/Arch/Labels）阻塞等待 channel 返回匹配的 Stage；`signal` 从 `store.ListIncomplete` 拉未完成 stage，按 `matchResource`（默认 `pipeline`/`docker`）+ 平台匹配 + Label 匹配筛选分发。

并发限制双层：`withinLimits()` in `queue.go:249` 按 `stage.Limit` 限制同名 stage 并发数；`shouldThrottle()` in `queue.go:272` 按 `stage.LimitRepo` 限制 repo 级并发。全局锁 `globMx`（`lock.MutexManager`，见 [基础设施层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/09-infra)）防止多实例竞争。

### Runner 与 embedded client 桥接

Runner 嵌入 `drone-runner-docker`：`NewExecutionRunner` in `runner/runner.go:73` 创建 `engine2.NewEnv`（Docker 环境）和 `runtime2.NewExecer`，配 `compiler2.CompilerImpl` 把 YAML 编译成可执行计划。`runtime2.Runner` 持 `LegacyRunner`（兼容旧 Drone YAML）和新引擎（V1）。`NewExecutionPoller` in `runner/poller.go:32` 创建 `poller.Poller` 循环 `client.Request` 拉取 stage，dispatch 给 `runner.Run`。

关键桥接是 `manager/client.go` 的 `embedded` 类型——实现 `drone/runner-go/client.Client` 接口，把 Drone runner 的 RPC 调用转发到 `ExecutionManager`：`Request` → `manager.Request` → `scheduler.Request`；`Detail` → `manager.Details`；`Update` → `BeforeStage`/`AfterStage`；`Batch` → `manager.Write` → `livelog.LogStream.Write`（实时日志流）。Step 在 Docker 容器执行（`engine2` 管理容器生命周期），`ParallelWorkers` 控制并行度。日志通过 `livelog.LogStream` 实时写，step 结束 `UploadLogs` 全量上传 in `manager.go:278`。

### 双层取消与 Drone 改造

两层取消：`canceler.Cancel` in `canceler/canceler.go:67` 把 execution 置 `Killed`，遍历 stage/step（已启动置 `Killed` exit code 130，未启动置 `Skipped`），通过 SSE 发 `SSETypeExecutionCanceled`；`scheduler/canceler` in `scheduler/canceler.go` 是内存级 pub/sub，`Cancel` 关闭 subscriber channel 通知正在 `Cancelled` 中阻塞的 runner，`Cancelled` 每分钟轮询 cancelled map，TTL 5 分钟防连接丢失。

与 Drone 的关系：**沿用** drone-yaml（`.drone.yml`）、drone-runner-docker、runner-go（poller/runtime/reporter）、drone-go 类型、drone/spec（V1 解析）。**Harness 改造**：`embedded` client 不走 HTTP 进程内调用消除网络开销；V1 YAML（`spec:` 开头）支持 `StageCI`、plugin/template 解析（`resolver/`）；converter 扩展 jsonnet/starlark；`manager.createNetrc` in `manager.go:385` 生成 JWT token 供容器内 git clone（内置认证）；`checks.Write` 把 execution 状态写 Gitness check 系统；`events.Reporter` in `manager/teardown.go:370` 执行完发事件供其他模块消费。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| DAG 调度 | `dag.Dag` + `DependsOn` | stage 并行/串行/条件执行 |
| 适配器（embedded） | `manager/client.go` | Drone runner 接口适配进程内调用 |
| 轮询队列 | `queue` + `ready` channel | DB-backed，多实例 + `globMx` 防竞争 |
| 双层取消 | execution 级 + scheduler 内存级 | 兼顾已完成与在途 stage |
| Provider/Resolver 注入 | `resolver.Manager` | plugin/template 可插拔 |

## 模块间交互

依赖 `store.ExecutionStore`/`StageStore`/`StepStore`（持久化）、`file.Service`（从 [git](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/05-git)取 YAML）、`converter.Service`（jsonnet/starlark）、`livelog.LogStream`（实时日志）+ `store.LogStore`（全量日志持久化）、`sse.Streamer`（前端推送）、`events.Reporter`（完成事件）、`publicaccess.Service`（repo 可见性）、`lock.MutexManager`（队列锁）、`resolver.Manager`（plugin/template）、`url.Provider`（clone URL/API 地址）。

## 扩展方式

**新增 step 执行后端（如 k8s）**：替换 `runner/runner.go` 中 `engine2.NewEnv`（Docker）为 k8s engine；在 `scheduler/queue.go:matchResource` 支持新 `Type`；runner poller 的 `Filter` 匹配新 Kind/Type。Drone 生态已有 `drone-runner-kube`，理论上可替换注入——但当前代码硬编码 Docker engine。

**新增 trigger 事件源**：扩展 `triggerer.Hook` 结构体和 `enum.TriggerAction`/`TriggerEvent`；在 `triggerer/skip.go` 增 `skipXxx` 过滤；在 `triggerer/trigger.go:Trigger` 的 switch-case 加匹配。上游 webhook handler 把事件转 `Hook` 调 `Trigger`。

**改 YAML 转换规则**：Drone 路径改 `converter/converter.go` 的 `Convert`（增扩展名分派）或对应 parser；V1 路径改 `triggerer/trigger.go:parseV1Stages` 的解析；stage 创建逻辑改 `Trigger` 中 `for i, match := range matched` 循环。
