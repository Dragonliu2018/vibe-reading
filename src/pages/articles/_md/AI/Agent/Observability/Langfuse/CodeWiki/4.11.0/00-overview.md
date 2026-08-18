---
source:
  type: "源码解读"
  project: "Langfuse"
  url: "https://github.com/langfuse/langfuse"
title: "Overview"
date: "2026-08-18T16:35:50+08:00"
category: ["AI", "Agent", "Observability", "Langfuse", CodeWiki, "4.11.0"]
tags: ["Langfuse", "Observability", "TypeScript", "ClickHouse", "BullMQ", "Next.js"]
description: "开源 LLM 可观测性平台 Langfuse v4.11.0 源码解读：摄入管线、队列分片、ClickHouse 宽表统一、后台作业、应用内 Agent。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v4.11.0 · **协议** MIT · **语言** TypeScript（Node 24）· **代码量** ~598,000 行 · **仓库** [GitHub](https://github.com/langfuse/langfuse)

---

## 总览

### 项目简介

Langfuse 是一个开源的 **LLM 工程平台**，帮助团队**开发、监控、评估、调试** AI 应用。它解决的核心问题是：当一个 AI 应用由多次 LLM 调用、检索、工具执行组合而成时，如何把这些分散的、嵌套的执行过程变成**可观测、可评估、可调试**的工程对象。

Langfuse 的定位边界值得先说清：它是一个**观测与评估后端**——你用 SDK 给应用插桩（instrumentation），把 trace/observation/score 事件发给它；它不替你跑 LLM（playground 除外），也不托管你的应用代码。它负责接收、存储、查询、评估这些事件，并在 Web UI 里把它们组织成 trace 树、评分、数据集、实验对比。自 2026 年 1 月起 Langfuse 加入 ClickHouse 生态，底层重度依赖 [ClickHouse](https://github.com/ClickHouse/ClickHouse) 列式库。

核心使用场景：给 LLM 应用插桩 → trace 流入 → 在 UI 里看 trace 树和 token/成本 → 配置 eval（LLM-as-judge / code eval / 人工标注）→ 用数据集做实验对比 → 用 prompt 管理版本化 prompt → 用监控触发告警。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| Trace 摄入（JSON batch） | `web/src/pages/api/public/ingestion.ts` · `packages/shared/src/server/ingestion/` | SDK 批量事件摄入主入口 |
| Trace 摄入（OTLP） | `web/src/pages/api/public/otel/v1/traces/` · `packages/shared/src/server/otel/` | OpenTelemetry Protocol 原生摄入 |
| 观测 UI | `web/src/features/traces/` | trace 树、observation 详情、JSON 查看器 |
| 评估 | `web/src/features/evals/` · `worker/src/queues/evalQueue.ts` | LLM-as-judge、code eval、人工标注、自定义管线 |
| 数据集与实验 | `web/src/features/datasets/` · `experiments/` | 测试集、基准、版本化对比 |
| Prompt 管理 | `web/src/features/prompts/` · `packages/shared/prisma/schema.prisma` | 版本化、依赖追踪、缓存 |
| Playground | `web/src/features/playground/` | 在 UI 里迭代 prompt + 模型配置（SSE 流式） |
| 仪表盘 | `web/src/features/dashboard/` · `widgets/` | 自定义 widget 与聚合视图 |
| 监控告警 | `web/src/features/monitors/` · `worker/src/queues/monitorQueue.ts` | 阈值告警 + severity 变化触发 webhook/Slack |
| 批量导出 | `worker/src/queues/batchExportQueue.ts` · `packages/shared/src/server/repositories/blobStorageLog.ts` | S3 导出 JSONL/Parquet |
| In-App Agent | `web/src/features/in-app-agent/` · `packages/in-app-agent-sandbox-runtime/` | 内置 AI 助手，microvm 沙箱跑工具 |
| 公开 REST API | `web/src/pages/api/public/` · `web/src/features/public-api/` | SDK 与脚本调用的资源 API |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| TypeScript 7（ts6 兼容包装） | 核心 | 全栈语言，Node 24 运行时 |
| Next.js（pages router） | 核心 | web 进程：UI + tRPC + 公开 REST API |
| Express | 核心 | worker 进程 HTTP 框架（注册 BullMQ processor） |
| Turbo + pnpm workspace | 核心 | monorepo 编排（web / worker / packages/shared / ee） |
| Prisma | 核心 | Postgres ORM，schema 在 `packages/shared/prisma/schema.prisma` |
| ClickHouse | 核心 | 海量观测事件列式存储（184 个迁移） |
| Redis + BullMQ | 核心 | 进程间队列、分片、DLQ、API key 缓存、去重缓存 |
| S3 兼容存储 | 核心 | 事件 payload 卸载、批量导出 |
| tRPC + superjson | 核心 | 前端到 server 端到端类型安全 |
| Zod | 核心 | 领域 schema 运行时校验 + 类型来源 |
| OpenTelemetry | 核心 | OTLP 摄入 + 自身可观测性插桩 |
| @tanstack/react-table | 前端 | 通用 DataTable（76 feature 复用） |
| AWS Lambda MicroVMs | 可选 | In-App Agent 沙箱隔离 |

### 版本历史

Langfuse 经历了几次关键演进，解读的 v4.11.0 处在一次**架构简化（Simplifying Langfuse for Scale）**的中段：

- **v3 时代**：traces、observations、scores 三张 ClickHouse 表分散存储，查询需 JOIN。事件摄入后通过 staging 表双写传播。
- **v4 迁移（进行中）**：把三表统一进 `events_core` 宽表，遵循 "Wide Events" 原则——observation 是主分析单元，trace 是 correlation handle，偏好宽而富属性的事件而非碎片化的 metrics/logs/traces。`worker/src/env.ts` 的 `LANGFUSE_MIGRATION_V4_WRITE_MODE`（`legacy` / `dual` / `events_only`，默认 `events_only`）控制写入路径，读路径在 repositories 里做 routing wrapper 分派。
- 同时 v4 把旧 `/api/public/ingestion` JSON 端点收窄为仅接受 score/sdk-log，trace/observation 引导到 OTLP 路径（`filterBatchForEventsOnly`）。

### 顶层上下文图

Langfuse 与外部交互方：

- **LLM 应用**：通过 Python/JS/TS SDK 插桩，POST 事件到摄入端点。
- **OTLP exporter**：任何 OpenTelemetry 兼容客户端走 `/api/public/otel/v1/traces`。
- **浏览器**：用户在 Web UI 查 trace、配 eval、跑实验。
- **脚本/CLI**：通过公开 REST API +  typed SDK 拉数据、跑 eval 管线。
- **IdP**：通过 SSO（ee）+ SCIM 做组织/用户同步。
- **Slack / Webhook**：监控告警外发。
- **S3 / Blob 存储**：事件 payload 卸载 + 批量导出。

## 快速上手

> 这是给代码阅读者的最简上手，不是完整安装手册。

```bash
# 1. clone 并起依赖服务（Postgres + ClickHouse + Redis，docker compose）
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up -d   # infra: postgres / clickhouse / redis

# 2. 装依赖 + 生成 Prisma client + 跑迁移 + 灌示例数据
pnpm install
pnpm run db:generate
pnpm run db:migrate
pnpm --filter=shared run ch:reset      # ClickHouse 建表
pnpm run db:seed:examples              # 示例 trace/observation/score

# 3. 起 web + worker（Turbo 并行）
pnpm run dev
# web    → http://localhost:3000
# worker → http://localhost:3030
```

端到端验证（证明摄入链路通）：用任意一个 Langfuse SDK，配 `LANGFUSE_HOST=http://localhost:3000` 和一个项目 API key，跑一次 LLM 调用并 `flush()`，几秒后刷新 UI 的 Traces 页应看到该 trace。或直接 POST：

```bash title="verify-ingestion.sh"
curl -u pk-lm-xxx:sk-lm-xxx -X POST http://localhost:3000/api/public/ingestion \
  -H "Content-Type: application/json" \
  -d '{"batch":[{"type":"trace-create","id":"req-1","traceName":"hello","body":{"id":"trace-1","name":"hello","timestamp":"2026-08-18T10:00:00.000Z"}}]}'
# 预期: 207 + {"successes":[{"id":"req-1","status":201}],"errors":[]}
```

## 架构设计解析

### 系统架构

Langfuse 的整体设计思想是**"快路径只做轻活，重活甩给后台异步消费"**，并把所有进程间契约收敛到一个无入向依赖的共享包。这解决的核心矛盾是：摄入端点是 SDK 阻塞调用的（用户的 LLM 调用在等它返回），必须毫秒级响应；而写入 ClickHouse、跑 eval、做数据迁移都是秒级以上的重活——两者不能在同一个调用栈里。

因此架构分成两条纵向进程 + 一个横向共享层：

- **web 进程**（Next.js）：负责所有对外 HTTP——公开 REST API、OTLP 端点、tRPC、UI 页面。对摄入请求，它只做"鉴权 + 限流 + zod 校验 + S3 卸载 + 入队"五件事就返回，绝不碰 ClickHouse。
- **worker 进程**（Express）：消费 Redis 队列做重活——把 S3 里的事件合并映射成 ClickHouse 行、微批写入、跑 eval、做后台数据迁移、跑 in-app agent。
- **packages/shared**：web 和 worker 共享的领域模型、队列契约、仓储、摄入/otel 处理器。它**不 import web/worker/ee**，是依赖图的叶子——这保证了两个进程对"什么是合法事件""队列 payload 长什么样"的理解永远一致。

依赖方向是严格的：`web → shared + ee`、`worker → shared`、`ee → shared`、`shared → 无入向`。

![Langfuse 分层架构](/vibe-reading/images/articles/langfuse-codewiki-4.11.0/architecture.svg)

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ------ | ------- | ------------------------- |
| 客户端 | SDK / OTLP exporter / 浏览器 / 脚本 | 事件产生与 UI 消费 |
| web（接口层） | `web/src/pages/api/` · `web/src/features/public-api/` | 隔离外部协议，鉴权限流，保护 worker 不直接暴露 |
| Redis 队列（解耦层） | `packages/shared/src/server/redis/` · `queues.ts` | 进程间解耦，削峰，分片保序，失败重试 |
| worker（处理层） | `worker/src/queues/` · `services/` | 编排重活，隔离 ClickHouse 写入压力 |
| packages/shared（核心层） | `packages/shared/src/domain/` · `repositories/` · `ingestion/` · `otel/` | 承载领域规则与契约，不依赖任何外部实现 |
| 数据层 | Postgres / ClickHouse / S3 / Redis | Postgres 存关系元数据，ClickHouse 存海量事件，S3 存 payload |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 异步队列解耦 | `processEventBatch` 入队 / worker 消费 | 把毫秒级摄入响应与秒级写入分离，SDK 不阻塞 |
| 微批写入 | `ClickhouseWriter` 单例 + 按表队列 | ClickHouse 不耐高频小 insert，攒批降 merge 压力 |
| 队列分片 | `redis/ingestionQueue.ts` by `projectId-eventBodyId` | 同实体事件串行消费，避免并发更新冲突 |
| Wide Events 宽表 | `eventsTable.ts` · `events_core` 表 | 消除 JOIN，高基数切片，未知问题探索 |
| 路由 wrapper | `repositories/traces.ts` `getTraceById` | v3→v4 迁移期按 `V4_WRITE_MODE` 分派 legacy/events 表 |
| Feature-based | `web/src/features/*` | 76 feature 内聚，并行开发不冲突 |
| tRPC 端到端类型 | `server/api/root.ts` + `utils/api.ts` | 无 OpenAPI codegen，schema 即类型 |
| 事件日志 + 多派生 | `in-app-agent/server/persistence.ts` | 一个事件日志派生 canonical/display/replay，回答不同问题 |
| 在位迁移 | `backgroundMigrations/` + `system.parts` 分块 | 不停服迁移海量 ClickHouse 数据，可任意阶段恢复 |
| Secure-by-default | `db.ts` 全局 omit 敏感列 | 防止无意在 API 响应里泄露密钥 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| **Observation** | 一次 LLM 调用/检索/工具执行/agent 动作，主分析单元 | 不可变追加（有 update 事件但走 merge） | 属于一个 Trace |
| **Trace** | 关联一组 observation 的 correlation handle | 创建后可 upsert 更新 | 1→N Observation |
| **Score** | 对 trace/observation 的评估分数（数值/分類） | 不可变 | 关联 trace/observation + ScoreConfig |
| **Dataset / DatasetItem** | 测试集与测试条目（带时间版本 validFrom/validTo） | 时间版本化 | Dataset 1→N DatasetItem |
| **JobConfiguration / JobExecution** | eval 配置与运行实例（配置 vs 运行分离） | 配置长期，执行一次性 | JobConfig 1→N JobExecution |
| **InAppAgentConversation / Run / Event** | in-app agent 对话/运行/事件日志 | 运行状态机驱动 | Conversation 1→N Run 1→N Event |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
|----------|---------|--------|---------|
| `IBackgroundMigration` | `worker/src/backgroundMigrations/IBackgroundMigration.ts` | 各迁移类（如 `backfillEventsFullFromObservations`） | Prisma `background_migrations` 表动态 `require` |
| `SandboxProvider` / `SandboxSession` | `in-app-agent/server/sandbox/types.ts` | Docker provider / Lambda-MicroVM provider | `createExecutionSandbox` 工厂 |
| `singleFilter`（discriminated union） | `packages/shared/src/interfaces/filters.ts` | 12 种 filter 类型 | `createFilterFromFilterState` switch |
| tRPC procedure 层级 | `web/src/server/api/trpc.ts` | public/authed/project/org/admin/trace | 中间件链组合 |

## 代码目录

```shell
langfuse/
├── web/                     # Next.js app（UI + tRPC + 公开 REST API）
│   ├── src/pages/api/       # HTTP 入口：public/* REST、trpc、auth、project
│   ├── src/features/        # 76 个 feature 垂直切片（含 server tRPC router）
│   ├── src/components/       # 通用 UI（table / AdvancedJsonViewer 等）
│   └── src/server/api/      # tRPC context + appRouter 聚合
├── worker/                  # 后台进程（Express + 队列消费）
│   ├── src/queues/          # 27 个 queue processor + workerManager
│   ├── src/services/        # IngestionService / ClickhouseWriter / dlq
│   └── src/backgroundMigrations/  # 在位 ClickHouse 数据迁移
├── packages/shared/         # 共享层（无入向依赖）
│   ├── prisma/schema.prisma # Postgres schema（70+ 模型）
│   ├── clickhouse/migrations/  # 184 个 ClickHouse 迁移
│   └── src/server/         # domain / redis / queues / repositories / ingestion / otel
├── ee/                      # 企业版包（SSO / RBAC / 计费），被 web 引用
├── packages/in-app-agent-sandbox-runtime/  # microvm 沙箱独立进程
├── fern/                    # API 定义源（OpenAPI 生成）
└── scripts/                 # 仓库脚本（seeder / release / agent 工具）
```

关键入口文件：web 进程 `web/src/pages/api/public/ingestion.ts`（摄入）、`web/src/pages/api/trpc/[trpc].ts`（前端 tRPC）；worker 进程 `worker/src/index.ts` → `app.ts`（启动 + 注册 processor）。`packages/shared/src/db.ts` 暴露 `prisma` + `clickhouseClient` 单例。

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/langfuse-codewiki-4.11.0/module-dependencies.svg)

所有模块都收敛到 `packages/shared`（黄虚线），它无入向依赖——这是整个系统的契约锚点。横向数据流是：前端 → 公开 API → 摄入管线 → 队列 → worker → ClickHouse 写入。in-app agent 是相对独立的子系统（自带沙箱运行时），但运行也走队列 + 共享领域模型。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 摄入管线 | 接收 SDK/OTLP 事件，校验、去重、S3 卸载、入队 | `processEventBatch` / `OtelIngestionProcessor` | hot path 毫秒级返回与重活分离的边界 | [01-摄入管线](./01-ingestion-pipeline) |
| 队列基础设施 | BullMQ 分片队列、二级队列、DLQ、失败追踪 | `redis/ingestionQueue.ts` / `queues.ts` | 进程间解耦层，承载所有异步契约 | [02-队列基础设施](./02-queue-infrastructure) |
| ClickHouse 写入与存储 | 微批写入、宽表 SQL helper、仓储、events_core 统一 | `ClickhouseWriter` / `eventsTable.ts` | 列式存储与 ClickHouse 写入优化的专门层 | [03-ClickHouse 写入与存储](./03-clickhouse-write-storage) |
| 后台作业处理 | worker 进程、38+ processor、在位迁移、优雅关闭 | `app.ts` / `WorkerManager` | 重活隔离进程，web 保持快 | [04-后台作业处理](./04-worker-job-processing) |
| 公开 API 与鉴权 | REST + tRPC、API key scope、限流、中间件链 | `withMiddlewares` / `createAuthedProjectAPIRoute` | 对外契约层，隔离协议与核心 | [05-公开 API 与鉴权](./05-public-api-auth) |
| 领域模型与数据定义 | Prisma schema、domain zod、双库分工、表映射 | `schema.prisma` / `domain/` | 高扇入契约层，被所有进程 import | [06-领域模型与数据定义](./06-domain-data-model) |
| 应用内 Agent | 事件日志多派生、durable worker、microvm 沙箱 | `in-app-agent/server/` / sandbox-runtime | 自带沙箱运行时的独立子系统 | [07-应用内 Agent](./07-in-app-agent) |
| 前端架构与 Tracing UI | 76 feature、tRPC、共享 filter/table、列式访问 | `server/api/root.ts` / `features/traces/` | UI 与前端 API 层，观察产品的用户面 | [08-前端架构与 Tracing UI](./08-frontend-tracing-ui) |

> 模块间的动态调用顺序见下文「运行时行为 > 核心运行流程」。ClickHouse 宽表统一是 v4 的核心架构变更，单独有深度解读：[events_core 宽表统一](./03-clickhouse-write-storage-events-core-unification)。

## 运行时行为

### 启动流程

**web 进程**（Next.js）：`pnpm run dev` → Next 启动 → 加载 `web/src/initialize.ts`（Prisma client + Redis 连接 + OTel 插桩）→ pages router 暴露 `/api/public/*`、`/api/trpc/*`、UI 页面。对象装配：`prisma` 单例来自 `packages/shared/src/db.ts`（全局 omit 敏感列）；`redis` 单例来自 `redis/redis.ts`；API key 鉴权缓存挂在 Redis。

**worker 进程**：`worker/src/index.ts` → `initializeWorker()`（ClickHouse 兼容性检查 + 默认数据 upsert）→ `import("./app.js")` → `app.listen(3030)`。`app.ts` 启动时：① 注册 ~38 个 BullMQ Worker（`WorkerManager.register`，含 ingestion 的每个分片 + secondary 队列）；② 启动后台 runner（`BackgroundMigrationManager`、`DlqRetryService`、`ClickhouseWriter` 定时 flush）；③ `onShutdown` 注册优雅关闭回调。关键：worker 是 Express 但它的 HTTP 端点几乎是空的——它本质是"带健康检查端点的队列消费者集群"。

对象装配顺序：`ClickhouseWriter.getInstance()` 单例（持有 8 个按表队列 + 定时器）→ `IngestionService`（redis + prisma + clickhouseWriter 注入）→ 各 processor builder（工厂函数注入配置如 `enableRedirectToSecondaryQueue`）→ `WorkerManager.register`。

### 核心运行流程

Langfuse 跑起来后有几条主要业务链路：**摄入主链路**（事件从 SDK 到 ClickHouse）、**eval 执行链路**（trace 触发 LLM-as-judge/code eval）、**查询链路**（前端列表/详情读 ClickHouse）。这里展开摄入主链路——它是系统吞吐的主干，其余链路在对应模块文档里。

#### 摄入：JSON batch 主链路

业务流程：SDK 发 batch → web 鉴权限流 → S3 卸载 + 入队（同步返回）→ worker 异步消费 → 合并映射 → 微批写 ClickHouse + 元数据写 Postgres → 后续传播触发 eval/聚合。

![摄入主链路数据流](/vibe-reading/images/articles/langfuse-codewiki-4.11.0/data-flow.svg)

文字解读：`ingestion.ts` handler 先 `ApiAuthService.verifyAuthHeaderAndReturnScope`（Basic Auth 解析 API key，查 Redis 缓存 + Postgres），再 `RateLimitService.rateLimitRequest`（失败 fail-open 继续）。然后 `processEventBatch` 做重活：`createIngestionEventSchema` zod discriminatedUnion 校验每个事件 → `isAuthorized` 按 scope 过滤（score-create 需 `scores`/`project` accessLevel）→ `sortBatch`（非 update 在前、update 在后，保证 worker 先 create 后 update）→ 按 `entityType-eventBodyId` 分组。然后 `Promise.allSettled` 并发上传每组到 S3（**任一失败即 throw 500，整批拒绝**，不回退入队——宁可拒绝也不丢数据；SlowDown 则 `markProjectS3Slowdown` 标记二级队列）。最后 `IngestionQueue.getInstance({shardingKey: projectId-eventBodyId}).add` 入队，payload 只带 `fileKey + bucketPrefix + authCheck + type`（轻量指针，事件本体在 S3）。

worker 侧 `ingestionQueueProcessor` 消费：`bucketPrefix` 优先用 producer 传的（producer/consumer-must-agree 不变量）→ `recently-processed` Redis cache 去重 → 二级队列重定向检查（S3 SlowDown 或配置的大客户）→ 从 S3 下载文件（`listFiles` + 并发分批，或 `skipS3List` 直下）→ `IngestionService.mergeAndWrite` 按 `eventType` 分流：trace 走 `processTraceEventList`（查 ClickHouse 旧记录 + merge 不可变字段保护 + `addToQueue(Traces)` + trace_sessions UPSERT + 可选 staging 双写 + `TraceUpsertQueue` 触发 eval）；observation 走 `processObservationEventList`（含 `getGenerationUsage` 查 model pricing + 异步 tokenize + `addToQueue(Observations)` + staging 双写）；score 走 `processScoreEventList`。`ClickhouseWriter.addToQueue` 攒批，定时 1000ms / 满量 1000 触发 `flush` → `clickhouseClient.insert`（写 `events_full` 表，MV 自动填充 `events_core`）。错误分级重试：retryable 退避重试 / string-length error 半拆 / size error 截断 / 超过 maxAttempts drop 计入指标。

#### 摄入：OTLP 路径

OTLP 走单独的两阶段管线：`/api/public/otel/v1/traces` 用 `createAuthedProjectAPIRoute` 鉴权 → 读 body（protobuf 或 json，gzip 解压）→ `new OtelIngestionProcessor().publishToOtelIngestionQueue` 把原始 `resourceSpans` 上传 S3 + 入 `OtelIngestionQueue`（只带 `fileKey`）。worker 的 `otelIngestionQueue` 消费时再 `processor.processToIngestionEvents` 把 OTLP span 转成内部事件（`createTraceEvent` 生成 shallow/full trace，`createObservationEvent` 映射 span → observation，`ObservationTypeMapper` 推断类型）。转换后 observation 事件直接进 `IngestionService`，trace 事件回注到标准 `processEventBatch` 管线——OTLP 转换开销大且需要整批 seenTraces 去重上下文，所以挪到 worker 异步做。

#### eval 执行链路

trace 写入后 `TraceUpsertQueue` 触发，先 `hasNoEvalConfigsCache` 快速跳过无 eval 的项目；有则 `evalJobCreatorQueue` 创建 eval job → `evalJobExecutorQueue` 执行 → 按 evaluator 类型分流：LLM-as-judge 走 `llmAsJudgeExecutionQueue`（调 LLM 打分）、code eval 走 `codeEvalExecutionQueue`（沙箱跑用户代码）、人工标注走 `annotation-queues`。结果写回 scores 表。

### 状态流

in-app agent 的 run 有一个明确的生命周期状态机，是系统里状态流转最复杂的对象：

![In-App Agent run 状态流](/vibe-reading/images/articles/langfuse-codewiki-4.11.0/state-flow.svg)

状态定义在 `packages/shared/src/features/inAppAgent/types.ts` 的 `InAppAgentRunStatus`（QUEUED / RUNNING / AWAITING_APPROVAL / SUCCEEDED / FAILED / CANCELLED），存为普通字符串列（非 PG enum，便于加状态免 `ALTER TYPE`）。状态转换用 Postgres CAS（compare-and-swap）在 `runLifecycle.ts` 完成（`claimRun` QUEUED→RUNNING、`heartbeatClaimedRun` 续命、approval 决策 AWAITING_APPROVAL→RUNNING/SUCCEEDED/FAILED、`reconcileConversationRuns` 强制单 active run）。错误码 `InAppAgentRunErrorCode`（`WORKER_LOST` 心跳超时、`RUN_TIMEOUT` 超时长跑、`OUTCOME_UNKNOWN` 已批准变更结果未持久化、`APPROVAL_EXPIRED` 等）由 watchdog 和 backstop 定时器设置。worker 优雅关闭时把 RUNNING 改 `CANCELLED` + `WORKER_SHUTDOWN`。

## 典型修改场景

#### 场景 1：新增一种 observation 事件类型

1. `packages/shared/src/server/ingestion/types.ts`：`eventTypes` 加常量 + `createIngestionEventSchema` 加 zod schema 进 discriminatedUnion
2. `packages/shared/src/server/clickhouse/schemaUtils.ts`：`getClickhouseEntityType` 映射新类型到 `"observation"`
3. `packages/shared/src/server/ingestion/processEventBatch.ts`：`sortBatch` 的 update 数组 + `isAuthorized` 权限
4. 对应测试：`packages/shared/src/server/ingestion/` 下加 case
   对应测试：`worker/src/__tests__/ingestion.test.ts`

#### 场景 2：新增一个后台作业队列

1. `packages/shared/src/server/queues.ts`：加 `QueueName` 枚举 + payload zod schema（`TQueueJobTypes` 类型扩展）
2. `packages/shared/src/server/redis/`：加 queue 类（仿 `ingestionQueue.ts` 分片 + getInstance）
3. `worker/src/queues/`：加 processor builder（工厂注入配置）
4. `worker/src/app.ts`：`WorkerManager.register` 注册（分片队列还要在 `shardedQueueRegistry.ts` 注册）
   对应测试：`worker/src/__tests__/`

#### 场景 3：新增一个 ClickHouse 列 + 查询

1. `packages/shared/src/eventsTable.ts`：`eventsTableColsDefinition` 加列定义（`internal` 指向 CH 列/SQL）
2. `packages/shared/clickhouse/migrations/`：加 `ALTER TABLE ... ADD COLUMN` 迁移（clustered + unclustered）
3. `packages/shared/src/server/repositories/definitions.ts`：插入记录 zod schema 加字段
4. `worker/src/services/IngestionService/`：构造记录时填充新字段
5. 如需查询：`repositories/events.ts` 的 `EventsQueryBuilder` field set 加列
   对应测试：`packages/shared/src/server/repositories/events.test.ts`

## 测试体系

```
web/src/__tests__/        # web 集成测试
web/src/__e2e__/          # Playwright 端到端
worker/src/__tests__/     # worker 单元/集成
packages/shared/.../*.test.ts  # 共享层就近测试
```

测试与代码的对应关系：

| 代码层 | 测试类型 | 位置约定 |
|--------|---------|---------|
| ingestion / otel 处理器 | 单元 + 闭卷 | `packages/shared/src/server/ingestion/*.test.ts` |
| repositories（ClickHouse 查询） | 集成（需 CH） | `packages/shared/src/server/repositories/*.test.ts` |
| tRPC router / 公开 API | 集成 servertest | `web/src/**/*servertest.ts` |
| queue processor | 集成 | `worker/src/__tests__/` |
| UI 组件 | 单元 + Storybook | `web/src/**/*.clienttest.ts` + `web/.storybook/` |
| 端到端 | Playwright | `web/src/__e2e__/` |

`pnpm run seed` 的 seeder 场景是"可执行文档"——很多行为先用 seeder 表达再写代码。修改某层时优先看它对应的测试。

## 阅读源码推荐路线

- **第一遍：理解摄入主流程**
  `web/src/pages/api/public/ingestion.ts` 的 handler → `packages/shared/src/server/ingestion/processEventBatch.ts` 的 `processEventBatch`（L116，重点看 L167 校验、L217 分组、L279 S3 上传、L341 入队）→ `worker/src/queues/ingestionQueue.ts` 的 `ingestionQueueProcessorBuilder`（L33）→ `worker/src/services/IngestionService/index.ts` 的 `mergeAndWrite` → `worker/src/services/ClickhouseWriter/index.ts` 的 `addToQueue` + `flush`（L364）

- **第二遍：理解队列与分片**
  `packages/shared/src/server/redis/ingestionQueue.ts`（`IngestionQueue.getInstance` 分片）→ `redis/sharding.ts`（`getShardIndex` SHA256）→ `redis/s3SlowdownTracking.ts` + `ingestionFailureTracking.ts` → `worker/src/queues/workerManager.ts`（`register` + `metricWrapper`）→ `worker/src/app.ts`（看 processor 注册段）

- **第三遍：理解数据模型与宽表统一**
  `packages/shared/prisma/schema.prisma`（看 ApiKey/Project/ScoreConfig/Dataset/JobConfiguration/InAppAgent* 模型）→ `packages/shared/src/domain/observations.ts`（zod schema）→ `packages/shared/src/eventsTable.ts`（`eventsTableTraceNameSql` 等 SQL helper，重点读注释解释 v3→v4）→ `packages/shared/src/server/repositories/events.ts`（`getTraceByIdFromEventsTable`）→ 深度附件 [events_core 宽表统一](./03-clickhouse-write-storage-events-core-unification)

- **第四遍：理解前端与列式访问**
  `web/src/server/api/root.ts`（appRouter 聚合）→ `web/src/server/api/trpc.ts`（procedure 层级 + `enforceTraceAccess` 中间件）→ `web/src/features/traces/`（`useTraceDetailData` + `TraceTree` + `AdvancedJsonViewer`）→ `packages/shared/src/server/services/traces-ui-table-service.ts`（`select: "rows"` 窄列 vs `"metrics"` JOIN）

- **第五遍：选择重点子模块深入**（模块文档；in-app agent 最值得读 `ARCHITECTURE.md` 原文）
  `web/src/features/in-app-agent/ARCHITECTURE.md` → `packages/shared/src/in-app-agent/server/runLifecycle.ts`（CAS 状态机）→ `packages/in-app-agent-sandbox-runtime/src/server.ts`（microvm 沙箱）

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| **Observation** | 一次 LLM 调用/检索/工具执行/agent 动作，Langfuse 的主分析单元 |
| **Trace** | 关联一组 observation 的 correlation handle（一次用户请求的完整链路） |
| **Wide Events** | 宽而富属性的事件模型，Langfuse v4 的核心架构原则（见 `ARCHITECTURE_PRINCIPLES.md`） |
| **events_core / events_full** | v4 统一宽表：full 存完整 I/O，core 存截断版（MV 自动填充） |
| **shardingKey** | `projectId-eventBodyId`，BullMQ 队列分片键，保证同实体串行 |
| **bucketPrefix** | S3 key 前缀，producer 计算后随队列 payload 传给 consumer（不变量） |
| **AG-UI** | Agent streaming 协议，in-app agent 用它流式传输消息 delta |
| **CAS** | Compare-And-Swap，in-app agent run 状态转换的并发控制手段 |
| **DLQ** | Dead Letter Queue，重试耗尽后的死信队列 |

### 参考资料

- [Simplifying Langfuse for Scale](https://langfuse.com/blog/2026-03-10-simplify-langfuse-for-scale) — v4 宽表统一的官方博客
- [All you need is Wide Events](https://isburmistrov.substack.com/p/all-you-need-is-wide-events-not-metrics) — Wide Events 方法论
- [Charity Majors on Observability 2.0](https://charity.wtf/tag/observability-2-0/) — 可观测性思想来源
- 仓库内 `.agents/ARCHITECTURE_PRINCIPLES.md` — 架构原则原文
- 仓库内 `web/src/features/in-app-agent/ARCHITECTURE.md` — in-app agent 架构契约原文
