---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "InnoDB 引擎"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "InnoDB", "MVCC", "B+树", "redo log", "缓冲池"]
description: "ha_innobase 桥接、row_search_mvcc 读取路径、缓冲池与 page cleaner、redo 五线程流水线、MVCC ReadView 与锁系统、Aries 恢复的源码解读"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

InnoDB 是 MySQL 的事务引擎（5.5 起默认），`storage/innobase/` 下 34 个子目录、约 47 万行——mysql-server 里最大的单一模块，比整个 SQL 层的一半还大。它完整自洽地实现了：B+树页存储、缓冲池、行级锁、MVCC 多版本、redo/undo 日志、Aries 式崩溃恢复、change buffer、自适应哈希、全文索引、在线 DDL 的 row merge、物理克隆。它独立存在的意义：**ACID 语义的全部重量压在引擎内部**，server 层只通过 handler 契约看到行与事务提交的抽象。

## 模块架构

![InnoDB 内部架构](/vibe-reading/images/articles/mysql-internals/innodb-architecture.svg)

自顶向下五个层次：`ha_innobase` 桥接层（handler API 翻译，`row_prebuilt_t` 缓存一次扫描的全部会话态）；row/锁/MVCC 事务层（`row_search_mvcc` 扫描、`lock_t` 位图锁、`ReadView` 快照）；内存层（`buf_pool_t` 缓冲池 + doublewrite/change buffer/AHI 三个旁路设施）；物理层（B-tree 游标、mtr mini-transaction、log buffer）；文件层（fil/fsp 表空间、undo、redo 文件）。右侧后台线程族与各层松耦合交互：purge 清 undo、page cleaner 刷脏页、log 五线程写 redo。

## 调用链路

### SELECT 读取路径

```text
ha_innobase::rnd_next (ha_innodb.cc:11104)
├─ m_start_of_scan 首扫: index_first(buf)，HA_ERR_KEY_NOT_FOUND 转 HA_ERR_END_OF_FILE
└─ general_fetch (ha_innodb.cc:10805)
   ├─ TrxInInnoDB 检查（事务是否被强制回滚）+ innobase_srv_conc_enter_innodb 并发限流
   ├─ intrinsic 表（优化器私有的无 undo 临时表）走 row_search_no_mvcc，
   │   其余全部走 row_search_mvcc (row/row0sel.cc:4437)
   ├─ PHASE 1: prefetch cache 命中直接出栈（row0sel.cc:4534）
   ├─ PHASE 2: AHI 快路径——btr0sea 哈希命中则免 B-tree 下降（:4656）
   ├─ PHASE 3: btr_pcur_open 打开/恢复游标；页面经 buf_page_get_gen (buf/buf0buf.cc:4445)
   │           （hash 查找→buf_fix pin→LRU young 化→读盘→挂入 mtr）
   └─ PHASE 4: 逐记录循环（:4968）
      ├─ 非锁定读: trx->read_view->changes_visible(rec_trx_id)（read0types.h:159）
      │     不可见 → row_vers_build_for_consistent_read (row/row0vers.cc:1228)
      │               沿 DB_ROLL_PTR 回溯 undo 版本链直到可见或历史已 purge
      └─ 锁定读: lock_sec_rec_read_check_and_lock（随 mtr 持有、commit 释放）
   错误映射: DB_RECORD_NOT_FOUND 与 DB_END_OF_INDEX 都映射 HA_ERR_END_OF_FILE
```

**每行迭代一个短 mtr**（页耗尽时 `mtr_commit` 重定位游标，`row0sel.cc:5933`）——事务级 latch 从不长持，这是 InnoDB 高并发的根基：读不阻塞写、写不阻塞读，全靠"短 mtr + MVCC"组合。

### UPDATE 写入路径

```text
ha_innobase::update_row (ha_innodb.cc:10035)
└─ row_update_for_mysql (row/row0mysql.cc:2434) → row_upd (row/row0upd.cc:3150)
   ├─ 聚簇索引: btr_cur_optimistic_update（原地更新）失败/需外溢
   │            → btr_cur_pessimistic_update（悲观路径预留 2×树高页防中途空间不足）
   └─ 二级索引 = DELETE+INSERT（row_upd_sec_index_entry）
└─ 页修改统一入口 btr/btr0cur.cc（"All changes must go through this module"）
   先写 undo → mtr_t::commit (mtr/mtr0mtr.cc:577)
   → Command::execute (:781)：m_log 拷入 log buffer、推进 LSN、脏页挂 flush list
```

### COMMIT 路径

```text
innobase_commit (ha_innodb.cc:5997)
├─ will_commit = commit_trx || !thd_test_options(OPTION_NOT_AUTOCOMMIT | OPTION_BEGIN)
│   # 真提交，或 autocommit 语句结束
├─ TrxInInnoDB(trx, will_commit)：置 TRX_FORCE_ROLLBACK_DISABLE，防高优先级事务在提交窗口杀死本事务
├─ trx->flush_log_later = true —— 先写不刷，为组提交留聚合窗口（:6091）
├─ innobase_commit_low (:5930) → trx_commit_for_mysql (trx/trx0trx.cc:2477)
│    └─ trx_commit (:2283)：写 COMMIT undo 标记 → trx_commit_in_memory (:1986)
│        （释放全部锁、清 insert undo、state=COMMITTED_IN_MEMORY）
└─ trx_commit_complete_for_mysql (:2532)：此时才等 log 刷盘（durability 点）
```

语句结束（非提交）分支则只做 `lock_unlock_table_autoinc`（自增锁释放）与 `trx_mark_sql_stat_end`（统计收尾）。

方法速查：

<details>
<summary>InnoDB 方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `row_search_mvcc` in `row0sel.cc:4437` | 一致性读扫描核心 | 短 mtr + prefetch cache + AHI 三级加速 |
| `buf_page_get_gen` in `buf0buf.cc:4445` | 取页（含 pin/读盘/挂 mtr） | change buffer 合并也在此触发 |
| `mtr_t::commit` in `mtr0mtr.cc:577` | 提交 mini-transaction | m_memo 记录 latch 依赖序保证重放正确 |
| `log_writer` in `log0write.cc:2237` | redo 写线程 | 收割并发写者的 buffer 片段单线程 write() |
| `ReadView::changes_visible` in `read0types.h:159` | MVCC 可见性 O(1) 短路 | 双界 + 二分的三段式判断 |
| `buf_flush_page_cleaner_thread` in `buf0flu.cc:3326` | 脏页刷盘 worker | coordinator/worker slot 状态机协作 |

</details>

## 核心实现

### MVCC：ReadView 双界快照

```cpp
bool ReadView::changes_visible(trx_id_t id) const {   // read0types.h:159
  if (id < m_up_limit_id || id == m_creator_trx_id) return true;   // 快照前提交
  if (id >= m_low_limit_id) return false;                          // 快照后开始
  if (m_ids.empty()) return true;
  return !std::binary_search(p, p + m_ids.size(), id);             // 活跃集中则不可见
}
```

四元组 `m_up_limit_id`（快照时刻最小活跃 id）/`m_low_limit_id`（下一待分配 id）/`m_creator_trx_id`/有序活跃数组 `m_ids`。**为什么是双界**：绝大多数记录的 trx_id 命中两端 O(1) 短路，只有落在 (up, low) 开区间且活跃集非空的少数才二分查找——避免每次行可见性判断都扫活跃事务表。`MVCC` 类（`read0read.h:46`）是 ReadView 池管理器，对 autocommit 只读事务有免 `trx_sys` mutex 的 fast path；`clone_oldest_view` 给 purge 系统取"最老视图"作为可清理 undo 的下界。26.x 把这层抽出 `read0read_view_interface.h`/`read0mvcc_interface.h` 接口（配合独立 redo 库的复用需求）。类头还有一个真实的性能注脚：cache line padding 防伪共享——曾造成 sysbench 16% TPS 下降。

### 锁系统：page+heap_no 的位图锁

`lock_t`（`lock0priv.h:137`，`alignas(8)`）是单个锁对象：`trx`（持有者）+ `type_mode`（uint32 位标志：`LOCK_GAP/LOCK_REC_NOT_GAP/LOCK_INSERT_INTENTION` + 模式）+ **union { lock_table_t tab_lock; lock_rec_t rec_lock; }**（表锁与记录锁共用同一结构，记录锁的位图 `page_id + n_bits` 紧跟结构体之后）。`type_mode` 的位域提取全靠内联方法：`type() = type_mode & LOCK_TYPE_MASK`、`mode() = type_mode & LOCK_MODE_MASK`、`is_waiting()/is_gap()/is_insert_intention()` 按位测试。锁粒度是 **(space, page_no, heap_no)** 而非主键——heap_no 与页内物理位置直接对应、哈希键短；代价是 B-tree split/merge 时必须搬运锁（`lock0lock.h:78` remark，`btr0cur.cc` 头注释同时解释悲观路径为何预留 2×树高页：leaf split 一旦开始很难撤销，预留保证不会中途因空间不足卡死在半分裂状态）。调度用 CATS 算法（Contention-Aware Lock Scheduling，非 FIFO）；全局 latch + 分片 cell 锁两级并发。next-key lock = 记录锁 + gap 锁，这是 RR 隔离级别下防幻读的机制根源。

### 缓冲池与 page cleaner

`buf_pool_t`（`buf0buf.h:2285`）分链表分锁：LRU（midpoint insertion，`LRU_old_ratio` 控制老区比例——全表扫描的页进 old 区防污染）、flush list（按 `oldest_modification` LSN 升序，即刷盘顺序）。`buf_page_t`（`:1156`）持 `newest/oldest_modification` 双 LSN。脏页刷盘由 page cleaner 家族驱动：coordinator（`buf0flu.cc:2955`）+ N 个 worker（`:3326`），刷多少由 `set_flush_target_by_lsn`（`:2270`）决定——取 dirty 百分比与 LSN age（adaptive flushing，`get_pct_for_lsn`）的较大值，追不上则升级 sync flush。**doublewrite**（`buf0dblwr.cc:491` 的 `Double_write` 类）：先整批写 dblwr 文件、fsync、再散写数据文件——消除 16K 页的 torn write；26.x 增 reduced dblwr 模式。

### redo log：五线程流水线

`log_start_background_threads`（`log0log.cc:908`）按顺序启动的流水线（创建序）：flush_notifier → flusher → write_notifier → writer → files_governor：

```text
用户线程（mtr commit）──写──► log buffer（log0buf，推进 log.sn）
                               │
                        log_writer (:2237)      write() 到 log file
                               │
                        log_flusher (:2502)     fsync（log_flush_low）
                               │
              log_write_notifier (:2639) + log_flush_notifier (:2761)
                        按 LSN slot（log_compute_flush_event_slot）唤醒等待的用户线程
                               │
                        log_files_governor     log 文件空间/checkpoint 推进
```

**为什么拆线程**（8.0 WL#10310 的动机）：fsync 比内存操作慢几个数量级，四级异步化后提交线程把 buffer 写完即返回（`flush_log_later` + `trx_commit_complete_for_mysql` 里才等刷盘），等待者由 notifier 专职唤醒——避免数百线程在同一个条件变量上惊群。`innodb_log_writer_threads=OFF` 可关回落单线程。26.x 把这层抽出 `log0handler_interface.h`，并提供**独立 redo 解析/应用库**（WL#15560，供克隆/备份工具脱离 server 复用恢复逻辑）。

### mtr：mini-transaction

`mtr_t`（`mtr0mtr.h:174` 起）是页级逻辑变更单元：`m_memo`（持有的页 latch 栈——崩溃重放时保证被引用页先恢复）+ `m_log`（本 mtr 的 redo 流）。redo 是 physiological 日志（"在该页该偏移插入此记录"而非整页镜像）——redo 量与变更量成正比而非页大小。恢复期 `recv_recovery_from_checkpoint_start`（`log0recv.cc:2304`）扫描 redo 建成 (space,page_no)→哈希桶的物理重放任务，`recv_writer_thread`（`:611`）配合 page cleaner 分批落盘；未提交事务由后台 `trx_rollback_or_clean_all_without_sess` 按 undo 回滚。

### change buffer 与 AHI

- **change buffer**（`ibuf0ibuf.cc`）：二级索引页不在池中时把 INSERT/DELETE-MARK 缓存到常驻内存的 ibuf B-tree，页被读入时在 `buf_page_get_gen` 内合并——用顺序化换随机读，代价是页空闲空间位图（`IBUF_BITS_PER_PAGE=4`）与合并时机的复杂性；
- **自适应哈希**（`btr0sea.cc`）：观察索引前缀访问模式建页级哈希，`row_search_mvcc` PHASE 2 命中即免 B-tree 下降；分区锁降低争用，可在线启停。

### DD 集成与克隆

表定义从 server 层 DD 翻译：`dd_open_table`（`dict/dict0dd.cc:5412`）把 `dd::Table` 序列化对象变成 `dict_table_t` 缓存；反向 DDL 经 `dict_sdi_*` 把 SDI JSON 写进表空间的 SDI B-tree（可传输表空间、`ibd2sdi` 工具的基础）。物理克隆（`clone/`）依赖 redo 归档 + buffer pool 侧的 `Flush_observer`——mtr commit 时把相关脏页登记给 observer，保证拷贝前的一致性切面（"pin 住 LSN"）。26.x 的 clone 支持 LTS 到 LTS 跨版本克隆与 Updated Versioning Model（`clone0snapshot.h` 的状态机扩展）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 桥接 | `ha_innobase` + `row_prebuilt_t` | MySQL 行格式与 InnoDB 记录格式的转换边界 |
| 对象池 | trx 池、ReadView 池（`MVCC`）、mtr 释放的 latch | 高频创建销毁对象全部池化 |
| 流水线 | redo 五线程 | 慢速 fsync 与快速内存写解耦 |
| 观察者 | `Flush_observer`（clone/online DDL 脏页追踪） | 不侵入正常刷盘路径的旁路登记 |
| 乐观/悲观双径 | `btr_cur_optimistic_*` vs `btr_cur_pessimistic_*` | 快路径无锁假设，失败降级持树锁 |

## 模块间交互

- **上游**：handler 契约（见[存储引擎 API](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/05-storage-engine-api)）——`innodb_init` 挂接 60+ 回调；
- **与 DD**：`dd_open_table` 翻译元数据、`handler0alter.cc` 的在线 DDL 读写 `se_private_data`（见[DD 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/07-dd-ddl)）；
- **与提交链**：`innobase_commit` 是组提交 Stage 3 的引擎侧终点（见[复制模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication)）；clone 还会反向要求 binlog 保持提交顺序（`Clone_handler::need_commit_order`）；
- **与可观测性**：`i_s.cc`/`p_s.cc` 暴露 20+ 张 INNODB_* 系统表（以 I_S 插件形式注册）。

## 扩展方式

- **新增 InnoDB 系统变量**：`handler/ha_innodb.cc` 的 `MYSQL_SYSVAR_*`（389 个定义全在此文件）+ update 回调；全局内部参数另在 `include/srv0srv.h` 声明；观测加 `handler/srv0mon.cc` 的 MONITOR 项；
- **新增锁类型**：`include/lock0types.h` 的 `lock_mode` 枚举 + `lock0priv.h` 的 type_mode 判定与冲突矩阵（`lock0lock.cc` 的 `lock_rec_lock` 路径）；
- **新增 redo 记录类型**：`log0log.cc`/`mtr0log.cc` 的记录编码 + `log0recv.cc` 的解析分发——需评估独立 redo 库的兼容性。
