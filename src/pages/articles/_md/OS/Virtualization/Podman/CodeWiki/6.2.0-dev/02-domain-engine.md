---
source:
  type: "源码解读"
  project: "Podman"
  url: "https://github.com/containers/podman"
title: "Domain 引擎层"
date: "2026-08-17T12:06:00+08:00"
category: [OS, Virtualization, Podman, CodeWiki, "6.2.0-dev"]
tags: ["Podman", "Go", "Domain", "ABI", "Tunnel"]
description: "解读 Podman 的引擎抽象层：ContainerEngine/ImageEngine 门面接口与 ABI/Tunnel 双后端分叉，让同一 CLI 既能本地直连 libpod 又能远程走 REST。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/00-overview)

---

## 模块定位

`pkg/domain` 是 Podman 的**引擎抽象层**：定义 `ContainerEngine`/`ImageEngine` 门面接口，由 `infra` 子包的工厂按 `EngineMode` 生产 ABI（本地）或 Tunnel（远程）实现。它让上层 cobra 命令只写一遍——命令代码既能在本地进程内直连 libpod，也能经 REST 调远程 podman。这是 Podman "同一 CLI，双后端"的核心机制，也是 macOS/Windows 客户端无法本地跑 Linux 容器时天然走远程的根因。

## 模块架构

接口与实现分离在两个子包：

- **`pkg/domain/entities`**：定义 `ContainerEngine`（`engine_container.go`）聚合 container/pod/network/volume/secret/quadlet/system 全部操作，`ImageEngine`（`engine_image.go`）聚合 image/artifact/manifest/farm。两个大接口都标 `//nolint:interfacebloat`——**有意为之的门面接口**。签名风格统一 `(ctx, 名称/ID, options) (report, error)`。`entities` 仅定义接口和 DTO，不 import libpod/bindings，杜绝循环依赖。
- **`pkg/domain/infra`**：工厂 `NewContainerEngine`/`NewImageEngine`（`runtime_abi.go:14` / `runtime_tunnel.go:36`）按 `facts.EngineMode` 分叉。

```go title="pkg/domain/infra/abi 与 tunnel 的实现结构差异"
// ABI：持有 libpod.Runtime 指针，进程内直连
type abi.ContainerEngine  struct{ Libpod *libpod.Runtime }
// Tunnel：持有带连接信息的 context.Context，走 REST/SSH
type tunnel.ContainerEngine struct{ ClientCtx context.Context }
```

两套实现的差异即其字段差异：ABI 持 `*libpod.Runtime`，Tunnel 持 `context.Context`（由 `bindings.NewConnectionWithOptions` 注入 URI/Identity/TLS）。

## 调用链路

以 `podman run` 为例的分叉：

```
cobra.Command(run).RunE
   │  (root.go:388 PersistentPreRunE 先行)
   ├─ registry.NewContainerEngine(cmd, args)        registry/registry.go:65
   │     └─ infra.NewContainerEngine(&podmanOptions)
   │            switch facts.EngineMode {  ★分叉点 runtime_abi.go:16
   │            ┌───────────────────────────┐
   │        ABIMode                       TunnelMode
   │   NewLibpodRuntime()              newConnection() → bindings.NewConnectionWithOptions
   │   runtime_proxy.go:15              runtime_tunnel.go:19
   │   └─ GetRuntime → libpod.NewRuntime  └─ &tunnel.ContainerEngine{ClientCtx}
   │   └─ &abi.ContainerEngine{Libpod}
   ├─ cmd.RunE 调 registry.ContainerEngine().ContainerRun(ctx, opts)
   ▼ ABI 路径                                 ▼ Tunnel 路径
   abi.ContainerEngine.ContainerRun          tunnel.ContainerEngine.ContainerRun
   abi/containers.go:1181                    tunnel/containers.go:888
   ├─ generate.CompleteSpec(ctx, ic.Libpod)  ├─ containers.CreateWithSpec(ic.ClientCtx) ← bindings
   └─ ic.Libpod.Create/Start/Wait            └─ containers.Start(ic.ClientCtx)
```

分叉点在 `infra.NewContainerEngine` 的 `switch facts.EngineMode`（`runtime_abi.go:16` / `runtime_tunnel.go:37`）。两条路径之后都返回 `entities.ContainerEngine` 接口，**上层命令代码完全一致**。两条路径最终合流到 libpod（见 [libpod 模块](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/01-libpod-runtime)）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `infra.NewContainerEngine` in `runtime_abi.go:14` | 按 EngineMode 生产引擎 | switch 分叉 ABI/Tunnel |
| `NewLibpodRuntime` in `runtime_libpod.go:43` | ABI 侧建 libpod 单例 | `sync.Once` 保证只建一次 |
| `abi.ContainerEngine.ContainerRun` in `abi/containers.go:1181` | 本地跑容器 | 委托 `generate` + `ic.Libpod` |
| `tunnel.ContainerEngine.ContainerRun` in `tunnel/containers.go:888` | 远程跑容器 | 委托 `bindings` HTTP |
| `remoteProxySignals` in `tunnel/runtime.go:40` | 远程信号转发 | ABI 由内核直发，Tunnel 必须显式代理 |

</details>

## 核心实现

### 门面接口 ContainerEngine / ImageEngine

`ContainerEngine`/`ImageEngine` 是聚合上百操作的大接口。命令侧通过 `registry.ContainerEngine()`/`ImageEngine()`（`registry.go:60`）按需取用——container 命令依赖前者，image 命令依赖后者，互不耦合。这是接口隔离与门面的结合：对外是统一大接口（命令好用），内部按资源域拆分实现文件。

### ABI 本地实现

`abi.ContainerEngine` 持 `*libpod.Runtime`，方法体直接调 `ic.Libpod.Create/Start/...`，并调用 `generate.CompleteSpec`（补全镜像字段）、`generate.MakeContainer`（装配 OCI spec）——这些是 ABI 独有的进程内能力。ABI build tag 为 `//go:build !remote && (linux || freebsd)`，只在 Linux/FreeBSD 编译。

### Tunnel 远程实现

`tunnel.ContainerEngine` 持 `context.Context`（含连接信息），方法体调 `bindings/containers.CreateWithSpec` 等 HTTP client。方法签名与 ABI **完全相同**（同一接口），但每个调用序列化成 REST 请求。Tunnel 多了 `remoteProxySignals`（`runtime.go:40`）做信号转发——本地 ABI 由内核直接发信号给容器进程，远程必须显式代理。Tunnel build tag 为 `//go:build remote || !(linux || freebsd)`，macOS/Windows 上 `ABIMode` 直接返回 `"direct runtime not supported"`。

### 编译期条件编译与 DTO 双用

ABI 与 Tunnel 同名函数在不同平台文件中编译不同实现，靠 build tag 选择。`entities` 的 Options 结构（`ContainerRunOptions`/`BuildOptions` 等）**既是 CLI 入参也是 API wire format**——很多字段带 `json` tag（如 `types.go:42` 的 `NetOptions`），CLI 把 flag 解析进 Options，domain 透传，ABI 直接喂 libpod、Tunnel 序列化成 query/body，避免双向映射。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂 | `infra.NewContainerEngine`/`NewImageEngine` | 按 EngineMode 生产不同实现 |
| 策略 | ABI vs Tunnel | 同接口两套实现，调用方无感知切换 |
| 接口隔离 | `ContainerEngine`/`ImageEngine` 分离 | container 与 image 命令各取所需 |
| 单例 + 懒初始化 | `registry` 缓存、`runtimeSync sync.Once` | 避免重复建 Runtime |

## 模块间交互

`pkg/domain/infra/abi` import `libpod`，直接调 `ic.Libpod`；`pkg/domain/infra/tunnel` import `pkg/bindings`，调 HTTP client。`cmd/podman/registry` import `pkg/domain/infra` + `entities`，是 domain 与 cobra 的胶水层。`pkg/api`（REST server）与 domain 并行：Tunnel 客户端调 `pkg/api` 的 endpoint，`pkg/api/handlers` 再委托 libpod。domain 层本身不 import `pkg/api`。

## 扩展方式

新增一个 top-level 命令需在**接口 + ABI + Tunnel 三处同步**（少任何一步都会让另一种模式编译失败或运行时报 nil）：

1. `pkg/domain/entities/engine_*.go` 加方法签名 + `entities/` 下加 `FooOptions`/`FooReport`。
2. `pkg/domain/infra/abi/foo.go` 实现委托 `ic.Libpod`。
3. `pkg/domain/infra/tunnel/foo.go` 实现委托 `bindings`（同时 `pkg/bindings` 加 client）。
4. `cmd/podman/commands/foo.go` 加 cobra command，RunE 调 `registry.ContainerEngine().Foo`；若仅 ABI 可用，加 `Annotations: map[string]string{registry.EngineMode: registry.ABIMode}`（参考 `system/reset.go:26`）。

这正是双后端抽象的代价：每个能力都得在接口 + ABI + Tunnel 三处落地。扩展点的契约定义见概览「架构设计解析 > 核心概念」。
