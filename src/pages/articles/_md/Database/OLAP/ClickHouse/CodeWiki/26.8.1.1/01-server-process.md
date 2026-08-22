---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "服务端入口与进程模型"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "Server", "网络协议", "多路复用"]
description: "ClickHouse 单二进制多路复用与多协议 server 源码解读——main 分发表、Server::main 装配、HTTP/TCP handler 与工厂模式。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

本模块是 ClickHouse 对外的唯一边界——`programs/main.cpp` 把 30+ 子工具编进一个 `clickhouse` 二进制，`programs/server/Server.cpp` 装配并启动 server，`src/Server/` 的各 handler 把 HTTP/TCP/MySQL/PostgreSQL/gRPC 协议全部汇聚到 `executeQuery()` 单一入口。它独立成模块因为"协议接入"与"查询执行"是两个正交关注点：换协议不影响引擎，换引擎不影响协议。

## 模块架构

模块内核心组件按"分发 → 装配 → 协议 handler"三段组织。分发段是 `clickhouse_applications[]` 数组+匹配器；装配段是 `Server::main` 的工厂注册与线程池构建；协议段是每协议一对 Factory+Handler，通过 `ProtocolServerAdapter` 统一管理。

```text
programs/main.cpp          ── 分发表 clickhouse_applications[] + isClickhouseApp 匹配
programs/server/Server.cpp ── Server::main 装配（register*/Context/线程池/createServers）
src/Server/
  ├─ IServer.h                 ── 抽象接口（依赖倒置，handler 不依赖 Server 类）
  ├─ ProtocolServerAdapter.h   ── 适配器（统一 TCPServer/HTTPServer/GRPCServer）
  ├─ HTTPHandlerFactory.h     ── HTTP handler 工厂（带过滤规则链）
  ├─ HTTPHandler.h/.cpp        ── HTTP 查询处理（模板方法骨架）
  ├─ TCPHandlerFactory.h       ── TCP handler 工厂
  ├─ TCPHandler.h/.cpp         ── 原生 TCP 协议查询处理
  ├─ createServer.cpp          ── createServer 端口装配
  └─ TCPProtocolStackFactory.h── 协议栈组合（tls+proxy+tcp 叠加）
```

装配段的核心是 `Server::main`（`programs/server/Server.cpp:1211`，约 4310 行），它完成 14 个 `register*` 调用装配所有工厂、创建全局 `Context`、构建多级线程池、`createServers()` 装配各协议监听。协议 handler 段每协议成对出现：`XxxHandlerFactory`（工厂方法）创建 `XxxHandler`（策略），handler 实现模板方法骨架，最终都调 `executeQuery()`。

## 调用链路

从 `main()` 到查询执行的调用链：

```text
main() in programs/main.cpp:258
└─ 遍历 clickhouse_applications[] → isClickhouseApp() 匹配 "server"
   └─ mainEntryClickHouseServer() in programs/server/clickhouse-server.cpp
      └─ Server::run() → Server::main() in programs/server/Server.cpp:1211
         ├─ registerInterpreters()/registerFunctions()/registerStorages()/... (14 个)
         ├─ Context::createShared() + Context::createGlobal()
         ├─ createServers() in Server.cpp:3764          ── 按 listen_host × ServerType 装配
         │  └─ DB::createServer() in src/Server/createServer.cpp ── 创建 ProtocolServerAdapter
         │     └─ HTTPHandlerFactory / TCPHandlerFactory / MySQLHandlerFactory ...
         └─ server_pool.joinAll()
            └─ [新连接到达] XxxHandlerFactory::createConnectionImpl() → new XxxHandler(...)
               └─ HTTPHandler::handleRequest() in HTTPHandler.cpp:724
                  └─ HTTPHandler::processQuery() in HTTPHandler.cpp:188
                     └─ executeQuery() in src/Interpreters/executeQuery.h  ── 汇聚到执行引擎
```

TCP 路径略不同：`TCPHandler::run()` → `runImpl()` 先 `receiveHello()` 认证握手，再循环 `receivePacketsExpectQuery()` → `processOrdinaryQuery()` 用 `PullingAsyncPipelineExecutor` 拉结果块并 `sendData()`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `main` in `programs/main.cpp` | 二进制入口、子命令分发 | 数组式分发表优于 if-else 链 |
| `Server::main` in `Server.cpp:1211` | server 装配与启动 | 14 个 register + Context + 线程池集中装配 |
| `Server::createServers` in `Server.cpp:3764` | 装配多协议监听 | 每 host × 协议创建 adapter |
| `HTTPHandler::handleRequest` in `HTTPHandler.cpp:724` | HTTP 查询模板方法骨架 | 骨架固定，getQuery 留给子类 |
| `HTTPHandler::processQuery` in `HTTPHandler.cpp:188` | HTTP 查询处理核心 | 多层 WriteBuffer 管道 |
| `TCPHandler::runImpl` in `TCPHandler.cpp:363` | TCP 连接生命周期 | 每连接一线程 + QueryState |
| `ProtocolServerAdapter` in `ProtocolServerAdapter.h` | 统一多协议 server | Pimpl + Impl 多态 |

</details>

## 核心实现

### 单二进制多路复用

`clickhouse_applications[]` in `programs/main.cpp:132` 是 `{string_view, MainFunc}` 数组，把子命令名映射到 entry function：

```cpp title="programs/main.cpp"
std::pair<std::string_view, MainFunc> clickhouse_applications[] =
{
    {"local", mainEntryClickHouseLocal},
    {"client", mainEntryClickHouseClient},
    {"server", mainEntryClickHouseServer},
    {"benchmark", mainEntryClickHouseBenchmark},
    {"keeper", mainEntryClickHouseKeeper},
    // ... 30+ 子命令
};
```

`isClickhouseApp()` 支持三种匹配：`clickhouse server` 子命令、`clickhouse --server`、符号链接 `clickhouse-server`（检测 `argv[0]`）。无参数默认走 `local`。

**为什么单一二进制**：部署只需分发一个文件；server 与 client 共享全部核心代码避免符号重复；静态链接无需 `dlopen`。`main.cpp:250-278` 甚至显式 override `dlopen` 返回 nullptr——注释直言"loading 3rd-party uncontrolled dangerous libraries into the process address space is insane"，单一二进制+静态链接保证安全与确定性行为。

### 多协议汇聚与 ProtocolServerAdapter

`Server::createServers()` 遍历 `listen_hosts`，对每个 host 按 `ServerType` 创建协议：

```cpp title="programs/server/Server.cpp"
// createServers 简化逻辑
for (const auto & host : listen_hosts)
{
    if (server_type.shouldStart(ServerType::Type::HTTP))
        createServer(host, http_port, [](...) {
            return std::make_shared<HTTPServer>(createHandlerFactory(...), server_pool, ...);
        });
    if (server_type.shouldStart(ServerType::Type::TCP))
        createServer(host, tcp_port, [](...) {
            return std::make_shared<TCPServer>(new TCPHandlerFactory(server, ...), server_pool, ...);
        });
    // mysql_port / postgresql_port / grpc_port / interserver_http_port ...
}
```

`ProtocolServerAdapter`（`src/Server/ProtocolServerAdapter.h`）用 Pimpl+`Impl` 多态基类统一 `TCPServer`/`HTTPServer`/`GRPCServer`——这三者无公共基类，但 `Server::main` 需用一个 `vector<ProtocolServerAdapter>` 统一 start/stop/connections。这是适配器模式的典型应用。

### 线程模型：每连接一线程 + 共享线程池

```cpp title="programs/server/Server.cpp:1538"
Poco::ThreadPool server_pool(
    3,                                          // min 线程
    server_settings[ServerSetting::max_connections], // max（默认 4096）
    60, ...);                                   // idle 超时
```

所有 `TCPServer`/`HTTPServer` 均传入 `server_pool`。每连接分配一个线程，连接关闭后归还。**为什么不用 reactor 异步**：查询执行本身 CPU 密集，线程内同步逻辑简单可靠；`max_connections` 限并发防线程爆炸；`TCPServerConnectionFilter` 在 accept 前检查 CPU 过载拒绝新连接。查询内并行用 `GlobalThreadPool`（`PullingAsyncPipelineExecutor`），server_pool 线程负责拉取发送结果——两级线程模型。

### HTTPHandler 模板方法

`HTTPHandler::handleRequest`（`HTTPHandler.cpp:724`）是模板方法：认证 → session → query context → 多层 WriteBuffer 输出管道 → `processQuery` → 异常处理。`getQuery()` 与 `customizeQueryParam()` 是纯虚，由 `DynamicQueryHandler`（从 URL 参数取 query）和 `PredefinedQueryHandler`（从 config 取）实现：

```cpp title="src/Server/HTTPHandler.h"
class HTTPHandler : public HTTPRequestHandler {
    void handleRequest(...) override;
    virtual std::string getQuery(...) = 0;          // 子类实现
    virtual bool customizeQueryParam(...) = 0;
private:
    void processQuery(...);                          // 调 executeQuery
    struct Output { /* raw → compressed → delayed WriteBuffer 管道 */ };
};
```

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 命令分发 | `clickhouse_applications[]` in `main.cpp:132` | 30+ 子命令数组式分发表易维护 |
| 工厂方法 | `HTTPHandlerFactory`/`TCPHandlerFactory` | 运行时按 config 创建不同 handler，带过滤规则链 |
| 适配器 | `ProtocolServerAdapter` | 统一无公共基类的多协议 server |
| 模板方法 | `HTTPHandler::handleRequest` | 骨架固定，getQuery 留子类 |
| 策略 | 各协议 handler | 不同协议是不同接入策略，汇聚到 executeQuery |
| 协议栈组合 | `TCPProtocolStackFactory` | 同端口叠加协议层（tls+proxy+tcp） |

## 扩展方式

新增一种网络协议（如 Cassandra 兼容）：新建 `src/Server/CassandraHandlerFactory.h`（仿 `TCPHandlerFactory`）+ `CassandraHandler.h/.cpp`（仿 `TCPHandler`，`run()` 解析协议包最终调 `executeQuery`）；在 `ServerType::Type` 加枚举；`Server::createServers` 加分支；`ProtocolServerMetrics.h` 加 ProfileEvents。新增 HTTP 路由则可纯配置：在 `config.xml` 的 `<http_handlers>` 加 handler 配置，`createHandlerFactory` 动态加载，无需改代码。

## 模块间交互

本模块 import `Interpreters/Context`（`IServer::context()` 获取全局上下文）、`Interpreters/executeQuery`（查询统一入口）、`Interpreters/Session`（会话认证）、`Access/AccessControl`（认证）、`Parsers/Lexer`（判断 INSERT）、`Compression`（响应压缩）。被 `AsynchronousMetrics` 引用（采集协议指标）。所有 handler 通过 `IServer` 抽象接口依赖 server，不直接依赖 `Server` 类——依赖倒置。
