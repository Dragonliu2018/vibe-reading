---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "Overview"
date: "2026-09-22T22:57:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C++", "OLTP", "InnoDB", "关系数据库", "可插拔存储引擎"]
description: "MariaDB Server main-2026-08 源码架构解读——MySQL 原班人马 fork 的开源关系数据库，JOIN_TAB 执行器/22 个可插拔引擎/三段式 GTID/Galera 集群/原生向量搜索/MTR 8832 测试全解"
readingTime: "70 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** main-2026-08 · **解读基线** commit [`ff09eefbe4e`](https://github.com/MariaDB/server/commit/ff09eefbe4e8b57846435ee4a928f17e49f0fdfc)（2026-08-18，开发分支快照，位于 tag `mariadb-13.0.1` 后 739 个提交；VERSION 文件为 13.1.0 alpha）· **协议** GPLv2 · **语言** C / C++17 · **代码量** ~205 万行（不含 vendor submodule）· **仓库** [GitHub](https://github.com/MariaDB/server) · **测试** 8,832 个 .test

---

## 总览

### 项目简介

MariaDB Server 是世界上最广泛部署的开源关系数据库之一——由 MySQL 原班人马（Monty Widenius 等）2009 年 fork 而来，由 MariaDB Foundation 与 MariaDB plc 共同维护。它保持与 MySQL 的 wire-protocol 与语法高度兼容，同时长出了自己的能力版图：**原生向量搜索**（内置 VECTOR 类型 + HNSW 索引，11.8 起无需扩展）、**22 个可插拔存储引擎**（InnoDB 默认、Aria、MyRocks、ColumnStore 分析引擎、Spider 分片、S3 归档）、**同步集群**（Galera 多主）、**三段式 GTID 复制与乐观并行复制**、以及 Oracle 兼容 SQL mode（PL/SQL 风格存储过程）。

**项目边界**：负责服务器与存储引擎本体；不含 MaxScale 代理（独立项目）、ColumnStore 的分布式层（submodule）与 mariadb-connector（独立仓库）。

这份解读基线是 main 分支快照（`ff09eefbe4e`，2026-08-18）——13.x 滚动系列的 13.1.0 alpha 开发版，能同时看到稳定特性（向量搜索、并行复制）与进行中的实验（binlog-in-engine、VIDEX 虚拟索引）。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|---|---|---|
| SQL 解析与执行 | `sql/`（251 个 .cc） | bison 文法 + 手写 DFA 词法器 + JOIN_TAB 执行器 |
| 事务引擎 | `storage/innobase/` | B+tree/MVCC/undo/redo，MariaDB 深度改造版 |
| 内部临时表/系统表 | `storage/maria/` | Aria：crash-safe，编译期绑定 tmp 表 |
| 向量搜索 | `sql/sql_type_vector.cc` + `sql/vector_mhnsw.cc` | VECTOR 类型 + MHNSW 索引 + VEC_DISTANCE 族 |
| 复制 | `sql/log.cc` + `sql/rpl_*.cc` | binlog=TC_LOG、三段式 GTID、乐观并行复制 |
| 同步集群 | `sql/wsrep_*.cc` + wsrep-lib submodule | Galera 写集复制、TOI/RSU、SST |
| 角色与认证 | `sql/sql_acl.cc` + `plugin/auth_*` | 角色先于 MySQL 8.0 五年；ed25519/PAM/GSSAPI 插件 |
| 数据类型插件 | `plugin/type_*` | MariaDB 独有：UUID/INET6/JSON 都是插件 |
| 物理备份 | `extra/mariabackup/` | InnoDB 热备（xtrabackup 血统） |
| 测试框架 | `mysql-test/` + `client/mysqltest.cc` | MTR：8,832 个回归测试 |

### 技术栈

| 依赖 | 类型 | 用途 |
|---|---|---|
| bison | 构建 | SQL 文法生成（`%expect 72` 冲突钉死） |
| OpenSSL / wolfSSL | 可选核心 | TLS；wolfSSL 是 GPLv2 兼容兜底 |
| zlib | 核心（vendored 1.3.2） | 压缩，锁版本保证行为一致 |
| libcurl | 可选 | S3 引擎、VIDEX |
| jemalloc | 可选 | 替代分配器 |
| PMEM 库 | 可选 | InnoDB redo 的 mmap 持久化路径 |
| libaio / io_uring | 可选 | tpool AIO 后端 |

### 版本历史

MariaDB 采用年度 LTS + 季度滚动发布模型。从 tag 时间线看当前格局：**11.4 / 11.8 是 LTS**（生产推荐），**12.3 / 13.0 是滚动版**，本解读基线的 13.1.0 alpha 是下一个滚动版的开发快照。10.x 系列仍在维护（10.11/10.6）——大量生产部署的存量所在。架构层面的大分水岭：10.5 移除 buffer pool 多实例、10.8 重写 redo 架构、10.9 移除 change buffer、11.8 引入向量搜索、13.0 开始 binlog-in-engine 实验——这些 fork 决策在[InnoDB](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/04-innodb)一章有逐项对照。

## 快速上手

按官方 [developer guide](https://mariadb.org/get-involved/getting-started-for-developers/get-code-build-test/) 从源码构建并跑测试：

```bash
git clone https://github.com/MariaDB/server.git && cd server
cmake . -DCMAKE_BUILD_TYPE=Debug && cmake --build . -j$(nproc)
cd mysql-test && ./mtr --parallel=auto --mem main.alias
```

预期输出末尾 `[100%] main.alias  [ pass ]`——8,832 个测试中跑通一个最小用例即证明 server 可构建、可启动、可执行 SQL。`./mtr --start main.alias` 会留下一个可手动连接的 server 打印端口。

## 架构设计解析

### 系统架构

![MariaDB Server 分层架构：从客户端工具到平台基础库的七层结构](/vibe-reading/images/articles/mariadb-server-internals/architecture.svg)

MariaDB 的架构思想是**「一个 SQL 层 + 一切皆插件」**：SQL 层（sql/ 759k 行）通过 handler 抽象把全部持久化工作委托给存储引擎插件，通过 plugin framework 把认证/审计/加密/数据类型也全部插件化；binlog 与向量索引这类"非引擎"组件以 transaction_participant 身份参与两阶段提交——13.x 的参与者已不限于存储引擎。层与层的依赖方向自上而下单向（解析→优化→执行→引擎→平台库），唯一反向是 handler 层对上层的回调（discovery、commit_ordered）。

| 架构层 | 包含目录 | 层职责 |
|---|---|---|
| 客户端与工具层 | `client/`、`extra/mariabackup/` | CLI 工具、物理备份、测试客户端 |
| 连接与会话层 | `vio/`、`sql/sql_connect.cc`、`sql/sql_class.cc` | 协议终点、THD 生命周期、认证 |
| SQL 解析层 | `sql/sql_yacc.yy`、`sql/sql_lex.cc`、`sql/sql_parse.cc` | 文本→AST、命令分发 |
| 优化器与执行器 | `sql/sql_select.cc`、`sql/opt_range.cc`、`sql/sql_join_cache.cc` | 成本优化、JOIN_TAB 执行程序 |
| 服务器核心与 Handler API | `sql/handler.cc`、`sql/ha_partition.cc`、`sql/log.cc`、`sql/rpl_*.cc` | 引擎抽象、两阶段提交、binlog、复制 |
| 存储引擎层 | `storage/`（22 个） | InnoDB/Aria/MyISAM/MyRocks/Spider/S3/... |
| 平台基础库 | `mysys/`、`strings/`、`vio/`、`tpool/`、`dbug/` | C ABI 可移植地基 |

### MariaDB 与 MySQL 的十个架构分叉

读 MariaDB 源码的最大认知陷阱是拿 MySQL 8 的地图找路。已从代码核实的关键差异：

| # | 维度 | MariaDB 13 | MySQL 8 |
|---|---|---|---|
| 1 | 执行器 | **JOIN_TAB 函数指针程序**（`sql_select.cc:16384` 编译计划） | RowIterator 迭代器树 |
| 2 | hash join | BNLH 嫁接在 JOIN_CACHE（"虚拟索引 + BNLH"） | 独立 hash join 迭代器 |
| 3 | 角色 | 10.0（2013）"角色=无 host 的用户" + 两遍 DFS 传播 | 8.0（2018） |
| 4 | 数据类型 | **Type_handler 插件 API**（UUID/INET6/JSON 是插件） | 全部内置 |
| 5 | 内部临时表 | Aria（编译期宏 `TMP_ENGINE_HTON` 绑定） | TempTable 引擎 |
| 6 | GTID | 三段式 `domain_id-server_id-seq_no`（多源天然并行） | `source_id:trx_id` + 区间集合 |
| 7 | 并行复制 | master 组提交信息编码 + 乐观回滚重试 | write-set 依赖分析 |
| 8 | InnoDB redo | 10.8 重写：无后台日志线程（group_commit_lock）、无 checksum | log_writer 四线程 |
| 9 | change buffer / AHI | 10.9 移除 / 13.x 重做且默认关 | 保留 / 默认开 |
| 10 | 闪回 | `mysqlbinlog --flashback`（事件反转） | 无 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 插件 + 函数表 | plugin framework（`sql_plugin.cc`）+ services 指针注入 | C ABI 二进制兼容；server 重构不破坏 .so |
| 包装器扇出 | `ha_partition` 包装 N 个 handler（degree 406） | 分区语义双向透明 |
| 双层巨型 switch | `dispatch_command`（协议层）+ `mysql_execute_command`（SQL 层） | 平面可见性；Sql_cmd 在渐进偿还技术债 |
| 观察者 | wsrep hook 进 handler 2PC（`wsrep_trans_observer.h`） | 集群逻辑集中一处、可编译期裁剪 |
| 隐藏子表 | 向量索引的 `t1#i#NN` 图表 | 全部引擎免改获得向量能力 |

### 核心概念

#### 核心对象

| 对象 | 含义 | 生命周期 | 主要关系 |
|---|---|---|---|
| THD | 每连接会话上下文（degree 641 全库第一） | 连接期；per-connection 模式下随线程缓存复用 | 持 LEX、mdl_context、ha_data[] |
| LEX | 语句解析容器（union-of-fields） | 语句期；常规查询复用 THD 内嵌 main_lex | 持 SELECT_LEX 树、Sql_cmd |
| Item | 表达式树节点（110 个类，degree 615） | 语句期，arena mem_root 分配 | 优化器直接在树上变换 |
| JOIN | 一次查询的优化执行上下文 | 查询期 | 产 JOIN_TAB 数组 |
| handler / handlerton | 每表实例 / 每引擎单例 | 表打开期 / 进程期 | 引擎全部从 handler 派生 |
| MYSQL_BIN_LOG | binlog + relay log + 组提交 + TC_LOG | 进程期（degree 198） | 是两阶段提交的协调者 |
| trx_t | InnoDB 事务（内嵌 ReadView） | 事务期 | purge 按 trx_no 排序 |

#### 核心抽象

| 抽象 | 定义位置 | 实现类 | 注册方式 |
|---|---|---|---|
| `transaction_participant` | sql/handler.h:1267 | binlog_tp、MHNSW_Trx::tp、各引擎 handlerton | `setup_transaction_participant`（handler.cc:672） |
| `TC_LOG` | sql/log.h:45 | MYSQL_BIN_LOG（binlog 开启时）、TC_LOG_MMAP、dummy | `get_tc_log_implementation()`（log.h:1553） |
| `handler` | sql/handler.h:3405 | 22 个引擎的 ha_* 类 + ha_partition | handlerton::create 工厂 |
| `Type_handler` | sql/sql_type.h:3919 | 全部内建类型 + type_* 插件 | 插件名反向注入（sql_type.cc:9903） |
| `Sql_cmd` | sql/sql_cmd.h:74 | Sql_cmd_dml/DDL 家族 | parser 构造，`lex->m_sql_cmd` |

## 代码目录

```
server/
├── sql/                  # SQL 层核心（759k 行，251 个 .cc）
│   ├── sql_yacc.yy       #   21k 行 bison 文法（双方言 %ifdef 分裂）
│   ├── sql_select.cc     #   35k 行 优化+执行一体（god file）
│   ├── handler.cc/.h     #   引擎抽象 + 两阶段提交
│   ├── log.cc + rpl_*.cc #   binlog + 复制
│   ├── wsrep_*.cc        #   Galera 集成（19 文件）
│   └── vector_mhnsw.cc   #   向量索引
├── storage/              # 22 个存储引擎
│   ├── innobase/         #   304k 行 默认事务引擎
│   ├── maria/            #   99k 行 Aria + S3
│   └── myisam/ rocksdb/ spider/ columnstore/ duckdb/ videx/ ...
├── plugin/               # 50 个插件目录（auth/type_*/provider_*/...）
├── client/               # CLI 工具 + mysqltest（46k 行）
├── mysys/ strings/ vio/ tpool/ dbug/   # 平台基础库（C ABI）
├── extra/                # mariabackup、innochecksum 等工具
├── mysql-test/           # MTR：8,832 个 .test
├── include/mysql/        # 插件 ABI 契约（plugin.h + service_*.h）
└── libservices/          # services 函数表占位（手工动态链接器）
```

## 模块地图

![模块依赖关系：SQL 层、横切子系统、引擎与平台三列](/vibe-reading/images/articles/mariadb-server-internals/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|---|---|---|---|---|
| 解析器与服务器层 | 文本→AST→命令分发；THD/ACL | `dispatch_command` (sql_parse.cc:1609) | SQL 语义的唯一入口，与执行解耦 | [01-parser](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/01-parser) |
| 优化器与执行器 | 成本优化 + JOIN_TAB 执行 | `JOIN::optimize` (sql_select.cc:1989) | 独立执行模型（与 MySQL 分叉点） | [02-optimizer](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/02-optimizer) |
| 存储引擎抽象层 | handlerton/handler/2PC | `ha_commit_trans` (handler.cc:1756) | 引擎可插拔的协议支点 | [03-handler-api](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api) |
| InnoDB | 默认事务引擎 | `row_search_mvcc` (row0sel.cc:4430) | 深度改造的 fork，自成一体 | [04-innodb](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/04-innodb) |
| Aria 与 MyISAM | 临时表/系统表/归档 | `ha_maria_init` (ha_maria.cc:3913) | crash-safe 恢复模型 vs 修复模型 | [05-aria-myisam](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/05-aria-myisam) |
| Binlog 与复制 | 变更流 + GTID + 并行复制 | `queue_for_group_commit` (log.cc:10206) | 既是持久化也是分发系统 | [06-replication](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/06-replication) |
| wsrep 集群 | Galera 同步多主 | `wsrep_trans_observer.h` | server 不持集群协议（wsrep-lib 边界） | [07-wsrep](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/07-wsrep) |
| 向量搜索 | VECTOR 类型 + HNSW | `mhnsw_read_first` (vector_mhnsw.cc:1520) | hlindex 隐藏子表架构独特 | [08-vector](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/08-vector) |
| 插件框架与安全 | 12 类插件 + ACL/角色 | `plugin_init` (sql_plugin.cc:1591) | 一切可扩展性的地基 | [09-plugins-security](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/09-plugins-security) |
| MTR 测试框架 | 8,832 个回归测试 | `mariadb-test-run.pl` | 可执行文档 + 开发工作流 | [10-mtr](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/10-mtr) |
| 平台基础库 | C ABI 地基 | IO_CACHE/Vio/tpool/DBUG | server 与全部插件共享 | [11-infra](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/11-infra) |

## 运行时行为

### 启动流程

```
mysqld_main (sql/mysqld.cc:6003)
├─ load_defaults_or_exit          读 my.cnf 合并默认组
├─ init_common_variables          字符集/错误消息/时区
├─ init_server_components (:5049) mdl_init、tdc_init、query_cache_init
│    ├─ plugin_init (:5458)       ★MyISAM 先于一切（默认表引擎依赖链）
│    └─ ha_init (:5650)           存储引擎注册
├─ network_init (:2756)           TCP + Unix socket 监听
├─ acl_init / grant_init          权限表载入内存
├─ init_slave / Events::init      复制与事件调度
└─ run_main_loop (:5985) → handle_connections_sockets (:6674)
     poll 阻塞 → accept → create_new_thread
     ├─ one-thread-per-connection（默认）: thread_cache.enqueue 复用或建 pthread
     └─ pool-of-threads: 连接对象进 thread_group 队列，不建线程
```

对象装配要点：配置优先级为 my.cnf 组 → 命令行覆盖；THD 在 `CONNECT::create_thd`（sql_connect.cc:1618）创建并 `store_globals()` 绑线程 TLS；引擎对象经 `get_new_handler` 工厂 + TDC 表缓存池化（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)）。

### 核心运行流程

以下三条链路覆盖日常运行的主干模式。每条链路的细节在对应模块文档展开。

#### 查询处理：一条 SELECT 的完整旅程

![SELECT 数据流：从 TCP 字节到结果集包的九步管道](/vibe-reading/images/articles/mariadb-server-internals/data-flow.svg)

业务流程：TCP 字节 → 协议包 → 语句字符串 → AST → 权限检查 → 打开表 → 优化 → 计划编译 → 执行循环 → 引擎取行 → 结果集包。关键方法链：`my_net_read_packet`（net_serv.cc:1062）→ `dispatch_command` → `mysql_parse` → `MYSQLparse`（bison）→ `mysql_execute_command` → `open_and_lock_tables`（sql_base.cc:5802）→ `JOIN::prepare/optimize/exec` → `sub_select` 递归 → `ha_rnd_next` → InnoDB `row_search_mvcc` → `Protocol_text::store` → `my_net_write`。数据形态十次演变：bytes→packet→query string→LEX AST→TABLE/Item→JOIN+POSITION→JOIN_TAB[]→record[0]→行包→TCP。

#### 事务提交：两阶段提交与组提交

业务流程：语句执行 → 逐引擎 prepare → binlog 组内定序 → binlog 整组一次 fsync → 逐引擎 commit → 引擎各自 group commit 刷 redo。关键方法链：`ha_commit_trans`（handler.cc:1756）→ `prepare_or_error` → `MYSQL_BIN_LOG::log_and_order` → `queue_for_group_commit`（log.cc:10206，BFS 拉等待者进组）→ `trx_group_commit_leader`（:10746）→ `commit_ordered`（InnoDB 在互斥内完成逻辑提交）→ 互斥外 `log_write_up_to` 组提交刷 redo。binlog 开启时它本身就是事务协调日志（`TC_LOG`）——崩溃恢复以 binlog 中的 XID 集合为准。

#### 节点加入集群：SST 状态传输

![wsrep 节点状态机：disconnected → connected → joiner → joined → synced，donor 旁路](/vibe-reading/images/articles/mariadb-server-internals/state-flow.svg)

业务流程：新节点 connect → Galera 比对位置（可增量则 IST，纯 provider 内部）→ SST：joiner spawn 外部脚本接收 → donor 侧 mariabackup 做快照 → joiner 收 `uuid:seqno` 完成 → 状态 joiner → joined → synced（`wsrep_ready` 置位放行查询）。状态机本体在 wsrep-lib（submodule），server 侧 `Wsrep_server_state` 是薄封装。

### 状态流

wsrep 的节点状态机是全库最完整的生命周期状态（定义见 `sql/wsrep_server_state.h`，状态枚举在 wsrep-lib）。其他"状态"（trx_t 六态、handler init_stat 三态、st_plugin_int 五态）散布在各模块文档中。

## 典型修改场景

#### 场景 1：新增一个 SQL 命令

`sql/sql_command.h` 加枚举 → `sql/lex.h` 加关键字 → `sql/sql_yacc.yy` 加规则 → `Sql_cmd` 子类 → `mysql_execute_command` 加 case → **`init_update_queries()` 设 `sql_command_flags[]` 位（漏了 binlog 与 SP 合法性都会错）** → `com_status_vars` 加计数。详见[解析器](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/01-parser)。

#### 场景 2：新增一个存储引擎

`ha_foo : public handler` 实现纯虚集（open/rnd_init/rnd_next/position/info/create）→ `foo_init_func` 填 handlerton → `maria_declare_plugin` → `MYSQL_ADD_PLUGIN`。事务引擎再加 transaction_participant 回调。参考模板 `storage/example/ha_example.cc`。详见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)。

#### 场景 3：新增一个数据类型插件

`Type_handler_mytype : public Type_handler` → `st_mariadb_data_type` 描述符 → `MariaDB_DATA_TYPE_PLUGIN` 声明（照抄 `plugin/type_inet/plugin.cc`）。解析器零改动（类型名经 plugin_hash 解析）。详见[插件框架](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/09-plugins-security)。

## 测试体系

```
mysql-test/
├── main/                 # 主 suite：1,450 个 .test（扁平布局）
├── suite/                # 45 个子 suite：5,434 个 .test
│   ├── rpl/ (737)        #   复制
│   ├── galera*/ (679)    #   集群
│   ├── innodb*/ (560)    #   InnoDB
│   └── sys_vars/ (759)   #   每个系统变量一个测试
├── include/              # 644 个共享脚本
└── combinations          # my.cnf 格式组合定义
```

| 代码层 | 测试类型 |
|--------|----------|
| SQL 层 | main/ + funcs_1/ + optimizer 相关 suite |
| 各引擎 | storage/<engine>/mysql-test 自带 suite |
| 复制/集群 | rpl/ + galera/ |
| 全量回归 | collections/default.push（CI 矩阵） |

改任何 SQL 层代码：`./mtr --do-test=<前缀> --force --parallel=auto --mem`。MTR 的组合机制（`--ps-protocol`）让同一 .test 在 5 种协议下免改重跑。详见[MTR 测试框架](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/10-mtr)。

## 阅读源码推荐路线

- **第一遍：主流程**（一条 SELECT 走通）
  `sql/mysqld.cc:6003` 的 `mysqld_main` → `sql/sql_parse.cc:1609` 的 `dispatch_command` → `:7890` 的 `mysql_parse` → `sql/sql_select.cc:5349` 的 `mysql_select` → `:24654` 的 `sub_select` → `sql/handler.cc:4032` 的 `ha_rnd_next` → `storage/innobase/row/row0sel.cc:4430` 的 `row_search_mvcc`
- **第二遍：核心数据结构**
  `sql/sql_class.h:3331` 的 THD（先读 :6012 的 LEX 生命周期注释）→ `sql/sql_lex.h:1121` 的 SELECT_LEX → `sql/sql_select.h:492` 的 JOIN_TAB → `sql/table.h` 的 TABLE/TABLE_SHARE
- **第三遍：事务与提交**
  `sql/handler.cc:1756` 的 `ha_commit_trans` → `sql/log.cc:10206` 的 `queue_for_group_commit` → `storage/innobase/trx/trx0trx.cc:1645` 的 `trx_t::commit` → `log/log0sync.cc` 的 group_commit_lock
- **第四遍：选子系统深入**（模块文档）
  想懂执行器与 MySQL 的分叉 → [02-optimizer](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/02-optimizer)；想懂集群 → [07-wsrep](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/07-wsrep)；想懂向量 → [08-vector](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/08-vector)

## 附录

### 术语表

| 术语 | 含义 |
|---|---|
| THD | Thread descriptor——每连接会话上下文，全库 degree 最高的对象 |
| handlerton | 每引擎单例结构（全局回调 + API 指针表） |
| hlindex | high level index——引擎不可见、sql 层实现的索引（vector 索引即此类） |
| TOI / RSU | Total Order Isolation / Rolling System Upgrade——Galera 的 DDL 隔离模式 |
| SST / IST | State Snapshot Transfer（全量）/ Incremental State Transfer（gcache 增量） |
| MTR | mariadb-test-run——回归测试框架 |
| TC_LOG | Transaction Coordinator Log——两阶段提交协调者（binlog 或 mmap 文件） |
| domain_id | MariaDB GTID 三段式的第一段——多源复制/独立写单元的并行边界 |

### 参考资料

- [MariaDB 官方文档](https://mariadb.com/docs/) · [MariaDB vs MySQL 差异](https://mariadb.com/docs/release-notes/community-server/about/compatibility-and-differences/mariadb-vs-mysql-features)
- [开发者指南：构建与测试](https://mariadb.org/get-involved/getting-started-for-developers/get-code-build-test/) · [JIRA](https://jira.mariadb.org)（MDEV 编号即源码 commit 前缀）
- 本系列模块文档（11 篇，见模块地图）
