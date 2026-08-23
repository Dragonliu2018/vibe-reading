---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "运行时基础"
date: "2026-08-23T19:05:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "ExecEnv", "FragmentMgr", "MemTracker", "FileSystem", "服务定位器"]
description: "Doris 3.1.4 运行时基础：ExecEnv god class 服务定位器 + FragmentMgr + 多级 MemTracker + io FileSystem 抽象。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

运行时基础模块由 `runtime/`（~3.4 万行）+ `common/`（~1.3 万行）+ `io/`（~2.4 万行）组成，核心是 `ExecEnv`（`runtime/exec_env.h:143`，BE 的 god class/服务定位器）与 `FragmentMgr`（`fragment_mgr.cpp`，1348 行）。它是跨模块共享的底层：全局单例依赖容器、Fragment 生命周期管理、内存追踪、文件系统抽象。独立成文是因为这些是所有 BE 模块的共享底座——`ExecEnv` 持有的引用被 pipeline/olap/vec/cloud 共用，与具体业务逻辑正交。

## 模块架构

```
ExecEnv (runtime/exec_env.h:143) ── static GetInstance() (:162) 单例
   ├─ storage_engine() (:149) ── BaseStorageEngine 引用
   ├─ vstream_mgr / client_cache (BE/Frontend/Broker) (:178/181/182)
   ├─ 多个 MemTrackerLimiter (:203-231):
   │    orphan / segcompaction / stream_load_pipe / query_cache
   │    block_compression / tablets_no_cache / rowsets_no_cache ...
   ├─ pipeline_tracer_context (:141)
   └─ brpc_iobuf_block_memory_tracker
   │
   ├─ FragmentMgr (runtime/fragment_mgr.cpp) ── exec_plan_fragment 入口
   ├─ Descriptor (runtime/descriptors.h) ── Tuple/Slot 描述符
   ├─ QueryContext / RuntimeState ── 查询级状态
   └─ MemTracker ── 内存追踪层级
   │
io/ ── FileSystem 抽象 (io/fs/)
   ├─ local/mem/s3/hdfs FileSystem
   ├─ file_cache (io/cache/fs_file_cache_storage.h) ── 文件缓存
   └─ BrokerMgr (runtime/broker_mgr.cpp)
```

## 调用链路

BE 启动装配与查询执行入口：

```
daemon.cpp main
  └─ ExecEnv::init (exec_env_init.cpp) ── 装配 god class
       ├─ StorageEngine::open / CloudStorageEngine
       ├─ MemTrackerLimiter 各级创建
       └─ client_cache 初始化
  └─ StorageEngine::start_bg_threads ── Compaction/Flush 后台线程

FE gRPC exec_plan_fragment
  └─ FragmentMgr.exec_plan_fragment (fragment_mgr.cpp)
       └─ new PipelineFragmentContext ── 装配 Pipeline DAG
       └─ TaskScheduler.schedule_task ── 入队执行
  └─ RuntimeState 持查询级状态（含 MemTracker）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ExecEnv::GetInstance` (`:162`) | 取单例 | `static` 局部变量，线程安全初始化 |
| `ExecEnv::storage_engine` (`:149`) | 取存储引擎 | god class 持引用 |
| `FragmentMgr.exec_plan_fragment` | Fragment 入口 | 装 PipelineContext 下发 |
| `ExecEnv::get_client_cache<T>` (`:194`) | 模板取 RPC 缓存 | BE/Frontend/Broker 统一管理 |

</details>

## 核心实现

### ExecEnv 服务定位器

`ExecEnv`（`exec_env.h:143`）是 BE 的进程级单例（`static ExecEnv s_exec_env` + `GetInstance()` `:162`），持有 `StorageEngine`、各 `ClientCache`（Backend/Frontend/Broker RPC `:181-182`）、`MemTrackerLimiter`（`:203-231` 一长串）、`pipeline_tracer_context`。任何模块 `ExecEnv::GetInstance()->xxx()` 即可拿依赖。

设计决策：**为何 BE 也用 god class**——与 FE 的 `Env` 同理：避免到处传参、无 DI 容器。`storage_engine()` 返回 `BaseStorageEngine&`（`:149`），多态支持本地/云引擎切换。代价是 555 行头文件的耦合，4.x 在拆分。

### 多级 MemTracker

`ExecEnv` 持有十多个 `MemTrackerLimiter`（`orphan_mem_tracker`、`segcompaction_mem_tracker`、`stream_load_pipe_tracker`、`query_cache_mem_tracker`、`block_compression_mem_tracker`、`tablets_no_cache_mem_tracker` 等 `:203-231`）。每个 tracker 限一类资源内存上限，查询级 `RuntimeState` 再挂 query/process tracker，形成层级。

设计决策：**为何多级而非单一内存池**——不同子系统内存特征不同（Compaction 突发大、查询缓存稳定、导入 pipe 持续），分级限流避免某类吃光内存拖垮全局；层级使"查询 OOM 只杀该查询不杀进程"。`SCOPED_ATTACH_TASK`（task_scheduler.cpp:78）把任务内存计入对应 tracker。

### FragmentMgr 与查询生命周期

`FragmentMgr`（`fragment_mgr.cpp`，1348 行）是 BE 收 FE `exec_plan_fragment` RPC 的入口，创建 `PipelineFragmentContext` 装配 Pipeline DAG 并下发 `TaskScheduler`。它管理 Fragment→QueryContext 映射、cancel 路由、send_report 回传。`RuntimeState`（查询级状态）持 `MemTracker`、`RuntimeProfile`、描述符表，贯穿整个 Fragment 执行。

### io FileSystem 抽象

`io/fs/` 提供统一 `FileSystem` 抽象，实现 local/mem/s3/hdfs/broker 等，`ExecEnv` 经抽象访问存储而非直接调本地 IO——这使云模式无缝接入对象存储。`io/cache/`（`fs_file_cache_storage.h`）做文件级缓存（缓存热 segment page），`tablets_no_cache_mem_tracker`/`rowsets_no_cache_mem_tracker`/`segments_no_cache_mem_tracker` 三个 tracker 管缓存内存。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `ExecEnv::GetInstance` | 进程单例，简化依赖获取 |
| 模板 | `get_client_cache<T>` (`:194`) | BE/Frontend/Broker 统一接口 |
| 分级限流 | 多级 MemTracker | 按子系统隔离内存，防全局 OOM |
| 抽象工厂 | `FileSystem` 抽象 + 各实现 | 本地/云存储透明切换 |

## 模块间交互

`runtime/` 是 BE 依赖汇聚点：被 `pipeline/`（`TaskScheduler`/`FragmentMgr`）、`olap/`（`StorageEngine` 经 `ExecEnv`）、`vec/`（`FunctionContext`/`MemTracker`）、`cloud/`（`CloudStorageEngine`）共用。`io/` 被 `olap/`（segment 读写）、`vec/io/`（外部格式）、`cloud/`（对象存储）调用。

## 扩展方式

新增一种 FileSystem（如新对象存储）：在 `io/fs/` 加实现（继承 `FileSystem`），在 `ExecEnv` 装配时按配置实例化。新增内存追踪类别：在 `ExecEnv` 加 `MemTrackerLimiter` 字段并在 `exec_env_init.cpp` 初始化。对应测试：`be/test/runtime/`、`be/test/io/`。
