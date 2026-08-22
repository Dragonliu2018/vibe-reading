---
title: "使用 Hint 调整 Join Shuffle 方式"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/query-acceleration/tuning/tuning-plan/adjusting-join-shuffle"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-03T23:00:00+08:00"
category: [Database, OLAP, Apache Doris, Docs, "3.x", "02 使用指南", "查询加速", "查询优化实践", "计划调优"]
tags: ["Apache Doris", "Join Shuffle", "Hint", "broadcast", "shuffle", "查询调优", "执行计划"]
description: "Apache Doris 3.x 官方文档：使用 Distribute Hint（[shuffle] 和 [broadcast]）调整 Join 操作的数据 Shuffle 类型，优化查询性能。"
readingTime: "5 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [使用 Hint 调整 Join Shuffle 方式](https://doris.apache.org/zh-CN/docs/3.x/query-acceleration/tuning/tuning-plan/adjusting-join-shuffle) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-03

---

## 概述

Doris 支持使用 Hint 来调整 Join 操作中数据 Shuffle 的类型，从而优化查询性能。本节将详细介绍如何在 Doris 中利用 Hint 来指定 Join Shuffle 的类型。

> **注意**
>
> 当前 Doris 已经具备良好的开箱即用的能力，也就意味着在绝大多数场景下，Doris 会自适应的优化各种场景下的性能，无需用户来手工控制 hint 来进行业务调优。本章介绍的内容主要面向专业调优人员，业务人员仅做简单了解即可。

目前，Doris 支持两种独立的 Distribute Hint，`[shuffle]` 和 `[broadcast]`，用来指定 Join 右表的 Distribute Type。Distribute Type 需置于 Join 右表之前，采用中括号 `[]` 的方式。同时，Doris 也可以通过 Leading Hint 配合 Distribute Hint 的方式，指定 shuffle 方式（详见使用 Leading Hint 控制 Join 顺序章节相关介绍）。

示例如下：

```sql title="Distribute Hint 示例"
SELECT COUNT(*) FROM t2 JOIN [broadcast] t1 ON t1.c1 = t2.c2;
SELECT COUNT(*) FROM t2 JOIN [shuffle] t1 ON t1.c1 = t2.c2;
```

## 案例

接下来将通过同一个例子来展示 Distribute Hint 的使用方法：

```sql title="原始查询"
EXPLAIN SHAPE PLAN SELECT COUNT(*) FROM t1 JOIN t2 ON t1.c1 = t2.c2;
```

原始 SQL 的计划如下，可见 t1 连接 t2 使用了 hash distribute 即 `DistributionSpecHash` 的方式。

```text title="原始执行计划"
+----------------------------------------------------------------------------------+
| Explain String (Nereids Planner)                                                 |
+----------------------------------------------------------------------------------+
| PhysicalResultSink                                                               |
| --hashAgg [GLOBAL]                                                               |
| ----PhysicalDistribute [DistributionSpecGather]                                   |
| ------hashAgg [LOCAL]                                                            |
| --------PhysicalProject                                                          |
| ----------hashJoin [INNER_JOIN] hashCondition=((t1.c1 = t2.c2)) otherCondition=()|
| ------------PhysicalProject                                                      |
| --------------PhysicalOlapScan [t1]                                              |
| ------------PhysicalDistribute [DistributionSpecHash]                             |
| --------------PhysicalProject                                                    |
| ----------------PhysicalOlapScan [t2]                                             |
+----------------------------------------------------------------------------------+
```

加入 `[broadcast]` hint 后：

```sql title="加入 broadcast hint"
EXPLAIN SHAPE PLAN SELECT COUNT(*) FROM t1 JOIN [broadcast] t2 ON t1.c1 = t2.c2;
```

可见 t1 连接 t2 的分发方式改为了 broadcast 即 `DistributionSpecReplicated` 的方式。

```text title="broadcast 执行计划"
+----------------------------------------------------------------------------------+
| Explain String (Nereids Planner)                                                 |
+----------------------------------------------------------------------------------+
| PhysicalResultSink                                                               |
| --hashAgg [GLOBAL]                                                               |
| ----PhysicalDistribute [DistributionSpecGather]                                   |
| ------hashAgg [LOCAL]                                                            |
| --------PhysicalProject                                                          |
| ----------hashJoin [INNER_JOIN] hashCondition=((t1.c1 = t2.c2)) otherCondition=()|
| ------------PhysicalProject                                                      |
| --------------PhysicalOlapScan [t1]                                              |
| ------------PhysicalDistribute [DistributionSpecReplicated]                       |
| --------------PhysicalProject                                                    |
| ----------------PhysicalOlapScan [t2]                                             |
+----------------------------------------------------------------------------------+
```

## 总结

通过合理使用 Distribute Hint，可以优化 Join 操作的 Shuffle 方式，提升查询性能。在实践中，建议先通过 EXPLAIN 分析查询执行计划，再根据实际情况指定合适的 Shuffle 类型。
