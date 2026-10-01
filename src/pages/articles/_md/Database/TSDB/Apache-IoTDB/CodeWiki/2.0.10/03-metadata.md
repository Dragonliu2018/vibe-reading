---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "元数据引擎"
date: "2026-10-01T20:50:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "时序数据库", "元数据", "MTree", "倒排索引"]
description: "树/表双模型统一于 ISchemaRegion：MTree 组合式 MNode 体系、表设备复用树存储、Tag 内存倒排索引、Memory/PBTree 双实现与 Ratis/MLog 双持久化通道。"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

元数据引擎（`datanode/.../db/schemaengine` 约 4.2 万行 + node-commons `commons/schema` 1.3 万行）回答一个问题：**百万级设备、千万级测点的元数据，怎么在树模型（`root.sg.device.measurement`）和表模型（database/table/column）两套语义下统一存取**。答案是 `ISchemaRegion`（`schemaregion/ISchemaRegion.java`）一个接口同时定义树模型操作（`createTimeSeries`、`createAlignedTimeSeries`、`constructSchemaBlackList`）与表模型操作（`createOrUpdateTableDevice`、`updateTableDeviceAttribute`），落到同一个 Region 实现上。

这里有一个精巧的分治：**表模型的设备复用 MTree 存储**——`MTreeBelowSGMemoryImpl.createOrUpdateTableDevice()` 把表设备路径 `[tableName, deviceId...]` 作为 database 节点下的普通子树插入，用 `setToEntity(cur)` + `new TableDeviceInfo<>()` 标记表设备（误挂树模型路径会抛 `TABLE_DEVICE_NOT_UNDER_TREE_MODEL`）。而**列 schema 不在 SchemaRegion**——表结构是 database 级全局对象，由 ConfigNode 统一管理，DataNode 经 `DataNodeTableCache`（乐观锁版本号 + semaphore 限流）从 ConfigNode 拉取 `TsTable`。设备级海量数据留 region 分片，全局对象上收 ConfigNode——这是一致的分治原则（模板同此，见下文）。

## 模块架构

![元数据引擎架构](/vibe-reading/images/articles/iotdb-2.0.10/metadata-architecture.svg)

实现分两种模式，由 `SchemaRegionLoader` 扫 `@SchemaRegion(mode=...)` 注解反射选择构造器：`SchemaRegionMemoryImpl`（`MTreeBelowSGMemoryImpl` 2081 行 + `MemMTreeStore`，全内存，写操作记 MLog）与 `SchemaRegionPBTreeImpl`（`MTreeBelowSGCachedImpl` 1720 行 + `CachedMTreeStore`，PBTree 磁盘 B+ 树 + 内存 LRU 缓存）。

MNode 体系是**组合优先于继承**的范本：node-commons 定义角色接口（`IMNode`→`IInternalMNode`→`IDeviceMNode`/`IDatabaseMNode`、`IMeasurementMNode`）与泛型基类；内存实现 `BasicMNode`（parent、`subtreeMeasurementCount`、惰性 `fullPath`）→ `BasicInternalMNode`（volatile `children` + volatile `deviceInfo`，**懒分配省内存**——源码注释原话 "use cpu time to exchange memory"）。设备角色不靠子类区分，靠可空的 `deviceInfo` 组合对象：`TreeDeviceInfo`（树设备）、`TableDeviceInfo`（表设备，含指向 `DeviceAttributeStore` 的 `attributePointer`）、`DatabaseDeviceInfo`。`IInternalMNode.isDevice()` 就是 `getDeviceInfo() != null`。**alias 作为虚子节点**：`BasicInternalMNode.getChild(name)` 先查 children 再查 `deviceInfo.getAliasChild(name)`，路径查找对别名透明。

PBTree 模式的 `ICachedMNode` 附加 `CacheEntry` + `LockEntry` 两个指针——节点必须携带自己的缓存身份，因为**逐出单位是子树而非节点**（`MemoryManager.java` 注释 "cache eviction on node is actually evicting a subtree"：缓存对象是 trie，逐出单个中间节点会撕裂父子链）。`LRUNodeCache` 是分段 LRU（`NUM_OF_LIST` 个桶按 hashCode 分片降锁竞争）。

## 调用链路

![Schema 变更传播](/vibe-reading/images/articles/iotdb-2.0.10/metadata-write-path.svg)

一条 schema 变更从共识层进入：`SchemaRegionStateMachine.write(request)` → `((PlanNode) request).accept(new SchemaExecutionVisitor(), schemaRegion)`——Visitor 分发 30+ 个 `visitCreateTimeSeries`/`visitCreateOrUpdateTableDevice`/`visitDeactivateTemplate`。持久化通道由共识协议决定（`SchemaRegionMemoryImpl.init()`）：**非 Ratis**（单机/旧协议）`usingMLog = true`，先改内存再 `writeToMLog(plan)`（`SchemaLogWriter` + `SchemaRegionPlanSerializer`），`SchemaEngine.forceMlog()` 定时刷盘，重启走 `initFromLog()` → `applyMLog()`（`RecoverPlanOperator` 逐条重放，`isRecovering=true` 时不回写防循环）；**Ratis 模式** `usingMLog = false`，工作目录直接清空重建，持久化与复制完全交给 Ratis log + `takeSnapshot()`/`loadSnapshot()`（返回 boolean 以满足 Ratis AddPeer 流程的失败感知）。写入成功后 `PipeDataNodeAgent.runtime().schemaListener().tryListenToNode(request)` 把变更推给 pipe——这是数据订阅/同步的 schema 事件源。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ISchemaRegion.createTimeSeries` | 树模型建序列 | 配额双闸门（单机 + 集群心跳上报） |
| `MTreeBelowSGMemoryImpl.createOrUpdateTableDevice()` | 表设备入树 | 复用 MTree，Info 组合区分角色 |
| `BasicInternalMNode.getChild(name)` | 路径查找 | alias 虚子节点透明映射 |
| `TagManager.getMatchedTimeseriesInIndex(TagFilter)` | Tag 检索 | 内存二级倒排索引；当前仅单 filter |
| `TagManager.recoverIndex(offset, node)` | 重启重建索引 | 索引不持久化，MLog 重放时重建 |
| `SchemaRegionMemoryImpl.activateSchemaTemplate()` | 模板激活 | 两阶段（预挂载→激活），自动建设备 |
| `mTree.getDeviceNodeWithAutoCreating(path)` | 写入自动建路径 | 建设备动作本身记 MLog |
| `fetchSeriesSchema(patternTree, templateMap, ...)` | 查询期 schema 获取 | 模板测量点不物化，动态展开 |
</details>

## 核心实现

### Tag/Attribute 检索：内存倒排 + 磁盘 append-only

`TagManager`（`schemaregion/tag/`）维护 `Map<tagKey, Map<tagValue, Set<IMeasurementMNode>>>` 的**二级倒排索引**，纯内存。tag/attribute 的 value 本体不进 MNode——`AbstractMeasurementMNode.getOffset()` 只是 `TagLogFile` 中的文件偏移，MTree 构造时注入 `tagManager::readTags` 惰性 getter，**读 tag 才落盘**。查询 `getMatchedTimeseriesInIndex(TagFilter)` 支持 equals 与模糊匹配（线性扫该 key 的 value 层，当前仅支持单 TagFilter——代码注释明示 "currently, only one TagFilter is supported"）。持久化上有个值得注意的决策：**索引不持久化**——快照只拷贝 `TagLogFile`，重启时 MLog replay 对每个带 offset 的测点调 `recoverIndex()` 重建内存索引，换取写路径零索引维护成本。

### 模板机制：集群级对象 + 两阶段激活

`Template`（node-commons）极简（id/name/`schemaMap`），但管理是集群级的：`ClusterTemplateManager` 直接发 `TCreateSchemaTemplateReq` 给 ConfigNode，本地仅缓存四张 map（id/name/挂载点/预挂载）。SchemaRegion 侧生命周期两阶段：`activateSchemaTemplate()`（`SchemaRegionMemoryImpl.java:1399` 起）调 `getDeviceNodeWithAutoCreate()` 自动建设备后 `mTree.activateTemplate()` + 记 MLog；挂载后测量点**不物化**进 MTree，查询时 `fetchSeriesSchema(patternTree, templateMap, ...)` 携带模板动态展开——海量同构设备不为每个测点付存储。

### AutoCreateSchema：写入即建元数据

入口在查询引擎侧 `AutoCreateSchemaExecutor.autoCreateTimeSeries()`（按写入值类型选默认 encoding/compressor，经 coordinator 生成写计划），最终落到 `mTree.getDeviceNodeWithAutoCreating(path)` 自动补全中间节点并把建设备动作记 MLog。配额双闸门：单机 `checkSchemaQuota` 与集群级 `DataNodeSchemaQuotaManager`（`SchemaEngine.updateAndFillSchemaCountMap` 借心跳上报 leader 侧 region 用量）。

### 写读模型分离

写侧是 `IMemMNode`/`ICachedMNode`（volatile children + `LockManager` 细粒度路径锁），读侧快照是 `queryengine/common/schematree/` 下的 `SchemaMeasurementNode`/`SchemaEntityNode`/`ClusterSchemaTree`——查询拿快照免锁遍历，写侧并发更新互不影响。同一套 MTree 算法（Traverser/Collector/Updater）通过 `IMNode<N extends IMNode<N>>` 自泛型接口同时服务 Mem 与 Cached 两套节点。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 注解 + 反射工厂 | `SchemaRegionLoader` 扫 `@SchemaRegion(mode)` | Memory/PBTree 切换零 if-else |
| 组合优于继承 | `deviceInfo` 可空组合；`MeasurementMNode = BasicMNode + MeasurementInfo` | 节点角色 × 实现模式正交，避免 2×N 类爆炸 |
| 自泛型接口 | `IMNode<N extends IMNode<N>>` | 同一算法泛化到两套节点 |
| 访问者 | `SchemaExecutionVisitor` / `SchemaRegionPlanVisitor` / `RecoverPlanOperator` | 共识回放、MLog 序列化、执行共用同一 Plan 类型 |
| 惰性求值 | `getFullPath()` 首拼缓存；tag 经闭包读盘 | 海量节点，用不到不付内存 |
| 模板方法 | `AbstractMeasurementMNode` 等 | 骨架固定，特化下沉 |

## 模块间交互

元数据引擎向上被查询引擎（schema fetch、AutoCreate、schema 查询算子）和存储引擎（表模型写入时 `registerToTsFile` 注册 `TableSchema`）调用；横向经 `SchemaRegionConsensusImpl` 接 Ratis 共识（读配 `Read.Option.LINEARIZABLE`——避免 stale schema 导致写错 TsFile）；向 ConfigNode 拉全局对象（列 schema、模板）；向 pipe 发 schema 变更事件。`SchemaEngine`（单例，`schemaRegionMap: ConcurrentHashMap<SchemaRegionId, ISchemaRegion>`）扫 `schema_dir/<database>/<regionId>` 目录多线程并发恢复。注意 SchemaPartition 与 DataPartition 同构（database × series slot）但独立成组，由 ConfigNode 统一分配。

## 扩展方式

新增一种 schema 写操作（如新 DDL）要动 5 处：`ISchemaRegion` 加接口 → `SchemaRegionMemoryImpl`/`SchemaRegionPBTreeImpl` 各实现 → `SchemaExecutionVisitor` 加 `visitXxx` → `SchemaRegionPlanType`/`Serializer`/`Deserializer`（`logfile/visitor/`）加日志编解码（**漏了这步，非 Ratis 模式重启丢操作**）→ PlanNode 挂进 `SchemaRegionStateMachine.write` 分发链。给 Tag 检索加多条件 AND 要改 `getMatchedTimeseriesInIndex` 的单 filter 假设并同步 `recoverIndex` 重放路径。调整 PBTree 内存策略改 `MemoryManager`（子树逐出）与 `ReleaseFlushMonitor`（周期）。

> ⚠️ 待核实：模板挂载后查询期物化展开的具体函数（`MTreeBelowSGMemoryImpl.fetchSeriesSchemaWithTemplate*`）；表模型 region 与树模型 region 能否共存于同一 database。
