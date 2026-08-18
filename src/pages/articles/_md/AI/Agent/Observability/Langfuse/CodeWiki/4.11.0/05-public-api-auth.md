---
source:
  type: "源码解读"
  project: "Langfuse"
  url: "https://github.com/langfuse/langfuse"
title: "公开 API 与鉴权"
date: "2026-08-18T16:35:50+08:00"
category: ["AI", "Agent", "Observability", "Langfuse", CodeWiki, "4.11.0"]
tags: ["Langfuse", "tRPC", "REST API", "API Key", "Rate Limit"]
description: "Langfuse API 层：tRPC appRouter 聚合 60+ feature router、REST 公开 API、API key scope 鉴权、Redis 限流。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Langfuse/CodeWiki/4.11.0/00-overview)

---

## 模块定位

这是 Langfuse 对外的契约层。职责边界：把外部协议（REST HTTP、tRPC、OTLP、SCIM）与核心逻辑隔开——鉴权、限流、中间件编排、路由分发。两类 API：① 公开 REST API（SDK 和脚本调，`/api/public/*`）；② tRPC（前端 UI 调，`/api/trpc/*`，端到端类型安全）。它不写 ClickHouse（摄入端点只入队）、不做 eval 逻辑、不渲染 UI 组件。它是 [08-前端架构](./08-frontend-tracing-ui) 的服务端对应面。

## 模块架构

```
web/src/
├── pages/api/
│   ├── public/          # 30+ REST 端点（ingestion/otel/traces/scores/prompts/datasets/scim/…）
│   ├── trpc/[trpc].ts   # tRPC HTTP 入口（createNextApiHandler）
│   ├── auth/, project/, dashboard/, billing/, well-known/
├── features/public-api/server/
│   ├── apiAuth.ts                    # ApiAuthService（API key 鉴权）
│   ├── RateLimitService.ts           # 限流
│   ├── withMiddlewares.ts           # 中间件链组合
│   ├── createAuthedProjectAPIRoute.ts  # 鉴权路由工厂
│   ├── cors.ts, deprecations.ts, health-service.ts
│   ├── organizationApiKeyRouter.ts, projectApiKeyRouter.ts
│   └── unstable-public-api-route.ts
└── server/api/
    ├── root.ts          # appRouter 聚合 ~60 feature router
    ├── trpc.ts          # createTRPCContext + procedure 层级
    └── routers/         # 部分 router（traces/scores/observations 历史位置）

packages/shared/src/server/auth/
├── types.ts             # AuthHeaderVerificationResult, ApiAccessScope, ApiAccessLevel
├── apiKeys.ts           # createAndAddApiKeysToDb, hashSecretKey, createShaHash
├── apiKeyCache.ts       # Redis 缓存 key 前缀
└── invalidateApiKeys.ts  # 三级缓存失效
```

## 调用链路

```
REST 端点（ingestion 为例，手动中间件）:
ingestion.ts handler
  ├─ cors runMiddleware
  ├─ ApiAuthService.verifyAuthHeaderAndReturnScope(authorization)  // Basic Auth → Redis cache + PG
  │     → AuthHeaderValidVerificationResultIngestion { scope: {projectId, accessLevel} }
  ├─ RateLimitService.getInstance().rateLimitRequest(scope, "ingestion")  // 失败 fail-open
  └─ processEventBatch(...)

REST 资源端点（traces 为例，工厂封装）:
traces/index.ts
  └─ createAuthedProjectAPIRoute({
       middleware: [cors, rateLimit, ...],
       handler: async (req, res, ctx) => { /* ctx.scope 已校验 */ }
     })

tRPC:
前端组件 api.traces.all.useQuery(...)
  → createTRPCNext<AppRouter> → httpBatchLink/httpLink → POST /api/trpc
  → [trpc].ts createNextApiHandler({router: appRouter, createContext})
  → createTRPCContext: session = getServerAuthSession() → {session, headers, prisma}
  → appRouter.traces.all (protectedProjectProcedure)
      ├─ enforceUserIsAuthedAndProjectMember 中间件（解析 projectId, 注入 orgId/projectRole）
      └─ router 实现 → repositories → ClickHouse
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `ApiAuthService.verifyAuthHeaderAndReturnScope` (`apiAuth.ts`) | API key 鉴权 | Basic Auth 解析 publicKey:secretKey，Redis cache + PG hash 查 |
| `RateLimitService.rateLimitRequest(scope, resource)` (`RateLimitService.ts`) | 限流 | Redis-based，per project/key；失败 fail-open |
| `withMiddlewares(handlers)` (`withMiddlewares.ts`) | 中间件链组合 | cors → rateLimit → auth → handler |
| `createAuthedProjectAPIRoute` (`createAuthedProjectAPIRoute.ts`) | 鉴权路由工厂 | 封装中间件 + 注入校验后 ctx.scope |
| `createTRPCContext` (`server/api/trpc.ts`) | tRPC context 注入 | session + headers + prisma + OTel |
| `appRouter` (`server/api/root.ts`) | tRPC 根路由 | 聚合 ~60 feature router |
| `createAndAddApiKeysToDb` (`auth/apiKeys.ts`) | 创建 API key | hashSecretKey 存 PG |
| `invalidateApiKeys` (`auth/invalidateApiKeys.ts`) | 三级缓存失效 | key/org/project 粒度 |

</details>

## 核心实现

### API key 鉴权与 scope

API key 分 `ORGANIZATION` / `PROJECT` 两种 scope（`ApiKeyScope` enum，`schema.prisma`）。鉴权：客户端 Basic Auth `publicKey:secretKey` → `verifyAuthHeaderAndReturnScope` 用 Redis 缓存查 key（`apiKeyCache.ts`），miss 则查 Postgres（`createShaHash` hash 比对）。返回 `AuthHeaderVerificationResult`，scope 含 `projectId` / `accessLevel`（`"organization" | "project" | "scores"`）/ `orgId?` / `plan?` / `apiKeyId?` / `isIngestionSuspended?`。缓存失效是三级（key/org/project 粒度，`invalidateApiKeys.ts`），改 key 后能及时生效。

### 限流

`RateLimitService`（Redis-based）按 project/key 维度限流，`RateLimitResource` 枚举区分资源（ingestion / 一般 API / scores 等）。**失败 fail-open**：限流服务本身异常时 catch + log 后继续处理，不因限流故障拒绝请求。

### tRPC procedure 层级

`server/api/trpc.ts` 定义 context + procedure 层级（权限递增）：

| Procedure | 中间件 | 用途 |
|-----------|--------|------|
| `publicProcedure` | OTel + errorHandling | 公开接口 |
| `authenticatedProcedure` | + enforceUserIsAuthed | 仅需登录 |
| `protectedProjectProcedure` | + enforceUserIsAuthedAndProjectMember | 项目成员校验，注入 projectId/orgId/projectRole |
| `protectedGetTraceProcedure` | + enforceTraceAccess("v3") | trace 级权限，中间件预取 trace |
| `protectedGetEventsTraceProcedure` | + enforceTraceAccess("v4") | 同上但从 events 表读 |
| `protectedOrganizationProcedure` | + enforceIsAuthedAndOrgMember | 组织级权限 |
| `adminProcedure` | + enforceAdminAuth | Admin API Key |

`enforceTraceAccess` 是特殊的"资源级权限"：中间件预取 trace（`getTraceById` 或 `getTraceByIdFromEventsTable`，`excludeInputOutput: true`），判断 trace 是否 public 或用户是否项目成员，ctx 里已有 trace——router 内部不重复查。

### appRouter 聚合

`server/api/root.ts` 手动聚合 ~60 feature router（traces/evals/datasets/dashboard/prompts/experiments/observations/scores/sessions/organizations/projects/table/batchAction/automations/monitors/…）。ee 的 router（cloudBilling/ssoConfig/verifiedDomain/uiCustomization/adminApi）直接导入混在同一 appRouter。`export type AppRouter = typeof appRouter` 是前端类型推断的唯一来源。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Middleware chain | `withMiddlewares` 组合 | 声明式编排 cors/rateLimit/auth |
| Route factory | `createAuthedProjectAPIRoute` | 封装鉴权+限流，端点只写业务 |
| Scope-based auth | project vs org scope | 不同 API 操作粒度 |
| Redis-based rate limit | `RateLimitService` | 分布式限流，多实例一致；fail-open 保可用 |
| tRPC 端到端类型 | `appRouter` + `createTRPCNext` | 无 OpenAPI codegen，schema 即类型 |
| Feature-based routers | 每 feature 一个 router 加入 appRouter | feature 内聚，router 与 UI 共存 |
| 中间件预取资源 | `enforceTraceAccess` | 权限校验顺便预取 trace，router 不重复查 |
| 三级缓存失效 | `invalidateApiKeys` key/org/project | 改 key 后及时生效 |

## 模块间交互

依赖 `@langfuse/shared`（auth、redis、prisma、repositories）、`processEventBatch`、tRPC。被 SDK（REST）、浏览器（tRPC）、OTLP exporter（otel 端点）、IdP（SCIM）调用。与 [01-摄入管线](./01-ingestion-pipeline) 的分工：public-api 提供鉴权/限流/中间件框架，ingestion.ts 用它但额外调 `processEventBatch` 做重活——ingestion 端点用手动中间件而非 `createAuthedProjectAPIRoute`，因为它需要自定义 body size limit（4.5mb）和 batch 处理逻辑。

## 扩展方式

**新增一个公开 REST 端点**：
1. `web/src/pages/api/public/<resource>/index.ts`：用 `createAuthedProjectAPIRoute({middleware:[cors,rateLimit,...], handler})` 封装
2. 如有新资源类型，`features/public-api/types/` 加 zod schema
3. `fern/apis/` 更新 API 定义 + 重新生成（公开契约走 Fern）

**新增一个 tRPC procedure**：
1. 对应 feature 的 `server/router.ts`（或 `server/api/routers/`）加 procedure：
   ```typescript title="router.ts"
   myProc: protectedProjectProcedure
     .input(z.object({projectId: z.string(), filter: z.array(singleFilter).nullable()}))
     .query(async ({input, ctx}) => { /* 调 repository */ }),
   ```
2. 前端直接 `api.traces.myProc.useQuery(...)`——类型自动推断，无需额外定义

**新增一个 API key scope**：
1. `schema.prisma`：`ApiKeyScope` enum 加值
2. `auth/types.ts`：`ApiAccessLevel` 类型扩展
3. 鉴权逻辑 `apiAuth.ts`：scope 校验加分支

> SCIM 端点（`/api/public/scim/*`）用 org-scoped key 做 SSO 用户同步（ServiceProviderConfig / Schemas / ResourceTypes / Users）。playground 的 `chatCompletionHandler.ts` 走独立 Next.js API route + 自定义 auth + SSE 流式（tRPC 不原生支持 SSE streaming）。
