---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "摄入管线"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "Ingestion", "OTel", "Apache Doris", "events_full"]
description: "Litefuse 摄入管线：OTel resourceSpans → S3 暂存 → 队列 → IngestionService 富化 EventRecord → DorisWriter，含 events_full 统一迁移与 SDK direct-write 门控。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/00-overview)

---

## 模块定位

摄入管线是 Litefuse 写路径的"心脏"——它把 SDK 上报的 OTel resourceSpans（或 legacy JSON batch）转换成 Doris 可写的 `EventRecord`，并交给 `DorisWriter` 批量落盘。它的职责边界：解析、校验、富化（prompt/usage/cost）、SDK 版本门控、采样、分发到 Doris 各表；它不负责最终的 stream load HTTP 调用（那是 DorisWriter 的事），也不负责查询。这个模块之所以独立，是因为"事件→记录"的转换逻辑复杂且频繁演进（events_full 统一迁移正在此发生），需要与存储层解耦。

## 模块架构

摄入管线由三个核心组件协作：`OtelIngestionProcessor`（shared 包，负责 OTel 语义解析与 S3/队列发布）、`otelIngestionQueueProcessor` / `ingestionQueueProcessorBuilder`（worker 队列消费者，串联整条链路）、`IngestionService`（worker 服务，单一转换点 `EventInput → EventRecordInsertType`）。Web 侧的 `processEventBatch` 是 legacy JSON batch 的入口（OTel-only fork 后仅 score-create/sdk-log 走它）。

## 调用链路

```
SDK POST /api/public/otel/v1/traces (resourceSpans)
  → createAuthedProjectAPIRoute (鉴权+限流)
  → OtelIngestionProcessor.publishToOtelIngestionQueue   (shared)
      ├─ getS3EventStorageClient().uploadJson(fileKey, resourceSpans)
      └─ OtelIngestionQueue.getInstance({}).add(...)      ──Redis 队列──►
  [跨模块边界: web → worker, Redis payload 含 fileKey + authCheck + SDK headers]
  → otelIngestionQueueProcessor (worker/src/queues/otelIngestionQueue.ts:200)
      ├─ S3 download fileKey → JSON.parse → parsedSpans
      ├─ processor.processToIngestionEvents(parsedSpans) → IngestionEventType[]   (拆 traces/observations)
      ├─ processor.processToEvent(parsedSpans) → EventInput[]
      ├─ prisma.traceSession.createMany(...)             ──PG 元数据──►
      └─ Promise.all(eventInputs.map):
          ├─ ingestionService.createEventRecord(eventInput, fileKey) → EventRecordInsertType
          ├─ scheduleObservationEvals({observation, configs, schedulerDeps})   (独立于写入)
          └─ ingestionService.writeEventRecord(eventRecord)
              └─ DorisWriter.addToQueue(TableName.EventsFull, eventRecord)   ──► DorisWriter
```

数据类型流转：`ResourceSpan[]`（OTel 原生）→ `IngestionEventType[]`（内部事件）→ `EventInput`（扁平 span 属性集，含 traceId/spanId/input/output/metadata）→ `EventRecordInsertType`（Doris events_full 行，含 `metadata_names`/`metadata_values` 并行数组）→ DorisWriter 队列项。

## 核心实现

### IngestionService 单一转换点

```ts title="worker/src/services/IngestionService/index.ts:201"
export class IngestionService {
  constructor(
    private redis: Redis | Cluster,
    private prisma: PrismaClient,
    private dorisWriter: DorisWriter | null,
    private dorisClient: DorisClientType | null,
  )
  // 按 eventType 分派到 processTraceEventList / processObservationEventList / processScoreEventList / processDatasetRunItemEventList
  async mergeAndWrite(eventType, projectId, eventBodyId, createdAtTimestamp, events, forwardToEventsTable): Promise<void>
  // 单一转换点：EventInput → EventRecordInsertType（prompt 查找、model/token 富化、metadata 扁平化、ms 时间戳）
  async createEventRecord(eventData: EventInput, fileKey: string): Promise<EventRecordInsertType>
  // 写入哨兵：单行 enqueue 到 DorisWriter.EventsFull
  writeEventRecord(eventRecord: EventRecordInsertType): void
}
```

`createEventRecord`（`:276`）内部用 `Promise.all` 并发富化 prompt（`promptService.getPrompt`）与 generation usage（`getGenerationUsage`），是 trace/observation/score 共用的富化入口——这样后续无论走哪张 Doris 表，富化逻辑只此一处。`writeEventRecord`（`:477`）只是 `dorisWriter.addToQueue(TableName.EventsFull, eventRecord)` 的一行哨兵，把"何时批写"的决策完全交给 DorisWriter。

### OtelIngestionProcessor 与 events_full 统一迁移

`OtelIngestionProcessor`（`packages/shared/src/server/otel/OtelIngestionProcessor.ts:142`）持有 `seenTraces: Set`（Redis 加载近 10min 已见 trace，去重）与 `traceEventCounts`。它产两种输出：`processToIngestionEvents`（legacy `IngestionEventType[]`，供旧双写路径）与 `processToEvent`（`EventInput[]`，供新 events_full 路径）。`filterRedundantShallowTraces` 在 shallow trace-create 被后续 full trace 覆盖时丢弃前者。

events_full 统一迁移用 `legacyDualWrite()` 哨兵函数（`otelIngestionQueue.ts:94`）控制：

```ts title="worker/src/queues/otelIngestionQueue.ts:94"
function legacyDualWrite(): boolean {
  return false;   // master: events_full 是唯一写入目标
}
```

它故意写成函数而非常量，避免 TypeScript 把 `if (false)` 分支常量折叠标为 unreachable、丢失类型检查——紧急时翻 `true` 即可恢复旧双写（`mergeAndWrite` + `processEventBatch`）。

### SDK direct-write 门控

是否走 events_full direct-write 由两级优先级决定（`otelIngestionQueue.ts:313-338`）：

1. **Priority 1 HTTP header**：`x-langfuse-sdk-name` python≥4.0.0 / javascript≥5.0.0，或 `x-langfuse-ingestion-version`≥4（自定义 OTel exporter opt-in）。命中则整 batch（含第三方 scope span）走 direct write。
2. **Priority 2 per-span scope**：scope.name 含 `langfuse` + `sdk-experiment` 环境 + python≥3.9.0 / js≥4.4.0。

`extractBaseSdkVersion`（`:98`）剥离 semver pre-release（`4.0.0-rc.1`→`4.0.0`）与 Python PEP440 shorthand（`4.0.0b1`→`4.0.0`），让 RC 也合格。门控保证只有产出正确 `EventInput` 的 SDK 版本才 direct-write，旧版降级防数据错乱。

### processEventBatch（legacy JSON 入口）

`processEventBatch`（`packages/shared/src/server/ingestion/processEventBatch.ts:104`）是 legacy JSON batch 的入口：`createIngestionEventSchema` + `isAuthorized` Zod 校验（`:154`）→ `sortBatch`（non-update 在前、update 按时间在后）→ 按 eventBodyId 分组 `uploadJson` 到 S3（`:227`）→ `isTraceIdInSample` 采样过滤（`:300`）→ `IngestionQueue.getInstance({shardingKey}).add`（`:321`）。`shardingKey = projectId-eventBodyId` 保证同事件有序落同一 shard。

### 采样与时间戳

- **采样**（`packages/shared/src/server/ingestion/sampling.ts:6` `isTraceIdInSample`）：仅对 `LITEFUSE_INGESTION_PROCESSING_SAMPLED_PROJECTS` 配置的项目生效，SHA-256(traceId) 取前 32 bit 归一化与 sampleRate 比较——确定性采样，同 trace 永远同决定；未配置项目全量通过。
- **分区锁时间戳**（`IngestionService/index.ts:2234` `getPartitionAwareTimestamp`）：createdAtTimestamp 超 2min 则改用当前时间，防更新落到已锁分区造成数据缺口（从 3.5min 降到 2min 观察到的 deletion gaps）。
- **ms 精度**（`IngestionService:2217` `getMillisecondTimestamp`）：Doris `DateTime(3)` 是毫秒精度，必须用 ms 而非上游 ClickHouse 的 μs，否则日期落到 year 58000+。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂 | `StorageServiceFactory.getInstance`（`processEventBatch.ts:42`）、`DorisWriter.getInstance` | 单例化 S3/DorisWriter，复用连接 |
| 策略 + 注册表 | `ObservationTypeMapperRegistry`（`ObservationTypeMapper.ts:165`）持 `ObservationTypeMapper[]`，按 priority 评估 `canMap`/`map` | 新增 observation-type 归类规则只需 push 一个 mapper |
| 哨兵/守卫 | `legacyDualWrite()`（`otelIngestionQueue.ts:94`） | 函数式屏蔽旧分支但保留类型检查，可紧急回滚 |
| 分派 | `mergeAndWrite`（`IngestionService:213`）按 eventType switch | 单入口多处理函数 |
| 中间件式分阶段 | `eventInputs.map` 内 `createEventRecord` → `scheduleObservationEvals` → `writeEventRecord`，各步独立 try/catch | eval 失败不阻断写入，反之亦然 |

## 模块间交互

- **依赖**：`DorisWriter`（构造期注入）、`prisma`（scoreConfig/datasetRuns/traceSession.createMany/prompt 查找）、`redis`（IngestionQueue 分片、seen-event 缓存 5min、seenTraces Set 10min）、`dorisClient`、S3 `StorageService`。
- **被调用**：`otelIngestionQueue` / `ingestionQueue` processor 实例化 `IngestionService` 并调用；`OtelIngestionProcessor` 由 `otelIngestionQueueProcessor` 实例化，产 `EventInput` 回喂 IngestionService。
- **跨模块边界**：web→worker 经 Redis 队列 payload（含 fileKey + authCheck + SDK headers）；worker→Doris 经 DorisWriter stream load；worker→PG 经 Prisma。

## 扩展方式

新增一种事件类型（如 `eval-result`）：① `packages/shared/src/server/ingestion/types.ts` 加 eventType 枚举 + body schema；② `IngestionService.mergeAndWrite`（`:213`）switch 加 case + 新 `processXxxEventList`；③ `getDorisEntityType`（`server/doris/schemaUtils.ts`）加映射；④ `DorisWriter` 的 `TableName` + `RecordInsertType<T>` 加分支；⑤ 调整 otelIngestionQueue 的 traces/observations 拆分 filter。对应测试：`worker/src/services/IngestionService/tests/`。
