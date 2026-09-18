---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "应用编排层"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "CliService", "组合根", "绞杀者模式"]
description: "local-runtime-v2 的 local/ + application/ 解读——CliService 为进程内无 RPC 门面（~90 个一方法一用例），runtime.ts 启动仍以 V1 宿主为外壳经 compat/v1 绞杀式装配 V2 RuntimeApplications，services.ts createRuntimeServices 是 ~30 依赖的组合根"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

本模块是 `local-runtime-v2` 的上半部：`src/local/`（CliService 门面）、`src/application/`（用例编排）、`src/compat/`（V1 适配）与根文件 `runtime.ts` / `services.ts` / `background-runtime.ts`，合计约 2.4 万行。它回答一个问题：**当 TUI 和 runtime 同进程时，"API 层"应该长什么样？** 答案是没有 API——`cli-service.ts:106` 类注释原话："In-process CLI entry point: call local Application directly, without HTTP or RPC envelopes"。这一层承担的是 protocol wire 类型（`@mavis/protocol/local` 枚举）与 application 领域类型之间的转换边界（`toQuestionnaireRequestView`、`toPermissionDecision` 等纯函数），以及 host 契约（promptMode、getRunawayGuardConfig 等进程本地选项）的隔离。

## 模块架构

![runtime 装配链](/vibe-reading/images/articles/minimax-code/runtime-assembly.svg)

内部三层：`local/CliService` 是平铺门面（约 90 个方法，一方法一用例，构造只收 `applications: RuntimeApplications + application: LocalRuntimeApplication + conversation: ConversationApplication`）；`application/` 是用例层——`initializeApplications()` 装配七个命名 Application（session 的 query/content/lifecycle/root/diff/conversationMutation 六个 + queue），注释明言 *"Constructs named feature applications without adding an aggregate forwarding facade"*；`RuntimeApplications` 之外还有一个 `LocalRuntimeApplication`（process-local-application-contract.ts:86）——**全 optional 字段的可拚装能力目录**（events/usage/skills/plugins/miniApps/goals/mcp/permissions/workspace/models…），Embedding 形态按需注入，degree 51 的高引用即源于此契约被全层消费。

## 调用链路

启动装配链（`createLocalRuntimeHostV2Internal`，runtime.ts）：

```
layout 迁移 → DatabaseClient + initializeDatabase          runtime.ts:183-192
→ createRuntimeAgentComposition → agentRuntimePort.bindResolver   :208-228（晚期绑定）
→ createLocalRuntimeHostV1(configuredOptions)               :254（V1 外壳，compat 注入 + deferChannelStartup）
→ initializeOwnerRuntime                                     :806
    → createBackgroundRuntime（Scheduler/EventBus/RuntimeOwnerIdentity/forkWorktree）
    → createRuntimeServices                                  services.ts:395（组合根）
        resolveCompatibility → browser/sandbox/inspector/safety/prompt
        → createProductionSessionComposition（model-system + sessionSystem + pin）
        → initializeRuntimeServiceOwners（mcp → plugin → miniApp → plan → turnSystem → cron）
        → initializeSessionApplications（:1137 → initializeApplications）
        → createRuntimeUserApplications → composeProcessLocalApplication
→ createCliService(ownerRuntime.services)                    :298
→ 返回 CreatedLocalRuntimeHost { cliService, application }   host-contract.ts:72
```

请求流：TUI `createEmbeddedRuntimeHost`（强制 `runtimeOwnerKind:'tui'`、禁 legacy 回退）→ `TuiRuntimeAdapter` 持 `cliService` → `CliService.sendMessage` → `ConversationApplication.sendMessage`（gate → attachment 物化 → directSend → `TurnService.submit`）→ turn-system。反向事件 `CliService.watchEvents` → `application.events.watch` → EventBus。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `CliService.sendMessage()` in local/cli-service.ts:282 | 流式对话入口 | 直接调 `conversation.sendMessage` 返回 AsyncIterable |
| `CliService.watchEvents()` in local/cli-service.ts:474 | 全局事件订阅 | GlobalEvent AsyncGenerator 适配 |
| `initializeApplications()` in application/initialize.ts:74 | 装配七个命名 Application | 拒绝聚合转发门面，防再造 god object |
| `createRuntimeServices()` in services.ts:395 | 服务组合根 | 纯手工装配 ~30 依赖，无 DI 容器 |
| `createLocalRuntimeHostV2()` in runtime.ts:73 | 进程宿主工厂 | V1 外壳 + V2 服务晚期绑定 |
| `requireCapability()` in local/cli-service.ts:869 | 可选能力延迟判空 | 缺省抛可读错误而非启动失败 |
| `createSharedClose()` in runtime.ts:917 | 单次 close | 防重复关闭竞态 |

</details>

## 核心实现

### application 与 service 的职责切分

application 层是用例编排：Req/Resp 契约、错误映射（`AppError`/turnAdmissionError）、事件投影、指标。`QueueApplication` + `QueueCommittedEventProjector`（queue-application.ts:57）是典型——队列 CRUD 之外把中性 committed facts 投影为 `session.queue.updated` GlobalEvent（best-effort，失败吞异常）。service 层持有状态、repository、turn 引擎。这条切分线让 CliService 保持平结构：新增一个查询只是 query-application 加方法 + CliService 加委托，不会增殖门面。

### 绞杀者装配与晚期绑定

`runtime.ts:254` 仍调用 V1 的 `createLocalRuntimeHostV1` 作为**进程外壳**（apiHost、managedWorktrees、questionnaire 实现来自 V1），V2 通过 `compat/v1/runtime.ts` 的 `createV1RuntimeCompatibility` 把 V1 能力适配成 service 输入；反向地，`local/agent-runtime-port.ts:30` 的 `createV2AgentRuntimeManagementPort` 把 V2 AgentApplication 桥回 V1 的管理端口——保证 "HTTP controller 仍是唯一 wire-mapping 边界"（内部形态）。`deferChannelStartup`（runtime.ts:773）把 channel 启动点交给 V2 的 `startChannelSubsystemAfterOwnerAgentDefinitions`，使渠道失败不拖垮核心 readiness。两阶段初始化（`DeferredLocalAgentRuntimePort`/`DeferredRuntimeConversation`）支撑 "V1 外壳先建、V2 服务后到" 的装配顺序。

### compat/ 兼容什么

V1 宿主仍在跑：compat/v1 适配 V1 的 diff 能力（`LegacyTurnDiffCapability`）、questionnaire、channel、cron 清理、plugin 配置、prompt-config。`isV2RuntimeOwner`（runtime.ts:526）决定是否走 V2 owner 路径。另有 `createRuntimeOwnerCompromiseGuard`（runtime.ts:456）：owner 租约被侵时自动 close，防双写者。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Facade + 能力门 | CliService + `requireCapability` | 可选能力缺省时给可读错误 |
| Ports & Adapters | `ConversationMutationPort` / `DirectSendDelivery` / `ForkWorktreePort` / `AgentSessionPorts` | application 依赖 `Pick<窄接口>` 而非整个 service |
| 两阶段初始化（Deferred binding） | runtime.ts:228 / services.ts:407 | 装配顺序约束下的晚期绑定 |
| 绞杀者模式 | compat/v1 整层 + V1 外壳 | 渐进重写而非大爆炸 |
| Best-effort 事件投影 | `SessionRootEventProjector`、`QueueCommittedEventProjector` | 投影失败不阻塞主流程 |

## 模块间交互

向下依赖 service-system 全家（session/turn/agent/model/plugin/mcp/cron/sandbox/browser-use/plan/pin/canvas/content-safety/channel-system/workspace）与 infra（db/event-bus/scheduler/runtime-owner/git）。向上被 tui 以子路径导出 `@mavis/local-runtime-v2/cli-service`、`/process-local` 消费。与 V1 的关系：全仓只有本模块（9 文件）和 tui（3 文件）import `@mavis/local-runtime`。可移植性约束：cron/channel 仅 Electron（`ownsElectronRuntimeCapabilities`，services.ts:492）。

## 扩展方式

- **新增 CLI 操作**（如新 session 查询）：`application/session/query-application.ts` 加方法 → `CliService` 加委托（模式同 `getSessionUsage`）；涉及新能力则扩 `LocalRuntimeApplication` + `composeProcessLocalApplication` + `requireCapability` 消费。
- **新增 application 流程**：service 层加状态口 → `conversation-mutation-workflow.ts` 的 `createProductionConversationMutationWorkflow`（services.ts:1179 装配点）加分支 → 对应 Application 暴露 → CliService 转发。
- **新增 TUI 可见事件**：service 投影 fact → 对应 Projector 的 `publishBestEffort` 发 GlobalEvent → TUI 经 `watchEvents` 订阅，无需改 CliService。
