---
title: "优化表 Schema 设计"
source:
  type: "article"
  project: "Doris-3.x"
  url: "https://doris.apache.org/zh-CN/docs/3.x/query-acceleration/tuning/tuning-plan/optimizing-table-schema/"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-03T11:30:00+08:00"
category: [Database, Apache Doris, Official]
tags: ["Apache Doris", "Schema 设计", "表引擎", "分桶列", "Key 列", "字段类型", "性能调优"]
description: "Apache Doris 3.x 官方文档：从实际案例角度展示因 Schema 设计问题导致的性能瓶颈，涵盖表引擎选择、分桶列选择、Key 列优化、字段类型优化四个典型场景及优化建议。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [优化表 Schema 设计](https://doris.apache.org/zh-CN/docs/3.x/query-acceleration/tuning/tuning-plan/optimizing-table-schema/) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-03

---

## 概述

Schema 设计和调优中，表设计是其中重要的一部分，包括表引擎选择、分区分桶列选择、分桶大小设置、key 列和字段类型优化等。缺乏 Schema 设计的系统可能导致数据倾斜等问题，不能充分利用系统并行和排序特性，从而影响 Doris 的真实性能优势。

详细设计原则可参考[数据表设计](https://doris.apache.org/zh-CN/docs/3.x/table-design/overview/)章节。本章从实际案例角度，展示几种典型场景下因 Schema 设计问题导致的性能瓶颈，并给出优化建议。

## 案例 1：表引擎选择

Doris 支持 Duplicate、Unique、Aggregate 三种表模型。其中 Unique 又可分为 Merge-On-Read（MOR）和 Merge-On-Write（MOW）两种。

查询性能由好到差依次为：Duplicate > MOW > MOR == Aggregate。通常情况下，如果没有特殊需求，推荐使用 Duplicate 表以获得更好的查询性能。

**优化建议：** 当业务无数据更新需求，但对查询性能有较高要求时，推荐使用 [Duplicate 表](https://doris.apache.org/zh-CN/docs/3.x/table-design/data-model/duplicate/)。

## 案例 2：分桶列选择

Doris 支持对数据进行分桶操作，即依据 Schema 中预设的分桶键来分布数据，进而形成数据 Bucket。

选取恰当的分桶列对于原始数据的合理分布至关重要，能有效防止数据倾斜引发的性能问题，同时最大化利用 Colocate Join 和 Bucket Shuffle Join 特性提升 Join 性能。

以下面 t1 表为例，当前分桶列选定为 c2。若 c2 列的值全部默认为 null，那么即便设定了 64 个分桶，实际上也只有一个分桶会包含所有数据，导致严重的数据倾斜：

```sql title="t1 表建表与数据导入"
CREATE TABLE `t1` (
  `c1` INT NULL,
  `c2` INT NULL
) ENGINE=OLAP
DUPLICATE KEY(`c1`)
DISTRIBUTED BY HASH(`c2`) BUCKETS 64
PROPERTIES (
"replication_allocation" = "tag.location.default: 1"
);

insert into t1 select number, null from numbers ('number'='10000000');
```

可以将分桶列从 c2 改为 c1，以实现数据的充分散列，最大化利用系统并行处理能力。

在 Schema 设计阶段，业务人员需要根据业务特性提前进行合理的分桶列设计。例如，如果预先了解到某列可能包含大量倾斜的值（如 null 或某些特定值），应避免选择这些字段作为分桶列，而应选择具有充分散列特性的字段（如用户 ID）。

排查时可以使用以下 SQL 确认分桶字段是否存在数据倾斜：

```sql title="排查分桶列数据倾斜"
select c2, count(*) cnt from t1 group by c2 order by cnt desc limit 10;
```

**优化建议：** 检查分桶列是否存在数据倾斜问题，如果存在，则更换为在业务含义上具有充分散列特性的字段作为分桶列。

## 案例 3：Key 列优化

在三种表模型中，若建表 Schema 明确指定了 Duplicate Key、Unique Key 或 Aggregate Key，Doris 将在存储层面确保数据依据 Key 列进行排序。这为查询性能优化提供了思路：将业务查询中频繁使用的等值或范围查询列定义为 Key 列，可显著提升查询速度。

以下是一组业务查询需求示例：

```sql title="业务查询需求示例"
select * from t1 where t1.c1 = 1;
select * from t1 where t1.c1 > 1 and t1.c1 < 10;
select * from t1 where t1.c1 in (1, 2, 3);
```

针对上述需求，可以将 c1 列作为 Key 列以加速查询：

```sql title="将 c1 设为 Key 列"
CREATE TABLE `t1` (
  `c1` INT NULL,
  `c2` INT NULL
) ENGINE=OLAP
DUPLICATE KEY(`c1`)
DISTRIBUTED BY HASH(`c2`) BUCKETS 10
PROPERTIES (
"replication_allocation" = "tag.location.default: 1"
);
```

**优化建议：** 将业务查询中频繁使用的列设定为 Key 列，以加速查询过程。

## 案例 4：字段类型优化

在数据库系统中，不同类型的数据其处理复杂程度可能存在显著差异。变长类型数据处理比定长类型更复杂，高精类型比低精类型更复杂。

设计启示：

1. 在满足业务系统表达和计算需求的前提下，应优先选择定长类型，避免使用变长类型；
2. 尽量采用低精类型，避免高精类型。具体实践包括：使用 BIGINT 替代 VARCHAR 或 STRING 类型字段，以及用 FLOAT / INT / BIGINT 替换 DECIMAL 类型字段等。

**优化建议：** 在定义 Schema 类型时，应遵循定长和低精优先的原则。

## 总结

一个精心设计的 Schema 能够最大化地利用 Doris 的特性，进而显著提升业务性能。未经过调优的 Schema 设计则可能对业务造成全局性的负面影响，例如数据倾斜等问题。因此，前期的 Schema 设计优化工作显得尤为重要。
