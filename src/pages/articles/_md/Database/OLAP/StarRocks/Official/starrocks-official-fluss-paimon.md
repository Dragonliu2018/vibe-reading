---
title: "StarRocks × Fluss × Paimon：流湖仓分析与 ETL 闭环"
source:
  type: "article"
  project: "StarRocks"
  url: "https://mp.weixin.qq.com/s/DYShkEEzlDIdKtbLTtwOLw"
  author: "段彦"
  site: "公众号 StarRocks"
date: "2026-08-14T17:02:50+08:00"
category: [Database, OLAP, StarRocks, Official]
tags: ["StarRocks", "Fluss", "Paimon", "流湖仓", "Union Read", "Native 读写", "ETL", "数据闭环", "段彦"]
description: "段彦在 Flink Forward Asia 2026 的分享：StarRocks、Fluss 与 Paimon 如何构建流湖仓分析与 ETL 闭环，实现实时与历史数据统一查询，并通过 Native 读写能力完成湖上数据加工与结果回流。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [StarRocks × Fluss × Paimon：流湖仓分析与 ETL 闭环](https://mp.weixin.qq.com/s/DYShkEEzlDIdKtbLTtwOLw) · **作者** 段彦 · **来源** 公众号 StarRocks · **原文发布** 2026-08-13 · **转载** 2026-08-14

---

作者：段彦 阿里云高级研发工程师

导读：

在传统数据架构中，一份数据从业务系统产生，到最终支撑分析、风控、报表及对外服务，往往需要经过多套系统、多份存储和多次口径对齐。随着业务对秒级数据新鲜度、运维效率及湖仓能力提出更高要求，传统架构的局限也愈发明显。

本文整理自段彦在 Flink Forward Asia 2026 的分享，将介绍 StarRocks、Fluss 与 Paimon 如何构建流湖仓分析与 ETL 闭环，实现实时与历史数据统一查询，并通过 Native 读写能力完成湖上数据加工与结果回流。

## 场景与架构

### 1 传统做法：Lamda[^err]

![传统 Lambda 架构](/vibe-reading/images/articles/starrocks-official-fluss-paimon/lambda-arch.png)

传统 Lambda 架构通常包含实时和离线两条链路。实时链路中，业务数据先进入 Kafka，经 Flink 等流计算引擎处理后写入实时 OLAP 系统，用于低延迟分析和在线服务；离线链路则将数据写入离线数仓或湖仓体系，通过批处理 ETL 完成清洗、建模与汇总，用于报表分析、明细查询和长期归档。

这种架构在过去长期发挥着重要作用，但随着业务对实时性和一致性的要求不断提高，其局限也逐渐显现。一方面，实时与离线链路需要分别维护存储和计算资源，同一份数据往往存在多份副本；另一方面，两条链路的处理逻辑和查询引擎并不完全一致，需要投入额外成本进行口径治理。此外，Kafka、Flink、湖仓存储、OLAP 引擎、离线计算引擎及调度系统等多个组件，也进一步增加了系统的运维复杂度。

### 2 流湖仓一体 —— 存储一体 + 分析 ETL 一体

![流湖仓一体架构](/vibe-reading/images/articles/starrocks-official-fluss-paimon/stream-lakehouse-arch.png)

在流湖仓一体架构中，Flink CDC 负责捕获业务系统的变更数据并写入 Fluss；Fluss 提供实时流式存储，并通过 Tiering 机制将数据沉淀至 Paimon；Paimon 作为湖仓存储，负责历史数据的长期保存与管理。

StarRocks 则统一承担分析与 ETL：一方面通过 Union Read 同时读取 Fluss 中的实时数据与 Paimon 中的历史数据，提供秒级新鲜度的查询；另一方面直接在湖上执行大规模 ETL，并将计算结果写回 Paimon，形成完整的数据处理闭环。

这套架构的核心在于，数据仅需以流式方式写入湖仓体系一次，后续的实时分析、历史分析与数据加工均可通过同一套分析引擎完成。

### 3 Lambda vs 流湖仓闭环

![Lambda 与流湖仓闭环对比](/vibe-reading/images/articles/starrocks-official-fluss-paimon/lambda-vs-closedloop.png)

与传统 Lambda 架构相比，流湖仓闭环主要带来三方面变化。

首先，存储链路进一步收敛。通过 Fluss 与 Paimon 的协同，实时数据与历史数据形成统一的数据生命周期：实时数据保留在 Fluss 中，历史数据沉淀至 Paimon，StarRocks 在查询时按需组合读取。

其次，分析与 ETL 引擎实现统一。传统架构中的实时查询、离线 ETL 和湖仓分析通常依赖不同系统，其资源模型、优化方式和语义边界并不一致。引入 StarRocks 后，同一套向量化执行引擎既可承担交互式分析，也可执行湖上 ETL，从而降低跨系统的协作成本。

最后，数据搬迁显著减少。数据无需频繁从湖仓复制到 OLAP 内表，也无需为实时查询额外维护完整副本，从而降低数据冗余与口径漂移，并简化系统运维。

## 读：在 Fluss 上做实时分析

接下来介绍 StarRocks 如何在 Fluss 上进行实时分析。其中的关键能力是 Union Read，即通过一次查询统一读取实时数据与历史数据。

### 1 Union Read：批查也有秒级新鲜度

![Union Read 读取机制](/vibe-reading/images/articles/starrocks-official-fluss-paimon/union-read.png)

Union Read 的基本思路，是将同一张表的数据划分为历史段与实时段。历史数据通过 Tiering 沉淀至 Paimon，并基于 Paimon 的 Snapshot 进行读取；实时数据则保留在 Fluss 中，StarRocks 根据 Snapshot 对应的 Offset 读取后续增量，并在执行层对两部分数据统一扫描、合并与计算，从而通过一条 SQL 同时获得完整的历史数据和最新的实时数据。

这一设计解决了传统架构中批处理与实时查询相互割裂的问题。用户只需提交一条普通查询，即可同时覆盖 Paimon 中已归档的历史数据和 Fluss 中尚未沉淀的最新增量，将风控、监控及运营分析等场景的数据新鲜度提升至秒级。

### 2 一行 SQL 接入 · 三种读模式

![三种读取模式](/vibe-reading/images/articles/starrocks-official-fluss-paimon/three-read-modes.png)

一张逻辑表，可以通过不同访问方式在完整性、新鲜度和成本之间进行选择。

在 StarRocks 中，用户可以通过 Fluss Catalog 访问相关表，并根据业务需求选择三种读取模式。

默认情况下，直接查询表名将使用 Union Read，同时读取 Paimon 中的历史数据和 Fluss 中的实时增量，以获得完整的数据与最高的新鲜度。

如果仅需查询已沉淀至湖仓的历史数据，可以访问 table$lake。此时，StarRocks 只读取 Paimon，适用于实时性要求较低、成本敏感或需要稳定历史快照的分析任务。

如果仅关注实时数据，则可以访问 table$rt。此时，StarRocks 只读取 Fluss，适用于近实时监控、增量核验及最新事件分析等场景。

通过以上三种读取模式，用户可以基于同一个 Catalog 和同一张逻辑表，在数据完整性、新鲜度与查询成本之间灵活选择。

### 3 读取链路：Paimon 走 Native，Fluss 走 JNI

![读取链路：Paimon Native 与 Fluss JNI](/vibe-reading/images/articles/starrocks-official-fluss-paimon/read-pipeline-jni.png)

StarRocks 较早便已支持 Paimon Native 读取。对于 Paimon 的 Append Only 表和 MOR 表，StarRocks 可以通过 C++ 原生扫描能力直接读取数据文件，并复用自身的向量化执行、列式读取、Data Cache 及统计信息等能力。这种方式不仅避免了 JVM 的运行时开销，也便于将读取链路纳入 StarRocks 的执行剖析与资源管理体系。

在接入 Fluss 的早期阶段，为快速复用 Fluss 官方 Java 生态中的协议和客户端能力，StarRocks 采用 JNI 方案读取 Fluss 数据。该方案接入速度快、兼容性较好，能够快速打通端到端链路，但也带来了 C++ 服务进程与 JVM 之间的边界问题，例如内存统计不完整、Profile 难以精确、GC 行为难以控制，以及跨语言数据传递成本较高等。

因此，早期读取链路采用 Paimon 历史数据 Native 读取、Fluss 实时数据 JNI 读取的方式，并最终在 StarRocks 执行层完成合并。

### 4 读取演进：从 JNI 兼容到 Native 全链路

![读取链路从 JNI 演进到 Native](/vibe-reading/images/articles/starrocks-official-fluss-paimon/read-evolution-native.png)

随着链路逐步稳定，StarRocks 开始将 Fluss 读取能力从 JNI 演进至 Native 方案。Native 读取能够在 BE 进程内通过 C++ 直接读取 Fluss Log 表，减少 JVM 中间层带来的资源不确定性与数据拷贝开销，同时复用 StarRocks 原生的内存管理、Profile、调度及向量化执行能力。

这一演进不仅提升了查询性能，也增强了生产环境的稳定性。对于长期运行的分析服务，Native 全链路能够改善内存可观测性、故障定位与资源隔离，使实时数据读取更加贴近 StarRocks 原生数据源的执行模型，并为后续接入 Data Cache、统计信息及更复杂的优化器能力奠定基础。

## 湖仓分析 + ETL

在高效读取湖仓数据的基础上，StarRocks 还可以作为湖上结果层的数据生产引擎，通过高吞吐、高稳定性且语义完整的写入链路，完成大规模数据加工与结果回流。

### 1 写入痛点：JNI 老路，撑不起结果回流

![JNI 写入痛点](/vibe-reading/images/articles/starrocks-official-fluss-paimon/write-pain-jni.png)

相较于读取，JNI 在 Paimon 写入场景中面临更为突出的问题。写入任务通常运行时间更长、数据规模更大，对内存管理、反压机制和失败恢复能力也提出了更高要求。

在 JNI 写入链路中，Java GC 与 C++ 执行引擎之间缺乏统一的资源视图，容易造成内存不可控；当下游提交或文件写入速度下降时，写入链路也难以与 StarRocks Pipeline 执行引擎形成有效反压。此外，跨语言 Profile 信息不完整，进一步增加了性能分析和故障定位的难度。

因此，面向大规模湖上 ETL 与结果回流，StarRocks 需要构建原生写入链路，将 Paimon 写入纳入自身的执行引擎与资源管理体系。

### 2 Native 写入：复用 StarRocks 引擎，三层能力栈纯 C++ 直写 Paimon

![Native 写入三层能力栈](/vibe-reading/images/articles/starrocks-official-fluss-paimon/native-write-three-layer.png)

StarRocks 的 Native 写入方案复用了自身成熟的执行与文件写入能力，形成了三层能力体系。

执行与分发。针对 INSERT、UPDATE、DELETE 等 DML 操作，StarRocks 会根据分区信息进行 Shuffle，并结合 Paimon 的 Bucket 语义进一步执行 Bucket Shuffle，确保生成的文件能够被 Paimon 及其他引擎正确识别和读取。

稳定性保障。StarRocks 的 Pipeline 执行框架支持反压机制：当下游写入、提交或文件系统响应变慢时，上游算子可以同步降低处理速度，避免数据无限堆积。同时，Chunk 级内存 Spill 能够提高大规模 ETL 任务的稳定性；针对数据倾斜，Skew Rebalancer 可以动态调整 Writer 分布，缓解热点分区或热点 Bucket 带来的吞吐瓶颈。

文件写入。StarRocks 复用原生 Parquet 写入能力，将向量化数据直接写入列式文件，并生成相应的统计信息。对于主键表，还可以在 Sink 层设置 RowKind 信息，从而支持 INSERT、UPDATE 和 DELETE 等完整的 DML 语义。

通过以上三层能力，StarRocks 不仅可以写入 Paimon，还将 Paimon 写入完整整合至自身的分布式执行、资源控制与列式文件生产体系中。

### 3 湖仓 ETL 三大卖点

![湖仓 ETL 三大卖点](/vibe-reading/images/articles/starrocks-official-fluss-paimon/etl-selling-points.png)

StarRocks 在湖仓 ETL 场景中的价值主要体现在三个方面。

稳定性。通过反压、Spill 和数据倾斜处理等能力，StarRocks 可以有效降低大规模 ETL 任务中的 OOM 与写入抖动风险，使任务在处理海量数据时依然具备良好的稳定性、可观测性与可调优性。

场景完整性。StarRocks 不仅支持写入 Append Only 表，还支持主键表的 INSERT、UPDATE 和 DELETE，并能够处理 Paimon 的分区、分桶及混合列类型。许多过去需要多套作业串联完成的湖上数据加工，如今可以直接通过 SQL 实现。

跨引擎一致性。StarRocks 写入的 Paimon 表不仅可以由自身读取，也能够被 Flink、Spark、Trino 等引擎继续使用。湖仓体系的价值并非构建单一引擎的封闭链路，而是基于开放格式实现多引擎协同。

## 性能对比

### 1 性能 · Paimon：Native vs JNI

![Paimon 写入与读取性能对比](/vibe-reading/images/articles/starrocks-official-fluss-paimon/perf-paimon.png)

在 Paimon 写入测试中，StarRocks Native 方案相较 JNI 展现出明显的性能与稳定性优势。

在 4 台 BE、每台 8 Core / 32 GB 的集群环境下，对于 Mixed 20 列混合表，1 GB 数据量的 Native 写入耗时为 28.4 秒，JNI 为 48.5 秒，性能提升约 1.7 倍；数据量扩大至 10 GB 后，Native 耗时 50.4 秒，JNI 耗时 196 秒，性能提升约 3.9 倍。在 100 GB 数据量下，Native 仍可稳定完成写入，而 JNI 出现 OOM。对于 80 列 INT 宽表，1 GB 数据量下 Native 耗时 11.3 秒，JNI 为 57.6 秒，性能提升达到 5.1 倍。

在读取侧，Native 同样表现出明显优势。在单机 8 Core / 32 GB 环境下，针对 PK Count、PK 点查、PK 过滤及 1000 列宽表聚合等场景，Native 相较 JNI 获得约 1.4～3.4 倍的性能提升。

测试结果表明，Native 方案的收益不仅来自局部编码优化，更在于消除 JNI/JVM 中间层后，执行、内存管理与列式数据传递能够统一纳入 StarRocks 的原生体系，从而同时提升性能与稳定性。

### 2 性能 · Fluss：Native vs JNI

![Fluss 读取性能对比](/vibe-reading/images/articles/starrocks-official-fluss-paimon/perf-fluss.png)

在 Fluss 读取测试中，Native 方案同样表现出稳定的性能收益。在多个聚合、投影和过滤查询中，Scan 阶段性能提升约 2.0～2.7 倍，IOExec 阶段提升约 1.6～2.1 倍，端到端 Wall Time 提升约 1.4～1.8 倍。

测试结果表明，当 Fluss 实时数据读取从 JNI 切换至 Native 后，性能收益会沿执行链路逐步释放：Scan 阶段减少了跨语言调用和数据转换，IOExec 阶段降低了调度与数据传递成本，并最终体现为端到端查询延迟的下降。在 Union Read 场景中，实时数据读取越频繁，Native 方案带来的性能收益越明显。

## 案例

### 1 可疑事件二次核验

![可疑事件二次核验场景](/vibe-reading/images/articles/starrocks-official-fluss-paimon/case-risk-recheck.png)

实时风控中的可疑事件二次核验，是这套架构的典型应用场景。当一笔交易订单被规则引擎或模型初步标记为可疑时，系统需要快速补充更多上下文信息，例如用户近期是否存在异常交易行为、当前订单是否关联陌生收货地址、历史上是否出现过类似风险模式，以及最新日志中是否产生新的风险信号。

传统架构通常需要分别访问实时系统和历史数仓，查询链路较为复杂，还需额外保证结果一致性。借助 StarRocks Union Read，用户可以通过一条 SQL，同时读取 Fluss 中的最新日志与 Paimon 中的历史数据，快速完成二次核验。核验结果随后回传至下游规则引擎，由其决定拦截、放行或转入人工审核。

通过这种方式，实时信号与历史画像能够统一分析，使风控系统在秒级窗口内获得更完整的数据上下文。

### 2 案例 · 云上用户实时风控数据架构图

![云上用户实时风控数据架构图](/vibe-reading/images/articles/starrocks-official-fluss-paimon/case-cloud-risk-arch.png)

在云上用户的实时风控架构中，交易数据首先通过 Flink CDC 进入 Flink/Fluss 链路。实时数据保留在 Fluss 中，以支持低延迟读取，同时通过 Tiering 机制沉淀至 Paimon。StarRocks 一方面通过 Union Read 提供实时分析与风控核验能力；另一方面在湖上执行 ETL，并在 Paimon 中构建 DWD、DWS 和 ADS 等数仓分层。

其中，ADS 层数据仍由 StarRocks 对外提供查询服务，支撑风控大屏、实时拦截与运营分析等业务场景。在这一架构中，StarRocks 同时承担实时分析入口、湖上 ETL 引擎和结果层查询引擎三个角色，Fluss 与 Paimon 则分别承载实时数据与历史数据。

这是流湖仓闭环在生产环境中的典型形态：数据一次写入湖仓体系，实时数据与历史数据统一读取，计算结果继续沉淀至开放湖仓格式。

## 未来规划

![未来规划路线图](/vibe-reading/images/articles/starrocks-official-fluss-paimon/future-roadmap.png)

后续规划将围绕"读得更快、写得更全"展开：

- **推进 Union Read 2.0**：将 Fluss 与 Paimon 的 Deletion Vector 纳入 Union Read，提升 MOR 表的 Merge 效率，降低端到端查询延迟。
- **增强优化器能力**：接入行数、NDV 等统计信息，帮助 CBO 更准确地评估执行代价，并支持 Count、Limit 短路及 Time Travel 回查等优化。
- **推进 Native 全链路**：在 Fluss Log 表 Native 读取的基础上，进一步支持 PK 表，并与 Data Cache 等 StarRocks 原生能力联动。
- **补齐 Paimon Alter 能力**：支持 ADD COLUMN、DROP COLUMN、RENAME COLUMN、ALTER COLUMN 等 Schema Evolution 操作，形成更完整的 DDL 闭环。
- **支持 MV 冷数据落湖**：通过 Lake MV Rewrite，使查询能够同时利用 StarRocks 内表 MV 与湖上 MV 数据，降低存储成本并扩展分层存储能力。

总结来看，StarRocks、Fluss 与 Paimon 的组合，旨在开放湖仓体系中兼顾实时分析的新鲜度、湖仓存储的开放性，以及分析与 ETL 的统一执行能力。

通过 Union Read，在一条 SQL 中统一读取 Fluss 的实时数据与 Paimon 的历史数据。

通过 Native 读写链路，减少 JNI/JVM 中间层带来的性能开销与稳定性问题。

通过写回 Paimon，将计算结果继续沉淀至开放湖仓格式，并支持多引擎共享。

这套架构并非多个组件的简单连接，而是让流、湖、仓在数据生命周期与执行语义上形成完整闭环。

[^err]: 原文如此，疑为 Lambda。

## 相关阅读

- [SHOW CREATE ASYNC MATERIALIZED VIEW](/vibe-reading/articles/doris-official-show-create-async-mv) — **同主题**·Apache Doris 异步物化视图，与本篇 Lake MV Rewrite 能力呼应
- [Stream Load](/vibe-reading/articles/doris-official-stream-load) — **同主题**·Apache Doris 流式导入，与本篇 Fluss 实时数据写入链路呼应
- [表类型概述](/vibe-reading/articles/doris-official-data-model-overview) — **同主题**·Apache Doris 数据模型，与本篇 Paimon Append Only 表 / 主键表呼应
- [从 Lakebase 到 LTAP，是旧饭新炒，还是新的技术范式？](/vibe-reading/articles/ymatrix-official-lakebase-ltap) — **同主题**·湖库一体与 HTAP 范式探讨，与本篇流湖仓闭环对照
