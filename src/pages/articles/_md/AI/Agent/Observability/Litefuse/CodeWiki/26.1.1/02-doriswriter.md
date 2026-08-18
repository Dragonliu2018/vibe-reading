---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "DorisWriter"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "DorisWriter", "Apache Doris", "stream load", "批写入"]
description: "Litefuse DorisWriter：单例内存批缓冲写入器，按 batch/字节/interval 三触发走 Doris HTTP stream load，含重试退避与丢弃策略。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/00-overview)

---

## 模块定位

DorisWriter 是 Litefuse 相对 Langfuse/ClickHouse 的**核心差异点**。原 Langfuse 的 `ClickhouseWriter` 走 ClickHouse HTTP insert；Litefuse 把它替换为 `DorisWriter`，走 Doris 的 HTTP stream load（`PUT /api/{db}/{table}/_stream_load`，FE 307 重定向到 BE）。它是一个**单例内存批缓冲写入器**：按 Doris 表分队列缓冲记录，按 batch size / 字节上限 / 时间间隔三触发 flush，失败重试、耗尽丢弃。它解决的问题是"高吞吐事件写入 + 对 Doris 友好的批导入"——Doris stream load 对大 batch 更高效，而内存队列让 `addToQueue` 是同步 push，热路径无网络往返。

## 模块架构

DorisWriter 是 `worker/src/services/DorisWriter/index.ts` 的单例类，核心结构：按 `TableName` 分的内存数组队列 + 字节计数 Map + 两类计数器（add/flush per window）+ 两个定时器（flush interval / gauge interval）。它依赖 `@langfuse/shared` 的 `dorisClient()`（实际 DorisClient 单例，`server/doris/client.ts`）做最终 HTTP 调用。`IngestionService` 是它唯一的上游生产者。

## 调用链路

```
IngestionService.writeEventRecord(eventRecord)
  → DorisWriter.addToQueue(TableName, record)        (:257)
      ├─ push 到 queue[tableName]，Buffer.byteLength 估算字节累加 queueSizeBytes
      ├─ addCounters[tableName]++
      └─ 触发判定: length>=batchSize (:282) 或 bytes>=maxQueueSizeBytes (:292) → 立即 flush
  [或] setInterval(writeInterval) (:89) → flushAll (:143)
  → flushAll: Promise.all 并发 flush 全部 6 张表     (instrumentAsync OTel 插桩)
  → flush(tableName) (:165)
      ├─ splice(0, batchSize) 取出批，扣 queueSizeBytes，记 wait_time histogram
      ├─ writeToDoris({table, records}) (:303)
      │   ├─ formatDataForDoris(records, table)        (shared)
      │   └─ (DorisWriter.client ?? dorisClient()).insert(table, records, {format:"json", strip_outer_array:true, read_json_by_line:false, timeout:600})
      │       └─ dorisClient.insert (client.ts:698): 重试循环 maxRetries 次，退避 retryDelay*2^(attempt-1) 上限 maxRetryDelay=60s → streamLoad (:505) PUT /_stream_load
      ├─ 成功: flushCounters++, recordGauge(queue length)
      └─ 失败: attempts<maxAttempts → 重新入队+attempts+1; 否则丢弃 + recordIncrement("...error")  (TODO: Redis DLQ)
```

数据类型：`addToQueue` 接 `RecordInsertType<T>`（条件类型按 `TableName` 映射到 `TraceRecordInsertType`/`ScoreRecordInsertType`/`EventRecordInsertType` 等），内部包成 `DorisWriterQueueItem<T>`（`createdAt`/`attempts`/`data`/`estimatedSizeBytes`）。

## 核心实现

### DorisWriter 单例与队列结构

```ts title="worker/src/services/DorisWriter/index.ts:23"
export class DorisWriter {
  private static instance: DorisWriter | null = null;
  batchSize: number;            // LITEFUSE_INGESTION_DORIS_WRITE_BATCH_SIZE
  maxQueueSizeBytes: number;     // LITEFUSE_INGESTION_DORIS_MAX_QUEUE_SIZE_BYTES
  writeInterval: number;         // LITEFUSE_INGESTION_DORIS_WRITE_INTERVAL_MS
  gaugeInterval: number;         // LITEFUSE_INGESTION_DORIS_GAUGE_INTERVAL_MS
  maxAttempts: number;           // LITEFUSE_INGESTION_DORIS_MAX_ATTEMPTS
  queue: DorisQueue;             // 按 TableName 分队
  queueSizeBytes: Map<TableName, number>;
  private addCounters = new Map<TableName, number>();
  private flushCounters = new Map<TableName, number>();
}

export enum TableName {                       // :337
  Traces = "traces",
  Scores = "scores",
  Observations = "observation_source",
  BlobStorageFileLog = "blob_storage_file_log",
  DatasetRunItems = "dataset_run_items_rmt",
  EventsFull = "events_full",
}
```

`getInstance(dorisClient?)`（`:72`）惰性构造，可注入 client 供测试。注意 Doris 表名与 ClickHouse 不同：observations 实际表名是 `observation_source`，dataset_run_items 是 `dataset_run_items_rmt`（rmt = 原 ReplaceMergeTree 命名残留），events_full 是统一宽表。

### 三触发 flush 与 gauge 监控

flush 由三个条件触发（`addToQueue` 内两个 + `start()` 定时一个）：batch size 达到（`:282`）、队列字节达 max（`:292`）、writeInterval 定时（`:89`）。定时 flush 用 `isIntervalFlushInProgress` 守卫防重叠。gauge 定时器（`:111`）每 `gaugeInterval` 遍历所有表输出 `q=<depth> +<added> -<flushed>` 日志并重置计数器，但**跳过静默表**（`len===0 && added===0 && flushed===0` 时 `continue`，`:118`），避免空闲系统每 tick 输出 6 行零。

### stream load 与重试退避

`writeToDoris`（`:303`）先 `formatDataForDoris` 再 `insert`。`dorisClient().insert`（`client.ts:698`）循环 `maxRetries` 次，每次调 `streamLoad`（`:505`，PUT `_stream_load`），失败退避 `retryDelay * 2^(attempt-1)`，**上限 `maxRetryDelay` 默认 60s**（`client.ts:58 DEFAULT_STREAM_LOAD_MAX_RETRY_DELAY_MS = 60_000`，commit `64cc561` "fix(doris): cap stream load retry backoff at 1 minute"）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例 | `DorisWriter.getInstance`（`:72`）、`DorisClientManager.getInstance` | 全局唯一写入器，控制 stream load 连接 |
| 缓冲/批写 | 内存数组 + splice 批量取 + 三触发 | 对齐 Doris stream load 大 batch 优化，降低 HTTP 往返 |
| Promise.all 并发 | `flushAll` 对 6 张表并行（`:151`） | 各表独立 flush 无依赖，并发提升吞吐 |
| OTel 插桩 | `flushAll` 包 `instrumentAsync({name:"write-to-doris"})`（`:144`） + `DorisClient` 注册 `otelInjectInterceptor` 注入 trace header | 自身可观测 |
| Gauge 监控窗口 | add/flush 计数器 + 定时重置 | 观察队列深度与速率，跳过静默表降噪 |

## 模块间交互

- **被 IngestionService 调用**：`IngestionService/index.ts:484` `this.dorisWriter.addToQueue(TableName.EventsFull, eventRecord)`；`:592` DatasetRunItems、`:699` Scores、`:782`/`:994` Traces。IngestionService 是唯一上游生产者。
- **依赖 @langfuse/shared**：`dorisClient`/`DorisClientType`/`formatDataForDoris`/6 个 `RecordInsertType` 类型、`logger`、`instrumentAsync`/`recordGauge`/`recordHistogram`/`recordIncrement`。
- **DLQ 关系**：DorisWriter **未接入** Redis DLQ——flush 失败超 `maxAttempts` 直接丢弃（`:246` TODO）。`DeadLetterRetryQueue`（`dlqRetryQueue.ts`）服务的 `DlqRetryService` 重试的是 `ProjectDelete`/`TraceDelete`/`BatchActionQueue` 等业务队列的 failed jobs，与 DorisWriter 内存丢写是两套独立路径。TODO 意在将丢弃路径接入 `DeadLetterRetryQueue`。

## 扩展方式

新增一张 Doris 表的写入：① `DorisWriter/index.ts` `TableName` 枚举加值（`:337`）；② `queue` 初始化加键（`:54`）；③ `flushAll` 的 `Promise.all` 加一行 `this.flush(TableName.NewTable, fullQueue)`（`:151`）；④ `RecordInsertType<T>` 条件类型加分支（`:346`）；⑤ `client.ts` 的 `DATE_FIELD_MAPPINGS` 如需 date 字段则加映射（`:872`）；⑥ `IngestionService` 在对应逻辑调 `this.dorisWriter.addToQueue(TableName.NewTable, record)`。改 batch size 等仅改 env（`workerEnv.LITEFUSE_INGESTION_DORIS_WRITE_BATCH_SIZE` 等），无需改代码。对应测试：`worker/src/services/DorisWriter/DorisWriter.unit.test.ts` + `DorisWriter.integration.test.ts`。
