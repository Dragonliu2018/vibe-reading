---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "Ray 编排层"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "Ray", "编排", "placement group"]
description: "slime 的 Ray 编排层：placement group 资源锁定、训练/rollout 对象装配、训练主循环驱动。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview)

---

## 模块定位

`slime/ray/` 是把 Megatron 训练后端与 SGLang rollout 后端粘到一起的唯一编排层。它不包含训练或生成逻辑本身，而是解决三个工程问题：**GPU 资源如何锁定与排序**、**训练/rollout 对象如何装配**、**训练主循环如何驱动**。它直接使用 Ray 的 placement group 与 actor 抽象，把"colocate 还是分离""offload 换入换出""release_train 每步重建"这些拓扑与生命周期决策集中在一处，让下游的训练/rollout 内核保持纯粹。

## 模块架构

![Ray 编排层组件](/vibe-reading/images/articles/slime-internals/orchestration-arch.svg)

文字上，`slime/ray/` 内部四个组件分工清晰：`placement_group.py` 负责 GPU bundle 的创建、探测与排序，并向外暴露 `create_placement_groups` / `create_rollout_manager` / `create_training_models` 三个装配函数；`actor_group.py` 的 `RayTrainGroup` 是训练侧的 actor 组封装，把一组 `MegatronTrainRayActor`（或自定义 `actor_cls`）包成对外的 `async_train` / `save_model` / `update_weights` / `onload` / `offload` 接口；`rollout.py` 的 `RolloutManager` 是 rollout 侧的 Ray actor 编排者（详见 [Rollout 模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/02-rollout)）；`ray_actor.py` 提供基础 `RayActor` mixin（master addr/port 探测）。组件之间是"装配关系"而非"调用关系"——`train.py` 调用 `placement_group.py` 的装配函数，后者实例化 `RayTrainGroup` 与 `RolloutManager`，二者再各自向下驱动训练/rollout 引擎。

## 调用链路

![训练装配与主循环](/vibe-reading/images/articles/slime-internals/train-loop.svg)

`train.py` 的 `train(args)` 是一次性装配 + 循环驱动的调用链。装配阶段顺序固定：先建 placement group（锁 GPU），再建 rollout manager（起 SGLang 引擎、算 `num_rollout_per_epoch`），再建训练模型（actor + 可选 critic 的 `RayTrainGroup`，触发 `MegatronTrainRayActor.init`），最后首次 `update_weights` 把初始权重推到 rollout。循环阶段每步：`generate`（rollout）→ `async_train`（actor + critic）→ `save_model`（按 `save_interval`）→ `update_weights`（权重回推）→ `eval`（按 `eval_interval`）。`should_run_periodic_action` 用 `rollout_id` 与每 epoch 步数周期化保存与评估。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `create_placement_groups` in `ray/placement_group.py` | 锁定 GPU bundle、按 (nodeIP, gpuID) 排序 | PACK 策略 + `InfoActor` 探测物理 GPU + 确定性排序保证可复现 |
| `_get_placement_group_layout` in `ray/placement_group.py` | 决定 train/rollout GPU 布局 | colocate / 分离 / debug-only / external 四种拓扑 |
| `create_rollout_manager` in `ray/placement_group.py` | 起 `RolloutManager` actor | 1 CPU 0 GPU，NIXL 传输时开 `enable_tensor_transport` |
| `create_training_models` in `ray/placement_group.py` | 建 actor/critic `RayTrainGroup` | 解析 `start_rollout_id`，多模型 megatron_config 按 role 分参数 |
| `RayTrainGroup.async_train` in `ray/actor_group.py` | fan-out train 到所有 worker | `external_data` 可逐 worker 或广播，critic values 回传 |
| `RayTrainGroup.update_weights` in `ray/actor_group.py` | 广播权重 / 全盘重载 | `_full_disk_weight_update_enabled` 走 disk 重载 rollout |
| `RayTrainGroup.release` in `ray/actor_group.py` | kill 重建 actor | `release_train` 每步释放显存 |

</details>

## 核心实现

### Placement Group 装配与拓扑决策

`_create_placement_group` in `ray/placement_group.py` 用 `"PACK"` 策略创建 bundle 组（`{"GPU":1,"CPU":1}` per bundle），并轮询 `pg.ready()` 而非裸 `ray.get`——这是为 autoscaling 集群留的口子：当 bundle 暂时放不下时，每 30s 打印已注册/可用 GPU 数，而不是无输出地挂死。bundle 就绪后用 `@ray.remote(num_gpus=1) class InfoActor` 逐 bundle 探测真实 `(node_ip, gpu_id)`，再按 `sort_key` 排序。

`sort_key` 的设计直击 RL 可复现性：它把 node identifier 尝试解析为 IP（失败则 `gethostbyname`，再失败取字符 ASCII 值），与 `gpu_id` 一起组成排序键，保证同一物理集群下 rank→物理 GPU 的映射是稳定确定的。RL 对此敏感——如果每次启动 rank0 落在不同 GPU 上，分布式通信与权重分片的不确定性会污染可复现性。

```python title="ray/placement_group.py"
def _get_placement_group_layout(args) -> tuple[int, int]:
    actor_num_gpus = args.actor_num_nodes * args.actor_num_gpus_per_node
    if args.debug_train_only: return actor_num_gpus, 0
    if args.rollout_external: ...        # 外部 rollout 引擎
    if args.debug_rollout_only: return args.rollout_num_gpus, 0
    if args.colocate: return max(actor_num_gpus, args.rollout_num_gpus), 0
    return actor_num_gpus + args.rollout_num_gpus, actor_num_gpus
```

`_get_placement_group_layout` 是整个部署拓扑的决策点：`colocate` 时 train 与 rollout 共用 `max(actor, rollout)` 张卡（靠 offload 换入换出显存，return 第二个值为 0 表示 rollout bundle 从 actor 组的 offset 0 起复用）；非 colocate 时 train+rollout 卡数相加、rollout 从 `actor_num_gpus` 偏移起独占。`rollout_external` 表示 serving 由训练作业外部托管。这个函数的返回值直接决定 `create_placement_groups` 里 `rollout_offset` 的切片位置。

### RayTrainGroup：训练 actor 组的统一接口

`RayTrainGroup` in `ray/actor_group.py` 把一组 `MegatronTrainRayActor`（或注入的 `actor_cls`）包成对外接口。`_allocate_gpus_for_actor` 创建 `world_size` 个 actor，逐 rank 用 `PlacementGroupSchedulingStrategy` 绑到 bundle，rank0 先起并通过 `get_master_addr_and_port` 探测地址供后续 rank 用——这是 Megatron 分布式初始化的标准握手。env_vars 里注入两类关键配置：`torch_memory_saver` 的 `LD_PRELOAD`（`offload_train` + megatron 后端时，让训练显存可换入换出到 CPU）、`ENABLE_ROUTING_REPLAY`（actor 角色才开，critic 不做路由重放）。

`async_train` 是循环里被高频调用的方法，返回每个 worker 的 object ref（不等完成），让 actor 与 critic 训练可以重叠：

```python title="ray/actor_group.py"
def async_train(self, rollout_id, rollout_data_ref, external_data=None):
    if isinstance(external_data, list):       # 逐 worker（critic values）
        return [actor.train.remote(rollout_id, rollout_data_ref, external_data=ed)
                for actor, ed in zip(self._actor_handlers, external_data)]
    return [actor.train.remote(rollout_id, rollout_data_ref, external_data=external_data)
            for actor in self._actor_handlers]   # 广播
```

`update_weights` 有两条路径：默认广播 rank0 权重到其他 rank；`_full_disk_weight_update_enabled`（`update_weight_mode==full` 且 `transport==disk`）走全盘重载——先让训练侧 `update_weights`（rank0 落盘），再调 `_reload_rollout_weights_from_disk` 让 rollout 引擎 `pull_weights` + `update_weights_from_disk`。`release`（`release_train` 模式）直接 `ray.kill` 全部 actor 并 sleep 5s，每步重建以彻底释放显存。

### 训练主循环的周期性编排

`train.py` 的 `for rollout_id` 循环里，`should_run_periodic_action` in `slime/utils/misc.py` 用 `rollout_id`、`save_interval`/`eval_interval`、`num_rollout_per_epoch`、`num_rollout` 四个量决定"这一步要不要存/评估"，让保存与评估周期化到 epoch 边界。`offload_train` 是嵌套定义的闭包，按 `actor_trains_this_step` 决定清哪一侧显存。`use_critic` 时前 `num_critic_only_steps` 步只训 critic（warmup critic 再训 actor），这是 PPO 的常见预热。循环结尾强制最后一步 `force_sync` 保存，避免异步保存未落盘就退出。

## 扩展方式

替换训练后端 actor：`RayTrainGroup` 接受 `actor_cls` 参数（默认 `MegatronTrainRayActor`），`create_training_models` 透传。自定义 actor 需实现 `init` / `train` / `save_model` / `update_weights` / `sleep` / `wake_up` / `clear_memory` / `set_rollout_manager` 等方法（参考 `slime/backends/megatron_utils/actor.py` 的 `MegatronTrainRayActor`）。这是接入非 Megatron 训练后端（如 FSDP）的扩展点，但 slime 聚焦 Megatron 路径，该扩展点主要用于实验。
