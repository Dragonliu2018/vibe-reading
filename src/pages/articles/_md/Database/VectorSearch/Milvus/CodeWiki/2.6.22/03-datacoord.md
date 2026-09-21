---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "DataCoord 存储编排"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "Go", "Compaction", "LSM"]
description: "Milvus DataCoord 解读——segment 状态机与 seal 策略、两代 compaction 触发器、clustering compaction 全流程（analyze kmeans→分桶→重写→原子切换）、v2.6 channel 职责让渡 streaming"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

`internal/datacoord/`（118 文件 58K 行，最大 Go 模块）是数据层的大脑：segment 元数据账本、seal/flush 决策、compaction 与索引构建的调度。**v2.6 的结构性变化**：channel 分配职责整体让渡给 streamingcoord（`grep channelwatch internal/datacoord` 零命中——v2.5 及以前"DataCoord 写 channelwatch 到 etcd、DataNode watch 之"的机制已不存在），DataCoord 从"channel 拥有者"退位为 **"segment/checkpoint 元数据账本 + 任务编排者"**。

## 模块架构

### 元数据总线：先 etcd 后内存

`type meta struct`（`meta.go:88`）：`collections`（**只是内存缓存**——真源在 RootCoord，`reloadCollectionsFromRootcoord` 兜底）、`segments *SegmentsInfo`（二级索引 coll2Segments/channel2Segments + `compactionTo` 血缘反向索引）、`channelCPs`（vchannel→checkpoint，带 ContextCond 供 Truncate 等待）、五个子 meta（index/analyze/partitionStats/compactionTask/statsTask）。

核心写入口 `UpdateSegmentsInfo(ctx, operators ...UpdateOperator)`（`meta.go:1346`）是**命令模式闭包链**：`UpdateStatusOperator`/`AddBinlogsOperator`/`CreateL0Operator` 等全部作用于 clone 出来的 pack，**先 `catalog.AlterSegments` 持久化、成功后才更新内存**——崩溃时内存不会领先 etcd。指标也走两阶段（`segMetricMutation.commit()` 只在 etcd 成功后调用）。`updateSegmentPack.Validate()`（`meta.go:841`）拦截"已 flushed / 旧 time tick"的过期上报，吞为良性 no-op。行数 allocation **不落 etcd**，靠 `LastExpireTime` 保证重启后旧分配作废（`genLastExpireTsForSegments`，`segment_manager.go:282`）。

### Segment 状态机

```
Growing ──(seal 阈值)──▶ Sealed ──(flushPolicy)──▶ Flushing ──(SaveBinlogPaths)──▶ Flushed
   └──(空段直接 Dropped)
```

Compaction 之后的"状态"是**附加维度而非新 SegmentState**：mix/sort 输出段 `Flushed + CreatedByCompaction + CompactionFrom=[输入段]`（输入段 Dropped）；clustering 输出段 `Flushed + Level=L2 + IsInvisible=true`——**不可见是临时代态**，等 stats+index 完成后原子置 Visible 并打 `PartitionStatsVersion=PlanID`（`compaction_task_clustering.go:532`）。Level 独立于 State：L0（只存删除 delta）/ L1（普通）/ L2（聚类产物）。

## 核心实现

### Seal：六种策略的注入式引擎

`SegmentManager`（`segment_manager.go:124`）构造注入 4 个 `SegmentSealPolicy` + 2 个 channel 策略：

| 策略 | 默认阈值 |
|------|---------|
| 容量（`sealL1SegmentByCapacity` :121） | 行数 ≥ maxSize×0.12×(1−jitter 0.1) |
| 生命周期（:131） | 24h |
| binlog 文件数（:148） | 主键字段 32 个文件 |
| 空闲（:171） | 10 分钟无写入且 > 16MB（注释 Q/A 解释防小碎段） |
| channel 总量（:200） | growing 总量 ≥ 4096MB 封最大者 |
| **L0 反压**（:225） | L0 delta ≥ 64MB 或 5M 条：按 startPos 排序封掉时间区间重叠的 growing（源码有 ASCII 时间轴图） |

容量策略带 jitter 是**打散同批段的封段时刻防惊群**（同步 seal→同步 flush→同步 compaction）。`GetFlushableSegments`（:526）的 flushPolicyL1 再过滤：Sealed 且距上次 flush ≥ interval 且 `LastExpireTime <= ts`（保证 checkpoint 完整）。

### Compaction：两代触发器 + 三层调度

**v1 legacy**（`compaction_trigger.go`，注释自认 "todo: migrate to v2"）：信号驱动 + 全局 tick，负责 size-based mix（小段填充）与 single 判断（TTL/`hasTooManyDeletions` 三阈值：delta 文件数/删除比例/字节）。**v2**（`CompactionTriggerManager`，`compaction_trigger_v2.go:107`）注册 5 策略各独立 ticker：l0 / clustering / single / storage_version / forcemerge，外加事件驱动的 sort compaction。

**调度框架 `compactionInspector`**（`compaction_inspector.go`）三层：优先级队列（`LevelPrioritizer`：L0=1 < Mix=10 < Clustering=100——**L0 优先因为它阻塞 seal 与查询**）→ **互斥仲裁** `schedule()`（:207：同 channel 的 L0/mix/cluster 互斥——mix 输入包含 L0 的 delta 合并结果、cluster 输入又被 mix 改写，并发执行会基于过期元数据；排除的任务重新入队）→ 全局 slot 调度器（`pickNode` 从可用 slot 最大堆取**最空闲** DataNode——水位填充而非首次适配）。互斥锁段 `CheckAndSetSegmentsCompacting`（`meta.go:1723`，原子 check-and-set）。超时上限：mix/L0 30min、clustering 60min、sort 20min。

### Clustering Compaction 全流程（v2.6 招牌）

**协调侧状态机**（`compaction_task_clustering.go`）：pipelining →（向量聚类键先 `doAnalyze`）→ analyzing → executing → meta_saved（`completeClusterCompactionMutation` `meta.go:1806`：**先写 compactTo 再写 compactFrom**——注释 "avoid data lost if service crash"）→ statistic（对每 tmp 段触发 sort compaction，`regeneratePartitionStats` 把分区统计按血缘改写——注释自嘲 "temporary solution"）→ indexing → completed（**原子的"结果可见 + 版本推进 + 输入段 Drop"**——两阶段切换保证 QueryNode 平滑切到新视图）。

**执行侧算法**（`datanode/compactor/clustering_compactor.go:254` 五步）：

1. **analyze**：标量键——`scalarAnalyze`（:838）只反序列化 PK+聚类键两列做精确统计；**向量键——kmeans 不在 Go 里**：`analyzecgowrapper.Analyze` 调 knowhere 的 C++ Kmeans（`numClusters = ceil(总字节/(maxSize×ratio))` clamp 到 [min, 10240]；训练集超内存×0.8 则下采样），产物 centroids + 每段 offset_mapping；
2. **分桶**：标量走 `generatedScalarPlan`（:1009）贪心装箱（桶按 key 排序保证桶间有序，供分区裁剪）；向量走 `splitCentroids` 轮转分组；
3. **mapping 重写**（:483）：全量读段、TTL/删除过滤、每行按 key 查 `keyToBufferFunc` 路由到 ClusterBuffer——**向量路径每行的聚类分配在 analyze 已由 kmeans 定死，mapping 阶段零距离计算**；
4. **内存控制**：超 70% 高水位 `flushLargestBuffers`（:736）flush 到 30% 低水位；
5. **产出**：`uploadPartitionStats`（:807）上传 PartitionStatsSnapshot（聚类键 min/max，QueryNode 用它做分区裁剪），planID 作版本。

**触发条件**（`triggerClusteringCompactionPolicy`，:252）：无 stats 时新数据 > 512MB 触发；有 stats 时 <1h 跳过、>24h 强制、其间未参与上次聚类的数据 >512MB 触发；前置检查 `checkAllL2SegmentsContains`（所有 L2 段必须空闲）+ 同 collection 上次聚类 Executing 中则跳过。聚类键选择：显式 IsClusteringKey > partitionKey（需开关）> 单一向量字段（需开关）。

### L0 Compaction：删除的最便宜归宿

`compaction_task_l0.go`：目标段在**派发时动态 `selectFlushedSegment`**（:302）——从 trigger 到执行之间 flush 的新段也应吸收删除。**fast-finish**：无目标段则不派发 DataNode 直接 Drop L0 段——删除数据的所有可能目标都还没落盘，丢弃 delta 安全。**关键规则**：只选 `dmlPos ≤ earliestGrowingStartPos` 的 L0——更晚的 delta 对应的写入可能还在 growing 内存 buffer，提前应用会丢失"写入后删除"语义。L0 compaction **不重写 insert 数据**只合并 delta 到目标段的 BloomFilter/pk 过滤——所有 compaction 里最便宜的。

### Index 与 Stats 调度

**indexInspector** 三个触发源：周期扫描（flushed × IsUnIndexed）+ collection 级通知（索引 DDL）+ flush 事件（`postFlush` 经 `getBuildIndexChSingleton()`）。`CreateJobRequest` 派给 DataNode 的 index worker（**IndexNode 能力已并入 DataNode**，`BindIndexNodeMode` 可绑独立节点）；小段或 no-train 索引直接 Finished 不派发。**analyze_meta 就是聚类采样中心的元数据**——存向量聚类键 kmeans 任务（centroids 路径/版本），产物是 clustering mapping 的分配依据。**stats task（sort compaction）**：按 PK 排序重写单段（`IsSorted=true`），v2.6 默认开启、flush 后必经——与 clustering 的 statistic 阶段衔接。**storage_version 策略**：把旧格式段用 mix 管道重写为 storagev2 列式——存储格式升级复用 compaction 是唯一不阻塞写入的途径（带令牌桶限速）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略族 | 5 个 compaction policy + 6 个 seal policy（显式接口） | 触发条件可插拔 |
| 命令模式 | `UpdateOperator` 闭包链（`meta.go:886`） | 元数据修改可组合、两阶段提交 |
| 观察者扇出 | `SaveBinlogPaths` → flushCh → postFlush → stats/index 单例 channel | 一个事件驱动多任务管线 |
| 两层调度 | Inspector（优先级+互斥）→ GlobalScheduler（slot 水位） | 互斥仲裁与负载分配解耦 |
| 持久化状态机 | 每任务的 `Process()` + loadMeta 恢复 | crash 后从 etcd 续跑 |

## 模块间交互

**上游**：RootCoord 的 DDL 广播（WatchChannels/DropVirtualChannel）；streamingnode 的 `SaveBinlogPaths` 上报（`GetLatestWALLocated` 校验上报者仍持有 channel）。**下游**：任务派给 [DataNode](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/09-datanode) 执行；flush 事件触发 [QueryCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/04-querycoord) 的 target 更新（拉取）。channel 分配在 [StreamingCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/06-streaming)（VChannelFairPolicy：DFS 搜索整体最优搬迁 + 防抖容差）。

## 扩展方式

**新增一种 compaction 策略**（storage_version 是最近范本，全套仅 2 文件）：proto 枚举 → `CompactionTriggerManager` 注册（常量 + 字段 + ticker 分支）→ `compaction_policy_xxx.go`（`Enable()/Trigger()` 产出 View）→ `compaction_task_xxx.go`（`Process()` 状态机 + `BuildCompactionRequest` + `Clean()`）→ inspector 的 switch/互斥集/超时 → `completeXXXCompactionMutation`（血缘与 level 落地规则）。**最小路径**（触发条件变体，如 forcemerge 复用 Mix 类型）：只需注册 + policy + Submit 函数——任务执行与 meta 落地全部复用。
