---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "资源管理与服务发现"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "C++", "VirtualWarehouse", "资源调度", "服务发现"]
description: "ByConity Snowflake 风格资源管理：Virtual Warehouse、worker 借用、一致性哈希与 leader 选举。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/00-overview)

---

## 模块定位

存算分离下计算节点可弹性扩缩，但"查询该让哪个 worker 执行""各服务实例如何互相找到"需要专门机制。**ResourceManagement**（`src/ResourceManagement/`，约 7.8k 行）落地 Snowflake 的 Virtual Warehouse（VW）思想——把计算资源按读/写/任务/default 分池，支持 VW 间 worker 借用与资源感知调度。**ServiceDiscovery**（`src/ServiceDiscovery/`，约 2.5k 行）让 server/tso/daemon-manager/resource-manager/worker 互相发现，并用一致性哈希把表元数据分担到 server。二者共同构成 ByConity 的"计算资源调度与服务拓扑"层。

---

## 模块架构

```text
┌─ ResourceManagement ───────────────────────────────────┐
│  ResourceManagerController (中央控制器)                │
│    ├─ VirtualWarehouseManager → VirtualWarehouse      │
│    │    └─ WorkerGroup (Physical / Shared)            │
│    │         └─ WorkerNode (cpu/mem/disk/query 指标)  │
│    ├─ WorkerGroupManager                              │
│    ├─ ResourceScheduler/QueryScheduler (filter+select)│
│    ├─ ResourceTracker / ResourceReporter (心跳)       │
│    └─ ElectionController (FDB CAS 选主)               │
│  ResourceManagerClient (RpcLeaderClientBase, 透明路由)│
├─ ServiceDiscovery ────────────────────────────────────┤
│  IServiceDiscovery → Consul / DNS / Local            │
│  ServiceDiscoveryFactory (单例, 按 config.mode)       │
│  CnchTopologyMaster → consistentHashForString         │
└────────────────────────────────────────────────────────┘
```

---

## 调用链路

### 资源分配（Server 查询取 worker）

```text
Server → ResourceManagerClient::pickWorker(vw_name, algo, requirement)
  └─ callToLeaderWrapper()  RPC 发到 leader RM  [ResourceManagerClient.h]
       └─ ResourceManagerServiceImpl::pickWorker()
            └─ vw_manager.getVirtualWarehouse(vw_name)
                 └─ vw.getQueryScheduler().pickWorker(algo, requirement)
                      ├─ filterWorker(requirement, workers)  // CPU/内存/磁盘/blocklist 过滤
                      └─ selectWorkers(algo, workers)        // LowCpu/LowMem/LowDisk/RoundRobin
                           └─ reserveResourceQuotas()         // 带_ttl 预留配额
  → 返回 HostWithPorts，Server 据此 CnchWorkerClient 下发任务
```

### 服务发现与一致性哈希

```text
Context::initServiceDiscoveryClient() → ServiceDiscoveryFactory::create(config)
各组件 sd->lookup(psm_name, type) 获取实例列表
表元数据分担: CnchTopologyMaster::getTargetServer(table_uuid, vw_name)
  └─ CnchServerTopology::getTargetServer()
       └─ consistentHashForString(uuid, servers_list.size())  // Jump Consistent Hash
```

### Leader 选举

`ElectionController` 构造时建 `StorageElector`，底层用 FDB（Metastore）CAS。`onLeader` 回调 → `pullState`（3 次重试，清空并重新从 KV 加载全量 VW/WorkerGroup 状态）→ 启动 `WorkerGroupResourceCoordinator`；`onFollower` → `shutDown`。Follower 收 RPC 时 response 标 `is_leader=false`，Client 重试到 leader。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `ResourceManagerClient::pickWorker` | 选 worker 执行查询 | 透明路由 leader |
| `QueryScheduler::pickWorker` | 两阶段选 worker | filter + select |
| `WorkerNode::available` | 判断资源是否满足 | CPU/内存/磁盘阈值 |
| `WorkerNode::reserveResourceQuotas` | 预留配额 | 带 TTL DeductionEntry 自动过期 |
| `VirtualWarehouse::lendGroup` | 借出 worker group | SharedWorkerGroup 链接 |
| `ElectionController::onLeader` | 选主后恢复状态 | pullState 全量加载 |
| `CnchTopologyMaster::getTargetServer` | 定位表归属 server | Jump Consistent Hash |
| `ServiceDiscoveryFactory::create` | 建服务发现客户端 | 按 config.mode |

</details>

---

## 核心实现

### 按读/写/任务分 Virtual Warehouse

`VirtualWarehouseType` 枚举 Read/Write/Task/Default，经 `toSystemVWName` 映射到 `vw_read`/`vw_write`/`vw_task`/`vw_default`（`VirtualWarehouseType.h`）。这是 Snowflake VW 思想直接落地——不同负载隔离，各自独立扩缩容。`VirtualWarehouseSettings` 的 `cpu_busy_threshold`/`cpu_idle_threshold`/`max_auto_borrow_links` 允许每个 VW 独立配置弹性策略。Server 启动时 `addVirtualWarehouse` 注册这 4 类（见概览启动流程）。

### PhysicalWorkerGroup vs SharedWorkerGroup

`PhysicalWorkerGroup`（`PhysicalWorkerGroup.h`）持有真实 `workers` 列表与 `psm` 标识（用于服务发现）；`SharedWorkerGroup`（`SharedWorkerGroup.h`）不持有 worker，而是经 `linked_id` 弱引用一个 PhysicalWorkerGroup，其 `randomWorkers`/`getWorkers` 全部委托给 linked group。`is_auto_linked` 区分手动/自动共享。这实现了 VW 间 worker 借用——繁忙 VW 创建 SharedWorkerGroup 链接空闲 VW 的 PhysicalWorkerGroup，无需迁移 worker 进程。

### ResourceScheduler 选 worker

`QueryScheduler`（`QueryScheduler.cpp`）两阶段：`filterWorker` 按 `ResourceRequirement` 检查 CPU 余量（`cpu_usage + reserve_percents > threshold` 排除）、内存可用量、磁盘空间、blocklist；`selectWorkers` 按算法排序——`GlobalLowCpu` 选 `reserved_cpu_cores/cpu_limit + cpu_usage` 最低，`GlobalLowMem` 选可用内存最多。选完 `reserveResourceQuotas` 预留 CPU/内存配额（带 TTL 的 `DeductionEntry` 自动过期回收，避免泄漏）。

### 一致性哈希分担 Server 元数据

`CnchServerTopology::getTargetServer`（`CnchServerTopology.cpp:85`）对 `table_uuid` 做 `consistentHashForString(uuid, servers_list.size())`（Jump Consistent Hash），保证同一表稳定映射到同一 server。server 故障时 `CnchTopologyMaster::fetchTopologies` 检测 term 变化，`PartCacheManager` 使旧缓存失效并重新分配。这是"哪张表归哪个 server 管"的负载分担机制（与 [Catalog](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/01-catalog) 的写权限检查配合）。

### leader 选举与 bthread 锁

`ElectionController`（`ElectionController.cpp`）用 `StorageElector` + FDB CAS。注释明确使用 `bthread::Mutex` 而非 `std::mutex`——因为锁作用域内会调用 Catalog RPC，`std::mutex` 在 brpc 线程模型下会死锁。`ResourceReporterTask`（Worker 端，`ResourceReporter.cpp`）每 1s 经 `reportResourceUsage` 上报 CPU/内存/磁盘/查询数，首次启动 `registerWorker`；RM 端 `ResourceTracker` 更新 `WorkerNode` 原子字段，`clearLostWorkers` 按 `worker_heartbeat_timeout_sec` 清理超时节点。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂 | `ServiceDiscoveryFactory`（ServiceDiscoveryFactory.h） | 三后端按 config 生成 |
| 策略 | `IServiceDiscovery` 三实现 / `IWorkerGroup` 两实现 / 9 种调度算法 | 后端/分组/调度可换 |
| 代理 | `ResourceManagerClient`(RpcLeaderClientBase) | 透明 leader 路由+重试 |
| 观察者 | `ResourceTracker`/`ResourceReporter` | 心跳上报与超时清理 |

---

## 模块间交互

依赖 Catalog（VW/WorkerGroup 元数据存 FDB，`ElectionController::pullState` 加载）、ServiceDiscovery。被 Server/CloudServices 调用（取 worker、发现服务）。`CnchWorkerClientPools` 用 `ServiceDiscoveryClientPtr` 发现 worker 实例；`CnchTopologyMaster` 用一致性哈希分配表元数据。

---

## 扩展方式

**新增 VW 类型**：`VirtualWarehouseType.h` 的 `Type` 枚举加值，更新 `toString`/`toSystemVWName`；`ResourceManagerController::createVWsFromConfig` 解析逻辑自动支持。

**新增服务发现后端**：实现 `IServiceDiscovery`（`lookup`/`lookupWorkerGroupsInVW`），写 `registerServiceDiscoveryXxx` 在 `registerServiceDiscovery.cpp` 调用，`ServiceDiscoveryFactory` 自动支持新 `service_discovery.mode`。

**调整 worker 选择算法**：`VWScheduleAlgo.h` 加枚举；`QueryScheduler::selectWorkers` 的 switch 加 comparator（类似 `cmp_worker_cpu`/`cmp_worker_mem`）；`WorkerNode` 可扩展 metrics 字段。
