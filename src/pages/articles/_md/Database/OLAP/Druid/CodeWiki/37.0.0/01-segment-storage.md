---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "Segment 存储与列模型"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "列式存储", "Segment", "向量化"]
description: "Druid 数据内核——不可变列式 Segment 的元数据/读写双路径、IncrementalIndex 增量索引、ColumnSelectorFactory 列选择器桥、向量化与嵌套列、SegmentWriteOutMedium 写出策略。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块是 Druid 的**数据地基**：定义 Segment 的列式存储格式、列模型与选择器、实时增量索引，以及 segment 持久化/迁移的 SPI。它被几乎所有上层模块依赖（查询引擎经选择器读列、摄入经 IncrementalIndex 写列、Coordinator 调度 DataSegment），自身只依赖 `query/` 的少量抽象（DimensionSpec、AggregatorFactory）与 `data/input/` 的 InputRow。核心职责边界：**怎么把数据按列存起来、怎么按列高效读出来**，不含查询执行编排（见查询引擎模块）与节点服务（见服务运行时模块）。

## 模块架构

![Segment 列模型](/vibe-reading/images/articles/druid-internals/segment-format.svg)

模块围绕一个不可变 `DataSegment` 元数据展开，分**写**与**读**两条路径：写路径经 `Appenderator.add` 把行写入 `IncrementalIndex`（`ConcurrentSkipListMap` + 聚合器），达阈值后由 `IndexMerger` 持久化为 segment 文件；读路径经 `QueryableIndex` 取出 `ColumnHolder[]`，每个列以 `BaseColumn` 暴露**逐行**与**向量化**双 selector。`SegmentWriteOutMedium` 与一组 deep storage SPI 贯穿读写两端，是可插拔后端的契约边界。之所以这样切分，是因为 Druid 把"如何组织列数据"与"如何执行查询"解耦——选择器（`ColumnSelectorFactory`）是两者之间唯一的桥，查询引擎只面向选择器编程，无需感知存储格式。

## 调用链路

**写入**（`Appenderator.add` → `IncrementalIndex.add` → `addToFacts`）：

```
Appenderator.add(identifier, row, committer, allowIncrementalPersists)
  → IncrementalIndex.add(InputRow)                        [IncrementalIndex.java:466]
    → toIncrementalIndexRow(row)                          # 维度值编码 + 时间截断构造排序 key
    → OnheapIncrementalIndex.addToFacts(key, rowHolder)    [OnheapIncrementalIndex.java:229]
      → facts.getPriorIndex(key)                          # ConcurrentSkipListMap 查找
      → 命中: doAggregate(metrics, aggs, ...)             # 复用 Aggregator 聚合
      → 未命中: factorizeAggs → doAggregate → facts.putIfAbsent  # 插入新行
```

**读取**（`Segment.as(CursorFactory)` → 选择器）：

```
Segment.as(CursorFactory.class).makeCursorFactory(buildSpec)
  → QueryableIndexColumnSelectorFactory(virtualColumns, timeOrder, offset, columnSelector)
    → makeColumnValueSelector(columnName)                 [QueryableIndexColumnSelectorFactory.java:139]
      → columnHolder.getColumn() as BaseColumn
      → BaseColumn.makeColumnValueSelector(offset)       # 逐行（缓存到 valueSelectorCache）
      → 或 makeVectorValueSelector(vectorOffset)          # 向量化（默认抛 UOE，支持列覆写）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `DataSegment.overshadows(other)` | 判断本 segment 是否覆盖另一个 | 基于 version + partition range，免原子删除 |
| `IncrementalIndex.add(row)` | 写入一行 | 单线程写 + 并发读，`ConcurrentSkipListMap` 无锁 |
| `OnheapIncrementalIndex.canAppendRow()` | 检查行数/字节上限 | `maxBytesInMemory` 估算每 entry ~44B |
| `ColumnSelectorFactory.makeColumnValueSelector` | 创建列值选择器 | 缓存实例避免重复解压 |
| `BaseColumn.makeVectorValueSelector` | 批量向量化读 | 默认 UOE，渐进式支持新列类型 |
| `Appenderator.persistAll(committer)` | 持久化到本地磁盘 | 流摄入同时落 offset 快照 |
| `Appenderator.push(identifiers, committer)` | 合并并推 Deep Storage | `IndexMerger.merge` 后调 `DataSegmentPusher` |

</details>

## 核心实现

### DataSegment：不可变元数据 + 版本覆盖

`timeline/DataSegment.java` 是整个集群的 segment 元数据标准，实现 `Overshadowable<DataSegment>`。它不可变（所有 `with*` 返回新实例），属性含 `SegmentId id`、`loadSpec`、`shardSpec`、`dimensions/metrics`、`size`。两个关键设计：**字符串 intern 去重**（`prepareLoadSpec()` 用 `Interner`，因集群可能有数十万 segment 元数据，刻意省内存，并用 `Object2ObjectArrayMap` 替代 HashMap）；**版本覆盖**——`overshadows()` 基于 dataSource + interval overlap + version + partition range 判断覆盖，新数据"替换"旧数据时无需原子删除，旧 segment 在查询中被自然 overshadow、最终被 GC 式清理。`atomicUpdateGroupSize` 保证一组 partition 原子可见。

### IncrementalIndex 与 ConcurrentSkipListMap

`segment/incremental/IncrementalIndex.java` 是实时摄入的核心。`add(InputRow)` 把行转成 `IncrementalIndexRow`（时间截断 + 维度编码排序 key），再 `addToFacts`：命中已有 key 则 `Aggregator.aggregate`，未命中则 `factorizeAggs` 新建聚合器并 `putIfAbsent`。

`OnheapIncrementalIndex` 用 `ConcurrentSkipListMap` 作 `FactsHolder`，选它而非 HashMap 的理由是多方面的：**并发读写**（摄入写、查询经 `IncrementalIndexCursorFactory` 并发读，`putIfAbsent` 无锁）；**有序性**（key 有序，`persistIterable()` 直接输出有序数据到 segment，rollup 模式下 facts 已预排序，免额外排序）；**高效范围查询**（`timeRangeIterable` 用 `subMap` 做 O(log n)）；**内存估算**（`ROUGH_OVERHEAD_PER_MAP_ENTRY` 约 44B/entry，用于 `maxBytesInMemory` 限制）。非 rollup 模式则按时间分桶、桶内用 `ConcurrentLinkedDeque`。`FactsHolder` 还是个策略切换点——按 rollup/timePosition 选 `RollupFactsHolder`/`PlainTimeOrdered...`/`PlainNonTimeOrdered...`。

### ColumnSelectorFactory：存储与查询的唯一桥

`segment/ColumnSelectorFactory.java`（继承 `ColumnInspector`）是查询引擎与存储层之间的桥梁：`makeDimensionSelector(DimensionSpec)` 与 `makeColumnValueSelector(String)`。`ColumnInspector.getColumnCapabilities()` 让查询优化器在创建 selector **之前**就知道列的字典编码/排序/bitmap 等特性，从而选最优路径。`QueryableIndexColumnSelectorFactory`（历史 segment）会先查 virtualColumns 再查物理列，对数值列走 `ValueTypes.makeNumericWrappingDimensionSelector`，对字典编码列走 `DictionaryEncodedColumn.makeDimensionSelector`，对嵌套列走 `NestedColumnSelectorFactory`。它缓存 selector 实例（解压后的 buffer 复用），注释明确不能用 `computeIfAbsent`——virtual column 引用可能递归改 map 触发 `ConcurrentModificationException`。

`DimensionSelector` 继承 `HotLoopCallee`，`getRow()` 标 `@CalledFromHotLoop`，让 JIT 对聚合热循环做单态化内联；`IndexedInts getRow()` 返回的对象可复用，调用方不能缓存引用。

### BaseColumn 双路径与向量化

`segment/column/BaseColumn.java` 定义两个 selector 创建方法：`makeColumnValueSelector(ReadableOffset)`（逐行）与 `makeVectorValueSelector(ReadableVectorOffset)`（批量向量化，默认抛 `UnsupportedOperationException`）。`VectorColumnSelectorFactory` 提供 `makeSingleValueDimensionSelector`/`makeValueSelector` 等向量选择器。双路径设计让向量化查询（一次处理 512–4096 行，比逐行快 5–20×）与逐行回退共存——新列类型可先实现逐行，后续再加向量化，且 `Segment.as(Class)` 能力查询让扩展模块定义自己的列子类型而不污染核心。

### Capable 三态能力系统

`ColumnCapabilities` 用 `Capable` 枚举（`TRUE`/`FALSE`/`UNKNOWN`）而非 boolean。`ColumnCapabilitiesImpl` 的 `dictionaryValuesSorted`/`hasNulls` 等默认 `UNKNOWN` 且 `@JsonIgnore`（不持久化）。原因：摄入时某些能力未知（动态发现的列），但 segment 生成后可扫描确定；`UNKNOWN` 允许延迟决策，`snapshot()` 配合 `CoercionLogic` 在查询路径上强制解析为 true/false。`dictionaryValuesSorted` 不持久化是因为它能从字典数据运行时计算，避免 segment 格式变更。

### Nested Column：直接摄入 JSON

`nested/NestedDataColumnV5` 是 37 版嵌套列实现，统一标量/字典串/混合/嵌套 JSON 多种格式，支持按 JSON path 提取子字段（`NestedPathFinder.parseJsonPath`），带全局字典 + 字段级类型信息 + 前缀编码整数数组。它走专用序列化路径（`NestedCommonFormatColumnPartSerde`）而非旧 complex type 通用路径，解决了旧 complex 类型无法做 bitmap 索引、无法高效过滤的问题——让 JSON 直接摄入同时保持列式压缩与向量化优势。

### SegmentWriteOutMedium 与 deep storage SPI

`segment/writeout/SegmentWriteOutMedium.java` 有四实现（OnHeap/OffHeap/TmpFile/LegacyTmpFile）。`TmpFileSegmentWriteOutMedium` 用 `LazilyAllocatingHeapWriteOutBytes` 惰性分配：小数据用堆 buffer，超阈值切临时文件——因分析表明大量 `WriteOutBytes` 只存很少数据，惰性策略避免为它们建临时文件。deep storage SPI 在 `segment/loading/`：`DataSegmentPusher`（push 到 deep storage）、`DataSegmentMover`/`DataSegmentKiller`/`DataSegmentArchiver`、`SegmentizerFactory`（从磁盘加载生成 `Segment`），均标 `@ExtensionPoint`。`DataSegmentPusher.getDefaultStorageDir()` 定义的 `dataSource/interval/version/partitionNum/` 目录结构是跨实现的标准约定。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| SPI | `loading/*SPI`（`@ExtensionPoint`） | deep storage 可插拔，core 不膨胀 |
| 策略 | `SegmentWriteOutMediumFactory`、`FactsHolder` | 写出介质与 facts 存储可替换 |
| 工厂 | `ColumnSelectorFactory` | 屏蔽历史 segment 与增量索引差异 |
| 装饰器 | `CachingColumnSelectorFactory` | 缓存 selector 避免重复解压 |
| 能力查询（as()） | `Segment.as(Class)`、`SelectableColumn.as` | 扩展自定义列类型不污染核心接口 |
| 三态能力 | `ColumnCapabilities.Capable` | 延迟决策摄入时未知的能力 |

## 模块间交互

本模块 import `query/`（`DimensionSpec`、`ExtractionFn`、`AggregatorFactory`、`ValueMatcher`、`Filter`）、`query/monomorphicprocessing/`（`HotLoopCallee`/`@CalledFromHotLoop`）、`data/input/`（`InputRow`、`Committer`）、`collections/`（`ImmutableBitmap`）。被 `server/` 的 `StreamAppenderator`/`BatchAppenderator`/`Sink`/`FireHydrant` import（实时摄入管道），被 `indexing-service/` 的 `InputSourceSampler` import，`DataSegment` 被 `coordinator`/`overlord`/`indexing` 全局 import 作为 segment 元数据标准。`Segment` 接口经 `query/` 的 `QuerySegmentWalker` 间接被查询使用。

## 扩展方式

- **新增列类型**（如 decimal）：加 `ValueType`/`ColumnType` 枚举、新增 `BaseColumn` 子接口与 `serde` 实现、在 `IncrementalIndex.makeMetricColumnValueSelector` 与 `QueryableIndexColumnSelectorFactory.makeDimensionSelectorUndecorated` 加分支、改 `ColumnType.leastRestrictiveType` 处理类型兼容。
- **新增 deep storage**：在扩展 module 实现 `DataSegmentPusher`/`Killer`/`Mover`/`Archiver` + `LoadSpec`/`SegmentizerFactory`，遵守 `getDefaultStorageDir()` 目录约定，写 `DruidModule` 注册。
- **新增 nested 数据类型**：扩展 `NestedCommonFormatColumn`、`FieldTypeInfo`、序列化器与 `NestedColumnSelectorFactory.makeDimensionSelector` 的路径查询。
