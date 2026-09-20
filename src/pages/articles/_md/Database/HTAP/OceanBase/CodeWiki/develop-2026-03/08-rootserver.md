---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "RootServer 集群管理"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "RootService", "DDL", "负载均衡", "bootstrap"]
description: "OceanBase RootServer：内嵌于 sys LS leader 的无状态总控——DDL 任务化轮询推进、unit 多租户资源模型、三层均衡与心跳双线程流水线。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`src/rootserver/`（~35 万行）是集群总控。**RootServer 不是独立进程**：`ObRootService`（`ob_root_service.h:141`）内嵌在每个 observer 里，各类调度服务（DDL、均衡、transfer、心跳、DR）通过 `ObTenantThreadHelper` 家族挂在 MTL 上，**只有收到 `switch_to_leader()` 回调（sys 租户 1 号日志流 Paxos leader 角色变化）才真正 do_work**——"谁是 SYS LS leader 谁当 RS"，RS 唯一性的根权威就是 Paxos 本身，不需要任何外部协调者。核心设计：**RS 无状态，一切调度状态落内部表**（`ob_ddl_scheduler.h:213-216` 注释明说），RS 崩溃/切主不丢任务。

## 模块架构

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `ObRootService` | `ob_root_service.h:141`（300+ RPC 处理） | 集群级单例 + 定时巡检任务队列 |
| `ObDDLScheduler` + `ObDDLTask` | `ddl_task/ob_ddl_scheduler.h:216`、`ob_ddl_task.h:726` | DDL 任务状态机（30+ 任务子类） |
| `ObUnitManager` | `ob_unit_manager.h:46`（505KB cpp） | unit/资源池管理 |
| `ObRootBalancer` / `ObServerBalancer` | `ob_root_balancer.h:54`、`ob_server_balancer.h:25` | unit 级均衡主循环 |
| `ObTenantBalanceService` | `ob_tenant_balance_service.h:67` | LS/分区级均衡（每租户独立服务） |
| `ObTenantTransferService` | `ob_tenant_transfer_service.h:43` | transfer 分区搬移执行 |
| `ObHeartbeatService` | `ob_heartbeat_service.h:33` | 双线程心跳流水线 |
| `ObBootstrap` / `ObPreBootstrap` | `ob_bootstrap.h:88/130` | 集群自举 |
| `ObTenantRoleTransitionService` | `standby/ob_tenant_role_transition_service.h:156` | 主备 switchover/failover |

## 调用链路

### Bootstrap 集群自举

```
ObRootService::execute_bootstrap(arg)              ob_root_service.cpp:1994
└─ ObPreBootstrap::prepare_bootstrap               ob_bootstrap.cpp:229
   ├─ 校验 rs_list / 各 server 为空
   ├─ notify_sys_tenant_server_unit_resource
   ├─ create_sys_ls(SYS_LS, unit_array)            建 1 号日志流
   └─ wait_elect_ls(SYS_LS)                        等 Paxos 选主（30s 超时）
      —— 此后 RS 的全部工作都发生在自己创建出的 SYS LS 之上
└─ ObBootstrap::execute_bootstrap                  ob_bootstrap.cpp:755
   ├─ create_all_core_table_partition              先建 __all_core_table（集群"根目录"，无租户框架可读）
   ├─ set_in_bootstrap / broadcast_sys_schema
   ├─ construct_all_schema                         从 schema_create_func 数组静态构造上千张系统表
   ├─ create_all_partitions                       （RPC 批量建 tablet，128 张/批）
   ├─ create_sys_unit_config/resource_pool/tenant  sys 租户本身也被 unit 模型管理
   └─ add_servers_in_rs_list
└─ do_restart（自举完立刻做一次 RS 全量状态装载）→ finish_bootstrap
```

### 一条 DDL（create index）的完整推进

```
observer 收 SQL → DDL executor → RPC 到 RS
└─ ObIndexBuilder::create_index                   ob_index_builder.h:52
   └─ ObDDLScheduler::create_ddl_task             ddl_task/ob_ddl_scheduler.cpp:1254
      生成 ObDDLTaskRecord 写入 __all_ddl_task_status 内部表
      └─ schedule_ddl_task                        同文件 :3369（表记录反序列化为内存任务入队）
[专用轮询线程]
ObDDLScheduler::do_work                            同文件 :1163
└─ task_queue_.get_next_task → task->need_schedule()（退避检查）
   └─ task->process()                             每轮只推进一步状态
      ObTableRedefinitionTask::process            ob_table_redefinition_task.cpp:1037
      PREPARE → WAIT_TRANS_END → OBTAIN_SNAPSHOT → CHECK_TABLE_EMPTY
      → REPENDING → REDEFINITION → COPY_TABLE_DEPENDENT_OBJECTS
      → MODIFY_AUTOINC → TAKE_EFFECT → SUCCESS
      └─ REDEFINITION 步：ObDDLReplicaBuildExecutor 向各源 tablet 所在
         observer 发 RPC，由 observer 本地补 SSTable（每 tablet 一个
         ObSingleReplicaBuildCtx 小状态机）
[回调 + 恢复]
observer 完成/校验列 checksum → RPC 回 RS → on_sstable_complement_job_reply 推进状态
RS 重启：DDLScanTask（60s）recover_task（读全表 select for update 重新入队）
失活清理：HeartBeatCheckTask（30s）remove_inactive_ddl_task
```

**注意**："每轮 heartbeat 推进 DDL"的说法不成立——推进者是 `do_work` 轮询线程 + observer 回调，heartbeat 只做失活任务清理。

### 三层均衡与 transfer

```
unit 层（server 粒度）：ObRootBalancer::do_balance → ObServerBalancer::try_migrate_unit
   （placement 由 ObUnitPlacementDPStrategy 动态规划决策）
LS 层：ObTenantBalanceService::do_work → ls_balance_ / partition_balance_
   （按 primary zone/unit group 拆建/裁撤 LS，任务落 __all_balance_job/task）
tablet 层：ObBalanceTaskExecuteService → ObTenantTransferService::generate_transfer_task
   └─ rpc_proxy_.start_transfer_task(arg)  ob_tenant_transfer_service.cpp:2228
      RPC 给源 LS leader 的 observer，由 logstream 层执行 transfer
      （START_TRANSFER/COMMIT 日志保证原子性）
```

一次 `alter tenant locality` 的最小代价路径：迁移 unit（不搬数据，日志流跟 unit 走）→ 按新 unit group 拆建 LS → transfer 分区搬数据；每层失败可独立重试，进度都在 job/task 表里可观测。

## 核心实现

### 任务状态机 + 单步非阻塞轮询

`ObDDLTask::process()` 每轮只做一个状态迁移，配合 `calc_next_schedule_ts`（任务越多退避越长）公平调度。防饿死机制：`do_work` 用 `first_retry_task` 标记本轮最早的重试任务，轮到它时直接回队尾不执行——防止反复失败的重试任务独占调度线程（`ob_ddl_scheduler.cpp:1163`）。为什么：一条 DDL 可能跑几天（大表补数据），不能单线程同步等；轮询 + 幂等步骤让任何一步失败都可安全重入，"取消 DDL"只需置标志。`is_error_need_retry`（黑/白名单 + `MAX_ERR_TOLERANCE_CNT=3` 容错计数）；升级期间 `check_conflict_with_upgrade` 直接拒绝新 DDL 任务（`GCONF.in_upgrade_mode()` → OB_NOT_SUPPORTED）。

### rs_epoch 防脑裂

`rs_epoch_`（leader 代次）随每次任务快照；旧代次的内存任务在 `check_and_refresh_status_if_rs_epoch_changed` 中自杀重载——切主期间旧 leader 仍在跑也不会双执行（`ob_ddl_task.h:846`）。

### 心跳双线程 + epoch 白名单

`ObHeartbeatService::do_work`（`ob_heartbeat_service.cpp:160`）：线程 0 `send_heartbeat_` 读 `__all_server` 生成白名单异步发 RPC；线程 1 `manage_heartbeat_` 收响应判定存活并更新内部表。三个 epoch_id 变量防止旧 leader 的响应污染新 leader 的判断——leader 切换期间旧 leader 仍在发心跳。

### DDL 三代并存

`ObDDLService` 直改 schema（轻量 DDL：create database 等一个事务完成）→ `ObDDLHelper`（parallel_ddl/ 模板方法）→ `ObDDLScheduler` + task（重 DDL）。轻 DDL 不为一次 `create database` 付任务表 + 轮询代价；重 DDL 跨 observer 推进必须任务化。

### unit-based 多租户资源模型

`ObUnitManager` 管理 CPU/mem/log_disk 配额进 `__all_unit`；租户 = N 个 resource pool × pool 内 unit 分布在 zone 上。**sys 租户本身也被 unit 模型管理**（bootstrap 也要 `create_sys_unit_config`）——RS 的资源消耗被计费/隔离。均衡、placement、primary zone 全部以 unit group 为原子。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 + 轮询推进 | `ObDDLTask::process`、balance/transfer/DR/switchover 全部同构 | 长任务幂等可恢复 |
| Memento（任务持久化） | `convert_to_record`（`ob_ddl_task.h:796`）+ 各 TaskRecordOperator | RS 无状态的实现基础 |
| 模板方法 | `ObDDLHelper::execute()`（`parallel_ddl/ob_ddl_helper.h:113`：锁对象→生成 schema→算版本→提交） | 各 DDL 类型共享骨架 |
| 策略 | `ObLSBalanceStrategy` 六子类、`ObUnitPlacementStrategy` | 均衡/放置算法可插拔 |
| 观察者/回调 | `ObStatusChangeCallback`（server 生命周期）、`ObRedefCallback` | 集群事件驱动均衡唤醒 |
| 宏代码生成 | `SYS_DDL_SCHEDULER_FUNC`（统一 sys leader 检查 + MTL 切换横切关注） | 消除重复样板 |

## 模块间交互

依赖 share/schema（DDL 落 `__all_ddl_operation` 后广播 schema version，observer 拉版本决定刷新）；通过 `ObSrvRpcProxy/ObCommonRpcProxy` 主动向 observer 发（create tablet、start_transfer_task、DDL build single replica、心跳）。所有调度状态存 sys 租户内表：`__all_server/__all_zone/__all_unit/__all_resource_pool/__all_tenant/__all_ddl_task_status/__all_balance_job(__task)/__all_transfer_task/__all_core_table`。与 logservice 的关系：`ObTenantThreadHelper` 同时实现三个 logservice handler 接口但 replay/flush 全是空实现——**调度状态全部落表，日志流复制器只负责把 role change 事件送上门**。

## 扩展方式

- **新增一种 DDL 任务类型**：`src/share/ob_ddl_common.h` 的 `ObDDLType` 加枚举 → `RS/ddl_task/ob_xxx_task.cpp` 继承 `ObDDLTask`（重写 `init/process/serialize_params_to_message`）→ `create_ddl_task` 与 `schedule_ddl_task` 两处 switch 各加 case（参考最近落地的 `ob_vec_ivf_index_build_task.*`）
- **新增均衡策略**：继承 `ObLSBalanceStrategy`（`ob_ls_balance_helper.h:449` 重写 `balance()`）
- **新增集群巡检项**：仿 `ObSelfCheckTask` 写 `ObAsyncTimerTask` 嵌套类，在 `start_timer_tasks()` 注册
- **新增 alter system 命令**：`ObRootService::admin_*` 系列（`ob_root_service.h:805-841`）
