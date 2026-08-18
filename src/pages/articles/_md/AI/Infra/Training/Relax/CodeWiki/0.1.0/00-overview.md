---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "Overview"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "Python", "Ray Serve", "Megatron-LM", "SGLang", "强化学习", "后训练", "全模态"]
description: "小红书开源的 Relax 是面向全模态大模型的异步强化学习后训练引擎。本文从六层服务架构、编排核心、组件层、引擎层、Megatron/SGLang 后端、DCS 分布式权重同步、TransferQueue 全异步数据流到 Agentic 多轮 RL，全面解读 v0.1.0 的内部原理。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.1.0 · **协议** Apache-2.0 · **语言** Python ≥ 3.10 · **代码量** ~90,000 行（`relax/` 包）· **仓库** [GitHub](https://github.com/redai-infra/Relax)

---

## 总览

### 项目简介

**Relax**（**R**einforcement **E**ngine **L**everaging **A**gentic **X**-modality）是小红书 AI Infra 团队开源的高性能强化学习后训练框架，面向多模态大语言模型（MLLM）的 RL post-training。它要解决的核心问题是：**在万亿参数级 MoE 模型 + 全模态（文本/图像/视频/音频）数据 + 多轮 agentic 交互的场景下，如何把 rollout（推理采样）与 training（策略更新）解耦到独立 GPU 集群上并行执行，从而把 GPU 利用率从"交替空转"拉到"流式满载"**。

Relax 的核心价值在于三点：一是**全模态统一**——一套框架覆盖 text、vision、audio 的端到端 RL 训练，是少数能跑通 Qwen3-Omni 全模态后训练的开源系统；二是**服务化架构**——每个角色（Actor / Rollout / Critic / ActorFwd / Reference / Advantages / GenRM）都是独立的 Ray Serve deployment，天然具备服务级弹性调度与故障恢复；三是**全异步数据流**——通过 [TransferQueue](https://github.com/redai-infra/TransferQueue) 数据传输系统实现训练与推理的彻底解耦，支持可配置 staleness 的 off-policy 训练。

典型使用场景：数学推理（DAPO Math + GRPO）、视觉问答（Open-R1 + 多模态 GRPO）、全模态音视频 QA（AVQA + Qwen3-Omni）、以及多轮 agentic 工具调用训练（DeepEyes 等 execute→observe→decide 闭环）。

**项目边界**：Relax 负责 RL 后训练的编排与全链路执行（rollout → reward → advantages → actor 更新 → 权重同步），**不负责预训练**、不实现底层算子 kernel（复用 Megatron-LM / SGLang）、不负责数据标注与 reward 标注（reward 函数由用户可插拔注入）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 六层服务化架构 | `relax/core/`、`relax/components/` | 每个角色是独立 Ray Serve deployment，服务级弹性与故障隔离 |
| 全模态训练 | `relax/utils/multimodal/`、`relax/models/qwen_omni/` | 文本/图像/视频/音频统一处理，`--multimodal-keys` 配置 |
| 全异步 TransferQueue | `relax/distributed/`、`relax/core/controller.py` | Rollout/Actor/ActorFwd/Reference/Advantages 独立集群并行 + 流式数据交换 |
| Hybrid 混合模式 | `relax/core/controller.py`、`relax/backends/megatron/` | Actor/Rollout 独立 PG + ref/actor_fwd/advantages 进程内执行（`TensorBackuper` + `_switch_model`） |
| Agentic 多轮 RL | `relax/agentic/` | 多轮交互、loss masking、`BaseInteractionEnv` 接口、VLM 上下文承接 |
| 弹性 Rollout 扩缩容 | `relax/utils/autoscaler/`、`relax/distributed/ray/rollout.py` | 训练中通过 HTTP REST 动态增减推理引擎，支持同集群/跨集群联邦 |
| 算法套件 | `relax/core/registry.py` | PPO / GRPO / GSPO / SAPO / CISPO / On-Policy Distillation / REINFORCE++ |
| GenRM（LLM-as-judge） | `relax/engine/rewards/`、`relax/components/genrm.py` | 用 LLM 充当奖励模型，可插拔奖励函数 |
| Megatron + SGLang 后端 | `relax/backends/megatron/`、`relax/backends/sglang/` | Megatron-LM（TP/PP/CP/EP）训练 + SGLang 高吞吐推理 |
| DCS 权重同步 | `relax/distributed/checkpoint_service/` | NCCL/GLOO 广播权重，训练→推理异步同步 |
| 生产运维 | `relax/utils/health_system.py`、`relax/utils/metrics/` | HealthManager 自动恢复 + WandB/TensorBoard/ClearML + Apprise 通知 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| `ray[serve]` | 核心 | 分布式编排 + Ray Serve 服务化部署 |
| `transfer_queue`（TransferQueue） | 核心 | 训练/推理数据解耦、流式传输、可配置 staleness |
| Megatron-LM（外部，PYTHONPATH） | 核心 | 训练后端，TP/PP/CP/EP 并行，支持 MoE 与深模型 |
| SGLang + `sglang-router` | 核心 | 高吞吐推理引擎 + 请求路由 |
| `transformers` / `huggingface_hub` | 核心 | 模型与分词器加载、HF↔Megatron 权重转换 |
| `omegaconf` | 核心 | 配置管理（`tq_config` 等） |
| `pydantic` | 核心 | 数据模型校验（Service 状态、Agentic 请求） |
| `fastapi` / `uvicorn` | 核心 | Agentic Chat HTTP API |
| `wandb` / `tensorboard` / `clearml` | 可选 | Metrics 后端，统一由 MetricsService 适配 |
| `apprise` | 可选 | 实时故障通知 |
| `math_verify` / `mathruler` | 可选 | 数学奖励验证 |
| `librosa` / `imageio[ffmpeg]` / `av` | 可选 | 多模态音频/视频处理 |
| `mcp[cli]` | 可选 | MCP 工具协议（agentic 工具调用） |
| `ring_flash_attn` | 可选 | Ring Attention |

---

## 快速上手

Relax 推荐通过官方 Docker 镜像运行（预装 CUDA / PyTorch / Megatron-LM / SGLang / Ray 并版本匹配）。最快验证"跑起来了"的方式是 Task 1——文本数学推理（8 GPU，GRPO）：

```bash title="bash"
# 拉取官方镜像并启动容器（GPU + 共享内存 + 工作区挂载）
docker pull ghcr.io/redai-infra/relaxrl:latest
docker run -it --gpus all --ipc=host --network=host \
  -v /path/to/workspace:/root ghcr.io/redai-infra/relaxrl:latest bash

# 容器内 clone + 安装
git clone https://github.com/redai-infra/Relax.git /root/Relax
cd /root/Relax && pip install -e .

# 下载公开数据集与模型
hf download --repo-type dataset zhuzilin/dapo-math-17k --local-dir /root/dapo-math-17k
hf download Qwen/Qwen3-4B --local-dir /root/Qwen3-4B

# 一条命令启动 GRPO 训练
export EXP_DIR=/root
bash scripts/training/text/run-qwen3-4B-8xgpu.sh
```

预期输出（证明训练循环已跑通）：

```text title="训练日志"
Finish rollout 0/200
training step 0/200
```

> Checkpoint 以 Megatron DCP 格式保存，用 `scripts/tools/convert_torch_dist_to_hf_bridge.py` 转回 HuggingFace 权重。视觉语言（Open-R1）与全模态（AVQA）任务分别用 `scripts/training/multimodal/` 下对应脚本。

---

## 架构设计解析

### 系统架构

Relax 的架构思想是**"用服务化换故障隔离，用数据总线换异步解耦，用控制面换权重点对点直传"**。传统 RLHF 训练把 rollout 与 training 绑在同一进程内交替执行，GPU 交替空转；Relax 把每个角色（Actor / Rollout / Critic / ActorFwd / Reference / Advantages / GenRM）拆成独立的 Ray Serve deployment——一个角色崩溃不会拖垮其他角色，且每个角色可独立分配 GPU、独立扩缩容。角色之间不直接传 tensor，而是通过 TransferQueue 数据总线流式交换 Sample 数据，训练与推理因此可以跑到不同 GPU 集群上并行。权重同步则不走 Ray object store（CPU 序列化对数十 GB 权重不可接受），而是由 DCS 控制面协调元数据、NCCL 直接 GPU-to-GPU broadcast。

![Relax 六层服务化架构](/vibe-reading/images/articles/relax-0.1.0/architecture.svg)

六层自上而下、依赖方向向下：**入口层**拉起编排层；**编排层**的 Controller 通过 Registry 查表创建各角色 Service，并接线 barrier；**组件层**每个角色是 Ray Serve deployment，持有后端 Actor；**引擎层**封装 RL rollout 编排逻辑（reward / router / filters），通过 HTTP 调用后层 SGLang；**后端层**是 Megatron-LM 训练 Actor 与 SGLang 推理 Engine 的生命周期管理；**分布式层**的 DCS 与 RolloutManager 横向支撑组件层与后端层的权重同步与多引擎管理。右侧三个横切模块（Agentic RL / 模型集成 / 共享基础设施）跨越多层：agentic 横跨组件与引擎层提供多轮 pipeline，models 为后端层提供模型族适配，utils 被全模块 import（扇入最高）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 入口层 Entrypoints | `relax/entrypoints/` | 隔离进程级关注点（信号、CLI、Ray 启动），把控制权交给编排层 |
| 编排层 Orchestration | `relax/core/` | 编排训练循环与全局重启，注册角色→组件映射，管理 placement group 生命周期 |
| 组件层 Components | `relax/components/` | 把每个角色封装为 Ray Serve deployment，提供 HTTP 端点与依赖注入接口 |
| 引擎层 Engine | `relax/engine/` | 封装 RL rollout 编排（生成、奖励、路由、过滤），与具体推理后端解耦 |
| 后端层 Backends | `relax/backends/` | 管理 Megatron/SGLang 进程生命周期与权重转换，适配底层训练/推理框架 |
| 分布式层 Distributed | `relax/distributed/` | DCS 权重同步控制面 + Ray Actor 组多引擎管理 + 跨角色 barrier 协调 |
| 横切：Agentic | `relax/agentic/` | 多轮 agentic RL 的 pipeline/session/runner，跨越组件与引擎层 |
| 横切：Models | `relax/models/` | 模型族适配（Qwen3-Omni / Dots-OCR / GLM-MoE-DSA），被后端层调用 |
| 横切：Utils | `relax/utils/` | Sample 数据结构、Envs 配置、metrics、autoscaler、health——全框架共享基石 |

### 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 注册表模式 | `ALGOS` in `relax/core/registry.py:83` | 算法名→「角色→组件类」字典，新增算法只需注册一行，编排逻辑与算法解耦 |
| 策略模式 | `process_role` in `registry.py:141`；`RewardSpec` + `resolve_rm_type` in `engine/rewards/registry.py` | 按 config 模式选角色集 / 按 rm_type 选奖励实现，运行时切换 |
| 两阶段重启 | `_global_restart` in `controller.py:881` | Phase 1 严格有序 teardown + Phase 2 `__init__` 从零重建，保证状态与首启一致 |
| 屏障协调 | `RolloutOffloadBarrier` / `PeerStepBarrier` in `distributed/coordination.py:28,50` | colocate 模式下多角色共享 GPU，轮询 peer 状态协调 offload/onload 时序 |
| 适配器模式 | `BridgeConverter` in `backends/megatron/weight_update/bridge_converter.py`；`MegatronModelBridge` in `relax/models/` | HF↔Megatron 权重命名/布局/分片互转，同一份 checkpoint 跨框架复用 |
| 描述符单例 | `Envs` + `EnvProperty` in `utils/env.py:92,160`；`GenerateState`/`RewardExecutor` | 环境变量惰性实时读取 + 只读绑定；rollout/reward 全局状态单例 |
| 观察者模式 | `HealthManager` + `HealthChecker` in `utils/health_system.py:335,209` | 心跳超时触发 `on_unhealthy` 回调重启，`on_fatal` 直接退出，解耦检测与恢复 |
| 领域驱动 | `RuntimeDomain`/`PrepareDomain`/`RewardDomain`/`TransferDomain` in `relax/agentic/pipeline/` | agentic 多轮 pipeline 按阶段切分领域，各管各状态，`_pump_once` 协调 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Sample` | 一条 RL 样本的全生命周期数据载体（40+ 字段） | rollout 创建 → 填充 response/log_probs/reward → 转 RolloutBatch → actor 消费 | 被 rollout/engine/advantages/actor/agentic 全链路读写（god node #1，177 边） |
| `RolloutBatch` | `list[Sample]` 转成的训练张量字典 | rollout 产出 → TransferQueue → actor 消费 | 由 `convert_samples_to_train_data` 从 Sample 转换 |
| `Controller` | 训练循环编排者 | 进程级单例，`__init__` 装配所有子系统，可被 `_global_restart` 重建 | 持有 `serve_dict`（角色→Service）、`HealthManager` |
| `Service` | Ray Serve deployment 包装器 | 每角色一个，`_deploy` 绑定+`serve.run` | 持有 placement group、component handle |
| `RolloutManager` | 多 SGLang 引擎集群管理器（`@ray.remote` actor） | rollout 角色内常驻，支持扩缩容 | 持有 `EngineGroup`→`SGLangEngine`，被 Actor 调用做权重同步 |
| `SGLangEngine` | SGLang 推理服务器进程的生命周期管理（Ray Actor） | 由 RolloutManager 创建/扩缩/销毁 | 注册到 router、DCS；接收 Megatron broadcast 权重 |
| `MegatronTrainRayActor` | Megatron 训练 Ray Actor | actor 角色内常驻，sleep/wake 切换 | 持有 model/optimizer/`TensorBackuper`/`CheckpointEngineClient` |
| `RuntimeDomain` | agentic 多轮运行时域 | 每个 agentic step rebind | 持有 managed session runner pool、runtime slots |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Base`（组件基类） | `relax/components/base.py` | `Actor`/`Rollout`/`Critic`/`ActorFwd`/`Advantages`/`GenRM`/`SFT` | `ALGOS` 字典按 role 映射 |
| `CommBackend`（权重同步后端） | `relax/distributed/checkpoint_service/backends/base.py` | `DeviceDirectBackend`（NCCL/GLOO） | `CheckpointEngineClient._init_backend` 按 `BackendType` 选择 |
| `RewardSpec`（奖励策略契约） | `relax/engine/rewards/registry.py` | 各 reward 函数（math/dapo/genrm/remote_rm…） | `register_reward(name, fn, mode, label_matcher)` |
| `MegatronModelBridge`（模型桥接） | `relax/models/`（装饰器注册） | `Qwen3OmniMoEBridge`/`GLM5Bridge`/`DotsOCRBridge` | `@MegatronModelBridge.register_bridge` |
| `HfWeightIteratorBase`（权重迭代器） | `backends/megatron/weight_update/hf_weight_iterator_base.py` | `HfWeightIteratorDirect`（手写）/`HfWeightIteratorBridge`（AutoBridge） | `create(args, model)` 工厂按 `megatron_to_hf_mode` |

---

## 代码目录

```shell title="relax/ 包结构"
relax/
├── entrypoints/        # 入口层：train.py（信号处理、CLI、Ray 启动、Controller 拉起）
├── core/               # 编排层：Controller（训练循环+全局重启）、Service（PG+生命周期）、Registry（ROLES+ALGOS）
├── components/         # 组件层：Ray Serve 角色部署（Actor/Rollout/Critic/ActorFwd/Advantages/GenRM/SFT）
├── engine/             # 引擎层：SGLang rollout 引擎、可插拔 rewards、SlimeRouter 路由、data filters、SFT 引擎
├── backends/           # 后端层：Megatron-LM 训练后端 + SGLang 推理后端 + 权重转换/同步
│   ├── megatron/       #   Megatron Actor/Model/Loss/Data/CP utils + weight_update + weight_conversion + kernels
│   └── sglang/         #   SGLangEngine 推理引擎封装
├── distributed/        # 分布式层：DCS checkpoint 服务 + Ray Actor 组（RolloutManager/GenRMManager）+ coordination barriers
│   ├── checkpoint_service/  #   DCS：coordinator + backends(device_direct) + client
│   └── ray/            #   RolloutManager（多引擎管理）、GenRMManager
├── agentic/            # Agentic RL：多轮 pipeline/runtime/session 三层
│   ├── pipeline/       #   RuntimeDomain/PrepareDomain/RewardDomain
│   ├── session/        #   AgenticSessionShard/AgenticChatAPIService/FinalizedResultTransport
│   └── runner/         #   IPC runner
├── models/             # 模型集成：Qwen3-Omni（全模态）、Dots-OCR、GLM-MoE-DSA（Megatron/SGLang 双侧适配）
└── utils/              # 共享基础设施：Sample 数据结构、Envs 配置、metrics、multimodal、autoscaler、health_system
    ├── data/           #   StreamingDataLoader / streaming_dataset
    ├── metrics/        #   MetricsService + WandB/TensorBoard/ClearML adapters
    ├── autoscaler/     #   AutoscalerService + ScalingDecisionEngine
    ├── multimodal/     #   图像/视频/音频处理
    ├── opd/            #   On-Policy Distillation 管理
    ├── training/       #   ppo_utils
    └── visualize/      #   训练可视化模板
```

> `tests/` 目录与 `relax/` 一一对应（`tests/core/`、`tests/components/` 等），测试分层结构见「测试体系」章。`configs/env.yaml` 是 Ray `runtime_env` 环境变量配置（NCCL/CUDA/PYTHONPATH）。`examples/` 含 DeepEyes、mini-swe-agent 等完整 agentic 示例。

---

## 模块地图

![Relax 模块依赖关系图](/vibe-reading/images/articles/relax-0.1.0/module-dependencies.svg)

模块间依赖方向总体自上而下（编排→组件→引擎→后端），但**后端层与分布式层存在双向协作**：`backends/megatron/actor.py` 依赖 `distributed/checkpoint_service/client` 发起权重同步，而 `distributed/checkpoint_service/backends/device_direct.py` 反向依赖 `backends/megatron/weight_conversion` 做 Megatron→HF 权重转换——这是权重同步链路的自然双向，而非架构坏味道（graphify AST 级 import cycle 检测为 None）。`utils` 被全模块 import（`get_logger` 95 次、`Envs` 28 次、`Sample` 18 次，扇入最高），是共享基石。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 编排核心 | 训练循环、placement group、角色注册、全局重启 | `Controller` in `core/controller.py` | 它是唯一知道"整个系统怎么组装、怎么从崩溃恢复"的层 | [01-orchestration](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/01-orchestration) |
| 组件层 | 每角色 Ray Serve deployment，HTTP 端点与依赖注入 | `Base` in `components/base.py` | 故障隔离 + 弹性 GPU 分配 + 算法灵活组合的前提 | [02-components](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/02-components) |
| 引擎层 | RL rollout 编排（生成/奖励/路由/过滤），与推理后端解耦 | `generate_rollout` in `engine/rollout/sglang_rollout.py` | RL 逻辑与推理引擎生命周期正交，可换后端 | [03-engine](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/03-engine) |
| 后端层 | Megatron/SGLang 进程生命周期 + 权重转换同步 | `MegatronTrainRayActor` / `SGLangEngine` | 适配底层框架差异，训练与推理各自独立演化 | [04-backends](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/04-backends) |
| 分布式层 | DCS 权重同步控制面 + 多引擎管理 + barrier | `RolloutManager` in `distributed/ray/rollout.py` | 权重点对点直传需要独立控制面协调拓扑 | [05-distributed](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/05-distributed) |
| Agentic RL | 多轮 pipeline/session/runner，loss masking，VLM 承接 | `AgenticResidentPipeline` in `agentic/rollout.py` | 多轮"执行→观察→决策"闭环与单轮 RL 模式根本不同 | [06-agentic](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/06-agentic) |
| 共享数据类型 | Sample 数据结构、Envs 配置、metrics/autoscaler/health | `Sample` in `utils/types.py` | 被全模块依赖的数据契约必须集中定义 | [07-utils](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/07-utils) |
| 模型集成 | Qwen3-Omni/Dots-OCR/GLM-MoE-DSA 模型族适配 | `Qwen3OmniMoeModel` in `models/qwen_omni/` | 模型族差异巨大，无法统一抽象，须隔离注册 | [08-models](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/08-models) |

## 运行时行为

### 启动流程

进程启动到训练循环开始的调用链（标注文件路径与职责）：

```
entrypoints/train.py: main(args)                                  # train.py:108
  ├─ ray.init(runtime_env) + serve.start(detached)                # 本地 Ray 集群 + Serve
  ├─ init_tracking(args)                                          # WandB/TB/ClearML（须在 Serve 后、Controller 前）
  ├─ _maybe_pin_baseline_to_stable(args)                          # autoscaler 时把 baseline 绑到 stable 节点组
  └─ Controller(args, runtime_env)                                # controller.py:118
       ├─ resolve_sft_num_rollout(config)                         # SFT 预填 num_rollout
       ├─ _initialize_data_system()                               # TransferQueue init + 选 sampler
       │    └─ StreamingTokenBudgetSampler / SeqlenBalancedSampler / GRPOGroupNSampler
       ├─ create_dcs_deployment()                                 # 部署 DCS coordinator Serve
       ├─ _deploy_metrics_service()（可选）                        # MetricsService @ /metrics
       ├─ deploy_agentic_chat_api_services()（可选）               # Agentic Chat API + 16 shard
       ├─ register_all_serve()                                    # controller.py:478
       │    ├─ ALGOS[algo_key] → process_role(config) → 角色集
       │    ├─ register_extra_roles()（GenRM / SFT-rollout）
       │    ├─ _validate_gpu_resources()（colocate 取 max、async 取 sum）
       │    └─ 逐角色 _create_service_task → Service._deploy → serve.run(name=role)
       ├─ _deploy_autoscaler_service()（可选）
       └─ HealthManager.start(on_unhealthy, on_fatal)             # 健康检查 daemon
  → ctrl.training_loop()                                          # controller.py:658
```

**对象装配要点**：配置来自 CLI（`parse_args` 三阶段：pre-parse → sglang args → megatron+slime args，合并后 `slime_validate_args` 校验），覆盖优先级为 CLI > 环境变量（`Envs`）> 默认。对象实例化顺序严格——`init_tracking` 必须在 `serve.start` 后（metrics adapter 探测 Serve `/metrics`）且在 `Controller` 前（wandb_run_id 写入 args 传播给 remote actor）；`register_all_serve` 内先解析 `num_rollout` 再创建 Service，因为 Service 会 pickle `self.config`，延迟解析会让 Actor/Critic 拿到 `num_rollout=None`。依赖注入发生在 `training_loop` 的 `run_all_services`：Controller 把 `rollout_manager`/`genrm_manager`/barriers 通过 `handle.set_*.remote()` 注入 Actor/Rollout/Critic，而非构造期传入——因为这些 handle 在 Serve 部署后才存在。单例创建在各自模块：`GenerateState`/`RewardExecutor`（metaclass Singleton）、`Envs`（类级单例）。

### 核心运行流程

Relax 的运行时由三条主链路覆盖：**同步 colocate 训练步**（最基础，展示 barrier 协调与 TransferQueue 数据流）、**全异步流式训练**（展示独立 GPU 集群 + staleness + DCS 权重同步）、**Agentic 多轮闭环**（展示 session/pipeline 驱动）。三者共享同一套角色抽象与 TransferQueue 数据总线，差异在 GPU 拓扑与协调方式。

#### 同步：GRPO Colocate 训练步

业务流程：Rollout 用 SGLang 生成 response 并计算 reward → 数据 PUT 进 TransferQueue → Advantages 取出算优势回填 → Actor 取出做 Megatron 前向/反向/更新 → 权重 NCCL 广播回 SGLang → 下一轮。colocate 模式下 Actor 与 Rollout 时分共享同一组 GPU，靠 barrier 协调显存让渡。

![GRPO Colocate 数据流](/vibe-reading/images/articles/relax-0.1.0/data-flow.svg)

文字描述：`Rollout._async_run`（`components/rollout.py:400`）每轮调 `rollout_manager.generate.remote(step)`，`RolloutManager`（`distributed/ray/rollout.py:1020`）转发给 `generate_rollout`（`engine/rollout/sglang_rollout.py:1306`）——后者通过 HTTP POST 到 SGLang router 拿回 response/logprobs，填入 `Sample`（`tokens`/`response`/`rollout_log_probs`/`reward`），`convert_samples_to_train_data` 转成 `RolloutBatch` 后 `data_system_client.async_put` 写入 `train_{step}` 分区。随后 `rollout_manager.offload` 让 SGLang 释放显存。`Advantages`（`components/advantages.py:46`）从同分区 GET 数据、算 GRPO group returns、PUT 回 `advantages`/`returns`。`Actor._background_run`（`components/actor.py:192`）先经 `RolloutOffloadBarrier.wait_offloaded_sync` 确认 SGLang 已 offload，再 `wake_up` 重载 Megatron 权重、从 TQ GET 训练数据、`train_actor`（ref/actor 前向→优势→`train_one_step` 1F1B 流水→optimizer step）、`backup`、`sleep` 让出 GPU，最后 `update_weights`（`backends/megatron/actor.py:1611`）走 CUDA IPC 把 HF 格式权重 push 给同节点 SGLang 引擎。关键设计：数据用 `Sample` 胖数据类贯穿全链路（避免多子类转换），权重用 NCCL/IPC 直传（绕过 Ray object store 的 CPU 序列化）。

#### 异步：Fully Async 流式训练

业务流程：Actor / Rollout / ActorFwd / Reference / Advantages 各自跑在独立 GPU 集群上，无 barrier，数据通过 TransferQueue 流式交换，权重通过 DCS NCCL broadcast 异步同步，`--max-staleness` 控制 off-policy 漂移。

文字描述：`process_role` 返回 `ROLES_FULLY_ASYNC`，`register_all_serve` 用 `ThreadPoolExecutor` 并行创建所有角色 Service（`controller.py:560`）。`_initialize_data_system` 选 `StreamingTokenBudgetSampler` 按 token budget 流式分桶。`training_loop` 不接任何 barrier（`controller.py:686` 注释），每步 `actor.update_weights_fully_async`（`actor.py:1814`）→ `CheckpointEngineClient.update_weights_for_rollout`（`client/engine.py:282`）→ `DeviceDirectBackend` 向 DCS coordinator 拉拓扑、建 NCCL 组、broadcast 权重到远程 rollout/actor_fwd/reference 集群。`StreamingDataLoader`（`utils/data/stream_dataloader.py:614`）让 Actor 在 Rollout 增量写数据时就开始消费，消除阶段间 GPU 空转。`reference`/`actor_fwd` 作为独立服务各持 GPU，权重通过 DCS 中转 `send_weight_meta`/`recv_weight_meta` long-poll 协调。

#### Agentic：多轮闭环

业务流程：外部 agent 进程通过 HTTP 调 `AgenticChatAPIService` 多轮对话（执行→观察→决策），`AgenticResidentPipeline` 常驻跨 step 协调 prepare/runtime/reward/transfer 四域，`SessionForest` 承接多轮上下文与 KV cache prefix，会话结束后 `FinalizedResultTransport` 把训练样本回传 TransferQueue。

文字描述：`generate_rollout`（`agentic/rollout.py:1769`）获取全局 `AgenticResidentPipeline` 单例调 `run_step`。`open_step` rebind 四个 Domain 并启动后台 `_resident_dataflow_loop`（`rollout.py:476`）持续 `_pump_once` 驱动 prepare→admission→runtime→reward→transfer。agent 进程由 `ManagedSessionRunnerPool` 拉起，环境变量 `RELAX_BASE_URL` 指向 Chat API；每次 chat 请求到 `AgenticSessionShard.chat`（`agentic/session/service.py:674`），经 `_match_parent_state_hash` 在 `SessionForest` 找历史 state 承接上下文，`_run_ir` 调 SGLang 生成，`forest.append_resp` 追加响应。会话结束 `finalize_and_discard` 调 `SessionForest.build_sample`（`state.py:620`）拼 `loss_mask`（resp 节点=1、obs 节点=0），通过 `ray.put` 存 ObjectRef 返回 `FinalizedResultTransport`，`RuntimeDomain` 解析后经 `TransferDomain` PUT 进 TransferQueue 供 Actor 训练。Partial rollout 时未完成会话被 `gate_rollout_irs_for_partial_resume` 挂起，下一 step `release_partial_resume_gate` 恢复，SGLang KV cache prefix 跨 step 复用。详见 [06-agentic](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/06-agentic)。

---

## 典型修改场景

#### 场景 1：新增一种算法

- `relax/core/registry.py:83` — 在 `ALGOS` 字典加 `"my_algo": {ROLES.rollout: Rollout, ROLES.actor: Actor, ...}`
- 若需新角色组合 → `registry.py` 新增 `ROLES_MY_ALGO` 枚举 + `process_role`（`registry.py:141`）加分支
- 若需新组件类 → `relax/components/` 创建并 import 到 `registry.py`
- 对应测试：`tests/core/`

#### 场景 2：接入新模型族

- 新建 `relax/models/{family}/megatron/`（`model.py` 定义 `MegatronModule`、`bridge.py` 定义 `MegatronModelBridge` 子类、`provider.py` 定义 Provider）
- `relax/models/__init__.py` 加 `try: from relax.models.{family} import megatron` 注册块
- 若需 SGLang 推理 → 新建 `{family}/sglang/model.py` 设 `EntryClass`
- 权重转换 → `backends/megatron/weight_conversion/` 加 `convert_{family}_to_hf` 分支
- 对应测试：`tests/models/`

#### 场景 3：新增一种奖励函数

- 方式 A（内置）：`engine/rewards/` 新建文件 + `engine/rewards/registry.py` 调 `register_reward("my_type", "relax.engine.rewards.my:get_fn")`
- 方式 B（不改框架）：写独立函数，`--custom-rm-path pkg.module:func`，`RewardExecutor._execute_custom`（`engine/rewards/__init__.py:298`）自动加载
- 对应测试：`tests/engine/`

## 测试体系

`tests/` 目录与 `relax/` 一一对应，按模块分层：

```
tests/
├── core/           # Controller/Service/Registry 单元测试
├── components/     # 各角色组件测试
├── engine/         # rollout/rewards/router 测试
├── backends/       # Megatron/SGLang 后端测试
├── distributed/    # DCS/RolloutManager/barrier 测试
├── models/         # 模型集成测试
├── utils/          # Sample/Envs/metrics/autoscaler 测试
├── integration/    # 跨模块端到端
├── data/           # 数据处理 fixtures
└── tools/          # 工具脚本测试
```

| 代码层 | 测试类型 | 阅读建议 |
| --- | --- | --- |
| `core/` Controller/Registry | Unit Test | 理解角色注册与重启逻辑先看 `tests/core/` |
| `distributed/` DCS/RolloutManager | Unit + Integration | 权重同步拓扑用例是理解 NCCL broadcast 的可执行文档 |
| `backends/` 权重转换 | Unit Test | `tests/backends/` 的 convert 用例对照权重映射表最直观 |
| `engine/` rewards/router | Unit Test | reward 注册与 radix tree 用例 |
| `examples/` | 端到端 | DeepEyes/mini-swe-agent 是完整 agentic 训练样例 |

> 测试用 `pytest` + `pytest-asyncio`（`asyncio_mode = "auto"`，见 `pyproject.toml`）。修改某层代码时，参照上表优先阅读对应测试。

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `relax/entrypoints/train.py` 的 `main()` → `relax/core/controller.py` 的 `Controller.__init__` 与 `training_loop`（`register_all_serve` 看角色装配、`run_all_services` 看接线与并行启动）→ `relax/core/registry.py` 的 `ALGOS` + `process_role` 看算法与模式如何决定角色集
- **第二遍：理解核心数据结构与数据流**
  `relax/utils/types.py` 的 `Sample`（40+ 字段，god node #1）→ `relax/utils/utils.py` 的 `convert_samples_to_train_data`（Sample→RolloutBatch）→ `relax/distributed/coordination.py` 的 `RolloutOffloadBarrier`/`PeerStepBarrier`（colocate GPU 协调）
- **第三遍：理解训练与推理后端**
  `relax/backends/megatron/actor.py` 的 `MegatronTrainRayActor.train_actor` + `update_weights`（前向/反向/权重广播）→ `relax/backends/sglang/sglang_engine.py` 的 `SGLangEngine`（推理生命周期）→ `relax/distributed/ray/rollout.py` 的 `RolloutManager`（多引擎管理与 DCS 权重同步）
- **第四遍：按兴趣选重点子模块深入阅读**
  Agentic 多轮闭环 → `relax/agentic/rollout.py` 的 `AgenticResidentPipeline` + `agentic/session/service.py` 的 `AgenticSessionShard` + `agentic/session/state.py` 的 `SessionForest`；或引擎层 reward/router → `relax/engine/rewards/` + `relax/engine/router/`；或模型适配 → `relax/models/qwen_omni/`（模块文件 [08-models](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/08-models)）

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| RLHF / RL post-training | 基于人类反馈的强化学习后训练，用 reward 信号优化策略 |
| PPO / GRPO / GSPO / SAPO / CISPO | 不同 advantage estimator 与 clipping 策略的 RL 算法 |
| MoE | Mixture of Experts，稀疏激活的专家混合模型 |
| TP / PP / CP / EP | Tensor / Pipeline / Context / Expert Parallelism，Megatron 四种并行 |
| DCS | Distributed Checkpoint Service，Relax 的权重同步控制面服务 |
| TransferQueue | 独立的数据传输库，跨角色流式交换 Sample，支持 staleness |
| Colocate / Fully Async / Hybrid | 三种执行模式：时分共享 GPU / 独立集群并行 / 独立 PG + 进程内 ref |
| GenRM | Generative Reward Model，用 LLM-as-judge 充当奖励模型 |
| OPD | On-Policy Distillation，师生 KL 蒸馏 |
| RolloutManager | 管理 SGLang 推理引擎集群的 Ray actor，含弹性扩缩容 |
| SessionForest | agentic 多轮对话的状态树，支持上下文承接与 partial rollout |

### 参考资料

- [Relax GitHub 仓库](https://github.com/redai-infra/Relax) · [官方文档](https://redai-infra.github.io/Relax) · [架构指南](https://github.com/redai-infra/Relax/blob/main/docs/en/guide/architecture.md)
- [TransferQueue](https://github.com/redai-infra/TransferQueue) — 数据传输系统
- [Ray Serve](https://docs.ray.io/en/latest/serve/index.html) · [Megatron-LM](https://github.com/NVIDIA/Megatron-LM) · [SGLang](https://github.com/sgl-project/sglang)
- [Fully Async 训练指南](https://github.com/redai-infra/Relax/blob/main/docs/en/guide/fully-async-training.md) · [Hybrid 训练指南](https://github.com/redai-infra/Relax/blob/main/docs/en/guide/hybrid-training.md) · [弹性扩缩容](https://github.com/redai-infra/Relax/blob/main/docs/en/guide/elastic-rollout.md)
