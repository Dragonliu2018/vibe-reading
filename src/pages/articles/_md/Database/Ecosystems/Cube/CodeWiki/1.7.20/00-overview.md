---
source:
  type: "源码解读"
  project: "Cube"
  url: "https://github.com/cube-js/cube"
title: "Overview"
date: "2026-08-17T22:20:51+08:00"
category: [Database, Ecosystems, Cube, CodeWiki, "1.7.20"]
tags: ["Cube", "TypeScript", "Rust", "语义层", "BI", "OLAP"]
description: "Cube.js 开源语义层架构全解：TS 语义编译 + Rust SQL/存储双引擎"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.7.20 · **协议** Apache 2.0（后端）/ MIT（客户端）· **语言** TypeScript + Rust · **代码量** ~45 万行（TS 10.8 万 + Rust 34 万）· **仓库** [GitHub](https://github.com/cube-js/cube)

---

## 总览

### 项目简介

Cube 是一个**开源语义层（semantic layer）**。它让用户在代码里一次性定义 metrics、dimensions、joins 和访问规则，然后通过 SQL、REST、GraphQL 三种标准 API 把这些语义暴露给下游——BI 工具、自定义应用或 AI agent。Cube 是 headless 的：它不自带 UI，用户可以围绕它构建自己的分析体验。

每个 BI 工具内部都依赖一个语义层作为核心引擎——定义 metrics 和业务逻辑、屏蔽底层数据源复杂性。但大多数语义层是私有的、与单一 BI 平台紧耦合、无法跨工具复用。Cube 把这个引擎独立出来，任何分析应用都能通过标准 API 消费。**定义一次，到处使用**——内部 BI、嵌入式分析、AI agent，无需在每处重复实现模型。

Cube Core 的核心价值在于：**语义层单一定义，多协议多消费端复用**。它内置了一个关系缓存引擎（CubeStore），通过预聚合（pre-aggregation）提供亚秒级延迟和高并发。

**项目边界**：Cube Core 负责语义定义、查询编译、预聚合缓存与 API 暴露；不负责数据采集、ETL、可视化 UI（这些由 Cube 商业版或用户自建）。数据模型在 Cube Core 和 Cube 商业版间完全兼容。

### 功能矩阵

| 特性 | 实现包 | 说明 |
|------|--------|------|
| 数据模型定义 | `cubejs-schema-compiler` | cube/measure/dimension/join/pre-aggregation 声明式定义 |
| 跨方言 SQL 生成 | `schema-compiler` + Tesseract | JS adapter 模板方法 + Rust 原生规划器双轨 |
| 预聚合（relational cache） | `cubejs-query-orchestrator` | 声明式预聚合 + 自动匹配 + 增量刷新 |
| REST API | `cubejs-api-gateway` | `/load` `/meta` `/sql` `/dry-run` |
| GraphQL API | `cubejs-api-gateway` | 动态 Nexus Schema 生成 |
| SQL pg-wire | CubeSQL（Rust） | Postgres 协议兼容，BI 工具直连 |
| 实时订阅 | `api-gateway` WebSocket | 轮询 + 增量推送 |
| 分布式 OLAP 存储 | CubeStore（Rust） | 列式 Parquet + 分区 + 集群 |
| 29 数据源驱动 | `cubejs-*-driver` | Postgres/Snowflake/BigQuery/ClickHouse/... |
| RBAC / 行级安全 | `server-core` + `schema-compiler` | `applyRowLevelSecurity` + access policy |
| 多租户 | `server-core` | Context 贯穿 + `contextToAppId` 隔离 |
| 后台刷新调度 | `server-core` `RefreshScheduler` | round-robin 三维轮询 + 指数退避 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| TypeScript 5.2 | 核心 | TS 包主语言 |
| Rust | 核心 | CubeSQL / CubeStore / Tesseract |
| Node.js + Express | 核心 | HTTP 服务器与中间件 |
| Lerna + Yarn workspaces | 工具 | monorepo 管理与发布 |
| Neon（napi-2） | 桥接 | TS↔Rust FFI，同进程零序列化调用 |
| DataFusion | Rust 依赖 | CubeStore/CubeSQL 查询引擎 |
| Apache Arrow / Parquet | Rust 依赖 | 列式内存格式与落盘存储 |
| RocksDB | Rust 依赖 | CubeStore 元数据存储 |
| egg | Rust 依赖 | e-graph equality saturation 查询重写 |
| sqlparser-rs | Rust 依赖 | SQL 解析 |
| warp | Rust 依赖 | CubeStore WebSocket 服务 |
| V8 `vm` | TS 依赖 | 数据模型沙箱执行 |
| node-dijkstra | TS 依赖 | JoinGraph 最短路径计算 |
| express-graphql + nexus | TS 依赖 | GraphQL Schema 构建与执行 |
| Jest | 测试 | 单元测试 + snapshot 测试 |

### 顶层上下文图

```
                    ┌──────────────────────────────────────┐
                    │          下游消费端                     │
                    │  BI 工具 · 前端 SDK · AI agent · psql  │
                    └──────────────┬───────────────────────┘
                                   │ REST / GraphQL / SQL pg-wire / WS
                    ┌──────────────▼───────────────────────┐
                    │           Cube 语义层                   │
                    │  定义一次 metrics/dimensions/joins      │
                    │  编译 SQL · 预聚合缓存 · 多协议暴露       │
                    └──┬──────────────────────────┬─────────┘
                       │                          │
            ┌──────────▼──────────┐   ┌───────────▼──────────┐
            │   数据源（查询）      │   │  CubeStore（预聚合）   │
            │ Snowflake/BigQuery/  │   │  列式 Parquet 存储     │
            │ Postgres/ClickHouse  │   │  分布式 OLAP           │
            └─────────────────────┘   └──────────────────────┘
```

---

## 快速上手

用 Docker 一行命令启动 Cube Core 开发环境：

```bash title="启动 Cube 开发服务器"
docker run -p 4000:4000 -p 15432:15432 \
  -v ${PWD}:/cube/conf \
  -e CUBEJS_DEV_MODE=true \
  cubejs/cube
```

打开 http://localhost:4000 即进入 Playground，可连接数据源、定义模型、调试查询。`CUBEJS_DEV_MODE=true` 启用 DevServer 热加载——修改数据模型文件无需重启服务，CompilerApi 通过 MD5 检测文件变化自动重编译（`CompilerApi.ts:212-236`）。

生产部署用 `cubejs-server` 进程：

```bash title="生产启动"
npx cubejs-server
```

一个最小的数据模型文件（`schema/Orders.js`）：

```javascript title="数据模型示例"
cube(`Orders`, {
  sql: `SELECT * FROM public.orders`,
  measures: {
    count: { type: `count` },
    revenue: { sql: `sum(amount)`, type: `sum` }
  },
  dimensions: {
    status: { sql: `status`, type: `string` },
    createdAt: { sql: `created_at`, type: `time` }
  },
  preAggregations: {
    main: {
      measures: [count, revenue],
      dimensions: [status],
      timeDimension: createdAt,
      granularity: `day`,
      refreshKey: { every: `1 hour` }
    }
  }
});
```

定义后即可通过 REST `POST /cubejs-api/v1/load` 查询 `["Orders.count"]`，或用 psql 连接 15432 端口发 SQL `SELECT count(*) FROM Orders`。

---

## 架构设计解析

### 系统架构

Cube 的架构思想是**双引擎分层**：TypeScript 承担语义编译与编排，Rust 承担高性能 SQL 规划与存储，两者通过 napi FFI 同进程桥接。这样设计解决了一个核心矛盾——语义层需要灵活的动态编译（TS/V8 沙箱擅长），而查询执行与存储需要极致性能（Rust 零成本抽象擅长），把两者放进同一语言都会妥协。

![Cube.js 分层架构](/vibe-reading/images/articles/cube-codewiki-1.7.20/architecture.svg)

系统分五层，依赖方向自上而下：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|------------------------|
| 接口层 | `packages/cubejs-api-gateway` + `rust/cubesql`（pg-wire） | 隔离外部协议（REST/GraphQL/SQL/WS），保护核心不受接口变化影响；四协议统一汇聚到 `load()` |
| 编排层 | `packages/cubejs-server-core` | 编排用例流程，装配各组件，Context 贯穿多租户隔离，驱动解析与刷新调度 |
| 语义层 | `packages/cubejs-schema-compiler` + `rust/cube/cubesqlplanner`（Tesseract） | 承载语义规则——数据模型编译、JoinGraph、SQL 生成；TS adapter 与 Rust Tesseract 双轨 |
| 执行层 | `packages/cubejs-query-orchestrator` | 查询执行编排——预聚合匹配、三层缓存、并发队列；不依赖具体数据源 |
| 存储层 | `rust/cubestore` + `packages/cubejs-*-driver` | 持久化预聚合数据（CubeStore OLAP）与连接外部数据源（29 驱动） |

层间协作的关键：接口层把四协议归一为 `QueryBody`；编排层按 `context` 解析出对应的 `CompilerApi`/`OrchestratorApi`；语义层把 `QueryBody` 编译成 SQL + 预聚合描述；执行层匹配预聚合、查缓存、入队列、调 driver；存储层执行 SQL 返回结果。

### 设计模式

Cube 在不同模块运用了多种设计模式，核心的几个：

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `BaseQuery.buildSqlAndParams()`（`adapter/BaseQuery.js:877`） | SQL 结构跨方言一致，基类控流程，子类只覆盖 `convertTz`/`timeGroupedColumn` 等差异点 |
| 责任链 | 4 阶段编译流水线（`DataSchemaCompiler.ts:512`） | 编译有严格前后依赖（先收集名称才能 transpile），分阶段链确保顺序 |
| 外观/门面 | `CubejsServerCore`（`server-core/server.ts:99`） | 统一暴露 CompilerApi/OrchestratorApi/ApiGateway，屏蔽装配细节 |
| 依赖注入 | `createApiGatewayInstance` 传 `getCompilerApi.bind(this)`（`server.ts:498`） | ApiGateway 不直接依赖 CompilerApi 类，通过函数接口解耦，支持多租户按 context 解析 |
| 工厂 | `DriverResolvers`（`DriverResolvers.ts:67`）+ `QueryFactory` | 按数据源类型动态创建 driver/Query 实例，创建逻辑与使用解耦 |
| 策略 | 缓存模式 `must-revalidate`/`stale-while-revalidate`（`QueryCache.ts:285`） | 不同场景需不同缓存一致性权衡，策略可配置切换 |
| e-graph saturation | legacy 规划器 egg 重写（`compile/rewrite/`） | 查询等价变换空间大，equality saturation 探索全部等价形态再选最优 |
| RPC 代码生成 | `#[cuberpc::service]` 宏（`cuberpc/src/lib.rs`） | MetaStore 80+ 方法，宏自动生成序列化/分发/客户端，避免手写 |
| 访问者 | Babel `traverse()` 遍历 AST（`compiler/transpilers/`） | 数据模型源码变换只关注特定 AST 节点，扩展独立 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| Cube | 一个语义数据模型单元（含 measures/dimensions/joins/preAggs） | schema 文件加载→编译→缓存 | 属于 Repository，被 CubeEvaluator 求值 |
| Measure | 可聚合的指标（count/sum/avg/cumulative） | 随 Cube 编译 | 被 BaseQuery 解析为 BaseMeasure |
| Dimension | 不可聚合的维度（string/time/number） | 随 Cube 编译 | 被 BaseQuery 解析为 BaseDimension |
| PreAggregation | 声明式预聚合定义（rollup/rollupjoin） | 编译→匹配→构建→刷新→过期 | 被 PreAggregations 匹配，PreAggregationLoader 构建 |
| JoinGraph | cube 间 join 关系的有向图 | 编译时构建 | node-dijkstra 计算最短 join 路径 |
| Context | 请求上下文（securityContext/requestId） | 每请求创建 | 贯穿 Gateway→Compiler→Orchestrator |
| Partition | CubeStore 分区（按 sort key 范围） | 创建→写入→sealed→compaction | 属于 Index，含多个 Chunk |
| Chunk | CubeStore 最小数据块（Parquet 文件或内存） | 写入→激活→查询→compaction 合并 | 属于 Partition |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|---------|--------|---------|
| `BaseQuery` | `schema-compiler/adapter/BaseQuery.js` | `PostgresQuery`/`BigqueryQuery`/`ClickHouseQuery` 等 | `queryClass(dbType)` 按 dbType 映射 |
| `DriverInterface` | `cubejs-base-driver` | 29 个 `*Driver` | `DriverResolvers.lookupDriverClass` 动态 require |
| `CompilerInterface` | `schema-compiler/compiler/` | `CubeSymbols`/`CubeEvaluator`/`JoinGraph`/`CubeValidator` | `prepareCompiler()` 组装数组 |
| `TransportService` | `cubesql/transport/service.rs` | `NodeBridgeTransport`/`HttpTransport` | 按部署模式选择 |
| `MetaStore` trait | `cubestore/metastore/mod.rs` | `RocksMetaStore`/`MetaStoreRpcClient` | `#[cuberpc::service]` 宏 + Injector |
| `ContextAcceptor` | `server-core/types.ts` | `AcceptAllAcceptor` | `createContextAcceptor()` 可覆写 |

---

## 代码目录

```
cube/
├── packages/                    # TypeScript monorepo（Lerna + Yarn workspaces）
│   ├── cubejs-server-core/      # 编排层：装配、Context、调度（5,686 行）
│   ├── cubejs-schema-compiler/  # 语义层：模型编译、SQL 生成（33,166 行）
│   │   ├── src/parser/          #   SQL/Python 解析（含 ANTLR 生成）
│   │   ├── src/compiler/        #   CubeEvaluator/JoinGraph/CubeValidator/4 阶段流水线
│   │   └── src/adapter/         #   BaseQuery 模板方法 + 各方言子类 + PreAggregations
│   ├── cubejs-query-orchestrator/ # 执行层：缓存、预聚合、队列（6,152 行）
│   ├── cubejs-api-gateway/      # 接口层：REST/GraphQL/SQL/WS（6,056 行）
│   ├── cubejs-server/           # HTTP/WS/SQL server 启动包装（1,262 行）
│   ├── cubejs-base-driver/      # 驱动/队列/缓存接口契约（1,553 行）
│   ├── cubejs-backend-native/   # napi FFI 桥接层（TS 侧）
│   ├── cubejs-cubestore-driver/ # CubeStore WebSocket 驱动
│   ├── cubejs-*-driver/         # 29 个数据源驱动
│   └── cubejs-client-*/         # 前端 SDK（React/Vue/Angular/core）
├── rust/                        # Rust 组件
│   ├── cubesql/                 # CubeSQL：pg-wire 服务 + legacy 规划器（130,046 行）
│   │   ├── cubesql/             #   shim/query_engine/rewrite(egg)/transport
│   │   ├── cubeclient/          #   OpenAPI REST 客户端
│   │   └── pg-srv/              #   pg-wire 协议帧编解码
│   ├── cube/
│   │   ├── cubesqlplanner/      # Tesseract：原生 SQL 规划器（77,895 行）
│   │   │   ├── cubesqlplanner/  #   logical_plan/physical_plan/planner/cube_bridge
│   │   │   └── nativebridge/    #   proc-macro 自动生成 napi 绑定
│   │   ├── cubeorchestrator/    # Rust 侧编排
│   │   └── cubenativeutils/     # napi runtime
│   ├── cubestore/               # CubeStore：分布式 OLAP 存储（114,085 行）
│   │   └── cubestore/           #   metastore/store/cluster/queryplanner/import
│   └── cube-cli/                # CubeStore CLI
├── docs-mintlify/               # 活跃文档站（Mintlify）
└── examples/                    # 示例与 recipe
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/cube-codewiki-1.7.20/module-dependencies.svg)

模块间依赖呈"TS 左 / Rust 右 / napi 中间桥接"格局。`server-core` 是装配中枢，依赖 `schema-compiler` 和 `query-orchestrator`；`schema-compiler` 与 Tesseract 通过 napi 双向回调（TS 调 `buildSqlAndParams`，Rust 回调 `CubeEvaluator` 解析模型）；CubeSQL 的 pg-wire 路径通过 napi 回调 `sqlApiLoad` 执行查询；`query-orchestrator` 通过 WebSocket 连 CubeStore、通过 driver 连数据源。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 语义编译器 | 数据模型编译与跨方言 SQL 生成 | `DataSchemaCompiler.compile()` | 语义定义与执行解耦的契约层，29 驱动共享同一 `BaseQuery` 抽象 | [01-schema-compiler](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/01-schema-compiler) |
| 查询编排器 | 预聚合匹配、三层缓存、查询队列 | `QueryOrchestrator.fetchQuery()` | 执行策略与数据源解耦，缓存/队列/预聚合是独立可演进的关注点 | [02-query-orchestrator](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/02-query-orchestrator) |
| API 网关 | REST/GraphQL/SQL/WS 四协议统一 | `ApiGateway.load()` | 协议多样性与语义层单一性分离，四协议归一为 `QueryBody` | [03-api-gateway](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/03-api-gateway) |
| 服务器核心 | 组件装配、Context 贯穿、刷新调度 | `CubejsServerCore.initApp()` | 装配与被装配解耦，多租户 Context 隔离要求独立编排层 | [04-server-core](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/04-server-core) |
| CubeSQL 与 Tesseract | pg-wire SQL 接口与原生 SQL 规划 | `AsyncPostgresShim`/`TopLevelPlanner.plan()` | 性能关键路径用 Rust 重写，与 TS 语义层通过 napi 解耦 | [05-cubesql-tesseract](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/05-cubesql-tesseract) |
| CubeStore 存储 | 分布式 OLAP 预聚合存储 | `SqlService.exec_query()` | 预聚合低延迟需求催生专用列式存储，自研而非用现有 OLAP | [06-cubestore](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/06-cubestore) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

```
ServerContainer.start()                         [cubejs-server/src/server/container.ts:378]
  → lookupConfiguration() → 从 cube.js/cube.ts/cube.py 加载 CreateOptions
  → new CubejsServer(config)                    [cubejs-server/src/server.ts:62]
      → this.core = new CubejsServerCore(config, systemOptions)   [server.ts:84]
          │
          ├─ OptsHandler 构造 → optionsValidate (Joi 校验)        [OptsHandler.ts:82]
          │   → getDriverFactory() 包装用户工厂或默认工厂
          │   → getDbType() 从 driverFactory 推导 dbType
          │   → initializeCoreOptions() 填默认值、CubeStore 处理
          │
          ├─ FileRepository(schemaPath)          加载数据模型文件
          ├─ compilerCache = new LRUCache({max:250, dispose})    [server.ts:204]
          ├─ orchestratorStorage = new OrchestratorStorage()     LRU 缓存 OrchestratorApi
          ├─ createContextAcceptor() → AcceptAllAcceptor         可覆写
          ├─ startScheduledRefreshTimer()                        [server.ts:360]
          │   → createCancelableInterval(handleScheduledRefreshInterval, 30s)
          └─ if devServer → new DevServer(this, {...)
          │
  → server.listen()
      → express() + cors + bodyParser
      → core.initApp(app)                       [server.ts:440]
          → apiGateway().initApp(app)            注册 REST/GraphQL 路由
          → if devServer: devServer.initDevEnv(app)
      → gracefulHttp(http.createServer(app))
      → WebSocketServer (if enabled) → core.initSubscriptionServer()
      → SQLServer (if enabled) → core.initSQLServer()   启动 Rust pg-wire
      → server.listen(PORT)
```

对象装配要点：配置来自 `cube.js` 文件 + 环境变量（`CUBEJS_DB_TYPE` 等），覆盖优先级是命令行 > 环境变量 > 文件。`driverFactory` 可由用户注入（返回 `BaseDriver` 实例或 `DriverConfig` 对象，`OptsHandler.assertDriverFactoryResult` 强制类型一致）。`compilerCache` 按 `appId`（多租户）缓存 `CompilerApi`，dispose 回调显式释放 `vm.Script` 等内存密集对象（`server.ts:209`）。

### 核心运行流程

Cube 有三条核心运行链路：REST/GraphQL 查询、SQL pg-wire 查询、后台预聚合刷新。前两者是用户请求路径，后者是后台维护路径。

![端到端请求数据流](/vibe-reading/images/articles/cube-codewiki-1.7.20/data-flow.svg)

#### 用户查询：REST/GraphQL 路径

业务流程：前端发 JSON Query → 鉴权 → 归一化（RLS + queryRewrite）→ 编译 SQL → 匹配预聚合 → 查缓存/入队列 → driver 执行 → 返回。

文字描述：`ApiGateway.load()`（`gateway.ts:2014`）先经中间件链 `checkAuth → requestContextMiddleware → contextRejectionMiddleware` 完成鉴权与 Context 构造。`getNormalizedQueries()`（`gateway.ts:1328`）调用 `compilerApi.applyRowLevelSecurity()` 注入行级安全 filter，再经用户 `queryRewrite` 钩子改写。`CompilerApi.getSql()`（`CompilerApi.ts:350`）调用 `schema-compiler` 的 `buildSqlAndParams()` 生成 SQL + 预聚合描述——JS adapter 路径或 Tesseract Rust 路径（`buildSqlAndParamsRust`，`BaseQuery.js:932`）。随后 `OrchestratorApi.executeQuery()`（`OrchestratorApi.ts:73`）进入执行层：`PreAggregations.loadAllPreAggregationsIfNeeded()` 匹配预聚合（content/structure 双层版本号），`QueryCache.cachedQueryResult()` 查三层缓存，未命中则 `QueryQueue.executeInQueue()` 入队执行。超过 `continueWaitTimeout`（默认 10s）抛 `ContinueWaitError`，返回 `{error:'Continue wait', stage}` 让客户端轮询。GraphQL 路径在 `getJsonQuery()` 把 AST 转 JSON Query 后复用同一 `load()` 管道。

#### SQL 查询：pg-wire 路径

业务流程：psql/BI 工具发 SQL → Rust pg-wire 接收 → 解析+规划 → 转 CubeQuery → napi 回调 TS 执行 → 结果转 RecordBatch → pg-wire 返回。

文字描述：`AsyncPostgresShim`（`shim.rs:43`）处理 pg-wire 协议，`process_query()` → `convert_statement_to_cube_query()`（`router.rs:756`）。legacy 路径经 `QueryEngine.plan()`（`query_engine.rs:92`）：sqlparser 解析 → 一组 Visitor 归一化 → DataFusion `SqlToRel` 生成 LogicalPlan → 8 个 OptimizerRule 优化 → `LogicalPlanToLanguageConverter` 转 egg e-graph → `Rewriter.find_best_plan()` 等价饱和重写取最优。最终 `CubeScanNode` 通过 `NodeBridgeTransport.load()` napi 回调 `ApiGateway.sqlApiLoad()`（`sql-server.ts:197`），进入与 REST 相同的 orchestrator 执行管道。结果 RecordBatch 经 pg-wire 返回 psql。Tesseract 路径则由 TS orchestrator 调用 `native.buildSqlAndParams()`，`TopLevelPlanner.plan()`（`top_level_planner.rs:33`）生成下推 SQL，回调 `CubeEvaluator` trait 解析模型。

#### 后台维护：预聚合刷新调度

业务流程：定时器 30s 触发 → 遍历 context → 刷新 refreshKey → round-robin 预聚合 → 指数退避。

文字描述：`createCancelableInterval` 每 30s 调 `handleScheduledRefreshInterval()`（`server.ts:769`），批量（`pLimit(scheduledRefreshBatchSize)`）处理所有 context。`RefreshScheduler.runScheduledRefresh()`（`RefreshScheduler.ts:257`）先并行 `refreshCubesRefreshKey()` 更新所有 cube 的 refresh key，再 `roundRobinRefreshPreAggregationsQueryIterator()`（`:486`）三维轮询（preAgg × timezone × partition）构建预聚合。失败时 `updatePreAggBackoff()` 指数退避（`multiplier *= 2`），`advance()` 出错回滚游标保证可恢复。最后 `forceReconcile()` 强制队列 reconcile。

### 状态流

预聚合版本状态机：

```
                  ┌─────────┐
            ┌─────│ 未构建   │─────┐
            │     └─────────┘     │
            │  (首次查询触发)      │ (刷新调度触发)
            ▼                     ▼
      ┌──────────┐         ┌──────────┐
      │ 构建中    │────────▶│ 就绪      │
      │ (队列 concurrency=1)│ (content version 命中)
      └──────────┘         └────┬─────┘
            │                     │
            │ (构建失败)           │ (refreshKey 变更 / 过期)
            ▼                     ▼
      ┌──────────┐         ┌──────────┐
      │ 失败/退避  │         │ 数据过期   │
      │ (指数退避) │         │ (structure 命中)│
      └────┬─────┘         └────┬─────┘
           │                    │
           └────重试────────────┘
                    │
              (后台 scheduleRefresh)
                    ▼
              返回旧数据 + 后台刷新
              (stale-while-revalidate)
```

关键状态转换在 `PreAggregationLoader.loadPreAggregationWithKeys()`（`PreAggregationLoader.ts:211`）：`byContent` 完全匹配→就绪；`byStructure` 匹配但数据过期→返回旧数据+后台 `scheduleRefresh()`；都不匹配→从零构建。`structureVersionPersistTime`（默认 30 天）保留旧结构版本支持回滚，`dropOrphanedTables` 清理半成品表。

---

## 典型修改场景

### 场景 1：新增一种数据源驱动（如 `cassandra-driver`）

- `packages/cubejs-cassandra-driver/` — 新建包，`CassandraDriver extends BaseDriver`，实现 `query`/`testConnection`/`informationSchemaQueries`
- `packages/cubejs-schema-compiler/src/adapter/` — 新增 `CassandraQuery extends BaseQuery`，覆盖 `convertTz`/`timeGroupedColumn`/`sqlTemplates`
- `packages/cubejs-server-core/src/core/DriverDependencies.ts:4` — 添加 `'cassandra': '@cubejs-backend/cassandra-driver'` 映射
- 配置 `CUBEJS_DB_TYPE=cassandra` 即可被 `DriverResolvers.lookupDriverClass()` 解析

### 场景 2：新增一个 measure 类型（如 `median`）

- `schema-compiler/adapter/BaseMeasure.ts` — 类型分发添加 `median` 分支，实现 `medianSql()`
- `schema-compiler/adapter/BaseQuery.js:1486` — `fullKeyQueryAggregateMeasures` 判断 `median` 非 additive，归入 multiplied 分支走子查询
- `schema-compiler/compiler/CubeValidator.ts` — measure type 校验白名单添加 `'median'`
- `schema-compiler/adapter/PreAggregations.ts:296` — `aggregationsColumns()` rollup 聚合函数映射
- 各方言 `BaseQuery` 子类 — 覆盖 `medianSql()` 返回方言等价（`PERCENTILE_CONT`/`APPROX_QUANTILES`/`quantile()`）

### 场景 3：新增 pre-aggregation 分区维度（按非时间维度分区）

- `schema-compiler/compiler/CubeSymbols.ts` — `PreAggregationDefinition` 扩展 `partitionDimension` 字段
- `schema-compiler/adapter/PreAggregations.ts:251` — `canPartitionsBeUsed()` 扩展检查非时间分区维度
- `schema-compiler/adapter/PreAggregations.ts:270` — `partitionDimension()` 支持从非时间维度取
- `query-orchestrator/orchestrator/PreAggregationPartitionRangeLoader.ts` — 分区展开逻辑扩展

---

## 测试体系

```
packages/
├── cubejs-testing/              # 端到端测试
├── cubejs-testing-drivers/      # 驱动集成测试（Docker 环境）
├── cubejs-testing-shared/       # 测试工具与抽象
└── cubejs-*/test/               # 各包 Jest 单元测试
rust/
├── cubestore/cubestore-sql-tests/  # CubeStore SQL 兼容性测试
└── cube/cubesqlplanner/src/test_fixtures/  # Tesseract insta snapshot 测试
```

| 代码层 | 测试类型 | 说明 |
|--------|---------|------|
| schema-compiler | Jest snapshot | SQL 编译结果 snapshot，方言差异回归 |
| query-orchestrator | Jest unit | 预聚合匹配、缓存策略、队列行为 |
| api-gateway | Jest unit | 路由、鉴权、查询归一化 |
| driver | Docker integration | `cubejs-testing-drivers` 跑真实数据源 |
| Tesseract | insta snapshot | logical/physical plan 生成结果 |
| CubeStore | SQL 兼容测试 | `cubestore-sql-tests` 覆盖 SQL 方言 |

理解 SQL 编译优先读 `cubejs-schema-compiler/test/` 的 snapshot 测试——它们是"可执行文档"，每个 snapshot 展示特定查询在特定方言下生成的 SQL。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `packages/cubejs-server/src/server.ts` 的 `CubejsServer` → `packages/cubejs-server-core/src/core/server.ts` 的 `CubejsServerCore.initApp()` → `packages/cubejs-api-gateway/src/gateway.ts` 的 `ApiGateway.load()` → `packages/cubejs-server-core/src/core/OrchestratorApi.ts` 的 `executeQuery()` → `packages/cubejs-query-orchestrator/src/orchestrator/QueryOrchestrator.ts` 的 `fetchQuery()`

- **第二遍：理解语义编译**
  `packages/cubejs-schema-compiler/src/compiler/DataSchemaCompiler.ts` 的 `doCompile()`（4 阶段流水线）→ `compiler/CubeEvaluator.ts` 的 `prepareCube()` → `compiler/JoinGraph.ts` 的 `buildJoin()` → `adapter/BaseQuery.js` 的 `buildSqlAndParams()` → `adapter/PreAggregations.ts` 的 `findPreAggregationForQuery()`

- **第三遍：理解执行与缓存**
  `query-orchestrator/orchestrator/QueryCache.ts` 的 `cachedQueryResult()`（三层缓存）→ `PreAggregationLoader.ts` 的 `loadPreAggregationWithKeys()`（双层版本号匹配）→ `QueryQueue.ts` 的 `executeInQueue()`（并发与 ContinueWait）→ `PreAggregationPartitionRangeLoader.ts` 的 `loadPreAggregations()`（分区增量刷新）

- **第四遍：深入 Rust 双引擎**
  `rust/cubesql/cubesql/src/sql/postgres/shim.rs` 的 `AsyncPostgresShim`（pg-wire）→ `rust/cubesql/cubesql/src/compile/query_engine.rs` 的 `QueryEngine::plan()`（egg rewrite）→ `rust/cube/cubesqlplanner/cubesqlplanner/src/planner/top_level_planner.rs` 的 `TopLevelPlanner::plan()`（Tesseract）→ `rust/cubestore/cubestore/src/sql/mod.rs` 的 `SqlService` → `rust/cubestore/cubestore/src/store/mod.rs` 的 `ChunkStore.partition_data()`

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| Semantic Layer | 语义层——定义 metrics/dimensions/joins 的中间层，屏蔽底层数据源 |
| Pre-aggregation | 预聚合——预先计算并物化的聚合结果，作为 relational cache 加速查询 |
| Refresh Key | 刷新键——检测源数据变更的机制，refreshKey 变化触发预聚合重建 |
| content_version / structure_version | 预聚合双层版本号——content 含数据指纹（变更即重建），structure 含结构定义（变更才重建） |
| ContinueWaitError | 查询超过 continueWaitTimeout 未完成时抛出，释放 HTTP 连接，客户端轮询 |
| rollup / rollup-join | 预聚合类型——rollup 物化单 cube 聚合，rollup-join 跨 cube join 后物化 |
| Tesseract | Cube 的新版原生 SQL 规划器（Rust），替代 JS 版 `BaseQuery` SQL 生成 |
| CubeScanNode | DataFusion Extension 节点，legacy 路径中 SQL→CubeQuery 的桥梁 |
| napi / Neon | Node.js 的 Rust 原生绑定，TS↔Rust 同进程 FFI |
| Router / Worker | CubeStore 集群角色——Router 管元数据与计划，Worker 执行扫描聚合 |
