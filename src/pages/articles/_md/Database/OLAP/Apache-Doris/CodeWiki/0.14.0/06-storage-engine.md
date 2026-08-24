---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "存储引擎"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "olap", "Tablet", "Rowset", "Compaction", "segment_v2"]
description: "Doris 0.14.0 存储引擎：StorageEngine 单例、Tablet/Rowset(alpha+beta)/Segment 列存、两级 Compaction（Cumulative+Base）、alpha→beta rowset 迁移、MemTableFlushExecutor。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块是 `be/src/olap/`（~7.1 万行，311 文件），是 BE 的**列存与副本核心资产**，独立于执行引擎。负责 Tablet 管理、Rowset（alpha 旧 + beta 新）读写、Segment 列存编解码、两级 Compaction、MemTable 刷盘。0.14.0 处于 alpha（segment v1）→ beta（segment_v2）的迁移期。

## 模块架构

```
StorageEngine (olap/storage_engine.h:70) ── BE 进程单例 (_s_instance)
   ├─ TabletManager (olap/tablet_manager.h:47)  ── Tablet 注册表
   ├─ TxnManager                              ── 事务→rowset 映射
   ├─ MemTableFlushExecutor (:139)            ── MemTable 刷盘
   ├─ DataDir (olap/data_dir.h:43) × N        ── 每块磁盘一个，存 Tablet
   ├─ RowsetIdGenerator                       ── 全局 rowset id
   │
   ├─ Rowset (olap/rowset/rowset.h)
   │   ├─ AlphaRowset (segment v1, SegmentGroup)   ── 旧格式
   │   ├─ BetaRowset (segment_v2)                   ── 新列存（列式 Page + 多级索引）
   │   └─ RowsetFactory::create_rowset (:30)       ── 按 rowset_type 工厂创建
   │
   ├─ Compaction (olap/compaction.h:45)
   │   ├─ CumulativeCompaction (cumulative_compaction.h:28) ── 小→中合并
   │   └─ BaseCompaction (base_compaction.h:30)             ── 中→基线合并
   │   (create_cumulative_compaction / create_base_compaction :172/174)
   │
   └─ default_rowset_type() (:156) ── 心跳可动态切 alpha/beta（迁移控制）
       └─ _default_rowset_type (:333) "Used to control migration segment_v1→v2"

Tablet (olap/tablet.h:53 : public BaseTablet)
   ├─ 版本链（rs_version_map）
   ├─ alpha/beta Rowset 列表
   └─ 副本管理
```

## 调用链路

```
[读路径]
OlapScanNode → TabletReader/BlockReader
  → Tablet 取 Rowset 列表（按版本可见性筛选）
  → Segment/SegmentGroup 按列存 Page 解码（short key/bloom/ordinal 索引定位）

[写路径]
DeltaWriter.write(MemTable) → 攒批
  → flush → BetaRowsetWriter → SegmentWriter.finalize (列存 Page + 多级索引)
  → Rowset 注册到 Tablet 版本链（事务 VISIBLE 后对查询可见）

[Compaction]
start_bg_threads() → _compaction_tasks_producer_callback()
  → 按 CompactionCandidate (nice 优先级) 选 tablet
  → create_cumulative_compaction / create_base_compaction (:172/174)
  → CumulativeCompaction::compact / BaseCompaction::compact (模板方法)
  → 合并多个 Rowset 为一个，减少读放大
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `StorageEngine::open`（`storage_engine.h:75`） | 启动存储引擎 | 加载 DataDir、恢复 Tablet |
| `instance`（`:77`） | 单例 | `_s_instance` 全局 |
| `create_tablet`（`:79`） | 建 tablet | 选 DataDir 分配 |
| `tablet_manager`/`txn_manager`（`:137/138`） | Tablet/事务管理 | 单例持有 |
| `default_rowset_type`（`:156`） | 默认 rowset 类型 | 心跳动态切 alpha/beta（迁移控制） |
| `start_bg_threads`（`:168`） | 启动后台线程 | 必须在 ExecEnv init 后 |
| `create_cumulative/base_compaction`（`:172/174`） | compaction 工厂 | 按类型实例化 |
| `RowsetFactory::create_rowset`（`rowset_factory.h:30`） | rowset 工厂 | 按 `rowset_type` 创建 alpha/beta |

</details>

## 核心实现

### alpha/beta rowset 迁移期

0.14.0 的 `olap/rowset/` 同时保留 `AlphaRowset`（segment v1，`SegmentGroup` 格式）与 `BetaRowset`（segment_v2，列式 Page + 多级索引）。`StorageEngine::default_rowset_type()`（`storage_engine.h:156`）的默认类型可由 **心跳**（`_heartbeat_flags->is_set_default_rowset_type_to_beta()`）动态切到 `BETA_ROWSET`——字段 `_default_rowset_type`（`:333`）注释明言 "Used to control the migration from segment_v1 to segment_v2, can be deleted in future"。`RowsetFactory::create_rowset`（`rowset_factory.h:30`）按类型工厂创建。这使迁移期新旧 rowset 可共存、可灰度切换。

### 两级 Compaction：Cumulative + Base

0.14.0 用两级 Compaction 减少读放大：`CumulativeCompaction`（`cumulative_compaction.h:28`）把多个小 rowset 合并成中等的，`BaseCompaction`（`base_compaction.h:30`）再把中等的合并到基线——都继承 `Compaction`（`compaction.h:45`）的模板方法 `compact`。调度由 `_compaction_tasks_producer_callback` 按 `CompactionCandidate`（`nice` 优先级，`CompactionCandidateComparator` 降序）选 tablet，经 `create_cumulative_compaction`/`create_base_compaction`（`:172/174`）工厂实例化。后台线程在 `start_bg_threads`（`:168`）启动——**必须在 `ExecEnv` 初始化之后**（`doris_main.cpp:214`），因为依赖 ExecEnv 持有的资源。

### Tablet 与版本链

`Tablet`（`olap/tablet.h:53`，`public BaseTablet`）是数据分片、副本管理与调度的基本单位，持有版本链（`rs_version_map`）与 alpha/beta Rowset 列表。查询时按 `visibleVersion` 筛选可见 rowset，导入事务 VISIBLE 后新 rowset 才对查询可见——这是事务一致性的存储层基础。`TabletManager`（`tablet_manager.h:47`）是 Tablet 注册表，`DataDir`（`data_dir.h:43`）每块磁盘一个，管理该盘上的 Tablet。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例 | `StorageEngine::instance`（`:77`） | BE 进程唯一存储引擎 |
| 工厂方法 | `RowsetFactory::create_rowset`（`:30`）/ `create_*_compaction`（`:172/174`） | 按 type 实例化 alpha/beta rowset、cumulative/base compaction |
| 模板方法 | `Compaction::compact`（`compaction.h:45`） | 基类骨架，子类覆盖 `execute_compact_impl` |
| 策略 | `default_rowset_type`（`:156`）+ `CumulativeCompactionPolicy` | rowset 类型/compaction 策略可切换（迁移控制） |

## 模块间交互

`olap` 被 `exec`（`OlapScanNode` 读、`OlapTableSink` 写）与 `runtime`（`ExecEnv` 持有 `StorageEngine`）依赖。`StorageEngine::open`（`:75`）在 `doris_main`（`:200`）启动，`start_bg_threads`（`:168`）在 ExecEnv init 后（`:214`）。FE 经 `task`/`agent` 下发 `create_tablet`/`clone` 任务，BE 回报 tablet 状态。

## 扩展方式

新增 rowset 格式：实现 `Rowset` 子类 + `RowsetFactory::create_rowset`（`:30`）分支 + segment 读写器。改 Compaction 策略：实现 `CumulativeCompactionPolicy`。新增列存编码：在 `segment_v2/` 加 Page writer/reader。改副本数：动 `Tablet` 的版本链与 quorum（配合 `DatabaseTransactionMgr`）。
