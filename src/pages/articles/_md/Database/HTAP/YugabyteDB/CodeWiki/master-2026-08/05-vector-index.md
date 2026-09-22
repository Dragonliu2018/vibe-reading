---
source:
  type: "源码解读"
  project: "yugabyte-db"
  url: "https://github.com/yugabyte/yugabyte-db"
title: "向量索引"
date: "2026-09-23T00:33:00+08:00"
category: [Database, HTAP, YugabyteDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["YugabyteDB", "C++", "HNSW", "pgvector", "Vector LSM", "Usearch", "copartitioned"]
description: "YugabyteDB 向量索引层解读——不塞 RocksDB 而是与它平级的 Vector LSM 子系统、yb_hnsw 自研块格式 + 共享 rocksdb block cache、UUID vector_id 让 MVCC 可见性退化为反向映射查询、intents flush 门控保崩溃一致性全解"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

YugabyteDB 的 pgvector 兼容层（2.29+ 特性）。官方设计文档（`architecture/design/vector-index.md`，641 行）的核心结论值得先记住：**不把 HNSW 图塞进 RocksDB，而是在每个 tablet replica 旁边再造一个对等的持久化子系统 "Vector LSM"**。难点：DocDB 的 per-node 存储是按主键排序的 RocksDB，而 HNSW 是图结构——KV 排序模型不匹配图遍历。

**先纠正一个常见猜测**：`src/yb/rocksdb/` 里**不存在** VectorIndexTableFactory（全仓库 grep 无此符号）——YB 没有把向量索引做成 RocksDB 的 TableFactory/SST 格式，真正的 hook 在四处：`rocksdb::Cache`（块缓存复用）、`rocksdb::DirectWriteHandler`（反向映射写入接口）、MemTable flush filter（flush 顺序门控）、`ConsensusFrontier`（OpId 恢复机制）。

## 模块架构

四层分工：

| 层 | 路径 | 职责 | 关键符号 |
|---|---|---|---|
| LSM 服务层 | `src/yb/vector_index/`（6.9k 行） | chunk 生命周期、manifest、compaction；**不依赖任何具体 ANN 库**（算法经 `VectorIndexFactory` 函数注入——依赖倒置） | `VectorLSM<Vector,DistanceResult>`（vector_lsm.h:103） |
| 算法适配层 | `src/yb/ann_methods/`（3.3k 行） | 把 Usearch/Hnswlib/自研 YbHnsw 包成 `VectorIndexIf` | `ANNMethodKind`（ann_methods.h:28） |
| 磁盘格式层 | `src/yb/hnsw/`（2.1k 行） | 自研只读块式 HNSW 文件格式 + 块缓存 | `YbHnsw`（hnsw.h:128）、`YbHnswBuilder`（hnsw.cc:109） |
| DocDB/tablet hook | docdb + tablet + tserver | 挂进读写路径、Raft apply、flush、bootstrap | `DocVectorIndexImpl`（doc_vector_index.cc:244）、`VectorIndexesUpdater`（rocksdb_writer.cc:1415） |

类型系统：`CoordinateKind` 十种标量（宏生成），`DistanceKind` 三种（kL2Squared/kInnerProduct/kCosine，distance.h:31）；生产路径只实例化 `std::vector<float>, float`（doc_vector_index.cc:576 硬编码）。

## 核心实现

### 存储模型：Vector LSM 目录

**图存哪**：不是专用 CF、不是 SST。每个 tablet 的 kv_store 目录下开独立目录 `vi-<permanent index id>`（`kVectorIndexDirPrefix = "vi-"`，docdb_util.cc:56）。目录内含 chunk 文件（后缀由 `HnswBackend` 决定：`usearch`/`hnswlib`/`yb_hnsw`）+ manifest `.meta`（CRC32 校验的追加记录：add_chunks/remove_chunks + frontiers，vector_lsm.proto:41）。

**yb_hnsw 块格式**（自研）：Header（dimensions、entry point、max_level、每层信息）+ 五类块——aux data（VectorId 列表）、非基层邻居块、基层邻居块、vector data 块 + footer（CRC32）。**块缓存复用 RocksDB**：`TSTabletManager` 用 tserver 的 `rocksdb::Cache` 构造 `hnsw::BlockCache`（ts_tablet_manager.cc:887），每块以随机 UUID 为 key 插入，LRU 驱逐回调 `Unload()`——**向量块与 SST 块共享同一容量和淘汰策略**。这是新增 `YB_HNSW_USEARCH` 后端的动机：usearch 原生 load 是 mmap view（不受控不可淘汰），转 yb_hnsw 块格式才能统一内存治理。

### 与 Raft 的关系：图不走 Raft，frontier 重放对齐

向量数据本身**不走 Raft**。三层时序：

1. **Raft 前**（PG 端）：`PgsqlWriteOperation::InsertColumn` 为每个向量值生成 `VectorId::GenerateRandom()` 并打包进值（pgsql_operation.cc:1498，`EncodedDocVectorValue` = 向量字节 + 尾部 UUID）
2. **Raft 后 apply 时**：`VectorIndexesUpdater::Feed`（rocksdb_writer.cc:1433）解码 packed row——经 `ApplyReverseEntry` 把 `vector_id → ybctid` 反向映射写进 **regular RocksDB**（key = `kVectorIndexMetadata | kVectorId | uuid` + DocHybridTime，天然 MVCC 兼容），同时把向量攒进 batch → `DocVectorIndex::Insert` → `VectorLSM::Insert`（插内存图）
3. **持久化**：mutable chunk 写满 → `RollChunk` → 落盘 + `UpdateManifest`（保证 chunk 按 order_no 顺序入 manifest）

**崩溃恢复**：Vector LSM 的 manifest 里记录各 chunk 覆盖的 Raft OpId（**复用 DocDB 的 ConsensusFrontier 机制**）；bootstrap 时 `TabletVectorIndexes::FillMaxPersistentOpIds`（tablet_bootstrap.cc:1871）→ `ComputeApplyToStorages`（:1124）逐存储系统（regular/intents RocksDB、每个 Vector LSM）按各自 frontier 决定是否重放该 op。

### UUID vector_id：MVCC 可见性的优雅退化

**vector_id 标识"一次向量插入事件"而非向量本身**——同一向量重复插入也换新 id；更新 = 删旧 id 加新 id。这样 MVCC 可见性判断退化为"**reverse mapping 里该 id 是否存在**"，无需改 HNSW 图；图内的删除只做逻辑过滤（搜索期 `PgsqlVectorFilter` 前推进图遍历，hnsw.cc:618 逐候选回调查反向映射判删除 + 可评估 WHERE 条件）+ compaction 期物理清理（`VectorMergeFilter::Filter`，doc_vector_index.cc:213）。

### Intents flush 门控：三个持久系统的顺序约束

APPLY 流程是"intents → regular RocksDB + Vector LSM，然后删 intents"。**若 intents 先 flush 而 Vector LSM 没 flush，crash 后该 op 可能因已过 intents frontier 而不重放 → 图数据永久丢失**。`Tablet::IntentsDbFlushFilter`（tablet.cc:997）+ `IntentsDbFlushFilterState::AddLargestFlushedIndex`（:948）用最小已 flush OpId 做门控——**intents 的 flush 必须晚于 Vector LSM**。

### 读路径：五源合并

`PgsqlReadOperation::ExecuteVectorLSMSearch`（pgsql_operation.cc:2734）：mutable 内存图 + 正在落盘的 immutable 内存图 + 磁盘 immutable chunk + insert buffer 暴力搜索 + **已提交事务的 intents 暴力搜索**（`VectorIndexKeyProvider::Prefetch`，SeekFilter::kIntentsOnly——未 apply 的已提交向量也能被搜到）。Compaction：类 universal compaction 的 size-amplification + size-ratio 挑块策略（vector_lsm.cc:2243/2317）。

### 与 pgvector 的关系：fork + 删原实现 + ybvector 扩展

`src/postgres/third-party-extensions/pgvector/` 是 **pgvector v0.8.0 的 fork，删掉了自带的 HNSW/IVF-Flat 实现**（Makefile 只编 `ybvector/`），保留 vector 类型与运算符。新增 `src/ybvector/`：`ybhnsw.c` 注册 **`ybhnsw` access method**（`makeBaseYbVectorHandler(is_copartitioned=true)`——**索引放进被索引表的 implicit tablegroup 即同 tablet**）；`ybvectorread.c` 走 `YBCPgDmlANNBindVector` 把查询向量下推到 tserver；partial vector index 被显式拒绝（谓词不下推会静默出错，#31441）。

**Copartitioning 是性能设计的关键**：向量索引与被索引表同分区同复制（同一 tablet），一次 RPC 内先查向量索引拿到 ybctid、再就地取同 tablet 的其他列——用户要的通常不是向量本身。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 依赖倒置 | VectorLSM 不依赖 ANN 库，`VectorIndexFactory` 注入 | 三后端（usearch/hnswlib/yb_hnsw）可切换 |
| 对等子系统 | Vector LSM 与 RocksDB 平级，共享 ConsensusFrontier | 复用崩溃恢复框架而非发明新协议 |
| 装饰器（缓存） | 块经 UUID key 进共享 rocksdb::Cache | 内存治理与 SST 统一 |
| 间接层（映射） | UUID vector_id → ybctid 反向映射存 regular RocksDB | MVCC/compaction 免费继承 |

## 模块间交互

- **与 DocDB/tablet**：`VectorIndexesUpdater` 挂在 `ApplyIntentsContext`/`NonTransactionalBatchWriter` 两个 writer 上（见[DocDB 存储抽象](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/04-docdb)）
- **与 Raft/bootstrap**：frontier 重放（见[Raft 共识与 Tablet](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/02-raft-tablet)的 `ComputeApplyToStorages`）
- **与 PG 查询层**：pgvector fork 的 ybvector 扩展 + `YBCPgDmlANNBindVector` 下推（见[PostgreSQL 查询层](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/06-ysql)）
- **元数据链**：`PgVectorIdxOptionsPB`（common.proto:152）→ master `TableInfo::NeedVectorIndex()` 命中 → `TabletVectorIndexes::DoCreateIndex` → `CreateDocVectorIndex`；建索引后台 backfill 扫存量数据补图

## 扩展方式

**新增距离度量（如 L1）**：pgvector fork 的 `sql/vector.sql` 加 opclass → `src/ybvector/ybhnsw.c:159` opclass 名→dist_type 分支 → `common.proto:123` 加 `DIST_L1` → `doc_vector_index.cc:88` ConvertDistanceKind → `distance.h:31` DistanceKind + 实现 + GetDistanceFunction 分支 → `hnsw_options.cc` 映射 usearch metric。

**新增 ANN 后端（如 DiskANN）**：`ann_methods/` 新 wrapper 实现 `VectorIndexIf`（复用 `IndexWrapperBase` 模板）+ kind 枚举 + `common.proto` HnswBackend + `doc_vector_index.cc:125` 的 Factory switch + `docdb_util.cc:650` 文件后缀。

**新增坐标类型（如 f16）**：另需改 `coordinate_types.h:170` 实例化组合、`CreateDocVectorIndex` 的硬编码 float 分发、各 wrapper 显式模板实例化。
