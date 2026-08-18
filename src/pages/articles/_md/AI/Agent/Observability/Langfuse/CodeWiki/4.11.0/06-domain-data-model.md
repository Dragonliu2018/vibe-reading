---
source:
  type: "源码解读"
  project: "Langfuse"
  url: "https://github.com/langfuse/langfuse"
title: "领域模型与数据定义"
date: "2026-08-18T16:35:50+08:00"
category: ["AI", "Agent", "Observability", "Langfuse", CodeWiki, "4.11.0"]
tags: ["Langfuse", "Prisma", "Postgres", "ClickHouse", "Domain", "Zod"]
description: "Langfuse 领域层：Prisma 70+ 模型、domain zod schema、Postgres+ClickHouse 双库分工、时间版本化 DatasetItem、安全默认。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Langfuse/CodeWiki/4.11.0/00-overview)

---

## 模块定位

这是整个系统的契约锚点——`packages/shared` 里定义的领域模型、Prisma schema、ClickHouse 表映射、domain zod schema。职责边界：定义"系统里有什么对象、对象长什么样、存哪"。它是**最高扇入**的模块（web/worker/ee 都 import 它），但**无入向依赖**（不 import web/worker/ee）。这保证了两个进程对领域定义的理解永远一致。

关键分工：Postgres 存关系元数据（用户/项目/API key/数据集/prompt/score config/job 配置/监控），ClickHouse 存海量观测事件（trace/observation/score 行）。这一层定义两者的 schema 和映射。

## 模块架构

```
packages/shared/
├── prisma/schema.prisma        # Postgres schema（1771 行，70+ 模型）
├── clickhouse/migrations/      # 184 个 ClickHouse 迁移（clustered + unclustered）
├── src/db.ts                    # Prisma client + clickhouseClient 单例
├── src/domain/                  # 17 个 domain zod schema
│   ├── observations.ts          # ObservationSchema + 10 种 type
│   ├── traces.ts, scores.ts, score-configs.ts
│   ├── automations.ts, prompts.ts, dataset-items.ts, media.ts
│   └── observation-field-groups.ts
├── src/types.ts                 # FilterState / TableName 共享类型
├── src/eventsTable.ts, observationsTable.ts   # 见 03 模块
└── src/server/
    ├── tableDefinitions/         # 14 个表/列定义
    ├── tableMappings/            # UI 列名 → ClickHouse SQL 映射
    └── repositories/             # 30 个数据访问 repo（见 03）
```

## 调用链路

domain 层是声明式的，没有复杂调用链——它是被各处 import 的类型 + 校验 schema + DB client：

```
任意模块
  └─ import { ObservationSchema, TraceDomain, prisma, clickhouseClient } from "@langfuse/shared"
       ├─ ObservationSchema.safeParse(body)   // 运行时校验 + 类型推断
       ├─ prisma.apiKey.findFirst({...})       // Postgres 查询
       └─ queryClickhouse({query, params})     // ClickHouse 查询（经 repositories）
```

db.ts 的关键设计——**全局 omit 敏感列**：

```typescript title="packages/shared/src/db.ts:34"
new PrismaClient({
  omit: {
    dataset: {
      remoteExperimentSecretKey: true,     // 默认不返回 secret key
      remoteExperimentRequestHeaders: true,
    },
  },
})
```

这是 secure-by-default——所有查询默认不返回密钥，需要这些字段的交付路径必须用显式 `select` 重新选回，防止无意在 API 响应里泄露。

## 核心实现

### Postgres 核心模型（按职责分组）

| 分组 | 核心模型 | 要点 |
|------|---------|------|
| 组织与权限 | `Organization` `Project` `ApiKey`(`ApiKeyScope`) `OrganizationMembership`(`Role`) `ProjectMembership` `MembershipInvitation` | Project 1→N ApiKey；User N→M Project(OrganizationMembership)；ApiKeyScope: ORGANIZATION/PROJECT |
| LLM 元数据 | `Model` `Price` `PricingTier` `LlmApiKeys` `LlmSchema` `LlmTool` `DefaultLlmModel` | 模型定价用于 observation 成本计算 |
| 观测元数据 | `TraceSession` `ScoreConfig`(`ScoreConfigDataType`) `AnnotationQueue`(`AnnotationQueueItem`/`Status`) | ScoreConfig 单独成表可复用版本化；AnnotationQueue 人工标注 |
| eval/dataset | `Dataset`(`DatasetStatus`) `DatasetItem`(validFrom/validTo 时间版本) `DatasetRuns` `DatasetRuns` `EvalTemplate`(`EvalTemplateType`) `JobConfiguration`(`JobType`/`JobConfigState`) `JobExecution`(`JobExecutionStatus`) | JobConfig vs JobExecution 配置/运行分离 |
| prompt | `Prompt` `PromptDependency` `PromptProtectedLabels` | PromptDependency 追踪 prompt 间依赖 |
| 自动化 | `Automation` `Action`(`ActionType`) `Trigger` `AutomationExecution`(`ActionExecutionStatus`) | Automation→Action→Trigger 关系 |
| 监控 | `Monitor`(`MonitorThresholdOperator`/`View`/`Severity`/`Status`) | schedulerBatchId + nextRunAt 调度集成 |
| 导出 | `BatchExport` `BatchAction` `BlobStorageIntegration`(`FileType`/`Type`/`ExportMode`) `WebCalloutEndpoint` | |
| in-app agent | `InAppAgentConversation` `InAppAgentEvent` `InAppAgentRun` `InAppAgentPendingToolApproval` `InAppAgentConversationVisibilityScope` | 事件日志模型，见 [07-应用内 Agent](./07-in-app-agent) |
| 媒体 | `Media`(`MediaAssociationOrigin`) `TraceMedia` `ObservationMedia` `DatasetItemMedia` | 多源媒体关联 |
| 其他 | `User` `Account` `Session` `VerificationToken` `SsoConfig` `VerifiedDomain` `Comment`(`CommentObjectType`) `NotificationPreference` `Dashboard`/`DashboardWidget` `TableViewPreset` `AuditLog`(`AuditLogRecordType`) `BackgroundMigration` `CronJobs` `PendingDeletion` | |

### 关键 enum

`ApiKeyScope`（ORGANIZATION/PROJECT）、`Role`、`JobType`、`JobConfigState`、`ActionType`、`ActionExecutionStatus`、`MonitorStatus`/`MonitorSeverity`、`DatasetStatus`、`AnnotationQueueStatus`/`AnnotationQueueObjectType`、`ScoreConfigDataType`、`CommentObjectType`、`AuditLogRecordType`、`MediaAssociationOrigin`、`InAppAgentConversationVisibilityScope` 等。

### domain zod schema

`domain/observations.ts` 定义 `ObservationSchema`（10 种 observation type + `isGenerationLike` 帮助函数）。`scores.ts` 用 zod discriminatedUnion 按 `dataType`（NUMERIC/CATEGORICAL）分。`score-configs.ts` 用 `superRefine` 做跨字段校验。`automations.ts` 定义 Trigger/Action/Automation domain + 3 种 action config。`media.ts` 定义 `MediaContentType`（50+ MIME 类型）+ extension 映射。`observation-field-groups.ts` 定义字段分组（public API vs full）——配合 03 模块的列式访问。

domain schema 同时是运行时校验和 TS 类型来源——一处定义，校验+类型+文档三合一。

### ClickHouse 表与迁移

`clickhouse/migrations/` 下 184 个 SQL 迁移，分 `clustered/` 和 `unclustered/`。`events_full` / `events_core` / `events_proto` 的定义见深度附件 [events_core 宽表统一](./03-clickhouse-write-storage-events-core-unification)（migration `0039_create_events_full` / `0040_create_events_core` / `0041_create_events_core_mv`）。`tableDefinitions/` 定义 14 个逻辑表/列；`tableMappings/` 做 UI 列名 → ClickHouse select 表达式映射（如 `mapTracesTable.ts` 227 行）。

### 模型关系

```
Organization 1→N Project 1→N ApiKey
User N→M Organization (OrganizationMembership, Role)
Project 1→N TraceSession
Project 1→N ScoreConfig 1→N Score (ClickHouse)
Project 1→N Dataset 1→N DatasetItem (validFrom/validTo 时间版本)
Project 1→N JobConfiguration 1→N JobExecution
Project 1→N Automation 1→N Action N→M Trigger
Project 1→N Monitor (triggerIds[] → Automation Trigger)
Project 1→N InAppAgentConversation 1→N InAppAgentRun 1→N InAppAgentEvent
```

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Postgres+ClickHouse 双库分工 | `db.ts` + `eventsTable.ts` | Postgres 强事务/关系，ClickHouse 列式高吞吐分析，各取所长 |
| zod domain schema | `domain/*.ts` | 一处定义=校验+类型+文档三合一 |
| Repository pattern | `repositories/` 30 个 | 统一访问两库，屏蔽 CH/PG 差异 |
| enum 强类型化 | 各 enum | 业务状态编译期约束 |
| Secure-by-default omit | `db.ts:34` | 防止无意泄露密钥 |
| 时间版本化 | `DatasetItem` validFrom/validTo | 更新不丢旧版本，已完成的 dataset run 可追溯 |
| 配置/运行分离 | `JobConfiguration` vs `JobExecution` | 配置长期复用，运行一次性可重跑有历史 |
| 事件日志模型 | `InAppAgentEvent` 单一日志多派生 | 见 07 模块 |
| 调度器集成字段 | `Monitor` nextRunAt/schedulerBatchId | 索引高效查"到期需执行" |

## 模块间交互

被 web/worker/ee 广泛 import（domain models 是高扇入契约）。`db.ts` 暴露 `prisma` + `clickhouseClient` 单例。`repositories` 被 03 模块（ClickHouse 写入与存储）和 05 模块（公开 API 查询）共用。

## 核心设计决策

**为什么 Postgres 和 ClickHouse 分工**：Postgres 擅长事务、关系 JOIN、低频高一致性写入（用户/API key/配置），ClickHouse 擅长列式高吞吐分析查询（海量事件 trace/observation/score）。强行用一库要么事务差要么分析慢，双库各取所长是规模下的合理选择——代价是双 schema 维护和路由 wrapper（见 03 的 `getTraceById`），用 `LANGFUSE_MIGRATION_V4_WRITE_MODE` 管控。

**为什么 ScoreConfig 单独成表**：score config 可复用、版本化，一个 config 可评多条 trace/observation，不内嵌到 score 行。

**为什么 Prompt 有 PromptDependency**：prompt 间依赖追踪，改一个 prompt 时知道影响哪些下游。

**为什么 JobConfiguration vs JobExecution 分离**：配置（eval 怎么跑）是长期复用的，运行实例（某次跑）是一次性的。分离后便于重跑、历史追溯、并发执行同一配置。

**为什么 DatasetItem 用时间版本（validFrom/validTo）而非 status 软删**：更新 item 不丢失旧版本——已完成的 dataset run 引用的旧版本数据仍可追溯。复合主键 `@@id([id, projectId, validFrom])` 允许多版本，`@@index([projectId, validTo])` 查"当前有效版本"（validTo=null）。`DatasetItemMedia` 也有 `datasetItemValidFrom` 做版本对齐。

**为什么 InAppAgent 用 Conversation+Event+Run 三张**：事件日志模型——Event 是不可变追加日志，Run 是执行实例（状态机），Conversation 是会话聚合。一个日志派生 canonical/display/replay 三种消息视图（见 07）。

**为什么 Monitor 有 schedulerBatchId + nextRunAt**：调度器分片查"到期需执行"的 monitor（`@@index([nextRunAt, schedulerBatchId])`），`lastClaimedAt`/`lastCompletedAt`/`lastPublishedAt` 追踪认领/完成/告警，`severity`+`severityChangedAt` 追踪告警状态转换触发 webhook/Slack。

## 扩展方式

**新增一个 Postgres 模型**：`schema.prisma` 加 model + 挂关系到 Project → `npx prisma migrate dev` → `domain/` 加 zod schema → `repositories/` 加 repo CRUD → `repositories/index.ts` 加 export。

**新增一个 ClickHouse 迁移**：`clickhouse/migrations/clustered/` + `unclustered/` 加 `00XX_<name>.up.sql` + `.down.sql` → 如新表，`repositories/definitions.ts` 加 `xxxRecordBaseSchema`/`ReadSchema`/`InsertSchema` → `tableMappings/` 加 UI 列映射 → `repositories/` 加查询 repo。

**给 ObservationSchema 加字段**：`domain/observations.ts` 加字段 → `repositories/definitions.ts` 加 snake_case 字段 → 如需表结构变更加 CH migration `ALTER TABLE ADD COLUMN` → `tableMappings/mapObservationsTable.ts` 加 UI 列映射 → converter 加字段映射。
