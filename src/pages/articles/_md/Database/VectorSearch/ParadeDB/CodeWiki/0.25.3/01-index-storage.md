---
source:
  type: "源码解读"
  project: "ParadeDB"
  url: "https://github.com/paradedb/paradedb"
title: "索引存储与 Tantivy 桥"
date: "2026-09-21T23:37:43+08:00"
category: [Database, VectorSearch, ParadeDB, CodeWiki, "0.25.3"]
contentType: "CodeWiki"
tags: ["ParadeDB", "Tantivy", "PostgreSQL", "MVCC"]
description: "ParadeDB 索引存储解读——bm25 Access Method 回调面、MVCCDirectory 把 tantivy 索引存进 Postgres 索引页、自建 FSM/页管理、LayeredMergePolicy、mutable segment 惰性物化与 fork tantivy 的理由"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/00-overview)

---

## 模块定位

`pg_search/src/postgres/` 的 AM 层（build/insert/delete/vacuum）+ `src/index/`（directory/writer/reader/merge 桥）+ `src/postgres/storage/`（自建页管理）。核心命题：**把 tantivy 索引存进 Postgres 索引关系的 main fork 页里**——不是 heap 表不是文件系统。先澄清路径：AM 层是 `postgres/build.rs` 等（`postgres/index.rs` 只是 72 行的分区索引辅助）；67K 的 `index.rs` 是 `index/writer/index.rs`（SerialIndexWriter）。

## 模块架构

![Tantivy Directory 存储](/vibe-reading/images/articles/paradedb-internals/tantivy-directory.svg)

![索引生命周期](/vibe-reading/images/articles/paradedb-internals/index-am-lifecycle.svg)

**handler 注册**：`bm25_handler` in `postgres/mod.rs:101` 填 `IndexAmRoutine`——ambuild/ambuildempty = `build.rs`、aminsert = `insert.rs`、ambulkdelete = `delete.rs`、amvacuumcleanup = `vacuum.rs`、scan 五件套 = `scan.rs`、并行四件套 = `parallel.rs`。`amstrategies = 2`（`ScanStrategy::TextQuery / SearchQueryInput`）。pg15/16 无 aminsertcleanup，用 `fake_aminsertcleanup.rs` 的 ExecutorRun/ProcessUtility 钩子 polyfill（`FrameGuard` 栈 + panic 安全）。

## 核心实现

### MVCCDirectory：Directory trait 的 Postgres 实现

`index/directory/mvcc.rs` 的 **存储映射**：每个 tantivy "文件"（`.postings/.terms/.fastfields/.fieldnorms/.positions/.idx/.store/.del/.vec/.centroids`）= 一条 `LinkedBytesList`（`storage/linked_bytes.rs`）——跨页链表，每页装 `bm25_max_free_space()` 字节；物理块号不必连续，`blocklist.rs` 用 bitpacking（Sorted1x/4x/8x delta 压缩）存"逻辑块序号→物理 BlockNumber"索引。文件位置 `FileEntry{starting_block, total_bytes}` 挂在 `LinkedItemList<SegmentMetaEntry>` 段元数据链表上；`meta.json` 对应 MetaPage 的 schema/settings 字节 + segment 链表。

三个关键 no-op/丢弃：**Store/TempStore 的 writer 是 `inner: None`（丢弃写入）**——pg_search 不存 doc store，字段数据留在 heap 里按需回读（late materialization 的根源）；`atomic_read/atomic_write` 直接 unimplemented（fork 已不让 tantivy 碰 meta）；`delete/exists/sync/acquire_lock` 均 no-op——**tantivy 文件锁被 Postgres 锁替代**（MergeLock/CLEANUP_LOCK 建议锁）。

### MVCC 版本管理

核心是 `MvccSatisfies` 枚举（`ParallelWorker(ids)/LargestSegment/Snapshot/Vacuum/Mergeable`）：`load_metas`（`directory/utils.rs:340`）遍历段元数据时按可见性过滤。段删除 = 置 `xmax = FrozenTransactionId`（`save_new_metas` in utils.rs:236）；`visible() = !is_deleted()`；**`recyclable() = is_deleted && pintest 块无 pin`**（`block.rs:883`）。`PinCushion`（mvcc.rs:627）为每个在用段 pin 住"pintest 块"——reader 持 pin 期间 VACUUM 无法回收。`save_new_metas` 三路 diff（created 加 xmin / modified 仅 VACUUM 换 .del / deleted 置 xmax），全部链表改动走 `atomically()` 深拷贝后一次性 commit。

**Mutable segment 惰性物化**（aminsert 的双模式配套）：mutable 段只是 `LinkedItemList<MutableSegmentEntry>` 的 Add/Remove(ctid) 日志。`index_memory_segment`（mvcc.rs:651）在**读取时**才物化：查询可见用活动 MVCC 快照 fetch（`GetActiveSnapshot`，detoast 安全），维护类用 `SnapshotAny + HeapTupleSatisfiesVacuum + oldest_xmin`；含 HOT 链遍历、截断块守卫、eager detoast。物化结果写进 `RamDirectory`（OnceLock 惰性建，哪个并行 worker 负责哪个段就在哪建）。

### aminsert 双模式与 Writer

`InsertState` 缓存在 `index_info->ii_AmCache`（`postgres/insert.rs`）：

- **Mutable 模式**（默认，`mutable_segment_rows` = 1000）：**只收集 ctid 不写 tantivy doc**——编码推迟到读取时物化。超限切 Immutable 并递归补插。
- **Immutable 模式**：每行 `row_to_search_document` 把 heap tuple **立即编码成 TantivyDocument**，`SerialIndexWriter::insert`（`index/writer/index.rs:347`）再追加 ctid fast field——**编码时机 = aminsert 当场**。

`SerialIndexWriter`（:198）——"不启任何线程、全前台"，适配 Postgres 后端单线程模型；内存预算 = `WorkMem::Tantivy`（work_mem 钳制 15MB-1GB）；`mem_usage >= budget` 或 `max_docs_per_segment`（向量 IVF 段上限 1000 docs）时 finalize 段。`SearchIndexMerger::merge_segments` 用 fork 的 `merge_foreground`（0 merge/worker 线程）。`DiskSpaceGuard`（:119）按首个 segment 实测大小预检剩余磁盘，ENOSPC 前提前报错；`deferred_wal`：建索引期间不写 WAL，结束后 `log_newpage_range` 整段补写。

### LayeredMergePolicy 与合并

`index/merge_policy.rs:173`（tantivy 默认策略的完全替代，**分层/leveled**）：(1) mutable 段激进合并——单段也合（layer 0 转 immutable），空段搭车；(2) 逐层贪心装箱——段按 `adjusted_byte_size`（×存活比例）降序，候选累计 ≥ `layer_size × 4/3` 开新候选（补偿合并后缩小 ~1/3，防产出段再被同层合并）；(3) `min_merge_count = 2` 过滤短候选。层大小来自索引选项 `layer_sizes`/`background_layer_sizes`，被 `target_segment_count` 钳制。触发点：`insertcleanup → do_merge(Insert)`（mutable 段 >2 强制前台"背压"）、`amvacuumcleanup → do_merge(Vacuum)`（仅此一行——真正的空间回收靠 merge 驱动的 GC）。后台合并 `try_launch_background_merger` 起后台 worker，`MergeSlot` 建议锁每索引最多 2 个；`VacuumSignal` 让 VACUUM 通知长合并提前退出；崩溃合并由 `garbage_collect` 按 pid 死亡/xmin 结束回收。

### 自建页管理（storage/）

**不是绕开 buffer manager**——`buffer.rs` 完全建立在 Postgres buffer 之上（`ReadBufferExtended`/`LockBufferForCleanup`）。自建的原因：**Postgres 没有适用于"索引即任意字节 blob 存储"的页组织与自由空间原语**。`Buffer/BufferMut/PinnedBuffer` RAII 封装 + panic 安全的 Drop（`impl_safe_drop!`）；写路径挂 Xlog（`XlogStyle`：FullPageImage / GenericXlog diff / Unlogged）。**自建 FSM**（`fsm.rs + avl.rs`）：要回收的块必须按"何时可回收的 XID"组织（兼顾仍在读的快照），v2 = **以 FullTransactionId 为 key 的页内 AVL 树**（零堆分配的页驻留实现，V2FSM 根页+溢出页）。`custom_rmgr.rs`：注册 Custom WAL RMGR（id 137），只发 INIT_INDEX 记录——**standby 重放即报错**（社区版把 WAL 级 standby 读划为企业特性）。

### delete/vacuum 的 MVCC 安全

`ambulkdelete`（`postgres/delete.rs:87`）五步：CLEANUP_LOCK 排他（先举 VacuumSignal 让后台 merger 退出）→ vacuum_list + sentinel pin（并发 merge 排除这些段）→ 逐段删除：**immutable 段遍历 ctid fast field，`callback(ctid)` 判死后推 `DeleteOperation::ByAddress{segment_id, doc_id}`**（fork 新增的按地址删除）——commit 用 `advance_deletes + save_delete_metas`（新 .del 替换旧条目，旧 .del 变 orphaned 伪条目待 GC）；**mutable 段直接从 Add/Remove 日志删**（避免物化 fast field 与并发 VACUUM 竞态）。**物理释放三条件**：段 xmax 已 Frozen + next_xid 越过删除事务 + pintest 块无 pin。`did_delete` 后取 `cleanup_lock_for_cleanup()` 屏障——等所有并发 scan 结束再让 PG 更新 VM。

### fast_fields_helper（28K）

tantivy fast field 的统一读取辅助，late materialization 的读侧地基：`FFType` 枚举统一各列类型；`FFHelper` 每段每列 OnceLock 惰性缓存（按 FFIndex 而非名字定位）；`WhichFastField` 的 **Deferred 系列**即延迟编码路径。核心批处理：`fetch_values_or_ords_to_arrow` + 宏按批 DocId 取列成 **Arrow 数组**喂 DataFusion；文本列取 term ordinal（u64），`ords_to_string_array`（:495）**手工按 SSTable 字典块顺序解码**（块缓存 + StringViewBuilder append_view）——绕开 tantivy 逐行 `ord_to_str` API（配合 fork 暴露的字典内部接口）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Directory 适配器 | `mvcc.rs` 实现 tantivy trait | 存储外包、事务内置 |
| MVCC 双时间线 | xmin/xmax + PinCushion | reader/VACUUM 并发安全 |
| 惰性物化 | mutable segment 读取时物化 | 小事务的写延迟最小化 |
| 前台串行 writer | `SerialIndexWriter` | Postgres 单线程模型的纪律 |
| no-op 锁 | tantivy 锁全 no-op | PG 锁替代文件锁 |

## 模块间交互

上游 [CustomScan](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/02-customscan) 的 cost 估算经 `SearchIndexReader::estimate_docs`（`LargestSegment` 目录只看最大段）；reader 被 [scan 执行](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/03-scan-exec) 的 FFHelper/Scanner 消费；schema 构建消费 [API 层](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/04-api-schema) 的 tokenizer cast。

## 为什么存 Postgres 内部（权衡表）

**得到**：WAL 崩溃恢复、pg_dump/基础备份、事务一致性、单一部署单元、PG 锁做并发原语、页分配/IO 全由 buffer manager 承担。**代价**：8KB 页粒度与 special area 开销；**双重缓冲**（自建 16 项 LRU + shared buffers）；写放大（GenericXlog diff / full-page image，`deferred_wal` 就是缓解）；每页 `assert!(IsTransactionState())` 逼出大量 panic-safe Drop；**社区版不能在 standby 上读**。

**为什么 fork tantivy**（pin `c3caae3f`，维护 `paradedb-0.2x.x` 分支）：把"文件系统假设"改成"可插拔 Directory + MVCC"——`save_metas` 携带前一版做 diff、GC 可 opt-out、`merge_foreground` 前台零线程合并、`DeleteOperation::ByAddress`、fast field 惰性打开、BM25 per-field k1/b、向量 IVF/SPANN/BKT 全套（v0.25 的重心）。
