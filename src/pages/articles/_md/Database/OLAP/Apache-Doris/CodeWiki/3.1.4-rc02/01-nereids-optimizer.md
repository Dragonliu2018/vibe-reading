---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Nereids 优化器"
date: "2026-08-23T18:56:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "Nereids", "Cascades", "CBO", "ANTLR4"]
description: "Doris 3.1.4 Nereids 优化器：ANTLR4 解析 + 启发式重写 + Cascades CBO + DPHyp join reorder，SQL 到物理计划全流水线。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

Nereids 是 Doris 的新一代查询优化器，灵感来自 Spark（Parser/Expression）与 CMU NoisePage（Cascades Optimizer）。它把一条 SQL 文本经「解析 → 分析 → 重写 → CBO → 物理计划 → 分布式计划」流水线，产出可分发到 BE 的 `PlanFragment` 树。在 3.1.4-rc02 中 Nereids 是**默认**优化路径（`enable_nereids_planner=true` in `SessionVariable.java:1498`），是 FE 最大模块（~24.6 万行 Java）。它独立成文是因为优化是自成一体的决策域——规则、代价模型、Memo 数据结构构成完整闭环，与执行调度正交，且与旧版优化器（见 [02-legacy-planner](02-legacy-planner)）是两条可切换的并行路径。

## 模块架构

Nereids 内部分四层：**解析层**（`NereidsParser` + ANTLR4 生成 `DorisLexer`/`DorisParser`，把 SQL 文本转 `LogicalPlan`）、**计划树层**（`trees/plans/` 下 logical/physical 节点，如 `LogicalOlapScan`/`PhysicalHashJoin`）、**规则层**（`rules/` 下 RewriteRuleFactory/Implementation rule DSL + `RuleSet` 容器）、**Cascades 引擎层**（`memo/` 的 `Memo`/`Group`/`GroupExpression` + `jobs/cascades/` 的 Job 调度）。

```
SQL 文本
   │  NereidsParser (ANTLR4)  ── parser/LogicalPlanBuilder
   ▼
LogicalPlan (UnboundRelation, UnboundSlot)
   │  Analyzer  ── BindRelation/BindExpression
   ▼
LogicalPlan (LogicalOlapScan, SlotReference)  ── bound
   │  Rewriter  ── 启发式规则 (whole_tree/children rewrite jobs)
   ▼
LogicalPlan (rewritten)
   │  Optimizer  ── Cascades: Memo + Group + GroupExpression
   ▼
PhysicalPlan (PhysicalOlapScan, PhysicalHashJoin...)
   │  PlanPostProcessors  ── PushDownFilter/RuntimeFilterGenerator/FragmentProcessor
   ▼
PlanFragment 树  ── 交给 Coordinator 调度
```

核心是 `NereidsPlanner`（`nereids/NereidsPlanner.java:102`）编排这六阶段，它持有五个 `Plan` 字段（`parsedPlan`/`analyzedPlan`/`rewrittenPlan`/`optimizedPlan`/`physicalPlan`，见 `NereidsPlanner.java:105-109`）对应流水线各阶段产物。

## 调用链路

`StmtExecutor.executeByNereids` 创建 `NereidsPlanner` 并调 `plan`：

```
StmtExecutor.executeByNereids (StmtExecutor.java:715)
  └─ new NereidsPlanner(statementContext)
  └─ planner.plan(parsedStmt, queryOptions) (NereidsPlanner.java:127)
       ├─ preprocess ── PlanPreprocessors.process() (处理 SET_VAR hint)
       ├─ initCascadesContext ── CascadesContext.initContext (NereidsPlanner.java:355)
       ├─ collectAndLockTable ── TableCollector.collect() + statementContext.lock()
       └─ planWithoutLock (NereidsPlanner.java:243)
            ├─ analyze()  ── Analyzer 按 ANALYZE_JOBS 绑定表/列/函数
            ├─ rewrite()  ── Rewriter 执行启发式重写规则
            ├─ optimize()  ── new Optimizer(cascadesContext).execute()
            │    ├─ cascadesContext.toMemo()  ── plan 转入 Memo
            │    ├─ DeriveStatsJob  ── 递归推导统计信息
            │    ├─ [条件] dpHypOptimize()  ── JoinOrderJob (join 数 > 阈值时用 DPHyp)
            │    └─ OptimizeGroupJob(root)  ── Cascades 自顶向下
            │         └─ ApplyRuleJob ── rule.transform() → memo.copyIn()
            ├─ chooseNthPlan(getRoot(), requireProperties, nth)  ── 选最优 PhysicalPlan
            └─ postProcess ── PlanPostProcessors (下推/RuntimeFilter/Fragment 切分)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `NereidsPlanner.plan` (`:127`) | 编排六阶段 | 调用链顺序固化，每阶段可短路（explain level） |
| `planWithLock` (`:198`) | 锁表后优化 | 先 `collectAndLockTable` 再优化，避免优化中表结构变更 |
| `planWithoutLock` (`:243`) | analyze→rewrite→optimize | Minidump 在此序列化输入，便于离线复现 |
| `Optimizer.execute` (`:53`) | Cascades 优化 | toMemo→DeriveStats→[DPHyp]→OptimizeGroupJob |
| `chooseNthPlan` | 选第 N 优计划 | 支持 `nth_optimized_plan` 选次优用于对比 |
| `postProcess` | 计划后处理 | RuntimeFilter、Fragment 切分、TopnFilter 等 |

</details>

## 核心实现

### Cascades 搜索：Memo 与 Group

Cascades 的核心数据结构是 `Memo`（`nereids/memo/Memo.java`），它把逻辑/物理计划拆成 `GroupExpression`（单个算子实例）与 `Group`（等价算子集合）。优化时规则对 GroupExpression 做 `transform` 生成新的等价表达式，经 `copyIn` 合并进 Memo——同一 Group 的多个 GroupExpression 即等价计划空间，代价最小者胜出。

```java title="nereids/jobs/executor/Optimizer.java"
public void execute() {
    cascadesContext.toMemo();                       // plan 转入 Memo
    cascadesContext.pushJob(new DeriveStatsJob(...)); // 统计推导
    cascadesContext.getJobScheduler().executeJobPool(cascadesContext);
    // DPHyp：join 数超过阈值或显式开启时走 DPHyp join reorder
    int maxJoinCount = cascadesContext.getMemo().countMaxContinuousJoin();
    boolean isDpHyp = getSessionVariable().enableDPHypOptimizer
            || maxJoinCount > maxTableCount;
    if (!getSessionVariable().isDisableJoinReorder() && isDpHyp ...)
        dpHypOptimize();                            // JoinOrderJob
    // Cascades 自顶向下优化
    cascadesContext.pushJob(new OptimizeGroupJob(
            cascadesContext.getMemo().getRoot(), cascadesContext.getCurrentJobContext()));
    cascadesContext.getJobScheduler().executeJobPool(cascadesContext);
}
```

设计决策：**为何 DPHyp 与 Cascades 共存**——DPHyp 是精确的 join 枚举算法，对小规模（≤64 join）多表连接能保证全局最优，但代价是 O(3^n)；Cascades 用代价模型+剪枝处理大规模场景。`maxTableCountUseCascadesJoinReorder` 阈值（`Optimizer.java:73`）决定走哪条路径，兼顾准确性与可扩展性。统计信息未知时阈值翻倍（`optimizeWithUnknownColStats`），让 Cascades 在不确定时承担更多。

### 规则系统：Rewrite 与 Implementation

Nereids 的规则分两类：**重写规则**（`Rewriter.java` 驱动，启发式 RBO，如谓词下推、子查询消除、列裁剪）与**实现规则**（Cascades 阶段，把逻辑算子转物理算子，如 `LogicalHashJoin → PhysicalHashJoin`）。规则用 `RuleFactory` DSL 描述匹配模式（`<LogicalFilter.leaf>`
 之类），`RuleSet` 容器按 `JobType`（WHOLE_TREE / CHILDREN / EXPLORATION / IMPLEMENTATION）分组。

设计决策：**为何用 DSL 而非命令式匹配**——DSL 声明"匹配什么、转成什么"，框架负责遍历树与应用，规则作者不写递归，降低出错面；同时 DSL 可静态校验模式合法性。

### 分布式计划：DistributePlanner

优化产出的 `PhysicalPlan` 还需切分成可分布式执行的 `PlanFragment` 树，由 `trees/plans/distribute/DistributePlanner` 完成——按 Exchange 边界切分 Fragment、分配 `FragmentIdMapping`。`NereidsPlanner.distribute()`（`:154`）触发，结果存入 `distributedPlans`，供 `Coordinator` 消费。

### Minidump 与可复现

`planWithoutLock` 入口先 `MinidumpUtils.serializeInputsToDumpFile`（`:249`），出口 `serializeOutputToDumpFile`。这意味着每次优化失败都能把输入序列化成 minidump 文件，离线用 `NereidsTracer` 复现调试——这是 Nereids 工程化的关键可观测性设计。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Cascades 搜索 | `memo/Memo.java` + `jobs/cascades/` | Memo 记录等价空间，代价剪枝，比启发式更准 |
| Job 调度 | `jobs/scheduler/` + `JobScheduler.executeJobPool` | 优化任务异步可调度，支持统计推导与规则应用并行 |
| 规则 DSL | `rules/` RuleFactory | 声明式匹配，框架统一遍历，规则可组合 |
| Visitor | `trees/visitor/` + `TreeNode` 递归 | 计划树遍历与改写解耦 |
| 策略（DPHyp vs Cascades） | `Optimizer.execute` | 按规模选算法，兼顾精度与扩展性 |

## 模块间交互

Nereids **依赖** `catalog/`（`TableCollector` 收集表并加锁、`LogicalCatalogRelation` 引用表元数据）、`datasource/`（外部表 scan）、`qe/`（`StatementContext`/`ConnectContext` 持会话变量）。**被** `qe/StmtExecutor` 调用入口、`qe/Coordinator` 消费其 `distributedPlans` 与 `RuntimeFilter`。与旧版优化器（`analysis/`+`planner/`）是互斥关系——由 `StmtExecutor` 按 `enable_nereids_planner` 与异常回退决定走哪条。

## 扩展方式

新增一条优化规则：在 `nereids/rules/` 下用 `RuleFactory` 声明规则（定义匹配模式 + transform），按类型注册到 `Rewriter` 的 `WHOLE_TREE_REWRITE_JOBS`（重写阶段）或 `Optimizer` 的 exploration/implementation 规则集（Cascades 阶段）。若涉及 join reorder，注意 `nereids/jobs/joinorder/`。对应测试：`regression-test/suites/nereids_p0/`。
