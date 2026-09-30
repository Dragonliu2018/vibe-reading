---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "SQL 引擎"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "OceanBase", "C++", "查询优化器", "MySQL 兼容"]
description: "MySQL 兼容流水线上的检索语义扩展：T_COLLECTION 复用的 VECTOR 语法、APPROXIMATE 免 Sort 下压、hybrid 融合下沉为单 TableScan 的 DAS attach 树、表达式双工厂与向量化执行"
readingTime: "35 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

`src/sql/`（~99 万行）完整继承 OceanBase 的 MySQL 兼容流水线：parser → resolver → rewrite → optimizer → code generator → 向量化执行器，另含 DAS 数据访问服务、px 并行执行、plan cache 与 PL 引擎的关联部分。seekdb 的检索能力全部以「最小侵入」方式挂在这条流水线的三个点位上——**语法层**复用既有节点打 tag（VECTOR 类型复用 `T_COLLECTION`）、**表达式层**经双工厂注册、**计划层**把向量/全文扫描编码进单个 `ObLogTableScan` 的 attach 结构而不新增任何逻辑算子。读这一模块要抓住的主线是：一条 `SELECT ... ORDER BY l2_distance(...) APPROXIMATE LIMIT 10` 从解析树到物理计划的每一处 seekdb 增量，以及为什么「融合检索」最终只产生一个 TableScan。

## 模块架构

```shell
src/sql/
├── parser/                      # flex sql_parser_mysql_mode.l + bison sql_parser_mysql_mode.y
│   ├── ob_fast_parser.cpp       # 快速参数化（plan cache 键提取）
│   ├── ob_parse_simd.cpp        # SIMD 加速 token 化
│   └── ftsblex.l + ftsparser.y  # MATCH AGAINST 查询词切分 DSL（支持 ngram）
├── resolver/                    # 七类子目录（cmd/dcl/ddl/dml/expr/prepare/tcl）
│   └── ddl/                     #   ob_vec_index_builder_util / ob_fts_index_builder_util / ob_fts_parser_resolver
├── rewrite/ob_transformer_impl  # 改写器（semantic_distance 在 ob_transform_pre_process.cpp 改写）
├── optimizer/                   # ObJoinOrder AccessPath / ObLogPlan / ObLogTableScan
├── code_generator/              # ObStaticEngineCG + ObTscCgService（tsc ctdef 生成）
├── engine/                      # 向量化执行：ob_operator 树 + expr/ 表达式 + vector/ 列格式
│   └── expr/ob_expr_ai/          # AI 函数族（另文详述）
├── das/                         # Data Access Service：ob_das_ref / task / iter/（20+ 迭代器）
├── hybrid_search/               # seekdb 私有：JSON 检索请求 → SQL 翻译（ob_query_translator）
├── engine/px/ + dtl/            # DFO 并行执行与 px 专用传输层（v1.4.0 保留）
└── plan_cache/                  # 计划缓存
```

数据在流水线中的形态变化：SQL 文本 → `ParseNode` 树（arena 分配）→ `ObStmt`/`ObRawExpr`（逻辑语句树）→ `ObLogPlan`（逻辑计划，`AccessPath` 候选）→ `ObPhysicalPlan`（`ObExpr` 数组 + `ObOperator` 树 + DAS attach ctdef 树）→ 执行期 `ObDatum` 批 → 协议层 `ObObj` → MySQL packet。

## 调用链路

```
ObMPQuery::process (observer/mysql/obmp_query.cpp:58)
└─ process_single_stmt (:350) → do_process (:421)
   └─ ObSql::handle_text_query (ob_sql.cpp:1991)
      ├─ pc_get_plan_and_fill_result          # plan cache 命中 → 直接执行
      └─ handle_physical_plan (:3661)          # 未命中走完整长路径
         ├─ handle_parser → ObParser (parser/ob_parser.h:52)
         ├─ generate_stmt                      # resolver: ParseNode → ObStmt
         ├─ transform_stmt                     # rewrite: ObTransformerImpl
         ├─ optimize_stmt                      # ObOptimizer → ObLogPlan
         ├─ create_expr_constraints
         └─ code_generate                      # ObStaticEngineCG → ObPhysicalPlan
执行期：
ObSql::stmt_query → result_set.open (ob_result_set.cpp:174)
└─ ObExecutor::execute_plan (executor/ob_executor.cpp:46) → set_static_engine_root(op)
   └─ ObOperator 树拉取（engine/ob_operator.cpp:924 get_next_row
       → 优先 get_next_row_vectorizely(:937) → get_next_batch(:1063)）
```

单机 fork 的重要事实：**远端 DAS 已被移除**——`ObIDASTaskOp::is_local_task()` 恒返回 true（`das/ob_das_task.h:206`），全库不存在 `ObDASSyncRpcProxy`/das_rpc 文件；异步只剩两条——DAS parallel task 线程池提交（`ObDASParallelHandler::run()` 深拷任务后在线程池执行，`das/ob_das_parallel_handler.cpp:125`）与 Rust NIO 层的 packet 攒批 flush。

## 核心实现

### 语法层：复用节点打 tag

seekdb 不新增 ParseNode 类型，而是在既有节点上打整数标签，让下游在原分支内判 tag——改动面最小，代价是消费方需知道约定（也是踩坑点）：

```bison title="src/sql/parser/sql_parser_mysql_mode.y"
| VECTOR '(' INTNUM ')'
{ malloc_non_terminal_node($$, result->malloc_pool_, T_COLLECTION, 1, $3);
  $$->int32_values_[0] = 1; /* vector type */ }
| SPARSEVECTOR
{ malloc_terminal_node($$, result->malloc_pool_, T_COLLECTION);
  $$->int32_values_[0] = 3; /* sparse vector type */ }
```

向量索引 DDL（4700 行）在 `T_INDEX` 上打 `value_ = 6`（FULLTEXT 为 3、SPATIAL 为 2、UNIQUE 为 1）；距离函数（3233-3280 行）产出 `T_FUN_SYS_VECTOR_DISTANCE`，metric 参数 `COSINE/DOT/EUCLIDEAN/MANHATTAN` 编码为隐藏常量整型（`is_hidden_const_ = 1`），避免引入 4 个独立 token。`ORDER BY ... APPROXIMATE` 由 `opt_approx`（8691 行，`APPROX | APPROXIMATE` → `T_APPROX`）加 `opt_with_vector_index_parameters`（`PARAMETERS '(' vec_index_params ')'` → `T_VEC_INDEX_PARAMS`）构成。另有 ES 风格扩展：带 boost 的 `MATCH(cols, expr, opts)` → `T_FUN_ES_MATCH`、`SCORE()` → `T_FUN_ES_SCORE`。全部 item type 登记在 `src/query/api/query/parser/ob_item_type.h`（如 `T_FUN_SYS_VECTOR_DISTANCE=1744`、`T_FUN_MATCH_AGAINST=4617`、`T_APPROX=4700`、`T_FUN_SYS_AI_EMBED=2083`）。

resolver 侧的约束校验集中在 `ObCreateIndexResolver::resolve_index_column_node`（`resolver/ddl/ob_create_index_resolver.cpp:116`）——向量索引单列限制（:137）、稀疏向量列判定（:186）、同表向量/全文共存校验（:212）；`ObCreateTableResolver`（:1588-1757）依次调 `resolve_vec_index_constraint()`/`resolve_fts_index_constraint()`，并校验向量列禁做普通索引/主键。`WITH(...)` 参数翻译成辅助表结构由 `ObVecIndexBuilderUtil::append_vec_hnsw_args`（`ob_vec_index_builder_util.h:193`）与 `ObFtsIndexBuilderUtil` 完成。

两个精妙的解析细节值得一提。其一，`l2_distance(a, b)` **没有专用文法产生式**——它走通用 `function_name '(' opt_expr_as_list ')'` 产生式（:2966）产出 `T_FUN_SYS` 节点，真正的定型发生在 `ObSysFunRawExpr::get_op()`（`resolver/expr/ob_raw_expr.cpp:4078`）：`get_type_by_name("l2_distance")` 查工厂名字表后 **re-type** 为 `T_FUN_SYS_L2_DISTANCE`——只有 `VECTOR_DISTANCE` 关键字才享有专属产生式。其二，seekdb 还有一个 `HYBRID_SEARCH(json, params)` FROM 子句表达式（`:17455`，`T_HYBRID_SEARCH_EXPRESSION`）：`ObDMLResolver::resolve_hybrid_search_item`（`ob_dml_resolver.cpp:3848`）经 `share::ObHybridSearchExecutor`（`SearchType::GET_SQL`）把 JSON 检索参数翻译成 SQL 文本再重新 parse——即 hybrid_search 目录的 JSON DSL 最终产物就是本文这条 SQL。

### 表达式层：双工厂注册

```cpp title="src/sql/engine/expr/ob_expr_operator_factory.cpp —— REG_OP 宏"
static AllocFunc OP_ALLOC[T_MAX_OP];                 // type → alloc 函数
ObExprOperatorFactory::NameType NAME_TYPES[];         // name → type（resolver 按名查）
#define REG_OP(OpClass) ... NAME_TYPES[i].type_ = op.get_type(); \
                          OP_ALLOC[op.get_type()] = alloc<OpClass>;
```

向量族注册（975-981 行）：`ObExprVectorL2Distance/CosineDistance/IPDistance/NegativeIPDistance/L1Distance`、`ObExprVectorDims/VectorNorm`、`ObExprSemanticDistance/SemanticVectorDistance`、相似度三兄弟——全部从 `ObExprVector`（距离）/`ObExprVectorSimilarity`（相似度）基类派生，求值时经函数指针表分派到 data_plane 层的 SIMD 内核（另见[向量类型与距离内核](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/04-vector-type)）。AI 函数族（`ob_expr_operator_factory.cpp:1048` 附近 `REG_OP(ObExprAIEmbed)` 等）另有第二层注册——`ob_expr_extra_info_factory.cpp` 的 `REG_EXTRA_INFO(T_FUN_SYS_AI_EMBED, ObAIFuncExprInfo)`（:111）：**运算符工厂管无状态的「这是什么函数」，extra info 工厂管有状态的「这次调用的参数」**——后者随物理计划序列化进 plan cache 与 px 远端调度，与共享的操作符代码解耦。`semantic_distance` 这类别名经 `case_compare` 链（:1223）归一到 `N_SEMANTIC_DISTANCE`。

### 计划层：APPROXIMATE 与免 Sort 下压

`ORDER BY ... APPROXIMATE` 的完整旅程是理解 seekdb 优化器增量的最佳标本：

1. **resolver**：`ObDMLResolver::resolve_approx_clause`（`resolver/dml/ob_dml_resolver.cpp:5540-5619`）要求 order item 恰好 1 个且 `tmp_expr->is_vector_sort_expr()`（`ob_raw_expr.h:2141`——`T_FUN_SYS_L2_DISTANCE/L2_SQUARED/COSINE_DISTANCE/SEMANTIC_DISTANCE...` 判定），经 `ObVectorIndexUtil::check_distance_algorithm_match` 校验后 `stmt->set_has_vec_approx(true)`；
2. **optimizer 候选生成**：`ObJoinOrder::get_valid_index_ids`（`optimizer/ob_join_order.cpp:3722`）——`has_vec_approx()` 且无 filter/子查询时**只保留向量索引**（`add_only_vec_index_id`，路径类型 `VEC_INDEX_POST_WITHOUT_FILTER`）；同时含向量 + MATCH AGAINST 时走通用分支再显式 `add_valid_vec_index_ids`/`add_valid_fts_index_ids` 加入域索引候选；`skyline_prunning_index`（:2296）对向量路径 `set_can_prunning(false)`——**向量索引不被 skyline 剪枝**；
3. **路径定型**：`ObJoinOrder::process_vec_index_info`（:1448-1586）——存在 filter/MATCH 时 HNSW 路径定为 `VEC_INDEX_POST_ITERATIVE_FILTER`（迭代过滤）；`process_index_for_match_expr`（:17074）把 MATCH 谓词按路径放入 `index_scan_exprs_`（FTS 主路径）或 `func_lookup_exprs_`（向量路径上的函数查找）；
4. **免 Sort 决策**：`ObLogPlan::allocate_sort_and_exchange_as_top`（`ob_log_plan.cpp:6452`）在 `need_sort` 时先调 `try_push_topn_into_domain_scan`（:13187）路由到 `try_push_topn_into_vector_index_scan`（:13229-13283）——单分区、无多余 filter 时 `need_further_sort = false`，**不分配任何 Sort/TopN/Limit 逻辑算子**：`table_scan->set_op_ordering(...)` 向上游声明扫描自带 distance 序，`vc_info.topk_limit_expr_ = stmt->get_limit_expr()`（:12884）把 limit 一起下压。HNSW 图遍历天然按距离输出 TopK，这是「近似检索」的语义兑现。

配套优化：距离表达式只用于 ORDER BY（不出现在投影里）时，`ObVectorIndexUtil::set_vector_index_param`（`observer/vector_index/ob_vector_index_util.cpp:6243`）给向量表达式打 `IS_CUT_CALC_EXPR`（`ob_expr_info_flag.h:111`）——距离由 vsag 结果直接携带，引擎不再逐行计算。

### 计划层：hybrid 融合 = 单 TableScan + DAS attach 树

seekdb 最反直觉的设计：**向量 + 全文的融合检索不产生 merge/fusion 算子**，物理计划永远是一个 `PHY_TABLE_SCAN`，两种检索在它的 DAS attach ctdef 树里完成融合。两条单 scan 路径：

- **路径 A（向量主路径，MATCH 作迭代过滤）**：`ObLogPlan::prepare_vector_index_info`（:12822）填 `ObVecIndexInfo`（`optimizer/ob_log_table_scan.h:238-341`：`sort_key_/topk_limit_expr_/target_vec_column_/aux_table_id_/vec_type_/is_hybrid_index`）→ code generator 的 `ObTscCgService::generate_vec_idx_ctdef`（`code_generator/ob_tsc_cg_service.cpp:1621-1883`）对每个 tr info 生成 `DAS_OP_FUNC_LOOKUP` 子 ctdef——HNSW 迭代期间**内联**逐 vid 求值 MATCH 谓词与相关度；attach 树 children 布局：`[0]`倒排扫描、`[1]`delta buffer、`[2]`index_id、`[3]`snapshot、`[4]`主表、`[5]`rowkey_vid、`[6]`hybrid embedded 表、`[7]`func lookup；
- **路径 B（FTS 主路径，FTS 作向量预过滤）**：MATCH 谓词进 `index_scan_exprs_`，向量路径定 `VEC_INDEX_PRE`；执行侧 `ObDASHNSWScanIter::get_vid_from_idx_filter`（`das/iter/ob_das_hnsw_scan_iter.cpp:1897-2060`）先扫倒排迭代器拿 rowkey→vid，再把 vid 集喂给 vsag 做预过滤位图。

两条路径由 `compute_vec_idx_path_relationship`（`ob_join_order.cpp:5743-5786`）按选择性择一。相关度分数（`MATCH(...) AS score`）经 `ObTscCgService::collect_all_relavence_exprs`（:2954）从 IR ctdef 收集进向量扫描的 `result_output_`，随 vid 一并回流。hybrid **语义索引**（schema 层 `INDEX_TYPE_HYBRID_INDEX_LOG/EMBEDDED_LOCAL`，`share/schema/ob_schema_struct.h:352`）的向量数据改从 embedded 隐藏表取（`prepare_hnsw_vector_access_exprs`，`ob_log_table_scan.cpp:3748`），一次 HNSW 图遍历完成融合检索。

### 执行与 DAS：迭代器树协议

物理算子是 `ObOperator` 树（`engine/ob_operator.h`），数据以列式格式（`engine/vector/` 的 Uniform/FixedLength/Discrete/Continuous 四族 + null 位图）在算子间传递。扫描算子 `ObTableScanOp` 把每个 tablet 的访问任务化：`prepare_das_task`（`engine/table/ob_table_scan_op.cpp:865`）→ `ObDASRef::create_das_task` → 同类型任务聚合进 `ObDasAggregatedTask`（`das/ob_das_ref.h:131`）→ 串行 `execute_local_das_task` 或 `parallel_submit_agg_task`（线程池 + 并发额度 `DASRefCountContext` 控制）。迭代器树由 `ObDASIterUtils::create_das_scan_iter_tree`（`das/iter/ob_das_iter_utils.cpp:122`）按 `get_iter_tree_type` 分派：`ITER_TREE_VEC_LOOKUP`（向量）/`ITER_TREE_MATCH`（RRF 混合）/`ITER_TREE_TEXT_RETRIEVAL`（纯全文）/`ITER_TREE_PARTITION_SCAN`（普通）。多 tablet 归并由 `ObDASMergeIter` 顶层完成（SEQUENTIAL_MERGE 顺序或 SORT_MERGE 归并），多路检索相关性的 RRF 融合节点是 `ObDASMatchIter`（`das/iter/sparse_retrieval/ob_das_match_iter.h:107`，内嵌 `common::ObLoserTree` 归并堆）。行回流链：storage 写 expr frame 的 `ObDatum` → DAS 迭代器树 → `ObExecuteResult::get_next_row` 做 **`ObDatum::to_obj`**（`executor/ob_execute_result.cpp:65`）→ `ObObj` → `ObSMRow::build_cell_value`（MySQL cell bytes）→ Rust `nio_response_append_row`/`nio_response_flush`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 双工厂（运算符 + extra info） | `ob_expr_operator_factory.cpp` + `ob_expr_extra_info_factory.cpp` | 无状态操作符可全局共享；有状态调用参数随计划序列化——两层生命周期解耦 |
| 节点 value_ 打 tag | `T_INDEX` 的 value_=6/3/2/1、`T_COLLECTION` 的 int32_values_[0] | 不膨胀 item type 枚举，resolver 在原分支内判 tag |
| 模板方法 | `ObOperator::get_next_row`（iterator 检查 → 向量化尝试 → 逐行回退） | 数百算子共享执行骨架，只覆写 `inner_get_next_batch` |
| attach 树组合 | `ObDASSortCtDef → ObDASVecAuxScanCtDef → children[]` | 融合检索不新增物理算子——DAS ctdef 树既是序列化单元又是装配蓝图 |
| Arena 内存 | parser 的 `malloc_non_terminal_node($$, result->malloc_pool_)` | 解析树与语句同生共死，免逐节点 free |

## 模块间交互

SQL 引擎向下经 `data_plane/api` 头文件消费存储能力（`ObITabletScan`、`ObIOptimizerStorageService`），域索引运行时经服务定位器拿 `query::ObIVectorIndexService`；DAS 迭代器树把检索执行「外包」给三个检索子系统——向量走 `observer/vector_index` 的 adaptor、全文/稀疏走 `storage/retrieval` 的迭代器工厂、分词走 `storage/fts`。`hybrid_search/` 是旁挂的请求翻译层（JSON 检索请求 → SQL，`ob_query_translator.cpp`），翻译后复用主链路——与 SQL 内的 hybrid 融合机制正交。`AI_EMBED` 表达式在 `hybrid_search` 与向量索引的查询文本 embed（`ObDasVecScanUtils::init_sort_of_hybrid_index`）两处被间接触发。

## 扩展方式

新增一个 SQL 内置函数（模板：现有距离函数族）：① `src/query/api/query/parser/ob_item_type.h` 加 `T_FUN_SYS_XXX`；② `sql_parser_mysql_mode.y` 加产生式（3233 行模式）+ 关键字清单；③ `src/oblib/lib/ob_name_def.h` 加 `#define N_XXX "xxx"`；④ 新建 `engine/expr/ob_expr_xxx.{h,cpp}`（`calc_result_typeN` + 批量求值）；⑤ `REG_OP` 注册（有别名加 `case_compare` 链）；⑥ 带运行时状态则 `REG_EXTRA_INFO`。
新增一种索引语法：语法三处产生式 + 新 value_ 标签 → `ob_ddl_resolver.h` 加 `resolve_xxx_index_constraint` → builder util 造辅助表 → `ObLogTableScan` 索引信息结构 + cost 路径 → `ObTscCgService` 生成对应 ctdef + `das/iter/` 新迭代器 + `ob_das_iter.cpp` 工厂注册（完整清单见[向量索引体系](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/05-vector-index)的算法扩展节）。
