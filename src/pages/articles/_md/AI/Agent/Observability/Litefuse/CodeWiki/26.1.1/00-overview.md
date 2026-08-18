---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "Overview"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "TypeScript", "Apache Doris", "BullMQ", "Next.js", "Observability"]
description: "开源 LLM 可观测性平台 Litefuse v26.1.1 源码解读：Apache Doris 替代 ClickHouse 的摄入管线、DorisWriter 流式写入、队列分片、events_full 宽表统一与前端 Tracing UI。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v26.1.1 · **协议** MIT · **语言** TypeScript（Node 24）· **代码量** ~469,000 行 · **仓库** [GitHub](https://github.com/litefuse/litefuse)

---

## 总览

### 项目简介

Litefuse 是一个**开源 LLM 工程平台**，帮助团队**开发、监控、评估、调试** AI 应用。它解决的核心问题是：当一个 AI 应用由多次 LLM 调用、检索、工具执行组合而成时，如何把这些分散的、嵌套的执行过程变成**可观测、可评估、可调试**的工程对象。

Litefuse 的出身值得先说清：它是 [Langfuse](https://github.com/langfuse/langfuse) 的 **Apache Doris 分支**——把原版重度依赖 ClickHouse 的存储与查询层整体迁移到 [Apache Doris](https://github.com/apache/doris) 列式库，目录 `clickhouse/` 重命名为 `doris/`，写入器从 ClickhouseWriter 改为 `DorisWriter`（走 Doris HTTP stream load）。定位与 Langfuse 一致：它是一个**观测与评估后端**——你用 SDK 给应用插桩（instrumentation），把 trace/observation/score 事件发给它；它不替你跑 LLM（playground / eval judge 除外），也不托管你的应用代码，只负责接收、存储、查询、评估这些事件，并在 Web UI 里把它们组织成 trace 树、评分、数据集、实验对比。

**项目当前边界**：负责事件的摄入、存储、查询、评估与可视化；不负责 LLM 推理执行（eval 的 LLM-as-judge 会调用外部 LLM，但不托管用户应用代码），也不包含 JS/Python 客户端 SDK（SDK 在独立仓库）。核心使用场景：给 LLM 应用插桩 → trace 流入 → 在 UI 看 trace 树和 token/成本 → 配置 eval（LLM-as-judge）→ 用数据集做实验对比 → 用 prompt 管理版本化 prompt。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| OTel 摄入 | `web/src/pages/api/public/otel/v1/traces/` + `packages/shared/src/server/otel/OtelIngestionProcessor.ts` | 接收 SDK 上报的 OTel resourceSpans，S3 暂存 + 入队 |
| 批摄入（legacy） | `web/src/pages/api/public/ingestion.ts` + `packages/shared/src/server/ingestion/processEventBatch.ts` | JSON batch 入口（OTel-only fork 后仅 score-create/sdk-log） |
| Doris 批写入 | `worker/src/services/DorisWriter/index.ts` | 内存批缓冲 + stream load |
| Doris 查询 | `packages/shared/src/server/repositories/doris.ts` + `server/doris/client.ts` | queryDoris / commandDoris / queryDorisStream |
| 队列总线 | `packages/shared/src/server/queues.ts` + `server/redis/` | 28 个 BullMQ 队列，ingestion/otel 分片 |
| 评估 | `worker/src/features/evaluation/evalService.ts` + `worker/src/queues/evalQueue.ts` | LLM-as-judge，creator/executor 两阶段 |
| 批导出 | `worker/src/features/batchExport/handleBatchExportJob.ts` | Doris 流式读 → S3 multipart |
| 定时清理 | `worker/src/features/batch-*-cleaner/` + `utils/PeriodicExclusiveRunner.ts` | 软删 → 物理删，独占锁 |
| 公开 API | `web/src/features/public-api/server/` | project/org 两级 API key 鉴权 + 限流 |
| tRPC API | `web/src/server/api/routers/` | 端到端类型安全，traces/dashboard/observations |
| Tracing UI | `web/src/components/trace2/` + `features/trace2/` | trace 树 v2，6 层 Context Provider |
| Dashboard | `web/src/features/dashboard/` + `server/api/routers/dashboardWidgets.ts` | 声明式表定义 + sqlInterface 查询 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| TypeScript / Node 24 | 核心 | 全栈语言 |
| Next.js（Pages Router） | 核心 | Web 应用（UI + tRPC + 公开 API） |
| Express | 核心 | Worker 进程（队列消费） |
| pnpm + Turbo | 核心 | Monorepo 与任务编排 |
| Apache Doris | 核心 | 事件分析库（events_full/traces/observations/scores） |
| Prisma + PostgreSQL | 核心 | 元数据/配置/用户/项目事务库 |
| Redis + BullMQ | 核心 | 队列总线 + 缓存 + 限流 |
| mysql2 | 核心 | Doris 查询协议（MySQL 兼容） |
| OpenTelemetry | 核心 | 自身可观测性插桩 |
| tRPC | 核心 | 端到端类型安全 API |
| Stripe | 可选 | 云版计费 |
| OpenAI SDK | 可选 | LLM-as-judge 评估 |

### 版本历史

Litefuse 的版本脉络与 Langfuse 不同：它从 Langfuse 分叉后把主版本号抬到 `26.x`（v26.1.1 为本文解读的 tag）。当前版本最重要的架构演进是 **events_full 宽表统一迁移**——把 trace/observation 事件从分别写 `traces`/`observation_source` 的双写路径，逐步收敛到统一的 `events_full` 宽表（OTel "span" 为行粒度，trace 字段冗余在每行，导出与分析免 JOIN）。源码里用 `legacyDualWrite()` 哨兵函数（`worker/src/queues/otelIngestionQueue.ts:94`）屏蔽旧双写分支但保留类型检查，`events_full` 已是 master 的唯一写入目标。另一条主线是 **ClickHouse → Apache Doris** 的存储迁移：表引擎从 ReplacingMergeTree 换成 Doris 的 UNIQUE KEY + merge-on-write（MoW），查询接口从 ClickHouse client 换成 mysql2 pool + Doris HTTP stream load。

### 顶层上下文图

系统与外部的交互边界：

- **上游**：LLM 应用（通过 Python/JS SDK 或 OTel exporter 上报 trace）。
- **下游**：LLM Provider（OpenAI 等，用于 eval 的 LLM-as-judge）、S3 兼容对象存储（ingestion blob 暂存 + 导出产物）、Stripe（云版计费）、PostHog/Mixpanel（集成）。
- **存储**：Apache Doris（事件）、PostgreSQL（元数据）、Redis（队列/缓存）、S3（blob）。

---

## 快速上手

```bash title="快速启动（dev）"
# 1. 安装依赖
pnpm install
# 2. 拉起基础设施（Doris / Postgres / Redis，docker-compose）
pnpm run infra:dev:up
# 3. 初始化数据库（Prisma migrate + Doris migrations + seed）
pnpm --filter=shared run db:reset && pnpm --filter=shared run db:seed:examples
# 4. 启动 web + worker
pnpm run dev
```

预期：web 监听 `http://localhost:3000`（Next.js dev），worker 监听 `env.PORT`（Express），`curl http://localhost:3000/` 返回首屏，`curl http://localhost:<worker-port>/` 返回 `{"message":"Langfuse Worker API 🚀"}`（`worker/src/app.ts:83`）。一条端到端验证：用 SDK 或 curl 向 `/api/public/otel/v1/traces` 发一个 resourceSpans batch，几秒后在 Web UI 的 Traces 页看到该 trace。

> 一键 bootstrap（含销毁重建）：`pnpm run dx`。

---

## 架构设计解析

### 系统架构

Litefuse 是一个**写入异步化、读写分离、双库分工**的观测平台。架构思想：**热路径只入队**——Web 进程（Next.js）只做鉴权、限流和把事件写 S3 + 入 Redis 队列，立即返回 SDK；真正的事件解析、富化、写库全部在 Worker 进程异步完成，避免 Web handler 被重活阻塞。**双库分工**：Postgres 存事务性元数据与配置（需要 ACID 与 FK），Doris 存海量分析事件（列存 + 高吞吐）。**横切共享包** `@langfuse/shared` 把队列契约、repositories、Doris client、domain、prisma client 收在一处，web 与 worker 都依赖它，保证两端类型与查询逻辑一致。

![Litefuse 分层架构](/vibe-reading/images/articles/litefuse-codewiki-26.1.1/architecture.svg)

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 客户端层 | SDK（Python/JS）、OTel exporter、Browser | 产生 trace/observation/score 事件并上报 |
| Web 应用层 | `web/src/pages/api/public/`、`server/api/`、`features/`、`components/` | 隔离外部协议、鉴权限流、入队、tRPC 查询、UI 渲染 |
| 队列总线层 | `packages/shared/src/server/redis/` + `queues.ts` | 解耦 web 与 worker，削峰、分片、重试、死信 |
| Worker 层 | `worker/src/queues/`、`services/`、`features/` | 事件解析富化、DorisWriter 批写、后台作业、定时清理 |
| 共享层 | `packages/shared/src/` | 队列契约、repositories、doris client、domain、prisma——横切 web/worker |
| 存储层 | Doris / PostgreSQL / Redis / S3 | 事件分析库 / 元数据事务库 / 队列与缓存 / blob |

写路径沿层自上而下穿过全部层（SDK→Web→队列→Worker→Doris）；读路径从 Web 直达 Doris，**跳过队列与 Worker**（查询走 web 进程的 tRPC → `queryDoris` → Doris MySQL 协议），这是读写分离的关键——读不被写吞吐拖累。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例 | `DorisWriter.getInstance`、`WorkerManager`、`RateLimitService`、各 `Queue.getInstance` | 全局唯一热路径对象，控制资源（连接池、worker 句柄） |
| 工厂 | `getQueue`（`redis/getQueue.ts`）、`createAuthedProjectAPIRoute`、`StorageServiceFactory` | 集中创建/路由，隔离实现 |
| 装饰器/中间件 | `redisQueueRetryOptions`、`WorkerManager.metricWrapper`、`createAuthedProjectAPIRoute` | 横切重试与可观测性，不侵入业务 |
| 模板方法 | `PeriodicExclusiveRunner`（`worker/src/utils/`） | 定时清理器的骨架（独占锁+定时），子类只覆写 `execute()` |
| 策略 | eval 路径（trace 级 `evaluate` vs observation 级 `processObservationEval`）、project vs org API key | 同一抽象多种执行策略 |
| 声明式表定义 | `tableDefinitions/` + `server/api/services/tableDefinitions.ts` + `sqlInterface.ts` | 用 schema 描述查询，编译器统一编 SQL，防注入 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Trace` | 一次用户请求/会话的根 | 写入后持久 | 包含多个 `Observation`、`Score` |
| `Observation` | trace 内一次步骤（span/generation/tool） | 隶属 trace | 属 trace，可触发 eval |
| `Score` | 对 trace/observation 的评分 | 依附被评对象 | 由 eval 或人工产生 |
| `EventRecord`（events_full 行） | 统一的事件宽表行（trace/obs/score denormalize） | 写入后由 MoW 去重 | 替代分别查 traces/observations |
| `JobExecution` | 评估任务执行记录（PG） | PENDING→EXECUTING→终态 | 由 `createEvalJobs` 创建 |
| `ApiKey` | project/org 两级鉴权密钥 | 长期 | bcrypt + SHA fast-hash |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `PeriodicExclusiveRunner` | `worker/src/utils/PeriodicExclusiveRunner.ts` | 6 个 `Batch*Cleaner` | `app.ts` 实例化 + `.start()` |
| `Processor`（BullMQ） | `worker/src/queues/*.ts` 各 `*QueueProcessor` | ~25 个 processor | `WorkerManager.register` in `app.ts` |
| `RecordInsertType<T>`（表→行类型映射） | `DorisWriter/index.ts:346` | 6 张 Doris 表的类型 | 条件类型映射 |
| `createAuthedProjectAPIRoute` | `web/src/features/public-api/server/` | 各 public API route | `withMiddlewares` 聚合 |


---

## 代码目录

```
litefuse/
├── web/                     # Next.js 应用（UI + tRPC + 公开 REST）
│   └── src/
│       ├── pages/api/public/   # 公开 API 入口（/otel/v1, /ingestion, /traces...）
│       ├── server/api/         # tRPC routers + services（tableDefinitions/sqlInterface）
│       ├── features/           # 按领域组织的功能（trace2/dashboard/evals/prompts...）
│       └── components/trace2/  # trace 树 UI v2（6 层 Context Provider）
├── worker/                 # Express 队列消费进程
│   └── src/
│       ├── queues/          # ~20 个队列 processor + workerManager
│       ├── services/        # DorisWriter / IngestionService / dlq
│       ├── features/        # 后台作业（evaluation/batchExport/cleaners...）
│       └── utils/           # PeriodicExclusiveRunner 等
├── packages/
│   ├── shared/             # 共享层：队列契约/repositories/doris/domain/prisma
│   │   ├── prisma/schema.prisma     # PostgreSQL 模型（1640 行）
│   │   ├── doris/migrations/        # Doris 建表 DDL
│   │   └── src/server/
│   │       ├── queues.ts            # QueueName + TQueueJobTypes 契约（529 行）
│   │       ├── redis/               # BullMQ 队列定义 + 分片
│   │       ├── doris/               # DorisClient（client.ts）+ schema
│   │       ├── repositories/        # 查询/写入函数 + converters
│   │       ├── ingestion/           # processEventBatch / sampling / validate
│   │       ├── otel/                # OtelIngestionProcessor（2619 行）
│   │       └── auth/                # apiKeys / RBAC
│   ├── config-eslint/     # 共享 ESLint 配置
│   └── config-typescript/ # 共享 tsconfig
├── fern/                   # API 文档与 OpenAPI 源
└── scripts/                # 运维/发布脚本
```

依赖方向（`AGENTS.md` 约定）：`web` → `@langfuse/shared`，`worker` → `@langfuse/shared`，`@langfuse/shared` 不反向 import web/worker。队列 payload schema 与 queue-name 契约归 `packages/shared/src/server/queues.ts` 所有。

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/litefuse-codewiki-26.1.1/module-dependencies.svg)

依赖方向与交互方式：写入侧由「06 公开 API」入队 → 「04 队列」 → 「01 摄入管线」→ 「02 DorisWriter」→ 「03 Doris 查询与表层」→ Doris；读取侧由「08 前端」/「06 公开 API」直达「03 Doris 查询」→ Doris，跳过队列与 worker。所有模块经由 `@langfuse/shared` 的 repositories/doris client 访问存储，「07 领域数据模型」定义领域对象与 PG↔Doris 转换器，被 web 与 worker 共享。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 01 摄入管线 | 解析 OTel/legacy 事件、富化、分发写库 | `otelIngestionQueueProcessor` | 处理"事件→记录"的复杂转换与 SDK 版本门控，逻辑独立于存储 | [01 摄入管线](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/01-ingestion-pipeline) |
| 02 DorisWriter | Doris 流式批写入器（stream load） | `DorisWriter.getInstance` | 是 Litefuse 相对 Langfuse 的核心差异点，单例批缓冲机制自成一体 | [02 DorisWriter](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/02-doriswriter) |
| 03 Doris 查询与表层 | Doris 客户端、查询/流式读、表定义与迁移 | `queryDoris` / `dorisClient` | Doris 的查询协议、租户过滤、宽表统一都收在此 | [03 Doris 查询与表层](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/03-doris-query-schema) |
| 04 队列基础设施 | BullMQ 队列契约、分片、Worker 注册、DLQ | `queues.ts` / `WorkerManager` | web↔worker 解耦总线，契约共享、分片重试自成体系 | [04 队列基础设施](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/04-queue-infrastructure) |
| 05 Worker 作业处理 | 评估、批导出、删除、定时清理 | `app.ts` register 集群 | 后台业务逻辑集中、各有独立的并发/限流/锁策略 | [05 Worker 作业处理](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/05-worker-job-processing) |
| 06 公开 API 与鉴权 | SDK/外部 REST 入口、API key、限流 | `createAuthedProjectAPIRoute` | 系统对外的安全边界，两级 key + 限流独立于业务 | [06 公开 API 与鉴权](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/06-public-api-auth) |
| 07 领域数据模型 | Prisma 模型、领域对象、repositories、转换器 | `schema.prisma` / `repositories/` | PG 元数据与 Doris 事件的双库映射中枢，被两端共享 | [07 领域数据模型](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/07-domain-data-model) |
| 08 前端 Tracing UI | Next.js 应用、trace 树、dashboard、tRPC | `components/trace2/Trace.tsx` | 读路径的 UI 与 API 编排，独立于写侧后台 | [08 前端 Tracing UI](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/08-frontend-tracing-ui) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

## 运行时行为

### 启动流程

worker 进程入口 `worker/src/index.ts` → `worker/src/app.ts`（Express 实例化 + helmet/cors）→ `initialize`（`initialize.ts`，DB/Redis/OTel 初始化）。随后 `app.ts` 用一连串 `if (env.X_IS_ENABLED)` 守卫，`WorkerManager.register` 注册约 25 个 BullMQ worker，每个带精心调过的 `concurrency` / `lockDuration:60000` / `stalledInterval:120000` / `maxStalledCount:3` / `limiter`；ingestion/otelIngestion/traceUpsert 队列按 `getShardNames()` 遍历分片注册。同时实例化并 `.start()` 5 类后台清理器（`BatchProjectCleaner`/`BatchDataRetentionCleaner`/`MediaRetentionCleaner`/`BatchTraceDeletionCleaner`/`BatchProjectBlobCleaner`），并启动 `DorisReadSkipCache` 与 `BackgroundMigrationManager`。对象装配：`redis`（`globalThis.redis` 单例，HMR 安全）、`prisma`、`dorisClient()`（`DorisClientManager` 单例 mysql2 pool）在 `@langfuse/shared` 顶层创建，worker 通过 import 取用；`DorisWriter.getInstance()` 在首次调用时惰性构造单例。

web 进程由 Next.js Pages Router 启动，tRPC `appRouter`（`server/api/root.ts`）聚合约 40 个子 router，`createTRPCContext` 注入 prisma/session/DB；公开 API 路由在 `pages/api/public/` 按文件即路由暴露。

### 核心运行流程

下面三条链路覆盖了 Litefuse 最核心的运行模式：事件摄入（写）、trace 查询（读）、评估执行。完整端到端数据流见下图。

![端到端数据流](/vibe-reading/images/articles/litefuse-codewiki-26.1.1/data-flow.svg)

#### 摄入：OTel → events_full 主链路

业务流程：SDK POST → 鉴权限流 → S3 暂存 + 入 OTel 队列 → worker 下载解析 → 富化成 EventRecord → DorisWriter 批缓冲 → stream load 写 Doris events_full（同时少量 session 元数据写 PG）。

文字描述：`/api/public/otel/v1/traces` 经 `createAuthedProjectAPIRoute`（`createAuthedProjectAPIRoute.ts:233`，verifyAuth + RateLimitService）后，`OtelIngestionProcessor.publishToOtelIngestionQueue`（`OtelIngestionProcessor.ts:183`）把 resourceSpans 上传 S3 并 `OtelIngestionQueue.add`（跨 web↔worker 边界，经 Redis）。worker 侧 `otelIngestionQueueProcessor`（`otelIngestionQueue.ts:200`）下载 S3 → `processToEvent` 产 `EventInput[]` → `IngestionService.createEventRecord`（富化 prompt/usage，`IngestionService/index.ts:276`）→ `writeEventRecord` → `DorisWriter.addToQueue(TableName.EventsFull, …)`。DorisWriter 按 batchSize/字节/interval 三触发 `flush` → `writeToDoris` → `dorisClient().insert`（stream load PUT，FE 307→BE，timeout 600s，`client.ts:505/698`）→ Doris events_full（UNIQUE KEY + MoW 自动去重）。设计决策：S3 暂存大 batch 避免 BullMQ 大 payload；`legacyDualWrite()` 哨兵屏蔽旧双写；SDK 版本门控（python≥4.0/js≥5.0）决定能否 direct-write 到 events_full。

#### 查询：浏览器 → trace 树

业务流程：浏览器访问 trace 页 → tRPC 查询 → 拼 CTE 查 Doris events_full → 转换为领域对象 → 渲染 trace 树。

文字描述：`/trace/[traceId]` 经 `getServerSideProps` 查 PG 拿 projectId 并重定向（`[traceId].tsx`）→ `TracePage` 调 `api.traces.byIdWithObservationsAndScores.useQuery`（`TracePage.tsx:29`）→ tRPC `traceRouter`（`traces.ts:340`）经 `protectedGetTraceProcedure` 鉴权 → `getTraceById`（`repositories/traces.ts:462`）用 `buildTraceAggregationQuery` 构造双 CTE（`trace_scalars` 用 `MAX_BY` 聚合标量、`trace_root` 取 root span 的 array/Variant 列）→ `queryDoris`（`doris.ts:119`，`DorisParameterProcessor` 绑参 + project_id 强制过滤）→ Doris → `convertDorisToDomain` → 前端 `Trace` 组件用 `buildTraceUiData` 迭代建树渲染。读路径**跳过队列与 worker**，web 直连 Doris（MySQL 协议）。

#### 评估：LLM-as-judge

业务流程：摄入时触发 → 创建 eval job → 执行（调 LLM）→ 写 score 回 Doris。

文字描述：OTel 摄入 `scheduleObservationEvals`（`observationEval/scheduleObservationEvals.ts:36`）→ `createEvalJobs`（`evalService.ts:173`，查 `job_configurations` + filter + 去重/采样 + 写 `jobExecution` PG + `EvalExecutionQueue.add` 带 delay）→ `evalJobExecutorQueueProcessorBuilder`（`evalQueue.ts:121`）→ `evaluate` → `executeLLMAsJudgeEvaluation`（`evalService.ts:718`，编译 prompt → `deps.callLLM` structured output → `validateEvalOutputResult` → S3 + ingestion 写 score）。creator/executor 两阶段设计让 ingestion burst 在 creator 阶段被过滤采样，executor 独立设并发与 60s lockDuration 应对 LLM 慢响应与 429。

### 状态流

![对象生命周期状态流](/vibe-reading/images/articles/litefuse-codewiki-26.1.1/state-flow.svg)

两类对象生命周期状态：**Eval Job**（`jobExecution.status`，PG）经 `createEvalJobs` 进入 `PENDING` → `EXECUTING` → 终态（`COMPLETED` / `FAILED` / `CANCELLED`），`FAILED` 可经 `DeadLetterRetryQueue`（每 10 分钟 cron 扫描）重投回 `EXECUTING`；**Trace 删除**两段式：`BatchActionQueue` 的 trace-delete 分支做软删（`is_deleted=1`），`BatchProjectCleaner`/`BatchDataRetentionCleaner`（继承 `PeriodicExclusiveRunner`，Redis 独占锁）定时跑 `commandDoris(DELETE …)` 物理删除。相关代码：状态枚举在 `schema.prisma` 的 `JobExecution` model；`createEvalJobs` 在 `evalService.ts:173` 设初态；软删/物删在 `handleBatchActionJob.ts:65` 与 `batch-data-retention-cleaner/index.ts:152`。

## 典型修改场景

#### 场景 1：新增一种 observation 事件类型

- `packages/shared/src/server/ingestion/types.ts` 加 eventType 枚举 + body schema
- `IngestionService.mergeAndWrite`（`IngestionService/index.ts:213`）switch 加 case + `processXxxEventList`
- `getDorisEntityType`（`server/doris/schemaUtils.ts`）加映射
- `DorisWriter` 的 `TableName` + `RecordInsertType<T>` 加分支
- 对应测试：`worker/src/services/IngestionService/tests/`

#### 场景 2：新增一个后台作业队列

- `packages/shared/src/server/queues.ts`：`QueueName` 枚举 + `QueueJobs` + `TQueueJobTypes` + Zod payload
- 新建 `packages/shared/src/server/redis/xxxQueue.ts`（仿 `dlqRetryQueue.ts` 单例）
- `getQueue.ts` switch 加 case；`worker/src/app.ts` `WorkerManager.register`
- 对应测试：`worker/src/queues/__tests__/`

#### 场景 3：新增一个 Doris 查询接口（含表 + migration）

- `packages/shared/doris/migrations/00XX_*.up.sql` 写 DDL（UNIQUE KEY + AUTO PARTITION + HASH(project_id) + 倒排索引）
- `schema.ts:DorisTableNames` 加名；`tableDefinitions/` 加 ColumnDefinition
- `repositories/` 加函数调 `queryDoris`；`doris/client.ts` 的 `DATE_FIELD_MAPPINGS` 注册日期字段
- 对应测试：`packages/shared/src/server/repositories/__tests__/`

## 测试体系

```
web/src/__tests__/        # web 单元/集成（server/async/worker/fixtures/static）
web/src/__e2e__/          # Playwright 端到端（playwright.config.ts）
worker/src/__tests__/     # worker 单元/集成（含 chatml）
worker/src/**/__tests__/  # 各 feature 内嵌测试（evalService、batchAction 等）
packages/shared/.../__tests__/  # shared repositories/doris 单元
```

| 代码层 | 测试类型 |
| --- | --- |
| shared repositories / doris client | 单元 + 集成（`*.integration.test.ts` 跑真 Doris） |
| worker queue processor / feature | 单元（`*.unit.test.ts`）+ 集成 |
| web tRPC router / public API | 单元 + e2e（Playwright） |
| DorisWriter | `DorisWriter.unit.test.ts` + `DorisWriter.integration.test.ts` |

> DorisWriter 有专门的 unit/integration 双测试（`worker/src/services/DorisWriter/`），改写入逻辑时优先看这两个文件。

## 阅读源码推荐路线

- **第一遍：理解摄入主流程**
  `worker/src/app.ts`（worker 装配）→ `worker/src/queues/otelIngestionQueue.ts` 的 `otelIngestionQueueProcessor`（`otelIngestionQueue.ts:200`）→ `worker/src/services/IngestionService/index.ts` 的 `createEventRecord`/`writeEventRecord`（`:276`/`:477`）→ `worker/src/services/DorisWriter/index.ts` 的 `addToQueue`/`flush`/`writeToDoris`
- **第二遍：理解 Doris 查询与表结构**
  `packages/shared/src/server/repositories/doris.ts` 的 `queryDoris`/`commandDoris`（`:119`/`:162`）→ `server/doris/client.ts` 的 `DorisClient.query`/`streamLoad`（`:280`/`:505`）→ `packages/shared/doris/migrations/0001_traces.up.sql` 看表引擎 → `server/queries/doris-sql/factory.ts` 的 `getDorisProjectIdDefaultFilter`
- **第三遍：理解队列与后台作业**
  `packages/shared/src/server/queues.ts` 的 `QueueName`/`TQueueJobTypes` → `server/redis/sharding.ts` + `ingestionQueue.ts` → `worker/src/utils/PeriodicExclusiveRunner.ts` → `worker/src/features/evaluation/evalService.ts` 的 `createEvalJobs`/`executeLLMAsJudgeEvaluation`
- **第四遍：理解前端与读路径**
  `web/src/components/trace2/TracePage.tsx`（`:29` useQuery）→ `web/src/server/api/routers/traces.ts` 的 `byIdWithObservationsAndScores`（`:340`）→ `packages/shared/src/server/repositories/traces.ts` 的 `buildTraceAggregationQuery`（`:57`）→ 选一个模块文档深入阅读

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| trace | 一次用户请求/会话的根执行单元 |
| observation | trace 内一次步骤（span/generation/event/tool） |
| events_full | 统一事件宽表，每行一个 OTel span，trace 字段冗余，替代分表查询 |
| MoW | merge-on-write，Doris UNIQUE KEY 模型的写时合并去重策略 |
| stream load | Doris HTTP PUT 导入协议（`/api/{db}/{table}/_stream_load`），FE 307 重定向到 BE |
| OTel | OpenTelemetry，Litefuse 用 OTLP 协议接收 SDK 上报 |
| DLQ | Dead Letter Queue，失败 job 重试队列 |
| MoW / ReplacingMergeTree | Doris 用前者（UNIQUE KEY + MoW），原 Langfuse 用 ClickHouse 后者 |

### 参考资料

- [Litefuse GitHub](https://github.com/litefuse/litefuse)
- [Apache Doris 文档](https://doris.apache.org/docs/)
- [Langfuse（上游）](https://github.com/langfuse/langfuse)（架构同源，存储层 ClickHouse vs Doris 对比）
- [BullMQ](https://docs.bullmq.io/)、[tRPC](https://trpc.io/)
