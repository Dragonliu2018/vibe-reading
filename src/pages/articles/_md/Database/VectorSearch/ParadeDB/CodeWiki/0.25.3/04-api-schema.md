---
source:
  type: "源码解读"
  project: "ParadeDB"
  url: "https://github.com/paradedb/paradedb"
title: "API 与 Schema"
date: "2026-09-21T23:37:43+08:00"
category: [Database, VectorSearch, ParadeDB, CodeWiki, "0.25.3"]
contentType: "CodeWiki"
tags: ["ParadeDB", "pgrx", "tokenizer", "PostgreSQL"]
description: "ParadeDB API 层解读——@@@ 操作符族的 SUPPORT 计划期改写、tokenizer 做成 PG 类型而非 DDL、SearchIndexSchema 类型映射表（numeric 双轨/ctid 强制 fast field）、boost/fuzzy/slop 的 typmod 魔法"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/00-overview)

---

## 模块定位

`pg_search/src/api/`（30 文件 12K 行）+ `src/schema/` + `src/bootstrap/` + `src/aggregate/` + `src/vector/` + `src/parallel_worker/` + `src/gucs.rs` + 顶层 `macros/`。用户可见的 SQL DSL、索引 schema 映射、启动注册、聚合 UDF、向量检索。

**重要事实修正**：0.25.x 没有名为 `paradedb.search()` 的函数。BM25 查询 DSL = **一族自定义操作符（`@@@`、`&&&`、`|||`、`===`、`###`、`##`）+ 两套构建器函数**（`paradedb.*` schema 产 SearchQueryInput，`pdb.*` schema 产字段无关的 pdb::Query）。操作符注册在 pg_catalog（`extension_sql!` 块 `bm25_ops_anyelement_operator` in `api/operator.rs:1172`）。

## 模块架构

### 三层查询类型模型

- **`pdb::Query`**（`query/pdb_query/pdb.rs`）：字段无关"半成品"（UnclassifiedString/Array、Term/Match/Phrase/Regex/Range 族/FuzzyTerm/TermSet…）；
- **`SearchQueryInput`**（`query/mod.rs`）：Postgres 一等公民类型（pgrx PostgresType）= pdb::Query + FieldName 包装 + 顶层组合子（Boolean/Boost/ConstScore/DisjunctionMax/MoreLikeThis/WithIndex）。**可直接从 jsonb 隐式转换**（`jsonb_to_searchqueryinput` in `api/builder_fns/paradedb.rs:324`）——jsonb 风格 API 的逃生通道；
- **`paradedb.fieldname`**（`FieldName` in `api/mod.rs:127`）：字符串包装，带 `root()/path()` 拆 json 路径。

## 核心实现

### 操作符 → 计划期改写（设计的灵魂）

每个操作符的"真函数"都是**永不执行的占位 panic 函数**（`search_with_parse` in `api/operator/atatat.rs:37`），真正逻辑在 **planner support function**（PG 12+ 的 `SupportRequestSimplify` 钩子）。核心 `request_simplify`（`api/operator.rs:696`）：

1. 从 SupportRequestSimplify 拿 lhs/rhs；
2. `tantivy_field_name_from_node`（:416）解析 lhs 是哪个索引字段：直接 Var → 列名；`varattno==0`（整行）→ **key_field**；索引表达式（`CREATE INDEX ... USING bm25 (id, body::pdb.simple)`）→ 复合类型字段名或 `pdb.alias` 别名；jsonb path（`json_col->'foo'->>'bar'`）→ `foo.bar` 拼接；多候选歧义时报错要求显式 `::pdb.alias`；
3. `rewrite_rhs_to_search_query_input`（:884）：rhs 是 Const 就**编译期折叠**成 SearchQueryInput；Param/复杂表达式生成运行时求值的 FuncExpr；
4. **重写成统一的 `@@@(anyelement, searchqueryinput)` OpExpr**，并用 `wrap_with_index`（:834）把索引 OID 织入查询（供 seqscan 场景显式指定索引）。

各操作符语义：`@@@` 通用 BM25 match（裸文本走 tantivy query string 语法）；`&&&` 所有 token 都出现（conjunction）；`|||` 任一出现；`===` 精确 term 匹配（不经分词）；`###` phrase 词组；`##`/`##>` 近邻（lhs 是 ProximityClause 复合类型）。

### RHS 修饰类型：typmod 魔法

`'beer'::boost(3)`、`'beer'::fuzzy(2)`、`['a','b']::slop(1)`——**携带 typmod 参数的类型转换**（`BoostType` in `api/operator/boost.rs:30`，`f16_typmod::serialize_f32_to_i32` 把 f32 boost 编进 typmod）。这些类型能叠加在任何 Unclassified 查询上（`apply_fuzzy_data/apply_slop_data`——`Term` 就地改写为 `FuzzyTerm`、`TermSet` 改写为 OR 的 MatchArray）。

### 慢路径与代价抬价

重写后的真函数 `search_with_query_input`（`api/operator/searchqueryinput.rs:145`）**只在优化器放弃 BM25 索引、退化为逐行 filter 时执行**：用 `pg_func_extra` 按查询字节缓存 `KeySet`（`keyset.rs:34`：内存 HashSet，超 work_mem 溢出临时文件 + 稀疏索引二分探测）逐行判断，发 `warn_sequential_scan` 警告。**代价函数把 per-tuple 成本设为 1 亿**（`paradedb.per_tuple_cost` 默认）——故意把 filter 路径抬到天上，逼优化器优先选索引扫描；selectivity 走真实打开 SearchIndexReader 算 matching/total docs（贵查询走启发式）。

### Tokenizer：PG 类型而非 DDL

**pg_search 不是"create tokenizer"动态注册，而是把每种 tokenizer 做成 Postgres `CREATE TYPE` 静态类型**：`pdb.simple/lindera/jieba/ngram/edge_ngram/regex_pattern/icu/whitespace/literal/chinese_compatible/source_code/unicode_words/alias`——CATEGORY='t'。`define_tokenizer_type!` 宏（`api/tokenizers/definitions.rs:240`）生成类型 + 全套 cast（json/jsonb/uuid/text[] → tokenizer 的 ASSIGNMENT cast、tokenizer → text[] 的 IMPLICIT cast 触发实际分词）。参数进 typmod：`body::pdb.ngram(min=2,max=3,lowercase=true)` 的 `apply_typmod`（`api/tokenizers/mod.rs:383`）。`DatumWithType`（definitions.rs:49）是个魔法包装（magic `"err\0"`）：tokenizer 类型的 datum 实际包着原类型数据 + 原 OID——`body::pdb.simple` 既保住原始值又标记分词方式。实际分词实现在独立 crate `tokenizers/`（lindera 中日韩字典 + tantivy-jieba + opencc 简繁转换），`SearchTokenizer` enum 是 serde 可序列化配置，经 `to_tantivy_tokenizer()` 注册进 tantivy 的 TokenizerManager。**没有 CREATE TOKENIZER DDL**。

### SearchIndexSchema：类型映射表

`SearchFieldType`（`schema/mod.rs:60`）→ tantivy 字段（`create_index` in `postgres/build.rs:315`）：

| PG 类型 | SearchFieldType | tantivy field |
|---------|-----------------|---------------|
| text/varchar | Text | `add_text_field`（Str + TextFieldIndexing） |
| tokenizer cast | Tokenized(oid,typmod) | inner json→json field 否则 text |
| json/jsonb | Json | `add_json_field`（expand_dots 开） |
| int2/4/8 | I64 | `add_i64_field` |
| float4/8、enum | F64 | `add_f64_field` |
| **numeric(p≤18)** | **Numeric64(scale)** | `add_i64_field`（定点缩放整数） |
| **numeric(p>18)** | **NumericBytes(scale)** | `add_bytes_field`（字典序保序 bytes） |
| uuid/ltree | →text / →**facet** | text / `add_facet_field` |
| inet | Inet | `add_ip_addr_field` |
| timestamp/date（≥0.24.1） | I64 微秒 | `add_i64_field`（版本阈值决定，`api/version.rs:31`） |
| range 类型 | Range | `add_json_field` + set_fast("raw") |
| pgvector | Vector(dims,metric) | `add_vector_field` |

**ctid 是强制隐藏 U64 fast field**（`build.rs:368` 的 `builder.add_u64_field("ctid",...)`）——MVCC 过滤/聚合 cardinality 快路径/Vacuum/verify 全靠它反查 heap。默认 `sort_by = ctid ASC NULLS FIRST`（转 tantivy IndexSortByField 使 segment 物理有序）。per-field BM25 k1/b 经 `apply_bm25` → `Bm25Params::new`（`schema/config.rs:317`）。

### bootstrap 与 _PG_init

真正的启动在 `lib.rs:110` 的 `_PG_init()`：(1) **强制 shared_preload_libraries 加载**（:128，否则 error——custom rmgr 只能 preload 时注册）；(2) options/build_logging/gucs 初始化；(3) custom_rmgr 注册（PG17+）；(4) **custom scan 注册**：register_rel_pathlist(BaseScan) / register_upper_path(AggregateScan) / register_join_pathlist(JoinScan) / register_subplan_join_pathlist / register_window_aggregate_hook / init_filter_query_builder。bm25 access method 的 handler 在 `postgres/build.rs` 经 pgrx SQL 图安装时注册；`bootstrap/mod.rs` 只剩 `create_bm25_test_table`（1,099 行的测试数据生成器）。`pg_search/sql/` 下 100+ 个版本迁移脚本（0.15.0 → 0.25.3）。

### 向量与聚合

**与 pgvector 是"类型级依赖、非编译依赖"**：`PgVector`（`vector/mod.rs:29`）手工解析 pgvector varlena 布局；`to_regtype('vector')` 探测未装则优雅退化。**索引侧聚类**：`SuperKMeansIvfClusterer`（`vector/clusterer.rs:42`，superkmeans 分层 K-Means，SPANN 风格），merge 时段内 ≥500 docs（`vector_clustering_threshold`，覆盖 tantivy 的 10000）从 flat 切到 IVF。**混合 BM25+向量**：同一索引里 `@@@` 过滤 + `ORDER BY embedding <-> $vec` TopK。聚合：COUNT/SUM/AVG/MIN/MAX 在 tantivy fast field 上直算（`aggregate/mod.rs:356`），NUMERIC 例外走 DataFusion 后端；按 segment checkout 并行、worker 产中间结果经 shm_mq 回传合并。

### macros/（proc-macro）

两个宏，没有 `#[pg_search]`：**`#[builder_fn]`**——贴在 `#[pg_extern]` 函数上，自动生成 `_bfn` fielded 版本（`fn foo(x) -> pdb::Query` 自动获得 `foo(field: FieldName, x) -> SearchQueryInput`——这就是"pdb.* + paradedb.* 成对出现"的机制）；**`generate_tokenizer_sql!`**——把"每个 tokenizer 15+ 条 DDL"压成一个宏调用。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| SUPPORT 函数改写 | operator.rs:696 | 计划期 const-fold，一条路径喂两种 scan |
| 代价抬价 | per_tuple_cost=1e8 | 慢路径只在绝境走 |
| typmod 承载参数 | boost/fuzzy/slop + tokenizer | 复用 PG cast 基建免发明 DDL |
| 类型级软依赖 | to_regtype 探测 pgvector | 未装扩展优雅退化 |
| builder_fn 宏 | macros/ | 字段化/非字段化成对生成 |

## 模块间交互

operator 的 SUPPORT 改写产物（SearchQueryInput Const）被 [CustomScan](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/02-customscan) 的 qual_inspect 消费；SearchIndexSchema 被 [索引层](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/01-index-storage) 的 build/reader 消费；parallel_worker 被 aggregatescan 与索引构建（build_parallel）共用。

## 扩展方式

**给 search operator 新增一种查询能力**（如 `pdb.wildcard`）：pdb::Query 加变体 + tantivy 降级 → `#[builder_fn] #[pg_extern(name="wildcard")]` 非字段化构建器（宏自动生成 paradedb.wildcard(fieldname,...)）→ operator 集成（const_rewrite 加分类分支，参照 atatat_support 的 UnclassifiedString 处理）→ selectivity 的贵查询启发式挂进 → 测试数据 + 迁移脚本。
