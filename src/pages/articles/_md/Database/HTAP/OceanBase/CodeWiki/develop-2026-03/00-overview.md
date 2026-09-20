---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "Overview"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "C++", "分布式数据库", "Paxos", "LSM-Tree"]
description: "OceanBase develop-2026-03 快照源码解读概览：单进程多租户 + Paxos 复制 + LSM-Tree 的分布式 HTAP 数据库，约 706 万行 C++。"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** develop-2026-03 · **解读基线** commit [`1091216115`](https://github.com/oceanbase/oceanbase/commit/109121611519b2f74bcf154ed8fcbcde7984df19)（2026-03-16，develop 分支快照，介于 v4.5.0_CE 与后续 release 之间） · **协议** MulanPubL-2.0 · **语言** C++ · **代码量** ~706 万行（src/ + deps/oblib + deps/easy，含约 80 万行生成代码） · **仓库** [GitHub](https://github.com/oceanbase/oceanbase)

---

## 总览

### 项目简介

OceanBase 是蚂蚁集团完全自研的分布式关系数据库：一台 observer 进程跑在一台普通服务器上，多台 observer 组成对等集群，靠 Paxos 协议做多副本强一致。它的核心价值是**用廉价通用服务器堆出金融级可用性（RPO=0、RTO<8s）和线性扩展能力**——官方记录做到过 1500 节点、PB 数据、万亿行的单集群，以及 TPC-C 7.07 亿 tmpC、TPC-H 1526 万 QphH 的成绩。核心使用场景是金融级 OLTP、HTAP 混合负载（行列混合存储 + 并行查询）以及云上多租户数据库服务。

项目当前边界：单机 observer 内**不包含** SQL 代理层（obproxy 是独立项目）、不包含 OCP/ODC 等管控运维平台、也不包含分布式文件系统（依赖本地磁盘 + 外部对象存储做备份归档）。列存与向量检索能力在快速演进中（本快照含 C-Replica、vector_index、FTS 等大量新代码）。

### 功能矩阵

| 特性 | 实现位置（模块文档） | 说明 |
| --- | --- | --- |
| MySQL 协议兼容 | [Observer](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/01-observer) | `ObMPQuery` 等 30+ 命令包处理器，Oracle 模式语法走闭源 parser |
| 多租户资源隔离 | [Observer](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/01-observer) | 单进程内 unit 配额 + cgroup + 资源组队列 |
| SQL 编译与优化 | [SQL 编译前端](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/03-sql-compile) | 规则改写 + cost-based 候选计划枚举（非 Cascades） |
| 向量化执行 / PX 并行 | [SQL 执行引擎](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/04-sql-engine) | Volcano 算子 + 表达式批处理 + QC/DFO/SQC 三级并行 |
| 存储过程 / 触发器 | [PL/SQL 引擎](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/10-pl) | LLVM ORC JIT 生成本机代码 |
| LSM-Tree 存储引擎 | [存储引擎](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/05-storage) | tablet + memtable + SSTable（宏块/微块）+ compaction |
| 分布式事务 | [事务引擎](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/06-transaction) | 2PC 日志驱动 + MVCC + 死锁检测 |
| Paxos 复制与选举 | [日志服务](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/07-logservice) | Palf（Multi-Paxos 日志库）+ LogStream |
| DDL / 均衡 / 容灾调度 | [RootServer](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/08-rootserver) | 任务状态机全部落内部表，RS 无状态可重启 |
| 多版本 Schema 服务 | [Schema 与共享服务](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/09-share) | 内存快照 + copy-on-write 发布 |
| 备份恢复 / 主备 / CDC | [HA·备份·CDC](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/11-ha-backup-cdc) | 物理备份 + 归档日志 + libobcdc 增量外发 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++（bison 2.4.1 锁版本） | 核心 | 全部核心代码；SQL/PL 语法表由固定版本 bison 生成，冲突即构建失败 |
| LLVM（ORC JIT） | 核心 | PL/SQL 编译为本机代码（`src/objit/` 封装，隔离 LLVM 头文件不污染主二进制） |
| libeasy（魔改） | 核心 | Reactor 网络库：MySQL 协议 + 内部 RPC 的 IO 线程底座（`deps/easy/`） |
| flex/bison + Python 生成器 | 构建 | parser、系统变量（`gen_ob_sys_variables.py`）、内部表 schema（`generate_inner_table_schema.py`，约 80 万行生成代码）、系统包注册表（`syspack_codegen.py`） |
| RocksDB | 可选 | libobcdc 中间任务落盘（防内存膨胀） |
| OpenSSL / ISA-L 等 | 可选 | 传输加密、SIMD 压缩与正则 |

### 版本历史

- **2010–2020**：蚂蚁内部演进 0.5 版本，2019 年双 11 创下 TPC-C 世界纪录（闭源）。
- **2021.6 开源 3.1**：单体 SQL 引擎 + Partition Group（每分区一条 clog 流）架构。
- **2022.5 发布 4.0**：架构大重构——Partition Group 收敛为少量 **LogStream（日志流）**，每条日志流一个 Palf 实例；存储层引入 tablet；事务层 v4 系列重写。本快照即 4.x 之后的演进形态。
- **v4.2–v4.5（2023–2025）**：列存（C-Replica / 混合行列）、向量检索、FTS、共享存储（SS 模式，`OB_BUILD_SHARED_STORAGE` 条件编译）陆续进入。本 develop 快照落后 v4.5.0_CE tag 1554 个提交，介于 v4.5 与后续 release 之间。

---

## 快速上手

面向代码阅读者（Linux）的最短路径：

```bash
# 一键安装并拉起单机演示实例（observer + obproxy + obclient）
bash -c "$(curl -s https://obbusiness-private.oss-cn-shanghai.aliyuncs.com/download-center/opensource/oceanbase-all-in-one/installer.sh)"
source ~/.oceanbase-all-in-one/bin/env.sh
obd demo

# 端到端验证：MySQL 协议直连 2881 端口
mysql -h127.0.0.1 -P2881 -uroot@test -e "SELECT version(); SHOW TENANTS;"
```

源码编译（用于调试）：

```bash
sh build.sh --init        # 拉取子模块与依赖
sh build.sh debug --make -j8
```

> 集群的自举入口是 `obd demo` 触发的 bootstrap 流程（见 [RootServer](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/08-rootserver) 的 bootstrap 链路）。

---

## 架构设计解析

### 系统架构

OceanBase 的架构思想可以概括为一句话：**把"数据库集群"压缩进一台对等进程——每个 observer 都是全功能的（SQL + 事务 + 存储 + 日志复制），集群层再没有独立的计算或存储节点；RootServer 不是独立进程，而是内嵌在 observer 里、由 sys 租户 1 号日志流的 Paxos leader 身份激活的一组调度服务**。这样任何机器宕机，RS、leader、数据副本都能在剩余多数派上自动重生。

另一条主线是**单进程多租户**：一台 observer 进程内运行多个租户（每个租户有独立的日志流、内存配额、线程组、cgroup），把"数据库即服务"的高密度部署做进了进程内部，而不是靠虚拟机或容器。

![OceanBase 分层架构](/vibe-reading/images/articles/oceanbase/architecture.svg)

分层自上而下：

- **接入层**：`observer` 是进程入口与组装层（`main.cpp` 全仓库唯一入口）；`rootserver` 逻辑内嵌其中，所有调度服务以 MTL（Multi-Tenant Library）组件挂进租户，只有 sys LS leader 角色才真正 do_work。
- **SQL 引擎层**：编译前端（文本 → 物理计划）与执行引擎（Volcano 算子 + 向量化表达式 + DAS 数据访问 + PX 并行）分离，PL/SQL 引擎通过 SPI 完整借道 SQL 主链路。
- **分布式内核层**：logservice（Palf 日志流复制）、storage（LSM-Tree tablet 存储）、tx（2PC 事务）三个互相咬合的内核——tx 的 redo 经 logservice 复制、回放时按日志类型分发回 storage 与 tx。
- **共享服务层**：share 被几乎所有模块依赖（实测 `#include "share/schema/..."` 1409 处），多版本 schema、位置缓存、IO 调度（mClock）都在这里。
- **基础库层**：oblib 提供 Worker 线程模型、MemoryContext 内存体系、ObLatch 锁、RPC 框架；easy 是魔改过的 Reactor 网络库（线程创建被劫持、阻塞调用全量挂钩诊断）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接入层 | `src/observer/`、`src/rootserver/` | 隔离协议与进程生命周期；把集群调度做成无状态服务，故障后随 Paxos 重生 |
| SQL 引擎层 | `src/sql/`、`src/pl/`、`src/objit/` | 语句编译与执行；PL 借道 SQL 保证语义一致 |
| 分布式内核层 | `src/logservice/`、`src/storage/` | 一致性复制与数据存储；副本协议与数据结构解耦 |
| 共享服务层 | `src/share/` | 全局一致的元数据视图（schema/位置/统计）与资源调度 |
| 基础库层 | `deps/oblib/`、`deps/easy/` | 零业务依赖的地基：线程、内存、锁、RPC、网络 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `ObGlobalContext`（`GCTX` 宏，`src/share/ob_server_struct.h:221`） | 进程内 50+ 子系统互访唯一通道，指针只读不变更 |
| 模板方法 | `ObSqlProcessor::run`（`deps/oblib/src/rpc/frame/ob_sql_processor.cpp:20`）、`ObOperator::open/get_next_row`（`src/sql/engine/ob_operator.cpp`） | 骨架固定（安全检查/监控/filter），子类只填 `process()`/`inner_*()` |
| 编译期注册工厂 | `REGISTER_OPERATOR`（`src/sql/engine/ob_operator_reg.h:81`）、`REGISTER_DAS_OP`（`src/sql/das/ob_das_def_reg.h:45`）、`REGISTER_STMT_RESOLVER`（`src/sql/resolver/ob_resolver.cpp:215`） | 无运行时 if-else 链；新增算子/命令零侵入 |
| Copy-on-write 快照 | `ObSchemaMgrCache`（`src/share/schema/ob_schema_mgr_cache.h:116`） | schema 读完全无锁，写只在 slot 数组写锁内 |
| 状态机 + 轮询推进 | `ObDDLTask::process`（`src/rootserver/ddl_task/`）、`ObLSMigrationHandler`（`src/storage/high_availability/`） | 长任务（DDL/迁移）每步幂等非阻塞，RS 重启不丢 |
| DAG 任务框架 | `ObIDag/ObITask/ObDagNet`（`src/share/scheduler/`） | compaction、备份、迁移一切长活统一调度与重试 |
| 回调注入 | `PalfFSCb/PalfRoleChangeCb`（`src/logservice/palf/palf_callback.h`）、`ObITransCallback`（`src/storage/memtable/mvcc/ob_mvcc.h`） | 切断 palf→storage、事务→SQL 的反向依赖 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `ObTenant` | 租户实例（worker 池 + 请求队列 + 内存配额） | 随 RS 下发 unit 创建/删除 | 持有全部 MTL 服务 |
| `ObSQLSessionInfo` | 会话（sysvar、事务句柄、plan cache 引用） | 连接断开销毁 | 挂 `ObTxDesc` 事务描述符 |
| `ObPhysicalPlan` | 物理计划（`ObOpSpec` 树 + `ObExpr` 数组） | plan cache 淘汰 | 被 `ObOperator` 执行期实例化 |
| `ObTablet` | 4.0 后数据分区的唯一单位（元数据 ~1KB） | 建表/分裂创建，GC 回收 | 属于 `ObLS`；持 table store |
| `ObLS`（LogStream） | 日志流：一个 Palf 实例 + 一组 tablet 的宿主 | RS 创建/迁移 | 聚合 `ObLogHandler`、事务、tablet 服务 |
| `ObTxDesc` / `ObPartTransCtx` | 事务描述符（调度器侧）/ 参与者上下文 | 事务结束即回收 ctx，状态留 `ObTxData` | 经 `ObTxTable` 提供可见性 |
| `ObMemtable` | 内存增量（keybtree + MVCC 版本链） | freeze 后 flush 成 SSTable | 行锁即 MVCC 节点 |
| `ObSSTable` | 不可变基线（宏块-微块两级） | compaction 产生/回收 | `ObTabletTableStore` 持多版本链 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `ObITabletScan` | `src/share/ob_i_tablet_scan.h` | `ObAccessService`（本地表）、`ObVTableScanService`（虚拟表）、`ObExtTblAccessService`（外表） | DAS 按 `get_tsc_service()` 查表选择 |
| `IPalfEnv` / `IPalfHandle` | `src/logservice/ipalf/` | `PalfEnvImpl` / `PalfHandleImpl`；SS 形态可换 `LibPalfEnv` | `create_palf_env` 工厂 |
| `ObIReplaySubHandler` 等三件套 | `src/logservice/ob_log_base_type.h` | tablet/tx/DDL/锁/备份等 30+ handler | `REGISTER_TO_LOGSERVICE` 宏一次注册三处 |
| `ObITransCallback` | `src/storage/memtable/mvcc/ob_mvcc.h` | `ObMvccRowCallback`（行）、`ObOBJLockCallback`（表锁） | 每次写入注册，提交时驱动 |
| `ObIStorageMetaObj` | `src/storage/meta_mem/ob_meta_obj_struct.h` | `ObTabletTableStore`、`ObSSTable` 等 | `deep_copy` 进 kv cache 的通行证 |
| `ObIDASTaskOp` | `src/sql/das/ob_das_task.h:150` | `ObDASScanOp`、`ObDASUpdateOp` 等 | `REGISTER_DAS_OP` traits |

---

## 代码目录

```shell
oceanbase/
├── src/
│   ├── observer/          # 进程入口与组装层（main.cpp 唯一入口）
│   │   ├── mysql/         #   MySQL 协议命令包处理器（ObMPQuery 等 30+）
│   │   ├── omt/           #   多租户（ObMultiTenant/ObTenant/ObThWorker）
│   │   └── virtual_table/ #   ~300 个虚拟表迭代器
│   ├── rootserver/        # RS 集群总控（bootstrap、DDL 任务、均衡、unit、心跳）
│   │   ├── ddl_task/      #   DDL 任务状态机
│   │   └── standby/       #   主备库切换
│   ├── sql/               # SQL 引擎
│   │   ├── parser/ resolver/ rewrite/ optimizer/ plan_cache/
│   │   ├── engine/        #   执行算子 + expr 向量化 + px 并行
│   │   ├── das/           #   数据访问服务（本地/远程屏蔽）
│   │   ├── code_generator/ # 静态引擎计划生成器（LLVM JIT 已废弃）
│   │   └── session/       #   ObSQLSessionInfo
│   ├── pl/                # PL/SQL 引擎（编译器、resolver、系统包）
│   ├── objit/             # LLVM ORC JIT 封装（独立库隔离 LLVM 头）
│   ├── storage/           # 存储引擎
│   │   ├── tablet/ memtable/ blocksstable/ blockstore/ macro_cache/
│   │   ├── access/        #   多版本行融合迭代器
│   │   ├── compaction/ column_store/  # 合并调度、行列混合
│   │   ├── tx/ tx_table/ tablelock/   # 事务引擎
│   │   ├── ls/            #   LogStream 宿主
│   │   └── high_availability/ backup/ restore/  # 副本迁移、备份恢复
│   ├── logservice/        # 日志服务
│   │   ├── ipalf/ palf/   #   Palf 接口层与实现（含 election/）
│   │   ├── applyservice/ replayservice/ rcservice/  # apply/回放/角色切换
│   │   ├── archiveservice/ restoreservice/          # 归档、日志回补
│   │   └── libobcdc/ logfetcher/ cdcservice/        # 增量日志外发
│   ├── share/             # 共享服务（schema 多版本、location、IO、统计、内表生成代码）
│   └── plugin/            # 全文检索等插件接口
├── deps/
│   ├── oblib/             # 基础库（lib/ + rpc/ + common/）
│   └── easy/             # 魔改 Reactor 网络库
├── unittest/              # 单元测试（按模块镜像 src 结构）
├── mittest/                # 多副本集成测试（multi_replica/simple_server/…）
├── tools/                  # ob_admin 等运维工具
└── docs/                   # 编码规范、内存/日志说明
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/oceanbase/module-dependencies.svg)

模块间依赖的基本走向：observer 装配一切（持 `GCTX` 与 MTL 容器）；SQL 执行引擎经 DAS 直达 storage 的 `ObITabletScan` 接口（本地直函数调用，远程转 RPC）；事务的 redo 经 `ObLogHandler` 进 Palf；logservice 回放时反向调用 storage/tx 注册的 handler；share 与 oblib 是被全员依赖的地基。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Observer 进程与多租户 | 进程生命周期、协议接入、租户隔离 | `ObServer::init/start`、`ObMPQuery::process` | 进程组装与资源隔离自成体系 | [01-observer](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/01-observer) |
| oblib 基础库 | 线程/内存/锁/RPC/网络 | `Worker`、`ObMallocAllocator`、`ObRpcProxy` | 零业务依赖的可独立测试地基 | [02-oblib](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/02-oblib) |
| SQL 编译前端 | 文本 → 物理计划 | `ObSql::stmt_query` | 编译流水线自成缓存体系（plan cache/SPM/UDR） | [03-sql-compile](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/03-sql-compile) |
| SQL 执行引擎 | 计划执行 | `ObOperator::get_next_row` | Volcano + 向量化 + PX 与编译解耦 | [04-sql-engine](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/04-sql-engine) |
| 存储引擎 | LSM-Tree 数据结构 | `ObTablet`、`ObMemtable::set` | tablet/SSTable/compaction 是独立数据层 | [05-storage](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/05-storage) |
| 事务引擎 | 分布式事务 | `ObTransService::commit_tx` | 2PC/MVCC/锁与存储结构分离 | [06-transaction](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/06-transaction) |
| 日志服务与 Paxos | 复制状态机 | `ObLogHandler::append` | Palf 与业务完全解耦的可独立库 | [07-logservice](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/07-logservice) |
| RootServer | 集群总控 | `ObRootService::execute_bootstrap` | 调度域与数据域分离（RS 无状态） | [08-rootserver](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/08-rootserver) |
| Schema 与共享服务 | 全局元数据视图 | `ObMultiVersionSchemaService` | 多版本一致性读是全局横切关注 | [09-share](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/09-share) |
| PL/SQL 引擎 | 存储过程/触发器 | `ObPL::execute`、`ObSPIService` | Oracle 兼容层独立演进（objit 隔离 LLVM） | [10-pl](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/10-pl) |
| HA·备份·CDC | 容灾与数据外发 | `ObLSMigrationHandler`、`ObLogInstance` | 长任务流水线与在线路径分离 | [11-ha-backup-cdc](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/11-ha-backup-cdc) |

---

## 运行时行为

### 启动流程

```
main()                                  main.cpp:688（全仓库唯一入口）
└─ mmap 新栈 + CALL_WITH_NEW_STACK      main.cpp:702（16MB 大栈 + mprotect 防护）
   └─ inner_main(argc, argv)            main.cpp:503
      ├─ easy_pool_set_allocator       main.cpp:538   easy 内存接管
      ├─ parse_opts → ObServerOptions  main.cpp:581
      ├─ lib::Worker worker（主线程占位防绑 worker）main.cpp:653
      ├─ ObServer::get_instance().init(opts, log_cfg)  ob_server.cpp:237
      │   链式 init：init_config → init_pre_setting → init_io → init_schema
      │   → init_network（easy/SQL NIO 双轨监听）→ init_ob_service
      │   → init_root_service → init_sql → init_pl → init_storage
      │   → init_multi_tenant → ...（40+ 步，见 ob_server.cpp:247-560）
      └─ observer.start()               ob_server.cpp:951
          ├─ net_frame_.start()                          :994
          ├─ multi_tenant_.start()
          │   └─ ObTenantNodeBalancer::get_instance().start()   ob_multi_tenant.cpp:704
          │       （周期轮询 RS：unit 增删 → 本地建/删租户）
          ├─ ob_service_.start()                        :1107
          └─ check_if_multi_tenant_synced()             :1229（拿到租户才对外服务）
```

对象装配的关键：所有租户级服务（事务、存储、日志、DDL 调度…）都是 **MTL 组件**——`ObMultiTenant::create_tenant` 时按注册表实例化，挂在 `ObTenant` 上，租户删除时自动销毁；进程级单例则经 `GCTX`（服务定位器）互访。租户视图不靠 RS 强推，而是 observer 周期 `fetch_effective_tenants` 对比本地列表做最终一致收敛（`ob_tenant_node_balancer.h:84-93`）。

### 核心运行流程

以下三条链路覆盖了 OceanBase 最重要的运行模式：一条 SQL 的编译执行、一次写入的复制提交、一次 leader 切换。

#### 查询与写入：一条 SQL 的端到端数据流

业务流程：客户端发 MySQL 包 → 协议解码入租户队列 → worker 取包安全检查 → 软解析命中 plan cache（未命中走编译流水线）→ 算子树执行 → DAS 访问存储（本地直执/远程 RPC）→ 行融合输出 / 事务提交经 Palf 复制 → 协议回包。

![SQL 请求端到端数据流](/vibe-reading/images/articles/oceanbase/data-flow.svg)

文字描述：读链路的核心数据变化是 `ObString` 文本 → `ParseNode` 树 → `ObDMLStmt` + `ObRawExpr` → `ObPhysicalPlan`（`ObOpSpec` 算子树 + frame 布局）→ `ObBatchRows` 向量化行 → `blocksstable` 行迭代；跨模块边界都由共享的 `ObExecContext` 携带（`DAS_CTX(ctx)` 直达全部 table location 与查询快照）。写链路的关键设计是**异步回包贯穿始终**：UPDATE 的执行线程在 redo/commit 日志经 Palf 多数派落盘后，由 apply 回调线程执行 `ObSqlEndTransCb` 发出 OK 包——一条 UPDATE 的回包线程与执行线程不同。细节数据类型与调用链见 [SQL 执行引擎](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/04-sql-engine) 的调用链路章节。

#### 集群管理：一条 DDL 的推进

以 create index 为例：observer 收到 SQL → 走 DDL executor 经 RPC 到 RS → `ObDDLScheduler::create_ddl_task`（`src/rootserver/ddl_task/ob_ddl_scheduler.cpp:1254`）生成任务记录写入 `__all_ddl_task_status` 内部表 → 专用线程 `do_work` 轮询队列，每个 `task->process()` 只推进一步状态 → REDEFINITION 步通过 `ObDDLBuildSingleReplicaRequestProxy` 向各源 tablet 所在 observer 发 RPC 由其本地补 SSTable → observer 完成/校验列 checksum 后回调 RS 推进状态 → RS 重启后 `DDLScanTask`（60s）从内部表恢复任务。**推进者是轮询线程 + observer 回调，不是心跳**；任务全落表使 RS 无状态可重启，`rs_epoch_` 防旧 leader 脑裂双执行。

#### 复制与高可用：leader 选举与日志回放

leader 崩溃后：Palf 内 `ElectionImpl`（自包含于 `palf/election/`，Prepare/Accept 两阶段投票）独立选出"谁该当 leader"——策略由 `ObLeaderCoordinator` 注入（zone 优先级/region/manual leader）；新 leader 进入 `LogReconfirm` 8 态状态机从多数派最新副本补齐日志，写 START_WORKING 后才转 LEADER ACTIVE——**把"选主"与"日志一致性"解耦是经典 Multi-Paxos 优化**。角色变化经 `ObRoleChangeService` 通知 `ObLS` 执行上任/卸任。follower 侧由 `ObLogReplayService` 用 `IPalfIterator` 拉模型回放，按 `ObLogBaseType` 分发到 30+ 注册 handler（`ob_replay_handler.cpp:71`）。

### 状态流

![核心状态机](/vibe-reading/images/articles/oceanbase/state-flow.svg)

两个最核心的状态机：**2PC 提交状态机**（`ObTxCycleTwoPhaseCommitter`，状态枚举在 `src/storage/tx/ob_committer_define.h:68`；单参与者走 SP_TRANS 一阶段捷径，任一阶段失败进 ABORT）；**Palf 角色状态机**（`LogStateMgr`，`src/logservice/palf/log_state_mgr.h`；reconfirm 失败回退 FOLLOWER，卸任/切主/被抢占都会从 LEADER 回到 FOLLOWER）。切换的触发方是 env 级单线程 `LogLoopThread`（`log_loop_thread.cpp:98`）周期 `check_and_switch_state`——单线程驱动消除状态迁移锁竞争。此外还有 DDL 任务（40+ 状态值，`src/share/ob_ddl_common.h:187`）、迁移（`ob_ls_migration_handler.h` 头文件内置 ASCII 状态图）、restore（类层级状态机）等多个长任务状态机，形态同构，在各模块文档展开。

---

## 典型修改场景

#### 场景 1：新增一张 `__all_virtual_t` 虚拟表

1. `src/observer/virtual_table/ob_all_virtual_t_xxx.h/.cpp`：新建迭代器类，实现 `inner_get_next_row`
2. `src/observer/virtual_table/ob_virtual_table_iterator_factory.cpp`：加 include + 在 `ObVTIterCreator::create_vt_iter` 的 table_id switch（:432 起）加分支
3. 表 schema 在 `src/share/inner_table/ob_inner_table_schema_def.py` 加定义并重新生成（ID 落在虚拟表区间）
4. SQL 引擎零改动——扫描算子经 `GCTX.vt_iter_creator_` 走 `ObITabletScan` 接口

对应测试：`unittest/observer/virtual_table/`。

#### 场景 2：新增一条改写规则

1. `src/sql/rewrite/` 新建 `ob_transform_xxx.{h,cpp}`，继承改写基类实现 `transform/check_validity`
2. `ob_transform_rule.h` 的 `TRANSFORM_TYPE` 枚举加位，加入启发式或 cost-based 位图（static_assert 防漏分类）
3. `ob_transformer_impl.cpp` 用 `transform_one_rule<T>` 模板注册

对应测试：`unittest/sql/rewrite/`。

#### 场景 3：新增一个物理算子

1. `src/sql/engine/ob_phy_operator_type.h` 加 `PHY_XXX` 枚举
2. 写 `ObXxxSpec : ObOpSpec` + `ObXxxOp : ObOperator`（实现 `inner_*` 钩子）
3. `ob_operator_reg.h` 加 `REGISTER_OPERATOR`（向量化/ rich format 由宏参数声明）
4. `ob_static_engine_cg.cpp` 加 `generate_spec(ObLogXxx&, ObXxxSpec&)` 重载；优化器侧加 `ObLogXxx` 逻辑算子

对应测试：`unittest/sql/engine/`。

---

## 测试体系

```
unittest/            # 单元测试，目录结构镜像 src/（storage/sql/observer/rootserver/logservice/...）
mittest/             # 多副本集成测试
├── multi_replica/   #   真实多进程副本场景
├── simple_server/   #   单进程模拟服务器
├── palf_cluster/    #   palf 集群
└── shared_storage/  #   SS 模式
```

| 代码层 | 测试类型 |
| --- | --- |
| oblib / share | `unittest/lib/`、`unittest/share/` 单元测试 |
| sql / storage / tx | `unittest/sql/`、`unittest/storage/` 单元测试 |
| logservice / HA / backup | `unittest/logservice/` + `mittest/` 集成测试 |
| 全链路 | `mittest/multi_replica/` 多副本场景 |

理解某个类时优先读它的测试；HA/backup 全线有 `ERRSIM_POINT_DEF` 故障注入与 `DEBUG_SYNC` 同步点——改这些模块时必须同步维护。

---

## 阅读源码推荐路线

- 第一遍：理解进程与一条 SQL 的主流程
  `src/observer/main.cpp` 的 `inner_main` → `ob_server.cpp` 的 `ObServer::init/start` → `ob_srv_deliver.cpp` 的 `deliver_mysql_request` → `ob_th_worker.cpp` 的 `ObThWorker::worker` → `obmp_query.cpp` 的 `ObMPQuery::process` → `ob_sql.cpp` 的 `handle_text_query`
- 第二遍：理解核心数据结构
  `src/sql/engine/ob_operator.h` 的 `ObOpSpec/ObOperator` → `ob_expr.h` 的 `ObExpr/ObEvalCtx` → `src/storage/tablet/ob_tablet.h` 与 `ob_tablet_table_store.h` → `src/storage/memtable/mvcc/ob_mvcc_row.h` 的 `ObMvccRow/ObMvccTransNode`
- 第三遍：理解复制与事务
  `src/logservice/palf/palf_handle_impl.h`（成员即架构图）→ `log_state_mgr.h` → `log_reconfirm.h` → `src/storage/tx/ob_trans_define_v4.h` 的 `ObTxDesc` → `ob_trans_part_ctx.h` 的 `ObPartTransCtx` → `ob_two_phase_committer.h`
- 第四遍：选择重点子模块深入阅读（各模块文档；建议顺序：存储 → SQL 执行 → RootServer → HA/CDC）

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| LS（LogStream） | 日志流：Paxos 复制的基本单位，一个 LS 一个 Palf 实例 + 一组 tablet；4.0 取代 3.x Partition Group |
| Palf | Paxos-aligned log file，自包含的 Multi-Paxos 日志库（`src/logservice/palf/`） |
| tablet | 4.0 后数据分区的唯一单位；一个分区一个 tablet，属某 LS |
| unit | 资源单元：CPU/内存/日志盘配额的最小分配单位，租户 = 资源池 × unit |
| MTL | Multi-Tenant Library：租户级服务组件框架，随租户创建/销毁自动装配 |
| memtable / SSTable | LSM-Tree 的内存增量层 / 不可变基线层（宏块 2MB-微块 ~16KB 两级） |
| major / minor / mini | 三种 compaction：全量合并（行列混合）/ 增量合并 / memtable flush |
| DAS | Data Access Service：对 SQL 层屏蔽本地/远程数据访问的服务层 |
| PX | Parallel Execution：QC→DFO→SQC 三级并行执行框架 |
| SPI | Server Programming Interface：PL 内嵌 SQL 的服务化封装，完整借道 SQL 主链路 |
| ELR | Early Lock Release：commit log 提交后（未等多数派）即提前放锁唤醒等锁者 |
| SCN | 单调递增的日志/事务时序号（版本号来源） |
| RS | RootService：集群总控服务（非独立进程，sys LS leader 上激活） |
| fast parser | 手写轻量 lexer，soft parse 时生成参数化模板 SQL 作为 plan cache key |
| wash score | tablet 元数据内存淘汰的评分（按访问时间+优先级），meta_mem 池满时堆选最冷 tablet 换出 |

### 参考资料

- [OceanBase GitHub 仓库](https://github.com/oceanbase/oceanbase)
- [OceanBase 官方文档](https://www.oceanbase.com/docs)
- [OceanBase 4.0 架构解读（官方博客）](https://open.oceanbase.com/blog)
- TPC-C/TPC-H 官方审计报告（oceanbase.com/product）
- Paxos: Lamport, *Paxos Made Simple*
