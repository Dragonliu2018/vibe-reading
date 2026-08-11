---
source:
  type: "源码解读"
  project: "multica"
  url: "https://github.com/multica-ai/multica"
title: "Realtime 实时推送"
date: "2026-08-11T20:31:27+08:00"
category: [AI, Agent, Team, Multica, CodeWiki, "0.3.28"]
tags: ["multica", "Go", "WebSocket", "Redis Stream", "Pub-Sub"]
description: "realtime 模块实现 WebSocket 事件 fanout——Hub 房间模型 + Redis 分片中继实现多节点广播，含 sharded/legacy/dual 三模式渐进迁移。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/00-overview)

---

## 模块定位

`server/internal/realtime/` 实现 WebSocket 实时推送——把 agent 执行进度、task 状态变更、issue 更新等事件实时推给前端。核心是 `Hub`（管理客户端 WS 连接、按 workspace 分房间 fanout）和 `Broadcaster` 接口（抽象本地投递 + Redis 跨节点中继）。当部署多节点 API server 时，Redis 分片中继（ShardedStreamRelay）让每个节点都能收到其他节点发出的事件。

这个模块独立存在因为**实时推送是独立关注点**——Service 层只管 `Bus.Publish` 事件，不关心谁监听；Realtime 订阅 bus 后转发给 WS 客户端。多节点扩展时只需切换 `Broadcaster` 实现（Hub → DualWriteBroadcaster），listener 代码零改动。

## 模块架构

模块围绕 `Broadcaster` interface（`broadcaster.go:23`）组织，有四个实现：

- **`*Hub`**（`hub.go`，1020 行）——单节点 WebSocket hub，连接管理 + scope 房间 + 认证 + 收发 pump
- **`*RedisRelay`**（`redis_relay.go`）——legacy per-scope stream 中继
- **`*ShardedStreamRelay`**（`sharded_stream_relay.go`）——固定分片 stream 中继（生产默认）
- **`*DualWriteBroadcaster`**（`redis_relay.go:502`）——本地快路径 + Redis 跨节点组合

五种 scope 路由域：`workspace`（按工作区 fanout）、`user`（个人定向）、`task`、`chat`、`daemon_runtime`（只给 daemon WS hub，不给浏览器）。

## 调用链路

事件从产生到推送客户端的完整链路：

```
Service 层产生事件
  └─ events.Bus.Publish(event)                    # internal/events/
       │
       ▼
registerListeners (cmd/server/listeners.go:24)    # bus → broadcaster 桥接
  ├─ personalEvents (inbox/invitation) → b.SendToUser(recipientID)
  ├─ member:added → b.SendToUser(uid, data, excludeWorkspace)
  └─ 其余 → bus.SubscribeAll → b.BroadcastToWorkspace(workspaceID, data)
       │
       ▼  broadcaster 实际类型（main.go:201-253 决定）
       │  无 Redis → *Hub（单节点）
       │  有 Redis → *DualWriteBroadcaster(hub, relay)
       │
       ▼  DualWriteBroadcaster.BroadcastToScope (redis_relay.go:521)
       ├─ ① id = ulid.Make() → frame = injectEventID(message, id)
       ├─ ② d.local.BroadcastToScopeDedup(scope, id, frame)   # 本地立即投递
       │     └─ client.markSeen(eventID) → 首次见则 client.send <- message
       │          └─ Client.writePump → conn.WriteMessage → 浏览器 WS onmessage
       └─ ③ d.relay.PublishWithID(scope, id, frame)           # 写 Redis Stream
            └─ XADD ws:relay:shard:N
                 ▼  其他 API 节点
                 ShardedStreamRelay.readShard (sharded_stream_relay.go:196)
                   └─ XREAD BLOCK → deliverEnvelope
                        ├─ ScopeDaemonRuntime → daemonRuntime.DeliverDaemonRuntime
                        ├─ ScopeUser → hub.fanoutUser
                        └─ default → hub.BroadcastToScopeDedup
                             └─ markSeen 去重（本地快路径已 markSeen，回环帧丢弃）
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计 |
|------|------|----------|----------|
| `Hub.Run` | `hub.go:267` | 事件循环 | register/unregister/broadcast 三路 select |
| `BroadcastToScopeDedup` | `hub.go:488` | 带 ULID 去重的 scope fanout | ring buffer 128 |
| `HandleWebSocket` | `hub.go:746` | HTTP→WS 升级 + 认证 | cookie JWT / firstMessageAuth |
| `handleSubscribe` | `hub.go:914` | 客户端动态订阅 | ScopeAuthorizer 鉴权 |
| `evictSlow` | `hub.go:609` | 慢客户端驱逐 | send chan 满则关闭 |
| `ShardedStreamRelay.readShard` | `sharded_stream_relay.go:196` | 读 Redis 分片 | XREAD BLOCK |
| `DualWriteBroadcaster.BroadcastToScope` | `redis_relay.go:521` | 本地+Redis 双写 | ULID 去重 |

</details>

## 核心实现

### Hub 房间模型——scope 路由

`Hub`（`hub.go`）维护 `rooms map[scopeKey]map[*Client]bool`——按 (scopeType, scopeID) 分房间。`scopeKey` 是 `{Type, ID}` 结构。客户端连接时自动 subscribe 自身 workspace + user scope；动态订阅 task/chat scope 需 `handleSubscribe`（`hub.go:914`）鉴权。

**五种 scope**：`workspace`（工作区 fanout）、`user`（个人定向，inbox/invitation）、`task`（per-task，暂未启用客户端订阅）、`chat`（per-chat）、`daemon_runtime`（只给 daemon WS hub，relay 收到后调 `DaemonRuntimeDeliverer.DeliverDaemonRuntime` 转交 daemonHub，不混入浏览器 fanout）。

### Redis 分片中继——为什么不用 per-scope stream

legacy `RedisRelay` 为每个 active scope 创建独立 stream + consumer，当 scope 数量（task/chat 实例）随用户增长时，Redis 阻塞连接数 = `active_scope_count × pod_count`，可能耗尽连接池。

`ShardedStreamRelay`（`sharded_stream_relay.go:65`）改为固定 N 个 shard stream（`ws:relay:shard:0`~`N-1`），连接数恒定 `8 × pod_count`。分片路由 `shardFor(scopeType, scopeID)` = FNV-32a hash → `hash % Shards`（`:188`），保证同一 scope 的事件总落同一 shard，顺序性有保障。每节点启动 `1 + Shards` 个 `readShard` goroutine（`XREAD BLOCK`），收到消息后 `deliverEnvelope` 本地过滤——hub.rooms 天然没有该 scope 就无人投递。

### DualWriteBroadcaster——本地快路径 + Redis 去重

`DualWriteBroadcaster`（`redis_relay.go:502`）不等 Redis round-trip：先本地 `BroadcastToScopeDedup` 立即投递，再异步 `PublishWithID` 写 Redis。同一 event id 被 `Client.markSeen`（`hub.go:239`）记录，Redis 回环帧到达时 `markSeen` 返回 false 自动丢弃。

**为什么**：单节点场景延迟 = 本地 chan 投递（微秒级），多节点场景才走 Redis。ULID event id 既是去重 key 也是跨节点一致性保证。

### sharded / legacy / dual 三模式渐进迁移

main.go（`:230-251`）通过 `REALTIME_RELAY_MODE` env 选择：

| 模式 | Stream 结构 | 消费方式 | 连接数 | 场景 |
|------|-------------|----------|--------|------|
| `sharded`（默认） | 固定 N 个 shard | `XREAD`（无 group/ack） | `shard_count × pods` | 生产目标态 |
| `legacy` | per-scope stream | `XREADGROUP` + consumer group + `XACK` | `active_scope_count × pods` | 兼容旧部署 |
| `dual` | sharded + legacy 双写 | 两套 reader | 两者并存 | 灰度验证 |

`MirroredRelay`（`relay_lifecycle.go:29`）包装 primary（sharded）+ mirror（legacy），用相同 event id 双写。`PublishWithID` 记录 `RedisMirrorDivergenceTotal` 指标，发现两 relay 投递不一致时告警。client 端 ULID 去重保证不重复投递。

### ScopeAuthorizer——动态订阅鉴权

`handleSubscribe`（`hub.go:914`）对 `task`/`chat` scope 做鉴权：调 `ScopeAuthorizer.AuthorizeScope(userID, workspaceID, scope, id)` 验证资源属于该 workspace。`workspace`/`user` scope 只允许匹配自身身份（隐式安全）。注释（`hub.go:36-39`）要求实现者缓存正向结果避免热路径 DB 压力。

### 慢客户端驱逐——背压策略

`evictSlow`（`hub.go:609`）：`client.send` chan（容量 256）满时直接关闭连接、清理 rooms、触发 `onLastSubscriber`。**为什么**：宁可断开慢客户端也不阻塞 Hub 事件循环。指标 `SlowEvictionsTotal` + `MessagesDroppedTotal` 可观测。

### daemonWS 与 client WS 分离

浏览器 WS（`realtime.Hub`）和守护进程 WS（`daemonws.Hub`）是完全独立的 Hub。daemon 连接是长生命周期的服务端推送（task 分配、心跳），语义和浏览器实时 UI 不同。daemon 事件通过 `ScopeDaemonRuntime` 路由，relay 收到后调 `DaemonRuntimeDeliverer.DeliverDaemonRuntime` 转交 daemonHub，不混入浏览器 fanout。`daemonws.RelayNotifier` 同样是 DualWrite 模式（local daemonHub + sharded relay），保证跨节点 daemon 唤醒。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 观察者 | `Hub.register/unregister` + `rooms` | Client 注册到 Hub，事件来时遍历 room fanout |
| 发布-订阅 | `events.Bus` → `registerListeners` → `Broadcaster` | Service 层 emit event 解耦 UI 推送 |
| 策略 | `Broadcaster` interface 四实现 | 运行时按 `REDIS_URL`/`REALTIME_RELAY_MODE` 选策略 |
| 桥接 | `DualWriteBroadcaster` = local Hub + RelayPublisher | 本地立即投递 + 跨节点 Redis 中继两维度组合 |
| 装饰器 | `MirroredRelay` 包装 primary + mirror | 灰度迁移双写验证 |
| 回调钩子 | `onFirstSubscriber`/`onLastSubscriber` | scope 0↔1 边界通知 relay 按需启停 consumer |

## 模块间交互

- **events bus → Broadcaster**：`registerListeners`（`listeners.go:24`）是唯一桥接点，`b` 参数类型是 `Broadcaster` interface 而非 `*Hub`——从单节点切 Redis relay 时 listener 零改动（MUL-1138 Phase 0 水平扩展计划）
- **handler → Hub/Bus**：`handler.New(..., hub, bus, ...)` 注入，handler 层通过 `bus.Publish` 发事件，不直接调 Broadcaster
- **daemonws → realtime**：`daemonws.RelayNotifier` import `realtime`，Redis 配置时 `relay.PublishWithID` 发布 `ScopeDaemonRuntime` 帧
- **relay → daemonws**：`sharded.SetDaemonRuntimeDeliverer(daemonHub)` 将 daemonHub 注入 relay，relay 收到 `ScopeDaemonRuntime` 帧时转交

## 扩展方式

新增一种事件类型（如 `agent:step_completed`）：`pkg/protocol/events.go` 加常量 → Service 层 `bus.Publish` → `listeners.go` 若是个人事件加 `bus.Subscribe` + `SendToUser`，workspace 事件无需改（`SubscribeAll` 自动覆盖）→ 若需 per-resource scope 路由在 `broadcaster.go` 加 scope 常量 + `handleSubscribe` 加鉴权分支。

调整分片数：设 `REALTIME_RELAY_SHARDS=16`（`main.go:62` 读取），无需改代码——`ShardedStreamRelayConfig.withDefaults()` 只在值 ≤ 0 时用默认。注意已有 stream 旧 shard 数据不会被新 reader 消费（hash 映射变了），需滚重启。
