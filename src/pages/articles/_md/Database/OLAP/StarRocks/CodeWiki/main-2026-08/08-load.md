---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "Load 导入"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "Stream Load", "Routine Load", "导入事务", "三阶段提交", "DeltaWriter"]
description: "StarRockss 数据导入体系：TransactionState 五态事务协议、Stream Load 端到端链路、主键表 DeltaWriter 写路径与 Routine Load 两级调度。"
readingTime: "17 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

导入体系（FE `load/` 3.9 万行 + `transaction/` 1.2 万行；BE `data_sink/` + `data_workflows/load/`）覆盖 Stream Load、Routine Load（Kafka/Pulsar）、Broker Load 与 Insert Into 写入，核心是一套**为导入设计的短事务协议**（PREPARE→COMMITTED→VISIBLE 三阶段）。独立成篇因为它的提交协议、写路径、调度模型都与查询路径完全正交——查询只读已发布版本，导入负责制造版本。

## 模块架构

三层：协议层 `GlobalTransactionMgr`（facade，按 dbId 分发到 `dbIdToDatabaseTransactionMgrs`）→ `DatabaseTransactionMgr`（真正的事务表 + edit log 持久化）；执行层 BE `DeltaWriter`（memtable→rowset）与 `OlapTableSink`（pipeline 算子形态的导入 sink）；入口层 Stream Load HTTP 管道与 Routine Load 两级调度。

## 调用链路

### 事务状态机（`transaction/TransactionStatus.java:25`）

```text
PREPARE → COMMITTED → VISIBLE          # 成功路径
PREPARE → PREPARED → COMMITTED         # 显式 2PC（TxnPrepareMode.EXPLICIT_TWO_PHASE，
                                       #   TransactionState.java:151）——transaction stream load
任意活动态 → ABORTED
```

`commitTransaction`（`DatabaseTransactionMgr.java:592`）= `prepareTransaction()` + `commitPreparedTransaction()` 两步。commit 流程：BE 汇报 `TabletCommitInfo` 列表 → FE 按 partition 计算 quorum（`:1149`）→ **COW 复制 TransactionState** → `beforeStateTransform(COMMITTED)` → `persistTxnStateInTxnLevelLock`（写 edit log，锁内替换 map 条目）→ `afterStateTransform` → `TransactionStateListener`（`OlapTableTxnStateListener`/`LakeTableTxnStateListener`）`postCommit` 分配 partition version。abort 路径（`:609`）在 writeLock 下**重取 latest state 再 abort**——注释（`:646-666`）解释了 COW 竞态下对 stale 快照 abort 会把已 COMMITTED 的事务覆盖为 version=-1 的 ABORTED，这是修过的真实 bug。

**为什么三阶段**：COMMITTED 只保证多数副本刷盘成功（快速返回客户端），rowset 真正可见/主键合并/版本对齐在后台异步做，避免慢 publish 阻塞导入吞吐。推手是 `PublishVersionDaemon`（LeaderDaemon，1356 行）：逐 BE 发 `PublishVersionTask` RPC，BE 对每个 tablet 把 PREPARED rowset 变为可见（主键表走 `TabletUpdates::on_commit` → `_apply_rowset_commit`，见 [11 存储](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/11-storage)）；全部（或 quorum + `quorum_publish_wait_time_ms` 等待，`DatabaseTransactionMgr.java:1183-1192`）成功后 `finishTransaction` 置 VISIBLE。

### Stream Load 端到端

```text
client PUT http://fe:8030/api/{db}/{tbl}/_stream_load
  → LoadAction (http/rest/LoadAction.java:100) 重定向到 BE (:281)
BE http/action/stream_load.cpp:
  on_header(:230) 建 StreamLoadContext
  → _on_header(:293) → StreamLoadExecutor::begin_txn (:385，向 FE beginTransaction)
  → _process_put(:473) → RPC FE streamLoadPut 取执行计划
FE service/FrontendServiceImpl.java:1725 streamLoadPut → streamLoadPutImpl
  → sql/LoadPlanner.java plan()(:296) 构造 fragment + OlapTableSink(:513-529)
BE: _stream_load_orchestrator->execute_plan_fragment (:698)
  → pipeline 执行 → OlapTableSink (data_sink/tablet/olap_table_sink.cpp)
     send_chunk(:632) → NodeChannel::add_chunk (tablet_sink_index_channel.cpp:537)
        → RPC PTabletWriterAddBatch → 目标 BE DeltaWriter
数据发完 → StreamLoadExecutor::commit_txn (stream_load.cpp:215)
  → FE commitTransaction(TabletCommitInfo) → 轮询 get_txn_status 至 VISIBLE
```

注意路径迁移：BE executor 在 `be/src/data_workflows/load/stream_load/stream_load_executor.cpp`（begin_txn :72、commit_txn :116）。另有 FE 前置流式 `load/streamload/StreamLoadMgr.beginLoadTaskFromFrontend/FromBackend`（:172/:218）与 2PC 的 `be/src/http/action/transaction_stream_load.cpp`。

### 主键表写路径（`storage/delta_writer.cpp`）

`DeltaWriter::open/_init`（:52/:174）：查 tablet、version 数检查（`tablet_max_versions` :213）、`txn_manager()->prepare_txn`（:256）、`RowsetFactory::create_rowset_writer`（:387，rowset_state=PREPARED、OVERLAPPING）。partial update 在此构建 partial schema：`referenced_column_ids` → `TabletSchema::create` 子集（:287-350），`is_partial_update_with_sort_key_conflict`（:147）校验与 sort key 相容性。

`write()`（:459）→ `MemTable::insert`（`storage/memtable.cpp`）：`__op` 列（LOAD_OP_COLUMN :47）随行携带操作类型，`_split_upserts_deletes`（:552-570）按 `TOpType::UPSERT/DELETE` 拆行——**delete 信号即随行的 `__op=DELETE`，落盘进 rowset 的 delete 部分**；merge_condition 存在时拒绝 delete 行（:560-563）。memtable 满或超内存 → `flush_mem_table_async`（:601）经 `MemTableFlushExecutor` 异步 flush 成 segment；replicated storage 下 Primary 副本同时经 `SegmentReplicateExecutor` 向 Secondary 传 segment（:615-641）。`commit()`（:759，`std::call_once` 幂等）→ flush wait → `rowset_writer->build()` → `txn_manager()->commit_txn`（:835）。**upsert/delete 的真正生效发生在 publish 阶段的 `_apply_rowset_commit`**：比对 primary index，生成 delete bitmap；column 模式 partial update 的 missing-row 物化也在 commit 后做（:333-338 注释）。

### Routine Load 两级调度

`RoutineLoadScheduler`（LeaderDaemon）扫 NEED_SCHEDULE 的 job → `KafkaRoutineLoadJob.divideTasks`（:304/:418）按 `KafkaProgress`（partition→offset）切 `KafkaTaskInfo`；`RoutineLoadTaskScheduler.runOneCycle`（:171）逐个 poll：`readyToExecute()`（无新数据延迟 1s 重投防空转）→ `allocateTaskToBe`（`max_routine_load_task_num_per_be` slot 限制）→ `beginTxn()` → `createRoutineLoadTask()` 生成 `TRoutineLoadTask` 下发 BE。BE 侧 `data_workflows/load/routine_load/`：`DataConsumerGroup` 管理 consumer（`DataConsumerPool` 复用）、`KafkaConsumerPipe`（:50，继承 StreamLoadPipe）把 Kafka batch 转 pipe，**复用与 Stream Load 相同的 plan fragment 执行链**。消费位点经 `RLTaskTxnCommitAttachment` 在事务 VISIBLE 回调中写回 `KafkaProgress`——只有事务可见才推进 offset，保证 at-least-once。Pulsar 为同构子类（`PulsarRoutineLoadJob`，模板方法）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 + 回调 | `TransactionState.beforeStateTransform/afterStateTransform` + `TxnStateCallbackFactory`；BE `DeltaWriter::_set_state`（kUninitialized→kWriting→kClosed→kCommitted/kAborted，:424） | 状态转换的钩子强制 |
| Facade + COW | `GlobalTransactionMgr` → `DatabaseTransactionMgr`；状态先复制再锁内替换 | 锁外构造、锁内原子替换 |
| 生产者-消费者线程池 | `MemTableFlushExecutor`、`SegmentReplicateExecutor`、`DataConsumerPool` | flush/复制/消费的并行化 |
| 模板方法 | `RoutineLoadJob`/`RoutineLoadTaskInfo` 抽象出 Kafka/Pulsar 实现 | 消费源差异隔离 |

## 模块间交互

- 事务持久化经 [02 元数据](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/02-catalog-ha) 的 EditLog；MV 刷新（[06](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/06-mv)）以 `LoadJobSourceType.MV_REFRESH` 参与同一事务协议。
- 导入 fragment 复用 [09 Pipeline](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/09-pipeline) 执行引擎（`OlapTableSink` 是 pipeline sink 算子）；主键 apply 落 [11 存储](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/11-storage)；shared-data 事务见 [07 存算分离](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data)（`LakeTableTxnStateListener`）。
- HTTP 入口与计划生成分别挂 [01 骨架](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/01-fe-server) 的 HttpServer 与 [04 QE](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/04-qe) 的 `LoadPlanner`。

## 扩展方式

**新增导入格式**：BE 解析在 `be/src/formats`（csv/json/avro 等），FE 解析列映射在 `StreamLoadHttpHeader`/`RoutineLoadDesc`，plan 侧改 `LoadPlanner.plan()` 的 scan node 选择即可，sink 不动。

**新 sink**：实现 pipeline sink 接口（参照 `data_sink/tablet/olap_table_sink.cpp` 的 init/prepare/open/send_chunk/close），FE 侧在 `LoadPlanner.java:513` 处选择 sink 类型；新事务参与方需在 `LoadJobSourceType` 加枚举并显式标 `loadingTransaction` 标志（枚举注释 :105 明确要求）。

**待核实**：`PublishVersionDaemon.publishVersionNew`（:443）与旧路径并存，默认走哪条由 config 开关决定（未确认默认值）；Broker Load v2 的 HDFS 拉取 task 调度链未深入。
