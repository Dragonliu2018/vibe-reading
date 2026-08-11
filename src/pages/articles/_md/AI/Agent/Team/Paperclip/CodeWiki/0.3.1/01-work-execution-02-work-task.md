---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Work & Task System"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 任务票据系统——原子 checkout、goal ancestry、blocker 依赖、inbox 状态"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 工作执行引擎](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/01-work-execution)

---

## 模块定位

本模块属于工作执行引擎子系统。Work & Task System 是 Paperclip 的任务票据系统——issue 是 agent 工作的基本单位，承载公司/项目/目标/父任务四级谱系（goal ancestry）、原子 checkout 执行锁、blocker 依赖、评论、文档、附件、work products、labels、inbox 状态。`issueService()` 是 graphify god node #2（85 边）。它独立存在，是因为"任务领取与状态流转"需要统一的票据语义——防双工 checkout、依赖就绪检查、per-user inbox——这是多 agent 协作的基础。

## 模块架构

`issueService(db)`（`issues.ts:3273`）工厂返回约 40 个方法，按职责分组：CRUD（create/update/remove/list）、原子 checkout（checkout/assertCheckoutOwner/release/adminForceRelease）、子任务（createChild/decomposeAcceptedPlan）、依赖（getDependencyReadiness/listDependencyReadiness/listWakeableBlockedDependents）、评论（listComments/addComment/tombstoneComment）、附件标签（createAttachment/listLabels）、Inbox（markRead/markUnread/archiveInbox）、Ancestry（getAncestors）。

issue 核心数据结构（`issueListSelect` `:2063`）：**status 枚举**（`:96`）`["backlog","todo","in_progress","in_review","blocked","done","cancelled"]`；**checkout 四元组** `checkoutRunId`/`executionRunId`/`executionAgentNameKey`/`executionLockedAt`（`:2088`）；**goal ancestry 链** `companyId`→`projectId`→`goalId`→`parentId`（`:2065`）；**执行策略** `executionPolicy`（JSON）+ `executionState`（运行时阶段状态）。

辅助服务：`issueTreeControlService(db)`（`issue-tree-control.ts:411`）管 tree hold/subtree pause；`issue-execution-policy.ts:612` 的 `applyIssueExecutionStageTransition` 管 review/approval stage 状态机；`issue-thread-interactions.ts` 管 agent 交互后回退 issue。

## 调用链路

原子 checkout 调用链（heartbeat → issue checkout → 锁校验 → in_progress）：

```
heartbeat.ts:8327  issuesSvc.checkout(issueId, agent.id, ["todo","backlog","blocked"], run.id)
  ↓ issues.ts:5533
1. treeControlSvc.getActivePauseHoldGate()           :5543  subtree pause 检查
2. isTreeHoldInteractionCheckoutAllowed()            :5546  hold 期间同 run 可 checkout
3. clearExecutionRunIfTerminal + clearCheckoutRunIfTerminal  :5557  清理已终止 run 残留锁
4. listIssueDependencyReadinessMap()                 :5560  blocker 检查
5. 原子 UPDATE issues SET status='in_progress',
     checkoutRunId=run.id, executionRunId=run.id
     WHERE id=? AND status IN(expected)
       AND (checkoutRunId IS NULL OR =run.id)
       AND (executionRunId IS NULL OR =run.id)        :5575-5595
6. 若原子 UPDATE 失败 → adoptUnownedCheckoutRun/adoptStaleCheckoutRun  :5602
```

issue 状态流转：`backlog → todo → in_progress → [in_review] → done`；`in_progress → blocked → in_progress`（blocker 解决后）；任意状态 → `cancelled`。`assertTransition`（`:109`）校验合法性，`applyStatusSideEffects`（`:116`）自动设 startedAt/completedAt/cancelledAt。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `checkout` (`:5533`) | 原子领取 issue | CAS UPDATE 防双工 |
| `assertCheckoutOwner` (`:5730`) | 校验当前 run 持有锁 | checkout 四元组校验 |
| `release` (`:5874`) | 释放执行锁 | terminal run 自动清理 |
| `createChild` (`:4627`) | 创建子任务 | 传递 goal ancestry |
| `listDependencyReadiness` (`:4428`) | 检查 blocker 就绪 | 区分 unresolved vs pendingFinalize |
| `listWakeableBlockedDependents` (`:4448`) | 反向查可唤醒的依赖者 | blocker 完成后唤醒后续 |
| `getAncestors` (`:6449`) | 遍历 parentId 链 | 上限 50 层，批量加载 project+goal |
| `addComment` (`:6076`) | 线程化评论 | tombstone 软删 |

</details>

## 核心实现

### 原子 checkout 防双工

`checkout`（`:5575-5595`）用单条 `UPDATE issues SET checkoutRunId=run.id, executionRunId=run.id, status='in_progress' WHERE id=? AND status IN(expected) AND (checkoutRunId IS NULL OR checkoutRunId=run.id) AND (executionRunId IS NULL OR executionRunId=run.id)` 实现 CAS。**为什么**：多 agent 可能同时竞争同一 issue，数据库行锁保证只有一个 run 成功，无需应用层锁——这是最轻量的防双工手段。若 CAS 失败，`adoptStaleCheckoutRun`（`:3842`）+ `adoptUnownedCheckoutRun`（`:3943`）检测旧 run 是否已 terminal 并接管，避免死锁。

### goal ancestry（任务携带完整目标谱系）

issue 携带 `companyId`/`projectId`/`goalId`/`parentId` 四级谱系。`createChild`（`:4707`）把 parent 的 `goalId` 和 `projectId` 传递给子任务；`getAncestors`（`:6449`）遍历 parentId 链（上限 50 层）批量加载关联 project+goal+workspace；`resolveIssueGoalId`（`:5166`）解析 goal 优先级：显式 goalId > project 默认 goalId > company 默认 goalId。**为什么**：agent 执行子任务时需要知道完整上下文——属于哪个公司/项目/目标——理解 "why" 而非孤立执行。

### blocker 依赖

`listIssueDependencyReadinessMap`（`:800`）批量查询 issue 的 blocker 链，区分 `unresolvedBlockerIssueIds`（未完成 blocker）和 `pendingFinalizeBlockerIssueIds`（已 done 但 workspace 未 finalize 的 blocker，`:628`）。checkout 前必须无 unresolved blocker（`:5562`）。`listWakeableBlockedDependents`（`:4448`）反向查询：blocker 完成时哪些 dependent 可被唤醒，heartbeat 的 `releaseIssueExecutionAndPromote` 用它唤醒后续。**为什么**：依赖未完成时 checkout 会空转，需前置拦截；pendingFinalize 区分逻辑完成与 workspace 就绪。

### inbox 状态

`issueReadStates` 表记录用户最后阅读时间，`issueInboxArchives` 表记录归档状态，`countUnreadTouchedByUser`（`:5275`）统计未读数。list 查询通过子查询关联 read state 和 inbox archive 过滤可见性。**为什么**：多 agent/user 协作场景需要 per-user 的 inbox 视图。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 工厂 + 闭包 | `issueService(db)` (`:3273`) | db 注入，便于事务内传 tx |
| 状态机 | `applyIssueExecutionStageTransition` (`issue-execution-policy.ts:612`) | review/approval stage 流转 |
| 原子 CAS | `checkout` 单条 UPDATE (`:5575`) | 无应用锁防双工 |
| Stale adoption | `adoptStaleCheckoutRun` (`:3842`) | CAS 失败时接管已 terminal 的旧 run |

## 模块间交互

`issueService` 被 `heartbeatService`（`:3394` 构造引用）在 run 启动时调 `checkout`、`listDependencyReadiness`、`addComment`、`update`、`listWakeableBlockedDependents`、`create`。被 `issue-thread-interactions.ts:666` 调 `update` 回退 issue 给创建者。被 `routines.ts:540`、`task-watchdogs.ts:721`、`productivity-review.ts:204`、`recovery/service.ts:471` 各自实例化使用。注意 `applyIssueExecutionPolicyTransition` 在**路由层**（`routes/issues.ts:5853`）调用，不在 service 内部——执行策略决策与持久化分离。

## 扩展方式

**新增 issue status**（如 "paused"）：`issues.ts:96` 的 `ALL_ISSUE_STATUSES` 加值；`:116` 的 `applyStatusSideEffects` 加 `pausedAt` 逻辑；`issue-tree-control.ts:71` 的 `TERMINAL_ISSUE_STATUSES` 决定是否纳入；DB schema `issues` 表加 `pausedAt` 列。

**新增 issue 关系类型**（如 "relates_to"）：`:2620` 附近的 `issueRelations` 查询当前 `type="blocks"` 硬编码，需加新 type 分支；`:4700` 的 `syncBlockedByIssueIds` 仅处理 blocks，新 type 需写对应 sync 函数。
