---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "Overview"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "RL", "Post-Training", "Megatron", "SGLang", "Ray", "GRPO", "Async"]
description: "Miles 是企业级大规模模型后训练 RL 框架，配 SGLang rollout 与 Megatron 训练，本章为整体架构概览。"
readingTime: "38 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.1.0 · **协议** Apache-2.0 · **Python** ≥ 3.10 · **代码量** ~74,600 行（`miles/` + `miles_plugins/`，437 个 .py 文件）· **仓库** [GitHub](https://github.com/radixark/miles)

---

## 总览

### 项目简介

**Miles** 是一个面向**大规模模型后训练（post-training）**的企业级强化学习框架。它将 [SGLang](https://github.com/sgl-project/sglang) 的高吞吐推理引擎与 [Megatron-LM](https://github.com/NVIDIA/Megatron-LM) 的可扩展训练结合，并内置了万亿参数级 RL 训练所需的精度控制、稳定性保障和可观测性能力。Miles 从 [slime](https://github.com/THUDM/slime) 分叉而来，在其基础上构建了完整的容错、异步编排和可观测性体系。

Miles 解决的核心问题是：**在万亿参数规模下，如何让 rollout（推理生成）与 training（梯度更新）两个物理分离、耗时悬殊的阶段高效协作，并在硬件故障下不丢失训练进度。** 为此它做了三件事——把 rollout 和 training worker 解耦成可独立调度的 Cell；用 token-in-token-out（TITO）和路由回放（R3）消除推理与训练间的数值偏差；用原地容错恢复让单个 GPU 挂掉时不重启整个 job。

核心使用场景包括：GRPO/GSPO/PPO/REINFORCE++ 等 RL 算法训练、SFT、on-policy distillation，以及面向 coding/computer-use 的 agentic 多轮训练。**项目边界**：Miles 负责训练编排与基础设施，模型架构实现由插件系统承载（`miles_plugins/`）；推理引擎本身由 SGLang 提供，Miles 只管理其生命周期与权重同步。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| Fully Async RL | `train_async.py`, `miles/rollout/fully_async_rollout.py` | rollout 与 training 解耦，DataBuffer 生产者-消费者 |
| 请求路由 | `miles/router/router.py` | least-active-requests 负载均衡 + 健康检查隔离 |
| TITO | `miles/utils/chat_template_utils/tito_tokenizer.py` | 增量分词，避免 detokenize/retokenize 往返 |
| R3 路由回放 | `miles/utils/replay_base.py`, `miles/rollout/session/core.py` | 记录 MoE expert routing，训练时回放 |
| P2P 权重同步 | `miles/backends/megatron_utils/update_weight/update_weight_from_distributed/p2p.py` | RDMA 直写，秒级更新万亿参数 |
| 低精度训练 | `miles/backends/megatron_utils/rematerialize_utils.py` | FP8/MXFP8/NVFP4 + FP32 master weight |
| 原地容错 | `miles/ray/train/cell.py`, `miles/utils/ft_utils/` | Cell 状态机 + in-memory checkpoint 传输 |
| 审计事件日志 | `miles/utils/audit_utils/event_logger/` | 8 种事件 + 3 条验证规则，检测 silent bug |
| Dashboard | `miles/dashboard/` | 自托管 web UI，per-GPU-per-step 行为可视化 |
| 插件系统 | `miles_plugins/` | mbridge 权重转换 + model spec + optimizer |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Ray | 核心 | 分布式 actor 编排、object store、placement group |
| Megatron-LM | 核心 | 训练后端（TP/PP/CP/EP/ETP 五维并行） |
| SGLang | 核心 | rollout 推理引擎（高吞吐生成） |
| PyTorch FSDP2 | 可选 | 替代训练后端（HF 原生模型） |
| torchft | 核心 | 弹性数据并行（IndepDP，动态成员 NCCL） |
| torch_memory_saver | 核心 | sleep/wake_up 期间 GPU 内存释放 |
| Mooncake TransferEngine | 可选 | P2P RDMA 权重传输 fast path |
| FastAPI | 核心 | Dashboard REST API + control server + router |
| mbridge | 可选 | HF↔Megatron 权重格式转换（外部库） |
| typer | 核心 | launch script CLI 参数桥接 |

### 版本历史

Miles v0.1.0（2026-08 发布）是首个正式 release，标志着从容错、异步编排到可观测性的完整体系成型。它从 slime 分叉，核心增量是：RayTrainCell 状态机驱动的原地容错、控制平面/数据平面分离的 K8s 风格 control server、`train_async.py` 的 1-step lookahead 与 fully-async DataBuffer、TITO/R3 正确性机制、以及自托管 Dashboard。

## 快速上手

以 Qwen3-4B 为例（H100 单节点）：

```bash title="快速启动（H100 单节点）"
# 1. 安装（推荐用官方 Docker 镜像，含 SGLang + Megatron + FlashInfer）
docker pull radixark/miles:latest
docker run --gpus all --shm-size 1g -it radixark/miles:latest

# 2. 运行 Qwen3-4B GRPO 训练（脚本自动下载模型/数据/转换 checkpoint）
python3 scripts/run_qwen3_4b.py --hardware H100 --mode debug_minimal

# 3. 预期：ray job submit 提交后，SGLang engine 启动 → rollout 生成 → Megatron 训练 → 权重同步循环
```

`debug_minimal` 模式只跑 2 个 rollout、最小 batch，用于验证端到端通路。`normal` 模式跑完整 `dapo-math-17k` 数据集。脚本内部 `prepare()` 下载模型与数据，`execute()` 拼装参数并 `ray job submit`。入口细节见 [启动与配置](01-launch-config)。

## 架构设计解析

### 系统架构

Miles 的架构思想是**解耦与弹性**：把一个 RL 训练 job 拆成可独立调度、可独立恢复的单元（Cell），用数据契约（`Sample`）和 object store 解耦 rollout 与 training 的数据传递，用控制平面/数据平面分离让容错决策不阻塞训练。

![Miles 分层架构](/vibe-reading/images/articles/miles-internals/architecture.svg)

系统分五层，依赖方向自上而下：

- **入口与配置层**：launch script 用 typer + dataclass 暴露 CLI/env var，`execute_train()` 提交 Ray job。`true_on_policy` 模块用声明式契约保证 SGLang 推理与 Megatron 训练的数值一致性。
- **异步编排层**：`RayTrainCell` 状态机管理每个训练单元的生命周期，`RayTrainGroup` 驱动训练循环，`RolloutManager` 编排生成。三层解耦——ObjectRef 非阻塞、DataBuffer 生产者-消费者、Cell 独立 stop/start。
- **Rollout 与 Router 层**：Generate/Filter/RM Hub 组成插件式生成管线，Session 层承载 TITO 增量分词与 R3 路由记录，MilesRouter 做请求分发与健康检查。
- **训练后端层**：`MegatronTrainRayActor` 与 `FSDPTrainRayActor` 实现统一 `TrainRayActor` 契约，权重同步有 P2P/Broadcast/Disk-delta/Tensor IPC 四种策略。
- **基础设施层**：`types.py` 定义全链路数据契约，`ft_utils` 提供容错，`audit_utils` 做事件审计，`dashboard` 提供可观测 UI。

插件系统（`miles_plugins/`）横切注入——经 CLI 参数（`--spec`、`--custom-model-provider-path`）加载，核心框架不 import 具体插件，依赖反转。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|------------------------|
| 入口与配置 | `scripts/`, `miles/utils/external_utils/`, `miles/true_on_policy/` | 隔离用户配置与训练内核，把 recipe 编译为 Ray job |
| 异步编排 | `miles/ray/` | 编排 rollout↔training 的异步协作与容错恢复 |
| Rollout 与 Router | `miles/rollout/`, `miles/router/` | 封装生成管线与请求路由，保证 TITO/R3 正确性 |
| 训练后端 | `miles/backends/` | 承载具体训练实现与权重同步，适配多后端 |
| 基础设施 | `miles/utils/`, `miles/dashboard/` | 提供数据契约、容错、审计、可观测等全局能力 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 状态机 | `RayTrainCell` in `miles/ray/train/cell.py` | FT 场景下 cell 可随时失败/恢复，状态机确保操作只在合法状态下执行 |
| 适配器 | `TrainRayActor` in `miles/ray/train_actor.py` | Megatron/FSDP 两后端统一接口，切换后端不改 launch script |
| 策略 | 权重同步策略类 in `miles/backends/megatron_utils/update_weight/` | 4 种传输路径（P2P/Broadcast/Disk/Tensor）按部署拓扑选择 |
| 生产者-消费者 | `DashboardCollector` in `miles/dashboard/collector.py` | 多数据源 fire-and-forget 推送，可观测性绝不阻塞训练 |
| 控制平面/数据平面分离 | `control_server/` in `miles/utils/ft_utils/` | 恢复决策独立于训练进程，未来可接入 K8s controller |
| 事件溯源 | `EventLogger` in `miles/utils/audit_utils/event_logger/` | 不可变事件流，离线分析检测 silent data corruption |
| Registry | `@register_model` in `miles_plugins/mbridge/` | 插件注册，新增模型不改核心代码 |
| 模板方法 | `prepare()`/`execute()` in `scripts/run_*.py` | launch script 固定两段式骨架，recipe 只填内容 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `Sample` | 一次 rollout 生成的训练样本（prompt+response+reward+tokens） | rollout 产出 → object store → train 消费 | 全链路唯一数据契约，被 80+ 处 import |
| `RayTrainCell` | 一个训练单元（一组 GPU + actor） | Pending→Allocated→Alive→(Errored)→Stopped | 挂载 health_checker，归属 RayTrainGroup |
| `RolloutManager` | rollout 编排 Ray actor（CPU 节点） | job 生命周期常驻 | 持有 SGLang engines，被 driver 调用 |
| `SGLangEngine` | rollout 推理引擎 Ray actor（GPU） | 被 RolloutManager 管理 | 接收 weight update RPC |
| `EnginesAndLock` | 权重同步时的引擎列表 + 全局锁 | 单次 update_weights | 由 RolloutManager 发给 train group |
| `IndepDPInfo` | 独立 DP 拓扑信息（cell_index/quorum_id/alive_cell_indices） | 每次 reconfigure 重建 | 约束 NCCL process group 成员 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|---------|--------|---------|
| `TrainRayActor` | `miles/ray/train_actor.py` | `MegatronTrainRayActor`, `FSDPTrainRayActor` | `actor_factory.py` 按 `--train-backend` 选择 |
| `BaseHealthChecker` | `miles/utils/ft_utils/health_checker.py` | `SimpleHealthChecker`, `NoopHealthChecker` | `cell_monitor.py:create_trainer_cell_health_checker()` |
| `_CellHandle` | `miles/utils/ft_utils/control_server/handles.py` | `_ActorCellHandle`, `_RolloutCellHandle` | `registry.py:register()` |
| `DistBucketedWeightUpdateMixin` | `miles/backends/megatron_utils/update_weight/update_weight_from_distributed/mixin.py` | `UpdateWeightP2P`, `UpdateWeightFromDistributed`, `UpdateWeightFromDiskDelta` | `actor.py:init()` 按 `--update-weight-transfer-mode` 选择 |
| `BaseReplayManager` | `miles/utils/replay_base.py` | `RoutingReplayManager`, `IndexerReplayManager` | monkey-patch MoE router top-k |

## 代码目录

```
miles/
├── backends/              # 训练与 rollout 后端适配层（~21,900 行）
│   ├── megatron_utils/    #   Megatron-LM 训练后端（模型/训练/权重同步/checkpoint 转换）
│   ├── fsdp_utils/        #   PyTorch FSDP2 后端（HF 原生模型）
│   ├── sglang_utils/      #   SGLang rollout 引擎管理（HTTP server 生命周期）
│   └── training_utils/    #   跨后端共享（ParallelState/CP/loss/data）
├── ray/                   # Ray 异步编排层（~5,000 行）
│   ├── train/             #   Cell 状态机 + Group + actor_factory
│   └── rollout/           #   RolloutManager + ServerGroup + 数据转换
├── rollout/               # Rollout 生成管线（~8,300 行）
│   ├── generate_hub/      #   单轮/多轮/agentic 三种生成函数
│   ├── filter_hub/        #   dynamic filter（reward 零方差过滤等）
│   ├── rm_hub/            #   reward model 分发
│   ├── session/           #   TITO + R3 + 多轮会话状态管理
│   └── inference_rollout/ #   类式 rollout 入口（v2）
├── router/                # SGLang 请求路由（~250 行）
├── dashboard/             # 自托管可观测 UI（~4,500 行）
├── true_on_policy/        # true-on-policy 契约与 launch plan（~520 行）
└── utils/                 # 共享基础设施（~22,900 行）
    ├── types.py           #   Sample 数据契约（被 import 80+ 次）
    ├── ft_utils/          #   容错（health_checker/control_server/indep_dp）
    ├── audit_utils/       #   事件审计（EventLogger + witness + analyzer）
    ├── tracking_utils/    #   结构化日志 + 多 backend tracking
    └── chat_template_utils/ #  TITO 增量分词器
miles_plugins/             # 插件系统（~11,200 行）
├── mbridge/               #   HF↔Megatron 权重转换 bridge（10 个模型）
├── models/                #   model-specific attention/MLP 实现
├── megatron_bridge/       #   megatron.bridge 集成（Nemotron-H MoE）
└── optimizers/            #   NVMe 流式 optimizer state
train.py / train_async.py  # 训练主循环入口（Ray job 内）
scripts/run_*.py           # launch script（用户入口，30+ 模型 recipe）
```

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/miles-internals/module-dependencies.svg)

模块间依赖方向：launch 编排层提交 Ray job 后交控制权给异步编排层；编排层向两侧调用——rollout 层生成数据、后端层训练消费；基础设施层被所有上层复用（`Sample` 数据契约约束 rollout↔train 边界）；插件系统经 CLI 参数注入后端层（依赖反转）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 启动与配置 | recipe 编译为 Ray job | `execute_train()` | 隔离用户配置与训练内核 | [01](01-launch-config) |
| 异步编排 | Cell 状态机驱动训练循环 | `RayTrainGroup.train()` | FT 需要 cell 级别独立生命周期 | [02](02-async-orchestration) |
| Rollout 与 Router | 生成管线 + 请求路由 + TITO/R3 | `InferenceRolloutFn` | 生成正确性与路由隔离是独立关注点 | [03](03-rollout-router) |
| 训练后端 | Megatron/FSDP 训练 + 权重同步 | `MegatronTrainRayActor.train()` | 多后端适配 + 4 种权重传输策略 | [04](04-backends) |
| 共享基础 | 数据契约 + 工具函数 | `Sample` in `types.py` | 全链路数据契约必须单一来源 | [05](05-shared-core) |
| 容错与审计 | 原地恢复 + 事件审计 | `_refresh_cells()` | 容错决策与训练解耦（控制平面分离） | [06](06-fault-tolerance) |
| 可观测性 | per-GPU-per-step 行为可视化 | `MetricStore` | 自托管 UI 展示 wandb 无法表达的维度 | [07](07-dashboard) |
| 插件系统 | 模型适配 + 权重转换 + optimizer | `@register_model` | 模型架构差异极大，必须可插拔 | [08](08-plugins) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

## 运行时行为

### 启动流程

从 launch script 到训练循环的启动调用链：

```
scripts/run_qwen3_4b.py: main()
├── prepare(args)                          # 下载模型/数据集/转换 checkpoint
└── execute(args)                          # 拼装 8+ argument groups
    └── U.execute_train(train_args, ...)   # command_utils.py:229
        ├── ray start --head
        └── ray job submit -- python3 train.py {model_args} {train_args}
            └── train.py: async def train(args)          # Ray job 内接管
                ├── parse_args()                          # arguments.py — 此处校验 4-knob invariant
                ├── create_placement_groups(args)         # 分配 GPU bundles
                ├── create_rollout_manager(args, pg)      # RolloutManager Ray actor → start SGLang engines
                ├── create_training_models(args, pgs)     # RayTrainGroup → RayTrainCell[] → MegatronTrainRayActor
                │   └── actor_model.init()                # cell.init() → actor init → 加载 checkpoint
                ├── actor_model.set_rollout_manager()     # 注入 rollout manager handle
                ├── actor_model.update_weights()          # 首次权重同步到 SGLang engine
                └── start_control_server()                # 容错控制平面（daemon thread）
```

对象装配要点：`actor_factory` 是延迟工厂（`Callable[[], list[ActorHandle]]`），cell 先以 `StatePending` 存在，`allocate_for_pending()` 时才创建 actor——解耦状态管理与资源分配。`health_checker` 在 `cell.init()` 完成后 `start()`，挂在独立 concurrency group 上，即使训练线程在 NCCL collective 中阻塞，心跳 RPC 仍能返回。权重同步策略对象（`weight_updater`）在 `actor.init()` 中按 `--update-weight-transfer-mode` 选择，是 P2P/Broadcast/Disk/Tensor 四选一。

### 核心运行流程

Miles 的核心是 RL 训练循环——`for rollout_id in range(num_rollout)` 内的 sample→generate→score→optimize→sync。有三种驱动模式覆盖不同运行场景：同步 on-policy、1-step prefetch 异步、fully-async 生产者-消费者。

#### 主链路：同步训练循环（`train.py`）

业务流程：每轮采样 prompt → SGLang 生成 response → reward model 打分 → Megatron 计算 advantage 并更新参数 → 权重同步回 SGLang engine。

![RL 训练循环数据流](/vibe-reading/images/articles/miles-internals/data-flow.svg)

文字描述：`RolloutManager.generate.remote(rollout_id)` 返回 Ray `ObjectRef`（非阻塞），内部 `InferenceRolloutFn._call_train()` 调 `generate_rollout_async()`——为每个 prompt group 创建并发生成任务（`asyncio.Semaphore` 控并发），每个 `Sample` 经 `single_turn.generate()` POST 到 router 分发到 SGLang engine，再经 `async_rm()` 打分。生成完成后 `convert_samples_to_train_data()` 把 `Sample[]` 转为 `dict{tokens, rewards, loss_masks, rollout_log_probs, ...}`，`split_train_data_by_dp()` 按 DP rank 分片 put 到 object store。训练侧 `MegatronTrainRayActor.train()` 中 `get_rollout_data()` 取对应分片移到 GPU，先切 ref model 算 `ref_log_probs`，切回 actor 算 `log_probs`，`compute_advantages_and_returns()` 算 GRPO advantage，最后 `train_one_step()` 做 PPO clip loss 的 forward+backward+optimizer.step()。`update_weights()` 把新权重经 Megatron→HF 转换后同步到 SGLang engine。

#### 异步链路：1-step prefetch（`train_async.py`）

`train_async.py` 在 `await rollout_data_curr` 的同时已发出 `rollout_manager.generate.remote(rollout_id + 1)`，rollout generation 与 training 时间重叠。wall time 从 `rollout_time + train_time` 降到 `max(rollout_time, train_time)`。`--update-weights-interval N` 允许 N 轮 off-policy 训练后同步一次权重。

#### 异步链路：fully-async DataBuffer（`train_async.py --fully-async`）

`FullyAsyncRolloutFn._worker_loop()` 是常驻 asyncio task，持续生成数据放入 `DataBuffer`；训练 step 只 drain 已完成的 group。生产者与消费者通过 `asyncio.Condition` 同步，`--max-weight-staleness` 控制数据新鲜度。详见 [异步编排](02-async-orchestration)。

### 状态流

`RayTrainCell` 的状态机是 Miles 容错的核心——每个训练单元独立管理生命周期，失败时原地恢复而非重启 job。

![RayTrainCell 状态机](/vibe-reading/images/articles/miles-internals/cell-state-flow.svg)

状态枚举定义在 `miles/ray/train/cell_state.py`（Pydantic frozen model），转换经 `cell.py` 的 `_change_state()`（含 assert 校验合法转换）。`StateAllocatedAlive` 的 cell 参与训练；`StateAllocatedErrored` 被 `_refresh_cells()` 发现后自动恢复——从 alive cell 经 NCCL 发 in-memory checkpoint（`send_ckpt`/`recv_ckpt`）到 healing cell，重建 NCCL process group（`quorum_id++`），整个过程不暂停其他 cell 的训练。触发转换的方法：`allocate_for_pending()`（Pending→Uninit）、`init()`（Uninit→Alive）、`_mark_as_errored()`（Alive→Errored）、`stop()`（→Stopped）、`mark_as_pending()`（Stopped→Pending，恢复）。详见 [容错与审计](06-fault-tolerance)。

## 典型修改场景

#### 场景 1：新增一个模型 recipe

需修改：`scripts/models/<type>.py`（架构常量）、`scripts/run_<model>.py`（ScriptArgs + 派生并行度）、`miles/true_on_policy/model_profiles.py`（注册 model profile）。若是新架构还需 `miles_plugins/mbridge/<model>.py`（权重转换 bridge）+ `miles_plugins/models/<model>/`（自定义 attention spec）。

#### 场景 2：接入新的 agentic environment

实现 `async def my_agent(base_url, prompt, ...)` 函数，通过 `--custom-generate-function-path` + `--custom-agent-function-path` + `--use-session-server` 指定。Session server 自动处理 TITO token tracking 和 R3 记录，agent 函数只需调 `POST /sessions/{id}/v1/chat/completions`。

#### 场景 3：新增一个 audit 验证规则

在 `miles/utils/audit_utils/event_logger/models.py` 新增事件类型，在训练代码中调 `get_event_logger().log()`，在 `miles/utils/audit_utils/event_analyzer/rules/` 新增 `check()` 函数，在 `analyzer.py:run_analysis()` 注册。

对应测试：`tests/fast/utils/`（types 校验）、`tests/fast-gpu/`（rollout/训练）、`tests/snapshots/`（端到端快照）。

## 测试体系

```
tests/
├── fast/          # 纯 CPU 单元测试（types/loss/utils/arguments 校验）
├── fast-gpu/      # 需 GPU 的单元测试（rollout/training step）
├── e2e/           # 端到端（完整训练循环 smoke test）
├── ci/            # CI 专用（fault injection / weight sync 验证）
├── snapshots/     # 端到端快照（golden output 对比）
└── manual/        # 手动测试（大规模/长跑）
```

| 代码层 | 测试类型 |
|--------|----------|
| `utils/types.py` 数据契约 | `tests/fast/utils/test_types.py`（Sample validate/序列化） |
| `rollout/` 生成管线 | `tests/fast/`（filter/generate 兼容性） + `tests/fast-gpu/` |
| `backends/` 训练后端 | `tests/fast-gpu/`（train step） + `tests/ci/`（weight sync / FT） |
| `ray/` 编排 | `tests/e2e/`（完整循环） + `tests/snapshots/` |

`tests/ci/` 的 fault injection 测试特别值得读——它通过 `_try_ci_fault_injection()` 在 `rollout_id >= 2` 时模拟 engine crash，验证原地恢复。

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `scripts/run_qwen3_4b.py` 的 `execute()` → `miles/utils/external_utils/command_utils.py` 的 `execute_train()`（Ray job 提交点，~line 229）→ `train.py` 的 `async def train()`（训练循环骨架）
- **第二遍：理解异步编排核心**
  `miles/ray/train/cell.py` 的 `RayTrainCell`（状态机）→ `miles/ray/train/group.py` 的 `RayTrainGroup.train()`（含 `_refresh_cells` 容错恢复）→ `miles/ray/rollout/rollout_manager.py` 的 `generate()`（rollout 编排）
- **第三遍：理解数据契约与数据流**
  `miles/utils/types.py` 的 `Sample`（全链路数据契约）→ `miles/ray/rollout/train_data_conversion.py` 的 `convert_samples_to_train_data()`（Sample→train dict）→ `miles/backends/training_utils/data.py` 的 `get_rollout_data()`（dict→GPU tensor）
- **第四遍：理解正确性机制**
  `miles/utils/chat_template_utils/tito_tokenizer.py`（TITO 增量分词）→ `miles/utils/replay_base.py`（R3 路由回放）→ `miles/backends/megatron_utils/update_weight/update_weight_from_distributed/p2p.py`（P2P 权重同步）
- **第五遍：选择重点模块深入阅读**（模块文档）

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| TITO | Token-In-Token-Out，全链路用 token IDs 避免 detokenize/retokenize 往返 |
| R3 | Rollout Routing Replay，记录 MoE expert routing 并在训练时回放 |
| IndepDP | Independent Data Parallel，弹性数据并行，支持 cell 级故障隔离 |
| Cell | 一个训练单元（一组 GPU + Ray actor），容错的最小恢复单位 |
| four-knob invariant | `rollout_batch_size × n_samples = global_batch_size × num_steps`，每样本都被产生且被消费 |
| quorum_id | IndepDP 拓扑版本号，每次 reconfigure 递增，确保所有 rank 一致 |
| colocate | trainer 与 SGLang engine 共享 GPU，用 sleep/wake_up 交替占用显存 |

### 参考资料

- [Miles 官方文档](https://miles.radixark.com/docs) — Core Concepts、Fully Async RL、Training Backends
- [Miles v0.1 发布博客](https://www.lmsys.org/blog/2026-08-18-miles-v0-1) — Production-level Post-training
- [slime](https://github.com/THUDM/slime) — Miles 的上游项目
- [SGLang](https://github.com/sgl-project/sglang) / [Megatron-LM](https://github.com/NVIDIA/Megatron-LM) / [torchft](https://github.com/pytorch/torchft)
