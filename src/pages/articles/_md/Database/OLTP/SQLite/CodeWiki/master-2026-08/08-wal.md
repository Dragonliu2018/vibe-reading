---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "WAL"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "WAL", "并发"]
description: "append-only 帧格式与累计校验链、wal-index 自定义哈希（可重建的 shm）、aReadMark 快照并发模型、checkpoint 四模式与 salt 回卷"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`wal.c`（4649 行）实现与 rollback journal 并列的第二种事务后端。WAL 模式下写者只追加日志帧、从不覆盖数据库页——**读写完全不互斥**，commit 退化为"写一个带 commit 标记的帧"，崩溃恢复只需顺序扫描校验链截断。文件头部 16-98 行的大注释是 WAL 文件格式的权威文档。

## 模块架构

```text title="三件套"
.db        # 主数据库文件（checkpoint 时才被写）
.db-wal    # 32B 头 + 帧序列（每帧 24B 头 + 一页数据），append-only
.db-shm    # wal-index：136B 头（双份 WalIndexHdr + WalCkptInfo）
           #   + 32KB 段（aPgno[4096] 页号数组 + aHash[8192] u16 哈希槽）
           # 所有连接 mmap 共享；崩溃后可从 WAL 全量重建（幂等）
```

核心结构：`Wal`（wal.c:511，每 pager 一个，持 `hdr`——WalIndexHdr 的**私有快照**，读事务的隔离锚点）；`WalIndexHdr`（:321，24+8 字节，关键字段 `mxFrame` 最后有效 commit 帧、`nPage` commit 后页数）；`WalCkptInfo`（:394，`nBackfill` 已回填帧数 + `aReadMark[5]` 读标记）。

锁位（:294-299）：`WAL_WRITE_LOCK=0`、`WAL_CKPT_LOCK=1`、`WAL_RECOVER_LOCK=2`、`WAL_READ_LOCK(I)=3+I`——全部落在 shm 文件偏移 120 处的 8 字节。

## 调用链路

```text title="读端"
sqlite3WalBeginReadTransaction → walTryBeginRead (wal.c:3020)
├─ 快路径 (:3132): nBackfill==mxFrame → 拿 WAL_READ_LOCK(0) 直接忽略整个 WAL
├─ 常规路径 (:3183-3214): 找 ≤mxFrame 的最大 aReadMark[i] 持共享锁
│   没有现成的就独占某槽写入 aReadMark[i]=mxFrame
├─ 复核 wal-index 头未变，变了返回 WAL_RETRY 重来（上限 100 次）
└─ minFrame = nBackfill+1   # 读端可忽略的帧下界
每页查找: walFindFrame (:3525) 从新段向旧段扫哈希
  命中条件 iFrame<=iLast && iFrame>=minFrame && aPgno 匹配
  找不到 → 从 db 文件读（经 checkpoint 回填的旧版本页）
```

```text title="写端 + checkpoint"
sqlite3WalFrames → walFrames (:4042)
├─ walRestartLog (:3879): nBackfill==mxFrame 且无 WAL 读者 → 回卷从帧 1 重写
├─ 循环 walWriteOneFrame (:3967): 同事务重复页就地覆盖旧帧
├─ commit 帧 nTruncate≠0（commit 后库页数）
└─ 先写 WAL 文件后更新 wal-index；仅 commit 时 walIndexWriteHdr (:942)
    发布新 mxFrame —— 非帧对读端天然不可见
checkpoint: walCheckpoint (:2199)
├─ mxSafeFrame = min(所有使用中的 aReadMark)   # 读者可见性安全边界
├─ fsync WAL → walIteratorInit 按页号升序遍历 → 逐帧回填 db
└─ 全部回填则截断 db 到 nPage 并 fsync；nBackfill 推进
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `walTryBeginRead` in wal.c:3020 | 读事务开快照 | aReadMark 槽位协议 + WAL_RETRY 内部重试 |
| `walIndexRecover` in wal.c:1390 | 重建 wal-index | 只有 commit 帧推进 mxFrame（:1516） |
| `walFindFrame` in wal.c:3525 | 页→最新帧 | 倒序扫段；两个界检查是与并发 append 无锁共存的关键（:3549 注释） |
| `walWriteOneFrame` in wal.c:3967 | 追加一帧 | 累计 Fibonacci 加权校验和贯穿全链 |
| `walCheckpoint` in wal.c:2199 | 回填 | 页号升序 = 顺序写 db |
| `walRestartHdr` in wal.c:2158 | 回卷翻新 | salt-1 自增 salt-2 随机化，旧帧 crash 后不可能被误认有效 |

</details>

## 核心实现

### 并发模型：快照与单写者

- **读写不互斥**：写者只 append；读者用私有 `pWal->hdr.mxFrame` 快照忽略新帧（:110-117 注释）。多个读者可经不同 `aReadMark[]` 槽同时持不同快照。
- **单写者**：`sqlite3WalBeginWriteTransaction`（:3703）独占 WAL_WRITE_LOCK；若 wal-index 头与本连接读事务开始时不同，返回 **SQLITE_BUSY_SNAPSHOT**（:3739）——防止基于过期快照写出分叉历史。
- **checkpoint 受读者约束**：只能回填 `≤ min(aReadMark)` 的帧，绝不覆盖在用读者可能读到的 db 页（:372-382 注释）。

### wal-index：为什么用自定义哈希而非 B-Tree

查询语义是"页 P 在帧 ≤M 的最后一个帧"；插入严格按帧号递增、永不删除（回滚只是清零槽位 `walCleanupHash` :1239）——**无重平衡需求**。哈希函数 `iKey=(P*383)&8191`（:1138）线性探测，装填 ≤1/2 期望碰撞 1 次，10MB WAL 约 8-10 次比较定位（:222-231 注释）。且 wal-index 是**易失结构**可用宿主机字节序（:139-146），不需要跨平台磁盘格式的复杂度；每段 32KB 恰好一页 mmap。

### shm 可重建：复杂度留在 WAL、简化留给 shm

wal-index 是 WAL 文件的**纯派生函数**——`walIndexRecover`（wal.c:1390）独占恢复锁后顺序扫描 WAL，逐帧用 `walDecodeFrame`（:1000）验证 magic/salt/校验链，**只有 commit 帧才推进 mxFrame**（:1516），先在私有堆缓冲构建再 memcpy 进 shm，最后重置 `nBackfill=0` 并初始化 aReadMark（:1579-1595）——因此 shm 不需要任何持久化保证——VFS 在最后一个连接关闭时清零其头部即可。双份头 + 校验和（`walIndexTryHdr` :2590）让无锁读能检测撕裂读。这是 WAL 设计的核心取舍。

### 帧有效性：累计校验链

每帧 24 字节头：页号、`nTruncate`（非 0 即 commit 帧）、salt 副本、帧校验和。校验和是**从 WAL 头贯穿所有前序帧的累计链**（`walChecksumBytes` :856）——任何一帧损坏即截断到其后。checkpoint 后 salt-1 自增、salt-2 随机化（`walRestartHdr` :2158-2159）：回卷后的旧帧 salt 不匹配，crash 后不可能被误认有效。

### checkpoint 四模式

**PASSIVE** 不调 busy handler、读到哪算哪；**FULL** 拿写锁 + busy handler 等整个 WAL 回填完；**RESTART** 在 FULL 基础上再 busy-lock 所有读锁槽，确保所有读者离开 WAL，下一个写者必然回卷；**TRUNCATE** = RESTART + 回卷 + `OsTruncate(WAL, 0)`。

**自动 checkpoint 阈值 1000 页**（`SQLITE_DEFAULT_WAL_AUTOCHECKPOINT`，sqliteLimit.h:169）：`main.c:3715` 注册 `sqlite3_wal_autocheckpoint(db, 1000)` → `sqlite3WalDefaultHook` 比较帧数触发 PASSIVE checkpoint——WAL 越长读放大越大且文件无界增长，1000 页是 checkpoint 开销与 WAL 查找开销的经验平衡。

**fsync 全部集中在 checkpoint**（:2176-2188 注释）：synchronous=NORMAL 下 commit 不 fsync WAL，barrier 移到 checkpoint 内——前台事务提交永不等 fsync，把长延迟 IO 推给后台。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| append-only + checkpoint | 整体架构 | commit 近似原子；读写不互斥；恢复=顺序扫描 |
| 派生缓存 | wal-index ← WAL | shm 免持久化保证，崩溃可重建 |
| 世代计数（salt） | walRestartHdr | 旧帧天然失效，无需删除 |
| 双份头 + 校验和 | WalIndexHdr ×2 | 无锁检测撕裂读 |
| 内存屏障发布 | walIndexWriteHdr 先写副本[1] barrier 再写[0] | 读端总能看到一致的新旧之一 |

## 模块间交互

- **pager.c**：读页 `sqlite3WalFindFrame`+`ReadFrame`（pager.c:3086）；写页 `pagerWalFrames`（:3233，先剔除 pgno>nTruncate 的页）；回滚 `sqlite3WalUndo`；checkpoint 入口 `sqlite3PagerCheckpoint`（:7572）。
- **os 层**：shm 原语 `sqlite3OsShmMap/ShmLock`（unix 实现是 mmap + fcntl 字节锁，见 VFS 篇）；Windows 用 SEH 捕获 shm 映射失效异常（wal.c:631-735）。
- **main.c**：自动 checkpoint 的 wal hook 注册。

## 扩展方式

调整 checkpoint 策略：阈值改 `SQLITE_DEFAULT_WAL_AUTOCHECKPOINT` 编译宏或运行时 `sqlite3_wal_autocheckpoint(db, N)`（main.c:2528，会替换用户 wal hook）；WAL 体积上限走 `PRAGMA journal_size_limit` → `Wal.mxWalSize` + truncateOnCommit（walFrames 内 :4224 的 `walLimitSize`）。任何"更激进回填"的改动都必须维持 aReadMark 不变量（改 aReadMark[K] 需独占 WAL_READ_LOCK(K)，:367-370 注释）——否则会覆盖在用读者的快照页。
