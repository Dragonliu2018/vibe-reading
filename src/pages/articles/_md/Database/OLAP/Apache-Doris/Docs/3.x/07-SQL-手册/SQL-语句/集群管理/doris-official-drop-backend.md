---
title: "DROP BACKEND"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/DROP-BACKEND"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-03T22:00:00+08:00"
category: [Database, OLAP, Apache Doris, Docs, "3.x", "07 SQL 手册", "SQL 语句", "集群管理"]
tags: ["Apache Doris", "DROP BACKEND", "BE 节点", "集群管理", "SQL"]
description: "Apache Doris 3.x 官方文档：DROP BACKEND 语句用于将 BE 节点从集群中删除，高危操作不推荐使用，建议使用 DECOMMISSION BACKEND 优雅下线。"
readingTime: "4 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [DROP BACKEND](https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/DROP-BACKEND) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-03

---

## 描述

该语句用于将 BE 节点从 Doris 集群中删除。

## 语法

```sql title="DROP BACKEND 语法"
ALTER SYSTEM DROP BACKEND "<be_identifier>" [, "<be_identifier>" ... ]
```

其中：

```sql title="be_identifier"
be_identifier : "<be_host>:<be_heartbeat_port>" | "<backend_id>"
```

## 必选参数

**1. `<be_host>`**

可以是 BE 节点的主机名或 IP 地址

**2. `<heartbeat_port>`**

BE 节点的心跳端口，默认为 9050

**3. `<backend_id>`**

BE 节点的 ID

> **提示** `<be_host>`、`<be_heartbeat_port>` 及 `<backend_id>` 均可通过 SHOW BACKENDS 语句查询获得。

## 权限控制

执行此 SQL 命令的用户必须至少具有以下权限：

| 权限 | 对象 | 说明 |
| --- | --- | --- |
| NODE_PRIV | | |

## 注意事项

不推荐使用该命令下线 BE，该命令会直接将 BE 直接从集群中删去，当前节点的数据并不会负载均衡到其他 BE 节点，如果集群存在单副本的表，那么就有可能出现数据丢失的情况。更好的做法是使用 [DECOMMISSION BACKEND](https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/DECOMMISSION-BACKEND) 命令优雅下线 BE。

- 由于此操作是高危操作，因此当直接运行此命令时：

```sql title="直接 DROP BACKEND"
ALTER SYSTEM DROP BACKEND "127.0.0.1:9050";
```

```text title="错误提示"
ERROR 1105 (HY000): errCode = 2, detailMessage = It is highly NOT RECOMMENDED to use DROP BACKEND stmt. It is not safe to directly drop a backend. All data on this backend will be discarded permanently. If you insist, use DROPP instead of DROP
```

会出现以上提示信息，如果您明白您当前所做的事情，可将 DROP 关键字替换成 DROPP，并继续下去：

```sql title="使用 DROPP"
ALTER SYSTEM DROPP BACKEND "127.0.0.1:9050";
```

## 示例

- 根据 BE 的 Host 和 HeartbeatPort 从集群中删除两个节点

```sql title="按 Host 和端口删除"
ALTER SYSTEM DROPP BACKEND "192.168.0.1:9050", "192.168.0.2:9050";
```

- 根据 BE 的 ID 从集群中删除一个节点

```sql title="按 ID 删除"
ALTER SYSTEM DROPP BACKEND "10002";
```
