---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "Overview"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "Agent Harness", "TUI", "ACP", "插件系统", "沙箱"]
description: "MiniMax Code（mcode）main-2026-09 源码解读——MiniMax 开源的终端 coding agent（TS pnpm monorepo ~66 万行），三入口 TUI/headless/ACP 汇合于进程内 CliService，turn 队列+租约执行系统，vendored pi-mono agent loop + anthropic sandbox-runtime，插件快照/MiniApp 世代租约/IM 渠道桥/oauth lease broker"
readingTime: "55 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** main-2026-09（对应 0.4.12 source preview）· **解读基线** commit [`17b8ded`](https://github.com/MiniMax-AI/minimax-code/commit/17b8ded9c16da54224c2a05e54185cbee4f15021)（2026-09-18，默认分支快照，无 release tag）· **协议** MIT（第三方 pi-mono MIT / sandbox-runtime Apache-2.0）· **语言** TypeScript（Node ≥ 22.19）· **代码量** ~66 万行 TS（packages/ 2488 文件）· **仓库** [GitHub](https://github.com/MiniMax-AI/minimax-code)

---

## 总览

### 项目简介

MiniMax Code（命令名 `mcode`）是 MiniMax 于 2026-09-18 开源的**终端 coding agent**：在终端里理解项目、改代码、跑测试，支持 MiniMax 账号（Token Plan）或 BYOK 自定义模型，同一工作流里还带搜索、插件、多模态工具。它与 Claude Code / OpenCode 同属 "terminal coding agent" 这个品类，但架构上有自己的鲜明选择——**无 HTTP 服务的进程内单体**：TUI、headless、ACP 三种前端全部与 runtime 同进程，靠 `CliService` 直接函数调用（AsyncGenerator 流式）而非 RPC 通信。

几个值得先建立的整体认知：

- **它是"内部 monorepo 的公开投影"**：仓库不是普通的开发工作区，而是从内部 monorepo 经 `release/public-source.json` 文件清单逐文件审出的快照（`AGENTS.md` 明言 "this repository is the reviewed public projection of an internal monorepo"）。每加一个文件都要更新清单，移动/重命名文件有同步成本。
- **执行栈大量复用开源基础设施**：agent loop 来自 vendored 的 [pi-mono](https://github.com/earendil-works/pi-mono)（Mario Zechner 的 pi coding agent v0.79.1，MIT），沙箱来自 fork 的 [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) v0.0.74（Apache-2.0）——但两者都带着自己的补丁台账（`MINIMAX_CHANGES.md`、`LOCAL_CHANGES.md`），可以不经上游发版就修运行时缺陷。
- **v1/v2 绞杀者并存**：`local-runtime`（v1，~15.3 万行）仍是进程外壳与 IM 渠道属主，`local-runtime-v2`（~23 万行）拥有 turn 执行与持久化，两者以 `compat/v1` 适配层共存于同一进程、共用同一 SQLite 文件。
- **项目边界**：仓库包含 TUI、headless CLI、ACP 实现与发布工具链；**不包含**内部生成 IDL、Desktop HTTP 前门、cloud-executor 专属实现。IM 渠道 / cron 等 Electron 形态能力在 CLI 嵌入形态中被省略。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| 交互 TUI | `packages/tui/src/tui/` | 自研终端渲染引擎（pi-tui 0.84.2 vendored fork），regular/fullscreen 双模式 |
| headless exec | `packages/tui/src/headless/` | `mcode exec` 单次提示执行，CI/脚本/评测 |
| ACP | `packages/tui/src/acp/` | Agent Client Protocol，编辑器接入（`@agentclientprotocol/sdk`） |
| 多模型 | `packages/local-runtime-v2/src/service/model-system/` | MiniMax 托管 / minimax_api BYOK / custom_provider / Codex OAuth 四路 |
| 权限系统 | `packages/agent-modules/permission/` | bash AST 解析 + fs 路径能力 + ask 弹窗 + 云端分类器 |
| 沙箱执行 | `third_party/sandbox-runtime` + `service/sandbox/` | macOS seatbelt / SRT，fork 自 Anthropic 实验沙箱 |
| 插件系统 | `service/plugin-system/` + `agent-modules/plugin-hooks/` | 官方/GitHub/本地三来源，快照原子生效，兼容 CLAUDE/CODEX manifest |
| MiniApp | `service/miniapp/` | 插件包内的 Node 子进程，世代/租约管理 |
| 技能 Skills | `agent-modules/skills/` | 五级来源优先级，20k 字符目录注入 system prompt |
| MCP | `service/mcp/` + `agent-modules/mcp/` | 连接池 + 项目级 `.mcp` 配置，工具名 `mcp__server__tool` 规整 |
| cloud 工具 | `packages/agent-tools/src/cloud/` | Matrix 网关 18 个工具（图像生成/搜索等），lease token 鉴权 |
| browser 工具 | `packages/browser-core/` | CDPHelper 三源快照（DOMSnapshot + DOM + AXTree） |
| IM 渠道 | `packages/local-runtime/src/channels/` | Feishu / Telegram / WeChat 消息桥（Electron 形态） |
| 会话持久化 | `service/session-system/` + `infra/` | SQLite（drizzle）+ canonical history JSONL 脱敏落盘 |
| OAuth 登录 | `packages/oauth-core/` | RFC 8628 设备码流 + PKCE，双 region 命名空间 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| TypeScript / Node ≥ 22.19 | 核心 | 全仓语言与运行时 |
| pnpm 9.12 workspace | 核心 | monorepo 组织（28 个 workspace 包） |
| esbuild | 核心 | 单文件 standalone 打包（`scripts/build.mjs`） |
| better-sqlite3 + drizzle-orm | 核心 | 持久化（同步 API，WAL 模式） |
| commander | 核心 | CLI 子命令组装 |
| `@agentclientprotocol/sdk` | 核心 | ACP 协议接入 |
| handlebars | 核心 | agent system prompt 模板（`.md.hbs`） |
| croner | 核心 | cron 调度 |
| hono / undici / ws | 可选 | 局部 HTTP 与网络 |
| `@earendil-works/pi-*`（vendored） | 核心 | agent loop / provider 协议 / 本地工具 |
| sandbox-runtime（vendored fork） | 核心 | seatbelt 沙箱 |

### 版本历史

仓库 2026-09-18 才完成首次源码导入（import commit `c59cf537`），当前为 0.4.12 source preview——一个很年轻的开源基线。版本号语义上，"published npm 包 0.4.12" 与 "本源码树构建出 0.4.12" 是两条独立路径，`docs/open-source-status.md` 明确说明版本号一致不能证明构建来源一致。本解读以 commit `17b8ded` 为基线。

---

## 快速上手

从源码跑起来（阅读者视角的最短路径）：

```bash
git clone https://github.com/MiniMax-AI/minimax-code.git
cd minimax-code
pnpm install --frozen-lockfile   # 首次需联网（含 integrity 校验的 mcode-tools bundle）
pnpm build                        # esbuild 打包到 dist/cli.js
pnpm mcode                        # 启动（登录：pnpm mcode login，或 BYOK 设 MCODE_PROVIDER_API_KEY）
```

端到端验证——用官方示例项目复现 demo 任务：

```bash
cd examples/clamp
node /absolute/path/to/minimax-code/dist/cli.js
# 输入：Read clamp.mjs and clamp.test.mjs. Run node --test to reproduce
# the failure, fix clamp without changing the tests, then run the tests again.
# 预期：agent 读文件 → 跑测试看到失败 → 修改 clamp.mjs → 重跑测试通过
```

三入口速查：`mcode [prompt]`（交互 TUI）、`mcode exec [prompt]`（headless）、`mcode acp`（编辑器 ACP 接入）；`mcode --continue` 恢复最近会话，`mcode --session` 打开会话选择器。

---

## 架构设计解析

### 系统架构

mcode 的架构主线一句话：**`TUI / exec / ACP → CliService → local Applications → Session / Turn / Agent services → Pi / model providers / local tools`**（这是 `docs/architecture.md` 的原话）。它的核心设计决策是**进程内单体、无 RPC**——既然 CLI 场景里前端和 runtime 天然同进程，就不引入 HTTP/SSE 服务的序列化与鉴权开销，全部用函数调用 + AsyncGenerator 流。

![分层架构](/vibe-reading/images/articles/minimax-code/architecture.svg)

从上到下：前端层的三个入口在 `createTuiRuntime` → `TuiRuntimeAdapter`（包住 `CliService`）处汇合，仅 `surface` 参数不同（能力门控：headless 关闭弹卡能力，headless/ACP 均启用 quarantined 启动策略——ACP 保留弹卡能力经协议映射到编辑器确认）；应用编排层把请求翻译为用例；领域服务层是 V2 的主体（turn 执行、会话持久化、模型解析、插件）；agent 基础设施层的 `PiTurnRunner` 是零 IO 适配层，把 V2 的 turn 语义翻译进 pi 的 Agent loop；最底层是 vendored 的 pi-mono（模型协议）与 sandbox-runtime（沙箱），以及被"绞杀"降级为设施库的 v1 `local-runtime`。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 前端层 | `packages/tui/`（cli/ tui/ headless/ acp/） | 隔离终端交互形态，三种 surface 复用同一 runtime，防前端逻辑泄漏进领域层 |
| 进程内门面 | `local-runtime-v2/src/local/` + `application/` | protocol wire 类型与领域类型的转换边界；无 HTTP/RPC envelope 的用例编排 |
| 领域服务层 | `local-runtime-v2/src/service/`（21 个子系统） | 持有状态与执行引擎，V2 独占 turn 执行与持久化的单写者边界 |
| Agent 基础设施 | `packages/agent-core/` + `agent-runtime/` + `agent-extension/` | 防腐层隔离 vendored pi-mono 类型，让上层不感知上游 API 变化 |
| 第三方与 v1 设施 | `third_party/` + `packages/local-runtime/` | 可替换的执行内核（pi loop / 沙箱）+ 绞杀者模式保留的 v1 复用设施 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Facade + 能力分片 | `TuiRuntimeAdapter`（tui/src/runtime/adapter.ts，degree 108）名义 god class，实际 9 个 Access 分片 | 单一入口便于消费，分片避免巨石实现 |
| 绞杀者模式（Strangler Fig） | `compat/v1/`（local-runtime-v2）+ `createLocalRuntimeHostV1` 作外壳（runtime.ts:254） | 避免一次性重写 15 万行 v1，V2 逐步接管执行与持久化 |
| 组合根 + 闭包工厂 | `createRuntimeServices()`（services.ts:395，~30 依赖纯手工装配）；turn-system 全部服务为工厂函数 + `Pick<Capability,...>` 窄接口注入 | 无 DI 容器的显式依赖图，测试可只注入所需能力 |
| 单写者租约 | `sessionLocks` 表 + 30min lease + 10s 续期（turn-system/persistence/turn.repository.ts） | 进程崩溃后的幂等恢复与多进程互斥 |
| 两阶段提交 + 补偿 | turn admission 的 prepare→admit→commit / rollback→compensate（turn-execution.service.ts:329）；插件发布 `PreparedTransition`；MiniApp 世代租约 | 涉及持久状态的变更必须可回滚 |
| 不可变快照 + revision | `PluginSnapshot` deep-frozen（plugin/runtime/snapshot-builder.ts）+ 引用计数 | 插件能力相对 turn 原子生效，执行中不换地板 |
| 世代/租约（generation & lease） | OAuth token generation/loginEpoch；MiniApp processGeneration；lease broker | 登出/刷新后全网立即失效旧凭据 |
| Registry | pi-ai `registerApiProvider`（9 种 API）；`TuiCommandCatalog`；`PluginHookRunner` | 插件式扩展点 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `SessionRecord` | 会话事实（36 字段：agent/模型快照/history 目录/状态） | 落库持久，`sessionKind` 五类（conversation/task/peek/channel/cron） | 被 SessionRepository 全层引用（degree 241 全库最高） |
| `TurnIngressReceipt` | turn 准入收据（turnId + inputDigest） | admission 事务内写入 `turnIngress` 表 | 幂等去重的唯一防线 |
| `ActiveTurnEntry` | 进程内活跃 turn（phase: running/closing/aborted + AbortController + 租约续期） | turn 执行期间 | TurnController 注册表（degree 25） |
| `AppDb` | better-sqlite3 + drizzle 数据库（v1/v2 共用文件） | 进程生命周期 | 被 6+ 社区桥接（degree 189） |
| `PluginSnapshot` | 插件能力全量快照（skills/MCP/hooks/工具） | revision 引用计数保活 | turn 组装时快照式取用 |
| `AccessTokenLease` | OAuth 短效访问令牌租约 | 分钟级，generation 单调递增 | lease broker 发给工具子进程 |
| `LocalTurnExecutionInput` | agent 执行的完整输入（租约/请求/装配/历史/控制通道） | 单 turn | C1 社区 hub（degree 48） |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `TurnService` | turn-system/contracts.ts:511 | 工厂装配的门面 | `createTurnFacade()` |
| `SessionRepository` | session-system/sessions/repo/contract.ts:328 | `DrizzleSessionRepository`（唯一生产实现，26 项能力） | `SessionSystemOwner` 集中构造 |
| `AgentHostTurnCapabilityProvider` | plugin-system/plugin-system.ts:108 | `PluginSystem` | `initializeRuntimeServiceOwners` 装配 |
| `ToolImpl` + `@bindTool(def)` | agent-core/src/tools/bind.ts | `LocalReadTool`/`LocalBashTool`/`Matrix*Tool`（18 个）等 | `buildLocalToolRegistry()` / `buildMatrixTools()` |
| `AgentExtension` SPI | agent-runtime/src/api.ts | 13 个内置 extension（skills/permission/context-manager/runaway-guard…） | `createAgentRuntime({base:[...]})` |
| `TuiRuntime` | tui/src/runtime/port.ts（~12 个窄 port） | `TuiRuntimeAdapter`；ACP 取 11 port 交集 `TuiAcpRuntime` | `createTuiRuntime` 装配 |

---

## 代码目录

```shell
minimax-code/
├── packages/                    # 一方 workspace 包（@mavis/* 前缀）
│   ├── tui/                     # 终端前端（~15.5 万行）：cli / tui / headless / acp / runtime
│   ├── local-runtime-v2/        # V2 运行时（~23 万行）：local / application / infra / service（21 子系统）
│   ├── local-runtime/           # V1 主机设施（~15.4 万行）：channels / api / persistence / permissions
│   ├── agent-modules/           # 横切原语二级包（~4.2 万行）：skills / permission / context-manager / mcp / cron / goal / …
│   ├── agent-tools/             # 工具定义（~2.3 万行）：cloud(Matrix) / desktop(本地工具) / mcp-disclosure
│   ├── agent-core/              # pi 适配层（~1.2 万行）：pi-turn-runner / event-bridge / protocol
│   ├── agent-runtime/ + agent-extension/  # 扩展 SPI 与内置 extension 装配
│   ├── browser-core/            # CDP 浏览器控制（~1.3 万行）
│   ├── oauth-core/ + oauth-lease-protocol/  # 认证与 lease 协议
│   ├── mcode-tools-host/        # lease broker 宿主
│   ├── protocol/ + config/ + shared/  # 共享数据契约 / 区域配置 / 工具库
├── third_party/
│   ├── pi-mono/                 # vendored pi（agent / ai / coding-agent / tui 四包）
│   └── sandbox-runtime/         # fork 自 anthropic-experimental（seatbelt/SRT）
├── release/                     # 机器可读发布契约（extraction.json / public-source.json）
├── scripts/                     # 构建与验证工具（verify.mjs 单一验证流水线）
├── test/                        # 仓库级测试 + vitest-suites.json（测试清单单一真源）
└── docs/                        # 人类可读文档（architecture.md / open-source-status.md 等）
```

一级目录中值得注意的特殊性：`release/` 与 `scripts/` 是"公开投影"机制的核心——`extraction.json` 的 `packageRoots` 是包范围的单一真源，build/typecheck/test/源检查全部从它读取；`test/vitest-suites.json` 声明本 distribution 运行的每个 Vitest 文件（加测试不改 package.json，改这里）。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/minimax-code/module-dependencies.svg)

依赖方向总体从左到右：tui 只依赖编排层与认证/工具（oauth 直连是它绕过分层的少数例外，用于登录 UI 与 lease broker 客户端）；编排层向下装配全部领域服务；turn-system 是最大的汇聚点（对 session-system 有队列/租约依赖，经 agent-host 进入 agent-core）；v1 以库形式被 V2 import（compat 绞杀者适配），同时向横切模块供给 permission/skills 实现。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| TUI 终端前端 | 三入口终端交互与渲染 | `runTuiCli()` in tui/src/cli/main.ts | 交互形态独立于领域；渲染引擎是 vendored fork 需台账管理 | [TUI 终端前端](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/01-tui) |
| 应用编排层 | 进程内门面与用例编排 | `CliService` in local-runtime-v2/src/local/cli-service.ts | wire 类型 ↔ 领域类型的转换边界，TUI/exec/ACP 的唯一汇合点 | [应用编排层](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/02-orchestration) |
| Turn 执行系统 | turn 提交/队列/准入/执行/结算 | `TurnService.submit()` in turn-system/contracts.ts | "谁正在执行"的进程内所有权 + 持久租约，与 Session 的持久事实分离 | [Turn 执行系统](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/03-turn-system) |
| 会话与持久化 | 会话事实、transcript、infra | `SessionRepository` + `AppDb` | 单写者边界的持久层；schema/迁移/恢复的唯一 owner | [会话系统与持久化](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/04-session-persistence) |
| 模型与 Agent 服务 | 模型解析、agent 目录、prompt 配置 | `LocalModelResolver.resolveModel()` | 模型三源解析与 prompt 供应链是独立演化域 | [模型与 Agent 服务](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/05-model-agent) |
| 插件与 MiniApp | 三来源插件、快照发布、子进程管理 | `PluginSystem` in service/plugin-system/ | 外部扩展生态需要原子生效与进程隔离 | [插件系统与 MiniApp](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/06-plugin-miniapp) |
| 技能·权限·上下文横切 | skills/permission/compaction/mcp/cron/goal 等原语 | `agent-modules/` 十个二级包 | IO-free 决策原语可被 local/cloud 两代宿主复用 | [技能·权限·上下文横切](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/07-agent-modules) |
| v1 主机设施 | IM 渠道桥、文件 API、权限引擎宿主、legacy reader | `LocalRuntimeApiHost` in local-runtime/src/api/host.ts | 绞杀者遗留的设施库，channels 32k 行是独立协议域 | [v1 主机设施与 IM 渠道](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/08-local-runtime-v1) |
| agent-core 与 pi-mono | agent loop 适配与模型协议 | `PiTurnRunner.runTurn()` in agent-core/src/pi-turn-runner/ | 防腐层隔离 vendored 上游；pi 类型不泄漏出两个 subpath | [agent-core 与 pi-mono](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/09-agent-core-pi) |
| 工具体系与沙箱 | 本地/cloud/browser 工具、lease、沙箱 | `buildLocalToolRegistry()` in agent-tools/src/desktop/index.ts | 工具执行的凭证/隔离域独立于工具定义 | [工具体系与沙箱](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/10-tools-sandbox) |
| 认证与共享协议 | OAuth、lease 协议、protocol/config/shared | `MCodeOAuthCore` in oauth-core/src/auth-core.ts | 凭据生命周期横跨所有模块，必须独立成最底层 | [认证与共享协议](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/11-auth-protocol) |

---

## 运行时行为

### 启动流程

交互 TUI 的启动链（headless/ACP 见 TUI 模块文档）：

```
runTuiCli (tui/src/cli/main.ts:81)
  → createTuiProgram (cli/program.ts:52)      commander 组装；版本检查
  → launchTui (tui/src/tui/launcher.ts:149)
      TTY 检查 → ProcessTerminal + 共享 OAuth 会话
      → createTuiRuntime({surface:'tui'})      不 await —— 动态 import
          → createEmbeddedRuntimeHost (tui/src/runtime/embedded-host.ts:61)
              runtimeOwnerKind:'tui' · 禁 legacy 回退
          → createLocalRuntimeHostV2 (local-runtime-v2/src/runtime.ts:73)
              layout 迁移 → DatabaseClient + initializeDatabase（备份+三段式迁移）
              → createLocalRuntimeHostV1（V1 外壳，compat 绞杀者）
              → createBackgroundRuntime → createRuntimeServices（services.ts:395）
                  → initializeApplications（七个命名 Application）
              → createCliService(services)
      → createTuiApp (tui/src/tui/app.ts:54)  deferred runtime 注入
      → app.start()                            首帧渲染与 runtime 初始化并行
      → Promise.race 汇合 (launcher.ts:489) → prepareInitialTuiState
```

对象装配的关键事实：**配置三级来源**是 smol-toml/yaml 配置文件 → 环境变量（`MAVIS_REGION` 等）→ 命令行；**实例化顺序**上 V1 宿主先建（外壳），V2 服务经 `DeferredLocalAgentRuntimePort`/`DeferredRuntimeConversation` 晚期绑定注入（runtime.ts:228）；**无 DI 容器**，全部组合根手工装配；cron/channel 等能力按 `ownsElectronRuntimeCapabilities` 判定是否拼装（`LocalRuntimeApplication` 全 optional 字段即为此服务）。

### 核心运行流程

下面三条链路覆盖 mcode 最核心的运行模式：对话主链路（一切功能的载体）、工具与权限链路（安全边界）、IM 渠道链路（多入口接入的另一极）。

#### 对话：一条消息的端到端数据流

业务流程：用户 Enter 提交 → 应用编排 → turn 准入（队列/租约）→ agent host 组装 → pi agent loop 执行 → 事件回流渲染 → 持久化。

![端到端数据流](/vibe-reading/images/articles/minimax-code/data-flow.svg)

文字描述：数据从 `ConversationSendMessageRequest` 开始，经 `DirectSendInput` → `SubmitTurnSubmission` 进入 turn 系统——队列路径先落 SQLite（`QueueItem` 行），dispatcher 每 session 单 drain 协程认领；admission 在单事务内写 `sessionLocks` 租约（30min）+ `turnIngress` 幂等收据 + 优先级栅栏，`controller.register` 占内存槽位。执行链组装 `LocalTurnExecutionInput`（agent 快照/历史/工具表/steering 通道），`LocalAgentHost.run` 冻结校验租约后交给 `PiTurnRunner`——它构造 pi `Agent`、注入 `convertToLlm`（按模型投影历史）与工具 hooks，跑 `runAgentLoop`。回流链上每个 `AgentEvent` 经 `EventBridge` 转 `RuntimeEvent` 进**单一串行队列**（并行工具调用的完成事件被保序），再经 `TurnCommitPipeline` → 四 projector（session/messages/stream/turnFacts）产出 `SessionFrame`，TUI 的 `TuiRunCoordinator` 逐 `next()` 拉取渲染。关键设计决策：流式全部是拉模型 AsyncGenerator（天然背压）；慢消费者由 `BoundedRing` + `SubscriberOverflowError` 断流而非无限缓存；turn 终态 `settleAndRelease` 唤醒队列下一条。

#### 工具：tool call → 权限检查 → 执行 → 回填

业务流程：pi loop 发起 tool call → beforeToolCall hook 链 → 权限三步流 → 工具执行（本地/cloud/沙箱）→ afterToolCall patch → 结果 push 回历史 → 下一轮 LLM 请求。

文字描述：mcode 在 pi 的 `config.beforeToolCall` 挂点上串接责任链（`createControlledToolHooks`，plugin-hook-tool-lifecycle.ts:64）：去重 → 工具准备 → 安全 guard → 插件 PreToolUse → policy → **permissionGuard 最后把关**。权限经 `LocalTurnPermissionGate` → `LocalPermissionFacade` → `PermissionEngine` 三步流（reject → allow → fallback ask），bash 走 shell AST 分析（危险命令 HARD deny、rm→trash 重写），read 走路径能力判定；ask 时发 `permission.ask` 事件到 TUI 弹窗三选一，回复经 `permissions.reply` 路由 settle waiter。工具执行本体：本地 read/write/edit/bash 是对 pi 工具的增值包装（PDF/notebook 分发、env 消毒、输出截断）；bash 在沙箱启用时每次 spawn 前 `beginInvocation()` 取 lease，`SandboxManager.wrapWithSandbox` 用 seatbelt profile 重写命令；cloud 工具走 Matrix 网关三段式（OSS 上传→网关调用→path-guard 下载）。**provider 完全不可感知这一切**——它只看到工具 schema，权限/沙箱/消毒全在本地层。

#### 渠道：IM 入站到 turn

业务流程：IM 平台消息 → 斜杠命令/访问控制 → 路由解析 (platform, chatId) → (agent, session) → enqueue 汇入 V2 turn 系统 → committed 回复投回原 thread。

文字描述（详细链路图见 [v1 主机设施文档](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/08-local-runtime-v1)）：`handleInbound`（channels/infra.ts:1076）先解析 `/new`、`/compact` 等斜杠命令分流 control/interactive lane；**访问控制在 lane 队列之前**执行（重放不占队列槽、群消息不饿死 DM）；`routeResolver` 把 (platform, chatId) 解析为 (agentName, sessionId)，binding 被删时回人类可读收据而非 500 黑洞；`enqueueMessage` 最终调 V2 的 `conversation.ingress.submit`——**v1 不拥有 turn 执行**，出站由 collector 聚合 committed 回复经平台 SDK 投回原 `threadId`。该链路仅 Electron 形态启用。

### 状态流

![状态流](/vibe-reading/images/articles/minimax-code/state-flow.svg)

三台状态机汇于一张图。**Turn 生命周期**：队列态 `queued`/`claimed`（`QueueItemStatus`，session-system/queue/repo/contract.ts:20）→ 准入后 `running`（`ActiveTurnEntry.phase`，turn.controller.ts:36）→ `closing`（`tryBeginClose`）→ durable 终态 `completed`/`failed`/`aborted`（`repository.settle` 写入）；steering 是 running 上的自环注入；closing 时未消费的用户 steering 走 requeue 回环变新查询（机器 steering 则扣住 close 等下一轮）。**沙箱/MiniApp 进程**：`disabled → initializing → ready/closing → closed`（`LocalSandboxLifecycleState`，local-sandbox-service.ts:50），ready 经 30s idle 进 closing。**认证**：`AuthStatus` 9 态（oauth-core/src/state-store.ts:10），主链 anonymous → authorizing → authenticated，refreshing 循环刷新，`invalid_grant` 直接回 anonymous（先写匿名态再删 secret），另有 scope_upgrade_required/logout_pending/expired/error 四个升级/异常态。

---

## 典型修改场景

#### 场景 1：新增一个内置 agent

在 `packages/local-runtime-v2/assets/agents/<name>/` 放 `PERSONA.md`（frontmatter 含 display_name/description/avatar）、`system-prompt.md.hbs`、可选 `agent.md`（capability 覆盖）；把名字加进 `builtin-agents.json` roster。`BuiltinAgentCatalog.readDefinition`（agent/builtin/catalog.ts）与 `LocalAgentService.ensureBuiltinRows`（agent.service.ts:876）自动 seed DB 行并重建 canonical 文件。对应测试：`packages/local-runtime-v2/test/unit/agent/agent-import.test.ts`。

#### 场景 2：新增一条工具权限规则 / checker

在 `packages/agent-modules/permission/src/tools/` 新建 checker 实现 `ToolPermissionChecker.checkPermissions`，经 `registerDefaultCheckers(engine)` 注册（tools/index.ts:14）；规则匹配在 `context.ts` 的 `getContentRulesForTool`，持久化 codec 在 `local-runtime/src/permissions/rule-codec.ts`。对应测试：`test:policy` suite（`scripts/run-vitest-suite.mjs policy`）。

#### 场景 3：新增一个 cloud 工具

在 `agent-tools/src/cloud/matrix-tools/tool-defs.ts` 加 `MatrixXxxToolDef`（名称须与 McpService thrift 声明顺序一致）→ `tools/` 新建工具类（照 image-synthesize.ts 的 upload→post→download 三段式）→ `buildMatrixTools()`（index.ts:185）注册 + `MATRIX_TOOL_NAMES` 插入。对应测试：`packages/tui/test/unit/mcode-tools-integration.test.ts`。

---

## 测试体系

```
test/                         # 仓库级测试 + vitest-suites.json（清单单一真源）
packages/*/test/unit/          # 各包单元测试（经 vitest-suites.json 分组声明）
packages/local-runtime-v2/test/unit/agent/   # agent 目录导入
packages/tui/test/unit/        # auth/provider/plugin/telemetry 等应用层
```

| 验证门 | 测试类型 | 触发 |
| --- | --- | --- |
| capability | Vitest 单元（按 suites.json 分组） | `pnpm test:capabilities` |
| policy | 权限/bash 解析单元 | `pnpm test:policy` |
| sandbox | 沙箱执行 | `pnpm test:sandbox` |
| smoke / byok / artifact / source-sync | node:test 仓库级 | `pnpm test:smoke` 等 |

特殊设计：`pnpm verify`（scripts/verify.mjs）与 CI 跑同一组 gate 且同序，`--list` 可查平台适用性；测试文件**必须**登记进 `test/vitest-suites.json` 而非 package.json。想理解某模块优先读它的单元测试——尤其 permission 的 policy suite 是"可执行规格"。

---

## 阅读源码推荐路线

- 第一遍：理解主流程
  `packages/tui/src/cli/main.ts` 的 `runTuiCli()` → `tui/src/tui/launcher.ts` 的 `launchTui()` → `tui/src/runtime/adapter.ts` 的 `TuiRuntimeAdapter` → `local-runtime-v2/src/local/cli-service.ts:107` 的 `CliService.sendMessage` → `application/conversation/conversation-application.ts` 的 `sendMessage()` → `service/turn-system/turn-submission.service.ts` 的 `submit()`
- 第二遍：理解执行内核
  `service/turn-system/agent-host/local-agent-host.ts:156` 的 `run()` → `agent-host/execution/executor.ts:319` 的 `runtime.runTurn` → `packages/agent-core/src/pi-turn-runner/pi-turn-runner.ts:114` 的 8 步 → `third_party/pi-mono/packages/agent/src/agent-loop.ts` 的 `runLoop()` → `event-bridge/bridge.ts:151` 的 `processEvent()`
- 第三遍：理解数据与契约
  `service/session-system/sessions/repo/contract.ts` 的 `SessionRecord` → `infra/db/client.ts` 的 `AppDb` → `agent-host/history/durable-canonical-history-store.ts` → `packages/protocol/src/local.ts`（CLI 数据结构）与 `runtime.ts`（RuntimeEvent）
- 第四遍：选择重点子模块深入（模块文档；权限看 `agent-modules/permission/src/engine.ts` 三步流，插件看 `plugin-system.ts:108` 的 `PluginSystem`，沙箱看 `service/sandbox/local-sandbox-service.ts`）

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| mcode / MCode | MiniMax Code 的 CLI 命令名与项目简称 |
| `@mavis/*` | 仓库内私有 workspace 包前缀（内部代号沿用），不发布 npm |
| pi / pi-mono | Mario Zechner 的开源 coding agent 基础设施（earendil-works），mcode vendored v0.79.1 |
| SRT / seatbelt | sandbox-runtime 的沙箱执行机制（macOS sandbox-exec profile） |
| Matrix | MiniMax 内部 cloud 工具网关代号（`/matrix/api/v1/mcp/` → 本地 `/mavis/api/v1/mcp/`） |
| steering | turn 运行中插话机制（用户/cron/task 的带外消息注入） |
| canonical history | 会话消息的权威 JSONL 记录（5 键 envelope，写前脱敏） |
| lease broker | 本地 unix socket 服务，给工具子进程发短效 OAuth token |
| 绞杀者模式 | V2 逐步接管 V1 的迁移策略（compat/v1 适配层） |
| BYOK | Bring Your Own Key——自带 API key 的自定义 provider |
| Token Plan | MiniMax 账号的订阅计费方式 |
| ACP | Agent Client Protocol——编辑器与 agent 的标准协议 |

### 参考资料

- [README.md](https://github.com/MiniMax-AI/minimax-code/blob/main/README.md) · [docs/architecture.md](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/architecture.md)（源码边界官方文档）· [docs/open-source-status.md](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/open-source-status.md)（版本与证据基线）
- [earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)（vendored 上游）· [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)（沙箱上游）
- [Agent Client Protocol](https://agentclientprotocol.com/) · [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)（设备码授权流）
