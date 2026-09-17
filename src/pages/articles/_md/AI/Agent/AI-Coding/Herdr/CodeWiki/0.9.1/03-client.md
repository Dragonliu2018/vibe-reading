---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "瘦客户端"
date: "2026-09-17T10:48:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
contentType: "CodeWiki"
tags: ["herdr", "Rust", "TUI", "终端"]
description: "herdr 瘦客户端：0.9.0 起 TUI 在每个 client 内本地渲染，server 只发元数据快照与 pane surface。"
readingTime: "21 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/client/`（约 55,700 行，其中相当部分是测试——实现在 `mod.rs` + `startup.rs` + `transport.rs` + `shell/` 子树）是用户直接面对的 TUI 进程。0.9.0 起（#3487）herdr 把 TUI 搬进了每个 client：**server 只发 `ClientShellSnapshot`（workspace/tab/pane/agent 元数据）+ 活跃 pane 的 `PaneSurface` cells，sidebar、tab bar、overlay、copy mode、文本选择、鼠标手势全部在客户端本地渲染与处理**。为什么：重绘工作下放到查看端，busy 多 client 会话下 server 不再是渲染瓶颈；主题、菜单、copy mode 等呈现设置本地化，不干扰其他查看者；也为多机联邦（一台窗口看多台机器）铺平了道路。

模块头注释（`client/mod.rs`）保留了历史职责描述："connects to the server's client socket, sends TerminalHello…receives Frame messages and blits them"——今天这段描述属于 **direct attach 模式**（`herdr attach`，哑终端贴 ANSI）；默认的 `herdr` 走 **client-rendered shell 模式**（`run_client_with_mode` 里 `let client_rendered_shell = attach_request.is_none()`）。

## 模块架构

![client 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-03-client.svg)

启动装配链：`run_client_with_mode()` 加载配置并构造 `ClientShellConfig` → `do_handshake()` 完成 EndpointControl 握手（声明 codec 与 surface_reuse/surface_delta 能力）→ `setup_terminal()` 拿到 `TerminalGuard` 并装 panic hook → current-thread tokio runtime 跑 `run_client_loop`。运行期是"三线程喂一个 channel"：stdin 线程（`input.rs`）、resize 轮询线程（`terminal_geometry.rs`，100ms + SIGWINCH 合并去抖）、每 endpoint 一个 reader 线程（`transport.rs`），全部汇入容量 256 的 `ClientLoopEvent` channel。`ClientShellState`（`shell/state.rs:837`，约 80 字段的本地 god node）持有 shell 投影与全部 UI 交互状态；`EndpointSupervisors` 在后台独立重连 Local/SSH endpoint。

## 调用链路

**一帧的接收-贴帧链**（三条路径）：

```
ServerMessage::Terminal(frame)                # direct attach：ANSI 直通
└─ stdout.write_all(&frame.bytes)             # mod.rs:1421

ServerMessage::PaneSurface(surface)           # shell 全帧
└─ shell.set_pane_surface(surface)
   └─ shell.compose(cols, rows)               # 本地把 pane cells + sidebar/tab chrome 合成 FrameData
      └─ state.present_frame(frame)           # client/state.rs:248
         └─ blit_encoder.encode(&frame, repaint_pending)
            └─ 与 last_frame 逐 cell diff → 变化 run 的 ANSI → commit 存基线

ServerMessage::PaneSurfacePatch(patch)        # 增量
└─ shell.apply_pane_surface_patch(patch)
   └─ state.present_surface_patch(patch)
      └─ blit_encoder.encode_patch(&rows, ...)
         └─ 任何 fallback（光标绘制失败/编码失败）→ request_repaint() 回退全帧
```

**一次按键的发送链**：

```
stdin 线程 unix_stdin_reader_loop() in client/input.rs:38
└─ RawInputByteFramer 按 idle 超时切 chunk（lone ESC 用更短超时）
   └─ ClientLoopEvent::StdinInput(Vec<u8>)
      └─ parse_raw_input_bytes_sync(&data) in raw_input.rs:8 → Vec<RawInputEvent>
         └─ shell.handle_raw_events(events)
            ├─ 返回 ClientShellAction 列表（剪贴板/开 URL/激活 endpoint）
            │   └─ dispatch_client_shell_actions() in shell_runtime.rs:8 统一执行
            └─ 面向 pane 的语义事件 → ClientShellPaneInput { pane_id, events }
               └─ write_to_server() in transport.rs:152 帧化写入 socket
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `run_client_with_mode()` in `client/mod.rs:144` | 启动装配 | attach 缺省即 client-rendered shell |
| `do_handshake()` in `client/handshake.rs` | 双协议栈握手 | 本地 5s / 远程 60s 双超时（#753） |
| `run_client_loop()` in `client/mod.rs:369` | 事件循环 | 三线程喂一个 channel(256) |
| `present_frame()` / `present_surface_patch()` in `client/state.rs` | 贴帧 | patch 失败自动回退全帧，`render_prof` 埋点 |
| `freeze_presentation()` in `client/state.rs` | handoff 冻结 | 切 endpoint 时源画面保持权威 |
| `dispatch_client_shell_actions()` in `shell_runtime.rs:8` | 动作队列消费 | UI 意图与 IO 解耦 |
| `stdin_reader_loop()` in `client/input.rs:38` | 原始输入 | lone ESC 短超时消歧 |

</details>

## 核心实现

### ClientShellState：本地渲染的 shell

`client/shell/` 子树是 0.9.0 架构迁移的主战场：`composition.rs` 的 `compose()` 把 server 发来的 pane surface cells 与本地 chrome（sidebar、tab bar、overlay）合成 `FrameData`；`input.rs` 的 `handle_key()` 按 `ClientShellMode { Terminal, Prefix, Navigate, Resize, Copy }` 状态机分派；`agent_sidebar.rs`、`endpoint_sidebar.rs` 渲染聚合的 agent 列表与多机列表。Local server 挂掉时 shell 仍能 `compose` 出"连接中"画面（`mod.rs:581`），`EndpointSupervisors` 后台拉起重连——**多机联邦里一台断线不干扰其他机器**的体验由此而来。

### 终端恢复的三重保险

`TerminalGuard`（`client/terminal_setup.rs`）是 raw mode 泄漏问题的答案——泄漏会把用户 shell 弄坏，属于最高优先级不变量。三重保险：`Drop` 实现、显式 `restore()`、panic hook，三者共享 `restore_claimed: Arc<AtomicBool>`，`restore_terminal_state_once` 用原子 `swap(true)` 保证恰好执行一次。连 ctrlc handler 都注释了要捕获 SIGTERM/SIGHUP（ctrlc crate 的 termination feature）。`ClientState::drop` 同理恢复 kitty keyboard 协议。

### presentation freeze：跨机器切换不闪残影

`freeze_presentation()` / `unfreeze_presentation()`（`client/state.rs`）配合 endpoint activation 两阶段事务：切换机器时**源画面保持权威**，直到目标 snapshot/surface 对齐提交；解冻时强制 repaint 而非在旧帧上打 patch——防止半新半旧的拼接帧。这与 `protocol/` 的 baseline 校验（boot_id/projection_revision/surface_revision）是一体两面。

### reader 线程的"失败不拆台"

`ClientMessageSink for EndpointRegistry`（`transport.rs`）的注释明确：单 endpoint 发送失败被 lifecycle loop 吸收，不许拆掉无关连接；配合 generation 门卫（`write_stream.accepts(&endpoint_id, generation)` 丢弃旧连接的迟到消息），避免僵尸连接的脏数据污染新连接。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| RAII + 三重恢复 | `TerminalGuard` in `client/terminal_setup.rs` | 错误/panic 路径也必须恢复终端 |
| 命令/动作队列 | `ClientShellAction` in `shell/state.rs:238` | UI 意图与 IO 解耦 |
| Supervisor 重连器 | `EndpointSupervisors` in `endpoint/supervisor.rs` | 500ms→120s 指数退避，Local 上限 30s |
| 两阶段 handoff 状态机 | `PendingEndpointActivation` in `endpoint/activation.rs` | 支持 `supersede()` 快速连续切换 |
| generation 门卫 | `write_stream.accepts()` in `mod.rs:1271` | 陈旧连接过滤 |

## 模块间交互

- **protocol/**：消费 wire 编码层、`render_ansi::BlitEncoder`、`surface_reuse::Decoder`（transport 读循环内嵌解码）
- **server/**：只通过 `client_socket_path()` 找 socket——进程边界即 socket
- **remote/**：`client/endpoint/` 反向调用 `remote::connect_saved_ssh`，saved machine 的运行时腿在 client 侧、安装升级腿在 remote/ 侧
- **input/**：本地 keybinding 匹配与宿主回复消费都在 client 完成，server 只收语义化 `ClientShellPaneInput`

## 扩展方式

- **新增 ServerMessage 品类**：`protocol/wire.rs` 加 variant（bincode tag 兼容）→ `mod.rs` 巨型 match 加分支；跨版本需求走 `EndpointControl` 新 kind
- **调整贴帧策略**：动 `present_surface_patch` 与 `BlitEncoder::encode_patch`（`render_ansi.rs:140`），fallback 已有 `render_prof::event("client_surface_patch.fallback.*")` 埋点可回归
- **新增宿主终端模式**：按 `set_mouse_capture()`（`terminal_setup.rs`）的模式加 enable/restore 对，restore 必须补进 `restore_terminal_state` 和 `TerminalGuard`——漏掉 restore 就破坏三重保险不变量

---

## 边缘机制速查

闭卷验证补充：

### 握手与读循环

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `LOCAL_HANDSHAKE_READ_TIMEOUT / REMOTE_HANDSHAKE_READ_TIMEOUT` | `client/handshake.rs` | 本地 5s、远程 60s 双超时，由 is_remote_client_process 区分（#753：SSH 冷连接的 TCP+密钥交换+认证在 5s 内完不成）
| `EndpointClientHello / ENDPOINT_HELLO_KIND` | `client/handshake.rs` | endpoint 路径的 hello 藏在 EndpointControl(kind=ENDPOINT_HELLO_KIND) 里，声明四个 codec（SNAPSHOT/SURFACE/INPUT/BLOB 的 V1）；welcome 的 generation 与 codec 清单须完全匹配
| `server_reader_thread / EndpointReader` | `client/transport.rs` | 非阻塞轮询读：WouldBlock 继续等、EOF 转 ClientLoopEvent::ServerDisconnected、其他错误进 lifecycle loop；EndpointReader 封装统一 Windows named pipe 与 Unix 语义

### 状态与重连细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `presentation_frozen / present_frozen_chrome` | `client/state.rs` | 冻结期间只贴冻结 chrome（'连接中'画面）；record_host_theme_update 对重复主题更新去重，host_theme_updates 缓冲在解冻后 replay_host_theme 重放
| `retry_delay 退避常量` | `client/endpoint/supervisor.rs` | INITIAL_RETRY_DELAY 起步指数左移，封顶 MAX_RETRY_DELAY；Local 单独 MAX_LOCAL_RETRY_DELAY（更短）；STABLE_CONNECTION_PERIOD 之后重置 attempt；ConnectionRefused/NotFound 等仍按可重试处理
| `connect_once 的接受条件` | `client/endpoint/supervisor.rs` | 编码须 SemanticFrame，且 negotiation 须 supports_surface_interest（非本地端点还须 supports_health_check），不满足拒绝该连接
| `direct_graphics_profile_values` | `client/handshake.rs` | kitty graphics 仅对 ghostty/wezterm/KITTY_WINDOW_ID 等宿主启用；TMUX 内与非终端环境视为 blocked_transport 禁用
| `panic_restore` | `client/terminal_setup.rs` | panic hook 与 Drop 共享 restore_claimed 原子标志，restore_terminal_state_once 恰好执行一次；write_terminal_restore_postlude 写入让光标重新可见的恢复序列