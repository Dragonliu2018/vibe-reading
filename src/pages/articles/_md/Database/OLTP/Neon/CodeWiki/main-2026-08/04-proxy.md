---
source:
  type: "源码解读"
  project: "neon"
  url: "https://github.com/neondatabase/neon"
title: "Proxy"
date: "2026-10-02T15:00:33+08:00"
category: [Database, OLTP, Neon, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["Neon", "Proxy", "认证", "SCRAM", "WebSocket"]
description: "Neon 接入网关：TLS SNI 路由、console 委托认证、websocket 帧适配复用 TCP 状态机、跨实例取消与限流"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

Proxy 是用户流量进 Neon 的唯一门厅：TLS SNI 分流、认证、路由到正确的 compute、双向字节转发、连接取消、限流与计量。设计约束是**无状态可横向扩缩**——认证真源（SCRAM verifier、IP allowlist）全部在 console（云端控制面），proxy 只缓存与执行；多实例部署时靠 Redis 同步 cancel key 与缓存失效。serverless 形态决定了它不止转发 TCP：websocket（Neon serverless driver）、SQL-over-HTTP、PostgREST 式 REST（subzero）三种边缘入口都要支持。

31k 行 Rust（`proxy/src`）+ 8.9k 行 fork crate（`libs/proxy/`）。默认监听 4432（psql）、7000（mgmt）、7001（http）。

## 模块架构

单进程多角色由 `ClientMode` 与入口分派：`pglb/` 是 TCP 直通主路径，`serverless/` 的 `WebSocketRw` 把 ws 帧适配成字节流后**调用同一个 `handle_connection` 状态机**——TCP/wss/HTTP 三入口共享 TLS、认证、路由、取消、计量全部逻辑，这是本模块最值得学习的复用设计。`auth/` + `scram/` 是认证执行层（交换细节），`control_plane/` 是 console 客户端（决策），`cache/` 双层缓存（project info + node info），`rate_limiter/` 两种桶（固定窗口 / 漏桶），`cancellation.rs` 是跨实例取消，`intern.rs` 字符串驻留把热点键变成 4 字节 Copy。fork 的 `tokio-postgres2` 等三个 crate 解决"代理需要独占协议控制权"（`libs/proxy/README.md`："Proxy needs unique access to the protocol"）。

## 调用链路

```
TCP 直通（psql via TLS）：
pglb/mod.rs::task_main accept
  → protocol2.rs::read_proxy_protocol（PROXY v2 提取真实 IP）
  → pglb/handshake.rs::handshake 状态机
      SslRequest → accept_tls（rustls，SNI 提取 endpoint）
      StartupMessage → HandleshakeData::Startup
  → proxy/mod.rs::handle_client
      ComputeUserInfoMaybeEndpoint::parse（user + SNI/project 一致性校验）
  → authenticate（auth/flow.rs::AuthFlow + auth/backend/classic.rs）
      scram/exchange.rs SCRAM 交换；scram/threadpool.rs 4 线程扛 PBKDF2
  → proxy/wake_compute.rs（ApiLocks 防同 endpoint 惊群）→ console wake_compute
  → compute/mod.rs::AuthInfo::authenticate
      （用派生的 ScramKeys 登录 compute，不碰明文口令）
  → forward_compute_params_to_client
      （BackendKeyData 替换为 proxy 自己的随机 CancelKeyData）
  → pglb/passthrough.rs::proxy_pass（MeasuredStream 计费 + 纯字节转发）

wss（serverless）：serverless/websocket.rs::serve_websocket
  → WebSocketRw（帧→字节流适配）→ 同一个 pglb::handle_connection
SQL-over-HTTP：serverless/sql_over_http.rs::handle（连接池复用 + CancelSet 超时掐杀）
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `handshake` (`pglb/handshake.rs`) | TLS/协议协商状态机 | 返回 Startup 或 Cancel 二分支 |
| `authenticate` (`auth/backend/classic.rs`) | SCRAM 执行 | mock() 防用户枚举（对齐 PG） |
| `wake_compute` (`proxy/wake_compute.rs`) | 唤醒 serverless compute | 指数退避 + 缓存失效重试一次 |
| `cancel_session` (`cancellation.rs`) | 取消正在执行的查询 | IP 子网限流 + 访问控制复查 |
| `handle` (`serverless/sql_over_http.rs`) | HTTP 执行 SQL | 池复用，超阈值随机掐连接 |
| `parse` (`serverless/rest.rs` + subzero) | REST 请求 → SQL | 权限条件内联进生成的 SQL |

</details>

## 核心实现

### 认证：执行与决策分离

proxy 完成 SCRAM 交换后拿到的是 `ScramKey`（32 字节，Drop 时 zeroize、`ct_eq` 常时比较）派生的 client_key/server_key——**用它代表用户登录 compute**，全程不接触明文口令（`libs/proxy/tokio-postgres2/src/config.rs::AuthKeys`）。决策全在 console：role verifier、endpoint 访问控制、IP allowlist 一次取回（`get_and_cache_auth_info`），密码变更经 Redis pubsub（`neondb-proxy-ws-updates` channel）按 project/org/endpoint 粒度失效 `ProjectInfoCache`（moka 双 Cache + 反向索引批量定位）。`ServerSecret::mock()` 对不存在的用户伪造 doomed secret，防枚举攻击——细节对齐 PG 的 `mock_scram_secret`。PBKDF2/HMAC 这类 CPU 工作甩给 4 线程 `ThreadPool`（15s 超时），不占用 async worker。

### 为什么 fork tokio-postgres

三个原版 API 满足不了的需求：① `AuthKeys` 支持现成 SCRAM keys 认证（连接时优先于 password 字段使用）；② `StartupStream::poll_fill_buf_exact` 精确读取——**不过读** startup 之后属于转发流的字节（直通代理必须字节级忠实，多读一个字节就是丢数据）；③ `RawCancelToken::cancel_query_raw` 在任意裸 socket 上发取消包。fork 已完全偏离上游，是"代理需要独占协议控制权"的必然代价。

认证交换本身也有时限保护：`AuthenticationConfig.scram_protocol_timeout`（`auth/backend/classic.rs`）给整个 SCRAM 消息往返设窗口，超时即断开——防止慢速客户端长期占用连接与认证状态。

### 跨实例取消：随机 pid + Redis 表

取消请求可能落到另一台 proxy 实例（多副本 + LB），所以取消信息必须集中。设计相当讲究：**发给客户端的 CancelKeyData 是 proxy 自己生成的随机值**（注释：compute 的 pid 普遍很小，转发真实 pid 会跨 compute 撞 key），真实取消信息（compute 地址 + 真实 pid/secret）序列化为 `CancelClosure` JSON 存 Redis（TTL 60s + 10 分钟轮转 Refresh）。取消执行链：IP 子网限流 → Redis 查 key → `get_endpoint_access_control` 复查权限 → `CancelClosure::try_cancel_query` **直连原 compute** 发取消包。`CancellationProcessor` 把取消键操作合并成 Redis pipeline（batch 8）摊薄 RTT。

### 限流与字符串驻留

`BucketRateLimiter`（`rate_limiter/limiter.rs`）多时间窗固定窗口桶（格式 `"300@1s,200@60s,100@600s"`），每 2048 次访问清一个随机分片做 O(1) 摊销 GC（注释给出 30MB 内存上限）；console 可下发 per-endpoint 漏桶（`LeakyBucketRateLimiter`，64 分片）实现动态限流。`intern.rs::StringInterner`（lasso `ThreadedRodeo`）把 endpoint/role/project/account 驻留成 4 字节 Spur（Copy）——每条连接要查多张 ClashMap/moka 表，键比较与哈希成本压到近零；serde 反序列化直接在 `visit_str` 里 `get_or_intern`，Redis 消息到手即得驻留键。

### subzero：REST 入口的 SQL 生成器

`serverless/rest.rs`（feature `rest_broker`，SNI 前缀 `apirest.`）：JWT claims 取 role → `subzero_core::parser::postgrest::parse` 解析 REST 请求 → `permissions::{replace_select_star, check_safe_functions}` 按 role 改写（权限条件内联进生成的 SQL）→ `formatter::postgresql::generate` 产参数化 SQL → 经 local proxy 执行。它**不作用于 psql 直通流量**——直通是字节转发，proxy 不解析 SQL。仓库内的 `libs/proxy/subzero_core` 只是 stub（46 字节），真实逻辑在独立仓库 neondatabase/subzero。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 类型状态协议机 | `HandshakeData::Startup/Cancel`、`AuthFlow<S, State>` | 状态非法转移编译期不可达 |
| 帧适配器复用状态机 | `WebSocketRw` → `pglb::handle_connection` | 三入口一套逻辑，行为一致性 |
| 错误分类而非 anyhow | `error.rs` `ErrorKind` 九类 | 驱动 Prometheus 标签 + 客户端可见性判定；注释明言 anyhow 易泄漏敏感信息 |
| ArcSwap 无锁热更 | `config.rs` TLS 配置 | 运行时刷新不重启 |
| RAII gauge 守卫 | `metrics.rs` `NumClientConnectionsGuard` | 连接计数的减法不会忘 |

## 模块间交互

对 console（控制面）：`NeonControlPlaneClient`（`cplane_proxy_v1.rs`）四类 API + 304 缓存语义；对 compute：fork 客户端 + `ScramKeys`；对 Redis：cancel key 存储 + console→proxy 失效广播（IRSA/plain 两种认证）；`usage_metrics.rs` 按 endpoint/branch 记录 IO 字节，会话上下文写 Parquet 上传远端（`context/parquet.rs`）。注意 proxy **不直接和 pageserver/safekeeper/storcon 说话**——存储拓扑对它完全透明，只认 compute 地址。

## 扩展方式

- **新增认证方式**：console 协议字段（`control_plane/messages.rs`）→ `auth/backend/classic.rs` 分支 → `AuthInfo` + `AuthKeys` 加 compute 侧凭据变体 → `PoolingBackend::authenticate_with_*` 补 http 路径。
- **新增限流维度**：`intern.rs` 加 Tag → 定义 `BucketRateLimiter<NewKeyInt>`；静态阈值改 `RateBucketInfo::DEFAULT_SET`，动态的走 `EndpointRateLimitConfig`。
- **新增 startup option**：`NeonOptions`（`proxy/mod.rs`）加常量 + `is_ephemeral()` 判定（影响连接池缓存键）+ 必要时进 `to_deep_object` 传 console。

对应测试：`test_runner/regress/test_proxy*`、`test_auth.py`、`pg_clients/`（9 种语言驱动连通性）。
