---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "magicsock NAT 穿透"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "Go", "NAT 穿透", "UDP"]
description: "magicsock 传输层：多路径选路、disco 探测、call-me-maybe 打洞与 DERP 兜底的实现解读。"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)
>
> disco 协议与路径选择的逐帧细节见深度附件：[disco 协议与路径选择](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/04-magicsock-disco)

---

## 模块定位

`wgengine/magicsock/`（约 18,700 行）是用户态 WireGuard 的传输层，也是 Tailscale 最著名的核心创新：每个 peer 的加密流量经 magicsock 的 UDP socket 发送，**自动在多条候选路径（直连 UDP 各端点、DERP 中继、v1.104 新增的 UDP peer relay）之间选择可用路径**，实现 NAT 穿透与连接保活。它以 `conn.Bind` 身份嵌在 wireguard-go 之下（见 [wgengine 模块](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/03-wgengine)的"Bind 替换"），对 WireGuard 完全透明。

核心文件：`magicsock.go`（4,663 行，Conn 主体）、`endpoint.go`（2,327 行，单 peer 状态机）、`derp.go`（DERP 连接管理）、`relaymanager.go`（peer relay）、`peermap.go`；disco 消息定义在顶层 `disco/disco.go`。

## 模块架构

两层结构：`Conn`（每进程一个，持有 socket 与全局索引）与 `endpoint`（每 peer 一个，路径状态机）。

```go title="wgengine/magicsock/magicsock.go:158 — Conn 关键字段"
pconn4, pconn6 RebindingUDPConn      // 可换绑的 UDP socket（v4/v6）
netMon  *netmon.Monitor              // 网络状态监控（触发 rebind）
peerMap peerMap                       // nodeKey/discoKey/epAddr → endpoint 三重索引
netChecker *netcheck.Client           // STUN 探测本地 NAT/端点
activeDerp map[DERPRegionID]activeDerp // 各 region 的 DERP 长连接
derpRoute  map[key.NodePublic]derpRoute // 反向路由优化（Issue 150）
relayManager relayManager             // UDP peer relay 路径管理（v1.104 新增）
```

```go title="wgengine/magicsock/endpoint.go:60 — endpoint 关键字段"
bestAddr addrQuality                  // 最优直连地址 + 延迟 + wireMTU
trustBestAddrUntil mono.Time          // 信任期（trustUDPAddrDuration = 6.5s, magicsock.go:4082）
derpAddr                             // fallback 路径
endpointState map[netip.AddrPort]*endpointState // 每条候选路径：lastPing/recentPongs(64 深)/callMeMaybeTime
sentPing map[stun.TxID]sentPing       // 在途 disco ping
```

`peerMap`（`peermap.go:38`）以 `byNodeKey/byEpAddr/byNodeID/nodesOfDisco` 四张索引维护 peer 全集，无锁、须持 `Conn.mu`；`setNodeKeyForEpAddr` 在收到 ping 时急速建立 ip:port→node 映射加速发现。

## 调用链路

连接建立全链路（新 peer 从 netmap 到可通信）：

```
Conn.SetNetworkMap → upsertPeerLocked (magicsock.go:3216)
  └─ endpoint.updateFromNode → setEndpointsLocked (endpoint.go:1762)   netmap 端点入候选
首个数据包触发发现: endpoint.send (endpoint.go:1107) → addrForSendLocked (endpoint.go:635)
  ├─ bestAddr 有效且在信任期 → 直发 UDP
  └─ 否则返回 (bestAddr, derpAddr) 双路并发
同时 sendDiscoPingsLocked (endpoint.go:1423)
  └─ 向所有候选路径发 disco Ping（startDiscoPingLocked → sendDiscoPing）
go enqueueCallMeMaybe(derpAddr, de) (magicsock.go:2672)
  └─ 确认本地端点新鲜（27s 阈值，否则 ReSTUN）→ disco.CallMeMaybe{MyNumber: eps} 经 home DERP 发出
对端: handleDiscoMessage → handlePingLocked (magicsock.go:2560)
  └─ addCandidateEndpoint 记录 ping 源为候选 → 回 disco.Pong{TxID, Src}
  └─ handleCallMeMaybe (endpoint.go:2150): 插入新端点 + 清零所有 lastPing 强制重 ping
pong 回来: handlePongConnLocked (endpoint.go:1929)
  └─ betterAddr (endpoint.go:2059) 比较 → setBestAddrLocked 换路 + 续期信任期
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `addrForSendLocked` in `endpoint.go:635` | 发送时选路 | 信任期内单路，否则 UDP+DERP 双发 |
| `sendDiscoPingsLocked` in `endpoint.go:1423` | 全路径探测 | 向所有候选端点并发 ping |
| `enqueueCallMeMaybe` in `magicsock.go:2672` | 经 DERP 发端点清单 | 紧跟出站 ping 后 NAT 映射最活跃 |
| `handlePongConnLocked` in `endpoint.go:1929` | pong 处理与选路 | betterAddr 延迟优先 |
| `Rebind` in `magicsock.go:3875` | 网络切换换 socket | 原子换绑 + resetEndpointStates |
| `derpWriteChanForRegion` in `derp.go:339` | DERP 写队列选择 | derpRoute 反向复用免跨洋建连 |

</details>

## 核心实现

### send 与双发保险

`endpoint.send`（endpoint.go:1107）调 `addrForSendLocked`：`bestAddr` 有效且未过 `trustBestAddrUntil` → 单路 UDP 直发；过期或无效 → `sendAddr` 同时向 UDP 与 DERP 各发一份（`sendAddr` in `magicsock.go:1679`，目标是 `DerpMagicIPAddr` 则经 `derpWriteChanForRegion` 异步入队）。**宁可短期双发，也不因 NAT 映射 silently 失效而断流**；pong 恢复后自动收敛回单路。

### DERP fallback 的三层复用

`derpWriteChanForRegion`（derp.go:339）优先复用该 region 的 `activeDerp` 连接；否则查 `derpRoute`（对方曾从非 home DERP 拨来我们的连接，可反向复用免跨洋建连）；都没有才 `derphttp.NewRegionClient` 建新连。每条 DERP 连接两个 goroutine：`runDerpReader`（derp.go:533，`RecvDetail` 循环 + 指数退避重连，断连触发 `ReSTUN("derp-recv-error")`）和 `runDerpWriter`（derp.go:683，消费 channel）。home DERP 空闲由 `derpCleanupTimer` 清理。

### rebind：wifi → 蜂窝

`netmon` 检测链路变化 → `userspaceEngine.noteLinkChange`：major（`delta.RebindLikelyRequired`，默认路由变了）→ `Conn.Rebind()`（magicsock.go:3875）→ `rebind(keepCurrentPort)`：`bindSocket`（magicsock.go:3756）原子地关旧 socket、按「用户指定端口→当前端口→随机」重绑（Unix 无法真正 rebind，靠换 socket，读写路径经 `pconnAtomic` 无缝切换，`rebinding_conn.go`）→ `maybeCloseDERPsOnRebind` → **`resetEndpointStates`**：对每个 endpoint 调 `noteConnectivityChange`（endpoint.go:1876）清空 bestAddr 信任与路径派生态（保留 netmap 端点），迫使下一包重新全量 disco。另有无网络切换时的自愈：`maybeRebindOnError`（magicsock.go:1612）写失败节流 rebind。

### UDP peer relay（v1.104 新增）

`relaymanager.go` + `net/udprelay`（`buildfeatures.HasNATTraversal` 门控）：在直连与 DERP 之外增加第三条路径——经 relay server 的 UDP 中继。新增 disco 消息类型（`TypeBindUDPRelayEndpoint*`、`TypeCallMeMaybeVia`、`TypeAllocateUDPRelayEndpointRequest/Response`），endpoint 加 `relayCapable` 能力位与节流字段，探测成功后以 `epAddr{vni}`（`endpoint.go:2026`，netip.AddrPort + 可选 Geneve VNI）形态注入 `bestAddr`，与直连/DERP 共用同一选路状态机。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 状态机（per-peer） | `endpoint` 的 bestAddr/信任期/路径候选 | 路径质量是时变的，状态机收敛优于静态配置 |
| 环形缓冲 | `recentPongs`（64 深）in `endpoint.go` | pong 延迟统计窗口，防旧样本污染 |
| 读写分离 goroutine | `runDerpReader`/`runDerpWriter` in `derp.go:533/683` | DERP TCP 收发解耦，写侧背压走 channel |
| 索引表 | `peerMap` in `peermap.go:38` | nodeKey/discoKey/地址三种身份互查 |

## 模块间交互

向上：以 `connBind` 身份被 wireguard-go 调用（Send/ParseEndpoint/ReceiveFunc 注册 `receiveIPv4/6` + `receiveDERP`）；被 userspaceEngine 驱动（SetNetworkMap/Rebind/SetPrivateKey）。横向：消费 netcheck（NAT 探测）、netmon（链路变化）、derp/derphttp（中继）、disco（协议消息）；netcheck Report 经 `Conn.updateNetInfo`（magicsock.go:1025）转 `tailcfg.NetInfo` 上报 control。

## 扩展方式

新增一种路径发现机制的范本即 v1.104 的 peer relay：(1) `disco/disco.go` 加消息类型及解析；(2) `endpoint` 加能力位与节流字段；(3) 在现有触发点挂钩（`send`、`heartbeat`、`handleCallMeMaybe`，endpoint.go:1125/2227）；(4) 独立 manager goroutine 管理分配/握手，成功后以 `epAddr` 形态注入选路状态机。细节展开见[深度附件](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/04-magicsock-disco)。
