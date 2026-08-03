---
title: "ADD BROKER"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/ADD-BROKER"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-04T01:30:00+08:00"
category: [Database, Apache Doris, Docs, "3.x", "07 SQL 手册", "SQL 语句", "集群管理"]
tags: ["Apache Doris", "ADD BROKER", "Broker", "集群管理", "SQL"]
description: "Apache Doris 3.x 官方文档：ADD BROKER 语句用于添加一个或多个 BROKER 节点到集群，支持 FQDN。"
readingTime: "3 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [ADD BROKER](https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/ADD-BROKER) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-04

---

## 描述

该语句用于添加一个或者多个 BROKER 节点。

## 语法

```sql title="ADD BROKER 语法"
ALTER SYSTEM ADD BROKER <broker_name> "<host>:<ipc_port>" [,"<host>:<ipc_port>" [, ...] ];
```

## 必选参数

**1. `<broker_name>`**

给添加的 broker 进程起的名字。同一个集群中的 broker_name 建议保持一致。

**2. `<host>`**

需要添加的 broker 进程所在节点的 IP，如果启用了 FQDN，则使用该节点的 FQDN。

**3. `<ipc_port>`**

需要添加的 broker 进程所在节点的 PORT，该端口默认值为 8000。

## 输出字段

无

## 权限控制

执行该操作的用户需要具备 NODE_PRIV 的权限。

## 示例

增加两个 Broker

```sql title="增加两个 Broker"
ALTER SYSTEM ADD BROKER broker1 "host1:port", "host2:port";
```

- 增加一个 Broker，使用 FQDN

```sql title="使用 FQDN 增加 Broker"
ALTER SYSTEM ADD BROKER broker1 "broker_fqdn1:port";
```
