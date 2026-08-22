---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Storage"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Storage", "Columnar", "MVCC", "WAL"]
description: "DuckDB Storage 模块——列式段存储 + BufferManager 多级淘汰 + MVCC UndoBuffer + WAL/Checkpoint 持久化。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Storage 模块（含 Transaction 子模块）负责 DuckDB 的持久化存储、内存缓冲管理和事务隔离。它采用列式段存储架构——每列数据由 `ColumnSegment` 链表组成，每个段绑定一种压缩算法；写入时数据先进入 TRANSIENT 段（内存、未压缩），Checkpoint 时压缩落盘为 PERSISTENT 段。MVCC 通过 `UndoBuffer` 记录旧值实现，WAL + Checkpoint 保证持久性。

## 模块架构

![DuckDB 列式存储分层架构](/vibe-reading/images/articles/duckdb-internals/storage-layered.svg)

存储层次从上到下：`StorageManager`（入口/生命周期）→ `BufferManager` + `BufferPool`（内存管理/淘汰）→ `DataTable`（表级管理）→ `RowGroupCollection` → `RowGroup`（行组，默认 122880 行）→ `ColumnData`（列数据，按 LogicalType 分派子类）→ `ColumnSegment`（段，压缩单元）→ `BlockHandle` → `BlockMemory` → `FileBuffer`（底层内存）。右侧是事务与持久化：`DuckTransactionManager` → `DuckTransaction` + `UndoBuffer` → `WriteAheadLog` → `CheckpointManager`。

`CompressionFunction` 采用策略模式——每个 `ColumnSegment` 绑定一个 `CompressionFunction`，通过函数指针表调用（`init_scan`/`scan_vector`/`append`/`finalize_analyze` 等）。新增压缩算法只需注册新的 `CompressionFunction`，不需修改 `ColumnSegment`。

## 调用链路

### 数据写入路径

```
DataTable::Append(chunk, state)                       [data_table.cpp:1200]
  → RowGroupCollection::Append(chunk, state)
    → RowGroup::Append(state, chunk, append_count)
      → ColumnData::Append(state, vector, count)      [column_data.cpp:374]
        → ColumnSegment::Append(state, data, offset, count)  [column_segment.cpp:190]
             → function.get().append(*state, *this, stats, data, offset, count)
             — 调用 CompressionFunction::append
        [段满时] ColumnData::AppendTransientSegment()  [column_data.cpp:606]
             → BufferManager::RegisterTransientMemory(segment_size)
             — 分配新 TRANSIENT 段，默认 UNCOMPRESSED
```

### 读取路径

```
DataTable::Scan(transaction, result, state)            [data_table.cpp:301]
  → RowGroupCollection scan → RowGroup::Scan
    → ColumnData::Scan(transaction, vector_index, state, result)  [column_data.cpp:317]
      → ColumnSegment::InitializeScan(state)
           → function.get().init_scan(context, *this)
      → ColumnSegment::Scan(state, scan_count, result, ...)  [column_segment.cpp:108]
           → function.get().scan_vector(*this, state, scan_count, result)
           — 调用 CompressionFunction::scan_vector 解压读取
      → FetchUpdates(transaction, ...)  — 合并 MVCC 更新
  → LocalStorage::Scan(state.local_state, ...)  — 扫描事务本地数据
```

### 事务提交路径

```
DuckTransactionManager::CommitTransaction(context, transaction)  [duck_transaction_manager.cpp:317]
  1. CanCheckpoint(transaction, lock, undo_properties)  — 判断是否需要 auto-checkpoint
  2. [if should_write_to_wal]:
     t_lock.unlock()  — 释放事务锁，允许只读并行
     transaction.WriteToWAL(context, db, commit_state)  [duck_transaction.cpp:215]
       → undo_buffer.WriteToWAL(*wal, commit_state)  — 遍历 undo entries 写 WAL
       → block_manager.FileSync()  — 刷盘
     t_lock.lock()
  3. GetCommitTimestamp()
  4. transaction.Commit(db, info, commit_state)
     → undo_buffer.Commit(iterator_state, commit_info)  — 正序遍历设 commit_id
  5. CleanupTransactions()  — 清理已完成事务的 undo buffer
  6. [if can_checkpoint]: storage_manager.CreateCheckpoint()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `DataTable::Append` | 数据追加 | 先写 TRANSIENT 段（内存），Checkpoint 时压缩落盘 |
| `DataTable::Scan` | 数据扫描 | 同时扫持久化段和事务本地数据 |
| `ColumnSegment::Append` | 段级追加 | 通过 CompressionFunction 函数指针间接调用 |
| `ColumnSegment::Scan` | 段级扫描 | scan_vector 或 scan_partial，按需解压 |
| `BufferPool::EvictBlocks` | 内存淘汰 | 多级 EvictionQueue 近似 LRU |
| `UndoBuffer::Commit` | 提交 undo | 正序遍历设 commit_id |
| `UndoBuffer::Rollback` | 回滚 undo | 逆序遍历恢复旧值 |
| `WriteAheadLog::WriteInsert` | WAL 写入 | BufferedFileWriter，WAL 锁与事务锁分离 |
| `SingleFileStorageManager::CreateCheckpoint` | Checkpoint | 遍历 catalog 压缩落盘 + 截断 WAL |

</details>

## 核心实现

### ColumnData 的段式设计

每列数据由 `ColumnSegmentTree` 管理的 `ColumnSegment` 链表组成。段大小受 `Storage::BLOCK_SIZE`（默认 256KB）限制，与 BufferManager 块大小对齐——一个段对应一个 `BlockHandle`。段有 TRANSIENT（内存、UNCOMPRESSED，快速写入）和 PERSISTENT（磁盘、已压缩，减少 I/O 和存储空间）两种状态。`ColumnData::CreateColumn`（`column_data.cpp:1207`）按 LogicalType 分派子类：`StandardColumnData`/`StructColumnData`/`ListColumnData`/`ArrayColumnData`/`ValidityColumnData`/`GeoColumnData`/`VariantColumnData`。

每个段有 `SegmentStatistics`（min/max/null count），用于 zone map 过滤（`ColumnData::CheckZonemap`，`column_data.cpp:430`）——扫描时跳过不满足过滤条件的段。

### BufferManager 多级淘汰队列

`BufferPool` 维护多个 `EvictionQueue`（基于 moodycamel ConcurrentQueue），按 `FileBufferType` 分类。`Unpin` 时将 reader=0 的块加入 eviction queue，`EvictBlocks` 从队列头部遍历调用 `BlockMemory::CanUnload` 判断可否淘汰。被淘汰的块如果 `DestroyBufferUpon::BLOCK` 则写入临时文件（`BlockMemory::UnloadAndTakeBlock`），否则直接销毁。内存统计有 per-CPU cache 优化（`MemoryUsage`），避免频繁原子操作。

DuckDB 使用 **read/write 而非 mmap**——`SingleFileBlockManager` 通过 `FileBuffer::Read`/`Write` 进行 I/O，每个块写入前计算 checksum 并存入块头，读取后验证。

### MVCC UndoBuffer 实现

DuckDB 的 MVCC **不复制新版本，记录旧版本**——更新/删除时将旧数据写入 `UndoBuffer`，新数据直接原地写入。这减少了写放大。`UndoBuffer` 基于 `BufferManager` 分配内存，每个 entry = `UndoFlags`（类型：INSERT_TUPLE/DELETE_TUPLE/UPDATE_TUPLE/CATALOG_ENTRY）+ 长度 + payload。Commit 正序遍历设 commit_id，Rollback 逆序遍历恢复旧值。提交后事务进入 `recently_committed_transactions`，等所有活跃事务的 `start_time > commit_id` 后才 `Cleanup` 清理 undo buffer。`cleanup_queue` 保证清理顺序有序。

### WAL + Checkpoint 机制

WAL 保证持久性——提交前先写 WAL（`BufferedFileWriter`），WAL 锁与事务锁分离（允许只读事务并行）。Auto-checkpoint 由 WAL 条目计数和 undo buffer 估算大小触发。支持全量（`FULL_CHECKPOINT`）和增量（`INCREMENTAL_CHECKPOINT`）两种。**乐观写入（Optimistic Write）**：大数据量 append 时可以跳过 WAL 直接写 RowGroup 到磁盘，WAL 中只记录引用（`WriteRowGroupData`），减少 WAL 体积。

Checkpoint 流程：获取 exclusive checkpoint lock → 阻止新事务 → `SingleFileCheckpointWriter` 遍历 catalog entries 序列化 → 每个 `DataTable` 通过 `TableDataWriter` 写入 RowGroup 数据 → `ColumnData::Checkpoint` 压缩落盘 → 写新 header → 截断 WAL。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 分层存储 | StorageManager→BlockManager→BufferManager→DataTable→ColumnData→ColumnSegment | 每层职责清晰，可独立替换 |
| 段+压缩（策略） | `ColumnSegment` + `CompressionFunction` | 按段选最优压缩，新增算法不改上层 |
| Copy-on-Write（MVCC） | `UndoBuffer` 记录旧值 | 不复制新版本，减少写放大 |
| 职责链 | WAL → Checkpoint | 先 WAL 保证持久性，再 Checkpoint 刷盘截断 |

## 模块间交互

Execution 的 scan 算子通过 `DataTable::InitializeScan` + `DataTable::Scan` 读取数据；写入算子通过 `DataTable::Append`/`Delete`/`Update` 写入。Catalog 的 `TableCatalogEntry` 通过 `GetStorage()` 返回 `DataTable`。Transaction 为 Storage 提供 MVCC 支持——`DuckTransaction` 持有 `UndoBuffer` 和 `LocalStorage`（事务本地数据）。Parallel 模块的 `PipelineExecutor` 构造时用 `BufferAllocator::Get(context.client)` 初始化 intermediate chunks，`TaskScheduler::ExecuteForever` 中集成内存刷新逻辑（线程空闲 0.5s 后触发 `ThreadFlush` 归还缓冲内存）。

## 扩展方式

新增一种压缩算法：`src/storage/compression/new_algo.cpp` 实现 `CompressionFunction` 的全部函数指针（`init_analyze`/`analyze`/`finalize_analyze`/`init_segment`/`init_scan`/`scan_vector`/`scan_partial`/`fetch_row`/`init_append`/`append`/`finalize_append`/`skip`/`select`/`filter`...） → `src/include/duckdb/common/enums/compression_type.hpp` 添加枚举 → 注册到 `CompressionFunctionSet`。`ColumnSegment` 无需修改——通过函数指针表间接调用。

新增一种存储后端：继承 `BlockManager` 实现 `Read`/`Write`/`ReadBlocks`/`WriteHeader` → 继承 `StorageManager` 实现 `Initialize`/`CreateCheckpoint` → 通过 `StorageExtension` 注册。参考 `SingleFileBlockManager`（`single_file_block_manager.cpp:1121-1147`）。
