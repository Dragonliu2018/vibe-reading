---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "客户端与 Host"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Web GUI", "BFF", "Typert", "React"]
description: "dsh 的 Web GUI 双半——host BFF + 浏览器 shell、ConversationNode 渲染系统与 Typert 类型图 RPC。"
readingTime: "15 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

`packages/host`、`packages/client`、`packages/api`、`packages/typert`、`apps/web` 是 dsh Web GUI 的双半架构。host 半（`host/apiproxy`）是 API gateway + HTTP route server，跑在 Node 进程持有所有 side-effectful method；client 半（`client/*`）是浏览器 runtime + connection + `ui-*` 插件群。这层独立是因为它把"agent 在哪跑"和"UI 怎么渲染"分开——agent 逻辑在 server 进程，浏览器只做 rendering，形成安全边界与进程隔离。UI 全从 session/event 渲染，不直接调 agent。

## 模块架构

```
host 半 (packages/host/apiproxy)                 client 半 (packages/client)
  ApiProxyService (ctx.apiProxy)                  ConnectionController (ctx.connection)
  ├─ shared API 契约 (src/api/, 零 Node 依赖)        ├─ 两条 downlink-only WebSocket (events.mux + events.host)
  ├─ fetch carrier 对 (src/fetch/)                 ├─ readiness handshake (host.describe + 双流 onOpen)
  └─ host impl (src/api-proxy.ts)                  └─ 指数退避重连
         │ four-quadrant wire                              │
         │  ClientRequest (POST /api/<method>)             │ ClientResponse (POST /api/respond)
         │  ServerResponse (POST 响应)                     │
         │  ServerRequest (downlink WS frame)              │
         │  ClientResponse                                 │
         ▼                                                 ▼
  TypertGatewayService (ctx.typertGateway)        ClientRemote (ctx.remote)
  从 ctx.typert.local 读 InvocationDescriptor      ctx.remote.$mount() 注册 generated contribution
  验证命名参数 + 调 business method + 验证返回     调用走 ctx.connection.rpc.call('/api', endpoint, ...)
```

## 调用链路

event 到 UI 渲染：

```
ConnectionController.pumpStream  (client/connection)
  └─ onMuxEnvelope / onHostEnvelope sink
     └─ SessionRuntime fan-out 到 Session + Workspace owner
        └─ 每个 generic host/remote-event frame 交给 ctx.remote.$dispatch
           └─ ConversationNodeAssembler.append(event)  (runtime/sessions/conversation-assembler.ts:137)
              ├─ 对每个 event 调所有 ConversationNodeDefinition.match()
              ├─ 匹配后创建/更新 InternalContext
              └─ 按 publication() 决定的 cadence flush()
                 └─ buildViewNode() → ConversationViewNode
                    └─ chat view dispatch 到匹配 key 的 renderer (slots 'conversation.chat.node')
```

## 核心实现

### ConversationNode 系统

核心接口 `ConversationNodeDefinition<State>`（`packages/client/runtime/src/client/contract/conversation.ts:171`）是独立注册的 Event-to-Node 状态机：

```typescript title="packages/client/runtime/src/client/contract/conversation.ts"
interface ConversationNodeDefinition<State> {
  kind: string
  target?: string
  match(event: SessionEvent): ConversationMatchResult | null
  start(context, match, reader): State
  update(context, match): State
  publication?(match): ConversationPublication  // 'none'|'animation-frame'|'immediate'
  buildViewNode?(context): ConversationViewNode | null
}
```

注册流程（`ui-conversation/src/client/conversation-nodes/register.ts`）：plugin apply 时 `registerConversationNodes(ctx)` 逐个注册 message/assistant/tool/command/compaction/retry/turn-error/turn-tail 等 Definition 到 `ctx.conversationEvents`；`registerChatNodeRenderers`（`chat/register-node-renderers.ts`）用 `ctx.slots.inject('conversation.chat.node', ...)` 按 key 注册 React renderer（`key: 'user' → UserMessageNodeView` 等）。

`ConversationNodeAssembler`（`runtime/src/client/sessions/conversation-assembler.ts:137`）是 per-Session 增量引擎。`append`/`prepend`/`replaceWindow` 三路径保证 live append、history page、reconnect resync 用同一套 Definition replay——refresh 既不丢 terminal failure 也不 resurrect discarded chunk。

### Typert 类型图 RPC

**Typert generator**（`packages/typert/generator`，10720 行）是 build-time TypeScript 分析器，产出 compiler-independent `FaceModel` + `TypeGraph`（`src/model.ts`）。`WorkspaceAnalyzer` 用 `tsconfig.host.json`/`tsconfig.client.json` 做 face 分离，从 Cordis `Context`/`Events` augmentation 和 `@typert` 声明发现 contributors，产出 executable JS（含 Zod schema）+ `.d.ts`。包含 `TypeDeclarationModel`、`TypeNodeModel`（18 种变体）、`InvocationModel`（每个 `@Remote` 方法的参数/返回 boundary、cancellation 支持）。

**Gateway 如何用**（`packages/api/gateway`）：Host 面 `TypertGatewayService`（`ctx.typertGateway`）从 `ctx.typert.local` 读 generated `InvocationDescriptor`，验证命名参数、解析 object/Context identity、调 business method、验证返回值。Client 面 `ClientRemote`（`ctx.remote`）通过 `ctx.remote.$mount()` 注册 generated contribution，验证后安装 typed 方法，调用走 `ctx.connection.rpc.call('/api', endpoint, ...)`。`api/remotes` 是 BFF：Host 面 owns Agent/Session identity policy（`createApiRemoteAgentResolver`），Client 面 import generated `/remote` artifacts。

### Runtime 与 ProjectionValueStore

`SessionRuntime` owns `Session` 对象和共享 event window + history paging。client session 总是 Host-born（`session.create` 同时创建 Session+Agent+cwd）。Agent scope（client mirror of host dsh-scope）在 session row 进入 list mirror 时诞生，prune 时消亡——client 不持有 pre-entity session state。`ProjectionValueStore` 从 history-tail `projections` block seed，由 `session/projection` frame 在 higher-seq-wins 下更新。domain key（含 `todos`、`title`、`tokenUsage`）通过 `projections.faceOf`/`useProjection` 读取。

### Trust fence

`connection/src/api-request-trust.ts` 把 privileged method set（`host.pickDirectory`、settings/credentials 全量、agentPreset authoring）pin 到 loopback。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| BFF | `packages/api/remotes` | Host Agent/Session policy + Client Remote contribution mount |
| API Gateway | `ApiProxyService` + `TypertGatewayService` | shared `/api` route，Typert interceptor claim 优先，fallback API Proxy |
| Type-graph RPC | `typert/generator` → `InvocationDescriptor` → Gateway runtime validate | 从 TS 源自动生成 Zod schema + 契约 |
| Node Registry (ConversationNode) | `ConversationNodeDefinition` + `ConversationNodeAssembler` + keyed renderer slot | Event-to-Node 状态机增量渲染 |
| Observer (render from event stream) | `ConnectionController.pumpStream` → `SessionRuntime` fan-out → `ConversationNodeAssembler` → React | UI 从 durable event stream 投影 |

## 模块间交互

host `apiproxy` 的 `/api` route 由 `webserver` 挂载，`toFetchHandler(api)` 把 Fetch 请求桥接到 `ApiProxyService`。client `connection` 是 wire consumer，`AbstractApiClient` 持 rpcId 生成、envelope 包/解、Zod parse、SSE 解码、unary timeout，平台子类只补 `doFetch`。client runtime drive `ctx.agents` 并从 session/event 渲染（对应"Add UI integration"）。`api/gateway` + `typert` 做 host↔client 类型安全契约。domain package 通过 `ctx.remote.$on` 订阅 owner event 并 invalidate cache。

## 扩展方式

- **新增一个 Chat node renderer**（"Add a Web Client Chat node"）：在 domain package 声明 `ChatNodeDataMap` key（declaration-merge）；实现 `ConversationNodeDefinition`（`match`/`start`/`update`/`buildViewNode`）注册到 `ctx.conversationEvents`；在 `register-node-renderers.ts` 加 `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ key: '<your-key>' }, YourNodeView))`。参考 `docs/cookbook/adding-a-conversation-node.md`。
- **加一个 host route**：在 `apiproxy/src/api/` 的 domain interface（如 `SessionsApi`）加方法签名；`RpcMethodMap` 注册；Zod schema `satisfies z.ZodType<Wire<T>>`；Host 实现 `src/api-proxy.ts` 的 dispatch table。
- **加一个 Typert Remote method**：Business Service 继承 `TypertRemoteService`，方法标 `@Remote`；Host tsdown 自动跑 Typert generation 产出 `lib/typert.host.{js,d.ts}`；`api/remotes` 的 Client entry 加 `/remote` value import + `ctx.remote.$mount()`；Gateway 验证参数/返回值，Connection 负责 transport。

## 重要设计决策

为什么 host/client 分两半：Host owns `/api` route 和所有 side-effectful method（session/agent/settings/credentials），client 只发 RPC + 收 event；trust fence 把 privileged method pin 到 loopback——agent 逻辑在 server 进程跑，浏览器只做 rendering，安全边界与进程隔离。为什么 UI 全从 session/event 渲染：session log 是 truth source，UI 从 durable event stream 投影；`ConversationNodeAssembler` 的 `append`/`prepend`/`replaceWindow` 三路径保证 live/history/resync 用同一套 Definition replay，比直接调 agent 解耦渲染与执行。为什么用 Typert 生成 type graph：从 TS 源码自动生成 Zod schema + InvocationDescriptor，避免手写 schema 漂移；host/client 共享一份 contract；`check` 模式在 CI 强制 source 与 model 可无损保留。代价是 generator 复杂度（10720 行），但一次投入覆盖所有 RPC method。
