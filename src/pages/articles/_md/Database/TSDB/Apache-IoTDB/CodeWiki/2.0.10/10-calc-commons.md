---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "计算公共层 calc-commons"
date: "2026-10-01T21:25:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "Trino", "代码生成", "查询优化", "freemarker"]
description: "Trino 血统的计算公共层：io.trino.matching 逐字 fork 的 Pattern 匹配 DSL、双轨 Accumulator 聚合框架、freemarker 生成 180 个类型特化算术 Transformer。"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

`iotdb-core/calc-commons`（`org.apache.iotdb.calc`，513 个 Java 文件 + 8 个 freemarker 模板 + 5 个 .tdd 数据模型）是表模型计算层中**与 IoTDB 数据面无关、可被多进程共享**的部分。它的来源有一段值得记录的考古：**不是"从 Trino 抽出的公共层"，而是"datanode 内的 Trino 血统代码被二次抽取成独立模块"**——第一阶段（IoTDB 1.3+ 引入表模型时）从 Presto/Trino 源码 copy-adapt 进 datanode；第二阶段（commit `89f855c777`，2026-04 PR #17526 "Refactor: extract shared table-model PlanNode and Operator code from datanode"）以 R100 内容零改动 rename 把 524 个文件整体搬入新建的 calc-commons。动机：datanode 是巨型模块，confignode/rest/integration-test 需要表模型抽象时不想背上整个 datanode。

Trino 血统有铁证：`calc/plan/relational/utils/matching/`（Pattern/Capture/Captures/Match/Property...）与 Trino 独立库 **io.trino.matching** 类名、方法签名、连 `Pattern.java` L55 的 `// FIXME make sure there's a proper toString` 注释都原样保留——逐字 fork 仅改包名。但执行模型被改造成 **pull 式 `next()/hasNext()`**（Trino 是 push 式 needsInput/addInput/getOutput），操作对象换成 IoTDB 自研 `TsBlock`（而非 Trino Page/slice）。

## 模块架构

![calc-commons 架构](/vibe-reading/images/articles/iotdb-2.0.10/calc-commons-architecture.svg)

依赖方向严格单向：calc-commons 只依赖 IoTDB 轻量层（tsfile、node-commons、service-rpc、udf-api、metrics-interface、guava/gson/lz4），**不依赖 datanode**。与 datanode 的分工：**calc-commons 承载"与存储无关的通用算子"**（process/join/fill/window/rowpattern + relational 算子），**datanode 承载"触碰 Region/TsFile 的数据源算子"**——前者用后者的 scan 算子作孩子拼成算子树。datanode queryengine 对本模块的 import 统计：`matching.Pattern` 74 处、`execution.operator.Operator` 68 处、`aggregation.Accumulator` 24 处等。

**为什么 fork 而非依赖 Trino jar**：(a) IoTDB 是嵌入式/单进程可部署的数据库，Trino 是重型分布式引擎，拉 jar 会拖进 airlift/slice/Guice 整套依赖树；(b) 数据容器被整体替换为 TsBlock/Column，Trino 的 Page/Block 体系无法直接复用；(c) 执行模型改 pull 式且需接自家内存管控与 metrics/i18n；(d) 只需要表模型子集而非整个 Trino 引擎。配套哲学是 vendored 外部库副本（`org.apache.tsfile.external.commons.*` 的 FileUtils/Validate/ComparatorChain）——"vendor-copy 而非引依赖"。

## 调用链路

### Pattern 匹配框架：给 CBO 规则用的声明式捕获 DSL

`Pattern<T>`：静态工厂 `any()/typeOf(Class)/empty()/nonEmpty()`；链式组合 `capturedAs(Capture)`（捕获子模式）、`matching(Predicate)`、`with(PropertyPattern)`（按属性约束）；`previous()` 链形成"先匹配前驱、再匹配自身"的装饰链；`match(Object, Captures, context)` 返回 `Stream<Match>`。消费方在 datanode 的 `relational/planner/iterative/`（IterativeOptimizer + 30+ 条规则）与 `planner/node/Patterns.java`。典型用法（`MergeFilters.java:36-46`）：

```java title="MergeFilters.java（datanode 优化规则）"
private static final Pattern<FilterNode> PATTERN =
    filter().with(source().matching(filter().capturedAs(CHILD)));

public Result apply(FilterNode parent, Captures captures, Context context) {
  FilterNode child = captures.get(CHILD);
```

规则声明"树形形状"，框架在 PlanNode 树上枚举匹配并回填捕获——Trino iterative optimizer 的核心机制原样继承。**为何放 calc-commons**：匹配框架自身不依赖任何 PlanNode 类型（泛型 + Property 抽象），而 PlanNode 在 node-commons、规则在 datanode——中间层让依赖方向干净。

### codegen：消灭"类型 × 运算符"组合矩阵

构建机制：pom 用 drill-fmpp-maven-plugin（继承自 Apache Drill 的方案）读 `src/main/codegen/config.fmpp` 加载 5 个 .tdd 数据模型，build-helper 把生成源挂进编译——**生成代码不进 git**。`ArithmeticBinaryColumnTransformer.ftl` 三重循环 `binaryOperators × types × types`：`MathematicalOperator.tdd` 定义五种二元运算 + 一元 NEGATION，`MathematicalDataType.tdd` 定义 INT/LONG/FLOAT/DOUBLE/DATE/TIMESTAMP 六型——即 **5×6×6=180 个类型特化算术 Transformer**，每个含带/不带 `boolean[] selection` 的两个 `doTransform()` 重载，DATE/TIMESTAMP 组合还生成 `Math.addExact` 溢出检查。**Why**：JVM 泛型擦除下无法对原始类型高效特化，手写 180 个类不可维护——与 Trino 用 codegen 生成算子同一动机，只是 Trino 生成 Page 级算子、IoTDB 生成列级 Transformer。fill 系列模板（linearFill/constantFill/previousFill）与 `ModeAccumulator.ftl` 同理。跨模块共享：datanode 的 pom 把 calc-commons 的 codegen 目录（排除 templates）与自己的模板合并统一生成——**.tdd 数据模型独家维护、datanode 模板复用**。

<details>
<summary>方法速查表</summary>

| 组件 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Pattern.match()` | 形状匹配 | Stream 串联前驱匹配 |
| `Captures.get(Capture<T>)` | 取回捕获值 | 类型化句柄 |
| `Operator.next()/isBlocked()` | 算子接口 | pull 式 + Future 阻塞（Trino 形状、TsBlock 载体） |
| `Accumulator.addStatistics(Statistics)` | 树模型聚合捷径 | **直达 tsfile 文件统计量跳过扫描**（Trino 没有的优化） |
| `TableAccumulator.copy()` | 表模型聚合并行 | 为 hash 分组拷贝实例 |
| `AbstractTemporaryQueryDataFileService.register()` | spill 文件登记 | 按 queryId 建目录 |
| `AccumulatorFactory.java`（28.6K） | 聚合总装配厂 | 表模型 40+ Accumulator 的构造入口 |
</details>

## 核心实现

### 双轨聚合框架

两套并行抽象对应双查询模型——**宁可两套也不强行统一**：树模型 `Accumulator` 面向时序对齐（`addInput(Column[], BitMap)`、部分聚合的 `addIntermediate/outputIntermediate`、以及 IoTDB 特有的 `addStatistics(Statistics)` **直达 tsfile 文件统计量**——注释明写 "only used in seriesAggregateScanOperator"，Trino 没有的捷径）；表模型 `TableAccumulator` 贴 Trino 语义（`AggregationMask` 替代 BitMap、`getEstimatedSize()`、`copy()` 为 hash 分组并行拷贝实例——Trino GroupedAggregation 的多实例模式）。两轨分别被 `SeriesAggregationScanOperator` 与 `AggregationOperator` 驱动。

### AbstractTemporaryQueryDataFileService：查询级 spill 生命周期

为溢出内存的数据结构分配管理临时文件：`register(SerializationRecorder)` 按 queryId 建目录、AtomicLong 生成唯一文件名；`deregister(queryId)` 关文件后删整个查询目录；`start()` 清掉上次崩溃遗留的整个临时根目录。抽象方法仅 `getTemporaryFileDir()`——目录位置由部署形态决定，经 `ServiceLoader` + `ITemporaryQueryDataFileServiceProvider`（SPI）加载唯一实现（datanode 的 `DataNodeTemporaryQueryDataFileServiceProvider`），多个/零个 provider 直接 IllegalStateException。使用者是 `ElasticSerializableTVList/ElasticSerializableRowList`（表达式求值中间结果落盘）与 `TreeDiskSpiller/TableDiskSpiller`（外排 spill）——**不是临时结果文件，而是查询内 spill，按 queryId 隔离、查询结束统一回收、重启自动清理**。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 组合式 Pattern（Interpreter + Decorator） | `previous()` 链 + accept 双分派 | 规则=纯声明式形状匹配 |
| 模板方法 | `AbstractOperator`、生成类的手写基类 | 骨架固定、特化生成 |
| SPI + 抽象服务 | TemporaryQueryDataFileService | 部署形态差异隔离到实现端 |
| 双轨接口 | Accumulator vs TableAccumulator | 两模型语义差异大于共性 |

## 模块间交互

被 datanode（重依赖）、confignode（仅 `SqlConstant`）、external-service-impl/rest、integration-test 消费；向下依赖 node-commons 与 tsfile。`QueryExecutionMetricSet`（wait_for_dispatch 等 Timer）挂 IoTDB metrics 框架；`MemoryReservationManager` 供查询内存预留；UDTFExecutor（transformation/dag/udf）是 UDF 执行的真正载体（见服务装配篇）。

## 扩展方式

新增一种二元算术运算：改 `MathematicalOperator.tdd`（加条目）或 `MathematicalDataType.tdd` → `ArithmeticBinaryColumnTransformer.ftl` 的 `<#switch>` 补 transform 代码块 → 重新构建自动生成——**改动面 = 2 个 .tdd + 1 个 .ftl，生成侧零手写**。新增 fill 插值方式：仿 linearFill.ftl 新建模板循环 DecimalDataType.tdd 生成 + 手写抽象基类 + datanode 装配链接入。新增聚合函数：表模型实现 TableAccumulator（可逆则实现 removeInput 支持滑动窗口）+ AccumulatorFactory 注册 + BuiltinAggregationFunctionEnum 加枚举；树模型实现 Accumulator（含 addStatistics 优化分支），类型特化多时走 ModeAccumulator.ftl。

> ⚠️ 待核实：IndexedBlockingQueue 对应的 Trino 包路径；fork 起始的 Presto/Trino 具体版本号（git 历史在 #17526 之前多为原地演进）；confignode 对本模块的实际用途（grep 仅见 SqlConstant）。
