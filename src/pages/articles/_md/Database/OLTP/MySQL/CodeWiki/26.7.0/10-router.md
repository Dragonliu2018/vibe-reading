---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "MySQL Router"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "Router", "路由", "连接池", "REST", "GraalVM"]
description: "独立路由进程、harness 插件体系、routing guidelines 规则语言、metadata cache 与 failover、MRS REST 网关、jit_executor JavaScript 运行时的源码解读"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

MySQL Router 是**独立于 mysqld 的操作系统进程**（同仓库 `router/`，~33.5 万行非测试代码），充当 InnoDB Cluster 的智能接入层：监听 6446/6447 等端口，把客户端连接路由到正确的 MySQL 成员（读写分离、failover），并提供连接池、REST 运维 API、MySQL REST Service（MRS）与 JavaScript 运行时。它独立存在的本质原因：**当 primary 实例故障时，客户端需要一个仍然活着的 TCP 端点接入**——若 Router 在 mysqld 进程内，被路由的 server 挂掉时 Router 也随之消失，failover 无从谈起。独立进程还带来独立升级（Plugin ABI + arch 描述符就是为此设计）、崩溃隔离与纯转发部署能力。

涉及目录：`router/src/harness/`（插件底盘）、`router/src/routing/`、`router/src/metadata_cache/`、`router/src/connection_pool/`、`router/src/routing_guidelines/`、`router/src/mysql_rest_service/`、`router/src/jit_executor/`、`router/src/rest_*/`、`router/src/keepalive/`。

## 模块架构

```text
MySQLRouter 进程（router/src/main.cc:194 的 main → real_main，:121）
  real_main 前置初始化: preconfig_log_init（读配置前先起日志）→ init_DIM（依赖注入注册表）
    → mysql_library_init（客户端库）；退出时 mysql_library_end + u_cleanup
└─ mysql_harness::Loader（harness/include/mysql/harness/loader.h:33）
     按 INI 配置 dlopen 各功能插件（.so/.dll，RTLD_LAZY|RTLD_GLOBAL）
     ┌──────────── harness 插件（Plugin struct，ABI 0x0201）────────────┐
     │ routing │ metadata_cache │ connection_pool │ http_server │ io   │
     │ rest_api / rest_router / rest_routing / rest_metadata_cache / …  │
     │ mysql_rest_service (MRS) │ jit_executor (GraalVM JS) │ keepalive │
     └───────────────────────────────────────────────────────────────────┘
     插件间经单例 Component 解耦：
     MySQLRoutingComponent / MetadataCacheAPI / ConnectionPoolComponent /
     RestApiComponent / JitExecutorComponent
```

**插件生命周期七步**（`loader.h:33-147` 注释）：Loading（`dlopen` + `RTLD_LAZY|RTLD_GLOBAL`）→ Initialization（按 `requires` 依赖拓扑序调 `init()`；**任一 init 失败则后续 init 不再跑、跳过 start/stop 直达逆序 deinit**）→ Starting（有 `start` 字段的插件各起线程，顺序任意）→ Running → Stopping（`stop()`）→ Deinitialization（逆序 `deinit()`）→ Unloading（注释明言"currently unimplemented"，进程退出前不真正卸载）。`Plugin` struct（`harness/src/plugin.h.in:291`）：`abi_version`（加载时校验，`PLUGIN_ABI_VERSION=0x0201`——最低字节 minor、次低字节 major；加回调不改旧回调则 minor+1，改签名则 major+1）、`arch_descriptor`（CPU/OS/编译器/运行时四段斜杠串，防跨编译器 ABI 混载）、`requires/conflicts` 声明（Loader 据此拓扑排序）。**为什么插件化 harness**：routing、REST、MRS、jit_executor 是互不相干的载荷，靠 requires 任意组合裁剪不必重编译主程序——这也让 GPL Router 能以"可选组件"形态链接 GraalVM polyglot 这类专有许可库而不污染核心。

## 调用链路

一次 classic protocol 连接的完整路由链：

```text
MySQLRouting::run (routing/src/mysql_routing.cc:690)
├─ run_acceptor(): 先 destination_manager_->start(env) 等目标可用，
│   注册三类回调: register_start_router_socket_acceptor（metadata 就绪才开始 listen，
│   避免把客户端引进无目标可路由的黑洞）/ register_stop_router_socket_acceptor /
│   register_md_refresh_callback（metadata 刷新时刷新 quarantine 节点列表，
│   allowed nodes 变化时对现有连接 connection_container_.disconnect）
├─ 正常分支创建两类 accepting endpoint: AcceptingEndpointTcpSocket +
│   AcceptingEndpointUnixSocket（Windows 上只有 TCP）
├─ 新连接 → round-robin 分给 IoThread 池 → create_connection 放入 ConnectionContainer
└─ Connector::connect (routing/src/connection.h:346)   # 异步状态机
   ├─ Function 枚举两态: kInitDestination → kConnectFinish（异步建连完成后回调续跑）
   ├─ 目标选择: DestinationManager
   │    ├─ dest_static（静态地址）或
   │    └─ dest_metadata_cache (:239) → get_nodes_allowed_by_routing_guidelines (:345)
   │         把 ManagedInstance 转 Server_info 交 Routing_guidelines_engine 分类
   ├─ RoutingStrategy（first-available / round-robin-with-fallback，routing.h:271 枚举）
   │    逐候选 try_connect；建成的连接按 destination socket 的 is_local()
   │    在 UnixDomainConnection 与 TcpConnection 间二选一
   └─ 三个回调: on_connect_failure_（失败上报 quarantine）/ on_connect_success_ /
        on_is_destination_good_（目的地健康判定）
   建连成功 → 双向 splice
MysqlRoutingClassicConnectionBase (classic_connection_base.cc)
├─ async_recv_both (:305) 同时挂两侧读回调——协议感知转发（非哑管道）
├─ 握手改写（注入 router 选项）· 五种认证（classic_auth_*.cc）
├─ SET 语句解析（:558/:863 sql_lexer 跟踪事务/隔离级别状态机）
└─ 事务结束且 trx_state_is_sharable (:932) → 连接归还 ConnectionPool 复用
```

方法速查：

<details>
<summary>Router 方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MySQLRouting::run` in `mysql_routing.cc:690` | 一个 [routing] section 的运行时 | metadata 就绪才 listen |
| `Connector::connect` in `connection.h:346` | 目标选择与建连状态机 | connect_timer + 失败上报 quarantine |
| `MetadataCache::refresh_thread` in `metadata_cache.cc:89` | 拓扑 TTL 刷新 | 分片 sleep 可被强制刷新打断 |
| `ConnectionPool::pop_if` in `connection_pool.h:296` | 按 endpoint+谓词取池化连接 | multimap + 谓词匹配 |
| `Routing_guidelines_engine` | guidelines 规则分类 | 静态配置可翻译成初始 guidelines 文档 |

</details>

## 核心实现

### metadata cache：TTL + 事件通知双失效

`MetadataCache`（`metadata_cache/src/metadata_cache.h:46`）缓存 `mysql_innodb_cluster_metadata` 拓扑（`v2_routers`/`v2_router_rest_accounts` 等表），双元数据源实现：`GRClusterMetadata`（组复制/ClusterSet）与 `ARClusterMetadata`（异步 ReplicaSet）。失效策略 **TTL 兜底 + GR 通知即时失效**（`gr_notifications_listener.cc` 经 X 协议订阅组变更事件）——纯 TTL 会打爆 metadata server，纯事件在通知丢失时永久陈旧，二者兼用。failover 等待逻辑 `wait_primary_failover()`（`metadata_cache.h:105` 注释区分 PRIMARY 真死与网络分区两种场景）。auth cache 独立 TTL（认证信息变更频率与拓扑不同）。bootstrap 时 Router 把自己注册进 metadata（`cluster_metadata.cc:571`），动态状态持久化到 `mysqlrouter.state`。

### routing guidelines：可编程路由规则语言

新一代路由配置：Bison 文法（`routing_guidelines/src/parser.yy`）解析规则文档，归约时**常量折叠并 emit 成 RPN 逆波兰 token 序列**（`rpn.h`），运行时对 `Router_info/Server_info/Session_info/Sql_info`（`routing_guidelines.h:59-117`，session 含 source_ip/user/schema，sql 含 query tags `/*-> tag=v */` 与 WL#12542 query attributes）求值分类。`rpn.h` 的 `Token::Type` 枚举覆盖求值所需的全谱操作：`NUM/STR/BOOL/ROLE/LIST/TAG_REF/VAR_REF/FUNC` 之外还有 `REGEXP`（正则匹配）、`NETWORK`（网络段匹配）、`RESOLVE_V4/RESOLVE_V6`（地址解析）等路由特有操作；数值统一以 double 存储、bool 按 0/1 编码。**与老式 strategy 的关系是超集**：第一个 [routing] section 启动时若 guidelines 未初始化，`create_routing_guidelines_document(...)`（`routing_plugin.cc:526`）把现有静态配置翻译成一份初始 guidelines 文档——静态配置是退化输入。`routing_simulator.cc` 提供规则预演（`mysqlrouter simulate`）。Router 进程内嵌 SQL 词法器（`routing/src/sql_lexer.cc` 直接复用 server 的 `lexer_yystype.h`）用于 SET 语句跟踪。

### 连接池与 connection sharing

`ConnectionPool`（`connection_pool/include/mysqlrouter/connection_pool.h:238`）的所有权模型：**pool**（无 client 的空闲连接）+ **stash**（仍挂着 client 的连接，connection sharing 中间态）；`PooledConnection` 持 idle_timer 异步等待；取用 `pop_if(ep, pred)` 按 endpoint 匹配，满则 `add()` 直接关闭；下线走 `ConnectionCloser::async_send_quit()` 优雅退出。可归还的判据来自协议感知转发的状态机（事务已结束、无可共享 SET 状态）。X 协议有平行实现 `x_connection.cc`。

### MRS：数据库对象到 REST 的映射

`mysql_rest_service` 插件（requires `{logger, http_server, io[, jit_executor]}`）维护 endpoint 树（`mrs/endpoint/`，父类 `OptionEndpoint`）：`content_file/content_set`（静态文件）、`db_schema_endpoint → db_object_endpoint`（库对象）、`db_service_endpoint`（存储过程/脚本服务）。HTTP 方法到 SQL 的映射由 `handler_factory.cc:216` 分派：表对象 GET→SELECT/POST→INSERT/PUT→UPDATE/DELETE→DELETE，另有存储过程、函数、**JS 脚本**（走 jit_executor）与自动生成的 OpenAPI 文档 handler。MRS 自身配置存 MySQL 表（`cluster_metadata.cc:453` 查 `v2_router_rest_accounts`）。

### jit_executor：GraalVM JavaScript 运行时

`harness_plugin_jit_executor`（`jit_executor/src/jit_executor_plugin.cc:167`，start/stop 均为 nullptr——纯被 MRS 按需驱动）。链接 GraalVM **native Polyglot API**（要求版本 23.0.1）；`class JavaScript`（`jit_executor_javascript.h:81`）在独立线程跑引擎以支持 **Promise 解析**——暴露 `synch_return/synch_error` 全局函数把异步结果同步化。这就是 SQL `CREATE FUNCTION ... LANGUAGE JAVASCRIPT`（MLE）在 Router/MRS 侧执行 Script 的机制。`ContextPool`（`jit_executor_context_pool.h:53`）池化昂贵的 GraalVM Context（专职 release 线程回收）；`shcore::Value`（来自 MySQL Shell 共享代码）做 polyglot↔C++ 类型桥接。

### REST 运维面与 keepalive

`rest_api` 插件是通用 REST 框架（route 表 + OpenAPI spec），`rest_router/rest_metadata_cache/rest_routing/rest_connection_pool/rest_host_cache` 各注册自己的 handler——`/status`、路由状态、连接池状态等运维观测全部 REST 化。26.x 新增 Router Host Cache（连接错误统计与封锁）与 HTTP server 限制（`max_connections`/`max_request_body_size`）。`keepalive` 插件周期性打日志证明事件循环存活。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 插件 + ABI 版本 | `Plugin` struct（`plugin.h.in:291`） | Router 二进制与插件 SO 可不同步发布 |
| 单例 Component 门面 | `MySQLRoutingComponent::get_instance()` 等 | 插件间无直接链接依赖，经 component 交互 |
| 状态机 | classic 连接的收发/事务跟踪 | 连接池可归还性需要精确会话状态 |
| 规则引擎 | guidelines 的 RPN 求值 | 路由策略从编译期枚举进化为数据驱动文档 |
| 对象池 | ConnectionPool / ContextPool | 建连与 GraalVM Context 都是重资源 |

## 模块间交互

- **与 server**：只经 MySQL 协议（classic + X）与 metadata 表交互——零进程间 API 耦合；`sql_lexer` 复用 server 源码是唯一的代码级共享；
- **与复制**：metadata cache 的拓扑判活消费 GTID；GR 通知经 X 协议订阅（见[复制模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication)）；
- **与 X Plugin**：GR notifications listener 依赖 server 侧 X 协议（见[插件组件模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/09-plugins-components)）。

## 扩展方式

- **新增一种 routing 策略（老式）**：`routing/include/mysqlrouter/routing.h:271` 枚举加值 + 字符串映射 → 目标选择在 `dest_static.cc`/`dest_metadata_cache.cc`；若策略可被 guidelines 表达则优先走 `routing_guidelines/`（新函数加到 `rpn.h` 的 Function_definition + `parser.yy` 产生式）——官方演进方向是 strategy 收敛进 guidelines；
- **新增一个 MRS endpoint 类型**：`mrs/endpoint/` 新建 `xxx_endpoint`（继承 `OptionEndpoint`）+ `endpoint_factory.cc` 加工厂重载 + `mrs/endpoint/handler/` 实现 HTTP handler；
- **新增 harness 插件**：新建 `router/src/<name>/` 实现 `mysql_harness::Plugin harness_plugin_<name>`（ABI/arch 字段必填）+ CMake 注册。
