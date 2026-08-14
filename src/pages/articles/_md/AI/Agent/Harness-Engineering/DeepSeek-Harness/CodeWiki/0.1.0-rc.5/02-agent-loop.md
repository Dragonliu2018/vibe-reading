---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "Agent Loop 执行核心"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Agent Loop", "Cordis", "TypeScript"]
description: "dsh 的 turn/step 驱动器——ReactLoopAgent 的 Phase 状态机、inbox claim、prompt 装配、agent/* waterfall 事件与 Agent handle 取消恢复。"
readingTime: "17 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

Agent Loop 是 dsh 的驱动核心，但**它本身也是一个插件**——这是"无特权核心"原则的极致体现。`packages/core/agent-loop` 提供唯一的具体驱动 `ReactLoopAgent`，它 `implements Agent` 接口（定义在 `packages/core/agent`），通过 `ctx.agents.setFactory(this)` 注册。外部依赖 `@deepseek-ai/dsh-agent` 接口而非 `agent-loop` 包，使整个 loop 可被替换。它负责把 inbox 里的 input、prompt 装配、LLM 流式、工具执行串成 turn/step 事件流，并通过 `agent/*` 事件暴露拦截点。

## 模块架构

```
AgentLoop (Service implements AgentFactory)  ──setFactory──▶  ctx.agents (registry)
   │ static inject = ['agents','sessions','llm','tools','systemPrompt']
   │ constructor: 对每个 config.agents → prepare() → publish('startup')
   ▼
ReactLoopAgent implements Agent
   ├─ phase: Phase 状态机  (idle | maintenance | running)
   ├─ inbox: Inbox (next-turn / next-step 两个有序 FIFO)
   ├─ scope: createScope(loopCtx, this) → ctx = scope.ctx.extend({agent: this})
   ├─ dispatch: agentEvents(scope carrier) — agent/* 事件调度
   └─ AgentHandle { agent, dispose() }  — dispose 是 capability
```

`AgentLoop`（`packages/core/agent-loop/src/index.ts:296`）是 `Service implements AgentFactory`，`static inject = ['agents','sessions','llm','tools','systemPrompt']`——这五个服务就绪才执行。`ReactLoopAgent`（`agent.ts:64`）是唯一具体驱动，包内 private，exports map 无 `./src/*` 逃逸。`Agent` 接口（`packages/core/agent/src/runtime-types.ts:64`）含 `id`/`options`/`session`/`inbox`/`status`/`ctx` 及方法 `cancel()`/`whenIdle()`/`runMaintenance()`/`send()` 与预设别名 `followup()`/`steer()`/`inject()`。

## 调用链路

turn/step 主循环（均在 `agent.ts`，引用概览的 turn-flow.svg 看全貌）：

```
wakeDriver() → setPhase{running} → ctx.agents.withInitiator(this, () => kick())
  └─ kick(): while(await turn()) {}                    # turn 循环
     └─ turn():
        ├─ session.append('turn/start', {turn})
        ├─ while(true):
        │  └─ preStep(target, {turn, step})
        │     ├─ inbox.claim(target, turn) → UserMessage[]   # 原子批量删除
        │     ├─ ctx.systemPrompt.assemble(assembleContextFor(this, signal))  # prompt + tool schemas
        │     └─ dispatch.waterfall('agent/pre-step', {messages,...}, default:{kind:'enter',messages})
        │        → PreStepDecision{reject | enter{messages,assembly}}
        │  └─ reject → turnEnds={kind:'blocked'}; break
        │  └─ session.append('step/start'); session.append('user/message') per message
        │  └─ step(assembly):
        │     └─ buildRequest() → agent/request waterfall → ctx.llm.prepareCall() → ctx.llm.stream()
        │        └─ for await chunk: session.append('assistant/chunk'); BlockAssembler.push(chunk)
        │     └─ createAssistantMessage() → session.append('assistant/message')
        │     └─ executeToolCalls() → tools/pre-execute → execute → post-execute → tool/result
        │  └─ session.append('step/end')
        │  └─ turnEnds && inbox.nextStep.length===0 → dispatch.serial('agent/turn-stopping')
        └─ session.append('turn/end', {turn, reason})
```

关键数据类型：`inbox.claim(target, turn) → UserMessage[]`；`systemPrompt.assemble(AssembleContext) → PromptAssembly`；`session.deriveMessages() → Message[]`（从 log 投影）；`ctx.llm.prepareCall(LlmCallConfig, signal) → PreparedLlmCall`；`ctx.llm.stream(GenerateOptions) → AsyncIterable<StreamChunk>`；`executeToolCalls() → {concluded: boolean}`。

## 核心实现

### Phase 状态机

核心状态是 `private phase: Phase`（`agent.ts:38`），closed union：

```typescript title="packages/core/agent-loop/src/agent.ts"
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort; lastTurn; wakeRequested }
  | { kind: 'running'; abort; turn; step; wakeRequested }
```

`setPhase()`（`agent.ts:104`）发布 `agent/status` 事件。`wakeDriver()`（`agent.ts:172`）从 idle→running，经 `ctx.agents.withInitiator(this, () => this.kick())` 传播 initiator scope。turn/step 编号内嵌在 running phase。`AgentHandle`（`packages/core/agent/src/index.ts:172`）包装 `{ agent, dispose() }`——dispose 是 capability，只有持有者能 teardown。

### Inbox 单入口与 claim 语义

`Inbox` 两个有序 FIFO（`next-turn`/`next-step`）。`send(message, target, wakeup)`（`agent.ts:113`）是唯一路由原语，`followup`/`steer`/`inject` 是固定预设别名。`claim(target, turn)`（`agent.ts:225`）原子批量删除——turn 边界处 claim next-step + 一个 next-turn prompt；step 间只 claim next-step。这确保所有 input 走相同 durable splice 事件与 claim 语义，`agent/pre-step` waterfall 统一处理。

**agent/pre-step 可 reject 为何能关闭 durable turn**：reject 时 claimed batch 已通过 `inbox.claim()` 纯删除移除（不回退），turn 已 open（`turn/start` 已 logged），所以 reject 直接设 `turnEnds = {kind:'blocked'}` 关闭 turn，不产生 step——claimed message 既不 discard 也不 re-emit，在 `agent/inbox/claimed` 事件中终止（`agent.ts:267`）。这保证 inbox mutation 的 durable 一致性。

### Prompt 装配与 runtime context 注入

`preStep()` 调 `ctx.systemPrompt.assemble(assembleContextFor(this, signal))` 装配 prompt sections + tool schemas。`AgentLoop` constructor（`index.ts:351`）注册 `provider`/`model`/`cwd` 等 prompt variables。`runtimeContext.project()` 注入动态 runtime context snapshot。工具 schema 经 `ctx.systemPrompt.tools()`（由 `core/tools` 注册 `wireSchemas`）每次 assembly 按 calling scope 重新解析可见工具集。

### Waterfall vs Serial 事件语义

- **Waterfall**（`agent/pre-step`、`agent/request`、`agent/request-error`）：MUST call `next()`，listener 可 rewrite 返回值（`dispatch.ts:143`）。`next()` 默认 fallback 让 listener 可缺席。
- **Serial**（`agent/turn-stopping`）：无 `next()`，listener 通过数据决策——steer 注入则继续，不 steer 则关闭 turn（`agent.ts:296`）。serial 保证 listener order 不改变 outcome。

### 取消与错误恢复

`AbortController` 贯穿 `Phase`，`cancel(cause)` 调 `phase.abort.abort(cause)`；`signal.throwIfAborted()` 在 preStep/step/buildRequest 关键点检查。LLM finish 为 error/aborted 时走 `agent/request-error` waterfall 决定 retry（`{kind:'retry'}`）或 throw `LlmError`。turn 级 try/catch 把 `signal.aborted` 映射为 `{kind:'aborted', reason}`、其他 error 映射为 `{kind:'error', error}`，经 `throwError()` 发 `agent/error` 事件后 throw。tool 层 `fuseToolSignals()` 融合 caller + wrapper signal，`bodyInvoked` 区分 `ABORTED` vs `ABORTED_BEFORE_DISPATCH`。README 明确："No built-in turn budget — a policy that bounds runaway turns must cancel from an existing lifecycle extension point such as `agent/turn-stopping`"（`README.md:134`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| State Machine | `agent.ts:38` `Phase` | idle→running→idle 转换，发布 agent/status |
| Driver/Plugin 分离 | `ReactLoopAgent` private + `Agent` 接口 | loop 可替换，外部只依赖接口 |
| Inbox-queue | `Inbox` 双 FIFO + `send()` 统一路由 | 所有 input 走相同 durable 语义 |
| Waterfall-middleware | `dispatch.waterfall`（`dispatch.ts:143`） | 多插件包裹 agent/pre-step / request |
| Serial checkpoint | `dispatch.serial`（`dispatch.ts:138`） | turn-stopping 顺序不影响 outcome |
| Scoped-registration | `createScope(loopCtx, this)` | per-agent scope，hot-path 零分配 |
| Rollback-covered transaction | `prepare()`（`index.ts:459`） | 先建 teardown 再建资源，setup 失败回滚 |

## 模块间交互

agent-loop 调用：`ctx.systemPrompt.assemble()`（prompt 装配，`index.ts:351` 注册 variables）；`session.append()`/`session.deriveMessages()`（写/读 log）；`ctx.llm.prepareCall()`/`ctx.llm.stream()`（LLM）；`executeToolCalls()`（`tool-calls.ts:59`）调 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 的 prepare/dispatch/finalize。被 `boot`/`preset` 装配：config 驱动的 agents 在 constructor 自动创建；preset 通过 `ctx.agentPresets.mount()` 在 setup 中组合 per-session tool/prompt 投影。

## 扩展方式

- **拦截一个 request/turn**：`ctx.on('agent/pre-step', ...)`（reject 关闭 step）或 `ctx.on('agent/request', ...)`（替换 `LlmCallConfig`，改 provider/model），无需改 agent-loop。
- **注入 model-visible context**：在 `agent/session-start` emit 中调 `agent.inject(message)`，message 进 next-step inbox，下次 `preStep()` claim 时注入。
- **加 turn budget**：在 `agent/turn-stopping` serial listener 中检查 turn/tool call 次数，超限 `agent.cancel({kind:'hook', reason})`。

## 重要设计决策

为什么 agent loop 本身也是插件：通过 `ctx.agents.setFactory()` 注册，外部依赖 `@deepseek-ai/dsh-agent` 接口，使 loop 可替换。为什么用 inbox 单入口：确保所有 input 经相同 durable splice 事件与 claim 语义，`agent/pre-step` 统一处理。为什么 waterfall vs serial 区分：waterfall 让多插件 rewrite 单决策，serial 让多 listener 不改 outcome 地观察/影响 turn 停止。
