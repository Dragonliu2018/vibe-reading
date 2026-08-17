---
source:
  type: "源码解读"
  project: "WSL"
  url: "https://github.com/microsoft/WSL"
title: "Linux 初始化子系统"
date: "2026-08-16T00:15:00+08:00"
category: [OS, Virtualization, WSL, CodeWiki, "2.9.3"]
tags: ["WSL", "C/C++", "Windows", "Linux", "虚拟化", "容器"]
description: "WSL2 VM 内的 usermode 初始化——mini_init/init/session leader/relay 的 fork+exec 链、namespace 隔离与 hvsocket 消息循环。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/WSL/CodeWiki/2.9.3/00-overview)

---

## 模块定位

`src/linux/init/` 是运行在 WSL2 虚拟机内的 usermode 初始化代码，~25,000 行 C。它承担两个层次的初始化：**mini_init**（VM 级 PID 1，负责挂载基础文件系统、配置网络、按需 fork 出各分发版 init）与 **init**（分发版级 PID 1，负责解析 `/etc/wsl.conf`、注册 binfmt 互操作、创建 session leader、启动 systemd）。同一个 `/init` 二进制通过 `argv[0]` 与 PID 还身兼 `gns`（网络配置）、`relay`（IO 中继）、`plan9`（文件服务）、`localhost`（网络转发）、`mount.drvfs`（驱动挂载）等多职。

这个模块是 WSL2 Linux 侧的运行时基石：wslservice.exe 拉起轻量 VM 后，VM 内第一条用户态指令就是 `/init`。从 VM 启动到用户敲下 `bash` 的整条 fork+exec 链、命名空间隔离、hvsocket 双向通信协议、互操作与 DNS 隧道，都落在这 ~25k 行里。它把"一个 Windows 进程的 IO 请求"翻译成"VM 内一棵 Linux 进程树"。

## 模块架构

WSL2 的 Linux 侧是一个分层 fork 的进程树，每个节点是 `/init` 二进制以不同 `argv[0]` 重 exec 自身。下图展示核心进程节点与静态职责关系（方法调用留给「调用链路」）：

![Linux 初始化子系统进程树](/vibe-reading/images/articles/wsl-internals/linux-init-architecture.svg)

整个子系统的内部结构可分四层来理解：

- **VM 级初始化层（mini_init）**：`main()`（`main.cpp:3660`）在 PID 1 启动，挂载 `/proc`/`/sys`/`/dev`、创建 `/mnt/wsl` 跨分发版共享 tmpfs、注册 binfmt 互操作解释器，然后进入 hvsocket 消息循环等待 wslservice 的指令。它不直接运行分发版，而是收到 `LxMiniInitMessageLaunchInit` 后在独立 namespace 中 fork 出分发版 init。
- **分发版级初始化层（init）**：`InitEntry()`（`init.cpp:2154`）在新 namespace 内以 PID 1 启动，`ConfigInitializeCommon()` 解析 `/etc/wsl.conf`，可选地延迟启动 systemd，建立与 wslservice 的第二条 hvsocket 通道（fd 100），进入 `InitEntryUtilityVm()`（`init.cpp:2207`）的消息循环处理 session 创建/初始化/终止。
- **会话与进程创建层（session leader + relay）**：`InitCreateSessionLeader()`（`init.cpp:1097`）fork 出 session leader，与一个 Windows console 一一对应；session leader 收到 `LxInitMessageCreateProcessUtilityVm` 后再 fork 出 **relay** 进程，relay 经 `forkpty()` 创建 PTY 并 fork 出真正的用户进程。中间层 relay 的存在让 session leader 不被 IO 阻塞、能持续处理后续请求。
- **辅助服务层（gns / plan9 / localhost）**：都是 init/mini_init 经 `execl(LX_INIT_PATH, ...)` 以特定 `argv[0]` 重新 exec 出的子进程——`gns`（`GnsEngine.cpp`）处理 HNS 下发的网络配置，`plan9`（`plan9.cpp`，实现在 `src/linux/plan9/` 静态库 `libplan9`）提供 9P 文件服务，`localhost`（`localhost.cpp`）做端口转发。

之所以把 init 与 mini_init 放进**同一个二进制**而非两个，是因为 VM 的最小化 rootfs 只装得下一个 `/init` 文件就需覆盖所有功能；`argv[0]` + PID 的双重判定避免了额外参数解析，也省去了分发版自带 init 二进制——mini_init 在 chroot 前把 `/init` self-bind-mount 进分发版根目录（`LaunchInit` in `main.cpp:1618`），分发版 init 在新 namespace 里仍能找到 `/init`。

## 调用链路

一次"在 Windows 终端敲 `wsl`，得到一个 bash"的端到端 fork+exec 链，贯穿三层消息循环：

链路的关键数据结构与流转：wslservice 发 `LxMiniInitMessageEarlyConfig` → mini_init 填充 `VmConfiguration`（`main.cpp:106`，含 GPU/GUI/网络模式）；发 `LxMiniInitMessageLaunchInit` → mini_init 在 `CLONE_NEWIPC|CLONE_NEWNS|CLONE_NEWPID|CLONE_NEWUTS`（`main.cpp:2972`）的新 namespace 中执行 `ProcessLaunchInitMessage` → `LaunchInit` 挂载分发版 VHD、chroot、`execle("/init")` 成为分发版 init。分发版 init 的 `InitEntryUtilityVm()`（`init.cpp:2451`）在 `poll(channel.Socket(), signalFd)` 上循环：收到 `LxInitMessageCreateSession` → `InitCreateSessionLeader()` fork session leader；session leader 收到 `LxInitMessageCreateProcessUtilityVm` → `InitCreateProcessUtilityVm()`（`init.cpp:1317`）fork relay。

**relay 双进程模型**是整条链最精巧的设计：relay 先 `UtilListenVsockAnyPort` 创建 5 个 hvsocket 端口（stdin/stdout/stderr/control/terminal）并把端口号经 `Transaction.SendResultMessage<uint32_t>` 告知 wslservice；随后 `fork()`，子进程 `forkpty()` 创建 PTY——PTY 的子进程 `dup2` 设好 std fd 后 `execvpe` 成用户进程（如 `/bin/bash`），PTY 的父进程成为 relay，`prctl(PR_SET_CHILD_SUBREAPER)` 后在 `poll()` 上双向中继 hvsocket↔PTY/pipe。设计 relay 这层中间进程，是为了让 session leader fork 后立即返回继续消息循环（否则会被 IO 中继阻塞，无法处理后续进程创建请求）；`PR_SET_CHILD_SUBREAPER` 则防止用户进程的孤儿子进程重新 parent 到 init（PID 1），避免 init 误收 SIGCHLD。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `main()` `main.cpp:3660` | `/init` 总入口，按 PID+argv[0] 分发角色 | 同二进制多角色 |
| `WslEntryPoint()` `init.cpp:169` | 非 PID 1 时按 argv[0] 路由（init/gns/plan9/localhost/...） | argv[0] 派发 |
| `Initialize()` `main.cpp:1269` | mini_init 基础挂载 + `/mnt/wsl` tmpfs + binfmt 注册 | `MS_SHARED` 跨 namespace 传播 |
| `ProcessLaunchInitMessage()` `main.cpp:2194` | 挂载 VHD、chroot、exec 分发版 init | clone namespace 隔离 |
| `InitEntryUtilityVm()` `init.cpp:2207` | 分发版 init 消息循环 | systemd 延迟启动 |
| `InitCreateSessionLeader()` `init.cpp:1097` | 创建 session leader，一一对应 Windows console | `setsid()`+`TIOCSCTTY` |
| `InitCreateProcessUtilityVm()` `init.cpp:1317` | fork relay、协商 5 个 hvsocket 端口 | relay 双进程模型 |
| `StartGuestNetworkService()` `main.cpp:1015` | fork+exec gns，处理网络配置 | 回调注入策略与机制分离 |
| `GnsEngine::run()` `GnsEngine.cpp` | gns 消息循环，处理 HNS JSON 网络配置 | DNS tunneling 可选 |

</details>

## 核心实现

### `argv[0]` 分发：一个二进制的多角色复用

`/init` 是 VM 内唯一的核心二进制。`main()`（`main.cpp:3660`）开头先判定角色：若 `getpid() == 1` 且带 `WSL_ROOT_INIT_ENV` 环境变量，则当前是 mini_init（VM 级 PID 1），走 VM 初始化路径；否则进入 `WslEntryPoint()`（`init.cpp:169`），后者对 `argv[0]` 取 basename 后 switch——`"init"`/`"gns"`/`"plan9"`/`"localhost"`/`"wslpath"`/`"wsl-generator"` 等十余种角色各走各的入口。例如 plan9 服务就是 init 通过 `execl(LX_INIT_PATH, LX_INIT_PLAN9, ...)` 重新 exec 自身、`argv[0]` 设为 `"plan9"`，`WslEntryPoint` 识别后调 `StartPlan9()`（`init.cpp:3291`）。

```cpp title="init.cpp（WslEntryPoint 派发节选）"
// argv[0] 的 basename 决定运行哪种逻辑
const auto baseName = UtilGetBaseName(argv[0]);
if (baseName == LX_INIT_GNS) { return StartGuestNetworkService(); }
if (baseName == LX_INIT_PLAN9) { return StartPlan9(); }
if (baseName == LX_INIT_LOCALHOST) { return StartLocalhostServer(); }
// ... 否则按 init / 互操作 等逻辑分发
```

这套设计的核心收益是**部署极简**——VM rootfs 只需一个 `/init` 文件即可覆盖全部功能。binfmt 互操作也复用同一机制：mini_init 在 `Initialize()` 写 `/proc/sys/fs/binfmt_misc/register` 注册 `/init` 为 Windows `.exe` 的解释器，带 `F` flag 使其在所有 mount namespace 和 chroot 中可用；当 Linux 进程 `exec` 一个 `.exe`，内核自动拉起 `/init`，`WslEntryPoint` 检测到无匹配 argv[0] 后路由到 `CreateNtProcess()` 经互操作通道在 Windows 侧拉起进程。

### namespace 隔离与 `/mnt/wsl` 跨分发版共享

WSL2 能同时跑多个分发版且互不可见，靠的是 Linux 原生 namespace。`ProcessMessage`（`main.cpp:2972`）收到 `LxMiniInitMessageLaunchInit` 后，用 `UtilCreateChildProcess(CLONE_NEWIPC|CLONE_NEWNS|CLONE_NEWPID|CLONE_NEWUTS)` 在四个新 namespace 里执行 `ProcessLaunchInitMessage`——分发版 init 在独立 PID namespace 中成为 PID 1、有独立 mount 视图、独立 hostname（UTS）、独立 SysV IPC。这里用的是 `CLONE()` 宏（`common.h:84`）直接 `syscall(SYS_clone, flags, ...)`，而非 libc 的 `clone()` 包装，因为前者让子进程以 copy-on-write 方式继续执行（落到 fork 点之后），后者会跳转到一个新函数入口。

但分发版间并非完全隔离——`/mnt/wsl` 是共享的。mini_init 在 `Initialize()`（`main.cpp:1269`）创建 `/mnt/wsl` 的 tmpfs 共享挂载（`MS_SHARED` 使挂载事件在所有 namespace 传播）；`LaunchInit()`（`main.cpp:1514`）把它 `MS_MOVE|MS_REC` 递归移动到分发版内临时路径，经 `WSL2_CROSS_DISTRO` 环境变量传递；分发版 init 收到后在对应路径重新挂载。`/etc/resolv.conf` 也 symlink 到此共享路径（`main.cpp:1278`），让多分发版共享 DNS 配置。共享 vs 隔离的边界被精确控制：进程树/挂载/hostname 隔离，但跨分发版临时文件与 DNS 共享。

### relay 双进程模型与 5 个 hvsocket 端口

`InitCreateProcessUtilityVm()`（`init.cpp:1317`）是用户进程诞生的现场。它先 `UtilListenVsockAnyPort(Sockets.size())` 创建 5+ 个监听 socket——对应 wsl.exe 最终拿到的 5 个 handle：stdin/stdout/stderr、控制通道（终端 resize）、互操作通道——再把端口号经 `Transaction.SendResultMessage<uint32_t>(port)` 回送 wslservice。随后 `fork()`：

- **父进程** return 0 回到 session leader 的消息循环，继续接下一个进程创建请求；
- **子进程**成为 relay：`ConfigSetMountNamespace(elevated)` 切换到正确的提权/非提权 mount namespace（drvfs 的两套 namespace 在此分叉），`accept` 5 个 socket，`forkpty(&Master)` 创建 PTY。

PTY 的子进程 `dup2` 设好 std fd、`read(EventFd)` 等 wslservice 的 go 信号，然后 `execvpe` 成用户进程；PTY 的父进程（relay）`prctl(PR_SET_CHILD_SUBREAPER)`、`signalfd(SIGCHLD)`，在 `poll()` 上双向中继：socket[0]→StdIn pipe、StdOutPipe→socket[1]、StdErrPipe→socket[2]、Master PTY→socket[1]、InteropServer socket、SignalFd。relay 设置 `PR_SET_CHILD_SUBREAPER` 的意义在于：用户进程若 fork 出子进程且子进程的父进程先退出，孤儿不会重新 parent 到 init（PID 1）触发误收 SIGCHLD，而是被 relay 这个 subreaper 收割。

### gns、DNS tunneling 与 seccomp 拦截

`gns`（`GnsEngine.cpp:14`）是 mini_init 在 `StartGuestNetworkService()`（`main.cpp:1015`）fork 出的网络配置进程。它通过 hvsocket 收 HNS（Host Networking Service）下发的 JSON 格式网络配置（IP 地址变更、路由变更、DNS 变更），委托 `NetworkManager`（`NetworkManager.h:11`）执行实际的 Linux 网络操作（`SetAdapterConfiguration`/`ModifyRoute`/`ModifyAddress`/`CreateTunAdapter`）。`GnsEngine` 的设计体现了**策略与机制分离**：构造时注入两个回调 `NotificationRoutine`（读消息）和 `StatusRoutine`（返回结果），引擎本身不直接做 IO。

NAT 网络模式下，Linux 侧 DNS 查询需经 hvsocket 隧道到 Windows 侧执行——因为只有 Windows 侧知道真正的 DNS 服务器（含 VPN DNS、split-tunnel DNS）。`DnsTunnelingManager`（`DnsTunnelingManager.cpp:10`）在 `10.255.255.254`（`lxinitshared.h:94`，选在 10/8 段因 HNS 从 Germanium 起不再从该段分配 WSL NAT 子网）上起 DNS 服务器（TCP+UDP），经 `DnsTunnelingChannel` 转发到 wslservice 解析后返回。Mirrored 网络模式下，`localhost` 进程用 `RegisterSeccompHook`（`main.cpp:3266`）注册 seccomp user notification——`SECCOMP_SET_MODE_FILTER` + `SECCOMP_FILTER_FLAG_NEW_LISTENER` 拦截 `bind()` 与 `ioctl(SIOCSIFFLAGS)`，被拦截的调用经 `SECCOMP_RET_USER_NOTIF` 送到用户态监听器，由它转发到 Windows 侧完成端口映射追踪。

### systemd 延迟启动

当 `/etc/wsl.conf` 的 `[boot] systemd=true` 启用时，`InitEntryUtilityVm()`（`init.cpp:2303`）的处理很特别：init fork 出子进程，子进程等 `LxInitMessageStartDistroInit` 信号后才 `execvpe("/sbin/init")` 让 systemd 接管 PID 1（systemd 必须是 PID 1），父进程继续 WSL 配置。该信号在**第一个 session leader 创建时**经 socketpair 发送。同时 fork 出一个 `init-watcher` 监控 WSL init，若意外退出则终止整个 PID namespace。

这套"延迟"设计服务于 WSL 的**触发式启动**——访问 `\\wsl.localhost` 才启动分发版。若 systemd 在 init 一启动就立即完整 boot，会浪费资源；延迟到真正有交互（第一个 session leader）才付完整 boot 开销。init-watcher 则防止 systemd 崩溃后 init 沦为僵尸 PID 1。

## 设计模式

| 模式 | 位置（文件:方法） | 为什么用 |
| --- | --- | --- |
| 进程 fork+exec 链 | `ProcessLaunchInitMessage` in `main.cpp:2194`、`InitCreateSessionLeader` in `init.cpp:1097` | 每层 fork 在新 namespace，形成 4-5 层进程树，天然隔离 |
| poll 消息循环（Reactor） | `main()` `main.cpp:3900`、`InitEntryUtilityVm` `init.cpp:2451` | 三层各一个 `poll(channel, signalFd)` 事件循环，复用单线程处理多源事件 |
| 命名空间隔离 | `ProcessMessage` `main.cpp:2972` | `CLONE_NEWIPC/NEWNS/NEWPID/NEWUTS`，分发版互不可见，开销远低于虚拟机 |
| relay 双进程 | `InitCreateProcessUtilityVm` `init.cpp:1422` | forkpty 后子进程 exec 用户程序、父进程中继 IO，让 session leader 不被阻塞 |
| 策略/回调注入 | `StartGns` `init.cpp:3329`（注入 Notification/Status 回调） | GnsEngine 只管机制，网络策略由回调决定，解耦 |
| binfmt 互操作 | `Initialize` `main.cpp:1299`、`WslEntryPoint` `init.cpp:256` | 内核级劫持 `exec`，Linux 进程 exec `.exe` 时自动走 `/init` 互操作路径 |
| seccomp user notification | `RegisterSeccompHook` `main.cpp:3266` | 拦截 `bind()` 转发到 Windows，实现 mirrored 网络端口映射 |

## 模块间交互

本模块几乎不直接调用其他 Linux 模块，而是以 hvsocket 与 Windows 侧 `wslservice.exe` 双向通信为枢纽：

- **与 wslservice.exe（hvsocket 双向）**：mini_init 连 port 50000（`LX_INIT_UTILITY_VM_INIT_PORT`）；分发版 init 继承 mini_init 的 fd 100 通道；session leader 与 relay 用动态端口，经消息回传端口号给 wslservice。所有通信走 `wsl::shared::SocketChannel` + `Transaction`（TransactionId+TransactionStep 的请求-响应事务）。
- **与 shared/inc/（共享协议）**：`src/shared/inc/lxinitshared.h` 是 Windows 侧与 Linux 侧共享的消息协议头——`LX_MESSAGE_TYPE` 枚举（约 90 种，如 `LxMiniInitMessageLaunchInit`、`LxInitMessageCreateSession`、`LxInitMessageCreateProcessUtilityVm`）、消息结构体、端口常量（50000/50001/50002…）、feature flags。两侧用相同结构体布局序列化。
- **与 plan9（fork+exec）**：`StartPlan9` `init.cpp:3291` 经 `execl(LX_INIT_PATH, LX_INIT_PLAN9, ...)` 重 exec 自身启动 plan9，实现在 `src/linux/plan9/` 静态库 `libplan9`。
- **与 wslc（WSLC 模式）**：`WSLC_ROOT_INIT_ENV` 环境变量触发 `WSLCEntryPoint`（`WSLCInit.cpp`），init 以容器内 PID 1 运行，消息类型以 `LxMessageWSLC*` 为前缀（`Mount`/`Fork`/`Exec` 等），服务于容器场景。
- **gns 与 init 的关系**：gns 是 mini_init fork 的子进程，但 gns 与 init **不直接通信**，各自独立与 wslservice 交互。

固定端口约定（50000 等）省去了服务发现——VM 内没有 DNS 或注册中心；动态端口用于 session leader/relay 是因并发实例可能多个，需经消息告知以避冲突。

## 扩展方式

### 新增一种 init 消息处理

1. `src/shared/inc/lxinitshared.h`：在 `LX_MESSAGE_TYPE` 枚举新增类型，定义消息结构体（含 `static inline auto Type`、`MESSAGE_HEADER`、`PRETTY_PRINT`，需响应则定义 `using TResponse = ...`）。
2. `src/linux/init/init.cpp`：在 `InitEntryUtilityVm()` 的消息循环 `switch`（`init.cpp:2472`）新增 `case` 分支。
3. Windows 侧 `wslservice`：发送新消息。

关键函数：`InitEntryUtilityVm`（`init.cpp:2207`）的 `switch (Header->MessageType)` 块。

### 新增 systemd 集成钩子

1. `src/linux/init/init.cpp`：`GenerateSystemdUnits()`（`init.cpp:318`）中新增 unit 文件生成。
2. `src/linux/init/WslDistributionConfig.h`：在 `WslDistributionConfig` 新增配置字段。
3. `src/linux/init/config.cpp`：在 `ConfigInitializeCommon()` 解析 `/etc/wsl.conf` 新选项。
4. `init.cpp` `InitEntryUtilityVm()`：在 systemd boot 流程注入钩子。

### 修改 namespace 隔离策略

1. `src/linux/init/main.cpp`：`ProcessMessage`（`main.cpp:2972`）的 `UtilCreateChildProcess` clone flags；`ProcessLaunchInitMessage`（`main.cpp:2283`）的 `CLONE()` flags。
2. `src/linux/init/config.cpp`：`ConfigSetMountNamespace()`（`config.h:422`）控制 elevated/非 elevated mount namespace 分离。例如加 network namespace 隔离需在此加 `CLONE_NEWNET`。
