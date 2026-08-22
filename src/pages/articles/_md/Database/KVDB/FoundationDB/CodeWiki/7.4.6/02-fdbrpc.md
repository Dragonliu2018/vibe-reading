---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "RPC 与网络层"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "7.4.6"]
tags: ["FoundationDB", "C++", "RPC", "FlowTransport", "负载均衡", "模拟网络"]
description: "fdbrpc 模块——FoundationDB 的 RPC 与网络层，FlowTransport 连接复用 + Endpoint 寻址 + ReplyPromise/RequestStream + QueueModel 负载均衡 + Sim2 模拟网络。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/7.4.6/00-overview)

---

## 模块定位

`fdbrpc/` 是 FDB 的远程过程调用与网络通信层。它把"节点间通信"从业务逻辑中剥离：所有角色间的消息走 `FlowTransport` 统一通道，而非裸 socket。它同时承载负载均衡（`LoadBalance`）、多版本协议兼容、以及确定性模拟网络（`Sim2`）——后者让模拟测试只需替换 `INetworkConnections` 实现即可注入网络故障。

## 模块架构

fdbrpc 的核心抽象是 **Endpoint 寻址 + 消息接收器**：通信不再面向"连接+地址"，而是面向"端点 token"——发送方把消息序列化后投递到一个 token 标识的端点，接收方按 token 查表分发。这使得连接复用（多个端点共享一条 TCP）与故障检测（`FailureMonitor` 按端点追踪状态）成为内建能力。

- **FlowTransport**（`fdbrpc/include/fdbrpc/FlowTransport.h`）——传输层入口，全局单例（`g_network->global(enFlowTransport)`）。`TransportData` 持 `EndpointMap`（token→receiver）、`peers`（NetworkAddress→Peer）、`HealthMonitor`、`degraded` 降级标志、`incompatiblePeers`。
- **Peer**（`FlowTransport.h:127`）——一条到远端的连接管理：`unsent` 待发包队列、`reliable` 可靠投递列表、`dataToSend` 触发器、指数退避重连、ping 延迟统计。
- **Endpoint**（`FlowTransport.h:40`）——`NetworkAddressList addresses` + `Token token`（UID）。`WLTOKEN_*` 枚举提供预定义 well-known 端点（Ping、EndpointNotFound）。
- **ReplyPromise<T> / RequestStream<T>**（`fdbrpc/include/fdbrpc/fdbrpc.h`）——网络化 Promise/请求通道，底层 `NetSAV<T>`（继承 `SAV<T>` + `FlowReceiver`）。序列化即注册：`save()` 只写 token，`load()` 构造远端 Endpoint 并自动启动 `networkSender()` actor 把结果异步发回。`ReplyPromiseStream<T>`（`fdbrpc.h:280`）内置 `AcknowledgementReceiver` 实现 ACK 流控（`onReady` `fdbrpc.h:587`）。
- **loadBalance**（`fdbrpc/include/fdbrpc/LoadBalance.actor.h`）——负载均衡：基于 `QueueModel`（平滑未完成请求数 + 延迟 + penalty）选最优/次优并支持第二请求竞速（`secondMultiplier`/`secondBudget` 自适应预算 `:976`）。
- **Sim2**（`fdbrpc/sim2.actor.cpp:1053`）——模拟网络，是真实 `Net2` 的 Test Double：`Sim2Conn`（`:334`）用 `recvBuf` 模拟 TCP 缓冲，`SimClogging`（`:230`）模拟延迟/丢包/重排，`halfLatency`（`:317`）99.9% 快速 + 0.1% 长尾。

## 调用链路

一次 RPC 请求→连接选择→发送→回复：

```text
客户端 loadBalance(alternatives, &StorageServerInterface::getValue, req)  [LoadBalance.actor.h]
  ├─ QueueModel 遍历 alternatives：过滤 failed 节点，选 smoothOutstanding 最小为 bestAlt
  ├─ stream->tryGetReply(request)
  │   ├─ FlowTransport::sendUnreliable(SerializeSource<T>, endpoint, true)
  │   │   ├─ isLocalAddress? → sendLocal() 直接本地投递
  │   │   ├─ getOrOpenPeer(address) → 无则 new Peer + connectionKeeper(peer)
  │   │   └─ sendPacket()  [FlowTransport.actor.cpp:1944]
  │   │       ├─ PacketWriter 写 token + 序列化消息体
  │   │       ├─ XXH3_64bits 校验和（非 TLS）  [:1994]
  │   │       └─ peer->send() → unsent 队列 + dataToSend.trigger()
  │   └─ 等待回复或失败
  ├─ connectionWriter(peer) actor
  │   ├─ co_await dataToSend.onTrigger()  等待 unsent 非空
  │   └─ conn->write(unsent, MAX_PACKET_SEND_BYTES)  合并小包
  └─ choose: firstRequest 响应 / secondDelay 超时启动第二请求到次优

服务端 connectionReader()  [FlowTransport.actor.cpp:1463]
  ├─ conn->read() 读 ConnectPacket → 判断 protocolVersion compatible?  [:1474]
  └─ scanPackets()  [:1250]
      ├─ 校验 checksum（非 TLS）→ ArenaReader 反序列化 token
      └─ deliver()  [:1172]
          ├─ checkCompatible(peerCompatibilityPolicy, reader.protocolVersion())
          └─ receiver->receive(reader)  # NetSAV/NetNotifiedQueue 投递

回复: 服务端 req.reply.send(value) → NetSAV::send → networkSender() actor
      → FlowTransport::sendUnreliable(...) → 回到 sendPacket 路径发回客户端
      → 客户端 NetSAV::receive() → Future<T> 满足
```

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `FlowTransport::transport` | `FlowTransport.h` | 全局单例获取 |
| `FlowTransport::bind` | `FlowTransport.actor.cpp` | 绑定监听地址（服务端） |
| `sendUnreliable`/`sendReliable` | `FlowTransport.actor.cpp` | 发送消息（可靠/不可靠） |
| `connectionKeeper` | `FlowTransport.actor.cpp` | 维护 Peer 连接 |
| `connectionReader` | `FlowTransport.actor.cpp:1463` | 接收端读包并分发 |
| `deliver` | `FlowTransport.actor.cpp:1172` | 按 token 查表投递 |
| `scanPackets` | `FlowTransport.actor.cpp:1250` | 解析包 + checksum 校验 |
| `sendPacket` | `FlowTransport.actor.cpp:1944` | 序列化 + 计算 checksum |
| `checkCompatible` | `FlowTransport.actor.cpp:1136` | 按端点策略检查协议兼容 |
| `loadBalance` | `LoadBalance.actor.h` | QueueModel 自适应负载均衡 |
| `Sim2::runLoop`/`now` | `sim2.actor.cpp:1058` | 模拟器事件循环/虚拟时钟 |
| `Sim2Conn::write` | `sim2.actor.cpp:453` | 模拟连接数据传输 |
| `halfLatency` | `sim2.actor.cpp:317` | 延迟分布（快速+长尾） |
</details>

## 核心实现

### Endpoint — 消息寻址

`Endpoint`（`FlowTransport.h:40`）持 `NetworkAddressList addresses` + `Token token`。well-known 端点（`WLTOKEN_*`）用于全局预定义服务如 Ping、EndpointNotFound。这种 token 寻址让连接复用天然支持：多个端点共享同一 TCP，发送方只管"投给这个 token"。

### ReplyPromise / RequestStream — 网络化 Promise

`ReplyPromise<T>`（`fdbrpc.h`）底层是 `NetSAV<T>`，同时继承 `SAV<T>` 和 `FlowReceiver`。`receive()` 反序列化 `ErrorOr<EnsureTable<T>>` 并设置 Promise 值。**序列化即注册**：`save()` 只写 token；`load()` 构造远端 Endpoint 并启动 `networkSender()` actor 将 Future 结果异步发回。`RequestStream<T>` 是请求通道：`getReply()` 可靠至少一次、`tryGetReply()` 最多一次、`getReplyStream()` 流式。`ReplyPromiseStream<T>`（`fdbrpc.h:280`）内置 `AcknowledgementReceiver` 实现 2MB 信用窗口流控——服务端 `onReady()`（`:587`）等 `bytesSent - bytesAcknowledged < bytesLimit`，客户端析构发 `operation_obsolete`。`PublicRequestStream<T>` 要求 `T::verify()` 返回 true 才投递（`fdbrpc.h:705`），用于外部不可信请求。

### LoadBalance — 多策略负载均衡

`loadBalance`（`LoadBalance.actor.h`）基于 `QueueModel`：遍历 alternatives，用 `smoothOutstanding` + `latency` 选最优和次优；**第二请求竞速**——若第一请求超过 `secondMultiplier * nextTime + BASE_SECOND_REQUEST_TIME` 未回复，自动向次优节点发第二请求；`secondMultiplier`/`secondBudget` 自适应预算系统（`:976`）：成功时 multiplier 衰减 budget 增长，触发 second request 消耗 budget，避免无限制并行浪费。本地优先：`countBest()` 给同 DC 候选数，本地健康时跳过远程。

多层故障应对：`FailureMonitor` 过滤失败节点；`QueueModel::failedUntil` 对 `future_version` 错误节点指数退避跳过；`penalty > 1.0` 服务端请求减速；全故障时 `allAlternativesFailedDelay`（`:870`）等任意恢复，`numAttempts >= alternatives->size()` 后指数退避（`:950`）；`HealthMonitor` 追踪 `peerClosedHistory`，`tooManyConnectionsClosed` 时标记 failed 并设 `degraded=true`。

### Sim2 — 模拟网络 Test Double

`Sim2`（`sim2.actor.cpp:1053`）完整实现 `INetworkConnections`，是真实 `Net2` 的 Test Double。`Sim2Conn`（`:334`）用 `std::deque<uint8_t> recvBuf` 模拟 TCP 缓冲，`write()`（`:453`）直接拷入 peer 的 recvBuf，经 `sender`/`receiver` actor 模拟跨进程调度（`g_simulator->onProcess`）和网络延迟。`SimClogging`（`:230`）模拟网络分区：`clogPairFor`/`clogSendFor`/`clogRecvFor`/`disconnectPairFor`。`halfLatency`（`:317`）99.9% 走快速延迟（`MIN_NETWORK_LATENCY`~`FAST_NETWORK_LATENCY`），0.1% 走慢速长尾；同机 stable connection 延迟乘 0.1。`BUGGIFY` 在 `Sim2Conn::write`（`:429`）可限制写入量或随机大小，`scanPackets`（`:1293`）可翻转 bit 测试 checksum。`now()`（`:1058`）返回模拟时间，`delay()` 经 `TaskQueue` 调度非真实定时器；每模拟进程有独立 `global()` 变量空间（`:164`）。**关键**：生产代码和模拟代码共用同一通信路径，`Sim2` 只替换 `INetworkConnections` 实现即可注入网络故障。

### 多版本兼容

`ConnectPacket`（`FlowTransport.actor.cpp:534`）连接握手交换 `ProtocolVersion`+`canonicalRemotePort`+`connectionId`。三级兼容判定（`:1474`）：完全兼容正常处理；不兼容但 `hasInexpensiveMultiVersionClient()` 保持连接不解析后续包（兼容老客户端）；不兼容且非 inexpensive 则 hang up。`connectionId` 追踪多版本连接（`:1482`，`multiVersionConnections` 带超时清理 `:1752`）。**Stable Endpoints**：`PeerCompatibilityPolicy`（`FlowTransport.h:127`）允许每端点声明兼容需求，`PingReceiver` 声明 `RequirePeer::AtLeast, ProtocolVersion::withStableInterfaces()`（`:257`），`checkCompatible()` 在 `deliver()` 逐消息检查（`:1172`）。Flatbuffers 序列化（6.2 起）可加字段不 bump protocol version。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 负载均衡多策略 | `LoadBalance.actor.h` | QueueModel + 第二请求竞速 + 自适应预算 |
| 多版本兼容 | `FlowTransport.actor.cpp:534` ConnectPacket | 三级判定 + Stable Endpoints 支持滚动升级 |
| Test Double 模拟 | `Sim2` in `sim2.actor.cpp:1053` | 替换 I/O 即注入故障，生产代码零改动 |
| ReplyPromise 扩展 | `fdbrpc.h` | Promise 网络化，序列化即注册回链 |
| 失败检测 FailureMonitor | `FlowTransport.actor.cpp` | 按端点追踪状态，通知所有等待 actor |

## 模块间交互

flow → fdbrpc：`FlowTransport` 基于 `INetwork`，`connect/listen` 调 `g_network->connect/listen` → `Net2`。fdbclient/fdbserver → fdbrpc：客户端 `FlowTransport::createInstance(true)`（`isClient=true`），主动关闭空闲连接；服务端 `bind()` 监听，各角色 `RequestStream` 注册端点。`loadBalance(location->locations(), &StorageServerInterface::getValue, req)` 是客户端读请求的典型调用。`FailureMonitor` 在 `connectionKeeper` 失败时 `setStatus(address, FailureStatus(true))`，`loadBalance` 据此跳过故障节点。非 TLS 连接额外 XXH3-64 checksum 保护完整性（TLS 由 TLS 层保证）。

## 扩展方式

新增 RPC 消息类型：定义 request/reply struct（含 `ReplyPromise<T> reply` + `serialize`），在 interface 加 `RequestStream<GetFooRequest> getFoo`；服务端 `wait(getFoo.getFuture())` 处理后 `req.reply.send(...)`；客户端 `loadBalance(locations, &StorageServerInterface::getFoo, req)`。流式用 `ReplyPromiseStream<T>`，服务端发前 `wait(stream.onReady())` 做流控（`fdbrpc.h:587`）。公共接口用 `PublicRequestStream` 并实现 `verify()`（`fdbrpc.h:705`）。新增 well-known endpoint：在 `FlowTransport.h:40` enum 加 `WLTOKEN_*`，实现 `NetworkMessageReceiver` 子类调 `endpoints.insertWellKnown`（参考 `PingReceiver` `:248`）。调整负载均衡参数：改 `flow/Knobs.h` 的 `LOAD_BALANCE_*`/`INSTANT_SECOND_REQUEST_MULTIPLIER`/`BASE_SECOND_REQUEST_TIME` 等 knob。
