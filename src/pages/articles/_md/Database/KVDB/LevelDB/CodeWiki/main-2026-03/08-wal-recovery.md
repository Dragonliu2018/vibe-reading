---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "WAL 与恢复"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "WAL", "Crash Recovery", "日志格式"]
description: "WAL 分块日志格式与崩溃恢复全流程：32KB 物理块、四类记录分片、crc32c 定位损坏、DBImpl::Recover 三段式、Repairer 终极重建。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/00-overview)

---

## 模块定位

WAL（write-ahead log，文件后缀 `.log`）是 LevelDB 的崩溃一致性支柱：写路径先落它再改 memtable（见 [01 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/01-write-path)），崩溃后重启**重放它找回未落盘的写入**。本模块覆盖三块：格式与读写器（`db/log_format.h` + `db/log_writer.cc` + `db/log_reader.cc`）、恢复编排（`DBImpl::Recover/RecoverLogFile` in `db/db_impl.cc`）、兜底修复（`db/repair.cc` 的 `Repairer`）。`doc/log_format.md` 是官方格式文档，注释与代码互证。

这个格式还有第二用途：**MANIFEST 也是它**（`descriptor_log_` 是 `log::Writer`，`VersionEdit` 记录经 `AddRecord` 追加）——一套分块日志编码服务 WAL 与元数据两条线（见 [02 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/02-version-manifest)）。

## 模块架构

物理格式（32KB 定长块，块内变长记录）：

```
┌──────────── 32KB 物理块 ────────────┐   ┌──────── 下一个 32KB 块 ────────┐
│ [crc32c 4B][len 2B][type 1B][data…] │   │ …                             │
│ [record]…[record]…[trailer ≤6B 全零] │   │ 尾块可以是部分块               │
└─────────────────────────────────────┘
type: FULL=1（整条在此块）/ FIRST=2 / MIDDLE=3 / LAST=4（跨块分片）
```

逻辑记录（一条 `WriteBatch` 编码）大于块内剩余空间时被**物理分片**：FIRST 起头、MIDDLE 续中、LAST 收尾。三个不变量：记录头永不在距块尾 <7B 处开始（放不下就填零 trailer 跳块）；恰好剩 7 字节时**写一条零长 FIRST 记录**占位（writer 与 reader 都有针对这个历史 bug 的处理，`log_reader.cc:110` 的注释直呼 "bug in earlier versions of log::Writer"）；每条物理记录的 crc32c 覆盖 type+data。

## 调用链路

```
写: log::Writer::AddRecord(slice)              log_writer.cc:44
 ├─ 循环分片：leftover < kHeaderSize(7) → 填零 trailer 跳新块
 ├─ avail = 32KB - offset - 7; fragment = min(left, avail)
 ├─ type = begin&&end ? FULL : begin ? FIRST : end ? LAST : MIDDLE
 └─ EmitPhysicalRecord                          log_writer.cc:87
      ├─ type_crc_[t] 预计算种子 + crc32c::Extend(data) + Mask
      └─ header(7B) + payload 追加 → dest_->Flush()

恢复: DBImpl::Recover(edit, save_manifest)     db_impl.cc:292   [见概览启动流程]
 └─ 对每个 ≥ LogNumber() 的 log（升序）:
    RecoverLogFile(log_number, last_log, …)    db_impl.cc:385
     ├─ log::Reader(file, &reporter, checksum=true, initial_offset=0)
     ├─ while ReadRecord(&record, &scratch):
     │    ├─ <12B → Corruption("log record too small") 跳过
     │    ├─ WriteBatchInternal::SetContents + InsertInto(mem)  ← 与写入共用重放器
     │    └─ mem > write_buffer_size → WriteLevel0Table 落盘（可多次）
     └─ reuse_logs && last_log && 未触发落盘 → NewAppendableFile 续写旧 log
        （mem 保留为 mem_：Chrome 的快速重启场景）

兜底: RepairDB(dbname, options) → Repairer     db/repair.cc
 ├─ FindFiles：目录扫描分拣 log/表/manifest
 ├─ ConvertLogFilesToTables：log 逐个重放成 L0 表
 ├─ ExtractMetaData：逐表扫描取 smallest/largest/最大 seq
 └─ WriteDescriptor：全部表记 L0、next_file = max+1、写新 MANIFEST
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `log::Writer::AddRecord` in `db/log_writer.cc:44` | 逻辑记录分片追加 | 块边界三不变量 |
| `log::Writer::EmitPhysicalRecord` in `db/log_writer.cc:87` | 物理记录成型 | type_crc_ 预计算省一次 crc 启动 |
| `log::Reader::ReadRecord` in `db/log_reader.cc:56` | 逻辑记录重组 | resync/坏记录跳块恢复 |
| `log::Reader::ReadPhysicalRecord` in `db/log_reader.cc:189` | 物理记录解析 | crc/长度双重校验 |
| `DBImpl::Recover` in `db/db_impl.cc:292` | 恢复总编排 | 缺文件即 Corruption 拒开 |
| `DBImpl::RecoverLogFile` in `db/db_impl.cc:385` | 单 log 重放 | 与写入共用 InsertInto |
| `VersionSet::Recover` in `db/version_set.cc:861` | MANIFEST 重放 | 见 02 篇 |
| `Repairer::Run` in `db/repair.cc:80` | 无 MANIFEST 重建 | 见下 |
</details>

## 核心实现

### 分块日志的取舍：为什么不是"一条一追加"

`doc/log_format.md` 尾部 "Some benefits over the recordio format" 三条道破设计：**免启发式重同步**——损坏时跳到下一块边界即可（块定长 32KB，位置永远可算）；**读放大有界**——reader 的缓冲区就是块大小，随机恢复点（`initial_offset`）可以按块跳过；**写放大有界**——trailer 至多浪费 6 字节。代价是 FULL/FIRST/MIDDLE/LAST 的分片状态机，但这状态机总共 40 行。

`Writer` 构造函数的第二个版本 `Writer(dest, dest_length)`（`log_writer.cc:33`）是 reuse_logs 的配套——**从文件中段续写**：`block_offset_ = dest_length % kBlockSize` 对齐到当前块位置，旧数据不重写。

### Reader：损坏定位与块级跳越

`ReadPhysicalRecord`（`log_reader.cc:189`）的双重校验：长度越界（`kHeaderSize + length > block`）与 crc 不符都返回 `kBadRecord` 并 `ReportCorruption`。上层 `ReadRecord` 的重组状态机里，`kBadRecord` 的处理是**丢弃当前半成品、继续下一条**——分片序列一旦中间损坏，整个逻辑记录作废（半条记录重放等于改写历史，宁可丢整条）。`initial_offset` 场景有**双重跳过**：构造时先 `SkipToInitialBlock`（`log_reader.cc`，整块整块地跳到目标块）；进入正读后 `resyncing_` 模式先跳过 MIDDLE、等到 LAST 对齐再收记录——从日志中段开始读（如按 offset 续传）不会把半条别人的记录当成自己的。

**损坏报告是可降级的**：`RecoverLogFile` 里 `reporter.status` 只在 `paranoid_checks` 时非空（`db_impl.cc:388-392`）——普通模式记日志继续跑，paranoid 模式传播错误拒开库。但 checksum 本身**永远开启**（注释：故意如此，防坏数据带出畸形 sequence 污染版本水位）。

`Reader` 对几类"看起来坏了"的尾部情形**不报 Corruption 而静默当 EOF**（`ReadPhysicalRecord` 与 `ReadRecord` 的分支）：文件尾部截断的记录头（块内剩余不足 7B 或读到 EOF）——正常崩溃时写者可能写到一半，缺的不是损坏是没写完；`kZeroType` 零长记录——**预分配文件**的未写区域，类型 0 专门为它保留（`log_format.h` 注释 "Zero is reserved for preallocated files"）；payload 不完整的 kFirst/kMiddle 孤儿分片——写者中途死亡的自然残迹，ReadRecord 会给上一条半成品报一次 "partial record without end" 后丢弃。`AddRecord` 对空 Slice 也有明确行为：`do-while` 循环保证**仍发一条零长 FULL 记录**（`log_writer.cc:47-49` 注释）——写"什么都没有"也是一次合法的写。

### Recover：三段式与"哪些 log 该重放"

`DBImpl::Recover`（`db_impl.cc:292`）决定重放集的判据是 `min_log = versions_->LogNumber()`：**MANIFEST 记录了"哪个 log 之前的已全部落盘"**（`CompactMemTable` 提交时 `edit.SetLogNumber(logfile_number_)`），只有编号 ≥ 它的（外加兼容老格式的 `PrevLogNumber()`）才含未落盘数据。重放完每个 log 后调 `versions_->MarkFileNumberUsed(log_number)`（`db_impl.cc:381`）——把日志文件号计入已用号段，**防止文件号分配器发出与现存 log 重号的文件**（上一代进程可能分配了号但没来得及写进 MANIFEST）。目录里出现 MANIFEST 未登记的表文件则直接 `Corruption`（`db_impl.cc:356` 的 missing files 检查）——**宁可拒开不静默丢数据**。

`RecoverLogFile` 的重放循环复用写入侧的 `WriteBatchInternal::InsertInto`（`db/write_batch.cc` 的 `MemTableInserter`）——**恢复不是特殊代码路径，而是写入路径的重放**，这是 crash-safe 最强的论证方式：两条路径不可能不一致。重放中 mem 超 4MB 就地 `WriteLevel0Table`（`db_impl.cc:455`），大 log 恢复不会撑爆内存。

### Repairer：当 MANIFEST 本身坏了

`RepairDB`（公共 API，`db/repair.cc`）的哲学写在文件头注释：**放弃全部元数据，从数据文件反推**。四步（`Repairer::Run`）：日志先转表（`ConvertLogToTable`——它创建 `log::Reader` 时 **checksum=false**，`repair.cc:418`，修复场景宽容优先，能捞多少捞多少）；逐表全扫取 `[smallest, largest]` 与最大 sequence；全部表塞 L0、`next_file = 最大文件号 + 1`、`last_sequence = 全局最大 seq`、**`edit_.SetLogNumber(0)`**（`repair.cc:364`，所有旧 log 已转换或归档，没有可重放的了）；写新 MANIFEST。被替换的旧 MANIFEST 不删除而是**归档进 `dbname/lost/` 目录**（`ArchiveFile`，`repair.cc:408`：rename 到同级 `lost/` 子目录）——修复失败还能回来翻。注释里两条 "Possible optimization"（按表序重分层、meta 块存边界）留了 15 年没做——**正确但粗糙**是这个兜底路径的自觉。代价是空间（全部 L0 重新压实要时间），收益是"只要 .ldb 还在就能救回数据"。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| 分片状态机 | `db/log_writer.cc:44` `AddRecord` | 定长块内装变长记录的通用解 |
| 重放即写入 | `db/db_impl.cc:385` `RecoverLogFile` 复用 `InsertInto` | 消除写/恢复双实现分歧 |
| 可降级错误 | `db/db_impl.cc:385` `LogReporter` | paranoid 开关换严格度 |
| Builder（重建） | `db/repair.cc:80` `Repairer::Run` | 从数据反推元数据的最小充分集 |
| 委托复用 | `db/version_set.cc` `descriptor_log_` 是 `log::Writer` | 一套日志格式两条产品线 |

## 模块间交互

上游：写入路径（`log_->AddRecord` 每组一次）、版本管理（MANIFEST 记录复用同一编码器）。下游：恢复时产出 `VersionEdit`（新增 L0 文件）与 memtable（重放结果），经 `WriteLevel0Table`→`BuildTable` 落成 SSTable（依赖 [05 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/05-sstable-format)）；`filename.cc` 的 `ParseFileName` 在恢复时担任文件分拣（`kLogFile/kTableFile/kDescriptorFile/...` 七种类型）。`Env`（[09 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/09-env-ecosystem)）提供 `NewSequentialFile/NewAppendableFile`——`NewAppendableFile` 是 reuse_logs 的关键依赖，`Env` 基类默认返回 `NotSupported`，**日志续写是 Env 的可选能力**，不支持时优雅退回换新 log。

## 扩展方式

- **加记录类型**（如 batch 的时间戳/校验摘要）：`RecordType` 枚举尾部加值，老 reader 跳过未知类型（格式文档预留的演进语义："Some Readers may skip record types they do not understand"）
- **改块大小**：`kBlockSize` in `db/log_format.h:23`——读写同改，旧库兼容性由恢复时按当前代码解释决定，需评估跨版本升级路径
- **日志复用策略**：`Options::reuse_logs` 已有开关，`RecoverLogFile` 尾部的续写分支是全部逻辑
- 对应测试：`db/log_test.cc`（15.5K——读写对拍、分片边界、损坏注入全覆盖）、`db/recovery_test.cc`、`db/corruption_test.cc`（截断/翻转字节的恢复行为断言）
