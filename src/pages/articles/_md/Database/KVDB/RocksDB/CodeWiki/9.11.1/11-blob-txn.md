---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "Blob 与事务"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "Transaction", "BlobDB"]
description: "大 value 分离存储（integrated BlobDB 的 blob_index 与 GC）、悲观/乐观事务、三种 write policy（WriteCommitted/WritePrepared/WriteUnprepared）、分片行锁与死锁检测。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

本模块覆盖 utilities 层两个最重要的叠加功能。先澄清（9.11.1 核实）：存在**两套 Blob 实现**共享同一文件格式——**integrated BlobDB**（新版主线，`db/blob/` 45 文件，flush/compaction 时抽离）与 **stacked BlobDB**（legacy，`utilities/blob_db/`，Put 时立即写）。本文以 integrated 为主。

## 模块架构

```
integrated BlobDB
  写路径完全不动（value 原样进 WAL+memtable）
  flush/compaction 时：
    CompactionIterator::ExtractLargeValueIfNeeded
      → BlobFileBuilder::Add（value ≥ min_blob_size 才分离）
        → blob 文件 append-only → 返回 BlobIndex 编码
      → SST 里 value 被替换为 blob_index，type 改 kTypeBlobIndex
  读回：GetContext::SaveValue 遇 kTypeBlobIndex → Version::GetBlob
      → BlobSource::GetBlob（BlobCache 命中？→ BlobFileCache 拿 reader
        → offset 点读 + 解压 → 回填 cache）
  GC：GarbageCollectBlobIfNeeded（旧文件 blob 搬运到新文件）
      + BlobGarbageMeter 进出流量对账

事务层（utilities/transactions/，StackableDB 装饰）
  PessimisticTransaction（模板方法骨架，状态机 8 态）
    ├─ WriteCommittedTxn（默认：prepare 只进 WAL，commit 才进 memtable）
    ├─ WritePreparedTxn（prepare 即进 memtable，commit O(1)）
    └─ WriteUnpreparedTxn（分段刷未 prepare 的 batch）
  PointLockManager（分片锁表 + 死锁检测）
```

## 调用链路

```
大 value 提取（compaction 时）
  CompactionJob::ProcessKeyValueCompaction 创建 builder（compaction_job.cc:1317）
  → CompactionIterator::ExtractLargeValueIfNeeded（:1122）
      → blob_file_builder->Add(user_key, value, &blob_index)
        （blob_file_builder.cc:99 五步：min_blob_size 过滤 → 惰性开文件
         → 压缩 → 写入 → 超 blob_file_size 关文件滚动）
      → 成功后 value_ = blob_index_; ikey_.type = kTypeBlobIndex
  → 收尾 Finish() 写 footer + BlobFileAddition 进 VersionEdit
     （失败 Abandon：文件入清理名单，不记 addition）

读回
  DBImpl::GetImpl → Version::Get → SaveValue 遇 kTypeBlobIndex
  → Version::GetBlob（version_set.cc:2267）
      BlobIndex::DecodeFrom → blob_source_->GetBlob
      ├─ GetBlobFromCache（key = db_id+session_id+file_number+offset）
      ├─ read_tier == kBlockCacheTier 且未命中 → Status::Incomplete（no_io）
      ├─ blob_file_cache_->GetBlobFileReader（与 table cache 共用一个 Cache）
      └─ BlobFileReader::GetBlob（:296）：offset 点读（- adjustment 读 header
          仅 verify_checksums 时——bytes_read 也相应计入 adjustment）→ 解压
          → BlobContents → 回填

事务（WriteCommitted 默认策略）
  Put → Operate → TryLock（pessimistic_transaction.cc:1097）
      ├─ PointLockManager::TryLock：GetStripe(key) 用
      │   FastRange64(GetSliceNPHash64(key), num_stripes_) 分片
      │   → AcquireLocked（无主 emplace / 过期抢锁 / 共享并存）
      │   （等待期间 PERF_TIMER_GUARD(key_lock_wait_time) +
      │     PERF_COUNTER_ADD(key_lock_wait_count)）
      └─ ValidateSnapshot（key 的 seq 晚于事务 snapshot 则冲突回滚）
  → GetBatchForWrite()->Put（写进 WriteBatchWithIndex——read-your-own-write）
  Prepare（:584）→ MarkEndPrepare → PrepareInternal（:634）
      强制 write_options.disableWAL = false
      → WriteImpl(disable_memtable=true)
      → 数据只进 WAL；MarkLogCallback → LogsWithPrepTracker 记账
  Commit（:675）→ 状态 CAS（STARTED→AWAITING_COMMIT；STARTED 且未
      skip_prepare 时先返回 Status::TxnNotPrepared()）
      → commit 标记 + prepare 数据追加 → WriteImpl(log_ref=log_number_)
      → MarkLogAsHavingPrepSectionFlushed → Clear()（释放全部锁）
```

## 核心实现

### BlobIndex 与 append-only 文件

```text title="db/blob/blob_log_format.h"
文件头 30B：magic(4)=2395959 + version(4) + cf_id(4) + flags(1) + compression(1) + expiration(16)
文件尾 32B：blob_count(8) + expiration range(16) + CRC(4)（仅正确关闭时存在）
记录：32B 定长 header（key_len/val_len/expiration 各 8B + header_crc/blob_crc 各 4B）+ key + value
  header CRC 校验三个长度字段；blob CRC 校验 key+value 本体
```

`BlobIndex`（`blob_index.h`）是 SST 内嵌的"地址"：`type(1B) + file_number(varint) + offset(varint) + size(varint) + compression(1B)`——**变长编码**（约 15 字节典型值；"19 字节编址"的说法不准确）。两个关键设计：(a) **offset 指向 value 本身而非记录头**（`blob_log_format.h:122` 注释明示）——默认读路径精确读到 value 字节零浪费，只有 `verify_checksums` 才回退 adjustment 多读 key+header；(b) **文件 append-only 无排序**——读取是 BlobIndex 直接给 offset 的点读不按 key 检索；删除一个 value = 上层写 deletion，blob 本身不动；compaction GC 是**搬运式**（旧文件有效 blob 重写到新文件），永远没有"从文件中删一条"的操作——这正是 append-only 成立的原因。

### 为什么 BlobCache 单独配置

`advanced_options.h:987` 注释直说："blobs are less valuable from a caching perspective than SST blocks"——blob 粒度是整个 value（可达 MB）而 block 是 4KB，共享时大 blob 会冲击 block cache 命中。故默认独立 blob_cache，但**允许共享同一 Cache** 并用 `Cache::Priority` 降 blob 优先级；`ChargedCache` 包装做容量预留对齐。两级缓存：`BlobFileCache`（reader 句柄，charge=1，**与 table cache 共用一个 Cache**）+ BlobCache（BlobContents 整 value，支持 secondary tier）。

### 三种 write policy 的取舍

枚举注释（`transaction_db.h:26`）即定义：

- **WriteCommitted**（默认）：prepare 只进 WAL，commit 时才把数据再写一遍进 memtable。读路径**零改动**（memtable 中只有已提交数据）；代价是 commit 延迟高、大事务双倍 WAL 引用成本。
- **WritePrepared**：prepare 即写 memtable（seq-per-batch 语义），commit 只写 marker——commit 变 O(1)；代价是**所有读都要过 `IsInSnapshot`** 过滤未提交数据。为让判定 O(1)，设计了 64 位压缩的 commit cache（`CommitEntry64b` 把 (prep_seq, commit_seq) 压进一个字）+ `max_evicted_seq` + `PreparedHeap` + `old_commit_map_` 兜底——这套数据结构是模块中最复杂的部分（`write_prepared_txn_db.cc:569-644`）。
- **WriteUnprepared**：在 WP 基础上允许 prepare 之前分段刷 batch（阈值 `write_batch_flush_threshold`），解决 MyRocks 长事务 WriteBatchWithIndex 内存爆炸；代价是回滚需构造**反向 batch**（`RollbackWriteBatchBuilder` 遍历已写 key 生成 Delete）、read-own-write 要维护 `unprep_seqs_`。

三者共存正是模板方法骨架的价值：状态机/WAL 记账/锁管理复用，只换写入时机。

### 事务为什么在 utilities 层

核心 DBImpl 只提供事务**原语**——2PC WriteBatch 标记、`WriteImpl` 的 `disable_memtable/log_ref/batch_cnt/pre_release_callback` 参数、`use_seq_per_batch`、`LogsWithPrepTracker`；并发控制策略（悲观锁/OCC/三种 policy/死锁检测）全部在 utilities 以 `StackableDB` 装饰。好处：不用事务的用户零开销、策略可独立演进、MyRocks 等嵌入方可用 `TransactionDBMutexFactory` 定制锁原语。`db/logs_with_prep_tracker` 是反向例外：它参与 WAL 文件生命周期，必须在核心层。

### PointLockManager：分片锁表

每个 CF 一个 `LockMap`，内含 `num_stripes`（默认 16）个 `LockMapStripe`（自带 mutex + condvar + key map）；`GetStripe(key)` 用 key hash 定位分片。锁顺序注释在 `point_lock_manager.h:165`：lock_map_mutex → stripe mutexes → wait_txn_map_mutex。`LockBatch` 按 (cf, key) **排序后加锁**保证免死锁（`pessimistic_transaction.cc:1019` 注释）；wait-for 图 + 环形 `DeadlockInfoBuffer` 做死锁检测；过期锁可被抢（`IsLockExpired`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 指针间接层 | BlobIndex 内嵌 LSM 本体 | LSM 语义完全不变，只是搬运的 value 变小 |
| 模板方法 + 策略 | PessimisticTransaction 骨架 + 三 write policy | 状态机复用，写入策略可换 |
| 装饰器（StackableDB） | `stackable_db.h:21` | 功能叠加不动核心 |
| 分片锁表 + 排序加锁 | PointLockManager | 并发与死锁免役 |
| 回调钩子写管线 | PreReleaseCallback（AddPrepared/AddCommitted/MarkLog 都挂这） | 事务挂进写管线的缝 |
| 流式 GC 计量 | BlobGarbageMeter 进出差值 | 垃圾满则整文件 obsolete |

## 模块间交互

**compaction/flush**：builder 在 `ProcessKeyValueCompaction` 与 `BuildTable` 中被创建并注入 CompactionIterator；`BlobFileAddition/Garbage` 经 VersionEdit 持久化。**cache**：`ColumnFamilyData::blob_source_` 持 BlobCache；flush 时 `prepopulate_blob_cache=kFlushOnly` 直接 `InsertSaved` 预热。**write_thread**：事务全部写操作走 `WriteImpl` 进入 group commit 管线；WC 依赖 `log_ref` 与 `disable_memtable`，WP 依赖 `batch_cnt` 与 PreReleaseCallback。**WAL GC**：`LogsWithPrepTracker` 被 FlushJob 与 `FindObsoleteFiles` 消费。**stacked BlobDB 的接口点**：核心层遇 memtable 内 kTypeBlobIndex 且 `is_blob_index` 出参为空时报 `NotSupported`——核心层只为 stacked 层放行，自身不解析。

## 扩展方式

**为 integrated BlobDB 增加 TTL**：格式已向后兼容预留（`has_ttl` 字段、`kBlobTTL` 类型都在）——需打通 `OpenBlobFileIfNeeded`（当前硬编码 false）、`ReadHeader/ReadFooter`（当前把 TTL 当 Corruption 拒绝）、`Version::GetBlob`（拒绝 kBlobTTL）三处管线。

**替换锁管理器**（分布式锁、范围锁扩展）：实现 `LockManager` 接口与 `LockTrackerFactory`，在 `PessimisticTransactionDB::Initialize` 装配处切换——现有 `lock/point/`（行锁）与 `lock/range/`（范围锁）是参照。

**新增 write policy**：继承 `PessimisticTransaction` 实现 5 个纯虚函数——参照 `write_unprepared_txn.h` 的三套 savepoint 数据结构如何扩展。
