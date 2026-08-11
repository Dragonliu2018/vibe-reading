---
source:
  type: "源码解读"
  project: "multica"
  url: "https://github.com/multica-ai/multica"
title: "Integrations"
date: "2026-08-11T20:31:27+08:00"
category: [AI, Agent, Team, Multica, CodeWiki, "0.3.28"]
tags: ["multica", "Go", "Lark", "WebSocket", "Lease", "Adapter"]
description: "integrations 模块用 channel 抽象层 + lark 适配器实现飞书集成——WS 长连接 lease 管理、两阶段幂等去重、ACK 与 reply 解耦。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/00-overview)

---

## 模块定位

`server/internal/integrations/` 是 Multica 的 IM 平台集成层。`channel/` 是平台无关的抽象契约（pure package，无 DB/network 依赖），`lark/` 是飞书/Lark 的全功能适配器实现。通过 Lark WS 长连接，用户可以在飞书群里 @bot 触发 agent 执行、创建 issue、对话——把 Multica 的工作流延伸到 IM 平台。

> **注意**：GitHub 集成（issue/repo 同步、installation webhook）不在 `integrations/` 目录下——它在 `server/internal/handler/github.go`，是 HTTP handler 层的 webhook + REST API 集成，不走 `channel.Channel` 抽象。`channel/` 的 `doc.go` 明确限定其范围为"inbound IM integrations (Feishu/Lark, Slack, WeCom, …)"。

这个模块独立存在因为**IM 平台协议差异大**（飞书 WS 长连接 + protobuf、Slack webhook、企微回调），需要适配器层隔离；且 WS 长连接的 lease 管理、多副本安全、ACK 时效约束是独立于 HTTP handler 的复杂问题域。

## 模块架构

两层结构——`channel/` 泛化基础层 + `lark/` 唯一具体实现：

- **`channel/`**（5 文件）——`Channel` interface（`Type/Connect/Disconnect/Send/Capabilities`）+ `Registry`（Type→Factory map）+ `Capability` 位掩码 + 标准化 `InboundMessage`/`OutboundMessage` 信封
- **`lark/`**（39 文件）——`Hub`（per-installation supervisor + lease）+ `Dispatcher`（inbound 事件处理 pipeline）+ `WSLongConnConnector`（飞书 WS 长连接）+ `InstallationService`（凭证加密存储）

代码处于 `lark_*` → `channel_*` 表迁移过渡期（MUL-3515），`channel_store.go` 将 feishu-specific 数据折叠到 `channel_*` 表的 JSONB config。

## 调用链路

Lark WS 事件 inbound 主链路（飞书消息 → 解析 → 创建 issue/入队 task → ACK）：

```
Lark Open Platform Server
  │  WebSocket binary Frame (protobuf)
  ▼
WSLongConnConnector.Run()                       [ws_connector.go:190]
  ├─ CredentialsProvider.Credentials(inst)
  ├─ EndpointFetcher.Endpoint(creds)            [ws_endpoint.go:119]  # POST /callback/ws/endpoint
  ├─ Dialer.DialContext(wss URL)
  │
  │  read loop:
  │  conn.ReadMessage() → binary frame
  │  ├─ [ping] → writeFrame(NewPongFrame)
  │  ├─ [chunk] → assembler.admit() → 不完整则 continue
  │  ├─ FrameDecoder.Decode(payload, inst)      # → InboundMessage | drop
  │  ├─ Enricher.Enrich(ctx, msg, creds)        # 展开引用消息/转发包
  │  └─ emit(ctx, msg) → Hub.handleEvent()      [hub.go:763]
  │       ├─ Dispatcher.Handle(ctx, msg)        [dispatcher.go:315]
  │       │    1. GetLarkInstallationByAppID
  │       │    2. ClaimLarkInboundDedup          # 两阶段幂等 claim
  │       │    3. Group filter (@bot?)
  │       │    4. GetLarkUserBindingByOpenID + IsWorkspaceMember
  │       │    5. EnsureChatSession
  │       │    6. AppendUserMessage + in-tx Mark  # 事务内 finalize dedup
  │       │    7. /issue command (if present)    # 创建 issue
  │       │    8. scheduleRun (debounced 3s)     # 入队 agent task
  │       │         └─ pendingBatcher.Schedule → flushChatRun → EnqueueChatTask
  │       ├─ typingIndicator.Add() (detached)
  │       └─ scheduleReply() (detached goroutine)  # binding card / offline notice
  │
  │  writeFrame(NewAckFrame(frame, success))    # ACK 200/500，严格 < 3s
  │
Hub.supervise() loop                            [hub.go:514]
  ├─ acquireLease (CAS)                          # 多副本安全
  ├─ factory(inst) → connector
  ├─ renewLeaseUntil (parallel goroutine)
  ├─ conn.Run(runCtx, inst, emit)
  └─ on exit: releaseLease + backoff + retry
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计 |
|------|------|----------|----------|
| `Hub.Run` | `hub.go` | 启动所有 installation supervisor | per-installation goroutine |
| `Hub.supervise` | `hub.go:514` | 单 installation 生命周期 | lease + backoff retry |
| `WSLongConnConnector.Run` | `ws_connector.go:190` | 飞书 WS 长连接 | chunk assembler + ACK |
| `Dispatcher.Handle` | `dispatcher.go:315` | inbound 事件 pipeline | 两阶段 dedup |
| `scheduleRun` | `dispatcher.go:615` | debounce run trigger | 3s 静默窗口 |
| `acquireLease` | `hub.go:642` | 多副本 lease | CAS + TTL 90s |
| `maybeRestartOnRotation` | `hub.go:433` | 凭证轮换检测 | fingerprint 比对 |

</details>

## 核心实现

### Lark WS 长连接 Lease 管理——多副本安全

多个 server replica 同时运行时，必须保证每个 installation 只有一个 replica 消费 WS 事件，否则重复处理。

`acquireLease`（`hub.go:642`）用 DB 层 CAS lease（`AcquireLarkWSLease` 的 WHERE 匹配现有 token 或已过期 lease），TTL 90s，续租间隔 30s。续租失败时立即 cancel connector 的 runCtx，通过 watchdog goroutine 关闭 WebSocket 打破阻塞的 `ReadMessage`。

**per-supervisor token**：`leaseToken(nodeID, gen)`（`hub.go:487`）——同一 Hub 内的 rotation 路径（re-scan 创建新 bot）每个 supervisor 实例有独立 token，防止旧 supervisor 的 release 误删新 supervisor 的 lease。

### 两阶段幂等去重 + Owner Fencing

`Dispatcher.Handle`（`dispatcher.go:315-394`）的两阶段 claim：

1. `ClaimLarkInboundDedup`（acquire）——pipeline 开始获取 claim_token
2. `MarkLarkInboundDedupProcessed`（finalize）——durable 副作用发生后 token-fenced 写入；或 `ReleaseLarkInboundDedup`（rollback）infra 错误时 token-fenced 回滚

**关键**：`AppendUserMessage` 在**同一事务内**执行 Mark——"the durable write and the Mark commit atomically"，关闭"crash between commit and Mark"窗口。stale-reclaim 旋转 token 使旧 holder 的 finalize 操作无效（zero rows → no-op）。

**为什么**：WS 重连可能重放同一事件；多 worker 可能竞争同一消息。需保证(a)不重复处理，(b)处理失败时不永久吞掉消息。

### ACK 路径与 Reply 解耦

Lark 长连接服务器要求 3 秒内 ACK 每个 data frame。如果 outbound reply（binding card、offline notice）的 HTTP 调用阻塞 ACK，超过 3s 后 Lark 认为事件未 ACK 并重推，但 dedup 行已 terminal，重推被丢弃，用户永远收不到 binding prompt。

**解决方案**（`hub.go:763-835`）：dispatch 同步执行（快速，一次 DB 往返），reply **detach 到独立 goroutine**，使用 fresh `context.Background()` + `ReplyTimeout`（2.5s，严格 < 3s）。`Hub.Wait` 通过 `replyWg` join in-flight replies。

### Installation 多租户隔离

`InstallationService.GetInWorkspace`（`installation.go:110`）防止伪造的 installation_id 跨 workspace 访问——"一个来自其他 workspace 的伪造 installation_id 返回 NotFound 而不是泄露存在性"。

**Region 隔离**：Feishu（mainland, `open.feishu.cn`）和 Lark（international, `open.larksuite.com`）是不同云，通过 per-installation 的 `Region` 字段解析 host，而非 deployment-wide env var——"一个 Multica deployment 同时服务两个云"。

**app_secret 加密**：`NewInstallationService`（`installation.go:46`）拒绝 nil secretbox，强制 at-rest 加密——"we refuse to fall back to plaintext storage even in test or dev configurations"。

### Credentials Rotation 检测

`maybeRestartOnRotation`（`hub.go:433`）+ `installationFingerprint`（`hub.go:501`）。device-flow re-scan 会创建新 bot（新 app_id/app_secret）。`installationFingerprint` = `app_id|bot_open_id|region|sha256(app_secret_encrypted)`，每次 sweep 比较当前行与启动时 fingerprint，不匹配则 cancel 旧 supervisor + 启新 supervisor。使用 encrypted ciphertext 的 hash（不触碰明文）。

### Debounce Run Trigger

`scheduleRun`（`dispatcher.go:615`）+ `pendingBatcher`：用户转发一个 transcript 然后打一条笔记，会在同一 session 产生多条消息，不应每条触发一次 agent run。3 秒静默窗口（`DefaultChatRunBatchWindow`），per-session keyed，窗口内最新 sender 的 flush 闭包 wins。`FlushPendingRuns` 在 graceful shutdown 时 drain。chat_message 行已同步持久化，debounce 的只是 run trigger。

### Cutover 控制开关

`MULTICA_LARK_HUB_DISABLED=true`（`main.go:382-396`）在不关闭 API 的情况下停掉 inbound hub。Rollout 流程：(1) 旧 build 设 DISABLE 停旧 hub → (2) 跑 migration 124 → (3) 新 build 保持 DISABLE 直到旧 pod 排空 → (4) 关掉 DISABLE 启动新 hub。确保新旧 hub 不会同时处理同一个 bot。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 适配器 | `channel.Channel` interface + `lark/` 全包 | `WSLongConnConnector` 把 Lark protobuf Frame 翻译为标准 `InboundMessage`，core 永不读平台 JSON |
| 注册表 | `channel/registry.go` `Registry` | 新增平台只需 `Register(type, factory)`，不改 core |
| 策略 | `WSConnectorConfig` 各 interface（EndpointFetcher/FrameDecoder/Enricher/CredentialsProvider） | 解码/扩展策略可替换 |
| 观察者 | `Patcher.Register(bus)` in `outbound.go:260` | 订阅 `EventChatDone`/`EventTaskFailed` 推送 Lark 消息 |
| 两阶段提交 + 幂等去重 | `Dispatcher.Handle` | Claim → 处理 → Mark/Release，token-fenced |
| Supervisor | `hub.go:514` `supervise` | per-installation goroutine 管理 lease→run→renew→backoff 全生命周期 |

## 模块间交互

- **lark → service 层**：`Dispatcher` 通过 `IssueCreator` interface 调 `IssueService.Create`（`/issue` 命令创建 issue），通过 `ChatTaskEnqueuer` interface 调 `TaskService.EnqueueChatTask`——`doc.go` 明确"this package never calls qtx.CreateIssue directly"
- **lark → events bus**：inbound `RegistrationService.SetEventBus` 发布 `lark_installation:created`；outbound `Patcher.Register(bus)` 订阅 `EventChatDone`/`EventTaskFailed` 推 Lark 消息
- **LarkHub 装配**：`router.go:281` `lark.NewHub(cs, connectorFactory, dispatcher, lark.HubConfig{})`；`main.go:399` `go h.LarkHub.Run(sweepCtx)`；`main.go:482` 优雅关闭 `WaitWithTimeout`
- **GitHub 集成独立**：`handler/github.go` 实现 webhook + REST，不走 `channel.Channel` 抽象

## 扩展方式

新增一种 IM 集成（如 Slack）：`channel/channel.go` 加 `TypeSlack` 常量 → 新建 `server/internal/integrations/slack/` 包实现 `channel.Channel` interface + inbound 适配器（参照 `lark/ws_connector.go`）+ `channel.Factory` → `router.go` 启动时 `registry.Register(channel.TypeSlack, slackFactory)` → `channel_installation` 表的 `channel_type` 列已支持任意 string，无需 schema 变更。

新增一种 Lark 事件（如 card interaction click）：`ws_frame_decoder.go` `Decode` 方法加 `event_type` 解析分支 → 产出 `InboundMessage`（ok=true）或 drop（ok=false）→ 如需新 outbound reply 在 `outcome_replier.go` `Reply` 加 `Outcome` 分支。
