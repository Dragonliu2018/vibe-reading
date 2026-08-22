---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Overview"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "OLAP", "列式存储", "向量化执行"]
description: "DuckDB 1.5.5——高性能嵌入式分析数据库，向量化执行引擎 + 列式段存储 + MVCC 事务 + Morsel-Driven 并行 + 扩展系统源码解读。"
readingTime: "60 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 1.5.5 · **协议** MIT · **C++** 11 · **代码量** ~44.8 万行（318k cpp + 130k hpp）· **仓库** [GitHub](https://github.com/duckdb/duckdb)

---

## 总览

### 项目简介

DuckDB 是一个**高性能嵌入式分析数据库（embedded analytical database）**，设计目标是快速、可靠、可移植、易用。它以进程内库（in-process library）的形式运行，无需独立 server 进程，零网络开销、零序列化开销，直接与宿主应用共享内存。DuckDB 提供丰富的 SQL 方言，支持任意嵌套相关子查询、窗口函数、复杂数据类型（数组、结构体、映射），以及一系列旨在简化 SQL 使用的扩展功能。

DuckDB 解决的核心问题是：**在本地环境（笔记本电脑、分析脚本、嵌入式应用）中高效执行 OLAP 查询**，而无需部署和维护独立的数据库服务器。它填补了" SQLite for OLAP"的空白——SQLite 证明了嵌入式 OLTP 数据库的价值，DuckDB 将同样的理念带入分析型工作负载。核心价值在于：向量化执行引擎（每次处理 2048 行的 DataChunk 批次）在单机上即可达到接近专业数仓的扫描和聚合性能，同时保持零部署成本的嵌入式体验。

核心使用场景：Python/R 数据分析脚本中的 SQL 查询（pandas/dplyr 深度集成）、CLI 交互式数据分析、应用内嵌分析（替代提取数据到本地再处理的工作流）、CI/CD 中的数据验证、Jupyter/Colab 中的轻量数仓。

**项目边界**：DuckDB 负责单进程内的分析查询执行和列式存储，**不**支持分布式部署（无多节点协调）、**不**面向高并发写入场景（单进程写，MVCC 支持并发读）、**不**是 OLTP 引擎（优化方向是批量扫描而非单行点查）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| SQL 解析 | `src/parser/` + `third_party/libpg_query/` | 基于 PostgreSQL parser（libpg_query），SQL string → AST |
| 查询绑定 | `src/planner/binder.cpp` | 名称解析、类型推导、Catalog 绑定，AST → LogicalPlan |
| 逻辑优化 | `src/optimizer/optimizer.cpp` | 27+ pass 规则链（FilterPushdown、JoinOrder DP、CSE 等） |
| 向量化执行 | `src/execution/` + `src/parallel/` | DataChunk 批处理（2048 行），Pull-Push 混合流水线 |
| Morsel 并行 | `src/parallel/pipeline_executor.cpp` | Morsel-Driven 并行 + 5-Event 状态机 + 无锁队列 |
| 列式存储 | `src/storage/table/column_data.cpp` | ColumnData → ColumnSegment，按段压缩 |
| Buffer 管理 | `src/storage/buffer_manager.cpp` | 多级 EvictionQueue 近似 LRU，临时文件溢出 |
| MVCC 事务 | `src/transaction/duck_transaction_manager.cpp` | UndoBuffer 记录旧值，commit/rollback/cleanup 状态机 |
| WAL + Checkpoint | `src/storage/write_ahead_log.cpp` | 先写 WAL 保证持久性，auto-checkpoint 基于估算大小触发 |
| 函数系统 | `src/function/` | Scalar/Aggregate/Table/Pragma/Cast，function pointer 策略模式 |
| Catalog MVCC | `src/catalog/catalog_set.cpp` | 版本链 + 依赖图，支持并发 DDL |
| 扩展系统 | `src/main/extension/extension_load.cpp` | `.duckdb_extension` 动态库，C ABI + 签名验证 |
| 类型系统 | `src/common/types/` | LogicalType + PhysicalType 双层，5 种 Vector 布局 |
| 多语言绑定 | `src/main/capi/` | C API 为基础，Python/R/Java/Wasm 上层封装 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++11 | 核心 | 主语言，向量化执行引擎 |
| CMake | 核心 | 构建系统，支持多平台编译 |
| libpg_query | 核心 | PostgreSQL parser 内核，SQL 词法/语法分析 |
| moodycamel ConcurrentQueue | 核心 | 无锁任务队列，TaskScheduler 线程池 |
| fmt | 核心 | 格式化库，错误信息和日志 |
| re2 | 核心 | 正则表达式引擎 |
| FSST | 核心 | 字符串压缩（Vector 布局 + 存储压缩） |
| fastpforlib | 核心 | 整数位压缩（BitPacking） |
| Parquet (thrift) | 可选 | Parquet 读写扩展 |
| zstd / lz4 / snappy / brotli | 可选 | 压缩算法库 |
| MbedTLS | 可选 | TLS 加密 + 扩展签名验证 |
| pcg / pdqsort / ska_sort | 核心 | 随机数 / 排序 / 基数排序 |

### 版本历史

DuckDB 的版本演进主线：

- **0.x 系列（2019-2022）**：奠定向量化执行引擎和列式存储基础，引入 JSON/Parquet 扩展
- **1.0（2024）**：首个稳定发布，API 稳定承诺，全面 ACID 事务
- **1.x 系列（2024-2025）**：持续增强——TEMPLATE 类型推断（v1.5）、Secret 管理系统、time-travel 查询（AT 子句）、COPY DATABASE、PIVOT/UNPIVOT 语法、Lambda 表达式（`->` 箭头）

**1.5.5** 是 1.5 系列的第 5 个 patch 版本，处于持续迭代中。解读基线为 tag `v1.5.5`（commit `d8cdaa33fd`，2026-08-20）。

---

## 快速上手

DuckDB 作为嵌入式数据库，最简使用方式是 Python 中一行代码：

```bash title="shell"
# 从源码构建
git clone https://github.com/duckdb/duckdb.git
cd duckdb && make -j8          # 生成 build/release/duckdb
```

```bash title="shell"
# CLI 交互式使用
./build/release/duckdb
v1.5.5 duckdb> SELECT * FROM 'test.csv' LIMIT 5;  -- 直接查 CSV 文件
v1.5.5 duckdb> SELECT count(*) FROM read_parquet('data.parquet');  -- 查 Parquet
```

```python title="python"
import duckdb
result = duckdb.sql("SELECT * FROM 'users.csv' WHERE age > 25").df()  # 返回 pandas DataFrame
```

端到端验证：执行 `SELECT 1 + 1` 返回 `2` 即可确认构建成功。开发调试用 `make debug` 编译非优化版本，`make unit` 运行单元测试。

---

## 架构设计解析

### 系统架构

DuckDB 的架构设计围绕一个核心理念：**嵌入式分析数据库应该像 SQLite 一样简单部署，但像专业数仓一样高效执行**。为此，DuckDB 选择了进程内架构——没有独立的 server 进程，`DuckDB` 对象直接在宿主进程中运行。这使得查询执行路径上没有网络往返、没有序列化开销，`Connection::Query()` 直接是进程内函数调用。

在执行模型上，DuckDB 选择了**向量化执行（vectorized execution）**而非传统的 Volcano 逐行迭代模型。每次处理 `STANDARD_VECTOR_SIZE`（2048）行的 `DataChunk` 批次，摊薄了虚函数调用开销，改善了 cache 局部性，并允许 SIMD 指令利用。配合 Pull-Push 混合流水线模型——`PipelineExecutor` 主动从 Source 拉一个 chunk，推过算子链到 Sink——DuckDB 在高吞吐扫描场景下达到了接近手写循环的性能。

![DuckDB 分层架构](/vibe-reading/images/articles/duckdb-internals/architecture.svg)

DuckDB 的架构分为五层。**接口层**提供 C API、CLI Shell 和多语言绑定，是用户接触的入口。**查询流水线层**是 SQL 处理的核心，按 `Parser → Planner/Binder → Optimizer → PhysicalPlanGenerator` 四阶段将 SQL string 逐步转换为可执行的物理计划。**执行引擎层**包含物理算子（`PhysicalOperator`）、表达式执行器（`ExpressionExecutor`）和并行执行框架（`Pipeline`/`Executor`/`TaskScheduler`）。**存储引擎层**管理列式存储、Buffer 缓冲、WAL 和 MVCC 事务。**基础设施层**是跨模块的公共组件——类型系统（`Common Types/Vector`）、元数据管理（`Catalog`）、函数注册（`Function`）——被上层所有模块依赖。

层间依赖方向严格向下：接口层调用查询流水线层，查询流水线层依赖存储引擎和基础设施。执行引擎通过 `TableFunction` 间接调用存储层（策略模式解耦），避免执行引擎直接依赖具体存储格式。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接口层 | `src/main/`（C API/Connection）、`tools/shell/` | 隔离外部 API 协议，保护核心不受接口变化影响 |
| 查询流水线层 | `src/parser/`、`src/planner/`、`src/optimizer/` | 将 SQL 逐步转换为优化后的物理执行计划 |
| 执行引擎层 | `src/execution/`、`src/parallel/` | 向量化执行物理计划，Morsel-Driven 并行调度 |
| 存储引擎层 | `src/storage/`、`src/transaction/` | 列式段存储 + Buffer 管理 + MVCC + WAL 持久化 |
| 基础设施层 | `src/common/`、`src/catalog/`、`src/function/` | 类型系统、元数据、函数注册——被所有层依赖 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Facade（门面） | `DuckDB`/`Connection` in `src/main/database.hpp`、`connection.hpp` | 用户一行构造即完成所有初始化，隐藏子系统复杂性 |
| Pull-Push 混合迭代器 | `PipelineExecutor::Execute` in `src/parallel/pipeline_executor.cpp:188` | Volcano 变体，批量 push 减少虚调用，支持暂停/恢复 |
| 策略模式（function pointer） | `ScalarFunction::function` in `src/include/duckdb/function/scalar_function.hpp:98` | UDF 用函数指针而非虚函数，便于编译器内联优化 |
| 规则链/管道 | `Optimizer::RunBuiltInOptimizers` in `src/optimizer/optimizer.cpp:116` | 27+ 优化 pass 顺序执行，可独立禁用/调试 |
| Morsel-Driven 并行 | `Pipeline::LaunchScanTasks` in `src/parallel/pipeline.cpp:179` | 按数据批分配线程，避免数据倾斜，自然工作窃取 |
| 版本链 MVCC | `CatalogSet::GetEntryForTransaction` in `src/catalog/catalog_set.cpp:526` | 并发 DDL 不阻塞，支持 time-travel 查询 |
| 段式压缩（策略模式） | `ColumnSegment` + `CompressionFunction` in `src/storage/table/column_segment.hpp` | 按段选择最优压缩算法，新增算法不改上层 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `DuckDB` | 数据库实例门面 | 进程级 | 持有 `shared_ptr<DatabaseInstance>` |
| `DatabaseInstance` | 子系统容器 | 进程级 | 持有 BufferManager/Catalog/Scheduler 等 |
| `ClientContext` | 会话上下文 | 连接级 | 持有 Transaction/Config/ActiveQuery |
| `Connection` | 用户 API 门面 | 连接级 | 持有 `shared_ptr<ClientContext>` |
| `LogicalOperator` | 逻辑算子树节点 | 查询级 | 持有 `Expression` 列表 + 子算子 |
| `PhysicalOperator` | 物理算子树节点 | 查询级 | Source/Operator/Sink 三种角色 |
| `DataChunk` | 列批处理容器 | chunk 级 | 持有 `vector<Vector>`（2048 行/批） |
| `Vector` | 向量化数据容器 | chunk 级 | 5 种布局（Flat/Constant/Dict/FSST/Seq） |
| `Pipeline` | 流水线抽象 | 查询级 | source → operators[] → sink |
| `PendingQueryResult` | 异步查询句柄 | 查询级 | 分离准备与执行，支持进度/中断 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Catalog` | `src/include/duckdb/catalog/catalog.hpp:84` | `DuckCatalog` | `AttachedDatabase` 创建时绑定 |
| `StorageManager` | `src/include/duckdb/storage/storage_manager.hpp` | `SingleFileStorageManager` | `AttachedDatabase` 创建 |
| `BufferManager` | `src/include/duckdb/storage/buffer_manager.hpp` | `StandardBufferManager` | `DatabaseInstance::Initialize` |
| `CompressionFunction` | `src/include/duckdb/function/compression_function.hpp:225` | Uncompressed/Dict/RLE/FSST/ALP/BitPacking/Chimp/Patas/Zstd | `CompressionFunctionSet` 注册 |
| `TableFunction` | `src/include/duckdb/function/table_function.hpp:362` | TableScanFunction/ReadCSVFunction/ReadParquetFunction/RangeFun | `BuiltinFunctions::Initialize` |
| `PhysicalOperator` | `src/include/duckdb/execution/physical_operator.hpp` | 40+ 子类（HashJoin/HashAggregate/TableScan...） | `PhysicalPlanGenerator::CreatePlan` switch 分派 |

---

## 代码目录

```
duckdb/
├── src/
│   ├── parser/             # SQL 解析（16k 行）—— libpg_query → Transformer → AST
│   ├── planner/            # 查询规划（26k 行）—— Binder 绑定 + LogicalPlan 生成
│   ├── optimizer/          # 逻辑优化（21k 行）—— 27+ pass 规则链 + JoinOrder DP
│   ├── execution/          # 执行引擎（48k 行）—— PhysicalOperator + ExpressionExecutor
│   ├── parallel/           # 并行框架（3.3k 行）—— Pipeline + TaskScheduler + Event 状态机
│   ├── storage/            # 存储引擎（47k 行）—— BufferManager + ColumnData + WAL + Checkpoint
│   ├── transaction/        # 事务管理（2.5k 行）—— MVCC + UndoBuffer
│   ├── common/             # 公共基础（71k 行）—— Types/Vector/VectorOperations/Serializer
│   ├── catalog/            # 元数据管理（8.7k 行）—— CatalogSet + DependencyManager
│   ├── function/           # 函数系统（45k 行）—— Scalar/Aggregate/Table/Pragma/Cast
│   ├── main/               # 客户端与扩展（27k 行）—— Database/ClientContext/Extension/Secret
│   ├── logging/            # 日志（1.5k 行）
│   └── verification/       # 验证工具（0.4k 行）
├── extension/              # 内置扩展（parquet/json/icu/tpch/tpcds/delta/autocomplete...）
├── third_party/            # 第三方库（libpg_query/parquet/fmt/re2/zstd/lz4/mbedtls...）
├── tools/                  # CLI Shell + 构建工具
├── test/                   # 测试（70+ SQL 测试目录 + api/arrow/optimizer/storage...）
├── benchmark/              # 性能基准
└── examples/               # 嵌入式示例（C/C++/Python）
```

关键入口文件：`src/main/database.cpp`（`DatabaseInstance::Initialize`）、`src/main/connection.cpp`（`Connection::Query`）、`src/main/client_context.cpp`（`ClientContext::PendingQueryInternal`）。

---

## 模块地图

DuckDB 的 10 个有效模块按查询流水线方向排列，从 SQL 解析到结果返回，辅以存储引擎和跨模块基础设施。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

![DuckDB 模块依赖关系](/vibe-reading/images/articles/duckdb-internals/module-dependencies.svg)

模块间依赖方向：查询流水线层（Parser → Planner → Optimizer → Execution）是主数据流，Planner 依赖 Catalog 查表/列信息、依赖 Function 查函数签名，Execution 依赖 Function 调 UDF、通过 TableFunction 间接调用 Storage 读数据。Parallel 驱动 Execution 的 PhysicalOperator。所有模块依赖 Common Types/Vector 的类型系统和向量化数据容器。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Parser | SQL string → AST | `Parser::ParseQuery` in `parser.cpp:221` | 复用 libpg_query，AST 类型系统独立于执行 | [Parser](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/01-parser) |
| Planner | AST → LogicalPlan | `Planner::CreatePlan` in `planner.cpp:46` | 绑定（名称解析）与逻辑规划深度交织 | [Planner](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/02-planner) |
| Optimizer | LogicalPlan 优化 | `Optimizer::Optimize` in `optimizer.cpp:326` | 27+ pass 规则链 + Dphyp DP join order | [Optimizer](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/03-optimizer) |
| Execution | 向量化执行 | `PhysicalPlanGenerator::Plan` in `physical_plan_generator.cpp:23` | Pull-Push 混合模型 + 多策略算子选择 | [Execution](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/04-execution) |
| Storage | 列式段存储 + MVCC | `DataTable::Append` in `data_table.cpp:1200` | 段式压缩 + Buffer 淘汰 + UndoBuffer 版本 | [Storage](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/05-storage) |
| Types & Vector | 类型系统 + 向量化容器 | `Vector::ToUnifiedFormat` in `vector.cpp:1199` | 5 种 Vector 布局 + LogicalType/PhysicalType 双层 | [Types & Vector](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/06-types-vector) |
| Function | 函数注册与调度 | `FunctionBinder::BindScalarFunction` in `function_binder.cpp:311` | function pointer 策略 + 重载代价选择 | [Function](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/07-function) |
| Catalog | 元数据 MVCC 管理 | `CatalogSet::GetEntry` in `catalog_set.cpp:629` | 版本链 + 依赖图，支持并发 DDL | [Catalog](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/08-catalog) |
| Client & Extension | 数据库实例 + 扩展系统 | `DatabaseInstance::Initialize` in `database.cpp:275` | 嵌入式 Facade + C ABI 动态加载 | [Client & Extension](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/09-client-extension) |
| Parallel | Morsel-Driven 并行 | `Executor::ExecuteTask` in `executor.cpp:554` | 5-Event 状态机 + 无锁队列工作窃取 | [Parallel](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/10-parallel) |

---

## 运行时行为

### 启动流程

DuckDB 的启动从 `DuckDB` 构造函数出发，依次初始化所有子系统：

```
DuckDB::DuckDB(path, config)                    [database.cpp:340]
  └→ DatabaseInstance::Initialize(path, config)  [database.cpp:275]
       ├→ Configure(config, path)                 — 设置内存/线程/临时目录/BufferPool
       ├→ DatabaseManager 创建                     — catalog 管理（多数据库 attach）
       ├→ StandardBufferManager 创建               — 页面缓冲管理
       ├→ LogManager → Initialize()                — 日志系统
       ├→ TaskScheduler 创建                       — 线程池（最后启动，避免 catalog 竞争）
       ├→ ConnectionManager 创建                   — 连接管理
       ├→ ExtensionManager 创建                    — 扩展管理
       ├→ SecretManager → Initialize()             — 注册默认 secret 类型
       ├→ DatabaseManager::InitializeSystemCatalog()  — 系统 catalog（内置类型/函数）
       ├→ CreateMainDatabase()                     — attach 主数据库文件
       │    └→ Catalog::Initialize() → BuiltinFunctions::Initialize()
       │         注册 Scalar/Aggregate/Table/Pragma 函数到 catalog
       └→ scheduler->RelaunchThreads()             — 启动工作线程
  └→ ExtensionHelper::LoadAllExtensions()         — 加载静态链接扩展
```

对象装配顺序：`DBConfig` 先于 `DatabaseInstance` 创建（配置决定内存上限、线程数等），`DatabaseInstance` 持有所有子系统的 `unique_ptr`。`ClientContext` 在 `Connection` 构造时创建，持有独立的 `ClientConfig`、`TransactionContext`、`ClientData`。扩展通过 `ExtensionLoader` 向 catalog 注册函数/类型/secret，不直接持有子系统引用。

### 核心运行流程

DuckDB 的运行时行为围绕查询生命周期展开——从用户提交 SQL 到结果返回，贯穿所有模块。以下三条主链路覆盖了 DuckDB 的核心运行场景。

#### 查询处理：SQL → 结果返回

业务流程：用户提交 SQL → 解析 → 绑定 → 优化 → 物理计划 → 并行执行 → 结果返回

![DuckDB 查询数据流](/vibe-reading/images/articles/duckdb-internals/data-flow.svg)

文字描述：`Connection::Query` 委托给 `ClientContext::Query`，后者先调用 `Parser::ParseQuery` 将 SQL string 通过 libpg_query 转为 `SQLStatement` AST，再用 `StatementPreprocessor` 预处理。接着 `PendingQueryInternal` 调用 `CreatePreparedStatementInternal`——这是查询流水线的核心协调点：`Planner::CreatePlan` 执行绑定和逻辑规划生成 `LogicalOperator` 树，`Optimizer::Optimize` 应用 27+ pass 优化规则，`PhysicalPlanGenerator::Plan` 将逻辑算子转换为 `PhysicalOperator` 物理算子树。随后 `Executor::Initialize` 调用 `MetaPipeline::Build` 从物理算子树构建 Pipeline 拓扑，`ScheduleEvents` 为每个 Pipeline 创建 5 个 Event 组成的 DAG。最后 `PendingQueryResult::Execute` 循环调用 `ExecuteTaskInternal` → `Executor::ExecuteTask` → `PipelineExecutor::Execute`，从 Source 拉 DataChunk 推过算子链到 Sink（`PhysicalResultCollector`），汇总后通过 `FetchResultInternal` 返回 `MaterializedQueryResult`。

#### 数据写入：INSERT → 存储 → WAL

业务流程：INSERT 语句 → 解析绑定 → 物理执行 → DataTable 追加 → WAL 记录 → 事务提交

文字描述：`PhysicalInsert` 算子执行时，先通过 `ExpressionExecutor` 求值要插入的数据，然后调用 `DataTable::Append` → `RowGroupCollection::Append` → `RowGroup::Append` → `ColumnData::Append` → `ColumnSegment::Append`。写入时数据先进入 TRANSIENT 段（内存中，UNCOMPRESSED），段大小受 `Storage::BLOCK_SIZE`（256KB）限制。事务提交时 `DuckTransactionManager::CommitTransaction` 先调用 `UndoBuffer::WriteToWAL` 将操作记录到 WAL（WAL 锁与事务锁分离，允许只读并行），再 `UndoBuffer::Commit` 正序遍历设置 commit_id。当 WAL 大小超过阈值时自动触发 `CreateCheckpoint`，将内存数据压缩落盘并截断 WAL。

#### 扩展加载：INSTALL + LOAD → 注册函数

业务流程：`INSTALL ext` 下载 → `LOAD ext` dlopen → 签名验证 → 扩展注册函数

文字描述：`ExtensionHelper::LoadExternalExtension` 搜索 `extension_directories` 下的 `.duckdb_extension` 文件，`ParseExtensionMetaData` 解析文件尾部元数据，`CheckExtensionSignature` 用 MbedTLS 的 RSA-SHA256 验证签名。验证通过后 `dlopen` 动态加载，根据 ABI 类型分派：C++ ABI 通过 `dlsym` 查找 `*_duckdb_cpp_init` 符号，创建 `ExtensionLoader` 让扩展调用 `RegisterFunction` 等方法向 catalog 注册；C ABI 查找 `*_init_c_api` 符号，扩展通过 `duckdb_ext_api_v1` 函数指针表调用 DuckDB。加载完成后 `ExtensionManager` 标记 `is_loaded = true`。

### 状态流

DuckDB 有两个关键的状态机：Pipeline 5-Event 状态机和事务提交状态机。

**Pipeline Event 状态机**：每个 Pipeline 的生命周期被建模为 5 个 Event 组成的 DAG——`PipelineInitializeEvent → PipelineEvent → PipelinePrepareFinishEvent → PipelineFinishEvent → PipelineCompleteEvent`。Event 之间通过 `finished_dependencies` 原子计数器推进，当所有依赖完成时自动触发 `Schedule()`。`PipelineEvent` 阶段多线程执行 morsel，`PipelineFinishEvent` 阶段单线程收尾。Join build pipeline 的 `PipelineCompleteEvent` 完成后，probe pipeline 的 `PipelineInitializeEvent` 才被触发——Event DAG 自然表达 Pipeline 间依赖。

**事务状态机**：`DuckTransaction` 经历 `Active → Committing → Committed → Cleanup` 四个状态。`Active` 状态下执行读写操作，旧值写入 `UndoBuffer`；`Committing` 状态先写 WAL 再 `UndoBuffer::Commit`；`Committed` 后进入 `recently_committed_transactions` 队列等待清理；当所有活跃事务的 `start_time > commit_id` 时，`Cleanup` 清理 undo buffer。`Rollback` 则 `UndoBuffer::Rollback` 逆序恢复旧值。

---

## 典型修改场景

#### 场景 1：新增一个标量函数

1. 定义函数 struct：`src/include/duckdb/function/scalar/xxx.hpp` — 含 `static ScalarFunction GetFunction()`
2. 实现函数逻辑：`src/function/scalar/xxx.cpp` — 实现 `scalar_function_t` 或用模板 `ScalarFunction::UnaryFunction<TA,TR,OP>`
3. 注册到函数列表：`src/function/function_list.cpp` — 添加 `DUCKDB_SCALAR_FUNCTION(XxxFun)` 宏
4. 更新 CMakeLists：`src/function/scalar/CMakeLists.txt` — 添加新 `.cpp` 文件

对应测试：`test/sql/scalar/` 下的 `.test` 文件。

#### 场景 2：新增一种物理算子

1. 新建头文件：`src/include/duckdb/execution/operator/xxx/physical_xxx.hpp` — 继承 `PhysicalOperator` 或 `CachingPhysicalOperator`
2. 新建实现：`src/execution/operator/xxx/physical_xxx.cpp` — 实现 `Execute`/`GetData`/`Sink`
3. 物理计划生成：`src/execution/physical_plan/plan_xxx.cpp` — 实现 `CreatePlan(LogicalXxx&)`
4. 分派入口：`src/execution/physical_plan_generator.cpp:70` — switch 中添加 case
5. 枚举注册：`src/common/enums/physical_operator_type.hpp` — 添加类型

对应测试：`test/sql/` 下相关功能测试目录。

#### 场景 3：新增一种压缩算法

1. 新建实现：`src/storage/compression/new_algo.cpp` — 实现 `CompressionFunction` 的全部函数指针（`init_analyze`/`analyze`/`finalize_analyze`/`init_scan`/`scan_vector`/`append`/`finalize_append`...）
2. 注册压缩函数：`src/storage/compression/compression_function.cpp` — 注册到 `CompressionFunctionSet`
3. 枚举注册：`src/include/duckdb/common/enums/compression_type.hpp` — 添加 `CompressionType`

对应测试：`test/sql/storage/compression/` 下的压缩测试。`ColumnSegment` 无需修改——通过函数指针表间接调用。

---

## 测试体系

DuckDB 的测试体系以 SQL 逻辑测试为主，辅以 C++ 单元测试和 API 测试：

```
test/
├── sql/               # SQL 逻辑测试（70+ 子目录，每个 .test 文件含 SQL + 预期输出）
│   ├── aggregate/     # 聚合函数测试
│   ├── join/          # JOIN 测试
│   ├── window/        # 窗口函数测试
│   ├── parallelism/   # 并行执行测试
│   └── ...
├── api/               # C/C++ API 测试
├── arrow/             # Arrow 集成测试
├── optimizer/         # 优化器测试
├── storage/           # 存储测试
├── extension/         # 扩展测试
├── parquet/           # Parquet 读写测试
├── persistence/       # 持久化/WAL/Checkpoint 测试
├── secrets/           # Secret 管理测试
├── fuzzer/            # 模糊测试
└── unittest.cpp       # 测试主入口
```

| 代码层 | 测试类型 | 测试目录 |
| --- | --- | --- |
| Parser/Planner | SQL 逻辑测试 | `test/sql/` 各功能子目录 |
| Optimizer | 优化器专项测试 | `test/optimizer/` |
| Execution | SQL + 并行测试 | `test/sql/parallelism/` |
| Storage | 存储持久化测试 | `test/storage/`、`test/persistence/` |
| Function | 函数专项测试 | `test/sql/` 对应功能子目录 |
| C API | API 测试 | `test/api/` |

SQL 逻辑测试格式：每行一条 SQL 语句，后跟 `----` 分隔符和预期输出（mode: `raw`/`column_names`/`value`）。这是 DuckDB 最主要的测试方式，测试文件本身就是可执行文档。

---

## 阅读源码推荐路线

- **第一遍：理解查询主流程**
  `src/main/connection.cpp` 的 `Connection::Query()` → `src/main/client_context.cpp` 的 `ClientContext::Query()` 和 `CreatePreparedStatementInternal()`（看 Planner→Optimizer→PhysicalPlanGenerator 的协调）→ `src/parallel/pipeline_executor.cpp` 的 `PipelineExecutor::Execute()`（看 Pull-Push 执行循环）

- **第二遍：理解向量化数据结构**
  `src/include/duckdb/common/types/vector.hpp` 的 `Vector` 类和 5 种布局辅助 struct（`FlatVector`/`ConstantVector`/`DictionaryVector`）→ `src/include/duckdb/common/types/data_chunk.hpp` 的 `DataChunk` → `src/common/types/vector.cpp` 的 `ToUnifiedFormat()`（看统一读取抽象）

- **第三遍：理解执行与并行**
  `src/execution/physical_plan_generator.cpp` 的 `CreatePlan()` switch 分派 → `src/execution/physical_operator.hpp` 的 Source/Operator/Sink 接口 → `src/parallel/executor.cpp` 的 `SchedulePipeline()` 和 5-Event 链 → `src/parallel/pipeline.cpp` 的 `ScheduleParallel()` 和 `LaunchScanTasks()`

- **第四遍：理解存储引擎**
  `src/storage/data_table.cpp` 的 `Append()`/`Scan()` → `src/storage/table/column_data.cpp` 的 `ColumnData::Append`/`ScanVector` → `src/storage/table/column_segment.cpp` 的 `ColumnSegment::Append`/`Scan`（看 CompressionFunction 间接调用）→ `src/transaction/duck_transaction_manager.cpp` 的 `CommitTransaction`（看 WAL+UndoBuffer 提交路径）

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| Vectorized Execution | 向量化执行，每次处理一个 DataChunk（2048 行）而非逐行，减少虚调用开销 |
| DataChunk | 列批处理容器，持有 `vector<Vector>`，是执行引擎的基本数据单元 |
| Morsel-Driven | 按数据批（morsel）分配线程的并行模型，无需预分区，自然工作窃取 |
| STANDARD_VECTOR_SIZE | 向量化批大小，默认 2048（2 的幂，16KB 刚好在 L1 cache 内） |
| UnifiedVectorFormat | 统一读取格式，将 5 种 Vector 布局零拷贝统一为 `data[sel[i]]` 访问 |
| UndoBuffer | MVCC 版本存储，记录旧值而非复制新版本，减少写放大 |
| RowGroup | 行组，默认 122880 行（60 个 vector），Checkpoint 和统计的基本单元 |
| libpg_query | PostgreSQL parser 的独立编译版本，DuckDB 复用其词法/语法分析 |
| Extension | `.duckdb_extension` 动态库，通过 C ABI 或 C++ ABI 注册函数/类型 |
| PendingQuery | 异步查询句柄，分离查询准备与执行，支持进度报告和中断 |

### 参考资料

- [DuckDB 官方文档](https://duckdb.org/docs/stable/)
- DuckDB: an embeddable SQL OLAP database system (Raasveldt & Müller, SIGMOD 2019 Demo)
- [Dphyp Join Order 算法](https://15721.courses.cs.cmu.edu/spring2019/papers/16-optimizer2/p209-moerkotte.pdf)（Moerkotte & Neumann, "Dynamic Programming Strikes Back"）
- [Morsel-Driven Parallelism](https://db.in.tum.de/~leis/papers/morsels.pdf)（Leis et al., SIGMOD 2014）
