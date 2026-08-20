---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "mito2 存储引擎"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "LSM", "存储引擎", "WAL", "compaction"]
description: "mito2——Datanode 的核心 region 存储引擎：worker 单写多读、WAL+memtable 写路径、CoW Version 读快照、LSM compaction 与分层 cache 解读。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`mito2`（`src/mito2/`，~15.4 万行）是 GreptimeDB 的核心 region 存储引擎，实现 `store_api::RegionEngine` trait。它是 Datanode 的心脏：负责 region 的打开/关闭、写入（WAL + memtable）、读取（memtable + SST 合并）、flush（memtable→SST）、compaction（LSM 合并）、manifest（元数据持久化）、分层 cache 与 GC。`metric-engine` 在其上做 metrics 专用复用，`index` 作为 external provider 注入 SST 加速检索。它是唯一一个"写串行化于 worker 线程、读不走 worker"的引擎——这一设计直接决定了 GreptimeDB 的写入吞吐与读并发特征。

## 模块架构

![mito2 内部架构](/vibe-reading/images/articles/greptimedb-internals/mito2-architecture.svg)

`MitoEngine`（`engine.rs:277`）是对 `EngineInner` 的 `Arc` 包装，持有 `WorkerGroup`、`MitoConfig`、WAL reader、scan 内存追踪器。`WorkerGroup`（`worker.rs:136`）含 N 个 `RegionWorker`，每个 worker 跑一个 `RegionWorkerLoop`（`worker.rs:837`）——单写多读的线程，从 mpsc channel 批量取请求处理。region 通过 `region_id_to_index`（`worker.rs:495`）哈希绑定到固定 worker，保证同一 region 的写串行、不同 region 天然并行。

`MitoRegion`（`region.rs:142`）是 region 的运行时态，核心是 `VersionControl`（`version.rs:49`）——一个 `RwLock<VersionControlData>`，内部持 `Version`（metadata + memtables + ssts + flushed_sequence）。`Version` 是 copy-on-write 快照，读操作取 `Arc<Version>` 异步扫描，写操作 clone 出新版本。`AccessLayer` 读写 SST 文件，`ManifestContext` 持 `RegionManifestManager` 记录文件列表变更历史。

写路径组件：`Wal<S>`（`wal.rs:52`，封装 `LogStore`）、`Memtable`（`memtable.rs:255` trait，`TimeSeriesMemtable`/`BulkMemtable` 两种实现）。后台任务：`CompactionScheduler`（`compaction/scheduler.rs:52`）+ `Picker`/`Compactor`、`FlushScheduler`、`IndexBuildScheduler`。`CacheManager`（`worker.rs:204`）管多种独立 cache（SST meta/vector/page、write cache 等）。

## 调用链路

**写请求**（`handle_request` → WAL + memtable）：

```
MitoEngine::handle_request(region_id, RegionRequest::Put)   engine.rs:1245
  → EngineInner::handle_request → WorkerRequest::try_from_region_request  engine.rs:1029, request.rs:670
  → WorkerGroup::submit_to_worker → 投入 mpsc channel           worker.rs:300
  → [worker 线程] RegionWorkerLoop::run 批量 recv               worker.rs:912
  → handle_write_requests                                       handle_write.rs:43
     1. maybe_flush_worker / maybe_flush_write_regions          handle_flush.rs:81,175  （背压检查）
     2. should_reject_write / should_stall                      handle_write.rs:570,81
     3. prepare_region_write_ctx → RegionWriteCtx              handle_write.rs:292, region_write_ctx.rs:116
        → push_mutation：分配 sequence number，构建 WalEntry    region_write_ctx.rs:149
     4. write_wal(&wal, &mut region_ctxs)                       handle_write.rs:611
        → Wal::writer → WalWriter::write_to_wal → LogStore::append_batch  wal.rs:78,226  （多 region 一次落盘）
     5. region_ctx.write_memtable                                region_write_ctx.rs:243
        → KeyValues::new → mutable_memtable.write(&kvs)         memtable.rs:260
     6. publish_sequence_and_entry_id                           region_write_ctx.rs:381
  → 返回 RegionResponse{ affected_rows }
```

**memtable flush 成 SST**（异步后台）：

```
maybe_flush_worker / flush_periodically / handle_flush_request   handle_flush.rs:81,339,307
  → new_flush_task + flush_scheduler.schedule_flush              handle_flush.rs:222, flush.rs:1265
  → RegionFlushTask::do_flush → flush_memtables → do_flush_memtables  flush.rs:375,439,577
     → mem.compact(true) + mem.ranges(for_flush)                flush.rs:601,614
     → access_layer.write_sst(...)                              （写 Parquet + Puffin 索引）
     → 构造 RegionEdit{ files_to_add, flushed_entry_id }
     → manifest_ctx.update_manifest(action_list)                flush.rs:547
  → BackgroundNotify::FlushFinished → 投回 worker                flush.rs:410
  → handle_flush_finished → version_control.apply_edit          handle_flush.rs:381, version.rs:143
     → wal.obsolete(region_id, flushed_entry_id)                 （删除已 flush 的 WAL）
     → schedule_compaction(&region)                             handle_flush.rs:502
```

**读请求**（`handle_query`，**不走 worker**）：

```
MitoEngine::handle_query(region_id, ScanRequest)   engine.rs:1275
  → EngineInner::scan_region → find_region + version_control.current()  engine.rs:1051
  → ScanRegion::new(version, access_layer, request, CacheStrategy)      scan_region.rs
  → region_scanner → SeqScan/UnorderedScan/SeriesScan                   scan_region.rs:384
  → Scanner::scan → build_stream                                         scan_region.rs:102
     → 合并 memtable ranges + SST file ranges → FlatMergeIterator/FlatDedupIterator
  → SendableRecordBatchStream
```

关键设计：读只取 `Version` 快照（`version_control.current()`），然后异步扫描 memtable + SST，不修改状态、不排队——这是单写多读的核心。`engine.rs:1053` 注释明确："Reading a region doesn't need to go through the region worker thread"。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `MitoEngine::handle_request`（engine.rs:1245） | 写/DDL 入口 | 投入 worker channel，oneshot 回收结果 |
| `MitoEngine::handle_query`（engine.rs:1275） | 读入口 | 直接取 version 快照，不走 worker |
| `RegionWorkerLoop::run`（worker.rs:912） | worker 主循环 | select! 收请求/flush 通知/超时，批量聚合 |
| `handle_write_requests`（handle_write.rs:43） | 批量写处理 | 先 WAL 后 memtable，多 region 并发写 memtable |
| `write_wal`（handle_write.rs:611） | 批量写 WAL | 多 region entry 一次 append_batch |
| `RegionFlushTask::do_flush`（flush.rs:375） | flush memtable→SST | 先 compact memtable 再 write_sst |
| `CompactionScheduler::schedule_automatic_compaction`（scheduler.rs:156） | compaction 调度 | 身份验证防 stale 通知 |
| `VersionControl::apply_edit`（version.rs:143） | 应用 SST 变更 | CoW 生成新 Version |

</details>

## 核心实现

### Worker 单写多读与 region 哈希绑定

`region_id_to_index`（`worker.rs:495`）用 `(table_id % num_workers + region_number % num_workers) % num_workers` 把 region 绑到固定 worker。只有该 worker 线程能修改 region 的 metadata（写、flush、compaction 调度），读操作直接从 `VersionControl` 取不可变快照。这样避免了写路径锁竞争，region 间无共享状态天然并行，`Version` 的 copy-on-write 让读不阻塞写。

worker 主循环（`worker.rs:912`）用 `tokio::select!` 在"receiver 收请求 / flush_receiver.changed() / 超时"间调度，批量聚合最多 `worker_request_batch_size` 个写请求后 `handle_requests`——批量写 WAL 减少 I/O 次数、批量处理减少线程唤醒开销。

### WAL 批量写入 + memtable 并发写

`write_wal`（`handle_write.rs:611`）把多个 region 的 `WalEntry` 攒进一个 `WalWriter`，一次 `LogStore::append_batch` 落盘，借鉴 Kafka producer batch 的思路减少 I/O。**写 WAL 成功后才写 memtable**，保证持久性。memtable 写入时，单 region 的 mutations 通过 `spawn_blocking_global` 并行写入（`region_write_ctx.rs:275`），memtable 内部各自做并发控制（`TimeSeriesMemtable` 按 series 分片）。`AllocTracker`（`memtable.rs:317`）追踪每个 memtable 内存分配并反馈给 `WriteBufferManager` 做全局背压。

### Memtable 实现

`Memtable` trait（`memtable.rs:255`）有三种实现，由 `MemtableBuilderProvider::builder_for_options`（`memtable.rs:419`）按 region options 选择：flat format 或 sparse primary key encoding 强制用 `BulkMemtable`（配合 metric-engine 的 sparse 编码），否则用 `TimeSeriesMemtable`。`write_bulk`（`memtable.rs:266`）走 bulk 路径，`compact(true)`（`memtable.rs`）在 flush 前对 memtable 内部做合并。

### CoW Version 与读快照

`VersionControl`（`version.rs:49`）内部 `RwLock<VersionControlData>`，`VersionControlData`（`version.rs:336`）持 `VersionRef`、`committed_sequence`、`last_entry_id`。`Version`（`version.rs:360`）含 metadata、memtables、ssts、flushed_entry_id/sequence。修改时 `VersionBuilder::apply_edit`（`version.rs:475`）clone 出新 `Version`（内部 `Arc` 共享，clone 开销极低），读取 `version_control.current()` 拿 `Arc<Version>` 快照。读不需持锁、写不阻塞读——这是 mito2 读高并发的根基。

### Manifest 持久化与一致性

`RegionManifestManager`（`manifest/manager.rs:153`）记录 region 元数据与文件列表变更历史，action 类型有 `Change`/`Edit`/`Remove`/`Truncate`（`manifest/action.rs:38`）。每次 flush/compaction 产生 `RegionEdit`（files_to_add/files_to_remove），**先写 manifest 再 apply 到 version**——如果 crash，重启时从 manifest 重放，保证一致性。`Checkpointer` 定期做快照（`manifest_checkpoint_distance` 默认 10）。manifest 是持久化的 source of truth，version 是其内存映射。

### WriteBufferManager 全局背压

借鉴 RocksDB WriteBufferManager（`flush.rs:111` 注释）：所有 region 共享一个 `global_write_buffer_size`。三级背压——(a) **flush**：mutable memtable 超 `global_write_buffer_size/2` 时触发 flush，并按 memtable 大小排序优先 flush 大的（`handle_flush.rs:134`）；(b) **stall**：总占用超 `global_write_buffer_size` 时暂停写请求放入 `StalledRequests`；(c) **reject**：超 `global_write_buffer_reject_size` 时拒绝。flush 完成后通过 `watch::channel` 通知所有 worker 处理 stalled 请求（`worker.rs:326 notify_group`）。防止单 region 或少数大 memtable 占满内存。

### Compaction：两级 LSM + TWCS

mito2 只用两级 LSM——L0（flush 产物）和 L1（compaction 产物），`MAX_LEVEL = 2`（`sst/file.rs:113`）。时序数据天然按时间排序，不需要 RocksDB 那样多级 LSM。默认 compaction 策略是 **TWCS（Time Window Compaction Strategy）**（`compaction/twcs.rs:50`）：把 SST 按 `max_timestamp` 分到时间窗口，窗口内找 sorted runs（重叠文件），多 run 用 `reduce_runs` 合并、单 run 多文件用 `merge_seq_files` 合并小文件，输出写 L1，受 `max_output_file_size`（默认 2GB）拆分。compaction 在 flush 完成后自动触发（`handle_flush.rs:502`），受 `min_compaction_interval` 与 staging 模式约束。compaction 的触发条件、状态机、合并算法、过期 SST 处理与 manifest 原子性的逐行解读见 [compaction 深读](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/01-mito2-compaction)。

### 分层 Cache

`CacheManager`（`worker.rs:204`，`cache/` 目录）管多种独立 cache：SST meta cache、vector cache、page cache、selector result cache、range result cache、prefilter result cache、index metadata/content/result cache、puffin metadata cache、write cache（文件级 LRU，远程对象本地缓存）。不同访问模式需要不同缓存策略——write cache 做远程文件本地缓存，减少 object store I/O。查询路径的 `CacheStrategy`（`scan_region.rs`）控制是否命中 cache。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Worker 单写多读 | `RegionWorkerLoop`（`worker.rs:837`） | region 哈希绑 worker，写串行避免锁，读走快照并发 |
| 批处理 + Channel | `run()`（`worker.rs:912`）、`try_recv` 批量（`worker.rs:994`） | 批量写 WAL 减 I/O、批量处理减唤醒 |
| 状态机 | `RegionLeaderState`（`region.rs:84`，Writable/Staging/Altering/Dropping…）、`CompactionStatus` | 保证生命周期操作与常规读写安全 |
| CoW Version | `VersionControl`（`version.rs:49`）、`apply_edit`（`version.rs:475`） | 读不持锁、写不阻塞读 |
| 背压 | `should_reject_write`（`handle_write.rs:570`）、`should_stall`、`should_flush_engine` | 三级防 OOM |
| 分层 Cache | `CacheManager`（`worker.rs:204`） | 不同访问模式不同策略 |

## 模块间交互

mito2 依赖 `store_api`（`RegionEngine` trait、`RegionMetadata`、`RegionId`）、`common_wal`/`log_store`（WAL 后端，`RaftEngineLogStore`）、`object_store`（S3/本地）、`datatypes`/`common_recordbatch`（Arrow）、`common_meta`、`common_memory_manager`、`datafusion`（`MemoryPool`、physical plan）、`parquet`（SST）、`mito_codec`（KeyValues 编解码）、`index`/`puffin`（SST 旁路索引）。

被 `datanode`（`src/datanode/src/datanode.rs:46` 启动时构造为 `RegionEngineRef`）、`metric-engine`（`engine.rs:492` 包装 `MitoEngine` clone 做多路复用）、`standalone`（单机直接用）调用。`RegionServer` 按 region 的引擎名（`"mito"`）路由到 `MitoEngine`，上层（operator/frontend）通过 `NodeManager` trait 间接调用，**不感知**底层是 mito2 还是 metric-engine。

## 扩展方式

- **新增 compaction 策略**：实现 `Picker` trait（`compaction/picker.rs:41`），在 `new_picker`（`picker.rs:129`）加分支，在 `region/options.rs` 的 `CompactionOptions` enum 加变体。
- **新增 SST 编码格式**：在 `sst.rs:62` `FormatType` 加变体，`sst/parquet.rs` 实现 writer/reader，`memtable.rs:419` 按格式选 memtable，`manifest/action.rs` 的 `RegionChange.sst_format` 支持新格式。
- **新增 memtable 实现**：实现 `Memtable` trait（`memtable.rs:255`）与 `MemtableBuilder`（`memtable.rs:303`），在 `builder_for_options`（`memtable.rs:419`）加选择逻辑，在 `region/options.rs` 的 `MemtableOptions` 加配置。
