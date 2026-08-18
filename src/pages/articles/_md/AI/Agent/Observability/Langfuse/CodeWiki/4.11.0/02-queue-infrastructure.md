---
source:
  type: "源码解读"
  project: "Langfuse"
  url: "https://github.com/langfuse/langfuse"
title: "队列基础设施"
date: "2026-08-18T16:35:50+08:00"
category: ["AI", "Agent", "Observability", "Langfuse", CodeWiki, "4.11.0"]
tags: ["Langfuse", "BullMQ", "Redis", "Sharding", "DLQ"]
description: "Langfuse 队列层：BullMQ 分片 by projectId-eventBodyId、二级队列分流、DLQ 重试、失败追踪。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Langfuse/CodeWiki/4.11.0/00-overview)

---

## 模块定位

队列层是 web 进程和 worker 进程之间的**唯一耦合点**——web 把重活甩进来，worker 从里面取。它的职责边界是：承载所有异步任务契约（queue name + payload schema）、分片策略、失败重试与死信、降级分流。它不属于任何单一业务，而是被摄入、eval、批量导出、监控、in-app agent 等所有异步流程复用的横向基础设施。

关键不变量：所有 queue payload schema 和 queue-name 常量由 `packages/shared/src/server/queues.ts` 统一拥有——两个进程对"队列叫什么、payload 长什么样"的理解由这一个文件锚定。

## 模块架构

```
packages/shared/src/server/
├── queues.ts                # QueueName 枚举 + payload zod schema（契约所有者）
├── redis/
│   ├── redis.ts             # BullMQ 连接 + createBullMQQueueOptionsWithRedis
│   ├── ingestionQueue.ts    # 分片 Queue producer（IngestionQueue class）
│   ├── otelIngestionQueue.ts
│   ├── sharding.ts          # getShardIndex (SHA256)
│   ├── s3SlowdownTracking.ts   # S3 SlowDown 项目标记
│   ├── ingestionFailureTracking.ts
│   ├── dlqRetryQueue.ts     # 死信重试
│   ├── getQueue.ts         # Queue 获取抽象
│   └── …（43 个队列文件）
```

Producer 端（web 进程）用 `Queue` 类（`bullmq`）入队；Consumer 端（worker 进程）用 `Worker` 类 + `WorkerManager` 注册（见 [04-后台作业处理](./04-worker-job-processing)）。这一层只描述 producer 契约和分片/失败策略，processor 实现在 worker。

## 调用链路

```
processEventBatch (ingestion)
  └─ IngestionQueue.getInstance({ shardingKey: `${projectId}-${eventBodyId}` })  // redis/ingestionQueue.ts
       ├─ getShardIndex(shardingKey, LANGFUSE_INGESTION_QUEUE_SHARD_COUNT)  // sharding.ts: SHA256 % N
       ├─ 缓存实例到 static instances Map<shardIndex, Queue>
       └─ queue.add(QueueJobs.IngestionJob, jobData, { delay: getDelay(...), ...defaultJobOptions })
            defaultJobOptions: removeOnComplete:true, removeOnFail:100_000, attempts:6, backoff:{type:"exponential",delay:5000}

worker 侧（见 04 模块）:
  WorkerManager.register(shardName, processor, {concurrency})
    → BullMQ Worker 消费 → ingestionQueueProcessorBuilder(true)
       ├─ 二级队列重定向检查（S3 SlowDown / 配置大客户）
       │     → SecondaryIngestionQueue.getInstance().add(...)  // 重定向到二级队列
       └─ 处理（不重定向则消费）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `IngestionQueue.getInstance({shardingKey, shardName})` (`redis/ingestionQueue.ts`) | 取分片 Queue 实例 | SHA256 hash % shardCount；shardingKey=`projectId-eventBodyId` |
| `IngestionQueue.getShardNames()` | 列所有分片名 | `["ingestion-queue", "ingestion-queue-1", …]` |
| `getShardIndex(key, shardCount)` (`redis/sharding.ts`) | 一致性哈希分片 | SHA256 前 8 hex % shardCount |
| `markProjectS3Slowdown(projectId)` (`s3SlowdownTracking.ts`) | 标记项目走二级队列 | Redis flag，worker 消费时检查 |
| `markProjectIngestFailure(projectId, {reason})` (`ingestionFailureTracking.ts`) | 记录摄入失败 | 故障追踪 + UI 可见性 |
| `hasS3SlowdownFlag(projectId)` | 查 SlowDown 标记 | worker 重定向决策依据 |
| `DlqRetryService.retryDeadLetterQueue` (`worker/src/services/dlq/`) | 死信重试消费者 | 并发度=1，独立 runner |

</details>

## 核心实现

### 队列契约（queues.ts）

`QueueName` 枚举列出所有队列名（IngestionQueue / SecondaryIngestionQueue / OtelIngestionQueue / TraceUpsertQueue / EvalExecutionQueue / LLMAsJudgeExecutionQueue / CodeEvalExecutionQueue / BatchExportQueue / MonitorQueue / InAppAgentRunQueue / BlobStorageIntegrationQueue / DataRetentionQueue / …）。每个队列的 payload 用 zod schema 定义，如：

```typescript title="packages/shared/src/server/queues.ts"
export const IngestionEvent = z.object({
  data: z.object({
    type: z.enum(Object.values(eventTypes)),
    eventBodyId: z.string(),
    fileKey: z.string().optional(),       // S3 文件指针
    skipS3List: z.boolean().optional(),
    forwardToEventsTable: z.boolean().optional(),
    ingestionApiKey: z.string().optional(),
    ingestionSdkName: z.string().optional(),
    ingestionSdkVersion: z.string().optional(),
    bucketPrefix: z.string().optional(),  // producer 传给 consumer 的 S3 前缀
  }),
  authCheck: z.object({ validKey: z.literal(true), scope: z.object({ projectId: z.string() }) }),
});
```

`authCheck` 在 web 端 pre-validated 后随 payload 入队——worker 信任这个 scope 不重做鉴权（hot path 优化）。`TQueueJobTypes` 把每个 QueueName 映射到它的 job 类型，BullMQ Worker 拿到的是已校验类型。

### 分片（sharding）

`getShardIndex`（`redis/sharding.ts`）用 SHA-256 一致性哈希把 `shardingKey` 映射到 `[0, shardCount)`：

```typescript title="packages/shared/src/server/redis/sharding.ts"
export function getShardIndex(key: string, shardCount: number): number {
  if (shardCount <= 1) return 0;
  const hash = createHash("sha256").update(key).digest("hex");
  const hashInt = parseInt(hash.substring(0, 8), 16);
  return hashInt % shardCount;
}
```

分片数由 `LANGFUSE_INGESTION_QUEUE_SHARD_COUNT` 控制。`IngestionQueue` 为每个 shard 维护独立 `Queue` 实例（static `instances` Map 缓存），shard 名形如 `ingestion-queue` / `ingestion-queue-1`。

### 二级队列与降级

当 S3 返回 SlowDown 或某项目是配置的大客户（`LANGFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS`），worker 把 job 从主队列重定向到 `SecondaryIngestionQueue`（低并发、独立消费）：

- web 端 `processEventBatch` 检测 SlowDown → `markProjectS3Slowdown(projectId)` 设 Redis flag
- worker `ingestionQueueProcessorBuilder(true)` 消费时检查 `hasS3SlowdownFlag(projectId)` 或 env 配置 → 重定向到 secondary，不在当前 queue 处理
- secondary 的 processor 用 `ingestionQueueProcessorBuilder(false)`（不再重定向，直接处理），并发度独立配置

> **细节差异**（待核实项已标注）：非 OTel 的 ingestion consumer 重定向检查 `hasS3SlowdownFlag` + env 配置两者；而 OTel ingestion consumer 的 secondary 重定向**只检查 env 配置的项目列表**，不检查 SlowDown flag。这是一个不对称点，阅读 `otelIngestionQueue.ts` 时留意。

### DLQ 与重试

BullMQ 内置重试是第一层：`defaultJobOptions` 设 `attempts: 6` + `backoff: {type: "exponential", delay: 5000}`，耗尽后进 failed set（`removeOnFail: 100_000` 保留上限）。

`DeadLetterRetryQueue` 是独立的最终重试机制，由 `DlqRetryService.retryDeadLetterQueue` 消费（并发度=1）。但要注意覆盖范围：

> **重要**：DLQ 重试服务**仅覆盖 5 个管理类队列**（`ProjectDelete` / `TraceDelete` / `ScoreDelete` / `BatchActionQueue` / `DataRetentionProcessingQueue`）。**摄入队列（IngestionQueue）没有 DLQ consumer**——它完全依赖 BullMQ 内置的 `attempts: 6` + 指数退避，耗尽后留在 failed set（100K 条上限）但不会被 DLQ 拉回。`ClickhouseWriter` 内部 drop 的记录目前只计指标（`langfuse.queue.clickhouse_writer.rows_dropped`），代码注释标记 TODO 计划用 Redis DLQ。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 契约集中所有 | `queues.ts` 统一拥有 QueueName + schema | 两进程对契约的理解由一文件锚定 |
| 一致性哈希分片 | `sharding.ts` SHA256 by `projectId-eventBodyId` | 同实体事件落同一 shard 串行消费，避免并发更新冲突 |
| Pre-validated auth 入队 | `IngestionEvent.authCheck` | worker 不重做鉴权，hot path 快 |
| 二级队列分流 | `SecondaryIngestionQueue` | S3 SlowDown / 大客户不冲击主队列，保护系统 |
| 双层重试 | BullMQ attempts:6 + DLQ | 普通重试与死信分离，DLQ 只覆盖关键管理队列 |
| 失败追踪 | `ingestionFailureTracking` | 项目级摄入故障可见，UI/运维可定位 |
| Producer/consumer 不变量 | `bucketPrefix` 随 payload | env 漂移也不找错 S3 key |

## 模块间交互

被调用方：`ingestion`（入队）、`worker/queues/*`（消费 + 重定向）、`public-api`（部分管理操作入队如 batchAction）。依赖 `bullmq`、`redis/redis`（连接）、`env`（分片数/并发/二级队列配置）。

与 [01-摄入管线](./01-ingestion-pipeline) 的分工：摄入管线管"事件怎么校验、S3 怎么卸载、payload 怎么构造"；队列层管"入哪个 shard、失败怎么重试、降级怎么分流"。两者通过 `IngestionQueue.getInstance({shardingKey}).add` 这个调用点衔接。

## 扩展方式

**新增一个队列**：
1. `queues.ts`：加 `QueueName` 枚举 + payload zod schema（`TQueueJobTypes` 类型扩展）
2. `redis/`：加 Queue 类（仿 `ingestionQueue.ts`，实现 `getShardNames()` + `getInstance({shardingKey/shardName})`）
3. worker：加 processor + 在 `app.ts` 用 `WorkerManager.register` 注册（分片队列还要在 `shardedQueueRegistry.ts` 注册，让 `WorkerManager.resolveMetricInfo` 归一 metric 名）

**修改分片键**：改 `processEventBatch` 调 `getInstance({shardingKey})` 传入的 key。注意：改分片键会改变事件落哪个 shard，影响同实体串行保证——只在确认新键仍能保序时改。
