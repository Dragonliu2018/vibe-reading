---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "工具目录与 MCP"
date: "2026-09-17T23:55:30+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "MCP", "Plugin", "Agent 编排"]
description: "paseo 工具目录与 MCP 服务——transport-neutral 的 40 个基础工具（+10 个 browser_*）一份目录两条消费路径（MCP HTTP / 进程内 bridge）、esbuild 插件子进程运行时、SKILL.md 编排技能分发器。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/server/src/server/agent/tools/`、`agent/mcp-server.ts`、`paseo-tool-policy.ts`、`server/plugins/`、`orchestration-skills/` 合起来回答："**agent 怎么驱动 Paseo 自己**"。agent 编排 agent（创建子 agent、发 prompt、等结果、管 workspace、定 schedule）是 Paseo 区别于"只看输出的监控面板"的核心能力，而这层就是那组能力的统一出口。

关键定位：工具目录是 **transport-neutral** 的——同一份定义有两个消费路径（MCP HTTP 端点 + 进程内 bridge），工具代码不依赖任何传输类型。

## 模块架构

```
tools/paseo-tools.ts（~99KB 单文件）
└── createPaseoToolCatalog(options)         # 按 callerAgentId 实例化
    └── ~40 个工具，五组：agent 编排 / workspace / 调度 / provider 元信息 / 权限
tools/types.ts
└── PaseoToolDefinition（name/description/inputSchema(zod)/outputSchema/handler）
└── PaseoToolCatalog（getTool/executeTool）  # 零 MCP 依赖

消费路径 A：MCP HTTP
agent/mcp-server.ts（52 行）→ Express 路由 /mcp/agents
  StreamableHTTPServerTransport（无状态）+ Bearer agentMcpAuthToken

消费路径 B：进程内 bridge（provider-runtime.ts setPaseoToolCatalog）
  → OpenCode bridge.ts setManifestCatalog / OMP provider

plugins/    # esbuild 编译的插件子进程运行时
orchestration-skills/  # SKILL.md 分发器（6 个内置技能）
```

`mcp-parity.e2e.test.ts` 保证两条路径的工具面一致——这是 transport-neutral 不漂移的回归防线。

## 调用链路

**MCP 路径**（Claude/Codex 这类只能从自身配置发现 MCP server 的外部 CLI）：

```
bootstrap.ts:1439  挂 Express 路由 /mcp/agents
└─ createAgentMcpSession(callerAgentId)     # 按请求级 caller 创建
   ├─ createAgentMcpServer() in agent/mcp-server.ts
   │   └─ server.registerTool(name, {title, description, inputSchema}, handler)
   │       └─ toMcpToolResult()             # PaseoToolResult → MCP CallToolResult
   └─ StreamableHTTPServerTransport（sessionIdGenerator: undefined，无状态）
# agent 侧：runtime-mcp-config.ts withRuntimePaseoMcpServer()
#   在 agent-manager.ts prepareSessionConfig()（:5038）把
#   http://...?callerAgentId=<id> + Bearer 头注入 agent 的 mcpServers
#   stripInternalPaseoMcpServer() 防止该内部条目被持久化
```

**native 路径**（OpenCode/OMP 声明 `supportsNativePaseoTools: true`）：`provider-runtime.ts` 的 `setPaseoToolCatalog()` → `buildLaunchContext()`（`agent-manager.ts:5105`）直接进程内拿 catalog，并调 `resolveProviderLaunchConfig()` 剥掉 MCP 注入——无需 HTTP 往返。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
| --- | --- | --- |
| `createPaseoToolCatalog()` | `tools/paseo-tools.ts` | 按 callerAgentId 实例化 40 个基础工具，携带调用者上下文（cwd 继承） |
| `createAgentMcpServer()` | `agent/mcp-server.ts` | 目录 → MCP server（52 行薄适配） |
| `resolvePaseoToolPolicy()` | `paseo-tool-policy.ts` | 读 per-provider 的 `paseoTools: {enabled, disabledTools[]}` |
| `compilePlugin()` | `plugins/compiler.ts` | esbuild 双入口打包（server node 平台 / client neutral） |
| `createPluginDaemonTransportFactory()` | `plugins/daemon-transport.ts` | 子进程 IPC → DaemonTransportFactory 适配 |
| `createOrchestrationSkills()` | `orchestration-skills/index.ts` | 内置技能同步 + getStatus/reconcile/saveSelection |

</details>

## 核心实现

### 工具目录：40 个基础工具五组 + 浏览器工具

`createPaseoToolCatalog(options)` 按 `callerAgentId` 实例化（`PaseoToolCatalogFactory`），携带调用者上下文做 **cwd 继承**（`resolveScopedCwd`/`resolveChildAgentCwd`——子 agent 默认继承父的工作目录，除非显式指定 workspace）。`paseo-tools.ts` 内 40 个 `registerTool` 调用（含条件注册的 `speak`），另由 `registerBrowserTools()`（`server/browser-tools/tools.ts`）追加 10 个 `browser_*` 浏览器自动化工具。五组：

- **agent 编排**：`create_agent`、`send_agent_prompt`、`get_agent_status`、`list_agents`、`cancel/kill/archive/update_agent`、`get_agent_activity`、`set_agent_mode`；
- **workspace**：`create/list/rename/archive_workspace`、workspace scripts、terminal 六件套；
- **调度**：`create_schedule`、heartbeat、`*_schedule` 共 10 个；
- **provider 元信息**：`list_providers/models/profiles`、`inspect_provider`；
- **权限**：`list_pending_permissions`、`respond_to_permission`；外加语音 `speak`。

工具定义只依赖 zod 与内部 `PaseoToolResult`（content + structuredContent + isError），由 `tools/paseo-tool-serialization.ts` 的 `addModelVisibleStructuredContent()` 统一序列化——传输层各自适配。

### 工具策略

`paseo-tool-policy.ts`（29 行，刻意小）：`resolvePaseoToolPolicy()` 从 per-provider settings 取 `paseoTools: {enabled, disabledTools[]}`；`isPaseoToolEnabled()` 在注册时过滤——`enabled !== false` 且不在 `disabledTools`；`speak` 在策略层恒返回 true，但只在语音启用（`voiceOnly || enableVoiceTools`）时才注册进目录。对应 0.8.0 的 "per-provider controls for disabling all or selected Paseo tools"（#4277）。

### 插件系统：esbuild 子进程运行时

插件是 0.7→0.8 的大特性（自定义 provider、timeline 组件、header buttons、composer pills、lifecycle hooks）。结构：

- **manifest**：`paseo-plugin.json` = `{id, requirements: {paseo: ">=0.8.0"}, build?}`，严格 schema；
- **编译**：`compilePlugin()` in `plugins/compiler.ts` 用 esbuild 把 `index.server.ts`（platform node）与 `index.client.tsx`（neutral/es2020，external 化 react/zod/SDK）分别打包为 CJS 字符串；`createRuntimeBoundaryPlugin()` 强制 client/server/shared 目录边界（server-only 模块进不了 client bundle）、SDK specifier 白名单（`plugin-sdk-specifiers.ts`）、未知 `@getpaseo/plugin/*` 报错；`wrapCommonJsBundle` + `makeHermesInteropEager` 修 Hermes 惰性 getter bug；
- **执行**：`plugins/plugin-process.ts` 在子进程执行 server bundle；`PluginRuntime`（`plugins/runtime.ts`）管理 lifecycle hook（如 `agent.session_open` 可变换 env/MCP 配置）、provider 桥、RPC；
- **回连**：`daemon-transport.ts` 的 `createPluginDaemonTransportFactory(port)` 把子进程 IPC 消息（`paseo_frame`/`paseo_close`）适配成 `DaemonTransportFactory`——插件代码在子进程内也能调 daemon RPC。

信任模型直白：插件 unsandboxed，靠 `paseo plugin install` 显式动作建立信任（`docs/plugins.md`）。

### 编排技能：SKILL.md 分发器

`orchestration-skills/` 不是代码机制，是**提示词分发**：把仓库 `skills/` 下 6 个内置技能（`paseo`、`paseo-handoff`、`paseo-advisor`、`paseo-committee`、`paseo-help`、`paseo-plugin`）同步到 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`（`internal/paths.ts` 的 `resolveSkillTargets()`），让各 CLI agent 原生发现。`internal/controller.ts` 是 single writer（串行队列防并发写半状态），`transaction.ts` 保证删除可恢复。handoff/committee 等技能本体就是教 agent 调用上面那批工具的提示词——**技能是提示词层，工具是 API 层**，两层都不碰协议层。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 目录（catalog）模式 | `createPaseoToolCatalog()` in `tools/paseo-tools.ts` | 一份定义服务两种传输；parity 测试防漂移 |
| 请求级实例化 | `PaseoToolCatalogFactory`（按 callerAgentId） | 工具天然携带调用者身份与 cwd，权限不需要额外传递 |
| 进程隔离 | `plugins/plugin-process.ts` | 插件崩溃不倒 daemon |
| 适配器 | `daemon-transport.ts` | 插件子进程的 IPC → 统一 DaemonTransportFactory |
| single writer | `orchestration-skills/internal/controller.ts` | 文件同步操作串行化 |

## 模块间交互

- 上游：AgentManager 在 `prepareSessionConfig()` 决定给每个 agent session 注入 MCP 端点还是进程内 catalog；
- 下游：工具 handler 通过闭包直接拿 `agentManager`/`scheduleService` 等 daemon 依赖（`PaseoToolHostDependencies` in `tools/paseo-tools.ts:98`）；
- 横向：与 03 篇 provider 层的接点是 `supportsNativePaseoTools` capability 位。

## 扩展方式

**新增一个 agent 工具只需两处**：① `tools/paseo-tools.ts` 内 `registerTool("my_tool", {description, inputSchema}, handler)`（注册处已含 policy 过滤与 zod 解析）；② 需新宿主依赖时在 `PaseoToolHostDependencies`（`:98`）加字段并在 `bootstrap.ts` 的 `createAgentToolHostDependencies` 装配。MCP 路径与 native 路径自动生效，**无需改 mcp-server.ts**——目录模式的扩展收益。

⚠️ 待核实：OMP provider 的 native 注入细节（`providers/omp/agent.ts` 未深读）；`speak` 工具的 handler 与 tts-manager 的关系。
