---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "Doris 查询与表层"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "Apache Doris", "queryDoris", "stream load", "events_full"]
description: "Litefuse Doris 查询与表层：DorisClient（mysql2 pool + stream load）、queryDoris 多租户过滤、events_full 宽表统一、声明式表定义与迁移 DDL。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/00-overview)

---

## 模块定位

这一层封装了 Litefuse 对 Doris 的全部访问——查询、命令、流式读、stream load 写入，以及表结构定义与迁移。它是读路径的终点、写路径的终点之一，也是 Litefuse Doris 身份最集中的模块：Doris 的 UNIQUE KEY + merge-on-write 模型、AUTO PARTITION、HASH(project_id) 分桶、倒排索引，以及 `events_full` 宽表统一，都体现在这里。它独立成模块，是因为 Doris 的查询协议（MySQL 兼容但与 ClickHouse 不同）、多租户过滤强制注入、宽表 SQL 编译都有专门逻辑，且 web/worker 共享。

## 模块架构

Doris 客户端 `DorisClient`（`packages/shared/src/server/doris/client.ts`）双通道：MySQL 协议（`mysql2/promise` 连接池，用于查询）+ HTTP stream load（`axios`，用于批量写入）。其上是 `repositories/doris.ts` 的薄封装函数 `queryDoris`/`commandDoris`/`queryDorisStream`/`upsertDoris`/`partialUpdateDoris`，参数经 `DorisParameterProcessor`（`parameterProcessor.ts`）绑定。查询过滤由 `queries/doris-sql/factory.ts` 的 `createDorisFilterFromFilterState` + `getDorisProjectIdDefaultFilter` 构建。表结构声明在 `tableDefinitions/`，迁移 DDL 在 `doris/migrations/`。

## 调用链路

```
普通查询: UI/tRPC → repository(如 getTracesByIds)
  → createDorisFilterFromFilterState + getDorisProjectIdDefaultFilter  (factory.ts:31/165)
  → queryDoris({query, params, tags})           (repositories/doris.ts:119)
  → DorisParameterProcessor.processQuery       (parameterProcessor.ts:14, 绑参)
  → dorisClient().queryWithParams              (client.ts:390)
  → DorisClient.query: escapeValue 手动替换 ? → connectionPool.query   (client.ts:280)
  → Doris

流式导出: getDatabaseReadStreamPaginated      (database-read-stream/getDatabaseReadStream.ts:102)
  → 按 tableName switch → getEventsStream      (event-stream.ts:114, 拼 raw SQL {projectId:String} 占位)
  → queryDorisStream                          (doris.ts:206)
  → dorisClient().queryStream                 (client.ts:428) → mysql2 conn.query(sql).stream() 逐行 yield

写入: DorisWriter → dorisClient().insert       (client.ts:698) → streamLoad (:505) PUT /_stream_load
```

## 核心实现

### DorisClient 双通道客户端

```ts title="packages/shared/src/server/doris/client.ts:57"
export class DorisClient {
  private connectionPool: mysql.Pool | null;        // mysql2/promise 查询池
  private streamLoadClient: AxiosInstance;          // HTTP stream load
  async query(sql, params, options): Promise<any[]>            // :280
  async queryWithParams({query, query_params}): Promise<any>     // :390
  async *queryStream<T>(sql, options): AsyncGenerator<T>        // :428
  async streamLoad(table, data, options): Promise<void>         // :505
  async insert(table, data, options): Promise<void>              // :698 带指数退避重试
}
export const dorisClient = (config?) => DorisClientManager.getInstance().getClient(config)  // :855 单例工厂
```

### queryDoris 与多租户强制过滤

```ts title="packages/shared/src/server/repositories/doris.ts"
export async function queryDoris<T>(opts: {query, params?, tags?}): Promise<T[]>        // :119
export async function commandDoris(opts: {query, params?, tags?}): Promise<void>       // :162
export async function* queryDorisStream<T>(opts): AsyncGenerator<T>                     // :206
export function parseDorisUTCDateTimeFormat(dateString): Date                            // :241
export async function upsertDoris(opts: {table, records, ...}): Promise<void>           // :13 stream load upsert
```

`getDorisProjectIdDefaultFilter`（`queries/doris-sql/factory.ts:165`）返回 traces/scores/observations 三套 `project_id = projectId` 的 `FilterList`，调用方必须并入。这是**租户隔离的硬约束**——所有 project-scoped 查询必须带 project_id 过滤，既防数据泄漏又命中分区裁剪与倒排索引。

### events_full 宽表统一与表引擎

events_full（migration `0037_create_events_full`）是统一事件宽表，每行一个 OTel "span"（synthetic trace span 用 `span_id='t-'||trace_id`），trace 字段冗余在每行，导出与分析免 JOIN。Doris 表引擎选择与 ClickHouse 截然不同：

```sql title="packages/shared/doris/migrations/0001_traces.up.sql"
CREATE TABLE if not exists traces (
    `project_id` varchar(64) not null,
    `timestamp_date` Date not null,
    `id` varchar(64) not null,
    `timestamp` DateTime(3) not null,
    `metadata`  Map<String, String>,
    `input` Variant,
    `tags` ARRAY<String>,
    INDEX idx_id (`id`) USING INVERTED,
    INDEX idx_project (`project_id`) USING INVERTED,
    INDEX idx_tags (`tags`) USING INVERTED
 ) ENGINE=OLAP
UNIQUE KEY(project_id, timestamp_date, id)
AUTO PARTITION BY RANGE (date_trunc(`timestamp_date`, 'month')) ()
DISTRIBUTED BY HASH(project_id) BUCKETS 8
PROPERTIES ("replication_allocation" = "tag.location.default: 1");
```

要点：`ENGINE=OLAP` + `UNIQUE KEY` + merge-on-write（MoW，`enable_unique_key_merge_on_write=true`）替代 ClickHouse 的 `ReplacingMergeTree`；`AUTO PARTITION`（traces/observations 按月、events_full 按天）；`DISTRIBUTED BY HASH(project_id)` 与 project_id 强制过滤配合命中分桶；`INVERTED` 倒排索引覆盖 id/project_id/user_id/session_id/tags。

### buildTraceAggregationQuery 双 CTE

由于 Doris 的 `MAX_BY` 不支持 Array/Variant 类型（ClickHouse 有 `argMaxIf`），`buildTraceAggregationQuery`（`repositories/traces.ts:57`）拆成两个 CTE：`trace_scalars`（用 `MAX_BY(IF(cond,val,NULL),event_ts)` 聚合标量）+ `trace_root`（用 `ROW_NUMBER()` 取 root span 的 array/Variant 列），再 JOIN。这是 Doris 与 ClickHouse 查询表达差异的典型妥协。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 参数化查询防注入 | `DorisParameterProcessor.processQuery`（`parameterProcessor.ts:14`），ClickHouse 风格 `{param: Type}` | 防 SQL 注入；未用 prepared statements——mysql2 与 Doris 协议有 "offset out of range" bug，故 `DorisClient.escapeValue` 手动转义（`client.ts:297`） |
| 多租户强制注入 | `getDorisProjectIdDefaultFilter`（`factory.ts:165`） | 调用方必须并入 project_id 过滤，租户隔离 + 分区命中 |
| AOP 计时 | `measureAndReturn`（`measureAndReturn.ts:25`，A/B canary 设计）+ `instrumentAsync` OTel span | 查询计时与链路追踪 |
| 声明式表结构 | `ColumnDefinition[]`（`tableDefinitions/types.ts`）+ `UiColumnMappings`（`factory.ts`） | UI 列名→Doris `table.field` 映射统一 |
| 虚拟表 | `scores_numeric`/`scores_categorical`（`schema.ts`） | 查询 CTE 物化，非物理表 |
| Stream Load 307 手动重定向 | `streamLoadPut`（`client.ts:559`） | Doris FE 永远 307 到 BE，需手动处理 |

## 模块间交互

被 web tRPC routers（经 repositories）、worker（batchExport/database-read-stream/experiments/cleaner/blob-storage）、repositories（traces/scores/observations/dataset-items/dashboards/events）调用。依赖 `mysql2/promise`、`axios`、`env`、`@opentelemetry/api`。与 Prisma 分工：Doris 存分析事件，Prisma 存元数据（users/datasets/sessions/bookmarks/audit_logs）。`getDatabaseReadStream` 内同时调 Doris（数据）与 `prisma.*findMany`（用户名/数据集名/session 状态）（`getDatabaseReadStream.ts:150/212/472`）。

## 扩展方式

新增 Doris 查询接口：在 `packages/shared/src/server/repositories/<entity>.ts` 加函数调 `queryDoris`；如需新过滤类型，在 `interfaces/filters.ts` 的 `filterOperators` 加算子 + `doris-sql/doris-filter.ts` 加 Filter 类 + `factory.ts:createDorisFilterFromFilterState` switch 加 case。加一张分析表：在 `doris/migrations/00XX_*.up.sql` 写 DDL（UNIQUE KEY + AUTO PARTITION + HASH(project_id) + 倒排索引）；`schema.ts:DorisTableNames` 加名；`tableDefinitions/` 加 ColumnDefinition；`doris.ts` 加 `upsertDorisX` 并在 `formatDataForDoris` 的 `DATE_FIELD_MAPPINGS`（`client.ts:872`）注册日期字段。对应测试：`packages/shared/src/server/repositories/__tests__/` + `doris/__tests__/`。
