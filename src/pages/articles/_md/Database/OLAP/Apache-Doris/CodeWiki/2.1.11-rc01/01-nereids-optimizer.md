---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Nereids 优化器"
date: "2026-08-23T19:52:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.11-rc01"]
tags: ["Apache Doris", "Nereids", "Cascades", "CBO", "Memo", "DPHyp"]
description: "Doris 2.1.11 Nereids：Cascades CBO 优化器，Memo 等价空间搜索 + 三阶段规则（analysis/rewrite/implementation）+ DPHyp join reorder + ORCA 式属性强制。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.11-rc01/00-overview)

---

## 模块定位

Nereids 是 Doris 的新一代 **Cascades 代价优化器**，位于 `fe/fe-core/src/main/java/org/apache/doris/nereids/`（~22 万行，1777 个文件）。它替代旧版 `analysis/Analyzer` + `planner/OriginalPlanner` 的启发式优化路径，用 Memo 记录等价计划空间、基于统计与代价搜索最优物理计划。独立成文是因为 CBO 是 MPP 数仓多表 join 性能的核心——旧优化器只能生成左深树，而 Cascades 能穷举 bushy plan 拓扑。2.1 线中 Nereids 已是默认路径（`enableNereidsPlanner = true` in `SessionVariable.java:1359`），旧版保留为回退安全网（见 [02-legacy-planner](02-legacy-planner)）。

## 模块架构

```
NereidsPlanner (nereids/NereidsPlanner.java) ── 优化总入口，extends 旧版 Planner
   │  plan() → planWithLock() → planWithoutLock()
   │
   ▼
CascadesContext (nereids/CascadesContext.java) ── 三阶段共享上下文
   ├─ Memo memo                       ── optimize 阶段的等价空间
   ├─ RuleSet ruleSet                 ── 规则集
   ├─ JobPool jobPool                 ── Job 栈
   └─ JobScheduler jobScheduler       ── SimpleJobScheduler（单线程串行）
   │
   ├── newAnalyzer() → Analyzer (jobs/executor/Analyzer.java)     ── 阶段1：绑定关系/语义
   ├── Rewriter.getWholeTreeRewriter() (jobs/executor/Rewriter.java) ── 阶段2：启发式改写
   └── new Optimizer()  → Optimizer (jobs/executor/Optimizer.java)   ── 阶段3：Cascades 搜索
         ├─ toMemo()                  ── plan → Memo
         ├─ DeriveStatsJob            ── 统计推导
         ├─ [条件] JoinOrderJob       ── DPHyp join reorder
         └─ OptimizeGroupJob          ── 递归优化 Group
              ├─ OptimizeGroupExpressionJob ── 触发 exploration + implementation 规则
              │    └─ ApplyRuleJob         ── 模式匹配 → transform → copyIn
              └─ CostAndEnforcerJob        ── 计算 cost + 插入 enforcer（ORCA 式）
   │
   ▼
Memo (nereids/memo/Memo.java) ── Cascades 核心数据结构
   ├─ Map<GroupId, Group> groups
   └─ Group → GroupExpression（Plan + children Groups + lowestCostTable + ruleMasks）
   │
   ▼
PhysicalPlan → translate() → PlanFragment（物理计划→可执行 Fragment）
```

## 调用链路

```
NereidsPlanner.plan(StatementBase, TQueryOptions) [NereidsPlanner.java:107]
└─ planWithLock(parsedPlan, ...) [NereidsPlanner.java:178]
   ├─ preprocess(plan)                      ── SET_VAR hint 等预处理
   ├─ initCascadesContext(plan, ...)         ── CascadesContext.initContext()
   ├─ collectAndLockTable()                 ── 收集表 + 加锁
   └─ planWithoutLock(plan, ...) [NereidsPlanner.java:224]
      ├─ analyze()  → cascadesContext.newAnalyzer().analyze()      [Analyzer.java:81]
      │    └─ 遍历 ANALYZE_JOBS (RewriteJob) → rule.transform()
      ├─ rewrite() → Rewriter.getWholeTreeRewriter().execute()    [Rewriter.java:490]
      │    └─ 遍历 WHOLE_TREE_REWRITE_JOBS (topic→topDown/bottomUp)
      ├─ optimize() → new Optimizer(cascadesContext).execute()    [Optimizer.java:46]
      │    ├─ cascadesContext.toMemo()                            ── 构建 Memo
      │    ├─ pushJob(new DeriveStatsJob(...))
      │    ├─ [条件] dpHypOptimize() → pushJob(new JoinOrderJob(...))
      │    └─ pushJob(new OptimizeGroupJob(root, context))
      │         └─ executeJobPool 循环 pop Job 执行
      │              ├─ OptimizeGroupJob → OptimizeGroupExpressionJob + CostAndEnforcerJob
      │              ├─ OptimizeGroupExpressionJob → ApplyRuleJob（exploration + implementation）
      │              └─ ApplyRuleJob → pattern.matchRoot → rule.transform → memo.copyIn
      ├─ chooseBestPlan(rootGroup, physicalProperties)            ── 从 Memo 取最优
      ├─ postProcess(physicalPlan) → PlanPostProcessors
      └─ translate(physicalPlan) → PhysicalPlanTranslator        ── → PlanFragment
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `NereidsPlanner.planWithoutLock` | 编排 analyze→rewrite→optimize→translate | 加锁与编排分离，支持并发 DDL |
| `CascadesContext.initContext` | 创建三阶段共享上下文 | Memo/RuleSet/JobPool 在此初始化 |
| `Optimizer.execute` | Cascades 优化入口 | toMemo→DeriveStats→DPHyp→OptimizeGroup |
| `Memo.copyIn` | 将变换后的 plan 插入 Memo | 五种 case 处理生成/合并 Group |
| `Memo.mergeGroup` | 合并等价 Group | 自动发现等价性，避免搜索爆炸 |
| `ApplyRuleJob.execute` | 模式匹配 + 规则变换 | GroupExpressionMatching 过滤 |
| `CostAndEnforcerJob.execute` | 计算 cost + 插入 enforcer | ORCA 式属性强制 |
| `Rewriter.getWholeTreeRewriter` | 启发式改写执行器 | topic + topDown/bottomUp DSL 编排 |

</details>

## 核心实现

### Cascades Memo 与 Group/GroupExpression

`Memo`（`memo/Memo.java:71`）是 Cascades 搜索空间的核心数据结构。`init(plan)` 递归将 Plan 树拆解为 `Group`（等价表达式集合）与 `GroupExpression`（Group 内一个具体表达式）。`copyIn(plan, target, rewrite)` 是变换后插入新计划的方法，内部处理五种 case（生成新 Group、合并 Group、替换已有表达式）。

`GroupExpression`（`memo/GroupExpression.java:53`）持有 `Plan` + `List<Group> children`（子 Group 引用）+ `lowestCostTable`（`Map<PhysicalProperties, Pair<Cost, List<PhysicalProperties>>>`）+ `ruleMasks`（BitSet 记录已应用规则）。`updateLowestCostTable()` 按 `PhysicalProperties` 键存储多个 cost 条目，支持同一表达式在不同属性要求下的最优。`mergeGroup()`（`Memo.java:567`）在发现两个 Group 等价时，将一个 Group 的所有父引用重定向到另一个并合并状态——这是 Cascades 自动发现等价性的机制。

**为什么用 Group 而非直接存 Plan**：Group 实现等价类共享——同一子树的所有等价变换只优化一次，cost 表复用；`ruleMasks` 避免重复应用同一规则；`mergeGroup` 自动发现 join 交换律等产生的等价 Group，避免搜索空间爆炸。

### 三阶段规则系统

规则分为 analysis、rewrite、implementation 三阶段，各有独立执行器：

- **analysis 阶段**（`Analyzer.java:92` `buildAnalyzerJobs()`）：绑定关系引用、表达式语义检查。必须在 rewrite 之前，因为改写规则依赖已绑定的列引用。
- **rewrite 阶段**（`Rewriter.java:154`）：启发式逻辑改写，不依赖 cost。用 `topic()` 分组 + `topDown()`/`bottomUp()` 控制遍历方向，使规则依赖关系显式（如 `InferPredicates` 必须在 `ColumnPruning` 之后）。`costBased()` 标记的规则在禁用 cost-based 优化时跳过。
- **implementation 阶段**（`RuleSet.java:179` `IMPLEMENTATION_RULES`，37 条）：Logical→Physical 规则（如 `LogicalJoinToHashJoin`、`LogicalOlapScanToPhysicalOlapScan`），在 `OptimizeGroupExpressionJob` 中触发。

`Rule`（`rules/Rule.java`）抽象基类持有一个 `Pattern`，`GroupExpressionMatching`（`pattern/GroupExpressionMatching.java`）实现 `Iterable<Plan>`，在 `ApplyRuleJob.execute()` 中通过 `pattern.matchRoot()` 过滤，再对匹配的 plan 调用 `rule.transform()`。

### DPHyp 与 Cascades 双策略 Join Reorder

`Optimizer.execute()`（`Optimizer.java:60-75`）按表数选择 join reorder 策略：表数 ≤ `maxTableCount`（`SessionVariable.getMaxTableCountUseCascadesJoinReorder()`）用 Cascades 枚举规则（`BUSHY_TREE_JOIN_REORDER`），否则用 DPHyp（`JoinOrderJob`，动态规划）。列统计未知时翻倍阈值，因为 Cascades 在统计缺失时退化更严重。

### CostAndEnforcer 的 ORCA 式属性强制

`CostAndEnforcerJob`（`jobs/cascades/CostAndEnforcerJob.java:88`，注释 "Inspired by NoisePage and ORCA-Paper"）通过 `RequestPropertyDeriver` 推导子节点需要的属性，`ChildrenPropertiesRegulator` 调节，`EnforceMissingPropertiesHelper` 在 gap 处插入 enforcer 节点（如 `DistributeExchange`），确保物理属性（分布、排序）满足父节点要求。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Cascades 搜索 | `Optimizer.execute` in `jobs/executor/Optimizer.java:46` | Memo 记录等价空间，基于代价剪枝搜索，比启发式更准 |
| Job 调度器 | `SimpleJobScheduler.executeJobPool` in `jobs/scheduler/SimpleJobScheduler.java:32` | 单线程串行 pop Job 执行，带超时检查，递归式 Cascades 优化 |
| Visitor（ANTLR4） | `LogicalPlanBuilder` extends `DorisParserBaseVisitor` in `parser/` | SQL AST → LogicalPlan 树 |
| Adapter | `glue/LogicalPlanAdapter.java` | 将 Nereids `LogicalPlan` 包装为旧版 `StatementBase`，衔接新旧优化器 |
| 不可变树 + 自重写 | `trees/TreeNode.java` | `withChildren()` 返回新节点，`rewriteUp()`/`rewriteDownShortCircuit()` 提供遍历重写原语 |

## 模块间交互

Nereids 被调用入口：`StmtExecutor.executeByNereids()`（`qe/StmtExecutor.java:798`）创建 `new NereidsPlanner(statementContext)` 并调用 `planner.plan()`。入口条件：`parsedStmt instanceof LogicalPlanAdapter` 或 `sessionVariable.isEnableNereidsPlanner()`（`StmtExecutor.java:562`）。

与旧版优化器的切换：`enable_nereids_planner`（`SessionVariable.java:1359`，默认 `true`）控制是否启用 Nereids；`enable_fallback_to_original_planner`（`SessionVariable.java:1484`，默认 `true`）控制失败时是否回退。Nereids 抛出 `NereidsException`/`MustFallbackException` 时，`StmtExecutor` catch 块回退 `executeByLegacy()`。

## 扩展方式

**新增一条优化规则**（rewrite 规则）：在 `rules/rewrite/` 下新建规则类（实现 `CustomRewriter` 或 `RuleFactory`），实现 `transform()` 方法；在 `rules/RuleType.java` 添加枚举值；在 `jobs/executor/Rewriter.java` 的 `CTE_CHILDREN_REWRITE_JOBS_BEFORE_SUB_PATH_PUSH_DOWN` 的合适 `topic()` 内注册。若是 implementation 规则，在 `rules/RuleSet.java` 的 `IMPLEMENTATION_RULES` 中 `.add(new XxxRule())`。对应测试：`regression-test/suites/nereids_p0/`。
