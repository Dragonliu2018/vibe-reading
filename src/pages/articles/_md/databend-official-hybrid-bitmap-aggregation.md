---
title: "小 Bitmap，大优化：Databend 如何加速大规模集合聚合？"
source:
  type: "article"
  project: "Databend"
  url: "https://mp.weixin.qq.com/s/7iRP_dPH7-elvyPOkg4D4g"
  author: "Databend"
  site: "Databend 微信公众号"
date: "2026-07-30T17:30:00+08:00"
category: [Database, Databend, Official]
tags: ["Databend", "Bitmap", "Roaring Bitmap", "HybridBitmap", "SmallBitmap", "RoaringTreemap", "聚合优化"]
description: "Databend 引入 HybridBitmap：小集合阶段用轻量 SmallBitmap，仅在集合真正膨胀后切换到 RoaringTreemap，避免大量小 bitmap 被过早反序列化为完整大集合结构，bitmap_intersect、bitmap_union 等聚合函数获显著性能提升。"
readingTime: "7 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [小 Bitmap，大优化：Databend 如何加速大规模集合聚合？](https://mp.weixin.qq.com/s/7iRP_dPH7-elvyPOkg4D4g) · **作者** Databend · **来源** Databend 微信公众号 · **原文发布** 2026-07-07 · **转载** 2026-07-30

---

导读：本文介绍 Databend 针对 Bitmap 聚合场景的一次性能优化：通过引入 HybridBitmap，在小集合阶段使用轻量的 SmallBitmap，只在集合真正膨胀后切换到 RoaringTreemap，避免大量小 bitmap 被过早反序列化和构造成完整大集合结构。Benchmark 显示，在大量小 bitmap 聚合场景下，`bitmap_intersect`、`bitmap_union` 等函数获得了显著性能提升。阅读时间约 6-8 分钟。

## 典型场景：大量小 Bitmap 参与聚合

Bitmap 函数在 SQL 数据库中常用于高效表示和加速集合计算，广泛应用于海量数据下的高维过滤与精确去重场景。目前，Databend 已支持丰富的 bitmap 计算函数，具体用法可参考产品文档：https://docs.databend.cn

在分布式聚合场景中，Bitmap 的经典链路为：从大量行中读取较小的 bitmap，并对它们做聚合计算，随着聚合层级向上递增，最终汇聚并输出一个包含完整交并集信息的大 Bitmap。例如：

```sql title="bitmap_intersect 示例"
SELECT bitmap_intersect(user_tags)
FROM events
WHERE dt = '...';
```

在优化前，这类查询的执行路径通常可以简化为：

```text title="优化前的执行路径"
row bytes -> deserialize RoaringTreemap -> aggregate state operate -> result
```

这个流程里有两个明显的成本点：

- bitmap 主要以 bytes 形式存储。如果涉及大量行的计算，每行 bitmap 都反序列化为完整结构，会让读取和构造成本被行数放大。对于元素数量很少的 bitmap，更理想的方式是尽量直接基于 bytes 或轻量结构完成计算。
- 两个 bitmap 进行计算时，需要尽可能复用已有结构，避免每次计算都重新构建 bitmap，否则会产生大量内存分配和临时对象成本。

## 适合哪些 Databend 查询场景

这类优化尤其适合以下 Databend 使用场景：

- 用户标签圈选：对不同标签人群做 `bitmap_intersect` / `bitmap_union`；
- 行为分析：计算访问、点击、购买等事件集合；
- 漏斗分析：按步骤求用户集合交集；
- 权限或资源集合计算：快速判断集合包含关系；
- 大规模低基数聚合：大量行内小 bitmap 汇聚成一个结果 bitmap。

这些场景通常有一个共同特征：输入行数很大，但单行 bitmap 很小。如果每一行都构造成完整 RoaringTreemap，查询成本会被行数放大。HybridBitmap 的价值，就是让小 bitmap 尽量停留在轻量表示里，只在结果真正膨胀时再切换到 RoaringTreemap。

## HybridBitmap：小集合与大集合的分层表示

Bitmap 函数主要应用在聚合场景下，而这些场景经常伴随"大量行内小 bitmap → 聚合结果逐步变大"的数据形态。因此 Databend 的 Bitmap 使用两种结构混合表示：

- **SmallBitmap**：使用 smallvec 表示小集合，构造成本低。
- **RoaringTreemap**：使用 Roaring Bitmap 表示大集合，适合高基数集合的压缩和计算。

状态切换遵循简单规则：

```text title="状态切换规则"
SmallBitmap → 超过阈值 → RoaringTreemap
```

### SmallBitmap：降低小集合构造成本

SmallBitmap 使用一种特殊的 vec 结构表示：默认在元素数量较少时使用栈上空间；当超出阈值后，再转换为堆上动态存储。SmallBitmap 在修改时会通过 binary search 保证元素有序且唯一，从而保持与常规 bitmap 一致的集合语义。

由于 SmallBitmap 主要依赖栈上空间，在行内 bitmap 较小时，可以以极低成本完成反序列化和构造，从而提高大量小 bitmap 的读取效率。同时，在 `xor` 等中间结果可能变小的计算中，也可以尝试将大 bitmap 转回小 bitmap，减少后续物化成本。

### RoaringTreemap：承接大集合压缩与计算

RoaringTreemap 是一种压缩位图算法，广泛应用于 Spark、Hive、Lucene 等高性能计算框架。相关论文可参考：https://arxiv.org/pdf/1603.06549

压缩 bitmap 对数据库系统非常重要，否则行内 bitmap 较大时可能造成严重的读取和计算开销。虽然存在 Oracle BBC、WAH、EWAH 等成熟压缩位图格式，但这些格式不支持高效随机访问，计算交集时可能需要完整解压整个大 bitmap。

Roaring Bitmap 的特殊之处在于将数据分割为多个块，允许快速检查某个值是否存在，同时在许多场景下也能提供较好的计算性能和压缩比。当然，相对于 SmallBitmap 来说，它在低基数小集合上的构造成本仍然偏高。

基于这样的混合结构，可以在不同计算阶段选择不同表示。例如在大多数行内 bitmap 都较小的 `bitmap_intersect` 场景下：

- 读取行内 bitmap 时，尽量以 small bitmap 表示 bytes。
- 结果计算时，如果结果逐步膨胀，再切换为 RoaringTreemap。
- 当一侧是 RoaringTreemap、另一侧是 serialized small bitmap 时，尽量直接基于 small bitmap bytes 与 RoaringTreemap 做 intersect。

这样既能利用 SmallBitmap 降低大量小 bitmap 的读取和构造成本，也能保留 RoaringTreemap 在大集合计算上的优势。

## 操作矩阵：不同状态下的计算路径

HybridBitmap 的核心思路不是替代 RoaringTreemap，而是在不同数据规模下选择不同计算路径，避免小 bitmap 过早承担完整 RoaringTreemap 的构造成本。

| 左侧状态 | 右侧状态 | 处理策略 |
| --- | --- | --- |
| Small | Small | 直接在有序 small vec 上做集合运算，避免构造 RoaringTreemap |
| Small | Large | 根据操作语义决定是否提升为 Large，例如 union/xor 可能需要膨胀，intersect/sub 可以优先保留小集合 |
| Large | Small | 遍历 small 集合，对 Large 做 contains、insert 或 remove 等局部操作 |
| Large | Large | 直接使用 RoaringTreemap 原生集合运算 |
| Large | serialized small | 尽量直接基于序列化 bytes 计算，减少将每行小 bitmap 完整反序列化为 RoaringTreemap 的成本 |

在聚合场景下，输入通常以 bytes 的形式从列中读取。对于大量行内小 bitmap，如果每一行都先反序列化成完整 RoaringTreemap，再参与聚合计算，实际成本会远高于集合本身的大小。

通过区分 small、large 和 serialized small 的计算路径，可以让小 bitmap 尽量停留在低成本表示中，只在结果真正膨胀时再切换到 RoaringTreemap。

## Benchmark：小 Bitmap 聚合性能提升

由于 PR 19041 前后的 benchmark 覆盖、函数命名和后续版本实现都有差异，这里只展示能够在两个版本之间复现和对齐的小 bitmap 聚合路径。其中 `bitmap_intersect` 使用 PR 19041 summary 中已有数据，`bitmap_union`、`bitmap_intersect_empty` 和 `bitmap_union_disjoint` 是基于相同思路在 PR 19041 前后本地补测的数据。

| Benchmark | PR 19041 前 median | PR 19041 后 median | 性能提升 |
| --- | --- | --- | --- |
| `bitmap_intersect/100000` | 15.27 ms | 4.729 ms | 69.0% |
| `bitmap_intersect/10000000` | 1.609 s | 533.1 ms | 66.9% |
| `bitmap_union/100000` | 19.67 ms | 7.628 ms | 61.2% |
| `bitmap_union/10000000` | 2.009 s | 831.9 ms | 58.6% |
| `bitmap_intersect_empty/100000` | 11.81 ms | 4.197 ms | 64.5% |
| `bitmap_intersect_empty/1000000` | 122.9 ms | 41.56 ms | 66.2% |
| `bitmap_union_disjoint/100000` | 36.61 ms | 7.236 ms | 80.2% |
| `bitmap_union_disjoint/1000000` | 345.5 ms | 84.98 ms | 75.4% |

这些结果覆盖了小 bitmap 交集、并集、快速收敛为空，以及互不相交并集持续膨胀的几类路径。收益最明显的是大量小 bitmap 参与聚合计算的场景。

优化前每行 bitmap 都需要反序列化为完整 RoaringTreemap，即使每行只有几个元素，也要承担较高的构造成本；优化后 SmallBitmap 可以直接以低成本结构表示，并在计算过程中减少完整 RoaringTreemap 的创建，因此能够显著降低 CPU 与内存分配开销。

## 适用边界：什么时候收益最明显

这些 benchmark 主要验证大量小 bitmap 聚合路径，不代表所有 bitmap 场景都有同等收益。当输入 bitmap 或中间结果很快膨胀为大 bitmap 时，性能瓶颈会重新回到 RoaringTreemap 的大集合运算。

因此，HybridBitmap 最适合的不是"所有 bitmap 计算"，而是输入数据中存在大量小集合、且聚合过程中结果逐步变化的场景。

## 总结：延迟支付大 Bitmap 的成本

Bitmap 聚合的性能瓶颈并不总是来自集合运算本身，很多时候来自"为了处理一个很小的集合，过早构造了一个完整的大集合结构"。在大量行内小 bitmap 参与聚合的场景下，每一行的反序列化、对象构造和内存分配都会被行数放大，最终成为查询执行中的主要成本。

HybridBitmap 的核心价值在于延迟支付 RoaringTreemap 的成本：当 bitmap 仍然很小时，使用 SmallBitmap 保持低构造、低分配的表示；当集合真正膨胀后，再切换到 RoaringTreemap，继续利用它在大集合压缩和集合运算上的优势。这个优化并不是替换 Roaring Bitmap，而是避免在不需要 Roaring Bitmap 的阶段过早使用它。

从 benchmark 结果看，收益最明显的是大量小 bitmap 聚合的场景，例如 `bitmap_intersect` 和 `bitmap_union`。当然，当输入 bitmap 或中间结果很快膨胀为大集合时，性能瓶颈会重新回到 RoaringTreemap 的大集合运算本身，优化收益也会趋于平缓。

也正因为如此，HybridBitmap 更像是对 bitmap 生命周期的分层建模：小集合用轻量结构承接，高基数集合交还给压缩位图处理。

对 Databend 来说，这类优化的意义不只是让某几个 bitmap 函数更快。在云数仓场景下，很多查询成本来自大量细小对象的重复构造、反序列化和内存分配。HybridBitmap 体现的是 Databend 一贯的优化方向：尽量让执行路径贴近真实 workload，在不牺牲通用性的前提下，减少不必要的数据结构转换和计算开销。

这最终会体现在用户能感知到的结果上：更低的 CPU 消耗、更少的内存分配、更稳定的聚合性能，以及在用户画像、标签分析、漏斗分析等场景中更好的 cost-performance。
