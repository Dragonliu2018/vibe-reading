---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "领域服务层"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "PullRequest", "分支保护", "MergeQueue", "webhook"]
description: "Harness 领域服务层：PR 生命周期与 merge 链路、space/repo 树形层级、可组合分支保护规则、事件驱动 webhook 分发、串行化合并队列"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/00-overview)

---

## 模块定位

领域服务层是 Harness 的业务大脑——承载 PR 生命周期、仓库与空间层级管理、分支保护规则、webhook 分发、合并队列、codeowner 计算等约 40 个子包的核心编排逻辑。它与 controller 的分工是：controller 做 HTTP 边界编排（鉴权、解码、事务管理），service 做跨 controller 复用的业务规则。本层解决的核心问题是：像「PR 能否 merge」这种判断牵涉保护规则、codeowner 审批、status check、合并队列、自动合并等多重逻辑，若散落在 controller 里会重复且无法复用——Harness 把它们抽成独立的 `merge`/`protection`/`codeowners`/`mergequeue`/`automerge` service，由 merge controller 组合调用。

## 模块架构

```
app/services/
  pullreq/        PR 事件驱动服务（mergeability check、code comment 迁移、file viewed）
  merge/          实际 git merge + 规则校验（MergeVerify）
  protection/     分支保护规则引擎（rule_branch、verify_pullreq）
  mergequeue/     合并队列（串行化 merge，临时 ref 跑 check）
  automerge/      自动合并监听（check 通过后自动入队 merge）
  codeowners/     CODEOWNERS 解析与评估
  webhook/        事件驱动 webhook 分发（HMAC 签名、重试）
  repo/ space/    仓库与空间层级服务
  label/ rules/ checkreq/ refcache/ migrate/ ...  其余约 30 个子包
```

注意一个反直觉的分工：PR 的 create/update/review/merge **不**在 `app/services/pullreq/` 里，而在 [API 层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/02-api)的 `app/api/controller/pullreq/`。`app/services/pullreq/` 的 `Service` 负责事件驱动的副作用（mergeability check、code comments migration、file viewed 标记），`ListService` 负责列表查询与 metadata backfill。merge 的实际编排在 `app/api/controller/pullreq/merge.go` 的 `Controller.Merge`，它组合调用本层的 `merge`/`protection`/`codeowners`/`mergequeue`/`automerge` service。

## 调用链路

PR merge 核心链路（`Controller.Merge` in `app/api/controller/pullreq/merge.go`）：

```
Controller.Merge(ctx, ...)
  ├─ c.mergeService.GetTargetSourceSHAs         取 target/source SHA
  ├─ c.fetchRules → c.protectionManager.ListRepoBranchRules   加载分支保护规则
  ├─ c.mergeService.CheckRules  in merge/rules.go
  │     └─ protectionRules.MergeVerify  in protection/verify_pullreq.go
  │           组装 reviewers / checkResults / codeOwners.Evaluate
  │           逐项：approval → code owner → comment resolve → status check
  │                  → target-is-ancestor → merge strategy → merge queue 阻塞
  │           → MergeVerifyOutput + []RuleViolations
  ├─ c.mergeQueueService.BranchInQueueViolations   目标分支是否在队列中
  ├─ if ruleOut.RequiresMergeQueue:
  │     └─ mergequeue.Enqueue   入队（PR.SubState=MergeQueue）
  └─ else:
        └─ mergeService.MergePullReq   直接 git merge + ref 更新
```

<details>
<summary>方法速查表</summary>

| 方法 | 路径 | 职责 | 关键设计 |
|------|------|------|---------|
| `Controller.Merge` | `app/api/controller/pullreq/merge.go` | merge 编排入口 | 规则校验→队列或直接 merge |
| `merge.Service.CheckRules` | `merge/rules.go` | 规则校验 | 组装 `MergeVerify` |
| `DefPullReq.MergeVerify` | `protection/verify_pullreq.go` | 保护规则求值 | 可组合 Definition |
| `Manager.ListRepoBranchRules` | `protection/rule_branch.go` | 规则加载 | 返回 `branchRuleSet` |
| `mergequeue.Enqueue` | `mergequeue/pull_request_enqueue.go` | 入队 | PR SubState=MergeQueue |
| `webhook.NewService` | `webhook/service.go` | webhook 消费者 | 注册 event reader |

</details>

## 核心实现

### 分支保护规则引擎

保护规则是可组合的 Definition 模型。`Branch` struct in `protection/rule_branch.go` 含 `Bypass`(`DefBypass`)、`PullReq`(`DefPullReq`)、`Lifecycle`(`DefBranchLifecycle`) 三块。`DefPullReq` in `protection/verify_pullreq.go` 内嵌一组 Definition：

- `DefApprovals`：require_code_owners、require_minimum_count、require_latest_commit
- `DefComments`：require_resolve_all
- `DefStatusChecks`：require_identifiers（必须通过的 check）
- `DefCommits`：require_target_is_ancestor
- `DefMerge`：strategies_allowed、block、delete_branch
- `DefMergeQueue`：可选，定义 merge queue 配置

求值流程：`Manager.ListRepoBranchRules` 返回实现 `BranchProtection` interface 的 `branchRuleSet`。调用 `MergeVerify` in `verify_pullreq.go` 逐项检查——approval 数量 → code owner 审批 → comment resolution → status check → target-is-ancestor → merge strategy → merge queue 阻塞，返回 `MergeVerifyOutput` + `[]RuleViolations`。`Branch.MergeVerify` 在外层包裹 bypass 逻辑（bypass 规则允许特定角色跳过部分检查）。每个 Definition 实现 `protection.Definition` interface（`Sanitize` + `SupportsParent`），在 `protection/service.go` 的 `Manager.Register` 注册——这是新增规则类型的扩展点。

### MergeQueue 串行化合并

为什么需要合并队列：多个 PR 指向同一 target branch 时，直接 merge 会互相 invalidate merge base——A 基于 main@v1 生成 merge commit 后，B 的 merge base 变了，得重新跑 check。Merge queue 让 PR 排队，按顺序创建 merge commit，在临时 ref 上跑 check，全部通过后一次性 fast-forward 到 target branch。

状态机（`mq_process.go` + `pull_request_enqueue.go`）：Entry 状态 `MergePending → ChecksPending → ChecksInProgress → merged/removed`。`Enqueue` 创建 entry（`MergePending`）并把 PR `SubState` 设为 `MergeQueue`。`process` 流程：锁分支 → 为每个 entry 创建 merge commit（base=上一个 entry 的 merge commit）→ 更新 merge queue ref → 按 `GroupSize` 分组触发 checks → checks 全通过后 fast-forward 到 target branch。冲突或 check 失败的 entry 被 `remove` 移出队列。这避免了多个 PR 各自 merge 后互相打架的问题，代价是串行延迟。

### Webhook 事件驱动分发

`webhook.Service` in `webhook/service.go` 在 `NewService` 中注册三个 event reader：git events（branch/tag）、pullreq events（created/merged/comment 等 12 种）、mergequeue events。每个 handler（如 `handleEventPullReqMerged`）调 `triggerForEventWithPullReq` in `trigger.go`，加载 PR/repo/principal → 构造 payload body → `WebhookExecutor.TriggerForEvent`。

分发逻辑 `triggerWebhooks` in `trigger.go` 按 `parents`（repo + 祖先 space 链）列出所有适用 webhook，去重已成功的 execution，对每个 webhook 调 `executeWebhook`：HTTP POST + HMAC-SHA256 签名（用 `crypto.GenerateHMACSHA256` + `crypto.IsShaEqual` 常量时间比较防时序攻击），10s 超时。响应码分类：2xx=success、408/429/5xx=retriable（事件重处理）、4xx=fatal。webhook 是 events 的**消费者**（通过 `ReaderFactory`）而非直接 pubsub——事件由 controller 通过 `Reporter` 发布到 events stream，webhook service 异步消费，这与 [基础设施层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/09-infra)的 events/stream 框架配合实现解耦。

### 空间层级模型

Space 是**树形容器**，Repo 挂在 Space 下。路径用 `/` 分隔的字符串表达 in `app/paths/paths.go`，如 `org1/team1/repo1`。`paths.IsAncesterOf` 判断祖先关系，`paths.DisectLeaf` 拆分父路径与叶名。Space 的 `ParentID` + `SpacePathStore` 维护路径链。`space.Service` in `space/service.go` 持有 `spaceStore`、`spacePathStore`、`repoStore`，支持 `move.go`（资源移动）和 `soft_delete.go`。这个树形层级让保护规则、webhook、权限都能按 space 继承（祖先 space 的规则对子 repo 生效），是 Harness 权限与规则模型的基础。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Strategy（merge method） | `merge.Func` 按 `enum.MergeMethod` 选 Merge/Squash/Rebase/FastForward | 4 种合并策略可插拔 |
| Composite Definition | `protection.DefPullReq` 内嵌多个 Definition | 规则可组合、可独立注册 |
| 事件驱动消费者 | `webhook.Service` 注册 event reader | webhook 与 controller 解耦，异步重试 |
| 构造注入 | `NewController(...)` 20+ 依赖 | wire 编织，无 service 全局状态 |

## 模块间交互

Service 层依赖：`store/*`（数据访问，见 [持久化层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/04-store)）、`git.Interface`（git 操作 RPC，见 [Git 引擎](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/05-git)）、`events.ReaderFactory/Reporter`（事件流）、`pubsub.PubSub`（跨实例通信，如 cancel merge check）、`dbtx.Transactor`（事务）、`sse.Streamer`（前端推送）、`locker.Locker`（分支/PR 锁）。被 `app/api/controller/*` 调用。Service 之间也有依赖：`mergequeue` 依赖 `merge.Service` + `protection.Manager`；`automerge` 依赖 `merge.Service` + `mergequeue.Service`。

## 扩展方式

**新增 PR 状态转换**：修改 `types/enum` 的 PullReqState/SubState 枚举 → 在 `pullreq/service.go` 的事件 reader 注册新 handler → 在 controller merge/review/close 流程中增加状态转换逻辑 → 在 `mergequeue/VerifyIfMergeQueueable` 等守卫处增加检查。

**新增保护规则类型**：实现 `protection.Definition` interface（`Sanitize` + `SupportsParent`）→ 在 `protection/service.go` 的 `Manager.Register` 注册 → 新增 `rule_xxx.go` 定义 struct → 在 `verify_pullreq.go` 或新文件实现 `MergeVerify` 等校验逻辑 → 更新 `enum.RuleType`。

**新增 webhook 事件源**：在 `app/events/` 对应包的 `Reporter` 增加新 event 方法 → 在 `webhook/service.go` 的 reader 注册新 handler → 新增 `handler_xxx.go` 调 `triggerForEventWithPullReq`/`triggerForEventWithRepo` → 在 `types/enum` 的 `WebhookTrigger` 增加触发类型 → 定义 payload struct。
