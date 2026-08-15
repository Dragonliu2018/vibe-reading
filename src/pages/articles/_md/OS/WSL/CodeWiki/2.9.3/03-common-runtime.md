---
source:
  type: "源码解读"
  project: "WSL"
  url: "https://github.com/microsoft/WSL"
title: "Windows 公共运行库"
date: "2026-08-16T00:15:00+08:00"
category: [OS, WSL, CodeWiki, "2.9.3"]
tags: ["WSL", "C/C++", "Windows", "Linux", "虚拟化", "容器"]
description: "跨二进制共享的 common 运行库——5 通道 IO 中继、按句柄类型分流、COM 客户端封装与互操作剖析。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/WSL/CodeWiki/2.9.3/00-overview)

---

## 模块定位

`src/windows/common/`（~32,000 行 C++，全仓最大目录）是跨多个 Windows 二进制共享的运行库。`wsl.exe`、`wslrelay.exe`、`wslhost.exe`、`wslservice.exe`、`wslc.exe` 都链接它，复用同一套 IO 中继、COM 客户端封装、配置解析、命令行分发与错误上下文化基础设施。它本身不构成一个独立进程，而是把"Windows 进程如何与 WSL 服务及 Linux 进程打交道"这层公共逻辑沉淀下来——`wsl.exe` 的 `main.cpp` 只有一行 `return WslClient::Main(GetCommandLineW())`，其余全在 common。

这个模块的关键张力是：Windows 终端模型（ConPTY、`INPUT_RECORD` 事件流）与 Linux 终端模型（session leader、控制终端、PTY）差异巨大，却要让两者透明互操作。common 的 relay 层就是弥合这道鸿沟的胶水。

## 模块架构

common 内部由几个相对独立的子系统组成，各服务于一类横切关注点：

![Windows 公共运行库架构](/vibe-reading/images/articles/wsl-internals/common-architecture.svg)

- **客户端入口与 COM 封装**：`WslClient`（`WslClient.h`，极简静态类，`Main` 是 wsl.exe 入口）按可执行名 stem 分发到 `WslMain`/`BashMain`/`WslconfigMain`/`WslgMain`；`SvcComm`（`svccomm.hpp:24`）封装 `wil::com_ptr<ILxssUserSession>`，是所有对 wslservice COM 调用的外观，构造时 `CoCreateInstance` + 动态伪装（`EOAC_DYNAMIC_CLOAKING`）。
- **IO 中继层**：`relay` 命名空间（`relay.hpp`）提供 `CreateThread`/`InterruptableRelay`/`StandardInputRelay`/`BidirectionalRelay`/`ScopedRelay`/`ScopedMultiRelay` 等线程级中继；`io` 命名空间（`HandleIO.h`）提供 `OverlappedIOHandle` 模板方法基类、`ReadConsoleHandle`/`ReadHandle`/`WriteHandle` 等策略子类、`RelayHandle<TRead>` 泛型组合、`MultiHandleWait` 事件循环——这是 Windows 异步 IO 的统一抽象。
- **互操作层**：`interop` 命名空间（`interop.hpp`）的 `WorkerThread`（WSL1，lxss bus）与 `VmModeWorkerThread`（WSL2，hvsocket）处理 Linux↔Windows 进程创建请求与退出通知；`ConsoleState`（`ConsoleState.h`）RAII 管理 console mode/codepage。
- **配置与错误**：`wsl::core::Config`（`WslCoreConfig.h`，50+ VM 级字段）解析 `.wslconfig`，双键路径支持 `wsl2.*`/`experimental.*` 迁移；`ExecutionContext`（`ExecutionContext.h`）线程局部错误上下文化，父子链表收集 wil 异常成 `LXSS_ERROR_INFO`。

之所以把 IO 抽象成 `OverlappedIOHandle` 模板方法 + `RelayHandle<TRead>` 泛型，是因为中继逻辑（read→buffer→write）通用，但读取策略各异（console 事件流 vs pipe 字节流 vs 按行 vs HTTP chunked），用模板注入策略既避免虚函数开销又保持类型安全。

## 调用链路

`wsl.exe` 从命令行到拿到 Linux 进程 IO 句柄的链路（Linux 侧 relay/进程的对应实现见 [Linux 初始化子系统](02-linux-init)，服务侧见 [WslService 服务核心](01-wslservice)）：

链路关键节点：`wmain`（`wsl/main.cpp:17`）→ `WslClient::Main`（`WslClient.cpp:1823`，COM/Winsock 初始化 + `CommandLineToArgvW` 取 stem 分发）→ `WslMain`（`:1523`，for 循环解析 `--distribution`/`--exec`/`--export`/... 15+ 子命令）→ `LaunchProcess`（`:650`，构造 `SvcComm service` → `service.CreateInstanceNoThrow` → `service.LaunchProcess`）。`SvcComm::LaunchProcess`（`svccomm.cpp:272`）构造 `CreateProcessArguments`（宽字符→多字节 + NtEnvironment）和 `LXSS_STD_HANDLES`（按 `IsConsoleInput/Output` 标 `LxssHandleConsole`/`Input`/`Output`），COM 调 `m_userSession->CreateLxProcess(...)` 拿回 5 个 handle + `ProcessHandle`。

WSL2 路径（`ProcessHandle` 为 null）：建 `ControlChannel`（`shared_ptr<SocketChannel>`，因 stdin 线程 detach）→ 起 detached stdin 线程 `relay::StandardInputRelay`（内含 `updateTerminal` lambda 发 `LX_INIT_WINDOW_SIZE_CHANGED`）→ `relay::CreateThread` 起 stdout/stderr 线程 → `SpawnWslHost`（后台 interop）→ `InteropChannel` → `ExitCode = interop::VmModeWorkerThread(InteropChannel, InstanceId)`（阻塞等 `LxInitMessageExitStatus`）。`StandardInputRelay`（`relay.cpp:410`）按 `GetFileType` 分流：非 console（`FILE_TYPE_CHAR` 之外）走 `InterruptableRelay`（`ReadFile` 字节流 + `InitializeFileOffset` 支持 `>>file` 追加，#11799）；console 走 `MultiHandleWait` + `RelayHandle<ReadConsoleHandle>`（`ReadConsoleInputExW` 读 `INPUT_RECORD`，提 `UnicodeChar`，处理 VT escape peek，检测 `WINDOW_BUFFER_SIZE_EVENT` 触发 `UpdateTerminalSize`）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `WslClient::Main` `WslClient.cpp:1823` | wsl.exe 入口，按 stem 分发 | bash/wslconfig/wslg/wsl 四入口 |
| `WslMain` `:1523` | 解析 15+ 子命令并分发 | for 循环 + ArgumentParser 二级解析 |
| `LaunchProcess` `:650` | COM 创建实例 + 启动进程 + 中继 | 5 通道 + spawn wslhost |
| `SvcComm::LaunchProcess` `svccomm.cpp:272` | 构造参数 + COM 调 CreateLxProcess | LXSS_STD_HANDLES 标 console/pipe |
| `relay::StandardInputRelay` `relay.cpp:410` | stdin 中继，按句柄类型分流 | 策略：console 事件 vs 字节流 |
| `ReadConsoleHandle::Collect` `HandleIO.cpp:907` | 读 INPUT_RECORD 提 UnicodeChar | VT escape peek + resize 检测 |
| `interop::VmModeWorkerThread` `interop.cpp:577` | WSL2 互操作消息循环 | IgnoreExit 控制前台/后台 |
| `MultiHandleWait::Run` `HandleIO.cpp:1676` | overlapped IO 事件循环 | std::list 保证回调中加项不失效 |

</details>

## 核心实现

### 5 通道设计与 relay 多策略分流

`CreateLxProcess` 返回 5 个 handle（WSL2 是 hvsocket，`reinterpret_cast<HANDLE>` 与 `wil::unique_socket` 互转）：

| 通道 | 变量 | 方向 | 职责 |
| --- | --- | --- | --- |
| stdin | `StdInSocket` | Win→Linux | 中继 Windows console/pipe 输入 |
| stdout | `StdOutSocket` | Linux→Win | 中继 Linux stdout |
| stderr | `StdErrSocket` | Linux→Win | 中继 Linux stderr（独立线程，保 `2>/dev/null`） |
| control | `ControlSocket`→`shared_ptr<SocketChannel>` | Win→Linux | 发 `LX_INIT_WINDOW_SIZE_CHANGED` 终端 resize |
| interop | `InteropSocket`→`SocketChannel` | 双向 | Linux 调 Windows 进程 + 退出通知 |

3 个 std fd 必须分离——Linux 的 fd 0/1/2 独立，合并会让输出顺序错乱且 `2>/dev/null` 失效。control 通道独立于 stdin 数据流，因终端 resize 是异步事件（用户随时改窗口大小），混入 stdin 数据流要 Linux 侧做协议多路分离，独立通道让 init 直接在 control socket 上 `recv` 消息头即可。`ControlChannel` 用 `shared_ptr` 而非栈对象，因为 stdin 线程 detach（`svccomm.cpp:475`），主线程可能先返回（`:440-443` 注释）。interop 通道承载跨系统进程创建与退出通知，语义与 IO 数据流完全不同。

`StandardInputRelay` 的分流是核心：console input 是 `INPUT_RECORD` 事件流（`KEY_EVENT`/`WINDOW_BUFFER_SIZE_EVENT`），不能 `ReadFile`；pipe/file 是字节流。`ReadConsoleHandle::Collect`（`HandleIO.cpp:907`）用 `ReadConsoleInputExW`（`CONSOLE_READ_NOWAIT` 非阻塞，`LxssDynamicFunction` 动态加载无导入库）读 `INPUT_RECORD`，逐条提 `UnicodeChar` 组装 UTF-8 字节流，并 peek 15 条记录找 VT escape 序列边界。`InitializeFileOffset`（`relay.cpp:177`）对 `FILE_TYPE_DISK` 用 `SetFilePointerEx` 取当前 offset，支持 `wsl.exe echo foo >> file` 追加（#11799）。

### 终端 resize 与互操作双向复用

终端 resize 全链：用户改窗口 → console 产生 `WINDOW_BUFFER_SIZE_EVENT` → `ReadConsoleHandle::Collect`（`:980`）检测 → 调注入的 `UpdateTerminalSize` 回调 → `updateTerminal` lambda（`svccomm.cpp:451`）`Io->GetWindowSize()` 取 `COORD` → 构造 `LX_INIT_WINDOW_SIZE_CHANGED` → `ControlChannel->SendMessage` → Linux init `ioctl(TIOCSWINSZ)` + `SIGWINCH` 通知前台进程组。用回调注入而非轮询：resize 是事件驱动的，轮询需额外线程且延迟不可控。

interop 通道在单个 socket 上承载两种语义：方向 1（Linux→Windows）`VmModeWorkerThread`（`interop.cpp:577`）收 `LxInitMessageCreateProcessUtilityVm` → `CreateProcessVmMode`（`:259`）`hvsocket::Connect(VmId, Port)` × 4（3 std + control，interop 进程不需独立 interop 通道）→ 非 PTY 模式建 anonymous pipe 中继 → `CreateProcessW` 启动 Windows 程序 → 判 `IMAGE_SUBSYSTEM_WINDOWS_GUI`；方向 2（退出通知）收 `LxInitMessageExitStatus` → `SendMessage` 转发 → `if (!IgnoreExit) return ExitCode` 成为 wsl.exe 退出码。`IgnoreExit` 参数让同一函数服务前台（wsl.exe，`false`）与后台（wslhost，`true`）：wslhost service 的是 `Ctrl+Z` 后台化进程，其退出不应让 wslhost 退出，因可能还有其他后台进程需互操作。GUI 应用在 control channel 关闭时不被 `TerminateProcess`（`:432`，有自己的窗口生命周期）。

### wslhost 接管与双配置分层

`SpawnWslHost`（`svccomm.cpp:130`）经 `helpers::LaunchInteropServer` 启动 wslhost.exe，传 interop socket handle 和 parent process handle。wslhost `WaitForSingleObject(parent)` 等 wsl.exe 退出后接管 interop（`wslhost/main.cpp:241-259`，`VmModeWorkerThread(channel, vmId, IgnoreExit=true)`）。场景：用户 `Ctrl+Z` 放后台并关 console 窗口，wsl.exe 退出但后台 Linux 进程仍可能需 interop 启 Windows 程序——wslhost 作为独立进程接管 interop socket，保证后台进程互操作不中断。

配置双层：`.wslconfig`（Windows 侧 `%USERPROFILE%\.wslconfig`）由 `wsl::core::Config::ParseConfigFile`（`WslCoreConfig.cpp:32`）解析，管 VM 级设置（kernel/memory/processors/networkingMode），键路径 `wsl2.*`/`experimental.*`；`/etc/wsl.conf`（Linux 侧）由 init 解析管 distro 级。VM 级放 Windows 侧、distro 级放 Linux 文件系统内，因影响域不同。`NetworkingMode`/`DnsTunneling`/`Firewall`/`AutoProxy` 同时注册 `wsl2.xxx` 和 `experimental.xxx` 双键（`:114-118`），从实验性到正式平滑迁移。WSL1 兼容遗留：`CreateLxProcess` 返回非空 `ProcessHandle` 即 WSL1，走 `LxBusClientWaitForLxProcess`（lxss bus IOCTL，不需 socket relay），但 interop 仍需独立线程（`LxssServerPort`）。

## 设计模式

| 模式 | 位置（文件:方法） | 为什么用 |
| --- | --- | --- |
| 策略（按 handle 类型分流） | `StandardInputRelay` `relay.cpp:410` | console 事件流 vs pipe 字节流，两种来源需不同读取策略 |
| 模板方法 | `OverlappedIOHandle` `HandleIO.h:68` | 基类定 `Schedule`/`Collect`/状态机，子类只实现 IO 细节 |
| 策略+泛型 | `RelayHandle<TRead>` `HandleIO.h:332` | 模板注入读取策略，避免虚函数开销且类型安全 |
| 外观 | `SvcComm` `svccomm.hpp:24` | 封装 COM 样板（context/error/relay 管道），调用方一行 |
| RAII | `ScopedRelay`/`ConsoleState`/`wil::scope_exit` | 确定性清理，`ScopedRelay` 析构顺序防死锁 |
| 观察者 | `MultiHandleWait` `HandleIO.h:476` | `concurrent_queue`+线程池回调，回调中可动态加 handle |
| 命令分发 | `WslMain` `WslClient.cpp:1523` | 15+ 子命令各独立，新增只加 `else if` |
| 配置多层覆盖 | `ConfigKey` 双键 `WslCoreConfig.cpp:114` | `experimental.*`→`wsl2.*` 平滑迁移 |

## 模块间交互

- **被共用**：`wsl.exe`（`WslClient::Main`）、`wslrelay.exe`（`relay::InterruptableRelay`/`BidirectionalRelay`，按 `RelayMode` 分发）、`wslhost.exe`（`interop::WorkerThread`/`VmModeWorkerThread` + COM `NotificationActivator`）、`wslc.exe`（`wslutil`/`ExecutionContext`，但不走 `SvcComm`/`relay`/`interop`）、`wslservice.exe`（大量复用 `helpers`/`relay`/`interop`/`registry`/`WslCoreConfig`）。
- **import**：`src/windows/inc/`（`wsl.h`/`wslrelay.h`/`wslhost.h` 命令常量、`lxssclient.h`/`lxssbusclient.h` WSL1、`LxssDynamicFunction.h` 动态加载、`wslpolicies.h`、`wslversioninfo.h`）；`src/shared/inc/`（`SocketChannel`、`Localization`、`retry`、`string`、`LX_INIT_*` 消息协议）。
- **与 wslservice**：COM `CoCreateInstance(ILxssUserSession, CLSCTX_LOCAL_SERVER)` 带重试（1s 间隔、1min 超时，`svccomm.cpp:169`），`EOAC_DYNAMIC_CLOAKING` 使调用用 wsl.exe 身份而非服务身份。
- **与 Linux relay/进程**：WSL2 走 hvsocket（5 通道经 `SocketChannel`）；WSL1 走 lxss bus driver（`ProcessHandle` + `LxssServerPort`/`LxssMessagePort`，VFS fd marshal/unmarshal）。

## 扩展方式

### 新增一个 wsl 子命令

1. `src/windows/inc/wsl.h` 定义参数常量（`#define WSL_XXX_ARG L"--xxx"`）。
2. `WslClient.cpp` 的 `WslMain` for 循环（`:1542` 附近）加 `else if (argument == WSL_XXX_ARG)` 分支。
3. 实现处理函数，参考 `Manage`（`:883`）：`ArgumentParser` 二级解析 + `SvcComm service` + 调对应 COM 方法（`svccomm.hpp`/`.cpp` 加封装，底层调 `m_userSession->` 新 COM 方法）。
4. 更新 `Localization` 消息资源；若需服务侧逻辑，改 `LxssUserSession` COM 实现。

### 修改 relay 对某种句柄的处理

1. `HandleIO.h` `ReadConsoleHandle` 构造（`:246`）确认 `DetachSequence`/`OnDetach` 参数。
2. `HandleIO.cpp:937` `Collect()` 的 detach 检测（`std::ranges::equal(CurrentSequence, DetachSequence)`）。
3. 调用方（`relay.cpp:422` `StandardInputRelay`）传新 detach sequence；涉及新 console 事件类型则改 `INPUT_RECORD` 处理。

### 新增配置项

1. `WslCoreConfig.h` `ConfigSetting` 命名空间加键路径常量。
2. `Config` struct 加字段。
3. `WslCoreConfig.cpp:72` `keys` 列表加 `ConfigKey`。
4. `Config::Initialize`（`:291`）加默认值/验证；`CONFIG_TELEMETRY` 宏加遥测。
5. Linux 侧 mini init 加对应解析（不在 common 内）。
