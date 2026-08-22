---
title: "SHOW CREATE ASYNC MATERIALIZED VIEW"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/table-and-view/async-materialized-view/SHOW-CREATE-ASYNC-MATERIALIZED-VIEW"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-04T00:00:00+08:00"
category: [Database, OLAP, Apache Doris, Docs, "3.x", "07 SQL 手册", "SQL 语句", "表和视图"]
tags: ["Apache Doris", "SHOW CREATE MATERIALIZED VIEW", "异步物化视图", "SQL", "表和视图"]
description: "Apache Doris 3.x 官方文档：SHOW CREATE ASYNC MATERIALIZED VIEW 语句用于查看异步物化视图的创建语句。"
readingTime: "3 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [SHOW CREATE ASYNC MATERIALIZED VIEW](https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/table-and-view/async-materialized-view/SHOW-CREATE-ASYNC-MATERIALIZED-VIEW) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-04

---

## 描述

查看异步物化视图创建语句。

## 语法

```sql title="SHOW CREATE MATERIALIZED VIEW 语法"
SHOW CREATE MATERIALIZED VIEW <materialized_view_name>
```

## 必选参数

**1. `<materialized_view_new_name>`**

物化视图名称

## 返回值

| 列名 | 说明 |
| --- | --- |
| Materialized View | 物化视图名 |
| Create Materialized View | 物化视图创建语句 |

## 权限控制

执行此 SQL 命令的用户必须至少具有以下权限：

| 权限 | 对象 | 说明 |
| --- | --- | --- |
| SELECT_PRIV/LOAD_PRIV/ALTER_PRIV/CREATE_PRIV/DROP_PRIV | 表 | |

## 示例

查看异步物化视图创建语句

```sql title="查看异步物化视图创建语句"
SHOW CREATE MATERIALIZED VIEW partition_mv;
```
