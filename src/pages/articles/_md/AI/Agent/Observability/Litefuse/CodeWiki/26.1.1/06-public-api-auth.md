---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "公开 API 与鉴权"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "Public API", "API Key", "RBAC", "限流"]
description: "Litefuse 公开 API 与鉴权：createAuthedProjectAPIRoute 中间件工厂、project/org 两级 API key 双哈希、RateLimitService 按计划限流、过滤构建。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/00-overview)

---

## 模块定位

公开 API 是 Litefuse 对外的安全边界——SDK 与外部系统通过 `/api/public` 写入事件、查询数据、配置 webhook。它独立成模块，是因为鉴权（project/org 两级 API key）、限流（按 plan）、过滤构建都有专门逻辑，且必须与内部 tRPC API 区分（tRPC 给浏览器用户，公开 API 给程序化 SDK）。这一层只做鉴权+限流+入队/查询，不做重活——写入异步交给 worker。

## 模块架构

核心是 `createAuthedProjectAPIRoute`（中间件工厂，串联 verifyAuth → 限流 → Zod parse → OTel context → 业务 fn）。鉴权由 `ApiAuthService.verifyAuthHeaderAndReturnScope`（Basic auth 双哈希校验）+ Admin auth（self-hosted only）组成。限流由 `RateLimitService` 单例（`RateLimiterRedis` + ioredis）按 plan × resource 二维查表。查询过滤由 `filter-builder.ts` 把 REST 参数适配为 Doris SQL filter。

## 调用链路

```
写入路径 (SDK POST):
  /api/public/otel/v1/traces (web/src/pages/api/public/otel/v1/traces/index.ts:32)
    → withMiddlewares → createAuthedProjectAPIRoute (createAuthedProjectAPIRoute.ts:233)
        ├─ verifyAuth → verifyBasicAuth → ApiAuthService.verifyAuthHeaderAndReturnScope  (:64)
        ├─ RateLimitService.rateLimitRequest("ingestion")  (:260)
        └─ fn → OtelIngestionProcessor.publishToOtelIngestionQueue  (:183, S3 upload + OtelIngestionQueue 入队)
  /api/public/ingestion (ingestion.ts:50, legacy, OTel-only fork 后仅 score-create/sdk-log)
    → 直接 verifyAuthHeaderAndReturnScope (:76) → 限流 (:98) → processEventBatch (:166) → IngestionQueue 入队

查询路径 (GET /api/public/traces):
  → createAuthedProjectAPIRoute 鉴权 → 限流("public-api") → generateTracesForPublicApi (traces.ts) → queryDoris
  → scores 查询经 convertApiProvidedFilterToDorisFilter (filter-builder.ts:29) 构建 FilterList
```

## 核心实现

### createAuthedProjectAPIRoute 中间件工厂

```ts title="web/src/features/public-api/server/createAuthedProjectAPIRoute.ts:233"
// 接受 RouteConfig { querySchema, bodySchema, responseSchema, rateLimitResource, fn }
// 返回 Next.js route handler
// 内部串联: verifyAuth → RateLimitService.rateLimitRequest → Zod parse → OTel context → 业务 fn
// verifyAuth (:210) 分发: verifyBasicAuth (Basic, project 级) / verifyAdminApiKeyAuth (Admin, self-hosted only)
```

### API key 双哈希校验

`ApiAuthService.verifyAuthHeaderAndReturnScope`（`apiAuth.ts`）Basic auth 双层校验：先用 `createShaHash`（`apiKeys.ts:29`，SHA-256+salt）查 Redis/Prisma 的 `fastHashedSecretKey`；miss 时 fallback bcrypt `verifySecretKey`（`apiKeys.ts:24`）并回填 fast hash。返回 scope（projectId/orgId/plan/accessLevel）。`createAndAddApiKeysToDb`（`apiKeys.ts:39`）生成 `pk-lf-<uuid>`/`sk-lf-<uuid>`，bcrypt hash + SHA fast hash + display key 入库，按 scope 区分 projectId/orgId。

### RateLimitService 按计划限流

```ts title="web/src/features/public-api/server/RateLimitService.ts:27"
export class RateLimitService {  // 单例 getInstance
  rateLimitRequest(resource) → checkRateLimit → getRateLimitConfig (plan+resource 查表)
  // getPlanBasedRateLimitConfig (:214) 按 plan × resource 二维查表
  // rateLimiter.consume(scope.orgId) — 按 org 限流
  // self-hosted (无 CLOUD_REGION) 不限流 (:60); Redis 不可用 fail open (:68)
}
```

### webhook 签名

`generateWebhookSignature` / `createSignatureHeader`（`packages/shared/src/encryption/signature.ts:25/:37`）HMAC-SHA256 签 `timestamp.payload`，输出 `t=,v1=` 头，接收方按 timestamp 验时效防 replay。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 装饰器/中间件 | `createAuthedProjectAPIRoute`（`:233`）包裹业务 fn，注入 auth/query/body | 横切鉴权限流，不侵入业务 |
| 策略 | project vs org API key（`accessLevel`，`scope === "ORGANIZATION"`）；Basic vs Admin auth | 两级权限范围与两种鉴权方式 |
| 工厂 | `withMiddlewares`（`traces/index.ts:31`）按 HTTP method 聚合多个 route | 多 method 路由统一装配 |
| 单例 | `RateLimitService.getInstance` | 限流器全局唯一，复用 Redis 连接 |
| 策略表 | `getPlanBasedRateLimitConfig`（`:214`）plan × resource 二维查表 | 限流规则数据化，改规则不改代码 |
| 适配器 | `convertApiProvidedFilterToDorisFilter`（`filter-builder.ts:29`） | REST 参数适配为 Doris SQL filter |

## 模块间交互

- **Queues**：`processEventBatch` → `IngestionQueue`（`processEventBatch.ts:285`）；`OtelIngestionProcessor` → `OtelIngestionQueue`。shardingKey = `projectId-eventBodyId`。
- **Doris**：`generateTracesForPublicApi`/`getTracesFromEventsTableForPublicApi`（`traces/index.ts:129/157`）。
- **Prisma**：`ApiAuthService` 查 `apiKey`（含 project/organization）；`createAndAddApiKeysToDb` 写 key；`projectApiKeysRouter`/`organizationApiKeyRouter` 做 CRUD。
- **Redis**：API key 缓存（`fetchApiKeyAndAddToRedis`）、限流计数（`RateLimiterRedis`）、key 失效广播。
- **S3**：ingestion 事件 blob 存储 + event cache。
- **SDK 边界**：web 仅做鉴权+限流+入队，worker 消费队列做实际写入。

## 扩展方式

新增公开 API 端点：在 `web/src/pages/api/public/<resource>.ts` 加文件，`export default createAuthedProjectAPIRoute({ name, querySchema, responseSchema, rateLimitResource, fn })`，fn 内用 `auth.scope.projectId`；若 GET 查 Doris，需在 `traces.ts`/`scores.ts` 加 `generateXxxForPublicApi` 并配 `ApiColumnMapping` 给 filter-builder。改限流规则：改 `RateLimitService.ts` 的 `getPlanBasedRateLimitConfig`（`:214`）对应 plan+resource 的 points/durationInSec；或给特定 org 加 `rateLimitOverrides`。加 org 级权限：改 `organizationApiKeyRouter.ts` 加 tRPC procedure，`throwIfNoOrganizationAccess` 校验 scope `organization:CRUD_apiKeys`。对应测试：`web/src/__tests__/`。
