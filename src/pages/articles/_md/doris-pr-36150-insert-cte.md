---
title: "让 INSERT 语句支持 CTE"
source:
  project: "Doris"
  type: "PR"
  id: "36150"
  url: "https://github.com/apache/doris/pull/36150"
date: "2026-07-01"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "Java", "Nereids", "CTE", "SQL", "FE"]
description: "在 Nereids 规划器中为 INSERT INTO 和 INSERT OVERWRITE 语句添加 CTE 支持。"
readingTime: "8 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#36150](https://github.com/apache/doris/pull/36150) · **Issue** [#35784](https://github.com/apache/doris/issues/35784) · **commit** [61857fe](https://github.com/apache/doris/commit/61857fec160de0858d8e8ee5ac02e9d111b9a7d0) · **首发版本** 2.1.5 / 3.0.0 · **变更行数** +133 行 · **合并时间** 2024-06-13

---

## 背景

Issue [#35784](https://github.com/apache/doris/issues/35784) 由 **morrySnow** 提出，请求在 Nereids 规划器中支持如下语法：

```sql title="目标：CTE + INSERT INTO"
WITH cte1 AS (SELECT * FROM src WHERE k < 4)
INSERT INTO tbl
SELECT * FROM cte1;
```

CTE（Common Table Expression，公共表表达式）是 SQL 标准中用 `WITH` 子句定义命名子查询的特性，在复杂查询中被大量使用。Doris 的 Legacy 规划器不需要支持此语法，因此这是 Nereids 专项增强。

---

## 前置知识

**Nereids 中的查询计划树**：Nereids 将 SQL 解析为一棵 `LogicalPlan` 节点树，每条 SQL 语句对应一棵树。对于普通 `SELECT` 语句，CTE 被解析为一个包裹主查询的 `LogicalCTE` 节点：

```text title="CTE 查询的计划树结构（SELECT 语句）"
LogicalCTE           ← CTE 定义节点，持有 WITH 子句中的子查询
  └── LogicalProject / LogicalFilter / ...  ← 主查询体
```

对于 INSERT 语句，Nereids 在主查询之外还需要一个 **Sink 节点**（`LogicalResultSink` 或 `InsertOverwriteSink`）来表示写入目标。因此，CTE 节点要插入什么位置，是这次实现的核心问题。

---

## 实现

### 语法层：一个问号打开 CTE

`DorisParser.g4` 中 INSERT 语句的产生式只增加了一个 `cte?`：

```antlr4 title="DorisParser.g4 — INSERT 产生式变更"
statementBase
-    | explain? INSERT (INTO | OVERWRITE TABLE) ...
+    | explain? cte? INSERT (INTO | OVERWRITE TABLE) ...
    ;
```

`cte?` 表示 CTE 子句可选，与 `SELECT` 语句共用已有的 `cte` 产生式，无需额外定义语法规则。

### 解析层：提取 CTE 并传入命令对象

`LogicalPlanBuilder.visitInsert` 在构造命令对象前，先将 CTE 从解析上下文中提取出来：

```java title="LogicalPlanBuilder.java — 提取 CTE"
Optional<LogicalPlan> cte = Optional.empty();
if (ctx.cte() != null) {
    cte = Optional.ofNullable(withCte(plan, ctx.cte()));
}

if (isOverwrite) {
    command = new InsertOverwriteTableCommand(sink, labelName, cte);
} else {
    command = new InsertIntoTableCommand(sink, labelName, Optional.empty(), cte);
}
```

`withCte(plan, ctx.cte())` 将 CTE 上下文构造为 `LogicalCTE` 节点。CTE 以 `Optional<LogicalPlan>` 的形式传入命令对象，由命令在执行阶段负责将其拼入计划树。

### InsertIntoTableCommand：CTE 包裹归一化后的计划

`InsertIntoTableCommand.run()` 在对计划做 `normalizePlan`（处理默认值、内联表等）之后，将 CTE 节点套在归一化结果之外：

```java title="InsertIntoTableCommand.java — CTE 拼接"
// 1. 归一化：处理 default 值、空 VALUES 等
this.logicalQuery = (LogicalPlan) InsertUtils.normalizePlan(logicalQuery, targetTableIf);

// 2. 若有 CTE，将 CTE 节点作为归一化计划的父节点
if (cte.isPresent()) {
    this.logicalQuery = (LogicalPlan) cte.get().withChildren(logicalQuery);
}
// 最终树：CTE → (Sink → SELECT ...)
```

拼接后的树结构：

```text title="InsertIntoTableCommand 的最终计划树"
LogicalCTE               ← cte 节点（with 子句定义）
  └── LogicalResultSink  ← 写入目标
        └── SELECT 子树  ← 引用 cte1 的查询
```

### InsertOverwriteTableCommand：CTE 插入 Sink 之下

`INSERT OVERWRITE` 的实现稍有不同。在 `run()` 的执行过程中，约第 150 行有清理操作，会移除 Sink 以外的顶层节点。若将 CTE 套在 Sink 之外，会被这里的逻辑剥离。

解决方案是将 CTE 插入 **Sink 的第一个子节点位置**，而非 Sink 之外：

```java title="InsertOverwriteTableCommand.java — CTE 拼接"
this.logicalQuery = (LogicalPlan) InsertUtils.normalizePlan(logicalQuery, targetTableIf);
if (cte.isPresent()) {
    // sink.withChildren(cte.withChildren(sink原来的child))
    this.logicalQuery = (LogicalPlan) logicalQuery.withChildren(
            cte.get().withChildren(this.logicalQuery.child(0)));
}
```

拼接后的树结构：

```text title="InsertOverwriteTableCommand 的最终计划树"
InsertOverwriteSink      ← Sink 保持在根部（不被清理逻辑移除）
  └── LogicalCTE         ← cte 节点插在 Sink 之下
        └── SELECT 子树
```

### 其他命令：透传 Optional.empty()

`UpdateCommand`、`DeleteFromUsingCommand`、`LoadCommand`、`CreateTableCommand`、`UpdateMvByPartitionCommand` 这五个命令内部也会构造 `InsertIntoTableCommand` 或 `InsertOverwriteTableCommand`，均新增 `Optional.empty()` 作为 CTE 参数，保持向后兼容：

```java title="UpdateCommand.java — 透传空 CTE（其余四个类同理）"
new InsertIntoTableCommand(completeQueryPlan(ctx, logicalQuery),
        Optional.empty(), Optional.empty(), Optional.empty()).run(ctx, executor);
```

---

## 测试

新增 `regression-test/suites/nereids_p0/insert_into_table/insert_cte.groovy`，覆盖 6 个场景：

```groovy title="insert_cte.groovy — 6 个测试场景"
// InsertIntoTableCommand 的三种形式
sql """ with cte1 as (select * from t2 where k < 4)
        insert into t1 values (4); """                          // CTE 定义但 VALUES 不引用
sql """ with cte1 as (select * from t2 where k < 4)
        insert into t1 select * from cte1; """                  // CTE + SELECT
sql """ with cte1 as (select * from t2 where k >= 4)
        insert into t1 partition(p2) select * from cte1; """    // CTE + 指定分区

// InsertOverwriteTableCommand 的三种形式
sql """ with cte1 as (select * from t2 where k < 4)
        insert overwrite table t1 select * from cte1; """       // 覆盖写整表
sql """ with cte1 as (select 4)
        insert overwrite table t1 partition(p2) select * from cte1; """  // 覆盖写指定分区
sql """ with cte1 as (select 1)
        insert overwrite table t1 partition(*) select * from cte1; """   // 覆盖写自动检测分区
```

第一个场景（CTE 定义但 VALUES 不引用）特别用于验证 `normalizePlan` 在有 CTE 时能正常工作，不会因 CTE 节点的存在而崩溃。

---

## Review

**morrySnow** 在 review 中指出 `InsertOverwriteTableCommand` 的 CTE 拼接位置问题：

> "add cte node as sink's child to avoid remove it in L150"

并建议具体写法：`logicalQuery.withChildren(cte.get().withChildren(this.logicalQuery.child(0)))`

作者采纳，这也解释了 `InsertOverwriteTableCommand` 和 `InsertIntoTableCommand` 树结构不同的原因——前者必须将 CTE 作为 Sink 的子节点而非父节点，才能规避执行过程中的节点清理逻辑。

---

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| `WITH ... INSERT INTO ... SELECT` | ❌ 语法报错 | ✅ 支持 |
| `WITH ... INSERT OVERWRITE ... SELECT` | ❌ 语法报错 | ✅ 支持 |
| `WITH ... INSERT INTO ... VALUES` | ❌ 语法报错 | ✅ 支持（CTE 可不引用）|
| Legacy 规划器 | — | 不涉及，无需修改 |
