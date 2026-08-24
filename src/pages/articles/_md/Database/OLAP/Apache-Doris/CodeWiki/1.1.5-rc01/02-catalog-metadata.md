---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "元数据与 Catalog"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "catalog", "Catalog god class", "EditLog", "BDBJE", "HA", "fencing"]
description: "Doris 1.1.5 元数据与 Catalog：Catalog god class（7424 行服务定位器单例）、Database/OlapTable/FunctionSet 元数据、EditLog+BDBJE 复制选主 HA、fencing 脑裂防护、journal 回放。2.x 拆分重命名为 Env。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

本模块由 `fe/.../catalog/`（~3.5 万行）、`journal/`、`persist/` 组成，是 FE 的元数据中心与高可用基石。`catalog/Catalog.java`（7424 行）是 1.x 的 **god class / 服务定位器**——集中元数据存储、DDL 执行、ID 分配、HA 选主、日志回放、image 持久化、50+ 管理器持有。它是 326 处被 import 的最频繁依赖，是所有 FE 模块的元数据来源。2.x 将其拆分并重命名为 `Env.java`，但 1.1.5 仍是单体 Catalog。

## 模块架构

```
Catalog (catalog/Catalog.java:301) ── 单例 (SingletonHolder:519, getCurrentCatalog:641)
   ├─ idToDb / fullNameToDb          ── Database 双索引
   ├─ idToCluster / nameToCluster
   ├─ editLog (EditLog)               ── 日志写入封装 (:382)
   ├─ idGenerator (CatalogIdGenerator) ── 全局递增 ID (:380)
   ├─ haProtocol (HAProtocol)         ── 指向 BDBHA (:411)
   ├─ journalObservable               ── 回放进度通知 (:404)
   ├─ frontends / role / feType       ── FE 节点与角色 MASTER/FOLLOWER/OBSERVER
   ├─ isReady / canRead              ── 服务就绪状态
   └─ 50+ 管理器: globalTransactionMgr / auth / tabletScheduler / loadManager /
                   routineLoadManager / alter / backupHandler / statisticsManager ...
       │
       ▼  写操作
   Database (catalog/Database.java:44) ── extends MetaObject
   ├─ rwLock (ReentrantReadWriteLock)  ── 细粒度读写锁
   ├─ idToTable / nameToTable
   └─ createTableWithLock() (:328)     ── 写内存 + 写 EditLog
       │
       ▼  日志
   EditLog (persist/EditLog.java:81)
   ├─ journal (Journal 接口 → BDBJEJournal, :91)
   ├─ logEdit(op, writable) (:860)     ── 核心写入
   ├─ logCreateDb/logCreateTable/...   ── DDL 语义级 API
   └─ loadJournal() static (:125)      ── 回放 switch 分发
       │
       ▼
   BDBJEJournal (journal/bdbje/BDBJEJournal.java:49) implements Journal
   ├─ write(op, writable) (:112)       ── JournalEntity → BDB put
   ├─ open() (:296) / rollJournal() (:89)
   └─ BDBEnvironment (BDBEnvironment.java:65)
        ├─ replicatedEnvironment (ReplicatedEnvironment) ── BDBJE HA 核心
        ├─ epochDB                       ── fencing 用 epoch 锁
        ├─ setup() (:87) ── 配置复制环境 + 注入 BDBHA (:173) + 注册 StateChangeListener (:177)
        └─ BDBHA (ha/BDBHA.java:44) implements HAProtocol
             ├─ fencing() (:62) ── epochDB.putNoOverwrite 脑裂防护
             └─ isLeader() (:196) ── 查询 master 节点
```

## 调用链路

建表写操作链路：

```
createTable(CreateTableStmt)                       [Catalog.java:3016]
  → getDbOrDdlException(dbName)
  → createOlapTable(db, stmt)                      [Catalog.java:3654]
    → getNextId()                                  [Catalog.java:4954 → CatalogIdGenerator]
    → new OlapTable(...)                           [OlapTable.java:162]
    → createPartitionWithIndices()                 ── Partition→MaterializedIndex→Tablet→Replica
    → db.createTableWithLock(olapTable, ...)       [Database.java:328]
       ├─ writeLock()
       ├─ idToTable.put / nameToTable.put
       └─ Catalog.getCurrentCatalog().getEditLog().logCreateTable(info)  [Database.java:348]
            → logEdit(OP_CREATE_TABLE, info)       [EditLog.java:860 → 943]
              → journal.write(op, writable)        [EditLog.java:865]
                → BDBJEJournal.write()             [BDBJEJournal.java:112]
                  → new JournalEntity; setOpCode/setData
                  → nextJournalId.getAndIncrement()
                  → currentJournalDB.put()         ── 写入 BDBJE (Durability 由 master_sync_policy 决定)
```

Master 选举与日志回放：

```
BDBEnvironment.setup()                             [BDBEnvironment.java:87]
  → new ReplicatedEnvironment(...)                 ── BDBJE 自动选举 master
  → new BDBHA(this, nodeName); Catalog.setHaProtocol()  [:173]
  → setStateChangeListener(BDBStateChangeListener)  [:177]
       ↓ BDBJE 选举完成回调
BDBStateChangeListener.stateChange()               [ha/BDBStateChangeListener.java:38]
  → Catalog.notifyNewFETypeTransfer(newType)       [Catalog.java:2315]
    → typeTransferQueue.put(newType)                ── 入队
       ↓ stateListener daemon 消费
  case INIT/UNKNOWN → MASTER:  transferToMaster()  [Catalog.java:1238]
    → replayer.exit()/join()                        ── 停回放线程
    → editLog.open() → BDBJEJournal.open()          ── 以 electable 加入复制组
    → haProtocol.fencing() → BDBHA.fencing()         [BDBHA.java:62]
       └─ epochDB.putNoOverwrite(epoch)             ── 获得 epoch，防脑裂
    → replayJournal(-1)                             [Catalog.java:2435]
       └─ EditLog.loadJournal(this, entity)         [EditLog.java:125] ── switch opCode → replayCreateDb/Table/...
    → editLog.rollEditLog(); startMasterOnlyDaemonThreads()  ── publishVersion/tabletScheduler/loadJobScheduler...
    → canRead.set(true); isReady.set(true)
  case → FOLLOWER/OBSERVER: transferToNonMaster()   [Catalog.java:1419]
    → createReplayer(); replayer.start()            ── 持续回放 journal
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `Catalog.getCurrentCatalog` | 获取单例 | 静态内部类 SingletonHolder 懒加载线程安全 |
| `Catalog.getNextId` | 分配全局 ID | CatalogIdGenerator 原子递增 |
| `Database.createTableWithLock` | 建表 | 写内存 + 写 EditLog，读写锁保护 |
| `EditLog.logEdit` | 日志写入 | opCode+Writable 编码，自动 roll |
| `EditLog.loadJournal` | 回放分发 | static switch-case 处理所有 opCode |
| `BDBJEJournal.write` | 写 BDB | JournalEntity 序列化 put |
| `BDBHA.fencing` | 脑裂防护 | epochDB.putNoOverwrite 获取 epoch token |
| `Catalog.transferToMaster` | 升主 | 停回放→开 BDBJE→fencing→回放→启 daemon |
| `Catalog.replayJournal` | 日志回放 | 按 journalId 读→loadJournal→notifyObservers |

</details>

## 核心实现

### Catalog god class（7424 行）

`Catalog` 集中了元数据存储（`idToDb`/`fullNameToDb`）、DDL 执行（`createDb`/`createTable`/`createOlapTable`/`dropTable`）、ID 分配（`getNextId`）、HA 管理（`transferToMaster`/`transferToNonMaster`/`replayJournal`/`isMaster`）、日志回放（50+ `replayXxx`）、image 持久化（`loadImage`/`saveImage`）、服务定位（50+ 管理器 getter）、节点管理、回收站、权限、统计等职责。**为什么**：早期 FE 规模小，集中简化开发；随功能增长不断膨胀。2.x 拆分为 `Env.java` + 独立 `DatabaseMgr`/`TabletMgr`/`FunctionMgr` 等，但 1.1.5 尚未完成。

### BDBJE HA + fencing

`BDBEnvironment`（`:65`）配置 `ReplicatedEnvironment`（BDBJE HA 核心），BDBJE 内部自动处理 master 选举、日志复制、quorum 确认——Doris 不需自实现 Paxos/Raft。`Durability` 策略由 `Config.master_sync_policy`/`replica_sync_policy`/`replica_ack_policy` 控制多数副本持久化。`BDBHA.fencing()`（`BDBHA.java:62`）通过 `epochDB.putNoOverwrite` 实现 fencing token——旧 master 脑裂后无法写新 epoch，不能继续写入。**为什么用 BDBJE**：内置复制与选举、强一致写入、fencing 机制、嵌入式（FE 进程内，无需独立部署 ZK）。代价是 BDBJE 商业许可（Sleepycat License）。

### EditLog 是 BDBJE 的封装

分层：`Catalog`（DDL）→ `EditLog`（日志抽象，`logXxx` API + `loadJournal` 回放分发）→ `Journal` 接口 → `BDBJEJournal`（BDBJE 实现）→ `BDBEnvironment`（复制环境）。`EditLog` 构造时 `journal = new BDBJEJournal(nodeName)`（`:93`），每个 `logXxx` 调 `logEdit(op, writable)`（`:860`）→ `journal.write`。EditLog 的价值：DDL 语义级 API、opCode 映射、`loadJournal()` 静态回放分发器、txId 计数与自动 roll。

### 为什么 1.x 叫 Catalog 而 2.x 重命名为 Env

`Catalog` 同时指"元数据中心管理类"和"外部 Catalog"（ExternalCatalog），2.x 引入 Multi-Catalog 后命名严重歧义；拆分后剩余核心类更适合叫 `Env`（运行时环境/服务定位器），因其已远超"目录"语义，承担事务、统计、备份、副本调度等。1.1.5 仍叫 Catalog。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例 | `Catalog.SingletonHolder` in `Catalog.java:519` | 懒加载线程安全单例；checkpoint 线程用独立 CHECKPOINT 实例 |
| 服务定位器 | `Catalog` 持 50+ 管理器 | 集中获取，避免到处传参；代价是 god class |
| 观察者 | `JournalObservable` in `qe/JournalObservable.java:28` + `notifyObservers` in `Catalog.java:2463` | non-master 回放完 journal 后通知等待者（DDL 需等 follower 同步） |
| 命令 | `OperationType` + `JournalEntity` + `EditLog.loadJournal` switch in `persist/` | 元数据操作编码为 opCode+Writable 序列化，可回放 |
| 策略 | `Journal` 接口 → `BDBJEJournal` in `journal/Journal.java:23` | 日志实现可替换（local/ 亦有实现） |
| 状态监听 | `BDBStateChangeListener` in `ha/BDBStateChangeListener.java:30` | BDBJE 选举完成回调转 Doris FrontendNodeType |

## 模块间交互

被 326 处 import（analysis 118、common/proc 33、httpv2/rest 19、qe 12、load 11、alter 8、task 7、planner 7、backup 7、clone 6、transaction 5）。依赖 `alter`/`clone`/`cluster`/`common`/`ha`/`journal`/`persist`/`system`/`transaction`/`backup`/`statistics`/`mysql.privilege`。所有 DDL 操作经 Catalog 入口，所有元数据查询经 Catalog getter。

## 扩展方式

**新增元数据对象类型**：`catalog/` 建类；`persist/OperationType.java` 分配新 opCode；`EditLog` 加 `logXxx` + `loadJournal` switch 分支；`Catalog` 加 `createXxx`/`replayXxx` + `loadXxx`（image 序列化）。**修改 HA 选举**：`BDBEnvironment.setup()` `:87` 改 ReplicationConfig；深度改需替换 `BDBHA` 为新 `HAProtocol` 实现（接近 2.x 探索方向）。
