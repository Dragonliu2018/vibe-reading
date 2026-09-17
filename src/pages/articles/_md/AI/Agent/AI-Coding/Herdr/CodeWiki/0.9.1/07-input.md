---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "输入解码"
date: "2026-09-17T10:52:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
contentType: "CodeWiki"
tags: ["herdr", "Rust", "kitty keyboard protocol", "输入处理"]
description: "herdr 输入解码：kitty keyboard protocol 三级解析瀑布、按 pane 协商重编码、lease 键归属记账。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/input/`（model、parse、encode、mouse、keybindings、lease、keybind_help，约 4,300 行）+ `src/raw_input.rs`（2,748 行）负责键鼠输入的**双向翻译**：client 侧把宿主终端的原始字节解码成语义 `TerminalKey`（degree 106 的 god node），server 侧再按 pane 协商的协议把语义键重编码回 VT 字节写给 PTY。两端共享同一套纯逻辑——这是"输入逻辑单源"设计，往返一致由 parse 测试模块同时调 `encode_terminal_key` 断言字节一致来守护。

为什么要实现 kitty keyboard protocol：legacy 编码无法区分 Shift+Enter、Ctrl+大写、release 事件——对 agent TUI（需要精确键位）和 copy mode（需要 release 语义）都是硬伤。但默认 flags 刻意排除 `REPORT_ALL_KEYS_AS_ESCAPE_CODES`：`ime_compatible_keyboard_enhancement_flags`（`input/model.rs`）只开 DISAMBIGUATE + EVENT_TYPES + ALTERNATE_KEYS 以兼容 IME；仅在 Prefix/Navigate 模式临时加开 report-all（`client/shell/input.rs:81` + `terminal_modes.rs:37`）。

## 模块架构

![input 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-07-input.svg)

解码是三级瀑布（`input/parse.rs:7` 的 `parse_terminal_key_sequence`）：kitty CSI-u → modify-other-keys → legacy，逐级 or_else。瀑布出口是 `TerminalKey`——携带语义（code/modifiers/kind）与出处（`KeySource::Synthesized | Vt{bytes} | WindowsConsole{record}`）双重信息。编码侧 `encode_terminal_key` 按 pane 独立协商的 `KeyboardProtocol`（Legacy / Kitty{flags}）选择输出形态——vim 开了 CSI-u 的 pane 收增强序列、普通 shell 收 legacy 字节，"按收件人能力说话"。`InputLeaseTable` 独立于这一切做键归属记账。

## 调用链路

**Unix 主链路**（按键从 stdin 到 PTY）：

```
stdin_reader_loop() in client/input.rs（独立线程）
└─ RawInputByteFramer::for_host_input() in raw_input.rs   # 切帧
   └─ ClientLoopEvent::StdinInput(data)
      └─ parse_raw_input_bytes_sync(data) in raw_input.rs:8
         └─ extract_one_event() in raw_input.rs:567
            ├─ bracketed paste / SGR 鼠标 / 焦点事件 / 宿主颜色回复
            └─ parse_terminal_key_sequence() in input/parse.rs:7   # 三级瀑布
               → RawInputEvent::Key(TerminalKey)
      └─ ClientShellState::handle_raw_events → handle_key() in client/shell/input.rs:302
         ├─ resolve_direct_binding / resolve_prefix_binding in input/keybindings.rs:74/81
         │    → KeybindAction（本地处理或转 API method）
         └─ 未消费且 Terminal 模式 → ClientInputTarget::Pane(id) → push_pane_key
            → ClientPaneInputEvent::from_terminal_key(key) in protocol/wire.rs:157
               → server: apply_client_pane_input_events() in server/pane_input.rs:203
                  → runtime.encode_terminal_key(key) in pane/terminal.rs:1979
                     ├─ Ghostty 内嵌 key encoder（优先）
                     └─ 回落 input::encode_terminal_key in input/encode.rs:24
                        → PTY 字节
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `parse_terminal_key_sequence()` in `input/parse.rs:7` | 三级解析瀑布 | kitty → momk → legacy or_else |
| `extract_one_event()` in `raw_input.rs:567` | 事件提取 | 粘贴/鼠标/焦点/回复逐个尝试 |
| `encode_terminal_key()` in `input/encode.rs:24` | 协商驱动编码 | 按 flags 选 CSI-u/文本/legacy |
| `resolve_direct_binding()` / `resolve_prefix_binding()` in `input/keybindings.rs` | 键位匹配 | Direct / Prefix 两种派发 |
| `InputLeaseTable::complete_press()` in `input/lease.rs` | 键归属记账 | Release 补发给同一 pane |
| `plan_repeat()` in `input/lease.rs` | Windows repeat 计划 | 防模式切换后重放过期动作 |
| `HostPixels::pane_position()` in `input/mouse.rs` | 像素→单元格换算 | 宿主→pane 坐标系 |

</details>

## 核心实现

### TerminalKey：语义与出身的双重携带

```rust
// src/input/model.rs
pub struct TerminalKey {
    pub code: KeyCode,                      // crossterm 语义键
    pub modifiers: KeyModifiers,
    pub kind: KeyEventKind,                 // Press/Repeat/Release
    pub repeat_count: u16,                  // Windows 原生按键分组
    pub shifted_codepoint: Option<u32>,     // kitty alternate key
    pub generated_text: Option<String>,     // 布局已提交文本
    physical_identity_hint: bool,
    windows_dead_key: bool,
    source: KeySource,                      // Synthesized | Vt{bytes} | WindowsConsole{record}
}
```

不可变 Builder 归一化链（`new().with_kind().with_repeat_count().with_generated_text()`）每个 setter 内嵌不变式修正（Release 清空 generated_text、repeat 归 1）。`KeyIdentity::Physical | Semantic` 区分 Windows scan-code 身份与 VT 语义身份——release/repeat 在无 kitty 协议的 Windows 上依然可追踪。

### raw_input.rs：歧义消解引擎

`raw_input.rs`（93KB）的本质是**歧义消解**：ESC 既可能是 Alt 前缀又是序列引导符，靠 10ms idle flush（`RAW_INPUT_IDLE_FLUSH_TIMEOUT_MS`）裁决——鼠标激活且悬着 lone ESC 时用更短超时；还要缝合跨读分包的 OSC 10/11 颜色回复、XTWINOPS 单元格尺寸回复、SGR 鼠标报告（150ms 窗口）；丢弃孤儿尾巴；追踪等待中的宿主回复计数（`flush_timeout`，`raw_input.rs:222` 起的大状态机）。

### lease：键归属记账

容易误解的点：lease **不是** prefix 等待态（那是 `ClientShellMode::Prefix`），而是**物理按键从 Press 到 Release 期间"谁拥有它"的记账**。`complete_press` 记录键被转发给哪个 pane（Release 时原样补发 release 给同一 pane）或被 UI 消费；`plan_repeat` 决定 Windows 分组 repeat 重放绑定还是抑制——并用 `ClientInputContext` 相等性检查防止 repeat 期间模式切换后重放过期动作（`lease.rs` 的 `reprocess_allowed`）。解决的是 report-all/release 语义下 UI 消费键与 pane 转发键的一致性。泛型 `InputLeaseTable<Source, Context, Target>` 不含任何 UI 语义，策略由消费侧注入。

### Windows 双通道输入

`client/input/windows_vti.rs`（3,899 行）：ConPTY VT 输入可用时走字节帧化（与 Unix 同路径）；不可用/不完整时读 `ReadConsoleInputW` 原生记录并解析 win32-input-mode CSI 序列（`parse_win32_input_mode_key_record`），用 scan code 构造 `PhysicalKeyId`，把 AltGr 归一化为纯文本修饰（`windows_key_modifiers`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 解析瀑布 + 对称编码 | `input/parse.rs:7` ↔ `input/encode.rs:24` | 往返一致性可测 |
| 不可变 Builder | `TerminalKey::new()...` in `model.rs` | setter 内嵌不变式 |
| 泛型策略状态机 | `InputLeaseTable` in `lease.rs` | 无 UI 语义，两端可测 |
| 协商驱动编码 | `KeyboardProtocol` per pane | vim 收 CSI-u、shell 收 legacy |
| 回退兜底 | `pane/terminal.rs::encode_terminal_key_once` | Ghostty encoder → 纯 Rust 编码器 |

## 模块间交互

`client/input.rs` 是平台 I/O 层（Unix 直读字节、Windows 走 windows_vti），`input/` 是纯逻辑层两端共享；shell 模式下客户端本地解析（keybinding 匹配 + 宿主回复消费都在 client 完成），attach 模式转发原始字节由 server `apply_terminal_attach_input` 处理。server 的 `app_keybindings`（`server/keybindings.rs`）维护 `LiveKeybindConfig` 并推给客户端——真正匹配在客户端 `route_key_press`，动作执行在 `record_binding`（多数转成 API 调用）。`keybind_help.rs` 从同一 `Keybinds` 配置渲染帮助 overlay。

## 扩展方式

- **新增 keybinding 动作**：`KeybindAction` 加变体 → config `Keybinds` 加字段 → `resolve_non_indexed_action` 表加行 → `record_binding` 加分支 → `keybind_help.rs` 加 entry
- **支持新的宿主回复序列**：`RawInputEvent` 加变体 → `extract_one_event` 加匹配 → `flush_timeout` 加跨读等待/丢弃分支
- **修正终端编码怪癖**：仿照 WezTerm control-associated-text 容忍（`parse.rs::matching_control_associated_text`）与 Ghostty extended-Enter 回退（`pane/terminal.rs:2019`）加窄条件

---

## 边缘机制速查

闭卷验证补充：

### 解析瀑布细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `parse_kitty_key_sequence` | `input/parse.rs` | shifted_codepoint 存在且 ≠ codepoint 且合法时强制 modifiers |= SHIFT——kitty alternate key 的修饰键规范化
| `parse_kitty_associated_text` | `input/parse.rs` | 按 ':' 分割 codepoint；is_control 字符导致整体 None；matching_control_associated_text 容忍 WezTerm report-all 模式附带的 Enter=13/Backspace=8/Tab=9/Esc=27 遗留控制码（associated_text 置 None 但事件保留）
| `parse_legacy_key_sequence` | `input/parse.rs` | '\\r'→Enter 而裸 LF 特意落空到控制字节解析（保留 Ctrl+J/Shift+Enter workaround）；ESC 后单字符递归解析再加 ALT；\\x1b[Z→BackTab+SHIFT、双 ESC 箭头→ALT
| `parse_legacy_ctrl_char` | `input/parse.rs` | 0→Ctrl+Space；1..=26→Ctrl+字母；27..=31→Ctrl+[\\]^_

### 编码细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `encode_terminal_key 决策流水线` | `input/encode.rs` | is_windows_dead_key 返回空 → Legacy+Super 先 try_encode_csi_u（防未修饰字符泄漏）→ generated_text 优先 → Release 且不 reports_event_types 返回空（防按键翻倍）→ kitty_first 决定 CSI-u 与文本先后
| `try_encode_csi_u 回落` | `input/encode.rs` | 无修饰无 event suffix 非 report-all、Enter/Tab/Backspace 无修饰、方向键/F 键无 suffix——都回落 legacy；kitty_modifier 在 xterm shift1/alt2/ctrl4 基础上加 super8/hyper16/meta32
| `encode_legacy_inner / encode_mouse_cb` | `input/encode.rs` | Ctrl+'/' 与 Ctrl+'_' 同为 31；Ctrl+非 ASCII 直接 UTF-8；ALT 字符键先 0x1b 前缀；鼠标 release 非 SGR 编码 cb 置 3（SGR 用 m 后缀）；坐标 +1 转 1-based；Default 编码再 +32 钳制 u8；滚轮按钮 64-67
| `HostGeometry::cell / HostPixels::pane_position` | `input/mouse.rs` | 宿主 1-based 像素→单元格两级映射：grid_extent 忽略尾余像素；grid_cell 用 ((pixel+1)*count-1)/extent；宿主单元格不在 pane Rect 返回 None；map_axis_within_cell 线性映射钳制在目标格内

### lease 与 keybinding 解析

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `InputLeaseKey` | `input/lease.rs` | (source, KeyIdentity) 组合键——物理与语义身份不会碰撞；normalize_press 把重复物理 Press 归一化为 Repeat（须有物理身份或无 generated_text）
| `complete_press / plan_repeat` | `input/lease.rs` | 转发键记 Forwarded 租约返回 Ignore；仅 initial_context == resulting_context 记 ReprocessRepeats（repetitions 为 repeat_count-1），否则 SuppressRepeats；plan_repeat 在上下文失配时降级 Suppress——防模式切换后重放过期动作
| `resolve_prefix_binding / resolve_indexed_action` | `input/keybindings.rs` | 前缀解析失败时用 generated_character_key 从 generated_text 取单字符构造空修饰键重试（IME 场景）；indexed 绑定按 [精确修饰, 忽略修饰] 两轮匹配（normalize_key_combo 归一化后比较）
| `resolve_exact_binding` | `input/keybindings.rs` | 三类匹配顺序：resolve_non_indexed_action → resolve_custom_command → resolve_indexed_action（switch_tab/switch_workspace/focus_agent 三组 indexed）
| `host_color_replies_awaited` | `raw_input.rs` | 宿主颜色查询后等待 258 条应答（HOST_COLOR_QUERY_REPLIES），期间孤立 ESC 扣住一个 flush 让跨读 OSC 10/11 应答可拼接；lone_escape_recently_flushed 让 '[<' 开头的孤立 SGR 尾巴可回收（前缀短于 32 字节即 MAX_ORPHANED_SGR_MOUSE_TAIL_BYTES 且 plausible）；bracketed paste 未终结时等待不丢弃；split_coalesced_escape 按平台拆双 ESC