---
source:
  type: "源码解读"
  project: "InfluxDB"
  url: "https://github.com/influxdata/influxdb"
title: "Catalog 元数据"
date: "2026-08-20T13:07:26+08:00"
category: [Database, TSDB, InfluxDB, CodeWiki, "3.11.1"]
tags: ["InfluxDB", "Rust", "TSDB"]
description: "InfluxDB 3 Core 的 Catalog 元数据管理：事件溯源（ordered_records）、版本化 format/log/snapshot、CatalogOp trait 与乐观并发"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/00-overview)

---

## 模块定位

`influxdb3_catalog`（73K 行，最大应用层 crate）是元数据中心，承载数据库/表/Parquet 文件/token/role 的元数据。它用**事件溯源**（Event Sourcing）管理状态变更——所有变更记录为 `Record` 序列（`ordered_records`），通过 replay 重建内存状态；用**版本化 format/log/snapshot** 三个独立维度保证前向兼容，允许新旧版本节点共存；用 `CatalogSequenceNumber` 做**乐观并发**控制。它是被 write（schema-on-write 建表建列）、query（读表元数据）、cache（订阅 CatalogEvent）、authz（查 token 权限）共同依赖的中枢。边界：元数据状态管理与持久化，不承载数据本身（Parquet 文件在对象存储）。

## 模块架构

外层 `Catalog`（`catalog/versions/v3/catalog.rs:395`）持有 `RwLock<InnerCatalog>`（内存状态）、`Mutex<CatalogSequenceNumber>`（全局写入许可 `write_permit`）、`ObjectStoreCatalog`（持久化层）、`CatalogSubscriptions`（事件广播）。`InnerCatalog`（`catalog/versions/v3/inner.rs:34`）持有 `ordered_records: Vec<Record>`（事件溯源核心）、`databases`/`tokens`/`roles` 等 `Repository`。操作层 `CatalogOp` trait（`ops/mod.rs:27`）定义 `prepare`/`output`/`limits_check`。持久化层 `format/` 体系：`Record`（16B header + 变长 data，`record.rs:110`）、`RecordId`（Core/Enterprise 分区，`record_id.rs:17`）、`CatalogRecord` trait（`registry.rs:25`）、`RecordRegistry`（inventory 编译期注册）、`FeatureLevel`（`feature_level.rs:14`）。

## 调用链路

**单 Op 写入流程（以 create_database 为例）**：

```
Catalog::create_database(name)
  └─ update::<CreateDatabaseOp>(args)
       └─ update_committed::<CreateDatabaseOp>(args)  [catalog.rs:2808]  ★ 写入 god node
            ├─ 1. 获取 write_permit 锁，计算 next_seq
            ├─ 2. PREPARE（读锁）: Op::prepare(args, &cat, &mut batch)
            │      → 分配 DbId，push CreateDatabase record 到 RecordBatch
            ├─ 3. FEATURE LEVEL 校验: check_batch_against_committed()
            ├─ 4. SERIALIZE: serialize_log_file(uuid, next_seq, batch)
            │      (Header 64B + Records payload + CRC32)
            ├─ 5. PERSIST: store.persist_log(next_seq, bytes)
            │      → Success / AlreadyExists（→ catch_up_from + retry）
            ├─ 6. APPLY（写锁）: apply_records(batch, &mut cat, next_seq)
            │      → REGISTRY.get(record.id).decode_apply_and_event()
            │      → record.apply(catalog) + record.event() → CatalogEvent
            │      → cat.ordered_records.push(record)
            ├─ 7. 更新 write_permit = next_seq
            ├─ 8. BROADCAST: broadcast(events) → CatalogSubscriptions::send_update
            │      → mpsc channel 发送，等待所有 subscriber ACK（Drop 触发）
            └─ 9. CHECKPOINT（后台）: maybe_background_checkpoint（log_interval=100 / time_interval=1h）
```

**事务写入**（如 `create_table_opts`）：`loop { begin_database_transaction → accumulate records → commit → Prompt::Success/Retry }`——`Prompt::Retry` 时 catalog 已前进，重建事务重试。

## 核心实现

### 事件溯源：ordered_records 与 apply_records

`InnerCatalog.ordered_records: Vec<Record>`（`inner.rs:73`）保留所有已应用 Record，是事件溯源核心。`apply_records`（`format/apply.rs:339`）是 replay god node——遍历 Record 序列，通过 `REGISTRY` 查找类型擦除的 `decode_apply_and_event` 函数，逐条 `decode → apply（改 InnerCatalog）→ event（生成 CatalogEvent）`。快照本质是 `ordered_records` 的序列化（`serialize_snapshot_file` in `inner.rs:116`），冷启动从 snapshot + log replay 恢复。`ordered_records` 保留所有 Record 还支持 hard-delete 后裁剪历史。

### 版本化 format/log/snapshot 体系

三个独立维度版本化：Catalog 内存结构 v1/v2/v3、Log 文件格式 v1(bitcode)→v2(json+token)→v3→v4、Snapshot 文件格式 v1-v4。每个版本有 10 字节 `VERSION_ID`（如 `idb3.004.l`），通过 `VersionedFileType` trait 标识（`serialize.rs:8`），版本链式转换 `v1→v2→v3→v4→in-memory`。`lib.rs:52-183` 的"Adding a New Version"指南明确规定：**永远不修改已发布版本模块**，新功能必须新增 record 类型，不能修改旧的——已发布 record 的 bitcode 编码是 on-disk 格式，任何字段重排/增删都破坏前向兼容。`assert_roundtrip!` 宏（`format/records/mod.rs:101`）在测试中检测编码漂移。

### CatalogOp trait 与 inventory 编译期注册

`CatalogOp` trait（`ops/mod.rs:27`）定义 `Input`/`Output` 关联类型 + `prepare`/`output`/`limits_check` 方法。30+ Op（CreateDatabaseOp/SoftDeleteDatabaseOp/CreateTableOp/CreateLastCacheOp/CreateTriggerOp/CreateAdminTokenOp/CreateRoleOp/RestoreOp 等）分布在 `ops/` 下各子模块。`CatalogRecord` trait（`registry.rs:25`）定义 `ID`/`FLAGS`/`NAME` + `apply`/`event`，每个 record 类型通过 `inventory::submit!{ RegisteredRecord::new::<T>() }` 在编译期注册（如 `format/records/database.rs:88`）。全局 `REGISTRY: LazyLock<RecordRegistry>` 提供 `get(id) → RegisteredRecord`（携带类型擦除的 `decode_apply_and_event` 函数指针）。`derive_feature_level()` 从注册表推导节点支持的最高 record ID。这套设计使新增 record 类型只需：定义 struct + impl CatalogRecord + `inventory::submit!`，不需修改任何中心化 enum。

### CatalogSequenceNumber 乐观并发

`write_permit: Mutex<CatalogSequenceNumber>`（`catalog.rs:129`）是全局写入许可。写入流程：获取 permit 计算 `next_seq`，prepare+persist（可能 race），`persist_log` 返回 `AlreadyExists` 说明被抢先 → `catch_up_from(next_seq)` 加载并应用对方的 log → 更新 `*permit` → retry。事务路径更严格：`*permit != sequence_at_begin` 直接返回 `Prompt::Retry`，调用方决定重试。这避免长时间持锁，用序列号做乐观检测。`CatalogSequenceNumber` 是 `u64` newtype（`catalog.rs:107`）。

### CatalogEvent 广播与同步 ACK

`CatalogSubscriptions`（`catalog/versions/v3/events.rs:368`）管理命名 subscriber（compactor/processing_engine/cache 等），通过 `mpsc::channel(buffer_size=1)` 发送。关键设计：`send_update()` **等待所有活跃 subscriber `Drop` 其 `CatalogUpdateMessage`**（触发 oneshot ACK）后才返回——确保事件按序处理。subscriber 可 `stop()`（AtomicBool + Notify）优雅退出而不阻塞 broadcaster。`CatalogFullyRestored` 事件通知 subscriber 全量重建。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 事件溯源 | `ordered_records` `inner.rs:73` + `apply_records` `apply.rs:339` | 状态由 Record 序列重建，支持 replay/snapshot |
| 版本化模式 | `catalog/versions/{v1,v2,v3}` + `log/versions/` + `snapshot/versions/` | 前向兼容，新旧节点共存 |
| Registry | `format/registry.rs` + `inventory::submit!` | 编译期自动收集 record 类型，运行时按 ID 查找 |
| 乐观并发 | `write_permit` `catalog.rs:129` + `Prompt::Retry` | 序列号检测，避免长持锁 |
| Repository 模式 | `Repository<I,R>` `repository.rs:94` | 双向 id↔name 映射 + 单调 ID 分配 |
| 快照/检查点 | `maybe_background_checkpoint` `catalog.rs:303` | log_interval(100)/time_interval(1h) 双触发 |

## 模块间交互

被 `influxdb3_write` 依赖：`WriteValidator` 用 `catalog.begin`/`commit` 开事务建表建列。被 `influxdb3_query_executor` 依赖：`QueryTable::chunks` 读 `db_schema.table_definition` + retention period。被 `influxdb3_cache` 依赖：`LastCacheProvider`/`DistinctCacheProvider` 从 catalog 初始化 + 订阅 `CatalogEvent`。被 `influxdb3_authz` 依赖：`Catalog` impl `TokenPermissionProvider`/`IdProvider`/`TokenProvider`，查 token 权限与 db_name↔db_id。`CatalogEvent` 广播给 deleter（硬删除）、table_index_cache、processing_engine。

## 扩展方式

- **新增 catalog 版本 v4**：参考 `lib.rs:52-183` 指南——创建 `log/versions/v5.rs` 设 `VERSION_ID`，实现 `From<v4> for v5` 转换，更新 `serialize.rs` 的 `detect_catalog_version` 与 `log.rs` re-export。
- **新增 CatalogOp（如 CreateView）**：`format/records/` 下新建 `view.rs` 定义 struct（derive bitcode+serde）+ impl CatalogRecord + `inventory::submit!`；`catalog/versions/v3/ops/` 下新建 `view.rs` impl CatalogOp；`catalog.rs` 加 `create_view` 方法；`events.rs` 加 `ViewCreated` 变体；FeatureLevel 自动推导。
- **新增 Catalog 订阅者**：调 `Catalog::subscribe("name")` 获取 `CatalogUpdateReceiver`，循环 `recv()` 处理后 `drop(msg)` 触发 ACK，退出调 `receiver.stop()`。
