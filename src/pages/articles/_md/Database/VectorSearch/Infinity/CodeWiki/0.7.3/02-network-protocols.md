---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "网络协议层"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 网络协议层解读：Thrift 主协议直传 ParsedExpr AST 免 SQL 解析、PostgreSQL wire 协议兼容通道、oatpp HTTP REST 前端、集群 Peer 双端 RPC，四协议汇聚同一门面"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/network/`（手写部分约 9,400 行，另有 5.6 万行 thrift 生成代码在 `infinity_thrift/` 与 `peer_server_thrift/` 子目录）实现**四个服务器前端**：Thrift server（SDK 主协议，ClientPort 23817）、PGServer（PostgreSQL wire 协议，5432）、HTTPServer（oatpp REST，23820）、PoolPeerThriftServer（集群节点间 RPC）。四个前端在一个进程里并存（`infinity_main.cpp:255-272` 装配），**前三个汇聚到同一条执行管道**（`Infinity` 门面 → `QueryContext`），peer server 则独立汇聚到 `ClusterManager`。

这个模块的职责边界刻意收窄：协议编解码 + 会话生命周期 + 请求到门面的翻译，**零直接依赖 catalog/storage**。业务语义全部下沉到门面。

---

## 模块架构

```text
src/network/
├── thrift_server.cppm/_impl          PoolThriftServer：TThreadPoolServer 装配 + 克隆工厂
├── infinity_thrift_service.cppm/_impl InfinityThriftService：~50 个 RPC 的 handler
├── pg_server.cppm/_impl               PGServer：boost::asio accept + 每连接一线程
├── pg_protocol_handler.cppm/_impl    PG wire format 编解码（不含业务）
├── connection.cppm/_impl             PG 协议状态机 + session 持有者
├── http_server.cppm/_impl            oatpp WebServer：~90 条路由
├── http/http_search.cppm/_impl        HTTPSearch：JSON → ParsedExpr 解析 + 查询入口
├── peer_thrift_server / peer_thrift_client / peer_task   集群双端
├── buffer_reader / buffer_writer / ring_buffer_iterator   协议缓冲原语
└── node_info                          集群节点信息 RPC 类型
thrift/infinity.thrift                主协议 IDL（66 个 Response 类型）
thrift/peer_server.thrift             集群协议 IDL
```

核心设计是**三客户端协议的分层定位**：

- **Thrift 是主协议**：`SelectRequest` 传的是 `ParsedExpr` **AST 树**而非 SQL 文本——SDK 侧的 API 调用直接映射为 thrift struct，服务端跳过 SQL 解析直达 binder，表达能力也最强（highlight_list、search_expr 的 knn/match_sparse/match_tensor/fusion 等）。
- **PG wire 是兼容/调试通道**：`pg_server_impl.cpp:51` 直接打印 `"Run 'psql -h {} -p {}' to connect to the server (SQL is only for test)"`——只实现 simple query，认证写死通过，extended protocol 五种命令空实现。但 OID 映射做得很认真：embedding 列映射到 PG 数组 OID（`connection_impl.cpp:273-326`），向量列在 psql 里可读。
- **HTTP 是无状态 REST**：每个 handler 自建自销 session，适合 curl/LangChain 集成。

---

## 调用链路

### Thrift 路径：AST 直传

```text
SDK (thrift binary, :23817)
 → TThreadPoolServer 池线程（池大小 = ConnectionPoolSize 配置）
 → InfinityServiceCloneFactory::getHandler：每连接 new InfinityThriftService
 → InfinityThriftService::Select(response, request)        infinity_thrift_service_impl.cpp:467
    1. GetInfinityBySessionID(session_id)                   在静态 infinity_session_map_ 查 Infinity
    2. GetKnnExprFromProto / GetMatchSparseExprFromProto ... （proto → AST，不做 SQL 解析！）
    3. infinity->Search(db, table, search_expr, filter, ...)  → 门面 → QueryContext
    4. QueryResult → ProcessDataBlocks → response.column_fields（列式序列化）
```

连接管理是**显式 RPC 而非连接事件**：`Connect`（`infinity_thrift_service_impl.cpp:132-166`）先做客户端版本协商——`current_version_index_ = 37`（0.7.3），版本表 `ClientVersions` 覆盖 0.5.0.dev1→0.7.3 共 37 个索引，不匹配即 `ClientVersionMismatch` 拒绝。然后 `Infinity::RemoteConnect()` 建 session，把 `session_id → Infinity` 塞进静态 map。**session 生命周期与 TCP 连接解耦**（SDK 可跨连接复用 session_id）；PG/HTTP 则是连接或请求结束即销毁。

### PG 路径：wire 协议状态机

```text
psql (:5432)
 → PGServer::Run：io_context + async_accept
 → StartConnection：detach 新线程 → Connection::Run       connection_impl.cpp:63
    ├─ session_manager->CreateRemoteSession()             维护模式返回 nullptr → 断开
    ├─ 握手：SSL 协商(80877103) → 回 'N' 重读 → AuthenticationOK（恒通过）
    │        → ParameterStatus(server_version=14, UTF8...) → ReadyForQuery('I')
    └─ 循环 HandleRequest：
         只实现 'Q'(simple query) 与 'X'(terminate)；'B'/'D'/'E'/'P'/'S' 空实现
         → query_context->Query(sql)                      ← 与 thrift 唯一不同：走 SQL parser
         → SendTableDescription：LogicalType → PG OID 硬编码映射
         → SendQueryResponse：逐 DataBlock 逐行 ToString → DataRow('D')
         → CommandComplete → ReadyForQuery
```

PG 的连接是 thread-per-connection 同步阻塞模型，仅 accept 异步，靠 `running_connection_count_` 计数配合优雅停机。注意 PG 路径绕过了 `Infinity` 门面直接构造 `QueryContext`——`connection_impl.cpp:106-116` 是网络层直接 import `query_context` 的唯一例外（源码有 FIXME 标记，计划改为按 session 缓存）。

### HTTP 路径与 Peer 双端

HTTP：oatpp 路由表（`http_server_impl.cpp:4244-4385` 注册约 90 条路由）→ `SelectHandler::handle` 内 `Infinity::RemoteConnect()` + `DeferFn(RemoteDisconnect)`（每请求建/销 session）→ `HTTPSearch::Process`（`http_search_impl.cpp:39`）用 simdjson 解析 body 的 `output/highlight/filter/sort/search{match_dense,...}` → `ParseXxx` 系列转 ParsedExpr → 门面。

Peer 双端：follower→leader 走 `RegisterPeerTask/HeartBeatPeerTask`（`PeerClient` 单发送线程 + 任务队列 + `Wait/Complete` cv 同步）；leader→follower 走 `SyncLogTask`，follower 侧 `PeerServerThriftService::SyncLog` 校验角色后 `FlushLogByReplication` 落盘再回放。`PeerServerThriftService` 六个方法全部一行式委托 `InfinityContext::instance().cluster_manager()->…`。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `PoolThriftServer::Init` | `thrift_server_impl.cpp:90` | TThreadPoolServer + TBinaryProtocol + 克隆工厂装配 |
| `InfinityThriftService::Select` | `infinity_thrift_service_impl.cpp:467` | SELECT RPC：proto→AST→门面→列式序列化 |
| `InfinityThriftService::Connect` | `infinity_thrift_service_impl.cpp:132` | 版本协商 + session 建立 |
| `PGServer::StartConnection` | `pg_server_impl.cpp:88` | detach 每连接线程 |
| `Connection::HandleSimpleQuery` | `connection_impl.cpp:153` | SQL 文本 → QueryContext → RowDescription/DataRow |
| `PGProtocolHandler::read_startup_header` | `pg_protocol_handler_impl.cpp:29` | SSL 协商 80877103 处理 |
| `HTTPSearch::Process` | `http_search_impl.cpp:39` | JSON body → ParsedExpr → 门面 Search |
| `PeerClient::Send` | `peer_thrift_client_impl.cpp` | 入队 + 单线程串行消费 |

</details>

---

## 核心实现

### 克隆工厂与递归上限

thrift server 用 `TThreadPoolServer + ProcessorFactory`，要求每连接独立 handler 实例——`InfinityServiceCloneFactory::getHandler` 每条 TCP 连接 `new InfinityThriftService`（`thrift_server_impl.cpp:46-53`）。配套的 `CustomerBufferedTransportFactory` 把 thrift 递归上限调到 256，因为 `SelectRequest` 里的 `ParsedExpr` 是递归结构，默认上限会被深表达式打爆。

"connection limit" 就是 `TThreadPoolServer` 的 `ThreadManager` 线程数（`ConnectionPoolSize` 配置）；`Connect` RPC 里 `session_count + 10 > pool_size` 时打 WARN——session 数被有意保持在线程池容量附近，一连接一线程 handler，天然背压。

### OID 映射：让 psql 读得懂向量列

`SendTableDescription`（`connection_impl.cpp:176-391`）把 Infinity 的 LogicalType 硬编码映射到 PG OID：`kInteger→23`、`kBigInt→20`、`kVarchar→25`、`kDate→1082`、`kTimestamp→1114`；embedding 列按元素类型映射到 PG 数组 OID（`float[]→1021`、`int8[]→1016` 等）。这套映射是接入 pgvector 生态工具的基础设施——虽然 v0.7.3 尚无 pgvector 扩展协议（仓库内无相关代码，待核实上游规划）。

### 错误的协议约定

三种前端、一套 `Status`/`ErrorCode` 内部错误码：thrift 填 `error_code/error_msg` 字段（带 `[THRIFT ERROR]` 头）；PG 发 `ErrorResponse('E'/'M')` 后**仍发 ReadyForQuery 保持连接存活**（`connection_impl.cpp:55-61`）；HTTP 回 `{"error_code", "error_msg"}` + 500。

### 停机状态机

四个 server 均用 `enum Status + compare_exchange_strong + atomic::wait/notify_one` 的 CAS 三态生命周期（kStopped/kRunning/kStopping，如 `thrift_server_impl.cpp:117-148`）。PG 侧 `num_running_connections` 计数确保 detach 出去的连接线程跑完才真正退出。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Clone Factory | `InfinityServiceCloneFactory`（`thrift_server_impl.cpp:46`） | thrift 池化服务器的接口要求 |
| 协议适配器 | `PGProtocolHandler`（纯 wire format）与 `Connection`（状态机）分离 | 换传输层不动协议逻辑 |
| Command + Future | `PeerTask::Wait/Complete` + `PeerClient` 队列 | 异步投递可选同步等待 |
| 路由表 + 策略 | 90+ 个 `XxxHandler : HttpRequestHandler` 集中注册 | 新端点 = 新类 + 一行 route |
| Facade 消费 | 所有 handler 只调 `infinity->Xxx()` | 网络层零 catalog/storage 依赖 |
| CAS 状态机停机 | 四 server 统一 | 优雅停机的标准做法 |

---

## 模块间交互

- **SessionManager**：三处入口汇聚 `CreateRemoteSession()`——PG 的 `Connection::Run`、thrift 的 `Infinity::RemoteConnect`、HTTP handler。维护模式下返回 nullptr，PG 连接直接收到拒绝。
- **Infinity 门面**：`GET_QUERY_CONTEXT` 宏（`infinity_impl.cpp:77-83`）封装"上下文未启动返回 `InfinityIsStarting`"检查。
- **PeerServer ↔ ClusterManager**：六个 RPC 一行式委托 + `GetServerRole()` 角色校验（非 leader 收 Register/HeartBeat 返回 `kInvalidNodeRole`）。HeartBeat 回带集群视图，收到 `kRemoved` 时 follower 自杀重连。
- **复制走 WAL 日志条目**：`SyncLog` 直接 `FlushLogByReplication(log_entries, on_startup)` 把 leader 推来的日志写进 follower 本地 WAL——重启恢复与在线复制共用同一套日志通道。注意 v0.7.3 的 `ContinueStartup`/`ApplySyncedLogNolock`（follower 侧 catalog 回放应用）函数体已被整体注释成空壳，`NewLeader` RPC handler 也是空实现——**集群复制链路是半成品**（推日志与落盘已实现，回放应用未接线）。

---

## 扩展方式

**新增一个 thrift RPC 方法**：`thrift/infinity.thrift` 加 `XxxRequest/XxxResponse` struct + service 方法 → thrift 编译器重新生成 `src/network/infinity_thrift/`（纯生成代码勿手改）→ `infinity_thrift_service.cppm` 加 `final` 声明 → `_impl.cpp` 三段式实现（`GetInfinityBySessionID` → 新增 `GetXxxFromProto` 转换 → `infinity->Xxx(...)` → `ProcessQueryResult`）→ 门面加方法 → SDK 各语言客户端同步升版本号。

**新增一个 HTTP 端点**：仿 `SelectHandler` 写 `XxxHandler` → 路由表加一行 → 若涉及新查询能力，`http_search_impl.cpp` 的 `ParseXxx` + 键分发循环挂新 key。注意当前所有 HTTP 路由无鉴权中间件，生产部署依赖网络隔离。

**新增一个 peer RPC**：`peer_server.thrift` 加方法 → 重新生成 → handler 委托 ClusterManager → `peer_task.cppm` 加 `XxxPeerTask` → `peer_thrift_client` 加封装 → `cluster_manager_*_impl.cpp` 构造任务并 Send。
