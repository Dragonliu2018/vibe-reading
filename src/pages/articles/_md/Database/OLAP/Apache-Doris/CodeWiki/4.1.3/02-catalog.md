---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Catalog 元数据"
date: "2026-08-23T18:24:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "Env", "EditLog", "BDBJE", "元数据"]
description: "Doris 元数据中枢：Env 服务定位器 + OlapTable/Tablet/Partition 元数据 + EditLog/BDBJE 持久化与高可用。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

Catalog 元数据模块（`fe/fe-core/.../catalog/` + `persist/`）是 Doris FE 的元数据中枢。它管理 Database/Table/Partition/Tablet/Replica 的全部元数据，通过 EditLog WAL 保证强一致，通过 BDB JE 复制实现 Master-Follower 高可用，通过 `Env` 服务定位器把 80+ 子服务装配在一个单例里供全 FE 访问。它独立成文是因为元数据的一致性与持久化是独立于查询/导入逻辑的关注点——所有模块都依赖它，但它不依赖任何模块的业务逻辑。

## 模块架构

模块核心是 `Env`（服务定位器/God Class，`catalog/Env.java` 7584 行）和元数据对象继承体系。`Env` 持有 80+ 子服务字段，构造函数集中实例化：

```java title="catalog/Env.java (字段与构造)"
public class Env {
    private static class SingletonHolder {
        private static final Env INSTANCE = EnvFactory.getInstance().createEnv(false);
    }
    private CatalogMgr catalogMgr;            // Catalog 管理
    private LoadManager loadManager;          // 导入
    private Alter alter;                      // Schema 变更
    private GlobalTransactionMgrIface globalTransactionMgr;  // 事务
    private TabletScheduler tabletScheduler;  // 副本调度
    private EditLog editLog;                  // WAL
    private HAProtocol haProtocol;            // 高可用
    private Auth auth;                        // 鉴权
    // ... 80+ 字段
    public Env(boolean isCheckpoint) {
        this.catalogMgr = new CatalogMgr();
        this.alter = new Alter();
        this.tabletScheduler = new TabletScheduler(this, systemInfo, ...);
        // ... 集中装配
    }
}
```

元数据对象继承体系：

```
TableIf (接口)  → Table (抽象) → OlapTable / EsTable / MTMV ...
Tablet (抽象)   → LocalTablet / CloudTablet
Replica (抽象)  → LocalReplica / CloudReplica
CatalogIf       → InternalCatalog / ExternalCatalog
```

`EnvFactory`（`catalog/EnvFactory.java`）按 `Config.isCloudMode()` 选择 `EnvFactory` 或 `CloudEnvFactory`，创建不同模式的 Env/InternalCatalog/Tablet/Replica 实现。

## 调用链路

DDL（CREATE TABLE）从 SQL 到元数据落盘：

```
CreateTableCommand.run (nereids/.../CreateTableCommand.java:91)
  └─ Env.createTable(createTableInfo) (Env.java:3592)
       └─ catalogIf.createTable → InternalCatalog.createOlapTable (InternalCatalog.java:2385)
            ├─ 创建 OlapTable/Partition/Tablet/Replica 对象
            ├─ db.createTableWithoutLock(table) (Database.java:423)
            │    └─ registerTable + Env.editLog.logCreateTable(info)
            └─ EditLog.logCreateTable (EditLog.java:1702)
                 └─ logEdit(OP_CREATE_TABLE, info) → journal.write
                      └─ BDBJEJournal.write → BDB JE 持久化
```

Follower 回放：`Replayer` 线程 → `Env.replayJournal`（`Env.java:3183`）→ `EditLog.loadJournal`（`EditLog.java:294`，1200+ 行 switch）→ `Env.replayCreateTable` 改内存。

查询时元数据读取：`Nereids` 的 `PhysicalCatalogRelation.getTableInfo` → `Env.getCatalogMgr().getCatalogOrAnalysisException` → `DatabaseIf.getTableNullable` → `OlapTable.getBaseSchema`/`getPartitions`。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `Env.getCurrentEnv` | 获取单例 | checkpoint 线程用独立实例 |
| `Env.getNextId` | 生成全局唯一 ID | `MetaIdGenerator` 原子递增 |
| `InternalCatalog.createOlapTable` | 建 OLAP 表 | 调 BE 建副本 + 写 EditLog |
| `Database.createTableWithoutLock` | 注册表到内存 | `idToTable`/`nameToTable` 双索引 |
| `EditLog.logCreateTable` | 写建表日志 | `logEdit` → `journal.write` |
| `EditLog.loadJournal` | 回放日志 | switch OpCode 分发 replay |
| `Checkpoint.doCheckpoint` | 全量 Image | loadImage+replay → saveImage → push |
| `BDBHA.fencing` | 防脑裂 | epochDB 原子递增 |

</details>

## 核心实现

### Env 服务定位器

`Env` 采用静态内部类单例（`Env.java:707`）+ `EnvFactory` 工厂方法双模式。所有模块通过 `Env.getCurrentEnv().getXxx()` 获取依赖，如 `LoadManager.java:151` 的 `Env.getCurrentEnv().getEditLog().logCreateLoadJob`、`TabletScheduler.java:1287` 的 `Env.getCurrentEnv().getEditLog().logDeleteReplica`。这避免了 Java 生态无 DI 框架时的手动参数传递，代价是 `Env.java` 膨胀到 7584 行、持有 80+ 引用成为 God Class——改一个字段影响面大，靠 `EnvFactory` 子类化（Cloud 模式）部分缓解。

### EditLog WAL + Image 二级持久化

`EditLog`（`persist/EditLog.java` 2565 行）实现 WAL，所有元数据变更先写日志再改内存。它不直接写 BDBJE，而是通过 `Journal` 接口解耦后端：`Journal.write` → `BDBJEJournal.write`（生产）或 `LocalJournal`（测试）。支持批量写入（`enable_batch_editlog` 时 `logEditWithQueue` 守护线程批量刷盘）。

纯 WAL 会导致日志无限增长、重启回放慢，Doris 用 **Image + EditLog 二级机制**：`Checkpoint.doCheckpoint`（`master/Checkpoint.java:99`）周期把内存全量序列化为 `image.{journalId}`（`Env.saveImage` → `MetaWriter.write`），HTTP 推送到所有 Follower，成功后删旧 EditLog。重启时先 `loadImage` 再 `replayJournal` 增量回放到目标版本。

### Master-Follower 高可用

`BDBHA`（`ha/BDBHA.java`）封装 BDB JE 的 `ReplicationGroupAdmin`，提供选主、节点管理、fencing。BDB JE 内置 Paxos 变体选主，FE 节点分 MASTER/FOLLOWER/OBSERVER 三角色。**Fencing**（`BDBHA.java:72`）新 Master 通过 `epochDB.putNoOverwrite` 原子递增 epoch 号，防止脑裂时旧 Master 继续写入。`Env.startStateListener`（`Env.java:3072`）监听 BDB JE 状态变更，触发 `transferToMaster`（启动 publishVersionDaemon/TabletScheduler/Checkpoint 等 Master 专属 daemon）或 `transferToNonMaster`。新加入 Follower 数据未同步完成前，`setElectableGroupSizeOverride` 降低选举组大小防止被误选为主。

### Tablet 副本与调度

`TabletScheduler`（`clone/TabletScheduler.java` 2377 行）优先级队列调度副本修复，`TabletChecker`（`clone/TabletChecker.java`）定期体检——`TabletStatus` 枚举（`REPLICA_MISSING`/`VERSION_INCOMPLETE`/`REDUNDANT`/`COLOCATE_MISMATCH`）标识不健康状态。`Rebalancer` 抽象（`clone/Rebalancer.java:59`）有 `BeLoadRebalancer`（默认按 BE 负载）、`PartitionRebalancer`、`DiskRebalancer`，由 `Config.tablet_rebalancer_type` 选择。`LocalTabletInvertedIndex`（`catalog/LocalTabletInvertedIndex.java`）维护 `tabletId↔(backendId↔Replica)` 双向倒排，BE tablet report 时快速比对。

### OlapTable 元数据对象

`OlapTable`（`catalog/OlapTable.java` 3988 行）持有 `indexIdToMeta`（`Map<Long, MaterializedIndexMeta>`）、`keysType`（DUP/UNIQUE/AGGREGATE）、`partitionInfo`、`idToPartition`（`ConcurrentHashMap`）、`colocateGroup`、`tableProperty` 等。`Partition`（`catalog/Partition.java`）含 `baseIndex`（`MaterializedIndex`）、`visibleVersion`/`nextVersion`、`distributionInfo`。`Tablet`（`catalog/Tablet.java`）抽象类管理 `Replica` 列表。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Env.java` | 无 DI 框架，全局 getter 简化依赖获取 |
| WAL | `EditLog.java` + `Journal` 接口 | 先写日志后改内存，保证不丢；接口解耦后端 |
| Master-Follower HA | `BDBHA.java` + `BDBEnvironment` | BDB JE 内置选主，避免自实现 Paxos |
| 工厂方法 | `EnvFactory.java` | 本地/Cloud 模式切换不同实现 |
| 模板方法 | `Tablet`/`Replica` 抽象基类 | 基类默认抛异常，子类按需覆写 |

## 模块间交互

被几乎所有 FE 模块通过 `Env` getter 调用：`nereids` 读表元数据（`PhysicalCatalogRelation.java:109`）、`qe` 读 `SessionVariable`/`SqlCacheManager`、`clone` 调 `TabletScheduler`/`EditLog`、`load` 调 `LoadManager`/`AccessManager`/`GlobalTransactionMgr`、`alter` 调 `Alter` 实例。`EditLog` 与 BDBJE 通过 `Journal` 接口解耦：`EditLog`（门面）→ `Journal`（接口）→ `BDBJEJournal`（持有 `BDBEnvironment` + `ReplicatedEnvironment`）。`persist/` 子模块提供数据载体：`OperationType`（150+ 种操作 `short` 常量）、各 `XxxInfo` 类（实现 `Writable`，Gson 序列化）、`MetaReader`/`MetaWriter`（Image 序列化）。

## 扩展方式

新增一种表属性：改 `OlapTable.java`（字段+getter/setter+`gsonPostProcess` 兼容）、`TableProperty.java`（OlapTable 注释明确要求"add property 时改 TableProperty"）、`common/util/PropertyAnalyzer.java`（SQL properties 解析）、`InternalCatalog.createOlapTable`（建表设属性）、如支持 ALTER 则加 `ModifyTablePropertyOperationLog` + `EditLog.logXxx` + `OperationType` + `Env.replayXxx`。

新增一种元数据 EditLog：在 `persist/OperationType.java` 加 `OP_XXX` 常量；新建 `XxxInfo` 实现 `Writable`；`EditLog` 加 `logXxx` 调 `logEdit(OP_XXX, info)`；`EditLog.loadJournal` switch 加 `case OP_XXX` 调 `env.replayXxx`；`Env` 加 `replayXxx`；如需入 Image 加 `MetaReader/Writer` 方法。
