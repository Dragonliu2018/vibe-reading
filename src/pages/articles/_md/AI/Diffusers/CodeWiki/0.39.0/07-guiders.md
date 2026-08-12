---
source:
  type: "源码解读"
  project: "Diffusers"
  url: "https://github.com/huggingface/diffusers"
title: "引导器"
date: "2026-08-12T15:35:17+08:00"
category: [AI, Diffusers, CodeWiki, "0.39.0"]
tags: ["Diffusers", "Guider", "CFG", "PAG", "Classifier-Free Guidance"]
description: "BaseGuidance 策略基类、CFG/PAG 引导计算、多前向管理与步长区间控制。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Diffusers/CodeWiki/0.39.0/00-overview)

---

## 模块定位

`src/diffusers/guiders/` 是 Diffusers v0.39.0 新引入的引导策略模块，共约 3,000 行代码。在传统扩散模型管线中，Classifier-Free Guidance（CFG）的逻辑内联在 pipeline 的 `__call__` 方法里——手动拼接条件/无条件批次、两次前向、然后线性组合。这种做法导致引导策略不可替换：换一种引导算法就要改 pipeline 代码。

本模块把引导策略抽离为独立的 `BaseGuidance` 基类，所有引导算法（CFG、PAG、SLG 等 11 种）实现同一套接口。pipeline 只需持有 guider 引用并按模板调用 `set_state → prepare_inputs → prepare_models → forward → cleanup`，引导策略的替换对 pipeline 透明。模块在 `__init__` 时发出警告："Guiders are currently an experimental feature under active development"，表明这是面向未来的架构演进。

## 模块架构

模块以 `BaseGuidance` 抽象基类为核心，11 个具体引导器为子类，共享 `ConfigMixin`（JSON 序列化）和 `PushToHubMixin`（Hub 上传）能力：

```
guiders/
├── guider_utils.py                        # BaseGuidance 基类 + GuiderOutput + rescale_noise_cfg
├── classifier_free_guidance.py             # ClassifierFreeGuidance（2 次前向）
├── perturbed_attention_guidance.py         # PerturbedAttentionGuidance（3 次前向 + hook）
├── skip_layer_guidance.py                  # SkipLayerGuidance（3 次前向 + hook）
├── auto_guidance.py                        # AutoGuidance
├── adaptive_projected_guidance.py          # AdaptiveProjectedGuidance
├── adaptive_projected_guidance_mix.py      # AdaptiveProjectedMixGuidance
├── classifier_free_zero_star_guidance.py   # ClassifierFreeZeroStarGuidance
├── frequency_decoupled_guidance.py         # FrequencyDecoupledGuidance
├── magnitude_aware_guidance.py             # MagnitudeAwareGuidance
├── smoothed_energy_guidance.py             # SmoothedEnergyGuidance
├── tangential_classifier_free_guidance.py  # TangentialClassifierFreeGuidance
└── __init__.py                             # 统一导出
```

- **`BaseGuidance`**（`guider_utils.py:38`）——抽象模板基类，继承 `ConfigMixin, PushToHubMixin`
- **`GuiderOutput`**（`guider_utils.py:368`）——输出数据类，含 `pred`/`pred_cond`/`pred_uncond` 三个字段
- **`_input_predictions`** 类属性——声明每个子类需要哪些前向预测（如 CFG 的 `["pred_cond", "pred_uncond"]`，PAG 的 `["pred_cond", "pred_uncond", "pred_cond_skip"]`）
- **`_identifier_key = "__guidance_identifier__"`**——批次标识机制，让 `__call__` 能区分每个前向结果对应哪种条件

## 调用链路

guider 在 pipeline 去噪循环中的调用模板（每个去噪步执行一次完整序列）：

```
# 1. 设置当前步状态
guider.set_state(step=i, num_inference_steps=N, timestep=t)
  └── 重置 _count_prepared = 0

# 2. 拆分输入批次
data_batches = guider.prepare_inputs(data)
  └── 根据 num_conditions 将条件/无条件数据拆为 1~3 个 BlockState
  └── 每个 BlockState 打上 __guidance_identifier__ 标签

# 3. 逐批次前向
for batch in data_batches:
    guider.prepare_models(denoiser)     # _count_prepared += 1；PAG 在第 3 次时挂 hook
    noise_pred = denoiser(**batch)      # 模型前向
    batch.noise_pred = noise_pred       # 存回 BlockState
    guider.cleanup_models(denoiser)     # 移除 hook（如果有）

# 4. 组合引导
output = guider(data_batches)           # __call__ → forward(**kwargs)
  └── 按 identifier 映射 noise_pred → forward(pred_cond=..., pred_uncond=...)
  └── 返回 GuiderOutput(pred=..., pred_cond=..., pred_uncond=...)
```

**为什么用 `_count_prepared` 计数器**：guider 需要知道当前是第几次前向——第 1 次是条件前向，第 2 次是无条件前向，第 3 次（PAG）是扰动条件前向。计数器在 `set_state` 重置，`prepare_models` 递增，子类通过 `is_conditional` 属性判断当前处于哪次前向。这是连接 guider 与 pipeline 多次前向循环的关键纽带。

## 核心实现

### BaseGuidance 模板方法

`BaseGuidance`（`guider_utils.py:38`）定义了引导算法的骨架，子类只需实现 4 个抽象方法：

```python title="src/diffusers/guiders/guider_utils.py"
class BaseGuidance(ConfigMixin, PushToHubMixin):
    config_name = GUIDER_CONFIG_NAME  # "guider_config.json"
    _input_predictions = None
    _identifier_key = "__guidance_identifier__"

    def __init__(self, start=0.0, stop=1.0, enabled=True):
        self._start = start        # 引导生效区间起点（[0,1) 分数）
        self._stop = stop          # 引导生效区间终点
        self._enabled = enabled
        self._count_prepared = 0   # 前向计数器
```

| 方法 | 类型 | 职责 |
|------|------|------|
| `set_state(step, num_inference_steps, timestep)` | 具体方法 | 设置当前步状态，重置计数器 |
| `prepare_models(denoiser)` | 模板方法 | 递增 `_count_prepared`，子类可覆盖以挂 hook |
| `cleanup_models(denoiser)` | 模板方法 | 基类 no-op，子类可覆盖以移除 hook |
| `prepare_inputs(data)` | 抽象方法 | 拆分条件/无条件批次 |
| `__call__(data)` | 具体方法 | 验证 → 按 identifier 映射 → 调 `forward` |
| `forward(...)` | 抽象方法 | 引导计算核心逻辑 |
| `is_conditional` | 抽象属性 | 当前前向是否为条件分支 |
| `num_conditions` | 抽象属性 | 需要几次前向 |

`__call__` 的核心机制是 identifier 映射：`prepare_inputs` 为每个批次设置 `__guidance_identifier__`（如 `"pred_cond"`、`"pred_uncond"`），`__call__` 收集所有批次的 `noise_pred` 后，按 identifier 组装为关键字参数传给 `forward`。这样 `forward` 的签名直接对应 `_input_predictions` 列表，子类无需手动解析批次顺序。

### ClassifierFreeGuidance：2 次前向

`ClassifierFreeGuidance`（`classifier_free_guidance.py:30`）是最基础的引导策略，实现标准 CFG 公式：

```python title="src/diffusers/guiders/classifier_free_guidance.py"
class ClassifierFreeGuidance(BaseGuidance):
    _input_predictions = ["pred_cond", "pred_uncond"]

    def forward(self, pred_cond, pred_uncond=None):
        if not self._is_cfg_enabled():
            return GuiderOutput(pred=pred_cond, ...)
        shift = pred_cond - pred_uncond
        base = pred_cond if self.use_original_formulation else pred_uncond
        pred = base + self.guidance_scale * shift
        return GuiderOutput(pred=pred, pred_cond=pred_cond, pred_uncond=pred_uncond)
```

**两种公式**：diffusers-native（默认，Imagen 论文）以 `pred_uncond` 为基底；`use_original_formulation=True` 以 `pred_cond` 为基底。两者的 `guidance_scale` 含义不同——native 模式下 `1.0` 为恒等，original 模式下 `0.0` 为恒等。`_is_cfg_enabled()` 据此判断 `guidance_scale` 是否接近恒等值来决定是否跳过无条件前向。

**`start`/`stop` 步长区间控制**：`start=0.3, stop=0.7` 表示只在去噪进程的 30%~70% 区间内应用 CFG。这是通过 `_is_cfg_enabled()` 中 `start <= step/num_inference_steps < stop` 判断实现的。**为什么需要**：研究表明早期去噪步不需要强引导（噪声主导，引导方向不明确），后期步引导效果递减——区间控制让用户精细调节引导时间表。

### PerturbedAttentionGuidance：3 次前向 + hook 扰动

`PerturbedAttentionGuidance`（`perturbed_attention_guidance.py:36`）实现 PAG 算法（arXiv:2403.17377），通过扰动 attention score 矩阵制造"退化版"模型预测，以此作为引导方向：

```python title="src/diffusers/guiders/perturbed_attention_guidance.py"
class PerturbedAttentionGuidance(BaseGuidance):
    _input_predictions = ["pred_cond", "pred_uncond", "pred_cond_skip"]

    def prepare_models(self, denoiser):
        super().prepare_models(denoiser)  # _count_prepared += 1
        if self._is_slg_enabled() and self.is_conditional and self._count_prepared > 1:
            # 第 3 次前向：条件输入 + 挂载 attention 扰动 hook
            for config, name in zip(self.skip_layer_config, self._skip_layer_hook_names):
                self._apply_layer_skip_hook(denoiser, config, name=name)
```

PAG 的核心机制：

1. **3 次前向**：条件前向（`pred_cond`）→ 无条件前向（`pred_uncond`）→ 扰动条件前向（`pred_cond_skip`）。第 3 次前向复用条件输入（`tuple_index=0`），但通过 hook 扰动 attention score
2. **Hook 扰动**：`LayerSkipConfig` 强制设置 `skip_attention_scores=True`，hook 将指定层的 attention score 矩阵替换为单位矩阵，破坏 attention pattern
3. **引导组合**：`pred = base + cfg_scale * (pred_cond - pred_uncond) + pag_scale * (pred_cond - pred_cond_skip)`

**为什么用单位矩阵替换 attention score**：单位矩阵让 attention 退化为"每个 token 只看自己"，产生语义退化的输出。正常预测与退化预测的差值（`pred_cond - pred_cond_skip`）指向"退化方向"，引导生成远离这个方向——类似 CFG 但不需要空文本作为对照。

**为什么复用 SkipLayerGuidance 的 hook 基础设施**：PAG 和 SLG 的差异仅在 hook 行为（PAG 扰动 score，SLG 跳过整个 attention/FFN 层），hook 注册/移除逻辑完全相同。PAG 直接复用 SLG 的 `LayerSkipConfig` 和 `_apply_layer_skip_hook`，通过强制设置 `skip_attention_scores=True, skip_attention=False, skip_ff=False` 来区分行为。

### rescale_noise_cfg：防止过曝光

`rescale_noise_cfg`（`guider_utils.py:374`）实现论文"Common Diffusion Noise Schedules and Sample Steps are Flawed"（arXiv:2305.08891）的 rescale 机制：当 `guidance_scale` 较高时，CFG 会放大预测的方差导致过曝光。该函数按 `std_text / std_cfg` 比例缩放预测，再按 `guidance_rescale` 系数混合原始预测。CFG 和 PAG 的 `forward` 均在 `guidance_rescale > 0` 时调用此函数。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 策略模式 | `BaseGuidance` + 11 个子类 | 同一接口下替换引导算法，pipeline 不感知具体策略 |
| 模板方法 | `BaseGuidance.__call__` 调 `forward` | 基类控制验证和分发流程，子类只实现计算逻辑 |
| ConfigMixin 序列化 | `BaseGuidance(ConfigMixin)` | guider 可序列化为 `guider_config.json`，支持 `from_pretrained`/`save_pretrained` |
| 标识符映射 | `_identifier_key` 机制 | 解耦批次顺序与 forward 签名——子类按名称接收预测而非按位置 |
| 计数器状态机 | `_count_prepared` | 轻量追踪多次前向的阶段，无需显式状态枚举 |

## 模块间交互

### guider ↔ modular_pipeline

模块化管线系统通过 `ComponentSpec` 把 guider 声明为管线组件。guider 作为 `ConfigMixin`（非 `nn.Module`）对象，与 scheduler 同类——无需权重，通过 `from_config` 重建。`modular_pipeline_utils.py` 的 `ComponentSpec.from_component` 明确注释："ConfigMixin objects without weights (e.g. schedulers, guiders) can be passed directly"。

在去噪循环中，`LoopSequentialPipelineBlocks` 的 `loop_step` 驱动每个子 block 执行，guider 的 `set_state`/`prepare_inputs`/`prepare_models`/`__call__`/`cleanup_models` 在 denoise block 内被调用。

### guider ↔ hooks 系统

PAG 和 SLG 引导器通过 `hooks/` 模块的 `HookRegistry` 管理 attention 扰动 hook：

- `prepare_models` 中调用 `_apply_layer_skip_hook(denoiser, config, name)` → 通过 `HookRegistry.check_if_exists_or_initialize` 注册 hook
- hook 在前向时拦截 attention 模块，将 score 矩阵替换为单位矩阵
- `cleanup_models` 中调用 `registry.remove_hook(hook_name, recurse=True)` 移除 hook

这种交互让引导器能临时修改模型行为而不改变模型代码——hook 的注册和移除完全在 guider 的 `prepare_models`/`cleanup_models` 生命周期内完成。

## 扩展方式

新增一种引导策略（如 Identity Guidance）：

1. 新建 `src/diffusers/guiders/identity_guidance.py`——继承 `BaseGuidance`，实现 4 个抽象成员：
   - `_input_predictions` 类属性声明需要的前向预测名称
   - `prepare_inputs(data)` 拆分输入批次，用 `_prepare_batch` 打标签
   - `forward(**kwargs)` 实现引导计算公式，返回 `GuiderOutput`
   - `is_conditional` 属性（基于 `_count_prepared` 判断）
   - `num_conditions` 属性（返回需要的前向次数）
   - 如需 hook，覆盖 `prepare_models`/`cleanup_models`
2. `__init__.py` 中添加导入和导出
3. 使用 `@register_to_config` 装饰 `__init__`，确保参数可序列化
4. 无需修改任何 pipeline 代码——pipeline 通过 `ComponentSpec` 持有 guider 引用，按模板调用接口方法
