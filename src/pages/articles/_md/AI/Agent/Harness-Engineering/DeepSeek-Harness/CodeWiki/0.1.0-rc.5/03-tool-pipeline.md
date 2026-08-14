---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "Tool 工具管线"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Tools", "Capability Seam", "Cordis"]
description: "dsh 的 scoped tool registry 与三段 waterfall 守卫管线（pre/execute/post-execute），以及 capability seam 三角色如何在此落地。"
readingTime: "15 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

`packages/core/tools` 是 model-facing 工具的归宿——它既是 `ctx.tools` 的 Service Definition，也是所有 `tool-*` 包（Consumer）注册进来的 registry 宿主。它解决两个问题：同一进程内不同 agent 看到不同工具集（scoped registry），以及工具执行前后插入多插件策略（守卫管线）。工具是 model 与外部能力交互的唯一入口，schema 走 prompt assembly、执行走 waterfall 管线、结果走 durable session event。

## 模块架构

```
ToolRuntime extends Service (ctx.tools, role: core)
  ├─ ScopedLayers (index.ts:811)  ── per-scope ToolLayer (register/restrict/guard/presentAs)
  │     └─ view(scope): inherited surface 经 restriction 过滤 + overlay own
  ├─ register(definition) → disposer          # trusted 同进程工具
  ├─ schemas(scope?) → ToolSchema[]           # 投影进 systemPrompt.tools()
  ├─ execute(ToolExecutionInput)              # 完整管线入口
  └─ TOOL_RUNTIME_SCHEDULER  ── prepare/dispatch/finalize 分阶段调度
        ├─ tools/pre-execute  [waterfall] → PreToolDecision{allow|deny|ask}
        ├─ tools/execute      [waterfall] → around-dispatch (timeout/retry)
        └─ tools/post-execute [waterfall] → PostToolDecision{accept|block|replace}
              └─ finalizeContent + emit('tools/result') + session.append('tool/result')
```

`ToolRuntime`（`index.ts:787`）核心方法：`register(definition): () => void`（`L1037`，强制要求 `output { schema, render, presentationMeta? }`）；`get(name, scope?)`/`schemas(scope?)`（`L1204`/`L1234`，按 scope 解析，project 出 model-facing `ToolSchema[]`，剔除 `execute`/`output` 等回调）；`restrict(filter)`/`presentAs(mode)`/`guard(guard)`（per-agent 贡献）；`execute(exec: ToolExecutionInput)`（`L1342`，管线入口）。

`ToolDefinition`（`index.ts:222`）= `ToolSchema` + `output: ToolOutputDefinition`（schema/render/presentationMeta）+ `execute(args, exec)` + 可选 `finalizeContent`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult`。

## 调用链路

agent loop 的 `executeToolCalls`（`packages/core/agent-loop/src/tool-calls.ts:57`）是消费者：

```
model tool-call block
  → session.append('tool/call')  [durable]
  → ctx.tools.executionMode(exec)                 # parallel/exclusive 分类
  → SCHEDULER.prepare(exec):
  │   ├─ createExecution: snapshot+freeze args, assign token, code-collapse check
  │   ├─ ctx.waterfall('tools/pre-execute', exec) → PreToolDecision{allow|deny|ask}
  │   ├─ serviceAsk (if ask) → ctx.approval.request → allow/deny
  │   └─ guardReason(exec) → monotonic guards (deny 或 abstain)
  → SCHEDULER.dispatch(exec):
  │   ├─ ctx.waterfall('tools/execute', mutableExec) → around-dispatch
  │   ├─ dispatchToolBody: fuseToolSignals + tool.execute(args, exec)
  │   └─ createSuccessResult: validate output.schema, render content
  → SCHEDULER.finalize(exec, result):
  │   ├─ ctx.waterfall('tools/post-execute') → PostToolDecision{accept|block|replace|attach}
  │   ├─ applyFinalContent: finalizeContent callback
  │   └─ materializeFinalResult: deepFreeze + emit('tools/result')
  → session.append('tool/result')  [durable, surfaceOp:'append']
  → presentResult(args, result) → UI card
```

关键类型流转：`ToolExecutionInput`(caller) → `ToolExecution`(registry-owned, immutable) → `ToolRunContext`(body view, +`deferContext`/`concludeTurn`) → `ToolExecutionResult`(discriminated success/failure, frozen)。每步输入输出有明确 schema 验证：body 返回 lossless JSON `value`，`output.render` 投影成 model-facing `content`，`presentationMeta` 投影 UI metadata。

## 核心实现

### Scoped Registry 与 per-agent 工具集

`view(scope)`（`index.ts:1152`）做 scope-chain 遍历——inherited surface（global + 祖先 layers）经 restriction 过滤后，overlay 本 scope 的 own registrations。`ToolLayer` 是 `ScopeLayer`：plain ctx 注册 = global，`agent.ctx` 注册 = scoped。这允许同一进程内不同 agent 有不同工具集（shadowing 同名工具、restrict 隐藏全局工具）。JSDoc 解释：restriction 过滤的是 INHERITED surface，不碰 own-layer，这样 delegated child 保留其应答机制。

`register`/`restrict`/`guard`/`presentAs` 均返回 `() => void` disposer，随 fiber dispose——registrations 是 reversible effects。

### 三段 Waterfall 守卫管线

三个 `@mode waterfall` 事件（声明于 `Events` 接口 `index.ts:142-208`）：

```typescript title="packages/core/tools/src/index.ts"
'tools/pre-execute'(exec: ToolExecution, next): Promise<PreToolDecision>   // allow|deny|ask
'tools/execute'(exec: ToolDispatchExecution, next): Promise<ToolExecutionResult>  // around-dispatch
'tools/post-execute'(exec, result, next): Promise<PostToolDecision>   // accept|block|replace|attach
```

每个 listener MUST call `next()`；`next()` 默认 fallback 是 allow/accept。`tools/pre-execute` 返回 `{kind:'ask', reason}` 时 registry 调 `ctx.approval.request`（`L1689`）。`tools/execute` 是 around-dispatch waterfall——timeout/retry wrapper 可替换 `signal`，但 registry 在 body 前重 fuse caller signal（`fuseToolSignals` `L1889`），保证 caller cancellation 不被 wrapper detach。`tools/post-execute` 可 `block` 工具或 `attach context` 到 inbox。

还有 monotonic `ToolGuard`（`L711`）——返回 `string|undefined`，无 allow 结果，只能 deny 或 abstain，listener 顺序不可逆转 denial（`guardReason` `L1119` 先 global 后 chain）。

### Schema-driven 工具声明

`defineTool`（`schema.ts`）用 `ParameterSchemaSpec`/`ValueSchemaSpec` DSL 声明参数，`InferArgs`/`InferValue` 编译期推断，`parameterSchemaSpecToJsonSchema`/`valueSchemaSpecToJsonSchema` 运行期投影。`schemas()` 自动 feed 进 `ctx.systemPrompt.tools()`（`L832`，constructor 自动注册 `wireSchemas`），prompt assembly 时按 calling scope 重新解析可见工具集。schema 是 model-visible 的唯一入口。

### Canonical value / Presentation 分离

body 返回 lossless JSON `value`，`output.render` 投影成 model-facing `content`，`presentationMeta` 投影 UI metadata。value 本身 execution-local 不持久化（`L1793-1823`）。`presentCall`/`presentResult`（`presentation.ts`）返回 card-tagged union（`generic`/`terminal`/`diff`/`search`/`read`/`web`），让 tool 自描述 UI 渲染而 UI 不 special-case tool name。必须 pure（live streaming 和 log replay 都调），所以依赖 only args + durable result；canonical value 不可重建，故 `output.presentationMeta` 持久化进 `tool/result` 事件，`presentResult` 从中 narrow。

### Code Mode collapse

`mode: 'code'` 下 model-direct call 非 `run_code` 在 `createExecution` 即 resolve 为 `UNKNOWN_TOOL`（`L1423`），before pre-execute，保证 policy pipeline 不观察一个注定失败的 call。SDK sub-dispatch 带 `parent` token 豁免。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Registry + Disposable | `ScopedLayers`（`index.ts:811`）+ `ToolLayer` | per-scope 工具集，register 返回 disposer |
| Pipeline-middleware (waterfall) | pre/execute/post-execute 三段 | 多插件串联 policy，每段有默认 fallback |
| Guard-policy (monotonic) | `ToolGuard`（`L711`） | 只能 deny 不可逆，防 listener 序绕过 denial |
| Schema-driven | `defineTool`（`schema.ts`） | 编译期类型推断 + 运行期 JSON Schema 投影 |
| Canonical value / Presentation split | `output.render` + `presentationMeta` | value 不持久化，render 纯函数从 durable result 投影 |

## 模块间交互

agent-loop 的 `executeToolCalls`（`tool-calls.ts`）经 `TOOL_RUNTIME_SCHEDULER`（`L796`）的 `prepare`/`dispatch`/`finalize`/`finish` 分阶段调用，以支持 parallel pool 调度（dispatch 可 overlap，policy/result 保持 model order）。tools 经 `ctx.systemPrompt.tools()` 注册 `wireSchemas`（`L832`）；opportunistic `ctx.get('approval')`/`ctx.get('codeRuntime')`，无则 degrade（approval degrade to deny）。Consumer 侧：`tool-fs`/`tool-bash`/`tool-web`/`tool-terminal` 等 `inject=['tools']` 注册工具；MCP server 每个一个 plugin。agent-loop 调 `session.append('tool/call')`/`tool/result'`（tools 本身不直接写 session event，只发 live `tools/result` emit）。

## 扩展方式

- **新增 model-facing tool**：在 `packages/<group>/tool-<name>/` 调 `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`，body 内调对应 capability（如 `ctx.fs.readBytes`）。需 UI 卡片则加 `presentCall`/`presentResult` + `output.presentationMeta`。
- **在 execute 前加 policy 拦截**：`ctx.on('tools/pre-execute', exec => next => ({...}))`（allow/deny/ask，reorderable），或 `ctx.tools.guard(exec => reason | undefined)`（monotonic，不可逆）。需 approval 则 listener 返回 `{kind:'ask', reason}`，registry 调 `ctx.approval.request`。
- **加 timeout/retry wrapper**：注册 `tools/execute` waterfall listener 包 `next()`。`ToolDefinition.timeoutMs` 是声明性 metadata，registry 不 enforce（`L254` JSDoc），需 wrapper（参考 `@deepseek-ai/dsh-tool-call-timeout-policy`）。

## 重要设计决策

为什么 registry 是 scoped：允许同进程不同 agent 有不同工具集，restriction 过滤 inherited surface 不碰 own-layer 让 delegated child 保留应答机制。为什么 pre/post-execute 是 waterfall：允许多独立 plugin 串联（hooks/permission/sandbox/spill-policy），每段 reorderable 语义 + 默认 fallback，简单 hook 无法组合且无法 `next()` 传递。为什么 tool schema 走 prompt assembly：restriction/shadow/presentAs 变更立即反映到 prompt，`toolOrder` 验证可见性，schema 是 model-visible 唯一入口。为什么 tool UI render intent 是设计一部分：tool 自描述 UI 而 UI 不 special-case tool name，render 必须纯函数让 live 与 replay 一致。
