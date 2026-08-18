---
source:
  type: "源码解读"
  project: "Langfuse"
  url: "https://github.com/langfuse/langfuse"
title: "应用内 Agent"
date: "2026-08-18T16:35:50+08:00"
category: ["AI", "Agent", "Observability", "Langfuse", CodeWiki, "4.11.0"]
tags: ["Langfuse", "In-App Agent", "MicroVM", "AG-UI", "Event Sourcing"]
description: "Langfuse 应用内 Agent：一个事件日志三种派生、fold once 不变量、durable worker 执行、microvm 沙箱。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Langfuse/CodeWiki/4.11.0/00-overview)

---

## 模块定位

这是 Langfuse UI 里的内置 AI 助手——一个抽屉式的 agent，能在 microvm 沙箱里跑工具（bash/edit/read/write），帮你查 trace、改 prompt、分析数据。它之所以独立成模块，是因为它有一套自成体系的设计：事件日志模型、durable worker 执行、自带的 microvm 沙箱运行时（独立包 + 独立进程）。它不只是"UI 里调个 LLM"，而是一个完整的、跨刷新存活的后台 agent 系统。

架构契约原文在 `web/src/features/in-app-agent/ARCHITECTURE.md`，运维指南在 `README.md`。这两个文档是这模块的权威来源，本节是对它们的解读 + 源码印证。

## 模块架构

```
packages/in-app-agent-sandbox-runtime/   # 独立包：microvm 沙箱运行时（独立进程）
├── src/server.ts          # HTTP server，POST /sandbox 处理 read/write/edit/bash
├── src/contracts.ts       # SandboxOperation Zod schema（discriminatedUnion）
├── Dockerfile             # node:24-alpine，非特权用户，/workspace 隔离
└── build-microvm-image.sh  # AWS Lambda MicroVM 镜像构建

packages/shared/src/in-app-agent/         # web+worker 共享
├── schema.ts              # AG-UI 消息 schema（AgUiMessageSchema，7 种 role）
├── messages.ts            # pruning helpers（dropUnpairedAssistantToolCalls 等）
├── ids.ts                 # ID 生成（aconv_/arun_/amsg_ 前缀）
├── constants.ts, backgroundWatch.ts
└── server/
    ├── persistence.ts     # 事件持久化、accumulator、replay、snapshot（核心）
    ├── watch.ts           # watchConversationFrames — SSE tail 生成器
    ├── runLifecycle.ts    # CAS claim/heartbeat/reconcile/cancel/approval（770 行）
    └── sandbox/
        ├── types.ts       # SandboxProvider/SandboxSession/InAppAgentSandbox 接口
        └── service.ts     # createInAppAgentSandbox 工厂

web/src/features/in-app-agent/           # web 侧
├── ARCHITECTURE.md / README.md
├── components/           # 抽屉 UI
├── lib/
│   ├── display.ts        # Display state recording + projectInAppAgentMessagesForDisplay（fold once）
│   ├── backgroundExecutionSession.ts  # BackgroundExecutionSessionController（浏览器唯一 state owner）
│   └── backgroundAgentClient.ts        # InAppAgentBackgroundClient（AG-UI AbstractAgent transport）
├── server/
│   ├── router.ts         # tRPC routes（startRun/cancel/approve/snapshot/list/feedback）
│   ├── conversationSnapshot.ts  # getConversationSnapshotFromEvents
│   └── backgroundRunService.ts  # startBackgroundRun / getBackgroundConversationSnapshot / cancelBackgroundRun
└── quickActions.ts, routeContext.ts, context.ts

worker/src/queues/inAppAgentRunQueue.ts   # BullMQ processor（5 行核心）
worker/src/features/in-app-agent/executeInAppAgentRun.ts  # Worker agent executor

Postgres: InAppAgentConversation / InAppAgentEvent / InAppAgentRun / InAppAgentPendingToolApproval
```

> **代码归属原则**（ARCHITECTURE.md:58-59）：`packages/shared` 放 web **和** worker 都需要的（事件日志、canonical 累积、replay、run 生命周期、watch framing）；web-only 逻辑即使跑在 server 上也留在 web。worker 跑 agent，永远不渲染。

## 调用链路

```
用户发消息
  └─ web InAppAgentProvider
       └─ BackgroundExecutionSessionController (lib/backgroundExecutionSession.ts)
            └─ startBackgroundRun (server/backgroundRunService.ts)
                 ├─ reconcileConversationRunsInTransaction（强制单 active run，supersede 旧 run）
                 ├─ 创建 InAppAgentRun(status=QUEUED) + InAppAgentEvent
                 └─ InAppAgentRunQueue.add({projectId, runId})

worker 侧（异步）:
inAppAgentRunQueue processor
  └─ executeInAppAgentRun (worker/src/features/in-app-agent/executeInAppAgentRun.ts)
       ├─ claimRun (CAS QUEUED→RUNNING) + heartbeat
       ├─ getConversationMessagesForReplay（从事件日志重建模型上下文）
       ├─ createInAppAgentSandbox（对话级沙箱句柄）
       ├─ AG-UI AbstractAgent loop → 流式 TEXT_MESSAGE/TOOL_CALL delta
       │    ├─ 工具调用 → POST /sandbox（microvm 沙箱执行 bash/edit/read/write）
       │    └─ 需批准的 mutation → AWAITING_APPROVAL（InAppAgentPendingToolApproval）
       ├─ 事件流 → InAppAgentEvent 表追加（canonical 来源）
       └─ 完成 → SUCCEEDED / 失败 → FAILED

浏览器渲染:
  └─ watchConversationFrames (SSE tail 生成器, shared/server/watch.ts)
       └─ 从 InAppAgentEvent 重建 + display sidecar
            └─ projectInAppAgentMessagesForDisplay（lib/display.ts，fold once）
                 └─ drawer 渲染
```

## 核心实现

### 一个日志，三种派生

这是模块的灵魂（ARCHITECTURE.md）。每条消息表示都从同一个地方派生——`in_app_agent_events` 表按每会话 `sequence_number` 排序。canonical/display/replay **不独立持久化**为额外真相来源：

| 派生 | 生产者 | 消费者 | shape | 永不 |
|------|--------|--------|-------|------|
| **canonical** | `createConversationMessageAccumulator` (`persistence.ts`) | `getConversation` wire、AG-UI seed、feedback 身份、title 推断 | 完整 assistant 消息，按稳定 AG-UI message id 键控，`runId` 保留，in-flight tool call 保留 | 被 prune 或重排后再 seed live agent |
| **display state + projection** | `lib/display.ts` `record*` 累积 + `projectInAppAgentMessagesForDisplay` 折叠 | 仅渲染一次，在 `InAppAiAgentProvider` | sidecar 描述交错 reasoning 与 tool call 归属，加合成 `display-text-<id>-N` 段 | 写回 server，或喂给 agent |
| **replay** | `getConversationMessagesForReplay` (`persistence.ts`) | resuming run 的模型上下文 | reasoning、redirect 结果、`runId`、未配对 tool call 被剥离 | 渲染，或用作 client hydration 快照 |

三者回答不同问题：**发生了什么**（canonical）、**该怎么显示**（display）、**模型下一轮该看到什么**（replay）。混淆任何两者是这个 feature 反复重新发现的失败模式——所以上表是契约不是描述。

### fold once 不变量

display projection **只在渲染时、在浏览器里跑一次**（ARCHITECTURE.md）。这不是风格偏好——projection 是**有损**的：它在 assistant 消息第一个交错块处截断，把续写移到合成兄弟消息。这对渲染正确，对其他用途错误。

当 server 也做 projection 时（这 feature 最初的样子），浏览器用截断的消息 seed live AG-UI agent——AG-UI 按 message id 追加 `TEXT_MESSAGE_CONTENT`，续写 run 的下一个 delta 落在截断 seed 上，续写从 canonical transcript 消失直到 run 完成重新 hydrate。**修复不是换 accessor，是停止 fold 两次**：wire 现在带 canonical 消息 + display state 作为 sidecar，唯一 fold 发生在 live path 已经 fold 的地方。

推论：① **pruning 也是 presentation**——`dropUnpairedAssistantToolCalls` / `dropEmptyAssistantMessages` 在渲染时跑，且只对已结算 transcript；live seed 必须保留 in-flight tool call，否则到达的 `TOOL_CALL_RESULT` 无处附着，AG-UI 追加一个 orphan `tool` 消息被抽屉静默丢弃。② **sidecar 是派生的，从不权威**——丢了它 transcript 仍正确只是更扁平，`deserializeInAppAgentDisplayState` 回退空 state 而非 throw。

### durable worker 执行

agent 跑在 worker 而非浏览器：durable（跨刷新存活）、密钥不暴露前端、长任务可超浏览器生命周期。浏览器是**唯一 state owner**（`BackgroundExecutionSessionController`），通过 AG-UI `AbstractAgent` transport（`InAppAgentBackgroundClient`）消费 worker 的 SSE 流。

### microvm 沙箱

`packages/in-app-agent-sandbox-runtime` 是独立进程，HTTP server（`server.ts`）处理 `POST /sandbox`：

```typescript title="packages/in-app-agent-sandbox-runtime/src/contracts.ts"
SandboxOperationSchema  // discriminatedUnion
// BashSandboxOperation / EditSandboxOperation / ReadSandboxOperation / WriteSandboxOperation
SandboxFileSchema       // 文件结构
```

沙箱在 `/workspace` 隔离，非特权用户运行，工具操作经 Zod 校验。镜像用 `build-microvm-image.sh` 构建为 AWS Lambda MicroVM——轻量、快启动、强隔离（比 Docker/进程隔离更适合跑不可信代码）。`SandboxProvider` 接口（`shared/in-app-agent/server/sandbox/types.ts`）有 Docker / Lambda-MicroVM 两个实现，`createInAppAgentSandbox` 工厂（`sandbox/service.ts`）创建对话级沙箱句柄。

### run 状态机（CAS）

状态定义见 `packages/shared/src/features/inAppAgent/types.ts` 的 `InAppAgentRunStatus`（QUEUED/RUNNING/AWAITING_APPROVAL/SUCCEEDED/FAILED/CANCELLED），存为普通字符串列（非 PG enum，加状态免 `ALTER TYPE`，读者须容忍未知历史值）。转换用 Postgres CAS 在 `runLifecycle.ts` 完成——`claimRun`（QUEUED→RUNNING）、`heartbeatClaimedRun`（续命）、approval 决策（AWAITING_APPROVAL→RUNNING/SUCCEEDED/FAILED）、`reconcileConversationRuns`（事务内强制单 active run，新消息到达 supersede 旧 QUEUED/AWAITING run）。

![In-App Agent run 状态流](/vibe-reading/images/articles/langfuse-codewiki-4.11.0/state-flow.svg)

错误码 `InAppAgentRunErrorCode`（`WORKER_LOST` 心跳超时、`RUN_TIMEOUT` 超时长跑、`OUTCOME_UNKNOWN` 已批准 mutation 可能已开始但结果未持久化——不可盲目重试、`APPROVAL_EXPIRED`、`WORKER_SHUTDOWN` 等）由 watchdog 和 backstop 定时器设置。worker 优雅关闭把 RUNNING 改 `CANCELLED` + `WORKER_SHUTDOWN`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 事件日志 + 多派生 | `InAppAgentEvent` 单一日志，canonical/display/replay 派生 | 一份真相，三种视图回答不同问题；避免三份真相漂移 |
| fold once | `projectInAppAgentMessagesForDisplay` 只在浏览器渲染时跑 | projection 有损，服务端 fold 会让浏览器 seed 截断、续写丢失 |
| Durable execution | worker 跑 agent，浏览器只渲染 | 跨刷新存活，密钥不暴露前端 |
| Microvm 沙箱 | `in-app-agent-sandbox-runtime` 独立进程 | 轻量快启动强隔离，跑不可信工具代码 |
| AG-UI 协议 | streaming message delta | agent 流式输出标准 |
| CAS 状态转换 | `runLifecycle.ts` Postgres CAS | 并发安全的状态机推进 |
| reconcile 强制单 active run | `reconcileConversationRuns` | 新消息到达时 supersede 旧 run，避免多 run 竞争同会话 |
| pruning 按形状归 web/shared | `AgUiMessage` shape 的放 shared，presentation 的放 web | replay 在 worker 也需 pruning，故按 shape 而非 presentation 归属 |

## 模块间交互

web in-app-agent 依赖 `packages/shared/in-app-agent`（事件日志、replay、生命周期）、tRPC（`server/router.ts` 的 startRun/cancel/approve/snapshot/list/feedback）、ee（部分功能）。worker 依赖 `shared/in-app-agent`、`executeInAppAgentRun`、sandbox-runtime（HTTP 调 microvm）。sandbox-runtime 是独立进程，通过 HTTP `/sandbox` 通信。`InAppAgentRunQueue` 在 `packages/shared/src/server/queues.ts:86` 定义（精简 `{projectId, runId}` payload）。

## 扩展方式

**新增一个沙箱工具**（如 `list` 列目录）：
1. `contracts.ts`（sandbox-runtime）：`SandboxOperationSchema` 加 `list` discriminatedUnion + `ListSandboxOperation` type
2. `server.ts`（sandbox-runtime）：`routeRequest` POST /sandbox 分支加 `list` case + `listOperation` 实现
3. `sandbox/types.ts`：`SandboxSession`/`InAppAgentSandbox` 加 `list(params)` 接口
4. `sandbox/service.ts`：`createExecutionSandbox` 加 `list` 实现
5. `shared/server/tools.ts`：`IN_APP_AGENT_SANDBOX_TOOL_NAMES` Set 加 `"list"` + 注册 tool schema/description
6. 两个 sandbox provider（Docker / Lambda-MicroVM）的 `ensureSession` 返回的 `SandboxSession` 实现新接口

**新增一个消息派生**（如 summary 摘要视图）：
1. `ARCHITECTURE.md` 的 "One log, three derivations" 表加一行（producer/consumer/shape/never）
2. `persistence.ts` 加 `getConversationMessagesForSummary()`，从事件日志读 + `createConversationMessageAccumulator` 重建 + summary 变换
3. 定归属：仅浏览器用→放 `web/src/features/in-app-agent/lib/`；worker 也需→放 `packages/shared/in-app-agent/`
4. 如有损变换，必须在 ARCHITECTURE.md 声明 invariant（只在 render time 跑？不能喂 live agent？不能写回 server？）
5. 如需 pruning，优先复用 `dropUnpairedAssistantToolCalls`/`dropEmptyAssistantMessages`（`messages.ts`），或新增时按 `AgUiMessage` shape vs presentation 决定归属

> 改这模块前必读 `ARCHITECTURE.md` 和 `README.md` 原文——它们是契约，不是描述。尤其是"fold once"和"three derivations"表，违反它们会重现这 feature 已经踩过的坑。
