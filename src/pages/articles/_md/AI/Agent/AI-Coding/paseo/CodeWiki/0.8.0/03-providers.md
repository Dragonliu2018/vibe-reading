---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "Provider 适配层"
date: "2026-09-17T23:54:20+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "ACP", "Provider", "MCP"]
description: "paseo Provider 适配层——AgentClient/AgentSession 双接口契约、五家 agent 后端五种接入协议（Agent SDK/JSON-RPC/ACP/HTTP/自有 RPC）、ACP 通用适配器、capability 与 feature 双轨差异表达。"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/server/src/server/agent/providers/`（~100 文件，最大的一块）加 `provider-registry.ts`、`provider-runtime.ts`、`provider-launch-config.ts` 是 Paseo 的"万能转接头"：把 Claude Code、Codex、GitHub Copilot、OpenCode、Pi 五家协议互不相容的 coding agent 后端，收敛成一个统一契约。Paseo 的产品价值（"one interface for all agents"）一半建立在这层上——另一半在客户端。

它要解决的核心矛盾：**每家 agent 的进程模型、协议、能力面都不同**（SDK in-process / 子进程 JSON-RPC / stdio ACP / HTTP server / 自有 RPC），但 AgentManager 只想面向一个接口编程。

## 模块架构

```
agent-sdk-types.ts                     # 契约：AgentClient + AgentSession + capability flags
provider-registry.ts
├── AGENT_PROVIDER_DEFINITIONS          # protocol 包的 manifest（UI 元数据）
├── PROVIDER_CLIENT_FACTORIES（:196）   # 唯一注册点
└── buildProviderRegistry()（:867） + addDerivedProviders()（:755）
providers/
├── claude/agent.ts        ClaudeAgentClient     # @anthropic-ai/claude-agent-sdk in-process
├── codex-app-server-agent.ts（235KB）          # codex app-server 子进程 JSONL JSON-RPC
├── acp-agent.ts（123KB）  ACPAgentClient        # ACP over stdio（copilot/cursor/kimi/kiro/trae/…）
├── opencode-agent.ts（171KB）                  # opencode serve HTTP 子进程
├── pi/agent.ts            PiRpcAgentClient      # pi --mode rpc 自有 JSONL RPC
└── omp/（pi fork）
executable-resolution/                  # 本机 CLI 发现（which -a）
```

## 调用链路

**provider 解析与 spawn 链**（以 CLI `--provider codex/gpt-5.5` 为例）：

```
AgentManager.createAgent() in agent-manager.ts:1200
├─ requireAvailableClient()          # registry 查 provider + isAvailable() 探测
├─ buildLaunchContext()（:5105）      # env/cwd/MCP 配置（native provider 会剥掉 MCP 注入）
└─ client.createSession(providerLaunchConfig, launchContext, createOptions)
   └─ CodexAppServerAgentClient.createSession()
      ├─ resolveProviderLaunch() in provider-launch-config.ts   # command replace|append
      └─ spawn "codex app-server" 子进程
         └─ providers/codex/app-server-transport.ts 的 request/notify/setRequestHandler
            # JSONL 帧 JSON-RPC：initialize → turn/steer（codex-app-server-agent.ts:4273）
```

<details>
<summary>方法速查表</summary>

| 方法/接口 | 位置 | 职责 |
| --- | --- | --- |
| `AgentClient.createSession()` | `agent-sdk-types.ts:737` | 会话工厂（spawn 内化在各实现） |
| `AgentClient.resumeSession()` | `agent-sdk-types.ts:737` | 按持久化 handle 恢复会话 |
| `AgentClient.fetchCatalog()` | `agent-sdk-types.ts:737` | models+modes 合一次发现 |
| `AgentClient.isAvailable()` | `agent-sdk-types.ts:737` | 本机是否装了该 CLI |
| `AgentSession.run()/startTurn()` | `agent-sdk-types.ts:660` | turn 驱动 |
| `AgentSession.subscribe()` | `agent-sdk-types.ts:660` | 流事件订阅（→ AgentStreamEvent） |
| `AgentSession.respondToPermission()` | `agent-sdk-types.ts:660` | 权限回传（精确 optionId） |
| `AgentSession.steerActiveTurn()` | `agent-sdk-types.ts:660`（可选） | turn 中途插话，返回 `accepted\|unavailable` |
| `AgentSession.tryHandleOutOfBand()` | `agent-sdk-types.ts:660`（可选） | 旁路命令（如 `/goal pause`，不经 turn） |
| `PROVIDER_CLIENT_FACTORIES` | `provider-registry.ts:196` | 唯一注册点 |
| `findExecutable()` | `executable-resolution/executable-resolution.ts` | 非 Windows 用 `/usr/bin/which -a`；Windows 委托专用解析 |
| `resolveProviderLaunch()` | `provider-launch-config.ts` | command `replace\|append` 两模式 |

</details>

## 核心实现

### 契约：两个接口 + 双轨差异表达

契约定义在 `agent-sdk-types.ts`（不在 registry）：

- **`AgentClient`**（`:737`）：会话工厂与目录发现——必需 `createSession`/`resumeSession`/`fetchCatalog`/`isAvailable`，可选 `listImportableSessions`/`importSession`/`listCommands`/`listFeatures`/`shutdown` 等。**没有单独的 spawn/listModels 方法**——spawn 内化在各 provider，模型发现收敛到 `fetchCatalog`（一次探测同时拿 models 与 modes）。
- **`AgentSession`**（`:660`）：一次会话——必需 `run`/`startTurn`/`subscribe`/`streamHistory`/`getPendingPermissions`/`respondToPermission`/`describePersistence`/`interrupt`/`close`。

差异表达分两轨（这是本层最重要的设计）：**capability 是静态布尔**（`AgentCapabilityFlags` in `agent-sdk-types.ts:182`：`supportsStreaming`/`supportsSessionPersistence`/`supportsDynamicModes`/`supportsMcpServers`/`supportsReasoningStream`/`supportsToolInvocations`，可选 `supportsNativePaseoTools` 与三个 rewind 位）——"能不能做"；**feature 是动态 UI 控件**（`AgentFeatureToggle/Select`）——"当前条件下做得怎样"。例：`codex-feature-definitions.ts` 的 `buildCodexFeatures` 按模型白名单 `CODEX_FAST_MODE_SUPPORTED_MODELS` 决定 fast_mode 控件是否出现——capability 无法表达"仅 gpt-5.x 支持"，所以 feature 是模型相关的运行时声明。

为什么自定契约而不直接用现成 SDK？`agent-sdk-capabilities.md` 记录了选型调研：`@openai/codex-sdk` 缺 mode 枚举与动态 MCP，Claude SDK 无长驻 session 对象——所以 adapter 各自补 gap（如 Claude 需自己包装 `query()` 维持有状态 handle）。

### 五家后端五种协议

| Provider | 类 | 协议与启动 |
| --- | --- | --- |
| claude | `ClaudeAgentClient` in `providers/claude/agent.ts` | in-process 加载 `@anthropic-ai/claude-agent-sdk` 的 `query()` AsyncGenerator；`resolveBinary` 定位 `claude` CLI；resume 用 session id；`canUseTool` 回调桥接权限流 |
| codex | `CodexAppServerAgentClient` in `codex-app-server-agent.ts` | 子进程 `codex app-server`（`:7021`）+ JSONL 帧 JSON-RPC（`initialize`/`turn`/`steer`） |
| copilot/cursor/kimi/kiro/trae | 继承 `ACPAgentClient` in `acp-agent.ts` | ACP over stdio：copilot `["copilot","--acp"]`、cursor `["cursor-agent","acp"]`；kimi/kiro/trae 无固定 defaultCommand，靠用户 `extends:"acp"` override 提供 |
| opencode | `OpenCodeAgentClient` in `opencode-agent.ts` | 子进程 `opencode serve --port`（`providers/opencode/server-manager.ts:318`）HTTP API；daemon 注入内容寻址 plugin（`OPENCODE_CONFIG_CONTENT`）从 loopback bridge 读工具目录 |
| pi / omp | `PiRpcAgentClient` in `providers/pi/agent.ts` | 子进程 `pi --mode rpc`（`providers/pi/runtime.ts:122`）自有 JSONL RPC；系统提示经生成的 Pi extension（刻意不用 `--append-system-prompt`，它会覆盖 APPEND_SYSTEM.md 发现）；omp 是 pi 的 fork（`omp --mode rpc-ui`） |

### ACP 通用适配器：一份实现服务 N 家

`acp-agent.ts`（123KB）是本层的"杠杆点"：`ACPAgentClient`（`:868`）实现完整 `AgentClient`——spawn（`resolveProviderLaunch()` + defaultCommand）、stdio transport、`initialize` 握手（`initializeTransport()` in `acp-agent.ts:1382`）、`session/new` 生命周期、`fetchCatalog` 用一个 probe 进程同时拿 models/modes（`:1024-1158`，能力位决定能否列历史）。Session 层把 ACP `sessionUpdate` 通知 switch 映射到 Paseo timeline：

```
agent_message_chunk   → 文本流
agent_thought_chunk   → reasoning
tool_call/update      → tool call 行
plan                  → mapPlanToTimeline()（acp-agent.ts:3500）
user_message_chunk    → 用户回显
session/request_permission → AgentPermissionRequest（选项按序渲染，回传精确 optionId）
```

子类（copilot/cursor/kimi/kiro/trae/Gajae Code…）只需给 provider id、defaultCommand、modes、capabilities——**新 ACP provider 的边际成本是一个薄文件加一条 manifest**。

### 注册与发现

两层注册：`packages/protocol/src/provider-manifest.ts` 的 `AGENT_PROVIDER_DEFINITIONS`（claude/codex/copilot/opencode/pi/omp，含 UI 元数据 icon/colorTier 与 modes）+ `buildProviderRegistry()`（`provider-registry.ts:867`）遍历 manifest；`addDerivedProviders()`（`:755`）处理用户 override——`extends:"acp"` 走 `GenericACPAgentClient`，`extends:<builtin>` 派生（如 Z.AI 传承 claude；extends 缺失或指向未知 base 直接抛错，acp 派生必须给 command）。`PROVIDER_CLIENT_FACTORIES` 里查不到的 provider id 由 `getProviderClientFactory()` 直接抛 `No provider client factory registered for <provider>`——注册表 fail-fast 而非静默降级。

CLI 发现：`findExecutable()`（`executable-resolution/executable-resolution.ts`）。一个安全细节：`createProviderEnvSpec()`（`provider-launch-config.ts:233`）**刻意剥离 `CLAUDECODE` 等父会话环境变量**——防止 daemon 嵌套启动报错（你在 Claude Code 里跑 Paseo 再 spawn Claude Code 的场景）。

### fail-closed 权限契约

`PROVIDER_CONTRACTS`（`provider-registry.ts:158`）只给 claude/codex/opencode `supportsExactMcpPreapproval: true`；其余 provider 收到 toolPolicy 直接抛 `ToolPolicyUnsupportedError`（`:625`）——Hub 无人值守执行前，provider 必须先证明能精确放行单个 MCP 工具。宁可拒绝执行也不静默放行，这是无人值守场景的正确默认。

模型合并收在 registry：`wrapClientProvider()`/`mergeModels()`（`:380`）把 profile 的 models/additionalModels 与运行时目录统一合并，provider 实现不关心用户配置层。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂注册表 | `PROVIDER_CLIENT_FACTORIES` in `provider-registry.ts:196` | 单点注册，新增 provider 不改分发逻辑 |
| 模板方法 | `ACPAgentClient` in `acp-agent.ts:868` | 协议共性一份实现，子类只填差异 |
| capability/feature 双轨 | `agent-sdk-types.ts:182` + `codex-feature-definitions.ts` | 静态能力 vs 模型相关运行时控件，两种变化频率不同的差异 |
| 派生注册 | `addDerivedProviders()` in `provider-registry.ts:755` | 用户自定义 provider 无需写代码 |
| fail-closed 契约 | `PROVIDER_CONTRACTS` in `provider-registry.ts:158` | 无人值守权限必须显式证明 |

## 模块间交互

- 上游：AgentManager（02 篇）只面向 `AgentClient`/`AgentSession`；
- 下游：本层 spawn 的子进程即各家 agent CLI；
- 横向：OpenCode/OMP 走进程内 bridge 消费 04 篇的工具目录（`supportsNativePaseoTools`），其余经 MCP HTTP 端点；graphify 显示 `agent/providers → agent/core` 有 501 条 import 边（全图最高），适配层重度依赖 manager 提供的类型与上下文。

## 扩展方式

新增一个 provider（对照 `docs/providers.md` 的 ACP 检查单）：

1. 新建 `providers/{name}-agent.ts`（ACP provider 薄继承 `ACPAgentClient`）；
2. `packages/protocol/src/provider-manifest.ts` 加 `AGENT_PROVIDER_DEFINITIONS` 条目（含 modes 的 icon/colorTier）；
3. `provider-registry.ts` 的 `PROVIDER_CLIENT_FACTORIES` 加工厂；
4. `packages/app/src/components/provider-icons.ts` + 图标组件；
5. `daemon-e2e/agent-configs.ts` 加 E2E 配置与 `isProviderAvailable` 分支；
6. `npm run typecheck`。

已知的坑：ACP mode id 可能是 URI；manifest 与 agent class 的 mode 列表是两份需同步。

⚠️ 待核实：omp/pi 共享的 provider-neutral JSONL 子进程 transport 的具体共用代码位置；pi 的 steer RPC 消息 ID 关联细节。
