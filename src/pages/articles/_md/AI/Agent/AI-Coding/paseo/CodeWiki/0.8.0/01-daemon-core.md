---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "Daemon 核心与会话"
date: "2026-09-17T23:52:35+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "WebSocket", "Session", "背压"]
description: "paseo daemon 核心与会话层——createPaseoDaemon 装配顺序、hello 握手与多物理 socket 共享逻辑 session、64 MiB 物理背压硬切、45s 应用层 lease、点分 RPC 责任链分发。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/server/src/server/` 的根部（`bootstrap.ts` 1,842 行 + `websocket-server.ts` 2,974 行 + `session.ts` ~7,000 行 + `websocket/`、`session/` 两个子目录）是 daemon 的"接客层"。它不管理 agent 进程（那是 AgentManager 的事），不落盘（那是 AgentStorage 的事）——它负责**把一个 TCP 端口变成一组有身份、有能力协商、有背压保护的客户端会话**，并把客户端 RPC 分发到各域实现。

这层的核心价值是回答三个问题：一条 WebSocket 连接如何变成有权限的会话（hello 握手 + principal）；一条慢连接如何不拖垮整个 daemon（物理 socket 背压硬切）；同一个用户开了三个 tab 又同时挂着 relay 时如何共享状态（逻辑 session 与物理 socket 分离）。

## 模块架构

```
bootstrap.ts                     # 装配入口 createPaseoDaemon()
├── express + mountWebUi()       # HTTP：web UI 静态托管 + /mcp/agents
├── AgentStorage                 # 文件持久化（先于 AgentManager 创建）
├── bootstrapWorkspaceRegistries()
├── AgentManager                 # agent 生命周期（见 02 篇）
├── VoiceAssistantWebSocketServer   # WS 服务（websocket-server.ts）
│   ├── pendingConnections       # 15s 内必须 hello
│   ├── Session（session.ts）    # 逻辑会话（可挂多个物理 socket）
│   │   └── session/<domain>/    # 域分发器（agent/checkout/workspace/...）
│   └── websocket/physical-socket.ts  # 背压 + 应用层 lease
├── relayRuntime（attachSocket 回调）  # relay 外部 socket 注入
└── hubRelationships             # Hub 出站关系
```

内部是"装配层 + 会话层 + 物理层"三段结构。`bootstrap.ts` 是唯一的组合根（composition root）——不用全局单例，所有依赖走构造器注入，`VoiceAssistantWebSocketServer` 的构造器接收 40+ 个依赖（`bootstrap.ts:1651-1720`），这让它可以在测试和 Hub 多租户场景下复用整套服务。

## 调用链路

**启动链**（`createPaseoDaemon` in `bootstrap.ts:568`，注意顺序里的两处刻意设计）：

```
createPaseoDaemon() in bootstrap.ts:568
├── express app + mountWebUi()                    # self-host web UI
├── createHTTPServer(app)（:847）
├── 注册 script proxy upgrade handler（:853）      # 必须先于 WS server 注册
├── new AgentStorage()（:859）
├── bootstrapWorkspaceRegistries()（:951）
├── new AgentManager()（:922）
├── httpServer.listen
├── new VoiceAssistantWebSocketServer(..., startPaused: true)（:1651）
├── pluginRuntime.start()
├── wsServer.beginAcceptingConnections()（:1723） # 半开防护：全部就绪才接客
├── createRelayRuntime()（:1724）                 # attachSocket → wsServer.attachExternalSocket
└── hubRelationships.start()
   # speech 延后到 listen 之后（:1763）——避免 Sherpa native 模型同步加载阻塞接客
```

**入站消息链**（一条客户端 RPC 的路径）：

```
ws "message" 事件
└─ handleRawMessage() in websocket-server.ts:2174
   ├─ applicationSocketLease.renew(ws)            # 任何入站活动续租
   ├─ 二进制帧 → maybeHandleBinaryFrame()         # 终端流走二进制 framing
   └─ JSON → WSInboundMessageSchema.safeParse()   # protocol 包的 zod 校验
      └─ 按顶层 envelope 分派（ping/pong/recording_state/session）
         └─ Session.handleMessage() in session.ts:1900
            └─ dispatchInboundMessage()（:1998）   # 责任链
               └─ dispatchXxxMessage()…           # 实现拆在 session/<domain>/
```

出站是事件驱动：AgentManager 产生 `agent_stream`/`agent_update` → Session 内的 agent-updates 控制器（`session/agent-updates/`）组装 → `sendToConnection` 对 `connection.sockets`（一个 Set）逐个广播。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
| --- | --- | --- |
| `createPaseoDaemon()` | `bootstrap.ts:568` | 唯一装配入口，返回 `PaseoDaemon`（start/stop/getListenTarget） |
| `beginAcceptingConnections()` | `websocket-server.ts:1723` 调用 | 解除 `startPaused`，开始接受升级请求 |
| `attachSocket()` | `websocket-server.ts:1239` | 物理 socket 入口（直连与 relay 共用） |
| `handleHello()` | `websocket-server.ts:1492` | 协议版本校验 + 会话键计算 |
| `resumeSession()` | `websocket-server.ts:1580` | 同键重连：新 socket 加入既有 Session 的 sockets 集合 |
| `handleRawMessage()` | `websocket-server.ts:2174` | 入站总入口：lease 续租 + 二进制/JSON 分流 |
| `dispatchSessionMessage()` | `websocket-server.ts:2267` | 路由到对应 Session |
| `handleMessage()` | `session.ts:1900` | Session 内分发 |
| `supports()` | `session.ts:1259` | capability 查询（wire 层只问这一句） |
| `closeAtOutboundHighWater()` | `websocket-server.ts:1188` | 背压硬切回调 |
| `sendMessageToSockets()` | `websocket-server.ts:1116` | 广播优化：先过滤再序列化一次 |

</details>

## 核心实现

### hello 握手与会话身份

物理 socket 升级后先进 `pendingConnections`，**15 秒内必须收到 hello**（`HELLO_TIMEOUT_MS = 15_000`，`websocket-server.ts:495`），否则关闭。`handleHello()` 校验三件事：

- `protocolVersion !== 1`（`WS_PROTOCOL_VERSION`，`websocket-server.ts:500`）→ close code 4401 协议不兼容；
- 非空 `clientId`（插件还校验保留前缀 `isPluginClientId`）；
- principal 鉴权（设备/服务凭证，见 `docs/permissions.md` 的 principal → grants 模型）。

会话键是 `sessionConnectionKey(principalId, clientId)`。同键再连走 `resumeSession()`——把新 ws 加入 `existing.sockets: Set`，这就是**多物理 socket 共享一个逻辑 session** 的机制：同一手机上三个 tab、或同时挂着直连 + relay 两条路，都落在同一个 Session 上，快照与 capability 不丢。没有专门的 welcome 消息，hello 被接受后直接回 `server_info`（`buildServerInfoStatusPayload` in `websocket-server.ts:1624`）。

capability 协商是双层的：hello 里的 `capabilities` 存入 Session（`updateClientCapabilities()` in `session.ts:1140`，断线重连时 rehydrate），wire 层任何地方只问一句 `session.supports(CLIENT_CAPS.xxx)`；服务端能力则经 `server_info` 的 `features.*` 一次性广播，每个 gate 带 `// COMPAT(name): remove after <日期>` 注释。全仓库 292 处 COMPAT 标记就是这套"capability gate 而非版本分支"策略的执行痕迹。

### 背压：物理 socket 硬切

背压实现在 `websocket/physical-socket.ts`：

```typescript title="websocket/physical-socket.ts"
export const MAX_PHYSICAL_SOCKET_BUFFERED_BYTES = 64 * 1024 * 1024;  // 64 MiB
export const APPLICATION_SOCKET_LEASE_MS = 45_000;

export function physicalSocketHasCapacity(socket, frameBytes) {
  return socket.bufferedAmount + frameBytes <= MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;
}
```

发送前检查 `bufferedAmount + frameBytes`，超限触发 `closeAtOutboundHighWater()`（`websocket-server.ts:1188`）→ `closePhysicalSocket()`（`:1199`）**只 `terminate()` 该物理 socket**，不影响同 session 的其他 socket——这就是物理/逻辑分离在背压上的收益：慢的是那一条 TCP 连接，不是那个用户。

> ⚠️ 事实核查：`docs/architecture.md` 写的是 "8 MiB outbound high-water mark"，与 v0.8.0 代码不符——`physical-socket.ts:4` 是 64 MiB（terminal 软背压 4 MiB、批帧 256 KB 的数值则与文档一致）。文档疑似过期，以代码为准。

广播路径有个序列化优化（`sendMessageToSockets` in `websocket-server.ts:1116`）：先过滤掉已达限的 socket，再**序列化一次**，然后逐 socket 精确字节校验——避免对 N 个 socket 序列化 N 次。

relay 侧的 `websocket/encrypted-relay-socket.ts:62` 复用同一 64 MiB 上限，保证直连与加密中继两条路的背压行为一致。

### 应用层 liveness lease

客户端活性检测不用 RFC6455 控制帧，而是**应用层 JSON `ping`/`pong`**（客户端每 10s 一次）。`ApplicationSocketLease`（`physical-socket.ts:12`）是租约表：首个应用层 ping `claim`（占下 socket 的所有权），后续**任何**入站活动 `renew`，租期 45s（容忍 4 个 ping 周期的丢失）；`startApplicationSocketLeaseInterval()`（`websocket-server.ts:837`）每 10s 扫描过期项强杀。

设计上的巧处：从不发 ping 的 legacy socket 永远不进入租约表，**不会被误杀**；而 session RPC 超时是操作失败，不会被误判为 socket 死亡（两种失败语义分离）。

### 域分发责任链

`Session`（`session.ts:657`，~7,000 行单体类）的 `dispatchInboundMessage()` 是一条 `dispatchXxxMessage` 责任链（链首依次是 voice/control、agent rewind、agent relationship、agent timeline、hub execution 等，域实现拆在 `session/<domain>/` 子目录——`session/agent-config/`、`session/checkout/`（如 `checkout-session.ts`）、`session/git-mutation/`、`session/schedule/`、`session/voice/` 等）。错误语义双轨：授权失败回 rpc_error `code: "access_denied"`，handler 抛错回 `code: "handler_error"`（`handleMessage()` in `session.ts`，用 `inflightRequests++`/finally `--` 维护并发计数）。两处可观测性细节：普通 session 请求超过 `SLOW_REQUEST_THRESHOLD_MS = 500` 打 `ws_slow_request` 告警；daemon 密码认证失败用 `WS_CLOSE_DAEMON_AUTH_FAILED = 4401` 关闭 socket（`attachAuthenticatedSocket()`，reason 区分 "Password required" 与 "Incorrect password"）。

`startPaused: true` 的语义也有个细节：`beginAcceptingConnections()` 之前 `verifyWsUpgrade` 对升级请求返回 **503 "Server not ready"**——启动期半开连接拿到明确拒绝而非挂死。新增一个 RPC 只需：protocol 包加 schema → 域分发器加分支 → 需要旧客户端探测时在 `server_info` 加 feature gate。bootstrap 与背压路径完全不用动。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 组合根 + 构造器注入 | `createPaseoDaemon()` in `bootstrap.ts:568` | 无全局单例，测试与 Hub 多租户可整套装配 |
| 两态连接（pending/active） | `pendingConnections` + `attachSocket()` | 半开连接在超时前不占 Session 资源 |
| 闭包回调解循环依赖 | `createSessionConnection()` in `websocket-server.ts:1305` | Session 构造期无法引用 connection，用 `let connection` 闭包捕获 `onMessage` 回调 |
| 责任链 | `dispatchInboundMessage()` in `session.ts:1998` | 域分发按需扩展，新域不改核心 |
| 租约（lease） | `ApplicationSocketLease` in `physical-socket.ts:12` | liveness 与 RPC 超时语义分离 |
| 内建 metrics | `startRuntimeMetricsInterval()` in `websocket-server.ts:827` | eventLoopDelay 分位数是"daemon 是否忙"的 ground truth（终端帧与 agent 流量共享同一事件循环） |

## 模块间交互

- **AgentManager**：经事件流喂 Session（`agent_stream`/`agent_update`），反向经 `agentRequests`；持久化由 `attachAgentStoragePersistence()`（`bootstrap.ts:944`）桥接。
- **Relay**：是"外部 socket 源"——`attachExternalSocket()`（`websocket-server.ts:966`）接收带 `ExternalSocketMetadata.transport: "relay"|"hub"` 标记的 socket，之后与直连 socket 走完全相同的会话/背压路径。
- **Hub**：走 `hubRelationships` + `SessionAdmission`（principalId/permissions），实现非 owner 的授权访问。
- graphify AST 图（37,352 条边）显示本层扇入最高的节点：`Session`（275 边）、`createPaseoDaemon()`（107 边）、`VoiceAssistantWebSocketServer`（99 边）——是整个 server 包被依赖最多的三个对象之二。

## 扩展方式

新增一个 session RPC 的完整改动面：

1. `packages/protocol/src/messages.ts`：定义 request/response schema（点分名 `domain.namespace.verb.request`，参数平铺，response 数据放 `payload`，两边带 `requestId`）；
2. `session/<domain>/` 域分发器加分支（或新建域目录）；
3. 需要旧客户端探测时：`buildServerInfoStatusPayload()` 加 `features.*` gate + COMPAT 注释；
4. 客户端侧 `packages/client` 加对应方法与调用；
5. 测试：对应 `session/*.test.ts` / `wire-compat.test.ts`。

无需改 bootstrap、握手或背压路径——这正是责任链 + capability gate 设计的扩展收益。
