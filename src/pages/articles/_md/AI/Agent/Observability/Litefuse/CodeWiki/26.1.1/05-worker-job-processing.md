---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "Worker 作业处理"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "BullMQ", "LLM-as-judge", "批导出", "清理器"]
description: "Litefuse Worker 作业处理：评估（creator/executor 两阶段 LLM-as-judge）、批导出、批操作、事件传播与实验回填、PeriodicExclusiveRunner 定时清理。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/00-overview)

---

## 模块定位

worker 进程除了摄入管线（01）与 DorisWriter（02），还有一大类后台作业：评估执行、批导出、批操作、删除、事件传播与实验回填、定时清理。它们都由 `worker/src/app.ts` 用 `WorkerManager.register` 接到对应 BullMQ 队列上，各自有独立的并发/限流/锁策略。这个模块独立，是因为这些作业是"重活"——调 LLM、流式读全表、定时 DELETE——必须与热路径隔离并精心控并发，否则会压垮 Doris 或 LLM Provider。

## 模块架构

作业分四类：(1) **评估**——`evalService.ts` + `evalQueue.ts`，creator/executor 两阶段，LLM-as-judge；(2) **批导出/批操作**——`handleBatchExportJob` / `handleBatchActionJob`，concurrency=1 + limiter；(3) **删除与清理**——`*Delete` processor 做软删，`PeriodicExclusiveRunner` 子类做定时物理删除；(4) **实验回填**——`handleExperimentBackfill`。所有 cleaner 继承 `PeriodicExclusiveRunner`（独占锁定时器基类）。

## 调用链路

```
评估(trace级): scheduleObservationEvals → evalJobTraceCreatorQueueProcessor (evalQueue.ts:24)
  → createEvalJobs (evalService.ts:173, 查 job_configurations + filter + dedupe + sample → 写 jobExecution PG → EvalExecutionQueue.add 带 delay)
  → evalJobExecutorQueueProcessorBuilder (evalQueue.ts:121, primary 可重定向到 secondary)
  → evaluate (evalService.ts:1011) → executeLLMAsJudgeEvaluation (:718, 编译 prompt → deps.callLLM → validateEvalOutputResult → S3 + ingestion 写 score)

评估(observation级): OTel 摄入 scheduleObservationEvals → LLMAsJudgeExecutionQueue → llmAsJudgeExecutionQueueProcessor (evalQueue.ts:271) → processObservationEval → 共享 executeLLMAsJudgeEvaluation

删除: traceDelete/scoreDelete/projectDelete processor (app.ts:147) 同步软删; handleBatchActionJob trace-delete 分支 (handleBatchActionJob.ts:65) → Cleaner 异步清理
  → PeriodicExclusiveRunner.start → 定时 execute() → withLock → commandDoris(DELETE...) (batch-data-retention-cleaner/index.ts:386)

批导出: handleBatchExportJob (handleBatchExportJob.ts:34) → getDatabaseReadStreamPaginated → pipeline + streamTransformations[format] → S3 multipart → getSignedUrl → 邮件通知

实验回填: runExperimentBackfill (handleExperimentBackfill.ts:835) → processExperimentBackfill (:868)
  → getDatasetRunItemsSinceLastRun (LEFT ANTI JOIN events_full) → enrichSpansWithExperiment → writeEnrichedSpans 经 IngestionService.writeEventRecord (Doris MoW 幂等)
```

## 核心实现

### executeLLMAsJudgeEvaluation 共享核心

```ts title="worker/src/features/evaluation/evalService.ts:718"
export async function executeLLMAsJudgeEvaluation(...) {
  // 编译 prompt → deps.callLLM (structured output) → validateEvalOutputResult
  // → deps.uploadScore (S3) + deps.enqueueScoreIngestion → 更新 jobExecution.status=COMPLETED
}
```

trace 级（`evaluate`）与 observation 级（`processObservationEval`）都复用它，差异在调度入口与队列。

### PeriodicExclusiveRunner 独占锁基类

```ts title="worker/src/utils/PeriodicExclusiveRunner.ts:14"
export abstract class PeriodicExclusiveRunner extends PeriodicRunner {
  // 持有 RedisLock(lockKey + lockTtlSeconds + onUnavailable)
  // withLock(operation, onFailure) 包装 + processBatch() 测试入口
}
```

6 个 cleaner 子类均 `extends PeriodicExclusiveRunner`，override `execute()` 调 `withLock(() => commandDoris(DELETE...))`。`BatchDataRetentionCleaner`（`batch-data-retention-cleaner/index.ts:113`）按 project retentionDays 批量 DELETE traces/observations/scores/events_full。

### TokenCountWorkerManager worker_thread 池

`TokenCountWorkerManager`（`tokenisation/async-usage.ts:20`）用 `new Worker(worker-thread.js)` 池化 tiktoken/Claude tokenizer 的 WASM 计算，`getNextWorker` round-robin，`replaceWorker` 在 error/exit 时重建，30s timeout 兜底。token 计数是 CPU 密集，放主线程会阻塞事件循环拖累其他 BullMQ job。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `PeriodicExclusiveRunner` 基类 `withLock`/`processBatch` 骨架，子类 override `execute()` | cleaner 骨架统一，只写删除逻辑 |
| 策略 | eval trace 级 `evaluate` vs observation 级 `processObservationEval`，均复用 `executeLLMAsJudgeEvaluation` | 同一抽象多执行路径 |
| 工厂 | `evalJobExecutorQueueProcessorBuilder(enableRedirectToSecondaryQueue, queueName)`（`evalQueue.ts:121`） | 按参数返回 primary/secondary processor |
| worker_thread | `TokenCountWorkerManager`（`async-usage.ts:20`） | 卸载 CPU 密集计算 |
| 独占锁 | `RedisLock`（`PeriodicExclusiveRunner`） + 实验 backfill 裸 `redis.set NX EX`（`handleExperimentBackfill.ts:777`） | 多实例防重复执行 |

## 模块间交互

- **BullMQ 队列**：TraceUpsert / CreateEvalQueue / DatasetRunItemUpsert / EvaluationExecution / LLMAsJudgeExecution / EvaluationExecutionSecondaryQueue / TraceDelete / ScoreDelete / DatasetDelete / ProjectDelete / BatchExport / BatchActionQueue / EventPropagationQueue。
- **Doris**：`queryDoris`（读）、`commandDoris`（DELETE/INSERT）、`DorisWriter`（流式 ingest）、表 events_full/observations_batch_staging/dataset_run_items_rmt/traces/observations/scores。
- **Prisma**：jobExecution/jobConfiguration/evalTemplate/batchExport/batchAction/project/user/dataset_items。
- **S3 / LLM**：`StorageServiceFactory.uploadFileBuffered` + `getSignedUrl`；`deps.callLLM`（`fetchLLMCompletion`，`LangfuseInternalTraceEnvironment.LLMJudge`）。
- **app.ts** `WorkerManager.register` 串联所有 processor；`Batch*Cleaner.start()` 启动定时器。

## 扩展方式

新增一种 eval target（如 session 级）：(a) `@langfuse/shared` 扩 `EvalTargetObject`；(b) `createEvalJobs`（`evalService.ts:173`）加新 `sourceEventType` 分支与 filter 逻辑；(c) 若执行特征不同，`evalQueue.ts` 加 `xxxExecutionQueueProcessor` + `app.ts` `WorkerManager.register`；(d) `scheduleObservationEvals`（`scheduleObservationEvals.ts:36`）扩展 targetObject 过滤。加一个定时清理任务：新建子类 `extends PeriodicExclusiveRunner`，override `execute()` 调 `withLock(() => commandDoris(DELETE...))`，构造时传 `lockKey`/`lockTtlSeconds`，在 `app.ts` 实例化并 `.start()`（模板参考 `BatchDataRetentionCleaner` `index.ts:113`）。对应测试：`worker/src/features/evaluation/__tests__/`、各 cleaner 的 `__tests__/`。
