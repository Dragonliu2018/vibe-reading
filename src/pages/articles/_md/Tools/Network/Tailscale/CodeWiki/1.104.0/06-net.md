---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "net 网络子系统"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "Go", "DNS", "STUN", "netlink"]
description: "net/ 子系统十个包：OS DNS 配置、netcheck NAT 探测、portmapper 三协议、netmon 监控与 tstun 钩子链解读。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

`net/`（约 73,900 行）是**网络环境感知与 OS 适配工具集**：家里/公司/咖啡馆的网络环境千差万别（DNS 被谁管、NAT 什么行为、路由器支不支持 UPnP、网络什么时候切换），这个模块把这些"环境问题"逐个封装成可独立测试的子包，让核心逻辑不写一行 `if windows`。它不是一个内聚的"模块"，而是一组横切工具——但共享同一个设计哲学：**每个子包一个环境问题，go:build 文件对解决平台差异**。

## 模块架构

| 子包 | 一句话职责 | 核心类型/函数 |
| --- | --- | --- |
| dns | 系统 DNS 配置管理 + 内置 MagicDNS resolver | `Manager`（manager.go）、`OSConfigurator` 接口（osconfig.go） |
| netcheck | NAT/连通性探测（STUN/ICMP/HTTPS） | `Client`、`Report`、`GetReport`（netcheck.go:832） |
| portmapper | UPnP/PMP/PCP 端口映射 | `Client`、`Probe`（:896）、`createOrGetMapping`（:553） |
| netmon | 网络状态变化监控 | `Monitor`、`ChangeDelta`（netmon.go:70/97） |
| tstun | tun 设备包装（filter+注入钩子链） | `Wrapper`（wrap.go:100）、`SetPeerRoutes`（:721） |
| packet | IP/TCP/UDP/ICMP/TSMP 零拷贝头解析 | `Parsed.Decode`（packet.go:104） |
| routemanager | 路由快照派生（dest→peer 表 + OS 路由） | `RouteManager`、`Begin/Commit` 事务（routemanager.go:180/219） |
| netns | 防路由回环的逻辑网络命名空间 | `Control`（Linux 用 SO_MARK） |
| tsaddr | Tailscale 保留 IP 段常量/运算 | `CGNATRange`、`TailscaleULARange`、`Tailscale4To6` |
| art | Allotment Routing Table（BART 基座） | `Table[T]`（art/table.go:32） |

包间的组织方式：dns/netcheck/netmon/portmapper 是"感知+适配"四件套，被 magicsock/wgengine/ipnlocal 消费；tstun/packet/routemanager/art 是数据面基座，被 wgengine 消费。

## 调用链路

### netcheck：一次探测的数据流

```
GetReport (netcheck.go:832)
  ├─ makeProbePlan (netcheck.go:455)    按 DERPMap 规划各 region 的 STUN probe
  ├─ 并发发 STUN（UDP v4/v6）、ICMPv4、HTTPS probe
  └─ 产出 Report (:91): UDP/IPv4/IPv6/MappingVariesByDestIP/UPnP/PMP/PCP
       /RegionLatency/PreferredDERP
消费方:
  magicsock.Conn.updateNetInfo (magicsock.go:1025)
    ├─ lastNetCheckReport → tailcfg.NetInfo（DERPLatency 按 "<region>-v4/-v6" 序列化）
    ├─ SetNetInfoCallback 上抛 ipnlocal (local.go:724 b.setNetInfo) → 上报 control
    └─ PreferredDERP → maybeSetNearestDERP 驱动 home region 切换
```

`MappingVariesByDestIP` 用于判定 hard NAT（对称型）——直接影响打洞策略与是否尽早走 DERP。增量报告复用上次结果，`GetLastDERPActivity` 回调抑制 home DERP 抖动。

### DNS：compileConfig 双轨拆分

入口 `dns.Manager.Set` → `compileConfig`（manager.go:334）把配置拆成 resolver 配置（MagicDNS 转发）+ `OSConfig`，再 `m.os.SetDNS`。`OSConfigurator`（osconfig.go:21，四方法 `SetDNS/SupportsSplitDNS/GetBaseConfig/Close`）按 go:build 分发，Linux 在 `dnsMode`（manager_linux.go:135）探测出五种模式：

| 模式 | 触发条件 | 实现 |
| --- | --- | --- |
| systemd-resolved | D-Bus ping `org.freedesktop.resolve1` 成功 | `resolvedManager`：D-Bus `SetLinkDNS/SetLinkDomains`（resolved.go:272 `setConfigOverDBus`），监听 `NameOwnerChanged` 处理 resolved 重启 |
| network-manager | 旧版 NM < 1.26.6 需经 NM 下发 | nm.go |
| direct | resolv.conf 属主无人认领 | `directManager` 直改 /etc/resolv.conf |
| debian-resolvconf / openresolv | resolvconf 变体存在 | 对应文件 |

Windows（manager_windows.go）用 `windowsManager` + `nrptRuleDatabase`（nrpt_windows.go，写注册表 `NRPTRuleIDs`/GenericDNSServers 实现 split DNS）；`buildfeatures.HasDNS` + `ts_omit_*` 支持编译裁剪。

### tstun.Wrapper：tun 的钩子链

`Wrapper`（wrap.go:100）包 `tun.Device` 并实现同接口，对 wireguard-go 透明替换。`Read/Write` 路径按序跑固定钩子链：入向 `PreFilterPacketInboundFromWireGuard` → 主 filter（`filt.RunIn`，wrap.go:1193）→ `PostFilterPacketInboundFromWireGuardAppConnector` → `PostFilterPacketInboundFromWireGuard`（GRO 版）；出向 netstack 拦截 → engine 拦截 → app connector → 主 filter（wrap.go:824）→ `PostFilterPacketOutboundToWireGuard`。所有钩子是**导出字段直接赋值注入**（如 userspace.go:469 设 `echoRespondToAll`；netstack 设 `NetstackIntercept` 抢走本应内核处理的包）。`InjectInboundCopy/InjectOutbound`（wrap.go:1438/1483）反向注入自造包；`peerConfigTable`（wrap.go:580）配合 `SetPeerRoutes` 做 per-packet SNAT/DNAT（masq）与 jailed filter。

### netmon：变更传播

`Monitor`（netmon.go:70）平台后端：Linux netlink（`nlConn`）、Windows IP Helper、darwin 路由 socket、其余平台 250ms 轮询，另检测时钟跳变（睡眠唤醒）。变化经 eventbus 发布 `ChangeDelta`（预计算 `RebindLikelyRequired` 等字段）。订阅者：wgengine 的 `linkChange`（userspace.go:1155）——major 先 `FlushCaches`、Linux 重设 DNS（NM 会清掉 resolved 配置），再 `magicConn.Rebind()` + `ReSTUN`；ipnlocal 的 `b.linkChange`（local.go:1196）触发控制面重连。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `GetReport` in `netcheck.go:832` | NAT 探测 | probe plan 按 DERPMap 动态规划 |
| `Probe` in `portmapper.go:896` | 三协议并行发现 | 250ms 超时，谁响应用谁 |
| `createOrGetMapping` in `portmapper.go:553` | 创建端口映射 | PMP/PCP 共享 pxpAddr 逻辑 |
| `Manager.Set` in `dns/manager.go` | DNS 配置下发 | compileConfig 拆 resolver/OS 两轨 |
| `Monitor.RegisterChangeCallback` in `netmon.go` | 变更订阅 | ChangeDelta 预计算 major/minor |
| `routemanager Begin/Commit` in `routemanager.go:180/219` | 路由快照事务 | 产出不可变 bart 快照，数据面无锁读 |

</details>

## 核心实现

### portmapper 为什么支持三种协议

家庭路由器固件碎片化：UPnP（IGD XML/SOAP，功能全但实现最杂）是事实标准；PMP 是 Apple 旧协议（0 字节请求即响应，最便宜）；PCP 是 PMP 的 IETF 标准化继任者（RFC 6887，带 nonce 防伪造）。`Probe`（portmapper.go:896）并行发三种发现包，谁响应用谁；`createOrGetMapping`（:553）里 PMP/PCP 共享 `pxpAddr` 端口逻辑。netcheck 只在 full report 里顺带 Probe 一次，避免常驻开销。

### routemanager 为什么独立成包

包注释即设计文档：把"peer→prefix 归属"与路由派生从 wgengine/ipnlocal 抽出，`Begin/Commit` 事务化产出**不可变 bart 快照**（与前驱共享内存），数据面（tstun `SetPeerRoutes`、wgengine）无锁读取；`PeerRoute` 指针复用使指针身份即变更检测。窄化的 `peerView` 使其可脱离完整 netmap 测试。这也是 v1.104 wgcfg 不再整表 Reconfig 的配套——route manager 惰性喂 peer 配置给 wireguard-go。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 策略 + go:build 分发 | `dnsMode` in `manager_linux.go:135`；各平台 manager_*.go | OS 差异编译期消解，运行时探测只管变体 |
| 装饰器钩子链 | tstun.Wrapper 的 Pre/PostFilter 导出字段 | 过滤/拦截/AppConnector 共用 tun 读写路径 |
| 不可变快照 | `routemanager` 的 bart 快照 | 数据面读不加锁 |

## 模块间交互

被消费关系：magicsock ← netcheck/netmon；wgengine ← tstun/packet/routemanager/art；ipnlocal ← netmon/routemanager（nodeBackend 持有实例）；tailscaled ← netns。tsaddr/types 是被全库引用的常量底座。

## 扩展方式

新增平台 DNS 配置方式（仿 manager_freebsd.go）：新建 `manager_<goos>.go` 实现 `NewOSConfigurator` 返回 `OSConfigurator` 四方法（无 split DNS 能力则 `SupportsSplitDNS()=false` 并实现 `GetBaseConfig` 供全量接管回退）；直改文件可复用 `direct.go` 的 `directManager`。全程无需改 `manager.go`——平台分发纯由构建标签完成。
