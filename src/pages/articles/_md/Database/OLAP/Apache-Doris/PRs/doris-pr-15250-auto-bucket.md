---
title: "自动分桶：BUCKETS AUTO 根据数据量和集群规模智能计算分桶数"
source:
  project: "Doris"
  type: "PR"
  id: "15250"
  url: "https://github.com/apache/doris/pull/15250"
  prType: "enhancement"
date: "2026-08-05T19:00:00+08:00"
category: [Database, OLAP, Apache Doris, PRs]
tags: ["Apache Doris", "Bucket", "分桶", "DDL", "动态分区", "Java"]
description: "新增 BUCKETS AUTO 语法，建表时根据数据量和集群规模自动计算分桶数；动态分区新增分区时根据历史分区数据量的指数移动平均趋势预测下一分区大小，动态调整分桶数。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#15250](https://github.com/apache/doris/pull/15250) · **Issue** - · **commit** [34075368](https://github.com/apache/doris/commit/34075368ecfa9c64631d1f490c456d159eee84f0) · **首发版本** 1.2.2 · **变更行数** +835 行 · **合并时间** 2023-01-18

---

## 背景

Doris 的分桶（Bucket）决定了数据在 BE 节点上的物理分布方式。分桶数设置不当会引发一系列问题：

- **分桶过少**：单个 Tablet 数据量过大，查询并行度低，Compaction 耗时长，甚至触发 OOM
- **分桶过多**：元数据膨胀，小查询开销大，副本管理复杂

用户在创建表时往往难以预估合适分桶数——尤其是分区表，不同分区的数据量可能差异巨大。Doris 原有的默认行为是：用户不指定分桶数时固定使用 10 个分桶（`default_bucket_num = 10`），这个值对大多数场景都不合理。

本 PR 引入 `BUCKETS AUTO` 语法，根据数据量和集群规模自动计算分桶数。对于分区表，动态分区新增分区时还能根据历史分区数据量趋势动态调整分桶数。

## 前置知识

### Doris 分桶机制

Doris 表的数据分两层物理划分：先按分区（Partition）切分，再按分桶（Bucket）在每个分区内切分为多个 Tablet。分桶由 `DISTRIBUTED BY HASH(col) BUCKETS N` 或 `DISTRIBUTED BY RANDOM BUCKETS N` 指定。

分桶数一旦确定就**不可动态修改**（需通过 ALTER TABLE 重建）。对于动态分区表，每个新分区创建时会使用表的默认分桶数——这意味着如果表有 100 个分区，所有分区分桶数相同，即使早期分区数据量小、近期分区数据量大。

### 指数移动平均（EMA）

指数移动平均（Exponential Moving Average）是一种赋予近期数据更大权重的平滑方法：

$$
\text{EMA}_t = \alpha \cdot x_t + (1 - \alpha) \cdot \text{EMA}_{t-1}
$$

其中 $\alpha = \frac{2}{N+1}$，$N$ 为周期。本 PR 使用 $N = 7$（取最近 7 个分区的数据量），$\alpha = 0.25$。

## 实现

### 语法扩展：BUCKETS AUTO

在 SQL 解析器中新增 `KW_AUTO` 关键字，并修改 `opt_distribution_number` 规则：

```cup title="fe/fe-core/src/main/cup/sql_parser.cup"
terminal String
    ...
    KW_HISTOGRAM,
    KW_AUTO;    // 新增 AUTO 关键字

opt_distribution_number ::=
    /* Empty */
    {:
        RESULT = FeConstants.default_bucket_num;   // 不指定时用默认值
    :}
    | KW_BUCKETS INTEGER_LITERAL:numDistribution
    {:
        RESULT = numDistribution.intValue();        // 显式指定数字
    :}
    | KW_BUCKETS KW_AUTO                           // 新增：BUCKETS AUTO
    {:
        RESULT = null;                              // null 表示自动分桶
    :}
    ;
```

当 `BUCKETS AUTO` 被解析后，`opt_distribution_number` 返回 `null`，上层规则据此设置 `is_auto_bucket = true`：

```cup title="fe/fe-core/src/main/cup/sql_parser.cup"
| KW_DISTRIBUTED KW_BY KW_HASH LPAREN ident_lists:columns RPAREN opt_distribution_number:numDistribution
{:
    int bucketNum = (numDistribution == null ? -1 : numDistribution);
    boolean is_auto_bucket = (numDistribution == null);
    RESULT = new HashDistributionDesc(bucketNum, is_auto_bucket, columns);
:}
```

`is_auto_bucket` 标记从 `DistributionDesc` 传递到 `DistributionInfo`，贯穿整个建表流程。

### AutoBucketUtils：分桶数计算核心

新增工具类 `AutoBucketUtils`，封装分桶数计算逻辑：

```java title="fe/fe-core/src/main/java/org/apache/doris/common/util/AutoBucketUtils.java"
public class AutoBucketUtils {
    public static final long SIZE_100MB = 100 * 1024 * 1024L;
    public static final long SIZE_1GB = 1 * 1024 * 1024 * 1024L;
    public static final long SIZE_1TB = 1L * 1024 * 1024 * 1024 * 1024;

    public static int getBucketsNum(long uncompressedPartitionSize) {
        // 1. 根据数据量计算 N：每 1GB 一个分桶，最小 1，次小 2
        int bucketsNumBySize = getBucketsNumBySize(uncompressedPartitionSize);

        // 2. 根据集群规模计算 M：BE 数 × 每台 BE 磁盘数
        int bucketsNumByCluster = getBucketsNumByCluster();

        // 3. min(N, M, 128)，但不低于 BE 节点数
        int bucketsNum = Math.min(Math.min(bucketsNumBySize, bucketsNumByCluster), 128);
        if (bucketsNum < bucketsNumBySize && bucketsNum < getBackendNum()) {
            bucketsNum = getBackendNum();
        }
        return bucketsNum;
    }

    private static int getBucketsNumBySize(long uncompressedPartitionSize) {
        if (uncompressedPartitionSize < SIZE_100MB) return 1;
        if (uncompressedPartitionSize < SIZE_1GB) return 2;
        return (int) (uncompressedPartitionSize / SIZE_1GB);
    }

    private static int getBucketsNumByCluster() {
        // 每个可用 BE 算 1，每 50GB 磁盘容量算 1，两者相乘
        int beNum = getAvailableBackendNum();
        int diskNum = getTotalDiskNum();  // 每台 BE 的磁盘数之和
        return beNum * diskNum;
    }
}
```

计算公式分三个维度：

| 维度 | 计算方式 | 含义 |
| --- | --- | --- |
| 数据量 N | `size < 100MB → 1; size < 1GB → 2; else → size / 1GB` | 数据量驱动，每 1GB 一个分桶 |
| 集群规模 M | `可用BE数 × 每台BE磁盘数（每50GB算1块盘）` | 确保分桶能均匀分布到磁盘上 |
| 最终值 | `min(N, M, 128)`，但不低于 BE 节点数 | 三个约束取交集，上限 128，下限保证每台 BE 有分桶 |

几个计算示例：

| 数据量 | BE × 盘 | N | M | 最终 |
| --- | --- | --- | --- | --- |
| 100MB | 10 × 3 (2T盘) | 1 | 1200 | 1 |
| 1GB | 3 × 2 (500GB盘) | 2 | 60 | 2 |
| 100GB | 3 × 2 (500GB盘) | 20 | 60 | 20 |
| 500GB | 3 × 1 (1T盘) | 63 | 63 | 63 |
| 1TB | 10 × 3 (2T盘) | 128 | 1230 | 128（触顶） |
| 1TB | 200 × 7 (4T盘) | 200 | 112000 | 200（BE 数下限生效） |

### 建表时的分桶计算

`CreateTableStmt.analyze()` 中新增 `maybeRewriteByAutoBucket` 方法，在 SQL 分析阶段根据是否提供 `estimate_partition_size` 决定分桶数：

```java title="fe/fe-core/src/main/java/org/apache/doris/analysis/CreateTableStmt.java"
private static Map<String, String> maybeRewriteByAutoBucket(
        DistributionDesc distributionDesc, Map<String, String> properties) throws AnalysisException {
    if (distributionDesc == null || !distributionDesc.isAutoBucket()) {
        return properties;     // 非自动分桶，直接返回
    }

    Map<String, String> newProperties = (properties == null) ? new HashMap<>() : properties;
    newProperties.put(PropertyAnalyzer.PROPERTIES_AUTO_BUCKET, "true");

    if (!newProperties.containsKey(PropertyAnalyzer.PROPERTIES_ESTIMATE_PARTITION_SIZE)) {
        // 未提供预估数据量：使用默认值（10）
        distributionDesc.setBuckets(FeConstants.default_bucket_num);
    } else {
        // 提供了预估数据量：解析并计算分桶数
        long partitionSize = ParseUtil.analyzeDataVolumn(
                newProperties.get(PropertyAnalyzer.PROPERTIES_ESTIMATE_PARTITION_SIZE));
        distributionDesc.setBuckets(AutoBucketUtils.getBucketsNum(partitionSize));
    }
    return newProperties;
}
```

| 用户输入 | 行为 |
| --- | --- |
| `BUCKETS AUTO`（无 `estimate_partition_size`） | 使用 `FeConstants.default_bucket_num`（10） |
| `BUCKETS AUTO` + `"estimate_partition_size" = "100G"` | 调用 `AutoBucketUtils.getBucketsNum(100GB)` 计算 |
| `BUCKETS 10`（显式指定） | 不触发改写，使用用户指定值 |

### 动态分区的趋势预测

对于动态分区表，新增分区时不再使用固定的默认分桶数，而是根据历史分区数据量的趋势动态计算。核心逻辑在 `DynamicPartitionScheduler` 中：

```java title="fe/fe-core/src/main/java/org/apache/doris/clone/DynamicPartitionScheduler.java"
// 指数移动平均
private static long ema(ArrayList<Long> history, int period) {
    double alpha = 2.0 / (period + 1);     // alpha = 0.25 (period=7)
    double ema = history.get(0);
    for (int i = 1; i < history.size(); i++) {
        ema = alpha * history.get(i) + (1 - alpha) * ema;
    }
    return (long) ema;
}

private static long getNextPartitionSize(ArrayList<Long> historyPartitionsSize) {
    if (historyPartitionsSize.size() < 2) {
        return historyPartitionsSize.get(0);    // 只有一个分区，直接用其大小
    }

    int size = Math.min(historyPartitionsSize.size(), 7);   // 最多取最近 7 个分区

    // 判断是否递增趋势
    boolean isAscending = true;
    for (int i = 1; i < size; i++) {
        if (historyPartitionsSize.get(i) < historyPartitionsSize.get(i - 1)) {
            isAscending = false;
            break;
        }
    }

    if (isAscending) {
        // 递增：用增量序列的 EMA 预测下一个增量，加到最新值上
        ArrayList<Long> historyDeltaSize = Lists.newArrayList();
        for (int i = 1; i < size; i++) {
            historyDeltaSize.add(historyPartitionsSize.get(i) - historyPartitionsSize.get(i - 1));
        }
        return historyPartitionsSize.get(size - 1) + ema(historyDeltaSize, 7);
    } else {
        // 非递增（递减或波动）：直接对历史值求 EMA
        return ema(historyPartitionsSize, 7);
    }
}
```

趋势判断逻辑：

| 趋势 | 预测方式 | 原因 |
| --- | --- | --- |
| 递增 | 最新值 + 增量序列的 EMA | 数据在增长，用增量趋势预测下一步增量 |
| 递减 / 波动 | 历史值的 EMA | 数据不稳定，取平滑均值更保守 |

获取历史分区数据量时，按分区范围上界排序确保取到最近的分区：

```java title="fe/fe-core/src/main/java/org/apache/doris/clone/DynamicPartitionScheduler.java"
private static int getBucketsNum(DynamicPartitionProperty property, OlapTable table) {
    if (!table.isAutoBucket()) {
        return property.getBuckets();     // 非自动分桶，用配置值
    }

    List<Partition> partitions = Lists.newArrayList();
    RangePartitionInfo info = (RangePartitionInfo) table.getPartitionInfo();
    List<Map.Entry<Long, PartitionItem>> idToItems = new ArrayList<>(info.getIdToItem(false).entrySet());
    // 按分区范围上界排序，确保获取的是最近的分区
    idToItems.sort(Comparator.comparing(o -> ((RangePartitionItem) o.getValue()).getItems().upperEndpoint()));

    for (Map.Entry<Long, PartitionItem> idToItem : idToItems) {
        Partition partition = table.getPartition(idToItem.getKey());
        if (partition != null) partitions.add(partition);
    }

    if (partitions.size() == 0) return property.getBuckets();    // 无历史分区，用默认值

    // 收集有数据的历史分区大小
    ArrayList<Long> partitionSizeArray = Lists.newArrayList();
    for (Partition partition : partitions) {
        if (partition.getVisibleVersion() >= 2) {    // 跳过空分区
            partitionSizeArray.add(partition.getDataSize());
        }
    }

    // 数据库存储的是压缩后大小，×5 还原为未压缩大小
    long uncompressedPartitionSize = getNextPartitionSize(partitionSizeArray) * 5;
    return AutoBucketUtils.getBucketsNum(uncompressedPartitionSize);
}
```

### 元数据持久化与兼容性

**关键设计决策**：`autoBucket` 标记不存储在 `DistributionInfo` 的序列化字段中，而是存储在 `TableProperty` 的 properties map 里。

Review 中 morningman 指出了元数据兼容性问题：

> You can not change `write` method like this, this will cause metadata incompatible. I suggest to not modify the `write` and `read` method of `DistributionDesc` and its derived classes.

作者的解决方案是将 `autoBucket` 存储在 `TableProperty` 中（通过 properties map 序列化），`DistributionInfo` 反序列化后通过 `OlapTable.readFields` 中的 `markAutoBucket()` 补回标记：

```java title="fe/fe-core/src/main/java/org/apache/doris/catalog/OlapTable.java — readFields"
if (in.readBoolean()) {
    tableProperty = TableProperty.read(in);
}
// 从 TableProperty 中恢复 autoBucket 标记到 DistributionInfo
if (isAutoBucket()) {
    defaultDistributionInfo.markAutoBucket();
}
```

这样旧版本的元数据文件（没有 `autoBucket` 字段）可以正常加载，新版本写入的元数据旧版本也能读取——`TableProperty` 的 properties map 是天然的向后兼容结构。

### SHOW CREATE TABLE 支持

修改 `HashDistributionInfo.toSql()` 和 `RandomDistributionInfo.toSql()`，当 `autoBucket` 为 true 时输出 `BUCKETS AUTO`：

```java title="fe/fe-core/src/main/java/org/apache/doris/catalog/HashDistributionInfo.java"
public String toSql() {
    // ...
    if (autoBucket) {
        builder.append(") BUCKETS AUTO");
    } else {
        builder.append(") BUCKETS ").append(bucketNum);
    }
    return builder.toString();
}
```

同时在 `Env.getDdlStmt` 中输出 `estimate_partition_size` 属性。

### DistributionDesc 重构：移除 Writable 接口

本 PR 顺带移除了 `DistributionDesc` 的 `Writable` 接口实现（`write` / `readFields`），因为实际持久化使用的是 `DistributionInfo` 的序列化，`DistributionDesc` 只是分析阶段的临时对象。`bucketNum` 字段也从子类上移到基类 `DistributionDesc`：

```java title="fe/fe-core/src/main/java/org/apache/doris/analysis/DistributionDesc.java — 修改后"
public class DistributionDesc {           // 不再 implements Writable
    protected DistributionInfoType type;
    protected int numBucket;              // 从子类上移
    protected boolean autoBucket;         // 新增

    public DistributionDesc(int numBucket, boolean autoBucket) {
        this.numBucket = numBucket;
        this.autoBucket = autoBucket;
    }
}
```

## 测试

### 单元测试

新增 `AutoBucketUtilsTest.java`（+294 行），使用 JMockit mock `SystemInfoService` 和 `Env`，覆盖 8 种场景：

| 测试方法 | 数据量 | 集群 | 期望分桶数 | 验证点 |
| --- | --- | --- | --- | --- |
| `testWithoutEstimatePartitionSize` | — | 1BE × 1盘 | 10 | 无 `estimate_partition_size` 时用默认值 |
| `test100MB` | 100MB | 10BE × 3盘 | 1 | 小数据量 → 1 桶 |
| `test500MB` | 500MB | 10BE × 3盘 | 1 | < 1GB → 1 桶 |
| `test1G` | 1GB | 3BE × 2盘 | 2 | ≥ 1GB → 每 1GB 一桶 |
| `test100G` | 100GB | 3BE × 2盘 | 20 | 中等数据量 |
| `test500G_0` | 500GB | 3BE × 1盘(1T) | 63 | min(N, M) 生效 |
| `test500G_1` | 500GB | 10BE × 3盘(2T) | 100 | N < M < 128 |
| `test500G_2` | 500GB | 1BE × 1盘(100T) | 100 | 单节点场景 |
| `test1T_0` | 1TB | 10BE × 3盘(2T) | 128 | 触顶 128 |
| `test1T_1` | 1TB | 200BE × 7盘(4T) | 200 | BE 数下限生效 |

测试还验证了 `SHOW CREATE TABLE` 输出包含 `BUCKETS AUTO`。

### 回归测试

```groovy title="regression-test/suites/autobucket/test_autobucket.groovy"
suite("test_autobucket") {
    sql "drop table if exists autobucket_test"
    result = sql """
        CREATE TABLE `autobucket_test` (
          `user_id` largeint(40) NOT NULL
        ) ENGINE=OLAP
        DUPLICATE KEY(`user_id`)
        DISTRIBUTED BY HASH(`user_id`) BUCKETS AUTO
        PROPERTIES ("replication_allocation" = "tag.location.default: 1")
    """
    result = sql "show create table autobucket_test"
    assertTrue(result.toString().containsIgnoreCase("BUCKETS AUTO"))

    result = sql "show partitions from autobucket_test"
    assertEquals(Integer.valueOf(result.get(0).get(8)), 10)   // 无 estimate_partition_size → 默认 10
}
```

### UtFrameUtils 增强

为支持单元测试中建表 + SHOW 操作，本 PR 还增强了 `UtFrameUtils`，新增 `createDatabase` / `createTable` / `showCreateTable` / `showPartitions` 等辅助方法（+79 行），并修复了 `updateReplicaPathHash` 以支持单副本测试场景。

## Review

**morningman** 给出了多条有价值的审查意见：

### Critical：元数据兼容性

> You can not change `write` method like this, this will cause metadata incompatible.

morningman 指出直接修改 `DistributionDesc` 的 `write`/`read` 方法会导致旧版本元数据无法加载。作者最终选择将 `autoBucket` 存储在 `TableProperty` 的 properties map 中，而非 `DistributionInfo` 的序列化字段中，实现了向后兼容。

### Important：分区排序

> You can not rely on partition id to get the latest partition. Use partition range value instead.

原代码通过 partition id 排序获取最近的分区，但 partition id 不保证与时间顺序一致。作者改为按分区范围上界（`upperEndpoint`）排序。

### Important：跳过空分区

> skip empty partition

原代码遍历所有历史分区计算数据量，但空分区（`visibleVersion < 2`）会拉低平均值。作者增加了 `if (partition.getVisibleVersion() >= 2)` 过滤。

### Suggestion：压缩比

> No need `* 5`, we can just use compressed data size to calc bucket num.

morningman 建议直接用压缩后的数据量计算，但作者回复 `AutoBucketUtils.getBucketsNum` 接受的是未压缩大小，因此需要 `× 5` 还原（假设 5:1 压缩比）。

### Suggestion：日志级别

> too many logs. remove some or change to debug level

`AutoBucketUtils` 中有较多 INFO 级别日志。作者回应建表不是高频操作，INFO 级别可接受。

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| 建表不指定分桶数 | 固定 10 个分桶 | 仍固定 10 个（需配合 `estimate_partition_size`） |
| `BUCKETS AUTO` + `estimate_partition_size` | 不支持 | 根据数据量和集群规模自动计算 |
| `BUCKETS AUTO`（无 `estimate_partition_size`） | 不支持 | 使用默认值 10 |
| 动态分区新增分区 | 所有分区相同分桶数 | 根据历史分区数据量趋势动态调整 |
| `SHOW CREATE TABLE` | 不支持 AUTO 语法 | 正确输出 `BUCKETS AUTO` |

**降低使用门槛**：用户不再需要了解集群磁盘数和 BE 数量，只需提供预估单分区数据量即可获得合理分桶数。对于动态分区表，系统会自动跟踪数据增长趋势，新分区的分桶数随数据量变化而调整。

**设计上的限制**：初始建表时如果未提供 `estimate_partition_size`，仍使用默认值 10——这并不比原来好多少。真正的价值在于动态分区场景：随着历史分区数据的积累，趋势预测会越来越准，分桶数会逐步收敛到合理值。

**元数据兼容性**：通过将 `autoBucket` 存储在 `TableProperty` 的 properties map 中而非 `DistributionInfo` 序列化字段中，确保了从旧版本升级时元数据兼容，这是一个值得借鉴的向后兼容设计模式。
