---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "运行时基础设施"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "runtime", "ExecEnv", "RuntimeState", "MemTracker", "doris_main", "brpc", "thrift"]
description: "Doris 1.1.5 运行时基础：ExecEnv 服务定位器单例（30+ 子系统）、RuntimeState per-fragment 状态+四级 MemTracker、RowBatch 旧版 vs vec::Block 新版、doris_main BE 启动、Thrift+brpc+HTTP+心跳四服务。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

本模块由 `be/src/runtime/`（~4.0 万行）、`service/`（~0.25 万行）、`common/`（~0.36 万行）、`env/`（~0.20 万行）组成，是 BE 的共享运行时基础设施：`ExecEnv` 全局对象容器（服务定位器）、`RuntimeState` 查询级状态、`RowBatch`/`Block` 数据容器、`MemTracker` 内存追踪、BE 守护进程入口 `doris_main.cpp`、brpc/Thrift/HTTP/心跳四类服务。跨 exec/olap/vec 共享依赖。

## 模块架构

```
ExecEnv (runtime/exec_env.h:81) ── 全局单例 (GetInstance:90 Meyers)
   ├─ _stream_mgr (DataStreamMgr)        ── 旧行模型数据传输
   ├─ _vstream_mgr (VDataStreamMgr)       ── 向量化 Block 数据传输
   ├─ _result_mgr (ResultBufferMgr)       ── 查询结果缓冲
   ├─ _result_queue_mgr                    ── 外部扫描结果队列
   ├─ _fragment_mgr (FragmentMgr)          ── Plan Fragment 执行管理
   ├─ _mem_tracker (旧进程级) / _process_mem_tracker (新, limit from mem_limit)
   ├─ _orphan_mem_tracker (兜底) / _bthread_mem_tracker
   ├─ _query_pool_mem_tracker (SELECT 祖先) / _load_pool_mem_tracker (LOAD 祖先)
   ├─ _task_pool_mem_tracker_registry
   ├─ _scan_thread_pool / _etl_thread_pool / _send_batch_thread_pool
   ├─ _storage_engine (外部注入) / _load_channel_mgr / _buffer_pool
   ├─ _disk_io_mgr / _tmp_file_mgr / _small_file_mgr / _broker_mgr
   ├─ _internal_client_cache (BrpcClientCache<PBackendService_Stub>)
   ├─ _backend_client_cache / _frontend_client_cache (Thrift)
   ├─ _heartbeat_flags / _master_info
   └─ _stream_load_executor / _routine_load_task_executor
       │
       ▼  per-fragment-instance
RuntimeState (runtime/runtime_state.h)
   ├─ _fragment_instance_id / _query_id / _query_options / _exec_env / _desc_tbl
   ├─ _obj_pool (ObjectPool 自动释放) / _profile (RuntimeProfile)
   ├─ 4 级 MemTracker: _query_mem_tracker→_instance_mem_tracker (旧) + _new_query_mem_tracker→_new_instance_mem_tracker (新)
   ├─ _is_cancelled / _process_status(带锁) / _error_log
   ├─ _num_rows_load_total/_filtered/_bytes_load_total (原子计数, 导入统计)
   ├─ _tablet_commit_infos / _error_tablet_infos (导入)
   ├─ _runtime_filter_mgr / _block_mgr2 (BufferedBlockMgr2) / _resource_pool / _query_ctx
   ├─ init (:150) / init_mem_trackers (:193) / check_query_state (:322) / set_mem_limit_exceeded (:311)
   └─ create_recvr (:167) / append_error_msg_to_file (:366)
       │
       ▼  数据容器（双轨）
RowBatch (runtime/row_batch.h:74) ── 旧行模型: Tuple** _tuple_ptrs + MemPool, serialize→PRowBatch, convert_to_vec_block (:360) 桥接
vec::Block (vec/core/block.h:57) ── 新列式: ColumnsWithTypeAndName (源自 ClickHouse)
       │
       ▼  服务
service/doris_main.cpp:257 ── BE 入口 main
service/BackendService (backend_service.h:68) extends BackendServiceIf ── Thrift 服务
   ├─ _exec_env / _agent_server (AgentServer)
   ├─ create_service (:71) ThriftServer
   └─ exec_plan_fragment/cancel_plan_fragment/transmit_data/fetch_data/open_scanner/get_next/close_scanner/submit_tasks/get_tablet_stat/clean_trash
service/BRpcService (brpc_service.h:33) ── brpc 包装
   └─ start (:43) 注册 PInternalServiceImpl<PBackendService> + 启动
service/PInternalServiceImpl (internal_service.h:34) 模板 extends PBackendService ── brpc RPC 实现
   ├─ _tablet_worker_pool (PriorityThreadPool, Tablet 写入专用)
   └─ transmit_data/transmit_block/exec_plan_fragment/tablet_writer_open/tablet_writer_add_batch/cancel_plan_fragment/fetch_data/merge_filter/apply_filter/fold_constant_expr/hand_shake
```

## 调用链路

BE 启动链路：

```
main() (service/doris_main.cpp:257)
  → signal::InstallFailureSignalHandler (:258)
  → 检查 DORIS_HOME (:271) + PID 文件锁 (:280)
  → config::init(be.conf, true,true,true) (:306) + initCustom(be_custom.conf) (:312)  ── 配置覆盖
  → Env::init() (:317)  ── 文件系统
  → TCMalloc 线程缓存调整 1GB (:322)
  → parse_conf_store_paths + check_datapath_rw (:340)
  → curl_global_init (:367)
  → Daemon::init (daemon.cpp:244) ── init_glog / CpuInfo/DiskInfo/MemInfo / UserFunctionCache / Functions::init / metrics
  → Daemon::start (daemon.cpp:290) ── tcmalloc_gc_thread / memory_maintenance_thread / calculate_metrics
  → ResourceTls::init / BackendOptions::init (:379-380)
  → ExecEnv::GetInstance() (:385) + ExecEnv::init(exec_env, paths) (:386 → exec_env_init.cpp:88 _init)
      → new 30+ 子系统 (DataStreamMgr/VDataStreamMgr/ResultBufferMgr/ClientCache/MemTrackerTaskPool/...)
      → _init_mem_tracker (:181) ── 五级 mem tracker + TCMalloc Hook (init_hook) + StoragePageCache + SegmentLoader + buffer_pool
      → _load_channel_mgr->init / HeartbeatFlags / _register_metrics
  → StorageEngine::open(options, &engine) (:393) ── 打开存储引擎
  → exec_env->set_storage_engine(engine) (:398)
  → engine->set_heartbeat_flags / start_bg_threads (:399-403)  ── Compaction/Flush 后台线程
  → ThriftRpcHelper::setup / BackendService::create_service(be_port, &be_server) (406-411)  ── Thrift 服务
  → BRpcService::start(brpc_port) (419-425)  ── BRPC 服务
  → HttpService::start() (428-435)  ── HTTP (Stream Load)
  → create_heartbeat_server(heartbeat_service_port) (440-456)  ── 心跳服务
  → 主循环 while (!k_doris_exit) (458-478) ── 每秒 refresh mem tracker / logout 过期 task tracker
  → 关闭序列 (481-496): http.stop / brpc.join / heartbeat.stop / be_server.stop / engine.stop / ExecEnv::destroy
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `ExecEnv.GetInstance` | 全局单例 | Meyers 单例 |
| `ExecEnv._init` | 装配 30+ 子系统 | 严格依赖顺序 new，销毁逆序 SAFE_DELETE |
| `RuntimeState.init_mem_trackers` | 4 级 mem tracker | Process→Query→Instance→组件 |
| `RuntimeState.check_query_state` | 查询终止检查 | 内存超限/取消 |
| `PInternalServiceImpl.exec_plan_fragment` | brpc 入口 | 转 fragment_mgr |
| `PInternalServiceImpl.transmit_block` | 列数据传输 | 转 vstream_mgr |
| `BackendService.exec_plan_fragment` | Thrift 入口 | 转 fragment_mgr |
| `BackendService.submit_tasks` | Agent 任务 | 转 agent_server |

</details>

## 核心实现

### ExecEnv 全局容器（服务定位器）

BE 有 30+ 子系统，若各模块直接互持引用则依赖网状不可维护。`ExecEnv`（`exec_env.h:81`）作单一聚合点，网状降星型——所有模块只依赖 `ExecEnv`，经 `ExecEnv::GetInstance()->xxx_mgr()` 获取。**为什么**：初始化顺序集中管控（`exec_env_init.cpp:88-179`）、销毁逆序安全（`:345-384` `_destroy`）、测试可替换（public 构造 `exec_env.h:96`）。C++ 无反射，用单例+getter 编译期确定依赖。

### RuntimeState 4 级 MemTracker

`RuntimeState` 是 per-fragment-instance 状态容器，继承 Impala 设计将查询状态与 ExecNode 解耦——ExecNode 经 RuntimeState 访问查询级信息（mem tracker/profile/error log/timezone）。4 级 MemTracker（`runtime_state.cpp:193`）：Process→Query→Instance→ExecNode/Sink/Sender。**新旧 tracker 并存**（`:216-237`）：`init_mem_trackers` 同时建旧 `MemTracker` 与新 `MemTrackerLimiter`，SELECT 走 `query_pool_mem_tracker`，LOAD 走 `load_pool_mem_tracker`——1.x 向新内存追踪迁移的过渡态。

### BE 单二进制多线程

`doris_be` 单进程启动四类服务：**Thrift**（`be_port`，FE 发起查询执行/取消/数据传输/Agent 任务）、**brpc**（`brpc_port`，BE 间高性能数据传输/Tablet 写入/Plan Fragment）、**HTTP**（`webserver_port`，Web UI/Stream Load）、**Heartbeat Thrift**（`heartbeat_service_port`）。**为什么**：FE-BE 用 Thrift（跨语言，FE 是 Java），BE-BE 用 brpc（更高性能，attachment 零拷贝传大 Block）；Thrift 用 `be_service_threads`、brpc 用 bthread 协程互不阻塞；`tablet_writer_add_batch` 提交独立 `_tablet_worker_pool`（`internal_service.cpp:246`）避免 bthread 被耗尽影响查询。

### MemTracker 内存追踪

层级（`exec_env_init.cpp:181`）：Root→`_process_mem_tracker`（limit from `mem_limit "80%"`）→`_orphan_mem_tracker`（兜底）+`_bthread_mem_tracker`+`_query_pool_mem_tracker`/`_load_pool_mem_tracker`。**TCMalloc Hook**（`:213` `init_hook`）拦截 new/delete 按线程 consume/release tracker。`mem_tracker_consume_min_size_bytes`（默认 1MB）减少原子操作频率。主循环每秒同步 TCMalloc cache（`:466`）。`enable_mem_tracker_cancel_query` 超限经 `check_query_state`→`RETURN_IF_LIMIT_EXCEEDED` 取消查询。

### RowBatch 旧 vs vec::Block 新

`RowBatch`（`row_batch.h:74`）行模型 `Tuple** _tuple_ptrs`+`MemPool`，segmentv1 旧路径，`serialize`→`PRowBatch`。`vec::Block`（`vec/core/block.h:57`）列模型 `ColumnsWithTypeAndName`，segmentv2 新路径。桥接 `RowBatch::convert_to_vec_block`（`:360`）。`internal_service.cpp` 中 `transmit_data`（旧 `_stream_mgr`）与 `transmit_block`（新 `_vstream_mgr`）并行，`ExecEnv` 同时持两者。`enable_storage_vectorization` 默认 true，`transfer_large_data_by_brpc` 默认 false（注释 expect v1.3）——向量化迁移进行中。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `ExecEnv` in `exec_env.h:81` | 网状依赖降星型，集中管控 |
| 单例 | `ExecEnv::GetInstance`/`StorageEngine::instance`/`StoragePageCache`/`SegmentLoader` | 全局唯一 |
| 生命周期管理 | `_init` 顺序 in `exec_env_init.cpp:88`、`_destroy` 逆序 `:345`、RuntimeState 析构 `:132`、`brpc::SERVER_OWNS_SERVICE`、`ClosureGuard` RAII | 严格序，RAII |
| 模板特化 | `get_client_cache<T>` in `exec_env.h:275` | 编译期返回不同 Thrift 客户端缓存 |

## 模块间交互

`exec/olap/vec` 共享依赖 `ExecEnv`。`BackendService`（Thrift）`exec_plan_fragment`→`_exec_env->fragment_mgr()->exec_plan_fragment`（`backend_service.cpp:100`）；`PInternalServiceImpl`（brpc）`transmit_block`→`vstream_mgr`、`tablet_writer_add_batch`→`load_channel_mgr`（`internal_service.cpp:165,256`）；`get_tablet_stat`→`StorageEngine::instance()->tablet_manager()`（`:204`）。`service` 承接 FE 的 Thrift RPC 调 olap/exec，是 FE↔BE 的桥。

## 扩展方式

**新增配置项**：`be/src/common/config.h` 加 `CONF_Int32(max_concurrent_load_tasks, "10")`（可运行时改用 `CONF_mInt32`）；`be/conf/be.conf` 加默认值；代码经 `config::max_concurrent_load_tasks` 引用。**新增 brpc 接口**：`gensrc/proto/internal_service.proto` 定义 `PXxxRequest/Result`+RPC；`internal_service.h` `PInternalServiceImpl<T>` 加方法声明；`internal_service.cpp` 实现（`ClosureGuard` RAII + 经 `_exec_env` 调下游）；若涉 FE 还需 `gensrc/thrift/BackendService.thrift`+`backend_service.h/cpp`。**新增 ExecEnv 子系统**：`exec_env.h` 加成员+getter；`exec_env_init.cpp` `_init` 按 `exec_env_init.cpp:88` 依赖顺序 new；`_destroy` 逆序 `SAFE_DELETE`。
