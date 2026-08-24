---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "查询解析与优化"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "analysis", "planner", "CUP", "Analyzer", "CBO", "Join 重排"]
description: "Doris 1.1.5 查询解析与优化：CUP+JFlex 解析、Analyzer 语义分析、ExprRewriter 规则改写、SingleNodePlanner Cost-Based Join 重排、DistributedPlanner Colocate/Bucket/Broadcast/Shuffle。1.x 唯一优化器路径，无 Nereids。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

本模块由 `fe/fe-core/src/main/java/org/apache/doris/analysis/`（~6.0 万行，360 文件）与 `planner/`（~1.9 万行，66 文件）组成，是 1.1.5 的**唯一查询规划路径**：SQL 文本 → AST → 语义分析 → 改写 → 计划生成 → 分布式切分。1.x **没有 Nereids**（Cascades 优化器是 2.0 引入），也**没有独立的 `Optimizer.java`**——CBO 逻辑分散在 `Planner`/`SingleNodePlanner` 与 `rewrite/` 规则链中，优化范式是"启发式规则 + 有限 Cost-Based Join 重排"，不做 bushy tree 搜索。FE 入口的 `PaloFe.java` 仍是 Palo 命名遗产。

## 模块架构

```
SQL 文本
  │
  ▼
SqlParser (CUP 生成) ── fe/fe-core/src/main/cup/sql_parser.cup (5883 行 LALR(1) 语法)
  │ + SqlScanner (JFlex 词法)
  └─→ StatementBase (AST: SelectStmt / InsertStmt / DDL)
       │
       ▼
Analyzer (analysis/Analyzer.java:96) ── 语义分析"状态仓库"（非优化器）
   ├─ tupleByAlias / slotRefMap        ── 名字→Tuple/SlotDescriptor 绑定
   ├─ tuplePredicates / slotPredicates ── 谓词归属管理（下推基础）
   ├─ eqJoinConjuncts                   ── 等值 Join 谓词
   ├─ GlobalState (descTbl, conjuncts, ExprRewriter×2)  ── 跨子查询共享
   └─ registerConjuncts() / getConjuncts() / materializeSlots()
       │
       ▼
StmtRewriter (analysis/StmtRewriter.java:47) ── 子查询改写
   └─ rewriteWhereClauseSubqueries() ── IN/EXISTS 标量子查询 → Join
       │
       ▼
ExprRewriter (rewrite/ExprRewriter.java) ── 表达式规则改写引擎
   ├─ rules_ (Repeat): FoldConstantsRule / BetweenToCompoundRule / NormalizeBinaryPredicatesRule / InferFiltersRule / ExtractCommonFactorsRule ...
   ├─ onceRules_ (Once)
   └─ mvExprRewriter (mvrewrite/: ToBitmapToSlotRefRule 等 6 条 MV 改写)
       │  (改写后 re-analyze: parsedStmt.reset(); parsedStmt.analyze(analyzer))
       ▼
Planner (planner/Planner.java)
   ├─ SingleNodePlanner.createSingleNodePlan()   ── 单节点 PlanNode 树
   │    ├─ createSelectPlan() → createTableRefNode()/createCheapestJoinPlan()
   │    ├─ SelectStmt.reorderTable() (旧版: 按 OlapTable.getRowCount 贪心左深树)
   │    └─ createCheapestJoinPlan() (新版 Cost-Based: 按 cardinality 降序选最左)
   ├─ selectMaterializedView() (SNPlanner:1103)
   └─ DistributedPlanner.createPlanFragments() (planner/DistributedPlanner.java:79)
        ├─ ScanNode → createScanFragment()
        ├─ HashJoinNode → createHashJoinFragment() (:306)
        │    └─ canColocateJoin() > canBucketShuffleJoin() > JoinCostEvaluation(Broadcast vs Shuffle)
        ├─ AggregationNode → createAggregationFragment() (本地+全局两阶段)
        └─ SortNode → createOrderByFragment()
            │
            ▼
        ArrayList<PlanFragment>  → Coordinator
```

## 调用链路

```
ConnectProcessor.handleQuery()                            [qe/ConnectProcessor.java:171]
  → StmtExecutor.execute(queryId)                        [qe/StmtExecutor.java:331]
    → analyze(tQueryOptions)                             [StmtExecutor.java:557]
      → SqlParser.parse(originStmt)                     [CUP 解析 → AST]
      → analyzer = new Analyzer(catalog, context)
      → parsedStmt.analyze(analyzer)                     [SelectStmt.analyze:398]
           ├─ fromClause_.analyze()  → TupleDescriptor 绑定
           ├─ expandStar()           → SELECT * 展开
           ├─ Expr.analyze(resultExprs) → 类型推导
           ├─ analyzeAggregation()    → GROUP BY/HAVING
           └─ reorderTable()         [SelectStmt.java:738 旧版 Join 重排]
      → parsedStmt.rewriteExprs(rewriter)               [SelectStmt.rewriteExprs:1366]
           └─ ExprRewriter.rewrite() 循环应用规则
      → StmtRewriter.rewrite(analyzer, parsedStmt)      [StmtRewriter.java:47]
           └─ rewriteWhereClauseSubqueries() → 子查询改 Join
      → re-analyze (parsedStmt.reset(); analyze)
    → handleQueryStmt() → sendResult()
      → planner.plan(parsedStmt, analyzer, tQueryOptions) [Planner.java:78]
        → createPlanFragments()                          [Planner.java:127]
          → singleNodePlanner.createSingleNodePlan()     [SingleNodePlanner.java:139]
            → createSelectPlan()                         [:934]
              → createCheapestJoinPlan()                 [:678 Cost-Based]
          → selectMaterializedView()                     [:1103]
          → singleNodePlan.finalize(analyzer)            [PlanNode.finalize:533]
          → distributedPlanner.createPlanFragments()     [DistributedPlanner.java:79]
              → createHashJoinFragment() (:306) 选 Colocate/Bucket/Broadcast/Shuffle
          → RuntimeFilterGenerator.generateRuntimeFilters()
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `SqlParser.parse` | CUP 解析 SQL | LALR(1)，对左递归 SQL 语法天然友好 |
| `Analyzer.registerConjuncts` | 谓词注册到 Tuple | 为后续下推提供归属数据结构 |
| `StmtRewriter.rewrite` | 子查询改写 | IN/EXISTS→Join，避免子查询执行 |
| `ExprRewriter.rewrite` | 表达式规则改写 | Repeat 规则循环到不变，Once 规则单次 |
| `SelectStmt.reorderTable` | 旧版 Join 重排 | 按 getRowCount 静态排序贪心左深树 |
| `createCheapestJoinPlan` | 新版 Join 重排 | 按 cardinality 估算降序选最左（`enable_join_reorder_based_cost`） |
| `DistributedPlanner.createHashJoinFragment` | 分布式 Join 策略 | Colocate>BucketShuffle>Broadcast>Shuffle 优先级链 |
| `PlanNode.finalize` | 递归计算基数 | 自底向上 computeNumNodes + computeOldCardinality |

</details>

## 核心实现

### Analyzer 是"状态仓库"而非优化器

`Analyzer`（`analysis/Analyzer.java:96`）没有 `optimize()` 方法，不做成本估算，不做 Join 重排（`reorderTable` 在 `SelectStmt` 中）。它的核心职责是**语义分析的共享黑板**：`tupleByAlias`/`slotRefMap` 完成名称到元数据绑定，`tuplePredicates`/`slotPredicates`（`:1031` `registerConjuncts`）管理谓词归属（后续下推基础），`eqJoinConjuncts`（`:290`）记录等值 Join 谓词供重排与等价类推断，`GlobalState.exprRewriter_`（`:342`）持两套 `ExprRewriter`（通用 + MV 改写）。子查询经 `createWithNewGlobalState()`（`:472`）创建新 GlobalState 但共享 DescriptorTable，实现作用域隔离。**为什么**：分析阶段需要跨 AST 节点共享状态（谓词归属、类型、物化标记），集中仓库避免各 `analyze()` 重复查询 catalog。

### 优化分散在三层

1.1.5 无独立 Optimizer，优化逻辑分布在：

- **表达式改写层**（`StmtExecutor.analyze` 内）：常量折叠 `FoldConstantsRule`、BETWEEN→AND、谓词规范化 `NormalizeBinaryPredicatesRule`、等价类推断 `InferFiltersRule`（`t1.id=t2.id AND t1.id=1` → 推断 `t2.id=1`，Join 前过滤内表）、公因子提取。
- **Join 重排层**：旧版 `SelectStmt.reorderTable()`（`:738`，按 `OlapTable.getRowCount` 静态排序贪心左深，仅 INNER）与新版 `SingleNodePlanner.createCheapestJoinPlan()`（`:678`，按 `PlanNode.getCardinality()` 运行时估算降序选最左，外/半 join 不参与），受 `enable_join_reorder_based_cost` 控制。
- **分布式计划层**：`DistributedPlanner.createHashJoinFragment()`（`:306`）按 `canColocateJoin()`→`canBucketShuffleJoin()`→`JoinCostEvaluation`（Broadcast vs Shuffle，`autoBroadcastJoinThreshold = perNodeMemLimit * 百分比`）优先级链选分布式 Join 策略。
- **谓词下推**：`PlanNode.init()` 调 `assignConjuncts()` 从 Analyzer 取未分配谓词附加到最近能处理该 Tuple 的节点；`rewrite/PredicatePushDown.java` 在 inner/left join 时从左表等值谓词推断右表谓词下推到 ScanNode。列裁剪经 `materializeSlots()`（`:2135`）+ `DescriptorTable.computeMemLayout()` 控制，只物化被引用 Slot。

### 为什么用 CUP 而非 ANTLR4

`sql_parser.cup`（5883 行 CUP 语法）+ JFlex 词法器。**为什么**：Doris FE 最初基于 Cloudera Impala 裁剪，Impala 选 CUP 因 2010 年代初 ANTLR4 尚未发布、ANTLR3 性能差；CUP 生成 LALR(1) 解析器（自底向上），对左递归 SQL 语法（表达式列表、JOIN 链）天然友好，而 ANTLR4 是 LL(*) 需显式处理左递归。5883 行语法涵盖全部 SQL 方言，迁移 ANTLR4 风险极高。**2.x Nereids 绕过语法层问题**——仍用 CUP 解析，但在 AST 之后接管语义分析与优化。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略（改写规则） | `ExprRewriteRule` 接口 in `rewrite/ExprRewriteRule.java` | 每条改写规则独立可插拔，`ExprRewriter` 持规则列表循环应用 |
| 模板方法 | `PlanNode.init/finalize/toThrift` in `planner/PlanNode.java:608,533,694` | 基类定义骨架，子类覆盖 `toThrift` |
| 组合 | `PlanNode extends TreeNode<PlanNode>` in `PlanNode.java:72` | Plan 树递归，`createPlanFragments` 递归遍历 |
| 工厂方法 | `DistributedPlanner.createPlanFragments` 按 `instanceof` 分派 in `:181` | 12 种节点类型各自的 fragment 创建 |
| 访问者变体 | Join 策略优先级链 in `DistributedPlanner.createHashJoinFragment:306` | 同一 HashJoinNode 按上下文选不同分布策略 |

> 注意：`Analyzer.java:39-40` 反向引用 `planner.PlanNode`/`RuntimeFilter`，形成 analysis↔planner 循环依赖，2.x Nereids 重写后消除。

## 模块间交互

`analysis/` 依赖 `catalog`（Catalog/Database/OlapTable/Type，118 处 import）、`common`（AnalysisException 457 次）、`qe`（ConnectContext）、`rewrite`。`planner/` 依赖 `analysis`、`catalog`（ColocateTableIndex/DistributionInfo）、`common`。被 `qe/StmtExecutor.java` 作为完整调用链入口调用。被 326 处 `import org.apache.doris.catalog.Catalog` 反映 Catalog 是其元数据来源。

## 扩展方式

**新增 SQL 语法**（如 QUALIFY 子句）：`sql_parser.cup` 加 `KW_QUALIFY` 终端符 + `qualify_clause` 产生式（在 `select_stmt` `:3808` 添加）；`analysis/SelectStmt.java` 加字段并在 `analyze()` `:398` 调用；`jflex/sql_scanner.flex` 加词法规则；`planner/SingleNodePlanner.java` `createSelectPlan()` `:934` 构建对应节点。

**新增改写规则**：建 `rewrite/LikePrefixRule.java` 实现 `ExprRewriteRule.apply()`；在 `Analyzer.java:350` `GlobalState` 构造 `rules` 列表注册（须排 `NormalizeBinaryPredicatesRule` 之后）。对应测试：`fe-core/src/test/java/org/apache/doris/rewrite/`。
