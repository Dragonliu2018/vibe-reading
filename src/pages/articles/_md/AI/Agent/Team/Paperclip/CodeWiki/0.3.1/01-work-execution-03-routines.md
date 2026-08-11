---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Routines & Schedules"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 周期任务系统——cron/webhook/API 触发、并发策略、catch-up 与 revision 快照"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 工作执行引擎](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/01-work-execution)

---

## 模块定位

本模块属于工作执行引擎子系统。Routines & Schedules 是 Paperclip 的周期性任务触发源——支持 cron/webhook/API 触发，并发与 catch-up 策略。`routineService()` 是 graphify god node（35 边）。它独立存在，是因为周期触发需要独立的调度器（CAS claim 防多实例重复）与并发语义（skip_if_active/coalesce/always_enqueue），而每次触发创建的 tracked issue 复用主 issue 系统的 inbox/状态机/heartbeat——统一可观测。

## 模块架构

`routineService(db, deps)`（`routines.ts:533`）工厂返回对象（`:1661`）：CRUD（get/list/getDetail/create/update）、trigger 管理（createTrigger/updateTrigger/deleteTrigger）、revision（restoreRevision）、执行（runRoutine/firePublicTrigger/tickScheduledTriggers/listRuns/syncRunStatusForIssue）。

routine 核心数据结构：trigger `kind` ∈ `schedule|webhook`；schedule 字段 `cronExpression+timezone+nextRunAt`；webhook 字段 `publicId+secretId+signingMode(none|github_hmac|bearer|timestamp)+replayWindowSec`；`assigneeAgentId`；`concurrencyPolicy` ∈ `always_enqueue|skip_if_active|coalesce`（`:1493-1558`）；`catchUpPolicy`（已实现 `enqueue_missed_with_cap`，`:2635`）。

## 调用链路

调度执行链：

```
index.ts:854  setInterval → routines.tickScheduledTriggers(now)   routines.ts:2601
  ├─ 扫描 due 的 schedule trigger
  ├─ CAS claim: WHERE nextRunAt=原值 条件 update 抢占          :2645
  └─ dispatchRoutineRun({source:"schedule"})                     :2673
       ↓ routines.ts:1373
  1. 解析 variables、插值 title、算 dispatchFingerprint(sha256)  :1428
  2. 事务内 SELECT ... FOR UPDATE 锁 routine                      :1443
  3. 插 routineRuns 一行(status=received)                         :1467
  4. findLiveExecutionIssue 查活跃 issue                           :1489
     ├─ 存在且 policy≠always_enqueue → skipped/coalesced finalize :1494-1517
     └─ 否则 issueSvc.create(originKind="routine_execution")      :1521
  5. queueIssueAssignmentWakeup({heartbeat, issue, reason})      :1585
  6. finalize run 为 issue_created                                  :1594
```

webhook 路径：`firePublicTrigger`（`:2438`）校验签名 → `dispatchRoutineRun({source:"webhook"})`（`:2515`）。手动/API：`runRoutine`（`:2411`）。

## 核心实现

### 每次执行创建 tracked issue

`dispatchRoutineRun`（`:1521`）调 `issueSvc.create` 建 tracked issue（`originKind="routine_execution"`，`originRunId=createdRun.id`），让 routine 执行与正常 agent issue 共用 inbox/状态机/heartbeat。受 `issues_open_routine_execution_uq`（`:1548`）唯一约束保护，防止同一 fingerprint 重复开 issue。**为什么**：统一可观测与生命周期管理，routine run 不需要独立的执行路径。

### 并发策略三选一

`concurrencyPolicy`（`:1493-1558`）：`always_enqueue` 总是新建；`skip_if_active` 命中活跃 issue 直接 `skipped`；`coalesce` 并入活跃 issue 并记 `coalescedIntoRunId`。**为什么**：同一 routine 不可重入时让调用方显式选择语义，而非隐式行为。

### catch-up 策略

默认不补跑（`:2626-2643`）——project paused 或非 `enqueue_missed_with_cap` 时只把 `nextRunAt` 推到下一个 cron 边界（"no backfill" 注释 `:2627`）；`enqueue_missed_with_cap` 时从 `nextRunAt` 起逐 tick 累加，上限 `MAX_CATCH_UP_RUNS = 25`（`:71`）。**为什么**：兼顾"不丢 tick"与"不爆队列"。project paused 时触发被 claim 但记 `skipped_paused`（`:2630`），恢复后从下个边界继续，不回放。

### Revision 快照与幂等

`appendRoutineRevision`（`:782`）+ `buildRoutineRevisionSnapshot`（`:458`）把 routine+triggers 序列化为 JSON 快照，支持 `restoreRevision`。`createRoutineDispatchFingerprint`（`:389`，sha256 over payload+agent+revisionId+env+workspace）配合 `idempotencyKey`（`:1446`）与唯一约束做去重。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 工厂 + 闭包 | `routineService(db, deps)` (`:533`) | issueSvc/secretsSvc/heartbeat 为闭包依赖 |
| 策略 | `concurrencyPolicy`/`catchUpPolicy` | 字段切换行为 |
| Revision 快照 | `appendRoutineRevision` (`:782`) | 可回滚的配置审计 |
| CAS claim | `tickScheduledTriggers` (`:2601`) | 防多实例重复 dispatch |

## 模块间交互

调 `issueService(db)`：`issueSvc.create` 建 tracked issue（`:1521`）、`issueSvc.getById` 取 parentIssue（`:1713`）。调 `heartbeatService`：经 `queueIssueAssignmentWakeup`（`:1585`，来自 `issue-assignment-wakeup.js`）入队唤醒指派 agent。调 `secretService`：webhook secret 创建/轮换（`:2001`）。被 `routes/routines.ts` + `services/plugin-managed-routines.ts`（`:129`）包一层做 plugin-managed routine。被 `index.ts:778` 实例化、`:866` `setInterval` 驱动调度。

## 扩展方式

**新增触发类型（如 `event`）**：`dispatchRoutineRun` 的 `source` 联合类型扩 `event`（`:1376`）；`createTrigger`（`:2013`）加 `kind==="event"` 分支；若需调度器驱动，`tickScheduledTriggers`（`:2601`）查询条件加该 kind 并实现 due 判定；`RoutineRevisionSnapshotV1["triggers"][number]["kind"]` 类型扩展。

**修改 catch-up 策略**：改 `MAX_CATCH_UP_RUNS`（`:71`）或 `tickScheduledTriggers` 的 while 循环（`:2636-2642`）；若新增 policy 值，扩 `catchUpPolicy` 字段类型与 `buildRoutineRevisionSnapshot`（`:438`）。
