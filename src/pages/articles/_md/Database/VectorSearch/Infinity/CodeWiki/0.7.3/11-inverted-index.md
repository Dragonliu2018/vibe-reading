---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "全文检索"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 全文检索解读：Lucene 风格倒排索引的 C++ 全栈实现——三段异步写入管线、posting SIMD 位打包与块级 block-max、FST 字典、BM25 与 Block-Max WAND 早停、多 chunk 顺序归并"
readingTime: "26 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/storage/invertedindex/`（约 1.9 万行，99 个文件）是 Lucene 风格倒排索引的 C++ 全栈实现，覆盖"构建（invert）→ 内存索引 → dump 落盘 → 段合并 → 查询解析 → 迭代器求值 → BM25 打分"全链路。分词器在 `src/common/analyzer/`（强相关但独立模块）；查询串解析器（`search_parser.y`）物理上在 `src/parser/`。

一个容易混淆的边界：**稀疏向量索引（BMP）不用这套倒排**。`src/storage/knn_index/sparse/` 自建倒排结构（block max pruning），与全文倒排是平行的两套实现——grep 确认 sparse 目录不 import 本模块任何文件，唯一共享的是 common 基础设施。

---

## 模块架构

![全文检索写入与查询管线](/vibe-reading/images/articles/infinity-internals/ft-pipeline.svg)

```text
src/storage/invertedindex/
├── column_inverter.cppm/_impl      列倒排构建：分词 → term 收集 → 排序 → posting 生成
├── memory_indexer.cppm/_impl       内存段索引（god node）：三段异步流水线 + dump/spill
├── posting_writer.cppm/_impl       单 term 的 posting list 写入器
├── posting_merger.cppm/_impl       多 chunk 归并（DocMerger）
├── column_index_reader.cppm/_impl   查询侧：磁盘段 + 内存段混合 reader
├── column_index_merger.cppm/_impl  compaction 时的索引段合并
├── format/                          编码格式：posting_field / skiplist / term_meta / doc_list_format
├── fst/                             FST 字典（Rust fst crate 的 C++ 移植）
├── search/                          查询树 + 迭代器 + BM25（query_node / term_doc_iterator / doc_merger...）
├── dict_reader.cppm                 DictionaryReader：FST mmap 查询
├── inmem_segment_reader / disk_segment_reader / segment_posting
└── multi_posting_decoder.cppm       跨段解码路由
```

---

## 调用链路

### 写入路径（INSERT → 内存 posting → dump）

```text
NewTxn::AppendMemIndex (new_txn_index_impl.cpp:851)
  在线索引走 AppendMemIndexTask 攒批 → bg_task 的 MemIndexAppender
  → MemoryIndexer::Insert (memory_indexer_impl.cpp:103)
     分配 seq_inserted_ 序号 + begin_doc_id → 推入 inverting_thread_pool_：
       ColumnInverter::InvertColumn → 每行 analyzer->Analyze(val, terms_once)
       → term 数写 column_lengths_ → MergePrepare（term 塞 terms_ 缓冲 + PosInfo）
       → Sort()（radix 排序）→ ring_sorted_.Put(task_seq, inverter)
  → MemoryIndexer::CommitSync (memory_indexer_impl.cpp:423)
     从 ring 批量取有序 inverter → GeneratePosting (column_inverter_impl.cpp:215)：
       线性扫描排序后的 positions_，term/doc 变化处 EndDocument(doc_id, payload)，
       否则 AddPosition(pos)；writer 经 posting_writer_provider_ → GetOrAddPosting（RcuMap）
容量达 MemIndexCapacity（65536 行）：
  DumpIndexProcessor 开 kDumpMemIndex 事务 → NewTxn::DumpMemIndex
  → MemoryIndexer::Dump (memory_indexer_impl.cpp:471) 写三个文件：
    .pos  posting 压缩块 + skiplist
    .dic   TermMeta + FST（Merge 追加到字典文件尾部）
    .len   column_lengths_ 原始 u32 数组
  → catalog 登记新 ChunkIndexMeta{base_row_id, row_cnt, term_cnt}
```

**ring 序号环是并发关键**：分词线程乱序完成 `Put(seq, inverter)`，commit 线程 `GetBatch` 只取连续就绪前缀，保证 posting 按 doc id 顺序生成；`inflight_tasks_ + cv_` 做背压。

### 查询路径（MATCH → 迭代器 → BM25 → TopN）

```text
planner：SearchDriver::ParseSingleWithFields → QueryNode 查询树（Lucene 查询串在 binder 期解析）
executor：PhysicalMatch::ExecuteInner (physical_match_impl.cpp:233)
  ├─ QueryBuilder::Init(index_reader_)  （TableIndexReaderCache 按 begin_ts 缓存 IndexReader）
  ├─ QueryBuilder::CreateSearch (query_builder_impl.cpp:40)
  │    QueryNode::GetOptimizedQueryTree（权重下推 + NOT→AND_NOT 优化）
  │    → 递归 CreateSearch → 叶子 TermQueryNode::CreateSearch (query_node_impl.cpp:416)
  │       → ColumnIndexReader::Lookup(term) (column_index_reader_impl.cpp:140)
  │          遍历所有 segment_readers_：
  │          磁盘段：DictionaryReader::Lookup（FST Get 拿偏移 → TermMetaLoader）
  │                  → mmap 的 .pos 上 ByteSlice::NewSlice 零拷贝切片
  │          内存段：InMemIndexSegmentReader 直接从 RcuMap 取活着的 PostingWriter
  │          所有 SegmentPosting 装进 PostingIterator（MultiPostingDecoder 跨段解码）
  └─ ExecuteFTSearch (physical_match_impl.cpp:143)
       while (iter->Next()) result_heap.AddResult(iter->Score(), iter->DocID())
       FullTextScoreResultHeap 命中 topn 后 iter->UpdateScoreThreshold(heap.GetScoreThreshold())
       ← 分数阈值回灌迭代器做动态剪枝
```

`TermDocIterator::InitBM25Info`（`term_doc_iterator_impl.cpp:53`）由 `FullTextColumnLengthReader`（先查 chunk 的 BufferHandle 缓存，再查内存 indexer，最后换 chunk）算 `avg_column_len_`，预计算 `bm25_common_score_`；`BM25Score()`（`:140-158`）按 doc 缓存。顶层 OR 且 BM25 时 `OrQueryNode::CreateSearch` 选 `BlockMaxWandIterator`（EarlyTermAlgo kAuto/kBMW/kBatch/kNaive）。

### 多 segment 归并

`NewTxn::OptimizeFtIndex` 收集同 segment 内多个 chunk 的 `base_names/base_rowids`（**只允许同 segment**，防止 doc id 相对偏移超 u32），`ColumnIndexMerger::Merge`（`column_index_merger_impl.cpp:44`）用 `SegmentTermPostingQueue` 按字典序流式取 term → `PostingMerger::Merge`：靠"各 chunk 已按 base_row_id 升序、内部 doc id 升序"的不变量做顺序归并——逐 chunk 用 `DocMerger` 重放 `AddPosition/EndDocument` 到新 PostingWriter，doc id 加 `base_doc_id = chunk_base_rowid - merge_base_rowid` 偏移。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `ColumnInverter::InvertColumn` | `column_inverter_impl.cpp:82` | 分词 + PosInfo 收集 |
| `ColumnInverter::GeneratePosting` | `column_inverter_impl.cpp:215` | 排序后线性扫描生成 posting |
| `MemoryIndexer::Insert/CommitSync` | `memory_indexer_impl.cpp:103/:423` | 三段流水线 |
| `MemoryIndexer::Dump` | `memory_indexer_impl.cpp:471` | .pos/.dic/.len 三件套 |
| `PostingWriter::AddPosition/EndDocument` | `posting_writer_impl.cpp` | posting 累积 |
| `ColumnIndexReader::Lookup` | `column_index_reader_impl.cpp:140` | term → 跨段 posting |
| `DictionaryReader::Lookup` | `dict_reader_impl.cpp` | FST 查询 + TermMeta 加载 |
| `TermDocIterator::BM25Score` | `term_doc_iterator_impl.cpp:140` | BM25 打分 |
| `ColumnIndexMerger::Merge` | `column_index_merger_impl.cpp:44` | 多 chunk 归并 |
| `NewTxn::OptimizeFtIndex` | `new_txn_index_impl.cpp:~2200` | 合并事务入口 |

</details>

---

## 核心实现

### posting 编码：块内差值 + SIMD 位打包 + 块级 block-max

- doc id 先做 delta（`doc_list_encoder_impl.cpp:58`），position 做 doc 内差值；
- 块压缩用 `IntEncoder<u32, SIMDBitPacking>`（FastPFor 系 SIMD 位打包），u16 字段（doc payload、block max percentage）用 `NewPForDeltaCompressor`，短链路可选 VByte；
- 块大小 `MAX_DOC_PER_RECORD = 128`（与 SIMD 寄存器对齐），每块 flush 写 skiplist 条目，**块级携带 `block_max_tf_` 与 `block_max_percentage_`**（tf/doc_len 量化为 u16）——这两个字段专门为 Block-Max WAND 早停服务：TopK 查询无需解压整条 posting 就能算出块内分数上界（`BlockMaxBM25Score`，`term_doc_iterator_impl.cpp:91-104`）。

### FST 字典：term → 字典文件内偏移

dump/merge 时 `FstBuilder::Insert(term, term_meta_offset)` 顺序插入、`Finish()` 落盘，随后把 FST 文件直接 `VirtualStore::Merge` 追加到字典文件尾部；读取时 `DictionaryReader` 持有 mmap 的 `Fst`，`Lookup` 走 FST `Get`（节点转移 + Output 拼值）拿偏移再 `TermMetaLoader::Load`。为什么用 FST：term 间前缀+后缀双重共享，字典体积远小于明文列表（这是 Rust `fst` crate 的 C++ 移植，`fst/README.md` 有说明）；mmap 零拷贝、O(|key|) 查询；`FstStream` 还预留 prefix/range 扫描。

### BM25 的两处实现（一个陷阱）

在线路径在 `TermDocIterator::BM25Score()`：`score = weight * smooth_idf * (k1+1) * (tf/(tf + k1(1-b) + k1·b·doc_len/avg_len) + delta/(k1+1))`，k1/b/delta 来自查询选项（默认 k1=1.2、b=0.75），公共因子在 `InitBM25Info` 预计算成 `bm25_common_score_/f1/f2/f4`。另一处 `BM25Ranker`（`bm25_ranker_impl.cpp`，k1/b 编译期常量）**在整个 src 中无调用方**——疑似遗留或供外部用。修改打分函数时 `InitBM25Info/BM25Score/BlockMaxBM25Score` 三件套必须同改，否则 BMW 早停会给出错误上界。

### 为什么内存索引是 MemoryIndexer + 后台 dump

四个理由：(1) **实时性**——`RcuMap` posting 表让查询线程无锁读到正在写入的 posting（`InMemIndexSegmentReader` 直接持有 PostingWriter，`CreateInMemPostingDecoder` 在内存 buffer 上构建解码器，**免落盘可查**）；(2) **写入吞吐**——三段流水线（分词线程池 → Ring 有序 → commit 生成 posting），`seq_inserted_` 保证 doc id 无洞；(3) **内存可控**——`mem_used_`/`MemUsageChange` 精确追踪，超限还可 `Dump(spill=true)` 换出成 `.spill` 文件、下次 Insert 前 `Load()` 换入，**内存索引可被驱逐是显式设计**；(4) **离线大批量导入另辟路径**——不驻留 posting 表，直接外排（SpillSortResults 写 (term, doc_id, pos, payload) 元组 → 败者树多路归并 → 直接产索引文件），内存占用与数据量解耦。

### 列存与倒排怎么共存

一列两套独立数据：原始行数据在列存 block（ColumnVector）；`IndexFullText` 是独立的二级索引，按 segment → chunk 组织，chunk 目录下三个文件 `.pos/.dic/.len`（chunk = 一次 dump 的产物，`base_name = "ft_{base_rowid:016x}"`）。一致性靠事务：dump/merge 都是 NewTxn 内操作并登记 catalog，查询用 begin_ts 快照。doc 长度与 posting 分开存，因为它按 doc 组织而非按 term 组织，BM25 需要随机访问任意 doc 的长度。

### RowID 与 doc id 的映射

索引内部 doc id 是 chunk 内 u32 相对值，`SegmentPosting` 携带 `base_row_id`，`MultiPostingDecoder` 在段边界加回（`LocateSegment/SkipInOneSegment`）。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 迭代器链（组合 + 策略） | `DocIterator` 之下的 And/Or/AndNot/Phrase/MinimumShouldMatch/BMW 组合树 | 查询对象与求值对象分离，按参数选迭代器策略 |
| 责任链式懒解码 | PostingIterator → MultiPostingDecoder → IndexDecoder → InDocPositionIterator | 每层只暴露 SeekDoc/GetCurrentTF，编码细节封在链尾 |
| 生产者-消费者 + 序号环 | `Ring<T>` 连续就绪前缀 + cv 背压 | 乱序分词、有序 commit |
| 模板方法/策略（编码器族） | `TypedPostingField<T>` 按 `EncoderTypeTraits` 绑定编码器 | 格式即数据 |
| Facade | `QueryBuilder`/`SearchDriver` | executor 只见 CreateSearch |
| 零拷贝 mmap | `DiskIndexSegmentReader` 构造时 mmap 整个 .pos | 查询期 ByteSlice 直接指向 mmap 内存 |

---

## 模块间交互

- **analyzer**：`ColumnInverter::InitAnalyzer` 经 `AnalyzerPool` 按名取分词器；analyzer 名配置在 `IndexFullText` 索引定义里。**写入与查询必须用同一 analyzer**（`SearchDriver` 用列的 analyzer 分词查询词）。
- **executor PhysicalMatch**：持有 `index_reader_`，构建 QueryBuilder → 迭代器打分 TopK；支持 `ScoreThresholdIterator` 包一层分数阈值过滤。
- **bg_task**：MemIndexAppender（INSERT 攒批）、DumpIndexProcessor（dump）、compaction/OptimizeIndexTask（归并）。
- **catalog/new_txn**：chunk 元数据（TableIndexMeta/SegmentIndexMeta/ChunkIndexMeta）驱动 reader 装配；`InvalidateSegment/InvalidateChunk` 在 dump/merge 后摘除旧 reader。
- **persistence_manager**：dump/merge 走对象缓存路径。

---

## 扩展方式

**新增打分函数（BM25 变体/TF-IDF）**：`parse_fulltext_options.cppm` 加参数解析 → `TermDocIterator` 的 `InitBM25Info/BM25Score/BlockMaxBM25Score` 三件套同改 → `FulltextSimilarity` 枚举加 case → `Score()` 的 switch 加分支。注意 `BM25Ranker` 的教训——没有接线就是死代码。

**修改 posting 编码**：编码侧 `format/posting_field.cppm` + `doc_list_format_option.cppm`；块大小 `index_defines.cppm` 的 `MAX_DOC_PER_RECORD`（定长缓冲联动）；解码侧 skiplist/posting_decoder。**dump 格式变化必须同步 `TermMetaDumper/Loader` 与 `ColumnIndexMerger`**（新老 chunk 混合合并时段内格式由 optionflag 区分）。

**新增查询算子（wildcard/prefix）**：`search/query_node.cppm` 加节点 → `query_node_impl.cpp` 的 CreateSearch/优化逻辑 → 新 DocIterator（prefix 可复用 `FstStream` 的 `Reset(prefix)` 与 `DictionaryReader::InitIterator(prefix)`，已就绪）→ parser 语法。

**风险点**：`MemoryIndexer`（线程池、外排、spill、内存追踪混在一类）是改动时最易引入并发问题的地方；`ColumnIndexMerger::Merge` 依赖"被合并 chunk 必须同 segment 且 base_row_id 升序"的隐含约定（代码注释明示），新增合并入口必须维护该约定。
