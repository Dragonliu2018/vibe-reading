---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "运行时基础"
date: "2026-08-24T10:22:21+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.7-rc01"]
tags: ["Apache Doris", "ExecEnv", "MemTracker", "RuntimeState", "FileSystem", "服务定位器", "TCMalloc"]
description: "Doris 2.1.7 运行时基础：ExecEnv 服务定位器 + MemTracker 层级追踪 + FileSystem 多后端抽象 + RuntimeState 查询状态。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.7-rc01/00-overview)

---

## 模块定位

运行时基础是 `be/src/runtime/`（~3.3 万行）+ `common/`（~1.2 万行）+ `io/`（~1.5 万行），是 BE 全模块共享的底层数据结构与资源管理。核心是 `ExecEnv`（BE god class 服务定位器，50+ 管理器）、`MemTracker`（层级内存追踪防 OOM）、`FileSystem`（多后端存储抽象）、`RuntimeState`（每查询运行时状态）。独立成文是因为这些跨模块共享的底层数据结构与资源管理独立于执行与存储——`Block`/`Column` 贯穿全链路，`ExecEnv` 持有所有管理器统一生命周期。

## 模块架构

```
ExecEnv (runtime/exec_env.h:120) ── BE 服务定位器单例
   ├─ GetInstance() (:143)  ── static 局部变量
   ├─ FragmentMgr* _fragment_mgr              ── 查询执行管理器
   ├─ BackendServiceClientCache _backend_client_cache  ── Thrift 客户端缓存
   ├─ LoadChannelMgr* _load_channel_mgr       ── 导入通道
   ├─ StorageEngine* _storage_engine          ── 存储引擎
   ├─ 10+ MemTrackerLimiter (orphan/segcompaction/s3_file_buffer/...)
   ├─ 6 个 ThreadPool (send_batch/prefetch/s3_upload/...)
   ├─ TaskScheduler* _without_group_task_scheduler  ── Pipeline 调度
   └─ WorkloadGroupManager / WorkloadSchedMgr
   │
   ▼ 内存追踪
MemTracker (runtime/memory/mem_tracker.h:48)
   └─ MemTrackerLimiter final (mem_tracker_limiter.h:67)
        ├─ Type: GLOBAL/QUERY/LOAD/COMPACTION/SCHEMA_CHANGE/OTHER (:66)
        ├─ limit_exceeded() (:106)  ── _limit 检查
        ├─ try_consume(bytes) (:108)  ── CAS 检查 limit
        ├─ free_top_memory_query() (:167)  ── GC 取消大内存查询
        └─ mem_tracker_limiter_pool (:178) (1000 组分桶降锁争用)
   │
   ▼ 查询状态
RuntimeState (runtime/runtime_state.h:66)
   ├─ _exec_env / _query_mem_tracker
   └─ init_mem_trackers() (runtime_state.cpp:85)
   │
   ▼ 文件系统抽象
FileSystem (io/fs/file_system.h:66) ── Strategy 基类
   ├─ LocalFileSystem (local_file_system.h:33)
   └─ RemoteFileSystem (remote_file_system.h:34)
        ├─ BrokerFileSystem / S3FileSystem / HdfsFileSystem
        └─ FILESYSTEM_M 宏 (:34)  ── bthread 检测→AsyncIO 切换
```

## 调用链路

BE 启动 → ExecEnv 初始化（`exec_env_init.cpp:147`）：

```
ExecEnv::init() → _init() (exec_env_init.cpp:147)
  ├─ init_doris_metrics()
  ├─ _external_scan_context_mgr / _vstream_mgr / _result_mgr = new ...
  ├─ _backend_client_cache = new BackendServiceClientCache(...)
  ├─ ThreadPoolBuilder("SendBatchThreadPool").build(&_send_batch_thread_pool)  ── 6 线程池
  ├─ init_pipeline_task_scheduler() (:308)  ── TaskScheduler + BlockedTaskScheduler + RFTimerQueue
  ├─ _fragment_mgr = new FragmentMgr(this)  (:224)
  ├─ _load_channel_mgr = new LoadChannelMgr()
  ├─ _init_mem_env() (:381)
  │    ├─ HeapProfiler::create_global_instance()
  │    ├─ init_mem_tracker()  ── 10+ 全局 MemTrackerLimiter
  │    ├─ init_hook()  ── TCMalloc hook（USE_MEM_TRACKER）
  │    ├─ CacheManager::create_global_instance()
  │    ├─ _storage_page_cache = StoragePageCache::create_global_cache(...)
  │    ├─ _row_cache / _segment_loader / _schema_cache / _inverted_index_searcher_cache
  │    └─ _orc_memory_pool / _arrow_memory_pool
  ├─ _storage_engine = new StorageEngine(options); _storage_engine->open(); start_bg_threads()  (:286)
  └─ _s_ready = true

查询内存注册：
  RuntimeState 构造 (runtime_state.cpp)
    → _query_mem_tracker = query_mem_tracker ?? ctx->query_mem_tracker ?? init_mem_trackers()
  SCOPED_ATTACH_TASK(query_mem_tracker) (thread_context.h)
    → ThreadMemTrackerMgr::attach_limiter_tracker(query_mem_tracker)
  [malloc] TCMalloc hook → ThreadMemTrackerMgr::consume(bytes)
    → _limiter_tracker->cache_consume(bytes)  ── _untracked_mem 累积, 超阈值 flush
    → [limit_exceeded] free_top_memory_query  ── GC
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `ExecEnv.GetInstance` | 获取单例 | static 局部变量，raw pointer 存管理器 |
| `ExecEnv._init` | 装配 50+ 管理器 | 按依赖序创建，destroy 逆序销毁 |
| `MemTrackerLimiter.try_consume` | 带限消费 | CAS 检查 limit，overcommit 模式可控 |
| `MemTrackerLimiter.free_top_memory_query` | GC 取消查询 | 按内存用量从大到小取消 |
| `RuntimeState.init_mem_trackers` | 创建查询 tracker | Type::OTHER，label 含 Id |
| `FileSystem` FILESYSTEM_M 宏 | IO 执行 | bthread 检测，阻塞 IO 切非 bthread 线程 |

</details>

## 核心实现

### ExecEnv 服务定位器

`ExecEnv`（`exec_env.h:120`）单例（`GetInstance()` 返回 static 局部变量，`:143`），50+ 个 inline accessor 对外提供全局服务指针。所有服务 raw pointer 存储（非 unique_ptr）——注释："we choose to use raw pointer...avoid introducing a large number of header files which slow down compilation"。`_init()`（`:147`）按依赖序创建（先 Thrift client cache → LoadChannel → StorageEngine），`destroy()` 用 `SAFE_STOP`/`SAFE_DELETE` 逆序销毁（"StorageEngine must be destoried before _page_no_cache_mem_tracker.reset"）。`#ifdef BE_TEST` 下提供 `set_storage_engine()` 等 setter 允许测试注入。

### MemTracker 层级追踪

`Type` 枚举（`mem_tracker.h:66`）：GLOBAL/QUERY/LOAD/COMPACTION/SCHEMA_CHANGE/OTHER。层级结构：Process（TCMalloc hook 汇总）→ Type::GLOBAL（Orphan + 各专用全局 tracker：SegCompaction/S3FileBuffer/ParquetMeta/...）→ Type::QUERY/LOAD/COMPACTION（每任务一个 `MemTrackerLimiter`）。

`MemTrackerLimiter`（`mem_tracker_limiter.h:67`）`final` 继承 `MemTracker`，增加 limit + GC。`try_consume`（`:108`）CAS 检查 limit（overcommit tracker 受 `enable_query_memory_overcommit` 控制）。`free_top_memory_query`（`:167`）按内存用量从大到小取消 Query 释放内存。`mem_tracker_limiter_pool`（`exec_env.h:178`）固定 1000 组，每组 `list<weak_ptr<MemTrackerLimiter>>` + 独立锁，分桶降锁争用。

**Orphan 兜底**：未 attach tracker 的线程默认计入 Orphan（`exec_env.h:359-364` 注释），保证任何线程内存分配不丢失追踪，Orphan consumption 应接近 0。`cache_consume`（`mem_tracker_limiter.h:230`）+ `_untracked_mem` 原子累积，超 `mem_tracker_consume_min_size_bytes` 才 flush，避免每次 malloc 原子写。

### FileSystem 多后端抽象 + bthread 兼容

`FileSystem`（`io/fs/file_system.h:66`）Strategy 基类，`FileSystemType` 枚举（`:52` LOCAL/S3/HDFS/BROKER）。继承层级：`LocalFileSystem`（final，`local_file_system.h:33`）+ `RemoteFileSystem`（中基，`remote_file_system.h:34`，增加 `connect_impl`/`upload_impl`/`download_impl`）→ `BrokerFileSystem`/`S3FileSystem`/`HdfsFileSystem`。

`FILESYSTEM_M` 宏（`file_system.h:34`）是核心设计：检查 `bthread_self() == 0`，若在 bthread 中则 `AsyncIO::run_task(task, _type)` 切换到非 bthread 线程执行——避免阻塞 IO 卡住 bthread 调度。`FileFactory`（`file_factory.h:65`）`create_file_reader()`（`file_factory.cpp:122`）按 `system_type` switch 分发到各后端 reader。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `ExecEnv::GetInstance` in `exec_env.h:143` | 50+ 管理器统一生命周期，避免 static init fiasco |
| Memory Tracker 层级 | `MemTracker.Type` + `mem_tracker_limiter_pool` in `mem_tracker.h:66` | 防进程 OOM，按类型隔离 GC |
| Strategy | `FileSystem` + `FileFactory` in `io/fs/file_system.h:66` | 统一 API，执行层不感知后端差异 |
| bthread 兼容 | `FILESYSTEM_M` 宏 in `file_system.h:34` | 阻塞 IO 切非 bthread 线程，不卡调度 |

## 模块间交互

`runtime` 被 158 个源文件 import，覆盖 `agent/`/`exec/`/`http/`/`olap/`/`pipeline/`/`vec/`/`service/`/`common/` 全模块——`ExecEnv` 是所有模块的依赖入口。`io/fs/` 被 60 个源文件 import，主要消费方：`olap/`（读 Segment 文件）、`vec/exec/scan/`（外表扫描）、`vec/exec/format/`（Parquet/ORC）、`runtime/stream_load/`。`common/config.h`（1571 行）定义 BE 全部配置项，`exec_env_init.cpp` 大量引用初始化参数。

## 扩展方式

**新增一种 FileSystem 后端**（如 Azure Blob）：新建 `be/src/io/fs/azure_file_system.h` 继承 `RemoteFileSystem`，实现 `create_file_impl`/`delete_file_impl`/`exists_impl`/`file_size_impl`/`list_impl`/`connect_impl`/`upload_impl`/`download_impl` 等；新建 `azure_file_reader.cpp`/`azure_file_writer.cpp` 实现 `FileReader`/`FileWriter`；在 `io/file_factory.cpp` 的 `create_file_reader()`（`:122`）加 `FILE_AZURE` 分支；在 `file_system.h:52` 的 `FileSystemType` 枚举加 `AZURE`；在 `file_factory.h:110` 的 `convert_storage_type()` 加映射；FE 侧 thrift `TFileType`/`TStorageBackendType` 加枚举。对应测试：`be/test/io/`。
