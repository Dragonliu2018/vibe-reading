---
source:
  type: "源码解读"
  project: "Diffusers"
  url: "https://github.com/huggingface/diffusers"
title: "模型架构"
date: "2026-08-12T15:35:17+08:00"
category: [AI, Infra, Inference, Diffusers, CodeWiki, "0.39.0"]
tags: ["Diffusers", "UNet", "VAE", "Transformer", "AutoencoderKL"]
description: "UNet2DConditionModel 的 down/mid/up block 架构、AutoencoderKL 的 KL 散度潜在空间、Transformer2DModel 的三模式输入。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/Diffusers/CodeWiki/0.39.0/00-overview)

---

## 模块定位

模型架构模块定义扩散模型的核心网络结构：UNet（条件去噪）、VAE（潜在空间编解码）、Transformer（DiT 风格架构）。这三类模型是扩散推理的"计算引擎"——管线层负责编排调用时序，调度器负责控制去噪数学，而真正的前向计算发生在 `models/` 定义的神经网络中。模块独立存在是因为**网络架构的定义与推理流程编排正交**：同一个 UNet 可被 SD 1.5、SDXL、ControlNet 等不同管线复用，同一个 VAE 可跨模型共享，只要接口（输入 latent + timestep + encoder_hidden_states → 输出噪声预测）一致即可互换。

## 模块架构

`models/` 目录按网络类型划分子目录，每个子目录封装一类模型家族的实现：

```
src/diffusers/models/
├── unets/                    # UNet 系列（条件去噪网络）
│   ├── unet_2d_condition.py  #   UNet2DConditionModel — SD 1.5/SDXL 核心
│   ├── unet_2d_blocks.py     #   down/mid/up block 定义 + 工厂函数
│   ├── unet_2d.py            #   UNet2DModel — 无条件去噪
│   ├── unet_3d_condition.py  #   UNet3DConditionModel — 视频生成
│   └── unet_motion_model.py  #   UNetMotionModel — 运动视频
├── autoencoders/             # VAE 系列（潜在空间编解码）
│   ├── autoencoder_kl.py     #   AutoencoderKL — 标准 KL-VAE
│   ├── vae.py                #   Encoder/Decoder/DiagonalGaussianDistribution
│   ├── autoencoder_tiny.py   #   TinyAutoencoder — 轻量 VAE
│   ├── autoencoder_dc.py     #   Deep Compression VAE
│   └── consistency_decoder_vae.py  # 一致性解码器 VAE
├── transformers/             # Transformer 系列（DiT 风格架构）
│   ├── transformer_2d.py     #   Transformer2DModel — 通用 2D DiT
│   ├── transformer_flux.py   #   FluxTransformer — FLUX 模型
│   ├── transformer_sd3.py    #   SD3Transformer2DModel — SD3 模型
│   └── transformer_wan.py    #   WanTransformer3D — Wan 视频
├── controlnets/              # ControlNet 系列（条件控制注入）
│   ├── controlnet.py         #   ControlNetModel — 标准 ControlNet
│   └── multicontrolnet.py    #   MultiControlNet — 多 ControlNet 组合
├── embeddings.py             # 嵌入层（TimestepEmbedding/Timesteps 等）
├── attention_processor.py    # 注意力处理器（策略模式核心）
├── modeling_utils.py         # ModelMixin — 模型基类
└── resnet.py                 # ResnetBlock2D — 基础卷积残差块
```

## 调用链路

### UNet forward 前向传播

`UNet2DConditionModel.forward`（`unet_2d_condition.py:978`）是扩散推理中最核心的单次计算。以下展示一次 forward 调用的完整数据流：

```
forward(sample, timestep, encoder_hidden_states)    [unet_2d_condition.py:978]
  │
  ├─ 1. 时间嵌入                                    [unet_2d_condition.py:1080]
  │   ├─ get_time_embed(sample, timestep)           → Timesteps → sinusoidal embedding
  │   ├─ time_embedding(t_emb, timestep_cond)       → TimestepEmbedding MLP
  │   ├─ get_class_embed(sample, class_labels)      → 可选类条件嵌入
  │   ├─ get_aug_embed(emb, ...)                    → 可选增强嵌入（text_image/time）
  │   └─ emb = emb + aug_emb                        → 最终时间嵌入向量
  │
  ├─ 2. 输入预处理                                  [unet_2d_condition.py:1107]
  │   └─ sample = self.conv_in(sample)              → Conv2d(4→320)
  │
  ├─ 3. down blocks（保存 skip connections）        [unet_2d_condition.py:1135]
  │   ├─ down_block_res_samples = (sample,)         → 初始化 skip 栈
  │   └─ for downsample_block in self.down_blocks:
  │       ├─ CrossAttnDownBlock2D: 有交叉注意力 → 传 encoder_hidden_states
  │       └─ DownBlock2D: 无交叉注意力 → 仅 ResnetBlock
  │       → 每层输出 res_samples 追加到 down_block_res_samples
  │
  ├─ 4. ControlNet 注入点                           [unet_2d_condition.py:1159]
  │   └─ if is_controlnet:
  │       └─ down_block_res_samples[i] += residual[i]  → ControlNet 残差注入
  │
  ├─ 5. mid block                                   [unet_2d_condition.py:1170]
  │   └─ self.mid_block(sample, emb, encoder_hidden_states)
  │       └─ UNetMidBlock2DCrossAttn: Resnet + Attention + Resnet
  │
  ├─ 6. up blocks（取 skip connections）             [unet_2d_condition.py:1195]
  │   └─ for upsample_block in self.up_blocks:
  │       ├─ res_samples = down_block_res_samples[-n:]  → 取对应 skip
  │       ├─ down_block_res_samples = down_block_res_samples[:-n]  → 弹出
  │       └─ CrossAttnUpBlock2D(sample, emb, res_hidden_states_tuple=res_samples, ...)
  │
  └─ 7. 输出后处理                                  [unet_2d_condition.py:1226]
      ├─ conv_norm_out → GroupNorm
      ├─ conv_act → SiLU
      └─ conv_out → Conv2d(320→4) → 噪声预测
```

| 阶段 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| 时间嵌入 | 将 timestep 编码为密集向量 | 正弦位置编码 + MLP，支持 class/aug 嵌入叠加 |
| conv_in | 4 通道 latent → 320 通道特征图 | 3x3 卷积，将潜在空间映射到特征空间 |
| down_blocks | 逐级下采样，保存多尺度特征 | 4 级 (320/640/1280/1280)，最后一级不下采样 |
| mid_block | 瓶颈层计算 | Resnet + Self-Attn + Cross-Attn + Resnet |
| up_blocks | 逐级上采样，融合 skip connection | 每级多一层 Resnet 以融合 skip |
| conv_out | 通道数还原为 latent 通道数 | 3x3 卷积，输出噪声预测 |

## 核心实现

### UNet2DConditionModel：down/mid/up 分层

UNet2DConditionModel 采用经典的 U 形结构——下采样路径提取多尺度特征，瓶颈层做最深层计算，上采样路径通过 skip connection 融合多尺度特征恢复分辨率。

**为什么分层**：分层设计有三重目的。第一，**多尺度特征提取**：`block_out_channels=(320, 640, 1280, 1280)` 使网络在低分辨率层捕获全局语义、高分辨率层保留细节。第二，**skip connection 保真**：每个 down block 的中间输出存入 `down_block_res_samples` 栈，up block 对应层取出拼接，防止信息在下采样过程中丢失。第三，**ControlNet/T2I-Adapter 注入点**：外部条件控制模型（ControlNet）的残差在 down/mid block 对应位置注入（`unet_2d_condition.py:1159-1168`），分层结构提供了天然的注入锚点。

**工厂函数**：block 的实际构建由 `get_down_block`（`unet_2d_blocks.py:43`）和 `get_up_block`（`unet_2d_blocks.py:327`）完成。这两个工厂函数接收 `down_block_type` 字符串，通过 if-elif 分发到具体 block 类：

```python title="get_down_block 工厂分发（unet_2d_blocks.py:43-77）"
def get_down_block(down_block_type, num_layers, in_channels, out_channels, ...):
    down_block_type = down_block_type[7:] if down_block_type.startswith("UNetRes") else down_block_type
    if down_block_type == "DownBlock2D":
        return DownBlock2D(...)
    elif down_block_type == "CrossAttnDownBlock2D":
        return CrossAttnDownBlock2D(...)
    elif down_block_type == "SimpleCrossAttnDownBlock2D":
        return SimpleCrossAttnDownBlock2D(...)
    # ... 更多 block 类型
```

SD 1.5 的典型配置是 `down_block_types=("CrossAttnDownBlock2D", "CrossAttnDownBlock2D", "CrossAttnDownBlock2D", "DownBlock2D")`——前三层有交叉注意力（与文本嵌入交互），最后一层纯 ResnetBlock（在最深尺度不做交叉注意力，减少计算量）。up block 的构建逻辑与 down block 对称，但每级多一层 Resnet 用于融合 skip connection（`layers_per_block + 1`，`unet_2d_condition.py:452`）。

**继承结构**：`UNet2DConditionModel` 继承 6 个 Mixin（`unet_2d_condition.py:76-77`）：

```python title="UNet2DConditionModel 多重继承"
class UNet2DConditionModel(
    ModelMixin, AttentionMixin, ConfigMixin, FromOriginalModelMixin,
    UNet2DConditionLoadersMixin, PeftAdapterMixin
):
```

`ModelMixin` 提供保存/加载能力，`ConfigMixin` 提供配置管理，`AttentionMixin` 提供注意力处理器管理，后三者分别支持单文件加载、UNet 专用 LoRA 加载和通用 PEFT adapter 注入。Mixin 组合避免了深层继承树，每个 Mixin 正交地贡献一个能力维度。

### AutoencoderKL：KL 散度潜在空间

AutoencoderKL 是 Stable Diffusion 的潜在空间编解码器。它将 512x512 的像素图像压缩为 64x64x4 的 latent，使 UNet 在 1/64 的数据量上做去噪，大幅降低计算成本。

**encode → DiagonalGaussianDistribution → sample → decode 流程**：

```python title="AutoencoderKL.encode（autoencoder_kl.py:171）"
@apply_forward_hook
def encode(self, x: torch.Tensor, return_dict: bool = True):
    # 1. 编码器前向：图像 → 特征图 [B, 2*latent_channels, H/8, W/8]
    h = self._encode(x)                    # encoder + quant_conv

    # 2. 构建对角高斯分布
    posterior = DiagonalGaussianDistribution(h)

    return AutoencoderKLOutput(latent_dist=posterior)
```

`DiagonalGaussianDistribution`（`vae.py:687`）是 KL-VAE 的核心数学对象。encoder 输出的通道数为 `2 * latent_channels`，`DiagonalGaussianDistribution.__init__` 将其沿通道维度一分为二——前半为均值 `mean`，后半为对数方差 `logvar`：

```python title="DiagonalGaussianDistribution 重参数化采样（vae.py:687-709）"
class DiagonalGaussianDistribution(object):
    def __init__(self, parameters):
        self.mean, self.logvar = torch.chunk(parameters, 2, dim=1)
        self.logvar = torch.clamp(self.logvar, -30.0, 20.0)  # 数值稳定
        self.std = torch.exp(0.5 * self.logvar)
        self.var = torch.exp(self.logvar)

    def sample(self, generator=None):
        # 重参数化技巧：z = mean + std * epsilon
        sample = randn_tensor(self.mean.shape, generator=generator, ...)
        x = self.mean + self.std * sample
        return x
```

**重参数化技巧**（Reparameterization Trick）：直接从分布采样不可微，`sample()` 将随机性转移到独立的 `epsilon` 上，使梯度能通过 `mean` 和 `std` 回传。训练时 KL 散度约束 latent 分布接近标准正态，推理时 `sample()` 生成带随机性的 latent。`logvar` 被 clamp 到 `[-30, 20]` 防止数值爆炸。

**scaling_factor=0.18215 的含义**：这个值是训练集首批次 latent 的逐分量标准差。管线在将 latent 送入 UNet 前乘以 `scaling_factor`（归一化到单位方差），UNet 输出后除以 `scaling_factor` 还原（`autoencoder_kl.py:57-63` 的文档注释）。这个缩放让 UNet 始终在单位方差空间工作，稳定训练和推理。对于 FLUX 等 newer 模型，使用 `shift_factor` 和 `latents_mean/std` 替代单一 `scaling_factor`，提供更灵活的归一化。

decode 流程是 encode 的镜像：`post_quant_conv` → `decoder`（`autoencoder_kl.py:199-211`），将 latent 解码回像素空间。

### Transformer2DModel：三种输入模式

Transformer2DModel 是 Diffusers 中 Transformer 架构的通用实现，被 DiT、PixArt、Sana 等模型使用。它的核心设计是**统一接口下的三种输入模式**，通过 `__init__` 时的配置自动选择（`transformer_2d.py:115-173`）：

```python title="Transformer2DModel 三种输入模式判定（transformer_2d.py:115-117）"
# 1. 连续输入：标准图像特征图 (B, C, H, W)
self.is_input_continuous = (in_channels is not None) and (patch_size is None)

# 2. 向量输入：离散 token ID (B, num_image_vectors)
self.is_input_vectorized = num_vector_embeds is not None

# 3. Patch 输入：图像分块 (DiT/FLUX 风格)
self.is_input_patches = in_channels is not None and patch_size is not None
```

| 模式 | 触发条件 | 输入处理 | 典型模型 |
|------|---------|---------|---------|
| `is_input_continuous` | `in_channels` 非空且 `patch_size=None` | GroupNorm + Conv2d/Linear 投影到 inner_dim | 早期 DiT 变体 |
| `is_input_vectorized` | `num_vector_embeds` 非空 | ImagePositionalEmbeddings + 查表嵌入 | VQ-VAE 离散 latent |
| `is_input_patches` | `in_channels` 和 `patch_size` 均非空 | PatchEmbed（切块 + 投影 + 位置编码） | FLUX / SD3 / PixArt |

**为什么统一接口**：三种模式的 Transformer 主体（`self.transformer_blocks`，由 `BasicTransformerBlock` 组成）完全相同，差异仅在输入投影和输出投影。统一接口让下游管线和注意力处理器无需感知输入模式，降低耦合。初始化时根据模式分发到 `_init_continuous_input` / `_init_vectorized_inputs` / `_init_patched_inputs`（`transformer_2d.py:168-173`），三种方法各自构建对应的 proj_in/proj_out 和位置编码，但共享 `transformer_blocks` 的构建逻辑。

`is_input_patches` 模式是最重要的——FLUX 和 SD3 都使用此模式。`PatchEmbed` 将 `(B, C, H, W)` 的特征图切分为 `(B, num_patches, inner_dim)` 的 token 序列，使 2D 图像能被标准 Transformer 处理。

### ModelMixin：模型基类

`ModelMixin`（`modeling_utils.py:232`）是所有 diffusers 模型的基类，继承 `torch.nn.Module` 和 `PushToHubMixin`：

```python title="ModelMixin 继承结构（modeling_utils.py:232）"
class ModelMixin(torch.nn.Module, PushToHubMixin):
    config_name = CONFIG_NAME
    _supports_gradient_checkpointing = False
    _no_split_modules = None
    # ...
```

**核心能力**：

- **save_pretrained**（`modeling_utils.py:669`）：将模型权重（safetensors）和配置（config.json）保存到目录。自动处理分片（sharding），大模型自动切分为多个文件。
- **from_pretrained**（`modeling_utils.py:876`）：从本地或 HuggingFace Hub 加载模型。支持 `dtype`（精度选择）、`low_cpu_mem_usage`（低内存加载）、`device_map`（设备映射）和量化参数。加载流程：下载/定位文件 → 读取 config → 实例化空模型 → 加载 state_dict。
- **enable_gradient_checkpointing**（`modeling_utils.py:285`）：激活梯度检查点，用计算换内存。子类需设置 `_supports_gradient_checkpointing = True` 并实现 `_set_gradient_checkpointing`。

**`__getattr__` 重写**（`modeling_utils.py:260`）：ModelMixin 重写了 `__getattr__` 以优雅地弃用直接属性访问——用户直接 `unet.sample_size` 会被重定向到 `unet.config.sample_size` 并发出弃用警告，保持向后兼容。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Mixin 组合 | `UNet2DConditionModel(ModelMixin, AttentionMixin, ConfigMixin, FromOriginalModelMixin, UNet2DConditionLoadersMixin, PeftAdapterMixin)` `unet_2d_condition.py:76` | 功能正交组合——保存/配置/注意力/加载/LoRA 各自独立，避免深层继承树 |
| 工厂函数 | `get_down_block` / `get_up_block` / `get_mid_block` `unet_2d_blocks.py:43,327` | 按 `block_type` 字符串分发到具体类，新增 block 类型只需加 elif 分支 |
| 策略模式 | `AttentionProcessor` 体系 `attention_processor.py` | 同一 Attention 类通过 `set_attn_processor` 切换注意力实现（AttnProcessor / AttnProcessor2_0 / xFormers），运行时可替换 |
| 装饰器 | `@register_to_config` `configuration_utils.py` | 拦截 `__init__` 参数，自动存入 config，避免手动维护配置字典 |
| 装饰器 | `@apply_lora_scale` `utils/__init__.py` | 包装 `forward`，在调用前自动缩放 LoRA 权重，不改 forward 逻辑 |
| 装饰器 | `@apply_forward_hook` `utils/accelerate_utils.py` | 包装 `encode`/`decode`，自动注册前向钩子用于组卸载等优化 |
| 模板方法 | `ModelMixin.from_pretrained` → 子类 `__init__` | 统一加载骨架（下载→config→实例化→加载权重），子类只需定义架构 |

## 模块间交互

模型架构模块在 Diffusers 的五层架构中处于**模型层**，被上层管线层加载和调用，被平行层（加载器、钩子）注入和包装：

**被 pipeline 调用**：管线通过 `load_sub_model`（`pipeline_utils.py`）在 `from_pretrained` 时加载模型——读取 `model_index.json` 中组件的 `class_name`，调用 `ModelMixin.from_pretrained` 加载 UNet/VAE/Transformer。推理时管线直接调用 `unet(latent, timestep, encoder_hidden_states)` 和 `vae.decode(latent)`。

**被 loaders 注入 LoRA**：`loaders/peft.py` 的 `PeftAdapterMixin.load_lora_adapter` 在运行时向 UNet 的注意力层注入 LoRA adapter，不修改模型代码。`@apply_lora_scale` 装饰器在 `forward` 调用前自动缩放 LoRA 权重。同一个 UNet 可叠加多个 LoRA adapter 并支持热替换。

**被 hooks 包装 forward**：`hooks/` 模块通过 `HookRegistry.register_hook()` 将 `ModelHook` 注册到模型的子模块，包装其 `forward` 方法。例如 `FBCHeadBlockHook` 缓存首次计算的输出，后续推理直接复用；`GroupOffloadingHook` 将模块按组卸载到 CPU 以节省显存。这些优化对模型代码完全透明。

## 扩展方式

**新增 UNet block 类型**：

1. 在 `unet_2d_blocks.py` 中定义新的 block 类（如 `MyDownBlock2D`），继承 `nn.Module`，实现 `forward` 方法
2. 在 `get_down_block` / `get_up_block` 工厂函数中添加 `elif down_block_type == "MyDownBlock2D":` 分支
3. 在模型 config 的 `down_block_types` 中使用新类型名

无需修改 `unet_2d_condition.py` 的 forward 逻辑——forward 通过 `has_cross_attention` 属性判断分支，新 block 只需正确设置该属性即可被自动路由。

**新增 VAE 变体**：

1. 在 `autoencoders/` 下新建 `autoencoder_my.py`，定义 `AutoencoderMy(ModelMixin, ConfigMixin, ...)`
2. 实现 `encode` / `decode` / `_encode` / `_decode` 方法，保持与 AutoencoderKL 相同的接口签名
3. 在 `autoencoders/__init__.py` 的 `_import_structure` 中注册导出

管线代码无需修改——它通过 `vae.encode(image)` 和 `vae.decode(latent)` 调用，只要接口一致即可无缝替换。例如 `AutoencoderTiny` 和 `ConsistencyDecoderVAE` 就是这种方式的变体实现。
