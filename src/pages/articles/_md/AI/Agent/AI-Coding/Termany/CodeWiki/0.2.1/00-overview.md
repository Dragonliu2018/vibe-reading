---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "Overview"
date: "2026-09-18T15:39:21+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "AI Agent", "终端"]
description: "Termany 是 ThinkAny 开源的 agent-native 终端：一个窗口同时跑大量 coding agent 会话，靠屏幕内容与进程组判断哪个 pane 在等你；React+xterm.js 共享 UI 经 ITerminalBackend 单一接缝连到 Node PTY 服务，同一份 server 未来即云后端。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.2.1（tag `831a0ea`，2026-09-13）· **协议** AGPL-3.0-only · **语言** TypeScript + Rust · **代码量** ~58k 行（TS ~56.6k + Rust ~1.4k）· **仓库** [GitHub](https://github.com/thinkany-ai/termany)

---

## 总览

### 项目简介

Termany 是 ThinkAny 开源的**同时运行大量 coding agent 的终端**（"A terminal for running many coding agents at once"）。它要解决的问题是：当你同时开着五个以上 Claude / Codex 会话、在同一个仓库的多个 worktree 上并行干活时，普通终端既找不到"哪个 agent 停下来等你了"，也没有把围绕这些会话的工作（diff、端口、远程主机、token 成本）放在同一个地方。

Termany 的核心价值有三块：**一是会话管理**——Workspace ▸ Page ▸ Tab ▸ Pane 四级嵌套布局，每个 tab 是常驻会话（后台化时 shell 与 scrollback 都活着），每个 pane 被标注 working / done / needs attention，有活动的 pane 浮到侧栏 ACTIVE 区；**二是 agent 集成**——经 Agent Client Protocol（ACP）把 Claude、Codex、Gemini 等 11 个 agent 接成结构化聊天（含多 agent 群聊、@提及路由、A2A 委托），并从 Claude/Codex 的本地 transcript 读取跨 worktree 的会话历史与 token 成本；**三是周边工作**——per-pane SSH、远程端口一键本地转发、git diff 视图、活动监视器、14 个全窗主题。

项目边界：Termany 是终端与编排层，**不是** agent 本体——它复用用户机器上已装的 agent CLI 与其登录态（BYOK，密钥存本地 `~/.termany/termany.db`），自己不跑模型推理（内置聊天助手除外，那也是转发到用户配置的 provider）。桌面版把 Node 服务与 web UI 一起打包进 Tauri，本地优先；云端形态（container-per-session）是 Roadmap 而非现状。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 四级嵌套布局 | `apps/web/src/state/store.ts` | Workspace ▸ TreeNode(Page) ▸ HTab ▸ Pane 二叉分裂树，服务端 SQLite 为真源 |
| 常驻会话 + scrollback 保活 | `apps/web/src/terminal/manager.ts` | xterm 实例池住在 React 之外的模块级 Map，后台 tab 卸载组件不杀 shell |
| pane 活动标注 | `apps/server/src/agentActivity.ts` + `apps/web/src/terminal/agentActivityPrompt.ts` | 双层感知：server 状态账本 + web 渲染屏分析，epoch CAS 防竞态 |
| ACP agent 聊天 | `apps/server/src/acpRuntime.ts` + `apps/web/src/components/AgentPane.tsx` | stdio JSON-RPC → NDJSON 流式 → 增量渲染；权限应答走结构化回路 |
| 多 agent 群聊 / A2A | `apps/web/src/agentGroupChat.ts`、`agentA2A.ts` | lead 成员 JSON 决策路由 + @提及 + `[[private:]]`/`[[a2a:]]` 私信协议 |
| 会话历史（⇧⌘H） | `apps/server/src/agentSessions.ts` | 流式解析 `~/.claude/projects` 与 `~/.codex/sessions` 的 JSONL transcript |
| token 成本（⇧⌘U） | `agentSessions.ts` + `apps/web/src/components/AgentUsage.tsx` | server 出原始 token，web 端 PRICING 前缀表估价 |
| per-pane SSH | `apps/server/src/ssh.ts` + `index.ts` spawn `"ssh"` | 交互式 ssh 进程直接跑在 node-pty 里，密码认证因此可行 |
| 远程端口本地转发 | `apps/server/src/sshPortForwarding.ts` | pane 的 ssh 即 ControlMaster，转发是 `ssh -O forward` 控制请求 |
| git diff / worktree 视图 | `apps/server/src/git.ts` + `apps/web/src/components/GitDiffView.tsx` | porcelain 子命令 + numstat 配对，linked worktree 默认 vs-main 比较 |
| 文件传输 | `apps/server/src/fileTransfer.ts` + `trzszFilter.ts` | trzsz 协议 plug 链，与 shell 共享同一条字节流 |
| 活动监视器（⇧⌘M） | `apps/server/src/systemStats.ts` + `apps/web/src/components/SystemMonitor.tsx` | CPU/内存/swap/pressure + 进程按端口定位与 kill |
| 主题（14 个 + CodexThemes） | `apps/web/src/themes/` | 全窗 token 化（CSS 变量注入），win98 用专属样式表做 3D bevels |
| 21 语言 i18n | `apps/web/src/i18n/` | 无 Context 轻量 hook，en 为 source 其余 Partial 回落 |
| 桌面打包 + 自更新 | `apps/desktop/src-tauri/src/lib.rs` + `scripts/bundle-server.mjs` | Tauri 2 壳 spawn 并看护打包的 Node 24 server |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| React 18 + Zustand 5 | 核心（web） | UI 与全局状态；selector 级订阅避免整树重渲 |
| xterm.js 5.5（@xterm/xterm + webgl/fit/search/web-links addon） | 核心（web） | 终端渲染；WebGL 字形图集 + 自研修复 |
| node-pty 1.0 + ws 8 | 核心（server） | PTY host 与 WebSocket 通道 |
| node:sqlite（Node 24 内置 DatabaseSync） | 核心（server） | `~/.termany/termany.db` 单文件持久化，WAL 模式 |
| @agentclientprotocol/sdk 1.2 + claude-agent-acp / codex-acp | 核心（server） | ACP 客户端与打包的 managed bridge |
| Tauri 2.11（Rust）+ objc2-app-kit / windows-sys | 核心（desktop） | 窗口/托盘/全局快捷键/更新器与平台原生集成 |
| trzsz、undici、@anthropic-ai/sdk、esbuild | 可选/工具 | 内联文件传输、代理环境、BYOK 聊天、server 打包 |
| marked + DOMPurify、CodeMirror 6、mammoth/SheetJS/pptx-preview | 可选（web） | Markdown 渲染、代码编辑、Office 预览（全部动态 import） |

### 版本历史

Termany 2026 年开源，v0.2.1（2026-09-13）是当前 release：桌面端已有 macOS 签名公证 DMG 与 Windows NSIS 安装包（`.github/workflows/build.yml`）。仓库内可见的演进痕迹：agent 注册表淘汰过 charm/kilocode/droid（`REMOVED_AGENT_IDS` in `agentConfig.ts`）；runtime 预设从系统 `npx` 启动迁移到打包 bridge（`isLegacyNpxRuntime` in `packages/core/src/agentRuntime.ts`）；pre-6.0 移除了应用内主题编辑器（`loadAiThemes` 清理逻辑 in `themes/index.ts`）。Roadmap 三件事：前端会话重连闭环、进程内 `LocalPtyBackend`、云端 container-per-session。

---

## 快速上手

```bash
git clone https://github.com/thinkany-ai/termany && cd termany
npm install          # postinstall 修 node-pty 权限（macOS 需 Xcode CLT）
npm run dev:web      # PTY server :5175 + web :15173
```

打开 `http://localhost:15173`——出现一个可输入的终端即跑通（这条链路 = WebSocketBackend → ws://localhost:5175 → node-pty → login shell）。桌面开发版：

```bash
npm run dev:desktop  # 同上 + Tauri Dev app（dev server 用 5175，与安装版 5174 隔离）
```

验证 agent 集成：装好 `claude` CLI 并登录后，右侧 rail 打开 Agent 面板，应能在 picker 里看到 Claude 并发起一轮聊天（NDJSON 流式回复）。

---

## 架构设计解析

### 系统架构

Termany 的架构宣言是 **local-first, cloud-ready**：同一份 UI 今天跑在浏览器和桌面 webview 里，明天换掉一个东西就是云服务——那个东西就是 backend。`packages/core/src/backend.ts` 的文件头注释把这称为 "The single seam between 'the terminal UI' and 'where the shell actually runs'"：接缝之上（xterm 渲染、tabs、AI 层）在所有形态间共享，接缝之下每个环境自带实现。目前唯一的实现是 `WebSocketBackend`（连本地或远程 PTY server），进程内 `LocalPtyBackend` 是 Roadmap。

这个决定解释了整个仓库的形状：**PTY 与全部 REST API 住在一个独立 Node 进程里**（`apps/server`），桌面版不是"Rust 直接开 pty"，而是 Tauri 壳 spawn 并看护一个打包好的 Node server（`spawn_server_child()` in `apps/desktop/src-tauri/src/lib.rs`）。`apps/server/src/index.ts:140-147` 的注释写明动机："The SAME server, moved behind auth + a container-per-session sandbox, becomes the cloud backend — the web frontend doesn't change a line." 附带收益是进程寿命独立于窗口：关窗重开，shell 还在跑（`ws.on("close")` 只是 detach，`DETACH_TTL` 默认 7 天后才回收，`index.ts:367-376`）。

![Termany 分层架构](/vibe-reading/images/articles/termany-codewiki-0.2.1/architecture.svg)

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 桌面壳层 | `apps/desktop/src-tauri/` | 包住 web UI 并看护 Node server；窗口/托盘/快捷键/更新等平台事务不渗入 TS 代码 |
| 共享 UI 层 | `apps/web/src/` | 全部界面与前端域逻辑；不知道 shell 跑在哪，只认 `ITerminalBackend` 与 REST 端点 |
| 核心接缝层 | `packages/core/src/` | 定义 UI 与执行环境的契约（接口、wire 协议、runtime 预设）；零依赖，web 经 vite alias 直接编译其 TS 源 |
| 本地服务层 | `apps/server/src/` | PTY host、ACP 运行时、活动追踪、Git/SSH——今天的本地服务，明天的云后端 |
| 外部进程 | 用户机器 | login shell、agent CLI（连同登录态）、ssh——Termany 刻意不复制、不替代它们 |

一个值得注意的例外：`apps/server/src/index.ts` **手工镜像**了 core 的 `ClientMessage`/`SHELL_EXIT_CLOSE_CODE`/`encodeShellExit`（约 230-246 行），因为 server 单独 esbuild 打包、不依赖 workspace 包——这是全仓库唯一的"双份真相"点，改 wire 协议必须同时改两处。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 端口-适配器 | `ITerminalBackend`（backend.ts）+ `WebSocketBackend`（ws-backend.ts） | 换执行环境 = 多写一个实现，UI 零改动；demo 模式注入 `DemoBackend` 同理 |
| God-registry 会话池 | `sessions` Map in `terminal/manager.ts:187` | xterm 实例住在 React 之外，后台化/布局移动不杀会话 |
| 带外元数据通道 | CLOSE 帧 code 4000 携带 `ShellExit`（backend.ts） | 数据流里任何带内哨兵都可能撞上 shell 合法打印的字节 |
| 状态机 + epoch CAS | `AgentIdleWatcher`（web）+ `taskEpoch`（server `agentActivity.ts`） | 屏幕证据可伪造可过时；单调代数保证旧观察不污染新任务 |
| 版本化默认值 + 精确迁移 | `AGENT_RUNTIME_REVISION` + `isLegacyNpxRuntime` in `agentRuntime.ts` | "新增 adapter 不得复活用户显式关掉的旧 adapter" |
| 单一出口 | `emit()` in `index.ts:483` | 所有客户端可见字节（含进度条）统一经过 ring 持久化 + 活动追踪 + 采样 |
| 协议 plug 链 | `createTransferPipeline` in `fileTransfer.ts` | 传输协议与 shell 共享字节流，filter 链免中央 dispatcher 的仲裁问题 |
| 全窗 token 化 | `applyThemeObject` in `themes/index.ts` | 主题是可序列化数据（手写/AI 生成/第三方导入走同一条注册管道） |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Session`（manager.ts） | 一个终端会话：xterm 实例 + backend + 滚动/焦点状态 | 住在模块级 Map，detach 不销毁 | 按 pane id 注册，`activeSessionByPane` 路由 |
| `Pane` / `AgentConversation`（store.ts） | 布局树叶节点；Agent 会话复用同一 leaf 形状 | 随布局持久化到 server SQLite | `HTab.layout` 二叉分裂树的叶 |
| `Runtime`（acpRuntime.ts） | 一个 pane 的 agent 子进程 + ACP 连接 | `acquire()` 缓存复用，agent/显式 cwd 变了才重建 | 被 `runtimes` Map 管理，进程退出自摘除 |
| `AgentActivityTracker`（agentActivity.ts） | server 持有的活动账本（无 TTL） | server 进程级单例 | 由 `noteInput/noteOutput/noteForegroundJob` 喂证据 |
| `ScrollRing`（index.ts） | 活会话的输出尾缓冲（512KB 上限） | 会话级，detach/close/10s 定时三重落库 | 播种自 SQLite，跨启动拼接 |
| `SshPortForwarding`（sshPortForwarding.ts） | per-session 转发状态（controlPath/forwards/probe 缓存） | pane spawn 时 prepare/register，onExit 时 remove | 复用 pane ssh 的 ControlMaster 连接 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `ITerminalBackend` | `packages/core/src/backend.ts` | `WebSocketBackend`、`DemoBackend`（demo.ts） | manager 的 `spawnBackend()` 按环境二选一 |
| `TransferProtocol` | `apps/server/src/fileTransfer.ts` | `trzszProtocol`（trzszFilter.ts） | `TRANSFER_PROTOCOLS` 数组，本地 pane 传空数组 |
| `AcpRuntimeEvent` | `acpRuntime.ts:34-42` | delta/thought/tool/image/permission/done… | `prompt()` 的 update 分发循环翻译 `session/update` |
| `Theme` | `apps/web/src/themes/types.ts` | 14 个内置 + Codex 导入 + AI 生成 | `THEMES` 数组 / `registerTheme()` 运行时注册 |

---

## 代码目录

```
termany/
├── apps/
│   ├── web/                  # 共享 UI（React + xterm.js，~56k 行）
│   │   └── src/
│   │       ├── state/        # store.ts 布局真源镜像 + sync/layoutMerge 多窗口合并
│   │       ├── terminal/     # manager.ts 会话池 + 屏幕活动分析 + OSC/IME 修复
│   │       ├── components/   # AgentPane/AgentWorkspace/SplitView/FileTree 等
│   │       ├── agent*.ts     # ~30 个聊天域纯函数模块（各带 .test.ts）
│   │       ├── themes/       # 14 主题 + CodexThemes 导入三件套
│   │       └── i18n/         # 21 locale（flat dot-key，en 为 source）
│   ├── server/               # Node PTY/API 服务（~11k 行）
│   │   └── src/
│   │       ├── index.ts      # 单文件 2019 行：HTTP+WS server + 全部路由 + wireSession
│   │       ├── acp*.ts       # ACP 运行时、managed/native bridge、兼容层
│   │       ├── agent*.ts     # 活动追踪、会话历史、配置、凭证
│   │       ├── git.ts ssh*.ts fileTransfer.ts systemStats.ts db.ts …
│   │       └── tests/        # fixtures + 集成测试
│   └── desktop/              # Tauri 2 壳（Rust ~1.4k 行）
│       └── src-tauri/        # lib.rs 全部逻辑 + 平台 conf/entitlements
├── packages/
│   └── core/                 # 唯一接缝（322 行，零依赖）
└── scripts/                  # bundle-server.mjs 打包链 + run-tauri.mjs 工具链防御
```

---

## 模块地图

静态职责与依赖方向见下图——web 侧与 server 侧各自 import `packages/core`（接缝的两侧），桌面壳 spawn server 并以 webview 载入 web；server 内部由 `index.ts` 统一路由到各域模块：

![模块依赖关系](/vibe-reading/images/articles/termany-codewiki-0.2.1/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 核心接缝 | UI 与执行环境的契约 | `backend.ts` 的 `ITerminalBackend` | 零依赖、被两侧共享，是"换环境不改 UI"的全部赌注 | [01](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/01-core-backend) |
| PTY 服务 | node-pty host + REST 路由 + 持久化 | `index.ts` 的 `wireSession()` | 一个端口同时服务 WS 升级与 REST；进程寿命独立于窗口 | [02](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/02-server-pty) |
| ACP 运行时 | agent 子进程与聊天协议 | `acpRuntime.ts` 的 `acquire()` | 把 11 家 agent 的差异消化在 server 侧，前端只见统一事件流 | [03](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/03-acp-runtime) |
| 活动与会话历史 | pane 状态判定 + transcript 解析 | `agentActivity.ts` 的 `AgentActivityTracker` | "谁在等你"是独立于渲染的账本问题，证据源横跨前后端 | [04](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/04-agent-activity) |
| Git 与 SSH | 仓库视图与远程主机 | `git.ts` 的 `gitOverview()` | 只读 porcelain 子进程 + ControlMaster 转发，两套外部世界适配 | [05](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/05-git-ssh) |
| 状态与布局 | 四级嵌套 + 多窗口同步 | `store.ts` 的 `useStore` | 布局真源在 server，webview 只是倒影；merge 规则是独立学问 | [06](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/06-web-layout) |
| 终端引擎 | xterm 会话池与宿主怪癖 | `manager.ts` 的 `getSession()` | 会话与渲染分离是"后台 tab 保活"承诺的实现载体 | [07](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/07-web-terminal) |
| Agent 聊天前端 | 聊天 UI 与群聊编排 | `AgentPane.tsx` 的 `submit()` | ~30 个域纯函数模块支撑可测试的群聊/A2A/私信路由 | [08](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/08-web-agent-chat) |
| 主题与组件 | 全窗主题 + i18n + 配套工具 | `themes/index.ts` 的 `applyThemeObject` | token 化让手写/AI 生成/第三方包走同一管道 | [09](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/09-theme-components) |
| 桌面壳 | Tauri 壳与打包链 | `lib.rs` 的 `spawn_server_child()` | 平台事务（版本仲裁/退出确认/原生集成）收口在 Rust 一处 | [10](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/10-desktop-shell) |

---

## 运行时行为

### 启动流程

**桌面版**（release）：Tauri `setup()`（`lib.rs:1148-1262`）→ `start_server()` → `spawn_server_child()`：先 `existing_server_matches()` 手写 HTTP GET `/api/version` 比对烧进 bundle 的版本号，匹配则复用已在跑的 server（上一版 app 留下的活 shell 因此存活）；不匹配且有 running 任务则推迟，否则 `kill_termany_server_on_port()` 只杀自己的 server 再 spawn `<Resources>/resources/server/node server.cjs`（stdout 重定向 `server.log`）→ watchdog 线程 500ms 轮询、意外退出自动重启 ≤3 次。webview 载入 `web/dist` 后：`main.tsx` 先 `applyTheme(loadThemeId())`（先于首渲染上色）→ `waitForServer()`（sync.ts:38，轮询 `/api/state` 最多 12s，容忍 server 慢启动）→ `loadState()` 从 SQLite 水合布局 → `adoptView()` 落位本窗口视点 → 首次 render。

**纯 web**（`dev:web`）：concurrently 同起 `dev:server`（tsx watch，端口 5175）与 Vite（15173），浏览器直连——与桌面版走完全相同的 `WebSocketBackend` 代码路径。

### 核心运行流程

下面三条链路覆盖 Termany 运行时的主干：终端的每一次按键往返、agent 聊天的每一轮流式回复、以及多窗口间的布局同步。

![端到端数据流](/vibe-reading/images/articles/termany-codewiki-0.2.1/data-flow.svg)

#### 终端：PTY 往返

按键 → xterm `term.onData` → `writeTerminalInput()`（manager.ts:840；若检测到 agent 输入提交，先 `registerRemoteAgentActivity` 让黄点先于 Enter 落地——经 `terminalInputSendChains` promise 链保证顺序）→ `WebSocketBackend.write()` 发 `ClientMessage` JSON 文本帧 → server `applyClientMessage()` 过 trzsz 过滤器后 `pty.write` → shell 输出 → `emit()`（index.ts:483，单一出口：ws.send + ringAppend + 活动追踪 + 前台进程采样）→ **原始文本帧无包装直达** → `writeSessionData()` → `term.write` → WebGL 渲染。退出走旁路：`pty.onExit` → CLOSE 帧 4000 + ShellExit JSON → `parseShellExit` → `shellExitDisposition` 三判据（signal / 存活<3s / unknown → restart ≤5；否则 close pane）。

#### Agent：ACP 聊天一轮

`AgentPane.submit()` → `POST /api/agent/acp/chat`（立即 NDJSON 响应头 + 10s heartbeat）→ `promptAcpRuntime()` → `acquire()` 按 paneId 复用或重建 `Runtime` → `Runtime.prompt()` 经 stdio JSON-RPC 发 `session/prompt` → agent 的 `session/update` 通知流被翻译成 `AcpRuntimeEvent` → `res.write` 逐行 NDJSON → web `reply()` 增量组装 `AgentMessage`（streaming 占位不落库，结束才 persist）→ 群聊场景下再由 `runGroupConversation()` 决定下一批成员。权限请求是独立回路：agent 发 `session/requestPermission` → `Runtime.requestPermission` 悬挂 Promise 并 emit permission 事件 → 前端按钮 → `POST /api/agent/acp/permission` → `respondPermission` resolve 回写 stdin。

#### 同步：多窗口布局合并

窗口 A 改布局 → zustand `subscribe` → debounced 400ms `PUT /api/state`（带 `clientId`）→ server 整表重写并 SSE 推 `/api/state/events` → 窗口 B `applyRemoteState()`（sync.ts:157）跳过自己的回声 → `mergeLayout()`（layoutMerge.ts:42）：**page 独占是免版本号的仲裁基础**——本窗口拥有的 page 它是唯一写者、副本必胜，其余照抄发送方。两个安全网：本窗口 page 被远端删了就 `adoptView` 重落位；远端快照落后就立即回写。

### 状态流

四台状态机刻画运行时的关键生命周期——pane 的 agent 活动状态（证据分级 + epoch CAS）、WebSocket 连接的初次重试与终态、shell 退出的处置决策、ACP Runtime 的进程生命周期：

![运行时状态流](/vibe-reading/images/articles/termany-codewiki-0.2.1/state-flow.svg)

活动状态的转换证据按可信度分级：输入行/TUI 横幅（可伪造）< OSC 778 显式上报（权威）< 前台进程组归还（不可伪造）。`done → working` 的回翻只允许"同 epoch 的 spinner 还在重绘"一种情况（`reportWorking` 的 green latch，agentActivity.ts:313-329）；连接状态以 `everOpened` 为分水岭——从未连上可重试 ≤8 次（server 启动竞速），连上之后的 close 就是会话终态。

---

## 典型修改场景

#### 场景 1：接入一个新 agent（如自带 `foo acp` 子命令的 CLI）

`packages/core/src/agentRuntime.ts` 的 `BUILTIN_RUNTIMES` 加 `foo: stdio("foo", "acp", 6)`（revision 填当前 `AGENT_RUNTIME_REVISION`）→ `apps/server/src/agentConfig.ts` 的 `BUILTIN_AGENTS` 加条目 → `nativeAcp.ts` 的 `NATIVE_AGENTS` 加 id（老版本 CLI 会把未知参数当 prompt，必须先 probe `--help`）→ 前端 `agents.ts` 的 `DEFAULT_AGENTS` + `agentInstall.ts` 的 `INSTALLERS`。对应测试：`agentConfig.test.ts`、`nativeAcp.test.ts`。

#### 场景 2：新增一个 REST 端点

`apps/server/src/index.ts` 的 if-else 路由链按惯例加分支（模式固定：`readJson(req).then(body => json(200, …)).catch(fail)`），逻辑重就抽独立文件。注意这个 2019 行 god file 是刻意选择——零框架依赖、`/api/version` 注释明说要 "cheap and dependency-free so it answers even if everything else is broken"。对应测试：server 各 `*.test.ts`。

#### 场景 3：新增一种 pane 视图类型（如 docker 监视器）

`store.ts` 的 `PaneView` union 加值 → `paneViewCycle.ts` 的 `CYCLABLE_PANE_VIEWS`（自动进 ⌘E 循环）→ `rail-config.ts`（右栏 + Settings 可见性）→ `SideRail.tsx` 加图标 → 新建组件并在 `SplitView.tsx:464-497` 的 view 分发链加分支。对应测试：`paneViewCycle.test.ts`、`rail-config.test.ts`。

---

## 测试体系

```
apps/server/src/*.test.ts     # 域模块单测（agentActivity/acpRuntime/git/ssh…）
apps/server/tests/            # 集成测试 + fixtures/（native-acp、group-chat 等 mock agent）
apps/web/src/**/*.test.ts     # 前端域模块单测（agent*/terminal/themes/keybindings…）
apps/web/src/terminal/fixtures/agent-screens/   # 录制的真实 agent 屏幕文本
```

全部用 Node 内置 test runner（`node --import tsx --test`），无 vitest/jest。测试哲学有两个亮点：一是**录屏即证据**——`agentActivityPrompt.test.ts`/`agentIdleWatcher.test.ts` 对 `fixtures/agent-screens/` 里录制的 Claude/Codex 真实渲染屏重放断言；二是**纯函数域模块**——web 侧 ~30 个 `agent*.ts` 顶层文件零 React 依赖，正是为了能直接构造数据断言（`agentGroupChat.test.ts` 466 行覆盖提及路由/决策校验/failover）。

---

## 阅读源码推荐路线

- 第一遍：理解接缝与主链路
  `packages/core/src/backend.ts`（契约 + 文件头注释）→ `ws-backend.ts`（唯一实现）→ `apps/server/src/index.ts` 只读三段：wireSession()（469-537）、wss connection handler（1787-1987）、shutdown()（1994-2017）
- 第二遍：理解前端两大骨架
  `apps/web/src/state/store.ts` 的类型定义区（150-330 行：Pane/HTab/TreeNode/Workspace）→ `terminal/manager.ts` 的 `getSession()` 与 `attachSession()` → `App.tsx` 的 handlers map
- 第三遍：理解 agent 集成
  `packages/core/src/agentRuntime.ts`（BUILTIN_RUNTIMES 预设表）→ `apps/server/src/acpRuntime.ts` 的 `Runtime.create/prompt/requestPermission` → `apps/web/src/components/AgentPane.tsx` 的 `submit()/reply()` → `agentGroupChat.ts` 的 `runGroupConversation()`
- 第四遍：选重点模块深入（见模块地图）——建议活动追踪（`agentActivity.ts` + `agentActivityPrompt.ts` 双层感知）与桌面壳（`lib.rs` 的 `spawn_server_child()` 版本仲裁）

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| ACP | Agent Client Protocol，JSON-RPC over stdio 的 agent 客户端协议；Termany 经 `@agentclientprotocol/sdk` 消费 |
| Pane / Page / Tab | 布局树叶节点 / 树节点（Notion 式既是页又是文件夹）/ 每节点挂的终端标签条 |
| OSC 778 | Termany 约定的自定义 OSC 序列 `778;(working\|done\|error)`，agent 显式上报状态的权威通道 |
| epoch（taskEpoch） | 活动账本的单调代数；屏幕证据只允许改写其观察到的那个代数 |
| managed / system / custom | runtime 分发的三种形态：Termany 打包的 bridge / 用户 PATH 上的 CLI / 用户手写配置 |
| trzsz | 跨 SSH 的内联文件传输协议（`trz`/`tsz` 命令族），与 shell 共享同一条字节流 |
| ControlMaster | OpenSSH 连接复用；pane 的交互式 ssh 即 master，端口转发是 `-O forward` 控制请求 |
| NDJSON | 换行分隔 JSON；聊天流与 `ClientMessage` 都用它（SSE 只用于 activity/state 两条通知流） |
| BYOK | bring your own key；模型凭证存 server 侧 SQLite，浏览器只见到掩码 |

### 参考资料

- [termany.sh](https://termany.sh) — 官网（下载、文档、release notes）
- [Agent Client Protocol](https://agentclientprotocol.com) — ACP 规范
- [Tauri 2](https://tauri.app) / [xterm.js](https://xtermjs.org) / [trzsz](https://trzsz.github.io) — 三大底层依赖
