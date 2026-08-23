---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "联邦数据源"
date: "2026-08-23T20:02:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.11-rc01"]
tags: ["Apache Doris", "ExternalCatalog", "Multi-Catalog", "Caffeine", "Hive", "Iceberg", "懒加载"]
description: "Doris 2.1.11 联邦数据源：ExternalCatalog 模板方法 + ExternalMetadataOps 策略 + Caffeine 三级懒缓存（Catalog/DB/Schema）。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.11-rc01/00-overview)

---

## 模块定位

联邦数据源是 `fe/fe-core/src/main/java/org/apache/doris/datasource/`（~4.7 万行，249 文件），负责外部数据源联邦查询——Hive/Iceberg/Hudi/Paimon/ES/JDBC/MaxCompute 等。核心是 `ExternalCatalog` 抽象基类 + 三级懒缓存（Caffeine）减少远端元数据访问。独立成文是因为外部元数据获取昂贵且异构（HMS Thrift、ES REST、JDBC driver 各不同协议），需要独立缓存与抽象层。2.1 中 `InternalCatalog`（内部库表）也迁移到此包，统一在 `CatalogIf` 接口下。

## 模块架构

```
ExternalCatalog (datasource/ExternalCatalog.java:100) abstract
   implements CatalogIf<ExternalDatabase<? extends ExternalTable>>, Writable
   ├─ makeSureInitialized() (:288)  ── final synchronized 模板方法
   │    ├─ initLocalObjects() → initLocalObjectsImpl()  ── 抽象钩子
   │    └─ [useMetaCache] buildDbForInit() (:860)  ── switch(logType)
   ├─ listDatabaseNames() (:216)  ── 委托 metadataOps
   └─ metadataOps : ExternalMetadataOps
   │
   ▼ 继承体系
HMSExternalCatalog (hive/HMSExternalCatalog.java:71)     ── Hive Metastore
EsExternalCatalog (es/EsExternalCatalog.java:42)         ── Elasticsearch
JdbcExternalCatalog (jdbc/JdbcExternalCatalog.java:64)    ── 通用 JDBC
IcebergExternalCatalog (iceberg/, abstract)
   ├─ IcebergHMSExternalCatalog / IcebergHadoopExternalCatalog
   ├─ IcebergGlueExternalCatalog / IcebergRestExternalCatalog
   └─ IcebergDLFExternalCatalog
PaimonExternalCatalog (paimon/, abstract)
   ├─ PaimonHMSExternalCatalog / PaimonFileExternalCatalog
   └─ PaimonDLFExternalCatalog
   │
   ▼ 三级懒缓存
Catalog 级: makeSureInitialized() (:288)  ── 首次访问才初始化客户端
DB/Table 级: MetaCache<T> (metacache/MetaCache.java:38)  ── Caffeine LoadingCache
Schema 级: ExternalSchemaCache (ExternalSchemaCache.java:41)  ── Caffeine LoadingCache
   │
   ▼ 工厂
CatalogFactory.createFromStmt() (CatalogFactory.java:87)  ── switch(catalogType) 实例化
CatalogMgr (CatalogMgr.java:86)  ── nameToCatalog/idToCatalog 管理 Multi-Catalog
```

## 调用链路

查询外部表流程（以 Hive 外表为例）：

```
SQL → CatalogMgr.getCatalog(name) [CatalogMgr.java:161]
  → ExternalCatalog.getDbNullable(dbName) [ExternalCatalog.java:650]
    → makeSureInitialized() (:655)                    ── 惰性初始化
      → [useMetaCache] metaCache.getMetaObj() → Caffeine loader → buildDbForInit()
      → [!useMetaCache] init() → listDatabaseNames() → metadataOps → 远端
  → ExternalDatabase.getTable() → ExternalTable 子类
  → ExternalTable.getFullSchema() [ExternalTable.java:171]
    → ExternalSchemaCache.getSchemaValue() [ExternalSchemaCache.java:84]
      → [miss] loadSchema() → catalog.getSchema() → table.initSchema() → 远端
  → 生成 ExternalScanNode/FileScanNode
    → metadataOps 获取分区/文件 split → SplitAssignment 下发 BE
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `ExternalCatalog.makeSureInitialized` | 惰性初始化 | final synchronized 模板方法，首次访问才连外部系统 |
| `ExternalCatalog.initLocalObjectsImpl` | 初始化客户端 | 抽象钩子，子类填具体（HMS/ES/JDBC client） |
| `MetaCache.getMetaObj` | DB/Table 缓存 | Caffeine LoadingCache，miss 触发 loader |
| `ExternalSchemaCache.getSchemaValue` | Schema 缓存 | Caffeine，miss 调 loadSchema 远端拉取 |
| `CatalogFactory.createFromStmt` | 创建 Catalog | switch(catalogType) 工厂分发 |
| `ExternalCatalog.buildDbForInit` | DB 实例化 | switch(logType) 统一在基类 |

</details>

## 核心实现

### Template Method + 三级懒缓存

`makeSureInitialized()`（`ExternalCatalog.java:288`）是 `final synchronized` 模板方法，定义初始化骨架：先 `initLocalObjects()`（→抽象 `initLocalObjectsImpl()` 钩子，子类填具体客户端初始化），再按 `useMetaCache` 分支。注释（`:284-287`）："Catalog can't be init when creating because the external catalog may depend on third system."

三级懒加载：
1. **Catalog 级**：`makeSureInitialized()` 首次调用才初始化外部客户端，expireAfterWrite=86400s（24h）
2. **DB/Table 级**：`MetaCache<T>`（`metacache/MetaCache.java:38`）用 Caffeine `LoadingCache`，`getMetaObj()`（`:90`）miss 触发 loader
3. **Schema 级**：`ExternalSchemaCache`（`:41`）用 Caffeine `LoadingCache<SchemaCacheKey, Optional<SchemaCacheValue>>`，`getSchemaValue()`（`:84`）miss 调 `loadSchema()`

### Strategy（ExternalMetadataOps）+ Multi-Catalog

各外部源实现 `ExternalMetadataOps` 接口（`operations/ExternalMetadataOps.java:32`）提供不同访问策略：`listDatabaseNames()`/`listTableNames()`/`tableExist()` 等。子类在 `initLocalObjectsImpl()` 实例化自己的 `metadataOps`（HMS 用 `HiveMetadataOps`，JDBC 用 `JdbcMetadataOps`）。基类方法统一委托给 `metadataOps`，实现策略透明切换。

`CatalogMgr`（`CatalogMgr.java:86`）用 `nameToCatalog`/`idToCatalog` 两个 Map 管理 Multi-Catalog，`internal` 是默认 `InternalCatalog`，其余均为 `ExternalCatalog` 子类。`CatalogFactory.createFromStmt()`（`:87`）按 `catalogType` switch 实例化（`:117-136`），`InitCatalogLog.Type` 枚举（`:35`：HMS/ES/JDBC/ICEBERG/PAIMON/MAX_COMPUTE/TEST）决定 `buildDbForInit()`（`:921`）实例化哪种 `ExternalDatabase`。

### Master/非 Master 转发

当 `useMetaCache == false` 且当前非 Master 时，`makeSureInitialized()`（`:306-317`）通过 `MasterCatalogExecutor.forward(id, -1)` 转发到 Master 等待 journal 回放——非缓存模式元数据变更需 EditLog 持久化保证多 FE 一致性。缓存模式下各节点独立缓存，无需 Master 协调。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Template Method | `makeSureInitialized` in `ExternalCatalog.java:288` | 统一初始化骨架，子类只填钩子 |
| 懒加载 + Caffeine | `MetaCache`/`ExternalSchemaCache` | 外部元数据昂贵，三级缓存减少远端访问 |
| Strategy | `ExternalMetadataOps` in `operations/ExternalMetadataOps.java:32` | 异构外部源适配，基类委托策略透明切换 |
| 工厂 | `CatalogFactory.createFromStmt` in `:87` | 按 type 创建子类，新增源加 case 分支 |

## 模块间交互

`datasource` 被 `catalog`（`Env` 持有 `CatalogMgr` + `ExternalMetaCacheMgr` 单例）、`qe`（`ConnectProcessor` 通过 `CatalogMgr` 获取 catalog→db→table）、`statistics`（自动统计收集）、`transaction`（`ExternalCatalog` 持有 `transactionManager`）import。BE 侧通过 thrift RPC 获取文件 split 后直接读存储层，不直接 import Java datasource。`ExternalCatalog` 实现 `Writable`，`replayInitCatalog()`（`:775`）回放 `InitCatalogLog`。

## 扩展方式

**新增一种 ExternalCatalog**（如 Delta Lake）：新建 `datasource/delta/DeltaExternalCatalog.java` 继承 `ExternalCatalog`，实现 `initLocalObjectsImpl()`/`listTableNames()`/`tableExist()`；新建 `DeltaMetadataOps` 实现 `ExternalMetadataOps`；新建 `DeltaExternalDatabase`/`DeltaExternalTable`/`DeltaSchemaCacheValue`；在 `InitCatalogLog.Type`（`:35`）追加 `DELTA`；在 `CatalogFactory.createFromStmt()`（`:117`）加 `case "delta"`；在 `ExternalCatalog.buildDbForInit()`（`:921`）加 `case DELTA`。对应测试：`regression-test/suites/external/`。
