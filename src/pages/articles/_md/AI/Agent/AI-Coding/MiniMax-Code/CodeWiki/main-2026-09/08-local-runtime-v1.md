---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "v1 主机设施与 IM 渠道"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "Feishu", "WeChat", "Telegram", "IM 渠道", "绞杀者"]
description: "local-runtime v1 解读（~15.3 万行）——LocalRuntimeApiHost 度 143 超级 Facade、channels 32k 行 IM 渠道桥（访问控制在 lane 队列之前、im-guard 收据）、三层 session 存储、legacy-opencode 迁移、经 compat/v1 类型借型被 V2 复用"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

`packages/local-runtime/`（~15.3 万行，621 文件）是 v1 时代留下的**主机设施库**。架构文档定调："V2 owns their execution and persistence"——v1 不再拥有执行权，只剩可复用设施（数据库、文件工具、权限引擎宿主、存储）+ 历史数据只读 reader。包入口 `src/index.ts` 刻意只暴露窄门面（`LocalRuntimeApiHost`、`listFileTree/searchFiles`、`SqliteLocal*Store`、`LocalQuestionnaireService` 等），不导出 channels 内部。它仍然独立成模块的原因：channels（3.2 万行 IM 渠道桥）是一个完整的协议适配域，且 v1 的 persistence/permissions 在 V2 落地前无可替代。

## 模块架构

![IM 入站链路](/vibe-reading/images/articles/minimax-code/channels-flow.svg)

30+ 子目录中四个是主体：`channels/`（IM 桥）、`api/`（`LocalRuntimeApiHost` 门面）、`persistence/`（三层 session 存储）、`permissions/`（权限引擎宿主）。核心对象：**`LocalRuntimeApiHost`**（api/host.ts:292，1842 行，degree 143）——构造函数即 composition root，依次装配 v2 layout 迁移、trash/rm-shim、三层 session store + `LiveSessionWriter`、`LocalSessionController`、`SqliteLocalCommunicationMessageStore`、`LocalPermissionRuleStore`、`LegacyOpencodeMigrator`、`wireHostChannelSubsystem()`（:961）等约 50 个子系统。它持有 `runtimeConversation?: RuntimeConversation`——由 v2 注入的执行入口，**未注入时 `requireRuntimeConversation()` 抛错**：v1 host 本身不能跑 turn。

## 调用链路

入站主流程（`handleInbound`，channels/infra.ts:1076）：

```
IM 平台消息（LocalChannelContext：platform/chatId/senderId/threadId）
→ parseLocalChannelSlashCommand（/new、/compact → control lane；普通消息 → interactive lane）
→ 访问控制（在 lane 队列之前！infra.ts:1194-1204 注释）
     重放事件不占队列槽 · 群消息 flood 不饿死 p2p DM · owner bootstrap 异步 IO 不被串行化
     preflightInbound 预检换一次性 token（WeakSet 校验+消费，防双重评估）
→ routeResolver.resolve(ctx)：(platform, chatId) → (agentName, sessionId)
     解析失败走 im-guard 收据（2026-09-04 产品决策注释 :1207-1216：binding 被删回人类可读回执而非 HTTP 500 黑洞）
→ options.enqueueMessage() → v2 conversation.ingress.submit/steer
→ 出站：LocalChannelRunner collector 聚合 committed messages
     → FeishuSender / LocalWeChatChannelClient（wechat.ts:316）/ Telegram SDK 投回原 threadId
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `beginHostedTurn/settleHostedTurn` in api/host.ts:1175-1199 | hosted turn 生命周期 | 执行权已归 V2 |
| `deleteSession()` in host.ts:1429 | 级联删除 | 清 channel binding/questionnaire/permission/thread-goal |
| `handleInbound()` in channels/infra.ts:1076 | 入站主流程 | 访问控制在队列之前 |
| `preflightInbound()` in infra.ts:984 | 预检 | 一次性 token 防双重评估 |
| `routeAgentIm()` in infra.ts:1277 | IM 路由 | im-guard 收据兜底 |
| `checkPermission()` in permissions/facade.ts:449 | 权限入口 | 包 applyAskGate 不变量 |
| `ensureMessagesMigrated()` in legacy-opencode-migrator.ts:554 | 历史迁移 | 懒触发 |

</details>

## 核心实现

### channels 是什么

**IM 消息渠道桥**（Feishu/Telegram/WeChat），不是机器人管理台。它本质是"设施 + 协议适配"：enqueue 之后的执行全在 V2 `RuntimeConversation`。`adapterRegistry` 注释（infra.ts:902-910）显示演进中的统一化——新平台走 adapter registry（`adapters/telegram/` 提供 inbound/status/bind/unbind 四条路由），老平台仍走遗留路由。出站侧 `outboundStore` 落盘重试、`laneQueue` 串行化、`eventDedupCache` 去重；回复锚定原 `threadId`（infra.ts:110-117 注释）。graphify 检出的 import 循环也集中于此子目录（infra.ts 与 runner/adapter/access-control 等互指，2-3 文件环居多）——协议适配层的典型耦合，是 v1 最可能被继续绞杀的部分。

### 权限宿主与 ask-gate 不变量

`LocalPermissionFacade`（facade.ts:411）构造时 `new PermissionEngine()` + `registerDefaultCheckers`（决策本体在 agent-modules，见[横切模块](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/07-agent-modules)）。它的增量价值是 `applyAskGate`：bypassPermissions 模式下"永不弹卡"的不变量在**单一入口点**强制，且模式在入口快照一次——防 PUT /config 中途翻转造成降级（:436-448 详细注释）。

### 三层 session 存储与 legacy 迁移

persistence 是 Ledger（追加事实）+ Snapshot（文件快照）+ Projection（SQLite 投影）三层，`LiveSessionWriter` 统一写入（host.ts:573-580）；`SqliteLocal*Store` 家族（sqlite-persistence.ts，7 个 store）覆盖 session/agent/message/queue/tokenUsage/turnDiff/communicationMessage。`LegacyOpencodeMigrator`（92.8k 行文件）仅在 `runtimeMode === "clean" && !runtimeConversation` 时构造，从 `dataDir/opencode/data|state/opencode` 读旧 opencode 会话（session.jsonl + 原生消息 part）转换为 Pi history（`convertNativeMessagesToPiHistory`）；`origin: 'user'` 的 session 永不 phantom-import（controller.ts:109 注释）。

### V2 如何复用 V1

全仓只有 local-runtime-v2（9 文件）和 tui（3 文件）import `@mavis/local-runtime`。核心是 `compat/v1/runtime.ts` 与 `compat/v1/agent-host.ts`——后者大量用 `ReturnType<LocalRuntimeApiHost["createHostedAgentCapabilities"]>` 这类**类型级借型**（type-level borrowing）把 v1 的 hosted-agent 能力（attachments/websiteDeploy/channel finalReplies）接到 v2 能力对象上；前者把 `listFileTree` 等直接包装为 v2 workspace capability（runtime.ts:694）。TUI 的 `embedded-host.ts:67` 明确 "requires the local-runtime-v2 front door; legacy fallback is disabled"——**无运行时回退**，v1 纯粹以库形式被 import。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Facade + 组合根 | `LocalRuntimeApiHost` 构造函数 | 50 个子系统的单点装配 |
| Port/Adapter + fail-closed | `agentRuntimePort ?? createFailClosedAgentRuntimePort()`（host.ts:486-487） | 未注入执行端口时失败而非静默空转 |
| 晚期绑定可变注入 | `accessControlDenyReply`（infra.ts:917-931）等 | 构造顺序约束下由 wire 层事后补挂，避免循环类型依赖 |
| 分层路由 | `files/api.ts:276 routeLocalFileApi` | 纯手写路由表（file/tree|info|content|…） |
| One-shot token | preflight WeakSet（infra.ts:1059-1062） | 防双重评估 |

## 模块间交互

被 v2 的 compat 层消费（见上）；向 agent-modules 供给 permission/skills 的进程级实现；`routeFileApi` 的 HTTP 前门不在此 source preview 中（调用者已排除）。cron/channel 能力仅 Electron 形态。

## 扩展方式

- **新增 IM channel（如企业微信）**：`src/channels/adapters/` 仿 `adapters/telegram/`（四条路由）实现 `LocalMultiChannelClient` 出站接口（参照 wechat.ts:316），在 `api/host-channels.ts` wire 层注册进 `channelBridgeInfra.adapterRegistry`，`wireHostChannelSubsystem()` 实例化。
- **新增 file API 路由**：`src/files/api.ts` 的 `routeFileApi()` 追加分支（:309 模式），复用 `resolveExistingWorkspacePath` 沙箱路径校验。
- **新增权限 checker**：`permissions/checkers.ts` 的 `registerDefaultCheckers` 注册（自动获得 askGate 与 plugin-hook 上下文管线）。
