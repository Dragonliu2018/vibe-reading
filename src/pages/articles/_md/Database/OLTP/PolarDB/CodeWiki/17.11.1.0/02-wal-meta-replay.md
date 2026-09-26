---
source:
  type: "源码解读"
  project: "polardb-pg"
  url: "https://github.com/polardb/PolarDB-for-PostgreSQL"
title: "WAL 元数据复制与并行回放"
date: "2026-09-26T23:11:29+08:00"
category: [Database, OLTP, PolarDB, CodeWiki, "17.11.1.0"]
contentType: "CodeWiki"
tags: ["PolarDB", "PostgreSQL", "walsender", "walreceiver", "并行回放", "replication", "存算分离"]
description: "RW 只向 RO 复制 WAL 元数据（record header + block 引用，无 payload）——'y' 消息从共享内存 ring buffer 零读盘发出；RO 写 LogIndex 后由 tag 亲和任务队列分发给并行回放 worker。"
readingTime: "26 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/00-overview)

---

## 模块定位

存算分离下 RW→RO 的同步通道。核心改造：RW 只把 WAL record 的**元数据**（record header + block 引用，不含 payload）通过共享内存 ring buffer 推给 walsender 发给 RO；RO 收到后写入 [LogIndex](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex)（page tag → LSN 映射表），由后台/并行 worker 或 backend 按需从**共享存储**读取完整 WAL record 和数据页完成回放。

为什么可以不传 payload：数据页和 WAL 文件都在共享存储上，payload 对 RO 是纯冗余——RO 需要完整记录做 redo 时直接从共享存储 `pg_wal` 读。

## 模块架构

三种消息类型对比（与上游 PG 的本质区别）：

| 消息 | 发送条件 | 内容 | 上游 PG 对应 |
| --- | --- | --- | --- |
| `'y'` | RW→RO，queue 可用 | flush_ptr + consistent_lsn + 批量 meta 包（**无 payload**） | 无对应（PG 发 'w'） |
| `'p'` | RW→RO 降级（walsender.c:3702） | dataStart/walEnd/consistent_lsn/sendTime，**无任何 WAL 数据** | PG 'w' 含完整 WAL 字节 |
| `'w'` | 发给 standby / 普通物理复制 | 完整 WAL record（读 WAL buffers 优先） | 同 PG 'w' |

上游 PG 的物理复制：walsender 从 WAL 文件读完整 record → 网络发 'w' → walreceiver 写**本地** WAL 文件 → startup 读本地文件回放。PolarDB RW→RO：**meta 从 ring buffer 零读盘发出，RO 不写任何 WAL 文件**（`XLogWalRcvFlush` in walreceiver.c:1317：`polar_is_replica()` 跳过 `issue_xlog_fsync`，只推进 `LogstreamResult`）。

任务调度层不是一致性哈希，是**tag 亲和 + 依赖链 + 轮转兜底**（`src/backend/storage/ipc/polar_procpool.c`）：

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `polar_task_sched_t` | polar_procpool.h:109 | 共享调度器：total_proc 个子进程 + task_nodes 数组 |
| `polar_task_sched_ctl_t` | :146 | dispatcher 控制：task_hash（HTAB，key=BufferTag）+ 每进程环形队列 |
| `parallel_replay_task_node_t` | polar_logindex_redo.h:134 | 任务节点 {task, BufferTag, lsn, prev_lsn, kind} |
| xlog_queue | polar_queue_manager.c | WAL meta 的 send/recv 双端 ring buffer |

## 调用链路

### meta 的产生（RW 侧，WAL 插入路径内）

**入口**：`ReserveXLogInsertLocation`（xlog.c:1262）。backend 在持有 WAL insertion lock 的 spinlock 临界区内，原子地 `pg_atomic_fetch_add_u64(&xlog_queue->pwrite, polar_rbuf_len)` 从 ring buffer 预留 meta 包空间，预留位置记入 `WALInsertLocks[lockno].l.polar_valid_meta_at`（xlog.c:426/1301）——供 `polar_get_min_valid_meta_pos`（xlog.c:11274）计算 readers 的最小安全读取位置，防止读到未写完的槽位。

**填充**：`XLogInsertRecord` 在 CRIT_SECTION 内调用 `polar_xlog_send_queue_push`（polar_queue_manager.c:524，调用点 xlog.c:1095-1105）：

```c
/* polar_queue_manager.c —— meta 包物理布局 */
[end_lsn: XLogRecPtr 8B][xlog_len: uint32 4B][record meta: 变长]
/* 包尾打标志 POLAR_RINGBUF_PKT_WAL_META | POLAR_RINGBUF_PKT_READY */
```

record meta 的内容（`polar_xlog_queue_decode` in polar_queue_manager.c:1013 的解码端印证）：

- `XLogRecord` 完整 header（24B）
- 每个 block reference 的 `DecodedBkpBlock` 元信息：`flags/forknum/has_image/has_data/data_len/rlocator/blkno`——**就是页面地址**（RelFileLocator + fork + block number）
- `polar_xlog_remove_payload`（polar_queue_manager.c:82）决定哪些 rmid 去 payload：HEAP/HEAP2/BTREE/HASH/GIN/GIST/SEQ/SPGIST/BRIN/GENERIC 全部去；RM_XLOG_ID 中 FPI/FPI_FOR_HINT/POLAR_WAL 去
- 但对回放必须用到 main data 的记录（heap insert/delete/update/lock、HEAP2 PRUNE/MULTI_INSERT、btree delete 等），`polar_reserve_data_size` + `polar_xlog_send_queue_push_data`（polar_queue_manager.c:480）会额外把 main_data 以自定义 block id `XLR_BLOCK_ID_POLAR_EXTRA` 附加在 meta 尾部——因为这类记录的 redo 函数需要 main_data 才能定位修改

### 发送端（walsender）

`polar_xlog_send`（walsender.c:5025）：当 `MyWalSnd->to_replica && polar_logindex_redo_instance` 时走 queue 路径，否则退化到 `XLogSendPhysicalExt`。`polar_send_physical_by_queue`（walsender.c:4881）发送 'y' 消息：

```c
/* walsender.c:4949-4986 */
pq_sendbyte(&output_message, 'y');
pq_sendint64(&output_message, flush_ptr);        /* 已 flush 到盘的 LSN 上限 */
pq_sendint64(&output_message, consistentptr);    /* 主库数据页已持久化位置 */
pq_sendint64(&output_message, sendtime);
/* 后接 N 个 {pktlen: uint32, pkt} 对 —— polar_xlog_send_queue_raw_data_pop */
```

关键点：

- 单批大小上限 `polar_send_xlog_meta_size`（默认 1024B，walsender.c:142）
- `polar_xlog_send_queue_raw_data_pop`（polar_queue_manager.c:629）只发 `lsn <= flush_lsn` 的包（`polar_max_sendable_lsn` = 主库 `GetFlushRecPtr`），保证不发送可能因主库崩溃而丢失的 WAL
- **读源是共享内存 ring buffer，不是 WAL 文件**——walsender 完全不读盘
- `polar_xlog_send_queue_check`（polar_queue_manager.c:699）先确认 sentPtr 在 queue 中可寻址，不可寻址（已 eviction）则降级发 'p'

**standby 级联场景**：standby 的 startup 进程每回放一条记录后调 `polar_standby_xlog_send_queue_push`（polar_queue_manager.c:573，调用点 `ApplyWalRecord` in xlogrecovery.c:2256）把 meta 重新塞进自己的 send queue，供下挂 RO 使用。

### RO 侧接收与 LogIndex 写入

```text
walreceiver 'y' 消息 (walreceiver.c:1146-1208)
├─ polar_xlog_recv_queue_push (polar_queue_manager.c:1388)
│  把包逐个 push 进 polar_logindex_redo_instance->xlog_queue
│  （polar_xlog_queue_buffers MB；check_xlog_queue_size (:274) 强制 ≥ 2.5×wal_buffers，
│   防止 WAL writer 换页时覆盖未消费数据）
├─ polar_wakeup_recovery_request() 节流唤醒 startup
└─ polar_set_primary_consistent_lsn() 更新 RO 视角的主库持久化点

startup ReadRecord (xlogrecovery.c:3573)
└─ reachedConsistency && StandbyMode && polar_is_replica()
   → polar_xlog_recv_queue_pop_record (polar_queue_manager.c:1562)
      → polar_xlog_queue_decode (:1013) 手工解析裁剪后的 record
        （解析 block refs，还原 XLR_BLOCK_ID_POLAR_EXTRA main data）
   → ApplyWalRecord (:2335)
      → polar_logindex_parse_xlog (polar_logindex_redo.c:619)
         ├─ rm_polar_idx_save: (BufferTag, lsn, prev_lsn) 写入 wal_logindex_snapshot
         │   ← meta → logindex 记录的转换点
         │   核心宏 POLAR_LOG_INDEX_ADD_LSN → polar_logindex_save_block (redo.c:532)
         ├─ rm_polar_idx_parse: mini-transaction 页锁 + outdate 标记
         └─ 更新 polar_replay_read_recptr（parse 进度，worker 的回放上限）
```

**队列满降级**：收到 'p' 消息（无数据）→ `polar_xlog_recv_queue_push_storage_begin`（polar_queue_manager.c:1374）插入 `POLAR_RINGBUF_PKT_WAL_STORAGE_BEGIN` 标志包并把 `WalRcv->polar_use_xlog_queue` 置 false（表示 primary 改为从文件发送），startup 据此切换回从文件读完整 WAL（walreceiver.c:1063-1074，含 `xlog_queue_catch_up` 平滑切换与对齐校验）；收到 'y' 消息则把该标志置回 true。'K' keepalive 在共享存储模式下也携带 `sentPtr` 与 `polar_get_consistent_lsn()`（`polar_wal_snd_keepalive`，walsender.c:4819）。

**RO 的 reply 回包**：`XLogWalRcvSendReply`（walreceiver.c:1440-1520）在标准 'r' 消息之后，`polar_is_replica()` 时追加两个 int64——`lockPtr`（取 `polar_allow_alr()` 时 `polar_alr_ctl->lsn`，无效或大于 applyPtr 则回退为 applyPtr）和 `bg_replayed_lsn`（取 `polar_get_read_min_lsn(polar_get_primary_consistent_lsn())`，受 `POLAR_UPDATE_BACKEND_LSN_INTERVAL` 限频并用静态变量缓存，避免频繁持 ProcArrayLock）。RW 侧 `ProcessStandbyReplyMessage` 仅当 `MyWalSnd->to_replica` 时才读取这两个字段，`polar_record_replica_lsn`（walsender.c:4767）单调推进 slot 的 `polar_replica_apply_lsn`/`polar_replica_lock_lsn`；`bg_replayed_lsn` 有效时 `polar_confirm_lsn` 取它而非 flushPtr 传给 `PhysicalConfirmReceivedLocation`——**保证后台回放之前的 WAL 不被删除**。

### 并行回放调度（三层并发冲突避免）

```text
dispatcher = logindex bg worker 进程
polar_logindex_bg_dispatch (polar_logindex_redo.c:1872)
├─ LSN 迭代器按全局 LSN 顺序取出 logindex 项
├─ 包装成任务 polar_sched_add_task 分发，每轮最多 ctl->replay_batch_size 个
└─ parallel_replay_task_finished (:2728): 全局 running queue 按 LSN 序，
   只有队头(最小 LSN)任务完成才 polar_advance_bg_replayed_lsn —— LSN 有序推进

worker 执行（polar_sub_task_main in polar_procpool.c）
└─ handle_parallel_replay_task (redo.c:2870) 按 kind 分派
   ├─ POLAR_TASK_REPLAY_BUFFER → handle_replay_buffer (:2803)
   │   pin → 判状态 → polar_bg_redo_apply_read_record (:1260)
   │   （buffer 不在 pool 时 XLogReadBufferExtended 从共享存储读入）
   │   → polar_logindex_apply_one_record 单条应用
   └─ POLAR_TASK_FORGET/CHECK_INVALID_PAGES
       （经 polar_sched_broadcast_task 广播全部 worker）
```

**三层并发冲突避免**：

1. **同 tag 单 worker 串行**：`polar_sched_get_dst_proc`（polar_procpool.c:503）先查 `task_hash`——同 tag 的已有任务链存在时，新任务**固定发给链尾任务所在的同一 worker**，保证同一页面的回放在单进程内按 LSN 串行。无同 tag 任务时 `polar_sched_get_next_proc` 轮转选进程；
2. **依赖链精确唤醒**：同 tag 任务经 `depend_task` SHM_QUEUE 串链（`polar_sched_add_task_hash_table`，procpool.c:563）；前驱未 FINISHED 时新任务置 `POLAR_TASK_NODE_HOLD` 并把前驱的 `next_latch` 指向本 worker 的 latch——前驱完成后精确唤醒；
3. **BufferDesc redo_state 原子标志**：`polar_pin_buffer_for_replay`（redo.c:1341，只 pin buffer pool 已存在的页）+ `polar_buffer_need_replay`（redo.c:1405）检查 `polar_redo_state` 的 `POLAR_REDO_REPLAYING/OUTDATE/READ_IO_END` 标志和 page LSN；正在被他人回放则本任务挂起重试（`handle_replay_buffer` 返回 false → `proc_add_repeat_task`）。

**角色分工**：startup 进程只 parse + 写 logindex + 推进 lastReplayedEndRecPtr，**不重放页面内容**——回放瓶颈被移出主恢复循环；logindex bg worker 兼任 dispatcher + lazy 执行者；parallel replay worker 是 bgworker 池；backend 进程 lazy 模式下读页时就地回放。worker 取任务的优先级顺序（`fetch_waiting_task_node`，polar_procpool.c:434）：**repeat_tasks 列表 → hold_tasks 列表 → 环形队列**；任务处理失败时 `proc_add_repeat_task` 入队头重试，`repeat_delay` 从 `POLAR_TASK_MAX_REPEAT_DELAY_TIMES` 起每轮扫描递减、减到 0 才重新执行。dispatcher 侧 `polar_sched_proc_add_task`（:635）在子进程 ring 满或 RUNNING 态任务累计 ≥ 16 时才 `SetLatch` 唤醒——避免每任务一次唤醒。

## 核心实现

### lazy 回放 vs parallel 回放：三种子模式

GUC 对照（guc_tables.c）：

| GUC | 级别 | 默认 | 控制什么 |
| --- | --- | --- | --- |
| `polar_bg_replay_batch_size` (:3598) | **PGC_SIGHUP 可动态** | 20000 | 每轮循环最多回放的记录数/分发的任务数 |
| `polar_primary_parallel_replay_mode` (:6980) | POSTMASTER | disable | 主库（含崩溃恢复）是否并行回放 |
| `polar_pitr_parallel_replay_mode` (:6991) | POSTMASTER | recovery+instant_recovery | PITR 恢复 |
| `polar_standby_parallel_replay_mode` (:7002) | POSTMASTER | recovery+instant_recovery | standby 回放 |
| `polar_parallel_replay_proc_num` (:3564) | POSTMASTER | 16（0-256） | worker 进程数 |
| `polar_parallel_replay_task_queue_depth` | POSTMASTER | 1024 | 每进程任务队列深度 |

模式枚举（guc_tables.c:561-573）：`recovery`（达一致后并行）/ `instant_recovery`（一致前也并行）/ `async_instant_recovery`（不等回放完成即接受连接）。

三种子模式的区别（**why**）：

1. **RO（replica）= lazy 模式**（`polar_logindex_apply_xlog_background`，redo.c:1078）：bg worker 单进程按 LSN 迭代器遍历 logindex，`polar_only_replay_exists_buffer`（redo.c:1462）**只回放 buffer pool 中已存在的页面**；backend 读到 outdate 页时由 `polar_logindex_require_backend_redo`（redo.c:2590，replica 分支 replay_from = consistent_lsn）→ `polar_logindex_lock_apply_buffer` 就地从 bg_replayed_lsn 回放到最新。**为什么可以 lazy**：数据页在共享存储上始终有（可能旧版本的）持久化副本，页面按需回放即可保证正确性；且 lsn < consistent_lsn 的页可直接 evict 不回放（`polar_xlog_need_replay`，redo.c:2757-2770）；
2. **standby = parallel 模式**：standby 是共享存储上的 RW 候选，必须把所有页面真实回放（buffer 不在 pool 就读进来，走 `XLogReadBufferExtended`），页面会标 dirty 持久化。standby 的 startup 还会重推 meta 给下挂 RO；
3. **PITR / 主库 instant recovery = parallel 模式**：`polar_is_pitr_primary()` / `polar_is_primary()` + 对应 mode 位；`logindex_worker_finish_parallel_replay`（redo.c:2200）在 `bg_replayed_lsn >= last_replayed_end_lsn && backend_min_lsn 无效` 时结束并行回放并 `RequestCheckpoint(CHECKPOINT_FORCE)`。

模式选择：`polar_logindex_wakeup_bg_replay`（redo.c:2556，reachedConsistency 时调用）：`POLAR_PARALLEL_REPLAY_IN_RECOVERY() || IN_INSTANT_RECOVERY()` → 置 `POLAR_BG_PARALLEL_REPLAYING`；否则 `polar_is_replica()` → `POLAR_BG_REPLICA_BUF_REPLAYING`（lazy）。bg worker 主循环 `polar_logindex_bg_worker_main`（polar_logindex_bg_worker.c:228-332）按 `polar_get_bg_redo_state` 状态机分派，还含 `POLAR_BG_ONLINE_PROMOTE`（RO 在线提升期间）。

### instant recovery：主库崩溃恢复不等全量回放

`polar_primary_parallel_replay_mode` 开启后（xlogrecovery.c:1983-1987）：`POLAR_PARALLEL_REPLAY_IN_INSTANT_RECOVERY()` 时在 redo 一开始（**未达 consistency**）就 `polar_logindex_wakeup_bg_replay(instance, redo_start_lsn)` 启动并行回放——主库崩溃恢复不必等全量回放完成即可提供读写服务。async 模式（`POLAR_ENABLE_IN_ASYNC_INSTANT_RECOVERY` 位）完全不等待；非 async 在 `FinishRecovery`（:1667-1671）`polar_wait_logindex_worker_finish_parallel_replay` 等回放追平。

配套的恢复改造（xlogrecovery.c POLAR 段）：

- **:1001-1005**：`polar_logindex_redo_instance` 存在时强制 `InRecovery = true`——启用 logindex 后即使正常 shutdown 也要走 recovery 流程（需要加载/校验 logindex 文件）；
- **:1870-1973**（redo 起点选择）：`polar_logindex_redo_init` 从 `pg_logindex/` 加载 snapshot，返回的 `xlog_read_from` **可能早于 redo_start_lsn**（logindex 是前滚式结构，需从其记录的最老 start lsn 开始重读以重建索引）；
- **promote 流程 :1641-1671**：RO 在线提升 `polar_wait_logindex_worker_handle_promote` + `polar_reset_xlog_source`；WAL buffer 清理 `polar_xlog_buffer_remove_range`（:1687，保证 endOfLog 确认读走真实 I/O）。

### feedback 环与一致性强弱依赖

- **RO 的 reply 携带 `bg_replayed_lsn`**（walreceiver.c:1501-1520，每秒更新 `polar_get_read_min_lsn`），RW 据此约束 checkpoint：`polar_is_checkpoint_legal`（xlog.c:10891）用 RO 回传的 `oldest_apply_lsn` 防止 checkpoint redo 越过最慢 RO；
- **consistent_lsn 的双端语义**：RW 侧由 bgwriter 维护（[03 Buffer 一致性](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency)），随 'y'/'p' 消息发给 RO——RO 对 lsn < consistent_lsn 的页直接判定 BUF_IS_FLUSHED/evict 不回放；
- **queue 大小 ≥ 2.5×wal_buffers**（`check_xlog_queue_size`，queue_manager.c:274）：保证 WAL writer 把 WAL buffer 换页刷盘时，对应的 meta 尚未从 queue 被 eviction，saver/walsender 能完整消费；
- **meta 写入在 CRIT_SECTION 内 + 信号屏蔽**（xlog.c:1091-1094 注释）：防止信号中断打乱 ring buffer 数据。

### 为什么 walsender 读 WAL buffers

`polar_enable_read_from_wal_buffers`（默认 true）只用于 walsender 两处（walsender.c:1283 逻辑复制读页、:3735 发完整 'w' 给 standby/级联）：`WALReadFromBuffers` 命中内存则免读 WAL 文件。**why**：共享存储模式下 WAL 文件在网络盘（PStore/ESSD 云盘）上，回读一次是一趟网络 I/O；standby 复制是常态大流量路径，WAL buffers 中最近写入的部分直接命中可显著降低读放大（配套统计 `polar_stat_walsnd_xlog_read`，walsender.c:5050）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 生产者-消费者 ring buffer | `polar_xlog_send_queue_push/pop`（queue_manager.c:524/629） | meta 生成与消费解耦，walsender 零读盘 |
| tag 亲和调度 | `polar_sched_get_dst_proc`（procpool.c:503） | 同页面任务天然串行，免全局锁 |
| 依赖链精确唤醒 | `polar_sched_add_task_hash_table`（procpool.c:563） | 前驱完成后只唤醒后继，不广播 |
| 状态机 | `polar_get_bg_redo_state` 三态 | lazy/parallel/online-promote 模式切换 |
| 优雅降级 | 'y' → 'p' → 读文件三级 | queue 满/不可寻址时退回文件复制，正确性不受损 |

## 模块间交互

- **依赖 [01 LogIndex 引擎](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex)**：`polar_logindex_parse_xlog` 的 save 回调把 meta 转成 logindex 记录；`parallel_replay_task_node_t` 由 LSN 迭代器产出。xlog_queue ring buffer（polar_queue_manager.c）是两模块的物理交汇点。
- **被 [03 Buffer 一致性](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency) 依赖**：`oldest_apply_lsn`/`consistent_lsn` 的 RW 侧计算依赖回放进度水位（slot 上报）；RO 侧 `MarkBufferDirty` 用 `oldest_replayed_lsn` 入 flush list。
- **依赖 [04 共享存储 VFS](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs)**：worker 读 WAL/数据页走共享存储 I/O 路径。
- **与 [07 进程与运维](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/07-process-ops) 协作**：parallel replay worker 与 logindex saver 都是 postmaster 注册的 bgworker；`polar_async_lock_replay.c` 处理锁的异步回放（锁是并行回放中少数不能按页拆分的对象）。

## 扩展方式

**调整回放 worker 数量策略**的修改点：

| 意图 | 修改点 |
| --- | --- |
| 改 worker 数（需重启） | GUC `polar_parallel_replay_proc_num`（guc_tables.c:3564）。影响链：`polar_logindex_redo_shmem_size`（redo.c:1617）→ `polar_calc_task_sched_shmem_size`（procpool.c）→ `polar_start_proc_pool` 拉起的子 bgworker 数 |
| 运行时调吞吐（SIGHUP） | `polar_bg_replay_batch_size`——但只在 `polar_create_bg_redo_ctl`（redo.c:1033）构建 ctl 时读入，运行中修改需等 bg_redo_state 变化触发 ctl 重建 |
| 动态 worker 数（不重启，需开发） | `polar_logindex_redo_shmem_size`（redo.c:1584）改 max 预留、`polar_start_proc_pool` 支持增量拉起、`polar_sched_get_next_proc` 轮转与 `polar_sched_get_dst_proc`（procpool.c:503）tag 亲和重映射、`parallel_replay_should_exit`（bg_worker.c:139）退出条件。**待核实**：task_hash 中的历史任务归属需要迁移（同 tag 依赖链跨进程会破坏串行语义） |
| 队列深度 | GUC `polar_parallel_replay_task_queue_depth`（默认 1024） |
| lazy 模式吞吐 | `polar_bg_replay_batch_size` + `polar_wait_xlog_meta_timeout`（queue_manager.c:65） |

**新增一种 rmgr 的 meta 处理**：见 [01 LogIndex 引擎](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex) 的"扩展方式"节——三件套 save/parse/redo + rmgrlist.h 注册，本模块的分发表 `polar_idx_redo[]` 自动收录。
