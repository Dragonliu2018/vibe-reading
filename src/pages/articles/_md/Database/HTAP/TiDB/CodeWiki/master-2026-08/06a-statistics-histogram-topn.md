---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "直方图与 TopN 构建"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "统计信息"]
description: "TiDB 统计信息深度解读：SortedBuilder 桶合并策略、LocateBucket/EqualRowCount 估算公式、TopN 入选阈值与 FMSketch NDV"
readingTime: "15 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回统计信息](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/06-statistics)

---

## 主题定位

[06-statistics](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/06-statistics) 讲了直方图 + TopN 双结构的**消费侧**（估算链的三级查找）。本附件补上**构建侧与估算公式**：SortedBuilder 如何从采样数据建桶、桶满后如何合并、LocateBucket 如何在成对存储的 Bounds 里定位值、EqualRowCount 的三个返回分支、TopN 的入选阈值，以及 FMSketch 的 NDV 公式。这些公式决定了估算误差的来源，是调优 `ANALYZE` 参数时真正需要理解的东西。

## 核心原理

### SortedBuilder：桶满即合并的构建算法

`SortedBuilder`（`pkg/statistics/builder.go`）按升序遍历采样值构建等深直方图，`Iterate` 是核心循环。两条关键规则：

1. **同值不跨桶**：值与当前桶上界相等（`cmp == 0`）时只 `Buckets[bucketIdx].Count++` 与 `Repeat++`，**即使已超 `valuesPerBucket` 也不新建桶**——保证一个值只存在于一个桶内，否则等值估算会跨桶重复计数。
2. **达到桶数上限后的归并**：桶满且 `bucketIdx+1 == numBuckets` 时，调 `b.hist.mergeBuckets(bucketIdx)` 把已有桶两两合并，然后 `valuesPerBucket *= 2`、`bucketIdx /= 2`——即"桶数触顶 → 加倍每桶容量 → 折半桶数"的自适应策略，代价是直方图精度退化一档而非构建失败。合并后需复查 `Count+1-lastNumber <= valuesPerBucket` 再决定收尾动作。

### LocateBucket 与 EqualRowCount：估算的数学

`Bounds` 里每桶存**成对**的上下界，所以 `LocateBucket`（`pkg/statistics/histogram.go`）用 `hg.Bounds.LowerBound(0, &value)` 定位后要 `bucketIdx = index / 2` 折算；超出末桶时返回 `exceed=true`（交给范围估算的溢出分支）。值恰好等于桶上界时返回 `matchLastValue=true`——这是最微妙的一步：**桶上界是闭的**，命中末值有精确的 `Repeat` 计数。

`EqualRowCount` 的三分支：

- `match`：直接返回 `float64(Buckets[bucketIdx].Repeat)`——桶上界的等值行数是精确值；
- `hasBucketNDV` 且桶内 `NDV > 1`：返回 `(BucketCount - Repeat) / (NDV - 1)`——桶内非上界值按"除上界外的行均摊到其余 NDV-1 个值"假设；
- 兜底：`NotNullCount() / NDV`（均匀假设），且 `matched=false`。

这三个分支的误差依次增大——TopN 命中（精确）→ 桶上界（精确）→ 桶内插值（近似）→ 全局均匀（最粗）。这就是估算链为什么把 TopN 查找放在最前。

### TopN 入选：为什么最多收 2×numTop 个

`newTopNHelper`（`pkg/statistics/cmsketch.go`）从采样值中挑 TopN，循环上界是 `actualNumTop < sampleNDV && actualNumTop < numTop*2`：

- 当已收满 `numTop` 个后，若下一个候选的计数 `cnt*3 < sorted[numTop-1].cnt*2`（即不足已入选最小值的 2/3），提前 break——**2/3 经验阈值**：低于它的高频值交给直方图覆盖，存进 TopN 只浪费内存；
- `cnt == 1` 的单例值直接 break——出现一次的值没有"高频"意义。

实际上限 `numTop*2` 的意义：边界模糊区（计数相近的候选群）最多多收一倍，防止最坏情况的排序空转。

### FMSketch：NDV 的对数空间估计

`FMSketch`（`pkg/statistics/fmsketch.go`）以 `(mask+1) * len(hashset)` 估算 NDV——`mask` 随插入推进而 `hashset` 收缩，乘积近似真值。`insertHashValue` 的降级：`(hashVal & mask) != 0` 直接跳过；hashset 超过 `MaxSketchSize=10000` 时 `mask = mask*2+1` 并用 `maps.DeleteFunc` 清掉不满足新掩码的元素——每降级一次空间减半、估计粒度翻倍。`MergeFMSketch` 合并时取两侧更大的 mask（更粗粒度）再逐个 insert。NDV 的作用：直方图桶内插值公式 `(BucketCount-Repeat)/(NDV-1)` 全靠它。

## 性能与权衡

- 采样带来的偏差由 TopN 部分对冲（高频值大概率被采到），长尾仍受采样率影响；
- `valuesPerBucket` 翻倍合并意味着"桶数参数给小了"不会报错，而是**静默降精度**——生产上 `ANALYZE ... WITH BUCKETS n` 应一次到位；
- `CMSketch.queryHashValue`（旧路径，StatsVer1）用 `noise = (count - table[i][j]) / (width-1)` 的逐格噪声消除取中位数组合，`considerDefVal` 时回落默认值——理解它主要是为了兼容存量统计。
