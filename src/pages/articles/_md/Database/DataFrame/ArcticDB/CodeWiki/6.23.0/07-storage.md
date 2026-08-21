---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "存储后端"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "storage", "S3", "LMDB", "后端抽象"]
description: "ArcticDB 存储后端：Store/Storage 抽象与 8 种后端实现"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

存储后端模块（`cpp/arcticdb/storage/`，~15k 行）把异构存储（S3/Azure/LMDB/Mongo/Memory/GCP/NFS/MappedFile）统一成一个**非泄漏抽象**。这层独立存在是因为 ArcticDB 的"无服务器"承诺要求客户端能直连任意对象存储——存储必须可替换、可测、可独立演进。`store.hpp` 的注释明确："The Store class aims, as much as possible, to be a fundamental, non-leaky abstraction... Higher level operations can read from or write to a Store without any consideration of what sort of storage is being written to."

## 模块架构

![存储抽象与后端](/vibe-reading/images/articles/arcticdb-internals/storage-stack.svg)

存储抽象分两层：**`Store`**（`store.hpp`）是高层接口，继承 `stream::StreamSink` + `stream::StreamSource` + `enable_shared_from_this`，对上提供"给 SegmentInMemory 返键、给键返 SegmentInMemory"的语义，主实现是 `AsyncStore`（用 Folly Future 包装存储操作）；**`Storage`**（`storage.hpp`）是后端基类，用模板方法模式——`write()`/`read()`/`remove()`/`key_exists()`/`iterate_type()` 等公共方法委托给 `do_*` 虚函数，后端只实现 `do_write`/`do_read`/`do_remove`/`do_key_exists`/`do_iterate_type_until_match` 等。`storage_factory.cpp` 的 `create_storage()` 按 protobuf `VariantStorage` 的 `config` 类型名分发到 8 个后端。URI 解析在 Python 侧的 `adapters/`（见 [Python API](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/01-python-api)），生成 protobuf 配置传给 C++ 工厂。

## 调用链路

```text
Python adapter 解析 URI → protobuf Storage 配置
  create_storage(library_path, mode, VariantStorage)        storage_factory.cpp:33
    └─ 按 type_name 分发 → make_shared<XxxStorage>(...)
  AsyncStore::write(key_seg) → submit_io_task → Storage::write → do_write
  AsyncStore::read(key)      → submit_io_task → Storage::read  → do_read
  iterate_type(KeyType, visitor) → do_iterate_type_until_match
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Store::write/read` `store.hpp` | 高层 SegmentInMemory ↔ 键 | 非泄漏抽象，屏蔽压缩/编码 |
| `AsyncStore` `async/async_store.hpp` | Folly Future 包装存储 I/O | 投到 I/O 池并行 |
| `Storage::write` `storage.hpp:81` | 模板方法 → `do_write` | 公共采样/校验在基类 |
| `Storage::supports_atomic_writes` `:113` | 是否支持条件写 | `test_atomic_write_support` 实测 |
| `Storage::iterate_type` `:143` | 遍历某 KeyType 的键 | `do_iterate_type_until_match` 谓词止 |
| `create_storage` `storage_factory.cpp:33` | 工厂分发 | 按 protobuf type_name |

## 核心实现

### 8 种后端与工厂分发

`storage_factory.cpp` 的 `create_storage(LibraryPath, OpenMode, VariantStorage)` 解包 protobuf `config`，按 `type_name` 分发：`s3_storage_pb2::Config`→`S3Storage`、`gcp_storage_pb2::Config`→`GCPXMLStorage`、`lmdb::LmdbStorage::Config`→`LmdbStorage`、`mongo::MongoStorage::Config`→`MongoStorage`、`memory::MemoryStorage::Config`→`MemoryStorage`、`nfs_backed::NfsBackedStorage::Config`→`NfsBackedStorage`、`azure::AzureStorage::Config`→`AzureStorage`、`file::MappedFileStorage::Config`→`MappedFileStorage`。另有 `S3Settings`/`GCPXMLSettings` 直接重载（不经 protobuf）。S3 是主力后端——`s3_storage.cpp`/`s3_api.cpp`/`s3_client_wrapper.cpp`，支持 multipart 上传、批量操作、重试、path_prefix；AWS SDK 日志经 `SpdlogLogSystem` 路由到 `s3` spdlog 流。LMDB（`lmdb_storage.cpp`）是本地嵌入式——单进程写、map_size 需创建时设定、内存映射。Mongo 主要为 Arctic v1 迁移。Memory（`memory_storage.cpp`）用于测试。

### 原子写探测与字符约束

`SupportsAtomicWrites` 枚举（`storage.hpp:59`）有三值：`NO`/`YES`/`NEEDS_TEST`。S3 与 MinIO 标 `YES`/`NEEDS_TEST`，但 PURE/VAST（也是 S3）会静默忽略 `IfNoneMatch` 条件写——所以 `test_atomic_write_support()`（`:195`）实测：写一个随机 `ATOMIC_LOCK` 键两次，第二次若仍成功说明后端忽略条件写（返 false），若抛 `AtomicOperationFailedException` 说明真支持（返 true），若抛 `NotImplementedException` 说明不支持（如 PURE）。结果缓存在 `supports_atomic_writes_`。这支撑了 `ATOMIC_LOCK` 的可靠分布式锁（见[版本引擎](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/02-version-engine)）。`GLOBALLY_UNSUPPORTED_CHARS{'*','<','>'}` 是所有后端禁用字符（S3 拒绝），后端可扩展——`do_unsupported_symbol_chars`/`do_unsupported_library_chars`/`do_verify_library_suffix`（如 LMDB Windows 不允许尾随 `.`/空白）。`has_async_api()`/`async_api()` 暴露原生异步接口（部分后端支持）。`max_delete_batch_size()` 限制单次 `do_remove(span)` 批量（LMDB/memory 无限制）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 抽象工厂 | `create_storage` | 按 protobuf 配置分发后端 |
| 模板方法 | `Storage::write`→`do_write` | 公共逻辑基类，后端只填 `do_*` |
| 适配器 | 每个 `*Storage` 适配一个 SDK | 屏蔽 AWS/Azure/LMDB SDK 差异 |
| 策略探测 | `test_atomic_write_support` | 不同 S3 厂商行为不一，运行时实测 |

## 模块间交互

存储向上被 `AsyncStore`（[异步模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/09-stream-async)）包装、被[版本引擎](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/02-version-engine)与[管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)经 `Store` 接口调用。键类型来自[核心类型](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/08-entity)。`StreamSink`/`StreamSource`（`stream/`）是 `Store` 的父接口，定义 `write`/`read`/`iterate` 的流式语义。Python 适配器（`adapters/`）是这层在 Python 侧的对应——每个 C++ 后端一个 Python 适配器。

## 扩展方式

新增存储后端：1) `cpp/arcticdb/storage/<backend>/` 新建类继承 `Storage`，实现 `do_write`/`do_read`/`do_remove`/`do_key_exists`/`do_iterate_type_until_match`/`do_key_path`/`do_supports_prefix_matching`/`do_supports_atomic_writes`/`do_fast_delete`；2) `cpp/proto/arcticc/pb2/<backend>_storage.proto` 加 protobuf 配置；3) `storage_factory.cpp` 的 `create_storage` 加 `else if` 分支；4) `python/arcticdb/adapters/<backend>_library_adapter.py` 加 URI 适配器 + 注册到 `arctic.py:_LIBRARY_ADAPTERS`；5) 测试 `python/tests/integration/arcticdb/test_storage_<backend>.py` + `cpp/arcticdb/storage/<backend>/test/`。见概览「典型修改场景 2」。
