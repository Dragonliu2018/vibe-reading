---
title: "按 table id 升序加锁：Doris 用全序关系根治 Nereids 规划期的表锁死锁"
source:
  project: "Doris"
  type: "PR"
  id: "45045"
  url: "https://github.com/apache/doris/pull/45045"
  prType: "enhancement"
date: "2026-07-30T14:20:00+08:00"
category: [Database, OLAP, Apache Doris, PRs]
tags: ["Apache Doris", "Nereids", "FE", "表锁", "死锁", "公平读写锁", "Cascades", "MTMV"]
description: "Doris 把 Nereids 规划期散落在各处的表读锁收口到 StatementContext.lock()，按 table id 升序统一加锁，根治多线程以不同顺序获取读锁与第三线程写锁竞争造成的公平锁死锁；Insert 路径改为分阶段加锁 + schema 变更重试。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> 📎 本文与 [用 volatile 快照打破表统计读锁的死锁](/vibe-reading/articles/doris-pr-39807-reduce-lock-table-statistics) 是同一主题的两条落地线：#39807 用「去锁」（volatile 快照）消除 TabletStatMgr 的跨表读锁死锁，本文用「排序加锁」消除 Nereids 规划期的表锁死锁。两者面对的都是 Doris 公平读写锁在不同加锁顺序下的死锁，建议对照阅读。

> **PR** [#45045](https://github.com/apache/doris/pull/45045) · **Issue** - · **commit** [24328d1cc24](https://github.com/apache/doris/commit/24328d1cc2401b62a62f4d89c944a03866e4a252) · **首发版本** 2.1.8 / 3.0.4 · **变更行数** +1083 行 · **合并时间** 2024-12-19

---

## 背景

Doris 的表锁是**公平读写锁**（`MonitoredReentrantReadWriteLock` 继承自 JDK 的 `ReentrantReadWriteLock`，构造为 fair 模式）。公平锁保证了写锁不会饥饿，但也引入了一个经典的死锁陷阱：**多个线程若以不同顺序获取多张表的读锁，再与一个试图获取写锁的线程相遇，读锁之间就会互相阻塞形成死锁。**

PR 描述里把问题定性得很清楚：

> Doris's table locks are fair read-write locks. If two threads acquire read locks on tables in different orders and simultaneously a third thread attempts to acquire a write lock on one of these tables, a deadlock can form between the two threads trying to acquire read locks.

具体场景：线程 T1 先锁表 A 再锁表 B，线程 T2 先锁表 B 再锁表 A。与此同时，T3 请求 A 的写锁、T4 请求 B 的写锁——在 Doris 里这对应并发发生在不同表上的 DDL / schema change。因为公平锁（`FairSync.readerShouldBlock()` 返回 `hasQueuedPredecessors()`），写锁一旦排队就会阻塞后续读锁：T1 拿到 A 的读锁后请求 B 时被 T4 挡住（B 的等待队列非空），T2 拿到 B 的读锁后请求 A 时被 T3 挡住（A 的等待队列非空）；而 T3 等 T1 释放 A、T4 等 T2 释放 B——T1 → T4 → T2 → T3 → T1 形成四节点循环等待，死锁。

> **为什么必须有两个写者？** 只有一个写者（比如只有 T3 写 A）时，T1 请求 RL(B) 不被阻塞——B 的等待队列空，`hasQueuedPredecessors()` 返回 false，T1 立即拿到 B、完成、释放 A，环断开。单写者只能堵住环的一侧。PR 描述里「a third thread … a write lock on one of these tables」是简化措辞，真实环境里 A、B 各有一个写者排队才是死锁成立的充要条件。Doris 的 `tryReadLock` 走 `tryLock(1, MINUTES)`（定时版，尊重公平队列；而非无参 `tryLock()` 的插队语义），所以这个死锁的表象是 1 分钟超时后抛 `Failed to get read lock on table`，而非永久挂起。

**根因不在于锁本身，而在于「加锁顺序不一致」**。只要所有线程都以同一个全局全序获取锁，循环等待的边就不可能形成，死锁被预防——这是互斥锁死锁的经典解法，与锁是否公平无关。

> **关于「资源等待环」与死锁判定的精确表述。** 等待图中出现环是死锁的**必要条件**（Coffman 四条件之「循环等待」），但环是否**充分**取决于资源实例数：
> - **单实例资源**：环 ⟺ 死锁，充要。
> - **多实例资源**：环只是必要、不充分——环外进程可能释放一个资源实例把环解开，有环未必死锁。
>
> 本场景每张表只有一把 RW 锁（单实例），且互斥、持有并等待、不可抢占三条件皆满足，故环的出现即死锁。下文图②的「单实例资源下死锁的充要条件」即就此而言。另需注意：RW 锁 + 公平队列下，等待图的边是「队列顺序边」（T1 等排在它前面的写者 T4，而非直接等持有 B 的 T2），比标准 mutex 等待图多一层间接，但每条边都对应真实阻塞，结论不变。

<details class="viz-details">
  <summary>📊 展开图解：四节点死锁的形成时序、资源等待环与全序加锁解法</summary>
  <figure class="viz-iframe">
    <iframe src="/vibe-reading/images/articles/doris-pr-45045-lock-table-by-id-order/deadlock-case.html"
            loading="lazy" title="Doris 表锁死锁案例可视化"
            sandbox="allow-same-origin"></iframe>
    <figcaption>四节点死锁的形成时序、资源等待环，以及按 table id 升序加锁如何切断环。</figcaption>
  </figure>
</details>

这个 PR 的解法直接而彻底：**把查询规划期的所有表读锁收口到一处，按 table id 升序统一加锁**。

---

## 前置知识

### 公平读写锁为什么会因「顺序不一致」死锁

`ReentrantReadWriteLock` 的 fair 模式近似 FIFO：请求锁的线程按到达顺序排队，写锁会阻塞后续的读锁请求（避免写饥饿）。这本来是优点，但代价是：**读锁不再是无障碍的**——一旦有写锁排队，新来的读锁必须等写锁走完。

于是「多把读锁」就退化成了「多把互斥锁」的经典死锁模型。互斥锁的教科书解法就是**对所有锁规定一个全局获取顺序**，所有线程都遵守这个顺序，循环等待就不会形成。Doris 这里选择的全序就是 **table id**（表在元数据里的唯一自增 id），因为它是稳定、全局可比、且每张表都有的。

### 旧版 Nereids 是怎么加锁的

旧版加锁逻辑散落在两条路径上，且**没有顺序保证**：

1. **规划主路径**：`NereidsPlanner.planWithLock` 里用一个 `try (Lock lock = new Lock(plan, cascadesContext))` 包住整个规划。`CascadesContext.Lock` 在构造时调用 `extractTables(plan)` 从计划树里抓出所有 `UnboundRelation` / `UnboundTableSink`，然后遍历 `cascadesContext.tables.values()` 逐个 `tryReadLock`。`HashMap` 的迭代顺序是无序的，所以加锁顺序不确定。
2. **权限/缓存路径**：`NereidsSqlCacheManager.privilegeChanged` 在检查每张表权限时调用 `statementContext.addTableReadLock(tableIf)`，谁先检查谁先加锁，顺序同样不可控。
3. **约束相关方法**：`TableIf` 的 `getConstraintsMap` / `addUniqueConstraint` / `dropConstraint` 等方法内部各自 `readLock()` / `writeLock()`，规划过程中随时可能触发，进一步打乱加锁顺序。

这些散点叠加起来，不同查询、不同线程的加锁顺序几乎是随机的，死锁在并发下必然出现。

---

## 实现

改造的核心思路是三步：**先收集、再排序、最后统一加锁**，并把所有散落的加锁点全部删除。

### 1. 加锁收口：`StatementContext.lock()` 按 table id 升序

新增的 `StatementContext.lock()` 是唯一的加锁入口。它把查询涉及的全部表（分三类，见下文）倒进一个以 `TableIf::getId` 为比较器的 `PriorityQueue`，再依次 `tryReadLock`：

```java title="StatementContext.java"
/**
 * lock all table collect by TableCollector
 */
public synchronized void lock() {
    if (!needLockTables
            || (tables.isEmpty() && mtmvRelatedTables.isEmpty() && insertTargetTables.isEmpty())
            || !plannerResources.isEmpty()) {
        return;
    }
    PriorityQueue<TableIf> tableIfs = new PriorityQueue<>(
            tables.size() + mtmvRelatedTables.size() + insertTargetTables.size(),
            Comparator.comparing(TableIf::getId));
    tableIfs.addAll(tables.values());
    tableIfs.addAll(mtmvRelatedTables.values());
    tableIfs.addAll(insertTargetTables.values());
    while (!tableIfs.isEmpty()) {
        TableIf tableIf = tableIfs.poll();
        if (!tableIf.needReadLockWhenPlan()) {
            continue;
        }
        if (!tableIf.tryReadLock(1, TimeUnit.MINUTES)) {
            close();
            throw new RuntimeException("Failed to get read lock on table:" + tableIf.getName());
        }
        String fullTableName = tableIf.getNameWithFullQualifiers();
        String resourceName = "tableReadLock(" + fullTableName + ")";
        plannerResources.push(new CloseableResource(
                resourceName, Thread.currentThread().getName(),
                originStatement == null ? null : originStatement.originStmt, tableIf::readUnlock));
    }
}
```

几个关键点：

- **`PriorityQueue` + `Comparator.comparing(TableIf::getId)`**：这是「全序」的落地。无论三类表以什么顺序塞进去，poll 出来的一定是 id 升序。
- **三类表合并排序**：查询表、MTMV 相关表、Insert 目标表一起进同一个堆，保证跨类别也是 id 升序。
- **`plannerResources.push(...)`**：加锁成功后把 `readUnlock` 注册为一个 `CloseableResource`，由 `StatementContext.close()` 在语句结束时统一释放，无需手动 unlock。
- **幂等保护**：`!plannerResources.isEmpty()` 时直接返回，避免重复加锁（SqlCache 路径与规划路径可能都进入这里）。

旧的 `addTableReadLock(TableIf)` 单表加锁方法被整体删除，调用方全部改走 `lock()`。

### 2. 表来源分类：`TableFrom` 枚举

PR 把查询里的表按来源分成三类，分别存在 `StatementContext` 的三个独立 Map 里：

```java title="StatementContext.java"
/**
 * indicate where the table come from.
 * QUERY: in query sql directly
 * INSERT_TARGET: the insert target table
 * MTMV: mtmv itself and its related tables witch do not belong to this sql,
 *       but maybe used in rewrite by mtmv.
 */
public enum TableFrom {
    QUERY,
    INSERT_TARGET,
    MTMV
}

// tables in this query directly
private final Map<List<String>, TableIf> tables = Maps.newHashMap();
// tables maybe used by mtmv rewritten in this query
private final Map<List<String>, TableIf> mtmvRelatedTables = Maps.newHashMap();
// insert into target tables
private final Map<List<String>, TableIf> insertTargetTables = Maps.newHashMap();
```

为什么要分类？因为这三类表的「发现时机」和「用途」不同：

| 来源 | 发现时机 | 作用 |
| --- | --- | --- |
| `QUERY` | 解析 SQL 中的 `UnboundRelation` | 查询直接读取的表 |
| `INSERT_TARGET` | 解析 `UnboundTableSink` | `INSERT INTO` 的目标表，规划期也要加锁防 schema 变更 |
| `MTMV` | 查询表关联的物化视图及其基表 | 物化视图改写时可能用到，需提前锁定 |

> **MTMV 是什么？** MTMV（Materialized Table Materialized View）即 Doris 的**物化视图**，源码里物化视图表实体类为 `org.apache.doris.catalog.MTMV`，相关类（`MTMVCache`、`MTMVRelationManager`、`MTMVRewriteUtil` 等）均以 `MTMV` 为前缀。物化视图的本质是把一张查询的结果预先存成表；Nereids 在规划后期会尝试**物化视图改写**——若发现某物化视图的基表正是查询要读的表，就改写计划去读物化视图（更快）而非扫原始基表。它的特殊之处在于：改写决策发生在规划后期，但物化视图本身及其基表都需要在规划期加锁，所以必须提前收集——这正是把 `MTMV` 单列一类的由来，详见下文 `collectMTMVCandidates`。

统一的入口是 `getAndCacheTable`，它同时承担「按名查表 + 缓存」的职责，替换了原来散落在 `BindRelation` 里的查表逻辑：

```java title="StatementContext.java"
public TableIf getAndCacheTable(List<String> tableQualifier, TableFrom tableFrom) {
    Map<List<String>, TableIf> tables;
    switch (tableFrom) {
        case QUERY:        tables = this.tables;           break;
        case INSERT_TARGET: tables = this.insertTargetTables; break;
        case MTMV:         tables = this.mtmvRelatedTables;  break;
        default: throw new AnalysisException("Unknown table from " + tableFrom);
    }
    return tables.computeIfAbsent(tableQualifier,
            k -> RelationUtil.getTable(k, connectContext.getEnv()));
}
```

`computeIfAbsent` 保证了「同一张表只查一次 catalog、只缓存一份」，避免多次查表拿到不同的 `TableIf` 实例（id 一致但不是同一对象，对 `PriorityQueue` 排序无影响，但缓存能省掉重复 catalog 查询）。

### 3. 表收集器：`TableCollector` + `CollectRelation`

旧版用 `CascadesContext.extractTables` 在加锁前**一次性从计划树抓表**，但它只看 `UnboundRelation` / `UnboundTableSink`，对 CTE、子查询、View、MTMV 的处理是残缺的（要靠一堆 `extractTableNamesFromFilter/Project/Having/CTE` 的 ad-hoc 方法补丁）。PR 把这套全删了，改成**走一遍正规的 rewrite job 流程来收集表**。

新增 `TableCollector`（注意：与旧版被删除的 `trees/plans/visitor/TableCollector` 同名但完全不同，旧的是 PlanVisitor，新的是 `AbstractBatchJobExecutor`）：

```java title="TableCollector.java"
public class TableCollector extends AbstractBatchJobExecutor {
    public static final List<RewriteJob> COLLECT_JOBS = buildCollectTableJobs();

    public TableCollector(CascadesContext cascadesContext) {
        super(cascadesContext);
    }

    @Override
    public List<RewriteJob> getJobs() {
        return COLLECT_JOBS;
    }

    public void collect() {
        execute();
    }

    private static List<RewriteJob> buildCollectTableJobs() {
        return notTraverseChildrenOf(
                ImmutableSet.of(LogicalView.class),
                TableCollector::buildCollectorJobs
        );
    }

    private static List<RewriteJob> buildCollectorJobs() {
        return jobs(topDown(new CollectRelation()));
    }
}
```

核心规则是 `CollectRelation`，它注册了四条 rule，覆盖了所有表出现的位置：

```java title="CollectRelation.java"
@Override
public List<Rule> buildRules() {
    return ImmutableList.of(
            // 先收集 CTE，避免把 CTE 名误当成表名
            logicalCTE()
                    .thenApply(ctx -> {
                        ctx.cascadesContext.setCteContext(collectFromCte(ctx.root, ctx.cascadesContext));
                        return null;
                    }).toRule(RuleType.COLLECT_TABLE_FROM_CTE),
            unboundRelation()
                    .thenApply(this::collectFromUnboundRelation)
                    .toRule(RuleType.COLLECT_TABLE_FROM_RELATION),
            unboundTableSink()
                    .thenApply(this::collectFromUnboundTableSink)
                    .toRule(RuleType.COLLECT_TABLE_FROM_SINK),
            any().whenNot(UnboundRelation.class::isInstance)
                    .whenNot(UnboundTableSink.class::isInstance)
                    .thenApply(this::collectFromAny)
                    .toRule(RuleType.COLLECT_TABLE_FROM_OTHER)
    );
}
```

每条 rule 的职责：

- **`COLLECT_TABLE_FROM_CTE`**：先递归收集 CTE 定义里的表。CTE 名会被当成 `UnboundRelation`，必须先注册 CTE，否则 `collectFromUnboundRelation` 会把 CTE 名当物理表去 catalog 查。
- **`COLLECT_TABLE_FROM_RELATION`**：处理 `UnboundRelation`，若不是 CTE 则 `getAndCacheTable(..., TableFrom.QUERY)`，并触发 MTMV 候选收集；若是 `View` 则递归解析 view 定义继续收集。
- **`COLLECT_TABLE_FROM_SINK`**：处理 `UnboundTableSink`，作为 `INSERT_TARGET` 收集。
- **`COLLECT_TABLE_FROM_OTHER`**：处理任意节点表达式里的子查询（`SubqueryExpr`），为每个子查询开新的 `CascadesContext` 递归收集。

`notTraverseChildrenOf(LogicalView.class)` 是关键：**View 的内部表由 `CollectRelation` 自己递归收集，不让框架自动下钻**，避免重复。

### 4. MTMV 候选表预收集

物化视图改写是 Nereids 规划后期才发生的事，但物化视图本身及其基表也需要在规划期加锁。PR 在收集表阶段就提前把候选 MTMV 及其基表收进来：

```java title="CollectRelation.java"
private void collectMTMVCandidates(TableIf table, CascadesContext cascadesContext) {
    if (cascadesContext.getConnectContext().getSessionVariable().enableMaterializedViewRewrite) {
        Set<MTMV> mtmvSet = Env.getCurrentEnv().getMtmvService().getRelationManager()
                .getAllMTMVs(Lists.newArrayList(new BaseTableInfo(table)));
        for (MTMV mtmv : mtmvSet) {
            cascadesContext.getStatementContext().getMtmvRelatedTables()
                    .put(mtmv.getFullQualifiers(), mtmv);
            mtmv.readMvLock();
            try {
                for (BaseTableInfo baseTableInfo : mtmv.getRelation().getBaseTables()) {
                    cascadesContext.getStatementContext()
                            .getAndCacheTable(baseTableInfo.toList(), TableFrom.MTMV);
                }
            } finally {
                mtmv.readMvUnlock();
            }
        }
    }
}
```

这里 `mtmv.readMvLock()` 是 MTMV 自带的锁（与表读锁不同），用来稳定地读取 MTMV 的关联基表列表；基表本身则作为 `TableFrom.MTMV` 存入 `mtmvRelatedTables`，最终和其他表一起进 `PriorityQueue` 按 id 排序加锁。

### 5. View 定义缓存：`getAndCacheViewInfo`

View 有个微妙问题：**在收集表之后、真正 analyze view 之前，view 的定义（`inlineViewDef`）和 `sqlMode` 可能被另一个 DDL 改掉**。如果在加锁后才读 view 定义，规划中途定义变了会导致计划不一致。PR 在收集阶段就「读一次、缓存住」：

```java title="StatementContext.java"
public Pair<String, Long> getAndCacheViewInfo(List<String> qualifiedViewName, View view) {
    return viewInfos.computeIfAbsent(qualifiedViewName, k -> {
        String viewDef;
        long sqlMode;
        view.readLock();
        try {
            viewDef = view.getInlineViewDef();
            sqlMode = view.getSqlMode();
        } finally {
            view.readUnlock();
        }
        return Pair.of(viewDef, sqlMode);
    });
}
```

后续 `BindRelation.parseAndAnalyzeDorisView` 和 `CollectRelation.parseAndCollectFromView` 都从缓存取定义，并临时切换 `sqlMode` 解析 view SQL，保证规划期内 view 定义稳定。

### 6. 规划主流程重构：`collectAndLockTable` 拆阶段

`NereidsPlanner.planWithLock` 的结构被重新编排。旧版是「extractTables → Lock 包住整个 plan」；新版拆成清晰的三个阶段：

```java title="NereidsPlanner.java"
plan = preprocess(plan);
initCascadesContext(plan, requireProperties);
// collect table and lock them in the order of table id
collectAndLockTable(showAnalyzeProcess(explainLevel, showPlanProcess));
// after table collector, we should use a new context.
statementContext.loadSnapshots();
Plan resultPlan = planWithoutLock(plan, requireProperties, explainLevel, showPlanProcess);
```

`collectAndLockTable` 做的事：

```java title="NereidsPlanner.java"
protected void collectAndLockTable(boolean showPlanProcess) {
    if (LOG.isDebugEnabled()) {
        LOG.debug("Start collect and lock table");
    }
    keepOrShowPlanProcess(showPlanProcess, () -> cascadesContext.newTableCollector().collect());
    statementContext.lock();
    cascadesContext.setCteContext(new CTEContext());
    NereidsTracer.logImportantTime("EndCollectAndLockTables");
    if (LOG.isDebugEnabled()) {
        LOG.debug("End collect and lock table");
    }
    if (statementContext.getConnectContext().getExecutor() != null) {
        statementContext.getConnectContext().getExecutor().getSummaryProfile()
                .setNereidsLockTableFinishTime();
    }
}
```

注意 `cascadesContext.setCteContext(new CTEContext())` —— 收集阶段用过的 CTE 上下文在加锁后被重置，因为后续 `Analyzer` 会重新正规地分析 CTE，收集阶段只是为了拿表名。注释 `// after table collector, we should use a new context.` 说的就是这件事。

旧的 `CascadesContext.Lock` 类、`extractTables` / `getOrExtractTables` / `getTables` 及一堆 `extractTableNamesFromXxx` 方法（约 200 行）被整体删除，`planWithoutLock` 也不再带 `Lock` 包裹。

### 7. Insert 路径：分阶段加锁 + schema 变更重试

Insert 是最复杂的部分。旧版 `InsertIntoTableCommand.initPlan` 在 `targetTableIf.readLock()` 包住整个规划 + 开事务。但新版主路径已经把表锁收口到 `StatementContext.lock()`，且锁是按 id 升序拿的——如果 Insert 还自己先拿目标表锁再走规划，就破坏了「全序」约定（目标表锁可能先于其他表锁拿到）。

于是 Insert 改成**分阶段加锁 + 重试**：

```java title="InsertIntoTableCommand.java"
int retryTimes = 0;
while (++retryTimes < Math.max(ctx.getSessionVariable().dmlPlanRetryTimes, 3)) {
    TableIf targetTableIf = RelationUtil.getTable(qualifiedTargetTableName, ctx.getEnv());
    // check auth ...
    BuildInsertExecutorResult buildResult;
    try {
        buildResult = initPlanOnce(ctx, stmtExecutor, targetTableIf);
    } catch (Throwable e) {
        Throwables.throwIfInstanceOf(e, RuntimeException.class);
        throw new IllegalStateException(e.getMessage(), e);
    }
    insertExecutor = buildResult.executor;
    if (!needBeginTransaction) {
        return insertExecutor;
    }

    // lock after plan and check does table's schema changed to ensure we lock table order by id.
    TableIf newestTargetTableIf = RelationUtil.getTable(qualifiedTargetTableName, ctx.getEnv());
    newestTargetTableIf.readLock();
    try {
        if (targetTableIf.getId() != newestTargetTableIf.getId()) {
            // 表被重建，id 变了，重试
            continue;
        }
        if (!targetTableIf.getFullSchema().equals(newestTargetTableIf.getFullSchema())) {
            // 规划期间 schema 被改了，重试
            continue;
        }
        if (!insertExecutor.isEmptyInsert()) {
            insertExecutor.beginTransaction();
            insertExecutor.finalizeSink(...);
        }
        newestTargetTableIf.readUnlock();
    } catch (Throwable e) {
        newestTargetTableIf.readUnlock();
        if (insertExecutor != null) {
            insertExecutor.onFail(e);
        }
        Throwables.throwIfInstanceOf(e, RuntimeException.class);
        throw new IllegalStateException(e.getMessage(), e);
    }
    ...
    return insertExecutor;
}
throw new AnalysisException("Insert plan failed. Could not get target table lock.");
```

逻辑拆解：

1. **`initPlanOnce`**：在「不加目标表锁」的前提下做一次完整规划（规划内部其他表仍由 `StatementContext.lock()` 按 id 升序加锁）。`initPlanOnce` 内部仍会对目标表 `readLock` 一小段，仅用于 normalize plan，完成后立即释放。
2. **规划完成后**重新拿一次最新目标表 `newestTargetTableIf`，`readLock`，然后校验：
   - **id 是否变了**：表可能在规划期间被 drop + 重建（id 会变），变了就 `continue` 重试。
   - **schema 是否变了**：规划用的是规划开始时的 schema 快照，如果中途发生 schema change，schema 不匹配就 `continue` 重试。
3. schema 一致才 `beginTransaction` 并 `finalizeSink`。
4. 重试次数由新 session 变量 `dml_plan_retry_times`（默认 3）控制：

```java title="SessionVariable.java"
@VariableMgr.VarAttr(name = DML_PLAN_RETRY_TIMES, needForward = true, description = {
        "写入规划的最大重试次数。为了避免死锁，写入规划时采用了分阶段加锁。当在两次加锁中间，表结构发生变更时，会尝试重新规划。"
                + "此变量限制重新规划的最大尝试次数。",
        "Maximum retry attempts for write planning. To avoid deadlocks, "
                + "phased locking is adopted during write planning. ..."
})
public int dmlPlanRetryTimes = 3;
```

这个「分阶段加锁」是必要的代价：为了维持全序，目标表锁不能在规划前就拿着，只能在规划后单独拿；但规划用的 schema 可能已经过期，所以必须用「校验 + 重试」来兜底。`originalLogicalQuery` 字段就是为重试时能从原始计划重新规划而保留的。

### 8. 非 Nereids 路径的同步：`StmtExecutor`

老优化器路径（`StmtExecutor` 里处理 `tableMap` 的地方）也补上了排序，保持全局一致：

```java title="StmtExecutor.java"
List<TableIf> tables = Lists.newArrayList(tableMap.values());
tables.sort((Comparator.comparing(TableIf::getId)));
```

还有一处 insert retry 路径同样补了 `tables.sort(Comparator.comparing(TableIf::getId))` 后再 `MetaLockUtils.readLockTables(tables)`。这保证即便不走 Nereids，加锁顺序也按 id 升序。

### 9. SqlCache 路径：`tryLockTables`

SQL Cache 命中后需要重新校验权限，旧版在 `privilegeChanged` 里逐表 `addTableReadLock`。新版抽出独立的 `tryLockTables`，把缓存里记录的 `usedTables` / `usedViews` 先 `getAndCacheTable` 填进 `StatementContext`，再统一调 `statementContext.lock()`：

```java title="NereidsSqlCacheManager.java"
if (!tryLockTables(connectContext, env, sqlCacheContext)) {
    return invalidateCache(key);
}
// check table and view and their columns authority
if (privilegeChanged(connectContext, env, sqlCacheContext)) {
    return invalidateCache(key);
}
```

`privilegeChanged` 里的 `addTableReadLock` 调用被删除，权限检查不再单独加锁（锁已由 `tryLockTables` 统一持有）。

### 10. 约束方法的散锁清理

`TableIf` 里所有约束相关方法（`getConstraintsMap` / `addUniqueConstraint` / `addPrimaryKeyConstraint` / `addForeignConstraint` / `dropConstraint` / `dropFKReferringPK`）内部的 `readLock()` / `writeLock()` 全部删除。这些方法的调用方（`AddConstraintCommand` / `DropConstraintCommand` / `ShowConstraintsCommand`）改为在更外层统一加锁，避免在规划期因约束查询触发零散的表锁，干扰全序。

### 11. 死锁诊断：`MonitoredReentrantReadWriteLock` 加警告

为了帮助发现「持有读锁时又去拿写锁」这类锁升级（同样是死锁高发场景），`MonitoredReentrantReadWriteLock.WriteLock.lock()` 在 fair 模式下加了警告：

```java title="MonitoredReentrantReadWriteLock.java"
public void lock() {
    super.lock();
    monitor.afterLock();
    if (isFair() && getReadHoldCount() > 0) {
        LOG.warn(" read lock count is {}, write lock count is {}, stack is {}, query id is {}",
                getReadHoldCount(), getWriteHoldCount(), Thread.currentThread().getStackTrace(),
                ConnectContext.get() == null ? "" : DebugUtil.printId(ConnectContext.get().queryId()));
        }
}
```

注意 `getReadHoldCount() > 0` 判断的是**当前线程**持有的读锁数——如果当前线程还持着读锁又请求写锁，`ReentrantReadWriteLock` 本身会直接死锁（同一线程持有读锁时无法升级为写锁），这里打 warn 是为了在日志里留下现场便于排查。

---

## 测试

### 单元测试

- **`ReadLockTest.java`**：调整为新加锁流程，验证 `StatementContext.lock()` 行为。
- **`BindRelationTest.java`**：删掉了大量基于旧 `CustomTableResolver` 的用例（`-70` 行），因为 `BindRelation` 不再接受 `CustomTableResolver` 参数，表解析统一走 `getAndCacheTable`。
- **`PlanVisitorTest.java`**：删除 163 行——这些是给旧版 `visitor.TableCollector` 用的测试，旧类已删，测试随之移除。
- **`PlanChecker.java`**：适配新的 `plan()` 方法命名（`planWithLock(StatementBase)` 改名为 `plan`）。

### 回归测试

- **`OlapQueryCacheTest.java`**：适配 SqlCache 路径的 `tryLockTables` 改动，确保缓存命中后的加锁 + 权限校验顺序正确。

---

## 问题

### Insert 分阶段加锁引入的 schema 一致性窗口

Insert 改成分阶段加锁后，规划与开事务之间出现了一个「无目标表锁」的窗口。在这个窗口内若发生 schema change，规划用的 schema 与实际 schema 不一致，会导致写入错误列。PR 用「重新查表 + schema 比对 + 重试」兜底，但这只是检测，不是预防——重试次数耗尽仍会抛 `Insert plan failed. Could not get target table lock.`。这个窗口后来成为几个后续 PR 的修复对象（见 TODO）。

### `CustomTableResolver` 的移除

旧版 `BindRelation` 接受一个可选的 `CustomTableResolver`（用于外部 catalog 自定义表解析）。PR 把它彻底移除，统一走 `RelationUtil.getTable` + `getAndCacheTable`。这是一个行为收敛：所有表解析都走同一条路径、进同一个缓存，否则不同路径拿到的 `TableIf` 可能不一致，破坏排序加锁的前提。代价是原先依赖 `CustomTableResolver` 的调用方必须迁移。

---

## 意义与影响

这个 PR 的价值不止「修了一个死锁」，而是**把 Nereids 规划期的表锁从一个散落的副作用，重构为一个显式、有序、可观测的统一阶段**：

1. **根治死锁**：所有线程都以 table id 升序加锁，循环等待不可能形成，公平锁的死锁陷阱被彻底消除。这是数据库系统里最经典也最可靠的死锁预防手段——全序加锁。
2. **统一加锁入口**：`StatementContext.lock()` 成为唯一的加锁点，旧的 `CascadesContext.Lock`、`addTableReadLock`、`extractTables` 全部删除，约 200 行 ad-hoc 表收集代码被 `TableCollector` + `CollectRelation` 这套正规 rewrite job 流程取代，可维护性大幅提升。
3. **表收集更完整**：新收集器覆盖了 CTE、子查询、View、MTMV、Insert target 等所有表出现位置，旧版漏掉的边角（子查询里的表、MTMV 基表）都被纳入加锁范围，规划期元数据一致性更有保障。
4. **可观测性**：`SummaryProfile` 新增 `Nereids Lock Table Time` 指标，profile 里能直接看到加锁阶段耗时；`MonitoredReentrantReadWriteLock` 的 warn 日志帮助定位锁升级。
5. **影响范围**：改动横跨 54 个文件、+1083/−1218 行，触及 Nereids 规划主流程、Insert、MTMV、SqlCache、约束管理多条路径。改动量大、回归风险高，因此被回溯到 2.1.8 和 3.0.4 两个 LTS 分支。Insert 路径的分阶段加锁也埋下了 schema 一致性窗口的隐患，直接催生了后续若干修复 PR。

> **后续**：Insert 分阶段加锁的 schema 一致性问题在 [#47033](https://github.com/apache/doris/pull/47033)「insert lock all target tables」和 [#47337](https://github.com/apache/doris/pull/47337)「Use the schema saved during planning as the schema of the original target table」中继续修复，[#60182](https://github.com/apache/doris/pull/60182) 进一步处理了并发 schema change 下 insert 失败的问题。

---

## TODO

- [ ] Insert 分阶段加锁在 schema change 并发下的稳定性（已由 [#47033](https://github.com/apache/doris/pull/47033) 部分修复）
- [ ] 规划期 schema 快照与目标表实际 schema 的一致性保证（已由 [#47337](https://github.com/apache/doris/pull/47337) 修复）
- [ ] 并发 schema change 导致 insert 失败的兜底（已由 [#60182](https://github.com/apache/doris/pull/60182) 修复）
