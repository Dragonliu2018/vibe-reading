---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "公共基础"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "Runtime", "hashtable", "对象存储"]
description: "Databend 公共基础库——GlobalInstance 单例 + Runtime 线程池 + ErrorCode + 自建 hashtable + OpenDAL 对象存储。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

公共基础库（`src/common/`，~70.7k 行，21 个 crate）是 Databend 的**最底层依赖**，被 query 和 meta 几乎所有模块引用，自身不依赖任何业务层。它提供跨模块复用的基础设施——异步 Runtime、全局单例注册、统一错误处理、二进制 IO、自建高性能哈希表、对象存储抽象、缓存、压缩、统计采样器。其中 `common/exception`（ErrorCode/Result）是被引用最多的模块（fan-in 2572），几乎所有 `.rs` 文件都 `use databend_common_exception::Result`。

## 模块架构

`src/common/` 下 21 个子 crate 各司其职，核心包括 `base`（Runtime/GlobalInstance）、`exception`（错误）、`io`（序列化）、`hashtable`（哈希表）、`storage`（对象存储）、`column`（底层列）、`cache`、`compress`、`statistics`。

```
query/* ──→ common/storage (DataOperator) ──→ common/base (Runtime/GlobalInstance)
         ──→ common/exception (Result)     ──→ common/io (序列化)
         ──→ common/hashtable (group-by/join)
meta/*  ──→ common/base, common/exception
```

## 调用链路

**全局实例注册与获取**：

```
GlobalInstance::init_production()          [singleton_instance.rs:104]
GlobalIORuntime::init(num_cpus)           [global_runtime.rs:36]
  → Runtime::with_worker_threads("IO-worker")
  → GlobalInstance::set(Arc<Runtime>)
GlobalIORuntime::instance()               [global_runtime.rs:47]
  → GlobalInstance::get::<Arc<Runtime>>()
```

**对象存储初始化**：

```
DataOperator::init(conf, spill_params)    [operator.rs:634]
└── init_operator(storage_params)         [operator.rs:74]
    └── init_operator_uncached(cfg)        [operator.rs:92]
        └── match StorageParams { S3 → init_s3_operator, ... }
            → build_operator(builder)      — 统一添加 layer 栈
    → GlobalInstance::set(DataOperator)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `GlobalInstance::set`/`get` | 全局单例注册/获取 | 按类型做 key，编译期安全 |
| `Runtime::block_on`/`spawn` | 异步运行时 | 自动注入 ThreadTracker |
| `ErrorCode::UnknownTable` | 错误构造 | 宏批量生成常量+构造函数 |
| `ErrorCodeResultExt::or_unknown_table` | 错误转 Option | 18 种 not-found 统一处理 |
| `init_operator` | 创建对象存储 Operator | 缓存 + layer 栈复用 |
| `Hashtable::insert` | 哈希表插入 | MaybeUninit 优化，返回槽位 |

</details>

## 核心实现

### GlobalInstance 全局单例

`GlobalInstance`（`base/src/base/singleton_instance.rs`）基于 `state::TypeMap`（按 Rust 类型做 key）实现全局注册表，替代 DI 容器：

```rust title="singleton_instance.rs"
impl GlobalInstance {
    pub fn init_production();
    pub fn get<T: Clone + 'static>() -> T;          // 按类型获取单例
    pub fn set<T: Send + Sync + 'static>(value: T); // 注册，重复 set panic
}
```

**为什么用 GlobalInstance 而非 DI 框架**：(1) 编译期类型安全，拼写错误编译失败；(2) 无反射开销，`get<T>()` 是 TypeMap 查找 + clone；(3) debug 模式下 per-thread 隔离（`LOCAL` 字典）解决单元测试全局状态污染。劣势是全局可变状态、隐式依赖，测试需 `init_testing` 显式管理。`GlobalIORuntime`/`GlobalQueryRuntime`/`GlobalControlRuntime` 都通过 `GlobalInstance::set/get` 单例化。

### Runtime 异步运行时

`Runtime`（`base/src/runtime/runtime.rs`）封装 tokio 运行时，`block_on` 包裹 `CatchUnwindFuture`，`spawn` 自动注入 `ThreadTracker::tracking_future` 和 `async_backtrace` 帧：

```rust title="runtime.rs"
pub struct Runtime {
    handle: Handle,
    task_marker: String,       // "[{runtime_label}]" 过滤标记
    _dropper: Dropper,         // Drop 时关闭 runtime 并 join watchdog
}
```

`Runtime::with_worker_threads` 创建时 `on_thread_start(ThreadTracker::init)` 让每个线程启动时初始化追踪。`GlobalIORuntime::init(num_cpus)` 创建 IO 线程池（线程数 = `max(num_cpus, num_cpus/2)`），所有对象存储 IO 走此运行时，与查询线程隔离。

### ErrorCode 统一错误

`ErrorCode<C = ()>`（`exception/src/exception.rs:31`）是统一错误类型，泛型 `C` 是 phantom type 用于编译期区分错误上下文。`Result<T> = std::result::Result<T, ErrorCode>` 全链路统一：

```rust title="exception.rs"
pub struct ErrorCode<C = ()> {
    code: u16,           // 错误码
    name: String,        // 如 "UnknownTable"
    display_text: String,
    span: Span,          // SQL 源码定位
    cause: Option<Box<dyn Error + Send + Sync>>,
    backtrace: StackTrace,
}
```

错误码通过 `build_exceptions!` 宏按**功能域**分段生成（同时生成 `const` 常量和构造函数）：`[1003-1026]` 数据库/表访问、`[1005-1007]` 语法/语义、`[2001-2016]` Meta 服务（含 `OCCRetryFailure(2011)`）、`[1061-2506]` 权限/集群。`ErrorCodeResultExt` 提供 `or_unknown_table()`/`or_unknown_resource()` 等——`or_unknown_resource()` 一次性将 18 种 "not found" 错误转为 `None`，实现 try-get 语义。

### 自建 hashtable

`Hashtable<K, V, A>`（`hashtable/src/hashtable.rs`）是自建高性能哈希表，用于 group-by/join：

```rust title="hashtable.rs"
pub struct Hashtable<K, V, A = DefaultAllocator> {
    zero: ZeroEntry<K, V>,     // key==0 特殊条目（避免哈希冲突）
    table: Table0<K, V, ...>,  // 主表
}
```

**为什么自建而非 std::HashMap/hashbrown**：(1) `FastHash` 使用 SSE4.2 CRC32 指令（`_mm_crc32_u64`），比 SipHash 快 10 倍以上；(2) `insert` 返回 `Result<&mut MaybeUninit<V>, &mut V>`——先获取槽位再写值，避免额外拷贝；(3) `PartitionedHashtable<Impl, BUCKETS_LG2>` 分区哈希表配合 Bump arena 分配器，实现无锁并行 group-by/join；(4) 系列变体：`StackHashMap`（栈上）、`StringHashMap`（字符串专用）、`LookupHashMap`（查找表）。

### DataOperator 对象存储抽象

`DataOperator`（`storage/src/operator.rs`）通过 OpenDAL `Operator` 抽象底层存储，`init_operator`（`operator.rs:74`）按 `StorageParams` 枚举分发到各后端初始化函数（`init_s3_operator`/`init_azblob_operator`/`init_gcs_operator` 等），再经 `build_operator` 统一添加 layer 栈：

```rust title="operator.rs"
fn build_operator<B: Builder>(builder, network_config, scope) -> Operator {
    Operator::new(builder)
        .layer(TimeoutLayer)                    // 超时
        .layer(RuntimeLayer::new(GlobalIORuntime::instance()))  // IO 运行时隔离
        .layer(RetryLayer)                      // 自动重试
        .layer(FastraceLayer)                   // 分布式 tracing
        .layer(METRICS_LAYER)                   // Prometheus metrics
        .layer(ConcurrentLimitLayer)            // 并发限制
}
```

支持 S3/Azblob/Gcs/Oss/Obs/Cos/Fs/Hdfs/Http/Ipfs/Memory/Huggingface/Webhdfs 12 种后端。`RuntimeLayer` 将所有存储 IO 调度到 `GlobalIORuntime` 线程池与查询线程隔离。`operator_cache` 缓存已创建 Operator 避免重复初始化，HTTP 类后端共享 `StorageHttpClient` 连接池。

### BinaryRead / BinaryWrite trait extension

`BinaryRead`/`BinaryWrite`（`io/src/binary_read.rs`/`binary_write.rs`）通过 blanket impl `impl<T: io::Read> BinaryRead for T`，所有实现 `std::io::Read` 的类型自动获得二进制读写能力（`read_scalar`/`read_string`/`read_uvarint`），零运行时开销。

### Cache / Compress / Statistics

`Cache` trait（`cache/src/cache.rs`）+ `LruCache`（基于 `LinkedHashMap`），`MemSized` trait 让 key/value 报告内存大小支持按字节或条目双维度淘汰。`CompressAlgorithm`/`CompressCodec` 支持 Brotli/Bz2/Gzip/Zstd 等。`KllSketch`（`statistics/src/kll_sketch.rs`）是 KLL 近优 quantile 估计算法，多层采样结构，满了 compaction 向上层推。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 全局单例 | `singleton_instance.rs` TypeMap | 替代 DI 框架，编译期类型安全 |
| Result 错误传播 | `exception.rs` 统一 ErrorCode | `?` 自动传播，`ToErrorCode` 无缝转换 |
| Trait extension | `io` blanket impl | 零开销扩展 std 类型 |
| 对象存储 Layer | `operator.rs` layer 栈 | 各后端复用统一 layer（超时/重试/指标）|
| 类型状态 | `ErrorCode<C>` phantom | 编译期区分错误上下文 |

## 模块间交互

`src/common/` 是最底层依赖，不依赖任何业务层。`common/storage`→`common/base`（GlobalInstance/Runtime）+`common/meta_app`（StorageParams 定义在此）。`common/exception` 被几乎所有模块引用。`common/hashtable`→`common/base`（DefaultAllocator）。

## 扩展方式

**新增一种对象存储后端**（如 MinIO）：在 `meta-app/src/storage/mod.rs` 的 `StorageParams` 枚举添加变体 → 在 `storage/src/operator.rs:92` 的 `init_operator_uncached` match 添加分支调 `init_minio_operator`（用 `services::S3` builder，MinIO 兼容 S3 协议）→ 如需特殊认证在 `auth.rs` 添加。

**新增一个 ErrorCode**：在 `exception_code.rs` 的合适 `build_exceptions!` 块添加一行（如 `UnknownPolicy(2801),`）→ 宏自动生成常量和构造函数 → 如需 try-get 语义加到 `error_code_groups` 组并扩展 `ErrorCodeResultExt`。
