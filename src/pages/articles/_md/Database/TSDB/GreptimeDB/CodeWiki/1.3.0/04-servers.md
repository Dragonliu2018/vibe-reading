---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "servers 协议接入层"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "MySQL", "PostgreSQL", "gRPC", "OTLP", "Prometheus"]
description: "servers——十种协议的统一接入层：Server/QueryHandler trait 抽象、Builder 组装、协议 codec 归一为 Instance 执行。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`servers`（`src/servers/`，~6 万行）是 GreptimeDB 的多协议服务器层，提供 MySQL/PostgreSQL/gRPC/OpenTelemetry(OTLP)/Prometheus remote write+read/HTTP/OpenTSDB/Elasticsearch/InfluxDB/Loki 十种协议的接入与查询入口。它是一个"协议归一层"：用 `Server` trait 统一生命周期、用 `*Handler` trait 族统一执行入口、用 `Output` 统一返回值，把各协议的 codec 与 context 构造收敛在自己内部，**执行权全部上交给 `frontend::Instance`**。组装规则集中在 `frontend/src/server.rs::Services`。

## 模块架构

`Server` trait（`server.rs:41-150`）+ `ServerHandlers`（状态机式管理 server 生命周期）是骨架。执行入口是 `QueryHandler` trait 族（`query_handler/`）：`SqlQueryHandler`（`query_handler/sql.rs:18`）、`GrpcQueryHandler`、`PromStoreHandler`、`OtlpHandler` 等，统一返回 `Output`。`Output` 是统一返回值（AffectedRows/Stream/RecordBatches）。

各协议实现：`mysql/`（`MysqlInstanceShim`，基于 `mio-mysql` 协议库）、`postgres/`（`MakePostgresServerHandler`，基于 `pgwire`）、`grpc/`（gRPC services：database/flight/region_server/otel_arrow/prom_query_gateway）、`http/`（HTTP + Dashboard + Jaeger + Script）、`otlp.rs`、`prom_remote_write/` + `prom_store.rs`、`elasticsearch.rs`、`opentsdb.rs`、`influxdb.rs`。

## 调用链路

**MySQL SQL 请求**（`mysql/handler.rs`）：

```
MysqlInstanceShim::on_query(query)                  servers/src/mysql/handler.rs:518
  → do_query(query, query_ctx)                       handler.rs:131
     → SqlQueryHandler::do_query(query, query_ctx)   query_handler/sql.rs:34
        （trait 在 servers 侧定义，impl 在 frontend::Instance）
        → Instance::do_query → do_query_inner       frontend/src/instance.rs:1198
           → parse_stmt → query_statement           instance.rs:282
              → exec_statement（Insert 走 operator，Query 走 query）
```

**OTLP 写入**（`otlp.rs`）：

```
http::otlp::metrics → handler.metrics               servers/src/otlp.rs
  → otlp::metrics::to_grpc_insert_requests          otlp/metrics.rs:118
     （把 OTLP proto 转 RowInsertRequests）
  → handle_row_inserts                               交给 frontend Inserter
```

**Prometheus remote_write**（`prom_store.rs`）：

```
http::prom_store::remote_write                      servers/src/prom_store.rs:455
  → decode_remote_write_request                      prom_remote_write/decode.rs:196
  → write_prometheus_rows_with_progress              
  → prom_store_handler.write_prepared               prom_remote_write/mod.rs:43
```

## 核心实现

### 统一 QueryHandler trait

`SqlQueryHandler::do_query`（`query_handler/sql.rs:34`）只接 `&str` + `QueryContextRef`，返回 `Vec<Result<Output>>`。各协议 handler 把自己的请求格式转成这层抽象，复用同一执行入口。MySQL 用 `SqlPlan` 三分支 prepared cache（`mysql/handler.rs:212-336`），PG 用 `transform_placeholders`（`postgres/helper.rs`）做占位符适配。

### Builder 组装

`HttpServerBuilder`（`http.rs:616-783`）、`GrpcServerBuilder`（`grpc/builder.rs:60-161`）、`MakePostgresServerHandler`（`postgres.rs:144`）+ `MysqlServer::create_server`/`PostgresServer::new` 按 options 条件装配，最终塞进 `ServerHandlers` 由 `start_all` 统一拉起。`frontend/src/server.rs::Services::build` 是唯一组装点。

### 方言适配

`GreptimeDbDialect`（见 [07-sql](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/07-sql)）同时支持 MySQL 反引号 `` ` `` 和 PG 双引号 `"`；MySQL handler 用 `SqlPlan` prepared cache 区分三分支；PG handler 做 `$1` 占位符到 `?` 的转换。`is_valid_schema` 放在 trait 而非 server（`query_handler/sql.rs:43`）。

### 多协议归一为写入

OTLP（metrics/logs/trace）、Prom remote_write、InfluxDB line protocol、OpenTSDB、ES `_bulk` 各自把数据格式转成 `RowInsertRequests`（`MultiTableData` + `row_writer`），交给 frontend `Inserter` 走统一写入主干——协议层只做 codec，不重复实现分区逻辑。

### gRPC 独立 runtime

gRPC handler 用独立 tokio runtime（`grpc/greptime_handler.rs:96-104`）避免 cancellation token 传播取消信号，保护长查询。

### ServerMemoryLimiter

跨协议共享内存限制器（`grpc/builder.rs:38-48`、`frontend/src/server.rs:71-76`），防止单协议爆内存。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Builder | `HttpServerBuilder`/`GrpcServerBuilder`（`http.rs:616`、`grpc/builder.rs:60`） | 链式条件装配 server |
| 适配器/门面 | `*Handler` trait 族 + `Output`（`query_handler/`） | 十种协议归一为统一执行入口 |
| 策略 | 各协议 handler 实现 `QueryHandler` | 不同协议不同 codec |
| Interceptor | `interceptor.rs:23`、`frontend/src/instance/otlp.rs:88` | 钩子在执行前后注入逻辑 |
| Template Method | gRPC `add_service!` 宏切面注入（`grpc/builder.rs:29-54`） | 统一 gRPC service 注册切面 |
| Object Pool | `prom_remote_write/mod.rs:43` 对象复用 | 减少 decode 缓冲分配 |

## 模块间交互

依赖 `frontend`（`Instance` 实现 `QueryHandler`）、`query`、`common_grpc`、`api`（proto）、`common_recordbatch`。被 `cmd`（standalone/datanode/frontend 启动时通过 `Services::build` 组装 server）。server 只做协议 codec 与 context 构造，执行权交给 `Instance`——**server 不感知底层引擎**。

## 扩展方式

- **新增接入协议**：新建协议文件实现 codec + handler trait，在 `frontend/src/server.rs::Services::build` 注入一处。既有协议无需改动——trait 边界把改动面限制在"新文件 + 一处注入"。
- **新增 HTTP API**：在 `http.rs:639-820` 的 nest 命名空间加路由 + handler。
