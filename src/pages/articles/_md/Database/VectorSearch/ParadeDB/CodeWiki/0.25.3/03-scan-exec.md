---
source:
  type: "源码解读"
  project: "ParadeDB"
  url: "https://github.com/paradedb/paradedb"
title: "scan 执行与 Late Materialization"
date: "2026-09-21T23:37:43+08:00"
category: [Database, VectorSearch, ParadeDB, CodeWiki, "0.25.3"]
contentType: "CodeWiki"
tags: ["ParadeDB", "DataFusion", "Top-K", "晚物化"]
description: "ParadeDB scan 执行层解读——SegmentedTopKExec 的 best-of-worst 全局阈值算法、LateMaterialization 的 ordinal 冒泡与锚定、PreFilter 的 ordinal 边界改写、PgSearchTableProvider 与物理计划的 MPP 序列化"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/00-overview)

---

## 模块定位

`pg_search/src/scan/`（19 文件 ~11.6K 行）是 ParadeDB 在 **DataFusion ExecutionPlan trait 之上**构建的物理算子层。关键设计一句话：**中间节点全部用廉价整数（term ordinal / packed DocAddress）工作，字符串字典解码与 Postgres heap 访问都推迟到最后一刻**。总体架构在 `joinscan/README.md` 有官方自述，与代码核实一致。

## 模块架构

三条路径共享本层：BaseScan（TopK/Columnar/Normal 三 ExecMethod）、JoinScan（管线 `Projection ← TantivyLookupExec ← SegmentedTopKExec ← HashJoinExec ← PgSearchScanPlan(s)`）、AggregateScan（仅 FilterPushdown post-pass）。

## 核心实现

### pdb_query：双层查询 IR → tantivy Query

**双层 DSL**：外层 `SearchQueryInput`（`query/mod.rs:65`：`Boolean{must,should,must_not}/Boost/ConstScore/ScoreFilter/DisjunctionMax/MoreLikeThis/Parse/TermSet/WithIndex/PostgresExpression`——AND/OR/NOT 组合在这层）+ 内层 `pdb::Query`（`pdb_query.rs:149`：字段无关叶子——Term/Match/Phrase/PhrasePrefix/Regex/Range{,Contains,Intersects,Term,Within}/FuzzyTerm/Proximity/ParseWithField 等 ~28 变体）。

`pdb::Query` 是 **Postgres 自定义类型（InOutFuncs）+ serde JSON**：`InOutFuncs::input`（:749）先按 JSON 反序列化，失败则包成 `UnclassifiedString`——`WHERE f @@@ 'some string'` 的 RHS 先成未分类变体，再由各操作符的 SUPPORT 函数改写（`===`→`Term`、`@@@`→`ParseWithField`）。`Query::into_tantivy_query`（:441）巨型 match 分发到构造函数产出 tantivy Query。附带 `is_expensive_to_estimate`（FuzzyTerm/Regex 构造 scorer 需建 DFA——planner 估选择性时改用常数启发式，避免估行数本身把查询跑一遍）。

### SegmentedTopKExec：招牌算子（97K）

**为什么分段**（模块 doc :18-71）：late materialization 下排序键字符串以 per-segment **term ordinal** 流动——ordinal 只在单 segment 字典内可比，不能跨段直接比；而每段只需保留自己的 top-K，最后归并即可——同时给出**并行性**（segment 是天然分区单位）与**内存上界 O(K×S)**。

**算法核心**（`SegmentedTopKState`，:831）：

1. **输入**：late materialization 的 2-way dense UnionArray。`extract_deferred_ordinals`（:1090）拆两种状态：State 0 = packed `(segment_ord<<32|doc_id)`，State 1 = 已解析的 `(segment_ord, term_ord)`；
2. **每段缓冲**：`SegmentBuf` 容量 2K（visibility 计划抬高到 max(2K, 8192)）。填满后 `truncate_top_k`（:936）：先可见性检查未查后缀，再 `select_nth_unstable_by(k-1)` **QuickSelect** 取前 K，记录第 K 优为该段 cutoff；
3. **全局阈值发布**（点睛之笔，`publish_global_threshold` :1317）：取所有满段 cutoff 的 **"worst 中最好"（best-of-worst）**，`build_lexicographic_filter`（:1237）构造链式字典序谓词（`a<t_a OR (a=t_a AND b<t_b)`，含 NULL 语义），经 `DynamicFilterPhysicalExpr::update` 推给下层扫描——**让 scanner 在读取时就按已见数据的阈值剪枝**，等价于 Bruno/parcel 式 top-k 提前终止，但作用在索引扫描层；
4. **最终发射** `emit_final_topk`（:1715）：物化为字符串 OwnedRow、全排序、截 K、interleave 重排；visibility 计划下把 HOT-corrected 真实 ctid 写回输出列；
5. **内存控制**：`maybe_compact`（:1499）在 stored ≥ 2×referenced 时压缩到幸存行。

**规则**（`segmented_topk_rule.rs`，PhysicalOptimizerRule）：`try_inject_at_sort`（:114）找带 `fetch` 的 SortExec 且排序键含 deferred 列，在 `TantivyLookupExec` 下注入 STK，**并拆掉原 SortExec 直接返回其 child**（STK 接管最终排序+LIMIT）。细节：吸收直接子 `VisibilityFilterExec`（dead row 不会抬高下发阈值）；接管已铸造的 DynamicFilter（#5635）；`wrap_blocking_nodes`（:387）给 SortPreservingMergeExec 套 `FilterPassthroughExec` 让动态过滤穿透。GUC `paradedb.enable_segmented_topk` 总开关。

### Late Materialization：两个正交的 deferral

**为什么**：BM25 索引里字符串列以 term dictionary + ordinal 存储，解码要逐段查字典；join/排序若全程在 ordinal 上做，就只需为**最终 K 行**付解码成本（heap 访问同理——README："the only point where the PostgreSQL heap is accessed"）。

**实现三件套**：
1. **逻辑规则** `LateMaterializationRule::rewrite`（`late_materialization.rs:384`）：在 TableScan 处调 `provider.enable_late_materialization_schema()` 把 schema 从 Utf8View 翻成 `Union(UInt64 doc_address, Struct term_ordinal)`；然后让 Union 类型**冒泡**穿过纯透传节点（简单 Projection、不做 join key 的 HashJoin、Limit），而一旦节点"求值"了 deferred 列（`should_anchor` :294：Filter 引用/Sort 按它排/Aggregate/非平凡表达式），就在其下**锚定** `LateMaterializeNode`；
2. **物理化** `LateMaterializePlanner`（:675）：把节点变成 `TantivyLookupExec`；
3. **`TantivyLookupExec`**（`tantivy_lookup_exec.rs:68`）：`execute`（:374）逐 batch `enrich_batch` → 按段分组 ordinal、批量字典解码（`ords_to_string_array`）、interleave 重组。`EmissionType::Incremental`（流式）——STK 是 Final（全收完再发）。

**ctid/heap 的 deferral 是另一条线**：`VisibilityMode::Deferred` 让 scan 的 ctid 列输出 packed DocAddress，join 后由 `VisibilityFilterExec` 批量解析 + MVCC 检查。**"晚物化"在这个版本里是"字典解码推迟"与"heap 访问推迟"两个正交机制**。

### PreFilter：ordinal 上的谓词求值

两种机制（模块 doc，`pre_filter.rs:27-40`）：
1. **Query-Time（倒排）**：静态可知的过滤（典型 HashJoin build 侧完成的 `InList`）转成 tantivy `TermSetQuery` AND 进主查询——**搜索时就剪枝**。带成本门：>20,000 distinct 值放弃、会退化成 LinearScan 时直接 Skip（丢谓词——上层 hash join 反正会复查）；
2. **Pre-Filter（fast field）**：STK 的**演化中阈值**无法事前转查询，就在**搜索之后、列物化之前**应用。`is_supported`（:428）白名单（Column/Literal/比较/逻辑/IsNull/InList/HashTableLookup——CAST/LIKE/UDF 一律拒绝）。执行不走自研求值，而是**改写后交给 DataFusion 原生 kernel**：`rewrite_col_op_lit`（:642）把字符串字面量比较翻译成**本段 ordinal 边界**（`col < 'abc'` → `col >= lo_ord AND col <= hi_ord` 的 UInt64 比较）——"Postgres filter → tantivy 可执行谓词"的转换面 = 能落到 fast-field 数值比较或 term-ordinal 边界的谓词。STK 的全局阈值下发后，正是这个改写把字符串阈值翻回 ordinal 边界才在扫描层生效——闭环成立的关键一环。

### PgSearchTableProvider 与执行计划

`PgSearchTableProvider`（`table_provider.rs:72`）把 BM25 索引暴露成 DataFusion 表：`scan_inner`（:593）合并 base 查询与 join 级谓词、解参数、开 SearchIndexReader、构造 FFHelper + VisibilityChecker，`create_lazy_scan` 出 `PgSearchScanPlan`。**双相 schema**（:100-116）：Phase 1 给 SQL planner 看 Utf8View（否则 TypeCoercion 对 Union panic），Phase 2 由 LM 规则翻开关后返回 Union 物理 schema。分区数 = `min(segment_count, target_partitions)`。

`PgSearchScanPlan`（`execution_plan.rs:147`）叶子算子：`handle_child_pushdown_result`（:1117）接收动态过滤器（Top-K 阈值收紧即刻生效——每轮循环 `build_filters` 重新解析最新阈值）；`reader.search_lazy` 支持段级 lazy checkout。`UnsafeSendStream`（:1250）unsafe Send 包装——**Postgres 扩展单线程执行是其安全前提**。

`Scanner`（`batch_scanner.rs:139`）：`next`（:270）顺序 **pre-filter → 批量取 ctid → VisibilityChecker::check_batch → 构造 Batch**；字符串列只存 ordinal UInt64Array（memoization）配合 `compact_with_mask` 原地压缩。batch size：全字符串 deferred 时 8192，否则 128,000。

### codec：计划序列化（非 Arrow↔Datum）

**勘误**：`codec.rs`/`physical_codec.rs` 不是 Arrow↔Datum 转换（那在 `postgres/types_arrow.rs::arrow_array_to_datum`）——是 **DataFusion 计划的 proto codec**，供 MPP leader 把各 stage 子计划发给 worker：`LogicalExtensionCodec`/`PhysicalExtensionCodec` 处理自定义节点的序列化，活的 FFHelper/ctid resolver 不随行——worker 从解码子树按 indexrelid 重新接线（`SegmentedTopKExec::decode_for_dispatch` 靠 proto 去重转换器保持 dynamic filter **同实例共享**，否则 worker 的 top-k 阈值就断了线）。

### range_partitioning / visibility_ctid_resolver

`RangePartitioning`（:38）：静态范围分区——`partition_by` 字段 + split_points，`partition_bounds`（:52）把分区翻译成 `Query::Range`（"每分区一个带范围谓词的查询"）；同时声明 DataFusion `Partitioning::Range` 让 `RangeCoPartitionedJoinRule` 把 CollectLeft join 翻成共分区 join 免 broadcast。与默认的 `ParallelScanState` 动态段 checkout 相对（"静态按值分区 vs 动态按段领取"）。`VisibilityCtidResolverRule`：无结构改动的接线规则——deferred visibility 下把 DocAddress 解析成真 ctid 的 FFHelper 接到 STK/VFExec 上，必须在 execute() 之前跑完。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| best-of-worst 阈值闭环 | STK ↔ PgSearchScanPlan 共享 Arc\<DynamicFilter\> | 扫描端自适应剪枝 |
| schema 双相 | Utf8View → Union | 骗过 TypeCoercion 再翻物理型 |
| 冒泡-锚定 | LM 规则 | deferral 的最大范围传播 |
| ordinal 边界改写 | pre_filter 的 rewrite_col_op_lit | 字符串谓词落到整数域 |
| 计划序列化重接线 | physical_codec | MPP 跨进程的活性句柄问题 |

## 模块间交互

上游计划由 [CustomScan](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/02-customscan) 的 scan_state 构建并注册规则（Join profile：`VisibilityFilterOptimizerRule → RangePartitioningRule → LateMaterializationRule` + `SegmentedTopKRule`）；底层 reader/FFHelper 来自 [索引层](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/01-index-storage)；查询 IR 由 [API 层](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/04-api-schema) 的 operator 产出。

## 扩展方式

**新增一种查询语法**（pdb::Query 加变体）：enum 加变体（serde snake_case 即 JSON 语法）→ `into_tantivy_query` 的 match 加分支 + 构造函数 → `is_expensive_to_estimate`/`selectivity_heuristic` 同步（编译器强制）→ 若需操作符修饰，`apply_fuzzy_data/apply_slop_data` 处理。**执行层通常零改动**——scan/ 消费的是 tantivy Query 结果，与具体语法正交。
