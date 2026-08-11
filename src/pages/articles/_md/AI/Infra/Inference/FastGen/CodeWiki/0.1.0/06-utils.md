---
source:
  type: "源码解读"
  project: "FastGen"
  url: "https://github.com/NVlabs/FastGen"
title: "分布式基础设施"
date: "2026-08-11T15:46:00+08:00"
category: [AI, Infra, Inference, FastGen, CodeWiki, "0.1.0"]
tags: ["FastGen", "Python", "PyTorch", "扩散模型", "蒸馏"]
description: "FastGen 分布式基础设施模块深度解读：DDP/FSDP2 装配、Checkpointer 适配器模式、AutoResumeInterface 策略模式、分布式原语、loguru 日志、S3 IO。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FastGen/CodeWiki/0.1.0/00-overview)


## 模块定位

基础设施模块（`fastgen/utils/`，3067 行，15 文件）封装分布式训练（DDP/FSDP2）、检查点管理、auto-resume 抢占恢复、日志、S3 IO、LR scheduler 等环境特定逻辑。它是全局扇入最高的模块之一（`utils` 64、`logging_utils` 58、`distributed` 27），被 trainer/methods/networks/callbacks 几乎所有模块依赖。设计目标是把"与环境相关的可替换逻辑"从训练算法中隔离——分布式策略、检查点格式、调度器对接都可替换而不污染训练核心。

---

## 模块架构

![基础设施模块架构](/vibe-reading/images/articles/fastgen-internals/utils-architecture.svg)

`distributed/` 子包提供分布式原语（`synchronize`/`world_size`/`is_rank0`/`rank0_only`）+ DDP/FSDP2 装配 + S3 FileSystem DCP 适配。`checkpointer.py` 用 Wrapper 适配器统一 FSDP 与非 FSDP 的 state_dict 接口。`autoresume.py` 用策略模式对接集群调度器。`logging_utils.py` 用 loguru + rank0 过滤。`__init__.py` 的 `instantiate`/`LazyCall`/`expand_like` 是全局工具（配置模块覆盖，这里看分布式/checkpointer 部分）。

---

## 调用链路

![FSDP 装配 + 检查点 + auto_resume 链路](/vibe-reading/images/articles/fastgen-internals/utils-flow.svg)

FSDP 装配 + 检查点保存链路：

```
Trainer.run → fsdp.model_to_fsdp(model)              # fsdp.py:67
├── _get_submodules_to_shard(module, min_num_params)  # fsdp.py:219 — 按参数量阈值选分片单元
├── apply_fsdp_checkpointing(module, check_fn)        # fsdp.py:38 — 对 transformer block 加 checkpoint_wrapper
└── fully_shard(...)                                  # PyTorch FSDP2 分片

Trainer.save_checkpoint → Checkpointer.save           # checkpointer.py
├── ModelWrapper.state_dict() → model.state_dict()    # checkpointer.py:200
├── OptimizerWrapper.state_dict() → optimizer.state_dict()  # checkpointer.py:222
└── [FSDP]: FSDPCheckpointer — 特殊处理 DTensor state_dict  # checkpointer.py:248

auto_resume 恢复:
Trainer.run → auto_resume.get_resume_details()        # autoresume.py
→ Checkpointer.load(save_path)                        # checkpointer.py:148
  ├── model.load_state_dict
  ├── optimizer.load_state_dict
  └── callback.load_state_dict (各回调状态)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `synchronize()` `distributed/__init__.py:38` | barrier 同步全 rank | 封装 `dist.barrier` |
| `world_size()` `distributed/__init__.py:14` | 返回 rank 数 | — |
| `is_rank0()` `distributed/__init__.py:33` | 是否 rank0 | 日志/保存用 |
| `rank0_only(func)` `distributed/__init__.py:60` | 装饰器：仅 rank0 执行 | 装饰器模式 |
| `fsdp.model_to_fsdp()` `fsdp.py:67` | FSDP2 装配 | 按参数量阈值分片 |
| `fsdp.apply_fsdp_checkpointing()` `fsdp.py:38` | activation checkpointing | `checkpoint_wrapper` |
| `fsdp.fsdp_sync_grad()` `fsdp.py:238` | 梯度同步开关 | 梯度累积用 |
| `ddp.ddp_sync_grad()` `ddp.py` | DDP 梯度同步开关 | context manager |
| `Checkpointer.save()` `checkpointer.py` | 存 model+optim+callback | `{iteration:07d}.pth` |
| `Checkpointer.load()` `checkpointer.py:148` | 恢复 | 不存在则 return 0 |
| `FSDPCheckpointer.load()` `checkpointer.py:379` | FSDP 特殊加载 | catch Missing key 继续 |
| `create_auto_resume()` `autoresume.py:143` | 工厂 | 默认 NoOpAutoResume |
| `AutoResumeInterface` `autoresume.py:39` | 抽象策略 | 4 方法 |

</details>

---

## 核心实现

### 分布式原语与 rank0_only 装饰器

`distributed/__init__.py`（175 行）封装 7 个分布式原语：

```python title="utils/distributed/__init__.py"
def synchronize():           # dist.barrier，CPU/CUDA 兼容
def world_size():            # dist.get_world_size
def get_rank(group=None):    # dist.get_rank
def is_rank0() -> bool:      # get_rank() == 0

def rank0_only(func):        # 装饰器：仅 rank0 执行，其余 no-op
    @wraps(func)
    def wrapper(*args, **kwargs):
        if is_rank0():
            return func(*args, **kwargs)
    return wrapper

def clean_up():              # dist.destroy_process_group
def sync_all(local_all, device) -> bool:   # all_reduce OR 聚合
def move_module_to_device(module, device, fsdp_meta_init):  # 含 meta device 零内存初始化
```

自封装原因：`synchronize` 封装 barrier 屏蔽 CPU/CUDA backend 差异；`rank0_only` 装饰器简化"仅 rank0 执行"的日志/保存逻辑，避免每处写 `if is_rank0():`。

### FSDP2 装配与分片粒度控制

`fsdp.py`（262 行）的 `model_to_fsdp`（`fsdp.py:67`）装配 FSDP2：`_get_submodules_to_shard`（`fsdp.py:219`）按 `min_num_params` 阈值（默认 10M）选出需要分片的子模块——大模块单独分片，小模块合并，平衡分片粒度与通信开销。`apply_fsdp_checkpointing`（`fsdp.py:38`）对 transformer block 加 `checkpoint_wrapper`（activation checkpointing 省显存）。`fsdp_sync_grad`（`fsdp.py:238`）是 context manager，梯度累积时禁用 all-reduce。FSDP CPU offload（`fsdp.py:124` `CPUOffloadPolicy`）可卸载参数到 CPU。

### Checkpointer 适配器模式与 FSDP 特殊处理

`checkpointer.py`（459 行）用 Wrapper 适配器统一 state_dict 接口：

```python title="utils/checkpointer.py"
class ModelWrapper(Stateful):       # checkpointer.py:200 — 包装 model
    def state_dict(self): return self.model.state_dict()
class OptimizerWrapper(Stateful):   # checkpointer.py:222 — 包装 optimizer
    def state_dict(self): return self.optimizer.state_dict()
class Checkpointer:                 # checkpointer.py:28 — 非 FSDP
    def save(self, model, iteration, path): ...  # {iteration:07d}.pth
    def load(self, path) -> int: ...              # 不存在 return 0
class FSDPCheckpointer(Checkpointer):  # checkpointer.py:248 — FSDP 特殊处理
    def load(self, path):
        # catch "Missing key"/"Unexpected key" → warning + 重置 optimizer 继续
```

Wrapper 适配器统一 FSDP 和非 FSDP 的 state_dict 接口——FSDP 的 DTensor state_dict 需要特殊 gather/scatter，`FSDPCheckpointer` override load 容错处理（optimizer 不兼容时 warning + 重置而非崩溃）。checkpoint 格式 `{iteration:07d}.pth`，存 model + optimizer + scheduler + grad_scaler + callback state_dict + iteration。

### AutoResumeInterface 策略模式

`AutoResumeInterface`（`autoresume.py:39`）抽象 4 方法：`init()`/`get_resume_details()`/`termination_requested()`/`request_resume()`。`NoOpAutoResume`（`autoresume.py:116`）全 no-op 默认关闭。`create_auto_resume`（`autoresume.py:143`）工厂——用户传自定义实现则用，否则 NoOp。策略模式让集群抢占恢复（SLURM/K8s）环境特定逻辑不硬编码——用户实现 4 方法即可对接任意调度器。`Trainer.auto_resume_exit`（`trainer.py:484`）rank0 集中决策 + `dist.broadcast` 广播，避免多 rank 不一致死锁。

### logging_utils 与 lr_scheduler

`logging_utils.py`（99 行）用 loguru 封装 + `rank0_if_not_debug` 装饰器——rank0 输出日志，debug 模式全 rank 输出。选 loguru 而非 Python logging：结构化日志、零配置、更好的堆栈格式。`lr_scheduler.py`（156 行）提供 4 种 Lambda scheduler（`LambdaWarmUpCosineScheduler2` 等），通过 `get_scheduler(optimizer, config)` 工厂创建。

### io_utils S3 IO

`io_utils.py`（210 行）提供 `s3_load`/`s3_save`/`latest_checkpoint`——S3 权重加载/保存、URL 下载。`Checkpointer` 的 `use_s3` 模式走这条路径。`ImageFolderDataset` 的 S3 下载也用 `s3_load`。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 装饰器 | `rank0_only` `distributed/__init__.py:60` | rank0 逻辑自动过滤 |
| 适配器 | `ModelWrapper`/`OptimizerWrapper`/`FSDPCheckpointer` `checkpointer.py:200/222/248` | 统一 FSDP/非 FSDP state_dict 接口 |
| 策略 | `AutoResumeInterface`/`NoOpAutoResume` `autoresume.py:39/116` | 集群抢占环境特定，4 方法对接 |
| 工厂 | `create_auto_resume` `autoresume.py:143` + `get_scheduler` `lr_scheduler.py` | 按配置创建实例 |

---

## 模块间交互

utils 被几乎所有模块依赖：`distributed` 原语被 trainer（`synchronize`/`is_rank0`）、checkpointer、logging、fsdp、ddp、networks（`is_rank0`）、methods（`synchronize`/`world_size`）用；`Checkpointer` 被 `Trainer` 持有；`AutoResumeInterface` 被 `Trainer` 通过工厂持有；`logging_utils` 全局 52 文件 import；`instantiate`（`__init__.py:60`）被 configs/trainer/methods 调用。`FSDPCheckpointer` 与 `Trainer.save_checkpoint` 协作——Trainer 调 `self.checkpointer.save`，不关心 FSDP 细节。

---

## 扩展方式

新增 LR scheduler：在 `lr_scheduler.py` 加 `LambdaXxxScheduler` 类，在 `get_scheduler` 工厂加分支，config 的 `net_scheduler._target_` 指向它。修改 checkpoint 格式：继承 `Checkpointer` override `save`/`load`，在 `Trainer.__init__` 按 config 选择。适配新分布式策略：在 `distributed/` 加新文件，`Trainer.run` 加分支（参考 ddp/fsdp 现有模式）。对接新集群调度器：实现 `AutoResumeInterface` 4 方法，通过 `Trainer(config, auto_resume=MyImpl)` 注入。
