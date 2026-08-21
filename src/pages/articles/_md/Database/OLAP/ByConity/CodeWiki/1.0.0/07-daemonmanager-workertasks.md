---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "后台任务编排与执行"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "C++", "后台任务", "merge", "DaemonManager"]
description: "ByConity 后台任务三层管线：DaemonManager 编排、CloudServices 选 part、WorkerTasks 执行 merge/mutate。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/00-overview)

---

## 模块定位

ByConity 的后台任务（merge/mutate/GC/dedup/auto-stats）是一条三层管线：**DaemonManager**（`src/DaemonManager/`，约 8k 行）是独立服务，做全局编排——周期遍历所有表、用一致性哈希定位每张表的 host server、触发其后台线程；**WorkerTasks**（`src/WorkerTasks/`，约 5k 行）是 worker 端的执行体——具体实现 merge/mutate/recluster 等操纵任务。中间由 CloudServices 的 BG 线程衔接（server 选 part、下发 worker）。两层分离是为了避免多 server 各自调度导致同一表的 BG job 重复运行。

---

## 模块架构

```text
┌─ DaemonManager（编排服务）─────────────────────────────┐
│  DaemonJob (模板方法: start/execute/scheduleAfter)     │
│    └─ DaemonJobServerBGThread                           │
│         ├─ getUUIDsFromCatalog (遍历全表)              │
│         ├─ TargetServerCalculator (一致性哈希定位)     │
│         ├─ BackgroudJobExecutor (RPC 触发 server BG)   │
│         └─ BGJobStatusInCatalog (状态持久化)          │
│    其他子类: DaemonJobGlobalGC / TxnGC / AutoStatistics│
│  DaemonFactory (singleton, 注册)                        │
├─ WorkerTasks（worker 执行）────────────────────────────┤
│  ManipulationTask (基类: execute→executeImpl)           │
│    ├─ CloudMergeTreeMergeTask                          │
│    ├─ CloudMergeTreeMutateTask                         │
│    └─ CloudMergeTreeReclusterTask                     │
│  ManipulationList (全局任务注册表/限流/心跳超时)       │
│  MergeTreeDataMerger/Mutator/ReclusterMutator          │
│  CnchMergePrefetcher (异步预取 part 到本地)            │
└────────────────────────────────────────────────────────┘
```

---

## 调用链路

### DaemonJob 生命周期（以 merge 为例）

```text
DaemonManager::main → createDaemonJobsForBGThread → DaemonFactory.createDaemonJobForBGThreadInServer("PART_MERGE")
  → daemon->init()   建 status_store(BGJobStatusInCatalog)/bg_job_executor/target_server_calculator
                     fetchCnchBGThreadStatus(): 遍历所有 CnchServerClient 恢复 background_jobs
  → daemon->start()  BackgroundSchedulePool::activateAndSchedule

DaemonJob::execute() → executeImpl()  [DaemonJobServerBGThread]
  1. getUUIDsFromCatalog(): 遍历 Catalog.getAllTables()，constructStorageTrait 判断 ifNeedDaemonJob
  2. fetchServerStartTimes(): 取存活 server
  3. getUpdateBGJobs(): diff 新旧 UUID → add/remove
  4. findServerInfo(): getAllTargetServerForBGJob()
       → TargetServerCalculator.getTargetServer()
       → CnchTopologyMaster::getTargetServer(uuid, vw_name, ts)  [一致性哈希]
  5. fetchStatusesIntoCache() [批量预取]
  6. ThreadPool 并行: 每个 BackgroundJob → sync(server_info)
       a. getStatus(uuid, use_cache) 从 Catalog 读 expected_status
       b. getSyncAction(): 比较 status + 目标 server 是否变化
       c. executeSyncAction(): bg_job_executor.start/stop/remove
            → CnchServerClient::controlCnchBGThread(Start/Stop/Remove)  [RPC 到目标 server]
  7. checkLivenessIfNeed() → runMissingAndRemoveDuplicateJob()
  → scheduleAfter(interval_ms)  // 10s 后再执行
```

![后台任务三层管线](/vibe-reading/images/articles/byconity/bg-task-pipeline.svg)

### merge 任务执行（worker 端）

```text
[server BG 线程] 选 part → ManipulationTaskParams → 下发 worker
[worker] executeManipulationTask(task, all_parts):
  1. StorageCloudMergeTree::loadDataParts(all_parts)
  2. CloudMergeTreeMergeTask::executeImpl():
     a. storage.lockForShare()
     b. MergeTreeDataMerger merger(...)
     c. merger.mergePartsToTemporaryPart():
        - chooseMergeAlgorithm(): Horizontal(列少) vs Vertical(列多)
        - CnchMergePrefetcher.submitDataPart() 每个 source part
          [远端 HDFS/S3 → 本地 AUXILITY disk 分段异步拷贝]
        - MergeTreePrefetchedReaderCNCH 读(触发下一 stage 预取)
        - MergingSortedTransform / ReplacingSortedTransform ...
        - MergedBlockOutputStream 写新 part
     d. 为每个 source part 建 drop_part(deleted=true)
     e. CnchDataWriter.dumpAndCommitCnchParts(temp_parts): 写共享存储 + Catalog 元数据
     f. getCurrentTransaction()->commitV2()  [提交使新 part 可见]
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `DaemonJob::execute` | 周期执行 + reschedule | final 模板方法 |
| `DaemonJobServerBGThread::executeImpl` | 发现表+定位 server+sync | consistent hashing |
| `BackgroundJob::sync` | 按状态差执行 start/stop | 状态比较 |
| `BackgroudJobExecutor::start` | RPC 触发 server BG 线程 | controlCnchBGThread |
| `TargetServerCalculator::getTargetServer` | 定位表归属 server | 一致性哈希 |
| `BGJobStatusInCatalog::setStatus` | 作业状态持久化 | 写 Catalog + 缓存预取 |
| `ManipulationTask::execute` | 切 MemoryTracker+执行 | final 模板方法 |
| `MergeTreeDataMerger::mergePartsToTemporaryPart` | 合并 part | H/V 算法+预取 |
| `CnchMergePrefetcher::submitDataPart` | 分段异步预取 | IO/计算重叠 |
| `ManipulationList::insert` | 注册任务+限流 | CurrentMetrics::Manipulation |

</details>

---

## 核心实现

### 为什么独立 DaemonManager

存算分离下 server 可能动态增缩。若每 server 各自调度，无法全局感知表分布——同一表的 BG job 可能在多个 server 重复运行。DaemonManager 作中央调度器，全局遍历 Catalog 取所有表 UUID，经一致性哈希精确定位每张表的 host server，确保每个 BG job 只在一个 server 运行。`executeImpl` 的 liveness check 与 zombie job 清理进一步保证一致性。

### TargetServerCalculator

对 CnchMergeTree 表，调 `CnchTopologyMaster::getTargetServer(toString(uuid), server_vw_name, ts, false)`（`TargetServerCalculator.cpp:47-52`），底层一致性哈希。对 CnchKafka 更复杂：经 Catalog 找 Kafka 表依赖的 MaterializedView，再找 MV 的目标 CnchMergeTree 表，用目标表 UUID 做哈希，确保 Consumer 与目标表在同一 server（`TargetServerCalculator.cpp:54-108`）。

### 作业状态持久化

`BackgroundJob` 构造时 `createStatusIfNotExist(uuid, Running)` 写 Catalog；`start/stop/remove` 先写 Catalog 再发 RPC。这样 DaemonManager 重启后 `fetchCnchBGThreadStatus` 能从 Catalog 恢复 expected_status，与 server 实际状态 sync。状态支持外部 RPC 查询（`GetDMBGJobInfo`）。`fetchStatusesIntoCache` 批量预取缓存避免逐表 RPC。

### ManipulationList 跟踪与故障检测

`ManipulationList`（`ManipulationList.h`）继承 `BackgroundProcessList`，全局线程安全任务注册表。每个 `ManipulationTask` 经 `getManipulationList().insert(params)` 注册得 `ManipulationListElement`（progress/is_cancelled/memory_tracker/thread_group/last_touch_time）。`isCancelled(timeout)` 检查 `last_touch_time`——超 timeout 未收 server 心跳则自动 `is_cancelled=true`。这实现 worker 端资源控制与故障检测：限制并发（CurrentMetrics::Manipulation）、追踪内存、server 失联时取消任务。

### CnchMergePrefetcher 预取

预取 source part 的 `data` 文件（checksums 中记录的列数据文件）。`submitDataPart` 按 checksums 的 `file_offset` 把 data 文件切成 segment（大小 `cnch_merge_prefetch_segment_size`），`std::async` 异步拷贝到本地 AUXILITY disk。读取时 `getFutureSegmentAndPrefetch` 触发下一 stage 预取（pipeline 化），`releaseSegment` 用完即删临时文件。IO 与计算重叠，减少远端读取延迟。小 part（<= 2*segment_size）直接整体预取。

### recluster vs merge

merge 把同 partition 多个 part 合并成一个大 part，减少 part 数量。recluster 在此基础上加 cluster key 重排——`MergeTreeDataReclusterMutator::executeClusterTask` 对单个 part `executeOnSinglePart`，按 clustering key 重新排序后可能拆成多个新 part。recluster 的 drop_part 保持原 mutation（`part->info.mutation`，不同于 merge 用 `getCurrentTransactionID`），最终以 `ManipulationType::Clustering` 提交。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `DaemonJob::execute`/`ManipulationTask::execute` | 骨架统一，子类填 executeImpl |
| 工厂+注册 | `DaemonFactory`/`registerDaemons.cpp` | 新增作业局部改动 |
| 策略 | `DaemonJobForCnch<T, ifNeedDaemonJobF>` 模板 | 10 种 BG 线程按表类型过滤 |
| 依赖注入 | `DaemonJobServerBGThread` 构造接受 interface ptr | 便于注入 mock 测试 |

---

## 模块间交互

DaemonManager 依赖 Catalog（表 UUID/状态/事务/trash）、ServiceDiscovery/CnchTopologyMaster（存活 server+目标定位）、CloudServices（`CnchServerClient::controlCnchBGThread` RPC）。WorkerTasks 依赖 CloudServices（任务下发/`CnchDataWriter`）、Disks（读写 part）、Catalog（part 元数据）、Storages。详见概览的 [后台任务管线图](/vibe-reading/images/articles/byconity/bg-task-pipeline.svg)。

---

## 扩展方式

**新增 DaemonJob**：继承 `DaemonJob`（本地作业）或 `DaemonJobServerBGThread`（触发 server BG 线程），实现 `executeImpl`；写 `registerXxxDaemon(DaemonFactory&)` 在 `registerDaemons.cpp` 调用；`DaemonManager.cpp` 的 default_config 加 `{"XXX", interval_ms}`；`DaemonJob.cpp` 的 metric switch 加对应项。

**新增 ManipulationTask**：`ManipulationType.h` enum 加类型；继承 `ManipulationTask` 实现 `executeImpl`；server 端 BG 线程选 part 后构造 `ManipulationTaskParams`，在 worker 调度入口分发到新 Task 类。

**调整调度频率/并发**：频率改 `DaemonManager.cpp` default_config map（ms）或 config.xml 覆盖；并发改 `daemon_job_for_bg_thread_max_thread_pool_size`（默认 10）、`background_schedule_pool_size`（12）、`cnch_txn_gc_parallel`（16）；worker 端经 `ManipulationList` 控制全局并发任务数。

> 注：`DaemonJobBackup.cpp` 在 1.0.0 不存在，备份功能在该版本尚未实现；`FixCatalogMetaDataTask.cpp` 是额外的 Catalog 元数据修复任务，在 `DaemonManager::main` 经 SchedulePool 调度。
