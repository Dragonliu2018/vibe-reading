---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "复制与 binlog"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "binlog", "GTID", "组提交", "复制", "半同步"]
description: "ordered_commit 组提交四阶段、BGC ticket、事件体系双层继承、GTID 生命周期、MTA/CSA 新 applier、组复制的源码解读"
readingTime: "40 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

复制模块是 MySQL 的跨进程数据面：事务在源端写 binlog，经 dump 线程推送给 replica，由 IO/SQL 线程（或 26.x 新的 CSA 任务图 applier）并行应用。它与查询路径完全正交，但深度嵌入**提交路径**——`MYSQL_BIN_LOG` 同时是事务协调者（`TC_LOG`），组提交的三阶段流水线就是崩溃一致性（内部 2PC）与复制传播的交汇点。本模块还包括 GTID 体系、事件编解码库（26.x 正在从 `libbinlogevents` 迁往 `libs/mysql/binlog`）、半同步插件与组复制插件。

涉及文件：`sql/binlog.cc`（7,900 行组提交心脏）、`sql/binlog/`（新 TC_LOG 抽象与输出流）、`sql/log_event.*`（服务器侧事件，65 个类）、`sql/rpl_*.cc/h`（116 个文件）、`sql/changestreams/apply/`（26.x 新 MTA applier，93 个新文件）、`libs/mysql/binlog/event/`（库层事件）、`libs/mysql/gtids/`（新 GTID 库）、`plugin/semisync/`、`plugin/group_replication/`。

## 模块架构

```text
源端 mysqld                          replica mysqld
┌───────────────────────┐            ┌────────────────────────────┐
│ 提交: ha_commit_trans  │            │ IO 线程 handle_slave_io     │
│  └ MYSQL_BIN_LOG (TC)  │──dump────► │  └ 写 relay log            │
│     ordered_commit     │  Binlog_   │ SQL 线程 handle_slave_sql  │
│     flush→sync→commit  │  sender    │  ├ 老路径: MTS Coordinator │
└───────────────────────┘            │  │   + Slave_worker (logical clock)
        │ gtid_executed 有序更新      │  └ 新路径(26.x): Csa_service
        ▼                             │     + Job_applier 任务图    │
   binlog.000001                      └────────────────────────────┘
```

事件体系是**双层继承**：库层 `mysql::binlog::event::Binary_log_event`（`libs/mysql/binlog/event/binlog_event.h:852`，无服务器依赖，负责序列化/解码，19 字节公共头 `Log_event_header`）+ 服务器层 `Log_event`（`sql/log_event.h:541`，负责 applier 行为）。具体事件菱形继承两层：`Gtid_log_event : public mysql::binlog::event::Gtid_event, public Log_event`（`sql/log_event.h:3978`）、`Rows_log_event : public virtual Rows_event, public Log_event`（`:2808`）。**为什么两层**：库层要被 mysqlbinlog、Router、克隆等无服务器进程复用，服务器层才有 THD/relay log 语境。

## 调用链路

### 组提交四阶段（ordered_commit，sql/binlog.cc:7513）

```text
ordered_commit(thd, all, skip_commit)
0. BGC ticket 分配（:7519 assign_ticket）——精确界定批次边界
   Stage 0: Commit_order_manager::wait_for_its_turn_before_flush_stage（:7548）
            # replica 开 binlog 时 MTS worker 按 relay log 顺序排队
1. FLUSH: change_stage(BINLOG_FLUSH_STAGE)（:7565）
   ├─ process_flush_stage_queue（:7589）: 统一分配 GTID + 逐个写事务缓存
   ├─ flush_cache_to_file（write()）→ RUN_HOOK(binlog_storage, after_flush)
   └─ update_binlog_end_pos（唤醒 dump 线程）
2. SYNC: change_stage(SYNC_STAGE)（:7635）
   ├─ 可选 wait_count_or_timeout（binlog_group_commit_sync_delay 人为攒批）
   └─ sync_binlog_file（fsync）
3. COMMIT: change_stage(COMMIT_STAGE)（:7707，受 binlog_order_commits/clone 控制）
   ├─ call_after_sync_hook（:7429）——半同步 AFTER_SYNC 在此等 ack
   ├─ process_commit_stage_queue（:7161）: 按序 finish_transaction_in_engines
   │   （ha_commit_low → innobase_commit）+ 集中 gtid_state->update_commit_group
   └─ AFTER_COMMIT_STAGE（:7742）: 单独持锁跑 RUN_HOOK(transaction, after_commit)
      # 半同步 AFTER_COMMIT / GR 通知，慢钩子不阻塞下一批
```

leader/follower 机制：第一个进入某 stage 的线程成为 leader 携带整个队列推进，follower 在 `Commit_stage_manager::enroll_for`（`sql/rpl_commit_stage_manager.h:41` 的 `Mutex_queue`，THD 用 `next_to_commit` 串成侵入式链表）里睡条件变量，leader 末尾 `signal_done` 唤醒。`StageID` 枚举共 5 个队列（`rpl_commit_stage_manager.h:166`）：`BINLOG_FLUSH_STAGE / SYNC_STAGE / COMMIT_STAGE / AFTER_COMMIT_STAGE / COMMIT_ORDER_FLUSH_STAGE`——Stage 0（replica 的 commit order 等待）**不占其中任何一个**：`Commit_order_manager` 自持队列与锁，只把"轮到我了"的裁决插在 flush 之前。**为什么分阶段**：fsync 最贵，flush 持 `LOCK_log` 定序、sync 攒批共享一次 fsync、commit 批量化引擎提交；每阶段换锁形成流水线，后一阶段执行时前一阶段已可接纳新事务。**BGC ticket 的 why**（`sql/binlog/group_commit/bgc_ticket_manager.h:94-116`）：老的"队列空即换 leader"批次边界模糊，follower 在 leader 处理中途入队会撕裂批次；ticket 用 front/back 双指针界定处理窗口（session 先在 `wait_for_ticket_turn` 等自己的 ticket 成为 front ticket），序列化全靠原子变量的**最高位 in-use 标志 + CAS**，全程无互斥锁。

### 复制传播链

```text
Binlog_sender::run (sql/rpl_binlog_sender.cc:386)
└─ 逐文件: fake_rotate_event（:411，先发合成 ROTATE 事件让 mysqlbinlog 等
   工具正确识别文件边界）→ send_binlog（:497，先发 FDE + 检查 Previous_gtids）
   → 逐事件 send_event（等 update_binlog_end_pos 推进的心跳逻辑）
   文件尾: lock_index() + find_next_log 切下一文件（:433-446）
handle_slave_io (sql/rpl_replica.cc:5434)
└─ request_dump（GTID 模式带 executed set 做 AUTO_POSITION）→ read_event
   → queue_event（:5811）写 relay log
handle_slave_sql (sql/rpl_replica.cc:7124)
├─ opt_replica_preserve_commit_order 且 worker>1 时构造 Commit_order_manager（:7181）
└─ if (rli->is_csa_enabled()) csa_service->run(rli)     # 26.x 分叉点（:7423）
   else: 老循环（applier_reader.read_next_event → MTS 分发 / 直接 apply_event）
```

### GTID 生命周期

```text
分配（flush stage leader）: assign_automatic_gtids_to_flush_group (binlog.cc:1289)
  → Gtid_state::specify_transaction_sidno → generate_automatic_gtid（rpl_gtid_state.cc:514）
  → acquire_ownership 写入 Owned_gtids（:80）
  （GNO 耗尽时置 THD::CE_FLUSH_GNO_EXHAUSTED_ERROR 并报 ER_GNO_EXHAUSTED）
写入 binlog: write_transaction（binlog.cc:1342）在事务事件前写 Gtid_log_event
  （每文件头有 Previous_gtids_log_event 汇总此前全部 GTID）
应用侧: replica 执行时 gtid_next=ASSIGNED → 提交时 update_on_commit 迁入 executed_gtids
  （replica 未开 binlog 时持久化到 mysql.gtid_executed 表，rpl_gtid_persist.cc）
```

**为什么有 owned/executed 两个集合**：`Owned_gtids`（进行中，防同一 GTID 并发双写、支持 `wait_for_gtid` 等待）与 `executed_gtids`（已完成，防重放 + AUTOPOSITION + GR recovery）。迁移只发生在 commit stage 的 `update_commit_group`（`rpl_gtid_state.cc:158`）——集中按序更新避免 `Gtid_set` 出现临时空洞（增删 interval 需要互斥锁，损失性能，`binlog.cc:7722` 注释）。回滚则把 GNO 还回 `next_free_gno` 填洞。

## 核心实现

### 事件体系与行格式

三种记录格式：**SBR**（`Query_event`，`statement_events.h:470`，存语句文本）、**RBR**（`Table_map_event` + `Write/Update/Delete_rows_event`（type 30/31/32，`rows_event.h:882`，post-header 6B table_id + 2B flags + body 列 bitmap））、**mixed**（不安全语句降级行格式）。事务边界 = `Gtid_log_event` + `Xid_log_event`。逻辑时间戳 `last_committed/sequence_number` 写在 Gtid_event body 里——它就是 replica 侧并行应用的依赖依据（源端 `m_dependency_tracker` 计算）。26.7 最大的事件类型编号是 **`GTID_TAGGED_LOG_EVENT = 42`**（`binlog_event.h:279-373`），配套新 GTID 库 `libs/mysql/gtids/`（`Tag`（0-32 字符）+ `Tsid = (uuid, tag)` + `Gtid`，四种串行化格式：Text/Binary v0（无 tag 兼容）/v1（含 tag）/v2（varint 压缩，解码器先行）。库迁移的过渡形态：`libbinlogevents/include/` 只剩 28 个 shim 头（`#include "mysql/binlog/event/xxx.h"` + `DEPRECATE_HEADER` 编译期警告）。

### 新 MTA applier（CSA，sql/changestreams/apply/）

26.x 相对 9.7.2 最大的复制架构变化（+93 个文件）：

| | 老 MTS | CSA（新） |
| --- | --- | --- |
| 调度 | Coordinator 线程逐事件解析 + GAQ 位图 + per-worker 队列 | 通用 scheduler 库任务图（`mysql/scheduler`），无逐事件分发瓶颈 |
| 依赖 | 事件流中逐个判断 last_committed | `Dependency_adapter_lwm`（`scheduler/dependency_adapter_lwm.h:111`）把整个事务折成一个 task，LWM 单调推进；`commit_parent==0` 时设 barrier |
| 会话 | Worker 固定线程 + THD attach/detach | `Session_service` 池化 session，`Job::attach/detach` 显式交接（`jobs/job.h:47`） |
| 提交序 | `Commit_order_manager`（MDL grant 六阶段状态机） | `Commit_order_clock` 作为 scheduler phase 注册（`csa_service.cpp:190`） |

每 channel 一套 `Csa_service`（`service/csa_service.h:54`，`Thread_pool` + `Scheduler` + `Session_service`）；工作单元是 `Job_applier`（`jobs/job_applier.h:36`，两阶段 prepare/commit，支持死锁回滚重试）。`Relay_log_info::m_applier_version`（`rpl_rli.cc:3647` 的 `is_csa_enabled()`）在 `handle_slave_sql` 入口处分叉新老路径。

### 半同步与组复制

- **半同步**（`plugin/semisync/`）：`enum_wait_point { WAIT_AFTER_SYNC, WAIT_AFTER_COMMIT }`，默认 AFTER_SYNC（fsync 完即等 ack，丢失最少但 replica 未见数据；AFTER_COMMIT 不阻塞读但崩溃窗口可能丢事务）——两档让用户在 RPO 与吞吐间取舍。AFTER_SYNC 挂在 `call_after_sync_hook`（`binlog.cc:7429`），AFTER_COMMIT 挂在 AFTER_COMMIT_STAGE；
- **组复制**（`plugin/group_replication/`，`MYSQL_GROUP_REPLICATION_PLUGIN`）：本地事务在 `trans_observer` before_commit 被 `Transaction_consistency_manager` 拦截 → 经 `Gcs_operations`（`gcs_operations.h:49`，封装 libmysqlgcs 共识层）广播 → 各成员 `Applier_module`（`applier.h:322`）→ **`Certifier`**（`certifier.h:236`，write-set 对 stable-set 认证，冲突则本地回滚）→ 通过后以组分配的 GTID 应用。26.x 关键变化：通信栈默认 `MYSQL_PROTOCOL`、XCom 弃用（`plugin.cc:5478` 的 sysvar 默认值 + `push_deprecated_warn_no_replacement`）；单主模式下 `Certifier` 的 GTID 块分配（`gtid_assignment_block_size`）摊薄认证争用。

### TC_LOG 抽象化（26.x）

`MYSQL_BIN_LOG` 从巨类中拆出 `Binlog_tc_log_processing` 纯虚接口（`sql/binlog/binlog_tc_log_processing.h:34`：`prepare/fetch_and_process_flush_stage_queue/process_flush_stage_queue/rollback_in_engines/finish_transaction_in_engines`），通用实现在新文件 `Binlog_tc_log`（`binlog_tc_log.h:31`）——`MYSQL_BIN_LOG` 持 `shared_ptr` 委托注入（`binlog.cc:7992` 的 `set_tc_log_processing`）。这为"可插拔 TC-log 处理 + 非持久 binlog 事务"（26.x WL）铺路。输出侧同样管线化：`Binlog_ofile`（`binlog_ofile.cc:36`）在裸文件流之上可叠加 `Binlog_encryption_ostream`（新 binlog 文件自动加密，按魔数识别旧文件）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `TC_LOG` 抽象（`sql/tc_log.h:144`） | binlog 开关决定协调者实现 |
| 观察者 | `RUN_HOOK(binlog_storage/trans, ...)` 遍布 `binlog.cc` | 半同步/GR/audit 挂钩不侵入主逻辑 |
| 侵入式链表 | `Mutex_queue` 的 `THD::next_to_commit` | 队列操作零分配 |
| 票据仲裁 | BGC ticket（原子 CAS） | 批次边界无锁化 |
| 双层继承 | 库层/服务器层事件 | 序列化逻辑被无服务器工具复用 |

## 模块间交互

- **上游**：提交路径 `ha_commit_trans` → `tc_log->commit`（见[概览 commit-flow.svg](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)）；
- **与 InnoDB**：Stage 3 的 `ha_commit_low`；克隆要求提交顺序（`Clone_handler::need_commit_order`）；
- **与解析器**：SBR 事件的 `Query_log_event` 在 replica 侧重新走完整解析（见[解析器模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/02-parser)）；
- **与 Router**：Router 的 metadata cache 消费 GTID 做拓扑判活（见[Router 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/10-router)）。

## 扩展方式

- **新增 binlog 事件类型**（参照 `GTID_TAGGED_LOG_EVENT` 路径）：`binlog_event.h:279` 的 `enum Log_event_type` 末尾显式分配编号 → `enum_post_header_length` 加 post-header 长度 → 库层新事件类（`libs/mysql/binlog/event/`，含编解码与 `print_event_info`）→ 服务器层 `Xxx_log_event`（菱形继承，`do_apply_event`/`pack_info`）→ `Log_event::read_log_event` dispatch + mysqlbinlog 打印 → applier 侧事务边界识别（`trx_boundary_parser.cpp` 与 `changestreams/apply` 若影响两阶段划分）→ 老 FDE 的版本门控；
- **新增复制过滤规则**：`sql/rpl_filter.h:214` 的 `Rpl_filter` 加规则容器与检查函数（参照 `tables_ok/db_ok`）→ 写侧 `binlog_filter` 与 applier 侧 per-channel `mi->rli->filter` 双生效点 → `Rpl_pfs_filter` 观测表；
- **调试**：`mysql-test/suite/rpl` 的 .test 文件配 `include/wait_for_slave_sql_error.inc` 家族是理解复制时序的最佳可执行文档。
