---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "应用状态机"
date: "2026-09-17T10:47:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
contentType: "CodeWiki"
tags: ["herdr", "Rust", "Elm 架构", "状态机"]
description: "herdr 的 App/AppState：Elm 式纯数据状态机，用户意图走 API、后台事实走 AppEvent 的双入口 reducer。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/app/`（约 36,600 行）加上根级 `src/events.rs` 是 herdr 的状态机核心。`AppState` 是**纯数据**——文件头注释写着 "All application state — pure data, no channels or async runtime. Testable without PTYs or a tokio runtime"。这一条军规（`AGENTS.md` 第一原则）的回报巨大：client-server 架构下状态机复杂度全部集中在 server 侧，如果没有纯数据层，每个状态转移测试都得起 PTY 和 tokio；有了它，`state.handle_app_event(...)` 直接断言就是测试。

先纠正一个容易踩的坑：根级 `src/update.rs`（3,817 行）**不是**事件分发主循环——那是自更新机制（拉 `herdr.dev/latest.json` manifest）。真正的主循环是 `HeadlessServer::run()`（`server/headless.rs:394`），app 模块提供被它调用的状态与 reducer。

## 模块架构

![app 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-02-app.svg)

设计是 Elm 架构的变体，但有 herdr 特色——**双入口 reducer**：

- **意图入口**：用户按键在 client 侧被解析成动作后，转成 API `Method` 调用（104 个变体），经 `api_rx` 进入 `App::handle_api_request_after_internal_events_drained()`（`app/api.rs:885`）。请求-响应语义由 `respond_to` 同步回执通道提供
- **事实入口**：PTY child watcher、git 刷新等后台任务经有界 256 的 `event_tx` 投递 `AppEvent`，由 `handle_app_event()` reducer（`app/actions.rs:1443`）消费

两条入口最终都落到 `app/actions.rs` 的纯函数状态变更，产出 `Vec<PaneStateUpdate>`（效果数据）——reducer 不执行副作用，效果由 server 层消费（发通知/声音）。Model = `AppState`，View = `ui/` 纯函数（`compute_view()` 算几何、`render()` 只画不改），Command = 后台任务持有 `event_tx` 回投事件。

## 调用链路

**一次用户动作**（如按下"新建 workspace"快捷键）：

```
client 侧 route_key_press() in client/shell/input.rs:500
└─ resolve_direct_binding() → KeybindAction::NewWorkspace
   └─ record_binding() in client/shell/actions.rs:4
      └─ push_endpoint_method(Method::WorkspaceCreate(...))    # 经 client socket
         → server 侧 ApiRequestMessage（含 respond_to 回执通道）in api/mod.rs:89
            → headless 主循环 LoopEvent::Api
               → App::handle_api_request_after_internal_events_drained() in app/api.rs:885
                  ├─ 先 drain 内部事件（保证读到一致快照）
                  └─ match Method::WorkspaceCreate → app/creation.rs 纯状态动作
                     └─ respond_to.send(encode_success(...))    # JSON 回 client
```

**一次后台事实**（PTY 子进程退出）：

```
spawn_blocking child.wait() in pane.rs:2381
└─ classify_child_exit → AppEvent::PaneDied { pane_id, exit_reason }
   └─ 主循环 drain（每轮 APP_EVENT_DRAIN_LIMIT=64）
      → handle_internal_event_with_render_impact() in app/api.rs:31
         ├─ TerminalBell / ClipboardWrite：被 server 层截获转发前台 client，不进 AppState
         └─ 其余 → AppState::handle_app_event() in app/actions.rs:1443
            → Vec<PaneStateUpdate>（通知效果数据）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `App::new()` in `app/mod.rs:374` | 状态装配点 | `AppPolicy` 控制持久化副作用（PRODUCTION/TEST/HANDOFF_REPLACEMENT） |
| `handle_api_request_after_internal_events_drained()` in `app/api.rs:885` | API 请求分发 | 先 drain 内部事件保证一致快照 |
| `handle_app_event()` in `app/actions.rs:1443` | AppEvent reducer | 穷尽 match，副作用事件显式空转 |
| `schedule_session_save()` in `app/session.rs:14` | 5s 防抖快照 | 会话保存语义集中于此 |
| `emit_event()` in `app/api.rs:748` | 事件外发 | 先跑插件 hook 再进 EventHub |
| `mark_session_dirty()` | 增量快照标记 | 恢复/保存的解耦点 |

</details>

## 核心实现

### App 与 AppState：状态与运行时的分离

```rust
// src/app/mod.rs:90
pub struct App {
    pub state: AppState,                          // 纯数据
    pub(crate) terminal_runtimes: TerminalRuntimeRegistry,  // 活 PTY 运行时
    pub event_tx: mpsc::Sender<AppEvent>,         // 有界 256
    pub(crate) api_rx: UnboundedReceiver<ApiRequestMessage>,
    pub(crate) event_hub: crate::api::EventHub,   // 512 条环形
    pub render_notify: Arc<Notify>,
    pub(crate) render_dirty: Arc<RenderSignal>,
    pub(crate) policy: AppPolicy,                 // 三态策略注入
    // + git 缓存、session 保存线程等 ~40 个运行时字段
}

// src/app/state.rs:789
pub struct AppState {
    pub terminals: HashMap<TerminalId, TerminalState>,
    pub workspaces: Vec<Workspace>,     // Workspace Deref 到活跃 Tab
    pub mode: Mode,                     // Navigate | Terminal
    pub view: ViewState,                // 最近一次计算的 pane 几何缓存
    pub(crate) popup_pane: Option<PopupPaneState>,  // 刻意在 workspace 布局之外
    pub session_dirty: bool,
    // + keybinds/palette/theme/配置镜像 ~100 字段
}
```

三个值得讲的细节：**`ViewState` 由渲染循环写一次、多路径复用**——几何缓存于 state 而非每次绘制重算；**popup 置于 workspace 布局之外**（`state.rs` 注释 "intentionally outside workspace layouts"）——popup 是会话级模态，不污染 tab 拓扑与快照语义；**`Mode` 只有 Navigate/Terminal 两态**——无 workspace 时 Navigate 兜底。

### AppEvent 的四类与"枚举在场、reducer 空转"

`src/events.rs` 约 20 个变体分四类：进程生命周期（`PaneDied`）、agent 探测/hook 权威（`AgentProcessDetected`、`HookStateReported` 等，hook 类带 `seq` 单调序号防乱序）、宿主副作用转发（`TerminalBell`、`ClipboardWrite`）、后台任务完成（`GitStatusRefreshed`、`WorktreeAddFinished`…）。妙处在 `actions.rs:~1645` 的注释：Bell/ClipboardWrite "intercepted by HeadlessServer and forwarded to the foreground client; they never touch AppState. **Kept for AppEvent exhaustiveness**"——依赖 Rust match 穷尽性，新增事件变体时 reducer 必须显式表态，不可能静默漏处理。

### 渲染触发：脏标记三兄弟

主循环每轮根据 drain 结果置 `needs_render` / `needs_full_render` / `needs_graphics_render` 三个脏标记，渲染路径再选 hidden-only / retained 快路径 / 全量三档。PTY 唤醒经 `RenderSignal`（按 pane 合并）+ `Notify` 进入 select；渲染节流 16ms（`MIN_RENDER_INTERVAL`，`app/mod.rs:38`）把多个 PTY 唤醒合并进一个批次——"multiplicative performance paths" 军规的落点：per byte × panes × clients 的路径上不做多余的事。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Elm 架构变体 | `AppState` + `app/actions.rs` + `ui/` | 状态机测试不需要 PTY |
| 策略注入 | `AppPolicy` in `app/mod.rs:79` | 同一 `App::new` 在测试中零磁盘副作用 |
| 命令模式 | `Method` enum + `respond_to` | 意图入口天然请求-响应 |
| 事件总线 | `EventHub` in `api/event_hub.rs` | 512 条环形日志，订阅端按 seq 补拉 |

## 模块间交互

app 是被 `server/` 消费的库模块（server 主循环驱动它）；向下持有 `workspace`（容器树）、`terminal_runtimes`（活 PTY）；`ui/` 单向依赖（全部从 `AppState` 计算行/矩形的纯函数，`sidebar_agent_rows` 等）；`persist` 的保存/恢复都挂在 App 上。`app/api/` 按领域拆 `workspaces.rs`/`tabs.rs`/`panes.rs`/`worktrees.rs`/`plugins/`，`agents.rs` 处理 `AgentStart`（超时校验、`AGENT_START_SETTLE_DELAY` 落定期）。

## 扩展方式

- **新增 AppEvent**：`events.rs` 加变体 → `actions.rs:1443` 加 match 臂（穷尽性强制）→ client 可见则在 `server/headless/notifications.rs:323` 转发 → 生产者在拿到 `event_tx` 的后台任务里 send
- **新增 popup**：仿 `PopupPaneState`（`state.rs:18`）加状态字段 → `app/popup.rs` 加 `spawn_popup_*_command` → `ui/panes.rs` 布局 → client 经 `ClientShellPopupInput`（`protocol/wire.rs:592`）路由输入
- **新增快捷键动作**：跨 `input/keybindings.rs` → config `Keybinds` → `client/shell/actions.rs::record_binding()` → `api/schema.rs` 的 `Method` → `app/api.rs` match 臂 → `app/actions.rs` 纯动作——5 个文件，本架构改动成本最高的路径

---

## 边缘机制速查

闭卷验证补充：

### 事件与保存机制

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `APP_EVENT_CHANNEL_CAPACITY / APP_EVENT_DRAIN_LIMIT` | `app/mod.rs:164-165` | 事件通道容量 256、每 tick 最多排空 64——背压上限与批处理粒度，防 PTY 风暴撑爆队列
| `start_background_session_save` | `app/session.rs:66` | 防抖 5s（SESSION_SAVE_DEBOUNCE，mod.rs:43）到期起 herdr-session-save 线程；上一次保存线程未结束时 +250ms 重新调度，spawn 失败时内联保存兜底
| `reap_finished_session_save` | `app/session.rs` | 回收已结束的保存线程 JoinHandle
| `SessionSaveJob::Clear` | `app/session.rs` | workspaces 为空时的保存任务是删文件而非写空快照——干净退出不留空壳
| `checkpoint_session_before_pane_exit` | `app/session.rs` | pane 退出前先做一次即时检查点；checkpoint 待处理时 shutdown 保存会跳过（pane_exit_checkpoint_pending），finish_checkpointed_pane_exit 收尾
| `App.persist_pane_history` | `app/mod.rs` | 控制 session-history.json（屏幕 ANSI）是否随结构快照一起保存

### 呈现与通知规则

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `estimate_pane_size` | `app/state.rs` | 无渲染几何时回退 headless_size（返回 (height, width)，注意顺序）；有几何用 ViewState
| `Palette::from_name / with_overrides` | `app/state.rs` | 未知主题名回落默认；自定义色覆盖叠在基础主题之上；built_in_themes_leave_sidebar_background_unset 测试保证内置主题 sidebar_bg 均为 Color::Reset
| `notification_sound_for_state_change_with_agent_labels` | `app/actions.rs` | Blocked 目标态映射 Request 声音 / NeedsAttention toast；is_completion_transition_parts 判定完成转换（含 Unknown→Idle 且 agent 标签不变），映射完成音；active_tab_suppresses_notifications（outer_terminal_focus != Some(false) 时）抑制通知
| `switch_workspace / mark_active_tab_seen` | `app/actions.rs` | 切工作区更新 active/selected、mark_session_dirty、record_pane_focus_after_navigation；mark_active_tab_seen 标记 tab 已读并按是否有未读返回布尔
| `API_NOTIFICATION_RATE_LIMIT` | `app/api.rs:20` | notification/show API 限流窗口 1s，由 api_notification_rate_limited / mark_api_notification_shown 实现；ServerStop 置 should_quit，ServerLiveHandoff 在嵌入式 app 模式返回 unsupported_in_app_mode