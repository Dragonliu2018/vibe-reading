---
source:
  type: "源码解读"
  project: "Diffusers"
  url: "https://github.com/huggingface/diffusers"
title: "调度器"
date: "2026-08-12T15:35:17+08:00"
category: [AI, Diffusers, CodeWiki, "0.39.0"]
tags: ["Diffusers", "Scheduler", "DDPM", "DDIM", "Euler", "噪声调度"]
description: "SchedulerMixin 基类、DDPM/DDIM/Euler 三大调度器的去噪数学、统一接口与策略模式。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Diffusers/CodeWiki/0.39.0/00-overview)

---

## 模块定位

调度器模块是 Diffusers 去噪数学的独立封装层——它定义了"如何从噪声中一步步恢复出干净样本"的算法，与模型架构（UNet/Transformer）完全解耦。这种分离的设计决策源于一个核心观察：**去噪策略和模型架构是正交的两个演化维度**。同一个 UNet 可以搭配 DDPM 做高质量慢采样，也可以搭配 Euler 做 4 步快速采样；同一个调度器可以用于 Stable Diffusion 也可以用于 FLUX。如果把调度逻辑嵌入模型内部，每换一种采样策略就要改模型代码，组合爆炸不可避免。

调度器的核心职责边界：接收模型输出的噪声预测（`model_output`）和当前样本（`sample`），计算上一步的样本（`prev_sample`）。它不关心模型是什么架构，也不关心输入是图像还是 3D 分子——只要模型输出符合约定的 `prediction_type`，调度器就能工作。

## 模块架构

```
schedulers/
├── scheduling_utils.py              # SchedulerMixin 基类 + SchedulerOutput
├── scheduling_ddpm.py               # DDPMScheduler（马尔可夫，随机去噪）
├── scheduling_ddim.py               # DDIMScheduler（非马尔可夫，eta 控制随机性）
├── scheduling_euler_discrete.py     # EulerDiscreteScheduler（ODE 积分，sigma 框架）
├── scheduling_dpmsolver_*.py        # DPM-Solver 系列
├── scheduling_heun.py               # Heun 二阶修正
└── ...                              # 60+ 调度器
```

调度器模块的内部设计围绕一个核心抽象展开：**`SchedulerMixin` 定义共享接口，各调度器以策略模式实现各自的去噪数学**。所有调度器继承 `SchedulerMixin` 和 `ConfigMixin`，前者提供 `from_pretrained` / `save_pretrained` / `_compatibles` 等通用能力，后者通过 `@register_to_config` 装饰 `__init__`，将所有构造参数自动序列化为 `scheduler_config.json`。这意味着调度器的完整状态可由一个 JSON 配置文件重建——这是跨调度器互换的基础。

三大调度器按数学框架分为两系：**DDPM 系**（DDPMScheduler、DDIMScheduler）使用 `alphas_cumprod` 累积乘积框架，基于离散马尔可夫链；**Euler 系**（EulerDiscreteScheduler）使用 `sigmas` 噪声尺度框架，基于连续 ODE 积分。两系的数学起点不同——DDPM 从前向加噪公式 $x_t = \sqrt{\bar\alpha_t} x_0 + \sqrt{1 - \bar\alpha_t} \epsilon$ 出发反推去噪，Euler 从 ODE $\frac{dx}{dt} = \frac{x - \hat{x}_0}{\sigma}$ 出发做数值积分——因此内部数据结构完全不同，但对外暴露统一的 `step()` / `set_timesteps()` / `scale_model_input()` 接口。

`KarrasDiffusionSchedulers` 枚举（`scheduling_utils.py:33`）列出 15 种兼容调度器，每个调度器的 `_compatibles` 属性设为该枚举的全部名称列表。这使得 `from_config()` 可以用一个调度器的配置文件实例化另一个兼容调度器——用户把 DDPM 的 config 传给 Euler，Euler 会提取自己需要的参数（`beta_schedule`、`num_train_timesteps`）忽略不需要的（`variance_type`），实现无缝切换。

## 调用链路

去噪循环的核心数据流（以 Stable Diffusion 为例）：

```
pipeline.__call__()
  ├── scheduler.set_timesteps(num_inference_steps=50)     # 初始化时间步序列
  ├── scheduler.scale_model_input(latent, t)               # 缩放输入（Euler 需要，DDPM 不需要）
  ├── unet(latent, t, encoder_hidden_states) → noise_pred  # 模型预测噪声
  ├── extra_step_kwargs = prepare_extra_step_kwargs()       # 鸭子类型适配 step 签名
  └── scheduler.step(noise_pred, t, latent, **extra_step_kwargs) → prev_sample
        ├── 1. 计算 alpha_prod_t / alpha_prod_t_prev       # DDPM/DDIM: alphas_cumprod[t]
        ├── 2. pred_original_sample = f(model_output, sample)  # 按 prediction_type 反推 x_0
        ├── 3. clip / threshold pred_original_sample       # 数值稳定性
        ├── 4. 计算系数 + 组合                               # DDPM: 马尔可夫转移 / DDIM: 非马尔可夫 / Euler: ODE 积分
        └── 5. (可选) 添加随机噪声                           # DDPM: 总是 / DDIM: eta>0 时 / Euler: s_churn>0 时
```

`prepare_extra_step_kwargs`（`pipeline_stable_diffusion.py:608`）是调度器与管线之间的关键适配层。不同调度器的 `step()` 签名不同——DDIMScheduler 有 `eta` 参数，DDPMScheduler 没有；EulerDiscreteScheduler 有 `s_churn`/`s_tmin`/`s_tmax`/`s_noise`，DDPM 没有。管线不硬编码哪个调度器需要什么参数，而是用 `inspect.signature(self.scheduler.step).parameters.keys()` 动态检测：

```python title="pipeline_stable_diffusion.py:608"
def prepare_extra_step_kwargs(self, generator, eta):
    accepts_eta = "eta" in set(inspect.signature(self.scheduler.step).parameters.keys())
    extra_step_kwargs = {}
    if accepts_eta:
        extra_step_kwargs["eta"] = eta

    accepts_generator = "generator" in set(inspect.signature(self.scheduler.step).parameters.keys())
    if accepts_generator:
        extra_step_kwargs["generator"] = generator
    return extra_step_kwargs
```

这是典型的鸭子类型——管线不要求调度器实现某个接口，而是运行时探测它接受什么参数。这种设计避免了为每种调度器签名写 if-else 分支，新增调度器时无需修改管线代码。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `SchedulerMixin.from_pretrained()` in `scheduling_utils.py:96` | 从 JSON 配置加载调度器 | 委托 `from_config()`，支持跨调度器互换 |
| `SchedulerMixin._get_compatibles()` in `scheduling_utils.py:183` | 获取兼容调度器列表 | 通过 `importlib` 动态按名查找类 |
| `DDPMScheduler.set_timesteps()` in `scheduling_ddpm.py:274` | 设置推理时间步 | 支持 `timestep_spacing` 三策略 + 自定义 `timesteps` |
| `DDPMScheduler.step()` in `scheduling_ddpm.py:461` | DDPM 去噪一步 | 6 步公式，马尔可夫链转移 + 随机噪声 |
| `DDPMScheduler._get_variance()` in `scheduling_ddpm.py:348` | 计算方差 | 6 种 `variance_type` 策略 |
| `DDIMScheduler.step()` in `scheduling_ddim.py:384` | DDIM 去噪一步 | `eta` 参数控制随机性，eta=0 确定性采样 |
| `EulerDiscreteScheduler.set_timesteps()` in `scheduling_euler_discrete.py:350` | 设置 sigma + 时间步 | 支持 Karras/exponential/beta sigma 变换 |
| `EulerDiscreteScheduler.step()` in `scheduling_euler_discrete.py:685` | Euler ODE 积分一步 | `step_index` 驱动的 sigma 索引 |
| `EulerDiscreteScheduler.scale_model_input()` in `scheduling_euler_discrete.py:326` | 缩放模型输入 | 除以 `(sigma**2 + 1) ** 0.5`，DDPM 不需要 |

</details>

---

## 核心实现

### DDPMScheduler：alpha/beta 累积乘积框架

`DDPMScheduler`（`scheduling_ddpm.py:137`）基于 DDPM 原始论文的马尔可夫链去噪。其核心数据结构是 `alphas_cumprod`——betas 的累积乘积 $\bar\alpha_t = \prod_{s=1}^{t} \alpha_s$，其中 $\alpha_s = 1 - \beta_s$。前向加噪公式 $x_t = \sqrt{\bar\alpha_t} x_0 + \sqrt{1 - \bar\alpha_t} \epsilon$ 的逆过程就是去噪。

```python title="scheduling_ddpm.py:186"
@register_to_config
def __init__(
    self,
    num_train_timesteps: int = 1000,
    beta_start: float = 0.0001,
    beta_end: float = 0.02,
    beta_schedule: str = "linear",  # linear / scaled_linear / squaredcos_cap_v2 / sigmoid
    variance_type: str = "fixed_small",
    prediction_type: str = "epsilon",  # epsilon / sample / v_prediction
    clip_sample: bool = True,
    timestep_spacing: str = "leading",  # leading / trailing / linspace
    rescale_betas_zero_snr: bool = False,
    ...
):
    self.alphas = 1.0 - self.betas
    self.alphas_cumprod = torch.cumprod(self.alphas, dim=0)
```

`step()` 方法（`scheduling_ddpm.py:461`）执行 6 步去噪公式：

1. **计算 alpha/beta 系数**：`alpha_prod_t = self.alphas_cumprod[t]`，`alpha_prod_t_prev` 取前一时间步的累积乘积
2. **反推 $x_0$**：根据 `prediction_type` 从模型输出反推干净样本。`epsilon` 模式：$x_0 = (x_t - \sqrt{1-\bar\alpha_t} \epsilon) / \sqrt{\bar\alpha_t}$；`v_prediction` 模式：$x_0 = \sqrt{\bar\alpha_t} x_t - \sqrt{1-\bar\alpha_t} v$
3. **裁剪/阈值**：`clip_sample` 将 $x_0$ 限制在 `[-clip_sample_range, clip_sample_range]`，`thresholding` 做动态阈值（对 latent diffusion 不适用）
4. **计算组合系数**：$\hat\mu_t = \sqrt{\bar\alpha_{t-1}} \beta_t / (1-\bar\alpha_t) \cdot x_0 + \sqrt{\alpha_t} (1-\bar\alpha_{t-1}) / (1-\bar\alpha_t) \cdot x_t$
5. **添加随机噪声**：当 $t > 0$ 时，从方差分布中采样噪声加到 $\hat\mu_t$ 上

`prediction_type` 是一个关键设计——同一模型可以被训练为预测噪声（epsilon）、直接预测干净样本（sample）或预测速度（v_prediction）。调度器需要根据预测类型用不同公式反推 $x_0$。这个参数存在 `config` 中，通过 `@register_to_config` 自动持久化，用户无需在推理时手动指定。

`_get_variance()`（`scheduling_ddpm.py:348`）支持 6 种方差类型：`fixed_small`（DDPM 默认，小方差）、`fixed_large`（大方差，接近 $\beta_t$）、`learned`（模型预测方差）、`learned_range`（在 `fixed_small` 和 `fixed_large` 之间插值）。当 `variance_type` 为 `learned` 或 `learned_range` 时，`step()` 会将模型输出的通道数翻倍（`model_output.shape[1] == sample.shape[1] * 2`），前半部分是噪声预测，后半部分是方差预测。

### DDIMScheduler：非马尔可夫 eta 控制

`DDIMScheduler`（`scheduling_ddim.py:139`）在 DDPM 基础上引入了非马尔可夫采样——通过 `eta`（$\eta$）参数在确定性采样和完全随机采样之间连续插值。$\eta = 0$ 时是确定性 DDIM（给定相同噪声和模型，输出完全确定），$\eta = 1$ 时退化为 DDPM 的随机采样。

```python title="scheduling_ddim.py:384"
def step(self, model_output, timestep, sample, eta=0.0, ...):
    # 1. 获取前一时间步
    prev_timestep = timestep - self.config.num_train_timesteps // self.num_inference_steps

    # 2. 计算 alpha_prod
    alpha_prod_t = self.alphas_cumprod[timestep]
    alpha_prod_t_prev = self.alphas_cumprod[prev_timestep] if prev_timestep >= 0 else self.final_alpha_cumprod

    # 5. 计算 sigma_t(eta)
    variance = self._get_variance(timestep, prev_timestep)
    std_dev_t = eta * variance ** (0.5)

    # 6. "direction pointing to x_t"
    pred_sample_direction = (1 - alpha_prod_t_prev - std_dev_t**2) ** (0.5) * pred_epsilon

    # 7. 组合
    prev_sample = alpha_prod_t_prev ** (0.5) * pred_original_sample + pred_sample_direction
    if eta > 0:
        prev_sample = prev_sample + std_dev_t * variance_noise
```

DDIM 与 DDPM 的关键区别在于 `final_alpha_cumprod`（`scheduling_ddim.py:236`）：DDPM 的 `alpha_prod_t_prev` 在最后一步用 `self.one`（即 1.0），而 DDIM 引入了 `set_alpha_to_one` 参数——当为 `True` 时最后一步的前置 alpha 设为 1，当为 `False` 时使用 `alphas_cumprod[0]`。这影响最后一步去噪的数值行为。

DDIM 的 `step()` 多了 `eta` 和 `variance_noise` 参数，这就是为什么管线需要用 `inspect.signature` 动态检测 `step` 签名——DDPMScheduler 的 `step()` 没有 `eta`，直接调用会报参数错误。

### EulerDiscreteScheduler：sigma 框架 + step_index

`EulerDiscreteScheduler`（`scheduling_euler_discrete.py:143`）采用完全不同的数学框架——基于 k-diffusion 的 ODE 积分方法。它不使用 `alphas_cumprod`，而是使用 `sigmas`（噪声尺度 $\sigma_t = \sqrt{(1-\bar\alpha_t)/\bar\alpha_t}$），将去噪过程视为 ODE $\frac{dx}{d\sigma} = \frac{x - \hat{x}_0}{\sigma}$ 的 Euler 积分。

```python title="scheduling_euler_discrete.py:202"
@register_to_config
def __init__(self, ..., final_sigmas_type="zero", use_karras_sigmas=False, ...):
    self.alphas = 1.0 - self.betas
    self.alphas_cumprod = torch.cumprod(self.alphas, dim=0)
    # 从 alphas_cumprod 转换为 sigmas
    sigmas = (((1 - self.alphas_cumprod) / self.alphas_cumprod) ** 0.5).flip(0)
    self.sigmas = torch.cat([sigmas, torch.zeros(1, device=sigmas.device)])

    self._step_index = None
    self._begin_index = None
```

Euler 调度器引入了 `step_index` 机制（`scheduling_euler_discrete.py:294`）——一个内部计数器，每执行一次 `step()` 自增 1。这是因为 Euler 的 `step()` 需要知道当前在 sigma 序列中的位置（`sigma = self.sigmas[self.step_index]`），而 DDPM/DDIM 通过 `timestep` 直接索引 `alphas_cumprod[t]`。`_init_step_index()`（`scheduling_euler_discrete.py:670`）在首次调用时通过 `index_for_timestep()` 从时间步序列中查找位置。

`scale_model_input()`（`scheduling_euler_discrete.py:326`）是 Euler 独有的——它将输入除以 $(\sigma^2 + 1)^{0.5}$ 来匹配 EDM 框架的预处理。DDPM 和 DDIM 的 `scale_model_input()` 直接返回原样（`return sample`），因为它们的模型在训练时没有做 sigma 缩放。这就是为什么管线需要统一调用 `scale_model_input()`——确保对不同调度器都正确预处理。

`set_timesteps()`（`scheduling_euler_discrete.py:350`）比 DDPM 版本复杂得多，支持四种 sigma 变换：默认线性插值、Karras sigma（$\rho = 7$ 的幂律分布，使中间步骤更密集）、exponential sigma、beta sigma。这些变换改变 sigma 序列的分布密度，影响采样质量与速度的权衡。

`step()` 的核心是 ODE Euler 积分（`scheduling_euler_discrete.py:766`）：

```python title="scheduling_euler_discrete.py:766"
# 1. 从 sigma 反推 x_0
if self.config.prediction_type == "epsilon":
    pred_original_sample = sample - sigma_hat * model_output
elif self.config.prediction_type == "v_prediction":
    pred_original_sample = model_output * (-sigma / (sigma**2 + 1)**0.5) + (sample / (sigma**2 + 1))

# 2. 计算 ODE 导数
derivative = (sample - pred_original_sample) / sigma_hat

# 3. Euler 积分一步
dt = self.sigmas[self.step_index + 1] - sigma_hat
prev_sample = sample + derivative * dt
```

Euler 还支持 `s_churn`（随机性扰动）参数——当 $\sigma$ 在 `[s_tmin, s_tmax]` 范围内时，对样本添加额外噪声 $\hat\sigma = \sigma(1+\gamma)$，其中 $\gamma = \min(s\_text{churn}/(N-1), \sqrt{2}-1)$。这是 DDIM 的 `eta` 之外的另一种随机性控制机制。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略模式 | `SchedulerMixin` 基类 + 各 `*Scheduler` 实现 | 同一 `step()` 接口下替换去噪算法，管线不感知具体调度器 |
| Mixin 组合 | `DDPMScheduler(SchedulerMixin, ConfigMixin)` | 通用功能（加载/保存）与配置管理正交组合，避免深层继承 |
| 装饰器模式 | `@register_to_config` in `scheduling_ddpm.py:186` | 拦截 `__init__`，自动将参数序列化到 config，支持 `from_config` 重建 |
| 鸭子类型 | `inspect.signature(self.scheduler.step)` in `pipeline_stable_diffusion.py:614` | 运行时适配不同 `step()` 签名，新增调度器无需改管线 |
| 注册表模式 | `KarrasDiffusionSchedulers` enum + `_compatibles` in `scheduling_utils.py:33` | 声明兼容调度器集合，支持跨调度器 config 互换 |

## 模块间交互

调度器模块与管线的交互是通过鸭子类型完成的，这是整个 Diffusers 架构中最精巧的解耦设计之一。管线在去噪循环中调用 `scheduler.step()`、`scheduler.set_timesteps()`、`scheduler.scale_model_input()` 三个方法，但不通过接口约束调度器必须实现这些方法——而是靠运行时 `inspect.signature` 检测参数签名。这带来三个好处：其一，新增调度器无需修改任何管线代码；其二，不同调度器可以有完全不同的 `step()` 参数（DDIM 的 `eta`、Euler 的 `s_churn`），管线自动适配；其三，调度器可以自由演化 API（如 Euler 后来添加的 `step_index` 机制），老管线不需要更新。

`_compatibles` 机制实现了调度器间的配置互换。每个调度器的 `_compatibles` 列出所有 `KarrasDiffusionSchedulers` 枚举成员名（`scheduling_ddpm.py:183`）。当用户调用 `EulerDiscreteScheduler.from_config(ddpm_config)` 时，`ConfigMixin.from_config()` 只提取 Euler 的 `__init__` 参数对应的 config 键，忽略 DDPM 特有的 `variance_type` 等参数。这使得用户可以在不改代码的情况下实验不同调度器——一行代码 `pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config)` 就能切换。

`AysSchedules`（`scheduling_utils.py:51`）是 v0.39.0 引入的预定义时间步/sigma 序列——经过大规模搜索优化的 10 步采样方案，针对 Stable Diffusion / SDXL / SDV 分别预设了最优的 timesteps 和 sigmas。调度器的 `set_timesteps()` 接受 `timesteps=` 或 `sigmas=` 自定义参数，可直接传入这些预定义序列。

## 扩展方式

**新增一种 scheduler**：

1. 创建 `schedulers/scheduling_my.py`，继承 `SchedulerMixin, ConfigMixin`
2. 用 `@register_to_config` 装饰 `__init__`，声明所有参数
3. 设置 `_compatibles = [e.name for e in KarrasDiffusionSchedulers]` 和 `order = 1`（多步法设更高值）
4. 实现核心方法：
   - `set_timesteps(num_inference_steps, device, timesteps=None)` — 生成时间步序列
   - `scale_model_input(sample, timestep)` — 缩放模型输入（如不需要则 `return sample`）
   - `step(model_output, timestep, sample, ...)` — 去噪一步，返回 `SchedulerOutput` 或 tuple
   - `add_noise(original_samples, noise, timesteps)` — 前向加噪（训练用）
5. 在 `schedulers/__init__.py` 的 `_import_structure` 中注册导出
6. 若使用 alpha 框架，参考 `scheduling_ddpm.py` 的 `alphas_cumprod` 计算；若使用 sigma 框架，参考 `scheduling_euler_discrete.py` 的 `sigmas` 计算

无需修改任何 pipeline 代码——管线通过 `inspect.signature` 自动适配新调度器的 `step()` 参数。对应测试：`tests/schedulers/`。
