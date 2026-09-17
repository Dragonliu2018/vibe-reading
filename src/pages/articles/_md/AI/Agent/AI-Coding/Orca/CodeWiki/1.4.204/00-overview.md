---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "Overview"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
contentType: "CodeWiki"
tags: ["Orca", "TypeScript", "Electron", "Agent IDE"]
description: "Orca v1.4.204 全景解读：370 万行 TypeScript 的并行 agentic 开发 IDE——五层架构、12 个核心模块、统一 RPC 面、orcad 终端守护进程与跨机器 agent 会话租约。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.4.204（2026-09-16 release tag）· **协议** MIT · **语言** TypeScript（Electron）· **代码量** ~370 万行 TS · **仓库** [GitHub](https://github.com/stablyai/orca)

---

## 总览

### 项目简介

Orca 自称 "The AI Orchestrator for 100x builders"——stablyai 开源的**并行 agentic 开发桌面 IDE**。它解决的问题是：当 coding agent 从"一个对话"变成"一支舰队"时，开发者需要同时跑多个 CLI agent（Claude Code、Codex、Grok、Cursor、Copilot、OpenCode、MiMo、Kimi……官方宣称支持任意终端里能跑的 CLI agent，`TuiAgent` 联合类型在 v1.4.204 已有 **37 个成员**），每个 agent 在自己的**隔离 git worktree** 里工作，互不踩踏，最后比较结果、合并胜者。

它的核心价值不在"又一个编辑器"，而在**编排**：

- **并行 worktree**：一条 prompt 扇出到五个 agent，各占一个 worktree——创建有预热池、删除有五重安全 fence、名字有退休注册表（552 个海洋生物名循环使用）；
- **终端即状态源**：agent 是黑盒 CLI，Orca 用无头 xterm 解析终端字节流 + 读 agent 写到磁盘的会话文件 + 在 agent 里埋 hook 三条通道，把"黑盒"变成结构化状态；
- **执行位置无关**：本地、WSL distro、SSH 远程主机、ephemeral VM 统一为 execution host 抽象，agent 可以跑在"beefy remote box"上；
- **移动 companion**：手机经云端 relay（E2EE）监控、转向 agent，收 APNs/FCM 推送；
- **agent 反向驱动**：`orca` CLI 有 160+ 子命令，agent 自己能开 worktree、截图、填表单——形成 agentic 闭环。

**项目边界**：Orca 是编排层，不是 agent 框架——它不自带模型、不实现推理，只编排已有 CLI agent；它也不试图替代终端（自研终端体验对标 Ghostty），而是把终端作为 agent 的原生宿主。

### 功能矩阵

| 特性 | 实现位置（代表文件） | 说明 |
| --- | --- | --- |
| 并行 worktree | `src/main/worktree-create-preparation-pool.ts`、`worktree-removal-safety.ts` | 预热池（5 分钟 TTL、上限 3 棵）+ 五重删除 fence + 海洋生物名退休注册表 |
| 37 种 CLI agent 适配 | `src/shared/tui-agent-config.ts` | 声明式注册表 + 6 种 prompt 注入模式 |
| 终端（scrollback 跨重启） | `src/main/daemon/daemon-entry.ts`、`cold-restore-payload-cache.ts` | 独立 orcad 守护进程 + 三段式冷恢复 |
| SSH 远程 worktree | `src/main/ssh/ssh-connection.ts`、`src/relay/` | 双 transport（ssh2/system-ssh）、断线重连梯子、远端 relay daemon |
| 移动 companion | `mobile/`、`cloud/apps/push/` | E2EE 配对、APNs/FCM 推送网关 |
| 嵌入式浏览器 + Design Mode | `src/main/browser/browser-grab-payload.ts` | CDP 截图、点击元素直送 agent prompt（主侧三重清洗） |
| GitHub / Linear 原生 | `src/main/github/`、`src/main/linear/` | PR/issue/board 浏览，从任务直接开 worktree |
| Orca CLI | `src/cli/`、`bin.orca = ./out/cli/index.js` | 160+ 子命令，agent 可反向驱动 |
| Skills 系统 | `src/main/skills/discovery.ts`、`skill-bundle-creation.ts` | 17 家 agent 目录发现 + 双 manifest bundle + 分享链接 |
| Computer Use | `src/main/computer/sidecar-entry.ts` | 独立 sidecar 进程操控桌面应用 |
| 多 agent 编排 | `src/main/runtime/orchestration/coordinator.ts` | 2 秒轮询的任务 DAG 协调器（AI 分解尚未实现） |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Electron 43.7 + electron-vite 5 / rolldown-vite | 核心 | 桌面外壳与构建（asar、多入口构建 daemon/sidecar 等独立产物） |
| React 19.2 + zustand 5.0 | 核心 | Renderer：单 store 45 个 slice 组合 |
| node-pty 1.1 | 核心 | PTY 终端进程 spawn |
| `@xterm/headless` 6.1 + SerializeAddon | 核心 | 无头终端仿真——OSC 解析、scrollback 序列化检查点 |
| `node:sqlite`（Node 内置） | 核心 | OrchestrationDb / agent session journal（WAL 模式） |
| ssh2 1.17 | 核心 | SSH 连接（FIDO2 场景回退 system-ssh 二进制） |
| ws 8.21 | 核心 | runtime-rpc WebSocket（桌面/远程/移动） |
| zod 4.5 | 核心 | 590 个 RPC 方法的参数契约 |
| tweetnacl | 核心 | 移动端 E2EE（React Native 无法 pin 自签证书，故不用 TLS） |
| agent-browser ~0.27 | 可选 | agent 浏览器自动化的独立 CLI 守护进程 |
| @anthropic-ai/claude-agent-sdk 0.3 | 可选 | Claude 结构化会话协议 |
| electron-updater 6.8 | 可选 | 每日发布的自动更新 |
| oxlint / oxfmt | 工具链 | 代码质量 ratchet 门（代替 eslint/prettier） |
| vitest + Playwright | 工具链 | 单测（8494 个 test 文件）+ e2e |

### 版本历史

Orca 是**日更节奏**的项目——仓库有 1102 个 tag，`v1.4.204` 发布于 2026-09-16，同日还有 `v1.4.200`–`v1.4.203`。README 自嘲 "we ship daily, so this list is perpetually behind. The changelog is the real feature list"。主要脉络：v1.0 确立桌面 IDE 形态 → v1.2–1.3 期补齐移动 companion、SSH 远程、skills 分享 → v1.4 进入编排深化（OrchestrationDb、coordinator、federation）。本篇解读基于 v1.4.204 桌面主线（`mobile-android-v0.0.44` 为移动线独立版本号）。

---

## 快速上手

以使用者视角最快看到"agent 舰队跑起来"：

```bash
# macOS 安装（也有 Windows/Linux 安装包与 AUR）
brew install --cask stablyai/orca/orca
open -a Orca
```

端到端验证——首次启动后：

1. 选一个本地 git repo 加入 workspace；
2. 在 composer 里选 Claude Code（需本机已安装 `claude` CLI），输入一条 prompt，如"给这个项目加一个 README"；
3. 预期结果：新 tab 打开、worktree 自动创建（名字是 `you/Nautilus` 这类海洋生物）、agent 在终端里开跑、sidebar 出现状态点（working）；
4. 再点一次 composer 选 Codex，同一条 prompt 发给第二个 agent——两个 agent 各在自己的 worktree 里并行工作。

开发者视角构建仓库：

```bash
git clone https://github.com/stablyai/orca && cd orca
pnpm install
pnpm dev        # orca-dev 多 worktree 并行开发场景
```

验证：`pnpm test src/main/runtime/rpc/core.test.ts` 跑通即构建链正常；`pnpm lint` 是全量质量门（含 RPC 契约目录、skill manifest 等生成物对账）。

---

## 架构设计解析

### 系统架构

Orca 的架构思想可以概括为一句话：**编排层不做执行，执行层不依赖编排**。桌面 main 进程是装配根（composition root），`OrcaRuntimeService` 是中枢运行时，真正的执行（终端、git、文件）下沉到独立守护进程或远端执行主机；三形客户端（桌面 renderer、移动 app、CLI）共享同一套 RPC 方法面，避免为每种客户端重写业务入口。

![Orca 分层架构](/vibe-reading/images/articles/orca-internals/architecture.svg)

自上而下五层加一个外部云端：

- **客户端层**只负责呈现与发起——renderer（React 单 store）、移动 app（Expo）、`orca` CLI 都是"薄客户端"，所有真状态在主进程；
- **接入层**是双通道：preload contextBridge 暴露 814 个 `ipcMain.handle`（桌面高频专用）+ 统一 `RpcDispatcher`（590 个 `defineMethod`，同时服务 IPC、Unix socket、WebSocket、移动 E2EE 四种传输）；
- **运行时层**是 `OrcaRuntimeService`（135 层 mixin 链机械拼装）加三个状态真源——`OrchestrationDb`（编排）、`AgentSessionRecordStore`（会话租约）、`RuntimeStore` 契约（持久化投影）；
- **执行主机层**持有进程与文件：orcad 终端守护进程（独立于 app 更新存活）、Local/WSL/SSH 三种 PtyProvider、按 host 隔离的 Git 能力缓存；
- **数据与状态层**是 agent 留下的客观痕迹——agent 自己写的会话文件（JSONL/SQLite）、loopback HTTP 的 hook 上报、electron-store 持久化、terminal-history 检查点；
- **云端**只做中继与推送，不持有状态：relay director/cell 把手机和桌面的出站 WebSocket 配对后纯转接帧（splice），push gateway 走 APNs/FCM 打 OS banner。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 客户端层 | `src/renderer/src/`、`mobile/`、`src/cli/` | 隔离呈现与传输细节，保证多客户端同构 |
| 接入层 | `src/preload/`、`src/main/ipc/`、`src/main/runtime/rpc/`、`src/main/runtime/runtime-rpc/` | 统一鉴权/校验/错误映射，保护 runtime 不感知客户端形态 |
| 运行时层 | `src/main/runtime/`（含 `orchestration/`） | 承载会话/终端/订阅的领域规则，进程内唯一权威 |
| 执行主机层 | `src/main/daemon/`、`src/main/pty/`、`src/main/git/`、`src/main/ssh/`、`src/main/providers/` | 拥有进程与文件系统，隔离崩溃域与更新域 |
| 数据与状态层 | `src/main/native-chat/`、`src/main/ai-vault/`、`src/main/agent-hooks/`、`src/main/persistence/` | 把黑盒 agent 的痕迹变成结构化数据 |
| 云端 | `cloud/apps/` | 中继与推送，永不成为状态权威 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 声明式注册表 + 策略枚举 | `TUI_AGENT_CONFIG_SOURCE` in `src/shared/tui-agent-config.ts` | 37 个 agent 的 launch/detect/paste 差异收敛为一张表，加 agent 漏配置直接编译失败（`Record<TuiAgent, …>` 强制穷尽） |
| 机械拆分的 mixin 继承链 | `OrcaRuntimeService` in `src/main/runtime/orca-runtime.ts`（135 层 `OrcaRuntimeWith*`） | god class 按能力拆到一文件一层，改动半径最小化；行为等价靠 AST 等价 + characterization 测试保证 |
| prototype 方法挂载 | `attachOrchestrationDbMethods()` in `orchestration/db/attach-orchestration-db-methods.ts`（75 个 `attach*`） | 与 mixin 链同思路：类型用交叉（`Core & Methods`）绕开 class 合并限制 |
| 生成式契约目录 + drift gate | `rpc-params-catalog.generated.ts` + `config/scripts/generate-rpc-params-catalog.mjs` | 590 个方法的参数 schema 从 registry 反查生成，字节级 + 类型级双重对账防漂移 |
| 能力协商 | `RUNTIME_PROTOCOL_VERSION=3` in `src/shared/protocol-version.ts`（60+ 个 capability 常量） | 客户端与 host 独立更新是常态，二进制帧无版本信封，新 opcode 必须 capability 确认后才发 |
| 租约 / rendezvous | `AgentSessionRecordStore`（lease）、`BrowserHostLeaseRegistry` | 多写者竞争（桌面/serve/手机/重启）用 fence 单调整数 + 三段式 acquire 裁决 |
| fail-open 旁路 | `RelayAgentHookServer` 错误回 204；`PushGatewayClient` 从不 throw | hook/push 是旁路组件，绝不阻塞 agent 主路径 |
| 稳定退出码契约 | `SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE = 3` in `startup/single-instance-lock.ts` | 给 systemd `RestartPreventExitStatus=` 的稳定契约，"changing it silently un-fixes #11935" |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `OrcaRuntimeService` | 运行时中枢，135 层 mixin 合成的单一对象 | 随 main 进程（桌面或 `orca serve`） | 被 RpcDispatcher 调用；持有各 controller |
| `OrchestrationDb` | 多 agent 编排的任务/消息/派发真源（SQLite WAL） | 惰性创建于首次编排操作 | `attachOrchestrationDbMethods` 挂载 75 组方法 |
| `AgentSessionRecordStore` | agent 会话的租约账本（fence/lease/operation ledger） | 每 host 目录一份，跨重启 | wire 层 `StructuredAgentSessionHost` 消费 |
| `RuntimePtyWorktreeRecord` | PTY 与 worktree 的绑定记录 + agent 状态折叠 | 随终端生命周期 | 由 daemon 事件流（exit/OSC）持续更新 |
| `ExecutionHostId` | 执行主机身份（判别联合字符串） | 静态 | `parseExecutionHostId()` 单点解析 |
| `TuiAgentConfig` | 单个 agent 的声明式配置 | 编译期 | `buildAgentStartupPlan()` 消费 |
| `PreparationEntry` | worktree 预创建池条目 | 5 分钟 TTL | `consumePreparedWorktreeCreate()` 消费 |
| `SkillBundleManifestV1` | 跨 agent 分享的 skill 包清单 | tar.gz 内双 manifest | `orca://skill-share/<id>` 分发 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `IPtyProvider` | `src/main/providers/` | `LocalPtyProvider`、`DaemonPtyAdapter`、SSH relay provider | 惰性闭包注入 runtime（`getLocalProvider: () => …`） |
| `defineMethod()` | `src/main/runtime/rpc/core.ts` | 590 个方法（`methods/*.ts`） | `ALL_RPC_METHODS` 平铺清单（安全审计单一 grep 点） |
| `ExecutionHostKind` 判别联合 | `src/shared/execution-host.ts` | `local` / `ssh:` / `runtime:` 三分支 | 消费方 switch，编译器强制穷尽 |
| `StructuredAgentSessionAdapter` | `native-chat/agent-session-wire/` | Claude（agent-sdk）、Codex（app-server JSON-RPC）等 | `adapterSupportsCreate` 能力门控 |
| `RuntimeStore` 契约 | `runtime-store-contract.ts` | `../persistence` 的 Store 投影 | 构造注入，测试可裁剪 mock |

---

## 代码目录

```shell
orca/
├── src/
│   ├── main/                 # Electron 主进程（~165 万行）
│   │   ├── index.ts          # 入口（115 行薄壳，转发 startup）
│   │   ├── startup/          # 分阶段装配（preflight→ready→launch）
│   │   ├── runtime/          # OrcaRuntimeService + orchestration/（RPC 中枢）
│   │   ├── ipc/              # 814 个 ipcMain.handle 文件
│   │   ├── daemon/           # orcad 终端守护进程（独立构建入口 daemon-entry.ts）
│   │   ├── pty/              # spawn 环境纯函数层（main 与 daemon 共用）
│   │   ├── git/              # Git 命令层 + 根下 worktree-*.ts 生命周期编排
│   │   ├── ssh/              # SSH 连接/重连/SFTP/端口转发
│   │   ├── browser/          # 嵌入式浏览器（506 文件，grab/CDP/lease）
│   │   ├── native-chat/      # 会话 journal/wire/文件解析
│   │   ├── ai-vault/         # 会话扫描（parse cache/worker）
│   │   ├── agent-hooks/      # agent 终端钩子 + hook server
│   │   ├── skills/           # skill 发现/打包/安装/分享
│   │   ├── computer/         # computer use sidecar
│   │   └── <agent>/          # 20+ 个 agent 深度集成目录（claude/codex/…）
│   ├── renderer/src/         # React UI（~167 万行，单 store）
│   ├── preload/              # contextBridge API（80+ bridge）
│   ├── relay/                # 桌面侧 relay daemon（远端执行时部署）
│   ├── cli/                  # orca CLI（~4.8 万行）
│   └── shared/               # 跨进程类型与纯函数（~25 万行）
├── mobile/                   # Expo 移动 companion（独立版本号）
├── cloud/                    # 云端：relay / push / fence-broker + Terraform
├── skills/                   # 内置 skills（orchestration/computer-use/…）
├── tests/e2e/                # Playwright e2e
└── electron.vite.config.ts   # 多入口构建（daemon/plugin-host/sidecar/workers）
```

`src/main/` 根下还散布 ~90 个 `worktree-*.ts`（worktree 生命周期编排）与 ~500 个带 `.test.ts` 同居测试的领域文件——这是 Orca 的显著风格：**测试与实现同名共居**，几乎每个非组件文件旁边都有对应测试。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/orca-internals/module-dependencies.svg)

依赖方向自左向右：客户端与装配层调用统一 RPC 面，RPC 的 590 个方法 handler 全部落到 Agent Runtime 核心的方法面；runtime 再以惰性闭包注入的方式消费右侧七个执行/数据模块（谁提供 provider 谁就被 runtime 调用）。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 主进程启动与生命周期 | composition root 分阶段装配 | `runMainProcessPreflight()` | 装配顺序本身是正确性约束（锁/崩溃捕获/深链缓冲） | [主进程启动与生命周期](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/01-startup) |
| 统一 RPC 层 | 四种传输共享一套方法面 | `RpcDispatcher.dispatch()` | 鉴权/校验/兼容只写一份 | [统一 RPC 层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/02-rpc) |
| Agent 运行时核心 | 会话/终端/编排中枢 | `OrcaRuntimeService` | 全部领域规则的唯一权威 | [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime) |
| 终端守护进程 | PTY 持有 + scrollback 冷恢复 | `startDaemon()` | 崩溃域/更新域与主进程隔离 | [终端守护进程](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/04-terminal-daemon) |
| Git Worktree 生命周期 | 创建预热/删除安全/名字退休 | `prepareWorktreeCreateForRepo()` | "并行"卖点的物理基础 | [Git Worktree 生命周期](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/05-git-worktree) |
| Agent Provider 适配 | 37 agent 的声明式接入 | `buildAgentStartupPlan()` | agent 差异必须收敛成数据而非分支 | [Agent Provider 适配](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/06-agent-providers) |
| 会话数据层 | journal/解析/hook 汇聚 | `AgentSessionJournal` | 黑盒 agent 的结构化投影 | [会话数据层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/07-session-data) |
| 嵌入式浏览器 | 页面租约 + Design Mode + agent 自动化 | `browserTabCreate` | 页面所有权跨机器流转 | [嵌入式浏览器](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/08-browser) |
| SSH 远程执行 | 连接/重连/SFTP/转发 | `SshConnectionManager.connect()` | "代码在哪跑"不是布尔值 | [SSH 远程执行](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/09-ssh-execution-host) |
| Relay 云中继 | 手机↔桌面中继 + 推送 | `RelayControlClient.connect()` | 云端永不持有状态权威 | [Relay 云中继](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/10-relay-cloud) |
| Renderer UI | 单 store 多 slice 呈现层 | `useAppStartupHydration()` | 167 万行的性能预算靠纪律不靠拆库 | [Renderer UI](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/11-renderer) |
| CLI 与工具生态 | CLI/Skills/Computer Use | `dispatch()` in `src/cli/dispatch.ts` | agent 反向驱动的闭环入口 | [CLI 与工具生态](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/12-cli-ecosystem) |

---

## 运行时行为

### 启动流程

main 进程的装配链（每步标注文件）：

```text
src/main/index.ts（115 行薄壳）
├─ setMainWindowOpener(openMainWindow)          # setter 注入打破循环依赖
├─ runMainProcessPreflight()                    # startup/main-process-preflight.ts
│  ├─ acquireSingleInstanceLock()               # 失败 app.exit(3)——systemd 契约
│  ├─ setter 注入面（~60 模块）：setSecretStore / setPtyHostBindings / …
│  ├─ startCrashpadCapture()                   # 必须在首个 renderer 前
│  └─ registerMainProcessIpcHandlers()         # 第一波 IPC（8 个启动 barrier/pull 型）
└─ app.whenReady()
   └─ initializeMainProcessReady()              # startup/main-process-ready.ts
      ├─ initializeReadyFoundation()            # Store、代理、SSH host key
      ├─ initializeReadyRuntimeServices()      # new OrcaRuntimeService(...) → state.runtime
      └─ Promise.all([i18n+menu, initializeMainProcessRuntimeLaunch()])
         ├─ installRuntimeRpc(runtime, serve)   # OrcaRuntimeRpcServer（loopback WS）
         └─ launchDesktopMode() / launchServeMode()   # 95% 同构，最后一步分叉
            └─ openMainWindow()                 # 与 runtimeRpc.start() 并行
               ├─ createMainWindow(store, {崩溃恢复回调×15})
               ├─ createSystemTrayDeferred()    # ready-to-show 后 + 12s 兜底
               └─ registerCoreHandlers()        # 第二波 IPC（窗口创建时）
```

对象装配的关键决策：**依赖全部惰性闭包注入**——runtime 构造收 `getLocalProvider: () => getLocalPtyProvider()` 而不是 provider 实例，因为 daemon 会被替换、SSH provider 会重连、serve 模式可原地晋升。渲染器侧的深链（skill share、markdown 文件）用 **pull-as-proof 握手**：主进程先 buffer，渲染器 mount 后主动 `ui:consumePendingMarkdownFileOpens` 拉取，拉取动作本身证明 listener 存活，此后才敢 push——因为 Electron 的 `webContents.send` 对无 listener 渲染器是静默丢弃。

### 核心运行流程

以下三条链路覆盖了 Orca 最核心的运行模式：单 agent 交互、并行 worktree 扇出、移动远程监控。

#### agent 交互：prompt 提交主链路

业务流程：用户在 composer 选 agent 输入 prompt → 建 tab → spawn PTY → agent 进程启动 → 输出流回渲染 → 状态行更新。

![prompt 提交数据流](/vibe-reading/images/articles/orca-internals/data-flow.svg)

从 `launchAgentInNewTab()` 出发：`buildAgentStartupPlan()`（`src/shared/tui-agent-startup.ts`）按该 agent 的 `promptInjectionMode` 拼启动命令——Claude Code 走 `argv` 模式直接把 prompt 折进命令行，followup 型 agent 则返回 `followupPrompt` 等 TUI 就绪后 bracketed-paste（paste 帧必须单次 PTY write，Claude composer 会吞掉拆帧的开头）。prompt 经 `queueTabStartupCommand` 入队（必须在 TerminalPane mount 前，pane 首渲染快照读取），pane mount 触发 `pty:spawn` invoke → `LocalPtyProvider.spawn()` 用 node-pty 起子进程。输出回流是**事件推送**：`proc.onData` 双消费者扇出——`runtime.onPtyData` 喂 tail buffer 和 OSC 状态扫描，`acceptPtyDataForRenderer` 走 2ms 批量 + 信用制背压（`pty:ackData` 回执，超限 gate 生产者）推 `pty:data` 给 renderer 的 xterm.js。agent 状态的权威源是 hook 上报：agent 终端里的 hook 脚本 POST 到 loopback `AgentHookServer`，归一化后 `agentStatus:set` 推 sidebar 与移动端。

#### 并行编排：worktree 扇出链路

业务流程：用户打开 base picker → 预热池后台 checkout → 提交创建 → 池命中（重命名级开销）→ 五个 agent 各占一个 worktree。

用户在 base picker 打开时（还在打字），`prepareWorktreeCreateForRepo()`（`src/main/worktree-create-preparation.ts`）已异步预检树：`git worktree add --detach --no-checkout` 建骨架（`--no-checkout` 绕过用户 post-checkout hook）→ `git reset --hard` 物化文件 → `git worktree lock` 防 prune。提交时 `consumePreparedWorktreeCreate()` 做 claim——`selectPreparationForCreate()` 裁决 exact/retarget/miss，await 后**重读池再选**防并发双 claim，命中则 `git worktree move` 到最终路径（重命名级开销，省掉一棵 ~200MB 树的完整 checkout）。删除走五重 fence（`worktree-removal-safety.ts`）：注册表核验 + 路径形状（拒绝 repo 根/文件系统根/$HOME）+ 嵌套 worktree 检查 + clean 断言 + 进回收站。名字退休是 GC 式回收：创建成功即 `retireGeneratedWorktreeName()` 把 `nautilus` 这类生成名记入注册表——名字复用会把上一个 agent 的对话历史目录交给下一个占用者，宁可过度退休。

#### 移动远程：手机监控链路

业务流程：配对 → 手机出站连云端 cell → relay splice 桥到桌面出站连接 → E2EE 帧进 runtime-rpc → allowlist 裁决 → 手机下发 follow-up / 收推送。

桌面 `RelayControlClient`（`src/main/runtime/relay/relay-control-client.ts`）持 Bearer JWT 向 director 分配的 cell 发起**出站** `/v1/host/control`；手机连 `/v1/connect/{hostId}`，director 查 invite 分配 cell（`relay-moved` 迁移，`assignmentEpoch` 幂等）；cell 把两端 splice 纯转接帧——relay 不解析业务内容，为端到端加密让路。帧到桌面后 `MobileSocketWiring`（每 WebSocket 一个 `E2EEChannel` + `DeviceRegistry` 鉴权）解密进 runtime-rpc，`device.scope === 'mobile'` 的请求必须过 `MOBILE_RPC_METHOD_ALLOWLIST`（约 300 个只读+审过的方法，默认拒绝）。通知走完全独立的 push 通道：`DesktopPushService` → 云端 push gateway（PostgreSQL 持久队列）→ APNs/FCM 打 OS banner——"desktop notification categories remain authoritative"，通知 socket 只用于实时 dismissal。

### 状态流

agent 会话的所有权是全系统最精细的状态机——多写者竞争（桌面、`orca serve`、手机重连、daemon 重启、进程 crash）全部由 `AgentSessionRecordStore` 的 fence + lease 裁决：

![agent 会话租约状态流](/vibe-reading/images/articles/orca-internals/state-flow.svg)

状态定义在 `src/main/native-chat/agent-session-wire/`（`agent-session-lease-transitions.ts` 的纯函数转移）：`reserveAgentSessionOwner()` 以 `fence+1` CAS 写入预约意图（输家被拒且**永不 spawn**）；子进程必须回显 `reservedSpawnToken` 才算 `commitProcessIdentity`（"a child that cannot echo the reserved token is not the process Orca started"）；`proveAgentSessionOwner()` 验证 provider handle 后才置 `claimStatus:'live'`——此刻 session 才有 writer。live 后每 10 秒续租（30 秒 TTL），续租同时断言子进程身份探测通过。`evict` 是除 acquire 外唯一推 fence 的操作，需 `deathEvidence`。TUI 接管走 handoff 阶段机（preparing → old-owner-stopped → 新 owner reserve → 回到 proving）。**进程重启后所有 lease 置 unreconciled**——"a restart grants no writer on the strength of what the previous process wrote"，逐条探测后才能回到 live 或 evicted。

---

## 典型修改场景

#### 场景 1：新增一个 CLI agent

编译器强制必改四处：`src/shared/tui-agent.ts` 的 `TuiAgent` union → `src/shared/tui-agent-config.ts` 加配置（漏加编译失败）→ `tui-agent-display-names.ts` 加显示名 → `agent-kind.ts` 加 telemetry 映射（`satisfies` 强制）。按需：二进制名不一致时加 `agent-process-recognition.ts` 的 entrypoint identity、有 trust 菜单加 `agent-trust-presets.ts`、quiet window 不够时在 `draft-paste-ready-scanner.ts` 加新的就绪信号 spec。详见 [Agent Provider 适配](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/06-agent-providers)。

#### 场景 2：新增一个 RPC 方法

`src/shared/rpc-contract/foo-params.ts` 写 zod schema → `src/main/runtime/rpc/methods/foo.ts` 用 `defineMethod` 定义 → `methods/index.ts` 加进 `ALL_RPC_METHODS` → 跑 `pnpm run generate:rpc-params-catalog` 重新生成契约目录（否则 lint 的 drift gate 挂掉）→ 手机要用则加进 `runtime-rpc-mobile-method-allowlist.ts`。

#### 场景 3：新增一个右侧栏面板

`src/shared/ui-chrome-types.ts` 的 `ActiveRightSidebarTab` 加值 → `store/right-sidebar-route.ts` 的 `resolveRightSidebarRoute` 归一化（注意 plugin panel key fencing）→ `right-sidebar-panel-content.tsx` lazy 挂载 → `right-sidebar/index.tsx` 加图标（该文件 7 处 `useAppStore(` selector 必须保持稳定 identity，否则过不了 fanout 基准）。

---

## 测试体系

```shell
src/                         # 同居测试：8494 个 .test.ts 与 11585 个源文件几乎 1:1
├── *-real-git.test.ts       # 真 git 二进制集成（版本边界矩阵）
├── *-real-*.test.ts         # 其他真实二进制兼容
├── *.live-shell.test.ts     # 真实 shell 环境测试
├── repro-*.test.ts          # 历史事故的复现锁定（文件名编码 issue 号）
└── config/vitest.performance.config.ts   # 性能契约测试
tests/e2e/                   # Playwright 端到端
```

| 代码层 | 测试类型 |
| --- | --- |
| shared 纯函数 / 状态转移 | 同居单元测试（含 fuzz 边界） |
| git / 终端 / shell 集成 | real-binary 与 live-shell 测试 |
| RPC 契约 | 生成物对账（catalog / manifest / localization） |
| 架构约束 | ratchet 测试（max-lines、ts-nocheck、runtime-electron 导入面只减不增） |
| renderer 性能 | zustand selector fanout 基准（2500 订阅者 × 2000 写，每写 ≤5ms 硬阈值） |
| UI | Playwright e2e + CDP 截图（禁止偷焦点，`ORCA_BACKGROUND_LAUNCH=1`） |

值得注意的文化：`daemon/` 目录大量文件名直接编码历史 bug（`repro-7329-remote-snapshot-corruption`、`issue-6814`），每个回归都有复现测试钉死；`AGENTS.md` 要求"读终端画面的规则必须对着捕获的 transcript 写，不许凭记忆的屏幕"。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `src/main/index.ts`（115 行薄壳）→ `startup/main-process-preflight.ts` 的 `runMainProcessPreflight()`（为什么这些事必须在 ready 前）→ `startup/main-process-ready.ts` 的 `initializeMainProcessReady()` → `startup/main-window-controller.ts` 的 `openMainWindow()`（窗口创建时才注册第二波 IPC）
- **第二遍：理解核心数据结构**
  `src/shared/execution-host.ts`（`ExecutionHostId` 判别联合与"本客户端可拨 vs 持有文件"的语义分裂）→ `src/shared/tui-agent-config.ts`（37 agent 一张表）→ `src/main/runtime/agent-session-record-store.ts`（lease 账本）→ `src/main/runtime/orchestration/db/orchestration-db.ts`（75 组方法挂载）
- **第三遍：理解扩展机制**
  `src/main/runtime/rpc/core.ts` 的 `defineMethod()` → `rpc/methods/index.ts` 的 `ALL_RPC_METHODS`（"安全边界审计的单一 grep 点"）→ `src/cli/handler-group-manifest.ts`（懒加载路由）→ `src/main/skills/discovery.ts`（17 家 agent 目录发现）
- **第四遍：选重点模块深入**
  从模块地图挑——终端体验读 [终端守护进程](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/04-terminal-daemon)，并行编排读 [Git Worktree 生命周期](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/05-git-worktree)，远程读 [SSH 远程执行](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/09-ssh-execution-host)

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| worktree | git worktree——Orca 中 agent 的隔离工作区单位，名字取自 552 个海洋生物池 |
| orcad | 独立终端守护进程（`daemon-entry.ts`），app 更新后可被"收养"继续存活 |
| execution host | 执行主机抽象：local / `ssh:<targetId>` / `runtime:<environmentId>` |
| fence | agent 会话记录的单调整数，所有权转移的唯一 CAS 坐标 |
| verdict | 进程存活判定词汇：`live` / `unverifiable` / `exited`，无同义词 |
| OSC 9999 | agent 自报状态的转义序列通道（与从 title 推断的状态区分） |
| splice | 云端 relay 对两端 WebSocket 的纯帧转接（不解析内容） |
| preparation pool | worktree 预创建池（5 分钟 TTL、磁盘上限 3） |
| retired name | 已用过的 worktree 生成名，复用前须退休以防对话历史泄漏 |

### 参考资料

- [Orca 官网与文档](https://onorca.dev)——worktree / mobile / SSH / CLI 各专题文档
- 仓库内 `AGENTS.md`——贡献者契约（execution host 边界、agent status store、wire 兼容规则、Windows/WSL/Git 兼容基线），是理解架构约束的第一手材料
- `docs/reference/`——`agent-status-store.md`、`ssh-execution-boundary.md`、`remote-wire-compatibility.md`、`git-compatibility.md` 等专题设计文档
- [Orca Releases](https://github.com/stablyai/orca/releases)——日更 changelog
