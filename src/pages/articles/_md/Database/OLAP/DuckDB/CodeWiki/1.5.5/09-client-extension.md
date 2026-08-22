---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Client & Extension"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "ClientContext", "Extension", "Embedded"]
description: "DuckDB Client & Extension 模块——DatabaseInstance/ClientContext/Connection 嵌入式门面 + C ABI 扩展动态加载 + Secret 管理。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Client & Extension 模块（`src/main/`）是 DuckDB 作为嵌入式数据库的对外门面——管理数据库实例生命周期、客户端会话上下文、查询提交与结果返回、扩展系统和 Secret 凭据管理。这是 DuckDB "进程内库"设计的核心体现：`DuckDB` 对象直接在宿主进程中运行，`Connection::Query()` 是进程内函数调用而非 RPC。

## 模块架构

四层 Facade 层次：`DuckDB`（用户门面，仅持有 `shared_ptr<DatabaseInstance>`）→ `DatabaseInstance`（子系统容器，持有 BufferManager/Catalog/Scheduler 等 `unique_ptr`）→ `ClientContext`（会话上下文，持有 Transaction/Config/ActiveQuery）→ `Connection`（用户 API 门面，持有 `shared_ptr<ClientContext>`）。

`PendingQueryResult` 是异步查询设计的核心——分离"准备查询"（parse→plan→optimize→physical plan→初始化 Executor）和"执行查询"（ExecuteTask 循环），支持进度报告、中断和流式结果。`QueryResult` 继承体系：`MaterializedQueryResult`（完整结果在内存）/`StreamQueryResult`（增量 Fetch）。

扩展系统通过 `ExtensionLoader` 注册门面提供 `RegisterFunction`/`RegisterType`/`RegisterSecretType` 等方法。`.duckdb_extension` 文件是动态链接库加尾部元数据，支持 C++ ABI 和 C ABI 两种加载方式。`SecretManager` 管理认证凭据（S3 access key、HTTP Bearer token），支持内存临时存储和本地文件持久化。

## 调用链路

### 数据库启动

```
DuckDB::DuckDB(path, config)                          [database.cpp:340]
  └→ instance->Initialize(path, config)                [database.cpp:275]
       ├→ Configure(config, path)                       — 设置内存(80%系统)/线程/临时目录/BufferPool
       ├→ DatabaseManager 创建                          — catalog 管理
       ├→ StandardBufferManager 创建                    — 页面缓冲
       ├→ TaskScheduler 创建                            — 线程池（最后启动）
       ├→ ExtensionManager / SecretManager 创建
       ├→ DatabaseManager::InitializeSystemCatalog()    — 系统 catalog
       │    └→ BuiltinFunctions::Initialize()           — 注册内置函数
       ├→ CreateMainDatabase()                          — attach 主数据库文件
       └→ scheduler->RelaunchThreads()                  — 启动工作线程
  └→ ExtensionHelper::LoadAllExtensions()               — 静态链接扩展
```

### 查询提交

```
Connection::Query(query)                               [connection.cpp:101]
  → context->Query(query, FORCE_MATERIALIZED)           [client_context.cpp:1042]
       ├→ ParseStatements(lock, query)                   — Parser::ParseQuery + StatementPreprocessor
       ├→ [循环] PendingQueryInternal(lock, statement, parameters)
       │    → PendingStatementOrPreparedStatementInternal()
       │         ├→ BeginQueryInternal(lock, query)      — 开启事务、设置 active_query
       │         └→ CreatePreparedStatement(lock, query, statement, parameters)
       │              → CreatePreparedStatementInternal()  [client_context.cpp:387]
       │                   ├→ Planner::CreatePlan()        — 逻辑计划
       │                   ├→ Optimizer::Optimize()        — 优化
       │                   └→ PhysicalPlanGenerator::Plan()  — 物理计划
       │         └→ PendingPreparedStatementInternal()
       │              ├→ executor = make_uniq<Executor>()
       │              ├→ PhysicalResultCollector::GetResultCollector()
       │              └→ executor.Initialize(collector)    — 构建 Pipeline + 调度 Event
       │         → 返回 PendingQueryResult
       ├→ ExecutePendingQueryInternal(lock, *pending)
       │    → pending->Execute()  — 循环 ExecuteTaskInternal 直到 RESULT_READY
       └→ FetchResultInternal(lock, *pending)  — executor.GetResult() → QueryResult
```

### 扩展加载

```
ExtensionHelper::LoadExternalExtension(db, fs, extension)  [extension_load.cpp:709]
  → InitialLoad(db, fs, extension)                         [:570]
    → TryInitialLoad()                                     [:363]
      ├→ 搜索 extension_directories 下的 .duckdb_extension 文件
      ├→ ParseExtensionMetaData(handle)  — 解析文件尾部 256 字节元数据
      ├→ CheckExtensionSignature()  — RSA-SHA256 签名验证 (MbedTLS)
      └→ dlopen(filename, RTLD_NOW | RTLD_LOCAL)
  → [C++ ABI] dlsym → ext_init_fun_t ("*_duckdb_cpp_init")
    → ExtensionLoader loader(info)
    → (*init_fun)(loader)  — 扩展调用 loader.RegisterFunction() 等
  → [C ABI] dlsym → ext_init_c_api_fun_t ("*_init_c_api")
    → DuckDBExtensionLoadState + ExtensionAccess
    → (*init_fun_capi)(info, &access)  — 扩展通过 duckdb_ext_api_v1 函数指针表调 DuckDB
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `DatabaseInstance::Initialize` | 启动所有子系统 | 线程池最后启动避免 catalog 竞争 |
| `ClientContext::Query` | 查询主入口 | Parse→Pending→Execute→Fetch 四阶段 |
| `CreatePreparedStatementInternal` | 协调查询流水线 | Planner→Optimizer→PhysicalPlanGen |
| `PendingQueryResult::Execute` | 异步执行循环 | ExecuteTaskInternal 直到 RESULT_READY |
| `ExtensionHelper::LoadExternalExtension` | 扩展动态加载 | dlopen + 签名验证 + ABI 分派 |
| `ExtensionLoader::RegisterFunction` | 扩展注册函数 | 委托给 Catalog::CreateFunction |

</details>

## 核心实现

### 嵌入式（in-process）架构

DuckDB 选择嵌入式而非 client-server——`DuckDB` 构造函数直接 `instance->Initialize(path, config)`，无网络监听。`Connection` 直接持有 `shared_ptr<ClientContext>`，方法调用是进程内函数调用。好处：零网络开销、零序列化开销、直接共享内存。代价：不支持多进程并发访问（但支持同一进程内多 Connection 共享 DatabaseInstance）。

### ClientContext 会话隔离

`ClientContext` 通过 `mutex context_lock` 实现单 Connection 内串行化。多个 Connection 可共享同一 `DatabaseInstance`，每个有独立的 `ClientConfig`、`TransactionContext`、`ClientData`。`ActiveQueryContext`（`client_context.cpp:75`）是每次查询的临时上下文，持有 query 字符串、PreparedStatementData、Executor 和 ProgressBar，查询结束即销毁。所有公开方法通过 `LockContext()` 获取 RAII 锁 `ClientContextLock`。

### PendingQuery 异步设计

PendingQueryResult 分离"准备查询"和"执行查询"：
1. `PendingQuery()` 完成 parse→plan→optimize→physical plan→初始化 Executor，返回 `PendingQueryResult`
2. `Execute()` 循环调用 `ExecuteTaskInternal` → `executor->ExecuteTask()`，返回 `PendingExecutionResult`（`RESULT_NOT_READY`/`RESULT_READY`/`EXECUTION_FINISHED`/`BLOCKED`/`EXECUTION_ERROR`）

这使得 DuckDB 支持流式结果（`StreamQueryResult` 增量返回行）、进度报告（`ProgressBar`）、中断（`interrupted` atomic 标志）和非阻塞执行。`BLOCKED` 机制：当 Sink 返回 `BLOCKED`（如 streaming result collector 缓冲区满），任务被加入 `to_be_rescheduled_tasks`，主线程在 `WaitForTask` 中等待条件变量。

### Extension C ABI 动态加载

`.duckdb_extension` 文件是动态链接库 + 尾部 256 字节元数据（magic_value/platform/version/ABI type/SHA256 签名）。签名验证用 MbedTLS 的 RSA-SHA256，支持 DuckDB 官方公钥和社区扩展公钥，`allow_unsigned_extensions` 可跳过。两种 ABI：C++ ABI 通过 `dlsym` 查找 `*_duckdb_cpp_init` 符号接收 `ExtensionLoader&` 引用；C ABI 查找 `*_init_c_api` 符号，扩展通过 `duckdb_ext_api_v1` 函数指针表调用 DuckDB。C_STRUCT 类型使用 semver 版本检查，C_STRUCT_UNSTABLE 与 DuckDB 版本 1:1 绑定。

### Secret 管理

`SecretManager`（`secret_manager.hpp:90`）管理认证凭据——双存储后端：`"memory"`（内存临时）和 `"local_file"`（`~/.duckdb/stored_secrets/` 持久化）。`SecretMatch` 带评分，支持基于路径前缀的 secret 匹配。通过 `CREATE SECRET` SQL 语句创建（`LogicalCreateSecret` operator）。扩展通过 `ExtensionLoader::RegisterSecretType()` 注册新 secret 类型。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Facade | `DuckDB`/`Connection` in `database.hpp:109`/`connection.hpp:40` | 一行构造完成所有初始化，隐藏子系统 |
| Context | `ClientContext` in `client_context.hpp:66` | 持有会话状态，mutex 串行化 |
| Plugin/Extension | `ExtensionLoader` in `extension_loader.hpp:28` | C ABI 动态加载，签名验证 |
| Builder 链 | CreatePreparedStatement→Execute→FetchResult | Template Method 链构建查询结果 |
| RAII | `ExtensionActiveLoad`/`ClientContextLock` | 构造获取锁，析构释放 |

## 模块间交互

`DatabaseInstance::Initialize` 按序创建所有子系统——DatabaseManager/BufferManager/LogManager/TaskScheduler/ConnectionManager/ExtensionManager/SecretManager，最后 `CreateMainDatabase` attach 主数据库并 `InitializeSystemCatalog` 注册内置函数。`ClientContext::CreatePreparedStatementInternal` 协调查询流水线：Parser→Planner→Optimizer→PhysicalPlanGenerator→Executor。扩展通过 `ExtensionLoader` 向 catalog 注册函数/类型/secret——`RegisterFunction` 最终调用 `Catalog::GetSystemCatalog(db)` 获取系统 catalog 创建 `ScalarFunctionCatalogEntry`。

## 扩展方式

新增一个扩展：实现入口函数（C++: `DUCKDB_CPP_EXTENSION_ENTRY(name, loader) { loader.RegisterFunction(...); }` 或 C: `bool name_init_c_api(duckdb_extension_info info, duckdb_extension_access *access)`）→ 在 `extension/` 下创建扩展目录或在外部仓库开发 → 通过 `INSTALL name; LOAD name;` 使用。静态链接扩展设置 CMake `DUCKDB_EXTENSION_XXX_LINKED` 宏。

新增一个配置项：通用设置在 `src/main/settings/` 的 JSON 定义中添加（自动生成 `setting_info.hpp`）→ `DBConfig::GetOptionByName()` 可查到。扩展专属设置在 `Load()` 中调用 `db.config.AddExtensionOption(name, description, LogicalType, default_value)`，可通过 `SET name = value` 修改。
