---
source:
  type: "源码解读"
  project: "InfluxDB"
  url: "https://github.com/influxdata/influxdb"
title: "WAL 与缓存"
date: "2026-08-20T13:07:26+08:00"
category: [Database, TSDB, InfluxDB, CodeWiki, "3.11.1"]
tags: ["InfluxDB", "Rust", "TSDB"]
description: "InfluxDB 3 Core 的 diskless WAL（对象存储持久化）、Last/Distinct/Parquet 三缓存与 LinearBuffer 内存分配器"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/00-overview)

---

## 模块定位

本模块是持久性与查询加速的双职责层。`influxdb3_wal` 实现 diskless WAL——写前日志直接 PUT 到对象存储而非本地磁盘，使节点无状态可迁移。`influxdb3_cache` 提供三种内存缓存：Last Cache（最近 N 值，服务 `last()` 查询）、Distinct Cache（去重值，服务 `DISTINCT` 查询）、Parquet Cache（已持久化 Parquet 文件字节缓存）。`core/linear_buffer` 是自研固定大小零拷贝内存分配器。这些缓存共同保证 last-value 查询 <10ms、distinct 查询 <30ms。边界：从 WAL 写入到缓存更新，不涉及 Line Protocol 解析（见 [写入路径](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/03-write-path)）。

## 模块架构

WAL 侧：`Wal` trait（`lib.rs:64`）定义接口，`WalObjectStore`（`object_store.rs:36`）是唯一实现，持有 `FlushBuffer`（内存 `WalBuffer` + `SnapshotTracker`）。`WalFileNotifier` trait（`lib.rs:123`）是观察者接口，`QueryableBuffer`（写入模块）实现它接收持久化通知。

缓存侧：`LastCacheProvider`（`last_cache/provider.rs:24`）持有三层嵌套 `HashMap<DbId, HashMap<TableId, HashMap<LastCacheId, LastCache>>>`；`LastCache` 用 `LastCacheState` 递归枚举（`Key→Store`）形成按 key column 层级树。`DistinctCacheProvider` 用 `Node` BTreeMap 嵌套树。Parquet Cache 用 `MemCachedObjectStore`（`parquet_cache/mod.rs:621`）包装底层 store，`MemCacheOracle` 是注册接口，`Cache` 用 `DashMap` + `BinaryHeap` 做 LRU。

## 调用链路

**写入到 WAL 持久化**：

```
wal.write_ops(ops)  [object_store.rs:291]
  └─ buffer_ops_with_response()  [object_store.rs:885]  → 合并到 WalBuffer
  └─ [后台] background_wal_flush()  [lib.rs:555]  每 flush_interval 触发
       └─ flush_buffer()  [object_store.rs:308]
            └─ flush_buffer_into_contents_and_responses()  [object_store.rs:727]
                 ├─ SnapshotTracker.snapshot() 判断是否快照
                 ├─ serialize_to_file_bytes()  [serialize.rs:103]
                 │    (FILE_TYPE_IDENTIFIER "idb3.001" + bitcode + crc32)
                 └─ object_store.put_opts(wal_path, PutMode::Create)  [object_store.rs:344]
            └─ file_notifier.notify(wal_contents)  → QueryableBuffer（见写入模块）
  └─ [快照完成] cleanup_snapshot() → remove_snapshot_wal_files()
```

**Last-value 查询命中缓存**：

```
SELECT * FROM last_cache(db, table, cache)  (UDTF)
  └─ LastCacheFunction table_function
       └─ LastCacheProvider::get_cache_schema()  [provider.rs:116]
       └─ LastCache::to_record_batches()  [cache.rs:340]
            └─ LastCacheKey::evaluate_predicate()  [cache.rs:607]  (In/NotIn 筛选)
            └─ LastCacheStore::to_record_batch()  [cache.rs:831]  (TTL 过滤 + Arrow ArrayRef)
       └─ → RecordBatch → DataFusion
```

`SnapshotSequenceNumber` 在 WAL replay 时用于跳过已快照的文件（`object_store.rs:249` 检查 `snapshot_sequence_number <= last_snapshot_sequence_number`），只 `notify` 不 `notify_and_snapshot`，避免重复快照。

## 核心实现

### diskless WAL：对象存储 PUT 而非 append

`WalObjectStore` 构造接收 `object_store: Arc<dyn ObjectStore>`（`object_store.rs:37`），`flush_buffer` 直接 `object_store.put_opts()` 写入（`object_store.rs:344`）。`PutMode::Create` 确保不覆盖已有文件——检测到同 node-id 并发写入会触发 shutdown（`object_store.rs:363`）。`replay()`（`object_store.rs:148`）从对象存储重放恢复。模块文档（`lib.rs:1-4`）明确："persist them as individual files in an object store"。传统 WAL 是 append-only，但对象存储不支持 append，因此 InfluxDB 3 在内存 `WalBuffer` 合并后整体序列化为单文件一次性 PUT（`serialize.rs:2-3`），用 `bitcode` 二进制序列化 + `crc32fast` 校验。

### SnapshotTracker 的 3x 防积压

`snapshot_tracker.rs:60-91`：若有未来时间数据持续写入，旧数据可能无法被快照（`end_time_marker` 需对齐 `gen1_duration`）。当 `wal_periods.len() >= 3 * snapshot_size` 时强制 `snapshot_all()`，防止 WAL 无限积压。正常情况 `snapshot_in_order_wal_periods()` 保留最后一个 WAL period 的数据（默认保留约 300 个 WAL period）。`SnapshotDetails` 的 `first/last_wal_sequence_number` 范围允许 `remove_snapshot_wal_files` 精确删除已快照文件区间。

### LastCache 层级树与 ring buffer

`LastCache`（`last_cache/cache.rs:35`）的 `LastCacheState` 是递归枚举（`cache.rs:541`）：`Init → Key(column_id, HashMap<KeyValue, LastCacheState>) → Store`，形成按 key column 逐层展开的树。叶子 `LastCacheStore`（`cache.rs:679`）用 `VecDeque` ring buffer 实现 FIFO 淘汰 + `instants` VecDeque 记录插入时间做 TTL 过期，双重淘汰策略（count + ttl）。`LastCacheProvider` 通过 `background_catalog_update`（`provider.rs:385`）订阅 `CatalogEvent`，响应表/库删除与缓存创建/删除。

### Parquet Cache + Oracle 两阶段填充

`parquet_cache/mod.rs` 的 `MemCacheOracle` 实现 `ParquetCacheOracle` trait（`mod.rs:160`）。两阶段缓存填充：**Immediate 模式**——持久化 Parquet 时已有序列化 bytes，`set_cache_value_directly()`（`mod.rs:226`）零延迟写入缓存；**Eventual 模式**——只有路径信息时异步从 object store GET，用 `Shared<BoxFuture>` + `Fetching` 状态去重并发请求（`mod.rs:897`），避免对同一路径重复拉取。`should_request_be_cached()`（`mod.rs:924`）根据 `query_cache_duration` 时间窗口判断是否值得缓存。`background_cache_pruner` 定期 LRU 淘汰。

> **两套缓存注记**：`influxdb3_cache/src/parquet_cache`（应用层 Parquet Cache Oracle）与 `core/object_store_mem_cache`（core 层对象存储 S3-FIFO 缓存）是两层相关但不同的缓存——后者包装底层 object_store 的 GET（见 [Parquet 与对象存储](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/07-parquet-object-store)）。

### LinearBuffer 自研内存分配

`core/linear_buffer/src/linear_buffer.rs:67` 的 `LinearBuffer` 用 `UnsafeCell` + `MaybeUninit` 实现固定地址分配（never moves），`Slice` 通过 `Arc` 共享底层 allocation 实现零拷贝引用。`Allocation`（`allocation.rs:14`）直接调 `std::alloc::alloc` 并支持自定义对齐（SIMD/I/O 要求）。它解决标准库与 `bytes` crate 无法同时满足"向 buffer 追加数据的同时持有已初始化部分只读引用"的需求——这在网络接收+并发缓存场景常见（文档 18-23 行）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `Wal` trait `lib.rs:64` + `ParquetCacheOracle` `mod.rs:160` | 抽象 WAL 后端与缓存注册 |
| 观察者 | `WalFileNotifier` `lib.rs:123` + `CatalogSnapshotObserver` `observer.rs:14` | WAL 事件解耦下游；catalog 事件驱动缓存 |
| 层级数据结构 | `LastCacheState` `cache.rs:541` + `DistinctCache::Node` | 按 key column 逐层展开树，支持谓词下推 |
| 缓存策略 | ring buffer + TTL（last）/ BTreeMap+cardinality（distinct）/ LRU（parquet） | 三缓存按查询模式定制淘汰 |

## 模块间交互

WAL 与 QueryableBuffer：`QueryableBuffer` 实现 `WalFileNotifier`，`notify()`（`queryable_buffer.rs:488`）先 `write_wal_contents_to_caches` 再 `buffer_write_ops`。WAL 与 Catalog：`LastCacheProvider`/`DistinctCacheProvider` 从 catalog 初始化并通过 `CatalogEvent` 订阅增量更新；`WriteBatch` 携带 `catalog_sequence` 与 catalog 版本对齐。三种缓存服务查询：Last Cache 服务 `SELECT last(...)`（UDTF 快路径），Distinct Cache 服务 `SELECT DISTINCT`（UDTF），Parquet Cache 服务普通时间范围查询（缓存 Parquet 字节）。`core/object_store_mem_cache` 是更底层的对象存储字节缓存。

## 扩展方式

- **新增缓存类型（如 Min/Max Cache）**：`influxdb3_cache/src/lib.rs` 加 `pub mod minmax_cache`；新建 `cache.rs`（参考 `last_cache/cache.rs`）+ `provider.rs`（`new_from_catalog`/`write_wal_contents_to_cache`/`background_catalog_update`）+ `table_function.rs`（DataFusion TableProvider）；`queryable_buffer.rs` 加字段与 `write_wal_contents_to_caches` 调用；`influxdb3_catalog` 加 `CatalogEvent` 变体。
- **修改 WAL 持久化（如加本地磁盘 WAL）**：新建 `influxdb3_wal/src/disk_store.rs` 实现 `Wal` trait，替换 `object_store.put_opts` 为本地文件 I/O，保留 `serialize_to_file_bytes`/`verify_file_type_and_deserialize` 不变。
- **修改 Parquet Cache 淘汰策略（如 LRU→LFU）**：`parquet_cache/mod.rs` 的 `CacheEntry`（行 337）将 `hit_time: AtomicI64` 改 `hit_count`，`Cache::prune()`（行 536）改 `PruneHeapItem` 比较逻辑，`background_cache_pruner`（行 954）无需改。
