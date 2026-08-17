---
source:
  type: "源码解读"
  project: "Podman"
  url: "https://github.com/containers/podman"
title: "libpod 核心运行时"
date: "2026-08-17T12:06:00+08:00"
category: [OS, Virtualization, Podman, CodeWiki, "6.2.0-dev"]
tags: ["Podman", "Go", "libpod", "容器运行时", "SQLite"]
description: "解读 libpod：Runtime/Container/Pod 核心结构、config 与 state 分离、SQLite 持久化、infra container、OCI spec 生成与无 daemon 设计。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/00-overview)

---

## 模块定位

libpod 是 Podman 的**核心容器运行时库**，承载容器、pod、镜像、卷的完整生命周期与状态持久化。它是 ABI/Tunnel 双后端的**合流点**——无论本地直连还是远程经 REST，最终都调到这里的 `Runtime`/`Container` 方法。Podman 的 daemonless 特性也由它实现：每次 `podman` 是独立进程，状态必须落盘，libpod 用 SQLite + 文件锁让多进程安全并发。

## 模块架构

```go title="libpod/runtime.go:67"
type Runtime struct {
    state             State                 // 状态后端接口（SQLite）
    store             storage.Store          // containers/storage 层存储
    defaultOCIRuntime OCIRuntime             // 默认 crun/runc 封装
    ociRuntimes       map[string]OCIRuntime
    network           nettypes.ContainerNetwork  // Netavark/CNI
    lockManager       lock.Manager          // 文件/SHM 锁
    eventer           events.Eventer
    libimageRuntime   *libimage.Runtime
}
```

`Runtime` 是顶层单例，聚合状态、存储、OCI runtime、网络、锁、事件六个子系统。围绕它有三组实体：

- **`Container`**（`libpod/container.go:96`）：`config`（持久化）+ `state`（运行时）分离，持 `ociRuntime` 与 `runtime` 反向引用。
- **`Pod`**（`libpod/pod.go:30`）：容器组，经 infra container 共享 namespace。
- **`State`** 接口（`libpod/state.go:20`）：Container/Pod/Volume 的 Repository，`SQLiteState` 为默认实现。

libpod 不反向依赖上层（`pkg/domain`/`pkg/api` 都调它，它不调它们），保证核心可被多入口复用。

## 调用链路

`NewRuntime()` 初始化链（`libpod/runtime.go:175`）：

```
NewRuntime()
 └─ newRuntimeFromConfig()  ── 加载 config.Default()
     └─ makeRuntime()  runtime.go:330
         ├─ getDBState()  runtime.go:290  → NewSqliteState()
         ├─ configureStore()  ── 初始化 containers/storage
         ├─ newConmonOCIRuntime()  ── 为每个 OCI runtime 建 conmon 封装
         ├─ network.NetworkBackend()  ── 选 Netavark/CNI
         ├─ getLockManager()  runtime.go:231  ── file/shm 锁
         └─ refresh()  runtime.go:893  ── 重启后重建运行时状态
```

`Container.Start()` 启动链（`libpod/container_api.go:93`）：

```
Container.Start(ctx, recursive)
 └─ startNoPodLock()
     ├─ syncContainer()  container_internal.go:363  ── 从 DB 刷新 state
     ├─ prepareToStart()  container_internal.go:819  ── 模板方法
     │   ├─ checkDependenciesAndHandleError()  ── pod 依赖容器已运行
     │   ├─ prepare()  ── rootfs/bind mount 准备
     │   └─ init()  container_internal.go:1025  ── 首次启动
     │       ├─ generateSpec()  container_internal_common.go:235  ── 装配最终 OCI spec
     │       ├─ saveSpec(newSpec)
     │       └─ ociRuntime.CreateContainer(c, nil)  ── fork conmon → runc/crun create
     └─ start()  container_internal.go:1290
         ├─ ociRuntime.StartContainer(c)  ── runc/crun start
         ├─ state.State = ContainerStateRunning
         └─ save()  ── 持久化到 SQLite
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `NewRuntime` in `runtime.go:175` | 工厂创建单例 Runtime | functional options，`sync.Once` 保证只建一次 |
| `getDBState` in `runtime.go:290` | 选状态后端 | BoltDB 已移除，强制 SQLite（6.0） |
| `refresh` in `runtime.go:893` | 重启后重建运行时状态 | config 不丢，state 重建 |
| `Container.Start` in `container_api.go:93` | 启动容器 | 锁 pod→锁 container，模板方法分阶段 |
| `init` in `container_internal.go:1025` | 首启装配 | 动态生成 OCI spec（运行时信息） |
| `generateSpec` in `container_internal_common.go:235` | 组装 `spec.Spec` | 注入 PID/NetNS/mount |
| `ociRuntime.CreateContainer` in `oci_conmon_common.go:181` | fork conmon | conmon 再 exec runc/crun |

</details>

## 核心实现

### Runtime 装配与单例

`libpod.Runtime` 在 ABI 模式由 `pkg/domain/infra/runtime_libpod.go:43` 用 `sync.Once` 创建——一次 `podman` 进程只建一个。`makeRuntime()`（`runtime.go:330`）按固定顺序装配：先开 SQLite、合并 DB 里的路径配置、初始化 `containers/storage`、为每个配置的 OCI runtime 建 `ConmonOCIRuntime`、选网络后端、选锁后端，最后 `refresh()`。这个顺序反映依赖：状态/存储先就绪才能装 runtime。

### Container 的 config 与 state 分离

```go title="libpod/container.go:96"
type Container struct {
    config     *ContainerConfig   // 持久化到 DB，reboot 不丢
    state      *ContainerState    // 运行时，tmpfs，reboot 丢失
    lock       lock.Locker
    runtime    *Runtime
    ociRuntime OCIRuntime
}
```

`config` 是用户意图（创建时确定、不可变），`state` 是运行时事实（PID、NetNS path、cgroup 路径，易变、可重建）。每次操作前 `syncContainer()`（`container_internal.go:363`）从 DB 重新加载 state、检查 conmon 写的 exit 文件。这是无 daemon 设计的关键：进程退出后，下次调用靠 DB 里的 config + 重建的 state 恢复视图。

### Pod 与 infra container

Pod 通过 `HasInfura` + `UsePodPID/IPC/Net` 标记（`pod.go:60`）决定是否共享 namespace。Linux namespace 以进程为单位，共享需一个"锚"进程持有 namespace——**infra container** 充当此角色，其他容器 `join` 它的 namespace。`SharesNamespaces()`（`pod.go:410`）检查是否需要 infra。这复刻了 K8s pod 的 pause container 模型，让 podman pod 与 K8s 语义对齐。

### 状态持久化：SQLite

`State` 接口（`state.go:20`）定义 Container/Pod/Volume/ExecSession 的 CRUD，是 Repository 模式。默认实现 `SQLiteState`（`sqlite_state.go:26`）。v6.0 移除了 BoltDB——`getDBState`（`runtime.go:290-322`）对 `DBBackendBoltDB` 直接返回迁移错误，引导用户 `podman system migrate --migrate-db`。仓库内 `boltdb_state.go` 保留为迁移读取逻辑。无 daemon 意味着多进程并发访问同一 DB，libpod 用 `lockManager`（file 或 shm，`runtime.go:231`）做容器/pod 级文件锁，每个 Container 有独立 lock ID，`Batch()` 避免重复 lock/sync。

### OCI spec 生成与启动

`generateSpec()`（`container_internal_common.go:235`）在 `init` 阶段**动态生成**最终 OCI spec，与容器创建时落盘的基础 `config.Spec` 分离：运行时信息（PID、NetNS path、mount point）不能在创建时确定，必须启动时注入。rootfs mount 由 `mount()`（`container_internal.go:2576`）独立处理，经 `containers/storage` 提供 overlayfs。spec 装配完落盘 `config.json`，`ociRuntime.CreateContainer` fork conmon，conmon 再 exec `runc/crun create`；`start` 阶段 `ociRuntime.StartContainer` exec `runc/crun start`，容器进程真正起跑。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂 | `NewRuntime`/`NewPod`/`NewContainer` + functional options | 灵活构造，默认值集中 |
| State | `State` 接口 + `SQLiteState` | 解耦存储实现与运行时逻辑，可换后端 |
| Repository | `State` 的 `Container(id)`/`AllContainers` 等 | 统一数据访问 |
| 策略 | `OCIRuntime` 接口（crun/runc/kata）、`network.NetworkBackend` | 运行时切换 runtime/网络后端 |
| 模板方法 | `prepareToStart` | 固定启动骨架，子步骤填充 |

## 模块间交互

libpod import `containers/{image,storage,common}`（vendor）、`libnetwork`、`pkg/rootless`、`pkg/systemd`（cgroup 集成）、`pkg/domain/entities`（DTO）。**被** `pkg/domain/infra/abi`（直接持 `*Runtime`）、`pkg/api/handlers/{compat,libpod}`（构造 `abi.ContainerEngine{Libpod: runtime}`）import。交互都是函数调用（进程内）或经 spec 落盘 + exec OCI runtime。libpod 不反向依赖上层。

## 扩展方式

- **新增状态后端**：实现 `State` 接口全部方法（约 50+，`state.go:20`），在 `getDBState`（`runtime.go:290`）加 case，在 `config.ParseDBBackend` 加名称。
- **新增容器 lifecycle hook**：在 `ContainerState.ExtensionStageHooks`（`container.go:211`）加 hook 定义，在 `init`/`start`（`container_internal.go:1025/1290`）插调用点，经 `generateSpec` 写入 OCI spec hooks 部分。
- **新增网络后端**：实现 `nettypes.ContainerNetwork` 接口，在 `network.NetworkBackend`（`runtime.go:557`）加选择逻辑，在 `setupNetNS`（`networking_linux.go:107`）的 `configureNetNS` 加调用。
