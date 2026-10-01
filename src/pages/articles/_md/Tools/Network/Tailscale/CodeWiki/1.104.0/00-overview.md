---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "Overview"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "Go", "WireGuard", "VPN", "NAT 穿透"]
description: "Tailscale v1.104.0 源码解读概览：零配置 WireGuard mesh VPN 的分层架构、模块地图与运行时行为。"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** v1.104.0 · **协议** BSD-3-Clause · **语言** Go 1.27 · **代码量** ~607,000 行（2,480 个 .go 文件，含 728 个测试文件）· **仓库** [GitHub](https://github.com/tailscale/tailscale)

---

## 总览

### 项目简介

Tailscale 是一个**基于 WireGuard 的零配置 mesh VPN**：你在多台设备上装上 `tailscaled`，登录同一个账号，它们就组成一个私有网络（tailnet），彼此之间可以直接用稳定的 100.x.x.x 地址互访——不用管双方身在哪个 NAT 后面、IP 怎么变。它的核心价值不在于"又实现了一遍 WireGuard"（内核 WireGuard 早就在了），而在于把 mesh 组网里最麻烦的部分自动化了：

- **密钥分发**：节点身份（node key）的注册、轮换、过期全由协调服务器（control plane）管理，用户无感知；
- **NAT 穿透**：`magicsock` 用自研 disco 协议在绝大多数网络下建立直连 UDP 路径，打不穿时无缝回落到 DERP 加密中继；
- **ACL 与路由**：谁访问谁、哪些子网被通告、exit node 怎么走，全部由控制面下发 `netmap`，客户端增量应用。

这个仓库包含 Tailscale 开源代码的主体：`tailscaled` 守护进程、`tailscale` CLI、DERP 中继服务器（`derper`）、Kubernetes operator，以及 `tsnet` 嵌入库。**不包含**：移动端 GUI（iOS/Android 仓库独立）、协调服务器本体（闭源，但可用开源的 headscale 替代）、官方 DERP 网络的运维代码。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| WireGuard 数据面 | `wgengine/` + wireguard-go | 用户态 WireGuard，tun 或纯用户态两种模式 |
| NAT 穿透 | `wgengine/magicsock/` | disco ping/pong + call-me-maybe，多路径自动选路 |
| DERP 中继 | `derp/` + `cmd/derper/` | TCP 443 加密中继兜底，可自建 |
| 控制面协议 | `control/` + `tailcfg/` | Noise IK 加密通道 + JSON Map 长轮询 |
| MagicDNS | `net/dns/` + `wgengine/netstack/` | 100.100.100.100 拦截 + OS 级 split DNS |
| Tailscale SSH | `ssh/tailssh/` | tailnet 身份即 SSH 身份，不经系统 sshd |
| Taildrop 文件传输 | `feature/taildrop/` | peer API 分块传输 + 断点续传 |
| Tailnet Lock | `tka/` | 哈希签名链，防协调服务器作恶 |
| Subnet router / exit node | `wgengine/router/` + `net/routemanager/` | 通告子网路由 / 全流量出口 |
| tsnet 嵌入 | `tsnet/` | 完整 tailscaled 作为库嵌入单二进制应用 |
| Kubernetes operator | `cmd/k8s-operator/` | Ingress/Egress/Connector 的 K8s CRD 化 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Go 1.27 | 语言 | 单语言代码库，重度使用 `go:build` 平台标签 |
| wireguard-go（tailscale fork） | 核心 | 用户态 WireGuard 实现，其 `conn.Bind` 被 magicsock 替换 |
| gVisor netstack（`gvisor.dev/gvisor`） | 核心 | 用户态 TCP/IP 栈，netstack 模式与本地服务拦截的基座 |
| `github.com/tailscale/certstore`、`go4.org` 等 | 可选 | 证书存储、跨平台兼容 |
| AWS SDK v2 / k8s.io/client-go | 可选 | SSM state store、K8s operator（可被 `ts_omit_*` 裁剪） |
| gliderssh（SSH 库 fork） | 可选 | Tailscale SSH 服务端协议栈 |
| zstd | 核心 | Map 长轮询响应压缩 |

### 版本历史

- **2020 前**：TLS + machine key 签名注册，节点身份绑定机器密钥；
- **ts2021**：控制面切换到 Noise IK 协议（`control/controlbase`），machine key 退化为传输层凭证；
- **1.x 中期**：`ipnlocal` 逐渐成为 god class，peerapi/serve/funnel/SSH 全部挂入；
- **近两年（至 v1.104）**：`feature/` 模块化重构——45 个特性包自注册、`ts_omit_*` 构建裁剪；`nodeBackend` 按 profile 拆分 LocalBackend；wgcfg 不再整表 Reconfig，peer 配置改由 `SetPeerConfigFunc` 惰性供给；v1.104 新增 UDP peer relay（`net/udprelay`）。

---

## 快速上手

以 Linux 为例（macOS/Windows 直接装官方客户端即可）：

```bash title="安装与启动"
# 安装（Ubuntu/Debian 官方源，或直接下载静态二进制）
curl -fsSL https://tailscale.com/install.sh | sh

# 启动守护进程（Linux 下 systemd 自动拉起；手动方式如下）
sudo tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock

# 登录并加入 tailnet
sudo tailscale up
```

`tailscale up` 会打印一个授权 URL，浏览器打开登录后节点即注册。端到端验证：

```bash title="验证"
tailscale ip -4          # 打印本节点 100.x.x.x 地址
tailscale ping <对端主机名或 IP>   # pong via DERP/直接连接，证明数据面就绪
tailscale status         # 所有 peer 及其连接状态
```

无 root 环境（容器/Crostini）可用用户态模式：`tailscaled --tun=userspace-networking`，流量经 SOCKS5/HTTP 代理（`tailscale proxy`）进出。

---

## 架构设计解析

### 系统架构

Tailscale 的整体设计可以概括为**"聪明的控制面 + 哑但可靠的数据面"**：协调服务器掌握全局（谁在网、谁能访问谁、走哪条路），但它只下发布局信息，不经手任何用户流量；数据面（WireGuard + magicsock）则把"端到端加密 + 尽量直连"做到极致，即使控制面暂时失联，已建立的连接照常工作。客户端内部沿这个思路分成六层：

![Tailscale 分层架构图](/vibe-reading/images/articles/tailscale-codewiki/architecture.svg)

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接口层 | `cmd/tailscaled/`、`cmd/tailscale/`、`ipn/ipnserver/` | 进程入口与本地通信面：守护进程装配、CLI 命令、socket 服务，把"进程"与"核心逻辑"隔离 |
| 编排层 | `ipn/ipnlocal/`、`ipn/prefs.go` | 全局状态机与业务编排：桥接控制面事件与数据面配置，承载 profile/prefs/peerapi/serve |
| 控制面客户端 | `control/`、`tailcfg/`、`types/` | 与协调服务器对话：Noise 加密、登录注册、netmap 长轮询；协议契约与密钥体系是全库的"类型底座" |
| 数据面引擎 | `wgengine/`、`net/tstun/`、`wgengine/filter/` | WireGuard 隧道的组装与运行：tun 读写、OS 路由下发、包过滤 |
| 传输层 | `wgengine/magicsock/`、`derp/` | NAT 穿透与中继：多路径选路、disco 探测、DERP 兜底，是 WireGuard 之下的"网络感知层" |
| 网络适配层 | `net/` | OS 环境感知与适配：DNS 配置、STUN 探测、网络监控、端口映射——把"OS 差异"挡在核心之外 |

层间依赖单向向下：编排层调 `Engine` 接口 unaware of WireGuard 细节；传输层对 wireguard-go 而言只是一个 `conn.Bind`。右侧的外部系统（协调服务器、DERP、peer）是仅有的三个网络对话方——**用户流量永远不经协调服务器**（除非显式配置 exit node 经由某节点）。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 依赖注入 Hook | `feature/hooks.go` 的 `Hook[T]`/`Hooks[T]`；`wgengine/router/router.go` 的 `HookNewUserspaceRouter` | 依赖倒置：核心包不 import 特性包，特性包反向注入实现，支撑二进制裁剪 |
| 注册表 + 条件导入 | `store.Register` in `ipn/store/stores.go`；`feature/condregister/` 的 `maybe_*.go` | 按前缀/构建标签组装实现（store 后端、feature），init 自注册零显式调用 |
| 不可变 View 快照 | `types/views` + `cmd/viewer` 生成的 `tailcfg_view.go`、`ipn/ipn_view.go` | netmap/prefs 被多 goroutine 共享，只读视图消除锁竞争 |
| 观察者回调 | `controlclient.Observer`（`SetControlClientStatus`）；`Engine.SetStatusCallback` | 控制面/数据面事件单向上抛编排层，避免反向依赖 |
| 派生状态机 | `nextStateLocked` + `enterStateLocked` in `ipn/ipnlocal/local.go` | 状态由字段推断而非指令设置，多异步源汇合时状态一致性免维护 |
| 单例包装（Auto/Direct） | `control/controlclient/auto.go` | 重连状态机与单次请求逻辑解耦，Direct 可被 testcontrol 复用 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `LocalBackend`（`ipn/ipnlocal/local.go:230`） | 客户端"大脑"，单锁状态机 | 进程级单例，被 ipnserver/tsnet 持有 | 持有 controlclient、Engine、store、profileManager |
| `nodeBackend`（`ipn/ipnlocal/node_backend.go`） | 单 profile/node 的独立后端（netmap、路由） | 随 profile 切换创建/销毁 | LocalBackend 的拆解方向 |
| `Engine`（`wgengine/wgengine.go`） | 数据面统一接口 | 与 Engine 实现同生命周期 | LocalBackend 只见接口 |
| `magicsock.Conn`（`wgengine/magicsock/magicsock.go:158`） | WireGuard 的传输 Bind | Engine 内部 | 持有 peerMap、DERP 连接、netChecker |
| `endpoint`（`wgengine/magicsock/endpoint.go:60`） | 单 peer 的路径状态机（bestAddr 等） | 随 netmap peer 增删 | 归属 Conn.peerMap |
| `NetworkMap`（`types/netmap/netmap.go:30`） | 全网快照（self+peers+DNS+filter） | 每次 MapResponse 全量时重建，delta 时打补丁 | 由 mapSession 组装，被 LocalBackend 消费 |
| `profileManager`（`ipn/ipnlocal/profiles.go:42`） | 多 profile（多账号）管理 | LocalBackend 内 | prefs 持久化经 StateStore |
| `AUM`（`tka/aum.go:132`） | Tailnet Lock 签名链消息 | 持久化于 Chonk 存储 | 由 Authority 验证 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `ipn.Backend` | `ipn/backend.go` | `LocalBackend` | 直接构造 |
| `wgengine.Engine` | `wgengine/wgengine.go` | `userspaceEngine` | `NewUserspaceEngine` |
| `controlclient.Client` | `control/controlclient/client.go` | `Auto`（包 `Direct`） | `controlclient.New` hook |
| `ipn.StateStore` | `ipn/store.go:91` | file/mem/aws/kube/tpmseal | `store.Register("prefix:")` |
| `dns.OSConfigurator` | `net/dns/osconfig.go:21` | 各平台 manager（resolved/NRPT/…） | go:build 分发 |
| `feature.Hook[T]` / `ipnext.Extension` | `feature/feature.go`、`ipn/ipnext` | 各 feature 包 | init 自注册 + condregister 条件导入 |

---

## 代码目录

```
tailscale/
├── cmd/                    # 可执行入口
│   ├── tailscaled/         # 守护进程（tun/netstack 模式选择、平台安装）
│   ├── tailscale/          # CLI（ffcli 命令树，经 localapi 与 daemon 通信）
│   ├── derper/             # DERP 中继服务器（可自建）
│   ├── k8s-operator/       # Kubernetes operator（~29k 行）
│   └── containerboot/      # 容器启动器
├── ipn/                    # 客户端应用层
│   ├── ipnlocal/           # LocalBackend 核心（~44k 行，最大模块）
│   ├── ipnserver/          # socket 服务与 backend 托管
│   ├── localapi/           # 本机 HTTP API（CLI/GUI 统一入口）
│   └── store/              # 状态持久化（file/aws/kube 后端）
├── wgengine/               # 数据面引擎
│   ├── magicsock/          # NAT 穿透传输层（~19k 行）
│   ├── netstack/           # gVisor 用户态栈集成
│   ├── router/             # OS 路由下发（osrouter 平台子包）
│   └── filter/             # 包过滤
├── control/                # 控制面客户端
│   ├── controlclient/      # Auto/Direct + map 增量解析
│   ├── controlbase/        # Noise IK 加密通道
│   └── controlhttp/        # Noise over HTTP 升级
├── net/                    # 网络子系统（dns/netcheck/netmon/portmapper/tstun/packet…）
├── tailcfg/                # 客户端↔协调服务器协议类型（Node/MapRequest/MapResponse）
├── types/                  # 核心类型（key/netmap/persist/views…）
├── feature/                # 45 个可裁剪特性包 + 注册/禁用/hook 机制
├── derp/                   # DERP 协议（derp/derpserver/derphttp 三件套）
├── ssh/                    # Tailscale SSH（tailssh）
├── tka/                    # Tailnet Lock 签名链（AUM/State/sync）
├── tsnet/                  # 嵌入式 tailscaled 库
├── disco/                  # disco 协议消息定义
├── util/                   # 工具集（syspolicy/linuxfw/eventbus…）
└── tempfork/               # 临时 fork 的第三方库（acme/spf13/sshtest…）
```

---

## 模块地图

![核心模块依赖关系](/vibe-reading/images/articles/tailscale-codewiki/module-dependencies.svg)

依赖主干是一条"脊柱"：`tailscaled`/`tsnet` 装配 → `LocalBackend` 编排 → `wgengine` 引擎 → `magicsock` 传输；右侧三组支撑模块（协议类型、控制面、网络子系统）从不同侧面挂接。`feature/` 是唯一反向注入的一支——它不依赖被编译进核心，而是通过 hook 与 Extension 注册把自己"挂"到 LocalBackend 上。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 守护进程与 CLI | 进程装配、socket 服务、CLI、状态持久化 | `tryEngine` in `cmd/tailscaled/tailscaled.go:865` | 进程边界：入口装配与核心逻辑分离，CLI/GUI/tsnet 三种 frontend 共用 | [01-daemon](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/01-daemon) |
| LocalBackend 编排 | 状态机、profile、prefs、peerapi、serve | `ipnlocal.NewLocalBackend` | 全部异步源（控制面/数据面/用户操作）的汇合点 | [02-localbackend](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/02-localbackend) |
| wgengine 引擎 | WireGuard 组装、router、filter | `NewUserspaceEngine` in `wgengine/userspace.go:310` | 数据面统一抽象，隔离 WireGuard 细节 | [03-wgengine](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/03-wgengine) |
| magicsock 传输 | NAT 穿透、多路径选路、DERP 兜底 | `magicsock.NewConn` | 传输层独立于加密层，路径智能全在此层 | [04-magicsock](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/04-magicsock)（深度附件：[disco 协议](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/04-magicsock-disco)） |
| netstack 用户态栈 | gVisor TCP/IP、本地服务拦截、子网转发 | `netstack.Create` in `wgengine/netstack/netstack.go:334` | 无 root 环境与本地服务（SSH/serve/DNS）都需要用户态终结 | [05-netstack](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/05-netstack) |
| net 网络子系统 | DNS/netcheck/netmon/portmapper/tstun | 各子包 New* | OS 网络环境感知是横切关注点，与业务逻辑无关 | [06-net](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/06-net) |
| 控制面客户端 | Noise 登录、Map 长轮询、增量解析 | `controlclient.New` → `Auto` | 与协调服务器的通信是独立协议栈 | [07-control](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/07-control) |
| DERP 中继 | 加密中继协议与服务器 | `derp/derpserver/derpserver.go` | 打洞失败的最后保障，协议独立于 WireGuard | [08-derp](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/08-derp) |
| 协议与核心类型 | tailcfg/tailnet 类型契约、密钥体系 | `tailcfg/tailcfg.go` | 双端共享的"语言"，独立演进（CapabilityVersion） | [09-tailcfg](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/09-tailcfg) |
| feature 特性架构 | 特性注册/禁用/裁剪、45 个特性包 | `feature.Register` in `feature/feature.go` | 二进制裁剪与新特性归宿，架构级机制 | [10-feature](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/10-feature) |
| localapi 与 tsnet | 本机 API、官方客户端库、嵌入 | `localapi.NewHandler`；`tsnet.Server` | 对外暴露面与"tailscaled 即库"的形态 | [11-localapi-tsnet](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/11-localapi-tsnet) |
| SSH 与 Tailnet Lock | tailnet 身份 SSH、签名链防作恶 | `tailssh.HandleSSHConn`；`tka.Authority` | 两个安全特性各自独立成域 | [12-ssh-tka](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/12-ssh-tka) |

---

## 运行时行为

### 启动流程

`tailscaled` 的启动是一次显式的依赖装配，入口在 `main`（`cmd/tailscaled/tailscaled.go:200`）：

```
main → mainNormal
  ├─ netmon.New（网络监控）
  ├─ ipnserver.New（socket 服务壳，先就绪可探活）        ipn/ipnserver/server.go:464
  └─ goroutine: getLocalBackend                          cmd/tailscaled/tailscaled.go:706
       ├─ tryEngine（tun 名多级降级尝试）                 tailscaled.go:865
       │    ├─ tstun.New / Wrap（tun 设备）              net/tstun/
       │    ├─ router.New（OS 路由器，hook 注入平台实现）  wgengine/router/router.go:71
       │    ├─ dns.NewOSConfigurator（DNS 配置器）        net/dns/
       │    └─ wgengine.NewUserspaceEngine                wgengine/userspace.go:310
       │         ├─ magicsock.NewConn（UDP socket + DERP）
       │         ├─ wgcfg.NewDevice（wireguard-go device，Bind=magicsock）
       │         └─ netstack.Create（gVisor 栈，hook 注入）
       ├─ store.New（按 --state 前缀选后端）              ipn/store/stores.go
       ├─ ipnlocal.NewLocalBackend（大脑）                ipn/ipnlocal/local.go:548
       └─ lb.Start(ipn.Options{})
```

对象装配的几个要点：**Engine/Router/DNS 三个平台强相关的组件全部经 hook 间接构造**（`router.New` 取 `HookNewUserspaceRouter` 注册的平台实现），核心装配代码无平台分支；**socket 服务先于 backend 就绪**，早到的连接由 `ipnserver.Server` 的 `waiterSet` 阻塞等待，Windows 上 wintun 初始化慢时 `/server-status` 可探活；配置优先级为命令行 flag > state store 持久化 prefs > 代码默认值。

### 核心运行流程

下面三条链路覆盖了 tailscaled 运行期的三种核心场景：加入网络（控制面）、转发流量（数据面）、适应环境变化（传输面自愈）。

#### 控制面：登录 → netmap → Running

业务流程：守护进程启动 → 注册新 node key → 用户浏览器授权 → 协调服务器下发全网快照 → 客户端配置数据面 → 进入 Running。

![控制面链路](/vibe-reading/images/articles/tailscale-codewiki/control-flow.svg)

文字解读：登录由 `controlclient.Auto` 的 `authRoutine` 驱动——`Direct.TryLogin` 经 Noise 通道 `POST /machine/register`，拿到 auth URL 后以 `Notify{BrowseToURL}` 抛给 GUI/CLI，同时最长轮询 30 分钟等授权。授权完成后 `mapRoutine` 的 `PollNetMap` 转入流式长轮询（zstd 帧流），`mapSession` 把增量 MapResponse 合并为全量状态并组装 `NetworkMap`。LocalBackend 收到后走 `setNetMapLocked` → `updateFilterLocked`（包过滤器）→ `authReconfigLocked`（v1.104 的 wgcfg 不再内联 peers，peer 配置由 route manager 惰性供给 wireguard-go）→ 数据面状态回投 `setWgengineStatus`，`nextStateLocked` 判断 `NumLive>0` 即转 Running。失败重试由 backoff（上限 30s）与 `Retry-After` 尊重共同控制。

#### 数据面：一个 ping 包的端到端旅程

业务流程：应用发包 → 内核路由入 tun → 过滤/转换 → WireGuard 加密 → magicsock 选路发送 → 对端逆向还原。

![数据面链路](/vibe-reading/images/articles/tailscale-codewiki/data-flow.svg)

文字解读：出向包在 `tstun.Wrapper.Read` 中过出向 filter（丢包计 metric）与 SNAT 后交给 wireguard-go 加密；密文经 `endpoint.addrForSendLocked` 选路——`bestAddr` 在 6.5 秒信任期内直发 UDP，过期则 UDP+DERP 双发保险。接收侧 `receiveIPv4/6` 与 `runDerpReader` 按 magic 字节区分 disco 帧与 WireGuard 密文，解密后过入向 filter（conntrack 放行回程）注入内核或 gVisor 栈。三条传输路径（直连/DERP/peer relay）的探测与切换全部由 disco 协议在后台维护，详见 magicsock 模块的深度附件。

#### 传输面：wifi → 蜂窝网络切换

业务流程：netmon 检测链路变化 → 判定 minor/major → ReSTUN 重探测 / Rebind 换 socket → 清空路径信任 → disco 重建直连。

文字解读：`netmon.Monitor` 平台后端（Linux netlink / Windows IP Helper / 其余轮询）产出 `ChangeDelta`，`userspaceEngine.noteLinkChange`（`wgengine/userspace.go`）区分两档：minor 变化仅 `ReSTUN` 重跑 STUN 端点发现；major（默认路由变了）则 `Conn.Rebind()`（`wgengine/magicsock/magicsock.go:3875`）——原子换绑 UDP socket、清理 DERP 连接、对每个 endpoint 调 `noteConnectivityChange` 清空 `bestAddr` 信任，迫使下一包重新全量 disco 探测。整个过程对上层 WireGuard 会话透明：**IP 变了，会话不重建**。

### 状态流

![ipn.State 状态机](/vibe-reading/images/articles/tailscale-codewiki/state-flow.svg)

状态枚举定义在 `ipn/backend.go:28`，转换逻辑在 `nextStateLocked`（`ipn/ipnlocal/local.go:6902`）——状态不是被"设置"的，而是每次事件后从锁内字段**派生推断**出来的（优先级：Stopped > NeedsLogin（无 netmap/keyExpired）> NeedsMachineAuth > Starting→Running）。`enterStateLocked`（`local.go:6794`）执行副作作：进入 NeedsLogin/Stopped 时下发空 wgcfg 卸载数据面，离开 Running 时关闭 peerapi 监听。watchdog（`ipn/ipnlocal/watchdog.go` 的 `CheckDeadlocks`）在 5 秒后探测各子系统锁、30 秒仍持有则打全栈 panic，专治大锁体系下的静默死锁。

---

## 典型修改场景

#### 场景 1：新增 CLI 子命令（如 `tailscale foo`）

- 新建 `cmd/tailscale/cli/foo.go`：暴露 `var fooCmd *ffcli.Command`（ffcli 命令树节点，`newRootCmd` 自动挂载 `Subcommands`）
- 实现走 `client/local`：`lc.get200(ctx, "/localapi/v0/foo")` 风格的方法加到 `client/local/local.go`
- daemon 侧：`ipn/localapi/localapi.go` 的 handler 表加 `"foo": (*Handler).serveFoo`（或 feature 化注册）
- 对应测试：`cmd/tailscale/cli/foo_test.go`

#### 场景 2：新增一个 pref 字段（如 `FooBar`）

- `ipn/prefs.go`：`Prefs` 加字段（含 JSON tag）+ `MaskedPrefs` 加 `FooBarSet bool`
- `go generate`（`ipn_view.go` 的 View 访问器是生成的）
- `ipn/ipnlocal/local.go`：`checkPrefsLocked`（校验）与 `authReconfigLocked`（消费点）
- CLI flag：`cmd/tailscale/cli/set.go` / `up.go`
- 测试：`ipn/prefs_test.go`、`ipnlocal/prefs_metrics.go` 指标同步

#### 场景 3：协调服务器新增下发字段（MapResponse.Foo）

- `tailcfg/tailcfg.go`：`MapResponse` 加字段 + `CurrentCapabilityVersion` bump（历史注释表记录）
- `control/controlclient/map.go`：可增量表达则进 `tryHandleIncrementally` 的 `NodeMutation`，否则全量路径 `updateStateFromResponse`/`netmap()`
- `types/netmap/netmap.go`：`NetworkMap` 加消费字段
- LocalBackend 消费点：`UpdateFullNetmap` / `UpdateNetmapDelta` 处理链
- 对应测试：`control/controlclient/map_test.go`

---

## 测试体系

```
代码库内嵌测试（728 个 _test.go 文件，与源码同目录）
├── 单元测试        各包 _test.go（magicsock/endpoint_test.go 用内存 fake conn 仿真 NAT）
├── tstest/          测试基建（~36k 行：integration 框架、testcontrol 假协调服务器）
├── derp/derptest/   DERP 客户端/服务端互测框架
├── cmd/tailscaled/deps_test.go  depaware 依赖树锁死（裁剪成果回归测试）
└── feature/register_disable_test.go  子进程禁用全部特性断言零注册
```

| 代码层 | 测试类型 | 代表 |
| --- | --- | --- |
| 协议/类型 | 单元测试 | `tailcfg`、`types/key` 的序列化 round-trip |
| 控制面客户端 | 集成测试 | `tstest/integration/testcontrol`（无第三方依赖的假 control） |
| 传输层 | 单元+集成 | `magicsock` 的 derp/derptest、内存 socket |
| 端到端 | 集成 | `tstest/integration/vms`（多节点真实组网） |
| 构建裁剪 | 专项 | `deps_test.go` + `deptest.DepChecker` |

理解某个包时优先读它旁边的 `_test.go`——尤其 `magicsock` 与 `controlclient` 的测试近乎可执行的协议文档。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `cmd/tailscaled/tailscaled.go` 的 `tryEngine`（装配顺序）→ `wgengine/userspace.go` 的 `NewUserspaceEngine` → `ipn/ipnlocal/local.go` 的 `Start`/`SetControlClientStatus`（登录与 netmap 到达）
- **第二遍：理解核心数据结构**
  `types/key/{node,machine,disco}.go`（三把密钥的语义注释必读）→ `types/netmap/netmap.go` 的 `NetworkMap` → `ipn/backend.go` 的 `ipn.State` 枚举
- **第三遍：理解传输魔法（Tailscale 的灵魂）**
  `wgengine/magicsock/endpoint.go` 的 `addrForSendLocked`（选路）与 `handlePongConnLocked`（pong 处理）→ `disco/disco.go`（协议消息）→ `derp/derp.go`（中继帧格式）
- **第四遍：选择重点模块深入**（配合各模块文档）
  做 VPN 网关选 `net/dns` + `wgengine/router`；做安全选 `tka/` + `ssh/tailssh`；做嵌入选 `tsnet` + `ipn/localapi`；关心架构演化选 `feature/README.md`（441 行设计文档，全库最重要的单篇文档）

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| tailnet | 一个账号下的私有设备网络，设备间以 100.64.0.0/10（CGNAT 段）互访 |
| 协调服务器（control plane） | 下发 netmap/ACL/DNS 配置的中心服务器，官方闭源，开源替代 headscale |
| netmap | 协调服务器下发的全网快照：节点列表、路由、包过滤规则、DERP 地图 |
| DERP | Detour Encrypted Routing Protocol，Tailscale 的加密中继（TCP 443），打洞失败时兜底 |
| disco | peer 间的路径发现协议（ping/pong/call-me-maybe），与 WireGuard 数据共用 UDP 端口 |
| node key / machine key / disco key | 节点身份 / 传输层机器身份 / 路径发现身份，三把独立 Curve25519 密钥 |
| TKA（Tailnet Lock） | 哈希签名链，节点加入 tailnet 须受信任密钥签名，防协调服务器作恶 |
| exit node | 全流量出口节点（替代传统 VPN 网关） |
| subnet router | 通告物理子网路由的节点 |
| CGNAT 段 | 100.64.0.0/10，Tailscale 地址空间，选它因其路由不会被公网宣告 |

### 参考资料

- [How Tailscale Works](https://tailscale.com/kb/1136/tailscale-how-it-works)（官方原理总览）
- [DERP 协议设计](https://tailscale.com/kb/1232/derp-servers)与 [NAT 穿透](https://tailscale.com/kb/1281/app-connectors)系列官方文档
- `feature/README.md`（本仓库内，feature 模块化设计文档）
- [A New Tunnel Coordinator / NAT traversal 论文对照](https://tailscale.com/blog/how-tailscale-works)（官方博客）
