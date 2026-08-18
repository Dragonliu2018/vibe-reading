---
source:
  type: "源码解读"
  project: "Cube"
  url: "https://github.com/cube-js/cube"
title: "服务器核心"
date: "2026-08-17T22:20:51+08:00"
category: [Database, Ecosystems, Cube, CodeWiki, "1.7.20"]
tags: ["Cube", "TypeScript", "装配", "调度", "依赖注入"]
description: "组件装配、Context 贯穿与预聚合刷新调度"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/00-overview)

---

> **路径** `packages/cubejs-server-core/src/core/` · **规模** 15 文件 / 5,686 行 TypeScript · **核心入口** `server.ts` 的 `CubejsServerCore`

---

## 模块定位

server-core 是 Cube.js 的**编排层**——它不实现具体的语义编译、查询执行或协议接入，而是把这些独立组件**装配**成一个可对外服务的整体。在分层架构中，它位于接口层（api-gateway）之下、语义层（schema-compiler）与执行层（query-orchestrator）之上，承担三件事：

1. **组件装配**：创建 `CompilerApi`（封装 schema-compiler）、`OrchestratorApi`（封装 query-orchestrator）、`ApiGateway`，并以函数注入方式把它们串联起来。
2. **Context 贯穿**：`RequestContext`（含 `securityContext`、`requestId`）从 API 请求一路传到编译器与编排器，是多租户隔离的核心载体。
3. **后台调度**：`RefreshScheduler` 周期性触发预聚合刷新，`DevServer` 提供开发模式热加载。

`cubejs-server` 包在 `CubejsServerCore` 之上再包一层 `CubejsServer`，加入 Express、HTTP server、WebSocket、SQL Server 与信号处理（SIGTERM/SIGINT 优雅关闭、SIGUSR1 重启）。server-core 本身是框架无关的纯装配逻辑。

---

## 模块架构

server-core 内部组件围绕 `CubejsServerCore` 门面组织，按职责分为装配、API 封装、调度、驱动解析四组：

```
                      CubejsServerCore (server.ts:99)  ← 门面
                            │
       ┌────────────────────┼─────────────────────────────┐
       │                    │                             │
  OptsHandler          contextAcceptor              compilerCache / orchestratorStorage
  (配置处理)           (AcceptAllAcceptor)           (LRU 缓存按 appId/orchestratorId)
       │
       ▼
  DriverResolvers ──→ driverDependencies / lookupDriverClass / createDriver
  (驱动解析链)
       │
       ├─► CompilerApi (CompilerApi.ts)
       │     ├─ compileSchema / getSql / metaConfig
       │     ├─ applyRowLevelSecurity (RBAC)
       │     └─ compiledScriptCache / compiledYamlCache / compiledJinjaCache (三级 LRU)
       │
       ├─► OrchestratorApi (OrchestratorApi.ts)
       │     └─ orchestrator: QueryOrchestrator
       │           (executeQuery / streamQuery / queryStage)
       │
       ├─► ApiGateway (createApiGatewayInstance)
       │     (函数注入 getCompilerApi.bind / getOrchestratorApi.bind)
       │
       ├─► RefreshScheduler (RefreshScheduler.ts)
       │     (runScheduledRefresh / roundRobin 三维轮询)
       │
       └─► DevServer (DevServer.ts)  [dev 模式]
             (Playground / 文件热加载)
```

`OptsHandler` 在构造阶段处理配置、推导 `dbType`、包装 `driverFactory`；`DriverResolvers` 是静态工具链，按 `CUBEJS_DB_TYPE` 解析到具体驱动包；`CompilerApi`/`OrchestratorApi` 分别封装编译器与编排器；`RefreshScheduler` 与 `DevServer` 是两个旁路子系统。**组件之间通过 `CubejsServerCore` 的方法引用（`this.getCompilerApi.bind(this)`）协作，而非直接持有彼此引用**——这是依赖注入的体现。

---

## 调用链路

### (a) 服务器启动 → 装配各组件 → 就绪服务请求

```
ServerContainer.start() [cubejs-server/src/server/container.ts:378]
  → lookupConfiguration()  从 cube.js / cube.ts / cube.py 加载 CreateOptions
  → new CubejsServer(config)
      → this.core = new CubejsServerCore(config, systemOptions)  [server.ts:181-347]
          │
          ├─ OptsHandler 构造 → optionsValidate (Joi 校验)
          │    → getDriverFactory(opts)  包装用户工厂或默认工厂  [OptsHandler.ts:173]
          │    → getDbType(driverFactory)  从工厂推导 dbType
          │    → initializeCoreOptions()  填充默认值 / externalDbType / CubeStore 处理
          ├─ FileRepository(schemaPath)
          ├─ compilerCache = new LRUCache({max:250, dispose: v=>v.dispose()})  [server.ts:204]
          ├─ createContextAcceptor() → AcceptAllAcceptor  [server.ts:349]
          ├─ startScheduledRefreshTimer() → createCancelableInterval(30s)  [server.ts:360]
          └─ if devServer → new DevServer(this)
  → server.listen()
      → express() + cors + bodyParser
      → core.initApp(app)  [server.ts:440]
          → apiGateway().initApp(app)  注册 /v1/load /graphql /sql 等路由
          → if devServer: devServer.initDevEnv(app)
      → WebSocketServer (if enabled) → core.initSubscriptionServer()
      → SQLServer (if enabled) → core.initSQLServer()
      → http.createServer(app).listen(PORT)

[请求到达]  ApiGateway.getCompilerApi(context)  [gateway.ts:2371]
  → core.getCompilerApi(context)  [server.ts:522]
      contextToAppId(context) → appId
      compilerCache.get(appId)  命中返回 / 未命中 createCompilerApi 并缓存
  → core.getOrchestratorApi(context)  [server.ts:572]
      contextToOrchestratorId(context) → orchestratorId
      orchestratorStorage.has(id)  命中返回 / 未命中构造 DriverFactoryByDataSource 闭包并缓存
```

关键点：`compilerCache` 与 `orchestratorStorage` 按 context 派生的 `appId`/`orchestratorId` 缓存实例，**同一租户复用同一套 Compiler/Orchestrator**，是查询热路径上的关键优化。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `CubejsServerCore` 构造器 | `server.ts:181` | 装配 OptsHandler、缓存、调度器、ContextAcceptor |
| `initApp(app)` | `server.ts:440` | 初始化 ApiGateway 并注册 Express 路由 |
| `getCompilerApi(context)` | `server.ts:522` | 按 appId 获取/创建 CompilerApi |
| `getOrchestratorApi(context)` | `server.ts:572` | 按 orchestratorId 获取/创建 OrchestratorApi |
| `getDriver(context)` | `server.ts:876` | 解析并实例化数据源驱动 |
| `startScheduledRefreshTimer` | `server.ts:360` | 启动 30s 周期刷新定时器 |
| `handleScheduledRefreshInterval` | `server.ts:769` | 单次刷新调度入口 |
| `runScheduledRefresh` | `server.ts:816` | 执行一轮刷新 |
| `shutdown()` | — | 释放连接、停止定时器 |
</details>

### (b) 预聚合后台刷新调度链路

```
createCancelableInterval(handleScheduledRefreshInterval, {interval: 30s})  [server.ts:360]
  │  每 30s 触发
  ▼
handleScheduledRefreshInterval({})  [server.ts:769]
  ├─ scheduledRefreshContexts() → allContexts[]
  ├─ 每个 context: migrateBackgroundContext()  [server.ts:825]
  │    (authInfo ↔ securityContext 向后兼容迁移)
  ├─ contextAcceptor.shouldAccept(resContext)  过滤被禁用租户
  ├─ pLimit(scheduledRefreshBatchSize)  批次并发限制
  └─ 每个 accepted context:
      ├─ scheduledRefreshTimeZones(context) → timezones[]
      └─ runScheduledRefresh(context, queryingOptions)  [server.ts:816]
          ▼
  getRefreshScheduler() → new RefreshScheduler(this)  [server.ts:809]
      ▼
  RefreshScheduler.runScheduledRefresh(ctx, options)  [RefreshScheduler.ts:257]
    ├─ getSchedulerConcurrency()  从 QueryOrchestrator 队列取最小并发
    ├─ compilerApi = serverCore.getCompilerApi(context)
    ├─ 并行:
    │   refreshCubesRefreshKey()  [RefreshScheduler.ts:337]
    │     每个 cube: getSql → orchestratorApi.executeQuery({loadRefreshKeysOnly:true})
    │   refreshPreAggregations()  [RefreshScheduler.ts:593]
    │     → roundRobinRefreshPreAggregationsQueryIterator()  [RefreshScheduler.ts:486]
    │         三维轮询: preAggregation × timezone × partition
    │         游标: preAggregationCursor / timezoneCursor / partitionCursor
    │         advance() 出错回滚游标  [RefreshScheduler.ts:549]
    │     每个 worker:
    │       getPreAggBackoff() → 退避检查
    │       orchestratorApi.executeQuery({scheduledRefresh:true})
    │       失败 → updatePreAggBackoff()  指数退避 multiplier*=2
    └─ forceReconcile(context, compilerApi)  [RefreshScheduler.ts:318]
        每个 dataSource 调 orchestratorApi.forceReconcile(ds)
```

---

## 核心实现

### CubejsServerCore 门面与依赖注入

`CubejsServerCore`（`server.ts:99`）是整个后端的门面，统一暴露 `CompilerApi`、`OrchestratorApi`、`ApiGateway`、`DevServer`、`RefreshScheduler`。它采用**函数注入**而非实例注入——`createApiGatewayInstance`（`server.ts:498`）接收的是 `this.getCompilerApi.bind(this)` 和 `this.getOrchestratorApi.bind(this)` 这两个函数引用，而非已创建的实例：

```typescript title="server.ts (createApiGatewayInstance 注入)"
protected createApiGatewayInstance(...) {
  return new ApiGateway(
    this.options.apiSecret,
    this.getCompilerApi.bind(this),     // (ctx) => Promise<CompilerApi>
    this.getOrchestratorApi.bind(this), // (ctx) => Promise<OrchestratorApi>
    this.logger,
    { ...options }
  );
}
```

**Why 用函数注入而非实例**：`CompilerApi` 和 `OrchestratorApi` 的创建依赖请求 `context`（多租户场景下不同租户有不同 schema、不同数据源），无法在启动时预先创建。函数注入让 ApiGateway 在每次请求时按 context 懒创建并缓存实例——`getCompilerApi` 内部用 `compilerCache.get(appId)` 命中即返回、未命中才 `createCompilerApi`（`server.ts:528-549`）。

`Context` 贯穿是这一设计的直接受益者：`RequestContext`（`types.ts:81-86`，含 `securityContext`、`requestId`）从 `requestContextMiddleware` 创建后，经 `getCompilerApi(context)` → `CompilerApi.metaConfig(context)` → `OrchestratorApi.executeQuery(query)` 中 `query.context` 字段全程传递。`contextToAppId(context)` 决定使用哪个 CompilerApi 实例，`contextToOrchestratorId(context)` 决定使用哪个 OrchestratorApi——**多租户隔离的核心就是 context 派生的这两个 id**。`migrateBackgroundContext()`（`server.ts:825-855`）处理 `authInfo` → `securityContext` 的向后兼容，确保后台刷新也有正确安全上下文。

### DriverResolvers 驱动解析

驱动解析是一条静态工具链（`DriverResolvers.ts`），按 `CUBEJS_DB_TYPE` 环境变量定位到具体的 npm 驱动包：

```typescript title="DriverResolvers.ts"
export const driverDependencies = (dbType: DatabaseType): string;   // 查 npm 包名
export const lookupDriverClass = (dbType): Constructor<BaseDriver>; // 动态 require 驱动模块
export const createDriver = (type, options?): BaseDriver;           // 实例化
```

解析链路：`OptsHandler.defaultDriverFactory(ctx)`（`OptsHandler.ts:164`）读取 `CUBEJS_DB_TYPE` 或多数据源的 `CUBEJS_DS_<dataSource>_DB_TYPE`，返回 `{ type: 'postgres' }` 这类 `DriverConfig`；`ServerCore.resolveDriver`（`server.ts:876`）调用 `createDriver(type, opts)`，后者经 `lookupDriverClass` 动态 `require(driverDependencies(type))`，例如 `driverDependencies('postgres')` 返回 `'@cubejs-backend/postgres-driver'`（`DriverDependencies.ts:4`）。映射表未命中时有 fallback：尝试 `@cubejs-backend/${dbType}-driver` 和 `${dbType}-cubejs-driver`（`DriverResolvers.ts:19-25`）。

**预聚合驱动的分离与共享**是更精巧的设计。`ServerCore.getOrchestratorApi()` 中的 driver factory 闭包（`server.ts:603-666`）按 `(dataSource, preAggregations)` 组合缓存 driver Promise：

- `hasPreAggregationsEnvVars(dataSource)` 检查是否有 `CUBEJS_DS_<dataSource>_PRE_AGG_DB_TYPE` 等独立预聚合环境变量。
- **有独立环境变量且非自定义 driverFactory** → 预聚合用独立 driver（写 CubeStore），查询用源数据库 driver。
- **无独立环境变量** → 预聚合与查询共享同一个 driver Promise（`server.ts:661-663`）。
- `externalDriverFactory`（CubeStore driver）独立传入；`externalDbType === 'cubestore'` 时 `skipExternalCacheAndQueue: true`（`server.ts:711`），CubeStore 兼任 cache 与 queue 驱动。

**Why 分离与共享并存**：生产环境中预聚合写入（CubeStore）与数据查询（源数据库）往往需要不同连接配置，分离避免互相影响；开发环境通常共享以简化配置。`OptsHandler.assertDriverFactoryResult()`（`OptsHandler.ts:108-143`）强制 factory 返回类型一致性——一旦确定返回 `BaseDriver` 实例或 `DriverConfig` 对象之一，后续必须保持相同类型。

### CompilerApi 编译器封装

`CompilerApi`（`CompilerApi.ts`）封装 schema-compiler，对外暴露编译、SQL 生成、RBAC、元数据能力。核心方法 `getSql(query, options)`（`CompilerApi.ts:350`）链路：`getSqlGenerator` → `getCompilers` → `compileSchema` → `withQuery` → `buildSqlAndParams`，返回 `SqlResult { sql, preAggregations, cacheKeyQueries, dataSource, aliasNameToMember }`。

RBAC 行级安全是 CompilerApi 的关键职责：`applyRowLevelSecurity(query, evaluatedQuery, context)`（`CompilerApi.ts:488`）根据 `securityContext` 中的策略为查询注入行级过滤条件，`getApplicablePolicies(cube, context, compilers)` 取该 cube 适用策略，`patchVisibilityByAccessPolicy` 按访问策略打可见性补丁。返回 `{ query, denied }`——被拒绝的 member 会在 `denied` 中标记。

**三级 LRU 缓存**（`CompilerApi.ts:158-172`）：`compiledScriptCache`（vm.Script，max 250）缓存编译后的 V8 Script、`compiledYamlCache` 缓存 YAML→JS 转换、`compiledJinjaCache` 缓存 Jinja 模板渲染。这三层缓存避免重复执行数据模型文件的沙箱编译。`dispose()`（`CompilerApi.ts:187`）在 LRU 淘汰时清除定时器并用 `disposedProxy` 替换 `compilers`/`queryFactory` 防止悬空引用——CompilerApi 持有 `vm.Script`、`NativeInstance`、`compilers` Promise 等内存密集对象，必须显式释放。

### RefreshScheduler 增量刷新调度

`RefreshScheduler`（`RefreshScheduler.ts`）用 round-robin 迭代器跨 `preAggregation × timezone × partition` 三个维度分配刷新工作（`roundRobinRefreshPreAggregationsQueryIterator`，`RefreshScheduler.ts:486`）。三维游标 `preAggregationCursor`/`timezoneCursor`/`partitionCursor` 推进，`advance()` 出错时回滚游标（`RefreshScheduler.ts:549-555`）保证可恢复。

**指数退避**（`RefreshScheduler.ts:639-658`）：首次失败延迟 1s，后续 `multiplier *= 2`，`delay = min(mult, maxTime)`，通过 `getPreAggBackoff`/`updatePreAggBackoff` 持久化到 cache driver。`refreshCubesRefreshKey()`（`RefreshScheduler.ts:337`）并行刷新所有 cube 的 refresh key；`forceReconcile()`（`RefreshScheduler.ts:318`）对每个 dataSource 强制队列 reconcile。

**Why 三维轮询 + 退避**：避免故障数据源阻塞整个刷新队列（退避让故障源有时间恢复），round-robin 公平分配避免热点（某些大 pre-agg 一直占用 worker）。`getSchedulerConcurrency` 从 `QueryOrchestrator` 队列取最小并发，让后台刷新与用户查询共享并发配额而不互相挤压。

### DevServer 热加载

`DevServer`（`DevServer.ts`）支持开发时修改数据模型文件无需重启服务。`CompilerApi.getCompilers()`（`CompilerApi.ts:212-236`）在 dev/fastReload 模式下把 schema 文件 MD5 附加到 `compilerVersion`：

```typescript title="CompilerApi.ts (热加载版本检测)"
if (this.options.devServer || this.options.fastReload) {
  const files = await this.repository.dataSchemaFiles();
  compilerVersion += `_${crypto.createHash('md5').update(JSON.stringify(files)).digest('hex')}`;
}
```

文件变化 → MD5 变化 → `compilerVersion !== this.compilerVersion` → 触发重编译。DevServer `/playground/env` 端点（`DevServer.ts:558`）写入 `.env` 后调 `resetInstanceState()`，清空 `orchestratorStorage`/`compilerCache`、重建 `FileRepository`、重启调度器——一次完整的开发态重置。

---

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
|------|---------------------|----------|
| 外观/门面 | `CubejsServerCore`（`server.ts:99`） | 统一暴露 Compiler/Orchestrator/Gateway/Scheduler，外部只需与一个对象交互 |
| 依赖注入 | `createApiGatewayInstance`（`server.ts:498`）函数注入 | Compiler/Orchestrator 依赖请求 context，无法启动时预创建；函数注入支持懒创建+缓存 |
| 工厂 | `DriverResolvers.createDriver`（`DriverResolvers.ts:67`）；`OptsHandler.getDriverFactory`（`OptsHandler.ts:173`） | 按 dbType 动态 require 驱动包；用户工厂与默认工厂可切换 |
| 调度器 | `startScheduledRefreshTimer`（`server.ts:360`）；`roundRobinRefreshPreAggregationsQueryIterator`（`RefreshScheduler.ts:486`） | 周期性后台刷新 + 三维公平轮询 + 退避 |
| 策略 | `ContextAcceptor`（`types.ts:284`）/ `AcceptAllAcceptor`（`server.ts:85`）；`createContextAcceptor`（`server.ts:349`）可覆写 | 多租户运行时禁用某租户，请求/连接层拒绝而非查询层报错 |
| 缓存 | `compilerCache`（`server.ts:204`，dispose 回调）；`OrchestratorStorage`（按 orchestratorId）；CompilerApi 三级 LRU | 查询热路径复用实例；LRU 淘汰时显式释放内存密集对象 |

---

## 模块间交互

server-core 是装配中枢，与几乎所有核心包交互：

- **装配 schema-compiler**：`CompilerApi` 调 `compile(repository, options)`（`CompilerApi.ts:261`）编译数据模型；`createQueryFactory`（`CompilerApi.ts:291`）遍历所有 cube，按 dataSource 取 dbType，用 `queryClass(dbType, dialectClass)` 为每个 cube 创建 Query 类。`dialectClass` 由 `OptsHandler` 中 `dialectFactory` 提供：`lookupDriverClass(ctx.dbType).dialectClass()`（`OptsHandler.ts:407`）。
- **装配 query-orchestrator**：`OrchestratorApi` 构造器直接 `new QueryOrchestrator(redisPrefix, driverFactory, logger, options)`（`OrchestratorApi.ts:35`）。`driverFactory` 是 `DriverFactoryByDataSource` 闭包，在 `ServerCore.getOrchestratorApi()`（`server.ts:603-666`）中构造，内部按 `(dataSource, preAggregations)` 缓存 driver Promise。`RefreshScheduler` 通过 `getQueryOrchestrator().getPreAggregations()` 直接访问预聚合队列调度刷新。
- **装配 api-gateway**：`ApiGateway` 接收 `getCompilerApi`/`getOrchestratorApi`/`refreshScheduler`/`dataSourceStorage`/`contextRejectionMiddleware`/`wsContextAcceptor` 等回调（`server.ts:469-496`）。ApiGateway 不直接依赖 CompilerApi/OrchestratorApi 类，只通过函数接口调用。
- **装配 driver 包**：`DriverResolvers` 动态 require 各 `@cubejs-backend/*-driver` 包；`cubestore-driver` 作为 external driver 独立注入。
- **被 cubejs-server 包装**：`CubejsServer`（`cubejs-server/src/server.ts:49`）在 `CubejsServerCore` 之上增加 Express 中间件、HTTP server 生命周期（gracefulHttp/keepAlive/headersTimeout）、WebSocket、SQL Server、信号处理。

---

## 扩展方式

### 新增一种数据源驱动集成

1. 发布 npm 包 `@cubejs-backend/<type>-driver`，实现 `BaseDriver` 接口（含 `query`、`stream`、`testConnection` 等），并导出 `dialectClass` 返回继承 `BaseQuery` 的 Query 子类。
2. 在 `DriverDependencies.ts:4` 的映射表添加 `'<type>': '@cubejs-backend/<type>-driver'`（或依赖 fallback 自动发现）。
3. 如驱动有特化 SQL 语法，在 Query 子类覆盖 `convertTz`/`timeGroupedColumn`/`sqlTemplates`/`newParamAllocator` 等模板方法。
4. 配置 `CUBEJS_DB_TYPE=<type>` 或多数据源 `CUBEJS_DS_<dataSource>_DB_TYPE=<type>`。

### 自定义 ContextAcceptor

1. 继承 `CubejsServerCore`，覆写 `createContextAcceptor()`（`server.ts:349`），返回自定义 `ContextAcceptor` 实现 `shouldAccept`/`shouldAcceptHttp`/`shouldAcceptWs`。
2. `ContextAcceptanceResult`（`types.ts:271`）已定义拒绝时的 `rejectStatusCode`/`rejectHeaders`/`message` 字段，`contextRejectionMiddleware`（`server.ts:508`）会读取这些字段返回对应 HTTP 响应。

### 自定义 queryRewrite

在 `CreateOptions.queryRewrite` 传入函数，经由 `server.ts:482` 传给 `ApiGateway`，后者在 `getNormalizedQueries` 中（`gateway.ts:1401`）查询执行前调用它改写查询。**无需修改 server-core 代码，纯配置注入**——这是依赖注入设计带来的扩展便利。
