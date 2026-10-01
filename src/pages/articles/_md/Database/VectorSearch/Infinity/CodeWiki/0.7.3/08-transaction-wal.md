---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "事务系统"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 事务系统解读：2025 年 RocksDB 重写的 NewTxn、乐观表级冲突检测、Top/Bottom 两半提交、WAL 单线程组提交与 BottomExecutor 分区并行 Apply、三层 MVCC 版本化与快照隔离"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/storage/new_txn/`（~1.7 万行）+ `src/storage/wal/` 是 Infinity 的事务与日志层，也是理解这个数据库的**核心**——存储引擎的其余部分（catalog/列存/索引）都被它的事务语义穿透。

先回答"为什么叫 new_txn"。git 证据链：

- **2025-05-06** PR #2553 "Add rocksdb as the meta storage"——首次引入 `src/storage/new_txn/` 目录；
- 旧系统是 `src/storage/txn/` 的 `class Txn` + 内存 Catalog 对象树（`TableEntry/SegmentEntry` + `CatalogDeltaEntry/AddDeltaEntryTask`），**需要把内存 catalog 的 delta 序列化同步到磁盘，是出了名的复杂点**；
- **2025-06-23** PR #2722 "Removed TableEntry, SegmentEntry and etc." 删除旧 `src/storage/txn/`；
- 后续 `fd33bffe2 "MVCC Refactor: db, table, index, column, segment (#2745)"` 完成 KV 版本键化。

所以 new = "元数据进 RocksDB、以 begin_ts 比较 KV 版本键实现 MVCC、用 txn store 做冲突检测与 WAL 生成"的事务系统；命名 `NewTxn/NewFlush/GetReplayEntries`（区别旧 `Flush`）皆源于此。事务模型是**乐观表级冲突检测 + Top/Bottom 两半提交 + WAL 单线程组提交**的快照隔离（SI）实现。

---

## 模块架构

```text
src/storage/new_txn/
├── new_txn.cppm (39KB)             NewTxn 接口：Commit/PrepareCommit/CommitBottom/Replay...
├── new_txn_impl.cpp (265KB)        上半部/下半部的巨型 switch（按 WalCommandType）
├── new_txn_data_impl.cpp (100KB)   DML：Append/Delete/Update 的暂存与 Apply
├── new_txn_index_impl.cpp (140KB)  索引操作：append/dump/optimize
├── new_txn_manager.cppm/_impl      NewTxnManager：ts 分配/冲突检测/有序发布
├── base_txn_store.cppm/_impl       24 个 BaseTxnStore 子类（写暂存）
├── txn_state.cppm                   7 态状态机 + 31 个 TransactionType
├── txn_allocator.cppm/_impl        单线程行区间分配器
└── txn_context.cppm                txn_id/begin_ts/commit_ts/state 集中地
src/storage/wal/
├── wal_entry.cppm/_impl (37KB+107KB) WalCommandType 枚举 + WalCmd 命令层次
├── wal_manager.cppm/_impl          单写者 flush 线程 + replay + checkpoint
├── bottom_executor.cppm/_impl      分区有序的下半部执行器
└── log_file.cppm/_impl            wal.log 文件抽象
```

`NewTxn` 的注释（`new_txn.cppm:170-177`）就是架构总纲：

```cpp
// NewTxn steps:
// 1. CreateTxn
// 2. Begin
// 3. Commit() / Rollback
// 3.1 PrepareCommit  - multiple thread   ← 上半部
// 3.2 WriteWAL       - single threads     ← WAL 组提交
// 3.3 PrepareWriteData - single thread
// 3.4 Commit         - multiple threads  ← 下半部
```

---

## 调用链路

![写事务提交管线](/vibe-reading/images/articles/infinity-internals/txn-commit.svg)

一次 DML 事务的完整生命周期：

```text
Begin → 暂存 → Commit{取号 → 冲突检测 → 行区间分配 → PrepareCommit(生成 WAL)
       → SendToWAL → [flush 线程] WAL 序列化落盘 → BottomExecutor 分发
       → [bottom 线程] CommitBottomAppend(写数据+版本+mem index)
       → RocksDB 提交 → NotifyTopHalf → PostCommit}
```

关键步骤（函数名 → 位置）：

1. **Begin**：`BeginTxnShared`（`new_txn_manager_impl.cpp:101`）持锁取 `begin_ts = current_ts_ + 1`；构造 `NewTxn`（构造函数即 `make_shared<WalEntry>()` + 从 `kv_store_->GetInstance()` 取 RocksDB 事务）；checkpoint/cleanup 类型用 `ckp_begin_ts_` 做单实例互斥。
2. **暂存**：`NewTxn::Append`（`new_txn_data_impl.cpp:457`）建 `AppendTxnStore`，`input_block_` 存入暂存，`row_ranges_` 留空（"will be populated after conflict check"）；此阶段**不写任何真身**。
3. **取号**：`GetWriteCommitTS`（manager:207）`prepare_commit_ts_ += 2`——**每个写事务占两个 ts 槽位**；登记进 `wait_conflict_ck_`/`check_txn_map_`/`bottom_txns_` 三张按 commit_ts 排序的 map。
4. **冲突检测**：`CheckConflict1` → `CheckConflictTxnStores`（`new_txn_impl.cpp:4556`）按 store 类型分发到 24 个重载之一。**表级粗粒度**：前一个事务若是同表的 `kCreateIndex/kDropIndex` → conflict 且可重试；`kDropTable/kRenameTable` → conflict 且不可重试。无行级/页级锁。
5. **行区间分配**：`TxnAllocator::Process`（`txn_allocator_impl.cpp:56`）**单线程**执行 `system_cache_->PrepareAppend` 算出 `row_ranges_`——集中分配消除 append 空间竞争。
6. **上半部 PrepareCommit**（`new_txn_impl.cpp:2171`）：`wal_entry_ = base_txn_store_->ToWalEntry(commit_ts)`（日志由暂存确定性生成），然后按 WalCommandType switch——DDL/import/compact/checkpoint 各调 `PrepareCommitXxx` 写 RocksDB 元数据；**APPEND_V2 是 no-op**（数据推迟到下半部）。
7. **SendToWAL 保序**（manager:280）：`wait_conflict_ck_` 闸门弹出**连续非空前缀**批量提交给 WAL，保证进入 WAL 队列的顺序严格等于 commit_ts 顺序。
8. **WAL 落盘**：`WalManager::NewFlush`（`wal_manager_impl.cpp:249`，独立 flush 线程）批量取 → 逐 txn 校验状态 kCommitting → `GetSizeInBytes` 预估 → `WriteAdv` 序列化（断言预估==实际）→ `ofs_.write` + `UpdateCommitState`；leader 节点额外 `PrepareLogs/SyncLogs` 同步复制；整批写完后 `bottom_executor_->Submit(txn)`。
9. **下半部**：`BottomExecutor::Submit`（`bottom_executor_impl.cpp:73`）按 `CRC32(table_id_str) % N` 选队列——**同表事务永远同队列串行，跨表并行**。worker 调 `CommitBottom`（`new_txn_impl.cpp:4566`）遍历 cmds：`CommitBottomAppend`（`new_txn_data_impl.cpp:1786`）按 row_ranges 对齐 block 边界 → `AppendInBlock`（持 `BlockLock` 写锁）→ `AppendInColumn`（经 buffer manager 写 .col）+ `BlockVersion::Append` → `AppendMemIndex` 插内存索引（段满则 seal + 投递 DumpMemIndexTask）。
10. **可见性发布**：`NewTxnManager::CommitBottom`（manager:410）在 `bottom_txns_` 上**循环弹出队头所有已完成事务**，逐个推 `current_ts_`——可见性时间线只在全部更小 commit_ts 的 bottom 完成后才推进，防止乱序可见；然后 `NotifyTopHalf` → `CommitKVInstance`（提交 RocksDB 事务 + 失效 MetaCache）→ 唤醒 `Commit()` 里等在 `commit_cv_` 的上半部 → `PostCommit` → `SetTxnCommitted`。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `NewTxnManager::BeginTxnShared` | `new_txn_manager_impl.cpp:101` | begin_ts 分配 + 登记三张 map |
| `NewTxn::Append` | `new_txn_data_impl.cpp:457` | 暂存进 AppendTxnStore |
| `NewTxn::Commit` | `new_txn_impl.cpp:2037` | 提交主流程，等 commit_cv_ |
| `NewTxnManager::GetWriteCommitTS` | `new_txn_manager_impl.cpp:207` | commit_ts 占 2 槽 |
| `NewTxnManager::CheckConflict1` | `new_txn_manager_impl.cpp:222` | 候选裁剪 + 分发 |
| `NewTxn::CheckConflictTxnStores` | `new_txn_impl.cpp:4556` | 24 个重载的表级比较 |
| `TxnAllocator::Process` | `txn_allocator_impl.cpp:56` | 单线程行区间分配 |
| `NewTxn::PrepareCommit` | `new_txn_impl.cpp:2171` | 上半部巨型 switch |
| `NewTxnManager::SendToWAL` | `new_txn_manager_impl.cpp:280` | 有序闸门 |
| `WalManager::NewFlush` | `wal_manager_impl.cpp:249` | 单写者组提交 |
| `BottomExecutor::Submit` | `bottom_executor_impl.cpp:73` | CRC32 分队列 |
| `NewTxn::CommitBottom` | `new_txn_impl.cpp:4566` | 下半部巨型 switch |
| `NewTxnManager::CommitBottom` | `new_txn_manager_impl.cpp:410` | 可见性有序发布 |
| `WalManager::GetReplayEntries` | `wal_manager_impl.cpp:588` | 三阶段启动恢复 |

</details>

---

## 核心实现

### MVCC：三层版本化

**(a) catalog 层——KV 版本键**。同一逻辑 key 写多版本（key 尾部编码 commit_ts，如 `catalog|tbl|{db}|{name}|{commit_ts}`），读时取 `commit_ts <= begin_ts` 的最大者；删除写 `drop|` tombstone。无 undo log——旧版本靠 KV 保留，由 `Cleanup` 事务按 `min(oldest_begin, last_ckp)` 水位回收。判定代码（`table_meta_impl.cpp:142-148`）：

```cpp
for (size_t i = 0; i < index_kvs.size(); ++i) {
    TxnTimeStamp commit_ts = GetTimestampFromKey(index_kvs[i].first);  // ts 编码在 key 尾
    if ((commit_ts <= begin_ts_ || (txn_ != nullptr && txn_->IsReplay() && commit_ts == commit_ts_))
        && commit_ts > max_commit_ts) { max_commit_ts = commit_ts; ... }  // 取 <= begin_ts 的最大版本
}
// tombstone：DropTableIndexKey 的 drop_ts <= begin_ts 则不可见
```

**(b) 数据层——BlockVersion 版本文件**（`block_version.cppm:36`）：

```cpp
export struct BlockVersion {
    std::vector<CreateField> created_{};      // (create_ts, 累计行数) 有序数组
    std::vector<TxnTimeStamp> deleted_{};     // 每行 offset 的 delete_ts（0=未删）
};
```

行可见 = `created_ts <= begin_ts`（`GetRowCount` 二分）且 `deleted_ts == 0 || deleted_ts > begin_ts`。Append 在下半部 `block_version->Append(commit_ts, 行末)`；Delete 写 `Delete(offset, commit_ts)`，回滚用 `undo_delete_state` + `RollbackDelete`。

**(c) ts 编号规则**。写事务 `prepare_commit_ts_ += 2`（奇偶区分）；`current_ts_`（已发布可见 ts）只在 `bottom_txns_` 队头**连续完成**时才推进——这就是可见性发布点。`GetOldestAliveTS()` = `begin_txn_map_.begin()` 即 GC 水位。**隔离级别是快照隔离**——未见写偏序（write skew）防护，冲突只到表级（`CheckConflictTxnStore` 各重载只比较 db/table/index 名字符串，待核实是否存在更细粒度检测）。

### WAL：单写者 + 命令模式

`WalEntry` 是物理单位 = 一个事务：`WalEntryHeader{size, crc32, txn_id, commit_ts}` + `cmds_`。`WalCommandType` 枚举带 V2 后缀（CREATE_TABLE_V2=10、APPEND_V2=24、CHECKPOINT_V2=104、CLEANUP=108 等——历史编号不连续）。`WalCmd` 是命令模式基类：`GetSizeInBytes/WriteAdv/ToCachedMeta` 三件套 + `ReadAdv` 反序列化工厂。**new_wait_flush_ 队列的注释就是设计**："Concurrent writing WAL is disallowed. So put all WAL writing into a queue and do serial writing"。

### 启动恢复：三阶段 replay

`GetReplayEntries`（`wal_manager_impl.cpp:588`，源码有 ASCII 图）：**phase 1** 从新到旧反向遍历 `wal.log` + 历史 `wal.log.<max_commit_ts>`，找最近 CHECKPOINT_V2 取 `max_checkpoint_ts`；**phase 2** 继续反向收集所有 `commit_ts > max_checkpoint_ts` 的 entry（checkpoint 之前的已持久化在 RocksDB/数据文件）；reverse 恢复正序；**phase 3** 逐 entry `BeginReplayTxn`（begin_ts = commit_ts - 1）→ `ReplayWalCmd`（多数 Replay* 直接复用 PrepareCommit*，Append 复用 CommitBottomAppend，`IsReplay()` 分支跳过缓存更新）→ `CommitReplay`。坏 entry 用 crc 校验失败即截断。集群 follower 的 `FlushLogByReplication` 复用同一套 replay 通道。

### 为什么 WAL 有 BottomExecutor

WAL 写必须全局有序（恢复正确性）→ flush 单线程；但数据 Apply（写列文件、插 HNSW/倒排 mem index）耗时且**不同表天然无共享**。`BottomExecutor` 把事务哈希到固定队列：同表串行（保数据文件与 mem index 一致性）、跨表并行（吞吐）；而**可见性与 RocksDB 提交不乱序**——`CommitBottom` 在 `bottom_txns_` 上按 commit_ts 有序推进。这是"日志全局序 + Apply 分区并行 + 提交发布全局序"的解耦，Kafka partition 式的有序性模型。

### Checkpoint 与 Cleanup

checkpoint 的内容出乎意料地薄：`CheckpointTxnStore` → 把 `BlockVersion` 按 checkpoint_ts 截断刷盘 → **`kv_store_->Flush()`（RocksDB 刷盘）——catalog 的 checkpoint 就是 RocksDB 快照**。WAL 轮转在 flush 线程遇 checkpoint 事务时先 `SwapWalFile`，保证"最近 checkpoint 必在当前 wal.log 可见"。`Cleanup` 事务（`new_txn_impl.cpp:5167`）按 `visible_ts = min(GetOldestAliveTS(), LastCheckpointTS())` 找出早于水位的 tombstone，删 KV + 物理文件，写 `WalCmdCleanup`。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Top/Bottom 两半提交（改进 2PC） | `new_txn.cppm:170-177` 注释 + `commit_cv_` | 协调者是 commit_ts 全序而非传统 prepare/vote |
| 状态机 | `txn_state.cppm:23`（7 态，非法迁移 UnrecoverableError） | 事务生命周期显式化 |
| 命令模式 | `WalCmd` 层次 + `ReadAdv` 工厂 | PrepareCommit/CommitBottom/Replay/ToCachedMeta 四处多态分发 |
| 写暂存 Staging | `BaseTxnStore::ToWalEntry` | 数据、WAL、Apply 从同一份暂存派生——redo 幂等 |
| 分区有序（Kafka 式） | `new_wait_flush_` + `CRC32(table_id) % N` | 全局单序 + 表内有序表间并行 |
| 单写者原则 | `ofs_` 仅 flush 线程触碰 | WAL 并发写的禁区 |
| 集中分配器 | `TxnAllocator` 单线程 | append 空间分配去锁化 |
| 有序发布闸门 | `wait_conflict_ck_`/`bottom_txns_` 前缀连续才放行 | commit_ts 全序的两个关键点 |

---

## 模块间交互

- **catalog**：所有目录访问经 Meta 句柄（构造时携带 `NewTxn*`，用 `kv_instance()` + `BeginTS()` 做版本读）；写路径的元数据进 RocksDB 事务，`CommitKVInstance` 统一提交。两层缓存（MetaCache/SystemCache）在提交时精确失效。
- **buffer manager**：`AppendInColumn` 经 `GetColumnVector(kReadWrite)` 拿列 buffer；`BlockVersion` 挂 block 的 version buffer；`BlockLock`（shared_mutex + min/max ts）是块级并发锚点。
- **索引**：`CommitBottomAppend → AppendMemIndex` 在提交下半部把新行插入 MemIndex（HNSW/倒排/IVF 按类型分发）。**可见性靠 BlockVersion 时间戳在查询侧过滤**——"索引先写、可见性后判"，这就是 HNSW 边写边查的实现方式。
- **集群**：leader 在 `NewFlush` 中 `PrepareLogs/SyncLogs`；follower 用 `FlushLogByReplication` 把收到的日志写入本地 WAL（在线 catalog 应用 `ApplySyncedLogNolock` 在 v0.7.3 是空壳，复制链路属半成品）。
- **persistence manager**：Import 回滚 `pm->Cleanup(file_name)`；checkpoint `pm->CurrentObjFinalize`。

---

## 扩展方式

**新增一种 WalCmd 类型**（8 处，以 `WalCmdCleanup` 为完整先例）：`wal_entry.cppm` 的 `WalCommandType` 加枚举（历史编号不连续，选未用号）→ WalCmd 区加 struct + 序列化三件套 → **`WalCmd::ReadAdv` 反序列化 switch 加 case**（漏掉则重启 replay 报 UNKNOWN）→ `PrepareCommit` 上半部 case → `CommitBottom` 下半部 case（若涉及数据）→ `ReplayWalCmd` replay case → `base_txn_store` 新 store 类 → 可选 UpdateCatalogCache/冲突重载。

**修改 fsync 策略**：`WalManager::NewFlush` 的 `FlushOptionType` 分支（`wal_manager_impl.cpp:329-342`）——注意两处 FIXME 表明 kOnlyWrite/kFlushPerSecond 未真正实现差异化，实际都 flush。
