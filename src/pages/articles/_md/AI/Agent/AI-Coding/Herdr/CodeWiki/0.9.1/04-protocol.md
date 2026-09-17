---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "渲染协议"
date: "2026-09-17T10:49:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
contentType: "CodeWiki"
tags: ["herdr", "Rust", "二进制协议", "增量渲染"]
description: "herdr wire 协议：私有 bincode 通道与稳定 endpoint JSON 世代并存，surface delta 三级降级最小化跨进程帧流量。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/protocol/`（约 7,900 行）是 server 与 client 之间唯一的契约层。它同时回答两个正交的问题：**跨进程怎么传**（wire 编码）与**跨版本怎么活**（协议演进）。herdr 的答案是把两条线拆开：

- **私有二进制协议**（`wire.rs`，`PROTOCOL_VERSION = 22`）：同安装内的 CLI / direct-terminal / handoff 路径，bincode 编码、性能优先、版本不匹配直接拒绝（`check_client_version`）
- **稳定 endpoint 协议**（`endpoint.rs`，`ENDPOINT_PROTOCOL_GENERATION = 1`）：client-owned shell（SSH/Cloud 连接）的兼容契约，JSON、前向兼容——`AGENTS.md` 把 generation 1 称为 "compatibility floor"

帧格式是 `[u32LE 长度][bincode payload]`（`wire.rs` 的 `write_message`/`read_message`），上限 `MAX_FRAME_SIZE = 2MB`（图形 32MB），并强制"解码消费字节 == payload 长度"防止拼接错位。

## 模块架构

![protocol 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-04-protocol.svg)

左列是私有 wire 协议：`ClientMessage`（21 个 variant）与 `ServerMessage` 的 **variant 顺序冻结**——bincode 的 enum tag 是位置敏感的，插入中间 variant 会破坏旧 client，所以只能 append 到末尾，且有 SHA256 fixture 测试（`client_message_wire_tags_reflect_current_order`）守护。右列是 endpoint 协议：新能力一律走 `EndpointControl { kind, data }` 双字符串通道——kind 是命名消息（如 `endpoint.surface-delta.v1`），未识别的 kind 被旧 client 忽略，天然 append-only。底部三个编码能力（surface delta / surface reuse / render_ansi）就藏在 EndpointControl 里传输。

## 调用链路

**编码链（server 侧）**：

```
ratatui Buffer（server 虚拟渲染产出）
└─ FrameData::from_ratatui_buffer_with_hyperlinks() in wire.rs
   ├─ CellData { symbol, fg, bg, modifier, skip, hyperlink }   # OSC 8 存索引去重
   └─ 包成 PaneSurfaceFrame（surface_revision 单调递增）
      └─ ClientRenderState::prepare_pane_surface() in server/render_stream.rs:155
         ├─ 协商了 surface_delta → surface_delta::message(last, &mut msg)
         │    ├─ changed_rows()（surface_delta.rs:62）逐行扫 old_row[x] != new_row[x]
         │    ├─ 每行连续变化 cell 压成 CellSpan（行级 + 行内 run）
         │    └─ span 数达 MAX_SPANS=4096 或 delta ≥ 全帧大小 → 返回 None（放弃）
         ├─ 协商了 surface_reuse → surface_reuse::message(base_revision, surface)
         │    # cells 被 mem::take 走，JSON 只发元数据 + revision
         └─ 都不行 → 完整 ServerMessage::PaneSurface
            └─ commit_sent_frame() 把发送帧存为 last_surface 基线
```

**解码链（client 侧）**：`client/handshake.rs` 发 `EndpointClientHello`（声明 `surface_reuse: true, surface_delta: true` 与四个 codec）→ server 回 `EndpointServerWelcome::compatible` 广播能力 → `client/transport.rs` 读循环里每个 `read_message` 之后先过 `surface_reuse::Decoder::decode`：把 EndpointControl 包装的 delta 还原成 `ServerMessage::PaneSurface`（从 baseline cells 拷出再 `apply_rows` 打补丁），同时把 `PaneSurfacePatch` 应用进 baseline。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `write_message` / `read_message` in `wire.rs` | 长度前缀帧 | 解码消费字节必须等于 payload 长度 |
| `check_client_version()` in `wire.rs` | 版本门卫 | 私有协议不匹配直接拒绝 |
| `surface_delta::message()` | 行级 delta 编码 | delta 必须严格小于全帧才用（`surface_delta.rs:179`） |
| `surface_reuse::message()` | 零 cell 复用 | 只发 revision + 元数据 |
| `surface_reuse::decode_delta()` | client 侧还原 | 校验全部通过才推进 baseline |
| `BlitEncoder::encode()` in `render_ansi.rs:59` | cell → ANSI 差分 | 视觉等价比较，忽略 ratatui skip 标志 |
| `EndpointServerWelcome::compatible` in `endpoint.rs` | 能力广播 | 缺失能力只禁用对应动作，不拒连接 |

</details>

## 核心实现

### FrameData：ratatui Buffer 的 wire 投影

```rust
// src/protocol/wire.rs
pub struct FrameData {
    pub cells: Vec<CellData>, pub width: u16, pub height: u16,
    pub cursor: Option<CursorState>,
    pub hyperlinks: Vec<String>,   // OSC 8，cell 里存索引
    pub graphics: Vec<u8>,         // Kitty 图形字节
}
```

`hyperlinks` 去重索引是个典型优化：一个链接跨 40 个 cell 时 wire 上只出现一次字符串。`RenderEncoding::{SemanticFrame, TerminalAnsi}` 在 Welcome 里协商——direct attach 模式 server 直接把 FrameData 转成 ANSI 字节流发 `TerminalFrame`，client 原样写 stdout。

### render_ansi：一份 diff 逻辑两端复用

`render_ansi.rs` 的 `BlitEncoder` 把 cell 网格转回 ANSI 转义序列（CUP/SGR/DECSCUSR/OSC 8），核心是**视觉 diff**：`cells_visually_equal`（`render_ansi.rs:962`）只比较可见属性，处理宽字符/半角浊音假名的 `invalidated` 级联失效；同步输出模式用 CSI ?2026 包裹 + 先藏光标防中间态闪烁（`blit_frame_to_with_cursor_memory_and_clear_policy`）。它同时服务 server（TerminalAnsi 模式提前编码）和 client（SemanticFrame 模式本地 blit）——同一份逻辑两端复用，这是"渲染逻辑单源"的落点。

### baseline 的原子推进与防"搁浅"

`Decoder::decode_delta`（`surface_reuse.rs:219`）的注释值得引用："Validate the entire update before advancing"——校验完 hyperlink 索引、维度、popup 一致性后才同时更新 cells 与 revision。`surface_reuse.rs::message` 也注明：紧凑编码失败必须回退而非让更新"搁浅"（stranded）——错序/坏帧让 client 停在旧基线，而不是跳到无法续传的状态。解码失败直接断连接（transport 把错误转 `InvalidData`）。三重序号校验（`boot_id` / `projection_revision` / `surface_revision`，`saturating_add(1)`）防止把 patch 打到错误基线上。

### 手写 Decode 与内存放大防御

`surface_delta/decode.rs` 分阶段手写 bincode `Decode` impl：自定义 `DecodeContext` + 逐集合限额（`MAX_PANES=4096`、`MAX_HYPERLINKS=65536` 等），先读 count 校验再分配——防伪造 Vec 前缀的内存放大攻击。对一个接受跨版本连接的协议来说，这是必需的敌意输入假设。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 协商降级链 | `prepare_pane_surface()` in `server/render_stream.rs` | delta → reuse → 全帧，任一不划算即静默回退 |
| 有状态编解码器对 | `ClientRenderState` ↔ `surface_reuse::Decoder` | 两侧持镜像基线，靠三元组序号校验 |
| 双协议栈隔离 | `wire.rs` vs `endpoint.rs` | 性能契约与兼容契约各自演进 |
| 零拷贝借用编码 | `CellSpan<'a>` in `surface_delta.rs` | 只借用 `&[CellData]` 序列化，编完放回 |

## 模块间交互

`server/render_stream.rs::ClientRenderState` 是 server 侧唯一消费 delta/reuse 编码的状态机；`client/transport.rs` 在读循环内嵌 `Decoder`；`client/state.rs` 用 `BlitEncoder::encode_patch` 直接渲染 patch（绕过全帧 diff）。`render_ansi.rs` 另被 direct-attach 双端复用。`endpoint.rs` 的 JSON 类型全带 `#[serde(default)]` + `#[serde(other)] Unknown` 兜底——新字段可选、新枚举值可被旧 client 忽略。

## 扩展方式

- **新增 wire 消息**：只能 append 到 enum 末尾 + bump 冻结测试；跨版本兼容改走 `EndpointControl` 新 kind（如 `endpoint.xxx.v1`），旧 client 自动忽略
- **新增 delta 编码能力**：仿 `surface_delta.rs`——加 `CAPABILITY` 常量、`EndpointClientHello` 的 `#[serde(default)]` 开关、`compatible` 的 capabilities 列表、`Decoder::decode` 新 kind 分支；冻结测试需新 codec 命名而非改旧 digest
- **改 CellData 布局**：同步 `cells_visually_equal`（视觉等价决定 diff 输出量）、手写 Decode 的限额常量、`encoded_sha256` 冻结 fixture 三处

---

## 边缘机制速查

闭卷验证补充：

### wire 编码细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `LENGTH_PREFIX_BYTES / FramingError::Oversized` | `protocol/wire.rs` | 4 字节小端长度前缀 + bincode 载荷；超 MAX_FRAME_SIZE（2MB，图形 32MB 为 MAX_GRAPHICS_FRAME_SIZE）直接拒绝
| `color_to_u32 / u32_to_color` | `protocol/wire.rs` | 颜色打包用 0x00/0x01/0x02 三个高字节标签区分命名色/索引色/RGB；未知标签解码回退 Reset
| `UNDERLINE_STYLE_MASK / u16_to_modifier` | `protocol/wire.rs` | 下划线样式（curly 等）占 modifier 高 4 位（0xF000）；还原时 from_bits_truncate 剥离未知位
| `supports_required_codecs` | `protocol/endpoint.rs` | 要求 SNAPSHOT/SURFACE/INPUT/BLOB 四类 codec 列表各含 V1 才算握手成功；EndpointClientHello 的 surface_active serde 默认 true（default_true），surface_reuse/surface_delta 默认 false
| `Unknown 兜底` | `ClientShellCommandAction in protocol/wire.rs` | 未来命令 action 用 #[serde(other)] Unknown 兜底——旧 client 忽略新枚举值，generation-1 契约的 append-only 关键

### 解码防御与 blit 细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `MAX_GRID_DIMENSION / MAX_GRID_CELLS` | `surface_delta/decode.rs` | 网格维度上限 4096、总 cell 上限 1,000,000——分配有界解码
| `require_empty_sequence` | `surface_delta/decode.rs` | 主网格 metadata 的 cells 序列必须为空——cells 只允许出现在 span 里，防双份 cell 注入
| `decode_rows / checked_grid_size` | `surface_delta/decode.rs` | span 必须按序不重叠（previous_end 检查）且总量不超 cell 预算；非图形 delta 的 base64 data_len 再对照 MAX_FRAME_SIZE 二次限制
| `CellBaseline` | `surface_reuse.rs` | Decoder 单基线同时服务 reuse/delta/legacy patch 三种编码；patch 与基线失配时清空基线强制下帧全量
| `MESSAGE_KIND` | `surface_reuse.rs` | reuse 消息走 EndpointControl(kind=MESSAGE_KIND)；bincode 计得尺寸超 MAX_FRAME_SIZE 时丢弃消息回退全量
| `encode_inner 全量条件` | `render_ansi.rs` | repaint / 无前帧 / 尺寸变化三种；每帧 ?2026h 同步块 + ?25l 藏光标，帧首重置 OSC 8（防上一帧链接残留）；repeat_ime_anchor_after_sync 在非 Windows 重复 IME anchor
| `write_changed_cells / patch 校验` | `render_ansi.rs` | 光标在 patch 上以 REVERSED_MODIFIER XOR 绘制；encode_patch 对含 hyperlink 或越界（patch_row_fits）/重叠（patch_rows_overlap）行的补丁返回 None 回退全帧