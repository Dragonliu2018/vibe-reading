---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "领域数据模型"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "Prisma", "PostgreSQL", "Doris", "Repository"]
description: "Litefuse 领域数据模型：Prisma PG 元数据 + Doris 事件双库分工、domain Zod schema、repositories 转换器、API key 与 LLM key 加密。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/00-overview)

---

## 模块定位

这一层定义 Litefuse 的核心领域对象（Trace/Observation/Score/Dataset/Prompt/EvalConfig）与持久化分层——**Postgres（Prisma）存事务性元数据/配置，Doris 存海量分析事件**的职责切分。它是双库映射的中枢：domain Zod schema 描述领域对象，`repositories/definitions.ts` 描述 Doris 行 schema，`*_converters.ts` 在两者间转换。它独立成模块，是因为 web tRPC 与 worker 共享同一套 repositories 函数，保证两端读写逻辑一致。

## 模块架构

四层：领域对象（`domain/*.ts`，Zod）→ Doris 行 schema（`repositories/definitions.ts`）→ 查询/写入函数（`repositories/*.ts`）→ 转换器（`*_converters.ts`）。Prisma schema（`prisma/schema.prisma`，1640 行）定义 PG 侧 `Project`/`Organization`/`User`/`ApiKey`/`ScoreConfig`/`Dataset`/`Prompt`/`TraceSession`/`JobExecution` 等。`repositories/index.ts` 统一 re-export，被 web 与 worker 共享。

## 调用链路

```
写流程 (ingestion → Doris):
  SDK OTel spans → OtelIngestionProcessor.publishToOtelIngestionQueue → S3 + 入队
  → worker 消费 → processToIngestionEvents → EventRecordInsertType[]
  → upsertDoris (repositories/doris.ts:26) → dorisClient().streamLoad("events_full", records) (:45)  Doris Unique Key 自动去重 upsert
  → Score 写: upsertScore (scores.ts:143) → upsertDoris({table:"scores"})
  → PG 侧: prisma.scoreConfig.findFirst (validateAndInflateScore.ts:27) 校验 config; prisma.model.findMany (observations.ts:642) enrich model

读流程 (tRPC → repository → Doris):
  tRPC handler → getTracesByIds (repositories/traces.ts:263)
  → buildTraceAggregationQuery (traces.ts:33, 双 CTE: trace_scalars MAX_BY 聚合 + trace_root ROW_NUMBER 取 root span)
  → queryDoris (doris.ts:143) → DorisParameterProcessor → dorisClient().queryWithParams
  → zipDorisMetadataArrays + convertDorisToDomain (traces_converters.ts:46) → 返回 TraceDomain[]

部分更新: updateEvents (events.ts:1343) → partialUpdateDoris (doris.ts:75) → UPDATE events_full SET ... WHERE project_id=...
```

## 核心实现

### Prisma 模型（PG 侧）

```prisma title="packages/shared/prisma/schema.prisma"
model Project {                 // :124  tenant 边界
  id String @id @default(cuid())
  orgId String @map("org_id")
  organization Organization @relation(...)
  apiKeys ApiKey[]; scoreConfig ScoreConfig[]; dataset Dataset[]; Prompt Prompt[]
  // ... 40+ 关系
}
model ApiKey {                  // :190  双哈希
  publicKey String @unique @map("public_key")
  hashedSecretKey String @unique @map("hashed_secret_key")       // bcrypt
  fastHashedSecretKey String? @unique @map("fast_hashed_secret_key") // SHA-256
  scope ApiKeyScope @default(PROJECT)
}
model TraceSession { id ...; projectId ...; bookmarked Boolean; public Boolean; @@id([id, projectId]) }  // :317
model ScoreConfig { projectId ...; name ...; dataType ScoreConfigDataType; isArchived Boolean }  // :480
// LegacyPrismaTrace/Observation/Score (:332/363/439) 旧 PG 宽表，迁移到 Doris 用
```

### Domain Zod schema

`TraceDomain`（`domain/traces.ts:18`）19 字段；`ObservationSchema`（`observations.ts:65`）含 `type/level/usageDetails/costDetails/toolCalls` 及 `EventsObservationSchema`（扩展 `userId/sessionId/traceName`）；`ScoreSchema`（`scores.ts:85`）discriminatedUnion by `dataType`（NUMERIC/CATEGORICAL/BOOLEAN/CORRECTION/TEXT）。

### Repository 与转换器

`definitions.ts`（770 行）定义 Doris 行 schema（`traceRecordReadSchema`/`observationRecordReadSchema`/`scoreRecordReadSchema`/`eventRecordBaseSchema`，后者 60+ 字段全 denormalize）+ PG→Doris 转换器（`convertPostgresTraceToInsert` 等）。`traces_converters.ts:convertDorisToDomain/convertTraceDomainToDoris`、`scores_converters.ts:convertDorisScoreToDomain` 做双向映射。

### 加密

`encryption/encryption.ts:encrypt/decrypt`（AES-256-GCM，输出 `iv:ciphertext:authTag` hex）；`auth/apiKeys.ts:hashSecretKey`（bcrypt cost=11）/`createShaHash`（SHA-256）。`LlmApiKeys.secretKey` 用 `encrypt()` 可逆加密（调 LLM 时 `decrypt`，`fetchLLMCompletion.ts:151`）；`ApiKey.hashedSecretKey` 用 bcrypt 不可逆哈希，`fastHashedSecretKey` 用 SHA-256 快速查找；webhook headers 走 `encryptSecretHeaders`（`headerUtils.ts:39`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Repository 封装双库 | `doris.ts:queryDoris/commandDoris/upsertDoris/partialUpdateDoris/queryDorisStream` | 所有 Doris 访问经统一入口，参数化防注入，instrumentAsync 追踪 |
| 领域模型分层 | `domain/*.ts`（Zod）→ `definitions.ts`（行 schema）→ `repositories/*.ts`（查询）→ `converters` | 四层解耦领域对象/物理行/查询/映射 |
| 数据映射 | `traces_converters.ts:convertDorisToDomain/convertTraceDomainToDoris`；`definitions.ts:convertPostgres*ToInsert` | 双向转换：领域↔Doris 行；PG 行→Doris 行（迁移） |
| 加密包装 | `encryption/encryption.ts` AES-256-GCM；`apiKeys.ts` bcrypt+SHA | 敏感字段分层：可逆加密（LLM key 需解密使用）vs 不可逆哈希（API key 校验） |

## 模块间交互

- **repositories 被 web tRPC 与 worker 共享**：`repositories/index.ts` 统一导出，web tRPC router 与 worker 消费者均 import 同一函数（如 `getTracesByIds`/`upsertScore`）。
- **双数据源**：`prisma`（PG）与 `dorisClient`（Doris MySQL/HTTP）并存，repository 函数内部决定走哪个库——元数据/配置走 `prisma.*`，事件数据走 `queryDoris/upsertDoris`。
- **converters 在两者间映射**：`definitions.ts` 的 `convertPostgres*ToInsert` 负责 PG→Doris 迁移；`*_converters.ts` 负责 Doris→Domain 读取映射。
- **S3 中转**：ingestion 先写 S3，再入队异步处理，解耦写入与消费。

## 扩展方式

加一个领域字段（PG+Doris 双写）：① `prisma/schema.prisma` 对应 model 加列 + migration；② `domain/traces.ts` `TraceDomain` Zod schema 加字段；③ `repositories/definitions.ts` `traceRecordBaseSchema` 加 Doris 列；④ `repositories/traces_converters.ts` `convertDorisToDomain`/`convertTraceDomainToDoris` 双向映射；⑤ `repositories/traces.ts` `buildTraceAggregationQuery` SELECT 加列；⑥ 涉及 partition key 则更新 `DATE_FIELD_MAPPINGS`（`doris/client.ts:869`）。加一张配置表：`prisma/schema.prisma` 加 model + `@@index([projectId])`；`repositories/` 新建 `xxx-repository.ts` 导出 query/upsert 函数；`repositories/index.ts` 加 `export *`。对应测试：`packages/shared/src/server/repositories/__tests__/`。
