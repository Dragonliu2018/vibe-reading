---
source:
  type: "源码解读"
  project: "Cube"
  url: "https://github.com/cube-js/cube"
title: "API 网关"
date: "2026-08-17T22:20:51+08:00"
category: [Database, Ecosystems, Cube, CodeWiki, "1.7.20"]
tags: ["Cube", "TypeScript", "REST", "GraphQL", "SQL", "WebSocket"]
description: "REST/GraphQL/SQL/WS 四协议统一汇聚到语义层"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/00-overview)

---

## 模块定位

`cubejs-api-gateway` 是 Cube.js 对外暴露的**接口层**——语义层只定义一次，但下游消费者（BI 工具、前端 SDK、AI agent、实时仪表盘）各有偏好的协议。api-gateway 的职责是把 REST、GraphQL、SQL（pg-wire）、WebSocket 四种协议的请求，统一翻译成对 `CompilerApi`（编译）和 `OrchestratorApi`（执行）的调用，并处理鉴权、请求上下文、订阅推送。

本模块共 6,056 行 TypeScript、24 个文件，核心入口是 `gateway.ts`（2,964 行）的 `ApiGateway` 类。它不承载业务逻辑，只做协议适配与请求编排——这是 headless BI 的关键设计：**协议多样性，语义层单一性**。

项目边界：api-gateway 不负责 SQL 生成（schema-compiler）、查询执行与缓存（query-orchestrator）、数据源连接（driver 包），它只负责"把外部协议请求转成内部语义调用"。

---

## 模块架构

```
                        ┌─────────────────────────────────────┐
                        │           cubejs-server              │
                        │  Express + WebSocketServer(5s 轮询)  │
                        └────────────────┬────────────────────┘
                                         │ initApp / initSubscriptionServer
                                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                      api-gateway (本模块)                         │
│                                                                  │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ REST 路由 │  │ GraphQL   │  │ SQLServer │  │SubscriptionSvr│  │
│  │ /load    │  │ /graphql  │  │ pg-wire   │  │  (WebSocket)  │  │
│  │ /sql     │  │ makeSchema│  │  桥接     │  │ processSubs   │  │
│  │ /meta    │  │           │  │           │  │               │  │
│  └────┬─────┘  └─────┬─────┘  └─────┬─────┘  └──────┬────────┘  │
│       │              │ getJsonQuery() │ sqlApiLoad   │           │
│       └──────────────┴────────┬───────┴──────────────┘           │
│                               ▼                                  │
│            ┌──────────────────────────────────┐                 │
│            │   ApiGateway 核心方法              │                 │
│            │  load() / sqlApiLoad() / subscribe│                 │
│            │  getNormalizedQueries (RLS+重写)  │                 │
│            └───────────────┬──────────────────┘                 │
│                            │                                     │
│  ┌─────────────────────────▼────────────────────┐               │
│  │  Middleware Chain                             │               │
│  │  checkAuth → requestContext → rejection → log │               │
│  └───────────────────────────────────────────────┘               │
│                                                                  │
│  helpers/ (prepare-annotation, transform-meta-extended)          │
│  types/ (query, request, auth, enums, strings, responses)        │
│  jwk.ts (JWK 拉取缓存)   cached-handler.ts (健康检查 coalescing)│
└─────────────────────────────┬────────────────────────────────────┘
                              │ compilerApi(ctx) / adapterApi(ctx)
                              ▼
                   server-core (CompilerApi / OrchestratorApi)
```

api-gateway 内部由五个核心组件构成：

- **`ApiGateway`**（`gateway.ts:138`）：主网关类，注册路由、组装中间件链、承载 `load()`/`sql()`/`subscribe()`/`meta()` 等核心方法。
- **`SQLServer`**（`sql-server.ts:41`）：SQL 协议桥接，通过 `@cubejs-backend/native` 的 `registerInterface()` 把 Rust pg-wire 的回调绑定到 gateway 方法。
- **`SubscriptionServer`**（`ws/subscription-server.ts:32`）：WebSocket 订阅消息分发与轮询推送。
- **`LocalSubscriptionStore`**（`ws/local-subscription-store.ts:16`）：内存订阅存储，按 connectionId 管理订阅与 auth context。
- **GraphQL schema 构建**（`graphql.ts`）：函数式（非类），`makeSchema()` 从 metaConfig 动态生成 Nexus Schema。

这种划分的逻辑主线是"按协议隔离"——每种协议有自己的入口组件，但都汇聚到 `ApiGateway` 的统一方法。helpers 和 types 是横切的支撑层。

---

## 调用链路

```
HTTP /cubejs-api/v1/load
  │
  ├── [Middleware Chain]  (gateway.ts:241-247)
  │   checkAuth → requestContextMiddleware → contextRejectionMiddleware
  │              → logNetworkUsage → requestLoggerMiddleware
  │
  ├── load(request)  (gateway.ts:2014)
  │   ├── assertApiScope('data', securityContext)         (gateway.ts:2717)
  │   ├── getNormalizedQueries(query, context, ...)       (gateway.ts:1328)
  │   │   ├── normalizeQuery()  (query.js)
  │   │   ├── compilerApi.applyRowLevelSecurity()         (RLS 行级安全)
  │   │   └── queryRewrite()  (用户自定义查询改写钩子)
  │   ├── compilerApi.metaConfig(context)                 (可见性过滤)
  │   ├── getSqlQueriesInternal() → compilerApi.getSql()  (gateway.ts:1771)
  │   ├── getSqlResponseInternal() → adapterApi.executeQuery()  (gateway.ts:1829)
  │   ├── prepareAnnotation()  (helpers/prepare-annotation.ts)
  │   └── prepareResultTransformData() → res(result)      (gateway.ts:1897)
  │
  └── [异常] handleError()  (gateway.ts:2405)

HTTP /cubejs-api/graphql
  │
  ├── [同 REST Middleware Chain]
  ├── assertApiScope('graphql', ...)
  ├── graphqlHTTP({ schema, context })  (express-graphql)
  │   ├── compilerApi.getGraphQLSchema()  (缓存命中?)
  │   │   └── 未命中 → makeSchema(metaConfig)  (graphql.ts:494)
  │   └── resolve(_, args, ctx, info)
  │       └── getJsonQuery(metaConfig, args, info)  (graphql.ts:365)
  │           └── apiGateway.load({ query, apiType: 'graphql' })
  │               └── [复用 REST load() 流程]

WebSocket 订阅
  │
  ├── ws.on('connection') → connectionId
  ├── 客户端 { authorization: "JWT..." }
  │   └── SubscriptionServer.processMessage()  (subscription-server.ts:92)
  │       └── handleMessage() → checkAuthFn → setAuthContext
  ├── 客户端 { method: "subscribe", params: { query } }
  │   └── apiGateway.subscribe()  (gateway.ts:2290)
  │       ├── load({ query, res: collector })  (首次执行，拦截 res 做状态对比)
  │       └── subscriptionStore.subscribe()  (存储订阅+状态)
  └── [轮询] WebSocketServer 每 5s → processSubscriptions()  (subscription-server.ts:227)
      └── 重新 load() → JSON.stringify 对比 → 有变化则推送
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `initApp(app)` | `gateway.ts:240` | 注册路由与中间件链 |
| `load(request)` | `gateway.ts:2014` | `/load` 入口，REST 查询主方法 |
| `sqlApiLoad(request)` | `gateway.ts:2141` | SQL API 内部 load（被 Rust 回调） |
| `subscribe(request)` | `gateway.ts:2290` | WebSocket 订阅，拦截 res 做状态对比 |
| `meta({ context, res })` | `gateway.ts:689` | 返回 cube/dimension/measure 元数据 |
| `getNormalizedQueries()` | `gateway.ts:1328` | 查询归一化 + RLS + queryRewrite |
| `getSqlQueriesInternal()` | `gateway.ts:1771` | 调 compilerApi.getSql 编译 SQL |
| `getSqlResponseInternal()` | `gateway.ts:1829` | 调 adapterApi.executeQuery 执行 |
| `assertApiScope(scope, ctx)` | `gateway.ts:2717` | 校验 API scope 权限 |
| `handleError({ e, ... })` | `gateway.ts:2405` | 统一错误处理 |
| `createDefaultCheckAuth()` | `gateway.ts:2513` | 默认 JWT 验签策略 |
| `contextByReq(req, ...)` | `gateway.ts:2379` | 构造请求上下文 |
| `makeSchema(metaConfig)` | `graphql.ts:494` | 动态生成 GraphQL Schema |
| `getJsonQuery(metaConfig, args, info)` | `graphql.ts:365` | GraphQL AST → Cube JSON Query |
| `processSubscriptions()` | `subscription-server.ts:227` | 轮询所有订阅重新查询推送 |

</details>

三条链路的关键设计是**统一汇聚**：REST 直接进 `load()`，GraphQL 先把 AST 转成 JSON Query 再调 `load()`，SQL 路径通过 Rust pg-wire 经 `sqlApiLoad()` 回调也进 `load()` 管道。这样 RLS、queryRewrite、编译、执行、结果转换的逻辑只写一份。

---

## 核心实现

### 四协议统一到 load() 管道

`ApiGateway` 是所有协议的汇聚点。它的构造器接收的不是 `CompilerApi`/`OrchestratorApi` 实例，而是两个**函数**：

```typescript title="packages/cubejs-api-gateway/src/gateway.ts"
class ApiGateway {
  constructor(
    protected readonly apiSecret: string,
    protected readonly compilerApi: (ctx: RequestContext) => Promise<any>,
    protected readonly adapterApi: (ctx: RequestContext) => Promise<any>,
    protected readonly logger: LoggerFn,
    protected readonly options: ApiGatewayOptions,
  )
}
```

**为什么是函数而不是实例**：多租户部署中，不同请求的 `context`（含 `securityContext`、`requestId`）对应不同的 CompilerApi/OrchestratorApi 实例（由 server-core 的 `contextToAppId`/`contextToOrchestratorId` 决定）。传函数让 gateway 每次请求按 context 懒加载对应实例，而不是持有单一全局实例。这是依赖注入的关键——gateway 不依赖具体类，只依赖函数接口。

`load()` 方法（`gateway.ts:2014`）是查询的核心模板，所有查询类方法都遵循同一流程：

```
assertApiScope → parseQueryParam → getNormalizedQueries → compilerApi.getSql
→ adapterApi.executeQuery → prepareAnnotation → prepareResultTransformData → res(result)
```

`sql()`、`dryRun()`、`sqlApiLoad()`、`subscribe()` 都是这个模板的变体——差异仅在参数处理和结果格式化。`subscribe()`（`gateway.ts:2290`）是特殊变体：它内部调 `load()` 但用 `collector` 拦截 `res` 回调，做新旧结果对比后再决定是否推送。

`getNormalizedQueries()`（`gateway.ts:1328`）是统一管道的关键入口，它依次做：`compareDateRangeTransformer()` 判断查询类型（regular/compareDateRange/blending）→ `normalizeQuery()` 规范化 → `compilerApi.applyRowLevelSecurity()` 行级安全 → `queryRewrite()` 用户自定义改写。这四步对所有协议一致，确保无论从哪个协议进来，最终送给 orchestrator 的 `QueryBody` 语义相同。

### JWT 与 JWK 三模式鉴权

鉴权由中间件链的第一环 `checkAuth`（`gateway.ts:2787`）处理，策略选择在 `createDefaultCheckAuth()`（`gateway.ts:2513`）和 `createCheckAuthFn()`（`gateway.ts:2635`）中完成。三种模式：

1. **HMAC 对称密钥**（默认）：用 `apiSecret` 或 `apiSecrets`（支持密钥轮换）验签 JWT。轮换逻辑遍历所有 candidate secrets，任一通过即接受；但 `TokenExpiredError`/`NotBeforeError` 立即抛出（`gateway.ts:2548-2550`），不因轮换掩盖 token 过期。**为什么**：过期是绝对状态，不应因密钥轮换而误判有效。

2. **JWK 公钥**（`jwkUrl` 配置）：从 JWK URL 拉取公钥集，按 JWT header 的 `kid` 匹配。`jwk.ts` 的 `createJWKsFetcher()` 用 `asyncMemoizeBackground` 做后台缓存刷新（默认 60s 间隔），`parseCacheControl()`（`jwk.ts:22`）解析 HTTP `Cache-Control` 的 `max-age` 决定 TTL。找不到 kid 时，超过 `jwkRefetchWindow`（默认 60s）会 `force()` 重新拉取（`jwk.ts:131-137`）。**为什么**：应对密钥轮换场景——IdP 轮换签名密钥后，旧 kid 查不到必须能强制刷新。

3. **自定义 `checkAuth`**：用户传入函数完全接管，`wrapCheckAuth()`（`gateway.ts:2465`）包装，处理 `authInfo` → `securityContext` 的向后兼容迁移。

此外还有独立的 **Playground 鉴权**（`playgroundAuthSecret`，`gateway.ts:2640-2658`）：先尝试主鉴权，失败后尝试 playground 鉴权，用于 Cube Cloud Playground 访问 `/cubejs-system/` 路由。

`assertApiScope()`（`gateway.ts:2717`）在鉴权后做 scope 校验，scope 类型定义在 `types/strings.ts`：`ApiScopes = graphql | meta | data | sql | jobs`。`contextToApiScopesFn` 可由用户自定义映射，默认返回 `['graphql', 'meta', 'data', 'sql']`。

### 轮询式实时订阅

订阅的"实时"是**轮询式**而非事件驱动。`SubscriptionServer.processSubscriptions()`（`subscription-server.ts:227`）由 cubejs-server 的 `WebSocketServer` 每 5 秒调用一次，对每个订阅重新执行完整 `load()` 查询，用 `JSON.stringify` 对比新旧结果，仅在变化时推送。

```typescript title="packages/cubejs-api-gateway/src/gateway.ts"
// gateway.ts:2308 注释:
// TODO subscribe to refreshKeys instead of constantly firing load
await this.load({ query, context, res: collector, ... });
```

代码里明确标注了 TODO——未来计划改为基于 refresh key 的事件驱动推送，当前轮询是工程简化妥协。**为什么当前用轮询**：refresh key 变更事件的订阅机制需要 orchestrator 暴露事件接口，工程复杂度高；轮询虽然每 5 秒全量重查，但实现简单且对短查询开销可控。

订阅存储有过期机制：`LocalSubscriptionStore.getAllSubscriptions()`（`local-subscription-store.ts:56`）清理超过 `heartBeatInterval * 4`（默认 240s）的订阅，防止客户端断连后订阅残留。

订阅消息处理走 `processMessage()`（`subscription-server.ts:92`）→ `handleMessage()`（`:109`）分发。消息校验用 Zod schema（`ws/message-schema.ts`），`methodMessageSchema` 是 discriminated union，按 `method` 字段路由到 `subscribe`/`unsubscribe` 等。

### SQL API 复用语义层

SQL API 有多种模式，核心是 `SQLServer`（`sql-server.ts:41`）通过 `@cubejs-backend/native` 桥接 Rust pg-wire：

```typescript title="packages/cubejs-api-gateway/src/sql-server.ts"
class SQLServer {
  protected sqlInterfaceInstance: SqlInterfaceInstance | null;
  constructor(protected readonly apiGateway: ApiGateway, options: SQLServerConstructorOptions)
  public async init(options: SQLServerOptions): Promise<void>   // L96, registerInterface 注册 native 回调
  public async execSql(sqlQuery, stream, securityContext?, ...): Promise<void>  // L79
}
```

`SQLServer.init()`（`sql-server.ts:96`）调 `registerInterface()` 注册一组回调给 Rust 侧的 `NodeBridgeTransport`：`on_meta`（获取 schema 元数据）→ `ApiGateway.meta()`、`on_sql_api_load`（执行查询）→ `ApiGateway.sqlApiLoad()`、`on_sql`（编译 SQL）→ `ApiGateway.sql()`、`checkAuth`/`checkSqlAuth`（鉴权）、`stream`（流式查询）。

当 BI 工具通过 pg-wire 发来 SQL，Rust 侧 `CubeSQL` 解析 SQL 并转为 `CubeScanNode`，执行时通过 napi 回调 `sqlApiLoad()`——这最终走的是与 REST 完全相同的 `load()` 管道。**为什么这样设计**：让标准 PostgreSQL 驱动能直接连 Cube，BI 工具（Tableau/Metabase/Superset）无需改造，但底层复用语义层的 RBAC、预聚合、缓存。

除了 pg-wire，还有三种 SQL 相关 HTTP 端点：
- **`/v1/cubesql`**（`gateway.ts:469`）：POST SQL 字符串，调 `sqlServer.execSql()` → native 执行，支持流式响应（Transfer-Encoding: chunked）。
- **`/v1/sql?format=sql`**（`gateway.ts:375`）：输入 Cube Query，输出生成的 SQL（不执行），供调试。
- **`/v1/convert-query`**（`gateway.ts:428`）：输入 SQL，输出等价的 REST Query JSON。

`SQLServer.contextByRequest()`（`sql-server.ts:106`）还支持 `__user` 切换：SQL 查询中可通过 `__user` 语法切换 security context（需 `canSwitchSqlUser` 授权），实现多租户 SQL 查询。

### GraphQL Schema 缓存与 RBAC 分离

GraphQL schema 由 `makeSchema()`（`graphql.ts:494`）从 `metaConfig` 动态生成——每个 cube 变成 `objectType({ name: "XxxMembers" })` + `WhereInput` + `OrderByInput`，根 `Query.cube` 字段的 resolver 把 GraphQL AST 转成 Cube JSON Query。

关键决策在 schema 缓存与 RBAC 的分离（`gateway.ts:301-310`）：

```typescript title="packages/cubejs-api-gateway/src/gateway.ts"
// Cache unfiltered schema - RBAC enforcement happens at query execution time
// via annotation-based validation in the Rust result transform layer
let schema = compilerApi.getGraphQLSchema();
if (!schema) {
  const metaConfig = await compilerApi.metaConfig(req.context, {
    requestId: req.context.requestId,
    skipVisibilityPatch: true,   // 跳过可见性补丁
  });
  schema = makeSchema(metaConfig);
  compilerApi.setGraphQLSchema(schema);
}
```

Schema 缓存为**未过滤的全量 schema**，不按 security context 分别缓存。**为什么不按租户缓存**：为每个 security context 生成独立 Schema 开销大（cube 数量多时 Schema 构建昂贵），且缓存键难设计。RBAC 改在两个层面执行：(1) 查询时 `filterVisibleItemsInMeta()`（`gateway.ts:639`）过滤不可见 member；(2) 执行时 `applyRowLevelSecurity()` 添加行级安全条件。这样一份 Schema 服务所有租户，可见性在查询时动态过滤。

`getJsonQuery()`（`graphql.ts:365`）负责 GraphQL AST 到 Cube JSON Query 的转换：`whereArgToQueryFilters()` 把 GraphQL where 转成 Cube filter 格式，遍历 `fieldNodes` 区分 measures/dimensions/timeDimensions，`inDateRange` 过滤器下推到 timeDimensions。

---

## 设计模式

| 模式 | 位置（文件:方法） | 为什么用 |
|------|-------------------|----------|
| 中间件 / 责任链 | `gateway.ts:241-247` `initApp` 中间件链 | Express 中间件按序执行，每层可短路（checkAuth 失败直接 403），解耦鉴权/上下文/日志 |
| 策略 | `gateway.ts:2635` `createCheckAuthFn`；`gateway.ts:2513` `createDefaultCheckAuth` | 鉴权方式按配置选择（HMAC/JWK/自定义），可替换 |
| 模板方法 | `gateway.ts` `load()`/`sql()`/`dryRun()`/`sqlApiLoad()` | 查询类方法遵循统一流程模板，差异仅在参数处理与结果格式化 |
| 观察者 / 发布订阅 | `ws/subscription-server.ts:227` `processSubscriptions` | 订阅者注册到 store，定时器驱动轮询推送（pull-based 而非事件驱动） |
| 适配器 / 桥接 | `sql-server.ts:96` `init` 通过 `registerInterface` 桥接 | native pg-wire 协议请求经回调转换为 gateway 方法调用，隔离协议细节 |

---

## 模块间交互

api-gateway 是上层，通过函数注入依赖下层：

| 依赖包 | 用途 | 关键导入 |
|--------|------|----------|
| `@cubejs-backend/query-orchestrator` | `QueryBody` 类型 | `gateway.ts:34` |
| `@cubejs-backend/native` | `ResultWrapper`/`registerInterface`/`execSql` | `gateway.ts:18-23`，`sql-server.ts:1-14` |
| `@cubejs-backend/shared` | `getEnv`/`CacheMode`/`asyncMemoizeBackground` | `gateway.ts:10-17` |
| `jsonwebtoken` | JWT 验签 | `gateway.ts:4` |
| `express-graphql` | GraphQL HTTP 中间件 | `gateway.ts:8` |
| `nexus` + `graphql` | GraphQL Schema 声明式构建 | `graphql.ts:13-27` |
| `zod` | WS 消息 schema 校验 | `ws/message-schema.ts:1` |

**被 server-core 装配**：server-core 的 `createApiGatewayInstance()`（`server.ts:498`）把 `this.getCompilerApi.bind(this)` 和 `this.getOrchestratorApi.bind(this)` 作为函数传入，同时注入 `checkAuth`、`queryRewrite`、`refreshScheduler`、`contextRejectionMiddleware`、`wsContextAcceptor` 等。ApiGateway 不直接依赖 CompilerApi/OrchestratorApi 类，只通过函数接口调用 `compilerApi.metaConfig()`、`compilerApi.getSql()`、`adapterApi.executeQuery()`。

cubejs-server 的 `WebSocketServer` 调 `serverCore.initSubscriptionServer(sendMessage)` 获取 `SubscriptionServer` 实例，并以 5 秒间隔调 `processSubscriptions()` 驱动订阅轮询。

---

## 扩展方式

### 新增一个 API 端点（如 `/v1/export`）

1. `gateway.ts` `initApp()`（L240）：添加路由注册 `app.post('/v1/export', ...)`
2. `gateway.ts`：新增 `export()` 方法，遵循模板：`assertApiScope` → `getNormalizedQueries` → `compilerApi`/`adapterApi` → `res`
3. 若需新 scope：`types/strings.ts`（L107-112）添加 scope 名，`gateway.ts:2698` 校验列表同步
4. `types/request.ts`：如需新请求类型，扩展 `BaseRequest`

### 新增鉴权方式（如 OAuth2 / API Key）

1. `gateway.ts` `createCheckAuthFn()`（L2635）：添加新策略分支
2. `gateway.ts`：新增 `createOAuth2CheckAuth()` 方法
3. `types/auth.ts`（L26-40）：添加 OAuth2 配置字段
4. `types/gateway.ts` `ApiGatewayOptions`（L58-81）：添加 `oauth2?` 选项
5. `server-core` `server.ts`：在 `createApiGatewayInstance` options 中透传新配置

### 新增 WS 消息类型（如 `/v1/schema` 实时推送）

1. `ws/message-schema.ts`（L25-64）：在 `methodMessageSchema` 的 discriminatedUnion 中添加 literal
2. `ws/subscription-server.ts` `methodParams`（L17-24）：添加消息方法映射
3. `gateway.ts`：实现 `schema()` 方法，`handleMessage` 通过 `method.replace` 动态调用（L191）
