---
source:
  type: "源码解读"
  project: "yugabyte-db"
  url: "https://github.com/yugabyte/yugabyte-db"
title: "RocksDB 引擎 Fork"
date: "2026-09-23T00:48:00+08:00"
category: [Database, HTAP, YugabyteDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["YugabyteDB", "C++", "RocksDB", "CompactionFeed", "UserFrontier", "universal compaction", "tablet 存储"]
description: "YugabyteDB RocksDB Fork 解读——2017 年硬 fork 上游 v4.6 开发期、UserFrontier 贯通全栈、CompactionFeed 流式替代 CompactionFilter、每 tablet 双实例 + 进程级共享线程池、SST 双文件分层全解"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`src/yb/rocksdb/`（177k 行）+ `src/yb/rocksutil/`。**硬 fork，单向演进，从未 rebase 上游**：导入提交 `b0c82724b9`（2017-10-02）从上游 commit `e8e6cf01` 落库，此后 519 个 YB 提交独立演进。上游基线对应 **v4.6 开发期**（HISTORY.md 止于 4.5.0；`BlockBasedTableSupportedVersion` 只支持 ≤2；ValueType 枚举止于 0x8——无 5.x 的 XID 类型）。

**为什么 fork 而不用 upstream + 扩展点**——四处硬改引擎内核、非插件点可覆盖：

1. **WAL 关闭、MANIFEST 语义外部化**：`InitRocksDBWriteOptions()` 设 `disableWAL=true`（**Raft log 就是 WAL**，恢复时重放）；版本编辑可序列化为 protobuf（`VersionEditPB`，version_edit.proto），内嵌 YB 概念 `obsolete_last_op_id`、`flushed_frontier`（google.protobuf.Any）——供 tablet superblock / remote bootstrap / 快照恢复时程序化修补 LSM 元数据（`RocksDBPatcher` 直接构造 VersionSet 调 LogAndApply）
2. **文件边界携带用户 frontier**：`storage/storage_types.h` 的 `UserFrontier`（docdb 侧实现 = HybridTime + OpId + history_cutoff）贯通 WriteBatch → MemTable → SST 文件 `smallest/largest.user_frontier` → VersionEdit。上游没有"文件级 MVCC 时间戳"概念——这是 flush/compaction 调度和 GC 判断的根基
3. **compaction 语义重写**：`db/compaction_context.h` 的 `CompactionFeed`（有状态流式 `Feed(key,value)` + `GetLiveRanges()`）替代上游无状态 CompactionFilter（compaction_job.cc:737 把每个 key 喂给 feed）
4. **多实例进程级资源管理**：改 `DBImpl` 内部接入 `yb::PriorityThreadPool`（db_impl.cc:228）

## 模块架构

**单实例多 tablet？——与直觉相反：每 tablet 独立 RocksDB 实例**。一个 yb-tserver 内是**大量实例**：每个 tablet 打开 **2 个**（`Tablet::OpenRegularDB` tablet.cc:1227 + `OpenIntentsDB` :1336，目录 `t-<id>` 与 `t-<id>.intents`；每个向量索引再一个 `t-<id>.vi-<index_id>`）。**tablet 隔离靠目录**；colocated 表共宿一个 tablet 靠 DocKey 前缀（`CotablePacking/ColocationPacking`）。

**进程级共享资源**（fork 存在感最强的地方）：

- 全局 block cache（`InitBlockCache`，tablet_memory_manager.cc:262；tserver 默认 32% 内存）
- 全局 memtable 预算：fork 新文件 `memory_monitor.h` + `WriteBuffer` 把所有实例 memtable 字节加总，超限唤醒 `FlushTabletIfLimitExceeded()` **挑最大 memtable 跨 tablet flush**
- 全局 compaction/flush 线程池（`GetGlobalPriorityThreadPool()`，~3.5/8×CPU，动态优先级、支持 suspend/pause）
- 共享 rate limiter（默认 1GB/s 全进程）

**为什么 intents 单独开 DB**（2018-06 commit `0af7366b9d` 的决策）：intents 生命周期短、可整文件直接删，apply 与 flush 的顺序协调需要两套 frontier 独立控制；独立实例还隔离 memtable 内存。

## 核心实现

### Compaction 三层调度 + GC 引擎在 compaction 内

1. **实例内**：bootstrap 期间 `disable_auto_compactions=true`，完成后 `EnableCompactions()`（tablet.cc:1641）恢复；稳态 universal compaction 由 fork 的 PriorityThreadPool 执行（按磁盘负载重排优先级）
2. **tserver 级**：`FullCompactionManager`（60s 一轮）——定期（按 tablet_id hash 确定性 jitter）+ **统计驱动**：`KeyStatsSlidingWindow` 监测 5 分钟窗口内 obsolete keys 占比 ≥99% 且 ≥10000 keys → 触发全量 compaction
3. **事件驱动**：split 后 `TriggerPostSplitCompactionIfNeeded()`（tablet.cc:5217）做**有限 compaction**——`file_number_upper_bound` + `GetLiveRanges()` 只重写新 tablet key range 内的父遗留文件

**MVCC GC 唯一场所是 compaction**：`DocDBCompactionFeed`（docdb_compaction_context.cc:783）流式处理每个 key，按 `HistoryRetentionDirective` 丢弃过期版本 + **row repacking**（把多个列级更新合并回 packed row）+ 向量反向映射清理（`VectorMetadataFilter`）。`GetLargestUserFrontier()` 把 history_cutoff 写进输出文件 frontier——**compaction 之后这个 tablet 不再支持更旧时间点的一致性读**。

### Flush 协调（frontier 驱动）与 intents GC

- **intents flush 门控**：`Tablet::IntentsDbFlushFilter`（tablet.cc:997，挂在 fork 新增的 `mem_table_flush_filter_factory`）——intents memtable 只有当 regular DB **和所有向量索引**已把对应 OpId 之前的数据刷盘才允许 flush
- **intents SST 文件直接删除**：`DoCleanupIntentFiles`（tablet.cc:1510）——regular DB 文件变化触发，"min running transaction start HT > 文件 max HT" 满足则 `intents_db_->DeleteFile()`。**fork 的 `DB::DeleteFile` 在此被用作事务 GC 原语**
- **compaction 内 intents 清理**：`DocDBIntentsCompactionFilter` 处理超时的 aborted 事务元数据、外部 intents

### SST 双文件分层

每个 SST 拆两个文件：`NNNNNN.sst`（index/filter/footer 等 metadata）+ `NNNNNN.sst.sblock.0`（数据块）——ENG-763 的**SST 分层**设计：metadata 驻本地 SSD，数据可落慢介质（配合 superblock 的 TierPath/db_paths tiered storage）。双写器在 `block_based_table_builder.cc`。

### 读路径与 bloom

fork 的 `HybridTimeFilteringIterator`（基于 `table/filtering_iterator.h`）按 key 尾部 DocHybridTime 过滤；`CreateIntentHybridTimeFileFilter` 按文件 `largest.hybrid_time` 整文件跳过。Bloom 是 **DocDB 感知的**（`DocDbAwareV3FilterPolicy` + fork 的 `GetKeyTransformer` 钩子；seek 时 `read_options.iterator_filter` 做文件级预检）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 流式有状态 feed | CompactionFeed（compaction_context.h） | DocDB GC 需要前一 key 上下文 + compaction 结束改写文件 frontier |
| frontier 贯通 | UserFrontier 从 WriteBatch 到 VersionEdit | MVCC 在 key 不在 seqno，RocksDB 原生 seqno 无用武之地 |
| 进程级池化 | PriorityThreadPool + MemoryMonitor | 万级 tablet 需要全局预算与带宽仲裁；upstream per-DB 后台线程在此规模不可行 |
| 双文件分层 | TableBaseToDataFileName（builder.cc:145） | metadata/data 异介质分层 |

## 模块间交互

- **与 DocDB**：KV 编码 `three_shared_parts`、compaction context 工厂、flush filter 全在 docdb 侧注入（见[DocDB 存储抽象](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/04-docdb)）
- **与 Raft**：WAL 禁用，`GetFlushedFrontier/GetInMemoryFrontier` 支撑崩溃恢复的 `ComputeApplyToStorages` 判定（见[Raft 共识与 Tablet](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/02-raft-tablet)）
- **与向量索引**：`hnsw::BlockCache` 包装全局 rocksdb LRU cache（`ConsumeSpace` 容量预留，cache.h:84/171）——向量块与 SST 块共享容量记账（见[向量索引](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/05-vector-index)）
- **选项差异要点**：universal compaction + `num_levels=1` + Snappy + `SkipListFactory(0, ConcurrentWrites::kFalse)`（YB 自己做写批并发）——**DocDB key 含 HybridTime 后缀，同一逻辑行多版本但 user key 不重复，天然适合 universal 合并 + SingleDelete**，层次化 level 结构无意义

## 扩展方式

**调 compaction 触发/节奏**：gflag 层全在 `docdb_rocksdb_util.cc:74-170`（`rocksdb_level0_file_num_compaction_trigger`、`rocksdb_universal_compaction_*`、rate limit 等）；全量调度改 `tserver/full_compaction_manager.cc`；实例内优先级改 `db/db_impl.cc` 的 TaskPriorityUpdater。

**改 GC/保留策略**：history cutoff 判定在 `docdb/docdb_compaction_context.cc`（`DocDBCompactionFeed::Feed`）；TTL 整文件跳过改 `docdb/compaction_file_filter.cc`。

**调 flush**：内存预算 `tserver/tablet_memory_manager.cc`；intents 门控 `tablet.cc:997`。

**向量块缓存**：chunk/merge 改 `vector_index/vector_lsm.cc`；反向映射 GC 改 `docdb_compaction_context.cc` 的 VectorMetadataFilter。
