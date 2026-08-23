---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "联邦数据源"
date: "2026-08-23T18:30:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "ExternalCatalog", "Hive", "Iceberg", "联邦查询"]
description: "Doris 联邦数据源：ExternalCatalog 抽象 + Lazy 加载 + 双层元数据缓存 + MVCC 一致性快照。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

联邦数据源模块（`fe/fe-core/.../datasource/`，~8.2 万行）让 Doris 用统一 SQL 访问外部数据湖与系统——Hive、Iceberg、Hudi、JDBC、Paimon、MaxCompute、ES 等。它通过 `ExternalCatalog` 抽象隔离各引擎差异，用双层元数据缓存降低远程访问，用 MVCC snapshot 保证查询内一致性。独立成文是因为外部系统的元数据获取方式、缓存策略、读路径都与内部表不同——Doris 不作为数据代理，BE 直接读外部文件。

## 模块架构

模块核心是 `CatalogIf` 接口体系与双层缓存。`CatalogMgr` 用双索引（id→catalog、name→catalog）管理所有 catalog，`InternalCatalog` 管内部表，`ExternalCatalog` 是所有外部 catalog 的抽象基类。元数据缓存分两套：旧版 `MetaCache<T>`（Caffeine LoadingCache，catalog/database/table 级）和新版引擎级 `AbstractExternalMetaCache`（按引擎注册 schema/partition/file 等条目）。

```
CatalogMgr (idToCatalog + nameToCatalog)
  ├─ InternalCatalog (内部表)
  └─ ExternalCatalog (抽象基类, lazy init)
       ├─ HMSExternalCatalog (Hive)
       ├─ IcebergExternalCatalog
       ├─ HudiExternalCatalog
       ├─ JdbcExternalCatalog
       ├─ PaimonExternalCatalog
       └─ ...
  └─ ExternalMetaCacheMgr (引擎级缓存路由)
       ├─ HiveExternalMetaCache (schema/partition/file/partition_values 条目)
       ├─ IcebergExternalMetaCache
       └─ ...
```

## 调用链路

查询外部表 `SELECT * FROM hive_catalog.db1.table1`：

```
第一层：Catalog → Database → Table
CatalogMgr.getCatalog("hive_catalog") (CatalogMgr.java:171)
  → ExternalCatalog.makeSureInitialized (ExternalCatalog.java:368)
    → initLocalObjectsImpl  // 子类初始化 HMS client
    → buildMetaCache
  → getDbNullable("db1") → metaCache.getMetaObj  // (miss) buildDbForInit → new HMSExternalDatabase
  → ExternalDatabase.makeSureInitialized → getTableNullable("table1")
    → metaCache.getMetaObj  // (miss) buildTableForInit → new HMSExternalTable

第二层：Schema 缓存或回源
ExternalTable.getFullSchema (ExternalTable.java:176)
  → getSchemaCacheValue → ExternalMetaCacheMgr.getSchemaCacheValue
    → engine(HIVE).getSchemaValue(catalogId, key) → MetaCacheEntry.get
      → (miss) loadSchemaCacheValue → externalCatalog.getSchema(key)
        → db.getTable(name).initSchemaAndUpdateTime
          → loadHiveTable → client.getSchema (HiveMetaStore Thrift API)

第三层：生成 ExternalScanNode → 下推 BE
Nereids PhysicalFileScan → PhysicalPlanTranslator.visitPhysicalFileScan (PhysicalPlanTranslator.java:725)
  → switch on table type:
    HMSExternalTable+DLA=HIVE → new HiveScanNode
    HMSExternalTable+DLA=ICEBERG → new IcebergScanNode
    IcebergExternalTable → new IcebergScanNode
    PaimonExternalTable → new PaimonScanNode
  → scanNode.init → computeColumnsFilter + initBackendPolicy (FederationBackendPolicy)
  → getScanRangeLocations → TScanRangeLocations → Thrift 下发 BE
[BE 用 FileSystem API 直接读外部文件]
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `CatalogMgr.createCatalog` | 创建外部 catalog | 注册后 resetToUninitialized (lazy) |
| `ExternalCatalog.makeSureInitialized` | 延迟初始化 | synchronized 防重入 |
| `ExternalCatalog.getDbNullable` | 获取 db | 从 metaCache，miss 则 buildDbForInit |
| `ExternalTable.getFullSchema` | 获取 schema | 走 SchemaCache，miss 回源 HMS |
| `ExternalMetaCacheMgr.getSchemaCacheValue` | 引擎级缓存 | 按引擎路由 + Caffeine |
| `FederationBackendPolicy` | 选 BE | 一致性哈希提高 FileCache 命中 |
| `ExternalCatalog.resetToUninitialized` | 重置缓存 | 改属性时清缓存 |

</details>

## 核心实现

### Lazy 加载

`CatalogMgr.addCatalog`（`datasource/CatalogMgr.java:119`）注册时立刻 `resetToUninitialized(false)` 标记 `initialized = false`。只有首次访问（`getDbNames`/`getTableNullable`）才触发 `makeSureInitialized`（`ExternalCatalog.java:368`）：`initLocalObjects`（只一次，初始化 HMS client）→ `buildMetaCache` → `initialized = true`。`gsonPostProcess` 也会强制 `initialized = false`（`ExternalCatalog.java:962`），确保 FE 重启后所有外部 catalog 重新 lazy 加载。

**为什么 lazy**：外部 catalog 依赖第三方系统（HMS/Glue/REST catalog），启动时全量初始化会导致 FE 启动极慢、远端不可用时 FE 无法启动、浪费内存（很多 catalog 可能从不被查询）。

### 双层缓存体系

**旧版 `MetaCache<T>`**（`datasource/metacache/`，基于 Caffeine LoadingCache）：catalog 级缓存 `ExternalDatabase`、database 级缓存 `ExternalTable`，两个 LoadingCache（`namesCache` 名列表 + `metaObjCache` 对象缓存），支持异步刷新与过期。

**新版引擎级 `ExternalMetaCache`**（接口）+ `AbstractExternalMetaCache`：按引擎（hive/iceberg/paimon）注册多种缓存条目（schema/partition_values/partition/file），结构 `Map<Long catalogId, CatalogEntryGroup>` → `Map<String entryName, MetaCacheEntry<K,V>>`，每个条目独立 `CacheSpec`（TTL、最大容量）和 `CacheLoader`。`HiveExternalMetaCache`（`datasource/hive/HiveExternalMetaCache.java:134`）注册 4 类条目：`schemaEntry`/`partitionValuesEntry`/`partitionEntry`/`fileEntry`。`ExternalMetaCacheRouteResolver` 按 catalog 引擎类型路由到正确实例。

### MVCC 一致性

`MvccSnapshot`（`datasource/mvcc/MvccSnapshot.java`）是空标记接口，由各引擎子类实现（如 `IcebergMvccSnapshot` 封装 Iceberg snapshot id）。`MvccUtil.getSnapshotFromContext`（`datasource/mvcc/MvccUtil.java:33`）从 `StatementContext` 获取当前查询的 snapshot：

```java title="datasource/mvcc/MvccUtil.java"
public static Optional<MvccSnapshot> getSnapshotFromContext(TableIf tableIf) {
    StatementContext ctx = ConnectContext.get().getStatementContext();
    return ctx.getSnapshot(tableIf);  // 同一查询内 snapshot 不变
}
```

这保证一条 SQL 执行期间看到一致的元数据视图——即使外部系统并发修改，partition 列表、schema 不中途变化。`HMSExternalTable.getPartitionColumns(Optional<MvccSnapshot>)` 将 snapshot 传给缓存 key，不同 snapshot 请求查不同缓存条目。

### ExternalScanNode 下推 BE

`ExternalScanNode`（`datasource/ExternalScanNode.java:42`）持有 `FederationBackendPolicy`，根据 `enableFileCache` 或 `useConsistentHashForExternalScan` 决定用一致性哈希还是随机选 BE。一致性哈希策略使同一文件扫描倾向同一 BE，提高文件元数据缓存（`FileCacheAdmissionManager`）命中率。`FileScanNode.toThrift` 序列化为 `TFileScanNode`，`getScanRangeLocations` 返回 `List<TScanRangeLocations>`（含文件路径、split 范围、目标 BE）。BE 收到后用文件系统 API（S3/HDFS/本地）直接读外部文件，**Doris 不作为数据代理**。

### ExternalMetaIdMgr 稳定 ID

`ExternalMetaIdMgr`（`datasource/ExternalMetaIdMgr.java`）管理 HMS 事件同步场景下 db/table/partition 的稳定 ID 映射，用 `Util.genIdByName(catalogName, dbName, tableName)` 基于名称确定性生成 ID（而非自增），使不同 FE 节点对同一外部对象生成相同 ID，是 `MetastoreEventsProcessor` 的基础。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 接口多态 | `CatalogIf`/`ExternalCatalog` 抽象 | 统一 catalog 操作契约，泛型约束类型安全 |
| 双层缓存 | `MetaCache` + `AbstractExternalMetaCache` | 旧版兼容 + 新版引擎级细粒度 |
| Lazy 加载 | `makeSureInitialized` | 避免启动慢与远端不可用阻塞 |
| Property 配置 | `CatalogProperty` | 分层懒加载派生属性，改属性时清缓存 |
| 一致性哈希 | `FederationBackendPolicy` | 提高 FileCache 命中率 |

## 模块间交互

被 `nereids` 调（`PhysicalPlanTranslator.visitPhysicalFileScan` 按 `ExternalTable` 类型选 `XxxScanNode`，所有 ScanNode 继承 `FileScanNode → ExternalScanNode → ScanNode`）；catalog 注册在 `Env`（`Env.getCatalogMgr`，FE 启动从 edit log 反序列化恢复，`gsonPostProcess` 重建 `nameToCatalog`）；`statistics` 调（`ExternalTable.createAnalysisTask`/`getColumnStatistic`，行数经 `ExternalRowCountCache` 异步加载）；与 metastore/client 交互（`HMSExternalCatalog.initLocalObjectsImpl` 创建 `HiveMetadataOps` 持 `HMSCachedClient` Thrift client，所有远程操作经 `ExternalMetadataOps` 接口）。

## 扩展方式

新增一个外部 Catalog（如 Delta Lake）：`InitCatalogLog.java` 的 `Type` 枚举加 `DELTA_LAKE`；`CatalogFactory.createCatalog`（`datasource/CatalogFactory.java:88`）switch 加分支；`ExternalCatalog.buildDbForInit`（`ExternalCatalog.java:918`）switch 加实例化；新建 `delta/` 子目录实现 `DeltaExternalCatalog`（`initLocalObjectsImpl`/`listTableNamesFromRemote`/`tableExist`）、`DeltaExternalDatabase`（`buildTableInternal`）、`DeltaExternalTable`（`initSchema`/`getMetaCacheEngine`/`fetchRowCount`）、`DeltaExternalMetaCache`（`registerEntry` 注册条目）；`ExternalMetaCacheMgr.registerBuiltinEngineCaches`（`ExternalMetaCacheMgr.java:304`）注册新引擎缓存；`PhysicalPlanTranslator.visitPhysicalFileScan` 加 `table instanceof DeltaExternalTable` 分支创建 ScanNode。
