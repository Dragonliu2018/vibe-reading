---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Agent 运行时"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "Agent Loop", "Turn", "流式", "Soft Interrupt"]
description: "jcode Agent 运行时——turn 循环、provider 流式消费、tool 执行、soft interrupt 队列、KV cache 追踪、上下文压缩"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)

---

## 模块定位

Agent 运行时是 jcode 的核心循环——它驱动"provider 请求 → 流式响应 → 工具执行 → 中断检查"的 turn 循环，是编码 agent 区别于普通 LLM 客户端的本质所在。模块位于 `crates/jcode-app-core/src/agent/`，入口 `agent.rs`，向下依赖 Provider/Tool/Memory/Session，被 Server 的 `handle_client` 驱动。

---

## 模块架构

agent 模块内部按职责拆分为 14 个子模块：

- **turn_execution.rs** — turn 入口（`run_once` / `run_once_streaming_mpsc`）
- **turn_loops.rs / turn_streaming_mpsc.rs** — turn 循环主体（`run_turn`）
- **streaming.rs** — 流式 keepalive pong
- **prompting.rs** — system prompt 构建（static/dynamic split）
- **tools.rs** — 工具输出裁剪与 content blocks 转换
- **interrupts.rs** — soft interrupt 队列、graceful shutdown
- **compaction.rs** — 上下文压缩
- **response_recovery.rs** — 文本包裹 tool call 恢复
- **messages.rs / environment.rs / status.rs / utils.rs** — 辅助

`Agent` struct（`agent.rs:181`）持有 `provider`、`registry`、`session`、`soft_interrupt_queue`、`cache_tracker`、`locked_tools` 等状态。

---

## 调用链路

```
run_once_streaming_mpsc(user_message)          turn_execution.rs:48
  ├─ take_alerts() → 注入 pending 通知
  ├─ append_user_context_message() → 持久化用户消息
  ├─ fire_turn_start_hook()
  └─ run_turn_streaming_mpsc(event_tx)         turn_streaming_mpsc.rs:79
       ┌── loop { (turn 循环) ─────────────────────────┐
       │ 1. is_graceful_shutdown()? → break           │
       │ 2. repair_missing_tool_outputs()   agent.rs:796│
       │ 3. messages_for_provider()         agent.rs:674│
       │ 4. build_memory_prompt_nonblocking_shared()   │
       │ 5. build_system_prompt_split()  prompting.rs:77│
       │ 6. record_client_cache_request()              │
       │ 7. provider.complete_split(messages, tools,   │
       │       static, dynamic, session_id) → stream   │
       │ 8. while stream.next():  ← 流式事件循环        │
       │     ├─ TextDelta → 累积 text                  │
       │     ├─ ToolUseStart/InputDelta/End → 累积 tool│
       │     ├─ ToolResult → sdk_tool_results          │
       │     ├─ RetryRollback → 清空 partial output    │
       │     ├─ StreamError → try_auto_compact         │
       │     └─ MessageEnd + SessionId → break         │
       │ 9. recover_text_wrapped_tool_call()           │
       │10. 持久化 assistant message                   │
       │11. tool_calls.is_empty()?                     │
       │     ├─ yes → break (turn 完成)                │
       │     └─ no  → registry.execute() → 下轮        │
       │12. inject_soft_interrupts()   interrupts.rs:330│
       └────────────────────────────────────────────────┘
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `run_once_streaming_mpsc()` | turn 入口，追加用户消息后启动循环 | mpsc 回写 ServerEvent |
| `run_turn_streaming_mpsc()` | turn 循环主体 | 无 tool call 时 break |
| `messages_for_provider()` | 准备发往 provider 的消息 | 只 hash cache-relevant 投影 |
| `inject_soft_interrupts()` | turn 结尾排空中断队列 | std::sync::Mutex 不阻塞 async |
| `recover_text_wrapped_tool_call()` | 从纯文本解析 tool call | 兼容 OpenRouter/Kimi |

---

## 核心实现

### Turn 循环与流式消费

`run_turn_streaming_mpsc`（`turn_streaming_mpsc.rs:79`）是一个 `loop{}`，每轮包含「provider 请求 → 流式消费 → 工具执行 → 中断检查」四阶段。provider 返回 `EventStream`（`Pin<Box<dyn Stream<Item = Result<StreamEvent>>>`），agent 逐事件 match——`TextDelta` 累积文本、`ToolUseStart/InputDelta/End` 累积 tool call、`MessageEnd` 结束当前流。无 tool call 时 `break` 退出（turn 完成）；有 tool call 则逐个执行后 `continue` 回到循环顶部。

### KV Cache 追踪与 cache_relevant_message_hashes

`cache_relevant_message_hashes`（`agent.rs:89`）不 hash 原始 `Message`——原始 Message 含 `timestamp`、`tool_duration_ms`、`ReasoningTrace` blocks、`cache_control` markers 等非传输元数据。同一消息在下一轮重新序列化时这些字段被回填，导致 hash 变化，触发虚假的 `harness:_prefix_changed` KV-cache miss 报告。改用只 hash 实际发送给 provider 的投影：

```rust title="crates/jcode-app-core/src/agent.rs"
fn message_hashes(messages: &[Message]) -> Vec<u64> {
    // Hash the cache-relevant projection, not the raw Message. Raw hashing
    // keys off non-transmitted metadata (timestamp, tool_duration_ms,
    // ReasoningTrace blocks, cache_control markers), which triggers spurious
    // harness:_prefix_changed KV-cache miss reports.
    crate::message::cache_relevant_message_hashes(messages)
}
```

### Soft Interrupt 队列

soft interrupt 队列用 `std::sync::Mutex` 而非 `tokio::sync::Mutex`——agent 运行时持有 async 锁（`&mut self`），如果中断队列也用 async mutex，外部线程（如 Telegram 消息到达）将无法入队直到 turn 结束。用 `std::sync::Mutex` + 短临界区使 `queue_soft_interrupt()` 可在 agent 处理中无阻塞调用。中断在 turn 结尾的 `inject_soft_interrupts()`（`interrupts.rs:330`）安全注入。

### Stream Keepalive Pong

provider 流式响应可能持续数分钟（长 thinking + 多 tool call），客户端 WebSocket/HTTP 可能超时。每 30 秒发 `ServerEvent::Pong{id:0}`（`streaming.rs:22`）让客户端知道连接活跃。`MissedTickBehavior::Skip` 避免积压补偿 tick。

### 工具输出裁剪与 Response Recovery

`cap_tool_output_for_history`（`tools.rs:7`）将超过 512KB 的输出截断并附说明——大输出会撑破远程协议消息大小限制、膨胀 session 历史文件、击穿 prompt cache。

`recover_text_wrapped_tool_call`（`response_recovery.rs:56`）处理部分 provider（如 OpenRouter 上的 Kimi）将 tool call 以纯文本 `to=functions.xxx{...}` 形式输出而非结构化 `StreamEvent::ToolUseStart` 的情况——从文本解析出 tool name + JSON arguments，转为正式 ToolCall 执行，避免 turn 静默结束。

### Locked Tools 与 MCP Late Register

首次 API 请求后冻结工具列表（`agent.rs:219`），避免 MCP 异步注册工具导致 prompt cache invalidation。MCP server 后台连接，首次 turn 不阻塞等待。允许恰好一次 rebuild 拾取 MCP 工具（一次性 cache miss），之后 `mcp_late_register_resolved=true` 停止扫描。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Loop/Turn 抽象 | `run_turn()` `loop{}` | 四阶段循环，无 tool call 时 break |
| 流式 keepalive | `streaming.rs:7` | 防 client 超时断连 |
| Soft interrupt 队列 | `interrupts.rs:122` `std::sync::Mutex` | 外部线程无阻塞入队 |
| 工具输出裁剪 | `tools.rs:7` 512KB 上限 | 防撑破协议/历史/cache |
| Locked tools | `agent.rs:219` | 防 MCP late register 击穿 cache |
| Response recovery | `response_recovery.rs:56` | 兼容文本包裹 tool call 的 provider |

---

## 模块间交互

**依赖**：`provider`（`Provider` trait, `complete_split()`）、`message`（`Message`/`StreamEvent`/`ToolCall`）、`tool`（`Registry`/`ToolContext`）、`session`（`Session`/`SessionStatus`）、`bus`（`BusEvent::ToolUpdated`）、`protocol`（`ServerEvent`）、`cache_tracker`（KV-cache 追踪）、`compaction`（`try_auto_compact`）、`memory`/`memory_agent`（非阻塞记忆注入）、`skill`（`SkillRegistry`）、`hooks`（turn_start/turn_end observer）。

**被调用方**：`server.rs` 通过 `soft_interrupt_queue()` 获取队列句柄入队中断，通过 `request_graceful_shutdown()` 停止 agent；`jcode-tui` 通过 `run_turn_interactive()` 驱动交互式 turn。

---

## 扩展方式

**新增 tool call 处理逻辑**：在 `turn_loops.rs` 的 stream 事件 match 分支新增 `StreamEvent::Xxx` 处理，然后在工具执行段添加该工具的特殊路径。若工具需 provider 侧执行，处理 `StreamEvent::NativeToolCall`。

**修改中断行为**：在 `interrupts.rs` 修改 `inject_soft_interrupts()` 的注入逻辑，或修改 `NoToolCallOutcome`/`PostToolInterruptOutcome` 的消费。`turn_streaming_mpsc.rs` 的 streaming 变体有独立中断检查路径，需同步修改。

**修改上下文压缩策略**：在 `compaction.rs:110` 的 `try_auto_compact_after_context_limit()` 修改触发条件，`MAX_CONTEXT_LIMIT_RETRIES` 控制重试上限。
