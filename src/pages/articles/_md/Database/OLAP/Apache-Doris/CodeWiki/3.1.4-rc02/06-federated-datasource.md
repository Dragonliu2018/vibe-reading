---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "联邦数据源"
date: "2026-08-23T19:01:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "ExternalCatalog", "联邦查询", "懒加载", "元数据缓存"]
description: "Doris 3.1.4 联邦数据源：ExternalCatalog 懒加载抽象 + CatalogMgr 多 catalog 树 + 外部元数据缓存。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

联邦数据源模块是 `datasource/`（~6.6 万行），核心是 `ExternalCatalog`（`datasource/ExternalCatalog.java:112`）抽象与 `CatalogMgr`（`CatalogMgr.java:85`）。它让 Doris 能查 Hive/Iceberg/Hudi/Paimon/JDBC 等外部数据源而无需导入。独立成文是因为外部元数据获取昂贵且各源异构（HMS、Glue、REST、JDBC），需要独立的懒加载、缓存失效、类型映射机制，与内部 `InternalCatalog` 的本地元数据模型完全不同。

## 模块架构

```
CatalogMgr (CatalogMgr.java:85) ── Writable，持久化 catalog 定义
   ├─ InternalCatalog (Doris 内部表)
   └─ ExternalCatalog (抽象基类, ExternalCatalog.java:112)
        │  initLocalObjects() (:382, final)  ── 懒加载入口
        │     └─ initLocalObjectsImpl() (:303, abstract) ── 子类实现连接
        ├─ listTableNames (ctx, dbName) (:288, abstract)
        ├─ reset / makeUnInitialized (:577) ── 失效重置
        │
        ├─ HMSExternalCatalog     (Hive)
        ├─ IcebergExternalCatalog
        ├─ HudiExternalCatalog
        ├─ PaimonExternalCatalog
        └─ JdbcExternalCatalog    (JDBC)
   │
ExternalMetaCacheMgr ── 外部表/分区元数据缓存 (Caffeine)
ExternalMetaIdMgr     ── 外部对象 id 映射
ExternalRowCountCache ── 行数缓存
```

## 调用链路

```
SELECT * FROM hive_catalog.db.table
  └─ CatalogMgr.getCatalog("hive_catalog")
       └─ ExternalCatalog（首次访问触发懒加载）
            └─ initLocalObjects() (:382)  ── 双检锁
                 └─ initLocalObjectsImpl() (:303)  ── 子类建 HMS Client 等
  └─ ExternalDatabase.getTable
       └─ ExternalMetaCacheMgr.getTable (命中缓存 / 否则查 HMS)
  └─ 生成 ExternalScanNode → Coordinator 下发
       └─ BE: 读取外部文件（Parquet/ORC on HDFS/S3）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `initLocalObjects` (`:382`) | 懒加载入口 | `final` + 双检锁，线程安全 |
| `initLocalObjectsImpl` (`:303`) | 子类建连接 | 抽象，各 catalog 异构实现 |
| `listTableNames` (`:288`) | 列表名 | 抽象，避免全量拉元数据 |
| `reset`/`makeUnInitialized` (`:577`) | 失效重置 | 配置变更或缓存失效时重连 |

</details>

## 核心实现

### 懒加载与连接延迟创建

`ExternalCatalog` 的 `initLocalObjects()`（`:382`）是 `final` 方法，内部用双检锁保证只初始化一次，真正建连接的逻辑在子类的 `initLocalObjectsImpl()`（`:303`，abstract）。即 catalog 创建时**不连外部源**，首次被查询引用才建连接——这对有大量 catalog 但多数冷访问的场景省资源。

设计决策：**为何 lazy**——HMS/Glue 连接与元数据拉取昂贵且可能失败，懒加载使 catalog 定义（轻）与连接（重）解耦：`CREATE CATALOG` 只落配置，访问才付连接成本。`reset`（`:577`）允许配置变更或缓存失效时重新初始化，释放旧连接防泄漏。

### 多层缓存

外部元数据经多级缓存避免反复打外部源：`ExternalMetaCacheMgr`（Caffeine 缓存表/分区结构）、`ExternalRowCountCache`（行数缓存，统计用）、`ExternalMetaIdMgr`（外部对象到 Doris 内部 id 的映射，用于 plan 缓存键）。缓存可失效（`REFRESH` 命令或 TTL），失效后 `makeUnInitialized` 重置 catalog。

### 类型映射

`DorisTypeVisitor`（`datasource/DorisTypeVisitor.java`）把外部类型（Hive/Parquet/ORC 类型）映射为 Doris 内部类型，`ExternalFunctionRules` 处理外部函数下推规则。这是联邦查询能与 Doris 优化器/执行器对接的基础——外部表经映射后像内部表一样参与 Nereids 优化与 Pipeline 执行。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `initLocalObjects`(final) + `initLocalObjectsImpl`(abstract) | 框架控并发，子类控连接，复用安全初始化 |
| 懒加载 | 首次访问才初始化 | 多 catalog 冷访问省资源 |
| 多级缓存 | MetaCacheMgr/RowCountCache/MetaIdMgr | 避免反复打外部源 |

## 模块间交互

`datasource/` **依赖** `catalog/Env`（`CatalogMgr` 在 Env 内，`Env.getCatalogMgr()`）、`nereids/`（`ExternalScanNode`/`LogicalCatalogRelation` 参与优化）、BE 侧 `vec/io/`（读外部文件 Parquet/ORC）、`io/`（FileSystem 抽象访问 HDFS/S3）。被 `qe/Coordinator` 下发 external scan。

## 扩展方式

新增一类联邦 catalog：在 `datasource/` 加 `XxxExternalCatalog extends ExternalCatalog`，实现 `initLocalObjectsImpl`/`listTableNames`/`getTable` 等，在 `CatalogFactory` 按 `type` 注册，在 `DorisTypeVisitor` 加类型映射。对应测试：`regression-test/suites/external/`。
