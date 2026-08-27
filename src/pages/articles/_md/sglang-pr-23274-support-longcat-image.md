---
title: "在 SGLang 中接入 LongCat-Image：一个文生图 DiT 模型的全栈适配"
source:
  project: "SGLang"
  type: "PR"
  id: "23274"
  url: "https://github.com/sgl-project/sglang/pull/23274"
  prType: "feat"
date: "2026-08-10T22:23:49+08:00"
category: [AI, Infra, Inference, SGLang, Contributions]
tags: ["Diffusion", "DiT", "SGLang", "Tensor Parallelism", "Qwen2.5-VL", "LongCat-Image"]
description: "解读 PR #23274：如何在 SGLang multimodal_gen 框架中接入 LongCat-Image 文生图模型，涵盖 MMDiT TP 并行化、Qwen2.5-VL Prompt Rewrite、3D RoPE 与组合式 Pipeline 复用。"
readingTime: "20 min"
aiModel: "Claude Opus 4.8"
reviewed: false
pinned: true
---

> **PR** [#23274](https://github.com/sgl-project/sglang/pull/23274) · **Issue** - · **commit** [b764194](https://github.com/sgl-project/sglang/commit/b764194e810f9ca7ad2c21e4d307d86158acfd12) · **首发版本** v0.5.18 · **变更行数** +1641 行（10 文件）· **合并时间** 2026-08-13

---

## 背景

LongCat-Image 是美团 LongCat 团队的文生图模型，基于 **Flow Matching + MMDiT** 架构（Flux 同族），使用 **Qwen2.5-VL（7B）** 作为文本编码器。它的一个显著特点是用 Qwen2.5-VL 对输入 prompt 进行 **VLM 改写（Prompt Rewrite）**——把用户的简短描述自回归扩写成细节丰富的长文本，再送入 DiT 去噪，从而提升生成质量。

SGLang 的 `multimodal_gen` 子系统已经接入了 Wan、Hunyuan、ZImage、Flux、Qwen-Image 等多个扩散模型，形成了一套"标准 Stage + 模型特定 `PipelineConfig` hooks"的组合式 pipeline 框架。本 PR 的目标，是把 LongCat-Image 也接入这套框架，复用已有的标准去噪 / 解码 Stage，同时支持 Tensor Parallelism（TP）多卡推理。

![LongCat-Image Pipeline 架构（6 阶段）](/vibe-reading/images/articles/sglang-pr-23274-support-longcat-image/pipeline-architecture.svg)

上图标注了 PR 的 Pipeline 架构：黄色框 `LongCatPromptRewriteStage` 是唯一模型特定的 Stage（新增代码），蓝色框 Stage 2-6 全部复用框架标准实现。改动集中在 Stage 1 + `PipelineConfig` hooks，标准去噪/解码链路零改动直接复用。

---

## 前置知识

### SGLang multimodal_gen 的组合式 Pipeline

`multimodal_gen` 把一次生成拆成一串 `PipelineStage`，由 `ComposedPipelineBase` 顺序执行。框架提供一批**标准 Stage**（`LatentPreparationStage` / `TimestepPreparationStage` / `DenoisingStage` / `DecodingStage`），它们的行为通过一个模型特定的 `PipelineConfig` 的若干 hook 方法注入。模型只需实现自己的 `PipelineConfig`（描述 latent 形状、pack/unpack、sigma 调度、CFG 后处理等）和必要的**模型特定 Stage**（如 prompt rewrite），就能拼出完整 pipeline，无需改框架代码。

### Packed Latents

Flux 同族模型把相邻 2×2 空间位置的 16 个通道折叠成 64 维 token，序列长度压缩 4 倍，降低自注意力复杂度。LongCat 沿用这一格式。

### 3D RoPE 与 axes_dims

LongCat 使用 3D RoPE：每个 token 的位置是 3 维向量 `(modality_id, axis1, axis2)`，`axes_dims_rope=[16, 56, 56]` 把 `head_dim=128` 切成三段，分别施加旋转。文本 token 的位置是 `(0, i, i)`，图像 token 是 `(1, row, col)`，第一个轴区分模态。

---

## 设计参考

本 PR 的 DiT 模型实现 `runtime/models/dits/longcat_image.py` 文件头明确标注：

```text title="longcat_image.py"
# Copied and adapted from: https://github.com/huggingface/diffusers
# main/src/diffusers/models/transformers/transformer_longcat_image.py
```

即直接对齐 diffusers 的 `LongCatImageTransformer2DModel` 与 `LongCatImagePipeline` 参考实现，保证数值一致；所有算法逻辑（pack/unpack、`_calculate_shift`、CFG renorm、quotation-aware tokenize、bilingual system prompt）都从 diffusers 1:1 移植。SGLang 侧的工作不是重新设计算法，而是**把这套算法映射到 TP 并行 + 组合式 Stage 框架**。

---

## 实现

### 模型架构总览

| 组件 | 类型 | 说明 |
|------|------|------|
| `text_encoder` | `Qwen2_5_VLForConditionalGeneration` | 取最后一层 hidden states 作为文本 embedding；也用于 prompt rewrite |
| `tokenizer` | `Qwen2Tokenizer` | `max_length=512` |
| `text_processor` | `Qwen2VLProcessor` | prompt rewrite 的 chat template 处理 |
| `transformer` | `LongCatImageTransformer2DModel` | DiT 主体：19 双流块 + 38 单流块 |
| `vae` | `AutoencoderKL` | 标准 VAE，8× 空间压缩 |
| `scheduler` | `FlowMatchEulerDiscreteScheduler` | Flow Matching 调度器 |

关键超参（`LongCatImageArchConfig`）：`num_attention_heads=24`、`attention_head_dim=128`、`hidden_size=3072`、`joint_attention_dim=3584`（Qwen2.5-VL hidden size）、`axes_dims_rope=[16,56,56]`、`num_layers=19`（双流）、`num_single_layers=38`（单流）。

### DiT 模型：TP 并行化与权重加载

`runtime/models/dits/longcat_image.py` 把 diffusers 的串行实现改写为全层 TP 并行。

![LongCatImageTransformer2DModel 架构（TP 并行）](/vibe-reading/images/articles/sglang-pr-23274-support-longcat-image/dit-model-architecture.svg)

上图展示了 DiT 模型的数据流：三条输入路径（packed latents → x_embedder、text embeds → context_embedder、timestep → time_embed）汇入 19 个双流块再到 38 个单流块，最后经 norm_out + proj_out 输出速度场。粉色虚线框标注了 RoPE 在 DiT forward 中**实时计算**（非预处理阶段预计算），对齐 diffusers transformer 的行为。

**FFN 对齐 checkpoint 键名**：diffusers 原始 FFN 结构是 `Linear → GELU → Dropout(0.0) → Linear`，索引为 `net.0.proj` / `net.1` / `net.2`。`Dropout(0.0)` 是 no-op，但它的存在决定了 checkpoint 权重键名（`transformer_blocks.0.ff.net.0.proj.weight`）。SGLang 实现保留 `nn.Dropout(0.0)` 占位 `net.1`，让 loader 用相同键名直接加载，无需重映射：

```python title="runtime/models/dits/longcat_image.py"
class _LongCatFFN(nn.Module):
    def __init__(self, dim, inner_dim, bias=True, prefix=""):
        self.net = nn.ModuleList([
            nn.ModuleDict({"proj": ColumnParallelLinear(dim, inner_dim,
                gather_output=False, prefix=f"{prefix}.net.0.proj")}),
            nn.Dropout(0.0),                       # net.1: 占位，对齐 checkpoint 键名
            RowParallelLinear(inner_dim, dim, input_is_parallel=True,
                prefix=f"{prefix}.net.2"),
        ])
        self.act = nn.GELU(approximate="tanh")
```

**双流注意力 `gather_output=False`**：`ColumnParallelLinear` 把输出列维度按 TP rank 分片，`gather_output=False` 让各 rank 持有自己的头分片（`num_local_heads = 24 / tp_size`）直接送 `USPAttention`，避免一次 all-gather 后又立即分片；`RowParallelLinear`（输出投影）输入本身分片，内置 all-reduce 完成聚合。图像与文本 QKV 分别投影、QK-Norm（SGLang fused `apply_qk_norm`），再 `cat([txt, img], dim=1)`（txt 在前，匹配 diffusers 约定）后送 `USPAttention(num_replicated_prefix=txt_seq_len)`。

**RoPE 用 diffusers `apply_rotary_emb` 而非 flashinfer**：`axes_dims_rope=[16,56,56]` 之和 = 128 = `head_dim`，即全维度旋转。flashinfer 的 `cos_sin_cache` 格式要求 `rotary_dim ≤ head_dim`，全维度旋转不兼容；diffusers 的 `apply_rotary_emb` 支持 `sequence_dim=1` 的全维度旋转，保证数值一致。

```python title="runtime/models/dits/longcat_image.py"
# RoPE 应用在 concat 之后，覆盖完整 [txt+img] 序列
if image_rotary_emb is not None:
    q = apply_rotary_emb(q, image_rotary_emb, sequence_dim=1)
    k = apply_rotary_emb(k, image_rotary_emb, sequence_dim=1)
x = self.attn(q, k, v, num_replicated_prefix=txt_seq_len)
```

**单流块 `proj_out` 权重加载 hack**：单流块的 `proj_out` 接受 `[attn_output; mlp_hidden]` 拼接（in_features = 3072 + 12288），是一段"wide"矩阵。`RowParallelLinear` 默认按连续列切片加载，但这里 attn 与 mlp 两段在 checkpoint 中是非连续列范围，默认切片会错。`_patch_proj_out_weight_loader` 覆盖 `weight_loader`，从 checkpoint 的非连续列范围正确取出每个 rank 的 attn 列与 mlp 列再拼接：

```python title="runtime/models/dits/longcat_image.py"
def _loader(param, loaded_weight):
    input_dim = getattr(param, "input_dim", None)
    if input_dim is not None:
        a = inner_dim // tp_size          # attn 段每 rank 列数
        m = mlp_dim // tp_size             # mlp 段每 rank 列数
        attn_cols = loaded_weight.narrow(input_dim, tp_rank * a, a)
        mlp_cols  = loaded_weight.narrow(input_dim, inner_dim + tp_rank * m, m)
        param.data.copy_(torch.cat([attn_cols, mlp_cols], dim=input_dim))
    else:
        param.data.copy_(loaded_weight)
```

**RoPE 实时计算**：DiT `forward` 中直接调用 `self.pos_embed(torch.cat((txt_ids, img_ids), dim=0))` 计算 `image_rotary_emb`，对齐 diffusers transformer 的行为。这意味着 RoPE 不需要在预处理阶段单独算一次并缓存——每次 forward 都从 `txt_ids + img_ids` 重新算，但由于 `pos_embed` 内部用 float64 精度且 `ids` 在 50 步去噪中不变，计算开销可忽略。

### Hybrid Pipeline：标准 Stage + 模型特定 Stage

```text title="LongCatImagePipeline.create_pipeline_stages"
LongCatPromptRewriteStage        ← 模型特定（prompt 改写 + CPU generator）
         ↓
TextEncodingStage                 ← 框架标准（tokenize_prompt + postprocess_text hooks）
         ↓
LatentPreparationStage           ← 框架标准（latent 形状 + packing，经 PipelineConfig hooks 定制）
         ↓
TimestepPreparationStage          ← 框架标准（FlowMatch sigma 调度 + mu）
         ↓
DenoisingStage                    ← 框架标准（去噪循环，注入 txt_ids/img_ids）
         ↓
DecodingStage                     ← 框架标准（VAE 解码）
```

只有第一个 Stage（`LongCatPromptRewriteStage`）是模型特定的，Stage 2-6 全部复用框架标准实现。`LongCatImagePipeline` 继承 `LoRAPipeline` + `ComposedPipelineBase`，通过 `add_standard_*_stage()` 方法组装标准 Stage：

```python title="runtime/pipelines/longcat_image.py"
class LongCatImagePipeline(LoRAPipeline, ComposedPipelineBase):
    _required_config_modules = ["tokenizer", "text_processor", "vae",
                                "transformer", "scheduler"]

    def create_pipeline_stages(self, server_args):
        rewrite_stage = LongCatPromptRewriteStage(
            tokenizer=self.get_module("tokenizer"),
            text_processor=self.get_module("text_processor"),
            model_path=self.model_path,
            text_encoder_dtype=PRECISION_TO_TYPE[
                server_args.pipeline_config.text_encoder_precisions[0]],
        )
        self.add_stage(rewrite_stage)
        self.add_module("text_encoder", rewrite_stage.text_encoder)
        self.add_standard_text_encoding_stage()
        self.add_standard_latent_preparation_stage()
        self.add_standard_timestep_preparation_stage(
            prepare_extra_kwargs=[_prepare_mu])
        self.add_standard_denoising_stage()
        self.add_standard_decoding_stage()
```

`_required_config_modules` 中 **`text_encoder` 不在列表**——编码器由 `LongCatPromptRewriteStage` 在 Stage 内加载并通过 `add_module("text_encoder", ...)` 注册，标准 `TextEncodingStage` 直接复用同一实例。

### PipelineConfig：把模型特定逻辑注入标准 Stage

`configs/pipeline_configs/longcat_image.py` 是适配方案的配置核心，通过实现各个 hook 把 LongCat 特有逻辑注入框架标准 Stage。

**Packed Latents**（pack 把序列长度压 4 倍）：

```python title="configs/pipeline_configs/longcat_image.py"
def _pack_latents(latents, batch_size, num_channels_latents, height, width):
    latents = latents.view(batch_size, num_channels_latents, height//2, 2, width//2, 2)
    latents = latents.permute(0, 2, 4, 1, 3, 5)
    return latents.reshape(batch_size, (height//2)*(width//2), num_channels_latents*4)

def _unpack_latents(latents, height, width, vae_scale_factor):
    batch_size, num_patches, channels = latents.shape
    h = 2 * (int(height) // (vae_scale_factor * 2))
    w = 2 * (int(width) // (vae_scale_factor * 2))
    latents = latents.view(batch_size, h//2, w//2, channels//4, 2, 2)
    latents = latents.permute(0, 3, 1, 4, 2, 5)
    return latents.reshape(batch_size, channels // (2*2), h, w)
```

**图像位置 ID**：`img_ids` 起始坐标设为 `(TOKENIZER_MAX_LENGTH, TOKENIZER_MAX_LENGTH)`（即 `(512, 512)`），与文本 `txt_ids` 的 `[0, 511]` 区间不重叠，让 3D RoPE 正确区分文本与图像 token。

```python title="configs/pipeline_configs/longcat_image.py"
def maybe_prepare_latent_ids(self, latents):
    _, _, h, w = latents.shape
    return _prepare_pos_ids(
        modality_id=1,                                       # 1 = 图像
        token_type="image",
        start=(TOKENIZER_MAX_LENGTH, TOKENIZER_MAX_LENGTH),  # (512, 512) 避开文本位置
        height=h // 2, width=w // 2,                         # pack 后空间尺寸
    )
```

**动态 mu**：高分辨率图像噪声分布更复杂，`_calculate_shift` 用线性插值给出更大的 `mu`，使 timestep 分布向低 sigma 偏移。

```python title="configs/pipeline_configs/longcat_image.py"
def _calculate_shift(image_seq_len, base_seq_len=256, max_seq_len=4096,
                     base_shift=0.5, max_shift=1.15):
    m = (max_shift - base_shift) / (max_seq_len - base_seq_len)
    b = base_shift - m * base_seq_len
    return image_seq_len * m + b                             # 线性插值
```

`_prepare_mu` 在 pipeline 文件中定义，作为 `prepare_extra_kwargs` 传入 `TimestepPreparationStage`：

```python title="runtime/pipelines/longcat_image.py"
def _prepare_mu(batch, server_args):
    image_seq_len = batch.latents.shape[1]
    mu = _calculate_shift(image_seq_len)
    return "mu", mu
```

**CFG Renorm**：标准 CFG 在 `guidance_scale` 较大时会放大噪声预测范数，导致色彩过饱和。CFG Renorm 把合并后的范数约束到不超过条件预测范数（`scale ≤ 1.0`），只保留 CFG 的方向信息、不放大幅度。

```python title="configs/pipeline_configs/longcat_image.py"
def postprocess_cfg_noise(self, batch, noise_pred, noise_pred_cond):
    enable_cfg_renorm = getattr(batch, "enable_cfg_renorm", True)
    cfg_renorm_min = getattr(batch, "cfg_renorm_min", 0.0)
    if not enable_cfg_renorm:
        return noise_pred
    cond_norm = torch.norm(noise_pred_cond, dim=-1, keepdim=True)
    noise_norm = torch.norm(noise_pred, dim=-1, keepdim=True)
    scale = (cond_norm / (noise_norm + 1e-8)).clamp(min=cfg_renorm_min, max=1.0)
    return noise_pred * scale
```

**frames 维度兼容**：`DecodingStage` 通用接口假设输入是 5D（含 frames 维度，给视频模型用）。图像模型在 `post_denoising_loop` 补一个 `num_frames=1` 维度，再在 `preprocess_decoding` 去掉，避免改 `DecodingStage` 本身。

### LongCatPromptRewriteStage：Prompt 改写与请求级初始化

`pipelines_core/stages/model_specific_stages/longcat_image.py` 是接入方案的执行核心。它是整个 pipeline 中唯一模型特定的 Stage。

**Prompt Rewrite = 在 SGLang 内复用 Qwen2.5-VL 做 `.generate()`**：用 `text_processor.apply_chat_template` 构造改写请求（中英双语 few-shot system prompt，直接从 diffusers 移植），然后直接在 `self.text_encoder` 上调用 HF 原生 `.generate()`：

![Prompt Rewrite 改动前/后对比](/vibe-reading/images/articles/sglang-pr-23274-support-longcat-image/prompt-rewrite-comparison.svg)

上图对比了旧版 PR 与新版 PR 的 prompt rewrite 方案。旧版用手动 `_greedy_generate()` + `DynamicCache` + `set_forward_context(attn_metadata=None)` 绕过 SGLang 后端，还需修复三处共享 bug（GQA repeat / attn_mask 透传 / position_ids 广播）。新版改用 HF 原生 `.generate()` API，由 `generation_config.json` 提供 sampling 参数，KV cache 完全由 HF 内部管理，消除了所有 bug 修复需求。

```python title="pipelines_core/.../longcat_image.py"
@torch.no_grad()
def _rewire_prompt(self, prompt, device):
    all_text = []
    for each_prompt in prompt:
        language = _get_prompt_language(each_prompt)
        if language == "zh":
            question = SYSTEM_PROMPT_ZH + f"\n用户输入为：{each_prompt}\n改写后的prompt为："
        else:
            question = SYSTEM_PROMPT_EN + f"\nUser Input: {each_prompt}\nRewritten prompt:"
        message = [{"role": "user", "content": [{"type": "text", "text": question}]}]
        text = self.text_processor.apply_chat_template(
            message, tokenize=False, add_generation_prompt=True)
        all_text.append(text)

    inputs = self.text_processor(text=all_text, padding=True, return_tensors="pt").to(device)
    with set_forward_context(current_timestep=0, attn_metadata=None):
        generated_ids = self.text_encoder.generate(**inputs, max_new_tokens=REWRITE_MAX_NEW_TOKENS)
    prompt_len = inputs["input_ids"].shape[1]
    generated_ids_trimmed = generated_ids[:, prompt_len:]
    return self.text_processor.batch_decode(generated_ids_trimmed, skip_special_tokens=True)
```

关键设计：只传 `max_new_tokens=512`，**不强制 `do_sample` / `num_beams`**——让 `.generate()` 使用 checkpoint 的 `generation_config.json`（`top_k=1, top_p=0.001, temperature=0.1, repetition_penalty=1.05`），等价于贪心解码但保留参考实现行为。`set_forward_context(attn_metadata=None)` 仍然用于确保 HF generate 内部的前向走 `F.scaled_dot_product_attention` 而非 SGLang PagedAttention 后端。

**ComponentUse 常驻管理**：Stage 通过 `component_uses()` 声明 `text_encoder` 的 `ComponentUse`，框架的 residency manager 负责在 rewrite→encode 之间保持编码器常驻、在最后一次使用后自动 offload（`memory_intensive=True` 触发 `torch.cuda.empty_cache()`）。替代了旧版手动 `self.text_encoder.to("cpu")`。

```python title="pipelines_core/.../longcat_image.py"
def component_uses(self, server_args, stage_name=None):
    return [
        ComponentUse(stage_name, "text_encoder",
                     target_dtype=self.text_encoder_dtype, memory_intensive=True),
    ]
```

**CPU generator**：`forward` 末尾始终设置 `batch.generator = torch.Generator(device="cpu").manual_seed(batch.seed)`，因为 diffusers 的 `randn_tensor` 在 CPU 上生成再搬移到 device，CPU 和 CUDA 生成器对同一 seed 产生不同噪声——设置 CPU generator 保证 seed 可复现。

### TextEncodingStage：标准文本编码 + 模型特定 hooks

文本编码由框架标准 `TextEncodingStage` 完成，通过两个 `PipelineConfig` hook 注入模型特定逻辑：

**`tokenize_prompt`**：quote-aware tokenization + 固定 prefix/suffix 包裹。引号内文字逐字符 tokenize（避免 BPE 合并），body 截断/pad 到 512 token，再拼接固定 system prefix 和 assistant suffix：

```python title="configs/pipeline_configs/longcat_image.py"
def tokenize_prompt(self, prompt, tokenizer, tok_kwargs):
    self._ensure_encode_prefix_suffix(tokenizer)
    body = _tokenize_prompt_for_encode(prompt, tokenizer)
    prefix_ids_t = torch.tensor(self._encode_prefix_ids, ...).unsqueeze(0).expand(batch_size, -1)
    suffix_ids_t = torch.tensor(self._encode_suffix_ids, ...).unsqueeze(0).expand(batch_size, -1)
    input_ids = torch.cat((prefix_ids_t, body.input_ids, suffix_ids_t), dim=-1)
    attention_mask = torch.cat((prefix_mask_t, body.attention_mask, suffix_mask_t), dim=-1)
    return BatchEncoding(data={"input_ids": input_ids, "attention_mask": attention_mask})
```

**`longcat_postprocess_text`**：编码后切片 `hidden_states[-1][:, prefix_len:-suffix_len, :]` 去掉模板部分，得 `[B, 512, 3584]`，返回 `TextConditioningOutput`。

### 其余改动

- **`component_loader.py`**：`AutoProcessorLoader.component_names` 加入 `"text_processor"`，让框架加载器能从 `model_index.json` 找到并加载 `Qwen2VLProcessor`（prompt rewrite 用）。
- **`sampling_params.py`**：把 `enable_cfg_renorm` / `cfg_renorm_min` / `enable_prompt_rewrite` 加到**基类** `SamplingParams`（默认 `False`）+ CLI 参数（`--enable-cfg-renorm` / `--cfg-renorm-min` / `--enable-prompt-rewrite`），因为 `postprocess_cfg_noise` 和 `LongCatPromptRewriteStage` 通过 `getattr(batch, ...)` 访问。子类 `LongCatImageSamplingParams` 覆盖为 `True`，默认 `guidance_scale=4.5`、`height=1024`、`width=1024`、`steps=50`。
- **`registry.py`**：注册 `meituan-longcat/LongCat-Image`，detector 用 `"longcat" in hf_id.lower() and "edit" not in hf_id.lower()`——`"edit" not in` 排除未来的 LongCat-Image-Edit。
- **`configs/models/dits/longcat_image.py`**：`LongCatImageArchConfig` + `LongCatImageDitConfig` 数据类，声明模型架构参数。
- **`configs/models/vaes/longcat_image.py`**：`LongCatImageVAEArchConfig` + `LongCatImageVAEConfig`，`spatial_compression_ratio=8`、`vae_scale_factor=8`。
- **`configs/sample/longcat_image.py`**：`LongCatImageSamplingParams`，默认开启 cfg_renorm 和 prompt_rewrite。

### 完整数据流

```
sglang generate --model-path meituan-longcat/LongCat-Image --prompt "..."
  │
  ├─ DiffGenerator → Req(sampling_params=LongCatImageSamplingParams)
  │
  ├─ LongCatPromptRewriteStage.forward()
  │    ├─ 可选：_rewire_prompt()  ← Qwen2.5-VL .generate()（max 512 tokens）
  │    └─ 写入 batch: generator(CPU), enable_cfg_renorm
  │
  ├─ TextEncodingStage.forward()
  │    ├─ tokenize_prompt()       ← quote-aware + prefix/suffix
  │    ├─ Qwen2.5-VL 前向，取最后一层 hidden states
  │    └─ longcat_postprocess_text() → batch.prompt_embeds [B,512,3584]
  │
  ├─ LatentPreparationStage.forward()
  │    ├─ randn([B,16,H_lat,W_lat], generator=cpu_generator).to(bf16)
  │    ├─ maybe_pack_latents() → [B, S, 64]
  │    └─ maybe_prepare_latent_ids() → batch.latent_ids (img_ids)
  │
  ├─ TimestepPreparationStage.forward()
  │    ├─ mu = _calculate_shift(S)   ← 高分辨率 mu 更大
  │    └─ scheduler.set_timesteps(sigmas, mu=mu)
  │
  ├─ DenoisingStage（循环 50 步）
  │    ├─ 每步：prepare_pos_cond_kwargs → txt_ids + img_ids
  │    ├─ DiT forward: pos_embed(cat(txt_ids, img_ids)) → RoPE 实时计算
  │    ├─ CFG：noise_pred = null_pred + scale * (cond_pred - null_pred)
  │    └─ CFG Renorm：约束 noise_pred 范数 ≤ cond_pred 范数
  │
  ├─ post_denoising_loop: _unpack_latents + unsqueeze(2) → [B,16,1,H,W]
  │
  └─ DecodingStage
       ├─ preprocess_decoding: squeeze(2) → [B,16,H,W]
       ├─ latents = latents / scaling_factor + shift_factor
       └─ vae.decode(latents) → 图像 [B, 3, H, W]
```

---

## 测试

PR checklist 中 `[ ] Add unit tests` 未勾选，合并时仍未补单测（10 个改动文件无测试文件）。作者在 PR body 中给出了一条 CLI 示例（768×1344、50 步、`guidance-scale=4.0`、`seed=43`），并附了一张生成样图用于人工目视验证，但 `Accuracy Tests` 与 `Speed Tests and Profiling` 两节均留空。

### 回归验证方式

由于无自动化测试，正确性目前靠**与 diffusers 参考实现 1:1 对齐**保证：

- 算法逻辑（pack/unpack、`_calculate_shift`、CFG renorm、quotation tokenize、system prompt）逐行从 diffusers 移植；
- 权重键名与 diffusers checkpoint 对齐（FFN `net.0.proj` / `net.1` / `net.2`、单流块 `proj_out` 列范围），保证权重无损加载；
- Timestep 处理对齐：SGLang `DenoisingStage` 直接传原始 scheduler timestep（`[0,1000]`），DiT 内部不再缩放，等效于 diffusers 的 `pipeline 传 t/1000` + `transformer 内 ×1000`。

---

## Review

PR 经 mickqian 审阅、BBuf 批准合并，交流集中在两点：

- **复用标准 Stage 的程度**：mickqian 建议尽量适配已有 Stage 以获得最优性能。作者回应——pipeline 已最大化复用标准 Stage（文本编码、latent 准备、timestep/mu、去噪、解码），只保留 `LongCatPromptRewriteStage`，因为它跑的是自回归 `.generate()` prompt 改写，没有标准 Stage 覆盖这一步。
- **系统 prompt 的归属**：初版把中英双语 system prompt 放在单独的 `longcat_image_system_messages.py`，mickqian 建议挪到 `configs/models/sample/longcat_image.py`。作者最终把它**合并进 `model_specific_stages/longcat_image.py`**——让 prompt 常量紧邻唯一消费者 `_rewire_prompt`，与 Qwen-Image-Layered 的约定一致。最终 10 个改动文件里不再有 `system_messages.py`。

BBuf 最终 approve 合并。

---

## 问题

### 为什么 RoPE 不用 flashinfer？

`axes_dims_rope=[16,56,56]` 之和 = 128 = `head_dim`，是**全维度旋转**。flashinfer 的 `cos_sin_cache` 格式要求 `rotary_dim ≤ head_dim`，全维度旋转不兼容；diffusers 的 `apply_rotary_emb` 直接处理 `sequence_dim=1` 的全维度旋转，数值与参考实现一致。

### 为什么 RoPE 在 DiT forward 中实时计算而非预处理？

新版 PR 直接在 DiT `forward` 中调用 `self.pos_embed(cat(txt_ids, img_ids))` 计算 `image_rotary_emb`，对齐 diffusers transformer 的行为。`txt_ids` 和 `img_ids` 在 50 步去噪中不变，但 `pos_embed` 内部用 float64 精度计算频率，单次开销可忽略。这种设计简化了 pipeline（不需要额外的 RoPE 预计算 Stage），且与参考实现行为一致。

### 为什么 `set_forward_context(attn_metadata=None)`？

SGLang 的 `LocalAttention` 有两条路径：`attn_metadata is not None` 走 SGLang 自定义后端（PagedAttention 等，不支持标准 KV cache 对象）；否则走 `F.scaled_dot_product_attention`。prompt rewrite 通过 HF `.generate()` 调用，HF 内部管理 KV cache，传 `attn_metadata=None` 确保走 SDPA 路径。

### 为什么 `text_encoder` 不在 `_required_config_modules`？

`LongCatPromptRewriteStage` 在 Stage 内通过 `Qwen2_5_VLForConditionalGeneration.from_pretrained()` 直接加载 HF 编码器，然后通过 `add_module("text_encoder", rewrite_stage.text_encoder)` 注册。标准 `TextEncodingStage` 从 pipeline 取 `text_encoder` 模块——两条路径共享同一实例，无需框架的 `TextEncoderLoader`。

### Timestep 为什么不缩放？

SGLang `DenoisingStage` 直接把 scheduler 原始 timestep（`[0,1000]`）传给 DiT，省去 diffusers 的"pipeline 除 1000、transformer 内乘回 1000"往返。`Timesteps`（sinusoidal embedding）输入必须是 `[0,1000]` 量级才能产生正确高频嵌入，误传 `[0,1]` 会让模型无法区分 timestep、输出纯噪声。

---

## 意义与影响

本 PR 把 LongCat-Image 接入 SGLang `multimodal_gen`，使该模型获得 **TP 多卡推理**（全层 `ColumnParallelLinear`/`RowParallelLinear` + `USPAttention` FA3/FA4）与统一 API（`DiffGenerator` Python API / `sglang generate` CLI / HTTP Server）。

更重要的是它**验证了组合式 pipeline 框架的扩展性**：仅靠一个 `PipelineConfig` + 一个模型特定 Stage（`LongCatPromptRewriteStage`），就接入了带 VLM prompt rewrite 的复杂 T2I 模型，标准文本编码/去噪/解码 Stage 全程复用。新版 PR 相比旧版简化了 prompt rewrite 实现——从手动 `_greedy_generate` + `DynamicCache` 改为 HF 原生 `.generate()` API，消除了三处共享 bug 修复的需求，同时通过 `ComponentUse` 让框架的 residency manager 接管编码器 offload。

### 与 diffusers 的关键差异

| 方面 | diffusers | SGLang |
|------|-----------|--------|
| 多 GPU（TP） | 不支持 | 全层 `ColumnParallelLinear`/`RowParallelLinear` |
| Timestep 传递 | `transformer(t=scheduler_t/1000)`，DiT 内 `×1000` | 直接传原始 scheduler t，DiT 不缩放 |
| RoPE 计算 | 每次 DiT forward 计算 | 每次 DiT forward 计算（对齐 diffusers） |
| Prompt Rewrite | 支持，VLM 改写 | 支持，复用 SGLang 内 Qwen2.5-VL `.generate()` |
| 编码器 offload | 手动 | ComponentUse + residency manager |

> **后续**：PR [#35995](https://github.com/sgl-project/sglang/pull/35995) 把 LongCat-Image 的 QKNorm 与全宽交错 RoPE 融合进 JIT 核（端到端加速 17%、输出逐字节一致），当时被迫走 diffusers 的 RoPE 路径由此收口，详见[融合 LongCat-Image 的 QKNorm 与全宽交错 RoPE](/vibe-reading/articles/sglang-pr-35995-fuse-longcat-qknorm-rope)。

---

## TODO

- [ ] 补单元测试（PR checklist 未勾选）。
- [ ] 与 diffusers 参考输出做同 seed 像素级对比，确认数值一致。
- [ ] 扩展支持多 prompt 并行（当前 batch_size 固定为 1）。
- [ ] 接入 LongCat-Image-Edit（图像编辑 pipeline，需额外处理 image VAE 编码）。

> **后续**：[PR #35829](https://github.com/sgl-project/sglang/pull/35829) 实现了 LongCat-Image-Edit 图像编辑（I2I）pipeline——条件图双路径（VL 联合编码 + VAE 参考隐空间拼接 `[noisy|reference]`）+ RoPE 双模态 id，顺带修复了 conditioning 批次展开、分组驻留管理器、mask 作用域三处框架缺陷。详见 [LongCat-Image-Edit 接入 SGLang：图像编辑（I2I）的隐空间拼接与联合 VL 编码](/vibe-reading/articles/AI/Infra/Inference/SGLang/PRs/sglang-pr-35829-longcat-image-edit)。

---

## 参考

- [LongCat-Image HuggingFace](https://huggingface.co/meituan-longcat/LongCat-Image)
- [LongCat-Image GitHub](https://github.com/meituan-longcat/LongCat-Image)
- [diffusers `transformer_longcat_image.py`](https://github.com/huggingface/diffusers/blob/main/src/diffusers/models/transformers/transformer_longcat_image.py)
- Flux MMDiT 架构（`axes_dims_rope`、packed latents 的同族设计）

---

## 相关阅读

- [LongCat-Image Technical Report](/vibe-reading/articles/longcat-image-technical-report) — **设计来源**·本 PR 落地的模型原论文（MM-DiT 混合架构 + 三阶段数据精炼 + 多奖励 RLHF）
- [在 SGLang 中接入 LongCat-AudioDiT](/vibe-reading/articles/sglang-pr-22191-support-longcat-audiodit) — **同设计落地线**·同系列接入 `multimodal_gen` 的文生音频分支，用框架 hooks 把耦合 ODE 纳入标准三段式，与本篇 Diffusers 多组件路径对照
- [xLLM PR #849：LongCat-Image CUDA 支持](/vibe-reading/articles/xllm-pr-849-longcat-image-cuda) — **同模型另一框架**·LongCat-Image T2I 在 xLLM 的 CUDA 适配
- [xLLM PR #957：LongCat-Image-Edit CUDA 支持](/vibe-reading/articles/xllm-pr-957-longcat-image-edit-cuda) — **同模型 Edit 分支**·LongCat-Image-Edit 在 xLLM 的 CUDA 适配
