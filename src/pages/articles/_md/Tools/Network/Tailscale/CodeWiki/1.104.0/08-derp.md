---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "DERP 中继"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "DERP", "中继", "自建"]
description: "derp/ 协议三件套：帧格式与公钥寻址、derpserver 转发逻辑、derphttp HTTPS 外壳与 region 体系解读。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

DERP（Detour Encrypted Routing Protocol）是 Tailscale 的**加密中继**：NAT 穿透失败时的最后保障。客户端侧（`derp/derp_client.go`、`derphttp/derphttp_client.go`）与服务器侧（`derp/derpserver/`，v1.104 已从 `derp/derp_server.go` 迁入）共享 `derp/derp.go` 协议定义；`cmd/derper` 是可自建的服务器入口。设计前提：**DERP server 是"最后一跳的哑管道"**——它转发的永远是 WireGuard 已加密的包，只能按公钥路由和 drop，不能读改内容；信任边界因此极小，官方 DERP 也无法解密用户流量。

## 模块架构

三层结构：`derp.go`（帧协议，双端共享）、`derpserver/`（服务器：客户端注册表 + 转发 + mesh）、`derphttp/`（HTTPS/WebSocket 外壳与客户端）。另有 `net/udprelay/`（beta 的 UDP peer relay，与 DERP 互补）。

### 协议帧格式（`derp/derp.go`）

帧头 5 字节：1B `FrameType` + 4B 大端长度（`FrameHeaderLen`）；连接 magic 为 8 字节 `"DERP🔑"`。关键 frame：`FrameServerKey(0x01)`、`FrameClientInfo(0x02)`、`FrameServerInfo(0x03)`、`FrameSendPacket(0x04)`、`FrameRecvPacket(0x05)`、`FrameKeepAlive(0x06)`、`FrameNotePreferred(0x07)`、`FramePeerGone(0x08)`、`FramePeerPresent(0x09)`、`FrameForwardPacket(0x0a)`、`FrameWatchConns(0x10)`、`FramePing/Pong(0x12/13)`、`FrameRestarting(0x15)`。

**密钥即地址**：`FrameSendPacket` = 32B 目的 `key.NodePublic` + packet；v2 的 `FrameRecvPacket` 前置 32B 源 key——一条长连接可以向任意 peer 发包，天然多路复用。

### 握手与信任模型

`accept`（`derp/derpserver/derpserver.go`）：server 发 `FrameServerKey`（magic + 公钥）→ client 发 `FrameClientInfo`（32B 公钥 + 24B nonce + naclbox 加密 JSON）→ server 回 `FrameServerInfo`。`recvClientKey`（derpserver.go:1922）用 server 私钥 `OpenFrom` 解开，**不信任 client**（限制 256KB 防资源耗尽）——持有 node key 即证明身份，无需账号体系。

## 调用链路

A→B 单包转发路径（同 region）：

```
A 客户端 FrameSendPacket{dst=B 的 node key}
  → derpserver.handleFrameSendPacket (:1470) 读出 dstKey
  → recvPacket (:1956) 校验 MaxPacketSize = 64<<10
  → lookupDest (:1446) 三级查找:
       ① 本地 s.clients（lock-free 快路径，命中 active client 直接返回）
       ② 慢路径持 Server.mu 查重复连接
       ③ 无本地 → s.clientsMesh[dst] 查 PacketForwarder（region 内其它 node）
  本地命中 → sendPkt (:1649) 入 dst.sendQueue
       （disco 包走独立 discoSendQueue 优先，队列满丢队头保新包）
       → wakeWriter 唤醒 B 的 writer goroutine 发 FrameRecvPacket
  有 mesh → fwd.ForwardPacket(src,dst) → FrameForwardPacket
       → handleFrameForwardPacket (:1391)（需 canMesh 权限，不再二次转发）
  完全未知 → drop + 向 A 回 FramePeerGone(PeerGoneReasonNotHere)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `accept` in `derpserver.go` | 握手 | naclbox 证明持钥，不信任 client |
| `lookupDest` in `derpserver.go:1446` | 目的寻址 | 本地快路径 → mesh 三级 |
| `registerClient` in `derpserver.go:882` | 连接注册 | dupClientSet 处理网络切换双连接 |
| `addWatcher` in `derpserver.go:1102` | mesh 观察者 | 先回放全部在线 peer |
| `NotePreferred` in `derp_client.go:350` | home region 声明 | 客户端迁移的信号 |
| `connect` in `derphttp_client.go:339` | HTTPS 外壳拨号 | Upgrade: derp + 101 切换 |

</details>

## 核心实现

### mesh key：region 内互通

`SetMeshKey`（derpserver.go:581）设定 region 内共享 PSK；`isMeshPeer`（derpserver.go:1747）常量时间比对 `ClientInfo.MeshKey`——mesh peer 获得 `canMesh` 权限：可发 `FrameWatchConns`（`addWatcher` 会先回放全部在线 peer）、可转发包、豁免 verifyClient/限速。`FramePeerPresent` 经 `broadcastPeerStateChangeLocked`（derpserver.go:942）让 region 内所有 node 都知道某 peer 在线。**跨 region 不 mesh**：B 在别的 region 时 A 的 server 无 B 记录，回 `PeerGoneReasonNotHere`，由 magicsock 层驱动 B 连到 A 的 home region。

### derphttp 外壳：为什么是 HTTPS/TLS

`derphttp_client.go` 包注释直说：让 DERP 流量**"看起来像 WebSocket"**，能穿过只放行 443 的企业代理/防火墙；即使 TLS 被中间人劫持（假 CA），拦截器若不识别 DERP 帧也只当普通 WebSocket。连接协商（`connect` in `derphttp_client.go:339`）：TCP → TLS（`tlsdial` 处理证书钉扎，`CertName` 支持 `sha256-raw:` 自签指纹）→ HTTP `Upgrade: derp` → `handler.go` 校验后 `Hijack` 并手写 `HTTP/1.1 101 Switching Protocols`。**Fast Start**（`FastStartHeader = "Derp-Fast-Start"`，derp.go:170）：client 跳过等待 101，把 DERP 握手帧与 HTTP 请求同发，省一个 RTT。js/wasm 客户端强制走 WebSocket（`websocket.go`，subprotocol `"derp"`）；`/derp/probe` 供无 UDP 的客户端测延迟。

### region 概念与选择

`tailcfg/derpmap.go`：`DERPMap.Regions map[DERPRegionID]*DERPRegion`；`DERPRegion{RegionID, RegionCode("nyc"/"sin"), Nodes []*DERPNode}`，**900-999 保留给自建**。选择流程：`netcheck` 对每个 region 的 STUN 做延迟探测（`makeProbePlan` in `net/netcheck/netcheck.go:455`），Report 的 `RegionLatency` 交给 magicsock 的 `setNearestDERP`（`wgengine/magicsock/magicsock.go:4145`）切换 home region；`FrameNotePreferred` 告知 server "这是我的 home"，`IdealNodeHeader` 标记是否连上 `Region.Nodes[0]` 理想节点。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 读写分离 goroutine | sendQueue + wakeWriter in `derpserver.go:1649` | 单 TCP 连接多路复用下背压走队列 |
| 三级查找 | `lookupDest` in `derpserver.go:1446` | lock-free 快路径避开全局锁 |
| 协议升级 | `connect` in `derphttp_client.go:339` | 复用 443/WebSocket 生态穿透企业网络 |

## 模块间交互

客户端侧被 magicsock 消费（`runDerpReader`/`runDerpWriter`，见 [magicsock 模块](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/04-magicsock)）；协议类型依赖 `types/key`（node key 寻址）与 `tailcfg/derpmap.go`（region 地图）。`net/udprelay/server.go` 是姊妹模块：不走 TCP 长连接、直接 UDP 中继 disco/WireGuard 包（blake2s MAC 会话认证，beta 阶段）。

## 扩展方式

自建 derper 的关键参数（`cmd/derper/derper.go`）：

```text title="cmd/derper 关键 flag"
-a :443                 监听地址（443 走 HTTPS/ACME）
-hostname               TLS 主机名；-certmode manual|letsencrypt
-mesh-psk-file          region 内 mesh PSK（64 hex），多实例组网
-mesh-with a,b          主动连接的 mesh 对端
-verify-clients         经本地 tailscaled WhoIsNodeKey 校验（防白嫖）
-stun（默认 true）/ -stun-port 3478    同机跑 STUN 供 netcheck 测延迟
-derp=false             只跑 STUN（下线过渡期）
-rate-config            per-client 限速（SIGHUP 热载）
```

客户端侧把自建 region 写入 ACL 的 `derpMap`（RegionID 900-999），可设 `OmitDefaultRegions` 弃用官方节点。
