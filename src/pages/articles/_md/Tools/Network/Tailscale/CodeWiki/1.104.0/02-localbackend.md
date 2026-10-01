---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "LocalBackend 编排"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "Go", "状态机", "profile"]
description: "ipn/ipnlocal LocalBackend 单锁状态机、派生状态机、profile 体系与 god class 拆解路线解读。"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

`ipn/ipnlocal/`（约 44,000 行，`local.go` 单文件 9,262 行）是 tailscaled 的大脑：**三个异步源——控制面回调（controlclient）、数据面状态（wgengine）、用户操作（localapi/prefs 编辑）——全部汇合到 LocalBackend 的一把锁内，再由派生状态机输出一致的状态**。它编排登录、netmap 应用、profile 切换、包过滤器更新、peerapi/serve/Taildrop 扩展宿主等几乎全部业务逻辑。理解了 LocalBackend 的状态机，就理解了客户端的全部生命周期。

## 模块架构

LocalBackend 内部由四块构成：**单一大锁 `mu`**（历史名 `ipnStateMu`，v1.104 统一为 `b.mu`，配合 `syncs.RequiresMutex` 静态断言）守护全部可变状态；**`currentNodeAtomic`** 持有 `nodeBackend`（`node_backend.go`，1,680 行）——每个 profile/node 一个独立后端（netmap、routeMgr、过滤器输入），是正在进行的 god class 拆解；**`profileManager`**（`profiles.go`）管理多账号 profile 与 prefs 持久化；**`ExtensionHost`/`ipnext.Extension** 机制把 Taildrop 等特性外移为插件（代码中大量 `TODO(nickkhyl): move to nodeBackend` 标注拆解进度）。

```
LocalBackend
├─ mu syncs.Mutex（大锁）
│    ├─ cc controlclient.Client      控制面句柄
│    ├─ pm *profileManager           profile + prefs
│    ├─ state ipn.State              派生状态（见概览状态流图）
│    ├─ keyExpired/authURL/authActor 登录态
│    ├─ peerAPIServer / serveConfig  扩展服务
│    └─ tka *tkaState                Tailnet Lock
├─ currentNodeAtomic → nodeBackend   per-profile 后端（netmap/routeMgr）
└─ extHost *ExtensionHost            特性扩展宿主（ipnext.Extension）
```

## 调用链路

登录主链（控制面事件进入的路径）：

```
Start (local.go:3040)                         先 DisconnectControl 防旧 client 竞态 #20365
  └─ startLocked → resetControlClientLocked   重建 controlclient
       └─ controlclient.New → Auto.start      两条常驻 goroutine 起跑
用户操作: StartLoginInteractiveAs (local.go:4684)
  ├─ 有 7 天内有效 authURL → popBrowserAuthNowLocked (local.go:4340)
  └─ 否则 cc.Login(LoginInteractive)
控制面回调: SetControlClientStatus (local.go:1837)
  └─ setControlClientStatusLocked
       ├─ st.LoggedIn → blockEngineUpdatesLocked(false) + authReconfigLocked
       └─ st.NetMap → setNetMapLocked (local.go:7335)
            ├─ nodeBackend 更新 + tkaSyncIfNeeded（Tailnet Lock 验证）
            ├─ updateFilterLocked (local.go:3401) → b.e.SetFilter
            └─ stateMachineLocked (local.go:6981)
数据面回投: setWgengineStatusLocked (local.go:2949)
  └─ cc.UpdateEndpoints + stateMachineLocked → NumLive>0 → Running
```

注意：**早期版本的 `authLoop` goroutine 在 v1.104 已不存在**——登录重试由 `controlclient.Auto` 的 backoff 负责。状态机本身是"纯派生函数"模式：

```go title="ipn/ipnlocal/local.go"
func (b *LocalBackend) stateMachineLocked() {
    b.enterStateLocked(b.nextStateLocked())
}
```

`nextStateLocked()`（local.go:6902）按优先级从锁内字段推断：`!wantRunning && hasNodeKey → Stopped`；`netMap==nil → NeedsLogin`；`keyExpired → NeedsLogin`；`MachineStatus != Authorized → NeedsMachineAuth`；`Starting && NumLive>0 → Running`。`enterStateLocked`（local.go:6794）负责副作用——进入 NeedsLogin/Stopped 时 `Reconfig` 空 wgcfg 卸载数据面。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `authReconfigLocked` in `local.go:6092` | 控制面→数据面配置汇合点 | v1.104 wgcfg 不内联 peers，route manager 惰性供给 |
| `updateFilterLocked` in `local.go:3401` | netmap 包过滤规则 → `filter.Filter` | `filter.New(packetFilter,...)` 后 SetFilter |
| `EditPrefsAs` in `local.go:5210` | MaskedPrefs 部分更新入口 | 反射按 mask 合并 |
| `SwitchToProfile` in `profiles.go` | profile 切换 | StateKey 隔离，Windows 每用户独立 |
| `CheckDeadlocks` in `watchdog.go` | 大锁死锁探测 | 5s 探测 30s panic，替代已删的 watchdogEngine |

</details>

## 核心实现

### 一把大锁的取舍

为什么用单锁而不是细粒度锁：状态是"读一堆字段做推断"的纯函数（`nextStateLocked`），任何字段间偏序都可能造成瞬时不一致的状态快照；单锁保证推断原子性。代价是**锁内不能调外部**——`Start` 特意把 `clientToShutdown.Shutdown` 放锁外、`ignoreControlClientUpdates` 防 shutdown 死锁、`tkaSyncLock` 要求先于 `mu` 获取。`syncs.Mutex` 支持 watchdog 探测（见概览"状态流"）。

### v1.104 的 Reconfig 新架构

`authReconfigLocked`（local.go:6092）构造的 `wgcfg.Config` **只含 PrivateKey + Addresses**（注释明言 "config carries no peers"）；peer 配置改为按需：`wgengine.Engine.SetPeerConfigFunc` 安装惰性 peer 源，由 route manager（`cn.updateRouteManagerPrefs`）增量提交并 `b.e.SyncDevicePeer(k)` 做 O(1) 单 peer 同步——netmap delta 不再触发整表 Reconfig。这是数据面性能的关键演进。

### profile 与 prefs 体系

`profileManager`（profiles.go:42）持 `knownProfiles map[ProfileID]LoginProfileView / currentProfile / prefs PrefsView / currentUserID`（Windows 多用户）。profile = `ipn.LoginProfile{ID, Key StateKey, NodeID, LocalUserID}`（`ipn/prefs.go:1096`）；prefs JSON 经 `pm.WriteState(profile.Key, prefs.ToBytes())` 写 StateStore，profile 列表存 `KnownProfilesStateKey`。

`Prefs`（`ipn/prefs.go:59`，ControlURL/RouteAll/ExitNodeID/CorpDNS/RunSSH/AdvertiseRoutes…）配合 `MaskedPrefs`（prefs.go:356，每字段一个 `XxxSet bool`）——`Prefs.ApplyEdits` 用反射按 mask 合并，构成"部分更新"协议。只读快照 `PrefsView` 由 `cmd/cloner` 生成。

### peerapi：节点间 API 的扩展宿主

`peerAPIServer`（peerapi.go:60）在节点 Tailscale IP 上监听（Linux `SO_BINDTODEVICE` / macOS `IP_BOUND_IF` 防物理网泄流），`peerAPIHandler.ServeHTTP`（peerapi.go:397）按 capability 门控分发 DoH、debug、Taildrop。v1.104 中 Taildrop 已拆出：`feature/taildrop/peerapi.go` 的 `handlePeerPut` 处理 `PUT /v0/put/<filename>`，经 `ipnlocal.GetExt[*Extension]` 反向取回 manager——这是 `ipnext.Extension` 插件化拆 god class 的实例。

### 多 profile 并发与 nodeBackend

`nodeBackend`（node_backend.go）持有单 node 的 netmap、routeManager、过滤器输入；profile 切换时 LocalBackend 原子替换 `currentNodeAtomic`。拆解动机：历史 LocalBackend 把所有 profile 的状态都堆在一把锁下，多 profile 语义纠缠；按 node 拆分后状态边界清晰（进行中，大量 TODO 标注）。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 派生状态机 | `nextStateLocked`/`enterStateLocked` in `local.go` | 多异步源汇合时状态一致性免手工维护 |
| 观察者 | `SetControlClientStatus` in `local.go:1837` | controlclient 单向上抛，无反向依赖 |
| 插件宿主 | `ExtensionHost` + `ipnext.RegisterExtension` | Taildrop 等特性外移，LocalBackend 只暴露钩位 |
| 依赖反转 | profileManager 的 `StateChangeHook`（PR #15791 注释） | store 层回调不 import LocalBackend |

## 模块间交互

向上被 ipnserver/tsnet/localapi 三个 frontend 持有；向下 import controlclient（Observer 实现）、wgengine（Reconfig/SetFilter）、store（经 profileManager）、tailcfg/netmap（类型）。SSH（`ShouldRunSSH`）、Taildrop（Extension）、Tailnet Lock（tkaState）以特性身份挂接。

## 扩展方式

新增 pref 字段的完整改动链见概览"典型修改场景 2"；新增需要 peerapi 的特性参考 `feature/taildrop/ext.go` 的 `ipnext.RegisterExtension` + `ipnlocal.RegisterPeerAPIHandler` 模式。
