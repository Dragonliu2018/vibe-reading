---
source:
  type: "源码解读"
  project: "Diffusers"
  url: "https://github.com/huggingface/diffusers"
title: "加载器"
date: "2026-08-12T15:35:17+08:00"
category: [AI, Diffusers, CodeWiki, "0.39.0"]
tags: ["Diffusers", "LoRA", "IP-Adapter", "PEFT", "SingleFile"]
description: "Mixin 架构的 LoRA/IP-Adapter 运行时注入、单文件加载、PEFT 集成。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Diffusers/CodeWiki/0.39.0/00-overview)

---

## 模块定位

加载器模块解决了扩散模型生态中一个核心工程问题：**如何在不重新训练、不修改模型代码的前提下，运行时向模型注入额外的适配器权重**。LoRA（Low-Rank Adaptation）通过低秩矩阵分解实现参数高效微调，IP-Adapter 通过图像嵌入实现图像条件控制，Textual Inversion 通过嵌入向量实现概念定制——这些技术的共同点是"在已加载的模型上叠加轻量修改"，而非替换模型本身。

加载器模块的核心职责边界：负责适配器权重的下载、格式转换、运行时注入和管理，不负责模型架构定义和推理流程编排。它与模型层（`models/`）和管线层（`pipelines/`）完全解耦——管线通过 Mixin 方法（`pipe.load_lora_weights()`）触发加载，加载器修改模型的 `nn.Module` 结构，管线对修改后的模型执行推理。

## 模块架构

```
loaders/
├── lora_base.py                 # LoraBaseMixin 模板方法 + _fetch_state_dict 工具函数
├── peft.py                      # PeftAdapterMixin（PEFT 后端 LoRA 注入）
├── ip_adapter.py                # IPAdapterMixin + 3 个变体
├── single_file.py               # FromSingleFileMixin（.ckpt/.safetensors 单文件加载）
├── lora_conversion_utils.py     # 格式转换（Kohya/XLabs/BFL → Diffusers/PEFT 格式）
├── unet_loader_utils.py         # UNet 特定的 LoRA 辅助
├── textual_inversion.py         # TextualInversionLoaderMixin
└── utils.py                     # 共享工具函数
```

加载器模块的内部设计基于一个关键决策：**用 Mixin 组合而非继承树管理多种加载能力**。一个管线需要同时支持 LoRA 加载、IP-Adapter 加载、单文件加载、Textual Inversion 加载——如果用继承，需要 `StableDiffusionPipeline(LoRALoader, IPAdapterLoader, SingleFileLoader, TextualInversionLoader, DiffusionPipeline)` 这样的多重继承，且每种加载能力的排列组合导致子类爆炸。Mixin 方案让管线按需组合：`class StableDiffusionPipeline(DiffusionPipeline, TextualInversionLoaderMixin, LoraLoaderMixin, IPAdapterMixin, FromSingleFileMixin)`，每种加载能力是一个独立 Mixin，可任意增减。

加载器分为两大类：**运行时适配器注入**（LoRA / IP-Adapter / Textual Inversion）在已加载的模型上动态添加层或替换处理器；**单文件加载**（FromSingleFileMixin）从 `.ckpt`/`.safetensors` 单文件重建整个管线。前者修改模型结构，后者创建管线实例，两者职责正交。

`lora_conversion_utils.py` 是格式转换的核心——社区存在 Kohya、XLabs、BFL、Fal、Musubi 等多种 LoRA 存储格式，它们的 key 命名规则各不相同。加载器在注入前先将各种格式统一转换为 PEFT 库期望的 `lora_A`/`lora_B` key 格式，再交给 PEFT 的 `inject_adapter_in_model` 执行注入。这是适配器模式的典型应用——适配各种外部格式到统一的内部接口。

## 调用链路

### LoRA 加载流程

```
pipe.load_lora_weights("path/to/lora.safetensors", adapter_name="style1")
  │
  ├── lora_state_dict()                                    # 获取权重 state_dict
  │     └── _fetch_state_dict()                            # lora_base.py:198 下载/加载文件
  │           └── safetensors.torch.load_file()             # 优先 .safetensors，fallback .bin
  │
  ├── 格式检测与转换
  │     ├── first_key = next(iter(state_dict.keys()))
  │     ├── if "lora_A" not in first_key:                  # 非 PEFT 格式
  │     │     └── convert_unet_state_dict_to_peft(state_dict)  # peft.py:219
  │     └── _convert_kohya_flux_lora_to_diffusers()         # lora_conversion_utils.py:385
  │           _convert_xlabs_flux_lora_to_diffusers()       # lora_conversion_utils.py:951
  │           _convert_bfl_flux_control_lora_to_diffusers() # lora_conversion_utils.py:1076
  │           ...                                           # 20+ 格式转换函数
  │
  ├── rank 推断
  │     └── for key, val in state_dict.items():
  │           if "lora_B" in key: rank[key] = val.shape[1]  # peft.py:232 从权重形状推断 rank
  │
  ├── _create_lora_config(state_dict, network_alphas, rank) # peft_utils.py:347 创建 LoraConfig
  │
  ├── inject_adapter_in_model(lora_config, model, ...)      # peft.py:327 PEFT 运行时注入
  │     └── 在每个 target module 上创建 LoraLayer            # 不修改原始权重，新增 lora_A/lora_B 层
  │
  └── set_peft_model_state_dict(model, state_dict, ...)     # peft.py:330 加载权重到 LoRA 层
```

LoRA 加载的完整链路体现了"获取 → 转换 → 注入 → 加载"四阶段设计。每个阶段都有明确职责：`_fetch_state_dict` 只负责把文件变成 dict，不关心格式；格式转换只负责 key 重命名和结构适配，不碰权重值；`inject_adapter_in_model` 只负责在模型结构上创建 LoRA 层，不加载权重；`set_peft_model_state_dict` 只负责把权重值填入已创建的 LoRA 层。这种分阶段设计使得每一步可独立测试和替换——比如换一种文件格式只需改 `_fetch_state_dict`，换一种 LoRA 变体只需改格式转换函数。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `LoraBaseMixin.load_lora_weights()` in `lora_base.py:503` | 模板方法，子类实现 | 抛 `NotImplementedError`，强制子类覆写 |
| `LoraBaseMixin.lora_state_dict()` in `lora_base.py:511` | 获取 LoRA 权重 dict | 类方法，抛 `NotImplementedError`，子类实现 |
| `LoraBaseMixin.unload_lora_weights()` in `lora_base.py:514` | 卸载 LoRA 层 | 调用 PEFT `unload()` 或移除 monkey patch |
| `LoraBaseMixin.fuse_lora()` in `lora_base.py:537` | 融合 LoRA 到原始权重 | 融合后无推理开销，但失去热替换能力 |
| `_fetch_state_dict()` in `lora_base.py:198` | 下载/加载权重文件 | 优先 safetensors，fallback pickle |
| `PeftAdapterMixin.load_lora_adapter()` in `peft.py:80` | PEFT 后端 LoRA 注入 | 格式转换 → LoraConfig → inject → set_state_dict |
| `IPAdapterMixin.load_ip_adapter()` in `ip_adapter.py:58` | 加载 IP-Adapter | 拆分 image_proj/ip_adapter，加载 CLIP image encoder |
| `FromSingleFileMixin.from_single_file()` in `single_file.py:273` | 单文件加载管线 | .ckpt/.safetensors → fetch config → 实例化管线 |
| `convert_unet_state_dict_to_peft()` | Diffusers → PEFT 格式 | key 重命名，被 `peft.py:219` 调用 |

</details>

---

## 核心实现

### LoraBaseMixin：模板方法骨架

`LoraBaseMixin`（`lora_base.py:479`）是所有 LoRA 加载能力的抽象骨架，采用模板方法模式——定义 LoRA 管理的标准接口（加载、卸载、融合、保存），但不实现具体加载逻辑（留给子类 Mixin 覆写）。

```python title="lora_base.py:479"
class LoraBaseMixin:
    """Utility class for handling LoRAs."""
    _lora_loadable_modules = []
    _merged_adapters = set()

    def load_lora_weights(self, **kwargs):
        raise NotImplementedError("`load_lora_weights()` is not implemented.")

    @classmethod
    def lora_state_dict(cls, **kwargs):
        raise NotImplementedError("`lora_state_dict()` is not implemented.")

    def unload_lora_weights(self):
        # 遍历 _lora_loadable_modules，对每个组件调用 unload
        for component in self._lora_loadable_modules:
            model = getattr(self, component, None)
            if model is not None:
                if issubclass(model.__class__, ModelMixin):
                    model.unload_lora()
                elif issubclass(model.__class__, PreTrainedModel):
                    _remove_text_encoder_monkey_patch(model)
```

`load_lora_weights()` 和 `lora_state_dict()` 抛出 `NotImplementedError` 是刻意的设计——`LoraBaseMixin` 定义"LoRA 加载器必须能做什么"，但"怎么做"取决于具体后端。v0.39.0 的默认后端是 PEFT（`PeftAdapterMixin`），但历史上存在过 monkey-patch 后端（`AttnProcsLoRAWrapper`），未来可能有新后端。模板方法让切换后端只需替换子类 Mixin，不改管线代码。

`_lora_loadable_modules` 是一个关键属性——它声明管线中哪些组件可以加载 LoRA。Stable Diffusion 管线设为 `["unet", "text_encoder"]`，FLUX 管线设为 `["transformer", "text_encoder", "text_encoder_2"]`。`unload_lora_weights()` 和 `fuse_lora()` 遍历此列表对每个组件操作，避免硬编码组件名。

`fuse_lora()`（`lora_base.py:537`）将 LoRA 权重数学融合到原始权重中（$W' = W + \alpha \cdot B A$），融合后推理时不再经过 LoRA 层，消额外计算开销。但融合是不可逆的（`unload` 无法恢复原始权重），且失去多 adapter 热替换能力——这是性能与灵活性的权衡。

### PeftAdapterMixin：运行时注入

`PeftAdapterMixin`（`peft.py:57`）是 v0.39.0 的默认 LoRA 后端，通过 PEFT 库的 `inject_adapter_in_model` 实现运行时注入。其核心方法 `load_lora_adapter()`（`peft.py:80`）执行完整的加载链路。

格式转换是第一个关键步骤。PEFT 期望 state_dict 的 key 格式为 `lora_A.weight` / `lora_B.weight`，但社区格式各不相同——Kohya 用 `lora_down.weight` / `lora_up.weight`，XLabs 用不同前缀。`load_lora_adapter` 通过检查 first key 判断是否需要转换：

```python title="peft.py:217"
# check with first key if is not in peft format
first_key = next(iter(state_dict.keys()))
if "lora_A" not in first_key:
    state_dict = convert_unet_state_dict_to_peft(state_dict)

# Control LoRA from SAI is different from BFL Control LoRA
is_sai_sd_control_lora = "lora_controlnet" in state_dict
if is_sai_sd_control_lora:
    state_dict = convert_sai_sd_control_lora_state_dict_to_peft(state_dict)
```

`lora_conversion_utils.py` 包含 20+ 格式转换函数，覆盖 Kohya、XLabs、BFL、Fal、Musubi、Hunyuan、Wan、LTXV 等社区格式。每个转换函数做两件事：key 重命名（将社区格式的 key 映射到 Diffusers/PEFT 格式）和结构适配（如某些格式将 UNet 和 text encoder 的 LoRA 混在一起，需要拆分）。这是适配器模式的典型应用——外部格式多样且持续演化，转换函数将它们统一到 PEFT 的单一接口。

rank 推断是第二个关键步骤。LoRA 的 rank（低秩矩阵的维度）决定模型容量和显存占用。`load_lora_adapter` 从 `lora_B` 权重的第二维推断 rank（`peft.py:232`）：

```python title="peft.py:228"
rank = {}
for key, val in state_dict.items():
    if "lora_B" in key and val.ndim > 1:
        rank[f"^{key}"] = val.shape[1]
```

`^` 前缀是 PEFT 的正则匹配语法（见 PEFT PR #2419），用于处理模块名共享前缀时的歧义——如 `proj_out.weight` 和 `blocks.transformer.proj_out.weight` 可能需要不同的 rank。

注入和权重加载由 PEFT 库完成（`peft.py:327`）：

```python title="peft.py:327"
inject_adapter_in_model(lora_config, self, adapter_name=adapter_name, state_dict=state_dict, **peft_kwargs)
incompatible_keys = set_peft_model_state_dict(self, state_dict, adapter_name, **peft_kwargs)
```

`inject_adapter_in_model` 遍历模型中所有匹配 `LoraConfig.target_modules` 的 `nn.Module`，为每个模块创建 `lora_A` 和 `lora_B` 两个低秩矩阵层，包装成 `LoraLayer`。原始权重不被修改——LoRA 层的输出 $Wx + \alpha \cdot B(Ax)$ 与原始层输出叠加。这种设计支持多 adapter 叠加（同一模块可以有多个 `adapter_name` 的 LoRA 层）和热替换（通过 `set_adapter()` 切换激活的 adapter）。

**hotswap 机制**（`peft.py:294`）是 v0.39.0 的重要增强。传统 LoRA 加载需要先 `inject_adapter_in_model` 创建新层再 `set_peft_model_state_dict` 加载权重，这会改变模型结构导致 `torch.compile` 重新编译。hotswap 通过 `prepare_model_for_compiled_hotswap` 预分配最大 rank 的 LoRA 层，之后加载新 adapter 只替换权重值不改结构——避免重新编译，大幅加速多 LoRA 切换场景。

### IPAdapterMixin：图像条件注入

`IPAdapterMixin`（`ip_adapter.py:54`）处理 IP-Adapter 的加载——IP-Adapter 通过将参考图像编码为嵌入向量，注入到 UNet 的 cross-attention 层中实现图像条件控制。它的加载逻辑与 LoRA 完全不同：LoRA 修改线性层的权重，IP-Adapter 替换 attention processor。

```python title="ip_adapter.py:58"
def load_ip_adapter(self, pretrained_model_name_or_path_or_dict, subfolder, weight_name, ...):
    # 1. 加载 state_dict（支持多个 IP-Adapter 并行加载）
    for path, name, folder in zip(paths, weight_names, subfolders):
        state_dict = load_state_dict(model_file)
        # 拆分为两个子 dict
        state_dict = {"image_proj": {...}, "ip_adapter": {...}}
        state_dicts.append(state_dict)

        # 2. 加载 CLIP image encoder（如果尚未注册）
        if self.image_encoder is None:
            image_encoder = CLIPVisionModelWithProjection.from_pretrained(...)
            self.register_modules(image_encoder=image_encoder)

        # 3. 创建 feature extractor
        if self.feature_extractor is None:
            feature_extractor = CLIPImageProcessor(...)
            self.register_modules(feature_extractor=feature_extractor)

    # 4. 注入到 UNet
    unet._load_ip_adapter_weights(state_dicts)
```

IP-Adapter 的 state_dict 有两个独立部分：`image_proj`（图像投影层，将 CLIP 图像嵌入映射到 UNet 能理解的维度）和 `ip_adapter`（cross-attention 层的额外权重）。这种分离设计使得同一个 image projection 可以搭配不同的 attention 权重——比如 FaceID IP-Adapter 复用 CLIP image encoder 但用不同的 attention 权重。

IP-Adapter 有 4 个 Mixin 变体，按模型架构分化：

| Mixin | 位置 | 适用模型 |
|-------|------|---------|
| `IPAdapterMixin` | `ip_adapter.py:54` | Stable Diffusion 1.5 / SDXL |
| `ModularIPAdapterMixin` | `ip_adapter.py:355` | 模块化管线（Wan / SD3） |
| `FluxIPAdapterMixin` | `ip_adapter.py:605` | FLUX |
| `SD3IPAdapterMixin` | `ip_adapter.py:897` | Stable Diffusion 3 |

这种分化是必要的——不同架构的 attention processor 不同（SD 用 `IPAdapterAttnProcessor`，FLUX 用 `JointAttnProcessor2_0`，SD3 用 `SD3IPAdapterJointAttnProcessor2_0`），注入逻辑也有差异。每个 Mixin 变体处理各自架构的 attention processor 替换，但共享 `load_ip_adapter` 的整体流程（加载 state_dict → 加载 image encoder → 注入 UNet）。

### FromSingleFileMixin：单文件加载

`FromSingleFileMixin`（`single_file.py:266`）处理社区常见的单文件格式（`.ckpt`/`.safetensors`）——这种格式将整个管线（UNet + VAE + text encoder + scheduler config）的所有权重打包在一个文件中，与 Diffusers 的多文件目录格式（`model_index.json` + 各子目录）完全不同。

```python title="single_file.py:273"
@classmethod
def from_single_file(cls, pretrained_model_link_or_path, **kwargs):
    # 1. 下载/加载单文件 checkpoint
    checkpoint = load_single_file_checkpoint(pretrained_model_link_or_path, ...)

    # 2. 从 checkpoint 推断 diffusers 格式的 config
    config = fetch_diffusers_config(checkpoint)
    cached_model_config_path = _download_diffusers_model_config_from_hub(...)

    # 3. 用 diffusers config 实例化管线
    pipeline_class = _get_pipeline_class(cls, config=None)
    config_dict = pipeline_class.load_config(cached_model_config_path)

    # 4. 从 checkpoint 拆分各组件权重并加载
    # ...
```

单文件加载的核心挑战是**config 推断**——单文件只有权重没有配置，Diffusers 需要知道用哪个管线类、各组件的参数。`fetch_diffusers_config()` 通过 checkpoint 的 key 结构推断模型类型（SD 1.5 / SDXL / FLUX），然后从 HuggingFace Hub 下载对应的 diffusers 格式 config。如果网络不可用（`local_files_only=True`），它会 fallback 到 `original_config`（原始 OmegaConf 格式的配置文件）来推断参数。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Mixin 组合 | `LoraBaseMixin` / `PeftAdapterMixin` / `IPAdapterMixin` / `FromSingleFileMixin` | 多种加载能力按需组合到一个管线类，避免多重继承爆炸 |
| 模板方法 | `LoraBaseMixin.load_lora_weights()` in `lora_base.py:503` | 定义标准接口，子类实现具体后端，可切换 LoRA 后端 |
| 适配器模式 | `convert_unet_state_dict_to_peft()` / `_convert_kohya_*` in `lora_conversion_utils.py` | 社区格式多样且持续演化，转换函数统一到 PEFT 接口 |
| 委托模式 | `PeftAdapterMixin.load_lora_adapter()` → `inject_adapter_in_model` in `peft.py:327` | 将注入逻辑委托给 PEFT 库，不重复造轮子 |
| 策略模式 | `IPAdapterMixin` vs `FluxIPAdapterMixin` vs `SD3IPAdapterMixin` | 同一 IP-Adapter 加载接口，不同架构用不同注入策略 |

## 模块间交互

加载器模块是连接管线、模型和外部库（PEFT）的桥梁。管线通过 Mixin 方法触发加载（`pipe.load_lora_weights()`），加载器修改模型的 `nn.Module` 结构（注入 LoRA 层或替换 attention processor），管线对修改后的模型执行推理。这种交互方式的关键在于**加载器不持有模型引用**——它通过 `self._lora_loadable_modules` 知道要操作哪些组件，通过 `getattr(self, component)` 获取模型实例，注入完成后即释放。模型不知道自己被注入了什么——它只看到自己的 `nn.Module` 结构变了。

与 PEFT 库的交互通过 `inject_adapter_in_model` / `set_peft_model_state_dict` / `get_peft_model_state_dict` 三个函数完成。Diffusers 不自己实现 LoRA 层的创建和管理，而是完全委托给 PEFT——这带来两个好处：其一，PEFT 的 LoRA 实现经过广泛测试且持续维护，Diffusers 不必重复造轮子；其二，PEFT 支持多种 adapter 类型（LoRA、AdaLoRA、IA3 等），Diffusers 未来扩展只需利用 PEFT 的能力。代价是强依赖 PEFT 版本——`peft.py` 中多处用 `is_peft_version(">=", "0.13.1")` 做版本检测，不同 PEFT 版本的行为有差异。

`_optionally_disable_offloading()`（`peft.py:77`）是加载器与管线 offload 机制的交互点。LoRA 注入需要修改模型结构（添加新层），但 CPU offload 的 hooks 会干扰这一过程——注入前需要临时移除 offload hooks，注入后恢复。`load_lora_adapter` 调用此方法检测并临时禁用 `model_cpu_offload` / `sequential_cpu_offload` / `group_offload`，注入完成后再恢复。

## 扩展方式

**新增一种 LoRA 格式**：

1. 在 `lora_conversion_utils.py` 中添加 `_convert_myformat_lora_to_diffusers(state_dict)` 函数，实现 key 重命名和结构适配
2. 在 `peft.py` 的 `load_lora_adapter()` 中添加格式检测分支（如检查特征 key），调用新转换函数
3. 对应测试：`tests/loaders/test_lora_conversion.py`

**新增一种 IP-Adapter 类型**：

1. 在 `models/attention_processor.py` 中定义新的 `IPAdapterAttnProcessor` 子类（如需新 attention 逻辑）
2. 在 `ip_adapter.py` 中添加新 Mixin 或扩展现有 Mixin 的 `_load_ip_adapter_weights` 方法，处理新 processor 的创建和权重加载
3. 在目标管线的类定义中添加新 Mixin
4. 对应测试：`tests/loaders/test_ip_adapter.py`

**新增一种单文件格式**：

1. 在 `single_file.py` 的 `fetch_diffusers_config()` 中添加新格式的检测逻辑
2. 如果 key 结构与现有格式差异大，添加专门的 key 拆分函数
3. 在 `from_single_file()` 的组件加载流程中处理新格式特有字段
