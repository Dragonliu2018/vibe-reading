---
source:
  type: "源码解读"
  project: "vscode"
  url: "https://github.com/microsoft/vscode"
title: "AI Agent 系统"
date: "2026-08-18T15:19:54+08:00"
category: [Tools, IDE, VSCode, CodeWiki, "1.135.0"]
tags: ["vscode", "Agent", "Sessions", "MCP", "BYOK", "Copilot"]
description: "VS Code 1.135 AI Agent 系统——Agents Window 会话模型、Agent Host、changeset/checkpoint、MCP 与 BYOK"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/00-overview)

---

## 模块定位

1.135.0 版本最显著的变化是 **AI Agent 成为主线**。VS Code 在 `vs/workbench` 之上新建了 `vs/sessions` 层（约 20.6 万行，"Agents Window"），配合 `vs/platform/agentHost`（约 33 万行）、`vs/platform/chat`、`vs/platform/mcp`，把 VS Code 从编辑器扩展为承载自治编码 agent 的运行时。本模块覆盖这四个子系统的协作——会话/provider 模型、Agent Host 执行循环、changeset/checkpoint 可追溯机制、MCP 工具集成与 BYOK 模型接入。`LAYERS.md` 用 ESLint 规则把 `sessions` 固化为 `workbench` 之上的新顶层，`workbench` 不允许反向 import `sessions`。

## 模块架构

```
┌──────────────────────────────────────────────────────────────┐
│ Sessions 层 (vs/sessions) — Agents Window                    │
│  Entry: sessions.common.main.ts / .desktop / .web            │
│  ┌────────────┐ ┌──────────────┐ ┌────────────────────────┐ │
│  │ contrib/*  │ │ contrib/     │ │ services/*             │ │
│  │ (chat,     │ │ providers/   │ │ (sessionsManagement,   │ │
│  │  sessions, │ │ (agentHost,  │ │  sessionsProviders,    │ │
│  │  changes)  │ │  copilot,    │ │  sessionsService)      │ │
│  └────────────┘ │  remote)     │ └────────────────────────┘ │
│                 └──────────────┘                             │
└───────────┬──────────────────┬───────────────────────────────┘
            │ ISessionsProvider 契约
            ▼
┌──────────────────────────────────────────────────────────────┐
│ Platform 层 (vs/platform)                                    │
│  ┌─────────────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ agentHost/      │  │ chat/    │  │ mcp/               │  │
│  │  IAgent         │  │  chat    │  │  JSONRPCMessage    │  │
│  │  changeset      │  │  service │  │  TransportType     │  │
│  │  checkpoint     │  │          │  │  (STDIO/HTTP/SSE)  │  │
│  │  byokLm         │  │          │  │                    │  │
│  └─────────────────┘  └──────────┘  └────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

sessions 层四层组织（`LAYERS.md`）：Entry Points → `contrib/*` + `contrib/providers/*` + `services/*` → `sessions/~` core（browser/common/electron-browser）。三层服务分工（`SESSIONS.md`）：`ISessionsProvidersService`（provider 注册表）、`ISessionsManagementService`（模型编排，路由 send/model/archive 到 owning provider）、`ISessionsService`（视图服务，拥有 active session、焦点）。

## 调用链路

用户消息到 UI 更新的核心数据流：

```
user submits
 → ISessionsManagementService.sendRequest(session, chat, options)
    → request routes to session.providerId
    → provider.sendRequest(sessionId, chatResource, options)
       → IAgent 执行循环
          ├─ 发射 AgentSignal (action | pending_confirmation | subagent_*)
          │    → onDidChatProgress → host state manager 分发
          │    → SessionPermissionManager.getAutoApproval 决定是否需用户确认
          ├─ 修改文件
          │    → IAgentHostChangesetService 计算 <session>/changeset/{uncommitted,session,turn/<id>} diff
          │    → IAgentHostCheckpointService.captureTurnCheckpoint  git commit-tree 建快照
          └─ 会话 observable 更新 (IObservable)
       → lifecycle notifications fire
    → ISessionsService 跟随 committed session 切换视图
```

<details>
<summary>核心接口速查表</summary>

| 接口 | 文件 | 关键设计 |
|------|------|----------|
| `IAgent` | `platform/agentHost/common/agent.ts` | `onDidChatProgress: Event<AgentSignal>`，`materializeChat`，`getOrCreateActiveClient` |
| `ISession` / `IChat` | `sessions/services/sessions/common/session.ts` | provider 中立 facade，`IObservable` 暴露状态 |
| `ISessionsProvider` | `sessions/services/sessions/common/sessionsProvider.ts` | `createNewSession` `sendRequest` `forkChat` `createSideChat` |
| `IAgentHostChangesetService` | `platform/agentHost/common/agentHostChangesetService.ts` | `registerStaticChangesets` `computeListEntryChanges` |
| `IAgentHostCheckpointService` | `platform/agentHost/common/agentHostCheckpointService.ts` | `captureTurnCheckpoint` `getTurnCheckpointPair` |
| `IAgentHostByokLmHandler` | `platform/agentHost/common/agentHostByokLm.ts` | `chat(request, token)` 纯 JSON 桥接 |
| `ILocalMcpServer` | `platform/mcp/common/mcpManagement.ts` | `TransportType` STDIO/STREAMABLE_HTTP/SSE |

</details>

## 核心实现

### Agents Window 架构与 provider 契约

`sessions` 是 `workbench` 之上的新顶层。会话模型（`SESSIONS.md`）的核心是 provider 中立——UI 和 shared services 只依赖 `ISession`/`IChat`/`ISessionsProvider`，**不写 provider-ID 分支**。

```typescript title="src/vs/sessions/services/sessions/common/sessionsProvider.ts"
export interface ISessionsProvider {
  readonly id: string; readonly label: string; readonly icon: ThemeIcon;
  readonly sessionTypes: readonly ISessionType[];
  readonly onDidChangeSessions: Event<ISessionChangeEvent>;
  createNewSession(workspaceUri, sessionTypeId, options?): ISession;
  createQuickChat(sessionTypeId): ISession;
  sendRequest(sessionId, chatResource, options: ISendRequestOptions): Promise<ISession>;
  setModel(sessionId, chatResource, modelId, source: ChatModelSource): void;
  forkChat(sessionId, sourceChat, turnId): Promise<IChat>;
  createSideChat(sessionId, sourceChat, turnId, selection?): Promise<IChat>;
}
```

三种 provider（`contrib/providers/`）：`copilotChatSessions`（Copilot Chat 后端）、`agentHost`（Agent Host，Claude/Codex 本地自治编码）、`remoteAgentHost`（远程 Agent Host，session type 格式 `remote-{authority}-{provider}`，见 `agentHostSessionType.ts`）。**抽象 provider 的原因**：同一会话模型承载不同 agent 后端。capability gate（`supportsMultipleChats`/`supportsQuickChats`）替代 provider 判断。`SessionStatus`（`Untitled`/`InProgress`/`NeedsInput`/`Completed`/`Error`）和 `ChatInteractivity`（`Full`/`ReadOnly`/`Hidden`）支持 agent-team 模式——lead chat 交互式，worker chat 只读/隐藏。

布局（`LAYOUT.md`）：Titlebar | Sidebar | Sessions Part（内部 `SerializableGrid`，1+ SessionView）| Editor（隐藏）| Auxiliary Bar（Changes view）。每个 `SessionView` 内含 `ChatGroupsView`（grid of ChatGroupView），支持拖拽 split。移动端（`MOBILE.md`）`MobileSessionsPart` 强制单 session 视图。

### Agent Host 执行循环与信号驱动

`IAgent` 是每个 agent backend 实现的接口。执行循环通过 `AgentSignal` 流式信号驱动——agent 发射 `action` 信号（携带 protocol `SessionAction`），host 通过 state manager 分发；`pending_confirmation` 信号触发 host 的 auto-approval 逻辑（`SessionPermissionManager.getAutoApproval`），决定是否需要用户确认。信号联合类型：`action | pending_confirmation | subagent_started | subagent_resumed | subagent_completed | steering_consumed`。agent 通过 `onDidChatProgress` 发射，host 分发到 state manager——这是 agent 执行与 UI 更新的解耦点。

### Changeset 与 Checkpoint：可追溯与可回滚

agent 对文件的修改需要可追溯、可回滚。`IAgentHostChangesetService` 追踪修改，`IAgentHostCheckpointService` 做 per-turn git 快照。

```typescript title="src/vs/platform/agentHost/common/agentHostCheckpointService.ts"
export function buildCheckpointRefName(sanitizedSessionId, turnNumber): string {
  return `refs/agents/${sanitizedSessionId}/checkpoints/turn/${turnNumber}`;
}
export interface IAgentHostCheckpointService {
  captureBaselineCheckpoint(sessionUri, workingDirs): Promise<void>;   // turn/0
  captureTurnStartCheckpoint(sessionUri, chatUri, turnId, workingDirs): Promise<void>;
  captureTurnCheckpoint(sessionUri, chatUri, turnId, workingDirs): Promise<void>;
  getTurnCheckpointPair(sessionUri, turnId, workingDir?): Promise<{parent, current} | undefined>;
  deleteCheckpoints(sessionUri, workingDirs?): Promise<void>;
}
```

checkpoint 用 git `commit-tree` + temp-index 技巧创建 parentless/parent-chained commit，锚定在 `refs/agents/<sid>/checkpoints/turn/<N>` ref 命名空间下——**不出现为 branch/tag**，不污染用户仓库的分支列表。每个 turn 开始前 `captureTurnStartCheckpoint`，完成后 `captureTurnCheckpoint`（chained to turn-start），changeset service 用 `getTurnCheckpointPair` 的 `{parent, current}` ref 走 git-diff fast path。baseline（turn/0）在 session 创建时捕获，session 删除时 `deleteCheckpoints` 清理所有 ref。

changeset 两种静态类型：`branch`（分支 vs base 的 diff）和 `session`（session 全生命周期修改），per-turn changeset 按 turn ID 索引。`IAgentHostChangesetService` 注册 `<session>/changeset/{uncommitted,session,turn/<id>}` URI，运行 git-driven 和 edit-tracker-driven diff 计算，debounce mid-turn recompute，persist 到 session DB。

### BYOK：用户自带模型密钥

```typescript title="src/vs/platform/agentHost/common/agentHostByokLm.ts"
export interface IByokLmChatRequest {
  readonly vendor: string; readonly modelId: string;
  readonly input: IByokLmInputItem[]; readonly tools?: IByokLmTool[];
}
export interface IAgentHostByokLmHandler {
  readonly onDidChangeModels?: Event<void>;
  chat(request: IByokLmChatRequest, token?): Promise<IByokLmChatResult>;
}
```

node agent host 运行 OpenAI-compatible proxy，renderer 通过 `ILanguageModelsService`（VS Code LM API）桥接。renderer 侧 extension 注册的 LM 模型通过 `IByokLmModelInfo` 枚举到 node 侧，无需 host 侧配置。wire-friendly 纯 JSON 设计，同时支持本地 utility-process IPC 和远程 JSON-RPC——`onDidChangeModels` 驱动 model picker 刷新。**为什么这样设计**：renderer 保留 extension LM API 所有权（扩展生态不破坏），node 侧无配置依赖，桥接协议极简。

### MCP 集成

`src/vs/platform/mcp/common/modelContextProtocol.ts` 是 MCP JSON-RPC 2.0 协议的完整 TypeScript 类型定义（`LATEST_PROTOCOL_VERSION = "2025-11-25"`，从 MCP spec repo 同步）。`mcpManagement.ts` 定义 `ILocalMcpServer`、`TransportType`（`STDIO`/`STREAMABLE_HTTP`/`SSE`）、`RegistryType`（npm/pypi/docker/nuget/mcpb/remote）。

agent 调用 MCP 工具路径：`IAgent.startMcpServer(session, id)` 启动受控 MCP server → `IAgent.handleMcpRequest(chat, serverName, method, params)` 路由 MCP 请求 → `IAgent.onMcpNotification` 接收 `IMcpNotification`（`{channel, method, params}`）并 fan-out 到对应 App。MCP server 也可作为 Customization 暴露给 agent（`AI_CUSTOMIZATIONS.md` 的 MCP servers section）。

### 分层与边界

`LAYERS.md` 的 import 规则（ESLint `local/code-import-patterns` 强制）：

- `sessions/~` core 可 import `vs/workbench/~`，不可 import `contrib/*`
- `sessions/services/*/~` 可 import `vs/workbench/contrib/*/~`，不可 import `contrib/providers/*`
- `sessions/contrib/*/~` 不可 import `contrib/providers/*`（**关键约束**）
- `sessions/contrib/providers/*/~` 最宽松，可 import sibling providers

**sessions 独立成顶层的原因**：解耦（agent 工作流与标准编辑器工作流独立演进）；移动端（`MOBILE.md` 强制单 session 视图）；独立布局（`LAYOUT.md` fixed part positions，不支持 settings 自定义）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 会话/Provider 分离 | `sessionsProvider.ts` `ISessionsProvider` | 多后端统一模型，shared code 不写 provider-ID 分支，capability gate 替代判断 |
| Changeset/Checkpoint | `agentHostChangesetService.ts` `agentHostCheckpointService.ts` | agent 修改可追溯（changeset diff）与可回滚（per-turn git ref 快照） |
| git ref 命名空间隔离 | `buildCheckpointRefName` `refs/agents/<sid>/checkpoints/turn/<N>` | 快照不污染用户分支列表，session 删除即清理 |
| BYOK 纯 JSON 桥接 | `agentHostByokLm.ts` `IByokLmChatRequest` | renderer 保留 extension LM API 所有权，node 侧无配置，双传输兼容 |
| 信号驱动执行 | `IAgent.onDidChatProgress: Event<AgentSignal>` | agent 执行与 UI 更新解耦，流式信号分发到 state manager |
| 顶层独立 + ESLint 强制 | `LAYERS.md` `local/code-import-patterns` | sessions 与 workbench 解耦独立演进，import 规则静态强制边界 |
| Customization 分层 | `AI_CUSTOMIZATIONS.md` agents/skills/instructions/prompts/hooks/MCP | 跨 workspace/user/extension 三层存储 agent 定制 |

## 模块间交互

sessions 层可 import `vs/workbench` 和下层，`workbench` 不可 import `sessions`。`agentHost`/`chat`/`mcp` 在 platform 层，被 sessions 的 provider 消费。agent 通过 `IAgentHostByokLmHandler` 反向调用 renderer 的 `ILanguageModelsService`（extension 注册的 LM 模型）。MCP server 经 `IAgent.startMcpServer` 启动，`handleMcpRequest` 路由。`AI_CUSTOMIZATIONS.md` 描述六类定制（agents/skills/instructions/prompts/hooks/MCP servers）跨 workspace/user/extension 三层存储。

## 扩展方式

**新增 session provider**：实现 `ISessionsProvider`（`contrib/providers/<name>/browser/`），适配后端状态到 `ISession`/`IChat` facade，从 `sessions.*.main.ts` 注册。参考 `SESSIONS.md` "Adding or changing a provider" 7 步清单：声明 sessionType → 实现 provider → 注册到 `ISessionsProvidersService` → 处理 `onDidChangeSessions` → 实现 sendRequest/forkChat → capability gate → 从 main.ts import 加载。

**给 agent 加 MCP 工具**：在 `ILocalMcpServer` 配置注册 server（`mcpManagement.ts`），agent 经 `IAgent.startMcpServer` 启动、`handleMcpRequest` 路由。MCP server 也可作为 Customization 在管理编辑器配置。

**定制 agent 行为**：通过 `IAgent.getChatCustomizations(chat, context, hostCustomizations)` 返回 `Customization[]`。`AI_CUSTOMIZATIONS.md` 的六类定制（agents/skills/instructions/prompts/hooks/MCP servers）跨 workspace/user/extension 三层存储，`IAgentHostByokLmHandler.onDidChangeModels` 驱动 model picker 刷新。
