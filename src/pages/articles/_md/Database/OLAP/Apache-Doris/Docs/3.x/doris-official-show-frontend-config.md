---
title: "SHOW FRONTEND CONFIG"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/SHOW-FRONTEND-CONFIG/"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-03T11:00:00+08:00"
category: [Database, OLAP, Apache Doris, Docs, "3.x"]
tags: ["Apache Doris", "SHOW FRONTEND CONFIG", "配置管理", "FE", "SQL", "集群管理"]
description: "Apache Doris 3.x 官方文档：SHOW FRONTEND CONFIG 语句用于展示当前集群的 FE 配置项，支持 LIKE 模式匹配，返回配置项的值、类型、是否可变、是否仅 Master 等信息。"
readingTime: "5 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [SHOW FRONTEND CONFIG](https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/SHOW-FRONTEND-CONFIG/) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-03

---

## 描述

该语句用于展示当前集群的配置（当前仅支持展示 FE 的配置项）

## 语法

```sql title="SHOW FRONTEND CONFIG"
SHOW FRONTEND CONFIG [LIKE "<pattern>"];
```

## 可选参数

**`<pattern>`**

> 可以包含普通字符和通配符的字符串

## 返回值

| 列名 | 说明 |
| --- | --- |
| Value | 配置项值 |
| Type | 配置项类型 |
| IsMutable | 是否可以通过 `ADMIN SET CONFIG` 命令设置 |
| MasterOnly | 是否仅适用于 Master FE |
| Comment | 配置项说明 |

## 示例

1. 查看当前 FE 节点的配置

```sql title="查看 FE 配置"
SHOW FRONTEND CONFIG;
```

2. 使用 like 谓词搜索当前 Fe 节点的配置

```sql title="使用 LIKE 搜索配置"
SHOW FRONTEND CONFIG LIKE '%check_java_version%';
```

返回结果示例：

```text title="返回结果"
+--------------------+-------+---------+-----------+------------+---------+
| Key                | Value | Type    | IsMutable | MasterOnly | Comment |
+--------------------+-------+---------+-----------+------------+---------+
| check_java_version | true  | boolean | false     | false      |         |
+--------------------+-------+---------+-----------+------------+---------+
```
