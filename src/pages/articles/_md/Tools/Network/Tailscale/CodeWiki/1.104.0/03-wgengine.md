---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "wgengine 引擎"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "Go", "WireGuard", "tun"]
description: "wgengine 数据面引擎：Engine 接口、userspaceEngine 装配、router 平台路由与 filter 包过滤解读。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

`wgengine/` 是数据面引擎：把 wireguard-go 的 `device.Device`、tun 封装（`net/tstun`）、magicsock、OS 路由器（`wgengine/router/`）、包过滤器（`wgengine/filter/`）组装成统一的 **`Engine` 接口**，向 LocalBackend 屏蔽全部 WireGuard 细节。它的存在理由是**抽象边界**：LocalBackend 说"Reconfig 这份配置"，不关心 WireGuard 握手、tun 读写、netlink 下发各自的复杂性。v1.104 的一个重要事实：历史目录 `watchcfg/` 已不存在；router 重构为 `router/router.go`（接口+Config）+ `router/osrouter/`（平台实现子包，经 `feature.Hook` 注册）。

## 模块架构

userspaceEngine 是组装者，五个被组装组件各司其职：`tstun.Wrapper`（tun 设备 + 过滤钩子链）、`magicsock.Conn`（wireguard-go 的 Bind 替身）、`wgdev`（wireguard-go device，加密与 peer 管理）、`Router`（OS 路由）、`Filter`（包过滤）。netstack（见[独立模块](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/05-netstack)）复用同一个 tundev 从旁挂入。

```go title="wgengine/wgengine.go — Engine 接口（核心方法节选）"
type Engine interface {
    Reconfig(*wgcfg.Config, *router.Config, *dns.Config) error  // 返回 ErrNoChanges 表示无变化
    GetFilter/SetFilter; GetJailedFilter/SetJailedFilter
    SetPeerRoutes  // per-packet NAT/jailed-filter 路由表
    SetPeerConfigFunc                       // 惰性 peer 源（v1.104 新架构）
    SyncDevicePeer(nodeKey) error           // O(1) 增量同步单 peer
    MarkDevicePeerForHandshake; SetPeerByIPPacketFunc
    Ping(ip, pingType, size, cb)
    SetStatusCallback; RequestStatus
    Close() <-chan error; Done() <-chan struct{}
    // 诊断/观测: PeerByKey / SetNetLogSource / InstallCaptureHook / ProbeLocks
}
```

注意 **Engine 没有 `SetNetworkMap` 方法**——netmap 由 LocalBackend 消化后拆成三个 Config 传给 `Reconfig`。

## 调用链路

`NewUserspaceEngine`（`wgengine/userspace.go:310`）的装配顺序：

```
conf.Tun (nil → tstun.NewFake)          可测试性：全链路可注入 fake
→ tstun.Wrap/WrapTAP → tsTUNDev         tun 包装，预置 filter 钩子位
→ rtr = conf.Router (nil → router.NewFake)   移动端再包 ConsolidatingRoutes
→ netmon.New + tsdial.Dialer + dns.NewManager
→ magicsock.NewConn(magicsockOpts)       DERP/disco/NAT 探测
→ wgdev = wgcfg.NewDevice(tsTUNDev, magicConn.Bind(), wgLogger)   userspace.go:519
→ wgdev.Up() → router.Up()              userspace.go:559/563
```

`Reconfig`（userspace.go:820）的处理链：比较 cfg/router/dns/listenPort，全无变化返回 `ErrNoChanges`；顺序为 `tundev.SetWGConfig` → `magicConn.SetPrivateKey`（先于 wgdev，保证握手可走 DERP）→ `wgdev.SetPrivateKey` → `router.Set` → `dns.Set`（router 失败不中断 DNS 配置，issue #20447）。**本版本 device 不再整表 reconfig**——peer 由 `SetPeerConfigFunc` 安装的 `device.PeerLookupFunc` 惰性创建（`NewPeerLookupFunc` in `wgengine/wgcfg/device.go:47`）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `NewUserspaceEngine` in `userspace.go:310` | 装配五组件 | 全部可注入 fake，测试不碰真实网络 |
| `Reconfig` in `userspace.go:820` | 三 Config 下发 | SetPrivateKey 先 magicsock 后 wgdev |
| `SetPeerConfigFunc` in `userspace.go:687` | 惰性 peer 源 | 配合 netmap delta 免整表重建 |
| `noteLinkChange` in `userspace.go` | 网络变化分档 | minor 只 ReSTUN，major 才 Rebind |
| `SetFilter` in `userspace.go:977` | 包过滤器注入 | 直通 `tundev.SetFilter` |

</details>

## 核心实现

### Bind 替换：为什么 wireguard-go 的 socket 要换掉

wireguard-go 默认 `conn.Bind` 只会向固定 UDP endpoint 发包；Tailscale 需要 NAT 打洞、多路径漫游（IP 变更不重建会话）、DERP 中继兜底。`magicsock.Conn.Bind()`（`magicsock/magicsock.go:3484`）返回 `connBind`，`ParseEndpoint`（magicsock.go:3925）把 node 公钥 hex 当"endpoint 地址"解析——**endpoint 寻址完全脱离 IP，由 magicsock 内部的 endpointTracker/disco 决定真实路径**。这是 wgengine 与 magicsock 的接缝，也是 Tailscale 对 WireGuard 最核心的改造。

### router：netlink 与平台文件组织

`Router` 接口仅三方法（`router/router.go:29`）：`Up/Set/Close`。平台实现（linux/darwin/freebsd/openbsd/windows/plan9）在 `router/osrouter/`，各文件 `init()` 经 `HookNewUserspaceRouter` 注册，`router.New`（router.go:71）取 hook——把"是否编译进二进制"也裁剪掉（`buildfeatures.HasOSRouter`）。

Linux 流程（`linuxRouter.Set` in `osrouter/router_linux.go:436`）纯 netlink：`netlink.RouteReplace` 加路由（`addRoute`:1190）、`AddrReplace` 加地址（`addAddress`:994）、`addThrowRoute` 下发 throw rule（LocalRoutes 防环）；`cidrDiff` 做旧新集合差量调和；netfilter 走 `util/linuxfw`（iptables/nftables 双后端），并有孤儿地址清扫（#19974）。

### filter：netmap 包过滤规则的执行者

`Filter`（`filter/filter.go:32`）按地址族预分桶 `matches4/matches6` + capability 例外，加本机 IP 集、512 条 LRU conntrack（放行本节点发起的回程）、`shieldsUp`、`IngressAllowHooks`。匹配链（`matches.match` in `filter/match.go:17`）：协议 ∈ m.IPProto → 源前缀/capability 匹配 → 逐 `Dst` 前缀+端口区间匹配，首中即 accept，默认 drop。

方向：`RunIn`（filter.go:443，先查本机 IP 防被攻破的 peer 发往未通告目的，非 SYN TCP 回包按 conntrack 放行）与 `RunOut`（filter.go:476）。**与 netmap 的关系**：控制面下发 `tailcfg.FilterRule`，`MatchesFromFilterRules`（`filter/tailcfg.go:33`）转成 `[]Match`；LocalBackend 构造后 `SetFilter` → `tstun.Wrapper.SetFilter`（`net/tstun/wrap.go:1322`），实际执行在 `wrap.go:824`（出向）与 `wrap.go:1193`（入向）。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 策略 + hook 注册 | `router.New` in `router/router.go:71` 取 `HookNewUserspaceRouter` | 平台实现编译期可裁剪 |
| 装饰器 | `tstun.Wrapper` 包 `tun.Device` 实现同接口 | 对 wireguard-go 透明注入过滤/钩子链 |
| 适配器 | `ParseEndpoint` in `magicsock/magicsock.go:3925` | 公钥冒充 endpoint 地址，寻址下沉到 magicsock |

## 模块间交互

向上：LocalBackend 经 `Reconfig`/`SetFilter`/`Ping` 驱动；netstack 复用同一 tundev（`netstack.Create` 注入 `PostFilterPacketInboundFromWireGuard` 钩子）；向下：magicsock（Bind）、router/dns（Reconfig 参数）、netmon（linkChange）。状态经 `SetStatusCallback` 回投 LocalBackend。

## 扩展方式

新增路由行为（Linux）：`osrouter/router_linux.go` 加 `addXxx/delXxx` 一对函数，挂进 `Set` 里的 `cidrDiff(...)` 调用；跨平台则改 `router.Config` 加字段（多数字段已带平台注释 "Linux-only, ignored elsewhere"）。新增 filter 匹配能力：改 `filtertype.Match`（`filter/filtertype/filtertype.go:70`）加字段 + `match.go` 的 `match()` 加判定 + `tailcfg.go` 的 `MatchesFromFilterRules` 加规则解析；"无显式规则放行"语义走 `IngressAllowHooks` 扩展点而不动核心匹配。
