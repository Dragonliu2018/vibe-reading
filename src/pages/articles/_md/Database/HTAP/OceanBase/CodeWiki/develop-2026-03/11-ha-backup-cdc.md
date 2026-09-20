---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "高可用、备份恢复与 CDC"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "副本迁移", "物理备份", "主备库", "libobcdc"]
description: "OceanBase 容灾全家桶：learner 先行的副本迁移、宏块级物理备份与伴随索引树、并行拉串行写的日志回补、libobcdc 增量外发流水线。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

四个子领域组成 OceanBase 的容灾面：**HA**（副本迁移/补副本/transfer，`src/storage/high_availability/`）、**备份恢复**（数据备份 + 日志归档，`src/storage/backup/`、`src/rootserver/backup/`、`src/logservice/archiveservice/`）、**主备库**（standby + restoreservice 日志回补）、**CDC**（libobcdc 增量日志外发 SDK）。共同形态：**RS/调度端只拆任务，重活全部在 observer 端以 DagNet 表达**；一切长任务都是状态机 + 幂等步骤。

## 模块架构

| 子领域 | RS 端 | observer 端 |
| --- | --- | --- |
| 副本迁移/transfer | `ob_disaster_recovery_service.*`（产出 `ObMigrationOpArg` 下发） | `high_availability/`（~70 文件） |
| 备份 | `rootserver/backup/`（`ObBackupService` 族） | `storage/backup/`（数据 DAG）+ `archiveservice/`（日志归档） |
| 恢复 | `rootserver/restore/`（`ObRestoreScheduler`） | `storage/restore/`（LS 恢复状态机）+ `restoreservice/`（日志回补） |
| 主备 | `rootserver/standby/` | `ObLogRestoreHandler`（RAW_WRITE 写回） |
| CDC | — | `libobcdc/`（SDK）+ `logfetcher/` + `cdcservice/`（RPC）+ `logminer/` |

## 调用链路

### 副本迁移（learner 先行）

```
RS 产出 ObMigrationOpArg → RPC
└─ ObLSService::create_ls_for_ha                 tx_storage/ob_ls_service.cpp:1368
   └─ ls->get_ls_migration_handler()->add_ls_migration_task
[1 秒轮询] ObStorageHAService::do_ha_handler_     high_availability/ob_storage_ha_service.cpp:211
└─ ObLSMigrationHandler::process（状态机，头文件 32-57 行内置 ASCII 状态图：
   INIT→PREPARE_LS→BUILD_LS→COMPLETE_LS→FINISH）
   └─ ObMigrationDagNet（DAG 链：Start → SysTablets/DataTablets → TabletGroup
      → ObTabletMigrationDag → Finish）
      └─ ObStartMigrationTask::process            ob_ls_migration.cpp:1029
         └─ join_learner_list_() :1823            ★ 目标端先以 learner 进 Paxos 组（只收日志不投票）
         └─ generate_*_copy_tasks_()              ObPhysicalCopyTask 按 TableKey 拉 SSTable 宏块
            （minor/major/ddl/inc_major 多路；ObStorageHARowDataReader ~206K 行负责读）
      └─ ObWaitDataReadyTask（等 clog checkpoint 追平）
         → ObLSMemberListService 切正式成员 → report_result_ 上报 RS
```

为什么 learner 先行：拷宏块的同时持续接收增量日志，消除"先全量再补日志"的二次窗口；learner 不投票不影响可用性。

### 备份（数据 + 归档）

```
RS：ObBackupDataScheduler::start_backup_data（写 __all_backup_job）
    → ObBackupTaskScheduler 把 LS 级任务 RPC 下发
observer：RPC 处理器 backup_ls_data 等 7 个（ob_rpc_processor_simple.cpp:780-828）
    → backup::ObBackupHandler::schedule_backup_data_dag
    └─ ObLSBackupDataDagNet::start_running        storage/backup/ob_backup_task.h:114
       ├─ prepare_backup_tablet_provider_         扫 LS 下 tablet 生成宏块清单
       └─ ObLSBackupDataTask::process             ob_backup_task.cpp:2359
          ├─ write_macro_block_data_ :3603        逐宏块拷贝（经 ObBackupWrapperIODevice 写 OSS/COS/S3/NFS）
          ├─ 同时维护 index/meta 伴随树 + ObBackupIndexKVCache
          │    → ObLSBackupIndexRebuildTask 多轮（turn_id）合并
          │    → 支持宏块级并行与按 retry_id 断点重试
          └─ 增量：ObBackupComplementLogDagNet（补 start_scn~end_scn 归档日志）
归档：ObArchiveScheduler::schedule → ObArchiveFetcher（从 palf 取）
      → ObArchiveSequencer（按 round/piece 组日志）→ ObArchiveSender（写 piece 文件）
```

### restore / 主备日志回补

```
observer 端 ObILSRestoreState 子类状态机（ob_sn_ls_restore_state.h：
  Start → SysTablet → CreateUserTablet → ConsistentScn → Quick/Major 拉宏块 → Finish）
日志恢复：ObLogRestoreService（注释 "Work in physical restore and physical standby"）
  └─ schedule_fetch_log_ → ObRemoteFetchWorker 并行拉
     → ObLogRestoreHandler::submit_sorted_task（排序去重缓存）
     → raw_write() 串行写回本地 palf → 走正常 palf replay
     → check_restore_done(recovery_end_scn) 判完成
```

`ob_log_restore_handler.h:314-325` 注释明确 "fetch log in parallel, raw write to palf in series"——LS 内日志必须按 LSN 严格落盘，但拉取可按区间并行。备库双源驱动：归档源（`ObLogRestoreArchiveDriver`，支持级联）与网络源（`ObLogRestoreNetDriver`）可切换。switchover 用 barrier log + palf AccessMode 切换（APPEND↔RAW_WRITE）保证备库日志不经主库写路径的格式差异。

### libobcdc 流水线

```
ObLogInstance::init_components_                   libobcdc/src/ob_log_instance.cpp:779
装配（INIT 宏序列）：
ObLogFetcher（INTEGRATED 模式经 logrpc 拉 / DIRECT 模式直读归档）
  → ObLogFetcherDispatcher → PartTransTask
  → ObLogSysLsTaskHandler(sys LS) / ObLogDmlParser + ObLogDdlParser
  → ObLogPartTransParser → ObLogSequencer（全局事务定序 + begin/commit 配对，
     事务上下文 ObLogTransCtxMgr）
  ├─ (a) ObLogTransRedoDispatcher/MsgSorter → ObLogStorager 落盘 RocksDB（防内存膨胀，
  │        TASK_POOL 上限 128G）
  └─ (b) 事务提交后 ObLogFormatter 格式化 IBinlogRecord → ObLogCommitter::push
     → commit_routine 全局按序推入 BRQueue
     → 下游 ObLogInstance::next_record(timeout_us) 拉取（纯拉模型，服务 oblogproxy 等）
```

## 核心实现

### 物理备份（基线宏块 + 归档日志）而非逻辑 dump

恢复时"回放宏块 + raw_write 日志 + 正常 palf replay"与在线路径完全同构，SCN 一致性由物理日志保证，速度远快于逻辑导入；restore 与备库日志回补共用 `restoreservice`——一套代码两种场景。

### RS 只调度不搬数据

`ObBackupDataScheduler` 仅拆任务、写内部表、收回调；重活全在 observer DagNet。RS 无带宽/内存单点压力；observer 崩溃后 `do_reload_task()` 从内部表恢复任务，天然断点续跑。

**HA 调度的公平性与隔离**：`ObStorageHAService` 每轮对 LS 列表 `std::random_shuffle`（`scheduler_ls_ha_handler_`）——防固定顺序下同一故障 LS 永远排前饿死其他 LS；单 LS 处理失败用独立 `tmp_ret` 接收而不中断本轮循环（注释明示"不阻塞其他 ls 调度"）。restore 写回侧，`ObLogRestoreHandler::raw_write` 对 palf 返回 `OB_EAGAIN` 以 10us 递增 sleep 重试（上限 100 次/100us）；角色非 LEADER 或 proposal_id 过期返回 `OB_NOT_MASTER`，恢复到终点返回 `OB_RESTORE_LOG_TO_END`。

### libobcdc 的 LS 级并行 + 全局 merge

fetcher 每个 LS 一路 fetch stream，`ObLogSequencer` 分配全局事务序，`ObLogCommitter` 的 `ObExtendibleRingBuffer` 做全局有序输出——并行度与下游"事务提交序严格一致"的要求解耦。

### 灵活的外部存储抽象

`ObBackupIoAdapter::get_and_init_device`（`share/backup/ob_backup_io_adapter.h:32`）按 URI 前缀（oss/cos/s3/nfs/file）路由到 `ObIODevice` 实现；端点管理在 `share/object_storage/`。CDC 的 DIRECT 模式甚至可完全绕过 observer 直读归档（`ObLogExternalStorageHandler`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 + 轮询推进 | `ObLSMigrationHandler`（头文件内置状态图）、`ObILSRestoreState` 类层级状态机、`ObTransferHandler` 三态 | 迁移/恢复跑数小时，任何一步失败可安全重入 |
| DAG/DagNet 工厂 | `ObIDagNet/ObIDag/ObITask`（`share/scheduler/ob_tenant_dag_scheduler.h`） | 迁移、备份、恢复、transfer 一切长活统一调度与失败重试 |
| 流水线 + 有界队列 | libobcdc 全链（每组件线程数与队列长度配置化） | 高吞吐下背压与内存控制 |
| 桥接/适配器 | `ObBackupIoAdapter`、`ObBackupWrapperIODevice` | 新存储类型零侵入接入 |
| 接口化依赖注入 | `IObLog*` 纯虚接口族、`ObMigrationDagNetInitParam` | HA 代码可在单测中替换 rpc/sql 依赖 |

## 模块间交互

依赖 RS 下发任务（`create_ls_for_ha` RPC、backup 7 个处理器）、logservice（learner 收日志、`ObArchiveFetcher` 旁路归档、restore 的 raw_write）、share/object_storage（外部 IO 收敛）。libobcdc 依赖 observer 的 logrpc + `cdcservice`（`fetch_log/fetch_missing_log` RPC）+ `ObLogSysTableHelper` 查 `__all_virtual_*` 取路由，或 DIRECT 模式完全独立。HA/backup 全线 `ERRSIM_POINT_DEF` 故障注入 + `DEBUG_SYNC` 同步点——修改时必须同步维护。

## 扩展方式

- **备份到新的外部存储类型**：`ObBackupIoAdapter::get_and_init_device` 加前缀分支 + 实现对应 `ObIODevice`；备份写路径检查 `ObBackupWrapperIODevice::parse_storage_device_type_`；端点管理加 `ob_device_config_parser.*`
- **新增 libobcdc 下游格式**：字段序列化改 `ObLogFormatter::format` + `ObObj2strHelper`；新 BR 类型改 `ObLogBRPool`；消费端只依赖 `ObLogInstance::next_record` 无需改动
- **新增迁移/DR 操作类型**：扩 `ObMigrationOpType::TYPE`（`ob_storage_ha_struct.h:66`）+ `ObLSMigrationHandler::generate_*_dag_net_` 新状态分支 + RS 端 `ob_disaster_recovery_task.h`
- **备库新增日志源类型**：`ObLogRestoreHandler::add_source` 重载（现有 DirArray/BackupDest/ServiceAttr 三种）+ 新 `ObLogRestoreDriverBase` 子类
