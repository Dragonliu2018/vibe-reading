---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "wsrep 集群"
date: "2026-09-22T22:42:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C++", "Galera", "wsrep", "同步复制", "SST", "TOI"]
description: "MariaDB wsrep 模块解读——server/client 双状态机、TOI/RSU DDL 隔离、certify 提前到 prepare 期的写集复制、高优先级通道与 BF abort、外部脚本驱动的 SST 全解"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

wsrep 是 Galera 同步多主集群的 server 集成层——`sql/wsrep_*.cc` 19 个文件（19.3k 行，版权头 Codership Oy）+ `wsrep-lib/` submodule（纯 C++ 抽象库，API 边界）。编译期可选（`WITH_WSREP`）。这层的架构本质是**server 不持有集群协议**：状态机本体在 wsrep-lib，provider（`libgalera_smm.so`）经 dlopen 加载，`sql/` 下这 19 个文件是"事件 → wsrep-lib 状态机调用"的薄适配器 + server 能力回调。

## 模块架构

两级状态机：

- **Server 级**（`Wsrep_server_state : wsrep::server_state`，`sql/wsrep_server_state.h:29`）：`disconnected → connected → joiner → joined → synced` + `donor` 旁路（状态迁移表在 wsrep-lib，本仓库不可见——submodule 未初始化，**待核实**）
- **Client 级**（`Wsrep_client_state : wsrep::client_state`，`sql/wsrep_client_state.h:25`，每 THD 一个）：事务子状态机 `executing/preparing/certifying/committing/committed/aborting/aborted/must_abort/must_replay/replaying`（`wsrep_trans_observer.h:56-79`）；四种 mode：`local / toi / rsu / high_priority`

| 文件 | 职责 |
|---|---|
| `wsrep_mysqld.cc`（~4600 行） | 全局生命周期、TOI/RSU、BF abort、kill/错误处理 |
| `wsrep_trans_observer.h` | **全部 2PC/语句/命令 hook 的 inline 实现** |
| `wsrep_thd.cc` | applier/rollbacker 线程主循环 |
| `wsrep_sst.cc`（~2500 行） | SST donor/joiner 编排 |
| `wsrep_high_priority_service.cc` | applier/replayer/storage 高优先级回调 |
| `wsrep_applier.cc` | 写集解析回放（含重试） |
| `wsrep_schema.cc` | `mysql.wsrep_*` 内部表（cluster/members/streaming/allowlist） |
| `wsrep_binlog.cc` | `wsrep_emulate_bin_log`：无 binlog 时模拟 binlog cache |

## 调用链路

**写集复制**（本地 commit → certify → 各节点回放）：

```
DML 行操作 → wsrep_after_row_internal (wsrep_trans_observer.h:171)
             └─ wsrep_check_pk() (112)   ★无 PK 表默认拒绝写（certification 依赖 PK）

prepare 阶段: prepare_or_error() (sql/handler.cc:1495)
  wsrep_before_prepare() → cs.before_prepare()   ← ★certification 在此完成（乱序并行）
  ht->prepare(thd, all)                          （wsrep-lib 内调 provider().certify()）
  wsrep_after_prepare()
  ※ GTID 在 before_prepare 分配，commit order 在 before_commit 进入
    (handler.cc:3073 注释原文)

commit 阶段: ha_commit_trans (sql/handler.cc:2045)
  wsrep_before_commit() → cs.before_commit()     进入 commit ordering；写集投递
  tc_log->log_and_order() → commit_one_phase_2()
  wsrep_after_commit() → cs.ordered_commit() + after_commit()

各节点 applier 回放: wsrep_replication_process (sql/wsrep_thd.cc:49)
  → provider().run_applier(&applier_service)     Galera 按 seqno 顺序回调
  → Wsrep_applier_service::apply_write_set (wsrep_high_priority_service.cc:573)
     → wsrep_apply_events (sql/wsrep_applier.cc:396)
        → wsrep_read_log_event 循环解析写集里的 binlog 事件
        → ev->apply_event(thd->wsrep_rgi)
        失败 → 回滚到 "wsrep_retry" savepoint 重试（wsrep_applier_retry_count 次）
        最终错误只回传错误码写回 provider → 全集群 abort（一致性优先）
```

**TOI/RSU DDL 分叉点**：`wsrep_to_isolation_begin()`（`wsrep_mysqld.cc:3137`），调用点在 `sql/sql_parse.cc:4834`、`sql/sql_truncate.cc:491` 等。TOI 把整条 DDL 序列化成单一写集（`wsrep_TOI_event_buf`，:2830）——**集群内全序复制**；RSU 则直接 `thd->variables.wsrep_on = 0`（:3110）本连接关掉 wsrep 纯本地执行——给 Galera 不兼容 DDL 的逃生门。

## 核心实现

### 事务观察者机制：为什么 hook 而不改 handler

`wsrep_trans_observer.h` 全部是 `static inline` 函数，插桩点在 `sql/handler.cc` 的 `#ifdef WITH_WSREP` 缝里。**Why 观察者而非直接改 handler**：

1. 所有 Galera 逻辑集中一个头文件，`handler.cc` 只留最小 `#ifdef` 缝——便于无 wsrep 构建（`wsrep_dummy.cc`）与上游同步
2. hook 是薄适配器（`thd->wsrep_cs().before_commit()`），状态机本体在 wsrep-lib
3. 同一组 hook 服务 client/applier/replayer 三种上下文（`wsrep_trans_observer.h:307-313` 注释明示 "must be called from both client and applier contexts"）
4. 观察者天然按引擎过滤——`HTON_WSREP_REPLICATION` 标志**只由 InnoDB 设置**（`ha_innodb.cc:4341`）

### certify 提前到 prepare 期、乱序并行

GTID/seqno 在 `wsrep_before_prepare` 取得，commit order 在 `wsrep_before_commit` 进入（`handler.cc:3073-3084` 注释）。prepare 可乱序完成 → 并行 apply 与 XID 连续性检查（`wsrep_order_and_check_continuity`）配套。这是 Galera "certify 后必达"与 MySQL 组提交的折中。

### 高优先级通道与 BF abort

`Wsrep_high_priority_service` 系列复用 client_state 的 `m_high_priority` 模式：applier commit 走 `prepare_for_ordering()` 直接领 seqno**不再 certify**；与本地事务争锁时 BF abort 对方（`wsrep_handle_mdl_conflict`，wsrep_mysqld.cc:3586，客户端见 `ER_LOCK_DEADLOCK`）。已过 certify 的事务转 `must_replay`，由 `Wsrep_replayer_service`（wsrep_high_priority_service.cc:650）在独立 THD + shadow Diagnostics_area 上重放——保证被 abort 事务"要么重放要么回滚"不悬空。

### SST：外包给外部脚本进程

**server 只拼命令行 + 解析 stdout 协议**。joiner 侧 `sst_joiner_thread`（wsrep_sst.cc:735）运行 `wsrep_sst_<method> --role 'receiver'`，脚本打印 `"ready <addr>"`；donor 侧 `sst_donate_other`（:2332）拼 `"wsrep_sst_<method> --role 'donor' ... --gtid 'uuid:seqno' --gtid-domain-id ..."`——**mariabackup 在脚本内做备份 + FTWRL**。传输完成后 joiner 读 `"uuid:seqno [domain_id]"` 行 → `wsrep_sst_complete()` → 状态 `joiner → joined → synced`。物理一致性靠 `wsrep_set_SE_checkpoint`（mariabackup 恢复后 InnoDB checkpoint 与 wsrep gtid 对账）。**IST 完全在 provider 内部（gcache 增量回放），server 代码零参与**。错误只回传错误码不回传消息——locale 差异会造成节点分歧（wsrep_mysqld.cc:3054-3060）。

### 双状态机解耦 + 可降级

无 provider（`WSREP_NONE`）时 `wsrep_init()`（wsrep_mysqld.cc:888-903）走普通单机路径；内部状态持久化进 `mysql.wsrep_*` schema 四表（`wsrep_schema.cc:48-105`），streaming replication fragment 崩溃后可 `recover_streaming_appliers`（wsrep_server_service.cc:303）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 模板方法 + 回调 | wsrep-lib 持流程，`Wsrep_*` 六个类供能力 | server 与集群协议解耦，同一状态机可被其他 server 复用 |
| 观察者 | `wsrep_trans_observer.h` hook 进 handler 2PC | 集中改动面、三上下文共用、引擎过滤 |
| 状态机 | client_state 十态 + server_state 六态 | 分布式正确性靠显式状态而非隐式标志 |
| 进程外脚本 | SST 全部外部化（mariabackup/rsync/mysqldump 可插拔） | 备份工具独立演进、故障隔离 |

## 模块间交互

- **与 handler 层**：hook 埋在 `prepare_or_error`/`ha_commit_trans`（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)）；写集靠 binlog 行事件生成（无 binlog 时 `wsrep_emulate_bin_log`）
- **与 InnoDB**：`HTON_WSREP_REPLICATION` 只由 InnoDB 设置——**Galera 只保证 InnoDB 的写集复制**；MyISAM 只能经 TOI 语句级复制
- **与 binlog**：certification 与 binlog 组提交打通——等待者可被拉进同组提交（log.cc:10168-10195）
- **与备份**：SST 物理方式直接用 mariabackup（`extra/mariabackup/`）

## 扩展方式

**新增一种 SST 方法**：写 `scripts/wsrep_sst_<method>.sh`（donor/receiver 双角色、stdout 协议 `ready/total/complete/uuid:seqno`）+ 在 `wsrep_sst.cc` 的方法注册处登记——server 代码几乎不用动，这是"SST 全外包"设计的直接红利。

**调试技巧**：`wsrep_server_state.cc:159` 的 `handle_fatal_signal()` 在致命信号时调 `provider().set_node_isolation(isolated)` 静默断网再打 stacktrace——防止故障节点脑裂扩散。
