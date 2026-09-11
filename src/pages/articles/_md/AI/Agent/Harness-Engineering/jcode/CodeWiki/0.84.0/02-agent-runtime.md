---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Agent 运行时"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.84.0"]
tags: ["jcode", "Rust", "Agent Loop", "Turn", "Soft Interrupt", "KV Cache"]
description: "jcode Agent 运行时——turn 循环、provider 流式消费、soft interrupt 注入点、KV cache 追踪与 locked_tools 冻结、memory 非阻塞注入、有界重试恢复"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

Agent 运行时是 jcode 的核心循环——它驱动"provider 请求 → 流式响应 → 工具执行 → 中断检查"的 turn 循环，是编码 agent 区别于普通 LLM 客户端的本质所在。模块位于 `crates/jcode-app-core/src/agent/`（15 个文件 ~7800 行），入口 `agent.rs`，被 Server 的 `process_message_streaming_mpsc` task 持锁驱动。整个模块围绕一个第一设计约束展开：**provider prompt-cache 前缀的稳定性**——几乎所有字段和流程决策都能看到"别让 cacheable prefix 动"的动机。

---

## 模块架构

模块内有**两条并行的 turn 主循环**：`turn_loops.rs` 的 `run_turn()`（blocking 版，服务 headless/CLI，直接 `terminal_println!` 输出）与 `turn_streaming_mpsc.rs` 的 `run_turn_streaming_mpsc()`（服务端 per-client 事件流，经 mpsc 转发 `ServerEvent`）。两者逻辑高度镜像，recovery 逻辑抽到 `response_recovery.rs` 共享；代价是注入点等改动需双写。

子模块分工：`turn_execution.rs`（turn 入口 `run_once` / `run_once_streaming_mpsc`）→ `turn_loops.rs` / `turn_streaming_mpsc.rs`（循环主体）→ `prompting.rs`（system prompt split）→ `interrupts.rs`（软中断）→ `response_recovery.rs`（恢复路径）→ `compaction.rs`（压缩对接）→ `streaming.rs`（keepalive pong）→ `inline_tail.rs`（swarm worker 活动尾）→ `tools.rs`/`messages.rs`/`environment.rs`/`status.rs`（辅助）。

`Agent` struct（`agent.rs:181`）的字段分七组：执行核心（`provider: Arc<dyn Provider>`、`registry`、`session`、`skills`、`provider_session_id`）；工具策略（`allowed_tools`/`disabled_tools` + RAII 的 `_tool_policy_registration`、session 启动时快照的 `mcp_tools_mode`/`mcp_tools_token_threshold`、`locked_tools`、`mcp_late_register_resolved`）；中断注入（`std::sync::Mutex` 的 `soft_interrupt_queue`——**故意不用 async 锁**，让 server 在 agent 持写锁时也能入队、`background_tool_signal`、`graceful_shutdown`、`pending_alerts`、`current_turn_system_reminder`）；cache 观测（`cache_tracker`、`last_usage`、`agents_md_snapshot`——AGENTS.md 启动快照，工具改写不会中途变 cacheable prefix）；以及辅助组（swarm inline 的 `inline_tail`、`rewind_undo_snapshot`、`stdin_request_tx`、`concurrency_session`）。

---

## 调用链路

```
run_once_streaming_mpsc() [turn_execution.rs:48]
  ├─ take_alerts() 注入 swarm 通知
  ├─ 追加 user 消息 + session.save() + fire_turn_start_hook("chat")
  └─ run_turn_streaming_mpsc(event_tx) [turn_streaming_mpsc.rs:79]  loop:
       1. 循环头：graceful_shutdown 检查（issue #732）+ StreamingGuard + turn_cancel 注册
       2. repair_missing_tool_outputs()        修复悬空 tool_use
       3. tool_definitions() + build_system_prompt_split + provider.prewarm()
       4. messages_for_provider()               超限自动压缩（→ 重置 cache 基线）
       5. memory 非阻塞取用（take_pending_memory）
       6. record_client_cache_request()         memory 注入之前——它是 ephemeral 尾巴
       7. memory/batch nudge 追加为尾部 user 消息（保 cache prefix）
       8. provider.complete_split()  ←— tokio::select! 30s keepalive pong
       9. stream 消费：TextDelta/ToolUse*/TokenUsage → ServerEvent 转译回写
       10. assistant 消息持久化 + filter_truncated_tool_calls
       11. 无 tool_call → 三条 recovery 路径（见下）→ break
       12. 有 tool_call → registry.execute() 轮 → 循环尾注入点 D → 回到 1
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `run_turn_streaming_mpsc()` in `turn_streaming_mpsc.rs:79` | turn 主循环（流式版） | select! biased 保 keepalive 优先 |
| `run_turn()` in `turn_loops.rs:45` | turn 主循环（blocking 版） | `print_output=true` 直打 stdout |
| `prewarm_provider_idle()` in `turn_loops.rs:13` | 空闲会话预热线 | 刻意绕过 tool_definitions 的缓存锁（晚到 MCP 仍可变快照） |
| `repair_missing_tool_outputs()` in `agent.rs:851` | 补悬空 tool_result | inflight 引用计数防误补（重复 tool_use_id 会被 Anthropic 永久拒收） |
| `build_memory_prompt_nonblocking_shared()` in `prompting.rs:38` | memory 非阻塞取用 | 只在 fresh user turn 取——tool continuation 不重跑 embedding |
| `tool_definitions()` in `turn_execution.rs:404` | 工具定义（带锁） | `locked_tools` 冻结 + `mcp_late_register_resolved` 一次性 guard |
| `try_auto_compact_after_context_limit()` in `compaction.rs` | 上下文超限自救 | 重试上限 `MAX_CONTEXT_LIMIT_RETRIES = 5` |
| `maybe_continue_empty_post_tool_response()` in `response_recovery.rs` | 空响应重试 | `MAX_EMPTY_POST_TOOL_CONTINUATION_ATTEMPTS = 5` |

</details>

---

## 核心实现

### turn 循环与有界重试

退出判定（`tool_calls.is_empty()`）时按序尝试四条 recovery 路径，全部 `continue` 重进循环（前四条定义在 `response_recovery.rs`，被 blocking 与 mpsc 两条循环共享）：

- `maybe_reconsider_fable_guardrail`——Fable-5 安全护栏停止时注入 reconsideration。`FABLE_GUARDRAIL_RECONSIDERATION_PROMPTS` 是 `[&'static str; 3]`（`response_recovery.rs:134`）三条提示轮换；触发条件 `should_reconsider_fable_guardrail` 要求模型名含 "fable-5" 且 stop_reason 匹配 refusal/content_filter/safety/guardrail/policy_violation
- **`maybe_continue_empty_post_tool_response`**——上限 `MAX_EMPTY_POST_TOOL_CONTINUATION_ATTEMPTS = 5`（`turn_loops.rs:29` 注释记录了 why：曾有一次 43-turn 里单次空响应静默终结 20 小时 benchmark；计数器按 turn-loop 作用域，真完成的 agent 仍会正常退出）
- `maybe_continue_incomplete_response`——stop_reason 未完成 → 续写，上限 `MAX_INCOMPLETE_CONTINUATION_ATTEMPTS = 3`
- `maybe_continue_stranded_tool_use`——stop_reason="tool_use" 却没解析出任何工具调用时，注入 system-reminder 告知"什么都没执行"让模型重发工具调用（与 incomplete 共享 3 次上限）

错误即控制流，四组独立计数器防 provider 抖动终结长任务、又防无限循环。

### 文本包裹工具调用的恢复

模型偶尔把工具调用以纯文本吐出（如 `<function=...> to=functions.bash ...`）。mpsc 循环用 `WRAP_TOOL_MARKERS = ["to=functions.", "+#+#"]`（`turn_streaming_mpsc.rs:19`）扫描流式文本：`find_wrap_marker_incremental` 只扫新 append 的 delta + 一个 marker 长度的 overlap（避免 O(响应²) 全量重扫），命中后 `parse_text_wrapped_tool_call` 解析出 ToolCall，call_id 用 `fallback_text_call_<id>` 前缀生成，全局计数器 `RECOVERED_TEXT_WRAPPED_TOOL_CALLS`（`agent.rs`）记录恢复次数。

### soft interrupt 三段注入点

`queue_soft_interrupt`（`interrupts.rs:113`）随时可入队（std Mutex + Arc 句柄，server 不必持 agent 写锁）。实际发射点（`build_soft_interrupt_events` 的调用方）：

- **Point B**（`turn_streaming_mpsc.rs:1224`）——本轮无 tool call、turn 即将结束时。why 不在 tool_result 前注入：tool_use 后必须紧跟 tool_result，插 user 文本违反 API 约束
- **Point C**（`turn_streaming_mpsc.rs:1297`）——工具循环中紧急中止（仅 `tool_index > 0` 且 `has_urgent_interrupt()`）：为剩余工具补 "[Skipped: user interrupted]" error result 再注入，并追加 "[User interrupted: N remaining tool(s) skipped]" 文本；被跳过的工具数随 `ServerEvent::SoftInterruptInjected` 的 `tools_skipped` 字段上报（只填在第一个事件上）
- **Point D**（`turn_streaming_mpsc.rs:1265`、`1623`）——所有工具执行完、下一轮 API 请求前的非紧急安全点
- 协议文档里的 Point A 在 v0.84.0 代码中无发射点（保留作兼容标签）

### KV cache 追踪与 locked_tools 冻结

`cache_tracker`（`jcode-base/src/cache_tracker.rs`）是为**不上报 cache 命中指标的 provider**（Fireworks/OpenRouter）做的客户端 fallback——记录消息前缀链式 hash，下一轮前缀不匹配即 `CacheViolation`。哈希刻意用 `cache_relevant_message_hashes` 投影而非 raw Message hash——raw hash 含 timestamp、`tool_duration_ms` 等**不随请求发送的元数据**，会造成假误报。

`locked_tools` 解决 MCP 后到竞态（#206）：MCP server 后台连接，工具异步到达；若每 turn 取 registry 当前快照，工具列表中途变化会打掉 provider prompt cache。所以首个请求后锁死快照。死锁场景：首份快照缺 `mcp__*` 工具，而唯一解锁路径是模型调 `mcp` 管理工具——但它看不到。解法是 `mcp_late_register_resolved` **one-shot guard**：guard 未置位时每 turn 扫描 `registry_has_new_mcp_tools(locked)`，发现新 MCP 工具就解锁重建一次（**接受这一次刻意的 cache miss**），置位后永不再扫。

### memory 非阻塞注入：turn N 结果 turn N+1 可用

`build_memory_prompt_nonblocking_shared`（`prompting.rs:38`）的两段式：`ends_with_fresh_user_turn(&messages)` 为真才 `take_pending_memory(session_id)` 取上一轮算好的结果 + `update_context_sync_with_dir` 把当前 messages 经 `try_send` 投递给常驻 `MemoryAgent` actor——**发送即返回，不 await**。tool continuation 既不注入也不重跑检索（每个 continuation 都跑本地 embedding 是纯浪费）。注入形态是尾部 user 消息（保 cache prefix），默认不持久化，`record_memory_injection_in_session` 记审计。

### 工具执行与后台化

`registry.execute` 在流式版经 `tokio::spawn` 成 `tool_handle`，再 `tokio::select! { biased; tool_handle, bg_signal/shutdown }`——这是 Alt+B 后台化和 server reload 打断的结构基础。**Alt+B 移交**：`background_tool_signal` 触发后 `crate::background::global().adopt(&tc.name, &session_id, tool_handle)` 把工具 handle 过继给全局后台任务管理器，并写入提示模型用 `bg` 工具 `action: "wait"` 的 tool_result。**reload 打断**：bash 类工具给 750ms 宽限后 abort（`allow_reload_handoff` 仅 `tc.name == "bash"`）；`reload_interrupted_tool_result` 对 selfdev 和 wait 类工具（`bg` 的 wait、`swarm` 的 await_members/run_plan）按非错误处理——返回可续传的消息而不是 error result，让重载后能继续。工具结果经 `cap_tool_output_for_history` 截断后入历史——超 `MAX_TOOL_OUTPUT_CHARS_FOR_HISTORY = 512KB`（`tools.rs:5`）的输出截断并附说明：大输出会撑破远程协议消息大小限制、膨胀 session 历史文件、击穿 prompt cache。SDK 代执行的结果优先（`sdk_tool_results`），native 工具（`JCODE_NATIVE_TOOLS = ["selfdev", "communicate"]`）在 SDK 报错时回退本地。

### batch nudge：教模型用并行工具

`update_sequential_tool_rounds`（`turn_loops.rs:33`）统计**连续单工具轮次**——一轮只有一个工具调用且没用 batch 才 +1，否则清零。累计 ≥ `SEQUENTIAL_TOOL_ROUNDS_BEFORE_BATCH_NUDGE = 3` 置 `batch_nudge_pending`，下轮请求前注入 `BATCH_NUDGE` system-reminder："如果接下来的独立操作可以并发，改用 batch"——但保留顺序调用的场景提示（一个结果决定下一步时）。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 双循环对称 | `run_turn` / `run_turn_streaming_mpsc` | blocking 与流式场景分离，recovery 共享 |
| 错误即控制流 + 有界重试 | 三组独立计数器 | 防 provider 抖动终结长任务又防死循环 |
| std Mutex + Arc 句柄外露 | `soft_interrupt_queue` | server 不持 agent 写锁也能注入 |
| RAII guard | `StreamingGuard` / `_turn_cancel_guard` | panic 路径也正确清理 presence/注册 |
| 增量游标 | `tool_output_scan_index` | 修复扫描不全量重扫历史 |
| select! + biased + spawn | 工具执行 | 工具天然可后台化/可打断 |

---

## 模块间交互

向上被 Server 的 `process_message_streaming_mpsc` 驱动（`Arc<Mutex<Agent>>` 整 turn 持有 tokio Mutex——锁跨 await 点）；取消走锁外的 `SessionControlHandle`（`InterruptSignal` 注册在 `shutdown_signals` map）。向下依赖 `Provider`（`complete_split` 返回进程内 `EventStream`）、`Registry`（工具执行）、memory agent（PENDING_MEMORY 全局交接）。与 TUI 的通路是 `event_tx` mpsc → `ServerEvent` JSON。`CacheTracker`/compaction 在 jcode-base，跨 crate 但同进程。

---

## 扩展方式

**新增 turn 级注入**（请求前）：在两个循环的 memory 注入附近追加 ephemeral 消息；若改 system prompt 内容则进 `prompting.rs::build_system_prompt_split` 的 **dynamic_part**（进 static_part 会全量 cache miss）。**新增恢复路径**：放 `response_recovery.rs`，返回 `bool` 的 `maybe_continue_*` + 独立计数常量，两个循环的 no-tool-call 分支各接一行。**新增 turn 生命周期观测**：`fire_turn_start_hook` / `fire_turn_end_hook`（`turn_execution.rs:145`）已带 model/duration/last-text 字段。
