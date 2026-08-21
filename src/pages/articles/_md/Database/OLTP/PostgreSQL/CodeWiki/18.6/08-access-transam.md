---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "访问方法与事务引擎"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "access", "transam", "WAL", "MVCC", "AM", "事务"]
description: "PostgreSQL access 模块——AM 可插拔抽象、heap_insert/HOT 优化、WAL 预写日志 XLogInsert/FPW、MVCC 多版本并发、两层事务状态机"
readingTime: "38 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`src/backend/access/` 是 PostgreSQL 最大的单一模块（~16.5 万行），承载两大职责：① 表/索引访问方法（AM）抽象与实现——heap 表操作、btree/gin/gist/brin/hash/spgist 等索引；② transam 事务引擎——WAL 预写日志、MVCC 多版本并发控制、事务管理、快照、CommitLog。WAL + MVCC 是 PostgreSQL ACID 的基石：WAL 保证 Durability + Atomicity（崩溃后 redo 恢复已提交事务），MVCC 保证 Isolation + Consistency（读不阻塞写）。

---

## 模块架构

子目录：`heap/`（堆表访问，`heapam.c` + `heapam_handler.c`）、`nbtree/`/`gin/`/`gist/`/`brin/`/`hash/`/`spgist/`（索引 AM）、`table/`（通用 table AM 接口 `tableam.c`）、`index/`（通用 index AM 接口 `indexam.c`）、`transam/`（`xlog.c` 10262 行 + `xact.c` 6505 行 + `xlogrecovery.c` + `snapmgr.c` + `varsup.c` + `clog.c` + `multixact.c`）、`common/`、`sequence/`、`tablesample/`、`rmgrdesc/`。

---

## 调用链路

写操作（INSERT）的完整路径，串起 AM→WAL→事务：

```
[executor] ModifyTable → ExecInsert
  → [access/heap/heapam.c:2081] heap_insert()
      1. heap_prepare_insert() 设 xmin/cid, 处理 TOAST
      2. RelationGetBufferForTuple() 找页
      3. CheckForSerializableConflictIn()   # SSI
      4. START_CRIT_SECTION()
      5. RelationPutHeapTuple() 写页
      6. MarkBufferDirty()
      7. XLogBeginInsert → XLogRegisterBuffer → XLogInsert(RM_HEAP_ID, info)  # WAL
      8. PageSetLSN()
      9. END_CRIT_SECTION() → CacheInvalidateHeapTuple()
  → 提交时 [transam/xact.c:2268] CommitTransaction()
      → RecordTransactionCommit()  # 写 WAL commit record + XLogFlush + clog
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `heap_insert` | 插入 tuple | 9 步含 WAL log |
| `heap_update` | 更新 tuple | HOT 优化免索引更新 |
| `table_tuple_insert` | table AM wrapper | 经函数指针间接调 heap |
| `XLogInsert` | 写 WAL record | 原子预留空间 |
| `XLogFlush` | WAL 刷盘 | 提交时保证落盘 |
| `GetSnapshotData` | MVCC 快照 | ProcArrayLock 下遍历 |
| `HeapTupleSatisfiesMVCC` | 可见性判定 | xmin/xmax + 快照 |
| `CommitTransaction` | 事务提交 | 写 commit WAL + 刷盘 + clog |

---

## 核心实现

### 访问方法（AM）抽象

**Table AM**（`tableam.h:321`）：`TableAmRoutine` 含 ~40 回调——`slot_callbacks`/`scan_begin`/`scan_getnextslot`/`tuple_insert`/`tuple_delete`/`tuple_update`/`tuple_lock`/`index_fetch_tuple`/`relation_set_new_filelocator`/`tuple_satisfies_snapshot` 等。调用经 inline wrapper 零开销：

```c
// src/include/access/tableam.h:1367
static inline void table_tuple_insert(Relation rel, TupleTableSlot *slot, ...) {
    rel->rd_tableam->tuple_insert(rel, slot, ...);  // 函数指针
}
```

heap 注册（`heapam_handler.c:2659`）：`heap_tableam_handler` 返回静态 const `heapam_methods`。默认 AM 经 `default_table_access_method` GUC（默认 "heap"）。

**Index AM**（`amapi.h:233`）：`IndexAmRoutine` 含 ~30 回调——`ambuild`/`aminsert`/`ambeginscan`/`amgettuple`/`amgetbitmap`/`ambulkdelete`/`amvacuumcleanup`/`amcostestimate` 等。`index_insert`（`indexam.c:213`）经 `rd_indam->aminsert` 间接。

AM 经 `pg_am` catalog（`pg_am.h:29`）注册：`amhandler` 字段指向 handler 函数（`bthandler`/`heap_tableam_handler`），relcache 打开关系时调 handler 获取 routine 指针存入 `Relation->rd_indam`/`rd_tableam`。为什么用 AM 抽象：存储引擎可插拔——新增列式/ZHeap 原地更新引擎只需实现回调 + 注册 `pg_am`，不改 executor/tcop。

### Heap 表访问

`heap_insert`（`heapam.c:2081`）9 步见调用链路。关键：`START_CRIT_SECTION` 后不允许出错（临界区），`XLogInsert` 在临界区内写 WAL，`PageSetLSN` 记页最后修改的 WAL 位置。

**HOT（Heap-Only Tuple）优化**（`heap_update` L4063-4089）——两个必要条件同时满足：①新 tuple 能放入同一页（`newbuf==buffer`）；②未修改任何索引列（`!bms_overlap(modified_attrs, hot_attrs)`）。满足则标 `HEAP_HOT_UPDATED`/`HEAP_ONLY_TUPLE`，旧 tuple `t_ctid` 指向新 tuple 形成 HOT 链，索引不指向新 tuple，executor 跳过索引维护（`*update_indexes = TU_None`）。VACUUM 时页内 prune 回收。HOT 避免每次 update 都更新所有索引的随机 I/O，性能可提升数倍。

`heap_scan` 两模式：`heapgettup`（逐 tuple 加 buffer lock）、`heapgettup_pagemode`（一次处理整页预计算可见 tuple 列表 `rs_vistuples[]`，减少 buffer lock）。

### B-tree 索引

`nbtree.c` 基于 Lehman-Yao 算法。`bthandler`（L118）注册 `IndexAmRoutine`：`amcanorder`/`amcanunique`/`amcanmulticol`/`amcanbackward`/`amcanparallel`。页面经 `_bt_split`/`_bt_insert` 维护平衡，支持 deduplication（`nbtdedup.c`）和 bottom-up deletion。WAL 由 `RM_BTREE_ID` rmgr 处理（`btree_xlog_*` 回调处理页面分裂的复杂恢复）。

### WAL 预写日志

WAL record 格式（`xlogrecord.h:41`）：固定头 `XLogRecord`（`xl_tot_len`/`xl_xid`/`xl_prev`/`xl_info`/`xl_rmid`/`xl_crc`）+ 可变块引用 + 可变数据。

**XLogInsert**（`xloginsert.c:474`）使用模式：`XLogBeginInsert` → `XLogRegisterBuffer`/`XLogRegisterData` → `XLogInsert(rmid, info)`。内部：`XLogRecordAssemble` 组装（含 FPI 判断）→ `XLogInsertRecord` 原子递增 `Insert->CurrBytePos` 预留空间 → `CopyXLogRecordToWAL` 复制到 WAL buffer。

**XLogFlush**（`xlog.c:2780`）：若 `record <= LogwrtResult.Flush` 已刷盘直接返回；否则 group commit 优化收集待写 → `WALWriteLock` → `XLogWrite` 写入 fsync。

**为什么 WAL 保证 durability**：严格 write-ahead——数据页修改前先 `XLogInsert` 写 WAL record；提交时 `RecordTransactionCommit`（`xact.c:1315`）调 `XLogFlush` 确保 commit record 落盘；数据页延迟写但 LSN 记录 WAL 位置，`FlushBuffer` 写页前先 `XLogFlush`。崩溃后 redo 回放恢复。

**Full-Page Writes（FPW）防页撕裂**（`xloginsert.c:685-693`）：checkpoint 后首次改页时 WAL 含整页镜像。判定 `needs_backup = (page_lsn <= RedoRecPtr)`——页 LSN ≤ 上次 checkpoint redo 起点，说明该页自 checkpoint 未被记录过。OS 写 8KB 页可能不原子（tearing），FPW 保证首次修改有完整镜像，回放 `XLogReadBufferForRedo` 返回 `BLK_RESTORED` 整页覆盖。代价是 WAL 体积增大，可 `full_page_writes=off` 或 `wal_compression` 调节。

**崩溃回放**：`StartupXLOG`（`xlog.c:5467`）→ `PerformWalRecovery`（`xlogrecovery.c:1680`）redo 循环逐条读 WAL record，按 `xl_rmid` 分发到各 rmgr 的 `rm_redo`（`rmgrlist.h` 注册 23 个内置 rmgr：`heap_redo`/`btree_redo`/`xact_redo`/`clog_redo` 等）。

### MVCC 多版本并发控制

每条 tuple header（`htup_details.h:153`）含 `t_xmin`（插入事务 ID）/`t_xmax`（删除/锁定事务 ID）/`t_cid`（命令 ID）。`t_infomask` 的 hint bits 缓存事务状态（`HEAP_XMIN_COMMITTED` 等），避免每次查 clog。

**GetSnapshotData**（`procarray.c:2175`）：`ProcArrayLock`（共享）下遍历 ProcArray 收集运行中事务，算 `xmin`（最小运行 XID，<xmin 一定已结束）、`xmax`（`latestCompletedXid+1`，>=xmax 一定未开始）、`xip[]`（xmin~xmax 间仍运行的事务，不可见）。`GetSnapshotDataReuse` 经 `xactCompletionCount` 比较跳过重建。

**HeapTupleSatisfiesMVCC**（`heapam_visibility.c:960`）：检查 xmin（插入事务）——`HEAP_XMIN_INVALID` 不可见、`XidInMVCCSnapshot(xmin,snapshot)` 不可见（快照中仍运行）、`TransactionIdDidCommit(xmin)` 设 hint bit 可见；检查 xmax（删除事务）——`HEAP_XMAX_INVALID` 可见、`XidInMVCCSnapshot` 可见（删除事务在快照中运行，视为未删）、`TransactionIdDidCommit(xmax)` 不可见。

**CommitLog（clog）**（`clog.c`）：每事务 2 bit 记提交状态（IN_PROGRESS/COMMITTED/ABORTED/SUB_COMMITTED），基于 SLRU，4 事务/字节。hint bit 是 clog 查询缓存——确认 commit/abort 后在 tuple header 设标记，后续零锁开销。

**为什么 MVCC 用多版本而非加锁**：读不阻塞写、写不阻塞读——读操作获取快照后只看可见版本，写操作创建新版本，只有写-写冲突才等待。牺牲存储空间（多版本）换取并发度，读多写少场景性能优势显著。

### 事务管理

两层状态机：

**低层 `TransState`**（`xact.c:143`）：`TRANS_DEFAULT`/`TRANS_START`/`TRANS_INPROGRESS`/`TRANS_COMMIT`/`TRANS_ABORT`/`TRANS_PREPARE`。

**高层 `TBlockState`**（`xact.c:159`，20 状态）：非事务块（`TBLOCK_DEFAULT`/`TBLOCK_STARTED`）、事务块（`TBLOCK_BEGIN`→`TBLOCK_INPROGRESS`→`TBLOCK_END`/`TBLOCK_ABORT`）、子事务（`TBLOCK_SUBBEGIN`→`TBLOCK_SUBINPROGRESS`→`TBLOCK_SUBRELEASE`/`TBLOCK_SUBABORT`）。

`CommitTransaction`（`xact.c:2268`）提交顺序：预提交（deferred trigger → `CallXactCallbacks(XACT_EVENT_PRE_COMMIT)` → ON COMMIT）→ 提交（`RecordTransactionCommit` 写 WAL + 刷盘 + clog → `ProcArrayEndTransaction`，不可回头点）→ 清理（释放 buffer pin → 缓存失效 → `AtEOXact_*`）。

**2PC**：`PrepareTransaction`（`xact.c:2557`）→ `MarkAsPreparing` → `StartPrepare`/`EndPrepare` 写 2PC state file → 从 ProcArray 移除。恢复时 `twophase.c` 读 state file 恢复 prepared 事务。

### 关键数据结构

`HeapTupleHeaderData`（`htup_details.h:153`）：`t_choice`（t_heap 含 xmin/xmax/cid 或 t_datum）、`t_ctid`（HOT 链）、`t_infomask2`（HOT 标志）、`t_infomask`（hint bits）。`SnapshotData`（`snapshot.h:138`）：`xmin`/`xmax`/`xip[]`/`subxip[]`/`curcid`/`snapXactCompletionCount`。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略模式 | `TableAmRoutine`/`IndexAmRoutine` + `pg_am` | 存储引擎可插拔 |
| Write-Ahead Logging | `XLogInsert` 先于数据页 | durability + 崩溃恢复 |
| 多版本并发 | xmin/xmax + 快照 | 读不阻塞写 |
| Hint bits 缓存 | `t_infomask` | 避免高频 clog 查询锁争用 |
| 两层状态机 | TransState + TBlockState | 低层原子状态 vs 高层事务块语义分离 |

### 为什么 WAL + MVCC 是 ACID 基石

**WAL 保证 Durability + Atomicity**：提交时 WAL commit record 必须落盘（`XLogFlush` in `RecordTransactionCommit`）。崩溃后 redo 恢复已提交、回滚未提交（clog abort 标记）。数据页延迟写不影响正确性——只要 WAL 完整。

**MVCC 保证 Isolation + Consistency**：每事务见一致快照（`GetSnapshotData`），不见未提交修改。读不阻塞写（多版本），写不阻塞读（快照隔离）。

### HOT 优化为什么重要

无 HOT 时每次 UPDATE 都更新所有索引（即使索引列未变），代价随索引数线性增长。HOT 满足条件时（同页+无索引列变更）标记 HOT 链，executor 跳过索引维护（`TU_None`），避免随机 I/O，UPDATE 性能提升数倍。

### FPW 的取舍

防 OS 部分页写撕裂（8KB 页可能不原子写）。代价是每个 checkpoint 周期每页首次修改多写 8KB。可用 `wal_compression` 压缩 FPI 缓解。

---

## 模块间交互

access 依赖 `storage`（buffer/lock/smgr）、`catalog`（`pg_am`/relcache/syscache）、`utils`（快照/内存/GUC/pgstat）。被 `executor`（`table_tuple_insert`/`index_insert`/`table_beginscan` wrapper）、`tcop`（`StartTransactionCommand`/`CommitTransactionCommand`）、`autovacuum`（`relation_vacuum` 回调）、`replication/walsender`（读 WAL stream）调用。

---

## 扩展方式

**新增索引 AM**（如向量索引）：新建 `access/myindex/` 实现 `IndexAmRoutine` 回调 → `CREATE ACCESS METHOD myindex TYPE INDEX HANDLER ...` 注册 `pg_am` → 需自定义 WAL 时 `rmgrlist.h` 加 `PG_RMGR(RM_MYINDEX_ID,...)` + 实现 `myindex_redo`。

**新增 Table AM**（如列式）：实现 `TableAmRoutine` 回调 → `CREATE ACCESS METHOD columnar TYPE TABLE HANDLER ...` → `CREATE TABLE ... USING columnar` → 实现自定义 WAL 或用 `RM_HEAP_ID`/`RM_GENERIC_ID` 框架。

**修改 WAL 记录格式**：`heapam_xlog.h` 改记录结构 → `heapam.c` 写入端改 `XLogRegisterData` 大小 → `heapam_xlog.c heap_redo` 改回放解析 → 考虑 pg_upgrade/跨版本复制兼容，可能 bump `XLOG_PAGE_MAGIC` → 更新 `heap_desc` 使 `pg_waldump` 正确解析。
