---
source:
  type: "源码解读"
  project: "Cloudberry"
  url: "https://github.com/apache/cloudberry"
title: "Overview"
date: "2026-08-20T11:29:59+08:00"
category: [Database, OLAP, Cloudberry, CodeWiki, "2.1.0-incubating"]
tags: ["Cloudberry", "C/C++", "MPP", "数据库", "ORCA", "PostgreSQL"]
description: "Apache Cloudberry 孵化器项目——由 Greenplum 原班人马打造、基于 PostgreSQL 14 内核的 MPP 数据仓库，CBDB 风格并行查询、AQUMV 物化视图改写与分布式执行内核解读。"
readingTime: "40 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 2.1.0-incubating (commit `bdf90c5518f`) · **PostgreSQL 内核** 14.4 · **协议** Apache 2.0 · **语言** C / C++ · **代码量** ~1,500,000 行（`src/`，排除测试）· **仓库** [GitHub](https://github.com/apache/cloudberry)

---

## 总览

### 项目简介

**Apache Cloudberry（孵化中）** 是一个面向 PB 级数据分析的大规模并行处理（MPP）数据仓库，由 **Greenplum Database 的原班开发者在 Apache 软件基金会孵化器下重新发起**。它从 Pivotal Greenplum Database 的开源版本演进而来，但做了一件关键的事——**把底层 PostgreSQL 内核升级到 14.x**（本解读基线 `2.1.0-incubating` 为 14.4，较 Greenplum 7 的 PostgreSQL 12 更新一截；`main` 分支的下一代 3.0.0 进一步跃升到 16.x），并在此基础上叠加更现代的企业级能力。它可以同时作为数据仓库和大规模分析 / AI/ML 工作负载的承载平台。

Cloudberry 与 Greenplum 共享同一套 coordinator + 多 segment 的共享无盘（shared-nothing）集群骨架：用户数据按分布键打散到多个 segment 节点（每个 segment 是一个独立 PostgreSQL 实例），查询在 coordinator 上被切成可在 segment 并行执行的"片段"（slice/fragment），各 segment 独立扫描本地数据、通过 Motion 算子经 interconnect 网络交换中间结果，最终由 coordinator 汇总返回客户端。`cdb` 是早年 "Cluster Database" 的工作代号，该名称已不再使用，但代码前缀保留至今。

但 Cloudberry 不是简单的"Greenplum 换内核"。它在优化器与执行层做了几处**原创设计**，这正是本解读与已有 [Greenplum 7 CodeWiki](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/00-overview) 互补的重点：

- **CBDB 风格并行查询**（`src/backend/optimizer/README.cbdb.parallel`）——Cloudberry 不沿用 PostgreSQL 标准的 `Gather`/`GatherMerge` "leader 进程拉起若干 worker" 模式，而是让**所有 worker 平等协作**共同执行一个计划节点（共享哈希表等同步机制），按 `parallel_workers` 因子扩展 Gang 规模。README 明确列出了不用 PG 风格的三个原因：leader 拉起的 worker 进程缺乏分布式事务 / 分布式快照 / QE 角色信息、Gather 的 locus 与子节点错位、PG 风格过早 Gather 会清空 partial pathlist。
- **AQUMV（Answer Query Using Materialized Views）**（`src/backend/optimizer/plan/aqumv.c` + `src/backend/catalog/gp_matview_aux.c`）——在 **planning 阶段**就用增量物化视图（IMV）改写查询，对大表聚合场景可带来数量级的加速。它通过 Construct Rows（MV 含查询所需的全部行）和 Construct Columns（查询输出可从 MV 计算）两个条件验证可用性，再做基于代价的等价转换。
- **FTS 提升为顶层目录**（`src/backend/fts/`）——容错服务从 Greenplum 时期的子模块提升为 `backend/` 下的独立顶级目录，凸显其在 Cloudberry 集群可用性中的地位。

**项目边界**：Cloudberry 负责分布式 OLAP 查询执行、并行数据加载与 MPP 仓库管理。它不是 OLTP 数据库——单行更新吞吐仍受限于 segment 数与锁粒度；它也不负责集群编排调度（由 `gpMgmt` 的 Python 工具与外部编排承担）。相比 Greenplum 7（基于 PostgreSQL 12），Cloudberry 能直接享用 PG 13–16 带来的 SQL 标准、分区表、逻辑复制、统计改进等上游红利。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|----------|------|
| MPP 并行查询 | `src/backend/cdb/` | coordinator 拆分计划、segment 并行执行、Motion 重分布 |
| GPORCA 代价优化器 | `src/backend/gporca/` | Cascades 框架的 C++ 优化器，`optimizer=on` 时启用 |
| 计划翻译桥 | `src/backend/gpopt/` | PostgreSQL Query/Plan ↔ ORCA DXL 双向翻译 |
| **CBDB 风格并行查询** | `src/backend/optimizer/` | 所有 worker 平等协作，无 Gather leader，按 `parallel_workers` 扩展 Gang |
| **AQUMV 物化视图改写** | `src/backend/optimizer/plan/aqumv.c`、`src/backend/catalog/gp_matview_aux.c` | planning 期用 IMV 改写查询，加速大表聚合 |
| Motion 数据重分布 | `src/backend/executor/nodeMotion.c` + `src/backend/cdb/cdbpath.c` | Gather / Redistribute / Broadcast 三类 Motion 算子 |
| 分布式事务 | `src/backend/cdb/cdbtm.c` | 两阶段提交（DTX）、分布式快照 |
| 容错与 mirror 提升 | `src/backend/fts/`（顶级目录） | FTS 后台探测进程，primary 故障→in-sync mirror 提升 |
| Append-Only 存储 | `src/backend/cdb/cdbappendonly*.c` | 行存/列存 AO 表，压缩、大批量加载 |
| 并行加载 | `src/bin/gpfdist/` + `gpcontrib/gp_exttable_fdw` | gpfdist 文件分发服务 + 外部表 |
| 分区表 | `src/backend/partitioning/` | 分区裁剪与分区选择算子 |
| 外部表 / FDW | `src/backend/foreign/`、`gpcontrib/pxf_fdw` | FDW 框架 + Cloudberry 扩展 |
| 过程语言 | `src/pl/{plpgsql,plpython,plperl,tcl}` | PL/pgSQL、PL/Python3、PL/Perl、PL/Tcl |
| 集群管理 | `gpMgmt/bin/` | gpinitsystem/gpstart/gpstop/gpssh/gpconfig 等 Python 工具 |
| PostgreSQL 14 内核 | `src/backend/{access,storage,executor,...}` | 上游 PG 14.4 合并，继承分区/逻辑复制/统计改进 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C | 核心 | PostgreSQL 14 内核 + cdb 分布式执行层 |
| C++ | 核心 | GPORCA 优化器（libgpopt/libnaucrates/libgpos/libgpdbcost/server） |
| Python | 管理 | gpMgmt 集群管理工具（gppylib，依赖 psutil/psycopg2/pyyaml） |
| meson + autoconf/make | 构建 | `meson.build` 主力 + `configure.ac`/`GNUmakefile.in` 兼容 |
| libxml2 | 可选 | XML 支持（DXL、gpdb-doc） |
| gssapi | 可选 | GSSAPI 认证 |
| perl / python | 可选 | PL 过程语言 UDF |
| PostgreSQL 14.4（上游） | 基座 | Cloudberry 跟踪合并上游 PG release，diff 集中在 cdb/gpopt/gporca/fts/optimizer |

### 版本历史

Cloudberry 的版本脉络与 Greenplum 既同源又分叉：`1.x` 系列对应早期 Greenplum 开源基线；`2.0.0-incubating`（2025-08）、`2.1.0-incubating`（2026-02）是进入 Apache 软件基金会孵化器后的正式 release，基于 PostgreSQL 14.4 内核（较 Greenplum 7 的 PostgreSQL 12 更新一截）；而 `main` 分支持续滚动开发下一代 3.0.0（`PACKAGE_VERSION=3.0.0-devel`），进一步跃升到 PostgreSQL 16.x 内核。本解读基于 `2.1.0-incubating` release tag（commit `bdf90c5518f`，2026-02-05）——这是 Apache 孵化器的最新正式 release，CBDB 并行查询与 AQUMV 等原创能力均已包含其中。release tag 位于独立的发布分支（未合并回 `main`），从 `main` HEAD 能到达的最近 tag 是较旧的 `1.6.0`（2024-09），故本解读显式 checkout `2.1.0-incubating` tag 作为基线。

## 快速上手

以 demo 集群最快看到 Cloudberry "跑起来"为例（节选自仓库 `README.md` 与 `gpAux/gpdemo`，验证后复用）：

```bash title="build & demo cluster"
# 配置（Cloudberry 用 meson 为主构建，这里给出传统 configure 兼容路径）
./configure --with-perl --with-python --with-libxml --with-gssapi --prefix=/usr/local/cbdb

# 编译安装
make -j8
make -j8 install

# 启动单机 demo 集群（1 coordinator + N segment）
cd gpAux/gpdemo
make create-demo-cluster
source gpdemo-env.sh   # 含 PGPORT 与 COORDINATOR_DATA_DIRECTORY
```

也可用仓库提供的 Docker 沙箱（`devops/sandbox`）零编译体验。端到端验证——连上 coordinator，执行一条会跨 segment 重分布的聚合查询：

```sql title="psql 连 demo 集群"
psql -p $PGPORT -d postgres
-- 关掉 ORCA 对比 PG planner（可选）
-- set optimizer=off;
SELECT gp_segment_id, count(*) FROM generate_series(1,1000000) g(id) GROUP BY gp_segment_id;
-- 预期：多行，每行一个 segment id，count 之和=1000000
```

`gp_segment_id` 是 Cloudberry 特有的隐含列，返回数据所在 segment 编号——它能"跑起来"即证明查询已被拆分到多个 segment 并行执行。`DATADIRS`/`PORT_BASE`/`NUM_PRIMARY_MIRROR_PAIRS`/`WITH_MIRRORS` 可在 `make create-demo-cluster` 时调整集群规模与镜像。

## 代码目录

```text
cloudberry/
├── src/                    # 核心源码（PostgreSQL 14 内核 + Cloudberry 扩展）
│   ├── backend/            # 服务端：parser/access/storage/executor/utils/optimizer(继承PG) + cdb/gporca/gpopt/fts(Cloudberry专属)
│   │   ├── cdb/            # ★ MPP 分布式执行层（Motion/interconnect/dispatch/gang/DTX/AO存储）
│   │   │   ├── motion/     #   interconnect 收发：cdbmotion.c/tupser.c/ic_proxy_bgworker.c
│   │   │   └── dispatcher/ #   Gang 派发：cdbgang.c/cdbdisp*.c/cdbdispatchresult.c
│   │   ├── gporca/         # ★ GPORCA 代价优化器（C++：libgpopt/libnaucrates/libgpos/libgpdbcost/server）
│   │   ├── gpopt/          # ★ PostgreSQL↔ORCA DXL 翻译桥（C++ translator 库）
│   │   ├── fts/            # ★ 容错服务（顶层目录：ftsprobe.c/ftsmessagehandler.c/fts.c）
│   │   ├── optimizer/      # ★ PG planner + CBDB 并行 + AQUMV（含 README.cbdb.parallel/aqumv）
│   │   ├── executor/       #   执行引擎 + Motion/Gather/Split 算子（nodeMotion.c/nodeGather.c/nodeSplitUpdate.c）
│   │   └── ...             #   parser/access/storage/commands/catalog/utils/replication 等 PG 继承目录
│   ├── bin/                # 客户端工具（psql/pg_dump + gpfdist/gpnetbench）
│   ├── include/           # 头文件
│   ├── interfaces/        # libpq / gppc / ecpg 客户端接口
│   ├── pl/                # 过程语言（plpgsql/plpython/plperl/tcl）
│   ├── test/              # 回归与隔离测试（regress/isolation2/walrep/...）
│   └── tools/            # pgindent/gdb 等开发工具
├── gpMgmt/                # 集群管理 CLI（Python：gpinitsystem/gpstart/gpstop/gpssh/gpconfig/gpcheckcat）
├── gpAux/                 # 发布脚本 + gpdemo demo 集群 + extensions
├── gpcontrib/             # Cloudberry 专属扩展（gp_toolkit/diskquota/orafce/pxf_fdw/gp_exttable_fdw/gp_stats_collector）
├── contrib/              # PostgreSQL contrib 扩展
├── config/ .github/ devops/  # 构建配置、CI、Docker 沙箱
└── configure / meson.build / GNUmakefile.in  # 构建（meson 为主 + autoconf 兼容）
```

一级目录职责：`gpMgmt/` 是 Cloudberry 专属的集群管理命令行工具（`gpinitsystem`/`gpstart`/`gpstop`/`gpssh`/`gpconfig`，多为 Python）；`gpAux/` 含发布脚本与 vendored 依赖，`gpdemo/` 提供单机 demo 集群；`gpcontrib/` 类似 PostgreSQL 的 `contrib/`，放 Cloudberry 专属扩展（含 `diskquota` 配额、`pxf_fdw` 外部数据、`gp_stats_collector` 统计采集）；`src/backend/cdb/` 是最大的 Cloudberry 专属后端模块——segment 间通信、计划并行化、镜像、分布式事务与快照管理；`src/backend/gpopt/` 是调用 GPORCA 的 "translator" 库（C++，DXL 与 PostgreSQL 内部表示互译）；`src/backend/gporca/` 是 GPORCA 优化器本体（C++）；`src/backend/fts/` 在 Cloudberry 中提升为顶层后端目录，运行于 coordinator、周期探测 segment 状态的容错进程；`src/backend/optimizer/` 除继承 PG planner 外，还承载了 CBDB 并行查询与 AQUMV 两个原创能力（各有一份 `README.cbdb.*` 设计文档）。

## 架构设计解析

### 系统架构

Cloudberry 的设计思想与 Greenplum 一脉相承——把单机 PostgreSQL 的执行引擎"横向切开"成共享无盘集群：每个 segment 是一个独立 PostgreSQL 14 实例只管本地数据；coordinator 也是 PostgreSQL 实例但不存用户数据，只负责接收连接、把查询计划切成可并行执行的片段、派发执行、汇总结果。这样 OLAP 扫描/聚合的吞吐随 segment 数近线性扩展，而单机 PostgreSQL 的执行器、存储、事务机制大部分得以复用。**Cloudberry 的 diff 相比上游 PostgreSQL 14，集中在三件事上**：如何把一个计划变成并行计划（`cdb` 插入 Motion）、如何让 segment 间交换数据（interconnect）、如何保持分布式一致性（分布式事务/快照/容错）——以及它独有的"如何在 MPP 之上再做一层节点内并行"（CBDB 并行查询）和"如何在优化期用物化视图加速"（AQUMV）。

![Cloudberry 分层架构](/vibe-reading/images/articles/cloudberry-internals/architecture.svg)

纵向分五层：客户端用 libpq 协议连 coordinator；接口层 `postmaster` 管理进程、`tcop/postgres.c` 的 `exec_simple_query` 处理查询；优化器层入口 `standard_planner`，`optimizer=on` 时走 GPORCA（经 `gpopt` 翻译桥调 `gporca` 的 Cascades 引擎产出 DXL 计划再翻回 PG Plan），否则走 PostgreSQL planner（`optimizer/`）；无论哪条路径，计划最终都经 `cdb` 插入 Motion 节点改写为可并行形态；分布式执行层 `cdb` 负责派发/gang/互连/Motion/分布式事务，`executor/` 的 Volcano 迭代器实际驱动计划树；存储与容错层是 PostgreSQL 继承的 `access`/`storage` 加 Cloudberry 的 `fts` 与 `gpMgmt`。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|------------------------|
| 客户端层 | `src/bin/psql`、外部 JDBC/ODBC | 隔离协议细节，提供统一入口 |
| 接口与进程层 | `postmaster`、`tcop/`、`libpq/` | 管理进程生命周期与连接，保护核心不受协议变化影响 |
| 优化器层 | `optimizer/`（含 CBDB 并行 + AQUMV）、`gpopt/`、`gporca/` | 把 Query 变成可执行最优计划，MPP 多维属性 + 节点内并行 + MV 改写驱动搜索 |
| 分布式执行层 | `cdb/`、`executor/nodeMotion.c` | 把计划切成片段派发 segment、建立互连、协调分布式事务 |
| 存储与容错层 | `access/`、`storage/`、`fts/`、`gpMgmt/` | 持久化（含 AO 存储）+ 集群拓扑保活与运维 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Cascades（Memo + 规则 + 多阶段搜索） | `gporca` `CGroup`/`CGroupExpression`/`CXform`/`CEngine` | MPP 多维正交物理属性（order/distribution/rewindability）需需求驱动搜索，自底向上 DP 处理不了 |
| Locus 类型系统 + Motion 类型转换 | `cdb/cdbpathlocus.c` + `cdbpath.c:193` 决策矩阵 | 声明式 + 组合性，collocation 检查跳过冗余 Motion |
| Strategy 虚表（`MotionIPCLayer`） | `cdb/ml_ipc.h:36` + `contrib/interconnect/ic_modules.c` | 互联传输协议可插拔（TCP/UDPIFC/Proxy），运行时 GUC 选择 |
| 翻译器 / 中性中间表示 | `gpopt` 三大 Translator + DXL | 解耦 PG C 结构与 ORCA C++ 对象（内存/类型/异常隔离） |
| Context 对象 + 映射表 | `gpopt` `CContextQueryToDXL`/`CContextDXLToPlStmt` + `CMappingVarColId` | 翻译全程可变状态从函数抽出；PG `Var` 三元组与 DXL `ColId` 整数双向转换 |
| CBDB "all workers equal" 并行 | `optimizer/planner.c:603-609` 保留 partial_pathlist + `cdbpathlocus.c` HashedWorkers | 让 worker 拥有完整 QE 上下文（分布式事务/快照/角色），避免 PG Gather leader 缺上下文 |
| 基于代价的等价转换 | `optimizer/plan/aqumv.c:571-578` 比 `total_cost` | 多个合法 MV 候选或原表有索引更便宜时，让 planner 选最优 |
| Volcano 迭代 pull | `executor/execMain.c:2707` `ExecutePlan` + `executor.h:278` `ExecProcNode` | 上层按需拉取，反压天然内建，网络 I/O 封装在算子里 |
| 后台 Worker + 状态机 | `fts/ftsprobe.h:30` `FtsMessageState` + `postmaster` `PMAuxProcList` 注册 | 多进程事务隔离 + 崩溃重启；故障判定流程显式化避免误判 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `PlannedStmt` + `PlanSlice`/`ExecSlice` | 可执行计划 + 并行切片 | 一次查询 | 含 Motion 节点与 slice 表，由 planner/gpopt 产生 |
| `CdbPathLocus` | 元组在 segment 间的分布（类型+distkey+numsegments+parallel_workers） | 计划期 | 驱动 Motion 插入；`Hashed`/`SegmentGeneral`/`Strewn` 等 |
| `Motion`（算子） | 数据重分布（Gather/Redistribute/Broadcast/Explicit） | 计划执行期 | 连接 segment 间 producer/consumer，由 cdbpath 插入 |
| Gang | 一组 segment 工作进程（reader/writer） | 一次查询/事务 | dispatcher `AllocateGang` 按需创建，FTS 保活 |
| `CGroup`/`CGroupExpression`（ORCA Memo） | 等价表达式分组 | 一次优化 | Cascades 搜索的载体 |
| `DistributedSnapshot` | 全局一致事务视图（xmin/xmax/inProgressXidArray） | 一次查询快照 | QD 建→序列化派发→QE 三级缓存可见性判断 |
| `FtsProbeInfo`（共享内存） | segment 健康状态版本 | 集群期 | FTS 写、dispatcher 读 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|----------|--------|----------|
| `COperator`（ORCA 算子基类） | `gporca/libgpopt/.../operators/COperator.h` | `CLogical`/`CPhysical`/`CScalar`/`CPattern` 子类 | 工厂 + xform `Implement` 生成物理算子 |
| `CXform`（变换规则） | `gporca/libgpopt/.../xforms/CXform.h` | `CXformExploration`/`CXformImplementation`（~120 条） | `CXformFactory::Instantiate` 全局单例 |
| `MotionIPCLayer`（互联虚表） | `src/include/cdb/ml_ipc.h:36` | `tcp_ipc_layer`/`udpifc_ipc_layer`/`proxy_ipc_layer` | `ic_modules.c:_PG_init` 经 `RegisterIPCLayerImpl` 注册，`gp_interconnect_type` GUC 选 |
| `PlanState`→`ExecProcNode` 回调 | `src/include/executor/executor.h:278` | 各算子 `ExecXxx`（`ExecMotion`/`ExecGather`/`ExecSeqScan`…） | `ExecInitXxx` 中 `ExecSetExecProcNode` 注册 |

## 模块地图

![Cloudberry 模块依赖关系](/vibe-reading/images/articles/cloudberry-internals/module-dependencies.svg)

模块间的依赖方向沿查询生命周期形成：客户端请求经 `tcop/postgres.c` 进入，`optimizer` 产计划（`optimizer=on` 时经 `gpopt` 桥调 `gporca`），`cdb` 把计划改写为可并行形态（插 Motion）并派发到 segment，`executor` 用 Volcano 迭代器驱动含 Motion 的计划树，`fts` 横向保活 segment 拓扑供 dispatcher 查询。`cdb` 是依赖最密集的中枢——被 optimizer/executor/xact 调、依赖 postmaster/libpq/access/storage；`fts` 与 `cdb` 双向协作（dispatcher 问 FTS 状态、FTS 更新 catalog 通知 dispatcher 重建 gang）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|---------|
| 分布式执行内核 | Locus 驱动 Motion 插入、Gang 派发、interconnect、分布式事务/快照 | `cdb/cdbpath.c:193`、`cdb/dispatcher/cdbdisp_query.c:184` | 承担"把单机 PG 变 MPP"的全部 diff，是 Cloudberry/Greenplum 的立身之本 | [分布式执行内核](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/01-cdb) |
| 查询优化器 | PG planner + CBDB 并行查询 + AQUMV 物化视图改写 | `optimizer/plan/planner.c:356` | 承载 Cloudberry 两项原创能力（CBDB 并行 + AQUMV），区别于 Greenplum | [查询优化器](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer) · [CBDB 并行详解](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer-cbdb-parallel) |
| GPORCA 优化器 | Cascades 框架的 C++ 代价优化器，ORCA 路径产出物理计划 | `gporca/libgpopt/.../COptimizer.h` `PdxlnOptimize` | 独立 C++ 体系（GPOS 内存/异常），用 Cascades 处理 MPP 多维属性 | [GPORCA 优化器](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/02-gporca) |
| DXL 翻译桥 | PG Query/Plan ↔ ORCA DXL 双向翻译 | `gpopt/CGPOptimizer.cpp:45` | 解耦 C 内核与 C++ 优化器，内存/类型/异常隔离 | [DXL 翻译桥](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/03-gpopt) |
| 执行引擎 | Volcano 迭代 pull 驱动 Plan 树，Motion/Gather/Split 算子 | `executor/execMain.c:246`、`nodeMotion.c:100` | 把网络 I/O 与分布式更新隐藏在迭代器背后 | [执行引擎](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/05-executor) |
| 容错服务 | 周期探测 primary/mirror，故障协调 mirror 提升 | `fts/fts.c:279` `FtsLoop`、`ftsprobe.c:1297` | MPP 集群高可用决策中枢，单点决策避免脑裂 | [容错服务](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/06-fts) |

## 运行时行为

### 启动流程

coordinator 的 `postmaster` 启动时注册若干后台进程：FTS probe 经 `PMAuxProcList` 注册（`FtsProbeStartRule` 只在 `Gp_role==GP_ROLE_DISPATCH` 返回真，`BgWorkerStart_DtxRecovering` DTX 恢复期即起）；`ic_proxy_bgworker` 在每个 segment 作 bgworker 启一个 interconnect 代理。QE 后端进程由 postmaster 按 segment 配置 fork，等待 QD 经 libpq 派发的 'M' 消息。

一次查询的入口装配在 `ExecutorStart`（`execMain.c:246`）：`CreateExecutorState` 建 `EState` → QD 侧 `InitSliceTable`（`:450`）构建 slice 表 → `createMotionLayerState`（`:472`）建 motion layer → QE 侧 `SetupInterconnect`（`:531`）建立 interconnect → `InitPlan`（`:580`）调 `ExecInitNode` 把 Plan 树转 PlanState 树（`ExecInitMotion` 在 `:666` 按 `LocallyExecutingSliceIndex` 定 Motion 的 send/recv 角色）→ QD 侧 `CdbDispatchPlan`（`:693`）序列化计划树+DTX 上下文，`AllocateGang` 建 segment 进程组、`cdbdisp_dispatchToGang_async` 经 libpq 非阻塞派发 'M' 消息。对象装配的核心是 `EState`——它持有 `motionlayer_context`/`interconnect_context` 两个上下文，是 executor 与 cdb 交互的桥梁；Gang 由 dispatcher 工厂 `AllocateGang`（`cdbgang.c:107`）按 slice 需求创建，从 QE 连接池取/建 `SegmentDatabaseDescriptor`。

### 核心运行流程

下面追踪 Cloudberry 最核心的业务链路——一次分布式 SELECT 的端到端执行。它串联了从客户端请求到 segment 并行执行再到结果汇总的全过程，覆盖优化器（ORCA/PG 双路径）、cdb（Motion 改写+派发+interconnect）、executor（Volcano 驱动）三大模块。

#### 查询处理主链路：分布式 SELECT

业务流程：客户端发 SQL → QD 解析/分析/重写 → 优化（ORCA 或 PG planner，cdb 插 Motion）→ 派发到 segment → segment 并行执行经 interconnect 交换 → Gather 汇总 → 返回客户端。

![分布式 SELECT 数据流](/vibe-reading/images/articles/cloudberry-internals/data-flow.svg)

文字描述：入口 `exec_simple_query`（`tcop/postgres.c:1652`）先 `start_xact_command` 开事务，`pg_parse_query`（flex/bison）产 `RawStmt` 列表，`pg_analyze_and_rewrite_fixedparams` 经 `parse_analyze` 绑类型/解表名产 `Query`、`QueryRewrite` 应用规则重写。`pg_plan_query` → `planner` → `standard_planner`（`planner.c:356`）在此分流：`optimizer=on` 且 QD 时走 ORCA（`orca.c:202` `optimize_query` → `gpopt` `CGPOptimizer::GPOPTOptimizedPlan` → `COptTasks::OptimizeTask` 做 Query→DXL→`COptimizer::PdxlnOptimize` Cascades 搜索→DXL→`PlannedStmt`，ORCA 在 DXL 阶段直接生成 Motion 节点），失败 fallback PG planner（`subquery_planner`→`grouping_planner`→`query_planner`→`make_one_rel`，经 `cdbpath_create_motion_path` 在 Path 层插 `CdbMotionPath`、`cdbllize_adjust_top_path`/`cdbllize_build_slice_table` 顶层并行化+建 slice 表）。两条路径都产出含 Motion 节点的 `PlannedStmt`。`PortalStart`（`pquery.c:551`）建 `QueryDesc`，`ExecutorStart` 装配 `EState`+slice 表+interconnect+`PlanState` 树，并 `CdbDispatchPlan`（`cdbdisp_query.c:184`）经 `AssignGangs`→`AllocateGang` 建 Gang、`buildGpQueryString` 序列化、`cdbdisp_dispatchToGang_async` 经 libpq 非阻塞派发 'M' 消息到各 QE。`PortalRun`→`ExecutorRun`→`ExecutePlan`（`execMain.c:2707`）`for(;;) ExecProcNode(planstate)` 逐行 pull：QD root slice 的 receiver Motion 经 interconnect `RecvTupleFrom` 收 segment 中间结果，`dest->receiveSlot` 发客户端。QE 侧 `exec_mpp_query`（`postgres.c:1110`）反序列化 `PlannedStmt`+`SliceTable`，按 `qe_identifier` 找本地 slice，`SetupInterconnect` 建网络，从某 sender Motion 节点切入执行，tuple 经 `SendTuple` 发出而非本地返回。QD `mppExecutorWait`（`execUtils.c:2085`）`poll(POLLIN)` 等所有 QE 完成、`cdbdisp_getDispatchResults` 收结果或错误。

#### 故障切换链路：segment failover

业务流程：primary segment 故障 → FTS 探测失败重试耗尽 → 检查 mirror in-sync → 更新 catalog 翻转角色 → 发 PROMOTE → mirror 提升为新 primary → dispatcher 感知拓扑变化重建 Gang。

文字描述：`FtsLoop`（`fts/fts.c:279`）每 `gp_fts_probe_interval`（默认 60s）或被 latch 唤醒跑一轮 `FtsWalRepMessageSegments`（`ftsprobe.c:1297`）——`ftsConnect` 异步 libpq 连 primary、`ftsPoll` 多路复用、`ftsSend` 发 `PROBE dbid=X contid=Y`、`ftsReceive` 收 5 列 bool 响应。primary 探测失败重试 `gp_fts_probe_retries`（5）次后进 `FTS_PROBE_FAILED`：`checkIfFailedDueToNormalRestart` 先排除正常重启；若 mirror `SEGMENT_IS_IN_SYNC` 则 `updateConfiguration`（`ftsprobe.c:1134`）**先更新 catalog**（旧 primary→mirror+down+notinsync、新 primary→primary+up+notinsync、`FTS_STATUS_SET_DOWN` 更新共享内存 `status[]`），再 `FTS_PROMOTE_SEGMENT` 向新 primary 发 `PROMOTE`，`HandleFtsWalRepPromote`（`ftsmessagehandler.c:377`）`SignalPromote` 发 SIGUSR1 触发 PG promotion；若 mirror not in-sync 判 double fault 不提升。`status_version++` 让 dispatcher 下次获取拓扑发现版本变化、重建 Gang 用新配置。状态全貌见下方状态流。

### 状态流

![segment failover 状态流](/vibe-reading/images/articles/cloudberry-internals/state-flow.svg)

`FtsMessageState`（`src/include/postmaster/ftsprobe.h:30`）定义了 FTS 探测每个 primary-mirror pair 的完整状态机，由 `nextSuccessState()`/`nextFailedState()`（`ftsprobe.c:57-127`）驱动转移。完整状态：`FTS_PROBE_SEGMENT`（发 probe）→ 成功 `FTS_PROBE_SUCCESS` → 处理后终态 `FTS_RESPONSE_PROCESSED`；失败 `FTS_PROBE_FAILED` → 重试 `FTS_PROBE_RETRY_WAIT`（1 秒）→ 回 `FTS_PROBE_SEGMENT`；重试耗尽后由 `processResponse`（`:981`）按 mirror 状态分流：in-sync → `updateConfiguration` 角色互换 → `FTS_PROMOTE_SEGMENT` → 成功 `FTS_PROMOTE_SUCCESS` → 终态 / 失败 `FTS_PROMOTE_FAILED` → 终态（double fault）；mirror not in-sync → double fault 直达终态；PM 正常重启 → 直达终态。segment 的 role/status/mode 三字段组合（`fts_comm.h:73-80`：`p`/`m` × `u`/`d` × `s`/`n`）表达运行/宕机/同步状态，failover 时由 `probeWalRepUpdateConfig`（`fts.c:177`）翻转。

## 典型修改场景

#### 场景 1：新增一种 Motion/Locus 类型

要新增一种数据分布方式（如范围分区分布）。需改 [cdb](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/01-cdb)：`cdbpathlocus.h` 的 `CdbLocusType` 加枚举值 + `CdbPathLocus_MakeXxx` 宏；`cdbpathlocus.c` 更新 `cdbpathlocus_equal`/`cdbpathlocus_join`；`cdbpath.c:193` 的 `cdbpath_create_motion_path` 决策矩阵加新类型转换；`plannodes.h:1636` 的 `MotionType` 加值；`cdbmutate.c` 加 `make_xxx_motion` 构造函数；`cdbmotion.c` 的 `SendTuple` 加路由、`addChunkToSorter` 加接收。对应测试：`src/test/regress/`。

#### 场景 2：新增一种 AQUMV 改写规则

要扩展 MV 改写支持 Sublink/Join（当前 MVP0 不支持）。需改 [查询优化器](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer)：放宽 `aqumv.c:164-177` 的排除条件（移除 `hasSubLinks` 排除）；`aqumv_process_from_quals`（`:750`）增加跨关系 qual 比较；`aqumv_adjust_sub_matched_expr_mutator`（`:785`）处理 `makeVar` 的 varno（当前硬编码 `1`）；必要时扩展 `gp_matview_aux` catalog 表结构。对应测试：`src/test/regress/`。

#### 场景 3：新增一种互联传输协议

要支持新网络协议（如 RDMA）。需改 [cdb](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/01-cdb)：新建 `contrib/interconnect/rdma/` 实现 `MotionIPCLayer`（`ml_ipc.h:36`）全部约 20 个函数指针（`SetupInterconnect`/`SendChunk`/`RecvTupleChunkFromAny` 等）；`ic_modules.c` 建 `rdma_ipc_layer` 常量并 `RegisterIPCLayerImpl` 注册；`cdbvars.h:292` 加 `INTERCONNECT_TYPE_RDMA`；`guc_gp.c` 更新 `gp_interconnect_type` 可选值。对应测试：`contrib/interconnect/test/`。

## 阅读源码推荐路线

- **第一遍：理解查询主流程**
  `src/backend/tcop/postgres.c` 的 `exec_simple_query()`（`:1652`）→ `src/backend/optimizer/plan/planner.c` 的 `standard_planner()`（`:356`）→ `src/backend/executor/execMain.c` 的 `standard_ExecutorStart`（`:246`）+ `ExecutePlan`（`:2707`）→ `src/backend/executor/nodeMotion.c` 的 `ExecMotion`（`:100`）。建立"SQL → 计划 → Motion 改写 → 派发 segment → Volcano 拉取"的整体认知。
- **第二遍：理解分布式执行内核**
  `src/include/cdb/cdbpathlocus.h` 的 `CdbPathLocus`（`:154`）与 Locus 类型枚举（`:39-69`）→ `src/backend/cdb/cdbpath.c` 的 `cdbpath_create_motion_path`（`:193`）决策矩阵 → `src/backend/cdb/dispatcher/cdbgang.c` 的 `AllocateGang`（`:107`）→ `src/backend/cdb/motion/cdbmotion.c` 的 `SendTuple`/`RecvTupleFrom` → `contrib/interconnect/ic_modules.c` 的三种 IPC 层注册。理解 Locus 如何驱动 Motion、Gang 如何建、tuple 如何跨 segment 流。
- **第三遍：理解 Cloudberry 原创能力（区别于 Greenplum）**
  `src/backend/optimizer/README.cbdb.parallel` + `README.cbdb.aqumv` 两份设计文档 → `src/backend/optimizer/plan/planner.c:603-609` 保留 partial_pathlist → `src/backend/optimizer/plan/aqumv.c:133` 的 `answer_query_using_materialized_views` + `src/backend/catalog/gp_matview_aux.c`。理解 CBDB 并行的"所有 worker 平等"与 AQUMV 的"基于代价等价转换"两项原创设计。
- **第四遍：理解优化器双路径与容错**
  选其一深入：ORCA 路径读 `src/backend/gpopt/utils/COptTasks.cpp` 的 `OptimizeTask`（`:883`）+ `src/backend/gporca/libgpopt/src/optimizer/COptimizer.cpp` 的 `PdxlnOptimize`；容错读 `src/backend/fts/ftsprobe.c` 的 `processResponse`（`:981`）+ `FtsMessageState` 状态机。若有深度解读附件从模块文件链接进 [CBDB 并行详解](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer-cbdb-parallel)。

## 附录

### 术语表

| 术语 | 解释 |
|------|------|
| QD / QE | Query Dispatcher（coordinator）/ Query Executor（segment 进程） |
| MPP | Massively Parallel Processing，大规模并行处理 |
| Motion | 把数据在 segment 间重分布的算子（Gather/Redistribute/Broadcast） |
| Locus | 元组在 segment 间的分布属性，MPP 计划的类型系统 |
| Gang | 一组 segment 工作进程（reader/writer） |
| Slice | 查询的并行分片，每个 Motion 切出一个 slice |
| interconnect | segment 间互连网络（TCP/UDPIFC/Proxy 三种可插拔） |
| DXL | Dynamic eXchange Language，ORCA 的 XML 中间表示 |
| Cascades | 自顶向下的记忆化查询优化搜索框架 |
| CBDB | Cloudberry 的代码前缀（README.cbdb.*） |
| AQUMV | Answer Query Using Materialized Views，planning 期物化视图改写 |
| IMV | Incremental Materialized View，基表写入时自动增量更新的物化视图 |
| FTS | Fault Tolerance Service，coordinator 上的 segment 容错探测服务 |
| 2PC / DTX | 两阶段提交 / 分布式事务 |

### 参考资料

- [Apache Cloudberry 官方文档](https://cloudberry.apache.org/docs)
- [Cloudberry GitHub 仓库](https://github.com/apache/cloudberry) · [DeepWiki](https://deepwiki.com/apache/cloudberry)
- 本仓库 `src/backend/optimizer/README.cbdb.parallel`（CBDB 并行查询设计）与 `README.cbdb.aqumv`（AQUMV 设计）
- 本仓库 `src/backend/fts/README`（FTS 架构文档）
- [Greenplum 7 CodeWiki](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/00-overview)（同源前序项目，共享 cdb/gporca/gpopt/fts 架构）
