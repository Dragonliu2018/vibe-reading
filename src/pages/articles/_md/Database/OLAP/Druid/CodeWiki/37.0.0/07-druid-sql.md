---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "Druid SQL"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "SQL", "Calcite", "规划", "JDBC"]
description: "Druid SQL——基于 Apache Calcite 的 SQL 前端，DruidPlanner/DruidQueryRel/PartialDruidQuery 把 SQL 规划为 native query，computeQuery 优先级级联，subquery 限制引出 MSQ。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（`sql/.../sql/`）是 Druid 的 **SQL 前端**：基于 Apache Calcite 把 SQL 解析、校验、规划为 Druid native query（GroupBy/TopN/Timeseries/Scan 等），在 Broker 上执行。它复用 native 查询引擎而非自研执行。职责边界：**SQL→native query 的翻译**；执行流水线见查询引擎模块，多阶段分布式执行见 MSQ 模块。

## 模块架构

```
SqlResource（HTTP /druid/v2/sql/）
  → SqlLifecycleManager（已授权 statement 生命周期，cancel）
  → DruidPlanner（validate → authorize → plan）
       └─ CalcitePlanner（Calcite PlannerImpl 克隆：parse → validate → rel → transform）
  → QueryHandler（SelectHandler / InsertHandler / ReplaceHandler）
       └─ VolcanoPlanner 跑 rules：DruidTableScanRule + DruidQueryRule + DruidRelToDruidRule
            把 Filter/Project/Aggregate/Sort 吸收到 PartialDruidQuery
       └─ DruidQueryRel.toDruidQuery → DruidQuery.computeQuery → native Query<?>
  → QueryMaker.runQuery（执行 native query）
```

核心是 `DruidQueryRel`——Calcite rel 树与 Druid native query 的桥，持有 `PartialDruidQuery`（累积 Calcite 算子）与 `DruidTable`（DataSource + RowSignature）。

## 调用链路

```
SqlResource.doPost(SqlQuery)  [sql/http/SqlResource.java:235]
  → HttpStatement（extends DirectStatement）.plan()  [DirectStatement.java:199]
    → plannerFactory.createPlanner → DruidPlanner
    → DruidPlanner.validate()  [planner/DruidPlanner.java:124]
       → CalcitePlanner.skipParse / validate（DruidSqlValidator）
    → authorize → createPlan → DruidPlanner.plan()  [DruidPlanner.java:243]
       → QueryHandler.plan()  [planner/QueryHandler.java:184]
         → CalcitePlanner.rel()（SqlNode → RelNode，decorrelate）
         → planWithDruidConvention → planner.transform(DRUID_CONVENTION_RULES, DruidConvention)
            VolcanoPlanner: DruidTableScanRule（LogicalTableScan→DruidQueryRel）
                           DruidQueryRule（Filter/Project/Aggregate/Sort 吸收进 PartialDruidQuery）
                           DruidRelToDruidRule（→DruidConvention）
         → DruidRel.runQuery → DruidQueryRel.toDruidQuery → PartialDruidQuery.build
            → DruidQuery.fromPartialQuery → computeQuery → Query<?>
       → QueryMaker.runQuery(druidQuery)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `DruidPlanner.validate` | 校验 SQL | 先 rewrite 参数，建 handler |
| `CalcitePlanner.rel` | SqlNode→RelNode | decorrelate |
| `DruidQueryRule.onMatch` | 吸收算子进 PartialDruidQuery | `isValidDruidQuery` 即时剪枝 |
| `DruidQueryRel.toDruidQuery` | rel→native | partialQuery.build |
| `DruidQuery.computeQuery` | 选 native query 类型 | 优先级级联 |
| `PlannerFactory.createPlanner` | 工厂 | 组装 FrameworkConfig |

</details>

## 核心实现

### DruidPlanner / CalcitePlanner

`DruidPlanner`（`sql/calcite/planner/DruidPlanner.java`）包装 `CalcitePlanner`，状态机 `START→VALIDATED→[PREPARED]→PLANNED`，`createHandler(SqlNode)` 按 SQL kind 分发 `SelectHandler`/`InsertHandler`/`ReplaceHandler`。`CalcitePlanner`（`CalcitePlanner.java`）类注释明确"Clone of Calcite's PlannerImpl, as of version 1.35"——最小定制（暴露 validator、`DruidConformance`、`DruidTypeSystem`、`DruidSqlParser.PARSER_CONFIG`），状态机 `STATE_0_CLOSED→...→STATE_5_CONVERTED`，方法 `parse`/`skipParse`/`validate`/`rel`/`transform`。`PlannerFactory`（继承 `PlannerToolbox`）`createPlanner` 组装 `FrameworkConfig`，`PlannerToolbox` 持 `DruidOperatorTable`/`ExprMacroTable`/`DruidSchemaCatalog`/`CalciteRulesManager`/`JoinableFactoryWrapper` 等共享依赖。`SqlLifecycleManager`（`@LazySingleton`）管已授权 statement 生命周期，`Map<String, List<Cancelable>>` 按 sqlQueryId 索引，供 cancel API。

### DruidQueryRel / PartialDruidQuery / DruidQuery（SQL→native 桥）

`DruidRel<T>`（`rel/DruidRel.java`）是所有 Druid rel 节点抽象基类，关键 `toDruidQuery(boolean)`（抽象）、`withPartialQuery`、`runQuery`（调 `getQueryMaker().runQuery(toDruidQuery(false))`）。`DruidQueryRel`（`rel/DruidQueryRel.java`）操作单 `DruidTable`（无 join/subquery），`toDruidQuery` 调 `partialQuery.build`。`PartialDruidQuery`（`rel/PartialDruidQuery.java`）是不含 DataSource 的构建器，维护有序 rel 链（`scan→whereFilter→selectProject→aggregate→havingFilter→...→window→windowProject`），`Stage` 枚举约束合法堆叠顺序，每个 `withXxx` 调 `validateStage` 返回新不可变实例。`DruidQuery`（`rel/DruidQuery.java`）是成形的 native query，含 `DataSource`/`DimFilter`/`Projection`/`grouping`/`sorting`/`windowing`/`Query<?>`。这设计的价值：Calcite 优化中 `PartialDruidQuery` 增量构建（每次 rule 加一层），`isValidDruidQuery()` 即时反馈（不能翻译则剪枝），`computeSelfCost` 让 VolcanoPlanner 在等价计划间做成本选择。

### computeQuery 优先级级联

`DruidQuery.computeQuery`（L1010-1058）按优先级尝试转 native query：① `toWindowQuery`→`WindowOperatorQuery` ② `toTimeBoundaryQuery` ③ `toTimeseriesQuery`（单维时间粒度）④ `toTopNQuery`（单维+LIMIT）⑤ `toGroupByQuery`（通用聚合）⑥ `toScanQuery`（无聚合选择）⑦ `toScanAndSortQuery`。`QueryDataSource` 子查询优先试 `toGroupByQuery`（groupBy toolchest 能直接处理某些子查询，避免 Broker 物化）。

### DruidOperatorTable 函数注册

`planner/DruidOperatorTable.java`（L448-489）用工厂式注册：经 Guice `Set<SqlOperatorConversion>` 与 `Set<SqlAggregator>` 注入扩展，与 `STANDARD_OPERATOR_CONVERSIONS`/`STANDARD_AGGREGATORS` 合并。新增 SQL 函数即实现 `SqlOperatorConversion`（`calciteOperator`/`toDruidExpression`）注册。

### subquery 限制与 MSQ / decoupled 演进

旧 SQL 引擎是"单段查询"模型：一条 SQL 译为一个（或有限 UNION ALL 组合的）native query，子查询结果在 Broker 物化，不适合大数据量。`DruidOuterQueryRel`（`rule/DruidRules.java:187-345`）处理 filter-on-aggregate 等不能合并到单 `PartialDruidQuery` 的场景。这限制正是 MSQ 引入动机——MSQ 编译为多段 DAG，中间结果落盘。37.0.0 还有 **decoupled planning** 新路径：`CalciteRulesManager` 的第三个 program `DRUID_DAG_CONVENTION_RULES` 用 `DruidLogicalConvention` + `DruidQueryGenerator` 走 DAG 规划（`QueryHandler.planWithDruidConvention` L544-584 有经典 `DruidConvention` 与新 `DruidLogicalConvention` 两分支），是 MSQ 复用此路径的基础。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 访问者 | Calcite RelOpt（`RelOptRule.matches/onMatch`） | 标准优化器体系 |
| 策略 | Druid rules、`SqlEngine` | 算子吸收/执行后端可换 |
| 工厂 | `PlannerFactory`、`DruidOperatorTable` | 组装 planner、注册函数 |
| 构建器 | `PartialDruidQuery`（不可变 withXxx） | 增量构建+顺序校验 |

## 模块间交互

依赖 `query/`（`DruidQuery.computeQuery` 构造 GroupBy/Scan/TopN/Timeseries 等 native query）、`segment/`（`DruidSchema` 经 `BrokerSegmentMetadataCache` 取列元数据构造 `DruidTable`，`RowSignature`/`ColumnType`）、`server/`（`SqlResource` HTTP、`QueryScheduler`、`RequestLogger`）。`SqlEngine` 接口（`validateContext`/`getSqlStatementFactory`/`cancelQuery`）由 `NativeSqlEngine`（旧）与 `MSQTaskSqlEngine`（MSQ）实现，`SqlEngineRegistry` 管理可用引擎。

## 扩展方式

- **新增 SQL 函数**：在 `sql/calcite/expression/builtin/` 新建 `XxxOperatorConversion`（实现 `SqlOperatorConversion`），注册到 `DruidOperatorTable.STANDARD_OPERATOR_CONVERSIONS`（L366-437）；聚合实现 `SqlAggregator` 注册 `STANDARD_AGGREGATORS`。简单映射可用 `DirectOperatorConversion`/`OperatorConversions` 工厂。
- **新增 SQL→native rule**：`sql/calcite/rule/` 新建继承 `RelOptRule`，注册到 `CalciteRulesManager.druidConventionRuleSet`（L464-478）；decoupled 路径注册到 `DruidLogicalRules.rules()`。
- **新增元数据表**：`sql/calcite/schema/` 建继承 `AbstractTableSchema` 的 schema + `AbstractTable`（走 `BindableConvention`），挂到 `DruidSchemaCatalog`。
