---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "Overview"
date: "2026-09-17T10:45:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
tags: ["herdr", "Rust", "终端复用器", "Agent 运行时"]
description: "herdr 是面向 AI coding agent 的终端工作区运行时：单 Rust 二进制的 client-server 终端复用器，后台 server 拥有 PTY 与终端仿真，瘦客户端本地渲染 UI。"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.9.1 · **协议** Apache-2.0 · **语言** Rust 2021 · **代码量** src/ ~26.5 万行（净 ~22.9 万行，另 tests/ ~2 万行 + vendored libghostty-vt Zig 库）· **仓库** [GitHub](https://github.com/herdrdev/herdr)

---

## 总览

### 项目简介

herdr 自称 "the runtime your coding agents live on"——一个**面向 AI coding agent 的终端工作区运行时**。它解决的问题是：当你同时跑着 Claude Code、Codex、Qwen 等多个 agent，每个 agent 占一个终端时，SSH 断线/合上电脑就意味着全部中断，而且你永远不知道哪个 agent 卡在等你回答。herdr 的答案是 tmux 式的 client-server 终端复用，但为 agent 做了深度定制：

- **detach 不停工**：headless server 拥有全部 PTY，客户端断开后终端继续运行；机器重启后恢复保存的布局，并对支持的 agent 用 `claude --resume <id>` 这类命令恢复会话（进程本身不存活）
- **agent 状态一目了然**：每个 pane 被标记为 working / blocked / idle，靠进程探测 + 屏幕文本 manifest + 集成 hook 三源仲裁
- **agent 也能驱动 herdr**：JSON socket API（104 个 method）+ 内置 agent skill，agent 可以互相 spawn pane、prompt 对方、`wait until blocked`
- **多台机器一个窗口**：本地 + 保存的 SSH 机器聚合为 endpoint 联邦，独立重连

**项目边界**：herdr 不包装、不替换任何 agent——它只拥有 agent 的终端（spawn PTY、仿真 VT、转发输入输出）。agent 的对话历史、工具调用全归 agent 自己管，herdr 只在终端层面观察与恢复。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 后台会话 / detach | `server/headless.rs`、`persist/` | headless server 拥有 PTY，客户端随时断连重连 |
| 客户端本地渲染 UI | `client/shell/`、`protocol/` | 0.9.0 起 TUI 跑在每个 client 内（#3487），server 只发 pane surface |
| surface delta 渲染协议 | `protocol/surface_delta.rs`、`render_ansi.rs` | 行级 patch → surface 复用 → 全帧三级降级 |
| agent 状态检测 | `detect/`、`terminal/state.rs` | 23 个 TOML manifest + 进程探测 + hook 权威仲裁 |
| agent 集成安装 | `integration/` | `herdr integration install claude` 注入 hooks/statusline，CST 保格式编辑 |
| JSON Socket API | `api/`、`docs/next/api/herdr-api.schema.json` | 104 个 method，schemars 生成 schema 入库 |
| agent skill | `skills/herdr/SKILL.md`、`main.rs` | `herdr --skill` 打印随二进制分发的技能文件 |
| SSH 多机联邦 | `remote/`、`client/endpoint/` | `--remote` 附加、`machine` 管理、supervisor 自动重连 |
| 远程 CLI 转发 | `cli/target.rs`、`remote/saved.rs` | `herdr --machine <label>` 在保存机器上执行 API 命令，失败绝不回退本地 |
| 会话快照与恢复 | `persist/`、`agent_resume.rs` | 5s 防抖快照、原子写、agent 会话注入式 resume |
| live handoff | `server/handoff.rs`、`headless/lifecycle.rs` | 自更新时 SCM_RIGHTS 传 PTY fd，无感换 server |
| kitty graphics 图片 | `kitty_graphics.rs`、`pane_graphics_files.rs` | Kitty 图形协议渲染 pane 内图片 |
| copy mode / 文本选择 | `copy_mode.rs`、`selection.rs` | 键盘与鼠标双轨选择复制 |
| 插件 | `plugin_command.rs`、`api/server/plugins.rs` | 插件命令经 API 执行，注册表持久化 |
| kitty keyboard protocol | `input/parse.rs`、`input/encode.rs` | 增强键位保真（Shift+Enter、release 事件） |
| 自更新 | `update.rs` | manifest 驱动的稳定/预览双通道更新 |
| 音效 / 通知 | `sound.rs`、`notifications.rs` | agent blocked 时提示音与系统通知 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Rust 2021 + tokio | 核心 | server 用 multi-thread runtime，client 用 current-thread runtime |
| ratatui 0.30（`unstable-rendered-line-info`） | 核心 | TUI 渲染——server 虚拟渲染 pane surface，client 合成 chrome，共用一套绘制代码 |
| crossterm 0.29 | 核心 | 终端模式切换与事件类型 |
| libghostty-vt（vendored Zig 库，C ABI） | 核心 | 终端 VT 仿真引擎，`build.rs` 用 `zig build` 编译静态链接 |
| portable-pty 0.9（vendored fork） | 核心 | PTY 创建与子进程 spawn |
| clap 4.5 | 核心 | CLI 参数解析 |
| serde / serde_json / bincode 2 / toml | 核心 | wire 协议（bincode）、API（JSON）、配置（TOML）三套序列化 |
| schemars 1.2 | 核心 | API schema 生成，产物 `herdr-api.schema.json` 入库并由测试守护 |
| interprocess 2.4 | 核心 | Unix domain socket / Windows named pipe 统一抽象 |
| jsonc-parser 0.33 | 集成 | CST 保注释编辑 claude `settings.json` 等 JSONC 文件 |
| png / sha2 / base64 | 辅助 | Kitty 图片解码、checksum、payload 编码 |
| tracing / tracing-subscriber | 辅助 | 结构化日志 |

### 版本历史

herdr 迭代很快（CHANGELOG 可追溯到 2026-05 的 0.6.x，几乎每 1-2 周一个版本）。对架构影响最大的里程碑：

- **0.9.0（2026-09-07）**：TUI 从 server 迁到每个 client 内运行（#3487）——重绘工作下放到查看端，主题/菜单/copy mode 等呈现状态本地化；本地与保存的 SSH 机器聚合进一个窗口（#3670）；多客户端可独立查看不同 workspace/tab（#3526）
- **0.9.1（2026-09-16）**：`herdr --machine` 远程 CLI 转发；Windows SSH 主机接入；输入框光标级编辑；Letta 检测与原生会话恢复

本文解读基线是 v0.9.1 tag（`065ef9d6`，2026-09-16）。

---

## 快速上手

```bash
git clone https://github.com/herdrdev/herdr
cd herdr
cargo build --release          # 首次编译需 zig（libghostty-vt），见 build.rs
./target/release/herdr         # 在工作目录启动
```

端到端验证（证明 client-server 架构真的在工作）：

```bash
./target/release/herdr --version          # 输出 herdr 0.9.1
./target/release/herdr                    # 启动 TUI，自动拉起后台 server
# 在 TUI 里按 prefix 组合键 ctrl+b 再按 q —— detach
pgrep -fl "herdr server"                  # server 进程仍在运行
./target/release/herdr                    # reattach，pane 内容原样还在
```

跑测试用 `just`（项目约定，不直接调 cargo）：`just test` = cargo nextest + maintenance 测试 + `ui-hot-path-architecture-test`（Python 确定性架构边界测试）+ `integration-assets-test` + `docs-contract-test`。

---

## 架构设计解析

### 系统架构

herdr 的架构思想是**"单二进制、多角色、状态集中、呈现下放"**：`herdr` 这一个可执行文件根据子命令分别扮演 server、TUI client、CLI、远程桥四种角色。为什么这样设计？因为终端复用器的本质问题是"终端状态归谁"——herdr 把答案定为：**运行时事实（PTY、终端仿真、workspace/tab/pane 树、agent 状态）全部归 server，呈现（sidebar、tab bar、主题、copy mode）归每个 client**。这带来三个直接收益：detach 后工作不停、多个 client 看到一致视图、主题等偏好不影响其他查看者。代价是两端要靠一套精心设计的 delta 协议通信——这就是 `protocol/` 模块存在的理由。

![herdr 分层架构](/vibe-reading/images/articles/herdr-codewiki-0.9.1/architecture.svg)

如图，接入层的四类角色通过两条独立的通信栈触达 server：TUI 瘦客户端与远程客户端走 `herdr-client.sock` 上的私有二进制 wire 协议（bincode，surface delta 编码），CLI 子命令与 agent 走 `herdr.sock` 上的 JSON Socket API。server 进程内，`HeadlessServer` 是单线程 actor 聚合根，持有 `App`（Elm 式状态机）与全部 `PaneRuntime`；每个 pane 由 vendored 的 libghostty-vt 做终端仿真、专属 PTY actor 线程做 I/O。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接入层 | `client/`、`cli/`、`remote/` | 把用户按键、CLI 命令、SSH 连接转成协议消息；终端环境的 setup/恢复是这一层的头等大事 |
| 协议层 | `protocol/`、`api/` | 隔离两套 wire 契约（私有 bincode + 稳定 endpoint JSON），保护两端不被彼此演进破坏 |
| 应用编排层 | `server/`、`app/`、`workspace/` | 单线程事件循环独占全部状态，把输入、API 请求、后台事件归约为状态变更与渲染需求 |
| 终端运行时层 | `pane.rs` + `pane/`、`terminal/`、`ghostty/`、`pty/` | 每个 pane 一份仿真核心与 PTY 线程，dirty 区域提取驱动增量渲染 |
| 支撑层 | `detect/`、`integration/`、`persist/`、`input/`、`config/`、`platform/` | 检测、持久化、输入解码等横切能力，被上层按需消费 |

值得一提的是 `AGENTS.md` 里维护的架构军规，它们解释了很多代码形状：**状态与运行时分离**（`AppState` 是纯数据可无 PTY 测试）、**渲染纯函数**（`compute_view()` 算几何、`render()` 只画不改）、**平台代码隔离**（`#[cfg(target_os)]` 只允许出现在 `src/platform/`）、**检测解耦**（detector 只读屏幕快照）。还有一条边界守则：新的共享行为必须走 server/API 路径而非私有 TUI socket——"TUI 只是 server 的一个 client"。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单线程 Actor + 消息总线 | `HeadlessServer::run()` in `server/headless.rs:394`（`tokio::select!` 五路复用） | 所有 client I/O 在独立 OS 线程、经 `ServerEvent` mpsc 汇入，主循环独占 App 状态，免锁 |
| Elm 架构变体 | `AppState` + `app/actions.rs` reducer + `ui/` 纯视图 | 状态机复杂度集中在 server，纯数据层让状态转移测试不起 PTY |
| 快照 + 版本化迁移 | `persist/snapshot.rs` 的 `capture_*` / `restore.rs` 的 `restore_*` | 运行时对象与可序列化 DTO 严格分离，旧格式经 `migrate_snapshot` 升级 |
| 策略模式 | `ClientRenderState` in `server/render_stream.rs:15`（Semantic vs TerminalAnsi） | 按握手协商结果选择帧编码策略 |
| 数据驱动规则引擎 | `detect/manifests/*.toml` + `evaluate_loaded_manifest()` | agent 界面月级变化，规则独立于二进制热更新 |
| Supervisor 模式 | `EndpointSupervisors` in `client/endpoint/supervisor.rs` | 每个 SSH endpoint 独立重连状态机与指数退避 |
| RAII 守卫 | `TerminalGuard` in `client/terminal_setup.rs`、`Drop for PaneRuntime`、ghostty FFI 包装 | raw mode 泄漏会弄坏用户 shell，恢复必须覆盖错误与 panic 路径 |
| 命令模式 | `Method` enum（104 变体）+ `respond_to` 回执 in `api/schema.rs` | 请求-响应语义 + JSON 序列化，CLI/插件/客户端按键复用同一入口 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `App` / `AppState` | server 侧全部应用状态（纯数据） | server 进程全程 | 持有 workspaces、terminals、event_hub |
| `Workspace` / `Tab` / `TileLayout` | 三层容器：workspace 绑 git 身份，tab 持 BSP 布局树 | 随会话持久化 | `Workspace` Deref 到活跃 `Tab` |
| `PaneRuntime` | 一个 pane 的运行时（仿真核心 + PTY 句柄 + 检测任务） | pane 存活期间 | 被 `TerminalRuntimeRegistry` 登记 |
| `TerminalState` | pane 的纯状态镜像（agent 仲裁、标题、cwd） | 与 pane 同期、可序列化 | 三源检测结果在此仲裁 |
| `HeadlessServer` / `ClientConnection` | server 聚合根 / 每个客户端连接的会话呈现协商 | server / 连接期 | `ClientConnection` 持 per-client 渲染基线 |
| `ClientShellState` | client 侧 shell 投影 + 全部 UI 交互状态 | client 进程 | 约 80 字段的本地 god node |
| `PaneSurfaceFrame` / `PaneSurfacePatch` | pane 内容的语义帧 / 行级增量 | 单帧 | 三级降级编码的载体 |
| `Agent` / `AgentState` | 24 种 agent / Idle·Working·Blocked·Unknown | 检测周期 | manifest 规则匹配的输出 |
| `EventHub` | 512 条环形事件日志 | server 全程 | API 订阅者按 `events_after(seq)` 增量拉 |
| `SessionSnapshot` | 会话结构快照（BSP 树 + pane 元数据） | 5s 防抖落盘 | 恢复时经 `restore_*` 重建 |
| `EndpointCatalog` / `ClientEndpointId` | 保存的 SSH 机器目录 / Local·Ssh 身份 | 持久化 | 多机联邦的注册表 |

#### 核心抽象

| 扩展点 | 定义位置 | 扩展方式 | 注册方式 |
| --- | --- | --- | --- |
| agent 检测规则 | `detect/manifests/*.toml`（DSL：region + AND/OR 门） | 新增 TOML 即零 Rust 改动 | `BUNDLED_MANIFESTS` include_str! 静态编入，支持远程热更新 |
| agent 集成安装 | `integration/registry.rs` 的 `integration_specs()` | 新增 target 的 install 函数 + 资产 | `IntegrationTarget` 冻结 enum（新 agent 走 experimental 路径） |
| API method | `api/schema.rs` 的 `Method` enum | 加变体（编译器穷尽 match 强制四处同步） | serde rename 成 `pane.list` 类名字 |
| keybinding 动作 | `input/keybindings.rs` 的 `KeybindAction` | 加变体 + 配置表 + client 路由分支 | config.toml `[keybindings]` |
| 插件 | `persist/plugin_registry.rs` + `plugin_command.rs` | 插件命令经 API 执行 | 注册表持久化 |
| agent 会话 resume | `agent_resume.rs` 的 `plan()` | 加 match 臂 + 官方 source 白名单 | 纯数据驱动 |

---

## 代码目录

```
herdr/
├── src/
│   ├── main.rs             # 入口：嵌套检测、子命令分发、server 拉起
│   ├── server/             # headless 守护进程（聚合根 headless.rs ~3900 行）
│   ├── app/                # App/AppState/actions——纯状态机（Elm 式）
│   ├── client/             # TUI 瘦客户端（shell/ 子目录 = client 本地渲染的 UI）
│   ├── protocol/           # wire 协议 + surface delta + render_ansi
│   ├── api/                # JSON Socket API（schema/server/event_hub/wait）
│   ├── pane.rs + pane/     # PaneRuntime 与 pane 级仿真（terminal.rs 7214 行、osc.rs）
│   ├── terminal/           # TerminalState 仲裁、runtime registry、metadata
│   ├── ghostty/            # libghostty-vt 的 FFI 安全包装（bindings.rs 为 bindgen 生成）
│   ├── pty/                # PTY actor（专用线程 + wake pipe）
│   ├── input/ + raw_input.rs   # 键鼠解码与重编码（kitty keyboard protocol）
│   ├── detect/ + integration/  # agent 检测 manifest 与集成安装
│   ├── remote/             # SSH 附加与远端 server 生命周期
│   ├── persist/            # 会话快照/恢复
│   ├── workspace.rs + workspace/ + worktree.rs + layout.rs   # 三层容器与 BSP 布局
│   ├── update.rs           # 自更新（manifest 驱动，curl 子进程）
│   ├── kitty_graphics.rs   # Kitty 图形协议（~1500 行）
│   ├── ui/                 # ratatui 绘制纯函数（server 渲染复用）
│   ├── config/ · platform/ · session.rs · selection.rs · sound.rs ...
│   └── update.rs 之外还有 ~40 个根级文件（copy_mode、ipc、events 等）
├── vendor/                 # libghostty-vt（Zig）与 portable-pty 的 vendored fork
├── skills/herdr/SKILL.md   # 随二进制分发的 agent 技能文件
├── docs/next/api/herdr-api.schema.json   # 测试守护的 API schema 生成物
├── tests/                  # 17 个集成测试（detach_reattach、live_handoff 等）+ tests/cli/
├── scripts/                # 架构边界测试等维护脚本
└── justfile                # just test / just check 等开发入口
```

---

## 模块地图

静态依赖关系（箭头 = import/调用方向）。注意 client 与 server 共享同一二进制内的模块（如 `protocol/`、`input/`），进程边界在运行时由 socket 划定：

![模块依赖关系](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 守护进程 | headless server：事件循环、client 会话、渲染流、handoff | `HeadlessServer::run()` | 它是唯一允许触碰全部状态的线程，client I/O 与协议编解码都为它服务 | [01-server](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/01-server) |
| 应用状态机 | Elm 式 App/AppState/actions，API 与事件双入口 reducer | `App::new()`、`handle_api_request_after_internal_events_drained()` | 纯数据状态层是"无 PTY 测试"与会话持久化的前提 | [02-app](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/02-app) |
| 瘦客户端 | 连接、握手、本地渲染 shell、贴帧、输入转发 | `run_client_with_mode()` | 终端 setup/恢复与 UI 呈现的复杂度全在 client，与 server 职责天然分离 | [03-client](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/03-client) |
| 渲染协议 | wire 消息、surface delta/reuse、ANSI 编码 | `prepare_pane_surface()`、`BlitEncoder` | 它是两端唯一的契约，且承担"跨版本兼容"这个独立难题 | [04-protocol](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/04-protocol) |
| Pane 运行时 | pane 生命周期、spawn、检测任务、压缩任务 | `PaneRuntime::spawn()` | pane 是"仿真 + PTY + 检测"的聚合单元，独立于 UI 容器 | [05-pane](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/05-pane) |
| 终端仿真引擎 | libghostty-vt FFI、OSC 拦截、PTY actor | `process_pty_bytes()` | VT 仿真是重 CPU 且有 C 边界的独立域 | [06-terminal](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/06-terminal) |
| 输入解码 | kitty keyboard protocol 解析/编码、lease 记账 | `parse_terminal_key_sequence()` | 输入的歧义消解与两端共享（client 解码、server 重编码）自成一体 | [07-input](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/07-input) |
| Socket API | JSON API、事件订阅、wait 语义 | `dispatch_to_app()`、`wait_for_agent()` | agent-native 是 herdr 的核心卖点，API 是它对外的稳定面 | [08-api](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/08-api) |
| Agent 检测与集成 | manifest 规则引擎、hook 权威、集成安装 | `evaluate_loaded_manifest()`、`install_target()` | 数据驱动的规则域 + 23 家 agent 的安装差异，和终端运行时完全正交 | [09-detect-integration](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/09-detect-integration) |
| 远程多机 | SSH 桥、保存机器、supervisor 重连、CLI 转发 | `run_remote()`、`connect_saved_ssh()` | 多机联邦有独立的身份模型（ProfileId）与可靠性问题 | [10-remote](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/10-remote) |
| 会话持久化 | 快照、原子写、恢复、agent resume | `capture()`、`persist::restore()` | "detach 停电也不丢"是独立于运行时的持久化问题 | [11-persist](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/11-persist) |
| 工作区与布局 | workspace/tab 容器、BSP 布局、git worktree | `Workspace::new_with_extra_env()` | 三层容器 + git 身份是会话的骨架，与渲染/仿真解耦 | [12-workspace](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/12-workspace) |

模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

```
main() in src/main.rs
├─ exit_if_nested_disabled()            # HERDR_ENV=1 时拒绝嵌套 herdr（彩蛋报错文案）
├─ remote_launch? → remote::run_remote()          # --remote <target>：SSH 附加分支
└─ server::autodetect::auto_detect_launch() in src/server/autodetect.rs:295
   ├─ is_server_listening_at(client_socket_path())  # 试连探测；ConnectionRefused = 残留 socket
   ├─ 无 server → spawn_server_daemon()             # 以自身 exe + "server" 参数 detach 拉起
   │                 └─ wait_for_server_socket(15s) # 50ms 轮询等就绪
   └─ crate::client::run_client()                   # 附加

server 进程（"herdr server" 分支）：
run_server() in src/server/headless/bootstrap.rs
├─ api::start_server_with_stop_control()   # 绑 herdr.sock（JSON API）
├─ app::App::new()                         # 装配：Config::load() → AppState →
│                                          #   AppEvent channel(256) → RenderSignal → Notify
│                                          #   persist::load() 恢复快照 → TerminalRuntimeRegistry
└─ HeadlessServer::new() → server.run()    # 绑 herdr-client.sock，tokio::select! 主循环

client 进程：run_client_with_mode() in src/client/mod.rs:144
├─ Config::load() → ClientShellConfig::from_config()
├─ initial_terminal_geometry()             # ioctl 取 cols/rows/像素
├─ do_handshake()                          # EndpointControl hello（协商 codec/能力）
├─ setup_terminal() + TerminalGuard        # raw mode/mouse capture，panic hook 三重恢复
└─ run_client_loop()                       # stdin/resize/reader 三线程喂一个 channel
```

对象装配的要点：配置优先级是 `HERDR_CONFIG_PATH` 环境变量 > `~/.config/herdr/config.toml`（`config::Config::load()`）；`App::new()` 是唯一的状态装配点，`AppPolicy`（PRODUCTION/TEST/HANDOFF_REPLACEMENT）控制持久化副作用；pane 运行时经 `app/creation.rs` 创建后**双注册**进 `TerminalRuntimeRegistry`（活的）与 `state.terminals`（纯的）。

### 核心运行流程

下面三条链路覆盖 herdr 最重要的运行模式：交互环（按键到屏幕）、agent 状态环（检测到通知）、持久化环（变更到落盘）。

#### 交互环：一次按键到屏幕更新

这是 herdr 的心跳——数据从 stdin 出发绕 server 一圈回到屏幕：

![按键到屏幕的数据流](/vibe-reading/images/articles/herdr-codewiki-0.9.1/data-flow.svg)

文字解读：client 侧 stdin 读取线程用 `RawInputByteFramer`（`src/raw_input.rs`）把字节流按 10ms idle 超时切成帧（消解 ESC 歧义），`parse_terminal_key_sequence()`（`src/input/parse.rs`）按 kitty CSI-u → modify-other-keys → legacy 三级瀑布解码出 `TerminalKey`；keybinding 匹配在**client 本地**完成（`route_key_press()` in `src/client/shell/input.rs`），未消费的键打包成**语义键** `ClientShellPaneInput` 发给 server。server 在 `apply_client_pane_input_events()`（`src/server/pane_input.rs`）里按 pane 协商的 kitty keyboard flags 把键重编码回 VT 字节，经 `PtyIoActor` 专用线程写入 PTY。子进程输出回到 `process_pty_bytes()`（`src/pane/terminal.rs`）喂给 libghostty-vt 更新 cell 网格，`RenderSignal` 按 pane 合并脏源、16ms 节流合并渲染批次；`prepare_pane_surface()`（`src/server/render_stream.rs`）与已发送基线逐行 diff，走 delta → reuse → 全帧三级降级产出 `PaneSurfacePatch`。client 的 `surface_reuse::Decoder` 还原 delta、`compose()` 本地合成 chrome、`BlitEncoder`（`src/protocol/render_ansi.rs`）差分成 ANSI 写 stdout。两次差分（server 算 patch、client 算 ANSI）叠加 OSC 52/主题/像素鼠标等宿主回复的过滤，构成完整的输入闭环。

#### agent 状态环：三源检测到仲裁通知

agent 状态由三个独立源汇流：进程探测（300ms tick 的检测任务读 `/proc` 识别 pgid）、屏幕 manifest（`detection_text()` 取屏幕尾部 12 行匹配 TOML 规则门）、集成 hook（`herdr integration install` 注入的 SessionStart 脚本经 socket API 报告会话身份）。三者最终在 `TerminalState`（`src/terminal/state.rs`）集中仲裁——hook 权威活跃时压倒屏幕回退检测，进程退出清除权威后重算，避免 agent 结束后状态卡在 Working。仲裁后的 `AgentState` 变化经 `AppEvent` 驱动 sidebar 标记、提示音、系统通知，同时 `emit_event()` 推入 `EventHub` 供 API 订阅者消费——这正是 `agent.wait` 能"等到 agent 真正 blocked"的底层机制。状态全貌见下方「状态流」。

#### 持久化环：布局变更到落盘恢复

任何布局变异调用 `mark_session_dirty()` → `schedule_session_save()`（`src/app/session.rs`，5 秒防抖）→ headless 事件循环到期起后台线程跑 `run_session_save_job()` → `capture()`（`src/persist/snapshot.rs`）遍历 workspace/tab/pane 产出纯 JSON（含 agent 会话引用 `PaneAgentSessionSnapshot`）→ `SessionWriter::save()` 以 write-temp-then-rename 原子写 `session.json`。恢复发生在下次 `App::new()`：`persist::load()` → `restore()` 逐层重建 BSP 树、按保存的 cwd 起全新 shell、把 `claude --resume <id>` 类命令延迟到 client attach 后"敲"进 PTY（agent CLI 需要 24-bit 主题环境才正确渲染）。

### 状态流

herdr 有两个对用户可见的状态机——agent 状态与 endpoint 连接状态：

![状态流](/vibe-reading/images/articles/herdr-codewiki-0.9.1/state-flow.svg)

左图 agent 状态：`AgentState` 枚举定义在 `src/detect/mod.rs`（Idle/Working/Blocked/Unknown），转换由 `TerminalState` 的 `set_detected_state_with_screen_signals_at()`、`set_hook_authority_with_session_ref()` 等方法触发，三源证据的优先级是 hook > 屏幕 manifest > 进程探测回退。右图 endpoint 连接：`ReconnectState` 由 `EndpointSupervisors`（`src/client/endpoint/supervisor.rs`）驱动，网络超时走指数退避（500ms 翻倍封顶 120s），而权限/host key/协议不兼容这类"重试也没用"的失败转 Attention 态停止自动重连，等用户经 `--remote` 或 `machine add` 修复。

---

## 典型修改场景

#### 场景 1：新增支持一个 agent（如 "foo"）

| 步骤 | 文件 / 函数 |
| --- | --- |
| 检测枚举 | `src/detect/mod.rs`：`Agent` enum 加变体 + `ALL`/`SCREEN_MANIFEST_AGENTS`/`lookup_agent` 别名 |
| 检测规则 | 新建 `src/detect/manifests/foo.toml`（region + AND/OR 门 DSL）+ `manifest.rs` 的 `BUNDLED_MANIFESTS` 注册 |
| 集成资产 | `src/integration/assets/foo/herdr-agent-state.sh` |
| 集成注册 | `src/integration/mod.rs`（版本常量）、`registry.rs`（`integration_specs()`）、`types.rs`、`targets.rs`（`install_foo()`）、`actions.rs` 两个 match |
| API 兼容 | `src/api/schema.rs` 的 `IntegrationTarget`（破坏兼容——或学 letta 走 experimental 路径） |
| 会话恢复 | `src/agent_resume.rs::plan()` 加 match 臂 + `is_official_agent_source` 白名单 |

对应测试：`integration/tests.rs`（资产安装断言）与 `detect/manifest.rs` 的 manifest 校验测试。

#### 场景 2：新增一个 API method（如 `agent.restart`）

| 步骤 | 文件 / 函数 |
| --- | --- |
| 线格式 | `src/api/schema/agents.rs` 加 `AgentRestartParams`（derive `schemars::JsonSchema`）→ `schema.rs` 的 `Method` enum 加 `#[serde(rename = "agent.restart")]` 变体 → `response.rs` 加结果变体 |
| 分发 | `src/api/server.rs::api_method_name()` 加分支（穷尽 match 强制）→ `src/app/api.rs` 巨型 match 加处理臂 |
| UI 影响 | 需要重渲染则加进 `request_changes_ui()`（`src/api/mod.rs`） |
| schema | `HERDR_UPDATE_API_SCHEMA=1 cargo test generated_protocol_schema_artifact_is_current` 重生成 `docs/next/api/herdr-api.schema.json` |
| 可选 CLI | `src/cli/agent.rs` 加子命令构造 `Request` |

对应测试：schema 逐字节比对测试 + `tests/cli/` 的 round-trip 测试族。

#### 场景 3：新增一个 keybinding 动作（如"分屏到右侧"）

| 步骤 | 文件 / 函数 |
| --- | --- |
| 动作定义 | `src/input/keybindings.rs`：`KeybindAction` 加变体 + `resolve_non_indexed_action` 表加行 |
| 配置 | `config` 的 `Keybinds` 加字段 |
| client 路由 | `src/client/shell/actions.rs::record_binding()` 加处理分支（本地 overlay 或转 API method） |
| server 处理 | 若走 API：`schema.rs` 加 `Method` 变体 + `app/api.rs` 加 match 臂 + `app/actions.rs` 写纯状态动作 |
| 帮助 | `src/input/keybind_help.rs` 加 entry |

这条链路跨 5 个文件，是本架构改动成本最高的路径——按键从 client 语义到 server 状态要走完整的 API 契约。

---

## 测试体系

```
herdr/
├── src/**/*_tests.rs + #[cfg(test)] mod tests   # 单元测试内嵌（88 个 pane 测试全程不碰真 PTY）
├── tests/                       # 集成测试（17 个文件）
│   ├── detach_reattach.rs       # detach/reattach 端到端
│   ├── live_handoff.rs          # 无感换 server
│   ├── client_mode.rs · auto_detect.rs · broken_pipe.rs · cross_area.rs ...
│   ├── migration_tests.rs       # 持久化格式迁移
│   ├── fixtures/endpoint-method-shapes-v1.json   # 冻结的 endpoint wire 契约
│   └── cli/                     # API/CLI 契约（agent_wait、hooks、protocol ...）
└── scripts/test_ui_hot_path_architecture.py     # 确定性架构边界测试（just ui-hot-path-architecture-test）
```

| 代码层 | 测试类型 | 入口 |
| --- | --- | --- |
| AppState / actions | 纯单元（`AppState::test_new()` 无 PTY） | `just test`（cargo nextest） |
| workspace / layout | 纯单元（`Workspace::test_new()` + 对抗性状态不变量） | 同上 |
| protocol / api schema | 契约测试（SHA256 冻结 fixture、schema 逐字节比对） | 同上 |
| server / client 交互 | 进程级集成（tests/） | `just test` |
| 架构边界 | 确定性架构测试（UI 热路径不得碰文件系统/进程树） | `just ui-hot-path-architecture-test` |

值得学习的设计：`AppState::assert_invariants_for_test()` 配合 `test_with_adversarial_identity_state()` 做身份类重构的特征测试；`docs-contract-test` 强制文档与 schema 同步。理解某个类时，优先读它旁边的 `#[cfg(test)]`——`app/actions.rs` 的测试区几乎就是一份可执行的状态机规约。

---

## 阅读源码推荐路线

- **第一遍：主流程**（进程怎么起来的）
  `src/main.rs` 的 `main()` → `src/server/autodetect.rs:295` 的 `auto_detect_launch()`（spawn daemon + 等就绪）→ `src/server/headless/bootstrap.rs` 的 `run_server()` → `src/server/headless.rs:394` 的 `HeadlessServer::run()`（`tokio::select!` 五路复用）→ `src/client/mod.rs:144` 的 `run_client_with_mode()` → `src/client/handshake.rs` 的 `do_handshake()`
- **第二遍：核心数据结构**（状态长什么样）
  `src/app/state.rs` 的 `AppState` → `src/workspace.rs` 的 `Workspace`/`Tab` → `src/pane.rs:1251` 的 `PaneRuntime` → `src/terminal/state.rs:120` 的 `TerminalState` → `src/protocol/wire.rs` 的 `ClientMessage`/`ServerMessage`
- **第三遍：渲染环**（帧怎么流的）
  `src/server/render_stream.rs` 的 `prepare_pane_surface()`（三级降级）→ `src/protocol/surface_delta.rs` 的 `changed_rows()` → `src/client/state.rs` 的 `present_frame()`/`present_surface_patch()` → `src/protocol/render_ansi.rs` 的 `BlitEncoder::encode()`
- **第四遍：按兴趣深入模块文档**
  agent 检测看 [09-detect-integration](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/09-detect-integration)，多机联邦看 [10-remote](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/10-remote)，会话恢复看 [11-persist](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/11-persist)。

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| pane / tab / workspace | 三层容器：pane = 一个终端视口；tab = 同 cwd 的一棵 BSP 布局树；workspace = 绑定 git 身份的 tab 集合 |
| surface / delta | pane 内容的语义帧（cell 网格）；delta = 帧间行级 patch |
| endpoint generation | client-owned 协议的兼容世代（当前 1），`tests/fixtures/endpoint-method-shapes-v1.json` 冻结其 wire 形状 |
| manifest | `detect/manifests/*.toml` 的声明式检测规则（region + AND/OR 门） |
| hook authority | 集成 hook 报告的 agent 会话/状态权威，优先于屏幕检测 |
| live handoff | 自更新时旧 server 经 SCM_RIGHTS 把 PTY fd 传给新 server，client 无感 |
| prefix 键 | tmux 式两段键（默认 ctrl+b），`ClientShellMode::Prefix` 等待第二键 |
| kitty keyboard protocol | 终端增强键位协议，支持 release 事件与 alternate keys |
| OSC 8 / OSC 52 | 超链接 / 剪贴板转义序列 |
| named session | `--session <name>`，socket 与快照各自独立目录 |
| retained surface | PTY-only 更新的渲染快路径，绕过完整 UI 布局 |

### 参考资料

- [herdr 官方文档](https://herdr.dev/docs/)：concepts、session state、connecting machines、socket API
- 仓库内 `AGENTS.md`：架构军规与贡献流程（本文多条设计原则的直接出处）
- 仓库内 `CHANGELOG.md` 与 `vendor/libghostty-vt.patches.md`（vendoring 治理范例）
