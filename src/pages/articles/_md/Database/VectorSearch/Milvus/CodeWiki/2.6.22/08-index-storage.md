---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "索引与存储层"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "C++", "Tantivy", "对象存储"]
description: "Milvus 索引与存储层解读——IndexFactory 分发、knowhere 委托边界、Tantivy 直出位图、binlog v1 事件编码、MVSIDXV3 容器、storagev2 Parquet 与 Kmeans 聚类"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

C++ `internal/core/src/index/`（~70 文件）+ `storage/` + `indexbuilder/` + `clustering/` 是索引族与存储地基。分工边界一句话：**Milvus core 只做文件编排/序列化/类型分发，ANN 数学核心全在 knowhere；标量/文本检索自研 + Tantivy（Rust）封装**。

## 模块架构

![索引与存储层](/vibe-reading/images/articles/milvus-internals/index-storage.svg)

## 核心实现

### 索引族全景

分发中枢 `IndexFactory`（`index/IndexFactory.cpp`，815 行 Meyers 单例）：`CreateIndex()`（:403）按 `IsVectorDataType` 二分——向量走 `CreateVectorIndex`，标量按 DataType 分 primitive/composite(Array)/Json/Geometry/Ngram。

| 索引族 | 代表类 | 底层 | 适配查询 |
|--------|--------|------|---------|
| 向量内存 | `VectorMemIndex<T>` | **完全委托 knowhere**（成员即 `knowhere::Index<IndexNode>`） | ANN top-k / range / sparse / 迭代器 |
| 向量磁盘 | `VectorDiskAnnIndex<T>` | knowhere（DiskANN） | 超内存大规模 |
| 标量排序 | `ScalarIndexSort<T>`（:56，static_assert arithmetic） | 自研排序数组 + mmap | 数值 Range/In |
| **倒排**（标量主力） | `InvertedIndexTantivy<T>`（:78） | **Rust Tantivy**（`tantivy-wrapper.h` C 封装） | In/NotIn/Range/IsNull/PrefixMatch |
| 位图 | `BitmapIndex<T>` | 自研 RoaringBitmap/dynamic_bitset | 低基数等值 |
| 混合标量 | `HybridScalarIndex<T>` | **构建期采样基数动态选择**：`SelectIndexTypeByCardinality`（:81-160）低基数选 BITMAP、高基数整型 STL_SORT/其他 INVERTED | 免选型的"智能索引" |
| 全文 | `TextMatchIndex : InvertedIndexTantivy<string>` | Tantivy + 分析器（jieba 等） | TEXT_MATCH / PHRASE_MATCH |
| Ngram | `NgramInvertedIndex` | 自研 ngram 词表 + tantivy writer | LIKE/模糊匹配 |
| JSON 倒排 | `JsonInvertedIndex<T>` | Tantivy JSON 类型 + simdjson（解析错误记录器） | `/a/b > 3`、Exists、IsNull |
| JSON 扁平 | `JsonFlatIndex` | 一份无 cast 类型的全量索引，查询时按 path 延迟出 executor | 免建多份索引支持任意 path |
| JSON Key 统计 | `JsonKeyStats` + bson/parquet | Tantivy key 倒排 + **shredding**（阈值 0.3：JSON 列转 Parquet 列存加速） | JSON_CONTAINS / key 存在性 |
| 空间 | `RTreeIndex` | 自研 R-Tree（v2.6 GEOMETRY 字段配套） | GIS 谓词 |
| Zone Map | `SkipIndex` + FieldChunkMetrics | 从 Parquet row-group 元数据提取 | 段级粗筛 |

**勘误**：源码中不存在 FM-Index——全文匹配由 TextMatchIndex 基于 Tantivy 倒排实现。

### Knowhere 边界（v2.6.18 pin）

调用点（`VectorMemIndex.cpp`）：创建 `knowhere::IndexFactory::Instance().Create<T>()`（:172，growing 段另有 `ViewDataOp` 零拷贝视图构造——索引直接看原始列内存不落文件）；构建 `CacheRawDataToMemory` 拉原始 binlog 后 `index_.Build(dataset, config, build_pool)`（:473）；查询 `PrepareSearchParams` 组装后 `index_.Search(dataset, conf, bitset, op_context)`（:752）；加载 `DeserializeFromFile` + `MmapFileRAII` 持有本地文件实现 mmap（:1045-1088）。**DiskANN**（`VectorDiskIndex.cpp`）：build_config 里写本地 raw_data/prefix 路径交 knowhere 直接落盘，完成后 `file_manager_->AddFile` 上传；加载先 `CacheIndexToDisk` 下载。**标量/文本侧对 knowhere 零依赖**——边界清晰成立。

### Tantivy：为什么用 + 关键改造

`internal/core/thirdparty/tantivy/`（zilliztech fork，双版本 pin 对应 `index_writer_v5/v7`）：Lucene 级成熟度（分词/analyzer/倒排/压缩）在 Rust 生态没有替代，自研成本过高。Milvus 的关键改造是 **`direct_bitset_collector.rs`：查询结果直接产出 row-id 位图（SetBitsetFn 回调）而非 Lucene 式 doc 迭代器**——与执行引擎的位图过滤模型（TargetBitmap）零拷贝对接。标量倒排/JSON/Ngram 全部复用同一 binding（另含 `index_json_key_stats_writer.rs`、`index_ngram_writer.rs` 专用 writer）。

### binlog v1 与 MVSIDXV3 容器

事件模型模仿 MySQL binlog：`EventHeader`（`Event.h:33`：timestamp/event_type/event_length/next_position）；文件魔数 `0xfffabc`；EventType 七种（Descriptor/Insert/Delete/CreateCollection/DropCollection/CreatePartition/DropPartition/IndexFile）。布局：`[MagicNum][DescriptorEvent][InsertEvent(含 payload)]`——descriptor 携带 collection/segment/field id 与数据类型，**payload 区经 PayloadWriter 内部已是 Arrow ArrayBuilder**（v1 binlog 本身就是 Arrow 编码）。上传 `PutIndexData()` 按 16MB 切片、128MB 并发约束。加密路径支持 EDEK。

**MVSIDXV3**（`IndexEntryWriter.h:30-57`）：8 字节魔数 + 目录区（name/offset/size/crc32）+ 数据区 + JSON `__meta__`，`IndexEntryReader` 流式按 entry 读取（CRC32c 增量校验 + 全局瞬时内存预算）——解决"一个索引 = 对象存储一串散碎分片"的问题（标量索引可单文件存取）；`InvertedIndexTantivy::LoadEntries/WriteEntries`（:799）已接入。

### 对象存储与 storagev2

`ChunkManager` 纯虚接口（`ChunkManager.h:31`）+ 实现：Local（全局单例——DiskANN 本地缓存层）、MinIO 系（基于 AWS SDK 派生 Aws/Gcp/Aliyun/Tencent/Huawei，配 STS 凭证提供者；**S3 系不支持 offset 读写**）、Azure/GcpNative、**OpenDAL**（插件式扩展）。**storagev2 不在 storage/ 下**而是独立仓库 `milvus-io/milvus-storage`（FetchContent pin）：ArrowFileSystem/manifest/segment writer；C++ 消费端 `segcore/storagev2translator/GroupChunkTranslator`（按 Parquet row-group 拉数据），Go 侧 `packed_writer_ffi.go` 走 FFI 写 packed Parquet。**SkipIndex 的 min/max 直接取自 row-group 元数据**——binlog → Parquet 的直接红利。双通道并存（`cache_raw_data_to_memory` 与 `cache_raw_data_to_memory_storage_v2`），由 collection 的 storage_version 决定。

### indexbuilder 与 Kmeans 聚类

`indexbuilder/` 是独立 OBJECT 库链接进 cgo 静态包：`index_c.cpp` 的 C ABI（`CreateIndex` :198 解析 proto + Go 传入对象存储凭证 → `BuildFloatVecIndex` 系列喂数据 → `Serialize/UpLoad` 回传）。Go 调用方 `indexcgowrapper/index.go:110`，被 **datanode** 的 `internal/datanode/index/task_index.go:337` 调用（索引构建在 datanode 进程内完成）。**clustering**（`KmeansClustering.cpp:342`）：`SampleTrainData` 采样 → **`knowhere::ClusterFactory` 创建 KMEANS 节点训练取质心** → `StreamingAssignandUpload` 流式分配全量数据产出 centroid→row mapping（`IsDataSkew` 检测倾斜可跳过）——**训练本体委托 knowhere cluster 模块，Milvus 侧只做采样/流式分配/上传**。产物即 [clustering compaction](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/03-datacoord) 的分区依据。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 单例工厂 | `IndexFactory`（Meyers，:403） | 索引类型注册分发 |
| 基数自适应 | `HybridScalarIndex`（:81-160） | 免用户选型 |
| 委托 | VectorMemIndex → knowhere | ANN 迭代快抽独立仓库随版本 pin |
| 位图直出 | `direct_bitset_collector.rs` | 与执行引擎零拷贝对接 |
| 容器格式 | MVSIDXV3 目录+数据区 | 散碎分片聚合为单文件 |

## 模块间交互

上游 [Segcore](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/07-segcore) 的 VectorSearchNode 消费 knowhere 索引、FilterBitsNode 消费标量/JSON/全文索引的位图；构建入口在 [DataNode](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/09-datanode) 的 index worker（indexbuilder cgo）；mmap 列经 [Segcore](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/07-segcore) 的 cachinglayer 管理。**与引擎层的连接**：knowhere 之下才是 [Faiss](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)/[USearch](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/00-overview) 的世界。

## 扩展方式

**新增标量索引类型**：`index/Meta.h` 加常量 → 实现 `FooIndex<T> : ScalarIndex<T>` → `CreatePrimitiveScalarIndex` 与 string 特化版各加分支 + `IndexLoadResource` 资源估算 → 文件管理器补缓存方法 → 表达式求值处加索引命中判断。**新增向量索引且 knowhere 已支持则 Milvus 几乎零改动**——`CreateVectorIndex` 只按 DataType×index_type 分派模板，索引名透传 knowhere 注册表分发。
