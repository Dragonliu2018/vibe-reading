---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "服务外壳与生命周期"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 服务外壳模块解读：main 入口与 InfinityContext 两阶段初始化、Infinity 门面的 140 个 API、QueryContext 七阶段查询管线、Session/Config/ClusterManager 的对象装配，以及维护模式与集群角色的双状态机设计"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/main/` + `src/bin/` + `src/admin/` 是 Infinity 进程的**组合根（composition root）**：进程入口、全局上下文装配、对外的门面 API、每查询的管线驱动器，以及维护模式下的 admin 命令执行器。模块合计约 1.44 万行，其中大头是 `admin_executor_impl.cpp`（4,284 行）和 `config_impl.cpp`（3,047 行）。

它与网络协议层的分工是：网络层只做协议编解码与会话管理，**所有业务语义都收敛到 `Infinity` 门面**——thrift、PG、HTTP 三个前端消费同一套门面方法。`QueryContext` 则是每个查询的"指挥部"，持有 parser/planner/optimizer/scheduler 的实例并驱动七阶段管线。

值得一提的代码组织：这个代码库全面使用 C++20 modules——每个类一个 `.cppm` 接口文件（`export module`）配一个 `_impl.cpp` 实现分区，模块名统一为 `infinity_core:xxx`。这是 C++ 圈少见的激进实践（配合 CMake 的 C++ modules 支持），接口与实现物理分离，编译防火墙清晰。

---

## 模块架构

```text
src/bin/infinity_main.cpp          进程入口：CLI 解析、信号注册、服务器启动顺序
src/main/
├── infinity_context.cppm/_impl    InfinityContext：全局单例，持有六件套（组合根）
├── infinity.cppm/_impl            Infinity 门面：~140 个 QueryResult Xxx(...) API
├── query_context.cppm/_impl       QueryContext：每查询一个，七阶段管线驱动
├── session.cppm / session_manager  会话（事务挂载点）与进程级会话表
├── config.cppm / options.cppm      Config + GlobalOptions（58 个配置项）
├── cluster_manager.cppm/_impl     集群角色管理（admin/standalone/leader/follower/learner）
├── query_result.cppm / profiler  查询结果与性能剖析
├── variables.cppm                 SET/SHOW VARIABLE 的变量注册表
└── logger.cppm / resource_manager 日志与资源管理
src/admin/admin_executor_impl.cpp   AdminExecutor：30+ 个维护命令的静态分发器
```

架构上有四条主线交织：

1. **InfinityContext 是唯一 new 子系统的地方**。`Config`、`ResourceManager`、`SessionManager`、`Storage`、`ClusterManager`、`TaskScheduler` 六件套都是它的 `unique_ptr` 成员，通过内联访问器对外暴露裸指针。`main()` 不直接 new 任何子系统——它只调 `InitPhase1/InitPhase2`。另外全文索引构建（`inverting_thread_pool_`）、HNSW 建图（`hnsw_build_thread_pool_`）等四个 `ctpl::thread_pool` 也是 `InfinityContext` 的内联成员，按 config 的 worker 数 resize（`SetIndexThreadPool()` in `infinity_context_impl.cpp:502`）。

2. **Infinity 门面统一三协议**。`class Infinity`（`infinity.cppm:39`）的 ~140 个方法全是同构四行样板：`GET_QUERY_CONTEXT` 宏取上下文（variant 双态：未就绪时直接返回错误 QueryResult）→ 手工构造 Statement 对象（**门面 API 是"已解析"的语句，绕过 SQL parser**）→ `query_context_ptr->QueryStatement(...)`。

3. **QueryContext 是查询指挥部**。构造时绑定 session，`Init()` 注入 7 个全局服务（config/task_scheduler/storage/resource_manager/session_manager/persistence_manager），再装配 `parser_`/`logical_planner_`/`optimizer_`/`physical_planner_`/`fragment_builder_` 五件套——每查询一套编译器组件，无共享状态。

4. **AdminExecutor 直通维护面**。admin 语句（`ADMIN SHOW ...`）在 `QueryStatementInternal` 一入口就分流到 `AdminExecutor::Execute`（`admin_executor_impl.cpp:59` 的 switch 分发 30 余个 case），**不走事务栈、不走优化器**——因为它们面向实例级元数据（节点拓扑、WAL 文件、config），不属于任何数据库事务快照，且必须在 `infinity_context_started_ == false`（存储尚为 admin 只读模式）时也能执行。

---

## 调用链路

### 启动链：main → InitPhase1 → InitPhase2

```text
main()                                          src/bin/infinity_main.cpp:227
 ├─ CLI 解析（CLI11：-f/--config、-m/--maintenance）
 ├─ InfinityContext::InitPhase1(config_path)    infinity_context_impl.cpp:42
 │   ├─ VarUtil::InitVariablesMap()             系统/会话变量名注册
 │   ├─ config_ = make_unique<Config>()         TOML 解析或默认值
 │   ├─ Logger::Initialize(config_)
 │   ├─ resource_manager_ / session_mgr_ 装配
 │   └─ ChangeServerRole(NodeRole::kAdmin)      ★ 先拉到 admin 角色
 │       ├─ storage_ = make_unique<Storage>(config_.get())
 │       ├─ cluster_manager_ = make_unique<ClusterManager>()
 │       ├─ storage_->SetStorageMode(StorageMode::kAdmin)   存储锁定只读
 │       └─ StartThriftServers()                thrift + peer server 开始监听
 ├─ StartThriftServers()（幂等）→ pg_server.Run() → http_server.Start()
 ├─ RegisterSignal() + set_terminate(TerminateHandler)
 └─ InfinityContext::InitPhase2(m_flag)         infinity_context_impl.cpp:80
     ├─ admin 模式或 -m → 短路返回（maintenance 停驻 admin 角色）
     └─ "standalone" → ChangeServerRole(kStandalone)
         ├─ cluster_manager_->InitAsStandalone()
         ├─ storage_->SetStorageMode(kWritable)
         └─ task_scheduler_ = make_unique<TaskScheduler>(config)  ← 角色确定后才建
```

### 查询链：thrift → 门面 → 七阶段管线

```text
Infinity::CreateDatabase                     infinity_impl.cpp:149（140 个方法同构）
 ├─ GET_QUERY_CONTEXT(GetQueryContext(), qctx)   宏 in infinity_impl.cpp:83
 │   └─ GetQueryContext                        infinity_impl.cpp:56
 │       ├─ !Inited  → 返回 Status::InfinityIsIniting
 │       ├─ !Started → 返回 Status::InfinityIsStarting
 │       └─ make_unique<QueryContext>(session) + Init(7 个全局服务)
 ├─ 手工构造 CreateStatement
 └─ qctx->QueryStatement(stmt)
     └─ do { QueryStatementInternal(stmt) } while (status == kTxnConflict)
         ├─ admin 分支 → HandleAdminStatement → AdminExecutor::Execute
         ├─ BeginTxn(stmt)                      StatementType → TransactionType 大 switch
         ├─ logical_planner_->Build()            kLogicalPlan
         ├─ optimizer_->optimize()               kOptimizer
         ├─ physical_planner_->BuildPhysicalOperator()  kPhysicalPlan
         ├─ fragment_builder_->BuildFragment()   kPipelineBuild
         ├─ FragmentContext::BuildTask(this)    kTaskBuild
         ├─ scheduler_->Schedule(...) → GetResult()  kExecution
         ├─ CommitTxn()                          kCommit（冲突 → RecoverableError → 重试）
         └─ catch(UnrecoverableException) → raise(SIGUSR1) 自杀取 core
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `InfinityContext::InitPhase1` | `infinity_context_impl.cpp:42` | 配置/日志/资源装配，角色拉到 kAdmin，启动 thrift |
| `InfinityContext::InitPhase2` | `infinity_context_impl.cpp:80` | 角色定局：standalone 转 kWritable，建 TaskScheduler |
| `InfinityContext::ChangeServerRole` | `infinity_context_impl.cpp:102` | 嵌套 switch 状态机，联动 StorageMode，失败回滚重建 |
| `Infinity::GetQueryContext` | `infinity_impl.cpp:56` | variant 双态：错误 QueryResult 或正常上下文 |
| `QueryContext::Query` | `query_context_impl.cpp:87` | SQL 文本入口：parser 强制单语句 |
| `QueryContext::QueryStatement` | `query_context_impl.cpp:114` | TxnConflict 自动重试循环 |
| `QueryContext::QueryStatementInternal` | `query_context_impl.cpp:123` | 七阶段管线主体，每阶段 StartProfile/StopProfile |
| `QueryContext::BeginTxn` | `query_context_impl.cpp:388` | StatementType → TransactionType 映射 |
| `AdminExecutor::Execute` | `admin_executor_impl.cpp:59` | 30+ case 的静态命令分发 |
| `ClusterManager::InitAsFollower` | `cluster_manager_reader_impl.cpp` | 注册到 leader + 接收 WAL 追平 |
| `ShutdownServer` | `infinity_main.cpp:120` | 信号触发，逆序停 HTTP → PG → UnInit |

</details>

---

## 核心实现

### 两阶段初始化：先监听、后定角色

`InitPhase1` 把进程拉到 `kAdmin` 角色（storage 锁 `kAdmin`、thrift/peer server 已监听），`InitPhase2` 才按 config 决定 standalone 还是停驻 admin。为什么这样设计？**集群模式下 follower 的角色切换要求节点先可被 leader 连上**——`ChangeServerRole(kAdmin→kFollower)` 尾部触发 `RegisterToLeader()`，注册要经历 leader 侧 `AddNodeInfo` → `SyncLogsOnRegistration` 推 WAL → follower 侧落盘回放的链路（`cluster_manager_reader_impl.cpp:92-141`）。若监听晚于角色确定，follower 会卡在"想注册但 leader 连不上我"的死锁里。需要说明：v0.7.3 的 `ContinueStartup`（注册完成后的 catalog 回放入口）函数体已被整体注释，只剩 `return Status::OK()`——**集群在线复制是半成品**（leader 推日志与 follower 落盘 `FlushLogByReplication` 已实现，回放应用未接线）。

两阶段也是 **maintenance 模式的载体**：`-m` 标志让 `InitPhase2` 短路（`infinity_context_impl.cpp:82-87`），DBA 在一个拒绝业务读写的实例上做运维——这正是 `GetQueryContext` 里 `!Started → InfinityIsStarting` 检查与 admin 白名单配合的语义。

### 双状态机：NodeRole × StorageMode 原子联动

```cpp
// infinity_context_impl.cpp:102 —— 嵌套 switch
Status InfinityContext::ChangeServerRole(NodeRole target_role, bool from_leader, ...) {
    switch (current_role) {
        case kAdmin: switch (target_role) { case kStandalone: ... case kFollower: ... } ...
    }
}
```

每次角色迁移都同步翻转 `StorageMode`（leader/standalone → `kWritable`，follower/learner → `kReadable`，admin → `kAdmin`），任一步失败即 `cluster_manager_.reset()` 后**重建** ClusterManager 并 `InitAsAdmin()` 退守；非法迁移（如 learner→follower、follower→standalone）返回 `Status::CantSwitchRole`。leader/follower/learner 强制要求 shared storage（`kLocal` 直接报 `InvalidStorageType`）——写路径（WAL 追加）只允许出现在 leader/standalone，follower 靠 leader 的 `SyncLogsOnRegistration` 单向复制，物理上排除双写。

### Admin 语句的准入白名单

admin 语句在 `QueryStatementInternal` 一入口就分流（`query_context_impl.cpp:126-166`）：admin 角色下直通 `AdminExecutor::Execute`；**非 admin 角色下只有少数命令放行**——`kShowNode/kShowCurrentNode/kListNodes/kRemoveNode/kSetRole` 与 `SHOW VARIABLE` 的 `server_role` 变量，其余返回 `Status::AdminOnlySupportInMaintenanceMode`。`GetQueryContext(bool is_admin_stmt, ...)`（`infinity_impl.cpp:64`）同样按此放宽 started 检查。

### 集群复制：心跳 + WAL 日志流

leader 侧 `CheckHeartBeatThread` 以 1s 周期扫描 `other_node_map_`，`update_ts + 4 < now` 判超时置 `kTimeout`；follower 上限 `follower_limit_ = 4`（`SetFollowerNumber` 可调，超出报 `TooManyFollower`）、learner 上限 255；follower/learner 侧 `HeartBeatToLeaderThread` 断线自动 `Reconnect`。复制不走共享存储多写，而是 leader 从 WAL 取日志字符串构造 `SyncLogTask` 推给 follower 的 peer server，follower 侧 `FlushLogByReplication` 落盘。移除节点时 leader 先发 `ChangeRoleTask(node_name, "admin")` 把目标节点远程降为 admin 再从拓扑摘除。

一个值得注意的现状：v0.7.3 中 `ADMIN SET ROLE` 已被整体禁用——`AdminExecutor::SetRole`（`admin_executor_impl.cpp:4069-4240`）约 170 行实现全部注释掉，只返回空 OK。在线改角色的唯一存活路径是 leader 通过 peer RPC `ChangeRole` 把节点降级 admin（`peer_server_thrift_service_impl.cpp:169`，`from_leader=true` 区分"leader 主动摘除"与"本地请求"）。禁用原因代码中无注释，推测与 catalog 重构期角色切换语义未稳有关（待核实）。

### 事务绑定在 Session 而非 QueryContext

`NewTxn` 存于 `BaseSession::new_txn_`（`session.cppm:69`），`BeginTxn`/`CommitTxn` 经 `session_ptr_->GetNewTxn()` 存取。`QueryContext` 每查询新建（thrift 每次 RPC 新建、PG 每请求新建——`connection_impl.cpp:110` 有 FIXME 标记），但**事务与变量状态挂在生命周期更长的 session 上**。`TxnConflict` 时 `QueryStatement` 的 do-while 整条语句重跑。

### 不可恢复错误即自杀

`UnrecoverableException` 捕获后 `raise(SIGUSR1)`（`query_context_impl.cpp:310`），配合 `SignalHandler` 的 `PrintTransactionHistory() + PrintStacktrace()` 再重触发信号产 coredump；`std::set_terminate(TerminateHandler)` 兜底未捕获异常。设计逻辑：进程内共享 catalog/buffer 状态无法局部恢复，**快死快重启优于带病运行**。

### 回调注入打破循环依赖

`InfinityContext` 需要在角色切换时启停 thrift server，但 core 模块不能 import network 模块（会形成 core → network → core 的环）。解法是 `main()` 把 `StartThriftServer/StopThriftServer` 两个 lambda 注入（`AddThriftServerFn`，`infinity_main.cpp:272`），context 只存 `std::function`。`StopThriftServers` 额外调 `InfinityThriftService::ClearSessionMap()` 清理 thrift 会话表。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Singleton（CRTP + Meyers） | `common/singleton.cppm:20`；`InfinityContext : public Singleton<InfinityContext>` | 进程唯一全局上下文；CRTP 让各单例免写 instance() |
| Facade（门面） | `class Infinity`（`infinity.cppm:39`） | 三个网络前端与查询引擎解耦；140 个 API 是协议契约 |
| 状态机（嵌套 switch） | `ChangeServerRole`（`infinity_context_impl.cpp:102`） | NodeRole × StorageMode 双状态机原子联动，非法迁移报错 |
| 依赖注入回调 | `AddThriftServerFn`（`infinity_context.cppm:75`） | 控制反转解循环依赖 |
| Template Method 管线 | `QueryStatementInternal`（`query_context_impl.cpp:123`） | 七阶段固定顺序 + profiler 挂钩 |
| variant 双态返回 | `GetQueryContext` 返回 `variant<unique_ptr<QueryContext>, QueryResult>` | "未就绪错误"与"正常上下文"统一一个返回值 |
| 静态命令分发器 | `AdminExecutor::Execute` | 无状态纯函数式，admin 命令天然适合 |
| Factory Method | `SessionManager::CreateRemoteSession/CreateLocalSession` | Local/Remote 两种会话产品 |

---

## 模块间交互

**被谁依赖**：`src/bin/infinity_core.cppm` 把本模块全部分区 re-export 成巨型聚合模块 `infinity_core`；网络三前端 `import :infinity` 用门面；peer server 经 RPC 远程调 `ChangeServerRole`。**依赖谁**：`:storage`（Storage/NewCatalog/NewTxnManager）、`:wal_manager`（集群日志回放）、`:task_scheduler`、parser 各 statement 模块（门面构造语句对象所需）。

---

## 扩展方式

**新增一个 config 项**：`options.cppm` 的 `GlobalOptionIndex` 枚举加项（插在 `kInvalid` 前）→ `config_impl.cpp` 两个分支（无配置文件默认值 + TOML 解析）各加 `make_unique<IntegerOption>(...)` + `AddOption` → `Config` 加访问器。`SET/SHOW CONFIG` 经 `name2index_` 映射自动生效。

**新增一个 admin 命令**：parser 的 `AdminStmtType` 加枚举 → `admin_executor.cppm` 加静态 handler 声明 → `Execute` 的 switch 加 case → 若要在非 maintenance 时也放行，`QueryStatementInternal` 的白名单（`query_context_impl.cpp:142-157`）加 case → 可选加门面方法。参考 `ListNodes`（`admin_executor_impl.cpp:3678`）的手工构表套路：`ColumnDef` 定义列 → `TableDef::Make` → `DataTable` → `Value::MakeVarchar(...).AppendToChunk(...)`。

**新增门面 API / 新语句类型**：`infinity.cppm` 声明 → `infinity_impl.cpp` 四行样板（参照 `CreateDatabase`）→ 新 statement 类型需补 `BeginTxn` 的大 switch 映射 → storage 层 `BeginTxnShared` 要能接受该 txn 类型。
