---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "复制"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "replication", "流复制", "逻辑复制", "复制槽", "syncrep"]
description: "PostgreSQL replication 模块——物理流复制 walsender/walreceiver、同步复制队列、复制槽 WAL 保留、逻辑解码 ReorderBuffer"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`src/backend/replication/` 是高可用基础子系统。① **物理流复制**——主库 walsender 把 WAL 流发给备库 walreceiver，块级一致复制；② **逻辑复制**——基于 WAL 解码成行级逻辑变更（publication/subscription），跨版本/跨平台；③ **同步复制**（syncrep）保证主库提交前备库已收到；④ **复制槽**防备库落后时 WAL 被回收。这一层独立存在，因复制是横切关注点——它依赖 access/transam 的 WAL，但不侵入查询处理路径。

---

## 模块架构

物理复制：`walsender.c`（4656 行，主库发送）、`walreceiver.c`（1643 行，备库接收）、`syncrep.c`（1147 行，同步等待）、`slot.c`（3295 行，复制槽）、`basebackup.c`（基础备份）。逻辑复制：`logical/worker.c`（6488 行，apply worker）、`reorderbuffer.c`（5677 行，重排序）、`decode.c`（WAL 解码）、`origin.c`（复制 origin）、`slotsync.c`（槽同步）。

---

## 调用链路

物理流复制的主备数据流：

```
PRIMARY                                 STANDBY
backend INSERT → WAL Buffer             startup process (replay)
  → pg_wal (fsync)                        ▲
  │                                       │
[walsender.c] WalSndLoop()                │ [walreceiver.c] WalReceiverMain()
  → XLogSendPhysical()                    │   → walrcv_receive()
    → GetFlushRecPtr() (只发已 fsync)      │   → XLogWalRcvProcessMsg()
    → WALRead → COPY protocol ─────────────┼──→ XLogWalRcvWrite → pg_pwrite → pg_wal
  ← ProcessRepliesIfAny() (ACK)            │   → XLogWalRcvFlush → fsync → flushedUpto
  ← SyncRepReleaseWaiters() (唤醒等待者)    │   → XLogWalRcvSendReply (ACK write/flush/apply)
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `InitWalSender` | walsender 初始化 | 标记 postmaster child 为 walsender |
| `WalSndLoop` | walsender 主循环 | 只发已 fsync 的 WAL |
| `XLogSendPhysical` | 读 WAL 发送 | COPY 协议 128KB 批次 |
| `WalReceiverMain` | walreceiver 主循环 | 动态加载 libpq 层 |
| `SyncRepWaitForLSN` | 同步复制等待 | LSN 有序队列 |
| `ReplicationSlotCreate` | 创建复制槽 | 共享内存 + 磁盘持久化 |
| `LogicalDecodingProcessRecord` | 逻辑解码 | rmgr rm_decode 分发 |

---

## 核心实现

### 物理流复制

**walsender 进程**：postmaster fork backend → 握手认证检测 replication 参数 → `InitWalSender`（`walsender.c:297`）分配 `WalSnd` 槽位 + `MarkPostmasterChildWalSender`（让 postmaster 在 shutdown 序列把 walsender 当辅助进程，活到 shutdown checkpoint 后发最后 WAL）。`StartReplication`（L860）创建 `XLogReader`、可选获取复制槽、确定发送起点 → `WalSndLoop(XLogSendPhysical)`。

**WalSndLoop**（`walsender.c:2828`）主循环：`ProcessRepliesIfAny`（处理备库 ACK）→ `send_data`（=`XLogSendPhysical`）→ `pq_flush_if_writable` → 检查 caught up/keepalive/timeout → 阻塞等待。`XLogSendPhysical`（L3362）只发已 fsync 的 WAL（`GetFlushRecPtr`）——防主库崩溃时备库 apply 丢失的 WAL，COPY 协议 128KB 批次。

**walreceiver 进程**：startup process 在 archive 恢复到末尾 → 填 `WalRcvData` → 信号 postmaster → fork walreceiver → `WalReceiverMain`（`walreceiver.c:159`）。动态加载 `libpqwalreceiver`（避免主二进制依赖 libpq）→ `walrcv_connect` 连主库 → `walrcv_startstreaming` → 接收循环：`walrcv_receive` → `XLogWalRcvProcessMsg` → `XLogWalRcvWrite`（`pg_pwrite` 写 pg_wal）→ `XLogWalRcvFlush`（fsync + 更新 `flushedUpto` + 唤醒 startup replay）→ 周期 `XLogWalRcvSendReply`（ACK write/flush/apply LSN）+ `XLogWalRcvSendHSFeedback`（热备反馈）。

### 同步复制（syncrep）

`synchronous_commit` GUC 级别：`off`（不等）、`local`（仅本地 flush）、`remote_write`（等备库 write 到 OS）、`remote_flush`（等备库 fsync）、`on`/`remote_apply`（等备库 apply）。`assign_synchronous_commit`（`syncrep.c:1124`）映射到 `SyncRepWaitMode`。

提交时 `SyncRepWaitForLSN`（`syncrep.c:148`，在 xact.c commit 路径）：若 `!SyncRepRequested()` 或无同步备库名直接返回；否则检查 `lsn <= WalSndCtl->lsn[mode]` 已 ACK 则返回；加入按 LSN 排序的等待队列 → latch 等待循环（不能真 abort 因事务已 commit）。

walsender 收 ACK（`ProcessStandbyReplyMessage`）→ 更新 `MyWalSnd->write/flush/apply` → `SyncRepReleaseWaiters`（`syncrep.c:474`）→ `SyncRepGetSyncRecPtr` 算同步备库集合位置 → `SyncRepWakeQueue`（L914）遍历有序队列唤醒 `waitLSN <= 确认 LSN` 的 backend（遇更大 LSN 即停，O(被唤醒数)）。三种等待模式各独立队列。`synchronous_standby_names` 支持 FIRST（优先级）/ANY（仲裁）双模式。

### 复制槽

**为什么需要**：备库断连时主库不知该保留多少 WAL，checkpoint 会回收旧 WAL 段，备库重连后所需 WAL 可能已删。复制槽记 `restart_lsn`（最旧需要的 WAL）+ `xmin`/`catalog_xmin`（vacuum 不能清理的最旧事务），让主库回收时考虑。

`ReplicationSlotCreate`（`slot.c:353`）：共享内存找空槽 → 初始化 → `ReplicationSlotReserveWal`（L1709，物理槽从 redo 点、逻辑槽从当前插入点）→ `CreateSlotOnDisk`（持久化到 `pg_replslot/<name>/state`）。

**为什么不用 catalog 存储**（`slot.c` NOTES）：复制槽需在备库创建（级联复制场景），但备库 catalog 只读，故用独立文件存储。复制槽同时管 WAL 保留和 vacuum horizon——逻辑槽的 `effective_xmin` 与 `data.xmin` 分离（逻辑解码对数据丢失更敏感，会产出错误结果；物理最坏只是备库查询被取消）。

三种持久性：`RS_PERSISTENT`（永久存盘）、`RS_TEMPORARY`（重启消失）、`RS_EPHEMERAL`（释放即删）。`ReplicationSlotsComputeRequiredLSN`（L1306）遍历活跃槽取最小 `restart_lsn`，checkpointer 据此决定哪些 WAL 段可删。

### 逻辑复制

**Publication/Subscription 模型**：主库 Publication（`pg_publication`/`pg_publication_rel` 定义发布表），订阅端 Subscription（`pg_subscription`），每个 subscription 启动一个 apply worker（logical launcher 管理）。

**WAL 解码**：物理 WAL record 是块级操作日志，逻辑复制需重组成行级变更。`LogicalDecodingProcessRecord`（`decode.c:88`）为每条 WAL record 构造 `XLogRecordBuffer`，按 `xl_rmid` 分发到 rmgr 的 `rm_decode`（如 `heap_decode`/`xact_decode`），转成 `ReorderBufferChange` 入队。

**ReorderBuffer 重排序**（`reorderbuffer.c`）：`ReorderBufferQueueChange`（L811）把 change 按序追加到事务的 changes 链表，`ReorderBufferCheckMemoryLimit` 内存超限溢出磁盘（`ReorderBufferSerializeTXN`，防大事务 OOM）。提交时 `ReorderBufferCommit`（L2893）→ `ReorderBufferReplay` 调 begin/apply_change/commit 回调链——按事务提交顺序输出（而非 WAL 写入顺序），这是需要 ReorderBuffer 缓冲重排序的根本原因。

**Apply Worker**（`worker.c`）：`run_apply_worker`（L5697）读 `pg_subscription` → 设复制 origin → `walrcv_connect` 连发布者 → `walrcv_startstreaming` → `LogicalRepApplyLoop`（L4004）接收循环：按消息类型分发 `apply_handle_begin`→`apply_handle_insert`/`update`/`delete`→`apply_handle_commit`，在订阅端执行实际 SQL。

### 关键数据结构

- **WalSnd**（`walsender_private.h:41`）：每 walsender 一个，含 `pid`/`state`/`sentPtr`/`write`/`flush`/`apply`（备库 ACK 的 LSN）/`sync_standby_priority`。`WalSndCtlData` 含 3 个 `SyncRepQueue`（write/flush/apply）+ `lsn[]`。
- **WalRcvData**（`walreceiver.h:58`）：全局唯一，含 `walRcvState`/`receiveStart`/`flushedUpto`/`conninfo`/`slotname`。
- **ReplicationSlot**（`slot.h:180`）：共享内存 + 磁盘，含 `active_proc`/`effective_xmin`/`effective_catalog_xmin`/`data`（`ReplicationSlotPersistentData` 含 `restart_lsn`/`xmin`/`confirmed_flush`/`plugin`）。
- **ReorderBuffer**（`reorderbuffer.h:574`）：`by_txn`（xid→txn 哈希）+ `toplevel_by_lsn`（顶层事务按 LSN 排序）+ 回调函数集。
- **LogicalDecodingContext**（`logical.h:33`）：含 `slot`/`reader`/`reorder`/`snapshot_builder`/`callbacks`（output plugin 回调）。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 块级流（物理）vs 解码（逻辑） | `XLogSendPhysical` vs `LogicalDecodingProcessRecord` | 物理零解析开销但要求同架构；逻辑需重组但跨版本 |
| LSN 有序队列 | `SyncRepQueue` | 利用单调性 O(被唤醒数)，避免 O(n) 遍历 |
| WAL 保留 + vacuum horizon | 复制槽 `restart_lsn`/`xmin` | 同时管 WAL 回收和 dead tuple 清理 |
| 动态加载传输层 | `load_file("libpqwalreceiver")` | 主二进制不依赖 libpq 客户端库 |
| 内存溢出磁盘 | `ReorderBufferCheckMemoryLimit` | 大逻辑事务不 OOM |

### 物理复制用 WAL 流，逻辑复制要解码

物理流复制直接发 WAL record 字节流，备库直接写本地 WAL 再 redo——块级一致、零解析开销，但要求同版本同架构。逻辑复制需行级语义（INSERT/UPDATE/DELETE），需将物理 WAL record 重组为逻辑变更，且必须按事务提交顺序输出（而非 WAL 写入顺序），所以需 ReorderBuffer 缓冲重排序。

### 复制槽设计

存共享内存 + 磁盘文件（不存 catalog），因备库也需创建复制槽（级联复制），但备库 catalog 只读。逻辑槽 `effective_xmin` 与 `data.xmin` 分离——逻辑解码对数据丢失更敏感（产出错误结果）。

### 核心设计哲学

**所有复杂逻辑集中在主库端**：同步复制等待、WAL 保留决策、逻辑解码全在主库；备库端保持简单（接收→写盘→replay→发 ACK），降低备库实现复杂度。

---

## 模块间交互

replication 依赖 `access/transam`（`GetFlushRecPtr`/`XLogReaderAllocate`/`WALRead`/`XLogFileInit`/`pg_pwrite`）、`postmaster`（fork walsender/walreceiver，`MarkPostmasterChildWalSender`）、`storage`（`WalSndCtl`/`WalRcv`/`ReplicationSlotCtl` 共享内存 + LWLock + PGPROC `syncRepLinks`/`syncRepState`/`waitLSN`）、`catalog`（`pg_replication_slots`/`pg_subscription`/`pg_publication` 视图驱动）。syncrep 的等待队列存 `WalSndCtl`，walsender 的 `ProcessStandbyReplyMessage`→`SyncRepReleaseWaiters` 唤醒。

---

## 扩展方式

**新增同步复制级别**：`syncrep.h` 加 `SYNC_REP_WAIT_*` 常量 + 更新 `NUM_SYNC_REP_WAIT_MODE` → `syncrep.c assign_synchronous_commit` 加 case → `SyncRepReleaseWaiters` 加对应 `WalSndCtl->lsn` 更新 + `SyncRepWakeQueue` 调用 → GUC `synchronous_commit` enum 加值。

**新增逻辑解码插件接口**：`output_plugin.h` 加回调指针到 `OutputPluginCallbacks` → `logical.c LoadOutputPlugin` 加载 → `reorderbuffer.c ReorderBufferProcessTXN`（L2214）apply 循环调新回调 → 现有插件（`pgoutput/`）实现新回调。

**修改复制槽行为（如新增失效原因）**：`slot.h` 的 `ReplicationSlotInvalidationCause` enum 加原因 → `slot.c SlotInvalidationCauses` 数组加映射 → 新增检查函数在 `ReplicationSlotAcquire` 调用 → `slotfuncs.c` 更新 `pg_replication_slots` 视图 `invalidation_reason` 列 → `ReplicationSlotsComputeRequiredLSN` 确保失效槽不参与 WAL 保留。
