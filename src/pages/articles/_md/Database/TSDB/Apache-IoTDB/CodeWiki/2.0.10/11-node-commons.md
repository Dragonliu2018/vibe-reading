---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "node-commons 公共基础库"
date: "2026-10-01T21:30:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "时序数据库", "序列化", "路径匹配", "模块设计"]
description: "跨节点共享底座：PartialPath 路径代数、PlanNode 自序列化 + 枚举分派 + SPI 反序列化、分区类型体系与 commons-pool2 连接池——为什么这些类型必须放最底层。"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

node-commons（`iotdb-core/node-commons`，984 个 Java 文件，pom 描述即定位："Common modules of the server and config node"）是 ConfigNode 与 DataNode 两个独立进程共享的类型与序列化底座。最大包：queryengine（289 文件，表模型 PlanNode 全集 + 121 个 relational AST）、pipe（172）、schema（110）、path（31）。

**为什么这些类型必须单独抽出**（依赖方向已核实）：ConfigNode 与 DataNode 是两个部署物，都要处理路径模式匹配（PartialPath/PathPatternTree）、分区表（SchemaPartition/DataPartition）、Thrift 连接池（ClientManager）；consensus 模块要序列化写请求（PlanNode——`IConsensus` 签名里就有它，而 datanode 依赖 consensus，放 datanode 会**循环依赖**）；calc-commons 要复用表模型 PlanNode；pipe 跨集群传 PlanNode 时收发两端版本可能不同，序列化格式和编号必须钉死在最底层。依赖方向严格单向：node-commons 只依赖 API/RPC 层（service-rpc、thrift、udf-api 等），不依赖 datanode/confignode；被 confignode、datanode、consensus、calc-commons、external-service-impl、cli、example 依赖。

## 模块架构

![node-commons 架构](/vibe-reading/images/articles/iotdb-2.0.10/node-commons-architecture.svg)

六个功能块：**路径体系**（PartialPath 家族 + PathPatternTree）、**PlanNode 序列化体系**、**relational AST 公共层**、**分区类型**、**客户端连接池**、**pipe 公共层**。注意一个容易找错位置的事实：`ConfigNodeClient` 不在本模块而在 datanode（它封装 datanode 视角的请求/响应翻译逻辑，node-commons 只提供与业务无关的连接池和传输层）。

## 调用链路

### PartialPath：最高扇入的路径代数

`PartialPath`（`path/PartialPath.java`，1159 行，graphify 度量 1384 边全仓第一）是树模型路径的"模式 + 全路径"二合一表示，内部就是 `String[] nodes`，通配符 `*`/`**` 是普通节点值。方法群分三类：**匹配**（`matchFullPath`/`matchPrefixPath`/`prefixMatchFullPath`）、**集合代数**（`include()` 包含关系（先把 `**.*` 归一成 `**` 再比较）、`overlapWith()` 是否相交（O(n·m) DP，源码注释写了转移方程）、`intersectWithPrefixPattern()`）、**变换**（`concatPath`/`alterPrefixPath`——schema 黑名单/TTL 场景改前缀）。反序列化必须走 `PathDeserializeUtil.deserialize`——按 `PathType` 标签分派到 PartialPath/MeasurementPath/AlignedPath 等子类。家族含 `MeasurementPath`（带 alias/schema）、`AlignedPath`、`IFullPath` 等。

`PathPatternTree`（451 行）把一批带通配符的模式收进前缀树供 schema 检索裁剪：`appendPathPattern()` 先在 list 里用 `include()` 去重（更宽的模式吸收更窄的），`constructTree()` 才真正建树——**"先攒模式、查询或序列化时才物化"**的惰性设计。核心查询 `intersectWithFullPathPrefixTree()`：给定存储侧全路径前缀树与查询模式树求交，得到真正需要下推的 pattern——schema fetch 跨 Region 裁剪的核心。使用方（grep 核实）：confignode 的 ClusterSchemaManager/ProcedureManager、pipe 的 IoTDBSchemaRegionSource、datanode 各 schema 查询 PlanNode。

### PlanNode 序列化：自序列化 + 枚举分派 + SPI 反序列化

**不存在 `PlanNodeSerializeVisitor`**（全仓 grep 无此类）——实际机制三层：① `PlanNode implements IConsensusRequest`（接口只有 `serializeToByteBuffer()`），基类 `serialize()` 固定格式：子类 `serializeAttributes()` → PlanNodeId → 子节点数 → 递归；`getType()` **默认直接抛 UnsupportedOperationException**——"不跨节点传输的算子不需要注册类型"，控制枚举膨胀。② `PlanNodeType` 枚举（~170 个常量）手工分配 short 编码，编号段有含义（0-109 树模型、1000+ 表模型、2000+ relational insert），**编码永不复用**——pipe 跨版本传输的兼容性约束。③ 静态块 `ServiceLoader.load(IPlanNodeDeserializerProvider.class)` 加载唯一 provider（datanode 经 META-INF/services 注册 `DataNodePlanNodeDeserializerProvider`）。

关键分工：`CommonPlanNodeDeserializer` 的 switch 只有 31 个 case 且全部是 1001+ 的**表模型算子**（因为这些类物理上就在 node-commons）；树模型算子类在 datanode，由 `DataNodePlanNodeDeserializer` 负责。`deserializeFromWAL()` 在 Common 反序列化器里直接抛异常——WAL 落盘回放是 datanode 独有职责。`isGeneratedByPipe` 标志 + `PIPE_ENRICHED_*` 节点类型是 pipe 把写计划原样传到接收端集群的通道。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `PartialPath.include/overlapWith` | 路径集合代数 | 全扇入爆炸点：改它影响权限/schema/pipe/订阅 |
| `PathPatternTree.intersectWithFullPathPrefixTree()` | 模式树求交 | schema fetch 跨 Region 裁剪 |
| `PlanNode.serialize()` | 自序列化 | 固定格式递归 |
| `PlanNode.getType()` | 类型注册 | 默认抛异常，跨节点才注册 |
| `ConsensusGroupId.Factory.create()` | 共识组反序列化 | thrift↔java 互转，漏分支抛 IllegalArgumentException |
| `ClientManager.borrowClient()` | 连接池借用 | returnClient 刻意不在接口（自动归还防泄漏） |
</details>

## 核心实现

### 分区类型体系

`SchemaPartition`（`Map<database, Map<TSeriesPartitionSlot, TRegionReplicaSet>>`）——注意源码首行就有 `// TODO: Remove this class`：v2 已迁移到 `SchemaPartitionTable`/`DataPartitionTable`/`SeriesPartitionTable`/`DatabaseScopedDataPartitionTable`，旧类只是兼容残留。`DataPartition` 是三维映射（db → seriesSlot → timeSlot → replica set 列表），`getDataRegionReplicaSetForWriting()` 的语义是**写入永远取每个 time partition 列表的最后一个 replica set**（源码 TODO 注明待改进）。`ConsensusGroupId` 体系（ConfigRegionId/SchemaRegionId/DataRegionId + Factory）是分区寻址的最终锚点。

### relational AST 公共层

`Node` 抽象基类（NodeLocation 溯源、`shallowEquals()` 忽略 children 供去重优化）；`IAstVisitor<R,C>` 竟只是**空标记接口**——真正的默认访问者是 `CommonQueryAstVisitor`（477 行 default 方法链）。分层已核实：`relational-grammar` 只含 ANTLR 文法不知道 AST 存在；node-commons 定义 AST；datanode 的 `AstBuilder`（4356 行）把 parse tree 翻译成 AST。**AST 放 commons 是因为三方都要引用**：parser（datanode）、执行引擎（calc-commons）、pipe 表语句转计划。

### 客户端连接池

`ClientManager<K,V>` 包装 commons-pool2 的 `GenericKeyedObjectPool`（按 TEndPoint keyed）；`ClientPoolFactory`（23.6K）为八类端点提供池——ConfigNode/DataNode Internal/MPPDataExchange/PipeTransfer/AINodeInternal/IoTConsensusV2/External 等，同步/异步双轨。`returnClient()` **刻意不放进接口**（源码注释："make you aware that the return of the client is automatic"）——防泄漏的 API 设计。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 自序列化 + 枚举分派 + SPI | PlanNode 体系 | 编译期格式钉死 + 运行期实现分派 |
| 泛型 Serializer 参数化 | `PathPatternNode<V, S>` | 同一树结构在 commons（纯模式）和 datanode（挂 schema value）复用 |
| 工厂 | `ConsensusGroupId.Factory`、`TVList.newList` | 多子类的统一构造入口 |
| 对象池 | ClientManager + commons-pool2 | Thrift 连接复用 |

## 模块间交互

向上服务全部四个核心模块；本模块是"改一处、震全仓"的扇入顶点——改 `PartialPath.include/overlapWith/matchFullPath` 会同时影响 confignode 权限与 schema 过滤、datanode schema 查询、pipe pattern 过滤、订阅，所有节点必须同步升级。

## 扩展方式

新增树模型 PlanNode 全流程：① datanode 建类继承对应基类，实现 `serializeAttributes(ByteBuffer)` 与 `(DataOutputStream)` 双重载 + 缓冲区构造器；② `PlanNodeType.java` 加枚举常量（**选从未用过的 short**，查注释里 occupied/deprecated 区段）；③ 覆写 `getType()`；④ `DataNodePlanNodeDeserializer` 的 switch 加 case；⑤ 若 pipe 需传输，改 `PipeTransferPlanNodeReq` 并处理版本兼容矩阵。表模型算子只改 commons 的 `relational/planner/node/` + CommonPlanNodeDeserializer——calc-commons 侧自动获得能力，无需改 datanode。新增共识组类型：thrift `TConsensusGroupType` 加枚举 → `Factory.create` 加分支 → 分配器与分区表适配 → datanode 路由识别。

> ⚠️ 待核实：`serializeUseTemplate()` 的具体调用方；SchemaPartition 旧类移除计划在 2.0.10 的完成度。
