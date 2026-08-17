---
source:
  type: "源码解读"
  project: "Podman"
  url: "https://github.com/containers/podman"
title: "Podman Machine"
date: "2026-08-17T12:06:00+08:00"
category: [OS, Virtualization, Podman, CodeWiki, "6.2.0-dev"]
tags: ["Podman", "Go", "虚拟机", "Mac", "Windows", "provider"]
description: "解读 pkg/machine：VMProvider 接口抽象多虚拟化后端，让 macOS/Windows 经虚拟机运行 Linux 容器，VM 内再跑 podman 服务端。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/00-overview)

---

## 模块定位

`pkg/machine` 让 Podman 在 macOS 和 Windows 上经虚拟机运行 Linux 容器。Podman 依赖 Linux namespaces、cgroups、overlayfs、netlink——这些 macOS/Windows 内核没有，故 VM 内跑 Fedora CoreOS 风格镜像，镜像里运行一个 podman 服务端，宿主通过转发后的 socket 连接（即 Tunnel 模式）。`pkg/machine` 管理 VM 生命周期（init/start/stop/rm/set/inspect）、provider 抽象（Apple HV/libkrun、WSL/Hyper-V、QEMU）、rootfs/镜像、端口转发、连接配置。

## 模块架构

```go title="pkg/machine/vmconfigs/config.go:61"
type VMProvider interface {   // 抽象核心，18 个方法
    CreateVM(opts, mc, ignBuilder) error
    PrepareIgnition(mc, ignBuilder) error
    StartVM(mc) (releaseCmd, waitForReady, error)
    StopVM(mc) error
    State(mc) (State, error)
    StartNetworking(mc, cmd) error
    PostStartNetworking(mc) error
    MountVolumesToVM(mc) error
    Remove(mc) error
    SetProviderAttrs(mc, opts) error
    VMType() vmtype.VMType
    MountType() string
    // ... 共 18 个
}
```

每个具体 provider（`AppleHVStubber`、`LibKrunStubber`、`WSLStubber`、`HyperVStubber`、`QEMUStubber`）实现此接口。`MachineConfig`（同文件 15-59）是 VM 持久化配置，持 `GvProxy`、`HostUser`、`Resources`、`SSH`、`Mounts` 及各 provider 的可选字段（`AppleHypervisor`/`HyperVHypervisor`/`LibKrunHypervisor`/`QEMUHypervisor`/`WSLHypervisor`，JSON omitempty，序列化时只留当前 provider 那个）。编排层在 `pkg/machine/shim`，协调 provider、ignition、connection、env、lock、ports、certificates。

## 调用链路

`podman machine init`：

```
cmd/podman/machine/machine.go: machinePreRunE
 └─ provider.Get()                        ── 读 containers.conf + $CONTAINERS_MACHINE_PROVIDER
     └─ platform_darwin.go:GetByVMType    ── build tag 选平台
        └─ new(applehv.AppleHVStubber)
cmd/podman/machine/init.go: initMachine
 └─ shim.Init(initOpts, machineProvider)  pkg/machine/shim/host.go:71
     ├─ env.GetMachineDirs(mp.VMType())
     ├─ vmconfigs.NewMachineConfig(...)    ── 写 JSON 配置
     ├─ diskpull.GetDisk(...)              ── 下载 rootfs（按 VMType 选 .raw/.qcow2/.vhdx/空）
     ├─ ignition.NewIgnitionBuilder(...)   ── 生成 ignition（首启脚本）
     ├─ mp.PrepareIgnition(mc, &ignBuilder)
     ├─ mp.CreateVM(createOpts, mc, &ignBuilder)
     └─ connection.AddSSHConnectionsToPodmanSocket(...)  ── 注册 podman system connection
```

`podman machine start`（`shim/host.go:511 Start → 557 startLocked`）：

```
startLocked
 ├─ startNetworking(mc, mp)              networking.go:93
 │   ├─ [WSL] provider.UseProviderNetworkSetup() → provider.StartNetworking
 │   └─ [Mac/默认] startHostForwarder → gvproxy 启动 → provider.StartNetworking
 ├─ mp.StartVM(mc) → (releaseCmd, waitForReady)
 ├─ mp.PostStartNetworking
 ├─ conductVMReadinessCheck (轮询 mp.State + SSH ping)
 ├─ mp.MountVolumesToVM                    ── virtiofs/9p
 └─ UpdatePodmanDockerSockService          ── docker 兼容 socket
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `provider.Get` in `platform_*.go` | 选 provider | 平台 build tag + VMType |
| `shim.Init` in `host.go:71` | 创建 VM | 协调 provider/ignition/connection |
| `startLocked` in `host.go:557` | 启动 VM | 先网络后 VM，readiness 轮询 |
| `AddSSHConnectionsToPodmanSocket` in `connection/add.go:14` | 注册连接 | URI `ssh://user@127.0.0.1:PORT/.../podman.sock` |
| `RequireExclusiveActive` in stubber | 独占控制 | Mac true，WSL false |

</details>

## 核心实现

### Provider 跨平台抽象

`VMProvider` 接口统一 18 个生命周期方法；跨平台差异落到三个维度：(a) 平台 build tag 选 provider 子集（`platform_darwin.go` 返回 AppleHV/LibKrun，`platform_windows.go` 返回 WSL/HyperV，`platform_unix.go` 返回 QEMU）；(b) `VMType` 决定镜像格式（`host.go:156-167`）、挂载类型（VirtIOFS/NineP/None）、用户名映射（WSL 把 `core` 改成 `user`，`host.go:207-212`）；(c) provider 自己决定 `UseProviderNetworkSetup()` 走自己的网络路径还是 shim 的 gvproxy 通用路径（`networking.go:103`，WSL 返回 true）。

### VM 内 podman 服务端

VM 镜像内置 podman.service，监听 `/run/user/UID/podman/podman.sock`（rootless）或 `/run/podman/podman.sock`（rootful）。宿主端 gvproxy 把本地 unix socket 经 virtio-net/SSH 转发到 guest socket；宿主 `podman` 客户端经 `podman system connection`（`connection/add.go`）指向该 socket。首启脚本由 `ignition`（`ignition.go`）注入，含 SSH 公钥、systemd 单元、volume 挂载单元、`ready.service`。

### 端口转发（gvisor-tap-vsock）

Mac 路径：gvproxy 监听 unix socket，vfkit 的 virtio-net 设备 `SetUnixSocketPath`（`apple/apple.go:84`）直连 gvproxy，实现 L4 + API socket 转发。Windows 路径：`startHostForwarder`（`shim/networking.go:33`）配置 gvproxy 的 `ForwardSock/ForwardDest/ForwardUser/ForwardIdentity`，用 SSH 隧道转发。WSL 走自己的 `StartNetworking`。`RequireExclusiveActive()` 控制全局只能跑一个 VM（Mac true，`shim/host.go:573` 据此加 `startLock`）。

### 清理回滚

`machine.CleanUp()` + `callbackFuncs.Add(...)`（`host.go:78-91`）在 init/start 全程注册清理函数，错误或信号时逆序回滚。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `VMProvider` + 多 Stubber | 运行时按 VMType 切换后端 |
| 平台 build tag 分离 | `platform_*.go` | 同包同名函数编译期选平台 |
| 模板方法 | `apple.StartGenericAppleVM`/`StartGenericNetworking` | applehv 与 libkrun 复用 |
| 命令 | cobra init/start/stop/rm/set/inspect | 各 RunE 委派 shim |
| 清理回调链 | `callbackFuncs` | 错误时逆序回滚 |

## 模块间交互

外部依赖：`containers/gvisor-tap-vsock`（gvproxy）、`crc-org/vfkit`（macOS Virtualization.Framework）、`containers/libhvee`（Windows Hyper-V WMI）。`cmd/podman/machine` 仅参数解析 + provider 选择，业务委派 `pkg/machine/shim`。`pkg/machine/connection` 在 init 时创建两条 `podman system connection`（root + rootless）。支撑子包：`ports`/`sockets`/`certificates`/`proxyenv`/`vmconfigs`/`env`/`lock`/`ignition`。

## 扩展方式

新增一个 VM provider：

1. `pkg/machine/define/vmtype.go` 加 `VMType` 枚举 + `ParseVMType` 映射。
2. `pkg/machine/provider/platform_<os>.go` 在 `GetByVMType`/`GetAll`/`IsInstalled`/`HasPermsForProvider` 各加 case。
3. 新建 `pkg/machine/<name>/stubber.go` 实现 `VMProvider` 全部 18 方法；相似可复用 `apple.StartGenericAppleVM`。
4. `pkg/machine/vmconfigs/config.go` 加 `XxxHypervisor *XxxConfig json:",omitempty"` 字段 + 配套 struct。
5. `pkg/machine/shim/host.go` 的 `imageExtension` switch（156-167 行）加格式 case；挂载方式不同则 `CmdLineVolumesToMounts` 也加分支。
6. 网络路径不同则决定 `UseProviderNetworkSetup()` 返回值并实现 `StartNetworking/PostStartNetworking`。
7. （可选）`pkg/machine/ignition/ignition_<os>.go` 加平台首启单元。

> 待核实：libkrun 与 applehv 是否共用 vfkit（`apple.go:155` 的 `mc.LibKrunHypervisor != nil` 加 `--nested` 暗示是，但 libkrun/stubber.go 仅 140 行未完整读）；ignition 是否真生成 CoreOS 标准格式（仅读了 schema 文件名，未读 `ignition.go` 515 行主体）。
