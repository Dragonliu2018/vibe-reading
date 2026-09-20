---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "日志服务与 Paxos"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "Paxos", "Palf", "日志流", "leader 选举"]
description: "OceanBase 日志服务：Palf 三层接口隔离的 Multi-Paxos 日志库、LogStream 4.0 架构、reconfirm 8 态状态机与按日志类型分发的回放框架。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`src/logservice/` + `src/storage/ls/`（合计 ~28.9 万行）实现复制状态机。**Palf**（Paxos-aligned log file）是自包含的 Multi-Paxos 日志库——只认字节流不解析内容，可独立单测，甚至可换后端做共享日志服务；**LogStream（LS）** 是 4.0 架构的核心抽象：一个租户少量 LS（取代 3.x 每分区一条 clog 流），每 LS 一个 Palf 实例 + 一组 tablet + 事务服务，跨 LS 用 2PC。为什么收敛：百万级 Partition Group 时选举/盘管理爆炸。

## 模块架构

三层接口 + 一层服务（先纠正常见目录误传：**接口层独立在 `ipalf/`，不在 palf/ 内**；选举模块自包含于 `palf/election/`）：

| 层 | 组件 | 文件 |
| --- | --- | --- |
| 接口层 | `IPalfEnv` / `IPalfHandle` | `ipalf/ipalf_env.h`、`ipalf_handle.h`（工厂 `create_palf_env`） |
| 实现接口 | `IPalfEnvImpl` / `IPalfHandleImpl` | `palf/palf_env_impl.h:186`、`palf_handle_impl.h:225` |
| 实现 | `PalfEnvImpl` / `PalfHandleImpl` | `palf_handle_impl.h`（成员即架构图） |
| 服务层 | `ObLogService` / `ObLogHandler` | `ob_log_service.h`、`ob_log_handler.h:80/222` |
| 回放 | `ObLogReplayService` / `ObReplayHandler` | `replayservice/ob_log_replay_service.h`、`ob_replay_handler.h` |
| LS 宿主 | `ObLS` | `storage/ls/ob_ls.h:197`（聚合 log_handler + tablet/tx 服务） |

`PalfHandleImpl` 的成员就是 palf 的架构图（`palf_handle_impl.h:1298-1312`）：`LogSlidingWindow sw_`（滑动窗口）、`LogConfigMgr`（成员管理）、`LogStateMgr`（角色状态机）、`LogReconfirm`（leader 上任日志对齐）、`LogEngine`（IO 引擎）、`election::ElectionImpl`、`LogCache`（fetch 侧读缓存）。PalfEnv 层集中共享基础设施（IO worker、选举定时器、FetchLogEngine）——N 个 LS 不产生 N 套线程。

## 调用链路

### 日志写入（leader 主链路）

```
业务层（事务 ObTxLogAdapter / ID service / dup table…）
└─ ObLogHandler::append_                        ob_log_handler.cpp:899
   ├─ 可选压缩 → role/stop/rate limiter 检查
   └─ palf_handle_->append → PalfHandleImpl::submit_log
      ├─ RLock → check_disk_space_enough → state_mgr_.can_append
      └─ LogSlidingWindow::submit_log           log_sliding_window.cpp:424
         ├─ lsn_allocator_.alloc_lsn_scn()      分配 LSN/log_id/SCN（含块尾 padding）
         ├─ generate_new_group_log_()           组 group log 进 LogGroupBuffer
         ├─ log_engine_ IO（LogIOWorker 异步写盘）
         └─ 复制：log_engine_->submit_push_log_req(dst_member_list, PUSH_LOG)  :858
            follower 侧 receive_log（:3136）按 prev_lsn/prev_proposal_id
            连续性检查后落盘，ack_log 回 ACK
多数派 ACK 后滑动窗口推进 committed_end_lsn → sliding_cb（:2203）
└─ palf_fs_cb_->update_end_lsn                   :2249
   └─ ObApplyFsCb → ObApplyStatus::update_palf_committed_end_lsn
      把连续区间的 AppendCb 弹出执行 on_success（事务回调由此触发）
```

### leader 选举

```
ObLeaderCoordinator（MTL 单例，策略层）
   周期刷新 + 内部表触发 refresh() → 为每 LS 计算选举参考信息（zone 优先级/manual leader…）
   └─ ObLS 注入 priority → palf_handle_->set_election_priority → election_
      ElectionImpl Prepare/Accept 两阶段投票（消息经 ElectionMsgSender → LogNetService）
      [env 级单线程] LogLoopThread::log_loop_    log_loop_thread.cpp:98
      └─ PalfHandleImpl::check_and_switch_state → LogStateMgr::switch_state
         follower → to_reconfirm_（写 PrepareMeta 持久化新 proposal_id）
         └─ LogReconfirm::reconfirm（8 态状态机）
            找 majority_max_log_server_ → 补齐日志 → 重确认 mode_meta
            → 写 START_WORKING → reconfirm_to_leader_active_()
            └─ PalfRoleChangeCbWrapper → ObRoleChangeService::on_role_change
               → RoleChangeEvent 队列 → ObLS 执行上任/卸任（ObLogHandler::switch_role
                  + ObRoleChangeHandler 按注册 sub-handler 分发）
```

### 日志回放（follower）

```
ObLS::enable_replay → ObLogReplayService::enable → ObReplayStatus::enable_   ob_replay_status.cpp:714
└─ fetch_and_submit_single_log_ → ObReplayServiceSubmitTask::get_log         :238
   （IPalfIterator<ILogEntry> 拉模型游标，尾随 accepted_end_lsn 前移）
   └─ do_replay_task_                          ob_log_replay_service.cpp:1288
      ├─ ObLogBaseHeader::deserialize 解出 log_type；barrier 检查（STRICT/PRE 语义）
      └─ ls_adapter_->replay → ls->replay → ObReplayHandler::replay
         （handlers_[type]->replay，ob_replay_handler.cpp:71）
         30+ handler 注册于 ObLS::init（ob_ls.cpp:1149-1232 的 REGISTER_TO_LOGSERVICE）
```

## 核心实现

### Palf 与业务完全解耦

`submit_log` 只收 `buf/buf_len/ref_scn`；业务语义（log base type）在 `ObLogBaseHeader` 由调用方自行序列化，palf 只认 `LogGroupEntryHeader/LogEntryHeader` 两级物理头。为什么：palf 可独立单测、可复用为共享日志服务（`#ifdef OB_BUILD_SHARED_STORAGE` 下同一 `IPalfEnv` 接口可换 `libpalf::LibPalfEnv` 后端，日志服务移出 observer 进程——云上多租户共享日志服务降成本方向）。依赖注入彻底：`PalfFSCb/PalfRoleChangeCb/PalfLocationCacheCb/PalfLocalityInfoCb/PalfReconfigCheckerCb` 全部由 logservice 侧实现，palf 不认识 storage/location service。

### 选举与 Paxos 分层

`ElectionImpl` 独立跑 Prepare/Accept，只产出"谁该当 leader"；Paxos 层 `LogStateMgr` 在 **reconfirm**（8 态：INITED → WAITING_LOG_FLUSHED → FETCH_MAX_LOG_LSN → … → START_WORKING → FINISHED）从多数派最新副本补齐日志后才 ACTIVE——把"选主"与"日志一致性"解耦，保证新 leader 拥有多数派最新日志（经典 Multi-Paxos 优化）。优先级抽象 `ElectionPriority` 带版本化 `compare()`——滚动升级期不同节点优先级结构不同仍可比较；策略全部在 palf 之外演进（V1 实现 26K 行独立演进即是证据）。env 级单线程 `LogLoopThread` 驱动所有 palf 状态机：per-LS 线程在 LS 多时不可扩展，串行化也简化了锁。

### 滑动窗口与两级磁盘阈值

`LogSlidingWindow`（cpp 208K，模块最大文件）：`FixedSlidingWindow<LogTask>` + `LSNAllocator` + `LogGroupBuffer` 环形组缓冲。窗口大小 `PALF_SLIDING_WINDOW_SIZE = 1<<11 = 2048`（必须 2 的幂，`palf/log_define.h:108`）；leader 并发提交上限取窗口一半（`PALF_MAX_LEADER_SUBMIT_LOG_COUNT`）；follower 收到 `log_id - start_log_id >= 2048` 的日志直接拒绝（`can_receive_larger_log_`）——背压窗口。leader 等待窗口槽位就绪时 100us 间隔自旋重试（`leader_wait_sw_slot_ready_`）。

磁盘管理内嵌 `PalfDiskOptionsWrapper`——**回收阈值与停写阈值两套** + SHRINKING 状态机：缩容时只更新 `disk_opts_for_recycling_blocks_`，不可能停止写入时才更新 stopping_writing 那份——先降回收阈值、等回收完成再降停写阈值，避免提前停写（头文件注释完整论述）。块回收由 **replayable point（SCN）驱动而非 LSN**——物理备库/弱读副本的同步进度是 SCN 语义，LSN 无法跨集群比较（`try_recycle_blocks` + `LogGetRecycableFileCandidate`）。

### append 与 apply 分离

palf 提交（多数派持久化）与业务 on_success 执行分离，中间隔 `ObApplyStatus` 16 队列。为什么：提交延迟不传播给回调执行；且支撑"切主时未提交回调"的语义（头文件注释：切主后多数派达成的日志仍调 on_success 而非 replay）。

### AccessMode 与 PalfEpoch

AccessMode 状态机（APPEND/RAW_WRITE/PREPARE_FLASHBACK/FLASHBACK）：主库 APPEND、备库 RAW_WRITE（恢复的日志由 restore service 原样 `raw_write` 进来）、flashback 两段式。`PalfEnvImpl::last_palf_epoch_` 为每个 palf 实例分配递增 epoch——区分"同一个 LS id 的不同 palf 实例"，防止删除重建后旧引用误操作。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 接口隔离 / 门面 | `ipalf::IPalfEnv/IPalfHandle` 三层 | 稳定 API + 可换后端（libpalf） |
| 回调注入 + Wrapper 链表 | `palf_callback.h` 七种纯虚回调、`PalfXxxCbWrapper` 广播 | 切断 palf 的反向依赖 |
| 状态机（三层） | `ElectionImpl` → `LogStateMgr`（role×state）→ `LogReconfirm` 8 态 | 选举/角色/日志对齐各管一段 |
| 适配器 | `ob_ls_adapter.h`、`ob_location_adapter.h` 等七个 Adapter | observer/storage 服务适配成 palf 回调 |
| 注册表 + 宏注册 | `REGISTER_TO_LOGSERVICE`（`ob_log_base_type.h:406`）一次注册 replay/role-change/checkpoint 三处 | 新日志类型三处同步不遗漏 |

## 模块间交互

palf 仅依赖 oblib + share 基础设施（rpc frame、batch RPC、日志盘 DirectIO、IOManager），**没有对 storage/tx 的任何 include**——这是"自包含库"的可验证证据。被调用方：storage/ls（ObLS 持 ObLogHandler）、storage/tx（redo append）、租户级服务（ObTimestampService 等经 log_handler 写日志）。消费方：apply service（主库回调执行）、replay service（follower）、restoreservice（备库日志回补）、archiveservice（归档旁路）、cdcservice/libobcdc（增量外发）。`ObGarbageCollector` 按 LS 状态机推进日志 GC。

## 扩展方式

- **新增一种日志类型（ObLogBaseType）**：`ob_log_base_type.h` 枚举加项（在 `MAX_LOG_BASE_TYPE` 前；编号允许不连续但须单调）→ 实现 `ObIReplaySubHandler`（/`ObIRoleChangeSubHandler`/`ObICheckpointSubHandler`）→ 在 `ob_ls.cpp` 的 `ObLS::init` 中 `REGISTER_TO_LOGSERVICE(XXX, &xxx_handler_)` → 写侧 buffer 首部序列化 `ObLogBaseHeader(type, barrier_type, replay_hint)`
- **新增 palf 配置项**：`palf_options.h` 加字段 → `PalfEnvImpl::update_options` 校验 → 对外走 `ObLogService`（注意 `ob_log_service.h` 注释：log_disk_size 与阈值必须分开更新——unit config 与租户参数两个来源并发更新会互相覆盖）
- **新增 palf RPC**：`log_rpc_packet.h` packet → `log_rpc_proxy.h` proxy → `log_req.cpp` 请求 → `log_request_handler.cpp` / `logrpc/` 处理器 → pcode
