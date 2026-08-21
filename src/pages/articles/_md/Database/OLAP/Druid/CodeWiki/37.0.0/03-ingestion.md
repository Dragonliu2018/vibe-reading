---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "摄入引擎"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "摄入", "Kafka", "Appenderator", "exactly-once"]
description: "Druid 摄入引擎——Task 抽象与 AbstractTask 模板方法、批/流统一 InputSource、Appenderator 拆分、流摄入 checkpoint exactly-once、并行批 partial→merge、Compaction 编排。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（`indexing-service/.../common/task/`、`seekablestream/` 及 `server/.../realtime/appenderator/`）负责**把外部数据变成 Segment**：Task 抽象定义"做什么"，批/流两条路径经统一 `InputSource`/`InputFormat` 读入 `InputRow`，由 `Appenderator` 追加到 `IncrementalIndex`，持久化/合并/推送后发布元数据。它是"worker"侧（task 在 peon/indexer 上跑），与 Overlord 模块（master 侧调度）互补。职责边界：**一个 task 内部如何把数据写成 segment**；谁来调度 task 见 Overlord 模块，segment 格式见 Segment 模块。

## 模块架构

```
        Supervisor(流, Overlord)          IndexTask(批)
                │                              │
        SeekableStreamIndexTask            IndexTask.runTask
        (委托 Runner)                     (determine → build)
                │                              │
        RecordSupplier/StreamChunkReader   InputSource + InputFormat
                │                              │
                └────────► InputRow ◄──────────┘
                              │
                  Appenderator.add（Batch / Stream）
                              │
                  Sink → IncrementalIndex.add
                              │
                  persist → IndexMerger → push(DataSegmentPusher)
                              │
                  publish metadata → Coordinator 加载 → handoff
```

批/流在 `InputRow` 汇合，统一走 Appenderator→IncrementalIndex。`Task` 经 Jackson `@JsonSubTypes` 注册所有子类型（IndexTask/CompactionTask/SeekableStreamIndexTask 子类等），Overlord 按 `type` 反序列化。

## 调用链路

![数据摄入流程](/vibe-reading/images/articles/druid-internals/ingestion-flow.svg)

**批摄入**（`AbstractTask.run` → `IndexTask.runTask`）：

```
AbstractTask.run(toolbox)                       [AbstractTask.java:165]  # final: setup→runTask→cleanUp
  → IndexTask.runTask(toolbox)                  [IndexTask.java:422]
    → determineShardSpecs(...)                  # 阶段1：扫描确定 interval/shard
    → generateAndPublishSegments(...)            # 阶段2
      → BatchAppenderators.newAppenderator/driver
      → InputSourceProcessor.process(...)       [InputSourceProcessor.java:64]
        → inputSource.reader(schema, inputFormat, tmpDir)
        → while (iter.hasNext()): driver.add(row, seqName)   # → BatchAppenderator.add → Sink.add → IncrementalIndex.add
          → if (pushRequired) driver.pushAllAndClear
      → driver.pushAllAndClear → awaitPublish(TransactionalSegmentPublisher)
```

**流摄入**（`SeekableStreamIndexTaskRunner.runInternal`）：

```
SeekableStreamIndexTask.runTask → getRunner().run(toolbox)
  → SeekableStreamIndexTaskRunner.runInternal   [SeekableStreamIndexTaskRunner.java:394]
    → StreamChunkReader + RecordSupplier.assign/seek
    → while (stillReading):
       getRecords → reader.parse → driver.add(row, seq, committerSupplier, true, false)
         → StreamAppenderator.add → Sink.add → IncrementalIndex.add
         → if (persist) persistAll(committer.get())   # 落 offset 快照
       if (checkpoint) submit CheckPointDataSourceMetadataAction   # 通知 supervisor
    → publishAndRegisterHandoff
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `AbstractTask.run` | 模板方法骨架 | final，固化 setup→runTask→cleanUp |
| `IndexTask.runTask` | 批摄入两阶段 | 先定分区再写，保证 rollup |
| `SeekableStreamIndexTask.runTask` | 流摄入 | 委托 Runner，自身极简 |
| `Appenderator.add` | 追加行 | Batch 拒 committer，Stream 保留 |
| `Appenderator.persistAll` | 持久化 | Stream 同落 offset 快照 |
| `Appenderator.push` | 合并并推 deep storage | IndexMerger.merge 后 pusher |
| `Committer.getMetadata` | offset 快照 | exactly-once 恢复依据 |

</details>

## 核心实现

### Task 抽象与模板方法

`indexing-service/.../common/task/Task.java` 是所有 worker 侧任务根接口，`@JsonSubTypes` 注册全部子类型，契约含单 datasource（`getDataSource`）、唯一 ID、`isReady(TaskActionClient)`（Overlord 侧前置检查，幂等）、`run(TaskToolbox)`、`canRestore()`。`AbstractTask`（`AbstractTask.java:165`）用**模板方法**把 `run` 声明 `final`，依次 `setup`→`runTask`（抽象）→`cleanUp`，子类只填 `runTask`。它还引入 `IngestionMode`（REPLACE/APPEND/REPLACE_LEGACY/NONE），由 `computeBatchIngestionMode` 依 `isAppendToExisting`/`isDropExisting` 算出。

### 批摄入 IndexTask

`IndexTask`（`IndexTask.java`）持 `IndexIngestionSpec`（DataSchema + IOConfig[InputSource+InputFormat] + TuningConfig）。`runTask`（行 422）两阶段：`determineShardSpecs` 扫描数据确定 interval 与分区数；`generateAndPublishSegments` 真摄入——经 `BatchAppenderators.newAppenderator/driver` 与 `InputSourceProcessor.process` 循环喂行，`pushAllAndClear` 增量推送，`TransactionalSegmentPublisher` 发布。

### 流摄入 SeekableStreamIndexTask + checkpoint

`SeekableStreamIndexTask<PartitionIdType, SequenceOffsetType, RecordType>`（`seekablestream/SeekableStreamIndexTask.java`）是 Kafka/Kinesis 流摄入基类，`runTask`（行 176）极简——委托 `SeekableStreamIndexTaskRunner`。`isReady` 直接返 true（由 supervisor 调度，不等待锁），`canRestore` 返 true。具体实现（`KafkaIndexTask`）只需实现 `createTaskRunner` 与 `newTaskRecordSupplier`。

exactly-once 靠两层 offset 状态：`currOffsets`（已处理）与 `sequences`（`SequenceMetadata` 的 start/endOffsets）。`Committer`（`runInternal` 行 576-588）每次 persist 创建 currOffsets 快照写入 Appenderator commit metadata；task 故障恢复时 `driver.startJob` 返回该 metadata，从中恢复 currOffsets 重新 seek，已持久化数据不重复摄入。checkpoint（行 782-807）达阈值时经 `CheckPointDataSourceMetadataAction` 通知 supervisor 该 sequence 完成，supervisor 据此推进 offset 并建新 sequence。

### Appenderator 拆分：Batch / Stream

37 版已**移除单一 `AppenderatorImpl`**，拆为 `BatchAppenderator`（`server/.../realtime/appenderator/BatchAppenderator.java`）与 `StreamAppenderator`（`StreamAppenderator.java`）。原因（`BatchAppenderator` 类注释）：旧 `AppenderatorImpl` 同时处理批和流，但批摄入不需要查询能力、不需要 commit 恢复、内存策略不同，共用代码"correct but inefficient"。拆分后 Batch 去掉查询支持与并发（`sinks` 用普通 HashMap、持久化时清内存），优化批量内存；Stream 保留查询（`SinkQuerySegmentWalker`）、commit 恢复、concurrent map、增量持久化。两者都经 `Sink.add`→`IncrementalIndex.add`，并持 `IndexMerger` 在 `push` 时 `persist`/`merge`。

### 并行批摄入 partial → merge

`ParallelIndexSupervisorTask`（`batch/parallel/ParallelIndexSupervisorTask.java` 行 698-847）支持两阶段：`runHashPartitionMultiPhaseParallel` 阶段 0（可选）`PartialDimensionCardinalityTask` 采样定 interval/numShards，阶段 1 `PartialHashSegmentGenerateTask` 各 worker 并行生成 partial segment 并报告 `GeneratedPartitionsReport`，阶段 2 `PartialGenericSegmentMergeTask` 按 (interval, partitionId) 分组合并 push 为最终 segment。single-phase（best-effort rollup）则各 subtask 独立生成 push、无 merge。perfect rollup 需全局 hash 分区，单 worker 无法保证跨 split 一致，故 partial（按 split）→merge（跨 split 合并同分区）。

### Compaction 编排

`CompactionTask`（`CompactionTask.java` 行 541）不直接读写，而是编排器：`createInputDataSchemas` 从 metadata 取指定 interval 已有 segment，构造 `DruidInputSource`（从已有 segment 读）+ `ParallelIndexIngestionSpec`，为每个 interval 创建 `ParallelIndexSupervisorTask` 子任务并以 REPLACE 覆盖旧 segment。`CompactionRunner` 是策略接口（`NativeCompactionRunner` native 引擎 vs `MSQCompactionRunner` MSQ 引擎）。Minor/Major compaction 与已 compact segment 的 `MarkSegmentToUpgradeAction` 升级均有支持。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `AbstractTask.run` | 固化骨架，子类只填 `runTask` |
| 策略 | `InputSource`/`InputFormat`、`CompactionRunner` | 存储/解析/合并引擎正交可换 |
| SPI/Plugin | `Task`/`InputSource` 的 `@JsonSubTypes` | task/数据源可扩展 |
| 工厂 | `BatchAppenderators`/`Appenderators` | 按批/流创建写入器 |

## 模块间交互

依赖 `segment/`（`Appenderator`/`IncrementalIndex`/`IndexMerger`/`FireHydrant`）、`overlord/`（被 `TaskRunner` 调度、经 `TaskActionClient` 提交 LockList/SegmentAllocate/Publish/Checkpoint action）、`metadata`（publish）、deep storage（`DataSegmentPusher`，在 `TaskToolbox` 注入）。注意 `Appenderator` 相关类在 `server` 模块（被 realtime 节点 `RealtimeIndexManager` 与 indexing worker 共享），不在 `indexing-service`。跨模块依赖路径：`indexing-service`(Task) → `processing`(InputSource/InputRow) → `server`(Appenderator/IncrementalIndex)。

## 扩展方式

- **新增 InputSource**：实现 `InputSource`（`isSplittable`/`needsFormat`/`reader`/`getTypes`），并行摄入实现 `SplittableInputSource.createSplits`，加 `@JsonType` 注册到 `InputSource` 的 `@JsonSubTypes`，按需在 `Task.getInputSourceResources` 加权限。
- **新增流摄入**（仿 KafkaSupervisor）：实现 `RecordSupplier`，新建 `SeekableStreamIndexTask` 子类（`createTaskRunner`/`newTaskRecordSupplier`）+ `SeekableStreamIndexTaskRunner` 子类 + `Supervisor`（继承 `SeekableStreamSupervisor`），注册 task 类型与 Guice。
- **新增 Task 类型**：继承 `AbstractTask` 实现 `runTask`，注册 `@JsonSubTypes`，按需用 `BatchAppenderators.newAppenderator` + driver 写 segment、`TransactionalSegmentPublisher` 发布。
