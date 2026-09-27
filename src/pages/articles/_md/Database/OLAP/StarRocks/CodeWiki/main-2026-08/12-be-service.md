---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "BE 服务与 RPC"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "BE", "brpc", "internal_service", "心跳", "starrocks_main"]
description: "StarRocks BE 进程装配与 RPC 协议矩阵：start_be 启动流水线、PInternalService/LakeService/BackendService/HeartbeatService 分工与错误注入。"
readingTime: "14 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

BE 的"装配车间"与对外协议面：`be/src/service/`（`starrocks_main.cpp` 启动、`internal_service.cpp` 69.7k 行的 brpc 实现）、`agent/`（心跳与任务上报）、`runtime/`（RuntimeState 等执行环境）。它与 [01 FE 骨架](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/01-fe-server) 对称——一侧管 FE 的对象装配，一侧管 BE 的——但多出一整块 RPC 协议矩阵的设计。

## 模块架构

`service/` 下 `service_be/` 子目录是主体实现（`starrocks_be.cpp` 的 `start_be()`），`backend_base.cpp/h` 提供 thrift 转发基类。RPC 服务按协议分四类（见下文矩阵），全部在 `start_be()` 末尾依次拉起。

## 调用链路

### 启动流水线

```text
starrocks_main.cpp main():
  init_tls_thread_status_offset()     # TLS 偏移，供外部 profiler 读 /proc/PID/mem
  register_orc_lzo_decompressor() → gflags 解析 → pid 文件锁（be.pid/cn.pid）
  → config::init(be.conf) → init_roaring_hook() → failpoint/Status 错误注入初始化
  → curl/AWS SDK init → parse_conf_store_paths + check_datapath_rw
    （坏盘可按 ignore_broken_disk 剔除）
  → start_be(paths, as_cn)            # 真正主体在 service_be/starrocks_be.cpp
```

`start_be()` 是**带 step 编号的顺序流水线**：`Daemon::init`（glog/CpuInfo/信号/minidump）→ `BackendOptions::init` → `PlatformEnv/RuntimeEnv/DataCache` → **`init_storage_engine()`**（核心是 `StorageEngine::open`，见 [11 存储](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/11-storage)）→ `ExecEnv`/`ComputeEnv`/`StorageEnv`/`DataWorkflowsEnv`/`OrchestrationEnv` → `AgentServer::start()` → `storage_engine->start_bg_threads()` →（USE_STAROS 时 `init_staros_worker`，即 starlet 集成）→ 依次启动 thrift BackendService（9060）→ brpc（PInternalService+LakeService，8060）→ HttpServiceBE（8040）→ ArrowFlightSQL → heartbeat ThriftServer（9050）→ `while(!process_exit_in_progress()) sleep(1)` 挂起。

退出按**逆序**逐层 stop/destroy/join，每步有 exit step 日志，顺序注释固化依赖（如 AgentServer 必须先于 StorageEngine 停，因其 pool 会提交 storage 清理工作）。

### RPC 协议矩阵

| 服务 | 协议/端口 | 定义 | 用途 |
| --- | --- | --- | --- |
| `PInternalService` | brpc / 8060 | `gensrc/proto/internal_service.proto`（L833-885，实现 `internal_service.cpp`，模板基类 `PInternalServiceImplBase<T>`） | BE↔BE 数据面 + FE↔BE 执行面：`exec_plan_fragment`/`exec_batch_plan_fragments`/`cancel_plan_fragment`（pipeline 执行入口，`_exec_plan_fragment_by_pipeline`）、`transmit_chunk`（向量化 chunk 传输，支持 pipeline level shuffle）、`transmit_chunk_via_http`（大包旁路）、`fetch_data`/`fetch_datacache`、`tablet_writer_open/add_batch/add_chunk(s)/add_segment/cancel`（导入写通道）、`transmit_runtime_filter`、`local_tablet_reader_*`（MultiGet/scan）、`exec_short_circuit`、`stream_load`、`lookup` |
| `LakeServiceImpl` | brpc / 8060（同 Server） | `lake_service.proto` | cloud native 存算分离：`compact`/`publish_version`/`vacuum` 等（设 `MaxConcurrencyOf` 并发上限），见 [07](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data) |
| `BackendService` | thrift / 9060 | `gensrc/thrift/BackendService.thrift`（L151） | 控制面兜底：`submit_tasks`（agent 任务下发）、`make/release snapshot`、`get_tablet_stat`、`submit_routine_load_task`、`finish_stream_load_channel`、`open/get_next/close_scanner`。实现 `BackendServiceBase`（`backend_base.h` 纯转发到 ExecEnv，注释明确 "bind multiple services on single port"） |
| `HeartbeatService` | thrift / 9050 | `gensrc/thrift/HeartbeatService.thrift`（L62；仓库无 heart_service.proto，心跳是 thrift 非 proto） | FE 主动拉心跳 |
| `HttpServiceBE` | HTTP / 8040 | `service_be/http_service.cpp` | Stream Load、brpc 大包旁路（`*_via_http`）、metrics/管理端点 |
| Arrow Flight SQL | `arrow_flight_port` | — | 对外高速列式 SQL 协议 |

### 心跳与状态上报（两条独立通路）

- **心跳（FE 拉）**：`agent/heartbeat_server.cpp` 的 `HeartbeatServer::heartbeat(THeartbeatResult, TMasterInfo)`（L81）——BE 返回 `backend_info`（be_port/http_port/brpc_port/arrow_flight_port/starlet_port、版本、核数、mem limit、reboot_time），校验 cluster id（首个心跳 `init_cluster_id_or_die`）、BE/CN 节点类型匹配、localhost 拓扑检查，接收 `heartbeat_flags` 更新 `HeartbeatFlags`。
- **Agent 上报（BE 推）**：`agent/agent_server.cpp` 的 `AgentServer::Impl` 注册 `ReportDiskStateTaskWorkerPool`（磁盘状态）与 `ReportOlapTableTaskWorkerPool`（tablet 报告，L360-361，worker 在 `task_worker_pool.cpp`，受 `report_disk_state_interval_seconds`/`report_tablet_interval_seconds` 与 `StorageEngine::wait_for_report_notify` 事件触发增量上报），另有 REPORT_WORKGROUP、REPORT_DATACACHE_METRICS；反向接收 FE 的 `submit_tasks`（PUBLISH_VERSION/DELETE/CLONE 等任务，经 `TaskWorkerType` 派发，`finish_task` 回写结果带 `report_version`）。

### Daemon 后台任务

`service/daemon.cpp` 比想象中薄：`Daemon::init`（L348）只起两类线程——`calculate_metrics`（15s：push/query bytes per second、max disk io util、max network traffic，并 dump_memory_tracker）与 `jemalloc_tracker_daemon`（1s 同步 jemalloc metadata 到 MemTracker）；**compaction、memtable flush、垃圾清理等真正周期任务在 `StorageEngine::start_bg_threads()`**，不在 Daemon。另装 SIGTERM/SIGINT handler（`sigterm_handler` L291：退出前 dump 内存统计、starlet shutdown 标记）与 minidump。内存上限保护在 `Daemon::init` 末尾 `set_large_memory_alloc_failure_threshold(MemInfo::physical_mem())`（配合 `mem_hook.cpp` 的 malloc hook 拒绝超大分配）。

## 核心实现

### 模板服务基类与双 service 挂载

`PInternalServiceImplBase<T>`（`service/internal_service.h` L62）+ `BackendInternalServiceImpl`（`service_be/internal_service.h`）两层模板——BE 测试可注入 mock T；brpc 用 `SERVER_DOESNT_OWN_SERVICE` 把 PInternalService 与 LakeService 两个 service 挂到同一 Server。

### 错误注入

- failpoint：`base/failpoint/fail_point.h`，`init_failpoint_from_conf` 读 failpoint.json，可通过 PInternalService 的 `update_fail_point_status/list_fail_point` RPC 动态控制；
- `ENABLE_STATUS_FAILED` 时 `Status::access_directory_of_inject()` 按源码行注入错误；
- glog fatal 时 `failure_handler.cpp` 的 `failure_handler_after_output_log`（L179）+ `google::InstallFailureHandlerAfterOutputLog`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 栈对象生命周期 | `start_be()` 局部 unique_ptr 管理全部 server/env，逆序手动 stop/join/destroy | 顺序约束靠注释固化，显式可审计 |
| 模板服务基类 | `PInternalServiceImplBase<T>` | 测试注入 mock |
| pImpl | `AgentServer::Impl` | 头文件解耦 |
| 转发器 | `BackendServiceBase` 纯转发到 ExecEnv | 协议层不掺业务 |

## 模块间交互

- 执行入口 `exec_plan_fragment` 进 [09 Pipeline](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/09-pipeline) 的 FragmentExecutor；导入写通道 `tablet_writer_*` 服务于 [08 Load](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/08-load) 的 OlapTableSink→DeltaWriter；`LakeService` 承接 [07 存算分离](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data) 的 FE 指挥。
- FE 侧对端是 [04 QE](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/04-qe) 的 `rpc/BackendServiceClient`/`BrpcProxy` 与 [01 骨架](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/01-fe-server) 的 `HeartbeatMgr`。
- storage 打开与后台线程委托 [11 存储](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/11-storage)。

## 扩展方式

**新增一个 FE↔BE brpc 方法**（四处）：① `gensrc/proto/internal_service.proto` 加 message + `service PInternalService` 内加 rpc（proto2，`cc_generic_services=true` 自动生成 stub）；② `be/src/service/internal_service.h/.cpp` 加 handler；③ FE 侧 `fe/fe-core/src/main/java/com/starrocks/rpc/PBackendService.java`（**手工维护的 Java 同步 stub**，另见 `PBackendServiceWithMetrics.java` 包装与 `BrpcProxy.java` 连接管理）加方法 + request/response 的 Java 类；④ 兼容性靠"FE 后升级"滚动升级约定（proto 中 `enable_per_partition_coordinator` 注释即此模式的显式范例）；gen_cpp 由 CMake 的 protobuf 生成步骤产出，无需手改。

**两套 Fragment 执行器的分工**（核实补记；订正原文「21k 行」——`plan_fragment_executor.cpp` 实为 545 行 + .h 247 行，另见其文件头的 Doris lineage 注释，出身即 incubator-doris 的 `runtime/plan_fragment_executor.h`）：

`orchestration/fragment_executor.cpp`（1.1k 行，`orchestration::FragmentExecutor`）是 **pipeline 执行器的 BE 侧封装**，四个入口：① `exec_plan_fragment` 单片 RPC（`internal_service.cpp:620`，`params.is_pipeline=true` 时走此，3.2 起 pipeline 为默认引擎）；② `exec_batch_plan_fragments` 多实例批量 RPC——先 `prepare_global_state()` 建 QueryContext/全局状态，各实例 prepare 并行投递 `pipeline_prepare_pool`；③ `open_scanner` 外部扫描（`ExternalScanOrchestrator` → `QueryOrchestrator::exec_external_plan_fragment`，BE 就地构造 fragment 参数本机执行）；④ pipeline 版 stream load（见下）。

`orchestration/plan_fragment_executor.cpp`（`PlanFragmentExecutor`，火山模型 ExecNode 树拉取 + DataSink）是非 pipeline 旧执行器，**但并非死代码**——两条通路至今活跃：① **stream load 默认路径**：FE `Config.enable_pipeline_stream_load` 默认 **false**（`Config.java:3311`），`streamLoadPut` 返回的计划不盖 `is_pipeline` 章，BE `StreamLoadOrchestrator::_execute_plan_fragment_by_legacy`（`stream_load_orchestrator.cpp:145`）经 `FragmentMgr::exec_plan_fragment` → `FragmentExecState`（内持 `_executor`）执行，`FragmentMgr` 的超时清理/状态上报/runtime filter 接收因而是默认配置下 stream load 的热代码；② **`SCHEMA_TABLE_SINK` 兜底**：FE `UpdatePlanner` 对 SystemTable 目标（如 ANALYZE 写统计表）因 `DataSink.canTableSinkUsePipeline` 返回 false 而强制关 pipeline 发片（`UpdatePlanner.java:143`），BE 在 `internal_service.cpp:627` 落入 `_exec_plan_fragment_by_non_pipeline`，代码注释明言 "SchemaTableSink is not supported on the Pipeline engine … will be removed in the future"。其余 non-pipeline 请求一律拒绝（"non-pipeline engine is no longer supported since 3.2"，批量入口同样只收 pipeline）。
