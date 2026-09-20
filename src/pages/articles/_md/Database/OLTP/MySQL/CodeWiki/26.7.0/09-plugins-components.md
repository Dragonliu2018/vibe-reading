---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "插件、组件与可观测性"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "插件体系", "Component", "X Protocol", "Performance Schema", "线程池"]
description: "plugin/component/UDF 三套扩展体系、X Plugin 与 protobuf 协议、thread_pool 社区化、Performance Schema 引擎化、clone 插件的源码解读"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

MySQL 实际上有**三套并存的可加载扩展体系**：老 plugin（C 宏 + dlopen 符号发现，12 种类型）、新 component（C ABI + registry + 显式依赖，159 个 service 定义）、以及最古老的 UDF（`CREATE FUNCTION ... SONAME` 命名约定符号）。本模块解读三套体系的机制与并存原因、以及最重要的插件载荷：X Plugin（protobuf 协议的第二服务器前端）、thread_pool（26.x 社区化）、Performance Schema（以存储引擎形态暴露自身）、clone（物理克隆）。它们共同回答一个问题：**一个 30 年历史的单体服务器如何保持可扩展**。

涉及目录：`include/mysql/plugin*.h`（契约头）、`sql/sql_plugin.cc`（装载器）、`include/mysql/components/`（service 框架）、`components/`（含最小底盘 libminchassis）、`sql/server_component/`（mysql:core 组件的服务实现）、`plugin/`、`storage/perfschema/`、`sql/sql_udf.cc`。

## 模块架构

```text
【plugin 体系】                     【component 体系】
mysql_declare_plugin(NAME) 宏        DECLARE_COMPONENT + DECLARE_LIBRARY_COMPONENTS
  导出 3 个符号:                       显式 list_components() 入口函数
  _mysql_plugin_interface_version_     manifest 声明 PROVIDES/REQUIRES service
  _mysql_sizeof_struct_st_plugin_      registry 按服务名获取实现
  _mysql_plugin_declarations_[]       ┌──────────────────────────┐
        │ dlopen 符号发现              │ libminchassis（最小底盘） │
        ▼                             │ registry + dynamic_loader │
plugin_initialize (sql_plugin.cc:1298)└──────────────────────────┘
  分派表 plugin_type_initialize[MYSQL_MAX_PLUGIN_TYPE_NUM=12]
  （仅 STORAGE_ENGINE / I_S / AUDIT 有专属初始化器；
    init 回调执行期间临时释放 LOCK_plugin 防死锁）
        │                                    ▲
        │          service_plugin_registry.h 桥（插件可消费 component 服务）
        ▼
12 种插件类型（include/mysql/plugin.h:116-127）
  st_mysql_plugin 契约: type/info/name/init/check_uninstall/deinit/
  version/status_vars/system_vars/flags
```

## 调用链路

插件装载与初始化（启动期）：

```text
plugin_init_internals (sql_plugin.cc:1406)      # 三把锁 + plugin_hash[12]
plugin_init_initialize_and_reap (:1449)
└─ plugin_initialize (:1298)                     # 对每个未初始化插件
   ├─ plugin_type_initialize[type]               # 三类有专属初始化器
   │    STORAGE_ENGINE → ha_initialize_handlerton
   │    INFORMATION_SCHEMA → initialize_schema_table
   │    AUDIT → initialize_audit_plugin
   │    其余直接 plugin->plugin->init(plugin)
   ├─ add_status_vars() 注册状态变量
   └─ sys_var_pluginvar 回填插件实例指针
```

组件装载（INSTALL COMPONENT，运行期热加载）：

```text
dynamic_loader（components/libminchassis/dynamic_loader.cc）
└─ load_do_load_component_by_scheme (:722)     # file:// URN 经 scheme 加载器
   ├─ 读 manifest（组件名、PROVIDES/REQUIRES、元数据）
   ├─ depth_first_search 依赖拓扑排序
   └─ 逐组件 init()（init 内禁止 acquire/release 服务——依赖必须写进 REQUIRES）
```

## 核心实现

### 为什么 plugin 和 component 两套并存

`components/libminchassis/dynamic_loader.cc:50-70` 的 `@page PAGE_COMPONENTS` 直接列出 Oracle 推 component 的四个动机（一手证据）：

1. plugin 只能和 server 对话，**插件之间无法互相调用**；
2. plugin 直接链接 server 导出符号，**无封装**；
3. **没有显式依赖声明**，初始化顺序难以正确安排；
4. plugin 需要一个已运行的 server 才能工作（component 可独立成库，如 log_builtins 被 mysqlbinlog 等工具复用）。

迁移策略：装机量巨大的老插件（InnoDB/PFS/X/clone）不可一夜迁移；新功能走 component，老插件经 `include/mysql/service_plugin_registry.h` 桥接消费 component 服务（X Plugin 即实例）。Service 的设计约束写在 `include/mysql/components/service.h:36-72`：无状态接口（状态经 opaque pointer 的 create/release 句柄传递，返回值用 `mysql_service_status_t`）、只用基本 C 类型防 C++ ABI 不兼容、**service 不做版本管理——改接口必须复制成新名字的 service**（用命名空间换 ABI 稳定）。`sql/server_component/server_component.cc` 的 `mysql:core` 组件（`DECLARE_COMPONENT(mysql_server, "mysql:core")`，init/deinit 为 `mysql_server_init/mysql_server_deinit`）一处就有 245 个 `PROVIDES_SERVICE`。

### X Plugin：一个 .so 双插件 + protobuf 前端

`mysql_declare_plugin(mysqlx)`（`plugin/x/src/xpl_plugin.cc:35-67`）声明**两个**插件：`MYSQL_AUDIT_PLUGIN` "mysqlx_cache_cleaner"（sha2 认证缓存随密码变更审计失效——必须以 AUDIT 类型挂进通知链）+ `MYSQL_DAEMON_PLUGIN` "mysqlx"（主服务）。启动链：`Module_mysqlx::initialize` → `Server_builder` 以 `Session_scheduler`（`server/session_scheduler.h:35`，继承 `ngs::Scheduler_dynamic`——**worker 数随负载动态伸缩**的线程池，不是一连接一线程）构造 `xpl::Server`（`server.h:65`，状态机 running/failure/terminating，默认端口 33060）。

协议层是 12 个 proto（`plugin/x/protocol/protobuf/mysqlx_*.proto`：connection/session/crud/expr/datatypes/resultset/sql/prepare/cursor/expect/notice）——protobuf 的自描述消息使协议可前向兼容扩展（notice 管道、expect 块都依赖此特性），多语言客户端可直接生成代码（官方动机陈述待核实）。**CRUD 到 SQL 的映射**：`crud_cmd_handler.cc` → `expr_generator.cc` 把 `mysqlx_expr` 编译成 SQL 表达式文本 → `query_string_builder.cc` 拼出**纯 SQL**；执行核心在 `Sql_data_context::execute`（`sql_data_context.cc:561`）→ `execute_server_command`（`:652`）调 command service，跑在 `srv_session_open`（`:104`）创建的内部 `MYSQL_SESSION`（SERVER session，非网络连接的 THD），每次执行 attach/detach 到当前 worker 线程；结果经 `streaming_command_delegate.cc` 回编为 `mysqlx_resultset` 消息。

### thread_pool：26.x 社区化

`plugin/thread_pool/src/thread_pool_plugin.cc:1116` 的 `mysql_declare_plugin(thread_pool)` 实际声明**四个**插件：一个 DAEMON 主插件（flags 设 `PLUGIN_OPT_NO_INSTALL`——禁止运行时卸载）+ 三个 INFORMATION_SCHEMA 表插件（`TP_THREAD_STATE`、`TP_THREAD_GROUP_STATE`、`TP_THREAD_GROUP_STATS` 诊断表）；核心实现在 `thread_pool.cc`（194KB）。结构：最多 512 个 thread group（`MAX_NORMAL_THREAD_GROUPS` + 1 个 admin 组保证管理操作在正常组全阻塞时可用）+ IO 多路复用（`epoll.cc/poll.cc`/Windows 三实现）；连接按 connection id 哈希分组，组内正常时刻单线程活跃，`threadpool_stall_limit`（默认 6s）检测长查询后追加 worker；26.x 新增高并发模式（`thread_pool_query_threads_per_group`，每组多个 query worker）。server 侧边界：`include/mysql/thread_pool_priv.h` 显式列出插件可访问的 server 内部符号——这是 Oracle 开源企业版插件时的边界管理方式（该头注释明确写 "maintained in the community version"）。

### Performance Schema：做成存储引擎的观测面

PSI 插桩接口（`include/mysql/psi/`，72 个头）分两类：内联插桩 API（`mysql_mutex.h/mysql_file.h/mysql_statement.h/...` 包装原生原语，lock/unlock 前后调 PSI hook）与冻结 ABI 头（`psi_abi_*_v1.h`，向插件承诺稳定性，配套 `.pp` 预处理产物防意外改动）。使用范式：`PSI_mutex_info` 数组 + `mysql_mutex_register("sql", ...)` 把 key 注册进 instrument class。**为什么 PFS 做成存储引擎**（`ha_perfschema.cc:1608` 的 `mysql_declare_plugin(perfschema)`，STORAGE_ENGINE 插件、引擎名 "performance_schema"、init/deinit 为 `pfs_init_func/pfs_done_func`、专属 `db_type=DB_TYPE_PERFORMANCE_SCHEMA`——注释引 Bug#43039：bootstrap 与正常运行的 legacy_db_type 必须一致）：(a) 复用整个 SQL 层（优化器/prepare/权限）而不发明新协议；(b) 引擎 flags 天然禁止 DDL/binlog/分区等不适用操作；(c) 内存中的易失统计数据需要游标式 `rnd_next/rnd_pos` 直读内存数组——目录 163 个 .cc 中 110 个 `table_*.cc` 一表一文件。PFS 有独立版本号（与 DD/I_S 分开治理）。

### clone 插件与 UDF

clone（`plugin/clone/src/clone_plugin.cc:682`，`MYSQL_CLONE_PLUGIN`，生命周期回调 `plugin_clone_init/plugin_clone_check/plugin_clone_deinit`）：descriptor 三入口——`clone_local(THD, data_dir)`（本地克隆）、`clone_client(THD, remote_host, ...)`（客户端角色连远端拉数据）、`clone_server(THD, MYSQL_SOCKET)`（服务端角色在独立 socket 上供远端拉取）。物理克隆 = 逐文件/块传输 + apply（配合 InnoDB redo 归档与 Flush_observer，见[InnoDB 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/06-innodb)）。做成第 11 种插件类型而非普通 daemon 的原因：server 需要按类型调用它。UDF（`sql/sql_udf.cc:111` 的 `udf_hash`）：`CREATE FUNCTION ... SONAME` → dlopen 按命名约定找 `xxx_init/xxx/deinit` 符号——无类型系统、无 sysvar、无生命周期管理，与 plugin 完全独立。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 注册表 + 发现 | 符号约定（plugin）/ 显式入口（component） | 两代机制的取舍：约定简单、显式可依赖 |
| 服务定位器 | `my_service<T>` acquire（`include/mysql/components/my_service.h`） | 按名解耦获取实现，支持 override |
| 双插件 | X Plugin 的 DAEMON + AUDIT | plugin 类型本质是"server 回调挂点集合"，功能跨挂点就声明多个 |
| 插桩装饰 | PSI 包装宏 | 零侵入插桩，release 关闭后近零开销 |

## 模块间交互

- **与存储引擎 API**：InnoDB/PFS 等全部以 STORAGE_ENGINE plugin 接入（见[存储引擎 API](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/05-storage-engine-api)）；
- **与复制**：semisync/GR 以 observer 挂进提交链（见[复制模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication)）；GR 是第 9 种插件类型；
- **与连接层**：X Plugin 的 Session_scheduler 与 classic 的 per-thread 并存（见[连接层](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/01-connection-layer)）；thread_pool 整体替换 Connection_handler 行为；
- **与 Router**：Router 经 X 协议订阅 GR 通知做拓扑失效（见[Router 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/10-router)）。

## 扩展方式

- **新增 daemon 插件**：`plugin/foo/foo.cc` 写 `st_mysql_daemon` descriptor + `mysql_declare_plugin(foo){MYSQL_DAEMON_PLUGIN, &descriptor, ...}`（参照 `thread_pool_plugin.cc:995/1116`）+ CMake `MYSQL_ADD_PLUGIN`——server 侧无需改代码（无专属初始化器的类型直接调 init）；
- **新增 component service**：`include/mysql/components/services/foo.h` 用 `BEGIN_SERVICE_DEFINITION(foo)` 定义 → `sql/server_component/foo_service_imp.cc` 实现（`BEGIN_SERVICE_IMPLEMENTATION(mysql_server, foo)`）→ `server_component.cc` 的 PROVIDES 加一行 → 消费方 `my_service<SERVICE_TYPE(foo)>::acquire("foo", registry)`；独立组件参照 `components/keyrings/keyring_file/keyring_file.cc:333`；
- **新增 PFS 表**：`storage/perfschema/table_foo.cc` 新建 `PFS_engine_table_share` 与游标类 → 追加进 `pfs_engine_table.cc:488` 的 `all_shares[]`。
