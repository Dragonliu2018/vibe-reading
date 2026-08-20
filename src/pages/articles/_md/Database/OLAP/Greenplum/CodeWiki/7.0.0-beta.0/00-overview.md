---
source:
  type: "源码解读"
  project: "Greenplum"
  url: "https://github.com/greenplum-db/gpdb"
title: "Overview"
date: "2026-08-14T15:39:30+08:00"
category: [Database, OLAP, Greenplum, CodeWiki, "7.0.0-beta.0"]
tags: ["Greenplum", "C/C++", "MPP", "数据库", "ORCA"]
description: "基于 PostgreSQL 的开源 MPP 数据仓库——coordinator/segment 共享无盘架构、GPORCA 代价优化器与分布式执行内核解读。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 7.0.0-beta.0 (commit 482967c1) · **协议** Apache 2.0 · **语言** C / C++ · **代码量** ~2,070,000 行（src/，排除测试）· **仓库** [GitHub](https://github.com/greenplum-db/gpdb-archive)

---

## 总览

### 项目简介

**Greenplum Database（GPDB）** 是一个基于 PostgreSQL 的开源大规模并行处理（MPP）数据仓库，面向 PB 级数据分析场景。它的核心价值在于把单机 PostgreSQL 的执行引擎改造成 **coordinator + 多 segment 的共享无盘（shared-nothing）集群**：用户数据按分布键打散到多个 segment 节点，查询在 coordinator 上被切成可在 segment 上并行执行的"片段"（fragment），各 segment 独立扫描本地数据、通过 Motion 算子经 interconnect 网络交换中间结果，最终由 coordinator 汇总返回客户端。这种架构让 OLAP 查询的吞吐随节点数近线性扩展。

GPDB 在 PostgreSQL 之上做了几处关键加法：**GPORCA**——一个基于 Cascades 搜索框架的模块化 C++ 代价优化器，替代 PostgreSQL planner 处理复杂 MPP 查询；**cdb 层**——分布式执行内核，负责把计划改写为可并行形态（插入 Motion 节点）、向 segment 派发命令、建立 segment 间互连、协调分布式事务；**FTS**——容错服务，周期性探测 primary/mirror segment 并在故障时触发 mirror 提升。`cdb` 是早年"Cluster Database"的工作代号，该名称已不再使用，但代码前缀保留至今。

**项目边界**：GPDB 负责分布式 OLAP 查询执行、并行数据加载与 MPP 仓库管理。它不是在线事务处理（OLTP）数据库——基于 PostgreSQL 内核的单行更新吞吐仍受限于 segment 数与锁粒度；也不负责集群运维调度（由 gpMgmt 的 Python 工具与外部编排承担）。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|----------|------|
| MPP 并行查询 | `src/backend/cdb/` | coordinator 拆分计划、segment 并行执行、Motion 重分布 |
| GPORCA 代价优化器 | `src/backend/gporca/` | Cascades 框架的 C++ 优化器，`optimizer=on` 时启用 |
| 计划翻译桥 | `src/backend/gpopt/` | PostgreSQL Query/Plan ↔ ORCA DXL 翻译 |
| Motion 数据重分布 | `src/backend/executor/nodeMotion.c` + `cdb/cdbpath.c` | Gather / Redistribute / Broadcast 三类 Motion 算子 |
| 分布式事务 | `src/backend/cdb/cdbtm.c` | 两阶段提交（DTX），分布式快照 |
| 容错与 mirror 提升 | `src/backend/fts/` | FTS 后台探测进程，primary 故障→in-sync mirror 提升 |
| Append-Only 存储 | `src/backend/cdb/cdbappendonly*.c` | 行存/列存 AO 表，压缩、大批量加载 |
| 并行加载 | `src/bin/gpfdist/` + `gpcontrib/gp_exttable_fdw` | gpfdist 文件分发服务 + 外部表 |
| 分区表 | `src/backend/partitioning/` | 分区裁剪与分区选择算子 |
| 外部表 | `src/backend/foreign/` | FDW 框架 + Greenplum 扩展 |
| 过程语言 | `src/pl/{plpgsql,plpython,plperl,tcl}` | PL/pgSQL、PL/Python3、PL/Perl、PL/Tcl |
| 集群管理 | `gpMgmt/bin/` | gpinitsystem/gpstart/gpstop/gpssh/gpconfig 等 Python 工具 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C | 核心 | PostgreSQL 内核 + cdb 分布式执行层 |
| C++ | 核心 | GPORCA 优化器（libgpopt/libnaucrates/libgpos） |
| Python | 管理 | gpMgmt 集群管理工具（gppylib，依赖 psutil/psycopg2/pyyaml） |
| autoconf / make | 构建 | `configure.in` + `GNUmakefile.in` |
| libxml2 | 可选 | XML 支持（DXL、gpdb-doc） |
| gssapi | 可选 | GSSAPI 认证 |
| perl / python | 可选 | PL 过程语言 UDF |
| PostgreSQL（上游） | 基座 | GPDB 跟踪合并上游 PostgreSQL release，diff 集中在 cdb/gpopt/gporca/fts |

### 版本历史

GPDB 经历了从 Pivotal/EMC 时期到开源社区的演进。7.x 系列对应合并较新的 PostgreSQL 内核（本快照基线 `7.0.0-beta.0`），延续 coordinator/segment MPP 架构与 GPORCA 优化器主线。本解读基于 `main` 分支 HEAD（commit `482967c1`，`getversion` 输出 `7.0.0-beta.0`），聚焦架构主线而非版本间差异。

## 快速上手

以 demo 集群最快看到 GPDB "跑起来"为例（节选自仓库 `README.md`，验证后复用）：

```bash title="build & demo cluster"
# 初始化子模块（GPORCA 等依赖）
git submodule update --init

# 配置（装到 /usr/local/gpdb）
./configure --with-perl --with-python --with-libxml --with-gssapi --prefix=/usr/local/gpdb

# 编译安装
make -j8
make -j8 install

# 载入环境
source /usr/local/gpdb/greenplum_path.sh

# 启动 demo 集群（1 coordinator + N segment）
make create-demo-cluster
source gpAux/gpdemo/gpdemo-env.sh   # 含 PGPORT 与 COORDINATOR_DATA_DIRECTORY
```

端到端验证——连上 coordinator，执行一条会跨 segment 重分布的聚合查询：

```sql title="psql 连 demo 集群"
psql -p $PGPORT -d postgres
-- 关掉 ORCA 对比 PG planner（可选）
-- set optimizer=off;
SELECT gp_segment_id, count(*) FROM generate_series(1,1000000) g(id) GROUP BY gp_segment_id;
-- 预期：多行，每行一个 segment id，count 之和=1000000
```

`gp_segment_id` 是 GPDB 特有的隐含列，返回数据所在 segment 编号——它能"跑起来"即证明查询已被拆分到多个 segment 并行执行。`DATADIRS`/`PORT_BASE`/`NUM_PRIMARY_MIRROR_PAIRS`/`WITH_MIRRORS` 可在 `make create-demo-cluster` 时即行调整集群规模与镜像。

## 代码目录

```text
gpdb-archive/
├── src/                    # 核心源码（PostgreSQL 内核 + GPDB 扩展）
│   ├── backend/            # 服务端：parser/access/storage/executor/utils/optimizer(继承) + cdb/gporca/gpopt/fts(GPDB 专属)
│   │   ├── cdb/            # ★ MPP 分布式执行层（Motion/interconnect/dispatch/gang/DTX/AO存储）
│   │   ├── gporca/         # ★ GPORCA 代价优化器（C++：libgpopt/libnaucrates/libgpos/server）
│   │   ├── gpopt/          # ★ PostgreSQL↔ORCA DXL 翻译桥（C++ translator 库）
│   │   ├── fts/            # ★ 容错服务（探测 primary/mirror、failover）
│   │   └── ...             # parser/access/executor/storage/utils/optimizer 等 PostgreSQL 继承目录
│   ├── bin/                # 客户端工具（psql/pg_dump + gpfdist/gpnetbench）
│   ├── include/           # 头文件
│   ├── interfaces/        # libpq / gppc / ecpg 客户端接口
│   ├── pl/                # 过程语言（plpgsql/plpython/plperl/tcl）
│   ├── test/              # 回归与隔离测试（regress/isolation2/walrep/...）
│   └── tools/            # pgindent/gdb 等开发工具
├── gpMgmt/                # 集群管理 CLI（Python：gpinitsystem/gpstart/gpstop/gpssh/gpconfig/gpcheckcat）
├── gpAux/                 # 发布脚本 + gpdemo demo 集群
├── gpcontrib/             # Greenplum 专属扩展（gp_toolkit/gp_inject_fault/orafce/zstd/gp_exttable_fdw）
├── contrib/              # PostgreSQL contrib 扩展
├── gpdb-doc/             # DITA XML 文档
├── config/ concourse/ .github/  # 构建配置与 CI
└── configure / GNUmakefile.in  # autoconf 构建入口
```

一级目录职责（沿用 `README.md` "Code layout" 说明）：`gpMgmt/` 是 Greenplum 专属的集群管理命令行工具（`gpinit`/`gpstart`/`gpstop`，多为 Python）；`gpAux/` 含发布脚本与 vendored 依赖，`gpdemo/` 提供单机 demo 集群；`gpcontrib/` 类似 PostgreSQL 的 `contrib/`，放 Greenplum 专属扩展（含 gpfdist 相关）；`src/backend/cdb/` 是最大的 Greenplum 专属后端模块——segment 间通信、计划并行化、镜像、分布式事务与快照管理，`cdb` 即早年 "Cluster Database" 工作代号；`src/backend/gpopt/` 是调用 GPORCA 的 "translator" 库（C++，DXL 与 PostgreSQL 内部表示互译）；`src/backend/gporca/` 是 GPORCA 优化器本体（C++）；`src/backend/fts/` 是运行于 coordinator、周期探测 segment 状态的容错进程。

## 架构设计解析

### 系统架构

GPDB 的设计思想是把单机 PostgreSQL 的执行引擎"横向切开"成共享无盘（shared-nothing）集群：每个 segment 是一个独立的 PostgreSQL 实例，只管本地数据；coordinator 也是 PostgreSQL 实例，但不存用户数据，只负责接收客户端连接、把查询计划切成可在 segment 并行执行的片段、派发执行、汇总结果。这样 OLAP 扫描/聚合的吞吐随 segment 数近线性扩展，而单机 PostgreSQL 的执行器、存储、事务机制大部分得以复用——GPDB 的 diff 主要集中在"如何把一个计划变成并行计划、如何让 segment 间交换数据、如何保持分布式一致性"这三件事上，即 `cdb`/`gpopt`/`gporca`/`fts` 四个专属模块。

![Greenplum 分层架构](/vibe-reading/images/articles/gpdb-internals/architecture.svg)

纵向分五层：客户端用 libpq 协议连 coordinator；接口层 `postmaster` 管理进程、`tcop/postgres.c` 的 `exec_simple_query` 处理查询；优化器层入口 `standard_planner`，`optimizer=on` 时走 GPORCA（经 `gpopt` 翻译桥调 `gporca` 的 Cascades 引擎），否则回退 PostgreSQL planner（`optimizer` + `cdbllize`/`cdbmutate` 插入 Motion）；分布式执行层 `cdb` 负责派发/gang/互连/Motion/分布式事务；存储与容错层是 PostgreSQL 继承的 `access`/`storage` 加 GPDB 的 `fts` 与 `gpMgmt`。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|------------------------|
| 客户端层 | `src/bin/psql`、外部 JDBC/ODBC | 隔离协议细节，提供统一入口 |
| 接口与进程层 | `postmaster`、`tcop/`、`libpq/` | 管理进程生命周期与连接，保护核心不受协议变化影响 |
| 优化器层 | `optimizer/`、`gpopt/`、`gporca/` | 把 Query 变成可执行的最优计划，MPP 多维属性需求驱动搜索 |
| 分布式执行层 | `cdb/`、`executor/nodeMotion.c` | 把计划切成片段派发 segment、建立互连、协调分布式事务 |
| 存储与容错层 | `access/`、`storage/`、`fts/`、`gpMgmt/` | 持久化（含 AO 存储）+ 集群拓扑保活与运维 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Cascades（Memo + 规则 + 多阶段搜索） | `gporca` `CGroup`/`CXform`/`CEngine` | MPP 多维正交物理属性需需求驱动搜索，自底向上 DP 处理不了 |
| 翻译器 / 中性中间表示 | `gpopt` 三大 Translator + DXL | 解耦 GPDB C 结构与 ORCA C++ 对象（内存/类型隔离） |
| Background Worker | `fts` 经 `PMAuxProcList` 注册 | 多进程架构下的事务隔离 + 崩溃自动重启 |
| 异步 I/O 多路复用 | `fts` `ftsConnect/Poll/Send/Receive`；`cdb` gang `PQconnectStart`+`WaitEventSetWait` | 多 segment 并行探测/建连，单进程内 poll 多路 |
| 状态机 | `fts` `FtsMessageState`（13 态）、segment role/status/mode | 故障判定流程显式化，避免误判 |
| 工厂 | `gporca` `CXformFactory::Instantiate`；`cdb` gang 类型分发 | 规则/算子种类多，统一生命周期与创建 |
| Fan-out/Fan-in | `cdb` `CdbDispatchPlan` → segments → gather | MPP 派发-汇总的核心形态 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `PlannedStmt` + `PlanSlice` | 可执行计划 + 并行切片 | 一次查询 | 由 gpopt 翻译产生，含 Motion 节点与 slice 表 |
| `Motion`（算子） | 数据重分布（Gather/Broadcast/Redistribute/Random） | 计划执行期 | 连接 segment 间的 producer/consumer |
| Gang | 一组 segment 工作进程（writer/reader） | 一次查询/事务 | dispatcher 按需创建，FTS 保活 |
| `CGroup`/`CGroupExpression`（ORCA Memo） | 等价表达式分组 | 一次优化 | Cascades 搜索的载体 |
| `FtsProbeInfo`（共享内存） | segment 健康状态版本 | 集群期 | FTS 写、dispatcher 读 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|----------|--------|----------|
| `COperator`（算子基类） | `gporca/libgpopt/.../operators/COperator.h:50` | `CLogical`/`CPhysical`/`CScalar`/`CPattern` 子类 | 工厂 + xform `Implement` 生成物理算子 |
| `CXform`（变换规则） | `gporca/libgpopt/.../xforms/CXform.h:47` | `CXformExploration`/`CXformImplementation` 子类（~120） | `CXformFactory::Instantiate` 全局单例 |
| `IMDProvider`（元数据源） | `gporca/libgpopt/.../mdcache` | `CMDProviderSystempan`(GPDB catalog)/`CMDProviderMemory`(minidump) | 注入 `CMDAccessor` |
| `BackgroundWorker` | `src/include/postmaster/bgworker.h` | FTS/autovacuum/bgwriter 等 | `PMAuxProcList` 硬编码注册 |

## 模块地图

四个 GPDB 专属模块各管一段：`gpopt` 与 `gporca` 组成优化器链（gpopt 翻译、gporca 搜索，用 DXL 解耦 C/C++）；`cdb` 独立负责分布式执行（派发/gang/互连/DTX），与 `fts` 经共享内存最终一致（cdb 建 gang 时查 fts 的 segment 状态、失败时触发 fts 重探）。其余依赖均为 PostgreSQL 继承目录或外部进程。

![模块依赖关系](/vibe-reading/images/articles/gpdb-internals/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| gporca | 代价优化器（Cascades） | `PdxlnOptimize`（`COptimizer.cpp:230`） | 独立 C++ 子项目，MPP 多维属性需需求驱动搜索，与 PG C 内核解耦 | [01-gporca](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/01-gporca) |
| gpopt | PG↔ORCA DXL 翻译桥 | `OptimizeTask`（`COptTasks.cpp:850`） | C↔C++ 边界唯一翻译通道，隔离内存/类型系统 | [02-gpopt](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/02-gpopt) |
| cdb | MPP 分布式执行层 | `CdbDispatchPlan`（`cdbdisp_query.c:177`） | 把单机计划变并行 + segment 间数据交换的唯一通道 | [03-cdb](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/03-cdb) |
| fts | 容错与 failover | `FtsProbeMain`（`fts.c:113`） | 集群拓扑需全局视图，独立进程的事务隔离 + 崩溃重启 | [04-fts](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/04-fts) |

模块间动态调用顺序见 [运行时行为 > 核心运行流程](#运行时行为)。参与的业务链路：gporca/gpopt 参与"查询优化"链路、cdb 参与"分布式执行"主链路、fts 参与"容错探测"循环。

## 运行时行为

### 启动流程

任何 postgres 进程从 `main()`（`src/backend/main/main.c:60`）起步，做平台 hack、`MemoryContextInit()`、locale，再按进程化身分发到对应的 `FooMain()`——postmaster / standalone backend / bootstrap。coordinator 与 segment 都是 postmaster，区别在 `gp_role`（`GP_ROLE_DISPATCH` vs `GP_ROLE_EXECUTE`）。

对象装配的关键：配置来自 GUC 文件 / 环境变量 / 命令行，覆盖优先级 CLI > env > file；postmaster 启动时把 FTS、bgwriter、autovacuum 等后台进程经 `PMAuxProcList` 数组注册（`postmaster.c:399-406`），其中 FTS 的启动规则 `FtsProbeStartRule` 检查 `gp_role == GP_ROLE_DISPATCH`，因此 FTS 只在 coordinator 跑。segment 的 postmaster 同样从 `main` 进入，进入 `PostgresMain` 后等待 coordinator 派发的 'M' 消息（`am_ftshandler` 标记的连接走 FTS 消息处理，否则走正常查询处理）。

```
main() main.c:60
 ├─ startup_hacks / MemoryContextInit / locale
 └─ 分发: PostmasterMain (coordinator & segment) / standalone / BootstrapMain
     PostmasterMain postmaster.c
      ├─ 读 GUC 配置（file/env/CLI 覆盖优先级）
      ├─ 注册 PMAuxProcList[] 后台进程（FTS/bgwriter/autovacuum…）  [399-406]
      ├─ ServerLoop: fork backend per connection
      │   coordinator: exec_simple_query 查询处理主入口
      │   segment: 等待 'M' 消息 → exec_mpp_query
      └─ FTS（仅 coordinator）: FtsProbeMain 后台探测循环
```

### 核心运行流程

下文覆盖两条最核心的运行链路：分布式查询执行主链路（数据如何从客户端到 segment 再回流），与容错探测循环（集群如何自愈）。

#### 查询执行：分布式 SELECT 主链路

用户连 coordinator 提交 SELECT → `exec_simple_query` 解析分析得 `Query` → `standard_planner` 在 `optimizer=on` 时走 GPORCA（`orca.c:92 optimize_query` → `gpopt` `OptimizeTask` 把 Query 翻 DXL、调 `COptimizer::PdxlnOptimize` 做 Cascades 搜索、回译 `PlannedStmt`，Motion 由 ORCA xform 或 PG 回退路径的 `cdbmutate`/`cdbllize` 插入）→ `CdbDispatchPlan`（`cdbdisp_query.c:177`）按 slice 序列化计划、建 gang（`cdbgang_createGang_async` 用 `PQconnectStart` 并行连所有 segment）、`SetupTCPInterconnect` 建互连 → segment 收 'M' 消息 `exec_mpp_query` 反序列化、执行本 slice 的 Motion sender 把元组经互连发回 → coordinator `ExecMotion` receiver（`nodeMotion.c:303`）`RecvTupleFrom` 收元组、汇总、经 `DestReceiver` 返回客户端。失败时 `cdbdisp` 取消所有 QE 并 `ThrowErrorData` 重抛，写事务则经 `cdbtm` 两阶段提交回滚。

![分布式 SELECT 数据流](/vibe-reading/images/articles/gpdb-internals/data-flow.svg)

关键数据结构变化：`SQL string` → `Query` → `PlannedStmt`（`DXL 逻辑 → DXL 物理`）→ `PlannedStmt(含 Motion+slices)` → 序列化字节流 → `PlannedStmt(QE)` → `MinimalTuple` 流 → `TupleTableSlot` → 客户端。并发模型：gang 建连 async（`PQconnectStart`+`WaitEventSetWait`）、dispatch 异步发送但必须 `cdbdisp_waitDispatchFinish` 同步等待（否则 gather motion 等 segment 数据、segment 等 plan 死锁）、多 segment 经互连并行执行、Motion sender 是 pull 模型（从子节点拉元组）、sorted receiver 用 binaryheap 归并多路有序流。

#### 容错：FTS 探测循环

FTS 后台进程周期（默认 `gp_fts_probe_interval=60s`）唤醒：读 `gp_segment_configuration` → 对所有 primary/mirror 对并行异步探测（`ftsConnect`/`Poll`/`Send`/`Receive`）→ `processResponse` 按状态机判定——primary 活则更新状态、primary 挂且 mirror in-sync 则翻转角色并下轮发 PROMOTE 提升镜像、primary 挂且 mirror 未同步则 double fault 不提升（数据一致性优先）→ 写 catalog + 共享内存 `status_version++`。dispatcher 下次建 gang 时 `getFtsVersion` 发现版本变化重读配置；建 gang 失败也可 `FtsNotifyProber` 主动触发探测。详见 [FTS 容错服务](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/04-fts)。

### 状态流

GPDB 最显式的状态机是 FTS 的 segment 探测流程（`FtsMessageState`，13 态）。每个 segment 对在一个探测周期内：`FTS_PROBE_SEGMENT` → 成功 `FTS_PROBE_SUCCESS` / 失败 `FTS_PROBE_FAILED` → 经 `processResponse` 分派到 SYNCREP_OFF / PROMOTE / 直接处理 / double fault，失败可 `*_RETRY_WAIT` 重试。同时区分 `PMRestartState`（重启中 / 恢复有进展 / 无进展）避免把 segment 正常重启误判为宕机。完整状态图与转换规则见 [FTS 容错服务 > 探测状态机](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/04-fts#核心实现)。

## 典型修改场景

#### 场景 1：新增一种 Motion 重分布类型（cdb + gpopt + gporca）

新增数据移动语义（如按范围分片的 Range Motion）需跨三模块协同：`cdbmutate.c` 加 `make_*_motion` 构造函数（参考 `make_hashed_motion:99`）→ `cdbpath.c` 的 `cdbpath_create_motion_path` 加路径分支 → `executor/nodeMotion.c` 的 `doSendTuple`(:1148) 路由 switch 加 case → ORCA 侧 `libgpopt` 加 `CDXLPhysicalMotion*` 算子 + 一条 implementation xform + `libgpdbcost` 代价分支 → `gpopt` 的 `CTranslatorDXLToPlStmt` switch 加 `TranslateDXL*`。对应测试：`src/backend/cdb/dispatcher/test/cdbdisp_query_test.c`。

#### 场景 2：新增一条 GPORCA 变换规则（gporca）

加一条 exploration 规则（如 LeftSemiJoin→SemiJoin）：`CXform::EXformId` 枚举末尾加 ID（`xforms/CXform.h`）→ 新建 `CXform*` 继承 `CXformExploration`，实现 `Exfp()`/`Transform()`（参考 `CXformJoinAssociativity.cpp`）→ `CXformFactory::Instantiate()`(`CXformFactory.cpp:140`) 注册 + `xforms.h` include + `Makefile`。对应测试：`gporca/server/` unittest + minidump 回放。

#### 场景 3：支持新 SQL 语法经 ORCA（gpopt）

让 ORCA 处理新语法（如 MERGE/ON CONFLICT）：`CTranslatorQueryToDXL.cpp` 的 `TranslateQueryToDXL` switch 加分支（`commandType` 分发，`:793`）→ 必要时 `CTranslatorScalarToDXL.cpp` 标量 switch 加 case → `CTranslatorDXLToPlStmt.cpp` 的 `TranslateDXLOperatorToPlan`(`:328`) 加对应 plan node 的 `TranslateDXL*` → 若影响 Motion/Gang 则改 `CContextDXLToPlStmt` 与 slice 管理。

> 扩展点的契约定义见 [架构设计解析 > 核心概念](#核心概念)（`COperator`/`CXform`/`IMDProvider`/`BackgroundWorker`）。每个场景改代码时参照对应模块文档的"扩展方式"节。

## 测试体系

GPDB 测试在 `src/test/`，分层对应不同关注点：

```
src/test/
├── regress/        # 回归测试（greenplum_schedule 含 GPDB 专属用例）
├── isolation2/     # GPDB 扩展的隔离测试（并发/锁/分布式死锁）
├── isolation/      # PostgreSQL 上游隔离测试
├── recovery/       # 恢复测试
├── walrep/         # WAL 复制与 mirror 同步
├── unit/           # 单元测试（cdb dispatcher 等有 C 单测，如 cdbdisp_query_test.c）
├── ssl/ kerberos/ ldap/  # 认证
└── modules/        # 可加载测试模块
```

| 代码层 | 测试类型 | 入口 |
|--------|----------|------|
| cdb dispatcher/gang | C 单测 | `src/backend/cdb/dispatcher/test/` |
| GPORCA | C++ 单测 + minidump 回放 | `gporca/server/` unittest |
| SQL 行为/分布式 | 回归 + isolation2 | `make installcheck-world` |
| mirror/复制 | walrep/recovery | `src/test/walrep` |

`make installcheck-world` 跑全部回归；`greenplum_schedule` 收录 GPDB 专属用例，上游 PostgreSQL 用例尽量保持原样以利合并。理解某个 cdb 函数时，优先看 `src/backend/cdb/dispatcher/test/cdbdisp_query_test.c` 这类可执行单测——它们是很好的"可执行文档"。

## 阅读源码推荐路线

- **第一遍：理解分布式查询主流程**
  `src/backend/main/main.c` → `tcop/postgres.c` 的 `exec_simple_query`(:1666) → `optimizer/plan/orca.c` 的 `optimize_query`(:92) → `src/backend/gpopt/utils/COptTasks.cpp` 的 `OptimizeTask`(:850) → `cdb/dispatcher/cdbdisp_query.c` 的 `CdbDispatchPlan`(:177) → `cdb/dispatcher/cdbgang_async.c` 的 `cdbgang_createGang_async`(:47) → `motion/ic_tcp.c` 的 `SetupTCPInterconnect`(:1248) → `executor/nodeMotion.c` 的 `execMotionSender`(:201)/`execMotionUnsortedReceiver`(:303)
- **第二遍：理解 GPORCA 优化内核**
  `gporca/libgpopt/src/optimizer/COptimizer.cpp` 的 `PdxlnOptimize`(:230) → `include/gpopt/search/CGroup.h` 的 `CGroup` 与 `CGroupExpression.h`（Memo）→ `include/gpopt/operators/COperator.h` 算子层次 → `include/gpopt/xforms/CXform.h` 变换规则 → `libgpopt/src/engine/CEngine.cpp` 的 `Optimize`(:1674) 与 `FCheckEnfdProps`(:2048)
- **第三遍：理解 MPP 计划并行化与互连**
  `cdb/cdbllize.c` 的 `cdbllize_adjust_top_path`(:386) + `cdbllize_build_slice_table`(:1094) → `cdb/cdbmutate.c` 的 `make_hashed_motion`(:99)/`make_broadcast_motion`(:136) → `cdb/cdbpath.c` 的 `cdbpath_create_motion_path` → `cdb/motion/ic_tcp.c` 互连收发 → `executor/nodeMotion.c` 的 `doSendTuple`(:1148) 路由与 `execMotionSortedReceiver`(:428) 归并 → `cdb/cdbtm.c` 分布式事务两阶段提交
- **第四遍：理解容错与集群管理**
  `fts/fts.c` 的 `FtsProbeMain`(:113)/`FtsLoop`(:322) → `fts/ftsprobe.c` 的 `processResponse`(:1024) failover 判定 → `fts/ftsmessagehandler.c` 的 `HandleFtsWalRepPromote`(:369) segment 端提升 → `cdb/cdbfts.c` 的 `FtsIsSegmentDown`/`FtsNotifyProber`（与 cdb gang 的最终一致）

每遍配合对应模块文档深入阅读。想快速验证某段行为，优先看 `src/backend/cdb/dispatcher/test/cdbdisp_query_test.c` 这类可执行单测与 `gporca/server/` 的 minidump 回放。

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| QD | Query Dispatcher，coordinator 上派发查询的进程 |
| QE | Query Executor，segment 上执行片段的进程 |
| Gang | 一组 segment 工作进程，分 writer gang（写）与 reader gang（读） |
| Motion | segment 间数据重分布算子（Gather 汇总/Broadcast 广播/Redistribute 哈希重分布/Random） |
| Slice | 计划的一个并行执行单元，每个 Motion 划分 slice 边界 |
| Interconnect (IC) | segment 间传输 Motion 元组的网络层（TCP/UDP） |
| DTX | Distributed Transaction，两阶段提交的分布式事务 |
| FTS | Fault Tolerance Service，容错探测与 failover |
| cdb | 早年 "Cluster Database" 工作代号，现为 MPP 层代码前缀 |
| DXL | ORCA 的 XML 中间表示，gpopt 与 gporca 的交换格式 |
| AO | Append-Only 存储，GPDB 专为大批量加载的行/列存表 |

### 参考资料

- 仓库 `README.md`（Code layout / 构建说明）、`src/backend/fts/README`（FTS 机制）
- `src/backend/gporca/README.md`（GPORCA 单测与 minidump）
- [Cascades 框架论文](https://15721.courses.cs.cmu.edu/wp-content/uploads/2015/01/cascades-graefe.pdf)（GPORCA 的理论基础）
- GPORCA 上游 [gp-x / optimizer](https://github.com/greenplum-db/gporca)（历史独立仓库，现内联于 `src/backend/gporca`）

## 相关阅读

- [聊聊 MotherDuck 的分布式](/vibe-reading/articles/digoal-motherduck-distributed) — **方法论镜像**·同为分布式分析型数据库，MotherDuck 的分布式思路与 GPDB 共享无盘 MPP 可横向对照
- [Doris Compaction 机制解析](/vibe-reading/articles/doris-official-compaction-mechanism) — **方法论镜像**·存储引擎 compaction 内部机制，对照 GPDB Append-Only 存储与压缩
- [PostgreSQL 迁移至 Apache Doris 的实践](/vibe-reading/articles/doris-official-postgres-to-doris-migration) — **背景知识**·PostgreSQL 家族同源，GPDB 基于 PG 内核，迁移实践有助理解 PG 系分析库的取舍
