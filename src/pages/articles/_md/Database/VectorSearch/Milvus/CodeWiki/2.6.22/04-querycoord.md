---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "QueryCoord 查询编排"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "Go", "分布式调度", "负载均衡"]
description: "Milvus QueryCoordv2 解读——target/dist 双状态的声明式对账、五类 checker、ScoreBasedBalancer 评分公式、resource group 多租户隔离与 v2 重写的 reconcile 思想"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

`internal/querycoordv2/`（99 文件 34K 行）是查询层的大脑：collection 的 load/release、replica 管理、segment/channel 的分布均衡、shard leader 选举。**v2 重写的核心思想**：把"期望状态"（target）与"实际状态"（dist）分离成纯数据，用无状态 checker 周期性做 diff 生成最小修复任务——v1 的过程式编排（handoff 多阶段状态机）变成**声明式收敛**（reconcile loop），任务可重试、可撤销、幂等。本仓库已无 v1 代码；`updateBalanceConfig`（`server.go`）对 <2.3.0 节点强制关 AutoBalance 的兼容逻辑是重写时序的间接证据。

## 模块架构

![协调者工作模式](/vibe-reading/images/articles/milvus-internals/coordinator-checkers.svg)

`Server`（`server.go`）聚合：`meta.Meta`（CollectionManager + ReplicaManager + ResourceManager + DistributionManager + TargetManager，持久化经 etcd catalog）、`broker`（对 DataCoord 的 RPC 封装——`GetRecoveryInfoV2` 是拉 target 的唯一入口）、`session`（etcd watch 的节点存活表）、`dist`（心跳收集）、`job/task` 两级调度、`checkers`、5 个 observer。启动顺序（`startServerLoop`）：distController.SyncAll → cluster → observers → taskScheduler → checkerController → jobScheduler；停止逆序。

## 核心实现

### 状态同步：拉模型的双流汇合

**是拉不是推**。`distHandler.startPullDistLoop()`（`dist/dist_handler.go`）：每 QueryNode 一个 handler goroutine，按 500ms（`distPullInterval`）调 `GetDataDistribution` gRPC 拉取，支持 `IsDelta` 增量模式（节点只报变化量）。两条状态流：

1. **QueryNode → dist（实际负载）**：segment 分布 + channel 分布，**同时注册 shard leader**（resp 的 LeaderViews 转成 `meta.LeaderView` 挂到 DmChannel）；
2. **DataCoord → target（期望目标）**：`TargetManager.UpdateCollectionNextTarget()`（`meta/target_manager.go`）经 broker 拉取 vchannel + sealed segment 列表写 next target——**current/next 双缓冲**（读 current 写 next），由 TargetObserver 周期维护、dist 追上后晋升。

**为什么拉而非推**：QueryCoord 主动控制节奏（`SyncAll` 强制全量、重启不误判）；且 diff 收敛天然幂等、抗事件丢失（节点宕机时事件源可能整个消失）。代价是收敛延迟 = 检查间隔（秒级）。

**Shard leader**：每个 vchannel 被 watch 的 QueryNode 即该 shard 的 delegator。`GetShardLeader`（`meta/channel_dist_manager.go:376`）选 replica 内持有该 channel 的候选——优先 serviceable、再选 version 最大。leader 变化经 `LeaderCacheObserver` 通知 Proxy 失效缓存。

### Checker 体系：五类对账

![协调者工作模式](/vibe-reading/images/articles/milvus-internals/coordinator-checkers.svg)

`NewCheckerController`（`checkers/controller.go:68`）——注意实际是**五类**：

| Checker | 检查什么 | 产出 |
|---------|---------|------|
| ChannelChecker | target vs dist 的 channel diff | channel Grow/Reduce/Move |
| SegmentChecker | target vs dist 的 segment diff（缺/冗余/版本/重复） | segment Grow/Reduce/Move/Update |
| BalanceChecker | 节点负载不均 / stopping 排水 | Move（**总是返回 nil 自行入队**——一次处理多 collection 任务量大） |
| IndexChecker | segment 索引状态 vs ListIndexes | Update/DropIndex |
| LeaderChecker | delegator 路由表 vs 实际 dist | LeaderTask（LOW priority——不抢占数据搬运） |

调度（v2.6.22 改为**每 checker 独立 goroutine**，各有独立热更间隔：segment/channel 3s、balance 300ms、index 10s、leader 1s）；`Check()` 手动触发被节点上下线/load 请求调用——立刻催对账。性能优化：Segment/ChannelChecker 的 `versionCache`（三元组版本没变直接跳过整轮 diff）；加载期 SegmentChecker 用 **RoundRobin** assign（注释："may break short-term balance but prioritizes loading speed"）——先快后均衡。

### 均衡策略：两层抽象 + 评分公式

v2.6.22 把 assign 从 balance 拆出（**均衡器与评分正交扩展**）：`Balance` 接口（`BalanceReplica`，粒度是 replica）+ `AssignPolicy`（把资源分给节点，checker 与 balancer 共用）。五个均衡器按 `queryCoord.balancer` 参数工厂选择（运行时热切换）：

- `RoundRobinBalancer`：按个数均分；
- `RowCountBasedBalancer`：按行数；
- `ScoreBasedBalancer`（`balance/score_based_balancer.go`）：核心评分 `calculateScoreBySegment`（`assign_policy_score.go:282`）——`nodeScore = collection 内行数 + (全局行数 + channel growing 行数 + 在途任务 delta) × GlobalRowCountFactor(0.1)`，即"本 collection 优先公平 + 全局负载折算"；assignedScore 按节点**内存容量加权**；delegator 额外加 0.1×count 开销分；收益评估 `HasEnoughBenefitForNodes`——**搬了没明显改善就不搬（防抖动）**；
- `ChannelLevelScoreBalancer`（**默认**）：channel 独占模式——replica 内每 channel 有专属 RW 节点集合时按 channel 分组均衡（数据局部性，减少跨节点 RPC）；
- `MultiTargetBalancer`：多目标加权。

**StoppingBalancer**（独立）：节点优雅停机 → 标 RO → Phase 1 强制排水（HIGH priority、不做收益评估），Phase 2 才普通均衡（LOW priority + 300ms 节流）。防震荡三处：冗余 segment 跳过、在途任务计入评分、stopping 生成了任务就清空 normal 队列强制下轮重来。

**Resource Group（多租户）**：`meta.ResourceGroup`（requests/limits 节点数 + TransferFrom/To 可借用）+ Replica 创建时绑定 RG——**均衡候选只能是本 replica 的节点** → 物理隔离。

### Replica 模型

`meta.Replica`（copy-on-write 不可变）：**replica 不是 segment 副本而是 collection 的完整服务副本组**——绑定一个 RG，含 rwNodes（载 sealed）/ roNodes（排水）/ rwSQNodes（嵌在 streamingnode 里的 QN，只 watch channel + growing）。channel/segment 在 replica 内**没有静态分配表**——target 给"应有哪些"，**具体放哪由 checker + assign 动态决定**，分布事实记在 dist。

### Job / Task 两级调度

**Job 只做元数据**：`LoadCollectionJob.Execute()`（`job/job_load.go:93`）步骤：建 replica → 写 CollectionLoadInfo → `UpdateNextTarget`（从 DataCoord 拉期望）→ 注册 load task——**到此为止**，真正的 segment 搬运由 checker→task 异步推进。**2.6.22 重大变化——load 也走 WAL 广播**：`LoadCollection`（`services.go:196`）经 `broadcastAlterLoadConfigCollectionV2ForLoadCollection` 广播 AlterLoadConfig 消息（带排它资源锁），Ack 回调再触发 Job——为 active-active 多 QueryCoord 部署提供恰好一次语义。JobScheduler **同一 collection 串行**（per-collection queue），job 带 UndoList 支持回滚；TargetObserver 拉取失败不需回滚（"target observer will pull target periodically"）。TaskScheduler（数据搬运）：`preAdd` 按 (replica, segment/channel) 去重（同 key 高优先级可替换在途任务）→ waitQueue → 每 node 的 dispatch loop → Executor 执行 loadSegment/subscribeChannel 等 action，依据 dist 反馈重试或回滚。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Reconcile 循环 | checker 体系（`checkers/controller.go:68`） | 声明式收敛，幂等抗事件丢失 |
| 策略 + 工厂 | Balance 5 实现（`balance/balancer_factory.go`） | 均衡算法热切换 |
| 双缓冲 | current/next target | 半更新状态不外泄 |
| COW | `meta.Replica` | 读写无锁竞争 |
| 模板方法 | `BalanceChecker.processBalanceQueue`（注释自称） | stopping/normal 两类均衡的公共骨架 |

## 模块间交互

**dist 上游**：QueryNode 心跳（拉）+ DataCoord 的 target（broker 拉）；**执行下游**：task 的 Executor 调 QueryNode 的 LoadSegments/WatchDmChannels；**上游触发**：Proxy 的 load 请求经 RootCoord 的 DDL 广播（v2.6.22 load 也是广播语义，见 [RootCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/02-rootcoord)）；leader 变化通知 Proxy 失效 shard leader 缓存。

## 扩展方式

**新增一种均衡策略**（以按磁盘均衡为例）：`balance/disk_based_balancer.go` 实现 `Balance` 接口（`BalanceReplica` + `GetAssignPolicy` 复用 assign 工厂）→ 常量注册 → `BalancerFactory.GetBalancer()` switch 加分支 → 运行时改 `queryCoord.balancer` 即热切换。要新评分函数则动 `assign/` 包（正交扩展点）。
