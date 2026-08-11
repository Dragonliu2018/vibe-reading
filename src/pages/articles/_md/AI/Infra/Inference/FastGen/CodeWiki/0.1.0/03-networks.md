---
source:
  type: "源码解读"
  project: "FastGen"
  url: "https://github.com/NVlabs/FastGen"
title: "网络架构"
date: "2026-08-11T15:43:00+08:00"
category: [AI, Infra, Inference, FastGen, CodeWiki, "0.1.0"]
tags: ["FastGen", "Python", "PyTorch", "扩散模型", "蒸馏"]
description: "FastGen 网络架构模块深度解读：FastGenNetwork 抽象基类、BaseNoiseSchedule 策略模式（7 子类）、EDMPrecond 装饰器、CausalFastGenNetwork 视频因果、noise_schedule 解耦组合爆炸。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FastGen/CodeWiki/0.1.0/00-overview)


## 模块定位

网络架构模块（`fastgen/networks/`，16817 行，35 文件）是 FastGen 最大的模块，包含 11 种生成模型架构（EDM/EDM2/DiT/SD15/SDXL/Flux/QwenImage/Wan/WanI2V/VaceWan/CogVideoX/CosmosPredict2）、7 种噪声调度、以及用于对抗蒸馏的判别器。核心抽象是 `FastGenNetwork`（degree 31）和 `BaseNoiseSchedule`（degree 40），两者通过策略模式解耦——网络与调度独立选择，把"7 种调度 × 11 种网络 = 77 种组合"压缩为"7 + 11 = 18 个实现"。

---

## 模块架构

![网络架构模块架构](/vibe-reading/images/articles/fastgen-internals/networks-architecture.svg)

`FastGenNetwork`（`network.py:13`）是所有架构的抽象基类，定义 `forward()` 契约并持有 `noise_scheduler`（通过 `set_noise_schedule` 工厂创建）。`BaseNoiseSchedule`（`noise_schedule.py:23`）定义扩散过程数学框架 `x_t = alpha(t)*x_0 + sigma(t)*eps`，7 个子类实现不同参数化。`EDMPrecond`（`EDM/network.py:808`）是装饰器模式代表，包装底层 U-Net 添加 EDM 预处理。视频因果模型走 `CausalFastGenNetwork`（`network.py:211`）分支，额外管理 KV cache 和分块处理。判别器独立在 `discriminators.py`，不继承 `FastGenNetwork`——消费网络中间特征做对抗训练。

---

## 调用链路

![EDMPrecond.forward 调用链路](/vibe-reading/images/articles/fastgen-internals/networks-flow.svg)

`FastGenNetwork.forward` 调用链（以 EDMPrecond 为例）：

```
EDMPrecond.forward(x_t, t, condition, r, ...)        # EDM/network.py:881
├── precond_input(x_t, t, r, sigma_data)              # EDM/network.py:755
│   ├── c_in = 1 / sqrt(sigma_data^2 + t^2)           # 输入缩放
│   └── t = t.clamp(min=eps).log() / 4                # 时间步变换
├── self.model(x_t, t, class_labels, ...)             # 底层 SongUNet/DhariwalUNet
│   └── encoder/decoder blocks: UNetBlock.forward     # EDM/network.py:274
├── precond_output(out, x_t_in, t_in, sigma_data)     # EDM/network.py:781
│   └── c_skip * x_t + c_out * out                    # 输出缩放
└── noise_scheduler.convert_model_output(x_t, out, t, src, target)  # noise_schedule.py:666
    └── if src != target: src → x0 → target            # 多态转换器
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `FastGenNetwork.forward()` `network.py:156` | 抽象：前向传播 | 支持 return_features_early 提前退出 |
| `FastGenNetwork.set_noise_schedule()` `network.py:78` | 创建 noise_scheduler | 工厂 `get_noise_schedule(schedule_type)` |
| `FastGenNetwork.sample()` `network.py:113` | 独立采样 | CFG + Euler/UniPC step |
| `FastGenNetwork.fully_shard()` `network.py:101` | FSDP2 分片 | 子类实现，默认 NotImplementedError |
| `BaseNoiseSchedule.forward_process()` `noise_schedule.py:425` | 前向加噪 `x_t = α_t x_0 + σ_t eps` | float64 精度计算 |
| `BaseNoiseSchedule.convert_model_output()` `noise_schedule.py:666` | pred_type 转换 | x0 作中间表示，4 种互转 |
| `BaseNoiseSchedule.sample_t()` `noise_schedule.py:236` | 采训练时间步 | 支持 uniform/lognormal/logitnormal 等 |
| `BaseNoiseSchedule.get_t_list()` `noise_schedule.py:259` | 采推理时间步列表 | 递减序列 |
| `EDMPrecond.forward()` `EDM/network.py:881` | EDM 预处理+底层网络 | 装饰器模式 |
| `EDMPrecond.sample()` `EDM/network.py:976` | EDM Euler 采样器 | 确定性 |
| `get_noise_schedule()` `noise_schedule.py:1667` | 工厂函数 | `NOISE_SCHEDULES` 注册表 |

</details>

---

## 核心实现

### FastGenNetwork 抽象基类与 forward 契约

`FastGenNetwork`（`network.py:13`）继承 `ABC, torch.nn.Module`，关键属性：

```python title="networks/network.py"
class FastGenNetwork(ABC, torch.nn.Module):
    def __init__(self, net_pred_type="x0", schedule_type="edm", **kwargs):
        self.net_pred_type = net_pred_type   # 必须属于 {"x0","eps","v","flow"}
        self.schedule_type = schedule_type
        self.set_noise_schedule(**kwargs)    # 创建 self.noise_scheduler

    @abstractmethod
    def forward(self, x_t, t, condition=None, r=None,
                return_features_early=False, feature_indices=None,
                fwd_pred_type=None, **fwd_kwargs):  # network.py:156
        ...
```

`forward` 返回三种类型：单 tensor（标准前向）、`List[tensor]`（`return_features_early=True` 时返回中间层特征，供判别器用）、`Tuple[tensor, tensor]`（output + logvar）。`return_features_early` 支持提前退出——一旦收集到所需特征立即返回，不走完整个网络（`EDM/network.py:543`）。

### BaseNoiseSchedule 策略模式与 7 子类

`BaseNoiseSchedule`（`noise_schedule.py:23`）定义扩散数学框架，核心公共方法在基类实现（所有子类共用）：

- `forward_process(x, eps, t)`（`noise_schedule.py:425`）：`x_t = alpha_t * x + sigma_t * eps`，**float64 精度**计算
- `convert_model_output(xt, output, t, src_pred_type, target_pred_type)`（`noise_schedule.py:666`）：**核心多态转换器**，通过 x0 作中间表示，在 x0/eps/v/flow 四种预测类型间任意转换
- `sample_t(n, time_dist_type, ...)`（`noise_schedule.py:236`）：训练时间步采样，支持 uniform/lognormal/logitnormal/polynomial/shifted/log_t 分布

7 个子类（策略实现）通过 `NOISE_SCHEDULES` dict（`noise_schedule.py:1655`）注册，`get_noise_schedule(name, **kwargs)`（`noise_schedule.py:1667`）工厂创建：

| 子类 | 数学模型 | 典型网络 |
|------|---------|---------|
| `EDMNoiseSchedule` | `x_t = x_0 + sigma*t * eps` | EDM, EDM2 |
| `AlphasNoiseSchedule` | `x_t = sqrt(α_cumprod)*x_0 + sqrt(1-α_cumprod)*eps` | SD15, SDXL, CogVideoX |
| `RFNoiseSchedule` | `x_t = (1-t)*x_0 + t*noise`（Rectified Flow） | Wan, Flux, QwenImage |
| `TrigNoiseSchedule` | `x_t = cos(t)*x_0 + sin(t)*eps` | — |
| `SDNoiseSchedule` | 继承 Alphas，加载 SD1.5 的 alphas_cumprod | SD15 |
| `SDXLNoiseSchedule` | 继承 Alphas，加载 SDXL 的 | SDXL |
| `CogVideoXNoiseSchedule` | 使用 CogVideoXDPMScheduler | CogVideoX |

### EDMPrecond 装饰器模式

`EDMPrecond`（`EDM/network.py:808`）继承 `FastGenNetwork`，内部持有 `self.model`（`SongUNet` 或 `DhariwalUNet`，通过 `globals()[model_type]` 动态实例化）。`forward`（`EDM/network.py:881`）在调用 `self.model` 前后加 EDM 预处理：`precond_input`（`c_in = 1/sqrt(sigma_data^2+t^2)`, `t = log(t)/4`）→ 底层网络 → `precond_output`（`c_skip * x_t + c_out * out`）→ `convert_model_output` 转 pred_type。`drop_precond` 参数可关闭预处理（装饰器透明/不透明模式）。`fully_shard`（`EDM/network.py:861`）对 encoder/decoder 的每个 `UNetBlock` 逐块 FSDP 分片。

### CausalFastGenNetwork 视频因果模型

`CausalFastGenNetwork`（`network.py:211`）继承 `FastGenNetwork`，扩展 `chunk_size`（默认 3）和 `total_num_frames`（默认 21）属性，新增 `clear_caches` 抽象方法（`network.py:258`）——强制子类实现 KV cache/attention cache/positional embedding cache 清理。用于自回归视频生成（按帧/块顺序，每步依赖之前内容）。具体实现见 `Wan/network_causal.py`（FlexAttention + `create_block_mask` 因果注意力）、`_rope_forward_with_time_offset`（带时间偏移的旋转位置编码）。单独成类的原因：非 causal 网络（EDM/Flux）不需要 cache 管理和分块接口，放基类违反接口隔离原则。

### noise_schedule 独立解耦组合爆炸

把 noise_schedule 独立成模块而非各网络自包含，解决了组合爆炸：7 种 schedule × 11 种网络 = 77 种组合，独立后只需 7 + 11 = 18 个实现。`FastGenNetwork.__init__`（`network.py:52`）接受 `schedule_type` 字符串，任何网络搭配任何 schedule——`Wan` 默认 `"rf"`、`EDMPrecond` 默认 `"edm"`，实例化时可覆盖。`convert_model_output`（`noise_schedule.py:666`）是通用转换器，所有网络共用而非各自实现。

### 数值精度设计

`BaseNoiseSchedule` 的所有关键计算（`forward_process`、`cond_velocity`、`convert_model_output`、各 `x0_to_*`/`*_to_x0`）强制在 `torch.float64` 下计算后转回原 dtype。高噪声水平（t 接近 max_t）时 `alpha(t)` 可能极小，float32 会除零或精度丢失。`t_precision` 默认 `"float64"` 统一管理。

### discriminators 横切关注点

`discriminators.py` 的判别器（`Discriminator_EDM`/`Discriminator_VideoDiT`）**不继承** `FastGenNetwork`，直接继承 `torch.nn.Module`。消费网络的中间特征（`List[torch.Tensor]`，通过 `return_features_early=True` + `feature_indices` 获取），输出 logits。独立在 networks 顶层而非各架构内部，因为判别器是横切关注点——多个网络可共享同一判别器类型（`Discriminator_VideoDiT` 被 Wan/CogVideoX 共用），架构选择（conv3d/attention/multiscale）是独立于生成网络的正交维度。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略 | `BaseNoiseSchedule` 7 子类 `noise_schedule.py:23` | 噪声调度可互换，解耦组合爆炸 |
| 装饰器 | `EDMPrecond` `EDM/network.py:808` | 包装底层 U-Net 加预处理，不改原模型 |
| 工厂 | `get_noise_schedule()` + `NOISE_SCHEDULES` `noise_schedule.py:1667/1655` | 按字符串创建 schedule 实例 |
| 抽象基类 | `FastGenNetwork`/`CausalFastGenNetwork` `network.py:13/211` | 统一 forward 契约，因果模型扩展 cache 接口 |
| 方法替换 | `Wan.override_transformer_forward` `Wan/network.py:831` | `types.MethodType` 给 diffusers 模型打补丁，不改源码 |

---

## 模块间交互

networks 被 `methods.FastGenModel` 组合持有（`self.net = instantiate(config.net)`，`model.py:254`），作为 student/teacher/discriminator 的底层网络。`FastGenModel` 通过 `self.net(input, t, condition, fwd_pred_type="x0")` 调用 forward，通过 `self.net.noise_scheduler` 访问加噪/采样（`model.py:377/382/420`）。`common_loss.py` 接受 `BaseNoiseSchedule` 参数算 loss。`inception.py`（`InceptionV3`）是 FID 评估用的特征提取器，不参与训练。networks 在 forward 中调用 `utils.distributed.is_rank0` 等原语。

---

## 扩展方式

新增网络架构：新建 `fastgen/networks/<Name>/network.py` 实现 `<Name>(FastGenNetwork)`，必须实现 `forward()`（`network.py:156`），可选 `sample()`/`fully_shard()`；视频因果模型继承 `CausalFastGenNetwork` 实现 `clear_caches()`。在 `configs/net.py` 添加 `LazyCall` 配置。不需修改 `methods/` 或 `trainer.py`——网络通过 `instantiate(config.net)` 注入，只要符合 `FastGenNetwork` 接口即可。如需新噪声调度，在 `noise_schedule.py` 添加子类 + `NOISE_SCHEDULES` 注册条目，所有网络自动支持。
