---
source:
  type: "源码解读"
  project: "Greenplum"
  url: "https://github.com/greenplum-db/gpdb"
title: "FTS 容错服务"
date: "2026-08-14T15:39:30+08:00"
category: [Database, OLAP, Greenplum, CodeWiki, "7.0.0-beta.0"]
tags: ["Greenplum", "容错", "FTS", "failover", "mirror"]
description: "FTS——coordinator 上的后台探测进程，周期探测 primary/mirror segment 并在故障时触发 mirror 提升。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/00-overview)

---

## 模块定位

FTS（Fault Tolerance Service，`src/backend/fts/`，仅 ~4K 行）是 GPDB 的集群拓扑管理器。它作为 coordinator 上的后台进程周期性探测所有 primary/mirror segment 对的健康状态，发现 primary 故障且 mirror 已同步时触发 mirror 提升为主（failover），把更新写入 `gp_segment_configuration` catalog 与共享内存，供 dispatcher 创建 gang 时即时读取。它的设计准则是**数据一致性优先于可用性**——primary 挂了但 mirror 未同步时不提升，标记为 double fault 等待人工介入。

## 模块架构

模块由 coordinator 侧探测 + segment 侧消息处理 + 共享内存接口三部分构成：

| 文件 | 职责 |
|------|------|
| `fts.c` | FTS 入口 `FtsProbeMain`、主循环 `FtsLoop`、catalog 读写 `readCdbComponentInfoAndUpdateStatus`/`probeWalRepUpdateConfig` |
| `ftsprobe.c` | 探测编排 `FtsWalRepMessageSegments`、异步 I/O（`ftsConnect`/`ftsPoll`/`ftsSend`/`ftsReceive`）、响应处理与 failover 判定 `processResponse` |
| `ftsmessagehandler.c` | segment 端入口 `HandleFtsMessage`，处理 PROBE/SYNCREP_OFF/PROMOTE 三类消息 |
| `src/backend/cdb/cdbfts.c` | 共享内存接口：`FtsNotifyProber`(触发探测)/`FtsIsSegmentDown`(查状态)/`getFtsVersion`(版本号) |

FTS 进程由 postmaster 经 `PMAuxProcList` 数组硬编码注册（`postmaster.c:399-406`），入口 `FtsProbeMain`、启动规则 `FtsProbeStartRule`（检查 `Gp_role == GP_ROLE_DISPATCH`，仅 coordinator 启动，`fts.c:104`）。segment 端由 postmaster fork 的后端进程标记 `am_ftshandler=true`（`postmaster.c:2543`），在 `PostgresMain()`（`postgres.c:5390`）中调 `HandleFtsMessage`。

## 调用链路

```
FtsProbeMain()                              [fts.c:113]
 ├─ pqsignal(SIGHUP→重载配置, SIGINT→外部触发探测)
 ├─ BackgroundWorkerInitializeConnection()   连 DB_FOR_COMMON_ACCESS
 └─ FtsLoop()                               [fts.c:322]  无限循环
     [1] SIGHUP? → ProcessConfigFile()                    [339-343]
     [2] ftsProbeInfo->start_count++                       [351]   通知外部等待者
     [3-5] 事务 → readCdbComponentInfoAndUpdateStatus()   [358]  读 gp_segment_configuration → 写共享内存
     [6] FtsWalRepMessageSegments(cdbs)                    [391]
         ├─ FtsWalRepInitProbeContext()    [ftsprobe.c:1302]  对每个 ACTIVE PRIMARY 初始化 fts_segment_info
         └─ while (!allDone)              [ftsprobe.c:1374]   并行探测所有 segment
              ├─ ftsConnect()  [301]  PQconnectStart 异步连接
              ├─ ftsPoll()     [443]  poll(50ms) + ftsCheckTimeout(gp_fts_probe_timeout)
              ├─ ftsSend()     [556]  发 PROBE / SYNCREP_OFF / PROMOTE
              ├─ ftsReceive()  [673]  PQgetResult → probeRecordResponse() [636] 解析 5 字段
              ├─ processRetry() [842]  失败重试(默认 5 次, 等 1s)
              └─ processResponse() [1024]  ← FAILOVER 判定核心
     [7] 更新? → writeGpSegConfigToFTSFiles() [408] + status_version++ [411]
     [9] done_count = start_count           [422]
     [10] WaitLatch(interval - elapsed)      [449]  超时/SIGINT/SIGHUP/PM_DEATH 唤醒
```

segment 端（`ftsmessagehandler.c`）：`HandleFtsMessage`（`:419`）解析 `PROBE dbid=X contid=Y` → `HandleFtsWalRepProbe`（`:255`，查 mirror WAL 同步状态、`checkIODataDirectory` 磁盘 IO 检查、`SendFtsResponse` 返回 5 字段）/ `HandleFtsWalRepSyncRepOff`（`:300`，关同步复制）/ `HandleFtsWalRepPromote`（`:369`，`CreateReplicationSlotOnPromote` 为 pg_rewind 准备 + `SignalPromote` 触发提升）。

<details>
<summary>方法速查</summary>

| 方法 | 一行职责 | 关键决策 |
|------|----------|----------|
| `FtsProbeStartRule` (fts.c:104) | 启动规则 | 仅 `Gp_role==DISPATCH` |
| `FtsLoop` (fts.c:322) | 主循环 | 读 catalog→探测→更新→WaitLatch |
| `FtsWalRepMessageSegments` (ftsprobe.c:1366) | 探测编排 | 并行非串行 |
| `processResponse` (ftsprobe.c:1024) | 处理响应、判定 failover | restart 状态检测 + double fault |
| `updateConfiguration` (ftsprobe.c:908) | 更新 catalog + 共享内存 | 仅不一致时写 |

</details>

## 核心实现

### 探测状态机（FtsMessageState）

每个 `fts_segment_info` 在一个探测周期内经状态机驱动（`include/postmaster/ftsprobe.h:30-57`）：

```
FTS_PROBE_SEGMENT ──成功──→ FTS_PROBE_SUCCESS ──processResponse──→
   │                          ├─ mirror down+syncrep → FTS_SYNCREP_OFF_SEGMENT
   │                          ├─ isRoleMirror     → FTS_PROMOTE_SEGMENT (重发)
   │                          └─ 正常             → FTS_RESPONSE_PROCESSED
   └──失败──→ FTS_PROBE_FAILED ──processResponse──→
                 ├─ PM_IN_RESETTING / PM_IN_RECOVERY_MAKING_PROGRESS → 不 failover (等)
                 ├─ mirror IN_SYNC → 角色翻转 + FTS_PROMOTE_SEGMENT
                 └─ mirror NOT in-sync → DOUBLE FAULT
任意 *_FAILED → processRetry → *_RETRY_WAIT → (等1s) → *_SEGMENT
```

状态转换由 `nextSuccessState()`（`ftsprobe.c:63`）与 `nextFailedState()`（`:93`）驱动。`PMRestartState`（`:60-66`，`PM_IN_RESETTING`/`PM_IN_RECOVERY_MAKING_PROGRESS`/`NOT_MAKING_PROGRESS`）区分 segment 正在重启/恢复 vs 真挂。

### 异步 I/O 并行探测

对所有 segment **并行**探测而非串行（`ftsprobe.c:1374` while 循环）：`ftsConnect` 用 `PQconnectStart` 非阻塞同时对所有 segment 发起连接、`PQconnectPoll` 推进状态机；`ftsPoll` 用 `poll(fds, nfds, 50)` 等所有 socket；`ftsSend` 用 `PQsendQuery` 异步发送；`ftsReceive` 用 `PQconsumeInput`+`PQgetResult` 异步接收。每轮 while 对**所有** segment 执行四步直到全部到达终态。

### 配置期望 vs 实际对比

`updateConfiguration`（`ftsprobe.c:908-978`）对比探测结果与 catalog 当前配置：只有 `IsPrimaryAlive != SEGMENT_IS_ALIVE(primary)` 等不一致时才写 catalog（`probeWalRepUpdateConfig`，`fts.c:172`），避免不必要写入；同时更新共享内存 `ftsProbeInfo->status[dbid]` 供 dispatcher 即时读。segment 状态由宏检查（`include/cdb/cdbutil.h:78-89`）：`SEGMENT_IS_ACTIVE_PRIMARY`/`SEGMENT_IS_ALIVE`/`SEGMENT_IS_IN_SYNC`。

### Failover 判定与 double fault

`processResponse`（`ftsprobe.c:1024`）case `FTS_PROBE_FAILED` 的判定逻辑：先看 `restart_state`——`PM_IN_RESETTING` 或 `PM_IN_RECOVERY_MAKING_PROGRESS` 直接返回不 failover（等重启/恢复）；否则看 mirror 是否 `IN_SYNC`，是则翻转角色（swap primary/mirror cdbinfo）并下轮发 PROMOTE；mirror NOT in-sync 则 **double fault**——`updateSegmentDownStatus`（`:993`）加入 `failedContentIds` 位图，`probeUpdateConfHistory`（`fts.c:271`）写审计日志 `"FTS: double fault detected"`。`updateConfiguration` 的 `AssertImply`（`:928-929`）强制约束：只有 mirror 处于 in-sync 才允许角色翻转。这是 GPDB 在数据一致性 vs 可用性间选择一致性的决策。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Background Worker | `PMAuxProcList` 注册（`postmaster.c:399-406`），restart_time=0 | 多进程架构下的事务隔离 + 崩溃隔离 + postmaster 自动重启 |
| 异步 I/O 探测-响应 | `ftsConnect`/`Poll`/`Send`/`Receive` 并行 | 多 segment 同时探测，单进程内用 poll 多路复用 |
| 状态机 | 13 态 `FtsMessageState` + `PMRestartState` | 探测-提升流程复杂，状态显式化避免遗漏 |
| 配置期望 vs 实际对比 | `updateConfiguration` | 只在状态变化时写 catalog，减少写入 + 最终一致 |
| Latch 等待 + 信号触发 | `WaitLatch`（`fts.c:449`） | 超时/SIGINT(外部触发)/SIGHUP/PM_DEATH 四种唤醒 |

## 模块间交互

- **postmaster → FTS**：经 `PMAuxProcList` 注册启动；外部经 `FtsNotifyProber()`（`cdbfts.c:78`）→ `SendPostmasterSignal(PMSIGNAL_WAKEN_FTS)` → postmaster 向 FTS 发 SIGINT；FTS 崩溃 postmaster 自动重启。
- **catalog 读写**：读 `gp_segment_configuration`（`cdbcomponent_getCdbComponents`）；写 role/status/mode + 审计 `gp_configuration_history`；写 PGDATA 目录下 dump 文件供事务外读取。
- **FTS ↔ segment postmaster**：`ftsConnectStart`（`:154`）libpq 异步 TCP 连 segment postmaster，连接串含 `gpconntype=fts`；3 类消息（`fts.h`）经 SQL 'Q' 命令发送：`PROBE`/`SYNCREP_OFF`/`PROMOTE`，格式 `"%s dbid=%d contid=%d"`。
- **FTS → dispatcher（最终一致）**：FTS 不直接通知 dispatcher，而是更新 catalog + 共享内存 `status_version++`，dispatcher 下次建 gang 时 `getFtsVersion()`（`cdbfts.c:172`）发现版本变化即重读配置；dispatcher 建 gang 失败时也可 `FtsNotifyProber()` 主动触发探测 + `FtsIsSegmentDown()`（`:135`）同步检查。
- **FTS → replication**：segment 端 `HandleFtsWalRepProbe` 调 `GetMirrorStatus` 查 WAL 同步；`HandleFtsWalRepSyncRepOff` 调 `UnsetSyncStandbysDefined`；`HandleFtsWalRepPromote` 调 `CreateReplicationSlotOnPromote`（为 `pg_rewind` 准备）+ `SignalPromote`。

## 扩展方式

调整探测参数：改 GUC `gp_fts_probe_interval`(默认 60s)/`gp_fts_probe_timeout`(20s)/`gp_fts_probe_retries`(5)，定义在 `utils/misc/guc_gp.c:3771-3799`，`PGC_SIGHUP` 生效，FTS 主循环检测 `got_SIGHUP` 后 `ProcessConfigFile()` 重载（`fts.c:339-343`）。

新增 segment 健康检查项：在 `FtsResponse`（`include/postmaster/fts.h:51`）加字段 + `Natts_fts_message_response` 计数 → `fts_result`（`ftsprobe.h:18`）加字段 → `HandleFtsWalRepProbe`（`ftsmessagehandler.c:255`）加检查逻辑 + `SendFtsResponse`（`:179`）加序列化 → `probeRecordResponse`（`:636`）解析 + `processResponse`（`:1024`）case 判断。

修改 failover 策略（如允许 not-in-sync mirror 提升）：改 `processResponse` case `FTS_PROBE_FAILED`（`ftsprobe.c:1142-1228`）的条件（`:1172` `SEGMENT_IS_IN_SYNC` → `SEGMENT_IS_ALIVE`）+ 调整 `updateConfiguration` 的 `AssertImply`。⚠️ 此改动会导致数据丢失（未同步 WAL 永久丢失），需配合 `pg_rewind` 修复——这是重大架构决策非简单代码改动。
