---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "后台任务调度"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "PostgreSQL", "Background Worker", "调度"]
description: "TimescaleDB BGW scheduler/job 调度器、job_execute 经 ABI 桥路由到 TSL 策略执行的机制解读"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

时序数据库需要后台自动执行压缩、连续聚合刷新、数据保留等周期性任务。TimescaleDB 用 PostgreSQL 的 Background Worker（BGW）机制实现：一个集群级 scheduler worker 协调，按需拉起 job worker 执行具体策略。这个模块独立存在因为调度与执行是正交关注点——scheduler 负责何时跑、跑哪个 job，具体策略（压缩/刷新/保留）由 TSL 经 ABI 桥提供。它让运维操作从外部 cron 回归数据库内部，保证事务一致性与故障恢复。

## 模块架构

```
集群级 launcher（src/loader/bgw_launcher.c）
  └─ 每 DB 一个 scheduler worker
       └─ ts_bgw_scheduler_main (scheduler.c:1028) 主循环
            ├─ 查 bgw_job 表按 next_start 排序
            ├─ 启动到期 job: ts_bgw_start_worker (scheduler.c:117)
            ├─ WaitLatch 等待下一 job 或超时
            └─ 处理 stopped/timed-out job
                 └─ 每个 job 独立 BGW worker:
                      ts_bgw_job_entrypoint (job.c:1098)
                       ├─ 以 job owner 身份建连
                       ├─ ts_bgw_job_execute (job.c:960)
                       │    └─ ts_cm_functions->job_execute(job)  ← ABI 桥到 TSL
                       └─ ts_bgw_job_stat_mark_end 记录成功/失败
```

`BgwJob`（`src/bgw/job.h`，元数据 `FormData_bgw_job` 在 catalog.h:534）含 `application_name`、`schedule_interval`/`max_runtime`/`max_retries`/`retry_period`、`proc_schema`/`proc_name`（执行存储过程）、`owner`、`fixed_schedule`、`config`（jsonb）、`check_schema`/`check_name`。`BgwJobStat`（job_stat.c）记录 last_run/next_start/success/failure 计数。

## 调用链路

```
scheduler 唤醒 → 查 bgw_job 按 next_start 排序取到期 job
  └─ ts_bgw_start_worker (scheduler.c:117)
       └─ RegisterDynamicBackgroundWorker（BgwParams memcpy 到 bgw_extra）
            └─ worker: ts_bgw_job_entrypoint (job.c:1098)
                 ├─ mark_job_as_started（独立事务记 bgw_job_stat）
                 ├─ 以 job owner 身份初始化 DB 连接 + 启用 TSL 加载
                 ├─ ts_bgw_job_find 查 job
                 └─ PG_TRY: ts_bgw_job_execute (job.c:960)
                      └─ ts_cm_functions->job_execute(job)
                           └─ TSL: 构造 SELECT proc(job_id, config) 或 CALL proc(...)
                                如 policy_recompression_proc / policy_refresh_cagg_proc
                 └─ PG_CATCH: 回滚 + 记 jsonb 错误 + 检查 max_retries
                 └─ ts_bgw_job_stat_mark_end（成功/失败统计）
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ts_bgw_scheduler_main` (scheduler.c:1028) | scheduler 主循环 | 按 next_start 调度，WaitLatch 等待 |
| `ts_bgw_start_worker` (scheduler.c:117) | 拉起 job worker | BgwParams 经 bgw_extra 传递 |
| `ts_bgw_job_entrypoint` (job.c:1098) | worker 入口 | 以 job owner 身份建连 |
| `ts_bgw_job_execute` (job.c:960) | 执行 job | 委托 `ts_cm_functions->job_execute` 到 TSL |
| `ts_bgw_job_stat_mark_end` (job_stat.c) | 记录统计 | next_start 计算（fixed/drifting/backoff/crash） |

## 核心实现

### scheduler 与 worker 分离

scheduler 自身是一个 BGW，只做协调：读 `bgw_job` 表、按 `next_start` 排序、启动到期 job、`WaitLatch` 等待。具体执行交给独立 job worker。分离的原因是故障隔离——一个 job 失败/超时不影响 scheduler 调度其他 job；且 job worker 以 job owner 身份建连，权限正确隔离。

### job_execute 经 ABI 桥委托

`ts_bgw_job_execute`（job.c:960）调 `ts_cm_functions->job_execute(job)`——这一步经双许可桥落到 TSL 的 `tsl/src/bgw_policy/job.c`。TSL 侧按 `proc_schema`/`proc_name` 查找 proc OID，构造 `FuncExpr`，调用对应存储过程（如 `policy_recompression_proc` 压缩未压缩 chunk、`policy_refresh_cagg_proc` 刷新连续聚合、`policy_retention_proc` 丢弃过期 chunk）。社区版 `job_execute` 桩报错。这就是为什么压缩/刷新/保留策略都是 TSL 功能——它们的执行入口在 TSL。

### next_start 计算与重试

`job_stat.c` 的 next_start 计算支持四种模式：fixed schedule（固定时刻）、drifting（每次基于上次实际开始时间漂移）、backoff（失败重试 `retry_period`）、crash（worker 崩溃后的恢复）。`max_retries` 超限则取消调度。`bgw_job_stat_history`（job_stat_history.c）记 jsonb 快照历史。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| PG Background Worker | scheduler + job worker | 复用 PG 的 worker 管理、故障恢复 |
| 调度器/执行器分离 | scheduler 协调，worker 执行 | 故障隔离、权限隔离 |
| 策略模式 | `job_execute` 按 proc 路由 | 不同 job_type 对应不同 proc |
| 统计跟踪 | `bgw_job_stat`/`history` | next_start 计算 + 失败诊断 |

## 模块间交互

scheduler 在集群启动时由 launcher（`src/loader/bgw_launcher.c`）拉起；job_execute 经 `ts_cm_functions` 委托 TSL 的 `tsl/src/bgw_policy/job.c`（压缩/刷新/保留策略）；job 与 job_stat 存 `ts_catalog` 的 `bgw_job`/`bgw_job_stat`/`bgw_job_stat_history` 表；策略执行会调压缩引擎/连续聚合模块的具体函数。错误恢复：worker 启动失败标记 `JOB_FAILURE_TO_START`、超时转 `JOB_STATE_TERMINATING`、postmaster 死亡调 `on_exit_reset`+`ereport(FATAL)`、优雅取消先 `pg_cancel_backend` 等 3 秒再升级 `TerminateBackgroundWorker`。

## 扩展方式

新增一种 policy（作业类型）：在 `tsl/src/bgw_policy/` 加 `*_api.c` 实现 add/check/remove（调 `ts_bgw_job_insert_relation` 建 `bgw_job` 记录），加 `*_proc` 存储过程执行函数并注册到 `tsl_cm_functions` 对应字段（或作为普通 SQL procedure 由 `job_execute` 调用）。修改调度间隔逻辑改 `job_stat.c` 的 next_start 计算。
