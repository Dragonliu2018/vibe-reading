---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "元数据与 Catalog"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "catalog", "BDBJE", "EditLog", "HA", "god class"]
description: "Doris 0.14.0 元数据与 Catalog：6888 行 Catalog god class 服务定位器、BDBJE 复制选主、EditLog journal、image 持久化、Checkpoint 副本机制。2.x 拆分重命名为 Env。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块由 `catalog/`（~2.9 万行，含 6888 行 `Catalog.java`）、`persist/`（EditLog）、`journal/`（BDBJE 复制层）、`ha/`（高可用协议）组成，是 FE 的**元数据与调度总控**。`Catalog` 是 0.14.0 的 god class——集中持有 40+ 管理器，既是元数据仓库又是服务定位器。2.x 才将其拆分重命名为 `Env.java`。

## 模块架构

```
Catalog (catalog/Catalog.java:267) ── 进程级 god class 单例
   ├─ SingletonHolder.INSTANCE (:471)         ── 普通线程入口
   ├─ CHECKPOINT 副本 (:578)                   ── checkpoint 线程专用，避免污染主内存
   │
   ├─ 元数据仓库
   │   ├─ idToDb / fullNameToDb (ConcurrentHashMap)
   │   ├─ frontends / removedFrontends          ── FE 节点拓扑
   │   ├─ TabletInvertedIndex / ColocateTableIndex
   │   └─ SystemInfoService / HeartbeatMgr      ── BE 节点与心跳
   │
   ├─ 持久化与复制
   │   ├─ EditLog (persist/EditLog.java)        ── journal 写入接口
   │   │   └─ Journal → BDBJEJournal (journal/bdbje/)
   │   ├─ BDBEnvironment                        ── BDBJE 环境，集群选主
   │   └─ HAProtocol → BDBHA (ha/HAProtocol.java:23)
   │
   ├─ 调度/运维管理器（部分）
   │   ├─ GlobalTransactionMgr (transaction/GlobalTransactionMgr.java:59)
   │   ├─ TabletScheduler / TabletChecker       ── 副本均衡
   │   ├─ LoadManager / RoutineLoadManager      ── 导入
   │   ├─ Alter / BackupHandler / DeleteHandler ── Schema Change/备份/删除
   │   ├─ PublishVersionDaemon                  ── 版本发布
   │   └─ PaloAuth                              ── 鉴权（Palo 命名遗产）
   │
   └─ Daemon 线程
       ├─ replayer / listener                   ── journal 回放
       ├─ checkpointer                          ── image 定期落盘
       └─ labelCleaner / txnCleaner             ── 清理
```

## 调用链路

```
PaloFe.start() → Catalog.getCurrentCatalog().initialize(args)   [catalog/Catalog.java:718]
  → loadImage(imageDir)                                          [:1462 读 image 恢复元数据]
  → BDBEnvironment 启动 + 选主
  → transferToMaster() / transferToNonMaster()                   [:1136 / :1310]
       ├─ Master: 启动后台 Daemon（PublishVersion/TabletScheduler/...）
       └─ NonMaster: 启动 replayer → replayJournal(-1)           [:2419 回放 journal]
  → waitForReady()

写元数据（任意 DDL/事务状态变更）:
  Catalog.xxx() → editLog.append(journalEntity)  → BDBJEJournal → BDBJE 复制
                 → checkpoint 线程定期将 journal 落为 image（CHECKPOINT 副本）

读元数据（查询路径）:
  Analyzer → Catalog.getDb(name) / getTable() → idToDb/fullNameToDb (无锁读)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `getCurrentCatalog`（`:574`） | 获取 Catalog 单例 | checkpoint 线程返回独立 `CHECKPOINT` 实例，避免长 checkpoint 阻塞主内存 |
| `initialize`（`:718`） | 装配 Catalog | 先 image 后 journal，再选主——恢复优先于服务 |
| `loadImage`（`:1462`） | 从 image 恢复元数据 | image 是 journal 的压缩快照，加速冷启动 |
| `replayJournal`（`:2419`） | 回放 journal | NonMaster 持续回放以保持元数据同步 |
| `transferToMaster`（`:1136`） | 切为主 | BDBJE 选主后异步切角色，启动 Master 后台 Daemon |
| `transferToNonMaster`（`:1310`） | 切为从 | 启动 replayer 回放 journal |

</details>

## 核心实现

### god class：40+ 管理器的服务定位器

`Catalog`（`catalog/Catalog.java:267`）在构造函数（`:480`）里 `new` 出 40+ 个管理器并作为字段持有——`GlobalTransactionMgr`、`TabletScheduler`、`TabletChecker`、`LoadManager`、`RoutineLoadManager`、`Alter`、`BackupHandler`、`PublishVersionDaemon`、`DeleteHandler`、`SystemInfoService`、`HeartbeatMgr`、`TabletInvertedIndex`、`ColocateTableIndex`、`CatalogRecycleBin`、`FunctionSet`、`BrokerMgr`、`ResourceMgr`、`TabletStatMgr`、`PaloAuth`、`DynamicPartitionScheduler`、`PluginMgr`、`AuditEventProcessor` 等。这是典型的**服务定位器反模式**——好处是任何地方 `Catalog.getCurrentCatalog().getXxx()` 即可拿到依赖，坏处是 6888 行的 god class 耦合了所有职责，2.x 不得不拆分重命名为 `Env`。

### 元数据持久化：image + journal 双层

0.14.0 的元数据持久化是 **image（全量快照）+ journal（增量 WAL）** 双层：DDL/事务状态变更先 `editLog.append()` 写 journal（BDBJE 复制保证多副本一致），`checkpointer` Daemon 定期将内存元数据序列化为新的 image 文件并截断旧 journal。冷启动时 `loadImage`（`:1462`）读最新 image 快速恢复大部分元数据，再 `replayJournal`（`:2419`）回放 image 之后增量。这种设计让重启快（不全量回放 journal），且 image 是 journal 的压缩点。

### BDBJE 选主与脑裂防护

FE 高可用依赖 BDB JE 的内建复制与选主。`HAProtocol`（`ha/HAProtocol.java:23`）由 `BDBHA` 实现，`BDBEnvironment` 管理 BDBJE 集群。选主由 BDBJE 自动完成，`Catalog` 经 `typeTransferQueue` 收到角色变更后异步 `transferToMaster()`（`:1136`）/`transferToNonMaster()`（`:1310`）。Master 承担所有写职责（DDL、事务提交、副本调度、版本发布），NonMaster 只读并持续回放 journal。`Catalog.getCurrentCatalog()`（`:574`）对 **checkpoint 线程**返回独立 `CHECKPOINT` 副本实例（`:578`）——checkpoint 是重操作，用独立 Catalog 实例序列化 image 避免长 checkpoint 期间阻塞主内存的查询/写入。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Catalog`（`:267`） | 全局单例持有所有依赖，`getCurrentCatalog().getXxx()` 取用——双刃剑 |
| 单例 + 副本 | `SingletonHolder.INSTANCE` + `CHECKPOINT`（`:471`/`:578`） | 主路径单例，checkpoint 重操作用副本隔离 |
| 观察者 | `JournalObservable`（`qe/JournalObservable.java`） | journal 回放进度通知下游（如 NonMaster 同步） |
| WAL + 快照 | `EditLog`（journal）+ `loadImage`（image） | 增量日志 + 全量快照，加速冷启动与压缩 |

## 模块间交互

`Catalog` 被 `analysis`/`planner`（名字解析、Function 查找）、`qe`（`Coordinator` 取 scan range）、`load`/`transaction`（事务状态机依赖 `GlobalTransactionMgr`）、`clone`/`alter`/`backup`（运维管理器挂在 Catalog 上）共同依赖——它是 FE 的事实中心。BE 通过 `agent` 的 HeartbeatService 上报心跳与 tablet 报告，FE 侧 `HeartbeatMgr`/`SystemInfoService` 更新 `Catalog` 内的 BE 拓扑。

## 扩展方式

新增一种元数据实体：在 `Catalog` 加字段 + `loadImage`/写 image 序列化逻辑 + journal 实体类型（`persist/`）+ EditLog `append` 路径——这是 god class 的代价，每加一类元数据都要动 Catalog。新增后台 Daemon：实现 `MasterDaemon`，在 `transferToMaster` 启动。
