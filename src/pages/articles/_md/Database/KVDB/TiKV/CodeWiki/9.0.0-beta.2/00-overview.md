---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "Overview"
date: "2026-10-01T20:34:15+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "Raft", "Percolator", "MVCC", "Rust"]
description: "PingCAP 开源分布式事务 KV 数据库 v9.0.0-beta.2 全景解读：Multi-Raft 复制、Percolator 两阶段提交、MVCC 三 CF 编码、Coprocessor 下推计算与 raftstore-v2 tablet 架构。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v9.0.0-beta.2 · **解读基线** commit [`423f4d2cc`](https://github.com/tikv/tikv/commit/423f4d2cc)（2025-06-26，tag `v9.0.0-beta.2.pre` 快照）· **协议** Apache-2.0 · **语言** Rust 2021（nightly）· **代码量** src/ ~12.6 万行 + components/ ~46.7 万行（非测试）· **仓库** [GitHub](https://github.com/tikv/tikv/)

---

## 总览

### 项目简介

TiKV 是 PingCAP 开源的分布式事务型 key-value 数据库，TiDB 的存储层，CNCF 毕业项目。设计灵感来自 Google 的 BigTable、Spanner 和 Percolator：数据按 Region（默认 96MB 区间）切分，每个 Region 是一个 Raft 组（多副本强一致），事务模型采用 Percolator 两阶段提交（客户端协调、TiKV 承担 prewrite/commit 与冲突检测），提供 Snapshot Isolation 与外部一致性读写。技术栈上，Raft 共识用 raft-rs 实现，共识日志与数据落盘用 RocksDB（v9 起共识日志默认独立为 raft-engine），下推计算用向量化火山模型。

**项目边界**：TiKV 只负责存储与下推计算——SQL 解析、执行计划、全局事务协调（TSO 发号）都由 TiDB 与 PD 承担；PD（placement Driver）负责 Region 调度与元数据，是独立进程不在本仓库内。TiKV 对外暴露 gRPC 接口（RawKV / TxnKV / Coprocessor），不直接接受 SQL。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|----------|------|
| RawKV 读写 | `src/storage/raw/mod.rs` | 无事务 KV API（API v2 带 Causal TS） |
| TxnKV 事务 | `src/storage/txn/`、`src/storage/mvcc/` | Percolator 2PC + SI |
| MVCC 多版本 | `components/txn_types/src/` | 三 CF 编码（default/lock/write） |
| Multi-Raft 复制 | `components/raftstore/src/store/` | PeerFsm/ApplyFsm 双池 |
| Region 分裂/合并 | `components/raftstore/src/store/worker/split_check.rs` | size/keys/load 三策略 |
| Coprocessor 下推 | `src/coprocessor/`、`components/tidb_query_*/` | DAG 向量化执行 |
| 事务 GC | `src/server/gc_worker/` | safe point + compaction filter |
| 死锁检测 | `src/server/lock_manager/deadlock.rs` | 中心化 leader 检测 |
| CDC 变更捕获 | `components/cdc/` | observer + incremental scan |
| 日志备份 PITR | `components/backup-stream/` | 流式日志到 S3/GCS |
| 快照备份 | `components/backup/` | BR 全量备份 |
| SST 导入 | `components/sst_importer/` | Lightning 快速导入 |
| In-Memory Engine | `components/in_memory_engine/` | Region 级只读内存副本 |
| raftstore-v2 | `components/raftstore-v2/` | per-region tablet 引擎（可选） |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| raft-rs | 核心 | Raft 共识状态机（PingCAP 维护） |
| RocksDB（rocksdb crate） | 核心 | 数据 KV 引擎（CF 三列族） |
| raft-engine | 核心 | 共识日志专用引擎（默认启用） |
| grpcio / grpc-rs | 核心 | gRPC 服务框架（C 绑定） |
| yatp | 核心 | yet another task pool，TiKV 定制线程池 |
| crossbeam | 核心 | 并发原语（skiplist/epoch/deque） |
| tipb | 核心 | TiDB 下推协议 protobuf 定义 |
| prometheus | 可选 | 指标暴露（status server :20180） |
| tikv_alloc | 核心 | jemalloc/tcmalloc/mimalloc 分配器抽象 |

### 版本历史

- 2016 开源，v1 单 RocksDB + 简单 raft
- v2.x（2018）：coprocessor、乐观事务定型，进入 CNCF 孵化
- v3.x（2019）：悲观事务、Unified Thread Pool
- v4.0（2020）：CNCF 毕业、Titan（LSM KV 分离）、CDC 雏形
- v5.x：raft-engine（共识日志独立）、async commit、stale read
- v6.x：Resolved TS、PITR 日志备份雏形、Raft Engine 默认
- v7.x：in_memory_engine 雏形、resource control
- v9.0（2025）：raftstore-v2 转正可选（partitioned-raft-kv）、lock_waiting_queue（pipelined DML 基建）、tirocks（Rust 原生 RocksDB 绑定）过渡——本版解读基线

## 快速上手

```shell
# 最小集群（PD + TiKV ×1 + 可选 TiDB）
tiup playground nightly --db 0 --kv 1 --pd 1
# 或源码构建
cd tikv && make build    # 产出 target/release/tikv-server

# 验证：raw_put 后 raw_get（tikv-ctl 或任意 TiKV client）
tikv-ctl --host 127.0.0.1:20160 raw-put abc 123
tikv-ctl --host 127.0.0.1:20160 raw-get abc
# 输出：123
```

二进制入口：`cmd/tikv-server/src/main.rs` 的 `fn main()`（`cmd/tikv-server/src/main.rs:16`），管理工具 `cmd/tikv-ctl/src/main.rs:74`。

## 架构设计解析

### 系统架构

TiKV 的核心设计问题：**如何把一个单机 KV 引擎（RocksDB）变成跨机器强一致、可线性扩展的分布式事务数据库**。答案分五层组装：最底下的引擎抽象层把 RocksDB/raft-engine 的差异抹平成 `KvEngine`/`RaftEngine` trait；之上 raftstore 把数据按 Region 切成成百上千个 Raft 组，用 FSM + BatchSystem 的消息驱动模型让单机跑几万个 Raft 组不爆炸；再上层的 MVCC/Percolator 在 Raft 之上叠事务语义（三 CF 编码 + 两阶段提交）；Storage 层的 Scheduler 管理事务命令的并发调度（latch + 线程池）；最顶上 gRPC Server 面向客户端。读写路径分离：写必须过 Raft 复制，读优先走 leader lease 本地读，回退 ReadIndex。

![分层架构](/vibe-reading/images/articles/tikv-codewiki-9.0.0-beta.2/architecture.svg)

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| gRPC 服务层 | `components/server`、`src/server` | 隔离网络协议，把 gRPC 请求翻译成存储层命令 |
| 存储调度层 | `src/storage` | 事务命令调度与读路径编排，屏蔽复制细节 |
| 复制状态机层 | `components/raftstore`（v2 同位） | Multi-Raft 复制、Region 生命周期，强一致的根基 |
| 事务数据层 | `src/storage/mvcc`、`components/txn_types` | MVCC 编码与 Percolator 语义 |
| 引擎抽象层 | `components/engine_traits` 及各 engine | 抹平后端差异，泛型静态分发保性能 |
| 基础设施 | `components/tikv_util` | 线程池/worker/channel/配置热更，全仓库共用地基 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| FSM + 消息驱动 | `components/batch-system/src/batch.rs` + raftstore fsm/ | 把上万 Raft 组的锁竞争变成 mailbox 队列串行 |
| 泛型静态分发 | `engine_traits` 全套 trait、`TikvServer<ER, F>` | 热路径零虚表开销，代价是编译膨胀 |
| Observer/Coprocessor Host | `components/raftstore/src/coprocessor/` | CDC/GC/IME 等寄生 raftstore 而不改主流程 |
| Worker/Actor | `tikv_util::worker`（gc_worker/pd_worker/deadlock） | 后台任务隔离线程 + 队列串行 |
| Builder | `KvEngineFactoryBuilder`、`YatpPoolBuilder` | 多参数对象装配 |
| 状态机 | `RegionState`（IME）、`State`（GC）、`GroupState`（peer） | 显式约束合法转移，非法即 panic |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| Region | 96MB 左右的 key 区间 + 副本列表 | 分裂/合并中诞生与消亡 | 每 Region 一个 Raft 组 |
| Peer | Region 在某 store 上的副本（含 raft 状态机） | confchange/destroy 中增删 | PeerFsm 持有 |
| RaftRouter | 全局 FSM 邮箱路由器（发消息给指定 region 的 FSM） | 进程级单例 | 被所有层共享 |
| Storage | RawKV/TxnKV 门面（clone 共享内部 Arc） | 进程级 | 持 Scheduler + Engine |
| TxnScheduler | 事务命令调度器（latch + sched_pool） | 进程级 | 每 store 一个 |
| MvccTxn | 单条事务命令的写缓冲（积累 Modify） | 单命令 | 输出喂给 Raft |
| Lock/Write | Percolator 的锁与提交记录 | prewrite 落 lock，commit 转 write | 三 CF 编码 |
| Tablet（v2） | per-region 独立 RocksDB 实例 | v2 引擎中随 region 生灭 | TabletRegistry 管理 |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|----------|
| `Engine` | `components/tikv_kv/src/lib.rs:341` | `RaftKv`（v1）、`RaftKv2` | 装配时注入 Storage |
| `KvEngine` | `components/engine_traits/src/engine.rs:13` | RocksEngine、RegionCacheMemoryEngine、tirocks | supertrait 组合 |
| `RaftEngine` | `components/engine_traits/src/raft_engine.rs:84` | RaftLogEngine、RocksEngine（兼容） | 启动按 config 选择 |
| `BatchExecutor` | `components/tidb_query_executors/src/interface.rs:21` | table_scan/selection/聚合等十余执行器 | `build_executors` 组装 |
| `PdClient` | `components/pd_client/src/lib.rs:407` | RpcClient、FakePdClient（测试） | 依赖注入 |
| `Runnable` | `components/tikv_util/src/worker/pool.rs` | 各 Worker 的 Runner | `Worker::start` |
| `CoprocessorHost` observer | `components/raftstore/src/coprocessor/` | CdcObserver、GcObserver、LoadEvictionObserver 等 | `register_xxx_observer(priority)` |

## 代码目录

```shell
tikv/
├── cmd/tikv-server/src/main.rs    # 服务端入口（run_tikv 分派）
├── cmd/tikv-ctl/src/main.rs       # 运维 CLI
├── src/
│   ├── config/                    # TikvConfig（8400 行）+ 热更新
│   ├── server/                    # gRPC service 定义、raftkv 桥接、raft_client
│   │   ├── service/kv.rs          # KvService（gRPC → Storage）
│   │   ├── raftkv/                # RaftKv（Engine trait 的 raftstore 适配）
│   │   ├── gc_worker/             # GC
│   │   └── lock_manager/          # 死锁检测 + waiter
│   ├── storage/                   # Storage 门面
│   │   ├── txn/                   # TxnScheduler + 命令对象
│   │   ├── mvcc/                  # MvccTxn/MvccReader/actions
│   │   └── raw/                   # RawKV
│   ├── coprocessor/               # DAG 下推入口 + analyze 统计
│   └── read_pool.rs               # 读线程池
├── components/                    # ~70 个子 crate
│   ├── raftstore/                 # v1 Multi-Raft（73k 行，本文重点）
│   ├── raftstore-v2/              # v2 tablet 引擎
│   ├── batch-system/              # FSM 轮转调度框架
│   ├── engine_traits|rocks|tirocks|panic # 引擎抽象与实现
│   ├── raft_log_engine/           # 共识日志专用引擎
│   ├── txn_types/ tikv_kv/        # MVCC 类型 / Engine trait
│   ├── tidb_query_*/              # 下推计算五件套
│   ├── cdc/ backup-stream/ backup/ resolved_ts/
│   ├── in_memory_engine/ hybrid_engine/
│   ├── pd_client/ concurrency_manager/
│   └── tikv_util/                 # 地基（49 crate 依赖）
└── tests/
    ├── integrations/              # 按域分：storage/raftstore/coprocessor/server...
    ├── failpoints/                # failpoint 注入测试
    └── benches/                   # 基准
```

## 模块地图

![模块依赖](/vibe-reading/images/articles/tikv-codewiki-9.0.0-beta.2/module-dependencies.svg)

依赖主线从下到上：tikv_util → engine_traits → raftstore（复用给 v2）→ RaftKv/Storage → Server。CDC/backup 系模块通过 observer 挂 raftstore，pd_client 是控制面唯一出口。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|------------|----------|
| Server 与 gRPC 服务 | 进程装配、gRPC 面向客户端、raft 消息网络 | `run_tikv` in `components/server/src/server.rs:219` | 网络协议与存储内核解耦，可独立演进 | [01](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/01-server-grpc) |
| Storage 与 TxnScheduler | 事务命令调度、latch、读池 | `Storage` in `src/storage/mod.rs:193` | 调度逻辑与事务语义、复制细节正交 | [02](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/02-storage-scheduler) |
| RaftStore v1 | Multi-Raft 复制状态机 | `RaftBatchSystem` in `fsm/store.rs:1647` | 强一致核心，体量与复杂度独一档 | [03](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/03-raftstore) |
| MVCC 与 Percolator | 多版本编码与事务数据语义 | `MvccTxn` in `src/storage/mvcc/txn.rs:60` | 数据编码独立于调度与复制，可单独测试 | [04](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/04-mvcc-percolator) |
| GC 与事务协调 | safe point GC、死锁检测、内存锁 | `GcWorker` in `src/server/gc_worker/gc_worker.rs:1194` | 都是"事务完成后的善后"，异步独立线程 | [05](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/05-gc-deadlock) |
| Coprocessor 下推 | DAG 向量化执行、analyze | `parse_and_handle_unary_request` in `src/coprocessor/endpoint.rs:587` | 计算下推与存储服务是两种负载形态 | [06](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/06-coprocessor) |
| PD Client 与调度 | 心跳上报、split/merge、调度指令执行 | `Runner::handle_heartbeat` in `worker/pd.rs:1187` | 控制面交互集中一处，与数据面隔离 | [07](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/07-pd-scheduler) |
| 引擎抽象与实现 | KvEngine/RaftEngine trait + RocksDB | `KvEngine` in `engine_traits/src/engine.rs:13` | 引擎可替换性的契约层 | [08](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/08-engine-traits) |
| raftstore-v2 | per-region tablet 新一代 raftstore | `create_store_batch_system` in `raftstore-v2/src/batch/` | 架构重设计，与 v1 平行演进的独立 crate | [09](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/09-raftstore-v2) |
| CDC 与备份 | 变更捕获、resolved-ts、PITR、BR | `Endpoint::on_multi_batch` in `cdc/src/endpoint.rs:988` | 观察者生态，与在线服务解耦 | [10](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/10-cdc-backup) |
| In-Memory Engine | Region 级只读内存副本 | `RegionCacheMemoryEngine` in `ime/src/engine.rs:338` | 独立缓存子系统，正交于磁盘引擎 | [11](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/11-in-memory-engine) |
| tikv_util | Worker/yatp/mpsc/config 地基 | `Worker` in `tikv_util/src/worker/pool.rs` | 49 个 crate 的公共依赖，必须独立 | [12](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/12-tikv-util) |

## 运行时行为

### 启动流程

```text
main() in cmd/tikv-server/src/main.rs:16
├── fips::maybe_enable()                       # FIPS 模式最早启用
├── TikvConfig::from_file + overwrite_config_with_cmd_args
├── validate_and_persist_config                # 校验并落 last_config.toml
├── config.storage.validate_engine_type()      # RaftKv / RaftKv2 分派
├── initial_logger + memory.init()
└── run_tikv(config, ...) in components/server/src/server.rs:219
    ├── dispatch_api_version!(...)            # (引擎类型 × API 版本) 双轴静态分发
    └── run_impl::<ER, F>() in server.rs:153
        ├── TikvServer::init                  # SecurityManager/gRPC Env/RpcClient(PD)/ConfigController
        ├── create_raft_batch_system          # (RaftRouter, RaftBatchSystem) in fsm/store.rs:2048
        ├── init_raw_engines                  # raft engine + KvEngineFactory + Engines + TabletRegistry
        ├── init_engines in server.rs:490     # RaftKv::new(ServerRaftStoreRouter(RaftRouter+LocalReader), kv)
        ├── init_servers in server.rs:534     # Storage::from_engine / ReadPool / LockManager / GcWorker
        │                                    #   / MultiRaftServer / coprocessor::Endpoint / Server::new
        ├── register_services in server.rs:1199 # KvService/Import/Debug/Deadlock/Backup/CDC/LogBackup...
        └── run_server                        # build_and_bind + start；主循环 service_event_rx.recv()
```

装配关系全部显式传参（无 DI 容器）：`RpcClient` → resolver/concurrency_manager/causal_ts；`Engines` → `RaftKv` → `Storage` → gRPC `Service`；`RaftRouter` 同时注入 RaftKv、MultiRaftServer、CDC/GC 各 endpoint。跨线程通信一律 channel（FSM mailbox、LazyWorker scheduler、GrpcServiceManager）。

### 核心运行流程

本节讲三条主链路：事务写、点读、启动外的第三条——Region 心跳调度。写路径与读路径的分野是 TiKV 性能设计的精髓：写必须全链路过 Raft（四段线程边界），读尽量短路。

#### 写路径：prewrite + commit

![写路径数据流](/vibe-reading/images/articles/tikv-codewiki-9.0.0-beta.2/data-flow.svg)

文字解读：`kv_prewrite`（gRPC 线程）→ `future_prewrite` 组 future+callback 对 → `Storage::sched_txn_command` 转成 `Command::Prewrite` 命令对象 → `TxnScheduler::run_cmd`（scheduler.rs:523）在 latch 队列排队， acquiring 成功后 `execute`（scheduler.rs:718）spawn 到 SchedPool；`process_write` 调 `actions::prewrite` 用 `MvccTxn` 积累 `Vec<Modify>`（lock CF 写入）→ `handle_async_write` 走 `RaftKv::async_write`（raftkv/mod.rs:474）转 `RaftCmdRequest` → `RaftRouter::send_command` 投进 PeerFsm mailbox → `propose_raft_command`（fsm/peer.rs:5882）→ `Peer::propose`（peer.rs:3875）写 raft log → quorum 后 `handle_raft_committed_entries`（peer.rs:3117）转 ApplyFsm → `apply_raft_cmd`（apply.rs:1465）逐 entry 解码写 RocksDB WriteBatch → `write_to_db`（apply.rs:576）落盘 → 回调沿 WriteEvent stream 反向唤醒 future → gRPC response。数据形态变化：`PrewriteRequest`(pb) → `Command::Prewrite` → `Vec<Modify>` → `RaftCmdRequest` → raft entry bytes → RocksDB CF 写入。

#### 读路径：kv_get

`kv_get` → `Storage::get`（mod.rs:605）投 ReadPool（yatp）→ `prepare_snap_ctx` 先查内存锁（ConcurrencyManager `read_key_check`）再 `RaftKv::async_snapshot` → **LocalReader**（worker/read.rs:1270）按策略分流：leader lease 有效（`is_in_leader_lease`）→ SnapCache 直取本地快照免 raft；stale read 检查 `safe_ts`；follower replica read / lease 失效 → redirect 到 PeerFsm 走 `read_index`（peer.rs:4198，raft `MsgReadIndex` 确认线性一致）→ `RegionSnapshot` → `SnapshotStore::get` → `PointGetter`（point_getter.rs:170）三步：`load_and_check_lock`（CF_LOCK 冲突）→ `seek_write`（CF_WRITE 倒序选版本）→ `load_data`（CF_DEFAULT 或 short_value 直取）→ GetResponse。lease read 与 ReadIndex 的分支条件在 `Peer::inspect`（peer.rs:6191）：`has_applied_to_current_term() && inspect_lease() == LeaseState::Valid` 才本地读。

#### 调度路径：Region 心跳与 split

`on_pd_heartbeat_tick`（fsm/peer.rs:6710）→ `Peer::heartbeat_pd` 组 HeartbeatTask → PdWorker（pd.rs:1187）→ `region_heartbeat`（client.rs:584）走**双向 gRPC 流**（hb_sender 复用单 stream），PD 调度指令从同流响应回来 → `schedule_heartbeat_receiver`（pd.rs:1602）转 admin 命令。split 由 TiKV 发起：size 检查（split_check.rs:602，Scan/Approximate 双 policy）→ `ask_batch_split` 向 PD 只申请新 region id → BatchSplit admin cmd 过 Raft → `on_ready_split_region`（fsm/peer.rs:4459）创建新 peer 并立即心跳上报。

### 状态流

![状态流](/vibe-reading/images/articles/tikv-codewiki-9.0.0-beta.2/state-flow.svg)

三台状态机：Region 副本的 raft 角色流转（Follower/Candidate/Leader + Snapshot 落后拉快照 + Tombstone confchange 移除，`GroupState` 与 raft-rs StateRole 驱动，转换触发点在 `on_role_changed` fsm/peer.rs:2196）；IME 缓存的 `RegionState`（region_manager.rs:28，`validate_update_region_state` 校验非法转移即 panic，evict 后进 historical_regions 等最后一个快照释放才物理删除）；GcWorker 单 key GC 的 `State::{Rewind, RemoveIdempotent, RemoveAll}`（gc.rs:87，safe point 推进触发回卷）。

## 典型修改场景

#### 场景 1：新增一个 gRPC unary 接口

改 kvproto → `src/server/service/kv.rs` 加 `future_xxx` + `handle_request!(xxx, ...)` 一行注册（kv.rs:335 起）→ 需要新依赖则扩 `Service` 字段与 `Service::new`。对应测试 `tests/integrations/server/`。

#### 场景 2：新增一个下推标量函数

`components/tidb_query_expr/src/impl_*.rs` 用 `#[rpn_fn(nullable)]` 写实现 → `lib.rs:408 map_expr_node_to_rpn_func` 注册 `ScalarFuncSig` 映射 → TiDB 侧同步加 sig。对应测试 `components/tidb_query_expr/src/impl_*/tests`。

#### 场景 3：用 Worker 起一个后台任务

定义 `enum XxxTask` + `impl Runnable` → `LazyWorker::new("xxx")` + `scheduler().schedule(task)`，销毁 `stop_worker()`——参考 raftstore pd_worker（fsm/store.rs:1624）。对应测试模式见 `tests/failpoints/`。

## 测试体系

```shell
tests/
├── integrations/     # 集成（按域分子目录：storage/raftstore/coprocessor/server/pd/backup/import/config）
├── failpoints/       # fail-rs 注入测试（cases/ 按域分子目录）
└── benches/          # 基准
components/test_*     # 测试基建 crate（test_raftstore 集群模拟、test_storage 等）
components/*/[mod].rs # 每个 crate 内嵌 #[cfg(test)] 单元测试（大文件如 peer.rs 测试占近半）
```

| 代码层 | 测试类型 |
|--------|----------|
| tikv_util / txn_types / engine_traits | crate 内单元测试 + engine_traits_tests 泛型框架 |
| raftstore | crate 内单元 + test_raftstore 模拟集群 + failpoints 注入 |
| storage/mvcc | crate 内单元（mvcc 测试极密）+ test_storage |
| server/gRPC/cdc | tests/integrations 端到端 |

理解某个类优先读它内嵌的同名 `tests` 模块——TiKV 的测试是可执行文档。

## 阅读源码推荐路线

- 第一遍：主流程
  `cmd/tikv-server/src/main.rs` 的 `main()` → `components/server/src/server.rs` 的 `run_tikv`/`init_servers`（看对象怎么装出来）→ `src/server/service/kv.rs` 的 `future_get` → `src/storage/mod.rs` 的 `Storage::get`
- 第二遍：事务与 MVCC
  `src/storage/txn/scheduler.rs` 的 `run_cmd`/`execute` → `src/storage/txn/commands/prewrite.rs` 的 `process_write` → `src/storage/mvcc/txn.rs` → `components/txn_types/src/types.rs` 的 `Key::append_ts`（编码基石）
- 第三遍：Raft 复制
  `components/raftstore/src/store/msg.rs`（消息全集）→ `fsm/peer.rs` 的消息分派（:674 起）→ `peer.rs` 的 `propose`/`read_index` → `fsm/apply.rs` 的 `apply_raft_cmd`/`write_to_db` → `components/batch-system/src/batch.rs` 的 `poll`
- 第四遍：按兴趣选模块文档深入（下表 12 篇），engine_traits → raftstore-v2 → CDC/IME 是 v9 的新动向

## 附录

### 术语表

| 术语 | 解释 |
|------|------|
| Region | key 空间区间切分单元，默认 ~96MB，Raft 组的基本单位 |
| Peer | Region 的一个副本；leader peer 服务读写 |
| PD | Placement Driver，集群调度器（独立仓库 pingcap/pd） |
| TSO | Timestamp Oracle，PD 发的混合物理+逻辑时间戳 |
| Percolator | Google 论文的 2PC 模型：prewrite 上锁 → primary/secondary 协调 |
| CF | RocksDB ColumnFamily；TiKV 用 default/lock/write 三个 |
| RaftEngine | 共识日志专用引擎（PingCAP raft-engine crate） |
| Tablet | v2 引擎中 per-region 的独立 RocksDB 实例 |
| Lease Read | leader 租约内的本地读（免 ReadIndex 往返） |
| Resolved TS | leader 已 apply 时刻的安全时间戳（CDC/stale read 基础） |

### 参考资料

- [TiKV 官方文档](https://tikv.org/docs/latest/concepts/overview/)
- [raft-rs](https://github.com/tikv/raft-rs) · [raft-engine](https://github.com/tikv/raft-engine) · [PD](https://github.com/tikv/pd)
- 论文：Raft（OSDI'14）、Percolator（OSDI'10）、Spanner（OSDI'12）、MonetDB/X100（CIDR'05，向量化执行出处）
- 本仓库 `doc/` 目录与 `PERFORMANCE_CRITICAL_PATH.md`（维护者视角的代码导读）
