---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "元数据与 HA"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "元数据", "EditLog", "BDBJE", "Leader 选举", "epoch fencing"]
description: "StarRocks FE 元数据对象模型、EditLog 异步批量 WAL 复制、checkpoint 截断与 BDBJE epoch fencing 选举。"
readingTime: "16 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

FE 的一致性域：元数据对象模型（库表分区 tablet 的内存树）、元数据持久化与复制（EditLog→BDBJE）、镜像 checkpoint、Leader 选举。它独立成篇的原因是独特的正确性约束——**写路径与 Follower 回放共用同一份代码**，任何 DDL 的正确写法都被这个约束塑形。

## 模块架构

三层：对象模型在 `catalog/`（59k 行），复制与日志在 `persist/`+`journal/`，角色与选举在 `ha/`+`leader/`。所有写操作经 `server/LocalMetastore`（5984 行）落地，它替代了老版本巨型 CatalogMgr 中的元数据职责。

## 调用链路

### 元数据对象层级

```text
InternalCatalog → Database → Table → Partition → MaterializedIndex → Tablet
```

`Table` 基类（`catalog/Table.java:75`，`extends MetaObject implements Writable, GsonPostProcessable, BasicTable`）内嵌 `TableType` 枚举（:84）约 32 种。继承体系值得记住三条枝：

- `OlapTable extends Table`（`OlapTable.java:173`）——内表主体，持 keysType/分区表/partitionIdToPartitionMap；
- `lake/LakeTable extends OlapTable`（`LakeTable.java:58`）——存算分离表**复用 OlapTable 全部模型**，只重写数据布局与 replica 语义；外部表（HiveTable/IcebergTable/…）直接 `extends Table`，元数据来自 ExternalCatalog connector 而非 EditLog；
- `MaterializedView` 见 [06 物化视图](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/06-mv)。

### 一条 DDL 的写路径（以建表为例）

```java title="server/LocalMetastore.java:2260 起"
locker.lockDatabase(dbId, WRITE);
editLog.logCreateTable(createTableInfo,
        wal -> db.registerTableUnlocked(table));   // 内存变更作为 WALApplier 回调
locker.unLockDatabase(...);
```

`logCreateTable`（`persist/EditLog.java:1537` 的 `logEditGated(short op, Writable, Runnable applyAction)`）进入 WAL fence → 入队 → `waitForCommit`（**不可中断**，防止内存与 WAL 分叉）→ commit 后在 fence 内执行 applyAction。Follower 侧 `EditLog.loadJournal()`（:161）按 `OperationType` switch 分发到 `replayCreateTable` 等回放函数——与写路径是**同一个 registerTableUnlocked lambda**。

## 核心实现

### 异步批量 WAL（与 Doris 的关键差异）

Doris 的 `logJournal` 同步直写 BDBJE；StarRocks main 分支演进为三层：

1. `EditLog.logEditGated`：调用方线程只入队并等 commit 通知；
2. `journal/JournalWriter.java`：独立守护线程从 blocking queue 批量取任务，一个 batch 调 `BDBJEJournal.batchWriteBegin/batchWriteAppend/batchWriteCommit`（`journal/bdbje/BDBJEJournal.java:301/335/386`）；
3. `BDBEnvironment`（:236）建 `ReplicatedEnvironment`，Durability 由 `Config.master_sync_policy` 控制；`REPLICA_MAX_GROUP_COMMIT=0`（:213）**禁用 BDB 组提交、由 JournalWriter 自己攒批**——把攒批的时序控制权从存储引擎收回到自己手里。

Follower 的 replayer 线程每 loop 回放上限 10 万条/1 秒（`GlobalStateMgr.replayJournal`，:300-302），落后超时可置 `canRead=false`。

### Checkpoint 集中调度

镜像生成在 `journal/CheckpointWorker.java`（GlobalState/StarMgr 两个子类），但**编排移到了 Leader 侧** `leader/CheckpointController.java`（LeaderDaemon）：Leader 选一个 Follower 下 checkpoint 任务，Follower 完成 `image.<journalId>` 后经 Thrift 上报，Leader `finishCheckpoint` → `deleteOldJournals`（:489）取 `min(imageVersion, minReplayedJournalId)` 截断日志——落后节点不会被截掉尚未回放的日志。这与 Doris（follower 自主 checkpoint 后 truncate）同思路但集中式调度。

### Epoch fencing 防脑裂

选举仍是 BDBJE mastership（无 FDB）：`ha/BDBHA.java` 封装 ReplicationGroupAdmin。关键演进是 **epoch fencing**——`BDBHA.fencing()` 在 Leader 切换时向专用 epochDB `putNoOverwrite` 写 `myEpoch = getLatestEpoch()+1`（`BDBHA.java:90-101`，`getLatestEpoch()` 用 `Get.LAST` 读末条，重试 3 次每次 sleep 2s）；`GlobalStateMgr.getEpoch()`（:2870）取 latest epoch 并 `publishLeaderLease`（:1541）；CheckpointWorker、JournalWriter 均校验 epoch，**老 Leader 的迟到写入会被 fence 掉**。

### 集中式锁管理

`common/util/concurrent/lock/LockManager.java:34`：按 rid（dbId/tableId）加锁，带**死锁检测**（fast/slow path，:106-238）。`Database` 本身不再内嵌 ReentrantReadWriteLock（与 Doris 显著不同），统一走 `Locker.lockDatabase(id, LockType.WRITE)`（`Database.java:247`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| WAL Applier | `logEditGated(op, writable, applyAction)` | 写与回放共用 mutate lambda，消除双份代码漂移 |
| Journal 抽象 | `journal/Journal.java` 接口 + `JournalFactory` | BDBJE 可替换 |
| 状态机驱动 | `ha/StateChangeExecutor.java` 的状态转移表（:110-144） | 角色转换串行化 |
| 失败可忽略条目 | `persist/IgnorableOnReplayFailed` | 升级兼容期容错 |

## 模块间交互

- 被 [01 FE 骨架](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/01-fe-server) 装配、被 `sql/analyzer`/`qe`/`load/` 读写；统计信息缓存（`CachedStatisticStorage` 等）被 [03 优化器](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/03-optimizer) 消费。
- shared-data 下与 `staros/StarMgrServer`（`starmgr_` 前缀的独立 journal 域）并存，见 [07 存算分离](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data)。

## 扩展方式

**新增 Table 类型**：`TableType` 枚举加值（注意 `@SerializedName` 兼容）→ 新类 extends Table 或 OlapTable → `persist/` 序列化与 `EditLog.loadJournal` 分发处登记 → CREATE 路径走 `logCreateTable(CreateTableInfo)`（新类型额外字段扩展 `persist/CreateTableInfo.java`）。

**新增 journal 条目**：`persist/OperationType.java` 分配 op id → 新 PersistInfo 类（Gson `@SerializedName`）→ `EditLog` 加 `logXxx(info, walApplier)` 写入口 + `loadJournal` switch 加 replay case（参照 `EditLog.java:236` OP_CREATE_TABLE_V2）。

**待核实**：follower FE 的 http 重定向具体位置（可能在 httpv2/rest 层）；`clone/`（TabletScheduler 均衡/修复）与持久化的关系未深入。
