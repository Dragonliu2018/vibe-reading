---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "查询规划器"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 查询规划器解读：QueryBinder 的 16 步绑定与 BindContext 作用域链、9 个子 Binder 的名字解析策略、BoundSelectStatement 组装 LogicalFusion 多路搜索树、Optimizer 的 6 条启发式规则链"
readingTime: "24 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/planner/`（约 150 个文件，2.2 万行）+ `src/expression/`（约 30 个 bound 表达式类）承担 BaseStatement → LogicalNode 树的全部编译工作：**Binder**（名字解析/绑定到 catalog 对象）、**LogicalPlanner**（bound 语句 → 逻辑计划）、**Optimizer**（规则优化）。物理规划器 `PhysicalPlanner` 物理上放在 `src/executor/`，逻辑上属于这条管线的最后一环。

架构明显借鉴 DuckDB 的 Binder/LogicalPlan 分层——`BindContext` 作用域链、`Binding` 列签名、table_index 集中分配这些概念与 DuckDB 同名同义。但 Optimizer 是**固定的启发式管道**而非 Cascades 风格：无代价模型、无 join 重排，6 条规则顺序执行。

---

## 模块架构

![查询规划器结构](/vibe-reading/images/articles/infinity-internals/module-map.svg)

```text
src/planner/
├── logical_planner.cppm/_impl      语句级入口：switch(StatementType) 分派 17 个 BuildXxx
├── query_binder.cppm/_impl         QueryBinder：BindSelect 的 16 步编排
├── binder/                         9 个子 Binder（WhereBinder/GroupBinder/ProjectBinder...）
├── expression_binder.cppm/_impl    ExpressionBinder：ParsedExpr → BaseExpression 翻译
├── bind_context.cppm/_impl         BindContext：作用域链 + table_index 分配器
├── bound/bound_select_statement*   BoundSelectStatement::BuildPlan 组装逻辑树
├── node/                           ~45 个 LogicalNode 子类（含 5 个搜索节点）
├── optimizer/                      6 条规则 + index_scan/ 子库
├── subquery/                       子查询 unnest（correlated/uncorrelated）
├── cached_node/                    结果缓存占位节点（CachedMatch/CachedKnnScan...）
└── binding.cppm/_impl              Binding：单数据源的列签名
```

三类核心角色：

- **LogicalPlanner**（`logical_planner.cppm:47`）——语句级入口，持有 `logical_plan_` 与 `logical_plans_`（COPY 等多计划场景）。
- **QueryBinder**（`query_binder.cppm:45`）——SELECT 的绑定编排器，产出 `BoundSelectStatement`。
- **Optimizer**（`optimizer.cppm:27`）——`vector<unique_ptr<OptimizerRule>> rules_` 规则链。

搜索专属的逻辑节点有 5 个：`LogicalMatch`（全文）、`LogicalKnnScan`、`LogicalMatchTensorScan`、`LogicalMatchSparseScan`、`LogicalFusion`（额外持 `other_children_` 支持 >2 路融合）。

---

## 调用链路

### BindSelect 的 16 步（`query_binder_impl.cpp:83-268`，源码注释直接标注步骤号）

```text
1    WITH：CTE 倒序注册进 CTE_map_，masked_name_set 限制可见性
2-4  FROM：BuildFromClause → BuildTable（CTE→BaseTable→View 顺序尝试）
              / BuildSubquery / BuildCrossProduct / BuildJoin；无 FROM → BuildDummyTable
5    SELECT 别名：展开 *（UnfoldStarExpression）；
     无别名的 KNN 表达式直接报错 "KNN expression in select list must have an alias"
6.1  SEARCH：BoundSearch → WhereBinder::Bind → SearchExpression
6.2  WHERE：WhereBinder 绑定，SplitExpressionByDelimiter(kAnd) 拆成条件列表
7/9  GROUP BY / HAVING：GroupBinder/HavingBinder（经 BindAliasProxy）
11   SELECT 列表：ProjectBinder（BuildSelectList）
13/14 ORDER BY / LIMIT：OrderBinder/LimitBinder
末尾  把 group/aggregate/project/knn 四个 table_index 写入 BoundSelectStatement
```

子查询绑定是递归点：`ExpressionBinder::BuildSubquery` 新建 `BindContext`（parent 指向外层）+ 递归 `BindSelect`；外层解析失败的列沿 parent 链上溯（depth+1）产生 `CorrelatedColumnExpression`。**v0.7.3 不支持多层嵌套子查询**——`BuildSubquery` 中 `building_subquery_` 标志命中即 `UnrecoverableError("Nested subquery detected")`。

### 搜索表达式的 bind 转换点

`BuildSearchExpr`（`expression_binder_impl.cpp:1105`）内部分发：

```text
kKnn         → BuildKnnExpr  → KnnExpression（校验 topn>0、目标列 TypeInfoType::kEmbedding、
                                query 维度与列维度（multi-vector 需整除）、元素类型合法性）
kMatch       → BuildMatchTextExpr → MatchExpression(fields_, matching_text_, options_text_)
kMatchTensor / kMatchSparse → 对应 bound 类
fusion_exprs → FusionExpression(method_, options_)
最终          → SearchExpression(match_exprs, fusion_exprs)
```

### BoundSelectStatement::BuildPlan 的树组装（`bound_select_statement_impl.cpp:92`）

搜索分支（`search_expr_ != nullptr`）的组装最能体现混合检索的计划形态：

- 校验必须是 base table、`have_filter_in_subsearch_` 与 WHERE filter 互斥；
- 组装 `CommonQueryFilter`（filter 表达式 + BaseTableRef + NewTxn）；
- 每个 match_expr 构造对应 LogicalNode：`kMatch → LogicalMatch`（副作用：`GetFullTextIndexReader` 取 analyzer 映射 + `SearchDriver::ParseSingleWithFields` 把 matching_text 解析成 QueryNode 查询树）、`kKnn → LogicalKnnScan`；
- 多子搜索融合：首个 `LogicalFusion` 挂 children[0]/[1]，其余进 `other_children_`；
- 上叠 `LogicalAggregate`/`LogicalTop`/`LogicalProject`；混合/异列 DISTINCT 走两级 `LogicalHashAggregate` + `LogicalMergeAggregate`（并行局部 + 串行全局去重）。

EXPLAIN 输出印证了这个形态（`test/sql/explain/explain_fusion.slt`）：

```text
PROJECT (5)
-> FUSION (4)
   - fusion: #FUSION('rrf', '')
  -> MATCH (2)          ← 全文检索分支
  -> KNN SCAN (3)       ← 稠密向量分支
     - embedding info: vec (FLOAT32, dim=4, L2)
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `LogicalPlanner::Build` | `logical_planner_impl.cpp:135` | StatementType 大 switch 分派 |
| `QueryBinder::BindSelect` | `query_binder_impl.cpp:83` | 16 步绑定编排 |
| `QueryBinder::BuildFromClause` | `query_binder_impl.cpp:133` | 表/子查询/CTE/JOIN 分发 |
| `ExpressionBinder::BuildExpression` | `expression_binder_impl.cpp:111` | ParsedExprType switch → 虚方法族 |
| `ExpressionBinder::BuildKnnExpr` | `expression_binder_impl.cpp:905` | 列级校验 + KnnExpression 构造 |
| `BoundSelectStatement::BuildPlan` | `bound_select_statement_impl.cpp:92` | 逻辑树组装主入口 |
| `BindContext::ResolveColumnId` | `bind_context_impl.cpp:262` | 三级名字解析 + 沿 parent 上溯 |
| `Optimizer::optimize` | `optimizer_impl.cpp:56` | 规则链顺序 ApplyToPlan |
| `SubqueryUnnest::UnnestCorrelated` | `subquery/subquery_unnest.cppm` | 相关子查询去关联 |

</details>

---

## 核心实现

### BindContext：作用域链 + table_index 分配器

`BindContext`（`bind_context.cppm:48`）是名字解析的心脏：`parent_` 裸指针指父作用域（子作用域持 `shared_ptr` 保活，父指回用裸指针避免循环引用）、`binding_by_name_`（表别名 → Binding）、`binding_names_by_column_`（列名 → 候选 binding，无表前缀解析用）、`CTE_map_`。

名字解析三级查找（`ResolveColumnId`）：先按列名查 `binding_names_by_column_`（多候选报 Ambiguous）→ 按表名查 `binding_by_name_` → 失败则 `parent_->ResolveColumnId(id, depth+1)` 递归上溯。depth 递增即 correlated column 的来源深度。

**table_index 集中分配**是后半管线的基石：`GenerateTableIndex()` 由根 BindContext 统一编号，group/aggregate/project/knn 各成一张"虚拟表"，保证 `ColumnBinding(table_index, column_idx)` 全局无歧义——executor 的列定位、ColumnRemapper 的重编号全依赖这个不变量。

### 9 个子 Binder：同一模板方法的不同名字解析策略

`ExpressionBinder::BuildExpression` 是模板方法，`WhereBinder/GroupBinder/HavingBinder/ProjectBinder/OrderBinder/LimitBinder/JoinBinder/InsertBinder/AggregateBinder` 九个子类用 `final` override `BuildColExpr`/`BuildExpression` 改变行为：WHERE 允许引用 select 别名（经 `BindAliasProxy`，`binding_alias_` 标志防环），GROUP 不允许；OrderBinder 只对 `kKnn` 放行距离列。这是策略模式在"子句级语义差异"上的精确应用。

### Optimizer 的 6 条规则（注册顺序即执行顺序）

| # | 规则 | 职责 | 文件 |
|---|---|---|---|
| 1 | `ApplyFastRoughFilter` | 把 Filter 中可下推的 zone map 级条件压入 TableScan/IndexScan 的 `fast_rough_filter_evaluator_` | `apply_fast_rough_filter_impl.cpp` |
| 2 | `IndexScanBuilder` | 收集 LogicalMatch 复用已解析全文查询树；可用二级索引的过滤条件改写为 `LogicalIndexScan` | `index_scan_builder_impl.cpp` |
| 3 | `ColumnPruner` | `RemoveUnusedColumns` 访问者收集被引用 ColumnBinding，裁剪各节点输出列 | `column_pruner_impl.cpp` |
| 4 | `LazyLoad` | 收集未被引用的列 binding 写 `LoadMeta`，支持列级延迟物化 | `lazy_load_impl.cpp` |
| 5 | `ColumnRemapper` | 裁剪后的列重新连续编号 | `column_remapper_impl.cpp` |
| 6 | `ResultCacheGetter`（条件启用） | 对搜索节点查 `ResultCacheManager`，命中用 `LogicalReadCache` 替换子树 | `result_cache_getter_impl.cpp` |

规则顺序有硬约束（注释明示）：改列集合的必须在 ColumnRemapper 之前；IndexScanBuilder 依赖 filter_fulltext 须在 ColumnPruner 之前。表达式折叠在 logical planner 阶段已完成（`optimizer_impl.cpp:57` 注释）。

### 为什么 KNN/Fusion 要在 binder 阶段特殊处理

1. **类型校验依赖 catalog 列信息**——`BuildKnnExpr` 必须拿 Binding 里的 `EmbeddingInfo` 验证维度/元素类型，报错才能带列名上下文；
2. **KNN 输出是"新表"**——bind 时分配 `knn_table_index_`，`LogicalKnnScan` 构造时显式接收；
3. **filter 子表达式需预先绑定**——每个子搜索的 `optional_filter_` 要在 bind 阶段产出，plan 期组装成 `CommonQueryFilter` 供物理算子做过滤下推（explain 输出里的 `index filter` 与 `leftover filter` 分野即来源于此）；
4. **Fusion 的计划结构在 bind/plan 期定型**——多子搜索 → LogicalFusion 多子节点树是**物理算子树结构决策**，不是等价变换，不适合放 optimizer；
5. **全文 MATCH 需要索引侧信息解析查询串**——`LogicalMatch` 构建时用 `GetFullTextIndexReader` 拿列 → analyzer 映射，AST 中的文本串必须在此刻物化为 QueryNode 查询树。

### 子查询 unnest 放在 plan 构建期而非 optimizer

`BuildSubquery` → `UnnestSubquery`（`bound_select_statement_impl.cpp:1059-1100`）在 `BuildPlan` 里递归触发，按 `HasCorrelatedColumn()` 分派 `SubqueryUnnest::UnnestCorrelated/Unnested`（依赖 `CorrelatedExpressionsDetector`/`DependentJoinFlattener`/`RewriteCorrelatedExpressions`）。bound 与 plan 两个阶段交替递归，是该模块最绕的控制流。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Visitor（节点+表达式双层） | `LogicalNodeVisitor`：`VisitNode/VisitNodeChildren` + 14 个 `VisitReplace` 重载 | 优化器规则的树改写骨架 |
| 规则链 | `Optimizer::rules_` 顺序 ApplyToPlan | 简单可控；顺序约束靠注释维护 |
| 模板方法 + 策略 | `ExpressionBinder::BuildExpression` + 9 个子类 override | 子句级语义差异 |
| 代理 | `BindAliasProxy::BindAlias`（`binding_alias_` 防环） | 别名延迟绑定 |
| 作用域链 | `BindContext::parent_` + `ResolveColumnId` 递归 | SQL 名字解析的经典结构 |
| 无校验下转 | `LogicalNode::Cast<T>()` 纯 reinterpret_cast | 性能取向，依赖枚举类型守卫 |

---

## 模块间交互

- **消费 parser**：`SelectStatement/KnnExpr/MatchExpr/SearchExpr/FusionExpr` 等 ParsedExpr 层级；parser 的 `KnnExpr` 保留原始字节流，binder 转成 `EmbeddingT` 包装进 `KnnExpression`。
- **产出被 executor 消费**：`LogicalNode` 树 → `PhysicalPlanner::BuildPhysicalOperator` 的 switch（`kMatch`/`kKnnScan`/`kFusion` 各有映射）。
- **与 catalog 交互**：`BuildBaseTable` 经 `NewTxn::GetTableMeta` 取表元数据，`BlockIndex::NewInit` 构建块索引，`AddTableBinding` 注册 Binding；特殊列 `_row_id` 来自 catalog 的 `special_columns_`。
- **与 function 交互**：`BuildFuncExpr` 经 `NewCatalog::GetFunctionSetByName` → `GetMostMatchFunction` 重载解析（详见[函数库](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/06-functions-expressions)）。

---

## 扩展方式

**新增一条 optimizer 规则**：`optimizer/` 新建 `my_rule.cppm/_impl.cpp`（`class MyRule final : public OptimizerRule`，实现 `ApplyToPlan` + `name()`，内部自建 `LogicalNodeVisitor` 子类，参考 `column_pruner.cppm` 的写法）→ `optimizer_impl.cpp` 构造函数 `AddRule(make_unique<MyRule>())`。不需要动 binder/QueryContext/parser——改动最小、完全正交。

**支持新的搜索表达式**（如 `MATCH GRAPH`）的全链路改动清单：parser 的 expr 类 + 语法规则 → `src/expression` 建 bound 类 → `expression_binder` 加 `BuildMatchGraphExpr` → `src/planner/node` 建逻辑节点 + `logical_node_type` 加枚举 → `bound_select_statement_impl.cpp` 搜索分支 switch 加 case → 物理算子 + explain 输出。约 8 处，见模块文件清单。

**新增列裁剪感知的算子**（改算子后必查）：`column_pruner_impl.cpp` 的 `RemoveUnusedColumns::VisitNode` switch 需为新节点类型补列引用收集逻辑，**否则新算子输出列会被误裁**——这是引入新逻辑节点最常见的坑。
