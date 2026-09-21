---
source:
  type: "源码解读"
  project: "ParadeDB"
  url: "https://github.com/paradedb/paradedb"
title: "CustomScan 查询劫持"
date: "2026-09-21T23:37:43+08:00"
category: [Database, VectorSearch, ParadeDB, CodeWiki, "0.25.3"]
contentType: "CodeWiki"
tags: ["ParadeDB", "CustomScan", "DataFusion", "查询下推"]
description: "ParadeDB CustomScan 解读——四层 planner hook、Qual 三级下推判定、Force flag 路径注入、三类 scan（base/aggregate/join）、DataFusion 计划翻译与内存对接、MPP 跨进程并行的完整内幕"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/00-overview)

---

## 模块定位

`pg_search/src/postgres/customscan/`（~41K 行）是 ParadeDB 的**性能核心**：通过 Postgres 的 CustomScan/CPath hook 体系，把含 BM25 谓词的查询（乃至整条 join/聚合管线）"劫持"出 Postgres 原生执行器，改由 Tantivy + DataFusion 执行——实现 PDQ 风格的下推与 late materialization。

## 模块架构

![CustomScan 三形态](/vibe-reading/images/articles/paradedb-internals/customscan-pipeline.svg)

### 四层 hook（hook.rs）

| Hook | 注册函数 | 服务的 Scan |
|------|---------|-----------|
| `planner_hook`（全局最顶层） | `paradedb_planner_hook`（hook.rs:550） | 窗口函数替换（pdb.agg → `window_agg(json)` 占位），在 grouping_planner 之前 |
| `set_rel_pathlist_hook` | `paradedb_rel_pathlist_callback`（:124） | BaseScan（单表 BM25 路径） |
| `set_join_pathlist_hook` | `paradedb_join_pathlist_callback`（:203） | JoinScan（整棵 join 树换 DataFusion） |
| `create_upper_paths_hook` | `paradedb_upper_paths_callback`（:283） | AggregateScan（只认 UPPERREL_GROUP_AGG） |

所有 hook 先保存 `PREV_HOOKS` 再链式调用（与 Citus 等扩展共存），以各自 GUC（`enable_custom_scan` / `enable_join_custom_scan` / `enable_aggregate_custom_scan`）做早退门。planner_hook 还负责 planner_warnings 的收集与去重输出（成功规划的表别名抑制同别名的失败警告——"为什么没用 custom scan"的 NOTICE 机制）。

**路径注入的"作弊"机制**：`add_path`（hook.rs:40）使用私有 flag `Flags::Force`(0x0008)——**直接清空 rel 的 pathlist**。因为自家 CustomPath 与原生路径不可互换（TopK、score/snippet 常量投影、`Qual::All` 时必须由我们执行），否则诚实的成本反而让 PG 自己的 BM25 index scan 赢（correct 但没有 fast-field/Block-WAND）。`Flags::OfferParallel` 表示并行 partial path 允许 PG 拒绝；`ParallelOnly` 则塞 cost=1e9 的串行 stub 迫使 Gather 胜出。

## 核心实现

### qual_inspect：三级分类的下推判定（灵魂）

`extract_quals`（qual_inspect.rs:834）把 Postgres 表达式树按节点 tag 解析成 `Qual` IR：BoolExpr→And/Or/Not；List→隐式 AND 扁平化；OpExpr→按 lhs/rhs 分类（`@@@` 族 RHS 是 Const 里的 SearchQueryInput 即 `Qual::OpExpr`；lhs 是 `pdb.score()` → `Qual::ScoreExpr`；RHS 含 Var → 拒绝或 join 场景 `Qual::ExternalVar`）；NullTest→PushdownIsNotNull；BooleanTest 的三值逻辑差异处理。

**三级分类状态** `QualExtractState`：`uses_our_operator`（真正属于索引的谓词——custom scan 的准入券）/ `uses_tantivy_to_query`（仅诊断标记——ltree `<@` 这类可降级的普通 PG 操作不算 our_operator）/ `uses_heap_expr`（须 heap 过滤，受 `enable_filter_pushdown` GUC 门控）。

**pushdown.rs**（`try_build_pushdown_qual`，:249）把**非** `@@@` 的普通 PG 运算符转为可下推查询：`lookup_operator` 查 OID→Tantivy 运算符表（`=`/`>`/`<`/…覆盖 int/float/date/text/uuid 等类型对）；守卫规则（:306-321）：tokenized text 不可下推（keyword/numeric_bytes 除外）；非 fast 的 JSON 字段不支持 range。成功则合成调 `paradedb.term_with_operator` 的 FuncExpr。**降级链**（`try_pushdown`，:1375，注释自称 "Critical decision point"）：索引下推失败 → 引用本关系且开了 pushdown GUC → `Qual::HeapExpr`（heap 上由 PG 执行器评估，`search_query_input: All` 即先全扫索引再过滤）；否则 ExternalExpr 或放弃。`optimize_quals_with_heap_expr`（:1944）第二遍优化：AND 分支里把已下推谓词合并进 HeapExpr 的 `HeapFilter{indexed_query, field_filters}`——让 heap 过滤搭上索引过滤的便车。

**否定语义**（:269-481）：`NOT(field @@@ q)` → `field exists AND NOT q`——用 `must_not + ConstScore(Exists,0.0)` 守卫保持 PG 三值 NULL 语义，仅对非数组非 JSON 的 fast 字段加守卫。配有 proptest 逻辑等价测试。

**pullup.rs** 名字有误导性——是"**值从索引拉上来**"：`resolve_fast_field`（:42）判定某列能否从 Tantivy fast field 直接取值（ctid/tableoid 系统列、普通列、表达式索引列），这是 Columnar 执行与 JoinScan"全 fast field 才行"判定的基础。

**solve_expr.rs**：`Qual::Expr` 转成 `SearchQueryInput::PostgresExpression` 后，BeginCustomScan 里 `ExecInitExpr + ExecEvalExpr` 求值（NULL → Empty）——参数化查询的运行时解析。

### 三类 Scan

**BaseScan**（`basescan/mod.rs`，create_custom_path :670）：restrict_info 抽 qual → RTE 须有 `USING bm25` 索引 → `pullup_topk_pathkeys` 判定 ORDER BY 可排序性 + `LimitOffset::from_root` 判定 LIMIT 可下推 → `choose_exec_method`（:2120）在 **TopK / Columnar / Normal** 三种 ExecMethod 间选择 → 对每 method 用 `estimate_selectivity_and_cost`（**真正打开 Tantivy 问 selectivity**，经 CostMemo 备忘）+ `decide_scan_parallelism`。成本公式（`basescan/cost.rs`）：`drive_cost × drive_fraction + base_result_rows × per_tuple_cost`——Columnar 用 `cpu_index_tuple_cost`（纯 fast field 不碰 heap），其余 `cpu_tuple_cost`。TopK 干净形态（仅 score DESC）**强制串行**——因为 Block-WAND 使其亚线性（`topk_can_prune_for_method`，cost.rs:218）。执行三方法：top_k.rs（TopK collector）、fast_fields/columnar.rs（纯 fast field 产 virtual tuple，MVCC 由 visibility map 保证）、normal.rs（ctid → heap）。

**AggregateScan**（`aggregatescan/mod.rs`，:212）：**双后端路由**——Tantivy 后端（默认，GROUP BY 走 tantivy aggregation，受 `max_term_agg_buckets` 桶上限）或 DataFusion 后端（四条路由：分组数超桶上限 / 聚合列 ORDER BY+LIMIT（DF 原生 TopK `SortExec(fetch=K)`）/ NUMERIC 聚合（tantivy 只会 f64，走 `numeric64_sum_udaf`）/ 多表聚合必走 DF）。

**JoinScan**（`joinscan/`，README 是权威设计文档）：触发条件（`try_build_join_custom_path`）：至少一侧有 search 谓词 + **必须有 equi-join key**。规划期构建可序列化 IR `JoinCSClause`（build.rs：RelNode join 树 + JoinLevelExpr 谓词树 + ORDER BY + LIMIT）存 `custom_private`。执行期翻成 DataFusion logical plan，再过四个自定义物理优化规则：`RangePartitioningRule`（MPP 范围分区对齐）、`LateMaterializationRule`、`RangeCoPartitionedJoinRule`（CollectLeft→Partitioned）、`SegmentedTopKRule`（注入 SegmentedTopKExec，动态阈值过滤经 `Arc<DynamicFilterPhysicalExpr>` 下推到 scanner，甚至把字符串阈值翻译成 per-segment term ordinal bound 做过滤前剪枝）。

### DataFusion 桥

**translator.rs**：`PredicateTranslator::translate`（:294）把 PG 表达式树译成 DataFusion Expr（T_OpExpr/T_Var/T_Const/Case/Coalesce/T_CoerceViaIO…）。**本地翻译失败就地回退 `try_wrap_as_udf`**——把整个子树包成 `PgExprUdf`（`pg_expr_udf.rs`：ScalarUDF 内部对每行调 PG 的 `ExecEvalExpr`，Datum↔Arrow 转换）——既保 PG 语义（collation 敏感的 upper/lower 故意不映射）又不放弃翻译。跨类型比较（INT < NUMERIC）显式拒绝（类型转换改变值语义）。`SearchPredicateUDF` 把 `@@@` 查询包成作用于 ctid 列的 UDF，从而被 DataFusion 的 filter pushdown 推到 TableProvider。

**memory.rs**：DataFusion memory pool 接 PG `work_mem`：`WorkMemMemoryPool` 包 `GreedyMemoryPool`，`try_grow` 超限报 `ResourcesExhausted`（查询失败而非 panic——MPP worker 里 panic 曾直接打死整个 server）。`create_memory_pool` 遍历物理计划估算预算（HashJoinExec 每分区 `work_mem × hash_mem_multiplier`）。同时**禁用 disk manager**——不落未跟踪的临时文件。保守但正确：超 work_mem 报错而不是失控。

### 并行与 MPP

**parallel.rs**：`compute_nworkers`（:49）——worker 数 = `segment_count - 1`，按 LIMIT（仅非排序）和 `min_rows_per_worker`（~30 万）封顶；segment 以 `ParallelScanState::checkout_segment_for_source` 惰性认领。**dsm.rs**：`ParallelQueryCapable` trait + 四个 DSM 回调泛型壳。

**MPP**（`mpp/`，JoinScan/AggregateScan 的跨进程并行）：**放弃 DataFusion 进程内多线程**（PG 已用 Gather 起了独立并行进程，线程级并行会 Workers × Threads 爆炸，且 PG API 只能在主线程调），改用 `datafusion-distributed` crate 的 shm 传输：`launch.rs` leader 经 `ParallelProcessBuilder` 自起 producer worker；**plan-first**（#5667）：先构建 distributed 物理计划切网络 stage，再走查计划得最大 task 数定 worker 数；数据面按 join key hash 分区，worker 间经 PG `shm_mq` 环形 mesh 洗牌中间行；死锁靠协作式内联排空。逻辑计划可序列化（codec），worker 拿字节流重建执行。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| hook 链 | PREV_HOOKS 保存链调 | 与其它扩展共存 |
| Force flag 私有协议 | `add_path`（hook.rs:40） | 不可互换路径的强制选择 |
| 三级 Qual 分类 | qual_inspect.rs | 下推边界的判定中枢 |
| 双遍优化 | HeapExpr 合并 | 下推谓词搭便车 |
| UDF 回退 | PgExprUdf | 翻译失败保 PG 语义 |
| 双后端路由 | aggregatescan | tantivy 快路径 + DF 能力路径 |

## 模块间交互

上游消费 [索引层](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/01-index-storage) 的 SearchIndexReader/cost 估算；产出 DataFusion 计划交给 [scan 执行](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/03-scan-exec) 的物理算子；qual 抽取依赖 [API 层](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/04-api-schema) 的 operator SUPPORT 改写产物。

## 扩展方式

**新增一种可下推表达式**（如 `field @> 'value'`）：`opexpr.rs` 运算符表加类型对（或专用分支仿 ltree `<@`）→ Qual 加变体 + `From<&Qual> for SearchQueryInput` 降级 → pdb::Query 加对应查询类型 → 若涉及 join 路径在 `expr_translators.rs` 加映射（或明确返回 None 让 PgExprUdf 回退保语义）→ proptest 逻辑等价测试。**加一种表达式基本只碰前三处，planner hook 与三类 scan 框架不动**——这是该架构维护性的核心证据。
