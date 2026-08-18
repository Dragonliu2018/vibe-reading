---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "队列基础设施"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "BullMQ", "Redis", "队列", "分片"]
description: "Litefuse 队列基础设施：28 个 BullMQ 队列契约、ingestion/otel 分片、WorkerManager 注册、主备队列与 DeadLetterRetryQueue。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/00-overview)

---

## 模块定位

队列层是 web 与 worker 之间的**解耦总线**。web 进程只把事件写 S3 + 入 Redis 队列就返回；worker 进程消费队列做重活。它独立成模块，是因为 28 个队列的命名契约、分片策略、重试退避、限流参数、死信队列都集中在 `packages/shared/src/server`，且 web 与 worker 共享同一套类型契约（`TQueueJobTypes`），保证两端不漂移。

## 模块架构

队列定义分两类入口：非分片队列走 `getQueue(name)` 工厂（`redis/getQueue.ts`）；分片队列（IngestionQueue / OtelIngestionQueue / TraceUpsertQueue）用各自的 `getInstance({shardingKey})` 静态工厂，内部用 `Map<number, Queue>` 存多实例。所有队列类的契约集中在 `queues.ts`（`QueueName` 枚举 + `TQueueJobTypes` + Zod payload schema）。worker 侧用 `WorkerManager.register(name, processor, opts)` 统一注册 BullMQ Worker，`metricWrapper` 注入可观测性。`DeadLetterRetryQueue` 用 cron 轮询失败 job 重投。

## 调用链路

```
web 入队: getQueue(QueueName.X).add(QueueJobs.X, payload)
  [分片队列不走 getQueue] IngestionQueue.getInstance({shardingKey}).add(...)  (shardingKey=projectId-eventBodyId)
  → BullMQ 序列化写 Redis
worker 消费: WorkerManager.register(queueName, processor, {concurrency,lockDuration,stalledInterval,maxStalledCount,limiter})  (workerManager.ts:96)
  → 创建独立 Redis 连接 → new Worker(queueName, metricWrapper(processor), {connection, prefix, ...options})
  → 存入 workers[queueName]   (重复 register 同名幂等跳过)
分片注册: 遍历 IngestionQueue.getShardNames() 对每个 shardName 调 WorkerManager.register  (ingestionQueue.ts:18)
DLQ: BullMQ job 重试耗尽 → failed → DeadLetterRetryQueue 每 10min cron (0 */10 * * * *) → DlqRetryService 扫描重投  (dlqRetryQueue.ts:46)
```

## 核心实现

### 队列契约（QueueName + TQueueJobTypes）

```ts title="packages/shared/src/server/queues.ts"
export enum QueueName { ... }     // :319  28 个队列名 (kebab-case)
export type TQueueJobTypes = {    // :380  映射到 {timestamp,id,payload,name,retryBaggage?}
  [QueueName.IngestionQueue]: { payload: IngestionEvent; ... };
  [QueueName.OtelIngestionQueue]: { payload: OtelIngestionEvent; ... };
  [QueueName.EvaluationExecution]: { payload: ...; retryBaggage?: {originalJobTimestamp, attempt} };
  ...
}
```

payload 全部用 Zod schema 定义，构成 web↔worker 类型契约。带 `retryBaggage` 的队列（EvalExecution/DatasetRunItemUpsert/ExperimentCreate/LLMAsJudge）携带 `originalJobTimestamp + attempt` 用于重试追踪。

### Redis 配置与重试装饰器

```ts title="packages/shared/src/server/redis/redis.ts"
export const redisQueueRetryOptions = {  // :15  统一重试装饰器
  retryStrategy: 指数退避 1s~20s 永久重试,
  reconnectOnError: 处理 READONLY 自动重连、忽略 MOVED/ASK 集群重定向,
}
export function getQueuePrefix(name) { return `{prefix:queueName}` }  // :235 集群 hash tag 保证同队列同 slot
```

集群模式下用 hash tag `{prefix:queueName}` 保证同队列所有 key 落同一 slot（便于原子操作）；单机返回 prefix 或 undefined。全局 `redis` 用 `globalThis.redis` 保证 dev HMR 不重连（`:326`）。

### WorkerManager 与 metricWrapper

```ts title="worker/src/queues/workerManager.ts:19"
export class WorkerManager {
  static workers: Record<string, Worker>;
  static register(name, processor, additionalOptions)  // :96  创建 Worker + metricWrapper 包装
  static closeWorkers() / getWorker()
}
// metricWrapper (:22): 包裹 processor，记录 request/wait_time/processing_time 直方图 + length/dlq_length gauge
```

### 分片与 DLQ

`getShardIndex`（`sharding.ts:9`）SHA-256 hash → `% shardCount`。`IngestionQueue.getInstance` 用 `shardingKey`（projectId-eventBodyId）做一致性哈希；`OtelIngestionQueue` 无 shardingKey 时随机 shard（`otelIngestionQueue.ts:54`）。`DeadLetterRetryQueue`（`dlqRetryQueue.ts:10`）单例，`defaultJobOptions: {attempts:5, exponential backoff 5s, removeOnFail:100}`，getInstance 时自动注册每 10 分钟 cron。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂 | `getQueue`（`getQueue.ts:33`）switch + exhaustive check | 集中路由 24 个非分片队列 |
| 单例 | 各 `Queue.getInstance`、`DeadLetterRetryQueue` | 队列句柄全局唯一 |
| 分片 | `getShardIndex`（`sharding.ts:9`）SHA-256 → `% shardCount` | 高吞吐队列横向扩展 |
| 装饰器 | `redisQueueRetryOptions`、`WorkerManager.metricWrapper` | 横切重试与可观测性 |
| 策略 | 各队列 `defaultJobOptions` 差异化、`register` 的 concurrency/limiter | 按队列特征定制并发与限流 |

## 模块间交互

- **契约共享**：web 和 worker 共用 `@langfuse/shared/src/server` 导出的 `queues.ts`，保证两端类型一致。
- **依赖**：`redis.ts` 依赖 `env`（REDIS_CLUSTER_ENABLED/REDIS_KEY_PREFIX/TLS）；`ingestionQueue.ts` 依赖 `LITEFUSE_INGESTION_QUEUE_SHARD_COUNT`。
- **被注册**：worker `app.ts` 批量 `WorkerManager.register`；web 通过 `getQueue` 按需获取。

## 扩展方式

新增一个队列：① `queues.ts` `QueueName` 枚举（`:319`）+ `QueueJobs`（`:378`）+ `TQueueJobTypes`（`:529`）加映射 + Zod payload；② 新建 `packages/shared/src/server/redis/xxxQueue.ts`（仿 `dlqRetryQueue.ts`）；③ `getQueue.ts` switch 加 case；④ `worker/src/app.ts` 或 `worker/src/queues/` 调 `WorkerManager.register`；⑤ web 调用处 `getQueue(QueueName.X)?.add(...)`。调整 ingestion 分片数：改 env `LITEFUSE_INGESTION_QUEUE_SHARD_COUNT`（`ingestionQueue.ts:21`），无需改代码，但需重启 worker 注册新 shard。对应测试：`worker/src/queues/__tests__/`。
