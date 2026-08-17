---
source:
  type: "源码解读"
  project: "Podman"
  url: "https://github.com/containers/podman"
title: "Quadlet systemd 集成"
date: "2026-08-17T12:06:00+08:00"
category: [OS, Virtualization, Podman, CodeWiki, "6.2.0-dev"]
tags: ["Podman", "Go", "Quadlet", "systemd", "generator"]
description: "解读 Quadlet：systemd generator 把 .container/.pod/.network 等声明式单元转译成 systemd .service，boot 早期一次性产出后退出。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Podman/CodeWiki/6.2.0-dev/00-overview)

---

## 模块定位

Quadlet 把声明式的 `.container`/`.pod`/`.network`/`.volume`/`.image`/`.kube`/`.build`/`.artifact` 单元文件转译成 systemd `.service`/`.network`，让用户用 systemd 原生方式管理容器生命周期（开机自启、依赖、重启策略）。它不是常驻进程，而是 **systemd generator**——boot 早期被 systemd 调用，一次性产出 `.service` 后退出，无状态、无崩溃面。systemd 随后原生管 start/stop/restart/依赖。

## 模块架构

解析与转换分两层：

- **`pkg/systemd/parser`**（`unitfile.go`）：通用 INI/unit 解析器，`UnitFile`（`:40`）持 `groups []*unitGroup` + `groupByName`，**不感知 Quadlet 语义**，保留注释。
- **`pkg/systemd/quadlet`**（`quadlet.go`）：领域转换层。`UnitInfo`（`:205`，`ServiceName`/`ResourceName`/`ContainersToStart`）做单元间依赖解析；`GroupInfo`（`:216`，`SupportedKeys`）做表驱动校验合法 key；`PodmanCmdline`（`podmancmdline.go:24`）是命令行构建器（`add`/`addf`/`addKeys`/`addBool`）；`groupsInfo` map（`:247`）是每种单元类型的合法 key 白名单。

## 调用链路

`.container → .service` 转换：

```
systemd boot → quadlet-generator 二进制（cmd/quadlet/main.go:429 main）
 └─ process() :440
     ├─ GetUnitDirs(isUserFlag) :479          ── unitdirs.go:42，区分 root/rootless 路径
     ├─ loadUnitsFromDir() :93               ── 逐文件 parser.ParseUnitFile()
     ├─ loadUnitDropins() :129              ── 合并 *.conf drop-in
     ├─ sort by SupportedExtensions :513    ── volume/network 先于 container
     ├─ generateUnitsInfoMap() :371          ── 预算 ServiceName/ResourceName
     ├─ switch ext → ConvertContainer() :537
     ├─ generateServiceFile() :196          ── 原子写入 .service
     └─ enableServiceFile() :237            ── 建 WantedBy/RequiredBy 符号链接

ConvertContainer() (quadlet.go:603):
 ├─ initServiceUnitFile() :606            ── Dup 原文件，[Container]→[X-Container]，加默认依赖
 ├─ createBasePodmanCommand() :660        ── podmanBinary() + --module/GlobalArgs
 ├─ podman.add("run","--name","--replace","--rm") :662-672
 ├─ handleLogDriver/PublishPorts/addNetworks/addVolumes/handleHealth/handlePod
 ├─ lookupAndAddString/AllStrings/Boolean  ── 表驱动 key→flag
 ├─ podman.add(image) :933
 └─ service.AddCmdline("Service","ExecStart", podman.Args) :944
```

分叉点（`cmd/quadlet/main.go:534-558`，switch on suffix）：`.container`→`ConvertContainer`、`.volume`→`ConvertVolume`（`quadlet.go:1108`）、`.network`→`ConvertNetwork`（`:1019`）、`.kube`→`ConvertKube`（`:1234`）、`.image`→`ConvertImage`（`:1364`）、`.build`→`ConvertBuild`（`:1417`）、`.artifact`→`ConvertArtifact`（`:2413`）、`.pod`→`ConvertPod`（`:1609`）。所有 `Convert*` 先 `initServiceUnitFile` 再建 `PodmanCmdline`，差异在子命令（`run`/`create`/`pull`/`build`/`play kube`）和 key 映射表。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `main` in `cmd/quadlet/main.go:429` | generator 入口 | 被 systemd boot 调用 |
| `GetUnitDirs` in `unitdirs.go:42` | 找单元目录 | rootless 走 XDG，root 走 /etc |
| `ConvertContainer` in `quadlet.go:603` | .container→.service | 表驱动 key→flag |
| `initServiceUnitFile` in `quadlet.go:606` | Dup 原文件加默认依赖 | [Container]→[X-Container] |
| `createBasePodmanCommand` in `:660` | 建命令行 | podmanBinary + GlobalArgs |

</details>

## 核心实现

### 解析器/转换器分层

parser 是通用 INI 解析，不感知 Quadlet 语义；quadlet 包做领域转换，复用 parser 的 `Lookup`/`Add`/`AddCmdline`/`Merge`/`Dup`/`RenameGroup`。这种分层让 parser 可被其他 unit-file 场景复用。

### 表驱动 key 映射

两层级：`groupsInfo`（`:247`）做合法性校验（`checkForUnknownKeys` :575 报错）；`ConvertContainer` 内 `stringKeys`/`allStringsKeys`/`boolKeys`（`:693/:712/:724`）将 Quadlet key→podman flag，经 `lookupAndAddString`（`:2090`）等统一处理。无需改 parser 即可加 key。类型分发表 `SupportedExtensions`（`quadlet_common.go:5`）既校验扩展名又定义处理顺序（artifact/image=1, volume/network=2, build=3, container/kube=4, pod=5），`process()` :513 据此排序解决资源名依赖。

### 为什么 generator 而非常驻进程

generator 是 systemd 原生机制，boot 早期一次性产出 `.service` 后退出，无状态、无崩溃面。systemd 原生管 start/stop/restart/依赖/重启策略。注释 `main.go:22-26` 明确 generator 运行在受限环境（无 /var、/home、syslog），代码因此避免重依赖；日志写 `/dev/kmsg`（`main.go:46 logToKmsg`）因为 generator 运行时 journald 未就绪。

### rootless 兼容

`isUserFlag` 从二进制名推断（`main.go:444`）。`GetUnitDirs`（`unitdirs.go:42`）rootless 走 `$XDG_CONFIG_HOME/containers/systemd` + `/etc/containers/systemd/users/$UID`，root 走 `/etc`+`/usr/share`+`/run`。`addDefaultDependencies`（`quadlet.go:2286`）root 用 `network-online.target`，user 用 `podman-user-wait-network-online.service`（user session 无法等 network-online.target，systemd issue #3312）。`GetNonNumericFilter`（`unitdirs.go:204`）防 rootless 递归进其他用户目录。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 解析器/转换器分层 | parser + quadlet | 通用解析与领域转换分离 |
| 表驱动 key 映射 | `groupsInfo`/`stringKeys`/`boolKeys` | 加 key 无需改 parser |
| 类型分发表 | `SupportedExtensions` | 既校验又定顺序 |
| 命令式构建 | `PodmanCmdline.Args` | 不用 text/template，保类型安全 |

## 模块间交互

quadlet import `pkg/systemd/parser`；import `pkg/specgenutilexternal` **仅用 `FindMountType`**（`quadlet.go:2138`），不复用 specgen 主体——有意隔离依赖。`cmd/quadlet/main.go` 是 systemd generator 二进制。`cmd/podman/quadlet/`（install/list/print/remove）是运行时 `podman quadlet` 子命令，管理 Quadlet 源文件，与 generator 解耦。日志走 `pkg/logiface`。

## 扩展方式

新增 `.container` 指令（如 `Foo=`）：

1. `pkg/systemd/quadlet/quadlet.go:59-200` Key 常量块加 `KeyFoo = "Foo"`。
2. `quadlet.go:251-348` `groupsInfo[ContainerGroup].SupportedKeys` 加 `KeyFoo: true`（否则 `checkForUnknownKeys` :575 报错）。
3. `ConvertContainer`（`:603`）内：若直接映射 podman flag，加进 `stringKeys`/`allStringsKeys`/`boolKeys` 之一即可，`lookupAndAdd*` 自动处理；若需特殊逻辑，写显式 `if val, ok := container.Lookup(ContainerGroup, KeyFoo); ok { ... }`。
4. parser 无需改动；man page 另需更新。
