---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "集群管理与运维"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "clone", "alter", "backup", "TabletScheduler", "Schema Change"]
description: "Doris 0.14.0 集群运维：TabletScheduler+TabletChecker 副本自均衡、SchemaChangeHandler 在线 Schema Change、BackupHandler 备份恢复、MasterImpl 任务回报、Master FE 后台职责域。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块由 `clone/`（副本均衡）、`alter/`（Schema Change）、`backup/`（备份恢复）、`master/`（Master 任务回报）、`system/`（BE 节点管理）组成，是 Master FE 的**后台运维职责域**。这些管理器都是 `MasterDaemon`（仅 Master 节点运行），独立于查询路径——查询是即时响应，运维是后台长周期任务。

## 模块架构

```
Master FE 后台 Daemon 群
  │
  ├─ TabletChecker (clone/TabletChecker.java:59) ── extends MasterDaemon
  │   └─ 周期扫描 → 产出待调度 tablet → 喂给 TabletScheduler
  │
  ├─ TabletScheduler (clone/TabletScheduler.java:87) ── extends MasterDaemon
  │   ├─ pendingTablets 队列
  │   ├─ 选 tablet → 创建 CloneTask（副本补齐/均衡）
  │   └─ Rebalancer 策略（BeLoad / Partition）
  │
  ├─ Alter / SchemaChangeHandler (alter/SchemaChangeHandler.java:103) ── extends AlterHandler
  │   └─ Shadow index + watershedTxn 在线不阻塞
  │
  ├─ BackupHandler (backup/BackupHandler.java:76) ── extends MasterDaemon implements Writable
  │   └─ BackupJob / RestoreJob + 仓库（Broker/本地）
  │
  ├─ MasterImpl (master/MasterImpl.java:81) ── BE 任务回报处理
  │   └─ finishTask / reportTablet / reportDisk / reportOlapTable
  │
  └─ SystemInfoService (system/) ── BE 节点拓扑 + 心跳
      └─ DynamicPartitionScheduler ── 动态分区
```

## 调用链路

```
[副本补齐]
TabletChecker 周期扫描 → 发现 unhealthy tablet（副本数不足/版本落后）
  → 加入 TabletScheduler.pendingTablets
TabletScheduler.run() → 选 tablet → 选源/目标 BE
  → 创建 CloneTask → 包装 AgentBatchTask（task/）→ 下发 BE
  → BE clone 完成回报 → MasterImpl.finishTask() (master/MasterImpl.java:81)
  → 更新 TabletInvertedIndex + Catalog

[在线 Schema Change]
DDL 提交 Alter Job → SchemaChangeHandler (alter/SchemaChangeHandler.java:103)
  → 建 Shadow index（新 Schema 的影子表）
  → watershedTxn：分水岭事务前数据走老 Schema、之后走新
  → 后台 convert 老数据到新 Schema
  → 完成 → 切换元数据 → 删老 index
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `TabletChecker`（`:59`） | 扫描 unhealthy tablet | MasterDaemon 周期运行，产出待调度集合 |
| `TabletScheduler`（`:87`） | 调度 clone 任务 | 从 pendingTablets 取，按 Rebalancer 策略选目标 |
| `SchemaChangeHandler`（`:103`） | 在线 Schema Change | Shadow index + watershedTxn，不阻塞读写 |
| `BackupHandler`（`:76`） | 备份恢复 | MasterDaemon + Writable，BackupJob/RestoreJob |
| `MasterImpl.finishTask`（`:81`） | BE 任务回报 | 处理 clone/alter/publish 等任务完成回报 |

</details>

## 核心实现

### 副本自均衡：Checker + Scheduler 两段式

0.14.0 的副本均衡是 `TabletChecker`（`clone/TabletChecker.java:59`）+ `TabletScheduler`（`:87`）两段式：Checker 周期扫描所有 tablet，把 unhealthy 的（副本数不足、版本落后、存储介质不符）加入 Scheduler 的 `pendingTablets`；Scheduler 从队列取 tablet，按 `Rebalancer` 策略（BeLoad 负载均衡 / Partition 分区均衡）选源/目标 BE，创建 `CloneTask` 经 `task.AgentBatchTask` 下发 BE 执行。两者都是 `MasterDaemon`——只在 Master FE 运行，保证唯一调度源。

### 在线 Schema Change：Shadow index + 分水岭事务

`SchemaChangeHandler`（`alter/SchemaChangeHandler.java:103`）实现在线 Schema Change：建新 Schema 的影子 index，以 `watershedTxn`（分水岭事务）为界——分水岭之前的数据后台 convert 到新 Schema，之后的新导入直接写新 Schema。这样读写不被阻塞，变更完成后切换元数据并删除老 index。这是 Doris "在线变更"能力的核心。

### MasterImpl 任务回报中枢

`MasterImpl`（`master/MasterImpl.java:81`）是 Master FE 处理 BE 任务回报的中枢——`finishTask`（clone/alter/publish 等任务完成）、`reportTablet`/`reportDisk`/`reportOlapTable`（BE 定期上报 tablet/磁盘/表状态）。这些回报经 `Catalog` 更新 `TabletInvertedIndex`/`SystemInfoService`，形成 BE→FE 的状态回流闭环。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| MasterDaemon | `TabletScheduler`/`TabletChecker`/`BackupHandler` | 仅 Master 运行的后台 Daemon，保证唯一调度源 |
| 两段式 | Checker→Scheduler | 发现与调度解耦，各司其职 |
| 策略 | `Rebalancer`（BeLoad/Partition） | 均衡策略可插拔 |
| 影子 + 分水岭 | `SchemaChangeHandler`（`:103`） | 在线不阻塞的 Schema 变更 |

## 模块间交互

运维管理器全部挂在 `Catalog` 上（`Catalog` 持有 `TabletScheduler`/`TabletChecker`/`Alter`/`BackupHandler` 等），经 `task` 模块的 `AgentBatchTask` 下发 BE 任务，BE 回报经 `master/MasterImpl` 处理。`clone` 依赖 `system`（BE 拓扑）与 `catalog`（`TabletInvertedIndex`）。`alter` 依赖 `transaction`（watershedTxn）。

## 扩展方式

新增均衡策略：实现 `Rebalancer` 子类，在 `TabletScheduler` 构造时按 `Config.tablet_rebalancer_type` 选。新增 BE 任务类型：在 `gensrc/thrift/AgentService.thrift` 加任务类型 + `task` 模块的 Task worker + `MasterImpl.finishTask` 分支。新增在线变更类型：扩展 `SchemaChangeHandler` 的 convert 逻辑。
