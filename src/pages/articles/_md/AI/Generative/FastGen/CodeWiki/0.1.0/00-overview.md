---
source:
  type: "源码解读"
  project: "FastGen"
  url: "https://github.com/NVlabs/FastGen"
title: "Overview"
date: "2026-08-11T15:35:00+08:00"
category: [AI, Generative, FastGen, CodeWiki, "0.1.0"]
tags: ["FastGen", "Python", "PyTorch", "扩散模型", "蒸馏", "NVIDIA"]
description: "NVIDIA FastGen 是基于 PyTorch 的扩散模型蒸馏/加速框架，支持 CM、DMD2、LADD、Self-Forcing 等多种方法与 11 种网络架构。本文从系统架构、运行时行为到核心模块，全面解读 v0.1.0 的内部原理。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.1.0 · **协议** Apache 2.0 · **语言** Python ≥ 3.10 · **代码量** ~37,000 行 · **仓库** [GitHub](https://github.com/NVlabs/FastGen)

---

## 总览

### 项目简介

**FastGen** 是 NVIDIA 开发的 PyTorch 扩散模型加速框架，核心目标是用**蒸馏**（distillation）技术把多步扩散采样压缩成少步甚至一步生成。它把"训练算法"和"网络架构"两层彻底分离——一个 `FastGenModel`（算法容器）组合任意一个 `FastGenNetwork`（网络架构），通过 `Trainer` 统一编排训练循环，再用 `Callback` 系统挂载 EMA、日志、梯度裁剪等横切关注点。整个框架由 `BaseConfig` + `LazyCall` + `instantiate` 的声明式配置驱动，一行命令即可切换"方法 × 网络 × 数据"的组合。

框架支持 ≥10B 参数的大规模训练（DDP/FSDP2）、图像与视频多模态（T2I/I2V/V2V），以及 13 种蒸馏/微调方法（CM、sCM、TCM、MeanFlow、DMD2、f-Distill、LADD、CausVid、Self-Forcing、SFT、CausalSFT、KD、CausalKD）。**项目边界**：FastGen 只负责"训练一个蒸馏后的快速生成器"，不负责推理服务化部署——推理脚本在 `scripts/inference/` 仅作验证用，不包含服务化、批处理调度等生产推理逻辑。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| 训练循环编排 | `fastgen/trainer.py` | `Trainer.run()` 模板方法，含梯度累积/auto-resume |
| 蒸馏算法容器 | `fastgen/methods/model.py` | `FastGenModel` 抽象基类（全局 degree #1） |
| 网络架构抽象 | `fastgen/networks/network.py` | `FastGenNetwork` + `CausalFastGenNetwork` |
| 噪声调度 | `fastgen/networks/noise_schedule.py` | 7 种 schedule（EDM/Alphas/RF/SD/SDXL/CogVideoX/Trig） |
| 配置系统 | `fastgen/configs/config.py` | `BaseConfig` attrs + `LazyCall` 延迟实例化 |
| 回调系统 | `fastgen/callbacks/callback.py` | 20 个生命周期钩子 + `CallbackDict` 动态分发 |
| 分布式训练 | `fastgen/utils/distributed/` | DDP + FSDP2 装配 + 梯度同步控制 |
| 检查点管理 | `fastgen/utils/checkpointer.py` | `Checkpointer` + `FSDPCheckpointer` 适配器 |
| 数据加载 | `fastgen/datasets/` | class-conditional + WebDataset（图像/视频/latent） |
| 自动恢复 | `fastgen/utils/autoresume.py` | `AutoResumeInterface` 策略模式（SLURM/K8s 抢占恢复） |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| PyTorch ≥ 2.6 | 核心 | 深度学习框架（DDP/FSDP2/autocast） |
| diffusers 0.35.1 | 核心 | HuggingFace 模型（Wan/Flux/SDXL/CogVideoX 底层网络） |
| transformers 4.49.0 | 核心 | 文本编码器（CLIP/T5） |
| hydra-core | 核心 | 命令行 `key=value` override 引擎 |
| omegaconf | 核心 | `DictConfig` 配置容器（`LazyCall` 返回值） |
| attrs | 核心 | 配置 dataclass（`@attrs.define`，非 `dataclass`） |
| wandb[media] | 可选 | 实验追踪与样本可视化 |
| webdataset | 可选 | 大规模数据流（shard 化存储） |
| loguru | 核心 | 结构化日志（rank0 过滤） |
| accelerate | 可选 | HuggingFace 加速工具 |
| safetensors | 核心 | 安全的权重序列化格式 |
| boto3 | 可选 | S3 权重/checkpoint 存储 |

### 版本历史

v0.1.0（2026-03-13，commit `123e6a2`）是 FastGen 的**首个公开版本**，标志着从内部研究项目转为开源框架。此版本已包含完整的训练框架骨架（Trainer + Callback + 配置系统）、7 种噪声调度、11 种网络架构、13 种蒸馏方法，以及 DDP/FSDP2 大规模训练支持。

---

## 快速上手

```bash
# 安装
git clone https://github.com/NVlabs/FastGen.git
cd FastGen
pip install -e .

# 下载数据（CIFAR-10 + 预训练 EDM）
python scripts/download_data.py --dataset cifar10

# 基础训练（DMD2 on EDM/CIFAR-10）
python train.py --config=fastgen/configs/experiments/EDM/config_dmd2_test.py
```

**预期输出**：训练日志输出 wandb.ai 链接，checkpoints 存入 `$FASTGEN_OUTPUT_ROOT/fastgen/cifar10/debug/checkpoints/0001000.pth`（格式 `{iteration:07d}.pth`）。

OOM 时用更小 batch-size + 梯度累积：`dataloader_train.batch_size=32`，框架自动按 `batch_size_global` 计算 `grad_accum_rounds` 匹配全局 batch。

---

## 架构设计解析

### 系统架构

FastGen 的核心架构思想是**配置驱动的分层蒸馏框架**——把"声明要什么"（配置）和"怎么执行"（训练循环/算法/网络）彻底分离，通过 `instantiate()` 递归实例化机制连接。这样设计解决了扩散模型蒸馏领域的一个关键痛点：方法（CM/DMD2/LADD…）和网络（EDM/Flux/Wan…）的组合爆炸——13 种方法 × 11 种网络 = 143 种组合，如果硬编码每种组合将不可维护。FastGen 通过分层解耦，只需 13 + 11 = 24 个实现，任意组合由配置驱动。

![FastGen 分层架构](/vibe-reading/images/articles/fastgen-internals/architecture.svg)

五层架构自上而下：**入口与配置层**负责声明式配置与递归实例化（`LazyCall` 把"类 + 参数"封装成 `DictConfig`，`instantiate()` 延迟到运行时才 new 对象）；**编排层**的 `Trainer.run()` 是模板方法，固定了"init → load → dataloader → train loop → validate → save"骨架，`Callback` 系统通过 20 个生命周期钩子注入横切关注点；**算法层**的 `FastGenModel` 是所有蒸馏方法的抽象基类（全局 god node #1，degree 94），各方法子类实现 `single_train_step()`；**模型与数据层**的 `FastGenNetwork` 是网络架构抽象，`noise_schedule` 独立模块解耦了"7 种调度 × 11 种网络"的组合爆炸；**基础设施层**封装分布式训练（DDP/FSDP2）、检查点、auto-resume 等环境特定逻辑。依赖方向严格自上而下，上层不感知下层实现细节。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|----------------------|
| 入口与配置层 | `train.py` `configs/` `utils/__init__.py` | 声明式配置 + 延迟实例化，把"要什么"与"怎么做"解耦 |
| 编排层 | `trainer.py` `callbacks/` | 固定训练骨架流程，横切关注点用回调注入而非硬编码 |
| 算法层 | `methods/` | 蒸馏算法容器，持有网络并定义 `single_train_step` 契约 |
| 模型与数据层 | `networks/` `datasets/` | 纯前向计算 + 数据加载，与训练算法无关可独立复用 |
| 基础设施层 | `utils/` | 封装分布式/检查点/auto-resume 等环境特定逻辑，可替换 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `Trainer.run()` in `trainer.py:67` | 固定训练骨架，钩子点留给 Callback 和子类 |
| 观察者 | `Callback` + `CallbackDict` in `callbacks/callback.py` | 横切关注点（EMA/日志/裁剪）可插拔，Trainer 不感知具体回调 |
| 策略 | `BaseNoiseSchedule` 7 子类 in `noise_schedule.py` | 噪声调度可互换，网络与调度解耦（7+11 vs 77） |
| 装饰器 | `EDMPrecond` in `networks/EDM/network.py:808` | 包装底层 U-Net，前后加 EDM 预处理，不改原模型 |
| 组合 | `FastGenModel` 持有 `FastGenNetwork` | "method 包 network"——一个 method 可持多网络（student+teacher+EMA） |
| 工厂 | `instantiate()` in `utils/__init__.py:60` | 配置驱动递归实例化，统一 model/dataloader/optimizer 创建 |
| 延迟初始化 | `LazyCall` in `utils/__init__.py:108` | 配置存"类+参数"不立即执行，支持序列化与编辑 |
| 策略 | `AutoResumeInterface` in `utils/autoresume.py:39` | 集群抢占恢复（SLURM/K8s）环境特定，用户实现 4 方法即可对接 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `FastGenModel` | 蒸馏算法容器（nn.Module） | 训练全程 | 持有 `net`/`teacher`/`ema`/`discriminator` |
| `FastGenNetwork` | 网络架构（nn.Module） | 训练+推理 | 被 `FastGenModel` 组合持有，持有 `noise_scheduler` |
| `BaseNoiseSchedule` | 噪声调度数学框架 | 与 network 同生命周期 | 被 `FastGenNetwork.set_noise_schedule` 创建 |
| `Trainer` | 训练循环编排器 | 训练全程 | 持有 `callbacks`/`checkpointer`/`auto_resume` |
| `Callback` | 横切关注点钩子 | 训练全程 | 被 `CallbackDict` 管理，注入 `config`/`trainer` 引用 |
| `BaseConfig` | 顶层配置（attrs） | 配置加载到训练结束 | 组合 `model`/`trainer`/`dataloader_train` 等子配置 |
| `Checkpointer` | 检查点持久化 | 训练全程 | 被 `Trainer` 持有，`FSDPCheckpointer` 适配 FSDP |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|---------|--------|---------|
| `FastGenModel` | `methods/model.py:26` | `DMD2Model`/`CMModel`/`LADDModel`/`SFTModel`/`KDModel` 等 | `methods/__init__.py` 导出 + config `model_class: L(XxxModel)` |
| `FastGenNetwork` | `networks/network.py:13` | `EDMPrecond`/`Wan`/`Flux`/`DiT`/`CosmosPredict2` 等 | `configs/net.py` 的 `LazyCall` 定义 |
| `BaseNoiseSchedule` | `noise_schedule.py:23` | `EDMNoiseSchedule`/`AlphasNoiseSchedule`/`RFNoiseSchedule` 等 7 种 | `NOISE_SCHEDULES` dict 注册表 + `get_noise_schedule()` 工厂 |
| `Callback` | `callbacks/callback.py:65` | `EMACallback`/`WandbCallback`/`GradClipCallback` 等 | config `trainer.callbacks` dict + `instantiate` |
| `AutoResumeInterface` | `utils/autoresume.py:39` | `NoOpAutoResume`（默认）/ 用户自定义 | `create_auto_resume()` 工厂 |

---

## 代码目录

```
FastGen/
├── train.py                 # 训练入口（46 行）：parse_args → instantiate → Trainer.run
├── fastgen/
│   ├── trainer.py           # 主训练循环 Trainer（549 行，god node degree 16）
│   ├── callbacks/           # 回调系统（11 文件）：Callback 基类 20 钩子 + EMA/Wandb/GradClip
│   ├── configs/             # 配置系统（95 文件）：BaseConfig + LazyCall + experiments/methods 两层
│   ├── methods/             # 蒸馏方法（18 文件）：FastGenModel 基类 + CM/DMD2/LADD/SFT/KD
│   ├── networks/            # 网络架构（35 文件，16817 行）：FastGenNetwork + 11 架构 + noise_schedule
│   ├── datasets/            # 数据加载（9 文件）：class-conditional + WebDataset 图像/视频
│   ├── utils/               # 基础设施（15 文件）：distributed/checkpointer/autoresume/logging
│   └── third_party/         # 第三方依赖（Depth Anything V2 等，vendored）
├── scripts/                 # 推理与评估脚本（inference/ + fid/）
├── tests/                   # 单元测试
├── Makefile                 # lint/format/test 命令
└── requirements.txt         # 依赖（torch≥2.6, diffusers 0.35.1, hydra-core 等）
```

`third_party/` 是 vendored 第三方代码（如 `Depth Anything V2` 深度估计、`wan_prompt_expand` 提示词扩展），非 FastGen 自身逻辑，本文不展开。`configs/` 虽含 95 文件但多为各实验的配置声明（`create_config()`），核心逻辑集中在 `config.py`/`config_utils.py`/`net.py`/`data.py`/`opt.py`。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/fastgen-internals/module-dependencies.svg)

依赖方向：`Trainer`（编排层）调用 `FastGenModel.single_train_step` 进入算法层；`FastGenModel` 组合持有 `FastGenNetwork`（self.net）并依赖 `configs` 的 `LazyCall` 实例化网络；`Trainer` 还实例化 `datasets` 的 dataloader 并依赖 `utils` 的 checkpointer/distributed；`networks` 在 forward 中调用 `utils` 的分布式原语（`is_rank0`）。虚线为配置/基础设施依赖，实线为运行时调用。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 训练循环核心 | 训练骨架编排 + 回调分发 | `Trainer.run()` | 模板方法固定流程，横切关注点用回调解耦 | [01-trainer](01-trainer) |
| 蒸馏方法 | 各蒸馏算法实现 | `FastGenModel.single_train_step()` | 算法可互换，"method 包 network" 组合模式 | [02-methods](02-methods) |
| 网络架构 | 11 种生成模型 + 噪声调度 | `FastGenNetwork.forward()` | 网络×调度解耦（7+11 vs 77 组合） | [03-networks](03-networks) |
| 配置系统 | 声明式配置 + 递归实例化 | `instantiate()` | 配置与代码解耦，LazyCall 延迟实例化 | [04-configs](04-configs) |
| 数据集 | class-conditional + WebDataset | `BaseWDSLoader._pipeline()` | 图像/视频/latent 多模态统一接口 | [05-datasets](05-datasets) |
| 分布式基础设施 | DDP/FSDP2 + 检查点 + auto-resume | `synchronize()`/`Checkpointer` | 环境特定逻辑可替换，不污染训练逻辑 | [06-utils](06-utils) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

从 `train.py` 入口到训练循环启动，对象装配链路：

```
train.py:main(config)                                    # train.py:23
├── config.model_class.config = config.model             # train.py:25 — 注入 model config 到 LazyCall
├── model = instantiate(config.model_class)              # train.py:26 — 递归实例化 FastGenModel 子类
│   └── instantiate() 递归：                             # utils/__init__.py:60
│       ├── 解析 _target_ → DMD2Model 类
│       ├── instantiate(config) → attrs 对象直接返回
│       └── DMD2Model(config=<BaseModelConfig>)          # 构造时 build_model() → instantiate(config.net) → FastGenNetwork
├── config.model_class.config = None                     # train.py:27 — 清理引用
├── fastgen_trainer = Trainer(config)                    # train.py:32
│   ├── CallbackDict(config, trainer=self)               # trainer.py:52 — 实例化所有 callback，注入 config/trainer
│   ├── create_auto_resume(...)                          # trainer.py:54 — 默认 NoOpAutoResume
│   └── Checkpointer / FSDPCheckpointer                  # trainer.py:61 — 按 config.trainer.fsdp 选择
└── fastgen_trainer.run(model)                           # train.py:37
    ├── on_model_init_start → load_pretrained_ckpt       # trainer.py:81
    ├── model.on_train_begin(is_fsdp=...)                # trainer.py:97
    ├── ddp.model_to_ddp / fsdp.model_to_fsdp            # trainer.py:107/111
    ├── model.init_optimizers()                          # trainer.py:125 → model.py:530
    ├── auto_resume.init() → checkpointer.load(...)      # trainer.py:131-148
    └── instantiate(dataloader_train)                    # trainer.py:166
```

**对象装配关键**：配置来自 Python 文件的 `create_config()` 函数（`importlib.import_module` 加载），命令行 `- key=value` 通过 Hydra `compose` override（attrs → dict → DictConfig → hydra.compose → attrs 往返）。实例化顺序：先 `model`（含 `net`/`teacher`/`ema` 子网络）→ 再 `Trainer`（含 `callbacks`/`checkpointer`）→ `Trainer.run` 内实例化 dataloader。依赖注入通过 `instantiate(config)` 工厂方法 + `callback.config = config; callback.trainer = trainer` 反向引用注入。

### 核心运行流程

FastGen 的运行时核心有三条主链路：**标准训练 step**（所有方法共用）、**DMD2 交替优化**（对抗蒸馏特有）、**auto-resume 抢占恢复**（大规模训练容错）。

#### 训练主链路：一个 step 的完整数据流

业务流程：取 batch → 预处理（VAE/augment）→ 方法 `single_train_step` → 网络前向 + loss → backward + optimizer → 回调（EMA/日志）

![训练数据流](/vibe-reading/images/articles/fastgen-internals/data-flow.svg)

文字描述：`Trainer.train_step`（`trainer.py:285`）先设 `sync_grads` 标志（梯度累积仅最后一轮同步），在 `model.autocast()` 上下文中调用 `model.single_train_step(data, iteration)`——这是 `FastGenModel` 的抽象方法，由具体蒸馏方法（DMD2/CM/SFT…）实现，内部调用 `self.net`（`FastGenNetwork`）做前向、`self.net.noise_scheduler.forward_process` 加噪、`common_loss.py` 算 loss。返回 `loss_map` 后，`grad_scaler.scale(loss/rounds).backward()` 反向传播；累积最后一轮触发 `on_optimizer_step_begin`（GradClipCallback 裁剪梯度）→ `model.optimizers_schedulers_step` → `optimizers_zero_grad`（zero after step 以尽早释放显存）。最后 `on_training_step_end` 触发 EMACallback 更新 EMA 权重、WandbCallback 记录 loss 和样本。数据结构变化：dataloader 产出 `dict(real, condition, neg_condition)` → `preprocess_data` 做 VAE/text encode → `FastGenModel._prepare_training_data` 提取 `real_data`/`condition` → 网络前向产出 `gen_data`（x0 预测）→ loss 标量。

#### DMD2 交替优化：student 与 fake_score/discriminator 轮流训练

业务流程：每个 iteration 按 `iteration % student_update_freq` 分流——`==0` 走 student 更新（VSD+GAN loss 优化 self.net），`!=0` 走 fake_score/discriminator 更新（DSM+GAN loss 优化 fake_score 和 discriminator）。

![DMD2 交替训练状态流](/vibe-reading/images/articles/fastgen-internals/state-flow.svg)

文字描述：`DMD2Model.single_train_step`（`dmd2.py:423`）先调 `_setup_grad_requirements` 切换 `requires_grad`——student 轮冻结 fake_score/discriminator，反之亦然。student 更新时（`_student_update_step`），student 生成 `gen_data` → forward process 加噪 → teacher 和 fake_score 各预测 x0 → `variational_score_distillation_loss`（`common_loss.py:63`）用 `(fake_score_x0 - teacher_x0) * w` 作伪梯度方向 → 加 GAN generator loss。fake_score 更新时，fake_score 通过 `denoising_score_matching_loss` 向 teacher 对齐，discriminator 用 teacher 中间特征做 real/fake 判别。关键设计：teacher 始终 `eval().requires_grad_(False)`，`get_optimizers(iteration)` 按 iteration 返回不同 optimizer 组——同一模型不同阶段优化不同参数。

#### 容错链路：auto-resume 抢占恢复

大规模训练在共享集群上常被抢占（SLURM preemption/K8s eviction）。`Trainer.auto_resume_exit`（`trainer.py:484`）每个 step 结束后调用：`synchronize()` 确保全 rank 就绪 → 仅 rank0 检查 `termination_requested()` → `dist.broadcast` 把决策广播到所有 rank → 若终止则保存 checkpoint（复用已存的或新存 `latest_ar.pth`）→ rank0 调 `request_resume()` 重新提交作业。恢复时 `Trainer.run` 调 `auto_resume.get_resume_details()` 获取 `save_path`，用 `checkpointer.load` 恢复 iteration/权重/optimizer/EMA/callback 状态，并设 `dataloader.sampler_start_idx` 跳过已训练数据。策略模式让用户只实现 4 个方法即可对接任意调度器。

---

## 典型修改场景

#### 场景 1：新增一种蒸馏方法

需修改：
- 新建 `fastgen/methods/<category>/<new>.py`，定义 `NewModel(FastGenModel)`，实现 `single_train_step()` 和 `_get_outputs()`（`model.py:503/515` 抽象方法）
- 如需 teacher/discriminator，override `build_model()` 调 `super().build_model()` 后追加（参考 `dmd2.py:40`）
- 新建 `fastgen/configs/methods/config_<new>.py`，定义 `ModelConfig(BaseModelConfig)` + `Config(BaseConfig)` 切换 `model_class`
- 在 `fastgen/methods/__init__.py` 添加导出
- 共享 loss 加到 `fastgen/methods/common_loss.py`

#### 场景 2：新增一种网络架构

需修改：
- 新建 `fastgen/networks/<Name>/network.py`，实现 `<Name>(FastGenNetwork)`，必须实现 `forward()`（`network.py:156` 抽象方法），可选 `sample()`/`fully_shard()`
- 视频因果模型继承 `CausalFastGenNetwork`（`network.py:211`），实现 `clear_caches()`
- 在 `fastgen/configs/net.py` 添加 `LazyCall` 配置
- 不需修改 `methods/` 或 `trainer.py`——网络通过 `instantiate(config.net)` 注入

#### 场景 3：新增一个训练回调

需修改：
- 新建 `fastgen/callbacks/<name>.py`，继承 `Callback`（`callback.py:65`），覆写所需 `on_xxx` 钩子（20 个可选）
- 在 config 的 `trainer.callbacks` dict 添加 `_target_` 条目——`CallbackDict.__init__` 自动 `instantiate` 并注入 `config`/`trainer`
- **不修改 Trainer**——参考 `GradClipCallback.on_optimizer_step_begin`（`grad_clip.py:159`）

---

## 测试体系

```
tests/
├── test_configs.py        # 配置加载与 override 测试
├── test_dataloaders.py    # 数据加载器测试
├── test_methods.py        # 蒸馏方法测试
├── test_networks.py       # 网络架构测试
├── test_noise_schedule.py # 噪声调度数学测试
├── test_utils.py          # 基础设施测试
└── test_trainer.py        # Trainer 集成测试
```

| 代码层 | 测试类型 |
|--------|----------|
| methods/networks | Unit Test（前向/loss 数值） |
| configs/utils | Unit Test（实例化/序列化） |
| trainer | Integration Test（端到端 step） |

运行：`make pytest`（`ulimit -n 4096 && pytest --ignore=FASTGEN_OUTPUT --ignore third_party`）。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `train.py` 的 `main()` → `utils/scripts.py` 的 `setup()` → `trainer.py` 的 `Trainer.run()` → `trainer.py:285` 的 `train_step()`
- **第二遍：理解配置驱动**
  `configs/config.py` 的 `BaseConfig` → `utils/__init__.py` 的 `LazyCall` + `instantiate()` → `configs/config_utils.py` 的 `override_config_with_opts()`
- **第三遍：理解算法抽象**
  `methods/model.py` 的 `FastGenModel`（重点 `single_train_step` 抽象 + `build_model`/`init_optimizers`） → `methods/distribution_matching/dmd2.py` 的 `DMD2Model._student_update_step` → `methods/common_loss.py` 的 4 个共享 loss
- **第四遍：理解网络与噪声调度**
  `networks/network.py` 的 `FastGenNetwork` → `networks/noise_schedule.py` 的 `BaseNoiseSchedule` + `convert_model_output` → `networks/EDM/network.py` 的 `EDMPrecond`（装饰器模式） → 选择一个视频网络 `networks/Wan/network.py` 深入
- **第五遍：选择重点模块深入阅读**
  [训练循环核心](01-trainer) · [蒸馏方法](02-methods) · [网络架构](03-networks) · [配置系统](04-configs) · [数据集](05-datasets) · [分布式基础设施](06-utils)

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| 蒸馏（Distillation） | 把多步扩散采样压缩成少步生成的训练技术 |
| CM | Consistency Model，一致性模型 |
| DMD2 | Distribution Matching Distillation v2，分布匹配蒸馏 |
| LADD | Latent Adversarial Diffusion Distillation |
| VSD | Variational Score Distillation，变分分数蒸馏（DMD2 核心 loss） |
| DSM | Denoising Score Matching，去噪分数匹配 |
| EMA | Exponential Moving Average，指数移动平均（权重平滑） |
| FSDP2 | Fully Sharded Data Parallel v2，PyTorch 全分片数据并行 |
| noise schedule | 噪声调度，定义扩散过程的时间步-噪声量映射 |
| pred_type | 预测类型（x0/eps/v/flow），网络输出的 4 种参数化 |
| CFG | Classifier-Free Guidance，无分类器引导 |

### 参考资料

- [FastGen GitHub](https://github.com/NVlabs/FastGen) · [Demo Video](https://youtu.be/xEKcP-SwBBY)
- [DMD2 论文](https://arxiv.org/abs/2405.14867) · [CM 论文](https://arxiv.org/abs/2303.01469) · [LADD 论文](https://arxiv.org/abs/2403.12015)
- [EDM 论文（Karras et al.）](https://arxiv.org/abs/2206.00364) · [Self-Forcing 论文](https://arxiv.org/abs/2506.08009)
- [Hydra 文档](https://hydra.cc/) · [OmegaConf](https://omegaconf.readthedocs.io/) · [PyTorch FSDP2](https://docs.pytorch.org/docs/stable/fsdp.html)
