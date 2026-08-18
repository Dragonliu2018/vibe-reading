---
source:
  type: "源码解读"
  project: "Langfuse"
  url: "https://github.com/langfuse/langfuse"
title: "ClickHouse 写入与存储"
date: "2026-08-18T16:35:50+08:00"
category: ["AI", "Agent", "Observability", "Langfuse", CodeWiki, "4.11.0"]
tags: ["Langfuse", "ClickHouse", "Micro-batching", "Wide Events", "Repository"]
description: "Langfuse ClickHouse 层：ClickhouseWriter 微批单例、events_core 宽表 SQL helper、30 个仓储、v3→v4 路由 wrapper。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Langfuse/CodeWiki/4.11.0/00-overview)

---

## 模块定位

这一层管"事件最终怎么落进 ClickHouse，以及怎么从 ClickHouse 查出来"。职责边界：微批写入（攒批 + flush + 重试）、ClickHouse 表/列定义、宽表 SQL helper、仓储（数据访问）。它不碰摄入校验和入队（那是摄入管线），不跑 eval/导出（那是 worker processor）。它是 v4 宽表统一的主战场——`events_core` 替代分散的 traces/observations/scores 三表，是 [Simplifying Langfuse for Scale](https://langfuse.com/blog/2026-03-10-simplify-langfuse-for-scale) 的核心落地。

## 模块架构

```
worker/src/services/ClickhouseWriter/index.ts   # 微批写入单例（666 行）
packages/shared/src/
├── eventsTable.ts                               # events_core 统一表 SQL helper（522 行）
├── observationsTable.ts                         # legacy observations 列定义
├── tableDefinitions/                             # 14 个表/列定义
│   ├── types.ts (ColumnDefinition union, TableNames)
│   └── index.ts
└── server/
    ├── clickhouse/ (schema.ts: ClickhouseTableNames; schemaUtils.ts: getClickhouseEntityType; client.ts)
    └── repositories/                             # 30 个数据访问 repo
        ├── index.ts (导出 30 模块)
        ├── events.ts (3672 行)                    # events 仓储：查询/更新/删除/filter
        ├── traces.ts (2001 行)                    # legacy traces + routing wrapper
        ├── observations.ts, scores.ts, datasets.ts, …
        └── clickhouse.ts (queryClickhouse 封装)
```

## 调用链路

**写路径**：

```
worker ingestionQueueProcessor (ingestionQueue.ts)
  └─ IngestionService.mergeAndWrite (IngestionService/index.ts:165)
       ├─ processTraceEventList → clickHouseWriter.addToQueue(TableName.Traces) (L789)
       │                          → addToQueue(TableName.ObservationsBatchStaging) (L816)  // 双写
       ├─ processObservationEventList → addToQueue(TableName.Observations) (L1012)
       │                               → addToQueue(TableName.ObservationsBatchStaging) (L1024)
       ├─ processScoreEventList → addToQueue(TableName.Scores) (L709)
       └─ writeEventRecord → addToQueue(TableName.EventsFull)        // v4 主写目标

ClickhouseWriter (index.ts:35)
  ├─ addToQueue(tableName, data) (L576)  → push queue[tableName] → 满量触发 flush
  ├─ setInterval(flushAll, writeInterval) (L83)  // 定时触发
  ├─ flush(tableName, fullQueue) (L364)
  │    ├─ splice batch
  │    ├─ clampDecimal64Fields (L288)  // Decimal64(12) 溢出保护
  │    └─ backOff(writeToClickhouse) (L406)
  │         ├─ isRetryableError → 退避重试
  │         ├─ isStringLengthError → 半拆批次重试
  │         ├─ isSizeError → 截断 input/output/metadata 重试
  │         └─ 超过 maxAttempts → drop + recordIncrement("rows_dropped")
  └─ writeToClickhouse (L596) → clickhouseClient.insert({table, format:"JSONEachRow", values})
       // EventsFull 写入 → MV 自动填充 events_core
```

**读路径**：

```
web/public-api/worker 查询
  └─ repositories/events.ts (如 getObservationsFromEventsTableForPublicApi)
       ├─ EventsQueryBuilder / CTEQueryBuilder
       │    ├─ selectFieldSet("base"/"core"/"count"/"metrics")
       │    ├─ where(appliedFilter) → createFilterFromFilterState
       │    └─ eventsTracesAggregation (CTE 聚合 events → traces)
       ├─ eventsTable.ts SQL helper  // eventsTableTraceNameSql 等
       └─ clickhouse.ts queryClickhouse({query, params, preferredService:"EventsReadOnly"})
            → clickhouseClient.query()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `ClickhouseWriter.getInstance()` (`index.ts:71`) | 取单例 | 支持注入测试 client |
| `addToQueue(tableName, data)` (`index.ts:576`) | 入内存队列 | 满量 batchSize 触发异步 flush |
| `flush(tableName)` (`index.ts:364`) | 批量写入 + 重试 | 错误分级：retryable/size/string-length |
| `writeToClickhouse` (`index.ts:596`) | 实际 insert | JSONEachRow 格式 |
| `getTraceByIdFromEventsTable` (`events.ts`) | 从 events 表查 trace | 聚合多条 event，excludeInputOutput 可控 |
| `getTraceById` (`traces.ts`) | routing wrapper | 按 `V4_WRITE_MODE` 分派 legacy/events |
| `getObservationsV2FromEventsTableForPublicApi` (`events.ts`) | V2 API 查询 | field groups 选择性返回，CTE+JOIN split |
| `updateEvents` (`events.ts`) | 批量更新 | 双表并行 events_full + events_core |
| `eventsTableTraceNameSqlForAlias(alias)` (`eventsTable.ts`) | trace 名 SQL | COALESCE/nullIf + argMaxIf 回退 |
| `queryClickhouse<T>` (`clickhouse.ts`) | 查询封装 | preferredClickhouseService 标签路由 |

</details>

## 核心实现

### ClickhouseWriter 微批单例

`ClickhouseWriter` 是 worker 进程唯一的 ClickHouse 写入口，单例持有 8 个按表独立队列 + 定时器。`TableName` 枚举：

```typescript title="worker/src/services/ClickhouseWriter/index.ts:629"
export enum TableName {
  Traces = "traces",
  TracesNull = "traces_null",
  Scores = "scores",
  Observations = "observations",
  ObservationsBatchStaging = "observations_batch_staging",
  BlobStorageFileLog = "blob_storage_file_log",
  DatasetRunItems = "dataset_run_items_rmt",
  EventsFull = "events_full",  // v4 主写目标，MV 自动填充 events_core
}
```

双重触发：满量（`queue.length >= batchSize`，默认 1000）+ 定时（`setInterval(writeInterval)`，默认 1000ms）。`RecordInsertType<T>` 条件类型把每个 TableName 映射到对应插入记录类型。队列项带 `createdAt`（wait_time 指标）+ `attempts`。

### 错误分级重试

`flush`（L364-574）按错误类型分级处理：
- **可重试**（socket hang up / timeout）→ `backOff` 指数退避
- **String length error**（JS 字符串拼接溢出）→ **对半拆分**批次，重试前半，后半重新入队
- **Size error**（ClickHouse JSON 对象过大）→ **截断** input/output/metadata 后重试一次
- **不可重试 / 超过 maxAttempts（默认 3）**→ drop + `recordIncrement("rows_dropped")`，注释标记 TODO 用 Redis DLQ

### eventsTable SQL helper

`eventsTable.ts` 不是 ORM 也不是 query builder，而是**纯函数生成 SQL 片段**，被嵌入 query builder 的 select/where。核心 helper：

```typescript title="packages/shared/src/eventsTable.ts"
// 是否根 observation（trace 的入口 span）
eventsTableIsRootObservationSqlForAlias(alias)  // → `(${alias}.parent_span_id = '' OR ${alias}.is_app_root = true)`

// trace 名：优先 trace_name，空则回退到根 observation 的 name
eventsTableTraceNameSqlForAlias(alias)
// → COALESCE(nullIf(e.trace_name, ''), if(isRootObservation, nullIf(e.name, ''), NULL))

// 聚合版：多条 event 属同一 trace，按 event_ts 取最新非空
eventsTableTraceNameAggregationSqlForAlias(alias)
// → COALESCE(nullIf(argMaxIf(e.trace_name, e.event_ts, e.trace_name <> ''), ''),
//             nullIf(argMaxIf(e.name, e.event_ts, isRootObservation AND e.name <> ''), ''))
```

`eventsTableTraceNameSelectSqlForAlias` 用 `ifNull(..., '')` 保证非 null String 类型——匹配 `events_core.trace_name` 列类型，避免 ClickHouse 25.x 的 `AMBIGUOUS_COLUMN_NAME (code 352)` 错误（注释 LFE-14924）。`normalizeEventsTraceName` 在 JS 侧把 `''` 归一为 `null`。

`eventsTableColsDefinition` 数组定义 ~50 个 UI 列映射（id/traceId/startTime/name/type/environment/totalCost/inputTokens/latency/scores_avg/toolCalls…），每列 `internal` 指向 CH 列或 SQL 表达式。

### 仓储与路由 wrapper

`repositories/index.ts` 导出 30 个 repo 模块。`events.ts`（3672 行）是最大的，含查询/更新/删除/批量 I/O/filter option。关键模式是**路由 wrapper**：

```typescript title="packages/shared/src/server/repositories/traces.ts (概念)"
export const getTraceById = async (params) => {
  // 按 LANGFUSE_MIGRATION_V4_WRITE_MODE 分派
  if (mode === "events_only" || (mode === "dual" && eventsHasData)) {
    return getTraceByIdFromEventsTable(params);
  }
  return getTraceByIdFromTracesTable(params);  // legacy
};
```

`getTraceById` / `getObservationById` / `hasAnyTracingData` 等都是这类 wrapper，根据 `LANGFUSE_MIGRATION_V4_WRITE_MODE`（`legacy` / `dual` / `events_only`，默认 `events_only`）在 legacy 表和 events 表间分派。

### ObservationsBatchStaging 桥接表

`ObservationsBatchStaging` 是 v3→v4 迁移的桥接表。`dual` 写模式下，IngestionService 同时写 legacy `observations` 表和 staging 表（`IngestionService/index.ts:1017-1037`）。staging 表由 `handleEventPropagationJob`（`worker/src/features/eventPropagation/`）定时扫描 `system.parts` 分区，JOIN traces 后批量写入 `events_full`。

为什么 staging 单独一张：① 分区感知写入——`getPartitionAwareTimestamp` 锁定分区（超过 2 分钟的 createdAt 用当前时间），保证 partition 不再变化才被 propagation 处理；② 批量化——攒一批再 JOIN；③ 容错——TTL 自动清理 + Redis cursor 追踪进度，失败可重跑。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 微批写入 | `ClickhouseWriter` 按表队列 | ClickHouse 不耐高频小 insert（merge 成本），攒批降压力 |
| 单例 + 多表队列 | `getInstance` + 8 个独立队列 | 全进程共享一个 writer，多表并行 flush |
| SQL helper 函数式 | `eventsTable.ts` 纯函数 | 可组合、无状态、版本化，非 ORM |
| Repository pattern | 30 个 repo | 统一访问 ClickHouse + Postgres |
| 宽表统一 | `events_core` 替代三表 | 消除 JOIN、高基数切片、未知问题探索 |
| 路由 wrapper | `getTraceById` 按 V4_WRITE_MODE | 迁移期读路径在 legacy/events 间透明分派 |
| Recently-processed 去重 | `ingestionQueue.ts` Redis cache | 队列重试/分区重处理时短路重复消费 |
| Decimal64 clamp | `clampDecimal64Fields` L288 | JS double 无法精确表示 Decimal64(12) 边界，防 overflow |

## 模块间交互

被调用方（写入）：`worker/IngestionService`（`addToQueue` 各表）、`worker/ingestionQueue`（BlobStorageFileLog）、`worker/handleEventPropagation`（查 staging 分区）、`worker/handleExperimentBackfill`（EventsFull）、`worker shutdown`（`getInstance().shutdown()`）。

被调用方（读取）：web/public-api/worker 各处 repositories 查询。

依赖：`@clickhouse/client`（`clickhouseClient`）、Redis（seen cache `langfuse:ingestion:recently-processed:*`，TTL 5min）、Postgres/prisma（`hasTraces` flag 缓存、model pricing 查询）、env（batch size/interval/maxAttempts/V4 write mode）。

## 扩展方式

**新增一个 ClickHouse 列**（如 `agent_id`）：
1. `eventsTable.ts`：`eventsTableColsDefinition` 加列定义 `{name, id, type, internal:"e.agent_id", …}`
2. ClickHouse DDL：`events_core` + `events_full` 的 migration SQL `ALTER TABLE … ADD COLUMN`
3. `repositories/definitions.ts`：`EventRecordInsertType` 加字段
4. `IngestionService`：构造 event record 时填充
5. 如需查询：`events.ts` `EventsQueryBuilder` field set 加列

**新增一个查询 repo**：仿 `getEventsGroupedByTraceName`（`events.ts:2164`），调 `getSingleEventsFilterOptionColumn(projectId, filter, "agentId", opts)`——通用实现已就绪。如需 MCP 暴露，列 id 加到 `OBSERVATION_MCP_ALLOWED_EVENTS_TABLE_FILTER_COLUMN_IDS`（`events.ts:483`）。

**调整微批参数**：纯配置，改 env `LANGFUSE_INGESTION_CLICKHOUSE_WRITE_BATCH_SIZE` / `_WRITE_INTERVAL_MS` / `_MAX_ATTEMPTS`（`worker/src/env.ts:113-124`），无需改代码。

> v4 宽表统一是这一层的灵魂，背后的 Wide Events 原则和 `eventsTableTraceNameSql` 的 argMaxIf 机制单独展开：[events_core 宽表统一](./03-clickhouse-write-storage-events-core-unification)。
