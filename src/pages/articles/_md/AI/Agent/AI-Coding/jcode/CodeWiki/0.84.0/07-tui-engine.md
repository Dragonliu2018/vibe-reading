---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "TUI 渲染引擎"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "AI Coding", jcode, CodeWiki, "0.84.0"]
tags: ["jcode", "Rust", "TUI", "ratatui", "StreamBuffer", "InfoWidget", "SSH"]
description: "jcode TUI 渲染引擎——TuiState 114 方法展示接口、redraw 调度（idle 250ms/deep 5s）、四层 prepared frame 缓存、StreamBuffer 比例控流平滑、InfoWidget 负空间渲染与 settle、远程 SSH attach"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

`crates/jcode-tui/`（`src/tui/` 主渲染 ~61K 行 + 周边 crate）是 jcode 的 ratatui 终端客户端。标准 TUI 是**纯远程客户端**（自身没有 Agent，经 socket 与 daemon 通信）——这让渲染层与会话执行彻底解耦，也让 v0.83.0 的"本地 TUI + 远程 server"SSH 模式几乎免费。模块的工程主题是把 CPU 和内存压到极限（多会话工作区不烧核）同时保持丝滑（60fps 装饰动画、流式平滑上屏）。

---

## 模块架构

核心三角：`App`（`app.rs:832`，大状态聚合体，字段按 TokenAccounting/KvCacheState/StreamingProgress/CostState 分组）→ `TuiState`（`mod.rs:270`，114 方法的展示 trait）→ `ui::draw`（`ui.rs:2655`，渲染树）。周边 crate：`jcode-tui-core`（StreamBuffer/CopySelection）、`jcode-tui-messages`（DisplayMessage + per-message 缓存）、`jcode-tui-markdown`（pulldown_cmark + syntect）、`jcode-tui-mermaid`（mermaid→PNG）、`jcode-render-core`（后端中立渲染模型——TUI 与桌面 GPU UI 共享 `parse_markdown → Document → wrap → adapter` 管线，各前端只写薄适配层）。

`TuiState` 为什么这么宽（`docs/TUISTATE_TRAIT_DECOMPOSITION.md` 的分析）：它是 `App` god-object 的展示层镜像，约 50 个渲染函数收 `&dyn TuiState`、~95 处消费散布在 29 个文件。结构性限制有二：`App` 反正要实现全部表面（拆 trait 不减少实现量）；Rust 没有稳定的 `&dyn (A + B)`，两个中央渲染器 `ui.rs`/`ui_viewport.rs` 用到几乎每个域。实测 ~28 个消费模块里只有 2 个跨域——拆分价值在"叶模块收窄 bound + 可读性"。拆分计划是增量抽 15 个子 trait，每步独立可编译。

---

## 调用链路

```
App::run_remote() [app/run_shell.rs:775]
  └─ tokio::select!(biased)   输入 > 远端事件 > 定时器
       ├─ event_stream.next() → apply_terminal_event → 按键处理
       │    Enter → submit → begin_remote_send → Request::Message 写 socket
       ├─ remote.next_event() → handle_remote_event [app/remote.rs:833]
       │    TextDelta → stream_buffer.push_text → 平滑 ops
       │    Done → flush → 提交 DisplayMessage → is_processing=false
       └─ tick → redraw_interval 决定本帧节奏
            full frame: ui::draw(frame, &app)   或
            animation-only partial: copy_cells_in_rect 只拷动画矩形
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `redraw_interval_with_policy_and_animation()` in `redraw_schedule.rs` | 本状态 tick 节奏 | 分支优先级从 tail-catchup 到 deep-idle |
| `periodic_redraw_required_excluding_idle_animation()` in `redraw_schedule.rs` | 区分整帧/动画帧 | 装饰动画走 partial repaint |
| `prepare_body_cached()` in `ui_prepare.rs` | body 三层增量缓存 | prefix_exact → prefix_reuse → suffix_reuse |
| `push_text()` in `jcode-tui-core/src/stream_buffer.rs` | 入站文本进 backlog | arrival 与 reveal 解耦 |
| `flush_smooth_frame()` in `app/turn.rs` | 每 tick 泄出 | cps = 180 + backlog×3，硬顶 960 |
| `compute_visible_margins()` in `ui_viewport.rs` | 负空间计算 | InfoWidget 只进空闲宽度 |
| `next_event()` in `backend.rs:1108` | socket 读循环 | 持久 buffer + 扫描游标防 O(n²) |

</details>

---

## 核心实现

### redraw 调度：多会话工作区的 CPU 总量

`redraw_schedule.rs` 回答两个正交问题：**tick 节奏**（`REDRAW_IDLE = 250ms`、`REDRAW_DEEP_IDLE = 5s`、`REDRAW_DEEP_IDLE_AFTER = 30s`）和**本 tick 是否真要画**。节奏分支优先级：tail-catchup/overscroll 倒计时（动画帧率）→ 失焦且空闲（直接 deep-idle——事件循环睡眠避开共享 server bus chatter）→ deep-idle（**流不活跃且用户 30s 未交互同时成立**——`time_since_activity()` 单独不算，恢复的历史会话它恒真，这是 idle donut 永不出现的 bug 修复）→ 装饰动画（`DECORATIVE_ANIMATION_FPS_CAP = 30`，附实测表：60fps 烧 0.224 core、30fps 0.104 core，30fps 已饱和终端 3x3 子像素网格）→ spinner → 处理中（`redraw_fps`）→ 静态 chrome（250ms 足够 retire）。

**animation-only partial repaint**：只有装饰动画推进时 `copy_cells_in_rect` 只拷动画矩形（旧实现整帧 `clone_from` 在 160x48/60fps 下每秒 ~92 万 cell 拷贝只更新 ~2200 cell）；守卫 `idle_animation_fast_path_blocked_reason`（input_changed——否则击键要等 ~500ms 才上屏）。`FULL_FRAME_REDRAW_REASONS` 原子记录最后整帧原因供 `draw-stats` 诊断。

### 四层缓存体系

`ui_prepare.rs`（2675 行）：

1. **`display_messages_version()`**：`App` 的单调计数器（`state_ui_messages.rs::bump_display_messages_version`），body 缓存失效的粗粒度信号
2. **body 缓存**：`BodyCacheKey = {width, diff_mode, messages_version, diagram_mode, ...}`；未命中时 `take_best_incremental_base` 取旧帧做三层增量——`prefix_exact`（纯 append）→ `prefix_reuse`（尾部编辑/finalize：截断到匹配前缀只重渲染尾部）→ `suffix_reuse`（加载压缩历史时老消息从上方 prepend，只渲染新 head 再拼接，修复 #344 长会话滚动卡顿）
3. **per-message 缓存**：`MESSAGE_CACHE_LIMIT = 2048`，key 含 `stable_cache_hash + width + mermaid_epoch`
4. **`AssistantAuxData` memo**：为 assistant 消息缓存 copy-selection 需要的 wrapped→raw 行映射（每次 body miss 原本要把同一 markdown 重渲染 2-3 遍；LRU 上限 2048）

### StreamBuffer：把 arrival 与 reveal 解耦

`jcode-tui-core/src/stream_buffer.rs` 的问题定义：OpenAI 每 10-15ms 几个字符（本来就平滑），Anthropic 合并成 20-40 字符每 80-100ms 的突发（直接 reveal 会"楼梯步进"）。机制：入站进 `VecDeque` 有序 backlog（Text/Reasoning chunk + 零宽 CloseReasoning 标记），时间驱动的**比例控制器**泄出——`BASE_REVEAL_CPS = 180` 字/秒、`REVEAL_BACKLOG_GAIN = 3.0`（cps = 180 + backlog×3，稳态 backlog ≈ `(R−180)/3`，追得上快模型且延迟有界）、`MAX_REVEAL_CPS = 960` 墙钟硬顶（防 3k backlog 一帧泄 500+ 字符）、`MAX_REVEAL_STEP = 50ms`（空闲 gap 不能攒预算倾泻）。本地流（`app/turn.rs`）与远程流（`app/remote.rs:121`）共用同一平滑。

### InfoWidget：负空间渲染 + settle/stability

15 种卡片（Overview/Todos/ContextUsage/KvCache/SwarmStatus/...）渲染在 transcript 行的**负空间**——每行文字右侧的空闲宽度，"只占用屏幕本来就不用的地方"。两个专门的机制：

- **settle**（`info_widget_settle.rs`）：`SettlementTracker` 逐帧观察每行 free-width profile，`SETTLE_AFTER_FRAMES = 3` 连续相同才算 settled——未 settle 的行宽度为 0，布局引擎不能在那里放新卡片。这挡住流式尾部、markdown 重渲染造成的抖动。已放置的 widget 做"居民"模型（`WidgetAnchor` 钉绝对行号，`MAX_HIDDEN_FRAMES = 120` 才允许重新安家）
- **stability**（`info_widget_stability.rs`）：把"滚动时 widget 分散注意力"变成可测数字——`analyze_frames`/`simulate_scroll` 逐行滚动产帧序列，`WidgetMotion` 统计 flicker（appear/disappear）、content_y_travel（实际 dy − 期望 scroll-ride 残差）、recycles——供 A/B 验证布局改进

### mermaid 渲染：纯 Rust 管线

mermaid 源 → `mermaid_rs_renderer` parse + layout（纯 Rust，取代 mermaid-cli 的 headless Chrome + Node，作者宣称 1800x 快）→ `resvg` 光栅化 PNG → `ratatui_image` 按终端能力选 Kitty/Sixel/iTerm2/halfblock 协议。缓存：磁盘 PNG 缓存（`~/.cache/jcode/mermaid`，512 条目）+ 内存 layout 缓存（32——Layout 是最贵阶段，debug build 中型图 ~580ms）+ 宽度分桶防模糊放大。未命中缓存时向后台渲染线程入队返回 None，UI 先画 placeholder，完成时 `bump_deferred_render_epoch()` 使上游缓存自动失效。Kitty 专项：缓存 virtual-placement id 滚动复用终端侧已传图像，evict 时捎带删除序列回收终端像素内存。

### Synchronized Update 与 KV cache 冷检测

整帧渲染用 crossterm 的 `BeginSynchronizedUpdate` / `EndSynchronizedUpdate` 包裹（`run_shell.rs:476`）——终端原子应用整帧 cell 变更，消除逐 cell 流式输出在 eager-repaint 终端上的可见闪烁。**KV cache 冷检测**：`App.kv_cache: KvCacheState` 追踪 provider 端 prompt 前缀缓存状态——Anthropic Claude cache 5 分钟后冷却，UI 会在 cache went cold 时警告并提示 unexpected cache miss 的 token 成本；redraw 调度里还有专门的 `cache_cold_countdown_redraw_active` 分支（`redraw_schedule.rs:226`）驱动冷却倒计时动画。**布局切换**：默认 left-aligned（消息区占满左侧，InfoWidget 仅右侧 margin）；`Alt+C` / `/alignment` / config 切 centered（widget 分布两侧 margin）。

### 远程 SSH attach 与内存优化

**SSH**（v0.83.0）：`jcode --ssh dev` → `NativeSsh::connect_with_workspace` 把远端 daemon 的 server socket 桥接到本地 socket path → 本地跑普通 `run_tui_client`——架构是"本地 TUI + 远程执行"，workspace/工具/凭据全留远端。`RemoteConnection`（`backend.rs:235`）的 newline-delimited JSON 读循环用持久 buffer + 扫描游标（防几十 MB History 事件时换行扫描退化 O(n²)）。`/login` 在远程主机执行；`--import-local` 显式同意后一次性拷贝本地凭证且不覆盖远端。

**内存**（每会话增量 ~10.4 MB vs Claude Code ~212.7 MB）：`idle_heap_release.rs` 的 glibc arena 滞留回收（`CLIENT_RETENTION_TRIM_THRESHOLD_BYTES = 16MB` 每 client，空闲 60s edge-triggered trim + 30s watchdog）；结构性省内存（`CompactedHistoryLazyState` 老历史按需加载 64 条/块、`Arc<PreparedMessages>` 共享而非复制）；`docs/MEMORY_BUDGET.md` 的棘轮预算给每个显式 cache 定上限（message 2048、mermaid render 512/layout 32/图片状态 12/aux 2048），每项绑定代码里的具名常量。

---

## 模块间交互

向下经 `jcode-protocol` 的 `Request`/`ServerEvent` JSON 与 daemon 通信（`jcode-transport` 抽象跨平台 socket）；`Bus::global()` 的进程内事件（clipboard/dictation/git status 等 off-UI-thread 工作完成通知）在本地触发重绘。`TuiState` 是渲染器与 `App` 的唯一接口——测试实现 `ui_tests/mod.rs` 的 `TestState` 可以脱离真实 App 跑快照测试。

---

## 扩展方式

**新增 TUI 命令**：`app/commands_dispatch.rs::dispatch_local_command`（本地）或 `commands_remote.rs`（远程）加分支 → 逻辑放 `commands*.rs` 之一 → 补 `command_candidates_cache` 来源；远程/本地行为不同注意 `is_remote_mode()` 分流。**新增 InfoWidget 卡片**：`info_widget.rs` 的 `WidgetKind` 加枚举 + `priority()` 次序 → 新建 `info_widget_<name>.rs` → `InfoWidgetData` 加数据字段（producer 在 `app/tui_state.rs:1599`）→ 依赖上下文新鲜度走 `ContextSnapshot{revision, fresh}` 而非裸 `context_info()`（否则 settle 后的缓存展示陈旧数据）→ 用 `info_widget_stability.rs::analyze_frames` 验证不引入 jiggle。
