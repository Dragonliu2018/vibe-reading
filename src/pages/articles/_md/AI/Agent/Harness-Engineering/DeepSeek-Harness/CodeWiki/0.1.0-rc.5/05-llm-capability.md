---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "LLM 能力层"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "LLM", "Streaming", "Adapter", "Cordis"]
description: "dsh 的 LLM seam——provider-neutral 的 Message/StreamChunk 词汇、llm/stream waterfall、pi-ai 与 DeepSeek adapter 如何让一次 swap 切换模型。"
readingTime: "14 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

`packages/llm` 是 LLM 能力的 capability seam 实现。`llm`（`ctx.llm`）是 Service Definition + Consumer 的 seam——定义 provider-neutral 的 `Message`/`StreamChunk` 词汇与 `llm/stream` waterfall；`llm-pi-ai` 通过 `@earendil-works/pi-ai` 适配多家 provider；`llm-deepseek` 直连 DeepSeek API。这层独立是因为它把"模型是谁"从 agent loop 抽离——换 provider = 改一个 settings profile + 重 register，不动 agent-loop / session log / UI。provider-neutral 的 `Message`/`StreamChunk` 词汇让历史可跨 provider 重放。

## 模块架构

```
LlmRuntime extends Service (ctx.llm)  ──registerAdapter──▶  LlmAdapter 实例
   ├─ registerAdapter(providers, adapter)  # all-or-nothing + replace() 原子换 route
   ├─ prepareCall(LlmCallConfig, signal) → PreparedLlmCall  # 绑定 registration + retry policy
   ├─ stream(GenerateOptions) → AsyncIterable<StreamChunk>  # 经 llm/stream waterfall
   └─ listProviders() / registerConfigurableProviders() / registerModelDiscovery()
              │ llm/stream  [waterfall]
              ▼
        adapterStream() → adapter.stream(resolvedOptions) → AsyncGenerator<StreamChunk>
              │
              ▼
        BlockAssembler.push(chunk) → blocks()/message() → createAssistantMessage → session log
```

`LlmRuntime`（`packages/llm/llm/src/index.ts:284`）核心方法 `registerAdapter(providers, adapter)`、`listProviders()`、`prepareCall()`、`stream(options): AsyncIterable<StreamChunk>`（`index.ts:913`）。抽象基类 `LlmAdapter`（`index.ts:180`）唯一必需方法 `abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>`（`index.ts:232`）。事件声明：`llm/stream` waterfall（`index.ts:64`）、`llm/adapters-updated` emit（`types.ts:23`）。

## 调用链路

```
agent/request（agent-loop 提议 LlmCallConfig）
  └─ ctx.llm.prepareCall(proposedConfig, signal) → PreparedLlmCall{config, retryPolicy, adapterDefaults, stream}
     └─ streamWithRegistration() → ctx.waterfall(this, 'llm/stream', options, () => adapterStream(options))
        └─ adapterStream(): registration.adapter.stream(forAdapter(options, adapter))
           └─ AsyncGenerator<StreamChunk>
        └─ adapter throw / iterator throw → adapterFailureChunk() → terminal finish{kind:'error'|'aborted'}
  └─ for await chunk of stream:
     ├─ session.append('assistant/chunk', {chunk})  # raw chunk 写 log（replay 保真）
     └─ BlockAssembler.push(chunk)  # 边组装边
  └─ assembler.finish → {kind:'ok'|'error'|'aborted'|'max-tokens', usage, replayState?}
  └─ createAssistantMessage({content: assembler.blocks(), source:{provider, model}})
  └─ session.append('assistant/message', {...}, {surfaceOp:'append', sourceEventSeqs:chunkSeqs})
```

`forAdapter()`（`index.ts:823`）剥离跨 adapter 的 `replayState`——仅当同 adapter instance 持有 historical+target route 才传递，否则剥离，保证 replay 不泄漏跨 adapter 私有态。

## 核心实现

### Message 与 StreamChunk 词汇

`Message`（`message.ts:129`）含 `id`/`role`('system'|'user'|'assistant')/`content: ContentBlock[]`/`source: MessageSource`。`MessageSourceMap`（`message.ts:99`）是 merge-extensible sum type：`user`/`plugin`/`model`/`tool`。assistant 携 `AssistantProvenance { provider, model, replayState? }`（`message.ts:8`）。`ContentBlockMap`（`types.ts:99`）派生 `ContentBlock`：`text`/`reasoning`/`image`/`tool-call`/`tool-result`，全部 merge-extensible。构造器 `createUserMessage`/`createAssistantMessage`/`createToolResultMessage`（`message.ts:192/206/231`）均 deep-freeze。

`StreamChunk`（`types.ts:291`）是 closed discriminated union：`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`。`finish.reason` 由 `FinishReasonMap`（`types.ts:116`）派生：`stop`/`tool-calls`/`max-tokens`/`aborted`/`error`。Adapter 契约：usage 必在 finish 之前、之后无 chunk；tool-call arguments 全程保持 raw JSON string；失败要么 throw 要么 `finish {kind:'error'|'aborted', failure}`。closed union 加 variant 编译期 break 所有 consumer（`assertNever`），强制新 block type 同时落 adapter/UI/compaction 支持。

### Adapter 机制

**pi-ai adapter**（`llm-pi-ai`）：一个 `PiAiAdapter extends LlmAdapter`（`adapter.ts:186`）实例服务全部 configured provider routes，通过 `@earendil-works/pi-ai` 的 `Models.streamSimple(model, context, options)`（`adapter.ts:313`）动态解析 provider/model 对。`apply(ctx, config)`（`index.ts:150`）按 profiles map 调 `ctx.llm.registerAdapter(routes, adapter)` 或 `registration.replace(routes)`（`index.ts:270/272`），零 route 时保持 dormant（bare mount）。

**DeepSeek provider**（`llm-deepseek`）：`DeepSeekAdapter extends LlmAdapter`（`adapter.ts:158`），route `deepseek-official`，直连 fetch + `eventsource-parser` SSE framing（`sse.ts`）。retry policy 变更用 `registration.replace([PROVIDER])` 原子重注册（`index.ts:266`）。

**Adapter 职责边界**：仅负责 wire 翻译（provider 协议 ↔ `Message`/`StreamChunk` 词汇）、credential 解析、idle watchdog、attribution header、`replayState` 生成/校验。不负责 retry 执行、cache、rate limit（这些是 `llm/stream` middleware 或 `llm-retry` plugin 的事）。`LlmRuntime` 把 adapter 的 throw/finish 归一为单一 terminal failure。

### llm/stream waterfall

```typescript title="packages/llm/llm/src/index.ts"
'llm/stream'(this: LlmRuntime, options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

loop-built 的 `options` 带 `markAgentLoopRequest` 标记且 deep-frozen（mutation throws），listener 只读不改写——保证 request 是 session log 的 pure function（可重建性）。listener 可短路（cache 命中 `yield* cachedChunks()` 不调 `next()`）或包装。但 README 明确：listener 若已 emit chunk 则无 durable attempt boundary，故 shipped retry 走 `agent/request-error` 而非 waterfall 内重试。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Seam (Service Def/Provider/Consumer) | `LlmRuntime`（`index.ts:284`）+ `LlmAdapter`（`180`） | 一个 provider swap 切换模型 |
| Adapter | `DeepSeekAdapter`（`llm-deepseek/src/adapter.ts:158`）、`PiAiAdapter`（`llm-pi-ai/src/adapter.ts:186`） | 两实现：direct-fetch vs library-backed |
| Stream-observer (Waterfall) | `llm/stream`（`index.ts:64,921`） | 拦截/包装/短路每次 model call |
| Assembler (single canonical fold) | `BlockAssembler`（`assembler.ts:36`） | 唯一 chunk→block 折叠实现 |

## 模块间交互

agent-loop 在 `agent/request` 阶段构造 `LlmCallConfig`，经 `ctx.llm.prepareCall()` 绑定 registration + retry policy，再调 `ctx.llm.stream()`。产出 `StreamChunk` raw chunk 写入 `dsh-session`（replay 真相源）；`BlockAssembler` 组装的 `assistant/message` 作为 durable assistant message 入 session log。provider adapter 是 plugin（`apply(ctx, config)` 入口），靠 settings section + fiber 生命周期管理 registration。`llm/adapters-updated` emit 让 UI / selector 重读 `listProviders()` 而非轮询。

## 扩展方式

- **新增一个 model provider**：新建 `packages/llm/llm-<name>/`，`src/adapter.ts` 写 `<Name>Adapter extends LlmAdapter` 实现 `stream()`（usage 在 finish 前、arguments raw JSON string、`attributionHeaders()` 入 `User-Agent`）；`src/index.ts` `apply(ctx, config)` 调 `ctx.llm.registerAdapter([PROVIDER], adapter)` + `registerConfigurableProviders([{provider, settingsNs, settingsPath}])`，settings section 驱动 `registration.replace(routes)`。仿 `llm-deepseek` 加 idle watchdog、`isContextWindowExceededError` 分类、`EMPTY_RESPONSE` 映射。
- **拦截/改写一个 llm/stream 请求**：plugin 内 `ctx.on('llm/stream', (options, next) => {...})`，命中 cache 短路不调 `next()`；改写读 `options`（loop-built 已 frozen 不可 mutate）构造新 `GenerateOptions` 传 `next()`。
- **加新 content block type**（如 audio）：`declare module './types.ts'` 合并 `ContentBlockMap` 加 `'audio': AudioBlock`；adapter `stream()` emit `block-start`/`block-end` 带 audio；同步落 UI 渲染 + compaction 规则 + durable replay path——closed union 加 variant 在所有 `switch` 处编译报错，强制覆盖。

## 重要设计决策

为什么 LLM 是 seam 而非硬编码：`GenerateOptions.provider` 只是 route key，`ctx.llm.registerAdapter` all-or-nothing + `replace()` 原子换 route，换 provider = 改 settings + 重 register，不动 agent-loop/session/UI。provider-neutral 词汇让历史可跨 provider 重放。为什么 chunk 流式进 session log：agent-loop 同时喂 `BlockAssembler` 并 log raw chunks，`finish.replayState` 是 adapter-private lossless-JSON 存于 assistant message，重放时 `forAdapter()` 仅当同 adapter instance 持有 historical+target route 才传递——保证 replay 不泄漏跨 adapter 私有态。为什么 waterfall 在 llm/stream：拦截/改写请求而不污染 adapter，但 loop-built request deep-frozen 保证 request 是 session log 的 pure function。
