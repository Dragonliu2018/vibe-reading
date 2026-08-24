---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "数据导入与事务"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "load", "transaction", "两阶段提交", "Stream Load", "Routine Load"]
description: "Doris 0.14.0 数据导入与事务：Stream/Broker/Routine Load、4 态两阶段事务（PREPARE→COMMITTED→VISIBLE，无 PRECOMMITTED）、quorum 副本校验、MemTable→Rowset 刷盘。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块由 `load/`（~2.3 万行，含 `loadv2`/`routineload`/`sync`/`update`）与 `transaction/`（~0.38 万行）组成，是 FE 的**写路径**。导入是独立于读路径（查询）编排的——数据先经两阶段事务落地为不可变 Rowset，再发布版本使其对查询可见，保证原子性与一致性。

## 模块架构

```
导入请求（HTTP Stream Load / Broker Load / Routine Load Kafka）
  │
  ▼  (BE Thrift RPC → FE)
FrontendServiceImpl (service/FrontendServiceImpl.java:134)
   ├─ loadTxnBegin() (:707) → loadTxnBeginImpl() (:737)
   │   → GlobalTransactionMgr.beginTransaction()           [transaction/GlobalTransactionMgr.java:97]
   │       → DatabaseTransactionMgr.beginTransaction()      [:251] → TransactionState(PREPARE) + EditLog
   ├─ streamLoadPut() / StreamLoadPlanner.plan()           [planner/StreamLoadPlanner.java:98]
   │   → 生成含 OlapTableSink 的 fragment 返回 BE          (OlapTableSink :137)
   └─ loadTxnCommit() (:773) → loadTxnCommitImpl() (:800)
       → GlobalTransactionMgr.commitTransaction()          [:156]
           → DatabaseTransactionMgr.commitTransaction()    [:353]
               ├─ quorum 校验 (quorumReplicaNum = repNum/2+1) [:493]
               ├─ PREPARE → COMMITTED + EditLog
               └─ (异步) PublishVersionDaemon → PublishVersionTask → BE
                                      ↓
                               COMMITTED → VISIBLE (finishTransaction)

BE 写路径:
  StreamLoadPipe → OlapTableSink::send → DeltaWriter (olap/delta_writer.h:54)
     ├─ _mem_table (:108)   ── 内存收集
     └─ flush → BetaRowsetWriter → SegmentWriter.finalize (列存 Page + 索引)
```

## 调用链路

```
[Stream Load]
BE StreamLoadAction (http/action/stream_load.cpp) 解析 HTTP 头
  → begin_txn → FE loadTxnBegin()                          [FrontendServiceImpl.java:707]
       → GlobalTransactionMgr.beginTransaction()            [GlobalTransactionMgr.java:97]
  → FE streamLoadPut → StreamLoadPlanner.plan()             [StreamLoadPlanner.java:98]
       → OlapTableSink fragment 返回 BE                      (OlapTableSink :137)
  → BE FragmentMgr::exec_plan_fragment (need_txn=true)
       → ScanNode 读 StreamLoadPipe (CSV/JSON)
       → OlapTableSink::send → brpc tablet_writer_add_batch
       → 目标 BE DeltaWriter.write(MemTable)                [delta_writer.h:54]
       → MemTable 满 → flush → BetaRowsetWriter → Segment
  → BE loadTxnCommit() → FE loadTxnCommit                   [FrontendServiceImpl.java:773]
       → DatabaseTransactionMgr.commitTransaction()         [DatabaseTransactionMgr.java:353]
           ├─ 校验 successReplicaNum >= quorumReplicaNum     [:527 / quorum :493]
           └─ PREPARE → COMMITTED + EditLog
  → PublishVersionDaemon 异步下发 PublishVersionTask 到 BE
       → 全部成功 → finishTransaction() → COMMITTED → VISIBLE
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `loadTxnBegin`（`:707`） | 开事务 | 创建 `TransactionState(PREPARE)` 写 EditLog |
| `StreamLoadPlanner.plan`（`:98`） | 生成导入计划 | 生成含 `OlapTableSink` 的 fragment |
| `loadTxnCommit`（`:773`） | 提交事务 | 校验 quorum 后 PREPARE→COMMITTED |
| `DatabaseTransactionMgr.beginTransaction`（`:251`） | DB 级开事务 | 按 db 隔离事务状态 |
| `DatabaseTransactionMgr.commitTransaction`（`:353`） | DB 级提交 | quorum 副本校验（`:493`） |
| `DeltaWriter.write` | 写 MemTable | 攒批后 flush 为 Rowset Segment |

</details>

## 核心实现

### 4 态两阶段事务（无 PRECOMMITTED）

0.14.0 的 `TransactionStatus`（`transaction/TransactionStatus.java:20`）只有 **4 个状态**：`PREPARE(1)`/`COMMITTED(2)`/`VISIBLE(3)`/`ABORTED(4)`，`isFinalStatus()`（`:55`）判定 VISIBLE 与 ABORTED 为终态。导入两阶段提交的正常路径是 `PREPARE → COMMITTED → VISIBLE`：`commit`（`loadTxnCommit` at `FrontendServiceImpl.java:773`）把状态从 PREPARE 推到 COMMITTED（数据已安全写入），`publish`（`PublishVersionDaemon` 异步下发 `PublishVersionTask`）再把 COMMITTED 推到 VISIBLE（推进 `partition.visibleVersion` 使数据对查询可见）。**0.14.0 没有 1.x 的 `PRECOMMITTED` 预提交态**——事务状态机比 1.x 更简练。COMMITTED 与 VISIBLE 的分离让 commit 快速返回，publish 异步进行不阻塞导入；查询只看 visibleVersion 保证一致性。`PREPARE` 或 `COMMITTED` 均可 `abort` 进 ABORTED。

### quorum 副本校验

`DatabaseTransactionMgr.commitTransaction()`（`transaction/DatabaseTransactionMgr.java:353`）在提交前校验每个 tablet 的副本数：`quorumReplicaNum = replicationNum / 2 + 1`（`:493`），若 `successReplicaNum < quorumReplicaNum`（`:527`）则该 tablet 提交失败——这是多数副本写成功的保证，与 Doris 的多副本高可靠设计一致。

### 写路径：MemTable → Rowset Segment

BE 侧 `DeltaWriter`（`olap/delta_writer.h:54`）持有 `_mem_table`（`:108`），导入数据先攒在内存 `MemTable`，满后 `flush` 为 `BetaRowsetWriter` 的 Segment——`SegmentWriter.finalize` 写列存 Page + 多级索引（short key / bloom filter / ordinal）。完成后 BE 调 FE `loadTxnCommit`，FE 校验 quorum 后转 COMMITTED，再由 `PublishVersionDaemon` 异步发布版本。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两阶段提交 | `TransactionStatus` + `loadTxn*` | commit 快返回、publish 异步可见，原子性 + 低延迟 |
| 状态机 | `TransactionStatus`（4 态，`:20`） | 状态驱动事务流转 |
| 回调 | `TxnStateChangeCallback` | 事务状态变更回调 `LoadJob` 联动作业状态 |
| quorum | `commitTransaction`（`:493`） | 多数副本写成功才提交，多副本高可靠 |

## 模块间交互

`load`/`transaction` 依赖 `catalog`（`Catalog` 持有 `GlobalTransactionMgr`/`PublishVersionDaemon`/`LoadManager`），经 Thrift `FrontendService` 接收 BE 的 `loadTxn*` 调用，下发 `PublishVersionTask` 经 `task` 模块的 `AgentBatchTask` 到 BE。BE 侧 `DeltaWriter`（`olap`）写 Rowset 落 `olap` 存储引擎。

## 扩展方式

新增导入形态：实现 `LoadJob` 子类 + 在 `LoadManager` 注册 + 对应 `ScanNode`（如 `StreamLoadScanNode`）。改事务状态：动 `TransactionStatus` 枚举（0.14.0 加 `PRECOMMITTED` 即演进到 1.x 风格）。改 quorum 策略：动 `DatabaseTransactionMgr.commitTransaction`（`:353`）的副本校验。
