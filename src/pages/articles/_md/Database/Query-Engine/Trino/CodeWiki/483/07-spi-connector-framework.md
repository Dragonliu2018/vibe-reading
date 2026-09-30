---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "SPI 与连接器框架"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "SPI", "连接器", "classloader 隔离"]
description: "Trino 483 SPI 合约层与引擎侧连接器框架：三级工厂、PluginClassLoader 隔离、三子连接器对象树"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

SPI 是 Trino 插件生态的**版本化兼容合约**：连接器只编译依赖 `trino-spi` 就能跨 Trino 版本运行。引擎侧框架（`trino-main/connector/`）负责发现插件、组装连接器对象树、管理 catalog 动态装卸与事务边界。数百个第三方 connector 能独立于引擎演进——整个生态的根基就在这一层。

规模：`core/trino-spi` 主代码 558 文件 ~73.9K 行（pom 仅依赖 jackson-annotations/slice/opentelemetry，**零 trino-* 依赖**）；`trino-main/connector/` 86 文件。

## 模块架构

两侧看：**SPI 侧**（合约本体——Plugin 入口、Connector 能力接口、Metadata/PageSource/PageSink/Split/事务/值模型/函数注解）与**引擎侧**（PluginManager 装载、`DefaultCatalogFactory` 组装、CatalogManager 动态管理、ConnectorServices 能力缓存）。一个用户 catalog 在引擎内部展开为**三个子连接器**的复合体——这是最容易被忽视的关键设计。

## 调用链路

```
插件发现：ServerPluginsProvider.loadPlugins（plugin.dir 目录扫描）
 └─ 每 plugin 一个 PluginClassLoader + ServiceLoader.load(Plugin.class)
     └─ PluginManager.installPluginInternal
         ├─ ConnectorFactory → CatalogFactory.addConnectorFactory
         └─ plugin.getFunctions() 经 InternalFunctionBundle 进 GlobalFunctionCatalog

catalog 创建：CatalogManager.createCatalog
 └─ DefaultCatalogFactory.createCatalog(CatalogProperties)
     ├─ createConnector：ConnectorContextInstance（TypeManager/NodeManager/Metadata 桥）
     │   在 ThreadContextClassLoader 内调 connectorFactory.create(...)
     └─ 组装 CatalogConnector（一个用户 catalog = 三个子连接器）：
         getMaterializedConnector(NORMAL)           → 连接器本体
         getMaterializedConnector(INFORMATION_SCHEMA)→ InformationSchemaConnector（内置）
         getMaterializedConnector(SYSTEM)            → SystemConnector（内置）
       ConnectorServices 构造函数急切缓存全部能力：
         systemTables/procedures/tableFunctions/splitManager/pageSinkProvider
         /indexProvider/partitioningProvider（各 Optional，靠捕获
         UnsupportedOperationException 探测）+ accessControl + 8 类 property map

查询期：TransactionManager.beginTransaction
 └─ Catalog.beginTransaction (:161)：对三个子连接器各调 connector.beginTransaction
 └─ CatalogTransaction.getConnectorMetadata(session)（synchronized 惰性单例）
     └─ connector.getMetadata + tracing 代理包装

执行期桥接：
 MetadataManager.getTableHandle (:291) → CatalogMetadata.getMetadataFor
 SplitManager.getSplits (split/SplitManager.java:69) → ConnectorSplitManager
 TableScanOperator (:273) → PageSourceManager.PageSourceProviderInstance
     .createPageSource（Session→ConnectorSession 适配 + 动态过滤短路）
     → SPI ConnectorPageSourceProvider.createPageSource(...)
```

<details>
<summary>核心接口速查</summary>

| 接口 | 代表方法 | 说明 |
| --- | --- | --- |
| `Plugin` | `getConnectorFactories()` / `getFunctions()` | 纯 default 方法的聚合入口（~17 类工厂） |
| `ConnectorFactory` | `getName()` / `create(catalogName, config, context)` | 每 connector 名一个 |
| `Connector` | `beginTransaction(...)` / `getMetadata(session, txn)` / `getSplitManager()` / `commit/rollback` | 全 default 抛 UnsupportedOperationException——能力靠异常探测 |
| `ConnectorMetadata` | `getTableHandle(...)` / `listTables(...)` / `beginInsert(...)` / `beginQuery/cleanupQuery` | 1866 行 156 方法全 default |
| `ConnectorPageSource` | `getNextSourcePage()` / `isFinished()` / `isBlocked()` | 产出 SourcePage |
| `ConnectorPageSink` | `appendPage(Page)` / `finish()` / `abort()` | 全异步 CompletableFuture |

</details>

## 核心实现

### 值模型：Page/Block 的 appendXxx/getXxx

`Page` = `Block[] blocks + int positionCount`（列=channel，行=position）。类型化访问在具体块上：`LongArrayBlockBuilder.writeLong(long)` / `LongArrayBlock.getLong(int)`、`IntArrayBlockBuilder.writeInt`…，`appendNull()` 处理空值。底层是 primitive 数组（`LongArrayBlockBuilder` 内 long[]）——零装箱零虚调用，`getSizeInBytes()/getRetainedSizeInBytes()` 直接支撑内存记账。483 进一步把 Block 拆为 raw Block（带 offset 语义）+ `ValueBlock`（纯值）：`DictionaryBlock/RunLengthBlock` 可包任意 ValueBlock。若用对象模型，每值一次分配+指针追踪，向量化算子无从谈起。

### PluginClassLoader：最小共享面

`PluginClassLoader`（server/PluginClassLoader.java:100）的 parent 是 **platform classloader 而非 application classloader**——引擎内部类（Guava/Jackson 等传递依赖）对插件完全不可见，防插件依赖引擎实现细节；引擎与插件的 Guava 版本互不冲突。唯一例外是 `SPI_PACKAGES` 白名单（`io.trino.spi.`、jackson 注解、slice、opentelemetry、jts 及 4 个 Blackbird 叶子接口）委托给共享的 spi classloader 保证**跨 classloader 类型同一性**（HandleResolver 反序列化、lambda 接口必需）。插件自带 SPI 类副本会直接报错（"应加 provided scope"）。

### 事务：为什么连接器需要 commit/rollback

javadoc 明确 "even in auto-commit mode" 也保证 commit/rollback 恰一次（Connector.java:32-40）。动机是 Hive 类 metastore 连接器需要**每查询取一致元数据快照**：`ConnectorMetadata` 绑定在事务生命周期上（`CatalogTransaction` 持有它，synchronized 惰性单例），同一查询内 catalog 刷新也不换实例（MetadataManager 侧按 `QueryId` 跟踪）。`isSingleStatementWritesOnly` 让不支持多语句写事务的连接器声明约束、由引擎兜底。

### Catalog 动态装卸

`CatalogManager.createCatalog/dropCatalog`（metadata/CatalogManager.java:55-80）由 `CoordinatorDynamicCatalogManager` 实现——catalog 本质是 ConcurrentMap + 持久化 `catalogStore.addOrReplaceCatalog`，连接器实例本来就是按需创建的对象，无需重启。多 coordinator 经共享 CatalogStore 收敛。**worker 端不推送**：`PlanFragment.getActiveCatalogs` 随查询下发，`SqlTaskManager.java:559` 的 `ensureCatalogsLoaded` 惰性拉起，`CatalogPruneTask` 回收闲置。

### 系统表与 information_schema

`GlobalSystemConnector`（connector/system/）注册成内置 `system` catalog；`system.metadata.catalogs` 即 `CatalogSystemTable implements SystemTable`：`getDistribution()=SINGLE_COORDINATOR`、`cursor(transactionHandle, session, constraint)` 用 `InMemoryRecordSet.Builder` 逐行灌数据（`MetadataListing.listCatalogs`）。information_schema 是**引擎内置连接器**（非插件，`implements InternalConnector`），每个用户 catalog 实例化一份——所以 `information_schema.tables` 天然按 catalog 隔离。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 三级工厂 | Plugin → ConnectorFactory → Connector | 发现单元/每名一次/每 catalog 一实例，三个生命周期粒度 |
| 能力探测 | `Connector` 全 default 抛异常 + `ConnectorServices` 捕获缓存 | 接口演进不破坏旧实现 |
| 注解扫描 | `InternalFunctionBundleBuilder.functions(Class)` 分派三类解析器 | 函数定义即声明 |
| 复合 | CatalogConnector 三子连接器 | NORMAL/INFO_SCHEMA/SYSTEM 统一在一个事务里 |

## 模块间交互

- **桥接点**：`MetadataManager` ↔ `CatalogMetadata`（三事务路由，metadata/CatalogMetadata.java:90）；`TableScanOperator` → `split/PageSourceProvider` 接口 → `PageSourceManager` 适配到 SPI；
- **服务定位**：`ConnectorCatalogServiceProvider.getService(catalogHandle)` = `ConnectorServicesProvider.getConnectorServices(catalogHandle)` + lambda 取服务——SplitManager/PageSourceManager/PageSinkManager 共用此模式；
- **函数注册**：`PluginManager.installPlugin`（server/PluginManager.java:241-246）拿 `plugin.getFunctions()` 的 Class 列表交给 `InternalFunctionBundle.builder().functions(class)`——WindowFunction 子类→`WindowAnnotationsParser`、`@AggregationFunction`→`SqlAggregationFunction.createFunctionsByAnnotations`、`@ScalarFunction/@ScalarOperator`→`ScalarFromAnnotationsParser`；
- **revapi 门禁**：trino-spi 的 pom 配置 revapi-maven-plugin 做二进制兼容性检查（允许加注解、禁破坏性变更）——SPI 演进纪律的机械化保障。

## 扩展方式

**写一个新连接器（最小集）**：参照 `plugin/trino-example-http`（17 个文件）——`ExamplePlugin→ExampleConnectorFactory→ExampleConnector`，后者只需实现 `beginTransaction`（返回单例 handle）、`getMetadata`、`getSplitManager`、`getRecordSetProvider`（记录集路径自动被 `RecordPageSourceProvider` 包装成 Page），外加 Table/Column/Split 三个句柄类。走读详解见[连接器生态](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/12-connector-ecosystem)。

**加系统表**：实现 `SystemTable`（cursor/pageSource/splitSource 三选一），注入 `GlobalSystemConnectorModule` 或在目标 Connector 的 `getSystemTables()` 返回。

**SPI 加方法的代价**：非 default 新抽象方法会让所有存量连接器编译失败且 revapi 拦截——SPI 演进几乎只用 default 方法 + 运行时抛异常；破坏性改动只能开 v2 接口或新方法重载（如 `createPageSource` 带/不带 MemoryContext 两个 overload 共存的 TODO 注释所示）。
