---
title: "将物化视图透明重写提前到 RBO 阶段"
source:
  project: "Doris"
  type: "PR"
  id: "50895"
  url: "https://github.com/apache/doris/pull/50895"
  prType: "enhancement"
date: "2026-08-05T15:30:00+08:00"
category: [Database, OLAP, Apache Doris, PRs]
tags: ["Apache Doris", "MTMV", "Optimizer", "RBO", "CBO", "Cascades", "Java"]
description: "通过在 RBO 阶段引入预重写机制，在 CBO 优化前完成物化视图透明改写，避免后续 RBO 规则（如 join 条件消除、limit 下推）改变计划结构导致透明重写失败。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#50895](https://github.com/apache/doris/pull/50895) · **Issue** - · **commit** [1feaef38](https://github.com/apache/doris/commit/1feaef3858231da87dad4586315d95ece6f39bfa) · **首发版本** 4.0.0 · **变更行数** +8999 行 · **合并时间** 2025-08-22

---

## 背景

Doris 的查询优化器（Nereids）分为两个阶段：**RBO**（Rule-Based Optimization，基于规则优化）和 **CBO**（Cost-Based Optimization，基于代价优化）。物化视图（Materialized View, MV）的透明重写——即自动将查询路由到物化视图而非基表——原本发生在 **CBO 阶段**。

问题在于：物化视图的定义 SQL 和查询 SQL 都会先经过完整的 RBO 重写，然后才进入 CBO 做 MV 透明重写。如果 RBO 阶段对查询计划和物化视图计划的改写路径出现分歧，透明重写就会失败。

### 典型失败场景

物化视图定义：

```sql title="物化视图定义 SQL"
select l_shipdate, o_orderdate, l_partkey, l_suppkey,
       sum(o_totalprice) as sum_total
from lineitem
left join orders on lineitem.l_orderkey = orders.o_orderkey and l_shipdate = o_orderdate
group by l_shipdate, o_orderdate, l_partkey, l_suppkey;
```

查询：

```sql title="查询 SQL"
select t1.l_partkey, t1.l_suppkey, o_orderdate, sum(o_totalprice)
from (select * from lineitem where l_shipdate = '2023-12-11') t1
left join orders on t1.l_orderkey = orders.o_orderkey and t1.l_shipdate = o_orderdate
group by o_orderdate, l_partkey, l_suppkey;
```

查询中子查询 `where l_shipdate = '2023-12-11'` 使得 `t1.l_shipdate` 成为常量，RBO 规则 `EliminateConstHashJoinCondition` 会消除 join 条件 `t1.l_shipdate = o_orderdate`。但物化视图定义中 `l_shipdate` 不是常量，对应的 join 条件无法消除。两边计划结构不一致 → 透明重写失败。

类似地，`limit` 下推等优化规则也会改变计划结构，导致同样的失败。

---

## 前置知识

### Nereids 优化流程

```
SQL → Analyzer → Rewriter(RBO) → Optimizer(CBO/Cascades) → Physical Plan
                       ↑                    ↑
                   规则重写            代价优化 + MV透明重写(旧)
```

| 阶段 | 职责 | 关键类 |
| --- | --- | --- |
| Analyze | 绑定表/列，类型检查 | `Analyzer` |
| Rewrite (RBO) | 基于规则改写计划（消除常量、下推 filter/limit 等） | `Rewriter` |
| Optimize (CBO) | 基于 Cascades 框架做代价优化，包括 MV 透明重写 | `Optimizer` |

### Cascades Memo 结构

CBO 阶段使用 **Cascades** 框架，核心数据结构是 **Memo**——一个有向无环图，将计划拆分为 **Group**（等价计划集合）和 **GroupExpression**（单个计划节点）。MV 透明重写规则作为探索规则在 Memo 中展开候选计划，最终由代价选择最优方案。

---

## 实现

### 核心思路：重写时机提前

将 MV 透明重写从 CBO 阶段提前到 **RBO 阶段之后、CBO 阶段之前**：

```
SQL → Analyzer → Rewriter(RBO) → [预MV重写] → Optimizer(CBO) → Physical Plan
                                     ↑
                              在RBO结果上做MV透明改写
```

具体做法是：RBO 重写完成后，先记录一份"快照"计划，然后基于这份快照在独立的 Cascades Memo 中尝试 MV 透明重写。如果成功，将重写后的逻辑计划作为 CBO 的初始计划；如果失败，回退到原始 RBO 结果继续 CBO。

### 三种重写策略

新增 session 变量 `pre_materialized_view_rewrite_strategy`，默认 `TRY_IN_RBO`：

```java title="fe/fe-core/src/main/java/org/apache/doris/qe/SessionVariable.java"
public static final String PRE_MATERIALIZED_VIEW_REWRITE_STRATEGY
        = "pre_materialized_view_rewrite_strategy";

@VariableMgr.VarAttr(name = PRE_MATERIALIZED_VIEW_REWRITE_STRATEGY, needForward = true, fuzzy = true,
        description = {"在RBO阶段基于结构信息的物化视图透明改写的策略", ...})
public String preMaterializedViewRewriteStrategy = "TRY_IN_RBO";
```

| 策略 | 行为 |
| --- | --- |
| `FORCE_IN_RBO` | 强制在 RBO 阶段做透明重写 |
| `TRY_IN_RBO`（默认） | 仅当 `NEED_PRE_REWRITE_RULE_TYPES` 中的规则改写成功时才尝试 |
| `NOT_IN_RBO` | 不在 RBO 阶段重写，回退到旧的 CBO 阶段重写 |

### NEED_PRE_REWRITE_RULE_TYPES：触发预重写的规则集合

`PreMaterializedViewRewriter` 中定义了一个 `BitSet`，标记哪些 RBO 规则可能改变计划结构、从而需要尝试预重写：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/rules/exploration/mv/PreMaterializedViewRewriter.java"
public static BitSet NEED_PRE_REWRITE_RULE_TYPES = new BitSet();

static {
    NEED_PRE_REWRITE_RULE_TYPES.set(RuleType.PUSH_DOWN_TOP_N_THROUGH_JOIN.ordinal());
    NEED_PRE_REWRITE_RULE_TYPES.set(RuleType.PUSH_DOWN_TOP_N_THROUGH_PROJECT_JOIN.ordinal());
    // ... 其他 topN/limit 下推规则 ...
    NEED_PRE_REWRITE_RULE_TYPES.set(RuleType.PUSH_LIMIT_THROUGH_JOIN.ordinal());
    NEED_PRE_REWRITE_RULE_TYPES.set(RuleType.LIMIT_SORT_TO_TOP_N.ordinal());
    NEED_PRE_REWRITE_RULE_TYPES.set(RuleType.LIMIT_AGG_TO_TOPN_AGG.ordinal());
    NEED_PRE_REWRITE_RULE_TYPES.set(RuleType.ELIMINATE_CONST_JOIN_CONDITION.ordinal());
    NEED_PRE_REWRITE_RULE_TYPES.set(RuleType.CONSTANT_PROPAGATION.ordinal());
    // ...
}
```

这些规则的特点是会改变计划的**结构**（消除 join 条件、下推 limit、改变聚合形态），而不是简单的表达式化简。结构变化会导致 MV 匹配失败，因此需要在它们生效前就完成 MV 重写。

### NereidsPlanner：编排预重写流程

`NereidsPlanner.planWithoutLock` 是优化主流程。PR 在 RBO 之后插入 `preMaterializedViewRewrite()` 调用：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/NereidsPlanner.java"
private Plan planWithoutLock(...) {
    // ...
    rewrite(showRewriteProcess(explainLevel, showPlanProcess));  // RBO
    preMaterializedViewRewrite();                                 // 预MV重写（新增）
    // ... CBO ...
}
```

`rewrite` 方法末尾设置 `needPreMvRewrite` 标志：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/NereidsPlanner.java"
protected void rewrite(boolean showPlanProcess) {
    // ... RBO 规则重写 ...
    statementContext.setNeedPreMvRewrite(PreMaterializedViewRewriter.needPreRewrite(cascadesContext));
    cascadesContext.getStatementContext().getPlannerHooks().forEach(hook -> hook.afterRewrite(cascadesContext));
}
```

`preMaterializedViewRewrite` 的核心逻辑——遍历 RBO 阶段记录的快照计划，尝试 MV 重写，再做规则优化：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/NereidsPlanner.java"
protected void preMaterializedViewRewrite() {
    if (!cascadesContext.getStatementContext().isNeedPreMvRewrite()) {
        return;
    }
    List<Plan> tmpPlansForMvRewrite = cascadesContext.getStatementContext().getTmpPlanForMvRewrite();
    List<Plan> plansWhichContainMv = new ArrayList<>();
    for (Plan planForRewrite : tmpPlansForMvRewrite) {
        // 只处理与最终RBO计划输出一致的快照
        if (!planForRewrite.getLogicalProperties().equals(
                cascadesContext.getRewritePlan().getLogicalProperties())) {
            continue;
        }
        // 1. 在独立Memo中尝试MV透明重写
        Plan rewrittenPlan = MaterializedViewUtils.rewriteByRules(cascadesContext,
                PreMaterializedViewRewriter::rewrite, planForRewrite, planForRewrite, true);
        // 2. 对重写后的计划再做规则优化
        Plan ruleOptimizedPlan = MaterializedViewUtils.rewriteByRules(cascadesContext,
                childOptContext -> {
                    Rewriter.getWholeTreeRewriterWithoutCostBasedJobs(childOptContext).execute();
                    return childOptContext.getRewritePlan();
                }, rewrittenPlan, planForRewrite, false);
        if (ruleOptimizedPlan != null) {
            plansWhichContainMv.add(ruleOptimizedPlan);
        }
    }
    // 3. 将含MV的候选计划注入CBO的初始Memo
    // ...
}
```

### PreMaterializedViewRewriter.rewrite：在独立 Memo 中做 CBO

`rewrite` 方法创建一个独立的 Cascades 优化上下文，在其中执行完整的 CBO（包括 MV 探索规则），然后选出最优物理计划，提取对应的逻辑计划：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/rules/exploration/mv/PreMaterializedViewRewriter.java"
public static Plan rewrite(CascadesContext cascadesContext) {
    if (cascadesContext.getMaterializationContexts().isEmpty()
            || !cascadesContext.getStatementContext().isNeedPreMvRewrite()) {
        return null;
    }
    // 在独立Memo中执行完整CBO优化
    new Optimizer(cascadesContext).execute();
    // 选最优物理计划
    Group root = cascadesContext.getMemo().getRoot();
    PhysicalPlan physicalPlan = NereidsPlanner.chooseBestPlan(root, ...);
    // 提取选中的MV对应的逻辑计划
    Pair<Map<List<String>, MaterializationContext>, BitSet> chosen = 
            MaterializedViewUtils.getChosenMaterializationAndUsedTable(physicalPlan, ...);
    StructInfo structInfo = root.getStructInfoMap().getStructInfo(cascadesContext, chosen.value(), root, null, true);
    if (structInfo != null && !chosen.key().isEmpty()) {
        return structInfo.getOriginalPlan();   // 返回含MV的逻辑计划
    }
    return null;
}
```

关键设计：预重写复用了 CBO 的 Cascades Memo 框架来做 MV 探索和代价选择，但结果只取**逻辑计划**（不取物理计划），这个逻辑计划会被注入到最终 CBO 的 Memo 中作为初始候选。

### RecordPlanForMvPreRewrite：RBO 中的快照记录

在 RBO 规则重写过程中，`RecordPlanForMvPreRewrite` 作为一个 custom rewriter，在合适时机记录计划快照：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/rules/rewrite/RecordPlanForMvPreRewrite.java"
public class RecordPlanForMvPreRewrite extends DefaultPlanRewriter<Void> implements CustomRewriter {
    @Override
    public Plan rewriteRoot(Plan plan, JobContext jobContext) {
        CascadesContext cascadesContext = jobContext.getCascadesContext();
        if (!PreMaterializedViewRewriter.needRecordTmpPlanForRewrite(cascadesContext)) {
            return plan;
        }
        Plan finalPlan = MaterializedViewUtils.rewriteByRules(cascadesContext, ...);
        statementContext.addTmpPlanForMvRewrite(finalPlan);  // 记录快照
        return plan;  // 不改变当前计划
    }
}
```

这个 rewriter 注册在 `Rewriter` 的 RBO 规则链中，位于 `AddDefaultLimit` 之后、CTE 重写之前：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/jobs/executor/Rewriter.java"
topic("record query tmp plan for mv pre rewrite",
        custom(RuleType.RECORD_PLAN_FOR_MV_PRE_REWRITE, RecordPlanForMvPreRewrite::new)
),
```

### needPreRewrite：决定是否执行预重写

`PreMaterializedViewRewriter.needPreRewrite` 在 RBO 完成后判断是否值得做预重写，检查五个条件：

1. `needRecordTmpPlanForRewrite` 为 true（有候选 MV 且策略非 `NOT_IN_RBO`）
2. 快照计划列表非空
3. 存在 MV 相关的 hook
4. RBO 最终计划的输出与某个快照计划的逻辑属性一致（说明计划结构未被后续规则改变）
5. 应用的规则集合与 `NEED_PRE_REWRITE_RULE_TYPES` 有交集，或策略为 `FORCE_IN_RBO`

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/rules/exploration/mv/PreMaterializedViewRewriter.java"
public static boolean needPreRewrite(CascadesContext cascadesContext) {
    // ... 前置检查 ...
    // 检查RBO应用的规则是否命中NEED_PRE_REWRITE_RULE_TYPES
    // needPreMvRewriteRuleMasks 在 StatementContext 中记录 RBO 阶段命中的规则
    BitSet appliedRules = statementContext.getNeedPreMvRewriteRuleMasks();
    BitSet needPreRewriteRuleSet = (BitSet) getNeedPreRewriteRule().clone();
    needPreRewriteRuleSet.and(appliedRules);
    boolean shouldPreRewrite = !needPreRewriteRuleSet.isEmpty()
            || PreRewriteStrategy.FORCE_IN_RBO.equals(preRewriteStrategy);
    return shouldPreRewrite;
}
```

> 条件 4 是精妙之处：只有当 RBO 最终结果与某个快照的**逻辑属性一致**时，才说明这个快照仍然有效（后续规则没有改变计划结构），预重写才有意义。

### Optimizer 重构：DpHyp 判断外提

`Optimizer.execute` 中原本内联的 DpHyp 判断逻辑被提取为静态方法 `isDpHyp(CascadesContext)`，供预重写复用：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/jobs/executor/Optimizer.java"
public static boolean isDpHyp(CascadesContext cascadesContext) {
    // 计算 maxTableCount、maxJoinCount，判断是否用 DPHyp
    boolean isDpHyp = sessionVariable.enableDPHypOptimizer || maxJoinCount > maxTableCount;
    cascadesContext.getStatementContext().setDpHyp(isDpHyp);
    return isDpHyp;
}
```

预重写时如果在 `StatementContext` 中已设置 `isDpHyp`，则直接复用，避免重复遍历计划。Review 中 924060929 建议移除冗余调用，作者解释这是性能优化——预重写阶段已设置 `isDpHyp`，后续可直接取。

---

## 测试

### 单元测试

新增 `PreMaterializedViewRewriterTest.java`（+3028 行），是本 PR 最大的测试文件，覆盖预重写的各种场景：

| 测试维度 | 覆盖内容 |
| --- | --- |
| join 条件消除 | `EliminateConstHashJoinCondition` 改变计划后 MV 重写是否生效 |
| limit 下推 | `PUSH_LIMIT_THROUGH_JOIN` 等规则后 MV 重写 |
| 三种策略 | `FORCE_IN_RBO` / `TRY_IN_RBO` / `NOT_IN_RBO` 的行为差异 |
| DpHyp 场景 | DpHyp 优化器下预重写的限制（不支持多 GroupExpression） |
| 无候选 MV | 无可用 MV 时不触发预重写 |

测试基础设施也有大量增强：`SqlTestBase`（+732 行）、`PlanChecker`（+100 行）、`MemoTestUtils`、`MatchingUtils` 等测试工具类。

### 回归测试

新增回归测试数据和套件：

| 路径 | 场景 |
| --- | --- |
| `regression-test/data/nereids_rules_p0/mv/pre_rewrite/limit/` | limit 场景下的预重写 |
| `regression-test/data/nereids_rules_p0/mv/pre_rewrite/strategy/` | 策略切换 |
| `regression-test/data/nereids_syntax_p0/mv/where/k123/` | where 条件场景 |

此外大量现有 MV 回归测试套件（`mv_p0/` 下 40+ 个 groovy 文件）统一适配了新的预重写机制。

### 性能测试

CI bot 自动跑了 TPC-H (sf100)、TPC-DS (sf100)、ClickBench，结果在 issue 评论中展示，确认无性能回退。

---

## Review

**924060929** 提出了 8 条代码质量意见，全部是改进建议：

1. 用 `MergeProjectable` 替代 `MergeProjects`（更好的抽象）
2. `synv` 是 typo（应为 `sync`）
3. 多处 rename 建议（`xxxPreRewritxxxMv` → 更清晰的名字，`isNeedRewriteMv`）
4. `Memo.java` 中有不可达分支（line 223 已存在），应移除
5. 用 `exprIdGenerator` 生成 exprId 而非手动构造
6. 用 `!Collections.disjoint(...)` 替代手动交集判断
7. `colum` → `column` typo
8. 日志加 `if (LOG.isDebugEnabled())` 保护

作者逐条采纳（"have fixed"）。

**zddr** 质疑 `MTMV.java:199` 中使用 `ConnectContext.get()` 的安全性——物化视图定义构建时 `ConnectContext` 由 `MTMVPlanUtil.createMTMVContext` 创建，直接使用线程局部变量可能有风险。作者解释：此处正是确保 `MTMVPlanUtil.createMTMVContext(this)` 不会改变当前线程的 `ConnectContext`。

**seawinde**（作者本人）在几处回复中补充了设计意图：DpHyp 判断的性能考量、rbo/tbo 术语纠正等。

---

## 问题

### 预重写为何不直接修改计划

`RecordPlanForMvPreRewrite` 记录快照后返回**原始计划**（`return plan`），不改变 RBO 的执行路径。这是为了不干扰 RBO 的正常流程——预重写是"旁路"尝试，只在 RBO 完成后统一判断是否采用。如果预重写失败，RBO 结果不受影响，回退到 CBO 阶段的旧 MV 重写机制。

### DpHyp 下的限制

DpHyp 优化器要求每个 Group 初始时只有一个 GroupExpression。预重写会向 Memo 注入多个候选计划（含 MV 的逻辑计划），与 DpHyp 的约束冲突。因此 `needPreRewrite` 中显式排除了 DpHyp 场景：

```java
if (Optimizer.isDpHyp(cascadesContext)) {
    return false;  // DpHyp 不支持预重写
}
```

### 逻辑属性一致性检查

预重写前会比较快照计划与 RBO 最终计划的 `LogicalProperties`。只有输出属性一致，才说明快照仍然有效——后续 RBO 规则没有改变计划的输出结构。这是一个保守的过滤：如果不一致，说明计划结构已变化，预重写基于的快照不再适用。

---

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| join 条件消除后 MV 重写 | ✗ 失败 | ✓ 成功（TRY_IN_RBO） |
| limit 下推后 MV 重写 | ✗ 失败 | ✓ 成功 |
| 常量传播后 MV 重写 | ✗ 可能失败 | ✓ 成功 |
| DpHyp 优化器 | CBO 阶段重写 | 不预重写（回退 CBO） |
| 无 MV 的查询 | 无影响 | 无影响（前置检查跳过） |

* **核心价值**：解决了 RBO 规则改写导致 MV 透明重写失败的根本问题。此前一旦查询计划被 RBO 规则（消除 join 条件、下推 limit 等）改变结构，CBO 阶段的 MV 匹配就会失败，物化视图形同虚设。预重写机制在 RBO 规则生效前就完成 MV 路由，使 MV 透明重写对后续优化规则"免疫"。
* **框架级复用**：预重写复用 Cascades Memo 框架做 MV 探索和代价选择，而非另起一套匹配逻辑。重写结果作为逻辑计划注入最终 CBO 的 Memo，与正常优化流程无缝衔接。
* **渐进式策略**：三种策略（`FORCE` / `TRY` / `NOT`）让用户按需选择，默认 `TRY_IN_RBO` 平衡了正确性和性能。`NOT_IN_RBO` 保留回退路径，降低升级风险。
* **影响范围**：8999 行变更覆盖 250 文件，不仅是核心优化器改动，还涉及大量测试基础设施增强和现有 MV 回归测试适配，是 Doris 4.0 物化视图体系的重大架构改进。
