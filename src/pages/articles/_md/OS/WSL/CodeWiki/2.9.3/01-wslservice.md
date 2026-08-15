---
source:
  type: "源码解读"
  project: "WSL"
  url: "https://github.com/microsoft/WSL"
title: "WslService 服务核心"
date: "2026-08-16T00:15:00+08:00"
category: [OS, WSL, CodeWiki, "2.9.3"]
tags: ["WSL", "C/C++", "Windows", "Linux", "虚拟化", "容器"]
description: "wslservice.exe——Session 0 COM 系统服务、HCS 轻量 VM 生命周期、分发版注册与 per-user 会话管理剖析。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/WSL/CodeWiki/2.9.3/00-overview)

---

## 模块定位

`src/windows/service/exe/`（实现）+ `src/windows/service/inc/`（IDL/头）+ `mc/`（message compile）是 `wslservice.exe` 的全部——一个以 SYSTEM 身份运行在 Session 0 的 Windows 服务，~23,000 行 C++。它是整个 WSL Windows 侧的中枢：所有 `wsl.exe`/`wslapi.dll` 的请求都经 COM（`ILxssUserSession`）打到这里，由它决定启动/复用哪台 WSL2 轻量虚拟机、把分发版 VHD 挂上去、经 hvsocket 把"创建进程"的指令送进 VM 内的 init。它还管分发版注册表、客户端进程生命周期、drvfs 重定向驱动、插件钩子，以及一套并行的 WSLC 容器会话 API。

可以把 wslservice 理解成"WSL 的资源调度器 + 安全边界"——它以最高权限运行却要服务任意普通用户，per-user 隔离、VM 复用、按需启停都由它裁决。

## 模块架构

wslservice 的内部结构可分四层，每层是一组协作的类：

![WslService 内部架构](/vibe-reading/images/articles/wsl-internals/wslservice-architecture.svg)

- **COM 接入层**：`LxssUserSessionFactory`（`LxssUserSessionFactory.h:26`）是 COM 类工厂，`LxssUserSession`（`LxssUserSession.h:68`）是薄 COM 外观，持有 `weak_ptr<LxssUserSessionImpl>`。客户端 `CoCreateInstance(CLSID_LxssUserSession)` 经工厂查到/新建 per-user 的 `LxssUserSessionImpl`，COM 对象随时释放重建都不影响底层 session 生命周期。
- **会话编排层**：`LxssUserSessionImpl`（`LxssUserSession.h:311`）是 per-user 实现核心，持有 `m_runningInstances`（按 DistroGuid 索引的运行实例表）、唯一的 `m_utilityVm`（WSL2 VM）、`LifetimeManager`（客户端进程跟踪）、`m_pluginManager`。`CreateInstance`/`CreateLxProcess`/`RegisterDistribution`/`Shutdown` 都落在这里。
- **VM 与实例层**：`WslCoreVm`（`WslCoreVm.h:48`）管 HCS 轻量 VM 的创建/启动/挂载磁盘/全局 hvsocket 控制通道；`WslCoreInstance`（`WslCoreInstance.h:25`）是单个运行中分发版，持有与该分发版 init 守护进程的 per-distro hvsocket 通道、`ConsoleManager`、关联的系统分发版。两者都继承 `LxssRunningInstance` 抽象基类——但 `WslCoreVm` 本身不是实例，`WslCoreInstance` 才是 `LxssRunningInstance` 的 WSL2 实现。
- **支撑层**：`DistributionRegistration`（注册表抽象）、`LifetimeManager`（进程生命周期）、`PluginManager`（插件钩子）、`GuestDeviceManager`（VM 内虚拟设备）、`ConsoleManager`（会话领导）、各 `Networking*` 类（NAT/Mirrored/Consomme）、`WSLCSessionManager`（并行容器 API）。

之所以把 COM 外观与实现分离，是因为 COM 对象引用计数归零（wsl.exe 退出）不应销毁 per-user session——session 由全局 `g_sessions` 的 `shared_ptr` 保活，COM 对象只持 `weak_ptr`，下次 `CoCreateInstance` 仍能 `lock()` 回同一个实现。

## 调用链路

一次 `wsl.exe` 调 COM `CreateLxProcess` 在服务侧的链路（hvsocket 跨域后进入 Linux init，详见 [Linux 初始化子系统](02-linux-init)）：

数据流的关键节点：`LxssUserSessionFactory::CreateInstance`（`LxssUserSessionFactory.cpp:150`）→ `CreateInstanceForCurrentUser`（`:201`）按 SID 在 `g_sessions` 查/建 session → `LxssUserSessionImpl::_CreateInstance`（`LxssUserSession.cpp:2493`）查注册表 `DistributionRegistration::OpenOrDefault`、查 `_RunningInstance` 复用，否则在 line 2535 按 `LXSS_DISTRO_FLAGS_VM_MODE` 分叉 WSL1/WSL2。WSL2 路径调 `_CreateVm`（`:2848`，`if (!m_utilityVm)` 按需创建：`WslCoreVm::Create` → `hcs::CreateComputeSystem` 生成 JSON 配置 → `hvsocket::Listen(runtimeId, 50000)` 监听 → `hcs::StartComputeSystem` → `AcceptConnection` 等 mini_init 连入建立 `m_miniInitChannel`），再 `m_utilityVm->CreateInstance(instanceId, config, LxMiniInitMessageLaunchInit, ...)`（`WslCoreVm.cpp:1177`）把 VHD 挂成 SCSI LUN、经 `m_miniInitChannel` 发 `LX_MINI_INIT_MESSAGE`、`AcceptConnection` 等该分发版 init 连入、构造 `WslCoreInstance` 并 `Initialize`（发 `LX_INIT_CONFIGURATION_INFORMATION` 握手）。

进程创建链路：`LxssUserSessionImpl::CreateLxProcess`（`:768`）→ `LxssCreateProcess::ParseArguments` + `CreateMessage`（`LxssCreateProcess.cpp:108`，序列化成 offset-based 的 `LX_INIT_CREATE_PROCESS_UTILITY_VM` 消息）→ `WslCoreInstance::CreateLxProcess`（`WslCoreInstance.cpp:151`）→ `ConsoleManager::GetSessionLeader` 获取/创建 session leader（发 `LX_INIT_CREATE_SESSION` → 收 `LX_INIT_CREATE_SESSION_RESPONSE{Port}` → `hvsocket::Connect(runtimeId, port)`）→ `sessionLeader->GetChannel().Transaction<LX_INIT_CREATE_PROCESS_UTILITY_VM>(span).Result` 拿到 relay 监听端口 → `hvsocket::Connect(runtimeId, port)` × 5 建立 stdin/stdout/stderr/control/interop 五条数据通道，返回给 wsl.exe。

注意 `WslCorePort::Lock()`（`WslCoreInstance.h:41`）返回 `wil::cs_leave_scope_exit` 串行化会话领导通道——否则两个并发 `CreateLxProcess` 可能交叉读取对方响应（`WslCoreInstance.cpp:227` 注释）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `LxssUserSessionFactory::CreateInstance` `:150` | COM 工厂创建/复用 session | per-user 单例 + weak_ptr |
| `CreateInstanceForCurrentUser` `:201` | 按 SID 查/建 `LxssUserSessionImpl` | 双锁层次避免死锁 |
| `LxssUserSessionImpl::_CreateInstance` `:2493` | 创建/复用分发版实例 | WSL1/WSL2 在 line 2535 分叉 |
| `LxssUserSessionImpl::_CreateVm` `:2848` | 按需创建/复用 utility VM | `if (!m_utilityVm)` 复用 |
| `WslCoreVm::Initialize` `:146` | HCS VM 创建+启动+early config | JSON 配置 + hvsocket 监听 50000 |
| `WslCoreVm::CreateInstance` `:1177` | 挂 VHD、发 LaunchInit、建 WslCoreInstance | offset-based 消息经 hvsocket |
| `WslCoreInstance::Initialize` `:364` | 与 init 握手、发 CONFIGURATION_INFORMATION | 5 个 handle 在 CreateLxProcess 建立 |
| `WslCoreInstance::CreateLxProcess` `:151` | 发创建进程消息、connect 5 socket | 串行化 session leader 通道 |
| `_TerminateInstanceInternal` `:3589` | 终止单个分发版 | 延迟析构避免锁内死锁 |
| `_VmCheckIdle` / `_VmIdleTerminate` `:3857/3879` | VM 空闲超时自动销毁 | threadpool timer + InstanceIdleTimeout |
| `LifetimeManager::RegisterCallback` `Lifetime.cpp:96` | 关联客户端进程、聚合退出 | 多进程聚合 + 60s 重试 |

</details>

## 核心实现

### per-user COM session 单例与 weak_ptr 外观

`wslservice.exe` 以 SYSTEM 在 Session 0 运行，却要服务多个普通用户的 WSL 请求。`CreateInstanceForCurrentUser`（`LxssUserSessionFactory.cpp:201`）取调用者 token → `GetTokenInformation` 得 SID → 在全局 `g_sessions`（`optional<vector<shared_ptr<LxssUserSessionImpl>>>`，`:30`）里按 `EqualSid` 查找：找到就复用，没找到就 `new LxssUserSessionImpl`。每个 Windows 用户 SID 对应唯一一个 session，分发版实例、VM、注册表键互不干扰。

COM 对象 `LxssUserSession` 只持 `weak_ptr<LxssUserSessionImpl>`（`LxssUserSession.h:305`），每个 IFACEMETHOD 做 `m_session.lock()`，失败返回 `RPC_E_DISCONNECTED`。这样 wsl.exe 退出（COM 引用归零）不会销毁 session——它由 `g_sessions` 的 `shared_ptr` 保活，下次 `CoCreateInstance` 仍 `lock()` 回同一个实现，复用已运行的 VM 与分发版。

锁层次是这里的难点：`g_sessionTerminationLock`（recursive_mutex）必须**先于** `g_sessionLock`（SRWLOCK）获取（`LxssUserSessionFactory.cpp:27`）。原因是 `ClearSessionsAndBlockNewInstances` 持 `g_sessionTerminationLock` 时调 `session->Shutdown()`（会取 `m_instanceLock`），若另一线程持 `g_sessionLock` 想取 `m_instanceLock` 就与 `Shutdown` 反向持锁死锁。规避法是先把 `g_sessions` `std::move` 移出再释放 `g_sessionLock`，然后才调 `Shutdown`（`:60-70`）。用户登出时 `WslService::OnSessionChanged`（`ServiceMain.cpp:231`）捕获 `WTS_SESSION_LOGOFF` → `TerminateSession` 从 `g_sessions` 移除并 Shutdown。

### VM 复用与按需启停

`_CreateVm`（`LxssUserSession.cpp:2848`）开头 `if (!m_utilityVm)` 是 WSL2 秒级启动的关键：首个 WSL2 分发版启动时才 `WslCoreVm::Create`（HCS VM 启动耗数秒，见 `WslCoreVm.cpp:94` 的 `CreateVmBegin/End` telemetry），后续分发版复用同一台 VM——所有 WSL2 分发版共享一个 utility VM，各自以 VHD 挂载（`WslCoreVm.cpp:1190` `AttachDiskLockHeld`）方式运行，靠 Linux namespace 隔离。

VM 销毁是延迟的：每次分发版终止后 `_VmCheckIdle`（`:3857`）检查 `_VmIsIdle`（所有分发版已终止、无锁定分发版），为真则设 threadpool timer，到期触发 `s_VmIdleTerminate` → `_VmIdleTerminate` → `_VmTerminate`（`:3901`）。`InstanceIdleTimeout` 负值时永不自动终止（`:3867` `if (timeout >= 0)`），需用户手动 `wsl --shutdown`。`_VmTerminate` 的清理顺序讲究：取消定时器 → `OnVmStopping` 插件通知 → `m_vmTerminating.SetEvent()`（ManualReset，因 distroExit 回调在析构期可能多次触发，`:3928` 注释）→ join telemetry 线程 → `m_utilityVm.reset()`（`WslCoreVm` 析构等 distroExitThread）→ `m_vmId = GUID_NULL` → `m_userToken.reset()` → ResetEvent 允许 VM 重建。

### WSL1/WSL2 双路径与 `LxssRunningInstance` 多态

WSL1 基于 Lxcore 内核驱动（pico 进程，Linux 系统调用在 Windows 内核模拟），WSL2 基于 HCS utility VM（完整内核跑在轻量 VM）。架构根本不同，但 `_CreateInstance`（`:2493`）在 line 2535 用一个 flag 分叉：`WI_IsFlagSet(configuration.Flags, LXSS_DISTRO_FLAGS_VM_MODE) ? V2 : V1`。WSL1 走 `LxssInstance`（`:2565`，Lxcore IOCTL + `LxssMessagePort`），WSL2 走 `_CreateVm()` + `WslCoreInstance`（`:2587`，hvsocket + `SocketChannel`）。

两者由抽象基类 `LxssRunningInstance`（`LxssCreateProcess.h:120`）统一——11 个纯虚方法（`CreateLxProcess`/`Initialize`/`RequestStop`/`Stop`/`GetDistributionId`/...）。`LxssUserSessionImpl` 通过 `m_runningInstances` 里的 `shared_ptr<LxssRunningInstance>` 管理，无需感知 WSL1/WSL2 差异；通信细节差异被各自的 `LxssPort` 子类封装。WSL1 还额外有策略检查（`:2567` `c_allowWSL1`，禁用时返回 `WSL_E_WSL1_DISABLED` 提示升级）。`SetVersion` 命令靠改写注册表 `Flags` 的 `VM_MODE` 位在两者间切换。

### hvsocket 三层通道与 offset-based 消息协议

Windows 侧与 Linux 侧（VM 内 mini_init/init）运行在不同执行域，hvsocket（基于 Hyper-V hypervisor 的 socket，按 `runtimeId` GUID 寻址）是唯一无需网络栈的高性能跨域通道。协议分三层：

1. **全局控制通道** `m_miniInitChannel`：`WslCoreVm` 在 `LX_INIT_UTILITY_VM_INIT_PORT`(50000) 上 `Listen`（`:338`），mini_init 启动后主动连。用于 VM 级控制（`LX_MINI_INIT_MESSAGE` 创建分发版、Import/Export、磁盘挂载）。
2. **Per-distro 实例通道** `m_initChannel`：每个分发版启动时 mini_init 让 init 连入，`WslCoreVm::CreateInstanceInternal`（`:1256`）`AcceptConnection` 等。用于实例级控制（`LX_INIT_CONFIGURATION_INFORMATION` 配置、`LX_INIT_CREATE_PROCESS_UTILITY_VM` 创建进程、`LX_INIT_TERMINATE_INSTANCE` 终止、`LX_INIT_MOUNT_DRVFS` 重挂载）。
3. **Per-process 数据通道**：进程创建时 init 回传一个动态端口号（`:228` `Transaction<...>().Result`），Windows 侧 `hvsocket::Connect(runtimeId, port)` × 5 建 stdin/stdout/stderr/control/interop 五条独立数据通道（`:238-250`）。固定端口（50000）省去服务发现，动态端口避并发冲突。

消息用 **offset-based 变长结构体**：`MESSAGE_HEADER`（MessageType+MessageSize+TransactionId+TransactionStep）+ 固定字段结构体 + 变长 Buffer（所有字符串按 offset 引用，`LxssCreateProcess.cpp:108` `CreateMessage`），避免指针序列化问题。`SocketChannel::Transaction` 提供请求-响应自动配对（TransactionId/Step），支持超时与取消。

### 分发版注册表模型与 `LifetimeManager` 多进程聚合

分发版配置存于用户 HKCU `Software\Microsoft\Windows\CurrentVersion\Lxss\{DistroGuid}`（`wslservice.idl:147`）。`DistributionRegistration`（`DistributionRegistration.h:45`）用 `wil::unique_hkey m_key` + `Property` 命名空间（`:90`）的类型安全模板 `DistributionProperty<T>` / `DistributionPropertyWithDefault<T>` / `ExpectedProperty<T>` 封装读写。选注册表而非文件：HKCU 天然 per-user 隔离（`s_OpenLxssUserKey` 模拟用户身份打开）、写操作原子（`REG_CREATED_NEW_KEY` 检查 + `Create` 的 `do-while` GUID 去重循环）、`ApplyGlobalFlagsOverride`（`DistributionRegistration.cpp:232`）允许管理员经 HKLM 覆盖用户 flags（如禁 interop），但 `VM_MODE` 位不可被覆盖（`:240`，防管理员降级 WSL1）。`State` 属性跟踪状态机（Invalid→Installing→Installed→Running→…）。

`LifetimeManager`（`Lifetime.h:19`）解决"何时自动终止分发版/VM"：`RegisterCallback`（`Lifetime.cpp:96`）注册客户端进程的 threadpool wait，一个 `ClientCallback` 可关联**多个** `OwnedProcess`（多进程聚合，`FindProcess` 按 PID 去重，`:345`）——只有当**所有**关联进程退出（`clientProcesses.empty()`，`:192`）才触发。带超时：最后进程退出后设 timer，到期 `s_OnTimeout`（`:217`）执行回调，返回 `false`（终止失败，如 init 拒绝）则重排队，重试周期 `RETRY_TIMER_PERIOD=60s`（`:18`）；`TimeoutMs==0` 则立即执行不重试。回调绑定 `s_TerminateInstance`（`:2683`），终止成功返回 true 取消定时器。析构用链式等待（`m_lastCallbackWait`，`:92-98` 注释）避免回调与析构的 AV 竞态。

## 设计模式

| 模式 | 位置（文件:方法） | 为什么用 |
| --- | --- | --- |
| 工厂 | `LxssUserSessionFactory` `:26`/`:150` | WRL 无 COM 单例概念，自定义 `IClassFactory` 控制 session 复用 |
| per-user 单例 | `g_sessions`+`FindSessionLockHeld` `:182` | 每 SID 唯一 session，用户隔离 |
| COM 服务（Out-of-Proc） | `ServiceMain.cpp:51` `WslService`+`ILxssUserSession` `idl:172` | Session 0 SYSTEM 服务，安全描述符限 authenticated users |
| 外观/门面 | `LxssUserSession` `:68` | 薄 COM 层，`weak_ptr` 转发到 `Impl`，持 IFastRundown 快速回收 |
| 策略/多态 | `LxssRunningInstance` `LxssCreateProcess.h:120` → `LxssInstance`/`WslCoreInstance` | 统一 WSL1/WSL2 接口，调用方无感 |
| 观察者 | `LifetimeManager::RegisterCallback` `Lifetime.cpp:96` | 多进程聚合 + 超时重试，自动终止分发版 |
| 生成器 | `LxssCreateProcess::CreateMessage` `:108` | COM 参数 → offset-based 二进制消息，跨 hvsocket 可序列化 |

## 模块间交互

- **import**：`common/`（hvsocket/hcs/registry/security/filesystem/helpers/wslutil）、`shared/inc/`（`SocketChannel`/`MessageWriter`/`string`/`Localization`/消息协议头）、`core/`（`Config` VM 配置模型、`INetworkingEngine`）；经 hvsocket 与 Linux init 通信；经 HCS C API 管 VM；经 `LxssClientInitialize` 连 Lxcore 驱动（WSL1）；经 `InitializePlan9Redirector` 确保 `p9rdr` 重定向驱动与 `wsl.localhost`/`wsl$` 注册表（`ServiceMain.cpp:119`）；`PluginManager` 钩子贯穿 VM 生命周期（`OnVmStarted`/`OnVmStopping`/`OnDistributionStarted`/...）。
- **被 import**：`wsl.exe`/`wslapi.dll` 经 `CoCreateInstance(CLSID_LxssUserSession)` 走 `ILxssUserSession`；`wslc` 经 `CLSID_WSLCSessionManager` 走 `IWSLCSessionManager`；`wslhost.exe`/`wslrelay.exe` 由 `WslCoreVm` 经 `m_processJobObject` 创建关联（VM 关闭时自动终止）。
- **两套并行 API**：传统 `ILxssUserSession` 路径（per-user 共享 utility VM，`LxssUserSessionImpl`+`WslCoreVm`+`WslCoreInstance`）与 WSLC session 路径（per-session 独立 VM，`WSLCSessionManager`+`HcsVirtualMachine`）。两者在 `ServiceMain.cpp:35,38` 各注册一个 `CoCreatableClassWrlCreatorMapInclude`，各有独立 session 表与 VM 管理，服务停止时各 `ClearSessions`。WSLC 是较新的容器化设计（详见 [wslc 容器管理 CLI](04-wslc-cli)），传统路径是 per-user 共享 VM 模型。
- 通信方式以 COM（客户端↔服务）与 hvsocket（服务↔Linux init）为主，驱动交互走 IOCTL/注册表。

## 扩展方式

### 新增网络模式

1. `src/windows/service/exe/` 新增 `Networking` 类，继承 `wsl::core::INetworkingEngine`（`WslCoreVm.h:24` 引用）。
2. `WslCoreVm::Initialize`（`:146`）的网络引擎创建处（`:565-609`）加分支实例化。
3. `WslCoreConfig.h` 加 `NetworkingMode` 枚举值 + `ConfigSetting` 键路径。
4. VM 配置 JSON（`GenerateConfigJson` `:1421`）加对应网络设备描述。
5. Linux 侧 gns/localhost 增加对应处理（见 [Linux 初始化子系统](02-linux-init) 的 gns 节）。

### 新增 init 消息

1. `src/shared/inc/lxinitshared.h`：`LX_MESSAGE_TYPE` 枚举新增类型 + 消息结构体（`static inline auto Type`、`MESSAGE_HEADER`、`PRETTY_PRINT`，需响应则 `using TResponse`）。
2. Linux 侧 `src/linux/init/init.cpp` `InitEntryUtilityVm()`（`:2472`）的 `switch` 加 `case`。
3. Windows 侧本模块用 `m_miniInitChannel`/`m_initChannel` 发送。

### 新增分发版注册字段

1. `DistributionRegistration.h` `Property` 命名空间（`:90`）加 `DistributionProperty<T>`。
2. `LxssUserSession.h:757` `s_GetDistributionConfiguration()` 读取到 `LXSS_DISTRO_CONFIGURATION`。
3. `LxssUserSession.cpp:1375` `RegisterDistribution()` 创建时写入。
4. `wslservice.idl` 若需 COM 暴露则改 IDL。
5. `WslCoreVm.cpp:1177` `CreateInstance()` 若影响 VM 启动参数则加进 `LX_MINI_INIT_MESSAGE`。
