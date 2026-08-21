---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "Overview"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "C", "OLTP", "MVCC", "WAL", "关系数据库"]
description: "PostgreSQL 18.6 源码架构解读——世界级开源关系数据库，per-process 架构、四阶段查询流水线、WAL+MVCC 事务引擎、可插拔访问方法全解"
readingTime: "60 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 18.6 · **协议** PostgreSQL License · **语言** C · **代码量** ~1.6M 行 · **仓库** [GitHub](https://github.com/postgres/postgres)

---

## 总览

### 项目简介

PostgreSQL 是世界上最先进的开源关系数据库系统。它起源于 1986 年 UC Berkeley 的 POSTGRES 项目，历经 40 年演进，现由 PostgreSQL Global Development Group 维护。本次解读基线为正式 release tag `REL_18_6`（PG 18 稳定版，2026-08-11）。

PostgreSQL 解决的核心技术问题是：在保证 ACID 事务语义的前提下，提供高并发、高可靠、可扩展的 SQL 数据存储与查询。它的核心价值在于**可扩展性**——通过可插拔的访问方法（AM）、扩展（extension）、背景工作进程（bgworker）机制，第三方无需修改内核即可扩展存储引擎、索引类型、过程语言。核心使用场景覆盖 OLTP 事务系统、HTAP 混合负载、以及作为 TimescaleDB、Citus、Cloudberry 等众多数据库产品的底座。

**项目边界**：PostgreSQL 是单机/共享磁盘架构的 OLTP 数据库内核，**不负责**分布式分片（由 Citus 等扩展承担）、不负责连接池化（由 PgBouncer 承担）、不负责列存加速（由扩展或 FDW 承担）。主备复制是物理/逻辑流复制，不是无共享分布式共识。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| SQL 解析 | `src/backend/parser/` | flex/bison 两阶段：raw parse + semantic analysis |
| 查询重写 | `src/backend/rewrite/` | 规则系统（CREATE RULE）、视图展开 |
| 代价优化器 | `src/backend/optimizer/` | Path/Plan 两阶段、DP+GEQO 连接枚举 |
| 迭代器执行器 | `src/backend/executor/` | Volcano pull 模型，40+ 节点类型 |
| MVCC 并发控制 | `src/backend/access/transam/` | 多版本快照隔离，读不阻塞写 |
| WAL 预写日志 | `src/backend/access/transam/xlog.c` | 崩溃恢复 + 复制基础 |
| 共享缓冲池 | `src/backend/storage/buffer/` | clock sweep 淘汰，128 分区哈希 |
| 表/索引 AM | `src/backend/access/heap/`、`nbtree/` 等 | 可插拔存储引擎抽象 |
| 流复制 | `src/backend/replication/` | 物理流复制 + 逻辑解码 |
| 多进程架构 | `src/backend/postmaster/` | per-connection backend + auxiliary 进程 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C（C99） | 核心 | 主实现语言，~1.6M 行 |
| flex / bison | 构建 | 词法/语法生成器（scan.l / gram.y） |
| autoconf / meson | 构建 | configure.ac 双构建系统 |
| LLVM | 可选 | JIT 表达式编译（src/backend/jit/） |
| OpenSSL / GSSAPI | 可选 | SSL/TLS 传输加密、认证 |

### 版本历史

PostgreSQL 采用年度大版本发布。本次解读基于 PG 18.6（REL_18_6 tag）。近年关键架构演进：PG 12 引入可插拔 table AM（`TableAmRoutine`）；PG 14 增量备份与 wal summarizer；PG 16 并行查询改进；PG 18 拆分 `backend_startup.c`、新增 `B_IO_WORKER` 进程类型、Direct SSL 支持。

---

## 快速上手

```bash
# 从源码构建（最简）
cd /Users/ace/code/database/postgres
./configure --prefix=/tmp/pg && make -j8 && make install

# 初始化数据目录并启动
/tmp/pg/bin/initdb -D /tmp/pgdata
/tmp/pg/bin/pg_ctl -D /tmp/pgdata -l /tmp/pg.log start

# 端到端验证
/tmp/pg/bin/psql -p 5432 -c "SELECT name FROM pg_settings WHERE name='version';"
#              version
# ---------------------------------------
#  PostgreSQL 20devel ... (18.6)
```

> 内部调用链（main → ServerLoop → fork backend → PostgresMain）见「运行时行为 > 启动流程」。

---

## 架构设计解析

### 系统架构

PostgreSQL 的整体架构思想是**分层流水线 + 多进程隔离**。一条 SQL 从客户端到达，要穿过 7 个子系统：libpq（通信）→ tcop（调度）→ parser（解析）→ rewrite（重写）→ optimizer（规划）→ executor（执行）→ access/storage（存储）。每个子系统职责单一、边界清晰，前一阶段的输出就是后一阶段的输入——经典的编译器 pipeline 模型，但落到数据库语境下，输入是 SQL 文本、输出是元组流。

这种分层解决的核心问题是**复杂度隔离**：SQL 语义极其复杂（DDL/DML/DCL/TCL、子查询、CTE、窗口函数、JSON、属性图……），若解析、优化、执行耦合在一起，任何改动都会牵一发动全身。分层后，`gram.y` 的语法扩展不影响执行器，执行器的节点新增不影响解析器。层间通过明确的节点数据结构（`RawStmt` → `Query` → `PlannedStmt` → `Plan`）传递，每层有独立的设计与测试空间。

纵向看，PostgreSQL 分为五层：

![PostgreSQL 分层架构](/vibe-reading/images/articles/postgres-internals/architecture.svg)

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 通信与进程层 | `postmaster/`、`libpq/` | 监听连接、fork backend、协议收发——隔离 OS 进程模型，保护核心不受连接细节影响 |
| 调度层 | `tcop/` | 查询生命周期编排，串联解析→重写→规划→执行——单点协调，避免各阶段互相直接耦合 |
| 编译层 | `parser/`、`rewrite/`、`optimizer/` | 把 SQL 文本翻译成执行计划——纯逻辑变换，无 I/O 副作用，可缓存复用 |
| 执行层 | `executor/` | Volcano 迭代器执行计划树——拉取式流水线，自然背压 |
| 存储与事务层 | `access/`、`storage/`、`replication/` | 缓冲池、AM、WAL、MVCC、复制——ACID 基石，向上屏蔽物理存储细节 |

层间依赖单向向下：上层调用下层接口，下层不知上层存在。`tcop` 是唯一同时知道 parser/rewrite/optimizer/executor 的模块，是「指挥交通」的枢纽。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略模式（Strategy） | `access/` 的 AM 函数指针表 `TableAmRoutine`/`IndexAmRoutine` | 存储引擎可插拔，executor 经 wrapper 间接调用，零编译开销 |
| 模板方法（Template Method） | `executor/` 每节点的 Init/Exec/ReScan/End 四方法 | 统一节点生命周期，`ExecProcNode` 按函数指针分发 |
| 钩子模式（Hook） | `planner_hook`、`ExecutorStart_hook`、`ProcessUtility_hook` | 第三方扩展（pg_stat_statements 等）注入逻辑不改内核 |
| X-macro | `postmaster/proctypelist.h` | 进程类型表单点声明，dispatch/命名/mask 多处自动同步 |
| 两阶段探索 | optimizer 的 Path→Plan | 轻量探索大量路径，仅最优路径转重量级 Plan |
| 规则系统 | `rewrite/` 的 `QueryRewrite` | 声明式视图/规则，在编译期改写查询 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Query` | 分析后的语义查询树 | 单次解析 | 含 `RangeTblEntry`/`TargetEntry` |
| `PlannedStmt` | 规划后的执行计划容器 | 单次执行 | 含 `Plan` 树 + `rtable` |
| `Plan`/`PlanState` | 执行计划节点 / 运行时状态 | 查询执行期 | 树形父子关系 |
| `Portal` | ready-to-run 执行容器 | 从 Bind 到 Drop | 持有 `PlannedStmt` + 参数 |
| `EState` | 执行期全局状态 | 单次 ExecutorStart | 共享于所有 PlanState |
| `HeapTuple` | 堆表元组 | 行级 | 含 `xmin`/`xmax` 事务标记 |
| `BufferDesc` | 缓冲页描述符 | 池化 | 按 `BufferTag` 索引 |
| `ReplicationSlot` | 复制槽 | 持久 | 管理 WAL 保留 + vacuum horizon |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `TableAmRoutine` | `access/tableam.h` | `heapam_methods`（heap） | `pg_am` catalog + `default_table_access_method` GUC |
| `IndexAmRoutine` | `access/amapi.h` | btree/gin/gist/brin/hash/spgist | `pg_am` catalog，`amhandler` 返回 routine |
| `f_smgr` | `storage/smgr/smgr.c` | `md.c`（magnetic disk） | `smgrsw[]` 数组，`smgr_which` 选择 |
| `DestReceiver` | `tcop/dest.c` | Frontend/IntoRel/Spi 等 | `CreateDestReceiver` 按 commandType 选择 |

---

## 代码目录

```
postgres/
├── src/
│   ├── backend/              # 服务端内核（~1.17M 行）
│   │   ├── postmaster/       # 主进程、fork、辅助进程、PMState 状态机
│   │   ├── libpq/             # 前后端协议、socket 收发、认证
│   │   ├── tcop/              # Traffic Cop 查询调度中枢
│   │   ├── parser/            # flex/bison 解析器 + 语义分析
│   │   ├── rewrite/           # 规则系统、视图展开
│   │   ├── optimizer/         # 代价优化器（path/plan/geqo/prep/util）
│   │   ├── executor/          # Volcano 迭代器执行器
│   │   ├── access/            # AM + transam（WAL/MVCC/事务）— 最大模块
│   │   ├── storage/           # buffer/smgr/lmgr/ipc
│   │   ├── replication/       # 物理/逻辑复制
│   │   ├── catalog/           # 系统目录
│   │   ├── commands/          # DDL/utility 命令实现
│   │   ├── nodes/             # 节点表示（copy/equal/out/read）
│   │   ├── utils/             # 工具集（内存/GUC/快照/adt）
│   │   ├── main/              # main() 入口与分发
│   │   ├── bootstrap/         # 引导模式（初始化系统目录）
│   │   └── ...
│   ├── bin/                   # 客户端工具（psql/initdb/pg_ctl 等）
│   ├── interfaces/            # libpq 客户端库（C/Python/ODBC）
│   ├── include/               # 头文件
│   ├── common/                # 客户端/服务端共享代码
│   ├── pl/                    # 过程语言（plpgsql/tcl/perl/python）
│   ├── test/                  # 回归测试
│   └── fe_utils/              # 前端工具库
├── contrib/                  # 扩展插件
└── doc/                      # 文档
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/postgres-internals/module-dependencies.svg)

模块间依赖呈严格的单向流水线：`tcop` 是枢纽，下游依次为 parser → rewrite → optimizer → executor → access → storage。`postmaster`/`libpq` 在最外层包裹整个查询路径。`replication` 依赖 access/transam 的 WAL。`catalog`、`utils`、`nodes` 是被广泛依赖的基础设施。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 进程与连接架构 | 多进程模型、连接管理、辅助进程 | `PostmasterMain` | per-process 隔离是 PG 崩溃恢复的根基 | [01-postmaster-libpq](01-postmaster-libpq) |
| 查询调度中枢 | 主循环、四阶段编排、Portal | `PostgresMain` | 唯一同时知道四个编译阶段的模块 | [02-tcop](02-tcop) |
| SQL 解析器 | 文本→语法树→语义树 | `raw_parser`/`parse_analyze` | 事务安全要求解析与目录访问分离 | [03-parser](03-parser) |
| 查询重写 | 规则系统、视图展开 | `QueryRewrite` | 声明式改写查询，planner 之前 | [04-rewrite](04-rewrite) |
| 查询优化器 | 代价估算、路径探索、Plan 生成 | `planner` | NP-hard 连接顺序需专用搜索 | [05-optimizer](05-optimizer) |
| 执行器 | 迭代器执行计划树 | `ExecutorRun` | pull 模型流水线，背压自然 | [06-executor](06-executor) |
| 存储与缓冲管理 | 缓冲池、smgr、锁管理器 | `ReadBuffer` | 多进程共享页缓存，clock sweep 淘汰 | [07-storage](07-storage) |
| 访问方法与事务引擎 | AM 抽象、WAL、MVCC、事务 | `heap_insert`/`XLogInsert` | ACID 基石，PG 最大模块 | [08-access-transam](08-access-transam) |
| 复制 | 物理/逻辑流复制、复制槽 | `WalSndLoop`/`WalReceiverMain` | 高可用基础，独立子系统 | [09-replication](09-replication) |

> 模块间的动态调用顺序见运行时行为 > 核心运行流程。

---

## 运行时行为

### 启动流程

PostgreSQL 进程启动是一次性序列，从 `main()` 到接受连接：

```
main() in src/backend/main/main.c
  ├── startup_hacks() / locale / signal base
  ├── MemoryContextInit()            # 错误与内存管理
  └── dispatch: DISPATCH_POSTMASTER → PostmasterMain()
        │  in src/backend/postmaster/postmaster.c:494
        ├── 注册信号: SIGCHLD/SIGTERM/SIGQUIT/SIGHUP/SIGUSR1
        ├── 解析 GUC (-D/-p/-h/-c)
        ├── ListenServerPort()         # 创建 TCP + Unix socket
        ├── load_hba()/load_ident()    # 加载认证配置
        ├── InitPostmasterDeathWatchHandle()  # 父死检测 pipe
        ├── StartChildProcess(B_CHECKPOINTER / B_BG_WRITER / B_STARTUP)
        │     └─ fork_process() → child_process_kinds[type].main_fn()
        │           startup: StartupProcessMain() → crash recovery (StartupXLOG)
        └── ServerLoop()               # 进入主事件循环
              └── WaitEventSetWait() 检测连接 / 信号
                    └── WL_SOCKET_ACCEPT → AcceptConnection() → BackendStartup()
                          └── fork_process() → BackendMain()
                                ├── BackendInitialize()  # pq_init + SSL + startup packet
                                ├── InitProcess()         # 共享内存 PGPROC
                                └── PostgresMain(dbname, username)  # 进入查询循环
```

对象装配要点：**配置**来自 `postgresql.conf`（GUC）+ 命令行 `-c` + 环境变量，覆盖优先级为后者高于前者。**共享内存**在 `PostmasterMain` 阶段由 `CreateSharedMemoryAndSemaphores()`（`storage/ipc/ipci.c:200`）一次性分配，fork 后子进程继承指针（Unix）或 attach（EXEC_BACKEND）。**辅助进程**由 `LaunchMissingBackgroundProcesses()`（`postmaster.c:3267`）按 `pmState` 动态启动——bgwriter/checkpointer/walwriter 仅在 `PM_RUN` 运行，walreceiver 仅在 recovery 运行。**backend 的 PGPROC** 在 `InitProcess()`（`backend_startup.c:116`）注册到共享内存 ProcArray，此后才能用 LWLock 和共享数据结构。

### 核心运行流程

下面三条主链路覆盖 PostgreSQL 最重要的运行时场景：简单查询、DML 写入、崩溃恢复。它们横跨多个模块，是理解「程序到底怎么跑起来」的关键。

#### 查询处理：Simple Query 全流程

业务流程：客户端发送 SQL 文本 → 解析 → 分析 → 重写 → 规划 → 执行 → 结果返回客户端。

![查询数据流](/vibe-reading/images/articles/postgres-internals/data-flow.svg)

文字描述：`PostgresMain` 收到 `PqMsg_Query` 后调 `exec_simple_query`（`tcop/postgres.c:1012`）。`pg_parse_query` 经 flex/bison 把 `char*` 文本变成 `List<RawStmt>` 原始语法树（不访问目录）。`pg_analyze_and_rewrite_fixedparams` 做语义分析：`parse_analyze` 用 `ParseState` 解析表/列/类型引用，产出 `List<Query>` 语义树，期间 `QueryRewrite` 应用规则（视图展开）。`pg_plan_queries` 调 `planner` 做 Path 探索 + 代价选择 + Plan 生成，产出 `List<PlannedStmt>`。随后 `CreatePortal` → `PortalStart` → `PortalRun` → `ExecutePlan` 循环调 `ExecProcNode` 迭代器拉取元组，经 `DestReceiver` 发回客户端（`RowDescription` + `DataRow` + `CommandComplete` + `ReadyForQuery`）。

关键设计决策：**快照在 analyze 前用 `PushActiveSnapshot` 获取，但执行前会重新获取**（`postgres.c:1219-1228` 注释解释：避免在锁表前取快照导致可见性异常）。多语句 SQL 被 `BeginImplicitTransactionBlock` 包成一个隐式事务。

#### 写入处理：DML 与 WAL/MVCC 交互

业务流程：`INSERT/UPDATE/DELETE` → 执行器 ModifyTable → heap AM → WAL 记录 → 事务提交刷盘。

`PortalRun` → `ExecutePlan` → `ModifyTable`（`executor/nodeModifyTable.c:4175`）触发 BEFORE 触发器 → `ExecInsert`/`ExecUpdate`/`ExecDelete`。以 `heap_insert`（`access/heap/heapam.c:2081`）为例：`heap_prepare_insert` 设 xmin → `RelationGetBufferForTuple` 找页 → `START_CRIT_SECTION` → `RelationPutHeapTuple` 写页 → `MarkBufferDirty` → `XLogBeginInsert`/`XLogRegisterBuffer`/`XLogInsert(RM_HEAP_ID,...)` 写 WAL → `PageSetLSN`。提交时 `CommitTransaction`（`xact.c:2268`）→ `RecordTransactionCommit` 写 commit WAL record → `XLogFlush` 确保落盘 → `ProcArrayEndTransaction` 标记 clog。

关键决策：**WAL 先于数据页落盘**（`FlushBuffer` in `storage/buffer/bufmgr.c:4565` 写页前先 `XLogFlush`），这是 write-ahead 原则的核心实现点。MVCC 可见性判定 `HeapTupleSatisfiesMVCC` 在 scan 时按 xmin/xmax + 快照判定，读不阻塞写。

#### 崩溃恢复：Crash → 重建 → Redo

业务流程：backend 崩溃 → postmaster 检测 → 终止所有子进程 → 重建共享内存 → startup 进程 redo WAL。

`process_pm_child_exit`（`postmaster.c:2233`）经 `waitpid` 收尸，若退出码非 0/1（关键进程连 exit 1 也视为 crash）→ `HandleChildCrash` → `HandleFatalError`。状态机 `PM_RUN → PM_WAIT_BACKENDS → PM_NO_CHILDREN`，随后 `shmem_exit(1)` 销毁旧共享内存 → `ResetShmemAllocator` → `CreateSharedMemoryAndSemaphores` 重建 → `StartChildProcess(B_STARTUP)`。startup 进程 `StartupXLOG`（`xact.c:5874`→实为`xlog.c`）→ `PerformWalRecovery`（`xlogrecovery.c:1680`）的 redo 循环逐条读 WAL record，按 `xl_rmid` 分发到各 rmgr 的 `rm_redo`（`heap_redo`/`btree_redo`/`xact_redo` 等），重放所有已提交事务的修改。

关键决策：**不尝试在原进程内恢复**（`postmaster.c:3197` 注释：PG 8.3 前尝试过，但 SIGTERM 时序问题导致不可靠），改为全量重建共享内存 + 重新 recovery，保留 listen socket 避免端口窗口。Full-Page Writes（FPW）防页撕裂：checkpoint 后首次改页时 WAL 含整页镜像。

### 状态流

![后端进程事务状态流](/vibe-reading/images/articles/postgres-internals/state-flow.svg)

PostgreSQL 有两个关键状态机。**Postmaster 的 PMState**（`postmaster.c:336`）管理服务端生命周期：`PM_INIT → PM_STARTUP → PM_RECOVERY → PM_HOT_STANDBY → PM_RUN`，shutdown 时 `PM_RUN → PM_STOP_BACKENDS → PM_WAIT_BACKENDS → PM_WAIT_XLOG_SHUTDOWN → PM_WAIT_XLOG_ARCHIVAL → PM_WAIT_CHECKPOINTER → PM_NO_CHILDREN → exit`，crash 时任意状态 → `PM_WAIT_BACKENDS` → 重建 → `PM_STARTUP`。**事务的 TBlockState**（`xact.c:159`，20 个状态）管理每个 backend 的事务块：`TBLOCK_DEFAULT → TBLOCK_STARTED`（隐式）或 `TBLOCK_BEGIN → TBLOCK_INPROGRESS`（显式），出错 `TBLOCK_ABORT → TBLOCK_ABORT_END`，`ReadyForQuery` 据此发 `'I'`/`'T'`/`'E'` 状态码。

---

## 典型修改场景

#### 场景 1：新增一种索引访问方法（如向量索引）

需修改 `src/backend/access/myindex/` 实现 `IndexAmRoutine` 回调（`ambuild`/`aminsert`/`ambeginscan`/`amgettuple`，见 `access/amapi.h:233`）→ `CREATE ACCESS METHOD myindex TYPE INDEX HANDLER ...` 注册到 `pg_am` → 如需自定义 WAL，在 `src/include/access/rmgrlist.h` 加 `PG_RMGR(RM_MYINDEX_ID,...)` 并实现 `myindex_redo`。

#### 场景 2：新增一种执行节点（如向量化扫描）

需新建 `src/backend/executor/nodeVectorScan.c` 实现 Init/Exec/ReScan/End 四方法 → `execProcnode.c:142` 的 `ExecInitNode` switch 加 `case T_VectorScan` → `execAmi.c:77` 的 `ExecReScan` 加 case → `include/nodes/execnodes.h` 定义 `VectorScanState` → `plannodes.h` 定义 plan 节点 → optimizer 侧 `joinpath.c`/`createplan.c` 生成该 plan。

#### 场景 3：新增一个辅助后台进程

需 `include/miscadmin.h` 的 `BackendType` enum 加 `B_XXX` → `postmaster/proctypelist.h` 加 `PG_PROCTYPE(B_XXX,...,XxxMain,true)`（X-macro 自动同步 dispatch/命名）→ 新建 `postmaster/xxx.c` 实现 `XxxMain`（调 `AuxiliaryProcessMainCommon` 后自定义循环）→ `postmaster.c:3267 LaunchMissingBackgroundProcesses` 加启动逻辑 → `process_pm_child_exit` 加退出处理。

---

## 测试体系

```
src/test/
├── regress/        # 回归测试（SQL 期望输出比对）
│   ├── sql/        # 测试用例 .sql
│   └── expected/   # 期望输出 .out
├── isolation/      # 隔离测试（并发会话时序）
├── recovery/       # 复制/恢复测试
├── subscription/   # 逻辑复制测试
├── perl/           # TAP 测试（基础设施 + 端到端）
└── module/         # C 单元测试
```

| 代码层 | 测试类型 |
| --- | --- |
| access/transam | recovery/ + isolation/（崩溃、并发、复制） |
| optimizer | regress/sql/（计划稳定性、EXPLAIN 输出） |
| executor | regress/ + isolation/（并发 MVCC） |
| parser | regress/（语法覆盖） |

理解某模块时优先看 `src/test/regress/sql/<topic>.sql`——它是可执行文档，展示了所有边界情况。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `src/backend/main/main.c` 的 `main()` → `postmaster/postmaster.c:494` 的 `PostmasterMain` → `postmaster.c:1653` 的 `ServerLoop` → `tcop/backend_startup.c:76` 的 `BackendMain` → `tcop/postgres.c:4188` 的 `PostgresMain` → `tcop/postgres.c:1012` 的 `exec_simple_query`
- **第二遍：理解查询编译流水线**
  `tcop/postgres.c:604` 的 `pg_parse_query`（→ `parser/parser.c` `raw_parser`）→ `postgres.c:666` 的 `pg_analyze_and_rewrite_fixedparams`（→ `parser/analyze.c` `parse_analyze` + `rewrite/rewriteHandler.c` `QueryRewrite`）→ `postgres.c:971` 的 `pg_plan_queries`（→ `optimizer/plan/planner.c` `planner`）
- **第三遍：理解执行与存储**
  `tcop/pquery.c:685` 的 `PortalRun` → `executor/execMain.c:297` 的 `ExecutorRun` → `executor/execMain.c:1660` 的 `ExecutePlan` → `executor/nodeSeqscan.c` 的 `ExecSeqScan` → `access/heap/heapam.c` 的 `heap_getnext` → `storage/buffer/bufmgr.c:805` 的 `ReadBufferExtended`
- **第四遍：理解事务与恢复（ACID 基石）**
  `access/transam/xact.c:2268` 的 `CommitTransaction` → `access/transam/xloginsert.c:474` 的 `XLogInsert` → `access/transam/xlog.c:2780` 的 `XLogFlush` → `storage/ipc/procarray.c:2175` 的 `GetSnapshotData` → `access/heap/heapam_visibility.c:960` 的 `HeapTupleSatisfiesMVCC` → `access/transam/xlog.c:5467` 的 `StartupXLOG`
- **第五遍：选择重点子模块深入阅读**（见各模块文档）

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| backend | 处理单个客户端会话的服务端进程 |
| postmaster | 监听并 fork backend 的主进程 |
| AM（Access Method） | 表/索引的存储引擎抽象 |
| WAL | Write-Ahead Log，预写日志 |
| MVCC | Multi-Version Concurrency Control，多版本并发控制 |
| HOT | Heap-Only Tuple，update 不更新索引的优化 |
| FPW | Full-Page Write，checkpoint 后首次改页写整页镜像 |
| RTE | RangeTblEntry，范围表条目 |
| Portal | 查询执行的 ready-to-run 容器 |
| LSN | Log Sequence Number，WAL 位置编号 |

### 参考资料

- [PostgreSQL 官方文档](https://www.postgresql.org/docs/)
- [PostgreSQL Internals](https://www.postgresql.org/docs/current/internals.html)（官方 internals 章节）
- [The Internals of PostgreSQL](https://www.interdb.jp/pg/)（社区 internals 图解）
- 仓库 [GitHub postgres/postgres](https://github.com/postgres/postgres)
