---
source:
  type: "源码解读"
  project: "yugabyte-db"
  url: "https://github.com/yugabyte/yugabyte-db"
title: "DocDB 存储抽象"
date: "2026-09-23T00:42:00+08:00"
category: [Database, HTAP, YugabyteDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["YugabyteDB", "C++", "DocDB", "MVCC", "HybridTime", "分布式事务", "Wait-on-Conflict", "dockv"]
description: "YugabyteDB DocDB 存储抽象解读——intent/regular 是两个独立 RocksDB 实例而非 CF、DocHybridTime 反序编码进键尾、intent 键内嵌时间使双库直接字典序合并、strong/weak 两级意图复刻 PG 四级行锁、Wait-on-Conflict 全解"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`src/yb/dockv/`（23k 行，2023-04 从 docdb 拆出的**纯编码层**，无 RocksDB 依赖）+ `src/yb/docdb/`（63k 行，读写路径/事务/compaction）。god node：IntentAwareIterator 97 度、DocWriteBatch 66、ConflictResolver 64。**先澄清一个关键架构事实**：intent/regular **不是 column family**——是每个 tablet 两个独立打开的 RocksDB 实例（`struct DocDB`，key_bounds.h:62：`rocksdb::DB* regular; rocksdb::DB* intents;`），intents 开在子目录 `intents` 且**只有事务表才打开**（`Tablet::OpenIntentsDB`，tablet.cc:1336）。

## 模块架构

### 文档模型（dockv 层）

**DocKey**（`src/yb/dockv/doc_key.h:120`）四段编码：`[kTableId/kColocationId 前缀] + [kUInt16Hash + 16-bit hash + hashed 组] + range 组 + kGroupEnd`。排序不变量刻进类型字节（`kGroupEnd('!')=33 < kHybridTime('#')=35 < kNullLow('$')=36`）——保证"子键少的键排前"，MVCC 时间戳永远在键尾。**YSQL 行映射**：PK 前若干 hash 列 → hashed 组（Jenkins 变种 `Hash64StringWithSeed(compound, 97)` 64 位折叠 16 位——**这个 hash 同时就是 tablet 路由的 partition key**），其余 → range 组。Colocated 表共享一个 tablet 靠 DocKey 前缀区分。

**值编码**：控制字段前缀 `[kMergeFlags][kHybridTime][kTtl][kUserTimestamp]` + 值体（首字节 ValueEntryType）。**Packed row**（YSQL 整行一 KV）：`kPackedRowV1('z')`，varint schema_version + 列偏移表 + 列数据，配 `SchemaPacking` O(1) 按列取值。

### MVCC 的键编码核心技巧

**DocHybridTime** = HybridTime + 32-bit `IntraTxnWriteId`（区分同事务同键多次写）。编码（`doc_hybrid_time.cc:39`）用降序 varint：**时间越新键序越靠前**——RocksDB 升序迭代先见最新版本，seek 即落最新版；末字节低 3 位存总编码长度，`DecodeFromEnd` 从键尾 O(1) 回解。

## 核心实现

### 写路径：intents 先行

`WriteQuery::DoExecute`（write_query.cc:860-1010）四步：`PrepareDocWriteOperation`（生成意图集 + 内存锁 LockBatch，per-tablet `SharedLockManager`）→ `ResolveTransactionConflicts` → `AssembleDocWriteBatch` → Raft 复制后各副本 apply。

**DocWriteBatch 边写边读**（不是 RocksDB batch 薄封装）：沿 DocPath 逐层下探，经 IntentAwareIterator 读当前状态，产出键**不含 hybrid time** 的 SubDocKey + 值——**HT 不走 Raft**（省带宽；HT 在追加 Raft log 时才确定，rocksdb_writer.cc:188 注释）。

**`TransactionalWriter::Apply`**（rocksdb_writer.cc:295）对每个键经 `dockv::EnumerateIntents` 展开为：一条 **strong intent**（全键）+ 若干 **weak intent**（祖先前缀，`ShouldTakeWeakLockForPrefix`，lock_util.cc:233），每条写两记录：

- intent：`SubDocKey(无HT) + kIntentTypeSet + kHybridTime + 反序DocHT → txn_id + write_id + 值`
- **reverse index**：`kTransactionId + txn_id + 反序DocHT → intent 键本身`——commit 时 apply 靠扫这个反索引定位全部 intent

**intent 键里嵌 value_time（反序编码）使 regular/intent 两库可直接字典序合并**——这是整个格式设计的核心巧妙处：读路径免"合并-排序"步骤，纯 seek+compare。

**Apply（commit 后）**：`ApplyIntentsTask`（给大事务的后台任务，每轮最多 100000 条、续传点存 `kTransactionApplyState` 记录崩溃后重启续传）→ 扫反索引 → 找回 intent → **以 commit_ht 重写键**进 regular DB（值头嵌入 intent 原写时间供 compaction TTL）→ SingleDelete intent 与反索引。abort 走 `CleanupIntentsTask` 纯删不 apply。

### 读路径：双迭代器合并

**IntentAwareIterator**（intent_aware_iterator.h:47）持两个子迭代器。构造顺序强制"intents 先建"（intent_aware_iterator.cc:210 长注释：否则会读到"值消失"）。合并规则（`ProcessIntent`，:852）：只认 strong write intent；他事务的 value_time = **commit HT**（经 TransactionStatusCache：先查本地 participant，未命中 RPC 到 status tablet）；可见性上界 `MaxAllowedValueTime`（intent_format.h:39）：本事务用 in_txn_limit、intent 写入时间 > local_limit 用 read、否则 global_limit（可能触发 read restart）。

**DocRowwiseIterator**（doc_rowwise_iterator.cc）：`FetchNextImpl`（:683，注释自称读路径最热函数并做了 cache-line 对齐）两种模式——`kGeneric` 逐列组装 SubDocument，或 `kFlat`（packed row）：整行一 KV 经 `SchemaPacking` 直出 PG datum。

### 分布式事务：status tablet + coordinator

**TransactionCoordinator 在 `src/yb/tablet/`**（不在 docdb）。模型：每个事务由客户端**任选一个 tablet 作 status tablet**；该 tablet leader 上的 coordinator 维护 `TransactionState`，**状态迁移经本 tablet 自己的 Raft 日志复制**（`UpdateTxnOperation`）——Raft log 即持久层。状态机 `CREATED/PENDING → SEALED → COMMITTED → APPLYING → APPLIED_IN_ALL_INVOLVED_TABLETS`。commit 链：coordinator poller 对每个 involved tablet 发 `NotifyApplying` → participant 复制 APPLYING 记录后 apply intents → 回 `NotifyApplied`。

### Wait-on-Conflict：复刻 PG 行锁语义

三种策略（conflict_resolution.h:44）：WAIT / SKIP / FAIL_ON_CONFLICT（旧默认）。`ConflictResolver::Resolve`（conflict_resolution.cc:231）的 wait 流程：`ReadIntentConflicts` 对要写的键前缀扫 intents DB（**intents 本身就是锁表**——weak 在祖先前缀、strong 在全键，扫一个前缀即得所有可能冲突）+ `StrongConflictChecker` 对单分片事务扫 regular DB 已提交记录 → 有 pending blocker 时 `WaitQueue::WaitOn` **临时释放 LockBatch** 入队，所有 blocker 解决后重跑整个 Resolve；Waiter/blocker 关系喂死锁检测器（`docdb/deadlock_detector.cc`）。

**RowMarkType → intent 类型映射复刻 PG 四级行锁**（dockv/intent.cc，源注释引 issue #1199）：`FOR UPDATE` = strong read + strong write；`FOR NO KEY UPDATE` = strong read + weak write；`FOR SHARE` = strong read；`FOR KEY SHARE` = weak read。且因为 YB 写**列级/子键级** intent，"不同列的修改不互相等待"是 spec 明说的优于 PG 之处。

### MVCC 垃圾回收

compaction 期按 `HistoryRetentionDirective` 丢被覆盖版本；**cutoff 上限约束**（`Tablet::CompactionHybridTimeConstraints`，tablet.cc:5557）：必须 ≤ 参与方 MinRunningHybridTime、memtable 与**未参与本次 compaction 的 SST 文件**的 frontier——避免删掉的墓碑被旧文件里的数据"复活"。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 双库 + 反序时间键 | DocDB 双指针（key_bounds.h:62）+ DocHT 编码 | intent 高删改生命周期与 regular 完全不同；分离 LSM 不互相放大 |
| 间接索引 | reverse index（rocksdb_writer.cc:125） | commit 时 O(intent) 定位，免全表扫 |
| 状态机 + Raft 持久 | TransactionCoordinator（transaction_coordinator.cc:711） | 事务状态免费获得容错 |
| 策略 | WAIT/SKIP/FAIL 三 resolver | 隔离级别语义可配 |
| 键序即语义 | 类型字节排序不变量（value_type.h） | 排序正确性由编码保证而非比较函数 |

## 模块间交互

- **与 tablet/Raft**：write_batch 进 Raft 复制、apply 回写两库（见[Raft 共识与 Tablet](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/02-raft-tablet)）；`ConsensusFrontier` 支撑崩溃恢复
- **与 HybridClock**：intent 时间 ≈ 写时间、regular 时间 = commit HT，读取时经 status 查询换算（见[RPC 与基础库](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/08-rpc-infra)的 HybridTime 编码）
- **与向量索引**：`VectorIndexesUpdater` 挂在 TransactionalWriter/NonTransactionalBatchWriter 上；intents flush 必须晚于 Vector LSM（见[向量索引](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/05-vector-index)）
- **与 YQL**：`DocPgExprExecutor`/`DocRowwiseIterator` 是表达式与行组装的执行地（见[YQL 执行层](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/09-yql-execution)）

## 扩展方式

**新增一种值类型编码**：① `dockv/value_type.h` 的宏表加类型字节（键内需保证与 `kGroupEnd/kHybridTime/kNullLow/kHighest` 及 Descending 家族的排序语义）；② `dockv/primitive_value.cc` 编解码两端 switch；③ `common/ql_type.cc` 的 DataType→encoder 映射 + pggate 序数化；④ 若影响打包改 `schema_packing.cc`；⑤ 旧格式降级路径（参照 `kObsolete*` 前例）。**值类型改动不动 docdb 层**（dockv 拆分的意图所在）；但 intent 类型改动会波及 conflict_resolution 的冲突矩阵。
