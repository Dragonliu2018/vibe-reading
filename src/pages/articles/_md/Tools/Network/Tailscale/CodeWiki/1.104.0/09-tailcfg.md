---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "协议与核心类型"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "协议", "密钥体系", "JSON"]
description: "tailcfg 协议契约、三把密钥的语义与演化、NetworkMap 组装与 Capability 下发机制解读。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

`tailcfg/` + `types/key/` + `types/netmap/` + `types/persist/` 构成客户端与协调服务器之间的**协议契约层**——`tailcfg/tailcfg.go` 是全库被 import 最多的包之一（193 次）的原因：`Node`/`Netmap`/`MapRequest`/`MapResponse` 这些 JSON 消息定义了双方"说什么话"；`types/key` 定义"我是谁"（三把密钥）；`types/netmap` 是控制面下发内容在客户端的落点。这一层的任何字段增删都受 `CapabilityVersion` 显式版本协商约束。

## 模块架构

### MapRequest / MapResponse：一问一答的全网同步

`MapRequest`（tailcfg.go:1436）——客户端上报身份与连通性：

```go title="tailcfg/tailcfg.go:1436 — MapRequest 关键字段"
Version CapabilityVersion   // 客户端能力版本号（单调递增，"简化版协议版本"）
NodeKey key.NodePublic       // 节点身份公钥
DiscoKey key.DiscoPublic     // 路径发现公钥
Endpoints []netip.AddrPort   // magicsock 打洞得到的 UDP 端点（STUN 公网 + 局域网）
Hostinfo                   // 硬件/OS/客户端版本
Stream bool                // 是否长轮询（一条 HTTP 连接收多个 MapResponse）
MapSessionHandle/MapSessionSeq  // 断线后重附着会话，序列号增量续传
```

`MapResponse`（tailcfg.go:2006）——服务器下发全网状态：`Node`（自身）、`DERPMap`、`Peers`/`PeersChanged`/`PeersRemoved`/`PeersChangedPatch`（全量 + 三级增量编码）、`DNSConfig`、`PacketFilter(s)`（nil=沿用、非 nil 空=全禁——三态语义注释明示）、`SSHPolicy`、`TKAInfo`。所有字段用 `omitempty`/`omitzero` 实现"零值即不变"的 delta 协议语义。

### Node struct

```go title="tailcfg/tailcfg.go:370 — Node 关键字段"
Key          key.NodePublic       // WireGuard 隧道身份
DiscoKey     key.DiscoPublic      // P2P 路径发现
Addresses    []netip.Prefix       // 节点自身的 Tailscale IP
AllowedIPs   []netip.Prefix       // 要路由到该节点的网段（含 subnet route）
Endpoints    []netip.AddrPort     // UDP 直连端点
PrimaryRoutes, Tags, CapMap NodeCapMap
```

`Addresses` 与 `AllowedIPs` 分开的原因（tailcfg.go:397-402 注释明确）：前者是节点直接持有的 IP，后者是"路由到这个节点的网段"——subnet router 节点两者不同。带宽优化：capver 112 起 AllowedIPs 线上可为 nil 表示"等于 Addresses"，客户端内部总是填充为显式值。

### 密钥体系全景

三把 32 字节 Curve25519 密钥，语义由文件注释定义（`types/key/`）：

| 密钥 | 定义位置 | 用途 | 持久化 |
| --- | --- | --- | --- |
| MachineKey | `machine.go:34` | 与协调服务器的传输层身份（Noise IK 握手） | 独立 state key（`ipn.MachineKeyStateKey`），不再入 `persist.Persist` |
| NodeKey | `node.go:49` | WireGuard 隧道 + DERP 寻址 + ACL 主体；可过期可轮换 | `persist.PrivateNodeKey` / `OldPrivateNodeKey`（轮换） |
| DiscoKey | `disco.go:28` | peer 间 disco 打洞消息加解密 | **不持久化**，每进程随机 |

**machine key 弱化史**：早期注册请求用机器密钥签名（`signRegisterRequest` in `control/controlclient/direct.go:784`，现仅 Windows 残留）、且是节点身份主体；ts2021 Noise 引入后控制通道加密交给 Noise，节点身份统一到 node key，machine key 退化为纯传输层凭证（`initMachineKeyLocked` in `ipn/ipnlocal/local.go:4491` 读独立 state，没有则新生成）。`Node.Machine` 与 `MachineAuthorized` 字段仅为兼容保留。

`persist.Persist`（`types/persist/persist.go:18`）：`PrivateNodeKey`/`OldPrivateNodeKey`（轮换）、`NetworkLockKey`（Tailnet Lock 私钥）、`NodeID`、`AttestationKey`（硬件证明）。

## 调用链路

NetworkMap 的组装不在 tailcfg 包，而在 `(*mapSession).netmap()`（`control/controlclient/map.go:1004`）：

```
多个 delta MapResponse --updateStateFromResponse--> 内存全量状态
  （ms.lastNode / ms.peers / ms.lastDNSConfig ...）
  --netmap()--> types/netmap.NetworkMap (netmap.go:30):
       SelfNode NodeView / AllCaps set.Set[nodecap.Cap]（Capabilities+CapMap 集合化）
       / Peers（按 NodeID 排序）/ DNS / PacketFilter / SSHPolicy
       / DERPMap / UserProfiles / TKAEnabled/TKAHead
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `netmap()` in `control/controlclient/map.go:1004` | 组装 NetworkMap | delta 先合并为全量再组装 |
| `HasCap` in `tailcfg.go:574` | 布尔能力测试 | `v.CapMap.Contains(cap)` |
| `GetVIPServiceIPMap` in `types/netmap/netmap.go:108` | 带参能力解码 | CapMap[cap] 的 []json.RawMessage 定点解析 |
| `MutationsFromMapResponse` in `types/netmap/nodemut.go:149` | delta→NodeMutation | 增量路径的转换器 |

</details>

## 核心实现

### Capability 机制：三类下发通道

`NodeCapMap = map[nodecap.Cap][]json.RawMessage`，通道有三（tailcfg.go:466-479 注释）：

1. **`Node.CapMap`**——自身节点行为开关（如 SSH `https://tailscale.com/cap/ssh`，常量在 `tailcfg/nodecap/nodecap.go`，即 ACL 里的 "node attributes"）；
2. **`PacketFilter(s)`**——授予 peer 的访问；
3. **`Peers[].CapMap`**——peer 级属性（如 `peercap.FileSharingTarget`，Taildrop 收文件能力，`tailcfg/peercap/peercap.go:30`）。

布尔型能力用 `HasCap` 测试；带参数能力（如 VIPService）用专用解码函数解析 `[]json.RawMessage`。旧 `Capabilities []string` 已废弃（issue #11508）。

### 为什么是 JSON 而不是 protobuf

代码中无正式声明（待核实官方原文），但结构证据充分：① 协议要求"nil/空/缺省"三态语义与字段级增量编码，靠 `omitempty`/`omitzero` 逐字段协商（266 处 json tag），protobuf proto3 默认值无法表达"nil=unchanged vs 空 slice=全禁"；② `CapabilityVersion` 显式版本协商 + "旧客户端忽略未知 JSON 字段"的宽容性，使新旧服务器/客户端任意混搭；③ 控制面双端都是 Go 且可 `curl`/日志 dump 调试（`DevKnob.DumpRegister` 即 dump JSON），跨语言客户端只需实现同一 JSON 形状。

### View 类型：netmap 快照的并发安全

`tailcfg_view.go`（93KB，`cmd/viewer` 生成）：不可变只读视图——netmap 是被多个 goroutine 共享的快照数据，View 避免快照被并发修改，也免去消费侧持锁。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 代码生成 View | `cmd/viewer` → `tailcfg_view.go` 等 | 手写 93KB 只读视图不可维护 |
| 显式版本协商 | `CurrentCapabilityVersion` in `tailcfg.go:34` | 100+ 条变更注释即协议演进史 |
| 三态字段语义 | `omitempty`/`omitzero` 全协议 | "零值即不变"支撑增量编码 |

## 模块间交互

被全库依赖：controlclient（收发）、ipnlocal（消费 NetworkMap）、magicsock（peer 端点/DERPMap）、wgengine（AllowedIPs→路由）、tka（NodeKeySignature）。`types/prefs` 在 v1.104 已重构为通用偏好框架（`Item/List/Map` + Managed/ReadOnly 元数据，MDM 管控），经典 `Prefs` 移到了 `ipn/prefs.go:59`——跨包迁移是这层持续演化的常态。

## 扩展方式

新增能力字段的完整链路见概览"典型修改场景 3"；布尔型能力甚至无需 bump 版本——旧客户端只是忽略未知 CapMap 键。
