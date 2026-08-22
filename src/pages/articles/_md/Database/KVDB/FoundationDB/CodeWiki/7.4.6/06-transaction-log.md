---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "事务日志"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "7.4.6"]
tags: ["FoundationDB", "C++", "TLog", "WAL", "Tag", "Spilling", "Generation"]
description: "事务日志——TLog 持久 mutation 日志 + LogSystem 拓扑管理 + LogRouter 跨 region，tag 分区 + spill-by-reference + generation 切换，FDB 读写分离的关键。"
readingTime: "42 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/7.4.6/00-overview)

---

## 模块定位

`fdbserver/TLogServer.actor.cpp` + `fdbserver/LogSystem.cpp` + `fdbserver/LogRouter.cpp` 是 FDB 的持久化事务日志。TLog 顺序记录所有 mutation（按 commit version 顺序），mutation 先持久化到 TLog 再异步落盘到 StorageServer——这是 FDB 读写分离的关键，commit 延迟只取决于 TLog 的顺序写速度。LogSystem 管理日志拓扑（多副本、generation 切换），LogRouter 跨 region 转发。恢复时从 TLog 重建事务系统状态。

## 模块架构

TLog 的核心是 **SharedTLog 多 generation 架构**——一个进程运行一个 SharedTLog，但可同时持有多个 generation 的 `LogData`：

- **TLogData**（`TLogServer.actor.cpp`）——单 SharedTLog 进程全局状态：`popOrder`（按 version 排序的 log ID 队列）、`spillOrder`、`id_data`（logId→LogData）、`persistentData`（已 spill 到磁盘的 B-tree）、`rawPersistentQueue`（物理磁盘队列）、`persistentQueue`（`TLogQueue` 封装）、`targetVolatileBytes`（spill 阈值 = `TLOG_SPILL_THRESHOLD`）、`peekMemoryLimiter`。
- **LogData**——一个 generation 的 TLog 状态：`TagData::versionMessages`（per-tag 内存 mutation 队列，存 `(Version, LengthPrefixedStringRef)` 指向 `messageBlocks`）、`persistentDataVersion`/`persistentDataDurableVersion`、`version`/`queueCommittedVersion`、`knownCommittedVersion`/`durableKnownCommittedVersion`、`recoveredAt`、`tag_data[locality][id]`、`logSystem`/`logSystemConsumer`。
- **TLogQueue**——`IDiskQueue`（`fdbserver/DiskQueue.actor.cpp`）封装，按 entry 的 push/read，格式 `payloadSize | payload | validFlag`，记 `versionLocation[version]` 供 spill-by-reference 回查。
- **TLogInterface**（`fdbserver/include/fdbserver/TLogInterface.h`）——RPC 端点：`peekMessages`/`peekStreamMessages`/`popMessages`/`commit`/`lock`/`confirmRunning`/`trackRecovery`。
- **LogSystem**（`fdbserver/LogSystem.cpp` + `fdbserver/include/fdbserver/LogSystem.h`）——拓扑管理：`tLogs`（不同 location 的 `LogSet`：primary/satellite/remote）、`oldLogData`（旧 generation）、`knownCommittedVersion`、`outstandingPops`。`LogSystemType` 恒为 tagPartitioned（无其他类型）。`LogPushData` 收集 tag 并计算 push locations。
- **LogSet**（`LogSystem.h`）——一组 TLog 副本：`logServers`/`logRouters`/`backupWorkers`、`tLogWriteAntiQuorum`/`tLogReplicationFactor`/`tLogPolicy`、`getPushLocations()`（tag→TLog 映射）。

**Tag**（`fdbclient/include/fdbclient/FDBTypes.h`）是 mutation 路由核心，紧凑结构 `int8_t locality + uint16_t id`。locality 类型：`tagLocalitySpecial`(-1)、`tagLocalityLogRouter`(-2，每条 mutation 都有，跨 region 转发)、`tagLocalityRemoteLog`(-3)、`tagLocalitySatellite`(-5)、`tagLocalityTxs`(-7)、`tagLocalityBackup`(-8)、`>=0` 普通 storage server tag（locality=DC id）。

## 调用链路

Mutation 写入：CommitProxy → TLog → StorageServer：

```text
CommitProxy 收集 mutation batch（version N-1→N）
  ├─ LogPushData::writeTypedMessage()  addTag + logSystemGetPushLocations
  │   → LogSet::getPushLocations()  tag.id % logServers.size() + selectReplicas()
  │   写入 messagesWriter[loc]，有 remote log 则追加 router tag
  └─ LogSystem::push()  对每个 isLocal LogSet 构造 TLogCommitRequest 发到 logServer[loc].commit
      └─ quorum(results, size - antiQuorum)  等写仲裁
          minVersionWhenReady() 返回所有 TLog 最小已提交版本
  ▼
TLog tLogCommit()  [TLogServer.actor.cpp:2378]
  ├─ 等 logData->version.whenAtLeast(prevVersion)  按 version 顺序处理
  ├─ bytesInput - bytesDurable >= TLOG_HARD_LIMIT_BYTES? 等待 spilling（反压）
  ├─ commitMessages()  按 tag 分发到 TagData::versionMessages + 追加 messageBlocks
  ├─ persistentQueue->push(TLogQueueEntryRef)  追加磁盘队列未 commit
  ├─ logData->version.set(req.version)  通知 commitQueue/peekMessages
  └─ 等 queueCommittedVersion.whenAtLeast(req.version) 才回 proxy
      ↑ commitQueue()  [:2310] doQueueCommit()  [:2248]
        persistentQueue->commit() fsync → durableKnownCommittedVersion = knownCommittedVersion
        → queueCommittedVersion.set(ver)

StorageServer 消费（异步）:
  LogSystemConsumer::peek()  先读 spilled B-tree（若 begin <= persistentDataDurableVersion）再读内存
  → tLogPeekMessages()  [TLogServer.actor.cpp:1747]
  → StorageServer 应用后:
  TLogPopRequest{to, durableKnownCommittedVersion, tag}
  → tLogPop()  [:494] → tagData->popped = upTo, eraseMessagesBefore(popped)
      若所有 tag pop 了 recoveredAt → recoveryComplete
```

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `tLog` | `TLogServer.actor.cpp` | TLog 主 actor |
| `tLogCommit` | `:2378` | 接收 commit 写内存+磁盘队列 |
| `commitMessages` | `TLogServer.actor.cpp` | per-tag 分发 mutation |
| `commitQueue`/`doQueueCommit` | `:2310`/`:2248` | 持续提交磁盘队列 fsync |
| `tLogPeekMessages` | `:1747` | StorageServer peek |
| `tLogPop` | `:494` | 回收已消费 mutation |
| `updateStorage` | `:1347` | spill 主循环 |
| `updatePersistentData` | `:210` | spill 到 B-tree（value/reference） |
| `rejoinClusterController` | `:2547` | TLog 向新 CC 重注册 |
| `LogSystem::push` | `fdbserver/LogSystem.cpp` | 推送 commit 到所有 TLog |
| `LogSystem::epochEnd` | 同上 | 锁定旧 TLog |
| `LogSystem::newEpoch` | 同上 | 招募新 TLog |
| `LogSystem::getDurableVersion` | 同上 | 计算持久化版本 |
| `LogSet::getPushLocations` | `LogSystem.h` | tag→TLog 路由 |
| `LogRouter::pullAsyncData` | `fdbserver/LogRouter.cpp` | 跨 region 拉取 |
| `LogRouter::waitForVersion` | `LogRouter.cpp:297` | 流控 |
</details>

## 核心实现

### WAL + tag 分区

TLog 本质是分布式 WAL。`tLogCommit()`（`:2378`）接收 commit 写入 per-tag 内存队列与磁盘队列，`commitQueue`（`:2310`）调 `doQueueCommit()`（`:2248`）fsync 持久化后才回复 proxy。FDB 按 tag 对 mutation 分区：`getPushLocations()`（`LogSystem.h`）根据 tag 决定 mutation 推送到哪些 TLog，使不同 locality 的 TLog 只接收自己负责的 tag；`commitMessages` 按 tag 分发到 `TagData::versionMessages`，satellite TLog 只索引 satellite 相关 tag。这使得 StorageServer 只 peek 自己的 tag 队列，避免扫描全量 commit；`tagLocalityLogRouter` tag 被推送到有 LogRouter 的 LogSet 支持跨 region 转发。

### Spilling（内存→磁盘分级）

当 `bytesInput - bytesDurable >= targetVolatileBytes`（`TLOG_SPILL_THRESHOLD`）时，TLog 把内存 mutation spill 到磁盘 B-tree。`updateStorage()`（`:1347`）按 `spillOrder` 从最老 LogData 开始，单批限 `REFERENCE_SPILL_UPDATE_STORAGE_BYTE_LIMIT`。两种策略：**spill-by-value**（`updatePersistentData` `:210`）mutation 完整拷贝到 B-tree，适用 txs tag；**spill-by-reference** B-tree 只存指针 `(tag, lastVersion) → [(version, diskQueueStart, length, mutationBytes)]`（`SpilledData`），mutation 数据留磁盘队列，适用普通 storage server tag。设计文档说明这把 B-tree 写入从 `O(tags * versions)` 降为 `O(tags)`——之前 spill-by-value 30 分钟后写带宽降至 10%，spill-by-reference 大幅减少写放大。peek 需先读 B-tree 指针再从磁盘队列读，`parseMessagesForTag` 过滤目标 tag。

### Generation 切换（故障恢复安全）

epoch（generation）号管理日志拓扑。故障时 `endEpoch()`→`epochEnd()`（`LogSystem.cpp`）锁定当前 TLog 停止新 commit，`getDurableVersion()` 计算 recovery version，`newEpoch()` 招募新 TLog 并设旧 generation 信息到 `oldLogData`。新 TLog 经 `pullAsyncData()`（`LogRouter.cpp`）从旧 TLog 拉缺失 mutation，`recoveryComplete` 信号通知完成。旧 generation 清理由 `purgeOldRecoveredGenerationsCoreState()`，`oldTLogData.empty()` 时恢复达 `STORAGE_RECOVERED`。

### 写反仲裁 + 读仲裁安全不变式

`getDurableVersion()`（`LogSystem.cpp`）计算 `requiredCount = logSet->logServers.size() + 1 - tLogReplicationFactor + logSet->tLogWriteAntiQuorum`。注释明确 "the number of servers NOT in the write quorum plus the number of servers NOT in the read quorum have to be strictly less than the replication factor"——即 **`W + (N-R) < F`**，保证不可能出现"所有可用 TLog 都不在写仲裁中"。`tLogLock()` 锁定时等 `queueCommittedVersion.whenAtLeast(stopVersion)` 确保已接收 commit 都已持久化。`knownCommittedVersion` 追踪"所有 TLog 已确认"的最大版本。

### LogRouter 跨 region 转发

非 primary TLog 经 `pullAsyncData()`（`LogRouter.cpp`）从上游拉取：优先从 satellite TLog peek 慢时切 primary；`getMessageWithTags` 提取消息；`logSet.getPushLocations()` 计算 tag→remote TLog 映射；tag 重映射为 `Tag(tagLocalityRemoteLog, t)`。`waitForVersion()`（`:297`）流控——remote TLog 没 pop 足够数据时 LogRouter 阻塞，`MAX_READ_TRANSACTION_LIFE_VERSIONS` 限制最大未 pop 版本跨度。`logRouterPop()` remote TLog pop 时算全局 `minPopped`，`poppedVersion = min(minKnownCommittedVersion, minPopped)` 向上游 pop，用 `getPseudoPopTag()` 把 `tagLocalityLogRouter` 映射为 `tagLocalityLogRouterMapped`。

### Pseudo-locality

多消费者（LogRouter、BackupWorker）可能消费同一份 `tagLocalityLogRouter` 数据。`addPseudoLocality()`（`LogSystem.cpp`）注册 `tagLocalityLogRouterMapped` 或 `tagLocalityBackup`，允许独立追踪每消费者 pop 进度，只有所有消费者都 pop 了某版本才真正从 TLog 回收。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| WAL 读写分离 | `tLogCommit` `TLogServer.actor.cpp:2378` | commit 延迟只取决于顺序写，落盘异步 |
| Tag 分区 | `LogSystem.h` `getPushLocations` | SS 只 peek 自己 tag，避免全量扫描 |
| Spilling 分级 | `updateStorage` `TLogServer.actor.cpp:1347` | spill-by-reference 降写放大 |
| Generation 切换 | `LogSystem.cpp` `epochEnd`/`newEpoch` | recoveryCount + 写反仲裁保证故障安全 |
| 跨 region 转发 | `LogRouter.cpp` `pullAsyncData`/`waitForVersion:297` | satellite→primary 切换 + 流控 |

## 模块间交互

依赖 fdbrpc/flow。被 CommitProxy（`push`）、StorageServer（`peek`/`pop`）、ClusterController（招募 `InitializeTLogRequest` + `trackRecovery`）。CommitProxy 经 `LogSystem::push` 推送等写仲裁 `quorum(size - antiQuorum)`。StorageServer 经 `LogSystemConsumer::peek`（`peekLocal`/`peekSingle`/`peekLogRouter`/`peekAll`/`peekTxs`）拉取，应用后 `TLogPopRequest` 回收。TLog 经 `rejoinClusterController`（`:2547`）向新 CC 重注册。持久化版本追踪链：CommitProxy→`TLogCommitRequest{knownCommittedVersion}`→TLog `durableKnownCommittedVersion`→`TLogPeekReply`→LogRouter `minKnownCommittedVersion`→`TLogPopRequest`→上游 pop。

## 扩展方式

新增 TLog 副本策略：改 `LogSet` 的 `tLogPolicy` 与 `getPushLocations`，同步改 `getDurableVersion` 的 `requiredCount` 保证 `W + (N-R) < F`，注意 `LogSystemConfig` 序列化前向兼容。调整 spilling 阈值：改 `SERVER_KNOBS->TLOG_SPILL_THRESHOLD`（影响 `targetVolatileBytes`）及 `TLOG_HARD_LIMIT_BYTES`（反压硬限）、`REFERENCE_SPILL_UPDATE_STORAGE_BYTE_LIMIT`（单批）、`TLOG_RECOVER_MEMORY_LIMIT`——增大减 spilling 但增内存与 crash 恢复时间。调整 DiskQueue：改 `TLOG_DISK_QUEUE_EXTENSION_BYTES`/`SHRINK_BYTES`，`popDiskQueue` 计算 `poppedLocation` 后 `persistentQueue->pop()` 回收。修改 LogRouter 流控：改 `LogRouter::waitForVersion`（`:297`）与 `LOG_ROUTER_PEEK_SWITCH_DC_TIME`。
