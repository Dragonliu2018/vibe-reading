---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "集群协调层"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "7.4.6"]
tags: ["FoundationDB", "C++", "ClusterController", "Paxos", "Recovery", "ServerDBInfo"]
description: "集群协调层——ClusterController 经协调器 Paxos 选举 + 9 阶段 Recovery 状态机 + Worker 角色承载 + ServerDBInfo 广播，FDB 容错与一致性的控制平面。"
readingTime: "42 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/7.4.6/00-overview)

---

## 模块定位

控制平面是 FDB 容错的大脑。`fdbserver/ClusterController.actor.cpp` + `ClusterRecovery.actor.cpp` + `CoordinatedState.actor.cpp` + `LeaderElection.actor.cpp` + `worker.actor.cpp` 负责：经协调器 Paxos 选出唯一 ClusterController（CC）；CC 为各事务系统角色招募 worker、监控存活、检测故障；故障时驱动 9 阶段恢复生成新 generation；把集群拓扑 `ServerDBInfo` 广播给所有节点。它不参与事务处理，却是"出故障能否自愈"的单一决策点。

## 模块架构

控制平面围绕 `ServerDBInfo` 这一集群拓扑快照运转：

- **ServerDBInfo**（`fdbserver/include/fdbserver/ServerDBInfo.h`）——集群拓扑完整描述，广播给所有 worker。含 `clusterInterface`（CC 接口）、`client`（`ClientDBInfo`，proxy 列表）、`master`（`MasterInterface`）、`distributor`、`ratekeeper`、`resolvers`、`logSystemConfig`、`recoveryCount`（generation 号）、`recoveryState`、`masterLifetime`、`infoGeneration`。每次字段变化重建 `id`。
- **ClusterControllerData**（`fdbserver/include/fdbserver/ClusterController.actor.h`）——CC 核心状态：`id_worker`（所有注册 worker 映射）、内嵌 `DBInfo`（持 `AsyncVar<ClientDBInfo>`/`AsyncVar<ServerDBInfo>` + `dbInfoCount`）、`updateDBInfo` 触发器、`AsyncVar<bool> recruitDistributor/recruitRatekeeper`、`workerHealth`、`degradationInfo`。
- **ClusterRecoveryData**（`fdbserver/include/fdbserver/ClusterRecovery.actor.h`）——单次恢复实例状态：`ReusableCoordinatedState cstate`、`masterInterface`/`masterLifetime`、`lastEpochEnd`/`recoveryTransactionVersion`、`RecoveryState recoveryState`、`LogSystem`、`txnStateStore`、`commitProxies`。
- **WorkerInterface**（`fdbserver/include/fdbserver/WorkerInterface.actor.h`）——worker 角色承载接口，每 `RequestStream` 对应一种可被 CC 招募的角色（`tLog`/`master`/`commitProxy`/`grvProxy`/`resolver`/`storage`/`dataDistributor`/`ratekeeper`/`logRouter`/`backup` + `updateServerDBInfo` 接收广播 + `debugPing` 验证存活）。
- **Coordinator**——独立进程（`coordinationServer()` 在 `fdbd()` 启动），用 `KeyValueStoreMemory`+`DiskQueue` 存约 1KB 状态，作 Paxos acceptor。

## 调用链路

集群启动 → CC 选举 → 招募 master → 恢复 → 广播：

```text
fdbserver main()  [fdbserver.actor.cpp:2015]  解析 CLI → fdbd() → g_network->run()
fdbd()  [worker.actor.cpp:4264]  每个 fdbserver 进程并发启动:
  ├─ coordinationServer()          若配置 coordFolder，运行协调器进程
  ├─ CC 候选 (worker.actor.cpp:4340-4352):
  │   ├─ NeverAssign → monitorLeader()（仅跟踪不候选）
  │   ├─ WorstFit → monitorLeaderWithDelayedCandidacy()  [:4172]  随机延迟后转 clusterController()
  │   └─ 正常 → clusterController()  参与选举
  └─ workerServer()                 worker 服务器，待 CC 招募角色
  ▼
CC 选举 (Paxos via 协调器)
  tryBecomeLeaderInternal()  [LeaderElection.actor.cpp:107]  CandidacyRequest 到所有协调器 → 获多数派提名
  → clusterControllerCore()  [ClusterController.actor.cpp:3220]
      ├─ clusterWatchDatabase()  [:231]  驱动恢复
      ├─ dbInfoUpdater()  [:2964]  广播 ServerDBInfo
      ├─ monitorProcessClasses/monitorDataDistributor()  [:2325]/monitorRatekeeper/workerHealthMonitor
      └─ handleRegisterWorkerRequests/handleRecruitStorageRequests ...
  ▼
clusterWatchDatabase()  [:231]
  while(true):
    recruitNewMaster()  [ClusterRecovery.actor.cpp:84]  → RecruitMasterRequest → worker 初始化 MasterInterface
    构造新 ServerDBInfo: master = iMaster, masterLifetime = ++previous
    db->serverInfo->set(dbInfo)  触发广播
    recoveryCore = clusterRecoveryCore(db->recoveryData)  [ClusterRecovery.actor.cpp:1503]
      9 阶段状态机（见概览状态流图）
  ▼
dbInfoUpdater()  [:2964]  检测 serverInfo->onChange() → 序列化 → broadcastDBInfoRequest 到所有 worker.updateServerDBInfo
  worker 接收 → dbInfo->set(newInfo) → 各角色 onChange() 响应
```

检测角色失败 → 触发恢复：`clusterWatchDatabase` 内层 `race(recoveryCore, waitFailureClient(master), forceMasterFailure, serverInfo->onChange, collection)`——master 网络失败或 `forceMasterFailure`（gray failure）触发 break 内层循环，回到 `while(true)` 招募新 master 起新 generation。Singleton 角色（DD/RK）失败不触发恢复，而是 `clearInterf` → 重新招募。Worker 失败由 `workerAvailabilityWatch()`（`:914`）监测。TLog 失败用 `rejoinClusterController()`（`TLogServer.actor.cpp:2547`）向新 CC 重注册；Worker 用 `registrationClient()` 持续注册。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `fdbd` | `worker.actor.cpp:4264` | 进程入口，并发启 CC 候选+worker+coordinator |
| `clusterControllerCore` | `ClusterController.actor.cpp:3220` | 启动所有管理 actor |
| `clusterWatchDatabase` | `:231` | 驱动恢复，监测 master 失败 |
| `dbInfoUpdater` | `:2964` | 广播 ServerDBInfo |
| `workerAvailabilityWatch` | `:914` | 监测 worker 存活 |
| `monitorDataDistributor` | `:2325` | singleton DD 招募与监测 |
| `recruitNewMaster` | `ClusterRecovery.actor.cpp:84` | 招募 master |
| `clusterRecoveryCore` | `:1503` | 9 阶段恢复状态机 |
| `tryBecomeLeaderInternal` | `LeaderElection.actor.cpp:107` | Paxos 候选 |
| `rejoinClusterController` | `TLogServer.actor.cpp:2547` | TLog 向新 CC 重注册 |
| `monitorLeaderWithDelayedCandidacy` | `worker.actor.cpp:4172` | WorstFit 延迟候选 |
</details>

## 核心实现

### Paxos 领导选举（经协调器）

CC 选举是经协调器进程实现的单 decree Paxos（`LeaderElection.actor.cpp`）。协调器是独立进程，运行 `leaderRegister`，存约 1KB 状态。候选人生成 `LeaderInfo`，把 processClass fitness（0-7）编码到 `changeID` 的 bit 61-63，使协调器可比较候选优劣；获多数派提名成为 leader；持续发 `LeaderHeartbeatRequest`（频率 `HEARTBEAT_FREQUENCY=0.5s`），多数派回 `false` 则自杀。`Fitness` 枚举最大值 6（`NeverAssign`），注释明确"不能大于 7 因为 leader election mask"。

### Generation 恢复（故障切换安全）

generation 号即 `DBCoreState.recoveryCount`（`fdbserver/include/fdbserver/DBCoreState.h`），是故障切换安全的核心。递增时机在 `clusterRecoveryCore` Phase 2（`LOCKING_CSTATE`），通过 Paxos write 持久化到协调器。`cstate.setExclusive()` 原子锁——只有获 cstate 锁的 CC 能继续，多 CC 竞争只有一个成功（`coordinated_state_conflict`）。旧 generation TLog 在 `epochEnd()`（`LogSystem.cpp`）被锁定阻止新 commit；`oldTLogData` 向量保存历史 generation 配置，`STORAGE_RECOVERED` 时清空。`recoveryCount` 递增还让旧 generation TLog 自行终止释放内存。`masterLifetime`（`LifetimeToken` 含 `ccID`+`count`）让 master 检测自己是否被替换——CC 选出新 master 后旧 master 提交被拒。

### ReusableCoordinatedState — Paxos 包装

`ClusterRecovery.actor.h` 的 `ReusableCoordinatedState` 包装 `MovableCoordinatedState` 实现 Paxos proposer，协调器作 acceptor。读协议两轮：第一轮 `GenerationRegReadRequest(key, empty_gen)` 发现已有最高 generation；算 `conflictGen = max+1`；第二轮获多数派承诺返回当前值。写协议 `GenerationRegWriteRequest(kv, gen)` 到所有协调器——初始状态写等**全部**，后续写等多数派 `n/2+1`；任何返回更高 generation → `coordinated_state_conflict`。`recoveryTerminateOnConflict()` race `cstate.onConflict()`，冲突时 throw `worker_removed` 终止当前恢复。

### Worker 多角色承载

`fdbd()`（`worker.actor.cpp:4264`）并发启动 CC 候选 + `workerServer()` + coordinator——两者并非二选一，同一进程同时跑 CC 候选 actor 和 worker。`WorkerInterface` 包含每种角色的 `RequestStream` endpoint，CC 通过向特定 endpoint 发 `Initialize*Request` 激活角色。`machineClassFitness()`（`fdbserver/ProcessClassRecruitment.cpp` 或 `fdbserver/clusterRecruitment`）把 `(ProcessClass, ClusterRole)` 映射 fitness 值——`ProcessClass` 仅影响 CC 候选的优先级/适配度，不影响是否参与。协作式调度让多角色在同进程经 coroutine 多路复用，无需线程同步。stateless 角色（master/proxy/resolver）崩溃无数据损失，CC 偏好招募 stateless class 的 worker 运行 CC 本身和这些角色。

### ServerDBInfo 传播

任何修改 `ServerDBInfo` 的操作（`clusterRegisterMaster`、`setDistributor` 等）→ `serverInfo->set(newInfo)` + `infoGeneration = ++dbInfoCount`。`dbInfoUpdater()`（`:2964`）检测变化或 `updateDBInfo.onTrigger()` → 序列化 → 收集所有 worker 的 `updateServerDBInfo` endpoint → `broadcastDBInfoRequest`（分批 `DBINFO_SEND_AMOUNT`）。失败 endpoint 放入 `updateDBInfoEndpoints` 下轮重试。Worker 侧 `serveServerDBInfoUpdates()` 接收反序列化 → `dbInfo->set()` → 各角色 `onChange()` 响应。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Paxos 领导选举 | `LeaderElection.actor.cpp` | 协调器轻量（~1KB），保证唯一 CC |
| Generation 恢复 | `ClusterRecovery.actor.cpp:1503` | recoveryCount 递增 + cstate 锁，故障切换安全 |
| 协调状态 | `CoordinatedState.actor.cpp` | Paxos proposer/acceptor，原子锁 |
| 心跳监控 | `ClusterController.actor.cpp:914` | CC↔协调器、CC↔worker、worker↔CC 三层 |
| 角色 fitness 招募 | `ProcessClassRecruitment` | 软亲和，最优优先但可降级 |

## 模块间交互

依赖 fdbrpc/flow、coordinator。与事务系统：CC 招募 master/proxy/resolver，恢复中接收 master 的 `RegisterMasterRequest` 更新 `ServerDBInfo` 的 `logSystemConfig`/`resolvers`/`recoveryState` 并广播。与数据分布：`monitorDataDistributor()`（`:2325`）在 `recoveryState >= ACCEPTING_COMMITS` 后招募 DD，DD 自报告 interface，失败不触发恢复而重招募。Storage Server 失败也不触发恢复——由 DD 招募替代或迁移数据。Gray failure：`workerHealthMonitor` 定期收集 worker 的 `degradedPeers` 报告，`shouldTriggerRecoveryDueToDegradedServers` 时 `forceMasterFailure.trigger()`。

## 扩展方式

新增角色并让 CC 招募：定义 `*Interface`（含 `RequestStream`）；在 `WorkerInterface.actor.h` 加 endpoint + `initEndpoints`/`serialize`；`ClusterRole` 枚举加角色 + `machineClassFitness` 映射；`ClusterControllerData` 加 `AsyncVar<bool> recruit*`，参照 `SingletonRoles.h` 的 `RatekeeperSingleton` 创建 `*Singleton`，在 `clusterControllerCore`（`:3220`）加 `monitor*` actor；worker 侧 `WorkerServerCore` 加 `serve*Recruitment`；`ServerDBInfo.h` 加 `Optional<*Interface>` + `set*()`。修改恢复参数：`ServerKnobs` 的 `CC_RECOVERY_INIT_REQ_*`（超时指数退避）、`CC_THROTTLE_SINGLETON_RERECRUIT_INTERVAL`、`CC_HEALTH_TRIGGER_RECOVERY`（gray failure）、`ENFORCED_MIN_RECOVERY_DURATION`。
