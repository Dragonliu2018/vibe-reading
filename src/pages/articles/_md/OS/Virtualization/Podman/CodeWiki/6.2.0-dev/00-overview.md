---
source:
  type: "源码解读"
  project: "Podman"
  url: "https://github.com/containers/podman"
title: "Overview"
date: "2026-08-17T12:06:00+08:00"
category: [OS, Virtualization, Podman, CodeWiki, "6.2.0-dev"]
tags: ["Podman", "Go", "容器引擎", "OCI", "libpod"]
description: "解读 Podman（containers/podman）的分层架构与同一 CLI 双后端设计：从 cobra 命令到 libpod 运行时与 OCI runtime。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 6.2.0-dev（module v6） · **协议** Apache-2.0 · **语言** Go 1.25.9 · **代码量** ~194,000 行 Go（cmd 33K / libpod 48K / pkg 112K） · **仓库** [GitHub](https://github.com/containers/podman)

---

## 总览

### 项目简介

Podman（Pod Manager）是一个 **daemonless 的 OCI 容器引擎**：管理容器、镜像、卷和 pod 的完整生命周期，提供 Docker 兼容的 CLI 与 REST API，原生支持 rootless、pod 与 systemd 集成。它没有常驻守护进程——每次 `podman` 调用都是独立进程，直接驱动容器运行时；状态持久化到磁盘（SQLite），进程退出后下次调用仍能恢复容器视图。

Podman 建立在 **libpod** 之上——本仓库自带的容器生命周期管理库。`README.md` 把范围界定为：多镜像格式（OCI/Docker）支持、镜像拉取/构建/推送、容器创建/运行/检查点恢复（CRIU）、容器网络（Netavark）、pod、rootless、资源隔离、Docker 兼容 CLI、**无 manager daemon**、Docker 兼容 + Libpod 原生双 REST API、Mac/Windows 经 `podman machine` 虚拟机运行。

**项目边界**：Podman 是编排者与运行时，不是底层能力的实现者——镜像层存储、镜像传输、网络栈、镜像构建、容器监控分别由 `vendor/` 下的 `containers/{storage,image,common}`、`libnetwork`、`buildah`、`conmon` 承担。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| Docker 兼容 CLI | `cmd/podman/` | cobra 命令树，`registry.Commands` 注册 |
| 容器/pod 生命周期 | `libpod/` | Runtime/Container/Pod，SQLite 状态 |
| OCI spec 生成 | `pkg/specgen/`、`pkg/specgen/generate/` | SpecGenerator → `spec.Spec` |
| REST API 服务端 | `pkg/api/` | Docker 兼容 + Libpod 双协议 |
| Go API 客户端 | `pkg/bindings/` | Tunnel 模式 HTTP 客户端 |
| Rootless | `pkg/rootless/` | 无 root 运行，reexec 降权 |
| Quadlet | `pkg/systemd/`、`cmd/quadlet/` | `.container` 等 → systemd `.service` |
| K8s YAML 互操作 | `pkg/domain/infra/abi/{play,generate}.go`、`libpod/kube.go` | `podman kube play/generate` |
| Mac/Win 虚拟机 | `pkg/machine/` | `podman machine`，VM 内再跑 podman |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| cobra/spf13 | 核心 | CLI 命令树与 flag 解析 |
| gorilla/mux | 核心 | REST API 路由 |
| go.etcd.io/bbolt | 遗留 | 旧状态后端（6.0 移除，仅迁移 shim） |
| database/sql + modernc.org/sqlite | 核心 | SQLite 状态持久化（6.x 默认） |
| opencontainers/runtime-tools | 核心 | OCI runtime-spec 构造 |
| opencontainers/runtime-spec | 核心 | `spec.Spec` 类型定义 |
| containers/image | 核心（vendor） | 镜像拉取/推送/签名 |
| containers/storage | 核心（vendor） | overlayfs 层存储 |
| containers/common/libnetwork | 核心（vendor） | Netavark/CNI/pasta 网络后端 |
| buildah | 核心（vendor） | 镜像构建（`podman build`） |
| conmon | 外部二进制 | 容器监控进程（fork OCI runtime） |
| gvisor-tap-vsock / vfkit / libhvee | 可选 | `podman machine` 端口转发与虚拟化 |
| sigs.k8s.io/yaml | 核心 | K8s YAML 序列化 |

### 版本历史

Podman 每年 2/5/8/11 月发布主/次版本。当前 `main` 分支为 **6.2.0-dev**（`version/rawversion/version.go:7`）。关键里程碑：v3 引入 `podman machine`；v4 重构 REST API（Docker + Libpod 双树）；**v6.0 移除 BoltDB 状态后端，强制迁移 SQLite**（`libpod/runtime.go:301-322` 报错引导用户 `podman system migrate --migrate-db`）。本文基于 6.2.0-dev 解读。

---

## 快速上手

最简方式是安装发行版包后直接跑一个容器验证：

```bash title="外部验证"
# Linux：装好 podman 后，无需 daemon 直接运行
podman run quay.io/podman/hello
# 预期：拉取 hello 镜像并打印欢迎信息，退出码 0
```

从源码构建（Linux，后端开发环境）：

```bash title="从源码构建"
cd /path/to/podman
make binaries        # 产物：bin/podman、bin/podman-remote、bin/podman-testing
./bin/podman run quay.io/podman/hello
```

验证 REST API（`podman system service` 启动服务端）：

```bash title="REST API 验证"
podman system service --time=0 &
curl --unix-socket /run/podman/podman.sock http://d/v5.0.0/libpod/info | head
```

> 仅给"用户视角操作"。内部 main 走了哪些步骤、连接怎么建立，见「运行时行为 > 启动流程」。macOS/Windows 用 `podman machine init && podman machine start` 起 VM。

---

## 架构设计解析

### 系统架构

Podman 的核心设计思想是 **"同一 CLI，双后端"**：上层 cobra 命令只写一遍，通过 `ContainerEngine`/`ImageEngine` 接口抽象后端，由 `pkg/domain/infra` 工厂按 `EngineMode` 在编译期/运行期分叉为 **ABI（本地，进程内直连 libpod）** 与 **Tunnel（远程，经 bindings HTTP 客户端）**。两条路径最终都汇聚到 `libpod.Runtime`——远程服务端的 handler 同样调用 libpod 函数。这样实现了"本地零延迟、远程透明"的统一体验，也让 macOS/Windows 客户端（无法本地跑 Linux 容器）天然走 Tunnel。

![Podman 分层架构](/vibe-reading/images/articles/podman-internals/architecture.svg)

如图，纵向分四层加一个集成层：CLI 命令经引擎抽象层分叉为 ABI/Tunnel 两路；ABI 直连 libpod + specgen 装配 OCI spec 再交给 OCI runtime；Tunnel 经 bindings→`pkg/api` 服务端再回到 libpod（合流点）；quadlet/kube/machine/rootless 作为集成层消费或复用 libpod/specgen。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| CLI 入口层 | `cmd/podman/` | 解析用户命令，注册 cobra 树；不含业务逻辑 |
| 引擎抽象层 | `pkg/domain/`（entities + infra） | 定义 `ContainerEngine`/`ImageEngine` 门面接口，按 `EngineMode` 分叉后端，解耦 CLI 与运行时 |
| 运行时层（本地） | `libpod/`、`pkg/specgen/` | 承载容器/pod/状态/锁/网络的真实实现，生成 OCI spec |
| 传输/服务层（远程） | `pkg/api/`（server）、`pkg/bindings/`（client） | 把后端能力经 HTTP 暴露，使远程客户端与本地等价 |
| 集成/扩展层 | `pkg/systemd/`、`pkg/k8s.io`、`pkg/machine/`、`pkg/rootless/` | 消费 libpod 或复用 specgen，对接 systemd/K8s/虚拟机/rootless 生态 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | ABI vs Tunnel（`pkg/domain/infra/runtime_abi.go` / `runtime_tunnel.go`） | 同一接口两套实现，CLI 无感知切换本地/远程 |
| 工厂 | `infra.NewContainerEngine`、`libpod.NewRuntime` | 按 config/EngineMode 生产运行时对象 |
| 门面 | `entities.ContainerEngine`/`ImageEngine`（`//nolint:interfacebloat` 有意） | 聚合上百个操作为一个大接口，简化命令侧调用 |
| State/Repository | `libpod.State` 接口 + `SQLiteState` | 解耦状态存储与运行时逻辑，支持换后端 |
| 模板方法 | `prepareToStart`（`container_internal.go:819`） | 固定启动骨架（依赖检查→prepare→init→start），子步骤填充 |
| 适配器（双向） | `pkg/specgen/generate/kube`、`libpod/kube.go` | K8s 资源 ↔ podman 资源互转 |
| 解析器/转换器 | `pkg/systemd/parser` + `quadlet` | 通用 INI 解析与 Quadlet 领域转换分层 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Runtime` | 顶层运行时单例，持有所有子系统 | 进程级（`sync.Once` 单例） | 持有 State/store/OCIRuntime/network |
| `Container` | 容器实体，config+state 分离 | 落盘 SQLite，进程退出仍在 | 归属 Pod、持 OCIRuntime |
| `Pod` | 容器组，经 infra container 共享 namespace | 落盘 SQLite | 含多个 Container |
| `SpecGenerator` | 用户意图的容器规格 | 单次创建请求 | → `spec.Spec`（OCI） |
| `APIServer` | REST 服务端，内嵌 http+grpc | `podman system service` 期间 | 持 `*libpod.Runtime` |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `entities.ContainerEngine` | `pkg/domain/entities/engine_container.go` | `abi.ContainerEngine`、`tunnel.ContainerEngine` | `infra.NewContainerEngine` 按 EngineMode 选 |
| `entities.ImageEngine` | `pkg/domain/entities/engine_image.go` | `abi.ImageEngine`、`tunnel.ImageEngine` | 同上 |
| `libpod.State` | `libpod/state.go:20` | `SQLiteState`、`BoltState`(遗留) | `getDBState`（`runtime.go:290`）按 config 选 |
| `libpod.OCIRuntime` | `libpod/oci.go:21` | `ConmonOCIRuntime` | `newConmonOCIRuntime` 在 `NewRuntime` 时建 |
| `machine.VMProvider` | `pkg/machine/vmconfigs/config.go:61` | AppleHV/LibKrun/WSL/HyperV/QEMU Stubber | 平台 build tag + `GetByVMType` |

---

## 代码目录

```
podman/
├── cmd/                 # 二进制入口
│   ├── podman/          # 主 CLI（cobra 命令树 + registry）
│   ├── quadlet/         # Quadlet systemd generator 二进制
│   ├── rootlessport/   # rootless 端口转发守护
│   └── podman-{mac-helper,wslkerninst,testing,winpath}/
├── libpod/             # 核心运行时库（48K 行）
│   ├── runtime.go      # Runtime 顶层 + NewRuntime 工厂
│   ├── container*.go    # Container 实体与生命周期
│   ├── pod.go           # Pod 与 infra container
│   ├── sqlite_state.go # State 的 SQLite 实现（默认）
│   ├── oci*.go          # OCIRuntime（conmon 封装）
│   └── {define,lock,events,layers,logs,namesgenerator,plugin,shutdown}/
├── pkg/
│   ├── domain/          # 引擎抽象层（entities 接口 + infra abi/tunnel）
│   ├── api/             # REST 服务端（handlers/{compat,libpod,grpc}）
│   ├── bindings/        # Go HTTP 客户端（按资源分包子）
│   ├── specgen/         # SpecGenerator + generate（→ OCI spec）
│   ├── systemd/         # Quadlet 转译器
│   ├── machine/         # Mac/Win 虚拟机（provider 策略）
│   ├── k8s.io/          # vendored K8s API 类型
│   ├── rootless/        # rootless 检测与降权
│   └── {util,auth,checkpoint,emulation,farm,...}/
├── internal/            # 进程内辅助（domain/localapi）
├── test/                # 测试（e2e/system/apiv2/build/compose）
├── vendor/              # 依赖源码（containers/* 等，不可手改）
├── version/             # 版本号与 API 版本表
└── docs/                # 文档源（rst）
```

> 只解释一级与关键二级目录；逐文件分析留给各模块文档。`vendor/` 是外部依赖，**绝不手改**（用 `go get` + `make vendor`）。`test/` 分层见「测试体系」。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/podman-internals/module-dependencies.svg)

依赖方向以 **libpod 为枢纽**：上层 `cmd/podman → pkg/domain`，domain 再分叉到 `libpod`（ABI）与 `pkg/bindings`（Tunnel）；`pkg/api` 服务端经 abi 回到 libpod；`pkg/specgen/generate` import libpod；quadlet 在运行时 exec podman；kube 直接调 libpod 与 specgen；machine 经 bindings 连 VM 内的 podman。所有路径终态都是 libpod。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| libpod 核心运行时 | 容器/pod/状态/锁/网络真实实现 | `libpod/runtime.go:NewRuntime` | 承载全部生命周期逻辑，是双后端的合流点 | [libpod 核心运行时](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/01-libpod-runtime) |
| Domain 引擎层 | Engine 接口 + ABI/Tunnel 分叉 | `pkg/domain/infra/runtime.go` | 把 CLI 与后端解耦，本地/远程等价 | [Domain 引擎层](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/02-domain-engine) |
| REST API 服务端 | Docker+Libpod 双协议 HTTP | `pkg/api/server/server.go` | 暴露远程能力，复刻 Docker 生态兼容性 | [REST API 服务端](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/03-api-server) |
| Bindings 客户端 | Go HTTP 客户端 | `pkg/bindings/connection.go` | Tunnel 模式底层，对齐 ABI 接口 | [Bindings 客户端](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/04-bindings-client) |
| Podman Machine | Mac/Win 虚拟机 | `pkg/machine/shim/host.go` | 非 Linux 内核跑容器，VM 内再起 podman | [Podman Machine](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/05-machine-vm) |
| Specgen | 用户意图→OCI spec | `pkg/specgen/generate/container_create.go` | 三处输入（CLI/REST/Quadlet）统一归一化 | [Specgen](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/06-specgen) |
| Quadlet | `.container`→`.service` 转译 | `pkg/systemd/quadlet/quadlet.go` | systemd 原生管理容器生命周期 | [Quadlet](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/07-quadlet) |
| K8s YAML 互操作 | K8s↔podman 双向转换 | `pkg/domain/infra/abi/play.go` | 与 K8s 生态互操作 | [Kube](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/08-kube) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

`podman` 进程启动（`cmd/podman/main.go:49 main`）：

```
main()
 ├─ reexec.Init()                         # 检查是否 reexec 子进程（如 podman top）
 │    命中注册名则跑注册函数后 return，不进 cobra
 ├─ logiface.SetLogger(logrusLogger{})
 ├─ parseCommands()                       # 遍历 registry.Commands 装配 cobra 树
 │    按 EngineMode 标注过滤/隐藏不支持的子命令
 └─ Execute() (root.go:138)
     └─ rootCmd.ExecuteContextC(...)
         └─ PersistentPreRunE (root.go:266)
             ├─ setupRemoteConnection     # 解析 --url/--connection
             ├─ registry.NewContainerEngine(cmd)        # registry.go:65
             │    └─ infra.NewContainerEngine(&podmanOptions)
             │         switch EngineMode {  ★分叉点（runtime_abi.go:16）
             │         ABIMode:   NewLibpodRuntime → abi.ContainerEngine{Libpod}
             │         TunnelMode: bindings.NewConnectionWithOptions → tunnel.ContainerEngine{ClientCtx}
             │         }
             └─ registry.NewImageEngine()  # 同理
```

对象装配要点：配置来自 `containers.conf`（`pkg/domain/infra` 读 `config.Default()`）+ 命令行 flag 覆盖；`libpod.Runtime` 用 `sync.Once` 单例创建（`runtime_libpod.go:43`）；`EngineMode` 由 `registry/config.go:175` 依 `--remote`/URI 设定，命令级还可用 cobra `Annotations[EngineMode]` 标注仅 ABI 或仅 Tunnel。

### 核心运行流程

下面覆盖 Podman 最核心的三条链路：本地容器运行（ABI）、远程容器运行（Tunnel，与 ABI 在 libpod 合流）、Quadlet 启动。三者共享"SpecGenerator → OCI spec → libpod → OCI runtime"的尾段。

#### 本地路径：`podman run`（ABI 模式）

![podman run 数据流](/vibe-reading/images/articles/podman-internals/data-flow.svg)

如图，请求在 `infra.NewContainerEngine` 分叉为 ABI/Tunnel 两路，ABI 直连 libpod，Tunnel 经 bindings→`pkg/api` 服务端再回到 libpod（★合流点），两路共享 `Container.Start → ociRuntime → conmon → runc/crun` 尾段。

文字描述：`run` 命令（`cmd/podman/containers/run.go:108`）用 `specgen.NewSpecGenerator` + `specgenutil.FillOutSpecGen` 把 flag 归一化进 `SpecGenerator`，再调 `registry.ContainerEngine().ContainerRun`。ABI 实现里 `generate.CompleteSpec`（`pkg/domain/infra/abi/containers.go:1181`）补全镜像字段，`generate.MakeContainer`（`pkg/specgen/generate/container_create.go`）把 SpecGenerator 装配成 `spec.Spec`，`ExecuteCreate` 调 `libpod.Runtime.NewContainer` 落盘 SQLite，最后 `Container.Start` 走 `init → ociRuntime.CreateContainer`（fork conmon，conmon 再 exec runc/crun）与 `start`。数据结构演变：`os.Args → ContainerRunOptions → SpecGenerator → spec.Spec → libpod.Container → conmon PID`。

#### 远程路径：`podman --remote run`（Tunnel 模式）

Tunnel 在同一 `ContainerEngine` 接口下走另一实现：`tunnel.ContainerEngine.ContainerRun`（`pkg/domain/infra/tunnel/containers.go:888`）调 `bindings.CreateWithSpec`（`pkg/bindings/containers/create.go:14`），把 SpecGenerator JSON 序列化后 `POST /v?/libpod/containers/create`；服务端 handler（`pkg/api/handlers/libpod/containers_create.go:34`）从 context 取 `*libpod.Runtime`，构造 `abi.ContainerEngine{Libpod: runtime}`，**调用同一套 `generate.MakeContainer`/`ExecuteCreate`**——分叉点在 `runtime_abi.go:16`，合流点在 libpod 内部。随后 `bindings.Start`/`Attach`（HTTP hijack 长连接流式 attach）与服务端 `Container.Start` 对接。关键设计：SpecGenerator 在客户端构造、JSON 传输、服务端反序列化复用，使 `MakeContainer` 之后的路径（含 OCI runtime fork）对两种模式共享。

#### 集成路径：Quadlet 开机自启

Quadlet 不是常驻进程，而是 systemd generator：boot 早期 `cmd/quadlet/main.go:429` 被 systemd 调用，扫描 `*.container` 等单元文件，经 `pkg/systemd/parser` 解析、`pkg/systemd/quadlet/ConvertContainer` 转译成 `podman run ...` 的 `.service`，落盘到 systemd 输出目录后退出。systemd 随后按依赖启动这些 `.service`，即"运行时 exec podman run"——回到上面 ABI 路径。详见 [Quadlet 模块](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/07-quadlet)。

### 状态流

容器生命周期状态由 `libpod` 的 `ContainerState` 枚举驱动（`libpod/define/containerstate.go`）：

![容器状态流](/vibe-reading/images/articles/podman-internals/state-flow.svg)

状态定义在 `libpod/container.go` 的 `ContainerState`；转换方法在 `container_internal.go`：`init()`（Created→Running 前的装配）、`start()`（→Running）、`stop()`/`KillContainer`（→Exited）、`cleanup()`/`Remove`（→Removed）。`refresh()`（`runtime.go:893`）在系统重启后重建运行时状态——config 落盘 SQLite 不丢，state 存于运行时（tmpfs/进程）reboot 后需重建。

---

## 典型修改场景

#### 场景 1：新增一个 top-level 命令（如 `podman foo`）

需在接口 + ABI + Tunnel 三处同步落地：`pkg/domain/entities/engine_*.go` 加 `Foo` 方法签名 + `FooOptions/Report`；`pkg/domain/infra/abi/foo.go` 委托 `ic.Libpod`；`pkg/domain/infra/tunnel/foo.go` 委托 `bindings`（同时 `pkg/bindings` 加 client）；`cmd/podman/foo.go` 加 cobra command，RunE 调 `registry.ContainerEngine().Foo`。对应测试 `test/e2e/`。

#### 场景 2：新增一个 `podman run` 选项（如新挂载类型）

`pkg/specgen/specgen.go` 的 `ContainerStorageConfig` 加字段（带 JSON tag）；`pkg/specgenutil/specgen.go:FillOutSpecGen` 加归一化赋值；`pkg/specgen/generate/oci_linux.go:SpecGenToOCI` 加 OCI 映射；`pkg/domain/entities` 与 CLI flag 定义同步。详见 [Specgen 模块](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/06-specgen)。

#### 场景 3：新增一个 Quadlet 指令（如 `Foo=`）

`pkg/systemd/quadlet/quadlet.go` Key 常量块加 `KeyFoo`；`groupsInfo[ContainerGroup].SupportedKeys` 加白名单；`ConvertContainer` 内按 key→flag 映射加入 `stringKeys/boolKeys` 或写显式 `Lookup` 分支。parser 无需改动。详见 [Quadlet 模块](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/07-quadlet)。

---

## 测试体系

```
test/
├── e2e/            # Go 端到端测试（~142 个 _test.go，主套件）
├── system/         # 系统/bash 集成测试
├── apiv2/          # API v2 测试
├── build/          # 构建相关测试
├── compose/        # podman-compose 兼容
└── {checkseccomp,tools,utils,upgrade,version}/
```

| 代码层 | 测试类型 |
| --- | --- |
| `libpod` 运行时 | `test/e2e`（端到端，启动真实容器）|
| `pkg/api` handler | `test/e2e` + `test/apiv2` |
| `pkg/bindings` | `test/e2e`（经 REST 往返）|
| `pkg/specgen`/`systemd` | `test/e2e` + 单元自测 |
| 全量 PR 校验 | `make validatepr`（lint + shfmt + swagger + 自检）|

`make localintegration` 跑集成测试，`make localsystem` 跑系统测试。`test/e2e` 是最接近"可执行文档"的入口——理解某命令行为可先看其 e2e 用例。

---

## 阅读源码推荐路线

- **第一遍：理解主流程（ABI）**
  `cmd/podman/main.go:main` → `root.go:Execute/PersistentPreRunE` → `registry/registry.go:NewContainerEngine` → `pkg/domain/infra/runtime_abi.go:NewContainerEngine`（分叉）→ `libpod/runtime.go:NewRuntime` → `libpod/container_api.go:Container.Start`
- **第二遍：理解双后端合流**
  `pkg/domain/infra/abi/containers.go:ContainerRun` vs `pkg/domain/infra/tunnel/containers.go:ContainerRun` → 两路都到 `pkg/specgen/generate/container_create.go:MakeContainer` 与 `libpod.Runtime.NewContainer`
- **第三遍：理解核心数据结构**
  `libpod/runtime.go:Runtime`、`libpod/container.go:Container`（config vs state）、`libpod/state.go:State` 接口 + `sqlite_state.go`、`libpod/pod.go:Pod`（infra container）
- **第四遍：选模块深入**
  REST 兼容看 `pkg/api/server/register_*.go` + `handlers/{compat,libpod}`；Quadlet 看 `pkg/systemd/quadlet/quadlet.go:ConvertContainer`；machine 看 `pkg/machine/shim/host.go`；kube 看 `pkg/domain/infra/abi/play.go:PlayKube`

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| ABI 模式 | 本地后端，进程内直连 libpod（`ABIMode`） |
| Tunnel 模式 | 远程后端，经 bindings HTTP 客户端（`TunnelMode`） |
| infra container | Pod 中持有共享 namespace 的锚进程 |
| conmon | 容器监控进程，libpod fork 它，它再 exec runc/crun |
| Quadlet | 把声明式单元文件转 systemd `.service` 的 generator |
| specgen | 把用户意图（SpecGenerator）转 OCI runtime-spec 的层 |
| EngineMode | `abi`/`tunnel`，决定后端分叉（`entities/types.go`） |

### 参考资料

- [Podman 官方文档](https://docs.podman.io/)
- 仓库内 `AGENTS.md`（贡献者/AI 指南）、`ROADMAP.md`、`RELEASE_NOTES.md`
- `docs/source/Commands.rst`（完整命令面）
