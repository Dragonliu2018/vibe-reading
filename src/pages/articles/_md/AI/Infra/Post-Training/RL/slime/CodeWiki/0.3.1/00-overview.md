---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "Overview"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "RL", "Post-Training", "Megatron", "SGLang", "PPO", "GRPO", "Ray"]
description: "slime 是连接 Megatron 与 SGLang 的 LLM 强化学习后训练框架，本章为整体架构概览。"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.3.1 · **协议** Apache-2.0 · **语言** Python ≥ 3.10 · **代码量** ~40,000 行（`slime` + `slime_plugins`，不含 tests/examples）· **仓库** [GitHub](https://github.com/THUDM/slime)
>
> **解读基线** commit [`41014d1f`](https://github.com/THUDM/slime/commit/41014d1f29e201137fdffce737bb8bac65bc5219)（2026-08-16，`v0.3.1` 之后约 30 个开发提交，开发分支快照）

---

## 总览

### 项目简介

**slime** 是清华大学 THUDM 团队开源的 LLM 强化学习后训练框架（RL post-training），核心定位是把 **Megatron 训练** 与 **SGLang 推理（rollout）** 串成一条显式数据流的 RL 循环。它不是又一个"训练器 + rollout 服务 + agent 框架"的堆叠，而是让训练、rollout、自定义数据生成、奖励计算、verifier 反馈、环境交互全部流经同一条 `训练 → rollout → Data Buffer` 路径。

slime 的设计哲学是 **native by design**——不把 Megatron 和 SGLang 的参数包装进一层抽象，而是直接透传：Megatron 参数原样读取，SGLang 参数通过 `--sglang-` 前缀暴露。这样上游引擎的优化可以零成本接入。同时它 **只选 SGLang 一个 rollout 后端**，刻意不做多后端抽象，从而能直接使用 SGLang 特有的 serving / routing / caching / disaggregation / weight-sync 能力，而不是退回到多引擎的最小公倍数。

这套框架经过了前沿模型训练的完整验证：GLM-5.2 / 5.1 / 5 / 4.7 / 4.6 / 4.5 全系列的 RL post-training 都跑在 slime 上，同时支持 Qwen 系列、DeepSeek V3/R1、Llama 3。它是目前最经过实战检验的开源 RL post-training 框架之一——小到可以理解和扩展，又经过了 SOTA 级模型发布背后的完整训练循环验证。

**项目边界**：slime 聚焦 **Megatron + SGLang 这一条大规模 RL 路径**。它不内置训练算法的研究实现（算法通过配置切换，不另起训练内核），也不做通用 agent 框架（agentic 工作流作为数据生成/奖励 workflow 接入，不分叉训练内核）。

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Megatron-LM | 核心 | 训练后端：模型并行（TP/PP/DP/CP/EP/VP）、优化器、checkpoint |
| SGLang | 核心 | rollout 后端：推理引擎、router、PD 分离、权重更新 |
| Ray | 核心 | 分布式编排：placement group、actor、object store |
| PyTorch | 核心 | 张量计算、autograd、`torch.distributed` NCCL 通信 |
| NumPy | 核心 | DP 调度中的负载统计与选择 |
| safetensors / zstd | 可选 | Delta 权重同步的序列化与压缩 |
| torch_memory_saver | 可选 | colocate 场景下训练/推理显存换入换出 |
| E2B | 可选 | agentic code RL 的代码执行沙箱 |

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| RL 训练循环 | `train.py` / `train_async.py` | 同步与异步两条主循环，rollout→train→weight sync |
| Megatron 训练后端 | `slime/backends/megatron_utils/` | 模型/优化器/loss/数据/checkpoint，~17k 行 |
| SGLang rollout 后端 | `slime/rollout/` + `slime/backends/sglang_utils/` | 引擎生命周期、生成、数据转换 |
| Ray 编排 | `slime/ray/` | placement group、train actor、rollout manager 装配 |
| 权重同步 | `slime/backends/megatron_utils/update_weight/` | tensor/nccl/disk/disk-delta 四路径 |
| RL 算法 | `slime/utils/ppo_utils.py` + `loss.py` | GRPO/GSPO/CISPO/PPO/REINFORCE++ 优势与策略损失 |
| 数据生成可插拔 | `slime/rollout/base_types.py` | `rollout_function_path` 等点式路径动态加载 |
| Agentic 工作流 | `slime/agent/` | 多轮轨迹树、token drift、沙箱、harness |
| 故障容错 | `slime/utils/health_monitor.py` | 引擎健康监控 + 死引擎恢复 |
| 路由重放 | `slime/utils/routing_replay.py` | MoE expert 路由在训练侧确定性重放 |
| PD 分离 | `slime/backends/sglang_utils/sglang_config.py` | prefill/decode 异构 server group |

## 架构设计解析

### 系统架构

slime 的架构思想是 **一条数据流，两根支柱，一座桥梁**。一条数据流指 `训练 → rollout → Data Buffer` 的 RL 循环始终显式、可观测、可单独调试（`--debug-train-only` / `--debug-rollout-only` 两条独立路径）；两根支柱是 Megatron 训练后端与 SGLang rollout 后端，两者参数都 native 透传、不包抽象；一座桥梁是权重同步子系统，把训练产出的新权重以四种不同代价/语义的方式推送到 rollout 引擎。

这样设计的根本动机是 **RL 的 bug 多是静默的**——损失算错、权重没同步上、advantage 归一化跨 CP 切错、rollout 被多算一次……都不会报错，只会让训练曲线悄悄变差。所以 slime 把数据流做得显式、把可复现性/故障容错/tracing/profiling 当一等公民工程问题对待，而不是"脚本能跑就行"。

![slime 分层架构](/vibe-reading/images/articles/slime-internals/architecture.svg)

文字上，自顶向下分四层：**编排层**（`slime/ray/`）用 Ray placement group 锁定 GPU、装配 `RolloutManager` 与 `RayTrainGroup`（actor/critic），并驱动训练主循环；**引擎层**并排放着 Megatron 训练后端（`slime/backends/megatron_utils/`，承载模型/优化器/loss/数据/checkpoint）与 SGLang rollout 后端（`slime/rollout/` + `slime/backends/sglang_utils/`，承载引擎生命周期/生成/数据转换）；**桥梁层**（`update_weight/`）四种权重同步路径横跨训练与推理；**支撑层**（`slime/utils/`）提供 RL 算法、DP 调度、分布式、健康监控等基础设施；`slime/agent/` 与 `slime_plugins/` 作为可插拔扩展挂接到数据生成与模型定义上。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 编排层 | `slime/ray/` | 锁定 GPU 资源、装配训练/rollout 对象、驱动循环——把两根支柱接到一起 |
| 训练引擎层 | `slime/backends/megatron_utils/` | 承载 Megatron 训练内核：模型/loss/优势/优化器，原生保留上游并行能力 |
| rollout 引擎层 | `slime/rollout/` + `slime/backends/sglang_utils/` | 承载 SGLang 生成与数据转换，原生暴露 SGLang serving 能力 |
| 权重同步桥梁 | `slime/backends/megatron_utils/update_weight/` | 训练↔推理权重的多路径传输，解耦训练与推理部署 |
| 支撑层 | `slime/utils/` | RL 算法、调度、分布式、监控——可独立单测的纯逻辑 |
| 扩展层 | `slime/agent/` + `slime_plugins/` | agentic 工作流与模型定义，作为 workflow 接入不分叉内核 |

### 核心概念

#### 核心对象

slime 里最重要的"东西"是贯穿整条数据流的 **`Sample`** 对象（`slime/utils/types.py`）。它不是普通的 DTO，而是一个随多轮交互增量生长、携带训练所需全部信号的数据结构：

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Sample` | 一次生成的完整记录：prompt+response tokens、reward、loss_mask、log_probs、top-p 路由、routed experts | rollout 产生 → 转训练数据 → 消费 | 聚合为 `RolloutBatch` |
| `RolloutBatch` | dict 形态的训练批次（tokens/rewards/advantages...） | `_convert_samples_to_train_data` 产生 → `train_actor` 消费 | 由 `Sample` 列表聚合 |
| `RolloutManager` | rollout 的 Ray actor 编排者：起引擎、调生成、转数据、同步权重 | 整个训练作业存活 | 持有 `RolloutServer`/`DataSource` |
| `RayTrainGroup` | 训练 actor 组（actor/critic）的 Ray 封装 | 整个训练作业存活 | 持有 `MegatronTrainRayActor` 列表 |
| `SGLangEngine` | 单个 SGLang 引擎的 Ray actor 包装 | 引擎组存活，可死可恢复 | 由 `ServerGroup` 编排 |
| `ServerGroup`/`RolloutServer` | 同构引擎组 / router 后的一个模型 | rollout 阶段 | 支撑 PD 分离多 group |

#### 核心抽象

slime 的扩展点是几个"点式路径字符串"（dotted path），由 `slime/utils/misc.py:load_function` 动态加载。这是它"最大数据生成自由度"的契约：

| 接口/抽象 | 定义位置 | 实现类/函数 | 注册方式 |
| --- | --- | --- | --- |
| `rollout_function_path` | `RolloutManager.generate` 调用 | 任意返回 `RolloutFnTrainOutput` 的函数 | `--rollout-function-path` 参数 |
| `eval_function_path` | `RolloutManager.eval` 调用 | 任意返回 `RolloutFnEvalOutput` 的函数 | `--eval-function-path` 参数 |
| `data_source_path` | `RolloutManager.__init__` 加载 | `DataSource` 子类 | `--data-source-path` 参数 |
| `custom_reward_post_process_path` | `_post_process_rewards` | 任意奖励后处理函数 | `--custom-reward-post-process-path` |
| `custom_convert_samples_to_train_data_path` | `_convert_samples_to_train_data` | 任意 Sample→train_data 转换 | `--custom-convert-samples-to-train-data-path` |
| `custom_advantage_function_path` | `compute_advantages_and_returns` | 任意 advantage 计算函数 | `--custom-advantage-function-path` |
| `DataSource` ABC | `slime/rollout/data_source.py` | `RolloutDataSource` / `RolloutDataSourceWithBuffer` | 继承 + 路径加载 |
| `MegatronTrainRayActor` | `slime/backends/megatron_utils/actor.py` | 默认训练 actor | `actor_cls` 参数注入 |

## 代码目录

```
slime/
├── ray/                # Ray 编排：placement_group / train_actor / rollout / actor_group
├── rollout/            # rollout 数据生成：sglang_rollout / base_types / data_source
│   ├── filter_hub/     # 动态采样过滤
│   └── rm_hub/         # 内置 reward model（math/f1/gpqa/ifbench...）
├── backends/
│   ├── megatron_utils/ # Megatron 训练后端（~17k 行）
│   │   ├── update_weight/      # 权重同步四路径
│   │   ├── hf_to_megatron/     # HF→Megatron checkpoint 转换
│   │   ├── megatron_to_hf/     # Megatron→HF checkpoint 转换
│   │   ├── alignment/         # DeepGMM 对齐 kernel
│   │   ├── kernels/           # fp8/int4 kernel
│   │   └── server/            # Megatron logprob server
│   └── sglang_utils/  # SGLang 引擎生命周期/控制/config
├── agent/              # agentic 工作流：trajectory / sandbox / harness / adapters
├── utils/              # 基础设施：arguments / ppo_utils / distributed / dp_schedule / health_monitor
slime_plugins/
├── models/             # 模型定义（glm4/glm5/qwen3_5/minimax_m2...）
└── rollout_buffer/     # 数据 buffer 插件（离线生成 + 回放）
train.py / train_async.py   # 同步/异步训练入口
```

`tests/` 目录单独有 ~22k 行，分 `ci/`、`plugin_contracts/`、`test_agent/`、`utils/`，测试分层结构见「测试体系」节。`examples/` 按场景组织（coding_agent_rl、fully_async、search-r1、tau-bench、retool、multi_agent 等），是理解各工作流的最佳入口。

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/slime-internals/module-dependencies.svg)

模块间的依赖方向是：`train.py` 入口只依赖 `slime.ray` 编排层；编排层向下装配训练引擎层（`slime.backends.megatron_utils`）与 rollout 引擎层（`slime.rollout` + `slime.backends.sglang_utils`）；两层都依赖支撑层 `slime.utils`；权重同步桥梁横跨训练与 rollout；扩展层（agent/plugins）通过可插拔路径接入，不被内核依赖。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Ray 编排 | GPU 资源锁定与训练/rollout 对象装配、驱动循环 | `create_placement_groups` | 把两根支柱接到一起的唯一粘合层，拓扑决策（colocate/分离）在此 | [编排层](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/01-orchestration) |
| Rollout 数据生成 | SGLang 生成、数据转换、DP 切分、引擎拓扑 | `RolloutManager.generate` | 承载"灵活数据生成"契约，所有 workflow 在此接入 | [Rollout](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/02-rollout) |
| Megatron 训练后端 | 训练内核：模型/loss/优势/优化器/checkpoint | `MegatronTrainRayActor.train_actor` | 原生保留 Megatron 全部并行能力，不包抽象 | [训练后端](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/03-megatron-backend) |
| 权重同步 | 训练→推理权重的四路径传输 | `MegatronTrainRayActor.update_weights` | 训练与推理部署解耦的桥梁，大模型更新效率关键 | [权重同步](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/04-weight-sync) |
| RL 算法 | 优势估计与策略损失 | `compute_advantages_and_returns` / `policy_loss_function` | 算法可配置切换，不绑死训练内核 | [RL 算法](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/05-rl-algorithms) |
| 基础设施 | 参数/分布式/调度/监控 | `slime/utils/arguments.py` | 可独立单测的纯逻辑层，被全仓 import（125 次） | [基础设施](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/06-utils) |
| Agentic 工作流 | 多轮轨迹树、token drift、沙箱、harness | `TrajectoryManager` | agentic RL 的多轮→训练样本转换，独立成 workflow | [Agentic](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/07-agent) |
| 插件机制 | 模型定义与离线数据 buffer | `slime_plugins/models/` / `RolloutBuffer` | 模型结构与离线生成是可插拔扩展，不分叉内核 | [插件](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/08-plugins) |

## 运行时行为

### 启动流程

入口 `train.py` 的 `train(args)` 是一次性启动的装配链。配置来自命令行参数（`parse_args` in `slime/utils/arguments.py`），它同时透传 Megatron 原生参数与 slime 自有参数。对象装配顺序明确：placement group → rollout manager → 训练模型 → 权重初次同步 → 循环。

```text
parse_args()                                                     # slime/utils/arguments.py
  └─ train(args)                                                 # train.py
      ├─ create_placement_groups(args)                           # ray/placement_group.py
      │    └─ _get_placement_group_layout(args)                  # 拓扑决策：colocate / 分离 / debug-only
      │    └─ _create_placement_group(num_gpus)                 # PACK 策略 + InfoActor 探测 + 按 (nodeIP,gpuID) 排序
      ├─ create_rollout_manager(args, pgs["rollout"])           # ray/placement_group.py → ray/rollout.py
      │    └─ RolloutManager.__init__                            # 起 SGLang 引擎 + 加载 DataSource + load_function(generate_rollout)
      ├─ create_training_models(args, pgs, rollout_manager)     # actor + critic RayTrainGroup
      │    └─ RayTrainGroup.create() → MegatronTrainRayActor.init()  # init Megatron + 模型/优化器 + weight_updater 选型
      ├─ actor_model.update_weights()                            # 首次权重推送到 rollout
      └─ for rollout_id in range(num_rollout): ...               # 训练主循环（见下）
```

关键装配点：`MegatronTrainRayActor.init` 里根据 `update_weight_mode`（delta/full）× `update_weight_transport`（disk/nccl/tensor）选择 `weight_updater` 类；`RolloutManager.__init__` 用 `load_function` 动态加载 `rollout_function_path` / `data_source_path` 等扩展点——对象实例化即扩展点注册。

### 核心运行流程

下面三条链路覆盖 slime 的核心运行模式：同步 RL 循环（最常用）、异步 RL 循环（rollout 与 train 重叠）、权重同步（每步结尾的桥接）。它们共享同一套 `Sample` 数据结构与 `RolloutBatch` 转换逻辑，差异只在循环编排与权重传输路径。

#### 同步循环：训练主链路

业务流程：取 prompt → SGLang 生成 → 奖励/verifier → 转训练数据 → DP 切分 → 算优势 → 策略梯度训练 → 存 checkpoint → 同步权重回 rollout → 评估。

![RL 循环数据流](/vibe-reading/images/articles/slime-internals/data-flow.svg)

文字描述：`train.py` 的 `for rollout_id` 循环里，`rollout_manager.generate` 调用可插拔的 `generate_rollout` 函数，经 SGLang router 生成 `Sample` 列表（`generate_and_rm` 内对每个 sample 调 SGLang `/generate`，回填 tokens/log_probs/routed_experts 到 `Sample.append_response_tokens`）；`_convert_samples_to_train_data` 把 `Sample` 列表转成 `RolloutBatch` dict（rewards 做 GRPO 组归一化、补 `rollout_mask_sums` 作为损失归约分母、按需附加 off-policy 的 `rollout_log_probs` 与 routing replay 的 `rollout_routed_experts`）；`_split_train_data_by_dp` 用纯 Python `build_dp_schedule` 按 rollout_id 分步、first-fit 打包微批、跨 DP rank 分发，打包成 `Box`（object-store 或 NIXL 张量传输）返给每个训练 worker。训练侧 `MegatronTrainRayActor.train_actor` 先算 ref/teacher/old_actor 三套 log_probs（靠 `TensorBackuper` 在同一组权重间 `_switch_model` 切换），再 `compute_advantages_and_returns` 算优势，最后 `train()` 走 Megatron 优化器步。结尾 `update_weights` 把新权重经四路径之一推回 rollout 引擎。关键设计：`rollout_mask_sums` 在步骤级预算每 rollout 的 loss_mask 总和，保证一个 rollout 的样本即使被 first-fit 打包拆到不同微批，损失归约分母仍正确——这是 RL 静默 bug 的防护点。

#### 异步循环：rollout/train 重叠

异步入口 `train_async.py` 的核心是把"等当前 rollout 完成"与"启动下一 rollout"重叠：`rollout_data_next_future = rollout_manager.generate.remote(rollout_id + 1)` 在当前步 train 之前就提交，下一步的生成与当前步的训练并行。它强制 `not args.colocate`（异步要求训练与 rollout 物理分离、各占 GPU），且不支持 critic 的 colocation。其余数据流（Sample→RolloutBatch→train_actor→update_weights）与同步路径完全一致——异步只是循环编排的差异，不引入新的数据结构。这体现了"一条数据流"的设计：同步/异步共享转换逻辑，静默 bug 面更小。

#### 桥接循环：权重同步

每步结尾 `actor_model.update_weights()` 触发 `MegatronTrainRayActor.update_weights`：先 `recover_updatable_engines`（故障容错下恢复死引擎），再从 `RolloutManager` 取可更新引擎 + 锁，按需 `connect_rollout_engines`，最后 `weight_updater.update_weights()` 落到四路径之一。colocate 走 `UpdateWeightFromTensor`（CUDA IPC 内存直传），分离 + NCCL 走 `UpdateWeightFromDistributed`（TP all-gather → HF 转换 → 分桶广播），分离 + 磁盘走 `UpdateWeightFromDisk`（全量 checkpoint 落盘引擎重载），大模型增量走 `UpdateWeightFromDiskDelta`（首帧基线、之后 zstd 压缩 delta 落盘、引擎 `pull_weights` 校验重载）。详见 [权重同步模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/04-weight-sync)。

## 典型修改场景

#### 场景 1：新增一种 advantage 估计器

不碰训练内核，走扩展点契约：实现一个签名 `(args, rollout_data) -> None`、在 `rollout_data` 里填 `advantages`/`returns` 的函数，用 `--custom-advantage-function-path module.fn` 传入。`compute_advantages_and_returns` in `slime/backends/megatron_utils/loss.py:758` 优先调用它，绕过内置的 GRPO/PPO 等分支。对应测试 `tests/utils/` 下 advantage 单测。

#### 场景 2：接入一个新的 agentic 数据生成 workflow

实现一个返回 `RolloutFnTrainOutput`（`samples: list[list[Sample]]`）的生成函数，用 `--rollout-function-path` 传入。`Sample.append_response_tokens` 是多轮 token 追加的契约入口——模型生成的 token 传 `trainable=True` + log_probs，工具/环境 token 传 `trainable=False`（自动补 loss_mask 0）。多轮拆分场景必须在每个 sibling sample 上设同一个 `rollout_id`，否则损失归约会把一个 rollout 算成 N 次。可参考 `slime/agent/trajectory.py` 的 `TrajectoryManager._chain_to_samples`。对应测试 `tests/test_agent/`。

#### 场景 3：新增一条权重同步传输路径

在 `slime/backends/megatron_utils/update_weight/` 新增一个类，实现 `connect_rollout_engines` / `update_weights` / `pop_metrics` 三个方法（可继承 `UpdateWeightFromDistributed` 复用 TP all-gather + HF 转换的分桶逻辑，重写 `_on_chunk` 注入传输行为），然后在 `slime/backends/megatron_utils/actor.py:154` 的 `update_weight_mode` × `update_weight_transport` 选型分支里注册。`tests/ci/` 有 GPU 端到端的权重同步正确性测试。

## 测试体系

```
tests/
├── utils/              # 纯逻辑单测：dp_schedule / ppo_utils / types / arguments
├── plugin_contracts/   # 扩展点契约测试：验证 generate/reward/advantage 的输入输出契约
├── test_agent/         # agentic 工作流：trajectory / sandbox / parsing
├── ci/                 # GPU 端到端：dense/MoE Megatron、SGLang 部署、checkpoint、async、OPD、debug replay
└── ...
```

| 代码层 | 测试类型 | 说明 |
| --- | --- | --- |
| `slime/utils/dp_schedule.py` | Unit（CPU） | "pack first, distribute second" 的不变量断言 |
| `slime/utils/ppo_utils.py` | Unit（CPU） | 优势/return 计算正确性 |
| 扩展点（generate/reward/advantage） | Contract | `plugin_contracts/` 验证函数签名与返回契约 |
| `slime/agent/` | Unit | trajectory tree / drift / sample 转换 |
| 端到端训练 | GPU CI | dense & MoE、checkpoint、async、OPD、权重同步正确性 |

测试是 slime 的"可执行文档"——`dp_schedule.py` 模块 docstring 里直接列了 4 条不变量（每个 DP rank 微批数相同、每个微批不超 token 上限、每样本恰好放置一次、flatten 后等于 `range(num_samples_rank)`），并由测试断言。理解某层代码时优先读对应测试。

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `train.py` 的 `train(args)` → `slime/ray/placement_group.py` 的 `create_placement_groups` / `create_rollout_manager` / `create_training_models` → `slime/ray/rollout.py` 的 `RolloutManager.generate` → `slime/backends/megatron_utils/actor.py` 的 `MegatronTrainRayActor.train_actor`
- **第二遍：理解核心数据结构**
  `slime/utils/types.py` 的 `Sample`（尤其 `append_response_tokens` 和 `rollout_id`/`rollout_mask_sums` 的契约）→ `slime/rollout/base_types.py` 的 `RolloutFnTrainOutput` → `slime/rollout/data_source.py` 的 `RolloutDataSourceWithBuffer`
- **第三遍：理解 RL 算法与权重同步**
  `slime/backends/megatron_utils/loss.py` 的 `compute_advantages_and_returns` + `policy_loss_function` → `slime/utils/ppo_utils.py` 的 `get_grpo_returns` / `get_advantages_and_returns_batch` → `slime/backends/megatron_utils/update_weight/common.py` 的 `all_gather_param` → 四个 `update_weight_from_*.py`
- **第四遍：选择重点子模块深入阅读**（模块文档；agentic 方向从 `slime/agent/trajectory.py` 的 `TrajectoryManager` 进）

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| rollout | RL 里的采样/生成阶段；slime 中由 SGLang 引擎执行 |
| advantage | 优势函数，策略梯度的方向信号 |
| colocate | 训练与 rollout 共用同一组 GPU，靠 offload 换入换出显存 |
| PD 分离 | prefill 与 decode 用不同 server group，各自 TP 配置 |
| routing replay | MoE 训练侧按 rollout 时记录的 expert 路由确定性重放，保证 on-policy |
| OPD | On-Policy Distillation，用 teacher log_prob 做 KL 约束 |
| NIXL | NVIDIA 的 GPU 间张量传输库，`rollout_data_transport: nixl` 走它而非 Ray object store |
| Data Buffer | prompt 管理 + 回放 buffer，桥接离线与 on-policy 数据 |

### 参考资料

- [slime: An SGLang-Native Post-Training Framework for RL Scaling](https://lmsys.org/blog/2025-07-09-slime/) — 官方愿景博客
- [v0.1.0 release note: Redefining High-Performance RL Training Frameworks](https://thudm.github.io/slime/blogs/release_v0.1.0.html)
- [Agent-Oriented Design: An Asynchronous and Decoupled Framework for Agentic RL](https://www.notion.so/Agent-Oriented-Design-An-Asynchronous-and-Decoupled-Framework-for-Agentic-RL-2278e692d081802cbdd5d37cef76a547)
