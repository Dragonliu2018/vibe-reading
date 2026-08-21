---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "查询引擎与处理流水线"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "查询引擎", "Sequence", "向量化", "表达式"]
description: "Druid 查询引擎——Query/QueryToolChest 策略体系、Aggregator onheap/offheap 双套、Expr 表达式引擎、FilterBundle 位图预过滤、Sequence/Yielder pull 与 Operator push 双流式模型。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（`processing/.../query/` 及 `java/util/common/guava/` 的流式基础）是 Druid 的**计算内核**：定义查询类型、聚合、过滤、表达式，以及贯穿全链路的惰性流式处理流水线。它面向 `ColumnSelectorFactory`（见 Segment 模块）编程——只通过选择器读列，不感知存储格式。职责边界：**给定一个 Query 和若干 Segment，产出惰性 Sequence<T>**。查询如何被服务、如何 fan-out 属于服务运行时模块；SQL 如何翻译为 Query 属于 Druid SQL 模块。

## 模块架构

```
Query<T>  ──getRunner(walker)──>  QueryRunner<T>
   │                                   ▲
   ├─ QueryToolChest (per-type 策略)    │ createRunner(segment) / mergeRunners
   │   mergeResults / createMergeFn     │
   │                                   │
   ├─ AggregatorFactory ─> Aggregator / BufferAggregator   (聚合)
   ├─ Filter ─> FilterBundle (bitmap 预过滤 + value matcher)
   ├─ Expr / ExprEval / ExprMacroTable                   (表达式)
   │
   └─ Sequence<T> / Yielder (pull)  ◄── Operator / RowsAndColumns (push)
```

查询以 `Query` 为根，每类查询由一组 `QueryToolChest`（Broker 侧重并/merge）与 `QueryRunnerFactory`（Historical 侧 createRunner/mergeRunners）策略支撑；聚合、过滤、表达式作为可组合的算子注入；最终结果统一落到 `Sequence<T>`——这套流水线既支持 pull 式 `Sequence`/`Yielder`，也支持 37 版引入的 push 式 `Operator`/`RowsAndColumns`，二者经 `OperatorSequence` 适配。

## 调用链路

以 GroupBy 为例，从 `Query.run` 到 `Sequence`：

```
QueryPlus.run(QuerySegmentWalker walker, ResponseContext)
  → BaseQuery.getRunner(walker)                  [BaseQuery.java:108]
  → spec.lookup(query, walker)                    # MultipleIntervalSegmentSpec
  → walker.getQueryRunnerForIntervals(query, intervals)
  → QueryRunner.run(QueryPlus, ResponseContext) → Sequence<T>
      [Historical] QueryRunnerFactory.createRunner(segment) → per-segment runner
        → toolChest.filterSegments / SegmentPruner 裁剪
        → ColumnSelectorFactory 取列 → Aggregator.aggregate（热循环）
      → factory.mergeRunners(pool, runners) → ChainedExecutionQueryRunner
      → toolChest.mergeResults(mergedRunner) → ResultMergeQueryRunner → CombiningSequence
  → accumulate(init, accumulator) 驱动整条链路求值
```

`Sequence` 采用**控制反转**：不暴露 Iterator，而接受 `Accumulator`（急切 `accumulate`）或 `Yielder`（惰性 `toYielder`）。`MergeSequence` 的 N 路惰性合并用 `PriorityQueue<Yielder<T>>`——每次取队首最小、`yielder.next()` 前进后放回；`CombiningSequence` 用 `CombiningYieldingAccumulator` 惰性合并相邻相等元素。整套设计保证结果**流式产出**，不被全部物化。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Query.getRunner(walker)` | 取查询执行器 | 经 spec 间接解耦 interval 选择 |
| `QueryToolChest.mergeResults` | Broker 侧合并 runner | 装饰器链 preMerge→merge→postMerge |
| `QueryRunnerFactory.createRunner(segment)` | per-segment 执行器 | 策略 per query type |
| `Aggregator.aggregate()` | 单行聚合 | `@CalledFromHotLoop` 热循环 |
| `Sequence.accumulate(init, acc)` | 急切消费 | 控制反转，不暴露 Iterator |
| `Yielder.next(init)` | continuation 前进 | 惰性，可中途停止 |
| `Filter.makeFilterBundle` | 组装 bitmap+matcher | 短路优化 |

</details>

## 核心实现

### Query / QueryToolChest / QueryRunnerFactory：策略体系

`Query<T>`（`query/Query.java`）是所有查询基类，关键方法 `getRunner(QuerySegmentWalker)`（`BaseQuery.java:108`）经 `QuerySegmentSpec.lookup` 间接拿到 runner，把 interval 选择与执行解耦。每种查询类型配一组策略：`QueryToolChest`（Broker 侧提供 `mergeResults`/`createMergeFn`/`preMergeDecoration`，决定结果怎么合并）；`QueryRunnerFactory`（Historical 侧 `createRunner(Segment)` 与 `mergeRunners(pool, runners)`，决定 per-segment 怎么跑、多 segment 怎么合）。这是典型的**策略 + 装饰器链**：`FluentQueryRunner`（`query/FluentQueryRunner.java`）以 builder 串联 `applyPreMergeDecoration→mergeResults→applyPostMergeDecoration→emitCPUTimeMetric→postProcess`，让缓存/指标/后处理能力叠加而不改核心 runner。内置查询类型（`timeseries`/`topn`/`groupby`/`scan`/`search`/`select`/`timeboundary`）各自实现这组策略。

### Aggregator 与 BufferAggregator：onheap/offheap 双套

`AggregatorFactory`（god node 434）是聚合的工厂抽象，`factorize(ColumnSelectorFactory)` 创建 `Aggregator`（onheap，对象持有中间值）或 `factorizeBuffered` 创建 `BufferAggregator`（offheap，写到 `ByteBuffer`，按 offset 存中间值）。双套设计让 Druid 可在堆外聚合大基数 groupBy 而不压 GC——`OnheapAggregate` 用对象、`BufferAggregator` 用直接内存。聚合循环 `Aggregator.aggregate()` 标 `@CalledFromHotLoop`，与 `DimensionSelector.getRow()` 配合做 JIT 单态化。

### 表达式引擎：Expr / ExprEval / ExprMacroTable

表达式引擎（god nodes `Expr`=781、`ExprEval`=405、`ExpressionType`=436、`ExprVectorProcessor`=244）是 Druid 复杂度最高的子系统之一，贯穿 SQL 转换、虚拟列、过滤、后聚合。`Expr` 是表达式 AST/求值抽象，`ExprEval` 是求值结果（值 + `ExpressionType`），`ExprMacroTable`（`query/expression/ExprMacroTable.java` L44-109）是函数注册表：内置函数在 `BuiltInExprMacros` 定义，扩展包经 Guice multibinding 注入自定义 `ExprMacro`；`ExprMacro.apply(List<Expr> args)` 返回一个 `Expr` 节点。Parser 解析函数调用时先查 `ExprMacroTable.get(name, args)`，未命中再查内置 `Function` 枚举。表达式与向量化结合由 `ExprVectorProcessor` 承接，`ExpressionPlanner`（`segment/virtual/ExpressionPlanner.java`）做输入分析与可向量化检查，`ExpressionSelectors` 是表达式引擎与列选择器的桥接。

### Filter 与 FilterBundle：位图预过滤 + 逐行兜底

37 版的 `Filter`（`query/filter/Filter.java` L66-113）引入 `makeFilterBundle`，把 bitmap index 加速与 value matcher 组合为统一的 `FilterBundle`：Filter **先尝试** `getBitmapColumnIndex` 做位图预过滤（O(1)/row，直接定位匹配行号集），**剩余**无法用索引解决的行再经 `makeMatcher`/`makeVectorMatcher` 逐行/向量化匹配。`makeFilterBundle` 接收 `applyRowCount`（前序 filter 已过滤后的行数上界），实现 AND/OR 短路优化——前序已缩小行数时后续 filter 代价下降。这套设计让 Druid 在有 bitmap 索引时近乎跳过不匹配行，无索引时退化到逐行/向量化扫描。

### Sequence/Yielder（pull）与 Operator（push）双流式模型

Druid 原生流式抽象是 pull 式 `Sequence`/`Yielder`（`java/util/common/guava/`）：`Sequence.accumulate(init, acc)` 由消费方驱动，`Yielder` 是 continuation 链（`get`/`next`/`isDone`/`close`）。37 版引入 push 式 `Operator` 框架（`query/operator/Operator.java`）：`Operator.goOrContinue(continuation, receiver)` 主动 `Receiver.push(RowsAndColumns)`，生产者驱动。`RowsAndColumns`（god node 229）是 Operator 的批量数据单元，经 `as(Class)`（如 `FramedOnHeapAggregatable`）暴露语义接口，与具体表示无关地调度优化。`OperatorSequence` 作适配器把 `Operator` 包装成 `Sequence`，两套模型共存互补——Operator 框架目前主要用于 `WindowOperatorQuery` 与 join 场景，Sequence 仍是绝大多数查询的主路径。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `QueryToolChest`/`QueryRunnerFactory` per query type | 查询类型可独立扩展 |
| 装饰器链 | `FluentQueryRunner`（cache→merge→metrics） | 查询能力叠加不改核心 |
| 控制反转 | `Sequence`/`Yielder` | 全链路不物化、背压自然 |
| Push/Pull 互补 | `Operator`/`OperatorSequence` | 窗口/join 需生产者驱动 |
| 策略（聚合） | `Aggregator`/`BufferAggregator` | onheap/offheap 可选 |
| 能力查询 | `RowsAndColumns.as(Class)` | 与表示无关的优化调度 |

## 模块间交互

本模块 import `segment/`（`ColumnSelectorFactory`、`DimensionSelector`、`ColumnCapabilities`、`BaseColumn`）读列，`collections/`（`ImmutableBitmap` 供 Filter 索引）。被 `server/` 的 `QueryLifecycle`/`ServerManager`/`ClientQuerySegmentWalker` 调用执行查询，被 `sql/` 的 `DruidQuery.computeQuery` 构造 native query 实例，被 `multi-stage-query/` 的 frame 处理器复用 operator/sequence 抽象。

## 扩展方式

- **新增查询类型**：实现 `Query` 子类 + `QueryToolChest` + `QueryRunnerFactory`，`@JsonSubTypes` 注册，Guice 绑定 factory；关键函数 `QueryRunnerFactory.createRunner(Segment)`。
- **新增聚合器**：实现 `AggregatorFactory`（`factorize`/`factorizeBuffered`）+ `Aggregator`/`BufferAggregator`，`@JsonSubTypes` 注册；参考 `query/aggregation/` 现有实现。
- **新增表达式函数**：实现 `ExprMacro`（`apply(List<Expr>)` 返回 `Expr`），注册到 `ExprMacroTable`（内置加 `BuiltInExprMacros`，扩展经 Guice multibinding）；向量路径实现 `ExprVectorProcessor`。

> 表达式引擎（`Expr`/`ExprEval`/`ExpressionType`/`ExprVectorProcessor`）复杂度足以单开深度解读，本文聚焦其与查询流水线的接口角色，内部求值/类型推导/向量化细节可在源码 `query/expression/` 进一步展开。
