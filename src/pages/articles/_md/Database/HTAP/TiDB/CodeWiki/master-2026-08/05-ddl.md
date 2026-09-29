---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "分布式 DDL"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "在线 Schema 变更"]
description: "TiDB 在线 Schema 变更解读：DDL job 队列、etcd owner 选举、SchemaState 双状态机与全集群版本同步"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/ddl/` 实现在线 Schema 变更：任意 TiDB 节点接收到 `ALTER TABLE` 后，变更以持久化 job 的形式异步推进，全集群按 schema version 逐步看到新表结构。为什么是分布式任务而不是 MySQL 式同步 DDL？因为 TiDB 是共享存储的多计算节点——**任何节点都能收 SQL，但元数据修改必须全局有序**；同步阻塞式 DDL 在任一节点失联时都会卡死全集群。本快照的 DDL 队列已从早期版本的 etcd 完全迁到 `mysql.tidb_ddl_job` 系统表（job V2 自 8.4.0 起，`jobV2FirstVer` in `pkg/ddl/ddl.go:104`），并支持多 worker 并行与 DXF 分布式 backfill。

## 模块架构

```
pkg/ddl/
├── ddl.go                # ddl 主结构 + ddlCtx（owner/schemaVerSyncer/lease）
├── executor.go          # 语句入口：CreateTable/AlterTable → 构造 Job（大 switch 分发）
├── job_submitter.go      # JobSubmitter：批量写 tidb_ddl_job（生产者）
├── job_scheduler.go      # jobScheduler：owner 侧调度（general/reorg 双 worker 池）
├── job_worker.go         # worker：transitOneJobStep/runOneJobStep（状态机引擎）
├── schema_version.go     # updateSchemaVersion / waitVersionSynced
├── schemaver/syncer.go   # Syncer：etcd 全局版本广播 + 各节点上报
├── backfilling.go + backfilling_dist_*.go   # reorg 回填（单机 + DXF 分布式）
├── rollingback.go        # 各 Action 的回滚处理
└── tables/               # 每种 DDL 的状态机实现（onAddColumn 等）
pkg/owner/manager.go      # etcd lease + campaign 的通用 owner 选举
```

## 调用链路

以 `ALTER TABLE ADD COLUMN` 为例的完整链路：

```
(e *executor) AlterTable                     pkg/ddl/executor.go:1707（按 spec 分发）
└─ (e *executor) AddColumn                   executor.go:2227（构造 model.Job）
    └─ doDDLJob2 → DoDDLJobWrapper           executor.go:7212
        ├─ deliverJobTask → limitJobCh        # 阻塞投递给 submitter
        ├─ JobSubmitter.submitLoop           job_submitter.go:65（批量 ≤100）
        │   └─ addBatchDDLJobs2Table         # 持久化 mysql.tidb_ddl_job + etcd notify
        └─ getJobDoneCh 阻塞等 job 结束        executor.go:7480

[owner 节点]（pkg/owner/manager.go 的 campaign 选出）
jobScheduler.scheduleLoop                    job_scheduler.go:264
└─ loadAndDeliverJobs                        job_scheduler.go:379
    ├─ select ... from tidb_ddl_job order by job_id
    ├─ runningJobs.checkRunnable             # 同 schema 冲突检测 → 可并行分组
    └─ 交给 general/reorg worker 池
        └─ (w *worker) transitOneJobStep     job_worker.go:592
            ├─ 开乐观事务 + 比较 job bytes 防并发冲突
            ├─ runOneJobStep                 job_worker.go:838（按 job.Type 分发 onAddColumn）
            │   └─ SchemaState 推进一步 + 回填数据（StateWriteReorg 阶段）
            ├─ updateSchemaVersion           schema_version.go:317（写 SchemaDiff）
            └─ waitVersionSynced             schema_version.go:369
                └─ Syncer.WaitVersionSynced  schemaver/syncer.go:102
                    # etcd 全局版本 + 各节点 WatchGlobalSchemaVer 上报 → 全集群追平
job 完成 → handleJobDone（job_worker.go:533）→ 移入 tidb_ddl_history
```

| 结构 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ddl` in `ddl.go:263` | DDL 子系统根，聚合 submitter/scheduler/executor | 各角色分离便于并行演进 |
| `Job` in `pkg/meta/model/job.go:353` | 一条 DDL 的持久化状态 | `DependencyID` 支撑并行 DDL 排序 |
| `JobState` | job 生命周期（Running/Rollingback/...） | 与 `SchemaState` 双层状态机 |
| `Manager` in `pkg/owner/manager.go` | etcd lease + campaign 选举 | DDL/GC/分布式任务共用 |

## 核心实现

### SchemaState 双层状态机与 Online Schema Change 语义

```go
// pkg/meta/model/job.go:269
StateNone → StateDeleteOnly → StateWriteOnly → StateWriteReorg → StatePublic
```

这是 F1 论文 Online Schema Change 的工程化：**中间态保证新旧 schema 共存时 DML 不产生歧义数据**。以加索引为例：`DeleteOnly` 期间旧节点删除的行会同步删索引（新节点不可见）；`WriteOnly` 期间新节点写入会维护索引但不可用于查询；`WriteReorg` 回填存量数据；`Public` 后对所有人可见。每步推进都 `updateSchemaVersion` 写 `SchemaDiff`，全集群 reload 后才进下一步——一个 job 跨越多个 schema version。失败时 `JobState` 转 `Rollingback`，按 `rollingback.go` 的各 Action 处理器逆向回退（部分 Action 不可回退，改为标记取消）。

job 执行中的两类健壮性机制：**可重试错误的退避**——`transitOneJobStep` 遇 `isRetryableJobError` 判定为可重试的错误时，按 `GetWaitTimeWhenErrorOccurred` 计算的时长 sleep（select 同时监听 `workCtx.Done()` 可被打断），期间 `sess.Reset()` 丢弃本步 KV 修改并把 `schemaVer` 置 0（让下一步重推版本）——注释明说不等待会让 DDL 像死锁一样立即重试；重试计数经 `metrics.RetryableErrorCount` 暴露。**完成收尾**——`finishDDLJob` 在 `JobNeedGC(job)` 为真时（如 truncate/drop 的旧数据）向 `delRangeManager.addDelRangeJob` 注册 GC 任务，再 `AddHistoryDDLJob` 归档 `tidb_ddl_history`；唯一例外是未取消的 `ActionAddPrimaryKey`（`updateRawArgs=false`，原始 args 含主键列信息需保留）。

### owner 选举与并行 DDL

owner 用 etcd **lease + campaign**（`pkg/owner/manager.go`）：lease 保证 owner 宕机自动释放锁，campaign 保证全局唯一。一个实战细节：升级期间老版本节点可能当选 owner 导致新语法 job 无人认领，`ForceToBeOwner`（manager.go，`ddl.Start` 的 Upgrade 分支处理，issue #54689）强制新节点竞选解决。并行 DDL 的现代实现：`jobScheduler` 持**双 worker 池**（`generalWorkerCnt`/`reorgWorkerCnt`=10，`ddl.go:102-103`），`loadAndDeliverJobs` 用 `runningJobs.checkRunnable` 判定同 schema 的 job 必须串行、不同 schema 可并行——取代了旧版单 worker 全串行。`mergeCreateTableJobs`（job_submitter.go:125，开关 `tidb_enable_fast_create_table`）甚至把并发到达的多个 create table 合并为一个 job，一次版本推进。

### 全集群版本同步与 lease

写路径有 schema lease（默认 45s）：节点本地 schema 超过 lease 未刷新就拒绝服务，这是"任何节点都不用过期 schema 写数据"的硬保证。在此之上 MDL（Metadata Lock）启用时 owner 精确等待持有旧 schema 的事务结束（`registerMDLInfo` in `job_worker.go:332`，锁存 etcd），未启用则退化为最坏等 2×lease。`schemaVersionManager.setSchemaVersion`（`ddl.go:389`）用**进程内互斥锁**保证"version+diff"原子写入 meta；`schemaver.Syncer` 完成双向确认：owner 写 etcd 全局版本 → 各节点 `WatchGlobalSchemaVer` 收到后 reload 并 `UpdateSelfVersion` 上报 → owner 汇总确认追平（`syncer.go:102`）。

### 分布式 backfill（加速加索引）

`StateWriteReorg` 的回填在数据量大时是 DDL 耗时主体。现代码有两条路：单机 backfill worker（`backfilling.go`，按 task 批次扫描写入）与**分布式 backfill**（`backfilling_dist_scheduler.go`/`backfilling_dist_executor.go`），后者把回填切成 subtask 经 `pkg/dxf/framework` 调度到集群多节点执行，`dist_owner.go` 管理其专用 owner——这是"add index 走集群算力"的加速方案（详见 [11-ingestor-dxf](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/11-ingestor-dxf) 的 DXF 框架）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机（双层） | `JobState` + `SchemaState` in `pkg/meta/model/job.go` | 生命周期与元数据可见性正交，失败恢复各走各的回退 |
| Owner 单例 | `pkg/owner/manager.go` | etcd 原语复用，DDL/GC/task 共享实现 |
| 生产者-消费者 | `limitJobCh` → `tidb_ddl_job` 表 → worker 池 | 持久队列使崩溃可恢复（job 不会丢） |
| 观察者 | `eventPublishStore`（notifier 包）→ stats/TTL 订阅 | 列变更事件广播给统计等下游 |

## 模块间交互

与 `pkg/meta`：`meta.NewMutator(txn)` 写 table info、`GenSchemaVersion`、`SetSchemaDiff`。与 domain/infoschema：DDL 每步经 `SchemaLoader.Reload()`（`ddl.go:364-367`，唯一实现是 domain）触发本节点 reload，其余节点靠 etcd 版本推送自行 reload（机制见 [09-domain-infoschema](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/09-domain-infoschema)）。与 session：`sess.Pool` 复用内部 session 执行系统表 SQL——DDL 的"SQL 层"操作（查 tidb_ddl_job、写 history）都用内部会话，不占用用户连接。

## 扩展方式

新增一种在线 DDL（概览场景 3）的落点：`ActionType` 与 `JobArgs`（`pkg/meta/model/job.go`）→ `executor.go` 的构造方法 + `AlterTable` switch（:1707）→ `runOneJobStep` 的 `onXxx`（job_worker.go:838 一带）→ `schema_version.go` 的 `SetSchemaDiffForXxx` → `rollingback.go` 回滚 → integrationtest。凡涉及数据回填的新 DDL，优先评估能否复用 backfilling/dist 框架而非自写扫描。
