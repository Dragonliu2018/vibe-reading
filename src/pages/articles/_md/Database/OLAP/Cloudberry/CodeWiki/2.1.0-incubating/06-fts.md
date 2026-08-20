---
source:
  type: "源码解读"
  project: "Cloudberry"
  url: "https://github.com/apache/cloudberry"
title: "容错服务"
date: "2026-08-20T11:29:59+08:00"
category: [Database, OLAP, Cloudberry, CodeWiki, "2.1.0-incubating"]
tags: ["Cloudberry", "C/C++", "MPP", "FTS", "高可用", "failover"]
description: "Cloudberry fts 模块——运行于 coordinator 的后台容错服务，周期探测 primary/mirror segment，故障时协调 in-sync mirror 提升，单点决策避免脑裂。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/00-overview)

---

## 模块定位

`src/backend/fts/` 是 Cloudberry 的**容错服务（Fault Tolerance Service）**，运行在 coordinator 节点的后台进程里，周期性探测所有 segment 的 primary/mirror 健康状态，在 primary 故障时协调 in-sync mirror 提升为新 primary，并更新 catalog 中的 `gp_segment_configuration`。它在 Cloudberry 中被**提升为 `backend/` 下的顶层目录**（`fts.c`/`ftsprobe.c`/`ftsmessagehandler.c`），区别于 Greenplum 时期放在 `cdb/` 下，凸显其在集群可用性中的地位。FTS 是整个 MPP 集群高可用的决策中枢——dispatcher 建 Gang 前要先问 FTS 哪个 segment 还活着，故障切换的全过程由 FTS 单点统筹。

## 模块架构

```text
coordinator postmaster
  └─ PMAuxProcList 注册 FtsProbeMain（仅 Gp_role==GP_ROLE_DISPATCH 启动）
       └─ FtsProbeMain() in fts.c:117           后台进程入口
            └─ FtsLoop() in fts.c:279           主循环
                 ├─ readCdbComponentInfoAndUpdateStatus()  从 catalog 读 segment 配置
                 ├─ FtsWalRepMessageSegments(cdbs) in ftsprobe.c:1297   一轮完整探测
                 │    └─ FtsWalRepInitProbeContext()        为每 primary-mirror pair 初始化 fts_segment_info
                 │    └─ while(!allDone):
                 │         ftsConnect()  ── PQconnectStart 异步建连
                 │         ftsPoll()     ── poll() 多路复用 (50ms)
                 │         ftsSend()     ── 发 PROBE / SYNCREP_OFF / PROMOTE
                 │         ftsReceive()   ── 收 5 列 bool 响应
                 │         processRetry() ── 失败重试 (gp_fts_probe_retries 次, 1s 间隔)
                 │         processResponse() in ftsprobe.c:981  ── 状态机推进 + 决定提升
                 ├─ writeGpSegConfigToFTSFiles()   catalog dump 到文件
                 ├─ status_version++                  通知 dispatcher 拓扑变化
                 └─ WaitLatch(gp_fts_probe_interval - elapsed)  等 60s 或被唤醒

segment 端（被探测方）
  HandleFtsMessage() in ftsmessagehandler.c:449    postmaster 见 gpconntype=fts 设 am_ftshandler
       ├─ HandleFtsWalRepProbe()       查 mirror 状态 + checkIODataDirectory 磁盘 IO 检查
       ├─ HandleFtsWalRepSyncRepOff()  关闭同步复制
       └─ HandleFtsWalRepPromote()     提升为新 primary（SIGUSR1 触发 PG promotion）

共享内存 FtsProbeInfo（coordinator）
  status[FTS_MAX_DBS]   按 dbid 索引的 up/down 位图（dispatcher 读）
  status_version        状态变更递增（dispatcher 缓存拓扑版本）
  start_count/done_count  piggyback 同步多请求复用一轮探测
```

FTS 分两侧：**coordinator 侧**的 `FtsLoop` 主循环 + `FtsWalRepMessageSegments` 探测协议（异步 libpq 连接 + `poll` 多路复用同时探测所有 primary）+ `processResponse` 状态机决策；**segment 侧**的 `HandleFtsMessage` 处理三种消息。两侧通过 libpq 连接（conninfo 带 `gpconntype=fts`，postmaster 见此标记设 `am_ftshandler`，`postgres.c:5695` 把 'Q' 消息直接路由到 `HandleFtsMessage` 而非正常 query 执行器）。共享内存 `FtsProbeInfo` 是 FTS 写、dispatcher 读的纽带。

## 调用链路

### FTS 探测主循环与协议

```text
FtsProbeMain(main_arg) in fts.c:117
  └─ BackgroundWorkerInitializeConnection(...)   建 DB 连接
     └─ FtsLoop() in fts.c:279
          ├─ sigHupHandler 重载 postgresql.conf（含 gp_fts_probe_interval）
          ├─ readCdbComponentInfoAndUpdateStatus()   catalog → 内存 segment 配置 + 初始化 status[]
          ├─ gp_segment_config_has_mirrors()? 否则跳过
          └─ FtsWalRepMessageSegments(cdbs) in ftsprobe.c:1297   [bool 配置是否更新]
               └─ while(!allDone && FtsIsActive()):
                    ├─ ftsConnect() in ftsprobe.c:148   PQconnectStart 异步建连 host:port
                    ├─ ftsPoll() in ftsprobe.c:437       poll(PollFds, nfds, 50) 50ms 超时
                    ├─ ftsSend() in ftsprobe.c:550       按 state 发 "PROBE dbid=X contid=Y"
                    ├─ ftsReceive() in ftsprobe.c:667    PQconsumeInput/PQgetResult 解析 5 列 bool
                    ├─ ftsCheckTimeout() in ftsprobe.c:418  gp_fts_probe_timeout(20s) 超时标失败
                    ├─ processRetry() in ftsprobe.c:836     重试 gp_fts_probe_retries(5) 次
                    └─ processResponse() in ftsprobe.c:981  状态机推进 + updateConfiguration
          ├─ writeGpSegConfigToFTSFiles() in cdbutil.c:216   dump catalog 到 flat file
          ├─ status_version++   done_count=start_count   通知等待的 backend
          └─ WaitLatch(gp_fts_probe_interval - elapsed)  等 60s 或 SIGHUP/SIGINT
```

探测协议：FTS **只直接连 primary**（primary 作为 mirror 状态的权威来源，调 `GetMirrorStatus` 报告 mirror 的 WAL 复制进度），不直接探测 mirror（除非 failover 期间向新 primary 发 PROMOTE）。响应是 1 行 5 列 bool：`is_mirror_up`/`is_in_sync`/`is_syncrep_enabled`/`is_role_mirror`/`request_retry`。

### 故障提升流程

```text
processResponse() in ftsprobe.c:981    (FTS_PROBE_FAILED 分支, :1089-1164)
  ├─ checkIfFailedDueToNormalRestart() in :210   PM 在 RESET/RECOVERY_MAKING_PROGRESS? 跳过提升
  └─ SEGMENT_IS_IN_SYNC(mirror)?
       ├─ YES: updateConfiguration(primary, mirror, newPrimaryRole='m', newMirrorRole='p', ...) in :1134
       │         ├─ probeWalRepUpdateConfig(primary->dbid, ...) in fts.c:177  旧 primary→mirror+down+notinsync
       │         ├─ probeWalRepUpdateConfig(mirror->dbid, ...)                 新 primary→primary+up+notinsync
       │         └─ FTS_STATUS_SET_DOWN(ftsProbeInfo->status[primary->dbid])    更新共享内存
       │    ftsInfo->primary_cdbinfo = mirror   交换指针
       │    ftsInfo->state = FTS_PROMOTE_SEGMENT
       │    → 下一轮 ftsSend 向新 primary 发 "PROMOTE dbid=X contid=Y"
       │         └─ HandleFtsWalRepPromote() in ftsmessagehandler.c:377
       │              ├─ GetCurrentDBState() == DB_IN_ARCHIVE_RECOVERY? (幂等：非 recovery 忽略)
       │              ├─ UnsetSyncStandbysDefined()
       │              ├─ CreateReplicationSlotOnPromote()
       │              └─ SignalPromote() in :430   SIGUSR1 触发 postmaster promotion
       └─ NO:  double fault, WARNING, FTS_RESPONSE_PROCESSED   (集群不可用)
```

### 消息处理

segment 端 `HandleFtsMessage`（`ftsmessagehandler.c:449`）解析 `"PROBE dbid=3 contid=1"` 格式消息，验证 dbid/contentid 匹配本 segment，分派三种处理：

| 消息 | 处理函数 | 位置 | 作用 |
|------|----------|------|------|
| `PROBE` | `HandleFtsWalRepProbe()` | `:259` | 查 mirror 状态、`checkIODataDirectory` 磁盘 IO 检查、返回 5 列 bool |
| `SYNCREP_OFF` | `HandleFtsWalRepSyncRepOff()` | `:308` | 关同步复制，解除 commit 阻塞 |
| `PROMOTE` | `HandleFtsWalRepPromote()` | `:377` | 提升为新 primary |

`checkIODataDirectory`（`:43-177`）是关键健康检查：用 `O_DIRECT` 开 `fts_probe_file.bak` 文件做读+写+验证 magic string，检测磁盘 IO 故障——IO 检查失败 `ereport(ERROR)`，FTS 就认为该 segment down 触发 failover，不只看进程死活。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `FtsProbeMain` in `fts.c:117` | 后台进程入口，建 DB 连接进主循环 | `BgWorkerStart_DtxRecovering` DTX 恢复期即启动 |
| `FtsLoop` in `fts.c:279` | 周期探测主循环 | `WaitLatch` 等 60s，SIGHUP 重载/SIGINT 立即探测 |
| `FtsWalRepMessageSegments` in `ftsprobe.c:1297` | 一轮完整探测（connect/poll/send/receive/retry/response） | 异步 libpq + poll 多路复用同时探测所有 primary |
| `processResponse` in `ftsprobe.c:981` | 状态机推进 + 决定提升/更新配置 | 先更新 catalog 再提升，dispatcher 通过版本号感知 |
| `updateConfiguration` in `ftsprobe.c` | 角色互换 + 标记 down + 更新共享内存 | in-sync 前置条件避免提升未同步的 mirror |
| `checkIfFailedDueToNormalRestart` in `ftsprobe.c:210` | 检测 primary 是否正常重启中 | 避免正常重启误触发 failover |
| `HandleFtsWalRepProbe` in `ftsmessagehandler.c:259` | segment 端 PROBE 处理 + IO 检查 | `O_DIRECT` 磁盘 IO 健康检查 |
| `HandleFtsWalRepPromote` in `ftsmessagehandler.c:377` | segment 端提升为新 primary | 幂等：只在 `DB_IN_ARCHIVE_RECOVERY` 执行 |
| `FtsNotifyProber` in `cdb/cdbfts.c:80` | dispatcher 通知 FTS 立即探测并等完成 | piggyback：多请求复用一轮探测 |
| `FtsIsSegmentDown` in `cdb/cdbfts.c:137` | gang 创建前查 segment 是否 down | 查共享内存 `status[]` 位图 |

</details>

## 核心实现

### 探测状态机

`FtsMessageState`（`src/include/postmaster/ftsprobe.h:30-57`）是 FTS 探测每个 primary-mirror pair 经历的状态，由 `nextSuccessState()`/`nextFailedState()`（`ftsprobe.c:57-127`）驱动转移，`processResponse()`（`:981`）根据当前状态和响应内容决定下一个状态。完整状态：`FTS_PROBE_SEGMENT`（发 probe）→ 成功 `FTS_PROBE_SUCCESS` → 处理后 `FTS_RESPONSE_PROCESSED`（终态）；失败 `FTS_PROBE_FAILED` → 重试 `FTS_PROBE_RETRY_WAIT`（1 秒）→ 回 `FTS_PROBE_SEGMENT`；重试耗尽后由 `processResponse` 决定：mirror in-sync → `updateConfiguration` 交换角色 → `FTS_PROMOTE_SEGMENT` → 发 PROMOTE；mirror not in-sync → double fault → `FTS_RESPONSE_PROCESSED`；PM 在重启中 → `FTS_RESPONSE_PROCESSED`。每个 pair 独立维护状态，互不干扰。

### 故障提升与脑裂防护

`processResponse` 的 `FTS_PROBE_FAILED` 分支（`ftsprobe.c:1117-1164`）是 failover 的决策核心。提升前必须满足 **mirror in-sync**（`SEGMENT_IS_IN_SYNC(mirror)`），否则判 double fault 不提升——这是防止数据丢失的关键。决定提升后**先更新 catalog 再发 PROMOTE**：`updateConfiguration` 把旧 primary 标记为 `role='m', status='d', mode='n'`（`probeWalRepUpdateConfig` in `fts.c:177`），dispatcher 通过 `status_version` 变化感知拓扑变化，不再向旧 primary 建 Gang，然后才向新 primary（原 mirror）发 PROMOTE 消息。

防脑裂措施层层叠加：**单点决策**（FTS 只在 coordinator 运行，`FtsProbeStartRule` 查 `Gp_role==GP_ROLE_DISPATCH`）；**in-sync 前置条件**（未同步的 mirror 不提升）；**PM 重启检测**（`checkIfFailedDueToNormalRestart` 解析 libpq 错误消息判断 RESET/RECOVERY_MAKING_PROGRESS，避免正常重启误判）；**幂等 promote**（`HandleFtsWalRepPromote` 只在 `GetCurrentDBState()==DB_IN_ARCHIVE_RECOVERY` 执行，非 recovery 忽略，防重复提升）；**PROMOTE 失败不重试提升**（`FTS_PROMOTE_FAILED` 直接 `FTS_RESPONSE_PROCESSED` 记 double fault）；**isRoleMirror 重试机制**（PROMOTE 未到达，下次 probe primary 报 `isRoleMirror=true`，FTS 重发 PROMOTE）。

### 共享内存与 piggyback 同步

`FtsProbeInfo`（`src/include/cdb/cdbfts.h:40-47`）在 coordinator 共享内存，`status[FTS_MAX_DBS]`（128*1024 槽）按 dbid 索引的 up/down 位图（`FTS_STATUS_DOWN` 位），`status_version` 状态变更时递增。dispatcher 通过 `FtsIsSegmentDown`（`cdbfts.c:137`）读位图判断 segment 是否可用，通过 `getFtsVersion`（`:173`）缓存拓扑版本、版本变化时重新获取。`start_count`/`done_count` 计数器实现 **piggyback**（README 描述）：多个外部请求（dispatcher gang 创建失败触发、用户 SQL 触发）可复用同一轮探测结果；若请求在探测进行中到达，则等新一轮探测完成拿 fresh 结果（`FtsNotifyProber` in `cdbfts.c:80`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 状态机 | `FtsMessageState` in `ftsprobe.h:30` + `nextSuccessState`/`nextFailedState` in `ftsprobe.c:57` | 故障判定流程显式化，每 pair 独立状态机，避免误判 |
| 后台 Worker | `FtsProbeMain` 经 `PMAuxProcList` 注册 in `postmaster.c:411` | 多进程架构下的事务隔离 + 崩溃自动重启 |
| 主动探测（Probing） | `FtsWalRepMessageSegments` 异步 libpq + `poll` 多路复用 | primary 是 mirror 状态权威；连接失败即故障信号；单点决策避免脑裂 |
| piggyback / 版本号同步 | `start_count`/`done_count` + `status_version` in `cdbfts.h:40` | 多请求复用一轮探测，避免探测风暴；版本号让 dispatcher 缓存失效 |
| 条件编译双模 | `#ifdef USE_INTERNAL_FTS` in `fts.c`/`ftsprobe.c` | 内置 background worker 模式 vs 外置 ETCD 模式（`readGpSegConfigFromETCD`） |

## 模块间交互

FTS 被 **coordinator postmaster** 启动（`PMAuxProcList` 注册 `FtsProbeMain` + `FtsProbeStartRule`，`postmaster.c:411`；`FtsProbeStartRule` 只在 `Gp_role==GP_ROLE_DISPATCH` 返回真，`fts.c:108`；启动时机 `BgWorkerStart_DtxRecovering`，DTX 恢复期即起）。共享内存 `FtsControlBlock` 只在 coordinator/utility 模式分配（`ipci.c:170,331`）。FTS 调用三方：**libpq** 连 segment（`PQconnectStart` 异步，conninfo `gpconntype=fts`）；**catalog** 更新 `gp_segment_configuration`（`table_open`+`systable_beginscan`+`CatalogTupleUpdate`）和 `gp_configuration_history`（`CatalogTupleInsert`）；**配置 dump** `writeGpSegConfigToFTSFiles`（`cdbutil.c:216`）序列化到 `$PGDATA` flat file 供非事务上下文读。

与 [cdb](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/01-cdb) 协作是核心：dispatcher 在 `cdbgang_async.c:104` gang 创建前查 `FtsIsSegmentDown` + 失败时 `FtsNotifyProber` 通知 FTS 立即探测并阻塞等完成（报 "gang was lost due to cluster reconfiguration"）；`cdbdisp_async.c:607` dispatcher 轮询发现连接错误时 `FtsNotifyProber`+`checkSegmentAlive`；`cdbdisp_async.c:643` 比较 `ftsVersion != getFtsVersion()` 检测拓扑变化。流程闭环：FTS 更新 catalog → `status_version++` → dispatcher 下次获取拓扑发现版本变化 → 重建 Gang 用新配置。

## 扩展方式

- **修改探测间隔**：改 `src/backend/utils/misc/guc_gp.c:4092` 的 `gp_fts_probe_interval`（默认 60s，范围 10-3600，`PGC_SIGHUP` 支持 `ALTER SYSTEM SET` + reload，下一轮探测生效）。
- **新增一种 segment 状态/探测消息**：在 `fts_comm.h:44` 加消息宏（如 `FTS_MSG_VERIFY`）；在 `ftsprobe.h:30` 的 `FtsMessageState` 加状态（`FTS_VERIFY_SEGMENT` + `*_SUCCESS`/`*_FAILED`/`*_RETRY_WAIT`）；在 `ftsprobe.c:57,127` 的 `nextSuccessState`/`nextFailedState` 加转移规则；在 `ftsSend`（`:550`）加发送、`processResponse`（`:981`）加响应分支、`HandleFtsMessage`（`:449`）加分派 + 新增 `HandleFtsWalRepVerify`。
- **修改提升决策逻辑**：改 `ftsprobe.c:1119` 的 `SEGMENT_IS_IN_SYNC(mirror)` 前置条件判断、`:1134-1138` 的 `updateConfiguration` 角色互换、`:1093-1115` 的 PM 重启检测。如加 grace period：在 `FTS_PROBE_FAILED` 分支加计数器，连续 N 次失败才真标 down 触发提升（当前是重试 `gp_fts_probe_retries` 次后立即判 down）。

扩展点契约：FTS 的扩展本质是"在状态机里加一种探测/提升路径"，必须同步 coordinator 侧（`ftsprobe.c` 状态机 + 消息收发）与 segment 侧（`ftsmessagehandler.c` 消息处理）两端，并更新 `fts_comm.h` 的消息格式与响应字段。
