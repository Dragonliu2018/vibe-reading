---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "元数据中枢"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "InfoSchema"]
description: "TiDB 元数据中枢解读：Domain 后台任务宿主、InfoSchema v2 增量 btree 快照、meta Mutator/Reader 与延迟 GC"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/domain/` + `pkg/infoschema/` + `pkg/meta/` 构成元数据中枢：Domain 是每个 tidb-server 实例的**顶层聚合对象**（一切后台任务的宿主），InfoSchema 是全库表结构的**不可变多版本快照**（每条语句的世界观），meta 是元数据在 TiKV 里的 **KV 编解码层**。三者合起来回答一个问题：多个无状态计算节点如何对一份持续变更的 schema 保持一致视图。本快照三处结构性变化：`Domain.Reload` 已迁到 `pkg/infoschema/issyncer`（domain 只剩一行委托）；`meta.Meta` 拆成写端 `Mutator` 与读端 `Reader`；InfoSchema v2 用全局共享 `Data`（btree 增量）替代 v1 的全量 map 物化。

## 模块架构

```
pkg/domain/
├── domain.go             # Domain 结构（:151）+ Start（:804，后台任务全在此起）
└── sysvar_cache.go       # 全局/会话系统变量缓存（:41）
pkg/infoschema/
├── interface.go          # InfoSchema 接口（:30，注释明确 read-only）
├── infoschema.go         # v1：infoSchema 全量 map（:71）
├── infoschema_v2.go      # v2：infoschemaV2 = {ts, *Data}（:790）+ Sieve LRU 按需加载
├── cache.go              # InfoCache：多版本滑窗（:34）+ gcOldVersion（:393）
├── builder.go            # Builder：全量构建 / ApplyDiff 增量
└── issyncer/
    ├── syncer.go          # Syncer：SyncLoop 推送/watch 驱动 Reload（:296/:409）
    └── loader.go          # Loader.LoadWithTS：版本差 <100 增量，否则全量（:145）
pkg/meta/
├── meta.go                # Mutator：m 前缀 KV 编解码（:219；顶部注释有键空间全图）
└── reader.go              # Reader：任意 snapshot 构造读端（:69）
```

## 调用链路

DDL 推进版本后的 reload 链：

```
[DDL owner] GenSchemaVersion + SetSchemaDiff       pkg/ddl/ddl.go:400 / pkg/meta/meta.go:2154
[etcd 推送] GlobalVersionCh
[每个节点] Syncer.SyncLoop                          issyncer/syncer.go:296
└─ Syncer.Reload (:409) → Domain.Reload 只剩委托     pkg/domain/domain.go:362
    └─ Loader.LoadWithTS (loader.go:145)
        ├─ meta.NewReader(snapshot).GetSchemaVersionWithNonEmptyDiff
        ├─ infoCache.GetByVersion 命中？→ v2 用 CloneAndUpdateTS 刷新 ts 即返回
        ├─ 未命中且版本差 <100 → tryLoadSchemaDiffs   # Builder.ApplyDiff 增量构建
        └─ 否则 fetchAllSchemasWithTables 全量 → Builder.InitWithDBInfos
            └─ infoCache.Insert(is, schemaTs)          cache.go:306
最后 schemaValidator.Update —— 刷新 lease
```

session 取 schema：语句开始时 `baseTxnContextProvider.EnterNewTxn` 设 `infoSchema = sctx.GetLatestInfoSchema()`（`pkg/sessiontxn/isolation/base.go:122`）→ `session.GetLatestInfoSchema`（`session.go:5539`）→ `infoCache.GetLatest()`；快照读走 `GetBySnapshotTS` 按时间戳二分定位。

| 结构 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Domain` in `domain.go:151` | 实例聚合 + 后台任务宿主 | store→Domain 的 per-instance 单例（domap） |
| `InfoCache` in `cache.go:34` | 按版本降序的多版本滑窗 | 旧版本延迟 GC，支撑长事务 |
| `infoschemaV2` in `infoschema_v2.go:790` | {ts, *Data} 极轻量 handle | 全局增量数据 + 按需加载 |
| `meta.Mutator` in `meta.go:219` | m 前缀写端 | 与 Reader 分离，读可用任意 snapshot |

## 核心实现

### InfoSchema 为什么不可变、为什么多版本

接口注释直说："InfoSchema is read-only"（`interface.go:27-29`）。不可变带来三个能力：**语句一致性**（事务固化 InfoSchema，见 [07-session-txn](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/07-session-txn)）；**快照读**（`GetBySnapshotTS` 按时间戳找到事务 startTS 对应的版本，长事务必须能拿到"旧世界"）；**无锁并发**（读旧快照的语句不阻塞 DDL 推进）。`InfoCache` 默认缓存 16 个版本（`SchemaVersionCacheLimit`），配合 schema lease（45s）构成"新版本最多 lease 内可见、旧版本最多缓存窗口内可用"的双时间界。

### InfoSchema v2：从全量物化到增量 btree + 按需加载

v1 的问题：每推进一个版本就复制全部表 map，内存 O(表数×版本数)——大集群（百万表）无法承受。v2 的解法：**全局共享一个 `Data`**（btree 存 `{key, schemaVersion}` 增量记录 + tombstone），每个版本的 `infoschemaV2` 只是 `{ts, *Data}` 轻量 handle——`CloneAndUpdateTS`（`infoschema_v2.go:841`）拷个结构体就"生成"了新版本快照。查表 `TableByName` 先查 btree，miss 时经 `tableCache`（Sieve LRU，`sieve.go`）**按需从 TiKV 加载 TableInfo**——大集群下启动也不必全量载入。旧增量记录由 `gcOldVersion()`（`cache.go:393`，每 100 版本/1 分钟触发）压缩：`meta.GetOldestSchemaVersion`（`meta.go:2215`，读 SchemaVersionKey 的 MVCC 写历史）找到"最老活跃 schema"，`Data.GCOldVersion`（`infoschema_v2.go:446`）删掉更老的记录。配套保护：`GetAndResetRecentInfoSchemaTS`（`cache.go:82`）维护 `recentMinTS` 上报 PD，防止 GC safepoint 越过按需加载所需的旧数据。开关 `tidb_schema_cache_size`（`shouldUseV2`），v1/v2 切换用 `Upsert` + 延迟 10 分钟清旧缓存避免双份内存峰值（`loader.go:270-276`）。

### Domain：后台任务宿主与生命周期管理

`Domain.Start`（`domain.go:804`）启动的任务清单就是 TiDB"分布式后台行为"的目录：`ddl.Start`（DDL scheduler/owner）、`SyncLoop`（schema reload）、`MDLCheckLoop`（metadata lock 检查）、`topNSlowQueryLoop`、`infoSyncer`/`TopologySyncLoop`、runaway 两个 loop（资源组失控查询）、`requestUnitsWriterLoop`（RU 统计）、log backup owner、跨 keyspace 的 `RunSystemKSGCLoop` 等；另有由 `BootstrapSession` 驱动的：`UpdateTableStatsLoop`/`loadStatsWorker`（`domain.go:1996`）、`StartTTLJobManager`（:2904）、`StartPlanReplayerHandle`（:1823）、`InitDistTaskLoop`（分布式任务）。**为什么聚在 Domain**：这些任务全部依赖同一套基建（内部 session 池 `sysSessionPool`、store、etcd、owner 选举），Domain 统一持生命周期（`Close` 逆序清理、`wg` 协程组），避免句柄散落。这也是"新增后台任务"的固定套路来源（见扩展方式）。

### meta：m 前缀的键空间

`pkg/meta/meta.go` 顶部注释就是键空间结构图：`DB:<id>` → `Table:<id>`、`Diff:<ver>`（SchemaDiff）、`SchemaVersionKey` 等，全部挂在 `m` 前缀下经 `structure.TxStructure` 编解码。读写分离（`NewMutator(txn)` 写、`meta.NewReader(snapshot)` 读任意快照）让 DDL 写元数据与 reload 读元数据互不干扰——读端永远基于一个 snapshot，天然与写并发安全。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 不可变多版本快照 | `InfoCache.cache []schemaAndTimestamp` in `cache.go:34` | MVCC 元数据：快照读 + 无锁读 |
| per-instance 单例 | `domap` in `pkg/session/tidb.go:168` | 一个 store 一个 Domain，会话共享 |
| 观察者/推送 | `Syncer.SyncLoop` + `ddlNotifier` in `domain.go:700` | etcd watch 推送 reload；DDL 事件广播给 stats/TTL |
| 读写分离 | `meta.Mutator`/`Reader` in `meta.go:219`/`reader.go:69` | 写走事务，读走任意 snapshot |

## 模块间交互

被消费方：session（`GetTxnInfoSchema`）、planner（resolve 表名）、executor、br、statistics。事件下游：DDL 经 `SchemaLoader.Reload()`（`ddl.go:364-367`，domain 是唯一实现）触发本节点刷新。限流保护：full load 超过 lease/2 时重读最新 version 校验并用当前 TS 续命（`syncer.go:476-500`）——防止"加载完即过期"的活锁。

## 扩展方式

新增系统表：`pkg/meta/metadef/system_tables_def.go`（清单）+ `pkg/meta/metadef/system.go`；DDL 相关表要 bump `DDLTableVersion`（`meta.go:196`）；bootstrap 建表在 `pkg/session/bootstrap.go`。新增后台任务：`pkg/domain/domain.go` 加字段与 `StartXxx`（模板：`StartTTLJobManager` in `domain.go:2904`——`do.wg.Run` + `sysSessionPool` 取会话 + owner 选举），`BootstrapSession` 挂启动、`Domain.Close` 加清理。新增 SchemaDiff 类型：`pkg/infoschema/builder.go` 的 `ApplyDiff` switch。
