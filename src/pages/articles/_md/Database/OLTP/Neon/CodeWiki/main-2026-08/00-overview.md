---
source:
  type: "源码解读"
  project: "neon"
  url: "https://github.com/neondatabase/neon"
title: "Overview"
date: "2026-10-02T15:00:33+08:00"
category: [Database, OLTP, Neon, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["Neon", "Rust", "PostgreSQL", "存算分离", "Serverless", "WAL", "分层存储"]
description: "Neon serverless Postgres 存储引擎全仓库解读概览：Pageserver / Safekeeper / Storage Controller / Compute 节点栈十大模块与读写数据流"
readingTime: "45 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** main-2026-08 · **解读基线** commit [`fa504217c`](https://github.com/neondatabase/neon/commit/fa504217c61bbcaf5c512d75830564541f917f8f)（2026-08-31，开发分支快照，仓库无 release tag——282 个 tag 均为 CI 代理标记）· **协议** Apache-2.0 · **语言** Rust 1.88 / Python 3.11 / C（PostgreSQL fork）· **代码量** Rust ~31.7 万行 + Python 测试 ~7.6 万行 + C 扩展 ~2.5 万行

---

## 总览

### 项目简介

Neon 是一个开源的 serverless Postgres 数据库平台，核心思想是把 PostgreSQL 的**存储层整体剥离**：compute 节点是无状态的标准 PostgreSQL（fork + `pgxn/neon` 扩展），数据不落本地盘，页面读取走网络向 Pageserver 要，WAL 写入经 Safekeeper 多副本持久化后再异步物化。这一刀切开之后，"PostgreSQL 集群"获得了存储引擎不具备的三个能力——**计算节点秒级启停**（serverless 按需付费的前提）、**时间线分支**（copy-on-write，分支不占空间）、**任意 LSN 时间点恢复**（PITR 天然免费）。

项目当前边界：本仓库是存储引擎 + 计算节点栈 + 接入网关 + 编排控制面的**服务端全家桶**；生产环境的 Web console、计费、K8s 编排等云端控制面在独立仓库，本地开发编排则收敛在一个 `neon_local` CLI 里。另外要特别说明：本基线 main-2026-08 快照在 safekeeper 侧带有一批 `BEGIN_HADRON` 标记的第三方部署变体补丁（34 个文件，涉及 HCC 控制、磁盘限额、offloader 重选），成文时会将其视为 Neon 官方主线之外的变体特征单独标注。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| 存算分离存储引擎 | `pageserver/` | WAL 物化为不可变 layer，响应 GetPage@LSN |
| WAL quorum 持久化 | `safekeeper/` | term-based 共识（非 Raft），WAL 备份 S3 |
| 无状态 compute | `compute_tools/` + `pgxn/neon` | smgr 整体替换，页面/WAL 全走网络 |
| 分片租户编排 | `storage_controller/` | shard 放置调度、failover、generation 签发 |
| 多入口接入 | `proxy/` | TLS SNI / websocket / SQL-over-HTTP |
| 时间线分支 | `pageserver` Timeline 祖先链 | 分支 = 新 timeline 指向祖先 LSN |
| 对象存储一致性巡检 | `storage_scrubber/` | 独立只读进程，孤儿检测 + 谨慎 GC |
| E2E 测试框架 | `test_runner/` | 582 个回归测试函数，真实二进制全链路 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Rust 1.88 + tokio | 核心 | 全部服务端组件 |
| PostgreSQL v14–v17 fork | 核心 | compute 内核 + walredo 进程（`vendor/` submodule） |
| tonic / protonn | 核心 | gRPC（page_api、storage_broker） |
| diesel_async + bb8 | 核心 | storcon 的 Postgres 持久层 |
| aws-sdk-s3 / azure / GCS | 核心 | `libs/remote_storage` 多云后端 |
| poetry + pytest | 测试 | test_runner E2E 框架 |
| cargo-hakari | 工程 | workspace_hack 特性统一 |
| TLA+（`safekeeper/spec/`） | 验证 | 共识协议形式化验证 |

### 版本历史

Neon 的版本演进有两条值得注意的脉络：一是协议持续精简——WAL 拉取曾有 vanilla（原始字节流）与 interpreted（解码后按 shard 过滤）两条路，本基线已把 vanilla 从 ingest 路径移除（`pageserver/src/tenant/timeline/walreceiver/connection.rs:291` 注释 "Vanilla WAL receiver protocol is no longer supported for ingest"），只保留 replica 场景；二是 compaction 重构——legacy 的 `compact_level0` 仍在生产，新的 tiered compaction 已拆成独立 `pageserver/compaction/` crate（配套模拟器），走 trait 解耦渐进替换的路线。这符合"渐进发布、保留 kill switch"的一贯工程风格（`upload_queue.rs` 里的 `DISABLE_UPLOAD_QUEUE_REORDERING` 等环境变量开关）。

### 顶层上下文图

系统外部交互方：最终用户（psql / 任意 PG 客户端 / serverless driver）、Neon 云控制面（console，签发 spec 与认证元数据）、多云对象存储（S3/Azure/GCS）与运行平台（K8s）。用户流量经 Proxy 路由到 compute；控制面经 storcon 编排存储集群；一切持久状态收敛到对象存储。

![Neon 分层架构](/vibe-reading/images/articles/neon-codewiki-main-2026-08/architecture.svg)

---

## 快速上手

`neon_local` CLI 把"起一套完整 Neon"压缩到三条命令（需要 Linux 或 macOS + Make + Poetry，`make build` 先构建 Postgres fork 与全部 Rust 组件）：

```bash title="本地开发环境"
# 1. 编译（首次较慢：要编 4 个版本的 PostgreSQL）
make build

# 2. 初始化并拉起全栈（broker + storcon + pageserver + safekeeper + compute）
./scripts/neon init && ./scripts/neon start

# 3. 起 compute 并验证——这是标准 PostgreSQL，任何客户端都能连
./scripts/neon endpoint create main --pg-version 17
./scripts/neon endpoint start main
psql "postgresql://localhost:55432/postgres" -c "SELECT 1"
```

想看到"存算分离"生效，最直观的验证是分支：

```bash title="分支零拷贝验证"
./scripts/neon timeline branch my-branch
./scripts/neon endpoint create my-branch --branch-name-override my-branch  # 分支上起独立 compute
psql ... -c "SELECT * FROM 只在分支上建的表"   # 分支 compute 有独立数据视图
```

---

## 架构设计解析

### 系统架构

Neon 的架构哲学是**把 PostgreSQL 拆成"执行器"和"存储引擎"两个独立可伸缩的组**。为什么这样设计？传统 PG 的 buffer 管理器和 smgr 耦合在一个进程里，扩容要整库搬家、恢复要重放全部 WAL；Neon 把 smgr 换成网络客户端（`pagestore_smgr.c` 的 `smgr_neon`），把 WAL 持久化外包给共识组，于是 compute 变成了纯执行器——可以随时销毁重建，可以秒级冷启动（一次 basebackup 拉目录），serverless 计费模型才有物理基础。

分层如上面的架构图：**接入/控制层**（Proxy、console、storcon、neon_local）负责"流量怎么进来、租户放哪里"；**计算层**（PostgreSQL fork + compute_tools）负责 SQL 执行；**存储层**（Safekeeper、Pageserver、Broker）负责数据持久化与页面服务；**持久层**（S3、storcon 的 Postgres、Redis）承载一切真相。层间协作有三条主协议：compute↔pageserver 的 `pagestream_v3`（libpq COPYBOTH 载体）或 gRPC page_api、compute(walproposer)↔safekeeper 的 `START_WAL_PUSH` 共识消息、pageserver↔safekeeper 的物理复制流（interpreted WAL）。

| 架构层 | 包含目录 | 层职责 |
| --- | --- | --- |
| 接入 / 控制层 | `proxy/`、`storage_controller/`、`control_plane/` | 隔离外部协议与租户编排，compute 无需感知彼此的放置变化 |
| 计算层 | `compute_tools/`、`pgxn/`、`vendor/postgres-v14..17` | 承载 SQL 执行语义，无持久状态、可丢弃 |
| 存储层 | `safekeeper/`、`pageserver/`、`storage_broker/` | WAL 先 quorum 落盘再异步物化，读写路径解耦 |
| 持久层 | `libs/remote_storage`（S3 等）、`storage_controller/migrations` | 唯一容错真源；generation 防脑裂 |
| 工程底座 | `libs/`、`test_runner/`、`scripts/` | 共享类型/协议/抽象 + E2E 验证 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 意图 / 观测双结构 | `TenantShard.intent/observed`（`storage_controller/src/tenant_shard.rs:161/397`） | level-triggered reconcile：重复执行无害，故障后自动收敛 |
| Generation number | `Generation`（`libs/utils/src/generation.rs`）+ DeletionQueue Validator | S3 无 CAS，单调代数号隔离新旧写者、拒绝旧代删除，防脑裂数据丢失 |
| Trait 抽象 + enum 分发 | `RemoteStorage` trait + `GenericRemoteStorage` enum（`libs/remote_storage/src/lib.rs`） | trait 定契约、enum 消泛型传染，多云后端一套调用面 |
| RAII 守卫 | `ResidentLayer` 驻留守卫、`Gate` + `CancellationToken`（`pageserver/src/tenant/timeline.rs:382`） | 关停安全：驻留期间禁止 evict，长任务可被取消 |
| 写回缓存 | `TimelineState` inmem/pers 分层（`safekeeper/src/state.rs:188`） | commit_lsn 高频变更不必每次 fsync，term 切换点强制落盘 |
| 声明式 spec 收敛 | `spec_apply.rs` 阶段化 apply + `ApplySpecPhase` 枚举 | 幂等：期望状态与现存状态 diff 后应用，重跑无害 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Timeline` | 一个分支的完整数据视图（LSN 标签的 KV 树） | tenant 内长期存在 | 指向 `ancestor_timeline` + `ancestor_lsn` |
| `TenantShard` | 租户分片，pageserver 的放置/管理单位 | storcon 侧长期 | 属于 Tenant，含 intent/observed 双状态 |
| `Layer`（delta/image） | 不可变的 (key, LSN) 数据文件 | 写入后不变，被 GC/compaction 合并 | 由 `LayerMap` 索引 |
| `Lsn` | WAL 字节偏移，全系统的时间轴 | — | commit/flush/backup/remote_consistent 诸底界都基于它 |
| `Term` + `TermHistory` | safekeeper 共识纪元 | 每 term 持久 | 决定 WAL 截断点 |
| `Generation` | pageserver 对象存储代数号 | 一次 attach 一个 | storcon 签发，防 split-brain |
| `ComputeSpec` | 控制面下发的期望状态 | 每次 configure 更新 | compute_tools 声明式应用 |
| `SafeKeeperState` | safekeeper 控制文件持久态 | 跨重启 | 含 acceptor_state/commit_lsn/eviction_state |

#### 核心抽象

| 接口 / 抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Handler<IO>` | `libs/postgres_backend/src/lib.rs:91` | page_service、wal_service 等 | `PostgresBackend::new_from_io` 传入 |
| `RemoteStorage` | `libs/remote_storage/src/lib.rs:340` | LocalFs/S3/Azure/GCS/Unreliable | `GenericRemoteStorage` enum 静态分发 |
| `CompactionJobExecutor` | `pageserver/compaction/src/interface.rs:15` | pageserver 内 `compact_tiered` 适配层 | trait object，配套模拟器独立运行 |
| `Storage`（SK 控制文件） | `safekeeper/src/control_file.rs:34` | `FileStorage` | 原子 rename 写入 |
| `ControlPlaneApi` | `proxy/src/control_plane/mod.rs` | console HTTP 客户端 | 构造注入 |
| `synchronous_standby_names = walproposer` | PG fork + `pgxn/neon/walproposer_pg.c` | `WalProposerMain` | bgworker 启动 |

---

## 代码目录

```shell
neon/
├── pageserver/          # 存储引擎（127k 行）：layer 物化、GetPage、上传 S3
│   ├── compaction/      # 新 tiered compaction crate（trait 解耦 + 模拟器）
│   ├── page_api/        # gRPC 页面服务（proto 定义 + shard 拆分器）
│   ├── ctl/ pagebench/ client/ client_grpc/   # 运维 CLI / 基准 / 客户端
│   └── src/
│       ├── tenant/      # Timeline、LayerMap、storage_layer、上传/下载队列
│       ├── walredo/     # WAL 重放（独立 postgres 进程 + Rust 内联两条路）
│       └── page_service.rs / pgdatadir_mapping.rs / walingest.rs ...
├── safekeeper/          # WAL 共识服务（22k 行）：term 协议、WAL 备份、eviction
│   └── spec/            # TLA+ 规约（ProposerAcceptorStatic/Reconfig）
├── storage_controller/  # storcon（30k 行）：放置调度、failover、generation
├── proxy/               # 接入网关（31k 行）：SNI/wss/SQL-over-HTTP/subzero REST
├── compute_tools/       # compute 管理器（13k 行）：spec 应用、监控、扩展下载
├── control_plane/       # neon_local CLI（9k 行）+ storcon_cli
├── pgxn/                # C 扩展（~25k 行）：smgr/communicator/walproposer/walredo
├── endpoint_storage/    # LFC prewarm 状态的 S3 文件服务（1k 行）
├── storage_broker/      # 时间线发现 pub/sub（1.3k 行，gRPC）
├── storage_scrubber/    # S3 一致性巡检 + GC（5k 行）
├── libs/                # 24 个共享 crate（62k 行）
├── test_runner/         # Python E2E 测试（76k 行，582 个测试函数）
├── compute/             # compute 镜像构建（Dockerfile/manifest/patches）
├── vendor/postgres-v14..v17  # PostgreSQL fork submodule（未随仓检出）
└── docs/                # 开发者文档（pageserver/safekeeper/storcon 各专题）
```

`workspace_hack/` 是 cargo-hakari 的特性统一产物；`scripts/` 含 `sk_cleanup_tenants` 等 safekeeper 运维脚本。

---

## 模块地图

模块间依赖与交互全局如下图——数据面（用户流量）在上，控制面（编排发现）居中，共享底座在下。要点：**compute 只认 pageserver/safekeeper 两个地址**，租户怎么分片、放在哪个节点，对它完全透明，这是 storcon + generation 机制换来的解耦。

![模块依赖关系](/vibe-reading/images/articles/neon-codewiki-main-2026-08/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Pageserver | WAL→layer 物化 + GetPage 服务 | `pageserver/src/bin/pageserver.rs` | 存储引擎职责单一：分层存储、walredo、上传下载自成一体 | [01-pageserver.md](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/01-pageserver) |
| Safekeeper | WAL quorum 持久化 | `safekeeper/src/bin/safekeeper.rs` | 共识组独立于存储引擎，commit 时延与物化解耦 | [02-safekeeper.md](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/02-safekeeper) |
| Storage Controller | 租户放置与 failover 编排 | `storage_controller/src/main.rs` | 全局唯一持 generation 视图的组件，pageserver 不可替代 | [03-storage-controller.md](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/03-storage-controller) |
| Proxy | 多协议接入与认证 | `proxy/src/bin/proxy.rs` | 无状态边缘层，与存储彻底隔离 | [04-proxy.md](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/04-proxy) |
| Compute 节点栈 | PostgreSQL 内核改造 + 管理 | `pgxn/neon/` + `compute_tools/src/bin/compute_ctl.rs` | C 扩展与 Rust 管理器共同构成"可丢弃的执行器" | [05-compute-stack.md](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/05-compute-stack) |
| libs 共享库层 | 类型 / 协议 / 存储抽象 | `libs/utils/src/lsn.rs` 等 | 打破服务间循环依赖（pageserver_api 独立是关键一招） | [06-libs.md](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/06-libs) |
| Storage Broker | 时间线发现 pub/sub | `storage_broker/src/bin/storage_broker.rs` | 避免存储节点 O(n²) 点对点连接 | [07-storage-broker-scrubber.md](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/07-storage-broker-scrubber) |
| Storage Scrubber | S3 一致性巡检 | `storage_scrubber/src/main.rs` | 独立只读进程：pageserver 宕机也能审计远端 | 同上 |
| Control Plane | 本地开发编排 CLI | `control_plane/src/bin/neon_local.rs` | 生产控制面不在本仓库，本地栈需要专门的编排器 | 同上 |
| test_runner | E2E 测试体系 | `test_runner/fixtures/neon_fixtures.py` | 测的是真实二进制全链路，独立于任何服务代码 | 同上 |

> 模块间的动态调用顺序见下方「核心运行流程」；Broker/Scrubber/Control Plane/test_runner 四个较小的模块合并为两篇文档，其余各自独立成文。

---

## 运行时行为

### 启动流程

一次 `neon start` 的装配链（生产环境等价物是控制面 + storcon 替代 CLI）：

```
neon_local::main（control_plane/src/bin/neon_local.rs:752）
├─ RepoLock: flock(".neon") 串行化 CLI 并发
├─ LocalEnv::init（local_env.rs:865）: 写 .neon/config、JWT 密钥对、各服务配置
├─ handle_start_all_impl（:1920）: tokio JoinSet 并发拉起
│   ├─ storage_controller（先起，其余服务向它自注册）
│   ├─ broker → pageserver×N → safekeeper×N（线程池并行）
│   └─ neon_start_status_check（:1992）: 轮询 storcon node_list 直到全部 Active
├─ pageserver 启动（src/bin/pageserver.rs:main）
│   ├─ config 加载 → virtual_file/page_cache 全局初始化（:208/:219）
│   ├─ delete_local_timeline_instantiation → attach 远端租户（generation 由 storcon 签发）
│   └─ Tenant::activate → launch_wal_receiver（订阅 broker 选 SK）
└─ compute 启动（compute_tools/src/bin/compute_ctl.rs）
    ├─ get_config: 控制面拉 ComputeSpec（或本地 config.json）
    ├─ start_compute（compute.rs:793）: HTTP server(3080/3081) → wait_spec
    ├─ prepare_pgdata: sync_safekeepers（quorum 确认）→ basebackup 拉数据目录
    ├─ start_postgres（:1789）: cgroup 内 spawn postgres
    └─ spec_apply: apply_spec_sql 阶段化建角色/库/扩展 → Running
```

配置优先级：CLI 参数 > 服务 TOML > 环境变量 > 编译默认值；compute 侧则是 ComputeSpec（控制面唯一真源）覆盖本地 postgresql.conf 追加项。

### 核心运行流程

三条最重要的链路：**写入**（INSERT 的共识与物化）、**读取**（buffer miss 的页面服务）、**放置变更**（节点宕机后的 failover）。前两条是数据面，第三条体现控制面如何让前两条对拓扑变化无感。

#### 数据面 · 写入：INSERT → WAL 共识 → 异步物化

业务流程：psql INSERT → PG 生成 WAL → walproposer 广播给 3 个 safekeeper → quorum fdatasync → commit 返回 → pageserver 从 safekeeper 拉 WAL 解码进 layer → 上传 S3。

![写路径数据流](/vibe-reading/images/articles/neon-codewiki-main-2026-08/data-flow.svg)

文字解读：commit 只等 quorum fdatasync（3 副本取 2，攒批 1s 一刷），pageserver 完全不在等待路径上——这是存算分离后写入可用性的根基。物化段 pageserver 经 `walreceiver` 选最超前的 safekeeper 拉 interpreted WAL（解码 + 按 shard 过滤 + 预序列化 KV，`send_interpreted_wal.rs`），`walingest` 把记录批量写进 `InMemoryLayer`，攒够 `checkpoint_distance`（默认 256MB）freeze 成 L0 delta layer 落盘，再经 `UploadQueue` 上传并推进 `remote_consistent_lsn`。安全阀是三段背压：compute 侧 `backpressure_throttling_impl` 按 pageserver feedback 减速写入、flush loop 在 L0 堆积时 stall、WAL GC 底界取三个 LSN 的 min。

#### 数据面 · 读取：buffer miss → GetPage@LSN → walredo

业务流程：SELECT 触发 buffer miss → smgr_neon 依次试 prefetch 环 / LFC / 网络 → pageserver 攒批 → LayerMap 搜层（含祖先 timeline 递归）→ 有 image 直接返回，否则 walredo 重放 WAL → 8KB 页返回。

![读路径数据流](/vibe-reading/images/articles/neon-codewiki-main-2026-08/read-flow.svg)

文字解读：请求带双 LSN——`request_lsn`（primary 用 latest 防竞态）与 `not_modified_since`（LwLSN 缓存的"该页最后写入位"），pageserver 的 `effective_request_lsn`（`page_service.rs:2240`）据此决定是否免等 WAL。三层查找顺序 image > delta > in-memory：image 层是读放大的"地板"，compaction 的意义就是不断造地板。walredo 用独立 `postgres --wal-redo` 进程（inmem smgr + seccomp 沙箱）重放任意 rmgr 记录——只有真 PG C 代码能正确重放全部 WAL 类型，这是"复用上游"压倒"自研精简"的决策。

#### 控制面 · 故障转移：node 宕机 → reschedule → compute 无感

链路：storcon `Heartbeater` 超时标记 `Offline`（`storage_controller/src/heartbeater.rs`）→ `handle_node_availability_transition`（`service.rs:7980`）把该节点上 observed 置为不可信 → intent 降级、`Scheduler` 重选健康节点 → `Reconciler` 以新 generation attach（旧节点残骸的写/删会因 generation 过期被拒）→ `compute_hook` 通知 compute 切换连接串。整个过程对 SQL 会话只是一次网络重连，租户数据不搬家（S3 是真源，attach 只是换一个缓存节点）。

### 状态流

Neon 的关键状态机有两类，代码与转换方法都集中、清晰：

- **TenantState（租户放置生命周期）**：`Attaching → Activating → Active → Stopping → Broken`（`libs/pageserver_api/src/models.rs:60`），经 `watch::Sender` 广播，后台任务用 `wait_for_active_tenant` 挂起等待。
- **SafeKeeper 共识纪元**：walproposer 侧 `SS_OFFLINE → SS_CONNECTING → SS_HANDSHAKE → SS_VOTING → SS_WAIT_ELECTED → SS_ACTIVE`（`pgxn/neon/walproposer.h`）；safekeeper 侧每 timeline 是 `Loaded(SafeKeeper) / Offloaded / Empty` 磁盘驻留三态（`safekeeper/src/timeline.rs:147`），冷时间线可整体下盘（`timeline_eviction`）。
- **layer 生命周期**：open in-memory → frozen → on-disk L0 → （compaction）L1/image → 被引用计数归零后 GC → 对象删除过 DeletionQueue 三段流水线。三大状态机彼此以 LSN/generation 对齐，构成系统的"时钟"。

---

## 典型修改场景

#### 场景 1：给 pageserver 新增一种后台任务

改 `pageserver/src/tenant/tasks.rs`（任务清单与并发信号量）+ `TenantShard::activate` 里的启动调用；被 `CONCURRENT_BACKGROUND_TASKS` 信号量约束、注册进 `task_mgr`。参考 `gc_loop` / `compaction_loop` 的写法，休眠用 `sleep_random` 防惊群。对应测试：`test_runner/regress/test_tenant_tasks.py`。

#### 场景 2：给 proxy 新增一种认证方式

改 `proxy/src/auth/backend/classic.rs::authenticate`（分支）→ `compute/mod.rs::AuthInfo` + `libs/proxy/tokio-postgres2/src/config.rs::AuthKeys`（compute 侧凭据变体）→ http 路径补 `PoolingBackend::authenticate_with_*`。console 侧协议字段在 `control_plane/messages.rs`。对应测试：`test_runner/regress/test_auth.py`。

#### 场景 3：给 storcon 新增一种租户编排操作

`storage_controller/src/http.rs::make_router` 加路由 → `Service` 新方法（先取 `tenant_op_locks` 排它锁）→ `tenant_shard.rs` 修改 intent + `sequence.next()` → `maybe_reconcile_shard` 触发收敛。**不需要手写执行逻辑**——reconcile 循环会自动补齐 intent 与 observed 的差。对应测试：`test_runner/regress/test_storage_controller.py`。

---

## 测试体系

```
test_runner/
├── fixtures/           # NeonEnv/Endpoint/PageserverHttpClient 等 pytest 夹具
├── regress/            # 151 个端到端回归（582 个测试函数）
├── performance/       # 38 个性能场景（含 vanilla PG 同机对照）
├── sql_regress/ cloud_regress/  # pg_regress 语法式 / 云实例回归
├── random_ops/         # 公共 API 模糊测试（RANDOM_SEED 可复现）
└── pg_clients/         # 9 种语言驱动连通性
```

| 组件 | 测试类型 |
| --- | --- |
| pageserver/safekeeper/storcon 行为 | regress E2E（真实二进制全链路） |
| safekeeper 共识 | desim 确定性模拟（跑真 C walproposer，`walproposer_sim`） |
| proxy 协议/认证 | regress + pg_clients |
| 性能回归 | performance/（vanilla 对照 + 基线入库 Grafana） |

测试与代码的对应关系上，`test_runner/fixtures/neon_fixtures.py` 的 `NeonEnvBuilder` 是全仓库 degree 最高的对象（graphify 统计 644 条边）——测试即架构文档，读它就能看到全部服务的装配关系。`allowed_errors` 白名单 + teardown `assert_no_errors()` 把"日志埋雷"也纳入失败判定，这是该测试体系最值得借鉴的一招。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `docs/sourcetree.md`（官方目录导读）→ `docs/pageserver.md` → `pageserver/src/bin/pageserver.rs::main`（服务装配）→ `pageserver/src/page_service.rs::handle_pagerequests`（读请求入口）→ `pageserver/src/tenant/timeline.rs::get_vectored`（存储引擎心脏）
- **第二遍：理解共识与写路径**
  `docs/safekeeper-protocol.md` → `safekeeper/src/safekeeper.rs::process_msg`（六种消息的分发中枢）→ `pgxn/neon/walproposer.c::WalProposerPoll`（C 侧状态机）→ `pageserver/src/walingest.rs::ingest_record`
- **第三遍：理解控制面**
  `docs/storage_controller.md` → `storage_controller/src/tenant_shard.rs`（intent/observed 模型）→ `storage_controller/src/reconciler.rs::reconcile` → `storage_controller/src/service.rs::handle_node_availability_transition`
- **第四遍：选择重点模块深入**
  按需读各模块文档（见模块地图），Walredo 沙箱、interpreted WAL、DeletionQueue、Proxy 认证细节都在模块篇里展开。

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| Timeline | Neon 的时间线（= 用户看到的"分支"），与 PG WAL timeline 无关 |
| Layer | 不可变数据文件；delta 存 (key,LSN) 增量记录，image 存某 LSN 全页快照 |
| L0 / L1 | L0 覆盖全 keyspace（WAL flush 产物），L1 是 compaction 后按 keyspace 切分的层 |
| VCL / CommitLSN / FlushLSN | safekeeper 协议三个关键位点：可保证完整的最大 LSN / quorum 确认位点 / 本机落盘位点 |
| LwLSN | compute 侧 per-page "最后写入 LSN" 缓存，读请求的 not_modified_since 来源 |
| LFC | Local File Cache，compute 本地的 pageserver 页二级缓存 |
| interpreted WAL | safekeeper 解码 WAL 后按 shard 过滤、预序列化 KV 的推送格式 |
| basebackup | pageserver 从 KV 树合成 compute 启动目录（与 pg_basebackup 无关） |
| storcon | Storage Controller 的简称，存储集群编排器 |
| generation | 每次 attach 单调 +1 的代数号，隔离新旧 pageserver 的远端写入 |
| HCC / Hadron | 本基线 safekeeper 侧第三方部署变体补丁的标记（`BEGIN_HADRON`） |

### 参考资料

- [Neon 官方文档](https://neon.com/docs)（用户视角）与仓库 `docs/`（开发者视角，SUMMARY.md 为索引）
- RFC 目录 `docs/rfcs/`：025-generation-numbers、031-sharding 等设计提案
- `safekeeper/spec/`：共识协议 TLA+ 规约与验证
- 相关博文：PolarDB 存算分离架构（同为 PG 系，可对照阅读）

