---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "Overview"
date: "2026-08-12T15:35:32+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "Python", "分布式训练", "ZeRO", "3D 并行", "MoE", "推理引擎"]
description: "DeepSpeed 是微软开源的大规模分布式深度学习训练框架，以 ZeRO 优化器闻名。本文从系统架构、ZeRO 分片、3D 并行、推理引擎到 DeepCompile，全面解读 v0.19.5 的内部原理。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.19.5 · **协议** Apache 2.0 · **语言** Python ≥ 3.10 / PyTorch ≥ 2.0 · **代码量** ~120,000 行 Python + ~10,000 行 C++/CUDA · **仓库** [GitHub](https://github.com/deepspeedai/DeepSpeed)

---

## 总览

### 项目简介

DeepSpeed 是微软开源的大规模分布式深度学习**训练**框架，其核心使命是"让万亿参数模型的训练变得可行且高效"。它 enabled 了 MT-530B、BLOOM 176B 等当时最大的语言模型，通过一系列系统创新重新定义了深度学习训练的规模上限。

DeepSpeed 解决的核心问题是：**大模型训练的显存墙与通信墙**。一个 175B 参数的模型，仅模型权重就需要 350GB（FP16），远超单卡 80GB 显存；而数据并行的梯度同步通信量随模型增大线性膨胀。DeepSpeed 的核心价值是通过 **ZeRO（Zero Redundancy Optimizer）** 将优化器状态、梯度、参数逐级分片到多卡，消除数据并行冗余，使 N 张卡的聚合显存接近单卡的 1/N。

核心使用场景包括：千亿参数 LLM 预训练、MoE 模型训练、长序列训练（Ulysses 序列并行）、大模型推理（InferenceEngine v2）。DeepSpeed 已集成进 HuggingFace Transformers、Accelerate、Lightning 等主流框架。

**项目边界**：DeepSpeed 是训练/推理加速库（library），不是完整的训练框架——它包装用户的 `nn.Module` 和 optimizer，注入分布式逻辑，但不提供数据预处理、模型定义、训练循环编排。它聚焦"让已有的 PyTorch 训练代码跑得更大更快"，不替代 PyTorch 本身。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| ZeRO-1/2/3 | `runtime/zero/stage_1_and_2.py`, `runtime/zero/stage3.py` | 优化器状态/梯度/参数逐级分片 |
| ZeRO-Offload | `runtime/zero/parameter_offload.py`, `ops/adam/cpu_adam.py` | 参数/优化器状态 offload 到 CPU/NVMe |
| 混合精度 FP16/BF16 | `runtime/fp16/fused_optimizer.py`, `runtime/bf16_optimizer.py` | 动态 loss scaling + FP32 master 权重 |
| 流水线并行 | `runtime/pipe/engine.py`, `runtime/pipe/module.py` | 1F1B 调度，PipelineModule 自动切分 |
| 张量并行（AutoTP） | `module_inject/auto_tp.py`, `module_inject/layers.py` | 自动遍历 nn.Linear 做 TP 分片 |
| 序列并行（Ulysses） | `sequence/layer.py`, `runtime/sequence_parallel/ulysses_sp.py` | all-to-all 转置序列/head 维度 |
| 专家并行（AutoEP） | `module_inject/auto_ep.py`, `moe/sharded_moe.py` | MoE 专家分片 + grouped GEMM |
| 推理引擎 v2 | `inference/v2/engine_v2.py`, `inference/v2/ragged/ragged_wrapper.py` | Ragged batch + paged KV-cache |
| DeepCompile | `compile/backend.py`, `compile/passes/zero3_compile.py` | FX graph 编译 + 通信 op 插入 |
| 多硬件支持 | `accelerator/real_accelerator.py` | NVIDIA/AMD/Intel CPU/HPU/XPU/NPU 等 9 种后端 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| PyTorch ≥ 2.0 | 核心 | 深度学习框架基座，autograd + distributed |
| hjson | 核心 | DeepSpeedConfig 配置文件解析（支持注释的 JSON） |
| pydantic ≥ 2.0 | 核心 | v2 推理引擎配置模型（`DeepSpeedConfigModel`） |
| packaging | 核心 | 版本号解析与兼容性检查 |
| einops | 核心 | 张量维度操作（推理 kernel） |
| ninja | 核心 | C++/CUDA 算子 JIT 编译的构建工具 |
| Triton | 可选 | GroupGEMM / 推理 kernel / DeepCompile SP pass |
| CUDA / ROCm | 可选 | C++/CUDA/HIP 算子编译（nvcc / hipcc） |
| transformers ≥ 4.51.3 | 可选 | HuggingFace 模型集成（AutoTP / 推理） |

### 版本历史

DeepSpeed 的核心创新沿版本演进清晰可见：v0.x 早期确立 ZeRO-1/2/3 三级分片（SC'20 论文）；2021 年加入 ZeRO-Offload（CPU offload）和 ZeRO-Infinity（NVMe offload）；2022 年引入 DeepSpeed-MoE 和推理引擎 v1；2023 年 ZeRO++ 量化通信优化；2024 年 Ulysses 序列并行和 DeepCompile 初版；2025 年 SuperOffload、ZenFlow 异步优化器、Arctic 长序列训练。v0.19.5 是 2026 年 5 月发布的最新稳定版，包含完整的 DeepCompile、AutoEP（支持 DeepSeek-V3 路由）、推理引擎 v2（Ragged batch + paged KV-cache）。

---

## 快速上手

DeepSpeed 是库而非应用，"跑起来"意味着用 `deepspeed.initialize()` 包装你的 PyTorch 训练代码：

```python title="quickstart.py"
import deepspeed

# 1. 定义 DeepSpeed 配置
ds_config = {
    "train_micro_batch_size_per_gpu": 16,
    "gradient_accumulation_steps": 4,
    "zero_optimization": {"stage": 3},
    "bf16": {"enabled": True},
}

# 2. 用 deepspeed.initialize 包装模型和优化器
model, optimizer, _, _ = deepspeed.initialize(
    model=model, optimizer=optimizer, config=ds_config
)

# 3. 训练循环（与原生 PyTorch 几乎一致）
for batch in dataloader:
    loss = model(batch["input_ids"], labels=batch["labels"])
    model.backward(loss)        # 替代 loss.backward()
    model.step()                # 替代 optimizer.step()
```

启动多卡训练用 DeepSpeed 自带的 launcher：

```bash title="launch.sh"
deepspeed --num_gpus=8 train_script.py --deepspeed_config ds_config.json
```

**预期输出**：每个 rank 打印 `Setting ds_accelerator to cuda (auto detect)`，首次 step 时 JIT 编译 CUDA 算子（日志显示 `JIT compilation`），之后进入正常训练循环打印 loss。ZeRO-3 下 `nvidia-smi` 可见每卡显存约为完整模型的 1/N。

> 纯库调用无"端到端跑起来"概念时，最小调用示例即上述 `deepspeed.initialize()`。内部初始化流程见「运行时行为 > 启动流程」。

---

## 架构设计解析

### 系统架构

DeepSpeed 的架构思想是**分层抽象 + 双路径编排**：上层用统一的 `DeepSpeedEngine` 包装用户模型，向下根据训练或推理场景分两条路径——训练路径走 ZeRO/FP16/Pipeline 等并行策略，推理路径走 InferenceEngine + Module Inject。两条路径共享底层的通信抽象（`comm`）、硬件抽象（`accelerator`）和算子库（`ops`）。这样设计解决了"训练和推理对参数生命周期管理需求截然不同，但通信和硬件适配逻辑相同"的矛盾——共用基础设施层避免重复实现，分路径编排允许各自优化。

![DeepSpeed 系统分层架构](/vibe-reading/images/articles/deepspeed/architecture.svg)

系统分五层，自顶向下依赖：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|------------------------|
| API 入口层 | `__init__.py`, `launcher/` | 暴露 `initialize()`/`init_inference()` 给用户，隔离 CLI 启动逻辑 |
| 引擎编排层 | `runtime/engine.py`, `runtime/config.py` | `DeepSpeedEngine` 装配模型/优化器/数据加载器，编排训练循环，是所有策略的汇聚点 |
| 并行训练层 | `runtime/zero/`, `runtime/fp16/`, `runtime/pipe/`, `moe/`, `compile/` | 各并行与优化策略的实现，被引擎按配置组合，彼此解耦可独立演进 |
| 推理引擎层 | `inference/v2/`, `module_inject/` | 推理专用：Ragged batch、paged KV-cache、模型层注入替换，独立于训练的参数管理 |
| 基础设施层 | `comm/`, `accelerator/`, `ops/`, `checkpoint/` | 通信原语、硬件抽象、CUDA 算子、检查点持久化，被训练与推理共享 |

层间协作方式：引擎层通过 `_configure_optimizer()` 在初始化时根据配置**策略选择**（Strategy 模式）具体并行实现，如 `ZERO_OPTIMIZATION` 分支走 `_configure_zero_optimizer()` 创建 `DeepSpeedZeroOptimizer_Stage3`。训练循环中 `engine.forward()` / `backward()` / `step()` 委托给被选中的优化器，优化器内部调用基础设施层的 `comm`（通信）和 `accelerator`（设备操作）。推理路径则由 `init_inference()` 直接创建 `InferenceEngineV2`，通过 Module Inject 替换模型层后走独立的 ragged forward。

### 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
|------|----------------------|---------|
| 策略模式 | `engine.py` `_do_optimizer_sanity_check` | 根据配置（ZeRO/AMP/FP16/BF16）选择不同优化器包装策略，互斥关系在检查时保证 |
| 工厂模式 | `engine.py` `_configure_basic_optimizer` | 按 optimizer_name 创建 12 种底层优化器实例，CPU offload 时切换到 `DeepSpeedCPUAdam` |
| 模板方法 | `engine.py` `step` → `_take_model_step` | `step()` 定义训练更新骨架，子类 `PipelineEngine` 覆写关键步骤 |
| 包装器模式 | `fp16/fused_optimizer.py` `FP16_Optimizer` | 包装底层 optimizer，注入 loss scaling 和 FP32 master 权重管理，对调用方透明 |
| 抽象工厂 | `accelerator/real_accelerator.py` `get_accelerator` | 按硬件探测结果创建对应 Accelerator，316 处调用方面向抽象编程 |
| Builder 模式 | `ops/op_builder/builder.py` `OpBuilder.load` | JIT 编译 CUDA 算子，封装"预编译查找→JIT 编译→缓存"流程 |
| Pass 管道 | `compile/backend.py` `run_opt_passes` | DeepCompile 的 FX graph 变换流水线，每个 pass 声明 contract 依赖 |
| 注册机制 | `module_inject/replace_policy.py` | Policy 列表 + `policy_to_container` 映射，新增模型只需注册不改核心 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `DeepSpeedEngine` | 训练编排器，包装用户模型 | 整个训练过程 | 持有 `optimizer`、`module`、`config`、`checkpoint_engine` |
| `DeepSpeedZeroOptimizer_Stage3` | ZeRO-3 优化器 | 训练过程 | 持有 `parameter_offload`、`loss_scaler`，引用 `module` |
| `DeepSpeedZeRoOffload` | 参数分片管理器 | 随 ZeRO-3 优化器 | 持有 `PartitionedParameterCoordinator` |
| `PartitionedParameterCoordinator` | 参数 fetch/release 调度器 | 随参数 offload | 管理 allgather stream 和预取队列 |
| `DeepSpeedConfig` | 配置对象 | 整个训练过程 | 解析 hjson，展开为几十个配置属性 |
| `RaggedBatchWrapper` | 推理变长批处理容器 | 每次推理 forward | 持有 token 流和序列映射元数据 |
| `LayerContainer` | 推理模型层参数容器 | 模型加载时 | 通过 `PARAM_MAPPING` 路由 checkpoint 参数 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `DeepSpeedAccelerator` | `accelerator/abstract_accelerator.py` | `CUDA_Accelerator`, `CPU_Accelerator` 等 9 种 | `get_accelerator()` 自动探测 |
| `ZeROOptimizer` | `runtime/base_optimizer.py` L250 | `DeepSpeedZeroOptimizer`(S1/2), `DeepSpeedZeroOptimizer_Stage3` | `engine._configure_zero_optimizer` 按 stage 创建 |
| `TransformerPolicy` | `module_inject/policy.py` L43 | `LLAMA2LayerPolicy`, `HFBertLayerPolicy` 等 | `replace_policies` 列表 + `policy_to_container` dict |
| `DeepSpeedBackend`(comm) | `comm/backend.py` L25 | `TorchBackend`, `CCLBackend` | `init_distributed()` 按硬件选择 |
| `CheckpointEngine` | `runtime/checkpoint_engine/checkpoint_engine.py` L21 | `TorchCheckpointEngine`, `DecoupledCheckpointEngine` 等 | `engine._configure_checkpointing` |
| `DSKernelBase` | `inference/v2/kernels/ds_kernel.py` L9 | `CUDABiasActivation`, `BlockedFlashAttn` 等 | `@DSModuleRegistry.register_module` 装饰器 |

---

## 代码目录

```
deepspeed/
├── __init__.py              # 入口：initialize(), init_inference(), 导出 DeepSpeedEngine
├── runtime/                 # 训练运行时（47,000 行，最核心）
│   ├── engine.py            # DeepSpeedEngine（5,777 行，362 度 god node）
│   ├── config.py            # DeepSpeedConfig 配置加载
│   ├── constants.py         # 全局常量
│   ├── base_optimizer.py    # ZeROOptimizer 基类
│   ├── bf16_optimizer.py    # BF16_Optimizer
│   ├── zero/                # ZeRO 优化器（13,900 行）
│   ├── fp16/                # FP16 混合精度
│   ├── pipe/                # 流水线并行
│   ├── tensor_parallel/     # TP 配置与管理
│   ├── sequence_parallel/   # Ulysses SP（HF 集成版）
│   ├── swap_tensor/         # NVMe swap
│   ├── zenflow/             # ZenFlow 异步优化器
│   └── checkpoint_engine/   # 检查点引擎
├── inference/               # 推理引擎（15,000 行）
│   ├── engine.py            # v1 推理引擎
│   └── v2/                  # v2 推理引擎（Ragged batch + paged KV-cache）
├── module_inject/           # 模型层注入/替换（11,000 行）
├── ops/                     # C++/CUDA 算子库（10,000+ 行）
├── compile/                 # DeepCompile 编译优化（6,200 行）
├── accelerator/             # 硬件加速器抽象（符号链接到顶层 accelerator/）
├── comm/                    # 通信层抽象
├── sequence/                # Ulysses 序列并行核心
├── moe/                     # MoE 专家混合
├── checkpoint/              # 检查点转换与 universal 格式
├── launcher/                # 多进程启动器
├── autotuning/              # 自动调优
├── utils/                   # 工具函数
└── csrc/                    # C++/CUDA 源码（与 ops/ 对应）
```

`accelerator/` 在仓库顶层（`deepspeed/accelerator` 是指向 `../accelerator/` 的符号链接），因为 op_builder 在编译时需要稳定的 import 路径。`csrc/` 是 C++/CUDA 源码目录，与 `ops/op_builder/` 的 Builder 类一一对应。

---

## 模块地图

DeepSpeed 的 12 个有效模块按职责分化自然形成，每个模块满足"含 god node 或 ≥500 行业务逻辑"的分量门槛。模块间的静态依赖方向见下图——`DeepSpeedEngine` 是中枢，向下编排训练（ZeRO/FP16/Pipeline）和推理（InferenceEngine/Module Inject）两条路径，底层共享 Comm + Accelerator + Ops + Checkpoint。

![DeepSpeed 模块依赖关系](/vibe-reading/images/articles/deepspeed/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 核心引擎 | 装配模型/优化器，编排训练循环 | `DeepSpeedEngine` in `runtime/engine.py` | 362 度 god node，所有策略的汇聚点 | [01-核心引擎](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/01-engine) |
| ZeRO 优化器 | 优化器状态/梯度/参数逐级分片 | `DeepSpeedZeroOptimizer_Stage3` in `runtime/zero/stage3.py` | 旗舰创新，Stage3 参数管理范式完全不同 | [02-ZeRO-优化器](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/02-zero) |
| 混合精度训练 | FP16 动态 loss scaling + BF16 master 权重 | `FP16_Optimizer` in `runtime/fp16/fused_optimizer.py` | 精度策略对 loss scaling 需求差异大，独立 wrapper | [03-混合精度训练](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/03-fp16-bf16) |
| 流水线并行 | 多 stage 切分 + 1F1B 调度 | `PipelineEngine` in `runtime/pipe/engine.py` | 覆写引擎 forward/backward/step，独立调度系统 | [04-流水线并行](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/04-pipeline) |
| 张量并行与通信 | TP 分片 + 通信后端抽象 + Ulysses SP | `TorchBackend` in `comm/torch.py` | 通信是多硬件适配的核心抽象，被所有模块共享 | [05-张量并行与通信](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/05-comm-tp) |
| 推理引擎 | Ragged batch + paged KV-cache + 模型实现 | `RaggedBatchWrapper` in `inference/v2/ragged/ragged_wrapper.py` | v2 全新设计，graphable forward + 连续批处理 | [06-推理引擎](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/06-inference) |
| 模型注入 | 自动替换 nn.Linear 为 TP/EP 层 | `AutoTP` in `module_inject/auto_tp.py` | Policy + Container 解耦模型适配与内核实现 | [07-模型注入](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/07-module-inject) |
| 算子库 | C++/CUDA 算子 JIT 编译与调用 | `OpBuilder` in `ops/op_builder/builder.py` | 多硬件编译适配，反射注册机制 | [08-算子库](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/08-ops) |
| 编译优化 | FX graph 变换 + 通信 op 插入 | `make_backend` in `compile/backend.py` | 基于 torch.compile 的自定义 backend，独立 pass 管道 | [09-编译优化](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/09-compile) |
| 加速器抽象 | 9 种硬件后端统一接口 | `get_accelerator` in `accelerator/real_accelerator.py` | 316 处调用，多硬件适配的基础设施 | [10-加速器抽象](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/10-accelerator) |
| 检查点 | ZeRO 分片持久化 + universal 格式转换 | `DeepSpeedCheckpoint` in `checkpoint/deepspeed_checkpoint.py` | 3D 并行检查点协调，解耦训练与加载拓扑 | [11-检查点](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/11-checkpoint) |
| MoE 专家混合 | Top-K 门控 + 专家并行 + grouped GEMM | `TopKGate` in `moe/sharded_moe.py` | 三套技术栈（训练/AutoEP/推理）覆盖不同场景 | [12-MoE-专家混合](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/12-moe) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

从 `deepspeed.initialize()` 出发的对象装配链：

```
deepspeed.initialize()                          __init__.py L93
├── dist.init_distributed()                     初始化分布式后端
├── DeepSpeedConfig(config)                     加载 hjson 配置 → 展开属性
├── [工厂分支] 根据模型类型选择引擎:
│   ├── PipelineModule → PipelineEngine         __init__.py L246
│   ├── hybrid_engine → DeepSpeedHybridEngine   __init__.py L217
│   └── 默认 → DeepSpeedEngine                  __init__.py L229
│
└── DeepSpeedEngine.__init__()                  engine.py L252
    ├── _configure_distributed_model(model)     模型放置 + 参数广播 + 通信组查询
    ├── _configure_optimizer(optimizer, params)  [核心] 优化器装配
    │   ├── _configure_basic_optimizer()         创建底层 optimizer（Adam/FusedAdam/CPUAdam）
    │   ├── _do_optimizer_sanity_check()         返回策略标识（ZERO/FP16/BF16）
    │   └── _configure_zero_optimizer()          按 stage 创建 ZeRO 优化器
    │       └── DeepSpeedZeroOptimizer_Stage3(module, optimizer, ...)
    │           ├── DeepSpeedZeRoOffload(module, ...)        参数分片管理
    │           │   └── PartitionedParameterCoordinator()    fetch/release 调度
    │           └── create_reduce_and_remove_grad_hooks()    注册梯度 hook
    ├── _configure_lr_scheduler()
    └── _configure_checkpointing()               创建 checkpoint_engine
```

**对象装配顺序**：配置先于一切（`DeepSpeedConfig` 先解析），模型先于优化器（优化器需要引用 `module` 注册 hook），优化器内部的 `DeepSpeedZeRoOffload` 先于 `PartitionedParameterCoordinator`（后者由前者创建）。依赖注入方式是**手动 new + 构造函数传参**——`DeepSpeedZeroOptimizer_Stage3` 的构造函数接收 `module`、`init_optimizer`、`param_names`、`ds_config` 等，无 DI 容器。`get_accelerator()` 是全局单例，首次调用时按硬件探测结果创建。

### 核心运行流程

DeepSpeed 的运行时行为分训练与推理两条主链路。训练链路以 ZeRO-3 为最复杂场景，覆盖 forward 参数 allgather → backward 梯度 reduce-scatter → step 参数更新的完整数据流；推理链路以 v2 引擎的 Ragged batch 为核心。此外 Pipeline 并行有独立的 1F1B 调度链路。

#### 训练：ZeRO-3 训练迭代

业务流程：用户取 batch → engine.forward（按需 allgather 参数 → 模型计算 → 释放参数）→ engine.backward（autograd 反传 + 梯度 reduce-scatter 分片）→ engine.step（溢出检查 → loss scale → 优化器更新 → fp32 回写 fp16）

![ZeRO-3 训练迭代数据流](/vibe-reading/images/articles/deepspeed/data-flow.svg)

文字描述：`forward` 时每个子模块的 pre-forward hook 触发 `coordinator.fetch_sub_module()` 在 `allgather_stream` 上异步聚合完整参数（基于 trace 预取后续模块），计算完成后 post-forward hook 调 `release_sub_module()` 释放参数回分片状态。`backward` 中 `loss.backward()` 触发 PyTorch autograd，每个参数的梯度 hook 将梯度放入 IPG bucket，bucket 满后在 `reduce_and_partition_stream` 上执行 `reduce_scatter_coalesced` 跨 rank 分片梯度，随后 `partition_grads` 写入本 rank 分区并释放完整梯度。`step` 在梯度累积边界检查溢出（`has_overflow` + `dist.all_reduce(MAX)` 跨 rank 同步），无溢出则逐子组准备 FP32 梯度 → unscale+clip → `optimizer.step()` 在 FP32 master 权重上更新 → `fp16.copy_(fp32)` 回写 → unflatten 到参数分片。关键设计是三条 CUDA Stream 并行（计算/梯度通信/参数聚合）实现计算-通信重叠。

#### 训练：Pipeline 1F1B 流水线

业务流程：用户调 `engine.train_batch()` → 构造 `TrainSchedule` → `_exec_schedule` 按指令序列执行 LoadMicroBatch → ForwardPass → SendActivation → RecvActivation → BackwardPass → SendGrad → ReduceGrads → OptimizerStep。

文字描述：`PipelineEngine` 覆写了基类的 `forward()`/`backward()`/`step()`（全部 `raise PipelineError`），用 `train_batch()` 替代整个训练循环。调度器生成 `2*(micro_batches + stages - 1)` 步指令序列，每个 stage 执行 1F1B 交替——峰值内存从 `O(micro_batches)` 降到 `O(stages)`。stage 间通过 `p2p.send()`/`p2p.recv()` 传递激活值和梯度。`enable_backward_allreduce = False` 禁用引擎自动 all-reduce，改由调度末尾的 `ReduceGrads` 指令统一规约。

#### 推理：v2 Ragged Forward

业务流程：用户调 `engine.put(batch_uids, batch_tokens)` → `can_schedule` 预检 → 逐序列 `insert_sequence` 写入 host buffer → `finalize` 批量 H2D copy → `model.prepare_batch` 构建 attention atoms → `model.forward`（ragged embed → transformer 层 → unembed）→ 返回 logits。

文字描述：`RaggedBatchWrapper` 将多个变长序列拼接为 1D token 流（无 padding），配合 `token_to_seq` 映射和 `inflight_seq_descriptors` 元数据，所有 kernel 在 ragged tensor 上操作。host shadow 双缓冲——insert 阶段写 Python list，finalize 阶段 `non_blocking` copy 到 GPU，减少 CPU-GPU 同步点。`DSStateManager` 管理 paged KV-cache（`BlockedKVCache` + `BlockedAllocator`），支持连续生成中的动态 KV 分配。`prepare_batch` 在 forward 前调 `attn.build_atoms()` 将 ragged 元数据转为 attention kernel 可直接消费的 atom 格式，让 forward 只需 GPU kernel 调用（CUDA graph 友好）。

---

## 典型修改场景

#### 场景 1：新增一种优化器类型（如 AdaFactor）

需修改 `runtime/config.py` L71 新增常量 + `DEEPSPEED_OPTIMIZERS` 列表；`runtime/engine.py` `_configure_basic_optimizer` L2041 新增 `elif` 分支创建实例；`runtime/zero/utils.py` `is_zero_supported_optimizer` 加入支持列表。对应测试：`tests/unit/test_run.py`。

#### 场景 2：新增支持一种推理模型架构

v2 路径需在 `inference/v2/model_implementations/` 新建目录，包含 `model.py`（继承 `DSTransformerModelBase`）、`container.py`（声明 `PARAM_MAPPING`）、`policy.py`（继承 `InferenceV2Policy`），然后在 `engine_factory.py` `build_hf_engine` 添加 `model_type` → Policy 分支。对应测试：`tests/inference/test_v2_*`。

#### 场景 3：新增一种通信后端

需在 `comm/` 新建后端文件（参照 `ccl.py` 继承 `TorchBackend`）；`comm/comm.py` 添加全局变量和 `init_deepspeed_backend` 分支；`set_backend` 添加初始化检查。对应测试：`tests/unit/comm/test_*`。

> 扩展点的契约定义见「架构设计解析 > 核心概念」的核心抽象表。

---

## 测试体系

```
tests/
├── unit/              # 单元测试（optimizer、config、zero 逻辑）
├── inference/         # 推理测试（v1 + v2 模型实现）
├── onebit/            # 1-bit Adam/BAdam 通信压缩
├── pipe/              # 流水线并行
├── moe/               # MoE 专家混合
├── checkpoint/        # 检查点保存/加载
└── launcher/          # 多进程启动器
```

| 代码层 | 测试类型 | 说明 |
|--------|---------|------|
| `runtime/zero/` | Unit + Integration | `tests/unit/zero/test_zero_*`，验证分片逻辑和显存 |
| `runtime/engine.py` | Integration | `tests/run_tests.py` 端到端训练 |
| `inference/v2/` | Inference | `tests/inference/test_v2_*`，模型实现正确性 |
| `ops/` | Unit | 每个算子有独立测试，验证 CUDA kernel 输出 |

修改某层代码时，参照上表找到对应测试优先阅读——很多 DeepSpeed 测试实际上是"可执行文档"，展示了配置和预期行为。

---

## 阅读源码推荐路线

- **第一遍：理解训练主流程**
  `deepspeed/__init__.py` 的 `initialize()` L93 → `runtime/engine.py` 的 `DeepSpeedEngine.__init__()` L252 → `engine.forward()` L2756 → `engine.backward()` L3160 → `engine.step()` L3360 → `_take_model_step()` L3281。这条线回答"用户调 deepspeed.initialize 后引擎怎么跑起来"。

- **第二遍：理解 ZeRO 分片核心**
  `runtime/zero/stage3.py` 的 `DeepSpeedZeroOptimizer_Stage3` L149 → `parameter_offload.py` 的 `DeepSpeedZeRoOffload` L130 → `partitioned_param_coordinator.py` 的 `fetch_sub_module` L310 → `partition_parameters.py` 的 `Init` L923 和 `ZeroParamStatus` L230。这条线回答"参数怎么分片、怎么按需聚合、怎么预取"。

- **第三遍：理解推理引擎 v2**
  `inference/v2/engine_v2.py` 的 `InferenceEngineV2.put()` → `inference/v2/ragged/ragged_wrapper.py` 的 `RaggedBatchWrapper` L31（`insert_sequence` + `finalize`）→ `inference/v2/model_implementations/inference_transformer_base.py` 的 `DSTransformerModelBase` L48 → `inference/v2/model_implementations/llama_v2/model.py` 的 `forward()` L199。这条线回答"变长序列怎么无 padding 批处理、paged KV-cache 怎么管理"。

- **第四遍：选择重点子模块深入阅读**
  从上方「模块地图」表的"深入阅读"链接进入各模块文档。推荐顺序：[ZeRO 优化器](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/02-zero) → [模型注入](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/07-module-inject)（理解 AutoTP/AutoEP）→ [编译优化](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/09-compile)（理解 DeepCompile pass 管道）→ [算子库](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/08-ops)（理解 JIT 编译机制）。

---

## 附录

### 术语表

| 术语 | 解释 |
|------|------|
| ZeRO | Zero Redundancy Optimizer，DeepSpeed 旗舰创新，分 Stage 1/2/3 三级分片 |
| ZeRO-Offload | 将优化器状态/参数 offload 到 CPU 或 NVMe，突破显存限制 |
| 3D-Parallelism | 数据并行 + 张量并行 + 流水线并行的三维组合 |
| Ulysses SP | 序列并行，用 all-to-all 转置 sequence/head 维度，通信量与序列长度无关 |
| AutoTP | 自动张量并行，遍历 nn.Linear 自动做 column/row parallel 分片 |
| AutoEP | 自动专家并行，检测 HF MoE 模型并替换为 DeepSpeed EP 层 |
| Ragged Batch | 推理 v2 的变长序列批处理，无 padding 拼接为 1D token 流 |
| DeepCompile | 基于 torch.compile + FX graph 的编译优化，插入 ZeRO 通信 op |
| ZenFlow | 异步优化器，选择性参数更新减少通信 |
| IPG bucket | Independent Parameter Gradient bucket，ZeRO 梯度累积容器 |
| GAS | Gradient Accumulation Steps，梯度累积步数 |

### 参考资料

- [ZeRO 论文（SC'20）](https://arxiv.org/abs/1910.02054) — ZeRO 内存优化理论
- [ZeRO-Offload 论文（USENIX ATC'21）](https://arxiv.org/abs/2101.06840) — CPU offload
- [ZeRO-Infinity 论文（SC'21）](https://arxiv.org/abs/2104.07857) — NVMe offload
- [DeepSpeed-MoE 论文（ICML'22）](https://arxiv.org/abs/2201.05596) — MoE 训练与推理
- [DeepSpeed Inference 论文（SC'22）](https://arxiv.org/abs/2207.00032) — 推理引擎
- [ZeRO++ 论文](https://arxiv.org/abs/2306.10209) — 量化通信优化
- [DeepSpeed 官方文档](https://www.deepspeed.ai/) — 训练与推理指南
- [DeepCompile 博客](https://github.com/deepspeedai/DeepSpeed/blob/master/blogs/deepcompile/README.md)
- [ZenFlow 博客](https://pytorch.org/blog/zenflow-stall-free-offloading-engine-for-llm-training/)
