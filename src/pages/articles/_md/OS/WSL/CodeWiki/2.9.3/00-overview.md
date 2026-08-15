---
source:
  type: "源码解读"
  project: "WSL"
  url: "https://github.com/microsoft/WSL"
title: "Overview"
date: "2026-08-16T00:15:00+08:00"
category: [OS, WSL, CodeWiki, "2.9.3"]
tags: ["WSL", "C/C++", "Windows", "Linux", "虚拟化", "容器"]
description: "Windows Subsystem for Linux 2.9.3 架构解读——从 wsl.exe 到 wslservice.exe COM 服务、HCS 轻量 VM、Linux 侧 mini_init/init/relay 启动链，再到 9P 文件服务与 wslc 容器管理 CLI 的全栈剖析。"
readingTime: "40 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 2.9.3 · **协议** MIT · **语言** C / C++（Windows 侧 C++，Linux 侧 C）· **代码量** ~144,000 行（src/，不含测试）· **仓库** [GitHub](https://github.com/microsoft/WSL)

---

## 总览

### 项目简介

**Windows Subsystem for Linux（WSL）** 是微软在 Windows 上运行未修改 Linux 命令行工具、实用程序与应用的兼容子系统。它的核心价值在于绕开传统虚拟机的引导开销与双系统切换——用户执行 `wsl --install` 即可获得一个与 Windows 共存、秒级启动的 Linux 环境，Linux 进程与 Windows 进程还能双向互调（interop）。

WSL 的工程实质是一套**横跨 Windows 用户态与 Linux 用户态的协作式运行时**，而非一个单一程序。Windows 侧由一个 session 0 系统服务 `wslservice.exe` 充当中枢，它通过 Host Compute Service（HCS）拉起一台轻量级 Hyper-V 虚拟机，再经 hvsocket（Hyper-V 套接字）与 VM 内的 `mini_init`/`init` 进程双向通信，完成分发版的启动、会话创建、进程拉起与 IO 中继。Linux 侧的 `/init` 二进制以 `argv[0]` 分发，身兼 `mini_init`（VM 级初始化）、`init`（分发版级初始化）、`relay`（IO 中继）、`plan9`（文件服务）、`localhost`（网络转发）、`mount.drvfs`（驱动挂载）等多职。Windows 文件管理器里 `\\wsl.localhost\<distro>` 能像访问本地盘一样浏览 Linux 文件，靠的正是这套 9P 协议文件服务经 `p9rdr.sys` 重定向驱动桥接。

2.9.x 版本的一个重要演进是引入了 `wslc.exe`——一套 docker 风格的容器管理 CLI（`wslc container/image/volume/network/session ...`），它复用内嵌的 dockerd HTTP API，标志着 WSL 从"运行 Linux 发行版"向"容器平台"扩展。

**项目边界**：WSL 负责在 Windows 上提供兼容的 Linux 用户态运行时、Windows↔Linux 文件与进程互操作、以及轻量 VM 的生命周期管理。它**不**实现 Linux 内核——WSL2 使用独立的 [WSL2-Linux-Kernel](https://github.com/microsoft/WSL2-Linux-Kernel) 仓库；**不**提供完整桌面虚拟机图形栈——GUI 应用支持由独立的 [WSLg](https://github.com/microsoft/wslg) 仓库承担；**不**负责 Linux 发行版自身的包内容——发行版（Ubuntu、Debian 等）由各自发布方提供，WSL 只负责注册与托管。

### 功能矩阵

| 特性 | 实现文件 / 组件 | 说明 |
| --- | --- | --- |
| CLI 入口 | `src/windows/wsl/main.cpp` → `common/wslclient.cpp` | `wsl.exe` 解析命令行、经 COM 调服务、中继 IO |
| 系统服务中枢 | `src/windows/service/exe/LxssUserSession.cpp` 等 | `wslservice.exe` 会话 0 COM 服务，VM 生命周期与分发版管理 |
| WSL2 轻量 VM | `src/windows/service/exe/WslCoreVm.cpp`、`HcsVirtualMachine.cpp` | 经 HCS 创建/复用 Hyper-V 工具虚拟机 |
| VM 内初始化 | `src/linux/init/init.cpp`、`main.cpp` | `mini_init` 做 VM 级初始化并 fork 出 `init` |
| 分发版 init | `src/linux/init/init.cpp` | 每分发版独立 mount/pid/UTS namespace，解析 `/etc/wsl.conf` |
| 会话与进程拉起 | `src/linux/init/init.cpp`（session leader）、`relay` | session leader 创建 relay，relay fork+exec 用户进程 |
| IO 中继 | `src/windows/common/relay.cpp` | 按句柄类型多策略中继 stdin/stdout/stderr |
| 文件互访 | `src/linux/plan9/`（静态库 `libplan9`）+ `init/plan9.cpp` | 9P 文件服务，Windows 经 `p9rdr.sys` 访问 Linux 文件 |
| 驱动挂载 | `src/linux/init/drvfs.cpp` | `/mnt` 下挂载 Windows 盘，区分提权/非提权 namespace |
| 互操作 | `src/linux/init/binfmt.cpp` | binfmt 注册 `/init`，从 Linux 启动 Windows 进程 |
| 网络 | `src/linux/init/GnsEngine.cpp`、`localhost.cpp` + service 侧网络模块 | NAT / Mirrored / Consomme 三种网络模式 |
| 容器管理 | `src/windows/wslc/` + `wslcsession/` + `WslcSDK/` | `wslc.exe` docker-like CLI，经 dockerd API 管理容器 |
| 设置 GUI | `src/windows/wslsettings/`（C#/WinUI） | 图形化 WSL 设置面板 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++（Windows 侧） | 核心 | `wsl.exe`/`wslservice.exe`/`wslc.exe` 等全部 Windows 二进制 |
| C（Linux 侧） | 核心 | `mini_init`/`init`/`plan9`/`relay` 等 VM 内二进制 |
| Windows COM | 核心 | 客户端（wsl.exe 等）与服务（wslservice.exe）间的 RPC 机制（`ILxssUserSession`） |
| Host Compute Service (HCS) | 核心 | 创建管理 WSL2 轻量虚拟机（`HcsCreateComputeSystem`） |
| hvsocket | 核心 | Hyper-V 套接字，Windows↔Linux VM 双向通信通道 |
| CMake ≥ 3.25 | 构建 | 生成 VS 2022 解决方案（`cmake .` → `wsl.sln`） |
| Visual Studio 2022 | 构建 | MSVC 工具链，需 Developer Mode 或管理员权限 |
| WIL（Windows Implementation Libraries） | 核心 | RAII/`wil::scope_exit`/COM 包装等现代 C++ 工具 |
| GSL（Guidelines Support Library） | 核心 | `gsl::span` 等边界安全容器 |
| C#/WinUI（wslsettings） | 可选 | WSL 设置应用 GUI |
| WiX / MSI | 打包 | 生成 `wsl.msi` 安装包 |

### 顶层上下文图

WSL 的外部交互方包括：终端里的用户、Windows 文件管理器（访问 `\\wsl.localhost`）、各 Linux 发行版（Ubuntu/Debian 等的 tarball 或 VHD）、以及 Windows 系统服务 HCS 与 p9rdr 重定向驱动。下图展示系统级边界与各进程关系（基于官方技术文档 `doc/docs/technical-documentation/index.md` 的架构图整理）：

```
┌─────────────────────────── Windows ───────────────────────────┐
│  用户终端 ──CreateProcess──► wsl.exe ──COM──► wslservice.exe │
│  wslg.exe / wslconfig.exe / wslapi.dll ──COM──► wslservice   │
│  文件管理器 \\wsl.localhost ──► p9rdr.sys ──COM──► wslservice │
│            wslservice ──CreateProcessAsUser──► wslrelay/wslhost│
│                        wslservice ──hvsocket──► ┐            │
└──────────────────────────────────────────────────┼────────────┘
                                                   │ hvsocket
┌─────────────────────────── Linux VM ─────────────┼────────────┐
│  mini_init ◄─fork+exec─► gns / init / localhost   │            │
│  init ──fork+exec──► session leader ──► relay ────┘            │
│  init ──fork+exec──► plan9（9P 文件服务）                      │
│  └── Linux 发行版（bash 等用户进程）                            │
└────────────────────────────────────────────────────────────────┘
```

## 快速上手

> 以下面向**代码阅读者**，给出"最快看到项目跑起来"的最简路径，而非完整安装手册。完整构建需 Windows + VS 2022 + Developer Mode。

**从源码构建**（来自 `doc/docs/dev-loop.md`）：

```bash title="dev-loop.md 节选"
# 1. 安装依赖（VS 2022、CMake、Developer Mode）
powershell tools\setup-dev-env.ps1

# 2. 生成 VS 解决方案
cmake .

# 3. 构建
cmake --build .              # 或在 VS 中打开 wsl.sln
# ARM64：cmake . -A arm64
# Release：cmake . -DCMAKE_BUILD_TYPE=Release
```

**部署与验证**：

```bash title="部署一个端到端验证"
# 安装构建产物 MSI
bin\<platform>\<target>\wsl.msi

# 验证：启动一个分发版
wsl --install              # 首次需安装一个发行版
wsl -d Ubuntu echo hello   # 预期输出：hello
```

**运行测试**（验证"构建链路通了"）：

```bash title="运行单元测试子集"
bin\<platform>\<target>\test.bat /name:*UnitTest*
# WSL1 测试加 -Version 1：bin\x64\debug\test.bat -Version 1
```

## 代码目录

```text
WSL/
├── src/
│   ├── windows/                    # Windows 侧 C++ 组件
│   │   ├── common/                 # 公共运行库（~32k 行，全仓最大）
│   │   │   ├── relay.cpp           #   IO 中继（wsl/wslrelay/wslhost 共用）
│   │   │   ├── wslclient.cpp       #   wsl.exe 客户端逻辑（WslClient::Main）
│   │   │   ├── svccomm.cpp         #   与 wslservice 的 COM 封装
│   │   │   ├── ConsommeNetworking.cpp  # Consomme 用户态 NAT
│   │   │   └── ...                 #   网络/配置/WSL1/文件系统工具
│   │   ├── service/                # wslservice.exe（~23k 行）
│   │   │   ├── exe/                #   服务实现（COM/Lifetime/VM/网络）
│   │   │   │   ├── ServiceMain.cpp
│   │   │   │   ├── LxssUserSession.cpp   # COM 接口实现
│   │   │   │   ├── WslCoreVm.cpp         # VM 生命周期
│   │   │   │   ├── WslCoreInstance.cpp   # 分发版实例
│   │   │   │   └── WSLCSessionManager.cpp# wslc 会话管理
│   │   │   ├── inc/                #   wslservice.idl 等头文件
│   │   │   ├── mc/                 #   message compile
│   │   │   └── stub/               #   桩
│   │   ├── wslc/                   # wslc.exe 容器 CLI（~14k 行，新子系统）
│   │   │   ├── core/               #   CLI 框架（Main/Command/ExecutionContext）
│   │   │   ├── commands/            #   命令树（Container/Image/Volume/Network...）
│   │   │   ├── tasks/              #   任务层
│   │   │   ├── services/ arguments/
│   │   ├── wslcsession/            # wslc 会话运行时（~13k 行，VM 内）
│   │   │   ├── WSLCSession.cpp / WSLCContainer.cpp
│   │   │   ├── DockerHTTPClient.cpp        # 与 dockerd HTTP API 通信
│   │   │   └── IORelay.cpp / WSLCProcess.cpp
│   │   ├── WslcSDK/                # wslc SDK（~7k 行，csharp + winrt）
│   │   ├── wsl/                    # wsl.exe 入口（main.cpp，仅 35 行）
│   │   ├── wslrelay/ wslhost/ wslg/# 小型辅助二进制
│   │   ├── wslsettings/            # C#/WinUI 设置 GUI
│   │   ├── wslinstall(er)/         # 安装器
│   │   ├── inc/ libwsl/            # 头文件 / 导入库
│   ├── linux/                      # Linux 侧 C 组件
│   │   ├── init/                   # mini_init/init/relay/gns/drvfs（~25k 行）
│   │   │   ├── main.cpp init.cpp   #   入口与消息循环
│   │   │   ├── GnsEngine.cpp       #   网络配置
│   │   │   ├── plan9.cpp drvfs.cpp #   文件服务/驱动挂载
│   │   │   ├── localhost.cpp       #   网络转发
│   │   │   ├── binfmt.cpp          #   互操作
│   │   │   └── DnsTunneling*.cpp   #   DNS 隧道
│   │   ├── plan9/                  # 9P 文件服务（静态库 libplan9，~9k 行）
│   │   ├── netlinkutil/            # netlink 网络工具
│   │   └── mountutil/ inc/
│   └── shared/                     # 跨平台共享
│       ├── inc/                    #   lxinitshared.h 协议 / message.h / config schema
│       └── configfile/            #   .wslconfig 解析
├── doc/docs/technical-documentation/  # 官方组件技术文档（宝贵参考资料）
├── test/                           # 测试（windows/ + linux/unit_tests/，~62k 行）
├── tools/ cmake/ .pipelines/       # 构建/CI 工具
└── CMakeLists.txt                  # 顶层构建脚本
```

只解释一级与关键二级目录；逐文件级分析留给各模块文档。

## 架构设计解析

### 系统架构

WSL 的核心架构思想是**用一条 hvsocket 隧道把 Windows 用户态和一台轻量 Linux VM 的用户态缝合起来**，再用 COM 把客户端与系统服务解耦。这样设计解决的根本问题是：Windows 进程与 Linux 进程运行在不同内核域，却要透明地共享终端、文件、网络与进程创建能力。拆成五层后，每层职责清晰、可独立演进：

![WSL 分层架构](/vibe-reading/images/articles/wsl-internals/wsl-architecture.svg)

- **Windows 客户端层**：`wsl.exe`（`common/wslclient.cpp` 的 `WslClient::Main`，解析命令行 + COM 调服务 + relay IO）、`wslc.exe`（容器 CLI，独立命令树）、`wslconfig.exe`、`wslg.exe`、`wslapi.dll`（第三方编程接口）。它们都是瘦客户端——逻辑在 common 库与服务里。
- **Windows 服务层**：`wslservice.exe`（Session 0 SYSTEM 服务）是中枢，经 COM `ILxssUserSession` 接受客户端请求，管 VM 生命周期（HCS）、分发版注册表、客户端进程生命周期；同时经 `WSLCSessionManager` 暴露容器会话 API。
- **VM 边界**：hvsocket（AF_VSOCK，按 VM `runtimeId` 寻址）是 Windows↔Linux 的唯一跨域通道，承载请求-响应事务消息（`MESSAGE_HEADER`+payload）。
- **Linux VM 初始化层**：`mini_init`（VM 级 PID 1）→ `init`（分发版级 PID 1）→ `session leader` → `relay`，一条 fork+exec 链把"创建进程"的指令翻译成 Linux 进程树；外加 `gns`（网络）、`localhost`（端口转发）。
- **Linux 服务层**：`relay`（IO 中继）、`plan9`（9P 文件服务，被 `p9rdr.sys` 经 wslservice 桥接访问）、`drvfs`（挂载 Windows 盘）、`binfmt` 互操作。

层间协作：客户端经 COM 把请求打到服务层；服务层经 hvsocket 把指令送进 VM 初始化层；初始化层 fork 出服务层进程处理实际 IO；服务层再经 hvsocket 把 5 条数据通道交回客户端层中继。这样分层让客户端可随时退出/重建（COM 引用归零不影响服务持有的 session），VM 可按需启停（`if (!m_utilityVm)` 复用），Linux 进程隔离靠原生 namespace（不依赖客户端）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| Windows 客户端 | `src/windows/wsl/`、`wslc/`、`wslrelay/`、`wslhost/` | 解析命令行、COM 调服务、中继 IO；瘦客户端，无核心状态 |
| Windows 服务 | `src/windows/service/` | 以 SYSTEM 服务统一管 VM/分发版/会话/安全；客户端退出仍保活 |
| VM 边界（通信） | `src/shared/inc/` | 共享协议（消息类型/结构体/端口约定），Windows 与 Linux 两侧共用同一布局 |
| Linux VM 初始化 | `src/linux/init/` | VM 内 usermode 初始化、namespace 隔离、fork+exec 进程树 |
| Linux 服务 | `src/linux/plan9/`、`init/drvfs.cpp` 等 | 9P 文件服务、驱动挂载、IO 中继、互操作 |

### 设计模式

WSL 全仓复用一组贯穿多模块的核心模式：

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| COM 外观 + per-user 弱引用单例 | `LxssUserSession`/`LxssUserSessionFactory` `service/exe` | COM 引用归零不销毁 session，跨进程客户端复用同一 VM |
| 抽象基类统一双路径 | `LxssRunningInstance` → `LxssInstance`/`WslCoreInstance` | WSL1（Lxcore pico）/WSL2（HCS VM）架构不同，统一接口让调用方无感 |
| fork+exec 进程链 | `mini_init`→`init`→`session leader`→`relay` `linux/init` | 每层 fork 在新 namespace，天然隔离，单一 `/init` 二进制多角色 |
| poll/Reactor 事件循环 | mini_init/init/relay 的 `poll(channel,signalFd)` | 单线程处理多源事件，复用避免线程开销 |
| relay 策略分流 | `StandardInputRelay` 按 `GetFileType` 分流 `common` | console 事件流 vs pipe 字节流需不同读取策略 |
| Dispatch Table | `Handler::HandleMessage` `plan9` | 9P 消息类型→handler 映射，新增只加 case |
| C++20 协程 + epoll/aio | `Scheduler`/`CoroutineIoIssuer` `plan9` | 4096 连接下协程比 thread-per-connection 高效 |
| Composite 命令树 | `Command`/`RootCommand` `wslc` | 递归下降子命令，新增命令组只加 push_back |

### 核心概念

WSL 运行时最重要的几个"东西"：

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `LxssUserSessionImpl` | per-user 会话（管该用户所有分发版+VM） | 用户 SID 存在即保活（`g_sessions` shared_ptr） | 持 `WslCoreVm`、`m_runningInstances`、`LifetimeManager` |
| `WslCoreVm` | WSL2 utility VM（HCS） | 按需创建、空闲超时销毁 | 持 `m_miniInitChannel`、`NetworkingEngine` |
| `WslCoreInstance` | 单个运行中分发版 | CreateInstance 起、Terminate 止 | 持 `m_initChannel`、`ConsoleManager` |
| session leader | Linux 会话首领（一一对应 Windows console） | `LxInitMessageCreateSession` 起 | fork 出 relay |
| relay | IO 中继进程 | fork 自 session leader，用户进程退出即止 | forkpty 出 bash，双向中继 hvsocket↔PTY |
| `Fid` | 9P 有状态文件句柄 | `Tattach` 起、`Tclunk` 止 | `File`/`XAttr` 两种策略 |

核心抽象（扩展点契约）：

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `LxssRunningInstance` | `LxssCreateProcess.h:120` | `LxssInstance`(WSL1)、`WslCoreInstance`(WSL2) | `_CreateInstance` 按 `VM_MODE` flag 选择 |
| `INetworkingEngine` | `core/INetworkingEngine.h` | Nat/Mirrored/Consomme 各实现 | `WslCoreVm::Initialize` 按 `NetworkingMode` 选 |
| `IWSLCSession` | `wslc.h` IDL | `WSLCSession` | per-user `WSLCSessionFactory::CreateSession` |
| `IPlan9FileSystem`/`ISocket` | `p9fs.h`/`p9platform.h` | `FileSystem`/`Socket` | `CreateFileSystem`/构造注入 |
| `Fid` | `p9fid.h:14` | `File`、`XAttr` | `Tattach`/`HandleXattrCreate` 运行时替换 |

## 模块地图

![WSL 模块依赖关系](/vibe-reading/images/articles/wsl-internals/module-dependencies.svg)

WSL 的静态依赖呈"客户端 → 服务 → 协议 → Linux init → 服务"的纵向链，common 作为横切共享库被多数二进制复用，shared/inc 作为协议层被 Windows 与 Linux 两侧共用。模块间动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| WslService 服务核心 | Windows COM 系统服务，VM 生命周期、分发版注册、安全边界 | `LxssUserSessionFactory`/`LxssUserSessionImpl` | 以 SYSTEM 运行却服务多用户，per-user 隔离与 VM 调度只能由中枢承担 | [01-wslservice](01-wslservice) |
| Linux 初始化子系统 | VM 内 usermode 初始化、namespace 隔离、fork+exec 进程树 | `main.cpp`/`init.cpp` | Windows 与 Linux 是不同内核域，VM 内启动/会话/进程创建是独立执行域 | [02-linux-init](02-linux-init) |
| Windows 公共运行库 | 跨二进制共享的 relay/COM/配置/分发 | `WslClient::Main`/`SvcComm`/`relay` | 多个 Windows 二进制共用同一套 IO/COM 逻辑，避免重复实现 | [03-common-runtime](03-common-runtime) |
| wslc 容器管理 CLI | docker-like 容器/镜像/卷/网络/会话管理 | `wslc/core/Main.cpp` `CoreMain` | 容器平台与 distro 运行是不同职责，复用 dockerd 而非自造运行时 | [04-wslc-cli](04-wslc-cli) |
| Plan9 文件服务 | 9P 文件服务，Windows↔Linux 文件互访 | `plan9.cpp` `StartPlan9Server` | 文件互访是独立横切能力，9P 协议需专门 server | [05-plan9](05-plan9) |

## 运行时行为

### 启动流程

一次 `wsl` 命令从 Windows 终端到 Linux shell 的完整启动链（对象装配标注于括号内）：

```
wsl.exe wmain (wsl/main.cpp:17)
└─ WslClient::Main (common/WslClient.cpp:1823)
   ├─ CoInitializeEx / WSAStartup / 按 stem 分发 → WslMain
   ├─ 解析参数 → LaunchProcess (WslClient.cpp:650)
   │  └─ SvcComm service（COM CoCreateInstance<ILxssUserSession>，动态伪装）
   │     └─ service.CreateInstanceNoThrow → COM CreateInstance
   │        → LxssUserSessionFactory::CreateInstance (工厂查/建 per-user session)
   │        → LxssUserSessionImpl::_CreateInstance (查注册表 DistributionRegistration)
   │           ├─ _RunningInstance 复用？ 否 → _CreateVm (if !m_utilityVm 按需创 VM)
   │           │  └─ WslCoreVm::Create → hcs::CreateComputeSystem(JSON) → StartComputeSystem
   │           │     → hvsocket::Listen(50000) → AcceptConnection 等 mini_init
   │           └─ m_utilityVm->CreateInstance(LxMiniInitMessageLaunchInit)
   │              → m_miniInitChannel.Send → AcceptConnection 等 init daemon
   │              → WslCoreInstance::Initialize (发 CONFIGURATION_INFORMATION 握手)
   └─ service.LaunchProcess → COM CreateLxProcess (5 handle 回传)
      → 启动 relay 线程 + SpawnWslHost + VmModeWorkerThread 阻塞等退出码
```

对象装配的关键点：per-user `LxssUserSessionImpl` 由全局 `g_sessions` 的 `shared_ptr` 保活（COM 对象只持 `weak_ptr`，wsl.exe 退出不销毁）；`WslCoreVm` 按需 `if (!m_utilityVm)` 创建，所有 WSL2 分发版共享一台 VM；`LifetimeManager` 注册客户端进程句柄做 threadpool wait，多进程聚合 + 60s 超时重试，全部退出后触发分发版/VM 自动终止；配置来自 `.wslconfig`（VM 级，Windows 侧 `Config::ParseConfigFile`）与 `/etc/wsl.conf`（distro 级，Linux init 解析）双层，`wsl2.*`/`experimental.*` 双键平滑迁移。

### 核心运行流程

下面四条链路覆盖 WSL 的核心运行模式。完整端到端数据流见下图，文字解读聚焦关键方法名、数据结构与设计决策。

#### 进程创建：wsl → bash

用户敲 `wsl` → 客户端 `CreateLxProcess` COM → 服务 `_CreateInstance`+`WslCoreInstance::CreateLxProcess` → `ConsoleManager::GetSessionLeader`（发 `LX_INIT_CREATE_SESSION`→收 `LX_INIT_CREATE_SESSION_RESPONSE{Port}`→`hvsocket::Connect`）→ `sessionLeader->Transaction<LX_INIT_CREATE_PROCESS_UTILITY_VM>` 拿 relay 端口 → `hvsocket::Connect` ×5 建 stdin/stdout/stderr/control/interop → Linux 侧 session leader `InitCreateProcessUtilityVm` fork relay → relay `forkpty` 出 bash。5 通道设计让 std×3（不可合并，保 `2>/dev/null`）、control（异步终端 resize）、interop（跨系统进程创建+退出通知）各走独立 socket，Linux init 无需做协议多路分离。

![WSL 端到端数据流](/vibe-reading/images/articles/wsl-internals/data-flow.svg)

#### IO 中继：5 通道双向

bash 的 stdin/stdout/stderr 经 relay 的 `poll` 在 hvsocket 与 PTY/pipe 间双向中继（`init.cpp:1754`）。Windows 侧 `relay::StandardInputRelay` 按 `GetFileType` 分流：console 走 `MultiHandleWait`+`RelayHandle<ReadConsoleHandle>`（`ReadConsoleInputExW` 读 `INPUT_RECORD` 提 `UnicodeChar`、检测 `WINDOW_BUFFER_SIZE_EVENT` 触发 `LX_INIT_WINDOW_SIZE_CHANGED`），非 console 走 `InterruptableRelay`（`ReadFile` 字节流 + `InitializeFileOffset` 支持 `>>file` 追加）。退出码经 interop 通道回传：relay `waitpid`→`LX_INIT_PROCESS_EXIT_STATUS`→wsl.exe `VmModeWorkerThread`→进程退出码=bash 退出码。wsl.exe 终止前 wslhost.exe 已接管 interop 通道（`IgnoreExit=true`），后台进程互操作不中断。

#### 文件互访：9P 双向

Windows 访问 Linux 文件（`\\wsl.localhost\<distro>`）：`p9rdr.sys`→wslservice COM 桥接获取 hvsocket fd→9P over AF_VSOCK→plan9 server。Linux 访问 Windows 文件（`/mnt/c`）：`drvfs.cpp` `UtilConnectVsock(PLAN9_DRVFS_PORT)`→`mount -t 9p trans=fd`→Linux 9p 内核客户端→同一 plan9 server。两者靠不同 vsock 端口区分。9P2000.W 的 `Twopen` 合并 walk+open+create+mkdir+readlink+getattr 六步为一次往返（Windows `CreateFileW` 同步语义原本需 3 RTT），`Twreaddir` 内联属性免每项 `Tgetattr`。

#### 互操作：Linux 调 Windows 进程

Linux 进程 `exec` 一个 `.exe` → 内核经 binfmt 拉起 `/init` → `WslEntryPoint` 检测后经 interop socket 发 `LxInitMessageCreateProcessUtilityVm` → Windows 侧 `VmModeWorkerThread` `CreateProcessVmMode` `hvsocket::Connect` ×4 建 3std+control → `CreateProcessW` 启 Windows 程序 → 退出码经 control socket 回传 Linux init。GUI 应用（`IMAGE_SUBSYSTEM_WINDOWS_GUI`）在 control channel 关闭时不被强杀（有自身窗口生命周期）。

### 状态流

WSL2 分发版实例有明确的生命周期状态（`LxssDistributionState`：Invalid→Installing→Installed→Running→Uninstalling/Converting/Exporting），但更值得讲的是 VM 的启停状态机：

![WSL2 utility VM 状态流](/vibe-reading/images/articles/wsl-internals/state-flow.svg)

VM 状态：**NotCreated** →（`_CreateVm` 按需）→ **Running** →（分发版全终止 + `InstanceIdleTimeout` 到期）→ **IdleTerminating** →（`_VmTerminate` 析构等 distroExitThread）→ **NotCreated**（`m_vmId=GUID_NULL` 允许重建）。异常路径：Running →（HCS `s_OnExit` 回调 VM 崩溃）→ `s_VmTerminated`→`TerminateByClientId(WILDCARD)` 终止所有关联分发版。`InstanceIdleTimeout` 负值时永不自动终止（需 `wsl --shutdown`）。分发版实例状态由 `WslCoreInstance`：构造（`LxMiniInitMessageLaunchInit`）→ `Initialize`（握手）→ Running → `RequestStop`（发 `LX_INIT_TERMINATE_INSTANCE`）→ `Stop`（关 `m_initChannel`）→ 移入 `m_terminatedInstances` 延迟析构（避免锁内析构死锁）。相关代码：状态枚举 `wslservice.idl:36-45` `LxssDistributionState`；VM 终止 `LxssUserSessionImpl::_VmTerminate` `service/exe/LxssUserSession.cpp:3901`；实例终止 `_TerminateInstanceInternal` `:3589`。

## 典型修改场景

### 场景 1：新增一个 wslc 子命令（如 `wslc container pause`）

需改 `wslc/commands/ContainerCommand.h`（声明 `ContainerPauseCommand`）+ `ContainerCommand.cpp:22`（`GetCommands` push_back）+ 新 `ContainerPauseCommand.cpp`（`ExecuteInternal` 一行 Task 链 `context<<ResolveSession<<PauseContainers`）+ `wslc/tasks/ContainerTasks.h/.cpp`（`PauseContainers`）+ `wslc/services/ContainerService.h/.cpp`（`Pause` 调 COM）+ `wslcsession/WSLCSession.h/.cpp`（`IFACEMETHOD(Pause)` 委托 `Impl`）+ `wslcsession/DockerHTTPClient.h/.cpp`（`PauseContainer` `POST /containers/{id}/pause`）+ `CMakeLists.txt`。对应测试 `test/windows/wslc/WSLCTests.cpp`。

### 场景 2：新增一种 init 消息（Windows↔Linux 协议扩展）

需改 `src/shared/inc/lxinitshared.h`（`LX_MESSAGE_TYPE` 枚举+消息结构体含 `static inline auto Type`/`MESSAGE_HEADER`/`PRETTY_PRINT`/`using TResponse`）+ `src/linux/init/init.cpp:2472`（`InitEntryUtilityVm` 的 `switch` 加 case）+ Windows 侧 `WslCoreInstance`/`WslCoreVm`（用 `m_initChannel`/`m_miniInitChannel` 发送）。对应测试 `test/linux/unit_tests/`。

### 场景 3：新增一种网络模式

需改 `src/windows/service/exe/`（新 `Networking` 类继承 `wsl::core::INetworkingEngine`，`WslCoreVm::Initialize:565-609` 加分支）+ `WslCoreConfig.h`（`NetworkingMode` 枚举+`ConfigSetting` 键路径）+ `WslCoreVm::GenerateConfigJson:1421`（VM 配置 JSON 加网络设备）+ Linux 侧 `gns`/`localhost`（`GnsEngine.cpp`/`localhost.cpp` 增处理）。对应测试 `test/windows/NetworkTests.cpp`。

## 测试体系

```
test/
├── linux/
│   └── unit_tests/        # Linux 侧单元测试
└── windows/
    ├── testplugin/         # 插件测试夹具
    ├── wslc/               # wslc 容器 CLI 测试
    ├── Common.cpp/.h       # 公共测试基础设施
    ├── UnitTests.cpp       # 主单元测试套件
    ├── DrvFsTests.cpp      # drvfs 文件系统测试
    ├── Plan9Tests.cpp      # 9P 文件服务测试
    ├── NetworkTests.cpp    # 网络模式测试
    ├── MountTests.cpp      # 挂载测试
    ├── PluginTests.cpp     # 插件钩子测试
    ├── WSLCTests.cpp       # wslc 容器测试
    ├── WslcSdkTests.cpp    # wslc SDK 测试
    ├── InstallerTests.cpp  # 安装器测试
    ├── PolicyTests.cpp     # 策略测试
    ├── WindowsUpdateTests.cpp
    └── SimpleTests.cpp
```

测试与代码的对应关系：

| 代码层 | 测试类型 | 测试文件 |
| --- | --- | --- |
| Linux init/plan9 | Unit Test | `test/linux/unit_tests/`、`Plan9Tests.cpp` |
| WslService（VM/lifecycle/network） | Unit/Integration | `UnitTests.cpp`、`NetworkTests.cpp` |
| common（relay/drvfs） | Integration | `DrvFsTests.cpp`、`MountTests.cpp` |
| wslc CLI + SDK | Integration | `WSLCTests.cpp`、`WslcSdkTests.cpp`、`WslcSdkWinRTTests.cpp` |
| 插件系统 | Unit | `PluginTests.cpp`、`testplugin/` |

运行：`bin\<platform>\<target>\test.bat /name:*UnitTest*`（WSL1 加 `-Version 1`）。改某层代码时参照上表找对应测试优先阅读——很多测试是可执行文档。

## 阅读源码推荐路线

- **第一遍：理解主流程（进程创建链）**
  `src/windows/wsl/main.cpp` 的 `wmain` → `src/windows/common/wslclient.cpp` 的 `WslClient::Main`/`LaunchProcess` → `src/windows/common/svccomm.cpp` 的 `SvcComm::LaunchProcess`（COM `CreateLxProcess` 拿 5 handle）→ `src/windows/service/exe/LxssUserSession.cpp` 的 `_CreateInstance`/`CreateLxProcess` → `src/windows/service/exe/WslCoreVm.cpp` 的 `CreateInstance` → `src/windows/service/exe/WslCoreInstance.cpp` 的 `CreateLxProcess`（hvsocket 5 通道）。
- **第二遍：理解 Linux 侧启动与 relay**
  `src/linux/init/main.cpp` 的 `main`（mini_init 消息循环）→ `src/linux/init/init.cpp` 的 `InitEntryUtilityVm`/`InitCreateSessionLeader`/`InitCreateProcessUtilityVm`（relay 双进程模型）。
- **第三遍：理解文件互访与互操作**
  `src/linux/init/plan9.cpp` 的 `StartPlan9Server`/`RunPlan9Server` → `src/linux/plan9/p9handler.cpp` 的 `HandleMessage`/`Handler::Run` → `src/linux/plan9/p9file.cpp` 的 `File::Read`/`Walk`；`src/linux/init/binfmt.cpp` 的 binfmt 互操作 → `src/windows/common/interop.cpp` 的 `VmModeWorkerThread`。
- **第四遍：选择重点子模块深入**
  容器方向读 [04-wslc-cli](04-wslc-cli)（`wslc/core/Main.cpp` → `commands/RootCommand.cpp` → `wslcsession/WSLCSession.cpp` → `DockerHTTPClient`）；VM 生命周期方向读 [01-wslservice](01-wslservice) 的 `_CreateVm`/`_VmTerminate` + `LifetimeManager`。

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| HCS | Host Compute Service，Windows 创建管理轻量虚拟机的系统服务（`HcsCreateComputeSystem`） |
| hvsocket | Hyper-V 套接字（AF_VSOCK），按 VM GUID 寻址的跨域通信通道，无需网络栈 |
| utility VM | WSL2 的轻量级 Hyper-V 工具虚拟机，运行完整 Linux 内核 |
| binfmt | Linux binfmt_misc 机制，注册 `/init` 为 Windows `.exe` 的解释器，实现互操作 |
| drvfs | WSL 挂载 Windows 盘的文件系统类型（`/mnt/c` 等），可走 9p/virtio-plan9/virtiofs |
| 9P / fid | Plan 9 文件协议；fid 是其有状态的会话级文件句柄（`Tattach`→`Tclunk`） |
| 9P2000.W | Windows 专有的 9P 扩展（`Twopen`/`Twreaddir`/`Taccess`），减少往返 |
| namespace | Linux mount/pid/UTS/IPC namespace，WSL2 用其隔离多分发版 |
| ConPTY | Windows 伪终端，与 Linux session leader + 控制终端一一对应 |
| session leader | Linux 会话首领，`setsid` 创建，与一个 Windows console 绑定，创建 relay |
| relay | WSL2 IO 中继进程，fork 自 session leader，forkpty 出用户进程，双向中继 hvsocket↔PTY |
| COM | Windows 组件对象模型，wsl.exe 与 wslservice.exe 经 `ILxssUserSession` 通信 |
| mini_init / init | VM 级 PID 1 / 分发版级 PID 1，同一 `/init` 二进制按 `argv[0]`+PID 分角色 |

### 参考资料

- [WSL 官方文档](https://learn.microsoft.com/windows/wsl/)（aka.ms/wsldocs）
- 仓库内技术文档：`doc/docs/technical-documentation/`（boot-process、wslservice、mini_init、init、plan9、relay、session-leader、interop、drvfs、gns、localhost、systemd 等）
- [WSL2-Linux-Kernel](https://github.com/microsoft/WSL2-Linux-Kernel)（WSL 使用的 Linux 内核）
- [WSLg](https://github.com/microsoft/wslg)（Linux GUI 应用支持）
- [Host Compute Service API](https://learn.microsoft.com/virtualization/api/hcs/overview)

## 相关阅读

- [Linux 内核源码解读](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview) — **背景知识**·WSL2 utility VM 运行的正是 Linux 内核，读内核有助于理解 WSL 的 namespace/hvsocket/gns 底层机制
