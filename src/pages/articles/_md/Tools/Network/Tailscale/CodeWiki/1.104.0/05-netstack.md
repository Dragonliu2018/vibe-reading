---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "netstack 用户态栈"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "gVisor", "TCP/IP", "用户态网络"]
description: "wgengine/netstack：gVisor 用户态 TCP/IP 栈、四元组拦截回调、MagicDNS 拦截与子网转发的实现解读。"
readingTime: "16 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

`wgengine/netstack/` 把 gVisor netstack（`gvisor.dev/gvisor/pkg/tcpip`）接入 tailscaled：**让无 root/无 tun 设备的环境也能收发流量（userspace-networking 模式），同时在 TUN 模式下按需拦截发往本机的 TCP/UDP 流量**，承载 MagicDNS（100.100.100.100:53）、peerapi、Tailscale SSH（端口 22）、serve/funnel、subnet router 转发。它是"tailscaled 进程内长出一副完整 TCP/IP 协议栈"的模块。

## 模块架构

`Impl`（`netstack.go:161`）是模块中枢，实现 `wgengine.FakeImpl`。关键扩展点是两个四元组拦截回调（外部注入）与两个模式开关：

```go title="wgengine/netstack/netstack.go:173/186"
GetTCPHandlerForFlow func(src, dst netip.AddrPort) (handler func(net.Conn), intercept bool)
GetUDPHandlerForFlow func(src, dst netip.AddrPort) (handler ..., intercept bool)
ProcessLocalIPs bool   // 处理发往本机 Tailscale IP 的流量
ProcessSubnets  bool   // 充当 subnet router
```

`Create`（netstack.go:334）组装：`stack.New`（ipv4/ipv6 + tcp/udp/icmp；Windows 下设 `ClockResolution=500µs` 修正 RACK 误判）→ CUBIC 拥塞控制 → `newLinkEndpoint`（`link_endpoint.go:146`，自管 GRO/三路出队的 gVisor LinkEndpoint）→ `CreateNIC` + `SetPromiscuousMode(true)`（动态注册 subnet IP 需收一切包）→ 全默认路由 → 两个关键挂钩：

```go title="wgengine/netstack/netstack.go:439-440"
ns.tundev.PostFilterPacketInboundFromWireGuard = ns.injectInbound        // WG → netstack
ns.tundev.PreFilterPacketOutboundToWireGuardNetstackIntercept = ns.handleLocalPackets  // 本机 → netstack
```

`Start`（netstack.go:631）注册 `tcp.NewForwarder(..., ns.acceptTCP)` / `udp.NewForwarder(..., ns.acceptUDPNoICMP)` 为传输层 handler，并启动 `injectToHost`/`injectToWireGuard`/`injectLoopback` 三个注入 goroutine。

## 调用链路

入向数据路径（tun → gVisor → 分发）：

```
wireguard-go 解密 → tstun.Wrapper → injectInbound (netstack.go:1446)
  └─ shouldProcessInbound (netstack.go:1255) 判定归 netstack 与否
       （peerapi 端口 / ShouldInterceptTCPPort / VIP service / ProcessLocalIPs / ProcessSubnets）
  → linkEP.gro(p,g) 或直接 DeliverNetworkPacket 进 gVisor
  → gVisor 完整 TCP 状态机（握手/重传/拥塞控制）
  → tcp.Forwarder 触发 acceptTCP (netstack.go:1576)
       ├─ quad-100:53 → ns.dns.HandleTCPConn
       ├─ ns.lb.TCPHandlerForDst（SSH / serve / peerapi）
       ├─ GetTCPHandlerForFlow（外部注入回调，tsnet 用）
       └─ 否则 forwardTCP (netstack.go:1783) 子网转发
出向: gVisor WritePackets → outboundQueueForPacket (netstack.go:1022) 三路路由
       ├─ shouldSendToHost → 宿主机网络
       ├─ isSelfDst → loopback
       └─ 其余 → outboundToWireGuard → tun → wireguard-go 加密
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Create` in `netstack.go:334` | 组装 gVisor 栈 | 复用同一个 tundev/Engine/magicsock |
| `shouldProcessInbound` in `netstack.go:1255` | 入向拦截判定 | TUN 模式按需拦截，最小化性能税 |
| `acceptTCP` in `netstack.go:1576` | TCP 分发 | quad-100/DNS → handler 回调 → 转发 |
| `forwardTCP` in `netstack.go:1783` | 子网转发 | 先拨通物理网络再完成握手（fail fast） |
| `handleLocalPackets` in `netstack.go:840` | 出向 quad-100 吸收 | 防 DNS 泄漏到 tailnet |
| `handleMagicDNSUDP` in `netstack.go:2054` | UDP 53 拦截 | 150ms deadline 兼容 glibc socket 复用 |

</details>

## 核心实现

### 子网转发与 NAT 映射

`forwardTCP`（netstack.go:1783）先 `dialFunc(ctx,"tcp",dialAddr)` 拨物理网络，成功才完成客户端握手（失败快速 RST），随后双向 `io.Copy` + half-close；本地 IP 场景经 `ns.pm.RegisterIPPortIdentity`（proxymap）做 NAT 映射。非 Tailscale IP 会先 `addSubnetAddress`（netstack.go:656）临时注册地址供 gVisor 握手。UDP 同构：`acceptUDP`（netstack.go:1987）→ MagicDNS/handler 回调/`forwardUDP`（按流建 endpoint，无 per-packet 状态）。

### MagicDNS 双向拦截

入向：`acceptUDP` 判定 `dst==100.100.100.100`（`serviceIP`）且 port 53 → `handleMagicDNSUDP`（netstack.go:2054）循环读（150ms deadline 兼容 glibc libresolv 的 socket 复用）→ `ns.dns.Query(...)` 交给 `dns.Manager` → 写回。出向：`handleLocalPackets`（netstack.go:840）钩在 tun 出路径，**无条件把 quad-100 流量吸收进 netstack**（`filter.DropSilently`）——防止本应给 MagicDNS 的查询泄漏到 tailnet 产生 "no associated peer node" 噪音（netstack.go:860-870 注释详述该回归修复）。

### 本地服务对接

统一经 `ipn/ipnlocal/netstack.go:21` 的 `TCPHandlerForDst`：quad-100:80 → web client、DriveLocalPort → Taildrive、**端口 22 且 `ShouldRunSSH()` → `handleSSHConn`**（附带 72h keepalive，注释解释长空闲 SSH 的权衡）、`GetPeerAPIPort` 匹配 → peerapi、`hookTCPHandlerForServe` → serve/funnel。TUN 模式下由 `ShouldInterceptTCPPort` 决定哪些 SYN 进栈。

未服务端口的 RST 兜底是安全考量（netstack.go:1744-1772 注释）：`hittingServiceIP`/`isVIPServiceIP` 的连接必须显式拒绝，否则会误落到"是 Tailscale IP 就转 127.0.0.1"的分支，打到宿主机 loopback 上无关服务。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 回调注入 | `GetTCPHandlerForFlow`/`GetUDPHandlerForFlow` 字段 in `netstack.go:173` | tsnet 等外部不必改 netstack 即可拦截流量 |
| 钩子链复用 | `tundev.PostFilterPacketInboundFromWireGuard` 挂接 in `netstack.go:439` | 与 filter/app-connector 共用 tstun 的同一钩子位体系 |
| 接口适配 | `newLinkEndpoint` in `link_endpoint.go:146` | gVisor LinkEndpoint+GSO 端点自管出队，替代 channel.Endpoint |

## 模块间交互

依赖：tstun（同一 tundev）、wgengine（Engine/magicsock）、gVisor（外部栈）、ipnlocal（`TCPHandlerForDst` 回调 + dns.Manager）。被 userspace 模式的 tailscaled、tsnet（`ProcessLocalIPs/ProcessSubnets = true`）、SSH/serve/peerapi 各服务消费。

## 扩展方式

新增本地拦截端口按归属三选一：(a) 属于 LocalBackend 语义 → `ipn/ipnlocal/netstack.go` 的 `TCPHandlerForDst` 加 port case（参考 SSH 分支）；(b) 需让 TUN 模式下 SYN 进栈 → `ShouldInterceptTCPPort` 端口集合（`local.go:8348` 背后的 atomic set）；(c) 独立组件 → `Impl.GetTCPHandlerForFlow`/`GetUDPHandlerForFlow` 回调（tsnet 即此路线）。
