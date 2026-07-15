---
title: "在 SGLang 中接入 LongCat-Image：一个文生图 DiT 模型的全栈适配"
source:
  project: "SGLang"
  type: "PR"
  id: "23274"
  url: "https://github.com/sgl-project/sglang/pull/23274"
  prType: "feat"
date: "2026-07-14"
category: [AI, 推理, SGLang, Contributions]
tags: ["Diffusion", "DiT", "SGLang", "Tensor Parallelism", "Qwen2.5-VL", "LongCat-Image"]
description: "解读 PR #23274：如何在 SGLang multimodal_gen 框架中接入 LongCat-Image 文生图模型，涵盖 MMDiT 并行化、Qwen2.5-VL 自回归改写、3D RoPE 与三处共享 bug 修复。"
readingTime: "22 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#23274](https://github.com/sgl-project/sglang/pull/23274) · **Issue** - · **commit** - · **首发版本** - · **变更行数** +1752 / -11 行（14 文件）· **合并时间** 2026-04-20（创建，截至写作时仍处 Open 状态）

---

## 背景

LongCat-Image 是美团 LongCat 团队的文生图模型，基于 **Flow Matching + MMDiT** 架构（Flux 同族），使用 **Qwen2.5-VL（7B）** 作为文本编码器。它的一个显著特点是用 Qwen2.5-VL 对输入 prompt 进行 **VLM 改写（Prompt Rewrite）**——把用户的简短描述自回归扩写成细节丰富的长文本，再送入 DiT 去噪，从而提升生成质量。

SGLang 的 `multimodal_gen` 子系统已经接入了 Wan、Hunyuan、ZImage、Flux、Qwen-Image 等多个扩散模型，形成了一套"标准 Stage + 模型特定 `PipelineConfig` hooks"的组合式 pipeline 框架。本 PR 的目标，是把 LongCat-Image 也接入这套框架，复用已有的标准去噪 / 解码 Stage，同时支持 Tensor Parallelism（TP）多卡推理与 TeaCache 加速。

接入过程中暴露了三个**与 LongCat 无关、但被本次接入首次触发**的共享 bug：`LocalAttention` 不支持 GQA、Qwen2.5-VL 的 attn_mask 不透传、3D position_ids 广播形状错误。这些 bug 在此前纯文本编码路径下不会出现，只有在 prompt rewrite 的自回归解码路径下才会显形，本 PR 一并修复。

---

## 前置知识

### SGLang multimodal_gen 的组合式 Pipeline

`multimodal_gen` 把一次生成拆成一串 `PipelineStage`，由 `ComposedPipelineBase` 顺序执行。框架提供一批**标准 Stage**（`LatentPreparationStage` / `TimestepPreparationStage` / `DenoisingStage` / `DecodingStage`），它们的行为通过一个模型特定的 `PipelineConfig` 的若干 hook 方法注入。模型只需实现自己的 `PipelineConfig`（描述 latent 形状、pack/unpack、sigma 调度、CFG 后处理等）和必要的**模型特定 Stage**（如文本编码），就能拼出完整 pipeline，无需改框架代码。

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

即直接对齐 diffusers 的 `LongCatImageTransformer2DModel` 与 `LongCatImagePipeline` 参考实现，保证数值一致；所有算法逻辑（pack/unpack、`_calculate_shift`、CFG renorm、quotation-aware tokenize、bilingual system prompt）都从 diffusers 1:1 移植。SGLang 侧的工作不是重新设计算法，而是**把这套算法映射到 TP 并行 + 组合式 Stage 框架**，并修掉框架在自回归解码路径下的若干缺口。

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

DiT 主体结构：

```
输入 packed latents [B, S, 64]    S = (H/16) * (W/16)，64 = 16通道 × 2×2 packing
  │
  ├─ x_embedder:        ColumnParallelLinear(64 → 3072)
  ├─ time_embed:        Timesteps(256) → TimestepEmbedding → 3072
  ├─ context_embedder:  ColumnParallelLinear(3584 → 3072)
  │
  ├─ 19 × _TransformerBlock（双流）
  │    AdaLayerNormZero → _LongCatJointAttention(img+txt) → _LongCatFFN
  │
  ├─ 38 × _SingleTransformerBlock（单流，img+txt 拼接）
  │    AdaLayerNormZeroSingle → _LongCatSingleAttention → proj_mlp + proj_out
  │
  └─ norm_out + proj_out: ColumnParallelLinear(3072 → 64)
     输出 [B, S, 64]（packed latents 的速度场预测）
```

关键超参：`num_attention_heads=24`、`attention_head_dim=128`、`hidden_size=3072`、`joint_attention_dim=3584`（Qwen2.5-VL hidden size）、`axes_dims_rope=[16,56,56]`。

### Hybrid Pipeline：标准 Stage + 模型特定 Stage

```text title="LongCatImagePipeline.create_pipeline_stages"
LongCatImageBeforeDenoisingStage   ← 模型特定（文本编码 + Prompt Rewrite）
         ↓
LatentPreparationStage             ← 框架标准（latent 形状 + packing，经 PipelineConfig hooks 定制）
         ↓
LongCatImageRoPEStage              ← 模型特定（RoPE 预计算，必须在 latent stage 之后）
         ↓
TimestepPreparationStage           ← 框架标准（FlowMatch sigma 调度，注入 mu）
         ↓
DenoisingStage                     ← 框架标准（去噪循环，注入 txt_ids/img_ids）
         ↓
DecodingStage                      ← 框架标准（VAE 解码）
```

Stage 3、4 必须排在 Stage 2 之后：`_prepare_mu` 需要 `batch.latents.shape[1]`（packed 后 token 数），`LongCatImageRoPEStage` 需要 `batch.latent_ids`（由 Stage 2 的 `maybe_prepare_latent_ids` 写入），二者都依赖 Stage 2 产物。

### PipelineConfig：把模型特定逻辑注入标准 Stage

`configs/pipeline_configs/longcat_image.py` 是适配方案的配置核心，通过实现各个 hook 把 LongCat 特有逻辑注入框架标准 Stage。

**Packed Latents**（pack 把序列长度压 4 倍）：

```python title="configs/pipeline_configs/longcat_image.py"
def _pack_latents(latents, batch_size, num_channels_latents, height, width):
    latents = latents.view(batch_size, num_channels_latents, height//2, 2, width//2, 2)
    latents = latents.permute(0, 2, 4, 1, 3, 5)   # 空间维度提前，通道+patch 放后
    return latents.reshape(batch_size, (height//2)*(width//2), num_channels_latents*4)

def _unpack_latents(latents, height, width, vae_scale_factor):
    h = 2 * (int(height) // (vae_scale_factor * 2))   # = height // 8
    w = 2 * (int(width) // (vae_scale_factor * 2))
    latents = latents.view(batch_size, h//2, w//2, 64//4, 2, 2)
    latents = latents.permute(0, 3, 1, 4, 2, 5)
    return latents.reshape(batch_size, 16, h, w)
```

**图像位置 ID**：`img_ids` 起始坐标设为 `(512, 512)`，与文本 `txt_ids` 的 `[0, 511]` 区间不重叠，让 3D RoPE 正确区分文本与图像 token。

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

**动态 mu**：高分辨率图像噪声分布更复杂，`_calculate_shift` 用线性插值给出更大的 `mu`，使 timestep 分布向低 sigma 偏移，等效于给高分辨率分配更多去噪步数。

```python title="configs/pipeline_configs/longcat_image.py"
def _calculate_shift(image_seq_len, base_seq_len=256, max_seq_len=4096,
                     base_shift=0.5, max_shift=1.15):
    m = (max_shift - base_shift) / (max_seq_len - base_seq_len)
    b = base_shift - m * base_seq_len
    return image_seq_len * m + b                             # 线性插值
```

**CFG Renorm**：标准 CFG 在 `guidance_scale` 较大时会放大噪声预测范数，导致色彩过饱和。CFG Renorm 把合并后的范数约束到不超过条件预测范数（`scale ≤ 1.0`），只保留 CFG 的方向信息、不放大幅度。

```python title="configs/pipeline_configs/longcat_image.py"
def postprocess_cfg_noise(self, batch, noise_pred, noise_pred_cond):
    if not getattr(batch, "enable_cfg_renorm", True):
        return noise_pred
    cond_norm = torch.norm(noise_pred_cond, dim=-1, keepdim=True)
    noise_norm = torch.norm(noise_pred, dim=-1, keepdim=True)
    scale = (cond_norm / (noise_norm + 1e-8)).clamp(
        min=getattr(batch, "cfg_renorm_min", 0.0), max=1.0)
    return noise_pred * scale
```

**frames 维度兼容**：`DecodingStage` 通用接口假设输入是 5D（含 frames 维度，给视频模型用）。图像模型在 `post_denoising_loop` 补一个 `num_frames=1` 维度，再在 `preprocess_decoding` 去掉，避免改 `DecodingStage` 本身。

### DiT 模型：TP 并行化与权重加载

`runtime/models/dits/longcat_image.py` 把 diffusers 的串行实现改写为全层 TP 并行。核心要点：

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

**TeaCache 接入**：`forward` 中通过 `_get_teacache_context()` 决定是否跳过整段 block 循环，命中时直接复用 `previous_residual`（CFG 正负分支独立缓存）。`runtime/cache/teacache.py` 把 `longcat_image` 加入 `_CFG_SUPPORTED_PREFIXES`，使其在开启 CFG 时仍支持分支分离缓存（与 ZImage 同族 MMDiT，策略适用）。

```python title="runtime/cache/teacache.py"
# Models that support CFG cache separation (wan/hunyuan/zimage/longcat_image)
_CFG_SUPPORTED_PREFIXES: set[str] = {"wan", "hunyuan", "zimage", "longcat_image"}
```

### BeforeDenoisingStage：Prompt Rewrite 与文本编码

`pipelines_core/stages/model_specific_stages/longcat_image.py` 是接入方案的执行核心。

**Prompt Rewrite = 在 SGLang 内复用 Qwen2.5-VL 做自回归解码**：用 `text_processor.apply_chat_template` 构造改写请求（中英双语 few-shot system prompt，直接从 diffusers 移植），然后直接在 `self.text_encoder`（带 `lm_head`）上跑贪心解码。关键是用 `DynamicCache` 做 KV cache 的 O(N) 解码：

```python title="pipelines_core/.../longcat_image.py"
@torch.no_grad()
def _greedy_generate(self, input_ids, attention_mask, max_new_tokens, device):
    from transformers import DynamicCache
    past_key_values = DynamicCache()
    # Prefill：一次处理完整 prompt
    cache_position = torch.arange(prompt_len, device=device)
    with set_forward_context(current_timestep=0, attn_metadata=None):
        outputs = self.text_encoder(input_ids=input_ids,
            attention_mask=attention_mask, past_key_values=past_key_values,
            use_cache=True, cache_position=cache_position, logits_to_keep=1)
    # Decode：每步一个 token，KV cache 累积
    for step in range(1, max_new_tokens):
        if (next_token.squeeze(-1) == eos_token_id).all(): break
        ...
        with set_forward_context(current_timestep=0, attn_metadata=None):
            outputs = self.text_encoder(input_ids=next_token, ...)
        next_token = outputs.logits[:, -1, :].argmax(dim=-1, keepdim=True)
```

**`set_forward_context(attn_metadata=None)` 是关键绕过手段**：SGLang 的 `LocalAttention` 有两条路径——`attn_metadata is not None` 时走 SGLang 自定义注意力后端（PagedAttention 等，不支持 KV cache 对象）；`attn_mask is not None` 或 `attn_metadata is None` 时走 `F.scaled_dot_product_attention`（支持标准 KV cache）。传 `attn_metadata=None` 强制走后者，让 `DynamicCache.update()` 的 KV cache 正常工作。`logits_to_keep=1` 只保留最后一个 token 的 logits，减少 GPU→CPU 传输。

**Quotation-aware tokenize**：`_split_quotation` 先保护词内撇号（如 `it's`），再按引号对分割，引号内文字**逐字符 tokenize**——避免 BPE 把组合词合并成不同 token，保证引号内文字 token 序列与引号外一致（对齐 diffusers 参考行为）。

**prefix/suffix chat template**：Qwen2.5-VL 是 chat 模型，纯文本前向时需用 chat template 包裹（`<|im_start|>system\nAs an image captioning expert...`）才能激活"文本描述专家"能力。取最后一层 hidden states（而非最后一个 token 的 logit），因为 DiT 需要对齐到 prompt 每个 token 做注意力。编码后切片 `[:, prefix_len:-suffix_len, :]` 去掉模板部分，得 `[B, 512, 3584]`。

**手动 CPU offload**：Qwen2.5-VL 没有 `_fsdp_shard_conditions`，框架的 `text_encoder_cpu_offload` 对它不生效，所以编码完成后在 stage 内手动 `self.text_encoder.to("cpu")` + `torch.cuda.empty_cache()`，为后续 DiT 让出显存。

### LongCatImageRoPEStage：RoPE 预计算

`transformer.pos_embed(ids)` 内部用 float64 精度算频率（`get_1d_rotary_pos_embed`），50 步去噪中 `ids` 不变，所以只在预处理阶段算一次，所有步骤共享同一个 `image_rotary_emb`，通过 `prepare_pos_cond_kwargs` 注入每步 forward。避免在每步 DiT forward 中重复调用 3 次 float64 三角函数计算。

### 三处共享 bug 修复

这三个 bug 都在 prompt rewrite 的自回归解码路径下首次触发。

**Bug 1：`LocalAttention` 不支持 GQA**（`runtime/layers/attention/layer.py`）。`attn_mask is not None` 路径走显式 transpose，若 k/v 的 `num_kv_heads < num_heads`，矩阵乘法维度不匹配会报错。Qwen2.5-VL 用 GQA（`num_heads=28, num_kv_heads=4`），`_greedy_generate` 的 `LocalAttention` 恰好走这条路径。修复：在 transpose 后用 `repeat_interleave` 把 k/v 扩展到 q 的头数。

```python title="runtime/layers/attention/layer.py"
if attn_mask is not None:
    q_ = q.transpose(1, 2)  # [B, num_heads, seq, head_dim]
    k_ = k.transpose(1, 2)  # [B, num_kv_heads, seq, head_dim]
    v_ = v.transpose(1, 2)
    # GQA: repeat k/v to match q's num_heads
    num_heads = q_.shape[1]
    num_kv_heads = k_.shape[1]
    if num_heads != num_kv_heads:
        n_rep = num_heads // num_kv_heads
        k_ = k_.repeat_interleave(n_rep, dim=1)
        v_ = v_.repeat_interleave(n_rep, dim=1)
```

**Bug 2：Qwen2.5-VL attn_mask 不透传**（`runtime/models/encoders/qwen2_5vl.py`）。`Qwen2_5_VLAttention` 原先没把 `attention_mask` 传给 `self.attn`，导致 `LocalAttention` 进入 `attn_metadata` 路径（被 SGLang 后端接管），而 `_greedy_generate` 已通过 `attn_metadata=None` 绕过后端、预期走 `attn_mask` 路径。不传 mask 导致无法建立因果掩码，生成无意义文本。同时补了 `_attn_implementation` 默认值——HuggingFace `create_causal_mask` 在其为 `None` 时返回 `None`（视为不需要 mask），强制设为 `"eager"` 确保生成标准三角掩码。

```python title="runtime/models/encoders/qwen2_5vl.py"
-attn_output = self.attn(query_states, key_states, value_states)
+attn_output = self.attn(
+    query_states, key_states, value_states, attn_mask=attention_mask
+)
...
+if not getattr(config, "_attn_implementation", None):
+    config._attn_implementation = "eager"
```

**Bug 3：3D position_ids 广播形状错误**（`runtime/models/encoders/qwen2_5vl.py`）。原代码 `delta.repeat_interleave(batch_size // delta.shape[0], dim=1)` 对 `dim=1`（seq 维）repeat，而意图是对 `dim=0`（batch 维）repeat；且 `position_ids` 形状是 `[3, B, seq_length]`（3D RoPE 三轴），原代码加一个 `[B, seq_length]` 的 `delta` 广播会失败。修复改为直接用广播构造正确的 `[3, B, seq_len]`，`delta` 形状 `[B, 1]` 自动广播到所有 seq 位置。

```python title="runtime/models/encoders/qwen2_5vl.py"
-delta = torch.zeros((batch_size, seq_length), device=inputs_embeds.device)
-delta = delta.repeat_interleave(batch_size // delta.shape[0], dim=1)
-position_ids += delta.to(position_ids.device)
+delta = torch.zeros(batch_size, 1, device=inputs_embeds.device)
+position_ids = (
+    (torch.arange(seq_length, device=inputs_embeds.device) + delta)
+    .unsqueeze(0)
+    .expand(3, -1, -1)
+)
```

### 其余改动

- **`component_loader.py`**：`AutoProcessorLoader.component_names` 加入 `"text_processor"`，让框架加载器能从 `model_index.json` 找到并加载 `Qwen2VLProcessor`（prompt rewrite 用）。
- **`sampling_params.py`**：把 `enable_cfg_renorm` / `cfg_renorm_min` / `enable_prompt_rewrite` 加到**基类** `SamplingParams`（默认 `False`）而非仅子类，因为 `postprocess_cfg_noise` 和 `BeforeDenoisingStage` 通过 `getattr(batch, ...)` 访问、不依赖具体子类类型。子类 `LongCatImageSamplingParams` 覆盖为 `True`。
- **`registry.py`**：注册 `meituan-longcat/LongCat-Image`，detector 用 `"longcat" in hf_id.lower() and "edit" not in hf_id.lower()`——`"edit" not in` 排除未来的 LongCat-Image-Edit，避免误匹配。

### 完整数据流

```
sglang generate --model-path meituan-longcat/LongCat-Image --prompt "..."
  │
  ├─ DiffGenerator → Req(sampling_params=LongCatImageSamplingParams)
  │
  ├─ LongCatImageBeforeDenoisingStage.forward()
  │    ├─ 可选：_rewire_prompt()  ← Qwen2.5-VL 自回归改写（最多 512 tokens）
  │    ├─ _encode_prompt()        ← Qwen2.5-VL 前向，取最后一层 hidden states [B,512,3584]
  │    └─ 写入 batch: prompt_embeds, txt_ids, generator, enable_cfg_renorm
  │
  ├─ LatentPreparationStage.forward()
  │    ├─ randn([B,16,H_lat,W_lat], generator=cpu_generator).to(bf16)
  │    ├─ _pack_latents() → [B, S, 64]
  │    └─ maybe_prepare_latent_ids() → batch.latent_ids (img_ids 雏形)
  │
  ├─ LongCatImageRoPEStage.forward()
  │    └─ batch.image_rotary_emb = transformer.pos_embed(cat(txt_ids, img_ids))  ← 仅算一次
  │
  ├─ TimestepPreparationStage.forward()
  │    ├─ mu = _calculate_shift(S)   ← 高分辨率 mu 更大
  │    └─ scheduler.set_timesteps(sigmas=np.linspace(1, 1/steps, steps), mu=mu)
  │
  ├─ DenoisingStage（循环 50 步）
  │    ├─ 每步：transformer(latents, txt_ids, img_ids, image_rotary_emb, timestep)
  │    ├─ CFG：noise_pred = null_pred + scale * (cond_pred - null_pred)
  │    └─ CFG Renorm：约束 noise_pred 范数 ≤ cond_pred 范数
  │
  ├─ _unpack_latents() → [B, 16, H_lat, W_lat]
  │
  └─ DecodingStage
       ├─ latents = latents / scaling_factor + shift_factor
       └─ vae.decode(latents) → 图像 [B, 3, H, W]
```

---

## 测试

PR 在 checklist 中标注了 `[ ] Add unit tests`（未勾选），截至写作时尚未补单测。作者在 PR body 中给出了一条 CLI 示例（768×1344、50 步、`guidance-scale=4.0`、`seed=43`），并附了一张生成样图用于人工目视验证，但 `Accuracy Tests` 与 `Speed Tests and Profiling` 两节均留空。

### 回归验证方式

由于无自动化测试，正确性目前靠**与 diffusers 参考实现 1:1 对齐**保证：

- 算法逻辑（pack/unpack、`_calculate_shift`、CFG renorm、quotation tokenize、system prompt）逐行从 diffusers 移植；
- 权重键名与 diffusers checkpoint 对齐（FFN `net.0.proj` / `net.1` / `net.2`、单流块 `proj_out` 列范围），保证权重无损加载；
- Timestep 处理对齐：SGLang `DenoisingStage` 直接传原始 scheduler timestep（`[0,1000]`），DiT 内部不再缩放，等效于 diffusers 的 `pipeline 传 t/1000` + `transformer 内 ×1000`。

---

## 问题

### 为什么 RoPE 不用 flashinfer？

`axes_dims_rope=[16,56,56]` 之和 = 128 = `head_dim`，是**全维度旋转**。flashinfer 的 `cos_sin_cache` 格式要求 `rotary_dim ≤ head_dim`，全维度旋转不兼容；diffusers 的 `apply_rotary_emb` 直接处理 `sequence_dim=1` 的全维度旋转，数值与参考实现一致。

### 为什么 `set_forward_context(attn_metadata=None)`？

SGLang 的 `LocalAttention` 有两条路径：`attn_metadata is not None` 走 SGLang 自定义后端（不支持 KV cache 对象）；否则走 `F.scaled_dot_product_attention`（支持标准 KV cache）。prompt rewrite 需要标准 `DynamicCache`，所以必须传 `attn_metadata=None` 强制走后者。

### 为什么三个共享 bug 此前没被发现？

它们都只在**自回归解码路径**下触发，而此前的文本编码器都只做单次前向（`use_cache=False`、走 `attn_metadata` 路径、无 GQA repeat 需求）。LongCat-Image 是首个在 SGLang 内复用 Qwen2.5-VL 做 prompt rewrite 自回归解码的模型，`_greedy_generate` 走 `attn_mask` 路径 + KV cache，才把这三个缺口同时暴露。

### Timestep 为什么不缩放？

SGLang `DenoisingStage` 直接把 scheduler 原始 timestep（`[0,1000]`）传给 DiT，省去 diffusers 的"pipeline 除 1000、transformer 内乘回 1000"往返。`Timesteps`（sinusoidal embedding）输入必须是 `[0,1000]` 量级才能产生正确高频嵌入，误传 `[0,1]` 会让模型无法区分 timestep、输出纯噪声。PR 注释明确记录了这一对齐决策。

---

## 意义与影响

本 PR 把 LongCat-Image 接入 SGLang `multimodal_gen`，使该模型获得 **TP 多卡推理**（全层 `ColumnParallelLinear`/`RowParallelLinear` + `USPAttention` FA3/FA4）、**TeaCache 加速**（默认关闭，借用 ZImage 系数待实测）与统一 API（`DiffGenerator` Python API / `sglang generate` CLI / HTTP Server）。

更重要的是它**验证了组合式 pipeline 框架的扩展性**：仅靠一个 `PipelineConfig` + 两个模型特定 Stage，就接入了带 VLM prompt rewrite 的复杂 T2I 模型，标准去噪/解码 Stage 全程复用。同时暴露并修复了三个共享缺口——`LocalAttention` GQA、Qwen2.5-VL attn_mask 透传、3D position_ids 广播——这些修复对后续任何想在 SGLang 内复用 VLM 做自回归解码的模型（如其他带 prompt rewrite 的扩散模型）都直接受益。

### 与 diffusers 的关键差异

| 方面 | diffusers | SGLang |
|------|-----------|--------|
| 多 GPU（TP） | 不支持 | 全层 `ColumnParallelLinear`/`RowParallelLinear` |
| Timestep 传递 | `transformer(t=scheduler_t/1000)`，DiT 内 `×1000` | 直接传原始 scheduler t，DiT 不缩放 |
| RoPE 计算 | 每次 DiT forward 计算 | 预处理阶段算一次，50 步复用 |
| Prompt Rewrite | 支持，VLM 改写 | 支持，复用 SGLang 内 Qwen2.5-VL + KV cache |
| TeaCache | 不支持 | 支持（默认关闭，借用 ZImage coefficients） |

---

## TODO

- [ ] 实测 TeaCache 多项式系数：当前借用同族 ZImage 的 `coefficients=[7.33e2, -4.01e2, 6.76e1, -3.15, 9.61e-2]`、`teacache_thresh=0.15`，未针对 LongCat-Image 独立测量，故默认 `enable_teacache=False`。
- [ ] 补单元测试（PR checklist 未勾选）。
- [ ] 与 diffusers 参考输出做同 seed 像素级对比，确认数值一致。
- [ ] 扩展支持多 prompt 并行（当前 batch_size 固定为 1）。
- [ ] 接入 LongCat-Image-Edit（图像编辑 pipeline，需额外处理 image VAE 编码）。

---

## 参考

- [LongCat-Image HuggingFace](https://huggingface.co/meituan-longcat/LongCat-Image)
- [LongCat-Image GitHub](https://github.com/meituan-longcat/LongCat-Image)
- [diffusers `transformer_longcat_image.py`](https://github.com/huggingface/diffusers/blob/main/src/diffusers/models/transformers/transformer_longcat_image.py)
- Flux MMDiT 架构（`axes_dims_rope`、packed latents 的同族设计）
