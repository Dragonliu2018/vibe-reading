---
source:
  type: "源码解读"
  project: "polardb-pg"
  url: "https://github.com/polardb/PolarDB-for-PostgreSQL"
title: "LogIndex 引擎"
date: "2026-09-26T23:11:29+08:00"
category: [Database, OLTP, PolarDB, CodeWiki, "17.11.1.0"]
contentType: "CodeWiki"
tags: ["PolarDB", "PostgreSQL", "LogIndex", "存算分离", "lazy 回放", "mini transaction", "bloom filter"]
description: "LogIndex 是 WAL 的页面级倒排索引——记录 BufferTag→有序 LSN 链，把 PG 顺序回放 WAL 的强依赖改造成按页面独立回放，支撑 RO 的 lazy/parallel 回放与 mini transaction 原子性。"
readingTime: "28 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/00-overview)

---

## 模块定位

LogIndex 是 PolarDB 独创的核心数据结构，位于 `src/backend/access/logindex/`（22 个 .c 文件，~22,400 行）。一句话：**WAL 的"页面级倒排索引"**——记录 `(BufferTag → 有序 LSN 链)`，把 PG 原生"顺序回放 WAL"的强依赖改造成"按页面独立回放"，从而支撑 RO 节点 lazy/parallel 回放、mini transaction 回放原子性和 full page snapshot。

每个表项**只存 LSN 不存数据**——回放时仍从共享存储读 WAL 原始记录。这一点决定了它与"复制 WAL 数据"的本质区别：它复制的是"修改历史的目录"，数据本身已经在共享存储上了。

## 模块架构

内存结构是 **snapshot（全局）→ 内存表（环形数组）→ 表内 hash 链** 三层，外加磁盘 `.tbl` 段文件 + bloom filter：

```text
log_index_snapshot_t                 (共享内存全局快照, polar_logindex_internal.h:386)
 ├─ mem_table[N]  (环形数组)
 │   └─ log_index_mem_table_t         单张内存表
 │       ├─ free_head                 bump 分配指针
 │       ├─ state                     FREE/ACTIVE/INACTIVE/FLUSHED 四态
 │       └─ data: log_index_table_t   可落盘数据
 │           ├─ hash[2048] ──(next_item 链)──> log_item_head_t  (页面条目头)
 │           │                                └─(next_seg 链)──> log_item_seg_t (LSN 溢出段)
 │           ├─ segment[4096]          48B 定长 slot 并行数组(union head/seg)
 │           └─ idx_order[40960]      全局插入序 (seg_id 12bit | idx 4bit)
 ├─ bloom_ctl (SlruCtlData)           bloom filter 的 SLRU 缓存
 ├─ meta: log_index_meta_t            落盘元数据
 └─ segment_cache (polar_local_cache) RO 本地磁盘缓存远端 .tbl 段
```

表内条目（`log_item_head_t` / `log_item_seg_t`，polar_logindex_internal.h:294-313）：

```c
/* src/include/access/polar_logindex_internal.h:294 */
typedef struct log_item_head_t
{
    log_seg_id_t head_seg;      /* 自身所在 seg 编号(1..4096) */
    log_seg_id_t next_item;    /* 同 hash 桶内下一个不同页面的条目(拉链) */
    log_seg_id_t next_seg;     /* 本页面 LSN 溢出到下一个 seg */
    log_seg_id_t tail_seg;     /* LSN 链尾段(追加点) */
    BufferTag    tag;          /* 页面三元组+fork+block */
    uint8        number;       /* head 内已存 LSN 数(<=2) */
    XLogRecPtr   prev_page_lsn;/* 该页面更早的 LSN——lazy 回放起点/防撕裂锚点 */
    uint32       suffix_lsn[LOG_INDEX_ITEM_HEAD_LSN_NUM];  /* 低 32 位 LSN */
} log_item_head_t;
```

三个结构级设计：

- **并行数组（parallel array）防对齐浪费**：若直接定义 struct 会因内存对齐浪费空间，因此 4096 个 slot 用 `log_tbl_seg_t` union 定长 48 字节（`StaticAssertStmt(sizeof(log_item_head_t)==48)` 在 `polar_logindex_snapshot_shmem_init`（polar_logindex.c:620）强制校验）。head（2 个 LSN）与 seg（10 个 LSN）共用槽位；
- **LSN 压缩**：同一张表内所有 LSN 共享高 32 位前缀 `prefix_lsn`（`LOG_INDEX_SAME_TABLE_LSN_PREFIX`），条目内只存低 32 位 suffix。一张表天然只覆盖约 4GB 的 LSN 窗口，前缀变了就必须换新表（`log_index_next_free_seg`，polar_logindex.c:1106）；
- **`prev_page_lsn`** 是 lazy 回放正确性的锚：迭代器用它验证"上一条记录确实已在收集范围内"（防 hollow）。

**内存表四态状态机**（`log_index_mem_table_t`，polar_logindex_internal.h:335）：`FREE`（未用）→ `ACTIVE`（当前插入目标，只有一张）→ `INACTIVE`（已封口，等 bg worker 落盘）→ `FLUSHED`（已落盘，slot 可复用/可作读缓存）。

**`max_lsn` / `min_lsn`**（`log_index_table_t` 字段）语义是**该表覆盖的 LSN 区间**，三个用途：(1) flush 门槛——`polar_logindex_table_flushable`（polar_logindex.c:166）要求 WAL flush 位超过表 max_lsn 才可写盘（logindex 绝不能比 WAL 更"持久"）；(2) 迭代器剪枝——`log_index_table_in_range` 整表跳过无交集的表；(3) 淘汰依据——`log_index_truncate`（polar_logindex.c:1829）按段内 max_lsn 判断可删。

**磁盘组织**：表文件 `pg_logindex/%04lX.tbl`，每段 64 张表（`LOG_INDEX_TABLE_NUM_PER_FILE = (BLCKSZ/4096) × SLRU_PAGES_PER_SEGMENT = 2×32`），表在段内按 tid 定长偏移直接 `FileWrite`（`log_index_save_table`，polar_logindex.c:1210）。每表附带 4KB bloom filter（对表内全部 BufferTag 做 membership），经 bloom 专用 SLRU 缓存。文件数上限 `polar_max_logindex_files`（默认 80）之上用 rename 循环复用段文件。meta 更新遵循"**先 meta 后删文件**"崩溃安全序。

## 调用链路

### RW 侧：记录生成（异步、旁路 WAL 关键路径）

```text
后端 XLogInsert
└─ CopyXLogRecordToWAL (xlog.c:1098)
   └─ polar_xlog_send_queue_push (polar_queue_manager.c:524)
      把 WAL 镜像进 xlog_queue ring buffer（共享内存，无盘 I/O）
└─ walwriter/checkpointer flush 后唤醒 "polar logindex saver" 后台进程
   └─ polar_logindex_saver_main (polar_logindex_bg_worker.c:345)
      └─ polar_logindex_primary_save (polar_logindex_redo.c:2407)
         ├─ polar_xlog_send_queue_pop 取出记录
         └─ polar_logindex_save_lsn (polar_logindex_redo.c:595)
            └─ polar_idx_redo[rmid].rm_polar_idx_save   ← rmgr 分发
               例: polar_heap_idx_save (polar_heap_idx.c:1596)
               ├─ XLOG_HEAP_INSERT → polar_heap_insert_save
               │    → polar_logindex_save_block(record, 0)
               └─ XLOG_HEAP_UPDATE(HOT) → polar_heap_xlog_update_save
                    按标志位推导 VM 页: polar_logindex_save_vm_block
                    （VM 页不在 WAL block ref 里，须由 flags 推导）
                    → polar_logindex_save_block (polar_logindex_redo.c:532)
                       → polar_logindex_add_lsn (polar_logindex.c:2008)
                          → log_index_insert_lsn (polar_logindex.c:1926) ★核心插入
```

`polar_logindex_add_lsn`（polar_logindex.c:2008）在 snapshot 尚未进入 `POLAR_LOGINDEX_STATE_ADDING` 状态时有三重丢弃门控：`lsn < meta->start_lsn` 丢弃（早于索引起点）；`lsn < meta->max_lsn` 丢弃（已插入过）；`lsn == meta->max_lsn` 时调 `log_index_exists_in_saved_table` 去重——该函数取 `LOG_INDEX_MEM_TBL_PREV_ID`（前一张）内存表，仅当其状态为 `FLUSHED` 时从 `last_order` 向下扫描 order 数组比对 tag。

`log_index_insert_lsn` 内部（polar_logindex.c:1926-2005）：

1. 活跃表 hash 查找 `log_index_mem_tbl_exists_page`（:942）——注释明确：仅一个进程插入，免 hash 锁检查存在性；
2. 命中且未满：`log_index_append_lsn`（:1050）在 head（≤2 个 LSN）或 tail_seg（每段 10 个）追加，断言 LSN 严格递增；
3. 未命中/满了/前缀变了：`log_index_next_free_seg`（:1081）切新表（满表置 INACTIVE、唤醒 bg worker），`log_index_insert_new_item`（:988，挂 hash 桶头）或 `log_index_insert_new_seg`（:1017，接 LSN 链尾）；
4. 无论哪条路径都执行 `LOG_INDEX_MEM_TBL_ADD_ORDER` 把 `(seg_id, idx)` 压入 `idx_order` 插入序数组；
5. 更新 `max_lsn/min_lsn`，且**必须在 CRC 计算之前**（:2000-2004 注释：max_lsn 影响表 CRC）。

`flush_active_table` 打开时（fullpage 快照要求活跃表也落盘），插入路径要持有 `LOG_INDEX_FLUSH_ACTIVE_TBL_LOCK` 排他锁且最后释放——防止与 fullpage 的 flush-active 落盘并发修改同一张活跃表（`log_index_insert_lsn` 的 `need_flush_lock` 分支，polar_logindex.c:1957）。

设计意图：logindex 生成完全移出 WAL 插入关键路径（插入进程只做一次共享内存 ring buffer 拷贝），由独立 saver 进程消费——WAL 写入延迟零额外磁盘 I/O。

### RW 侧：落盘

```text
触发源（三处）:
  ① CheckPointGuts (xlog.c:8378) → polar_logindex_redo_flush_data
     → 把所有 [min_lsn,max_lsn] 在 checkpoint 之前的 INACTIVE 表刷出
  ② logindex bg worker / saver 主循环 → polar_logindex_redo_bg_flush_data
     → log_index_primary_bg_write → log_index_flush_table
        (RO 侧走 log_index_replica_bg_write, 只读 meta 更新内存态不写盘)
  ③ 表满时插入进程自保: log_index_wait_active → log_index_force_save_table
     还有 fullpage 的 flush_active=true 路径(fullpage 快照要求活跃表也落盘)

log_index_flush_table (polar_logindex.c:185-308)
└─ 从 mid = meta->max_idx_table_id % mem_tbl_size 环形扫描
   ├─ log_index_table_flushable (166): WAL flush 位必须超过表 max_lsn
   ├─ log_index_table_saved_before_promote (144): failover 后旧主已刷的表
   │  直接标 FLUSHED 跳过
   └─ log_index_write_table (1661)
      ├─ 按 tid 顺序落盘(tid == meta->max_idx_table_id+1 才写，保证表文件有序)
      ├─ log_index_calc_bloom (1179) 构建 4KB bloom → log_index_save_bloom
      ├─ log_index_save_table (1210): 算 CRC → FileWrite 到 .tbl 段内偏移 → FileSync
      ├─ 更新 meta → log_index_write_meta (781) 覆写 log_index_meta 文件
      └─ 表状态置 FLUSHED (slot 可被环形复用)
   └─ 批量限制 polar_logindex_table_batch_size=100 (checkpoint 路径不受此限)
```

### RO 侧：接收 + 建 logindex + parse

```text
walreceiver 收到 WAL → startup 进程 ApplyWalRecord (xlogrecovery.c:2335)
└─ polar_logindex_parse_xlog (polar_logindex_redo.c:619)
   ├─ rm_polar_idx_save 先插 logindex（641-647 行注释：先存 LSN 再拿 mini trans 锁，
   │  缩短 mini transaction 临界区、降低锁竞争）
   ├─ polar_logindex_mini_trans_start(mini_trans, state->EndRecPtr)
   ├─ rm_polar_idx_parse，例 polar_heap_idx_parse (polar_heap_idx.c:1641)
   │  └─ 对每个 block:
   │     ├─ polar_logindex_mini_trans_lock(tag) 拿 mini trans 页锁
   │     └─ polar_logindex_parse → polar_logindex_outdate_parse (:311)
   │        读 buffer 进内存 + 标记 POLAR_REDO_OUTDATE（等 lazy 回放）
   └─ lastReplayedEndRecPtr 更新后 polar_logindex_mini_trans_end
```

669-678 行注释解释了 mini transaction 不能在 parse 处结束的原因：`XLogCtl->lastReplayedEndRecPtr` 尚未推进，若提前放锁，backend 立刻 lazy 回放会拿不到 mini trans 锁、回放不到当前记录，导致该记录"已存索引但没人回放"而丢失。

### RO 侧：迭代器读取（lazy 回放/并行回放共用）

```text
backend 读到 POLAR_REDO_OUTDATE 页
└─ LockBuffer (bufmgr.c:6032/6099/6203)
   └─ polar_logindex_lock_apply_buffer (polar_logindex_redo.c:928)
      └─ polar_logindex_lock_apply_page_from (:828)
         ├─ polar_logindex_mini_trans_cond_lock (polar_mini_transaction.c:249)
         │  该页若属于正在 parse 的 mini transaction → 拿锁并返回 trans->lsn
         └─ polar_logindex_apply_page_from
            └─ polar_logindex_apply_page (:696)
               ├─ start_lsn = Max(start_lsn, PageGetLSN(page))  ← 页面 LSN 即回放进度
               ├─ polar_logindex_create_page_iterator (polar_logindex_iterator.c:701) ★
               │  从 max_idx_table_id 开始（新表→旧表）:
               │  (a) log_index_push_mem_tbl_lsn (442) 扫内存表
               │  (b) log_index_push_file_tbl_lsn (630) 扫落盘表:
               │      ├─ log_index_check_hollow_table (546): meta 追不上 → HOLLOW → ERROR
               │      ├─ log_index_check_bloom_not_exists (570): bloom 说没有 → 跳过整表读盘
               │      │   （bloom_data->max_lsn < iter->min_lsn 时整表早于检索窗口，
               │      │    直接置 ITERATE_STATE_FINISHED 终止迭代）
               │      └─ log_index_read_table (1605): 命中才读——
               │         FLUSHED 内存表 → 本地 segment_cache → 共享存储 .tbl
               │         并回填一个 FLUSHED 内存表 slot（读缓存复用）
               └─ polar_logindex_apply_one_page (:992): 迭代器逐条 pop LSN
                  → polar_logindex_read_xlog (:267) 按需读 WAL 记录
                  → polar_logindex_apply_one_record (:237)
                  → polar_idx_redo[rmid].rm_polar_idx_redo
```

**为什么用栈收集而不是边扫边回放**：搜索是从新表到旧表（`tid--`），但 LSN 必须按旧到新回放，`lsn_stack`（两级链表栈：每表一个 `log_index_tbl_stack_lsn_t`，内含 64 项一批的数组块）的 LIFO 语义天然把逆序搜索翻转为正序输出（`polar_logindex_page_iterator_next`，polar_logindex_iterator.c:776）。

**RO 启动预热**：`polar_logindex_snapshot_base_init`（polar_logindex.c:507）→ `polar_load_logindex_snapshot_from_storage`（:2103）把最近 `mem_tbl_size` 张表从盘读入内存标 FLUSHED——给随后的 page iterator 省读盘时间。

**并行回放（dispatcher）**：`polar_logindex_bg_worker_main`（polar_logindex_bg_worker.c:153）辅助进程用 `log_index_lsn_iter`（`polar_logindex_create_lsn_iterator`，polar_logindex_iterator.c:1057）按 `idx_order` 全局顺序扫出"下一个要回放的页面"，封装成 `parallel_replay_task_node_t` 推给并行 worker——LSN iterator 的 `log_index_lsn_iterator_update`（:1128）处理了"扫到 ACTIVE 表时 last_order 仍在增长"的并发竞态（先读 state 再读 `UINT32_ACCESS_ONCE(last_order)` 的顺序保证，:1146-1150 注释）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `log_index_insert_lsn` (polar_logindex.c:1926) | 核心插入 | 单写者免 hash 锁；满表唤醒 bg worker |
| `log_index_append_lsn` (:1050) | head/seg 追加 LSN | 断言严格递增 |
| `log_index_flush_table` (:185) | 环形扫描落盘 | WAL 先于 logindex 持久化门槛 |
| `log_index_save_table` (:1210) | 写 .tbl 段内偏移 | CRC + FileSync |
| `log_index_calc_bloom` (:1179) | 构建 4KB bloom | 免读盘前置过滤 |
| `log_index_truncate` (:1829) | 段淘汰 | 先 meta 后删文件崩溃安全序 |
| `polar_logindex_create_page_iterator` (iterator.c:701) | 页面维迭代器 | 新→旧扫描，栈翻转正序 |
| `polar_logindex_create_lsn_iterator` (:1057) | LSN 维迭代器 | dispatcher 用，idx_order 序 |
| `polar_logindex_apply_page` (redo.c:696) | 单页回放 | start_lsn=Max(请求, PageLSN) 幂等 |
| `polar_logindex_read_xlog` (:267) | 读 WAL 记录 | 从共享存储按需读 |
| `polar_logindex_parse_xlog` (:619) | startup parse 入口 | save 先于 mini trans 锁 |
| `polar_logindex_save_block` (:532) | block ref→BufferTag→插入 | rmgr 三件套的公共底座 |

</details>

## 核心实现

### MiniTransaction：页面级并行的原子性桥

**为什么需要**（polar_mini_transaction.c 头注释 :26-33 原文）：一条 XLOG 记录可能包含多个页面的修改；没有 mini transaction，RO 上会出现同一数据结构的不同版本页面（如 B-Tree 一半节点回放了新版本、一半还是旧的）。LogIndex 把回放拆成页面粒度后，**必须有一个机制把"一条记录内的多个页面"重新绑成原子单元**。

```c
/* src/include/access/polar_mini_transaction.h:55 */
typedef struct mini_trans_data_t
{
    LWLockPadded lock[1 + MINI_TRANSACTION_TABLE_SIZE]; /* 1 总锁 + 37 页锁 */
    bool     started;
    XLogRecPtr lsn;      /* 当前正在 parse 的 WAL 记录 EndRecPtr */
    uint64_t  occupied;  /* 64bit 位图: info 槽占用情况 */
    mini_trans_info_t info[37];  /* {tag, refcount, next, added} */
} mini_trans_data_t;
```

核心流程：

1. **start**（`polar_logindex_mini_trans_start`，polar_mini_transaction.c:122）：startup 进程为当前记录开启事务；上一条没结束则 PANIC（**任一时刻只有一个 mini transaction**）；
2. **锁页**（`polar_logindex_mini_trans_lock`，:322）：`mini_trans_find` 在 coalesced hash 里找 tag，找到则 `refcount+1`（**多个 backend 可以同时等同一页**），没找到则 `mini_trans_insert_tag`（:150）占位——目标 key 桶已被占用时，沿 `next` 链找到空闲槽插入并保持链表可查找。**加锁顺序 = redo 处理该记录 block 的顺序**（注释明确要求，例：`polar_heap_xlog_update_parse` 中先 old 页后 new 页，polar_heap_idx.c:324-333）——这是防回放死锁的序；

容量 37 的推导（polar_mini_transaction.h:43）：`MINI_TRANSACTION_TABLE_SIZE = MINI_TRANSACTION_HASH_SIZE + MINI_TRANSACTION_HASH_SIZE/5 = 31 + 6 = 37`。编译期两条静态断言（`polar_logindex_mini_trans_shmem_init`）：`MINI_TRANSACTION_TABLE_SIZE > XLR_MAX_BLOCK_ID`（一条记录的 block 数天然有上限）和 `MINI_TRANSACTION_TABLE_SIZE <= sizeof(uint64_t) * CHAR_BIT`（37 槽必须塞得进 64bit `occupied` 位图）——**选 coalesced 是因为表大小固定且极小，开链法省内存**。
3. **page_added 标志**（`polar_logindex_mini_trans_set_page_added`，:473）：LSN 存入 logindex 后打标。backend lazy 回放时用它决定回放终点——**没打标就不能回放到当前记录**，否则可能基于半成品结构回放。这是"先 save 后加锁"优化的安全网；
4. **end**（:413）：等待所有 `refcount` 归零，清位图。backend 侧事务回滚中持有页锁时，`polar_logindex_abort_mini_transaction`（:103）按本地记录逐个释放——防锁泄漏。

**容量保证**：`MINI_TRANSACTION_TABLE_SIZE(37) > XLR_MAX_BLOCK_ID`（StaticAssert，:88）——一条 WAL 记录的 block 数天然有上限，37 槽 coalesced 表必然够用。

**双端视角**：startup（写方）排他锁住"正在 parse 的记录的所有页"；backend（读方）`polar_logindex_mini_trans_cond_lock`（:249 条件锁）——页在当前事务里就等锁并得知 `trans->lsn`（可安全回放到当前记录），不在就返回 INVALID 立即回放到上一条完成记录。**这实现了读写两端的非阻塞交汇**。

### rmgr 三件套：table-driven 分发

每个资源管理器注册三个钩子（`log_index_redo_t`，polar_logindex_redo.h:116）：

```c
/* polar_idx_redo[] 分发表 (polar_logindex_redo.c:120)
 * 经 #include "access/rmgrlist.h" + PG_RMGR 宏 10/11/12 参扩展 (rmgr.h:22) */
polar_idx_redo[rmid].rm_polar_idx_save   /* 从 record 提取 (tag, lsn) 存 logindex */
polar_idx_redo[rmid].rm_polar_idx_parse  /* mini trans 锁页 + 标记 outdate */
polar_idx_redo[rmid].rm_polar_idx_redo   /* 单页面版本的 redo */
```

按 `(info & XLOG_HEAP_OPMASK)` 二级 switch 分发。11 个适配文件覆盖 heap/nbtree/hash/gin/gist/spgist/brin/sequence/generic/xlog/storage——`polar_storage_idx.c` 特殊处理 SMGR truncate/extend，维护 `polar_rel_size_cache` 的 truncate 记录（`polar_record_truncate_heap_info` 系列）。

### failover 边界：`log_index_promoted_info_t`

旧主 crash 时可能"已插入 logindex 但没落盘"（`old_primary_max_inserted_lsn` vs `old_primary_saved_max_lsn` 两个水位）。RO 提升后：已落盘的表标 FLUSHED 跳过重写（`log_index_table_saved_before_promote`，:144）；迭代器 `before_promote=true` 时 `max_idx_table_id` 钳到旧主边界（`polar_logindex_create_page_iterator`，:727-743）——防止读到"新主自己产生、尚未回放"的 LSN 造成自引用循环。

### WAL 与 logindex 的删除协调

WAL 文件会被 checkpoint 删除，**logindex 引用的 WAL 若先删，迭代器就指向空洞**——所以 `xlog.c:8151/8679` 在 checkpoint 删 WAL 前先调 `polar_logindex_remove_old_files`（注释明确 "Truncate logindex before removing wal files"），淘汰水位 `min_lsn` 取自 `polar_calc_min_used_lsn`（xlog.c:11042）：logindex start_lsn、物理复制槽 restart_lsn、RedoRecPtr、并行回放 bg_replayed_lsn 的最小值——即"最落后的消费者还需要的最老 LSN"。迭代器侧的对应防线是 `ITERATE_STATE_HOLLOW` 与 `prev_lsn` 校验链——一旦发现窗口不完整立即 ERROR，而不是静默回放出半新半旧的页面。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 函数指针表 / table-driven 分发 | `polar_idx_redo[]`（redo.c:120） | 新增 rmgr 零改动分发框架 |
| 迭代器模式（两种正交维度） | page iter（iterator.c:701）+ lsn iter（:1057） | "这一个页有哪些 LSN" vs "下一个该回放哪个页" |
| 状态机 | mem table 四态 / iter 五态 / snapshot 三态位 | 原子 uint32 + 写屏障驱动跨进程协作 |
| hook 扩展点 | `polar_logindex_table_flushable_hook`（internal.h:494） | fullpage 上层替换"表可落盘"判据 |
| bloom filter 前置过滤 | `log_index_check_bloom_not_exists`（iterator.c:570） | RO 避免为"不含该页的表"读盘 |
| 两级缓存 | FLUSHED 内存表 → 本地 segment_cache → 共享存储 | RO 本地 SSD 缓存远端段文件 |
| union 定长槽 + 并行数组 | `log_tbl_seg_t`（internal.h:315） | 48B 对齐消除 struct padding |
| stack-based 收集 | `log_index_iter_push_tbl_stack`（iterator.c:147） | 新→旧扫描、旧→新回放，LIFO 天然翻转 |

## 模块间交互

**被谁调用**：

- `xlog.c`：`CopyXLogRecordToWAL` 推 `xlog_queue`（:1098）；`CheckPointGuts`→`polar_logindex_redo_flush_data`（:8378）；checkpoint 删 WAL 前先 `polar_logindex_remove_old_files`（:8151/8679）；
- `xlogrecovery.c`：`polar_logindex_redo_init`（:1941/1960）；`ApplyWalRecord`→`polar_logindex_parse_xlog`（:2335）；级联备库 `polar_standby_xlog_send_queue_push`（:2257，RO 把 WAL 从 xlog_queue 再转发给自己的 standby）；
- `bufmgr.c`：`LockBuffer` 体系三处（:6032/6099/6203）调 `polar_logindex_lock_apply_buffer`——**lazy 回放的真正入口在 buffer 锁上**；
- postmaster：注册 logindex saver BGW（`polar_register_logindex_primary_saver`）与 `B_BG_LOGINDEX` 辅助进程。

**依赖谁**：`storage/polar_fd.c` + [04 VFS](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs)（所有 .tbl/meta/bloom I/O）；`access/slru.c`（bloom SLRU 页缓存）+ `lib/bloomfilter.c`；`storage/polar_local_cache.c`（segment_cache）；[05 本地缓存体系](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/05-local-cache) 的 `polar_rel_size_cache`（回放前校验页是否已被 truncate）。

与 [02 WAL 元数据复制与并行回放](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/02-wal-meta-replay) 的分工：本模块是"索引结构与读写"；02 是"传输协议与回放调度"——xlog_queue ring buffer 在 `polar_queue_manager.c`，是两模块的物理交汇点。与 [03 Buffer 一致性](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency) 的分工：fullpage snapshot（`polar_log_fullpage_snapshot_image`，polar_fullpage.c:690）在 RW checkpoint 时直接把旧页整页写盘（copy_buffer 可复用免读盘），RO 直接整页恢复跳过逐条回放——用空间换回放时间。

## 扩展方式

**新增一种索引 AM 的 logindex 支持**（以 BRIN 的 `polar_brin_xlog_idx.c` 510 行为最小模板），改 **4 处**：

1. **新建 `src/backend/access/logindex/polar_XXX_xlog_idx.c`**，实现三件套：
   - `polar_XXX_idx_save(instance, record)`：遍历每个 block ref 调 `polar_logindex_save_block`；AM 特有页面（如 heap 的 VM）要像 `polar_heap_xlog_update_save`（polar_heap_idx.c:248）那样从记录 flags **推导**隐式页面再记录；
   - `polar_XXX_idx_parse(instance, record)`：每个 block 先 `polar_logindex_mini_trans_lock` 再 `polar_logindex_parse`，锁序与原生 redo 一致；
   - `polar_XXX_idx_redo(instance, record, tag, buffer)`：把原生 `XXX_redo` 改造成**单页面**版本——按 tag 与 buffer 里 `PageGetLSN` 判断是否需要重做，返回 `XLogRedoAction`；
2. **`src/backend/access/logindex/Makefile`**：OBJS 加 `polar_XXX_xlog_idx.o`；
3. **`src/include/access/polar_logindex_redo.h`**：三个函数的 extern 声明（参照 :341-347 heap/btree 的写法）；
4. **`src/include/access/rmgrlist.h`**：对应 `PG_RMGR(RM_XXX_ID, ...)` 行的末三参数从 NULL 换成三个函数名。

分发表 `polar_idx_redo` 因宏展开自动收录，无需再改。若该 AM 有"记录隐含修改的关联页"（heap→VM、btree→metapage），还要同步维护 `polar_rel_size_cache` 的 truncate 记录。
