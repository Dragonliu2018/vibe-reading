---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Budget & Governance"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 预算与治理——cost 追踪、预算硬停、审批门 enforcement、生产力 review 软停"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 组织与治理](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/02-organization-governance)

---

## 模块定位

本模块属于组织与治理子系统。Budget & Governance 回答"限额"——token/cost 按 company/agent/project 维度追踪，scoped budget 策略含 warning 阈值与硬停，超支自动 pause agent 并取消排队 work；审批工作流含 review/approval 阶段门。`budgetService()` 是 graphify god node（24 边）。它独立存在，是因为防 runaway spend 与审批 enforcement 是治理的硬约束——budget 管 cost，governance 管 progress，两者互补。

## 模块架构

`budgetService(db, hooks)`（`budgets.ts:496`）工厂返回：`listPolicies`/`upsertPolicy`（创建/更新，scope 校验 + 超支自动 pause+cancel + 欠支 resume）、`overview`（返回 BudgetOverview）、`evaluateCostEvent`（核心：cost event 入库后触发阈值检查）、`getInvocationBlock`（run 前预算门）、`resolveIncident`（处理 incident）。

budget policy 数据结构（`:317-348`）：`scopeType` ∈ `company|agent|project`；`scopeId`+`metric`(billed_cents)+`windowKind`(calendar_month_utc|lifetime)；`amount`(cents)+`warnPercent`(默认 80)+`hardStopEnabled`(默认 true)+`notifyEnabled`+`isActive`；`status` ∈ `ok|warning|hard_stop`（`:66`）。

辅助：`issue-execution-policy.ts:612` 的 `applyIssueExecutionStageTransition`（review/approval stage 状态机）；`productivity-review.ts` 的 `productivityReviewService`（生产力 review 软停）；`approvals.ts` 的 `approvalService`。

## 调用链路

预算超支处理链：

```
costService.createEvent (costs.ts:54)
  → db.insert(costEvents) (costs.ts:66)
  → 更新 agents/companies spentMonthlyCents (costs.ts:83-97)
  → budgets.evaluateCostEvent(event) (costs.ts:99)
      ↓ budgets.ts:648-715
  1. 扫描 candidatePolicies + filter relevantPolicies                :649-665
  2. computeObservedAmount (按 scope+window 聚合 costEvents)        :669
  3. soft: observedAmount >= ceil(amount*warnPercent/100)            :670
     → createIncidentIfNeeded("soft") (幂等查 existing)             :673
  4. hard: observedAmount >= amount                                  :692
     → resolveOpenSoftIncidents                                       :693
     → createIncidentIfNeeded("hard") + insert budget_override_required approval  :694
     → pauseAndCancelScopeForBudget(policy)                           :695
         ↓ budgets.ts:252-259
       pauseScopeForBudget (status=paused/pauseReason=budget)        :214-250
       hooks.cancelWorkForScope?.(scope)                              :254
         ↓ heartbeat.ts:11928-11954
       cancelActiveForAgentInternal / cancelRunInternal              :11930-11951
       cancelPendingWakeupsForBudgetScope                             :11931/11953
```

run 前预算门：`claimQueuedRun` 调 `budgets.getInvocationBlock(companyId, agentId, ctx)`（`budgets.ts:717`），逐层检查 company→agent→project 是否被硬停，返回 block reason。

## 核心实现

### Budget 硬停防 runaway spend

`hardStopEnabled` + `pauseAndCancelScopeForBudget`（`:600-604`/`:692-695`）。hard incident 同时创建 `budget_override_required` approval（`:380-393`），强制人工决策才能恢复。**为什么**：agent 失控循环会在你知道前烧光 quota——hard stop 在 adapter 启动前拦截。

### Scope 化多维策略

company/agent/project 三级 scope，`evaluateCostEvent` 按 scope 匹配（`:660-665`），`getInvocationBlock` 逐层降级检查（`:744→781→831`），任一被硬停即阻断。**为什么**：不同粒度的预算控制——公司级月度上限、agent 级个人预算、project 级项目预算。

### cancelWorkForScope 钩子注入

`budgets.ts` 不 import heartbeat，仅依赖 `hooks.cancelWorkForScope?.`（`:254`）。`heartbeat.ts:3412-3415` 构造时注入 `cancelWorkForScope=cancelBudgetScopeWork`。**为什么**：解耦 budget 与 heartbeat——budget 逻辑可在 `routes/costs.ts` 路由中独立复用（同样注入 hooks），不形成循环依赖。

### 审批门 enforcement

run 前 `getInvocationBlock` 检查 `pauseReason==="budget"`（`:781`/`:856`）；issue execution policy 用 stage 强制 review/approval，`commentBody` 必填（`:700`/`:753`）。stage 状态机 `idle → pending → completed | changes_requested`（`issue-execution-policy.ts:612`）。

### Productivity review 软停

`isSoftStopTrigger`（no_comment_streak/high_churn）触发 `continuation hold`（`productivity-review.ts:851-880`），与 budget 硬停互补——budget 管 cost，productivity 管 progress。`productivityReviewService(db, {enqueueWakeup})` 同样注入 enqueueWakeup 形成回调闭环。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 工厂 + 闭包 | `budgetService(db, hooks)` (`:496`) | hooks 注入解耦 |
| Hook 注入 | `BudgetServiceHooks.cancelWorkForScope` (`:44`) | 解耦 budget 与 heartbeat |
| 状态机 | issue execution stage (`issue-execution-policy.ts:612`) | review/approval 流转 |
| 策略矩阵 | BudgetPolicy 按 scopeType×windowKind×metric | 多维匹配 |
| 幂等 incident | `createIncidentIfNeeded` (`:350`) | 先查 existing 防重复 |
| 门卫模式 | `getInvocationBlock` (`:717`) | run 前预检门 |

## 模块间交互

`budgetService` 被 `heartbeatService` 构造时注入 `cancelWorkForScope`（`heartbeat.ts:3412`）；`getInvocationBlock` 在 run 前后多处调用（`heartbeat.ts:5088/5394/6042/7263/10868`）。被 `routes/costs.ts:61` 构造时注入同一 hooks。`costService.createEvent`（`costs.ts:99`）调 `evaluateCostEvent`。`productivityReviewService` 被 heartbeat 构造注入 enqueueWakeup（`:3417`），内部调 `budgets.getInvocationBlock` 选 review owner（`productivity-review.ts:550`）。`approvalService.approve`（`approvals.ts:117`）对 `hire_agent` 类型审批后调 `budgets.upsertPolicy`（`:162`）给新 agent 建 budget。

## 扩展方式

**新增 budget scope 维度（如 goal/issue/provider）**：`BudgetScopeType`（shared 包）加值；`resolveScopeRecord`（`:82`）加分支查 goal/issue 表；`computeObservedAmount`（`:143-166`）加 `costEvents.goalId`/`issueId` 过滤；`evaluateCostEvent` candidate filter（`:657`/`:660-665`）扩展；`getInvocationBlock`（`:717-863`）加层级检查；`pauseScopeForBudget`/`resumeScopeFromBudget`（`:214`/`:261`）加 pause/resume 目标表。

**修改超支自动动作**：`pauseAndCancelScopeForBudget`（`:252-259`）调整是否调 `cancelWorkForScope`；`evaluateCostEvent` hard 分支（`:692-713`）在前后插入 notify 逻辑；若要 soft pause（pause 但不 cancel），拆分 `pauseScopeForBudget` 与 `hooks.cancelWorkForScope?.` 调用，按 `hardStopEnabled` 等级区分。
