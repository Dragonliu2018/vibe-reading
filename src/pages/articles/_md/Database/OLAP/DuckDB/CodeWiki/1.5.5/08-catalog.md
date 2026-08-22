---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Catalog"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Catalog", "MVCC", "DependencyManager"]
description: "DuckDB Catalog 模块——MVCC 版本链元数据管理，CatalogSet + DependencyManager 双向依赖图，支持并发 DDL。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Catalog 模块负责管理数据库的元数据——Catalog/Schema/Table/View/Sequence/Index 等元数据的存储、检索和版本管理。DuckDB 的 catalog 不是简单的"最新值覆盖旧值"，而是用 **MVCC 版本链**管理元数据——每个修改创建新版本节点链接到链表上，支持并发 DDL（一个事务 `ALTER TABLE` 时另一个事务可继续读旧版本）、事务回滚（旧版本保留在链上）和 time-travel 查询（`AT` 子句查历史版本）。

## 模块架构

Catalog 采用三级层次结构：`Catalog`（数据库级）→ `SchemaCatalogEntry`（schema 级，持有多个 CatalogSet：tables/views/sequences/indexes/functions）→ `StandardEntry`（TableCatalogEntry/ViewCatalogEntry/SequenceCatalogEntry/IndexCatalogEntry）。

`CatalogSet` 是元数据集合存储的引擎，底层用 `case_insensitive_tree_t<unique_ptr<CatalogEntry>>`（大小写不敏感有序树映射）存储版本链根节点。`DependencyManager` 维护双向依赖图——`subjects`（"被依赖"方向）和 `dependents`（"依赖者"方向），用 `MangledEntryName`（`Type\0Schema\0Name` 格式）做 key。`CatalogEntryRetriever` 封装查找逻辑，被 Binder 使用，附加 `CatalogSearchPath`（搜索路径）和回调机制。

`Catalog` 是抽象基类（Strategy 模式），`DuckCatalog` 是内置实现。外部 catalog 后端（如 PostgreSQL FDW、iceberg 扩展）可继承 `Catalog` 实现自己的 `LookupSchema`/`PlanInsert` 等方法。`CatalogTransaction` 是轻量 struct，从 `DuckTransaction` 提取 `transaction_id` 和 `start_time` 用于 MVCC 可见性判断。

## 调用链路

### 表查找路径（SELECT * FROM t）

```
Catalog::GetEntry(context, schema, lookup_info, ...)      [catalog.cpp:1062]
  → TryLookupEntry(retriever, schema, lookup_info, ...)    [catalog.cpp:812]
    → TryLookupEntryInternal(transaction, schema, lookup_info)  [catalog.cpp:795]
      → LookupSchema(transaction, schema_lookup)           — 虚方法→DuckCatalog
        → schemas->GetEntry(transaction, schema_name)      [catalog_set.cpp:629]
          → GetEntryDetailed(transaction, name)            [catalog_set.cpp:602]
            ├→ map.GetEntry(name)  — 从 case_insensitive_tree_t 取根节点
            └→ GetEntryForTransaction(transaction, entry)  [catalog_set.cpp:526]
                 遍历版本链 child→child→... 找可见版本:
                 UseTimestamp(transaction, entry.timestamp):
                   timestamp == transaction_id → 自己创建的，可见
                   timestamp < start_time → 提交早于事务开始，可见
                   否则不可见，继续走 child
```

### CREATE TABLE 路径

```
Catalog::CreateTable(context, BoundCreateTableInfo)       [catalog.cpp:131]
  → schema.CreateTable(transaction, info)
    → CatalogSet::CreateEntry(transaction, name, value, dependencies)  [catalog_set.cpp:195]
      ├→ value->timestamp = transaction.transaction_id  — 标记当前事务创建
      ├→ DependencyManager::AddObject(transaction, *value, dependencies)
      │    → CreateDependencies → 在 subjects/dependents CatalogSet 创建 DependencyEntry
      ├→ VerifyVacancy()  — 检查写写冲突 + 是否已删除
      ├→ map.UpdateEntry(value)  — 新版本插入版本链头部 (SetChild)
      └→ DuckTransactionManager::PushCatalogEntry(transaction, child)  — 旧版本推入 undo buffer
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `CatalogSet::GetEntryForTransaction` | MVCC 版本可见性 | 遍历版本链找对当前事务可见的版本 |
| `CatalogSet::CreateEntry` | 创建新条目 | 新版本插入链头，旧版本推入 undo buffer |
| `CatalogSet::DropEntry` | 删除条目 | 创建 tombstone 节点（deleted=true）插入链头 |
| `DependencyManager::CheckDropDependencies` | DROP 依赖检查 | cascade 递归删，非 cascade blocking 报错 |
| `CatalogEntryRetriever::GetEntry` | 封装查找 | 附加搜索路径和回调 |

</details>

## 核心实现

### MVCC 版本链管理

每个 `CatalogEntry` 通过 `child`/`parent` 指针形成单向链表（`catalog_entry.hpp:64-66`）。新版本插入链头（`CatalogEntryMap::UpdateEntry` → `SetChild`），旧版本保留在链尾。读取时遍历链表找对当前事务可见的版本。版本可见性规则（`catalog_set.cpp:509-519`）：

- `timestamp == transaction_id`：自己创建的版本，可见
- `timestamp < start_time`：提交早于事务开始，可见
- `timestamp >= TRANSACTION_ID_START` 且不等于自己：其他未提交事务的版本，不可见
- `timestamp < TRANSACTION_ID_START && timestamp > start_time`：事务开始后提交的版本，不可见

ROLLBACK 时 `CatalogSet::Undo`（`catalog_set.cpp:642-663`）恢复旧版本——从链头移除未提交的新版本。

### CatalogSet 实现

底层用 `case_insensitive_tree_t`（有序树）而非 `unordered_map`——大小写不敏感匹配（SQL 标识符 `MyTable` = `mytable`），且 tree 支持遍历做 did-you-mean 建议（`StringUtil::SimilarityRating`，`catalog_set.cpp:551-564`）。写操作用 `catalog_lock`（mutex）保护，读操作通过版本链 MVCC 无锁进行。

### 依赖管理

`DependencyManager` 维护双向依赖图（`dependency_manager.hpp:102-103`）。`CheckDropDependencies`（`dependency_manager.cpp:530-575`）在 DROP 时：`ScanDependents` 遍历所有依赖此对象的条目——`cascade=true` 加入 `to_drop` 递归 DROP，`cascade=false` 且 blocking 依赖抛 `DependencyException`。特殊规则：`INDEX_ENTRY` 不设 blocking flag（index 总随 table 一起删除）。跨 catalog 依赖不支持（`dependency_manager.cpp:281-286` 会 throw）。

### Attach/Detach 多 catalog

DuckDB 支持同时 attach 多个数据库，每个 `AttachedDatabase` 持有一个 Catalog 实例。特殊 catalog：`TEMP_CATALOG`（session 临时对象）、`SYSTEM_CATALOG`（内置函数/类型）。`Catalog::GetCatalogEntry` 通过 `DatabaseManager::GetDatabase(context, catalog_name)` 查找。不同 catalog 可以有不同的 `GetCatalogType()`（如 `"duckdb"`、`"postgres"`），支持异构数据源。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Composite | Catalog→Schema→Table 三级层次 | 自然表达命名空间层次 |
| Registry | `CatalogSet` in `catalog_set.hpp:54` | 大小写不敏感树 + 版本链 |
| Version Chain | `CatalogEntry::child/parent` in `catalog_entry.hpp:64` | MVCC 版本管理，支持并发 DDL |
| Dependency Graph | `DependencyManager` in `dependency_manager.hpp:84` | 双向依赖图，防 DROP 被依赖对象 |
| Strategy | `Catalog` 抽象基类 in `catalog.hpp:84` | 外部 catalog 后端可替换 |

## 模块间交互

Planner/Binder 通过 `CatalogEntryRetriever` 查找表/视图/函数——`TableCatalogEntry::GetColumns()` 提供列信息，`ScalarFunctionCatalogEntry` 提供函数签名。Parser 的 CREATE/DROP/ALTER 生成 `CreateInfo`/`DropInfo`/`AlterInfo`，Catalog 消费这些结构。Storage 的 `TableCatalogEntry` 通过 `GetStorage()` 返回 `DataTable`。`CatalogTransaction` 从 `DuckTransaction` 提取事务视角用于 MVCC 可见性判断，`DuckTransactionManager::PushCatalogEntry` 将 catalog 变更推入 UndoBuffer 支持回滚。

## 扩展方式

新增一种 CatalogEntry 类型（如 `TriggerCatalogEntry`）：`src/include/duckdb/catalog/catalog_entry/xxx.hpp` 继承 `StandardEntry` → `src/include/duckdb/common/enums/catalog_type.hpp` 添加 `CatalogType` 枚举 → `SchemaCatalogEntry` 添加 `CreateXxx` 方法 + `CatalogSet` → `Catalog` 抽象层添加委托方法 → Parser 新增 `CreateXxxInfo` 结构 → Binder 实现 `BindCreateXxx`。

支持新的外部 catalog 后端：继承 `Catalog` 实现所有纯虚方法（`Initialize`/`LookupSchema`/`ScanSchemas`/`PlanInsert`/`PlanDelete`/`PlanUpdate`...）。注意 `CatalogSet` 和 `DependencyManager` 硬绑定到 `DuckCatalog`（构造函数要求 `catalog_p.IsDuckCatalog()`），外部 catalog 需自己实现条目存储和查找逻辑。
