---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "终端仿真引擎"
date: "2026-09-17T10:51:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
contentType: "CodeWiki"
tags: ["herdr", "Rust", "ghostty", "VT100", "FFI"]
description: "herdr 终端仿真：vendored libghostty-vt（Zig）+ 手写 FFI 安全层，OSC 拦截与三源 agent 状态仲裁。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

终端仿真回答的问题是"PTY 里涌出来的字节流如何变成一个可查询的 cell 网格"。herdr 没有自己写 VT 解析器，也没有用 Rust 生态的 vte/wezterm-term，而是 **vendor 了 ghostty 的 VT 引擎 libghostty-vt**——一个带 C ABI 的 Zig 库（`vendor/libghostty-vt/`，757 个 Zig 文件，`build.rs` 用 `zig build` 编译成静态库）。本模块覆盖四层：FFI 绑定层（`ghostty/bindings.rs`，bindgen 生成）→ 安全包装层（`ghostty/mod.rs`，4,598 行手写）→ pane 仿真层（`pane/terminal.rs` 7,214 行 + `pane/osc.rs` 等）→ PTY IO 层（`pty/`），加上 `src/terminal/` 的状态仲裁服务层。

为什么 vendor ghostty（从功能面与补丁记录推断，原始决策文档未在仓库中找到直接陈述）：libghostty-vt 提供带回调的 C ABI 天然适配 FFI 嵌入；带 kitty graphics 支持、精确 dirty 追踪、grapheme 聚类；且 vendoring 治理成熟——`vendor/libghostty-vt.vendor.json` 锁定上游 commit，`libghostty-vt.patches.md` 逐条记录本地补丁的存在理由/验证/移除条件（如 0002 补丁为 herdr 暴露 modifyOtherKeys 模式查询）。

## 模块架构

![terminal 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-06-terminal.svg)

数据自下而上：PTY Actor 专用线程读到字节后调 `on_read` 回调进入 `process_pty_bytes()`（前置扫描 + 按偏移切写）；`GhosttyPaneCore` 是单锁核心，聚合仿真终端与一排 tracker（默认色、agent OSC 证据、kitty keyboard 协议栈、光标形状、XTGETTCAP）；`ghostty::Terminal` 是 C 句柄的 RAII 包装；最底层 libghostty-vt 做 VT 解析。右侧 `TerminalState` 是纯状态镜像——不含任何屏幕数据，只仲裁 agent 状态（`AGENTS.md` 军规 "Detection is decoupled" 的落点：detector 读屏幕快照，从不碰 parser 状态）。

## 调用链路

**PTY 字节流 → 屏幕更新**：

```
PtyIoActorRunner 读到字节（pty/actor/unix.rs:443 起，专用线程 poll）
└─ PaneTerminal::process_pty_bytes() in pane/terminal.rs:1330
   ├─ 前置字节扫描：default_color_tracker / agent_osc_state / kitty_keyboard /
   │    c1_xtgettcap_tracker / decscusr_tracker 逐个 observe
   ├─ write_pty_bytes_with_ordered_responses() in pane/terminal.rs:1485
   │    # 按拦截事件的字节偏移切分写入：
   │    ├─ core.terminal.write() → ffi::ghostty_terminal_vt_write（Zig 解析器）
   │    ├─ drain_pending_pty_responses()（库产生的 DA/DSR 应答）
   │    └─ 插入 herdr 自定义应答（宿主主题色回报），顺序与字节序一致
   ├─ trampoline 回调收取：take_bell_count / take_clipboard_writes / take_pwd_changes
   └─ ProcessBytesResult → render_dirty.request_pty + render_notify
```

**dirty 区域提取**（渲染时）：

```
collect_dirty_patch() in pane/terminal.rs:2424
└─ ghostty_collect_dirty_patch:2542
   ├─ render_state.dirty() → Dirty::{Clean, Partial, Full}
   ├─ RowIterator::next_dirty() in ghostty/mod.rs:3044 逐行取脏行
   ├─ RowSelection.range() 给出脏列区间 → 组装 patch
   └─ 错误走 fallback! 全量重绘；完成后 clear_dirty + render_prof 打点
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `process_pty_bytes()` in `pane/terminal.rs:1330` | 字节流入口 | 顶部先清空回调效果防播种历史冒充实时输出 |
| `write_pty_bytes_with_ordered_responses()` in `pane/terminal.rs:1485` | 切分写入 | 应答按字节偏移交错，顺序严格 |
| `encode_terminal_key()` in `pane/terminal.rs:1979` | 键位重编码 | Ghostty encoder 优先，回落纯 Rust 编码器 |
| `active_screen()` / `scrollbar()` | alt screen / 滚动状态 | resize 保存 offset-from-bottom 用于恢复 |
| `set_hook_authority_at()` in `terminal/state.rs` | hook 仲裁 | 会话身份/生命周期权威 |
| `seed_handoff_input_state()` | handoff 重放 | ANSI 重放鼠标/键盘协议状态 |

</details>

## 核心实现

### FFI 安全层：RAII + trampoline

```rust
// src/ghostty/mod.rs:815 — C 句柄的 RAII 包装
pub struct Terminal {
    raw: ffi::GhosttyTerminal,
    max_scrollback: usize,
    callback_state: Box<TerminalCallbackState>,   // userdata 指针
    kitty_fingerprints: Mutex<HashMap<u32, KittyImageFingerprintEntry>>,
}

// src/pane/terminal.rs:188 — pane 拥有的仿真核心（单锁串行化）
pub(crate) struct GhosttyPaneTerminal {
    pub core: Mutex<GhosttyPaneCore>,
    key_encoder: Mutex<crate::ghostty::KeyEncoder>,
    pending_pty_responses: Arc<Mutex<Vec<Bytes>>>,
}
```

C 边界的惯用法在这里集齐：`Terminal`/`RenderState`/`KeyEvent`/`KeyEncoder`/`MouseEncoder`/`RowIterator`/`KittyPlacementIteratorGuard` 全部有 `impl Drop`（guard 语义保证迭代器异常路径也释放）；`Box<TerminalCallbackState>` 裸指针经 `GHOSTTY_TERMINAL_OPT_USERDATA` 注册，bell/pwd_changed/clipboard_write/color_scheme/size 五个 trampoline 把 C 回调收窄回 `&mut TerminalCallbackState`——不在 C 边界传 Rust 闭包；`ghostty_grid_ref_graphemes` 用两段式缓冲查询（先传 null 拿 required 长度再分配重调）实现零拷贝。注意 `bindings.rs` 首行注明由 rust-bindgen 0.72.1 生成——手写的是安全包装层而非绑定。

### OSC 拦截：herdr 在 VT 流里的哨兵

libghostty 自己消化 OSC 10/11/12（颜色）、52（剪贴板）、7（cwd，经回调暴露）；herdr 在 Rust 侧用 `OscStreamCollector`（跨 chunk 状态机，`pane/osc.rs:329`）复扫字节流，分发给 tracker：`DefaultColorOscTracker` 区分 Query/Set/Reset——**查询必须由 herdr 应答宿主终端的真实主题色而非库默认色**；`AgentOscStateTracker`（`observe:467`）捕获 OSC 0/2 标题与 OSC 9 进度作为 agent 证据，`clear_retained` 防止前一个进程的证据泄漏给新 agent。还有一处兼容性过滤：主屏下前台 job 是 droid 时剥除 scrollback-clear 序列（`pane/osc.rs:742`）——droid 的清屏习惯会误杀 herdr 的 scrollback。

### TerminalState：三源仲裁的集中地

`src/terminal/state.rs`（约 6,100 行的 god node）文件头注释明确了仲裁规则：full-lifecycle hook 报告有权威性（`HookAuthority`），屏幕恢复检测仅作 fallback；进程退出会先清除匹配的 hook 权威再重算——避免 agent 结束后状态卡在 Working。`agent_metadata` 走 `terminal/metadata.rs` 的 seq/TTL 守卫与 `effective_presentation`（显示 title/display_agent/state_labels 的 TTL 淘汰）。

### PTY Actor

`src/pty/actor/unix.rs` 的 `PtyIoActorRunner` 是非 async 的专用线程：poll master fd + 自建 wake pipe（handle 发命令后 `wake_actor` 唤醒），三条 channel（data/control/write），用户输入提交（`SubmitUserInput`）带 deadline/分阶段写入语义。为什么不用 tokio：PTY fd 在等价就绪语义上跨平台坑多（Windows named pipe 行为不同），专用线程 + poll 是最可控的形态。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| RAII FFI 包装 | `ghostty/mod.rs:2140` 起 | C 资源异常路径也释放 |
| userdata + trampoline | `ghostty/mod.rs:488` | C 回调边界安全收窄 |
| 单锁核心 + 双向编码器 | `Mutex<GhosttyPaneCore>` + `KeyEncoder` | 串行化访问；输入输出对称编码 |
| Actor 模式 | `PtyIoActor` in `pty/actor/unix.rs:377` | 专用线程 + wake pipe |
| 纯函数决策层 | `pane/agent_detection.rs` | `decide_detection_screen_read` 等无副作用，易测试 |

## 模块间交互

`pane.rs:2161/2322` 构造 `GhosttyPaneTerminal` 并接 PTY actor；`TerminalRuntime`（`terminal/runtime.rs`）以 newtype 委托 `PaneRuntime`，向 server 暴露 `render`/`scroll_up`/`agent_osc_title`/`visible_text` 等 40+ 门面方法；`TerminalState` 由 workspace/session 层持有，经 `EffectiveStateChange`/`TerminalStateMutation` 接收仲裁结果。handoff 时 `seed_handoff_input_state` 用 ANSI 重放协议状态、`restore.rs` 用 `spawn_with_initial_history` 播种历史。

## 扩展方式

- **支持新的 OSC 拦截**：`pane/osc.rs` 复用 `OscStreamCollector` 加 tracker 结构 → `GhosttyPaneCore` 加字段 → `process_pty_bytes` 里 observe+drain → 需要应答则在 `write_pty_bytes_with_ordered_responses` 的事件合并中注册
- **新增 agent 识别**：`detect/mod.rs` 的 `Agent` 枚举 + manifest 规则（metadata 仲裁已按 label 泛化，无需动）
- **升级 libghostty-vt**：换 `vendor.json` 的 commit，按 `libghostty-vt.patches.md` 逐条 rebase/移除补丁并跑 `just check` 验证补丁可逆应用

---

## 边缘机制速查

闭卷验证补充：

### FFI 配置与 kitty 图形

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `Terminal::new 选项` | `ghostty/mod.rs` | terminfo 名取 crate::pane::PANE_TERM；scrollback 上限经 GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES；MODE_GRAPHEME_CLUSTER 默认开；glyph_protocol=false；unsafe impl Send 手工担保（C 句柄本身不含线程语义）
| `kitty 图形管线` | `ghostty/mod.rs` | KITTY_IMAGE_STORAGE_LIMIT_BYTES=64MB 存储 + install_png_decoder_once 装 PNG 解码器；kitty_image_placements_with_data_filter 用 generation 与 kitty_empty_generation 跳过空存储；kitty_image_fingerprint_cached 按 image_id 缓存指纹、generation 变化重算；prune_kitty_fingerprints 按存活 id 清理；placement 按 z 排序；压缩图（compression != NONE）跳过
| `capture_clipboard_write` | `ghostty/mod.rs` | OSC 52 回调安全捕获：仅 STANDARD 剪贴板（否则 UNSUPPORTED）、单条内容、text/plain MIME（忽略 params）、空内容直接 SUCCESS（忽略清除请求）、MAX_CLIPBOARD_BYTES=192KB 超限 INVALID_DATA

### 仲裁与托管 agent

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `recompute_effective_state` | `terminal/state.rs` | visible blocker 压过 hook authority，无有效 hook 回退 fallback_state；label/state/presentation 均未变时返回 None 不更新；TerminalStateMutation{effective_state_change, session_ref_changed, agent_released}
| `recent_agent_process_exit / clear_agent_name` | `terminal/state.rs` | 进程退出不等于 agent 离开——名字是'所有者对 pane 的唯一句柄'，仅 agent 为 None 且有近期退出记录才释放；newer_custom_authority 保护自定义 hook 权威不被退出清除；官方 source 的 session 以 ProcessExit 理由抑制
| `ManagedAgentPhase` | `terminal/state.rs` | 托管 agent 三阶段 Pending{ready_after, deadline, observed_expected}/Blocked/Active：begin_managed_agent 初始化 owner；reconcile_managed_agent_at 在进程退出/kind 不匹配/预期 agent 消失时清名，Pending 在 Idle 时转 Active；next_managed_agent_deadline 取 min(ready_after, deadline)
| `finish_agent_process_acquisition` | `terminal/state.rs` | 达到 Idle 且无近期退出时抑制完成信号——acquisition 期间的 Idle 不是终点

### 运行时与 PTY actor

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `TerminalRuntimeRegistry` | `terminal/runtime_registry.rs` | 放在 AppState 之外（注释：让纯状态不依赖 PTY/解析后端）；handoff 批量方法 set_handoff_readers_paused / assume_handoff_ownership / drain_for_handoff
| `TerminalId::alloc` | `terminal/id.rs` | 格式 term_{微秒:x}{计数器:x}，static AtomicU64 保证并发唯一
| `screen_text_snapshot_with_seq` | `terminal/runtime.rs` | content_seq 前值须为偶数且 before==after，最多 3 次重试防撕裂读，失败返回 None——写锁双计数栅栏的消费端
| `ActorState / ACTOR_IDLE_POLL_MS` | `pty/actor/unix.rs` | Running/Quiesced/Released 三态；线程名 herdr-pty-{pane_id}；idle 轮询 1000ms 只是 missed wake 的兜底，wake pipe 才是主驱动
| `SubmissionPhase` | `pty/actor/unix.rs` | WritingText → WaitingUntil(延迟) → WritingEnter 的输入提交状态机（text 写完设边界延迟，enter 延迟写出）
| `HANDOFF_DRAIN_TIMEOUT / ReleaseAfterCommit` | `pty/actor/unix.rs` | DuplicateForHandoff 仅在 Quiesced 时成功（2s 排空上限）；ReleaseAfterCommit 置 Released 清 pending_writes 后退出主循环——handoff 的两阶段在 PTY 层的对应
| `nudge / resize_pty_fd` | `pty/actor/unix.rs · pty/fd.rs` | nudge 小改尺寸促子进程重绘（rows-1 或 cols-1 下限 4，30ms 后还原）；resize_pty_fd 算 ws_xpixel/ws_ypixel（min u16::MAX）后 ioctl TIOCSWINSZ
| `spawn_with_portable_pty` | `pty/backend/unix.rs` | duplicate_cloexec_fd 复制 master fd 给 actor 后 drop 掉 portable-pty pair（portable_pty_setup_leaves_one_parent_pty_fd 测试守护 fd 不泄漏）