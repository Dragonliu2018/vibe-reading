---
source:
  type: "源码解读"
  project: "polardb-pg"
  url: "https://github.com/polardb/PolarDB-for-PostgreSQL"
title: "Overview"
date: "2026-09-26T23:25:20+08:00"
category: [Database, OLTP, PolarDB, CodeWiki, "17.11.1.0"]
contentType: "CodeWiki"
tags: ["PolarDB", "PostgreSQL", "存算分离", "LogIndex", "一写多读", "云原生", "并行回放"]
description: "PolarDB for PostgreSQL 源码解读总览：基于 PG 17.11 的存算分离内核——LogIndex 页面级倒排索引、WAL 元数据复制、copy buffer 刷脏协调、增量 checkpoint 与并行回放。"
readingTime: "32 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** v17.11.1.0 · **协议** Apache-2.0（含 PostgreSQL License 组件）· **基线** PostgreSQL 17.11 · **代码量** src/ ~143 万行 C（相对上游 +11.6 万行）· **仓库** [GitHub](https://github.com/polardb/PolarDB-for-PostgreSQL)

---

## 总览

### 项目简介

PolarDB for PostgreSQL 是阿里云自主研发的云原生数据库，100% 兼容 PostgreSQL，采用基于 Shared-Storage 的**存储计算分离**架构。它把数据库从传统的 shared-nothing（N 份计算 + N 份存储）转变为 **N 份计算 + 1 份存储**：所有计算节点（一个 RW 读写节点 + 多个 RO 只读节点）共享同一份 PolarStore 共享存储上的数据。

核心价值：**极致弹性**（计算与存储独立横向扩展，扩容不复制数据）、**毫秒级延迟**（RW 到 RO 仅复制 WAL 元数据而非数据）、**HTAP 能力**（本系列覆盖的存算分离主线外，`distributed` 分支另有基于共享存储的 MPP 并行执行引擎）。

项目边界：本仓库是存算分离内核（`POLARDB_17_STABLE` 分支主线），分布式执行引擎（px）在 `distributed` 分支、多模特性（向量/GIS/图谱）以 extension 形态存在于 `external/`，均不在本系列展开。相对上游 PostgreSQL 17.11 的 diff 为 **738 文件改动、+116,379 行**（326 新增 / 412 修改），全部改造以 `/* POLAR */` 标记块标注（全树 ~4,800 处）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 存算分离存储路由 | `src/polar_vfs/` + `storage/file/polar_fd.c` | 本地 / PolarFS / DirectIO 三后端 VFS 分发 |
| LogIndex 页面级倒排索引 | `src/backend/access/logindex/`（22 文件 ~2.1 万行） | 记录 BufferTag→LSN 链，支撑按页回放 |
| WAL 元数据复制 | `walsender.c`（+842 行）+ `polar_queue_manager.c` | 'y' 消息只发 meta，payload 从共享存储读 |
| 并行回放 | `storage/ipc/polar_procpool.c` + `polar_logindex_redo.c` | tag 亲和任务队列，默认 16 worker |
| Buffer 一致性 | `storage/buffer/polar_*.c` + `polar_parallel_bgwriter.c` | copy buffer 池 + flush list + 四 LSN 安全带 |
| 增量 checkpoint | `polar_bufmgr.c` + `polar_checkpoint_ringbuf.c` | redo 点 = consistent_lsn，常规 checkpoint 降级 |
| RO 本地缓存 | `polar_local_cache.c` + `polar_rsc.c` + `polar_rel_size_cache.c` | clog/multixact 本地化 + 关系大小双缓存 |
| TDE 透明加密 | `storage/encryption/`（5 文件）+ `external/polar_tde_utils` | 页级 AES-CTR/SM4，在线启用 |
| 多 syslogger + 审计日志 | `syslogger.c`（+620 行）+ `utils/error/elog.c` | audit 通道按 PID 分片 |
| 集群参数管理 | `utils/polar_parameters_manage/` | 共享存储 polar_settings.conf + WAL 同步 |
| 在线 promote | `postmaster.c:5099` | RO 无重启变 RW（remount + 存量 backend 排空） |
| 离线修复工具 | `src/bin/polar_tools/` | 不启动实例 dump/修复 pg_control 与 logindex |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| PostgreSQL 17.11 | 核心 | 上游基线（REL_17_11 tag 合并） |
| PFSD SDK（`--with-pfsd`） | 可选 | PolarFS 共享存储客户端（`/usr/local/polarstore/pfsd`） |
| OpenSSL（`--with-tde`） | 可选 | TDE 加密（AES-128/256-CTR、SM4-CTR、AES-KW、HMAC-SHA256） |
| meson / autoconf | 构建 | 双构建系统（继承上游） |
| Perl TAP | 测试 | `src/test/polar_pl` 等（`perl/PolarDB/DCRegression.pm` 框架） |

### 版本历史

版本号机制（configure.ac:49）：`POLAR_VERSION = PG版本.小版本`，如 v17.11.1.0 = PG 17.11 + PolarDB 1.0。tag 节奏跟随上游季度版合并：

| tag | 日期 | 合并的上游 |
| --- | --- | --- |
| v15.8.2.0 … v15.19.5.0 | 2024~2026-08 | PG 15.x 系列（并行维护） |
| v17.9.1.0 | 2026-03 | PG 17.9 |
| v17.10.1.0 | 2026-05 | PG 17.10 |
| **v17.11.1.0（本系列）** | **2026-08** | **PG 17.11**（merge commit ff510dfcb41） |

本系列解读基于 v17.11.1.0（tag 指向 "merge: resolve conflicts of merging PostgreSQL 17.11"，2026-08-18）。

## 快速上手

最快体验（单机镜像，内置 localfs 模式模拟共享存储）：

```bash
docker pull polardb/polardb_pg_local_instance:17
docker run -it --cap-add=SYS_PTRACE --privileged=true --rm polardb/polardb_pg_local_instance:17 psql
```

```text
postgres=# SELECT version();
 PostgreSQL 17.x (PolarDB 17.x.x.x build xxxxxxxx) on {your_platform}
```

源码编译并拉起本地 demo 集群（primary + standby + replica 三节点，验证存算分离全链路）：

```bash
./build.sh -m --ws=1 --wr=1          # 最小扩展集编译 + init standby + init replica
psql -p <primary_port> -c "CREATE TABLE t(i int); INSERT INTO t VALUES(1);"
psql -p <replica_port> -c "SELECT * FROM t;"   # replica 直接读到 —— 数据经共享存储同步
```

集群布局由 `src/bin/initdb/polar-initdb.sh` 定义：`global/`、`pg_wal`、`pg_logindex`、`pg_xact` 等放共享存储（`pfs cp` 上去），`postgresql.conf`、`pg_replslot` 等留本地。

## 架构设计解析

### 系统架构

架构思想三句话：

1. **N 份计算 + 1 份存储**——数据只有一份，RW 与所有 RO 共享；存储容量与 I/O 不足时单独扩存储集群，不中断业务。
2. **网络上只传 WAL 元数据**——RW 向 RO 发送的是去 payload 的 WAL 记录骨架（record header + block reference，即"哪个 LSN 改了哪个页面"）；数据本体（完整 WAL 段与数据页）在共享存储上，RO 按需直读。一写多读场景下 WAL 发送是 N 倍放大，去掉 payload 把网络占用降约一个数量级。
3. **用 LogIndex 把顺序回放改造成页面粒度回放**——PG 原生 standby 严格按序回放每条 WAL；LogIndex 记录 `(BufferTag → 有序 LSN 链)` 后，不同页面天然无依赖，可以 lazy 回放（读到的页才回放）、并行回放（多 worker 按页分发）、合并回放（积压 LSN 一次迭代连续回放）。代价是需要 mini transaction 补回"一条记录多页面"的原子性，以及一套 flush list/copy buffer 的刷脏协调。

![PolarDB 分层架构](/vibe-reading/images/articles/polardb-pg-17.11.1.0/architecture.svg)

RW 刷脏侧的核心是**四 LSN 安全带**：`oldest_apply_lsn`（所有 RO 的最小回放进度，由 slot 上报）约束"RW 永不把新于它的页面刷上共享存储"；buffer 级 `oldest_lsn` 记录首脏位置；`consistent_lsn` = min(flush list 队头, copy 池) 是"共享存储一致性下界"兼增量 checkpoint 的 redo 点；page LSN 是页面当前版本。四者合起来保证磁盘上的页面版本对最慢的 RO 都要么"过去"要么"当前"，详见 [03 Buffer 一致性](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency)。

| 架构层 | 包含目录 | 层职责（为什么存在） |
| --- | --- | --- |
| 进程与运维层 | `postmaster/` 改造 + `utils/polar_parameters_manage/` + `src/bin/polar_tools/` + `external/` | 进程编排、集群参数、审计日志、离线修复 |
| 查询与 Buffer 一致性层 | `storage/buffer/polar_*.c` + `postmaster/polar_parallel_bgwriter.c` | 读写路径的页面版本一致性与刷脏协调 |
| WAL 与 LogIndex 层 | `access/logindex/` + `access/transam/` 改造 | 修改历史的索引、回放原子性、fullpage snapshot |
| 复制与并行回放层 | `replication/walsender|walreceiver` + `storage/ipc/polar_procpool.c` | meta 传输、tag 亲和任务分发、回放 worker 池 |
| 存储抽象层 | `src/polar_vfs/` + `storage/file/polar_fd.c` + `storage/smgr/` 改造 | 本地 / PFS / DIO 三后端路由，批量 IO |
| 安全横切 | `storage/encryption/` | 页级加密（buffer 与 smgr 之间） |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 函数指针表 + 宏分发 | `polar_idx_redo[]`（polar_logindex_redo.c:120）/ `vfs_mgr`（polar_fd.h:126）/ `child_process_kinds[]`（launch_backend.c:214） | 新增 rmgr / 存储后端 / 子进程类型零改动分发框架 |
| 生产者-消费者 ring buffer | `xlog_queue`（polar_queue_manager.c，同一结构 send/recv 两用） | meta 生成与消费解耦，walsender 零读盘 |
| 双迭代器 | page iter（polar_logindex_iterator.c:701）+ lsn iter（:1057） | "这一个页有哪些 LSN" vs "下一个该回放哪个页"两个正交需求 |
| 状态机 + 原子位 | mem table 四态 / bg_redo 三态 / `BufferDesc.polar_redo_state` | 跨进程协作免重量级锁 |
| 多级缓存 | FLUSHED 内存表 → 本地 segment_cache → 共享存储；SLRU 本地段 | RO 本地 SSD 挡住共享存储读放大 |
| hook 体系 | `polar_vfs` hooks（只读写保护）+ `polar_logindex_table_flushable_hook` | 策略注入不侵入调用点 |
| 优雅降级 | 'y' → 'p' → 读文件三级（walsender.c） | queue 满时退回文件复制，正确性不受损 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `log_index_snapshot_t` | LogIndex 全局快照（mem_table 环形数组 + bloom + meta） | shmem init 创建，fork 继承 | 两个实例：wal / fullpage |
| `log_item_head_t` | 页面条目头（tag + LSN 链头，48B 定长槽） | 随表分配，flush 后复用 | hash 桶 → head → seg 链 |
| `CopyBufferDesc` | 旧版本页外移槽 | 刷脏决策时分配，flush copy 后归还 | `origin_buffer` 指回原 buffer |
| `parallel_replay_task_node_t` | 回放任务 {tag, lsn, prev_lsn, kind} | dispatcher 产出，worker 消费 | task_hash 同 tag 依赖链 |
| `polar_local_cache_data` | SLRU 本地段缓存池 | ShmemInit 创建 | clog/commit_ts/multixact 各实例化一份 |
| `KmgrFileData`（pg_kmgr） | TDE 密钥文件（wrap 的 RDEK/WDEK + 双 HMAC） | initdb/bootstrap 创建 | 副本各自 unwrap |
| `vfs_mgr` | 存储后端操作表（~40 个 POSIX 操作） | 插件 `_PG_init` 填充 | 三后端各一份 const 实例 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `vfs_mgr` | polar_fd.h:126 | `polar_vfs_bio / pfsd / dio` | 插件 `_PG_init` 填 `polar_vfs[PLUGIN]` |
| rmgr 三件套（save/parse/redo） | polar_logindex_redo.h:116 | 11 个 `polar_*_idx.c` 适配文件 | `rmgrlist.h` 的 `PG_RMGR` 宏展开 |
| `polar_rsc_replica_redo_cb[]` | polar_rsc_replica.c | 各 rmgr 的 RSC 更新回调 | startup 回放循环逐条调用 |
| `f_smgr` 批量钩子 | smgr.c:111 | `polar_mdbulkread/write/extend` | smgr.c:143 静态注册 |
| `polar_task_sched_t` | polar_procpool.h:109 | 并行回放进程池 | shmem init + 动态 bgworker |

## 代码目录

```shell
PolarDB-for-PostgreSQL/
├── src/
│   ├── backend/
│   │   ├── access/
│   │   │   ├── logindex/          # LogIndex 引擎（22 文件 ~2.1 万行）★核心新增
│   │   │   └── transam/           # xlog/xlogrecovery/slru 深度改造（+4,791 行）
│   │   ├── replication/           # walsender(+842) / walreceiver(+392) / slot(+424)
│   │   ├── storage/
│   │   │   ├── buffer/            # polar_bufmgr / copybuf / flush / xlogbuf
│   │   │   ├── smgr/              # polar_rsc(_replica).c + md.c 改造
│   │   │   ├── file/              # polar_fd.c（VFS 内联分发的本地端）
│   │   │   ├── encryption/        # TDE（5 文件 1,220 行）
│   │   │   └── ipc/               # polar_procpool.c + shm limit（+1,838 行）
│   │   ├── postmaster/            # postmaster 改造 + parallel_bgwriter + async_lock_replay
│   │   └── utils/                 # polar_parameters_manage + error/elog 审计改造
│   ├── polar_vfs/                 # VFS 插件（三后端 + polar_vfs_fe.c 前端）
│   ├── bin/
│   │   ├── polar_tools/           # 离线修复工具（6 子命令）
│   │   └── initdb/polar-initdb.sh # 共享存储集群初始化
│   └── test/                      # polar_pl / polar_consistency / modules / perl/PolarDB
├── external/                      # 9 个 polar_* 组件 + 第三方扩展（1,377 文件全新增）
├── package/                       # debian / rpm 打包
└── build.sh                       # 编译 + demo 集群初始化
```

`src/tools/` 下的 `polar_copyright_check.pl`、`polar_check_guc_short_desc.pl`、`delta_coverage.pl`（新代码测试覆盖率检查）、`polar_sort_subdir.pl` 是 CI 卫生工具；`.github/workflows/` 四条流水线（package/precheck/stylecheck/sync-postgres）消费它们。

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/polardb-pg-17.11.1.0/module-dependencies.svg)

依赖主轴是"数据同步面"（01/02）与"数据页路径"（03/06）落在"存储面"（04/05）之上，07 全局编排。`xlog_queue` ring buffer（polar_queue_manager.c）是 01 与 02 的物理交汇点；`oldest_apply_lsn`/`consistent_lsn` 水位是 02 与 03 的协议接口；`polar_vfs` 是所有落盘 IO 的必经之路。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| LogIndex 引擎 | BufferTag→LSN 链的存储/检索/持久化 | `log_index_insert_lsn`（polar_logindex.c:1926） | 独创数据结构，自成体系（含 mini transaction、bloom、双迭代器） | [01](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex) |
| 元数据复制与回放 | 'y' 消息协议 + 并行回放调度 | `polar_xlog_send`（walsender.c:5025） | 传输协议与回放调度是一个整体的两端 | [02](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/02-wal-meta-replay) |
| Buffer 一致性 | 四 LSN 安全带 + copy buffer + 增量 checkpoint | `polar_buffer_can_be_flushed`（polar_bufmgr.c:171） | 刷脏协调是 RW 侧独立的一整套机制 | [03](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency) |
| 共享存储 VFS | 三后端路由 + 批量 IO + 前端适配 | `polar_open` 等内联分发（polar_fd.h:225） | 存储侧入口，插件形态自成一层 | [04](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs) |
| RO 本地缓存 | SLRU 本地化 + RSC + rel_size 历史 | `polar_create_local_cache`（polar_local_cache.c:182） | "共享存储是 RW 的现在，RO 要自己的过去"这一独立问题域 | [05](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/05-local-cache) |
| TDE 透明加密 | 页级加密 + 密钥管理 + 在线启用 | `PageEncryptCopy`（bufpage.c:1553） | 脱胎于社区补丁的独立安全子系统 | [06](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/06-tde) |
| 进程与运维 | 进程编排 + syslogger + 参数管理 + polar_tools + external | `polar_postmaster_receive_promote`（postmaster.c:5099） | 运维平面与数据面正交 | [07](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/07-process-ops) |

## 运行时行为

### 启动流程

```text
postmaster
├─ 读本地 postgresql.conf（DataDir 为本地目录）
├─ SelectConfigFiles (guc.c:2091)
│   └─ polar_mount_and_extra_load_polar_settings (polar_cluster_settings.c:132)
│       ├─ polar_init_node_type: 按 standby.signal/replica.signal 判角色
│       ├─ polar_load_vfs: dlopen polar_vfs 插件
│       │   └─ _PG_init → polar_vfs_init → pfsd_mount 挂载共享存储
│       │      （replica 以 POLAR_VFS_RD 只读挂载）
│       └─ polar_settings.conf 共享→本地拷贝后装载
├─ InitializeKmgr（TDE 密钥，fork 前完成 —— postmaster.c:1433）
├─ CreateSharedMemoryAndSemaphores (ipci.c)
│   └─ polar_logindex_redo_shmem_init: xlog_queue + wal/fullpage 两个 logindex
│      snapshot + mini_trans + rel_size_cache + parallel_sched + copy buffer 池
│      （polar_shm_limit 启用时二分收缩 NBuffers）
├─ replica: startup 进程 polar_init_local_dir (miscinit.c:2097)
│   └─ 从共享存储拷贝 pg_xact/pg_commit_ts/pg_multixact 骨架 + pg_control.local
├─ startup: polar_logindex_redo_init → polar_logindex_snapshot_base_init
│   └─ 从共享存储加载 logindex meta + 预热最近若干张表
└─ 拉起子进程: syslogger × N → checkpointer → bgwriter（+并行 bgwriter 池）
   → B_BG_LOGINDEX → walsender / walreceiver → backends
   （polar_enable_early_launch_parallel_bgwriter: recovery 期间提前拉起）
```

对象装配要点：

- **`polar_logindex_redo_instance` 全局单例**是数据面心脏，shmem init 时创建，含 `mini_trans` + 两个 logindex snapshot + `xlog_queue` + `rel_size_cache` + `parallel_sched`；
- 配置覆盖优先级：本地 `postgresql.conf` → 共享存储 `polar_settings.conf`（`ALTER SYSTEM FOR CLUSTER` 写入、WAL 同步三节点）→ 命令行；RO 允许 `max_connections` 等五参数低于 RW（`polar_enable_parameters_inconsistency`，持续 WARNING 直到 WAL 追上）；
- TDE 密钥不进共享内存——postmaster 进程静态变量，子进程 fork 继承；
- 共享存储上的 pg_kmgr / pg_control 由 `polar_make_file_path_level2`（polar_fd.h:433）映射，副本各自在启动时验证 passphrase 并 unwrap。

### 核心运行流程

下面三条链路覆盖存算分离的主要运行模式：写入同步（RW→RO 全链路）、读路径兜底、刷脏协调。

#### 写入同步：UPDATE 从 RW 到 RO 回放完成

业务流程：用户在 RW 执行 UPDATE → WAL 与元数据产生 → 只传元数据给 RO → RO 写 LogIndex 并标记页面过期 → 并行回放 worker 读共享存储完成回放 → backend 读页兜底。

![一写多读数据流](/vibe-reading/images/articles/polardb-pg-17.11.1.0/data-flow.svg)

文字描述：backend 的 `heap_update` 调 `XLogInsert` 时，`ReserveXLogInsertLocation` 在 WAL 插入锁临界区内同时预留 ring buffer 空间（保证队列顺序 = WAL 顺序），`polar_xlog_send_queue_push` 把去 payload 的 meta（record header + block reference + 回放必需的 main_data）推入 `xlog_queue`。WAL 本体经 `XLogWrite` 落共享存储（`polar_fsync` 强制）。walsender 从 ring buffer 零读盘弹出 meta 组 'y' 消息——只发 `lsn <= flush_lsn` 的包，保证不发送可能因主库崩溃而丢失的 WAL；队列不可寻址时降级发 'p'（纯 LSN，零 WAL 字节），RO 切回从共享存储 WAL 文件直读。

RO 侧 walreceiver 把 meta 包写入自己同构的 `xlog_queue`，限频唤醒 startup；startup 的 `polar_logindex_parse_xlog` 先执行 save 回调把 `(BufferTag, lsn)` 写入 wal_logindex_snapshot（唯一写者），再在 mini transaction 页锁保护下给已驻留 buffer pool 的页面打 `POLAR_REDO_OUTDATE` 标记——**startup 不做任何页面回放**，回放瓶颈被移出主恢复循环。一致性到达后 `polar_logindex_wakeup_bg_replay` 按 GUC 置 `POLAR_BG_REPLICA_BUF_REPLAYING`（RO lazy：只回放 pool 内页面）或 `POLAR_BG_PARALLEL_REPLAYING`（standby/PITR/主库恢复：全量并行）。

并行模式下 dispatcher（B_BG_LOGINDEX 辅助进程）用 LSN 迭代器产出任务，`polar_sched_add_task` 按 tag 哈希把同页任务固定发到同一 worker（天然串行），依赖链未完成则 HOLD 并由前驱精确唤醒。worker 从共享存储读完整 WAL 记录（经 `polar_xlog_page_buffers` 页缓存）与旧数据页，`PageGetLSN(page) <= lsn` 时应用 redo 并标脏；全局 running queue 按 LSN 有序推进 `bg_replayed_lsn`。RW 侧的 logindex saver bgworker 异步消费同一 ring buffer 生成 RW 自己的 logindex（供崩溃后 instant recovery 使用）。

#### 读路径兜底：future page 的恢复

RO backend 读页 miss 时，`smgrreadv` 从共享存储读到旧版本页——但若 RW 因内存压力已把新版本刷上盘（违反安全带的例外路径），页面 LSN 会大于 RO 回放进度（future page）。此时 `polar_logindex_restore_fullpage_snapshot_if_needed`（polar_logindex_redo.c:3277）在 fullpage logindex 中查 `[replayed_lsn, ∞)` 的 FPSI 记录，从共享存储 `polar_fullpage/` 段文件读旧页镜像覆盖 buffer，再从 checkpoint_lsn 起正常回放；重试超过 `polar_wait_old_version_page_timeout`（默认 30s）则 FATAL。已在 pool 的页面由 `polar_lock_buffer_ext`（bufmgr.c:5967）发现 `POLAR_REDO_OUTDATE` 后由 backend 自己回放至最新——**任何加锁都可能触发回放**，这是 lazy replay 的入口。

#### 刷脏协调：一条脏页的三种出路

RW 的 bgwriter/checkpointer 扫描时对每条脏页走 `SyncOneBuffer` 四分支：页 LSN ≤ `oldest_apply_lsn` 直接刷；不能刷但满足条件则先写 FPSI 全页镜像再刷（旧版本外置到共享存储段文件，WAL 里只有 tag + 编号）；有 copy buffer 且可刷则刷 copy 版本；都不行且值得 copy 则 `memcpy` 当前版本进 copy 池（原 buffer 保持脏继续演进，一致性义务转移给 cbuf）。`consistent_lsn` = min(flush list 队头, copy 池) 由 bgwriter 周期计算，增量 checkpoint 的 redo 点直接取它——常规 checkpoint 退化"刷全部脏页"为"推进 redo 点 + 更新 control file"，刷脏节奏由 flush list 的 lag 流控接管（详见 [03](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency)）。

### 状态流

![状态流](/vibe-reading/images/articles/polardb-pg-17.11.1.0/state-flow.svg)

logindex 内存表四态由 `log_index_mem_table_t` 的原子 state 字段驱动（polar_logindex_internal.h:199）：插入侧表满或 LSN 前缀变化时置 INACTIVE 并唤醒 bg worker；追上未落盘的表时插入进程自保强制落盘（`log_index_force_save_table`）。回放模式三态由 `polar_get_bg_redo_state` 状态机分派（polar_logindex_redo.h）：startup 达一致性时按角色/GUC 选 lazy 或 parallel；RO 收到 promote 信号进入 ONLINE_PROMOTE（存量 backend 排空 + remount 共享盘），提升完成后转 instant recovery 的 PARALLEL_REPLAYING，回放追平后 `RequestCheckpoint(CHECKPOINT_FORCE)` 收尾。

## 典型修改场景

#### 场景 1：新增一种索引 AM 的 logindex 支持

改 4 处：新建 `src/backend/access/logindex/polar_XXX_xlog_idx.c`（三件套 save/parse/redo，BRIN 的 510 行是最小模板）；`logindex/Makefile` 加 OBJS；`polar_logindex_redo.h` 加声明；`rmgrlist.h` 的 `PG_RMGR` 行末三参数换函数名。详见 [01 扩展方式](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex)。

#### 场景 2：新增一种存储后端

改 4 处：`polar_fd.h` 加 `PolarVFSKind` 枚举 + 协议前缀宏 + 声明；新建 `src/polar_vfs/polar_nfs.c` 实现 `const vfs_mgr`；`polar_vfs_interface.c` 的 `vfs[]` 数组与协议表插条目；Makefile 加 OBJS。`fd.c`/`md.c`/上层调用者零改动。详见 [04 扩展方式](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs)。

#### 场景 3：把另一个 SLRU 也本地化

改 6 处：`xxx.c` 的 ShmemSize/ShmemInit + 三个包装函数；`polar_local_cache.c` 加 GUC 变量；`guc_tables.c` 注册；`miscinit.c` 的拷贝/清理挂点；`polar_logindex_redo.c` 的 promote 挂点。slru.c 框架零改动。详见 [05 扩展方式](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/05-local-cache)。

## 测试体系

```
src/test/
├── polar_pl/t/              # 32 个 TAP：GUC 校验、审计日志、async lock replay、
│                            #   xlog queue、bulk read/write、write combine 等
├── polar_consistency/t/     # 35 个 TAP：promote 全场景（twophase/kill/pending/
│                            #   memtable full/parallel replay/aborted xact…）
├── modules/
│   ├── test_logindex/       # logindex 单元（+3,167 行）
│   ├── test_local_cache/    # 本地缓存段
│   ├── test_xlog_buffer/    # WAL 页缓存
│   ├── test_bulkio/         # 批量 IO（polar_smgrbulkread/write/extend）
│   ├── test_polar_directio / test_polar_rsc / test_polar_shm_limit
├── encryption/t/            # TDE 5 个（需 --with-tde）
├── regress/sql/polar/       # 9 个 SQL 回归
└── perl/PolarDB/            # DCPRegression.pm（57KB 框架）+ Task.pm
```

| 代码层 | 测试类型 |
| --- | --- |
| logindex / 回放调度 | `test_logindex` + `polar_pl` 的 xlog queue / bulk 系列 |
| promote 一致性 | `polar_consistency`（35 个场景全覆盖） |
| VFS / 批量 IO | `test_polar_directio` + `test_bulkio` |
| 本地缓存 / RSC | `test_local_cache` + `test_polar_rsc` |
| TDE | `encryption/t`（密文 grep 断言 + 在线启用 + 三算法） |

新代码覆盖率由 `src/tools/delta_coverage.pl` 守门（CI precheck 流水线）。

## 阅读源码推荐路线

- 第一遍：理解部署形态与进程模型
  `README_zh.md` → `build.sh`（compile/init_primary/init_follower/init_cluster 函数）→ `src/bin/initdb/polar-initdb.sh`（哪些目录上共享存储）→ `postmaster.c` 搜 POLAR（进程清单 + 在线 promote `polar_postmaster_receive_promote`:5097）
- 第二遍：理解核心数据结构
  `src/include/access/polar_logindex_internal.h`（`log_index_snapshot_t`:386 / `log_item_head_t`:294 / 四态 mem table:199）→ `src/include/storage/polar_copybuf.h`（`CopyBufferDesc`）→ `src/include/storage/polar_fd.h`（`vfs_mgr`:126 + 两级分发:225）→ `src/include/access/polar_logindex_redo.h`（全局实例 `polar_logindex_redo_ctl_data_t`:78）
- 第三遍：理解写入同步主链路
  `xlog.c:1098` 的 `CopyXLogRecordToWAL` → `polar_queue_manager.c:524` 的 push → `walsender.c:4881` 的 `polar_send_physical_by_queue` → `walreceiver.c:1146` 的 'y' 处理 → `xlogrecovery.c:2335` 的 `ApplyWalRecord` → `polar_logindex_redo.c:619` 的 parse
- 第四遍：选择模块深入
  回放细节读 [01](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex)/[02](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/02-wal-meta-replay)；刷脏协调读 [03](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency) 的 `SyncOneBuffer` 四分支（bufmgr.c:3747）；存储路由读 [04](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs) 的 `polar_vfs_interface.c`；运维面读 [07](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/07-process-ops) 的 polar_tools。

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| LogIndex | WAL 的页面级倒排索引：`(BufferTag → 有序 LSN 链)`，只存 LSN 不存数据 |
| mini transaction | 把一条 WAL 记录内多个页面的回放绑成原子单元的机制（37 槽 coalesced hash + 页锁） |
| FPSI（fullpage snapshot） | 刷脏前把旧版本页外置到 `polar_fullpage/` 段文件（WAL 里只有 tag + 编号），供慢 RO 恢复旧页 |
| copy buffer | 刷不动时的旧版本外移池（默认 128MB），吸收 RW 写入速率与 RO 回放速率的不匹配 |
| `oldest_apply_lsn` | 所有 RO 的最小回放进度（slot 上报），RW 刷脏不可超越的闸门 |
| `consistent_lsn` | min(flush list 队头, copy 池)，共享存储一致性下界兼增量 checkpoint redo 点 |
| 'y' / 'p' / 'w' 消息 | RW→RO 元数据 / 降级纯 LSN / 完整 WAL（发 standby） |
| PFS / PFSD / PBD | PolarFS 共享存储 / 其用户态 daemon SDK / Polar Block Device（磁盘名标识） |
| RSC | Relation Size Cache，查询路径的关系大小共享内存缓存 |
| rel_size_cache | 回放路径的 (LSN→关系大小变更) 历史，回答"LSN X 时该块还存在吗" |
| localfs mode | `polar_vfs.localfs_mode`，本地目录 + `file-dio://` 前缀模拟共享存储 DIO 语义 |
| instant recovery | 主库崩溃后不等全量回放即提供读写服务（`polar_primary_parallel_replay_mode`） |
| 在线 promote | RO 无重启变 RW：排空 backend → remount 共享盘为读写 → 通知 startup/logindex |
| DCPRegression | `src/test/perl/PolarDB/DCRegression.pm`，PolarDB 的 TAP 集群测试框架 |

### 参考资料

- [PolarDB for PostgreSQL 官方文档](https://polardb.github.io/polardb-pg-docs/)（架构、部署、开发指南）
- [产品架构文档](https://polardb.github.io/polardb-pg-docs/zh/theory/arch-overview.html)
- 上游基线：[PostgreSQL 17.11](https://www.postgresql.org/docs/17/)（本仓库含 `REL_17_11` tag，可做精确 tree diff）
- 本系列七篇模块解读（见模块地图表）
