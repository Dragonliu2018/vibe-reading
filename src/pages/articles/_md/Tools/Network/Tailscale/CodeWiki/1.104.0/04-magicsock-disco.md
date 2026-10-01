---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "disco 协议与路径选择"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "NAT 穿透", "disco", "协议设计"]
description: "magicsock 深度附件：disco 协议帧格式、加密方式、call-me-maybe 打洞时序与路径选择算法详解。"
readingTime: "15 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回 magicsock 模块](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/04-magicsock)

---

## 主题定位

disco 是 magicsock 用的 **peer 间路径发现协议**：在 WireGuard 会话之外，用独立的轻量密钥探测"我和对端之间哪条路能通、哪条最快"。本文展开 magicsock 模块中一笔带过的三件事：disco 消息的帧格式与加密、从互不知晓到直连确立的完整握手时序、发送时的路径选择算法（`addrForSendLocked`）。

## 核心原理

### 帧格式与加密

消息定义在 `disco/disco.go`：三种核心消息 `Ping`（携带我方 NodeKey + TxID）、`Pong`（携带 TxID + `Src`——对方看到的我的地址，即 NAT 公网映射）、`CallMeMaybe`（携带 `MyNumber`——我方全部端点清单）。disco 帧与 WireGuard 密文共用同一个 UDP socket，靠 magic 字节区分（`packetLooksLikeDisco` in `wgengine/magicsock/magicsock.go` 的接收分流）。

**disco 消息是加密的**——用 peer 间 ECDH 共享密钥做 NaCl box：

```go title="wgengine/magicsock/magicsock.go:2029 — sendDiscoMessage 加密"
// di.sharedKey 由本方 DiscoPrivate 与对方 DiscoPublic 的 ECDH 派生
di.sharedKey.Seal(m.AppendMarshal(nil))   // 发送侧
sharedKey.Open(...)                       // 接收侧 magicsock.go:2247
```

### 为什么自己造 disco 而不用 STUN+ICE

- **STUN 只回答"我的公网映射是什么"**，不携带身份与信任——disco 消息带加密认证，收到的 ping 一定来自持有该 disco key 的节点；
- **ICE 的 offer/answer 信令要靠额外通道**且角色协商重——disco 把路径发现消息直接混在 WireGuard 数据 socket 上（同一 UDP 端口，NAT 只需打一个洞），无需先建立 WireGuard 会话即可探测路径；
- **两层加密的分工**：WireGuard 层加数据面（密钥协商慢、会话过期），disco 层是轻量独立密钥（`RotateDiscoKey` 可单独轮换）——路径探测/保活流量不占用 WireGuard 会话状态，即使 WG key 失效也能继续维护路径。

### 为什么 call-me-maybe 必须经 DERP

直连尚未打通时，双方唯一**保证可达**的信道是各自常连的 home DERP（TCP 443，几乎不会被墙）。更关键的是时机：A 先向 B 发 disco ping（此刻 A 的 NAT 出站映射刚被"按摩"过、处于活跃窗口），**紧接着**把 `CallMeMaybe{A 的全部端点}` 经 DERP 发出——B 收到后立刻主动回连 A 的这些端点，成功率最高。这是"让对端主动连我"的定向触发器，而非 ICE 那种对称连通性检查。

## 实现细节

### 完整握手时序

![disco 打洞时序](/vibe-reading/images/articles/tailscale-codewiki/disco-sequence.svg)

代码对应（均已在 magicsock 模块列出，这里给出时序中每步的实现锚点）：

1. `sendDiscoPingsLocked`（`wgengine/magicsock/endpoint.go:1423`）向所有候选路径并发发 `disco.Ping`；
2. B 侧 `handlePingLocked`（`magicsock.go:2560`）→ `addCandidateEndpoint` 把 ping 源地址记为候选，回 `disco.Pong{TxID, Src}`；
3. A 侧 `enqueueCallMeMaybe`（`magicsock.go:2672`）先确认本地端点新鲜（`endpointsFreshEnoughDuration = 27s`，不新鲜则 `ReSTUN("refresh-for-peering")` 后重试）再发送；
4. B 侧 `handleCallMeMaybe`（`endpoint.go:2150`）把 `MyNumber` 中的新端点插入 `endpointState`，**清零所有 `lastPing`** 强制立即重 ping；
5. pong 汇合：`handlePongConnLocked`（`endpoint.go:1929`）记录 latency/pongSrc，`betterAddr`（`endpoint.go:2059`，延迟优先）比较后 `setBestAddrLocked` 换路并续期 `trustBestAddrUntil`。

### 路径选择算法

发送决策集中在 `addrForSendLocked`（`endpoint.go:635`）：

```
bestAddr 有效且未过 trustBestAddrUntil（6.5s）
  → 单路 UDP 直发（sendUDPBatch）
过期/无效
  → 返回 (bestAddr, derpAddr) 双路并发：UDP 与 DERP 各发一份
无任何地址
  → fallbackDERPRegionForPeer 兜底，否则 errNoUDPOrDERP
```

`bestAddr` 的信任不是一次性的：每次收到 pong 都续期（滚动 6.5 秒窗口），ping 超时未回则信任失效——降级到双发并重新 disco，恢复后收敛回单路。**宁可短期重复发包，也不因 NAT 映射 silently 失效而断流**。

peer relay 路径（v1.104）以 `epAddr{vni}` 形态（`endpoint.go:2026`，netip.AddrPort + Geneve VNI）参与同一状态机，不另设选路分支；wireguard-only peer（老版本对端）走 `addrForWireGuardSendLocked`（`endpoint.go:654`）按端点延迟选路。

## 性能与权衡

- **6.5s 信任期 + 双发**是核心权衡：信任期短则直连性能感知灵敏但 disco 噪声多；长则省流量但 NAT 失效后断流窗口大。6.5s 与常见 NAT UDP 映射超时（家用路由器 30s-数分钟）相比偏保守——配合 pong 滚动续期，活跃流量下几乎不降级。
- **pong 统计的 64 深环形缓冲**（`recentPongs`）取窗口内样本算延迟，防旧样本污染 `betterAddr` 判定；
- **DERP 反向路由优化**（`derpRoute`，Issue 150）：对方曾从非 home region 的 DERP 拨来，则记住该连接可反向复用，免去跨洋建连——DERP 侧带宽换延迟。
