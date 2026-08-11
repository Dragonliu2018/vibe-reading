---
source:
  type: "源码解读"
  project: "multica"
  url: "https://github.com/multica-ai/multica"
title: "Task API & Service"
date: "2026-08-11T20:31:27+08:00"
category: [AI, Agent, Team, Multica, CodeWiki, "0.3.28"]
tags: ["multica", "Go", "Task Queue", "FOR UPDATE SKIP LOCKED", "Lease"]
description: "handler + service 模块实现 issue→task 生命周期：enqueue→claim→start→complete/fail，含原子 claim、租约、负缓存与自动重试。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/00-overview)

---

## 模块定位

`server/internal/handler/` 是 HTTP API 层（Chi router，147 文件），`server/internal/service/` 是业务编排层。两者共同实现 Multica 的核心——issue→task 生命周期管理：把一个 issue 分配给 agent，入队（enqueue）→ 认领（claim）→ 开始（start）→ 完成/失败（complete/fail），加上 dispatch、lease、handoff、自动重试。

这个模块是整个系统的中枢——向上通过 events bus 驱动 Realtime 广播、通过 Wakeup 接口唤醒 Daemon，向下访问 DB。所有业务规则（claim 竞争、租约过期、重试分类、状态广播顺序）都沉淀在这里。

## 模块架构

分层架构：Handler（HTTP 解析、鉴权、响应组装）→ Service（事务编排、事件广播、metrics）→ db.Queries（sqlc 生成的 SQL）。Service 层 transport-agnostic——`IssueService.Create` 的注释明确说明"service deliberately does NOT depend on http.Request"，使 HTTP、Lark、MCP 等多入口共享同一业务逻辑。

核心 struct：

- `TaskService`（`task.go:28`）——持有 `Queries`、`TxStarter`、`Hub`、`Bus`、`Wakeup`（TaskWakeupNotifier）、`EmptyClaim`（负缓存）
- `IssueService`（`issue.go:26`）——创建 issue 后委托 TaskService 入队
- `AutopilotService`（`autopilot.go:29`）——持有 TaskService 引用，dispatch 时委托入队
- `Handler`（`handler.go:98`）——持有所有 service，注入路由

## 调用链路

Task 生命周期主链路（assign → enqueue → claim → start → complete/fail）：

```
IssueService.Create()                          [issue.go:159]
  ├─ 事务创建 issue → publishIssueCreated()
  └─ maybeEnqueueOnAssign()                    [issue.go:388]
       └─ TaskService.EnqueueTaskForIssue()    [task.go:435]
            ├─ Queries.CreateAgentTask()        # DB INSERT, status='queued'
            ├─ broadcastTaskEvent(EventTaskQueued)   # 先广播
            └─ NotifyTaskEnqueued()                  # 后唤醒 daemon
                 ├─ EmptyClaim.Bump()                # 失效负缓存
                 └─ Wakeup.NotifyTaskAvailable()     # WS 推送 task_available

[daemon HTTP claim]
Handler.ClaimTaskByRuntime()                   [handler/daemon.go:1227]
  └─ TaskService.ClaimTaskForRuntime()         [task.go:1040]
       ├─ ReclaimStaleDispatchedTask()          # 先恢复崩溃遗留
       ├─ EmptyClaim.IsEmpty()                  # Redis 负缓存快速路径
       ├─ ListQueuedClaimCandidatesByRuntime()  # DB SELECT 候选
       └─ ClaimTask(agentID)                    [task.go:965]
            ├─ CountRunningTasks()               # 检查 max_concurrent_tasks
            ├─ ClaimAgentTask()                  # FOR UPDATE SKIP LOCKED, queued→dispatched
            └─ broadcastTaskDispatch()

[daemon HTTP start/complete/fail]
Handler.StartTask → TaskService.StartTask()    [task.go:1171]
  └─ Queries.StartAgentTask() (dispatched→running) + broadcastTaskEvent(EventTaskRunning)

Handler.CompleteTask → TaskService.CompleteTask()  [task.go:1237]
  ├─ runInTx: CompleteAgentTask() + UpdateChatSessionSession()
  ├─ createAgentComment()           # 无评论时合成 fallback
  └─ broadcastTaskEvent(EventTaskCompleted)

Handler.FailTask → TaskService.FailTask()      [task.go:1420]
  ├─ taskfailure.Classify()          # 分类失败原因
  ├─ runInTx: FailAgentTask()
  ├─ MaybeRetryFailedTask()          # infra 类自动重试
  └─ broadcastTaskEvent(EventTaskFailed)
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计 |
|------|------|----------|----------|
| `EnqueueTaskForIssue` | `task.go:435` | issue 分配时入队 | 先广播再唤醒 |
| `ClaimTaskForRuntime` | `task.go:1040` | runtime 认领 task | 负缓存 + SKIP LOCKED |
| `ClaimTask` | `task.go:965` | 单 agent 原子 claim | per-(issue,agent) 序列化 |
| `StartTask` | `task.go:1171` | 转 running | 不改 issue 状态 |
| `CompleteTask` | `task.go:1237` | 完成 task | 事务原子 + fallback 评论 |
| `FailTask` | `task.go:1420` | 失败处理 | Classify + 自动重试 |
| `MaybeRetryFailedTask` | `task.go:1584` | 自动重试 | infra 类 + session 继承 |
| `RerunIssue` | `task.go:1664` | 手动重跑 | force_fresh_session |

</details>

## 核心实现

### ClaimAgentTask——FOR UPDATE SKIP LOCKED 原子认领

claim 的核心是一条 SQL（`pkg/db/queries/agent.sql:267`）：

```sql title="server/pkg/db/queries/agent.sql"
-- name: ClaimAgentTask :one
UPDATE agent_task_queue
SET status = 'dispatched',
    dispatched_at = now(),
    prepare_lease_expires_at = now() + make_interval(secs => @prepare_lease_secs)
WHERE id = (
    SELECT atq.id FROM agent_task_queue atq
    WHERE atq.agent_id = $1 AND atq.status = 'queued'
      AND NOT EXISTS (
          SELECT 1 FROM agent_task_queue active
          WHERE active.agent_id = atq.agent_id
            AND active.status IN ('dispatched', 'running', 'waiting_local_directory')
            AND (/* 同 issue / 同 chat_session / 同 quick-create 形状 */)
      )
    ORDER BY atq.priority DESC, atq.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

三层设计：(1) `FOR UPDATE SKIP LOCKED` 让多 daemon 并发 claim 不阻塞，公平竞争；(2) `NOT EXISTS` 子查询做 per-(issue, agent) 序列化——同一 agent 不重复跑同一 issue，但不同 agent 可并行跑同一 issue；(3) chat task 用 `chat_session_id` 序列化，quick-create task（所有 FK NULL）按"同 agent 的其他 quick-create"序列化。

候选列表查询 `ListQueuedClaimCandidatesByRuntime`（`agent.sql:619`）只查 `status='queued'`（不含 dispatched），由 partial index `idx_agent_task_queue_claim_candidates` 支撑——dispatched 行已被人持有，列入候选只会浪费每次 poll 的 SELECT。

### ClaimTaskForRuntime 三阶段顺序

`ClaimTaskForRuntime`（`task.go:1040`）的执行顺序：(1) `ReclaimStaleDispatchedTaskForRuntime` 先恢复崩溃遗留的 dispatched task（`claimResponseRecoveryWindow=90s` 窗口内无 `started_at` 的任务）；(2) `EmptyClaim.IsEmpty` 负缓存快速跳过空队列；(3) `ListQueuedClaimCandidatesByRuntime` DB SELECT 候选。

**为什么 stale reclaim 必须在 empty cache 检查之前**：一个 task 可能已 claim（dispatched）但 daemon 崩溃未 start。如果先查 empty cache，此时队列可能确实为空（那个 dispatched task 不在候选里），写入空判定。但那个 dispatched task 的 lease 很快过期需要被 reclaim——若 reclaim 在 empty cache 写入之后，runtime 会因负缓存跳过这次 reclaim 机会，等到 TTL 过期才重试。先 reclaim 确保崩溃遗留的任务优先恢复。

### 租约机制——prepare_lease + claim 恢复窗口

两层保护（`task.go:83-91` 常量）：

- `prepareLeaseDuration=45s`：claim→start 之间的准备阶段租约。daemon 需在租约内调 `StartTask`；超时则 `ReclaimStaleDispatchedTaskForRuntime`（`agent.sql`）回收。
- `claimResponseRecoveryWindow=90s`：claim 响应丢失时的恢复窗口（需 > daemon HTTP timeout 30s × 2 + 调度余量）。

`ReclaimStaleDispatchedTaskForRuntime` 恢复"claim 成功但响应未达 daemon"的任务——task 还在 `dispatched` 且无 `started_at`，刷新 `dispatched_at` 重新度量超时。`ExtendTaskPrepareLease` 在 daemon 准备工作目录（如大仓库 clone）期间续约。

### EmptyClaimCache——负缓存 + 版本化失效

`EmptyClaimCache`（`empty_claim_cache.go:71`）Redis 缓存"runtime 无可领取任务"的判定，带版本号。

**为什么需要**：解决"慢 claim SELECT 返回空 → enqueue 插入新任务 → 慢 claim 写入空判定"的竞态。如果无版本号，空判定会滞留到 TTL（`EmptyClaimCacheTTL`，3min）过期，task 被 stall。

**机制**（四方法协作）：`ClaimTaskForRuntime`（`task.go:1099`）在 DB SELECT **之前**先读 `preSelectVersion := s.EmptyClaim.CurrentVersion(ctx, runtimeKey)`；若 SELECT 返回空，`MarkEmpty(ctx, runtimeKey, preSelectVersion)` 写入空判定时带入观察到的版本号；后续 `IsEmpty()` 比对版本号——enqueue 时 `Bump()` 递增版本号，使旧版本标记的空判定被拒绝，关闭竞态窗口。`CurrentVersion` 必须在 SELECT 之前读取，因为 SELECT 期间可能有 enqueue 插入新任务并 Bump 版本——用 SELECT 前的版本标记空判定，保证"SELECT 时确实为空"这一事实被正确记录，而 enqueue 后的 Bump 会让该空判定立即失效。

### 事件总线同步广播——顺序保证

`enqueueIssueTask`（`task.go:497-504`）注释 "Order matters"：先 `broadcastTaskEvent(EventTaskQueued)` 再 `NotifyTaskEnqueued()`。所有 Enqueue* 路径（issue/chat/quick-create/retry）都遵循此顺序。

**为什么**：如果先唤醒 daemon，daemon claim 后发出 `EventTaskDispatch`，可能比 `EventTaskQueued` 先到达客户端，导致 UI 状态跳变（直接看到 dispatch 没看到 queued）。events.Bus 是**同步的**（`bus.go:61` Publish 按注册顺序同步调用 handler），所以广播先于唤醒执行，顺序确定。

### notifyTaskAvailable——Bump-before-Wakeup + background context

`notifyTaskAvailable`（`task.go:2101`）内部顺序：先 `s.EmptyClaim.Bump(context.Background(), runtimeKey)` 递增版本号失效负缓存，再 `s.Wakeup.NotifyTaskAvailable` 唤醒 daemon。

**为什么 Bump 必须在 Wakeup 之前**：否则 wakeup 驱动的 claim 可能读到仍生效的空判定返回 null，task 被 stall 到 TTL 过期。

**为什么用 `context.Background()` 而非请求 context**：缓存 Bump 和 daemon 唤醒必须比创建 task 的请求生命周期更长——客户端提前断开连接不应导致空判定滞留、刚入队的 task 被 stall。Redis 缓存本身对每次调用有短超时，wedged Redis 不会阻塞 enqueue。

### CompleteTask 事务原子性——resume pointer 与终态一致

`CompleteTask`（`task.go:1237`）用 `runInTx` 把 `CompleteAgentTask`（status→completed）和 `UpdateChatSessionSession`（保存 chat resume pointer）放在同一事务。**为什么**：如果不在同一事务，可能出现"task 标记 completed 但 chat session resume pointer 未更新"的中间态——下次该 chat 的 task 恢复时会用旧 session_id，丢失本次对话上下文。事务保证终态与 resume pointer 原子提交。`FailTask` 同样事务原子，但对 resume-unsafe 原因（见上文 `resumeUnsafeFailureReason`）不更新 resume pointer。

### 自动重试——失败分类 + session 继承

`MaybeRetryFailedTask`（`task.go:1584`）按失败原因分类决定是否重试。`retryableReasons`（`task.go:1556`）只含基础设施类原因：`runtime_offline`/`timeout`/`runtime_recovery`/`codex_semantic_inactivity`。`attempt < max_attempts` 时 `CreateRetryTask` 创建子任务**继承 session_id**（保持对话连续性）。

**两类任务被显式排除不在此处重试**：(1) `parent.AutopilotRunID.Valid`——autopilot 有自己的重试语义，不在此 double-trigger；(2) `!parent.IssueID.Valid && !parent.ChatSessionID.Valid`——quick-create 任务无 issue/chat 上下文，不重试。

**手动重跑 vs 自动重试的区别**：`RerunIssue`（`task.go:1664`）从 source task 继承 agent/squad/`TriggerCommentID`，但强制 `force_fresh_session=true`（跳过 session resume，从干净状态开始）；自动重试继承 session_id（恢复上次对话）。因为用户手动重跑 = 判定上次输出不好；自动重试 = 基础设施故障，应恢复状态。

**resume-unsafe 失败的 session 处理**：并非所有失败都安全 resume。`resumeUnsafeFailureReason`（`task.go:1563`）判定 `iteration_limit`/`agent_fallback_message`/`api_invalid_request`/`codex_semantic_inactivity` 四种原因为 resume-unsafe——`FailTask`（`task.go:1447`）对 chat task 在这些原因下**不更新** chat session resume pointer（避免下次恢复到一个坏掉的对话状态）。`CreateRetryTask` SQL（`agent.sql:188`）对 `codex_semantic_inactivity` 特殊处理：`CASE WHEN failure_reason = 'codex_semantic_inactivity' THEN NULL ELSE session_id END`——清空 session_id 和 work_dir 并设 `force_fresh_session=true`，因为 Codex 语义不活跃后的 session 状态不可信。

### Issue 状态与 Task 状态解耦

`StartTask`/`CompleteTask`/`FailTask` 注释均标注 "Issue status is NOT changed here — the agent manages it via the CLI"。task 的 start/complete/fail 不直接改 issue 状态——agent 通过 CLI（`multica issue status`）独立管理。仅在 `HandleFailedTasks`（`task.go:1808`）中当 issue 卡在 `in_progress` 且无活跃任务时才回滚到 `todo`。

**为什么**：agent 是 issue 的实际操作者，可能在 task 运行中多次切换 issue 状态。服务器不应假设 task 完成 = issue 完成。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 事件驱动 | `events.Bus` + `broadcastTaskEvent` | 解耦业务逻辑与 UI 推送，service 只管 Publish |
| 分层架构 | Handler → Service → db.Queries | transport-agnostic，多入口共享业务逻辑 |
| 租约 | `task.go:83-91` + `ClaimAgentTask` SQL | 防 daemon claim 后崩溃导致任务永久卡 dispatched |
| 负缓存 + 版本化失效 | `empty_claim_cache.go` | 解决慢 claim 与 enqueue 的竞态 |
| 监听器 | `TaskWakeupNotifier` + `RelayNotifier` | enqueue 后主动唤醒 daemon 降低轮询延迟 |
| 自动重试 + 分类 | `retryableReasons` + `taskfailure.Classify` | 区分基础设施抖动与业务错误 |

## 模块间交互

- **Handler → Service → DB**：分层调用，service 持有 `db.Queries` 执行 SQL
- **Service → events.Bus → Realtime**：`broadcastTaskEvent` Publish 事件，`listeners.go` SubscribeAll 转发 `BroadcastToWorkspace` 给前端 WS
- **Service → daemonws（Wakeup）**：`notifyTaskAvailable` 调 `Wakeup.NotifyTaskAvailable`，`RelayNotifier` 本地 hub + Redis relay 双通道
- **AutopilotService → TaskService**：`dispatchCreateIssue` 委托 `IssueService.Create`（创建 issue 后自动入队），`dispatchRunOnly` 委托 `EnqueueTaskForIssueWithHandoff`
- **Router 路由分组**：`/api/daemon/*`（daemon token 鉴权）含 claim/start/complete/fail/recover-orphans；`/api/issues/*`（用户鉴权）含 rerun/cancel

### Quick-create 任务——无 issue 的快速执行

除 issue task 和 chat task 外，还有 quick-create 路径（`EnqueueQuickCreateTask`，`task.go:625`）——没有 issue/chat/autopilot 关联的快速执行任务。上下文（prompt、requesterID、attachmentIDs 等）序列化为 `QuickCreateContext` struct 存储在 `agent_task_queue.context` JSONB 字段，类型标记 `QuickCreateContextType = "quick_create"`（`task.go:604`）。`parseQuickCreateContext`（`task.go:378`）解析该字段识别 quick-create 任务。claim 时 `ClaimTaskForRuntime` 对 quick-create 形状（所有 FK NULL）按"同 agent 的其他 quick-create"序列化，防止用户连点创建按钮触发并发竞态。

**与其他 Enqueue* 路径的区别**：`EnqueueQuickCreateTask` 只调 `NotifyTaskEnqueued`（唤醒 daemon claim），**不调 `broadcastTaskEvent`**——因为 quick-create 没有 issue_id/chat_session_id，无需向 workspace 广播 `task:queued` 事件（前端通过 quick-create 完成通知而非 task 事件感知）。但仍需唤醒 daemon，否则用户会感知"quick create 没触发"——modal 关闭后 task 卡在 queued 直到下次 30s poll。

## 扩展方式

新增一种 task 状态（如 `paused`）：DB migration 改 CHECK → `pkg/db/queries/` 加 `PauseAgentTask` 查询重新生成 sqlc → `service/task.go` 加 `PauseTask()` + `broadcastTaskEvent` → `handler/daemon.go` 加 handler → `router.go` daemon group 加路由 → `pkg/protocol/events.go` 加 `EventTaskPaused` 常量。

新增一种 retryable failure reason：`task.go:1556` `retryableReasons` map 加 reason → `pkg/taskfailure/` `Classify()` 映射新错误模式 → 若 resume-unsafe 还需更新 `resumeUnsafeFailureReason()`（`:1563`）。
