---
source:
  type: "源码解读"
  project: "FastGen"
  url: "https://github.com/NVlabs/FastGen"
title: "蒸馏方法"
date: "2026-08-11T15:42:00+08:00"
category: [AI, Generative, FastGen, CodeWiki, "0.1.0"]
tags: ["FastGen", "Python", "PyTorch", "扩散模型", "蒸馏"]
description: "FastGen 蒸馏方法模块深度解读：FastGenModel 抽象基类（全局 god node #1）、DMD2 交替优化（student/fake_score/discriminator）、common_loss 共享逻辑、组合模式（method 包 network）。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Generative/FastGen/CodeWiki/0.1.0/00-overview)


## 模块定位

蒸馏方法模块（`fastgen/methods/`，4438 行，18 文件）是 FastGen 的算法层，以 `FastGenModel` 抽象基类为核心——这是 graphify 全局 god node #1（degree 94），所有蒸馏方法的统一入口。模块实现了 13 种蒸馏/微调方法（CM/sCM/TCM/MeanFlow/DMD2/f-Distill/LADD/CausVid/Self-Forcing/SFT/CausalSFT/KD/CausalKD），每种方法是一个 `FastGenModel` 子类，通过组合模式持有 `FastGenNetwork`（student/teacher/EMA/discriminator）并实现 `single_train_step()` 契约。

---

## 模块架构

`FastGenModel`（`methods/model.py:26`）继承 `torch.nn.Module`，是训练算法容器。它**不继承** `FastGenNetwork`，而是**组合持有**它——这是"method 包 network"的两层分离：network 层负责纯前向计算，model 层负责训练逻辑（loss/optimizer/EMA/sampling）。一个 method 可同时持有多个 network（DMD2 最多 5 个：student+teacher+fake_score+discriminator+ema）。各子类按 4 个方法分类组织在 `consistency_model/`/`distribution_matching/`/`fine_tuning/`/`knowledge_distillation/` 子目录，共享 loss 逻辑抽到 `common_loss.py`。

---

## 调用链路

`Trainer.train_step` → `FastGenModel.single_train_step`（抽象，子类实现）的调用链，以 DMD2 为例：

```
Trainer.train_step()                              # trainer.py:285
└── model.autocast() → single_train_step(data)    # trainer.py:314
    └── DMD2Model.single_train_step(data, iter)   # dmd2.py:423
        ├── _prepare_training_data(data)           # model.py:447 → (real, condition, neg_cond)
        ├── _setup_grad_requirements(iter)         # dmd2.py:67 — 切换 requires_grad
        ├── _generate_noise_and_time(real)         # dmd2.py:79
        └── [iter % student_update_freq == 0]:
            _student_update_step()                 # dmd2.py:187
            ├── gen_data = gen_data_from_net(...)  # model.py:322 → self.net(input, t, cond)
            ├── perturbed = noise_scheduler.forward_process(gen_data, eps, t)
            ├── fake_score_x0 = self.fake_score(perturbed, t)  # no_grad
            ├── teacher_x0, gan_gen = _compute_teacher_prediction_gan_loss()  # dmd2.py:124
            ├── vsd_loss = variational_score_distillation_loss(gen, teacher_x0, fake_x0)  # common_loss.py:63
            └── loss = vsd_loss + gan_weight * gan_gen
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `FastGenModel.single_train_step()` `model.py:515` | 抽象：单步训练 | 子类必须实现，Trainer 唯一入口 |
| `FastGenModel._get_outputs()` `model.py:503` | 抽象：构造输出 dict | 子类实现 |
| `FastGenModel.build_model()` `model.py:250` | 创建 self.net | 子类 super() 后追加 teacher/disc |
| `FastGenModel.build_teacher()` `model.py:186` | 创建 teacher | `eval().requires_grad_(False)` 冻结 |
| `FastGenModel._setup_ema()` `model.py:65` | 创建 EMA 副本 | `setattr(self, name, ema)` 动态挂载 |
| `FastGenModel.init_optimizers()` `model.py:530` | 创建 optimizer | 子类扩展额外 optimizer |
| `FastGenModel.get_optimizers(iter)` `model.py:554` | 按 iter 返回 optimizer 组 | 交替优化核心 |
| `FastGenModel.optimizers_schedulers_step()` `model.py:601` | optimizer+scheduler step | grad_scaler.step |
| `FastGenModel.generator_fn()` `model.py:390` | classmethod 多步采样 | student 推理 |
| `FastGenModel.sample()` `model.py:438` | 推理采样 | 委托 net.sample |
| `DMD2Model.single_train_step()` `dmd2.py:423` | 交替分流 | `iter % freq` 分流 |
| `DMD2Model._student_update_step()` `dmd2.py:187` | student VSD+GAN | fake_score/teacher no_grad |
| `DMD2Model._fake_score_discriminator_update_step()` `dmd2.py:319` | fake_score DSM+disc GAN | student no_grad |
| `CMModel._compute_cm_loss()` `CM.py:85` | 一致性 loss | 采样 (y_t, y_r) 对 |
| `LADDModel._student_update_step()` `ladd.py:103` | 纯 GAN generator loss | 无 VSD |

</details>

---

## 核心实现

### FastGenModel 抽象基类与"method 包 network"组合模式

`FastGenModel`（`model.py:26`）继承 `torch.nn.Module`，关键属性：

```python title="methods/model.py"
class FastGenModel(torch.nn.Module):
    def __init__(self, config: BaseModelConfig):
        self.config = config
        self.device = torch.device(config.device)
        self.set_precision(precision=config.precision, ...)  # 5 级精度控制
        self.use_ema = config.use_ema                        # bool 或 list[str]
        self.net = None  # student 网络，build_model 中创建
        self.teacher = None  # 可选

    @abstractmethod
    def single_train_step(self, data: Dict, iteration: int) -> tuple[dict, dict]:  # model.py:515
        ...
    @abstractmethod
    def _get_outputs(self, gen_data, ...) -> Dict:  # model.py:503
        ...
```

**为什么不继承 FastGenNetwork 而是组合持有**（`model.py:254` `self.net = instantiate(self.config.net)`）：(1) 一个 method 需同时管理多网络（DMD2 持 5 个），继承只能表示一个；(2) 职责分离——network 是纯前向，model 是训练逻辑；(3) FSDP 分片管理需要 `fsdp_dict`（`model.py:688`）枚举所有网络选择性分片；(4) 配置驱动——`instantiate(config.net)` 允许任意网络与任意 method 自由组合（13+11 vs 143）。

### Teacher/Student/EMA 组织与权重加载

teacher 在 `build_teacher`（`model.py:186`）创建：`self.teacher = instantiate(self.teacher_config)` → `_load_pretrained_model` → `eval().requires_grad_(False)`。student 在 `build_model`（`model.py:250`）创建，`load_student_weights_and_ema`（`model.py:207`）负责加载——优先 `pretrained_student_net_path`，否则从 teacher 权重初始化（`self.net.load_state_dict(self.teacher.state_dict(), strict=False)`），否则从 `pretrained_model_path`。EMA 在 `_setup_ema`（`model.py:65`）：`use_ema` 接受 `bool` 或 `list[str]`（支持多 EMA 如 `["ema", "ema2"]`），为每个创建 `config.net` 副本 `eval().requires_grad_(False)`，`setattr(self, name, ema)` 动态挂载。EMA 更新不在 model 内，而在 `EMACallback`（`callbacks/ema.py:93`）——把 EMA 策略（beta schedule）与模型本体解耦。

### DMD2 交替优化与 VSD loss

`DMD2Model`（`dmd2.py:30`）持有 4 个网络：`self.net`（student）、`self.teacher`、`self.fake_score`（teacher 架构副本）、`self.discriminator`。`single_train_step`（`dmd2.py:423`）按 `iteration % student_update_freq` 分流：

```python title="methods/distribution_matching/dmd2.py"
def single_train_step(self, data, iteration):
    real_data, condition, neg_condition = self._prepare_training_data(data)
    self._setup_grad_requirements(iteration)  # dmd2.py:67 切换 requires_grad
    input_student, t_student, t, eps = self._generate_noise_and_time(real_data)
    if iteration % self.config.student_update_freq == 0:
        return self._student_update_step(...)      # dmd2.py:187 优化 student
    else:
        return self._fake_score_discriminator_update_step(...)  # dmd2.py:319
```

student 更新（`dmd2.py:187`）：student 生成 `gen_data` → forward process 加噪 → teacher 和 fake_score 各预测 x0 → `variational_score_distillation_loss`（`common_loss.py:63`）用 `(fake_score_x0 - teacher_x0) * w` 作伪梯度方向（`w = 1/|gen_data - teacher_x0|`，fp32 计算避免数值不稳）→ 加 GAN generator loss。`get_optimizers(iteration)`（`dmd2.py:473`）按 iteration 返回不同 optimizer 组——同一模型不同阶段优化不同参数。

### common_loss 共享逻辑

`common_loss.py`（137 行）抽出 4 个跨方法共享的纯函数 loss：

| 函数 | 行号 | 用途 | 被谁调用 |
|------|------|------|---------|
| `denoising_score_matching_loss` | 12 | DSM loss，支持 x0/eps/v/flow 四种 pred_type | DMD2(`dmd2.py:355`)、SFT(`sft.py:144`) |
| `variational_score_distillation_loss` | 63 | VSD loss：fake_score-teacher 作伪梯度 | DMD2(`dmd2.py:235`) |
| `gan_loss_generator` | 106 | Generator softplus GAN loss | DMD2(`dmd2.py:146`)、LADD(`ladd.py:139`) |
| `gan_loss_discriminator` | 122 | Discriminator hinge GAN loss | DMD2(`dmd2.py:380`)、LADD(`ladd.py:258`) |

抽出原因：DMD2 和 LADD 共享 GAN loss；DMD2 和 SFT 共享 DSM loss。纯函数（只接受 tensor 参数），便于测试。CM 的 loss（`CM.py:181` `_pred_to_loss` 6 种 weighting）没放这里，因为高度 CM 专属。

### 各方法继承结构与差异

| 类 | 文件 | 继承 | 特点 |
|----|------|------|------|
| `FastGenModel` | `model.py:26` | `nn.Module` | 抽象基类，degree 94 |
| `DMD2Model` | `dmd2.py:30` | `FastGenModel` | 4 网络，VSD+GAN 交替 |
| `LADDModel` | `ladd.py:25` | `FastGenModel` | teacher+disc，纯 GAN（无 VSD） |
| `CMModel` | `CM.py:54` | `FastGenModel` | 一致性 loss，use_cd 时才有 teacher |
| `SFTModel` | `sft.py:20` | `FastGenModel` | 无 teacher，直接 DSM |
| `KDModel` | `KD.py:18` | `FastGenModel` | 从预构建 ODE pair 学习，L2 |
| `CausVidModel` | `causvid.py:20` | `DMD2Model` | 因果视频 DMD2 |
| `SelfForcingModel` | `self_forcing.py:22` | `CausVidModel` | override `gen_data_from_net` 为 `rollout_with_gradient` |

### Sampling 与 Training 共用 noise_schedule

`noise_scheduler` 是 `FastGenNetwork` 的属性（`network.py:43`），所有 method 通过 `self.net.noise_scheduler` 访问。训练用 `forward_process(x0, eps, t)` 加噪、`sample_t()` 采时间步；采样用 `get_t_list()`、`latents()`、`forward_process()` 反向去噪。共用同一实例保证训练和推理的前向过程数学一致——时间步离散化、`t_precision`（默认 float64）统一管理，避免分布不匹配。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `FastGenModel` 基础设施模板 `model.py:250/530` | 基类提供 optimizer/EMA/sampling 默认实现，子类 override 扩展 |
| 策略 | 各 method 子类 `single_train_step` | 蒸馏方法可互换，Trainer 只依赖抽象接口 |
| 组合 | `FastGenModel` 持有 `FastGenNetwork` | "method 包 network"，一 method 持多网络 |
| 交替优化 | `DMD2Model` `iter % freq` 分流 | 同一模型不同阶段优化不同子网络 |

---

## 模块间交互

methods import `networks.network.FastGenNetwork`（TYPE_CHECKING）、`configs.opt.get_scheduler`、`utils.{instantiate, distributed, io_utils, logging_utils, basic_utils}`。被 `Trainer.train_step` 调用（`model.single_train_step`/`optimizers_schedulers_step`）、被 `EMACallback` 读 `model.net` 参数、被 `train.py:instantiate(config.model_class)` 创建。`FastGenModel` 通过 `self.net`（`FastGenNetwork`）间接依赖 `noise_scheduler`——method 层不直接 import noise_schedule，而是通过 network 层的 `self.net.noise_scheduler` 访问。

---

## 扩展方式

新增蒸馏方法：新建 `fastgen/methods/<category>/<new>.py` 定义 `NewModel(FastGenModel)`，实现 `single_train_step()` 和 `_get_outputs()`（`model.py:515/503` 抽象方法）；如需 teacher/discriminator，override `build_model()` 调 `super()` 后追加（参考 `dmd2.py:40`）；如有额外 optimizer，override `init_optimizers`/`get_optimizers`/`get_lr_schedulers`/`model_dict`/`optimizer_dict`。新建 `configs/methods/config_<new>.py` 定义 `ModelConfig(BaseModelConfig)` + `Config(BaseConfig)` 切换 `model_class: L(NewModel)`。在 `methods/__init__.py` 添加导出。共享 loss 加到 `common_loss.py`。
