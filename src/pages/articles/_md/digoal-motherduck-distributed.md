---
title: "聊聊 MotherDuck 的分布式"
source:
  type: "article"
  project: "MotherDuck"
  url: "https://mp.weixin.qq.com/s/tiUutBQ78cSmb6c2Fbd_Pg"
  author: "digoal德哥"
  site: "digoal德哥 微信公众号"
date: "2026-07-30T18:30:00+08:00"
category: [Database, MotherDuck, Informal]
tags: ["MotherDuck", "DuckDB", "分布式", "Serverless", "数据仓库", "MPP", "Duckling"]
description: "MotherDuck 的分布式不是传统 MPP：单条查询单节点执行，平台用更多 Duckling 扩展租户和并发。本文拆解 workload-level distribution、单节点优势的物理天花板、Duckling 三层扩展与 Serverless 计费的真相边界。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [聊聊 MotherDuck 的分布式](https://mp.weixin.qq.com/s/tiUutBQ78cSmb6c2Fbd_Pg) · **作者** digoal德哥 · **来源** digoal德哥 微信公众号 · **原文发布** 2026-07-29 · **转载** 2026-07-30

---

一听到"分布式数据仓库"，很多人脑中都是几百台机器齐刷刷开工，把一条 SQL 切成几百份。基于 DuckDB 的 serverless 数据仓库 MotherDuck 偏偏反着来：一条查询尽量只在一个 Duckling 节点里跑完，平台再用许多 Duckling 承接不同用户和查询。

这听起来有点像"我没有分布式，但我分布式了"。绕口归绕口，它恰好点出了 MotherDuck 最值得聊的地方：它扩展的不是一条查询，而是整个平台上的工作负载。

## 先把"分布式"说清楚

传统 MPP 数据仓库里的 MPP，是"大规模并行处理"的缩写。Snowflake 收到一条大查询后，会让一个 Virtual Warehouse 里的多个 worker 一起读数据、做 join 和聚合；Databricks Spark 则把作业拆成 stage 和 task，分发到集群各处。

好处很直接：一台机器装不下的数据，可以摊到很多机器上；代价是调度、协调和网络传输。查询越小，这些"开会成本"占比越高——活还没干多少，群聊已经拉了八个。

MotherDuck 选择另一条路：单个查询交给一个 Duckling，在节点内多核执行，不再拆给其他 Duckling；需要更多并发时，平台启动更多独立 Duckling。这是 **workload-level distribution**，也就是工作负载级分布，而非 MPP 的查询内并行。

![workload-level distribution vs query-level distribution](/vibe-reading/images/articles/digoal-motherduck-distributed/workload-vs-query-distribution.png)

这一区分不是咬文嚼字。1000 个 Duckling 同时服务 1000 个用户，不等于 1000 个 Duckling 能一起加速某一个超大查询。前者解决的是"人多"，后者解决的是"活大"。MotherDuck 主攻前者，也把后者留给 Snowflake、BigQuery 和 Databricks。

## 单节点为什么能打

MotherDuck 敢这样设计，底气来自 DuckDB。DuckDB 是嵌入式分析数据库，核心武器并不神秘：列式存储只读取查询需要的列；向量化执行不是一行一行解释，而是一批一批交给 CPU；morsel-driven parallelism 再把数据块分给单机多个核心。少搬无关数据、少做解释开销、榨干单机多核。

第一性原理其实很朴素：一条分析查询的时间，大致等于有效计算，加上数据搬运和系统协调。如果工作集能被一台机器的内存与本地 SSD 承接，那么剔除网络 shuffle、跨节点协调和重复序列化的开销，往往比盲目增加机器更划算。单机不是天然快，少做无用功的单机才快。

这套逻辑有一个重要前提：查询工作集和中间态不能远超单节点能力。MotherDuck 的 CIDR 2024 论文引用云数仓轨迹称，超过 95% 的数据库小于 1 TB，超过 95% 的查询涉及少于 10 GB 数据；Mühleisen 在 2025 年的《小数据失落的十年》中也强调了小数据被长期低估。

不过也不能太绝对。数据库总大小、输入扫描量、运行内存不是同一个数字。一个查询只读几 GB，遇到高基数 GROUP BY、全局排序或两个大表 hash join，仍可能制造几十乃至几百 GB 的中间态。"95%"只能作为 MotherDuck 产品定位时的统计依据，不能当成你家系统一定能单机跑完的保证。

边界一旦被突破，DuckDB 可以把中间数据 spill 到 SSD，也就是内存放不下时临时写盘。查询"还能跑"，却不保证"仍然很快"。

## Duckling 怎么扩

MotherDuck 把扩展拆成三个层面。

第一个是**纵向扩容**。Duckling 分为 Pulse、Standard、Jumbo、Mega、Giga 等级，更高等级给单条查询更多计算和内存资源。它解决的是"这一个活需要更大的机器"，但最高档仍是一台机器，不会突然变成跨节点 shuffle 引擎。公开材料对最高档的精确内存规格披露有限。

第二个是 **hypertenancy**，可译作"超多租户"。每个用户、客户或 AI agent 获得一个或多个独立 Duckling。某个客户突然跑出昂贵查询，影响主要留在自己的进程和资源额度内，不容易把隔壁客户的仪表盘一起拖慢。这比共享大集群更容易做故障隔离和费用上限。

但"独立 Duckling"应理解为独立进程或容器级计算单元，不能自动推导成每个租户都独占物理机。对象存储、元数据服务、调度器和网络仍可能共享，因此 query 延迟是否稳定，最终还得看 P95、P99 实测，不能靠架构图脑补。

第三个是 **read-scaling replica**，即只读扩展副本。多个副本读取同一份底层数据，它增加的是同时服务读请求的能力，不会把一条查询拆到 40 个副本上跑；每个副本也仍消耗计算、缓存和 I/O，不能因为数据没有复制 40 份，就说副本成本"几乎为零"。

这三个合在一起，设计就很清楚了：Duckling 等级负责单查询的纵向规模，hypertenancy 负责租户隔离，read replicas 负责单一数据源的高并发读请求并发。所谓"平台级分布式"，说的正是这三件事，而不是一条 SQL 横跨数百台机器。

## Serverless

Serverless 的意思从来不是机房消失了，而是用户不再预先管理服务器。MotherDuck 按 compute-unit seconds 计费，可以粗略理解为"计算能力 × 实际占用秒数"；没有查询时，Duckling 可以关停，因此用户侧没有持续的空闲计算费用。

它还宣传约 100ms 冷启动。顺带提醒一下，这是 Duckling 计算进程就绪时间，不是用户提交 SQL 后 100ms 就看到结果。第一次查询还可能经历元数据获取、计划生成、对象存储中数据的读取、解压和网络返回。对短而频繁的交互查询，少等一两秒都很有价值；对跑半小时的 ETL，冷启动可以忽略。

"零空闲成本"也只成立于用户账单视角。平台要维持快速调度能力，必然承担预留容量和基础设施成本，再摊入计算单价。与此同时，每租户独立进程会减少共享缓存和统计复用。间歇、突发的短查询可能很省；全天稳定高负载则未必比一个利用率很高的共享 warehouse 便宜。

## 怎么选

BI 仪表盘、SaaS 内嵌分析、AI agent 的短查询，通常符合"查询相对小、用户彼此独立、流量有突发、在意费用上限"这组前提，正是 MotherDuck 的甜蜜区。此时应重点验证副本扩展后的 P99、冷数据首查，以及某个大客户是否会耗尽自己的 Duckling 配额。

超大事实表之间的 repartition join、PB 级批处理、持续高并发写入、大规模特征工程，则更需要 MPP 的聚合内存、网络 shuffle 和 stage 级容错。大量用户反复访问同一份热数据时，共享 worker 和缓存也可能比每租户独立进程更划算。

## 收尾

MotherDuck 的"分布式"不是传统 MPP：而是单个查询单节点执行，平台用更多 Duckling 扩展租户和并发。

DuckDB 的单机优势来自列存、向量化、多核并行和减少协调开销，但优势有物理天花板；不要看总数据量大小，真正该关注的是查询工作集、中间态和 spill。Pricemedic 官方案例提到约 100 TB 数据湖。这个例子说明：MotherDuck 的边界不能只看湖里总共有多少数据，还要看查询实际触达的工作集。

它最适合 BI、AI agent 与中小规模的交互分析，不是 Snowflake、BigQuery 或 Databricks 的通用替代品。解决单节点就能满足的场景时，MotherDuck 很有竞争力；需要跨节点执行的场景，就别逼一只鸭子去拉火车了。
