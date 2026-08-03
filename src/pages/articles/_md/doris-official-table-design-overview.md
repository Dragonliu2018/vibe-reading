---
title: "数据表设计概览"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/table-design/overview"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-03T13:30:00+08:00"
category: [Database, Apache Doris, Docs, "3.x", "02 使用指南", "数据表设计"]
tags: ["Apache Doris", "数据表设计", "建表", "分桶", "分区", "Schema"]
description: "Apache Doris 3.x 官方文档：数据表设计概览，介绍建表语句、表名规则、表属性（分桶数、存储介质、副本数、冷热分离）及注意事项。"
readingTime: "5 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [数据表设计概览](https://doris.apache.org/zh-CN/docs/3.x/table-design/overview) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-03

---

## 创建表

使用 CREATE TABLE 语句在 Doris 中创建一个表，也可以使用 CREATE TABKE LIKE[^err] 或 CREATE TABLE AS 子句从另一个表派生表定义。

[^err]: 原文如此，疑为 CREATE TABLE LIKE。

## 表名

Doris 中表名默认是大小写敏感的，可以在第一次初始化集群时配置 `lower_case_table_names` 为大小写不敏感的。默认的表名最大长度为 64 字节，可以通过配置 `table_name_length_limit` 更改，不建议配置过大。创建表的语法请参考 [CREATE TABLE](https://doris.apache.org/zh-CN/docs/3.x/table-design/sql-manual/sql-statements/table-and-view/table/CREATE-TABLE/)。

## 表属性

Doris 的建表语句中可以指定[建表属性](https://doris.apache.org/zh-CN/docs/3.x/table-design/sql-manual/sql-statements/table-and-view/table/CREATE-TABLE/#properties)，包括：

- 分桶数 (buckets)：决定数据在表中的分布；
- 存储介质 (storage_medium)：控制数据的存储方式，如使用 HDD、SSD 或远程共享存储；
- 副本数 (replication_num)：控制数据副本的数量，以保证数据的冗余和可靠性；
- 冷热分离存储策略 (storage_policy) ：控制数据的冷热分离存储的迁移策略；

这些属性作用于分区，即分区创建之后，分区就会有自己的属性，修改表属性只对未来创建的分区生效，对已经创建好的分区不生效，关于属性更多的信息请参考[修改表属性](https://doris.apache.org/zh-CN/docs/3.x/table-design/sql-manual/sql-statements/table-and-view/table/ALTER-TABLE-PROPERTY/)。[动态分区](https://doris.apache.org/zh-CN/docs/3.x/table-design/data-partitioning/dynamic-partitioning/) 可以单独设置这些属性。

## 注意事项

1. **选择合适的数据模型**：数据模型不可更改，建表时需要选择一个合适的[数据模型](https://doris.apache.org/zh-CN/docs/3.x/table-design/data-model/overview/)；
2. **选择合适的分桶数**：已经创建的分区不能修改分桶数，可以通过[替换分区](https://doris.apache.org/zh-CN/docs/3.x/data-operate/delete/table-temp-partition/)来修改分桶数，可以修改动态分区未创建的分区分桶数；
3. **添加列操作**：加减 VALUE 列是轻量级实现，秒级别可以完成，加减 KEY 列或者修改数据类型是重量级操作，完成时间取决于数据量，大规模数据下尽量避免加减 KEY 列或者修改数据类型；
4. **优化存储策略**：可以使用层级存储将冷数据保存到 HDD 或者 S3 / HDFS。
