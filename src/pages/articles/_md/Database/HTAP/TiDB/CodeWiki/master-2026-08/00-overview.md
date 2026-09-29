---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "Overview"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "分布式数据库", "HTAP"]
description: "TiDB master 分支 2026-08 快照源码解读概览：分层架构、12 大模块地图、四条核心运行链路与状态机全景"
readingTime: "45 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** master-2026-08 · **解读基线** commit [`17b7807839`](https://github.com/pingcap/tidb/commit/17b780783925eea71af5e2bdd1a0b1c171efc650)（2026-08-20，master 分支快照，无对应 release tag；最新正式版为 v8.5.x LTS 系列，v9.0.0 处于 beta）· **协议** Apache-2.0 · **语言** Go 1.25 · **代码量** ~97 万行（非测试 Go 代码）· **仓库** [GitHub](https://github.com/pingcap/tidb)

---

## 总览

### 项目简介

TiDB（/"taɪdiːbiː/，Ti 即钛）是 PingCAP 开源的**云原生分布式 SQL 数据库**，对外兼容 MySQL 协议与绝大部分 MySQL 语法，对内采用计算存储分离架构：TiDB 本体只做 SQL 解析、优化与执行（无状态计算节点），数据落在 TiKV（行存 + MVCC + Raft）与 TiFlash（列存 + MPP）中，PD 负责全局时钟（TSO）、region 元信息调度与 etcd 元数据中心。它解决的核心问题是：**在保留 SQL 生态兼容性的前提下，把单机 MySQL 的容量与吞吐上限扩展到数百 TB 与水平伸缩**，同时以 TiFlash 列存副本 + MPP 计算提供 HTAP（同库同表的实时分析）能力。

项目边界：本仓库只包含 **TiDB 计算节点（tidb-server）** 及其配套工具（BR 备份恢复、Lightning 物理导入、Dumpling 导出）；TiKV/TiFlash/PD 是独立仓库。但 TiKV 事务协调器（Percolator 2PC 的客户端一侧）、coprocessor 客户端、在线 Schema 变更调度都在 TiDB 侧——读懂 TiDB 才能读懂整个系统的事务与元数据协议。

### 功能矩阵

| 特性 | 实现模块 | 说明 |
| --- | --- | --- |
| MySQL 协议兼容 | `pkg/server` | 握手/认证插件、COM 命令分发、Prepared Statement、压缩流 |
| SQL 解析 | `pkg/parser` | goyacc 生成的 LALR 文法（~723 条规则），独立 go module |
| 查询优化 | `pkg/planner` | RBO + CBO；Volcano 自底向上与 Cascades 双框架并存 |
| 向量化执行 | `pkg/executor` + `pkg/expression` | 火山模型 + Chunk 列式批处理 |
| 计算下推 | `pkg/distsql` + `pkg/store/copr` | TiKV Coprocessor / TiFlash MPP（Exchange 算子） |
| 在线 Schema 变更 | `pkg/ddl` | 异步 job 队列 + etcd owner 选举 + 双状态机 |
| 统计信息 | `pkg/statistics` | 直方图 + TopN、auto-analyze、sync/async 按需加载 |
| 事务 | `pkg/session` + `pkg/store/driver` | Percolator 2PC、乐观/悲观、async commit / 1PC |
| 数据导入 | `pkg/ingestor` + `pkg/dxf` + `lightning/` | SST 物理导入、global sort、分布式任务调度 |
| 备份恢复 | `br/` | KV 层 SST 快照备份、PITR log backup |
| HTAP | `pkg/executor`（MPPGather） | 计划切分为 MPP task 下发 TiFlash |
| 执行计划管理 | `pkg/bindinfo` | SPM（SQL Binding）以 hint 注入强制计划 |
| TTL 行过期 | `pkg/ttl` | 后台 job 定期删除过期行 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Go 1.25 | 语言 | 全部核心代码 |
| goyacc（TiDB fork） | 构建工具 | 由 `parser.y` 生成 `parser.go`（约 2.7 万行生成代码） |
| `github.com/tikv/client-go/v2` | 核心依赖 | TiKV 客户端内核：2PC、RegionCache、RegionRequestSender（2024 年起从 TiDB 仓库外置为独立模块） |
| gRPC | 核心依赖 | TiKV coprocessor / MPP / Raft 通信 |
| etcd client（经 PD） | 核心依赖 | DDL owner 选举、schema version 广播、service safepoint |
| pebble | 导入栈 | Lightning/Ingestor 本地排序引擎（`pkg/ingestor/ingestctrl`） |
| goycsv / pingcap/tipb、kvproto | 协议 | 下推执行计划与 gRPC 协议的 protobuf 定义 |

### 版本历史

TiDB 主干近年最重要的几次架构演进（截至本快照）：

- **v5.x**：Async Commit / 1PC 落地，提交延迟不再受两次 TSO 往返限制。
- **v6.x**：把 TiKV 客户端内核外置为 `tikv/client-go/v2`；TiFlash MPP 模式 GA。
- **v7.x**：`IMPORT INTO` 语句（数据导入进入 SQL 层）；Cascades 优化器框架引入（默认关闭）。
- **v8.x**：DDL job 队列从 etcd 迁到 `mysql.tidb_ddl_job` 系统表（job V2，8.4.0 起）；InfoSchema v2（btree 增量 + 按需加载）；global sort 导入；DXF 分布式任务框架。
- **master（本快照）**：Cascades 重构为多子包（旧实现移入 `cascades/old/`）；planner 引入 `alternativeRounds` 多轮构建按 cost 竞争；Lightning local backend 持续迁入 `pkg/ingestor`；v9.0.0 处于 beta。

---

## 快速上手

最快看到 TiDB 跑起来的方式（本机单机模拟集群）：

```bash
# 1. 安装并启动纯本地的模拟集群（TiUP 内置 playground，含 1 TiKV + 1 PD + 1 TiDB）
tiup playground v8.5.4

# 2. 用任意 MySQL 客户端连接（默认 4000 端口，root 无密码）
mysql --host 127.0.0.1 --port 4000 -u root

-- 3. 端到端验证：建表写入并查询
CREATE TABLE hello (id INT PRIMARY KEY, name VARCHAR(32));
INSERT INTO hello VALUES (1, 'TiDB');
SELECT * FROM hello;
-- 预期输出：1 行 (1, 'TiDB')
```

源码构建（阅读者视角，一条命令验证编译链）：

```bash
make server          # 产出 bin/tidb-server
./bin/tidb-server --store=unistore --path=""   # 内置单机 mockstore，无需 PD/TiKV 即可起服务
```

> `--store=unistore` 使用 `pkg/store/mockstore` 的内嵌存储，是调试 SQL 层最常用的姿势——改一行 planner 代码即可重启验证。

---

## 架构设计解析

### 系统架构

TiDB 的架构设计围绕一个核心矛盾：**多个无状态计算节点共享同一份存储**。由此产生三条主线：一是**计算无状态化**——任何 tidb-server 都能接收任何 SQL，会话状态（`sessionctx.Context`）全靠请求携带的上下文对象传递；二是**元数据多版本化**——schema 是全集群共享且持续变更的，故用不可变多版本 InfoSchema 快照 + etcd 广播版本号保证所有节点看到一致视图；三是**复杂性下推**——能推给存储的（扫描、聚合、JOIN、表达式）都编码成 coprocessor DAG 下推到 TiKV/TiFlash，推不动的才在 TiDB 本地用火山算子执行。

![TiDB 分层架构](/vibe-reading/images/articles/tidb-internals/architecture.svg)

六层职责与依赖方向（上层依赖下层，接入层在最上）：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接入层 | `pkg/server` | 隔离 MySQL wire protocol 细节，保护 SQL 内核不受协议变化影响 |
| 会话事务层 | `pkg/session`、`pkg/sessiontxn`、`pkg/sessionctx`、`pkg/kv` | 承载语句执行编排与事务语义，定义对存储的事务接口契约 |
| SQL 引擎层 | `pkg/parser`、`pkg/planner`、`pkg/expression`、`pkg/executor`、`pkg/distsql` | 从文本到物理计划再到算子执行的全部 SQL 处理逻辑 |
| 元数据调度层 | `pkg/domain`、`pkg/infoschema`、`pkg/meta`、`pkg/ddl`、`pkg/statistics`、`pkg/ttl` | 全集群共享元数据的读写、版本同步与所有后台任务宿主 |
| 存储客户端层 | `pkg/store/driver`、`pkg/store/copr`、`pkg/store/gcworker` | 适配外部存储协议（2PC、Coprocessor、GC），向上只暴露 `kv.*` 接口 |
| 外部系统 | PD、TiKV、TiFlash | 时钟与调度 / 行存 / 列存，独立仓库独立演进 |

一条贯穿全层的依赖注入线索：`pkg/kv` 定义的 `Storage`/`Transaction`/`Retriever` 接口是第 2 层与第 5 层之间的接缝——SQL 引擎只依赖接口，第 5 层的 `driver`（真实 TiKV）与 `mockstore`（单机测试）都实现它，这正是 `--store=unistore` 能工作的原因。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Visitor + Accept | `Accept` in `pkg/parser/ast/dml.go`（每个 AST 节点手写） | 预处理、名字解析、表达式改写都以遍历器实现，Leave 阶段允许替换节点 |
| 状态机 | `SchemaState` in `pkg/meta/model/job.go`、`LazyTxn` in `pkg/session/txn.go`、`regionJob` in `pkg/ingestor/ingestctrl/region_job.go` | 在线变更/事务/导入三处的失败恢复都以"状态回退"而非"整体重试"建模 |
| Owner 单例选举 | `pkg/owner/manager.go`（etcd lease + campaign） | DDL、GC、分布式任务、log backup 等所有"全集群只做一次"的工作共用同一选举机制 |
| 迭代器（火山模型） | `Executor` 接口 in `pkg/executor/internal/exec/executor.go` | pull-based 执行让 Limit/流式/嵌套算子自然组合，Chunk 批处理摊薄虚函数开销 |
| 模板方法 | `baseTxnContextProvider` in `pkg/sessiontxn/isolation/base.go` | 公共事务钩子放基类，四种隔离级别子类只注入取 TS 函数 |
| 注册表 | `funcs` map in `pkg/expression/builtin.go:659`；`optRuleList` in `pkg/planner/core/optimizer.go` | 函数/优化规则可枚举、可插拔 |
| 防腐层（Adapter） | `TiDBContext` in `pkg/server/driver_tidb.go`；`tikvTxn` in `pkg/store/driver/txn/txn_driver.go` | 协议层不直接依赖 session 实现；SQL 层不直接依赖 client-go 类型 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Session`（`pkg/session/session.go:194`） | 一个客户端连接的全部状态：变量、事务、语句上下文 | 连接建立到断开（COM_CHANGE_USER 会重建） | 持有 `store`、`domain`、`LazyTxn` |
| `Chunk`（`pkg/util/chunk/chunk.go:35`） | 列式批处理容器：选择向量 + typed 列 | 单次 Next 迭代，连接级复用 | 全部算子与表达式求值的数据载体 |
| `InfoSchema`（`pkg/infoschema/interface.go:30`） | 某一 schema version 下全库表结构的不可变快照 | 随 version 缓存于 `InfoCache`，旧版本延迟 GC | `domain` 持有缓存；语句经 `GetTxnInfoSchema` 消费 |
| `Job`（`pkg/meta/model/job.go:353`） | 一条 DDL 的持久化任务：状态、schema 状态、reorg 进度 | 提交到 `tidb_ddl_job`，完成归档 `tidb_ddl_history` | 由 DDL owner 推进 |
| `statistics.Table`（`pkg/statistics/table.go:81`） | 一张表的直方图 + TopN 统计快照 | ANALYZE 写入系统表，lease 轮询增量刷新内存缓存 | planner 行数估算的唯一数据源 |
| `Memo/Group`（`pkg/planner/cascades/memo/group.go:35`） | Cascades 优化器的逻辑等价类森林 | 单次优化内 | GroupExpression 携带 `LogicalPlan` |
| `regionJob`（`pkg/ingestor/ingestctrl/region_job.go:117`） | 一个 region 范围的 SST 导入任务 | 导入期间，失败回退续传 | 由 ingestctrl Backend 驱动 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `kv.Storage` / `kv.Transaction` | `pkg/kv/kv.go` | `tikvStore`（driver）、mockstore | `RegisterStore` 按 store 类型注册 |
| `Executor`（Open/Next/Close） | `pkg/executor/internal/exec/executor.go:224` | 全部物理算子 | `executorBuilder.build` 巨型 type switch（编译期穷举） |
| `Expression` / `VecExpr` | `pkg/expression/expression.go:189/129` | `Column`、`Constant`、`ScalarFunction` | 由 planner 的 expressionRewriter 构建 |
| `functionClass` | `pkg/expression/builtin.go` | 每个内置函数一组 sig | `funcs` 全局 map 注册 |
| `base.LogicalOptRule` | `pkg/planner/core/base` | 每条逻辑优化规则 | `optRuleList` + `optRuleFlags` 位标志 |
| `owner.Manager` | `pkg/owner/manager.go` | etcd 实现 | DDL/GC/分布式任务各自创建 |
| `Backend`（导入引擎） | `pkg/lightning/backend/backend.go:193` | local（ingestctrl）、tidb（逻辑） | Lightning 按 config 选择 |

对象关系（执行一次查询时各对象的持有链）：

```
Server ─ clientConn ─ TiDBContext ─ session ─ LazyTxn ─ kv.Transaction(tikvTxn → client-go KVTxn)
                     │                │
                     │                ├─ SessionVars ─ StmtCtx / TxnCtx
                     │                └─ domain ─ InfoCache ─ InfoSchema(v2)
                     └─ ExecStmt ─ Plan ─ Executor 树 ─ *chunk.Chunk 流
```

---

## 代码目录

```shell
tidb/
├── cmd/tidb-server/        # tidb-server 入口（main.go：flag 解析 → 配置 → 起服务）
├── pkg/                    # SQL 内核主体（所有核心逻辑都在这里）
│   ├── server/             # MySQL 协议（conn.go 握手/分发、internal/packetio.go 编解码）
│   ├── session/            # 会话与事务编排（session.go、txn.go、tidb.go）
│   ├── sessiontxn/          # TxnManager + 隔离级别 provider（isolation/ 四实现）
│   ├── parser/             # 独立 go module：lexer + goyacc 文法 + AST 定义
│   ├── planner/            # optimize.go 入口；core/（Volcano）+ cascades/（新框架）+ memo/
│   ├── executor/           # 算子与语句执行（adapter.go、builder.go 600+ 分支）
│   ├── expression/         # 表达式构建与向量化求值（builtin*.go、aggregation/）
│   ├── distsql/            # 下推请求构建（request_builder.go）与结果解码（select_result.go）
│   ├── domain/             # 实例级聚合对象 + 全部后台任务启动（domain.go ~3000 行）
│   ├── infoschema/         # v1/v2 双实现 + issyncer 增量加载
│   ├── meta/               # 元数据 KV 编解码（Mutator 写端 / Reader 读端）
│   ├── ddl/                # 在线 Schema 变更（job_scheduler、job_worker、schemaver）
│   ├── statistics/         # 统计信息（handle/ 下按职责拆 10+ 子包）
│   ├── store/              # driver/(txn 适配) copr/(coprocessor) gcworker/ mockstore/
│   ├── ingestor/           # SST 导入新家（ingestctrl/globalsort/simplesst/ingestcli）
│   ├── dxf/                # 分布式任务执行框架（framework/importinto/operator）
│   ├── objstore/           # 对象存储统一抽象（S3/OSS/GCS/Azure/HDFS/local）
│   ├── kv/ table/ types/ util/   # 接口层、表编码、类型系统、公共库
│   └── bindinfo/ ttl/ metrics/ privilege/ resourcemanager/ ...  # 周边子系统
├── br/                     # 备份恢复（backup/restore/split/stream/task/glue）
├── lightning/              # Lightning 入口层（importer/server/checkpoints）；引擎在 pkg/lightning
├── dumpling/              # 数据导出（独立工具，SQL 层导出）
├── tests/                  # 集成测试（integrationtest 为主，testkit 框架驱动）
└── pkg/testkit/            # 测试框架（真实集群/unistore 两种 backend）
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/tidb-internals/module-dependencies.svg)

依赖主线只有一条：`server → session → (parser → planner → executor → distsql) → store`，其余模块都是挂在主线旁的支撑件——`statistics` 供 planner 估算、`domain/infoschema/meta` 提供元数据快照、`ddl` 独立异步演进 schema、`store/driver` 承接事务提交。图中最能体现"TiDB 是分布式系统协调者"的两个箭头：`session → store/driver` 的"事务提交 2PC"（Percolator 客户端在 TiDB 侧）和 `store/driver → PD` 的"TSO/etcd"（全集群时钟）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| [协议接入](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/10-server) | MySQL wire protocol 手写实现 | `clientConn.dispatch` in `pkg/server/conn.go` | 二进制协议编解码与 SQL 内核无任何共享语义 | [10-server](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/10-server) |
| [SQL 解析器](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/01-parser) | SQL 文本 → AST | `Parser.ParseSQL` in `pkg/parser/yy_parser.go` | 独立 go module、零上层依赖，被 planner/executor/session 共用 | [01-parser](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/01-parser) |
| [查询优化器](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/02-planner) | AST → 最优物理计划 | `Optimize` in `pkg/planner/optimize.go` | 优化决策独立于执行，Volcano/Cascades 双框架 + plan cache | [02-planner](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/02-planner) |
| [执行器](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/03-executor) | 物理计划 → 算子树迭代执行 | `ExecStmt.Exec` in `pkg/executor/adapter.go` | 数据流执行与计划决策解耦，火山模型统一本地/下推 | [03-executor](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/03-executor) |
| [表达式](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/04-expression) | 表达式树 + 向量化求值 + 内置函数 | `newFunctionImpl` in `pkg/expression/scalar_function.go` | 求值逻辑被 planner 与 executor 共用，还要下推到 TiKV | [04-expression](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/04-expression) |
| [会话与事务](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/07-session-txn) | 语句编排、事务状态机、隔离级别 | `session.executeStmtImpl` in `pkg/session/session.go` | 事务语义是横切所有语句的独立维度 | [07-session-txn](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/07-session-txn) |
| [元数据中枢](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/09-domain-infoschema) | Domain 聚合 + InfoSchema 多版本快照 | `Loader.LoadWithTS` in `pkg/infoschema/issyncer/loader.go` | 全集群一致 schema 是分布式正确性的根基 | [09-domain-infoschema](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/09-domain-infoschema) |
| [分布式 DDL](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/05-ddl) | 在线 Schema 变更 | `(w *worker) transitOneJobStep` in `pkg/ddl/job_worker.go` | DDL 是异步分布式任务，与同步查询路径完全隔离 | [05-ddl](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/05-ddl) |
| [统计信息](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/06-statistics) | ANALYZE 收集 + 估算消费 | `StatsCacheImpl.Update` in `pkg/statistics/handle/cache/statscache.go` | 双层存储（系统表+内存）与 lease 增量同步是独立子系统 | [06-statistics](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/06-statistics) · 附件 [直方图与 TopN 构建](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/06a-statistics-histogram-topn) |
| [存储客户端](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/08-store) | TiKV/PD 客户端：2PC + Coprocessor | `tikvTxn.Commit` in `pkg/store/driver/txn/txn_driver.go` | 存储协议适配层，client-go 内核外置后的接缝 | [08-store](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/08-store) |
| [导入栈](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/11-ingestor-dxf) | SST 直写 + global sort + 分布式任务 | `ImportEngine` in `pkg/ingestor/ingestctrl/local.go` | 导入绕过 SQL 层直写存储，是独立的数据平面 | [11-ingestor-dxf](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/11-ingestor-dxf) |
| [备份恢复与导入工具](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/12-br-lightning) | BR 快照/PITR + Lightning 双模式导入 | `RunBackup` in `br/pkg/task/backup.go` | KV 层旁路工具，复用集群协议但自成 CLI 体系 | [12-br-lightning](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/12-br-lightning) |

模块间的动态调用顺序见「运行时行为 > 核心运行流程」——静态上 `statistics` 挂在 planner 旁，动态上行数估算发生在 `RecursiveDeriveStats` 一刻。

---

## 运行时行为

### 启动流程

```
cmd/tidb-server/main.go: main()
 ├─ initFlagSet / 解析命令行与配置文件（config.Load）        # 配置优先级：命令行 > 环境变量 > 配置文件 > 默认值
 ├─ 根据 --store 决定存储后端                                  # tikv / unistore(mockstore) / future
 │   └─ kv.RegisterStore 注册的 TiKVDriver.OpenWithOptions    # pkg/store/driver/tikv_driver.go:127
 │       ├─ 建 PD client（含 keyspace 编解码 CodecPDClient）与 TSO
 │       └─ tikv.NewKVStore（client-go：RegionCache/RPCClient）
 ├─ session.BootstrapSession(store)                           # pkg/session/tidb.go:168
 │   ├─ domap 单例创建 domain.NewDomain                       # per-store 唯一 Domain
 │   ├─ domain 启动后台任务（DDL scheduler、schema reload SyncLoop、
 │   │    stats worker、TTL job、runaway、plan replayer、GC owner ...）# domain.go:804 Domain.Start
 │   └─ Bootstrap：首次启动建系统表（pkg/session/bootstrap.go）
 └─ server.NewServer → Run                                    # accept 循环 + go onConn 每连接一 goroutine
```

对象装配要点：`Domain` 是唯一手工装配的聚合根——它持有 store、etcd client、session 池，并把 DDL、统计、TTL 等"需要 owner 选举 + 内部会话"的后台任务统一挂到自己的 `wg` 协程组下（`Domain.Close` 逆序清理）。没有 DI 容器，全部在 `BootstrapSession` 里按依赖顺序显式构造：先 store、后 domain、再 session 池。

### 核心运行流程

以下四条链路覆盖 TiDB 的主要运行模式：读、写、元数据变更、批量导入。

#### 查询链路：一条 SELECT 的端到端数据流

业务流程：客户端发 COM_QUERY → 协议层分发 → 解析 AST → 优化成物理计划 → 构建算子树 → 下推 TiKV 扫描 → Chunk 流式回传 → 编码为 MySQL 行包。

![查询数据流](/vibe-reading/images/articles/tidb-internals/data-flow.svg)

文字描述：`handleQuery` in `pkg/server/conn.go:1857` 先调 `cc.ctx.Parse` 拿 `[]ast.StmtNode`，逐条进 `session.executeStmtImpl`（`pkg/session/session.go:2432`）。编译阶段三步走：`core.Preprocess`（`pkg/planner/core/preprocess.go:128`，名字解析与校验）→ `planner.Optimize`（`pkg/planner/optimize.go:141`，依次尝试 prepared plan cache → non-prepared plan cache（常量参数化后复用）→ 全新优化，`doOptimize` in `pkg/planner/core/optimizer.go:333` 做逻辑规则改写与 `FindBestTask` 代价搜索）→ `executorBuilder.build`（`pkg/executor/builder.go:193`）把物理计划映射为算子。执行阶段以 Chunk 为单位 pull：`recordSet.Next` → `TableReaderExecutor.Next` → `selectResult.Next`（`pkg/distsql/select_result.go:499`）从 gRPC 流式响应解码 `tipb.SelectResponse` 为 `chunk.Chunk`，`writeChunks` in `conn.go` 再编码成 MySQL text/binary 行包。异步点：每连接一个 goroutine；`copIterator.open` 起 N 个 worker goroutine + 一个限速 taskSender（`pkg/store/copr/coprocessor.go:1204`），单 region 点查走 `liteCopIteratorWorker` 免 goroutine。

#### 写入链路：INSERT 与 Percolator 2PC

业务流程：INSERT 写入内存 MemBuffer → 语句级 staging flush → autocommit 或显式 COMMIT 触发 2PC：prewrite 主键 → 并行 prewrite 次键 → commit 主键（拿到 commit_ts 即返回）→ 异步 commit 次键。

文字描述：`InsertExec.Next` in `pkg/executor/insert.go:360` 经 `Table.AddRecord`（`pkg/table/tables/tables.go:742`）把行编码进 `txn.GetMemBuffer()` 的 staging——语句失败由 `StmtRollback`（`pkg/session/txn.go:759`）丢弃 staging，成功由 `StmtCommit` 合入事务。提交由 `finishStmt → autoCommitAfterStmt`（`pkg/session/tidb.go:321`）在 `!InTxn()` 时触发 `doCommitWithRetry`（乐观冲突可重放）→ `tikvTxn.Commit`（`pkg/store/driver/txn/txn_driver.go:115`）→ client-go 的 `twoPhaseCommitter`（primary key 先行，async commit 下 prewrite 返回即成功，1PC 由 TiKV 原子合并）。写-写冲突检测在 TiKV prewrite 一侧完成，错误经 `extractKeyErr` 语义化为 `ErrWriteConflict`/Duplicate Key 回传 session 决定重试或报错。

#### DDL 链路：ALTER TABLE ADD COLUMN 的全集群协同

业务流程：SQL 构造 Job → 持久化 `tidb_ddl_job` 表 → owner 节点领取调度 → 逐步推进 SchemaState 状态机 → 每步推进 schema version 并广播全集群 reload → job 归档。

文字描述：`(e *executor) AddColumn` in `pkg/ddl/executor.go:2227` 构造 `model.Job`，`JobSubmitter.submitLoop` in `pkg/ddl/job_submitter.go:65` 批量写入 `mysql.tidb_ddl_job` 并写 etcd notify key。owner（`pkg/owner/manager.go` 的 etcd campaign 选举，`jobScheduler.scheduleLoop` in `pkg/ddl/job_scheduler.go:264` 监听）领取 job，`transitOneJobStep` in `pkg/ddl/job_worker.go:592` 每步开事务执行一次状态迁移（如 `onAddColumn`），并 `updateSchemaVersion` 写 `SchemaDiff`；`schemaver.Syncer.WaitVersionSynced`（`pkg/ddl/schemaver/syncer.go:102`）通过 etcd 全局版本 + 各节点上报确认全集群 schema 追平。数据回填（加索引）在 `StateWriteReorg` 阶段由 backfill worker（乃至 DXF 分布式执行）完成。

#### 导入链路：IMPORT INTO 的 global sort 三步流水线

业务流程：SQL 提交任务 → DXF 调度到多节点 EncodeAndSort（编码 KV 局部排序直写对象存储）→ MergeSort 全局归并切分 range → WriteAndIngest 按 range 生成 SST 直写并 ingest 到 TiKV。

文字描述：`ImportIntoExec` in `pkg/executor/import_into.go` 把任务写入 DXF meta 表；`importStepExecutor` in `pkg/dxf/importinto/task_executor.go:72`（注释自称"等价于一个 Lightning 实例"）驱动三个 step：编码阶段 `chunkWorker.HandleTask` 经 `simplesst` 写出 data/stat 文件；归并阶段 `MergeOverlappingFiles` in `pkg/ingestor/globalsort/merge.go:179` 多路归并后 `RangeSplitter.SplitOneRangesGroup` 切出 region 级 range；ingest 阶段 `Backend.ImportEngine` in `pkg/ingestor/ingestctrl/local.go:1405` 暂停 PD 调度、split/scatter region，按 `regionJob` 状态机逐 region `doWrite`（gRPC/HTTP 写 KV 生成 SST）→ `doIngest`。

### 状态流

![核心状态机](/vibe-reading/images/articles/tidb-internals/state-flow.svg)

三个状态机覆盖 TiDB 最关键的运行时状态：**SchemaState**（`pkg/meta/model/job.go:269`，在线变更的元素级可见性，枚举定义处；迁移由 `transitOneJobStep` 推进）实现 F1 论文的 Online Schema Change 语义——中间态（DeleteOnly/WriteOnly）保证新旧 schema 并存期间 DML 不产生不可解释的数据；**LazyTxn**（`pkg/session/txn.go:49`，`Invalid → Pending（txnFuture）→ Valid`）让只读语句不必取 TSO，提交/回滚后回到 Invalid；**regionJob**（`pkg/ingestor/ingestctrl/region_job.go:117`）把 SST 导入的失败恢复建模为"更新 keyRange 回退续传"，配合 `regionJobRetryHeap` 优先级重试。触发者分别是 DDL owner、session 语句边界、ingestctrl Backend。

---

## 典型修改场景

#### 场景 1：新增一条 SQL 语法

以 `ADMIN RELOAD XXX` 为例：

1. `pkg/parser/parser.y` 加 `%token` 关键字 + 文法规则（动作里构造 AST 节点）；unreserved 词需同步 `pkg/parser/keywords.go` 并 `make parser` 重新生成 `parser.go`
2. `pkg/parser/ast/misc.go` 定义语句 struct（实现 `Restore/Accept/statement()`），`GetStmtLabel` 加 label
3. `pkg/planner/core/planbuilder.go` 的 build 分发加分支
4. `pkg/executor/` 新增 executor + `builder.go` 的 `build` switch 加 case
5. 对应测试：`pkg/parser/parser_test.go` + `pkg/testkit` 集成测试

#### 场景 2：新增一个内置标量函数

以 `ABS` 为模板：

1. `pkg/parser/ast/functions.go` 加函数名常量
2. `pkg/expression/builtin.go:659` 的 `funcs` map 注册 functionClass
3. `builtin_xxx.go` 写 `getFunction` 类型分发与行式 `evalInt/...`
4. `builtin_xxx_vec.go` 写 `vecEvalXxx` + `vectorized()`（或用 `vecEvalIntByRows` 回退）
5. `setPbCode(tipb.ScalarFuncSig_Xxx)` 使其可下推（需在 tipb 仓库加枚举）
6. `infer_pushdown.go` / `builtin_threadsafe_generated.go` 与测试同步

#### 场景 3：新增一种在线 DDL

1. `pkg/parser` 加语法与 AST
2. `pkg/meta/model/job.go` 增 `ActionType` 与 `JobArgs`
3. `pkg/ddl/executor.go` 增 `(e *executor) AlterXxx` 构造 job 并挂入 `AlterTable` switch（:1707）
4. `pkg/ddl/job_worker.go` 的 `runOneJobStep` switch 加 `onXxx` 状态机处理
5. `pkg/ddl/schema_version.go` 的 `updateSchemaVersion` 增 `SetSchemaDiffForXxx`；`pkg/ddl/rollingback.go` 处理回滚
6. 对应测试：`tests/integrationtest` 下的 DDL 子目录

三个场景对应的测试位置见「测试体系」——改 parser/expression 优先看单元测试，改 ddl/executor 优先看 integrationtest。

---

## 测试体系

```
tidb/
├── tests/
│   ├── integrationtest/       # 主集成测试矩阵（testkit 框架，真实 SQL 断言，万级用例）
│   ├── realtikvtest/          # 需要真实 TiKV 集群的测试（unistore 模拟不了的行为）
│   ├── globalkilltest/ graceshutdown/ clusterintegrationtest/ ...  # 专项集群行为
│   └── _utils/                # 测试辅助
├── br/tests/ lightning/tests/ ...  # 工具子系统各有独立集成测试目录
└── (代码旁 *_test.go)          # 1848+ 个单元测试文件，与源码同目录
```

| 代码层 | 测试类型 | 典型位置 |
| --- | --- | --- |
| parser / expression / util | 纯单元测试 | `pkg/parser/parser_test.go`、`pkg/expression/builtin_xxx_vec_test.go` |
| planner / executor / session | testkit 集成（unistore 起库跑 SQL） | `tests/integrationtest/`（按域分子目录） |
| store 层协议行为 | realtikvtest（真集群） | `tests/realtikvtest/` |
| DDL 并发/冲突 | integrationtest + failpoint | `pkg/ddl/failpoint_test.go` |

理解某个类的最快方式：先看同目录的 `*_test.go`——如 `pkg/executor/executor_required_rows_test.go` 展示了 Limit 传导需求数的完整用法，`pkg/parser/testdata/` 存放黄金结果文件。

---

## 阅读源码推荐路线

- **第一遍：主流程**。从 `cmd/tidb-server/main.go` 起，`pkg/server/conn.go` 的 `dispatch` → `handleQuery`，到 `pkg/session/session.go` 的 `executeStmtImpl`，`pkg/executor/compiler.go` 的 `Compile`，`pkg/planner/optimize.go` 的 `Optimize`，最后 `pkg/executor/adapter.go` 的 `ExecStmt.Exec`——一条 SELECT 从字节到结果的完整骨架。
- **第二遍：核心数据结构**。`pkg/util/chunk/chunk.go` 的 `Chunk/Column`（执行期一切数据的载体）→ `pkg/parser/ast/ast.go` 的 `Node/ExprNode/StmtNode` 接口 → `pkg/planner/core/base/plan_base.go` 的 `Plan` 三接口 → `pkg/statistics/table.go` 的 `Table/HistColl`。
- **第三遍：事务与存储**。`pkg/session/txn.go` 的 `LazyTxn` 三态 → `pkg/sessiontxn/isolation/base.go` 的 `baseTxnContextProvider`（四种隔离级别怎么只差两个函数）→ `pkg/store/driver/txn/txn_driver.go` 的 `tikvTxn.Commit` → `pkg/store/copr/coprocessor.go` 的 `copIterator`（下推扫描怎么流式化）。
- **第四遍：元数据与后台任务**。`pkg/domain/domain.go` 的 `Domain.Start`（列出全部后台任务）→ `pkg/infoschema/issyncer/loader.go` 的 `LoadWithTS`（schema 怎么增量加载）→ `pkg/ddl/job_worker.go` 的 `transitOneJobStep` → `pkg/meta/meta.go` 顶部注释的键空间结构图。
- **第五遍：按模块文档深入**。从上方「模块地图」挑关心的模块进入 12 篇模块解读。

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| TSO | Timestamp Oracle，PD 提供的全局唯一递增时间戳，事务 StartTS/CommitTS 的来源 |
| Percolator | Google 论文提出的基于 KV 的分布式事务协议，2PC 协调在客户端（TiDB）侧 |
| Region | TiKV 按 key range 切分的数据分片（默认 96MB），Raft 组的基本单位 |
| Coprocessor | TiKV/TiFlash 内嵌的下推执行引擎，TiDB 把 scan/agg/join 编码为 DAG 下发 |
| MPP / Exchange | TiFlash 的大规模并行执行模式；Exchange 算子在节点间 Shuffle 数据 |
| InfoSchema | 某一 schema version 下全库表元数据的不可变快照 |
| Schema Lease | 节点本地 schema 的有效期（45s），过期必须 reload，否则拒绝服务 |
| Owner | 经 etcd campaign 选举的"全集群唯一执行者"（DDL、GC、分布式任务均用） |
| Reorg / Backfill | DDL 回填存量数据的阶段（如加索引扫描全表写入索引） |
| Plan Cache / SPM | 计划缓存 / SQL Binding（执行计划管理，以 hint 注入强制计划） |
| Chunk | 列式批处理容器，TiDB 向量化执行的基本单位（默认 1024 行级批） |
| Global Sort | 导入时把局部排序结果写对象存储再全局归并，摆脱单节点磁盘/内存瓶颈 |
| DXF | Distributed eXecution Framework，导入等长任务的分布式调度框架 |
| PITR | Point-In-Time Recovery，全量备份 + log backup 回放到任意时间点 |
| Keyspace | 多租户下 TiKV 中的逻辑隔离空间（API V1/V2 编码） |

### 参考资料

- [TiDB 官方架构文档](https://docs.pingcap.com/tidb/stable/tidb-architecture)
- [TiDB Design Docs](https://github.com/pingcap/tidb/tree/master/docs/design)（仓库内 `docs/design/`，DDL/事务/导入的中文设计文档）
- [Large-scale Incremental Processing Using Distributed Transactions and Notifications](https://research.google/pubs/pub36726/)（Percolator，事务模型出处）
- [F1 Schema Change 论文](https://arxiv.org/abs/1911.08547)（Online Schema Change 状态机出处）
- [TiDB Development Guide](https://pingcap.github.io/tidb-dev-guide/)
