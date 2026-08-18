---
source:
  type: "源码解读"
  project: "zed"
  url: "https://github.com/zed-industries/zed"
title: "Overview"
date: "2026-08-18T11:06:09+08:00"
category: [Tools, IDE, Zed, CodeWiki, "1.15.0"]
tags: ["zed", "Rust", "code editor", "GPUI", "CRDT"]
description: "Zed 高性能多人协作代码编辑器源码架构解读"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.15.0 · **协议** GPL-3.0-or-later / Apache-2.0 · **语言** Rust (edition 2024) · **代码量** ~1,540,000 行 (243 crates) · **仓库** [GitHub](https://github.com/zed-industries/zed)

---

## 总览

### 项目简介

Zed 是一款由 Atom 和 Tree-sitter 的原作者团队（Zed Industries）用 Rust 从头打造的高性能、多人协作代码编辑器。它不基于 Electron，也不复用任何现成的 GUI 框架——团队自己写了一套 GPU 加速的 UI 框架 **GPUI**，用 Metal / Vulkan / Direct3D 直接把界面绘制到屏幕上，以此换取毫秒级的输入延迟和流畅的滚动体验。

Zed 解决的核心问题是：**现代编辑器在「功能丰富」和「响应速度」之间被迫取舍**。Electron 类编辑器（VS Code）功能生态庞大但输入有不可消除的延迟；传统原生编辑器（Sublime）快但扩展性和协作能力弱。Zed 的价值主张是同时拿到两端——用 GPU 直渲保证速度，用 Rust workspace 多 crate 架构保证可扩展性，用 CRDT 文本模型原生支持多人协作。

核心使用场景：日常代码编辑、AI 辅助编程（内置 Agent 面板）、实时多人协作编辑、终端 / Git / 调试器集成。**项目边界**：Zed 是一个编辑器应用，不是一个 IDE 平台——它不提供自研的插件运行时沙箱（扩展基于 WebAssembly + WASI），也不追求 VS Code 级别的插件生态广度，而是聚焦于编辑核心体验和协作。

### 功能矩阵

| 特性 | 实现目录 | 说明 |
|------|----------|------|
| GPU 加速渲染 | `crates/gpui/` | 自研 UI 框架，Metal/Vulkan/D3D 后端 |
| 代码编辑 | `crates/editor/` | 光标、选择、折叠、补全、多光标 |
| 多人协作 | `crates/text/` + `crates/client/` + `crates/collab_ui/` | CRDT 文本同步 + 实时光标 |
| AI Agent | `crates/agent/` + `crates/agent_ui/` | 内置 AI 助手，工具调用，多模型 |
| Vim 模式 | `crates/vim/` | 完整 Vim 模式仿真 |
| 语言服务 | `crates/language/` + `crates/lsp/` | LSP 客户端 + Tree-sitter 语法 |
| 终端 | `crates/terminal/` + `crates/terminal_view/` | 集成终端 |
| Git | `crates/git_ui/` | 内联 diff、blame、commit |
| 调试器 | `crates/debugger_ui/` + `crates/dap/` | DAP 调试适配器 |
| 主题系统 | `crates/theme/` + `crates/syntax_theme/` | 运行时主题切换 |
| 扩展系统 | `crates/extension/` + `crates/extension_host/` | WASM 扩展 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| **GPUI** | 核心（自研） | GPU 加速 UI 框架，所有渲染和实体管理的根基 |
| **Rope + SumTree** | 核心（自研） | 文本数据结构，O(log n) 编辑与查询 |
| **Tree-sitter** | 核心 | 增量语法解析，语法高亮与代码结构 |
| **smol** | 核心 | 异步运行时（轻量 executors） |
| **tokio** | 可选 | GPUI 与 tokio 桥接（`gpui_tokio`），用于部分异步任务 |
| **serde** | 核心 | 序列化，配置 / RPC / 持久化 |
| **livekit** | 可选 | 实时音视频通话（协作语音） |
| **reqwest** | 可选 | HTTP 客户端（fork 版本，定制 TLS） |
| **axum + sea_orm** | 可选（`collab` crate） | 协作服务端（SaaS 侧，非编辑器本体） |
| **Cargo** | 工具 | 构建系统，243 crate workspace |

---

## 快速上手

```bash title="构建与运行 (macOS)"
# 前置：Xcode + Command Line Tools
git clone https://github.com/zed-industries/zed
cd zed
cargo run                    # debug 构建并启动 Zed
cargo run --release          # release 构建（性能接近正式版）
```

验证：启动后打开任意源码文件，编辑输入应无明显延迟；`Cmd+Shift+P` 打开命令面板确认 UI 响应。Linux 需额外安装 `script/install-linux` 依赖；Windows 见 `docs/src/development/windows.md`。

> 以下为内部调用链，留给「运行时行为」章展开。

---

## 架构设计解析

### 系统架构

Zed 的架构思想可以概括为一句话：**用自研基础设施换取消除抽象层**。主流编辑器在 OS 原生窗口之上叠了至少三层抽象（浏览器引擎 → DOM → UI 框架），Zed 把这些压成一层——GPUI 直接拿到 GPU 上下文，Element 树经 Taffy 布局后直接绘制。文本编辑路径同样如此：按键事件不经任何中间队列，直接路由到 `Editor`，`Editor` 调 `Buffer::edit`，`Buffer` 操作 `Rope`（基于 `SumTree`），全部在同一进程的同步调用链里完成。这种"直通式"设计是 Zed 低延迟的根因——不是靠优化，而是靠少绕路。

![Zed 架构分层](/vibe-reading/images/articles/zed-codewiki/architecture.svg)

五层从下到上，依赖方向严格单向（上层依赖下层）：

1. **基础设施层**（`gpui` / `sum_tree` / `rope`）：GPU 渲染、实体系统（`Entity<T>` + `Context`）、文本底层结构。GPUI 是一切 UI 的根基，`SumTree` 是一切可聚合数据结构的根基。
2. **文本内核层**（`text` / `multi_buffer`）：`Buffer` 封装 `Rope` 为可编辑、可协作的文本模型（CRDT）；`MultiBuffer` 在 `Buffer` 之上做跨文件拼接（excerpt），支撑多缓冲区编辑。
3. **编辑器层**（`editor` / `language` / `lsp`）：`Editor` 是核心编辑组件，消费 `MultiBuffer` 渲染文本、处理光标选择；`language` 提供 Tree-sitter 语法注册与高亮；`lsp` 是 LSP 客户端。
4. **应用编排层**（`zed` / `workspace` / `project` / `worktree`）：`zed` 是应用入口与 action 注册中心；`workspace` 管理窗口、面板（Pane）、Dock；`project` 编排文件系统、语言服务、缓冲存储；`worktree` 封装工作目录树。
5. **功能扩展层**（`vim` / `collab` / `agent` / `terminal` / `git_ui` / `ui`）：面向用户的功能模块，各自包装下层能力，互不依赖。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|------------------------|
| 功能扩展层 | `vim/` `collab/` `agent/` `terminal/` `git_ui/` `ui/` | 面向用户的功能切片，各自独立演进，不互相耦合 |
| 应用编排层 | `zed/` `workspace/` `project/` `worktree/` | 编排应用生命周期与窗口/项目状态，协调下层组件 |
| 编辑器层 | `editor/` `language/` `lsp/` | 编辑体验与语言智能，消费文本模型渲染交互 |
| 文本内核层 | `text/` `multi_buffer/` | 可协作的文本模型与多文件拼接，为编辑器提供数据源 |
| 基础设施层 | `gpui/` `sum_tree/` `rope/` | 渲染、实体系统、底层数据结构——一切的地基 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| **Entity + 观察者** | `gpui/src/app.rs` `Entity<T>` / `Context::observe()` / `Context::subscribe()` | GPUI 的核心状态管理：实体是 `Rc` 式智能指针，观察者模式驱动 UI 重渲染，替代 React 式虚拟 DOM |
| **即时 + 保留混合渲染** | `gpui/src/element.rs` `Element` trait `request_layout` → `prepaint` → `paint` | 每帧重建 Element 树（即时模式），但元素状态跨帧保留（保留模式），兼顾简洁与性能 |
| **CRDT（无主复制）** | `text/src/text.rs` `Operation::Edit` + `clock::Lamport` | 多人协作无需中心锁：每个副本独立编辑，Lamport 时钟排序操作，操作可交换合并 |
| **SumTree（可聚合 B-tree）** | `sum_tree/src/sum_tree.rs` `SumTree<T: Item>` | 文本片段、选择、布局节点等需要 O(log n) 聚合查询（如"第 N 行在哪个 offset"）的数据结构通用底座 |
| **Action 注册表** | `gpui/src/action.rs` + `zed/src/zed.rs` `init()` | 所有命令（保存、跳转…）注册为类型安全的 Action，按键映射解耦于逻辑，支持跨平台 keymap |
| **Provider / Registry** | `project/src/project.rs` `LanguageRegistry` / `LspStore` | 语言、LSP、工具链等按类型注册，运行时按需实例化，新语言只需注册不改编排逻辑 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `App` | GPUI 应用全局上下文 | 进程级 | 持有所有 `Entity`、窗口、全局状态 |
| `Entity<T>` | GPUI 托管的共享状态单元 | 引用计数 | 被 `Context` 观察和更新 |
| `Window` | 一个操作系统窗口 | 窗口级 | 持有根 `View`、元素 arena、焦点 |
| `Buffer` | 可编辑文本缓冲区（CRDT 副本） | 文档级 | 内含 `BufferSnapshot` + `History` |
| `MultiBuffer` | 多 `Buffer` 拼接视图 | 编辑器级 | 持有多个 `ExcerptRange<Buffer>` |
| `Editor` | 编辑器组件 | 视图级 | 消费 `MultiBuffer` 渲染交互 |
| `Workspace` | 工作区（窗口内容根） | 窗口级 | 持有 `Pane` 组 + `Project` |
| `Project` | 项目模型 | 会话级 | 编排 `Worktree` / `Buffer` / `LspStore` |
| `Thread` | AI 会话线程 | 会话级 | 持有消息历史 + 工具注册表 + 模型 |

#### 核心抽象

| 接口 / trait | 定义位置 | 实现类 | 注册方式 |
|--------------|----------|--------|----------|
| `Render` | `gpui/src/element.rs:163` | 所有可绘制 View（`Editor`、`Workspace`…） | `impl Render for T` |
| `Element` | `gpui/src/element.rs:51` | `div`、`img`、`text` 及自定义元素 | `IntoElement` trait 自动转换 |
| `View` | `gpui/src/view.rs` | `Editor`、`Workspace`、`Vim` 等 | `cx.new(\|cx\| T::new())` 创建实体 |
| `Item`（workspace item） | `workspace/src/pane.rs` | `Editor`、`Terminal`、`ChannelView` 等 | `Workspace::register_item()` |
| `Global` | `gpui/src/global.rs:22` | `SettingsStore`、`ThemeRegistry`、`Client` 等 | `cx.set_global()` / `UpdateGlobal` |
| `LanguageModel` | `language_model_core` | `AnthropicModel`、`OpenAIModel`、`OllamaModel` 等 | provider 注册到 `LanguageModelRegistry` |

---

## 代码目录

```
zed/
├── crates/                    # 243 个 Rust crate（全部 workspace 成员）
│   ├── gpui/                  # GPU UI 框架（核心，79K 行）
│   │   ├── src/gpui.rs        # 模块入口
│   │   ├── src/app.rs         # App / Entity / Context（实体系统）
│   │   ├── src/element.rs     # Element / Render trait（渲染抽象）
│   │   ├── src/window.rs      # Window（窗口与帧循环）
│   │   └── src/view.rs        # View trait
│   ├── text/                  # CRDT 文本缓冲区（核心）
│   │   └── src/text.rs        # Buffer / BufferSnapshot / Operation
│   ├── rope/                  # Rope 文本结构
│   ├── sum_tree/              # 可聚合 B-tree（rope 等的底座）
│   ├── editor/                # 编辑器组件（163K 行，最大 crate）
│   │   └── src/editor.rs      # Editor 结构体
│   ├── multi_buffer/          # 多缓冲区拼接
│   ├── workspace/             # 工作区 / Pane / Dock
│   ├── project/               # 项目模型 / LSP / 文件系统
│   ├── zed/                   # 应用入口（main.rs / zed.rs）
│   ├── vim/                   # Vim 模式
│   ├── collab/                # 协作服务端（SaaS 侧）
│   ├── agent/                 # AI Agent 核心
│   ├── agent_ui/              # AI Agent UI
│   ├── language/              # 语言注册 / Tree-sitter
│   ├── lsp/                   # LSP 客户端
│   ├── ui/                    # UI 组件库
│   ├── theme/                 # 主题系统
│   └── ...                    # 其余 ~220 个 crate
├── Cargo.toml                 # workspace 根配置
├── docs/                      # 官方文档源码
├── extensions/                # 内置扩展
└── script/                    # 构建 / 安装脚本
```

> `crates/` 下每个子目录是一个独立 crate，`default-members = ["crates/zed"]` 意味着 `cargo run` 默认构建编辑器二进制。

---

## 模块地图

![Zed 模块依赖关系](/vibe-reading/images/articles/zed-codewiki/module-dependencies.svg)

模块间依赖严格遵循分层方向：功能层（`vim` / `agent` / `collab`）依赖编辑器层和应用层，编辑器依赖文本内核，文本内核依赖基础设施。`gpui` 被几乎所有上层模块通过 `Entity` / `View` 系统依赖（图中省略其入向箭头以保持可读）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| GPUI 渲染框架 | GPU 加速 UI、实体系统、布局 | `gpui/src/gpui.rs` | 一切 UI 的根基，自成体系 | [GPUI 渲染框架](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/01-gpui) |
| 文本模型 | CRDT 缓冲区 + Rope + SumTree | `text/src/text.rs` `Buffer` | 协作编辑的核心数据模型，与 UI 无关 | [文本模型](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/02-text-model) |
| 编辑器 | 文本编辑交互与渲染 | `editor/src/editor.rs` `Editor` | 最大 crate，核心产品体验 | [编辑器](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/03-editor) |
| 应用与工作区 | 应用启动、窗口/面板管理 | `zed/src/main.rs` + `workspace/src/workspace.rs` | 应用编排层，协调所有组件 | [应用与工作区](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/04-app-workspace) |
| 项目与语言服务 | 项目模型、文件系统、LSP | `project/src/project.rs` `Project` | 编排文件/语言/缓冲的资源中心 | [项目与语言服务](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/05-project-language) |
| 协同编辑 | CRDT 同步、实时光标 | `text/` + `client/` + `collab_ui/` | Zed 的差异化能力，横跨客户端与服务端 | [协同编辑](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/06-collab) |
| Vim 模式 | 完整 Vim 仿真 | `vim/src/vim.rs` `Vim` | 独立模式系统，包装 Editor 行为 | [Vim 模式](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/07-vim) |
| AI 代理 | AI 会话、工具调用、多模型 | `agent/src/thread.rs` `Thread` | 大规模功能模块，独立的工具与模型抽象 | [AI 代理](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/08-agent) |

模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

```
main() in crates/zed/src/main.rs:201
  ├─ sandbox::run_sandbox_launcher_if_invoked()    # Linux 沙箱 helper（优先）
  ├─ util::prevent_root_execution()                # 安全：拒绝 root 运行
  ├─ Args::parse()                                 # clap 解析 CLI
  ├─ [--askpass / --crash-handler 分支]            # 子模式直接 return
  ├─ build_application()                           # 选平台 (gpui_platform::current_platform)
  │     └─ Application::new_inaccessible(platform) # 创建 GPUI Application
  └─ application.run(|cx| {                        # 进入 GPUI 主循环
        cx.refresh();                              # 初始化日志 / 崩溃 handler
        zed::init(cx);                             # 注册全局 action（crates/zed/src/zed.rs:194）
        Client::global(cx);                        # 建立协作客户端
        SettingsStore::global(cx);                 # 加载 settings.json / keymap.json
        ThemeRegistry::global(cx);                 # 主题注册
        LanguageRegistry::global(cx);              # 语言注册（Tree-sitter）
        cx.open_window(build_window_options(..))   # 开窗口
          └─ initialize_workspace(app_state, cx)   # crates/zed/src/zed.rs:430
               └─ initialize_panels(window, cx)    # crates/zed/src/zed.rs:779
                    └─ Editor::new / ProjectPanel / AgentPanel
     })
```

对象装配的关键决策：**全局单例通过 `Global` trait 注册到 `App`**。`Client`、`SettingsStore`、`ThemeRegistry`、`LanguageRegistry` 都通过 `cx.set_global()` 或 `TypeMap` 式的全局存储注册，任何 `Context` 都能 `cx.global::<T>()` 取到。窗口打开后，`initialize_workspace` 创建 `Workspace` 实体，它持有 `Project` 实体；`initialize_panels` 依次创建中央 `Pane`、左/下/右 `Dock`，并向 Pane 添加 `Editor` / `ProjectPanel` / `AgentPanel` 等视图。配置覆盖优先级：默认值 < `settings.json`（全局）< 项目级 `settings.json` < 命令行参数。

### 核心运行流程

Zed 运行时最核心的链路是**从按键到像素**——一次按键如何穿越各层最终改变屏幕。这条链路直接体现了五层架构的协作方式。

#### 编辑主链路：按键到像素

业务流程：键盘按下 → 事件分发 → 编辑器处理 → 文本模型变更 → 快照生成 → 渲染 Element 树 → 布局 → GPU 绘制 → 屏幕更新。

![Zed 按键到像素数据流](/vibe-reading/images/articles/zed-codewiki/data-flow.svg)

文字描述：按键经 GPUI 的 `key_dispatch`（`crates/gpui/src/key_dispatch.rs`）路由为类型安全的 Action，命中 `Editor` 注册的 handler（如 `Editor::handle_input`）。`Editor` 将字符与当前 `Selection` 传给 `MultiBuffer`，最终落到 `Buffer::edit`（`text/src/text.rs`），生成 `EditOperation`（含 Lamport 时间戳和目标版本）。`Buffer` 调 `Rope::replace`（`rope/src/rope.rs:124`）修改文本，底层 `SumTree<Fragment>` 在 O(log n) 内更新并聚合 `TextSummary`。随后 `BufferSnapshot` 被克隆（COW，零成本），供 `Editor::render` 读取——`render` 构建 Element 树，GPUI 经 Taffy 布局后用 GPU 绘制。整条链路同步完成，无消息队列中转。

#### 协作同步链路：本地编辑到远端

业务流程：本地 `Buffer::edit` → 生成 `Operation` → `client` 序列化经 RPC 发送 → 服务端 `collab` 转发 → 远端 `Buffer` 收到 `deferred_ops` → 按 Lamport 时钟排序后 `apply` → 远端 `Editor` 重渲染。

文字描述：`Buffer` 每次 `edit` 不仅改本地，还把 `EditOperation`（含 `clock::Lamport` 时间戳和 `clock::Global` 版本向量）推入订阅流。`client` crate 的 RPC 连接将操作序列化发送到 Zed 协作服务端（`collab` crate，基于 axum + sea_orm），服务端转发给同房间的其他副本。远端 `Buffer` 的 `deferred_ops: OperationQueue`（`text/src/text.rs`）暂存到达顺序错乱的操作，待依赖版本对齐后按 Lamport 顺序应用。CRDT 保证所有副本最终收敛到相同状态，无需中心锁。

#### AI Agent 链路：用户提示到代码修改

业务流程：用户输入提示 → `Thread::stream_completion` → 语言模型流式返回 → 解析工具调用 → 执行工具（如 `edit_file_tool`） → 工具结果回传模型 → 循环至完成 → `Editor` 展示改动。

文字描述：`Thread`（`agent/src/thread.rs:1243`）持有消息历史和工具注册表（`BTreeMap<SharedString, Arc<dyn AnyAgentTool>>`）。用户消息触发 `running_turn`，调用 `LanguageModel::stream_completion` 流式获取模型响应。若模型返回 `ToolCall`，`Thread` 查注册表执行对应工具（如 `edit_file_tool.rs` 修改 `Buffer`），工具结果作为新消息回传模型，循环直到模型返回 `Stop`。工具执行需要用户授权时通过 `ThreadEvent::ToolCallAuthorization` 请求 UI 交互。

### 状态流

`Buffer` 的协作状态机是 Zed 运行时最核心的状态流转：

- **Local clean** → `edit()` → **Local dirty**（生成未同步 Operation）
- **Local dirty** → Operation 发送并确认 → **Local clean**
- 任意状态 → 收到远端 `Operation` → `deferred_ops` 暂存 → 依赖版本就绪 → `apply` → 触发 `Buffer::Event::Operation` → `Editor` 重渲染
- 任意状态 → `undo()` / `redo()` → 生成 `UndoOperation`（引用被撤销的 Lamport 计数）→ 广播

相关代码：状态枚举隐含在 `Buffer` 的 `history` / `deferred_ops` 字段（`text/src/text.rs:59`），操作排序在 `OperationQueue`，版本向量在 `clock::Global`。

---

## 典型修改场景

#### 场景 1：新增一种语言支持

- `crates/languages/src/` 新增语言 crate（如 `crates/languages/src/xxx/`），定义 Tree-sitter grammar 和语言配置
- `crates/language/src/languages.rs` 在 `LanguageRegistry` 注册新语言
- `crates/project/src/lsp_store.rs` 添加该语言的 LSP server 启动配置
- 对应测试：`crates/languages/src/xxx/xxx_tests.rs`

#### 场景 2：新增一个 AI 工具

- `crates/agent/src/tools/` 新增工具文件（如 `xxx_tool.rs`），实现 `AnyAgentTool` trait（提供 `name` / `input_schema` / `run`）
- `crates/agent/src/tools.rs` 在工具注册表注册
- 若需 UI 交互（如授权），扩展 `ThreadEvent` 枚举（`agent/src/thread.rs:872`）
- 对应测试：`crates/agent/tests/`

#### 场景 3：新增一个编辑器 Action

- `crates/editor/src/actions.rs` 定义 Action 结构体（`#[derive(PartialEq, Action)]`）
- `crates/editor/src/editor.rs` 在 `Editor::init` 注册 handler（`cx.on_action`）
- `assets/keymaps/default-*` 添加按键绑定
- 对应测试：`crates/editor/src/editor_tests.rs`

扩展点的契约定义见「架构设计解析 > 核心概念」的核心抽象表。

---

## 阅读源码推荐路线

- **第一遍：理解启动与主循环**
  `crates/zed/src/main.rs:201` `fn main()` → `build_application()` → `Application::run()` 回调 → `crates/zed/src/zed.rs:194` `init()` → `zed.rs:430` `initialize_workspace()` → `zed.rs:779` `initialize_panels()`。看清应用怎么装配、窗口怎么开、组件怎么创建。

- **第二遍：理解 GPUI 的实体与渲染**
  `crates/gpui/src/app.rs:692` `struct App`（全局上下文）→ `app.rs:2706` `App::new()`（实体创建）→ `crates/gpui/src/view.rs` `trait View` → `crates/gpui/src/element.rs:51` `trait Element`（`request_layout` → `prepaint` → `paint`）→ `crates/gpui/src/window.rs:1116` `struct Window`（帧循环）。理解一个 View 怎么变成像素。

- **第三遍：理解文本模型与 CRDT**
  `crates/sum_tree/src/sum_tree.rs:213` `SumTree`（可聚合 B-tree）→ `crates/rope/src/rope.rs:26` `Rope`（基于 SumTree 的文本）→ `crates/text/src/text.rs:59` `Buffer`（CRDT 副本）→ `text.rs:619` `Operation` / `EditOperation`（Lamport 时钟）→ `text.rs:113` `BufferSnapshot`。理解文本怎么存、怎么改、怎么协作。

- **第四遍：理解编辑器与选择重点子模块**
  `crates/editor/src/editor.rs:921` `struct Editor` → `editor/src/display_map.rs`（坐标映射）→ `editor/src/selections_collection.rs`（多光标）→ `editor/src/element.rs`（渲染）。之后按兴趣选模块文档深入：协作看 `06-collab`，Vim 看 `07-vim`，AI 看 `08-agent`。

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| GPUI | Zed 自研的 GPU 加速 UI 框架，混合即时/保留模式 |
| Entity | GPUI 托管的状态单元，类似 React 的 state 但用引用计数而非虚拟 DOM |
| View | 实现了 `Render` trait 的 `Entity`，可被绘制到窗口 |
| Element | GPUI 渲染树的基本节点，经 Taffy 布局后绘制 |
| Rope | 树状文本结构，将大字符串拆成块以支持高效编辑 |
| SumTree | Zed 自研的可聚合 B-tree，支持 O(log n) 聚合查询 |
| CRDT | Conflict-free Replicated Data Type，无冲突复制数据类型，Zed 用它实现协作 |
| Lamport 时钟 | 逻辑时钟，给每个操作打单调递增时间戳用于排序 |
| Excerpt | `MultiBuffer` 中一个 `Buffer` 的可见片段区间 |
| Action | 类型安全的命令，由按键映射触发，路由到注册的 handler |

### 参考资料

- [Zed 官方文档](https://zed.dev/docs)
- [GPUI 源码 README](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)
- [Zed 博客：性能与架构](https://zed.dev/blog)
- [CRDT 原理](https://crdt.tech/)
