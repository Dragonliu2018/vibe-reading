---
source:
  type: "源码解读"
  project: "Langfuse"
  url: "https://github.com/langfuse/langfuse"
title: "摄入管线"
date: "2026-08-18T16:35:50+08:00"
category: ["AI", "Agent", "Observability", "Langfuse", CodeWiki, "4.11.0"]
tags: ["Langfuse", "Ingestion", "OTLP", "Zod"]
description: "Langfuse 摄入管线：JSON batch 与 OTLP 两路摄入、eventBodyId 去重分组、S3 卸载、延迟入队防乱序。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Langfuse/CodeWiki/4.11.0/00-overview)

---

## 模块定位

摄入管线是 Langfuse 的"前门"——SDK 和 OTLP 客户端的所有事件都从这里进。它的核心职责边界是：**鉴权之后、入队之前的一切同步处理**——校验、去重分组、S3 卸载、入队。它不写 ClickHouse（那是 worker + ClickhouseWriter 的事），也不做 OTLP→内部模型的转换（OTLP 路径的转换在 worker 异步做）。

它必须毫秒级返回，因为 SDK 的 LLM 调用在阻塞等它。所以设计上这是一条"只做轻活、把重活甩进队列"的路径。

## 模块架构

摄入管线跨两个包，分两条入口路径：

- **JSON 路径**：`web/src/pages/api/public/ingestion.ts` → `packages/shared/src/server/ingestion/processEventBatch.ts`
- **OTLP 路径**：`web/src/pages/api/public/otel/v1/traces/` → `packages/shared/src/server/otel/OtelIngestionProcessor.ts`

两条路径都把事件本体卸载到 S3、把轻量指针入 Redis 队列，但分入不同的队列（`IngestionQueue` vs `OtelIngestionQueue`），且 OTLP 在 worker 完成转换后会把 trace 事件回注到标准 JSON 管线。

核心组件：

| 组件 | 位置 | 职责 |
|------|------|------|
| `processEventBatch` | `packages/shared/src/server/ingestion/processEventBatch.ts:116` | JSON 批次主处理：校验→分组→S3→入队 |
| `OtelIngestionProcessor` | `packages/shared/src/server/otel/OtelIngestionProcessor.ts:241` | OTLP span→内部事件转换 + 入队 |
| `IngestionEventType` / `eventTypes` | `ingestion/types.ts` | 事件类型枚举 + zod discriminatedUnion |
| `createIngestionEventSchema` | `ingestion/types.ts:840` | 区分 public/internal 两套 environment 校验 |
| `IngestionAttribution` | `ingestion/ingestionAttribution.ts:7` | 携带 SDK name/version/apiKey 归因 |
| `isTraceIdInSample` | `ingestion/sampling.ts:6` | trace 级 SHA256 采样 |

## 调用链路

### JSON 路径（同步阶段）

```
ingestion.ts handler (L55)
  ├─ cors runMiddleware (L62)
  ├─ ApiAuthService.verifyAuthHeaderAndReturnScope (L83)  // Basic Auth → Redis+PG 查 key
  │     → AuthHeaderValidVerificationResultIngestion { scope: {projectId, accessLevel, orgId?, plan?} }
  ├─ 鉴权失败 → 401/403；isIngestionSuspended → 403 (L88-103)
  ├─ contextWithLangfuseProps → OTel context 注入 projectId/apiKeyId (L105)
  ├─ RateLimitService.rateLimitRequest (L118)  // 失败 fail-open 继续 (L127)
  ├─ zod 校验 body {batch: z.array(z.unknown()), metadata} (L133)
  ├─ filterBatchForEventsOnly (L156)  // v4 events_only 仅放行 score/sdk-log
  ├─ createIngestionAttribution (L161)  // 从 x-langfuse-sdk-* header 提取
  └─ processEventBatch(batch, authCheck, {attribution, delay, source}) (L176)
       ├─ createIngestionEventSchema.safeParse 每事件 (L170)  // zod discriminatedUnion("type",…)
       ├─ isAuthorized(parsed, authCheck) (L183)  // score-create 需 scores/project scope
       ├─ SDK_LOG 仅 log 不处理 (L193)
       ├─ sortBatch (L201, L441)  // 非 update 在前、update 在后，timestamp asc
       ├─ 按 eventBodyId 分组 (L217)  // key=`${entityType}-${event.body.id}`，算 bucketPrefix
       ├─ Promise.allSettled S3 upload (L283)  // 任一失败 s3UploadErrored=true → throw 500 (L328)
       └─ IngestionQueue.getInstance({shardingKey:`${projectId}-${eventBodyId}`}).add (L345)
            payload: {data:{type,eventBodyId,fileKey,bucketPrefix,ingestionApiKey,sdkName,sdkVersion}, authCheck}
            delay: getDelay(delay, source) (L72)
```

### OTLP 路径（两阶段）

第一阶段（web 同步）：`/api/public/otel/v1/traces` 用 `createAuthedProjectAPIRoute` 鉴权 → 读 body（protobuf / json，gzip 解压）→ `validateOtelSpanIds` → `new OtelIngestionProcessor(...)` → `publishToOtelIngestionQueue(resourceSpans)`（上传原始 `resourceSpans` 到 S3 + 入 `OtelIngestionQueue`，payload 只带 `fileKey`）。

第二阶段（worker 异步）：`otelIngestionQueue` 消费 → `processor.processToIngestionEvents(parsedSpans)` 转换 → observation 事件直接进 `IngestionService`，trace 事件回注 `processEventBatch` 标准管线。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `processEventBatch` (`processEventBatch.ts:116`) | JSON 批次校验+分组+S3+入队 | 返回 successes/errors，任一 S3 失败整批 throw |
| `getDelay` (`processEventBatch.ts:72`) | 计算入队延迟 | 23:45-00:15 UTC 加延迟防跨日乱序；OTLP=0 |
| `sortBatch` (`processEventBatch.ts:441`) | 非 update 先于 update | 保证 worker 先 create 后 update |
| `OtelIngestionProcessor.publishToOtelIngestionQueue` (`OtelIngestionProcessor.ts:302`) | OTLP 入队 | 原始 resourceSpans 上传 S3 |
| `processToIngestionEvents` (`OtelIngestionProcessor.ts`) | OTLP→内部事件 | 用 seenTraces Redis Set 去重 trace |
| `processSpan` (`OtelIngestionProcessor.ts:862`) | span→trace+observation 事件 | shallow trace 仅 id/timestamp/environment |
| `createObservationEvent` (`OtelIngestionProcessor.ts:1109`) | span→observation | ObservationTypeMapper 推断类型 |
| `filterRedundantShallowTraces` (`OtelIngestionProcessor.ts:752`) | 去冗余 shallow trace | 有 full trace 时移除 shallow |
| `isTraceIdInSample` (`sampling.ts:6`) | trace 采样 | SHA256 traceId 取前 32 位 % 1 < 采样率 |

</details>

## 核心实现

### 事件类型与 zod 校验

`eventTypes` 枚举了 18 种事件类型，覆盖 trace/observation/score 的 create+update 以及 dataset-run-item：

```typescript title="packages/shared/src/server/ingestion/types.ts:279"
export const eventTypes = {
  TRACE_CREATE: "trace-create",
  SCORE_CREATE: "score-create",
  SPAN_CREATE: "span-create",  SPAN_UPDATE: "span-update",
  GENERATION_CREATE: "generation-create",  GENERATION_UPDATE: "generation-update",
  AGENT_CREATE: "agent-create",  TOOL_CREATE: "tool-create",
  // … EVALUATOR / EMBEDDING / GUARDRAIL / SDK_LOG / DATASET_RUN_ITEM_CREATE …
  OBSERVATION_CREATE: "observation-create",  OBSERVATION_UPDATE: "observation-update", // legacy
} as const;
```

`IngestionEventType` 是 `z.discriminatedUnion("type", [...])` 的推断类型。`createIngestionEventSchema(isLangfuseInternal)` 工厂区分 public/internal 两套校验——internal 路径（如 prompt 实验）保留 `langfuse-` 环境前缀，public 路径剥离它，避免内部 trace 被暴露成用户环境并绕过 trace-upsert eval-loop 保护。

### eventBodyId 分组与 S3 卸载

`processEventBatch` 把 batch 按 `entityType-eventBodyId` 分组（`processEventBatch.ts:217`）。同一 API 请求里对同一实体的 create+update 被合并到一个 S3 文件，减少写操作，并保证 worker 一次读到该实体全部事件、按序处理。`bucketPrefix` 在 producer 侧计算（`buildEventBucketPrefix`），随队列 payload 传给 consumer——这是 **producer/consumer-must-agree 不变量**：consumer 永远不重建路径，即使 env 值在 web/worker 容器间漂移也不会找错 S3 key。

S3 上传用 `Promise.allSettled`（`processEventBatch.ts:283`）：每个分组独立 settle，单个失败不阻断其他上传的完成；但只要有任一失败，`s3UploadErrored=true`，随后**整批 throw 500**——宁可拒绝请求也不冒数据丢失风险（worker 消费时拿不到 S3 payload 就会丢事件）。SlowDown 错误额外 `markProjectS3Slowdown` 标记项目走二级队列。

### OTLP span → observation 映射

`OtelIngestionProcessor`（3611 行）是 OTLP 路径的核心。`processSpan` 对每个 span 生成 trace 事件 + observation 事件：

| OTLP Span 字段 | Langfuse Observation 字段 | 代码 |
|---------------|--------------------------|------|
| `spanId` (byte→hex) | `observation.id` | L1169 |
| `traceId` / `parentSpanId` | `traceId` / `parentObservationId` | L1170, L903 |
| `startTimeUnixNano`→ISO / `endTimeUnixNano`→ISO | `startTime` / `endTime` | L917, L1173 |
| `attributes[gen.*.usage.*]` / `[gen.*.cost.*]` | `usageDetails` / `costDetails` | L1218, L1225 |
| `span.events` + `attributes` | `input` / `output`（via `extractInputAndOutput`） | L1130 |
| `resource/scope.attributes` | `metadata.resourceAttributes` / `scope` | L1146-1149 |
| `status.code === 2` | `level = ERROR` | L1185 |
| `ObservationTypeMapperRegistry` | event type（GENERATION/SPAN/AGENT/TOOL…） | L1159, L1241 |

trace 去重用 `seenTraces` Set（从 Redis 加载近 10 分钟已见 trace）。非 root span 且无 trace 更新属性时生成 **shallow trace**（仅 id/timestamp/environment），后续由 `filterRedundantShallowTraces` 在存在 full trace 时移除。

### 摄入归因与采样

`IngestionAttribution`（`ingestionAttribution.ts:7`）携带 `ingestionApiKey`/`ingestionSdkName`/`ingestionSdkVersion`，从 HTTP header 提取。它用于：① UI 展示"此事件由 Python SDK v3.x 发送"；② `classifyIngestionSdkVersion` 比较大版本提示升级；③ OTLP worker 据此判断走 direct write 还是 staging 双写；④ 故障追踪日志定位 SDK 版本。

`isTraceIdInSample`（`sampling.ts:6`）按项目采样率对 `traceId` 做 SHA-256 哈希取前 32 位转 [0,1)，低于采样率则保留——保证同一 traceId 的全部事件（trace + observations + scores）一致地被采样或丢弃。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 批处理 + eventBodyId 去重分组 | `processEventBatch.ts:217` | 合并同实体事件到一 S3 文件，降写操作 + 保证消费原子性 |
| S3 卸载 + 任一失败 throw | `processEventBatch.ts:283-329` | S3 是持久缓存，不可用则拒绝而非丢数据 |
| 延迟入队防乱序 | `getDelay` `processEventBatch.ts:72` | 跨日 Redis key 过期导致去重失败，加延迟集中处理 |
| 队列分片 | `redis/ingestionQueue.ts` by `projectId-eventBodyId` | 同实体串行消费避免并发更新冲突 |
| 两级队列分流 | IngestionQueue vs OtelIngestionQueue | OTLP 转换开销大需整批上下文，挪到 worker 异步 |
| Trace 级采样 | `sampling.ts` by traceId | 整 trace 一致采/弃，不出现半截 trace |
| Wide Events | `types.ts` CreateGenerationBody 等 | observation 携带全部上下文，不做碎片化拆分 |
| producer/consumer 不变量 | `bucketPrefix` 随 payload 传 | consumer 不重建路径，env 漂移也不找错 S3 key |

## 模块间交互

摄入管线 import：`redis/ingestionQueue`（入队）、`services/StorageService`（S3）、`redis/s3SlowdownTracking` + `ingestionFailureTracking`（降级标记）、`ingestion/sampling`（采样）、`clickhouse/schemaUtils`（entity 类型映射）、`instrumentation`（OTel span/metrics）、`otel/OtelIngestionProcessor`（OTLP 转换）。

被调用方：`web/src/pages/api/public/ingestion.ts`（JSON 入口）、`web/src/pages/api/public/otel/v1/traces/`（OTLP 入口）、`worker/src/queues/otelIngestionQueue.ts`（worker 侧 OTLP 转换后回注 `processEventBatch`）、`worker/src/features/experiments/`（内部 prompt 实验直接调 `processEventBatch`）。

## 扩展方式

**新增一种 observation 事件类型**（如 `tool-update`）：
1. `ingestion/types.ts`：`eventTypes` 加常量 + `createIngestionEventSchema` 加 schema 进 union
2. `server/clickhouse/schemaUtils.ts`：`getClickhouseEntityType` 映射到 `"observation"`
3. `processEventBatch.ts`：`sortBatch` update 数组（L442）+ `isAuthorized`（L420）

**修改 OTLP 字段映射**（如新增 cost 属性）：
1. `otel/OtelIngestionProcessor.ts`：`createObservationEvent`（L1109）的 `extractCostDetails` 调用处
2. `otel/attributes.ts`：如需常量，在 `LangfuseOtelSpanAttributes` 加条目
3. 测试 `processToIngestionEvents` 输出含新值

> OTLP Metrics 端点（`/api/public/otel/v1/metrics`）目前是空实现 `fn: async () => {}`——Langfuse 不支持 OTLP metrics 摄入，符合 Wide Events 原则（不需要碎片化 metrics）。`ArraySlotBudget`（`OtelIngestionProcessor.ts:112`）是 OTLP 独有保护：防止 `0.role`/`9999.content` 这类 flattened array 属性重建时分配超大数组（上限 10001 slots）。
