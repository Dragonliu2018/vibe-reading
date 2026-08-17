---
source:
  type: "源码解读"
  project: "Podman"
  url: "https://github.com/containers/podman"
title: "Specgen OCI 规格生成"
date: "2026-08-17T12:06:00+08:00"
category: [OS, Virtualization, Podman, CodeWiki, "6.2.0-dev"]
tags: ["Podman", "Go", "SpecGenerator", "OCI", "spec"]
description: "解读 pkg/specgen：SpecGenerator 把用户意图转为 OCI runtime-spec，specgenutil 归一化 CLI/REST/Quadlet 三处输入。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/00-overview)

---

## 模块定位

`pkg/specgen` + `pkg/specgenutil` 是 Podman "用户输入 → 可执行容器规格"的**核心转换层**。`specgen` 定义 `SpecGenerator`（表达用户意图：RestartPolicy、HealthCheck、Pod 归属、Secrets 等 podman 概念），`pkg/specgen/generate` 把它装配成标准 OCI `spec.Spec`（运行时执行规格），`specgenutil` 做客户端侧归一化，统一 CLI、REST API、Quadlet 三处输入。specgen 只 import `libpod/define`（常量/错误），不 import libpod 运行时——保持纯数据结构，可 JSON 序列化在客户端构造、传到服务端装配。

## 模块架构

```go title="pkg/specgen/specgen.go:628"
type SpecGenerator struct {
    ContainerBasicConfig       // Name, Command, Entrypoint, Env, Labels, RestartPolicy, Systemd...
    ContainerStorageConfig     // Image, Rootfs, Mounts, Volumes, Devices, IpcNS, ShmSize...
    ContainerSecurityConfig    // Privileged, User, CapAdd/Drop, SeccompPolicy, UserNS, IDMappings...
    ContainerCgroupConfig      // CgroupNS, CgroupParent, CgroupsMode
    ContainerNetworkConfig     // NetNS, PortMappings, Networks, DNSServers, HostAdd...
    ContainerResourceConfig    // ResourceLimits, Rlimits, OOMScoreAdj, WeightDevice...
    ContainerHealthCheckConfig // HealthData, StartupHealthConfig, HealthLogDestination...
    cacheLibImage              // 本地模式缓存 *libimage.Image；远程模式为空 stub
}
```

`SpecGenerator` 嵌入 7 个子配置 struct 分组管理，带 JSON tag 可序列化。构造 `NewSpecGenerator(arg, rootfs)`（`:673`）按 rootfs 参数决定填 Image 还是 Rootfs。分三层：`specgen`（纯数据结构）、`specgenutil`（客户端归一化）、`generate`（服务端 OCI spec 装配，import libpod）。

## 调用链路

```
cmd/podman/containers/run.go                 ── CLI 解析 flags → entities.ContainerCreateOptions
  ↓ specgenutil.FillOutSpecGen(s, &cliVals, args)        ── 客户端归一化
  ↓ （远程模式: SpecGenerator JSON 序列化传到服务端）
pkg/domain/infra/abi/containers.go:841
  ↓ generate.CompleteSpec(ctx, rt, s)                    ── 服务端: 从 image 填充缺失字段
  ↓ generate.MakeContainer(ctx, rt, s, clone, c)        ── 编排: namespace 默认值→Validate→finalizeMounts→SpecGenToOCI
  ↓ generate.ExecuteCreate(ctx, rt, rtSpec, s, ...)     ── → libpod.Runtime.NewContainer()
```

`SpecGenToOCI`（`pkg/specgen/generate/oci_linux.go:103`）是核心装配，用 `generate.New("linux")`（OCI runtime-tools）创建 Generator，逐项映射 SpecGenerator 字段到 `*spec.Spec`：`g.SetProcessArgs(makeCommand(s, imageData))`、`g.SetProcessCwd(s.WorkDir)`、`g.AddProcessEnv`、`specConfigureNamespaces`（PidNS/IpcNS/UtsNS/UserNS/NetNS/CgroupNS → `g.AddOrReplaceLinuxNamespace`）、`securityConfigureGenerator`（CapAdd/Drop/Seccomp/SELinux/Apparmor）、`SupersedeUserMounts`（用户 mounts 覆盖默认 mounts）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `NewSpecGenerator` in `specgen.go:673` | 初始化 SpecGenerator | 按 rootfs 决定 Image/Rootfs |
| `FillOutSpecGen` in `specgenutil/specgen.go:324` | 客户端归一化 | 统一 CLI/REST/Quadlet 输入 |
| `CompleteSpec` in `generate/container.go` | 服务端补全镜像字段 | 远程模式不依赖 libimage |
| `MakeContainer` in `generate/container_create.go:33` | 编排装配 | namespace 默认值→Validate→SpecGenToOCI |
| `SpecGenToOCI` in `generate/oci_linux.go:103` | 核心装配 OCI spec | 用 runtime-tools Generator 逐项映射 |

</details>

## 核心实现

### 为什么需要 SpecGenerator 中间层

直接填 OCI spec 不够，原因有三：

1. **抽象层级差距**：OCI spec 是低级运行时规格（process/mounts/linux/namespaces），缺 Podman 概念（RestartPolicy、HealthCheck、Pod 归属、LogConfig、Secrets、Init）。SpecGenerator 表达"用户意图"，OCI spec 表达"运行时执行规格"。
2. **客户端/服务端分离**：build tag `!remote`/`remote` 控制 `cacheLibImage`（`specgen_local.go` vs `specgen_remote.go`）。远程客户端不需 `libimage` 依赖（减二进制体积），SpecGenerator 可 JSON 序列化后在客户端填充、传到服务端装配。直接传 OCI spec 无法实现此分离（不含 podman 元数据）。
3. **三处输入统一归一化**：`FillOutSpecGen` 统一 CLI、REST、Quadlet 输入。归一化解决：端口格式解析（`[[hostIP:]hostPort:]containerPort`）、ulimit 解析、namespace 字符串→Namespace struct、资源单位转换（`units.RAMInBytes`）、env-file 合并优先级。逻辑做一次，避免三处重复。

### 装配流程

`MakeContainer`（`generate/container_create.go:33`）编排：设 namespace 默认值 → `Validate` → `finalizeMounts` → `SpecGenToOCI` 产出 `*spec.Spec` + `[]CtrCreateOption`，`ExecuteCreate`（`:335`）调 `libpod.Runtime.NewContainer`。libpod 接收已装配好的 `*spec.Spec` + `*SpecGenerator`，创建时落盘基础 spec，启动时 `generateSpec`（见 [libpod 模块](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/01-libpod-runtime)）注入运行时信息再生成最终 spec。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 配置对象 | `SpecGenerator` 7 子 struct | 结构化配置，可 JSON 序列化复用 |
| Builder/Generator | `SpecGenToOCI` 用 runtime-tools Generator | 逐步 `AddMount`/`AddProcessEnv` 构建 spec |
| 归一化中间层 | `specgenutil.FillOutSpecGen` | 三处输入统一 |

## 模块间交互

`specgen` import `libpod/define`（常量/错误），不 import libpod 本体。`specgenutil` import `specgen`、`libpod/define`、`pkg/domain/entities`。`generate` import `libpod`（Runtime/Pod/Container）、`specgen`、`specgenutil`，是服务端装配层。libpod 被调用方：`generate.ExecuteCreate → rt.NewContainer`。Quadlet 生成 `podman run` CLI 走标准 CLI 路径，不直接调 specgen API，仅用 `specgenutilexternal` 解析 mount 类型。

## 扩展方式

新增一个 run 选项（如新挂载类型）：

1. **specgen 层**：`pkg/specgen/specgen.go` 的 `ContainerStorageConfig`（`:239`）加字段，带 JSON tag。
2. **specgenutil 层**：`FillOutSpecGen`（`specgen.go:324`）加 `c.Xxx → s.Xxx` 赋值；有解析需求在 `pkg/specgenutil/volumes.go` 加函数。
3. **generate 层**：`SpecGenToOCI`（`generate/oci_linux.go:103`）的 mounts 段（`:326` `SupersedeUserMounts`）或 `finalizeMounts`（`generate/container.go`）加 OCI 映射。
4. **entities 层**：`pkg/domain/entities/container_create.go` 的 `ContainerCreateOptions` 加 CLI flag 对应字段；`cmd/podman/containers/` 加 flag 定义。
