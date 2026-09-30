---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "存储引擎"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "OceanBase", "C++", "LSM", "存储引擎"]
description: "tablet/LS 两级结构、2MB 宏块与列存编码微块、memtable→minor→major 的 LSM 生命周期、heap 表隐藏 PK、域索引 DDL 流水线与向量索引为何必须旁路 LSM"
readingTime: "32 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

`src/storage/`（~77 万行）是 OceanBase 4.x LSM 分布式存储的继承体，加上 seekdb 的四个增量目录（`fts/`、`retrieval/`、`vector_index/`、`vector_type/`）。它承载三件事：**数据物理形态**（tablet 分片、宏块/微块两级块、列存编码）、**正确性**（memtable/MVCC/2PC 事务、palf redo）、**域索引构建管线**（向量/全文索引的 DDL 直写宏块 + 存量回填）。seekdb 检索能力的存储侧答案浓缩成一句话：**LSM 主路径服务 OLTP 事务与隐藏辅助表，向量索引的内存图结构旁路 LSM 由专用服务维护**——理解这对「主路径/旁路」的分工，就理解了这个模块的架构。

## 模块架构

```shell
src/storage/
├── ob_i_table.h            # ObITable：SSTable 与 Memtable 的公共基类（版本范围裁剪的统一边界）
├── tablet/                 # ObTablet（COW 不可变）+ table_store + meta_mem 指针表
├── ls/                     # ObLS（日志流）+ ObLSTabletService（231.9KB，DML/向量写入钩子）+ ObFreezer
├── blocksstable/           # 宏块/微块/SSTable + encoding/（11 类列编码）+ index_block/（嵌套索引树）
├── memtable/               # ObMemtable + mvcc/（ObMVCCEngine + ObKeyBTree）
├── compaction/             # minor/major merge 调度（DAG 驱动，ob_batch_freeze_tablets_dag 批量冻结）
├── ddl/                    # DDL 构建管线（ObIDDLPipeline chunk 流水线 + 向量/全文/FORK 特化）
├── tx/ tx_table/           # 2PC 事务 + 事务表（tx_table 本身是 LS 内部 tablet）
├── vector_index/           # IVF kmeans 训练上下文（Elkan）
├── fts/ retrieval/ vector_type/   # 检索子系统（另文详述）
└── meta_mem/ slog/ meta_store/    # tablet 指针表、存储日志、元数据落盘
```

## 调用链路

一次 DML 写入的数据流（与检索读路径互为镜像）：

```
DML 算子（sql/engine）→ DAS InsertOp → ObLSTabletService::insert_rows（ls/ob_ls_tablet_service.cpp）
├─ 事务写 redo（经 ObLS::get_log_handler() → palf，2PC 由 ObTxCtx 推进）
├─ 域索引行写入钩子：insert_vector_index_rows (:3385)
│    ├─ table_param.is_vector_delta_buffer() → server_service<ObIVectorIndexRuntime>()
│    │    → adaptor->insert_rows()（同步插内存 vsag inc 索引）
│    │    → rows[k].storage_datums_[vector_idx].set_null()   # 磁盘行不落向量本体
│    └─ FTS 行 → ObFTIndexRowCache::segment()（das/ob_das_domain_utils.cpp 分词）→ 写倒排/doc_word 辅助表
├─ ObMemtable 追加（memtable/mvcc/ObKeyBTree + ObMVCCRow 版本链）
└─ 提交返回（读己之写：inc 索引已同步插入）

后台：ObFreezer::tablet_freeze → 冻结 memtable → compaction DAG
   → minor merge（增量合并）→ major/medium merge（全量基线，重算列编码）
读：ObTablet::get_read_tables(snapshot) → memtable + minors + major 迭代器 → ob_row_fuse 多版本融合
```

数据类型变化：`ObDatumRow`（存储行）→ memtable `ObMemTableKey`/`ObMVCCRow`（版本链）→ flush 后微块列存（`ObDatum` 列 + null 位图 + 编码）→ 宏块（2MB）→ SSTable 元数据（`ObSSTableMeta`）。

## 核心实现

### tablet / LS 两级结构与五类表数组

```cpp title="src/storage/tablet/ob_tablet.h:759-802（节选）"
class ObTablet final : public ObITabletMdsCustomizedInterface {
  ObTabletMeta tablet_meta_;          // 288B：tablet_id_ / data_tablet_id_ / ref_tablet_id_
                                      //        clog_checkpoint_scn_ / extra_medium_info_
  ObRowkeyReadInfo *rowkey_read_info_;        // heap 表时即隐藏 PK 的读取描述
  ObTabletComplexAddr<ObTabletTableStore> table_store_addr_;   // SSTable 数组（可只落盘按需进 kv cache）
  storage::ObIMemtable *memtables_[MAX_MEMSTORE_CNT];          // 活跃 memtable（不持久化的缓存指针）
  ObDDLKV **ddl_kvs_;  int64_t ddl_kv_count_;  // 在线 DDL 数据 KV（DDL_KV_ARRAY_SIZE = 64）
  logservice::ObLogHandler *log_handler_;      // 从 LS 借来的日志句柄
  ObTablet *next_tablet_;               // 旧版本链（merge 后旧 tablet 等_GC）
  ObTableStoreCache table_store_cache_; // 读路径热缓存（major 数/版本/宏块数）
};
```

**一个 `ObLS` 管理多个 tablet、共享一条 palf 日志流**；tablet 内部由 `ObTabletTableStore` 维护**五类 SSTable 数组**（`ob_tablet_table_store.h:139-146`）：`get_major_sstables()`（基线快照）、`get_minor_sstables()`（增量）、`get_ddl_sstables()`（直载产物）、`get_mds_sstables()`（多源元数据）、`get_meta_major_sstables()`。`ObTabletMeta` 的三个 id 是域索引的关键：`tablet_id_` 是本辅助表 tablet 自己的 id，`data_tablet_id_` **指回数据表**——这就是 6 张向量辅助表/4 张 FTS 辅助表能以普通 tablet 形态挂进同一 LS、复用全部事务与 compaction 能力的机制。tablet 本身**不可变**：merge/flush 通过 `init_for_merge()` 构造新 ObTablet 整体替换旧对象（旧对象进 `next_tablet_` 版本链等 GC），宏块靠 `inc/dec_macro_ref_cnt()` 引用计数安全退役——这是 LSM 「不可变 SSTable」在元数据层的延伸。

### 宏块 / 微块 / 列存编码

- **宏块 = 2MB**（`src/oblib/lib/ob_define.h:1474` `OB_DEFAULT_MACRO_BLOCK_SIZE = 2 << 20`）：磁盘分配、GC、副本物理传输（standby 全量恢复也按宏块流式拷贝）的单位；
- **微块 ≈ 16KB（可配）**：缓存与读 I/O 的最小单位，大小经 `ObDataStoreDesc::micro_block_size_` 由 schema/配置传入；宏块内部由 `index_block/ob_index_block_builder.cpp`（154KB）构建嵌套微块索引树；
- **列存编码**（`blocksstable/encoding/`，11 类）：`ObColumnHeader` 枚举（`ob_block_sstable_struct.h:161`）含 `RAW/DICT/RLE/CONST/HEX_PACKING/COLUMN_EQUAL/COLUMN_SUBSTR/STRING_PREFIX/STRING_DIFF/INTEGER_BASE_DIFF`，每列一个 encoder/decoder 对，DICT 解码有 SIMD 版本（`ob_dict_decoder_simd.cpp`）。行存格式三档（`ObRowStoreType`）：`FLAT_ROW_STORE`/`ENCODING_ROW_STORE`（全列编码）/`SELECTIVE_ENCODING_ROW_STORE`。对文档表尤其有价值的是**跨列编码**——embedding 之外的元数据列大量重复。

**SSTable 只读不可变的 why**：无锁读（无写者）、宏块引用计数整块回收（无碎片整理）、flush 产物以快照为单位原子生效（crash 由 `clog_checkpoint_scn_` 决定丢弃多少，无 undo 半成品）、major merge 时全量重算列编码（数据分布变化后压缩率自适应）。

### LSM 生命周期与 heap 表

```
DML → ObMemtable(内存 B-tree) --ObFreezer::tablet_freeze--> 冻结
   → mini/minor merge → minor SSTable → major/medium merge → major SSTable（唯一基线）
```

heap 表是 seekdb collection 语义的载体：`ObTableOrganizationMode`（`share/schema/ob_table_schema.h`）区分 `TOM_INDEX_ORGANIZED`（聚簇，按用户 rowkey 物理排序）与 `TOM_HEAP_ORGANIZED`（堆表，按隐藏自增 PK 排序）。ROWID 由 **tablet 级自增序列**分配（`ObTabletAutoincrementService` + `ObTabletAutoincSeq`），序列经 `ObTablet::write_sync_tablet_seq_log()` 写 clog 保证重启续分配。seekdb 默认 HEAP 的三重理由：

1. **无主键文档表**：AI collection 是 schema-free 文档，隐藏 `__pk_increment` 列免去用户指定 PK，ROWID 成为文档稳定句柄；
2. **LSM 友好**：自增隐藏 PK 使插入严格 append-only，避免随机 rowkey 打散写热点；
3. **域索引回填锚点**：向量/FTS 辅助表以 rowid 关联回数据表，`ObComplementDataDag` 回填时有单调行标识可并行切分。

配合 `QUEUING/MODERATE/SUPER/EXTREME` 四档表模式（`ob_table_schema.h:340-370` 的模式宏），heap 表还能表达「老化降级」语义——Agent 记忆这类只写不改的流式表的专用形态。

### 域索引 DDL 管线：chunk 流水线直写宏块

`ObIDDLPipeline`（`ddl/ob_ddl_pipeline.h:26`）是极简的流式抽象——**DDL 数据不走 memtable，直接产出不可变 SSTable**：

```cpp title="src/storage/ddl/ob_ddl_pipeline.h"
class ObIDDLPipeline : public ObPipeline {
  virtual int get_next_chunk(ObChunk *&chunk) = 0;   // 拉数据块（纯虚）
  virtual int finish_chunk(ObChunk *chunk) { ... }    // 落盘回调
  virtual int process() override;   // 驱动：循环 get_next_chunk → 写宏块 + 同步建索引块
  int init(const ObTabletID &tablet_id, const int64_t slice_idx);  // 按 tablet 分片并行
};
```

向量索引特化是三层模板组合（`ddl/ob_vector_index_ddl_pipeline.h`，812 行）：**Row iterator**（`ObVectorIndexRowIterator` → `ObHNSWIndexRowIterator`/`ObIVFBaseRowIterator` → 质心/SQ8 元数据/PQ 行迭代器）→ **Operator**（`ObHNSWIndexAppendBufferOperator` + `ObHNSWIndexBuildOperator` 构图；`ObIVFCenterIndexBuildOperator` 调 kmeans——训练上下文在 `storage/vector_index/ob_vector_kmeans_ctx.h` 的 Elkan 实现）→ **Pipeline**（`ObVectorIndexBuildAndWritePipeline<BuildOp, WriteOp>` 模板把「建索引算子 + 写宏块算子」组合起来）。DDL 期间的行容器复用执行引擎列格式：`ObDDLContinuousVector : ObDDLVector`（`ddl/ob_ddl_continuous_vector.h`）直接接管 `query/engine/vector` 的 `ObContinuousBase*`——批式流转换零拷贝，`bytes_usage/sum_lob_length` 让 DDL 按 batch 精确限额内存。

**存量回填**：索引建好后 `ObComplementDataDag`（`ddl/ob_complement_data_task.h:205`）扫主表 → `ObComplementRowIterator` 逐行转索引行 → 写宏块 → `ObComplementMergeTask` 合成 SSTable → 上报列校验和。之所以独立回填，是因为 IVF 质心需要全样本 kmeans、HNSW 需要全量构图——在线增量无法完成全量统计，主表先正常服务，回填任务后台扫全量。整个过程的状态机即概览所述的 `ObDDLTaskStatus`（FTS 走 25-28、向量走 29-34、ik 先 `LOAD_DICTIONARY(46)`、最后 `BUILD_DATA(48)`）。

### MVCC 与事务表

一段话版本：行级多版本在 `memtable/mvcc/`——`ObMVCCEngine` 把 `ObMemTableKey`（rowkey+快照）组织进 `ObKeyBTree`，每个 `ObMVCCRow` 挂事务写入的版本链，读用 `ObMultiVersionIterator` 按快照过滤；事务状态在 `tx_table/`——`ObTxTable = ObTxDataTable + ObTxCtxTable`，二者本身持久化为 LS 内部 tablet（`ObTablet::is_ls_tx_data_tablet()/is_ls_tx_ctx_tablet()`）。提交协议（2PC/GTS）见[日志事务与热备](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/09-logservice-tx-standby)。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 不可变对象 + 版本链 | `ObTablet` COW 替换 + `next_tablet_` 链 + 宏块引用计数 | 元数据替换无锁化，回收安全可延迟 |
| 流水线模板组合 | `ObVectorIndexBuildAndWritePipeline<BuildOp, WriteOp>` | 算法算子与落盘算子自由组合，IVF/HNSW 各拼各的 |
| chunk 迭代器 | `ObIDDLPipeline::get_next_chunk` | DDL 吞吐路径按批流式，内存可控 |
| 五类数组分类学 | `ObTabletTableStore` 的 major/minor/ddl/mds/meta 数组 | 不同生命周期的 SSTable 各归其位，读路径按版本范围各取所需 |

## 模块间交互

存储引擎向上经 `data_plane/api` 暴露 `ObITabletScan`/`ObIDmlService` 等接口（SQL 层只 include 接口头）；**域索引运行时是反向依赖的唯一特例**——`ObLSTabletService::insert_vector_index_rows` 经 `server_service<storage::ObIVectorIndexRuntime>()` 服务定位器拿到 observer 层的向量索引服务，这条接口缝让 storage 无需 include 实现头。DDL 管线消费 rootserver 的任务调度（`ObDDLScheduler`）与 `rootserver/fork_table` 的 tablet fork 任务；检索子系统（fts/retrieval/vector_type）在其内部。palf 日志经 `ObLS::get_log_handler()` 提供提交持久化，compaction 完成经 `ObLocalManagementService::merge_finish()` 回调上报。

## 扩展方式

给微块加一种新编码（模板：现有 11 类）：① `ob_block_sstable_struct.h:161` 的 `ObColumnHeader` 枚举 + `ObEncodingEnableType` 位图；② 新建 `encoding/ob_x_encoder.{h,cpp}` 继承 `ObIColumnEncoder`；③ `ob_x_decoder.{h,cpp}` 继承 `ObIColumnDecoder`（性能敏感时加 SIMD 版，参照 `ob_raw_decoder_simd.cpp`）；④ `ob_micro_block_encoder.cpp` 的逐列择优 + `ob_micro_block_decoder.cpp` 分发接入；⑤ 配套校验（`ob_micro_block_checksum_helper.cpp`）与格式版本升级全量重扫路径；⑥ schema 级开关再动 `oblib/common/ob_store_format.h`。域索引辅助表经同一套 `ObDataStoreDesc` 写宏块，通常无需联动。
