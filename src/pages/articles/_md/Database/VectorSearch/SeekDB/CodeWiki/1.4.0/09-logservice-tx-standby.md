---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "日志事务与热备"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "OceanBase", "palf", "2PC", "物理备库"]
description: "palf 日志格式保留共识裁剪、2PC/GTS 事务栈完整继承、ObRootService 消亡与进程内管理服务、standby 的 gRPC 日志流热备与 promotion 防环协议——单机化的正确性与容灾基座"
readingTime: "32 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

这是 seekdb「降维」最彻底的一层：把 OceanBase 4.x 的分布式基座压成单机形态——**palf 日志格式保留但多副本共识不再发生**、**`ObRootService` 整类删除**（代之以进程内 `ObLocalManagementService`）、**事务/GTS 全套保留**（单机内仍走 2PC + 全局时间戳，事务可跨多个 LS/tablet，只是所有参与者都在本进程）、**新增 `src/standby/` 顶层模块用 gRPC 日志流复制实现热备**（取代 Paxos 多副本容灾，模型更像 PostgreSQL 的 WAL shipping + 级联备 + promotion）。保留与裁剪的分界线只有一个原则：**正确性协议骨架全留，物理分布机制全删**。

## 模块架构

```shell
src/logservice/                    # 日志层四件套
├── palf/                           # Paxos log filesystem 本体（~70 文件）
│   ├── palf_env_impl.{h,cpp}       # 节点上全部日志组的容器（按 log_id open/close）
│   ├── palf_handle.h               # PalfHandle: append/raw_read/seek（含按 SCN seek，迭代器不含未确认日志）
│   ├── log_sliding_window.cpp      # 复制核心状态机（74.8K，palf 内最大实现文件）
│   ├── log_engine / log_storage / log_block_mgr（4MB 块文件） / log_group_buffer（组提交缓冲）
│   └── log_meta_info.h             # Paxos 元数据（member list 等）持久化
├── applyservice/                   # ObLogApplyService: 已提交日志按序回调存储层（memtable apply）
├── replayservice/                  # ObLogReplayService + ObReplayStatus: 备库回放与门控
└── localservice/                   # ObLocalLogHandlerSet: 非 Paxos 的本地日志处理器注册表
                                    #   register_handler(type, handler) + activate/deactivate
                                    #   activate_except(type) ← promotion fence 语义

src/storage/tx/                     # 事务栈（"v4" 全套）
├── ob_trans_service_v4.h           # ObTransServiceV4: start/commit/rollback/savepoint
├── ob_tx_ctx.cpp (222.7K!)         # ObTxCtx: 2PC 状态机主体（全模块最大文件）
├── ob_tx_log / ob_tx_redo_submitter / ob_tx_replay_executor
├── ob_timestamp_service.h / ob_ts_mgr.h / ob_tx_timestamp_waiter.h   # GTS 三件套
└── ob_multi_data_source.h          # MDS: schema/DDL 复用事务日志通道

src/rootserver/                     # 管理面（ObRootService 已不存在）
├── ob_local_management_service.h   # "Process-local management entry point for schema, DDL,
│                                   #  jobs, freeze and recycle-bin work."
├── ddl_task/                       # ObDDLScheduler + ObDDLTask（含 vec/fts 索引任务）
└── freeze/ + ob_partition_creator + fork_table/ + dbms_job/

src/standby/                        # v1.4.0 新增顶层：gRPC 热备
├── standby_module.h                 # pimpl + IStandbyHost 接口 + StandbyConfig
├── ob_standby_bootstrap_service.h   # bootstrap(param, source_end_scn)：用 primary 的 palf::PalfBaseInfo 建sys LS
├── ob_standby_log_sync_service.cpp  # 定时调度日志拉取（embedded 门控）
├── ob_standby_grpc.h                # fetch_log / get_promotion_boundary / 宏块流式恢复
└── standby_module_disabled.cpp      # 编译期可裁剪 stub
```

## 调用链路

```
【主库提交】事务 commit
├─ ObTransServiceV4 → ObTxCtx: redo 本地持久化（经 ObLS::log_handler_ → ObLogHandler → PalfHandle::append）
│    （LogSlidingWindow 组提交批量推进，LSNAllocator 分配 LSN）
├─ prepare/commit 两阶段日志跨参与者推进（协调者 = 事务首个参与者 LS，无中心 XA 协调者）
├─ ObTimestampService 经 palf 日志持久化推进全局 ts（GTS）
└─ ObTxTimestampWaiter: 快照需要未来时间戳时等待 GTS 推进

【备库同步】StandbyModule
├─ bootstrap: fetch_standby_palf_base_info → check_bootstrap_source → create_sys_ls_（对接 palf 格式）
├─ 全量恢复: gRPC streaming 逐层复制——create_ls_view_stream → tablet_info → sstable_info
│    → sstable_macro_info → create_macro_block_stream（★宏块级物理拷贝，向量索引随 SSTable 同步）
├─ 增量: ObStandbyGrpcClient::fetch_log(start_lsn, max_bytes, consume_log) → 本地 local_append
│    → ObStandbySchemaRefreshTrigger 刷新 schema
└─ ObLocalLogHandlerSet::activate/deactivate 做回放门控（promotion fence）

【晋升】promotion
├─ get_promotion_boundary(StandbyPromotionBoundaryRequest)
│    → StandbyPromotionBoundary{ origin_, cutover_scn_, source_chain_[4]{relay_, source_, version_} }
│    （source_chain_ visited 防环；MAX_PROMOTION_BOUNDARY_HOPS = 16 支持级联备）
└─ 身份与路由分离: promotion_node_id_ = trace::UUID::gen()（注释: "SeekDB intentionally uses a
     loopback self address… keep routing and identity as separate concepts"）
```

## 核心实现

### palf：为什么单机还留 Paxos 日志

事务/schema/timestamp/MDS 的 redo 全部以 palf 条目为物理格式，备库也按 `PalfBaseInfo` 对接——改日志格式等于重写地基；**保留格式、裁剪共识**是最小改动路径。`LogSlidingWindow`（Multi-Paxos 滑窗）+ `LogGroupBuffer`（组提交）+ 4MB `LogBlockMgr`（DIRECT IO 块布局）+ `LogThrottle`（流控）这套共识时代的管道在单副本下是纯开销，换来的是崩溃恢复（`clog_checkpoint_scn_` 决定重放边界）与备库复制的正确性。自研而非用 Raft 库的 why（基于代码结构的推断）：Multi-Paxos 批量 + 流水线复制需与组提交缓冲、滑窗、DIO 块布局、流控、校验一体设计，SCN 与 LSN 双寻址（`PalfHandle::seek` 支持按 SCN）供事务/快照消费——开源 Raft 库按「状态机复制」抽象，难以内嵌这些 DB 级优化。

`localservice/ObLocalLogHandlerSet` 是单机化的日志层答案：按 `ObLogBaseType`（FREEZE/DDL/TRANS/TIMESTAMP 等）注册**非 Paxos 的本地日志处理器**，备库模式下日志本地追加（`local_append_enabled_`），promotion 时用 `activate/deactivate`/`activate_except`（排除某类日志的激活，防晋升竞争——git 提交 `334a6f0e` 修的就是这个 fence 竞态）做回放门控。

### rootserver：从集群大脑到本地服务

`grep "class ObRootService"` 在整个 rootserver 目录零命中。上游数千行的集群大脑（unit/zone/server 管理、分区均衡、major freeze 全局调度、RS 租户选举）被替换为：

```cpp title="src/rootserver/ob_local_management_service.h:78"
// Process-local management entry point for schema, DDL, jobs, freeze and recycle-bin work.
class ObLocalManagementService : public query::ObIRootCommandService {
  class ObLoadDDLTask : public common::ObTimerTask;
  class ObDeadlockEventClearTask : public common::ObTimerTask;
  int execute_bootstrap();      // 自举退化为 ObSystemBootstrapService::initialize_system_data() 写本地元数据
  int create_table(const obcall::ObCreateTableArg &arg, obcall::ObCreateTableRes &res);
  int execute_ddl_task(...); int merge_finish(...);   // 合并完成回调
};
```

保留的 RS 职责：**DDL 全套**（`ObDDLScheduler` 调度 `ObDDLTask` DAG——seekdb 的向量/FTS 索引 DDL 任务 `ob_drop_vec_ivf_index_task.h`、`ob_fts_index_build_task.h` 就是这么加的）、**冻结调度**（`freeze/` + `ObRootMinorFreeze`）、**表/分区创建**（无任何 balancer 文件——分区均衡已裁剪）、`ob_ai_model_ddl_service.h`（AI model DDL 管理进管理面）、巡检/dbms_job/fork_table。**RS 与 observer 的关系变为接口化组合**：rootserver 只声明 `ObIRootserverLocalRuntime`/`query::ObIRootCommandService` 接口，observer 在装配期注入实现（`ObServer::init_local_management_service()` 里 `local_management_service_.set_local_command_service(ob_service_)`）——不再是「RS 是 sys 租户」的集群角色。

### 事务：完整保留的 2PC + GTS

单机模式下这套协议仍按分布式语义运行（事务可跨多个 LS/tablet，所有参与者在同进程）：`ObTxCtx` 执行两阶段提交，协调者由事务首个参与者 LS 担任，无中心 XA 协调者（XA 分支事务已随 v1.4.0 裁剪——`ObXACtx` 全库零匹配）；全局一致性快照依赖 GTS：`ObTimestampService` 经 palf 持久化推进、`ObTsMgr` 管理 lease、`ObTxTimestampWaiter` 等待推进（git 提交 `c2e85de57` "[seekdb][transaction] Retry GTS acquisition when not ready" 证明单机下 GTS 活跃）。行级 MVCC 见[存储引擎](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/03-storage-engine)。MDS（`ob_multi_data_source.h`）让 schema/DDL 变更复用事务日志通道。死锁检测（`deadlock_adapter/`）与 ELR（`ob_tx_elr_handler.h`，Early Lock Release）、弱一致读（`ob_weak_read_util.h`）一并保留。

### standby：可插拔的物理热备

```cpp title="src/standby/standby_module.h"
class StandbyModule final {          // pimpl；生命周期由 observer 驱动
  int init(const StandbyConfig &config, IStandbyHost &host);
  int prepare_storage_replay();      // 备库：存储层回放准备
  int start_listener();              // gRPC 监听
  int wait_replay_ready(...);  int wait_metadata_ready();
};
// StandbyConfig{embedded_mode_, rpc_port_, rpc_service_enabled_, promotion_node_id_,
//               boot_role_, bandwidth_throttle_, ...}
```

三要素：**(1) `fetch_log` 定点拉日志**（LSN + SCN 回调消费）；**(2) 流式宏块物理恢复**（LS 视图 → tablet 信息 → SSTable 信息 → 宏块逐层流）——向量索引的 snapshot blob/隐藏表都在 SSTable 宏块里，随物理拷贝整体同步，**故障后 promotion 即可用，不用重建索引**（向量索引是重资产，容灾不能靠重建——这是 seekdb 选物理备库的根本理由）；**(3) promotion boundary 协议**——`source_chain_` visited 防环检测支持级联备（跳数上限 16），身份（`promotion_node_id_`）与路由地址分离（不同主机可能撞 RPC 端口）。独立顶层目录的理由：api 化重构的一环——standby 换了复制协议（gRPC 日志流 + promotion 边界协商）就不再依赖 RS/storage 内部服务，自然获得「pimpl + 独立 proto（`oblib/grpc/standbyservice.proto`）+ `standby_module_disabled.cpp` 可裁剪 stub」的完整模块边界；备库提升不需要任何集群协调者。

### embedded/单机的差异汇总

`--embedded` 模式（详见[进程底座](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/01-observer-runtime)）：无 TCP（本地通道）、`run/seekdb.clients` 锁文件生命周期（最后客户端断开自动退出）、standby RPC 关闭、身份上报 `"embed"`。分布式初始化的「多服务器协商」步骤全部消失：没有 RS 选举、bootstrap 退化为写本地元数据（SQLite + slog/super block）、日志层单副本形态。**保留**：palf 格式与块管理、apply/replay 流水线、2PC/GTS/MVCC/deadlock/MDS、DDL 任务框架、minor freeze、data_plane 的本地并行扫描（`ob_parallel_range_task_planner.cpp`——分区并行 ANN 的本地等价物）。**裁剪**：ObRootService 整类、unit/zone/server 管理、分区均衡、major freeze 全局调度、Paxos 成员变更/选主的实际使用、legacy 分布式执行框架（`init_px_target_mgr()` 残留为实例内 px）、XA、CDC（`src/cdc` 不存在）、Table API、多租户。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 格式保留、实现裁剪 | palf 单副本化 | 正确性地基（redo/crash recovery）不重写，物理机制按需删 |
| 接口反转 | rootserver 的 `ObIRootserverLocalRuntime`、standby 的 `IStandbyHost` | 管理面只声明需求，observer 决定实现——进程内组合取代集群角色 |
| pimpl + 可裁剪 stub | `StandbyModule` + `standby_module_disabled.cpp` | 备库整模块编译期可拔 |
| 回放门控 | `ObLocalLogHandlerSet::activate/activate_except` | promotion fence：晋升瞬间排除特定日志类型的激活，关竞态 |
| visited 链防环 | `StandbyPromotionBoundary::source_chain_` | 级联备的晋升请求要证明不成环 |

## 模块间交互

palf 被 storage（`ObLS::log_handler_`）、tx（GTS/redos）、MDS 消费；向量索引服务以 logservice handler 身份挂进复制/检查点框架（follower 内存重建的通道——见[向量索引体系](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/05-vector-index)）；rootserver 调度 DDL 任务（`ObDDLScheduler` 消费 storage 的 pipeline 产物并回调 `merge_finish()`）；standby 由 observer 装配（`ObServer::init_ob_service()` new `StandbyModule` 填 `StandbyConfig`），rootserver 不参与——**备库提升不需要集群协调**。gRPC/protobuf 基础设施在 `oblib/grpc/`。

## 扩展方式

新增一个「集群级」后台任务（上游改 ObRootService 的时代已终结，v1.4.0 有四个现成模式）：① 管理/DDL 类（需 root 能力）→ `ObLocalManagementService` 内加 `common::ObTimerTask` 子类（参照其内部 `ObLoadDDLTask`/`ObDeadlockEventClearTask`）；② 存储/服务类 → observer 的 `ObUniqueTaskQueue` 或 `ObServerDutyTask`；③ 备库周期任务 → 参照 `ObStandbyLogSyncService`（timer 调度 + `is_scheduled_` 状态 + `embedded_mode_` 门控）；④ DDL 任务型后台作业 → `rootserver/ddl_task/` 新增 `ObDDLTask` 子类注册进 `ObDDLScheduler`（现成范例就是 seekdb 自己的向量/FTS 索引任务）。
