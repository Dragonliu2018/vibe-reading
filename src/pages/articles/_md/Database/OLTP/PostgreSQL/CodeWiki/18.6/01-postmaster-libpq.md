---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "进程与连接架构"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "postmaster", "libpq", "多进程", "进程模型"]
description: "PostgreSQL per-process 多进程架构——postmaster 主循环、fork backend、辅助进程 X-macro 分发、PMState 状态机、崩溃恢复、libpq 前后端协议与认证"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`postmaster/` 和 `libpq/` 构成 PostgreSQL 的最外层——服务端进程模型与通信协议。postmaster 是整个数据库服务的主进程：监听客户端连接、fork 出独立的 backend 子进程处理每个会话、管理后台辅助进程（bgwriter/checkpointer/walwriter/autovacuum 等）、在崩溃后重建共享内存并触发恢复。libpq 则是服务端的协议层，实现 PostgreSQL 前后端协议的 socket 收发、SSL/TLS 协商、认证流程。

这一层独立存在，是因为它隔离了「OS 进程模型」与「查询处理逻辑」——`tcop` 的 `PostgresMain` 只需假设自己运行在一个已认证的 backend 进程里，不关心连接是怎么 accept 出来的、fork 是怎么做的。这种隔离让 per-process 模型（而非线程模型）成为 PostgreSQL 崩溃恢复可靠性的根基：一个 backend crash 不会 corrupt 其他 backend 的内存，postmaster 重建共享内存即可恢复。

---

## 模块架构

postmaster 内部由三块组成：**主循环与连接管理**（`ServerLoop`/`BackendStartup`）、**辅助进程管理**（`LaunchMissingBackgroundProcesses`/`StartChildProcess` + X-macro dispatch）、**生命周期状态机**（`PMState` + `HandleChildCrash`）。libpq 由**通信原语**（`pqcomm.c` 收发缓冲 + VTable）、**认证**（`auth.c`）、**SSL 抽象**（`be-secure*.c`）组成。

核心组件协作：`ServerLoop` 基于 `WaitEventSet` 等待连接/信号；新连接到达时 `AcceptConnection` → `BackendStartup` → `postmaster_child_launch`（X-macro 按 `BackendType` 找到 `BackendMain`）→ `fork_process`（Unix fork）→ 子进程 `BackendInitialize`（libpq 初始化 + 认证）→ `PostgresMain` 进入查询循环。辅助进程走相同 fork 路径，只是 `child_process_kinds[type].main_fn` 指向各自的 Main（如 `BackgroundWriterMain`）。

---

## 调用链路

从客户端 TCP 连接到 backend 进入查询循环的完整路径：

```
客户端 connect()
  │
[postmaster.c:1653] ServerLoop()  ── WaitEventSetWait() 检测 WL_SOCKET_ACCEPT
  │
[pqcomm.c:794] AcceptConnection()  ── accept() 填充 ClientSocket
  │
[postmaster.c:3518] BackendStartup()  ── canAcceptConnections 检查 + AssignPostmasterChildSlot
  │
[launch_backend.c:229] postmaster_child_launch(B_BACKEND,...)
  │
[fork_process.c:32] fork_process()  ── Unix fork()
  └── 子进程:
      [launch_backend.c:268] child_process_kinds[B_BACKEND].main_fn() = BackendMain()
        │
[tcop/backend_startup.c:76] BackendMain()
  ├── [backend_startup.c:141] BackendInitialize()  ── pq_init + SSL + startup packet
  ├── [backend_startup.c:116] InitProcess()  ── 共享内存 PGPROC
  └── [tcop/postgres.c:4188] PostgresMain(dbname, username)  ── 查询主循环
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `PostmasterMain` | postmaster 启动序列 | 注册信号 + 创建监听 + 分配共享内存 |
| `ServerLoop` | 主事件循环 | WaitEventSet 而非 select，可中断 |
| `BackendStartup` | fork backend | postmaster 不保留 client socket，子进程独占 |
| `fork_process` | Unix fork 封装 | fork 前屏蔽信号，避免竞态 |
| `BackendInitialize` | 连接 pre-auth 初始化 | SSL 探测（peek 0x16）+ startup packet 解析 |
| `ClientAuthentication` | 认证分发 | pg_hba.conf 方法 switch |
| `PostgresMain` | backend 查询循环 | sigsetjmp 做最外层错误恢复 |

---

## 核心实现

### PostmasterMain 启动序列

`PostmasterMain`（`postmaster.c:494`）是服务器主入口，启动序列严格有序：注册信号处理器 → 解析 GUC → `ListenServerPort` 创建 TCP/Unix socket → `load_hba`/`load_ident` 加载认证配置 → `InitPostmasterDeathWatchHandle`（`postmaster.c:4560`）创建父死检测 pipe → `StartChildProcess(B_CHECKPOINTER/B_BG_WRITER/B_STARTUP)` fork 辅助进程 → 进入 `ServerLoop`。

```c
// src/backend/postmaster/postmaster.c:494
pg_noreturn void PostmasterMain(int argc, char *argv[]);
```

父死检测 pipe 是关键设计：postmaster 持写端（`POSTMASTER_FD_OWN`），子进程持读端（`POSTMASTER_FD_WATCH`）并加入 `FeBeWaitSet`。postmaster crash → pipe EOF → 子进程 `read()==0` 即退出，避免 orphan backend。比 `prctl(PR_SET_PDEATHSIG)` 更可移植。

### ServerLoop 主循环

`ServerLoop`（`postmaster.c:1653`）基于 `WaitEventSet`，而非手写 `select()`。正常运行时 `ConfigurePostmasterWaitSet(true)` 注册所有 listen socket 为 `WL_SOCKET_ACCEPT` + 一个 latch；shutdown 时 `ConfigurePostmasterWaitSet(false)` 取消 socket 注册以停止接受新连接。

```c
// src/backend/postmaster/postmaster.c:1653
static int ServerLoop(void)
// 核心结构（简化）:
// for (;;) {
//   nevents = WaitEventSetWait(pm_wait_set, DetermineSleepTime(), events, ...);
//   处理信号: shutdown/reload/child_exit/pmsignal（延迟处理，避免 reentrancy）
//   WL_SOCKET_ACCEPT → AcceptConnection → BackendStartup
//   LaunchMissingBackgroundProcesses()
// }
```

信号延迟处理：信号处理器只设 `sig_atomic_t` 标志 + `SetLatch()`，实际工作在 `ServerLoop` 处理（`postmaster.c:1715-1722`）。这避免在信号上下文调用非 async-signal-safe 函数。`DetermineSleepTime`（`postmaster.c:1551`）扫描 crashed bgworker 找最小重启时间，确保不错过重启窗口。

### Fork 与进程类型分发

`postmaster_child_launch`（`launch_backend.c:229`）用 X-macro 表驱动分发所有子进程类型。`proctypelist.h` 单点声明每个 `BackendType` → Main 函数映射，多处（dispatch table、名称、mask）自动同步：

```c
// src/include/postmaster/proctypelist.h
PG_PROCTYPE(B_BACKEND,        "backend",    ..., BackendMain,           true)
PG_PROCTYPE(B_BG_WRITER,      "bgwriter",   ..., BackgroundWriterMain,  true)
PG_PROCTYPE(B_CHECKPOINTER,   "checkpointer",..., CheckpointerMain,    true)
PG_PROCTYPE(B_WAL_WRITER,     "walwriter",  ..., WalWriterMain,         true)
PG_PROCTYPE(B_STARTUP,        "startup",    ..., StartupProcessMain,    true)
PG_PROCTYPE(B_AUTOVAC_LAUNCHER,"autovacuum",..., AutoVacLauncherMain,   true)
// ... 共 ~15 种
```

`fork_process`（`fork_process.c:32`）在 fork 前 `sigprocmask` 屏蔽所有信号，子进程安装自己的处理器后再解除——避免 fork 后子进程继承 postmaster 信号处理器导致的竞态。子进程调 `ClosePostmasterPorts` 关闭 listen socket 和 death pipe 写端，再 `InitPostmasterChild` 设信号/latch，然后进入 `child_process_kinds[type].main_fn`（永不返回）。

### 辅助进程

辅助进程共享 `AuxiliaryProcessMainCommon`（`auxprocess.c`）初始化：删 PostmasterContext → `InitAuxiliaryProcess` → `BaseInit` → 创建 AuxProcessResourceOwner。各进程职责：

| 进程 | Main 函数 | 职责 |
| --- | --- | --- |
| bgwriter | `BackgroundWriterMain` | 异步刷脏页，减轻 backend 写压力 |
| checkpointer | `CheckpointerMain` | 周期 checkpoint，刷所有脏页+WAL |
| walwriter | `WalWriterMain` | 异步写 WAL buffer，确保不积压 |
| startup | `StartupProcessMain` | 崩溃恢复 redo WAL |
| autovac launcher | `AutoVacLauncherMain` | 周期扫描系统表调度 vacuum |
| archiver | `PgArchiverMain` | 归档完成 WAL segment |
| walreceiver | `WalReceiverMain` | standby 接收 WAL |

`LaunchMissingBackgroundProcesses`（`postmaster.c:3267`）在 ServerLoop 每次迭代按 `pmState` 决定启动哪些进程——bgwriter/checkpointer 在 `PM_RUN`/`PM_HOT_STANDBY` 运行，walreceiver 仅在 recovery。`maybe_start_bgworkers`（`postmaster.c:4213`）每循环最多启 100 个 custom bgworker，防 postmaster 耗在启动上。

### PMState 状态机

`PMState`（`postmaster.c:336`，13 个状态）管理服务端生命周期。`PostmasterStateMachine`（`postmaster.c:2865`）在每次 child exit/signal 后推进。正常 shutdown：`PM_RUN → PM_STOP_BACKENDS → PM_WAIT_BACKENDS → PM_WAIT_XLOG_SHUTDOWN → PM_WAIT_XLOG_ARCHIVAL → PM_WAIT_CHECKPOINTER → PM_WAIT_DEAD_END → PM_NO_CHILDREN → exit`。

### 崩溃恢复

`HandleChildCrash`（`postmaster.c:2772`）→ `HandleFatalError` → `TerminateChildren(SIGQUIT/SIGABRT)` → 状态切 `PM_WAIT_BACKENDS`。所有子进程退出后（`PM_NO_CHILDREN` + `FatalError` + `restart_after_crash`），`shmem_exit(1)` 销毁旧共享内存 → `ResetShmemAllocator` → `CreateSharedMemoryAndSemaphores` 重建 → `StartChildProcess(B_STARTUP)` 重启 recovery。

关键决策：**不尝试在原进程内恢复**（`postmaster.c:3197` 注释——PG 8.3 前试过，SIGTERM 时序不可靠）。`SIGKILL_CHILDREN_AFTER_SECS`（值 5，`postmaster.c:1784`）超时后升级 SIGKILL。**不同进程类型对退出码容忍度不同**：bgwriter/checkpointer/walwriter/autovac launcher 视 exit 1 为 crash；walreceiver/archiver/slotsync worker 接受 exit 1 为非 crash（合法 FATAL 退出）。

### libpq 协议原语

`pqcomm.c` 实现收发缓冲：send buffer 动态分配（初始 8KB，可 `socket_putmessage_noblock` 扩大），recv buffer 固定 8KB。通过 `PQcommMethods` VTable 间接（`pqcomm.c:153`），允许替换为共享内存 IPC（`pqmq.c` 用于 parallel worker 间）。

```c
// src/backend/libpq/pqcomm.c
int pq_getbyte(void);                 // 读消息类型字节
int pq_getmessage(StringInfo s, int maxlen);  // 读完整消息（4字节长度前缀+body）
static int socket_putmessage(char msgtype, const char *s, size_t len);  // 发消息
```

`pq_init`（`pqcomm.c:174`）设 socket 为 nonblocking + `TCP_NODELAY`/`SO_KEEPALIVE`，创建 `FeBeWaitSet`（socket write + latch + postmaster death）。nonblocking socket + Latch 实现可中断阻塞 I/O——backend 等 I/O 时能被 `SIGINT`（取消查询）唤醒。

### 认证流程

`ClientAuthentication`（`auth.c:379`）在 `InitPostgres`→`PerformAuthentication`（`postinit.c:194`）中调用，在 `PostgresMain` 主循环之前。流程：`hba_getauthmethod` 从 pg_hba.conf 取方法 → switch 分发：`uaTrust`（直接通过）、`uaPassword`（`CheckPasswordAuth` 明文）、`uaSCRAM`（`CheckPWChallengeAuth` SCRAM-SHA-256）、`uaPeer`（OS peer credential）、`uaGSS`/`uaSSPI`/`uaLDAP`/`uaOAuth` 等。成功 `sendAuthRequest(AUTH_REQ_OK)`，失败 `auth_failed` FATAL。

SSL 协商两条路径：**Direct SSL**（PG 18+）`ProcessSSLStartup` peek 0x16 直接 TLS 握手；**传统 SSLRequest** `ProcessStartupPacket` 检测 `NEGOTIATE_SSL_CODE` 回复 'S'/'N' 后 `secure_open_server`。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| X-macro | `proctypelist.h` | 进程类型单点声明，dispatch/命名/mask 多处同步，新增进程只改一处 |
| 信号延迟处理 | `ServerLoop` 的 `pending_pm_*` 标志 | 避免信号上下文 reentrancy，所有实际工作在主循环做 |
| 父死检测 pipe | `postmaster_alive_fds` | 比 `prctl(PR_SET_PDEATHSIG)` 可移植，跨 Unix 平台一致 |
| VTable 间接 | `PQcommMethods` | libpq 协议层可替换为共享内存 IPC（parallel worker） |
| Cancel key | `MyCancelKey` 随机数 | per-process 模型无法线程间传 cancel，用 (PID,key) 验证后发 SIGINT |

---

## 模块间交互

postmaster/libpq 是最外层，向内调用 `tcop`（`BackendMain`→`PostgresMain`）、`storage/ipc`（`CreateSharedMemoryAndSemaphores`）、`storage/proc`（`InitProcess` PGPROC）、`utils/init`（`InitPostgres` 认证）。被 OS 直接调用（`main.c` dispatch）。辅助进程中 `walreceiver`/`walsender` 进一步依赖 `replication/`。

---

## 扩展方式

**新增辅助进程**：`miscadmin.h` 的 `BackendType` 加 enum → `proctypelist.h` 加 `PG_PROCTYPE` → 新建 `postmaster/xxx.c`（调 `AuxiliaryProcessMainCommon`）→ `LaunchMissingBackgroundProcesses` 加启动逻辑 → `process_pm_child_exit` 加退出处理。X-macro 保证 dispatch/命名自动同步。

**修改认证方式**：`hba.h` 的 `UserAuth` enum 加类型 → `hba.c parse_hba_auth_type` 加映射 → `auth.c ClientAuthentication` switch 加 case + 实现 `CheckXxxAuth` → `protocol.h` 加 `AUTH_REQ_XXX` 常量。
