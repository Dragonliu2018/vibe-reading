---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "客户端协议与驱动"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "wire protocol", "JDBC", "spooling"]
description: "Trino 483 客户端协议：queued/executing 双端点、nextUri 轮询、JSON 编码与 spooling 大结果"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

Trino 的 wire protocol 是一套**纯 HTTP 请求/响应 + 轮询**的协议：POST 提交 SQL 拿 nextUri，客户端循环 GET nextUri 拉增量结果，token 化 URL 天然幂等。这个模块覆盖协议两端——服务端的两个 statement 端点与 `Query` 结果管理器，客户端的 `StatementClientV1` 状态机，以及 JDBC/CLI 对 client 库的包装。

483 的实际拆分（与常见旧认知不同）：`/v1/statement` 的 POST 与排队端点在 **`io.trino.dispatcher.QueuedStatementResource`**；`/v1/statement/executing` 的增量数据端点在 **`io.trino.server.protocol.ExecutingStatementResource`**。trino-client 是纯 Java 协议库（OkHttp），JDBC 和 CLI 都是它的壳。

## 模块架构

服务端：两个端点 + `Query`（810 行，@ThreadSafe 的执行期查询对象）+ `JsonEncodingUtils`（类型化 JSON 编码）+ `spooling/`（大结果落对象存储）。客户端：`StatementClientV1`（4 态状态机）+ `ClientSession`（不可变会话镜像）。层叠：CLI/JDBC → trino-client → HTTP。

## 调用链路

```
1. POST /v1/statement（postStatement in dispatcher/QueuedStatementResource.java:169）
   ├─ registerQuery：HttpRequestSessionContextFactory.createSessionContext
   │   解析 X-Trino-User/Source/Catalog/Schema/Session/Role/
   │        Prepared-Statement/Transaction-Id/Client-Capabilities/
   │        Query-Data-Encoding 头（ProtocolHeaders 生成；遗留 X-Presto- 头
   │        冲突抛 ProtocolDetectionException）
   └─ 同步返回首个 QueryResults：只有 id/infoUri/nextUri=
       /v1/statement/queued/{queryId}/{slug}/{token}（无数据）

2. queued 长轮询（getStatus → Query.waitForDispatched）
   ├─ submitIfNeeded CAS 提交 dispatchManager.createQuery(...)
   └─ FluentFuture.withTimeout(MAX_WAIT_TIME=1s) 等 dispatch：
       未派发 → 仍是 queued nextUri（客户端立刻再 GET）
       已派发 → nextUri 重定向为 /v1/statement/executing/{queryId}/{slug(0)}/0
                （指向实际持有该查询的 coordinator——多 coordinator 路由）

3. executing 轮询（getQueryResults → Query.waitForResults(token, uri, 1s)）
   ├─ JAX-RS @Suspended AsyncResponse + bindAsyncResponse
   ├─ getCachedResult：token 幂等（重复请求回放缓存并 recordHeartbeat；
   │   旧 token → GoneException）
   ├─ removePagesFromExchange (:577)：从 query-results exchange
   │   （LazyExchangeDataSource）按 estimateJsonSize 拉到 ~1MB
   ├─ queryDataProducer.produce（JsonBytesQueryDataProducer：
   │   TypeEncoder 逐列编码为 JsonBytesQueryData）
   └─ toResponse：session 变化映射为 X-Trino-Set-Catalog/Set-Session/
       Clear-Session/Set-Role/Added-Prepare/Started-Transaction-Id 响应头，
       nextUri 指向 token+1

4. 客户端驱动（StatementClientV1.advance()）
   ├─ GET nextUri（executeRequest：瞬时网络异常线性退避 attempts×100ms；
   │   5xx 按 HttpStatusCodes.shouldRetry；超 requestTimeoutNanos → CLIENT_ERROR）
   ├─ processResponse：响应头回放本地 session 镜像
   ├─ HEAD nextUri（heartbeat，迭代行时触发——防慢消费被判超时）
   └─ 服务端终态且无缓冲数据 → nextUri=null → FINISHED
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `postStatement` in QueuedStatementResource.java:169 | 提交入口 | 立即返回，不阻塞于 dispatch |
| `waitForResults` in Query.java:314 | 长轮询等增量 | 1s 超时上限，token 幂等 |
| `removePagesFromExchange` in Query.java:577 | 从 exchange 拉页到 ~1MB | TARGET_RESULT_SIZE=1MB |
| `advance` in StatementClientV1.java | 客户端主循环 | null nextUri = FINISHED |
| `close` in StatementClientV1.java | 取消 | CAS→CLIENT_ABORTED + DELETE nextUri |

</details>

## 核心实现

### Query：token 游标即状态

```java title="server/protocol/Query.java（节选）"
class Query {
    static final DataSize TARGET_RESULT_SIZE = 1MB;  // 每次响应的目标数据量
    // 状态镜像：columns/types、nextToken、lastResult/lastToken（缓存+去重）、
    //           setCatalog/setSessionProperties/startedTransactionId…（响应头素材）
    ListenableFuture<QueryResultsResponse> waitForResults(long token,
            ExternalUriInfo uriInfo, Duration wait);
}
```

**URL 即无状态凭据**：`slug`（防伪随机序列）+ `token`（单调序列）编码进 nextUri，重复请求幂等回放、断线重连从当前 token 续传、心跳即 HEAD 同一个 URL——服务端无需会话粘性，任意 LB/代理/认证网关可无状态水平扩展。

### JSON 编码：TypeEncoder 分派

`JsonEncodingUtils.createTypeEncoder` 用 sealed interface `TypeEncoder` 按 `Type` 模式分派（BigintEncoder/CharEncoder/ArrayEncoder 递归组合…兜底 `TypeObjectValueEncoder` 走 `getObject`）；`writePagesToJsonGenerator` 把 `List<Page>` 流式写成 `[[v,…],…]`，null→`writeNull`、varbinary→Base64。客户端镜像：`JsonDecodingUtils` 按 `signature.getRawType()` switch 50+ 类型转 Java 对象，`JsonIterators.forJsonParser` 惰性流解析避免大响应整体驻留。

### spooling：大结果集的逃生通道

客户端连接属性 `encoding` → 请求头 `X-Trino-Query-Data-Encoding` → `QueryDataProducerFactory.create` 换用 `SpoolingQueryDataProducer`。链路：worker 侧 `OutputSpoolingOperatorFactory` 把输出段写 SPI `SpoolingManager`（对象存储），以 `SpooledMetadataBlock` page 经 exchange 到 coordinator；`SpoolingQueryDataProducer.produce` 转成 `EncodedQueryData{segments:[downloadUri/ackUri/attributes/inline]}`（初始小段经 `spooling_inlining_enabled` 内联）；`SpoolingManagerBridge` 用共享密钥 AES 加密 segment identifier 进 URI；`SegmentRetrievalMode` 决定 STORAGE（预签名直连）/COORDINATOR_PROXY/WORKER_PROXY。客户端 `SegmentsIterator`+`OkHttpSegmentLoader` 拉段，`QueryDataDecoders`（json/lz4/zstd）解码。**动机：大结果集绕开 coordinator——数据 worker→存储→客户端直拉，coordinator 只发 metadata，内存与网络双解放**。

### JDBC：session 状态存客户端

`TrinoConnection.startQuery`→`buildSession`→StatementClient；行迭代 `TrinoResultSet.create`→`getColumns` 循环 advance→`AsyncResultIterator` 后台线程消费 `client.currentRows()`（JDBC `next()` 不阻塞网络）。**session 变化逐请求重放**：`connection.updateSession(client)` 把 `getSetSessionProperties/getSetCatalog/getStartedTransactionId` 回写 Connection 字段，下次 buildSession 带上；事务即 `transactionId` 经 `X-Trino-Transaction-Id` 往返（"NONE" 表示无）。连接属性统一定义在 trino-client `uri/ConnectionProperties.java`——JDBC URL 属性与 CLI 选项共享一套注册表。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 异步资源模型 | JAX-RS AsyncResponse + Guava ListenableFuture | 1s 长轮询不占容器线程 |
| 状态机 | 客户端 4 态（RUNNING/CLIENT_ERROR/CLIENT_ABORTED/FINISHED）+ CAS | close/advance 并发安全 |
| 分层 | CLI/JDBC → trino-client → HTTP | 协议逻辑只写一份 |
| 策略 | QueryDataProducer（direct JSON vs spooling） | 大结果走完全不同的通路 |

## 模块间交互

- **服务端 Query 依赖**：DispatchManager（排队派发）、QueryManager（注册表）、LazyExchangeDataSource（消费根 stage 输出——上游是 `QueryOutputTaskLifecycleListener` 把 `{taskSelf}/results/0` 塞进 `queryStateMachine.updateInputsForQueryResults`）；
- **线程池**：queued 用 `DispatchExecutor`、executing 用 `@ForStatementResource`（"statement-response-%s" 结果编码 + "statement-timeout-%s"）——**两个独立线程池**，互相拥塞不影响；
- **排队清理**：内嵌 `QueryManager.syncWith`（200ms 周期）按 submission 超时清理排队对象；
- **取消**：`close()`→DELETE nextUri→`Query.cancel`→`queryManager.cancelQuery`；叶子 stage 单独取消走 partialCancelUri（`findCancelableLeafStage`）。

## 设计决策：为什么是轮询而不是 websocket

纯请求/响应语义对 LB、代理、认证网关零要求；单请求 ≤1s，故障隔离好；token 化 URL 让续传/重试/心跳天然幂等。代价是协议开销与 ~1s 粒度的延迟上限——对分析查询（秒到分钟级）完全可接受。queued 端点独立的意义：提交+排队走 dispatcher 专用线程池，executing 拥塞（重查询拉数据）时新提交不受影响；且 dispatch 后 302 式 nextUri 重定向实现多 coordinator 路由。JSON（可关 gzip，`compressionDisabled`→`Accept-Encoding: identity`）的取向是调试友好（curl 直读）与生态接入低成本，性能缺口用 spooling 补。

## 扩展方式

**新增 X-Trino-\* 协议头**（两端四处）：`ProtocolHeaders.Headers` 枚举+访问器 → 请求侧 `StatementClientV1.buildQueryRequest`/`processResponse` → 服务端 `HttpRequestSessionContextFactory`（入）+ `QueryResultsResponse` 字段与 `ExecutingStatementResource.toResponse`（出）；若属 session 状态，再加 `TrinoConnection.buildSession/updateSession` 两端。

**新增类型解码**：server `JsonEncodingUtils.createTypeEncoder` 加 encoder + client `JsonDecodingUtils` 加 case；需协商的按 `ClientCapabilities`（NUMBER/VARIANT 模式：旧客户端降级为 varchar/json）。

**JDBC 加 Connection 属性**：`trino-client/.../uri/ConnectionProperties.java` 注册 ConnectionProperty（自动获得 URL/Properties 两种来源，CLI 共享）→ `TrinoConnection.buildSession` 映射进 ClientSession。
