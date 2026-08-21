---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "Overview"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "Java", "实时分析", "列式存储", "OLAP"]
description: "Apache Druid 37.0.0——高性能实时分析数据库，列式 Segment 存储 + Sequence 惰性流式查询 + 批流统一摄入 + 多阶段 SQL 引擎（MSQ）内核解读。"
readingTime: "55 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 37.0.0 · **协议** Apache-2.0 · **Java** 17 · **代码量** ~90 万行 · **仓库** [GitHub](https://github.com/apache/druid)

---

## 总览

### 项目简介

Apache Druid 是一个**高性能实时分析数据库（real-time analytics database）**，以分布式列式存储（distributed column store）为核心，面向"既要摄入快、又要查询快"的工作负载。它的设计目标是把数据**从摄入到可查询的延迟压到亚秒级**，同时支撑高并发与大批量扫描。

Druid 解决的核心问题是：**在海量时序事件数据上做亚秒级的聚合与 ad-hoc 查询**。为此它把数据按时间分片成不可变的 **Segment**（列式存储），查询时把计算下推到持有数据的 Historical 节点并行执行，再在 Broker 上惰性流式合并结果。摄入侧同时支持批与流（Kafka/Kinesis），流摄入通过 offset checkpoint 实现 exactly-once。

核心使用场景：面向 UI 的仪表盘与可视化、运营 ad-hoc 查询、高并发点查、实时监控与漏斗分析。

**项目边界**：Druid 负责时序事件的快速摄入、列式存储与聚合查询，**不**是事务型数据库（无 ACID 事务、无行级更新），也**不**是通用数据仓库——复杂的多表 JOIN 与大规模 ETL 在 37.0.0 前由 MSQ 引擎补足，但 Druid 的定位仍是"分析加速层"而非全功能数仓。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 列式 Segment 存储 | `processing/.../segment/`、`timeline/DataSegment.java` | 不可变列式数据块，mmap 高效读 |
| 实时增量索引 | `segment/incremental/IncrementalIndex.java` | `ConcurrentSkipListMap` + 聚合器，支持 rollup |
| 批流统一摄入 | `indexing-service/.../common/task/`、`seekablestream/` | `InputSource`/`InputFormat` 替代旧 Firehose |
| 惰性流式查询 | `processing/.../query/`、`java/util/common/guava/Sequence.java` | `Sequence`/`Yielder` 控制反转，全链路不物化 |
| 数据均衡与生命周期 | `server/.../coordinator/` | 声明式 Rules + Cost 均衡 |
| 任务调度 | `indexing-service/.../overlord/` | `HttpRemoteTaskRunner`（37 默认）+ Supervisor |
| Druid SQL | `sql/.../calcite/planner/` | 基于 Apache Calcite 规划为 native query |
| 多阶段 SQL（MSQ） | `multi-stage-query/.../msq/` | stage DAG + kernel 状态机 |
| 可插拔后端 | `processing/.../segment/loading/`、`extensions-core/` | Deep/Metadata storage SPI |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Java 17 / Maven | 核心 | 语言与构建（JDK 17 或 21 构建） |
| Jetty | 核心 | HTTP 服务器，承载 QueryResource / SqlResource |
| ZooKeeper（Curator） | 核心 | 服务发现、Leader 选举、（旧）task 状态 |
| Google Guice | 核心 | 依赖注入，扩展点经 Multibinder 注册 |
| Jackson | 核心 | JSON 序列化，subtype 多态（`@JsonSubTypes`） |
| Apache Calcite | 核心 | Druid SQL 的 parser/validator/优化器 |
| Netty / 异步 HTTP | 核心 | Broker→Historical fan-out 客户端 |
| Resilience4j | 核心 | `Bulkhead` 信号量实现 QueryScheduler lanes |

### 版本历史

Druid 演进脉络的关键节点：早期以"实时节点 + 批摄入 + Historical"三段式起家；随后用 `InputSource`/`InputFormat` 取代 Firehose、`AppenderatorImpl` 拆分为 Batch/Stream 两条路径，统一批流摄入；0.21 起引入 MSQ 多阶段查询引擎，补足 JOIN/大规模 INSERT 能力；近年引入 nested column（直接摄入 JSON）、向量化执行、以及 37.0.0 中的 decoupled planning（`DruidLogicalConvention`）与 `HttpRemoteTaskRunner`（弃用 ZK 通信、默认 HTTP）。37.0.0 是解读基线，正处于"经典 native 引擎"与"MSQ/decoupled 新路径"并存的阶段。

---

## 快速上手

最快的代码阅读体验来自官方 Docker 单机镜像，它一次性拉起全部节点角色：

```bash title="快速启动单机集群"
docker pull apache/druid:37.0.0
docker run --rm -p 8888:8888 apache/druid:37.0.0
```

启动后打开 Web Console（`http://localhost:8888`），用内置向导加载一份示例数据（如 Wikipedia 编辑流），再在查询工作台执行：

```sql title="Web Console 查询工作台"
SELECT page, COUNT(*) AS edits FROM wikiticker
GROUP BY page ORDER BY edits DESC LIMIT 10;
```

预期：返回按编辑次数排序的页面 Top-10，证明摄入、Segment 落盘、Broker fan-out 查询全链路打通。构建源码则需 JDK 17/21 + Maven：`mvn install -DskipTests`（耗时较长，详见[构建指南](https://druid.apache.org/docs/latest/development/build.html)）。

---

## 架构设计解析

### 系统架构

![Apache Druid 分层架构](/vibe-reading/images/articles/druid-internals/architecture.svg)

Druid 的整体架构思想是**把"数据所在"与"计算发生"对齐**：数据按时间切成不可变 Segment 散布在 Historical 上，查询被 Broker 拆解后**下推**到持有对应 Segment 的 Historical 并行执行，Broker 只做 fan-out 与结果合并——这避免了大规模 shuffle，让聚合扫描近乎线性扩展。同时它把**易变部分（发现、调度、生命周期）**抽离为独立的协调职责，让数据路径上的 Historical/Broker 保持无状态、可水平扩展。

分层职责与依赖方向如下（上层依赖/调用下层）：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接入层 | `web-console/`、`server/.../http/` | 隔离外部协议（HTTP/JDBC/Web Console），保护核心不受接口变化影响 |
| 节点进程 | `services/.../cli/`、`server/` | 定义 Broker/Coordinator/Overlord/Historical/MM 等角色，绑定各自依赖 |
| 引擎层 | `processing/.../query/`、`sql/`、`multi-stage-query/` | 承载查询执行与 SQL 规划，native 引擎与 MSQ 并存 |
| 数据内核 | `processing/.../segment/`、`timeline/` | 列式格式、列模型、增量索引——一切数据落地的基础 |
| 协调层 | `server/.../coordinator/`、`indexing-service/.../overlord/`、`server/.../discovery/` | 数据均衡、任务调度、服务发现/Leader，把易变状态与数据路径解耦 |
| 存储后端 | `extensions-core/`（S3/HDFS/MySQL/PG…） | 可插拔的 Deep/Metadata storage，core 只依赖 SPI |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| SPI + Guice Multibinder | `DruidModule`、`segment/loading/*SPI`、`ExtensionInjectorBuilder` | Deep/Metadata storage、InputSource 等按需加载，core 不膨胀 |
| 模板方法 | `AbstractTask.run()` in `indexing-service/.../common/task/AbstractTask.java` | 固化 setup→runTask→cleanUp 骨架，子类只填 `runTask` |
| 策略 | `BalancerStrategy`、`QueryToolChest`、`SegmentWriteOutMediumFactory` | 均衡/查询/写出多种算法可替换 |
| 责任链 | `CoordinatorDuty` pipeline in `duty/CoordinatorDutyGroup.java` | Coordinator 职责按序串联，duty 间以 params 传递 |
| 装饰器链 | `QueryRunner` 链（cache→merge→metrics）in `FluentQueryRunner` | 查询能力可叠加，不改动核心 runner |
| 状态机 | `ControllerQueryKernel`、`ControllerStagePhase` | MSQ 调度决策与 I/O 分离，单线程化保正确 |
| 控制反转（惰性流） | `Sequence`/`Yielder` in `java/util/common/guava/` | 全链路不物化结果，背压自然形成 |
| DI 容器 | 三层 `InjectorBuilder` in `server/.../initialization/` | 扩展点经 Multibinder 注册，节点差异靠 module 组合 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `DataSegment` | 不可变列式数据块元数据（interval/version/shardSpec/loadSpec） | 落盘后长期存在，可被 overshadow 覆盖 | 被 Historical 加载、Coordinator 调度 |
| `IncrementalIndex` | 实时内存增量索引（写端） | 单 segment 持续累积，persist 后清空 | 持有 `Aggregator[]`，由 Appenderator 驱动 |
| `Sequence<T>`/`Yielder` | 惰性数据流（控制反转的迭代器） | 一次查询链路 | 被 `QueryRunner.run` 返回、`accumulate` 驱动 |
| `Query`/`QueryToolChest` | 查询及其 per-type 策略集 | 单次查询 | toolChest 提供 mergeResults/mergeFn |
| `Task` | 摄入任务抽象 | Overlord 调度单次 | 由 `TaskRunner` 执行，通过 `TaskActionClient` 回写 |
| `ControllerQueryKernel` | MSQ stage DAG 调度纯状态机 | 单次 MSQ 查询 | 管理 `StageDefinition` 依赖与 phase 推进 |

对象关系：

```
DataSegment ──(加载)──> QueryableIndex ──> ColumnHolder[] ──> BaseColumn
                                                          ├─ makeColumnValueSelector（逐行）
                                                          └─ makeVectorValueSelector（向量化）
Appenderator.add ──> IncrementalIndex（ConcurrentSkipListMap + Aggregator[]）
                              └── IndexMerger.persist ──> DataSegment（落盘）
```

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `ColumnSelectorFactory` | `segment/ColumnSelectorFactory.java` | `QueryableIndexColumnSelectorFactory`、`IncrementalIndex...` | 直接实现 |
| `BaseColumn` | `segment/column/BaseColumn.java` | `DictionaryEncodedColumn`、`LongColumn`、`NestedColumn...` | `as()` 能力查询 |
| `Appenderator` | `server/.../realtime/appenderator/Appenderator.java` | `BatchAppenderator`、`StreamAppenderator` | 工厂 `BatchAppenderators`/`Appenderators` |
| `QuerySegmentWalker` | `query/QuerySegmentWalker.java` | `ClientQuerySegmentWalker`（Broker）、`ServerManager`（Historical） | Guice 按节点角色绑定 |
| `TaskRunner` | `indexing-service/.../overlord/TaskRunner.java` | `HttpRemoteTaskRunner`（默认）、`RemoteTaskRunner`、`ForkingTaskRunner` | `TaskRunnerFactory` + 配置选择 |
| `BalancerStrategy` | `coordinator/balancer/BalancerStrategy.java` | `CostBalancerStrategy`、`RandomBalancerStrategy` | `@JsonTypeInfo` 工厂 |
| `DruidModule` | core | 各扩展 `*DruidModule` | ServiceLoader `META-INF/services` |

---

## 代码目录

```
druid/
├── processing/          # 数据内核 + 查询引擎（~38 万行，最大模块）
│   └── org/apache/druid/
│       ├── segment/        # 列式格式、列模型、增量索引、SPI
│       ├── query/           # 查询类型、聚合、表达式、Sequence
│       ├── timeline/        # DataSegment、版本覆盖
│       └── data/input/     # InputSource/InputRow/InputFormat
├── server/               # 节点运行时 + Coordinator（~14 万行）
│   └── org/apache/druid/
│       ├── server/          # broker/historical、QueryResource、ServerManager
│       ├── coordinator/     # 数据均衡、Rules、duty
│       └── discovery/       # DruidNodeDiscovery、Leader 选举
├── indexing-service/     # Overlord + Task 框架（~8.4 万行）
│   └── org/apache/druid/indexing/
│       ├── common/task/     # Task/AbstractTask/IndexTask/CompactionTask
│       ├── overlord/        # TaskMaster/TaskRunner/Supervisor/TaskLockbox
│       └── seekablestream/  # Kafka/Kinesis 流摄入基类
├── sql/                  # Druid SQL（~6.3 万行，Calcite 规划）
├── multi-stage-query/    # MSQ（~7.2 万行，多阶段执行）
├── services/             # CLI 启动 + Guice 装配（~1 万行）
│   └── org/apache/druid/cli/  # CliBroker/CliCoordinator/... 入口
├── extensions-core/      # 核心扩展（~10.5 万行，S3/MySQL/Kafka…）
├── extensions-contrib/   # 社区扩展
├── benchmarks/           # 性能基准
├── distribution/         # 打包发布
└── docs/                 # 文档站
```

`processing` 是地基（被几乎所有模块依赖）；`server` 与 `indexing-service` 是两个"重型服务"模块（前者承载节点运行时与 Coordinator，后者承载 Task 与 Overlord）；`services` 虽小却是所有节点的启动入口，负责把上述模块按角色组合装配。

---

## 模块地图

![Druid 模块依赖关系](/vibe-reading/images/articles/druid-internals/module-dependencies.svg)

依赖方向自顶向下：`services`（CLI bootstrap）经 Guice 装配加载所有节点模块；中间的服务模块依赖底层 `processing` 内核；扩展系统以 SPI 形式实现数据内核的接口。横向也有协作：`Overlord` 调度 `摄入引擎` 的 task、`MSQ` 复用 `Druid SQL` 的 Calcite 规划并借 `摄入引擎` 的 task 框架执行。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Segment 存储与列模型 | 列式格式、列模型、增量索引 | `DataSegment`、`IncrementalIndex` | 数据落地基础，读写双路径自成体系 | [01-segment-storage](01-segment-storage) |
| 查询引擎与处理流水线 | 查询类型、聚合、表达式、惰性流 | `Query`、`Sequence`、`AggregatorFactory` | 计算内核，与存储解耦的 selector 桥 | [02-query-engine](02-query-engine) |
| 摄入引擎 | 批/流摄入、Appenderator、Compaction | `Task`、`IndexTask`、`SeekableStreamIndexTask` | 把外部数据变为 segment 的独立路径 | [03-ingestion](03-ingestion) |
| Coordinator 数据协调 | segment 分配、Rules、均衡 | `DruidCoordinator` | 数据可用性与均衡的"管家"职责 | [04-coordinator](04-coordinator) |
| Overlord 任务调度 | task 派发、Supervisor、锁、autoscale | `TaskMaster`、`HttpRemoteTaskRunner` | 摄入调度的"管家"职责 | [05-overlord](05-overlord) |
| 服务运行时与查询服务 | HTTP、QueryLifecycle、fan-out、segment 服务 | `QueryResource`、`ServerManager` | 查询如何被服务（路由 + 本地执行） | [06-server-runtime](06-server-runtime) |
| Druid SQL | SQL→native query 规划 | `DruidPlanner`、`DruidQueryRel` | SQL 前端，复用 Calcite | [07-druid-sql](07-druid-sql) |
| 多阶段查询引擎 MSQ | stage DAG + kernel 调度 | `ControllerQueryKernel`、`MSQControllerTask` | 复杂 SQL/INSERT 的新执行路径 | [08-msq](08-msq) |
| 节点启动与服务发现 | Guice 装配、节点发现、Leader | `Cli*`、`DruidNodeDiscovery` | 所有节点的启动与组群基础 | [09-node-startup](09-node-startup) |
| 扩展系统 | Deep/Metadata storage SPI、扩展加载 | `DruidModule`、`DataSegmentPusher` | 可插拔后端，core 只依赖契约 | [10-extensions](10-extensions) |

---

## 运行时行为

### 启动流程

节点经 `Main` 注册命令，`Cli*` 继承 `GuiceRunnable` 装配 injector，启动 Jetty 并加入集群：

```
main → services/.../cli/CliBroker（等）
  → GuiceRunnable.run()
    → ServerInjectorBuilder：CoreInjectorBuilder → ServiceInjectorBuilder → ExtensionInjectorBuilder
      （~30 核心 module + 节点角色 module + 扩展 module，按 @LoadScope 过滤）
    → ServerModule 绑定 @Self DruidNode（host/port/serviceName）
    → JettyServerModule 创建 HTTP server，挂载 QueryResource / SqlResource
    → DiscoveryModule（PolyBind）→ CuratorDruidNodeAnnouncer 写 ZK ephemeral 节点
    → CuratorDruidNodeDiscoveryProvider（PathChildrenCache）监听同类节点
    → Leader 角色（Coordinator/Overlord）经 CuratorDruidLeaderSelector（LeaderLatch）选举
```

对象装配的关键是**三层 InjectorBuilder**：核心模块先行，Service 层用 `Modules.override` 覆盖配置，Extension 层再叠加扩展。扩展点（`DruidService`→`NodeRole` MapBinder、`DruidModule`）经 Guice Multibinder 注册，节点差异仅靠组合不同 module 实现——例如 `CliCoordinator` 支持 `asOverlord` 模式，合并 `CliOverlord` 的全部 module 让一个进程兼任两职。

### 核心运行流程

下面三条链路覆盖了 Druid 的查询、摄入与数据均衡三类核心场景。

#### 查询：Broker fan-out → Historical 本地执行

业务流程：客户端 POST 查询 → Broker 接入 → 路由到各 Historical → 各节点本地扫描 segment → 合并 → 流式返回。

![查询执行数据流](/vibe-reading/images/articles/druid-internals/query-flow.svg)

文字解读：入口 `QueryResource.doPost` 构造 `QueryLifecycle`（init→authorize→execute），`execute` 调 `QueryPlus.run(QuerySegmentWalker)`。Broker 注入 `ClientQuerySegmentWalker`，其内部 `CachingClusteredClient` 经 `BrokerServerView` 取 segment timeline、用 `SegmentPruner` 裁剪、经 `QueryScheduler.prioritizeAndLaneQuery` 分配 lane，再按 server 分组由 `DirectDruidClient` **同步触发异步 HTTP**（返回 `ListenableFuture<InputStream>`）fan-out 到各 Historical。结果包装为惰性 `Sequence`（`JsonParserIterator` 从 `LinkedBlockingQueue` 拉取，`TrafficCop` 背压）。各 Historical 同样走 `QueryResource`→`ServerManager`（`QuerySegmentWalker` 在此绑定为 `ServerManager`）→`ChainedExecutionQueryRunner` 在 `QueryProcessingPool` 上**按 segment 并行**执行，`MergeIterable` 排序合并后由 `toolChest.mergeResults`（`CombiningSequence`）二次合并，流式回传。Broker 端 `MergeSequence`（`PriorityQueue<Yielder>`）做 N 路惰性合并，`QueryResultPusher` 在**第一行**触发 HTTP 200 + 响应头，逐行序列化写出——全程不物化全部结果。

#### 摄入：批/流统一管线

业务流程：数据源 → 解析为 InputRow → Appenderator 追加 → IncrementalIndex 聚合 → persist/push → 发布元数据 → Coordinator 加载 → Historical handoff。

![数据摄入流程](/vibe-reading/images/articles/druid-internals/ingestion-flow.svg)

文字解读：流摄入由 `Supervisor`（Overlord）周期创建 `SeekableStreamIndexTask`，`SeekableStreamIndexTaskRunner` 经 `RecordSupplier` 拉 Kafka/Kinesis 记录、`StreamChunkReader` 解析为 `InputRow`，交 `StreamAppenderator.add`→`Sink`→`IncrementalIndex.add`（命中 key 则 `Aggregator.aggregate`，未命中则 factorize 新建）。批摄入由 `IndexTask` 分 `determinePartitions`/`buildSegments` 两阶段，用 `InputSource`+`InputFormat`（`isSplittable` 支持并行 split）经 `InputSourceProcessor` 循环喂入 `BatchAppenderator`。两条路径在 `Appenderator` 汇合：内存达阈值时 `persistAll`（流摄入用 `Committer` 快照 offset 保证 exactly-once），`IndexMerger.merge` 生成不可变 segment，`DataSegmentPusher` 推 Deep Storage，`TransactionalSegmentPublisher` 发布元数据，Coordinator 随后加载、Handoff 给 Historical。37.0.0 已**移除 Firehose**、`AppenderatorImpl` 拆为 Batch/Stream 双实现。

#### 数据均衡：Coordinator duty 链

`DruidCoordinator` 成为 Leader 后，按 `scheduleAtFixedRate` 跑 `CoordinatorDutyGroup` 责任链：`PrepareBalancerAndLoadQueues`（构建 cluster + `BalancerStrategy`）→`RunRules`（按声明式 Rules 匹配 segment，下发 load/drop）→`UpdateReplicationStatus`→`UnloadUnusedSegments`→`BalanceSegments`（`CostBalancerStrategy` 用 24h 半衰期 cost 模型把时间相近的 segment 分散到不同 Historical，降低查询热点）→`CollectLoadQueueStats`。下发经 `StrategicSegmentAssigner`→`HttpLoadQueuePeon` 以 HTTP POST `DataSegmentChangeRequest` 发给 Historical。

### 状态流

![关键状态流转](/vibe-reading/images/articles/druid-internals/state-flow.svg)

Druid 有两套关键状态机：**Overlord Task 生命周期**（`PENDING`→`RUNNING`→`SUCCESS`/`FAILED`，由 `TaskRunner` 驱动，`TaskLockbox` 时间区间锁保证 segment 版本顺序，流摄入可 `canRestore` 恢复）；**MSQ `ControllerStagePhase`**（`NEW`→`READING_INPUT`→`MERGING_STATISTICS`→`RESULTS_READY`→`FINISHED`，可经 `RETRYING` 重跑失败 worker，`GLOBAL_SORT` 需先收集 key statistics 再生成分区边界）。MSQ 的所有状态变更经 `kernelManipulationQueue` 单线程串行，决策与 I/O 分离保证调度正确性。

---

## 典型修改场景

#### 场景 1：新增 Deep Storage 后端（如自建对象存储）

需实现 `processing/.../segment/loading/` 的 `DataSegmentPusher`/`DataSegmentKiller`/`DataSegmentMover`，新增 `LoadSpec`+`SegmentizerFactory` 从后端下载，并写一个 `*DruidModule`（`META-INF/services/org.apache.druid.initialization.DruidModule` 注册）。关键函数：`DataSegmentPusher.push()`、`makeLoadSpec()`（约定目录结构 `dataSource/interval/version/partitionNum/`）。对应测试：`extensions-core/s3-extensions` 的单测可作参考。

#### 场景 2：新增 SQL 函数

在 `sql/.../calcite/expression/builtin/` 新建 `XxxOperatorConversion`（实现 `SqlOperatorConversion`，提供 `calciteOperator()` 与 `toDruidExpression()`），注册到 `DruidOperatorTable.STANDARD_OPERATOR_CONVERSIONS`（`sql/calcite/planner/DruidOperatorTable.java`）。聚合函数则实现 `SqlAggregator` 注册到 `STANDARD_AGGREGATORS`。对应测试：`sql/.../calcite/expression/` 下现有 conversion 的单测。

#### 场景 3：新增查询类型（如一种新聚合查询）

实现 `Query` 子类 + `QueryToolChest`（Broker 侧 merge/mergeFn）+ `QueryRunnerFactory`（Historical 侧 `createRunner(Segment)`/`mergeRunners`），经 `@JsonSubTypes` 注册 query 类型，并绑定 Guice factory。关键函数：`QueryRunnerFactory.createRunner()` in `query/QueryRunnerFactory.java`。对应测试：参考 `query/timeseries/` 的 `TimeseriesQueryRunnerTest`。

---

## 测试体系

Druid 各模块自带 `src/test/`，分层对应代码层：

| 代码层 | 测试类型 | 典型目录 |
| --- | --- | --- |
| `processing`（内核） | 单元测试（selector/sequence/merger） | `processing/src/test/.../query/`、`segment/` |
| `server`/`indexing-service` | 集成测试（QueryLifecycle、TaskRunner） | `*/src/test/.../server/`、`indexing/` |
| 端到端 | IT（分布式集群） | `integration-tests/`（独立模块） |

理解某类时优先读其对应测试：例如读懂 `Sequence` 合并可从 `processing/src/test/.../common/guava/MergeSequenceTest` 入手；改 `QueryRunner` 链时参考 `server/src/test/.../QueryLifecycleTest`。

---

## 阅读源码推荐路线

- 第一遍：理解查询主流程
  `server/.../QueryResource.java` 的 `doPost` → `QueryLifecycle.java` 的 `execute` → `ClientQuerySegmentWalker.java` 的 `getQueryRunnerForIntervals` → `client/CachingClusteredClient.java` 的 `run` → `java/util/common/guava/Sequence.java` 与 `Yielder.java`
- 第二遍：理解存储与写入
  `timeline/DataSegment.java` → `segment/incremental/IncrementalIndex.java` 的 `add`/`addToFacts` → `segment/column/BaseColumn.java` 的 `makeColumnValueSelector`/`makeVectorValueSelector` → `segment/realtime/appenderator/BatchAppenderator.java`
- 第三遍：理解摄入与调度
  `indexing-service/.../common/task/AbstractTask.java` 的 `run` → `IndexTask.java` 的 `runTask` → `seekablestream/SeekableStreamIndexTaskRunner.java` 的 `runInternal` → `overlord/TaskMaster.java` → `overlord/HttpRemoteTaskRunner.java`
- 第四遍：理解 SQL 与 MSQ 演进
  `sql/.../calcite/planner/DruidPlanner.java` 的 `plan` → `rel/DruidQueryRel.java` 的 `toDruidQuery` → `multi-stage-query/.../msq/kernel/controller/ControllerQueryKernel.java` 的 `registerStagePhaseChange` → `indexing/MSQControllerTask.java`

> 每遍都先看对应模块文档（01–10）获取该子系统内部结构，再进源码。

---

## 附录

**术语表**

| 术语 | 解释 |
| --- | --- |
| Segment | Druid 的不可变列式数据块，按时间 interval 分片 |
| Historical | 服务已落盘 segment 查询的数据节点 |
| MiddleManager / Indexer | 运行摄入 task 的节点（peon 是其内部 task 进程） |
| Broker | 接收查询、fan-out 到 Historical 并合并结果的节点 |
| Coordinator | 管理 segment 可用性/均衡/生命周期的协调节点 |
| Overlord | 管理摄入 task 调度的协调节点 |
| Deep Storage | segment 文件的共享持久存储（S3/HDFS…） |
| Metadata Storage | 存 segment/task 元数据的关系库（MySQL/PG） |
| Rollup | 摄入时按维度聚合，压缩存储 |
| MSQ | Multi-Stage Query，多阶段分布式 SQL 执行引擎 |

**参考资料**

- [Druid 官方设计文档](https://druid.apache.org/docs/latest/design/architecture.html)
- [Druid 设计文档：进程、Segment、查询](https://druid.apache.org/docs/latest/design/)
- 仓库 [apache/druid](https://github.com/apache/druid) @ tag `druid-37.0.0`
