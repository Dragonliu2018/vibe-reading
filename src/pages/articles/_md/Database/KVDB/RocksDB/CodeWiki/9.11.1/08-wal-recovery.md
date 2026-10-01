---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "WAL 与恢复"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "WAL", "Crash Recovery"]
description: "32KB 分段 WAL 格式与 CRC、DB Open 的 MANIFEST+WAL 回放链、四档 WALRecoveryMode、ErrorHandler 的 severity 分级与自动恢复、WAL in MANIFEST 的链式校验。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

WAL 模块回答一个问题：**崩溃后数据从哪里来**。涉及 `db/log_writer.cc/h`（物理写）、`db/log_reader.cc`（1070 行，恢复读）、`db/wal_manager.cc`（目录级管理与归档）、`db/wal_edit.cc/h`（WAL 元数据进 MANIFEST）、`db/logs_with_prep_tracker.cc`（2PC WAL 保留）、`db/db_impl/db_impl_open.cc`（2651 行的 Recover 链）、`db/error_handler.cc`（840 行错误分级）。

## 模块架构

```
写侧（leader 在写管线中，见 01-write-path）
  log::Writer::AddRecord
    32KB block 分段：剩余放不下 header → 填 0 trailer 换块
    每段 EmitPhysicalRecord：[4B CRC][2B len][1B type](+4B log#)
    type ∈ Full/First/Middle/Last（recyclable 变体 5-8 带 log number）

恢复（DB::Open → Recover）
  CURRENT → MANIFEST 回放（VersionEditHandler）→ 各 CF log_number
  → 列 wal_dir → WalSet::CheckWals 对账（track_and_verify_wals_in_manifest）
  → 逐 WAL：log::Reader::ReadRecord（CRC 校验）
      → WriteBatch::InsertInto 进 memtable
      → 写满即 WriteLevel0TableForRecovery 直接落 L0
  → edit->SetLogNumber(max_wal+1)（下次 open 跳过已恢复段）

错误处理（ErrorHandler）
  SetBGError 四路分派 → severity 五级（Soft/Hard/Fatal/Unrecoverable）
  → auto recovery（recovery_thread 轮询）/ manual（ResumeImpl 强制 flush）
```

## 调用链路

```
DBImpl::Open（db_impl_open.cc:2319）
├─ ValidateOptions → new DBImpl
├─ Recover（:418）
│   ├─ env_->LockFile(LOCK)（进程独占）
│   ├─ 新库走 NewDB；best_efforts_recovery 绕过 CURRENT 扫非空 MANIFEST
│   ├─ versions_->Recover()：读 CURRENT（manifest_ops.cc:13）
│   │   → log::Reader 逐条 edit.DecodeFrom → builder->Apply（delta）
│   │   → 末尾一次性 SaveTo 落初始 Version
│   ├─ 列 wal_dir → track_and_verify_wals_in_manifest 时
│   │   WalSet::CheckWals（wal_edit.cc:169）：MANIFEST 记录的 synced WAL
│   │   必须在盘上存在且 file_size ≥ synced_size，否则 Corruption
│   └─ RecoverLogFiles（:1135）
│       ├─ min_wal_number = MinLogNumberToKeep()，非 2PC 抬到
│       │   MinLogNumberWithUnflushedData()（跳过已刷过的 WAL）
│       ├─ 逐 WAL ProcessLogFile（:1227）
│       │   ├─ InitializeLogReader：即使 paranoid=false 也强制 checksum
│       │   │   （防坏数据如超大 sequence 传播，:1403 注释）
│       │   ├─ ReadRecord → ProcessLogRecord（:1415）
│       │   │   InsertInto（write_batch.cc:2207：log_number < cf log_number
│       │   │   时丢弃——该 CF 已 flush 过此 log，防双重应用）
│       │   └─ MaybeWriteLevel0TableForRecovery：memtable 写满
│       │       → WriteLevel0TableForRecovery（:1942，直接 dump L0，
│       │         assert imm 为空——open 期单线程无需 imm 并发机器）
│       └─ MaybeFlushFinalMemtableOrRestoreActiveLogFiles（:1758）
│           默认：flush 最终 memtable + edit->SetLogNumber(max+1)
│           + MarkFileNumberUsed(max_wal_number+1)（提前占住新 WAL 号，
│             防 NewFileNumber 再发出同号）
│           avoid_flush_during_recovery：RestoreAliveLogFiles 保活旧 WAL
├─ 新建 WAL + dummy batch（corruption 后给 seq 连续性留锚点，:2428）
├─ LogAndApplyForRecovery：恢复期 edit 一次性原子提交
└─ DeleteObsoleteFiles + MaybeScheduleFlushOrCompaction
```

## 核心实现

### 32KB 分段格式

```text title="db/log_format.h:54-61"
+---------+-----------+-----------+--- ... ---+
|CRC (4B) | Size (2B) | Type (1B) | Payload   |   ← kHeaderSize = 7
+---------+-----------+-----------+--- ... ---+
recyclable 变体在 Type 后加 4B log number    ← kRecyclableHeaderSize = 11
```

`kBlockSize = 32768`（LevelDB 遗产值）。可确证的收益：(a) **torn write 的爆炸半径被限制在块内**——CRC 失败时丢弃 buffer 余量、下一块边界重新同步（`log_reader.cc:626` 注释明言不信任可能损坏的 length："信任它会找到恰好合法的假 record"）；(b) header 的 2B length 只需覆盖块内可用空间；(c) reader 以块为单位对齐缓冲读。注意：**"32KB = 原子写边界"的说法在仓库内无证据**（grep `atomic|torn` 全模块无命中）——RocksDB 自身只把 32KB 当 resync 粒度而非原子性承诺，这正是每 record 带 CRC 的原因。`recycle_log_files_` 复用 WAL 文件省 preallocate/delete 开销，但残留旧数据需要 header 多 4B log number 区分新旧 record（`:330` 注释：只编码低 32 位，~40 亿个 log 才可能误判）。

### 四档 WALRecoveryMode

`kTolerateCorruptedTailRecords`（默认，容忍尾部损坏）→ `kAbsoluteConsistency`（干净关机，见错即报）→ `kPointInTimeRecovery`（损坏即停回放，回退到一致时间点）→ `kSkipAnyCorruptedRecords`（跳过继续，可能产生空洞）。分派集中在 `log_reader.cc:241-340` 与 `HandleNonOkStatusOrOldLogRecord`（`db_impl_open.cc:1617`）。前向兼容：`kRecordTypeSafeIgnoreMask = 1<<7`——第 8 位置 1 的未知 type 被旧版本静默忽略，新增元数据 record（UDT size、PredecessorWALInfo）不破坏旧二进制。

### 恢复期"跳过 immutable 队列"直接转 L0

**纠正一个常见误解——并非"跳过 memtable"**：WAL record 先插 memtable，写满才触发转储；但转储路径确实跳过 imm 队列（`WriteLevel0TableForRecovery` 直接 dump 活跃 memtable 并 assert imm 为空）。Why：(a) open 期单线程无 client 访问，不需要 imm/后台 flush 的并发机器；(b) flush 后 `edit->SetLogNumber(max+1)` 一次性落 MANIFEST——**下次 open 直接跳过整段回放**；(c) 反向取舍 `avoid_flush_during_recovery=true` 保留 WAL 续写，避免大 DB open 时巨型 flush；2PC 强制 flush 模式（相邻 WAL 的 seq 可能不连续使恢复复杂）。

### WAL in MANIFEST：为什么与版本归属

`track_and_verify_wals_in_manifest` 引入于 **6.16.0**（HISTORY.md:1590，非传闻的 9.7+）；9.11.0 新增替代品 `track_and_verify_wals`。动机（`options.h:620` 注释）：record CRC 只能发现 record 损坏，**发现不了整个 WAL 文件丢失/被截短**（文件系统级丢失已 sync 数据）。机制：closed WAL sync 时写 `WalAddition(number, synced_size)` 进 VersionEdit；open 时 `WalSet::CheckWals` 比对磁盘。**只追踪已关闭的 WAL**（live WAL 不追踪——曾试过被 revert）。新方案改在每个 WAL 头写 `kPredecessorWALInfoType` record（前一 WAL 的 number/size/last_seqno），恢复时链式对账——能发现"WAL hole"。

### ErrorHandler：severity 五级与恢复

`SetBGError`（`error_handler.cc:383`）四路分派：非文件作用域数据丢失直接 `kUnrecoverableError`；`manual_wal_flush` 下 WAL 相关 IO 失败 → `kFatalError` **禁自动恢复**（buffered WAL 写失败导致 memtable/WAL 不一致，单 CF flush 会放大成 CF 间不一致）；retryable/file-scope IO → `kHardError` 起恢复线程（最多 `max_bgerror_resume_count` 次轮询 `ResumeImpl`）；其余走 `HandleKnownErrors`（`:271`）——**三级查表**：`ErrorSeverityMap`（reason+code+subcode+paranoid 四元组）→ `DefaultErrorSeverityMap` → `DefaultReasonMap`。severity ≥ Hard → `is_db_stopped_` → 写路径 `PreprocessWrite` 首查拒绝写入。**manual 恢复的 `ResumeImpl` 强制 flush 全部 CF**——"We cannot guarantee consistency of the WAL. So force flush Memtables of all the column families"（`db_impl.cc:404` 注释）。NoSpace 错误委托 `SstFileManagerImpl::StartErrorRecovery` 轮询磁盘。

### LogsWithPrepTracker：双结构双锁

```cpp title="db/logs_with_prep_tracker.h:40-60"
std::vector<LogCnt> logs_with_prep_;            // 有序，prepare 线程写
std::unordered_map<uint64_t, uint64_t> prepared_section_completed_;  // commit 线程写
```

双结构双锁是刻意的（`:46-58` 注释）：prepare 线程只碰前者，commit/rollback 线程只碰后者，读侧 `FindMinLogContainingOutstandingPrep()` 惰性对账——**含未完成 prepare 的 WAL 即使 memtable 已 flush 也不能删**，这是 2PC 场景 WAL 保留决策的全部逻辑。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 分段日志 + CRC | `log_writer.cc:112` 的 AddRecord 循环 | torn write 边界恢复 |
| 模板方法 | `VersionEditHandlerBase::Iterate` 派生四 handler | 回放逻辑复用 |
| 双结构分锁 | `LogsWithPrepTracker` | prepare/commit 线程互不争锁 |
| 前向兼容掩码 | `kRecordTypeSafeIgnoreMask` | 新 record 类型不破坏旧二进制 |
| 优雅降级 | dummy batch 锚点（`db_impl_open.cc:2437`） | corruption 后保 seq 连续性 |

## 模块间交互

**write_thread**：leader 一次 `AddRecord` 成帧全组；`MarkLogsSynced` → `WalAddition` 落 MANIFEST。**memtable**：回放插入走 `column_family_memtables_`；按 log_number 过滤已 flush 数据。**version_set**：新 WAL 号取自 `NewFileNumber`；恢复完 `SetLogNumber(max+1)`；滚动 MANIFEST 时 dump 全部 `wals_`。**2PC**：`MarkLogAsContainingPrepSection`/`HavingPrepSectionFlushed` 维护 tracker；`SwitchWAL` 用其结果决定最老 WAL 能否释放。

## 扩展方式

**新增 WAL record type**（历史上反复发生：压缩类型/UDT size/PredecessorWALInfo 都走这条路）：`log_format.h` 枚举 + `kRecordTypeSafeIgnoreMask` 兼容位 → `log_writer.cc`（Add 方法 + EmitPhysicalRecord 分发）→ `log_reader.cc`（ReadRecord 新 case + bypass 列表）→ `db_impl_open.cc`（构造参数与传参）。`kPredecessorWALInfoType` 是完整范本。

**调整恢复档位**：`WALRecoveryMode` 语义边界（`MaybeReviseStopReplayForCorruption` 的 seq 连续性启发式，`:1544`）、`best_efforts_recovery`、`avoid_flush_during_recovery`、WAL 压缩（`AddCompressionTypeRecord` 必须是文件第一条 record）。

**ErrorHandler 分级调整**：`ErrorSeverityMap` 增条目、auto-resume 参数（`max_bgerror_resume_count`/`bgerror_resume_retry_interval`）、WAL 相关错误禁自动恢复的策略（`:420-438`）。
