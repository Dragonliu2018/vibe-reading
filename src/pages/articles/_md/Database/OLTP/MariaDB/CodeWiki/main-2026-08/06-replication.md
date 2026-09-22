---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "Binlog 与复制"
date: "2026-09-22T22:40:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C++", "binlog", "GTID", "并行复制", "组提交", "闪回"]
description: "MariaDB binlog 与复制模块解读——三段式 GTID（domain_id-server_id-seq_no）、单队列组提交、基于 master 组提交信息的乐观并行复制、--flashback 闪回与 binlog-in-engine 新方向全解"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

binlog 与复制是 MariaDB 的事务持久化与分发系统。它有三个身份：**事务协调者**（`MYSQL_BIN_LOG : public TC_LOG`——binlog 开启时它本身就是两阶段提交的协调日志）、**变更流序列化器**（binlog 事件）、**复制协议**（master dump 线程 + slave IO/SQL 线程 + 并行 worker 池）。MariaDB 在这层的独特设计——三段式 GTID、基于 master 组提交信息的乐观并行复制、`--flashback` 闪回——都是相对 MySQL 的路线差异，值得逐一读。

## 模块架构

| 文件 | 职责 |
|---|---|
| `sql/log.h/.cc` | `MYSQL_BIN_LOG`（binlog+relay log 复用同一类）、组提交、rotate/purge、checkpoint、崩溃恢复 |
| `sql/log_event.h/.cc` | 事件类型 enum 与定义（`Gtid_log_event` 等），客户端/服务端共用 |
| `sql/log_event_server.cc` | server/slave 端 `do_apply_event` |
| `sql/log_event_client.cc` | mysqlbinlog 打印 + `--flashback` 事件反转 |
| `sql/rpl_gtid.cc` + `include/rpl_gtid_base.h` | GTID 三件套 |
| `sql/rpl_rli.cc/.h` | `Relay_log_info` + `rpl_group_info` |
| `sql/rpl_parallel.cc/.h` | 并行复制 worker 池与调度 |
| `sql/slave.cc` | IO/SQL 线程主体 |
| `sql/sql_repl.cc` | `mysql_binlog_send`（dump 线程） |

核心结构：`MYSQL_BIN_LOG`（`sql/log.h:629`，god node degree 198 的原因——同时承担文件管理、组提交、GTID、XA 恢复、relay log 五个职责）、`rpl_gtid`、`Relay_log_info`、`rpl_group_info`（一个 event group 的执行上下文）、`rpl_parallel_thread`（worker）。

## 调用链路

**binlog 写入**（与组提交一体）：

```
语句执行 → binlog_cache_mngr 的 stmt_cache/trx_cache（IO_CACHE）
COMMIT: ha_commit_trans → TC_LOG::log_and_order
→ binlog_commit (sql/log.cc:2802)              binlog 作为 handlerton 参与 2PC
→ write_transaction_to_binlog (log.cc:10081)   构造 group_commit_entry
→ queue_for_group_commit (log.cc:10206)
    在 LOCK_prepare_ordered 下挂入 group_commit_queue
    + BFS 把"等我提交后才能提交"的 wait_for_commit 等待者拉进同组
    ← 并行复制 in-order commit 与组提交的集成点 (log.cc:10168 注释)
→ trx_group_commit_leader (log.cc:10746)       队列头成为 leader
    ├─ wait_for_sufficient_commits (log.cc:11363)   binlog_commit_wait_count/uscd 凑组
    ├─ write_transaction_or_stmt (:11171)
    │    ├─ write_gtid_event (:8317)   rpl_global_gtid_binlog_state 分配 D-S-N
    │    └─ write_cache + end_event (Xid/Commit)
    ├─ flush_and_sync (:7168)           ★整组一次 write+fsync
    └─ commit_ordered / 唤醒 follower
```

**纠正一个常见误解**：MariaDB 不是 MySQL 5.6+ 的 flush/sync/commit 三阶段 pipeline，而是**单队列模型**——所有线程进同一个 `group_commit_queue`，leader 拿 `LOCK_log` 后统一写盘+fsync。

**复制链路**：

```
master: COM_BINLOG_DUMP → mysql_binlog_send (sql/sql_repl.cc:3538)
  ├─ get_slave_connect_state (:993)  读 @slave_connect_state 用户变量校验 GTID 位点
  └─ 主循环读 binlog → 发送（heartbeat 来自 @master_heartbeat_period）

slave IO 线程: handle_slave_io (sql/slave.cc:4530)
  ├─ GTID 模式握手全用 SQL 用户变量（非新协议命令）：
  │    SET @master_binlog_checksum=@@global.binlog_checksum (slave.cc:2087)
  │    SET @slave_connect_state='<D-S-N,...>' (:2362)
  └─ 主循环: read_event (:3375) → queue_event (:5840)
       ├─ event_checksum_test (:5919)   逐事件 CRC32 校验
       └─ rli->relay_log.write_event_buffer (:6875)

slave SQL 线程: handle_slave_sql (slave.cc:5194)
  └─ exec_relay_log_event (:4029)
       ├─ next_event 从 relay log 读
       ├─ using_parallel()? → rli->parallel.do_event (slave.cc:4214)  分发给 worker
       └─ 串行: GTID_EVENT → event_group_new_gtid (:4262)
            → apply_event_and_update_pos (:3810)
              = ev->do_apply_event(rgi) + ev->do_update_pos(rgi) + rli->stmt_done()
```

## 核心实现

### 三段式 GTID 与两侧状态

```cpp
// include/rpl_gtid_base.h:26
struct rpl_gtid {
  uint32 domain_id;
  uint32 server_id;
  uint64 seq_no;      // 文本形式 "D-S-N"
};
```

比较运算只比 domain+seq_no（server_id 不参与序）。两侧状态机：**master 侧 `rpl_binlog_state`**（sql/rpl_gtid.h:301）记每个 (domain_id, server_id) 的最后 GTID，序列化为每个 binlog 文件开头的 `GTID_LIST_EVENT`；**slave 侧 `rpl_slave_state`**（:126）持久化在 `mysql.gtid_slave_pos` 表（及按引擎分表 `gtid_slave_pos_<engine>`——GTID 记录与事务同引擎原子提交，避免 crash 后不一致）。slave 重放时 `Gtid_log_event::do_apply_event`（log_event_server.cc:3259）把 domain_id/seq_no 写进 `thd->variables`，提交时生成与 master 相同 GTID。

**Why 这个设计**（vs MySQL 的 `source_id:trx_id`）：domain_id 让多源复制/分片天然可区分、可并行；状态是 O(domain) 而非 O(事务数)，无需区间集合合并。握手复用 SQL 用户变量而非新协议命令——兼容老客户端。

### 并行复制：master 信息编码 + 乐观冲突处理

`--slave-parallel-threads=N` + `--slave-parallel-mode`（NONE/MINIMAL/CONSERVATIVE/OPTIMISTIC/AGGRESSIVE）。SQL 线程退化为 driver，事件按 GTID 域分发到 worker 池（每 domain 一个 `rpl_parallel_entry`，`rpl_parallel.cc:3243` 的 `do_event` 调度）。哪些事务可并行——**三重信息全部编码在 `Gtid_log_event` 的 flags**（`sql/log_event.h:3493`）：

| 标志 | 含义 |
|---|---|
| `FL_GROUP_COMMIT_ID` + commit_id | master 上同一批组提交 → 无限制并行 |
| `FL_TRANSACTIONAL` | 可安全回滚（乐观并行的前提） |
| `FL_WAITED` | master 上发生过行锁等待 → 倾向串行 |
| `FL_DDL` / XA 系列 | DDL 禁并行；XA 需 worker 亲和 |

OPTIMISTIC 模式下冲突按死锁处理、回滚重试（worker 内 `trans_retries` + `retry_start_offset` 重读 relay log）。顺序保证两层：域内 `wait_commit_sub_id`（worker 经 `THD::wait_for_prior_commit` 等前一个 group）；跨 batch 用 `group_commit_orderer`。**Why 不学 MySQL 8 的 write-set 依赖分析**：信息在写 binlog 时免费获得（commit_id、FL_* 标志），对无冲突负载开销极小；代价是冲突时回滚重试。

### 闪回（--flashback）与 checksum

`client/mysqlbinlog.cc` 的 `opt_flashback` + `Rows_log_event::change_to_flashback_event`（`sql/log_event_client.cc:1127`）：WRITE↔DELETE 反转、UPDATE 取 before 镜像、**倒序输出**。这是 MariaDB 独有的运维利器。checksum 全链路防损坏：FD 事件协商算法、IO 线程逐事件 `event_checksum_test`（slave.cc:5919）、relay log 以 master 算法为准。

### 13.x 进行中：binlog-in-engine

`--binlog-storage-engine` 方向（log.cc:282、`LOG_INFO::file_no` 原子文件号坐标替代文件名）：binlog 存进引擎表空间、由引擎恢复路径托管——见[InnoDB](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/04-innodb)的 `innodb_binlog.cc`。**待核实**（进行中工作）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| leader/follower | `queue_for_group_commit`（log.cc:10206） | 一组一次 fsync；BFS 拉等待者进组 |
| 状态机 | `Relay_log_info` 的组边界三坐标（group_relay_log_name/pos vs event_relay_log_pos vs future_event_relay_log_pos） | 处理事务跨 relay log 文件 |
| 生产者-消费者 | IO 线程写 relay log ↔ SQL/driver 线程读（`SEQ_READ_APPEND` 的 IO_CACHE） | relay log 同时读写 |
| 亲缘调度 | `check_xa_xid_dependency`（rpl_parallel.cc:2692）同 XID 落同一 worker | XA prepare/commit 的顺序约束 |

## 模块间交互

- **上游**：`TC_LOG::log_and_order` 被 `ha_commit_trans` 调用（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)）——binlog 作为 `transaction_participant` 参与 2PC（`binlog_tp`，log.cc:10143）
- **下游**：worker 执行经 `apply_event_and_update_pos_for_parallel`（slave.cc:3840）走完整 handler 提交路径；GTID slave 位点表按引擎分表
- **与 wsrep**：`wsrep_binlog.cc` 的 `wsrep_emulate_bin_log` 在无 binlog 时模拟 binlog cache 供 Galera 写集生成（见[wsrep 集群](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/07-wsrep)）

## 扩展方式

**新增一种 binlog event 类型**（按 `sql/log_event.h:631/720/774` 的官方锚点）：

1. `sql/log_event.h`：`enum Log_event_type` 加号（MariaDB 私有区 ≥160，加在 :774 "Add new events here" 上方）+ 新事件类 + **`Format_description_log_event` 构造的 post_header_len 数组必须同步**（协议兼容硬约束）
2. `sql/log_event.cc`：序列化 + `Log_event::read_log_event` 工厂分发
3. `sql/log_event_server.cc`：slave 端 `do_apply_event` + `do_update_pos`
4. `sql/log_event_client.cc`：mysqlbinlog 打印与 flashback 适配
5. `sql/slave.cc` `queue_event` 的 switch：IO 线程特殊处理（如 ROTATE 的 master 崩溃检测）
6. `sql/rpl_parallel.cc`：确认 `Log_event::is_group_event()` 归类
7. `mysql-test/suite/rpl/`：正向+闪回+并行复制测试
