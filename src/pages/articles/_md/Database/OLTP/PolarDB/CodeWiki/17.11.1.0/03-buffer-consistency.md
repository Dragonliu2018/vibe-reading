---
source:
  type: "源码解读"
  project: "polardb-pg"
  url: "https://github.com/polardb/PolarDB-for-PostgreSQL"
title: "Buffer 一致性与刷脏协调"
date: "2026-09-26T23:11:29+08:00"
category: [Database, OLTP, PolarDB, CodeWiki, "17.11.1.0"]
contentType: "CodeWiki"
tags: ["PolarDB", "PostgreSQL", "存算分离", "copy buffer", "flush list", "增量 checkpoint", "bgwriter"]
description: "PolarDB 用四个 LSN（oldest_apply_lsn/oldest_lsn/consistent_lsn/page LSN）织出刷脏安全带：copy buffer 保留旧版本、flush list 物理化一致性下界、增量 checkpoint 把常规 checkpoint 降级为推进 redo 点。"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/00-overview)

---

## 模块定位

存算分离打破了上游 PostgreSQL 的两个隐含假设——**"磁盘页面版本 ≤ WAL 回放进度"** 和 **"checkpoint redo 之后可以任意刷脏"**。共享存储上 RW（primary）与 RO（replica）读的是同一份数据文件，而 RO 的 logindex 回放是 lazy 的（读页面时才回放），于是出现两类病态页面：

- **未来页面（future page）**：RW 把新于 RO 回放进度的页面刷上共享存储，RO 读到后内存状态无法解释；
- **过去页面（past page）**：RO 读到磁盘版本新于自己回放 LSN 的页面，同样不一致。

本模块（`src/backend/storage/buffer/` 的 polar 扩展 + `polar_parallel_bgwriter.c`）负责管住 RW 侧刷脏的每一道闸门，核心思想是**用四个 LSN 织一条"版本演进安全带"**，让任意时刻磁盘上的页面版本对最慢的 RO 都要么"过去"要么"当前"。

## 模块架构

四个 LSN 的语义与定义位置：

| LSN | 定义位置 | 语义 |
| --- | --- | --- |
| `oldest_apply_lsn` | `XLogCtl->oldest_apply_lsn`，`polar_get_oldest_lsn()`（xlog.c:10786） | 所有 RO 的最小回放进度，由 replication slot 上报（`polar_set_oldest_replica_lsn` in slot.c:3121） |
| `oldest_lsn`（buffer 级） | `BufferDesc` 新增字段 | 该 buffer 首次变脏的 LSN，刷盘后 reset 为 invalid |
| `consistent_lsn` | `XLogCtl->consistent_lsn`，`polar_get_consistent_lsn()`（xlog.c:10823） | "共享存储一致性下界" = min(flush list 队头 oldest_lsn, 所有 copy buffer 的 oldest_lsn) |
| page LSN | `PageGetLSN(page)` | 页面当前版本 |

核心不变量：**RW 永不把 page LSN > `oldest_apply_lsn` 的页面写到共享存储**（`polar_buffer_can_be_flushed` 保证），因此磁盘页面版本对最慢的 RO 都安全；而 `consistent_lsn` 是增量 checkpoint 的 redo 点。

组件分工：

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| flush list | `polar_flush.c` | 按 oldest_lsn 升序的脏页双向链表，队头即一致性下界 |
| copy buffer 池 | `polar_copybuf.c` | 刷不动时的旧版本外移池 |
| 并行 bgwriter | `polar_parallel_bgwriter.c` | 多 worker 消费 flush list，动态扩缩容 |
| polar_bufmgr | `polar_bufmgr.c` | consistent_lsn 计算、刷脏决策、增量 checkpoint 判定 |
| WAL 读页缓存 | `polar_xlogbuf.c` | LSN 环形直接映射的 WAL 页缓存 |

## 调用链路

刷脏的**决策链末端**在 `SyncOneBuffer`（bufmgr.c:3747 起重写，返回值新增 `BUF_SKIP`），四分支顺序：

```text
SyncOneBuffer(buf)                       # bufmgr.c:3747
├─ ① polar_buffer_can_be_flushed(buf, oldest_apply_lsn, false)
│     → 直刷原 buffer（FlushBuffer 内顺带 free copy buffer）
├─ ② 不能直刷但 polar_buffer_need_fullpage_snapshot()
│     → 刷之前先写 fullpage WAL 镜像再刷（shutdown 场景）
├─ ③ 有 copy buffer 且 polar_buffer_can_be_flushed(buf, lsn, use_cbuf=true)
│     → polar_flush_copy_buffer() 刷 copy buffer 里的旧版本
└─ ④ 都不行且 polar_buffer_copy_is_satisfied()
      → polar_buffer_copy_if_needed() 此刻把当前版本 memcpy 进 copy 池
```

`polar_buffer_can_be_flushed()`（polar_bufmgr.c:171）是总闸门，直刷放行条件：非共享存储 / 无 RO（`oldest_apply_lsn` invalid）/ `BufferGetLSN(buf) <= oldest_apply_lsn` / FSM、INIT fork 等。`use_cbuf=true` 时检查 copy buffer 的页 LSN ≤ `oldest_apply_lsn` 才能刷 copy 版本。

`copy_buffer_alloc()`（polar_copybuf.c:256）的复制流程：`polar_start_buffer_io_extend(buf, true, false, true)`（复用 `BM_IO_IN_PROGRESS` 防并发，幂等——已有 copy_buffer 直接返回 false）→ double check 满足条件 → 从 freelist 摘 cbuf（池满限流 WARNING + 计 `full_count`）→ `memcpy` 复制当前内存版本（一个中间版本）→ `cbuf->oldest_lsn = buf->oldest_lsn`、`cbuf->origin_buffer = buf` → 挂到 `buf->copy_buffer`。

数据结构流转：`BufferDesc`（源）→ `memcpy` → `CopyBufferDesc`（`tag`/`buf_id`/`free_next`/`oldest_lsn`/`origin_buffer`/`pass_count`/`is_flushed`）→ `polar_flush_copy_buffer()` 里 `XLogFlush` + `smgrwrite` 落盘（置 `is_flushed`）→ `polar_free_copy_buffer()` 归还 freelist。**原 buffer 保持脏**（`TerminateBufferIO(buf, false, 0, true)` 不清 `BM_DIRTY`），其内存版本比刚落盘的 copy 版本新，继续正常演进。

copy 后的生命周期闭环：

```text
copy 时刻: cbuf->oldest_lsn 保留旧值 ──参与──> polar_cal_cur_consistent_lsn 的 min 计算
首次再脏: polar_set_buffer_fake_oldest_lsn()          # polar_bufmgr.c:872
          检测 polar_buffer_first_touch_after_copy
          → polar_adjust_position_in_flush_list()      # polar_flush.c:303
            设 fake oldest_lsn 挪到 flush list 队尾
          —— 一致性义务已转移给 cbuf
消费时刻: polar_sync_buffer_from_copy_buffer()          # polar_bufmgr.c:927
          遍历 copy 池对每个 origin buffer 调 SyncOneBuffer
          能刷原的刷原的（顺带 free copy），否则刷 copy
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `polar_buffer_can_be_flushed` (polar_bufmgr.c:171) | 刷脏总闸门 | 无 RO/非共享存储时放行，保留单机行为 |
| `polar_cal_cur_consistent_lsn` (polar_bufmgr.c:131) | min(flush list 队头, copy 池最小) | O(1) 读队头靠 flush list 升序不变量 |
| `polar_buffer_copy_is_satisfied` (polar_copybuf.c:186) | 判定"值不值得 copy" | lag + modified_count 双维度 |
| `copy_buffer_alloc` (polar_copybuf.c:256) | 执行复制 | 复用 IO_IN_PROGRESS 幂等 |
| `polar_flush_copy_buffer` (polar_copybuf.c:403) | 刷 copy 版本 | XLogFlush 先于数据落盘 |
| `polar_put_buffer_to_flush_list` (polar_flush.c:219) | 首脏入表 | 违序直接 PANIC 保不变量 |
| `polar_get_batch_buffer` (polar_flush.c:134) | 游标批量取页 | 刷完才移除，游标回卷 |
| `polar_buffer_sync` (polar_bufmgr.c:488) | bgwriter 核心循环 | lag 流控决定刷页数 |
| `evaluate_sync_buffer_num` (polar_bufmgr.c:679) | 按 lag 估算本轮页数 | 用上轮 sync_per_lsn 比例外推 |
| `polar_adjust_parallel_bgwriters` (polar_bufmgr.c:712) | 动态调 worker 数 | 缩容慢 10 倍防抖动 |
| `polar_check_incremental_checkpoint` (polar_bufmgr.c:1016) | 增量 checkpoint 判定 | redo = consistent_lsn |
| `polar_is_future_page` (polar_bufmgr.c:1125) | 未来页判定 | 未开 fullpage 直接 FATAL |
| `polar_xlog_buffer_lookup/append` (polar_xlogbuf.c) | WAL 页缓存 | LSN 直接映射无哈希 |

</details>

## 核心实现

### 四 LSN 安全带与 consistent_lsn 计算

`polar_cal_cur_consistent_lsn()`（polar_bufmgr.c:131）由 bgwriter 周期调用：flush list 为空时按状态取回放进度下界——并行回放态取 `polar_get_oldest_replayed_lsn()`，否则取 `polar_max_valid_lsn()`；非空时取队头的 `oldest_lsn`；最后与 copy 池最小值（`polar_copy_buffers_get_oldest_lsn`，polar_copybuf.c:512 扫全池）做 Min 写入 `XLogCtl->consistent_lsn`。它同时是增量 checkpoint 的 redo 点和"最老未落盘脏页"的物理化。

`oldest_apply_lsn` 由 replication slot 上报（`polar_set_oldest_replica_lsn` in slot.c:3121）——slot 既挡 WAL 回收又挡刷脏，一个机制两用。

### copy buffer：两个 GUC 阈值的组合判定

`polar_buffer_copy_is_satisfied()`（polar_copybuf.c:186）的判定式：

```c
/* src/backend/storage/buffer/polar_copybuf.c:245-250 */
if ((buf->recently_modified_count > polar_buffer_copy_min_modified_count &&
     lsn_lag_with_cons_lsn < polar_buffer_copy_threshold_lag * 1024 * 1024) ||
    lsn_lag_with_cons_lsn < polar_buffer_copy_threshold_lag * 1024 * 1024 / 2)
    return true;
```

- `polar_buffer_copy_threshold_lag`（默认 100MB，PGC_SIGHUP）：buffer 的 `oldest_lsn` 距 `consistent_lsn` 的 lag 上限。lag 小说明它很快轮到 flush list 队头，没必要 copy；lag 大说明它离可刷还很远（RO 太慢或它是队头阻塞者），必须 copy 解卡。
- `polar_buffer_copy_min_modified_count`（默认 5）：hot page 判定。修改次数 > 5 且 lag < 100MB 才 copy（热页会持续演进，每次修改都扩大"不可刷窗口"）；但 lag < 50MB（阈值一半）时无条件 copy。

为什么两个维度：单纯 lag 阈值会把"冷而新"的页面也 copy（浪费池子）；单纯次数阈值会漏掉"队头卡死但没人再改"的页面。组合实现"该等的等、该复制的复制"。池大小 GUC `polar_copy_buffers`（默认 16384 blocks = 128MB，PGC_POSTMASTER，0 = 禁用）。

### flush list：一致性下界的物理化

上游 bgwriter 靠 clock-sweep 扫全池找脏页，无序且无法回答"最老的未落盘脏页是谁"。PolarDB 在 `BufferDesc` 上增加 `flush_prev/flush_next`，维护**按 oldest_lsn 升序的双向链表**（`FlushControl`，polar_flush.h:69）：

- 首脏入表 `polar_put_buffer_to_flush_list()`（polar_flush.c:219）：lsn 无效时设 fake（`polar_fake_oldest_lsn`：并行回放用 `oldest_replayed_lsn`，否则 `GetXLogInsertRecPtr()`，保证升序不变量，`append_one_buffer` 违序直接 PANIC）；
- hint bit 场景 `polar_put_dirty_hint_buffer_into_flushlist()`（polar_flush.c:256）：调用方可能只持共享锁，spinlock + double check 保证幂等；
- 批量取页 `polar_get_batch_buffer()`（polar_flush.c:134）：从 `current_pos` 游标批量取 `polar_bgwriter_flush_batch_size`（默认 100）个 id **不移除**（FlushBuffer 刷完才移除）；两种条件下游标回退到 `first_flush_buffer` 且 `latest_flush_count` 清零——走完整个列表，或单轮累计超过 `polar_bgwriter_batch_size`（5000）。

为什么值得：队头永远是最老脏页，consistent_lsn 只需 O(1) 读队头 + 扫 copy 池。

### 并行 bgwriter 与任务分发

结构 `ParallelBgwriterInfo`（polar_parallel_bgwriter.h:67）：48 个 slot（`MAX_NUM_OF_PARALLEL_BGWRITER`，utils/guc.h:277）的 handle/latch/state/task、`flush_task` 环形队列（dispatcher 用）、`flush_workers[]` 每类任务在跑计数。

- `polar_launch_parallel_bgwriter_workers()`（polar_parallel_bgwriter.c:142）：拉起 `polar_parallel_flush_workers`（默认 10，上限 24）个 dynamic bgworker（`BGW_NEVER_RESTART`）。**`polar_enable_early_launch_parallel_bgwriter`（默认 true）**：primary in recovery（在线 promote 期间）也提前拉起——不开则要等 recovery 结束，期间 flush list 无人消费、consistent_lsn 卡住拖慢恢复。
- **`polar_enable_flush_dispatcher`（默认 true，SIGHUP）**：normal bgwriter（bgwriter.c 的 `polar_flush_generate_task`，约 :474）按 lag 与 LRU 超前圈数决定往环形队列塞多少 FLUSHLIST/FLUSHLRU 任务；idle worker 数作为总量约束。dispatcher 关闭时多 worker 抢 flushlist_lock 会严重锁竞争（worker 主循环注释明说），故靠 hibernate 降频（睡 50 倍 `polar_parallel_bgwriter_delay`）。
- **`polar_enable_dynamic_parallel_bgwriter`（默认 true，SIGHUP）**：`polar_adjust_parallel_bgwriters()`（polar_bufmgr.c:712）——lag > `polar_parallel_new_bgwriter_threshold_lag`（1024MB）持续 10s 则加 1 个 worker；但先过 `polar_new_parallel_bgwriter_useful()`（polar_parallel_bgwriter.c:598）检查：新增 worker 后 flush rate 增幅 < `polar_new_bgwriter_flush_factor`（100 页/s）说明 IO 已饱和，不再加。缩容慢 10 倍（100s）防抖动。

**LRU writer（FLUSHLRU_TASK）**：`polar_lru_sync_buffer()`（polar_bufmgr.c:306）以 `StrategySyncStart`（clock sweep 位置）为起点向后扫，共享游标 `lru_buffer_id/lru_complete_passes`（`lru_lock` 保护）分批，`SyncOneBuffer(skip_recently_used=true)`。

### 刷脏流控：追 RO 进度而不是盲目猛刷

`polar_buffer_sync()`（polar_bufmgr.c:488）核心循环：

1. 算 lag（`polar_consistent_lsn_lag`：`oldest_apply_lsn - consistent_lsn`）；
2. `evaluate_sync_buffer_num()`（polar_bufmgr.c:679）流控：用上一轮的 `sync_per_lsn`（每推进 1 字节 consistent_lsn 平均刷多少页）按 lag 估算本轮刷页数——lag 超上限就满速 5000 页/轮，否则按比例；
3. 开 dispatcher 时，**抢到 `polar_flush_ctl->cbuflock`（LWTRANCHE_POLAR_COPY_BUFFER）的 worker** 独占执行 `polar_sync_buffer_from_copy_buffer`，避免多 worker 并发处理 copy 池；
4. 返回 `lag < polar_bgwriter_sleep_lsn_lag`（100MB）决定 hibernate。

### 增量 checkpoint：常规 checkpoint 降级为"推进 redo 点"

`polar_enable_incremental_checkpoint`（默认 true，SIGHUP）。使能条件（polar_bufmgr.h:37-41）：

```c
polar_incremental_checkpoint_is_allowed() ==
    polar_flush_list_enabled() && polar_enable_incremental_checkpoint && (!fullPageWrites)
```

为什么要求关闭 fullPageWrites：上游 FPI 机制依赖"checkpoint 后第一次修改该页才写 FPI"的假设，而增量 checkpoint 的 redo 点（= consistent_lsn）不是 WAL 一致点，FPI 假设被破坏。PolarDB 用 PolarFS 原子写 + fullpage snapshot（`polar_log_fullpage_snapshot_image`）替代 FPI 的 torn-write 防护。

`polar_check_incremental_checkpoint()`（polar_bufmgr.c:1016，由 `xlog.c:7678` 的 CreateCheckPoint 调用）：

- **增量 checkpoint 的 redo lsn = consistent_lsn**（不是当前 insert 位置）。为什么：consistent_lsn 保证"从该点起按 logindex 回放可把任意磁盘页面修正到一致状态"——因为 RW 从不刷 LSN 超前于 oldest_apply_lsn 的页，且 fullpage snapshot 兜底 future page，磁盘页面可以是任意中间版本，恢复不依赖"redo 点之前数据全落盘"；
- checkpoint 侧消费（bufmgr.c BufferSync ~3108）：`polar_buffer_can_be_flushed_by_checkpoint()`（polar_bufmgr.c:217）——**增量 checkpoint 只刷 FSM/INIT fork**（bgwriter 不处理的），其余脏页全权交给 flush list；
- 效果：常规 checkpoint 从"刷全部脏页的重量级操作"退化为"推进 redo 点 + 更新 control file"。

**`polar_checkpoint_ringbuf`**（`src/backend/access/logindex/polar_checkpoint_ringbuf.c`，201 行）：不是拆分 checkpoint，而是 **standby 并行回放时重启点的缓冲**——并行回放乱序执行，`bg_replayed_lsn` 落后于 `lastCheckPoint`。`polar_checkpoint_ringbuf_check()`（xlog.c:8511，仅 `POLAR_BG_PARALLEL_REPLAYING` 时启用）：

- `polar_checkpoint_ringbuf_push`：每个回放到的 checkpoint 入环——与尾部元素比较 `redo` 和 `lsn` 两个字段，redo 非严格递增则拒绝入环（LOG 跳过）；环满（默认 1024）时 evict **最后插入的那个** checkpoint 并递增 `evict_count`；
- `polar_checkpoint_ringbuf_pop`：以 `polar_get_bg_replayed_lsn()` 为界，从队头连续弹出所有 `redo <= bg_replayed_lsn` 的 checkpoint，返回**最后一个被弹出的**（即 redo 最大且不超过回放完成度的那个）。

为什么：增量 checkpoint 高频产生，restartpoint 若直接取 lastCheckPoint，其 redo 可能超前于实际回放完成位置，导致重启后从错误位置恢复。

### bufmgr.c 的关键 POLAR 改造点

7648 行 vs 上游 6204 行（+~1450 行改造），按行号：

| 位置 | 改造 | 作用 |
| --- | --- | --- |
| 2138-2168 | `BufferAlloc` victim 刷脏控制 | 不能刷的 victim 不能 evict（否则把 future 版本挤到盘上），`goto again` 重选 + `CHECK_FOR_INTERRUPTS` 防全池不可刷时查询无法取消 |
| 1829-1853 | `InvalidateVictimBuffer`/`InvalidateBuffer` | buffer 复用时清 `polar_flags`、redo state flag、`polar_free_copy_buffer` + `polar_reset_buffer_oldest_lsn`，防止脏状态泄漏到新页面 |
| 2676-2730 | `MarkBufferDirty` → `PolarMarkBufferDirty(buffer, oldest_lsn)` | primary 设 fake oldest_lsn 入 flush list；replica/standby 用真实回放 lsn |
| 3667-3814 | `SyncOneBuffer` 重写 | 四分支 flush 决策链（本节开头）；`BUF_SKIP` 让批量循环不阻塞 |
| 4199-4470 | `FlushBuffer` 大改 | 签名加 `oldest_apply_lsn` + flags（`FLUSH_NOWAIT`/`FLUSH_NOFPW`/`FLUSH_COMBINE`）；write combine（连续脏页合并进 `merge_buffer`，`polar_smgrbulkwrite` 一次写 `polar_write_combine_limit` 页）；future page 刷前写 fullpage snapshot |
| 5248-5681 | `FlushRelationBuffers` 系列 | `LockBuffer` 改用会回放的扩展版；vacuum full/rewrite 绕过 flush 控制（调用方持 AccessExclusiveLock，DDL 同步保证 RO 不会访问该表） |
| 5757-5832 | `MarkBufferDirtyHint` | hint 产生的脏必须进 flush list 参与 consistent_lsn；宁可丢 hint bit 也不产生不一致（注释详述 FlushBuffer copy 内容与 hint 设置的竞态） |
| 5967-6148 | **`polar_lock_buffer_ext`** | **RO 的 lazy replay 入口**：任何加锁都可能触发回放——锁前查 `POLAR_REDO_OUTDATE`（页面有未回放日志）→ 升级排他锁做 `polar_logindex_lock_apply_buffer` 回放 → 降回目标模式 |
| 7500-7640 | `polar_handle_read_error_block` | partial write 重读 / 从 checkpoint redo 回放修复 invalid page；backend redo 三函数（`polar_init_backend_redo`/`polar_prepare_backend_redo`/`polar_exec_backend_redo`，:289-296 声明） |

### polar_xlogbuf.c：WAL 读页缓存（LSN 直接映射）

不是 WAL 写 buffer，而是 **WAL 段页的读缓存**。RO/standby/在线 promote 场景中 startup 进程、logindex worker、parallel replayer、backend（lazy replay）会反复读同一 WAL 页（polar_xlogbuf.h:45-58 注释枚举三种启用场景）。

- GUC：`polar_xlog_page_buffers`（MB，默认 0 即关闭，PGC_POSTMASTER）；
- 结构：**LSN 环形直接映射**——`buf_id = (lsn / XLOG_BLCKSZ) % total_count`（polar_xlogbuf.h:65），每 slot 一个 `polar_xlog_buffer_desc`（start_lsn/end_lsn）+ 独立 LWLock，**无链表无哈希**；
- `polar_xlog_buffer_append()`：盘读完页后先以共享锁判断能否入缓存，不满足则升级为独占锁并**重新检查一遍**（防 TOCTOU——共享锁判断与升级之间别的进程可能已写入该 slot）；evict 策略是"保留新页"（请求页比缓存页新才 evict）——旧 WAL 页读一次就不再读；
- `polar_xlog_buffer_update()`：遇到非法记录截断 `end_lsn`——**只能缩小不能扩大**（生效前提：请求范围覆盖 `start_lsn` 且原 `end_lsn` 大于新值），流复制中断后 twophase 读场景的保护；`polar_xlog_buffer_remove()` 在请求范围完全覆盖 `[start_lsn, end_lsn)` 时才清空两个 LSN；
- 统计 hit/io，每 16GB 页查询打一条 LOG。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 双向链表 + 不变量 PANIC | `append_one_buffer` (polar_flush.c) | 升序不变量比防御性排序更可靠，违序说明设计前提被破坏 |
| 生产者-消费者解耦 | copy buffer 池 vs flush list | 用小缓冲区吸收"RW 写入速率"和"RO 回放速率"的不匹配，而不是阻塞生产者 |
| dispatcher + 环形任务队列 | `polar_flush_generate_task` (bgwriter.c:474) | 把"决定刷多少"与"实际刷"分离，多 worker 无锁竞争 |
| 反馈式流控 | `evaluate_sync_buffer_num` (polar_bufmgr.c:679) | 用上一轮 sync_per_lsn 比例外推，避免盲目满速刷 |
| 幂等复制 | `polar_start_buffer_io_extend` 的 cbuf 分支 (bufmgr.c:6504) | 复用 IO_IN_PROGRESS 语义防并发重复 copy |

## 模块间交互

- **依赖 [01 LogIndex 引擎](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex)**：future page 的恢复走 `polar_logindex_restore_fullpage_snapshot_if_needed()`（polar_logindex_redo.c:3277）；`polar_lock_buffer_ext` 的 lazy replay 调 `polar_logindex_lock_apply_buffer`；fake oldest_lsn 在并行回放时取 `oldest_replayed_lsn`（回放侧进度）。
- **被 [02 WAL 元数据复制与并行回放](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/02-wal-meta-replay) 依赖**：`oldest_apply_lsn` 来自 slot 上报；replica 侧 `MarkBufferDirty` 用回放 LSN 入 flush list；checkpoint ringbuf 服务并行回放的重启点。
- **依赖 [04 共享存储 VFS](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs)**：write combine 的 `polar_smgrbulkwrite` 走 VFS 批量写；fullpage snapshot WAL 落共享存储。
- **与 [06 TDE](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/06-tde) 协作**：copy buffer 刷盘路径 `polar_copybuf.c:488` 调 `PageSetChecksumInplace`（其内含 `PageEncryptInplace`），加密与 checksum 对 copy 版本同样生效。

## 扩展方式

**调整 copy buffer 策略**的修改点：

| 意图 | 修改点 |
| --- | --- |
| 池大小 | GUC `polar_copy_buffers`（guc_tables.c，POSTMASTER 需重启），自动影响 `polar_copy_buffer_shmem_size()`/`polar_init_copy_buffer_pool()`（polar_copybuf.c:145/52），无需改代码 |
| copy 触发条件 | `polar_buffer_copy_is_satisfied()`（polar_copybuf.c:186）的判定式；对应 GUC `polar_buffer_copy_threshold_lag`/`polar_buffer_copy_min_modified_count`（SIGHUP 免重启） |
| fork 排除规则 | 同函数开头的排除列表（FSM/INIT/VM，polar_copybuf.c:198-206） |
| copy 消费时机 | `polar_sync_buffer_from_copy_buffer()`（polar_bufmgr.c:927）、cbuflock 竞争规则（polar_bufmgr.c:536-545） |
| 刷脏流控节奏 | `evaluate_sync_buffer_num()`（polar_bufmgr.c:679）、`polar_get_batch_buffer` 的游标回卷规则（polar_flush.c:170-180） |
| fullpage snapshot 兜底阈值 | `polar_buffer_need_fullpage_snapshot()`（polar_bufmgr.c:1147） |

**修改 hint bit 处理**时参照 `MarkBufferDirtyHint`（bufmgr.c:5757-5832）的注释——hint 脏页入 flush list 的竞态分析是该函数最核心的设计文档。
