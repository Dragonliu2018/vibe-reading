---
source:
  type: "源码解读"
  project: "sidex"
  url: "https://github.com/Sidenai/sidex"
title: "Overview"
date: "2026-08-18T15:41:58+08:00"
category: [Tools, IDE, SideX, CodeWiki, "0.1.3"]
tags: ["sidex", "Rust", "Tauri 2", "VSCode", "IDE", "Code editor", "Extension"]
description: "SideX 0.1.3 源码架构解读——用 Tauri 2 + Rust 后端替换 VSCode 的 Electron 层，保留同一套 TypeScript workbench"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 0.1.3 · **协议** MIT · **语言** Rust 1.91 + TypeScript · **框架** Tauri 2 · **代码量** ~98,500 行 Rust（19 crate + src-tauri）· ~958,000 行 TS（VSCode workbench 移植）· **仓库** [GitHub](https://github.com/Sidenai/sidex)

---

## 总览

### 项目简介

SideX 是 **Visual Studio Code 的移植版**——用 [Tauri 2](https://tauri.app/)（Rust 后端 + 操作系统原生 webview）替换掉 Electron。同一套 TypeScript workbench、同一个 Monaco 编辑器、集成终端、Git 集成，跑在没有打包 Chromium 的进程里。

SideX 解决的核心问题是：**VSCode 的内存几乎全部来自它打包的 Chromium，而非编辑器本身**。Tauri 用系统已有的 webview（macOS WKWebView、Windows WebView2）替代这个打包浏览器——它跨应用共享，额外开销几乎为零。README 的对比图给出 SideX 16.4 MB vs VSCode 797.8 MB（macOS 空闲态），目标是 **macOS 空闲低于 200 MB**。

核心使用场景是日常代码编辑——Monaco 编辑、集成终端、Git 操作、文件搜索、语法高亮都已"solid"，扩展宿主与调试器仍在进行中。**项目边界**：SideX 负责把 VSCode 的 Electron/Node.js 原生层逐一替换为 Rust 实现，**不改动 VSCode 的 TypeScript workbench 源码**——前端是 `microsoft/vscode` 的直接移植，只新增一层 `sidex*.ts` service 适配 Tauri IPC。因此本系列解读聚焦**原创的 Rust 后端**（~98,500 行），而非直接移植的 TS workbench。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|----------|------|
| Tauri IPC 桥 | `src/vs/sidex-bridge.ts` + `src-tauri/src/lib.rs` | invoke/emit/listen + sidex-asset 协议 |
| 文件系统 | `crates/sidex-workspace` + `commands/fs.rs` | 读写/目录/路径，notify 文件监听 |
| 搜索 | `commands/index.rs` + `commands/search.rs` | dashmap 倒排索引 + rayon 并行全文搜索 |
| 集成终端 | `crates/sidex-terminal` + `commands/terminal.rs` | portable-pty PTY，OSC 633 shell 集成 |
| Git | `crates/sidex-git` + `commands/git.rs` | 系统 git CLI 封装（gix 预留未用） |
| 语法高亮 | `crates/sidex-textmate` + `crates/sidex-syntax` | TextMate grammar + tree-sitter |
| 文本缓冲 | `crates/sidex-text` | ropey rope，Position/Range 共享类型 |
| LSP | `crates/sidex-lsp` + `commands/lsp.rs` | Language Server Protocol 客户端 |
| 扩展系统 | `crates/sidex-extensions` + `commands/extension_wasm.rs` | Node sidecar + WASM 组件双轨 |
| 远程开发 | `crates/sidex-remote` + `commands/remote.rs` | russh SSH + bollard Docker |
| 调试器 | `crates/sidex-dap` + `commands/debug.rs` | Debug Adapter Protocol 客户端 |
| 存储配置 | `crates/sidex-db` + `crates/sidex-settings` | 三个 SQLite 库 + 分层设置 |
| 自动更新 | `crates/sidex-update` + `commands/updater.rs` | 自研 Ed25519 签名更新器 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| **Tauri 2** | 核心 | Rust 后端 + 原生 webview，命令/事件 IPC |
| **Rust 1.91** | 核心 | 后端语言，workspace 19 crate + src-tauri |
| **TypeScript / Vite 6** | 核心 | 前端 workbench（VSCode 移植） |
| **Monaco Editor** | 核心 | 编辑器内核（前端，同 VSCode） |
| **xterm.js** | 核心 | 终端 UI + WebGL renderer |
| **portable-pty** | 核心 | PTY（替代 node-pty） |
| **notify** | 核心 | 文件监听（FSEvents/macOS，替代 @parcel/watcher） |
| **rusqlite** | 核心 | SQLite（bundled，替代 @vscode/sqlite3） |
| **wasmtime 43** | 核心 | WASM 扩展运行时（component-model） |
| **tree-sitter** | 核心 | 语法解析 |
| **gix** | 预留 | 工作区声明但**未引用**，Git 实走系统 CLI |
| **russh / bollard** | 核心 | SSH / Docker 远程 |
| **reqwest** | 核心 | HTTP（市场、更新、网络代理） |

### 版本历史

SideX 处于早期发布阶段（README 标注 "Early release"）。当前 `package.json` 版本 0.1.3，Rust workspace 版本 0.2.0，HEAD 落在最新 tag `v0.1.2` 之后 93 个提交。这一阶段的演进主线是 **逐层替换 Electron API**：`BrowserWindow → WebviewWindow`、`ipcMain/ipcRenderer → invoke/emit`、Node.js `fs/pty` → Rust 命令。`ARCHITECTURE.md` 的 Electron API 替换映射表记录了 23 项中 19 项 "Ported"、4 项 "Partial/Not started"（safeStorage、crypto、powerMonitor、native-keymap）。扩展宿主与调试器标注 "in progress"，是当前主要缺口。

### 顶层上下文图

SideX 作为桌面 IDE，外部交互方有：用户（键鼠操作）、操作系统（webview、PTY、文件系统、菜单、keyring）、远程主机（SSH/Docker）、扩展市场（Open VSX / SideX marketplace）、更新源（Ed25519 签名 manifest）。Git 操作依赖系统安装的 `git` CLI。语言服务器（rust-analyzer、tsserver 等）与调试适配器作为子进程由 Rust 后端 spawn。

---

## 快速上手

```bash
git clone https://github.com/Sidenai/sidex.git
cd sidex
npm install
npm run tauri dev
```

`npm install` 装前端依赖，`npm run tauri dev` 启动开发模式——Vite 起 dev server，Tauri 编译 Rust 后端（首次约 5–10 分钟）并打开 webview 窗口。一个端到端验证：窗口打开后 `Cmd+N` 新建文件、敲几行代码看到 Monaco 高亮、`Ctrl+` `` ` `` 打开终端执行 `ls`、左侧 Source Control 面板能看到当前目录的 Git 状态——证明 TS workbench ↔ Tauri IPC ↔ Rust 后端整条链路通了。

> 首次构建需 `NODE_OPTIONS="--max-old-space-size=12288"`（前端打包内存）+ Rust 编译时间。预编译二进制尚未分发。

---

## 架构设计解析

### 系统架构

SideX 的架构思想是 **"前端不动，后端换核"**——VSCode 的分层 TypeScript workbench（`base → platform → editor → workbench`）原封不动跑在原生 webview 里，所有原本由 Electron 主进程 / Node.js 原生模块提供的能力，逐一替换为 Rust 命令。Tauri 2 的 `invoke()` / `emit()` / `listen()` 取代 `ipcMain` / `ipcRenderer`，`WebviewWindow` 取代 `BrowserWindow`。

![SideX 分层架构](/vibe-reading/images/articles/sidex-codewiki/architecture.svg)

从上到下五层：**Webview 渲染层**是 VSCode workbench 移植，最底部新增极薄的 `sidex-bridge.ts`（仅 41 行）封装 `window.__TAURI__.core.invoke`；**Tauri IPC 边界**做 JSON 序列化的命令分发与事件推送，外加 `sidex-asset://` 自定义协议让 webview 受控访问本地文件；**Rust 命令层**（`src-tauri/src/commands/`，41 个文件）是 Tauri 命令处理器，`lib.rs` 的 `run()` 用 `.manage()` 注册 19 个 `Arc` 包裹的共享状态、用 `generate_handler!` 注册约 250 个命令，`mod.rs` 用 glob re-export 把 `commands::fs::read_file` 打平成 `commands::read_file`；**Rust 领域 crate**（`crates/`，19 个）承载真正业务逻辑；**OS 原生能力**是 portable-pty、notify、rusqlite、git CLI、russh、bollard、wasmtime 等。

分层解决了"前端是别人的代码、后端是我们的代码"这一约束——workbench 不感知后端是 Electron 还是 Tauri，只需 service 层把 `fs.readFile` 从 Node 实现换成 `invoke('read_file')`。`sidex-bridge.ts` 极薄是因为业务适配（参数转换、错误映射）都下沉到各 `sidex*Service.ts`，bridge 只负责"能不能调 Tauri"的探测与统一入口。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 渲染层 | `src/vs/{base,platform,editor,workbench}` + `sidex*.ts` | VSCode workbench 移植，UI 与编辑器逻辑；新增 service 层把 Node 调用改成 Tauri invoke |
| IPC 边界 | `src/vs/sidex-bridge.ts` + Tauri runtime | 隔离前端与后端传输细节，保护 workbench 不感知 IPC 实现 |
| 命令层 | `src-tauri/src/commands/` + `lib.rs` | Tauri 命令注册、共享状态注入、参数反序列化、返回 serde 序列化 |
| 领域层 | `crates/sidex-*` | 各领域纯业务逻辑，不依赖 Tauri，可独立测试 |
| 基础设施 | portable-pty / notify / rusqlite / wasmtime / ... | 适配 OS 资源，可替换 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Service Locator / DI | `lib.rs` `.manage()` + `State<'_, Arc<T>>` | 命令函数声明需要什么 State，Tauri 按类型自动注入；省去手写 DI 容器 |
| Facade | `sidex-bridge.ts:30` `invoke()` | 极薄封装 `__TAURI__.core.invoke`，提供 graceful fallback（浏览器开发模式） |
| Protocol Handler | `lib.rs:396` `register_asynchronous_uri_scheme_protocol` | `sidex-asset://` 受控代理本地文件，绕开 webview 的 `file://` 限制 |
| Event Dispatcher | `lib.rs:512` `on_menu_event` + `main.ts:417` | 原生菜单点击经 `window.eval` 注入 CustomEvent → 前端二级分发到命令 |
| Registry | `sidex-extension-api` `CommandRegistry`、`sidex-dap` `DebugAdapterRegistry`、`sidex-lsp` `ServerRegistry` | 扩展点契约，按 ID 查找实现 |
| Observer | terminal `app.emit("terminal-data")`、LSP `app.emit("lsp-notification")`、DAP `app.emit("dap-event")` | 后端持续事件流推送前端 |
| State Machine | `sidex-update` 11 态 `State` 枚举、`sidex-dap` `SessionState` | 对齐 VSCode TS 类型，前端原样转发 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `TerminalStore` / `ProcessStore` | PTY 会话表（id→handle） | App 级，`.manage()` 注册 | 命令函数按 id 借用 |
| `LspState` | 语言服务器实例表（id→`Arc<LspClient>`） | App 级 | 每个 server 独立 tokio 子进程 |
| `WasmExtensionRuntime` | wasmtime 引擎 + 已加载 WASM 扩展 | App 级 | 每扩展独立 `Store<WasmHostState>` |
| `IndexStore` | 全文倒排索引（trigram） | App 级 | dashmap 并发索引 |
| `StorageDb` / `SidexDbState` | 两个 SQLite 库连接 | App 级 | `Mutex<Connection>` |
| `Buffer` (`sidex-text`) | ropey rope 文本缓冲 + 行尾 | 文档级 | 被 syntax/lsp 共享作类型桥梁 |
| `StateStackImpl` (`sidex-textmate`) | TextMate tokenize 跨行状态栈 | 行级，handle 引用 | 不可变链表 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|-------------|----------|--------|----------|
| `RemoteTransport` trait | `crates/sidex-remote/src/transport.rs` | `SshTransport`、`ContainerTransport` | `RemoteManager::connect_*` |
| `TokenSink` / `GrammarRuntime` trait | `crates/sidex-textmate/src/tokenizer/contracts.rs` | `LineTokens`、`Arc<AttributedScopeStack>` | 解耦 tokenizer 热路径与 grammar |
| `UpdateObserver` trait | `crates/sidex-update/src/manager.rs` | `EventEmitter` | `set_observer` |
| WIT `host-api` interface | `src-tauri/wit/world.wit` | `WasmHostState` (impl Host) | `wasmtime::component::bindgen!` |

---

## 代码目录

```
sidex/
├── src/                        # TypeScript workbench（VSCode 移植）
│   ├── vs/
│   │   ├── base/                # 基础工具
│   │   ├── platform/           # 平台服务 + DI；sidex/ 子目录是 Tauri 适配层
│   │   ├── editor/             # Monaco 编辑器
│   │   └── workbench/          # IDE shell，contrib/ 92 特性、services/ 90 服务
│   ├── main.ts                 # 前端入口 + 菜单事件接收
│   └── sidex-bridge.ts         # 41 行 invoke 封装
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── commands/           # 41 个 Tauri 命令文件
│   │   ├── lib.rs              # run()：State 注册 + generate_handler! + setup
│   │   └── main.rs             # 进程入口
│   └── wit/world.wit           # WASM 扩展 WIT 契约（~900 行）
├── crates/                     # 19 个领域 crate
│   ├── sidex-workspace/        # 文件系统、工作区、搜索索引
│   ├── sidex-text/             # ropey 文本缓冲（高扇入基础）
│   ├── sidex-syntax/           # tree-sitter 语法
│   ├── sidex-textmate/         # TextMate grammar + 主题（最大 crate）
│   ├── sidex-terminal/         # PTY 终端
│   ├── sidex-git/              # Git CLI 封装
│   ├── sidex-lsp/              # LSP 客户端
│   ├── sidex-extensions/       # 扩展管理 + Node 宿主
│   ├── sidex-extension-api/    # 扩展 API shim + CommandRegistry
│   ├── sidex-remote/           # SSH/Docker 远程
│   ├── sidex-dap/              # 调试适配器协议
│   ├── sidex-db/               # SQLite 状态存储
│   ├── sidex-settings/         # 分层设置 + JSONC
│   ├── sidex-update/           # 自动更新
│   ├── sidex-theme/keymap/...  # 主题、键映射、任务等
│   └── ...
├── extensions-rust/            # 原生 WASM 扩展源码（6 语言，workspace 外）
├── sidex-extension-sdk/        # WASM 扩展开发 SDK
└── Cargo.toml                  # workspace 根
```

---

## 模块地图

![SideX Rust crate 依赖关系](/vibe-reading/images/articles/sidex-codewiki/module-dependencies.svg)

依赖关系图揭示一个关键特征——**松耦合**：除 `sidex-text`（Position/Range/Rope 共享类型）和 `sidex-db`（状态存储）被 syntax/lsp/workspace 引用作基础外，各领域 crate 互相独立，互不依赖。`src-tauri/commands` 是唯一的全局装配点，依赖全部 crate。这意味着每个领域可以独立演进、独立测试，代价是部分逻辑重复（如 terminal 的 shell 检测有三份实现、IndexStore 在 crate 与 commands 层各有一份）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| 桥接层与命令分发 | Tauri IPC 桥、状态注册、命令分发、sidex-asset 协议 | `lib.rs::run()` | 是唯一装配点，连接前端与全部后端 | [桥接层与命令分发](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/01-bridge-commands) |
| 文件系统与工作区 | 文件 I/O、notify 监听、搜索索引 | `commands::fs::*` / `IndexStore` | 封装 OS 文件能力，独立于编辑逻辑 | [文件系统与工作区](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/02-filesystem-workspace) |
| 集成终端 | portable-pty PTY、shell 检测、OSC 633 | `terminal_spawn` | 替代 node-pty，独立的进程/IO 子系统 | [集成终端](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/03-terminal) |
| Git 集成 | 系统 git CLI 封装、porcelain 解析 | `git_status` | 独立的版本控制领域，无跨 crate 依赖 | [Git 集成](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/04-git) |
| 语法高亮与 TextMate | TextMate grammar tokenize + tree-sitter | `textmate_tokenize_line_binary` | 独立的高亮/tokenize 流水线 | [语法高亮与 TextMate](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/05-syntax-textmate) |
| 文本缓冲区 | ropey rope、Myers diff、Position/Range | `Buffer` / `simple_diff` | 共享类型基础，被 syntax/lsp 引用 | [文本缓冲区](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/06-text-buffer) |
| LSP 语言服务 | 语言服务器进程、JSON-RPC、能力协商 | `lsp_start_server` | 独立的语义智能领域 | [LSP 语言服务](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/07-lsp) |
| 扩展系统 | Node sidecar + WASM 组件双轨、市场 | `WasmExtensionRuntime` / `ExtensionPlatformSupervisor` | 最大最复杂模块，独立成体系 | [扩展系统](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/08-extensions) · [WASM 运行时](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/08-extensions-wasm-runtime) |
| 远程开发 | russh SSH + bollard Docker + 隧道 | `RemoteManager` | 独立的远程后端抽象 | [远程开发](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/09-remote) |
| 调试器 | DAP 客户端、请求-响应关联 | `DebugClient` / `DapClientStore` | 独立的调试协议领域 | [调试器](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/10-dap) |
| 存储与配置 | 三个 SQLite 库、分层设置、更新、密钥 | `StorageDb` / `SidexDbState` / `SettingsStore` | 持久化与配置基础设施 | [存储与配置](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/11-storage-settings) |

---

## 运行时行为

### 启动流程

```
main.rs main()
  └─ sidex_lib::run()                                  in src-tauri/src/lib.rs:372
       ├─ tauri::Builder::default()
       ├─ .plugin(dialog) .plugin(shell)               Tauri 插件
       ├─ .manage(Arc::new(TerminalStore)) ... ×19     builder 阶段注册 17 个共享 State
       ├─ .register_asynchronous_uri_scheme_protocol("sidex-asset", ...)   本地文件代理
       ├─ .setup(|app| {
       │    ① app_data_dir → create_dir_all
       │    ② StorageDb::new(sidex_storage.db)         扁平 KV 库
       │    ③ restore_and_show(app, &db)               从 KV 恢复窗口几何 + window.show()
       │    ④ app.manage(Arc::new(db))
       │    ⑤ SettingsStore::load_user(settings.json)  预加载用户设置
       │    ⑥ sidex_db::Database::open(sidex_state.db) 结构化状态库
       │    ⑦ ProcessStore::set_app_handle            （空实现，历史遗留）
       │    ⑧ updater/profiles/secrets::initialize     三个可选子系统，失败只 warn
       │    ⑨ build_menu (macOS) → set_menu            原生菜单
       │    ⑩ devtools (debug)
       │  })
       ├─ .on_menu_event(→ window.eval CustomEvent)    菜单事件注入前端
       └─ .invoke_handler(generate_handler![ ... ~250 cmds])
```

启动顺序的依赖链是 `app_data_dir → StorageDb → restore_and_show`——窗口必须在 KV 库初始化后才能恢复几何状态；`SettingsStore` 在 builder 已 `.manage()` 但内容空，需在 setup 中 `load_user` 填充；updater/profiles/secrets 是"尽力而为"子系统，初始化失败用 `log::warn!` 降级，不阻断启动。`ProcessStore::set_app_handle` 标注 "Intentionally empty — kept for API compatibility"，是历史遗留的空函数。

### 核心运行流程

概览选三条覆盖不同通信模式的链路——请求-响应、请求-响应+持续事件流、能力协商+推送。

#### 请求-响应：Git 状态查询

业务流程：用户切到 Source Control 面板 → 前端 `invoke('git_status', {path})` → Rust 校验路径 → 调系统 `git status --porcelain=v2` → 解析为 `Vec<GitChange>` → 返回 → 前端按 staged/unstaged 分组刷新 SCM 视图。

![终端请求数据流（请求-响应 + 事件流）](/vibe-reading/images/articles/sidex-codewiki/data-flow.svg)

`git_status` 是 `#[tauri::command] pub async fn` 但函数体内无 `.await`——实际是同步阻塞的 `std::process::Command::output()` 等待 git 子进程，会占用 tokio worker 线程。`GitError`（thiserror 枚举）经 `git_err()` 格式化为 `String` 返回，前端 `try/catch` 捕获 rejected Promise。`validate_path` 拒绝空路径、NUL 字节、`..` 目录遍历。

#### 请求-响应 + 事件流：集成终端

终端是唯一需要持续事件流的链路：前端 `invoke('terminal_spawn', {...})` → Rust 用 `native_pty_system().openpty` 开 PTY、spawn shell、分配 id 存入 `TerminalStore`、立即 `std::thread::spawn` reader 线程 → 返回 `terminal_id`。之后 reader 线程持续 `app.emit("terminal-data", {id, data})` 推送 PTY 输出，前端 `_listen('terminal-data')` 收到后 `_onProcessData.fire` 喂给 xterm.js。用户键入走 `invoke('terminal_write', {id, data})` → `handle.writer.write_all`。`terminal_spawn` 是同步 `fn`（Tauri 主线程执行），reader 用 OS 线程而非 tokio——正确选择，因为 `reader.read()` 是阻塞 I/O。注意当前前端用的是第一代 `terminal_*` 命令（事件推送、无背压），第二代 `term_*`（RingBuffer + bounded channel 背压）已注册但前端未接入。

#### 能力协商 + 推送：LSP

`lsp_start_server` → `LspClient::start` spawn 语言服务器子进程（`tokio::process::Command`，`kill_on_drop(true)`）→ 发 `initialize` 请求协商能力 → 存 `ServerCaps` → 发 `initialized` 通知 → 注册 `notification_handler` 把服务器推送（`publishDiagnostics`、`$/progress`）经 `app.emit("lsp-notification")` 转发前端。后续补全/定义/引用请求走 `lsp_send_request` 转发。关键限制：`send_request` 持 transport Mutex 直到收到匹配 response——**单服务器内请求串行**，不能并发（与 VSCode 用 correlation map 支持并发的实现不同）。`DiagnosticManager` 已在 crate 定义但命令层未使用，诊断路由由前端处理。

### 状态流

SideX 有两个值得注意的状态机。**更新器**（`sidex-update/src/state.rs`）11 态：`Uninitialized → Idle → CheckingForUpdates → AvailableForDownload → Downloading → Downloaded → Ready → Updating → Restarting`，外加 `Disabled`/`Overwriting`；序列化用 `#[serde(tag="type", rename_all="kebab-case")]` 与 VSCode TS `State` 类型对齐。**调试会话**（`sidex-dap/src/session.rs`）4 态：`Initializing → Running → Stopped → Terminated`，但 `DebugSession` 在 crate 定义后 Tauri 命令层未接线，状态追踪是 TODO。

---

## 典型修改场景

#### 场景 1：新增一个 Rust 命令

在 `src-tauri/src/commands/<模块>.rs` 加 `#[tauri::command] pub fn xxx(...) -> Result<T, String>`；在 `commands/mod.rs`（新模块还要 `pub mod` + `pub use`）；在 `lib.rs:521` 的 `generate_handler!` 加 `commands::xxx,`；前端某 `sidex*Service.ts` 调 `invoke<T>('xxx')`。若需共享状态，在 `lib.rs:376` 附近 `.manage(Arc::new(YourStore::new()))`。

#### 场景 2：新增一个扩展 API 能力

在 `src-tauri/wit/world.wit` 与 `sidex-extension-sdk/wit/world.wit`（两份需同步）的 `host-api` interface 加函数签名；在 `extension_wasm.rs` 的 `impl Host for WasmHostState` 块加实现；SDK 侧 `wit_bindgen::generate!` 自动生成 trait 方法。

#### 场景 3：新增一种调试适配器

在 `crates/sidex-dap/src/adapter.rs` 的 `DebugAdapterRegistry::with_builtins()` 加 `register(type_name, ...)`；在 `launch_config.rs::builtin_templates()` 加 `LaunchConfigTemplate`；如需新 DAP 命令分发，在 `debug.rs::dap_send_request` 的 match 加分支。

> 对应测试：`crates/sidex-dap/` 下 `adapter.rs:129-141` 有适配器注册测试用例。

---

## 测试体系

SideX 的测试分散在各 crate 内（`#[cfg(test)] mod tests`），未形成 unit/integration/e2e 的明确分层。`crates/sidex-dap/src/adapter.rs` 含适配器注册测试、`crates/sidex-text/src/diff.rs` 含 Myers 算法测试、`crates/sidex-git/` 各模块有 porcelain 解析测试。前端沿用 VSCode 的测试体系（`@vscode/test-electron` 在 Tauri 下需适配）。目前测试覆盖尚不完整，与 "early release" 阶段一致——想理解某模块，优先读该 crate 的 `#[cfg(test)]` 块作为可执行文档。

---

## 阅读源码推荐路线

- **第一遍：理解主流程与 IPC 桥**
  `src/vs/sidex-bridge.ts`（41 行，invoke 封装）→ `src-tauri/src/lib.rs:372` 的 `run()`（State 注册 + generate_handler + setup）→ `src-tauri/src/commands/mod.rs`（glob re-export 打平）→ `src-tauri/src/main.rs`
- **第二遍：理解两条代表线性路**
  `src-tauri/src/commands/git.rs:76` 的 `git_status` → `crates/sidex-git/src/status.rs:32` 的 `get_status`（请求-响应）；`src-tauri/src/commands/terminal.rs:100` 的 `terminal_spawn` → reader 线程 `app.emit`（事件流）
- **第三遍：理解共享基础与高扇入**
  `crates/sidex-text/src/buffer.rs` 的 `Buffer`（ropey）→ `crates/sidex-text/src/diff.rs:49` 的 `myers_diff` → `crates/sidex-text/src/position.rs`（被 syntax/lsp 引用）
- **第四遍：选择重点子模块深入**
  终端三世代（`commands/terminal.rs` vs `commands/process.rs` vs `crates/sidex-terminal/`）；扩展系统双轨（`commands/ext_host.rs` Node sidecar vs `commands/extension_wasm.rs` WASM）；存储三库（`commands/storage.rs` vs `commands/db_state.rs` vs `crates/sidex-db/src/db.rs`）。各模块独立文档见上方模块地图链接。

---

## 附录

### 术语表

| 术语 | 解释 |
|------|------|
| Tauri 2 | 用 Rust 后端 + OS 原生 webview 的桌面应用框架，替代 Electron |
| invoke / emit / listen | Tauri IPC 三件套：前端调命令 / 后端推事件 / 前端订阅事件 |
| generate_handler! | Tauri 宏，编译期注册命令函数到路由表 |
| sidex-asset:// | 自定义 URI scheme，让 webview 受控访问本地文件 |
| OSC 633 | VSCode 定义的终端转义序列协议，shell 集成用 |
| WIT | WebAssembly Interface Type，WASM 组件模型的接口定义语言 |
| porcelain v2 | git 的机器可读状态输出格式 |
| JSONC | JSON with Comments，VSCode settings.json 格式 |

### 参考资料

- [SideX 仓库](https://github.com/Sidenai/sidex) · [ARCHITECTURE.md](https://github.com/Sidenai/sidex/blob/main/ARCHITECTURE.md)
- [Tauri 2 文档](https://tauri.app/) · [VSCode 源码](https://github.com/microsoft/vscode)
- 本站 [VSCode CodeWiki](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/00-overview)（对照 Electron 原版架构）
