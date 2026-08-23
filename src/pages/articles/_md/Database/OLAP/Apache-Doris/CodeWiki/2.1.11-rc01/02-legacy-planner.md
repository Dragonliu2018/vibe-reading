---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "旧版优化器"
date: "2026-08-23T19:54:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.11-rc01"]
tags: ["Apache Doris", "Analyzer", "OriginalPlanner", "CUP", "Legacy", "回退"]
description: "Doris 2.1.11 旧版优化器：CUP/JFlex 解析 + Analyzer 绑定 + SingleNodePlanner/DistributedPlanner 规则式计划，Nereids 失败时的回退安全网。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.11-rc01/00-overview)

---

## 模块定位

旧版优化器是 `fe/fe-core/src/main/java/org/apache/doris/analysis/`（~8.6 万行，446 文件）+ `planner/`（~2.4 万行，74 文件），是 Nereids 之前的 SQL 解析与计划生成路径。它用 CUP/JFlex 解析 SQL（`sql_parser.cup` 8402 行），通过 `Analyzer` 绑定表引用与谓词，`OriginalPlanner` 经 `SingleNodePlanner`（规则式 Join 排序）+ `DistributedPlanner`（Fragment 切分）产出 `PlanFragment`。独立成文是因为 2.1.x 处于过渡期——Nereids 是默认路径但旧版仍完整保留为**回退安全网**（`enable_fallback_to_original_planner = true`），当 Nereids 遇到不支持的语法/功能时由 `StmtExecutor.executeByLegacy()` 接管。这是 2.1 LTS 与 4.x 的关键差异：4.x 已大幅移除 legacy 代码。

## 模块架构

```
SqlParser (CUP 生成) ── 词法 SqlScanner (JFlex 生成)
   │  parse() → List<StatementBase>
   ▼
StatementBase (analysis/StatementBase.java:38) ── 抽象基类 implements ParseNode
   ├─ QueryStmt → SelectStmt / UnionStmt
   ├─ DdlStmt / ShowStmt / InsertStmt ...
   │
   ▼ analyze(Analyzer)
Analyzer (analysis/Analyzer.java:116) ── 单 SELECT block 分析状态仓库
   ├─ registerTableRef() (:715)     ── 创建 TupleDescriptor + 别名映射
   ├─ registerConjunct() (:1333)    ── 分配 ExprId，存 conjuncts
   ├─ materializeSlots() (:2623)    ── 标记 Slot materialized
   └─ getDescTbl() (:1777)
   │
   ▼ OriginalPlanner.plan() (planner/OriginalPlanner.java:94)
SingleNodePlanner (planner/SingleNodePlanner.java)
   ├─ createSingleNodePlan() (:163) ── 按语句类型分发
   │    ├─ createSelectPlan() (:1181) ── ScanNode + Join + Agg
   │    ├─ createJoinPlan() (:1002)  ── 规则式左深树排序
   │    └─ createScanNode() (:1919)   ── 每个 TableRef → ScanNode
   ├─ ProjectPlanner.projectSingleNodePlan()
   └─ MaterializedViewSelector
   │
   ▼
DistributedPlanner (planner/DistributedPlanner.java)
   └─ createPlanFragments(PlanNode root, ...) (:183) ── 递归切分 Fragment
        ├─ ScanNode → createScanFragment()
        ├─ HashJoinNode → createHashJoinFragment()
        └─ ExchangeNode 插入在 Fragment 边界
```

## 调用链路

```
ConnectProcessor.executeQuery() [ConnectProcessor.java:237]
  ├─ [Nereids 失败回退] parse(convertedStmt)  ── SqlScanner + SqlParser (CUP)
  │    → SqlParserUtils.getMultiStmts(parser) → List<StatementBase>
  └─ StmtExecutor.execute() [StmtExecutor.java:554]
     └─ executeByLegacy(queryId) [StmtExecutor.java:886]
        ├─ parseByLegacy()                    ── 确保已解析
        ├─ analyzeVariablesInStmt()           ── SET_VAR hint
        ├─ analyze(sessionVariable.toThrift()) [StmtExecutor.java:1166]
        │    ├─ analyzer = new Analyzer(env, context)  (:1215)
        │    └─ parsedStmt.analyze(analyzer)           ── StatementBase.analyze → 子类重写
        └─ OriginalPlanner.plan(queryStmt, queryOptions) [OriginalPlanner.java:94]
             ├─ createPlanFragments() (:153)
             │    ├─ singleNodePlanner.createSingleNodePlan() (:163)
             │    ├─ ProjectPlanner.projectSingleNodePlan()
             │    └─ DistributedPlanner.createPlanFragments() (:183)
             └─ → fragments 列表 → TExecPlanFragment → 下发 BE
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `SqlParser.parse` | CUP 解析 SQL | 8402 行语法文件，构建时生成 |
| `StatementBase.analyze` | 分析入口 | Visitor 变体，子类重写 |
| `Analyzer.registerTableRef` | 注册表引用 | 创建 TupleDescriptor + 别名映射 |
| `Analyzer.registerConjunct` | 注册谓词 | 分配 ExprId，简化 substitute |
| `SingleNodePlanner.createJoinPlan` | 规则式 Join 排序 | 左深树策略，无 CBO |
| `DistributedPlanner.createPlanFragments` | Fragment 切分 | 纯规则式（按节点类型 + limit） |

</details>

## 核心实现

### StatementBase 继承体系与 Analyzer

`StatementBase`（`analysis/StatementBase.java:38`）是所有 SQL 语句的抽象基类，实现 `ParseNode` 接口，持有 `Analyzer analyzer` 引用和 `ExplainOptions`。`analyze(Analyzer)` 方法设置 `this.analyzer = analyzer` 并记录 root statement class，防止重复分析。子类 `SelectStmt.analyze()` 重写此方法，调用 `Analyzer.registerTableRef()` 注册表引用、`registerConjuncts()` 注册 WHERE 谓词。

`Analyzer`（`analysis/Analyzer.java:116`）是"单个 SELECT block 的分析状态仓库"，维护 `uniqueTableAliasSet`（表别名唯一性检查）、`tupleByAlias`（别名→TupleDescriptor 映射）、`conjuncts`（全局谓词注册表，用 ExprId 引用以简化 substitute 操作）。`registerConjunct(Expr, TupleId)` 分配唯一 ExprId 并存入容器；`materializeSlots(List<Expr>)` 标记 expr 引用的 Slot 为 materialized，决定查询读取哪些列。

### PlanNode 继承体系与计划生成

`PlanNode`（`planner/PlanNode.java:82`）是所有计划节点的抽象基类，继承 `TreeNode<PlanNode>`，持有 `PlanNodeId id`、`tupleIds`、`conjuncts`（该节点可执行的谓词）、`cardinality`（输出基数估计）、`fragment`（所属 Fragment）。值得注意的是 `nereidsId` 字段（`:160`）——Nereids 产出的物理计划节点也继承 PlanNode，两套优化器**共享物理执行层**。

`SingleNodePlanner.createJoinPlan()`（`:1002`）和 `createCheapestJoinPlan()`（`:916`）使用**启发式规则**而非 CBO 排序 Join：基于左深树（left-deep tree）策略，基于谓词连接条件判断两表是否可 Join，小表作为 build side。这是规则式优化器，与 Nereids 的 Cascades CBO 形成对比。

### 两套优化器的三级回退机制

`enable_nereids_planner` 默认 `true`（`SessionVariable.java:1359`），`enableFallbackToOriginalPlanner` 默认 `true`（`:1484`）。回退分三级：

1. **解析阶段回退**（`ConnectProcessor.java:268-300`）：`NereidsParser.parseSQL()` 抛 `ParseException` → 直接回退旧 `parse()`；抛 `DoNotFallbackException` → 直接报错不回退；抛其他 Exception → 设置 `nereidsParseException` 后回退。
2. **执行阶段回退**（`StmtExecutor.java:560-610`）：`executeByNereids()` 抛 `NereidsException`/`ParseException` 时，若 `enableFallbackToOriginalPlanner` 开启则回退 `executeByLegacy()`。
3. **单次禁用**（`SessionVariable.java:4189`）：`disableNereidsPlannerOnce()` 在旧版路径中调用，临时关闭当前 session 的 nereids 开关，避免后续 SQL 反复尝试再回退。

`force_fallback` 特殊逻辑（`StmtExecutor.java:597`）：`InsertIntoTableCommand`（非外部表）强制回退旧版，因 Nereids 对某些 Insert 场景支持不完整。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Visitor 变体 | `StatementBase.analyze(Analyzer)` in `analysis/StatementBase.java:82` | Analyzer 作为"状态仓库 + 分析工具"，子类 analyze() 主动调用注册方法 |
| Template Method | `OriginalPlanner.plan()` in `planner/OriginalPlanner.java:94` | 固定调用顺序：SingleNode→Project→Distributed |
| 规则式优化 | `SingleNodePlanner.createJoinPlan` in `planner/SingleNodePlanner.java:1002` | 左深树 + 启发式，无 CBO（Nereids 替代原因） |

## 模块间交互

`analysis` 被 `qe` 调用：入口在 `ConnectProcessor.executeQuery()`（`ConnectProcessor.java:525-528`）——`SqlScanner` + `SqlParser`（CUP/JFlex 生成）解析为 `List<StatementBase>`。`planner` 产出 Fragment：`OriginalPlanner.createPlanFragments()`（`OriginalPlanner.java:153`）将 `PlanNode` 树递归切分为 `PlanFragment` 列表，每个 Fragment 含一个 PlanNode 子树和一个 `DataPartition`（数据分布策略）。

与 Nereids 的切换点在 `StmtExecutor.execute()`（`:562`）：`parsedStmt instanceof LogicalPlanAdapter` 或 `isEnableNereidsPlanner()` 走 Nereids，否则/回退走 Legacy。

## 扩展方式

**新增一种 SQL 语法**：修改词法文件 `fe-core/src/main/jflex/sql_scanner.flex` 新增关键字 token；修改语法文件 `fe-core/src/main/cup/sql_parser.cup` 新增产生式返回新节点；新建 `analysis/XxxExpr.java` 继承 `Expr` 实现 `analyze(Analyzer)`。若 Nereids 也需支持，在 `fe-core/src/main/antlr4/` 的 ANTLR4 语法同步添加。对应测试：`fe/fe-core/src/test/java/org/apache/doris/analysis/`。
