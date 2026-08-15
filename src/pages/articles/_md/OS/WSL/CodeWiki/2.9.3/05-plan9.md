---
source:
  type: "源码解读"
  project: "WSL"
  url: "https://github.com/microsoft/WSL"
title: "Plan9 文件服务"
date: "2026-08-16T00:15:00+08:00"
category: [OS, WSL, CodeWiki, "2.9.3"]
tags: ["WSL", "C/C++", "Windows", "Linux", "虚拟化", "容器"]
description: "9P 文件服务实现（libplan9 静态库）——9P2000.W 扩展、fid 生命周期、C++20 协程异步 IO 与 WSL1/WSL2 双传输。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/WSL/CodeWiki/2.9.3/00-overview)

---

## 模块定位

`src/linux/plan9/`（静态库 `libplan9`，CMake `add_linux_library` 编译 11 个 `.cpp`+24 个 `.h`，~9k 行）+ `src/linux/init/plan9.cpp`（服务入口，~328 行）是 WSL 的 9P 文件服务实现。它在分发版内运行一个 9P（9P2000.L / 9P2000.W）文件服务器，把 Linux 文件系统经 hvsocket（WSL2）或 unix socket（WSL1）暴露给 Windows 侧的 `p9rdr.sys` 重定向驱动，实现 `\\wsl.localhost\<distro>` 文件访问。这是 Windows 访问 Linux 文件（drvfs 的正向方向）的底层管道。

注意：plan9 不是独立二进制，而是 `init` 经 `execv(LX_INIT_PATH, ["init","--plan9",...])` 以子命令方式启动、复用同一个 `/init` 二进制。`libplan9` 作为静态库链接进 `init`。

## 模块架构

plan9 server 的内部结构围绕"一个 9P 连接的生命周期"组织，核心组件分四组：

![Plan9 文件服务架构](/vibe-reading/images/articles/wsl-internals/plan9-architecture.svg)

- **协议层**：`p9defs.h`（消息类型 `MessageType` 枚举、`Qid`/`StatResult`/`StatFsResult`/`OpenFlags` 常量、协议版本 `9P2000.L`/`9P2000.W`）、`p9data.h`（`GetMessageSize` 消息类型→wire size 映射）、`p9protohelpers.h`（`SpanReader`/`SpanWriter` header-only 编解码器，`U8/U16/U32/U64/Qid/String/Name`，`Name()` 内联路径合法性校验拒绝空/`.`/`..`/含`/`，`FixString()` 截断内部 NUL 防注入）。
- **文件抽象层**：`Fid`（`p9fid.h:14`，纯虚基类，所有 9P 文件操作 `Walk/Clone/GetAttr/SetAttr/Open/Create/Read/Write/ReadDir/.../Clunk`，默认返回 `LX_EINVAL` 唯独 `Clunk()` 返回成功）、`File`（`p9file.h:71`，Linux 具体实现，`m_FileName` 相对路径 + `Root::RootFd` 用 `openat`/`fstatat` 实现 chroot-like 安全）、`Root`/`Share`（`Root` 构造经 `getpwuid_r`+`getgrouplist` 解析附加组）、`XAttr`（扩展属性策略）。
- **派发与连接层**：`Handler`（`p9handler.cpp`，消息派发器 + fid 表 + 连接主循环 + `RequestTracker`/`RequestList` 支持 `Tflush` 取消）、`FileSystem`/`ShareList`（`p9fs.cpp`，服务实现，`MaximumConnectionCount=4096`）、`WaitGroup`（连接计数器 RAII）。
- **异步基础设施**：`Scheduler`（`p9scheduler.h`，C++20 协程调度器，`Schedule`/`Block`/`Unblock`）、`EpollWatcher`/`CoroutineIoIssuer`/`CoroutineEpollIssuer`（`p9io.h`，epoll socket + aio 文件 IO，sigval 回调唤醒协程）、`Socket`/`ThreadPool`（`p9lx.h`，`ISocket` 平台适配）。

之所以用 C++20 协程 + 单线程调度器 + epoll/aio 而非 thread-per-connection：4096 最大连接数下线程开销过大；协程让 `HandleRead` 遇 `EWOULDBLOCK` 挂起、epoll 事件唤醒重试，单线程承载高并发。

## 调用链路

以一个 `Tread` 请求为例，从连接 accept 到 R-message 返回：

链路关键节点：`init.cpp:211`（`argv[0]=="plan9"` → `StartPlan9`）→ `StartPlan9Server`（`plan9.cpp:219`，WSL2 `UtilBindVsockAnyPort`+`setsockopt(65536)`，WSL1 `CreateUnixServerSocket`，`socketpair` 建 control channel，`UtilCreateChildProcess` fork+execv init --plan9，`read(pipe)` 等子进程就绪）→ `RunPlan9Server`（`plan9.cpp:174`，`getrlimit` 提高 fd 上限，`open("/",O_PATH)` 取 rootFd，`CreateFileSystem`→`g_Watcher.Run()`+`listen`，`AddShare("",rootFd)`，`Resume`→`HandleConnections`，`pipeFd.reset()` 通知父进程，`RunPlan9ControlFile` 等停止消息）。

`HandleConnections`（`p9handler.cpp:1423`）循环 `co_await listen.AcceptAsync`（检查连接数<4096）→ 每 `Handler` 跑 `Run`（`:1312`）。`Run` 循环 `co_await NextMessage`（`FillData(4)` 读 size → `RecvAsync` epoll 驱动 → 读完整消息 → 校验 size 7~`m_NegotiatedSize`）→ `RequestTracker` 注册 tag → `messageSemaphore.Acquire(1)`（限流 32 并发）→ `ProcessMessage`（`:1215`，`SpanReader` 解码 `messageType`+`tag` → `HandleMessage` `:181` dispatch）→ `SendAsync` 回写响应。`HandleMessage` 是 dispatch table：async 消息（`Tread`/`Twrite`/`Tflush`）用 `co_await`，blocking 消息包进 `BlockingCode([&]{switch(...)})`。

`HandleRead`（`:624`）解码 `fid`/`offset`/`count` → `LookupFid`（`:1374`，`shared_lock(m_FidsLock)` 查 `m_Fids` map）→ `response.EnsureSize` 预分配 → `co_await file->Read(offset,buffer)` → `File::Read`（`p9file.cpp:648`）→ `CoroutineIoIssuer::Issue` `aio_read` → 填 `response.Writer` → `Header(messageType+1,tag)` 回填头。其他消息同构：`Twalk`→`HandleWalk`→`Fid::Clone`+`File::Walk`+挂载点检测；`Tlopen`→`HandleLOpen`→`Fid::Open`+`openat(O_NOFOLLOW)`；`Tclunk`→`HandleClunk`→`m_Fids.erase`+`Clunk()`；`Twopen`→`HandleWOpen` 合并 walk+open+create+mkdir+readlink+getattr 六步。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `StartPlan9Server` `plan9.cpp:219` | 启动 plan9 服务（建 socket+fork+execv） | pipe 同步就绪，control socketpair 级联终止 |
| `RunPlan9Server` `plan9.cpp:174` | 子进程入口，建 FileSystem+AddShare+Resume | getrlimit 提高 fd 上限 |
| `HandleConnections` `p9handler.cpp:1423` | accept 循环，限 4096 连接 | 每连接一个 Handler |
| `Handler::Run` `:1312` | 消息循环，NextMessage→ProcessMessage | messageSemaphore 限流 32 |
| `Handler::HandleMessage` `:181` | dispatch table 派发 30+ 消息 | async co_await vs blocking BlockingCode |
| `Handler::LookupFid` `:1374` | fid→Fid 查表 | shared_lock shared_mutex |
| `File::Read/Write` `p9file.cpp` | aio 文件 IO | CoroutineIoIssuer sigval 回调唤醒 |
| `File::Walk` `p9file.cpp:197` | 路径导航+挂载点检测 | st_dev 变化查 mountinfo 防 drvfs 嵌套 |
| `ShareList::MakeRoot` `p9fs.cpp:74` | uid/gid 映射+附加组解析 | getpwuid_r+getgrouplist |

</details>

## 核心实现

### 编译进 init（静态库而非独立二进制）

plan9 server 经 `execv(LX_INIT_PATH, ["init","--plan9",...])` 作为 `init` 子命令启动，复用同一 `/init` 二进制。`libplan9`（`CMakeLists.txt:40` `add_linux_library`）作为静态库链接进 `init`。设计收益：减少攻击面（不引入新 setuid 二进制，plan9 需 root 跑 `setresuid`，作为 init 子命令继承 root 权限无需额外配置）；简化部署（一个 `/init` 覆盖所有功能，WSL mini rootfs 空间有限）；共享初始化代码（`InitializeLogging`/异常处理/路径翻译）；进程隔离（`execv` 创独立进程，plan9 崩溃不影响 init PID 1，pipe 同步就绪）；control channel（`socketpair` 建父子通道，父发 `LX_INIT_STOP_PLAN9_SERVER` 控生命周期，control socket 关闭子进程 `_exit(0)` 级联终止）。代价是 `init` 二进制更大，可接受。

### 9P 协议选择与 9P2000.W 扩展

选 9P 而非 FUSE/SMB：FUSE 需 Linux 内核模块（WSL1 是翻译层无真正内核，用不了）；9P 纯用户态协议，Windows 已有 `p9rdr.sys` 内核态重定向驱动；drvfs 用 Linux 9p 内核客户端（`mount -t 9p`）比 FUSE 高效（原生内核实现，不需用户态守护）。SMB 复杂度高（认证/Session/Tree connect 开销）、不原生支持 Unix 语义（uid/gid/symlink/xattr/设备文件需 Unix Extensions，支持不完整）；9P2000.L 直接映射 `stat/openat/mkdirat/symlinkat/...` syscall 无需语义转换，有状态 fid 模型比 SMB 无状态模型开销低。

9P2000.W 是 Windows 专有扩展（`p9defs.h:82` 注释 "unofficial extension for improved functionality and performance"）：`Twopen`（`p9handler.cpp:867`）合并 walk+open+create+mkdir+readlink+getattr 六步为一次协议往返——Windows `CreateFileW` 同步语义需 3 次 RTT（标准 9P2000.L 的 Twalk→Tlopen→Tgetattr），`Twopen` 只 1 次；`Twreaddir` 在目录项内联属性（`includeAttributes`，`:579`）免每项 `Tgetattr`——Windows `FindFirstFile`/`FindNextFile` 需目录项+属性；`Taccess`（`:836`）支持 Windows `access()` 语义含 `Delete` 模式。协议协商在 `HandleVersion`（`:297`），优先 `9P2000.W`，`m_Use9P2000W` 控后续专有消息，msize 协商 4096~256KB。

### WSL1 unix socket vs WSL2 hvsocket 双传输

`StartPlan9Server`（`plan9.cpp:227`）按 `UtilIsUtilityVm()` 分流：WSL2（VM mode）`UtilBindVsockAnyPort` 绑定 vsock + `setsockopt(SO_SNDBUF/SO_RCVBUF, 65536)`（跨 VM 延迟高，大缓冲提吞吐），返回端口号，不需 socketPath（vsock 按端口号寻址）；WSL1（翻译层）`TranslatePath` Windows 路径→Linux + `CreateUnixServerSocket`（`AF_UNIX`，同内核最高效，处理超长路径 split 父子 + chdir + `unlink` 旧文件）。`drvfs.cpp:440` 还可选 virtio 9p（`trans=virtio`，msize 262144，`HandlerFactory::CreateHandler` `m_AllowRenegotiate=true` 因 virtio 无法检测 disconnect 允许多次 Tversion）。统一靠 `ISocket`（`p9platform.h:9`）抽象 `AcceptAsync`/`RecvAsync`/`SendAsync`，WSL1 `AF_UNIX` 与 WSL2 `AF_VSOCK` 都由 `Socket`（`p9lx.h:9`）实现、`CoroutineEpollIssuer`+epoll 统一驱动，传输切换对消息处理层透明。

### fid 生命周期、uid/gid 切换、安全与性能

fid 是 9P 有状态协议的核心（会话级文件句柄）：`Tattach` 创根 fid（`CreateFile`），`Twalk` `Clone()` 创新 fid 导航路径，`Tclunk` 显式释放（服务器知客户端何时不再需某文件）。`m_Fids` 用 `shared_ptr<Fid>` + `shared_mutex` 保护，`EmplaceFid` 用 `try_emplace` 防重复。`XAttr` 运行时替换 `File` fid（`HandleXattrCreate` `:811`，策略动态切换）。

uid/gid 映射（`p9util.cpp:224` `FsUserContext`）：plan9 server 以 root 跑但代表不同用户操作文件，构造时 `sys_setresuid`/`sys_setresgid`/`sys_setgroups` 切线程有效 uid/gid，析构恢复 root。用 syscall 而非 glibc wrapper（wrapper 改所有线程 uid，`SYS_setresuid` 只改当前线程）。`MakeRoot`（`p9fs.cpp:74`）处理 uid==euid 不切换 / root 下 `getpwuid_r` 查 gid（查不到用 nobody 组）/ 非 root 返回 `LX_EPERM`。

安全：所有文件操作加 `O_NOFOLLOW`/`AT_SYMLINK_NOFOLLOW` 防 symlink 攻击；`Walk`（`p9file.cpp:243`）`st_dev` 变化查 `/proc/<tid>/mountinfo`，遇 drvfs/9p/virtiofs 挂载返回 `LX_EACCES` 防嵌套挂载无限递归。性能：`LX_INIT_UTILITY_VM_PLAN9_BUFFER_SIZE=65536`（`lxinitshared.h:128`）`setsockopt` 增大 hvsocket 缓冲 + 9P `msize=65536`；`Handler::m_RequestBuffer` 预分配 256KB（`MaximumRequestBufferSize`）避免运行时分配，限制协商 msize 不超 256KB（`:1199`）；virtio 路径用更大 262144。

## 设计模式

| 模式 | 位置（文件:方法） | 为什么用 |
| --- | --- | --- |
| Dispatch Table/Strategy | `Handler::HandleMessage` `p9handler.cpp:181` | `switch(messageType)` 映射消息→handler，新增只加 case |
| Strategy（Fid 多态） | `Fid` `p9fid.h:14`→`File`/`XAttr` | Handler 只持 `shared_ptr<Fid>`，运行时可替换策略 |
| RAII | `RequestTracker`/`WaitGroup::Add`/`FsUserContext`/`MessageResponse` | 构造插入/析构移除+通知，uid 切换自动恢复 |
| Serializer | `SpanReader`/`SpanWriter` `p9protohelpers.h` | 类型安全编解码，`Header()` 后填支持先 payload 后补头 |
| Reactor/Proactor+协程 | `Scheduler`+`EpollWatcher`+`CoroutineIoIssuer`/`CoroutineEpollIssuer` `p9io.h`/`p9scheduler.h` | epoll+aio 唤醒协程，单线程高并发 |
| 工厂 | `CreateFileSystem`/`CreateFile`/`HandlerFactory::CreateHandler`/`CreateWorkItem` | 创建各组件实例 |
| 接口隔离 | `IPlan9FileSystem`/`ISocket`/`IWorkItem`/`IHandler`/`IRoot`/`IShareList` `p9fs.h`/`p9platform.h`/`p9ihandler.h` | virtio 使用者不需协程头文件 |
| Template-Only | `SpanReader`/`SpanWriter`/`GetMessageSize`/`LinkedList<T>` | header-only 内联，`GetMessageSize` constexpr 编译期求值 |

## 模块间交互

- **启动路径**：`init.cpp:211`（`argv[0]=="plan9"`→`StartPlan9`）；`plan9.cpp:219` `StartPlan9Server`（由 init 主进程在初始化阶段调，`UtilIsUtilityVm()` 分流 WSL1/WSL2 传输，`socketpair` 建 control，fork+execv init --plan9，pipe 同步就绪）。
- **与 Windows 侧**：WSL2 正向访问 `p9rdr.sys`→`wslservice.exe` COM 桥接获取 hvsocket fd→9P over AF_VSOCK（`WSLCVirtualMachine.cpp:1146-1154` mount options `msize=65536,trans=fd,rfdno=...,wfdno=...,aname=...,cache=mmap`）；WSL1 正向访问 `p9rdr.sys`/`wslservice.exe`→9P over AF_UNIX（`CreateUnixServerSocket`）。`p9rdr.sys` 不直连 vsock，经 `wslservice.exe` COM 桥接。
- **与 drvfs**：`drvfs.cpp` 是消费者（不是 plan9 模块），`UtilConnectVsock(LX_INIT_UTILITY_VM_PLAN9_DRVFS_PORT)` 连 plan9 server 的 drvfs 端口→`mount -t 9p trans=fd`（Linux 9p 内核客户端挂载）。drvfs（Linux 访问 Windows 文件 `/mnt/c`）与 p9rdr（Windows 访问 Linux 文件 `\\wsl.localhost`）复用同一 plan9 server，靠不同 vsock 端口区分（`PLAN9_PORT` Windows 直连、`PLAN9_DRVFS_PORT`/`PLAN9_DRVFS_ADMIN_PORT` drvfs）。
- **control channel**：`socketpair(PF_LOCAL)` 建父子通道，父发 `LX_INIT_STOP_PLAN9_SERVER` 控生命周期（`Force=false` 时 `HasConnections()` 检查优雅关闭，`:154`）。

## 扩展方式

### 新增一个 9P 消息类型（如 `Ttruncate`）

1. `p9defs.h`：`MessageType` enum 加 `Ttruncate=134, Rtruncate`。
2. `p9data.h`：`GetMessageSize` switch 加 case（wire size = HeaderSize+sizeof(fid)+sizeof(size)）。
3. `p9fid.h`：`Fid` 加 `virtual LX_INT Truncate(UINT64 Size);` 默认 `LX_ENOTSUP`。
4. `p9fid.cpp`：实现默认。
5. `p9file.h`/`p9file.cpp`：`File` override `Truncate`，调 `ftruncate(m_File.get(), Size)`。
6. `p9handler.cpp`：`HandleMessage` blocking switch 加 `case Ttruncate: return HandleTruncate(reader);`，实现 `HandleTruncate` 读 fid+size 调 `file->Truncate`。

### 修改 fid 超时回收策略（当前只在 `Tclunk` 释放）

1. `p9handler.cpp` `Handler` 加定时器（基于 `AsyncEvent`+`co_await` 超时）。
2. `EmplaceFid`（`:1392`）插入记时间戳。
3. 新增 `ReapExpiredFids`：遍历 `m_Fids` 超时 fid `Clunk()`+erase。
4. `Handler::Run` 空闲时调；处理 `m_FidsLock` 与 `Tclunk` 的并发竞争。

### 新增一种文件属性（如 `btime`，当前 `GetAttr` 始终返回 0）

1. `p9defs.h`：已有 `GetAttrBtime=0x800` bitmask。
2. `p9file.cpp` `File::GetAttr`（`:268`）加 `if (WI_IsFlagSet(mask, GetAttrBtime))` 分支，从 `statx` 读 `st_btim`（需 Linux 4.18+）。
3. `p9commonutil.h`：`StatResult` 加 `BtimeSec`/`BtimeNsec` 字段。
4. `p9handler.cpp` `HandleGetAttr`（`:397`）替换 `response.Writer.U64(0)` 为实际值；`HandleWOpen`/`WriteWOpenReply` 同步（`:1111`）。
