---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Catalog 元数据"
date: "2026-08-23T18:58:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "Env", "BDBJE", "EditLog", "高可用"]
description: "Doris 3.1.4 Catalog 元数据：Env god class 集中元数据 + EditLog/BDBJE 复制高可用 + Master/Follower 选主。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

Catalog 元数据模块由 `catalog/`（~5 万行）+ `persist/`（~1.4 万行）+ `journal/` 组成，核心是 `Env`（`catalog/Env.java:358`，7034 行的 god class）——FE 的元数据、副本、事务状态、调度全部集中于此。它独立成文是因为元数据是所有 FE 模块的共享底座：优化器查表结构、协调器查副本位置、导入改事务状态、联邦查 catalog 树，都经 `Env`。高可用通过 EditLog + BDB JE 复制实现 Master/Follower 模式。

## 模块架构

```
                ┌─────────────────────────────┐
                │           Env (god class)   │  catalog/Env.java:358
                │  getCurrentEnv() 进程单例  │
                ├─────────────────────────────┤
  逻辑职责      │  CatalogMgr        (多 Catalog 树) │
                │  GlobalTransactionMgrIface (事务)   │
                │  TabletInvertedClause...     │
                │  各 Daemon 线程句柄          │
                ├─────────────────────────────┤
  持久化        │  EditLog  ── logXxx() 写日志  │  persist/EditLog.java
                │     │                        │
                │     ▼                        │
                │  BDBJEJournal  ── 复制+存储  │  journal/bdbje/BDBJEJournal.java
                │     │                        │
                │     ▼                        │
                │  BDBJE Environment (嵌入式 KV)│
                ├─────────────────────────────┤
  恢复          │  loadImage() ← image 文件   │
                │  replayJournal() ← EditLog  │
                └─────────────────────────────┘
```

`Env` 持有 `CatalogMgr`（`:674`，管理多 catalog 树，含内部 `InternalCatalog` 与外部 catalog）、`GlobalTransactionMgrIface`（`:938`，事务状态总控）、各资源管理器与 Daemon 线程句柄。

## 调用链路

FE 启动时 `Env` 的装配与恢复链：

```
DorisFE.start
  └─ Env.getCurrentEnv().initialize(args) (Env.java:1121)
       ├─ new BDBJEJournal(nodeName)        // 打开 BDBJE 环境
       ├─ loadImage(imageDir) (Env.java:1170 / 2194)  // 从 image 快照恢复元数据
       ├─ replayJournal(-1) (Env.java:3062)          // 回放 EditLog 增量
       │    └─ EditLog.loadJournal(this, logId, entity) (:3104)
       ├─ 角色判定：Master / Follower
       ├─ startMasterOnlyDaemonThreads() (:1872)   // Master 独有：副本均衡/统计
       └─ startNonMasterDaemonThreads() (:1971)    // 所有节点：心跳/上报
  └─ Env.waitForReady() (Env.java:1201)            // 等恢复完成
```

运行期写元数据的路径：调用方调 `Env.xxx()` → 内部改内存状态 → `EditLog.logXxx()` 写日志 → `BDBJEJournal` 复制到 Follower → Follower `replayJournal` 回放。读元数据直接走内存对象。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Env.initialize` (`:1121`) | 启动装配 | image + EditLog 回放两段恢复，先快照后增量 |
| `loadImage` (`:2194`) | 镜像恢复 | 全量快照，启动时一次性加载 |
| `replayJournal` (`:3062`) | 日志回放 | 增量补齐到最新，Master/Follower 都执行 |
| `waitForReady` (`:1201`) | 等就绪 | 阻塞直到恢复完成，DorisFE 后续服务依赖此 |
| `startMasterOnlyDaemonThreads` (`:1872`) | Master 专属线程 | 选主后才跑，避免多写 |
| `getCatalogMgr` (`:674`) | 取 catalog 树 | god class 入口 |

</details>

## 核心实现

### Master/Follower 高可用

Doris FE 集群是多副本（通常 3 或 5 个 FE），通过 BDB JE 的复制组实现选主：只有一个 Master 可写，其余 Follower 只读 + 接收日志复制。`BDBJEJournal`（`journal/bdbje/BDBJEJournal.java:73`，`implements Journal`）封装 BDB JE 环境，每个"database 以其最小 journal id 命名"（`:99-101`，如含 journal 100-200 的库叫 100），按 id 滚动建库控制单库大小。

设计决策：**为何用 BDB JE 而非 Raft**——BDB JE 是嵌入式、成熟、支持事务的 KV 复制存储，Doris 早期选型时它降低了自研一致性协议的工程成本；代价是依赖 JVM、与 BE 的 C++ 生态割裂。这也是 4.x 云模式把元数据迁到 FoundationDB（MetaService）的动机之一。

### 两段恢复：image + EditLog

`initialize` 先 `loadImage`（全量快照）再 `replayJournal`（增量日志），这是经典的"检查点 + 重做日志"恢复模型。`loadImage`（`:2194`）从 `imageDir` 读镜像文件反序列化整个 Catalog；`replayJournal`（`:3062`）从 image 之后的 journal id 开始回放 `JournalEntity`，经 `EditLog.loadJournal(this, logId, entity)`（`:3104`）分发到各 `replayXxx` 方法（如 `replayCreateDb` `:3364`、`replayDropDb` `:3385`、`replayEraseDatabase` `:3413`）。

设计决策：**image 的存在**——纯日志回放在长期运行后会无限增长，image 周期性把内存元数据快照落盘，回放只需"最近 image + 之后日志"，把恢复时间从 O(全部历史) 降到 O(最近窗口)。

### god class 与服务定位器

`Env` 既是服务定位器（持有所有子系统引用，`getXxx()` 即取）又是元数据持有者。这种"god class"在 Doris 早期简化了依赖注入——任何模块 `Env.getCurrentEnv().getXxx()` 即可拿到依赖，无需 DI 容器。代价是 `Env` 膨胀到 7000+ 行、高耦合，4.x 起在逐步拆分（如事务迁出）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Env.getCurrentEnv()` + `getXxx()` | 进程级单例，简化依赖获取 |
| Master/Follower 复制 | `BDBJEJournal` + 选主 | 单写多读，BDB JE 保证日志一致 |
| 检查点 + 重做日志 | `loadImage` + `replayJournal` | 限制恢复窗口，O(最近窗口) |
| Write-Ahead Log | `EditLog.logXxx` 先于内存提交 | 崩溃不丢已确认的元数据变更 |

## 模块间交互

`Env` 是 FE 的依赖汇聚点：`nereids/` 经 `TableCollector` 查表、`qe/Coordinator` 查副本位置、`load/` 经 `GlobalTransactionMgr` 改事务状态、`datasource/` 经 `CatalogMgr` 管 catalog 树、`clone/` 经副本调度器均衡。所有写操作经 `EditLog` 复制到 Follower。云模式下部分元数据职责移交给 Cloud `MetaService`（见 [11-cloud-metaservice](11-cloud-metaservice)）。

## 扩展方式

新增一类元数据对象：在 `catalog/` 下定义对象类（实现 `PersistMeta`/`Writable`）→ 在 `Env` 增加 `replayXxx` 方法 → 在 `EditLog` 增加 `logXxx` 与 `loadJournal` 分支 → 在 image 序列化（`persist/meta/`）中注册。注意 Master 写、Follower 回放的对称性。对应测试：`fe/fe-core/src/test/`。
