---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "异步编排"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "RL", "Ray", "Async", "Cell", "Fault Tolerance"]
description: "RayTrainCell 状态机驱动的异步 RL 编排，rollout 与 training 三层解耦，fully-async DataBuffer 生产者-消费者。"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/CodeWiki/0.1.0/00-overview)

---

## 模块定位

这是 Miles 的心脏。它用 `RayTrainCell` 状态机管理每个训练单元的生命周期，用 `RayTrainGroup` 驱动训练循环，用 `RolloutManager` 编排生成。核心设计目标是**让 rollout 与 training 在三个层次上解耦**，并在硬件故障下原地恢复而非重启 job。

## 模块架构

```
miles/ray/
├── train/
│   ├── cell.py              # RayTrainCell — 状态机 + actor 工厂
│   ├── cell_state.py        # CellState 5 状态（Pydantic frozen）
│   ├── group.py             # RayTrainGroup v2（FT 版，含 _refresh_cells）
│   ├── cell_monitor.py      # cell_status 计算（cell + health_checker → CellStatus）
│   └── actor_factory.py     # actor 创建 + concurrency_groups 配置
├── actor_group.py           # RayTrainGroup v1（非 FT 默认路径，FROZEN）
├ rollout/
│   ├── rollout_manager.py   # RolloutManager Ray actor（generate/eval/weight lock）
│   ├── rollout_server.py    # RolloutServer / ServerGroup / ServerEngine
│   ├── train_data_conversion.py   # Sample[] → train dict → DP 分片
│   └── rollout_data_conversion.py # 后处理（flatten/trim/compact 校验）
├── placement_group.py       # GPU bundle 分配 + v1/v2 group 选择
└── train_actor.py           # TrainRayActor 抽象基类
```

## 调用链路

三个入口驱动脚本，由 `asyncio.run()` 启动，对应三种运行模式：

```
train.py (同步 on-policy):
  for rollout_id in range(num_rollout):
    rollout_data = await rollout_manager.generate.remote(rollout_id)   # 阻塞
    await actor_model.train(rollout_id, rollout_data)                  # 阻塞
    await actor_model.update_weights(rollout_id=rollout_id)            # 每轮同步

train_async.py (1-step prefetch):
  rollout_data_next = rollout_manager.generate.remote(start)           # 预取第 0 轮
  for rollout_id in range(start, num_rollout):
    rollout_data_curr = await rollout_data_next_future                 # 等上一轮预取
    rollout_data_next_future = rollout_manager.generate.remote(id+1)   # 立即启下一轮
    await actor_model.train(rollout_id, rollout_data_curr)
    if (id+1) % update_weights_interval == 0:                          # 每 N 轮同步
        await actor_model.update_weights(rollout_id=rollout_id)

train_multi_lora_async.py (Multi-LoRA 全异步):
  while True: ...                                                       # 适配器驱动循环
```

异步模式时间线（rollout 与 training 重叠）：

```
Rollout:  │== generate(0) ==│== generate(1) ==│ pause │== generate(2) ==│
Train:                        │== train(0) ==│            │== train(1) ==│
UpdateW:                                        │== update_weights ==│
                ^pre-fetch overlap^      ^drain before weight sync^
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `RayTrainCell.init()` in `cell.py` | 初始化 actor，完成后 mark_as_alive | 工厂延迟创建，init 后挂 health_checker |
| `RayTrainCell.execute()` in `cell.py:92` | 转发调用到所有 actor handles | 失败→mark_as_errored→stop_and_confirm_dead |
| `RayTrainGroup.train()` in `group.py:135` | 一次 rollout 训练，含 retry（max 30） | `_refresh_cells` 前置容错检查 |
| `RayTrainGroup.update_weights()` in `group.py:255` | 权重同步到 engines | 只用 first-alive cell（rank-0 主导） |
| `RayTrainGroup._refresh_cells()` in `group.py:332` | 检查并恢复 dead cell | alive cell 发 in-memory checkpoint |
| `RolloutManager.generate()` in `rollout_manager.py` | 生成 rollout 并转训练格式 | 返回 ObjectRef 非阻塞 |
| `RolloutManager.get_updatable_engines_and_lock()` | 获取可更新 engine + 全局锁 | 权重同步前暂停健康监控 |
| `_select_train_group_class()` in `placement_group.py:16` | v1/v2 选择 | `MILES_EXPERIMENTAL_FT_TRAINER` env var |

</details>

## 核心实现

### CellState 状态机

5 个 Pydantic frozen model 表示状态，转换经 `_change_state()` 做受控转换（含 assert 校验合法转换）：

```python title="miles/ray/train/cell_state.py"
class StatePending(StateBase): pass                              # 尚未分配 GPU
class StateAllocatedUninitialized(StateAllocatedBase): pass       # 已分配 actor 未 init
class StateAllocatedAlive(StateAllocatedBase):                    # 已 init 健康运行
    indep_dp_info: IndepDPInfo
class StateAllocatedErrored(StateAllocatedBase):                  # 运行中出错
    indep_dp_info: IndepDPInfo | None
class StateStopped(StateBase): pass                               # 已停止 actor 被 kill
CellState = StatePending | StateAllocatedUninitialized | StateAllocatedAlive | StateAllocatedErrored | StateStopped
```

frozen=True 防止意外修改状态字段——状态转换是整体替换 `self._state` 引用，非原地修改。详见概览的 [状态流图](00-overview#状态流)。

### 三层解耦

| 层次 | 机制 | 代码位置 |
|------|------|---------|
| **Ray ObjectRef 解耦** | `generate.remote()` 返回 ObjectRef 非阻塞，driver 提前发下一轮 | `train_async.py:73-81` |
| **DataBuffer 解耦** | `_worker_loop()` 常驻 asyncio task 持续生产，`_drain()` 消费，`asyncio.Condition` 同步 | `miles/rollout/fully_async_rollout.py:128` |
| **Cell 状态机解耦** | training cell 和 rollout engine 独立 stop/start，`_refresh_cells` 自动恢复 | `group.py:332` |

### 原地恢复（_refresh_cells）

`_refresh_cells()` 在每次 `train()` 开头执行，检测是否有 pending cell 需要恢复：

```
_refresh_cells(rollout_id)
  ├── 检查 pending cells + alive cells → needs_reconfigure?
  ├── bump quorum_id（拓扑版本号）
  ├── allocate_for_pending() → 为 pending cell 分配新 actor
  ├── 协作恢复:
  │   alive cell:  prepare_indep_dp_mode_alive() → reconfigure_indep_dp (重建 NCCL PG) → send_ckpt
  │   healing cell: prepare_indep_dp_mode_healing() → init() → recv_ckpt → reconfigure_indep_dp
  ├── health_checker.resume()
  └── log CellReconfigureEvent
```

关键：training loop **不阻塞等待**恢复完成。`_refresh_cells` 在 train attempt 内部执行，恢复成功则本 attempt 继续；失败则 `retry()` 下一个 attempt（`_RETRY_MAX_ATTEMPTS=30`）。`group.py:347` 断言 `len(snapshotted_alive_indices) > 0`——只要还有至少一个 alive cell 就能继续训练。

### IndepDP（弹性数据并行）

当 `args.indep_dp` 为 True 时，GPU 被切成多个独立 DP cell（每个 cell 内部是完整 TP/PP 组），cell 间通过 torchft `ProcessGroupNCCL` 做梯度 all-reduce。`IndepDPInfo`（frozen dataclass）携带 `cell_index`/`alive_rank`/`alive_size`/`quorum_id`/`alive_cell_indices`——cell 失败后 `_refresh_cells` 重算 `alive_cell_indices` 并 bump `quorum_id`，确保所有 alive cell 看到一致拓扑。`reconfigure_indep_dp_group()`（`indep_dp.py:74`）先 `shutdown()` 旧 PG，再用新 quorum_id 创建新 PG，支持动态成员变更。

### v1 vs v2 分发

`actor_group.py` 的 v1 `RayTrainGroup` 是 FROZEN 的非 FT 默认路径（直接持有 actor handles，无 cell 抽象）；`train/group.py` 的 v2 带 FT cell 状态机。分发由 `placement_group.py:16` 的 `_select_train_group_class()` 根据 `MILES_EXPERIMENTAL_FT_TRAINER` env var 决定。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 状态机 | `cell_state.py` + `cell.py:_change_state` | FT 场景 cell 可随时失败/恢复，状态机确保操作只在合法状态下执行 |
| Actor 模型 | `actor_factory.py:74` `ray.remote(...)(actor_impl)` | Ray actor 提供进程隔离和 GPU 独占 |
| 工厂 | `cell.py:38` `actor_factory: Callable[[], list[ActorHandle]]` | 延迟创建，cell 先 StatePending 存在，需要时才分配 GPU |
| 策略 | `placement_group.py:16` `_select_train_group_class()` | FT 实验性功能，允许稳定路径与实验路径无缝切换 |
| 观察者 | `cell_monitor.py:18` + `health_checker.py` | 健康监测独立 concurrency group，不被训练 collective 阻塞 |
| 模板方法 | `train_actor.py:39` `TrainRayActor` 抽象方法 | 统一 Megatron/FSDP 接口 |

### 为什么 health_checker 挂在 cell 上

精度定位——挂在 cell 而非 group 上，可精确定位哪组 GPU 不健康。`actor_factory.py:77` 为 FT 模式创建 `concurrency_groups={"heartbeat_status": 1, "default": 1, "fault_injector": 1}`——心跳 RPC 在独立 concurrency group，即使训练线程在 NCCL collective 中阻塞，心跳仍能返回。`_refresh_cells` 期间用 `_paused_health_checkers` 暂停所有 checker，避免重配置过程的临时状态被误报。

## 模块间交互

```
miles/ray/train/cell.py
  ├── miles.ray.train.cell_state (CellState)
  ├── miles.utils.ft_utils.control_server.models (CellStatus)
  ├── miles.utils.ft_utils.health_checker (BaseHealthChecker)
  ├── miles.utils.ft_utils.indep_dp (IndepDPInfo)
  └── miles.utils.tracking_utils.structured_log

miles/ray/train/group.py (v2)
  ├── miles.ray.train.actor_factory (allocate_gpus_for_actor)
  ├── miles.ray.train.cell (RayTrainCell)
  ├── miles.backends.megatron_utils.ft.types (TrainStepOutcome)
  ├── miles.utils.ft_utils.indep_dp / health_checker
  ├── miles.utils.audit_utils (event_logger / witness / checksum)
  └── miles.utils.retry_utils (retry)

miles/ray/rollout/rollout_manager.py
  ├── miles.ray.rollout.rollout_server (RolloutServer)
  ├── miles.ray.rollout.train_data_conversion (convert / split_by_dp)
  ├── miles.backends.sglang_utils (SGLang engine/config)
  └── miles.rollout.base_types (call_rollout_fn, RolloutFnInput)
```

`RolloutManager` 是 Ray actor（CPU 节点），不直接与 `RayTrainCell` 交互，而是两层间接：(1) 权重同步时 `RayTrainGroup.update_weights()` → `rollout_manager.get_updatable_engines_and_lock.remote()` 取 engine 列表+锁，train actor 直接与 SGLang engine 通信；(2) cell 启停联动经 `server_cell.py` 的 `get_cell_indexer_of_id_map` 映射 cell_id 到具体 server+group+engine。

## 扩展方式

#### 新增一种 async 调度策略（如 2-step lookahead）

修改 `train_async.py:73-81` 的 prefetch 逻辑，维护 `future_0` 和 `future_1` 两个 ObjectRef；在 `miles/utils/arguments.py` 新增 `--async-lookahead-steps` 参数（当前硬编码为 1）；需配合 `--update-weights-interval` 确保权重同步前所有 prefetch 都 drain。

#### 新增一种训练后端

`miles/ray/train_actor.py` 的 `TrainRayActor` 是抽象基类，新后端需继承并实现 `sleep()`/`wake_up()`/`train()`/`save_model()`/`update_weights()`；`actor_factory.py:62` 加 backend 选择分支；`arguments.py` 的 `--train-backend` choices 加新值；`miles/backends/` 新建后端目录。
