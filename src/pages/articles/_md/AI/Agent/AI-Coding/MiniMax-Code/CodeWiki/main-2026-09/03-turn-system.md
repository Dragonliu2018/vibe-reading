---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "Turn 执行系统"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "Turn 系统", "队列", "租约", "compaction"]
description: "turn-system 解读（~48.8k 行仓库最大单模块）——submit immediate/queued 二分、每 session 单 drain 协程队列、admission 事务（sessionLocks 租约 + turnIngress 幂等收据）、LocalAgentHost fail-closed 适配、steering 双 lane、双触发 compaction、runaway-guard 白名单"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

`service/turn-system/`（~4.9 万行）是仓库最大的单一子系统，回答 agent 界最核心的执行问题：**一条消息如何变成一次可靠的 agent 执行**——排队、准入、并发控制、崩溃恢复、上下文压缩、防失控。它与 session-system 的分界是刻意的设计：SessionSystem 只管持久事实（队列行、canonical history），TurnSystem 独占"谁正在执行"的进程内所有权 + 持久租约。why：AgentHost 独占运行时 history/stream 投影（execution.coordinator.ts:57 注释），只有 Host 入口前的失败才走 SessionSystem 失败投影器——单写者边界让崩溃恢复与历史投影互不纠缠。

## 模块架构

![Turn 执行链路](/vibe-reading/images/articles/minimax-code/turn-flow.svg)

内部按生命周期阶段切分：`turn-submission.service.ts`（提交语义）、`queue.dispatcher.ts`（派发）、`execution/`（准入与执行协调，含 `turn-controller/` 内存注册表与 `steering/`）、`agent-host/`（与 pi 执行内核的衔接，含 `preparation/`、`assembly/`、`execution/`、`history/`、`events/`、`runner/`）、`persistence/`（SQLite 事务）、`compaction/`、`runaway-guard/`。全部服务为**闭包工厂 + `Pick<Capability,...>` 窄接口注入**（如 `Pick<CommittedQueueCapability, 'requireMutableSession'|'enqueue'|...>`），唯二的类是 `LocalAgentHost` 与 `AutomaticContextCompactor`。

## 调用链路

一条用户消息的完整链路：

```
TurnService.submit → TurnSubmissionService.submit (turn-submission.service.ts:55)
  ├─ immediate：submitImmediate → activation.execute 直达 admission
  └─ queued：submitQueued (:127)
       → queue.enqueue（durable 行，session-system 所有）
       → completions.register 返回 completion Promise
       → dispatcher.dispatch(sessionId)          best-effort 唤醒
→ QueueDispatcher.drain (:241)                   每 session 单 drain 协程
     claimNext → classifyQueuedItem（ready/defer/cancel）
     → executeClaim (:361) → QueueTurnExecutor.execute
         beforeSubmit→prepareDelivery；beforeStart→queue.acknowledge（claimId 绑 turnId，崩溃后唯一去重防线）
→ TurnExecutionService.submitTurn (turn-execution.service.ts:280)
     submissionPreparation.prepare（带 commit/rollback/compensate）
     → repository.admit (:239)（单事务：sessionLocks 租约 30min + turnIngress 收据 + priorityFence）
     → controller.register（内存槽位 + AbortController + 10s 租约续期）
     → coordinator.startTurn
→ LocalAgentHost.run (local-agent-host.ts:156)
     captureAcceptedTurnLease 冻结校验 → TurnPreflight.prepare → assembleTurn
     → TurnCommitPipeline（事件流 + canonical history 写入）
     → executor.execute(LocalTurnExecutionInput)
→ ExecutionCoordinator.settleAndRelease (:224)
     repository.settle → controller.complete → released.publish 唤醒下一条
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `submit()` in turn-submission.service.ts:55 | 提交入口 | immediate/queued 按 `allowQueue` 二分 |
| `dispatch()` in queue.dispatcher.ts:81 | 唤醒 drain | requestedWake/startedWake 计数去重 |
| `drain()` in queue.dispatcher.ts:241 | 队列排空循环 | claim+receipt 唯一去重；FIFO 头让位（GOAL-05） |
| `submitTurn()` in turn-execution.service.ts:280 | 持久准入 | Saga：prepare→admit→commit / rollback→compensate |
| `admitRepositoryTurn()` in turn.repository.ts:239 | 准入事务 | 单事务写租约+收据+栅栏 |
| `run()` in local-agent-host.ts:156 | Host 执行 | "有序 fail-closed 适配器" |
| `steer()` in turn.controller.ts:260 | steering 注入 | 推入 entry.steering 并唤醒 runner |
| `tryBeginClose()` in turn.controller.ts:367 | 优雅关闭边界 | 未消费 steering 的双 lane 规则 |
| `settleAndRelease()` in execution.coordinator.ts:224 | 结算释放 | 失败重试一次后 abandon |

</details>

## 核心实现

### 队列 dispatcher 的并发模型

每 session 单 drain 协程 + 唤醒计数（queue.dispatcher.ts:52-57）。`beforeStart` 的 `queue.acknowledge` 把 claimId 绑定 turnId——这是**进程崩溃后的唯一去重防线**（重启后凭收据识别已受理的 turn）。GOAL-05 让自主 Goal 项让出 FIFO 头（`shouldYieldFifoPosition`，:39），drain-local 单调 `yielded` 集合保证一趟必终止、新唤醒是新一轮必须重查——避免队头阻塞的同时不取消不重排自主任务。

### admission：租约 + 收据 + 栅栏的事务

`admitRepositoryTurn` 在单事务内写三样东西：`sessionLocks` 租约（30min，防跨进程双写）、`turnIngress` 收据（含 `inputDigest` 幂等）、优先级栅栏。进程内 `TurnController` 注册 `ActiveTurnEntry`（phase: running/closing/aborted，`matchingEntry` 五元组防 stale 持有），起 10s 租约续期定时器。崩溃恢复走 `turn-lease-recovery.ts`（过期/进程重启/死属主三种场景）。

### steering：运行中插话的双 lane

`TurnService.steer` → `SteerSessionService.deliver`（steer-session.service.ts:65）：`findSteeringReceipt` 幂等去重 → 活跃 Turn 则 `reserveSteeringReceipt` → `controller.steerActiveTurn` 推入 `entry.steering` 并唤醒 runner；无活跃 Turn 先尝试激活（`activateOrSteerRace`），被 active-turn/compaction-active 拒绝说明是竞态，回头投递给新出现的活跃 Turn。退出边界（`tryBeginClose`，turn.controller.ts:367）的不对称规则很能体现产品判断：**未消费的用户 steering 交给 requeue lane 变成新查询；未消费的机器 steering（cron/task）扣住 close 等下一轮消费**——"丢机器输入比早一步收尾更糟"。消费侧在 `agent-host/execution/user-input-control.ts:47` 的 `control.drainSteering()`。

### compaction：双触发与三策略

两条触发路径：显式 `requestCompaction` 走与 Turn 相同的 admission（busyReason 'compaction'）；**自动压缩挂在每次 LLM 调用前**（`createAutomaticContextCompactionHook` 是 `PiBeforeLlmCallHook`，local-agent-host.ts:582 注入），条件是 `inputTokens > automaticTriggerAt`（`resolveCompactionTokenBudget` 按 contextWindow 算）或序列化字节超限。策略 v3 `local-context-compaction-v3`：优先 `ToolResultArchiver` 归档旧工具结果（read 工具可读回），不够再 `llm_checkpoint`（LLM 摘要）；Plugin `PreCompact` 钩子可 abort/deny/defer。

### runaway-guard 与重试的保守主义

runaway-guard 防 agent 陷入重复工具调用死循环：`tool-policy.ts:7` 的白名单策略——bash/grep 的"搜索无匹配 exit 1"视为预期结果不误报；task_query/task_output 用 loopKey/progressKey 投影轮询进度，状态变化即 reset。命中后注入 reminder（goal-verifier 豁免）并 fail-open 上报。重试策略同样保守：LLM 层仅 rate-limit/upstream/TPM/overloaded 四个错误码可重试（runtime-error-retry-policy.ts 的 `isProductionRuntimeErrorRetryable`）；结算层各重试一次，两次耗尽后 `abandon` 释放产品侧 pin 的状态——durable settlement 幂等，盲目重试会放大不确定性。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 + AbortController | `ActiveTurnEntry.phase`（turn.controller.ts:36） | 优雅关闭与中止的显式建模 |
| Saga/补偿事务 | `admitTurnWithSubmissionPreparation`（turn-execution.service.ts:329） | 持久准入必须可回滚，`AggregateError` 聚合补偿失败 |
| 单写者租约 | `sessionLocks` + leaseId（turn.repository.ts:58-67） | 崩溃恢复与多进程互斥 |
| 闭包工厂 + 窄接口 Pick | 全模块服务 | 最小依赖注入，测试只需构造所需能力 |
| Fail-open 观察者 | observation.ts:48-58、execution.coordinator.ts:267 | 诊断/上报回调不阻塞主流程 |

## 模块间交互

对 session-system 的依赖全部经 `TurnSystemSessionCapabilities`（contracts.ts:551）窄缝注入（队列持久化/派发、优先级栅栏、canonical history append、会话删除恢复回调）。向下经 `agentRuntimes.normal.assembleTurn` 与 `pi-turn-runner`（`PiBeforeLlmCallHook` 压缩挂点）进入 pi；`@mavis/agent-extension` 提供 runaway-guard 扩展本体，`@mavis/context-manager` 提供 token 预算。v1 的 `SqliteLocalTurnDiffStore`（local-runtime/src/persistence/sqlite-persistence.ts:685）经 `compat/v1/session.ts` 供 rewind/fork 用。

## 扩展方式

- **新增队列消息来源**（如新 IM channel）：改 `turn-submission.service.ts:445` 的 `QUEUE_SOURCES` + `toQueueChannelContext`，再在 session-system 的 `QueueMessageSource` 联合类型加成员。
- **调整自动压缩**：触发判定在 `compaction/automatic-context-compactor.ts` 的 `prepareAutomaticCompaction`，策略在 `algorithm/compact-context.ts`，Plugin 钩子行为在 `agent-host/compaction/context-compaction.ts`。
- **给 runaway-guard 增加工具的循环检测**：`runaway-guard/tool-policy.ts` 的 `createProductionRunawayGuardToolPolicies` 注册表加 `kind: 'detect'` 或 `'polling'` 策略。
