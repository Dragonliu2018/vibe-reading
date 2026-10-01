---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "控制面客户端"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "Noise", "长轮询", "增量同步"]
description: "control/ 三层：Noise IK 加密通道（controlbase）、HTTP 升级（controlhttp）与 Auto/Direct 客户端的登录与 Map 长轮询解读。"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

`control/` 是客户端与协调服务器的通信层，三个子包自底向上：`controlhttp`（Noise over HTTP 的协议升级拨号）、`controlbase`（Noise IK 握手与加密帧）、`controlclient`（登录注册 + netmap 长轮询 + 增量解析）。协议类型（MapRequest/RegisterRequest 等）在 [tailcfg 模块](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/09-tailcfg)。一个重要事实：**本版本 Noise 用 IK 模式**（`protocolName = "Noise_IK_25519_ChaChaPoly_BLAKE2s"` in `control/controlbase/handshake.go:31`），不是早期文档常提的 XX 模式。

## 模块架构

三层职责分明：

```go title="control/controlclient/client.go:40 — Client 接口"
type Client interface {
    Shutdown; Login(LoginFlags); Logout; SetPaused
    AuthCantContinue
    SetHostinfo; SetNetInfo; SetTKAHead; SetDiscoPublicKey
    UpdateEndpoints; SetIPForwardingBroken; ClientID
    // 注释明确 "must be comparable"——Observer 用 == 识别过期 client 实例
}
```

- **`Auto`**（`auto.go:125`）：Client 的自动重连包装，内部三条常驻 goroutine——`authRoutine`（登录状态机）、`mapRoutine`（netmap 长轮询）、`updateRoutine`（endpoints 变化时的 lite 上报）；
- **`Direct`**（`direct.go:74`）：真正的 HTTP/Noise 客户端。关键字段 `serverNoiseKey`（ts2021）、`persist`（node key 持久化）、`tryingNewKey`（注册中的新 key）、`sfGroup`（singleflight 防并发建 Noise 连接）；
- **`mapSession`**（`map.go:50`）：单次长轮询会话的解析器，持 `lastNode/lastPeers/lastUserProfile` 增量基线。

## 调用链路

### 登录/注册链路（`doLogin` in `control/controlclient/direct.go:634`）

```
loadServerPubKeys (direct.go:1535)         GET /key?v=N 拿 serverNoiseKey
决定 key: 过期/interactive → regen=true
  ├─ tryingNewKey = key.NewNode()
  └─ 旧 key 存 persist.OldPrivateNodeKey（供 control 授权平滑换 key）
Tailnet Lock: persist.NetworkLockKey 新建 NLKey
  └─ 旧签名走 tka.ResignNKS 重签 / wrapped authkey 走 tka.SignByCredential
构造 tailcfg.RegisterRequest（OldNodeKey/NodeKey/NLKey/Hostinfo/AuthKey）
  └─ Windows 特例: signRegisterRequest (direct.go:784) 用 machine key 签名
Noise client POST /machine/register（ts2021.AddLBHeader 加负载均衡头）
  ├─ RegisterResponse.NodeKeySignature 非空 → 重签循环
  ├─ AuthURL 非空 → authRoutine (auto.go:315) sendStatus 推 URL 给 LocalBackend
  │                    开浏览器 + WaitLoginURL 长轮询等授权
  └─ 成功 → persist.PrivateNodeKey 落盘
```

429 限流由 `parseRateLimitError` 处理，`authRoutine` 的 `waitRetryAfter`（auto.go:655）尊重 `Retry-After`。

### netmap 长轮询（`sendMapRequest` in `direct.go:1026`）

`PollNetMap` → `sendMapRequest(ctx, isStreaming=true, nu)`：`POST /machine/map`，`MapRequest{Stream:true, KeepAlive:true, Compress:"zstd"}`。响应体是**大小前缀帧流**（`readMapResponseMessage`），`watchdogTimer` 120 秒收不到任何消息即 cancel 重连。流内处理：

```
KeepAlive 消息 → 续命跳过
非 keep-alive → mapSession.HandleNonKeepAliveMapResponse (map.go:167)
  ├─ upgradeNode: 废弃字段升级（LegacyDERP→DERP、Capabilities→CapMap）
  ├─ patchifyPeersChanged → tryHandleIncrementally (map.go:277)
  │    └─ netmap.MutationsFromMapResponse (types/netmap/nodemut.go:149)
  │         把 PeersChangedPatch/PeersRemoved 转成 NodeMutation
  │         → 先 UpdatePacketFilter/UpdateUserProfiles 单独窄推送
  │         → 再 UpdateNetmapDelta
  └─ 不支持/字段太多 → 全量重建 netmap() (map.go:1004) + UpdateFullNetmap
流内旁路指令: PingRequest / PopBrowserURL / ControlDialPlan / ClientVersion
```

`updateRoutine`（auto.go:61）在 endpoints 变化时用 `SendUpdate` → `sendMapRequest(isStreaming=false, nu=nil)` 的 lite 更新。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `doLogin` in `direct.go:634` | 注册/登录单次请求 | key 轮换经 OldPrivateNodeKey 平滑 |
| `WaitLoginURL` in `direct.go` | 授权长轮询 | 与 auth URL 回路配合 |
| `sendMapRequest` in `direct.go:1026` | Map 请求（流式/lite 双态） | watchdogTimer 120s 兜底 |
| `tryHandleIncrementally` in `map.go:277` | 增量路径 | 失败自动 fallback 全量 |
| `sendStatus` in `auto.go:717` | 状态上抛 | observerQueue 缓冲防回调反锁 |

</details>

## 核心实现

### Noise IK：为什么不用 TLS 做身份层

节点的身份就是其 machine key（Curve25519）。Noise IK 让客户端用 `controlKey` 静态公钥**预知**认证协调服务器，服务器反之认证 machine key——**双向身份内建于握手，无需 CA/PKI**，自托管 control（headscale）只需一对 key。更进一步：`controlhttp` 可跑 **HTTP 80 明文 + Noise**（`tryURLUpgrade` 明确 "demote all cert verification errors to log messages"——安全完全由 Noise 承担，middlebox MITM 只能看到 Noise 密文），443 HTTPS 仅作穿透 fallback。升级路径 `POST /ts2021` + `101 Switching Protocols`，h2 必须禁用（无法 protocol switch）。帧格式 ChaCha20Poly1305 + BLAKE2s，协议名+版本混入 prologue 防降级。

### 事件上推与 key 演化

`Auto.observer` 即 LocalBackend（实现 `Observer.SetControlClientStatus`）。`sendStatus`（auto.go:717）构造 `Status{Err,URL,LoggedIn,InMapPoll,NetMap,Persist}` 经 `observerQueue`（带缓冲 goroutine）异步调用，避免 observer 回调反锁 client。NetMap 增量要求 observer 额外实现 `NetmapDeltaUpdater`。v1.104 新增 eventbus 旁路（`clientVersionPub/controlTimePub/autoUpdatePub`）。

key 体系演化（详见 [tailcfg 模块](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/09-tailcfg)）：2020 前 = TLS + machine key 签名；ts2021 起 machine key 只作 Noise IK 身份，`RegisterRequest.NodeKeySignature`（tailnet lock 签名）逐步接管节点身份证明——`direct.go:879` 仅留 TODO "machine key no longer supported"。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 包装器（Auto/Direct） | `auto.go:125` | 重连状态机与单次请求解耦，Direct 可被 testcontrol 复用 |
| singleflight | `sfGroup` in `direct.go:74` | map/auth 并发不重复握手 |
| 流式长轮询 | `sendMapRequest` in `direct.go:1026` | 一条 TCP 复用全部下发（含 ping/browser URL），控制面秒级全网推送 |
| 渐进降级 | `tryHandleIncrementally` in `map.go:277` | 增量优先、全量兜底，性能与正确性权衡 |

## 模块间交互

向上：Observer 回调进 LocalBackend 的 `SetControlClientStatus`（`ipn/ipnlocal/local.go:1837`）。向下：controlbase/controlhttp（Noise 通道）、tailcfg（协议）、types/netmap（NetworkMap 组装）、tka（NodeKeySignature）。`controlclient.New` 本身是个 hook（`getNewControlClientFuncLocked` in local.go:3008），测试可注入 testcontrol。

## 扩展方式

新增 control 下发字段的完整链路见概览"典型修改场景 3"；能力开关靠 `resp.Node.CapMap` + `tailcfg.CurrentCapabilityVersion` 版本门控——旧客户端忽略未知 JSON 字段的宽容性使新旧端任意混搭。
