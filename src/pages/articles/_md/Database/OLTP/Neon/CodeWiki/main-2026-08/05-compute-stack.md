---
source:
  type: "源码解读"
  project: "neon"
  url: "https://github.com/neondatabase/neon"
title: "Compute 节点栈"
date: "2026-10-02T15:00:33+08:00"
category: [Database, OLTP, Neon, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["Neon", "PostgreSQL", "C 扩展", "compute_tools", "存算分离"]
description: "Neon 计算节点全栈：PostgreSQL fork 的 smgr 整体替换、pgxn/neon C 扩展、compute_tools 声明式 spec 与扩展下载服务"
readingTime: "35 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

Compute 节点栈回答"**怎么把一个标准 PostgreSQL 变成可随时丢弃的纯执行器**"。三个组成部分分工明确：PostgreSQL fork（`vendor/postgres-v14..17` submodule）只开洞——加 `smgr_hook` 等挂载点，不实现逻辑；`pgxn/neon` C 扩展（~25k 行 C）填洞——smgr 替换、WAL proposer、页面通信、本地缓存；`compute_tools`（Rust，13k 行）做进程外管理——spec 应用、basebackup、扩展下载、监控上报。边界：fork 与 pgxn 是"内核态"（跑在 postgres 进程内），compute_tools 是"管理态"（独立进程，能联网能落盘），两者经 hook + localhost HTTP 协作。

> vendor/postgres-v14..17 未随仓检出，fork 侧 hook 点（`smgr_hook/dbsize_hook/download_extension_file_hook`）只能从 pgxn 调用侧反推语义——本篇对其行为的描述标注为推断。

## 模块架构

C 扩展的核心是三个"控制反转"挂载：`smgr_hook = smgr_neon`（`libpagestore.c:1648`，只有设置了 `neon.pageserver_connstring` 才生效）把一切持久页访问接管；walsender 被 `WalProposerMain`（`walproposer_pg.c:181`）替换为共识 proposer；`ProcessUtility_hook`（`neon_ddl_handler.c:54`）捕获 DDL 转发 console。页访问路径上再叠两层缓存：communicator（进程内 prefetch 环）与 LFC（本地文件页缓存）。Rust 侧 `ComputeNode`（`compute_tools/src/compute.rs:139`）以 Condvar 状态机管理"拉 spec → 备目录 → 起进程 → 应用 spec"全流程，`communicator/` Rust bgworker 目前只导出指标，是 IO 剥离的演进方向。

## 调用链路

```
启动：compute_ctl.rs::main → get_config（HTTP 拉 ComputeSpec）
  → ComputeNode::run(compute.rs:627)：HTTP server 3080(external)/3081(internal)
  → wait_spec（Condvar 等 ConfigurationPending）
  → start_compute(:793) 并发 pre_tasks：
      download_preload_extensions / prepare_pgdata / 磁盘配额 / pgbouncer
  → prepare_pgdata(:1601)：
      primary 先 check_safekeepers_synced（quorum = len/2+1）
      → get_basebackup（libpq "basebackup {tenant} {timeline} --gzip"）
  → start_postgres(:1789)：cgroup 内 spawn postgres
  → spec_apply.rs::apply_spec_sql 阶段化建角色/库/扩展
  → Running；monitor.rs 接管（500ms 循环维护 last_active）

页面读：buffer miss（PG executor）
  → smgr_hook = smgr_neon（pagestore_smgr.c:2258）
  → neon_readv(:1471，PG17+) 依次尝试：
      ① communicator_prefetch_lookupv（进程内 prefetch 环命中）
      ② lfc_read（LFC 本地文件缓存命中）
      ③ communicator_read_at_lsnv(:2093) → page_server_request(:1412)
          打包 NeonGetPageRequest（reqid + 双 LSN + BufferTag）
          → libpagestore.c pageserver_send(:1140)
              PQsendQuery("pagestream_v3 …") → COPYBOTH 收发
              get_shard_number(BufferTag) 按分片路由
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `start_compute` (`compute.rs:793`) | 冷启动编排 | 注释强调这是关键路径，pre_tasks 全并发 |
| `apply_spec_sql` (`spec_apply.rs:40`) | 声明式应用 spec | `ApplySpecPhase` 阶段顺序敏感 |
| `sync_safekeepers` (`compute.rs:1507`) | `--sync-safekeepers` | 用 SK quorum 确认位点决定恢复起点 |
| `neon_readv` (`pagestore_smgr.c:1471`) | 页读取分发 | 三级缓存依次 fallback |
| `neon_get_request_lsns` (`pagestore_smgr.c:507`) | 选请求 LSN | LwLSN 缓存 + primary 用 latest 防竞态 |
| `WalProposerMain` (`walproposer_pg.c:181`) | WAL 共识 | 借 walsender 框架，`synchronous_standby_names='walproposer'` |
| `download_extension_file_hook`（pgxn 侧）(`extension_server.c:111`) | 扩展按需下载 | 转发 localhost HTTP 给 Rust 侧 |

</details>

## 核心实现

### ComputeSpec：声明式的期望状态

`ComputeSpec`（`libs/compute_api/src/spec.rs:35`）是控制面签发的完整期望状态：cluster（roles/databases/settings）、tenant/timeline、`pageserver_connection_info`（shard 清单 + `prefer_protocol: Libpq|Grpc`）、safekeeper 连接串、mode（Primary/Static(Lsn)/Replica）、`delta_operations`（DROP/RENAME 这类无法用终态表达的增量）、远程扩展白名单、LFC/审计/swap 等运维参数。`apply_spec_sql`（`spec_apply.rs:40`）按 `ApplySpecPhase` 枚举顺序做 diff 应用：CreatePrivilegedRole → DropInvalidDatabases → RenameRoles → … → HandleOtherExtensions，每库并行，连接强制 `-c role=cloud_admin` 防用户库参数干扰。破坏性操作靠 `delta_operations` + `neon.drop_subscriptions_done` 标记表保证幂等。**为什么要声明式**：compute 随时重建，重放 spec 必须收敛到同一终态——命令式配置脚本做不到这一点。

### smgr 整体替换：透明接管一切访问路径

`struct f_smgr neon_smgr`（`pagestore_smgr.c:2220`）实现了完整的 smgr 接口表，任何走 buffer manager 的页访问都被透明接管——不需要改任何 SQL 层代码。三个例外回落 md.c：temp/unlogged 关系（易失数据，本地盘正好）、bitmap build 中间态。**这是"改 hook 而不改调用方"的经典**：PG 的 smgr 抽象本来为 tablespace 而设，Neon 把它变成了存储引擎的边界。页面请求经 `neon_get_request_lsns`（`:507`）选 LSN：primary 发 `request_lsn=UINT64_MAX`（latest，防 GC 竞态）+ `not_modified_since=LwLSN`（该页最后写入位缓存，miss 回退 `maxLastWrittenLsn`）；replica 用 `GetXLogReplayRecPtr()`。双 LSN 让 pageserver 能跳过不必要的等待与重放。

### communicator 与 LFC：两级本地缓存

communicator（`communicator.c`）是 backend 进程内的异步 prefetch 状态机：`PrefetchRequest` 环（`readahead_buffer_size` 默认 128 深度）按 BufferTag 哈希管理"已回包未消费"的页，顺序读场景下能把网络延迟藏进流水线。环有天然局限（代码注释明示）：prefetch 与 read 之间间隔超过环容量时，旧请求会被环覆写而丢失，此时 fallback 到同步读。LFC（Local File Cache，`file_cache.c`）是磁盘级二级缓存：单一大文件 1MB chunk × 8KB 块，dynahash 索引 + per-block 状态机 + LRU；写缓存前校验 `LwLSN <= not_modified_since`（`:1558`）保证一致性。LFC 的容量决策靠 `hll.c` 的 HyperLogLog 估算 working set（`:1990`），供 vm_monitor/控制面调整。目录跨 suspend 的持久化交给 `endpoint_storage`（独立 axum 服务 + S3），prewarm 时下载 zstd 状态再 `select neon.prewarm_local_cache($1)`。

### WAL Proposer：借 walsender 之壳

`WalProposerMain`（`walproposer_pg.c:181`）替换 walsender 入口，状态机 `SS_OFFLINE → SS_CONNECTING → SS_HANDSHAKE → SS_VOTING → SS_WAIT_ELECTED → SS_ACTIVE`（`walproposer.h`）驱动 libpq 连每个 safekeeper 发 `START_WAL_PUSH`。**为什么借这个壳**：synchronous replication 的等待机制（`SyncRepWaitForLSN`）现成可用——`synchronous_standby_names='walproposer'`（`compute_promote.rs:97`）让 backend 的 commit 等待复用 syncrep latch，walproposer 的 quorum 确认（`GetAcknowledgedByQuorumWALPosition`，`walproposer.c:1995`：排序取第 n−quorum 个 flushLsn）经 `ProcessStandbyReply` 喂回去——PG 内核完全不知道对面不是 standby 而是共识组。另两个 hook：`neon_walreader.c` 让 walsender 能从 SK 拉 WAL（replica 链路）；`Custom_XLogReaderRoutines = NeonOnDemandXLogReaderRoutines`（`neon.c:521`）配合 `neon_rmgr`（自定义 rmgr，`RegisterCustomRmgr`）处理 neon 特有 WAL 记录的 redo/decode/mask。

### extension_server：把网络下载移出 postgres 进程

postgres 以受限用户跑，不该碰对象存储、重试逻辑与白名单校验。分工：C 侧只留 `download_extension_file_hook`，实现是发 `http://localhost:{port}/extension_server/{filename}` 的 curl（`extension_server.c:49`）；Rust 侧 `compute_tools/src/extension_server.rs::download_extension` 做 S3 网关下载、解压、按 pg_config 放置。`create_control_files()`（`:229`）先把全部白名单扩展的 control 文件落盘——`CREATE EXTENSION` 触发按需下载，镜像不必预装扩展（冷启动瘦身；只有 `shared_preload_libraries` 需要预下载，`compute.rs:1057`）。

### lsn_lease：静态节点的 GC 保护

Static compute（钉死旧 LSN 的只读计算节点）面临一个危险：pageserver 持续 GC 老层，钉住的 LSN 可能被越过导致读失败。`compute_tools/src/lsn_lease.rs` 的 bg 线程周期向所有 pageserver shard 发 `lease lsn …`（libpq `:170` 或 gRPC `:212`），取最早 `valid_until` 续约；**pageserver 显式拒绝（LSN 越过 GC cutoff）则进程退出**（`:95`）——与其读到坏数据，不如干脆死掉。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| hook 控制反转（C 层） | `smgr_hook/ProcessUtility_hook/download_extension_file_hook` | fork 只开洞，逻辑集中在扩展内可独立构建 |
| 声明式 spec + 幂等 apply | `spec_apply.rs` + `ApplySpecPhase` | compute 重建重放必须收敛 |
| Condvar 状态机 | `ComputeNode` + `ComputeStatus` | HTTP 只投递事件，单 configurator 线程串行应用 |
| 进程外服务分工 | extension_server、endpoint_storage | 权限/网络能力隔离在 postgres 之外 |
| C↔Rust bgworker 桥 | `communicator_process.c` + cbindgen 头 + SetLatch 回调 | 演进中的 IO 剥离（当前仅指标） |

## 模块间交互

对 pageserver：libpq `pagestream_v3` 或 gRPC（spec 的 `prefer_protocol` 决定）+ basebackup + lsn lease，统一 `storage_auth_token` 鉴权。对 safekeeper：walproposer quorum 写 + `--sync-safekeepers`。对控制面：HTTP 拉/收 spec（3080）、上报 `/status`/`check_writability`/`terminate_flush_lsn`；monitor 的 last_active 供 autoscaler 决定 suspend。周边组件全在 compute_tools 编排：vm_monitor（cgroup `memory.high` 事件驱动 OOM 保护，1s 限频 upscale）、pgbouncer、rsyslog（审计）、local_proxy（JWT）。`compute/` 目录是镜像构建：`compute-node.Dockerfile` 编四个 PG 版本的全部扩展，`manifest.yaml` 定义镜像级 pg_settings 默认（`fsync=off`——数据在 pageserver，本地 datadir 可弃），`patches/` 收纳 pgvector 等需适配的第三方扩展补丁。

## 扩展方式

- **新增 GUC**：neon 扩展 `_PG_init` 里 `DefineCustomIntVariable`（模板见 `extension_server.c:91`）；默认值/允许用户改的部分改 `compute_tools/src/config.rs::write_postgres_conf` 与 `compute/manifest.yaml`；控制面下发的走 `ComputeSpec.cluster.settings`。
- **新增打包扩展**：`compute/compute-node.Dockerfile` 编译段 + 必要补丁进 `compute/patches/`；远程分发路径约定 `{build_tag}/{arch}/{pg_ver}/extensions/{ext}.tar.zst`（`spec.rs:443`）+ `remote_extensions` 白名单。
- **新增 apply 阶段**：`ApplySpecPhase` 枚举追加（顺序敏感，只加不改）；存量集群的权限变更向 `spec.rs:255` migrations 数组**末尾**追加 SQL。

对应测试：`test_runner/regress/test_compute_tools.py`、`test_extensions.py`、`test_ondemand_download.py`；PG 语义对照在 `sql_regress/`。
