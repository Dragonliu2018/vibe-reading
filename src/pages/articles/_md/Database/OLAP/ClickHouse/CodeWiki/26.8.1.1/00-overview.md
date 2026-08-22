---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "Overview"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "C++", "OLAP", "列式存储", "向量化执行", "MergeTree"]
description: "ClickHouse 26.8.1.1——开源列式 OLAP 数据库，拉模型执行流水线 + MergeTree 存储 + MVCC + Morsel 并行 + 工厂扩展源码解读。"
readingTime: "90 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 26.8.1.1 · **协议** Apache-2.0 · **C++** 20 · **代码量** ~206 万行（src/）· **仓库** [GitHub](https://github.com/ClickHouse/ClickHouse)

---

## 总览

### 项目简介

ClickHouse 是一个**开源列式数据库管理系统（column-oriented DBMS）**，专为实时生成分析数据报告而设计。它不是某个单独组件，而是一个**完整的 OLAP DBMS**——从 SQL 解析、查询优化、向量化执行到列式存储，全部自研。其核心价值在于：在单机或集群上对海量数据（十亿百亿行级）做极速扫描与聚合，典型查询延迟在毫秒到秒级。

ClickHouse 解决的核心问题是：**以列式存储 + 向量化执行 + 拉模型流水线，把 OLAP 查询的扫描-聚合吞吐推到极致**。它面向批量扫描而非点查，面向读多写少而非事务。核心使用场景：实时分析看板、日志与事件分析、用户行为漏斗、广告/营销归因、时序与可观测性指标聚合、AI 特征存储。

**项目边界**：ClickHouse 负责 OLAP 查询执行与列式存储，**不**是面向高并发事务的 OLTP 引擎（单行事务与高频更新非其强项，mutation 是异步批量改写），**不**追求严格 ACID（提供有限事务语义）。但通过 MergeTree 家族、副本、分片、Keeper 协调，它覆盖了分布式 OLAP 从存储到查询到协调的完整栈。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 单二进制多路复用 | `programs/main.cpp` | 一个 `clickhouse` 二进制分发 30+ 子命令（server/client/local/keeper…） |
| 多协议接入 | `src/Server/` | HTTP / 原生 TCP / MySQL / PostgreSQL / gRPC / Interserver 同时监听 |
| SQL 解析 | `src/Parsers/` | 手写递归下降，SQL → AST，零拷贝 Token |
| 查询分析 | `src/Analyzer/` | AST → QueryTree，名称解析/类型推导/常量折叠，37 个 Pass |
| 查询计划 | `src/Planner/` + `src/Processors/QueryPlan/` | QueryTree → QueryPlan（step 树），18+ 优化 pass |
| 拉模型执行 | `src/Processors/` + `src/QueryPipeline/` | IProcessor DAG，pull-based + work stealing + 异步 I/O |
| 列式数据模型 | `src/Core/` + `src/Columns/` + `src/DataTypes/` | Block/IColumn/IDataType，COW 列、Field tagged union |
| MergeTree 存储 | `src/Storages/MergeTree/` | 不可变 data part + 后台 merge + mutation + granule 索引 |
| 副本与分片 | `src/Storages/StorageReplicatedMergeTree.h` | ZooKeeper/Keeper 日志队列协调副本，分片表 |
| 函数系统 | `src/Functions/` + `src/AggregateFunctions/` | 工厂+注册器，1000+ 标量函数，CRTP 去虚化聚合 |
| 压缩 | `src/Compression/` | 按 block 压缩，LZ4/ZSTD/Gorilla/Delta，栈式 buffer |
| 磁盘抽象 | `src/Disks/` + `src/IO/` | IDisk 统一本地/S3/HDFS，栈式 ReadBuffer/WriteBuffer |
| RBAC | `src/Access/` | 用户/角色/权限/配额/行策略，256-bit bitmap + Radix Tree |
| 协调服务 | `src/Coordination/` | ClickHouse Keeper，Raft，ZooKeeper 兼容协议 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++ 20 | 核心 | 主语言，重度模板与 CRTP 去虚化 |
| Poco::Net | 核心 | 网络服务器框架（TCPServer/HTTPServer） |
| boost | 核心 | 多盘容器、intrusive_ptr、noncopyable |
| LLVM/OpenSSL/mimalloc | 核心 | JIT（可选）、加密、内存分配 |
| ZooKeeper 协议 / NuRaft | 核心 | 副本协调与 Keeper Raft |
| Arrow / Parquet | 可选 | 列式互操作与格式 |
| AWS SDK / Azure SDK | 可选 | S3/Azure 对象存储后端 |

### 版本历史

ClickHouse 采用 YY.M 月度发布（如 26.8 = 2026 年 8 月）。关键演进：早期直接在 AST 上做查询计划；2022 年起引入**新的 Analyzer/Planner** 子系统，以 QueryTree 作为类型化中间表示逐步替代旧路径，提升优化能力与正确性；执行引擎从早期的线性 pipeline 演进为**任意 DAG 的拉模型**（IProcessor），支持多输入多输出 processor 与异步 I/O。26.8.1.1 是本文解读基线。

## 快速上手

```bash
# 最简启动（单二进制）
clickhouse server                  # 默认监听 8123(HTTP) / 9000(TCP)
# 验证
clickhouse client --query "SELECT 1"        # → 1
clickhouse client --query "SELECT version()" # → 26.8.1.1
```

本地构建（开发者视角）：

```bash
git clone https://github.com/ClickHouse/ClickHouse && cd ClickHouse
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j$(nproc) --target clickhouse-server  # 耗时较长，全量编译
```

## 架构设计解析

### 系统架构

ClickHouse 的整体设计思想是**"垂直分层 + 拉模型流水线 + 不可变列式存储"**。查询自上而下穿过网络层、查询流水线层、执行引擎层，抵达数据模型与存储层；数据再自下而上回流为结果集。各层职责清晰、依赖单向，便于独立演进。

![ClickHouse 分层架构](/vibe-reading/images/articles/clickhouse-internals/architecture.svg)

系统分六层。**网络协议层**用工厂+适配器统一管理 HTTP/TCP/MySQL/PostgreSQL/gRPC 等协议，最终都汇聚到 `executeQuery()` 单一入口。**查询流水线层**是 SQL 的四阶段处理：Parsers 解析、Analyzer 语义分析、Planner 生成计划、Interpreters 编排。**执行引擎层**是 ClickHouse 的核心创新——IProcessor 组成的 DAG，以拉模型驱动数据流，天然背压、支持异步 I/O 与 work stealing 并行。**数据模型层**提供 Block/IColumn/IDataType 的列式抽象与函数工厂。**存储引擎层**以 MergeTree 为核心，不可变 data part + 后台 merge。**基础设施层**含异常、访问控制与 Keeper 协调。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 网络协议层 | `src/Server/` + `programs/server/` | 隔离外部协议，多协议汇聚到单一执行引擎入口 |
| 查询流水线层 | `src/Parsers/` `src/Analyzer/` `src/Planner/` `src/Interpreters/` | SQL 文本到可执行计划的逐级变换与编排 |
| 执行引擎层 | `src/Processors/` `src/QueryPipeline/` | 拉模型 DAG 调度，背压、并行、异步 I/O |
| 数据模型层 | `src/Core/` `src/Columns/` `src/DataTypes/` `src/Functions/` | 列式内存表示与计算的统一抽象 |
| 存储引擎层 | `src/Storages/` `src/IO/` `src/Disks/` `src/Compression/` | 不可变 part 存储、合并、压缩与磁盘抽象 |
| 基础设施层 | `src/Common/` `src/Access/` `src/Coordination/` | 异常、内存、RBAC、分布式协调 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Context` in `src/Interpreters/Context.h` | 数百服务需全局访问，调用链极深，避免依赖参数爆炸 |
| 工厂+注册器 | `FunctionFactory` / `DataTypeFactory` / `InterpreterFactory` | 1000+ 函数/类型按名 O(1) 查找，编译隔离、易扩展 |
| 拉模型管道 | `IProcessor` in `src/Processors/IProcessor.h` | 消费者驱动生产，天然背压，work() 可并行 |
| COW（写时复制） | `COW<IColumn>` in `src/Common/COW.h` | 列共享不可变，改写时才 clone，零拷贝切片 |
| CRTP 去虚化 | `IAggregateFunctionHelper<Derived>` | 热路径 addBatch 编译期消虚函数，向量化 |
| pimpl | `ContextSharedPart` in `Context.cpp` | 隔离 1127+ includer 的编译依赖 |
| 栈式装饰器 | `CompressedReadBuffer` 包 `ReadBuffer` | I/O 多层变换（解压/解密/缓冲）可任意组合 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Block` | 列批次（列名+类型+列），数据处理基本单元 | 查询内流转 | 持有 `ColumnWithTypeAndName` 列表 |
| `IColumn` | 列抽象（COW 不可变） | Block 内 | 被 `IDataType::createColumn()` 创建 |
| `Context` | 服务定位器，持有全局状态 | global/session/query 三层 | 通过 `shared` 指向 `ContextSharedPart` |
| `IProcessor` | 执行流水线节点 + Status 状态机 | 单次查询 | 通过 `Port` 与上下游连接 |
| `MergeTreeData` | MergeTree 表数据 | 表级 | 持有不可变 `IMergeTreeDataPart` 集合 |
| `IAccessEntity` | 访问实体（User/Role/Quota） | 持久化 | 存于 `IAccessStorage`（磁盘/ZK） |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `IStorage` | `src/Storages/IStorage.h` | `StorageMergeTree`/`StorageReplicatedMergeTree`/系统表 | `registerStorages()` |
| `IFunction`/`IFunctionOverloadResolver` | `src/Functions/IFunction.h` | 1000+ 标量函数 | `REGISTER_FUNCTION` 宏自注册 |
| `IAggregateFunction` | `src/AggregateFunctions/IAggregateFunction.h` | sum/count/quantile… | `registerAggregateFunctions()` |
| `IDataType` | `src/DataTypes/IDataType.h` | String/Int64/Array… | `DataTypeFactory` 构造时注册 |
| `IQueryPlanStep` | `src/Processors/QueryPlan/IQueryPlanStep.h` | 70+ plan step | `updatePipeline()` 转换为 processor |
| `IInterpreter` | `src/Interpreters/IInterpreter.h` | 50+ Interpreter | `InterpreterFactory::get()` |

## 代码目录

```
ClickHouse/
├── programs/        # 可执行入口（main.cpp 多路复用、server/client/keeper）
├── src/
│   ├── Server/      # 网络协议处理（HTTP/TCP/MySQL/PostgreSQL/gRPC handler）
│   ├── Parsers/     # SQL 解析（Lexer + 递归下降 + AST）
│   ├── Analyzer/    # 查询分析（AST → QueryTree，37 Pass）
│   ├── Planner/     # 查询计划（QueryTree → QueryPlan step 树）
│   ├── Interpreters/# 编排与 Context（executeQuery 全流程入口）
│   ├── Processors/  # 执行引擎（IProcessor DAG + PipelineExecutor 调度）
│   ├── QueryPipeline/ # 流水线封装（Pipe/Builder/QueryPipeline）
│   ├── Core/        # Block/Field/Settings/Chunk 基础类型
│   ├── Columns/     # IColumn 列实现（COW）
│   ├── DataTypes/   # IDataType + DataTypeFactory
│   ├── Functions/   # 标量函数工厂（1000+）
│   ├── AggregateFunctions/ # 聚合函数（CRTP 去虚化）
│   ├── Storages/    # 表引擎（MergeTree 家族、系统表）
│   ├── IO/          # ReadBuffer/WriteBuffer 栈式 I/O
│   ├── Disks/       # IDisk 磁盘抽象（本地/S3/HDFS）
│   ├── Compression/ # 压缩编解码（LZ4/ZSTD/Gorilla）
│   ├── Access/      # RBAC（User/Role/Quota/RowPolicy）
│   ├── Coordination/# Keeper（Raft，ZooKeeper 兼容）
│   ├── Common/      # 通用工具（Exception/Arena/COW/ThreadPool）
│   └── ...          # Backups/Dictionaries/Formats/TableFunctions 等
├── contrib/         # 第三方库（boost/arrow/aws/capnproto…）
├── tests/           # 集成/单元/状态less 测试
└── cmake/ docker/   # 构建与打包
```

## 模块地图

ClickHouse 的模块按查询处理流水线与存储栈组织。模块间依赖单向（上层依赖下层），Context 作为中央服务定位器贯穿全局。

![ClickHouse 模块依赖关系](/vibe-reading/images/articles/clickhouse-internals/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 服务端入口与进程模型 | 单二进制多路复用 + 多协议监听 | `main()` in `programs/main.cpp` | 是系统对外唯一边界，协议层独立于查询引擎 | [01-server-process](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/01-server-process) |
| 列式数据模型 | Block/IColumn/IDataType 抽象 | `Block` in `src/Core/Block.h` | 是所有数据处理的基础单元，独立于存储与执行 | [02-columnar-data-model](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/02-columnar-data-model) |
| SQL 解析器 | SQL 文本 → AST | `parseQuery()` in `src/Parsers/parseQuery.h` | 解析与语义分离，纯结构映射无副作用 | [03-sql-parser](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/03-sql-parser) |
| 查询分析器 | AST → QueryTree | `QueryAnalyzer` in `src/Analyzer/` | 类型化中间表示，承载语义分析与优化 pass | [04-query-analyzer](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/04-query-analyzer) |
| 查询计划器 | QueryTree → QueryPlan | `Planner` in `src/Planner/Planner.h` | 计划生成与优化独立于分析，step 树支持 DAG | [05-query-planner](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/05-query-planner) |
| 执行流水线 | IProcessor DAG 调度 | `PipelineExecutor` in `src/Processors/Executors/` | 拉模型执行是核心创新，独立于计划表示 | [06-execution-pipeline](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/06-execution-pipeline) |
| 解释器与上下文 | 查询全流程编排 + 服务定位器 | `executeQuery()` in `src/Interpreters/executeQuery.h` | Context 贯穿全局，executeQuery 串联各阶段 | [07-interpreters-context](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/07-interpreters-context) |
| MergeTree 存储引擎 | 不可变 part + 合并 + 副本 | `MergeTreeData` in `src/Storages/MergeTree/MergeTreeData.h` | 存储引擎独立于查询，IStorage 接口解耦 | [08-mergetree-storage](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/08-mergetree-storage) |
| 函数与聚合工厂 | 标量/聚合函数库 | `FunctionFactory` in `src/Functions/FunctionFactory.h` | 工厂+注册器统一扩展点，1000+ 函数架构一致 | [09-functions-factory](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/09-functions-factory) |
| I/O、磁盘与压缩 | 存储栈式 I/O + 磁盘抽象 | `ReadBuffer` in `src/IO/ReadBuffer.h` | I/O 层栈式组合独立于存储引擎 | [10-io-disks-compression](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/10-io-disks-compression) |
| 访问控制 | RBAC + 行策略 + 配额 | `AccessControl` in `src/Access/AccessControl.h` | 访问控制是横切关注点，贯穿认证到查询 | [11-access-control](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/11-access-control) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。Coordination（Keeper）作为独立协调服务在 `programs/keeper` 启动，本文不单独成篇。

## 运行时行为

### 启动流程

服务端启动从单一 `clickhouse` 二进制进入，分发到 server 子命令后完成对象装配：

```text
main() in programs/main.cpp
└─ 遍历 clickhouse_applications[] 分发表，匹配 "server"
   └─ mainEntryClickHouseServer() in programs/server/clickhouse-server.cpp
      └─ Server app; app.run(argc, argv)            # Poco 框架入口
         └─ Server::main() in programs/server/Server.cpp:1211
            ├─ registerInterpreters/registerFunctions/registerStorages/...  # 14 个 register 调用，装配所有工厂
            ├─ Context::createShared() + Context::createGlobal()            # 创建全局 Context + ContextSharedPart 单例
            ├─ GlobalThreadPool + IOThreadPool + 专用线程池                   # 装配线程池
            ├─ Poco::ThreadPool server_pool(min=3, max=max_connections)     # 连接处理线程池
            ├─ createServers()                                              # 装配 HTTP/TCP/MySQL/... 监听
            │  └─ 按 ServerType 创建 ProtocolServerAdapter（工厂+适配器）
            └─ server_pool.joinAll()                                       # 阻塞接收连接
```

对象装配要点：**配置**来自 `config.xml`（Poco LayeredConfiguration），覆盖优先级为命令行 > 配置文件 > 默认；**Context** 是 `shared_ptr` + pimpl，`ContextSharedPart` 全局唯一（构造函数 `num_calls` 计数防多例），session/query Context 通过 `createCopy()` 派生共享同一 `shared`；**工厂注册**在 `registerInterpreters()` 等集中调用，每个工厂是单例（`instance()` 返回函数内 static 变量）；**线程池**两级——`server_pool` 处理连接，`GlobalThreadPool` 做查询内并行执行。

### 核心运行流程

ClickHouse 运行时有三条最重要的业务链路：查询执行、数据写入与合并、副本同步。下面分别展开。

#### 查询执行：SELECT 端到端

业务流程：客户端发送 SQL → 协议层接收认证 → executeQuery 串联解析-分析-计划-执行 → 拉模型流水线产出 Block 流 → 回送结果。

![ClickHouse SELECT 查询端到端数据流](/vibe-reading/images/articles/clickhouse-internals/data-flow.svg)

文字描述：`HTTPHandler::handleRequest` / `TCPHandler::run` 完成认证与上下文创建后，调用 `executeQuery()`。`executeQueryImpl` 先用 `parseQuery` 把 SQL 文本经 Lexer + ParserQuery 递归下降生成 `ASTPtr`；再做 AST 预处理（参数替换、WITH 传播）；注册到 `ProcessList` 获取 `QueryStatus`（用于取消与限流）；`InterpreterFactory::get` 按 AST 类型分发到具体 Interpreter（如 `InterpreterSelectQueryAnalyzer`）；Interpreter 调 `Planner::buildQueryPlanIfNeeded` 把 QueryTree 转 `QueryPlan`（step 树 + 优化），再 `buildQueryPipeline` 后序遍历 step 树生成 `QueryPipelineBuilder`，`execute()` 产出 `PipelineExecutor`；`CompletedPipelineExecutor` 或 `PullingAsyncPipelineExecutor` 驱动拉模型 DAG，work stealing 多线程并行，异步 I/O 走 epoll；产出的 `Block` 流经输出格式（Native/JSON/CSV）回送客户端。关键设计：拉模型让背压天然成立，`Status` 状态机避免忙等，`QueryStatus` 支持随时 `KILL`。

#### 数据写入：INSERT

写入路径与查询分离。`TCPHandler::processInsertQuery` 接收数据块，`InterpreterInsertQuery` 解析目标表，通过 `IStorage::write` 调用 `MergeTreeData` 的写入链：数据按 granule 组织列式编码，经 `CompressionCodec` 按块压缩，落盘为新的不可变 `IMergeTreeDataPart`（原子性提交）。异步 INSERT 队列（`AsynchronousInsertQueue`）可聚合小写入。`ReplicatedMergeTree` 额外把 part 元数据写入 ZooKeeper 队列，由副本拉取。

#### 后台合并：Merge

MergeTree 的核心机制是后台合并。`MergeTreeDataMergerMutator` 周期性选择若干小 `data part`，按列式合并生成新 part，替换旧 part（原子切换）。mutation（`ALTER UPDATE/DELETE`）同样以生成新 part 实现，不就地改写。`ReplicatedMergeTree` 的 merge 任务通过 ZooKeeper 日志队列协调，保证所有副本 merge 出 byte-identical 的结果。详见 [MergeTree 存储引擎](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/08-mergetree-storage)。

### 状态流

IProcessor 的执行由一个状态机驱动。调度器反复调用 `prepare()`（轻量、不阻塞）判断状态，仅在 `Ready` 时调 `work()`（CPU 密集），`Async` 时调 `schedule()`（I/O 等待）。

![IProcessor 状态机与调度流转](/vibe-reading/images/articles/clickhouse-internals/state-flow.svg)

相关代码：状态枚举 `IProcessor::Status` 定义于 `src/Processors/IProcessor.h`；状态转换在 `ExecutingGraph::updateNode`（`src/Processors/Executors/ExecutingGraph.cpp`）中根据 `prepare()` 返回值驱动；端口版本号 `Port::UpdateInfo`（`src/Processors/Port.h`）让相邻 processor 感知变化、避免忙等；线程空队列时在 `ExecutionThreadContext::wait` 的 condition variable 上阻塞。

## 典型修改场景

#### 场景 1：新增一个标量函数

新增 `myfunc(x)`：新建 `src/Functions/myfunc.cpp`，实现 `IFunction` 子类或复用 `FunctionUnaryArithmetic<Op,Name>` 模板，用 `REGISTER_FUNCTION(MyFunc)` 宏自注册到 `FunctionFactory`。无需改中心文件。详见 [函数与聚合工厂](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/09-functions-factory)。

#### 场景 2：新增一种 plan step

新建 `src/Processors/QueryPlan/MyStep.h` 继承 `ITransformingStep`，实现 `updatePipeline` 创建对应 processor；在 `Planner.cpp` 的 `buildPlanForQueryNode` 适当位置 `addStep`。优化器可感知则注册到 `getOptimizations()` 数组。详见 [查询计划器](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/05-query-planner)。

#### 场景 3：新增一种数据类型

新建 `src/DataTypes/DataTypeMy.h` + `src/Columns/ColumnMy.h`，实现 `IDataType`/`IColumn` 接口，在 `DataTypeFactory` 构造函数中 `registerDataTypeMy`。详见 [列式数据模型](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/02-columnar-data-model)。

## 测试体系

ClickHouse 测试体系庞大，主要在 `tests/` 目录：

```
tests/
├── integration/    # Python 驱动的端到端集群测试
├── performance/    # 性能基准
├── queries/        # SQL 功能测试（0_stateless/1_stateless...）
└── unittest/       # gtest 单元测试（src/* 下的 gtest_*.cpp）
```

| 代码层 | 测试类型 | 说明 |
| --- | --- | --- |
| `src/*/gtest_*.cpp` | gtest 单元测试 | 与源码同目录，如 `src/Processors/Executors/gtest_*` |
| `tests/queries/` | stateless SQL 功能 | 覆盖 SQL 语义与回归 |
| `tests/integration/` | 端到端集成 | Python + Docker 多节点集群 |

理解某模块时优先读对应的 `gtest_*.cpp`——它们是"可执行文档"，`PipelineExecutor`、`Aggregator`、`MergeTreeData` 都有详尽的 gtest。

## 阅读源码推荐路线

- 第一遍：理解主流程
  `programs/main.cpp` 的 `clickhouse_applications[]` → `programs/server/Server.cpp` 的 `Server::main()` → `src/Interpreters/executeQuery.cpp` 的 `executeQueryImpl` → `src/Interpreters/InterpreterFactory.cpp` 的 `get`
- 第二遍：理解拉模型执行引擎
  `src/Processors/IProcessor.h` 的 `Status` 与 `prepare/work` → `src/Processors/Port.h` 的无锁 push/pull → `src/Processors/Executors/ExecutingGraph.cpp` 的 `updateNode` → `src/Processors/Executors/PipelineExecutor.cpp` 的 `executeImpl`
- 第三遍：理解列式数据模型
  `src/Core/Block.h` → `src/Columns/IColumn.h` 的 COW → `src/Core/Field.h` 的 tagged union → `src/DataTypes/IDataType.h` 与 `DataTypeFactory.cpp`
- 第四遍：选择存储或查询子模块深入（各模块文档）
  MergeTree 读 `MergeTreeData.h` + `MergeTreeDataMergerMutator.h`；解析读 `Parsers/IParserBase.h` + `parseQuery.cpp`；函数读 `Functions/IFunction.h` + `FunctionFactory.cpp`

## 附录

- **术语表**：granule（颗粒，列式数据的最小索引单位，默认 8192 行）；data part（MergeTree 的不可变存储单元）；morsel（并行处理的数据块）；QueryTree（类型化查询中间表示）；Keeper（ClickHouse 自研的 ZooKeeper 兼容协调服务）
- **参考资料**：[ClickHouse 官方文档](https://clickhouse.com/docs) · [ClickHouse Theater 演讲](https://presentations.clickhouse.com/) · 拉模型执行引擎设计见 `src/Processors/IProcessor.h` 注释
- **工具推荐**：`clickhouse-local` 做离线分析；`EXPLAIN` 查看 QueryPlan；`clickhouse-client --time` 测延迟；`system.trace_log` 与 `system.query_log` 做性能分析
