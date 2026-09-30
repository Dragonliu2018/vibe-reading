---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "执行计划落地与代码生成"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "JIT", "字节码生成", "invokedynamic"]
description: "Trino 483 LocalExecutionPlanner 物理计划翻译与运行时字节码生成：PageProjection、JoinCompiler、LambdaMetafactory"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

worker 收到 coordinator 下发的 `PlanFragment` 后，这个模块负责两件事：**翻译**（`LocalExecutionPlanner.plan()` 把 PlanNode 树变成 DriverFactory 列表——物理执行蓝图）和**编译**（`sql/gen/` 把 RowExpression/join 哈希/排序比较器在运行时生成为 JVM 字节码）。Trino 快的秘诀一半在算子设计（下篇），另一半就在这里——表达式不再是解释执行的解释树，而是摊平成单个 `evaluate(int position)` 方法的专用类。

## 模块架构

两层：`LocalExecutionPlanner`（4461 行，含 ~40 个 `visitXxx` 的 PhysicalPlanner visitor）负责结构与装配；`sql/gen/`（56 文件）负责把 IR 编译成类——`ExpressionCompiler`（门面）、`PageFunctionCompiler`（投影）、`JoinCompiler`（45.6K）、`OrderingCompiler`、`LambdaMetafactoryGenerator`、`columnar/`（列式过滤）。

## 调用链路

```
worker: TaskResource 收 POST → SqlTask.updateTask (:511)
 └─ SqlTaskExecutionFactory.create (:81, span "local-planner")
     └─ LocalExecutionPlanner.plan(taskContext, fragment.getRoot(), partitioningScheme…)
         ├─ 按 partitioning handle 选输出工厂：
         │   SINGLE/broadcast → TaskOutputFactory(outputBuffer) (:555)
         │   分区 → PartitionedOutputFactory(:623)（含 PartitionFunction/nullChannel）
         ├─ plan.accept(new Visitor(session), context)   # ~40 个 visitXxx
         │   TableScanNode → TableScanOperatorFactory
         │   Filter/Project → visitScanFilterAndProject（源是 TableScan 则融合成
         │                     ScanFilterAndProjectOperatorFactory）
         │   AggregationNode → createHashAggregationOperatorFactory
         │                     （无 group by → AggregationOperatorFactory；
         │                       streamable → StreamingAggregationOperator）
         │   JoinNode → createLookupJoin（build 侧 HashBuilderOperatorFactory
         │                     + probe 侧 JoinOperatorFactory）
         │   SortNode → OrderByOperatorFactory
         │   ExchangeNode(LOCAL) → LocalExchangeSink/SourceOperatorFactory
         │   RemoteSourceNode → ExchangeOperatorFactory / MergeOperatorFactory
         │   TopN/Window/Unnest/MarkDistinct → 对应 Factory
         ├─ 末端 context.addDriverFactory(true, outputOperator, …)
         │   （LocalExchange/IndexSource 用 createSubContext 分叉新 pipeline）
         └─ new LocalExecutionPlan(driverFactories, partitionedSourceOrder)

表达式编译（建树过程中触发）：
 PageFunctionCompiler.compileProjection (:170)
   ├─ Reference → InputPageProjection（短路）
   ├─ Constant → ConstantPageProjection（短路）
   └─ compileProjectionClass()
       ├─ rewritePageFieldsToInputParameters 压缩 layout
       ├─ definePageProjectWorkClass()：生成实现 PageProjectionWork 的类
       │   （process() 生成 range/list 双模式 ForLoop，evaluate() 逐 position 求值）
       └─ defineClass() 经 CompilerUtils.defineClass (util/CompilerUtils.java:76)
           + DynamicClassLoader → MethodHandle → GeneratedPageProjection
           表达式主体由 ExpressionBytecodeCompiler.Visitor (:102,
           extends IrVisitor<BytecodeNode, Context>) 遍历 IR：
           visitCall→generateFullCall / visitConstant→LDC/indy /
           visitLogical→And/OrCodeGenerator / visitLambda→LambdaBytecodeGenerator
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `plan` in LocalExecutionPlanner.java:638 | Fragment → LocalExecutionPlan | visitor 返回 PhysicalOperation（factory+layout） |
| `compileProjection` in PageFunctionCompiler.java:170 | IR → PageProjection | Reference/Constant 短路不生成类 |
| `generateEvaluateMethod` in PageFunctionCompiler.java:339 | 表达式摊平成单方法 | null 用 wasNull 布尔局部变量追踪 |
| `internalCompileLookupSourceFactory` in JoinCompiler.java:182 | join 哈希表类生成 | 单 bigint channel 特化 BigintPagesHash |
| `generateMetafactory` in LambdaMetafactoryGenerator.java:57 | SQL lambda → 函数接口实例 | 复用 JVM invokedynamic 机制 |

</details>

## 核心实现

### LocalExecutionPlan 与 pipeline 概念

```java title="LocalExecutionPlanner.java（节选）"
class LocalExecutionPlan {
    List<DriverFactory> driverFactories;           // 一条 pipeline 一个蓝图
    List<PlanNodeId> partitionedSourceOrder;        // split 调度顺序
}
// DriverFactory：pipelineId / inputDriver / outputDriver / sourceId
//   + List<OperatorFactory>；createDriver(ctx) 逐个 createOperator 拼 Driver；
//   noMoreDrivers() 置空工厂列表防泄漏
```

pipeline 是 fragment 内的并行度单位：LocalExchange（unnest/join build 侧）会分叉出子 pipeline（`createSubContext`），固定 driver 数与 split 驱动 driver（`driverInstances` OptionalInt）在 DriverFactory 层面区分。

### 为什么编译而不是解释

解释执行每个值都要走 visitor 虚分发 + null 装箱判断；编译后整条表达式摊平成一个 `evaluate(int position)`：常量经 LDC/indy 折叠、函数调用绑成 MethodHandle 直调、`wasNull` 布尔局部变量追踪空值——JIT 可整体内联，热路径零模式匹配。每个投影一个专用类。

### io.airlift:bytecode DSL 与 invokedynamic

字节码生成不用裸 ASM 而用 `io.airlift:bytecode` 的声明式 DSL（`ClassDefinition/MethodDefinition/Scope/Variable/BytecodeBlock + BytecodeExpressions`）——类型安全、可组合（`generateProcessMethod` 里的 ForLoop/IfStatement 可读性接近源码）。DSL 未覆盖处仍直用 ASM（如 LambdaMetafactoryGenerator 拼 `Handle`）。

常量绑定走 invokedynamic：`Bootstrap.bootstrap` in sql/gen/Bootstrap.java 经 bindingId 从 `DynamicClassLoader.getCallSiteBindings()` 取 MethodHandle 返回 `ConstantCallSite`——**绕开常量池 64KB 限制与跨 classloader 可见性问题**（源码注释明说 "avoid constant pool issues due to large strings"）。SQL lambda（`filter(arr, x->...)`）同样用 LambdaMetafactory：`generateMethodsForLambda` 预生成方法，运行时发 indy 让 JVM 造函数接口实例。

### 编译缓存：值相等即指纹

`PageFunctionCompiler` 的 `projectionCache/filterCache`（key 为 Expression 对象本身，值等价 immutable IR record）；`JoinCompiler` 的 `lookupSourceFactories/hashStrategies`（key = CacheKey(types, outputChannels, joinChannels, sortChannel)）；`OrderingCompiler` 与 `LocalExecutionPlanner.accumulatorFactoryCache`（1000 条 expireAfterAccess 1h）。全部 `buildNonEvictableCache`（io.trino.cache.SafeCaches，非弱引用——防 GC 抖动引发重编译）。**channel/layout 刻意不入 key**：`PageFieldsToInputParametersRewriter` 把 layout 归一为紧凑序号，同一表达式跨不同 symbol 布局命中同一 class。缓存大小 `CompilerConfig.expressionCacheSize` 默认 10,000。

### JoinCompiler 的特化优化

单 bigint join channel 特化成 `BigintPagesHash`（`IsolatedClass.isolateClass` 复制 JoinHash 家族类消除字段可见性开销）；`InCodeGenerator` 把 IN 列表编译成 lookupswitch（按 hashCode 分桶，InCodeGenerator.java:170-216）；`columnar/` 子包的 `FilterEvaluator`（sealed 七实现）对 SelectedPositions 整段求值、`DictionaryAwareColumnarFilter` 免解码字典 Block、`FilterReorderingProfiler` 按选择性重排 AND 条件。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Visitor | `LocalExecutionPlanner.Visitor extends PlanVisitor<PhysicalOperation, LocalExecutionPlanContext>`（:877） | 计划→算子的开放映射表 |
| 策略族 | `interface BytecodeGenerator` 的 10 个实现（And/Or/Coalesce/In/IsNull/Match/Dereference/Row/Array/Bind） | IR 节点类型 → 生成策略的分派 |
| 缓存 | 五处编译缓存（值相等指纹） | 编译昂贵，等价表达式全集群复用 |
| 工厂 | OperatorFactory → DriverFactory 两级 | 同 pipeline 多 Driver 实例的复制源 |

## 模块间交互

- **输入**：`HttpRemoteTask` → worker `TaskResource` → `SqlTaskManager.updateTask`（SqlTaskManager.java:494）→ 本模块 plan；
- **输出**：`SqlTaskExecution` 构造器（SqlTaskExecution.java:138-165）遍历 `localExecutionPlan.getDriverFactories()`，按 sourceId 分为带 split 生命周期的 `DriverSplitRunnerFactory` 与固定 driver，`schedulePartitionedSplits` 按 `partitionedSourceOrder` 启动；
- **依赖**：`PlannerContext.getFunctionManager()` 解析 `ResolvedFunction` → `ScalarFunctionImplementation`（MethodHandle）供字节码绑定（见[元数据与类型系统](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/08-metadata-types)）；
- **动态过滤**：`ExpressionCompiler.compilePageProcessor` 返回 `Function<DynamicFilter, PageProcessor>`——动态过滤器就绪后才实例化，编译结果按 filter 值延迟绑定。

## 扩展方式

**新增 RowExpression code generator**：实现 `BytecodeGenerator`，在 `ExpressionBytecodeCompiler.Visitor` 加 `visitXxx` 分发（参照 `visitCoalesce` in ExpressionBytecodeCompiler.java:290）。

**新增逻辑节点→物理算子映射**：`LocalExecutionPlanner.Visitor` 加 `visitXxx` 返回 `new PhysicalOperation(operatorFactory, makeLayout(node), source)`。

**调编译缓存**：`CompilerConfig.setExpressionCacheSize`（配置项 `compiler.expression-cache-size`）；JoinCompiler/OrderingCompiler 的 maximumSize(1000) 目前硬编码（待核实是否存在对应 config）。
