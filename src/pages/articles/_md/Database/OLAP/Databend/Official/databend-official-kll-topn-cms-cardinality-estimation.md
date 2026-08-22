---
title: "从全表排序到概率统计：Databend 如何用 KLL、Top-N 与 CMS 改进基数估计？"
source:
  type: "article"
  project: "Databend"
  url: "https://mp.weixin.qq.com/s/GZkpGRqqDz5zFa28uHcMBQ"
  author: "Databend"
  site: "Databend 微信公众号"
date: "2026-07-30T17:00:00+08:00"
category: [Database, OLAP, Databend, Official]
tags: ["Databend", "基数估计", "KLL", "Top-N", "Count-Min Sketch", "查询优化器", "直方图"]
description: "Databend 用 KLL、Top-N 和 Count-Min Sketch（CMS）分工协作改进基数估计：KLL 以低内存构建近似等深直方图，Top-N 精确记录高频值，CMS 补足 Top-N 容量之外的宽热点。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [从全表排序到概率统计：Databend 如何用 KLL、Top-N 与 CMS 改进基数估计？](https://mp.weixin.qq.com/s/GZkpGRqqDz5zFa28uHcMBQ) · **作者** Databend · **来源** Databend 微信公众号 · **原文发布** 2026-07-28 · **转载** 2026-07-30

---

## 背景与问题

导读： 查询优化器既要了解数据的整体分布，也要识别少量高频值，否则就可能在 JOIN 顺序、扫描策略和算子选择上做出错误判断。本文结合 Databend 的实现与 Benchmark，介绍 KLL、Top-N 和 Count-Min Sketch（CMS）如何分工协作：KLL 以较低内存开销构建近似等深直方图，Top-N 精确记录最常见值，CMS 则补足未被 Top-N 保留的热点。

![KLL、Top-N、CMS 三者分工协作总览](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/overview.png)

SQL 查询进入数据库后，优化器需要估算不同执行计划的成本，再决定 JOIN 顺序、扫描方式和算子组合。基数估计是这一过程的基础：如果优化器错误判断某个过滤条件会返回多少行，即使执行引擎本身足够快，也可能选出代价很高的计划。

直方图（Histogram）是描述列值分布的常用统计结构。相比等宽直方图（Equi-width Histogram），等深直方图（Equi-depth Histogram）让每个桶包含大致相同数量的行，因此在存在数据热点和倾斜时，通常能提供更稳定的估计。

但准确的统计信息并不是免费的。传统方式通常需要扫描、排序并聚合整列数据。在 Databend 这类面向大规模分析、采用存算分离架构的云数据仓库中，ANALYZE 不仅消耗内存和计算资源，也可能带来大量对象存储读取。问题因此变成：

> 如何在不承担全局排序成本的前提下，获得足以支撑优化器决策的统计信息？

Databend 使用 KLL、Top-N 和 CMS 处理这个问题。三者并非互相替代，而是分别描述数据分布的不同部分。

![KLL、Top-N、CMS 各自负责的数据分布部分](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/three-structures.png)

## 等深直方图与范围估计

先看一个简化的范围查询。

```sql title="employee 建表"
CREATE TABLE employee (
    id INT,
    salary INT
);
```

假设 `salary` 列的等深直方图如下：

![salary 列的等深直方图](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/histogram.png)

对于查询：

```sql title="范围查询"
SELECT *
FROM employee
WHERE salary < 5000;
```

B1 和 B2 被完全覆盖，B3 只覆盖了部分范围。若假设桶内数据均匀分布，则估算结果为：

```text title="范围估计结果"
Estimated Rows
= B1 + B2 + B3 × Coverage
= 250 + 250 + 250 × (5000 - 4000) / (7000 - 4000)
≈ 583
```

直方图通过桶边界近似描述全局分布。但要得到完全准确的等深桶边界，传统实现往往需要完成一次全表扫描、全局排序和聚合：

![传统实现：全表扫描 + 全局排序 + 聚合](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/full-scan-sort.png)

随着数据量增长，全局排序会成为 ANALYZE 的主要时间和内存开销。KLL 的作用，就是在可接受的误差范围内移除这一瓶颈。

## KLL：用流式 Sketch 近似分位数

![KLL 移除全局排序瓶颈](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/kll-bottleneck.png)

KLL（Karnin-Lang-Liberty Sketch）是一种近似计算分位数（Quantile）的流式摘要算法。它只需要顺序读取数据，并将有限数量的样本压缩为可合并的 Sketch。

KLL 的可合并性非常适合 Databend 的分布式执行模型：不同计算节点可以并行构建局部 KLL，再将结果合并为全局 Sketch，最后查询各个分位点并生成等深桶。

![KLL 的分布式可合并性](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/kll-distributed.png)

这条路径将"全表扫描 + 全局排序 + 聚合"简化为"一次扫描 + Sketch 合并"。对于需要频繁刷新统计信息的大表，它可以显著降低内存占用，并减少统计收集对业务查询的资源干扰。

### KLL 还需要 NDV

KLL 能计算分位点和桶边界，但不能直接给出每个桶的 NDV（Number of Distinct Values，不同值数量）。而 NDV 又直接影响等值谓词的估计精度。

Databend 在第一次 ANALYZE 扫描中使用 HLL 估算整列 NDV：

```rust title="整列 NDV 估算"
let column_ndv = self
    .ndv_states
    .get(&column_id)
    .map(|hll| hll.count() as f64);
```

KLL 根据 rank 推算每个等深桶的行数 `bucket_values`，再按行数比例估算桶内 NDV：

```text title="桶内 NDV 按比例估算"
bucket_ndv = column_ndv × bucket_values / total_values
```

结果被限制在以下范围：

```text title="NDV 约束"
1 ≤ bucket_ndv ≤ bucket_values
```

例如：

```text title="示例数值"
总行数       = 10,000
全列 HLL NDV = 1,000
桶数         = 100
每桶行数     ≈ 100
```

这种估算开销低，但隐含了"不同值在各个桶中按行数比例分布"的假设。数据倾斜越明显，等值查询的估计误差就越可能增大。

![NDV 按比例估算示意](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/ndv-estimation.png)

### kll_fast 与 kll_full

Databend 提供两种基于 KLL 的 ANALYZE 方式：

- **kll_fast**：执行一次扫描，使用整列 HLL NDV 按比例估算各桶 NDV。
- **kll_full**：先用 KLL 确定桶边界，再执行第二次扫描，统计每个桶的实际行数与 HLL NDV。

`kll_full` 的处理过程如下。

第一遍扫描：

```text title="第一遍扫描"
数据 → KLL Sketch → 近似分位点 → 固定桶边界
```

第二遍扫描：

```text title="第二遍扫描"
数据 → 根据桶边界分桶 → 每桶单独统计 Count 和 HLL NDV
```

每个桶维护以下状态：

```rust title="KllBucketStats 结构"
struct KllBucketStats {
    routing_upper_bound: Datum,
    observed_lower_bound: Option<Datum>,
    observed_upper_bound: Option<Datum>,
    count: u64,
    ndv: MetaHLL,
}
```

第二遍扫描每读到一个值，就寻找第一个满足以下条件的桶：

```text title="分桶条件"
value <= bucket.routing_upper_bound
```

然后更新桶的行数和 NDV：

```rust title="更新桶统计"
self.count += 1;
self.ndv.add_object(original_value);
```

与此同时，Databend 还会更新该桶实际观察到的最小值和最大值。最终桶 NDV 来自：

```rust title="桶 NDV"
bucket.ndv.count()
```

`kll_full` 用额外一次扫描换取更准确的桶级统计，但由于扫描和分桶本身仍有成本，它的执行时间不一定比传统 `window` 方案短。

![kll_full 处理流程](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/kll-full-process.png)

## 等值谓词与桶内 NDV

继续使用 `salary` 示例，并为每个桶加入 NDV：

![salary 示例加入桶内 NDV](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/salary-ndv.png)

对于等值谓词：

```sql title="等值谓词查询"
SELECT *
FROM employee
WHERE salary = 4500;
```

4500 位于 B3。B3 包含 250 行和 150 个不同值。假设桶内数据均匀分布：

```text title="等值估计（B3）"
Estimated Rows = Bucket Rows / Bucket NDV
               = 250 / 150
               ≈ 1.67
```

再看另一个查询：

```sql title="另一个等值谓词"
SELECT *
FROM employee
WHERE salary = 1500;
```

1500 位于 B1：

```text title="等值估计（B1）"
Estimated Rows = 250 / 50
               = 5
```

虽然 B1 和 B3 的行数相同，但不同的 NDV 会产生不同的平均频率：

![不同 NDV 产生不同平均频率](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/average-frequency.png)

因此，范围谓词主要依靠桶边界和覆盖比例；等值谓词则更依赖桶内 NDV。KLL 很适合描述整体值域和分位点，但仅靠 KLL 与 NDV 仍无法识别桶内的热点值。

![范围谓词 vs 等值谓词的依赖差异](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/range-vs-eq.png)

## KLL 三方案 Benchmark

下面比较传统 `window`、`kll_fast` 和 `kll_full` 三种方案。q-error 越接近 1，说明估计结果越接近真实值。

![window / kll_fast / kll_full 三方案对比](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/kll-comparison.png)

结果体现出三个清晰的取舍：

1. **kll_fast 显著缩短了 ANALYZE 时间。** 在 1M 和 5M 数据集上，它分别约为 `window` 耗时的 20.5% 和 16.8%，同时明显降低内存增量。
2. **kll_fast 对范围谓词较稳定，但不适合单独承担等值估计。** 两组测试中的 Range q-error geomean 分别为 1.111 和 1.135，而 Eq q-error geomean 上升到 5.236 和 6.833。
3. **kll_full 改善了整体和等值估计精度，但时间优势并不成立。** 它的内存增量低于 `window`，范围估计几乎保持准确；不过第二次扫描使其耗时略高于 `window`，极端等值谓词仍可能存在明显误差。

这说明 KLL 解决的是直方图构建的资源问题，而不是所有数据倾斜问题。要准确处理高频值，还需要 Top-N 和 CMS。

![KLL 的能力边界](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/kll-limit.png)

## Top-N：精确保存突出热点

Top-N 用于保存单列中出现频率最高的一组值及其对应行数。与在全表层面一次性计算不同，Databend 采用分层采集和合并：

![Top-N 分层采集与合并](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/topn-hierarchical.png)

Block 级 Top-N 会保存在 Segment Statistics 中，可在增量 ANALYZE 时复用，避免每次重新扫描所有历史数据。

当等值谓词命中 Top-N 时，优化器可以直接使用记录的频率，避开"桶内均匀分布"这一假设。它对少量、稳定且非常突出的热点尤其有效。

Top-N 的边界也很明确：可保存的值数量有限。如果热点值很多、频率分布较宽，一些实际高频值可能被截断在 Top-N 之外。

![Top-N 的容量边界](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/topn-boundary.png)

## Count-Min Sketch：覆盖宽热点

Count-Min Sketch（CMS）是一种估计元素频率的概率数据结构。它使用多个 Hash 函数将输入值映射到二维计数器数组：

```text title="CMS 写入"
hash(value, row0) → counter++
hash(value, row1) → counter++
...
hash(value, row4) → counter++
```

查询某个值的频率时，CMS 取多个计数器中的最小值：

```text title="CMS 查询"
estimate(value) = min(counter[hash_i(value)])
```

因为 Hash 冲突只会让计数增大，所以 CMS 给出的是带上界偏差的近似频率。它使用固定空间，且和 KLL 一样支持分布式合并：

![CMS 结构与分布式合并](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/cms-hash.png)

相比 Top-N，CMS 能覆盖更广的值集合，尤其适合"热点数量超过 Top-N 容量"的场景；代价是结果不再完全精确，并且需要控制 Hash 冲突产生的噪声。

![CMS vs Top-N 覆盖范围对比](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/cms-vs-topn.png)

## 分层估计策略

Databend 对等值谓词采用分层的估计策略：

![等值谓词分层估计策略](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/layered-strategy.png)

CMS 不会无条件覆盖普通估计。优化器首先计算：

```text title="CMS 触发条件计算"
lower_count  = cms_estimate - cms_error_bound
average_count = non_null_rows / NDV
```

只有满足以下条件时：

```text title="CMS 采用条件"
lower_count > average_count
```

优化器才认为该值确实比平均频率高，并采用 CMS 结果。对于普通低频值，仍然使用常规 NDV 或直方图估算，从而避免 CMS 的碰撞噪声放大误差。

这一组合背后的思路是：

- KLL 描述整体值域与分位点；
- Top-N 精确保存最突出的热点；
- CMS 覆盖 Top-N 容量之外的宽热点；
- NDV 和直方图继续处理普通值。

![三者组合的分工思路](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/combination.png)

## Benchmark：Top-N 与 CMS 的收益

测试数据包含 100 万行、10 万 NDV，Top-N 大小为 50，CMS 错误率为 0.001。`wide_hot_key` 的一半数据分布在 200 个热点值上，因此 Top-N 无法保存所有热点，而 CMS 仍可以估算它们的频率。

以下结果为三次重复实验的中位数和范围。

### ANALYZE 开销

![ANALYZE 开销对比](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/analyze-cost.png)

启用 Top-N 或 CMS 会增加统计收集时间与内存，但整体开销仍处于亚秒级。是否值得承担这部分成本，需要结合等值过滤在真实工作负载中的重要程度判断。

### 全部等值谓词的 q-error

![全部等值谓词 q-error](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/eq-qerror.png)

仅使用普通统计信息时，等值谓词 q-error 的几何平均值为 25.354；启用 CMS 后下降到 1.355，P90 从 2006.822 降至 2.5。Top-N 能明显改善最突出的热点，但面对更宽的热点集合，CMS 的覆盖更完整。

### wide_hot_key 的 q-error

![wide_hot_key 的 q-error](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/wide-hotkey-qerror.png)

以代表性的 `wide_hot_key = 0` 为例，真实结果为 2500 行：

![wide_hot_key = 0 示例](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/wide-hotkey-0.png)

这个结果揭示了 Top-N 的容量限制：当 200 个热点竞争 50 个位置时，某些热点会被漏掉；CMS 虽然是近似估计，却能把结果从 10 行修正到接近真实值的 2716 行。

![结果对比与揭示](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/result-reveal.png)

没有一种统计方式能同时取得最低开销和最高精度。更合理的选择取决于查询模式与数据分布。

![不同统计方式的取舍](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/tradeoff.png)

## 总结

在 Databend 中，这些概率数据结构的价值不只是让 ANALYZE 更快，而是帮助优化器用有限资源建立足够可靠的数据画像。对于存储在对象存储中的大规模数据，降低统计收集的扫描、排序和内存成本，能够减少后台维护对前台查询的影响，也让计算资源的使用更加可控。

![总结](/vibe-reading/images/articles/databend-official-kll-topn-cms-cardinality-estimation/summary.png)

KLL、Top-N 和 CMS 分别解决了基数估计中的三个不同问题：

- **KLL** 以一次扫描和可合并 Sketch 近似分位点，降低等深直方图构建的排序与内存开销。
- **Top-N** 精确记录最常见值，修正直方图对突出热点的估计。
- **CMS** 用固定空间覆盖更宽的热点集合，弥补 Top-N 容量有限的问题。

Benchmark 也说明了它们的边界：`kll_fast` 适合快速、低内存地生成范围统计，但单独用于等值估计时误差较大；`kll_full` 提高了桶级精度，却不一定缩短执行时间；CMS 则能以有限的额外开销显著改善宽热点数据的等值估计。

对 Databend 这样的云原生分析数据库而言，优化器统计不是一个孤立的内核功能。更低的 ANALYZE 成本、更准确的基数估计和更稳定的执行计划，最终都会反映到大规模分析的查询性能、资源效率与成本可预测性上。
