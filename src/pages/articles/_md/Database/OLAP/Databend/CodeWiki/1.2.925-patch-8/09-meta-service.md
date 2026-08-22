---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "元数据服务"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "Raft", "Meta", "KV"]
description: "Databend 元数据服务——KV/CRUD API 分层 + Ident 类型化 Key + Raft 核心（外部独立仓库）。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

元数据服务模块（`src/meta/`，~82.5k 行）管理 Databend 的所有 schema/tenant 元数据。一个关键架构事实是：**Raft 共识核心已被拆分到独立仓库** `github.com/databendlabs/databend-meta`（git 依赖 `v260512.4.0`）。本仓库内的 `src/meta/` 是围绕外部 raft 核心构建的**客户端 API 层 + 数据模型 + 二进制入口 + 管理工具**——不包含 raft 状态机、日志存储等核心逻辑。

## 模块架构

模块分四层职责，自底向上：数据模型（`meta-app`）→ API 抽象（`meta-api`）→ 客户端（`meta-store`）→ 运行时桥接与二进制入口。

```
query (CatalogManager) ─→ MetaStore (meta-store)
                              ↓ impl KVApi
                          meta-api: SchemaApi = DatabaseApi + TableApi + ...
                              ↓ KVPbApi → KVPbCrudApi → NameIdValueApi
                          meta-app: Ident 类型化 Key + 数据模型
                              ↓ gRPC
                          databend-meta (外部仓库): Raft + 状态机 + GrpcServer
```

## 调用链路

**metasrv 启动**（`meta/binaries/meta/entry.rs:64`）：

```
entry::<RT>(conf)
├── OnDisk::open(raft_config)           — 打开磁盘数据
├── MetaWorker::create_meta_worker()   — 创建 raft meta worker（外部 crate）
├── HttpService::do_start()             — admin HTTP
├── GrpcServer::<RT>::create().do_start()  — gRPC API
└── meta_handle.join_cluster()          — 加入 raft 集群
```

**客户端调用**（以 `create_database` 为例）：

```
CatalogManager::init() → MetaStoreProvider → MetaStore
MetaStore.create_database(req)
└── SchemaApi (DatabaseApi trait 默认实现)
    └── 构建_txn_req (condition + if_then)
        └── send_txn(self) → upsert_kv/transaction (gRPC)
            └── metasrv → raft log → 状态机 apply → KV store
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MetaStore::create_meta_store` | 创建客户端 | 本地/远程 gRPC 双模式 |
| `KVPbApi::upsert_pb` | protobuf KV 读写 | 类型化 Key + FromToProto |
| `KVPbCrudApi::crud_update_existing` | CAS 更新 | 默认实现 + blanket impl |
| `NameIdValueApi::create_id_value` | name→id→value 两级映射 | rename 不影响 id→value |
| `send_txn` | 事务提交 | condition(CAS) + if_then |
| `MetaTxnManager::run` | CAS 重试驱动 | 失败丢弃状态重读 |

</details>

## 核心实现

### MetaStore 双模式客户端

`MetaStore`（`meta/store/src/lib.rs:74`）是统一入口，枚举支持本地嵌入式和远程 gRPC 两种模式：

```rust title="meta/store/src/lib.rs"
pub enum MetaStore {
    L(Arc<LocalMetaService>),               // 嵌入式本地元服务（测试/databend-local）
    R(Arc<ClientHandle<DatabendRuntime>>),  // 远程 gRPC 客户端
}
```

`MetaStore` 直接 impl `kvapi::KVApi`（非通过 Deref），将 `upsert_kv`/`get_many_kv`/`list_kv`/`transaction` 委托给 `inner()`。设计意图（注释 L69-72）：将 KV API 与底层 gRPC client 解耦，使 `ClientHandle` 成为纯通信层。`MetaStoreProvider::create_meta_store` 根据配置选择模式。

### KV/CRUD API 四层抽象

四层从底到顶，每层 trait + 默认实现 + blanket impl：

1. **`KVApi`**（外部 `databend-meta-client`）：4 个原始 KV 操作（`upsert_kv`/`get_many_kv`/`list_kv`/`transaction`）。
2. **`KVPbApi`**（`kv/pb_api/mod.rs:60`）：protobuf 编解码 + 类型化 Key（`kvapi::Key`），提供 `upsert_pb`/`get_pb`/`list_pb`。`get_id_and_value` 一次调用完成 `name→id→value` 两级查询。
3. **`KVPbCrudApi`**（`kv/pb_crud_api.rs:43`）：CRUD 语义（`crud_try_insert`/`crud_try_upsert`/`crud_update_existing`/`crud_remove`），含 CAS 重试循环。
4. **`NameIdValueApi`**（`kv/name_id_value_api.rs:73`）：`name→id→value` 两级映射模式。

新资源类型只需定义 `TenantResource` + `ValueType`，即获得全部 CRUD 能力——blanet impl 自动为所有满足约束的类型实现。

### Ident 类型化 Key

`TIdent<R, N>`（`meta/app/src/tenant_key/ident.rs:32`）通过 phantom type `R: TenantResource` 区分不同 key 空间，`TenantResource` trait 定义 key 元数据：

```rust title="resource.rs"
pub trait TenantResource: 'static {
    const PREFIX: &'static str;       // 如 "__fd_database"
    type ValueType: kvapi::Value;     // key 对应的 value 类型
}
```

`StructKey` derive 宏自动实现 key 编解码，序列化为 `/` 分隔字符串（如 `__fd_database/tenant_foo/db1`）。Database 的 KV 映射：

```
__fd_database/<tenant>/<db_name>      → DatabaseId (u64)         // name → id
__fd_database_by_id/<db_id>          → DatabaseMeta (protobuf)   // id → meta
__fd_database_id_to_name/<db_id>     → DatabaseNameIdentRaw       // id → name (反向索引)
```

**两级映射的优势**（`name_id_value_api.rs:63` 注释）：`name→id` 提供稳定内部 ID，rename 不影响 `id→value` 映射。用 `TableId` 更新表元数据不会与 rename 事务冲突。

### 事务 API 与 CAS

事务通过 `TxnRequest` 构建（`condition` + `if_then` + `else_then`），工具函数组装：

```rust title="database_api.rs — create_database 的 CAS 事务"
txn.condition.extend(vec![
    txn_cond_seq(name_key, Eq, curr_seq),   // CAS: name→id 映射未变
    txn_cond_seq(&id_to_name_key, Eq, 0),    // 新 id→name 不存在
]);
txn.if_then.extend(vec![
    txn_put_pb(name_key, &id_key),          // (tenant, db_name) → db_id
    txn_put_pb(&id_key, &req.meta),          // (db_id) → db_meta
]);
let (succ, _) = send_txn(self, txn).await?;
if !succ { /* backoff and retry */ }
```

`MetaTxnManager`（`txn/meta_txn/manager.rs:37`）的 `run()` 驱动闭包在 CAS 循环中执行——失败提交后丢弃事务状态重新读取重试。`txn_backoff()` 控制退避。

### SchemaApi 组合 trait

`SchemaApi`（`api_impl/schema_api.rs:124`）是**纯组合 trait**，聚合 8 个领域 trait（`CatalogApi`/`DatabaseApi`/`DictionaryApi`/`GarbageCollectionApi`/`IndexApi`/`LockApi2`/`SecurityApi`/`TableApi`），不定义自己的方法。所有 trait 都有 `impl<KV> TraitXxx for KV where KV: KVApi<...>` 的 blanket impl——**任何实现 KVApi 的类型自动获得全部 schema 管理能力**。

### RuntimeApi 解耦

`RuntimeApi`/`SpawnApi` trait 定义在外部 `databend-meta` crate，`DatabendRuntime`（`meta/runtime/src/lib.rs:70`）是本仓库适配器，将 `databend_common_base::Runtime` 包装为 `RuntimeApi` 实现。模块文档（L17-21）：让 meta-service 利用 Databend 的高级运行时特性（内存/线程追踪），同时保持 raft 核心与 query 运行时解耦。`entry::<RT: RuntimeApi>(conf)` 是泛型函数，运行时注入在 `entry.rs:167`。`DatabendRuntime` 还通过 `SpawnApi::prepare_request()` 注入 W3C traceparent 和 QueryID，实现分布式追踪从 query 到 metasrv 端到端传递。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| KV/CRUD 分层 blanket | `kv/` 四层 trait | 新资源类型自动获得全部 CRUD |
| Ident 类型化 Key | `tenant_key/ident.rs` TIdent | phantom type 区分 key 空间，编译期安全 |
| 事务 CAS 模式 | `txn/` condition+if_then | 乐观锁，冲突重试 |
| 组合 trait | `SchemaApi` 聚合 8 trait | 避免巨型 trait，按领域拆分 |
| 适配器 | `DatabendRuntime` → RuntimeApi | raft 核心与 query 运行时解耦 |

**为什么把 raft 拆到独立仓库**：(1) 独立版本节奏——`databend-meta` 版本 `260512.4.0` 与 query 版本不同，raft 核心可独立迭代；(2) 减少编译依赖——query 只需依赖轻量的 `databend-meta-client`（trait 定义+类型），不必编译 raft 状态机；(3) 关注点分离——数据模型与 raft 实现严格分离（`meta-app/src/lib.rs:18` 注释：此 crate 类型"不会被 databend-meta 直接使用"）。

## 模块间交互

query（`CatalogManager`）通过 `MetaStore` 客户端访问元服务。`CatalogManager::init`（`catalog/src/catalog/manager.rs:73`）创建 `MetaStoreProvider`→`MetaStore`。query 的 `management/`（user_mgr/role_mgr/procedure_mgr）使用 `KVPbApi`/`NameIdValueApi` trait 调用。调用链：query → SchemaApi trait → KVApi → MetaStore → gRPC → metasrv → raft → 状态机。

## 扩展方式

**新增一种 schema 元数据**（如给 `TableMeta` 加字段）：在 `meta-app/src/schema/table/mod.rs` 的 `TableMeta` struct 加字段 → 在 `meta/proto-conv/src/impls/table.rs` 更新 `FromToProto` impl → 更新 `.proto` 文件。无需修改 API 层（value 通过 `FromToProto` 自动编解码）。

**新增一个 KV 资源类型**（如 `NotebookMeta`）：定义 `TenantResource`（PREFIX/ValueType）→ 定义 `ValueType` struct impl `kvapi::Key` → 实现 `KeyUnknownBuilder`/`KeyExistsBuilder` 错误类型 → `proto-conv` 实现 `FromToProto`。直接用 `CrudMgr` 或 `KVPbCrudApi` 即获 CRUD 能力，无需修改 KVApi/SchemaApi。
