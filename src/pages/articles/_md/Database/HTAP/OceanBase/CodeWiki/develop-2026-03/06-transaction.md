---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "事务引擎"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "分布式事务", "2PC", "MVCC", "死锁检测"]
description: "OceanBase 事务引擎 v4：TxDesc/PartTransCtx 分离、日志驱动 2PC、Elr 早提交、行锁即 MVCC 节点、事务表与延迟 cleanout。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`src/storage/tx/`（~19.6 万行，含 memtable/mvcc/、tx_table/、tablelock/、lock_wait_mgr/、concurrency_control/）实现分布式事务。当前生效的是 4.0 重写后的 **v4 系列**（`ob_trans_service.h` 组合 `ob_trans_service_v4.h` + `ob_tx_api.h`）。两大命题：**跨 LS 分布式提交的正确性**（消息可丢可乱序，durable 状态只认日志）与**高并发单机事务的尾延迟**（一阶段提交、Elr 早提交）。边界：MVCC 数据结构（`ObMvccRow`）物理上在 memtable 里，但由本模块的 `ObMvccEngine` 驱动；日志复制见 [日志服务](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/07-logservice)。

## 模块架构

调度器侧与参与者侧的分离是 v4 的第一设计：

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `ObTransService` | `tx/ob_trans_service.h:180`（MTL per-tenant） | begin/commit/rollback/savepoint 全套 API（定义在 `ob_tx_api.h`） |
| `ObTxDesc` | `tx/ob_trans_define_v4.h:556` | 事务描述符：状态机 + `parts_` 参与者列表 + savepoints |
| `ObTxPart` | 同文件 :249 | 参与者（LS）：`epoch_ == EPOCH_DEAD` 表示"参与者失忆" |
| `ObPartTransCtx` | `tx/ob_trans_part_ctx.h:155` | 参与者上下文：三重继承（ObTransCtx + ObTsCbTask + **ObTxCycleTwoPhaseCommitter**） |
| `ObLSTxCtxMgr` | `tx/ob_trans_ctx_mgr_v4.h:165` | per-LS 上下文表（1<<14 桶 LightHashMap） |
| `ObMvccEngine` | `memtable/mvcc/ob_mvcc_engine.h:54` | MVCC 写入/读取（行内嵌于 memtable） |
| `ObTxTable` | `tx_table/ob_tx_table.h:47` | ctx 增量 dump + 事务数据（可见性判断的地面真相） |
| `ObLockWaitMgr` | `lock_wait_mgr/ob_lock_wait_mgr.h:71` | 行锁等待队列（FixedHash2） |
| `ObDeadLockDetectorMgr` | `share/deadlock/ob_deadlock_detector_mgr.h:75` | LCL 分布式死锁检测 |

## 调用链路

### 本地事务：begin → 写 → 一阶段 commit

```
ObSqlTransControl::start_tx                         sql/ob_sql_trans_control.cpp:176
└─ txs->start_tx                                    tx/ob_tx_api.cpp:286（IDLE→ACTIVE）
DML 写入（见存储引擎模块的 mvcc_write 链）
└─ 冲突时 post_row_read_conflict                    memtable/ob_row_conflict_handler.cpp:255
   └─ MTL(ObLockWaitMgr)->post_lock（挂等待队列 + 注册死锁依赖）
commit：
ObSqlTransControl::end_trans → txs->commit_tx       ob_tx_api.cpp:450
└─ do_commit_tx_                                    ob_trans_service_v4.cpp:169
   └─ decide_tx_commit_info_ :630（优先选本机参与者当 coordinator）
      └─ ObPartTransCtx::commit                     ob_trans_part_ctx.cpp:767
         单参与者且非 dup table → TransType::SP_TRANS
         └─ one_phase_commit_ :884 → submit_commit_log_ :3793
            一次 log block 打包 redo + commit info + commit log（MIN_LOG_BUF_SIZE 分支）
            └─ ObLSTxLogAdapter::submit_log         tx/ob_tx_log_adapter.cpp
               └─ ObLogHandler::append（Palf，replay_hint=trans_id）
                  多数派成功 → on_success :2254 → tx_end_ :2165
                  （顺序敏感 6 步：set tx data state → trans_end 按序回填版本
                    → insert_into_tx_table → 应答 scheduler）
```

### 分布式 2PC

```
ObPartTransCtx::commit（多参与者 → DIST_TRANS）
└─ set_2pc_upstream_ → ObTxCycleTwoPhaseCommitter::two_phase_commit
   状态机（tx/ob_committer_define.h:68）：
   INIT(10)→REDO_COMPLETE(20)→PREPARE(30)→PRE_COMMIT(40)→COMMIT(50)/ABORT(60)→CLEAR(70)
   ├─ REDO_COMPLETE：落 ObTxCommitInfoLog（参与者列表+上游）
   ├─ PREPARE：向参与者发 OB_MSG_TX_PREPARE_REQ
   │    └─ 对端 do_prepare（ob_tx_2pc_ctx_impl.cpp:83）→ generate_prepare_version_
   │       （commit_version = max(GTS, local_max_read_version)，GTS 只由 ROOT 参与者申请）
   │       → submit_prepare_log_ → 落多数派后回 RESP
   ├─ coordinator 收齐（collected_ bitset）→ 全局 commit_version = max(各参与者)
   ├─ PRE_COMMIT：优化消息，降低单机读延迟
   ├─ COMMIT：coordinator 落 ObTxCommitLog → 广播 → 参与者 tx_end_(true)
   └─ CLEAR：异步落 ObTxClearLog 回收 ctx（scheduler 在 COMMIT 响应后即回 commit_cb，不等 CLEAR）
```

推进机制是**日志驱动 + 消息驱动双通道**：`try_submit_next_log_`（`ob_trans_part_ctx.cpp:2917`）在日志回调 `on_success` 中继续推状态机；`handle_timeout` + 上下游消息重发兜底。

## 核心实现

### TxDesc / PartTransCtx 分离（v4 基石）

参与者集合在执行期动态发现（write 才 touch LS），提交时才选 coordinator（`decide_tx_commit_info_` 偏好本机 LS 省一跳 RPC）；调度器只存轻量执行信息，跨节点由 `ObTxExecResult` 增量合并（PX SQC→QC 场景，`ob_tx_api.h:543-572` 注释）。`tx/README` 第 1 节有完整论证。**epoch + op_sn 防失忆/防重**：ctx 可能被过时消息或重建后的 leader 重新创建（participant amnesia），epoch 不匹配即拒绝（`ob_trans_part_ctx.h:1132-1136` 注释、`ObTxPart::EPOCH_DEAD`）。

### exec_data 与 tx_data 分离（4.0 核心改动）

运行态在 ctx；**提交后仍需的状态**（state/commit_version/undo 链）在 `ObTxData`，由 tx data memtable 持有并 flush 成 sstable（`tx_table/ob_tx_table.h:188-194` 注释）。为什么：ctx 可以及时回收，而可见性判断/undo/合并求上界只需 tx_data。配合**延迟 cleanout**：回调被 fast-commit 移除后节点打 `F_DELAYED_CLEANOUT`，读时经 `ObTxTable::lock_for_read` 补状态（`ob_mvcc_row.cpp:851-860` Tip 1）。

### 行锁即 MVCC 节点

**无独立锁表**——写者插入 trans node 即持锁（首个写入者持有），等待经 `ObLockWaitMgr`（请求级重挂而非线程阻塞）。为什么：锁与数据版本天然合一，`check_row_locked` 一次判断同时覆盖锁与可见性，冲突信息（holder tx/seq）直接喂给死锁检测。死锁检测是 LCL 分布式算法：锁冲突信息经 `ObTxDesc::conflict_info_array_` 从远端执行节点带回 scheduler，连续冲突达到阈值才启动检测（`ob_trans_define_v4.h:730` 注释）。

写写冲突的具体判定在 `ObMvccRow::mvcc_write_`（`mvcc/ob_mvcc_row.cpp:808`，持 `ObRowLatchGuard`）遍历版本链头时分五种 case：头空可插入；头节点已提交（或 ELR）可插入；头节点已 abort 则沿 `prev_` 继续找；未决节点属于自己（同一事务重写）且是 lock node 时覆盖；未决节点属于他人则不可插入并填充 `lock_state`（is_locked/lock_trans_id 等，喂给锁等待）。delayed cleanout 节点先经 `cleanout_tx_node`（tx_table 复查，不需要行锁）；已提交且 `tx_version <= base_version` 的节点被过滤（`lock_dml_flag` 置 DF_NOT_EXIST）——这条正是"基线以下版本对增量写不可见"的判定。

### Elr 早提交

commit log **提交后（未等多数派）** 即：tx_data 置 `ELR_COMMIT` + 更新 `max_elr_commit_ts` → `ObMvccRow::elr` 给节点打 `F_ELR` 并填 commit version → 唤醒等锁者。单 LS 事务提交日志已发出即大概率提交，提前放锁显著降低单机提交尾延迟（`tx/ob_tx_elr_handler.h` + `ob_trans_part_ctx.cpp:4974`）。`ObTxVersionMgr` 把 elr 与非 elr commit ts 分开记录。

### Cycle/Tree 2PC（transfer 并发）

partition transfer 期间参与者集合会变，循环 transfer（A→B→A）会造成树形 commit 死锁——通过 `merge_intermediate_participants` + "真实上游"判定解决（`ob_two_phase_committer.h:220-268` 图 + `ob_tx_2pc_ctx_impl.cpp:455-551`）。

### 表锁事务化（MDS）

表锁 op 经 `ObTableLockService::lock → ObLockTable::check_lock_conflict` 后注册为 **multi_data_source 数据源**随事务日志持久化（`ObMemtableCtx::add_lock_record`），锁记录存在专用 `ObLockMemtable`（LS 的第 3 个 memtable）。为什么：表锁要和 DML 事务原子提交/回滚，备库/恢复必须重放出锁状态。MDS 机制（`register_multi_data_source`，`ob_trans_part_ctx.h:570`）同时服务 DDL 日志、备库事务表等，commit/abort 时 `notify_data_source_` 回调（ON_PREPARE/ON_COMMIT/ON_ABORT/ON_REPLAY）。

### commit version = max(GTS, 全局 max_read_ts)

串行化/RR 的反依赖要求提交版本高于本事务读过的所有版本（`ObTxVersionMgr::update_max_read_ts` 每次读访问记录）；GTS 保证跨机外部一致性（`generate_prepare_version_/generate_commit_version_`，`ob_trans_part_ctx.cpp:3181/3255`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `ObTxCycleTwoPhaseCommitter`（`ob_two_phase_committer.h:48`）固定 2PC 骨架 | dup table 的 lease 持久化复用同一状态机抽象 |
| 双层状态机 | `exec_info_.state_`（durable）vs `upstream_state_`（内存）+ `ObTxSubState` | 日志驱动推进要求区分"已落日志"与"已收到消息" |
| 回调链 | `ObITransCallback`（`memtable/mvcc/ob_mvcc.h`）三实现：行/表锁/ext info | redo 的组织单位是回调不是行 |
| 适配器 | `ObITxLogAdapter`（↔logservice）、`ObILocationAdapter`（↔location cache）、`ob_trans_deadlock_adapter` | 切断事务对具体服务的依赖 |
| CRTP 工具 | `memtable/mvcc/ob_crtp_util.h`（ObMvccWriteGuard） | 写授权 + 析构触发 instant logging |

## 模块间交互

SQL 层 `ObSqlTransControl` 直调 start_tx/commit_tx；每条语句建隐式 savepoint（`create_implicit_savepoint`，`ob_sql_trans_control.cpp:1244`）。与 logservice：正向 `ObLSTxLogAdapter → ObLogHandler`；反向 replay 经 `ob_tx_replay_executor.cpp` 分发到 `replay_redo_in_ctx/replay_prepare/replay_commit/replay_rollback_to`；leader 切换 `ObLSTxCtxMgr::switch_to_leader`。compaction 用 `ObTxTable::get_upper_trans_version_before_given_scn` 求合并上界。XA（`ob_xa_*.cpp`）、dup table（`ob_dup_table_*.cpp`）、备库事务推断（`ob_tx_sby_read_*`）、事务免费路由（`ob_tx_free_route_*`）同属本模块未在本文展开的部分。

## 扩展方式

- **新增隔离级别行为**：读侧快照策略 `ObTransService::get_read_snapshot`（RC 每语句 vs RR/SERIAL 事务级）；写侧 `ObMvccRow::mvcc_write` 的 TSC 检查与 `concurrent_control::check_sequence_set_violation`（`memtable/ob_concurrent_control.cpp`）
- **新增 savepoint 特性**：调度器侧 `ObTxSavePoint`（三态 SAVEPOINT/SNAPSHOT/STASH，STASH 服务 PL/SQL 栈语义）+ `rollback_to_savepoint_`（leader 先 `ObTxData::add_undo_action` 持久化再摘除 trans node）
- **新增 MDS 参与者**：`ObTxDataSourceType`（`storage/multi_data_source/`）+ `register_multi_data_source` + `notify_data_source_` 分支 + replay 分支
- **调整 Elr**：`can_elr_`（租户配置）+ `ObTxELRHandler::check_and_early_lock_release`
