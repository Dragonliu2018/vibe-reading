---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "执行引擎 Operator"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "拉模型", "向量化", "哈希聚合"]
description: "Trino 483 执行引擎：Driver 拉模型流水线、Operator 四方法契约、FlatGroupByHash 与 DirectExchangeClient"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

这里是数据真正被处理的地方：**Driver 驱动一组 Operator 的拉模型流水线处理 Page**。124K 行覆盖扫描/过滤/投影/聚合/join/窗口/exchange/排序/TopN/unnest 全部算子，加上两套聚合哈希表、哈希 join 的 build/probe 协作、跨机数据拉取客户端。设计基调：**Page 列式批处理 + 拉模型 + future 表达阻塞**——三者合力让极少量线程跑海量 driver。

## 模块架构

根包是 Driver 体系与通用算子；子包按算子族划分：`aggregation/`（229 文件）、`scalar/`（261 文件——内置函数的注解实现）、`join/`、`window/`、`exchange/`、`output/`、`project/`、`table/`、`unnest/`、`index/`。算子有两代形态：经典 `Operator`（状态机式）与新式 `WorkProcessorOperator`（惰性变换链），由 `WorkProcessorOperatorAdapter` 互相适配——FilterAndProject 与非溢出 lookup join 已迁移到新形态。

## 调用链路

```
SqlTaskExecution（execution 包）
 └─ 每 split 一个 DriverSplitRunner implements SplitRunner
     └─ processFor(Duration) → driver.processForDuration
         └─ Driver.process(maxRuntime, maxIterations)
             ├─ tryWithLock(100ms) 拿 DriverLock（单线程进算子保证）
             ├─ DriverYieldSignal.setWithDelay(maxRuntime, executor)
             │   （时间片到期置 yield 标志；长循环算子轮询 isSet() 主动让出）
             └─ 循环 processInternal：
                 ├─ handleMemoryRevoke()（spill 协作点）
                 ├─ processNewSources()（消费暂存 split 指派）
                 ├─ 自根向叶两两推进：
                 │   if (current 未 finished && next 未 blocked && next.needsInput())
                 │       page = current.getOutput(); next.addInput(page);
                 │   current.isFinished() → next.finish()
                 │   头部算子全部完成 → close 并从 activeOperators 摘除
                 └─ 本轮没搬动 Page → 收集 blocked future（revoking /
                     isBlocked() / isWaitingForMemory / isWaitingForRevocableMemory）
                     合并成 firstFinishedFuture 返回 → Driver 挂起等唤醒
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `processForDuration` in Driver.java | 一个时间片的处理 | blocked 用 future 不占线程 |
| `processInternal` in Driver.java | 算子链两两推进 | 自根向叶——拉模型的落点 |
| `getOutput` / `needsInput` / `addInput` / `finish` in Operator.java | 四方法契约 | 无数据返回 null，非阻塞 |
| `startMemoryRevoke` in Operator.java | spill 前回收内存 | 默认空实现，可 spill 算子覆写 |
| `pollPage` in DirectExchangeClient.java | 从上游拉一页 | token 游标 + ack 确认 |

</details>

## 核心实现

### Operator 接口：四方法契约

```java title="operator/Operator.java"
public interface Operator extends AutoCloseable {
    ListenableFuture<Void> NOT_BLOCKED = immediateVoidFuture();
    OperatorContext getOperatorContext();
    default ListenableFuture<Void> isBlocked() { return NOT_BLOCKED; }
    boolean needsInput();
    void addInput(Page page);      // 仅在 needsInput()==true 时被调
    Page getOutput();              // 无数据时返回 null
    default ListenableFuture<Void> startMemoryRevoke();  // spill 前回收
    default void finishMemoryRevoke();
    void finish();                 // 通知无更多输入
    boolean isFinished();
}
```

每个算子一工厂（`OperatorFactory.createOperator/noMoreOperators/duplicate`），`DriverFactory.createDriver` 顺序组装。Page 在算子间"拉一下、吐一页"流转；算子没数据就返回 null，等待数据就返回 blocked future——**驱动线程从不空转**。

### FlatGroupByHash：把哈希表压成连续字节

聚合哈希表有两套：`BigintGroupByHash`（`long[] valuesByGroupId`，仅单 BIGINT key 特例）与通用的 `FlatGroupByHash`（+`FlatHash`）。Flat 的记录布局是 `[可选 8B hash][可选变长指针][定长值 flat 排布]`：`fixedSizeRecords` 按 1024 条一组连续 byte[]，`control` 字节存 hash 前缀，`match(vector,…)` 用 8 字节 LITTLE_ENDIAN 视图一次比对 8 桶（SwissTable 风格 SIMD 思路）；变长数据集中在 `AppendOnlyVariableWidthData`。对比旧式"每列一个 Block 对象"的布局：flat 把对象头开销和多列指针追踪全部消掉，cache 命中率与向量化 probe 友好度质变。

聚合的 accumulator 体系：`AccumulatorFactory` 产出 `Accumulator/GroupedAccumulator`，`Aggregator` 按 `Step`（partial/final）包装并套 `AggregationMask`（过滤已删行）。注解入口 `aggregation/AggregationFromAnnotationsParser`。

### 哈希 join：build/probe 两阶段 + 动态过滤

`join/nonspilling/HashBuilderOperator`（build 侧）：`JoinBridgeManager<PartitionedLookupSourceFactory>` 跨 Driver 共享（build 并行分片，`partitionIndex++`），`IsolatedClass` 特化加速。probe 侧 `LookupJoinOperator`：`waitForBuild` 时 `pages.blocking(lookupSourceFuture)`——probe 等 build 完成不占线程。**动态过滤**是这对搭档的杀手锏：`DynamicFilterSourceOperator`（根包）作为 build 侧 pass-through 管道，把值集合/min-max 收集进 `DynamicFilterSourceConsumer`，运行时反哺 probe 侧 TableScan 的谓词——broadcast join 的 build 集合在扫描前就变成过滤条件，砍掉 probe 侧 IO。

### DirectExchangeClient：拉取 + 反压

```java title="operator/DirectExchangeClient.java（节选）"
Map<URI, HttpPageBufferClient> allClients;    // 每上游 task 一个 client
DirectExchangeBuffer buffer;                   // Streaming(内存) / Deduplicating(可落盘)
public void addLocation(TaskId taskId, URI location);
public WorkProcessor<Slice> pages();
```

`HttpPageBufferClient` 发 `GET {location}/{token}` 带 `TRINO_MAX_SIZE_HEADER` 限响应大小，响应带 nextToken 游标，`DELETE .../acknowledge` 确认。**反压天然成立**：`scheduleRequestIfNecessary()` 只在 buffer 有余量时才发新请求——消费速度经 buffer 占用自然传导到上游 OutputBuffer，不需要任何服务端推送协议。worker 端点即 `TaskResource.getResults`（GET `/v1/task/{taskId}/results/{bufferId}/{token}`，TRINO_PAGES 二进制）。

### spill：revocable memory 的协作点

可 spill 算子用 `operatorContext.localRevocableMemoryContext()` 记账；内存池超限时 `OperatorContext.requestMemoryRevoking()` → listener 置 `driverBlockedFuture` 完成 → 下个 tick `handleMemoryRevoke()` 调 `operator.startMemoryRevoke()`（如 `HashAggregationOperator` 委托 aggregationBuilder 用 `SpillerFactory` 造 `Spiller.spill(Iterator<Page>)` 落盘）→ `finishMemoryRevoke()` 复位。模板参照 `OrderByOperator` / `SpillableHashAggregationBuilder` / `WindowOperator`（均含 spillEnabled 分支）。

### scalar/：261 个文件是什么

确认为**内置标量函数的注解实现**：`BitwiseFunctions.java` 的 `@ScalarFunction public static long bitCount(@SqlType(BIGINT) long, …)`、`MathFunctions` 等。注解被 `ScalarFromAnnotationsParser` 解析为函数元数据，经 `SystemFunctionBundle` 注册进 `GlobalFunctionCatalog`（链路见[元数据与类型系统](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/08-metadata-types)）——**加一个内置函数 = 写一个注解静态方法**，零框架代码。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Factory | `OperatorFactory` 每算子一工厂，`duplicate()` 支持多实例 | Driver 复制的蓝图 |
| 拉模型 pipeline | Driver 自根向叶要数据 | 对比 push 火山迭代器：反压天然、阻塞不占线程 |
| 适配器 | `WorkProcessorOperatorAdapter` | 新旧两代算子共存过渡 |
| 组合 | `WorkProcessor<Page>` 惰性变换链（flatMap/transformProcessor/blocking） | 新式算子用函数组合表达 |

## 模块间交互

- **输入**：`TableScanOperator.getOutput` 经 `PageSourceProvider.createPageSource(...)` 惰性创建 SPI 的 `ConnectorPageSource`，逐页 `getNextSourcePage()`（见[SPI 与连接器框架](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/07-spi-connector-framework)）；`ScanFilterAndProjectOperator` 把 scan+filter+project 融合为一个算子减少物化；
- **输出**：`operator/output/PartitionedOutputOperator` + `PagePartitioner` 写入 `execution.buffer.OutputBuffer`（见[查询与任务生命周期](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/03-query-lifecycle)）；
- **驱动**：`SqlTaskExecution` ↔ `TaskExecutor`（TimeSharingTaskExecutor 以 `SPLIT_RUN_QUANTA = 1s` 时间片调 `split.processFor`，耗时上报 MultilevelSplitQueue 做多级优先级；483 默认 ThreadPerDriverTaskExecutor）；
- **窗口/unnest 补充**：`WindowOperator` 按 `partitionChannels`+`sortChannels` 分组排序，`preSortedChannelPrefix` 利用上游已排序前缀走 `mergeSortedPages`；`unnest/UnnestOperator` 用 `ArrayUnnester/MapUnnester` 展开数组/映射列。

## 扩展方式

**新增物理算子**：实现 `OperatorFactory`+`Operator`（或新式 `WorkProcessorOperatorFactory`）→ `LocalExecutionPlanner.java` 的 visitXxx 加映射 → `OperatorTestHarness`/`AbstractTestOperator` 测试。

**新增内置标量函数**：`operator/scalar/` 写 `@ScalarFunction` + `@SqlType` 注解的静态方法（仿 `BitwiseFunctions`）→ `SystemFunctionBundle` builder 加 `.scalars(XxxFunctions.class)`。

**给算子加 spill**：工厂注入 `SpillerFactory`；用 revocable 记账 + 实现 `startMemoryRevoke/finishMemoryRevoke`（参照 `HashAggregationOperator`）。
