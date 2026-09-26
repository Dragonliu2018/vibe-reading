---
source:
  type: "源码解读"
  project: "polardb-pg"
  url: "https://github.com/polardb/PolarDB-for-PostgreSQL"
title: "进程结构与运维生态"
date: "2026-09-26T23:11:29+08:00"
category: [Database, OLTP, PolarDB, CodeWiki, "17.11.1.0"]
contentType: "CodeWiki"
tags: ["PolarDB", "PostgreSQL", "postmaster", "syslogger", "audit log", "polar_tools", "在线 promote"]
description: "PolarDB 进程模型改造：logindex 后台进程/多 syslogger/异步锁回放 worker、polar_shm_limit 二分收缩 NBuffers、集群级参数文件 polar_settings.conf、polar_tools 离线修复工具与 external/ 九组件生态。"
readingTime: "24 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/00-overview)

---

## 模块定位

PolarDB 对 PostgreSQL 进程模型的四类改造：**postmaster 子进程编排**（新增 logindex 后台进程、多 syslogger、异步锁回放 worker）、**共享内存限额**（`polar_shm_limit` 二分收缩 NBuffers）、**参数/日志运维体系**（集群级参数文件 + 审计日志三通道）、**外围生态**（`external/` 下 9 个 polar_\* 组件 + `src/bin/polar_tools` 离线修复工具）。

一个与直觉不符的核实结果：`src/backend/main/main.c`（454 行）在 v17.11.1.0 中**没有任何 POLAR 改造**——旧版本挂在 main.c 的启动期逻辑（挂载共享存储、加载 polar_settings.conf）已迁入 `src/backend/utils/misc/guc.c` 的 `SelectConfigFiles()`（:2091 调用 `polar_mount_and_extra_load_polar_settings`），是 GUC 装载流程内聚化的重构。

## 模块架构

新增子进程类型：

| 进程 | BackendType | 启动点 | 主函数 |
| --- | --- | --- | --- |
| logindex 后台进程 | `B_BG_LOGINDEX`（miscadmin.h:394） | `postmaster.c:1443/1815/2638` 三处 `StartChildProcess` → `LogIndexBgPID` | `polar_logindex_bg_worker_main()`（polar_logindex_bg_worker.c:157） |
| 异步锁回放 worker | 动态 BackgroundWorker | `polar_alr_launch_worker()`（xlogrecovery.c:1998，进入 redo 主循环前） | `polar_alr_worker_main()`（polar_async_lock_replay.c:273） |
| 多 syslogger ×N | `B_LOGGER` ×N | `postmaster.c:1121-1123` 循环 `SysLogger_Start(i)` 填 `SysLoggerPIDs[MAX_SYSLOGGER_NUM]` | `SysLoggerMain()`（syslogger.c:917） |
| parallel bgwriter 池 | 共享内存句柄池（非独立 fork） | `polar_init_parallel_bgwriter()`（ipci.c:462） | polar_parallel_bgwriter.c（见 [03 Buffer 一致性](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/03-buffer-consistency)） |

`B_BG_LOGINDEX` 通过 PG17 新引入的 `child_process_kinds[]` 分发表接入（`launch_backend.c:214`：`[B_BG_LOGINDEX] = {"logindex background worker", polar_logindex_bg_worker_main, true}`）——这是 PG17 子进程框架下最干净的挂接方式。

## 调用链路

### 在线 promote（RO 在线变 RW）

`polar_postmaster_receive_promote()`（postmaster.c:5099）的完整链路：

```text
收到 promote 信号
├─ ① 拒绝新连接（pmState 回 PM_STARTUP）
├─ ② SignalSomeChildren(SIGTERM, BACKEND_TYPE_NORMAL) 等所有普通 backend 退出
│     （避免旧 buffer 被 pin）
│     ——CountChildren(BACKEND_TYPE_NORMAL) == 0 才立即继续；
│       否则置 polar_wait_promote = true，在子进程退出路径上延迟触发
└─ ③ polar_postmaster_online_promote() (postmaster.c:5124)
   ├─ polar_remount(POLAR_VFS_RDWR | POLAR_VFS_PAXOS_BYFORCE)
   │  把共享盘从只读重挂为读写（失败 ereport(FATAL, "can't remount PBD")）
   └─ 依次 SIGUSR2 通知: startup → polar worker（按 POLAR_WORKER_PROCESS_NAME
      找动态 bgworker, postmaster.c:5156）→ logindex 进程
```

### crash 恢复重入

`postmaster.c:3633-3652` 在 `shmem_exit(1)` 之后、`CreateSharedMemoryAndSemaphores()` 之前重新执行 `polar_init_node_type()` + `polar_init_global_dir_for_replica_or_standby()`——因为节点身份来自**本地信号文件**（`replica.signal`/`standby.signal`，`polar_fd.c:469-512` 的 `polar_get_node_type_by_file()`），而 crash 期间 CM（集群管理器）可能改写了它。`checkControlFile()`（postmaster.c:1580）在共享存储模式下跳过 pg_control 检查——此刻共享盘还没挂载。

### 生命周期改造清单

- **logindex 进程的 crash 语义**：`postmaster.c:2865` 单独处理 `LogIndexBgPID` 退出——非 0 退出码即走 `HandleChildCrash` 触发全库重启；它与 checkpointer 同级被 SIGQUIT；startup 退出时清除 `POLAR_STARTUP_REMOVE_STATUS(polar_logindex_redo_instance, POLAR_STARTUP_RUNNING)`（postmaster.c:2553），保证 crash 后 logindex 并行回放 worker 不比 startup 活得久；
- **BGWORKER_CRASH_ON_ERROR 收紧**（postmaster.c:2956）：带该标志的 worker 任何非 0 退出都视为 crash（社区版只对 errno 特判）——并行回放类 worker 半途退出会留下不一致的 buffer 状态；
- **proxy sid 的取消请求**：`POLAR_IS_PROXY_SID(backendPID)`（sid > `POLAR_BASE_PROXY_SID=10000000`，backend_status.h:370）时，先 `polar_proxy_get_pid()` 用 cancel_key 鉴权并翻译回真实 PID 再发 SIGINT——Proxy 环境下客户端持有的不是后端真实 PID 而是 proxy 会话号。

## 核心实现

### 多 syslogger：audit 日志的分片吞吐

**通道拓扑**（`SysLogger_Start(int loggerIndex)`，syslogger.c:779）：

- **channel 0 = 原生 syslogPipe（`pipe()`）**：承载 error log + slow log；
- **channel 1..N-1 = `socketpair(AF_UNIX, SOCK_STREAM)`**（syslogger.c:827-833）：**只承载 audit log**；
- `polar_syslogger_num` 默认 3（syslogger.h:111），上限 16。

路由规则（`polar_write_channel()`，elog.c:4441-4464）：

```c
/* elog.c — 每个 backend 按 PID 哈希固定写一个 audit syslogger */
if (polar_enable_multi_syslogger && polar_syslogger_num > 1)
    if ((chunk_buf->proto.flags & POLAR_PIPE_PROTO_DEST_AUDITLOG) != 0)
    {
        channel_index = MyProcPid % (polar_syslogger_num - 1) + 1;
        lock_index = channel_index % NUM_SYSLOGGER_LOCK_PARTITIONS;  /* 16 个 LWLock 分区 */
    }
```

**Why 多进程**：audit log 是每条 SQL 一行（RDS 合规审计要求），QPS 高时单 syslogger 的单管道 read + 单线程格式化写盘是吞吐瓶颈。audit 通道按 PID 分片后，多个 syslogger 各自 `read()` 自己的 socketpair、写各自的 audit 文件（文件名带 index），error log 仍走单通道保序。同一 channel 的写者用 `SysLoggerWriterLWLockArray[16]` LWLock 分区串行化。

**EOF 语义的坑**（syslogger.c:360-378）：每个 syslogger 启动时关闭**其他所有** channel 的两端 fd——否则兄弟 syslogger 持有写端导致 EOF 永远不触发，无法"收集所有进程临终日志后最后退出"。

### 审计日志三通道

- **独立目的地位**（elog.h）：`LOG_DESTINATION_POLAR_AUDITLOG 64` / `LOG_DESTINATION_POLAR_SLOWLOG 128`，pipe 协议新 flag `POLAR_PIPE_PROTO_DEST_AUDITLOG 0x02 / SLOWLOG 0x04`（syslogger.h:70-71）；
- **独立文件**：后缀 `_audit.log` / `_slow.log` / `_error.log`，audit 文件名追加 `_{MyLoggerIndex}`；
- **专用格式符**（elog.c:3140-3200，log_line_prefix 扩展）：`%S` select 行数、`%U` update 行数、`%E` 影响/扫描行数（`polar_get_audit_log_row_count()`，pgstat.c:1820）、`%T` 语句耗时。行数来自 `Pg_audit_log` 结构（tcopprot.h:36）；
- **内容生成**：`postgres.c:1408/2491`——`check_log_statement()` 命中或 `polar_audit_log.is_need_audit` 时，走**旁路 API** `polar_write_audit_log(&edata, "statement: ...")`（elog.c:4379，注释 "Bypass elog framework for reducing buffer copy"）。**错误 SQL 也进 audit**：`polar_enable_error_to_audit_log`（默认 true）在 elog 输出错误时复制一份 edata 转 audit；
- **脱敏与截断**：`edata->needs_mask` + `polar_str_find_passwd()` 剥密码；`polar_shrink_audit_log()`（elog.c:4155）按 `polar_auditlog_max_query_length`（默认 2048）截断 SQL；
- **两级缓冲 flush**：backend 侧 audit chunk 先攒进 128KB 静态缓冲（`LOG_CHANNEL_WRITE_BUFFER_SIZE`，elog.c:139），过半或超 `polar_audit_log_flush_timeout`（默认 30000ms）才写管道；`before_shmem_exit(polar_audit_log_flush_callback)`（postgres.c:4666）连接退出前必 flush；syslogger 侧 `flush_syslogger_file` 主循环 `WL_TIMEOUT` 时顺带刷；`is_polar_audit_log_writing` 标志防递归；
- **页缓存驱逐**：轮转后旧文件 `polar_drop_log_page_cache()`（syslogger.c:2033，`posix_fadvise(POSIX_FADV_DONTNEED)`）主动驱逐页缓存，防止日志刷盘把数据页挤出去。文件数保留由 `polar_remove_old_syslog_files()`（syslogger.c:1919，每次轮转后**每个 syslogger 都执行**）按三个 GUC 上限分类清理：`polar_max_log_files`（默认 10，普通日志）/ `polar_max_auditlog_files`（默认 15）/ `polar_max_slowlog_files`（慢日志），三者均 < 0 直接 return；按 `Log_filename` 第一个 `%` 前缀 strncmp 过滤，`strcmp` 选字典序最小（最旧）的删除。

### polar_shm_limit：容器化防 OOM

三个 GUC（均 PGC_POSTMASTER、以 8K 块为单位、对用户隐藏）：`polar_shm_limit`（总上限，默认 0 = 关闭，由 DBaas/DBStack 控制面按实例物理规格下发）、`polar_shm_reserved`（预留偏置，默认 4MB）、`polar_shm_unused`（调试填充量）。

**实现——对 NBuffers 二分搜索**（`polar_get_shared_mem_total_size()`，ipci.c:230-320）：因为共享内存大小是 `shared_buffers` 的单调（非线性——`wal_buffers` 等随 NBuffers 变化）函数，且其他 Polar 组件（parallel bgwriter、logindex、RSC、ALR、xlog buffer）都往 `CalculateShmemSize()` 里加尺寸，所以用二分而非公式反解。二分后再 `NBuffers--` 并断言双向夹逼，若结果 < 16 直接 ERROR。

**Why**：云上实例跑在固定 cgroup/hugepage 预算里，RDS 场景要求用户只给一个"内存上限"，内核自己算出能塞下多大的 shared_buffers，而不是让用户配 shared_buffers 再撞 OOM。配套 `polar_output_shmem_stat()`（ipci.c:576）把最终 size 写进 `$PGDATA/polar_shmem_stat_file`，postmaster 建锁文件前先删旧文件（crash 后可能残留过期值）。

### 集群级参数：polar_settings.conf

目录 `src/backend/utils/polar_parameters_manage/`（`polar_cluster_settings.c` 539 行 + `polar_guc_flag_check.c` 154 行）。文件头注释写明完整设计：

- **共享存储上的实例级配置文件** `global/polar_settings.conf`，每个节点启动时**拷贝到本地做缓存**（`polar_setting_file_global_to_local()`，:445）：先 `unlink` 本地旧缓存再 `polar_copy_file` 从共享路径复制（三个理由：pfs 不支持 `FILE*` 接口而 PG 配置解析器需要；靠 rename 做并发控制，每次读都远程拷会读到中间态；只读本地缓存性能更好）。复制后本地文件不存在则 `ereport(FATAL)`；全局文件不存在时返回 false、上层 `polar_mount_and_extra_load_polar_settings` 只 WARNING（"may be caused by an old instance upgrade"）。装载前后用 `polar_check_config_file_change()`（:93）对 `postgresql.conf` + `postgresql.auto.conf` 两个文件做 CRC32 对比（`POLAR_CHECK_FILE_NUMS = 2`），启动期间被改动则 FATAL；
- **修改走 WAL**：`ALTER SYSTEM FOR CLUSTER` 语法 → `polar_cluster_setting_wal_write()`（:226）写 `PWT_ALTERSYSTEMFORCLUSTER` 类型 WAL（reload 变体为 `PWT_ALTERSYSTEMFORCLUSTER_RELOAD`）。三种 action 的注册数据：SET 注册 name + value（各 `strlen+1` 保证 `\0` 结尾）、RESET 只注册 name、RESET_ALL 不注册任何数据；`XLogFlush(XLogInsert(RM_XLOG_ID, POLAR_WAL))` 包在 `START_CRIT_SECTION` 内（flush 不可被 ERROR 打断，调用方之后配对 `END_CRIT_SECTION`，:223 注释）。RO/Standby 侧 `polar_cluster_setting_wal_redo()`（:313）重放——从 record 数据解析 `value = rec + sizeof(PolarSettingWalHeader) + strlen(name) + 1`（+1 跳过 `\0`），调 `AlterSystemSetConfigFileInternal(..., is_polar_redo=true, ALTOPT_CLUSTER)`，保证三节点一致；
- **ALTER FORCE**：`polar_alter_force_check()`（:493）——绕过 GUC 合法性校验强改参数的逃生门，只允许 `polar_` 前缀和 extension 参数，用于实例起不来时的抢救。

**参数不一致检测**（实现在 xlogrecovery.c:5166-5190）：PolarDB RO 节点规格可以与 RW 不同（小 RO 便宜），所以 `max_connections` 等五个参数允许从库**低于**主库。社区 PG 行为是暂停恢复甚至 FATAL；PolarDB 的 `polar_enable_parameters_inconsistency`（默认 true）打开时只置标志并 WARNING，每 `polar_warning_parameters_inconsistency_timeout` 秒（默认 300s）重查，持续报警直到 WAL 追上。

**`polar_apply_global_guc_for_super`**（postinit.c:1431）：默认不把 `pg_db_role_setting` 的 GLOBAL 层装载进超级用户会话——DBaas 控制面账号可通过 `ALTER ROLE ALL SET` 下发全局设置，若作用于超级用户会话可能劫持其行为（如 search_path 注入）；确需恢复社区行为时打开此开关。

**GUC flag 自检**（`polar_guc_flag_check.c`）：debug build 下每个 `polar_` 前缀 GUC 必须显式标注 `POLAR_GUC_IS_VISIBLE|POLAR_GUC_IS_INVISIBLE` 和 `POLAR_GUC_IS_CHANGEABLE|POLAR_GUC_IS_UNCHANGEABLE`（guc.h:260-265，用于 DBaas 控制台展示"用户可见/可改"矩阵），否则 FATAL——消费方是 external 的 `polar_parameter_manager.polar_get_guc_info()`。

### 异步锁回放（polar_async_lock_replay）

**Why**：RO 用 logindex 做并行回放，但 `XLOG_STANDBY_LOCK` 记录（DDL 的 AccessExclusiveLock）必须调 `LockAcquire()`，而 `LockAcquire` 可能阻塞等待（与查询持有的锁冲突），会把并行回放流水线卡死在一条锁记录上。

**三角色协作**（`polar_async_lock_replay.c`，535 行，生效条件 `polar_allow_alr() = polar_enable_async_lock_replay && polar_is_replica()`）：

- **startup（生产者）**：`standby_redo()` 处理 `XLOG_STANDBY_LOCK` 时不再 `StandbyAcquireAccessExclusiveLock`，改 `polar_alr_add_async_lock()`（standby.c:1276）入队后**立刻继续回放**；
- **worker（消费者）**：`polar_alr_worker_main()` 死循环 `alr_try_to_acquire_lock()`（逐个出队、查 `TransactionIdDidCommit/Abort` 已完结则 SKIP、否则 `LockAcquire(AccessExclusiveLock, sessionLock=true)`）+ `alr_try_to_release_xact()`。拿到锁后 `WakeupRecovery()` + `WalRcvForceReply()`；
- **必要的顺序回退点**：同一事务的**后续 WAL 记录**回放前要等它的锁到手——`xlogrecovery.c:2303-2317`：`polar_alr_xact_is_replaying(record->xl_xid)` 为真时 startup 在 `recoveryWakeupLatch` 上等 worker。即"锁回放异步化、但同事务数据回放仍受锁约束"，保证 DDL 的可见性顺序不被破坏；worker 已死还遇到运行中事务则 PANIC（宁崩不留脏状态）；
- **对主的反馈**：`walreceiver.c:1484`——standby feedback 消息里多带 `lockPtr = polar_alr_ctl->lsn`（最老未回放完的锁 LSN），主库据此做 quarantine 决策。

### polar_tools：离线修复工具箱

单二进制多子命令（`src/bin/polar_tools/`，`polar_tools.c` 的 `main()` 字符串分发表）：

| 子命令 | 源文件 | 功能 |
| --- | --- | --- |
| `dump-block-header` | `block_header_dump.c` | 读任意数据文件第 N 块的 `PageHeaderData`，判页损坏 |
| `control-data-change` | `control_data_change.c` | **离线改 pg_control**：`-p` 改 redo、`-c` 改 checkPoint 指针，重算 CRC32C 写到新文件。用于实例起不来时强制回拨恢复起点 |
| `logindex-meta` | `logindex_meta_dump.c` | dump logindex 元文件，校验 magic/version/CRC |
| `logindex-table` | `logindex_table_dump.c` | dump logindex 表文件 |
| `logindex-bloom` | `logindex_bloom_dump.c` | 按指定 buffer tag dump bloom filter 项 |
| `logindex-page` | `logindex_page_dump.c` | dump logindex 页内指定 tag 的 LSN 链 |

**核心价值：不启动实例即可诊断/修复元数据**。它们直接复用内核头文件，Makefile 把 `xlogreader.c` 以 `-DFRONTEND` 软链进来自行编译、链接 `$(polar_libvfs)`——所以能读 pfs 上的共享存储文件。

### external/ 生态组件

| 组件 | 行数 | 一句话定位 | 接入方式 |
| --- | --- | --- | --- |
| `polar_monitor` | 3828 | SQL 函数库：内核状态暴露成视图（`polar_consistent_lsn`、copy buffer/flush list/logindex 计数器等） | CREATE EXTENSION |
| `polar_advisor` | 4795 | 纯 SQL 扩展：维护窗口对象 + vacuum/reindex 智能调度黑白名单 | CREATE EXTENSION（SQL only） |
| `polar_worker` | 1604 | 后台维护 worker：预分配 WAL 段、清过期 core dump、清 xlog 临时文件；SIGUSR2 参与在线 promote | `shared_preload_libraries` |
| `polar_resource_manager` | 1224 | 监控各 backend 内存占用，超策略强制回收/杀会话，防单会话吃光容器内存 | preload + bgworker |
| `polar_io_stat` | 905 | 内核 I/O 统计（多维 + 延迟直方图）的 SQL 暴露层 | CREATE EXTENSION |
| `polar_parameter_manager` | 449 | `polar_get_guc_info(name)` 把 POLAR_GUC flag 矩阵查给 DBaas 控制台 | CREATE EXTENSION |
| `polar_proxy_utils` | — | 纯 SQL：Proxy 路由策略表管理 | CREATE EXTENSION（SQL only） |
| `polar_feature_utils` | — | 特性用量统计视图（内核 `utils/polar_features.h` 计数器出口） | CREATE EXTENSION |
| `polar_monitor_preload` | — | 依赖进程内 hook 的监控：锁等待/网络/memory-context dump | `shared_preload_libraries` |

**为什么放 external/ 而不是 contrib/**：(1) 保持 contrib/ 与上游 PG 完全同构——PolarDB 要长期跟随 PG 大版本 rebase，自己的扩展放 contrib 会每个版本制造合并冲突；(2) `external/Makefile` 自带编译分层——`enable_minimal`（极简 RDS 镜像）下只编核心组件、`polar_tde_utils` 挂 `with_tde`、`faultinjector` 挂 `enable_fault_injector`，contrib 没有 per-feature 开关的惯例；(3) external 同时收纳第三方扩展（pg_repack、pg_cron、pgaudit…），polar_\* 与它们同级——都是"数据库外围可选组件"。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 分发表挂接 | `child_process_kinds[]`（launch_backend.c:214） | PG17 子进程框架的原生扩展点 |
| 生产者-消费者（锁回放） | `polar_alr_ctl` 三角色 | 锁异步化但同事务保序 |
| 分片通道 + 分区锁 | `polar_write_channel`（elog.c:4441） | audit 吞吐水平扩展 |
| 二分搜索配置 | `polar_get_shared_mem_total_size`（ipci.c:230） | 非线性依赖的逆向求解 |
| 本地缓存 + WAL 同步 | `polar_settings.conf` 拷贝机制 | 远端配置的一致性读 |
| WAL 化 DDL | `polar_cluster_setting_wal_write` | 参数变更三节点一致 |

## 模块间交互

- **编排 [01 LogIndex](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/01-logindex) 与 [02 并行回放](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/02-wal-meta-replay) 的进程**：logindex saver/dispatcher 由 postmaster 拉起；BGWORKER_CRASH_ON_ERROR 收紧保护回放 worker 的一致性。
- **与 [04 VFS](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/04-shared-storage-vfs)**：在线 promote 的 `polar_remount(POLAR_VFS_RDWR | POLAR_VFS_PAXOS_BYFORCE)` 重挂共享盘；`polar_settings.conf` 的本地缓存拷贝走 VFS；polar_tools 链接 `$(polar_libvfs)` 读共享存储。
- **audit 日志与 [06 TDE](/vibe-reading/articles/Database/OLTP/PolarDB/CodeWiki/17.11.1.0/06-tde)** 无直接耦合——audit 记录 SQL 文本明文，脱敏由 `polar_str_find_passwd()` 负责（与存储加密正交）。

## 扩展方式

**新增一个 polar_tool**（四处改动，全在 `src/bin/polar_tools/`）：

1. 新建 `xxx_dump.c`：文件头 Apache-2.0 版权注释（IDENTIFICATION 指明路径）→ `usage()` + `getopt_long` 解析 → `xxx_main(int argc, char **argv)` 返回 0/-1。参考 `logindex_meta_dump.c` 的 CRC 校验三件套（magic/version/crc）；
2. `polar_tools.h`：`extern int xxx_main(int argc, char **argv);`
3. `polar_tools.c`：`usage()` printf 一行 + `main()` 的 strcmp 分发表加一个 else-if；
4. `Makefile`：`OBJS` 加 `xxx_dump.o`。

注意：这些工具直接 include 后端头但**不链后端符号**，结构体定义变更（如 logindex 格式演进）需同步检查工具的 `sizeof`/偏移假设；`control_data_change` 的读-改-写新文件模式（永不原地覆盖）是破坏性修复工具的标准安全姿势。

**新增一个 external 组件**：目录 + Makefile（声明 `REGRESS`/`EXTENSION`/`MODULE_big`）+ 挂进 `external/Makefile` 的条件编译列表；若需 shmem 走 `shmem_startup_hook`/`shmem_request_hook`（参考 polar_worker.c:312-327 的 `RequestAddinShmemSpace`）；若需进程内 hook 走 `shared_preload_libraries` 路线（参考 polar_monitor_preload）。
