---
source:
  type: "源码解读"
  project: "multica"
  url: "https://github.com/multica-ai/multica"
title: "Scheduler & Autopilot"
date: "2026-08-11T20:31:27+08:00"
category: [AI, Agent, Team, Multica, CodeWiki, "0.3.28"]
tags: ["multica", "Go", "Scheduler", "Distributed Lease", "Cron", "Autopilot"]
description: "scheduler 模块用 sys_cron_executions 表做 DB-backed 分布式定时——租约 + 审计 + crash recovery，驱动 Autopilot 自动创建 issue 派给 agent。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/00-overview)

---

## 模块定位

`server/internal/scheduler/` 是 DB-backed 分布式定时调度器，`server/internal/service/autopilot.go` 是 Autopilot 业务逻辑。Multica 的 Autopilot 功能——"定时给 agent 派活"——靠这两个模块协作：cron 触发/webhook/手动 → 自动创建 issue → 路由给 agent。scheduler 把 `sys_cron_executions` 表变成内部周期任务的分布式租约 + 审计日志，AutopilotService 负责创建 issue、入队 task、同步 run 状态。

这个模块独立存在因为**分布式定时需 DB 租约防重复执行**——多实例部署下内存 cron（`time.Ticker` + goroutine）无法防止重复执行。DB 表的 unique constraint 天然保证只有一个实例能 claim 一个 plan，同时充当审计日志。

## 模块架构

scheduler 是通用骨架，Autopilot 是其上的具体 job：

- **`Manager`**（`manager.go`）——调度管理器，持有 `pgxpool.Pool` + `jobs map[string]*JobSpec`，`Run(ctx)` 周期性 tick
- **`JobSpec`**（`spec.go`）——job 定义：`Name`/`Cadence`/`Scopes`/`Handler` + 租约/重试/追赶参数
- **`db_ops.go`**——lease 操作 SQL：`tryClaim`/`heartbeat`/`finishSuccess`/`finishFailure`/`markStaleAsFailed`
- **`jobs_autopilot.go`**——Autopilot 具体 job：`AutopilotScheduleDispatchJob` + `autopilotPlansForScope` + `autopilotHandler`
- **`AutopilotService`**（`service/autopilot.go`）——dispatch 业务：`DispatchAutopilotForPlan` + create_issue/run_only 两种模式 + 状态同步

## 调用链路

Autopilot 调度主链路（cron 触发 → lease → 创建 issue → 派给 agent → 审计）：

```
Manager.Run(sweepCtx)                           [manager.go:95]
  └─ Manager.RunOnce → runJob                    [manager.go:124]
       ├─ markStaleAsFailed()                    [db_ops.go:161]  # 清理过期 RUNNING lease
       └─ plansForTick → autopilotPlansForScope  [jobs_autopilot.go:227]
            └─ service.NextOccurrencesUTC(cron, tz, after, now)  # cron 算 plan_time
            └─ CatchUpLatestOnly: 只保留最近 occurrence
       └─ processPlan → tryClaim                 [db_ops.go:57]
            └─ INSERT ON CONFLICT DO NOTHING      # 分布式 lease
            └─ Manager.runClaimed                [manager.go:319]
                 ├─ runHeartbeats (goroutine)     # 续 lease
                 └─ autopilotHandler              [jobs_autopilot.go:312]
                      ├─ GetAutopilotTrigger / GetAutopilot  # 重载验证状态
                      └─ dispatcher.DispatchAutopilotForPlan [autopilot.go:97]
                           ├─ GetAutopilotRunByTriggerAndPlanned  # 幂等查找
                           │    ├─ [已 complete] → 直接返回
                           │    └─ [partial] → RecoverPartialAutopilotRun
                           └─ dispatchAutopilot  [autopilot.go:192]
                                ├─ shouldSkipDispatch           [autopilot.go:823]  # 准入检查
                                ├─ CreateAutopilotRun
                                ├─ [create_issue] dispatchCreateIssue  [autopilot.go:280]
                                │    ├─ resolveAutopilotLeader
                                │    ├─ tx: CreateIssueWithOrigin
                                │    ├─ Bus.Publish(EventIssueCreated)  # 触发 issue listener 入队
                                │    └─ TaskSvc.EnqueueTaskForIssue
                                └─ [run_only] dispatchRunOnly          [autopilot.go:528]
                                     ├─ CreateAutopilotTask
                                     └─ TaskSvc.NotifyTaskEnqueued     # 唤醒 daemon
```

事件监听器反向同步（issue/task 终态 → run 状态）：

```
registerAutopilotListeners (autopilot_listeners.go:15)
  ├─ bus.Subscribe(EventIssueUpdated) → SyncRunFromIssue      # issue done → run completed
  ├─ bus.Subscribe(EventTaskCompleted/Failed/Cancelled)
  │    ├─ SyncRunFromTask                                     # run_only task 终态 → run 同步
  │    └─ SyncRunFromLinkedIssueTask                          # create_issue task 失败 → run failed
  └─ publishRunDone → Bus.Publish(EventAutopilotRunDone)
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计 |
|------|------|----------|----------|
| `Manager.Run` | `manager.go:95` | 周期性 tick | 每 TickInterval(30s) |
| `runJob` | `manager.go:140` | 单 job 执行 | markStale + plans + processPlan |
| `tryClaim` | `db_ops.go:57` | 获取分布式 lease | INSERT ON CONFLICT + stale steal |
| `runHeartbeats` | `manager.go:435` | 续 lease | 后台 goroutine |
| `autopilotPlansForScope` | `jobs_autopilot.go:227` | cron 算 plan_time | CatchUpLatestOnly |
| `DispatchAutopilotForPlan` | `autopilot.go:97` | 幂等 dispatch | partial unique index |
| `shouldSkipDispatch` | `autopilot.go:823` | 准入检查 | runtime 离线则 skip |
| `dispatchCreateIssue` | `autopilot.go:280` | 创建 issue 入队 | 事务 + 事件链 |
| `SyncRunFromIssue` | `autopilot.go:596` | issue 终态同步 run | done→completed |

</details>

## 核心实现

### DB-backed cron——为什么不用内存 cron

`sys_cron_executions` 表的 unique constraint `uq_sys_cron_execution (job_name, scope_kind, scope_id, plan_time)` 天然保证只有一个实例能 claim 一个 plan。所有实例都 tick 同样的 jobs，loser 通过 `ON CONFLICT DO NOTHING` 静默 no-op。DB 表同时充当审计日志——每次执行的状态、耗时、错误码都留痕。

`dbNow`（`db_ops.go:30`）通过 `SELECT now()` 获取 Postgres 时间作为统一时钟，避免多实例时钟偏移。

### 分布式 lease + lease_token guard

`tryClaim`（`db_ops.go:57-156`）两阶段 claim：

1. **fresh claim**：`INSERT ON CONFLICT DO NOTHING`，成功则获得 lease
2. **stale steal**：冲突后尝试 `UPDATE ... WHERE status='RUNNING' AND stale_after < now`，偷取过期 lease

lease_token（UUID）作为乐观锁。claim 后生成 token，后续 heartbeat 和终态写入都用 `WHERE lease_token = $2` guard。如果 lease 被偷（生成新 token），原 runner 的终态写入 `RowsAffected=0` 返回 `ErrLeaseLost`——防止旧 runner 覆盖新 runner 的状态。

### Crash recovery via stale-lease sweep

`markStaleAsFailed`（`db_ops.go:161`）在每个 tick 开头扫描 `status='RUNNING' AND stale_after < now`：对 `AllowStaleReentry=false` 的 job 标记 FAILED；对 `AllowStaleReentry=true` 的 job（如 Autopilot）允许下次 tick 的 `tryClaim` steal 分支重新获取。

Autopilot 的 handler 是幂等的（见下条），所以重新执行不会产生重复 issue/task。

### Occurrence 级幂等——plan_time + partial unique index

两层幂等保证：

1. `sys_cron_executions` 的 unique key 保证一个 (job, scope, plan_time) 只被一个 runner claim
2. `autopilot_run` 表的 partial unique index `uq_autopilot_run_trigger_planned (trigger_id, planned_at)` 保证一个 cron occurrence 只产生一个 run

`DispatchAutopilotForPlan`（`autopilot.go:97`）先查已有 run——complete（有 issue_id 或 task_id）直接返回不重复创建；partial（crash 后只写了 run 行没建下游）则标记 FAILED 并释放 slot 重新 dispatch。这解决了"claim+crash 后重试可能丢失 occurrence"的 bug。

### PlansForScope hook——non-uniform cron schedule

标准 scheduler 用 `Cadence` 做 uniform grid（如每 5 分钟一个 plan_time）。但 Autopilot 每个 trigger 有自己的 cron 表达式（如 `0 9 * * 1-5`），plan_times 不形成 uniform grid。

`JobSpec.PlansForScope` hook（`spec.go:187`）让 job 完全控制 plan_time 枚举，同时复用 scheduler 的 lease/heartbeat/retry/audit 基础设施。`autopilotPlansForScope`（`jobs_autopilot.go:227`）接收 `LatestPlanInfo` 以决定从哪里恢复枚举——处理 retry-eligible 的 FAILED 行需返回相同 plan_time 的边界情况。

### 准入门控——shouldSkipDispatch

`shouldSkipDispatch`（`autopilot.go:823`）：如果 assignee agent 的 runtime 离线，直接跳过而非入队 doomed task。记录 `skipped` run 而非 `failed`——这样 failure monitor 不会因 offline agent 导致的 skip 而误 pause autopilot。区分 hard-skip（agent 删除/squad archived，重试无意义）和 fail-open（DB 瞬时错误，下次 tick 再试）。

### Failure monitor——自动暂停失控 autopilot

`runAutopilotFailureMonitor`（`autopilot_failure_monitor.go:71`）是独立 goroutine（`main.go:373` 启动）。以 24 小时间隔扫描，对 lookback 7 天内 `MinRuns >= 50` 且 `FailRatio >= 0.9` 的 autopilot 自动 `SystemPauseAutopilot`，通过 inbox_item 通知 creator（或 agent owner）。

**为什么**：MUL-1336 案例——一个每 5 分钟触发的 autopilot 7 天内跑了 1475 次全部失败，仍在持续触发。阈值可通过 env 调整（`AUTOPILOT_FAIL_MONITOR_MIN_RUNS` 等），设为 0 可禁用。

### Handler panic recovery

`runClaimed` 中的 `defer func() { if r := recover()... }`（`manager.go:359`）将 panic 转为 `ErrHandlerPanic` error，走正常 failure 路径写 FAILED 审计行 + 触发 retry。**为什么**：没有 recover 时 panic 被静默吞掉且外层写入 SUCCESS（rows_affected=0）审计行——完全失真。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 租约 | `tryClaim` in `db_ops.go:57` + `heartbeat` | 分布式防重复执行，lease_token 乐观锁 |
| 策略 | `CatchUpMode` enum + `PlansForScope` hook | 追赶策略可替换，non-uniform cron |
| 模板方法 | `dispatchAutopilot` in `autopilot.go:192` | 调度骨架 + create_issue/run_only 分支 |
| 观察者 | `registerAutopilotListeners` | 被动同步 run 状态，解耦 |
| 心跳保活 | `runHeartbeats` in `manager.go:435` | 防 long-running handler 被误判 stale |
| 重试退避 | `retryDelay` in `spec.go:239` | FAILED 后 `next_retry_at` + `MaxAttempts` 封顶 |

## 模块间交互

- **scheduler → AutopilotService**：通过 `AutopilotScheduleDispatcher` interface（`jobs_autopilot.go:37`）调用，narrow contract 只依赖 `DispatchAutopilotForPlan` 一个方法——scheduler 包测试不需拉入整个 service 层
- **AutopilotService → TaskService/IssueService**：`dispatchCreateIssue` 委托 `IssueService.Create`（创建 issue 后自动入队），`dispatchRunOnly` 委托 `TaskService.NotifyTaskEnqueued`
- **AutopilotService → events bus**：dispatch 后 `Bus.Publish(EventIssueCreated/EventAutopilotRunStart/EventAutopilotRunDone)`；反向通过 `registerAutopilotListeners` 订阅 issue/task 终态事件同步 run
- **failure monitor → DB/inbox**：直接查 `SelectAutopilotsExceedingFailureThreshold`，对超阈值调 `SystemPauseAutopilot` + `CreateInboxItem`，不触碰 `sys_cron_executions`

## 扩展方式

新增一个定时 job（如每小时清理过期 session）：新建 `server/internal/scheduler/jobs_session_cleanup.go` 定义 `SessionCleanupJob(pool) JobSpec`（参照 `jobs_task_usage.go:36`）→ `main.go:417` 附近加 `schedulerMgr.Register(...)`。不需改 `manager.go`/`spec.go`/`db_ops.go`——框架是通用骨架。

新增 autopilot 触发方式（如 issue 状态变更触发）：若需幂等调度，`autopilot_trigger` 表加 kind + `autopilotScopes` 查询包含新 kind + `autopilotPlansForScope` 扩展；若是事件驱动，`autopilot_listeners.go:15` 加 `bus.Subscribe` 回调调 `DispatchAutopilot`。
