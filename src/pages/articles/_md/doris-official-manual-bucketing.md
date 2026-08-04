---
title: "Manual bucketing"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/table-design/data-partitioning/manual-bucketing"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-04T13:30:00+08:00"
category: [Database, Apache Doris, Docs, "3.x", "02 使用指南", "数据表设计", "数据划分"]
tags: ["Apache Doris", "Manual bucketing", "手动分桶", "Hash 分桶", "Random 分桶", "数据划分"]
description: "Apache Doris 3.x 官方文档：Manual bucketing 手动分桶，介绍分桶列选择原则、分桶数与数据量建议及 Random 分布的使用场景。"
readingTime: "6 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Manual bucketing](https://doris.apache.org/zh-CN/docs/3.x/table-design/data-partitioning/manual-bucketing) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **中英对照·AI 译** 2026-08-04
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

If partitions are used, DISTRIBUTED ... statement describes the rules for dividing data within each partition. If partitions are not used, it describes the rules for dividing the data across the entire table. It is also possible to specify a bucketing method for each partition individually.

> **译：** 如果使用了分区，`DISTRIBUTED ...` 语句描述的是每个分区内数据的划分规则。如果未使用分区，则描述的是整张表数据的划分规则。也可以为每个分区单独指定分桶方式。

The bucket columns can be multiple columns. For the Aggregate and Unique models, they must be Key columns, while for the duplicate key data model, they can be both key and value columns. Bucket columns can be the same as or different from Partition columns.

> **译：** 分桶列可以是多列。对于聚合模型和主键模型，分桶列必须是 Key 列；对于明细模型，分桶列可以是 Key 列也可以是 Value 列。分桶列可以与分区列相同，也可以不同。

The choice of bucket columns involves a trade-off between query throughput and query concurrency:

> **译：** 分桶列的选择涉及查询吞吐量和查询并发度之间的权衡：

- If multiple bucket columns are selected, the data distribution will be more uniform. If a query condition does not include equal conditions for all bucket columns, the query will trigger simultaneous scanning of all buckets, increasing query throughput and reducing the latency of individual queries. This approach is suitable for high-throughput, low-concurrency query scenarios.
- If only one or a few bucket columns are selected, a point query can trigger scanning of just one bucket. In this case, when multiple point queries are concurrent, there is a higher probability that they will trigger scanning of different buckets, reducing the IO impact between queries (especially when different buckets are distributed across different disks). Therefore, this approach is suitable for high-concurrency point query scenarios.

> **译：**
> - 如果选择多个分桶列，数据分布将更均匀。如果查询条件未包含所有分桶列的等值条件，查询将触发所有分桶的同时扫描，提高查询吞吐量，降低单个查询的延迟。这种方式适用于高吞吐、低并发的查询场景。
> - 如果只选择一个或少数几个分桶列，点查询可以只触发一个分桶的扫描。此时当多个点查询并发时，它们更有可能触发不同分桶的扫描，减少查询之间的 IO 影响（尤其是当不同分桶分布在不同磁盘上时）。因此，这种方式适用于高并发的点查询场景。

## Recommendations for bucket number and data volume

- The total number of tablets for a table is equal to (Partition num * Bucket num).
- Without considering expansion, it is recommended that the number of tablets for a table be slightly more than the total number of disks in the cluster.
- In theory, there is no upper or lower limit for the data volume of a single tablet, but it is recommended to be within the range of 1G - 10G. If the data volume of a single tablet is too small, the data aggregation effect will not be good, and the metadata management pressure will be high. If the data volume is too large, it will not be conducive to the migration and replenishment of replicas, and it will increase the cost of retrying failed operations such as Schema Change or Rollup (the granularity of retrying these operations is the tablet).
- When there is a conflict between the data volume principle and the quantity principle of tablets, it is recommended to prioritize the data volume principle.
- When creating a table, the bucket number for each partition is uniformly specified. However, when dynamically adding partitions ADD PARTITION, the bucket number for the new partition can be specified separately. This feature can be conveniently used to handle data reduction or expansion.
- Once the bucket number for a partition is specified, it cannot be changed. Therefore, when determining the bucket number, it is necessary to consider the cluster expansion scenario in advance. For example, if there are only 3 hosts with 1 disk each, and the bucket number is set to 3 or less, then even if more machines are added later, the concurrency cannot be improved.

> **译：**
> - 一张表的 tablet 总数等于（分区数 * 分桶数）。
> - 在不考虑扩容的情况下，建议一张表的 tablet 数量略多于集群磁盘总数。
> - 理论上单个 tablet 的数据量没有上下限，但建议在 1G - 10G 范围内。如果单个 tablet 数据量太小，数据聚合效果不好，且元数据管理压力大。如果数据量太大，不利于副本的迁移和补充，也会增加 Schema Change 或 Rollup 等失败操作的重试成本（这些操作的重试粒度是 tablet）。
> - 当 tablet 的数据量原则与数量原则冲突时，建议优先考虑数据量原则。
> - 建表时统一指定每个分区的分桶数。但动态增加分区 ADD PARTITION 时，可以单独指定新分区的分桶数。这一特性可以方便地用于处理数据量缩减或扩容。
> - 一旦分区的分桶数指定后就不能再更改。因此，在确定分桶数时需要提前考虑集群扩容场景。例如，如果只有 3 台机器各 1 块磁盘，分桶数设为 3 或更少，那么即使后续增加更多机器，也无法提高并发度。

Here are some examples: Assuming there are 10 BEs, each with one disk. If a table has a total size of 500MB, 4-8 tablets can be considered. For 5GB: 8-16 tablets. For 50GB: 32 tablets. For 500GB: It is recommended to partition the table, with each partition size around 50GB and 16-32 tablets per partition. For 5TB: It is recommended to partition the table, with each partition size around 50GB and 16-32 tablets per partition.

> **译：** 以下是一些示例：假设有 10 台 BE，每台一块磁盘。如果表总大小为 500MB，可考虑 4-8 个 tablet。5GB：8-16 个 tablet。50GB：32 个 tablet。500GB：建议对表进行分区，每个分区大小约 50GB，每分区 16-32 个 tablet。5TB：建议对表进行分区，每个分区大小约 50GB，每分区 16-32 个 tablet。

The data volume of a table can be viewed using the [SHOW DATA](https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/table-and-view/data-and-status-management/SHOW-DATA/) command, and the result should be divided by the number of replicas to obtain the actual data volume of the table.

> **译：** 表的数据量可以通过 [SHOW DATA](https://doris.apache.org/zh-CN/docs/3.x/sql-manual/sql-statements/table-and-view/data-and-status-management/SHOW-DATA/) 命令查看，结果需除以副本数才是表的实际数据量。

## Random distribution

- If an OLAP table does not have fields of the update type, setting the data bucketing mode of the table to RANDOM can avoid severe data skew. When data is imported into the corresponding partitions of the table, each batch of a single import job will randomly select a tablet for writing.
- When the bucketing mode of a table is set to RANDOM, there is no bucketing column, it is not possible to query only a few buckets based on the values of the bucketing column. Queries on the table will simultaneously scan all buckets that hit the partition. This setting is suitable for aggregate query analysis of the entire table data, but not suitable for high-concurrency point queries.
- If the data distribution of the OLAP table is Random Distribution, then during data import, single-tablet import mode can be set (set `load_to_single_tablet` to true). Then, during large-volume data import, a task will only write to one tablet when writing data to the corresponding partition. This can improve the concurrency and throughput of data import, reduce the write amplification caused by data import and compaction, and ensure the stability of the cluster.

> **译：**
> - 如果 OLAP 表没有更新类型的字段，将表的数据分桶方式设为 RANDOM 可以避免严重的数据倾斜。数据导入表的对应分区时，单次导入作业的每批数据会随机选择一个 tablet 进行写入。
> - 当表的分桶方式设为 RANDOM 时，没有分桶列，无法根据分桶列的值只查询少数分桶。对表的查询将同时扫描命中分区的所有分桶。此设置适用于对整表数据进行聚合查询分析，但不适用于高并发点查询。
> - 如果 OLAP 表的数据分布为 Random Distribution，则在数据导入时可以设置单 tablet 导入模式（设置 `load_to_single_tablet` 为 true）。这样在大批量数据导入时，一个任务在向对应分区写入数据时只写入一个 tablet。这可以提高数据导入的并发度和吞吐量，减少数据导入和 compaction 引起的写放大，并保证集群的稳定性。
