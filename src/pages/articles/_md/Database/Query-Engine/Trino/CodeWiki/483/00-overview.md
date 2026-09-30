---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "Overview"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "Java", "分布式查询引擎", "SQL", "Connector"]
description: "Trino 483 源码解读概览：分布式 SQL 查询引擎的分层架构、模块地图与查询全链路"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** 483 · **协议** Apache-2.0 · **语言** Java 25 · **代码量** ~1,925,000 行 Java（11,133 文件）· **仓库** [GitHub](https://github.com/trinodb/trino)

---

## 总览

### 项目简介

Trino 是一款**快分布式 SQL 查询引擎**（"Trino is a fast distributed SQL query engine for big data analytics"——README 第一句）。它诞生于 Facebook Presto（facebook-last tag 2019-01-20），2019 年社区分叉为 PrestoSQL（prestosql-first），2021 年初更名 Trino（trino-first tag 2021-01-02），本文解读的 483 发布于 2026-07-18。

它解决的核心问题是：**对分散在多个数据源（Hive/Iceberg/MySQL/Kafka…）上的大数据做交互式联邦查询**。传统做法要么把数据搬到单一数仓（ETL 搬运成本），要么在存储引擎上直接执行（每个引擎各造一遍 SQL 层）。Trino 的选择是第三条路——把 SQL 执行引擎从存储中完全剥离，通过 Connector SPI 接入任意数据源，查询下推到数据所在处执行。

核心价值与使用场景：

- **联邦查询**：一条 SQL JOIN 跨 Hive 与 MySQL 的表，Trino 统一规划、分布式执行；
- **交互式分析**：pipelined 执行 + 内存计算 + 代码生成，秒到分钟级响应 PB 级数据扫描；
- **存算分离引擎**：本身不存数据、不管理副本，只做"无状态计算层"，天然适配湖仓与多租户场景。

**项目边界**：Trino 负责解析/优化/调度/执行 SQL；不负责存储与事务持久化（数据归属连接器和底层系统）、不是带 ACID 保证的 OLTP 数据库（写路径主要为批量 insert/merge into）。

### 功能矩阵

| 特性 | 实现模块 | 说明 |
| --- | --- | --- |
| ANSI SQL 解析 | `core/trino-grammar` + `core/trino-parser` | ANTLR 4 语法 SqlBase.g4，SLL 快路径 + LL 兜底 |
| 语义分析（scope/类型/权限） | `trino-main/sql/analyzer` | StatementAnalyzer + ExpressionAnalyzer，产出 Analysis |
| 基于规则的优化 | `trino-main/sql/planner/iterative` | IterativeOptimizer + 232 个规则文件，Memo 到不动点 |
| 代价优化（CBO） | `trino-main/sql/planner` + `cost/` | StatsCalculator + CostProvider，join 重排/分布选择 |
| 分布式执行 | `trino-main/execution` + `scheduler/` | PlanFragmenter 切片 → PipelinedQueryScheduler 全 stage 并行 |
| 容错执行（FTE） | `scheduler/faulttolerant/` | EventDrivenFaultTolerantQueryScheduler，task 级重试 + 落盘 exchange |
| 执行代码生成 | `trino-main/sql/gen` | 表达式投影/join 哈希/排序比较器运行时编译为 JVM 字节码 |
| 连接器框架 | `core/trino-spi` + `plugin/`（61 个） | Plugin → ConnectorFactory → Connector 三级，独立 classloader |
| JDBC/CLI 客户端 | `client/trino-*` | JSON 轮询 wire protocol，spooling 大结果落对象存储 |
| 集群内存管理 | `trino-main/memory` | 三级记账 + revocable memory + spill + 可插拔 LowMemoryKiller |
| 资源组排队 | `execution/resourcegroups/` | 层级公平调度，WEIGHTED_FAIR 等四种策略 |
| 系统表/监控 | `connector/system` + Web UI | system.* 元数据表 + React UI（bun 构建） |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Java 25 | 核心 | 语言与运行时（含 incubator Vector API SIMD） |
| ANTLR 4 | 核心 | SQL 语法（SqlBase.g4 → Lexer/Parser 生成物） |
| Airlift 全家桶 | 核心 | bootstrap(DI)/http-server/http-client/json/slice/discovery/jmx——Trino 团队维护的服务器框架 |
| Guice | 核心 | 依赖注入装配（Server/Module 体系） |
| Guava | 核心 | 不可变集合、ListenableFuture（异步贯穿全引擎） |
| io.airlift:bytecode | 核心 | 字节码 DSL（ClassDefinition/MethodDefinition），运行时 JIT 用 |
| airlift slice + aircompressor | 核心 | 堆外二进制值容器 + Zstd/LZ4/Snappy 压缩 |
| Jackson | 核心 | JSON 序列化（wire protocol、PlanFragment 下发、HandleResolver） |
| Provisio | 构建 | 发行版打包（trino-server tar.gz：bin/lib/plugin/） |
| Bun + React | Web UI | 前端构建（frontend-maven-plugin 的 bun goal） |

### 版本历史

| 节点 | 时间 | 意义 |
| --- | --- | --- |
| facebook-last | 2019-01 | Facebook 内部 Presto 最后一版（0.215） |
| prestosql-first | 2019-01 | 社区分叉 PrestoSQL 起点 |
| trino-first | 2021-01 | PrestoSQL 更名 Trino（版本号重开） |
| 449 | ~2023 | 开始支持可复现构建（reproducible builds） |
| **483** | **2026-07-18** | 本文基线：master 主线最新 tag（HEAD 已再前进 577 commit） |

---

## 快速上手

开发者视角的最短路径（不部署集群、不装 Docker）：

```bash
git clone https://github.com/trinodb/trino.git && cd trino
./mvnw clean install -DskipTests    # 首次构建较久（依赖下载）
```

IDE 里跑一个内置 TPCH 的单进程开发服务器：

- Main Class：`io.trino.server.DevelopmentServer`
- VM Options：`-ea -Dconfig=etc/config.properties -Dlog.levels-file=etc/log.properties -Djdk.attach.allowAttachSelf=true --sun-misc-unsafe-memory-access=allow --add-modules jdk.incubator.vector`
- Working directory：`testing/trino-server-dev`

更轻的方式：直接跑 `TpchQueryRunner`（`core/trino-testing` 里）起一个内存中单节点实例。然后验证：

```bash
client/trino-cli/target/trino-cli-*-executable.jar
trino> SELECT * FROM system.runtime.nodes;   -- 能看到本节点
trino> SELECT * FROM tpch.tiny.region;       -- TPCH 数据可查 = 引擎跑通
```

---

## 架构设计解析

### 系统架构

Trino 的架构思想可以概括为一条主线：**计算与存储彻底解耦，SQL 引擎本身完全无状态**。集群里只有两种角色——coordinator（受理、规划、调度）与 worker（执行、产出页），**同一个二进制**用 `node.id` + `coordinator=true/false` 区分。数据永远不落在 Trino 自己手里：读来自 Connector 的 `ConnectorPageSource`，中间结果经 exchange 直连流转，最终结果以 JSON 流给客户端。这让"计算层"可以独立扩缩容、独立升级，也正是它能成为湖仓标准查询层的根本。

分层自上而下：

![Trino 分层架构](/vibe-reading/images/articles/trino-internals/architecture.svg)

- **客户端层**（trino-cli/jdbc/client）只持有会话状态，逐请求重放；
- **客户端协议层**：queued/executing 两个端点把"提交"与"取数"解耦——重查询拥塞取数线程时，新提交照常被受理；
- **查询前端层**（coordinator）：SQL → AST → Analysis → PlanFragment 树，优化器决定物理分布；
- **分布式调度层**（coordinator）：把 fragment 变成 worker 上的 task，split 陆续到达陆续调度；
- **执行引擎层**（worker）：PlanFragment → DriverFactory → Driver 拉模型流水线，表达式运行时编译为字节码；
- **SPI 与连接器层**：全部数据访问收敛到 `trino-spi` 一个合约模块，61 个插件在独立 classloader 里实现。

| 架构层 | 包含目录 | 层职责 |
| ---- | ---- | ---- |
| 客户端 | `client/trino-{cli,jdbc,client}` | 屏蔽轮询协议细节，向应用暴露 REPL/JDBC API |
| 协议 | `trino-main/server/protocol` + `dispatcher/` | 无状态 HTTP 语义，token 游标即会话凭据 |
| 前端 | `trino-grammar`/`trino-parser` + `sql/analyzer` + `sql/planner` | 把声明式 SQL 变成可分布执行的物理计划 |
| 调度 | `execution/scheduler` + `node/` + `remotetask/` | 全局视图下做数据本地性与负载均衡的折中 |
| 执行 | `execution/` + `operator/` + `sql/gen` + `memory/` | Page 级流水线处理 + 内存治理 |
| SPI/连接器 | `core/trino-spi` + `plugin/` + `lib/` | 版本化兼容合约，插件生态的根基 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| CAS 状态机模板 | `StateMachine` in `execution/StateMachine.java`；Query/Task/Stage/Node 四套 | HTTP 线程、调度线程、回调并发触发状态变更，CAS+listener 保证单次生效、无锁传播 |
| Visitor（双精度分派） | `AstVisitor` in `trino-parser`；`PlanVisitor` in `sql/planner/plan`；`LocalExecutionPlanner.Visitor` | 三棵树（AST/逻辑计划/物理计划）统一遍历协议，新节点类型自动获得全部既有访问者 |
| Pattern 匹配规则引擎 | `io.trino.matching.Pattern` in `lib/trino-matching`；`Rule` in `planner/iterative/Rule.java` | 规则声明"匹配什么形状"，引擎统一做候选索引/捕获/迭代——规则作者零遍历代码 |
| 三级工厂 | `Plugin`→`ConnectorFactory`→`Connector`（`trino-spi`） | 插件发现单元 / 每 connector 名一次 / 每 catalog 一实例，三个生命周期粒度各自独立 |
| 组合树记账 | `AggregatedMemoryContext` in `lib/trino-memory-context` | 算子→driver→task→query→池逐层汇总 O(1)，Top-Consumers 诊断免费获得 |
| 策略族 | `LowMemoryKiller` 4 实现、`NodeSelector` 2 实现、资源组 4 种队列 | OOM 杀谁/选哪个节点/怎么排队都是可插拔决策点 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Session` | 查询上下文（用户/事务/配置/路径） | 每查询 | 被 Analyzer/Planner/Operator 全程携带 |
| `Analysis` | 语义分析结果集（~70 个 NodeRef side-table） | 每查询 | Analyzer 产出 → LogicalPlanner 消费 |
| `PlanNode` 树 | 逻辑计划（48 种节点） | 每查询 | 优化器改写 → PlanFragmenter 切分 |
| `PlanFragment` | 可分布执行的切片（含分区方案） | 每查询 | 调度器按它建 stage/task，JSON 下发 worker |
| `Driver` | 一条算子流水线的运行时实例 | 每 task×pipeline×split | 持有 Operator 链，被 TaskExecutor 调度 |
| `Page` / `Block` | 列式批数据（行=position，列=channel） | 毫秒级 | 算子间流转的唯一数据单位 |
| `Split` | 数据分片（含位置提示与权重） | 每 source 表 | NodeScheduler 据此选节点 |
| `QueryContext` / `MemoryPool` | 每查询/每节点的内存账本 | 查询期/常驻 | OperatorContext 逐层上报 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Plugin` | `trino-spi/Plugin.java` | 61 个插件 | `plugin/` 目录扫描 + ServiceLoader |
| `Connector` | `trino-spi/connector/Connector.java` | 每连接器一个（含引擎内置 InformationSchema/System） | `ConnectorFactory.create()` |
| `ConnectorMetadata` | `trino-spi/connector`（156 方法全 default） | 各连接器 | `Connector.getMetadata()` |
| `Operator` | `operator/Operator.java` | 40+ 算子 + WorkProcessorOperator 适配 | `OperatorFactory` + LocalExecutionPlanner 映射 |
| `Rule<T>` | `planner/iterative/Rule.java` | 232 个规则文件 | `PlanOptimizers` 显式装配 |
| `DataDefinitionTask<T>` | `execution/DataDefinitionTask.java` | ~60 个 DDL Task | `QueryExecutionFactoryModule` MapBinder |
| `LowMemoryKiller` | `memory/LowMemoryKiller.java` | 4+1 实现 | `CoordinatorModule` 按 enum 绑定 |

---

## 代码目录

```shell
trino/
├── client/                  # 客户端三件套
│   ├── trino-client/        #   协议库（OkHttp，132 文件）
│   ├── trino-jdbc/          #   JDBC 驱动（57 文件）
│   └── trino-cli/           #   终端 REPL（50 文件，StatementSplitter 在这）
├── core/                    # 引擎本体
│   ├── trino-grammar/       #   ANTLR 语法（SqlBase.g4，新拆出）
│   ├── trino-parser/        #   parser + AST（381 文件）
│   ├── trino-spi/           #   连接器合约（650 文件，零引擎依赖）
│   ├── trino-main/          #   引擎核心（4131 文件 82 万行，所有模块的家）
│   ├── trino-server*/       #   装配与发行（TrinoServer main 入口）
│   └── trino-web-ui/        #   React UI（bun 构建）
├── lib/                     # 共享库（20 模块）
│   ├── trino-filesystem*/   #   文件系统抽象 + S3/GCS/Azure/HDFS 实现
│   ├── trino-parquet|orc/   #   列式格式读写（湖连接器共用）
│   ├── trino-metastore/     #   Hive Metastore 客户端（5 个湖连接器共用）
│   └── trino-matching/      #   规则引擎的 Pattern DSL
├── plugin/                  # 61 个插件（连接器/exchange/event-listener/…）
├── service/                 # trino-proxy、trino-verifier（周边服务）
├── testing/                 # 测试矩阵（product-tests/tests/benchmark…）
└── docs/                    # Sphinx 用户手册（trino.io/docs 源）
```

`trino-main` 内部按包切分：`sql/`（解析→规划 13.9 万行）、`operator/`（执行 12.4 万行）、`execution/`（生命周期+调度 5.7 万行）、`server/`（装配+REST 2.9 万行）、`metadata/`+`type/`（2.8 万行）——模块地图即按此展开。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/trino-internals/module-dependencies.svg)

模块间的依赖呈"沙漏"形：上面五分（前端链路各环节），中间一收（trino-spi），下面一展（连接器生态）。所有引擎模块只通过 SPI 触碰数据源；`MetadataManager`/`SplitManager`/`PageSourceManager` 是横跨沙漏腰身的三个桥。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| SQL 解析与分析 | SQL 文本 → AST → 语义完备的 Analysis | `SqlParser.createStatement()` / `Analyzer.analyze()` | 语法无状态可复用（view 递归分析）；parser 零引擎依赖可入插件 | [01](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/01-sql-parser-analyzer) |
| 查询规划与优化器 | Analysis → 优化后的 PlanFragment 树 | `LogicalPlanner.plan()` | 声明式转换与物理分布决策是两种演进节奏 | [02](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/02-planner-optimizer) |
| 查询与任务生命周期 | 状态机驱动的查询受理/驱动/task 管理 | `SqlQueryExecution.start()` | 生命周期是横切关注点，与"做什么计算"正交 | [03](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/03-query-lifecycle) |
| 分布式调度 | fragment→task、split→节点、远程同步 | `PipelinedQueryScheduler.start()` | 全局视图（节点/负载/拓扑）只有 coordinator 有 | [04](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/04-scheduler) |
| 执行计划落地与代码生成 | PlanFragment → DriverFactory + 字节码 | `LocalExecutionPlanner.plan()` | "翻译计划"与"执行计划"是 worker 上两个不同阶段 | [05](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/05-local-execution-gen) |
| 执行引擎 Operator | 拉模型流水线运行时 | `Driver.processForDuration()` | 算子组合爆炸，需统一契约与记账 | [06](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/06-operator-engine) |
| SPI 与连接器框架 | 插件合约 + 引擎侧组装 | `PluginManager.installPlugin()` | 兼容性合约必须独立演进（revapi 门禁） | [07](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/07-spi-connector-framework) |
| 元数据与类型系统 | 全集群元数据门面 + 函数/类型注册表 | `Metadata` 接口 / `FunctionResolver` | 引擎与 catalog 动态装卸解耦的支点 | [08](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/08-metadata-types) |
| 内存与资源管理 | 记账/杀查询/spill/资源组排队 | `MemoryPool.reserve()` | 资源治理是安全网，不能散进业务代码 | [09](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/09-memory-resource) |
| 客户端协议与驱动 | wire protocol 两端 | `ExecutingStatementResource` / `StatementClientV1` | 协议是跨版本兼容面，需独立演进 | [10](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/10-client-protocol) |
| 服务器装配与插件加载 | 进程启动/DI 装配/双角色分化 | `Server.doStart()` | 装配逻辑集中一处，coordinator/worker 差异配置化 | [11](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/11-server-bootstrap) |
| 连接器生态与存储格式库 | 61 插件 + 20 共享库 | `trino-example-http`（最小集） | 生态复用：parquet/orc/metastore 只写一份 | [12](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/12-connector-ecosystem) |

静态依赖看上图，**动态调用顺序见「运行时行为 > 核心运行流程」**——两者是同一系统的两个视角。

---

## 运行时行为

### 启动流程

```
TrinoServer.main (trino-server-main)
 └─ Server.doStart (trino-main/server/Server.java:80)
     ├─ Locale.setDefault(US) / verifySystemRequirements()
     ├─ modules: 19 个 Guice Module
     │   Airlift 基础（Node/HttpServer/Json/Jaxrs/Jmx/Tracing…）
     │   + Trini 领域（ServerSecurity/AccessControl/EventListener/
     │     Exchange/Catalog/Transaction/NodeManager/ServerMain/…）
     ├─ Bootstrap("io.trino.bootstrap.engine").loadSecretsPlugins().initialize()
     │   └─ ServerMainModule.setup (ServerMainModule.java:203)
     │       ├─ isCoordinator() → install(CoordinatorModule) else WorkerModule
     │       └─ 绑定 MetadataManager/QueryManager/SqlTaskManager/
     │          LocalExecutionPlanner/TaskExecutor/各 Manager…
     ├─ PluginInstaller.loadPlugins()            # plugin/ 目录扫描
     │   └─ ServerPluginsProvider → PluginClassLoader(parent=platform)
     │       → ServiceLoader.load(Plugin.class) → installPluginInternal
     ├─ CatalogStoreManager.loadConfiguredCatalogStore
     ├─ ConnectorServicesProvider.loadInitialCatalogs   # 逐 catalog 建 connector 树
     ├─ 各 Manager 依序 load（SessionPropertyDefaults → ResourceGroup
     │   → AccessControl → PasswordAuthenticator → GroupProvider → Exchange
     │   → Spooling → Certificate → Header …）
     ├─ [coordinator] EventListenerManager.loadEventListeners
     ├─ Announcer.start()                         # 默认 ANNOUNCE 模式：POST /v1/announce
     └─ StartupStatus.startupComplete             # ===== SERVER STARTED =====
```

对象装配的关键：**全部经 Guice**——配置用 `@Config` 绑定的 Config 类（如 `ServerConfig`），服务用 `@Inject` 构造器互相组装；coordinator/worker 分化在装配期决定（`ServerMainModule.setup` 的 if 分支），WorkerModule 用 NoOp 占位（NoOpSessionSupplier 等）保依赖图完整。插件发现是**目录扫描**（`plugin.dir` 下每个子目录的全部 jar），不再是 Maven 坐标解析。

### 核心运行流程

以下三条链路覆盖了 Trino 最核心的运行模式：查询主链路（coordinator+worker 全景）、worker 内数据流水线、以及出错与重试。每条都只列主干，细节见各模块文档。

#### 主链路：一条 SELECT 的端到端旅程

业务流程：客户端提交 SQL → 排队准入 → 解析分析 → 规划切片 → 分布式调度 → worker 执行 → 结果逐批回流。

![查询数据流](/vibe-reading/images/articles/trino-internals/data-flow.svg)

文字描述：`POST /v1/statement` 立即返回 queued URL（`QueuedStatementResource.postStatement`），客户端转去长轮询排队端点；`DispatchManager.createQueryInternal` 完成 session 解码、`QueryPreparer.prepareQuery` 解析出 Statement、资源组 `selectGroup` 准入后入队；被调度时经 `QueryManager.createQuery` 落到 `SqlQueryExecution`（**analyze 在构造器、plan 在 start()**）——`LogicalPlanner.plan` 产出 Plan，`PlanFragmenter.createSubPlans` 切成 SubPlan 树；`PipelinedQueryScheduler.start` 起调度循环，`SourcePartitionedScheduler` 逐批拉 split、`NodeSelector` 选点、`HttpRemoteTask` 把 `TaskUpdateRequest`（首包带全量 PlanFragment JSON，后续只发增量 split）POST 到 worker 的 `/v1/task`。数据类型一路上从 `String` → `Statement` → `Analysis` → `PlanNode` 树 → `PlanFragment` 树 → `TaskUpdateRequest JSON` → `LocalExecutionPlan` → `Page` 流 → `SerializedPage`（二进制 exchange）→ 最终 `QueryResults JSON` 回客户端。

#### worker 链路：从 TaskUpdateRequest 到输出页

`TaskResource.createOrUpdateTask` 收 POST → `SqlTaskManager.updateTask`（先建 QueryContext 内存限额，再 `outputBuffer.setOutputBuffers`——LazyOutputBuffer 必须先有配置——然后 `SqlTaskExecutionFactory.create`）→ `LocalExecutionPlanner.plan` 把 fragment 翻译成 DriverFactory 列表并 JIT 编译投影 → `SqlTaskExecution.addSplitAssignments` 按 `sourceStartOrder` 放行 source → `TaskExecutor.enqueueSplits` → `DriverSplitRunner` 以 1 秒时间片跑 `Driver.processForDuration`。算子链自根向叶两两推进（`current.getOutput() → next.addInput()`），源头 `TableScanOperator` 经 SPI 拿 `ConnectorPageSource.getNextSourcePage()`；终点 `PartitionedOutputOperator` 把 Page 序列化进 OutputBuffer。**没有搬动数据时 Driver 挂起在 blocked future 上**——协作式调度让少量线程跑海量 driver。

#### 容错与重试链路

失败传播：worker 算子异常 → `TaskStateMachine.failed` → 状态经 `ContinuousTaskStatusFetcher` 长轮询回到 coordinator → `PipelinedStageExecution.updateTaskStatus` → `QueryStateMachine.transitionToFailed` → `Query.toQueryError` 编进响应，nextUri 置 null。重试分三档（`retry_policy` session 属性）：`QUERY` 整查询重跑（`PipelinedQueryScheduler.scheduleRetryWithDelay` 指数退避）；`TASK` 走容错模式（EventDrivenFaultTolerantQueryScheduler + exchange 落盘 + task 级重启 + AdaptivePlanner 运行时重规划）；`NONE` 直接失败。

### 状态流

![核心状态机](/vibe-reading/images/articles/trino-internals/state-flow.svg)

四套状态机共用一个模板：`StateMachine<T>`（`trySet`/`compareAndSet`/`setIf` + `FutureStateChange` 轮询等待 + listener 异步 fire）。`QueryState` 九态由 `SqlQueryExecution` 的 `transitionToXxx` 系列驱动，**FINISHED 需要 committed 且 `resultsConsumed()` 双条件**（客户端拉完输出才结束，防止结果丢失）；`TaskState` 初始即 RUNNING（调度器选点在先，task 被创建时已在跑）；节点状态机支撑 drain 式优雅停机；catalog 只有 OPERATIONAL/FAILING 两态（"可 drop"由 `getReachableDynamicCatalogs` 单独表达）。

---

## 典型修改场景

#### 场景 1：新增一种 DDL 语句

- 语法：`SqlBase.g4`（trino-grammar）statement 规则加分支 → `tree/Xxx.java`（AST 节点）→ `AstBuilder.visitXxx`（trino-parser）
- 语义/执行：`XxxTask implements DataDefinitionTask<Xxx>`（execution/）→ `StatementUtils.STATEMENT_QUERY_TYPES` 注册 → `QueryExecutionFactoryModule.bindDataDefinitionTask` 加绑定行
- 测试：`TestSqlParser` + `TestXxxTask`
- 对应测试：`core/trino-main/src/test/java/io/trino/execution/`

#### 场景 2：新增一条优化规则

- 规则本体：`planner/iterative/rule/MyRule implements Rule<FilterNode>`（`getPattern()` + `apply()` 返回 `Result`）
- 注册：`PlanOptimizers.java` 对应阶段的 ImmutableSet
- 测试：仿照各 `Prune*Columns` 规则的 `BaseRuleTest` 样板
- 对应测试：`core/trino-main/src/test/java/io/trino/sql/planner/iterative/rule/`

#### 场景 3：新增一个内置标量函数

- 本体：`operator/scalar/XxxFunctions.java` 写 `@ScalarFunction` + `@SqlType` 注解的静态方法
- 注册：`metadata/SystemFunctionBundle` builder 加 `.scalars(XxxFunctions.class)`
- 测试：`AbstractTestFunctions` 派生
- 对应测试：`core/trino-main/src/test/java/io/trino/operator/scalar/`

（连接器/认证/killer 三类扩展见对应模块文档的「扩展方式」节。）

---

## 测试体系

```
测试金字塔（散布在各 Maven 模块内，而非独立顶层目录）：
每个模块 src/test/java/io/trino/…
├── 单元/组件测试      # TestSqlParser、TestAnalyzer、各 Prune* 规则测试、
│                      # AbstractTestFunctions（5000+ 函数断言）
├── 引擎集成测试        # testing/trino-testing 提供 QueryAssertions /
│                      # LocalQueryRunner（内存跑全 SQL 栈）
├── 产品级验收          # testing/trino-product-tests（Hive/Iceberg 等真实容器）
└── 容错专项            # testing/trino-faulttolerant-tests（FTE 全链路）
```

| 代码层 | 测试类型 | 代表 |
| --- | --- | --- |
| parser / analyzer | 单元 | `TestSqlParser`、`TestStatementBuilder`、`TestAnalyzer` |
| planner 规则 | 规则级快照 | `iterative/rule/` 下每规则一个 BaseRuleTest 派生 |
| operator / 函数 | 引擎内集成 | `AbstractTestOperator`、`AbstractTestFunctions` |
| 端到端 SQL | LocalQueryRunner | `testing/trino-testing`（不用起集群） |
| 连接器 | product-tests | `trino-product-tests`（Docker 容器矩阵） |

想理解某个类，优先读它对应的测试——`BaseRuleTest` 派生类就是规则的"可执行规格"。

---

## 阅读源码推荐路线

- **第一遍：主流程（跟一条查询走）**
  `server/Server.java` 的 `doStart()` → `dispatcher/QueuedStatementResource.postStatement()` → `dispatcher/DispatchManager.createQuery()` → `execution/SqlQueryExecution.start()`（932 行，读状态机驱动链）→ `scheduler/PipelinedQueryScheduler.start()` → `server/TaskResource.createOrUpdateTask()` → `execution/SqlTaskExecution.start()`
- **第二遍：计划体系（数据结构）**
  `sql/analyzer/Analysis.java`（70 个 side-table）→ `sql/planner/plan/PlanNode.java`（48 节点 + `@JsonSubTypes`）→ `sql/planner/PlanFragmenter.java` 的 `Fragmenter` → `sql/ir/Expression.java`（sealed 16 节点）
- **第三遍：执行运行时（worker 侧）**
  `operator/Operator.java`（四方法契约）→ `operator/Driver.java` 的 `processInternal()` → `sql/planner/LocalExecutionPlanner.java` 的 `Visitor.visitXxx`（计划→算子映射表）→ `operator/DirectExchangeClient.java`
- **第四遍：扩展机制**
  `trino-spi/Plugin.java` → `plugin/trino-example-http/`（17 个文件整个读）→ `server/PluginManager.installPluginInternal` → `planner/iterative/rule/` 任选一个规则 → `operator/scalar/BitwiseFunctions.java`（注解函数样板）
- **第五遍：选重点模块深入**（按兴趣，模块文档见「模块地图」）
  容错执行读 `scheduler/faulttolerant/EventDrivenFaultTolerantQueryScheduler.java`；代码生成读 `sql/gen/PageFunctionCompiler.java`；内存读 `memory/MemoryPool.java` + `MemoryRevokingScheduler.java`

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| Coordinator / Worker | 受理与调度角色 / 执行角色（同一二进制，配置分化） |
| Split | 表数据的并行单元（连接器定义，含位置提示） |
| Stage / Task | 一个 PlanFragment 的调度单元 / 其在具体节点上的执行实例 |
| Exchange | stage 间数据搬运（pipelined 内存直连 / FTE 落盘） |
| Page / Block | 列式批数据 / 单列值容器（行=position，列=channel） |
| Dynamic Filtering | build 侧运行时收集值域反哺 probe 侧扫描谓词 |
| Revocable Memory | 允许被回收（spill）的内存记账类别，配合 over-commit |
| Spooling | 大结果集落对象存储、客户端直拉结果的协议扩展 |
| FTE | Fault-Tolerant Execution，task 级重试的执行模式 |
| ANNOUNCE | 483 默认节点发现模式：worker 周期 POST /v1/announce 自注册 |

### 参考资料

- [Trino 官方文档](https://trino.io/docs/current/)（Sphinx 源就在仓库 `docs/`）
- [Trino: The Definitive Guide](https://trino.io/trino-the-definitive-guide.html)（O'Reilly，免费下载）
- 仓库内 `.github/DEVELOPMENT.md`——代码风格与贡献流程的权威来源
