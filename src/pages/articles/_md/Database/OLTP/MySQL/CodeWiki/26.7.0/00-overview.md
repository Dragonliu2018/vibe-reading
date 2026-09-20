---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "Overview"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "C++", "OLTP", "InnoDB", "关系数据库"]
description: "MySQL Server 26.7.0 源码架构解读——世界最流行的开源关系数据库，SQL 层/存储引擎分层、超图优化器、InnoDB 事务引擎、组提交复制、插件组件双体系全解"
readingTime: "60 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 26.7.0（INNOVATION，tag `mysql-26.7.0`，2026-07-28）· **协议** GPLv2 · **语言** C++（CMake 构建）· **代码量** ~340 万行 · **仓库** [GitHub](https://github.com/mysql/mysql-server)

---

## 总览

### 项目简介

MySQL 是世界上使用最广泛的开源关系数据库系统，由瑞典 MySQL AB 公司创建（1995 年），2008 年起归 Sun，2010 年起归 Oracle 并持续维护至今。本系列解读基于官方 `mysql-server` 仓库的 trunk 分支，基线为 release tag `mysql-26.7.0`（`MYSQL_VERSION` 标记 `MATURITY="INNOVATION"`，前一 LTS 为 9.7.0）。

MySQL 解决的核心技术问题是：在单机共享内存架构下，提供高并发、ACID 事务、SQL 标准兼容的数据存储与查询，同时通过**分层解耦的存储引擎架构**（MySQL 层做 SQL 与调度，存储引擎负责持久化与事务）让不同负载可以替换底层实现。它的核心价值是**生态与可插拔性**：InnoDB 事务引擎、多种复制形态（异步/半同步/组复制）、X 协议、以及组件（component）服务框架共同构成一个"数据库操作系统"。核心使用场景覆盖互联网 OLTP 服务、嵌入式部署、以及作为 Percona、MariaDB、各大云厂商 RDS 的源流。

**项目边界**：本仓库是 MySQL Server 单体（mysqld 进程 + 客户端工具 + MySQL Router），**不负责**分布式分片（由应用分库分表或 MySQL Cluster/NDB 承担）、不负责 OLAP 列存加速（HeatWave 是 MySQL 企业侧的二级引擎能力，本仓库通过 secondary engine 接口预留挂点）、分析型 MPP 不是目标。Parser、优化器、执行器、引擎、复制全部在一个进程内。

### 功能矩阵

| 特性 | 实现文件/目录 | 说明 |
| --- | --- | --- |
| SQL 解析 | `sql/sql_yacc.yy`（~19,300 行 bison 文法） | LALR 语法分析，产出 `PT_*` 解析树 |
| 查询优化 | `sql/sql_optimizer.cc`、`sql/join_optimizer/`（~37k 行） | 新老双优化器：超图 DPhyp + prefix search |
| 火山执行器 | `sql/iterators/` | `RowIterator` 拉模型（Init/Read） |
| InnoDB 引擎 | `storage/innobase/`（~47 万行） | 事务、行锁、MVCC、B+树、redo/undo |
| binlog 与复制 | `sql/binlog.cc`、`sql/rpl_*.cc`、`sql/changestreams/` | 组提交、GTID、MTA 多线程 applier |
| 数据字典 | `sql/dd/`（~8 万行） | 8.0 起的统一元数据层（替代 .frm） |
| X 协议 | `plugin/x/` | protobuf 定义的 mysqlx 协议（33060 端口） |
| 组复制 | `plugin/group_replication/` | 基于 libmysqlgcs 的多主共识复制 |
| Performance Schema | `storage/perfschema/`（163 个 .cc） | 以存储引擎形态暴露 instruments 数据 |
| 组件框架 | `components/`、`include/mysql/components/`（159 个 service 头） | C ABI 显式依赖服务框架 |
| MySQL Router | `router/`（~46 万行） | 独立进程的智能路由/连接池/REST 网关 |
| 客户端工具 | `client/` | mysql/mysqldump/mysqlbinlog/mysqlslap 等 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++（`sql/sql_const.h` 等按 C++17/20 特性编写） | 核心 | 主体语言，深面相对象 + 大量宏体系 |
| Bison/Flex | 核心 | SQL 文法（`sql_yacc.yy`）与词法（`sql_lex.cc`） |
| CMake | 核心 | 构建（`CMakeLists.txt` ~2,900 行） |
| protobuf | 核心 | X 协议消息（`plugin/x/protocol/protobuf/` 12 个 proto） |
| Boost / abseil / ICU / zlib / zstd | 核心 | `extra/` 内置（异常、字符串、压缩等） |
| OpenSSL | 核心 | TLS、认证（26.x 支持后量子密码 PQC） |
| GraalVM polyglot | 可选 | Router jit_executor 的 JavaScript 运行时（MLE） |
| NDB（`storage/ndb/`） | 可选 | MySQL Cluster 无共享引擎（编译期开关） |

### 版本历史

| 阶段 | 时间 | 关键变革 |
| --- | --- | --- |
| 5.7 | ~2015 | 最后一个"经典架构"大版本（`.frm` 文件、老解析器） |
| 8.0 | 2018 | 数据字典（DD）重写、事务性 DDL、窗口函数、CTE、` temptable` 内存引擎、瞬时 DDL |
| 8.4 LTS | 2024 | 长期支持版，X Plugin 默认等清理 |
| 9.x Innovation | 2024-2025 | 超图优化器合入、向量类型（`MYSQL_TYPE_VECTOR`）、EVENT 语法等 |
| 9.7 LTS | 2025 | 当前前一 LTS（`MYSQL_PREVIOUS_LTS_VERSION=9.7.0`） |
| 26.x Innovation | 2026- | 版本号改 CalVer；26.7 相对 9.7.2 有 ~2072 文件变更（+8.8 万/-4.8 万行） |

26.x（相对 9.7.2 的 git diff）值得注意的架构级变化：**MTA 优化版 change stream applier**（`sql/changestreams/apply/` 新增 93 个文件，`Csa_service` 任务图调度）、**InnoDB 接口化重构**（redo log / MVCC ReadView / tablespace / monitoring 均抽出 `*_interface.h`，含独立 redo 解析库）、**Thread Pool 插件社区版化**、**GR 通信栈默认 MYSQL 协议并弃用 XCom**、**CalVer 升降级兼容**（`sql/dd/impl/bootstrap/server_version_transition.cc`）、**Router 侧 host cache 与 HTTP 限制**、后量子密码（OpenSSL ≥ 3.5）。

## 快速上手

```bash
# 构建（macOS/Linux，需要 cmake + ninja/make + C++20 编译器）
mkdir build && cd build
cmake .. -DDOWNLOAD_BOOST=1 -DWITH_BOOST=./boost -DWITH_UNIT_TESTS=OFF
make -j$(nproc) mysqld          # 只编 mysqld 可以大幅缩短时间

# 初始化并启动
./runtime_output_directory/mysqld --initialize-insecure --datadir=./data
./runtime_output_directory/mysqld --datadir=./data --port=3306 &

# 端到端验证
./runtime_output_directory/mysql -uroot -P3306 -h127.0.0.1 \
  -e "SELECT VERSION(), @@version_comment;"
# 预期输出：8.26.7... / 这样只读代码不跑起来的阅读是纸上谈兵
```

> 验证解读基线：`./mysql -e "SELECT VERSION()"` 应返回 `26.7.0`（编译出的二进制版本号由 `MYSQL_VERSION` 文件注入，见 `cmake/mysql_version.cmake`）。

## 架构设计解析

### 系统架构

MySQL Server 的整体设计思想是**"SQL 层与存储引擎分治"**：上面的 SQL 层（解析、优化、执行、复制、元数据）对下只通过一张 `handler`/`handlerton` 抽象契约沟通，任何引擎只要实现这张契约即可接入——InnoDB、MyISAM、CSV、NDB、Performance Schema 全部平权地挂在这张契约下。这种分层的历史根源是 MySQL 早期的"窄服务器 + 可插拔引擎"产品策略，它换来了引擎生态（InnoDB 收编自 Innobase Oy、NDB 来自并购），代价是 server 层需要容忍引擎能力的巨大差异（有无事务、有无索引、是否支持在线 DDL）。

![MySQL Server 分层架构](/vibe-reading/images/articles/mysql-internals/architecture.svg)

自顶向下六层：客户端层（CLI 工具与 Router）经 TCP/socket 进入连接层（每连接一线程的 Connection Handler 与 THD 会话上下文）；SQL 层完成解析（bison）、语义解析（Item 表达式）、优化（超图 DPhyp）、执行（RowIterator 火山）；服务基础设施（数据字典、binlog 复制、Performance Schema、插件组件框架）是横贯 SQL 层的旁路设施；存储引擎层通过 handler API 收行操作请求；最底下是表空间、redo/undo、binlog 文件。注意图中"服务基础设施"只占半宽——SQL 层调用存储引擎的行操作（`ha_rnd_next` 等）**不经过**它，但它（尤其 DD 与 binlog）参与 DDL 与提交路径。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 客户端层 | `client/`、`router/` | 工具与路由进程，隔离终端用户协议细节 |
| 连接层 | `sql/conn_handler/`、`sql/sql_class.*`、`sql/protocol_classic.*` | 连接生命周期、会话上下文（THD）、协议编解码 |
| SQL 层 | `sql/sql_yacc.yy`、`sql/sql_lex.*`、`sql/sql_optimizer.cc`、`sql/join_optimizer/`、`sql/iterators/` | 把文本变成最优物理计划并拉取执行 |
| 服务基础设施 | `sql/dd/`、`sql/binlog*`、`sql/rpl_*`、`storage/perfschema/`、`sql/sql_plugin.cc`、`components/` | 元数据、复制、可观测性、扩展机制 |
| 存储引擎层 | `sql/handler.*`（契约）+ `storage/*`（实现） | 持久化与事务语义的 provider |
| 文件层 | `storage/innobase/{fil,fsp,log}/` 等 | 物理布局与崩溃恢复介质 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略（引擎抽象） | `struct handlerton`（`sql/handler.h:2852`）+ `class handler`（`sql/handler.h:4753`，~200 个虚方法） | 引擎是可替换策略；handlerton 是引擎级单例（函数指针表），handler 是每表实例 |
| 插件注册 | `mysql_declare_plugin` 宏（`include/mysql/plugin.h:147`）+ `plugin_initialize`（`sql/sql_plugin.cc:1298`） | dlopen 符号发现 + 12 种插件类型的统一生命周期 |
| 火山（迭代器） | `class RowIterator`（`sql/iterators/row_iterator.h:82`）的 Init/Read | 执行计划的统一拉模型，运营商（Filter/Sort/Aggregate）嵌套组合 |
| 桥接（新老优化器） | `JOIN::optimize()`（`sql/sql_optimizer.cc:344`）内按 `using_hypergraph_optimizer()` 分流 | 新优化器渐进替换老 prefix-search，共享 AccessPath/iterator 执行层 |
| 观察者（复制钩子） | `RUN_HOOK(transaction, after_commit)` 等遍布 `sql/binlog.cc` | 半同步、GR、audit 都以 observer 挂进提交/刷盘路径，不侵入主逻辑 |
| 服务定位器（component） | `my_service<T>` acquire（`include/mysql/components/my_service.h`）+ registry | 组件间按服务名解耦获取实现，支持热替换 |
| ARENA | `MEM_ROOT`（`include/my_alloc.h:83`）+ `Query_arena`（`sql/sql_class.h:352`） | 解析/执行期对象成批分配、语句结束整体释放，避免碎片 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `THD` | 会话线程上下文（`sql/sql_class.h:953`，多继承 `MDL_context_owner`/`Query_arena`/`Open_tables_state`） | 一连接（或一内部 session）一个 | 持有 `LEX`、`Transaction_ctx`、`MDL_context`、`Protocol` |
| `LEX` / `Query_expression` / `Query_block` | 解析产物与查询块树（`sql/sql_lex.h:662/1198`） | 语句级（语句结束销毁） | `Query_term` 树表达 UNION/INTERSECT/EXCEPT 结构 |
| `Item` | 表达式节点（`sql/item.h:929`，700+ 子类散布 `item_*.h`） | 语句级，MEM_ROOT 分配 | 编译期求值/执行期 val_int/val_str 的统一接口 |
| `AccessPath` | 物理计划节点（`sql/join_optimizer/access_path.h:243`，45 种类型） | 优化期生成，执行前转 iterator | 规划与执行的中间表示 |
| `RowIterator` | 执行算子（`sql/iterators/row_iterator.h:82`） | 执行期 | 火山模型 Init/Read |
| `handler` / `handlerton` | 引擎表实例 / 引擎单例（`sql/handler.h:4753/2852`） | 表打开期 / 进程期 | server↔引擎唯一通道 |
| `dict_table_t` / `dict_index_t` | InnoDB 表/索引缓存（`storage/innobase/include/dict0mem.h:1927/1069`） | 引用计数 | 从 DD（`dd_open_table` in `dict0dd.cc:5412`）翻译而来 |
| `trx_t` | InnoDB 事务（`storage/innobase/include/trx0trx.h:670`） | 事务期，池化复用 | 持有 ReadView、锁、undo 段 |
| `MYSQL_BIN_LOG` | binlog + 事务协调器（`sql/binlog.h:108`，`TC_LOG` 子类） | 进程期 | 组提交五阶段队列 |
| `Gtid_state` / `Gtid_set` | GTID 状态机（`sql/rpl_gtid.h:2895/1558`） | 进程期 | owned/executed 双集合 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `handler` 虚接口 | `sql/handler.h:4753` | `ha_innobase`、`ha_myisam`、`ha_perfschema`、`Handler`（temptable）… | `handlerton::create` 工厂（`get_new_handler` in `sql/handler.cc:614`） |
| `handlerton` 函数表 | `sql/handler.h:2852` | 各引擎 `xxx_init` 填表 | `mysql_declare_plugin` + `plugin_initialize` |
| `RowIterator` | `sql/iterators/row_iterator.h:82` | TableScan/IndexScan/Ref/HashJoin/NestedLoop/Aggregate/Window/Sort/Materialize… | `CreateIteratorFromAccessPath`（`sql/join_optimizer/access_path.cc:686`） |
| `Sql_cmd` | `sql/sql_cmd.h:83` | `Sql_cmd_dml`、`Sql_cmd_ddl`、`Sql_cmd_create_table`… | `Parse_tree_root::make_cmd`（`sql/parse_tree_nodes.h:175`） |
| `TC_LOG` | `sql/tc_log.h:144` | `MYSQL_BIN_LOG`（有 binlog）、`TC_LOG_DUMMY` | `init_server_components` 装配（`sql/mysqld.cc:8116`） |
| `Service`（component） | `include/mysql/components/service.h`（`SERVICE_TYPE` 宏） | `sql/server_component/` 下 245 处 `PROVIDES_SERVICE` | registry 按名获取 |
| `PSI` 插桩接口 | `include/mysql/psi/`（72 个头） | Performance Schema 实现 | `mysql_mutex_register` 等 |

## 代码目录

```shell
mysql-server/
├── sql/                  # SQL 层主体（~97.5 万行）
│   ├── sql_yacc.yy       # bison 文法（~1.93 万行）
│   ├── mysqld.cc         # 服务器 main 与初始化（~1.5 万行）
│   ├── join_optimizer/   # 超图优化器（~2.9 万行）
│   ├── iterators/        # RowIterator 执行器
│   ├── dd/               # 数据字典（~8 万行）
│   ├── auth/             # 认证与权限（~4.2 万行）
│   ├── rpl_*.cc/h        # 复制（116 个文件）
│   └── changestreams/    # 新 MTA applier（26.x）
├── storage/              # 存储引擎（~141 万行）
│   ├── innobase/         # InnoDB（~47 万行，34 个子目录）
│   ├── perfschema/       # Performance Schema（~11.6 万行）
│   ├── ndb/              # MySQL Cluster 引擎（~9.8 万行）
│   ├── myisam/ temptable/ csv/ ...  # 其他引擎
├── router/               # MySQL Router 独立进程（~33.5 万行非测试）
├── plugin/               # 服务端插件（x、group_replication、clone、thread_pool…）
├── components/           # 组件与最小底盘 libminchassis
├── client/               # 客户端工具（mysql、mysqldump、mysqlbinlog…）
├── libs/mysql/           # 共享 C++ 库（gtid、binlog event、concurrency…）
├── libbinlogevents/      # 旧事件库（已 shim 化，指向 libs/mysql/binlog）
├── include/              # 公共头（plugin.h、components/、psi/）
├── mysys/                # C 基础库（内存、字符串、IO）
├── extra/                # 第三方（boost/protobuf/icu/abseil…，~181 万行 vendored）
├── mysql-test/           # MTR 测试（9,531 个 .test / 9,368 个 .result）
└── unittest/             # gunit 单测（265 个文件）
```

## 模块地图

本系列按职责分化拆为 10 个模块文件（单层结构，全部平级）：

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 连接与会话层 | 监听、线程模型、THD、协议 | `mysqld_main`、`handle_connection` | 连接生命周期与 SQL 语义正交，线程模型可替换（thread pool） | [01-connection-layer](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/01-connection-layer) |
| SQL 解析器 | 文法、解析树、LEX、Item 表达式 | `THD::sql_parser`、`LEX::make_sql_cmd` | 从文本到语义对象的纯编译问题，自成体系 | [02-parser](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/02-parser) |
| 查询优化器 | 双优化器、AccessPath、成本模型、直方图 | `JOIN::optimize`、`FindBestQueryPlan` | 计划搜索是独立的组合优化问题（DPhyp） | [03-optimizer](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/03-optimizer) |
| 执行器 | RowIterator 火山、算子实现 | `ExecuteIteratorQuery` | 计划的物理执行与计划搜索关注点分离 | [04-executor](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/04-executor) |
| 存储引擎 API | handler/handlerton、MDL、表缓存、插件装载 | `ha_init`、`get_new_handler` | server 与引擎的契约边界，扩展点的本质 | [05-storage-engine-api](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/05-storage-engine-api) |
| InnoDB 引擎 | 缓冲池、B+树、MVCC、锁、redo/undo | `ha_innobase`、`row_search_mvcc` | 代码量最大（47 万行）、事务语义完整自洽 | [06-innodb](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/06-innodb) |
| 数据字典与 DDL | DD 三层、SDI、在线 DDL 三协议 | `mysql_alter_table`、`dd_open_table` | 元数据是 8.0 架构重写核心，DDL 走独立编译路径 | [07-dd-ddl](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/07-dd-ddl) |
| 复制与 binlog | 组提交、GTID、applier、组复制 | `ordered_commit`、`handle_slave_sql` | 跨进程数据面，与查询路径完全正交 | [08-replication](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication) |
| 插件组件与可观测性 | plugin/component 双体系、X、PFS、线程池 | `plugin_initialize`、`xpl_plugin.cc` | 扩展机制横贯全系统，自成一套ABI | [09-plugins-components](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/09-plugins-components) |
| MySQL Router | 独立路由进程、metadata cache、MRS | `MySQLRouting::run` | 独立进程独立交付，harness 插件体系自成一体 | [10-router](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/10-router) |

## 运行时行为

### 启动流程

`mysqld` 从 `sql/main.cc:29` 的 `main()` 进入 `mysqld_main()`（`sql/mysqld.cc:10453`，非 Windows；Windows 走 `win_main`）。核心装配序列（顺序执行，任何一步失败 `unireg_abort`）：

```text
mysqld_main (sql/mysqld.cc:10453)
├── my_init / pre_initialize_performance_schema     # C 库与 PFS 早期初始化
├── init_common_variables()                          # 默认配置、字符集（:9631）
├── init_server_components() (sql/mysqld.cc:8116)   # 组件装配核心
│   ├── binlog 服务注册、mysql_bin_log.open_index_file
│   ├── gtid_server_init()                           # GTID 全局状态（:8430）
│   ├── ha_init()                                    # 装载全部存储引擎插件（sql/handler.cc:910）
│   ├── dd::init(DD_INITIALIZE|DD_RESTART)           # 数据字典初始化/恢复（:8721）
│   ├── event_scheduler / 系统视图 / I_S 元数据更新
├── init_ssl_communication() → network_init()        # TLS 与监听 socket（:9997）
├── create_pid_file() / acl_init()                   # PID 与权限表（:10021/:10073）
├── start_signal_handler()                           # 信号线程（:10139）
├── Connection_handler_manager::init()               # per-thread 调度器（sql/conn_handler/connection_handler_manager.cc:147）
└── socket_conn_event_handler → connection_event_loop()  # accept 循环（sql/mysqld.cc:3488）
```

对象装配要点：**handlerton 由插件系统创建**——`ha_init()` 经 `plugin_initialize`（`sql/sql_plugin.cc:1298`）的分派表 `plugin_type_initialize`（STORAGE_ENGINE → `ha_initialize_handlerton`）逐个调用引擎 init（如 `innodb_init` in `storage/innobase/handler/ha_innodb.cc:5441`，填充 60+ 回调），**引擎与 server 之间没有编译期依赖，只有 dlopen 后的函数指针**。调度器按 `thread_handling` 装配 `Per_thread_connection_handler` 或 `One_thread_connection_handler`（`connection_handler_manager.cc:147`），thread_pool 插件可以整体替换。

### 核心运行流程

以下三条链路覆盖了服务器最重要的运行时行为：查询执行（读路径）、事务提交（写路径与崩溃一致性）、复制传播（跨进程数据面）。

#### 查询执行：一条 SELECT 的完整旅程

业务流程：客户端发 SQL → 解析成语法树 → 生成 Sql_cmd → 语义 prepare → 优化搜索物理计划 → 迭代器拉取执行 → 经 handler 进入 InnoDB 读页与 MVCC 判断 → 行结果回客户端。

![查询执行主链路](/vibe-reading/images/articles/mysql-internals/query-flow.svg)

文字解读：`do_command`（`sql/sql_parse.cc:1347`）读一个协议包，`dispatch_command` 的 `COM_QUERY` 分支调 `dispatch_sql_command`（`sql/sql_parse.cc:5303`）——它先跑解析前后重写插件（query rewrite），再 `THD::sql_parser()`（`sql/sql_class.cc:3180`）驱动 bison 生成的 `my_sql_parser_parse`，成功后 `LEX::make_sql_cmd`（`sql/sql_lex.cc:5178`）把 `PT_*` 解析树实例化为 `Sql_cmd_dml`。执行侧 `mysql_execute_command`（`sql/sql_parse.cc:3027`）调 `sql_cmd->execute()`：`Sql_cmd_dml::execute`（`sql/sql_select.cc:685`）完成 prepare（`Query_block::prepare` in `sql/sql_resolver.cc:184`，开表/权限/MDL）→ optimize（`Query_expression::optimize` → `JOIN::optimize` in `sql/sql_optimizer.cc:344`，超图路径调 `FindBestQueryPlan` in `sql/join_optimizer/join_optimizer.cc:10103`）→ `FinalizePlanForQueryBlock` 定稿 AccessPath 树 → `CreateIteratorFromAccessPath`（`access_path.cc:686`，迭代式栈展开防栈溢出）生成 RowIterator 树。执行循环在 `Query_expression::ExecuteIteratorQuery`（`sql/sql_union.cc:1068`）：`Init` 一次，`Read` 逐行拉取（PFS 批模式降低 instrumentation 开销），每行经 `Query_result::send_data` 编码回客户端。存储访问的最底层：`TableScanIterator::DoRead`（`sql/iterators/basic_row_iterators.cc:276`）调 `ha_rnd_next`（带 PFS 计时的 wrapper，`sql/handler.cc:3111`）→ `ha_innobase::rnd_next`（`storage/innobase/handler/ha_innodb.cc:11104`）→ `general_fetch`（`:10805`）→ `row_search_mvcc`（`storage/innobase/row/row0sel.cc:4437`，B-tree 游标 + ReadView 可见性 + undo 回溯）。

#### 事务提交：组提交三阶段与内部 2PC

业务流程：多个并发 COMMIT → binlog 作为事务协调者（TC_LOG）分阶段批处理 → 引擎按序提交 → redo 持久化 → 返回客户端。

![组提交与 2PC](/vibe-reading/images/articles/mysql-internals/commit-flow.svg)

文字解读：`ha_commit_trans`（`sql/handler.cc:1686`）先持久化 GTID 归属，再调 `tc_log->commit()`——binlog 开启时 `MYSQL_BIN_LOG` 就是 TC。`ordered_commit`（`sql/binlog.cc:7513`）是组提交心脏：Stage 0 让 MTS worker 按 relay log 顺序排队（`Commit_order_manager::wait_for_its_turn_before_flush_stage`）；Stage 1 flush 中 leader 汇集整个队列（`process_flush_stage_queue` 统一分配 GTID 并 `write()` 事务缓存）；Stage 2 sync 把攒批的写一次性 fsync（`sync_binlog` 控制粒度）；Stage 3 commit 由 `process_commit_stage_queue`（`binlog.cc:7161`）按序对每个 THD 调引擎提交（`ha_commit_low` → `innobase_commit` in `ha_innodb.cc:5997` → `trx_commit_for_mysql`），并集中更新 `gtid_executed` 避免集合出现空洞；After Commit 阶段单独持锁跑 `after_commit` 钩子（半同步 ACK、GR 通知），防止慢钩子阻塞下一批。**为什么分阶段**：fsync 是最贵的操作，flush 持 log 锁定序、sync 攒批共享一次 fsync、commit 批量化引擎提交；每阶段换锁形成流水线，后一阶段执行时前一阶段已可接纳新事务。binlog 先于引擎持久化 + 崩溃恢复按 binlog 重放，构成内部 2PC 的崩溃一致性保证。

#### 复制传播：binlog → dump → replica applier

业务流程：源端提交写 binlog → dump 线程推送 → replica IO 线程写 relay log → SQL 线程（或 MTS worker/新 CSA applier）按依赖并行应用 → 更新 executed GTID。

文字解读（不另出图，细节见[复制模块文档](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication)）：源端 `Binlog_sender::run`（`sql/rpl_binlog_sender.cc:386`）逐文件逐事件推送，`update_binlog_end_pos`（提交路径调用）负责唤醒等待的 dump 线程。replica 侧 `handle_slave_io`（`sql/rpl_replica.cc:5434`）拉事件写 relay log；`handle_slave_sql`（`:7124`）读 relay log 应用——26.x 在此处分叉：`rli->is_csa_enabled()` 时走新 MTA applier `Csa_service::run`（`sql/changestreams/apply/service/csa_service.cpp`，每事务一个 `Job_applier`，`Dependency_adapter_lwm` 把源端 `last_committed/sequence_number` 逻辑时钟翻译成任务图交给通用 scheduler 线程池），否则走老 MTS（Coordinator 按 `Mts_submode_logical_clock` 分发 `Slave_worker`）。详见模块八。

## 典型修改场景

#### 场景 1：新增一个存储引擎

- `storage/example/` 是官方模板：实现 `handlerton` init（填 `db_type`/`create`/`commit` 等 60+ 函数指针）与 `handler` 子类（override `rnd_init/rnd_next/index_read/write_row` 等）；
- `mysql_declare_plugin(myengine)` 声明（参照 `storage/innobase/handler/ha_innodb.cc:23744`）+ CMake `MYSQL_ADD_PLUGIN`；
- 想被 DDL 识别需在 `sql/handler.cc` 的 legacy_db_type 映射处登记（`ha_resolve_by_name` in `sql/handler.cc:413` 按名解析）。

#### 场景 2：新增一个服务器系统变量

- server 变量：`sql/sys_vars.cc`（485 个 `static Sys_var_*`）加定义，默认值与文档一处维护；
- 插件变量：`MYSQL_SYSVAR_*` 宏 + 加入 `st_mysql_plugin.system_vars` 数组（如 `storage/innobase/handler/ha_innodb.cc` 中 389 个 sysvar 定义全在此文件）；
- 对应测试：`mysql-test/t/` 加 `.test`（变量组合行为）。

#### 场景 3：新增一种 SQL 语句

- `sql/sql_yacc.yy` 加文法产生式（token 加 `sql/lex.h`）；
- `sql/parse_tree_nodes.h` 加 `PT_xxx` 节点，`make_cmd` 返回新 `Sql_cmd` 子类；
- `mysql_execute_command` 的 switch（`sql/sql_parse.cc:3027` 起）或 `Sql_cmd::execute` 实现语义；
- 复制安全：新语句若改数据需评估 binlog 记录方式（语句/行）。

## 测试体系

```shell
mysql-test/
├── t/  r/            # 主套件（1,899 个 .test 与对应 .result）
├── suite/            # 69 个子套件（innodb、binlog、rpl、grp_rpl、x…）
├── include/          # 共享 include 片段
└── mysql-test-run.pl # MTR 驱动（perl）
unittest/gunit/       # C++ gunit 单测（265 个文件，如 hypergraph、bgc_ticket_manager-t.cc）
```

| 代码层 | 测试类型 | 对应位置 |
| --- | --- | --- |
| SQL 层/复制/DDL | MTR 集成测试（起真实 mysqld） | `mysql-test/suite/{main,binlog,rpl,innodb,…}` |
| 优化器数据结构 | gunit | `unittest/gunit/join_optimizer*` |
| InnoDB 内部 | MTR `suite/innodb` + gunit | `storage/innobase/unittest`（历史） |
| 协议 | `suite/x` | X Plugin protobuf round-trip |

MTR 的 `.test` + `.result` 黄金文件模式使行为回归的颗粒度到输出级；理解某个特性最快的方式往往是读它的 `.test` 文件——它们是"可执行的规格说明"。

## 阅读源码推荐路线

- **第一遍：主流程**（一条 SELECT 怎么跑通）
  `sql/main.cc:29` → `sql/mysqld.cc:10453` 的 `mysqld_main`（只看初始化顺序）→ `sql/conn_handler/connection_handler_per_thread.cc:246` 的 `handle_connection` → `sql/sql_parse.cc:1347` 的 `do_command` → `sql/sql_union.cc:1068` 的 `ExecuteIteratorQuery`（Init/Read 循环）→ `sql/iterators/basic_row_iterators.cc:276` 的 `TableScanIterator::DoRead`
- **第二遍：核心数据结构**
  `sql/sql_class.h:953` 的 `THD`（看它聚合了什么）→ `sql/sql_lex.h:662/1198` 的 `Query_expression`/`Query_block` → `sql/handler.h:2852/4753` 的 `handlerton`/`handler` → `sql/join_optimizer/access_path.h:243` 的 `AccessPath` 类型枚举（45 种就是执行计划的词表）
- **第三遍：写路径与崩溃一致性**
  `sql/handler.cc:1686` 的 `ha_commit_trans` → `sql/binlog.cc:7513` 的 `ordered_commit`（对照 commit-flow.svg 逐阶段读）→ `storage/innobase/handler/ha_innodb.cc:5997` 的 `innobase_commit` → `storage/innobase/trx/trx0trx.cc:2477` 的 `trx_commit_for_mysql`
- **第四遍：选重点子模块深入**（模块文档）
  优化器爱好者走 [03](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/03-optimizer)（从 `sql/join_optimizer/join_optimizer.h:30` 的设计注释读起，它本身就是一篇论文导读）；引擎爱好者走 [06](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/06-innodb)（从 `storage/innobase/include/read0types.h:159` 的 `ReadView::changes_visible` 读起，10 行代码讲清 MVCC）；分布式爱好者走 [08](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication) 与 [10](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/10-router)

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| THD | thread descriptor，MySQL 会话上下文对象（`sql/sql_class.h`） |
| handlerton | 引擎级函数指针表（"ton" 后缀仿 singleton），server 与引擎的唯一契约 |
| MDL | Meta Data Lock，server 层元数据锁（`sql/mdl.h`，19 个命名空间） |
| DPhyp | Dynamic Programming hypergraph，超图连通子图枚举的 join order 算法（Neumann/Moerkotte 论文） |
| AccessPath | 优化器产出的物理计划节点（规划期对象），执行前转 RowIterator |
| mtr | mini-transaction，InnoDB 页级逻辑变更 + redo 单元（非 SQL 事务） |
| ReadView | InnoDB 一致性快照（MVCC 可见性判断） |
| TC_LOG | 事务协调者日志抽象，binlog 开启时由 MYSQL_BIN_LOG 实现（内部 2PC） |
| GTID | 全局事务标识 `uuid:gno`，复制定位与幂等应用的基础 |
| BGC ticket | binlog group commit 票据，26.x 精确界定组提交批次边界 |
| MTA / CSA | Multi-Threaded Applier / Change Streams Applier（26.x 新任务图 applier） |
| SDI | Serialized Dictionary Information，DD 对象的 JSON 序列化（写入表空间） |
| MRS | MySQL REST Service，Router 侧的 REST 网关插件 |
| MLE | MySQL JavaScript runtime（GraalVM polyglot，Router jit_executor 承载） |
| CalVer | 日历版本号，MySQL 2025 起创新版采用（26.x = 2026 年第 x 个创新版） |

### 参考资料

- 源内权威文档：`sql/join_optimizer/join_optimizer.h`（超图优化器设计说明）、`storage/innobase/include/lock0lock.h`（锁系统总述）、`include/mysql/components/service.h`（Service 概念定义）
- Neumann & Moerkotte, *Dynamic Programming Strikes Back*（DPhyp）；*An Efficient Framework for Order Optimization*（interesting orders）
- Mohan et al., *ARIES*（InnoDB 恢复设计的理论源头）
- 本系列其余 10 篇模块文档（见模块地图）
