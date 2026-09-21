---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "DataNode 与公共库"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "Go", "Compaction", "Import"]
description: "Milvus DataNode 与公共库解读——v2.6 角色收缩（compaction/index/import 离线 worker）、flushcommon 共享刷盘、六种 SyncPolicy、mix compaction 逐行过滤算法与 bulk import 五格式"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

`internal/datanode/`（54 文件 21K 行）+ `internal/storage/`（Go 侧 47 文件）+ `internal/flushcommon/` + `internal/compaction/` + `pkg/` 基础库。**v2.6 的角色巨变**：DataNode 从"channel 消费者"收缩为**离线工作节点**——compaction 执行器 + index build + stats + analyze + bulk import，不再消费消息队列（`WatchDmChannels is not in use`，`services.go:53`；`FlushSegments`/`GetCompactionState`/`SyncSegments` 等标注 "Deprecated after v2.6.0" 直接返回 success）。`DataNode` struct（`data_node.go:74`）只剩四个引擎：compactionExecutor、importTaskMgr+Scheduler、内嵌 indexnode（taskScheduler + taskManager，走 segcore cgo）、供 import 复用的 syncMgr。

## 模块架构

### v2.6 的新接口面：统一 worker 协议

`CreateTask/QueryTask/DropTask`（`services.go:538-761`）用 `taskcommon.Properties` 把 PreImport/ImportV2/CompactionV2/index/stats/analyze 六种请求**统一为一个泛化 RPC 入口**——为 datacoord 的 task-based 调度与多集群（ClusterID）路由做准备。老 `CompactionV2`（:165）仍按 `CompactionType` 分派到四种 task 后 `compactionExecutor.Enqueue`；`QuerySlot`（:487）汇总三类任务的 slot 上报给 datacoord 做负载调度。

### flushcommon：为什么抽出来

"写 WAL → 内存 buffer → flush 到对象存储 → 上报 datacoord"这条链路在 streamingnode 的 flusher（在线流式）和 datanode 的 importv2（离线导入）都存在——抽成 `internal/flushcommon/` 让两者**复用同一套落盘代码**（streamingnode 的 `resource.go:76` 构造 syncMgr，`flusher_components.go:63` 用 pipeline.NewEmptyStreamingNodeDataSyncService 建 DataSyncService）。这也匹配"streamingnode + datanode 二选一/并存"的部署演进——滚动升级期间两者共存，共享代码保证刷盘行为一致。

## 核心实现

### SyncManager 与六种刷盘策略

`SyncTask.Run`（`flushcommon/syncmgr/task.go:115`）：取 segment 元信息 → 按 `StorageVersion` 选 writer（v2 走 `NewBulkPackWriterV2` + packed Parquet，v1 走 `NewBulkPackWriter`）→ 写 insert/stats/delta/bm25 四类 binlog → `metaWriter.UpdateSync` 经 broker 通知 datacoord → 更新 metacache。同一 segment 的 sync 任务按 SegmentID 加 key lock **串行化**（`keyLockDispatcher`），并发度 = CPU 数 × 每核任务数（运行时热调）。

**writebuffer 的六种 SyncPolicy**（`writebuffer/sync_policy.go`）——**用可控的内存换写放大**（攒得越久单文件越大、小文件越少）：`GetDroppedSegmentPolicy`（段已 drop）、`GetFullBufferPolicy`（满）、**`GetSyncStaleBufferPolicy`**（数据停留超 staleDuration + **随机 10% jitter——避免雪崩**）、`GetSealedSegmentsPolicy`（seal 通知）、`GetFlushTsPolicy`（用户 flush 语义）、`GetOldestBufferPolicy`（限并发数时优先最老）。`getColumnGroups`（task.go:208）：storagev2 的列组拆分，首次 sync 计算后沿用 previous split 保持稳定。

### Compaction 执行（mix 逐行过滤）

`mixCompactionTask.Compact()`（`datanode/compactor/mix_compactor.go:328`）：

1. `preCompact` 估算 `outputSegmentCount = ceil(currSize/targetSize)`；
2. 输入段全 `IsSorted` 且 ≤ `MaxSegmentMergeSort` 且开 `UseMergeSort` → 走**按 PK 的 k 路归并零拷贝直写**（`merge_sort.go`）；否则 `mergeSplit`；
3. **逐行读入逐行过滤**（`writeSegment`，:205-326）：`ComposeDeleteFromDeltalogs` 反解 delta 成 `map[pk]Timestamp`，`EntityFilter` 做**删除过滤（PK 命中即滤除）+ TTL 过期过滤**（统计 deleted/expired 计数）；逐 batch 读 Arrow Record，被滤行用 RecordBuilder 连续区间批量 Append（非真逐行复制）；
4. 输出段 sorted 还**内联建 text index**（:412 注释解释 why：让 QueryNode 加载时已有 TextStatsLogs，避免 cgo CreateTextIndex 兜底；非 sorted 输出等后续 sort compaction 再建）。

`MultiSegmentWriter`（`segment_writer.go:45`）：`rotateWriter`（:152）按 `plan.GetMaxSize()` 滚动新 segment ID 写（**ID 来自 datacoord 预分配区间 + `allocator.NewLocalAllocator` 无锁分配**，执行期间不回源申请）。Executor 的 Slots/ExecPool 双重并发控制被注释自嘲 "should use a single resource pool"。

### L0 Compactor：删除按 BF 分拣

`LevelZeroCompactionTask.Compact()`（`l0_compactor.go:116`）：输入 = 一个 L0 段（全是 delete）+ 若干目标段。`loadBF`（:436）并行加载各目标段的 BloomFilterSet，`process` 把 L0 的删除按 **bloom filter 归属**分拣写入各目标段的新 deltalog（分批控内存）——**不重写 insert 数据**只合并 delta，是所有 compaction 里最便宜的。Clustering compactor 的执行侧算法在 [DataCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/03-datacoord)（analyze kmeans → 分桶 → 内存受控重写）。

### Go 侧 storage 与双抽象

`ChunkManager` Go 接口（`types.go:53`：local/minio/azure/gcp 实现 + factory 按 `cloud_provider` 选型）；datanode 侧的 `StorageFactory`（`chunk_mgr_factory.go`）可**按请求的 StorageConfig 为每个任务单独建 ChunkManager**——支持多存储后端集群。**为什么 Go/C++ 双 storage 抽象**：Go 服务层需要独立于 C++ 的对象存储操作（事务性 binlog 写、元数据、import 读外部文件——写路径不经 C++）；列式引擎（storagev2 packed：列组 Parquet + 压缩 + multipart）在 C++ Arrow 栈实现性能更好，Go 经 **loon FFI** 调用（`storagev2/packed/packed_reader_ffi.go` → `storage/loon_ffi/ffi_reader_c.h`——Arrow Schema 跨 FFI 传递）。读写管线统一 Arrow Record 抽象：`NewBinlogRecordReader`（v1）与 `NewManifestRecordReader`（v2 manifest→packed）都产出 `RecordReader`。

### Importv2：bulk import 五格式

两阶段：**PreImport**（只读文件头统计行数/大小/vchannel 分布上报，datacoord 决定切分）→ **Import**（`task_import.go:164`）：`GetMemoryAllocator().BlockingAllocate` 内存背压 → 逐行读 → `AppendSystemFieldsData`（补 RowID/时间戳，autoID 分配）→ `RunEmbeddingFunction`（**服务端 embedding**：dense + BM25 sparse）→ `HashData`（按 pk hash 到 vchannel×partition）→ `NewSyncTask` 经 syncMgr **直接复用 flush 管线写 binlog（不走 WAL）——这就是 import 快的原因**。格式支持（`internal/util/importutilv2/reader.go:48`）：binlog（backup 恢复，IsBackup 时 UnsetAutoID 保留原 pk）/json/jsonl/numpy/parquet/csv。L0 import 特例直接把删除数据导入 L0 段。

### pkg 基础库

**pkg/kv** 四层接口（`kv.go:43-85`：BaseKV → TxnKV（MultiSaveAndRemove with predicates）→ MetaKv（CompareVersionAndSwap）→ WatchKV（etcd WatchChan））+ 带重试的可靠写。**pkg/mq** `MsgStream` 生产消费一体抽象（pulsar/kafka/rocksmq wrapper）——**v2.6 主要用于控制面广播与遗留路径，数据面已由 streaming WAL 取代**。**pkg/common** 的存储路径常量（SegmentInsertLogPath/DeltaLogPath/StatsLogPath/…按 collection/partition/segment/field/logID 拼接）是对象存储 key 布局的全局契约；系统字段保留 ID（RowIDField=0、TimeStampField=1、用户字段从 100 起）。**typeutil**：`Timestamp = uint64`（混合逻辑时钟）与角色常量。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 共享库抽取 | flushcommon（两节点复用） | 部署演进的代码一致性 |
| 统一 worker 协议 | CreateTask/QueryTask 泛化入口 | 六任务类型一套调度 |
| 策略链 | 六种 SyncPolicy | 刷盘触发条件可插拔 |
| ID 预分配 | datacoord 区间 + LocalAllocator | 执行期免回源 |
| FFI 复用 | loon packed reader | C++ 列式引擎的性能直接受益 |

## 模块间交互

上游调度来自 [DataCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/03-datacoord)（compaction/index/stats/analyze 任务）；索引构建经 indexbuilder cgo 进 [C++ 引擎](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/08-index-storage)；flushcommon 被 [Streaming](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/06-streaming) 的 flusher 复用；产物（binlog/索引文件）上传对象存储后触发 QueryCoord 的 target 更新。

## 扩展方式

**新增 import 格式（如 ORC）**：`internal/util/importutilv2/orc/` 实现 `Reader` 接口（`Read() (*storage.InsertData, error)`）→ `reader.go:48` 的 NewReader 加后缀分派 → util.go 加扩展名常量——importv2 主体零改动（格式完全封装在 reader 后面）。**新增 compaction 类型**：datapb 枚举 + `compactor/` 新 task 实现 `Compactor` 接口 + services.go 的 switch。**调整刷盘策略**：sync_policy.go 新增一个 SyncPolicy 实现插入策略链即可。
