---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "TUI 渲染引擎"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "TUI", "StreamBuffer", "InfoWidget", "Mermaid"]
description: "jcode TUI 渲染引擎——14ms 首帧、双令牌桶 StreamBuffer、5s 深空闲帧调度、InfoWidget 负空间锚定、Synchronized Update 消闪烁"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)

---

## 模块定位

TUI 渲染引擎是 jcode 性能优势的门面——14ms 首帧、千 fps 渲染、无闪烁。它作为 server 的客户端运行，负责终端 UI 渲染、流式平滑、info widget 布局、mermaid 图表。模块位于 `crates/jcode-tui/src/tui/`（90+ 文件，204K 行——jcode 最大 crate），是 jcode 区别于其他 harness 的核心体验层。

---

## 模块架构

- **app.rs** — `App` struct 主循环（100+ 字段）
- **ui.rs** — UI 渲染入口 `draw()`
- **redraw_schedule.rs** — 帧调度（5s 深空闲 → animation FPS）
- **stream_buffer.rs**（`jcode-tui-core`）— 流式缓冲双令牌桶
- **info_widget*.rs** — 15 种 info widget + 负空间布局
- **markdown.rs / mermaid.rs** — markdown 与 mermaid 渲染
- **backend.rs** — server 客户端通信
- **ui_*.rs** — 各 UI 组件（header/messages/diff/pinned/...）

`App` struct（`app.rs:830`）持有 `provider`、`registry`、`messages`、`display_messages`、`stream_buffer`、`kv_cache: KvCacheState`、`token_accounting` 等 100+ 字段。

---

## 调用链路

```
App::run()                                   run_shell.rs:635
  loop {
    1. redraw_interval() → 计算当前帧率
    2. needs_redraw? → draw_full() / draw_idle_animation_only()
    3. tokio::select! { biased;
         event_stream.next()  → handle_terminal_event()
         redraw_interval.tick() → handle_tick()
         bus_receiver.recv()  → handle_bus_event()
       }
  }

流式响应增量渲染:
  Provider StreamEvent::TextDelta(text)
    → stream_buffer.push_text(&text)
      → reveal_now()  按 cps 速率返回 Vec<StreamOp>
        → apply_stream_ops(ops)
          → append_streaming_text() → needs_redraw = true → draw_full()

  redraw tick 空闲时:
    handle_tick() → stream_buffer.flush_smooth_frame()  继续揭示 backlog
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `App::run()` | 事件循环主入口 | biased select 优先输入 |
| `redraw_interval_with_policy_and_animation()` | 帧率调度 | 5s 深空闲 → animation FPS |
| `stream_buffer.reveal_now()` | 流式揭示控制 | 双令牌桶 |
| `find_all_empty_rects()` | 负空间扫描 | widget 锚定 transcript 行 |
| `draw_full()` | 全帧渲染 | Synchronized Update 包裹 |

---

## 核心实现

### Stream Buffer 双令牌桶

`StreamBuffer`（`jcode-tui-core/src/stream_buffer.rs:86`）防止 provider 突发（如 2000 字/ms）一帧倾泻成文字墙。双令牌桶设计：

- **比例控制器**（`carry`）：base 180 cps + backlog×3.0 增益跟赶积压
- **独立硬上限**（`ceiling_carry`）：960 cps 墙钟硬上限，防止突发

`reveal_now()`（`stream_buffer.rs:257`）按速率返回 `Vec<StreamOp>`；`flush_smooth_frame()` 在 tick 中持续排空 backlog。`MAX_STEP = 50ms` 限制单步时间。

### 帧调度（Redraw Schedule）

`redraw_schedule.rs:393` `redraw_interval_with_policy_and_animation()` 根据状态动态选择 tick 间隔，从 5s deep-idle 爬升到 animation FPS。`periodic_redraw_required()`（line 581）区分"真实状态变更需全帧"vs"仅装饰动画前进"，后者走 `draw_idle_animation_only()` 部分重绘。

关键决策：
- **深空闲 5s**：大量 dormant tab 不应各自以 60fps 空转 saturate CPU
- **装饰动画 typing 时降速**：60fps donut 让按键排在 in-flight 帧后面，输入卡顿
- **animation_on_screen 检测**：防止 overlay 全屏覆盖时仍以 animation_fps 空转全帧（实测 63 帧/s 改 0 cell）
- **Deep idle 需双信号**：仅 stream dormant 会误判新 session（onboarding 静态但用户在打字）；加 user_interaction 信号

### Info Widget 负空间利用

`info_widget_layout.rs:174` `find_all_empty_rects()` 扫描消息区域右侧/左侧 margin 的逐行空闲宽度，在负空间中放置 widget。`WidgetAnchor`（line 28）将 widget 锚定到 transcript 行号，使其随文本滚动而非抢占响应区。

15 种 `WidgetKind`（`info_widget.rs:71`）：Overview/Todos/ContextUsage/Diagrams/GitStatus/Memory/Timeline/Usage/Tips 等，每种有 `priority()`/`preferred_side()`/`min_height()` 属性。`all_by_priority()`（line 169）按优先级排序放置。

### Synchronized Update 双缓冲

`run_shell.rs:476` `BeginSynchronizedUpdate` / `EndSynchronizedUpdate` 包裹整帧，终端原子应用所有 cell 变更，消除闪烁。ratatui crossterm 后端逐 cell 流式输出，eager-repaint 终端可见闪烁。`FullFrameInvalidation` 枚举区分 HardClear / SoftRepaint / None。

### Deferred Mermaid 与纯 Rust 渲染器

`ui.rs:2659` `with_deferred_mermaid_render_context()`：首帧渲染 placeholder，mermaid PNG 在后台线程生成完成后通过 `BusEvent::MermaidRenderCompleted` 触发重绘。

mermaid 渲染用 `jcode-tui-mermaid` crate（基于 [mermaid-rs-renderer](https://github.com/1jehuang/mermaid-rs-renderer)），纯 Rust 无浏览器/headless-chrome 依赖，`render_svg()` 直接生成 SVG→PNG，无需 node/mmdc——比浏览器方案快 1800x。

### Left-aligned vs Centered

默认 left-aligned（消息区占满左侧，widget 仅右侧 margin）。centered 模式 widget 分布两侧 margin。`Alt+C` 热键 / `/alignment` 命令 / config 切换。

### KV Cache 冷检测

`KvCacheState` 追踪 provider 端 prompt 前缀缓存状态。Anthropic Claude cache 5 分钟后冷却——UI 警告 cache went cold，通知 unexpected cache miss。这是 jcode "Misc" 中提到的细节优化。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 帧调度 | `redraw_schedule.rs:393` | 5s 深空闲→animation FPS，省 CPU |
| Stream Buffer 双令牌桶 | `stream_buffer.rs:257` | 防突发文字墙 + 跟赶积压 |
| Info Widget 负空间 | `find_all_empty_rects()` | 不抢响应区，HUD 感觉 |
| Synchronized Update | `BeginSynchronizedUpdate/End` | 原子应用 cell 变更，消闪烁 |
| Deferred Mermaid | `with_deferred_mermaid_render_context` | placeholder 先渲染，异步生成 |
| Widget 锚定 | `WidgetAnchor` transcript 行号 | widget 随文本滚动 |

---

## 模块间交互

TUI 作为 **server 客户端**运行。`AppRuntimeMode::RemoteClient`（`app.rs:43`）下 `run_remote()`（`run_shell.rs:766`）通过 `remote::connect_with_retry()` 连接 jcode server，接收 `ServerEvent` 流。`Bus`（全局事件总线）传递后台任务完成、mermaid 渲染完成等通知。`Provider` trait 提供 LLM 流式输出，`StreamEvent` 在 turn 处理中 match 分发。MCP manager、SkillRegistry、Tool Registry 通过 App 字段持有。

---

## 扩展方式

**新增 Info Widget**：(1) `WidgetKind` 枚举加变体（`info_widget.rs:71`）；(2) 实现 `priority()`/`preferred_side()`/`min_height()`（line 104-166）；(3) `all_by_priority()` 注册（line 169）；(4) 编写 render 函数（参照 `info_widget_tips.rs`）；(5) `InfoWidgetData` 和 dispatch 接入。

**修改布局策略**：调整 `info_widget_layout.rs` 的 `MIN_WIDGET_WIDTH`/`MAX_WIDGET_WIDTH`/`MAX_HIDDEN_FRAMES` 常量，或修改 `find_all_empty_rects()` 算法。切换 centered/left-aligned 在 `info_widget.rs:1305` 的 `centered: false`。

**调整流式渲染速率**：修改 `stream_buffer.rs:32-51` 的 `BASE_REVEAL_CPS`(180)/`REVEAL_BACKLOG_GAIN`(3.0)/`MAX_REVEAL_CPS`(960)。`MAX_REVEAL_CPS` 是墙钟硬上限，降低它让流式更平滑但积压更多。
