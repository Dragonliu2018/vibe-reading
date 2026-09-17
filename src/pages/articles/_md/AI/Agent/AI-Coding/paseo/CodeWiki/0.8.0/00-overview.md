---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "Overview"
date: "2026-09-18T00:10:00+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "AI Agent", "客户端-服务端", "Expo"]
description: "Paseo 是 Claude Code / Codex / Copilot / OpenCode / Pi 五家 coding agent 的统一监控与操控客户端：本机 daemon 管理 agent 进程并经 WebSocket 流式推送，移动/CLI/桌面三端一个界面，local-first 可选 E2EE 中继。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.8.0（tag `v0.8.0`，commit `b8e24677e`，2026-09-10）· **协议** Apache-2.0 · **语言** TypeScript（npm workspaces monorepo，11 个包）· **代码量** ~110 万行（server 与 app 各 ~40 万，含测试）· **仓库** [GitHub](https://github.com/getpaseo/paseo)

---

## 总览

### 项目简介

Paseo 自称 "One interface for Claude Code, Codex, Copilot, OpenCode, and Pi agents"——一个**本地 AI coding agent 的运行、监控与操控环境**。它解决的问题是：当你同时跑着多家 agent CLI，每个占一个终端窗口时，你既看不全它们在干什么（哪个在等你回答权限？哪个跑完了？），也没法离开电脑（SSH 断了全断）。Paseo 的答案是 client-server：

- **daemon 常驻本机**，spawn 并管理全部 agent 进程（你的代码不出机器，local-first）；agent 事件流式汇入统一 timeline 模型
- **三端一个界面**：Expo App（iOS/Android/Web）、Docker 风格 CLI（`paseo run/ls/attach/send`）、Electron 桌面端——全部说同一套 WebSocket 协议
- **agent 也能驱动 Paseo**：40 个编排工具（另加 10 个 browser_* 浏览器工具）经 MCP 或进程内 bridge 暴露给 agent（创建子 agent、互相 prompt、管 workspace），配套 6 个 SKILL.md 编排技能
- **远程访问不牺牲隐私**：可选的零知识 E2EE 中继（Curve25519 + NaCl box），或直连 TCP/Tailscale/SSH 隧道

**项目边界**：Paseo 不实现任何 LLM 推理也不包装模型 API——它只管理各家的 agent CLI 进程并搬运它们的事件流；对话历史、工具执行全归 agent 自己（provider session 是 timeline 真源）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 统一 agent 管理 | `server/agent/agent-manager.ts` | 生命周期状态机 + timeline 追踪 + 订阅广播 |
| 五家 provider 适配 | `server/agent/providers/` | claude（Agent SDK）/ codex（app-server RPC）/ ACP / opencode（HTTP）/ pi |
| 实时流式输出 | `agent-stream-coalescer.ts` + app `agent-stream/` | daemon 60ms 合批 + 客户端 rAF 攒批 + paced reveal |
| 权限交互流 | `agent/permission-response.ts` | `agent_permission_request/resolved` 往返，provider 侧 pending Promise 阻塞 |
| workspace 隔离 | `server/worktree-core.ts` | local / worktree 两种隔离，PR checkout 三种意图 |
| Forge 集成 | `services/github-service.ts` 等 | PR 状态/检查/auto-merge，GitHub/Gitea/GitLab（含 Forgejo/Codeberg） |
| 终端 | `terminal/terminal.ts` | node-pty + headless xterm.js，worker 进程隔离 |
| 文件浏览/编辑 | `server/file-explorer/service.ts` | 乐观并发读写 + git 感知 rename |
| E2EE 远程 | `relay/encrypted-channel.ts` | 零知识中继，QR 配对公钥走 URL fragment |
| agent 编排工具 | `agent/tools/paseo-tools.ts` | 40 工具（+10 browser_*）：子 agent/workspace/schedule/权限，MCP + native 双路径 |
| 插件系统 | `server/plugins/` | esbuild 编译 client/server 双 bundle，子进程执行 |
| 语音 | `server/speech/`、`stt-manager.ts`、`tts-manager.ts` | 听写与朗读（`speak` 工具） |
| Hub（可选） | `server/hub/` | daemon 出站连接云端触发器 |
| TypeScript SDK | `packages/client/` | `client.agents.create()` / `waitForFinish()` |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| TypeScript（全 strict，禁 any） | 核心 | 全仓库语言，zod `z.infer` 推导类型 |
| Node.js + Express + ws | 核心 | daemon 的 HTTP（web UI/MCP 端点）+ WebSocket 服务 |
| zod + zod-aot | 核心 | 协议 schema 单一真源 + 出站消息 AOT 校验（Hermes 性能） |
| Expo / React Native | 核心 | 三端客户端（iOS/Android/Web，Desktop 复用 web export） |
| Electron | 核心 | 桌面壳 + 托管 daemon 子进程 + 内置浏览器 |
| commander | 核心 | CLI 命令面 |
| node-pty + xterm.js | 核心 | PTY 与终端仿真（snapshot 保真） |
| tweetnacl | 核心 | relay 的 Curve25519 + XSalsa20-Poly1305 |
| zustand + React Query | app | 双轨状态（UI 会话态 / 可重取服务端态） |
| esbuild | server | 插件编译器（运行时边界强制） |
| vitest + Playwright + Maestro | 测试 | 单测/集成/E2E 分层 |
| Biome / oxlint / lefthook | 工具链 | 格式化与 lint |

### 版本历史

Paseo 迭代极快——从 0.1 到 0.8 不到两个月（2026-07 中旬首版，0.8.0 于 2026-09-10 发布）：

- **0.2.x–0.4.0**（2026-07/08）：基础形态成型，workspace/调度/权限逐步引入
- **0.5.0–0.6.x**（2026-08 下旬）：Hub、移动端完善
- **0.7.0**（2026-08-31）：**许可证改为 Apache-2.0**；插件系统落地（Git 仓库安装、timeline 转换渲染、composer pill）；SSH 连接远程 daemon
- **0.8.0**（2026-09-10，本次解读版本）：插件 header buttons 与自定义 provider（独立 icon/设置/权限/timeline 渲染）、插件 client/server 入口分离（含迁移指南）、per-provider 工具开关、Codex 异步问答 answer forms；桌面端最低 macOS 13

## 快速上手

```bash
npm install -g @getpaseo/cli
paseo          # 首次运行引导：本地启动 + 询问是否启用 E2EE relay 配对
```

端到端验证（需要本机装有任一支持的 agent CLI，如 claude）：

```bash
paseo run --provider claude/opus-4.6 "implement user authentication"
# 前台阻塞到 turn 结束；另一终端：
paseo ls                # 列出运行中的 agent
paseo attach abc123     # 流式跟随输出
```

Docker 自托管（daemon + web UI）：`docker run -d -p 6767:6767 -e PASEO_PASSWORD=... ghcr.io/getpaseo/paseo:latest`。

开发模式：仓库根 `npm run dev`（tmux 里同时起 daemon 与 Expo）；`npm run build:server` 构建 server 栈。

## 架构设计解析

### 系统架构

Paseo 的架构思想可以一句话概括：**"本地 daemon 是唯一的真源，所有客户端都是等价的消费者"**。之所以这样设计，是因为它要同时满足三个看似冲突的目标——代码留在本机（local-first）、从任何设备访问（移动/桌面/CLI）、agent 间可编程编排（工具目录）。把 agent 进程的所有权、事件流的汇聚点、权限的判定点全部收敛到 daemon，客户端就退化成纯视图 + 输入端，三端共用一套协议（`@getpaseo/protocol`），新增一种客户端不触碰核心。

![Paseo 系统分层](/vibe-reading/images/articles/paseo-codewiki-0.8.0/architecture.svg)

五层自上而下：**客户端层**四种形态（App/CLI/Desktop/SDK）全部经**传输层**的三条通道（直连 WS / E2EE relay / SSH 隧道）连到 **Daemon 层**——daemon 内部再分六个职责块（会话与 RPC、Agent 生命周期、Provider 适配、工具目录与 MCP、终端、Forge 与工作区）。daemon 向下 spawn **Agent 进程层**（五家 agent CLI 子进程，协议各异），并向**持久层**做原子 JSON 写。两条灰字注释标出两个易误解点：生产 relay 是独立的 Elixir 服务；Hub 是 daemon 主动出站的可选关系。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 客户端层 | `packages/app`、`packages/cli`、`packages/desktop`、`packages/client` | 把 daemon 的状态变成人能看的界面与脚本能调的 API；三端等价，无特权客户端 |
| 传输层 | `packages/relay`、protocol 的 binary-frames | 承载同一消息集的三条通道；E2EE 保证中继零知识 |
| Daemon 层 | `packages/server/src/server/` | 系统唯一真源：会话/生命周期/工具/终端/forge 的所有权与判定点 |
| Agent 进程层 | 各家 agent CLI（daemon spawn） | 真正干活的推理与工具执行；Paseo 不介入其内部 |
| 持久层 | `$PASEO_HOME/`（agents JSON、keypair、pid） | 无迁移的文件持久化；timeline 真源在 provider session，磁盘只存身份 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 组合根 + 构造器注入 | `createPaseoDaemon()` in `bootstrap.ts:568` | 40+ 依赖无全局单例，测试与 Hub 复用整套装配 |
| 工厂注册表 + 模板方法 | `PROVIDER_CLIENT_FACTORIES` + `ACPAgentClient` | 五家 provider 一份契约；ACP 一份实现服务 N 家 |
| 目录（catalog）模式 | `createPaseoToolCatalog()` in `tools/paseo-tools.ts` | 一份工具定义服务 MCP 与 native 两条传输，parity 测试防漂移 |
| 开放注册表 + 开放信封 | `ForgeRegistry` + protocol `forgeSpecific` | 新 forge 零分支接入，新 facts 老客户端中性降级 |
| capability gate + COMPAT 治理 | `server_info` features + 292 处 `// COMPAT` 注释 | 新旧版本任意组合共存，清理有截止日期 |
| 状态机 + token 防伪结算 | `AgentRunState` in `agent-run-state.ts` | 异步竞态下旧回调作废 |
| worker 进程隔离 | `terminal-worker-process.ts` | xterm 解析/snapshot 序列化不阻塞主事件循环 |
| AOT 代码生成 | `generate-validation-aot.mjs`（含编译器补丁） | 移动端入站校验 10.9ms → 2.5ms |
| 引用计数订阅聚合 | `ConnectionSubscriptions` in `client/connection/` | UI 生命周期抖动不传导到 daemon |
| 物理逻辑会话分离 | `Session.sockets: Set` | 慢连接硬切不误伤用户，多 tab/多通道共享状态 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| Agent | 一个被管理的 agent 实例（身份+记录） | 建档 → live/closed → archived | 持 workspaceId、parentAgentId、timeline |
| Timeline | per-agent 事件历史（rows + epoch/seq） | 随 agent；真源在 provider session | canonical rows → projection 只读派生 |
| Workspace | 执行环境的持久记录（`wks_` id） | 创建 → 活跃 → 归档 | cwd/worktreeRoot 双目录；agent 归属的唯一来源 |
| Session | 逻辑客户端会话（principalId + clientId 键） | hello 建立，断线 resume | 挂多个物理 socket（多 tab/relay 并存） |
| Principal / Grant | daemon 权限主体与授权 | 持久（credential 可轮换） | Hub 非 owner 访问的授权基础 |
| ProviderCatalog | 某 provider 的 models + modes | 探测缓存 | registry 与用户 profile 合并 |
| PaseoToolDefinition | 一个 agent 可用工具 | 注册期实例化 | 按 callerAgentId 携带 cwd 上下文 |
| PluginManifest | 插件声明（`paseo-plugin.json`） | 安装期 | requirements 版本门 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `AgentClient` / `AgentSession` | `agent-sdk-types.ts:737/:660` | ClaudeAgentClient、CodexAppServerAgentClient、ACPAgentClient（+5 子类）、OpenCodeAgentClient、PiRpcAgentClient | `PROVIDER_CLIENT_FACTORIES` |
| `ForgeService` | `services/forge-service.ts` | github / gitea（forgejo、codeberg 复用） | `defaultForgeRegistry` |
| `DaemonTransport` | `client/daemon-client-transport-types.ts:8` | 直连 WS、relay E2EE 包装、插件 IPC 适配 | `config.transportFactory` |
| `TerminalManager` | `terminal/terminal-manager.ts` | in-process（测试）、worker（生产） | `createConfiguredTerminalManager()` |
| `PaseoToolCatalog` | `agent/tools/types.ts` | 单实现，MCP/native 双消费 | `PaseoToolCatalogFactory` |
| `Transport`（relay） | `relay/types.ts` | Node ws 适配、Cloudflare DO（legacy） | channel 构造注入 |

## 代码目录

```
paseo/（npm workspaces monorepo）
├── packages/
│   ├── server/          # daemon：agent 生命周期、WS API、MCP、终端、forge（~40.7 万行）
│   │   └── src/server/  # agent/（providers+tools）、session/、plugins/、hub/、terminal…
│   ├── app/             # Expo 三端客户端 + desktop renderer（~39.1 万行）
│   ├── cli/             # Docker 风格 CLI（~3 万行）
│   ├── protocol/        # zod schema 单一真源 + zod-aot（~2.5 万行）
│   ├── client/          # @getpaseo/client SDK（~1.8 万行）
│   ├── desktop/         # Electron 壳（~2.7 万行）
│   ├── relay/           # E2EE 协议库（~3.3k 行）
│   ├── plugin/          # 插件 SDK 类型（~5.3k 行）
│   ├── highlight/       # 语法高亮（~3k 行）
│   ├── website/         # paseo.sh 营销站（TanStack Router + CF Workers）
│   └── expo-two-way-audio/ # Expo 原生音频模块
├── docs/                # ★ 系统级文档（架构/生命周期/数据模型/协议/性能…60+ 篇）
├── skills/              # 6 个内置编排技能（SKILL.md）
└── paseo.json           # worktree setup 与开发服务定义
```

`docs/` 值得单独一提：CLAUDE.md 明言 "the docs" 指这里而非网络——架构、agent 生命周期、数据模型、协议兼容、终端/流式性能、每类 UI 模式的坑都有专文，是本仓库最宝贵的导读材料（本系列多处直接引用）。

## 模块地图

![Paseo 包依赖](/vibe-reading/images/articles/paseo-codewiki-0.8.0/module-dependencies.svg)

依赖方向自上而下：三端客户端（青）依赖共享 SDK 引擎 client（浅蓝）与 daemon；protocol（黄条）是全底座——app/cli/server/plugin/desktop 均直接依赖（图中箭头省略部分）；relay（粉）只被 client 与 server 消费。graphify 对 server 包建的 AST 图（14,914 节点 / 37,352 条边）显示内部扇入最高的对象是 `AgentStreamEvent`（291 边）、`Session`（275）、`AgentManager`（266）——事件流、会话、生命周期管理是 server 的三大引力中心。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Daemon 核心与会话 | 装配、WS 服务、hello 握手、RPC 分发、背压 | `createPaseoDaemon()` | 接客层与 agent 逻辑分离，慢连接不拖垮核心 | [01](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/01-daemon-core) |
| Agent 生命周期与时间线 | 状态机、持久化、timeline、coalescing | `AgentManager` | 身份/runtime/timeline 三概念正交 | [02](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/02-agent-lifecycle) |
| Provider 适配层 | 五家 agent 后端的统一契约 | `PROVIDER_CLIENT_FACTORIES` | 协议差异必须被一层吸收 | [03](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/03-providers) |
| 工具目录与 MCP | agent 驱动 Paseo 的 40+10 个工具 + 插件 | `createPaseoToolCatalog()` | transport-neutral，一份定义两条消费路径 | [04](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/04-tools-mcp) |
| 协议与校验 | 消息 schema、AOT 校验、兼容契约 | `messages.ts` | 五方共享的单一真源，演进成本集中于此 | [05](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/05-protocol) |
| 客户端 SDK | 连接/重连/RPC 等待/订阅聚合 | `createPaseoClient()` | 对外产品与对内引擎合一层 | [06](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/06-client-sdk) |
| CLI | 命令面、daemon 管理、SSH 隧道 | `runCli()` | 脚本化与桌面 launcher 双形态 | [07](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/07-cli) |
| Relay 端到端加密 | 零知识中继的密码学与握手 | `createClientChannel()` | 密码学独立于传输与业务 | [08](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/08-relay-e2ee) |
| 终端子系统 | PTY、worker 隔离、shell 集成 | `createConfiguredTerminalManager()` | 性能与崩溃隔离的独立进程边界 | [09](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/09-terminal) |
| App 客户端 | 三端 UI、状态、流式渲染管线 | `host-runtime.ts` | 39 万行的展示层自成一体 | [10](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/10-app) |
| Forge 与工作区 | GitHub/Gitea/GitLab、worktree、文件观察 | `ForgeRegistry` | "理解代码仓库"是与 agent 管理正交的领域 | [11](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/11-forge-workspace) |
| Desktop 桌面端 | Electron 壳、托管 daemon、内置浏览器 | `runDesktopStartup()` | OS 集成与 agent 逻辑分离 | [12](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/12-desktop) |

## 运行时行为

### 启动流程

```
createPaseoDaemon() in server/bootstrap.ts:568
├── express + mountWebUi()                       # self-host web UI + /mcp/agents
├── createHTTPServer()（:847）
├── script proxy upgrade handler（:853）          # 必须先于 WS server 注册
├── AgentStorage（:859）→ workspace registries（:951）→ AgentManager（:922）
├── httpServer.listen
├── VoiceAssistantWebSocketServer(40+ 依赖, startPaused: true)（:1651）
├── pluginRuntime.start() → beginAcceptingConnections()（:1723）
├── createRelayRuntime()（:1724）→ hubRelationships.start()
└── speech 延后到 listen 之后（:1763）             # 防 Sherpa native 加载阻塞接客
```

对象装配全走构造器注入（无全局单例）。配置优先级：环境变量（`PASEO_HOME`/`PASEO_LISTEN` 等）> `$PASEO_HOME` 下的 config.json > 内置默认（6767 端口）。daemon 密码设置后全局中间件生效（MCP agent 端点凭 capability token 豁免）。stop() 逆序冻结：`prepareForShutdown()` → closeAllAgents → storage flush → relay stop → 强制收尾。

### 核心运行流程

#### 任务执行：`paseo run` 主链路

业务流程：客户端发起 → SDK 连接握手 → daemon 建 agent → spawn provider → prompt 注入 → 流式事件回传 → 客户端渲染。

![端到端数据流](/vibe-reading/images/articles/paseo-codewiki-0.8.0/data-flow.svg)

左列下行：`runRunCommand()`（`cli/src/commands/agent/run.ts`）解析 provider/workspace → `DaemonClient.createAgent()`（`daemon-client.ts:2549`）发 `create_agent_request` → `handleCreateAgentRequest()`（`session.ts:3571`）→ `AgentManager.createAgent()`（`agent-manager.ts:1200`）建档并 spawn provider session（claude 走 `claudeQuery()` 包装 Agent SDK 的 `query()`）。右列上行：SDK 消息泵（`startQueryPump()`）逐事件 yield → `handleStreamEvent()` 经 60ms coalescer 合批 → timeline append（epoch/seq）→ `agent_stream` 广播 → 客户端三级分发 → rAF 攒批 + paced reveal 渲染。CLI 前台则走 `wait_for_finish_request` RPC 等终态（`status: idle|permission|error|timeout`）。

#### 交互：权限往返

业务流程：agent 请求工具许可 → daemon 广播 → 客户端决策 → 回传 → provider 继续。

Claude 的 `handlePermissionRequest`（`providers/claude/agent.ts:4624`，SDK `canUseTool` 回调）构造 `AgentPermissionRequest` 并**返回 pending Promise 阻塞 provider**；AgentManager 存入 `agent.pendingPermissions` 并触发 `broadcastAgentAttention(agent, "permission")`（推送通知计划由 `computeNotificationPlan` 决定）；客户端决策走 `agent_permission_response` → `respondToAgentPermission()`（`agent/permission-response.ts`）→ `AgentManager.respondToPermission()`（`:2906`）resolve 那个 Promise。取消 turn 时 `rejectAllPendingPermissions` 统一 deny——provider 永远等到答案，不会悬挂。

#### 恢复：断线重连与 timeline catch-up

业务流程：连接断开 → 指数退避重连 → resume 逻辑会话 → timeline 增量补齐。

`scheduleReconnect()`（`daemon-client.ts:6098`）清 waiters、挂起发送队列；`armReconnectTimer()` 以 `min(1.5s × 2^n, 30s)` 退避。重连后 hello 携带同一 `clientId`，daemon 按 `(principalId, clientId)` 键 `resumeSession()`——新物理 socket 加入既有 Session 的 sockets 集合，capability 从 hello rehydrate。timeline 补齐靠游标：客户端持 `timelineCursor`（epoch + seq），epoch 不匹配 → `fetchReset` 全量重拉，seq 断层 → gap reset；`ConnectionSubscriptions.restore()` 自动重建 daemon 侧订阅。慢到 64 MiB 缓冲上限的物理 socket 被硬切（只切那一条连接），重连后照常 catch-up。

### 状态流

![Agent 生命周期状态流](/vibe-reading/images/articles/paseo-codewiki-0.8.0/state-flow.svg)

live 态四值（`initializing → idle → running → idle/error`）定义在 protocol 的 `AGENT_LIFECYCLE_STATUSES`，转移在 `finalizeForegroundTurn()`（`agent-manager.ts:2533`）结算；`closed` 与 `archived` 是持久记录态的两个正交维度——`closeAgentRuntime()` 只释放 provider 进程（保留身份/timeline/labels），`archiveAgent()` 才是软删除（置 `archivedAt` + 级联子 agent + 调 provider 原生 archive hook）。`ensureAgentLoaded()`（`agent-loading.ts:62`）是 closed → live 的恢复入口（resume 持久 session + provider 历史回放）；`unarchive` 是唯一回到交互态的路径（先跑 provider 原生 unarchive，如 Codex `thread/unarchive`）。状态字面化原则：父 agent 不因子 agent 运行而变 running，workspace 聚合态另行计算。`autoArchive` 模式下首个终态 turn 后自动归档（含隔离 workspace）。

## 典型修改场景

#### 场景 1：新增一个 agent provider

`providers/{name}-agent.ts`（ACP 薄继承 `ACPAgentClient`）→ `protocol/src/provider-manifest.ts` 加 `AGENT_PROVIDER_DEFINITIONS` 条目 → `provider-registry.ts` 的 `PROVIDER_CLIENT_FACTORIES` 加工厂 → app 的 `provider-icons.ts` + 图标 → `daemon-e2e/agent-configs.ts`。详见 [03 篇](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/03-providers)。

#### 场景 2：新增一个 session RPC

`protocol/src/messages.ts` 定义 schema（点分名 + requestId + payload）→ `session/<domain>/` 分发器加分支 → 需要 gating 时 `buildServerInfoStatusPayload()` 加 feature + COMPAT 注释 → client SDK 加方法。bootstrap 与背压路径不动。详见 [01](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/01-daemon-core)/[05 篇](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/05-protocol)。

#### 场景 3：新增一家 Git forge

`services/acme-service.ts` 实现 `ForgeService` + `acme-facts.ts` + `defaultForgeRegistry` 一条 entry（可选 protocol `forge-manifest.ts` 加云主机）→ app 侧 `git/forges/acme.ts` + `acme.view.tsx` 双模块注册。禁止协议 typed-union arm 与中心 map。详见 [11 篇](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/11-forge-workspace)。

#### 场景 4：新增一个 agent 可用工具

只需 `tools/paseo-tools.ts` 的 `registerTool()` + 需要时 `PaseoToolHostDependencies` 加依赖——MCP 与 native 路径自动生效。详见 [04 篇](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/04-tools-mcp)。

## 测试体系

```
测试组织（以 server 包为例，vitest）
├── collocated：thing.test.ts 与实现同目录（无独立 tests/ 树）
├── 分层：test:unit / test:integration(:real/:local) / test:e2e(:all)
├── daemon-e2e/：进程内隔离 daemon 测试 harness（ad-hoc-daemon-testing.md）
├── .real.e2e.test.ts：真实 API 集成（真实 claude/codex 进程）
└── app：Playwright（web）+ Maestro（移动）+ capture-harness（真实 Electron 截图）
```

| 代码层 | 测试类型 |
| --- | --- |
| AgentManager / AgentStorage | collocated unit（`agent-manager.test.ts`） |
| Provider 适配 | `.e2e` / `.real.e2e`（真实 agent 进程） |
| WebSocket 协议 | `wire-compat.test.ts` + protocol `tests/validation/`（编译器补丁回归） |
| CLI | `cli-surface.test.ts` 命令面快照 |
| App | Playwright / Maestro / browser-capture-harness |

想理解某个类，优先读它的 collocated 测试（`docs/testing.md` 的 TDD 工作流意味着测试就是可执行文档）。修改场景的测试标注见各模块篇。

## 阅读源码推荐路线

- 第一遍：理解 daemon 主流程
  `server/bootstrap.ts` 的 `createPaseoDaemon()`（启动顺序）→ `websocket-server.ts` 的 `handleHello()`/`resumeSession()` → `session.ts` 的 `dispatchInboundMessage()` 责任链 → `agent-manager.ts` 的 `streamAgent()` 一条 turn 的完整链
- 第二遍：理解协议与数据模型
  `protocol/src/messages.ts` 的 envelope 结构（7,228 行，读骨架）→ `docs/data-model.md` + `agent-storage.ts`（$PASEO_HOME 布局）→ `agent-timeline-store.ts` 的 epoch/seq 游标模型
- 第三遍：理解 provider 差异
  `agent-sdk-types.ts`（双接口契约）→ `providers/acp-agent.ts` 的 `initializeTransport()` 与 sessionUpdate switch（一份实现看懂 N 家）→ `providers/claude/query.ts`（in-process SDK 的对照样本）→ `docs/providers.md`
- 第四遍：选择重点子系统深入
  客户端读 `client/src/daemon-client.ts` 的 `attemptConnect()`/`deliverSessionMessage()`，再进 app 的 `contexts/session-context.tsx` → `timeline/session-stream-reducers.ts` → `agent-stream/text-reveal.ts`（两级平滑）；或读 `relay/src/encrypted-channel.ts`（E2EE 握手）与 `terminal/terminal-worker-process.ts`（worker 隔离）；配套 `docs/` 对应专文（agent-lifecycle / protocol-compatibility / terminal-performance）

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| daemon | 常驻本机的 Node.js 服务（`@getpaseo/server`），agent 进程与状态的唯一所有者 |
| provider | 一家 agent 后端的适配器（claude/codex/copilot/opencode/pi/omp） |
| ACP | Agent Client Protocol，stdio JSON-RPC 的 agent 通信协议（Copilot/Cursor/Kimi/Kiro/Trae 用） |
| workspace | Paseo 的执行环境单元（local 目录或 worktree），`wks_` opaque id，agent 归属的唯一来源 |
| timeline | per-agent 的事件历史；canonical rows 在内存，真源是 provider session |
| epoch / seq | timeline 的代与序号：epoch 变更全量重拉，seq 断层 gap reset |
| principal / grant | daemon 权限模型：持久身份与授权，credential 可轮换 |
| COMPAT | 带截止日期的兼容 shim 注释（全仓库 292 处），构成清理 backlog |
| facts | forge adapter 私有的结构化事实（如 `GitHubPullRequestStatusFacts`），协议侧开放信封传输 |
| Hub | 可选的云端触发器关系，daemon 主动出站连接，不走 relay |
| subagents track | agent 面板底部的子 agent 面板（Paseo 子 agent 与 provider 原生子 agent 两类） |

### 参考资料

- [paseo.sh](https://paseo.sh)（官网与文档站）· [getpaseo/paseo](https://github.com/getpaseo/paseo) · [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay)（生产 Elixir relay）
- 仓库 `docs/`：`architecture.md`（系统设计）、`agent-lifecycle.md`（状态与归档语义）、`data-model.md`（持久化模型）、`protocol-compatibility.md` / `protocol-validation.md`（协议演进与 AOT）、`terminal-performance.md` / `agent-stream-performance.md`（性能规范）、`providers.md` / `forge-providers.md` / `plugins.md`（扩展指南）、`SECURITY.md`（威胁模型）
- ACP：[Agent Client Protocol](https://agentclientprotocol.com)；MCP：[Model Context Protocol](https://modelcontextprotocol.io)
