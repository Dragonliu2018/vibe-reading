---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "数据分布"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "7.4.6"]
tags: ["FoundationDB", "C++", "DataDistributor", "Shard", "Team", "Relocation", "Wiggler"]
description: "数据分布——DataDistributor 把 key range 分片到 storage team，监控负载触发迁移，三阶段 moveKeys 协议 + StorageWiggler 渐进轮换，FDB 弹性伸缩与容错的数据平面。"
readingTime: "38 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/7.4.6/00-overview)

---

## 模块定位

`fdbserver/DataDistribution.actor.cpp` + `DDTeamCollection.actor.cpp` + `DDRelocationQueue.actor.cpp` + `DDShardTracker.actor.cpp` + `MoveKeys.actor.cpp` 是 FDB 的数据分布与负载均衡。DataDistributor（DD）角色把 key range 分片（shard）分配到 storage server 团队（team），监控分片大小与负载，触发迁移（relocation）以平衡负载、处理故障、响应扩缩容。它是 FDB 弹性伸缩与容错的数据平面——存储层故障不触发恢复，而由 DD 招募替代或迁移数据。

## 模块架构

DD 把三个关注点解耦为独立 actor 组件，经 `PromiseStream<RelocateShard>` 和 `GetTeamRequest` 异步连接：shard 生命周期管理（tracker）、team 管理与监控（teamCollection）、迁移调度（DDQueue）。

- **DataDistributor**（`DataDistribution.actor.cpp:404`）——顶层协调器，NonCopyable + ReferenceCounted。持 `DDSharedContext context`、`IDDTxnProcessor txnProcessor`、`MoveKeysLock lock`、`InitialDataDistribution initData`、`PromiseStream<RelocateShard> relocationProducer/relocationConsumer`。引导 `takeMoveKeysLock`（`:492`）/`loadInitialDataDistribution`（`:500`）/`init`（`:595`）/`resumeFromShards`（`:744`）。
- **DDSharedContext**（`fdbserver/include/fdbserver/DDSharedContext.h:32`）——所有子组件共享引用容器：`DDEnabledState`、`DataDistributorInterface`、`MoveKeysLock`、`ShardsAffectedByTeamFailure`、`DataDistributionTracker`、`DDQueue`、`primaryTeamCollection`/`remoteTeamCollection`。只存引用不存逻辑。
- **DDTeamCollection**（`fdbserver/include/fdbserver/DDTeamCollection.h:206`）——每 DC 一个，管理该 DC 所有 SS/server team/machine team。`server_info`/`teams`/`machine_info`/`machineTeams`/`storageWiggler`/`server_status`。`getTeam`（`:707`）、`teamTracker`（`DDTeamCollection.actor.cpp:996`）、`storageServerTracker`（`:1357`）、`buildTeams`（`:841`）、`perpetualStorageWiggler`（`:2435`）。
- **TCServerInfo / TCTeamInfo**（`fdbserver/include/fdbserver/TCInfo.h`）——`TCServerInfo`（`:37`）每 SS 一个；`TCTeamInfo`（`:185`，实现 `IDataDistributionTeam`）含 `servers`/`healthy`/`priority`/`eligibilityCounter`，`getLoadBytes(includeInFlight, inflightPenalty)`/`getReadLoad`/`getAverageCPU`。
- **IDataDistributionTeam / GetTeamRequest**（`fdbserver/include/fdbserver/DataDistributionTeam.h:57`/`:140`）——team 抽象接口 + 选择请求（`TeamSelect` `:113`：ANY/WANT_COMPLETE_SRCS/WANT_TRUE_BEST；`preferLowerDiskUtil`/`forReadBalance`/`completeSources`/`src`；`lessCompare`）。
- **DDQueue / RelocateData / Busyness**（`fdbserver/include/fdbserver/DDRelocationQueue.h:125`/`:38`/`:97`）——迁移调度器：`queueMap`/`fetchingSourcesQueue`/`fetchKeysComplete`/`queue`（per SS）/`inFlight`/`inFlightActors`/`busymap`/`destBusymap`/`priority_relocations`。`RelocateData`（`:38`）keys/priority/boundaryPriority/healthPriority/src/completeSources/dataMove。`Busyness`（`:97`）10 优先级桶 ledger，`canLaunch(prio, work)`。
- **DataDistributionTracker**（`fdbserver/include/fdbserver/DDShardTracker.h:56`）——监控每 shard metrics（bytes/write/read bandwidth）触发 split/merge/relocate。`shardTracker`（`DDShardTracker.actor.cpp:1309`）/`shardEvaluator`（`:1243`）/`shardSplitter`（`:866`）/`shardMerger`（`:1061`）。`maxShardSize` 随 dbSize 自适应。
- **StorageWiggler**（`fdbserver/include/fdbserver/DataDistribution.actor.h:799`）——渐进轮换 SS，`boost::heap::skew_heap` 按 `StorageMetadataType`（创建时间+storeType）排序。`necessary`（`DataDistribution.actor.cpp:235`）/`getNextServerId`/`startWiggle`/`finishWiggle`。
- **ShardsAffectedByTeamFailure**（`fdbserver/include/fdbserver/ShardsAffectedByTeamFailure.h:28`）——反向索引：`shard_teams`（`:124`，KeyRangeMap<pair<vector<Team>,vector<Team>>>，first=当前 dest/src，second=历史 src）+ `team_shards`（`:127`）+ `storageServerShards`（`:128`）。`defineShard`（`:96`）/`moveShard`（`:99`）/`finishMove`（`:104`）/`getShardsFor`（`:82`）。
- **MoveKeysLock**（`fdbserver/include/fdbserver/MoveKeys.actor.h:37`）——单例锁 owner+write key。

## 调用链路

team 故障 → 迁移的完整流程：

```text
1. 检测故障: storageServerTracker 监控 server_status.onChange
2. teamTracker()  [DDTeamCollection.actor.cpp:996]
   └─ quorum(change,1) 等任一 status 变化 → 计算 serversLeft
      └─ 按 serversLeft 设 priority: TEAM_0_LEFT/TEAM_1_LEFT/TEAM_2_LEFT/UNHEALTHY/CONTAINS_UNDESIRED  [:1170-1195]
      └─ shardsAffectedByTeamFailure->getShardsFor(Team) 找该 team 所有 shard  [:1227]
      └─ 对每 shard 构造 RelocateShard → relocationProducer.send()  [:1235-1288]
3. DDQueue 接收: queueRelocation()  [DDRelocationQueue.actor.cpp:820]  合并重叠（取最大 priority）→ queueMap + queue[src]
4. launchQueuedWork()  [:348]  检查 overlappingInFlight + canLaunchSrc(busyness) → inFlight.insert → dataDistributionRelocator()  [:1505]
5. dataDistributionRelocator
   └─ 循环 getSrcDestTeams(primary + remote)  [:365]:
      teamCollections[i].getTeam(GetTeamRequest) → getBestTeam
      shardsAffectedByTeamFailure->moveShard(keys, destTeams)
      moveKeys()  [MoveKeys.actor.cpp:3325]  三阶段协议:
        Phase 1 startMoveKeys()  [:964]  写 keyServers dest=新team（src保留）+ serverKeys dest=true + commit
        Phase 2 checkFetchingState()  [:1198]  dest SS 收 private mutation → fetchKeys 从 source 读（异步）
        Phase 3 finishMoveKeys()  [:1269]  原子交换 src→dest + 清旧数据 + commit
6. processRelocationComplete
```

shard 过大 split：`shardTracker`（`DDShardTracker.actor.cpp:1309`）→ `shardEvaluator`（`:1243`）检查 `stats.bytes > shardBounds.max.bytes`（`getShardSizeBounds` `DataDistribution.actor.h:531`）→ `shardSplitter`（`:866`）`db->splitStorageMetrics` 取 split 点 → `executeShardSplit`（`:497`）`defineShard` 更新边界 → `output.send(RelocateShard(r, SPLIT_SHARD))`。shard 过小 merge：`shardMerger`（`:1061`）向前/向后遍历相邻 shard 合并。`maxShardSize = min((MIN_SHARD_BYTES + sqrt(dbSize)*RATE)*RATIO, MAX_SHARD_BYTES)` 自适应。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `DataDistributor::init` | `DataDistribution.actor.cpp:595` | 加载配置/lock/初始分布 |
| `teamTracker` | `DDTeamCollection.actor.cpp:996` | 监控 team 健康触发迁移 |
| `storageServerTracker` | `:1357` | 监控单 SS 健康 |
| `buildTeams` | `:841` | 构建 server/machine team |
| `getTeam`/`getBestTeam` | `DDTeamCollection.h:707` | team 选择 |
| `queueRelocation` | `DDRelocationQueue.actor.cpp:820` | 接收并排序迁移请求 |
| `launchQueuedWork` | `DDRelocationQueue.h:348` | 启动迁移 actor |
| `dataDistributionRelocator` | `DDRelocationQueue.actor.cpp:1505` | 执行单次迁移 |
| `getSrcDestTeams` | `DDRelocationQueue.h:365` | 请求 primary+remote team |
| `moveKeys` | `MoveKeys.actor.cpp:3325` | 三阶段数据迁移协议 |
| `takeMoveKeysLock` | `MoveKeys.actor.cpp:286` | 获取单例锁 |
| `shardEvaluator` | `DDShardTracker.actor.cpp:1243` | split/merge 决策 |
| `shardSplitter`/`shardMerger` | `:866`/`:1061` | split/merge 执行 |
| `perpetualStorageWiggler` | `DDTeamCollection.actor.cpp:2435` | 渐进轮换 |
| `necessary` | `DataDistribution.actor.cpp:235` | 判断是否需 wiggle |
</details>

## 核心实现

### Shard/Team 抽象

FDB 把 key space 分为不重叠 shard（KeyRange），每个分配给一个 server team（k 个 SS 副本）。shard ownership 存系统 keyspace `keyServers`（`\xff/keyServers/[start_key]`，格式 `[src][dst]`）和 `serverKeys`（`\xff/serverKeys/`），`ShardsAffectedByTeamFailure` 维护内存反向索引。team 分两层：server team（`TCTeamInfo`，k 个 server）和 machine team（`TCMachineTeamInfo`），每 server team 必属一个 machine team 保证跨机架分布。team 和 shard 解耦：一 team 可拥多 shard，shard 可 split/merge 不影响 team。

### Relocation Queue（异步迁移队列）

所有迁移经 `RelocateShard` 进 DDQueue，按 priority 排序，异步——不阻塞调用方，放 `queueMap` 后立即返回，迁移在后台 `dataDistributionRelocator` actor 执行。`Busyness` 限每 server 并行迁移数防过载。`queueRelocation`（`:820`）合并重叠请求——新请求覆盖已排队的旧请求则取消旧的，priority 取最大值，避免重复迁移。

### Team Selection（负载均衡选择）

`getBestTeam` 遍历 healthy team，按 `GetTeamRequest::lessCompare` 排序：`preferLowerDiskUtil` 选 `getLoadBytes()` 最小；`forReadBalance` 按 `getReadLoad`；`WANT_TRUE_BEST`（ValleyFiller）全遍历选最优；`ANY` 随机起点。`TeamSelect` 枚举 `ANY`/`WANT_COMPLETE_SRCS`/`WANT_TRUE_BEST`。`EligibilityCounter` gate 用 `pivotAvailableSpaceRatio`（集群中位数 free ratio）过滤过满 team 作 dest——在不均匀硬件上自动导向更空 disk。

### MoveKeys 三阶段协议

`moveKeys()`（`MoveKeys.actor.cpp:3325`）异步增量迁移：Phase 1 `startMoveKeys`（`:964`）原子把 dest 加入 `keyServers`（src+dest 并存），commit proxy 同时向 src+dest 路由写；Phase 2 `checkFetchingState`（`:1198`）dest SS 后台 `fetchKeys` 从 src 读数据（不阻塞 DD）；Phase 3 `finishMoveKeys`（`:1269`）数据就绪后原子交换 src→dest 移除旧 src。迁移期间数据仍可读写（src 仍服务），DD 可同时管数百并发迁移（受 `Busyness`/`FlowLock`），DD 崩溃可从 `DataMoveMetaData` 恢复，大 shard 可跨多事务分批。

### StorageWiggler（渐进轮换）

解决长期集群滚动维护（旧引擎、旧配置、打补丁、换磁盘）。按 `StorageMetadataType`（创建时间+storeType）排序 min-heap，自动逐个排除最老 SS：`perpetualStorageWiggleIterator`（`:2380`）选下一个 → `excludeStorageServersForWiggle`（`:460`）标 excluded → teamTracker 发 `RelocateShard(PRIORITY_PERPETUAL_STORAGE_WIGGLE)` → 数据迁走 → `removeServer` → `includeStorageServersForWiggle`（`:464`）重新允许招募。集群不健康时 `pauseWiggle` 自动暂停。

### Private Mutation 传播

Shard map 变更必须对所有 commit proxy 一致。DD 不直接 RPC 通知 SS，而是经 FDB 自身事务传播 private mutation：DD 写 `keyServers`/`serverKeys` 系统 key → commit proxy 分类 private mutation → TLog 按 tag 路由到相关 SS → SS `applyPrivateData` 处理（`nowAssigned=true`→`fetchKeys`，`false`→清数据）。保证 serializability、total order、durability、atomicity。`MoveKeysLock`（`MoveKeys.actor.h:37`）保证唯一 DD 改 shard map。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Shard/Team 抽象 | `DataDistribution.actor.h:481`、`TCInfo.h:185`、`DataDistributionTeam.h:57` | 分片独立分配，server team+machine team 跨故障域 |
| Relocation Queue | `DDRelocationQueue.h:125` | 异步迁移不阻塞，合并防重复 |
| Team Selection | `DDTeamCollection.actor.cpp`、`DataDistributionTeam.h:140` | 多策略+eligibility gate 自适应负载 |
| Wiggler | `DataDistribution.actor.h:799` | 渐进滚动维护无需停机 |
| MoveKeysLock | `MoveKeys.actor.h:37` | 单例锁保证唯一 DD |
| Private Mutation | `MoveKeys.actor.cpp` | 复用事务 ACID 保证 shard map 一致 |

## 模块间交互

依赖 fdbrpc/flow。与 StorageServer（数据落点，经 private mutation 间接控制 + `getStorageMetrics` RPC 获取指标）、ClusterController（`storageRecruiter` 监听 `RecruitStorageRequest` 招募新 SS，经 `dbInfo` 获知拓扑）、fdbclient（系统 keyspace 元数据，`IDDTxnProcessor` `DDTxnProcessor.actor.cpp` 封装事务操作抽象层）。多 DC 维护 primary + remote 两个 `DDTeamCollection`，每 shard 需两 DC 各一 team，`Team.primary` 标志区分。

## 扩展方式

新增 `RelocateReason`/`DataMovementReason`：`DataDistribution.actor.h:54` 枚举加值，`DDRelocationQueue.actor.cpp:76` `buildPriorityMappings` 加 `DataMovementReason→priority` 映射，`ServerKnobs.h` 加 `PRIORITY_*` knob，`RelocateData::isHealthPriority`/`isBoundaryPriority` 加分类。调整 shard split/merge 阈值：改 `ServerKnobs.h` 的 `MAX_SHARD_BYTES`/`MIN_SHARD_BYTES`，`getShardSizeBounds`（`DataDistribution.actor.h:531`）自动用，`shardEvaluator`（`:1243`）决策。新增 team selection 策略：`DataDistributionTeam.h:113` `TeamSelect` 枚举加值，`DDTeamCollection.actor.cpp` `serverGetTeamRequests` 加评分逻辑，`GetTeamRequest` 加过滤条件，`lessCompare` 加排序。调整迁移并发度：改 `DDQueue` 的 `startMoveKeysParallelismLock`/`finishMoveKeysParallelismLock` FlowLock 容量，`Busyness::canLaunch`（`DDRelocationQueue.actor.cpp:401`）阈值，`WORK_FULL_UTILIZATION`（`:43`），`getSrcWorkFactor`（`:445`）。
