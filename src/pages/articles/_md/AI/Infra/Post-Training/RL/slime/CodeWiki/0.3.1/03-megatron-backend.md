---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "Megatron 训练后端"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "Megatron", "训练后端", "PPO"]
description: "slime 的 Megatron 训练后端：actor 装配、多模型权重切换、PPO 训练步、checkpoint 转换。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview)

---

## 模块定位

`slime/backends/megatron_utils/` 是 slime 的训练引擎支柱（~17k 行）。它原生保留 Megatron 的全部并行能力（TP/PP/DP/CP/EP/VP），不包抽象——Megatron 参数原样读取、模型 provider 直接用 Megatron 的 `GPTModel`。本模块覆盖训练 actor 的装配、PPO 训练步的执行、多模型权重切换（KL 参考模型 / OPD teacher / old_actor）、以及 checkpoint 在 Megatron↔HF 格式间的转换。损失与优势计算的 RL 算法细节见 [RL 算法模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/05-rl-algorithms)，权重同步见 [权重同步模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/04-weight-sync)。

## 模块架构

![Megatron 训练后端组件](/vibe-reading/images/articles/slime-internals/megatron-backend-arch.svg)

`MegatronTrainRayActor`（`actor.py`）是核心，它继承 `TrainRayActor`（`slime/backends/train_actor.py` 基类），持有四类对象：`model` / `optimizer` / `opt_param_scheduler`（Megatron 三件套，由 `initialize_model_and_optimizer` 装配）、`weights_backuper`（`TensorBackuper`，在 CPU 上备份多组权重）、`weight_updater`（按 `update_weight_mode × transport` 选型，见模块 04）。`model_provider.py` 提供模型构造（接 Megatron 的 `GPTModel` 与 `slime_plugins/models` 的模型定义），`initialize.py` / `stateless_adam.py` 处理 Megatron 初始化与无状态优化器，`data.py` 处理训练数据迭代器与 CP 切分，`hf_to_megatron/` 与 `megatron_to_hf/` 做 checkpoint 格式转换（按模型族分发：glm/qwen/deepseek/minimax 等）。

## 调用链路

![train_actor 训练步流程](/vibe-reading/images/articles/slime-internals/train-actor-flow.svg)

`train_actor` 是 PPO 训练步的核心，关键在于**用同一组 Megatron 权重装多个角色**——靠 `TensorBackuper` 在 CPU 上备份的 `actor` / `ref` / `teacher` / `old_actor` 标签间 `_switch_model` 切换，分别跑前向算 log_probs，再切回 actor 算优势与训练。这避免了为 KL 参考模型和 OPD teacher 单独加载模型副本的显存浪费。`can_reuse_log_probs_in_loss` 是一个重要优化：当单微批、policy_loss、无 KL、无 critic、无 OPD、无路由重放、非 GSPO 时，训练前向的 log_probs 可直接复用，省掉一次单独前向。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MegatronTrainRayActor.init` in `actor.py` | 装配 Megatron + 模型/优化器 + weight_updater 选型 | `update_weight_mode × transport` 四路径选型；`TensorBackuper` 多标签备份 |
| `train` in `actor.py` | 入口：wake→取数→train_actor/train_critic→sleep | offload_train 的 wake/sleep 生命周期 |
| `train_actor` in `actor.py` | PPO 训练步 | 三套 log_probs 前向 + advantages + train + backup |
| `train_critic` in `actor.py` | critic 训练 + 返回 old values | `forward_only(get_values)` 先算当前值作 old_values |
| `compute_log_prob` in `actor.py` | 前向算 log_probs | 复用 `get_log_probs_and_entropy`（vocab-parallel） |
| `fill_routing_replay` in `actor.py` | MoE 路由重放录制 | `RoutingReplay` 逐层记录 rollout routed experts |
| `save_model` in `actor.py` | 存 Megatron checkpoint | `async_save` 异步落盘 + 强制 finalize |
| `load_other_checkpoint` in `actor.py` | 加载 ref/teacher/old_actor 权重 | 临时改 args.load 再 `load_checkpoint` |

</details>

## 核心实现

### init 装配与 weight_updater 选型

`MegatronTrainRayActor.init` 是装配中心。它先 `monkey_patch_torch_dist`（slime 对 `torch.distributed` 的补丁，支持 sleep/wake 时销毁/重建 process group），`register_default_process_group`（设超时），再调 Megatron 的 `init(args)` 完成分布式初始化。HF config 与 tokenizer 按节点内 rank 串行读取（`dist.barrier(get_gloo_group())` 防并发写 bug）。`initialize_model_and_optimizer` 装配 Megatron 三件套后，`train_parallel_config` 记录 `dp_size` / `cp_size` / `vpp_size` / `microbatch_group_size_per_vp_stage`，这套配置会回传给 `RolloutManager` 用于 DP 切分。

最关键的是 `weight_updater` 的选型矩阵——直接由 `update_weight_mode`（delta/full）× `update_weight_transport`（disk/nccl/tensor）决定：

```python title="backends/megatron_utils/actor.py"
if update_weight_mode == "delta":           # delta 仅支持 disk
    assert not self.args.colocate, "delta 不支持 colocate"
    assert update_weight_transport == "disk"
    update_weight_cls = UpdateWeightFromDiskDelta
elif update_weight_transport == "disk":     # 全量落盘
    update_weight_cls = UpdateWeightFromDisk
elif self.args.colocate:                    # colocate 走内存
    update_weight_cls = UpdateWeightFromTensor
else:                                       # 分离 + NCCL
    assert update_weight_mode == "full" and update_weight_transport == "nccl"
    update_weight_cls = UpdateWeightFromDistributed
```

这个矩阵是 slime 部署灵活性的核心：colocate 用内存直传最快，分离用 NCCL，跨机型/外部 serving 用磁盘，大模型增量用 delta。`TensorBackuper` 在 init 末尾 `backup("actor")` 存第一份 CPU 备份，`with_ref` / `with_opd_teacher` / `keep_old_actor` 分别触发加载 ref / teacher / old_actor 检查点并存为对应标签。

### TensorBackuper：一组权重装多个角色

`TensorBackuper`（`slime/utils/tensor_backper.py`）在 CPU 上按标签备份/恢复整组权重（`named_params_and_buffers` 产出全局名）。`_switch_model(tag)` 调 `restore(tag)` 把某标签的 CPU 权重载回 GPU 模型，`_active_model_tag` 追踪当前在用角色。PPO 训练步里反复切换：算 ref log_probs 时切 "ref"、算 teacher log_probs 时切 "teacher"、算 old_actor log_probs 时切 "old_actor"、最后切回 "actor" 训练。`ref_update_interval` 控制参考模型定期更新（EMA-style，让 ref 跟上 actor 的缓慢漂移）。`release_train` 模式下还有 "rollout_actor" 标签做队列式更新（`rollout_actor → old_actor`、`actor → rollout_actor`）。

### train_actor：PPO 训练步

`train_actor` 的前向序列（见调用链路 SVG）按依赖顺序排：先 `fill_routing_replay`（MoE 路由重放，把 rollout 的 routed experts 录到 `RoutingReplay` 各层，让训练侧专家路由确定性对齐 rollout，保证 on-policy），再依次算 ref / teacher / old_actor 的 log_probs。`compute_log_prob` 复用 `loss.py` 的 `get_log_probs_and_entropy`（vocab-parallel autograd，见模块 05）。`ROUTING_REPLAY_STAGE` 环境变量分阶段控制：`fallthrough`（ref/teacher 前向时不重放）、`record` / `replay_forward`（录制/重放）、`replay_backward`（反向重放）。

critic values 通过 `external_data` 注入（critic 的 `train_critic` 先 `forward_only(get_values)` 算当前值作 old_values，返回 CPU tensors，再传给 actor 的 `train_actor`）。`compute_advantages_and_returns` 算优势后，可选 `rollout_data_postprocess`（`--rollout-data-postprocess-path` 可插拔）做最后调整，最后 `train()` 走 Megatron 优化器步。结尾 `weights_backuper.backup("actor")` 把训练后的新权重同步到 CPU 备份——这是 `update_weights` 取最新权重的来源。

### checkpoint 格式转换

`hf_to_megatron/` 与 `megatron_to_hf/` 按模型族分发（`glm` / `qwen` / `qwen3_5` / `qwen3_next` / `deepseek` / `llama` / `minimax_m2` / `mimo` 等），处理各模型权重命名与张量布局差异。`megatron_to_hf/processors/` 还有量化后处理（`quantizer_compressed_tensors` 处理 int4/fp4，`padding_remover` 去量化 padding）。`save_model` 时若 `save_hf` 设定，`save_hf_model_to_path` 把 Megatron 权重转回 HF 格式存盘（用于发布或外部 rollout 引擎重载）。`stateless_adam.py` 提供无状态 Adam 优化器变体，配合 `release_train` 每步重建 actor 的场景（优化器状态不依赖长期 actor 生命周期）。

## 扩展方式

新增模型支持：在 `slime_plugins/models/` 加模型定义（见 [插件模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/08-plugins)），在 `hf_to_megatron/` 与 `megatron_to_hf/` 各加一个该模型族的转换器（参考 `glm.py` / `qwen.py`）。`model_provider.py` 通过模型名分发到对应定义。新增训练数据后处理：实现 `(args, rollout_id, rollout_data) -> None` 函数，用 `--rollout-data-postprocess-path` 传入，在 `compute_advantages_and_returns` 之后、`train()` 之前调用。
