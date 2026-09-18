---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "agent-core 与 pi-mono"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "pi-mono", "Agent Loop", "防腐层", "EventBridge"]
description: "agent-core + third_party/pi-mono 解读——vendored earendil-works/pi v0.79.1（MINIMAX_CHANGES.md 补丁台账）、零 IO 防腐层经 PiTurnRunner 8 步组装、EventBridge（AgentEvent→RuntimeEvent + message_id 契约 + 延迟发射 completed）、ai 包 9 种 provider registry"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

这一层是 mcode 的 **agent 执行内核**：vendored 的 `third_party/pi-mono`（Mario Zechner 的 [pi](https://github.com/earendil-works/pi-mono) coding agent 基础设施）提供 agent loop 与模型协议，`packages/agent-core/`（~1.2 万行）是包在它外面的防腐层。为什么 vendored 而非 npm 依赖——`MINIMAX_CHANGES.md`（41.3KB 补丁台账）开篇明言："vendors pi-mono as source so MiniMax can patch, validate, and ship agent-loop fixes without waiting on upstream release cadence"。台账里记录的实际改动包括：Windows PowerShell ConstrainedLanguage 兼容（2026-08-31）、Claude 默认 thinking 模型省略显式 thinking 字段（2026-08-27）、Codex SSE 响应头超时 10s→30s（2026-08-26）——都是等不起上游的运行时缺陷修复。`agent-core/src/index.ts` 自述 "Pure TypeScript core … **Zero IO**"，pi 类型与 mcode 类型完全隔离。

## 模块架构

![PiTurnRunner 与事件桥](/vibe-reading/images/articles/minimax-code/pi-turn-runner.svg)

pi-mono 四包分工：`agent`（Agent 类 + agent-loop，外层 follow-up 循环 + 内层 tool-call 循环）、`ai`（api-registry + providers + stream，9 种 API 格式）、`coding-agent`（本地工具、会话、CLI——mcode 的本地工具即包装它的 createReadTool 等）、`tui`（终端组件库——**mcode 侧无引用**，自研 TUI 不用它）。`agent-core` 三块：`pi-turn-runner/`（组装与执行）、`event-bridge/`（事件翻译）、`protocol/`（mavis 自有规范层：agent-event.ts/agent-message.ts/runtime-event.ts）。隔离纪律：pi 的类型只出现在 `pi-turn-runner/` 与 `event-bridge/` 两个 subpath 内——这就是 subpath exports 的意义，只消费协议的包不必加载 `@earendil-works/*`。

## 调用链路

一个 turn 的完整链：

```
turn-system executor.ts:319 runtime.runTurn({...})
→ LocalAgentTurnRunner.run (agent-host/runner/local-agent-turn-runner.ts:86,91)
→ PiTurnRunner.runTurn (pi-turn-runner.ts:114) 八步：
   1 newTurn(:139)      组装工具表/streamFn/EventBridge（每 turn 重建）
   2 emitRunning(:149)  首帧 session.status
   3 newAgent(:154)     构造 pi Agent（注入 convertToLlm = projectAgentMessagesForModel）
   4 setToolHooks(:179) before/afterToolCall 串接（tools.ts）
   5 setLLMHook(:180)   LLM 调用钩（llm.ts，吞 compaction 与消息改写）
   6 subscribeEvents(:188) 单一串行队列（events.ts:78）
   7 runAgent(:217)     agent.prompt() / continue() + waitForIdle
   8 drain + flushTail + emitTerminal(:228-231)
→ pi Agent.prompt → runAgentLoop(agent-loop.ts:95)
   → streamAssistantResponse → streamFn（默认 streamSimple）
   → getApiProvider(model.api) 命中 registry → 具体 provider 打 HTTP 流式请求
→ AgentEvent 逐个 emit → Agent.processEvents(agent.ts:531) 按订阅顺序 await listener
→ EventBridge.processEvent → RuntimeEvent[] → host writer → AgentEventDelivery
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `runTurn()` in pi-turn-runner.ts:114 | turn 编排 | 每次重建 Agent/Bridge/队列，per-turn 状态隔离 |
| `newAgent()` in pi-turn-runner/agent.ts:33 | Agent 构造 | 注入 convertToLlm/streamFn/getApiKey 全策略 |
| `newTool()` in pi-turn-runner/tools.ts:127 | 工具包装 | `b.impl.execute(callCtx,...)` → pi AgentToolResult |
| `setToolHooks()` in tools.ts:71 | hook 串接 | beforeTool 任一返回 block 即短路 |
| `processEvent()` in event-bridge/bridge.ts:282 | 事件翻译 | 见下文 message_id 契约 |
| `registerApiProvider()` in ai/src/api-registry.ts:66 | provider 注册 | sourceId 生命周期，支持插件式卸载 |
| `runLoop()` in agent-loop.ts:155 | 循环本体 | steering 注入 → stream → executeToolCalls |

</details>

## 核心实现

### EventBridge：翻译与两个关键机制

`EventBridge`（bridge.ts:151）把 pi `AgentEvent`（message_*/toolcall_*/tool_execution_*/turn_*/agent_*）翻译为 mavis `RuntimeEvent`，刻意只发 canonical 流（stream.resp chunk + 完成消息 + 终端状态 + debug.trace）。两个补丁级机制值得细读：

- **message_id 契约**（bridge.ts:15-24）：pi 不给 assistant 消息分配 id——首个 `message_start` 时 bridge 返回 `requestAssistantMessageId=true`，host 分配后回注，后续 delta 挂起等 id 就绪。
- **延迟发射 completed**（bridge.ts:174-209 注释）：有 tool call 的 assistant 消息，其 completed `agent_message` 延迟到该消息所有 `tool_execution_end` 到齐才发射——否则持久化的 RespData 里 tool_call 永远停在 "started" 状态。`message.persisted` 侧信道明确排除在 bridge 之外，由 SessionController 在 MessageStore.append 后发。

### 串行事件队列：并发工具的保序

pi 的 Agent 可能从并行 tool 分支并发 emit 事件。`subscribeEvents`（events.ts:78）用 Promise 链 `queue.then(() => onAgentEvent(event))` 把所有 AgentEvent **串行化**成单一队列（events.ts:356-363）——保证 RuntimeEvent 顺序与持久化一致。这是把"执行并行"与"观测串行"解耦的关键一环。

### ai 包：registry 与 9 种 API 格式

`registerApiProvider(provider, sourceId)` 以 `Api` 字符串为 key 的全局 Map 注册 `stream`/`streamSimple` 双函数；`unregisterApiProviders(sourceId)` 支持插件式动态注册/卸载。内置 9 种（register-builtins.ts:348-397）：anthropic-messages、openai-completions、mistral-conversations、openai-responses、azure-openai-responses、openai-codex-responses、google-generative-ai、google-vertex、bedrock-converse-stream。mcode 的 BYOK 格式白名单（三种）是这个面的子集（见[模型服务](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/05-model-agent)）。

### 版本注记与 TUI 关系

vendored 版本 **v0.79.1**（commit `28df940`，2026-06-16 导入，`.minimax-vendor.json` `"strategy": "source-vendor"`）——注意 tui engine 是独立 vendored 的 pi-tui 0.84.2（见 [TUI 文档](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/01-tui)），两处版本不同步。mcode 的终端 UI 自研于 fork 之上，不依赖 `@earendil-works/pi-tui`；pi-mono 的 coding-agent 包则被复用（本地工具 + AuthStorage 被 CodexOAuthManager 复用）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Anti-corruption / Adapter | agent-core 整体；`newAgent()` 双向翻译 | 上游 API 变化不扩散 |
| Registry + sourceId 生命周期 | ai/src/api-registry.ts:66 | 插件式 provider 动态注册 |
| Observer（await 链） | `Agent.subscribe`（agent.ts:531-577） | listener 纳入 run 的 settlement |
| Strategy 全注入 | `streamFn`/`convertToLlm`/`getApiKey`（agent.ts:180-183） | 执行内核零硬编码 |
| 串行事件队列 | events.ts:356-363 | 并行执行、串行观测 |

## 模块间交互

`createLocalAgentHost`（turn-system/production-composition.ts:338）是组合根，注入 product ports（toolCatalog/permission/runner/executor/sessions 等——degree 31 扇出来源）。消费链：turn-system agent-host → `LocalAgentTurnRunner` → `PiTurnRunner`；事件反向经 `AgentEventDelivery` → 队列/持久化/SSE。改动 pi-mono 源码时必须在 `MINIMAX_CHANGES.md` 补 ledger 条目。

## 扩展方式

- **新增 provider API 格式**：`ai/src/providers/` 新建实现 stream/streamSimple → `register-builtins.ts` 注册；动态（插件）注册带 sourceId 并在卸载时 `unregisterApiProviders`。
- **agent loop 层加 hook**：首选 agent-core 注入点——`pi-turn-runner/llm.ts` 的 `setLLMHook`（包住每次模型调用）或 `tools.ts` 的 `setToolHooks`；hook 属 pi 语义则改 `newAgent()` 的 `onPayload`/`onResponse` 或上游 `AgentOptions.afterToolCall`（改源码须记台账）。
- **host 层产品扩展**：`agent-runtime/src/factories.ts` 的 `createHookExtension`/`createReminderExtension` 等工厂 → `Registry.assembleTurn`（registry.ts:345）自动进入每次 turn 组装。
