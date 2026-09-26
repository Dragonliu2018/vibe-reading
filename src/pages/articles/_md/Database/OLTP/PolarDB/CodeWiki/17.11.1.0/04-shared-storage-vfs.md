---
source:
  type: "源码解读"
  project: "polardb-pg"
  url: "https://github.com/polardb/PolarDB-for-PostgreSQL"
title: "共享存储 VFS"
date: "2026-09-26T23:11:29+08:00"
category: [Database, OLTP, PolarDB, CodeWiki, "17.11.1.0"]
contentType: "CodeWiki"
tags: ["PolarDB", "PostgreSQL", "VFS", "PolarFS", "PFSD", "DirectIO", "存算分离"]
description: "polar_vfs 两级分发：内联跳转（未开共享存储零开销等价上游）→ 插件按路径路由三个后端（本地 buffered IO / PolarFS / 本地 O_DIRECT），协议前缀兼任路由标记，批量 IO 把 N 次网络往返压成 1 次。"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/00-overview)

---

## 模块定位

PolarDB 通过 VFS 抽象层把 PostgreSQL 的文件 I/O 路由到两类后端——本地文件系统与 Polar 共享存储（PFS/PolarFS），这是存算分离的存储侧入口。设计上极其克制：**静态内核只保留"数组 + 内联跳转"约 500 行**（`src/include/storage/polar_fd.h` + `src/backend/storage/file/polar_fd.c`），所有后端实现在插件 `src/polar_vfs/` 里——未启用共享存储时零开销，行为等价上游 PG。

## 模块架构

三层结构：

```text
┌─────────────────────────────────────────────────────────────┐
│ 上层调用者: fd.c(VFD) / md.c(smgr) / xlog.c / SLRU / 前端工具    │
├─────────────────────────────────────────────────────────────┤
│ ① 内联分发层  src/include/storage/polar_fd.h                   │
│    polar_open/polar_read/polar_write... → polar_vfs[switch]    │
│    全局数组 polar_vfs[2]: [0]=LOCAL(libc 直连) [1]=PLUGIN(插件)  │
├─────────────────────────────────────────────────────────────┤
│ ② VFS VFD 层  src/polar_vfs/polar_vfs_interface.c             │
│    vfs_vfd_cache + POLAR_VFS_FD_MASK 掩码 + hooks + 协议路由    │
├─────────────────────────────────────────────────────────────┤
│ ③ 三个后端（各实现一份 const vfs_mgr）:                          │
│    polar_bufferio.c → 本地 buffered IO（libc 直映射）           │
│    polar_pfsd.c     → PolarFS 共享存储                        │
│    polar_directio.c → 本地 O_DIRECT + 对齐垫片                │
└─────────────────────────────────────────────────────────────┘
```

核心数据结构 `vfs_mgr`（`src/include/storage/polar_fd.h:126-166`）把完整 POSIX 文件面（约 40 个操作）抽成函数指针结构体：

```c
/* src/include/storage/polar_fd.h */
typedef struct vfs_mgr
{
    int     (*vfs_env_init)(void);
    int     (*vfs_mount)(vfs_mount_arg_t *mount_arg);
    int     (*vfs_open)(const char *path, int flags, mode_t mode);
    ssize_t (*vfs_pread)(int fd, void *buf, size_t len, off_t offset);
    ssize_t (*vfs_preadv)(int fd, const struct iovec *iov, int iovcnt, off_t offset);
    ... /* write/pwrite/pwritev/stat/fstat/lseek/fsync/unlink/rename/
           fallocate/ftruncate/opendir/mkdir/mmap/fdatasync ... */
    PolarVFSKind (*vfs_type)(int fd);
} vfs_mgr;
```

## 调用链路

### 两级分发

**第一级（粗粒度）**：`polar_fd.h:225-330` 的内联函数 `polar_open/polar_pread/polar_pwrite...` 全部走 `polar_vfs[polar_vfs_switch]`：

- `POLAR_VFS_SWITCH_LOCAL (0)`：槽位 0 由 `polar_fd.c:77` 静态初始化为 libc 直连（`open/read/pwrite/pg_fsync...`）——**未启用共享存储时等价上游 PG**；
- `POLAR_VFS_SWITCH_PLUGIN (1)`：槽位 1 初始为全 NULL，由插件 `_PG_init` 时通过 `polar_init_vfs_function()`（polar_vfs_interface.c:259）填入。

**第二级（细粒度）**：插件内部按文件类型路由到三个后端：

```c
/* src/polar_vfs/polar_vfs_interface.c:120-128 */
static const vfs_mgr *const vfs[POLAR_VFS_KIND_SIZE] =
{
    &polar_vfs_bio,   /* POLAR_VFS_LOCAL_BIO：本地 buffered IO */
    &polar_vfs_pfsd,  /* POLAR_VFS_PFS：PolarFS */
    &polar_vfs_dio    /* POLAR_VFS_LOCAL_DIO：本地 O_DIRECT */
};
```

**路由规则**（`polar_vfs_file_type_and_path()`，polar_vfs_interface.c:1131）——三信号优先级：

1. **协议前缀匹配优先**（:139-144 的 `polar_vfs_kind` 表，定义于 polar_fd.h:39-41）：`"file://"` → LOCAL_BIO；`"pfsd://"` → PFS；`"file-dio://"` → LOCAL_DIO。匹配后**剥掉前缀**把剩余路径传给后端——协议前缀兼任路由标记和剥离标记；
2. **无前缀时按磁盘名匹配**：`vfs_file_type()`（:1158）——路径以 `/<polar_disk_name>/` 开头的绝对路径判为 PFS；相对路径（进程 cwd = 本地 DataDir）或其它绝对路径判为 LOCAL_BIO；
3. `localfs_mode=true` 时强制全 LOCAL。

**虚拟 FD 与掩码**：`vfs_open()`（:411）从 `vfs_vfd_cache` 取槽位（`vfs_allocate_vfd` 自由链表扩容：首次不足 32 槽时取 32，按需 ×2，扩到 ≥ `POLAR_VFS_FD_MASK` 时报错），路由出 `vfdP->kind`，调 `vfs[kind]->vfs_open()` 拿真实 fd，然后 `POLAR_VFS_FD_MASK_ADD(file)`（fd |= 0x40000000）给上层返回**带高位标记的虚拟 fd**——与真实 fd 区分防误用。后续读写先 `MASK_RMOVE` 还原槽位号再按 kind 分发；`vfs_close` 对已关闭（VFD_CLOSED）的句柄置 `errno = EBADF`。

### shared storage mode 初始化

启动序列（postmaster）：

```text
1. postmaster 先读本地 postgresql.conf（DataDir 是本地目录）
2. guc.c:2091 → polar_mount_and_extra_load_polar_settings()
   ├─ polar_init_node_type(): 按 standby.signal/replica.signal 判角色
   └─ polar_load_vfs() (miscinit.c:2032): load_file("polar_vfs") dlopen 插件
3. 插件 _PG_init(): 注册 GUC → polar_init_vfs_function() 填 polar_vfs[PLUGIN]
   → polar_vfs_init() → polar_register_vfs_fun_hooks()
4. polar_vfs_init() (polar_vfs.c:214):
   ├─ replica 节点 → POLAR_VFS_RD 只读挂载
   ├─ localfs_mode → posix_memalign 分配 1MB 对齐 directio_buffer
   └─ 否则 PFSD_INIT_MOUNT_ARG(集群名, 磁盘名, hostid, flag)
      → polar_mount() → pfsd_mount() (polar_pfsd.c:436)
5. 挂载后 polar_setting_file_global_to_local() 把共享存储上的
   polar_settings.conf 拷回本地再解析
   （why: VFS 不提供 FILE*，ProcessConfigFile 的 stdio 解析路径没法直接读 PFS）
6. startup: replica 从共享存储复制 base/ 骨架、pg_twophase、SLRU 事务状态
   到本地 + pg_control 本地副本
```

**本地 vs 共享的目录划分**（权威清单来自 `src/bin/initdb/polar-initdb.sh:200-258`）：

| 放共享存储 | 留本地 |
| --- | --- |
| `base`、`global`（pg_control、polar_settings.conf）、`pg_tblspc`、`pg_wal`、`pg_logindex`、`pg_twophase`、`pg_xact`、`pg_commit_ts`、`pg_multixact` | `postgresql.conf`/`pg_hba.conf`、`pg_replslot`、`pg_stat*`、`pg_log`、`pg_notify`、`pg_serial`、`pg_snapshots`、`pg_subtrans`、`pg_dynshmem`、临时文件（`fd.c:1795` 生成**相对路径** → 进程 cwd = 本地 DataDir → 落本地盘） |

**polar_datadir 与 DataDir 的关系（无软链，双目录结构）**：DataDir（本地）——postmaster `chdir` 到这里，配置文件、节点私有目录、相对路径访问都落这里；polar_datadir（共享）——`polar_make_file_path_level2/3`、`POLAR_DATA_DIR()`（miscadmin.h:583）、`polar_get_database_path()` 显式拼出的路径指向它，其值自带路由信息。**没有 `local/` 子目录约定**，而是**同名目录两边各一份**——共享侧是权威副本，replica 本地侧是缓存。

## 核心实现

### PFS 接口（polar_pfsd.c）：PFSD 客户端

`pfsd_*` 系列来自 **PolarFS Daemon 的用户态客户端 SDK**（头文件 `pfsd_sdk.h`）：configure 用 `--with-pfsd`（configure.ac:953-968）开启并定义 `USE_PFSD`，库链到 `/usr/local/polarstore/pfsd/lib -lpfsd`。进程通过本地 pfsd daemon 访问网络共享块存储（盘古），PBD 以磁盘名标识，`pfsd_mount(cluster, pbdname, hostid, flags)` 完成"挂载"。

包装层做的三件事（`polar_vfs_pfsd`，polar_pfsd.c:58-135）：

1. **单次 IO 上限分片**：`pfsd_read/pfsd_write` 单次调用有大小限制，`polar_pfsd_pread/pwrite`（:249/341）循环按 `polar_vfs.max_pfsd_io_size`（默认 4MB）切片，每次 `writesize = Min(nleft, max_pfsd_io_size)`；单次返回 ≤ 0 时若已写 count==0 则 count=res 并 break（传递错误）；
2. **补齐 vectored 接口**：SDK 无 preadv/pwritev → 用 `aligned_malloc(PG_IO_ALIGN_SIZE)` 聚合或逐 iov 模拟；SDK 缺失的操作以 NULL 占位——`vfs_lstat = pfsd_stat`、`vfs_mmap = NULL`、`vfs_fdatasync = NULL`；
3. **flag 翻译**：`polar_transform_pfs_flag()`（:169）把 `POLAR_VFS_RD/RDWR/PAXOS_BYFORCE/TOOL` 逐位映射为 SDK 的 `PFS_RD/PFS_RDWR/PFS_PAXOS_BYFORCE/PFS_TOOL`。

`USE_PFSD` 未定义时整个结构体退化为全 NULL 桩——保证无 PolarStore 环境可编译（配合 localfs 模式跑测试）。SQL 函数 `polar_libpfs_version()`（polar_vfs.c:319，运行时报 SDK 版本）与 `polar_vfs_disk_expansion(text)`（:138，`pfsd_mount_growfs` 在线扩盘）由 extension 的 SQL 文件暴露。

**RO→RW 切换**：`polar_postmaster_online_promote()`（postmaster.c:5124）等所有普通 backend 退出后，以 `POLAR_VFS_RDWR | POLAR_VFS_PAXOS_BYFORCE` 调 `polar_remount()` → `vfs_remount()`（polar_vfs_interface.c:321）→ `pfsd_remount()`。`PAXOS_BYFORCE` 是在 RO 节点还持有租约时强制改写权限位（PFS 内部用 Paxos 维护挂载视图）。

### DirectIO（polar_directio.c）：正确性问题而非性能问题

**Why**：共享存储读写的正确目标态是 DIO 语义——PFS 本身无 OS page cache（用户态网络栈），数据只进 PG shared buffer。若本地盘路径仍走 buffered IO，会出现 **PG buffer + kernel page cache 的 double buffer**，且 localfs 测试模式与真实 PFS 行为不一致。因此 localfs 模式用 `polar_datadir='file-dio://...'`（`build.sh:99`、TAP `Cluster.pm:3929`）强制数据目录走 `polar_vfs_dio` 后端，**让单机测试环境逼真模拟共享存储的 DIO 语义**。另注意 PG17 原生 `io_direct` GUC 在 `md.c:170-177` 也能给数据文件加 `PG_O_DIRECT`——那是上游机制，与 VFS 的 `file-dio://` 是两条并行路径。

实现细节（复杂度都在边界处理）：

- `polar_directio_open()`（:138）：只对已存在的 regular file 或 ENOENT 新建文件加 `PG_O_DIRECT`（目录不能 O_DIRECT）；`O_WRONLY` 与 O_DIRECT 冲突 → 换成 `O_RDWR`；
- `polar_directio_pread()`（:218）三段式：把 `[offset, offset+len)` 切成 **head（对齐边界前残段）/ middle（按 `polar_vfs.max_direct_io_size` 默认 1MB 分块）/ tail** 三节，头尾残段经 1MB 对齐缓冲中转 memcpy；
- `polar_directio_pwrite()`（:415）：头尾残段是 **pread-modify-pwrite**；**关键细节**：O_DIRECT 的 pwrite 会把文件扩展到 4096 的整数倍导致文件大于期望——`need_truncate` 检测后 `ftruncate` 修回（注释点名 `ReadTwoPhaseFile` 等依赖精确文件大小的调用者）。

### fd.c / md.c 改造点

fd.c 的做法是**把所有触及内核 fd 的调用点替换为 polar_ 前缀**，VFD/LRU/temp file 管理逻辑不动：

- `BasicOpenFilePerm()`（fd.c:1141）：`open` → `polar_open`；
- **`FileRead/FileWrite` 是 `fd.h:212-233` 的 inline 包装** → `FileReadV/FileWriteV`（fd.c:2149/2205）→ `polar_preadv/polar_pwritev`——**每一次 VFD 级读写都过 VFS 分发**；
- `FileZero()`（fd.c:2337）增加 `bulkwrite` 参数：true 走 `polar_pwrite_zeros()`（`src/common/file_utils.c:783`，用全局共享内存 zero buffer），false 落回上游 `pg_pwrite_zeros`；
- `durable_rename/durable_unlink/MakePGDirectory/RemovePgTempFiles` 全部换 polar_ 前缀。

md.c 的关键改造：

- **`mdzeroextend()`（md.c:619-678）按 `polar_zero_extend_method` 三分支**（默认 `bulkwrite`）：`fallocate`（posix_fallocate 空洞分配，共享存储上避免逐块写零）/ `bulkwrite`（默认，批量写零）/ `none`（上游行为）；
- 新增三个 f_smgr 钩子（smgr.c:111-119）：`polar_smgr_bulkread/bulkwrite/bulkextend` → `polar_mdbulkread`（:1109）/`polar_mdbulkwrite`（:1311）/`polar_mdbulkextend`（:708）。调用方：`polar_smgrbulkread` ← `catalog/storage.c:552`（`CREATE DATABASE`/`CREATE TABLE LIKE` 批量拷页，GUC `polar_bulk_read_size`）；`polar_smgrbulkwrite` ← `bufmgr.c:4403`（polar 并行 bgwriter 的合并刷脏，见 [03 Buffer 一致性](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency)）；
- **PFS 专属优化**：`XLogFileInit`（xlog.c:3595 附近）在 `polar_vfs_type(fd) == POLAR_VFS_PFS` 时用 `polar_fallocate(fd, FALLOC_FL_NO_HIDE_STALE, ...)`（GUC `polar_enable_fallocate_no_hide_stale`）——**PFS 支持免清零分配**，跳过 WAL 段全量写零。`vfs_type()` 接口的存在意义就是让上层做这类**后端感知的条件优化**。

### 批量 IO：共享存储的第一优化杠杆

| GUC（guc_tables.c:3700-3730，POLAR_IO_MANAGEMENT 组） | 默认 | 场景 |
| --- | --- | --- |
| `polar_recovery_bulk_extend_size` | 512 块（SIGHUP） | 恢复重放时 `XLogReadBufferExtended`（xlogutils.c:665）和 logindex 并行回放一次把文件扩到 `target+N` 块——**共享存储上每次小 extend 都是一次跨网络往返 + 元数据操作**，重放大批页时逐块扩展是数量级的浪费；小于阈值的表退回单块（防小表膨胀） |
| `polar_bulk_write_maxpages` | 128 页（USERSET） | `smgr_bulk_write()`（bulk_write.c:274）自动 flush 阈值——控制 PG17 新 `BulkWriteState` 在共享存储上的聚合页数 |
| `polar_bulk_read_size` | — | relation copy 批量读 |
| `polar_max_direct_io_size` | 1MB | DIO 主体分块 |

### extension 形态：为什么是 .so 插件而非静态链接

`polar_vfs.control`（`trusted = true`）+ `polar_vfs--1.0.sql`。静态内核只留数组骨架和内联分发。理由：

1. **外部二进制依赖隔离**：libpfsd 是部署在特定环境的 PolarStore 组件，`--with-pfsd` 条件编译 + 动态加载让不带 PolarStore 的环境（CI、开发机 localfs 模式）能构建运行；
2. **一份代码两种产物**（`src/polar_vfs/Makefile`）：`libpolarvfs.a`（`-DFRONTEND`，前端工具静态链）和 `polar_vfs.so`（`*_srv.o`，后端 dlopen）——公共文件用 `%_srv.o` 规则编译两遍；
3. **加载顺序可控**：GUC `polar_internal_shared_preload_libraries`（默认 `polar_vfs,polar_resource_manager,pg_cron,...`）让 polar_vfs **先于普通 `shared_preload_libraries`** 加载（miscinit.c:1936）——其他插件初始化可能就要做共享存储 IO。

### 前端工具读写共享存储（polar_vfs_fe.c）

接入的前端工具（都链 `$(polar_libvfs)`）：`pg_basebackup`、`pg_waldump`、`pg_checksums`、`pg_controldata`、`pg_ctl`、`pg_resetwal`，外加 [07 的 polar_tools](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/07-process-ops)。典型流程（pg_resetwal.c:377-409）：

1. `polar_vfs_init_simple_fe(pgconfig, datadir, POLAR_VFS_RDWR)`（fe.c:696）；
2. 该函数用 **`postgres -C <guc> -D <datadir>` 子进程**读取配置（`polar_get_config()`，fe.c:517）——配置解析逻辑复杂（include、条件段），复用 postgres 自身解析最可靠；
3. `polar_vfs_init_fe()`（fe.c:380）真正挂载，前端特有处理：hostid 默认 `PG_TOOL_HOSTID (0)`（root 以 `POLAR_VFS_TOOL` 标志像 pfs 命令行工具一样访问，绕过节点身份）；
4. `polar_vfs_state_backup/restore`（fe.c:743）支持 pg_basebackup 在**源/目标两套存储参数**间切换；
5. fe.c 末尾提供 `errstart/errmsg` **前端桩**（fe.c:824）——让共享代码里的 `ereport/elog` 在 FRONTEND 下能编译运行。

### Hook 体系：只读节点写保护

`polar_vfs_interface.h:122-132` 定义三组 hook（env / file / io，各分 before/after）。`polar_register_vfs_fun_hooks()`（polar_vfs.c:403）挂上 `polar_vfs_file_handle_node_type` / `polar_vfs_io_handle_node_type`：`polar_is_replica() && !polar_vfs_is_writable()` 时对写类操作报 **PANIC（LOCAL_DIO）或 WARNING（PFS）**（polar_vfs.c:329-396）——这是只读节点写共享存储的核心闸门。注意 `_PG_init` 在**子 backend 重复进入**时（非 `process_shared_preload_libraries_in_progress` 阶段）只 elog WARNING 并直接 return——初始化只在 postmaster preload 期做一次。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 函数指针结构体 + 内联分发 | `vfs_mgr`（polar_fd.h:126）+ `polar_*` inline | 关闭开关时编译成 libc 直调，零抽象税 |
| 协议前缀路由 | `polar_vfs_kind` 表（interface.c:139） | polar_datadir 一个 GUC 同时携带位置与路由信息 |
| 虚拟 fd 掩码 | `POLAR_VFS_FD_MASK`（interface.c:26） | 与真实 fd 命名空间隔离 |
| 插件骨架 | `polar_vfs.control` + `_PG_init` | 外部库隔离 + 加载顺序控制 |
| hook 防护 | `polar_vfs.c:329-396` | 只读保护不侵入各调用点 |

## 模块间交互

- **被所有数据面模块依赖**：[01 LogIndex](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex) 的 `.tbl`/meta/bloom I/O 走 `PathNameOpenFile/FileWrite`（经 VFS 分发）；[02 并行回放](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/02-wal-meta-replay) 的 worker 从共享存储读 WAL/数据页；[03 Buffer](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency) 的 write-combine 批量刷脏调 `polar_smgrbulkwrite`；[06 TDE](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/06-tde) 的 `pg_kmgr` 共享存储路径由 `polar_make_file_path_level2`（polar_fd.h:433）映射。
- **与 [05 本地缓存体系](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/05-local-cache) 的分工**：SLRU 本地段缓存（`polar_local_cache`）建立在 VFS 之上——`POLAR_SHARED_FILE_PATH` 宏回源共享存储读取，本地写入走 LOCAL_BIO。
- **与 [07 进程运维](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/07-process-ops)**：polar_tools/前端工具链 `$(polar_libvfs)`；在线 promote 的 `polar_remount` 是本模块接口。

## 扩展方式

**新增一种存储后端**（如 NFS / 对象存储），改动清单：

1. `src/include/storage/polar_fd.h`：`PolarVFSKind` 枚举（:66-73）加 `POLAR_VFS_NFS`（放在 `POLAR_VFS_KIND_SIZE` 前）；加协议宏 `#define POLAR_VFS_PROTOCOL_NFS "nfs://"`（:39-41 旁）；声明 `extern const vfs_mgr polar_vfs_nfs;`；
2. 新建 `src/polar_vfs/polar_nfs.c`：实现 `const vfs_mgr polar_vfs_nfs = {...}`（参考 `polar_pfsd.c`——SDK 有单次大小限制需分片；`vfs_type` 返回新 kind）；
3. `src/polar_vfs/polar_vfs_interface.c`：`vfs[POLAR_VFS_KIND_SIZE]` 数组（:120）插入 `&polar_vfs_nfs`；`polar_vfs_kind` 协议表（:139）加新前缀——改格式必须同步 `polar_path_remove_protocol()`（polar_fd.h:417）；
4. `src/polar_vfs/Makefile`：`OBJS_COMMON` 加 `polar_nfs.o`；
5. 需要挂载语义则实现 `vfs_mount/vfs_remount/vfs_umount`；需要 GUC 则在 `polar_vfs.c` `_PG_init` 里 `DefineCustom*`。

**零改动项**：`fd.c`/`md.c`/上层调用者完全不动——这正是该抽象的价值；hook 点（`polar_vfs_*_hook`）已预留，可在插件外挂监控/审计而不碰核心代码。
