---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "TS Catalog 元数据"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "PostgreSQL", "catalog", "元数据"]
description: "TimescaleDB 自有 catalog 表、Scanner 访问抽象、watermark 水位线与 cache invalidation proxy 机制解读"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

TS Catalog 是整个 TimescaleDB 的**持久化元数据基座**——hypertable、dimension、chunk、bgw_job、continuous_agg、compression_settings 等所有结构的状态都存在这里的普通表里。它独立成模块因为：一是 TimescaleDB 不扩展 PG 的 `pg_class` 而用自有 schema 下的普通表，需要一套统一访问层；二是 watermark、cache invalidation proxy 等机制是元数据层特有的设计。几乎所有模块都单向依赖它。

## 模块架构

```
catalog.h（~1469 行）—— 所有 catalog 表结构定义
  每张表: enum Anum_XXX（属性号）+ FormData_XXX（C struct）+ Form_XXX + 表名常量
  ├─ hypertable / dimension / dimension_slice / chunk
  ├─ bgw_job / bgw_job_stat / bgw_job_stat_history
  ├─ continuous_agg / continuous_aggs_watermark / *_invalidation_log / ...
  └─ compression_settings / chunk_column_stats / metadata / tablespace
catalog.c —— 初始化（ts_catalog_get）+ scan/insert/update/delete 封装
scanner.h / scan_iterator.h —— ScannerCtx + ScanIterator 三层抽象封装 PG heap/index scan
```

关键设计：所有 catalog 表在 `_timescaledb_catalog` schema 下，用普通 `CREATE TABLE` 声明（`sql/pre_install/tables.sql`），通过 `pg_extension_config_dump()` 注册到 pg_dump 使数据随 extension dump/restore。部分表标 `WITH (user_catalog_table = true)`。

## 调用链路

### catalog 初始化与 scan

```
ts_catalog_get (catalog.c:481)  首次调用初始化 s_catalog
  ├─ ts_catalog_table_info_init (catalog.c:421) 遍历所有表，ts_get_relation_relid 查 OID + 索引 OID
  ├─ 解析 extension schema OID
  └─ 查 cache invalidation proxy 表 OID（cache_inval_hypertable/bgw_job/extension）

访问: ts_catalog_scan_one/scan_all (catalog.c:816)
  └─ 构造 ScannerCtx（表/索引 OID + ScanKey + tuple_found 回调 + data）
       └─ ts_scanner_scan_one/scan → 底层 index_scan 或 heap_scan
高层迭代器: ts_scan_iterator_create(CATALOG_TABLE, lockmode, mctx)
  └─ ts_scanner_foreach 遍历
```

### 安全上下文切换

写 catalog 时切换为 catalog schema owner 身份：`ts_catalog_database_info_become_owner()`（避免普通用户权限不足），写完 `ts_catalog_restore_user()` 恢复。

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ts_catalog_get` (catalog.c:481) | 取/初始化全局 catalog | 缓存所有表/索引 OID |
| `ts_catalog_scan_one/all` (catalog.c:816) | 统一 scan 封装 | 回调式，不暴露底层 ScanDesc |
| `ts_cagg_watermark_insert/get` (continuous_aggs_watermark.c) | 水位线读写 | 用事务快照保证一致性 |

## 核心实现

### 为什么用自有 catalog 表而非扩展 pg_class

- **Schema 隔离**：所有表在 `_timescaledb_catalog` schema，不污染 PG 内核 catalog。
- **扩展性**：新增表只需 `CatalogTable` enum 加项 + 三个静态数组加项 + tables.sql 加 DDL，不改 PG 内核。
- **pg_dump 支持**：`pg_extension_config_dump()` 注册，可带条件（如 `WHERE id >= 1000` 过滤系统默认 job）。
- **安全上下文切换**：`become_owner`/`restore_user` 允许以 catalog owner 身份写。

### Scanner 三层抽象

底层 PG `heap_scan`/`index_scan`（`ScanDesc` 联合体统一）→ 中层 `ScannerCtx`（`src/scanner.h`，封装表/索引 OID、ScanKey、锁、快照、`tuple_found` 回调，自动判断走 index 还是 heap scan）→ 高层 `ScanIterator`（`src/scan_iterator.h`，内嵌 5 个 ScanKey 槽，`ts_scanner_foreach` 宏简化遍历）。回调式设计避免暴露底层 scan descriptor，保证一致的锁/快照/内存上下文管理。

### watermark 机制

`continuous_aggs_watermark` 表仅两列（mat_hypertable_id, watermark），是连续聚合 real-time aggregation 的核心边界标记：`<= watermark` 走物化表，`> watermark` 走原始表实时聚合。`ts_cagg_watermark_get`（continuous_aggs_watermark.c:39）用**事务快照**而非 SnapshotSelf 读，确保 watermark 与物化数据视图一致。更新用 `TUPLE_LOCK_FLAG_FIND_LAST_VERSION` 锁定 tuple 处理并发，**水位只增不减**。更新后 `CacheInvalidateRelcacheByRelid`——因为 `constify_cagg_watermark` 在规划期把 watermark 函数（STABLE）constify 了，缓存失效确保 prepared statement 重新规划。

### cache invalidation proxy 表

`ts_catalog_invalidate_cache`（catalog.c:782）不直接发 invalidation 给各 backend 内存缓存，而是通过 dummy "proxy 表" 的 relcache invalidation 间接触发：`cache_inval_hypertable`/`cache_inval_bgw_job`/`cache_inval_extension` 三张代理表分别对应 hypertable cache、bgw_job cache、extension cache。不同 catalog 表变更映射到不同 proxy——如 HYPERTABLE/DIMENSION/CONTINUOUS_AGG/CHUNK_COLUMN_STATS 变更→hypertable cache proxy，BGW_JOB 变更→bgw_job cache proxy。

### metadata KV 表

`metadata` 表三列（key, value text, include_in_telemetry bool），存 `uuid`（实例标识）、`exported_uuid`、`install_timestamp`，用于遥测和区分安装。`ts_metadata_insert`（metadata.c:143）用 ShareRowExclusiveLock 实现 insert-if-not-exists。

## 模块间交互

是单向基座：hypertable/chunk/bgw_job/compression/continuous_agg 都读 catalog；catalog 层不反向调业务模块（除了 `ts_catalog_invalidate_cache` 触发 cache 失效信号）。`chunk_column_stats`（catalog.h:331）记录 chunk 列的 range_start/range_end/valid，仅支持 INT2/INT4/INT8/TIMESTAMP/TIMESTAMPTZ/DATE，用于压缩决策辅助。

## 扩展方式

新增 catalog 表需改 6 处（catalog.h:59 注释提醒）：`CatalogTable` enum 加项 + `catalog_table_names`/`catalog_table_index_definitions`/`catalog_table_serial_id_names` 三数组加项 + `sql/pre_install/tables.sql` 加 DDL + 新 .c 用 `ts_scan_iterator_create` 实现 CRUD + `src/Makefile` 加文件。加字段：`Anum_XXX` enum + `FormData_XXX` struct **末尾**加字段（定长在变长前，PG tuple 布局约束）+ `formdata_make_tuple`/`fill` 处理 + `sql/updates/` 写迁移脚本。
