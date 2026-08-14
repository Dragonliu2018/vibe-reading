---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "委托与协议"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Subagent", "Workflow", "SDK", "ACP"]
description: "dsh 把另一个 agent 藏在同接口后——subagent provider、workflow worker-thread、skill registry、ACP/JSON-RPC SDK 与 extensions 自我修改。"
readingTime: "14 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

`packages/subagent`、`workflow`、`skill`、`acp`、`sdk`、`extensions`、`jobs`、`schedule`、`feedback`、`identity` 这组包把"另一个 agent"藏在同一个接口后。从 fresh child agent、delegated turn、model-written 脚本工作流，到把整个 harness runtime 嵌入另一个产品的 out-of-process SDK，都经 capability seam 抽象。这层独立是因为它把"谁来执行这个委托"从调用方解耦——`tool-subagent` 调 `ctx.subagents.start(provider, request)`，不知 provider 是 fresh child 还是另一个产品里的 delegated turn。

## 模块架构

```
subagent (ctx.subagents)  ──registerProvider──▶  SubagentProvider
  ├─ fresh child (spawn provider, inheritsParentContext=false)
  ├─ delegated turn (fork provider, inheritsParentContext=true, completedTurnPrefix seed)
  └─ out-of-process (acp/sdk/claude-code/codex)
workflow (ctx.workflowEngine)  ──WorkerThreadWorkflowEngine──▶  node:worker_threads
  static inject = ['subagents']   # workflow 是 subagent 的 Consumer
skill (skill registry): 多 provider catalog 合并 + rank 解重名 + list/get
sdk (JSON-RPC over stdio): HarnessClient spawn runtime → initialize → prompt → session.event
extensions (self-modification): DynamicCordisRegistry + node:vm sandbox, agent 挂自己写的插件
jobs (ctx.jobs): background-job runtime + job_output/job_kill tools
```

## 调用链路

### 一次 subagent delegation

```
model 调 subagent(description, prompt[, run_in_background])  (tool-subagent/src/index.ts apply → execute)
  ├─ foreground: ctx.subagents.start(config.provider, request)
  │    └─ SubagentRuntime.start: capability 校验 + descriptor 快照 → provider.start(resolved) → SubagentRun
  │       └─ settleForegroundRun: 收集 run.result → run.dispose()
  ├─ continuable background: ctx.subagents.startContinuable({provider, request, signal})
  │    └─ manager 接管 AgentHandle，provider 贡献 prepareContinuable → ContinuableCreateSpec{seed?}
  └─ one-shot background: ctx.jobs.start({owner, run})
       └─ run 回调里调 ctx.subagents.start()，结果经 settleStart → JobOutcome
```

### workflow worker-thread 执行

```
WorkerThreadWorkflowEngine.start (workflow-worker-thread/src/index.ts:112)
  ├─ host: assertBodyParses + validateMeta → 新建 WorkerRun spawn node:worker_threads.Worker
  ├─ worker (worker.ts): 在 node:vm 跑 model-authored script
  │    └─ agent() 调用经 HostToWorker/WorkerToHost protocol 桥到 host ctx.subagents.start
  └─ host dispose grace 后可强制 terminate worker
```

### SDK out-of-process

```
HarnessClient (sdk/client/src/client.ts:184)
  └─ spawn runtime 进程，JsonRpcLineTransport over stdio
     ├─ initialize({cwd, provider, model}) → server 按需 mount DeepSeek fallback adapter
     └─ prompt(sessionId, contentBlocks) → server getOrCreateSession → ctx.agents.create → agent.followup(message)
        └─ session.event 等 notification 由 server ctx.on(...) 订阅转发
```

## 核心实现

### SubagentProvider 契约

```typescript title="packages/subagent/subagent/src/types.ts"
interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities  // outputSchema/depthLimit/toolFilter/persona
  readonly inheritsParentContext: boolean       // 决定 model-facing 工具措辞
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
```

Service Definition 在 `SubagentRuntime extends Service`（`subagent/src/index.ts`），键 `ctx.subagents`；`registerProvider()` 是 effect-scoped，多 provider 并存。capability flag + `assertCapabilities()`（`subagent/src/index.ts:481`）保证 "fail loud, no silent degradation"。

### Workflow seam + worker-thread

抽象类 `WorkflowEngine extends Service`（`workflow/src/index.ts`），唯一方法 `abstract start(request): WorkflowRun`，键 `ctx.workflowEngine`。实现 `WorkerThreadWorkflowEngine`（`workflow-worker-thread/src/index.ts:112`）`static inject = ['subagents']`——workflow 是 subagent 的 Consumer，`agent()` 调用桥到 subagent provider。

### Skill provider registry

`packages/skill/skill/src/index.ts`：合并多 provider catalog、按 `rank` 解重名、暴露 `list/get`；`@deepseek-ai/dsh-skill-filesystem` 是一个 provider，还有 catalog/loader tool。

### SDK JSON-RPC

`HarnessSdkRequestMap`（`sdk/protocol/src/types.ts`）定义 `initialize`/`session/prompt`/`shutdown`；`HarnessSdkNotificationMap` 定义 `session.event`/`session.status`/`subagent.started`/`subagent.finished`。Server `HarnessSdkJsonRpcServer`（`sdk/server/src/server.ts`）订阅 `session/event`/`agent/status`/`session/created`/`subagent/end` 转发。

### Extensions 自我修改

`packages/extensions/cordis-host-runner/src/registry.ts` + `sandbox.ts`：`DynamicCordisRegistry` 持有 `DynamicCordisPlugin → DynamicCordisDefinition → DynamicCordisRun`；`createSandbox()`（`sandbox.ts:129`）用 `node:vm` fresh realm，trap 掉 `require`/`setTimeout`/`fetch` 重定向到 cordis services。registrations 是 reversible `ctx.effect()` disposer（`registry.ts` 的 `handlerDisposers`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Seam/Provider-registry | `SubagentRuntime`/`WorkflowEngine`/`JobRegistry`/skill registry（`subagent/src/index.ts:369`） | provider 经 `registerProvider()` 以 `ctx.effect()` 登记 |
| Worker-thread | `WorkerThreadWorkflowEngine`（`workflow-worker-thread/src/index.ts:112`） | 隔离同步脚本阻塞，支持强制 terminate |
| Self-modification | `DynamicCordisRegistry` + `node:vm`（`extensions/cordis-host-runner/src/registry.ts:141`、`sandbox.ts:129`） | agent 自挂载插件 |
| Protocol-server | `HarnessSdkJsonRpcServer`（`sdk/server/src/server.ts:71`） | cordis events 翻译成 JSON-RPC notifications |

## 模块间交互

subagent/workflow/skill/jobs 全是 capability seam，model-facing `tool-*` 包是 Consumer；`tool-subagent` 经 `ctx.subagents.start` 走 provider。workflow engine `static inject = ['subagents']`，`agent()` 调用桥到 subagent provider，形成 workflow→subagent 依赖。sdk server 暴露 `agent-loop`（followup + session.event 流）让另一个进程驱动 harness runtime。extensions 的 dynamic plugin 经 `ctx.tools.register`/`ctx.effect` 挂到同一 agent 运行时——self-referential：agent 修改自己跑的 cordis。jobs 经 `tool-jobs` 暴露 `job_output`/`job_kill`；`tool-subagent` one-shot background 路径调 `ctx.jobs.start`。

## 扩展方式

- **新增 subagent provider**：实现 `SubagentProvider` 接口（`start` 必填，`prepareContinuable` 选填），新建 `packages/subagent/subagent-<name>/src/index.ts`，`apply()` 调 `ctx.subagents.registerProvider(new MyProvider())`，`inject = ['subagents']`。参照 `subagent-fork-in-process/src/index.ts:92`。
- **新增 workflow engine**：继承 `WorkflowEngine` 实现 `start`，`apply()` 注册。换掉 worker-thread 参照 `workflow-worker-thread/src/index.ts:112` 的 `static Config` 和 `static inject`。
- **用 sdk 嵌入另一个产品**：`new HarnessClient({command, args, cwd, env, requestTimeoutMs})` → `start()` → `initialize({cwd, provider, model})` → `prompt(sessionId, blocks)` → `subscribeSessionTree(sessionId)` 流式收 `session.event`。参照 `sdk/client/src/client.ts:184`。

## 重要设计决策

为什么 subagent 是 seam 而非硬编码：fresh child（`spawn` provider `inheritsParentContext=false`）vs delegated turn（`fork` provider `inheritsParentContext=true`，`completedTurnPrefix()` seed parent 已完成 turn 前缀，`subagent-fork-in-process/src/index.ts:48`）解决"context 继承"语义差异；out-of-process（`acp`/`dsh-sdk`/`claude-code`/`codex`）provider 解决"另一个产品里的 delegated turn"。capability flag + `assertCapabilities()` 保证 "fail loud, no silent degradation"。为什么 workflow 用 worker-thread：防止 model-written 脚本同步工作阻塞 host event loop，并允许 forced termination（`disposeGraceMs` 后 SIGTERM worker）；明确声明 "containment rather than a security boundary"。为什么 sdk 用 JSON-RPC over stdio：out-of-process runtime，caller 供 runtime 可执行 + `cordis.yml`；`HarnessClient` 拥有 child process 走 EOF→SIGTERM→SIGKILL ladder（`sdk/client/src/client.ts:380`），无 wire-level cancel，超时仅 abandon 客户端等待。为什么 extensions self-modification 安全：registrations 是 reversible `ctx.effect()` disposer，`node:vm` sandbox trap Node API 重定向到 cordis services；但文档明确 "host-realm helper functions remain an escape route"——非安全边界，靠 trust stance。

---

> **待核实**：`packages/schedule/`、`packages/feedback/`、`packages/identity/` 未读源码，仅按 README 与模块命名推断为 session-local 调度 / 反馈 / 身份 capability seam。
