---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "查询解析与优化"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "analysis", "planner", "CUP", "Analyzer", "CBO", "Join 重排"]
description: "Doris 0.14.0 查询解析与优化：CUP+JFlex 解析、Analyzer 语义分析、ExprRewriter 规则改写、SingleNodePlanner Cost-Based Join 重排、DistributedPlanner Colocate/Bucket/Broadcast/Shuffle。0.x 唯一优化器路径，无 Nereids。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块由 `fe/fe-core/src/main/java/org/apache/doris/analysis/`（~5.0 万行，296 文件）与 `planner/`（~1.4 万行，52 文件）组成，是 0.14.0 的**唯一查询规划路径**：SQL 文本 → AST → 语义分析 → 改写 → 计划生成 → 分布式切分。0.x **没有 Nereids**（Cascades 优化器是 2.0 引入），也**没有独立的 `Optimizer.java`**——CBO 逻辑分散在 `Planner`/`SingleNodePlanner` 与 `rewrite/` 规则链中，优化范式是"启发式规则 + 有限 Cost-Based Join 重排"，不做 bushy tree 搜索。

## 模块架构

```
SQL 文本
  │
  ▼
SqlParser (CUP 生成) ── fe/fe-core/src/main/cup/sql_parser.cup (LALR(1) 语法)
  │ + SqlScanner (JFlex 词法)
  └─→ StatementBase (AST: SelectStmt / InsertStmt / DDL)
       │
       ▼
Analyzer (analysis/Analyzer.java:83) ── 语义分析"状态仓库"（非优化器）
   ├─ tupleByAlias / slotRefMap        ── 名字→Tuple/SlotDescriptor 绑定
   ├─ tuplePredicates / slotPredicates ── 谓词归属管理（下推基础）
   ├─ eqJoinConjuncts                   ── 等值 Join 谓词
   ├─ GlobalState (descTbl, conjuncts, ExprRewriter×2)  ── 跨子查询共享 (:167)
   └─ registerConjuncts() / getConjuncts() / materializeSlots()
       │
       ▼
StmtRewriter (analysis/StmtRewriter.java:40) ── 子查询改写
   └─ rewriteWhereClauseSubqueries() ── IN/EXISTS 标量子查询 → Join
       │
       ▼
ExprRewriter (rewrite/ExprRewriter.java) ── 表达式规则改写引擎
   ├─ rules (Repeat): FoldConstantsRule / BetweenToCompoundRule / NormalizeBinaryPredicatesRule ...
   └─ mvExprRewriter (ToBitmapToSlotRefRule / CountDistinctToBitmapOrHLLRule 等 MV 改写)
       │  (改写后 re-analyze: parsedStmt.reset(); parsedStmt.analyze(analyzer))
       ▼
Planner (planner/Planner.java:49)
   ├─ SingleNodePlanner.createSingleNodePlan() (:128)  ── 单节点 PlanNode 树
   │    └─ createCheapestJoinPlan()  ── Cost-Based 按 cardinality 降序选最左
   └─ DistributedPlanner.createPlanFragments() (planner/DistributedPlanner.java:75)
        ├─ ScanNode → createScanFragment()
        ├─ HashJoinNode → createHashJoinFragment() (:303)
        │    └─ canColocateJoin() > canBucketShuffleJoin() > JoinCostEvaluation(Broadcast vs Shuffle)
        └─ AggregationNode → createAggregationFragment() (本地+全局两阶段)
            │
            ▼
        ArrayList<PlanFragment>  → Coordinator
```

## 调用链路

```
ConnectProcessor.handleQuery()                            [qe/ConnectProcessor.java:158]
  → StmtExecutor.execute()                                [qe/StmtExecutor.java:240]
    → analyze(tQueryOptions)                             [StmtExecutor.java:404]
      → SqlParser.parse(originStmt)                     [CUP 解析 → AST]
      → analyzer = new Analyzer(catalog, context)
      → parsedStmt.analyze(analyzer)                     [SelectStmt.analyze]
           ├─ fromClause.analyze()  → TupleDescriptor 绑定
           ├─ expandStar()          → SELECT * 展开
           ├─ Expr.analyze(resultExprs) → 类型推导
           └─ analyzeAggregation()  → GROUP BY/HAVING
      → parsedStmt.rewriteExprs(rewriter)               [ExprRewriter.rewrite() 循环应用规则]
      → StmtRewriter.rewrite(analyzer, parsedStmt)       [StmtRewriter.java:40]
           └─ rewriteWhereClauseSubqueries() → 子查询改 Join
      → re-analyze (parsedStmt.reset(); analyze)
    → handleQueryStmt()                                   [StmtExecutor.java:720]
      → planner.plan(parsedStmt, analyzer, tQueryOptions) [Planner.java:77]
        → createPlanFragments()                           [Planner.java:139]
          → singleNodePlanner.createSingleNodePlan()      [SingleNodePlanner.java:128]
          → distributedPlanner.createPlanFragments(plan) [DistributedPlanner.java:180 调 :75]
              → createHashJoinFragment() (:303) 选 Colocate/Bucket/Broadcast/Shuffle
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `SqlParser.parse` | CUP 解析 SQL | LALR(1)，对左递归 SQL 语法天然友好 |
| `Analyzer.registerConjuncts` | 谓词注册到 Tuple | 为后续下推提供归属数据结构 |
| `StmtRewriter.rewrite` | 子查询改写 | IN/EXISTS→Join，避免子查询执行 |
| `ExprRewriter.rewrite` | 表达式规则改写 | Repeat 规则循环到不变（规则在 `Analyzer.java:246` GlobalState 注册） |
| `createCheapestJoinPlan` | Cost-Based Join 重排 | 按 cardinality 估算降序选最左（`enable_join_reorder_based_cost`） |
| `DistributedPlanner.createHashJoinFragment` | 分布式 Join 策略 | Colocate>BucketShuffle>Broadcast>Shuffle 优先级链（`:303`） |
| `Planner.plan` | 计划生成入口 | 串起单节点计划与分布式切分（`:77`） |

</details>

## 核心实现

### Analyzer 是"状态仓库"而非优化器

`Analyzer`（`analysis/Analyzer.java:83`）的命名容易误导——它**不做优化**，只负责一次查询的语义状态：`tupleByAlias`/`slotRefMap` 维护名字到 `TupleDescriptor`/`SlotDescriptor` 的绑定，`tuplePredicates`/`slotPredicates` 记录每个谓词归属哪个 Tuple/Slot（谓词下推的基础数据结构），`eqJoinConjuncts` 收集等值 Join 谓词。关键设计是 **`GlobalState` 内部类**（`:167`）——一个查询的所有 `Analyzer` 实例（每个 select block 一个）共享同一个 `GlobalState`（含 `DescriptorTable`、`conjuncts` 全表、两个 `ExprRewriter`），子查询通过 `new Analyzer(parentAnalyzer)` 构造（继承 GlobalState）实现跨 block 的名字解析。`ExprRewriter` 的规则在 `GlobalState` 构造函数（`:246`）注册：`BetweenToCompoundRule`（先，把 Between 展开以触发其他规则）、`NormalizeBinaryPredicatesRule`（把 SlotRef 规范到左侧，为下推与 Parquet min/max 裁剪做准备）、`FoldConstantsRule`，外加一组物化视图改写规则（`ToBitmapToSlotRefRule` 等）。

### 优化分散在三层，没有独立 Optimizer

0.14.0 没有一个叫 `Optimizer` 的类，CBO 分散在：(1) `ExprRewriter` 做表达式级改写（常量折叠、谓词规范化）；(2) `StmtRewriter` 做语句级改写（子查询→Join）；(3) `SingleNodePlanner.createCheapestJoinPlan` 做 Join 树重排——按 cardinality 估算降序选最左叶子构造左深树，受 `enable_join_reorder_based_cost` 开关控制。**不做 bushy tree 搜索、没有代价模型**——这是 0.x/1.x 的局限，也是 2.0 引入 Nereids（Cascades）要解决的痛点。分布式层的 `DistributedPlanner.createHashJoinFragment`（`:303`）按 **Colocate > Bucket Shuffle > Broadcast/Shuffle** 的优先级链选 Join 分布方式，尽量利用数据物理分布避免 Shuffle。

### 为什么用 CUP 而非 ANTLR4

0.14.0 的 SQL 解析器用 **CUP**（LALR(1) 语法，`sql_parser.cup`）+ JFlex 词法器，而非 ANTLR4。这是 Impala 血统的遗产（Impala 早期即用 CUP）。LALR(1) 对 SQL 的左递归语法天然友好，无需 ANTLR4 的 LL(*) 左递归消除。代价是 CUP 生成的解析器可读性差、错误恢复弱。2.0 引入 Nereids 时才改用 ANTLR4 重写解析器。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态仓库 | `Analyzer` + `GlobalState`（`:83`/`:167`） | 把查询语义状态与优化逻辑解耦，Analyzer 只管"记录"，优化在别处 |
| 策略（规则链） | `ExprRewriter` + `ExprRewriteRule`（`rewrite/`） | 改写规则可插拔，Repeat/Once 两种应用语义 |
| 模板方法 | `Planner.plan`（`:77`）→ `createPlanFragments`（`:139`） | 固定"单节点计划→分布式切分"骨架 |

## 模块间交互

`analysis`/`planner` 依赖 `catalog`（`Analyzer` 构造时传入 `Catalog` 做 `Database`/`Table`/`Function` 名字解析与 `FunctionSet` 查找）与 `qe`（`StmtExecutor` 持有 `Analyzer`+`Planner`，`Coordinator` 消费 `PlanFragment`）。被 `qe.ConnectProcessor` 从入口驱动。生成的 `PlanFragment` 经 `Coordinator` 序列化为 Thrift `TExecPlanFragmentParams` 下发 BE。

## 扩展方式

新增表达式改写规则：实现 `ExprRewriteRule`，在 `Analyzer.java:246` 的 `GlobalState` 构造函数 `rules` 列表注册（注意规则顺序）。新增 Join 分布策略：改 `DistributedPlanner.createHashJoinFragment`（`:303`）的优先级链。新增 PlanNode 类型：在 `planner/` 加节点类 + `SingleNodePlanner` 构建逻辑 + `gensrc/thrift/PlanNodes.thrift` 的 `TPlanNodeType` 枚举。
