---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "集群协调层"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "main-2026-08"]
tags: ["FoundationDB", "C++", "ClusterController", "Paxos", "Recovery", "ServerDBInfo"]
description: "集群协调层——ClusterController 经协调器 Paxos 选举 + 9 阶段 Recovery 状态机 + Worker 角色承载 + ServerDBInfo 广播，FDB 容错与一致性的控制平面。"
readingTime: "42 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

控制平面是 FDB 容错的大脑。`clustercontroller/` + `core/` + `worker/`（合计 ~44k 行）负责：经协调器 Paxos 选出唯一 ClusterController（CC）；CC 为各事务系统角色招募 worker、监控存活、检测故障；故障时驱动 9 阶段恢复生成新 generation；把集群拓扑 `ServerDBInfo` 广播给所有节点。它不参与事务处理，却是"出故障能否自愈"的单一决策点。

## 模块架构

控制平面围绕 `ServerDBInfo` 这一集群拓扑快照运转：

- **ServerDBInfo**（`core/include/fdbserver/core/ServerDBInfo.h:34`）——集群拓扑完整描述，广播给所有 worker。含 `clusterInterface`（CC 接口）、`client`（`ClientDBInfo`，proxy 列表）、`master`（`MasterInterface`）、`distributor`、`ratekeeper`、`resolvers`、`logSystemConfig`、`recoveryCount`（generation 号）、`recoveryState`、`masterLifetime`、`infoGeneration`。每次字段变化重建 `id`。
- **ClusterControllerData**（`clustercontroller/ClusterController.h:142`）——CC 核心状态：`id_worker`（所有注册 worker 映射）、内嵌 `DBInfo`（持 `AsyncVar<ClientDBInfo>`/`AsyncVar<ServerDBInfo>` + `dbInfoCount`）、`updateDBInfo` 触发器、`AsyncVar<bool> recruitDistributor/recruitRatekeeper`、`workerHealth`、`degradationInfo`。
- **ClusterRecoveryData**（`ClusterRecovery.h:165`）——单次恢复实例状态：`ReusableCoordinatedState cstate`、`masterInterface`/`masterLifetime`、`lastEpochEnd`/`recoveryTransactionVersion`、`RecoveryState recoveryState`、`LogSystem`、`txnStateStore`、`commitProxies`。
- **WorkerInterface**（`core/include/fdbserver/core/WorkerInterface.h:42`）——worker 的角色承载接口，每个 `RequestStream` 对应一种可被 CC 招募的角色（`tLog`/`master`/`commitProxy`/`grvProxy`/`resolver`/`storage`/`dataDistributor`/`ratekeeper`/`logRouter`/`backup` + `updateServerDBInfo` 接收广播 + `debugPing` 验证存活）。
- **Coordinator**——独立进程（`coordinationServer()` 在 `fdbd()` 启动），用 `KeyValueStoreMemory`+`DiskQueue` 存约 1KB 状态，作为 Paxos acceptor。

## 调用链路

集群启动 → CC 选举 → 招募 master → 恢复 → 广播：

```text
fdbd() [worker.cpp:4060] 同时启动: coordinationServer() + clusterController()/monitorLeader() + workerServer()
  ▼
CC 选举 (Paxos via 协调器)  [ClusterController.cpp:3585]
  tryBecomeLeader() → CandidacyRequest 发送到所有协调器 → 获多数派提名
  → clusterControllerCore()  [:3438]
      ├─ clusterWatchDatabase(&self, &self.db, coordinators)  驱动恢复
      ├─ dbInfoUpdater()  广播 ServerDBInfo
      ├─ monitorProcessClasses/monitorDataDistributor/monitorRatekeeper/workerHealthMonitor
      └─ handleRegisterWorkerRequests/handleRecruitStorageRequests ...
  ▼
clusterWatchDatabase()  [:730]
  while(true):
    recruitNewMaster()  [ClusterRecovery.cpp:78]
      → getWorkerForRole(Master) → RecruitMasterRequest → worker 初始化 MasterInterface
    构造新 ServerDBInfo: master = iMaster, masterLifetime = ++previous
    db->serverInfo->set(dbInfo)  触发广播
    recoveryCore = clusterRecoveryCore(db->recoveryData)  [:1702]
      9 阶段状态机（见概览状态流图）
  ▼
dbInfoUpdater()  [:3113]
  检测 serverInfo->onChange() → 序列化 → broadcastDBInfoRequest 到所有 worker.updateServerDBInfo
  worker 接收 → dbInfo->set(newInfo) → 各角色 onChange() 响应
```

检测角色失败 → 触发恢复：`clusterWatchDatabase` 内层 `race(recoveryCore, waitFailureClient(master), forceMasterFailure, serverInfo->onChange, collection)`——master 网络失败或 `forceMasterFailure`（gray failure）触发 break 内层循环，回到 `while(true)` 开头招募新 master 起新 generation。Singleton 角色（DD/RK）失败不触发恢复，而是 `clearInterf` → 重新招募。Worker 失败由 `workerAvailabilityWatch()`（`:1313`）监测，`removeFailedWorker` 清理。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `clusterController` | `ClusterController.cpp:3585` | CC 主入口，选举重试循环 |
| `clusterControllerCore` | `:3438` | 启动所有管理 actor |
| `clusterWatchDatabase` | `:730` | 驱动恢复，监测 master 失败 |
| `dbInfoUpdater` | `:3113` | 广播 ServerDBInfo |
| `workerAvailabilityWatch` | `:1313` | 监测 worker 存活 |
| `monitorDataDistributor` | `:2902` | singleton DD 招募与监测 |
| `recruitNewMaster` | `ClusterRecovery.cpp:78` | 招募 master |
| `clusterRecoveryCore` | `:1702` | 9 阶段恢复状态机 |
| `tryBecomeLeader` | `LeaderElection.cpp` | Paxos 候选 |
| `ReusableCoordinatedState::read/write` | `ClusterRecovery.h:67` | Paxos prepare/accept |
</details>

## 核心实现

### Paxos 领导选举（经协调器）

CC 选举是经协调器进程实现的单 decree Paxos（`LeaderElection.cpp`）。协调器是独立进程，运行 `leaderRegister`，存约 1KB 状态。候选人生成 `LeaderInfo`，把 processClass fitness（0-7）编码到 `changeID` 的 bit 61-63，使协调器可比较候选优劣；获多数派提名成为 leader；持续发 `LeaderHeartbeatRequest`（频率 `HEARTBEAT_FREQUENCY=0.5s`），多数派回 `false` 则自杀。`Fitness` 枚举最大值 6（`NeverAssign`），注释明确"不能大于 7 因为 leader election mask"。

### Generation 恢复（故障切换安全）

generation 号即 `DBCoreState.recoveryCount`（`DBCoreState.h:135`），是故障切换安全的核心。递增时机在 `clusterRecoveryCore` Phase 2（`LOCKING_CSTATE`，`ClusterRecovery.cpp:1774` `recoveryCount++`），通过 Paxos write 持久化到协调器。`cstate.setExclusive()` 原子锁——只有获 cstate 锁的 CC 能继续，多 CC 竞争只有一个成功（`coordinated_state_conflict`）。旧 generation TLog 在 `epochEnd()`（`LogSystem.cpp:1761`）被锁定阻止新 commit；`oldTLogData` 向量保存历史 generation 配置，`STORAGE_RECOVERED` 时清空。`recoveryCount` 递增还让旧 generation TLog 自行终止释放内存。`masterLifetime`（`LifetimeToken` 含 `ccID`+`count`）让 master 检测自己是否被替换——CC 选出新 master 后旧 master 提交被拒。

### ReusableCoordinatedState — Paxos 包装

`ClusterRecovery.h:67` 的 `ReusableCoordinatedState` 包装 `MovableCoordinatedState` 实现 Paxos proposer，协调器作 acceptor。读协议两轮：第一轮 `GenerationRegReadRequest(key, empty_gen)` 发现已有最高 generation；算 `conflictGen = max+1`；第二轮获多数派承诺返回当前值。写协议 `GenerationRegWriteRequest(kv, gen)` 到所有协调器——初始状态写等**全部**，后续写等多数派 `n/2+1`；任何返回更高 generation → `coordinated_state_conflict`。`recoveryTerminateOnConflict()`（`:61`）race `cstate.onConflict()`，冲突时 throw `worker_removed` 终止当前恢复。

### Worker 多角色承载

`fdbd()`（`worker.cpp:4060`）同时启动 CC + worker + coordinator。`WorkerInterface` 包含每种角色的 `RequestStream` endpoint，CC 通过向特定 endpoint 发 `Initialize*Request` 激活角色。`machineClassFitness()`（`ProcessClassRecruitment.cpp:25`）把 `(ProcessClass, ClusterRole)` 映射 fitness 值，最优匹配优先但不强制——资源不足时 CC 可招募任何可用 worker。协作式调度让多角色在同进程经 coroutine 多路复用，无需线程同步。stateless 角色（master/proxy/resolver）崩溃无数据损失，CC 偏好招募 stateless class 的 worker 运行 CC 本身和这些角色。

### ServerDBInfo 传播

任何修改 `ServerDBInfo` 的操作（`clusterRegisterMaster`、`setDistributor` 等）→ `serverInfo->set(newInfo)` + `infoGeneration = ++dbInfoCount`。`dbInfoUpdater()`（`:3113`）检测变化或 `updateDBInfo.onTrigger()` → `delay(DBINFO_BATCH_DELAY)` 批量 → 序列化 → 收集所有 worker 的 `updateServerDBInfo` endpoint → `broadcastDBInfoRequest`（分批 `DBINFO_SEND_AMOUNT`）。失败 endpoint 放入 `updateDBInfoEndpoints` 下轮重试。Worker 侧 `serveServerDBInfoUpdates()`（`worker.cpp:2031`）接收反序列化 → `dbInfo->set()` → 各角色 `onChange()` 响应。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Paxos 领导选举 | `LeaderElection.cpp` | 协调器轻量（~1KB），保证唯一 CC，远比每次决策跑共识高效 |
| Generation 恢复 | `ClusterRecovery.cpp:1702` | recoveryCount 递增 + cstate 锁，故障切换安全 |
| 协调状态（分布式配置） | `CoordinatedState.cpp` | Paxos proposer/acceptor，原子锁保证一个 CC 推进 |
| 心跳监控 | `ClusterController.cpp:1313` | CC↔协调器、CC↔worker、worker↔CC 三层 |
| 角色 fitness 招募 | `ProcessClassRecruitment.cpp:25` | 软亲和，最优优先但可降级 |

## 模块间交互

依赖 fdbrpc/flow、coordinator。与事务系统：CC 招募 master/proxy/resolver，恢复中接收 master 的 `RegisterMasterRequest` 更新 `ServerDBInfo` 的 `logSystemConfig`/`resolvers`/`recoveryState` 并广播。与数据分布：`monitorDataDistributor()` 在 `recoveryState >= ACCEPTING_COMMITS` 后招募 DD，DD 自报告 interface，失败不触发恢复而重招募。Storage Server 失败也不触发恢复——由 DD 招募替代或迁移数据。Gray failure：`workerHealthMonitor`（`:3179`）定期收集 worker 的 `degradedPeers` 报告，`shouldTriggerRecoveryDueToDegradedServers` 时 `forceMasterFailure.trigger()`。

## 扩展方式

新增角色并让 CC 招募：定义 `*Interface.h`（含 `RequestStream`）；在 `WorkerInterface.h` 加 endpoint + `initEndpoints`/`serialize`；`ClusterRole` 枚举加角色 + `machineClassFitness` 映射；`ClusterControllerData` 加 `AsyncVar<bool> recruit*`，参照 `SingletonRoles.h` 的 `RatekeeperSingleton` 创建 `*Singleton`，在 `clusterControllerCore` 加 `monitor*` actor；worker 侧 `WorkerServerCore` 加 `serve*Recruitment`；`ServerDBInfo.h` 加 `Optional<*Interface>` + `set*()`。修改恢复参数：`ServerKnobs.cpp` 的 `CC_RECOVERY_INIT_REQ_*`（超时指数退避）、`CC_THROTTLE_SINGLETON_RERECRUIT_INTERVAL`、`CC_HEALTH_TRIGGER_RECOVERY`（gray failure）、`ENFORCED_MIN_RECOVERY_DURATION`。
