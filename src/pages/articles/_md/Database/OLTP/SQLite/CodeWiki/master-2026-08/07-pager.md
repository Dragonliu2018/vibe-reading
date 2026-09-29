---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "Pager 与事务"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "事务", "页缓存"]
description: "pager.c 七态状态机与 ACID 不变式、commit 的 journal-before-database 顺序、hot journal 崩溃恢复、两层页缓存与六种 journal 模式"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

ACID 正确性全部在此。Pager 是每个数据库文件一个的事务管理器：向上对 btree 提供"页的读写 + 事务边界"抽象，向下把所有 IO 走 VFS。文件族：`pager.c`（7896 行）、`pcache.c`/`pcache1.c`（两层页缓存）、`memjournal.c`（内存 journal）、`bitvec.c`（稀疏位图）。pager.c 头部 134-357 行的大注释是**权威文档**——状态机、journal 机制、七条不变式全在其中。

一处勘误：trunk 上不存在 `sqlite3BeginConcurrent`（那是分支特性）；写事务真实入口是 `sqlite3BtreeBeginTrans`（btree.c:3835）→ `sqlite3PagerBegin`。

## 模块架构

```text title="两层页缓存"
btree ──sqlite3PagerGet──► PCache（策略层：脏页链/spill 阈值/xStress 回调）
                              │ sqlite3_pcache*（可插拔 vtable）
                              ▼
                          PCache1（实现层：哈希查找/PGroup 共享 LRU/三种内存来源）
                              │
                              ▼ [page 内容|PgHdr1|MemPage|PgHdr] 单块分配
```

**为什么两层**：pcache.c 管"哪些页脏、何时必须写"（事务正确性逻辑），pcache1.c 管"如何存取页"（纯内存管理）——ZipVFS 等压缩层可以整体替换后者而不碰 ACID 代码。PgHdr1 紧贴页内容之后兼作 btree 层 16 字节越界读的缓冲区（pcache1.c:96-110，防 corrupt db 导致内存错误）。

## 调用链路

```text title="七态状态机（pager.c:134-357 注释 + :157-169 转换表）"
OPEN ↔ READER → WRITER_LOCKED → WRITER_CACHEMOD → WRITER_DBMOD → WRITER_FINISHED
                                    任意 WRITER_* ──IO 错误──► ERROR → OPEN
OPEN→READER: sqlite3PagerSharedLock    READER→OPEN: pager_unlock
READER→WRITER_LOCKED: sqlite3PagerBegin
WRITER_LOCKED→CACHEMOD: pager_open_journal（懒触发，首次改页时）
CACHEMOD→DBMOD: syncJournal
DBMOD→FINISHED: sqlite3PagerCommitPhaseOne
WRITER_*→READER: pager_end_transaction
```

每个状态绑定唯一转换函数；`assert_pager_state()`（pager.c:847）把"哪个状态锁几级、journal 开否、尺寸变量是否有效"编成 DEBUG 断言。**WAL 连接永远停留在前四态**（OPEN/READER/WRITER_LOCKED/WRITER_CACHEMOD）——WAL 模式的脏页由 `pagerWalFrames` 写日志帧，不存在 DBMOD/FINISHED 的"journal sync + 脏页回写"阶段。**ERROR 态的保守性**（:280-330 注释）：读语句触发的 spill IO 错误也强制进 ERROR——若只返回错误码，用户继续用就可能把不一致缓存写进文件造成永久损坏；宁可不服务。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `sqlite3PagerSharedLock` in pager.c:5316 | 读事务开锁 | 检测并回放 hot journal；缓存版本不符丢弃整个缓存 |
| `pager_playback` in pager.c:2872 | 崩溃回滚 | 垃圾数据返回 SQLITE_DONE 截断（断电残留尾部的处理） |
| `sqlite3PagerBegin` in pager.c:5984 | 写事务 | RESERVED 锁；快照三尺寸 dbOrigSize/dbFileSize/dbSize |
| `sqlite3PagerCommitPhaseOne` in pager.c:6527 | commit 前半 | 固定顺序见下文 |
| `pager_end_transaction` in pager.c:2090 | journal finalize | 四种模式四种处理 |
| `pagerStress` in pager.c:4663 | pcache 回调 | spill 时可 sync journal 再写页 |
| `pagerPlaybackSavepoint` in pager.c:3460 | savepoint 回滚 | 倒序三段回放 + pDone 位图去重 |

</details>

## 核心实现

### commit 顺序：journal-before-database（ACID 的 D）

rollback 模式 commit phase one 的固定顺序（pager.c:6652-6737）：

1. `pager_incr_changecounter`——更新 page1 偏移 24 的 change-counter（使其他连接缓存失效）；
2. `writeSuperJournal`——多库事务时写 super-journal 名进 journal 尾部；
3. **`syncJournal`（fsync journal！）**——非 SAFE_APPEND 设备先回填 nRec 字段再 `sqlite3OsSync(jfd)`；成功后清全部 `PGHDR_NEED_SYNC`；
4. 脏页按 pgno 排序逐页写数据库文件；
5. `sqlite3PagerSync`（fsync db）。

头部不变式 (5)（pager.c:70-71）是全部正确性的根：**数据库页的覆盖写只在该页旧值已写 journal 且已 fsync 之后允许**。断电时磁盘可能只留部分新页——只要旧值先落盘，恢复就总能把任意半写状态还原到事务前。`PGHDR_NEED_SYNC` 是逐页执行该纪律的机制（`pager_write_pagelist` 的 assert，:4529）。

**hot journal 恢复**：commit 最后一步（finalize journal）之前崩溃 → journal 遗留且无人持 RESERVED 锁 → 后来者拿 SHARED 时检测（`hasHotJournal` :5196）→ **直接跳 EXCLUSIVE**（不经过 RESERVED——否则别的进程会以为"有活跃写者"而放心读未回滚数据，:5355 注释）→ 回放。journal 用 magic + 每页随机初值 checksum 区分"有效旧值"与"断电垃圾"——初值随机化防"垃圾恰好是旧 journal 复用"的巧合（:749-755）。

### 六种 journal 模式

六种模式的差异**只在 commit/rollback 时 journal 文件如何 finalize**（`pager_end_transaction`，:2117-2161）：

| 模式 | finalize 方式 | 特点 |
| --- | --- | --- |
| DELETE（默认） | 删文件 | 多一次目录元数据 sync |
| PERSIST | 首部 header 抹零 | 免删文件；含 super-journal 时退化为 truncate（:492 注释：残留指针会污染后续 hot-journal 判定） |
| TRUNCATE | 截为 0 | fullSync 下补一次 sync（Mozilla bug 1072773） |
| MEMORY | 直接 close | 断电不保证 |
| OFF | 无 journal | 崩溃即损 |
| WAL | 无 rollback journal | 走 wal.c |

`sqlite3JournalOpen`（memjournal.c:353）是统一包装：先给内存 journal，超 `nSpill` 字节才真正落盘——OFF/MEMORY 之外的模式也受益（journal 小时零文件 IO）。

### Savepoint 与 sub-journal

`PagerSavepoint`（:431）记录 `iOffset`（主 journal 起点）、`iHdrOffset`（journal header 前一字节偏移）、`nOrig`（当时 dbSize）、`iSubRec`（sub-journal 首记录下标）、`pInSavepoint`（该 savepoint 覆盖的页集合 Bitvec），WAL 模式下另有 `aWalData[]`。ROLLBACK 到某 savepoint 走 `pagerPlaybackSavepoint`（:3460）**倒序三段回放**（主 journal 段落 → 主 journal 后续 → sub-journal 尾部），全程 `pDone` Bitvec 保证每页只回放一次。**sub-journal 存的是新值**（区别于主 journal 存旧值）——这是 statement journal 支撑语句级回退的机制。

### OOM 下的内存管理支点

`sqlite3PagerDontWrite`（:6345）：freelist 叶页免写盘——freelist 叶页内容不影响逻辑等价性（:76-80 定义），实测大 DELETE 提速 4 倍。`doNotSpill` 三标志精细禁流：ROLLBACK 期间禁止 spill（playback 正在读 journal，stress 又往 journal 写 header 会破坏遍历，:525 注释）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 显式状态机 | eState 七态 + 转换表 | "哪些变量何时可信"从注释升级为编译期可验证不变式 |
| 两层缓存 | pcache.c/pcache1.c | 策略与实现正交，后者可整体替换 |
| 回调驱动 spill | `xStress` → `pagerStress` | pcache 不懂磁盘，内存不足时倒置控制 |
| 锁状态镜像 | `pagerLockDb/pagerUnlockDb` 维护 eLock | xUnlock 失败时保守只降不升（:359-406） |
| PGroup 双模式 | pcache1.c:141-157 | 每连接独立无锁 vs 全局共享 LRU 的取舍 |

## 模块间交互

- **上层 btree**：`sqlite3PagerGet`（:5788，xGet 分发普通/mmap/getContent 三种取页）、`sqlite3PagerWrite`（改页前置 journal）、CommitPhaseOne/Two、OpenSavepoint；MemPage 借 pExtra 存放。
- **下层 VFS**：全部走 `sqlite3OsRead/Write/Sync/Truncate/Delete/Lock`，并依据 `xDeviceCharacteristics` 的 SAFE_APPEND/SEQUENTIAL/BATCH_ATOMIC 能力位切换代码路径。
- **与 wal.c**：`pagerOpenWal`（:7643）建 pWal；读事务走宏封装（:828-836）；`pagerWalFrames`（:3233）包装帧写。
- **与 backup.c**：`sqlite3BackupUpdate/Restart` 钩子（:4550）在页写出时同步副本。

## 扩展方式

新增一种 journal 模式的步骤：`pager.h:78-84` 枚举追加值（**数值是 API 兼容承诺只能追加**）→ `pager.c` 三处：`sqlite3PagerSetJournalMode`（:7423 assert 与切换清理）、`pager_end_transaction` + `pager_open_journal`（定义 finalize 与打开方式）→ `assert_pager_state` 同步 → `sqlite3JournalModename` 加名字（pragma 自动生效）→ 交互协议仿 `sqlite3PagerCloseWal` 分支。关键提醒：新模式必须让 commit 后的 hot-journal 检测返回"不热"，否则已提交事务会被下个连接误回滚。
