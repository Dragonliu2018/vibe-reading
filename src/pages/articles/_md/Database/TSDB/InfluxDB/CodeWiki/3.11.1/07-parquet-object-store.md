---
source:
  type: "源码解读"
  project: "InfluxDB"
  url: "https://github.com/influxdata/influxdb"
title: "Parquet 与对象存储"
date: "2026-08-20T13:07:26+08:00"
category: [Database, TSDB, InfluxDB, CodeWiki, "3.11.1"]
tags: ["InfluxDB", "Rust", "TSDB"]
description: "InfluxDB 3 Core 的 Parquet 列式持久化、对象存储抽象（S3/Azure/GCP）、S3-FIFO 内存缓存与双编码元数据"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/00-overview)

---

## 模块定位

本模块是 diskless 架构的物理基座。`core/parquet_file` 抽象 Parquet 文件读写（列式持久化格式），`core/object_store_utils` + `core/object_store_mem_cache` + `core/object_store_metrics` + `core/object_store_size_hinting` 组成对象存储抽象与缓存层。它把 S3/Azure/GCP/本地磁盘统一为 `ObjectStore` trait，在其上叠加 S3-FIFO 内存缓存（避免重复拉取）、指标采集（`ObjectStoreMetrics`）、健康观测（`ObservedObjectStore`/`ObjectStoreHealth` 用于 `/ready` 端点）。diskless 的核心意义在此层显现：WAL 与 Parquet 都持久化到对象存储，节点本身无持久状态。边界：物理字节读写与缓存，不涉及业务逻辑（分区/去重见 [写入路径](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/03-write-path)）。

## 模块架构

`core/parquet_file` 下 `lib.rs`（文件抽象）、`writer.rs`（ArrowWriter 封装）、`storage.rs`（存储）、`metadata.rs`（`IoxMetadata` 双编码）、`chunk.rs`、`serialize.rs`。`core/object_store_mem_cache` 的核心是 `MemCachedObjectStore`（`store.rs`）实现 `ObjectStore` trait，持有 `Cache`（`cache_system/` 下的 S3-FIFO 实现）。`Cache`（`mod.rs:400`）用 `DashMap<Path, CacheEntry>` 并发安全 + `BinaryHeap` 做 LRU/S3-FIFO 淘汰，`CacheEntry` 有 `Fetching`/`Success` 双状态去重并发请求。`ObservedObjectStore` 包装任意 store 报告 `ObjectStoreHealth`。

## 调用链路

**Parquet 写入**：`Persister::persist_parquet_file`（`influxdb3_write/src/persister.rs:924`）→ `serialize_to_parquet`（ArrowWriter + ZSTD + 100K row group）→ `object_store.put_adaptive()`。

**Parquet 读取（查询）**：DataFusion 物理计划 `DataSourceExec` → `ParquetSource` → `RuntimeEnv.object_store_registry` 查找 `DynObjectStore` → `MemCachedObjectStore.get`（先查 S3-FIFO 缓存，未命中走底层 S3/Azure）→ Parquet 解析 → RecordBatch。

## 核心实现

### 对象存储抽象与适配器链

`ObjectStore` trait（来自 `object_store` crate）统一 S3/Azure/GCP/本地磁盘，`influxdb3_write` 的 `Persister` 与 `core/iox_query` 的查询都通过同一 trait 访问。在 `serve.rs:1009-1038`，store 被层层包装：基础 store → `ObjectStoreMetrics`（指标装饰器）→ `create_cached_obj_store_and_oracle`（Parquet 缓存装饰器）。每层都实现同一 trait，组合出"带指标+带缓存"的 store。`register_iox_object_store`（`exec.rs:267`）把 store 注册到 `RuntimeEnv` 供查询使用。

### S3-FIFO 三队列驱逐算法

`core/object_store_mem_cache/src/cache_system/s3_fifo_cache/s3_fifo.rs` 实现 S3-FIFO（优于传统 LRU）。三队列结构：**Small 队列**（新数据先进）→ **Main 队列**（被二次访问的数据晋升）→ **Ghost 集**（已驱逐 key 的 tombstone）。`evict_from_small_queue`（行 870）：从 small 头部弹出，若 `freq>0` 或 in-use 移到 main 尾部，否则驱逐到 ghost 集。`evict_from_main_queue`（行 921）：对 freq `fetch_sub(1)`，仍 >0 或 in-use 移尾部，否则驱逐到 ghost。防 livelock：最多迭代 `queue_len*4` 次。Ghost 集实现"二次访问晋升"——新插入时若 key 在 ghost 中直接进 main（`s3_fifo.rs:388`）。并发设计：`get()` 仅 `DashMap` 短锁 + `AtomicU8::fetch_update` 更新频率，无需获取 `locked_state` Mutex，读不阻塞写；`drop_it()` 标记 `#[inline(never)]` 确保 deallocation 不在临界区。

### 元数据双编码路径

`IoxMetadata` 有两种序列化：**Protobuf + Base64**（嵌入 Parquet 文件 KV metadata）——`to_base64()`（`metadata.rs:304`）→ `to_protobuf` → base64 存入 `KeyValue{key:"IOX:metadata"}`，`read_iox_metadata_new()`（`metadata.rs:739`）反向提取，`METADATA_VERSION=10`；**Thrift + Zstd**（Catalog 独立存储）——`parquet_md_to_thrift()`（`metadata.rs:656`）用 `ParquetMetaDataWriter` 生成完整 footer，手动解析 FileMetaData thrift 字节再 zstd 压缩，绕过 parquet 57.0.0 移除的 `to_thrift()` API，用 footer 格式 `[ColumnIndex][OffsetIndex][FileMetaData][4-byte len][PAR1]` 手动切片。

### BufferChannel 零拷贝路径

`MemCachedObjectStore` 支持两条数据获取路径（`store.rs:67-99`）：**零拷贝**——调用方在 `GetOptions.extensions` 插入 `BufferSender`，底层 store（如 S3）把数据写入共享 `LinearBuffer::Slice`，`CacheValueData::Shared(Slice)` 直接引用底层 buffer无拷贝，`InUse` 检查用 `slice.is_unique()`；**拷贝 fallback**——无 `BufferSender` 时流式读到 `Vec` 再转 `Bytes`，`CacheValueData::Owned(Bytes)` 独立持有。`buffer_channel.rs` 实现 channel。

### ObjectStoreHealth 错误分类

`ObservedObjectStore`（`observed_object_store.rs:30`）把每次操作结果报告给 `ObjectStoreHealth`，用于 `/ready` 端点判断存储可用性。`record_outcome`：`Ok` 或 `NotFound` 视为成功（网络/认证路径正常，仅路径不存在），其他 `Err` 调 `health.record_error`，`ErrorCategory::categorize` 分类永久/瞬时性错误影响 `/ready` 判定。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 适配器 | `ObjectStore` trait 统一 S3/Azure/GCP | 屏蔽云厂商差异 |
| 装饰器 | `ObjectStoreMetrics`/`MemCachedObjectStore` 包装链 | 层层叠加指标与缓存 |
| 分层缓存 | Small/Main/Ghost 三队列 S3-FIFO | 优于 LRU，适应时序访问模式 |
| 双编码 | `IoxMetadata` protobuf+base64 / thrift+zstd | Parquet 内嵌 vs Catalog 独立，按场景选 |
| 零拷贝 | `BufferSender` + `LinearBuffer::Slice` | 共享底层 buffer 避免 bytes 拷贝 |

## 模块间交互

`parquet_file` 被 `influxdb3_write`（`Persister::persist_parquet_file` 落盘）、`influxdb3_wal`（WAL 也用 object_store）、`influxdb3_query_executor`（`DataSourceExec` 读 Parquet）依赖。`object_store` 被 `serve.rs` 构造后通过 `Arc::clone` 共享给 Persister/WAL/QueryExecutor。`MemCachedObjectStore` 包装底层 store，查询读取时先查缓存；`influxdb3_cache/src/parquet_cache`（应用层 Oracle）则负责持久化时主动注册缓存（Immediate 模式）。`ObjectStoreHealth` 被 `/ready` 端点查询。

## 扩展方式

- **新增对象存储后端**：实现 `object_store::ObjectStore` trait（参考现有 S3/Azure 实现），在 `influxdb3_clap_blocks/src/object_store.rs` 加配置分支，`serve.rs` 构造处接入。
- **修改 Parquet 压缩**：`influxdb3_write/src/persister.rs:1010` 的 `WriterProperties` 调整 `compression`（当前 ZSTD）或其他属性。
- **调整 S3-FIFO 淘汰**：`core/object_store_mem_cache/src/cache_system/s3_fifo_cache/s3_fifo.rs` 的 `evict_from_small_queue`/`evict_from_main_queue` 修改驱逐条件与晋升逻辑（如改 freq 阈值）。
