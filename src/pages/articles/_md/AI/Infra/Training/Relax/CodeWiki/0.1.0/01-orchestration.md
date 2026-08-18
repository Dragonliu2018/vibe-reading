---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "编排核心"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "Controller", "Ray Serve", "placement group", "全局重启"]
description: "解读 Relax 编排核心：Controller 训练循环与两阶段全局重启、Service 的 Ray Serve 部署与 placement group 分配、Registry 的 ROLES/ALGOS 算法注册表与 process_role 策略选择。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/00-overview)

---

## 模块定位

`relax/core/`（1,739 行）是六层架构的编排层，回答"整个系统怎么组装、怎么跑起来、崩了怎么从零恢复"。它不含任何训练或推理逻辑，只负责三件事：**注册**（哪些角色参与、用什么算法）、**装配**（为每个角色创建 placement group 与 Ray Serve deployment）、**编排**（驱动训练循环、接线角色间依赖、故障时全局重启）。它是入口层 `train.py` 唯一直接调用的内部模块，也是唯一持有全局视图的层。

## 模块架构

编排层内部三个核心组件分工清晰：`Controller` 是有状态的编排者（持有 `serve_dict`、`HealthManager`、重启状态），`Service` 是无状态的部署包装器（把组件类绑定到 Ray Serve 并管理 placement group），`Registry` 是静态注册表（`ROLES` 枚举 + `ALGOS` 算法映射 + `process_role` 策略）。Controller 在 `__init__` 装配期查 Registry 拿到角色集，为每个角色创建 Service，Service 再 `_deploy` 把组件类部署成 Serve deployment。运行期 Controller 的 `training_loop` 通过 Service 的 handle 驱动各角色 `run()`，并通过 `run_all_services` 注入 rollout_manager / barriers 等跨角色依赖。

```
entrypoints/train.py
        │  main() → Controller(args).training_loop()
        ▼
┌─────────────────────────────────────────────────┐
│ Controller (controller.py, 1107 行)              │
│  ├─ __init__: 数据系统/DCS/metrics/registry/health │
│  ├─ register_all_serve: 查 ALGOS → 创建 Service    │
│  ├─ training_loop: run_all_services + 重启 while   │
│  └─ _global_restart: 两阶段 teardown + re-init     │
└───────────────┬─────────────────────────────────┘
                │ 每角色一个
                ▼
┌─────────────────────────────────────────────────┐
│ Service (service.py, 378 行)                     │
│  ├─ _deploy: cls.bind + serve.run(name=role)      │
│  ├─ _ensure_placement_group: PACK 策略 + GPU 排序  │
│  └─ restart: in-place 复用 PG 恢复 step            │
└───────────────┬─────────────────────────────────┘
                │ cls 来自
                ▼
┌─────────────────────────────────────────────────┐
│ Registry (registry.py, 165 行)                   │
│  ├─ ROLES StrEnum + 8 个场景子枚举                 │
│  ├─ ALGOS: {algo → {role: ComponentClass}}        │
│  └─ process_role(config): 按模式选角色集            │
└─────────────────────────────────────────────────┘
```

## 调用链路

从进程启动到训练步并行运行的调用链（标注文件路径与行号）：

```
main(args)                                          # entrypoints/train.py:108
  → ray.init + serve.start + init_tracking
  → Controller(args, runtime_env)                   # controller.py:118
      → _initialize_data_system()                   # controller.py:243  TransferQueue+sampler
      → create_dcs_deployment()                     # controller.py:141
      → register_all_serve()                        # controller.py:478
          → ALGOS[algo_key] + process_role(config)  # registry.py:141
          → _validate_gpu_resources()               # controller.py:409
          → _create_service_task(role, cls, ...)    # controller.py:385
              → Service(cls, role, pgs, ...)        # service.py:25
                  → _deploy() → serve.run(name=role)# service.py:77
      → HealthManager.start(on_unhealthy, on_fatal) # controller.py:171
  → training_loop()                                 # controller.py:658
      → run_all_services()                          # controller.py:659
          → 接线 rollout_manager/barriers            # controller.py:675-705
          → service.run() 并行 → await task_refs     # controller.py:730-744
      → while True: 异常→_restarting?等重启:raise    # controller.py:752
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Controller.__init__` | 装配所有子系统并注册服务 | `__init__` 可被 `_global_restart` 重入，`hasattr` 守护跨重启保留的字段 |
| `register_all_serve` | 查 ALGOS 创建所有角色 Service | colocate 串行创建保 PG 顺序，fully_async 用 ThreadPoolExecutor 并行 |
| `training_loop` | 驱动 `run_all_services` + 重启循环 | `_restart_done_event` 跨线程同步主线程与 HealthChecker 回调线程 |
| `_global_restart` | 两阶段 teardown + re-init | 严格有序：cancel refs → 关 TQ → 停 async loop → ray.shutdown，否则 C++ 崩溃 |
| `Service._deploy` | 绑定组件类并 serve.run | `route_prefix=f"/{role}"`，HTTP 端点绕过 handle（restart 时 handle 失效） |
| `create_placement_group` | 创建 PACK 策略 PG | 每包 1 GPU + node_group_affinity 自定义标记资源 |
| `process_role` | 按 config 返回角色枚举 | 模式优先级：debug > sft > ppo > hybrid > fully_async > colocate |

</details>

## 核心实现

### Controller：训练循环与全局重启

`Controller` 是进程级单例，生命周期跨越整个训练。`__init__`（`controller.py:118`）按严格顺序装配：先 `resolve_sft_num_rollout` 预填 SFT 步数（必须在 Service 创建前，因为 Service 会 pickle config），再 `_initialize_data_system` 选 TransferQueue sampler——`StreamingTokenBudgetSampler`（fully_async+动态批）、`SeqlenBalancedSampler`（SFT/balance-data）、`GRPOGroupNSampler`（默认 GRPO 分组）三者按模式分流；然后 `create_dcs_deployment` 部署 DCS coordinator，可选部署 metrics/agentic-chat/autoscaler 服务，最后 `register_all_serve` 创建所有角色 Service 并启动 `HealthManager`。

`training_loop`（`controller.py:658`）的 `run_all_services` 协程负责接线与并行启动：先 `rollout_manager = await serve_dict["rollout"].get_rollout_manager()` 取 rollout 管理器 handle，`await serve_dict["actor"].set_rollout_manager(rollout_manager)` 注入 Actor（首次注入时触发初始权重同步 Megatron→SGLang）；colocate 模式下创建 `RolloutOffloadBarrier` 与 `PeerStepBarrier` 注入 actor/critic/rollout（`controller.py:686-705`），fully_async/hybrid 模式跳过接线；最后遍历 `serve_dict` 调 `service.run()` 拿 task_ref，`await` 所有任务并行运行。

```python title="relax/core/controller.py:686"
# Colocate wiring topology:
#   - actor.rollout_barrier: always, so wake_up doesn't collide with SGLang's static KV pool.
#   - critic.rollout_barrier / actor.peer_barrier / rollout.peer_barrier:
#     only when critic is co-hosted (PPO colocate). GRPO has no third GPU claimant.
if _is_colocate(self.config):
    rollout_barrier = RolloutOffloadBarrier(rollout_manager, logger=logger)
    actor_set_kwargs: dict[str, Any] = {"rollout": rollout_barrier}
    if ROLES.critic in self.serve_dict:
        ...  # PeerStepBarrier 接入 actor/critic/rollout 三方
    await self.serve_dict[ROLES.actor].set_barriers(**actor_set_kwargs)
```

外层 `while True` 循环（`controller.py:752`）捕获 `run_all_services` 异常：若 `_restarting` 标志被 HealthChecker 回调线程置位（说明已有重启在进行），主线程 `wait` `_restart_done_event` 阻塞到 `_global_restart` 完成，再 `continue` 用新状态重跑；非重启异常直接 raise 退出。`_max_global_restart`（默认 3）超限后 `os._exit(1)` 强制终止——`raise` 只退主线程，Ray Serve/daemon 线程会使进程存活。

### 全局重启：两阶段 teardown + re-init

`_global_restart`（`controller.py:881`）是 Relax 最精密的容错机制，分两阶段、11 步严格有序 teardown 后调 `self.__init__` 从零重建。teardown 顺序的每一步都有明确的因果约束：

```python title="relax/core/controller.py:959-1019（teardown 关键顺序）"
# 1.2 cancel pending ObjectRefs MUST before ray.shutdown()
#   否则主线程阻塞在 stale ObjectRef stream，ray.shutdown() 触发
#   致命 C++ 崩溃: TryReadObjectRefStream API can be used only when
#   the stream has been created and not removed.
self._cancel_pending_tasks()
# 1.8 shutdown_async_loop MUST before ray.shutdown()
#   AsyncLoopThread 持有 ObjectRefStream watcher，先 shutdown ray 会触碰已销毁 stream
shutdown_async_loop()
# 1.9 杀 router 进程：router 是主进程 daemon 子进程，ray.shutdown() 杀不掉
#   不杀则旧 engine URL 永留 router worker 列表，无尽 Connection refused 告警
stop_launched_routers()
# 1.10 先 serve.shutdown() 再 ray.shutdown()
serve.shutdown(); ray.shutdown(); time.sleep(5)
# Phase 2: re-init 从零
ray.init(runtime_env); serve.start()
self.__init__(config, runtime_env)   # 重建所有子系统
restart_done_event.set()             # 通知主线程
```

Phase 2 调 `self.__init__(config, runtime_env)`（`controller.py:1091`）而非手工逐个重建，保证状态与首启完全一致。关键细节：`restart_done_event` 引用必须在 `__init__` 前保存——`__init__` 会创建新 Event 对象，而主线程等待的是旧 Event；`_global_restart_count` 同理保存（`__init__` 的 `hasattr` 检查只保留首次创建值）。触发条件见 `restart_serve`（`controller.py:827`）：actor 失败（核心服务，所有角色依赖它）、rollout/actor_fwd 失败（权重同步链路紧耦合）、或任意角色重启次数 ≥ 3（深层状态腐败需 clean slate），其余角色走 `Service.restart` in-place 恢复。

### Service：Ray Serve 部署与 placement group

`Service`（`service.py:24`）是组件类与 Ray Serve 之间的无状态包装器。`_deploy`（`service.py:77`）两步：`cls.options(ray_actor_options={"runtime_env": ...}).bind(healthy, pgs, num_gpus, config, role, ...)` 绑定组件类，`serve.run(self.service, name=self.role, route_prefix=f"/{self.role}")` 部署。`route_prefix` 使每个角色暴露 HTTP 端点（如 `/actor/get_step`），restart 流程中 `serve.delete` 会使 handle 失效但 HTTP URL 在新 deployment 部署后立即可用——`Service._http_call`（`service.py:122-149`）因此绕过 handle 直接 HTTP 调用。

`create_placement_group`（`service.py:335`）按 `num_gpus` 创建 `num_gpus` 个 bundle，每个 `{accel_resource: 1, CPU: 1}`，策略 `"PACK"`（所有 bundle 尽量同节点）；若启用 `node_group_affinity` 且设了 `RELAX_INITIAL_NODE_GROUP`，向每包追加 `{node_group}_gpu`/`{node_group}_cpu` 自定义标记资源把 PG 绑到特定 worker group。PG ready 后为每包创建临时 `InfoActor` 探测物理 GPU ID 与节点 IP，按 `sort_key` 排序返回 `(pg, bundle_indices, gpu_ids)`。分配逻辑（`service.py:62-71`）：colocate 传 `actor_rollout_pgs` 复用共享 PG，`num_gpus==0`（CPU 服务如 metrics）返回 `None`，否则独立创建。

### Registry：算法注册表与角色策略

`Registry`（`registry.py`）是静态注册表，无状态。`ROLES` StrEnum（`registry.py:23`）定义 7 个角色（actor/critic/rollout/advantages/reference/actor_fwd/sft），外加 8 个场景子枚举（`ROLES_COLOCATE`/`ROLES_FULLY_ASYNC`/`ROLES_PPO_*` 等）对应不同模式所需角色集。`ALGOS`（`registry.py:83`）是 `dict[str, dict[ROLES, type]]`，把 8 种算法（grpo/gspo/sapo/cispo/reinforce_plus_plus/sft/ppo）映射到「角色→组件类」字典——`process_role` 选角色集，`ALGOS[algo_key]` 选每角色用什么组件类，两者正交。

```python title="relax/core/registry.py:141"
def process_role(config):
    if config.debug_rollout_only: return ROLES_ROLLOUT_ONLY
    if config.debug_train_only:   return ROLES_TRAIN_ONLY
    if getattr(config, "loss_type", None) == "sft": return ROLES_SFT_ONLY
    if getattr(config, "advantage_estimator", None) == "ppo":
        if config.fully_async:
            return ROLES_PPO_FULLY_ASYNC_ON_POLICY if config.true_on_policy_mode else ROLES_PPO_FULLY_ASYNC
        return ROLES_PPO_COLOCATE
    if config.hybrid:     return ROLES_COLOCATE          # hybrid: actor 内部处理 ref/actor_fwd
    if config.fully_async:
        return ROLES_FULLY_ASYNC_ON_POLICY if config.true_on_policy_mode else ROLES
    return ROLES_COLOCATE
```

`process_role` 的模式优先级揭示了一个关键设计：hybrid 模式虽然 actor 内部用 `_switch_model` 处理 ref/actor_fwd，但角色集仍是 `ROLES_COLOCATE`（只需 actor+rollout），真正区别在 `register_all_serve` 的 PG 分配（hybrid 用独立 PG 而非共享）。`register_extra_roles`（`optional_roles.py:44`）作为可选角色插件入口，按 config 条件动态注入 GenRM 与 SFT-rollout。

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 注册表 | `ALGOS` in `registry.py:83` | 新增算法只需注册一行，编排逻辑与算法解耦 |
| 策略 | `process_role` in `registry.py:141` | 按 config 模式标志选角色集，运行时切换 |
| 两阶段重启 | `_global_restart` in `controller.py:881` | 严格有序 teardown 避免 C++ 崩溃，`__init__` 重入保证状态一致 |
| 健康检查回调 | `HealthManager.start(on_unhealthy, on_fatal)` in `controller.py:171` | 解耦检测与恢复，fatal 跳过重启阶梯直接退出 |
| 委托 | `restart_serve` in `controller.py:827` | 核心角色走全局重启、边缘角色委托 `Service.restart` in-place |
| 屏障协调 | `RolloutOffloadBarrier`/`PeerStepBarrier` 注入 in `controller.py:686-705` | colocate 多角色共享 GPU 时协调 offload/onload 时序 |
| 可选角色插件 | `register_extra_roles` in `optional_roles.py:44` | GenRM/SFT-rollout 条件注册，不污染主注册表 |

## 模块间交互

core 是依赖关系的枢纽，向下依赖几乎所有其他层：`distributed.checkpoint_service.coordinator`（DCS 部署）、`distributed.coordination`（barrier）、`agentic.session.service`（chat API 部署）、`engine.sft.bootstrap`（SFT 算法解析）、`utils`（health/async/env/arguments/opd/s3_loader）、`transfer_queue`（外部，sampler 与 init/close）、`components.*`（组件类）。被 `entrypoints/train.py` 调用。交互方式多样：Ray Serve `handle.remote()`（驱动服务）、Ray actor `handle.remote()`（barrier 轮询 `get_step`）、`tq.init/close`（数据系统生命周期）、HTTP（`_http_call` 绕过 handle）。详见概览「模块地图」的依赖关系图。

## 扩展方式

- **新增算法**：`registry.py:83` ALGOS 加条目；若需新角色组合加 `ROLES_X` 枚举 + `process_role` 分支
- **新增角色**：`registry.py:23` ROLES 加常量 + 场景子枚举 + ALGOS 映射；可选角色走 `optional_roles.py`；共享 PG 则改 `ACTOR_ROLLOUT_PG_ROLES`（`controller.py:69`）；需 barrier 接线则改 `run_all_services`（`controller.py:686-705`）
- **修改重启策略**：`controller.py:866` 改全局重启触发条件；`controller.py:123` 改 `_max_global_restart`；`service.py:201` 改 in-place restart 流程
