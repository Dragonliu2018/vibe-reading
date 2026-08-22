---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "RPC 与网络层"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "main-2026-08"]
tags: ["FoundationDB", "C++", "RPC", "FlowTransport", "负载均衡", "模拟网络"]
description: "fdbrpc 模块——FoundationDB 的 RPC 与网络层，FlowTransport 连接复用 + Endpoint 寻址 + ReplyPromise/RequestStream + QueueModel 负载均衡 + Sim2 模拟网络。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`fdbrpc/`（~34k 行）是 FDB 的远程过程调用与网络通信层。它把"节点间通信"从业务逻辑中剥离：所有角色间的消息走 `FlowTransport` 统一通道，而非裸 socket。它同时承载负载均衡（`LoadBalance`）、多版本协议兼容、以及确定性模拟网络（`Sim2`）——后者让模拟测试只需替换 `INetworkConnections` 实现即可注入网络故障。

## 模块架构

fdbrpc 的核心抽象是 **Endpoint 寻址 + 消息接收器**：通信不再面向"连接+地址"，而是面向"端点 token"——发送方把消息序列化后投递到一个 token 标识的端点，接收方按 token 查表分发。这使得连接复用（多个端点共享一条 TCP）与故障检测（`FailureMonitor` 按端点追踪状态）成为内建能力。

核心组件：

- **FlowTransport**（`FlowTransport.h:200`）——传输层入口，全局单例（`g_network->global(enFlowTransport)`）。持有 `EndpointMap`（token→receiver）、`peers`（NetworkAddress→Peer 连接）、`HealthMonitor`、`degraded` 降级标志。
- **Peer**（`FlowTransport.h:150`）——一条到远端的连接管理：`unsent` 待发包队列、`reliable` 可靠投递列表、`dataToSend` 触发器、指数退避重连、ping 延迟统计。
- **ReplyPromise<T> / RequestStream<T>**（`fdbrpc.h:131` / `:730`）——网络化 Promise/请求通道，底层是 `NetSAV<T>`（继承 `SAV<T>` + `FlowReceiver`）。序列化即注册：`save()` 只写 token，`load()` 用 token 构造远端 Endpoint 并自动启动 `networkSender()` actor 把结果异步发回。
- **loadBalance / basicLoadBalance**（`LoadBalance.actor.h:308` / `:655`）——负载均衡：完整版基于 `QueueModel`（平滑未完成请求数 + 延迟 + penalty）选最优/次优并支持第二请求竞速；精简版按 `processBusyTime` 概率加权，用于 `alwaysFresh` 接口（如 GRV Proxy）。
- **Sim2**（`sim2.cpp:1021`）——模拟网络，是真实 `Net2` 的 Test Double：`Sim2Conn` 用 `std::deque<uint8_t>` 模拟 TCP 缓冲区，`SimClogging` 模拟延迟/丢包/重排，`rollRandomClose()` 0.001% 随机断连。

## 调用链路

一次 RPC 请求→连接选择→发送→回复：

```text
客户端 loadBalance(alternatives, &StorageServerInterface::getValue, req)  [LoadBalance.actor.h:308]
  ├─ QueueModel 遍历 alternatives：过滤 failed 节点，选 smoothOutstanding 最小为 bestAlt
  ├─ tryGetReply(request)  [fdbrpc.h:789]
  │   ├─ FlowTransport::sendUnreliable(SerializeSource<T>, endpoint, true)  [FlowTransport.cpp:2125]
  │   │   ├─ isLocalAddress? → sendLocal() 直接本地投递
  │   │   ├─ getOrOpenPeer(address) → 无则 new Peer + connectionKeeper(peer)
  │   │   └─ sendPacket()  [FlowTransport.cpp:1976]
  │   │       ├─ PacketWriter 写 token + 序列化消息体
  │   │       ├─ XXH3_64bits 校验和（非 TLS）
  │   │       └─ peer->send() → unsent 队列 + dataToSend.trigger()
  │   └─ waitValueOrSignal(...) 等待回复或失败
  ├─ connectionWriter(peer) actor  [FlowTransport.cpp:731]
  │   ├─ co_await dataToSend.onTrigger()  # 等待 unsent 非空
  │   └─ conn->write(unsent, MAX_PACKET_SEND_BYTES)  # 合并小包写出
  └─ choose: firstRequest 响应 / secondDelay 超时启动第二请求到次优

服务端 connectionReader()  [FlowTransport.cpp:1435]
  ├─ conn->read() 读 ConnectPacket → 判断 protocolVersion compatible?
  └─ scanPackets()  [FlowTransport.cpp:1260]
      ├─ 校验 checksum → ArenaReader 反序列化 token
      ├─ endpoints.getPriority(token) 查端点优先级
      └─ deliver()  [FlowTransport.cpp:1175]
          ├─ orderedDelay(0, priority) 切换优先级
          ├─ endpoints.get(token) → NetworkMessageReceiver*
          └─ receiver->receive(reader)  # NetSAV/NetNotifiedQueue 投递

回复: 服务端 req.reply.send(value) → NetSAV::send → networkSender() actor
      → FlowTransport::sendUnreliable(...) → 回到 sendPacket 路径发回客户端
      → 客户端 NetSAV::receive() → Future<T> 满足
```

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `FlowTransport::transport` | `FlowTransport.h:200` | 全局单例获取 |
| `FlowTransport::bind` | `FlowTransport.cpp` | 绑定监听地址（服务端） |
| `sendUnreliable` | `FlowTransport.cpp:2125` | 发送不可靠消息 |
| `sendReliable` | 同上 | 可靠投递（断连重发） |
| `connectionKeeper` | `FlowTransport.cpp` | 维护 Peer 连接的 actor |
| `connectionReader` | `FlowTransport.cpp:1435` | 接收端读包并分发 |
| `deliver` | `FlowTransport.cpp:1175` | 按 token 查表投递给 receiver |
| `loadBalanceImpl` | `LoadBalance.actor.h:308` | QueueModel 自适应负载均衡 |
| `basicLoadBalance` | `LoadBalance.actor.h:655` | 概率加权精简版 |
| `QueueModel::addRequest` | `QueueModel.h:76` | 记录未完成，返回 penalty |
</details>

## 核心实现

### Endpoint — 消息寻址

`Endpoint`（`FlowTransport.h:44`）持 `NetworkAddressList addresses` + `Token token`（16 字节 UID）。`TOKEN_STREAM_FLAG=1`（`FlowTransport.cpp:82`）：token 最低位标记是否流式端点——流式端点找不到时通知远端（用于清理远端状态），非流式静默丢弃。`wellKnownToken()` 提供预定义端点（Ping、EndpointNotFound）。这种 token 寻址让连接复用天然支持：多个端点共享同一 TCP，发送方只管"投给这个 token"。

### ReplyPromise / RequestStream — 网络化 Promise

`ReplyPromise<T>`（`fdbrpc.h:131`）底层是 `NetSAV<T>`，同时继承 `SAV<T>`（flow 的单值异步变量）和 `FlowReceiver`（网络消息接收器）。`receive()` 反序列化 `ErrorOr<EnsureTable<T>>` 并设置 Promise 值。**序列化即注册**：`save()` 只写 token；`load()` 用 `FlowTransport::loadedEndpoint(token)` 构造远端 Endpoint，并启动 `networkSender()` actor 将 Future 结果异步发回。

`RequestStream<T>`（`fdbrpc.h:730`）是请求通道，底层 `NetNotifiedQueue<T>`：`getReply()` 可靠至少一次、`tryGetReply()` 最多一次、`getReplyStream()` 流式。`ReplyPromiseStream<T>`（`:461`）内置 `AcknowledgementReceiver` 实现 2MB 信用窗口流控——服务端在 `onReady()` 中等待 `bytesSent - bytesAcknowledged < bytesLimit`。`PublicRequestStream<T>` 要求 `T::verify()` 返回 true 才投递，用于外部不可信请求。

### LoadBalance — 多策略负载均衡

`loadBalanceImpl`（`LoadBalance.actor.h:308`）基于 `QueueModel`：遍历 alternatives，用 `smoothOutstanding`（平滑未完成请求数）+ `latency` 选最优和次优；**第二请求竞速**——若第一请求超过 `secondMultiplier * nextTime + BASE_SECOND_REQUEST_TIME` 未回复，自动向次优节点发第二请求（`:422`）；`secondBudget` 限制频率防雪崩。本地优先：`countBest()` 给同 DC 候选数，本地健康时跳过远程。

多层故障应对：`FailureMonitor` 过滤失败节点；`QueueModel::failedUntil` 对返回 `future_version` 的节点指数退避跳过；`penalty > 1.0` 是服务端请求客户端减速；全故障时 `quorum(ok,1)` 等任意恢复，非 `alwaysFresh` 接口抛 `all_alternatives_failed` 让调用者刷新列表；`HealthMonitor` 追踪 `peerClosedHistory`，`tooManyConnectionsClosed` 时标记 failed 并设 `degraded=true`。`basicLoadBalance`（`:655`）用 `ModelInterface` 按 `processBusyTime` 概率加权，用于 `alwaysFresh` 接口。

### Sim2 — 模拟网络 Test Double

`Sim2`（`sim2.cpp:1021`）完整实现 `INetworkConnections`，是真实 `Net2` 的 Test Double。`Sim2Conn`（`:293`）用 `std::deque<uint8_t> recvBuf` 模拟 TCP 接收缓冲，sender/receiver 两个 actor 模拟双向传输+延迟。`SimClogging`（`:189`）模拟网络分区/延迟：`clogPairFor`/`disconnectPairFor`、`halfLatency()` 提供 99.9% 快速 + 0.1% 长尾。`rollRandomClose()`（`:541`）0.001% 随机断连测试容错。`INJECT_FAULT`（`:75`）按概率注入 io_timeout/io_error。`SimpleFile`（`:620`）模拟磁盘 I/O 延迟。

接入方式：`FlowTransport::createInstance()`（`:2174`）通过 `g_network->setGlobal()` 注册；`Sim2` 为每个模拟进程提供独立 `global()` 命名空间（`:130`），因此每个模拟进程有自己的 FlowTransport、FailureMonitor 实例。**关键**：生产代码和模拟代码共用同一通信路径，`Sim2` 只需替换 `INetworkConnections` 实现即可注入网络故障。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 负载均衡多策略 | `LoadBalance.actor.h:308`/`:655` | 不同接口特性适配（QueueModel vs 概率加权） |
| 多版本兼容 Adapter | `FlowTransport.cpp:546` ConnectPacket | 连接握手交换 ProtocolVersion，不兼容只响应 Ping |
| Test Double 模拟 | `Sim2` in `sim2.cpp:1021` | 替换 I/O 即注入故障，生产代码零改动 |
| ReplyPromise 扩展 | `fdbrpc.h:131` | Promise 网络化，序列化即注册回链 |
| 失败检测 FailureMonitor | `FlowTransport.cpp:625` | 按端点追踪状态，通知所有等待 actor |

## 模块间交互

flow → fdbrpc：`FlowTransport` 基于 `INetwork`，`connect/listen` 调 `g_network->connect/listen` → `Net2`。fdbclient/fdbserver → fdbrpc：客户端 `FlowTransport::createInstance(true,...)`（`isClient=true`，`NativeAPI.actor.cpp:889`），主动关闭空闲连接；服务端 `bind()`（`fdbserver.cpp:2040`）监听，各角色 `RequestStream` 注册端点。`loadBalance(location->locations(), &StorageServerInterface::getValue, req)` 是客户端读请求的典型调用。`FailureMonitor` 在 `connectionKeeper` 失败时 `setStatus(address, FailureStatus(true))`（`:949`），`loadBalance` 据此跳过故障节点。

## 扩展方式

新增 RPC 消息类型：在角色 interface（如 `StorageServerInterface.h`）定义 request/reply 结构体（含 `file_identifier`、`ReplyPromise<T> reply`、`serialize`），在 interface 加 `RequestStream<GetFooRequest> getFoo`；服务端 `wait(getFoo.getFuture())` 处理后 `req.reply.send(...)`；客户端 `loadBalance(locations, &StorageServerInterface::getFoo, req)`。流式回复用 `ReplyPromiseStream<T>`，服务端发前 `wait(stream.onReady())` 做流控（`fdbrpc.h:588`）。公共接口用 `PublicRequestStream` 并实现 `verify()`。
