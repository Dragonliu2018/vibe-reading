---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Pgwire 与进程装配"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "PostgreSQL 协议", "tokio"]
description: "Pgwire 与进程装配解读：PG 协议状态机、单二进制 multicall、standalone 独立 runtime、compute 组合根与两阶段上线"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

两个关注点合成一篇：**pgwire**（src/utils/pgwire，~10k 行）是零 RisingWave 语义的 PostgreSQL 协议库——`Session`/`SessionManager` trait 是它与数据库内核的唯一边界，可完整 mock 测试；**进程装配**（src/cmd_all + src/compute）是把 crate 世界变成可运行进程的组合根——单二进制多模式分发与 compute 节点装配。

## 模块架构

```text
src/utils/pgwire/src/
├── pg_protocol.rs   # PgProtocol<S, SM>：每连接的协议状态机
├── pg_server.rs     # SessionManager/Session trait + pg_serve（acceptor/worker 分离）
├── pg_extended.rs   # 扩展协议（ResultCache 分页）
└── pg_message.rs / net.rs / ldap_auth.rs / memory_manager.rs
src/cmd_all/src/
├── bin/risingwave.rs  # Component 枚举 + parse_args（multicall + 子命令）
├── standalone.rs      # 多组件单进程（每组件独立 runtime）
└── single_node.rs     # 用户态单机（高层选项 → standalone 选项的映射层）
src/compute/src/
└── server.rs          # compute_node_serve：~450 行纯装配函数
```

pgwire 的核心trait 注释明说设计动机（pg_server.rs:47-48）："The interface for a database system behind pgwire protocol. We can mock it for testing purpose"。

## 调用链路

启动分发：

```text
main()                                       cmd_all/src/bin/risingwave.rs:217
 └ parse_args()                              :172（clap multicall + 子命令）
    ├ "./meta-node ..."                      multicall：argv[0] 即组件名（docker symlink）
    └ "./risingwave" 裸跑 → SingleNode（默认子命令）
 └ Component::start()
    └ standalone()                           cmd_all/src/standalone.rs:241
       ├ meta → compute → frontend → compactor 顺序 Service::spawn
       │   每组件独立 multi-thread runtime，线程名 rw-standalone-{name}
       ├ 自旋等 meta is_server_started()     :261
       └ 关停逆序                            :384
```

一条 SQL 的协议流程：

```text
pg_serve（单线程 rw-acceptor runtime 只 accept，连接 spawn 到 worker runtime） pg_server.rs:369
 └ PgProtocol::run → process_startup_msg      pg_protocol.rs:728
    └ session_mgr.connect(db, user)（进入 frontend SessionManagerImpl）:752
    └ AuthenticationOk + BackendKeyData + ParameterStatus → Regular 态
简单协议（Query 'Q'）：
 └ process_query_msg → inner_process_query_msg  :838/:849
    └ Parser::parse_sql（parse 发生在 pgwire 层）→ 逐条
       session.run_one_query(stmt, Format::Text)
    └ RowDescription → 流式逐行 write_streaming(DataRow) → CommandComplete
扩展协议（Parse/Bind/Describe/Execute/Sync）：
 └ process_parse_msg → session.parse() → prepare_statement_store     :1003
 └ process_bind_msg → session.bind() → portal_store                  :1084
 └ process_execute_msg → session.execute(portal) → ResultCache::consume(row_max 分页)  :1139
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `parse_args` in risingwave.rs:172 | 模式分发 | multicall + 默认子命令 |
| `standalone` in standalone.rs:241 | 多组件装配 | 每组件独立 runtime |
| `PgProtocol::run` in pg_protocol.rs:296 | 协议主循环 | 三态状态机 |
| `process_startup_msg` in pg_protocol.rs:728 | 认证握手 | 5 种 authenticator |
| `process_execute_msg` in pg_protocol.rs:1139 | 扩展协议执行 | ResultCache 分页 |
| `compute_node_serve` in compute/server.rs:93 | CN 装配 | 6 gRPC + 两阶段上线 |

</details>

## 核心实现

### PgProtocol：Future 洋葱包装与错误分级

`do_process`（pg_protocol.rs:400-499）把 `do_process_inner` 逐层包进 `CURRENT_SESSION.scope` → `rw_catch_unwind` → 慢查询周期重报 → 查询日志 → tracing span——**横切关注点全部协议层统一收口**。错误细颗粒分级：IoError/StartupError 断连；SimpleQueryError 回 ErrorResponse 继续会话；**Panic 强制断连**（"Catching the panic may leave the session in an inconsistent state"，:555）。

### 为什么手写 pgwire

Rust 生态当时无可用的 PG 服务端协议库（tokio-postgres 是客户端；此为生态背景推断，仓库内无书面注释），且需要深度定制：`MessageMemoryManager` 单条/总查询字节节流返回合成 ServerThrottle（:677-687）、慢查询周期性重报、panic 断连、SQL 关键字脱敏。`PgProtocol<S, SM>` 双泛型注入字节流与 SessionManager，测试里换 `MockSessionManager` 全链路自测（pg_server.rs:467）。

### 单二进制多模式（multicall）

一份产物覆盖 docker 镜像、risedev 开发、playground 三种形态。`Component::aliases()`（:131）兼容 `compute-node/compute_node` 历史命名。**standalone vs single_node 分层**：前者给云（暴露低层选项，CLI hide），后者给用户（默认子命令，`~/.risingwave` 目录 + SQLite meta + 内存 hummock + 按 16GB 阶梯切分内存；in-memory 模式不启动独立 compactor，由 compute 的 embedded compactor 代劳，server.rs:589）。

### standalone 每组件独立 tokio runtime

`Service::spawn` 注释（standalone.rs:192-196）："By using a separate runtime, we get better isolation... logs can be distinguished by thread name; each service can be shutdown cleanly"。同进程模拟分布式部署时避免组件间 runtime 资源串扰，优雅关停可逐组件收口。

### compute 组合根与两阶段上线

`compute_node_serve`（server.rs:93）是 ~450 行纯装配函数，无全局单例：metrics → StateStoreImpl（可带 embedded compactor）→ Batch/StreamEnvironment（**同一 StateStore Arc 共享**）→ LocalStreamManager → 6 个 gRPC service（Task/BatchExchange/StreamExchange/Stream/Monitor/Config/Health）→ `meta_client.activate()`。两阶段上线：先 `register_new` 后 `activate`——注册未激活期间不被调度，避免半初始化节点接活。

### 扩展协议的 ResultCache 分页

`row_max`（Execute 消息的 max_rows）驱动 `ResultCache::consume`（pg_extended.rs:55）——JDBC cursor 模式下每次 Execute 只取 N 行，未取完的 result 放回 cache 待下次继续；`ignore_util_sync` 实现协议要求的"扩展协议出错后丢弃消息直到 Sync"。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 组合根 | `compute_node_serve` in compute/server.rs:93 | 显式装配无全局单例 |
| 策略+泛型注入 | `PgProtocol<S, SM>` in pg_protocol.rs:72 | TCP/Unix/SSL 通吃 + mock |
| Future 洋葱包装 | `do_process` in pg_protocol.rs:400 | 横切关注点收口 |
| Opts 映射层 | `map_single_node_opts_to_standalone_opts` in single_node.rs:124 | 高层→低层配置翻译（含单测） |
| acceptor/worker 分离 | `pg_serve` in pg_server.rs:379 | 慢查询不阻塞新连接 |

## 模块间交互

pgwire ↔ frontend：`SessionManagerImpl`（frontend/session.rs:1553）实现 trait 并在 `frontend/lib.rs:259` 调 `pg_serve` 挂上 4566 端口；`SESSION_MANAGER` OnceLock 让 auto schema change 回调能拿到 dummy session。cmd_all ↔ 各节点 crate：各 `start(opts, shutdown)` 返回 `Pin<Box<dyn Future>>`（注释警示不能改成 async fn，会拖慢 release 编译）。

## 扩展方式

**新增一种启动模式**：`Component` 枚举加变体 + `aliases()`/`augment_args()`/`start()` 三处 match → 复用 standalone 骨架则改 `map_single_node_opts_to_standalone_opts`（产出 ParsedStandaloneOpts，不需要的组件置 None 即自动跳过）→ 补 parse_args 单测。

**新增 pgwire 认证方式（如 SCRAM-SHA-256）**：`UserAuthenticator` 枚举加变体（pg_server.rs）→ `process_startup_msg`（:770-805）match 新分支发对应 Authentication 消息 → frontend `connect_inner` 构造新 authenticator。

**给 compute 加新 gRPC 服务**：`compute/src/rpc/service/` 新建 xxx_service.rs（参照 config_service.rs 最小模板）→ `compute_node_serve` 构造 + `.add_service(...)`（:470-512 区块），需 await-tree 诊断则套 `AwaitTreeMiddlewareLayer`。
