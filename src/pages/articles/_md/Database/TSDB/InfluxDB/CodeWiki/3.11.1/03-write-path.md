---
source:
  type: "源码解读"
  project: "InfluxDB"
  url: "https://github.com/influxdata/influxdb"
title: "写入路径"
date: "2026-08-20T13:07:26+08:00"
category: [Database, TSDB, InfluxDB, CodeWiki, "3.11.1"]
tags: ["InfluxDB", "Rust", "TSDB"]
description: "InfluxDB 3 Core 写入路径：Line Protocol 解析 → WriteValidator 校验建表 → WriteBatch → WAL → TableBuffer 内存缓冲"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/00-overview)

---

## 模块定位

写入路径负责把 Line Protocol 文本转化为持久化的 Parquet 文件与可查询的内存缓冲。本模块涵盖 `influxdb3_write`（`WriteBuffer`/`TableBuffer`/`Persister`）+ `core/influxdb_line_protocol`（解析器）+ `core/mutable_batch`（列式内存格式，非生产路径）。核心职责是**schema-on-write**：每次写入都可能触发新表/新列创建，需与 catalog 事务协调。边界：从 HTTP `write_lp` 进入到 WAL 持久化 + 内存缓冲为止，Parquet 落盘由 WAL snapshot 触发（见 [WAL 与缓存](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/04-wal-cache)）。

> **重要修正**：生产写入路径**不使用** `MutableBatch`。经代码验证，生产路径是 `LP → ParsedLine → QualifiedLine/Row → WriteBatch → TableBuffer（Arrow builders）`。`MutableBatch` 是并行的列式格式，仅用于测试与 protobuf 编解码。

## 模块架构

模块按数据流切分：**解析层**（`line_protocol::parse_lines` 用 nom 组合子，零拷贝 `EscapedStr`）→ **校验层**（`WriteValidator<State>` 类型状态机，开启 catalog 事务、自动建表建列）→ **缓冲层**（`TableBuffer` 按 `chunk_time` 分桶的 `MutableTableChunk`，直接用 Arrow builders）→ **持久化层**（`Persister` 调 ArrowWriter+ZSTD 写 Parquet）。`WriteBufferImpl`（`write_buffer/mod.rs:170`）是 `WriteBuffer`/`Bufferer`/`ChunkContainer`/`DistinctCacheManager`/`LastCacheManager` 五 trait 的组合实现。

## 调用链路

```
LP 文本: "cpu,host=A val=42i 1234567890"
  ├─ parse_lines()  [line_protocol/src/lib.rs:580]  → ParsedLine{series,field_set,timestamp}
  ├─ WriteValidator::initialize()  [validator.rs:102]  → catalog.begin(db_name) 事务
  ├─ v1_parse_lines_and_catalog_updates()  [validator.rs:124]
  │    └─ validate_and_qualify_v1_line() → table_or_create / column_or_create → QualifiedLine
  ├─ commit_catalog_changes()  [validator.rs:339]  → catalog.commit(txn) → Prompt::Success/Retry
  ├─ convert_lines_to_buffer()  [validator.rs:410]  ★ 转换 god node
  │    └─ chunk_time = gen1_duration.chunk_time_for_timestamp(row.time)
  │    └─ table_chunks.push_row(chunk_time, row) → WriteBatch
  ├─ wal.write_ops(vec![WalOp::Write(write_batch)])  [write_buffer/mod.rs:550]
  │    └─ WAL 缓冲，按 flush_interval 持久化（见 WAL 模块）
  └─ [WAL notify 回调] QueryableBuffer::buffer_wal_contents()  [queryable_buffer.rs:155]
       ├─ write_wal_contents_to_caches()  → 更新 last/distinct cache
       └─ BufferState::add_write_batch()  [queryable_buffer.rs:530]
            └─ TableBuffer::buffer_chunk() → MutableTableChunk::add_rows() (Arrow builders)
  [WAL snapshot 时] sort_dedupe_persist()  [queryable_buffer.rs:578]
    └─ ReorgPlanner::compact_plan() 去重+排序 → Persister::persist_parquet_file()  [persister.rs:924]
         └─ serialize_to_parquet (ArrowWriter + ZSTD) → object_store.put_adaptive()
```

<details>
<summary>方法速查表</summary>

| 方法名 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `parse_lines` in `line_protocol/lib.rs:580` | nom 解析 Line Protocol | `EscapedStr::SingleSlice` 零拷贝 |
| `WriteValidator::initialize` in `validator.rs:102` | 开启 catalog 事务 | 类型状态机 |
| `commit_catalog_changes` in `validator.rs:339` | 提交事务 | `Prompt::Retry` 乐观并发重试 |
| `convert_lines_to_buffer` in `validator.rs:410` | 行式→分组 WriteBatch | chunk_time 分桶 |
| `add_write_batch` in `queryable_buffer.rs:530` | WAL 数据入内存缓冲 | 按 ColumnId 索引 Arrow builder |
| `sort_dedupe_persist` in `queryable_buffer.rs:578` | snapshot 时落盘 | 去重取最后值+排序 |
| `persist_parquet_file` in `persister.rs:924` | 写 Parquet | ZSTD + 100K row group |

</details>

## 核心实现

### WriteValidator 类型状态机

`validator.rs:82` 的 `WriteValidator<State>` 用泛型参数编码状态机 `Initialized → LinesParsed → CatalogChangesCommitted`。每个状态只能调用该状态特有方法（`v1_parse_lines_and_catalog_updates` 只在 `Initialized` 可用），编译期保证调用顺序正确，运行时零开销。`commit_catalog_changes` 返回 `Prompt::Success(seq)` 或 `Prompt::Retry`——后者表示 catalog 已被并发修改前进，调用方（如 `create_table_opts`）在 `loop` 中重建事务重试。

### chunk_time 分区与 Gen1Duration

`convert_qualified_line`（`validator.rs:448`）用 `gen1_duration.chunk_time_for_timestamp(row.time)` 计算分区键。`Gen1Duration` 默认 600 秒（10 分钟，`lib.rs:240`），将时间戳对齐到分桶边界。10 分钟粒度平衡了写入吞吐与查询裁剪：太细则小文件过多，太粗则无法有效按时间范围过滤。`chunk_time` 作为 `TableBuffer` 的 `BTreeMap` 键，支持按时间范围快速裁剪；`ParquetFile` 记录 `chunk_time`，查询时用于文件级裁剪；同一 chunk_time 的数据最终落盘为一个 Parquet 文件。

### TableBuffer 用 Arrow builders 而非 MutableBatch

生产路径选择 `TableBuffer`（直接操作 Arrow `Float64Builder`/`Int64Builder`/`StringDictionaryBuilder` 等）而非 `MutableBatch`（自定义 `Vec<f64>` 列式）。原因：MutableBatch 需要最终转换为 Arrow `ArrayRef`（二次转换开销），而 TableBuffer 直接构建 Arrow builder，零转换；TableBuffer 按 `ColumnId`（BTreeMap）索引，与 catalog 的列 ID 体系直接对接；内置 `string_bytes_per_column` 跟踪，单列超过 `ARROW_VAR_COL_MAX_BYTES` 自动切分新 chunk，避免单 Arrow array 过大。`table_buffer.rs:300` 的检查保证变长列不溢出。

### Persister 与 Parquet 落盘

Parquet 落盘由 WAL snapshot 触发（非定时器）：WAL 完成 flush 后若到 snapshot 边界，调 `WalFileNotifier::notify_and_snapshot` → `QueryableBuffer` 缓冲数据到 `TableBuffer` 同时 `TableBuffer::snapshot(table_def, end_time_marker)` 移出旧 chunk → 每个 `SnapshotChunk` 创建 `PersistJob`，`tokio::spawn` 并发执行 `sort_dedupe_persist` → `ReorgPlanner::compact_plan()` 去重（同 timestamp 取最后值）+排序 → `Persister::persist_parquet_file` 用 ArrowWriter+ZSTD 写入 object store。`persister.rs:1005` 的 `ROW_GROUP_WRITE_SIZE=100000` 控制 row group 大小。并发数由 `parquet_snapshot_concurrency_limit` 信号量限制。补充：`check_mem_and_force_snapshot_loop` 定期检查 buffer 大小，超 `memory_threshold_bytes` 强制 `wal.force_flush_buffer()` 触发 snapshot。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `Bufferer` trait `lib.rs:69` + `WriteBufferImpl` | 抽象写入缓冲，允许测试 mock |
| 类型状态 | `WriteValidator<State>` `validator.rs:82` | 编译期保证流程顺序 |
| RAII 回滚 | `mutable_batch::Writer` `writer.rs:45` | Drop 时若未 commit 自动回滚到 initial rows |
| 观察者 | `WalFileNotifier` `queryable_buffer.rs:487` | WAL 持久化后异步通知缓冲与缓存 |
| 模板方法 | `Bufferer::write_internal_lp` 默认实现 `lib.rs:84` | 委托给 `write_lp` 传 `INTERNAL_DB_NAME` |

## 模块间交互

写入路径与 WAL：`wal.write_ops` 缓冲数据，WAL 持久化后回调 `WalFileNotifier::notify` 触发 `QueryableBuffer` 缓冲。与 Catalog：`catalog.begin(db_name)` 开事务，`txn.table_or_create`/`column_or_create` 自动建表建列，`catalog.commit` 返回 `CatalogSequenceNumber`，`Prompt::Retry` 时重试。与 Cache：`buffer_wal_contents` 先 `write_wal_contents_to_caches` 更新 last/distinct cache，再入内存 buffer。`MutableBatch` 与生产路径的关系：仅 `mutable_batch_lp`（LP→MutableBatch，测试用）与 `mutable_batch_pb`（protobuf 编解码）使用，共享的是 `line_protocol::parse_lines` 解析器。

## 扩展方式

- **新增写入格式（如 JSON）**：新建解析器 crate 产出 `ParsedLine` 等价结构；`validator.rs` 加等价方法或泛化 `WriteValidator`；WAL 与 buffer 层格式无关（`WriteBatch{Row{fields}}`），无需改。
- **修改分区策略**：`lib.rs:240` 改 `Gen1Duration::default()`；`validator.rs:448` 改 `chunk_time` 计算（若引入非时间维度分区需改 `TableBuffer` 键类型）；风险：破坏与已持久化 Parquet 的 `chunk_time` 兼容性。
- **修改去重策略**：`queryable_buffer.rs:578` 的 `sort_dedupe_persist` 替换 `ReorgPlanner::compact_plan`；`persister.rs:1010` 调整 `WriterProperties`（压缩算法/row group 大小）。
