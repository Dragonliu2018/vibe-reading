---
title: "将简单聚合查询改写为常量，完全绕过 BE"
source:
  project: "Doris"
  type: "PR"
  id: "61183"
  url: "https://github.com/apache/doris/pull/61183"
  prType: "feat"
date: "2026-08-05T16:00:00+08:00"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "Nereids", "Optimizer", "RBO", "Cache", "Java"]
description: "新增 RewriteSimpleAggToConstantRule，将 DUP 表的无 GROUP BY 聚合查询（count/min/max）改写为常量返回，通过 FE 侧异步缓存获取精确值，完全绕过 BE 执行。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#61183](https://github.com/apache/doris/pull/61183) · **Issue** - · **commit** [ac97a2c4](https://github.com/apache/doris/commit/ac97a2c4c24b61aec66458358a4ce4b0bef9f490) · **首发版本** 4.1.0 · **变更行数** +1600 行 · **合并时间** 2026-03-16

---

## 背景

对 DUP_KEYS（Duplicate Key）模型表的简单聚合查询——`SELECT count(*), min(col), max(col) FROM table`——在 Doris 中原本需要将查询下发到 BE，扫描数据后计算结果。即使表上建有物化视图或列统计信息，`count(*)` 的精确值和 `min`/`max` 的精确值仍需 BE 实际执行。

问题在于这类查询非常常见（BI 报表、数据探查、监控面板），但对大表执行全表 `count(*)` 或 `min`/`max` 开销很大。BE 需要扫描所有 rowset，即使有索引也需大量 IO。

本 PR 的思路：**这类查询的精确结果可以在 FE 侧缓存**——通过内部 SQL（`SELECT count(*) FROM table`）异步获取精确值并缓存，后续相同查询直接改写为常量返回，完全绕过 BE。

```
PR 前:  SQL → Nereids → BE 扫描全表 → 聚合 → 返回结果
PR 后:  SQL → Nereids → 改写为常量 → 直接返回（BE 不参与）
```

---

## 实现

### RewriteSimpleAggToConstantRule：规则改写

新增 Nereids rewrite rule，匹配 `LogicalAggregate → LogicalOlapScan`（或中间有 `LogicalProject`）的模式，将聚合函数替换为常量字面量。

改写条件严格——只有全部满足才触发：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/rules/rewrite/RewriteSimpleAggToConstantRule.java"
private Plan tryRewrite(LogicalAggregate<?> agg, LogicalOlapScan olapScan,
        StatementContext statementContext) {
    // 排除：指定分区 / 指定 tablet / 采样查询（缓存的是全表值，不能用于部分扫描）
    if (olapScan.isIndexSelected()
            || !olapScan.getManuallySpecifiedPartitions().isEmpty()
            || !olapScan.getManuallySpecifiedTabletIds().isEmpty()
            || olapScan.getTableSample().isPresent()) {
        return null;
    }
    // 条件 1：仅 DUP_KEYS（AGG_KEYS 行数膨胀；UNIQUE_KEYS 的 MoW 模型 min/max 可能不准）
    if (table.getKeysType() != KeysType.DUP_KEYS) {
        return null;
    }
    // 条件 2：无 GROUP BY
    if (!agg.getGroupByExpressions().isEmpty()) {
        return null;
    }
    // 条件 3：仅 COUNT / MIN / MAX
    for (AggregateFunction func : funcs) {
        if (!(func instanceof Count) && !(func instanceof Min) && !(func instanceof Max)) {
            return null;
        }
    }
    // 条件 4 & 5：每个聚合函数都能拿到常量值，否则整体放弃
    // ...
}
```

| 条件 | 原因 |
| --- | --- |
| 仅 DUP_KEYS | AGG_KEYS 的 rowCount 在 compaction 前可能膨胀；UNIQUE_KEYS 的 MoW 模型 min/max 可能包含已删除标记的行 |
| 无 GROUP BY | 有 GROUP BY 时聚合结果是分组级别的，无法用全表常量替代 |
| 仅 COUNT / MIN / MAX | SUM / AVG 等无法从元数据推导 |
| 无分区/tablet/采样限制 | 缓存的是全表值，部分扫描会返回错误结果 |
| 无 WHERE 子句 | WHERE 会产生 `LogicalFilter` 节点，阻断了 `agg → scan` 的模式匹配——天然安全 |

改写后的计划结构：

```
原计划:  LogicalAggregate(count(*), min(k1)) → LogicalOlapScan(table)
改写后:  LogicalProject(常量列表) → LogicalOneRowRelation(单行哑数据)
```

`LogicalOneRowRelation` 提供单行数据源（`__dummy__` 空列），`LogicalProject` 将常量值投射为输出列。整个计划无需 BE 参与。

### tryGetConstant：从缓存获取常量值

对每种聚合函数，尝试从 `SimpleAggCacheMgr` 获取缓存值：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/rules/rewrite/RewriteSimpleAggToConstantRule.java"
private Optional<Literal> tryGetConstant(AggregateFunction func, OlapTable table) {
    long versionTime = table.getVisibleVersionTime();  // 便宜的本地读取，作为缓存键
    // --- COUNT ---
    if (func instanceof Count) {
        OptionalLong cachedCount = SimpleAggCacheMgr.internalInstance()
                .getRowCount(table.getId(), versionTime, () -> getVisibleVersionOrUnknown(table));
        if (!cachedCount.isPresent()) return Optional.empty();  // 缓存未命中，放弃改写
        long rowCount = cachedCount.getAsLong();
        if (func.getArguments().isEmpty()) {
            return Optional.of(new BigIntLiteral(rowCount));   // count(*) → 常量
        }
        // count(not-null col) == rowCount（colOpt.isAllowNull() == false）
        // count(nullable col) 放弃（不等于 rowCount）
    }
    // --- MIN / MAX ---
    if (func instanceof Min || func instanceof Max) {
        // 仅数值和日期类型；聚合列跳过
        ColumnMinMaxKey cacheKey = new ColumnMinMaxKey(table.getId(), column.getName());
        Optional<ColumnMinMax> minMax = SimpleAggCacheMgr.internalInstance()
                .getStats(cacheKey, versionTime, () -> getVisibleVersionOrUnknown(table));
        // 将字符串值转换为 Nereids Literal
    }
}
```

关键设计：**缓存未命中时不阻塞查询**。`getRowCount` / `getStats` 返回 `Optional.empty()` 时，规则放弃改写，查询走正常的 BE 执行路径。异步缓存在后台加载，下次查询即可命中。

### SimpleAggCacheMgr：异步缓存管理器

核心组件，基于 Caffeine `AsyncLoadingCache`，通过内部 SQL 获取精确值并缓存。

#### 两级新鲜度检查

缓存键是 `versionTime`（表的可见版本时间戳），但仅靠 `versionTime` 不够——同毫秒内的并发写入会产生相同 `versionTime` 但不同 `version`。因此采用两级检查：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/stats/SimpleAggCacheMgr.java"
public Optional<ColumnMinMax> getStats(ColumnMinMaxKey key, long callerVersionTime,
        LongSupplier versionSupplier) {
    CompletableFuture<Optional<CacheValue>> future = cache.get(key);
    if (future.isDone()) {
        CacheValue value = cacheValue.get();
        if (value.versionTime() == callerVersionTime) {
            // 第一级：versionTime 相同 → 可能是同毫秒并发写入，需进一步验证
            long callerVersion = versionSupplier.getAsLong();  // 可能是 RPC（cloud 模式）
            if (callerVersion < 0) {
                return Optional.empty();  // RPC 失败，保守返回空，不失效缓存
            }
            if (value.version() == callerVersion) {
                return Optional.of(value.minMax());  // version 也相同 → 缓存有效
            }
            // version 不同 → 同毫秒写入，缓存过期
        }
        // versionTime 不同 → 表已变更，缓存过期
        cache.synchronous().invalidate(key);  // 失效，触发后台重载
    }
    return Optional.empty();  // 未命中或过期，返回空（不阻塞）
}
```

| 检查级别 | 触发条件 | 开销 | 结论 |
| --- | --- | --- | --- |
| 第一级：`versionTime` 对比 | 每次查询 | 本地读取（无 RPC） | 不同 → 立即失效 |
| 第二级：`version` 对比 | 仅当 `versionTime` 相同 | 可能 RPC（cloud 模式） | 不同 → 同毫秒写入，失效 |

这一设计避免了每次缓存检查都发起 `getVisibleVersion()` RPC——只有 `versionTime` 恰好相同时才回退到 version 检查。

#### 缓存加载：内部 SQL + 版本守卫

`CacheLoader` 通过内部 SQL 获取精确值，加载前后都捕获版本信息，防止查询执行期间的并发写入污染结果：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/stats/SimpleAggCacheMgr.java — CacheLoader.doLoad"
private Optional<CacheValue> doLoad(ColumnMinMaxKey key) throws Exception {
    OlapTable olapTable = (OlapTable) Env.getCurrentInternalCatalog().getTableByTableId(key.getTableId());
    // 加载前捕获版本
    long versionBefore = olapTable.getVisibleVersion();
    long versionTimeBefore = olapTable.getVisibleVersionTime();

    // 执行内部 SQL（禁用自身规则防止递归）
    String sql = genMinMaxSql(qualifiers, column.getName());
    try (AutoCloseConnectContext r = StatisticsUtil.buildConnectContext(false)) {
        r.connectContext.getSessionVariable().setDisableNereidsRules("REWRITE_SIMPLE_AGG_TO_CONSTANT");
        StmtExecutor stmtExecutor = new StmtExecutor(r.connectContext, sql);
        rows = stmtExecutor.executeInternalQuery();
    }

    // 加载后验证版本未变
    long versionTimeAfter = olapTable.getVisibleVersionTime();
    if (versionTimeAfter != versionTimeBefore) {
        return Optional.empty();  // 查询期间有写入，丢弃结果
    }
    long versionAfter = olapTable.getVisibleVersion();
    if (versionAfter != versionBefore) {
        return Optional.empty();  // 同毫秒写入，丢弃结果
    }
    return Optional.of(new CacheValue(new ColumnMinMax(minVal, maxVal), versionAfter, versionTimeBefore));
}
```

三个关键设计：

1. **禁用自身规则防递归**：内部 SQL `SELECT min(col) FROM table` 也会经过 Nereids 优化，若不禁用 `REWRITE_SIMPLEAggToConstantRule`，会无限递归。通过 `setDisableNereidsRules("REWRITE_SIMPLE_AGG_TO_CONSTANT")` 禁用。
2. **加载前后版本守卫**：内部 SQL 执行期间如果有写入，`versionBefore` / `versionAfter` 不一致，结果被丢弃，下次重试。
3. **`getTableByTableId` 直接查找**：避免遍历所有 database 的 O(N) 扫描。

### Bug 修复：TRUNCATE TABLE 未重置 visibleVersion

PR body 中提到的 bug：`TRUNCATE TABLE` 替换了分区数据但从未调用 `olapTable.resetVisibleVersion()`，导致 `visibleVersionTime` 不变。`SimpleAggCacheMgr`（以及任何基于 versionTime 的逻辑）会认为缓存仍然有效，返回 truncate 前的值（如 `count(*) = 5` 而非 `0`）。

修复在 `truncateTableInternal` 中添加 `resetVisibleVersion` 调用：

```java title="fe/fe-core/src/main/java/org/apache/doris/catalog/TableAttributes.java"
public void resetVisibleVersion() {
    this.visibleVersion = TABLE_INIT_VERSION;
    this.visibleVersionTime = System.currentTimeMillis();
}
```

```java title="fe/fe-core/src/main/java/org/apache/doris/datasource/InternalCatalog.java — truncateTableInternal"
// Reset table-level visibleVersion to TABLE_INIT_VERSION so it stays consistent
// with the newly created partitions (which also start at PARTITION_INIT_VERSION).
olapTable.resetVisibleVersion();
```

此修复同时覆盖 Master 执行路径和 Follower journal-replay 路径——两者都经过 `truncateTableInternal`，因此 version 重置在主备上一致。

### Rewriter 注册

规则注册在 `Rewriter` 的 RBO 规则链中，两个位置分别处理 `agg → scan` 和 `agg → project → scan` 两种模式：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/jobs/executor/Rewriter.java"
new RewriteSimpleAggToConstantRule(),  // 在 RBO 规则链中注册
```

---

## 测试

### 单元测试

`RewriteSimpleAggToConstantRuleTest.java`（+294 行）使用 mock cache 覆盖 6 个正例和 8 个负例：

| 正例（触发改写） | 负例（不触发改写） |
| --- | --- |
| `count(*)` | 非 DUP_KEYS 表 |
| `count(not-null col)` | 有 GROUP BY |
| `min(numeric col)` / `max(numeric col)` | `count(nullable col)` |
| `count(*) + min(col) + max(col)` 组合 | `min(string col)`（非数值/日期） |
| | `sum(col)` / `avg(col)` |
| | `count(distinct col)` |
| | 指定分区 / tablet / 采样 |

### 回归测试

| 套件 | 场景 |
| --- | --- |
| `rewrite_simple_agg_to_constant.groovy`（+317 行） | 缓存预热轮询、正/负例 explain 检查、正确性断言、禁用规则验证 |
| `truncate_version_reset.groovy`（+112 行） | TRUNCATE 后 `count(*)` 返回 0（非过期缓存值），后续 insert 正确计数 |

---

## Review

**github-actions bot** 的 clang-tidy review 工具给出了 12 条详细审查意见，质量很高：

### Critical 级别

1. **构建破坏**：`Rewriter.java` 的 diff 意外删除了 ~109 个 import（`MergeFilters`、`EliminateSort` 等），且没有用 wildcard import 替代，会导致编译失败。判断为 IDE 自动 import 清理的错误。→ 作者修复，只保留新增的 `RewriteSimpleAggToConstantRule` import。

2. **数据正确性**：`tryRewrite()` 原始版本未检查 `manuallySpecifiedPartitions`、`manuallySpecifiedTabletIds`、`tableSample`——缓存的是全表值，部分扫描会返回错误结果。→ 作者补充了检查（见上文代码）。

### Minor / Suggestion

3. **未使用的参数**：`selectedIndex` 传入 `tryGetConstant` 但内部从不使用。建议移除或加 base-index 检查。
4. **命名不清**：变量名 `version` 实际是毫秒时间戳，建议改为 `versionTime`。
5. **性能**：`findTableById()` 原本遍历所有 database，O(N)。建议用 `getTableByTableId` 直接查找。→ 作者采纳。
6. **递归安全性**：内部 SQL 经过完整 Nereids pipeline，包括 `RewriteSimpleAggToConstantRule` 本身。当前"偶然安全"（Caffeine 去重 + `isDone()` 检查），但脆弱。→ 作者通过 `setDisableNereidsRules` 显式禁用，并添加注释。
7. **内存可见性**：`visibleVersion` / `visibleVersionTime` 是普通 `long`（非 `volatile`），缓存加载线程读取时无 happens-before 保证。→ 实践中由两级验证缓解，bot 确认为低风险。

### 正确性确认

8. **cloud 模式 RPC**：`getVisibleVersion()` 在 cloud 模式可能抛 `RpcException`，`doLoad` 的 `throws Exception` + 外层 `catch` 正确处理。✓
9. **before/after 版本检查**：正确检测查询期间的并发写入。✓
10. **`setDisableNereidsRules` 替换而非追加**：由于 `StatisticsUtil.buildConnectContext(false)` 创建全新的 `ConnectContext`，替换是安全的，不会误禁其他规则。✓
11. **TRUNCATE 修复**：`truncateTableInternal` 在 DB 写锁内执行，journal-replay 也经过此方法，主备一致。✓
12. **建议补充 WHERE 子句负例测试**：虽然 `LogicalFilter` 天然阻断模式匹配，但显式测试能防回归。

---

## 问题

### 为什么不用 BE tablet stats？

BE 会定期上报 tablet 级别的行数和统计信息，但这些数据有**延迟上报**和**版本不匹配**的问题——BE 上报的可能是旧版本的数据。PR body 明确说明：通过内部 SQL 获取的值是**精确且版本一致**的，不依赖 BE 的延迟上报机制。

### 缓存未命中时的行为

`SimpleAggCacheMgr` 的 `getStats` / `getRowCount` 是非阻塞的——缓存未命中时返回 `Optional.empty()`，`RewriteSimpleAggToConstantRule` 放弃改写，查询走正常 BE 执行路径。同时 Caffeine 在后台异步加载缓存，下次相同查询即可命中。这是"尽力优化"策略——不保证每次都命中，但命中时大幅加速。

### count(nullable col) 为何不支持

`count(col)` 忽略 NULL 值，而 `count(*)` 统计所有行。对于允许 NULL 的列，`count(col) != rowCount`，无法用缓存的 rowCount 替代。只有 `NOT NULL` 约束的列，`count(col) == count(*) == rowCount` 才成立。

---

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| `SELECT count(*) FROM dup_table` | BE 全表扫描 | FE 常量返回（缓存命中时） |
| `SELECT min(k), max(k) FROM dup_table` | BE 全表扫描 | FE 常量返回（缓存命中时） |
| `SELECT count(*), min(k), max(k) FROM dup_table` | BE 全表扫描 | FE 常量返回（缓存命中时） |
| 非 DUP 表 / 有 GROUP BY / 有 WHERE | 正常执行 | 正常执行（不触发改写） |
| `TRUNCATE TABLE` 后查询 | 可能返回过期值 | 正确返回 0 |

* **查询加速**：对 DUP 表的简单聚合查询，缓存命中时完全绕过 BE，延迟从秒级降至毫秒级。这类查询在 BI 报表和数据探查中极为常见。
* **精确性保证**：缓存值来自内部 SQL 的精确计算，而非 BE 的延迟上报统计。两级版本检查 + 加载前后版本守卫确保数据一致性。
* **非侵入式**：缓存未命中时透明回退到正常执行路径，不影响查询正确性。用户可通过 session 变量禁用规则。
* **附带 Bug 修复**：`TRUNCATE TABLE` 的 `visibleVersion` 重置问题不仅影响本 PR 的缓存逻辑，也影响任何依赖 versionTime 的功能，是一个独立的数据正确性修复。
* **限制**：仅支持 DUP_KEYS 表、无 GROUP BY、无 WHERE、无分区限制的 COUNT/MIN/MAX 查询。AGG_KEYS 和 UNIQUE_KEYS 的支持需要解决 compaction 前的数据准确性问题，留待后续。
