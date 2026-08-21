---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "元数据管理"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "C++", "FoundationDB", "元数据", "MVCC"]
description: "ByConity 基于 FoundationDB 的分布式元数据管理：Catalog 代理层、多版本可见性与原子提交。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/00-overview)

---

## 模块定位

存算分离架构把"元数据"从计算节点剥离出来，放进共享的、强一致的 KV 存储。**Catalog** 就是这层元数据的统一访问入口——所有 server、worker、daemon-manager 各自在进程内实例化一个 `Catalog` 对象，通过它读写共享元数据（数据库、表、part、delete bitmap、字典、UDF、事务记录、worker group、统计信息等）。

Catalog 解决两个核心问题：

1. **强一致 + 原子性**：一次写入可能同时改 part 元数据、delete bitmap、分区索引、sync list，这些必须全部成功或全部失败。Catalog 底层用 FoundationDB（FDB）的 ACID 事务 + CAS 保证这一点。
2. **多版本可见性（MVCC）**：并发事务读写同一张表时，每个事务只能看到自己 `snapshot_ts` 之前的已提交版本。Catalog 在 KV 层之上用"多版本 key"实现应用级 MVCC，而非依赖 FDB 自身的事务隔离（FDB 事务 5 秒超时，只用于单次提交隔离）。

Catalog 是进程内库（非独立服务），对调用方屏蔽了 FDB 细节。

---

## 模块架构

Catalog 内部分四层，自上而下逐层委托：

```
┌──────────────────────────────────────────────────────────┐
│  Catalog  (Catalog.h)        对外 API 200+ 方法           │
│  getTable / writeParts / finishCommit / createDatabase    │
└─────────────────────────────┬────────────────────────────┘
                              │  委托 + key schema
┌─────────────────────────────▼────────────────────────────┐
│  MetastoreProxy  (MetastoreProxy.h)                      │
│  130+ static key 生成方法 (dbKey/tableStoreKey/...)       │
│  CAS 冲突错误转译 (METASTORE_DB_UUID_CAS_ERROR ...)       │
└─────────────────────────────┬────────────────────────────┘
                              │  抽象接口
┌─────────────────────────────▼────────────────────────────┐
│  IMetaStore  (IMetastore.h)   put/get/putCAS/batchWrite  │
│  adaptiveBatchWrite: 超限事务自动拆分                      │
└──────────────┬──────────────────────────┬──────────────────┘
       MetastoreFDBImpl               MetastoreByteKVImpl
       (FDBClient, 当前启用)           (#if 0 禁用, 预留后端)
└──────────────┴──────────────────────────┴──────────────────┘
```

四层各司其职：**Catalog** 只关心业务语义（"把这几个 part 提交到这张表"），**MetastoreProxy** 负责 key 命名空间与 CAS 错误转译，**IMetaStore** 是与后端解耦的抽象接口，**MetastoreFDBImpl** 落到 FDB。这种分层让"换一个元数据后端"成为局部改动——历史上有 FDB 与 ByteKV 两套实现，1.0.0 仅启用 FDB。

---

## 调用链路

### getTable：读取一张表的可见版本

```text
Catalog::getTable(ctx, db, name, ts)                // Catalog.cpp:1318
  └─ meta_proxy->getTableID(name_space, db, name)   // 取表 UUID
       └─ metastore->get(tableUUIDMappingKey(...))  // FDBClient::Get
  └─ tryGetTableFromMetastore(uuid, ts)              // Catalog.cpp:5682
       └─ meta_proxy->getTableByUUID(...)
            └─ metastore->getByPrefix(tableStorePrefix(...))  // FDBClient::Scan
       └─ MVCC 过滤: model->commit_time() <= ts，取最新
  └─ CatalogFactory::getTableByDataModel(model)     // protobuf → StoragePtr
       └─ createStorageFromQuery(create_query)
```

数据类型变化：`String db/name` → `Protos::TableIdentifier(uuid)` → `RepeatedPtrField<Protos::DataModelTable>`（按 commit_time 排序的多版本）→ `StoragePtr`。

### writeParts：事务提交时原子写入多个 part

```text
Catalog::writeParts(table, txnID, commit_data, ts)  // Catalog.cpp:3378
  └─ 检查 host server (CnchTopologyMaster::getTargetServer)
  └─ finishCommitInternal(...)                       // Catalog.cpp:948
       └─ meta_proxy->prepareAddDataParts(uuid, parts, batch_write)  // MetastoreProxy.cpp:924
            └─ 每个 Protos::DataModelPart → SerializeAsString()
            └─ SinglePutRequest(dataPartKey(...), part_meta) 加入 batch
       └─ meta_proxy->batchWrite / finishCommitInBatch
            └─ metastore->batchWrite(req, resp)
                 └─ FDBClient::MultiWrite(tr, req, resp)   // CAS + fdb_transaction_commit
```

关键点：所有 part 元数据、delete bitmap、partition meta、sync list 被打包进一个 `BatchCommitRequest`，由 FDB 单事务原子提交；任一 CAS 失败则整批回滚，`RunWithRetry`（`FDBClient.cpp:64`）处理 FDB 的 `not_committed` 冲突重试。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Catalog::getTable` | 按事务 ts 读表的可见版本 | getByPrefix + commit_time 过滤 |
| `Catalog::writeParts` | 事务提交时写 part 元数据 | 单 FDB 事务原子批写 |
| `Catalog::finishCommit` | 标记事务已提交（commit_ts） | CAS Running→Finished |
| `Catalog::createDatabase` | 创建数据库 | dbUUIDUniqueKey CAS 防重 |
| `MetastoreProxy::prepareAddDataParts` | 把 part 序列化成 KV | dataPartKey 命名 |
| `IMetaStore::adaptiveBatchWrite` | 拆分超限事务 | 按 getMaxBatchSize 分批 |
| `FDBClient::MultiWrite` | FDB 多操作原子提交 | RAII + CAS 重试 |

</details>

---

## 核心实现

### 为什么是 FoundationDB 而非 ZooKeeper

ClickHouse 原版用 ZooKeeper 协调副本与 mutation，但 ZK 不支持多 key 的原子事务（multi-op 无真正隔离级别）。ByConity 的写入语义需要原子性——`writeParts` 要同时落 parts + delete bitmaps + partition meta + sync list，必须 all-or-nothing。FDB 提供严格的 ACID 事务与 optimistic concurrency control：

```cpp title="FDBClient.cpp"
// MultiWrite 在单个 fdb_transaction_commit 中原子提交多个 put/delete + CAS
// RunWithRetry 处理 FDB 的 not_committed 冲突重试（ZK multi-op 无此机制）
```

`MetastoreFDBImpl` 定义了两个硬上限：`MAX_FDB_KV_SIZE 10000`（单个 value 10KB）、`MAX_FDB_TRANSACTION_SIZE 10000000`（单事务 10MB）。后者由 `IMetaStore::adaptiveBatchWrite`（`IMetastore.cpp:9`）处理——当一次 `BatchCommitRequest` 总量超过 `getMaxBatchSize()` 时自动拆成多个独立事务提交（注意：拆分后不保证跨批原子性，调用方需保证拆分点安全）。

### MetastoreProxy：key schema 与 CAS 错误转译

MetastoreProxy 的核心职责不是"转发"，而是**集中 key 命名规则**和**把底层 CAS 冲突转译成业务错误**。它持有 130+ 个 `static` key 生成方法，例如 `dbKey(name_space, db, ts)` 生成形如 `namespace_DB_db_<commit_ts>` 的版本化 key。这样 Catalog 方法只需关心业务语义，key 格式逻辑全收口在代理层。

CAS 错误转译是另一个关键设计。以 `addDatabase`（`MetastoreProxy.cpp:126`）为例：当 `batchWrite` 抛出 `METASTORE_COMMIT_CAS_FAILURE` 时，代理层检查 `resp.puts` 中的冲突 index，转译为 `METASTORE_DB_UUID_CAS_ERROR`（UUID 重复）或 `METASTORE_TABLE_NAME_CAS_ERROR`（表名重复）——把"底层 CAS 失败"翻译成调用方能理解的"业务冲突"。

### 应用层 MVCC：多版本 key

`VisibilityLevel` 枚举（`Catalog.h:74`）定义了三种可见性：`Visible`（仅 commit_ts ≤ ts 的可见版本）、`Committed`（含已删除版本）、`All`（含未提交版本）。

MVCC 的实现方式是**多版本 key**——每次修改表/数据库时写入新 key，key 中嵌入 `commit_time` 后缀，旧版本保留：

```cpp title="Catalog.cpp (tryGetTableFromMetastore)"
// getByPrefix 取出表的所有版本 (RepeatedPtrField<DataModelTable>)
// 按 commit_time 排序，过滤 model->commit_time() <= ts，取最新可见版本
// 再用 Status::isDeleted 检查是否已被删除
```

这是**应用层 MVCC**，不依赖 FDB 的 MVCC——FDB 的事务隔离只覆盖单次 5 秒提交窗口，元数据的多版本历史是 Catalog 通过 key 设计自己实现的。`name_space` 前缀则用于多租户 key 隔离，不同 name_space 的元数据互不干扰。

### consistent hashing 定位 host server

Catalog 本身不实现 consistent hashing，路由由 `CnchTopologyMaster::getTargetServer(table_uuid, vw_name, ts)` 完成（在 `getTable` `Catalog.cpp:1333`、`writeParts` `Catalog.cpp:3403` 处调用）。只有 host server 才能执行写操作（`assertLocalServerThrowIfNot`），非 host server 会通过 `CnchServerClientPool` 重定向（`redirectCommitParts`）。这把"哪张表归哪个 server 管"的负载分担从 Catalog 剥离到拓扑层。

### 元数据 GC

Catalog 提供丰富的 GC API：`getTransactionRecordsForGC`（僵尸事务）、`clearDataPartsMeta` / `clearDeleteBitmapsMetaForTable`（元数据清理）、`moveDataItemsToTrash` / `clearTrashItems`（trash 机制——先移入 trash 延迟删除，避免误删）、`clearZombieIntent`（僵尸事务的 intent）。这些 API 由 DaemonManager 的 `DaemonJobTxnGC` / `DaemonJobGlobalGC` 周期性调用（见[后台任务编排与执行](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/07-daemonmanager-workertasks)）。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂 | `CatalogFactory::getTableByDataModel`（CatalogFactory.cpp:77） | protobuf DataModel → StoragePtr，隔离反序列化与引擎创建 |
| 代理 | `MetastoreProxy`（MetastoreProxy.h:179） | 集中 key schema 与 CAS 错误转译，Catalog 不碰底层 KV |
| 策略 | `IMetaStore` + `MetastoreFDBImpl` / `MetastoreByteKVImpl` | 可切换元数据后端 |
| 单例 | `FDBClient::Instance`（FDBClient.cpp:112） | FDB 限制每进程一个 client |
| RAII | `FDBTransactionRAII` / `FDBFutureRAII`（FDBClient.h:65,77） | 析构自动 destroy FDB 资源，防泄漏 |
| 模板方法 | `Catalog::getDataModelsByPartitions<T>`（Catalog.h:968） | 泛化 part/delete bitmap 的分区扫描 |

---

## 模块间交互

Catalog 几乎被所有模块依赖（30+ 文件 import）：Transaction（commit record、undo buffer、intent、锁）、Interpreters（Context 持有 Catalog）、Statistics（统计信息读写）、Storages（`StorageCnchMergeTree` 取 parts/mutations）、DaemonManager（后台 GC）、CloudServices（BG 线程取 part、写入提交）。

交互方式均为**进程内直接调用**（非 RPC）。Catalog 本身不发起 RPC——但写操作前会通过 `CnchTopologyMaster` 检查本 server 是否为 host server，非 host 时委托 `CnchServerClient` 转发。Catalog 依赖：FDB C API、Protos（所有元数据用 protobuf 序列化）、Transaction（`TxnTimestamp`/`TransactionRecord`）、Storages（part 对象）、ResourceManagement（VW/worker group 元数据）。

---

## 扩展方式

**新增一种元数据类型**（如新增一种 database object）：

1. `MetastoreProxy.h`：新增 key 前缀宏与 static key 生成方法
2. `MetastoreProxy.cpp`：新增 `addNewObject` / `getNewObject` / `dropNewObject`，调用 `metastore->put/get/drop`
3. `Catalog.h/.cpp`：新增对外 API，用 `runWithMetricSupport` 包装
4. `Protos/data_models.proto`：新增对应 protobuf DataModel
5. `CatalogFactory.cpp`：如需从 DataModel 构建对象，新增 `getNewObjectByDataModel`

**替换 metastore 后端**（FDB → 其他 KV）：新建 `MetastoreXXXImpl` 继承 `IMetaStore` 实现全部纯虚方法，在 `MetastoreProxy::getMetastorePtr`（MetastoreProxy.h:171）按 `config.type` 新增分支。`MetastoreByteKVImpl` 虽已 `#if 0` 禁用，但保留了切换后端的扩展骨架。
