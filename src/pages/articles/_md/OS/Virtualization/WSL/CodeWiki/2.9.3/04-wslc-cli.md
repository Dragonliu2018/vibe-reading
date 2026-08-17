---
source:
  type: "源码解读"
  project: "WSL"
  url: "https://github.com/microsoft/WSL"
title: "wslc 容器管理 CLI"
date: "2026-08-16T00:15:00+08:00"
category: [OS, Virtualization, WSL, CodeWiki, "2.9.3"]
tags: ["WSL", "C/C++", "Windows", "Linux", "虚拟化", "容器"]
description: "WSL 新一代 docker-like 容器 CLI——命令树+Task+Service 三层、per-user 会话运行时与复用 dockerd HTTP API。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/WSL/CodeWiki/2.9.3/00-overview)

---

## 模块定位

`src/windows/wslc/`（CLI 客户端，~14k 行）+ `src/windows/wslcsession/`（会话运行时，~13k 行）+ `src/windows/WslcSDK/`（SDK，~7k 行）合起来是 WSL 新增的容器管理子系统 `wslc.exe`。它提供 docker 风格命令（`wslc container/image/volume/network/session/registry ...`），经 COM 调 `wslservice.exe` 的 `WSLCSessionManager`，后者在 VM 内启动 `wslcsession.exe` 进程与内嵌 `dockerd` 通信，实现容器生命周期管理。这是 WSL 从"运行 Linux 发行版"向"容器平台"演进的核心。

wslc 的价值不在自造容器运行时——容器运行时极复杂（OCI runtime、镜像分层、存储驱动）——而在 Windows 集成层：VM 生命周期、端口转发、卷映射、IO relay、per-user 安全隔离。它复用标准 dockerd HTTP API 获得完整 Docker 生态兼容性（标准 Dockerfile、OCI 镜像、docker-compose）。

## 模块架构

四层架构，每层是独立进程或 COM 边界：

![wslc 容器管理四层架构](/vibe-reading/images/articles/wsl-internals/wslc-architecture.svg)

- **CLI 客户端层**（`wslc.exe`，user 进程）：`Command`（`Command.h:31`，Composite 命令树）→ `CLIExecutionContext`（`:20`，携带 Args/Data/Reporter/CancelEvent）→ `Task`（`Task.h:22`，Command 模式，`operator<<` 链式）→ `Service` 层（`ContainerService`/`SessionService`，封装 COM）。`RootCommand::GetCommands`（`RootCommand.cpp:31`）注册 Container/Image/Volume/Network/Registry/Settings/System 命令组 + root-scoped 快捷命令（`images`/`rmi`/`run`/...）。
- **SYSTEM 服务层**（`wslservice.exe` 内）：`WSLCSessionManager`/`WSLCSessionManagerImpl`（`WSLCSessionManager.h:76`），持有 `m_sessions`（`SessionEntry` 弱引用 + `CallingProcessTokenInfo` 安全元数据）、`m_persistentSessions`（持久会话强引用）。创建 per-user `wslcsession.exe` 进程，用 `Job Object`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）确保崩溃清理。
- **会话运行时层**（`wslcsession.exe`，per-user COM 服务）：`WSLCSessionFactory`（`WSLCSessionFactory.h:32`，`REGCLS_SINGLEUSE` 单次激活工厂）→ `WSLCSession`（`WSLCSession.h:76`，`IWSLCSession` 实现，每会话独立 VM + 独立 dockerd）→ `WSLCContainerImpl`（`WSLCContainer.h:67`，容器生命周期）→ `DockerHTTPClient`（`DockerHTTPClient.h:99`，Boost.Beast HTTP over AF_HYPERV socket）。
- **VM 内 dockerd**：标准 `containerd` + `dockerd`（`StartContainerd`/`StartDockerd` `WSLCSession.cpp:639-667`），Docker Engine REST API。

之所以 per-session 独立 VM + 独立 dockerd，而非共享：安全隔离（不同用户容器各自身份、daemon 不共享）、故障隔离（一用户 dockerd 崩溃不影响他人）、资源隔离（独立内核/cgroup 层级）。

## 调用链路

一次 `wslc run nginx` 的端到端链路：

链路关键节点：`wmain`（`Main.cpp:179`）→ `CoreMain`（`:30`，COM/Winsock 初始化 + `CLIExecutionContext context` + `SetConsoleCtrlHandler` 路由 Ctrl-C 到 `CancelEvent`）→ `RootCommand`（`:70`）→ `FindSubCommand` 循环（`Command.cpp:274`，`RootCommand`→`ContainerCommand`→`ContainerRunCommand`）→ `ParseArguments`/`ValidateArguments` → `Execute`→`ExecuteInternal`。`ContainerRunCommand::ExecuteInternal`（`ContainerRunCommand.cpp:85`）用 Task 链：`context << ResolveSession << SetContainerOptionsFromArgs << RunContainer`。

`ResolveSession`（`SessionTasks.cpp:61`）→ `SessionService::OpenOrCreateDefaultSession`（`SessionService.cpp:55`）→ `CreateSessionManager`（`:27`，`CoCreateInstance(WSLCSessionManager, CLSCTX_LOCAL_SERVER)`）→ `manager->CreateSession` → `WSLCSessionManagerImpl::CreateSession`（记录 `CallingProcessTokenInfo`、`ResolveDefaultSessionName`、`CreateSessionProcessJob` 经 `CoCreateInstanceAsUser(WSLCSessionFactory)` 启 per-user `wslcsession.exe`）→ `WSLCSessionFactory::CreateSession`（`:32`，`WSLCSession::Initialize` 创 VM + `StartContainerd`/`StartDockerd` + 等 `m_dockerdReadyEvent` + 建 `DockerHTTPClient`）→ 返回 `IWSLCSession` + `IWSLCSessionReference` 弱引用 → 存入 `context.Data[Data::Session]`。

`RunContainer`（`ContainerTasks.cpp:368`）→ `ContainerService::Run`（`ContainerService.cpp:398`）→ `CreateInternal`（`:45`，`WSLCContainerLauncher` → `session->CreateContainer` COM → `WSLCSession::CreateContainerImpl` `:1942` → `m_dockerClient.CreateContainer` `:274` 经 `Transaction<CreateContainer>` POST `/containers/create`）→ `container.Start`（`m_dockerClient.StartContainer` POST `/containers/{id}/start`）→ `ConsoleService::AttachToCurrentConsole`（IO relay）。镜像不存在时 `WSLC_E_IMAGE_NOT_FOUND` 自动 `ImageService::Pull`（POST `/images/create`）后重试。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `CoreMain` `Main.cpp:30` | wslc 入口，初始化+命令树+分发 | CancelEvent 路由 Ctrl-C |
| `Command::FindSubCommand` `Command.cpp:274` | 子命令解析循环 | Composite，按 Name/Aliases 匹配 |
| `Task::operator<<` `Task.h` | 链式执行任务 | Command 模式，`context << T1 << T2` |
| `SessionService::OpenOrCreateDefaultSession` `SessionService.cpp:55` | COM 建/开会话 | CreateSessionManager + impersonation |
| `WSLCSessionManagerImpl::CreateSession` `WSLCSessionManager.h:175` | 启 per-user 进程+记安全上下文 | Job Object + CallingProcessTokenInfo |
| `WSLCSessionFactory::CreateSession` `WSLCSessionFactory.cpp:32` | 创 WSLCSession+弱引用 | REGCLS_SINGLEUSE 单次激活 |
| `WSLCSession::Initialize` `WSLCSession.cpp:326` | 创 VM+启动 dockerd+建 HTTP 客户端 | 等 dockerdReadyEvent |
| `DockerHTTPClient::Transaction` `DockerHTTPClient.h` | 泛型 JSON 事务 POST→解析 | HTTP over AF_HYPERV |
| `ContainerService::Run` `ContainerService.cpp:398` | 创建+启动+attach 容器 | 镜像不存在自动 pull |

</details>

## 核心实现

### 命令树 + ExecutionContext + Task 三层分离

`Command`（`Command.h:31`）是 Composite 模式核心：`GetCommands()` 返回子命令列表，`FindSubCommand`（`Command.cpp:274`）按 `Name()`/`Aliases()` 匹配递归下降到叶命令；`ParseArguments`（`:314`，`ParseArgumentsStateMachine` 驱动）/`ValidateArguments`（`:342`）/`Execute`（`:373`，检查 `--help` 否则调 `ExecuteInternal`）是模板方法。`ContainerCommand`（`ContainerCommand.h:19`）注册 14 个子命令（attach/create/exec/inspect/kill/list/logs/prune/remove/run/start/stats/stop），`ImageCommand` 含 root-scoped 别名技巧（`ImageListCommand` 在根下用 `"images"` 名、在 image 下用 `"list"`，避免与 `container list` 冲突）。

`CLIExecutionContext`（`CLIExecutionContext.h:20`，继承 `ExecutionContext(Context::WslC)`）携带 `Args`（叶命令参数）、`GlobalArgs`（`--session` 等）、`Data`（`DataMap` variant map，Task 间传递 Session/Containers/ContainerOptions/Images/Volumes/Networks）、`Reporter`、`CancelEvent`、`ExitCode`。`Task`（`Task.h:22`）是 Command 模式：`operator<<(CLIExecutionContext&, const Task&)` 链式执行，`context << ResolveSession << SetContainerOptionsFromArgs << RunContainer`。三层分离让每层独立可测：命令树只管参数解析/帮助，Task 层编排执行步骤，Service 层处理 COM 细节；新增命令只需写 `GetArguments()` + `ExecuteInternal()`（一行 Task 链）。`DataMap`（`ExecutionContextData.h:30`，`EnumBasedVariantMap`）用 variant 在 Task 间传数据，避免 Task 间直接耦合。

### 复用 dockerd API 与会话进程模型

`DockerHTTPClient`（`DockerHTTPClient.h:99`）封装全套 Docker REST API（`/containers/*`、`/images/*`、`/volumes/*`、`/networks/*`），`HTTPRequestContext`（`:136`）每请求独立 `boost::asio::io_context` + `generic::stream_protocol(AF_HYPERV)`。流程（`:14-23` 注释）：`WSLC_FORK` 消息发 VM init 获新 hvsocket channel → `WSLC_UNIX_CONNECT` 连 `/var/run/docker.sock` → HTTP 请求。简单响应直接读，流式（attach/logs/import）返回 `wil::unique_socket` 供调用方操作。泛型 `Transaction<TRequest,TResponse>`（序列化 JSON→POST→反序列化，失败 throw `DockerHTTPException`）。

会话进程模型：`WSLCSessionFactory`（`WSLCSessionFactory.h:32`）注册 `REGCLS_SINGLEUSE`（单次激活，每次 `CreateSession` 启一个新 per-user 进程）。每个 `WSLCSession` 创独立 `WSLCVirtualMachine`（HCS VM），VM 内启独立 `containerd` + `dockerd`。SYSTEM 服务持 `IWSLCSessionReference` 弱引用跟踪生命周期，`CallingProcessTokenInfo`（`WSLCSessionManager.h:49`）创建时记 caller 安全上下文，后续 `CheckTokenAccess` 校验防伪造，持久会话由服务持强引用保活。

### IO relay 复用与表格输出

`IORelay`（`IORelay.h:19`）独立线程 `Run`（`WaitForMultipleObjectsEx` 循环），管多个 `OverlappedIOHandle`，`m_refreshEvent` 动态加 handle。容器 attach/logs/exec 流式操作返回 raw socket，由 `RelayedProcessIO` 包装入 `IORelay` 双向中继（复用 common 的 `StandardInputRelay`/`InterruptableRelay`）。`HttpHeaderEndDetector`（`DockerHTTPClient.h:203`）处理 HTTP 响应头结束检测，`HTTPChunkBasedReadHandle` 处理 chunked transfer。Ctrl-C 经 `CancelEvent` 传到 COM 层（`WSLCSession::WaitForEventOrSessionTerminating`）让长操作可中断；`ForEachAsync`（`AsyncExecution.h:39`）有界并发批量执行（batch 10，wall time ∝ ceil(N/10)）。`TableOutput<FieldCount>`（`TableOutput.h:87`）模板化自适应表格（编译期列数、栈分配），复现 docker 的列宽自适应（`PreferredShrink` 优先收缩、`MaxWidth`/`MinWidth`、console 宽度自适应、重定向不收缩 `DefaultRedirectedConsoleWidth=2000`）。

## 设计模式

| 模式 | 位置（文件:方法） | 为什么用 |
| --- | --- | --- |
| Composite（命令树） | `Command` `Command.h:31`，`RootCommand::GetCommands` `.cpp:31` | `GetCommands` 返回子命令，递归下降；新增命令组只加一个 push_back |
| Command（Task 链） | `Task` `Task.h:22`，`operator<<` | 链式 `context<<T1<<T2`，Task 层编排可独立测 |
| 工厂 | `WSLCSessionFactory` `WSLCSessionFactory.h:32` | per-user COM 工厂，`REGCLS_SINGLEUSE` 单次激活 |
| 策略 | `Reporter`/`OutputChannel` `Reporter.h:59`/`OutputChannel.h:27` | VT strip 按 `vtEnabled`/`colorEnabled` 运行时分流 |
| 模板元编程 | `TableOutput<FieldCount>`/`ForEachAsync` `TableOutput.h:87`/`AsyncExecution.h:39` | 编译期列数栈分配避免堆；泛型批处理复用 |
| RAII | `wil::CoInitializeEx`/`scope_exit`/`unique_socket`/`OutputChannel::m_vtMode` | 贯穿全代码库，确定性清理 |

## 模块间交互

- **四层通信**：`wslc.exe`→`wslservice.exe`（COM `CLSCTX_LOCAL_SERVER`，`IWSLCSessionManager` `CreateSession`/`OpenSession`/`ListSessions`/`EnterSession`，`ConfigureForCOMImpersonation`）；`wslservice.exe`→`wslcsession.exe`（COM per-user，`CoCreateInstanceAsUser` 触发进程启动，`IWSLCSessionFactory::CreateSession` 返回 `IWSLCSession`+`IWSLCSessionReference`，`Job Object` 关联）；`wslcsession.exe`→`dockerd`（HTTP/1.1 over AF_HYPERV socket，Boost.Beast，`WSLC_FORK`+`WSLC_UNIX_CONNECT`）。
- **与 common/ 与 shared/**：复用 common 的 `ExecutionContext` 基类、`wslutil`（CRT/COM/安全）、`docker_schema`（Docker API JSON schema）、`io`（`OverlappedIOHandle`/`MultiHandleWait`）、`relay`（`StandardInputRelay`/`InterruptableRelay`）、`ConsoleState`、`vt`；复用 shared 的 `Localization`、`string`、`SocketChannel`、`ToJson`/`FromJson`、`OfficialBuild`。
- wslc.exe 是与传统 wsl.exe 并行的独立 CLI（独立入口 `CoreMain`/`wmain`、namespace `wsl::windows::wslc`、`s_ExecutableName=L"wslc"`），共享 `wslservice.exe` 和 common，但会话模型不同：wsl.exe 走 `WslApi` 直接操作 distro，wslc 走 `IWSLCSessionManager` 操作容器。`IWSLCCompatSession`/`IWSLCCompatContainer` 兼容接口表明新旧 API 版本共存。COM + dockerd 架构比传统 distro 模型更适合容器场景（隔离性、API 兼容性、生命周期管理）。

## 扩展方式

### 新增一个 wslc 子命令（如 `wslc container pause`）

1. `commands/ContainerCommand.h` 新增 `ContainerPauseCommand`（继承 `Command`，实现 `GetArguments`/`ShortDescription`/`ExecuteInternal`）。
2. `commands/ContainerCommand.cpp` 的 `GetCommands()`（`:22`）`push_back(std::make_unique<ContainerPauseCommand>(FullName()))`。
3. `commands/ContainerPauseCommand.cpp`（新文件）实现 `ExecuteInternal`，通常为 `context << ResolveSession << PauseContainers`。
4. `tasks/ContainerTasks.h/.cpp` 声明+实现 `PauseContainers`，调 `ContainerService::Pause`。
5. `services/ContainerService.h/.cpp` 加 `Pause`，调 `session->OpenContainer(id)` 后调容器 COM 方法。
6. `wslcsession/WSLCSession.h/.cpp` 如需新 COM 接口方法，加 `IFACEMETHOD(Pause)` 委托 `WSLCContainerImpl::Pause`。
7. `wslcsession/DockerHTTPClient.h/.cpp` 加 `PauseContainer`，`POST /containers/{id}/pause`。
8. `arguments/ArgumentDefinitions.h` 如有新参数定义 `ArgType`+`Argument`；`CMakeLists.txt` 加新 `.cpp`。

### 新增一个容器选项（如 `--init-path`）

1. `arguments/ArgumentDefinitions.h` 定义 `ArgType::InitPath`+`Argument::Create(...)`。
2. `commands/ContainerRunCommand.cpp`/`ContainerCreateCommand.cpp` 的 `GetArguments()` 加 `Argument::Create(ArgType::InitPath)`。
3. `services/ContainerModel.h` 的 `ContainerOptions` 加 `std::optional<std::string> InitPath`。
4. `tasks/ContainerTasks.cpp` 的 `SetContainerOptionsFromArgs`（`:377`）加 `if (context.Args.Contains(ArgType::InitPath)) options.InitPath=...`。
5. `services/ContainerService.cpp` 的 `CreateInternal`（`:45`）传给 `WSLCContainerLauncher`。
6. COM/IDL 与 `wslcsession/WSLCContainer.cpp` 的 `Create` 透传到 `docker_schema::CreateContainer`。

### 新增一种卷类型（如 NFS volume）

1. `wslcsession/WSLCVolumes.h/.cpp` 的卷创建逻辑加新类型分支（或新 `WSLCNFSVolume.h/.cpp`）。
2. `wslc.h`/IDL 的 `WSLCVolumeOptions` 加类型字段。
3. `wslc/commands/VolumeCreateCommand.cpp` 加 `--driver nfs` 参数。
4. `wslc/tasks/VolumeTasks.cpp`/`services/VolumeService.cpp` 透传选项。
5. `wslcsession/DockerHTTPClient.cpp` 的 `POST /volumes/create` 传 driver opts。
