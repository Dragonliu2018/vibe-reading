---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "客户端 SDK"
date: "2026-09-17T23:57:50+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "SDK", "重连", "订阅聚合"]
description: "paseo @getpaseo/client——createPaseoClient 的 handle 工厂 API 面、DaemonClient 6496 行的连接/重连/RPC 关联等待模型、ConnectionSubscriptions 引用计数订阅聚合、直连与 E2EE relay 双传输。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/client/src/`（~16.8k 行净代码）是 `@getpaseo/client`——**对外是稳定产品 SDK**（版本化协议兼容，README 的 quickstart 面），**对内是 App/CLI/Desktop 共用的客户端引擎**（App 直接 import `@getpaseo/client/internal/daemon-client` 用 `DaemonClient`）。一个包两层身份：`index.ts` 是"对外产品"，`daemon-client.ts` 是"对内共享引擎"。App 复用全部重连/订阅/COMPAT 门控逻辑而无需经高层 facade——协议演进的维护成本集中在这一个包里。

## 模块架构

```
index.ts（931 行）                      # 对外：createPaseoClient()
└── PaseoApi 六组 handle
    └── agents / workspaces / projects / providers / config / terminals
        └── createAgentHandleFactory()（:672）   # handle 闭包工厂

daemon-client.ts（6496 行）             # 对内：DaemonClient（clientType 可选）
├── 连接生命周期 connect()/attemptConnect()/scheduleReconnect()
├── RPC：sendCorrelatedRequest() → waiters 集合按 predicate 匹配
├── 三级订阅分发：rawMessageListeners → messageHandlers → eventListeners
└── ConnectionSubscriptions（connection/）      # 引用计数订阅聚合

transport 层（可插拔）
├── daemon-client-websocket-transport.ts       # 直连（Node ws / RN / 浏览器三态）
├── daemon-client-relay-e2ee-transport.ts      # relay E2EE 包装
└── terminal-stream-router.ts                  # 二进制终端帧路由
```

## 调用链路

**SDK 一次调用的路径**（`client.agents.create({...})`）：

```
createPaseoClient({url}) in index.ts:468
└── new DaemonClient(clientType: "cli") + createPaseoApi(daemonClient)（:483）
    └── agents.create(config)
        ├── parseProviderModel() 拆 "provider/model"
        └── daemonClient.createAgent()（daemon-client.ts:2549）
            └── sendCorrelatedRequest()（:1758）
               → sendRequest() 把 predicate 挂进 this.waiters
               → （未连接时）进 pendingSendQueue
            ……
            ← deliverSessionMessage()（:6228）→ resolveWaiters()（:6295）
               按 predicate 匹配 requestId → resolve
```

**连接建立链**：`connect()`（`:1188`，幂等 + connectPromise 单飞）→ `attemptConnect()`（`:1209`）先 `disposeTransport()`（浏览器 close/error 顺序不定，重连前必须先销毁旧 transport）→ 选 transport factory → onOpen 发 `sendHelloMessage()`（`:5768`）→ 收到 daemon 的 `status`/`server_info` 才置 connected 并触发恢复：重置 reconnectAttempt、`subscriptions.restore()`、重订阅 checkout/terminal/file、`flushPendingSendQueue()`。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
| --- | --- | --- |
| `createPaseoClient()` | `index.ts:468` | SDK 入口，薄封装 DaemonClient |
| `connect()` / `close()` | `daemon-client.ts:1188` | 幂等连接（connectPromise 单飞） |
| `attemptConnect()` | `daemon-client.ts:1209` | 销毁旧 transport → 建新 → hello |
| `armReconnectTimer()` | `daemon-client.ts:6154` | 指数退避：min(1.5s × 2^attempt, 30s) |
| `sendCorrelatedRequest()` | `daemon-client.ts:1758` | RPC 关联等待（waiters + predicate） |
| `on(type, handler)` | `daemon-client.ts:1493` | 按 type 注册 messageHandler |
| `deliverSessionMessage()` | `daemon-client.ts:6228` | 入站分发中枢 + 恢复触发点 |
| `waitForFinish()` | `daemon-client.ts:5377` | 一次 `wait_for_finish_request` RPC 等终态 |
| `subscribeAgentTimeline()` | `daemon-client.ts:3061` | timeline 按需订阅（经 subscriptions 聚合） |
| `createWebSocketTransportFactory()` | `daemon-client-websocket-transport.ts:57` | 直连传输工厂 |

</details>

## 核心实现

### handle 工厂与 API 面

`createPaseoClient(config)` 返回 `PaseoClient = PaseoApi + connect/close/ensureConnected/getConnectionState`（`index.ts:468-481`）。API 面六组 handle，核心是 `createAgentHandleFactory()`（`index.ts:672`）：把 id 字符串或 snapshot 变成**有状态的 `PaseoAgentHandle`**——getter 读闭包里的 `current` 快照，daemon 推送即更新（SDK 不拥有 app 的缓存）。`agent.run()` = `send` + `waitForFinish`，默认 10 分钟超时（`DEFAULT_WAIT_FOR_FINISH_MS`，`index.ts:62` 注释解释：coding turn 常跑数分钟）。

### RPC 关联等待：不是轮询

`waitForFinish(agentId, timeout)`（`daemon-client.ts:5377`）是一次 `wait_for_finish_request` RPC——`sendCorrelatedRequest` 挂 waiter 等对应的 `wait_for_finish_response`，超时 +5s 兜底、`skipQueue: true`（不等连接队列）。对比 `waitForAgentUpsert()`（`:5272`）才是事件 + 250ms 轮询混合（`on("agent_update")` + `setInterval` 兜底防丢事件）——两种等待策略按语义区分。

### 三级订阅分发

入站 session 消息经 `handleTransportMessage` → `handleJsonPayload` → `handleSessionMessage` → `deliverSessionMessage` → `resolveWaiters()`（`:6295`）。监听者三级：`rawMessageListeners`（原始）→ 按 type 的 `messageHandlers`（`on(type, handler)`）→ `toEvent()` 转成带 entityId 的 `DaemonEvent` 给 `eventListeners`。provider snapshot 特殊路径：带 snapshotHash 无 compactSnapshot 时走 `providerSnapshotUpdates` 暂停/合并机制（`:6213`）。

### ConnectionSubscriptions：引用计数的需求聚合

`ConnectionSubscriptions`（`connection/index.ts:41`，注释 "Owns connection demand, independently of individual facades and React lifetimes"）是本包最精巧的设计：把"谁在看什么"聚合成 viewed 集合 ∪ timelines keys，**只向 daemon 发增量的 `agent.timeline.set_subscription.request`**；组件挂卸载不抖动 daemon 订阅状态；重连后 `restore()` 自动重建；带 `ready` promise 确认 daemon 已登记（否则不发 `timelineReplacementInvalidation` 会丢历史）。事件订阅同理经 `updateEventSubscriptions()`（`:3087`）——**只在有监听者时才让 daemon 推送**，空监听会 `providerSnapshotUpdates.clear()`。

### 传输抽象与双通道认证

`DaemonTransport` 接口（`daemon-client-transport-types.ts:8`）：send/close/onOpen/onClose/onError/onMessage，返回退订函数。`createWebSocketTransportFactory()` 包装 `WebSocketLike`——兼容 Node `ws`、React Native、浏览器三种事件 API。认证双通道：`Authorization: Bearer` header + WebSocket subprotocol `paseo.bearer.<password>`（`attemptConnect()`，`daemon-client.ts:1223-1229`）——后者供浏览器场景（无法设自定义 header）。

E2EE 切换：`config.e2ee.enabled === true && isRelayClientWebSocketUrl(url)` 时用 `createRelayE2eeTransportFactory()`（`daemon-client-relay-e2ee-transport.ts:17`）把 base factory 包一层 `@getpaseo/relay/e2ee` 的 `EncryptedChannel`（08 篇）。`config.transportFactory` 可整体注入（测试用）。

### 重连细节

指数退避 `min(base 1.5s × 2^attempt, 30s)`（`:927-928`）；`scheduleReconnect()`（`:6098`）统一清 waiters、挂起发送队列、ping 探针、terminal 槽。浏览器 `onerror` 常无细节且后随 close(1006)，generic error 延迟 250ms 让位给 close 详情（`:1310-1334` 注释）——平台差异在传输层吸收，上层只见统一的恢复语义。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| handle 工厂 + 闭包快照 | `createAgentHandleFactory()` in `index.ts:672` | 有状态对象不复制缓存，daemon 推送即更新 |
| 需求聚合（引用计数） | `ConnectionSubscriptions` in `connection/index.ts:41` | UI 生命周期抖动不传导到 daemon |
| 传输工厂注入 | `DaemonTransport` 接口 + `config.transportFactory` | 三平台事件 API 差异 + E2EE 包装 + 测试替换 |
| 单飞连接（connectPromise） | `connect()` in `daemon-client.ts:1188` | 并发 connect() 只建一条连接 |
| predicate 关联等待 | `resolveWaiters()` in `daemon-client.ts:6295` | requestId 匹配而非全局锁 |

## 模块间交互

- 下游：`@getpaseo/protocol` 的 schema 与类型；`@getpaseo/relay/e2ee`（relay 场景）；
- 上游：CLI 注入 Node ws 工厂（07 篇）；App 直接用 internal 的 `DaemonClient`（`app/src/contexts/session-context.tsx:32`）；Desktop 经 web app 间接使用；
- COMPAT 门控集中在此包（如 `selectiveAgentTimeline` 要求 v0.1.106+，`:3108` 注释 "Remove after 2027-01-12"）。

## 扩展方式

新增一个 SDK API：

1. `@getpaseo/protocol` 加 request/response schema（多数走 `${ns}.request`/`.response` 对，可自动走 `sendNamespacedCorrelatedSessionRequest`，`daemon-client.ts:1821`）；
2. `daemon-client.ts` 加 `async xxx(...)` 方法（`sendCorrelatedRequest` 内核）；旧 daemon 兼容时加 `lastServerInfoMessage?.features?.xxx` 门控（模仿 `listProviderUsage`，`index.ts:832-841` 的 COMPAT 模式）；
3. `index.ts` 加 type 别名 + 挂到对应 Actions 或新 handle（走 `createAgentHandleFactory` 类似的闭包工厂）；
4. 测试：`daemon-client.test.ts`（6,266 行）+ `index.test.ts`。

⚠️ 待核实：`daemon-client-runtime-metrics.ts`（liveness 心跳）与 `provider-snapshots/` 细节未逐行读；`waitForFinish` 服务端实现（阻塞回 vs 逐 turn 推送）需对照 server 包 `handleWaitForFinish()`。
