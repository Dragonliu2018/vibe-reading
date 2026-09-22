---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "InnoDB"
date: "2026-09-22T22:35:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C++", "InnoDB", "B+tree", "MVCC", "redo log", "buffer pool", "mtr"]
description: "MariaDB 13 InnoDB 引擎解读——mtr_t 单一 redo 写入点、lock-free page hash、group_commit_lock 取代后台日志线程、commit_ordered 与 binlog 协同、change buffer 移除与 AHI 重做等 fork 现状全解"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

InnoDB（`storage/innobase/`，约 30.4 万行）是 MariaDB 的默认事务引擎——B+tree 聚簇存储、MVCC 多版本、undo/redo、行锁、buffer pool。但这个模块的第一读法不是"又一个 InnoDB"：MariaDB 的 InnoDB 是一个**深度改造过的 fork**——redo 架构重写（后台日志线程全删）、change buffer 移除、AHI 重做、binlog-in-engine 实验方向，处处是与 MySQL 8 的路线分叉。读懂这些差异比复述教科书上的 InnoDB 概念更有价值。

## 模块架构

| 目录 | 规模 | 职责 |
|---|---|---|
| `handler/` | 46.6k 行 | server↔engine 桥：`ha_innodb.cc`（handler 全量实现）、`handler0alter.cc`（在线 DDL）、`innodb_binlog.cc`（13 新增 binlog-in-engine） |
| `row/` | 41.5k 行 | 行层：`row0sel.cc`（row_search_mvcc 光标引擎）、row0ins/upd/undo（DML）、row0vers（版本链）、row0purge |
| `buf/` | 12.2k 行 | buffer pool：page hash、LRU、page cleaner 刷脏、doublewrite、预读 |
| `btr/` | 16.5k 行 | B+tree：btr0btr（导航/分裂/合并）、btr0cur（游标）、btr0sea（AHI）、btr0bulk（批量建树） |
| `trx/` | 10.9k 行 | 事务：trx0trx（提交状态机）、trx0purge、trx0rseg/trx0undo（回滚段） |
| `log/` | 9.7k 行 | **redo 新架构**：log0log（write/checkpoint/resize）、log0recv（6194 行恢复）、log0sync（group_commit_lock） |
| `lock/` | 8.6k 行 | 行锁/间隙锁/表锁，全局 `lock_sys` |
| `read/` | 265 行 | MVCC read view（ReadView 定义在 `include/read0types.h`） |
| `mtr/` | 1.9k 行 | mini-transaction：latch 栈 + redo 缓冲 |
| `dict/` | 16k 行 | 数据字典 cache + 持久统计 |
| `page/` `rem/` | 13.9k 行 | 16KB 页格式（COMPACT/REDUNDANT）与 record 编码 |
| `fsp/` `fil/` | 17.6k 行 | file space/extent 与文件抽象、页压缩、加密 |
| `ibuf/` | 1.1k 行 | **change buffer 已移除**——只剩旧格式升级清除逻辑 |

核心数据结构四件套：`buf_pool_t`（`include/buf0buf.h:1081`，全局单实例 `buf_pool`）、`trx_t`（`include/trx0trx.h:597`）、`mtr_t`（`include/mtr0mtr.h:77`）、`btr_pcur_t`（持久游标）+ `row_prebuilt_t`（每 handler 预构建上下文，`include/row0mysql.h:463`）。

## 调用链路

**一次主键点查**（SQL 层 `index_read` 进入）：

```
ha_innobase::index_read (handler/ha_innodb.cc:9132)
├─ row_sel_convert_mysql_key_to_innobase (:9197)   MySQL key → dtuple
└─ row_search_mvcc (row/row0sel.cc:4430)
    ├─ 预取缓存命中直接返回 (:4507)
    ├─ AHI 快路径 (:4634)  unique_search && btr_search.is_enabled(index)
    │    └─ row_sel_try_search_shortcut_for_mysql (row0sel.cc:3972)
    ├─ btr_pcur_open_with_no_init (:4909)
    │    └─ btr_cur_search_to_nth_level (btr/btr0cur.cc:1778)
    │         search_loop (:1830): 逐层下潜
    │         ├─ mtr->get_already_latched(page_id)   mtr 内已持有则复用
    │         └─ buf_page_get_gen (buf/buf0buf.cc:2729)
    │              ├─ page_guess(block)             ★无锁猜测
    │              ├─ hash_lock.lock_shared + page_hash.get()
    │              ├─ block->page.fix()              原子 buffer-fix
    │              └─ miss → buf_read_page() 同步读 + 随机预读
    ├─ 可见性: trx->read_view.changes_visible(rec 的 DB_TRX_ID)
    │    不可见 → row_sel_build_prev_vers_for_mysql (:6552) → row_vers_build_for_consistent_read
    └─ row_sel_store_mysql_rec()   InnoDB rec → TABLE::record[0]
```

**事务提交**（与 binlog 的协同是 MariaDB 特色的重头）：

```
server: ha_commit_trans → TC_LOG::log_and_order
① 全局互斥内: innobase_commit_ordered (ha_innodb.cc:4678)
   ├─ thd_binlog_pos() 记录 binlog 位点到 trx->mysql_log_file_name/offset
   ├─ trx->flush_log_later = true          fsync 推迟到锁外
   └─ innobase_commit_ordered_2 (:4621) → trx_t::commit (trx0trx.cc:1645)
        └─ commit_persist (:1586)
             ├─ write_serialisation_history (:1147)   trx_sys.assign_new_trx_no() + purge_sys.enqueue() 同临界区
             ├─ mtr->commit() → commit_lsn（逻辑提交点）
             └─ commit_in_memory (:1413)  释放锁、状态→COMMITTED_IN_MEMORY
② 互斥外: innobase_commit (ha_innodb.cc:4750)
   ├─ thd->wakeup_subsequent_commits(0) (:4813)   放行后续事务一起 group commit
   └─ trx_flush_log_if_needed (trx0trx.cc:1284)
        └─ log_write_up_to(lsn, durable) (log/log0log.cc:1801)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
|---|---|---|
| `row_search_mvcc` | 统一取行入口 | row0sel.cc:4430；预取缓存/AHI/游标三段 |
| `btr_cur_search_to_nth_level` | B-tree 下潜 | btr0cur.cc:1778；`root_guess` 缓存跳过一次 hash 查找 |
| `buf_page_get_gen` | 页获取 | buf0buf.cc:2729；page_guess 无锁快路径 |
| `mtr_t::commit` | mini-transaction 提交 | mtr0mtr.cc:534；flush_list 插入与页 LSN 写入同序 |
| `trx_t::commit` | 事务提交状态机 | trx0trx.cc:1645；6 态转换见 include/trx0trx.h:686 注释 |
| `log_write_up_to` | redo 写入+刷盘 | log0log.cc:1801；group_commit_lock 实现 |
| `ReadView::changes_visible` | MVCC 可见性判断 | include/read0types.h:129 |

</details>

## 核心实现

### mtr_t：一切页修改的单一入口

`mtr_t`（`include/mtr0mtr.h:77`）持有 page latch 栈 `m_memo` + redo 缓冲 `m_log`。`log/log0log.cc:50-55` 文件头有一段哲学声明——所有页修改必须经 mtr。关键语义在 `memo_push()`（:394）：`MTR_MEMO_PAGE_X_MODIFY` 标记脏页时若该页 `oldest_modification() <= 1`（净页）则置 `m_made_dirty`，使 `commit()` 持 `flush_list_mutex` 并把页插入 flush_list——**保证"写 FIL_PAGE_LSN"与"进 flush list"同序**（`mtr_t::commit_log()`，`mtr/mtr0mtr.cc:418-457`）。这是自适应刷脏与 crash recovery 正确性的根基。

### lock-free page hash（MDEV-22871）

`buf_pool.page_hash`（`include/buf0buf.h:1498`）是 MariaDB 特色设计：`hash_chain` 单链 + 每 64 字节（7 个 cell）共享一个 `page_hash_latch`，查找先走无锁 `page_guess()`，miss 才 `lock_shared()`。**Why**：page hash 查找是最热路径，单 pool mutex 在多核下不可扩展；64 字节对齐分桶使锁冲突概率 ~1/7 per cell。配合 `buf_page_t::fix()` 原子 buffer-fix 状态机取代了大锁。

### group_commit_lock：没有后台日志线程的 redo

这是 MariaDB InnoDB 与 MySQL 8 分叉最剧烈的地方。MySQL 8 有 log_writer/log_flusher/write_notifier/flush_notifier 四个专用后台线程；MariaDB（10.8 起）**全部删除**，代之以 `log/log0sync.cc` 的 `group_commit_lock`（LSN 感知唤醒 + Linux futex `binary_semaphore`）：

1. durable 提交先 `flush_lock.acquire(lsn)` 承诺至少刷到该 LSN
2. 抢到 leader 的线程：`log_sys.writer()` 把 `log_sys.buf` 以 `write_size`（≤4KB，对齐文件系统块）`pwrite` 进单循环文件 `ib_logfile0`
3. `log_flush()` fsync，更新 `flushed_to_disk_lsn`；follower 挂在锁上按 LSN 精确唤醒

**Why**（`log0sync.cc:30-40` 设计说明）：专用线程方案有唤醒风暴与跨线程交接开销；此处等待者即执行者，无交接。redo 文件也无 log block checksum——恢复靠块对齐 + 非法记录即停（FORMAT_10_8，`include/log0log.h:147`）。

### commit_ordered：提交序与持久化解耦

`trx/trx0trx.cc:1484-1505` 的注释讲清了设计：逻辑提交（分配 trx_no、undo 进 history list）在全局互斥内完成以保证 **binlog 与 InnoDB 提交序一致**；昂贵的 fsync 推迟到锁外的 `trx_flush_log_if_needed` + group commit；`wakeup_subsequent_commits()`（ha_innodb.cc:4813）显式放行后续提交形成组。若在互斥内 fsync，会把所有提交串行化成单 fsync 流。配套约束：purge 入队与 trx_no 分配同临界区（trx0trx.cc:1158-1189）——purge 协调器按 trx_no 顺序读 undo，乱序入队会破坏 history list 顺序。

### binlog-in-engine（13.x 实验方向）

`handler/innodb_binlog.cc`（160KB，Kristian Nielsen "Binlog-in-engine" 系列）：binlog 数据在提交 mtr 内写入（`innodb_binlog_trx`，trx0trx.cc:1195），文件为 `binlog-N.ibb`，用伪表空间 ID `LOG_BINLOG_ID_0/1 = 0xFFFFFFF0/1`（`include/mtr0log.h:317`）走标准 mtr/redo/恢复路径。**redo 成为唯一事实源，binlog↔engine 两阶段提交被取消**——`innodb_flush_log_at_trx_commit=0` 时崩溃后仍能恢复出一致的 binlog。这是 MySQL 完全没有的方向。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 模板方法 | `mtr_t::commit` 固定 flush_list→写 LSN→wakeup 顺序 | 保证三序一致的正确性骨架 |
| 读写锁 + hazard pointer | flush_list 的 `FlushHp`、LRU 的 `lru_hp` | 刷脏/扫描与并发修改共存 |
| 状态机 | `trx_t::state`（NOT_STARTED→ACTIVE→COMMITTED_IN_MEMORY，include/trx0trx.h:686 六态） | AC-NL-RO（autocommit 非锁定只读）全程无 mutex 切换 |
| 单例 | `buf_pool`、`lock_sys`、`log_sys` 全局唯一 | MariaDB 10.5 移除了 `innodb_buffer_pool_instances` |

## 模块间交互

- **上游**：`ha_innobase : public handler`（`storage/innobase/handler/ha_innodb.h:63`）实现 handler 抽象（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)）；`HTON_WSREP_REPLICATION` 标志只在此引擎设置（`ha_innodb.cc:4341`）——Galera 的行级写集复制只对 InnoDB 保证
- **横切**：binlog 协同两模式——传统 2PC + `commit_checkpoint_request = innodb_log_flush_request`（ha_innodb.cc:4325，binlog 落盘后请求 InnoDB 推进 redo/checkpoint）；13.x 新增 binlog-in-engine
- **线程模型**：InnoDB 专用线程只剩 page cleaner 一个（`buf/buf0flu.cc:3101`）；purge worker 与 dict_stats 跑在 `srv_thread_pool`（tpool）任务上——**MariaDB 把引擎后台任务搬到了通用线程池**

## MariaDB fork 现状速查

相对 MySQL 8 的差异（均已从代码核实）：

| 项 | MariaDB 13 | MySQL 8 |
|---|---|---|
| redo 架构 | 10.8 重写：单循环文件、无 checksum、在线 resize、无后台日志线程（group_commit_lock） | log_writer 四线程 + log block checksum |
| change buffer | **10.9 移除**（ibuf0ibuf.cc 只剩升级清除逻辑） | 保留 |
| AHI | 重做且**默认关**（MDEV-37070：`OFF`/`ON`/`IF_SPECIFIED` + `ADAPTIVE_HASH_INDEX=` 表/索引选项） | 默认开 |
| buffer pool | 单实例 + lock-free page hash | 多实例 |
| doublewrite | 仍在系统表空间 TRX_SYS 页 + `innodb_doublewrite=fast` + 原子写跳过 | 8.0.20+ 独立 .dblwr 文件 |
| general tablespace | **无**（`innodb_file_per_table` 已 DEPRECATED 但仍默认 ON，方向是单文件化） | 有 |
| undo 表空间 | 独立 3 个默认（0-127） | 有 |
| 快照隔离 | `innodb_snapshot_isolation` 默认 ON（RR 升级为写冲突检测 SI，MDEV-35124） | 无此语义 |
| binlog-in-engine | 13.0 新增（`--binlog-storage-engine`） | 无 |

## 扩展方式

**新增一种页级压缩算法**：`fil/fil0pagecompress` 与 `handler` 的 `COMPRESSION_ALGORITHM` 表选项联动——在 `fsp/fsp0crypt`（加密挂钩在 `innobase_hton`）旁注册新算法。

**新增 redo 记录类型**：`include/mtr0log.h` 的记录类型枚举 → `log0recv.cc` 恢复分支 → 写入点在 `mtr_t::commit_log` 的序列化函数。注意 FORMAT 版本（FORMAT_10_8 = 0x50687973）不变则记录类型号向后兼容。

**典型修改示例（MDEV 实践）**：给 buffer pool 加统计 → `buf/buf0buf.cc` 计数器 + `handler/i_s.cc` 的 `INNODB_BUFFER_PAGE` 表暴露——i_s.cc（6.5k 行）是引擎状态暴露给 SQL 层的标准通道。
