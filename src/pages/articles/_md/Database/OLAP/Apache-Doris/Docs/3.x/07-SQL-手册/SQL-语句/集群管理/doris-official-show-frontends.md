---
title: "SHOW FRONTENDS"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/SHOW-FRONTENDS"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-04T00:30:00+08:00"
category: [Database, OLAP, Apache Doris, Docs, "3.x", "07 SQL 手册", "SQL 语句", "集群管理"]
tags: ["Apache Doris", "SHOW FRONTENDS", "FE 节点", "集群管理", "SQL"]
description: "Apache Doris 3.x 官方文档：SHOW FRONTENDS 语句用于查看 FE 节点的基本状态信息，返回名称、主机、端口、角色、存活状态等 19 列。"
readingTime: "4 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [SHOW FRONTENDS](https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/cluster-management/instance-management/SHOW-FRONTENDS) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-04

---

## 描述

该语句用于查看 FE 节点的基本状态信息。

## 语法

```sql title="SHOW FRONTENDS 语法"
SHOW FRONTENDS
```

## 返回值

| 列名 | 说明 |
| --- | --- |
| Name | 当前 FE 在此 Doris 中的名称，该名称通常是一个以 fe 为前缀的随机字符串 |
| Host | 当前 FE 的 IP 地址或主机名 |
| EditLogPort | 当前 FE 的 bdbje 通信端口 |
| HttpPort | 当前 FE 的 http 通信端口 |
| QueryPort | 当前 FE 的 MySQL 协议通信端口 |
| RpcPort | 当前 FE 的 thrift RPC 通信端口 |
| ArrowFlightSqlPort | 当前 FE 的 ArrowFlight 协议通信端口 |
| Role | 当前 FE 的角色，可能的值有 FOLLOWER 和 OBSERVER |
| IsMaster | 当前 FE 是否被选举为 Master |
| ClusterId | 当前 Doris 集群的 ID，通常为一个随机生成的数字 |
| Join | 用于表示当前 FE 节点是否成功加入当前 Doris 集群 |
| Alive | 当前 FE 是否存活 |
| ReplayedJournalId | 当前 FE 已经回放的最大元数据日志 ID |
| LastStartTime | 当前 FE 启动的时间戳 |
| LastHeartbeat | 当前 FE 上一次成功发送心跳的时间戳 |
| IsHelper | 当前 FE 是否为 bdbje 中的 helper 节点 |
| ErrMsg | 当前 FE 心跳失败时的错误信息 |
| Version | 当前 FE 的版本信息 |
| CurrentConnected | 当前客户端链接是否连接了当前 FE 节点 |

## 权限控制

执行此 SQL 命令的用户必须至少具有以下权限：

| 权限 | 对象 | 说明 |
| --- | --- | --- |
| SELECT_PRIV | internal.information_schema | 所有用户默认有该 db 的权限 |

## 注意事项

如果需要对查询结果进行进一步的过滤，可以使用表值函数 `frontends()`。SHOW FRONTENDS 与下面语句等价：

```sql title="等价查询"
SELECT * FROM FRONTENDS();
```

## 示例

```sql title="查看 FE 节点"
SHOW FRONTENDS
```

```text title="返回结果"
+-----------------------------------------+-----------+-------------+----------+-----------+---------+--------------------+----------+----------+-----------+------+-------+-------------------+---------------------+---------------------+----------+--------+-----------------------------+------------------+
| Name                                    | Host      | EditLogPort | HttpPort | QueryPort | RpcPort | ArrowFlightSqlPort | Role     | IsMaster | ClusterId | Join | Alive | ReplayedJournalId | LastStartTime       | LastHeartbeat       | IsHelper | ErrMsg | Version                     | CurrentConnected |
+-----------------------------------------+-----------+-------------+----------+-----------+---------+--------------------+----------+----------+-----------+------+-------+-------------------+---------------------+---------------------+----------+--------+-----------------------------+------------------+
| fe_65a0c6f0_b31f_42ac_bd20_26d851299f1a | 127.0.0.1 | 9010        | 8030     | 9030      | 9020    | 10030              | FOLLOWER | true     | 840241689 | true | true  | 302891            | 2025-01-20 02:11:39 | 2025-01-21 09:48:36 | true     |        | doris-2.1.7-rc03-443e87e203 | Yes              |
+-----------------------------------------+-----------+-------------+----------+-----------+---------+--------------------+----------+----------+-----------+------+-------+-------------------+---------------------+---------------------+----------+--------+-----------------------------+------------------+
```
