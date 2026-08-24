---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Catalog 元数据"
date: "2026-08-24T10:22:21+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.7-rc01"]
tags: ["Apache Doris", "Env", "BDBJE", "EditLog", "Tablet", "HA", "服务定位器"]
description: "Doris 2.1.7 Catalog 元数据：Env god class 服务定位器 + TabletInvertedIndex + image/log 持久化 + BDBJE fencing 选主。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.7-rc01/00-overview)

---

## 模块定位

Catalog 元数据是 `fe/fe-core/src/main/java/org/apache/doris/catalog/`（~4.4 万行，136 文件），核心是 `Env`——整个 FE 的元数据中心 god class（6397 行，80+ 管理器字段）。它负责元数据管理（库表/分区/分桶/Tablet 元信息）、元数据高可用（BDB JE 复制 + fencing 防脑裂）、元数据持久化（image 全量 + EditLog 增量）、副本调度与事务状态托管。独立成文是因为元数据是所有 FE 子系统的公共依赖——优化器、协调器、导入、联邦模块都通过 `Env.getCurrentEnv()` 获取依赖，集中元数据避免多写源。2.1 中 `InternalCatalog`（内部库表实现）已迁移到 `datasource/` 包，但元数据核心（`Env`/`Table`/`Partition`/`Tablet`/`EditLog`）仍在 `catalog/`。

## 模块架构

```
Env (catalog/Env.java:339) ── God Class / 服务定位器，6397 行
   ├─ CatalogMgr catalogMgr                    ── 多 Catalog 管理（Internal + External）
   ├─ EditLog editLog                          ── WAL 日志
   ├─ TabletInvertedIndex tabletInvertedIndex  ── Tablet→Replica 反向索引
   ├─ GlobalTransactionMgr globalTransactionMgr
   ├─ TabletScheduler tabletScheduler          ── 副本均衡
   ├─ HAProtocol haProtocol                    ── BDBJE 选主
   ├─ FrontendNodeType role                    ── MASTER/FOLLOWER/OBSERVER
   ├─ static Env CHECKPOINT (:433)             ── 独立 checkpoint 实例
   │
   ▼ 持有
TabletInvertedIndex (catalog/TabletInvertedIndex.java:68) ── Guava Table 三维索引
   ├─ Map<tabletId, TabletMeta> tabletMetaMap (:79)
   ├─ Table<partitionId, indexId, TabletMeta> tabletMetaTable (:93)
   └─ Table<tabletId, backendId, Replica> replicaMetaTable (:96)
   │
   ▼ 元信息结构
Table (catalog/Table.java:65) abstract ── OlapTable extends Table
   └─ Partition (catalog/Partition.java:47)
        ├─ visibleVersion / nextVersion          ── 版本号
        ├─ MaterializedIndex baseIndex           ── 滚动索引
        └─ Tablet (catalog/Tablet.java:61)
             └─ List<Replica> replicas           ── 副本列表
   │
   ▼ 持久化
EditLog (persist/EditLog.java:109)
   └─ Journal journal (:119)                     ── BDBJEJournal | LocalJournal（策略）
        └─ logEdit(opCode, Writable) (:1256)     ── 命令模式，switch 分发回放
```

## 调用链路

建表流程（DDL → 元数据分配 → 持久化）：

```
InternalCatalog.createTable(stmt) [datasource/InternalCatalog.java:1141]
    → [engine=olap] createOlapTable() (:2226)
      ├─ IdGeneratorBuffer 批量预分配 tableId/partitionId/tabletId/replicaId
      ├─ OlapTableFactory 创建 OlapTable
      ├─ createPartitionWithIndices() (:1943)
      │    ├─ 创建 MaterializedIndex baseIndex + rollup index
      │    ├─ 构造 Partition（visibleVersion=1）
      │    └─ createTablets() (:1995)
      │         ├─ 按 bucketNum 循环创建 Tablet
      │         ├─ systemInfoService.selectBackendIdsForReplicaCreation() 选 BE
      │         └─ 为每个 BE 创建 Replica 加入 tablet.getReplicas()
      ├─ CreateReplicaTask → AgentBatchTask → AgentTaskExecutor.submit()  ── 下发 BE
      └─ Database.createTableWithLock()
           ├─ registerTable(table)               ── 加入 idToTable/nameToTable 内存映射
           └─ EditLog.logCreateTable(info) [EditLog.java:1354]
                → logEdit(OP_CREATE_TABLE, info) (:1256)  ── 写入 BDBJE
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `Env.getCurrentEnv` | 获取进程级单例 | 服务定位器，所有子系统零成本获取依赖 |
| `Env.initialize` | 装配 Env | 加载 image + replay EditLog + 启动 Daemon |
| `Env.transferToMaster` | 成为 Master | fencing + replayJournal + rollEditLog |
| `EditLog.logEdit` | 写日志 | 命令模式，(opCode, Writable) 序列化 |
| `EditLog.loadJournal` | 回放日志 | switch(opCode) 分发到 replayXxx |
| `Checkpoint.doCheckpoint` | 生成 image | 独立 CHECKPOINT Env 实例 replay 后 saveImage |

</details>

## 核心实现

### Env 服务定位器与 God Class

`Env`（`catalog/Env.java:339`）持有 80+ 个管理器实例字段，包括 `CatalogMgr`、`EditLog`、`TabletInvertedIndex`、`ColocateTableIndex`、`LoadManager`、`GlobalTransactionMgr`、`TabletScheduler`、`Auth`、`SystemInfoService`、`HeartbeatMgr` 等。所有子系统通过 `Env.getCurrentEnv()`（`:810`）获取依赖而非依赖注入。

**为什么用 god class**：FE 是单进程服务，元数据全局唯一，服务定位器提供"全局唯一入口"便利性；`CHECKPOINT` 静态字段（`:433`）是独立 Env 实例，在后台线程 replay journal 生成 image——要求所有管理器在同一 Env 实例内方便整体序列化。代价是 `Env.java` 达 6397 行，测试困难（无法 mock 单个管理器）。

### BDBJE 选主与 fencing 防脑裂

`BDBHA`（`ha/BDBHA.java:45`）封装 BDB JE 复制组选主机制。`FrontendNodeType` 定义 6 种角色：MASTER/FOLLOWER/OBSERVER/REPLICA/INIT/UNKNOWN。

`fencing()`（`BDBHA.java:71`）是防脑裂核心：新 Master 必须在 `epochDb` 中用 `putNoOverwrite` 写入递增 epoch number，保证只有一个 Master 能成功——这是 fencing token 机制，防止脑裂后旧 Master 继续写入。`transferToMaster()`（`Env.java:1477`）流程：停止 replayer → `editLog.open()` → `haProtocol.fencing()` → `replayJournal(-1)` 回放所有日志 → `rollEditLog()` → 标记 `isReady=true`。

### image + log 两级持久化

Doris 采用 **image（全量快照）+ EditLog（增量日志）** 机制，类似数据库 checkpoint + WAL：

- **启动加载**：`loadImage()`（`Env.java:1971`）读最新 `image.{seq}` 到内存，再 `replayJournal()` 回放 image 之后的 edit log。
- **写入路径**：每次 DDL 先改内存，再 `editLog.logXxx()` 写一条 journal 到 BDBJE。
- **Checkpoint 生成**：`Checkpoint.doCheckpoint()`（`master/Checkpoint.java:87`）在独立 `CHECKPOINT` Env 实例中 replay 到 `finalizedJournalId`，`saveImage()`（`Env.java:2313`）序列化整个 Env 到 `image.{seq}`，删除旧 journal。

**为什么**：纯 log 启动慢（回放数百万条），纯 image 无法实时持久化。image + log 组合让启动只加载一个 image + 回放少量增量 log。

### TabletInvertedIndex 反向索引

`TabletInvertedIndex`（`catalog/TabletInvertedIndex.java:68`）独立于 `OlapTable` 的内存索引，用 Guava `Table` 三维结构存储 tabletId→meta（`tabletMetaMap` `:79`）、partitionId→(indexId→meta)（`tabletMetaTable` `:93`）、tabletId→(backendId→Replica)（`replicaMetaTable` `:96`），避免遍历整棵元数据树。`TabletScheduler` 通过 `Env.getTabletInvertedIndex()` 访问 Tablet 健康状态。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Env.getCurrentEnv()` in `catalog/Env.java:810` | FE 进程单例，80+ 管理器统一入口 |
| Observer | `JournalObservable` in `qe/JournalObservable.java` | 非 Master FE 日志回放进度通知，DDL 等待元数据同步 |
| 命令模式 | `EditLog.loadJournal` switch in `persist/EditLog.java:166` | 每个 OperationType 对应一个 replayXxx 回放逻辑 |
| 策略模式 | `EditLog.journal` in `persist/EditLog.java:119` | BDBJEJournal vs LocalJournal 可切换 |

## 模块间交互

`Env` 被 qe、load、clone、transaction、alter 等几乎所有 FE 子系统 import 并通过 `Env.getCurrentEnv()` 访问。`EditLog` 持久化机制：`logEdit()`（`:1256`）是所有持久化操作统一入口，`loadJournal()`（`:166`）通过 `switch(opCode)` 分发回放。BDBJE 多 FE 选主：FOLLOWER 节点参与选主（Raft-like 协议），OBSERVER 节点不参与选主但可读取。

## 扩展方式

**新增一种表类型**：在 `Table.java` 的 `TableType` 枚举（`TableIf.java`）新增类型常量；在 `datasource/InternalCatalog.java:1141` 的 `createTable` if-else 链新增 `engineName` 分支；新建表类继承 `Table`/`OlapTable`；若需独立持久化 opCode，在 `EditLog.java:166` 的 `loadJournal` switch 新增 `OperationType.OP_CREATE_XXX` 分支。对应测试：`fe/fe-core/src/test/java/org/apache/doris/catalog/`。
