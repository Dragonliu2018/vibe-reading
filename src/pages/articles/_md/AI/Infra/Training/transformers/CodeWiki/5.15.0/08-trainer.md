---
source:
  type: "源码解读"
  project: "transformers"
  url: "https://github.com/huggingface/transformers"
title: "训练框架"
date: "2026-08-18T16:40:20+08:00"
category: [AI, Infra, Training, transformers, CodeWiki, "5.15.0"]
tags: ["transformers", "Trainer", "训练循环", "梯度累积", "TrainingArguments"]
description: "Trainer 是模型无关的训练循环编排器，靠 model.forward + data_collator + compute_loss 三角解耦训练任意架构。两层嵌套循环实现梯度累积，AMP/分布式委托给 accelerate。本文解读其解耦与扩展设计。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/transformers/CodeWiki/5.15.0/00-overview)

---

## 模块定位

`Trainer` 是 transformers 的训练循环编排器——它包装用户的模型，编排 forward→backward→step 三段式训练循环，管理 checkpoint/日志/评估/保存。它独立成模块，是因为训练循环逻辑跨数百模型架构通用，把它抽出来让用户不用为每个模型重写训练代码。关键定位是"模型无关"——Trainer 不 import 任何具体模型类，靠接口契约 + data_collator + compute_loss 三角解耦。

边界：Trainer 只管"循环编排与 checkpoint"，不管分布式/AMP 底层（委托给 `accelerate`），也不管模型结构（靠 model.forward 契约）。

## 模块架构

训练框架跨四个文件：

- **Trainer 主类**：`trainer.py:258`，持有 `model`/`model_wrapped`（DDP/FSDP 包装后）/`args`/`data_collator`/`train_dataset`/`processing_class`/`optimizer`/`lr_scheduler`/`accelerator`/`callback_handler`/`state`/`control`。模板方法 `train`（L1347）、`_inner_training_loop`（L1456）、`_run_epoch`（L1678）、`training_step`（L1892）、`compute_loss`（L1965）、`evaluate`（L2554）、`_save_checkpoint`（L3079）、`create_optimizer`（L1168）、`create_scheduler`（L1244）。
- **TrainingArguments dataclass**：`training_args.py:179`，200+ 字段用 `field(default=..., metadata={"help":...})` 声明，`__post_init__`（L1483）做默认值规范化/Enum 转换/自动推导/校验/混合精度设置。
- **优化器**：`optimization.py`，`Adafactor`（L1057）+ 各类 LR scheduler；AdamW 本身用 `torch.optim.AdamW`，经 `get_optimizer_cls_and_kwargs` 按 `args.optim` 路由。
- **PyTorch 工具**：`trainer_pt_utils.py`，`LabelSmoother`（L437，支持 shift_labels+精确 token 缩放）、`LengthGroupedSampler`（L521，按长度分组减 padding）、`nested_concat`/`nested_numpify`（递归处理嵌套 tensor）、`distributed_concat`（all_gather）。

## 调用链路

`train` → `_inner_training_loop` → `_run_epoch` 的训练循环：

```
train(resume_from_checkpoint)                    trainer.py:1347
├── model_init（若存在）→ 新模型
├── gradient_checkpointing_enable / NEFTune hook
├── _load_from_checkpoint（恢复权重+TrainerState）
└── _inner_training_loop(batch_size, args)       # L1456
    ├── get_train_dataloader / set_initial_training_values / _init_training_state
    ├── _prepare_for_training → _wrap_model + create_optimizer + accelerator.prepare + create_scheduler
    ├── callback_handler.on_train_begin
    └── for epoch in range(epochs):
        ├── callback_handler.on_epoch_begin
        └── _run_epoch(model, epoch, dataloader, ...)   # L1678
            └── for update_step in range(num_update_steps_per_epoch):  # 外层：每 optimizer step
                ├── get_batch_samples(epoch_iterator, gradient_accumulation_steps)  # 预取 N 个 batch
                │   └── _get_num_items_in_batch（精确 token 数，用于 loss 缩放）
                └── for i, inputs in enumerate(batch_samples):  # 内层：每 micro-batch
                    ├── do_sync_step = (step+1) % grad_accum == 0
                    ├── callback_handler.on_step_begin
                    ├── with accelerator.no_sync(model) [非最后 step]:  # 禁 DDP 梯度同步
                    │     training_step(model, inputs, num_items_in_batch)  # L1892
                    │       ├── _prepare_inputs → 移到 device
                    │       ├── compute_loss_context_manager（AMP，v5 委托 accelerate）
                    │       ├── compute_loss → model(**inputs) → outputs["loss"]
                    │       └── accelerator.backward(loss)
                    └── if do_sync_step:
                        ├── _clip_grad_norm
                        ├── on_pre_optimizer_step / optimizer.step / on_optimizer_step
                        ├── lr_scheduler.step / model.zero_grad / global_step += 1
                        ├── on_step_end → DefaultFlowCallback 设 control.should_log/eval/save
                        └── _maybe_log_save_evaluate（log / _evaluate / _save_checkpoint）
```

数据流：`dataset → data_collator → inputs dict → model(**inputs) → loss → backward → grad → optimizer.step`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `train` in `trainer.py:1347` | 训练入口 | 模板方法，编排初始化→循环→收尾 |
| `_run_epoch` in `trainer.py:1678` | 单 epoch 循环 | 两层嵌套实现梯度累积 |
| `training_step` in `trainer.py:1892` | 单步 forward+backward | 子类可覆写 |
| `compute_loss` in `trainer.py:1965` | 计算 loss | 默认取 outputs["loss"]，可覆写 |
| `_save_checkpoint` in `trainer.py:3079` | 保存检查点 | |
| `create_optimizer` in `trainer.py:1168` | 创建优化器 | 按 args.optim 路由 |
| `evaluate` in `trainer.py:2554` | 评估 | |

</details>

## 核心实现

### 模型无关的三角解耦

Trainer 支持数百模型架构，不可能为每种写专用逻辑，靠三角解耦：① **模型接口约定**——模型 `forward()` 返回 `ModelOutput`（含 `loss` 字段），Trainer 默认取 `outputs["loss"]`（L2038）；② **data_collator**——把原始 dataset 元素组装成 model forward 接受的 dict，用户可自定义；③ **compute_loss 可覆盖**——子类实现自定义 loss（对比学习、多任务）。另有内省机制：`inspect.signature(model.forward)`（L502）检测是否接受 `**kwargs` 决定是否传 `num_items_in_batch`；`find_labels(model.__class__)`（L513）自动找出 forward 的 label 参数名。这样用户传不同模型，同一套 Trainer 代码都能训。

### 两层嵌套循环的梯度累积

`_run_epoch`（L1678）用两层循环：外层每个 optimizer step 预取 `gradient_accumulation_steps` 个 batch（`get_batch_samples` 一次性取 N 个以便预先算 `num_items_in_batch` 整个累积窗口的精确 token 数），内层每个 micro-batch 走 `training_step`。关键：① **梯度同步控制**（L1749）——非最后 micro-batch 用 `accelerator.no_sync(model)` 禁止 DDP all-reduce，减少通信开销；② **loss 缩放**——模型不支持 `num_items_in_batch` 时 `loss = loss / grad_accum_steps` 线性缩放，支持时传入精确 token 数由模型内部处理；③ **step 时机**——仅 `do_sync_step=True` 时 `optimizer.step()`+`lr_scheduler.step()`+`zero_grad()`+`global_step+=1`。

### AMP 下沉到 accelerate

v5.15.0 中 AMP 已**下沉到 accelerate**：`Trainer.autocast_smart_context_manager()`（L2066）返回 `contextlib.nullcontext()`，实际 `torch.autocast` 由 `accelerator.prepare(model)` 注入的 hook 管，`accelerator.backward(loss)` 处理 fp16 的 loss scaling，`TrainingArguments.__post_init__` 设 `self.mixed_precision = "fp16"/"bf16"`（L1568）由 accelerator 读。Trainer 从"自己管 AMP"演进为"委托 accelerate 管 AMP"，只负责循环编排。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `train`/`_inner_training_loop`/`_run_epoch`/`training_step`/`compute_loss` | 骨架固定，子类覆写 compute_loss/training_step |
| 观察者 | `TrainerCallback` + `CallbackHandler`（`trainer_callback.py:429`） | 14 个事件钩子，callback 改 TrainerControl 间接影响流程 |
| 策略 | AMP/分布式 context manager | v5 下沉到 accelerate |
| dataclass 配置 | `TrainingArguments`（L179） | 声明式 200+ 字段 + HfArgumentParser 自动生成 CLI |
| 委托 | 分布式/AMP/device 委托给 `accelerator` | Trainer 聚焦循环编排，不碰分布式底层 |

## 模块间交互

Trainer 不直接 import 具体模型类，靠鸭子类型：`model.forward(**inputs)`、`model.config`（读 `use_cache`/`problem_type`/`is_encoder_decoder`）、`inspect.signature(model.forward)` 内省。关键 import：`integrations`（wandb/tensorboard callback）、`data.data_collator`、`trainer_callback`（CallbackHandler/TrainerState/TrainerControl）、`trainer_pt_utils`（LabelSmoother/LengthGroupedSampler）、`optimization`（get_scheduler/Adafactor）。`accelerator` 委托 DDP/FSDP/DeepSpeed 包装与 backward。callback 不直接调 Trainer 方法，而是改 `TrainerControl` 布尔标志（`should_log`/`should_evaluate`/`should_save`/`should_training_stop`）由 `DefaultFlowCallback.on_step_end` 设置，`_maybe_log_save_evaluate` 据标志触发。

## 扩展方式

自定义 compute_loss（方法 A 传 `compute_loss_func` 参数无需子类化，方法 B 子类覆写 `compute_loss`，影响 `trainer.py:1965`）。新增 callback：继承 `TrainerCallback` 实现钩子（`on_pre_optimizer_step` L377 梯度裁剪后 step 前适合监控梯度，`on_step_end` L392 适合记指标），`trainer = Trainer(..., callbacks=[...])`。自定义采样：覆写 `_get_train_sampler`（L1022），默认据 `args.train_sampling_strategy` 选 random/sequential/group_by_length（后者用 `LengthGroupedSampler`）。
