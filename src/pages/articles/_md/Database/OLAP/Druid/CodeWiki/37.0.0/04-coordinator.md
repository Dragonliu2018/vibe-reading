---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "Coordinator 数据协调"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "Coordinator", "数据均衡", "Rules", "HA"]
description: "Druid Coordinator——DruidCoordinator duty 责任链、声明式 Rules 数据生命周期、CostBalancerStrategy 24h 半衰期均衡、HttpLoadQueuePeon 下发、HA leader。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（`server/.../coordinator/`）是 Druid 的"**数据管家**"：管理 segment 可用性——决定哪些 segment 加载到哪些 Historical、按 Rules 加载/丢弃/广播、副本复制、segment 均衡、自动 compaction 调度。它不碰查询路径（查询走 Broker/Historical），也不调度摄入（那是 Overlord）。职责边界：**让"正确的 segment 副本数"出现在"正确的 Historical 上"**，并随数据生命周期演进。

## 模块架构

```
DruidCoordinator（@ManageLifecycle，leader 驱动）
  ├── DruidLeaderSelector（ZK LeaderLatch + localTerm 脑裂防护）
  ├── MetadataManager（segments/rules/configs/indexer 元数据）
  ├── ServerInventoryView（发现 Historical 在线状态与已加载 segment）
  ├── LoadQueueTaskMaster → HttpLoadQueuePeon（per-server HTTP 下发队列）
  ├── SegmentLoadQueueManager / StrategicSegmentAssigner（load/drop 决策）
  ├── BalancerStrategyFactory（Cost/Random/Caching/DiskNormalized）
  └── DutiesRunnable × N → CoordinatorDutyGroup（责任链）
        PrepareBalancerAndLoadQueues → RunRules → UpdateReplicationStatus
        → CollectSegmentStats → UnloadUnusedSegments → MarkOvershadowed/MarkEternity
        → BalanceSegments → CloneHistoricals → CollectLoadQueueStats
```

核心是 `DruidCoordinator` + duty 责任链：leader 经 `DruidLeaderSelector` 选举后，按 `scheduleAtFixedRate` 跑 `CoordinatorDutyGroup`，各 duty 以 `DruidCoordinatorRuntimeParams` 串联传递；`StrategicSegmentAssigner` 是命令接收者，`HttpLoadQueuePeon` 是实际执行者（HTTP POST 给 Historical）。

## 调用链路

```
CliCoordinator → DruidCoordinator.start() → coordLeaderSelector.registerListener
  → becomeLeader() → makeHistoricalManagementDuties() + scheduleAtFixedRate(DutiesRunnable)
  → DutiesRunnable.run()  [DruidCoordinator.java:723]
    → CoordinatorDutyGroup.run(params)  [duty/CoordinatorDutyGroup.java:102]
      for (duty : duties): params = duty.run(params);  # pipeline
      ── RunRules.run  [duty/RunRules.java:71]
           for segment in usedSegments:
             rules = ruleHandler.getRulesWithDefault(dataSource)
             rule.appliesTo(segment, now) → rule.run(segment, segmentAssigner)
      ── LoadRule.run  [rules/LoadRule.java]
           handler.replicateSegment(segment, tieredReplicants)
      ── StrategicSegmentAssigner.replicateSegment  [loading/StrategicSegmentAssigner.java:202]
           updateReplicasInTier → loadReplicas()
             → BalancerStrategy.findServersToLoadSegment   # 选 server
             → SegmentLoadQueueManager.loadSegment(segment, server, action)
      ── HttpLoadQueuePeon.loadSegment  [loading/HttpLoadQueuePeon.java:474]
           queuedSegments.add(holder) → doSegmentManagement()
             → POST druid-internal/v1/segments/changeRequests（到 Historical）
```

`DropRule.run`→`handler.deleteSegment`→`StrategicSegmentAssigner.deleteSegment`→`RunRules.processSegmentDeletes`→`markSegmentsAsUnused`（经 OverlordClient HTTP）→后续 `UnloadUnusedSegments` 卸载。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `DruidCoordinator.becomeLeader` | leader 接管，起 duty 调度 | 只 leader 跑，防并发均衡 |
| `CoordinatorDutyGroup.run` | duty 责任链 | params 串联，null 中断 |
| `RunRules.run` | 按 rules 下发 load/drop | 第一个 appliesTo 的 rule 生效 |
| `LoadRule.run` | 下发复制 | tieredReplicants 定副本数 |
| `CostBalancerStrategy.computePlacementCost` | 候选 server cost | 24h 半衰期，分散热点 |
| `HttpLoadQueuePeon.loadSegment` | 入队 HTTP 下发 | priority + interval 排序 |
| `DruidLeaderSelector.localTerm` | term 号 | 脑裂防护 |

</details>

## 核心实现

### DruidCoordinator 与 duty 责任链

`server/.../coordinator/DruidCoordinator.java` 是主类，`@ManageLifecycle`。`start()` 注册 leader listener，`becomeLeader()`（行 505）构建 duty 组并 `ScheduledExecutors.scheduleAtFixedRate` 调度 `DutiesRunnable`。`DutiesRunnable.run`（行 723）构建 `DruidCoordinatorRuntimeParams`（dataSourcesSnapshot、dynamicConfigs、compactionConfig）交给 `CoordinatorDutyGroup`。`CoordinatorDutyGroup.run`（`duty/CoordinatorDutyGroup.java:102`）是**责任链**：`for (duty : duties) params = duty.run(params)`，返回 null 中断链。duty 顺序至关重要——`PrepareBalancerAndLoadQueues` 必须先建 cluster/strategy，`RunRules` 必须在 `UpdateReplicationStatus` 前（先定 required replicas 才能算 under-replicated）。`RuntimeParams` 用 Builder + `buildFromExisting` 让 duty 改部分字段而不重建。还有 `CoordinatorCustomDuty` 机制（`duty/CoordinatorCustomDuty.java`）经 `druid.coordinator.dutyGroups` 配置加载自定义 duty，无需改核心。

### Rules：声明式数据生命周期

`rules/Rule.java` 用 `@JsonSubTypes` 注册 10 种规则（PeriodLoadRule/IntervalLoadRule/ForeverLoadRule 及对应 DropRule + 3 个 BroadcastDistributionRule）。每个 datasource 有序 rule 列表，`RunRules`（`duty/RunRules.java:71`）按序匹配第一个 `appliesTo` 为 true 的 rule。`LoadRule.run`→`handler.replicateSegment(segment, tieredReplicants)`，`DropRule.run`→`handler.deleteSegment`。`SegmentActionHandler` 接口（`replicateSegment`/`deleteSegment`/`broadcastSegment`）唯一实现 `StrategicSegmentAssigner`。这是**规则引擎**模式——让用户经 JSON/API 声明式配置数据生命周期（如"7 天内 3 副本、90 天前丢弃"），无需改代码。

### CostBalancerStrategy：24h 半衰期均衡

`balancer/CostBalancerStrategy.java`（行 74-216）的 cost 模型：两 segment 联合 cost = `intervalCost(intervalA, intervalB) * multiplier`，`multiplier=2.0`（同 datasource）或 `1.0`；`intervalCost` 基于指数衰减 `e^{-λ|x-y|}`，半衰期 24 小时（`HALF_LIFE=24.0`），计算窗口前后 45 天。`computePlacementCost`（行 280）计算把某 segment 放某 server 的总 cost = 该 server 所有已有 segment 与此 segment 的联合 cost 之和，cost 越低越好。why：Druid 查询常按时间范围扫描，时间相近的 segment 若集中在一 Historical 会成热点，cost 模型量化"亲和度"（时间近+同源=高 cost=应分散），使均衡最小化查询热点。`ReservoirSegmentSampler` 随机采样避免 O(N²) cost 计算，`SegmentToMoveCalculator` 按集群规模动态算每次最大移动量。

### 均衡为何定时 duty 而非事件驱动

`becomeLeader` 用 `scheduleAtFixedRate`，`BalanceSegments` 作为 duty 链一环。why：均衡需全局视角（事件驱动单次触发难获全局）；定时+`maxSegmentsToMove` 限制避免抖动；批量评估+采样降复杂度；只 leader 跑防并发冲突。`TierSegmentBalancer` 检查 `movingSegmentCount` 跳过 loaded segment 移动（`balancer/TierSegmentBalancer.java:120`）。

### LoadQueuePeon 与 StrategicSegmentAssigner

`loading/LoadQueuePeon.java` 接口（`loadSegment`/`dropSegment`/`getSegmentsToLoad`）唯一实现 `HttpLoadQueuePeon`（`HttpLoadQueuePeon.java:474`）——`loadSegment` 入 `SegmentHolder` 优先级队列，`doSegmentManagement`（行 193）按 priority+interval 排序取 batch，序列化为 `List<DataSegmentChangeRequest>` POST 到 Historical 的 `druid-internal/v1/segments/changeRequests`。`StrategicSegmentAssigner`（行 202）是 `SegmentActionHandler` 接收者：`replicateSegment` 为每 tier 设 `requiredReplicas`，`updateReplicasInTier`（行 256）比较 projected vs required 决定 load/drop，`loadReplicas`（行 502）经 `BalancerStrategy.findServersToLoadSegment` 选 server。`SegmentAction` 枚举（LOAD/REPLICATE/DROP/MOVE_TO/MOVE_FROM）把操作命令化。`ReplicationThrottler` 限制副本复制速率。

### HA leader 与 localTerm

`DruidLeaderSelector`（注入 `@Coordinator`）基于 Curator/ZK 的 `LeaderLatch`。`becomeLeader`/`stopBeingLeader` 回调控制 duty 启停。`startingLeaderCounter`（`DutiesRunnable` 行 699）是 term 号，duty 执行时间歇检查 `leaderSelector.localTerm()` 是否变化，防旧 leader 在新 leader 接管后续跑（脑裂防护）。多副本由 `LoadRule.tieredReplicants` 定义，`StrategicSegmentAssigner` 据此设 `requiredReplicas`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 责任链 | `CoordinatorDutyGroup.run` | duty 按序串联，params 传递累积 |
| 策略 | `BalancerStrategy`、`Rule` 类型 | 均衡算法/生命周期可换 |
| 命令 | `SegmentAction` + `DataSegmentChangeRequest` | load/drop/move 封装为操作 |
| 规则引擎 | `Rule.appliesTo`/`run` | 声明式生命周期 |
| 单例/leader | `DruidLeaderSelector` | HA，防多 Coordinator 并发 |
| Builder | `DruidCoordinatorRuntimeParams` | duty 局部修改 |

## 模块间交互

依赖 `metadata`（`MetadataManager` 读 segment/rules/configs/indexer 表）、`discovery`/`initialization`（`ServerInventoryView` 发现 Historical）、`timeline`（`DataSourcesSnapshot`/`SegmentTimeline` 判 overshadowed，`RunRules` 跳过被覆盖 segment 由 `MarkOvershadowedSegmentsAsUnused` 标 unused）、`overlord`（`CompactSegments` duty 经 `OverlordClient` 提交 compaction task）。被 `CliCoordinator`（services）装配启动。

## 扩展方式

- **新增 Rule**：实现 `Rule`（或继承 `LoadRule`/`DropRule`），在 `Rule.java` 的 `@JsonSubTypes` 加注册，如需新操作扩展 `SegmentActionHandler` 与 `StrategicSegmentAssigner`；关键函数 `Rule.appliesTo`/`run`。
- **改均衡算法**：实现 `BalancerStrategy` + `BalancerStrategyFactory`，经 `druid.coordinator.balancer` 配置选择；关键函数 `findServersToLoadSegment`/`findDestinationServerToMoveSegment`，仅改 cost 可覆写 `computePlacementCost`。
- **新增 Coordinator Duty**：实现 `CoordinatorDuty`，插入 `DruidCoordinator.makeHistoricalManagementDuties`（行 556）合适位置；或用 `CoordinatorCustomDuty` + `druid.coordinator.dutyGroups` 免改核心。
