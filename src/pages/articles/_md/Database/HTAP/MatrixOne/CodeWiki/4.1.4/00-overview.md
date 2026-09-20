---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "Overview"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "HTAP", "分布式数据库", "向量检索"]
description: "MatrixOne v4.1.4 源码解读概览：CN/TN/Log 三服务云原生 HTAP 数据库，Git for Data 版本控制 + AI 原生检索，约 110 万行 Go。"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v4.1.4（2026-07-21） · **协议** Apache-2.0 · **语言** Go ≥ 1.26 · **代码量** ~110 万行非测试 Go（含 ~20 万行 protobuf 生成代码） · **仓库** [GitHub](https://github.com/matrixorigin/matrixone)

---

## 总览

### 项目简介

MatrixOne 自称"业界第一个把 Git 式版本控制带到数据上的数据库"。去掉营销话术，它的技术内核是一个**云原生 HTAP 数据库**：单套系统同时承载 OLTP 事务、OLAP 分析、全文检索与向量检索，MySQL 协议兼容，存算分离，可直接替换"MySQL + ClickHouse + Elasticsearch + Pinecone"多库组合。

架构上是经典的三服务分离：**CN（Compute Node）** 无状态计算节点负责协议、优化与向量化执行，并缓存热数据；**TN（Transaction Node，代码里叫 DN）** 承载 TAE 存储引擎与事务协调；**LogService** 基于 multi-raft 提供共享 WAL，其 0 号 shard 内嵌 **HAKeeper** 做集群元数据与调度。数据最终以不可变列存对象落 S3，本地盘只做缓存。

v4 的招牌特性 **Git for Data**（快照 / 分支 / 合并 / 回滚）由两条腿支撑：`pkg/publication/` 的 CCPR（Cross-Cluster Publication Replication）对象级差量复制，与 `pkg/frontend/` 的 data branch 命令族（DAG + LCA + 分片哈希对比）。AI 原生能力由 `pkg/vectorindex/`（IVF-Flat / IVF-PQ / HNSW / CAGRA，含 GPU cuVS 路径）与 `pkg/fulltext/`（jieba 分词 + BM25）提供，均以 `indexplugin` 插件契约接入优化器。

**项目边界**：MatrixOne 负责单集群内的 HTAP + 检索 + 数据版本控制；跨集群 CDC 同步（`pkg/cdc/`、`pkg/datasync/`）与多集群全局元数据不在核心范围内。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| MySQL 协议兼容 | `pkg/frontend/mysql_protocol.go` | 自研协议栈（goetty 替代），prepared statement 改写为文本 SQL |
| SQL 代理 / 连接迁移 | `pkg/proxy/` | salt 中继透明认证，connCache 复用后端连接 |
| 分布式事务（SI） | `pkg/txn/` | HLC 时钟 + Clock-SI，1PC/2PC 混合 |
| 悲观锁 | `pkg/lockservice/` | 分片锁表 + allocator 迁移 + 集中式死锁检测 |
| 列存对象 + MVCC | `pkg/vm/engine/tae/` | append-only 段 + tombstone，logtail 推送 |
| CN 缓存引擎 | `pkg/vm/engine/disttae/` | workspace 内存写 + logtail 增量订阅 |
| 向量检索 | `pkg/vectorindex/` + `pkg/sql/plan/apply_indices_*.go` | IVF/HNSW/CAGRA，usearch mmap 与 GPU cuVS |
| 全文检索 | `pkg/fulltext/` + `pkg/monlp/tokenizer/` | jieba 分词，BM25 打分，倒排隐藏表 |
| Git for Data | `pkg/publication/` + `pkg/frontend/data_branch*.go` | CCPR 对象级差量复制 + 分支 DAG |
| 共享 WAL + 调度 | `pkg/logservice/` + `pkg/hakeeper/` | dragonboat multi-raft，HAKeeper 心跳黑盒调度 |
| 多级缓存文件层 | `pkg/fileservice/` + `pkg/objectio/` | IOVector 批量 IO，mem→disk→remote 级联缓存 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Go ≥ 1.26 | 语言 | 全库实现语言（`go.mod` 声明 1.26.4） |
| dragonboat v4（matrixorigin fork） | 核心 | LogService 的 multi-raft 复制库（`go.mod` replace 指向 fork） |
| usearch（unum-cloud） | 核心 | HNSW 向量索引的 C++ 引擎（`pkg/vectorindex/hnsw`） |
| gojieba | 核心 | 中文分词（`pkg/monlp/tokenizer`） |
| cuVS（NVIDIA，cgo） | 可选 | GPU 向量索引（`//go:build gpu` 编译标签） |
| morpc（matrixorigin） | 核心 | 全部跨进程 RPC（txn / logtail / remoterun / 锁） |
| ants | 核心 | goroutine 池（scope 并行、logtail 收集） |
| goyacc | 构建 | MySQL 方言语法表 `mysql_sql.y`（14.5k 行）生成解析器 |
| protobuf | 核心 | plan / pipeline / txn 等 pb 定义（`pkg/pb/` ~20 万行生成代码） |

### 版本历史

| 版本 | 日期 | 里程碑 |
| --- | --- | --- |
| v1.0.0 | 2023-11 | 首个 GA：TAE 引擎定型（RFC `docs/rfcs/20220503_tae_design.md`） |
| v2.0.0 | 2024-10 | 存算分离架构成熟，S3 为主存储 |
| v3.0.0 | 2025-08 | AI 原生检索（向量/全文索引）体系化 |
| v4.0.0 | 2026 上半年 | Git for Data：Publication/分支/合并 |
| v4.1.4 | 2026-07-21 | 本次解读基线：CCPR 稳定化 + CTAS 引号别名修复 |

## 快速上手

最简路径（Docker，60 秒）：

```bash title="快速启动"
docker run -d -p 6001:6001 --name matrixone matrixorigin/matrixone:latest
mysql -h127.0.0.1 -P6001 -uroot -p111 -e "create database demo; use demo; \
  create table t(a int primary key, b vecf32(4)); \
  insert into t values (1, '[0.1,0.2,0.3,0.4]'); \
  select a, l2_distance(b, '[0.1,0.2,0.3,0.4]') from t;"
```

源码构建（开发者视角）：

```bash title="源码构建"
git clone https://github.com/matrixorigin/matrixone.git && cd matrixone
make build          # 产出 mo-service 二进制
./mo-service -launch ./etc/launch/launch.toml   # 单机拉起 Log + TN + CN 三服务
mysql -h127.0.0.1 -P6001 -uroot -p111 -e "select version()"   # 预期返回 8.0.30-MatrixOne
```

`launch.toml` 把 `log.toml`、`tn.toml`、`cn.toml` 三个服务配置交给同一个 `mo-service` 进程分别拉起——单机二进制即完整集群，这是理解三服务架构的最小实验场。本地多 CN 开发用 `make dev-build && make dev-up`（见 `etc/DEV_README.md`）。

## 架构设计解析

### 系统架构

![MatrixOne 分层架构](/vibe-reading/images/articles/matrixone-internals/architecture.svg)

设计主线是**"计算无状态、存储不可变、一致性外包给 raft"**：CN 不落任何持久状态（workspace 是内存、索引缓存带 TTL、元数据靠订阅 logtail 重建），因此 CN 可以随意扩缩容；TN 上的 TAE 把数据写成 append-only 的 S3 不可变对象，删除走 tombstone，靠后台 merge 物理回收——这匹配 S3 的对象模型，也让快照（Git for Data）天然零拷贝；所有需要多数派保证的状态（WAL、HAKeeper 元数据、TSO）都压进 LogService 的 multi-raft。

读路径的关键决策是 **logtail 推送 + CN 缓存**：CN 首次读某表时向 TN 订阅（Subscribe 回放 checkpoint + 增量），此后 TN 在事务提交流水线内把变更推给所有订阅 CN——CN 读已提交数据不再走跨节点 RPC，HTAP 的分析查询命中缓存时接近本地内存数据库的速度。写路径则是 **CN workspace 内存缓冲**：未提交数据留在 CN 内存（超阈值溢写 S3），提交时整包 ship 给 TN 走 1PC/2PC。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 接入层 | `pkg/frontend/`、`pkg/proxy/` | 隔离 MySQL 协议与会话语义，保护执行内核不受协议细节污染 |
| SQL 层 | `pkg/sql/parsers/`、`pkg/sql/plan/` | 把文本翻译成可优化的中间表示，所有语义决策在此定型 |
| 执行层 | `pkg/sql/compile/`、`pkg/sql/colexec/`、`pkg/vm/` | 把计划编译成并行执行图，向量化吞吐的唯一现场 |
| CN 数据面 | `pkg/vm/engine/disttae/`、`pkg/vectorindex/`、`pkg/fulltext/`、`pkg/publication/` | CN 上的"准存储"：缓存、检索索引、数据版本复制的所在地 |
| 事务与一致性层 | `pkg/txn/`、`pkg/lockservice/` | 跨节点正确性的守门人：隔离级别、提交排序、悲观锁 |
| 存储与日志层 | `pkg/vm/engine/tae/`、`pkg/logservice/`、`pkg/fileservice/`、`pkg/objectio/` | 持久化真相的唯一来源：MVCC、WAL、对象格式与缓存 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 插件注册表 | `pkg/indexplugin/plugin.go` 的 `Register/Get` | 向量/全文索引算法（5 种）各自演进，单一真源消除硬编码 switch 的算法 drift |
| 模板方法（Go 内嵌自委托） | `pkg/sql/plan/base_binder.go:71` 的 `b.impl.BindExpr` | binder 家族（14 个子类）共享绑定骨架，子类只覆写差异方法 |
| 状态机 | `pkg/frontend/cdc_state_machine.go:129` 的 `initTransitions` | CDC executor 生命周期 9 态显式转移表，长任务可暂停/恢复 |
| RPC 消息驱动 | `pkg/tnservice/store_rpc_handler.go:35` 按 `TxnMethod` 注册 | 事务协议（1PC/2PC/Rollback）全部异步消息化，天然支持重试与超时 |
| 装饰器链 | `pkg/fileservice/s3_fs.go` 的 semaphore/metrics/trace 三层包裹 ObjectStorage | 多云后端复用同一套并发控制与观测逻辑 |
| CoW 快照 | `pkg/vm/engine/disttae/logtailreplay/partition.go:125` 的 `Snapshot/MutateState` | 事务读不加锁，logtail 后台应用在新版本上 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Compile` / `Scope` | 一次查询的编译产物与执行子图（`pkg/sql/compile/types.go`） | 单条 SQL | Scope 树含 `RootOp` 算子树与 `DataSource` |
| `Transaction`（disttae） | CN 侧事务 workspace，`writes []Entry` 内存缓冲（`disttae/types.go:354`） | 单事务 | 挂在 `txnOperator` 上，commit 时打包 ship TN |
| `PartitionState` | 某表的 logtail 缓存快照（`logtailreplay/partition_state.go`） | 表级长驻 | CoW 不可变，被 `LocalDisttaeDataSource` 消费 |
| `TxnOperator` | 事务操作句柄（`pkg/txn/client/operator.go`） | 单事务 | 聚合 workspace、锁表 bind、时钟 |
| `DB`（TAE） | TN 引擎实例：TxnMgr + Catalog + LogtailMgr + checkpoint（`tae/db/db.go:86`） | TN 进程级 | 装配 `Handle` RPC 入口 |
| `IOVector` | 一次批量 IO 的描述（`pkg/fileservice/io_vector.go`） | 单次读写 | entries 级联缓存短路 |
| `IterationContext` | CCPR 一轮差量复制的全上下文（`pkg/publication/types.go`） | 单轮 iteration | 持有快照 TS、AObjectMap、水位 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `vm.Operator` | `pkg/vm/types.go:210` | 60+ 算子（hashjoin/group/insert/…） | `OpType` 枚举 + `constructXxx` 工厂（`compile/operator.go`） |
| `engine.Engine` / `engine.Relation` / `engine.Reader` | `pkg/vm/engine/engine.go` | disttae（主）/ memoryengine | CN 服务装配时注入 |
| `client.Workspace` | `pkg/txn/client/types.go` | disttae `Transaction` | `txnOperator.AddWorkspace` |
| `storage.TxnStorage` | `pkg/txn/storage/types.go` | TAE 适配器（`storage/tae/`） | TN 装配（`pkg/tnservice/factory.go`） |
| `AlgoPlugin` | `pkg/indexplugin/plugin.go` | fulltext/hnsw/ivfflat/cagra/ivfpq | init() 注册 + `all.go` blank import |
| `FileService` | `pkg/fileservice/file_service.go` | S3FS / LocalFS / MemoryFS | 配置驱动（`cmd/mo-service/config.go`） |
| `LockService` / `LockTableAllocator` | `pkg/lockservice/types.go:95/188` | CN 侧 service / TN 侧 allocator | HAKeeper 心跳路由 |

## 代码目录

```shell
matrixone/
├── cmd/
│   └── mo-service/          # 唯一服务入口（main.go 分派 CN/TN/Log/Proxy）
├── pkg/
│   ├── frontend/            # MySQL 协议 · 会话 · 鉴权 · data branch 命令（~7.5 万行）
│   ├── proxy/               # SQL 代理（~7.5k 行）
│   ├── sql/
│   │   ├── parsers/         # 词法/语法 → AST（~6 万行，goyacc）
│   │   ├── plan/            # bind + 改写优化（~15.7 万行）
│   │   ├── compile/         # Plan → Scope（~2.6 万行）
│   │   └── colexec/         # 向量化算子（~7.3 万行）
│   ├── vm/
│   │   ├── engine/
│   │   │   ├── disttae/     # CN 引擎：workspace + logtail 缓存（~3.6 万行）
│   │   │   └── tae/         # TN 引擎：MVCC + checkpoint + merge（~9.3 万行）
│   │   ├── pipeline/        # pipeline 框架
│   │   ├── process/         # 执行上下文（mpool 注入点）
│   │   └── message/         # 跨算子/跨 CN 消息
│   ├── txn/                 # txn client/service/rpc（~1.9 万行）
│   ├── lockservice/         # 分布式锁（~1.1 万行）
│   ├── logservice/          # multi-raft WAL（~8.6k 行）
│   ├── hakeeper/            # 集群调度 checker（~5.8k 行）
│   ├── fileservice/         # 文件抽象 + 多级缓存（~1.76 万行）
│   ├── objectio/            # S3 对象格式层（~1.2 万行）
│   ├── container/           # Vector/Batch/Type（~2.6 万行）
│   ├── vectorindex/         # IVF/HNSW/GPU 向量索引（~1.9 万行）
│   ├── fulltext/ + monlp/   # 全文检索 + 分词器
│   ├── publication/         # CCPR 差量复制（~1.3 万行）
│   ├── pb/                  # protobuf 生成代码（~20 万行，不手改）
│   └── cdc/ · datasync/     # 跨集群同步
├── test/distributed/cases/  # 端到端 SQL 用例（按特性分目录）
├── etc/launch/              # 三服务启动配置
└── docs/rfcs/               # 设计文档（含 TAE 设计 RFC）
```

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/matrixone-internals/module-dependencies.svg)

依赖总方向自上而下：frontend 触发一切；SQL 层产出 pb Plan；执行层消费 Plan 并向 disttae 要 Reader；disttae 经 txn client 提交、经 logtail 订阅从 TAE 拉增量；TAE 落盘依赖 LogService（WAL）与 fileservice（S3）。横向的特殊边有两条：plan ↔ AI 检索的 indexplugin 契约（改写期）、publication ↔ TAE 的快照/GC 保护（复制期）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 前端协议层 | MySQL 协议、会话、鉴权、语句分发 | `Routine.handleRequest` | 协议兼容是独立演化面（MySQL 8.0 语义全集） | [前端协议层](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/01-frontend) |
| SQL 解析与查询计划 | AST → 逻辑计划 → 改写优化 | `plan.BuildPlan` | 语义与优化决策需独立于执行演进 | [SQL 解析与查询计划](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/02-sql-plan) |
| 向量化执行引擎 | Scope 编译 + push 算子 + 跨 CN 执行 | `Compile.Run` | 吞吐与并行度是独立性能域 | [向量化执行引擎](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/03-execution-engine) |
| DistTAE 引擎 | CN workspace + logtail 缓存 | `Engine.New` | CN 数据面与 TN 存储面解耦的枢纽 | [DistTAE 引擎](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/04-disttae) |
| TAE 存储引擎 | MVCC、logtail 服务、checkpoint | `db.Open` | 持久化正确性与 GC 的唯一现场 | [TAE 存储引擎](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/05-tae) |
| 事务与锁服务 | SI 事务协调 + 分布式悲观锁 | `txnClient.New` / `LockService.Lock` | 跨节点一致性独立于存储与计算 | [事务与锁服务](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/06-txn-lockservice) |
| LogService 与 HAKeeper | multi-raft WAL + 集群调度 | `logservice.NewService` | 复制与调度是全部状态的底座 | [LogService 与 HAKeeper](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/07-logservice-hakeeper) |
| FileService 与 ObjectIO | 对象格式 + 多级缓存 + 多云 | `NewS3FS` | IO 性能与后端无关性独立演化 | [FileService 与 ObjectIO](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/08-fileservice-objectio) |
| AI 原生检索 | 向量索引 + 全文检索 + 增量同步 | `indexplugin.Get` | 算法集合高频迭代，插件化隔离 | [AI 原生检索](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/09-ai-index) |
| Publication 与 Git for Data | CCPR 差量复制 + 数据分支 | `ExecuteIteration` | v4 招牌特性，横跨 frontend/TAE/taskservice | [Publication 与 Git for Data](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/10-publication-git4data) |
| 容器与内存管理 | Vector/Batch/mpool 向量化地基 | `vector.NewVec` | 全库共享的数据结构契约 | [容器与内存管理](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/11-container-mpool) |

模块间的动态调用顺序见下文「核心运行流程」各链路。

## 运行时行为

### 启动流程

`mo-service` 是唯一二进制，按配置里的服务类型分派（`cmd/mo-service/main.go:206` `startService`）：

```text
main() → 解析 flag / 配置（config.go）
  → setupServiceRuntime（logutil · runtime 注入）
  → 按 ServiceType 分派：
     CN  → startCNService（main.go:281）  → cnservice.New（装配 frontend MOServer、compile、disttae、lockservice、taskservice executor 注册）
     TN  → startTNService（main.go:329）  → tnservice.New（装配 TAE storage、txn service、LogTailServer、LockTableAllocator）
     Log → startLogService（main.go:366） → logservice.NewService（dragonboat NodeHost + HAKeeper 0 号 shard）
     Proxy → startProxyService（main.go:422）
  → 各服务向 HAKeeper 发心跳（如 tnservice/store_heartbeat.go:61）
  → HAKeeper 检出集群 bootstrap 后下发命令（AddReplica 等，心跳响应携带）
```

对象装配的关键点：**FileService 先于一切**（所有服务共享 S3/Disk 配置，`cfg.createFileService`）；**disttae Engine 是 CN 进程级单例**，持 txn client 与 partitions map；**TAE 的 DB 由 `Controller.AssembleDB`（`tae/db/controller.go:602`）装配**，先 `replayFromCheckpoints` 再 `ReplayWal` 双段恢复；锁表 allocator 挂在 TN（`tnservice/store.go:414`），CN 的 lockservice 等 HAKeeper 就绪后才启动（`WithWait`）。

### 核心运行流程

三条主链路覆盖了 MatrixOne 的核心运行模式：读（缓存命中与未命中）、写（事务提交与反哺）、发布（Git for Data 差量复制）。模块间的动态调用顺序在此展开。

#### 查询：SELECT 端到端读路径

业务流程：客户端发 COM_QUERY → 协议解析分发 → 计划构建 → 编译执行 → 三路合并读 → 流式回包。

![端到端数据流](/vibe-reading/images/articles/matrixone-internals/data-flow.svg)

数据形态依次演变为 MySQL packet → `tree.Statement`（AST）→ `pb.plan.Plan`（protobuf）→ `[]*Scope`（执行子图）→ `batch.Batch`（列式批）→ MySQL row packet。关键设计：CN 不向 TN 逐行拉数——表首次被读时 `PushClient.toSubscribeTable`（`disttae/logtail_consumer.go:457`）发订阅 RPC，TN `HandleSyncLogTailReq` 返回 checkpoint 位置 + 增量 entry，CN 建成 `PartitionState` 缓存；此后读已提交数据全在 CN 本地完成，`LocalDisttaeDataSource.Next`（`local_disttae_datasource.go:380`）合并 workspace、PartitionState、S3 对象三路。执行层细节见[向量化执行引擎](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/03-execution-engine)。

#### 事务：INSERT / UPDATE 写路径

写与读共用前半段（协议 → plan → colexec insert 算子），分岔在数据落点：insert 算子把 batch 追加进 `Transaction.writes`（`disttae/txn.go:88` `WriteBatch`），超 `writeWorkspaceThreshold` 时 `dumpBatchLocked` 溢写 S3。提交时 `txnOperator.Commit`（`pkg/txn/client/operator.go:847`）驱动 `workspace.Commit` → `genWriteReqs` 生成 `TxnRequest[]` 发往 TN：单 TNShard 走 1PC 快路径，多 shard 并行 Prepare 后异步 CommitTNShard。TN 侧 TAE 经 TxnManager 流水线写 WAL（LogService raft），并在提交流水线内发布 logtail 推回各订阅 CN——写路径的终点反哺读路径的缓存（见上图黄色回环）。

#### 版本控制：Publication 差量复制

业务流程：订阅建立 → 后台 executor 双 ticker 驱动 → 每轮 iteration 打快照 → 对象级差量 → 两阶段 ApplyObjects → 推进 LSN。

```text
mo_ccpr_log（状态表） → PublicationTaskExecutor.run（executor.go:341，CAS 单飞）
  → ExecuteIteration（iteration.go:1114）
     ① RequestUpstreamSnapshot（快照滚动保留 2 个）
     ② ProcessDDLChanges（表级 diff → ALTER）
     ③ GetObjectListMap（两快照 OBJECTLIST 对象差量，未变对象零拷贝）
     ④ RegisterSyncProtection（bloom 注册上游 GC 保护）
     ⑤ ApplyObjects（先 DATA 后 TOMBSTONE；aobj 过滤行并重写 rowid）
     ⑥ UpdateIterationState（成功 LSN+1，失败幂等重试）
```

对象级差量把复制代价从 O(数据量) 降到 O(对象元数据)，是"毫秒级快照 + 分支"的性能根基。详见[Publication 与 Git for Data](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/10-publication-git4data)。

### 状态流

![运行时状态机](/vibe-reading/images/articles/matrixone-internals/state-flow.svg)

左：logtail 表订阅状态机（`logtail_consumer.go` 的 `PushClient`）——`Unsubscribed → Subscribing → SubRspReceived → Subscribed` 四态，`Subscribed` 后常驻 goroutine 持续消费增量；长时间未使用的表被 `doGCUnusedTable` 回收回初始态。右：CCPR iteration 状态（`mo_ccpr_log` 双状态字段）——`pending → running → complete/error` 循环，失败轮不推 LSN 保证幂等。事务生命周期状态机见[事务与锁服务](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/06-txn-lockservice)。

## 典型修改场景

#### 场景 1：新增一个向量化算子

- `pkg/sql/colexec/<name>/` 实现 `vm.Operator` 接口（参照 `hashjoin/types.go` 的 `NewArgument`）
- `pkg/vm/types.go` 的 `OpType` 枚举注册
- `pkg/sql/compile/operator.go` 加 `constructXxx` 工厂；`compile.go` `compilePlanScope` switch 加 case
- 需跨 CN 执行时补 `remoterun.go` 的 `convertToPipelineInstruction` / `convertToVmOperator` 编解码

对应测试：`pkg/sql/colexec/<name>/*_test.go` + `test/distributed/cases/`。

#### 场景 2：新增一种数据类型

- `pkg/container/types/types.go` 加 `T` 枚举 + `TypeSize/ToType`
- `pkg/container/vector/vector.go` 的 `GetUnionAllFunction` / `AppendAny` / `RowToString` 三处巨型 switch（vector.go:1374/3384/3241）
- `versions.go` 序列化版本 + plan/function 层注册 + parsers 字面量
对应测试：`test/distributed/cases/dtype/`。

#### 场景 3：新增一种向量索引算法

按 `pkg/indexplugin/all/all.go` 注释的 5 步模板：`pkg/catalog` 加 `MoIndex<Foo>Algo` → 拷 `pkg/vectorindex/ivfpq/plugin/` 实现四组 Hooks → `pkg/sql/plan/apply_indices_<foo>.go` 写改写 → `all.go`（GPU 则 `all_gpu.go`）blank import → `test/distributed/cases/vector/` 加用例。

## 测试体系

```shell
test/distributed/cases/     # 端到端 SQL 用例（按特性分目录：ddl/dml/fulltext/vector/git4data/…）
pkg/**/*_test.go            # 单元测试（1298 个文件，与源码同目录）
pkg/tests/                  # 服务级集成测试（拉起多进程集群的框架）
```

| 代码层 | 测试类型 | 位置示例 |
| --- | --- | --- |
| container / vectorize / plan | 单元测试 | `pkg/container/vector/vector_test.go`、`pkg/sql/plan/*_test.go` |
| colexec 算子 | 算子级单测 + 分布式用例 | `pkg/sql/colexec/hashjoin/`、`test/distributed/cases/expression/` |
| disttae / tae | 引擎级集成 | `pkg/vm/engine/disttae/*_test.go`、`pkg/vm/engine/tae/` |
| 全链路 | 端到端 SQL | `test/distributed/cases/git4data/` |

理解某个模块优先读它同目录的 `_test.go`——尤其 `pkg/sql/plan/` 下按特性命名的测试（如 `apply_indices_hnsw_test.go`）是行为的可执行文档。

## 阅读源码推荐路线

- 第一遍：主流程
  `cmd/mo-service/main.go` 的 `startService` → `pkg/frontend/routine.go` 的 `Routine.handleRequest` → `pkg/frontend/mysql_cmd_executor.go` 的 `ExecRequest` / `doComQuery` → `pkg/sql/plan/build.go` 的 `BuildPlan` → `pkg/sql/compile/compile2.go` 的 `Compile.Run`
- 第二遍：核心数据结构
  `pkg/container/vector/vector.go`（先读 `class`/`ToSlice`/`Free`）→ `pkg/container/batch/batch.go` → `pkg/common/mpool/mpool.go` 的 `Alloc/freePtr` → `pkg/pb/plan/plan.pb.go` 只看注释与消息名（勿通读）
- 第三遍：两条引擎路径
  读路径：`pkg/vm/engine/disttae/txn_table.go` 的 `Ranges/doRanges/BuildReaders` → `local_disttae_datasource.go` 的 `Next`；写路径：`disttae/txn.go` 的 `WriteBatch/Commit` → `pkg/txn/client/operator.go` 的 `Commit` → `pkg/vm/engine/tae/db/` 的 TxnManager 流水线
- 第四遍：选专题深入（模块文档）
  一致性读 [事务与锁服务](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/06-txn-lockservice)；AI 检索读 [AI 原生检索](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/09-ai-index)；v4 特性读 [Publication 与 Git for Data](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/10-publication-git4data)

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| CN / TN（DN） | Compute Node / Transaction Node，计算与事务存储服务；代码中 DN 与 TN 同义 |
| TAE | Transactional Analytical Engine，TN 上的 MVCC 列存引擎（RFC 20220503） |
| DistTAE | CN 侧的 "distributed TAE"——workspace + logtail 缓存组成的 CN 数据面 |
| logtail | TN 向订阅 CN 推送的增量变更流（insert/delete entry + checkpoint 位置） |
| workspace | CN 事务的未提交写缓冲（内存 `writes []Entry`） |
| HAKeeper | LogService 0 号 shard 上的集群元数据与调度器 |
| CCPR | Cross-Cluster Publication Replication，Publication 的代码内名称 |
| aobj / nobj | appendable object（可追加）/ non-appendable object（已冻结） |
| S3 对象 | fileservice 管理的不可变列存文件，objectio 定义内部布局 |
| remoterun | CN 间传输序列化 Scope（执行计划）在远端重建执行的机制 |
