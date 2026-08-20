---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "index 索引引擎"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "倒排索引", "FST", "Roaring Bitmap", "全文索引", "向量索引"]
description: "index——倒排/全文/bloom/向量索引：FST term 映射、Roaring segment 位图、外部排序与 Puffin blob 存储作为 mito2 external provider。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`index`（`src/index/`，~1.2 万行）是 GreptimeDB 的索引引擎，提供倒排索引（inverted index，加速日志/标签搜索）、全文索引（fulltext，Tantivy）、bloom filter、向量索引（vector，USearch HNSW）。它是可观测性日志检索的核心加速器。`index` 是**纯逻辑库**（无 I/O 依赖），通过 `ExternalTempFileProvider` trait 由 `mito2` 注入文件系统实现，作为 external provider 注入 SST（Puffin blob），在 flush/compact 时建索引、scan 时用索引过滤。

## 模块架构

四类索引各有 Creator/Reader/Applier 三侧 trait。倒排：`InvertedIndexCreator`（`inverted_index/create.rs`）+ `InvertedIndexWriter`（`format/writer.rs`）+ `InvertedIndexReader`（`format/reader.rs`）+ `IndexApplier`（`search/index_apply.rs`）+ `FstApplier`（`search/fst_apply.rs`）。bloom：`BloomFilterCreator`/`Reader`/`Applier`。全文：`FulltextIndexCreator`/`Searcher`（`Config` 含 `Analyzer` English/Chinese）。向量：`IndexCreator`/`Applier`（`vector/`，`VectorIndexEngine` trait，USearch 实现）。统一 `Bitmap` enum（`bitmap.rs`，Roaring/BitVec）跨类型 union/intersect。`ExternalTempFileProvider`（`external_provider.rs`）注入临时文件。

## 调用链路

**倒排索引构建**（SST flush/compact 时）：

```
IndexerBuilderImpl::build()                           mito2/sst/index.rs:381
  → build_inverted_indexer → InvertedIndexer::new     mito2/sst/index/inverted_index/creator.rs:88
     → TempFileProvider::new + ExternalSorter::factory → SortIndexCreator
IndexBuildTask::index_build()                          mito2/sst/index.rs:822
  → indexer.update_flat(&batch)                        mito2/sst/index.rs:291
     → InvertedIndexer::do_update_flat                 creator.rs:170
        → IndexValueCodec::encode_nonnull_value
        → index_creator.push_with_name → SortIndexCreator → ExternalSorter::push_n
           （内存超阈值时 spill 到临时文件）            inverted_index/create/sort/external_sort.rs
  → indexer.finish()                                   mito2/sst/index.rs:297
     → InvertedIndexer::do_finish                      creator.rs:391
        → tokio::duplex(8192) pipe
        → InvertedIndexBlobWriter → SingleIndexWriter::write
           → for (value, bitmap): 序列化 bitmap → blob
              + MapBuilder.insert(value, packed[offset,size])  ← FST 需字典序
           → finish_fst_construction → 写 FST
        → writer.finish → encode InvertedIndexMetas (proto) + footer
        → puffin_writer.put_blob(INDEX_BLOB_TYPE, rx, ...)     写 Puffin blob
```

**倒排索引查询**（scan 时）：

```
ScanRegionBuilder::build()                             mito2/read/scan_region.rs:533
  → build_invereted_index_applier(&filters)           :772
     → InvertedIndexApplierBuilder.build(&[expr])
        → InvertedIndexApplier::new → build_apply_plan
           → PredicatesIndexApplier::try_from(predicates)
              InList → KeysFstApplier（fst.get 精确查找）
              Range/Regex → IntersectionFstApplier（OpBuilder 范围/DFA 交集）
  → InvertedIndexApplier::apply(file_id, ...)          mito2/sst/index/inverted_index/applier.rs:214
     → cached_blob_reader 或 remote_blob_reader（PuffinManager → blob）
     → InvertedIndexBlobReader / CachedInvertedIndexBlobReader
     → index_applier.apply(context, &mut reader, metrics)
        → reader.metadata()（footer 解析）+ reader.fst_vec()（批量取 FST）
        → fst_applier.apply(&fst) → Vec<u64>（FST packed [offset,size]）
        → ParallelFstValuesMapper::map_values_vec     search/fst_values_mapper.rs
           → 解包 u64 → [offset,size] → 算绝对 range → reader.bitmap_deque 批量取
           → per-group bitmap.union → intersect → matched_segment_ids
              （早终止：count_ones()==0）
```

## 核心实现

### FST term→offset 映射

`FstMap = fst::Map<Vec<u8>>`（`inverted_index.rs`）。FST 把所有 term 压成确定有限自动机，共享前缀/后缀，内存占用极低（比 HashMap 节省一个数量级），查询 O(term 长度)。天然支持有序遍历和范围查询（Automaton 接口）——这是 Range/Regex 谓词能高效执行的基础。写入在 `SingleIndexWriter::append_value` 的 `MapBuilder.insert(value, packed_value)`（要求字典序输入）。

### Roaring Bitmap + segment 结构

`Bitmap` enum（`bitmap.rs`）`Roaring(RoaringBitmap)`/`BitVec(BitVec)`，mito2 统一用 Roaring（`creator.rs:400`）。Roaring 对稀疏/密集都优秀压缩。**segment-based 结构**：`segment_row_count: NonZeroUsize` 贯穿建链——行按固定 segment 分组，每个 term 的位图是 segment 粒度而非行粒度，位图大小 = segment 数。大表数亿行 + segment=1024 只需 ~100K bit，极大缩小存储与 I/O；查询返回 `matched_segment_ids` 再精确扫对应 segment 行。

### 外部排序控内存

倒排索引要求 term 字典序（FST `MapBuilder.insert` 要求有序输入）。`ExternalSorter`（`inverted_index/create/sort/external_sort.rs`）用 BTreeMap 内存排序 + 超阈值 spill 临时文件 + `MergeSortedStream` 2-way 归并。`may_dump_buffer` 检查全局内存（`AtomicUsize` 跨 sorter 共享）与 `memory_usage_threshold`，超限 dump——保证索引构建内存有上界，大 SST 不 OOM。

### Puffin Blob 存储

mito2 的 `SstPuffinManager`/`PuffinManagerFactory`：Puffin（雪花格式）一个文件存多个命名 blob。倒排/bloom/全文/向量各自独立 blob，一个 SST 对应一个 `.puffin` 索引文件、生命周期一致，查询只读需要的 blob，blob metadata 存索引配置，支持 range read 免全文件下载。

### ExternalTempFileProvider 依赖注入

`index` 是纯逻辑库无 I/O，但外部排序需 spill。通过 trait 注入（`external_provider.rs`），测试可注入内存实现，生产由 mito2 注入基于 `InstrumentedStore`（带监控本地 FS）的 `TempFileProvider`（`mito2/sst/index/intermediate.rs:183`）。路径 `__intm/{region_id}/{sst_file_id}/{uuid}/{file_group}/{file_id}.im` 用 UUID 隔离，`IntermediateManager::init_fs` 启动时异步清理残留。

### 向量索引 null_bitmap 映射

HNSW（USearch）内部用连续 u64 key 标识向量，但原始数据可能有 NULL（跳过不索引）。creator 维护 `null_bitmap` 记录 NULL 行号，HNSW key 只给非 NULL 向量；查询 `hnsw_key_to_row_offset()` 用 null_bitmap 的 rank 二分查找映射回原始行号（无 NULL 走快速路径 key==row_offset，`vector/apply.rs`）。

### 多策略 FstApplier

`FstApplier` trait（`search/fst_apply.rs`）：`KeysFstApplier` 处理 InList（`fst.get` 精确查找，多 InList 交集），`IntersectionFstApplier` 处理 Range/Regex（`OpBuilder` 范围/DFA 交集）。`PredicatesIndexApplier::try_from` 先处理 InList 再处理 Range/Regex。不同谓词对 FST 查询方式完全不同，策略模式让每种独立实现。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略（FstApplier） | `FstApplier` trait + Keys/Intersection（`search/fst_apply.rs`） | InList 精确 vs Range/Regex 范围扫描 |
| Provider（外部文件） | `ExternalTempFileProvider`（`external_provider.rs`） | index 纯逻辑库，I/O 由 mito2 注入 |
| 工厂 | `SorterFactory`（`sort_create.rs`）、`create_engine`/`load_engine`（`vector/engine.rs:44`） | 按配置创建 sorter/engine，预留扩展 |
| Builder | `InvertedIndexApplierBuilder`（`applier/builder.rs`）、`Config.build_tantivy_tokenizer` | 链式装配 applier/分词器 |

## 模块间交互

`index` 是纯逻辑库，被 `mito2`（`sst/index.rs` 是统一索引器门面，`InvertedIndexer`/`BloomFilterIndexer`/`FulltextIndexer`/`VectorIndexer` 包装 index crate；`sst/index/intermediate.rs` 实现 `ExternalTempFileProvider`；`read/scan_region.rs` 查询路径建四类 applier）集成。索引数据存于 mito2 SST 的 Puffin blob（`INDEX_BLOB_TYPE`）。`IndexBuildScheduler`（`mito2/sst/index.rs:1217`）管后台构建调度（优先级 Manual > SchemaChange > Flush > Compact，支持任务合并）。被 `operator`/`log_query` 通过查询下推使用。

## 扩展方式

- **新增索引类型**（如图索引）：`index/src/` 新建模块定义 Creator/Searcher trait + 实现，`lib.rs` 加 `pub mod`，mito2 新建 `sst/index/<type>/{creator,applier}.rs` 包装，`Indexer` 加字段并在 `update_flat`/`finish` 分发，`IndexOutput` 加字段，`scan_region.rs` 加 `build_<type>_index_applier`，定义 `<TYPE>_INDEX_BLOB_TYPE`。
- **改全文分词器**：`fulltext_index/tokenizer.rs` 实现 `Tokenizer` trait，`fulltext_index.rs` `Analyzer` enum 加 variant，`Config::build_tantivy_tokenizer` 加 match arm（分词器类型存 Puffin blob metadata，读取侧自动适配）。
- **新增向量引擎**（如 FAISS）：`vector/engine.rs` 实现 `VectorIndexEngine` trait，`create_engine`/`load_engine` 加 match arm + feature flag，`store_api::storage` 的 `VectorIndexEngineType` 加 variant + proto 映射（`HnswVectorIndexCreator`/`Applier` 通过 `Box<dyn VectorIndexEngine>` 多态，无需改）。
