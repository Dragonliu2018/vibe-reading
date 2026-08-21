---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "事务与时间戳"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "C++", "事务", "MVCC", "TSO", "FoundationDB"]
description: "ByConity 分布式事务与全局时间戳：TSO 批量预分配、MVCC、IntentLock 与 CAS 提交。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/00-overview)

---

## 模块定位

ClickHouse 原版没有跨表分布式事务能力。ByConity 在存算分离之上补齐了事务层：`src/TSO/`（约 1.8k 行）提供全局单调递增时间戳，`src/Transaction/`（约 9k 行）在其上实现 ACID——用 commit_ts 作版本号实现 MVCC、用锁处理 DDL/表级冲突、用 FDB CAS 做原子提交。TSO 是独立服务（多副本选主），Transaction 是进程内协调器，二者共同回答"并发读写如何不互相破坏"。

---

## 模块架构

```text
┌─ TSO 服务（独立进程，多副本选主）─────────────────────┐
│  TSOServer (BaseDaemon, StorageElector 选主)            │
│    └─ TSOImpl: atomic ts (physical<<18 | logical)       │
│         fetchAddLogical() 批量预分配                     │
│  TSOProxy → Catalog::IMetaStore (t_last 持久化到 FDB)   │
│  TSOClient (brpc, 自动跟随 leader)                     │
├─ Transaction 协调器（进程内）──────────────────────────┤
│  TransactionCoordinatorRcCnch (Read Committed)         │
│    ├─ createTransaction → ICnchTransaction 多态:        │
│    │    CnchServerTransaction / CnchWorkerTransaction  │
│    │    CnchProxyTransaction / CnchExplicitTransaction │
│    ├─ GlobalTxnCommitter → TableTxnCommitter (per-table)│
│    └─ TransactionCleaner (后台清理 undo/record)        │
│  LockManager (singleton, striped)                      │
│    IntentLock (KV 级, 跨 server) / CnchLock (内存级)   │
└────────────────────────────────────────────────────────┘
```

TSO 提供"时间"，Transaction 消费"时间"做版本号与可见性。二者通过 `TxnTimestamp` 类型解耦。

---

## 调用链路

### 取时间戳

```text
Context::getTimestamp()
  └─ TSOClient::getTimestamp()  [TSOClient.cpp:89]  → brpc 到 leader
       └─ TSOImpl::GetTimestamp()
            └─ fetchAddLogical(1) = ts.fetch_add(1, acquire)  返回旧值
```

单调性保证：leader 唯一 + `updateTSO()` 每 50ms 持久化 `t_last` 到 KV + logical 原子递增。`tso_window`（默认 3s）允许 leader 不读 KV 批量分配时间戳；logical 用过半时推进 physical 并持久化新 t_last。

### 事务生命周期

```text
createTransaction()                           取 start_ts，建 TransactionRecord(Running)
  └─ appendAction(InsertAction/MergeMutateAction/...)  action 持有 part + undo buffer
commitV2()
  ├─ precommit()  每个 action->executeV2() 写 part 到 staging
  └─ commit()     取 commit_ts，CAS TransactionRecord(Running→Finished, commitTs) 写 Catalog
finishTransaction()  从 active_txn_list 移除，调度 TransactionCleaner::cleanTransaction()
  └─ clean()  成功: action->postCommit(), catalog->setCommitTime() 打 commit_ts 到 part, 清 undo
              失败: action->abort() 回滚中间 part, 删 record
```

![事务生命周期状态流](/vibe-reading/images/articles/byconity/transaction-state.svg)

### 锁

`IntentLock::writeIntents` → `catalog->writeIntents(prefix, intents, conflict_parts)` 写 KV 意图。冲突时查 conflict txn 状态：Running 且优先级低→CAS abort 抢占（`IntentLock.cpp:160-174`）；Inactive→rollback。`CnchLockHolder` 管理多个 `CnchLock`，经 `CnchTopologyMaster::getTargetServer` 路由到本地 `LockManager` 或远端 `CnchServerClient::acquireLock`。心跳每 5s `updateExpireTime` 续期（`CnchLock.cpp:219`）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `TSOImpl::GetTimestamp` | 分配全局时间戳 | atomic fetch_add |
| `TSOServer::syncTSO` | leader 上任同步 t_last | t_next = max(now, t_last_prev+1) |
| `TransactionCoordinatorRcCnch::createTransaction` | 建事务 | 取 start_ts + 多态分发 |
| `ICnchTransaction::commitV2` | 2PC 提交 | precommit + commit CAS |
| `GlobalTxnCommitter::commit` | 表级提交 | 非 leader 转发 leader |
| `TableTxnCommitter::getNewVersion` | 取表新版本号 | TSO commit_ts |
| `LockManager::lock` | 加锁 | striped + 冲突抢占 |
| `TransactionCleaner::cleanTransaction` | 清理 undo/record | 成功 TTL 删 / 失败立即删 |

</details>

---

## 核心实现

### 为什么独立 TSO 而非用 FDB 时间戳

FDB 跨 region 延迟可达数十毫秒。TSO 在本地用 `atomic fetch_add`（微秒级），通过 `tso_window`（3s）批量预分配——leader 每 50ms 更新一次 physical 并持久化 `t_last`（`TSOServer.cpp:143-196`），期间完全靠 local logical 递增，不读 KV。这把"每次取时间戳一次 FDB 往返"降为"几乎零开销的本地原子操作"。

### 全局单调递增

单一 leader + `t_last` 持久化到 KV。`syncTSO`（`TSOServer.cpp:101-141`）在 leader 上任时从 KV 读 `t_last_prev`，设 `t_next = max(t_now, t_last_prev+1)`，确保新 leader 时间戳大于旧 leader 持久化值。logical 溢出时 `checkLogicalClock` yield leadership（`TSOImpl.cpp:148-181`）。`TxnTimestamp` 位布局：高 46 位物理毫秒、低 18 位逻辑（`TSO/Defines.h`，`LOGICAL_BITS=18`）。

### MVCC 与可见性

事务 commit 时取 commit_ts，`TransactionCleaner::cleanCommittedTxn` 调 `catalog->setCommitTime(table, CommitItems{parts,bitmaps,staged}, commitTs, txnID)`（`TransactionCleaner.cpp:157`）把 commit_ts 打到 part 元数据。读取时 `getMinActiveTimestamp()` 返回当前最小活跃事务时间戳，确定可见性下界，按 snapshot_ts 过滤——这是与 [Catalog 的多版本 key](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/01-catalog) 配合的 MVCC。

### IntentLock vs CnchLock

`IntentLock` 是 KV 级锁，经 `catalog->writeIntents` 写 metastore，跨 server 可见，用于 DDL/表级互斥。`CnchLock` 是内存级锁，经 `LockManager` striped map 管理，支持 TABLE/PARTITION/BUCKET 三级 + IS/IX/S/X 四模式（`LockDefines.h`），本地快但仅单 server 有效——跨 server 经 `CnchServerClient` RPC 路由到 target server 执行。

### 多 server 事务协调

无全局锁服务。`GlobalTxnCommitter::commit` 先检查 `server_manager->isLeader()`，非 leader 转发到 leader server（`GlobalTxnCommitter.cpp:36-43`）。原子性由 FDB CAS 保证——`setTransactionRecord(old, new)` 是 FDB CAS，只有一个并发 commit 能成功。`LockManager` 的 `topology_version` 检查（`LockManager.cpp:350-361`）在 unlock 时验证 server 拓扑是否变化，防止拓扑切换期间并行锁持有。`TransactionCleaner` 用两个线程池：`server_thread_pool`（HIGH，事务完成同步调度）与 `dm_thread_pool`（LOW，DM 后台补充）；`scanActiveTransactions` 默认 10 分钟扫描，过期事务（默认 24h）强制清理。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 代理 | `TSOProxy`（TSOProxy.cpp）、`CnchProxyTransaction` | 代理 metastore / 远端事务 |
| 协调器 | `TransactionCoordinatorRcCnch` | 集中创建/提交/清理 |
| 策略 | `ICnchTransaction` 多态 | Server/Worker/Proxy/Explicit |
| 缓存 | `TimestampCache`/`TransactionRecordCache` | 减少 TSO RPC |
| 单例 | `LockManager : ext::singleton` | 全局锁视图 |

---

## 模块间交互

依赖 Catalog（commit record、undo buffer、intent、part 元数据存 FDB）、TSO。被 CloudServices（写入去重用 commit_ts）、Optimizer/Interpreter（`Context::getCnchTransactionCoordinator`）、Storages（part 打 commit_ts）调用。

---

## 扩展方式

**新增事务类型**：继承 `ICnchTransaction`，实现 `commitV2/precommit/commit/rollback/abort/clean`，在 `TransactionCoordinatorRcCnch::createTransaction` 按 `CnchTransactionType` 分发。

**调整 TSO 批量预分配**：修改 `tso_service.tso_window_ms`（默认 3000）增大窗口减 KV 写频率但增 leader 切换等待；修改 `TSO_UPDATE_INTERVAL`（`Defines.h:27`，50ms）影响物理时间更新频率。

**新增锁类型**：`LockDefines.h` 的 `LockMode` 加模式并更新 `conflicts()` 兼容矩阵；需新锁级别则在 `LockLevel` 加并扩展 `lock_maps`。
