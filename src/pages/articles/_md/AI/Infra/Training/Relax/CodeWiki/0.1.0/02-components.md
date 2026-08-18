---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "组件层"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "Ray Serve", "Actor", "Rollout", "barrier", "deployment"]
description: "解读 Relax 组件层：Base 抽象基类与各角色 run() 模式、Actor 的依赖注入与 barrier 协调、Rollout 的多引擎管理与 OpenAI 兼容 API、Service 部署包装。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/00-overview)

---

## 模块定位

`relax/components/`（3,015 行）是六层架构的组件层，把每个 RL 角色（Actor / Rollout / Critic / ActorFwd / Advantages / GenRM / SFT）封装成独立的 Ray Serve deployment。它向下持有后端 Actor（`MegatronTrainRayActor` / `RolloutManager`），向上被编排层 `Service` 部署与驱动。组件层存在的意义是**故障隔离与弹性调度**：每个角色是独立 Serve replica，一个角色崩溃可单独 restart，且各自有独立 placement group 与 `max_ongoing_requests`。组件类本身不含训练/推理算法，只负责生命周期循环、依赖接收、HTTP 端点暴露与 barrier 协调。

## 模块架构

组件层内部以 `Base` 抽象基类为根，7 个子类按角色语义实现 `run()`。`Base` 定义最小契约（`run` 抽象 + `set_step/get_step/get_status` + `pause/resume/stop` no-op），子类按主循环性质选三种 `run()` 模式之一：**async + 后台线程**（含阻塞同步操作如 `ray.get`/`tq.get`，用 `asyncio.Event` 桥接 Serve 事件循环）、**纯 async Task**（主循环是 `await ...remote()` 的纯 async I/O）、**返回 None**（被动 HTTP 服务，无后台循环）。每个组件用 `@serve.deployment` + `@serve.ingress(app)` 装饰，绑定 FastAPI app 暴露标准端点（`/get_step`/`/set_step`/`/stop_service`）与角色专属端点（Rollout 的 `/scale_out`、`/v1/chat/completions`）。

```
Base (base.py, 177 行)  ← 抽象基类：run()/set_step/get_step/get_status
  │
  ├─ Actor (actor.py, 416)       async+后台线程  训练角色
  ├─ Critic (critic.py)          async+后台线程  PPO 价值角色
  ├─ ActorFwd (actor_fwd.py, 164) async+后台线程 前向-only 角色
  ├─ Rollout (rollout.py, 1001)  纯 async Task   推理角色 + OpenAI API
  ├─ Advantages (advantages.py, 231) to_thread   优势计算（CPU）
  ├─ SFT (sft.py, 489)           async Task      SFT 训练
  └─ GenRM (genrm.py, 354)       返回 None       被动 LLM-as-judge 服务
```

## 调用链路

组件层从被部署到驱动一轮训练的调用链：

```
Service._deploy → serve.run(name=role)                 # service.py:77 部署组件
Controller.run_all_services
  → handle.set_rollout_manager.remote(rollout_manager) # actor.py:107 依赖注入
  → handle.set_barriers.remote(rollout=..., peers=...) # actor.py:124
  → handle.run.remote() → task_ref                     # 并行启动所有角色
      │
      ├─ Actor.run() (actor.py:153)
      │    → asyncio.Event + Thread(_background_run)   # 让出 Serve 事件循环
      │    → _background_run: while step < num_rollout
      │         → _wait_for_rollout_data()             # barrier 等待 + TQ 检查
      │         → _execute_training() → ray.get(actor_model.async_train(step))
      │         → healthy.update_heartbeat.remote("actor", step+1)
      │
      ├─ Rollout.run() (rollout.py:372)
      │    → asyncio.ensure_future(_async_run)
      │    → _async_run: while step < num_rollout
      │         → rollout_manager.generate.remote(step)  # 交 RolloutManager
      │         → rollout_manager.offload.remote()       # 释放 GPU
      │         → staleness/peer_barrier wait
      │
      └─ Advantages.run() (advantages.py:46)
           → asyncio.to_thread(_run_blocking)           # CPU 阻塞放线程
           → while: TQ GET → compute_advantages → TQ PUT
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Base.run` | 抽象入口 | `raise NotImplementedError`，子类自决内部结构（loose contract） |
| `Base._logger` | 懒加载 logger | class-level `_logger_cache` 规避 Ray Serve pickle 不可序列化 logger |
| `Actor.set_rollout_manager` | 注入 rollout_manager + 首次权重同步 | SFT 跳过 init-time sync（会导致 predict 时 onload 崩溃） |
| `Actor.set_barriers` | 存储 rollout/peer barrier | fully_async 时为 None，barrier-guarded 代码短路 |
| `Actor._background_run` | 训练循环 | 后台线程 + `asyncio.Event` 让 Serve 可并发响应 HTTP |
| `Rollout.get_rollout_manager` | 返回 manager handle | 被 Controller 取出注入 Actor |
| `Rollout._async_run` | rollout 循环 | 纯 async，SFT 模式直接 return（被动服务器） |
| `Rollout.scale_out/in` | 弹性扩缩容 HTTP 端点 | fire-and-forget `execute_scale_out.remote()` |

</details>

## 核心实现

### Base 与三种 run() 模式

`Base`（`base.py`）是 legacy 兼容基类，docstring 明确标注 "Legacy base class for backward compatibility"。它只定义 `run()` 为抽象方法（`raise NotImplementedError`），`pause/resume/stop` 为 async no-op，`set_step/get_step/get_status` 提供 step 同步与状态报告。`get_step` 被 `PeerStepBarrier` 依赖——barrier 通过 `handle.get_step.remote()` 轮询 peer 进度，是跨进程状态查询的唯一可靠方式。

`_logger` 属性采用懒加载（`base.py`）：首次访问时 `get_logger(module_name)` 创建并缓存到 class-level `_logger_cache`。这是为规避 Ray Serve pickle 问题——logger 持有 handler/文件句柄等不可序列化对象，在 `__init__` 创建会在 `serve.run` 序列化时失败。子类三种 `run()` 模式的选择原则：主循环含阻塞同步操作（`ray.get`/`tq.get_data`/`time.sleep`）用后台线程 + `asyncio.Event`；纯 async I/O（`await ...remote()`）用 asyncio Task；被动服务返回 None。

```python title="relax/components/actor.py:153（async + 后台线程模式）"
async def run(self) -> None:
    loop = asyncio.get_event_loop()
    self._done_event = asyncio.Event()
    # 后台线程跑训练循环，主协程 await 让出给 Serve 事件循环
    self._thread = threading.Thread(target=self._background_run, daemon=True)
    self._thread.start()
    await self._done_event.wait()  # 阻塞直到线程完成
```

Actor 用线程模式而非纯 async，因为 `_background_run` 含 `ray.get(self.actor_model.async_train(step))`（`actor.py:320`）等阻塞调用，且需让 Serve replica 在长训练循环运行时仍能并发响应 `/get_step`、`/stop_service` 等 HTTP 请求。Rollout 用纯 async Task 因为其主循环 `await self.rollout_manager.generate.remote()` 本身是 async I/O。

### Actor：依赖注入与 barrier 协调

`Actor`（`actor.py`）是训练角色组件，用 `@serve.deployment(max_ongoing_requests=10, max_queued_requests=20)` + `@serve.inggress(app)` 装饰。`__init__`（`actor.py`）调 `allocate_train_group` 创建 `MegatronTrainRayActor` 并 `ray.get(actor_model.async_init(config, role, with_ref, with_opd_teacher))`。`set_rollout_manager`（`actor.py:107`）注入 rollout_manager handle 并在非 fully_async/SFT 模式下触发首次权重同步 `self.actor_model.update_weights()`——SFT 跳过此步，因为 SFT 只在 periodic `/predict` 前 sync，init-time sync 会让 SGLang 恢复 weights 却无后续 offload，导致首次 predict 的 `onload_weights` 崩溃在 non-idempotent `set.remove`。

barrier 协调是 Actor 的核心职责之一。`_wait_for_rollout_data`（`actor.py:245`）先检查 TransferQueue 分区是否含 `train_{step}`，再调 `self._rollout_barrier.wait_offloaded_sync()`（`actor.py:264`）轮询 `rollout_manager.get_status()` 直到 SGLang 完成 offload——确保 SGLang 释放 GPU 显存后 Megatron 才 `wake_up` 占用。PPO colocate 时再调 `self._peer_barrier.wait_completed_round_sync(self.step)`（`actor.py:276`）等 Critic 完成该轮。`_execute_training`（`actor.py:280`）调 `ray.get(actor_model.async_train(step))` 跨模块边界到 backends，完成后 `data_system_client.async_clear_partition` 清理分区、`update_heartbeat` 报活。

### Rollout：多引擎管理与 OpenAI API

`Rollout`（`rollout.py`）是推理角色组件，`__init__` 调 `create_rollout_manager(config, pg, ...)` 创建 `RolloutManager` Ray actor。`_async_run`（`rollout.py:400`）每轮 `rollout_manager.generate.remote(step)` 生成、`offload.remote()` 释放 GPU、staleness/peer_barrier 等待。SFT 模式下 `_async_run` 直接 return（`rollout.py:405`），因为 SFT 的 Rollout 是被动 SGLang HTTP 服务器，由 Actor 的 `/predict` 端点驱动。

Rollout 暴露丰富的 HTTP 端点：标准 `/get_step`/`/set_step`/`/stop_service`，弹性扩缩容 `/scale_out`/`/scale_in`（`rollout.py:661`/`810`，调 `rollout_manager.create_scale_out_request.remote()` + fire-and-forget `execute_scale_out.remote()`），引擎管理 `/engines`/`/recover_rollout_engines`，以及**OpenAI 兼容代理** `/v1/chat/completions`（`rollout.py`）与 `/v1/models`——这让 Relax 的推理服务可直接被 OpenAI SDK 调用。fully_async 模式还暴露 `/can_do_update_weight_for_async`/`/end_update_weight` 供 Actor 询问权重同步时机。

### 心跳与重启协作

两层心跳机制：`Service._start_heartbeat`（`service.py:95`）后台线程每 10 秒 `healthy.update_heartbeat.remote(role, 0)`；组件层每步完成 `healthy.update_heartbeat.remote("actor", step+1)`（`actor.py:230`）。`HealthChecker`（`utils/health_system.py:209`）监控 120s 超时，触发 `on_unhealthy` 回调 → `Controller.restart_serve(role)`。`Service.restart`（`service.py:201`）in-place 重启复用 PG、恢复 step、同步权重、重跑 task；全局重启则由 Controller 接管。HTTP 端点绕过 handle 的设计在此显出价值：`serve.delete` 使 handle 失效后，`_http_call` 仍能通过 HTTP 调 `/stop_service`/`/set_step` 控制新旧 deployment 切换。

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 模板方法（loose contract） | `Base.run` in `base.py:114` | `run()` 是契约入口，内部结构由子类自决，不强加骨架 |
| 部署模式 | `@serve.deployment` + `_deploy` in `service.py:77` | 每角色独立 Serve deployment，HTTP 端点绕过 handle 抗 restart |
| 依赖注入 | `set_rollout_manager`/`set_barriers`/`set_genrm_manager` in `actor.py:107,124` | handle 在部署后才存在，构造期无法传入 |
| 健康检查心跳 | Service 层 + 组件层双层心跳 | 解耦检测与恢复，stale heartbeat 触发 restart |
| 适配器（run 模式） | 三种 run() 实现策略 | 按主循环性质选线程/async Task/None，统一接口适配异构循环 |

## 模块间交互

components 向下依赖 `backends/megatron`（`MegatronTrainRayActor` via `allocate_train_group`）、`backends/sglang`（`SGLangEngine` via `RolloutManager`）、`distributed/coordination`（barrier）、`distributed/ray`（`RolloutManager`/`TrainRayActor` 基类/`create_rollout_manager`）、`engine/sft`（`is_sft_mode`）、`utils`（health/async/logging）。被 `core/Service` 部署、`core/controller` 驱动。交互方式：Ray Serve `handle.remote()`（Controller→Component）、Ray actor `handle.remote()`（Component→backend）、HTTP（Service.restart 绕过 handle + 外部用户调 OpenAI API）、TransferQueue（数据传输）、barrier 轮询（`get_step.remote()`）。详见概览「模块地图」。

## 扩展方式

- **新增角色组件**：`components/` 新建 `class XRole(Base)` + `@serve.deployment`+`@serve.ingress(app)`，实现 `__init__(healthy, pgs, num_gpus, config, role, runtime_env)` 签名与 `async def run()`；`registry.py` ROLES 加常量 + ALGOS 映射；需依赖注入则 `Service` 加 `async def set_xxx` wrapper 并在 `run_all_services` 接线；共享 PG 则改 `ACTOR_ROLLOUT_PG_ROLES`
- **修改权重同步方式**：`actor.py:107` `set_rollout_manager` 的 init-time sync 条件、`actor.py:150` `update_weights_fully_async` 委托、`actor.py:280` `_execute_training` 的 onload 触发
- **修改扩缩容逻辑**：`rollout.py:661`/`810` `scale_out`/`scale_in` 端点 + `distributed/ray/rollout.py` 的 `create_scale_out_request`/`execute_scale_out` 状态机
