---
source:
  type: "源码解读"
  project: "ParadeDB"
  url: "https://github.com/paradedb/paradedb"
title: "查询数据流"
date: "2026-09-21T23:37:43+08:00"
category: [Database, VectorSearch, ParadeDB, CodeWiki, "0.25.3"]
contentType: "CodeWiki"
tags: ["ParadeDB", "查询执行", "Late Materialization"]
description: "ParadeDB 一次 BM25 查询的端到端数据流——operator 求值、planner hook 拦截、DataFusion 翻译与规则改写、tantivy 逐段评分、SegmentedTopK 归并与 top-k 回表的完整链路"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/00-overview)

---

## 模块定位

本文串起四个层的完整链路，回答"一条 `@@@` 查询从 SQL 到结果集到底怎么走"。前置阅读：[CustomScan](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/02-customscan)（拦截与下推判定）、[scan 执行](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/03-scan-exec)（物理算子细节）。

## 完整调用链

```
SELECT * FROM items
WHERE items.description @@@ paradedb.term('keyboard')
ORDER BY paradedb.score(description) DESC LIMIT 10;
（注意：v0.25.x 无 paradedb.search() 函数，操作符是 @@@；旧文档的 search() @@ 语法
 对应本版的 with_index/直接 @@@ 写法）
│
├─ ① SQL 解析与操作符求值（api/operator.rs）
│   search_with_parse 是占位 panic 函数——永不执行
│   atatat_support（SupportRequestSimplify 钩子，api/operator/atatat.rs:54）：
│     tantivy_field_name_from_node 解析 lhs（Var → 列名 / 整行 → key_field）
│     rhs 的 paradedb.term(...) 求值成 SearchQueryInput Const（编译期折叠）
│     → 重写成统一的 @@@(anyelement, searchqueryinput) OpExpr + 索引 OID 织入
│
├─ ② Planner 拦截（postgres/customscan/hook.rs:124）
│   paradedb_rel_pathlist_callback（set_rel_pathlist_hook）
│     → basescan/mod.rs:670 create_custom_path：
│        extract_quals（qual_inspect.rs:834）抽 @@@ → Qual::OpExpr
│          → uses_our_operator = true（custom scan 准入券）
│        pullup_topk_pathkeys：ORDER BY paradedb.score() DESC 可排序 ✓
│        LimitOffset::from_root：LIMIT 10 可下推 ✓
│        choose_exec_method（basescan/mod.rs:2120）→ ExecMethodType::TopK
│        estimate_selectivity_and_cost：打开 Tantivy 真实问 selectivity
│        add_path 用 Flags::Force（hook.rs:40）清空原生路径
│     → CustomPath（含序列化的 PrivateData）
│
├─ ③ DataFusion 计划构建（joinscan/scan_state.rs 的 build_base_session 注册）
│   BaseScan 的 TopK 路径不走完整 DF 计划——直接用 SearchIndexReader
│   （JoinScan 路径才全量翻译：datafusion/translator.rs 的
│    PredicateTranslator + PgSearchTableProvider + 逻辑/物理优化规则）
│   TopK 的优化在 reader 内部：topk_can_prune_for_method 判定
│   仅 score DESC → Block-WAND 使其亚线性
│
├─ ④ BeginCustomScan → 执行（basescan/mod.rs:124 init_search_reader）
│   MvccSatisfies::Snapshot 打开 MVCCDirectory → SearchIndexReader
│   init_exec_method → TopKScanExecState（exec_methods/top_k.rs）
│
├─ ⑤ Tantivy 查询执行（index/reader/index.rs + query/pdb_query.rs:441）
│   SearchQueryInput::Term{field:"description", value:"keyboard"}
│     → into_tantivy_query → TermQuery（倒posting list）
│   逐 segment（或并行 worker 按 segment 认领）：
│     BM25 scorer 打分（k1/b 参数）
│     TopK collector + Block-WAND 剪枝 → 每段 top-10
│   段间归并 → 全局 top-10 的 (score, doc_id)
│
├─ ⑥ score/ctid 从 fast field 取（index/fast_fields_helper.rs）
│   FFType::new 按 FFIndex 惰性打开列
│   doc_id → ctid（U64 fast field，build.rs:368 强制写入的隐藏列）
│   paradedb.score(description) 占位符替换：从 score fast field 取回
│
├─ ⑦ 回表（Normal 路径）或虚拟元组（Columnar 路径）
│   TopK 方法：executor 的 ExecProject 阶段对 10 行做 heap fetch
│     （VisibilityChecker::resolve_visible 走 HOT 链 + VM 位图）
│   Columnar 方法：全 fast field 覆盖时直接产 Virtual slot（免 heap）
│   → ExecState::{FromHeap, Virtual}（exec_methods.rs:24）
│
└─ ⑧ 返回：TupleTableSlot → 10 行（score DESC 排序）
```

## JoinScan 变体（LM 全链路）

若查询是 join + ORDER BY + LIMIT（如 `SELECT a.* FROM a JOIN b ON a.id=b.id WHERE a.title @@@ t1 AND b.body @@@ t2 ORDER BY paradedb.score(a.title) LIMIT 10`），走 `joinscan/scan_state.rs:329` 的完整 DataFusion 管线：

1. **翻译**：JoinCSClause（planner 期构建的 IR）→ DataFusion LogicalPlan；
2. **逻辑优化**：`VisibilityFilterOptimizerRule → RangePartitioningRule → LateMaterializationRule`——LM 规则把 TableScan 的 schema 从 Utf8View 翻成 `Union(doc_address, term_ordinal)`，Union 类型冒泡穿过透传节点，在求值点锚定 LateMaterializeNode；
3. **物理优化**：`RangeCoPartitionedJoinRule → VisibilityCtidResolverRule → SegmentedTopKRule`——STK 规则在 SortExec(fetch=10) 下注入 SegmentedTopKExec 并拆掉原 Sort；
4. **执行**：`HashJoinExec ← PgSearchScanPlan × 2`——hash join 的 build 侧完成后动态过滤经 `DynamicFilterPhysicalExpr` 下推到扫描端；字符串列全程以 term ordinal 流动，**只有最终 10 行**在 TantivyLookupExec 做字典解码 + heap fetch。

## 每步数据类型

| 步骤 | 类型 |
|------|------|
| SQL → planner | Postgres OpExpr（`@@@(anyelement, searchqueryinput)`） |
| qual 抽取 | `Qual::OpExpr`（Rust IR） |
| 查询 IR | `SearchQueryInput::Term{...}`（serde JSON 可序列化） |
| tantivy | `TermQuery` → `TopDocs`（doc_id + score） |
| fast field | `(score: f32, ctid: u64)` 的 Arrow 列 |
| LM 路径 | `Union(UInt64 doc_address, Struct term_ordinal)` |
| 回表 | ctid → heap tuple → TupleTableSlot |

## 并行执行

BaseScan 并行：`compute_nworkers`（`customscan/parallel.rs:49`）= `segment_count - 1`（按 LIMIT 封顶）；worker 经 DSM 从 `ParallelScanState::checkout_segment_for_source` 惰性认领 segment；各 worker 独立 TopK，leader Gather 归并。JoinScan/AggregateScan 的 MPP：leader 自起 producer worker，按 join key hash 分区经 shm_mq mesh 洗牌。

## 与普通 Postgres 执行的对比

不命中 custom scan 时：`@@@` 退化为 `search_with_query_input`（`api/operator/searchqueryinput.rs:145`）逐行 filter——KeySet 缓存命中判断，**per-tuple 代价 1 亿**（故意抬价）+ sequential scan 警告。这条慢路径保证语义正确性——custom scan 的所有下推判定（三级 Qual 分类、proptest 逻辑等价）都以它为底线。
