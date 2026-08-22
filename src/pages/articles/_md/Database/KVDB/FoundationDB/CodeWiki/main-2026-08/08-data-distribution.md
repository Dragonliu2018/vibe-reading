---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "数据分布"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "main-2026-08"]
tags: ["FoundationDB", "C++", "DataDistributor", "Shard", "Team", "Relocation", "Wiggler"]
description: "数据分布——DataDistributor 把 key range 分片到 storage team，监控负载触发迁移，三阶段 moveKeys 协议 + StorageWiggler 渐进轮换，FDB 弹性伸缩与容错的数据平面。"
readingTime: "38 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`datadistributor/`（~25k 行）是 FDB 的数据分布与负载均衡。DataDistributor（DD）角色把 key range 分片（shard）分配到 storage server 团队（team），监控分片大小与负载，触发迁移（relocation）以平衡负载、处理故障、响应扩缩容。它是 FDB 弹性伸缩与容错的数据平面——存储层故障不触发恢复，而由 DD 招募替代或迁移数据。

## 模块架构

DD 把三个关注点解耦为独立 actor 组件，经 `PromiseStream<RelocateShard>` 和 `GetTeamRequest` 异步连接：shard 生命周期管理（tracker）、team 管理与监控（teamCollection）、迁移调度（DDQueue）。

- **DataDistributor**（`DataDistribution.cpp:394`）——顶层协调器，NonCopyable + ReferenceCounted。持 `DDSharedContext context`、`IDDTxnProcessor txnProcessor`、`MoveKeysLock lock`、`InitialDataDistribution initData`、`PromiseStream<RelocateShard> relocationProducer/relocationConsumer`。引导方法 `takeMoveKeysLock`/`loadDatabaseConfiguration`/`loadInitialDataDistribution`/`resumeRelocations`/`pollMoveKeysLock`。
- **DDSharedContext**（`DDSharedContext.h:33`）——所有子组件共享的引用容器：`DDEnabledState`、`DataDistributorInterface`、`MoveKeysLock`、`ShardsAffectedByTeamFailure`、`DataDistributionTracker`、`DDQueue`、`primaryTeamCollection`/`remoteTeamCollection`。注释要求"避免变成庞大 class"——只存引用不存逻辑。
- **DDTeamCollection**（`DDTeamCollection.h:212`）——每 DC 一个，管理该 DC 所有 SS/server team/machine/machine team。`server_info`（所有 SS）、`teams`、`machine_info`、`machineTeams`、`storageWiggler`、`server_status`（`AsyncMap`）。`getTeam(GetTeamRequest)`→`getBestTeam()`、`teamTracker()`、`storageServerTracker()`、`storageRecruiter()`、`buildTeams()`、`addBestMachineTeams()`/`addTeamsBestOf()`。
- **TCServerInfo / TCTeamInfo / TCMachineInfo**（`TCInfo.h`）——SS/team/machine 抽象。`TCTeamInfo`（`:184`，实现 `IDataDistributionTeam`）含 `servers`/`healthy`/`priority`/`eligibilityCounter`/`machineTeam`，`getLoadBytes(includeInFlight, inflightPenalty)`/`getReadLoad()`。
- **ShardsAffectedByTeamFailure**（`.h:28`）——反向索引：给定 team 找其所有 shard，给定 shard 找所属 team。`shard_teams`（`KeyRangeMap<pair<vector<Team>, vector<Team>>>`，first=当前 source/dest team，second=历史 source）+ `team_shards` 反向索引 + `storageServerShards` 每 SS shard 计数。`defineShard`/`moveShard`/`finishMove`/`getShardsFor(Team)`。
- **DDQueue**（`DDRelocationQueue.h:125`）——迁移调度器：`queueMap`（排队中）、`fetchingSourcesQueue`/`fetchKeysComplete`、`queue`（per SS）、`inFlight`（迁移中）、`inFlightActors`、`busymap`/`destBusymap`（source/dest 负载）、`priority_relocations`。`RelocateData`（keys/priority/boundaryPriority/healthPriority/src/completeSources/completeDests/wantsNewServers/dataMove）。`Busyness` 10 优先级桶 ledger，`canLaunch(prio, work)`。
- **DataDistributionTracker**（`DDShardTracker.h:55`）——监控每 shard metrics（bytes/write/read bandwidth）触发 split/merge/relocate。`shardSplitter()`/`shardMerger()`/`executeShardSplit()`/`trackShardMetrics()`。`maxShardSize` 随 dbSize 自适应。
- **StorageWiggler**（`StorageWiggler.h:37`）——渐进轮换 SS 调度器，min-heap 按 `StorageMetadataType`（creation time + wrongConfigured）排序。`addServer`/`getNextServerId`/`necessary`。

## 调用链路

team 故障 → 迁移的完整流程：

```text
1. 检测故障
   storageServerFailureTracker()  [DDTeamCollection.actor.cpp:1964]  监控 ServerStatusMap.onChange(uid)
2. teamTracker 响应  [:1002]
   └─ quorum(change,1) 等任一 status 变化 → 计算 serversLeft
      └─ setPriority(PRIORITY_TEAM_2_LEFT)  // 3 副本降到 2
      └─ shardsAffectedByTeamFailure->getShardsFor(Team)  找该 team 所有 shard
      └─ 对每 shard 构造 RelocateShard(shard, maxPriority) → output.send(rs)
3. DDQueue 接收
   queueRelocation()  [DDRelocationQueue.cpp:848]  合并重叠请求（取最大 priority）→ queueMap + queue[src]
4. launchQueuedWork()  [:1143]
   └─ 检查 overlappingInFlight + canLaunchSrc(busyness)
      inFlight.insert → dataDistributionRelocator(this, rrs, ...)  [:1561]
5. dataDistributionRelocator
   └─ 循环 getSrcDestTeams(primary + remote):
      getTeam(GetTeamRequest) → getBestTeam()  [:400]
      shardsAffectedByTeamFailure->moveShard(keys, destTeams)
      moveKeys()  [MoveKeys.cpp:4039]  三阶段协议:
        Phase 1 startMoveKeys(): 写 keyServers dest=新team（src保留）+ serverKeys dest=true + commit
        Phase 2 rawCheckFetchingState（异步）: dest SS 收 private mutation → fetchKeys 从 source 读
        Phase 3 rawFinishMovement → finishMoveKeys(): 原子交换 src→dest + 清旧数据 + commit
6. processRelocationComplete()  [:834]

数据结构变化:
  shard_teams: [oldTeam] → [newTeam, oldTeam] → [newTeam]
  keyServers:  src=[old],dest=[] → src=[old],dest=[new] → src=[new],dest=[]
```

shard 过大触发 split：`trackShardMetrics()`（`DDShardTracker.cpp:176`）检测 `metrics.bytes > maxShardSize` → `shardSplitter()`（`:463`）`db->splitStorageMetrics` 取 split 点 → `executeShardSplit()`（`:418`）`defineShard` 更新边界 → `output.send(RelocateShard(r, SPLIT_SHARD))`。`maxShardSize = min((MIN_SHARD_BYTES + sqrt(dbSize)*RATE)*RATIO, MAX_SHARD_BYTES)` 自适应数据库增长。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `DataDistributor` | `DataDistribution.cpp:394` | DD 主体 |
| `takeMoveKeysLock` | `:480` | 获取单例锁设自己为 owner |
| `loadInitialDataDistribution` | — | 从系统 keyspace 恢复 shard/team 映射 |
| `teamTracker` | `DDTeamCollection.actor.cpp:1002` | 监控 team 健康触发迁移 |
| `getBestTeam` | `:400` | 负载均衡选 team |
| `queueRelocation` | `DDRelocationQueue.cpp:848` | 接收并排序迁移请求 |
| `launchQueuedWork` | `:1143` | 启动迁移 actor |
| `dataDistributionRelocator` | `:1561` | 执行单次迁移 |
| `moveKeys` | `MoveKeys.cpp:4039` | 三阶段数据迁移协议 |
| `shardSplitter` | `DDShardTracker.cpp:463` | shard 过大 split |
| `perpetualStorageWiggler` | `DDTeamCollection.actor.cpp:2491` | 渐进轮换 |
</details>

## 核心实现

### Shard/Team 抽象

FDB 把 key space 分为不重叠 shard（KeyRange），每个分配给一个 server team（k 个 SS 副本）。team 是数据逻辑归属单元——shard ownership 存系统 keyspace `keyServers`（`\xff/keyServers/[start_key]`）和 `serverKeys`（`\xff/serverKeys/[serverID]/[start_key]`），`ShardsAffectedByTeamFailure` 维护内存反向索引。team 和 shard 解耦：一个 team 可拥有多 shard，shard 可 split/merge 不影响 team 构成。

### Relocation Queue（异步迁移队列）

所有迁移经 `RelocateShard` 请求进 DDQueue，按 priority 排序，异步——不阻塞调用方，放 `queueMap` 后立即返回，迁移在后台 `dataDistributionRelocator` actor 执行。`Busyness` 限每 server 并行迁移数防过载。`queueRelocation` 合并重叠请求——新请求覆盖已排队的旧请求则取消旧的，priority 取最大值，避免重复迁移同一数据。

### Team Selection（负载均衡选择）

`getBestTeam`（`:400`）遍历 healthy team，按 `GetTeamRequest::lessCompare` 排序：`preferLowerDiskUtil` 选 `getLoadBytes()` 最小；`forReadBalance` 按 `getReadLoad()`；`WANT_TRUE_BEST` 全遍历选最优（MountainChopper）；`ANY` 随机起点（ValleyFiller）。`EligibilityCounter` gate 用 `pivotAvailableSpaceRatio`（集群中位数 free ratio，clamp [5%,30%]）过滤过满 team 作 dest——在不均匀硬件上自动导向更空 disk。

### MoveKeys 三阶段协议

`moveKeys()`（`MoveKeys.cpp:4039`）实现异步增量迁移：Phase 1 `startMoveKeys` 原子把 dest 加入 `keyServers`（src+dest 并存），commit proxy 同时向 src+dest 路由写；Phase 2 dest SS 后台 `fetchKeys` 从 src 读数据（不阻塞 DD）；Phase 3 `finishMoveKeys` 数据就绪后原子交换 src→dest 移除旧 src。迁移期间数据仍可读写（src 仍服务），DD 可同时管数百并发迁移（受 `Busyness`/`FlowLock`），DD 崩溃可从 `DataMoveMetaData` 恢复，大 shard 可跨多事务分批（`MOVE_KEYS_KRM_LIMIT`）。

### StorageWiggler（渐进轮换）

解决长期运行集群的滚动维护（旧引擎、旧配置、打补丁、换磁盘）。按 creation time 排序 min-heap，自动逐个排除最老 SS：`perpetualStorageWiggleIterator` 选下一个 → 写 `perpetualStorageWiggleIDPrefix` → `perpetualStorageWiggler` watch → `excludeStorageServersForWiggle` 标 excluded → teamTracker 发 `RelocateShard(PRIORITY_PERPETUAL_STORAGE_WIGGLE=141)` → 数据迁走 → `removeServer` → `includeStorageServersForWiggle` 重新允许招募。集群不健康时 `clusterHealthCheckForPerpetualWiggle` 自动暂停。无需停机的 gradual rolling maintenance。

### Private Mutation 传播

Shard map 变更必须对所有 commit proxy 一致。DD 不直接 RPC 通知 SS，而是经 FDB 自身事务系统传播 private mutation：DD 写 `keyServers`/`serverKeys` 系统 key → commit proxy 分类为 private mutation → TLog 按 tag 路由到相关 SS → SS `applyPrivateData()` 处理（`nowAssigned=true`→`fetchKeys`，`false`→清数据）。保证 serializability（resolver 保证并发变更可串行化）、total order（所有 proxy 同序应用）、durability（tLog 持久化）、atomicity（`finishMoveKeys` 单事务原子交换）。代价：与用户事务竞争 commit proxy 带宽。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Shard/Team 抽象 | `DataDistribution.h:458`、`TCInfo.h:184` | 分片独立分配，支持 PB 级扩展 |
| Relocation Queue | `DDRelocationQueue.h:125` | 异步迁移不阻塞，合并防重复 |
| Team Selection | `DDTeamCollection.actor.cpp:400` | 多策略负载均衡，eligibility gate |
| Wiggler | `StorageWiggler.h:37` | 渐进滚动维护无需停机 |
| MoveKeysLock | `MoveKeys.h` | 单例锁保证唯一 DD 改 shard map |
| Private Mutation | `MoveKeys.cpp` 传播 | 复用事务 ACID 保证 shard map 一致 |

## 模块间交互

依赖 fdbrpc/flow。与 StorageServer（数据落点，经 private mutation 间接控制 + `getStorageMetrics` RPC 获取指标）、ClusterController（`storageRecruiter` 监听 `RecruitStorageRequest` 招募新 SS，经 `dbInfo` 获知拓扑）、fdbclient（系统 keyspace 元数据，`IDDTxnProcessor` 封装事务操作抽象层）。多 DC 时维护 primary + remote 两个 `DDTeamCollection`，每 shard 需两 DC 各一 team，`Team.primary` 标志区分。

## 扩展方式

新增 team 选择策略：`DataDistributionTeam.h:140` `GetTeamRequest` 加字段（如 `preferLowerCPU`），`IDataDistributionTeam` 确保有 `getAverageCPU()`，`DDTeamCollection.actor.cpp:400` `getBestTeam` 加 CPU 排序，`DDRelocationQueue.cpp:2891` `BgDDLoadRebalance` 设 `preferLowerCPU`，`ServerKnobs.cpp` 加开关——`EligibilityCounter` 已支持 `LOW_CPU`。调整分片大小：改 `ServerKnobs.cpp` 的 `MIN_SHARD_BYTES`/`SHARD_BYTES_RATIO`/`MAX_SHARD_BYTES`/`SHARD_MAX_BYTES_PER_KSEC`，`getMaxShardSize()` 公式自动用，无需改代码。新增迁移优先级：`ServerKnobs.cpp` 加 `PRIORITY_*` knob，`DataDistribution.h:46` `DataMovementReason` enum 加值，`RelocateData::isHealthPriority()` 加，触发点构造 `RelocateShard`。
