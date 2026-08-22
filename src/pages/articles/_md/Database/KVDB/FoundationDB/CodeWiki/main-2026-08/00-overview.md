---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "Overview"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "main-2026-08"]
tags: ["FoundationDB", "C++", "KVDB", "分布式事务", "确定性模拟"]
description: "FoundationDB main-2026-08——Apple 开源分布式事务型 KV 数据库，有序 KV + ACID 严格可串行化 + 角色化分布式架构 + 确定性模拟测试源码解读。"
readingTime: "90 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** main-2026-08 · **解读基线** commit [`a6233ad8a9`](https://github.com/apple/foundationdb/commit/a6233ad8a9ebfd99d37ce9e20db97dbcf726ab1b)（2026-08-19，main 分支开发快照，最新可达 tag 为 7.1.0 但已落后 11000+ 提交，故以 main HEAD 为解读基线）· **协议** Apache-2.0 · **语言** C++20 · **代码量** ~450,000 行（核心 cpp/h/actor）

---

## 总览

### 项目简介

**FoundationDB（FDB）** 是 Apple 开源的分布式数据库，设计用于在普通服务器集群上处理海量结构化数据。它把数据组织为**有序 key-value 存储**（ordered KV store），所有操作都以 **ACID 事务**执行，尤其擅长高并发读写负载。用户通过多语言 API 绑定（C / Python / Go / Java / Ruby）与数据库交互。

FDB 的核心价值在于把三件难事揉到了一起：**分布式**（跨集群横向扩展）、**事务**（严格可串行化、无锁 OCC）、**容错**（节点故障自动恢复、不丢已提交数据）。它的杀手锏是**确定性模拟（deterministic simulation）**——在一个进程内用确定性随机数模拟整个集群，跑数千个并发测试 workload，让分布式并发 bug 可 100% 复现。这也是 FDB 能支撑 Apple iCloud 等大规模生产系统的可靠性根基。

**项目边界**：FDB 负责分布式 KV 存储与事务，**不负责** SQL、复杂查询、文档/图模型——这些留给上层 layer（如 Snowflake 的元数据层、Skylab 记录层）在 KV 之上构建。FDB 也不直接做副本同步的多数派读写给用户，而是通过 TLog 解耦读写路径。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 有序 KV 读写 | `fdbserver/storageserver/storageserver.cpp` | StorageServer 提供 get/getRange/set/clear |
| ACID 事务 | `fdbserver/commitproxy/CommitProxyServer.cpp`、`fdbserver/resolver/ConflictSet.cpp` | 批量提交 + OCC 冲突检测 |
| 严格可串行化 | `fdbserver/sequencer/masterserver.cpp` | Master 单点分配单调递增 commit version |
| 持久化日志 | `fdbserver/tlog/TLogServer.cpp` | TLog 顺序写磁盘队列，mutation 先持久化再落盘 |
| 自动分片与迁移 | `fdbserver/datadistributor/DataDistribution.cpp` | DataDistributor 按 key range 分 shard 到 team |
| 故障恢复 | `fdbserver/clustercontroller/ClusterRecovery.cpp` | 9 阶段恢复状态机，generation 切换 |
| 多区域容灾 | `fdbserver/logrouter/LogRouter.cpp` | LogRouter 跨 region 转发 mutation |
| 确定性模拟测试 | `fdbserver/SimulatedCluster.cpp`、`fdbrpc/sim2.cpp` | 单进程模拟整个集群，bug 可复现 |
| 客户端缓存 | `fdbclient/ReadYourWrites.cpp` | RYW 读你的写，减少网络往返 |
| 管理 keyspace | `fdbclient/SpecialKeySpace.cpp` | `\xff\xff` key 暴露集群管理接口 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++20 | 核心 | 协程（`co_await`）、concept、模板 |
| Boost.Asio | 核心 | Net2 事件循环（epoll/kqueue） |
| Boost.Multiprecision | 可选 | 精确数值 |
| OpenSSL / BoringSSL | 核心 | TLS 连接加密 |
| RocksDB | 可选 | 备选存储引擎 |
| FlatBuffers | 核心 | 跨版本兼容的 RPC 序列化 |
| CMake + Ninja | 构建 | 跨平台构建 |
| Swift | 可选 | 部分 flow 互操作（`swift_concurrency_hooks`） |

### 版本历史

FDB 起源于 2009 年左右，2013 年开源，2015 年被 Apple 收购后持续投入。主要里程碑：

- **6.x**：确立 actor 异步模型 + 确定性模拟测试体系；Master 驱动恢复。
- **7.0**：引入 Redwood（自研 VersionedBTree）存储引擎；DataDistributor / Ratekeeper 从 Master 进程拆出为独立 singleton 角色。
- **7.1**：当前生产稳定线（7.1.57 为最新 bugfix）。SharedTLog 多 generation 架构成熟，spill-by-reference 大幅降低写放大。
- **7.3 / 7.4**：开发中（本解读基线 main HEAD），引入 C++20 协程替换旧 actor 编译器、Version Vector unicast、Physical Shard 等实验特性。

本解读基于 main 分支 2026-08-19 快照，涵盖 C++20 协程化后的最新架构。

### 顶层上下文图

```text
┌───────────────┐   fdb.cluster    ┌─────────────────────────────┐
│  应用进程      │ ───────────────▶ │  FDB 集群                    │
│ (C/Py/Go/...)  │   API 绑定       │  ┌────────┐  ┌───────────┐  │
│                │ ◀──数据读写──── │  │ Client │─▶│ CommitProxy│  │
└───────────────┘                  │  │  lib  │  │ GRVProxy  │  │
                                   │  └────────┘  │ Resolver  │  │
                                   │              │ Sequencer  │  │
                                   │              └─────┬─────┘  │
                                   │           push/peek│        │
                                   │              ┌─────▼─────┐  │
                                   │              │  TLog     │  │
                                   │              └─────┬─────┘  │
                                   │              ┌─────▼─────┐  │
                                   │              │StorageSvr │  │
                                   │              └───────────┘  │
                                   │  ClusterController + 协调器 │
                                   │  统筹选举/恢复/招募          │
                                   └─────────────────────────────┘
```

## 快速上手

FDB 依赖繁多，官方推荐用 Docker 镜像构建。最简流程：

```bash title="build-from-docker.sh"
# 用官方构建镜像
docker run -v "$PWD:/tmp/fdb" -w /tmp/fdb -it foundationdb/build bash -c \
  "mkdir -p build && cd build && \
   CC=clang CXX=clang++ LD=lld cmake -DUSE_LD=LLD -DUSE_LIBCXX=1 -G Ninja .. && ninja"
```

启动一个本地模拟集群并验证：

```bash title="local-cluster.sh"
# 启动单进程模拟集群（fdbserver 内置 simulation 模式可无需多机）
./build/bin/fdbserver -C test.cluster -p 127.0.0.1:4500 --locality machineid=m1
# 用 fdbcli 连接并写入一个 key
./build/bin/fdbcli -C test.cluster --exec "w testkey hello; get testkey"
# 预期输出：=> `testkey' is `hello'
```

> 严格正确性验证靠模拟测试，而非手搭集群：`fdbserver -r simulation tests/fast/NoSimTip.rtttrim` 跑一个测试用例，成功输出 `OK`。

## 架构设计解析

### 系统架构

FDB 的架构思想是**读写路径解耦 + 角色化进程 + 单线程协作式异步**。传统数据库把存储与事务耦合在一个进程，FDB 把它们拆成可独立横向扩展的角色：提交走 CommitProxy、冲突检测走 Resolver、持久化走 TLog、读写服务走 StorageServer，每个角色都能独立扩容。所有角色跑在 fdbserver 进程里，由 ClusterController（经协调器 Paxos 选出）统一招募与监控。

![分层架构](/vibe-reading/images/articles/foundationdb-internals/architecture.svg)

整体分六层（自上而下，上层依赖下层）：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 客户端层 | `fdbclient/`、`bindings/` | 暴露事务 API 给应用，封装重试、RYW 缓存、定位缓存 |
| 控制平面 | `fdbserver/clustercontroller/`、`fdbserver/core/`、`fdbserver/worker/` | 选出单一领导者、招募各角色、驱动恢复、广播拓扑；是容错的大脑 |
| 事务系统 | `fdbserver/commitproxy/`、`fdbserver/grvproxy/`、`fdbserver/resolver/`、`fdbserver/sequencer/` | 提交事务、授予读版本、检测冲突、分配 commit version；是 ACID 的引擎 |
| 事务日志 | `fdbserver/tlog/`、`fdbserver/logsystem/`、`fdbserver/logrouter/` | 持久化 mutation、管理日志拓扑与 generation 切换、跨 region 转发 |
| 存储层 | `fdbserver/storageserver/`、`fdbserver/kvstore/` | 从 TLog pull mutation 落盘、提供 MVCC 读写服务 |
| 基础设施 | `flow/`、`fdbrpc/` | 异步运行时（Future/Promise/协程/事件循环/内存）与 RPC/网络，全栈基石 |

模拟测试（`fdbserver/workloads/`、`fdbserver/SimulatedCluster.cpp`）横切所有层——它复用 flow/fdbrpc 的模拟原语，跑的是同一份 fdbd 业务代码，只是底层 I/O 换成模拟实现。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Promise/Future 单赋值变量 | `SAV<T>` in `flow/include/flow/flow.h:729` | 协作式异步的通用粘合剂，支持多订阅与回调链 |
| C++20 协程状态机 | `CoroPromise` in `flow/include/flow/Coroutines.h:325` | 替代旧 actor 编译器，语言级协程，消除预处理工具维护负担 |
| 乐观并发控制（OCC） | `ConflictSet.cpp:948` `detectConflicts` | 无锁冲突检测，适合短事务高吞吐，冲突直接重试 |
| 批量提交 | `commitBatcher()` in `CommitProxyServer.cpp:234` | 一批事务共用一次 master/resolver/TLog RPC，摊薄开销 |
| WAL 读写分离 | `tLogCommit()` in `TLogServer.cpp:2832` | commit 延迟只取决于顺序写 TLog，落盘异步进行 |
| Generation 恢复 | `ClusterRecovery.cpp:1702` `clusterRecoveryCore` | 故障切换靠递增 generation 号 + Paxos 互斥保证安全 |
| Test Double 模拟 | `Sim2` in `fdbrpc/sim2.cpp:1021` | 单进程模拟整个集群，确定性可复现并发 bug |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Version` | 64 位单调递增 commit 版本号 | 由 Sequencer 分配，贯穿事务全流程 | MVCC、日志、恢复都以 version 为坐标 |
| `ServerDBInfo` | 集群拓扑快照（各角色 interface） | 每次 recovery/角色变更时重建，广播给所有 worker | 含 `ClientDBInfo`、`MasterInterface`、`LogSystemConfig` |
| `generation`（recoveryCount） | 事务系统的代际号 | 每次 recovery 递增，持久化在协调器 cstate | TLog 按 generation 切换，旧 generation 数据供恢复 |
| `Tag` | mutation 路由标签（locality + id） | 由 CommitProxy 按 shard 边界分配 | TLog 按 tag 分区维护队列，StorageServer 按 tag peek |
| `shard` / `team` | key range 分片 / SS 副本集合 | 由 DataDistributor 动态 split/merge/relocate | team 满足复制策略，shard 是迁移粒度 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `IKeyValueStore` | `fdbserver/kvstore/include/fdbserver/kvstore/IKeyValueStore.h:47` | `KeyValueStoreRedwood`、`KeyValueStoreMemory`、`KeyValueStoreRocksDB` | `openKVStore()` 工厂按 `KeyValueStoreType` 选择 |
| `IPager2` | `fdbserver/kvstore/IPager.h:625` | `DWALPager` | Redwood 的页面管理层 |
| `TestWorkload` | `fdbserver/tester/include/fdbserver/tester/workloads.h:66` | 数十个具体 workload（`CycleWorkload`、`MachineAttrition`…） | `WorkloadFactory<T>` 全局对象自动注册 |
| `ISimulationPolicy` | `fdbserver/core/FDBSimulationPolicy.cpp:58` | `FDBSimulationPolicy` | `installFDBSimulationPolicy()` 安装 |
| `LogSystem` | `fdbserver/logsystem/include/fdbserver/logsystem/LogSystem.h:262` | tag-partitioned 实现（唯一） | `newEpoch()` 创建 |

```text
                  IKeyValueStore
                 /      |       \
    Redwood   Memory   RocksDB    （StorageServer 层做 MVCC，引擎只存单版本）
        |
    VersionedBTree → IPager2 → DWALPager → 磁盘
```

## 代码目录

```text
foundationdb/
├── flow/                  # 异步运行时（~70k 行）：Future/Promise/协程/Net2/FastAlloc/Arena
├── fdbrpc/                # RPC 与网络（~34k 行）：FlowTransport/LoadBalance/Sim2
├── fdbclient/             # 客户端库（~102k 行）：NativeAPI/RYW/定位缓存/SpecialKeySpace
├── fdbserver/             # 服务端（~224k 行），按角色分目录：
│   ├── clustercontroller/ # ClusterController + ClusterRecovery（控制平面）
│   ├── core/              # ServerDBInfo/CoordinatedState/LeaderElection/MoveKeys/ServerKnobs
│   ├── worker/            # Worker 进程（承载角色）
│   ├── commitproxy/       # CommitProxy（提交）
│   ├── grvproxy/          # GRVProxy（读版本）
│   ├── resolver/          # Resolver + ConflictSet（冲突检测）
│   ├── sequencer/         # Master/Sequencer（版本分配）
│   ├── tlog/               # TLog（持久日志）
│   ├── logsystem/         # LogSystem（日志拓扑）
│   ├── logrouter/         # LogRouter（跨 region）
│   ├── storageserver/     # StorageServer（读写服务 + MVCC）
│   ├── kvstore/            # 存储引擎：Redwood(VersionedBTree)/Memory/RocksDB
│   ├── datadistributor/   # DataDistributor（分片/迁移/负载）
│   ├── workloads/         # 模拟测试 workload（~54k 行）
│   └── SimulatedCluster.cpp # 模拟集群搭建
├── fdbcli/                # 命令行客户端
├── fdbmonitor/            # 进程监控
├── fdbbackup/             # 备份恢复
├── fdbctl/                # 控制面工具
├── bindings/              # 多语言绑定（C/Python/Go/Java/Ruby）
├── design/                # 设计文档（recovery/commit/coroutines/tlog-spilling…）
└── documentation/         # 官方文档（sphinx）
```

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/foundationdb-internals/module-dependencies.svg)

依赖方向自上而下：客户端与运维工具驱动服务端；服务端各角色横向协作（控制平面招募事务系统、事务系统 push 给 TLog、TLog 被 StorageServer peek）；所有上层都建立在 flow + fdbrpc 基础设施之上。模拟测试横切全栈。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 异步运行时 | Future/Promise/协程/事件循环 | `flow/Net2.cpp` `Net2::run` | 是全栈唯一的并发原语，所有角色共享一套调度 | [异步运行时](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/01-flow) |
| RPC 与网络 | 传输/负载均衡/模拟网络 | `fdbrpc/FlowTransport.cpp` | 把网络通信与故障检测从业务逻辑剥离 | [RPC 与网络层](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/02-fdbrpc) |
| 客户端库 | 事务 API/RYW/定位缓存 | `fdbclient/NativeAPI.actor.cpp` | 用户编程接口，与集群拓扑解耦 | [客户端库与事务 API](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/03-fdbclient) |
| 集群协调 | 选举/恢复/招募/广播 | `fdbserver/clustercontroller/ClusterController.cpp` | 是容错的大脑，故障切换的单一决策点 | [集群协调层](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/04-cluster-coordination) |
| 事务系统 | 提交/读版本/冲突检测 | `fdbserver/commitproxy/CommitProxyServer.cpp` | ACID 引擎，可独立横向扩展 | [事务系统](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/05-transaction-system) |
| 事务日志 | 持久 mutation/日志拓扑 | `fdbserver/tlog/TLogServer.cpp` | 读写分离的关键，commit 延迟只取决于它 | [事务日志](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/06-transaction-log) |
| 存储引擎 | MVCC/读写服务/落盘 | `fdbserver/storageserver/storageserver.cpp` | 数据最终落盘与读取服务的地方 | [存储引擎](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/07-storage-engine) |
| 数据分布 | 分片/迁移/负载均衡 | `fdbserver/datadistributor/DataDistribution.cpp` | 弹性伸缩与容错的数据平面 | [数据分布](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/08-data-distribution) |
| 模拟测试 | 确定性模拟/workload | `fdbserver/SimulatedCluster.cpp` | FDB 可靠性的根本保障，横切全栈 | [模拟测试体系](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/09-simulation-testing) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

## 运行时行为

### 启动流程

```text
fdbserver main()                                   [fdbserver.cpp:1865]
  └─ fdbd()                                        [worker.cpp:4060]
      ├─ coordinationServer()          # 若配置 coordFolder，运行协调器进程
      ├─ clusterController() 或 monitorLeader()   # 基于 processClass 决定是否竞选 CC
      └─ workerServer()               # worker 服务器，待 CC 招募角色
           ├─ FlowTransport::bind()              # 绑定监听地址
           ├─ registrationClient()               # 周期性向 CC 注册 (worker.cpp:580)
           ├─ serveServerDBInfoUpdates()         # 接收 ServerDBInfo 广播 (worker.cpp:2031)
           └─ 等待 Initialize*Request 激活具体角色

CC 选举（Paxos via 协调器）                          [ClusterController.cpp:3585]
  └─ tryBecomeLeader() → 获多数派提名 → clusterControllerCore()  [ClusterController.cpp:3438]
      ├─ clusterWatchDatabase()      # 驱动恢复
      ├─ dbInfoUpdater()             # 广播 ServerDBInfo
      ├─ monitorProcessClasses/monitorDataDistributor/monitorRatekeeper
      └─ handleRegisterWorkerRequests / handleRecruitStorageRequests ...
```

配置来自命令行参数与 `fdb.cluster` 连接字符串；对象装配是**角色按需招募**——worker 进程先空载启动并注册到 CC，CC 在恢复过程中通过 `Initialize*Request` 逐个激活 master/proxy/resolver/tlog/storage 角色。没有 DI 容器，靠 CC 的招募请求把角色实例化到 worker 上。`ServerDBInfo` 是全局共享状态，通过 `AsyncVar<ServerDBInfo>` 广播，各角色 `onChange()` 响应拓扑变化。

### 核心运行流程

FDB 的运行时核心是**事务提交链路**与**故障恢复链路**。前者回答"数据怎么写进去"，后者回答"出故障怎么办"。

#### 提交链路：事务提交主链路

业务流程：客户端提交事务 → CommitProxy 批量收集 → 向 Sequencer 请求 commit version → Resolver 检测冲突 → push 到 TLog 持久化 → 回复客户端 → StorageServer 异步消费落盘。

![事务提交数据流](/vibe-reading/images/articles/foundationdb-internals/data-flow.svg)

数据从客户端的 `CommitTransactionRequest`（含 mutations + read/write conflict ranges）出发，经 CommitProxy 的 `commitBatcher()` 批量收集后进入 `commitBatch()`：`preresolutionProcessing` 向 Sequencer 的 `getVersion()`（`masterserver.cpp:74`）请求并拿到 `commitVersion + prevVersion`；`getResolution` 把事务拆分发给 Resolver 的 `resolveBatch()`（`Resolver.cpp:263`），后者用 `ConflictSet::detectConflicts()`（`ConflictSet.cpp:948`，SkipList + MiniConflictSet bitmap）做 OCC 检测；`postResolution` 给每条 mutation 按 shard 边界分配 storage server tag，再 `logSystem->push()` 推给 TLog。TLog 的 `tLogCommit()`（`TLogServer.cpp:2832`）把 mutation 写入 per-tag 内存队列与磁盘队列，`commitQueue` actor 调 `persistentQueue->commit()` 做 fsync，持久化后回复 proxy。proxy 再 `reply` 给客户端，并 `reportLiveCommittedVersion` 给 Sequencer。StorageServer 在后台通过 `peekSingle()`（`storageserver.cpp:12210`）按自己负责的 tag 从 TLog pull mutation，应用到内存 MVCC（`VersionedMap`）后发送 `TLogPopRequest` 回收。整条链路的设计精髓是**读写分离**——commit 延迟只取决于 TLog 顺序写，落盘异步进行；以及**批量提交**——一批事务共用三次 RPC。

#### 读链路：读取与读版本授予

读路径相对简单：客户端先经 GRVProxy 拿读版本，再直接定位到 StorageServer 读。`getConsistentReadVersion()` → GRVProxy 的 `queueGetReadVersionRequests()`（`GrvProxyServer.cpp:537`）按优先级入队，`transactionStarter()` 调 `getLiveCommittedVersion()`（`GrvProxyServer.cpp:694`）向 Sequencer 拿当前最大已提交版本，并用 `confirmEpochLive` 确认 epoch 存活，最后分发 version 给所有请求。客户端拿到读版本后，`getKeyLocation()`（`NativeAPI.actor.cpp:1348`）查定位缓存找到 key 所在的 StorageServer，`loadBalance()` 直接向其发 `getValue` 请求；StorageServer 的 `getValueQ()`（`storageserver.cpp:2134`）先 `waitForVersion` 等版本就绪，再从内存 `versionedData.at(v)` 或引擎读取，验证 `storage[k] + versionedData.at(v)[k] = database[k] @ v` 的 MVCC 不变式。

#### 恢复链路：故障恢复状态机

当 ClusterController 检测到 master/proxy/resolver/tlog 等事务系统角色失败，或出现"better master"信号时，触发恢复，生成新 generation。恢复是严格的 9 阶段状态机：

![Recovery 状态机](/vibe-reading/images/articles/foundationdb-internals/state-flow.svg)

`ClusterRecovery` actor（`ClusterRecovery.cpp:1702` `clusterRecoveryCore`）驱动状态机：从协调器读 cstate（`READING_CSTATE`）→ Paxos 写锁定 cstate 并锁旧 TLog（`LOCKING_CSTATE`，`epochEnd` in `LogSystem.cpp:1761`）→ 招募新 TLog/proxy/resolver 并从旧 TLog 复制 `[knownCommittedVersion+1, recoveryVersion]` 区间数据（`RECRUITING`，`recruitEverything`）→ 提交恢复事务通知 SS 回滚预取的未提交版本（`RECOVERY_TRANSACTION`）→ 把新 TLog 写回协调器 cstate（`WRITING_CSTATE`，`trackTlogRecovery`）→ 开始接受提交（`ACCEPTING_COMMITS`）→ 待所有 TLog 招募（`ALL_LOGS_RECRUITED`）→ 旧 generation TLog 清理完（`STORAGE_RECOVERED`）→ `FULLY_RECOVERED`。关键安全保证是写反仲裁 + 读仲裁不变式 `W + (N-R) < F`（`getDurableVersion()` in `LogSystem.cpp:1412`），以及 `recoveryCount` 递增让旧 generation TLog 自行终止。

### 状态流

恢复状态机的全貌见上图 9 阶段。状态枚举定义在 `fdbserver/core/include/fdbserver/core/RecoveryState.h:31`（`READING_CSTATE=1` … `FULLY_RECOVERED=9`）。转换由 `clusterRecoveryCore` 顺序推进，任意阶段检测到冲突（`coordinated_state_conflict`）或角色失败都会回退到 `READING_CSTATE` 开始新 generation（图中粉色虚线回环）。`RecoveryStatus`（`RecoveryState.h`）是 trace 事件用的诊断状态，运维通过 `MasterRecoveryState` trace 定位卡在哪一阶段。

## 典型修改场景

#### 场景 1：新增一种存储引擎实现

需实现 `IKeyValueStore` 接口（`IKeyValueStore.h:47`）的 `set/clear/commit/readValue/readRange/getStorageBytes`，在 `openKVStore()` 工厂加分支。新引擎**无需实现 MVCC**——StorageServer 的 `versionedData` 负责多版本，引擎只存单版本快照，但必须满足因果一致性契约（commit 后的 read 能看到、commit 前看不到）。对应测试：`fdbserver/kvstore/` 下现有引擎的 unit test + 模拟测试 `tests/fast/StoreRecovery`.

#### 场景 2：新增一种角色并让 ClusterController 招募

在 `WorkerInterface.h` 加 `RequestStream<Initialize*Request>` endpoint；在 `ClusterRole` 枚举（`ProcessClassRecruitment.h`）加角色并映射 fitness；在 `ClusterControllerData` 加 `AsyncVar<bool> recruit*` 与 `monitor*` actor；在 `ServerDBInfo.h` 加 interface 字段与 `set*()` 方法（参照 `setRatekeeper()`）。对应测试：模拟测试中用 `ChangeConfig` workload 拉起角色。

#### 场景 3：修改冲突检测粒度

改 `ConflictSet.cpp:799` `ConflictBatch::addTransaction()`（当前把 read/write conflict range 的 begin/end 作为 `KeyInfo` points）与 `CommitProxyServer.cpp:154` `addReadConflictRanges()` 的粒度。粗粒度增加假冲突，细粒度增加 SkipList 节点数。对应测试：`ConflictSet.cpp` 的 `TEST_CASE` + `tests/fast/ConflictRange`.

## 测试体系

FDB 的测试哲学以**确定性模拟**为核心，辅以单元测试：

```text
tests/                         # 集成/模拟测试用例（.txt/.toml/.ini）
fdbserver/workloads/          # 模拟 workload（~54k 行）
fdbserver/FDBServerUnitTestMain.cpp  # 单元测试入口
flow/CoroTests.cpp             # flow 层单元测试
fdbrpc/tests/                  # RPC 层测试
```

| 代码层 | 测试类型 |
| --- | --- |
| flow（Future/协程/FastAlloc） | `flow/CoroTests.cpp` 单元测试 + 模拟回归 |
| fdbrpc（FlowTransport/LoadBalance） | `fdbrpc/tests/` + `sim2` 模拟网络 |
| fdbserver 各角色 | 确定性模拟（`fdbserver -r simulation`） |
| 跨角色集成 | 模拟测试用例（`tests/fast/`、`tests/slow/`、`tests/restart/`） |

要理解某个角色，优先看 `fdbserver/workloads/` 下对应的 workload——它们本质是"可执行文档"。例如理解恢复就看 `workloads/TriggerRecovery.cpp`，理解一致性就看 `workloads/ConsistencyCheck.cpp`。每个 PR 都跑模拟回归（`tests/fast/`），改代码时参照对应测试类型优先阅读。

## 阅读源码推荐路线

- **第一遍：理解异步模型与提交主链路**
  `flow/include/flow/flow.h` 的 `SAV<T>/Future<T>/Promise<T>` → `flow/Net2.cpp` 的 `Net2::run()` 事件循环 → `fdbclient/NativeAPI.actor.cpp` 的 `Transaction::commit()` → `fdbserver/commitproxy/CommitProxyServer.cpp` 的 `commitBatcher()/commitBatch()` → `fdbserver/sequencer/masterserver.cpp` 的 `getVersion()`
- **第二遍：理解冲突检测与日志持久化**
  `fdbserver/resolver/ConflictSet.cpp` 的 `detectConflicts()` + `SkipList` → `fdbserver/tlog/TLogServer.cpp` 的 `tLogCommit()/commitQueue()` → `fdbserver/logsystem/LogSystem.cpp` 的 `push()/getDurableVersion()`
- **第三遍：理解存储与数据分布**
  `fdbserver/storageserver/storageserver.cpp` 的 `getValueQ()/update()/updateStorage()` → `fdbserver/kvstore/VersionedBTree.cpp` 的 `commit()` → `fdbserver/datadistributor/DataDistribution.cpp` 与 `DDRelocationQueue.cpp` 的 `dataDistributionRelocator()`
- **第四遍：理解容错与恢复**
  `fdbserver/clustercontroller/ClusterController.cpp` 的 `clusterWatchDatabase()` → `ClusterRecovery.cpp` 的 `clusterRecoveryCore()` 9 阶段 → `fdbserver/core/CoordinatedState.cpp` Paxos → `fdbserver/SimulatedCluster.cpp` 看模拟如何复用同一份 fdbd 代码

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| **generation** | 事务系统的代际号，即 `recoveryCount`，每次 recovery 递增 |
| **cstate** | coordinated state，持久化在协调器上的集群核心状态（含 TLog 配置） |
| **tag** | mutation 的路由标签，按 storage server 分配，TLog 按 tag 分区 |
| **knownCommittedVersion** | proxy 确认已在所有 TLog 持久化的最大版本 |
| **recoveryVersion** | 恢复基准版本，`min(所有旧 TLog durable version)` |
| **shard** | key range 分片，DataDistributor 的迁移与分布粒度 |
| **team** | 一组 storage server（通常 3 副本），共同复制一个 shard |
| **OCC** | 乐观并发控制，FDB 用 read/write conflict range 检测写写冲突 |
| **actor** | FDB 的异步执行单元，现用 C++20 协程实现 |
| **Buggify** | FDB 独创的概率性代码路径变异测试技术 |

### 参考资料

- [FDB 官方文档](https://apple.github.io/foundationdb/)
- [design/recovery-internals.md](https://github.com/apple/foundationdb/blob/main/design/recovery-internals.md) — 恢复机制详解
- [design/Commit/How a commit is done in FDB.md](https://github.com/apple/foundationdb/blob/main/design/Commit/How%20a%20commit%20is%20done%20in%20FDB.md) — 提交全流程图解
- [design/fdb-coroutines-internals.md](https://github.com/apple/foundationdb/blob/main/design/fdb-coroutines-internals.md) — C++20 协程内部机制
- [design/tlog-spilling.md.html](https://github.com/apple/foundationdb/blob/main/design/tlog-spilling.md.html) — TLog spill-by-reference 设计
- [design/data-distributor-internals.md](https://github.com/apple/foundationdb/blob/main/design/data-distributor-internals.md) — 数据分布内部机制
- 论文：*FoundationDB: A Distributed Store with ACID Transactions*（2021 SIGMOD Record）
