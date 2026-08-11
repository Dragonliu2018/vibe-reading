---
source:
  type: "源码解读"
  project: "multica"
  url: "https://github.com/multica-ai/multica"
title: "Daemon 执行引擎"
date: "2026-08-11T20:31:27+08:00"
category: [AI, Agent, Team, Multica, CodeWiki, "0.3.28"]
tags: ["multica", "Go", "Daemon", "WebSocket", "exec", "worktree"]
description: "internal/daemon 是跑在用户机器上的执行守护进程——轮询/唤醒领取 task、调用 CLI 子进程、流式上报进度，含 worktree 缓存与心跳。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/00-overview)

---

## 模块定位

`server/internal/daemon/` 是运行在用户机器上的本地代理守护进程，`server/internal/daemonws/` 是部署在 API server 侧的 WebSocket hub。两者协作：daemon 通过 WebSocket 连到 daemonws hub 接收 task 唤醒信号，通过 HTTP claim/start/complete 任务，调用 `pkg/agent` 执行编码 CLI，流式上报进度。

这个模块独立存在因为**执行逻辑跑在用户机器上**，与 Server 分离——Server 不直接执行 agent、不调 LLM。Daemon 负责：探测已安装的 CLI、管理隔离工作目录、流式 drain agent 输出、session 恢复、心跳保活、自动更新。它是 Multica"计算与编排分离"架构的执行端。

## 模块架构

Daemon 是一个多 goroutine 引擎，核心结构 `Daemon`（`daemon.go:149`）持有配置、HTTP client、仓库缓存、skill 缓存，管理多个 workspace 的状态。内部组件：

- **pollLoop**（`daemon.go:2382`）——主循环，每 runtime 一个 poller goroutine
- **heartbeatLoop**（`daemon.go:1793`）——每 runtime 一个心跳 goroutine（WS + HTTP 双通道）
- **taskWakeupLoop**（`wakeup.go:25`）——WebSocket 客户端，接收 task 唤醒
- **execenv**——隔离执行环境（工作目录、provider 配置注入）
- **repocache**——bare clone 仓库缓存 + worktree 创建
- **gcLoop**——过期执行环境清理

server 侧的 `daemonws.Hub`（`hub.go:139`）管理 daemon 连接，按 `byRuntime`/`byWorkspace` 索引，`RelayNotifier`（`notifier.go:14`）实现本地 hub + Redis relay 双通道广播。

## 调用链路

从 daemon 启动到 task 执行完成的完整链路：

```
Daemon.Run()                                    [daemon.go:713]
  ├─ listenHealth() / serveHealth()             # /health, /shutdown, /repo/checkout
  ├─ preflightAuth()                            # PAT 续期 + workspace 同步 + runtime 注册
  ├─ workspaceSyncLoop()                        # 后台发现新 workspace
  ├─ taskWakeupLoop()                           # WebSocket 客户端接收唤醒
  ├─ heartbeatLoop()                            # 每 runtime 一个 HTTP 心跳 goroutine
  ├─ gcLoop() / autoUpdateLoop() / tokenRenewalLoop()
  └─ pollLoop(ctx, taskWakeups)                 [daemon.go:2382]  # 主循环
       └─ runRuntimePoller(pollerCtx, rid, sem, wakeup)  [daemon.go:2498]
            ├─ waitForTaskSlot(sem)             # 先获取执行槽再 claim
            ├─ tryEnterClaim()                  # 检查 auto-update 屏障
            ├─ client.ClaimTask(runtimeID)      # HTTP POST /api/daemon/runtimes/{id}/tasks/claim
            └─ go handleTask(parentCtx, task, slot)  [daemon.go:2711]
                 ├─ acquireLocalDirectoryLockIfNeeded()  # local_directory 路径互斥
                 ├─ watchTaskCancellation()     # 轮询 server-side 取消信号
                 └─ runner.run() → d.runTask()  [daemon.go:3255]
                      ├─ execenv.Prepare()/Reuse()       # 创建隔离执行环境
                      ├─ client.StartTask(taskID)        # 状态 dispatched→running
                      ├─ agent.New(provider, config)     # 创建 agent backend
                      ├─ executeAndDrain()               # 执行+流式 drain
                      │    ├─ backend.Execute(ctx, prompt, opts)  # 启动 CLI 子进程
                      │    ├─ runIdleWatchdog()          # 空闲看门狗
                      │    └─ drain loop: ReportProgress / ReportTaskMessages
                      └─ reportTaskResult()              # Complete/Fail 回调 server
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计 |
|------|------|----------|----------|
| `Daemon.Run` | `daemon.go:713` | 启动所有循环 | 多 goroutine fan-out |
| `pollLoop` | `daemon.go:2382` | 主循环分发 poller | per-runtime goroutine |
| `runRuntimePoller` | `daemon.go:2498` | 单 runtime claim+dispatch | slot-before-claim |
| `handleTask` | `daemon.go:2711` | 执行单个 task | cancellation watch |
| `runTask` | `daemon.go:3255` | 准备环境+执行+drain | execenv + agent |
| `executeAndDrain` | `daemon.go:3919` | 启动 CLI + drain 消息 | idle watchdog |
| `handleRuntimeGone` | `daemon.go:330` | runtime 被删后恢复 | 三重 gate 防惊群 |

</details>

## 核心实现

### pollLoop 与 per-runtime poller——避免跨 workspace 阻塞

`pollLoop`（`daemon.go:2382`）采用 `sync()` 模式：对比 `want` runtime 集合与当前 pollers map，增量启停 per-runtime goroutine。每个 runtime 一个独立的 `runRuntimePoller` goroutine。

**为什么不用 round-robin 单循环**：旧设计中一个 runtime 的慢 `ClaimTask`（30s HTTP timeout）会阻塞所有其他 runtime 的 claim。改为 per-runtime 独立 goroutine + 独立 wakeup channel 后互不影响。`runtimePollOffset`（`daemon.go:2596`）用 FNV hash 分散初始 poll 时间避免同步风暴。

### Slot-before-claim——先获取执行槽再认领

`runRuntimePoller`（`daemon.go:2498`）先 `waitForTaskSlot(sem)` 获取并发槽位（受 `max_concurrent_tasks` 限制），再 `ClaimTask`。

**为什么**：如果先 claim 再等 slot，task 进入 server-side `dispatched` 状态但没有对应 `StartTask`，server 的 sweeper 会在 `dispatchTimeoutSeconds=300s` 后标记 `failed/timeout`。先获取 slot 确保拿到 task 后能立即开始执行。代价是慢 claim 会占一个 slot，但远低于 300s dispatch timeout。

### WebSocket + HTTP 双通道心跳

`wakeup.go:187`（WS heartbeat sender）+ `daemon.go:1868`（HTTP heartbeat tick）。WS heartbeat 减少 HTTP DB 写入（server 收到 WS heartbeat 同样更新 `last_seen_at`），但 WS 断连时 HTTP 兜底。

`wsHeartbeatFreshness()`（`daemon.go:671`）设为 `2× HeartbeatInterval`——丢一个 WS ack 仍保持 HTTP 抑制，连丢两个（~30s）恢复 HTTP，远在 server 45s offline 阈值内。

### Task-scoped auth token——代理凭证隔离

`taskScopedAuthToken()`（`daemon.go:57`）+ `runTask` 注入 `MULTICA_TOKEN`（`daemon.go:3500`）。Server 在 claim 时 mint task-scoped `mat_` token，daemon 注入给 agent 子进程。

**为什么**：agent 永远看不到 daemon 自己的 workspace-owner credential，防止 agent 写入被误归因到 runtime owner。空/非 task-scoped token 是 fatal 错误。

### execenv 隔离执行环境

`execenv.Environment`（`execenv.go:130`）为每个 task 创建隔离环境：

- `RootDir` = `{workspacesRoot}/{workspaceID}/{shortTaskID}/`
- `WorkDir` = `RootDir/workdir/` 或 `local_directory` 用户路径
- per-provider 配置：`CodexHome`（codex）、`CursorDataDir`（cursor）、`OpenclawConfigPath`（openclaw）
- `writeContextFiles()`（`context.go:37`）写入 `.agent_context/`、skills、project resources
- `InjectRuntimeConfig()` 向 workdir 注入 `CLAUDE.md`/`AGENTS.md`

### repocache——bare clone + worktree + per-repo 锁

`repocache.Cache`（`cache.go:68`）维护 bare clone 缓存（`~/multica_workspaces/.repos`），`CreateWorktree()` 从 bare clone 创建 worktree。`repoLocks`（`sync.Map`）为每个 bare repo 分配独立 `sync.Mutex`。

**为什么**：git 自身的 lockfile（`packed-refs.lock`、`config.lock`）不容忍同一 bare repo 上的并行变更。per-repo 独立锁让不同 repo 完全并行。bare clone 用 remote-tracking refspec（`refs/remotes/origin/*`）而非 mirror refspec，避免 fetch 与 worktree-locked `refs/heads/*` 冲突。

### Runtime gone 合并恢复——三重 gate 防惊群

`handleRuntimeGone`（`daemon.go:330`）在 server 删除 runtime row 时触发。heartbeat、poller、WS-ack 三个路径可能毫秒级内各自检测到，三重 gate 确保只触发一次 `registerRuntimesForWorkspace`：

- `runtimeGoneInflight`——per-runtimeID 去重
- `reregisterNextAttempt`——per-workspace 合并窗口（30s）
- `reregisterLastCompletedAt`——同波 straggler 检测

恢复调用使用 `recoveryContext()`（daemon root ctx），因为 per-runtime ctx 会在 `notifyRuntimeSetChanged` 后被取消。

### Auto-update claim barrier——升级不中断 task

`claimMu`/`pauseClaims`/`claimsInFlight`（`daemon.go:203-206`）+ `tryEnterClaim()`/`trySetClaimBarrier()`（`daemon.go:2294`）。自动升级需重启进程但不能中断执行中的 task。`trySetClaimBarrier` 等待所有 in-flight claim 和 active task 完成后才升级；`runRuntimePoller` 在 `pauseClaims=true` 时跳过 `ClaimTask`。

### Idle watchdog with tool-flight awareness

`executeAndDrain`（`daemon.go:3919`）启动 `runIdleWatchdog`（`daemon.go:3975`）监控 `lastActivityAt` 原子变量。`DefaultAgentTimeout=0`（无墙钟上限）时，agent 可能因 stuck child process 永远 hang。idle watchdog（`DefaultAgentIdleWatchdog=30min`）在无消息超阈值时 force-stop。

但 tool 执行（如 `npm install`）合法地长时间无消息，所以 `inFlightTools` 计数器在 tool 在途时切换到更大的 `AgentToolWatchdog`（2h）预算。

### 稳定 daemon 身份——machine-scoped UUID

`identity.go:39` `EnsureDaemonID` 用 `~/.multica/daemon.id` 存储持久 UUID（UUIDv7）。**为什么**：旧设计用 hostname，hostname 变化（`.local` 后缀漂移、系统重命名）会 mint 新身份导致 runtime row 碎片。`LegacyDaemonIDs()` 枚举历史身份，server 在 register 时合并旧 row。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Pub/Sub | `runtimeSetWatcher`（`daemon.go:631`） | runtime 集合变化通知 heartbeat/poll/wakeup 三消费者同步增减 goroutine |
| 策略 | `taskRunner` interface（`daemon.go:71`） | 抽象 task 执行，测试注入 fake 无需真实 CLI |
| 依赖注入 | 包级变量 `detectAgentVersion` 等（`daemon.go:82-112`） | 测试可替换外部调用 |
| Fan-out/Fan-in | `pollLoop` + `heartbeatLoop` 的 `sync()` 模式 | 增量启停 per-runtime goroutine |
| 引用计数 | `activeEnvRoots`（`daemon.go:208`） | GC 保护执行环境目录 |
| 重试退避 | `postJSONWithRetry`（`client.go:591`） | terminal callback 有界指数退避 `[4s,8s,16s,32s,64s]` |
| 事件去重 | `daemonws client.markSeen`（`hub.go:101`） | ring buffer 128 防止 Redis relay 多节点重复投递 |

## 模块间交互

- **daemon → pkg/agent**：`agent.New(provider, config)` 创建 backend、`backend.Execute` 启动子进程、`agent.DetectVersion`/`ListModels` 注册时探测
- **daemon → execenv/repocache**：`execenv.Prepare`/`Reuse` 创建环境、`repocache.Cache.Sync`/`CreateWorktree` 管理 git
- **daemonws ↔ daemon**：`daemon/wakeup.go` 是 WS 客户端连到 `/api/daemon/ws`；`daemonws/hub.go` 是 server 侧 hub；`daemonws/notifier.go` 通过 `realtime.Relay` 多节点广播
- **daemonws → realtime**：`RelayNotifier` import `realtime`，Redis 配置时 `relay.PublishWithID` 发布唤醒，其他节点 `DeliverDaemonRuntime` 接收

## 扩展方式

新增一种执行环境（如 Docker sandbox）：

1. `execenv/execenv.go`——新增 `prepareDockerSandbox()`，在 `Prepare()`（`:179`）按 provider 分支调用；扩展 `Environment` struct 加 `DockerContainerID`
2. `execenv/context.go`——`writeContextFiles()`（`:37`）为新 provider 加 skill 目录解析
3. `daemon/daemon.go`——`runTask()`（`:3255`）构造 `PrepareParams` 传新 provider 参数；`agentEnv` map（`:3505`）注入 env var
4. `daemon/config.go`——`Config` struct 加新 provider 配置项

修改 task 领取策略（如优先级队列）：`daemon/client.go` `ClaimTask()`（`:157`）传优先级参数 → `daemon.go` `runRuntimePoller()` 调整 claim 决策 → `wakeup.go` 解析 wakeup 中的优先级。
