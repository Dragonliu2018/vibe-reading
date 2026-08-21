---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "Flight RPC"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "Flight", "gRPC"]
description: "Arrow Flight RPC——gRPC streaming 数据传输、PATH/CMD 双 descriptor、中间件链与传输层抽象、FlightPayload 与 protobuf 零拷贝对齐"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

`cpp/src/arrow/flight/`（~65k 行）实现 Arrow Flight RPC 协议——基于 Arrow IPC + gRPC 的数据传输机制。它让服务端把 Arrow 数据流式推给客户端（`DoGet`），或客户端推数据给服务端（`DoPut`），甚至双向交换（`DoExchange`）。核心定位：**传输语义独立于数据语义**——Flight 不关心数据是什么，只负责高效搬运 RecordBatch；且**gRPC 只是默认传输**，通过传输层抽象可替换为共享内存/RDMA。它是分布式查询引擎跨节点传 Arrow 数据的标准协议。

## 模块架构

```
┌──────────── 用户层 ────────────┐
│ FlightServerBase (server.h:185)│ 子类 override DoGet/DoPut/...
│ FlightClient (client.h:183)    │ DoGet→FlightStreamReader 等
└────────────┬───────────────────-┘
             │ 委托
┌────────────▼───────────────────┐
│ ServerTransport/ClientTransport │ transport_server.h / transport.h
│  (DoGet/DoPut 适配 用户↔传输)    │
└────────────┬───────────────────-┘
             │ 注册到
┌────────────▼───────────────────┐
│ TransportRegistry (transport.h) │ scheme→factory，默认 gRPC
│  GrpcServerTransport/GrpcClient │ grpc_server.cc / grpc_client.cc
└────────────┬───────────────────-┘
             │ 传输 FlightPayload
┌────────────▼───────────────────┐
│ FlightPayload (types.h:893)     │ descriptor + app_metadata + ipc::IpcPayload
│  RecordBatchStream (server.h:64)│ 适配 RecordBatchReader→FlightPayload 序列
│  reinterpret_cast → pb::FlightData│ 零拷贝（字段布局对齐）
└────────────┬───────────────────-┘
             │ 序列化引擎
┌────────────▼───────────────────┐
│ arrow::ipc (RecordBatchWriter) │ RecordBatch→IpcPayload(metadata+body)
└────────────────────────────────-┘
  横切：Middleware 链 (server_middleware.h)  认证 ServerAuthHandler (server_auth.h)
```

## 调用链路

一次 `DoGet`（client→server 取数据），IPC 承担序列化/反序列化：

```
client: FlightClient::DoGet(opts, ticket)               client.cc:677
  └─ transport_->DoGet → gRPC DoGet RPC
server: GrpcServiceHandler::DoGet(ctx, req, writer)      grpc_server.cc:482
  └─ CheckAuth: auth_handler_->IsValid(token, peer)     验证 per-call token
  └─ MakeCallContext: 遍历 middleware_ → ServerMiddlewareFactory::StartCall
  └─ base_->DoGet(ctx, ticket, &data_stream)            用户 override，返回 RecordBatchStream
  └─ ServerTransport::DoGet (transport_server.cc:298)
       ├─ data_stream->GetSchemaPayload → 先发 schema
       └─ while: payload = data_stream->Next()           RecordBatchStream 用 ipc::RecordBatchWriter
            └─ 若 metadata==nullptr break（流结束）
            └─ stream->WriteData(payload)               写 gRPC stream
client: ClientStreamReader::Next                         client.cc:178
  └─ data->OpenMessage → ipc::Message                   从 metadata+body 开 Message
  └─ ipc::RecordBatchStreamReader::ReadNext → RecordBatch  IPC 反序列化
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `FlightServerBase::DoGet` (`server.h:185`) | 用户实现取数端点 | 默认返回 NotImplemented |
| `FlightClient::DoGet` (`client.cc:677`) | 发起取数 RPC | 返回 FlightStreamReader |
| `RecordBatchStream` (`server.h:64`) | RecordBatchReader→FlightPayload | 内部用 `ipc::RecordBatchWriter` |
| `ServerTransport::DoGet` (`transport_server.cc:298`) | 适配 data_stream→传输 | 逐 payload 写直到流结束 |
| `WritePayload` (`serialization_internal.cc:220`) | FlightPayload→gRPC | `reinterpret_cast` 零拷贝 |
| `ClientStreamReader::Next` (`client.cc:178`) | 取下一个 batch | 用 IPC reader 反序列化 |
| `TransportRegistry` (`transport.h:214`) | scheme→factory | gRPC 在 `InitializeFlightGrpcServer` 注册 |
</details>

## 核心实现

### gRPC streaming 与 PATH/CMD descriptor

`DoGet`/`DoPut`/`DoExchange` 都是 gRPC **streaming** RPC（`Flight.proto:108/118/127`）——返回/接收 `stream FlightData`，而非单次 unary。**为什么 streaming 而非 unary**：数据集可能含大量 RecordBatch，unary 需把所有数据塞进一个 protobuf 消息，内存不可控；streaming 逐 batch 传输，服务端可边生成边发，gRPC 内置 flow control 避免淹没接收方，且 DoExchange 需双向通信。`FlightDescriptor`（`types.h:414`）有两种：**PATH**（`vector<string>`，标识已存在的命名数据集，适合数据仓库按名取数）与 **CMD**（不透明 blob，可编码 SQL/plan，适合按需计算后流式返回结果）。一个协议覆盖"读已物化数据"和"执行查询后流式返回"两类场景。

### 中间件链

`FlightServerOptions.middleware` 是 `vector<pair<string, shared_ptr<ServerMiddlewareFactory>>>`（`server.h:166`），每个 RPC 调用按序执行 `StartCall`（`grpc_server.cc:329`）。**已有实现**：`TracingServerMiddleware`（OpenTelemetry span）、`ServerSessionMiddleware`（cookie 管理 session）。**为什么中间件可插拔**：认证/tracing/session 不应硬编码核心，中间件让用户在不改 `FlightServerBase` 代码下插入横切逻辑。关键设计：**Middleware 是 infallible**（`SendingHeaders`/`CallCompleted` 返回 void，因为 RPC 已开始发数据，报错难处理），但 **Factory 可拒绝**（`StartCall` 返回 Status，此时还没发数据，可安全拒绝，`server_middleware.h:76`）。这分离了"准入控制"与"观察增强"。

### 传输层抽象

`FlightServerBase`（`server.h:185`）不直接依赖 gRPC，而通过 `ServerTransport`（`transport_server.h:57`）间接委托。`Init()`（`server.cc:155`）按 URI scheme 从 `TransportRegistry`（`transport.h:214`）创建传输实现。**为什么抽象传输**：`transport.h:22` 注释明说"实现 ServerTransport/ClientTransport 并注册 scheme 即可"。直接绑死 gRPC 就无法支持替代传输（共享内存/RDMA/UCX 做进程间零拷贝）。附带好处：头文件 `server.h` 不 include gRPC，用户代码不需链接 gRPC 即可继承 `FlightServerBase`，gRPC 依赖全在 `.cc` 的 pimpl 中。

### 零拷贝 FlightPayload↔pb::FlightData

`FlightPayload`（`types.h:893`）含 `descriptor`/`app_metadata`/`ipc_message`。`serialization_internal.cc:220` 用 `reinterpret_cast<const pb::FlightData*>(&payload)` 把它当 protobuf 消息写——因为 `FlightPayload` 与 `pb::FlightData` 的字段布局被刻意对齐，自定义 `SerializationTraits<pb::FlightData>`（`customize_grpc.h`）拦截 gRPC 序列化直接用 buffer 指针写入。**为什么这么做**：protobuf 默认序列化需逐字段拷贝到 message 对象再序列化，对大批量 RecordBatch 是严重开销；布局对齐+拦截让 gRPC 直接引用 FlightPayload 的 buffer，省一次完整 protobuf 序列化拷贝。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Middleware Chain | `ServerMiddlewareFactory`+`ServerMiddleware`（`server_middleware.h`） | 横切逻辑可插拔、有序组合 |
| Strategy（认证） | `ServerAuthHandler`（`server_auth.h:54`），`NoOpAuthHandler` null object | 认证策略可替换 |
| Adapter（多层） | `RecordBatchStream`/`GetDataStream`/`IpcMessageReader`（`server.cc`/`grpc_server.cc`/`client.cc`） | IPC↔gRPC 各层适配 |
| Transport Abstraction | `TransportRegistry`+`ServerTransport`/`ClientTransport`（`transport.h`） | 传输可替换（gRPC/未来 RDMA） |
| Template Method | `FlightServerBase` 虚方法默认 `NotImplemented`（`server.cc:224`） | 子类选填端点 |
| PIMPL | `FlightServerBase::Impl`/`RecordBatchStreamImpl` | gRPC 依赖隔离在 .cc |

## 模块间交互

依赖 **ipc**（`RecordBatchStream` 用 `ipc::RecordBatchWriter` 序列化，client 用 `ipc::RecordBatchStreamReader` 反序列化）、**核心类型**（`RecordBatch`/`Schema`/`Buffer`）、**io**（`StopToken` 支持交互式取消）。被 **dataset/acero** 可用作数据源（远程 Flight dataset）；`arrow/flight/sql` 子模块在其上构建 SQL 查询层。交互方式：gRPC streaming + 函数调用。

## 扩展方式

- **实现 FlightServer 端点**：继承 `FlightServerBase`（`server.h:185`），override `GetFlightInfo`（解析 PATH/CMD 返回 `FlightInfo`）与 `DoGet`（构造 `RecordBatchStream` 包装 `RecordBatchReader`）。`FlightServerOptions opts(Location::ForGrpcTcp(...)); server.Init(opts); server.Serve();`
- **添加认证中间件**：继承 `ServerAuthHandler`（`server_auth.h:54`，`Authenticate`+`IsValid`）做 handshake+token，或继承 `ServerMiddlewareFactory`（`server_middleware.h:60`）做 header-based auth（JWT in `Authorization`），注入 `opts.auth_handler` 或 `opts.middleware`。参考 `NoOpAuthHandler`、`TracingServerMiddleware`。
- **添加客户端 tracing**：实现 `ClientMiddleware`/`ClientMiddlewareFactory`（`client_middleware.h:36/63`），`StartCall` 建 span，`SendingHeaders` 注入 `traceparent`，注入 `FlightClientOptions.middleware`。
