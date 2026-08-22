---
title: "Auto bucket"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/table-design/data-partitioning/auto-bucket"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-04T13:00:00+08:00"
category: [Database, OLAP, Apache Doris, Docs, "3.x", "02 使用指南", "数据表设计", "数据划分"]
tags: ["Apache Doris", "Auto bucket", "自动分桶", "BUCKETS AUTO", "数据划分"]
description: "Apache Doris 3.x 官方文档：Auto bucket 自动分桶功能动态推算分桶数，使分桶数始终保持在合理范围内，用户无需关心分桶数的细节。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Auto bucket](https://doris.apache.org/zh-CN/docs/3.x/table-design/data-partitioning/auto-bucket) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **中英对照·AI 译** 2026-08-04
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

Users often encounter various issues due to improper bucket settings. To address this, we provide an automated approach for setting the number of buckets, which is currently applicable only to OLAP tables.

> **译：** 用户经常因为不恰当的分桶设置而遇到各种问题。为此，我们提供了一种自动设置分桶数的方式，目前仅适用于 OLAP 表。

In the past, user had to set the number of buckets manually when creating table, but the automatic bucket feature is a way for Apache Doris to dynamically project the number of buckets, so that the number of buckets always stays within a suitable range and users don't have to worry about the minutiae of the number of buckets.

> **译：** 过去，用户在建表时必须手动设置分桶数，而自动分桶功能是 Apache Doris 动态推算分桶数的一种方式，使分桶数始终保持在合理范围内，用户无需关心分桶数的细节。

For the sake of clarity, this section splits the bucket into two periods, the initial bucket and the subsequent bucket; the initial and subsequent are just terms used in this article to describe the feature clearly, there is no initial or subsequent Apache Doris bucket.

> **译：** 为便于说明，本节将分桶分为两个阶段——初始分桶和后续分桶；"初始"和"后续"仅是本文用于清晰描述该功能的术语，Apache Doris 中并不存在"初始分桶"或"后续分桶"的概念。

As we know from the section above on creating buckets, `BUCKET_DESC` is very simple, but you need to specify the number of buckets; for the automatic bucket projection feature, the syntax of `BUCKET_DESC` directly changes the number of buckets to `Auto` and adds a new Properties configuration.

> **译：** 如上文创建分桶所述，`BUCKET_DESC` 非常简单，但需要指定分桶数；对于自动分桶推算功能，`BUCKET_DESC` 的语法直接将分桶数改为 `Auto`，并新增了一个 Properties 配置。

```sql title="手动分桶 vs 自动分桶"
-- old version of the creation syntax for specifying the number of buckets
DISTRIBUTED BY HASH(site) BUCKETS 20

-- Newer versions use the creation syntax for automatic bucket imputation
DISTRIBUTED BY HASH(site) BUCKETS AUTO
properties("estimate_partition_size" = "100G")
```

The new configuration parameter `estimate_partition_size` indicates the amount of data for a single partition. This parameter is optional and if not given, Doris will take the default value of `estimate_partition_size` to 10GB.

> **译：** 新增的配置参数 `estimate_partition_size` 表示单个分区的数据量。该参数为可选，如未指定，Doris 将使用默认值 10GB。

As you know from the above, a partitioned bucket is a tablet at the physical level, and for best performance, it is recommended that the tablet size be in the range of 1GB - 10GB. So how does the automatic bucketing projection ensure that the tablet size is within this range?

> **译：** 如上所述，分区分桶在物理层面是一个 tablet，为获得最佳性能，建议 tablet 大小在 1GB - 10GB 范围内。那么自动分桶推算是如何保证 tablet 大小在此范围内的呢？

To summarize, there are a few principles.

> **译：** 总结起来，有以下几条原则。

- If the overall data volume is small, the number of buckets should not be set too high
- If the overall data volume is large, the number of buckets should be related to the total number of disk blocks, so as to fully utilize the capacity of each BE machine and each disk

> **译：**
> - 如果整体数据量较小，分桶数不应设置过高
> - 如果整体数据量较大，分桶数应与磁盘块总数相关，以充分利用每台 BE 机器和每块磁盘的容量

> **提示** propertie `estimate_partition_size` not support alter

## Initial bucketing projection

1. Obtain a number of buckets N based on the data size. Initially, we divide the value of `estimate_partition_size` by 5 (considering a data compression ratio of 5 to 1 when storing data in text format in Doris). The result obtained is

> **译：**
> 1. 根据数据量获取分桶数 N。初始计算时，将 `estimate_partition_size` 的值除以 5（考虑 Doris 以文本格式存储数据时 5:1 的压缩比）。得到的结果为：

```text title="N 值计算"
(, 100MB), then take N=1
[100MB, 1GB), then take N=2
(1GB, ), then one bucket per GB
```

2. calculate the number of buckets M based on the number of BE nodes and the disk capacity of each BE node.

> **译：**
> 2. 根据 BE 节点数和每个 BE 节点的磁盘容量计算分桶数 M。

```text title="M 值计算"
Where each BE node counts as 1, and every 50G of disk capacity counts as 1.
The calculation rule for M is: M = Number of BE nodes * (Size of one disk block / 50GB) * Number of disk blocks.
For example: If there are 3 BEs, and each BE has 4 disks of 500GB, then M = 3 * (500GB / 50GB) * 4 = 120.
```

3. Calculation logic to get the final number of buckets.

> **译：**
> 3. 获取最终分桶数的计算逻辑。

```text title="最终分桶数计算"
Calculate an intermediate value x = min(M, N, 128).
If x < N and x < the number of BE nodes, the final bucket is y.
The number of BE nodes; otherwise, the final bucket is x.
```

4. `x = max(x, autobucket_min_buckets)`, Here `autobucket_min_buckets` is configured in Config (where, default is 1)

> **译：**
> 4. `x = max(x, autobucket_min_buckets)`，其中 `autobucket_min_buckets` 在 Config 中配置（默认值为 1）

The pseudo-code representation of the above process is as follows

> **译：** 上述过程的伪代码表示如下：

```text title="伪代码"
int N = Compute the N value;
int M = compute M value;
int y = number of BE nodes;
int x = min(M, N, 128);
if (x < N && x < y) {
    return y;
}
return x;
```

With the above algorithm in mind, let's introduce some examples to better understand this part of the logic.

> **译：** 了解了上述算法后，下面通过一些示例来更好地理解这部分逻辑。

```text title="计算示例"
case1:
Amount of data 100 MB, 10 BE machines, 2TB * 3 disks
Amount of data N = 1
BE disks M = 10 * (2TB/50GB) * 3 = 1230
x = min(M, N, 128) = 1
Final: 1

case2:
Data volume 1GB, 3 BE machines, 500GB * 2 disks
Amount of data N = 2
BE disks M = 3 * (500GB/50GB) * 2 = 60
x = min(M, N, 128) = 2
Final: 2

case3:
Data volume 100GB, 3 BE machines, 500GB * 2 disks
Amount of data N = 20
BE disks M = 3 * (500GB/50GB) * 2 = 60
x = min(M, N, 128) = 20
Final: 20

case4:
Data volume 500GB, 3 BE machines, 1TB * 1 disk
Data volume N = 100
BE disks M = 3 * (1TB / 50GB) * 1 = 60
x = min(M, N, 128) = 63
Final: 63

case5:
Data volume 500GB, 10 BE machines, 2TB * 3 disks
Amount of data N = 100
BE disks M = 10 * (2TB / 50GB) * 3 = 1230
x = min(M, N, 128) = 100
Final: 100

case 6:
Data volume 1TB, 10 BE machines, 2TB * 3 disks
Amount of data N = 205
BE disks M = 10 * (2TB / 50GB) * 3 = 1230
x = min(M, N, 128) = 128
Final: 128

case 7:
Data volume 500GB, 1 BE machine, 100TB * 1 disk
Amount of data N = 100
BE disk M = 1 * (100TB / 50GB) * 1 = 2048
x = min(M, N, 128) = 100
Final: 100

case 8:
Data volume 1TB, 200 BE machines, 4TB * 7 disks
Amount of data N = 205
BE disks M = 200 * (4TB / 50GB) * 7 = 114800
x = min(M, N, 128) = 128
Final: 200
```

## Subsequent bucketing projection

The above is the calculation logic for the initial bucketing. The subsequent bucketing can be evaluated based on the amount of partition data available since there is already a certain amount of partition data. The subsequent bucket size is evaluated based on the EMA (short term exponential moving average) value of up to the first 7 partitions, which is used as the `estimate_partition_size`. At this point there are two ways to calculate the partition buckets, assuming partitioning by days, counting forward to the first day partition size of S7, counting forward to the second day partition size of S6, and so on to S1.

> **译：** 以上是初始分桶的计算逻辑。后续分桶可以基于已有的分区数据量进行评估。后续分桶大小基于最近 7 个分区的 EMA（短期指数移动平均）值来评估，作为 `estimate_partition_size`。此时有两种计算分区分桶的方式，假设按天分区，往前数第一天分区大小为 S7，往前数第二天分区大小为 S6，以此类推到 S1。

- If the partition data in 7 days is strictly increasing daily, then the trend value will be taken at this time. There are 6 delta values, which are

> **译：**
> - 如果 7 天内的分区数据严格逐日递增，则此时取趋势值。有 6 个 delta 值，分别为：

```text title="趋势值计算"
S7 - S6 = delta1,
S6 - S5 = delta2,
...
S2 - S1 = delta6
```

This yields the `ema(delta)` value. Then, today's `estimate_partition_size = S7 + ema(delta)`

> **译：** 由此得到 `ema(delta)` 值。然后，今天的 `estimate_partition_size = S7 + ema(delta)`

- not the first case, this time directly take the average of the previous days EMA. Today's `estimate_partition_size = EMA(S1, ... , S7)`

> **译：**
> - 不是第一种情况时，直接取前几天的 EMA 平均值。今天的 `estimate_partition_size = EMA(S1, ... , S7)`

> **提示** According to the above algorithm, the initial number of buckets and the number of subsequent buckets can be calculated. Unlike before when only a fixed number of buckets could be specified, due to changes in business data, it is possible that the number of buckets in the previous partition is different from the number of buckets in the next partition, which is transparent to the user, and the user does not need to care about the exact number of buckets in each partition, and this automatic extrapolation will make the number of buckets more reasonable.

> **译：** 根据上述算法，可以计算出初始分桶数和后续分桶数。与以前只能指定固定分桶数不同，由于业务数据的变化，前一个分区的分桶数可能与后一个分区不同，这对用户是透明的，用户无需关心每个分区的确切分桶数，这种自动推算将使分桶数更加合理。
