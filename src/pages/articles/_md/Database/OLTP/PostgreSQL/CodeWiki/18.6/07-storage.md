---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "存储与缓冲管理"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "storage", "buffer pool", "clock sweep", "smgr", "lock manager"]
description: "PostgreSQL storage 模块——共享缓冲池 128 分区哈希、clock sweep 淘汰、bgwriter/checkpointer 协作、smgr/md 段文件、两层锁体系"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`src/backend/storage/` 是 PostgreSQL 存储基础设施层。管理共享缓冲池（buffer pool）、底层文件 I/O 抽象（smgr）、重量级锁（lock manager）、轻量锁（LWLock）、共享内存分配和缓存失效消息（sinval）。它是多进程架构下所有 backend 共享数据的基石——同一 page 被多 backend 共享、写操作经 WAL 同步、并发经锁控制，都在这层实现。

---

## 模块架构

四个子模块：`buffer/`（`bufmgr.c` 缓冲池 + `freelist.c` clock sweep + `buf_table.c` 哈希 + `localbuf.c` 临时表）、`smgr/`（`smgr.c` 抽象 + `md.c` 磁盘实现）、`lmgr/`（`lock.c` 重量级锁 + `lwlock.c` 轻量锁 + `deadlock.c` 死锁检测）、`ipc/`（`shmem.c` 共享内存 + `sinval.c` 失效消息 + `procarray.c` 进程数组 + `proc.c` PGPROC）。

---

## 调用链路

`ReadBuffer`（读 8KB page）核心流程：

```
[bufmgr.c:805] ReadBufferExtended(rel, forkNum, blockNum, mode, strategy)
  → ReadBuffer_common()
      ├── RBM_ZERO*: PinBufferForBlock + ZeroAndLockBuffer
      └── RBM_NORMAL: StartReadBuffer + WaitReadBuffers   # 支持异步批量读
  → PinBufferForBlock()
      ├── RELPERSISTENCE_TEMP → LocalBufferAlloc（本地缓冲）
      └── 其他 → BufferAlloc（共享缓冲池）
            → BufferAlloc（bufmgr.c:2009）
                1. 构造 BufferTag + 算 hash + 取 BufMappingPartitionLock
                2. BufTableLookup ── 命中: PinBuffer 返回
                3. 未命中 → GetVictimBuffer → StrategyGetBuffer（clock sweep）
                      └── victim 脏: FlushBuffer（先 XLogFlush 再 smgrwrite）
                4. BufTableInsert 新 tag + LockBufHdr 设 tag
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ReadBufferExtended` | 读 page 入缓冲 | 经 AM 间接调用 |
| `BufferAlloc` | 缓冲池分配/淘汰 | 128 分区哈希减锁竞争 |
| `StrategyGetBuffer` | clock sweep 选 victim | 原子计数器，无链表锁 |
| `FlushBuffer` | 脏页刷盘 | 先 XLogFlush 保 WAL 先落盘 |
| `LockAcquire` | 重量级锁 | fast path 优化弱锁 |
| `smgrread/write` | 存储抽象 | 策略模式可换后端 |

---

## 核心实现

### Buffer Pool 架构

共享内存三大数据结构（`buf_init.c` 注册）：

| 结构 | 说明 |
| --- | --- |
| `BufferDescriptors[]` | NBuffers 个 `BufferDescPadded`（64 字节 cache line 对齐） |
| `BufferBlocks` | NBuffers×BLCKSZ 连续内存（IO 对齐） |
| `SharedBufHash` | 分区哈希表，key=BufferTag，128 分区 |

```c
// src/include/storage/buf_internals.h:326
typedef struct BufferDesc {
    BufferTag tag;                 // RelFileLocator + ForkNum + BlockNum
    int buf_id;
    pg_atomic_uint64 state;        // 64-bit 原子: refcount + usage_count + flags + lock
    int wait_backend_pgprocno;
    proclist_head lock_waiters;
} BufferDesc;
```

`state` 用 64-bit 原子操作而非 spinlock——refcount/usage_count/flags/content lock 全打包，pin/unpin 高频操作经 CAS 无锁，减少竞争。`BufferDescPadded` 64 字节对齐避免多核 false sharing。

### ReadBuffer 与 BufferAlloc

`BufferAlloc`（`bufmgr.c:2009`）4 步：①构造 BufferTag 算 hash 取分区锁；②`BufTableLookup`（`LW_SHARED`）命中则 `PinBuffer` 返回；③未命中 `GetVictimBuffer`→`StrategyGetBuffer`（clock sweep），victim 脏则 `FlushBuffer` 刷盘；④`BufTableInsert`（`LW_EXCLUSIVE`）新 tag，冲突则用别人的 buffer。

### Clock Sweep 淘汰

`StrategyGetBuffer`（`freelist.c:183`）：`ClockSweepTick()` 原子递增 `nextVictimBuffer` → CAS 检查 state：refcount≠0 跳过（pinned）；usage_count≠0 递减跳过；usage_count==0 且 refcount==0 则原子 pin 返回。

```c
// freelist.c:32
typedef struct {
    pg_atomic_uint32 nextVictimBuffer;  // clock 指针，原子递增
    uint32 completePasses;
    pg_atomic_uint32 numBufferAllocs;
} BufferStrategyControl;
```

**为什么 clock 近似 LRU 而非严格 LRU**（`buf_internals.h:136` 注释）：严格 LRU 需全局链表，每次访问更新位置，多进程下需全局锁成瓶颈。Clock sweep 用一个原子计数器 + 每 buffer `usage_count`（0-5，`BM_MAX_USAGE_COUNT=5`），CAS 无锁更新。代价是淘汰精度略差，但 5 轮扫描最坏仍可接受，避免 LRU 链表锁竞争。

**BufferAccessStrategy**（ring buffer）：`BAS_BULKREAD`（256KB 大表扫描）、`BAS_BULKWRITE`（16MB COPY）、`BAS_VACUUM`（2MB）——防大批量操作冲刷整个 buffer pool。

### 脏页写回与 bgwriter/checkpointer

| 角色 | 函数 | 职责 |
| --- | --- | --- |
| checkpointer | `BufferSync`（`bufmgr.c:3367`） | checkpoint 批量写回所有脏页，按 tablespace/relNumber/blockNum 排序减随机 IO |
| bgwriter | `BgBufferSync`（`bufmgr.c:3643`） | 后台持续清脏页，追赶 clock sweep 指针，移动平均自适应速度 |
| backend | `GetVictimBuffer`→`FlushBuffer` | 淘汰 victim 时若脏则写回 |

`FlushBuffer`（`bufmgr.c:4307`）关键规则（L4565-4585）：`BM_PERMANENT` 页先 `XLogFlush(recptr)` 确保 WAL 先于数据页落盘——write-ahead 原则核心实现点。

### smgr 抽象层

`f_smgr`（`smgr.c:88`）函数指针表（19 个回调：`smgr_readv`/`smgr_writev`/`smgr_create`/`smgr_nblocks` 等），当前唯一实现 `md.c`（magnetic disk）。上层调 `smgrread/write` 间接，不直接调 `md.c`。

```c
// smgr.c:128
static const f_smgr smgrsw[] = {
    { .smgr_init = mdinit, .smgr_readv = mdreadv, .smgr_writev = mdwritev, ... }
};
```

**md.c 段文件管理**：一个 relation 拆多个 `RELSEG_SIZE` 大小段文件（命名 `<relNumber>.<segno>`）。`_mdfd_getseg`（`md.c:1744`）算 `targetseg = blkno / RELSEG_SIZE`，逐段打开/创建，维护不变量（除最后一段恰好 RELSEG_SIZE）。`mdreadv` 用 iovec + `preadv` 系统调用，不跨段读。

为什么有 smgr 抽象：策略模式，架构允许替换为其他存储后端（网络存储、WAL-based recovery storage），上层代码不变。

### Lock Manager

8 种锁模式（`lockdefs.h:34`）从 `AccessShareLock`(1, SELECT) 到 `AccessExclusiveLock`(8, DROP TABLE)，冲突矩阵在 `lock.c:68` 的 `LockConflicts[]`。

`LockAcquireExtended`（`lock.c:832`）流程：①Local hash 查 `LOCALLOCK`，`nLocks>0` 直接递增本地计数（不访问共享内存）；②**Fast path** 弱锁（≤RowExclusiveLock）在 `MyProc->fpInfoLock` 保护下用 `FastPathGrantRelationLock` 直接设 PGPROC 数组（99% 弱锁免访问共享哈希表）；③共享内存路径 `SetupLockInTable` 创建 `LOCK`+`PROCLOCK`；④`LockCheckConflicts` 三级检测（全局→扣自身→扣同组）；⑤无冲突 `GrantLock`，有冲突入 `waitProcs` 队列。

**死锁检测**（`deadlock.c`）：基于 waits-for graph 的环检测。`DeadLockCheck` 做 DFS 找硬环/软环，`TestConfiguration`+`TopoSort` 尝试重排等待队列解软死锁。结果：`DS_NO_DEADLOCK`/`DS_SOFT_DEADLOCK`/`DS_HARD_DEADLOCK`（须 abort 一事务）/`DS_BLOCKED_BY_AUTOVACUUM`。

### 两层锁体系

| 体系 | 模式 | 用途 | 死锁检测 |
| --- | --- | --- | --- |
| Regular lock（重量级） | 8 种 + 冲突矩阵 | SQL 语义级（表/行/页锁） | 有 |
| LWLock（轻量） | LW_SHARED/LW_EXCLUSIVE | 内部数据结构（buffer hash 分区、header spinlock） | 无 |

分离原因：重量级锁的死锁检测/冲突矩阵开销不适合高频内部临界区；LWLock 的简单性不适合表达 SQL 级复杂锁语义。

### IPC 共享内存

`shmem.c` 基于 `ShmemCallbacks` 注册式分配：postmaster 启动调所有 `request_fn` 累计大小→分配→调所有 `init_fn` 初始化。fork 后子进程继承指针（Unix）或 `attach_fn` 重建（EXEC_BACKEND）。`sinval.c` 维护全局环形消息队列，backend 经 `SIGetDataEntries` 读失效消息触发 relcache 失效。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略模式 | `f_smgr` 函数指针表 | 存储后端可插拔 |
| Clock 近似 LRU | `StrategyGetBuffer` | 无锁原子计数器，避免 LRU 链表锁瓶颈 |
| 分区哈希 | `SharedBufHash` 128 分区 | 减少锁竞争 |
| Fast path 优化 | `FastPathGrantRelationLock` | 99% 弱锁免访问共享哈希表 |
| 64-bit 原子状态 | `BufferDesc.state` | pin/unpin 高频操作无 spinlock |
| 两层锁 | regular + LWLock | 语义丰富 vs 高频临界区分开 |

---

## 模块间交互

storage 被 `executor`/`access` 调用（`ReadBuffer`/`MarkBufferDirty`/`LockRelation`）。依赖 `access/transam`（`FlushBuffer` 先 `XLogFlush`）、`utils`（内存上下文、ResourceOwner）。`sinval` 与 relcache 协作（`ReceiveSharedInvalidMessages` 触发失效）。

---

## 扩展方式

**调整淘汰策略（如 LRU-K）**：`freelist.c` 改 `BufferStrategyControl` 加历史访问记录 + 替换 `ClockSweepTick`（L109）+ 调 `buf_internals.h:144` 的 `BM_MAX_USAGE_COUNT`/`BUF_USAGECOUNT_BITS` + 同步改 `StrategySyncStart`/`StrategyNotifyBgWriter` 保 bgwriter 协作。

**新增 smgr 后端（如直接 NVMe）**：新建 `smgr/nvme.c` 实现 `f_smgr` 全部 19 回调 → `smgr.c:128 smgrsw[]` 加条目 → `smgr_which` 选择。

**新增锁模式**：`lockdefs.h` 加模式 + `lock.c:68 LockConflicts` 扩展冲突矩阵 + `default_lockmethod` 的 `numLockModes` + 更新 `lock_mode_names`（注意 `MAX_LOCKMODES=10` 限制 + `LOCKMASK` 位宽）。
