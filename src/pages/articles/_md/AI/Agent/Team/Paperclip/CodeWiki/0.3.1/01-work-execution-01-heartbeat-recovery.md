---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Heartbeat & Recovery"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 心跳执行引擎——DB-backed 唤醒队列、原子 checkout、有界退避重试、孤儿进程恢复"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 工作执行引擎](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/01-work-execution)

---

## 模块定位

本模块属于工作执行引擎子系统。Heartbeat & Recovery 是 Paperclip 整个控制平面的编排枢纽——`heartbeatService()` 是 graphify 全图 degree 最高的 god node（172 条边），在 `heartbeat.ts` 单文件 12,338 行里实现了从唤醒入队到执行恢复的完整引擎。它独立存在，是因为"让 agent 跑起来"需要统一的队列消费者模型来治理并发唤醒的原子性、瞬态失败的有界退避、进程丢失的检测恢复——这些是一个内聚的问题域，不能散落在各 service 里。

## 模块架构

`heartbeatService(db, options)` 是一个工厂函数（`heartbeat.ts:3385`），返回 ~30 个方法的对象。工厂内部装配全部子服务并注入依赖：

```
heartbeatService(db, options)                    heartbeat.ts:3385
├─ issuesSvc = issueService(db)                 :3394   issue checkout/依赖
├─ budgets = budgetService(db, {cancelWorkForScope})  :3415  budget 硬停钩子
├─ recovery = recoveryService(db, {enqueueWakeup})     :3416  回调闭环
├─ productivityReviews = productivityReviewService(db, {enqueueWakeup})  :3417
├─ taskWatchdogs = taskWatchdogService(db, {enqueueWakeup})  :3418
├─ secretsSvc = secretService(db)               :3392   secret 注入
├─ companySkills = companySkillService(db)     :3393   运行时技能
├─ environmentsSvc + environmentRuntime + envOrchestrator  :3397-3401  环境租约
├─ executionWorkspacesSvc = executionWorkspaceService(db)  :3396  git worktree
├─ treeControlSvc = issueTreeControlService(db)  :3395  pause hold
└─ activeRunExecutions = new Set<string>()      :3406   内存活跃 run 追踪
```

工厂返回的方法群：入队（`enqueueWakeup`/`invoke`）、调度（`tickTimers`）、执行（`executeRun`）、取消（`cancelRun`/`cancelActiveForAgent`）、恢复（`reapOrphanedRuns`/`resumeQueuedRuns`/`reconcileStrandedAssignedIssues`/`reconcileIssueGraphLiveness`）、重试（`scheduleBoundedRetry`/`promoteDueScheduledRetries`）、查询（`list`/`getActiveRunForAgent`）。

## 调用链路

一次 heartbeat run 从触发到终态的核心调用链（行号见 `heartbeat.ts`）：

```
tickTimers(now)                        :12238  周期扫描到期 agent
  └─ enqueueWakeup(agentId, opts)      :10743  唤醒队列入口
       ├─ enrichWakeContextSnapshot    :10754  丰富上下文快照
       ├─ budgets.getInvocationBlock  :10868  budget 预检
       ├─ db.transaction               :10973
       │   ├─ SELECT ... FOR UPDATE (agent 行锁)
       │   ├─ coalescing 检查 (同 task scope 合并)
       │   └─ INSERT heartbeatRuns(status=queued)
       ├─ publishLiveEvent(run.queued) :11483
       └─ startNextQueuedRunForAgent   :11495
            └─ withAgentStartLock      :8195   per-agent 串行
                 └─ claimQueuedRun      :7247   原子 claim + 守卫链
                      ├─ getAgentInvokability    :7254
                      ├─ budgets.getInvocationBlock  :7263  budget 硬停
                      ├─ getHeartbeatDailyCapBlock  :7272
                      ├─ treeControlSvc.getActivePauseHoldGate  :7284
                      ├─ issuesSvc.listDependencyReadiness  :7315  blocker 检查
                      ├─ evaluateQueuedRunStaleness  :7324
                      └─ UPDATE heartbeatRuns SET status=running WHERE status=queued  :7336
                 └─ void executeRun(runId)  :8265  fire-and-forget
                      ├─ issuesSvc.checkout(issueId, agentId, run.id)  :8327
                      ├─ resolveWorkspaceForRun  :8722  → realizeExecutionWorkspace
                      ├─ resolveExecutionRunAdapterConfig  :8796  → secretsSvc 注入
                      ├─ envOrchestrator.acquireForRun  :9043  → 环境租约
                      ├─ getServerAdapter(agent.adapterType)  :9519
                      ├─ adapter.execute({...})  :9558  → Claude/Codex/Cursor
                      │    ├─ onLog → runLogStore.append + publishLiveEvent
                      │    └─ onAdapterMeta → appendRunEvent
                      └─ setRunStatus(terminal) → releaseIssueExecutionAndPromote  :10170
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `enqueueWakeup` (`:10743`) | 唤醒入队，创建 heartbeatRun | agent 行锁防并发竞争 |
| `startNextQueuedRunForAgent` (`:8195`) | 消费队列，按优先级 claim | withAgentStartLock 串行化 |
| `claimQueuedRun` (`:7247`) | 原子 claim + 守卫链 | CAS UPDATE 无应用锁 |
| `executeRun` (`:8273`) | 执行主流程 | fire-and-forget 不阻塞 |
| `setRunStatusIfRunning` (`:4936`) | 设置终态 | 原子条件更新 |
| `releaseIssueExecutionAndPromote` (`:10170`) | 释放 issue 锁 + 唤醒后续 | FOR UPDATE 防并发 finalize |
| `reapOrphanedRuns` (`:7940`) | 回收进程丢失的 running run | 一次性 retry |
| `scheduleBoundedRetry` (`:6382`) | 瞬态失败有界退避 | `[2m,10m,30m,2h]` 最多 4 次 |
| `tickTimers` (`:12238`) | 周期扫描到期 agent | setInterval 驱动 |

</details>

## 核心实现

### 原子 checkout 与 lazy locking

`claimQueuedRun`（`:7247`）用单条 `UPDATE heartbeatRuns SET status='running' WHERE id=? AND status='queued'` 实现 compare-and-swap——数据库行锁保证只有一个 run 能成功 claim，无需应用层锁。守卫链在 claim 前串联检查：agent invokability → budget `getInvocationBlock` → daily cap → pause hold gate → blocker 依赖 readiness → staleness。

`enqueueWakeup` 的注释明确 `"executionRunId is NOT stamped here"`（`:11469`）——`executionRunId`（issue 的执行锁）延迟到 `claimQueuedRun` 置 running 时才 stamp（`:7372-7391`）。**为什么**：queued run 可能被 coalesce 或 cancel，提前 stamp 会留下指向已废弃 run 的 execution lock，这是 issue deadlock 的根因。lazy locking 确保只有真正开始执行的 run 才持有 issue 锁。

### 持久化 agent state（跨 heartbeat session 复用）

`resolveSessionBeforeForWakeup`（`:10828`）+ `getTaskSession`（`:8453`）按 `(companyId, agentId, adapterType, taskKey)` 持久化 session 参数到 `agent_task_sessions` 表。新 run 从 `previousSessionParams` 恢复（`:8481`），让 agent 在多次 heartbeat 间保持对话上下文，不每次从零开始。`shouldResetTaskSessionForModelChange`（`:8458`）在 model 变更时强制 reset——不同 model 的 session 不兼容。

### 有界瞬态退避重试

瞬态失败（adapter_failed/timeout）走 `scheduled_retry` 状态。退避阶梯定义在 `BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS = [2m, 10m, 30m, 2h]`（`:249`），`scheduleBoundedRetryForRun`（`:6382`）用 `scheduled_retry` 状态 + `dueAt` 定时，由 `promoteDueScheduledRetries` 提升回 `queued`。**为什么有界**：最多 4 次（`:258`）防止无限循环；jitter ratio 0.25（`:255`）防惊群。`recovery/service.ts:213` 的 `classifyContinuationFailure` 按 errorCode 分类为 `non_retryable`/`transient_infra`/`default`，决定是否重试——budget_blocked 不可重试，adapter_failed 应重试。

### 进程丢失检测与恢复

`reapOrphanedRuns`（`:7940`）定期扫描所有 `status='running'` 但不在 `runningProcesses`/`activeRunExecutions` 中的 run。检查 `processPid`/`processGroupId` 是否存活，失败时 `setRunStatus('failed', errorCode='process_lost')`（`:8003`）并 `enqueueProcessLossRetry`（`:5886`）。**为什么**：服务器崩溃/重启后 in-memory process handle 丢失，DB 中仍为 running，必须恢复。retry 限制 1 次（`processLossRetryCount < 1`，`:8000`）。

### Coalescing 唤醒

`enqueueWakeup` 查找同 task scope 的 queued/scheduled_retry/running run（`:11505-11522`），找到则 `mergeContextSnapshot`（`:11530`）合并上下文快照，将 `agentWakeupRequests` 标记为 `coalesced`。**为什么**：避免对同一 issue 的密集唤醒产生多个排队 run，合并意图而非丢弃——多次 @mention 只跑一个 run 但上下文累积。

## 设计模式

| 模式 | 位置（文件:方法） | 为什么用 |
|------|------------------|----------|
| 工厂 + 闭包 | `heartbeatService(db)` (`:3385`) | 装配全部依赖，闭包共享 `db` 与 `activeRunExecutions` |
| 队列消费者 | `enqueueWakeup` → `startNextQueuedRunForAgent` | DB-backed 队列，无内存队列丢数据风险 |
| 策略 | `getServerAdapter(agent.adapterType)` (`:9519`) | adapterType 解耦 agent 与 runtime |
| 观察者 | `publishLiveEvent` (`:7348`) | run 状态变更经 SSE 推前端 |
| Guard chain | `claimQueuedRun` 守卫串联 (`:7247-7333`) | budget→pause→dependency→staleness 逐层拦截 |
| 钩子注入 | `budgetService(db, {cancelWorkForScope})` (`:3415`) | 解耦 budget 与 heartbeat |

## 模块间交互

Heartbeat 是中央枢纽，被上层 `index.ts:777` 创建并由 `setInterval`（`:854`）周期驱动 `tickTimers`/`reapOrphanedRuns`/`promoteDueScheduledRetries`。Routes 层（`routes/agents.ts`/`routes/issues.ts`）各自创建 `heartbeatService(db)` 实例调 `wakeup`/`cancelRun`。

它与全部子服务交互：内部装配时 `recoveryService(db, {enqueueWakeup})` 和 `productivityReviewService(db, {enqueueWakeup})` 注入 `enqueueWakeup` 形成**回调闭环**——recovery 需要 enqueueWakeup 来触发恢复 run，但 heartbeat 又需要 recovery 来分类失败，用钩子注入打破循环依赖。`budgetService` 注入 `cancelWorkForScope` 钩子同理——budget 触发停摆时回调 heartbeat 取消活跃 run，但 budget 不 import heartbeat。

## 扩展方式

**新增一种 wakeReason**：改 `enqueueWakeup`（`:10743`）的 `enrichWakeContextSnapshot` 处理新 reason；若影响 coalescing 判断，改 `shouldQueueFollowupForRunningIssueWake` 和 `isSameTaskScope`（`:11506`）；若 reason 是 retry 类，可能加到 `BOUNDED_TRANSIENT_HEARTBEAT_RETRY_*` 常量区（`:249-258`）。

**修改 retry 策略**：改 `BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS` 数组（`:249`）调退避阶梯；改 `MAX_ATTEMPTS`（`:258`）调次数；新增 transient error code 改 `recovery/service.ts:180` 的 `TRANSIENT_INFRA_CONTINUATION_ERROR_CODES` Set。
