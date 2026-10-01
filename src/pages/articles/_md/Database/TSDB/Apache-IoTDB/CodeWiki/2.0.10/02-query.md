---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "查询引擎"
date: "2026-10-01T21:00:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "时序数据库", "MPP", "Trino", "查询优化"]
description: "双模型 MPP 查询引擎：树/表模型在 IPlanner 处统一、共享 FragmentInstance-Driver-Operator 执行层；表模型整条链路是 Trino 移植，含 IterativeOptimizer、Pattern 匹配与协作式调度。"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

查询引擎（`datanode/.../db/queryengine`，plan 21.8 万行 + execution 5 万行，是全仓库最大的子系统）是一套 **MPP（Massively Parallel Processing）查询引擎**。它最核心的架构决定是：**树模型（时序 SQL）与表模型（关系 SQL）各自拥有独立的 parser/analyzer/planner，但在 `IPlanner` 接口处统一，完整共享 execution 层**（FragmentInstance → Driver → Operator → Exchange → Memory）。execution 层不关心数据模型语义，只搬运 TsBlock 列式数据块——MPP 调度、内存、容错一次性为两个模型服务。

代码分布在四个 Maven 模块：datanode（主体）、node-commons（121 个 relational AST 类 + PlanNode 公共基类）、calc-commons（Operator 接口与通用算子基座）、antlr + relational-grammar（两套 .g4 文法）。

## 模块架构

![查询引擎架构](/vibe-reading/images/articles/iotdb-2.0.10/query-architecture.svg)

树模型链路：`StatementGenerator.createStatement(sql, zoneId)`（L134）→ ANTLR `IoTDBSqlParser.g4`（SLL 优先失败回退 LL 两阶段）→ `ASTVisitor` 转 Statement → `Coordinator.executeForTreeModel()`（L368）→ `TreeModelPlanner`。表模型链路：`SqlParser.createStatement()`（L106）→ `RelationalSql.g4`（Trino 风格文法，`CaseInsensitiveStream` + nonReserved→IDENT 的 PostProcessor）→ `AstBuilder`（4356 行）产出 node-commons 的 AST → `Coordinator.executeForTableModel()`（L441）→ `TableModelPlanner`。

两模型在 `IPlanner` 五段式（analyze / doLogicalPlan / doDistributionPlan / doSchedule / invalidatePartitionCache）统一后，进入共享的分布式执行框架。DDL/管理语句走独立分支：`IConfigStatement` 的 instanceof 大清单 → `ConfigExecution` + `Tree/TableConfigTaskVisitor` → ConfigTask 树转发 ConfigNode。

## 调用链路

![MPP 执行调用链](/vibe-reading/images/articles/iotdb-2.0.10/query-execution-flow.svg)

`Coordinator`（单例，`queryExecutionMap` 管理本节点发起的所有查询，`QueryIdGenerator` 按 DataNodeId 生成全局唯一 QueryId）→ `QueryExecution.start()`（L169：analyze → doLogicalPlan → doDistributedPlan → initResultHandle → schedule）→ `DistributionPlanner.planFragments()`（L220）四步：**rewriteSource**（SourceRewriter 按分区信息把逻辑 SourceNode 重写为带 DataRegion 的物理扫描节点）→ **addExchangeNode**（在跨 Region 边界插 ExchangeNode，`needShuffleSinkNode()` 决定 child 挂 ShuffleSinkNode 还是 IdentitySinkNode——alignByDevice 且按 time 排序无 OrderByExpression 时需要 shuffle，limit 足够小走 TopK 时用 Identity；`adjustUpStreamHelper` 用 `Map<TRegionReplicaSet, MultiChildrenSinkNode>` memo 做 computeIfAbsent，同 Region 多个 Exchange 共享 SinkNode，但 **forced exchange 不入 memo** 单独 new）→ **optimize**（LimitOffsetPushDown 等）→ **splitFragment**（`FragmentBuilder.splitToSubPlan()` 以 Exchange/Sink 为切割线：遇 ExchangeNode 调 `cleanChildren()` 使其成为当前 Fragment 叶子，`visitedSinkNode` Set 去重保证同一 MultiChildrenSinkNode 只生成一个子 SubPlan；`planFragmentInstances()` 按 `context.isQuery()` 选 `SimpleFragmentParallelPlanner` 或 `WriteFragmentParallelPlanner` 克隆成并行 FragmentInstance）→ `ClusterScheduler.start()` 经 Thrift 双通道派发到目标 DataNode → 远端 `FragmentInstanceManager.execDataQueryFragmentInstance()`（L137，computeIfAbsent 幂等 + 拒绝重复派发）→ `LocalExecutionPlanner.plan()` 生成 PipelineDriverFactory → `DriverScheduler` 执行。

`QueryExecution.retry()`（L234）是一个值得注意的容错设计：失败最多重试 3 次、间隔 2s，`planner.invalidatePartitionCache()` 强刷分区缓存后重新走完整流程——应对 Region 迁移导致的分区信息失效。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `StatementGenerator.createStatement()`（L134） | 树模型解析 | SLL→LL 两阶段；RPC 直查协议跳过 SQL 解析 |
| `SqlParser.createStatement()`（L106） | 表模型解析 | Trino 同款加速策略与 PostProcessor |
| `Coordinator.executeForTreeModel/TableModel` | 查询入口 | 仅构造 planner 时分叉 |
| `QueryExecution.start()`（L169） | 五段调度 | QueryStateMachine 终态统一 releaseResource |
| `DistributionPlanner.planFragments()`（L220） | 分布式规划 | 先插 Exchange 再包 Sink 最后切分 |
| `FragmentInstanceDispatcherImpl.dispatch()` | 派发 | sync+async 双通道 + 状态轮询双保险 |
| `FragmentInstanceManager.execDataQueryFragmentInstance()`（L137） | 远端执行 | 幂等防重复派发 |
| `Driver.processFor(Duration)`（L121） | 时间片执行 | isBlocked 让出线程，Future 唤醒 |
| `MPPDataExchangeManager.createLocalSourceHandleForFragment()`（L837） | 同节点数据交换 | 共享内存队列零拷贝 |
| `MPPDataExchangeManager.getDataBlock()` | 跨节点拉块 | 按 req.getIndex() 从 SinkChannel 取 `getSerializedTsBlock(i)`；通道关闭/中止抛异常时返回空响应由 SourceHandle 处理 |
| `DriverScheduler.submitDrivers()` | Driver 调度 | readyQueue 为 `MultilevelPriorityQueue(LEVEL_TIME_MULTIPLIER, TASK_MAX_CAPACITY, ...)`；容量 = maxAllowedConcurrentQueries × degreeOfParallelism；依赖 Driver 经 SettableFuture listener 就绪后才入队 |
| `OperatorTreeGenerator.visitExchange`（L2537） | Exchange 算子构造 | isSameNode 判定 local/remote |
</details>

## 核心实现

### Operator：协作式推拉混合模型

统一接口 `Operator`（calc-commons）：`hasNext()`/`next()` 返回 TsBlock 或 null、`isBlocked()` 返回 ListenableFuture——**阻塞即让出线程、事件驱动唤醒**，这是 Trino cooperative scheduling 的移植（`MultilevelPriorityQueue` 注释直接引用 Trino MultilevelSplitQueue 源码链接）。`Driver.processFor(Duration)` 在时间片内循环：`root.isBlocked()` 未完成→返回；`sink.isFull()`→返回；否则 `nextWithTimer()` 取 TsBlock `sink.send()`。Driver 状态不是经典的 blocked/running/finished 三态，而是 ALIVE/NEED_DESTRUCTION/DESTROYED + `driverBlockedFuture`（AtomicReference<SettableFuture>）表达阻塞、`isFinishedInternal()`（L209）动态判定完成——`DriverLock`（非重入 + interrupterStack）防并发 close 竞态。

算子三分类：**source**（`SeriesScanOperator` 直读 DataRegion 的 seq/unseq 文件列表——`AbstractSeriesScanOperator` 的三级数据消费循环：page 优先、chunk 次之、file 最后，时间片超限让出。乱序数据的合并在 `SeriesScanUtil`：unseq 的 ITimeSeriesMetadata/IChunkMetadata/IVersionPageReader 分别用 **PriorityQueue** 管理（seq 用 List），时间重叠页经 `PriorityMergeReader` 归并出全局有序流）、**process**（Aggregation/Transform/Sort/Join/Fill 等）、**sink**（Identity/Shuffle）。两模型各有独立的 PlanNode→Operator 生成器：`OperatorTreeGenerator`（3780 行）与 `DataNodeTableOperatorGenerator`（2000+ 行），由 `LocalExecutionPlanner.generateOperator()`（L170）按 session 的 SqlDialect 选择。

### Exchange：Sink push + Source pull

`DistributionPlanner` 不是按算子任意切分，而是"先插 Exchange，再在每个 Exchange 的 child 处包 Sink 节点，最后以 Sink 为边界切"——**Exchange 是 pull 语义、Sink 是 push 语义**，二者由 `MPPDataExchangeManager` 的 handle 体系桥接：跨节点走 `createSourceHandle()`（Thrift 拉序列化 TsBlock——`getDataBlock()` 按 `req.getIndex()` 从对应 SinkChannel 调 `getSerializedTsBlock(i)` 逐序号取块；通道已关闭/中止时抛 `GetTsBlockFromClosedOrAbortedChannelException`，返回空响应由 SourceHandle 依自身状态处理信号），同节点走 `createLocalSourceHandleForFragment()`（`SharedTsBlockQueue` 共享内存零拷贝，省 RPC 的关键设计）。FragmentInstance 间的拓扑在 `SimpleFragmentParallelPlanner.calculateNodeTopologyBetweenInstance()` 建立双射：上游侧 `downStreamChannelLocation.setRemoteEndpoint(instance 的 MPPDataExchangeEndPoint)` + 远端 FragmentInstanceId，下游 ExchangeNode 侧 `setUpstream(...)` 三元组（endpoint、instanceId、sinkNode 的 planNodeId）。

### 内存三层：预估准入 + 背压 + 局部 spill

`PipelineMemoryEstimator` 基于每个 Operator 的 `calculateMaxPeekMemory()` 预估 pipeline 峰值，不足直接拒绝查询（`isEnableQueryMemoryEstimation` 可关）；运行中 `MemoryPool.reserveMemory()` 给 SinkChannel/SourceHandle 背压额度，`SinkChannel.isFull()`（L208）超额度返回未完成 future 阻塞上游 Driver——端到端流控；spill 覆盖面窄（只给最可能爆炸的 sort/topK：`DiskSpiller` 写 .sortTemp 文件），聚合/join 靠内存准入控制。

### 表模型：Trino 整链移植

这不是"借鉴"，是**移植**：`SqlParser`/`AstBuilder`/`StatementAnalyzer`（Scope/Field/ExpressionAnalysis）/`RelationPlanner`/`QueryPlanner`/`SymbolAllocator`/`TranslationMap`/`EqualityInference`/`CteMaterializer`/`IterativeOptimizer`（Memo/Lookup/Rule/RuleIndex/RuleStats）/`StatementRewrite`/`TypeManager` 与 Trino 同名包逐层对应，行模式识别（rowpattern、MATCH_RECOGNIZE 语法）也一并搬运。`io.airlift.units.Duration`（Presto airlift 库）遍布 Driver 体系。差异点：无 Presto 的 node/split/字节码生成，数据单元是 TsBlock 而非 Page，source 算子对接 TsFile 存储引擎。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Visitor（重灾区） | `StatementVisitor`（~100 个 visit）/ `PlanVisitor`（703 行接口）/ `AstBuilder` / 优化器 Rewriter | 节点种类 × 处理逻辑多对多正交扩展 |
| 策略 | `IPlanner` 两实现、SqlDialect 分派 | 双模型同骨架 |
| 状态机 | `QueryStateMachine`、FragmentInstanceStateMachine | 查询生命周期监控与资源释放 |
| 模板方法 | `QueryExecution.start()` 五段骨架 | 子类只覆写分叉点 |
| 观察者/回调 | stateTracker、Future 唤醒 | 异步派发的完成通知 |

## 模块间交互

向下经 source 算子直读存储引擎（`QueryDataSource` 注入 seq/unseq 文件列表）；向元数据引擎做 schema fetch 与 AutoCreate；DDL 经 ConfigTask 体系转发 ConfigNode；`MPPDataExchangeService`（独立端口 10740）承载跨节点数据流；写入语句同样走 MPP（`WriteFragmentParallelPlanner` + 写重定向推荐），复用全部容错。PlanNode/AST 基类下沉 node-commons 是硬约束——confignode 需要解析校验同样的语句与计划（pipe/订阅转发），放 datanode 会循环依赖。

## 扩展方式

树模型新增聚合函数：`execution/aggregation/` 写 `XxxAccumulator`（参考 `SumAccumulator`）+ `AccumulatorFactory` 注册。表模型新增聚合函数：node-commons `TableBuiltinAggregationFunction` enum 加项（缺省 fallback 到 UDAF）。新增执行算子三步：Operator 类 → 新 PlanNode（node-commons `PlanVisitor` 加抽象方法）→ `OperatorTreeGenerator`/`DataNodeTableOperatorGenerator` 加 visitXxx——**改 PlanVisitor 接口会波及全部 ~5 个实现类**，这是该体系最大的机械成本。新增优化规则在 `relational/planner/iterative/rule/` 写 Rule（60+ 现成可抄）挂进 `LogicalOptimizeFactory`。

> ⚠️ 待核实：LocalMemoryManager 注释提到的 write 池在 v2.0.10 未见实现；confignode 侧对 commons PlanNode 的复用范围。
