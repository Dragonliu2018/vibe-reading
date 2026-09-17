---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "守护进程"
date: "2026-09-17T10:46:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
tags: ["herdr", "Rust", "Actor 模型", "终端复用器"]
description: "herdr headless 守护进程：单线程 actor 事件循环如何独占全部状态、把渲染流推给多个客户端、并在自更新时无感交接。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/server/`（约 26,600 行）是 herdr 的常驻核心——`herdr server` 启动的 headless 守护进程。它直接持有 `app::App`（含全部 PTY `TerminalRuntime` 与终端仿真状态），把 UI 渲染成内存中的 ratatui Buffer，按每个 client 协商的编码转成帧/delta 推到 `herdr-client.sock`，并把 client 输入注入 PTY。用户看到的 "detach 后工作继续运行"，本质就是这个进程在无人观看时继续消化 PTY 输出、维持几何尺寸、保存会话快照。

模块边界：client I/O 的脏活（握手、读写、写队列）在独立 OS 线程完成，但**任何触碰 App 状态的操作都被收敛进主循环**——线程只产生 `ServerEvent` 消息。这让它成为理解整个系统的支点：`AGENTS.md` 的架构军规（状态与运行时分离、渲染纯函数）都以它为执行现场。

## 模块架构

![server 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-01-server.svg)

内部是"线程层 + 单线程主循环 + 三个职责出口"的结构。`client_accept.rs` 以 nonblocking accept 循环收连接，每个连接 spawn 一个 OS 线程跑 `client_transport.rs` 的握手与读循环；读出的消息转成 `ServerEvent` 经 mpsc 汇入主循环。`HeadlessServer::run()`（`headless.rs:394`）用 `tokio::select!` 五路复用（API 请求、内部事件、server 事件、定时器、渲染唤醒），独占 `App` 状态、无锁。主循环向三个方向出手：`render_stream.rs` 负责帧的生产与编码降级、`pane_input.rs` 负责把 client 输入注入 PTY、`handoff.rs`/`headless/lifecycle.rs` 负责自更新时的进程交接。巨型 `headless.rs`（约 3,900 行）是聚合根，其 impl 按关注面拆进 `headless/` 子模块（render/lifecycle/client_views/retained_surface/notifications），`pub(super)` 互相不可见。

## 调用链路

**启动链**：

```
run_server() in server/headless/bootstrap.rs:4
├─ api::start_server_with_stop_control()        # 绑 herdr.sock（JSON API）
├─ app::App::new(...)                           # AppState + AppEvent channel + RenderSignal
└─ HeadlessServer::new() → server.run()         # 绑 herdr-client.sock（set_nonblocking）
```

**client 消息链**（一次按键进入 server 的路径）：

```
accept_client_connections() in headless.rs:1095
└─ accept_pending_client_connections() in client_accept.rs:15
   └─ std::thread::spawn → handle_client_handshake() in client_transport.rs:651
      ├─ 读 TerminalHello（直连）或 EndpointControl hello（client shell）
      ├─ check_client_version() → 回 Welcome / EndpointServerWelcome
      ├─ 建 ClientWriterQueue + spawn client_writer_loop()（client_transport.rs:929）
      └─ client_read_loop_with_endpoint_controls()（client_transport.rs:971）
         └─ ServerEvent::ClientShellPaneInput → server_event_tx.blocking_send()
            → 主循环 handle_server_event_with_render_impact()（headless.rs:2684）
               └─ apply_client_pane_input_events() in pane_input.rs:203
                  → runtime.try_send_bytes() → PTY
```

**渲染链**（PTY 输出到 client 帧的路径）：

```
主循环 step 7：render_dirty.take()（合并脏源）
├─ hidden-only：不可见源只做有界分类，不渲染
├─ render_retained_pane_surface_and_stream() in headless/retained_surface.rs:212
│    # PTY-only 快路径：直接产出 PaneSurfacePatch，绕过完整 UI
└─ render_and_stream() in headless/render.rs:375
   ├─ render_tab_surface_virtual() / render_terminal_virtual() in render_stream.rs:472/513
   │    # ratatui Terminal::draw 挂在 CursorTrackingBackend 上
   ├─ FrameData::from_ratatui_buffer_with_hyperlinks() in protocol/wire.rs
   └─ ClientRenderState::prepare_pane_surface() in render_stream.rs:155
      ├─ 逐字段比对旧基线，相同 → skip（零流量）
      ├─ surface_delta::message()（行级 span patch）
      ├─ surface_reuse::message()（只发 revision）
      └─ 全帧 PaneSurface → writer.render.try_send()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `HeadlessServer::run()` in `headless.rs:394` | `tokio::select!` 五路复用主循环 | 单线程独占 App，所有 client I/O 在别的线程 |
| `accept_pending_client_connections()` in `client_accept.rs:15` | nonblocking accept 循环 | 每连接一线程，主循环不被 I/O 阻塞 |
| `handle_client_handshake()` in `client_transport.rs:651` | 握手与能力协商 | 协商 RenderEncoding 与 codec 清单 |
| `client_writer_loop()` in `client_transport.rs:929` | per-client 写线程 | control 优先于 render；render 通道容量 1 |
| `handle_server_event_with_render_impact()` in `headless.rs:2684` | ServerEvent 分发 | 返回 `RenderImpact::{None,Graphics,Full}` 三态 |
| `render_and_stream()` in `headless/render.rs:375` | 全量渲染 | 相同帧直接 skip（`full_render.skip_identical`） |
| `render_retained_pane_surface_and_stream()` in `retained_surface.rs:212` | PTY-only 快路径 | 绕过整个 ratatui 布局 |
| `prepare_pane_surface()` in `render_stream.rs:155` | 帧编码降级 | delta → reuse → 全帧 |
| `perform_live_handoff()` in `headless/lifecycle.rs:25` | 无感换 server | 两阶段提交 + 回滚 |
| `auto_detect_launch()` in `autodetect.rs:295` | 拉起 daemon + 附加 client | 15s/50ms 轮询等就绪 |

</details>

## 核心实现

### HeadlessServer：聚合根与连接管理

```rust
// src/server/headless.rs:195
pub struct HeadlessServer {
    app: app::App,                       // 直接持有整个应用状态 + terminal_runtimes
    clients: HashMap<u64, ClientConnection>,
    foreground_client_id: Option<u64>,   // 驱动会话级呈现的 client
    tab_geometry_controllers: HashMap<String, u64>, // 每 tab 的几何控制者
    client_shell_boot_id: String,        // 拒绝旧 server boot 的 shell 替换
    effective_size: (u16, u16),          // 前台 client 尺寸或 headless_size
    server_event_rx: mpsc::Receiver<ServerEvent>,
    // ...约 30 个字段
}
```

`ClientConnection`（`clients.rs:133`）按模式区分 `ClientShell | TerminalAttach | TerminalObserve | TerminalPending`，并持有自己的 `ClientRenderState` 渲染基线——**delta 的前提是 server 记得"这个 client 上一帧发了什么"**。多客户端策略（0.9.0 起）：不同 client 可独立查看不同 workspace/tab；共享同一 tab 时，最后交互者控制其尺寸（`tab_geometry_controllers`）。

### 渲染背压：双通道写队列

```rust
// src/server/client_transport.rs:122
pub(crate) struct ClientWriter {
    control: ClientControlWriter,  // 可靠通道：shutdown/通知/剪贴板，无限排队
    render:   ClientRenderWriter,  // 可丢通道：容量 1，慢 client 不积压
}
```

为什么 render 通道容量是 1（`client_transport.rs:125` 注释明说 "slow clients cannot build lag"）：终端流是"最新者赢"语义，丢中间帧是正确行为；丢帧后下一帧全量自愈。配套的 `defer_full_render` 在 writer 排空时事件驱动重试，且 `full_redraw_pending` 是 per-connection 追踪——"一个慢 client 不能把其他响应灵敏的 peer 拖上全局全量渲染路径"（`render.rs` 末尾注释）。

### live handoff：无感换 server

`perform_live_handoff()`（`headless/lifecycle.rs:25`）是自更新的关键：用 SCM_RIGHTS 直接传 PTY fd（`FDS_PER_MESSAGE=64`，刻意避开 253 个 fd 的控制消息上限），配 `HandoffManifest`（会话快照 + 每 pane runtime 状态 + 8KB 重放 ANSI）。协议是两阶段提交：先 `pause_handoff_reader` 冻结输出再导出；新 server `wait_ready` 确认就绪后，旧 server 才删公共 socket 并 `report_committed`；任一步失败走 `rollback_handoff_before_commit` 恢复 socket——**旧 server 在确认新 server 就绪之前绝不放弃监听**。handoff 期间 `accept_client_connections` 切到 `reject_pending_client_connections`，不让新 client 在 backlog 里等一个永远不会来的 Welcome。

### 启动探测：autodetect

`auto_detect_launch()`（`autodetect.rs:295`）的逻辑简洁而稳健：试连 client socket——`ConnectionRefused` 说明是崩溃残留的 stale socket（等价于无 server）；无 server 则 `spawn_server_daemon()`（`autodetect.rs:194`，detach、stdio null、注入 `HERDR_STARTUP_CWD` 种子），然后 `wait_for_server_socket` 以 15s 上限、50ms 间隔轮询就绪；已有 server 则校验 endpoint generation 兼容性。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单线程 Actor + 消息总线 | `HeadlessServer::run()` in `headless.rs:394` | 免锁独占状态，client I/O 隔离在线程层 |
| 策略模式 | `ClientRenderState` in `render_stream.rs:15` | Semantic / TerminalAnsi 两种帧编码按协商实例化 |
| 三态影响合并 | `RenderImpact::merge()` in `headless.rs` | 一批事件的需求合成最便宜的正确动作 |
| 两阶段提交 | `perform_live_handoff()` in `headless/lifecycle.rs:25` | 交接失败可回滚，socket 所有权明确 |

## 模块间交互

`server/` 是组装层：import 几乎所有 crate 模块（`api`、`app`、`protocol`、`ui`、`kitty_graphics`、`persist`、`input`、`raw_input`、`sound`…），渲染复用 `crate::ui::render_tab_surface`——**server 渲染与 TUI 绘制是同一份代码**，这是"渲染纯函数"军规的直接受益。被 `cli.rs`（`server::run_server_command`）、`remote/host.rs`（在远端拉起 daemon）、`client/`（只用 `socket_paths::client_socket_path`）消费。`src/update.rs` 的自更新（`STABLE_UPDATE_MANIFEST_URL`，curl 子进程拉 manifest，无 HTTP 依赖）完成后触发上面的 handoff 链。

## 扩展方式

- **新增一种 client 消息**：`src/protocol/wire.rs` 加 `ClientMessage` variant（只能 append，tag 冻结）→ `client_transport.rs` 的读循环发对应 `ServerEvent` → `headless.rs` 的 `handle_server_event_with_render_impact` 加 match 臂并返回 `RenderImpact`
- **新增 endpoint 命令**：`server/client_commands.rs` 的 `CLIENT_SHELL_METHODS` 列表 + `api/schema` 的 `Method` 枚举——transport 层 `decode_endpoint_request` 自动放行并转成既有 API 管线
- **调整渲染节流**：只动 `app/mod.rs:38` 的 `MIN_RENDER_INTERVAL`（16ms）与 `app/runtime.rs` 的 `can_render_now`——headless 不感知具体数值

---

## 边缘机制速查

闭卷验证补充——一轮信息隔离的源码阅读发现的细粒度机制，按主题归档：

### 启动与会话协商

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `validate_running_server_compatibility` | `autodetect.rs` | 已有 server 时校验 endpoint_protocol_generation 与 ENDPOINT_PROTOCOL_GENERATION；saved_federation 时额外要求 capabilities.surface_interest，不满足给重启指引
| `saved_federation 跳过校验` | `auto_detect_launch() in autodetect.rs` | 保存了 SSH 机器时跳过本地兼容性校验直接附加——本地 startup 失败只 warn 不退出（'Local startup failed; keeping saved machines available'），一台机器的问题不拖垮联邦
| `build_server_daemon_command` | `autodetect.rs` | daemon 环境继承的两处特殊处理：当前目录写入 HERDR_STARTUP_CWD（获取失败则移除）；显式 --session 时清掉 HERDR_SOCKET_PATH/HERDR_CLIENT_SOCKET_PATH 覆盖，让 daemon 用会话自己的 socket

### 写队列与 handoff 细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `send_ordered` | `ClientWriterQueue in client_transport.rs` | 先把已存在的 render 槽内容移入 ordered 队列再入队——保证有序消息（如全帧后的 patch）不被乱序 render 插队；discard_pending_render 同时清空槽和队列
| `ClientWriterDrained` | `client_transport.rs:940 附近` | writer 排空 render 槽后发回主循环，驱动 defer_full_render 的重试——事件驱动而非轮询
| `reject_pending_client_connections` | `client_accept.rs` | handoff 期间 accept 到的 stream 直接丢弃、不启动握手——不能让 client 滞留在 listener backlog 里等一个永远不会来的 Welcome
| `fd 批传输` | `FDS_PER_MESSAGE=64 in handoff.rs` | 单个 SCM_RIGHTS 控制消息 Linux 上限 253 个描述符（macOS 254）；按 64 一批远低于两限且 pane 数量不受限。recv_fd_batch 遇 MSG_CTRUNC 关闭已收 fd 报错；数量超预期报错；流中途关闭关闭已收 fd 报 UnexpectedEof
| `handoff 握手协议` | `accept_and_validate_on / send_fds_and_wait_restored in handoff.rs` | 单行文本确认链：token 行 → manifest JSON → 'validated' → fds → 'restored' → 'ready' → 'committed' → 'owned'；OWNED_ACK_TIMEOUT=500ms（其余阶段 READY_TIMEOUT=30s）；read_line_unbuffered 单行上限 16 MiB；handoff socket 权限 0o600

### 输入路由细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `downgrade_ineligible_pixel_mouse` | `pane_input.rs` | 像素坐标仅在 geometry 与 runtime 的行列/像素尺寸完全一致且坐标在界内时按 SGR-pixel 转发，否则改写为 Cell 并清 geometry——防错误像素注入 PTY
| `WheelRouting 三路由` | `wheel_routing() in pane/terminal.rs` | 优先级 MouseReport（scroll_reset 后 encode_mouse_wheel 发转义序列）> AlternateScroll（alt screen + alternate scroll mode 时 encode_alternate_scroll）> HostScroll（本地 runtime.scroll_up/down）；PageUp/PageDown 无修饰且 host_page_keys 时按终端行数本地滚屏，Release 被忽略