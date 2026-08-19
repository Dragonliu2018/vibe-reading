---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "基础设施"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "utils", "分布式", "tracing", "routing replay"]
description: "slime 的基础设施层：参数、分布式、DP 调度、健康监控、tracing、内存与 routing replay。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview)

---

## 模块定位

`slime/utils/`（~9k 行，被全仓 import 125 次，是最高扇入模块）是支撑层。它把"可在 CPU-only CI 单测的纯逻辑"（DP 调度、优势计算、类型、序列长度均衡）与"分布式工程设施"（process group 管理、健康监控、tracing、profiling、内存、参数解析）放在一起。原则是：凡是能脱离 Ray/SGLang/Megatron 独立测的逻辑都写成纯 Python（`dp_schedule.py` 模块 docstring 明确要求"不 import ray/sglang"），其余是跨引擎的工程胶水。`dp_schedule` 与 `health_monitor` 的核心逻辑已在 [Rollout 模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/02-rollout) 讲过，本章覆盖其余子模块。

## 模块架构

![utils 子模块](/vibe-reading/images/articles/slime-internals/utils-arch.svg)

`utils/` 内部按职责分四组：**配置与类型**（`arguments.py` 参数解析、`types.py` `Sample`/`ParamInfo`/`RolloutBatch`、`eval_config.py` 多任务评估配置、`data.py` `Dataset`）；**分布式工程**（`distributed_utils.py` process group、`reloadable_process_group.py` 可重建 PG、`health_monitor.py`、`memory_utils.py`、`disk_delta.py`）；**可观测性**（`timer.py`、`trace_utils.py`、`profile_utils.py`、`tensorboard_utils.py`/`wandb_utils.py`、`metric_utils.py`）；**RL 与数据辅助**（`ppo_utils.py` 见模块 05、`dp_schedule.py`、`seqlen_balancing.py`、`routing_replay.py`、`flops_utils.py`、`processing_utils.py`）。

## 核心实现

### arguments.py：native 透传的参数表面

`parse_args` in `arguments.py`（~2070 行，最大单文件）是 slime 参数透传哲学的集中地。它既解析 slime 自有参数（`rollout_function_path` / `advantage_estimator` / `update_weight_mode` 等），又**原样读取 Megatron 参数**（不包一层 wrapper），还把 `--sglang-` 前缀的参数映射到 SGLang。`parse_megatron_role_args`（`actor.py` 调用）支持 actor/critic 不同 role 从同一 `megatron_config_path` 读不同配置——多模型（actor+critic）并行训练时各自的 Megatron 并行配置可独立。`train_env_vars` 注入训练侧环境变量。这个文件是理解 slime 全部可调旋钮的索引。

### distributed_utils：可重建的 process group

colocate 场景下训练与 rollout 交替占用 GPU，`MegatronTrainRayActor.sleep`/`wake_up` 会销毁/重建 NCCL process group。`reloadable_process_group.py` 提供 `register_default_process_group` / `reload_process_groups` / `destroy_process_groups`，让 WORLD 与子组在 sleep 时全销毁、wake 时按需重建。`get_gloo_group` 提供 CPU 侧 gloo 组（用于 `dist.barrier(group=get_gloo_group())` 这类跨 rank 同步，不依赖 GPU NCCL）。注释提到一个 Megatron 已知坑：PP>2 时 patched batched pipeline P2P 用默认 WORLD 组，wake 后需 `dist.barrier(device_ids=...)` 预热，否则后段 rank 会错过 NCCL 惰性初始化——`SLIME_DESTROY_WORLD_PROCESS_GROUP` 环境变量可控制是否销毁 WORLD（外部代码缓存了 raw `group.WORLD` 引用时设 0）。

### routing_replay：MoE 路由确定性重放

MoE 模型的 RL 有个微妙问题：rollout 时 SGLang 按 expert 路由算的 log_prob，训练侧若让 Megatron 重新路由，expert 选择可能不同 → log_prob 错配 → off-policy 偏差。`routing_replay.py` 的 `RoutingReplay` 在 rollout 侧记录每层每 token 的 routed experts（存进 `Sample.rollout_routed_experts`），训练侧 `MegatronTrainRayActor.fill_routing_replay` 把它们逐层录到 `RoutingReplay.all_routing_replays`，`ROUTING_REPLAY_STAGE` 环境变量控制 fallthrough/record/replay_forward/replay_backward 四阶段，让训练前向/反向按 rollout 路由确定性重放。`use_routing_replay`（训练侧重放）与 `use_rollout_routing_replay`（用 rollout 引擎记录的路由，不训练侧重算）是两个相关但不同的开关。

### timer / trace / profile：可观测性一等公民

slime 把可观测性当工程一等公民。`timer.py` 的 `Timer` + `@timer` 装饰器 + `with_defer`/`inverse_timer` 做细粒度计时（如 `data_preprocess` / `train` / `ref_model_update`）。`trace_utils.py` 用 OpenTelemetry-style span（`trace_span`、`build_sglang_meta_trace_attrs`）追踪 generate 的 SGLang 调用元信息。`profile_utils.py` 的 `TrainProfiler` 跟踪训练步。`metric_utils.py` 算 pass rate / statistics / 重复检测（`has_repetition`，用于检测生成退化）。`docs/en/developer_guide/trace.md` 与 `profiling.md` 文档化这些工具的用法。

### memory_utils 与 disk_delta

`memory_utils.py` 的 `clear_memory` / `print_memory` 是 offload 生命周期的标配调用（sleep/wake/update_weights 前后打印显存）。`disk_delta.py` 是 `UpdateWeightFromDiskDelta` 的小工具集（`make_tensor_reader` 读 HF 张量、`_atomic_write` 原子写 safetensors 防非 POSIX 文件系统读到半写文件）。

## 扩展方式

加新训练参数：在 `arguments.py` 的 `parse_args` 注册，遵循 slime 透传原则——若是 Megatron 原生参数直接复用其解析，若是 SGLang 参数加 `--sglang-` 前缀。加新 metric：`metric_utils.py` 的 `compute_metrics_from_samples` / `compute_perf_metrics_from_samples` 聚合 `Sample` 的 `spec_info`（speculative decoding 接受率）/`prefix_cache_info`（缓存命中），新 metric 从 `Sample` 字段取。`flops_utils.py` 的 `calculate_fwd_flops` 供 `dp_schedule` 的 `balance_by_flops` 估算微批工作量。
