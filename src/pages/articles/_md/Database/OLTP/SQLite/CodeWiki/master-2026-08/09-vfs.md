---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "VFS OS 抽象层"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "VFS", "文件锁"]
description: "sqlite3_vfs/sqlite3_file 双对象分层、五级文件锁的字节区模拟、shm 双层锁协议、29 项 syscall 注入层与 kvvfs 最小实现范本"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

可移植性的全部边界：1 个公共接口（`os.h`）+ 1 个分发中枢（`os.c`）+ 4 个平台实现（`os_unix.c` 8582 行 / `os_win.c` 5344 行 / `os_kv.c` KV 示例 / 条件编译选择器 `os_setup.h`）+ mutex 子系统。公共对象 `sqlite3_vfs`/`sqlite3_file`/`sqlite3_io_methods` 定义在 `sqlite.h.in`——它们同时也是**用户自定义 VFS 的 API**。

## 模块架构

### 双对象分层

```text title="为什么是两个对象"
sqlite3_vfs（进程级单例，18 方法）          sqlite3_file + sqlite3_io_methods（每打开文件一例）
├─ xOpen/xDelete/xAccess/xFullPathname     ├─ v1: xRead/xWrite/xSync/xTruncate/xFileSize
├─ xDlOpen/xDlError/xDlSym/xDlClose        │      xLock/xUnlock/xCheckReservedLock
├─ xRandomness/xSleep/xCurrentTime         │      xFileControl/xSectorSize/xDeviceCharacteristics
├─ v2: xCurrentTimeInt64                   ├─ v2: xShmMap/xShmLock/xShmBarrier/xShmUnmap（WAL）
└─ v3: xSetSystemCall/xGet/xNextSystemCall └─ v3: xFetch/xUnfetch（mmap 直读）
```

Why 分层：两者生命周期和多例性完全不同——vfs 管进程级"名字空间"（路径操作、randomness/sleep 等进程服务），file 管实例操作（读写锁）。`szOsFile` 字段把"实现类大小"告知 core，core 用 `sqlite3OsOpenMalloc` 统一分配，实现方零分配负担。os.c 注释自嘲："如果用 C++ 写这些就全自动了"（:79-81）。

`sqlite3_file` 只有一个成员 `pMethods`——C 语言的"基类指针"，所有平台实现（`unixFile` 等）把它放第一个字段来"继承"。**pNext 是唯一允许 core 修改的字段**，注册表是链表（os.c:355 的 `vfsList` + `sqlite3_vfs_register` :408）。

### 双重多态：UNIXVFS × IOMETHODS × finder

os_unix.c 用两层宏生成变体：`IOMETHODS(FINDER, METHOD, VERSION, …)`（:5808）生成一份 io_methods 常量 + finder 函数——**I/O 方法全平台共享，只有锁方法按风格换**（posix/flock/afp/nfs/dotfile/proxy）；`UNIXVFS(NAME, FINDER)`（:8465）生成 vfs 实例。`sqlite3_os_init`（:8444-8565）注册 `aVfs[]`：unix（Apple 上 autolock——statfs 探测文件系统类型自动选锁风格）、unix-none、unix-dotfile、unix-excl 等。

## 调用链路

```text title="unixLock 五级锁状态机（os_unix.c:1866-2095）"
SHARED:    F_RDLCK on PENDING_BYTE（串行化入口）→ F_RDLCK on [SHARED_FIRST,+510) → 释放 PENDING
RESERVED:  F_WRLCK on RESERVED_BYTE 单字节
PENDING:   F_WRLCK on PENDING_BYTE —— core 永远不直接请求（assert :1935）
           它是 SHARED→EXCLUSIVE 升级路径的过渡态：挡住新 SHARED，存量 SHARED 保留
EXCLUSIVE: F_WRLCK on [SHARED_FIRST,+510)
```

锁字节区在 **1GB 偏移处**（`PENDING_BYTE=0x40000000`，os.h:159）——避开真实数据页（Windows 锁是强制性的且锁区不能存数据；改 PENDING_BYTE 即文件格式不兼容）。POSIX 只有共享/独占两种字节锁，SQLite 的 RESERVED（意图锁）和 PENDING 语义只能靠**不同字节区组合模拟**。PENDING 防写者饿死：若 RESERVED 直接抢 EXCLUSIVE 失败，反复重试期间新读者源源不断，写者永远拿不到（os.h:82-97 注释）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `unixOpen` in os_unix.c:6519 | 打开文件 | MAIN_DB 走 `findReusableFd`——POSIX 锁 per-process，同 inode fd 不能随手 close |
| `robust_open` in os_unix.c:834 | open 包装 | EINTR 重试、fd≥3 保护、O_CLOEXEC、journal 绕 umask（:826 注释：保证 hot journal 能被任何可写进程恢复） |
| `unixLock` in os_unix.c:1866 | 锁升级 | 同进程同 inode 已有锁时直接 nShared++ 不碰内核（:1957） |
| `posixUnlock` in os_unix.c:2124 | 锁降级 | NFS 两段式降级防 BSD lockd bug（:2157-2208） |
| `unixShmMap` in os_unix.c:5106 | 映射 shm | 每 4KB 页写 1 字节强制 OS 分配页面防 SIGBUS；hShm<0 时 heap 降级 |
| `unixShmLock` in os_unix.c:5284 | shm 锁 | 双层：进程内 aLock[] 计数 + 跨进程 fcntl 字节锁 |

</details>

## 核心实现

### inode 聚合与延迟关闭 fd

`unixInodeInfo`（:1323）以 `{dev, ino}` 为 key，**同一 inode 的多个 fd 共享一个实例**。POSIX advisory lock 属于进程：close 任一 fd 会清掉该进程在此文件上的**全部**锁——所以同 inode 的旧 fd 不能随手 close，存进 `UnixUnusedFd` 备用链（unixOpen 的 `findReusableFd` :6612 消费它）。互斥规则（:1306-1321 注释）：全局 `unixBigLock` 必须先于 per-inode 的 `pLockMutex`。

### shm：WAL 的地基

`unixOpenSharedMemory`（:4952）：按 `zPath+"-shm"` 打开/复用（挂 inodeInfo 上跨连接共享）；`readonly_shm` URI 参数覆盖只读挂载场景。`unixShmMap`（:5106）按需扩展文件——**每 4KB 页写 1 字节**（:5175，强制 OS 立即分配页面，防后续 mmap 访问触发 SIGBUS），然后按批 mmap 进 `apRegion[]`。**heap 降级分支**（:5215）：hShm<0（unix-excl 的 bProcessLock 模式）时用进程堆内存模拟——承诺单进程访问时堆内存即正确语义。

`unixShmLock`（:5284）的 8 个锁槽布局（`sqlite3_os_init` :8548 的 assert 给出：120=WRITE、121=CKPT、122=RECOVER、123-127=READ0-4）与 wal.c 的锁位一一对应。实现是**双层锁**：进程内 `aLock[]` 计数（-1 独占、>0 共享计数）+ 跨进程 fcntl。与主文件锁不同，SHARED↔EXCLUSIVE 不允许直接互转（:5279 注释）。

### syscall 注入层（v3 三件套）

`aSyscall[]` 表（~460-596 行，29 项：open/read/write/pread/mmap/fcntl…）每项 `{zName, pCurrent, pDefault}`，全部 `osXxx` 宏经函数指针间接调用。`unixSetSystemCall`（:731）可运行时替换单项。sqlite.h.in:1499 注释明说 core 不使用这些接口——**纯粹为 fault injection 测试服务**：VFS 层是内部 mock 无法覆盖的边界，必须在 OS 边界打桩（`src/test_syscall.c` 注入 open 失败、磁盘满、EINTR 风暴）。

### 平台条件编译

`os_setup.h:38-88`：四个互斥宏归一为恰好一个（`SQLITE_OS_UNIX/WIN/KV/OTHER`），显式指定优先级 OTHER > KV > UNIX > WIN。**KV 模式连坐关掉** OMIT_WAL/OMIT_LOAD_EXTENSION/TEMP_STORE=3/OMIT_SHARED_CACHE——KV 后端没有 shm/动态库概念。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 接口/实现分离 + 注册表 | os.c vfsList | 一个进程多 VFS 共存（unix+kvvfs+自定义） |
| 宏生成变体 | IOMETHODS/UNIXVFS | 一份 I/O 代码 × N 种锁风格 |
| 组合锁模拟 | 字节区布局 | POSIX/Win32 语义交集上实现五级锁 |
| 装饰器 | ext/misc/cksumvfs（包裹默认 VFS 加整库校验和） | 官方扩展 VFS 范式 |

## 模块间交互

- **被 pager 消费**：所有页面 IO 走 `sqlite3OsRead/Write/Sync/FileSize`；事务锁走 `sqlite3OsLock/Unlock`（os.c 的薄转发，`sqlite3OsSync` 有 flags==0 直接返回 OK 的小优化）。
- **被 wal.c 消费**：`sqlite3OsShmMap/ShmLock/ShmBarrier`。
- **URI 参数在 VFS 内消费**：文件名双 NUL 结尾正是为 `sqlite3_uri_parameter`（unixOpen :6622 注释）；`psow`/`readonly_shm`/`modeof` 各有消费点。`unix-excl` VFS 触发 UNIXFILE_EXCL → 一次性进程级 WRLCK → 后续锁全部退化为进程内计数、shm 走 heap。
- **mutex 子系统**：与 VFS 同构的第二套可替换接口（`sqlite3_mutex_methods`），noop 实现所有方法空壳、alloc 返回 `(sqlite3_mutex*)8` 假指针——单线程构建零成本。

## 扩展方式

注册自定义 VFS 的最小路径（`src/os_kv.c` 1097 行是官方完整范本——把 SQLite 跑在"每页一个 key 的 KV 存储"上）：

1. 定义文件子类：`struct KVVfsFile { sqlite3_file base; … }`——base 必须是首字段；
2. 实现两张方法表（db 与 journal 可各一份），`iVersion=1` 即可（shm/mmap 填 0）；
3. 定义 vfs 对象：`iVersion=2`、`szOsFile=sizeof(子类)`、`zName`；
4. 注册三选一：`SQLITE_OS_KV=1` 时实现 `sqlite3_os_init()` 直接 `sqlite3_vfs_register(&obj, 1)` 成默认；或 `-DSQLITE_OS_KV_OPTIONAL` 让 os_unix 的 init 末尾追加注册（用 `?vfs=kvvfs` 启用）；或运行时 `sqlite3_vfs_register(&myVfs, makeDflt)`。

同样模式见 `src/memdb.c`（内存 VFS）、`ext/misc/appendvfs.c`（db 追加在任意文件尾部）、`ext/misc/cksumvfs.c`（装饰器）。
