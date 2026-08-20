---
source:
  type: "源码解读"
  project: "InfluxDB"
  url: "https://github.com/influxdata/influxdb"
title: "HTTP API 服务"
date: "2026-08-20T13:07:26+08:00"
category: [Database, TSDB, InfluxDB, CodeWiki, "3.11.1"]
tags: ["InfluxDB", "Rust", "TSDB"]
description: "InfluxDB 3 Core 的 HTTP API（端口 8181）与 FlightSQL gRPC 同端口复用、路由分发与 Tower 中间件栈"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/00-overview)

---

## 模块定位

`influxdb3_server` 是 InfluxDB 3 Core 对外的协议层，承载 HTTP API（端口 8181）与 FlightSQL gRPC。它的核心职责是**协议隔离与路由分发**：把外部协议（HTTP/gRPC/FlightSQL）翻译为内部 trait 调用（`WriteBuffer`/`QueryExecutor`/`AuthProvider`），保护核心引擎不受协议变化影响。它不实现查询或写入逻辑，而是把请求路由到正确的子系统。关键设计是 **HTTP/gRPC 同端口复用**——单一 `TcpListener` 同时服务两种协议，通过 `is_grpc_request()`（HTTP/2 + `application/grpc` content-type）检测分流。

## 模块架构

模块由四部分组成：**`Server`**（`lib.rs:150`）持有 listener 与 TLS 配置，通过 `CreateServerArgs` builder 构造；**`HttpApi`**（`http.rs:1009`）是 HTTP 路由核心，持有 `write_buffer`/`query_executor`/`processing_engine`/`authorizer` 等依赖；**`UnifiedService<S>`**（`unified_service/service.rs:18`）实现 `tower::Service<Request>`，在 `call()` 中检测协议分发到 gRPC 或 HTTP；**`FlightService`**（`core/service_grpc_flight/src/lib.rs:662`）实现 `arrow_flight::FlightService` trait，处理 do_get/get_flight_info 等。`CommonServerState`（`lib.rs:94`）持有 catalog/metrics/trace_exporter 等 HTTP 与 gRPC 共享的基础设施。

## 调用链路

```
TCP 连接 → hyper ConnectionBuilder (lib.rs:374)
  └─ Tower ServiceStack:
       RemoteAddrLayer → TraceLayer(http) → TraceLayer(grpc) → UnifiedService
         │
         ├─ [gRPC] is_grpc_request()?  (HTTP/2 + content-type: application/grpc)
         │    └─ grpc_service.call(req) → FlightService
         │         (do_get/get_flight_info/do_action/handshake...)
         │
         └─ [HTTP] route_request()  (http.rs:2609)
              └─ perform_routing()  (http.rs:2680)
                   ├─ 认证: authenticate_request() (跳过 health/admin-token 端点)
                   ├─ match (method, path):
                   │    write: /write, /api/v2/write, /api/v3/write_lp → write_lp
                   │    query: /api/v3/query_sql, /query_influxql, /query
                   │    token: /api/v3/configure/token/* (create/regenerate/delete)
                   │    db/table: /api/v3/configure/database, /table
                   │    cache: /api/v3/configure/last_cache, /distinct_cache
                   │    plugin: /api/v3/engine/*, /api/v3/plugins/*
                   │    health: /health, /ping, /metrics, /debug/pprof/heap
                   └─ 后处理: CORS header + cluster-uuid header
```

<details>
<summary>方法速查表</summary>

| 方法名 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `serve` in `lib.rs:374` | TCP 接受循环 + GracefulShutdown | TLS ALPN 协商 h2+http/1.1 |
| `route_request` in `http.rs:2609` | HTTP 路由入口 | 记录日志 + cluster-uuid header |
| `perform_routing` in `http.rs:2680` | 大型 match 路由分发 | 手写模式匹配，非 axum 宏 |
| `authenticate_request` in `http.rs:1338` | 提取+验证 token | Authorization header 或 v1 `p` 参数 |
| `authorize_admin` in `http.rs:2097` | Admin 权限检查 | AccessRequest::Admin |
| `make_flight_server` in `grpc.rs:9` | gRPC 薄包装层 | 委托给 service_grpc_flight 复用 IOx 实现 |

</details>

## 核心实现

### UnifiedService 同端口复用

`unified_service/service.rs:18` 的 `UnifiedService<S>` 在 `call()` 中先 `is_grpc_request()` 判断：是则委托 `grpc_service.call(req)`（FlightService），否则收集 body 后 `route_request(http_api, ...)`。`service.rs:122` 注释明确说明没有用额外 tower service 做 HTTP/2 multiplex，而是直接在 `call()` 路由——简化部署，单端口共享 TLS 与 trace layer。HTTP 与 gRPC 共享 `query_executor`（`Arc::clone`）和 `authorizer`，确保协议无关的一致性。

### 手写路由 perform_routing

`http.rs:2680` 用 `match (method, path)` 大型模式匹配分发，而非 axum/actix 的声明式路由宏。每个 arm 直接调用 `http_server.xxx_handler(req).await`。路径常量集中在 `all_paths.rs`。`RoutingError`（`http.rs:96`）是 sum type，统一多种错误来源（`Error`/`V2WriteApiError`/`WriteParseError`/`AuthenticationError`），各自实现 `IntoResponse` 生成不同 HTTP 响应格式。

### 认证与授权分离

认证（Authentication）在 `perform_routing` 入口处统一执行（`http.rs:2718`）——`authenticate_request` 提取 `Authorization` header（或 v1 `p` 参数），`authorizer.authenticate(token)` 返回 `TokenId` 注入 extensions。授权（Authorization）按需在各 handler 延迟执行——admin 端点调 `authorize_admin`（`http.rs:2097`），query/write 端点的数据库级权限由 query_executor 内部处理。`paths_without_authz` 允许 health/ping 等跳过认证。原始 `Authorization` header 验证后移除并包装为 `AuthorizationHeaderExtension`（防日志泄露），供 write path 下游 IOx 级权限检查使用。

### TraceLayer 中间件接入

`lib.rs:517-521` 的 `tower::ServiceBuilder` 叠加三层：`RemoteAddrLayer`（注入 remote_addr 到 extensions）、`http_trace_layer`（`ServiceProtocol::Http`）、`grpc_trace_layer`（`ServiceProtocol::Grpc`）。两个 TraceLayer 同时挂载，每请求只触发匹配协议的那层完整逻辑（metric family 不同：`HttpServer` vs `GrpcServer`）。`TraceHeaderParser` 从请求头提取 `traceparent`/`b3` 建立/延续分布式追踪。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Tower 中间件栈 | `lib.rs:517-521` | ServiceBuilder 组合 TraceLayer/Metrics |
| 统一服务外观 | `UnifiedService` `service.rs:18` | 单端口 HTTP/gRPC，避免多 listener |
| 手写路由 | `perform_routing` `http.rs:2680` | 精确控制，不受 axum 宏限制 |
| 依赖注入 | `HttpApi::new` `http.rs:1024` | 构造时注入所有依赖 |
| RAII 关闭 | `ShutdownTrigger` `http.rs:2894` | Drop 触发 token cancel，关闭恢复端点 |

## 模块间交互

`HttpApi` 持有的依赖：`write_buffer: Arc<dyn WriteBuffer>`（写入）、`query_executor: Arc<dyn QueryExecutor>`（查询）、`processing_engine: Arc<ProcessingEngineManagerImpl>`（插件）、`authorizer: Arc<dyn AuthProvider>`（认证）、catalog/time_provider 通过 `CommonServerState`。gRPC 侧通过 `make_flight_server` 把 `query_executor` upcast 为 `QueryDatabase` 传给 `FlightService`。与 `influxdb3_authz` 通过 `AuthProvider` trait 交互；与 `core/authz` 通过 `upcast()` 桥接（`V1HttpHandler` 依赖 IOx 层 `Authorizer` trait）。

## 扩展方式

- **新增 HTTP 端点**：`all_paths.rs` 加路径常量；`http.rs` 的 `impl HttpApi` 加 handler；`perform_routing` match 加 arm；请求/响应类型加到 `influxdb3_types`。
- **新增 gRPC 方法**：修改 `core/service_grpc_flight/src/lib.rs` 的 `FlightService` 对应方法实现（如 `list_flights` 当前未实现）；可能需在 `planner.rs` 加 plan 方法。`grpc.rs` 委托层无需改。
- **新增中间件**：`unified_service/` 下新建 layer 实现 `tower::Layer`/`Service`；`lib.rs:517` ServiceBuilder 链插入。
