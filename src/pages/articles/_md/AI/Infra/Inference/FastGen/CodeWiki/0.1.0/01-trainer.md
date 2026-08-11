---
source:
  type: "源码解读"
  project: "FastGen"
  url: "https://github.com/NVlabs/FastGen"
title: "训练循环核心"
date: "2026-08-11T15:41:00+08:00"
category: [AI, Infra, Inference, FastGen, CodeWiki, "0.1.0"]
tags: ["FastGen", "Python", "PyTorch", "扩散模型", "蒸馏"]
description: "FastGen 训练循环核心模块深度解读：Trainer 模板方法、Callback 观察者模式（20 钩子）、CallbackDict 动态分发、梯度累积与 DDP/FSDP 同步控制、auto-resume 策略模式。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FastGen/CodeWiki/0.1.0/00-overview)


## 模块定位

训练循环核心模块由 `fastgen/trainer.py`（549 行）和 `fastgen/callbacks/`（11 文件，1571 行）组成，是 FastGen 的编排层。`Trainer` 用模板方法模式固定训练骨架流程（init → load → loop → validate → save），`Callback` 系统用观察者模式把 EMA、梯度裁剪、日志等横切关注点从训练循环中解耦——Trainer 只调 `self.callbacks.on_xxx()`，不感知具体有哪些回调。这种分离让新增功能无需改动 `Trainer.run()` 核心逻辑。

---

## 模块架构

![训练循环核心模块架构](/vibe-reading/images/articles/fastgen-internals/trainer-architecture.svg)

`Trainer` 是唯一编排器，持有 `CallbackDict`（回调容器）、`Checkpointer`（持久化）、`AutoResumeInterface`（抢占恢复）三个协作者。`CallbackDict` 通过 `__getattr__` 动态分发——Trainer 调任意 `on_xxx` 方法时，Python 触发 `__getattr__` 返回闭包，遍历所有注册的 callback 逐个调用同名方法。Callback 子类（EMA/Wandb/GradClip）通过 config 的 `_target_` 动态实例化，Trainer 不 import 任何具体回调类。

---

## 调用链路

![训练一个 step 的调用链路](/vibe-reading/images/articles/fastgen-internals/trainer-flow.svg)

`Trainer.run()` 是主模板方法，固定骨架：

```
Trainer.run(model)                                          # trainer.py:67
├── on_model_init_start → load_pretrained_ckpt              # trainer.py:81
├── model.on_train_begin(is_fsdp=...)                       # trainer.py:97
├── ddp.model_to_ddp / fsdp.model_to_fsdp                   # trainer.py:107/111
├── on_optimizer_init_start → model.init_optimizers()       # trainer.py:125
├── auto_resume.init() → checkpointer.load [if resume]     # trainer.py:131-148
├── on_dataloader_init_end → on_train_begin                 # trainer.py:171
└── for iter_cur in range(iter_start+1, max_iter):          # trainer.py:181
    ├── on_training_step_begin                              # trainer.py:182
    └── for grad_accum_iter in range(grad_accum_rounds):    # trainer.py:183
        ├── data = next(dataloader); preprocess_data(data)  # trainer.py:184-185
        └── train_step(model_ddp, model, data, iter, accum) # trainer.py:192
            ├── sync_grads = (accum == rounds-1)            # trainer.py:308
            ├── model.autocast() → single_train_step        # trainer.py:313-314
            ├── on_backward_begin                           # trainer.py:316
            ├── grad_scaler.scale(loss/rounds).backward()   # trainer.py:319
            └── [if last]: on_optimizer_step_begin          # trainer.py:333
                → optimizers_schedulers_step → zero_grad    # trainer.py:334-336
    ├── on_training_step_end → [EMA/Wandb]                  # trainer.py:194
    ├── [validate] / [save_checkpoint]                      # trainer.py:203-211
    └── auto_resume_exit                                    # trainer.py:213
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `Trainer.run()` `trainer.py:67` | 训练全流程模板方法 | 骨架固定，钩子留给回调 |
| `Trainer.train_step()` `trainer.py:285` | 单步 forward+backward | `sync_grads` 仅累积最后一轮同步 |
| `Trainer.preprocess_data()` `trainer.py:375` | VAE/text encode + augment | i2v/v2v 条件预处理分支 |
| `Trainer.validate()` `trainer.py:341` | `@torch.no_grad` 验证 | — |
| `Trainer.save_checkpoint()` `trainer.py:263` | 触发 checkpointer.save | 保存后 `gc.collect()+empty_cache` |
| `Trainer.auto_resume_exit()` `trainer.py:484` | 抢占检测+广播 | rank0 决策 + `dist.broadcast` |
| `CallbackDict.__getattr__` `callback.py:51` | 动态分发 on_xxx 到所有回调 | 闭包遍历，不检查返回值 |
| `Callback.state_dict()` `callback.py:179` | 回调状态序列化 | 与 checkpoint 一起存/取 |

</details>

---

## 核心实现

### Trainer 模板方法与回调解耦

`Trainer` 类（`trainer.py:28`）的核心属性在 `__init__` 中装配：

```python title="trainer.py"
class Trainer:
    def __init__(self, config: BaseConfig, auto_resume: Optional[AutoResumeInterface] = None):
        self.config = config
        self.auto_resume = create_auto_resume(...)           # 默认 NoOpAutoResume
        self.callbacks = CallbackDict(config=config, trainer=self)  # 实例化所有 callback
        self.checkpointer = Checkpointer(...) or FSDPCheckpointer(...)  # 按 fsdp 选择
```

`Trainer.run()`（`trainer.py:67`）是模板方法——固定了"init → load → dataloader → train loop → validate → save → auto_resume_exit"顺序，每个阶段插入 `self.callbacks.on_xxx()` 钩子。关键设计：**Trainer 的 `run()` 和 `train_step()` 中没有任何 EMA/Wandb/GradClip 的直接逻辑**——梯度裁剪在 `GradClipCallback.on_optimizer_step_begin`（`grad_clip.py:159`），EMA 更新在 `EMACallback.on_training_step_end`（`ema.py:93`），日志在 `WandbCallback.on_training_step_end`（`wandb.py:365`）。这样设计是因为这些横切关注点有不同生命周期（EMA 需跨 checkpoint 持久化、Wandb 需 wandb_id 持久化）、不同执行频率（裁剪每 optimizer step、日志每 `logging_iter` 步）、可独立开关——写进 Trainer 会变成上帝类。

### Callback 观察者模式与 CallbackDict 动态分发

`Callback` 基类（`callback.py:65`）定义 **20 个钩子方法** + 2 个状态方法，覆盖训练全生命周期：

```python title="callbacks/callback.py"
class Callback:
    config: "BaseConfig"
    trainer: "Trainer"
    # 应用生命周期
    def on_app_begin(self) -> None                          # callback.py:69
    def on_app_end(self, model, iteration=0) -> None        # callback.py:176
    # 训练循环（最常用）
    def on_train_begin(self, model, iteration=0) -> None    # callback.py:98
    def on_training_step_begin(self, model, iteration=0)    # callback.py:101
    def on_training_step_end(self, model, data, output, loss_dict, iteration)  # callback.py:128
    def on_optimizer_step_begin(self, model, iteration=0)   # callback.py:138
    # 验证 / 检查点 / 模型初始化 … 共 20 个
    def state_dict(self) -> dict                            # callback.py:179
    def load_state_dict(self, state_dict)                   # callback.py:182
```

所有方法默认 `pass`，子类按需覆写。`CallbackDict`（`callback.py:18`）是容器和分发器：

```python title="callbacks/callback.py"
class CallbackDict:
    def __init__(self, config: BaseConfig, trainer: Trainer):
        self._callbacks = {}                                # name -> Callback 实例
        # 从 config.trainer.callbacks 遍历 instantiate(current_callback_cfg)
        # 注入 callback.config = config; callback.trainer = trainer
        # 立即调用 on_app_begin()

    def __getattr__(self, method_name: str) -> Callable:
        # 对任意 on_xxx，返回闭包遍历 self._callbacks.values() 逐个调用
        # 特殊处理 state_dict / load_state_dict
```

当 Trainer 调 `self.callbacks.on_training_step_begin(model, iteration=iter_cur)` 时，`__getattr__` 被触发，返回 `callbacks_wrapper` 闭包（`callback.py:51`），遍历所有 callback 调同名方法。**Callback 不能中断训练流程**——闭包不检查返回值，唯一控制流是 `Trainer.auto_resume_exit()` 在 Trainer 层实现。

### 梯度累积与 DDP/FSDP 同步控制

梯度累积在 `Trainer.run()` 内层循环（`trainer.py:183`），`grad_accum_rounds` 次共享一个 optimizer step：

```python title="trainer.py"
for grad_accum_iter in range(self.config.trainer.grad_accum_rounds):
    data = next(dataloader_train_iter)
    data = self.preprocess_data(model, data, augment_pipe)
    loss_map, outputs = self.train_step(model_ddp, model, data, iter_cur, grad_accum_iter)
```

`train_step`（`trainer.py:307`）的同步控制：`sync_grads = grad_accum_iter == grad_accum_rounds - 1`，前 N-1 轮 `sync_grads=False` 禁用 DDP all-reduce。`with ddp.ddp_sync_grad(model_ddp, sync_grads)`（`trainer.py:311`）和 `with fsdp.fsdp_sync_grad(model, sync_grads)`（`trainer.py:321`）分别控制两条路径。Loss 除以 `grad_accum_rounds`（`trainer.py:319`）保证等效大 batch。Optimizer step 仅最后一轮执行（`trainer.py:331`），且 **zero_grad 在 step 之后**（`trainer.py:336` 注释 `# Zero after step to free memory on active optimizers`）——尽早释放梯度显存。

### auto_resume 策略模式与 rank0 广播

`AutoResumeInterface`（`autoresume.py:39`）是抽象策略接口，4 个方法：`init()`/`get_resume_details()`/`termination_requested()`/`request_resume()`。默认 `NoOpAutoResume`（`autoresume.py:116`）全 no-op。`Trainer.auto_resume_exit`（`trainer.py:484`）每个 step 后调：`synchronize()` → rank0 检查 `termination_requested()` → `dist.broadcast` 广播决策 → 若终止则存 checkpoint + rank0 调 `request_resume()`。rank0 集中决策 + broadcast 避免多 rank 不一致死锁。策略模式让用户实现 4 方法即可对接 SLURM/K8s 调度器。

### EMA 在 Callback 而非 Trainer 的设计

`EMACallback.on_training_step_end`（`ema.py:93`）在 optimizer step 后更新 EMA：`ema_param.lerp_(net_param, 1.0 - beta)`。`on_model_init_end`（`ema.py:53`）运行时检查 `getattr(model, self.ema_name, None)`——无 EMA 层则 `self._enabled = False` 跳过。三种 beta 衰减策略：`constant`/`power`/`halflife`（`ema.py:114`）。放 callback 而非 Trainer 的原因：EMA 可选（非所有模型有）、策略可换、状态需序列化（`Callback.state_dict`）、执行时机固定由模板方法保证。FSDP2 CPU offloading 的 DTensor 特殊处理在 `ema.py:128`（标准 `lerp_` 在 CPU DTensor 上会失败）。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `Trainer.run()` `trainer.py:67` | 固定训练骨架，可变步骤用钩子注入 |
| 观察者 | `Callback` + `CallbackDict` `callback.py:65/18` | 横切关注点可插拔，Trainer 不感知具体回调 |
| 策略 | `AutoResumeInterface` `autoresume.py:39` | 集群抢占恢复环境特定，4 方法对接任意调度器 |
| 装饰器 | `rank0_only` `distributed/__init__.py:60` | rank0 逻辑自动过滤，简化分布式代码 |

---

## 模块间交互

Trainer 依赖 `methods.FastGenModel`（调 `single_train_step`/`init_optimizers`/`optimizers_schedulers_step`）、`callbacks.CallbackDict`（编排回调）、`utils.Checkpointer`/`FSDPCheckpointer`（持久化）、`utils.autoresume.AutoResumeInterface`（抢占恢复）、`utils.distributed.ddp`/`fsdp`（分布式包装）。被 `train.py:main` 调用（`Trainer(config).run(model)`）。Callback 通过注入的 `self.trainer` 反向引用可读 Trainer 状态（如调 `self.trainer.save_checkpoint`），但不能改流程。

---

## 扩展方式

新增训练回调：新建 `fastgen/callbacks/<name>.py` 继承 `Callback`，覆写所需 `on_xxx` 钩子，在 config 的 `trainer.callbacks` dict 添加 `_target_` 条目。`CallbackDict.__init__` 自动 `instantiate` 并注入 `config`/`trainer`。参考 `GradClipCallback.on_optimizer_step_begin`（`grad_clip.py:159`）。**无需修改 Trainer**。
