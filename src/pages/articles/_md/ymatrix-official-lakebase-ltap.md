---
title: "从 Lakebase 到 LTAP，是旧饭新炒，还是新的技术范式？"
source:
  type: "article"
  project: "YMatrix"
  url: "https://mp.weixin.qq.com/s?__biz=Mzg5MDU1NDczNQ==&mid=2247494873&idx=1&sn=671ff6ddf8a88b864b1593cdfa9b2e43"
  author: "YMatrix"
  site: "公众号 YMatrix"
date: "2026-07-25"
category: [Database, YMatrix, Official]
tags: ["YMatrix", "LTAP", "Lakebase", "Databricks", "HTAP", "PostgreSQL", "对象存储"]
description: "从 Databricks Lakebase 到 LTAP，是旧饭新炒还是新范式？拆解 Lakebase 存储计算分离架构与 LTAP 开放列式权威存储设想，及 Oracle/SingleStore/Snowflake 的分歧。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **原文** [从 Lakebase 到 LTAP，是旧饭新炒，还是新的技术范式？](https://mp.weixin.qq.com/s?__biz=Mzg5MDU1NDczNQ==&mid=2247494873&idx=1&sn=671ff6ddf8a88b864b1593cdfa9b2e43) · **作者** YMatrix · **来源** 公众号 YMatrix · **原文发布** 2026-07-24 · **转载** 2026-07-25

---

## 01 LTAP 是 HTAP 的新名字，还是数据库的新方向？

今年，Databricks 又提出了一个新的概念：LTAP (Lake Transactional/Analytical Processing)。从 Lakebase 再到 LTAP，让我们顺着 Databricks 的叙事，看看它究竟想解决什么问题，又把哪些更棘手的问题推到了台前。

---

## 02 Lakebase，Databricks 补上的事务拼图

Lakebase 的底层技术来自 Neon。2025 年 5 月，Databricks 宣布收购 Neon；据媒体报道，交易规模约为 10 亿美元。Neon 最核心的变化，是将传统 PostgreSQL 中紧密耦合的计算、WAL 和数据文件拆开：

- PostgreSQL Compute 继续负责 SQL 执行、事务、锁、MVCC 和扩展生态；
- Safekeeper 接收 WAL，并通过多副本 quorum 完成事务提交确认；
- PageServer 消费 WAL，根据页面与 LSN 重建指定时间点的数据；
- 对象存储承担长期、低成本的持久化存储。

![Neon/Lakebase 存储计算分离架构](/vibe-reading/images/articles/ymatrix-official-lakebase-ltap/fig-1-neon-lakebase-arch.png)

据 Gartner 预测，到 2028 年，33% 的企业软件应用将包含 Agentic AI，至少 15% 的日常工作决策将由 Agent 自主完成，Agent 类应用确实呈现出一些与传统核心业务不同的负载特征：数据库数量多、生命周期不确定、开发分支频繁、状态需要隔离，负载也可能突然出现、快速消失。Serverless、Scale-to-Zero、快速分支、即时恢复，与这种开发模式存在天然契合。

从 Databricks 的产品版图来看，这笔收购可谓恰到好处。在此之前，Databricks 已经覆盖了数据湖、数据仓库、Spark、SQL、流处理、BI、机器学习和 AI，却始终缺少一个真正贴近应用侧的事务型数据库入口。Neon 补上了这个关键窟窿，成为了 Databricks 从"分析和 AI 平台"继续向"应用数据平台"延伸的关键拼图。

---

## 03 从 Lakebase 到 LTAP

在 2026 年 6 月的 Data + AI Summit 上，Databricks 正式提出 LTAP，即 Lake Transactional/Analytical Processing，直译过来便是"湖上事务与分析处理"或"湖事务分析一体化"，它希望 OLTP、OLAP、AI 应用和 Agent 都建立在湖中同一份受治理的数据之上，尽量不再通过 CDC、ETL、Mirroring 或同步管道维护两套彼此独立的数据，Databricks 宣称 "One data，zero compromises，zero copies" 和"无需数据复制"。

Databricks 的论证大致分为三步：

1. 传统 HTAP 往往试图在一个数据库体系中融合事务与分析，可能面临资源竞争、生态不完整或专业能力不足；
2. Zero ETL、Mirroring 等方案虽然降低了管道建设成本，但底层依然存在数据复制、转换和延迟；
3. LTAP 不在计算引擎层强行统一，而是在存储层建立一份权威数据，让事务计算与分析计算独立伸缩。

这套逻辑之所以能够被提出来，关键仍然在 Lakebase。Lakebase 已经将 WAL 和页面存储从 PostgreSQL Compute 中剥离出去：Safekeeper 管 WAL，PageServer 根据 LSN 生成和重建页面，长期数据进入对象存储，在这套架构下，PageServer 作为存储服务，将物化后的数据持久化到对象存储。于是一个很自然的问题出现了：

既然数据最终都要进入对象存储，为什么还要继续以 PostgreSQL 原生页面格式保存？能不能直接把对象存储中的格式变成 Parquet、Delta 或 Iceberg，让分析引擎直接读取？

这就是 Lakebase 走向 LTAP 的关键一步，把 Lakebase (OLTP)、Lakehouse (OLAP) 和 Unity Catalog (统一治理) 包装成 AI 时代的新一代统一数据架构。

---

## 04 引擎内融合，还是存储层融合？

归根结底，HTAP 和 LTAP 面对的其实是同一个问题：事务系统与分析系统长期割裂，数据需要搬来搬去。

但是 HTAP 更强调在数据库体系内部完成融合，一张逻辑表背后可以同时存在行存、列存或不同副本，由统一事务、SQL 入口和一致性机制协调，YMatrix 便是这条融合路线的先行者。它以 PostgreSQL 生态和统一 SQL 入口为基础，在同一套数据库体系中，通过行式存储承载事务型访问，列式存储提升分析场景下的压缩率、扫描效率与数据组织能力，再结合 mxvector 向量化执行引擎加速复杂分析计算，在统一事务、一致性与治理体系之下，为不同类型的工作负载提供更合适的物理路径。

而 LTAP 更强调在存储和治理层完成融合，PostgreSQL 继续处理事务，Spark、Databricks SQL 等引擎继续负责分析；计算引擎不必相同，但底层尽量共享一份开放、受治理的权威数据。

但是这并不意味着 LTAP 天然比 HTAP 更先进，很多成熟 HTAP 产品同样具备计算隔离、行列副本和独立扩缩能力。Databricks 对 HTAP 的批评抓住了一部分真实问题，但也有意将 HTAP 描绘得过于单一，以凸显自己的存储层统一路线。

---

## 05 共享对象存储，不等于共享同一份数据

但是当我们仔细一想，便可知其中不可调和之难，OLTP 与 Lakehouse 对存储的偏好几乎处在两个极端。

OLTP 所关注的是小块随机读取 + 低延迟提交 + B-tree 索引的快速点查，而 Lakehouse 天然适合大文件顺序扫描、批量写入，将数据放到同一个对象存储桶中，并不能自动消除两类系统在访问粒度、事务语义和物理布局上的根本差异。Lakebase 即使把数据持久化到了对象存储，底层仍然主要是 PostgreSQL 页面或 Neon 内部格式。Spark、Trino 和 Databricks SQL 并不能因为"数据已经在对象存储"就直接高效读取它。

所以必然需要一种机制，将传统 PostgreSQL 的行存格式转换为 Parquet，将对象存储中的数据既能被 PostgreSQL 无损还原，又能被分析引擎以列式方式直接扫描。

在 Databrick 官方发布的 *From monolith to Lakebase to LTAP: rethinking the database from storage up*（https://www.databricks.com/blog/lakebase-ltap-rethinking-database-storage）文章中，CTO Reynold Xin 给出了一个更激进的设想，让开放列式文件成为持久化的权威数据，让 Neon 和 Lakehouse 分析引擎共享一份持久数据，而不是同时在对象存储中维护一份 PostgreSQL Page 和一份 Parquet：

- Parquet，以及 Delta/Iceberg 元数据，成为 durable source of truth；
- PostgreSQL Heap Page 从持久化权威格式降级为面向点查和事务读取的缓存表示；
- PostgreSQL Compute 仍然看到传统页面，不需要改写上层 PostgreSQL 生态；
- Lakehouse 引擎直接读取开放列式文件；
- 行式与列式不再各自维护一份独立的权威持久化副本。

这其实是在反过来重新定义数据库的存储关系。

在传统 PostgreSQL 中，Heap Page 就等于权威持久化格式，而 LTAP 理想状态下，Parquet / Delta / Iceberg 等于权威持久化格式，而 Heap Page 变为了可重建的事务访问缓存，PageServer 在把数据物化到对象存储的过程中，同时完成从 PostgreSQL 行式表示到 Parquet 列式布局的转码。官方强调，这部分工作由 PageServer 层承担，不占用正在服务事务请求的 PostgreSQL Compute。

> As the PageServer materializes pages into object storage, it transcodes Postgres data from a row format into Parquet's columnar layout…

为了保证能够从 Parquet 重新构建 PostgreSQL 页面，它需要保留两类信息：

- PostgreSQL 类型语义，对于无法无损映射到 Parquet 的特殊值和扩展类型，需要通过额外字段保留其原始语义；
- PostgreSQL 物理行位置，每一个行版本都需要携带类似 block number 与 offset number 的物理地址，使 Heap Page 能够被重新构建。

有趣的是，在这个架构下，PostgreSQL 索引并不会被直接转码为 Parquet 列。Parquet 化的主要是表数据和行版本，B-tree 等索引仍由热缓存层服务，必要时根据权威数据重建。

> Postgres indexes are not transcoded into columns；

也就是说，不是系统中不存在 WAL、缓存、索引、增量层和副本，而是只保留一份权威的持久化表数据，其他物理结构都属于可派生、可缓存或为可靠性服务的表示。

不过值得注意的是，截至 2026 年 7 月，Databricks 描述的"单一列式权威存储"仍处于逐步推出阶段。官方文章明确提到，在过渡期会同时写入行格式与列格式进行正确性验证，并将在未来数月继续完善和上线相关能力。现阶段的同步，还是依靠传统的类似 CDC + sync table 传统同步方式。

---

## 06 共识已经出现，分歧仍然明显

围绕 Lakebase 和 LTAP，Oracle、SingleStore、Snowflake 等知名厂商都给出了不同回应。

### Oracle：认同云上弹性，但质疑它是否配得上关键 OLTP

在这篇文章中 *Oracle AI Database vs Databricks Lakebase for Modern OLTP*（https://blogs.oracle.com/database/oracle-ai-database-vs-databricks-lakebase-modern-oltp），Oracle 并不否认存储计算分离、弹性、快速克隆和统一平台的价值。它真正反对的是：把这些能力直接等同于一套成熟的企业级 OLTP 数据库。Oracle 的质疑集中在兼容性、长事务、高并发、故障切换后的缓存恢复、跨区域容灾、诊断能力、SLA 和数十年生产经验。换句话说，Oracle 争的不是"湖上能不能放一个 PostgreSQL"，而是：一个面向开发者和弹性场景的新型 PostgreSQL 服务，是否已经具备承载最关键核心交易的完整工程成熟度？

### SingleStore：认同"一份数据"，但反对"多个引擎也算真正统一"

SingleStore 对 LTAP 愿景的认可最直接：减少复制、降低数据新鲜度问题、让事务和分析更紧密地协同，这些方向都没有错。

但它反对 Databricks 将多引擎共享存储描述为彻底统一。因为不同引擎仍然拥有各自的缓存、调度器、执行器、快照边界和故障模式，行式与列式之间也仍然需要转码。Iceberg 的单表快照，并不会自动解决 PostgreSQL 跨表事务在分析侧的原子可见性。

SingleStore 给出的答案依然是"一份数据、一个引擎"的 HTAP 路线。

### Snowflake：认同 OLTP 与 Lakehouse 需要靠近，但不把"零数据移动"当作前提

Snowflake 同样在补 PostgreSQL (收购了 Crunchy Data)，也在加强 Iceberg、分析和 AI 之间的协同。它认同开放湖表能够降低数据边界，也认同事务数据与分析平台应该更紧密地连接。

但 Snowflake 的路径是：Data Mirroring 接受近实时数据移动，pg_lake 则尝试让 PostgreSQL 更方便地读取和管理湖中 Parquet/Iceberg 数据，把 Lakehouse 的数据接到 PostgreSQL 里，重分析扫描交给 pgduck_server / DuckDB sidecar，相当于 pg_lake 让 PostgreSQL 自己扮演 Iceberg catalog。它并没有把"必须消除所有数据移动"作为架构成立的前提。

这几家的分歧可以归纳为：

- 大家都认同事务、分析和 AI 需要更紧密地协同；
- 大家都认同传统 CDC 链路存在复杂度和新鲜度成本；
- 真正的争议在于，统一应该发生在引擎层、数据库体系层、存储层，还是治理与产品平台层。

---

## 07 概念之下，仍是数据库的老矛盾

Lakebase/LTAP 的价值首先在于，它把数据库行业长期存在的几组矛盾重新推到了台前：

- 事务实时性与分析吞吐之间的矛盾；
- 专业引擎与统一治理之间的矛盾；
- 数据副本带来的隔离收益与一致性成本之间的矛盾；
- 开放文件格式与完整事务语义之间的差距；
- 云上弹性与关键业务可预测性之间的权衡。

### LTAP 不是 HTAP 的替代者，而是另一条融合路线

HTAP 和 LTAP 并不是简单的先进与落后关系。它们只是把系统统一的边界画在了不同位置。

HTAP 倾向于在一个数据库体系中管理行存、列存、事务和分析一致性；LTAP 则试图在开放存储层统一权威数据，让多个专业引擎分别计算。

哪条路线更好，最终取决于业务更看重什么：低延迟一致性、开放格式、生态兼容、独立扩缩，还是运维边界和故障模型的简单性。

### 开放格式只是起点，不等于完整数据库语义

Parquet、Delta 和 Iceberg 解决了数据开放、列式扫描、快照管理和多引擎读取问题，但 PostgreSQL 的语义远不止表中的一行数据。

MVCC、长事务、跨表原子性、锁、约束、排序规则、TOAST、自定义类型、扩展索引、Vacuum、PITR，这些能力如何在开放列式格式中保真，并不是"把行转成列"就能解决的。

### AI 放大了融合需求，却不会自动证明某一种架构

Agent 确实让数据库不再只是一个被动查询系统。它需要读取历史、分析上下文、维护状态、调用工具并写回结果，事务与分析的边界因此变得更加模糊。

但这只能说明 TP、AP 与 AI 的协同需求变强了，AI 是需求变化，而不是某个厂商架构的证明题。

---

## 08 真正的考验：从架构蓝图走向工程现实

如果未来继续跟踪 LTAP，那么下面这些问题能否被真正工程化解决，才是决定 LTAP 能否大规模落地的关键：

1. **事务延迟**：对象存储、PageServer 和多层缓存如何保证高并发 OLTP 的尾延迟可预测？
2. **语义保真**：PostgreSQL 的 MVCC、扩展类型、TOAST、排序规则和各种 Index AM 如何被完整重建？
3. **数据新鲜度**：对象存储主体数据与未物化增量如何高效合并，最大可接受增量窗口是多少？
4. **更新成本**：高频 Update/Delete 如何映射到 Parquet，如何避免小文件、写放大和持续 Compaction？
5. **索引与冷启动**：大型 B-tree、GIN、GiST、HNSW 等索引是否真的可以随时重建，冷缓存和故障切换成本有多高？
6. **事务一致性**：PostgreSQL 的跨表事务，如何映射为分析引擎可以原子观察的一致快照？
7. **故障模型**：PostgreSQL、Safekeeper、PageServer、对象存储、表格式元数据和分析引擎之间，如何定义统一的恢复边界？
8. **开放性**：所谓 Delta/Iceberg 权威数据，是否能够被第三方引擎真正独立、完整地读写，而不是只能在 Databricks 产品体系中使用？

这些问题如果没有答案，LTAP 就仍然是一幅非常精彩的架构蓝图；这些问题如果能够被逐一解决，它可能真的会改变我们对数据库持久化格式的传统认知。

---

## 09 写在最后

LTAP 并不是一个毫无意义的营销概念。它至少提出了一个足够大胆的问题：

PostgreSQL Page 是否必须永远是事务数据库的权威持久化格式？能不能让开放列式数据成为最终事实来源，而把行式页面、索引和缓存变成可重建的服务层？

这个方向很有想象力，但是笔者并不认为，仅凭"一份数据、多个引擎"这句话，就可以宣布事务与分析之间几十年的矛盾已经解决。数据不再显式复制，不代表格式转换消失；统一了持久化数据，不代表统一了事务语义；共享了对象存储，也不代表拥有相同的快照、故障和运维边界。

所以现阶段，我们需要理性看待，将 LTAP 看成一种值得认真研究、但仍需生产实践验证的存储范式探索。事务、分析与 AI 究竟应该在什么位置汇合？是同一个引擎、同一个数据库体系、同一份权威存储，还是仅仅同一个治理平台？

Databricks 已经给出了它的答案。

至于这是不是最终答案，还远未到盖棺定论的时候。

---

## 参考资料

1. [From monolith to Lakebase to LTAP: rethinking the database from storage up](https://www.databricks.com/blog/lakebase-ltap-rethinking-database-storage)
2. [Lakebase Change Data Feed](https://docs.databricks.com/aws/en/oltp/projects/lakebase-cdf)
3. [Serve lakehouse data with synced tables](https://docs.databricks.com/aws/en/oltp/projects/sync-tables)
4. [Oracle AI Database vs Databricks Lakebase for Modern OLTP](https://blogs.oracle.com/database/oracle-ai-database-vs-databricks-lakebase-modern-oltp)
5. [The Lakebase Vision Is Right. Who Will Build It First?](https://www.singlestore.com/blog/lakebase-vision-is-right/)
6. [HTAP Was Right. AI Agents Are Proving Why.](https://www.pingcap.com/blog/htap-database-vs-ltap-ai-agents/)

---

感谢你的阅读，YMatrix 期待与志同道合的你一起同行。
