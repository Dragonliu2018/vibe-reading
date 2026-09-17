---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "Pane 运行时"
date: "2026-09-17T10:50:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
contentType: "CodeWiki"
tags: ["herdr", "Rust", "PTY", "Agent"]
description: "PaneRuntime：一个 pane 的完整生命周期——spawn 五步组装、PTY I/O、检测任务与 scrollback 压缩。"
readingTime: "19 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/pane.rs`（5,282 行）+ `src/pane/` 子树是 "pane" 这个 herdr 核心抽象的运行时侧：每个 pane 对应一个 `PaneRuntime`——仿真核心（`Arc<PaneTerminal>`，见[终端仿真引擎](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/06-terminal)）、PTY I/O 抽象、子进程 pid、检测任务、scrollback 压缩任务的聚合体。pane 是"仿真 + PTY + 检测"的聚合单元，独立于 workspace/tab 容器——`AGENTS.md` 军规 "State is separated from runtime" 的另一半：`TerminalState`（纯状态镜像，`src/terminal/state.rs`）与 `PaneRuntime`（活运行时）严格分家，前者支撑持久化与测试，后者只在 server 存活期间存在。

目录提示：`src/pane/` 下是 `terminal.rs`（7,214 行，仿真编排）、`osc.rs`、`agent_detection.rs` 等仿真层文件；`src/terminal/` 下是 `state.rs`、`runtime.rs`、`runtime_registry.rs`、`metadata.rs`、`history_read.rs` 等服务层文件——两个 "terminal" 目录各管一半。

## 模块架构

![pane 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-05-pane.svg)

`PaneRuntime::spawn()` 是唯一入口，`spawn_command_builder()`（`pane.rs:2258`）五步组装：① `crate::ghostty::Terminal::new` → `GhosttyPaneTerminal` → `Arc<PaneTerminal>`；② `TerminalCompressionTask::spawn`；③ portable-pty 起子进程 + `spawn_blocking` 的 child watcher（`child.wait()` → `classify_child_exit` → 阻塞式 `AppEvent::PaneDied`）；④ 构造 `on_read` 回调并 `PtyIoActor::spawn`；⑤ `spawn_basic_detection_task`（`pane.rs:710`）。app 侧随后**双注册**：`terminal_runtimes.insert(terminal.id, runtime)` + `state.terminals.insert(...)`（`app/creation.rs:146`）——运行时与纯状态各归各的表。

## 调用链路

**spawn 链路**：

```
app/creation.rs:create_workspace_with_launch_env
└─ Workspace::new_with_extra_env → TerminalRuntime::spawn（薄 newtype 门面）
   └─ PaneRuntime::spawn → spawn_with_initial_history() in pane.rs:1990
      └─ 组装 CommandBuilder：
         ├─ pane_shell_command_builder()        # login shell 解析
         ├─ apply_pane_terminal_env()           # 强制 TERM=xterm-256color
         ├─ apply_pane_launch_env()             # 注入 HERDR_WORKSPACE/TAB/PANE_ID
         │    # 清除 CODEX_THREAD_ID / OMPCODE 防误判嵌套会话
         └─ spawn_command_builder() in pane.rs:2258  # 上文五步
```

**PTY 读循环**（每个 pane 一条专用线程）：

```
PtyIoActorRunner::run() in pty/actor/unix.rs:505   # 非 async 专用线程
└─ fd::poll_pty_and_wake   # 同时 poll master fd 与自管 wake fd
   └─ read_once() → on_read 回调（pane.rs spawn 时注入）
      └─ PaneTerminal::process_pty_bytes() in pane/terminal.rs:1330
         ├─ 持 core mutex → 过滤 droid 兼容序列 → 按偏移切写（见终端仿真模块）
         ├─ 摘取 bells / OSC52 剪贴板 / OSC7 cwd → AppEvent
         └─ render_dirty.request_pty(pane_id) + render_notify.notify_one()
```

**agent 检测发布链**（三源合流的前半段）：

```
spawn_basic_detection_task() in pane.rs:710（300ms tick）
├─ detect::foreground_process_group_id(child_pid) → identify_agent_in_job()
│    → AppEvent::AgentProcessDetected → TerminalState::set_detected_agent_process_at()
├─ decide_detection_screen_read()（detection_content_seq 变化才读屏）
│    → terminal.detection_text() + agent_osc_title()/agent_osc_progress()
│    → detect_agent_with_osc() → AppEvent::StateChanged
└─ hook 权威（不经 PTY）：integration 脚本 → API → AppEvent::HookStateReported
     → TerminalState::set_hook_authority_with_session_ref()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `spawn_command_builder()` in `pane.rs:2258` | 五步组装 | 运行时与纯状态双注册 |
| `process_pty_bytes()` in `pane/terminal.rs:1330` | 字节流入口 | 先 `take_bell_count` 清空防播种历史副作用 |
| `spawn_basic_detection_task()` in `pane.rs:710` | 300ms 检测 | `AGENT_MISS_CONFIRMATION_ATTEMPTS=6` 去抖 |
| `run_terminal_compression_task()` | scrollback 压缩 | 全局 4 许可信号量 + generation 校验 |
| `try_send_bytes()` | 写 PTY | 满或关时 `TrySendError` 由调用方 warn |
| `drain_for_handoff()` | handoff 导出 | 状态/运行时分离的直接受益 |

</details>

## 核心实现

### PaneRuntime 与 PaneRuntimeIo

```rust
// src/pane.rs:1251
pub struct PaneRuntime {
    pane_id: PaneId,
    terminal: Arc<PaneTerminal>,          // 仿真核心
    io: PaneRuntimeIo,                    // I/O 抽象
    child_pid: Arc<AtomicU32>,
    reported_cwd: Arc<Mutex<Option<PathBuf>>>,
    content_seq: Arc<AtomicU64>,          // 内容修订号（渲染栅栏）
    content_write_lock: Arc<Mutex<()>>,
    detection_content_seq: Arc<AtomicU64>, // 检测专用修订号
    full_lifecycle_authority_active: Arc<AtomicBool>,
    pending_release: Arc<Mutex<Option<PendingAgentRelease>>, // 优雅释放抑制窗口
    compression: TerminalCompressionTask,
    detect_handle: Option<tokio::task::AbortHandle>,
}

// src/pane.rs:1272 —— 生产一个 variant，测试一个
enum PaneRuntimeIo {
    Actor(PtyIoActorHandle),
    #[cfg(test)]
    TestChannel { sender: mpsc::Sender<Bytes>, resize_tx: watch::Sender<(u16,u16,u32,u32)> },
}
```

`PaneRuntimeIo` 是"为可测性付的类型噪声"的坦率示范：把"PTY 的全部能力"（写、resize、handoff、foreground pgid）收口到一个 seam，`TestChannel` 让 pane.rs 的 88 个测试完全不碰真 PTY，生产路径只有 `Actor` 一个 variant。

### TerminalCompressionTask：caller-owned 的重活

libghostty 的 scrollback 压缩是 caller-owned 的重活，放在 PTY 读线程会卡 I/O。解法：空闲 250ms 后触发、`spawn_blocking` + **全局 4 许可信号量**（`terminal_compression_permits`，多 pane 共享 CPU 预算）、以 activity 计数 + generation 双重校验防"压缩途中又来新输出"的过期压缩；`Compressed(Pending)` 时 1ms 步进增量推进。这是 "multiplicative performance paths" 军规的典型应用：压缩频率 = 空闲 pane 数 × 压缩周期，必须限流。

### 写锁 + 双计数栅栏

`on_read` 里 `content_seq` 在写前后各 `fetch_add` 一次并夹住 `content_write_lock`——渲染线程用 seq 判断"读到的是完整一帧"而非撕裂中间态（`TerminalDirtyPatchSnapshot` 同理带 `content_revision`）。UI 线程读状态用 `try_lock_core`（`pane/terminal.rs:2162`）避免阻塞渲染。

### TERM 重写与 Drop 拆栈

`apply_pane_terminal_env`（`pane.rs:92`）强制 `TERM=xterm-256color`——注释解释：继承宿主 TERM 会把宿主终端身份泄漏进 shell/SSH，远端无对应 terminfo 时破坏重绘。`Drop for PaneRuntime`（`pane.rs:1450`）按 detect → compression → io → 进程杀的顺序确定性拆栈；`preserve_processes_on_drop` 支撑 handoff 场景（进程要交给新 server，不能杀）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Actor + Handle | `PtyIoActorHandle` in `pty/actor/unix.rs` | 专用线程 + wake-fd 替代轮询 |
| RAII 确定性关停 | `Drop for PaneRuntime` in `pane.rs:1450` | 拆栈顺序明确，handoff 可豁免 |
| 迁移门面 newtype | `TerminalRuntime(PaneRuntime)` in `terminal/runtime.rs` | 配合 `pane/terminal/migration_tests.rs` 渐进迁移 |
| 回调注入 | `on_read`/`on_reader_exit` in `PtyIoActorConfig` | pane 与 actor 解耦 |
| 状态机 + generation | `TerminalCompressionWake{notify, generation}` | 防过期压缩竞态 |

## 模块间交互

- **terminal/**：`TerminalState` 仲裁三源检测结果；`TerminalRuntimeRegistry` 管活运行时；`history_read.rs` 的 `merge_scrolled_up`/`snapshot_text` 不持锁重建滚动历史
- **pty/**：只提供进程与 I/O actor，不懂终端语义
- **detect/**：manifest 与启发式都在那边，pane 只调用不实现
- **app/**：经 `TerminalRuntime` 门面消费，事件总线是 `AppEvent`（`events.rs:57`）

## 扩展方式

- **新增 agent 识别**：只改 `detect/manifests/`（数据）——检测任务与 manifest 热更新（`AppEvent::AgentDetectionManifestsUpdated`）全自动生效
- **新增 OSC 元数据能力**：`pane/osc.rs` tracker → `events.rs` 的 `HookMetadataReported` → `terminal/metadata.rs` 的 `AgentMetadata`（TTL/seq 守卫）→ `effective_presentation`
- **更换 PTY 后端**：只动 `pty/backend.rs` 与 `fd.rs`，`PaneRuntime` 零改动——actor 接口不变

---

## 边缘机制速查

闭卷验证补充：

### 环境注入与压缩调度

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `PANE_TERM / PANE_COLORTERM` | `apply_pane_terminal_env in pane.rs` | TERM=xterm-256color、COLORTERM=truecolor——宿主终端身份不泄漏进子进程；启动时移除 WT_SESSION/CODEX_THREAD_ID/OMPCODE 防误判嵌套 agent 会话
| `TERMINAL_COMPRESSION_IDLE` | `pane.rs` | 250ms 空闲稳定期后才触发压缩；TerminalCompressionWake{notify, generation} 的 generation 校验防'压缩途中又来新输出'的过期压缩；try_compress_incremental_if_activity 在有活动时增量推进

### 检测去抖与探测调度

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `foreground_shell_agent_action / PendingAgentRelease` | `pane.rs` | 前台 agent 消失不立即清除身份——先进入 pending 释放窗口（1s 抑制），避免 agent 短暂 shell out（git 调用等）导致状态闪烁
| `PendingIdleConfirmation` | `pane/agent_detection.rs` | Working→普通 Idle（无 visible_idle 信号）要 should_hold_working_to_idle 判定后延迟发布：AGENT_PENDING_IDLE_CONFIRMATIONS 次确认 / AGENT_PENDING_IDLE_CAP 时间上限；visible_idle、进程退出、agent 切换直接绕过
| `should_probe_foreground_job / PROCESS_ACQUISITION*` | `pane.rs` | 内容变化触发 8s acquisition window（快查 500ms/慢查 2s），常规 5s 重查、无前台组 30s；change tracking 只用内核观测的 process_group_for_change_tracking 而非推断值
| `AgentOscStateTracker` | `pane/osc.rs` | 被动截获 OSC 0/2 标题与 OSC 9 进度；sanitize_agent_osc_string 过滤控制字符并截断到 AGENT_OSC_MAX_CHARS（256）；clear_retained 在 agent 切换时清 retained 证据但保 parse 状态（跨边界的序列归属新 agent）

### PTY 字节旁路处理

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `maybe_filter_primary_screen_scrollback_clear` | `pane/terminal.rs` | 主屏 + droid 前台时剥除 scrollback-clear 序列，防 droid 清屏习惯误杀 scrollback
| `respond_to_default_color_event` | `pane/terminal.rs` | 默认色查询由 herdr 应答宿主主题色（DefaultColorEventTracker 区分 Query/Set/Reset），与库应答按字节偏移交错（write_pty_bytes_with_ordered_responses）
| `render_delay_after_pty_write` | `pane/terminal.rs` | 同步输出模式（MODE_SYNCHRONIZED_OUTPUT）抑制渲染请求 + 写后光标落定延迟合帧；ProcessBytesResult 汇总 bells/剪贴板/cwd/渲染请求