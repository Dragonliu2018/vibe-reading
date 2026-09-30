---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "统一检索原语"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "BM25", "BMW", "倒排索引", "检索算法"]
description: "BM25 与稀疏内积共用一套迭代器：DAAT 归并堆/TAAT 分区 spill/BMW 五状态机剪枝、skip index 块统计上界、SPIV 稀疏向量倒排与第二代 cursor 工厂——hybrid search 的打分底座"
readingTime: "42 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

`src/storage/retrieval/`（34 文件，~1.1 万行）是 seekdb 混合检索的打分引擎——**全文 BM25 与稀疏向量内积共用同一套倒排迭代器**，因为二者数学同构：都是 $\sum_{term} q_{term} \times s(term, doc)$（BM25 的 $q$ 是 IDF 权重、$s$ 是 tf 饱和项；稀疏内积的 $q$ 是查询维值、$s$ 是存储维权重）。倒排遍历、归并、topk 剪枝、打分聚合 100% 复用，差异被压缩到两个点：dim iter 的 score 来源与 block 上界公式——这使「多字段 BM25 + 多向量加权」的 hybrid search 自然退化为加权和。模块放 storage 层是因为迭代器直接消费 storage 私有设施（`ObTableScanParam`、tablet 切换语义、skip index、多表归并）；v1.4.0 又抽出 `data_plane/api/data_plane/retrieval/` 的隔离缝（接口只剩 datum id + double score + 中性 view）。

## 模块架构

第一代体系（当前生产路径）分两层，公共语言是 **doc id（ObDatum）升序的 posting 流**：

```
Dim iter 层（每个词项/维度一个，负责拉 posting）—— ob_i_sparse_retrieval_iter.h
  ObISparseRetrievalDimIter                    # get_next_row/batch/advance_to（动态剪枝接口）
   ├─ ObISRDaaTDimIter                         # + get_curr_score/get_dim_max_score（WAND 上界）
   │   ├─ ObTextRetrievalDaaTTokenIter         # 文本（批量缓存 relevance/doc_id）
   │   │   └─ ObTextRetrievalBlockMaxIter      # + advance_shallow/get_curr_block_max_info
   │   ├─ ObSPIVDaaTDimIter                    # 稀疏向量（scores_ × query_value_）
   │   │   └─ ObSPIVBlockMaxDimIter            # 同构的 BlockMax 装饰
   │   └─ (TaaT 直接复用 ObTextRetrievalTokenIter)
   └─ ObTextRetrievalTokenIter                # TaaT 源：batch 版 token 扫描器

Merge iter 层（编排 + 打分输出）
  ObISparseRetrievalMergeIter                  # reuse/reset/get_next_row(s)/get_query_max_score
   ├─ ObSRDaaTIterImpl                         # 归并堆（ObMergeLoserTree/ObSimpleRowsMerger）
   │   ├─ ObTextDaaTIter / ObTextBMWIter final # + ObBM25ParamEstimator + mode_flag
   │   ├─ ObSPIVDaaTIter → ObSPIVDaaTNaiveIter  # + pre-filter valid_docid_set_ + SPIVSortHeap
   │   └─ ObSRBMWIterImpl                      # BMW 状态机（ob_sparse_bmw_iter.h/cpp）
   │       ├─ ObTextBMWIter / ObSPIVBMWIter final
   └─ ObSRTaaTIterImpl / ObTextTaaTIter final   # TAAT（ob_sparse_taat_iter.h）
  ObSRLookupIter 装饰器                          # Sorted/Hash 两个 function-lookup 形态

共享打分抽象（ob_sparse_utils.h）
  ObSRDaaTRelevanceCollector                    # collect_one_dim(dim_idx, relevance) + get_result()
   ├─ ObSRDaaTInnerProductRelevanceCollector   # 加权和 + should_match_ 门槛
   └─ ObSRDaaTBooleanRelevanceCollector        # 对 ObFtsEvalNode 布尔表达式树求值
```

**对称但不共享基类**：`ObTextRetrievalBlockMaxIter` 与 `ObSPIVBlockMaxDimIter` 结构逐字段同构（内嵌 exact iter + `ObBlockMaxScoreIterator` + `max_score_tuple_`），但没有抽公共实现——是平行实现，差异仅在 `ObBlockMaxBM25RankingParam` vs `ObBlockMaxIPRankingParam`。第二代抽象是 `ObRetrievalProgram`（Pimpl 门面，`compile() → start() → pull()`，状态机 `EMPTY→COMPILED→READY→RUNNING→END`）+ `ob_sparse_retrieval_factory.cpp` 的 cursor 工厂（`ObSparseRetrievalDaaTCursor/BMWCursor`，基于 `data_plane/api/data_plane/retrieval/ob_sparse_retrieval.h` 的四个中性港口 `ObISparseRetrievalSource/BlockSource/IdOps/Filter`）——**注意：第二代的 corpus binding 在 v1.4.0 尚无生产实现**（仅 `unittest/data_plane/retrieval/test_retrieval_program_contract.cpp` 契约测试），生产 FTS/SPIV 路径仍走第一代；它是接口注释自白的设计宣言："No posting, scorer, algorithm, scan or storage type is part of this interface"。

## 调用链路

装配选择逻辑（`das/iter/ob_das_iter_utils.cpp` 的 `create_text_retrieval_sub_tree()`）：

```
if (has_pushdown_topk && 无重复 boolean token)  → ObTextBMWIter    # BMW 剪枝
else if (token 数 > 256 || (非 func_lookup && 不需要 relevance 投影)) → ObTextTaaTIter
else                                            → ObTextDaaTIter   # 默认归并
# MATCH 作函数（function lookup：给了 doc id 回填分数）再包一层 ObSRLookupIter（Sorted/Hash）
# 装配点：observer/composition/retrieval/ob_das_legacy_tr_merge_iter.cpp 的 create_sparse_retrieval_iter()
```

BMW 主流程（`ObSRBMWIterImpl::top_k_search()`，继承 DaaT 归并堆）：

```
1. build_top_k_heap()        # 无剪枝灌满 k 候选 → get_top_k_threshold() = 堆顶最小分
2. next_pivot()              # 弹 dim 累加 get_dim_max_score()，直到 Σ > threshold
                              #   且当前 id is_unique_champion() → 该 id 为 pivot
3. evaluate_pivot_range()    # 各 dim advance_shallow(pivot_id)（只挪 block 游标不动 posting）
                              #   Σ block_max ≤ threshold → 假阳性 → 转 4；否则转 5
4. next_pivot_range()        # 取各 dim 当前 block 的 minimum_max_domain_id 作跳过边界，
                              #   尽量连续跳过多个 range（skip_range_cnt 统计）直到找到候选 range
5. evaluate_pivot()          # advance_dim_iters_for_next_round 真实定位 → collect_dims_by_id 精确打分
                              #   → process_collected_row() 更新 topk 堆
```

<details>
<summary>三种算法与块统计机制速查</summary>

| 组件 | 职责 | 关键设计 |
| --- | --- | --- |
| `ObSRDaaTIterImpl` | DAAT：按 doc id 归并堆逐文档打分 | `ObSRMergeCmp` 用 `ObDomainIdCmp` 比较 datum；`collect_dims_by_id` 弹出同 id 全部 dim 项；输出 doc id 升序 |
| `ObSRTaaTIterImpl` | TAAT：单 dim 顺序扫全量 posting | 按 `murmurhash(docid) % partition_cnt_` 分区写 `ObSpillRowStore`（**可 spill 到磁盘**，`skips_` 位图分区过滤）→ 逐分区 hash map 累加 → 遍历输出支持 offset/limit |
| `ObSRBMWIterImpl` | BMW：块上界剪枝的 topk | `TopKHeap` 最小堆存 `TopKItem{relevance_, cache_idx_}`——堆里只存 cache 索引，`id_cache_` 固定 k 槽复用，省 datum 深拷 |
| `ObBlockStatIterator` | 按 range 迭代块级统计（宏块粒度） | SSTable 侧内嵌 `ObSSTableIndexScanner` 读 **skip index 预聚合行**；Memtable 无 skip index 走真扫。多 SSTable 有两路推进：`use_merged_range`（`MIN_SSTABLE_CNT_USE_MERGED_RANGE = 2` 以上才用合并区间）与 baseline 路径（下标 0 的迭代器 `get_baseline_block_iter()` 作基线）；归并堆在表数不多时用 `ObBSSimpleMerger`、超过阈值换 `ObBSLoserTree` |
| `ObBlockStatCollector` | 跨表宽松聚合块统计 | `ObLooseMinMaxStatCollector`（注释："approximate upper bound... regardless of multi-version data"）+ `ObBM25MaxScoreParamCollector`（跨块 max tf / min doc_length） |
| `ObBlockMaxScoreIterator` | 块统计 → `ObMaxScoreTuple{max_score, min/max_domain_id}` | 模板多态：BM25 特化用块内最大 tf + 最短 doc 算上界；IP 特化用 `max(value) × query_value_` |
| `ObBM25ParamEstimator` | 估计 N 与 avgdl | N 取 planner 预算或扫 doc 聚合表；avgdl 能走 skip-index SUM 就算，否则默认 10.0；k1/b **硬编码**（`ObExprBM25`: k1=1.2, b=0.75, ε=0.25） |
| `ObSRLookupIter` | function lookup 装饰 | MATCH 给定 doc id 回填分数：DAAT→Sorted、TAAT→Hash 两个实现 |
</details>

## 核心实现

### posting 从哪来：三张隐藏表上的普通 DAS 扫描

迭代器的数据**不是独立倒排存储引擎**，而是隐藏辅助表上的普通表扫描——**posting seek 靠动态改写 `key_ranges_` 的 rowkey 再 `das_scan_reuse/rescan/advance`**：

| 检索 | 辅助表（schema 由 builder util 生成） | rowkey | payload |
| --- | --- | --- | --- |
| FTS 倒排 | `INDEX_TYPE_FTS_DOC_WORD_*` | (token, docid) | 词频 / doc_length 列 |
| FTS 聚合 | doc_agg（总文档数）、inv_idx_agg（token df） | token | pushdown aggregate |
| SPIV | `INDEX_TYPE_VEC_SPIV_DIM_DOCID_VALUE_LOCAL = 40` | (dim, docid) | value 列即 posting payload |

`ObTextRetrievalTokenIter::update_scan_param/advance_to`（token 前缀 + docid 第 2 列改写）、`ObSPIVDaaTDimIter::update_scan_param`（dim 前缀）同构。**稀疏向量转倒排的方式**：每个非零维一条记录、rowkey=(dim, docid)、value 列存该维权重（`resolver/ddl/ob_vec_index_builder_util.cpp` 的 `append_vec_dim_docid_value_arg()`，生成列 flag `GENERATED_VEC_SPIV_DIM/VALUE`）——dim 就是 term，value 就是 payload。`ObDatum` 出现在 god nodes 的含义：它是全模块通用值载体——doc id 协议 `sql::ObDocIdExt`（兼容 DAS domain-id 协议，`MAX_DOC_ID_BYTES=40`，二进制不假设整型）、rowkey 拼装、比较（`ObDomainIdCmp` 处理 ext/min/max）、表达式求值定位——所有 id/score 以 datum 穿过 storage→SQL 边界，正是 FTS 与向量能统一在一个迭代器体系里的表示层基础。

### SPIV 两代 merge 路径

旧路 `ObSPIVDaaTIter/ObSPIVBMWIter` 挂在第一代 Impl 下，支持 `valid_docid_set_` **pre-filter**（两阶段检索：稀疏召回 docid 集再给稠密/HNSW 复核——这是 hybrid search 里稀疏预过滤的落点）与 `SPIVSortHeap` topk。新路 `das/iter/ob_das_spiv_merge_iter.cpp` 的 `create_dim_iters()` 对查询向量每个非零 dim 建 `ObDASSPIVDaaTSourceAdapter`（data_plane exact source，`entry.score_ = scores_[idx] * query_value_`）+ `ObSparseVectorBlockSource`，再交 `ObSparseRetrievalFactory::create_daat/create_block_max_wand` 组装第二代 cursor。`SPIVAlgo` 枚举有六种（`DAAT_NAIVE/WAND/BLOCK_MAX_WAND/DAAT_MAX_SCORE/BLOCK_MAX_MAX_SCORE/TAAT_NAIVE`），目前实现 DAAT_NAIVE 与 BLOCK_MAX_WAND，**默认 BLOCK_MAX_WAND**；`candidate_limit = limit + offset`（非 pre-filter 且选择性 < 1 时 ×2）。第二代 BMW 的剪枝语义与第一代等价但港口化：整体判停用 `Σ max(0, block_max × w)`（注释："A dimension absent from a document contributes zero, so zero is always a safe upper bound"），块判停则 `advance_sources_to_boundary()` 跳到各 dim block 边界。

### 打分聚合与加权

`ObSRDaaTRelevanceCollector` 的两个实现承载了 hybrid 加权：内积版是带 `should_match_`（minimum_should_match）门槛的加权和；布尔版对 `sql::ObFtsEvalNode` 布尔表达式树（BOOLEAN MODE 查询）逐 dim 求值。`ObSparseRetrievalMergeParam` 已有 `dim_weights_/field_boost_` 通道——BM25F 之类的字段级权重可以直接借用这个通道。词项侧 df 由 `ObAccessService::estimate_row_count` **估算**而非精确 count，`ObExprBM25::query_token_weight` 专门注释了近似风险并用 `MAX(0, N-df)` + `MAX(ε, idf)` 防护。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 迭代器 + 装饰器 | DaaT/BlockMax/Lookup 三层装饰 | 流式 + 向量化 batch 适配 SQL 执行框架；`reuse(switch_tablet)` 分级复用贴合分区轮转 |
| 模板多态打分 | `ObBlockMaxScoreCalc<RankingParam>::calc_max_score` 特化 | BM25/IP 的上界公式收敛为两份模板特化，其余 100% 复用 |
| Pimpl 门面 + 中性港口 | `ObRetrievalProgram::Impl` + 四个 `ObISparse*` 接口 | 第二代隔离缝："deliberately no kind(), native handle, RTTI hook or templated downcast escape hatch"（防假封装） |
| 最小堆存索引 | `TopKItem{relevance_, cache_idx_}` + `id_cache_` k 槽 | topk 只驻留 k 个项且避免 datum 深拷贝——内存可控是硬指标 |
| 归并堆复用 | BMW 继承 DaaT | 精确打分路径（状态 5）直接复用归并逻辑 |

## 模块间交互

向上被 DAS 迭代器装配层消费（`observer/composition/retrieval/` + `das/iter/ob_das_iter_utils.cpp`——后者同时决定 BMW/TAAT/DAAT 选择）；数据来自 FTS/SPIV 隐藏表（与[全文检索](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/06-fts)的写路径、[向量索引体系](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/05-vector-index)的 SPIV 辅助表衔接）；块统计依赖 `blocksstable/index_block/` 的 skip index（`ObSkipIndexColMeta` 的 SK_IDX_MIN/MAX 预聚合）；BM25 打分表达式在 `sql/engine/expr/ob_expr_bm25.h`（k1/b 硬编码）。参数估计的 N/avgdl 部分来自 planner 预算，`reuse(switch_tablet)` 只在切换倒排表 tablet 时重估——估计值在分区内复用。

## 扩展方式

BM25 → BM25F（字段级权重）的改动面：① `ob_expr_bm25.h/.cpp`——常量与 `eval()` 参数布局按字段扩展；② `ob_block_max_iter.h`——`ObBlockMaxBM25RankingParam` 加 per-field `token_freq_col_idx_/doc_length_col_idx_`、`calc_max_score` 按字段求和；③ `ob_block_stat_collector`——`ObBM25MaxScoreParamCollector` 逐字段收集；④ `ob_text_retrieval_token_iter.cpp`——`init_calc_exprs_in_relevance_expr()/fill_token_weight()` 填字段权重；⑤ avgdl 按字段估计则扩 `ObTextAvgDocLenEstimator`；⑥ 上游 ctdef 与 `dim_weights_` 加权通道（已有雏形）；⑦ block 统计投影列清单（`ObBlockMaxScoreIterParam::init`）。新增一种遍历算法（如 DAAT_MAX_SCORE）则落点在第二代：`SPIVAlgo` 枚举 + `ob_sparse_retrieval_factory.cpp` 的 `create_*` 工厂分支 + 一个 cursor 类。
