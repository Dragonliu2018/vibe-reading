---
source:
  type: "源码解读"
  project: "polardb-pg"
  url: "https://github.com/polardb/PolarDB-for-PostgreSQL"
title: "RO 本地缓存体系"
date: "2026-09-26T23:11:29+08:00"
category: [Database, OLTP, PolarDB, CodeWiki, "17.11.1.0"]
contentType: "CodeWiki"
tags: ["PolarDB", "PostgreSQL", "SLRU", "本地缓存", "relation size cache", "future page", "存算分离"]
description: "共享存储上的文件永远反映 RW 的「现在」，而 RO 需要自己的「过去」——SLRU 本地段缓存、smgr 层 RSC 当前值缓存、logindex 层 rel_size 历史缓存三层各管一个视角。"
readingTime: "24 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/00-overview)

---

## 模块定位

核心问题一句话：**共享存储上的文件永远反映 RW 的"现在"，而 RO 需要自己的"过去"**。该体系由三层组成：

1. **SLRU 本地段本地文件缓存**（`polar_local_cache` 框架，clog/commit_ts/multixact 本地化）——事务状态视角；
2. **smgr 层 RSC**（relation size cache，`polar_rsc.c`）——查询路径的 nblocks 当前值缓存；
3. **logindex 层 `polar_rel_size_cache.c`**——回放路径的"LSN→关系大小变更历史"，与 [LogIndex 按页回放](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex) 配套。

## 模块架构

三层分工（从代码确认，非猜测）：

| | `src/backend/storage/smgr/polar_rsc.c` | `src/backend/access/logindex/polar_rel_size_cache.c` |
| --- | --- | --- |
| 服务路径 | **查询/执行路径**（`smgrnblocks`） | **回放路径**（LogIndex 按页回放） |
| 存的内容 | 关系当前 nblocks（每 fork 一个值，可失效） | **(LSN, rlocator, fork, rel_size) 变更历史** + (LSN, db) 的 DB NEW/DROP 状态（append-only，环形表，溢出落本地文件 `polar_rel_size_cache/%04lX`）。单张表内**关系大小记录从 `rel_tail=0` 起向后追加（递增）、DB 状态记录从 `db_tail=REL_INFO_TOTAL_SIZE` 起向前追加（递减）**，一张 BLCKSZ 表两头对向增长 |
| 数据结构 | 分区哈希 + 定长对象池 + clock 淘汰 | `polar_rel_size_table_t`（BLCKSZ 固定大小），共享内存保留 `polar_rel_size_cache_blocks`（默认 2）张，更早的表 flush 到本地盘 |
| GUC | `polar_rsc_shared_relations`（默认 16384）等 | `polar_rel_size_cache_blocks`（默认 2） |
| 回答的问题 | "这个关系现在多大？" | "**在 LSN X 这个时间点，(tag, blockNum) 这一块还存在吗？该从哪个 LSN 起回放这个页面？**" |

两者交汇点：`polar_storage_idx.c` 的 truncate 函数同时调 `polar_record_rel_size_with_lock`（写历史）和 `polar_rsc_update_if_exists`（更新当前值）——历史给回放用，当前值给查询用。

## 调用链路

### SLRU 本地段路由（两级判别）

**第一级（文件路径级）**：宏 `POLAR_SLRU_FILE_IN_SHARED_STORAGE()`（slru.c:98）——`polar_enable_shared_storage_mode && ctl->shared->polar_file_in_shared_storage`。`polar_file_in_shared_storage` 由 `SimpleLruInit`（slru.c:282，签名追加第 10 参 `polar_shared_file`）写入，各 SLRU 统一传 `POLAR_SLRU_ENABLE_SHARED_STORAGE`（slru.h:236）：

```c
/* src/include/access/slru.h */
#define POLAR_SLRU_ENABLE_SHARED_STORAGE (polar_enable_shared_storage_mode && !polar_is_replica())
```

路径分流在 `SlruFileName`（slru.c:100-133）：命中共享存储时路径加 `polar_datadir` 前缀，否则为本地相对路径。

**第二级（I/O 层整段接管）**：若向该 SLRU 注册过本地缓存（`shared->polar_cache != NULL`，由 `polar_slru_reg_local_cache`，slru.c:2126 注册），则 `SlruPhysicalReadPage/WritePage` 在最前面直接转交 `polar_slru_local_cache_read_page`（:2134）/ `polar_slru_local_cache_write_page`（:2167），完全不经过普通文件路径。**段删除**：`SlruInternalDeleteSegment`（slru.c:1609）走 `polar_local_cache_remove`；纯 replica 对共享存储上的文件跳过 `polar_unlink`（slru.c:1634，elog LOG）——RO 不删共享盘上的段。

**哪些 SLRU 被本地化**（`polar_shared_file` 实参一览）：

| SLRU | 目录 | 实参 | 位置 |
| --- | --- | --- | --- |
| CLOG | `pg_xact` | `POLAR_SLRU_ENABLE_SHARED_STORAGE` | clog.c:823 |
| CommitTs | `pg_commit_ts` | 同上 | commit_ts.c:567 |
| MultiXact offsets/members | `pg_multixact/` | 同上（两个 SLRU） | multixact.c:2141/2148 |
| SubTrans | `pg_subtrans` | `false`（永远本地） | subtrans.c:290 |
| Serialize/Notify | `pg_serial`/`pg_notify` | `false` | predicate.c:816 / async.c:540 |
| LogIndex bloom | logindex 目录 | `true` | polar_logindex.c:664 |

subtrans/pg_serial/pg_notify 在原生 PG 语义里就是节点本地的瞬态数据，连 RW 都不放共享存储。subtrans 的 +46 行 POLAR 改造与本地缓存**无关**——是增量 checkpoint 场景下对"回放起点 LSN 早于 oldestActiveXid 导致 subtrans 段被截断"的防御（`polar_slru_page_physical_exists` 检查后补零页）。

### GUC → 缓存池结构

三个 GUC（均 PGC_POSTMASTER）：`polar_clog_max_local_cache_segments`（默认 **128**）、`polar_commit_ts_max_local_cache_segments`（默认 **32**）、`polar_multixact_max_local_cache_segments`（默认 **32**，offsets/members 各建一个池）。

缓存池结构 `polar_local_cache_data`（`src/include/utils/polar_local_cache.h:65`）：

- `io_seg_items[]`：定长数组，元素 `polar_io_segment{segno, status, min_write_offset}`；`status` 位标志含 `OCCUPIED / DIRTY / READABLE / WRITE_IN_PROGRESS` + 20 位读引用计数。空间耗尽时的淘汰顺序（`polar_evict_io_segment`，polar_local_cache.c:533 注释）：**先淘汰 clean 段 → 其次等待 io in progress 的段（释放锁后以 LW_EXCLUSIVE 重取并 continue）→ 最后选 `io_seg_items[0]` 强制调 `polar_local_cache_flush` 刷写腾位**；
- `hash_io_seg`：共享内存 HTAB，segno → 数组下标；
- `free_items_list`：空闲下标栈；
- `io_permission`：4 位权限（LOCAL/SHARED × READ/WRITE）。

**角色权限差异**（clog.c:834-835）：

```c
/* src/backend/access/transam/clog.c — CLOGShmemInit */
uint32 io_permission = POLAR_CACHE_LOCAL_FILE_READ | POLAR_CACHE_LOCAL_FILE_WRITE;
if (!polar_is_replica())
    io_permission |= (POLAR_CACHE_SHARED_FILE_READ | POLAR_CACHE_SHARED_FILE_WRITE);
```

- **RW**：本地缓存是共享存储 SLRU 段的**写回式缓存**——读：本地命中直接返回，miss 则整段 SHARED→LOCAL 拷贝（`polar_cache_read`，polar_local_cache.c:454）；写：只写本地并标 DIRTY，checkpoint 时 `polar_shared_file_flush` 从 `min_write_offset` 起 LOCAL→SHARED 拷贝（:512）。附带收益（slru.c:1024 注释）：`O_CREAT` 会触发 pfs 写锁，append-only 文件仅在 offset==0 时带 `O_CREAT`；
- **RO**：只有 LOCAL 读写权限。`polar_cache_read` 本地 miss 且无 SHARED_FILE_READ 权限时直接失败（按段不存在处理），即 **RO 的 clog 视图完全 = 启动时拷贝的快照 + WAL 回放增量**。

### RO 提升时的一致性：flush list 记账

RO 上 `polar_local_cache_flush`（:758）发现没有 SHARED_FILE_WRITE 权限时走 `polar_record_local_flushed_seg`（:84）：把 segno 追加写入 `pg_xact/readonly_flushed_seg_NNNN` 元数据文件，**只保留最近 3 份 list**。

`polar_slru_promote`（slru.c:2220）→ `polar_local_cache_set_io_permission`（:1147）：检测到"无共享写 → 有共享写"的权限翻转时，按 N-2、N-1、N 三份 flush list 依次 `polar_copy_local_flushed` 把这些段 LOCAL→SHARED 拷贝——保证 RO 期间被逐出的段在提升后不丢。随后 `ctl->shared->polar_file_in_shared_storage = true`。

调用链：

```text
启动: polar_init_local_dir (miscinit.c:2097)
├─ replica: polar_copy_dirs_from_shared_storage_to_local
│   → polar_copy_shared_trans_dirs (:2234)
│   → polar_init_local_clog/commit_ts/multixact
│     (polar_slru_copy_shared_dir slru.c:2013 文件级拷贝; copy_all=false 时
│      用 polar_trans_file_need_copy 只拷含 oldestXid 之后的段,
│      依赖 pg_control.local——RO 上次运行保存的本地 control 副本)
└─ 非 replica: polar_remove_local_cache (:2173) 把本地缓存目录 move 进
   polar_cache_trash (checkpoint 时 polar_local_cache_empty_trash 清理)

提升: polar_online_promote_data (polar_logindex_redo.c:3108)
└─ polar_promote_clog() (clog.c:1185) 等四个
```

## 核心实现

### RSC：查询路径的 nblocks 缓存（polar_rsc.c）

纯共享内存结构（无本地文件）：

```c
/* src/include/storage/polar_rsc.h */
typedef struct polar_rsc_shared_relation_t {
    RelFileLocator rlocator;
    BlockNumber nblocks[MAX_FORKNUM + 1];  /* 每个 fork 独立缓存 */
    pg_atomic_uint32 flags;               /* RSC_LOCKED / RSC_VALID / RSC_DIRTY */
    pg_atomic_uint64 generation;          /* 逐出时 +1，用于无锁指针校验 */
    int64 usecount;                       /* clock sweep 计数 */
} polar_rsc_shared_relation_t;
```

- 哈希表 `rsc_mappings`：128 分区 HTAB，key = `RelFileLocator`；对象池 `rsc_pool`：entry 用自旋锁位（`polar_rsc_lock_entry`，polar_rsc.c:172，CAS + `perform_spin_delay`）保护，配合 generation 做 seqlock 式读；
- `polar_rsc_shared_relations`（默认 16384）：池容量。`polar_rsc_pool_sweep_times`（默认 8，SIGHUP）：时钟扫描最大步数。淘汰算法 `rsc_lru_pool_sweep`（polar_rsc.c:308）：`pg_atomic_fetch_add_u32(&rsc_pool->next_sweep, 1) % 容量` 作时钟指针逐个锁定条目并 `--usecount`，减到 ≤ 0 即返回；累计扫描达到 sweep_times 仍未找到则随机挑 `entries[random() % 容量]`——简单 clock/第二次机会淘汰；
- **锁序约束**（`rsc_alloc_entry`，polar_rsc.c:339 大段注释）：淘汰时必须**先复制 rlocator 并释放条目 spin 锁，再获取分区 LWLock**——持自旋锁的进程若因 LWLock 忙碌而离开 CPU 睡眠，会导致自旋卡死；拿到 LWLock 后复查 `mapping->index == index`，不一致则重试。淘汰成功时 `pg_atomic_add_fetch_u64(&sr->generation, 1)` 使其他进程的 `rsc_ref` 快速路径失效，再从 `rsc_mappings` 中 `HASH_REMOVE`；
- `smgrnblocks_cached` 在 RSC 启用时**永远返回 InvalidBlockNumber**（smgr.c:887，注释：强制所有进程走共享内存的 RSC 而非 per-backend 的 `smgr_cached_nblocks`——后者缺乏文件大小变更的失效机制）；
- 读取走 `polar_rsc_search_entry`（polar_rsc.c:662）三级：`search_by_ref`（SMgrRelation 上缓存 `rsc_ref` 指针 + generation 校验）→ `search_by_mapping`（分区哈希）→ miss 则回源 `smgrnblocks_real` 并入池。搜索模式枚举 `polar_rsc_search_mode_t`（polar_rsc.h）：NEVER / MEMORY_ONLY / NO_EVICT / AND_EVICT / NOEXIST_SEARCH_AND_EVICT——`NO_EVICT` 在未命中时 `elog(WARNING, "RSC miss but no need to evict, fallback to real file system call")` 回落 `smgrnblocks_real`，不做逐出；

**写路径（RW）**：`smgrextend`/`smgrzeroextend`/`polar_smgrbulkextend`（smgr.c:619/666/714）→ `polar_rsc_update_entry`；`smgrtruncate2`（:1043）；`smgrdounlinkall` → `polar_rsc_drop_entry`（:539）。**RSC_DIRTY 语义**（polar_rsc.c:582-620 大段注释）：只有 extend/truncate 能写值并标 dirty；普通查询回填不允许覆盖——防止"backend A 查询回源的旧大小"覆盖"backend B extend 刚写入的新大小"。

**RO 侧维护（polar_rsc_replica.c）——WAL 驱动**：RO 回放进程的 RSC 更新回调表 `polar_rsc_replica_redo_cb[RM_N_BUILTIN_IDS]`，在主回放循环每条记录前调用（xlogrecovery.c:2284）。三类策略：

- **知道怎么变**：heap insert/update/multi-insert、btree split/newroot、gin/gist split、FPI → `polar_rsc_update_if_exists(&rlocator, fork, blkno+1, _nblocks_greater_than)`（只增不减）；`XLOG_SMGR_TRUNCATE` 用 `_nblocks_less_than`；
- **不确定** → 默认回调 `rsc_replica_redo`（:360）：把该记录涉及的所有 rlocator 的 entry 直接 drop；
- **DDL**：`XLOG_DBASE_DROP`/`XLOG_TBLSPC_DROP` → drop entries；`XLOG_SMGR_CREATE` → init empty entry。

`polar_rsc_update_if_exists`（:726）的头注释是 RO 设计的官方理由：

> "Relying on the value given by storage is not safe, because the file may have been modified by primary. Trust the value from WAL record is more accurate."

**为什么 RO 不能直接读共享存储上的 relation size**：(a) RW 已 extend 而 RO 未回放对应 WAL 时 size 偏大，RO 会扫到"未来块"；(b) RW 已 truncate/drop 而 RO 未回放时 size 偏小甚至文件消失，而 RO 仍需要旧大小来丢 buffer、判定块有效性；(c) 每次远程 lseek 共享存储本身昂贵。所以 RO 的 nblocks 只信 WAL 值；miss 时 fallback 到 `smgrnblocks_real`（读到的是未来态，作为初值接受，后续由 WAL 回放校正）。

**附带优化** `polar_rsc_optimize_drop_buffers`（默认 true）：`DropRelationBuffers`（bufmgr.c:4663）从 RSC 取 nblocks，改走哈希精确定位 `FindAndDropRelationBuffers`，避免全 buffer 池扫描；RO 上还跳过 FSM/INIT fork（bufmgr.c:4647 注释：RO 从不读这两个 fork）。

### rel_size 历史缓存（polar_rel_size_cache.c）

只被回放侧使用（关键证据——调用方）：

- **写入**：① 运行时 `POLAR_RECORD_REL_SIZE` 宏（polar_logindex_redo.h:557，取当前 WAL insert/replay 指针为 LSN），调用点是 `smgrtruncate2`（smgr.c:970）和 `smgrdounlinkall`（:510，仅 replica/并行回放时）；② 回放 parse 阶段 `polar_storage_idx_parse`（polar_storage_idx.c:188）处理 RO 上的 `XLOG_SMGR_TRUNCATE`；③ `dbase_redo` 的 `POLAR_RECORD_DB_STATE`（dbcommands.c:3520/3551）；
- **读取**：`polar_logindex_apply_page_from`（polar_logindex_redo.c:786，`polar_check_rel_block_valid_and_lsn`——块若已被 truncate/drop，把回放 start_lsn 改到 truncate LSN）；`polar_bg_redo_apply_read_record`（:1294，跳过已删块）；`polar_xlog_need_replay`（:2785，并行回放 worker 标记 `BUF_IS_TRUNCATED`）。查找方向是**从最新表向旧表回溯、按 LSN 比较**——`polar_search_truncate_info` 从 `rel_tail` 向 pos=0 回扫、`rel.lsn <= lsn` 即终止返回；`polar_search_db_state` 从 `db_tail` 向 `REL_INFO_TOTAL_SIZE` 正向扫描。终止用 `<=` 而非 `<` 的原因：rel_size_cache 记录 XLOG 记录的 **EndRecPtr** 而 LogIndex 记录 start LSN——polar_rel_size_cache.c:296 注释专门解释了这个 off-by-one；
- **两个入口的错误处理差异**：`polar_check_rel_block_valid_only`（内部 `lsn_changed = NULL`）在遇到 POLAR_DB_NEW 且 lsn 早于结果、或 POLAR_DB_DROPED 且 lsn 不早于结果时直接 `elog(PANIC)`（数据结构矛盾宁可崩溃）；`polar_check_rel_block_valid_and_lsn`（`lsn_changed` 非 NULL）不 PANIC，而是把修正后的起始 LSN 写入 `*lsn_changed` 交给调用方改写回放起点；
- **生命周期**：`polar_logindex_remove_old_files`（polar_logindex_redo.c:1777）按 min_lsn 截断旧表。

### future page：等待旧版本页面

**纠正一个定位**：`polar_wait_old_version_page_timeout` 的逻辑主体不在 xlogutils.c，而在 `polar_logindex_restore_fullpage_snapshot_if_needed`（polar_logindex_redo.c:3277）。变量默认 30s（GUC 注册 guc_tables.c:3820，PGC_USERSET）。

检测与恢复链（全部在 RO backend ReadBuffer 路径）：

```text
ReadBuffer → polar_prepare_backend_redo (bufmgr.c:7580)
           → polar_exec_backend_redo (bufmgr.c:7610)
           → polar_logindex_io_lock_apply (polar_logindex_redo.c:2365)
              ├─ polar_logindex_restore_fullpage_snapshot_if_needed (:3277)
              │  ├─ polar_is_future_page (polar_bufmgr.c:1125:
              │  │    MAIN_FORKNUM && LSN > replayed_lsn; 未开 FPSI 则直接 FATAL)
              │  ├─ fullpage_logindex 建 [replayed_lsn, ∞) 页迭代器 → 取第一条 FPSI 记录
              │  ├─ polar_logindex_read_xlog + polar_logindex_apply_one_record
              │  │    旧镜像覆盖 buffer
              │  └─ 取不到 → pg_usleep(100) 重试; 超过 polar_wait_old_version_page_timeout
              │       → elog(FATAL, "Read a future page due to timeout...")
              └─ polar_logindex_lock_apply_page_from（从 checkpoint_lsn 正常补 WAL;
                 其中 :786 处查 polar_rel_size_cache 决定截断块的回放起点）
```

**与 LogIndex 的关系**：WAL LogIndex（页 tag → LSN 列表）使"按页按需回放"可行；fullpage snapshot 是第二个 logindex（PWT_FPSI 记录），专供旧版本页恢复；`polar_wait_old_version_page_timeout` 等的是 RO 自己的 FPSI logindex 解析进度（WAL 还没解析到那条 FPSI 记录时短暂等不到）。

**xlogutils.c 实际的 +254 行支撑点**：`XLogReadBufferForRedoExtended` 的无效页检查（:434-533）、`XLogReadBufferExtended` 的 RO 不建文件 + `blkno < lastblock` 分支（:605-627，RO 直接读共享存储上已被 RW 扩好的文件）+ bulk extend、`read_local_xlog_page` 的 logindex/fullpage/xlog-buffer 读源支持（:1066-1240）、invalid-page 的并行回放 forget 队列。

### relcache/relmapper 改造

本版本 `src/backend/utils/cache/` 下的 POLAR 改动 = `polar_local_cache.c`（1263 行新文件）+ `relmapper.c`（23 处）；`relcache.c` 本身 0 处修改：

- `polar_local_cache.c`：即本地段缓存框架（通用文件缓存层，logindex bloom/wal/fullpage 快照也复用它：`polar_logindex_create_local_cache`，polar_logindex.c:2458，权限 = LOCAL R/W + SHARED READ）；
- `relmapper.c`：读写 `pg_filenode.map` 统一走 `polar_make_file_path_level2` 前缀（:787-819 读 / :894-999 写）；`relmap_redo`（:1106）：**RO 回放 XLOG_RELMAP_UPDATE 时不落盘**（RO 不能写共享存储上的 map 文件），只 `CacheInvalidateRelmap` 广播内存失效。**遗留观察**：共享盘上的 map 文件可能已是"未来"版本而 RO 直接读盘重载——本版本未见 LSN 版本校验（待核实）；旁证是 polar_rsc.c:787 注释 "Don't load relfilelocator under global tablespace into RSC because of uncontrolled flushing of relmapper"。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两级路由（路径前缀 + I/O 接管） | `SlruFileName` + `polar_slru_local_cache_*`（slru.c:100/2134） | 框架级通用，新 SLRU 零改动 |
| 权限位翻转 + 重放记账 | `readonly_flushed_seg_NNNN`（polar_local_cache.c:84） | RO 期间的脏段提升不丢 |
| seqlock 式读 | generation 字段（polar_rsc.c:225） | 无锁快速路径 + 逐出安全 |
| 当前值 vs 历史 双缓存 | RSC + rel_size_cache | 查询路径 O(1) 当前值；回放路径时间旅行 |
| WAL 驱动的回调表 | `polar_rsc_replica_redo_cb[]`（polar_rsc_replica.c） | RO 无写权限时的状态维护 |

## 模块间交互

- **依赖 [01 LogIndex 引擎](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex)**：`polar_logindex_apply_page_from` 查 rel_size 历史决定截断块的回放起点；logindex bloom 的 SLRU 复用 `polar_local_cache` 框架；`polar_logindex_remove_old_files` 同时截断 rel_size 历史表。
- **与 [02 并行回放](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/02-wal-meta-replay)**：`polar_rsc_replica_redo_cb` 挂在 startup 主回放循环（xlogrecovery.c:2284）；`polar_xlog_need_replay` 的 `BUF_IS_TRUNCATED` 判定供并行回放 worker 消费。
- **与 [03 Buffer 一致性](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency)**：future page 的检测在 `polar_is_future_page`（polar_bufmgr.c:1125）与恢复在 fullpage snapshot——03 的 RW 侧约束（不刷超前页）与 05 的 RO 侧兜底（FPSI 恢复）是同一问题的两端。
- **依赖 [04 VFS](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs)**：本地缓存段与共享存储段的拷贝（SHARED→LOCAL / LOCAL→SHARED）全部走 VFS 路由；`polar_init_local_dir` 的目录骨架拷贝在 VFS 挂载完成后执行。

## 扩展方式

**把另一个 SLRU（设为 XXX，目录 pg_xxx）也本地化**——slru.c 框架本身零改动（已通用），按 clog 模板改 6 处：

1. **`src/backend/access/transam/xxx.c`**：`XXXShmemSize` 追加 `polar_local_cache_shmem_size`（模板 clog.c:792）；`XXXShmemInit` 里 `SimpleLruInit(..., POLAR_SLRU_ENABLE_SHARED_STORAGE)` + 创建缓存并注册（io_permission：replica 仅 LOCAL R/W，否则加 SHARED R/W；tranche 需新增 `LWTRANCHE_POLAR_XXX_LOCAL_CACHE`）；三个包装 `polar_promote_xxx()` → `polar_slru_promote` / `polar_init_local_xxx(...)` → `polar_slru_copy_shared_dir`（起点用 RO 本地 pg_control 的 oldest 值，模板 clog.c:1192）/ `polar_remove_xxx_local_cache_file()`；
2. **`src/backend/utils/cache/polar_local_cache.c:39-42`**：加 `int polar_xxx_max_local_cache_segments = 0;`（+ 头文件 extern）；
3. **`src/backend/utils/misc/guc_tables.c`**：注册 GUC（PGC_POSTMASTER，模板 :3136）；
4. **`src/backend/utils/init/miscinit.c`**：`polar_remove_local_cache()`（:2173）加 remove；`polar_copy_shared_trans_dirs()`（:2261）加 `polar_init_local_xxx(...)`；
5. **`src/backend/access/logindex/polar_logindex_redo.c`**：`polar_online_promote_data()`（:3118-3123）加 `polar_promote_xxx()`；
6. **miscadmin.h / slru.h** 补函数声明。

若该 SLRU 是 append-only 复用（如 logindex bloom），还需要 `polar_slru_append_page`（O_CREAT 仅 offset==0）与 `polar_slru_invalid_page`（强制驱逐某页，polar_logindex.c:327/1289 是现成用例）。
