---
source:
  type: "源码解读"
  project: "cc-switch"
  url: "https://github.com/farion1231/cc-switch"
title: "格式转换层"
date: "2026-09-23T22:00:00+08:00"
category: ["AI", Tools, CC-Switch, CodeWiki, "3.20.4"]
contentType: "CodeWiki"
tags: ["CC Switch", "Rust", "Anthropic API", "OpenAI Responses", "SSE", "格式转换", "供应商怪癖"]
description: "CC Switch API 格式转换层解读——四格式双向矩阵、reasoning_bridge 不透明信封、BufferedCitationTextState 引用缓冲、SSE 生命周期状态机、moonshot/xAI 怪癖补丁的单文件隔离策略全解"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/00-overview)

---

## 模块定位

`src-tauri/src/proxy/providers/`（~50k 行）。proxy 的"协议翻译核心"：客户端（Claude Code 说 Anthropic Messages、Codex 说 OpenAI Responses）进来，上游供应商可能是任意格式。god node 数据吻合——`anthropic_to_responses()` 76 度、`responses_request_to_anthropic()` 61 度、`chat_sse_to_response_value()` 44 度，**转换函数群是全库最高连接度的核心**。4 种格式 × 双向 × 流式/非流式 ≈ 12 条转换管线。

## 模块架构

**四种格式**：Anthropic Messages (A)、OpenAI Chat Completions (C)、OpenAI Responses (R)、Gemini `generateContent` (G)。已实现的方向矩阵：

| 客户端 | 上游 | 请求转换 | 流式响应 |
|---|---|---|---|
| A | A / C / R / G | 透传 / `anthropic_to_openai_with_reasoning_content` / `anthropic_to_responses` / `anthropic_to_gemini_with_shadow` | 透传 / `streaming.rs` / `streaming_responses.rs` / `streaming_gemini.rs` |
| R (Codex) | R / C / A | 透传（xAI 时 sanitize）/ `responses_to_chat_completions_with_reasoning` / `responses_request_to_anthropic` | 透传 / `streaming_codex_chat.rs` / `streaming_codex_anthropic.rs` |

**未实现**：R→G、C/G 互转——两类客户端各自只面向"母语 + Anthropic 中枢"设计。

**分发**：`claude.rs::get_claude_api_format()` 按 `meta.apiFormat > settings_config.api_format` 解析；**codex_oauth/xai_oauth 被强制返回 "openai_responses"**——注释明言这是 invariant 而非默认值（"可编辑的 metadata 绝不能把 Anthropic body 发给只懂 Responses 的上游"）。响应方向非流式用**结构判别**（`candidates` 是 Gemini、`output` 是 Responses、否则 Chat——两格式结构不相交，安全）。Codex 方向的 `wire_api` 显式声明转换——注释强调"不做 base_url 猜测，猜容易误伤"。

## 核心实现

### anthropic_to_responses()（transform_responses.rs:1775）

- **system → instructions**：先 `strip_leading_anthropic_billing_header`——Claude Code 会在 system 开头塞动态 billing header（轮换的 `cch=` 值），透传会**破坏上游 prompt cache 前缀复用**（#2350），只剥开头那行
- **messages → input**：把 Anthropic"单条消息内嵌 blocks"拆成 Responses"扁平 item 流"——`tool_use` 提升为 `{type:"function_call", call_id, arguments: canonical_json_string}`；`tool_result` 提升为 `function_call_output`
- **reasoning 孤儿清理**：被回放的 reasoning item 必须紧跟同代消息，否则上游报错毁掉下一轮——转换器倒序扫描删除无跟随者
- **Codex OAuth 契约**：以 OpenAI 官方 codex-rs 的 `ResponsesApiRequest` 为协议契约——`store:false` 必填、`include` 必须含 `reasoning.encrypted_content`、**删除** codex-rs 没有的字段、强制 `stream:true`、FAST mode 时 `service_tier:"priority"`

### reasoning_bridge：不透明信封做无损有状态语义

模块注释直击要害："Anthropic Messages 协议没有承载 OpenAI reasoning item 的字段。为让无状态工具循环无损，把完整 item 塞进带版本的 thinking signature payload"。**版本化前缀信封**：`encode_openai_reasoning_item` 把整个 reasoning item JSON base64url 加前缀 `ccswitch-openai-reasoning-v1:`；回放方向按字段位置反解。镜像方向 `encode_anthropic_thinking_block`（`ccswitch-anthropic-thinking-v1:`）把 Anthropic 签名 thinking 装进 Responses `reasoning.encrypted_content`。**前缀还起到隔离作用**（"unrelated providers' ciphertext isolated"）。effort ↔ budget 双向标定（R→A：medium→8192、high→16384；budget 钳到 max_tokens/2 且低于 1024 地板则关 thinking）。

### 流式响应：生命周期模型差异 + 主状态机

`streaming_responses.rs` 头部点明核心难点：Responses 是**命名事件生命周期模型**（`response.created → output_item.added → output_text.delta → response.completed`），与 Chat 的 delta chunk 完全不同，需独立状态机。主函数 `create_anthropic_sse_stream_from_responses_raw`（:2359）在 `async_stream::stream!` 内约 30 个状态变量。健壮性三件套：**UTF-8 安全缓冲**、**EOF 哨兵**（缺尾空行的最后块也能解析）、**JSON 兜底**（网关忽略 stream:true 返回单 JSON 时整体持有到 EOF 合成完整 Anthropic 生命周期）。

### BufferedCitationTextState：引用缓冲（47 度 god node）

**为什么**：OpenAI web search 引用以 `url_citation` annotation 随文本下发（带 start/end_index），而 Anthropic 协议**没有独立 annotation 通道**——引用必须渲染进文本正文。问题：annotation 可能晚于文本 delta 到达，即到即发就无处安放——所以对"可能有引用的 part"必须**先扣住文本，等 part 终结、annotation 齐了再渲染**（:646，600 行结构体的复杂度主要来自网关兼容：双键归属文本、emitted_bytes 已发前缀追踪、`merge_part_indices` 区分累加型 delta 与快照型 done 事件、无键与 keyed 事件合并对账）。

### 供应商怪癖补丁：单文件隔离策略

| 补丁 | 修什么 |
|---|---|
| `transform_codex_chat_moonshot_schema.rs` | Moonshot 按 2019-09 前的 JSON Schema 读法拒绝 `$ref` 带兄弟关键字——改写成 draft-07 惯用法（2020-12 下语义严格等价）；**范围刻意收窄**——其它供应商保持字节级 schema 不动以保 prompt cache |
| `transform_codex_responses_xai_sanitize.rs`（1804 行） | xAI 严格 serde 拒绝 Codex 私有字段——sub2api `patchGrokResponsesBody` 的忠实移植 + 递归删字段 + tool type 白名单（以 xAI 自己的 serde 错误枚举为准） |
| `transform_codex_responses_namespace.rs` | Codex 私有 `{"type":"namespace"}` 工具形状——请求侧提升为顶层扁平名（超 64 字符 sha256 截断），响应侧还原；正反向从同一请求体派生映射 |
| `gemini_schema.rs` | Gemini 两条 schema 通道探测切换（受限 `parameters` vs 全功能 `parametersJsonSchema`）+ `ensure_object_schema` 满足 Vertex 硬校验 |

**头注释都是设计宣言**：写明来源 issue、探针日期、上游对齐对象，声明"上游修了就删这层而非双轨"——对抗 upstream rebase 的明确策略。挂载集中在 `forwarder.rs:1636-1680` 单一调用点。

### 其他流式要点

`streaming.rs`（Chat→A）：去重多个 finish_reason chunk（OpenRouter kimi 在 tool_use 后发多个会让 Claude Code 断连）；`pending_message_delta` 缓到 `[DONE]` 再发保 usage 完整。`streaming_gemini.rs`：Gemini 并行 functionCall 常无 `id` → 合成 `gemini_synth_` 前缀 ID（回传前剥除）；thought signature 存 `GeminiShadowStore`。**Web search 事件重排**（:2284）：强制 `server_tool_use` 与配对 `web_search_tool_result` 相邻——等待期间发 ping 保活，EOF 未配对则发 stream_truncated 错误。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 单一职责 | 转换层不做模型映射（model_mapper 在 proxy 层） | 避免两处各改一半 |
| 不透明信封 | reasoning_bridge 版本化前缀 | 无服务端状态的多轮 reasoning 不丢 |
| 结构判别 | transform_response 三分 | 不依赖可能配错的配置 |
| 补丁隔离 | 怪癖单文件 + 单一挂载点 | upstream 修复后可整体删除 |
| 双键对账 | BufferedCitationTextState | 网关 annotation 时序不定的兼容 |

## 模块间交互

- **上游**：由[本地代理引擎](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/04-proxy-engine)的 `forward()` 在 `needs_transform()` 时调用；`CodexChatHistoryStore`（LRU 512）支撑 `previous_response_id` 的无状态 Chat 上游回放
- **`codex_chat_history.rs`**：还原 DeepSeek 要求的"tool result 前必须紧跟带 reasoning_content 的 assistant function call"
- **`tool_media.rs`**：Chat 协议 tool 消息不能带图片——把 tool_result 媒体抽出来在下一 user 轮前集中呈现

## 扩展方式

**新增一个已有格式的供应商**（最常见）：通常零改动，或只加一个 host 门控的怪癖补丁文件。

**新增一种上游格式 `foo_native`**：① `claude.rs` 的 `get_claude_api_format` + `transform_claude_request_for_api_format` 加分支；② 新建 `transform_foo.rs`（参照 transform_gemini.rs 结构）+ 响应判别特征；③ 新建 `streaming_foo.rs`（参照 streaming_gemini.rs，四个流式文件里最小的模板，1054 行）；④ `handlers.rs` 流式分发加分支；⑤ 有怪癖则独立补丁 + forwarder 单一挂载。

**新增客户端协议**则重得多：ProviderType/adapter/handlers 端点路由/反向 streaming 族/跨请求存储。
