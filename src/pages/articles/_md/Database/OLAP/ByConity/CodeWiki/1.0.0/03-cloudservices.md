---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "云服务协调"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "C++", "brpc", "后台线程", "去重"]
description: "ByConity 云服务协调层：后台线程框架、server↔worker RPC、去重与 manifest checkpoint。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/00-overview)

---

## 模块定位

存算分离下，server 无状态、worker 无状态，二者需要一套协调机制来完成后台任务调度、远程过程调用与写入去重。**CloudServices**（`src/CloudServices/`，约 18k 行）就是这层协调层。它包含三块：(1) 后台线程框架 `ICnchBGThread` 及具体实现（merge/mutate/GC/dedup/materialized view refresh/recluster/manifest checkpoint）；(2) RPC 客户端 `CnchServerClient`/`CnchWorkerClient` 与服务端 `CnchServerServiceImpl`/`CnchWorkerServiceImpl`；(3) 写入去重 `DedupScheduler`/`DedupWorkerManager` 与 manifest 缓存。这是 server 与 worker 协作的核心枢纽。

---

## 模块架构

```text
┌─ 后台线程框架 ─────────────────────────────────────────┐
│  ICnchBGThread (模板方法基类: run→runImpl)              │
│    ├─ CnchMergeMutateThread   (选 part 下发 merge)      │
│    ├─ CnchPartGCThread        (part 回收)              │
│    ├─ ReclusteringManagerThread (cluster key 重排)     │
│    ├─ CnchRefreshMaterializedViewThread                 │
│    ├─ CnchManifestCheckpointThread (版本链→检查点)     │
│    └─ DedupWorkerManager      (去重 worker 编排)        │
│  CnchBGThreadsMap / CnchBGThreadsMapArray (注册表)     │
├─ RPC 层 ───────────────────────────────────────────────┤
│  CnchServerClient (worker→server 回访)                 │
│  CnchWorkerClient (server→worker 下发)                 │
│  RpcClientBase / RpcLeaderClientBase (leader 路由)    │
│  CnchServerServiceImpl / CnchWorkerServiceImpl (brpc)  │
├─ 写入与去重 ───────────────────────────────────────────┤
│  CnchDataWriter / CnchDataAdapter (写 part)           │
│  DedupScheduler / DedupGran / DedupDataChecker        │
│  ManifestCache / ManifestBroadcaster                  │
└────────────────────────────────────────────────────────┘
```

三块通过 `CnchBGThreadsMap` 串联：DaemonManager 控制 BG 线程生命周期，BG 线程用 RPC 客户端下发任务，任务结果经 RPC 回写并触发去重/checkpoint。

---

## 调用链路

### 后台 merge

```text
CnchMergeMutateThread::runImpl()                  [CnchMergeMutateThread.cpp:401]
  ├─ runHeartbeatTask() → worker->touchManipulationTasks() 检查 task 存活
  ├─ tryMutateParts() → 从 Catalog 取 mutation entries
  └─ tryMergeParts()
       └─ trySelectPartsToMerge() 6 步:
            1. 快照 currently_merging_mutating_parts（防并发）
            2. partition_selector->selectForMerge() → catalog->getServerDataPartsInPartitions()
            3. CnchPartsHelper::calcVisibleParts() 算可见 part
            4. getMergePred() 构造合并谓词（校验 commit_time 一致性）
            5. selectPartsToMerge()（SimpleMergeSelector/DanceMergeSelector）
            6. 推入 merge_pending_queue
       └─ submitFutureManipulationTask()
            ├─ prepareTransaction() 建低优 merge 事务
            ├─ getWorker() 从 VirtualWarehouse 选 worker
            ├─ 填 ManipulationTaskParams（create_query + source_parts + txn_id）
            └─ worker_client->submitManipulationTask()  [brpc 下发]
```

worker 端接收（`CnchWorkerServiceImpl.cpp:240`）：`submitManipulationTask` → 建 `CnchWorkerTransaction`（关联 `CnchServerClient`）→ `createStorageFromQuery` 在 worker 建本地 `StorageCloudMergeTree` → `data->manipulate(params)` → 完成后 `CnchServerClient::commitParts()` 回写。

### 写入去重

`CnchDataWriter::dumpAndCommitCnchParts`（`CnchDataWriter.cpp:141`）：`dumpCnchParts` 把 part 写共享存储 + 写 undo buffer；`commitDumpedParts` 在 server 端经 `TransactionCoordinator` 提交，worker 端经 `CnchServerClient::commitParts` RPC 回写。去重由 `DedupWorkerManager`（每 3s `iterate`）按 `DedupGran`（partition_id + bucket_number）hash 路由到 dedup worker，比对 staged part 与 visible part 生成 delete bitmap。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `ICnchBGThread::run` | 后台线程骨架 | 模板方法：更新 metric→runImpl→通知 wakeup |
| `CnchBGThreadsMap::createThread` | 按 type 工厂建 BG 线程 | 枚举分发 |
| `CnchMergeMutateThread::trySelectPartsToMerge` | 6 步选可合并 part | 校验 commit_time 一致 |
| `CnchWorkerClient::submitManipulationTask` | 下发 merge/mutate task | brpc |
| `CnchServerClient::fetchDataParts` | worker 回访取 part 元数据 | server 做缓存+可见性过滤 |
| `CnchServerClient::commitParts` | worker 回写提交结果 | RPC |
| `CnchDataWriter::dumpAndCommitCnchParts` | 写 part + 提交 | undo buffer |
| `DedupScheduler::assignHighPriorityDedupPartition` | 去重分区路由 | DedupGran hash |

</details>

---

## 核心实现

### Server 选 part、Worker 执行

存算分离下 server 持有 Catalog 元数据（part 列表、可见性、mutation 状态），能做全局决策；worker 持计算资源但不持元数据。因此 `CnchMergeMutateThread`（`CnchMergeMutateThread.cpp:625`）在 server 上选 part、构造任务参数，再下发 worker 执行 IO 密集的合并。这避免了 worker 间的分布式协调开销——决策集中、执行分散。

### 去重幂等性

去重通过 `DedupScope` 定义锁粒度（TABLE/PARTITION + BUCKET 级），`CnchDedupHelper::getStagedPartsToDedup` 取 staged part 与 visible part 比对，过滤重复行生成 delete bitmap。`DedupGran`（partition_id + bucket_number）的 hash 决定由哪个 dedup worker 处理，保证同一 gran 始终路由到同一 worker（`DedupGran.h`）。事务 commit_ts 保证去重的时间一致性。`duplicate_auto_repair` 开启时 `DedupDataChecker` 后台检测需修复的 gran 并分配。

### Manifest checkpoint

`CnchManifestCheckpointThread`（`CnchManifestCheckpointThread.cpp:42`）：`TableVersion` 记录每次 part 变更（insert/merge/mutate）形成版本链，`checkPointImpl` 把累积的多个 TableVersion 合并为一个 checkpoint 版本，计算可见 part 集合后 dump 到远程存储。这减少 FDB 中的版本元数据量——查询只需读最新 checkpoint + 增量版本，而非全量历史。`ManifestCache`/`ManifestBroadcaster` 缓存并广播 manifest，减少 worker 回访。

### Worker 回访 Server 取元数据

worker 不直接读 FDB，而是经 `CnchServerClient::fetchDataParts` RPC 向 server 请求（`CnchServerServiceImpl.cpp`）。原因：server 做 `PartCacheManager` 缓存与事务可见性过滤（`calculateMinActiveTimestamp` 遍历所有 server 取最小活跃 ts），避免 worker 直连 FDB 造成缓存分散与可见性错误。

### BG 线程注册表与 leader 路由

`CnchBGThreadsMap`（`CnchBGThreadsMap.cpp:57`）管理一种类型的所有表线程（UUID → thread），`CnchBGThreadsMapArray` 持有所有类型 map；`cleanThread` 每 30s 清理 error 线程（`failed_storage >= 3`）。RPC 层 `RpcLeaderClientBase`（`RpcLeaderClientBase.cpp:27`）维护 `leader_host_port`，leader 变更时 `updateChannel` 重建 brpc channel。consistent hashing 路由在 `CnchTopologyMaster`（MergeTreeCommon）实现。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `ICnchBGThread::run`（ICnchBGThread.cpp:104） | BG 线程骨架统一 |
| 工厂方法 | `CnchBGThreadsMap::createThread`（CnchBGThreadsMap.cpp:57） | 按 type 建 BG 线程 |
| 对象池 | `CnchServerClientPool`/`CnchWorkerClientPools` | RPC client 复用 |
| leader 路由 | `RpcLeaderClientBase`（RpcLeaderClientBase.cpp:27） | 自动跟随 leader |
| 广播 | `ManifestBroadcaster` | manifest 分发 |

---

## 模块间交互

依赖 Catalog（取 part/mutation 元数据）、WorkerTasks（下发 `ManipulationTaskParams`）、Transaction（merge 建低优事务、commit_ts 可见性）、Disks（`CnchDataWriter` 写共享存储）、Storages（`StorageCnchMergeTree` server 侧 / `StorageCloudMergeTree` worker 侧）。被 Server（HTTP 请求触发查询）与 DaemonManager（控制 BG 线程生命周期）调用。

---

## 扩展方式

**新增后台线程类型**：`CnchBGThreadCommon.h` 的 `Type` enum 加值并更新 `ServerMaxType`；继承 `ICnchBGThread` 实现 `runImpl`；`CnchBGThreadsMap::createThread` 加 `else if` 分支；若需 DaemonManager 调度，在 proto 注册。

**新增 worker RPC 方法**：proto（`cnch_worker_rpc.proto`）加 RPC 定义；`CnchWorkerClient` 加方法（构造 Request→`stub->method`）；`CnchWorkerServiceImpl` 实现服务端。

> 后台任务的三层编排（DaemonManager→CloudServices BG 线程→WorkerTasks）全景见概览的 [后台任务管线图](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/00-overview#状态流) 与 [后台任务编排与执行](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/07-daemonmanager-workertasks)。
