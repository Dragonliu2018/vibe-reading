---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "存储引擎"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "LSM-Tree", "tablet", "SSTable", "compaction"]
description: "OceanBase 存储引擎：tablet 懒加载三态地址、宏块-微块两级结构、败者树多版本行融合、wash-score 堆淘汰与 DAG 化 compaction。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`src/storage/`（~128 万行）是 LSM-Tree 数据层：tablet（4.0 后数据分区的唯一单位）、memtable（内存增量 + MVCC）、SSTable（不可变基线，宏块/微块两级）、compaction（major/minor/mini 三种合并）、行存/列存混合（column_store）、SLog（存储层元数据日志）。核心设计命题：**百万级 tablet 的元数据内存可控 + 不可变数据结构换并发读**。边界：事务（tx/）、日志流（ls/ 宿主）、备份 HA 见各自模块文档。

## 模块架构

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `ObTablet` + `ObTabletMeta` | `tablet/ob_tablet.h:219`、`ob_tablet_meta.h:50` | 分区单位，本体固定 ~1KB |
| `ObTabletTableStore` | `tablet/ob_tablet_table_store.h:44` | 按桶分数组组织多版本 table 链 |
| `ObMemtable` + `ObQueryEngine` | `memtable/ob_memtable.h:184`、`mvcc/ob_query_engine.h:64` | keybtree + 可选 hash 双索引 |
| `ObSSTable` | `blocksstable/ob_sstable.h:124` | 双层元数据（meta_cache 内联 + 懒加载 meta） |
| `ObMacroBlock` / `ObMicroBlockHeader` | `blocksstable/ob_macro_block.h:58` | 宏块组装器 / 微块自描述头 |
| `ObTenantMetaMemMgr` | `meta_mem/ob_tenant_meta_mem_mgr.h:126` | tablet 对象池 + wash 淘汰 |
| `ObMultipleMerge` 族 | `access/ob_multiple_merge.cpp` | 多版本行融合迭代器 |
| `ObTenantTabletScheduler` | `compaction/ob_tenant_tablet_scheduler.cpp` | 合并调度 |
| `ObCOSSTableV2` | `column_store/ob_column_oriented_sstable.h:124` | 列存 major（多 CG SSTable） |

## 调用链路

### 一行 INSERT 的写入链

```
ObTablet::insert_row()                            tablet/ob_tablet.cpp:5609
└─ ObStorageTableGuard（保护 memtable 快照）→ prepare_memtable :5669
   └─ write_memtable->set(param, context, arg)
      └─ ObMemtable::set() → set_()                memtable/ob_memtable.cpp:549/2530
         ├─ build_row_data_（序列化行，兼容 micro_block_format_version）
         ├─ mvcc_write_()                          同文件 :3008
         │  ├─ mvcc_engine_->create_kv             定位/新建 ObMvccRow（INSERT 场景 no_get_before_set 直插优化）
         │  ├─ ObMvccEngine::mvcc_write            mvcc/ob_mvcc_engine.cpp:254
         │  │    写写冲突 → OB_TRY_LOCK_ROW_CONFLICT / TSC 违反 → OB_TRANSACTION_SET_VIOLATION
         │  ├─ ensure_kv（插入 keybtree）
         │  └─ 失败 mvcc_undo（无副作用回滚——该函数的原子性契约，注释明示）
         ├─ check_row_locked_on_frozen_stores_（已冻结旧 memtable 的行锁复查，经 tx_table）
         └─ register_row_commit_cb（后续 redo/commit 由事务层回调）
```

### 读路径 row fusion

```
ObTablet::get_read_tables(snapshot_version, iter)  ob_tablet.cpp:4810
└─ ObTabletTableStore::calculate_read_tables       选 ≤snapshot 的最近 major + 连续 minor 链 + 活跃 memtable
   └─ ObMultipleScanMerge::inner_merge_row          access/ob_multiple_scan_merge.cpp:~600
      ├─ rows_merger_（ObScanMergeLoserTree 败者树，按 rowkey 排序各层迭代器）
      ├─ 对同 rowkey 的多版本行从新到旧 ObRowFuse::fuse_row  storage/ob_row_fuse.cpp:191
      │    Nop 列被更老版本补齐；final_result 短路（无 Nop 即完整行）
      └─ process_fuse_row                           ob_multiple_merge.cpp:1060
         fuse_default（Nop 补默认值）→ fill_lob_locator → pad_columns → 虚拟列 → filter/limit
```

单消费者 + blockscan 开启时直接 `iter->get_next_row` 免败者树（pushdown 优化）；点查有 fuse_row_cache 命中路径（`ob_multiple_get_merge.cpp:446`）。

### memtable flush 判定与 fast freeze

`ObMemtable::ready_for_flush_` 的三个基础条件：`is_frozen && get_write_ref() == 0 && get_unsubmitted_cnt() == 0`——冻结、无并发写引用、redo 已全部提交；满足后依次 `resolve_snapshot_version_`（transfer freeze 场景用 `recommend_snapshot_version_` 而非 freezer 的 freeze 版本）、`resolve_max_end_scn_`、`get_ls_current_right_boundary_`（要求 `current_right_boundary >= get_max_end_scn()` 才继续）、`resolve_left_boundary_for_active_memtable_` 才置 READY_FOR_FLUSH。为什么 boundary 解析这么谨慎：mini merge 产物的版本边界必须与 LS 全局水位对齐，否则恢复/合并会多版本丢失。

**fast freeze**（`ObFastFreezeChecker::check_need_fast_freeze`，`compaction/ob_tenant_tablet_scheduler.cpp`）有两条触发路径：热点行（hotspot）与墓碑行（tombstone）——后者在 `empty_mvcc_row_count_ >= 1000` 且占比 ≥ 50% 时触发（大量删除留下的空 MVCC 行会拖垮读路径，提前冻结让它进 minor merge 清理），阈值还随最近 merge 次数自适应调整（`try_update_tablet_threshold`）。

### Compaction 调度与执行

```
major freeze：RS 广播冻结版本
└─ ObTenantTabletScheduler::schedule_merge          compaction/ob_tenant_tablet_scheduler.cpp:690
   └─ mini（memtable flush）：ObMemtable::flush → ObTabletMiniMergeDag
      └─ DAG 链：ObTabletMergeDag（:205）→ prepare_merge_ctx → N 个并行 ObTabletMergeTask（:297）
         └─ ObTabletMergeTask::process              ob_tablet_merge_task.cpp:1329
            └─ ObPartitionMajorMerger::merge_partition   compaction/ob_partition_merger.h
               ├─ ObPartitionMergeHelper（迭代器 + loser tree）
               ├─ major 遇 OB_ENCODING_EST_SIZE_OVERFLOW → force_flat_format 降级重试 :1390
               └─ ObDataMacroBlockMergeWriter + ObSSTableIndexBuilder 建索引树
      └─ 收尾 ObTabletMergeFinishTask → update_tablet_after_merge
         → ObTablet::init_for_merge 造新 tablet → ObTabletPersister 写 shared block + slog
         → ObTenantMetaMemMgr::compare_and_swap_tablet 换指针
```

## 核心实现

### tablet 元数据：全内存指针 + 懒加载三态地址

`ObTablet` 本体固定 ~1KB（头文件逐字段标 size），重的 `ObTabletTableStore`/`ObStorageSchema`/`ObTabletMacroInfo` 全部 `ObTabletComplexAddr<T>` 三态化（memory/disk/none，`ob_tablet_complex_addr.h`）。`ObTableStoreCache` 把调度需要的统计（major/minor 数量、last_major_snapshot_version）**镜像进 tablet 本体**——多数调度决策连 table_store 都不用拉。为什么：百万级 tablet 全量常驻不可行。`fetch_table_store` 与 `load_table_store` 的语义区分见 `ob_tablet.h:394-397` 注释（load=一定在盘，fetch=可能内存可能盘并进 kv cache）。

所有 table store 变更 = 新建对象 → `compare_and_swap_tablet` CAS 换指针，老版本走 `next_tablet_` 链延迟 GC——不可变快照 + copy-on-write。

### meta_mem 淘汰：wash-score 二元堆（不是 2Q）

**常见说法"meta_mem 用 2Q 淘汰"在当前代码无证据**。实际机制：tablet 对象池（NORMAL 3824B / LARGE 65480B 两档，`ob_tenant_meta_mem_mgr.h:130-131`）配额满时，`ObTenantMetaObjPool::acquire` 调 `TryWashTabletFunc` → `get_wash_tablet_candidate`（`ob_tenant_meta_mem_mgr.cpp:2981`）用 `ObBinaryHeap` 选 wash_score 最小的 tablet 换出。score 由 `ObTabletHandle::calc_wash_score`（`meta_mem/ob_tablet_handle.cpp:272`）：`WTP_HIGH → t`，`WTP_LOW → t - INT64_MAX`（LOW 优先被洗；t = 当前时间，即近似 LRU 但保留优先级维度）。

### 宏块（2MB）- 微块（~16KB）两级结构

宏块是 IO 与空间管理单位（`ObMacroBlockCommonHeader` 一个类型字段统一 9 种宏块：数据/索引/元数据/共享块…），微块是压缩/编码/缓存单位；`ObMicroBlockAdaptiveSplitter` 按压缩率自适应切分。小 SSTable 还有嵌套进单宏块的空间优化（`ObSSTableIndexBuilder::ObSpaceOptimizationMode`）。SSTable 双层元数据：`ObSSTableMetaCache` 内联轻量镜像（row_count/upper_trans_version 等，读统计不必拉全量 meta）+ 完整 meta 懒加载走 kv cache。注意 `ObSSTable::inc_ref/dec_ref` 在 4.2 后**故意废弃为空操作**（`ob_sstable.h:130-134` 注释：进 KVCACHE 只读后不能改缓存内存）——生命周期改由 table_store + 宏块引用计数保证（防"元数据在缓存、宏块被删"竞态）。

### 列存（4.3+ C-Replica）

一个 major 逻辑上是 `ObCOSSTableV2`，内部 `column_group_cnt_` 个 CG SSTable（ALL_CG + EACH_CG）；读取侧 `ObCoSSTableRowScanner` + `ObCGBitmap`。`ObTabletMeta::ddl_replay_status_`（头文件 224-242 行长注释）解决"offline DDL 与加 C-Replica 并发时行存 clog 要在列存 tablet 上回放"的顺序问题；`ObTableStoreCache::ObMajorStoreType` 记录 last major 形态支持行列渐进互转。写出参数四层拆分（`ObStaticDataStoreDesc` 共享 + `ObColDataStoreDesc` 每 CG 一份）让 N 个 CG 并行任务语义一致且省内存。

### SLog 与 LOB

tablet 变更路径 = 宏块（shared block + linked block）落盘 → slog 写 tablet 新地址 → `ObMetaDiskAddr` CAS（8×int64 位压缩寻址）。为什么独立于 clog：tablet 元数据变更频率远低于数据，且 replay 时必须先于数据可定位。LOB in-row/out-row 自适应：小 LOB 内联省一次 IO，大 LOB 外置保微块压缩率（阈值 session 变量 `ob_default_lob_inrow_threshold` 可调）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 引用计数 RAII 句柄 | `ObMetaObjGuard<T>`（`meta_mem/ob_meta_obj_struct.h:192`，2h hold 告警）、`ObTabletHandle`、`ObSSTableMetaHandle` | 换指针式更新的并发安全基础 |
| 不可变快照 + COW | `compare_and_swap_tablet` + `next_tablet_` 延迟 GC 链 | 读路径完全无锁 |
| 两级缓存 | 微块 `ObDataMicroBlockCache`（`ob_micro_block_cache.h:466`）+ `ObStorageMetaCache`（`ob_storage_meta_cache.h:210`） | 微块是压缩/缓存粒度、meta 是对象粒度 |
| DAG 框架 | `ObIDag/ObITask/ObDagNet`（share/scheduler） | compaction 一切长活统一调度重试 |
| 败者树 | `ObScanMergeLoserTree` | 多层数据流按 rowkey 归并 |

## 模块间交互

依赖 logservice：tablet 持 `log_handler_` 缓存指针，replay 经 `ObTabletReplayExecutor`（friend）调各 `replay_*` 变体；`ObMemtable::replay_row` 消费事务 redo。依赖 tx：`mvcc_acc_ctx_` 携带快照与 TxTableGuard，冲突判定依赖 `ObTxTable` 复查（延迟 cleanout）。被 DAS/`ObLSTabletService` 调用；HA/备份经 `get_ha_tables`、`ObMigrationTabletParam` 消费接口。

## 扩展方式

- **新增一种 merge type**：`compaction/ob_compaction_util.h` 的 `ObMergeType` 枚举 → `ob_partition_merge_policy.cpp` 选表策略 → `ob_tablet_merge_task.h` 用 `DEFINE_MERGE_DAG` 宏加 Dag → ctx 构造 + `update_tablet_after_merge`；新 filter 实现 `ObICompactionFilter`（`ob_i_compaction_filter.h`）
- **修改微块编码/压缩**：编码器在 `blocksstable/encoding/`（行存）与 `cs_encoding/`（列存）；参数入口 `ObMicroBlockEncoderOpt`；降级兜底在 `force_flat_format` 分支
- **新增 tablet 元数据字段**：`ob_tablet_meta.h` 成员（头文件 243 行注释警告：必须同步 `ObMigrationTabletParam`）+ `ob_tablet.cpp` 各 `init_*` 变体 + 版本升级路径 `load_deserialize_v1/v2/v3`（`ob_tablet.h:1078-1103`）
