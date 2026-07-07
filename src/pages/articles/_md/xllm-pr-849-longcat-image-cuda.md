---
title: "在 CUDA 上支持 LongCat-Image 图像生成"
source:
  project: "xLLM"
  type: "PR"
  id: "849"
  url: "https://github.com/jd-opensource/xllm/pull/849"
  prType: "feat"
date: "2026-07-06"
category: [AI, 推理, xLLM, Contributions]
tags: ["DiT", "FlashInfer", "Image Generation", "Qwen2.5-VL", "CUDA", "FlowMatch"]
description: "为 xLLM 实现 LongCat-Image CUDA 支持：以 Qwen2.5-VL 做文本编码器，将 attn_mask 从 NPU 专属提升为通用字段，并为 FlashInfer FA2 后端实现 bit-packing 自定义掩码。"
readingTime: "15 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#849](https://github.com/jd-opensource/xllm/pull/849) · **Issue** - · **commit** [e59548b](https://github.com/jd-opensource/xllm/commit/e59548b) · **首发版本** v0.9.0 · **变更行数** +1400 行 · **合并时间** 2026-02-10

---

## 背景

LongCat-Image 是美团自研的文生图模型，基于 DiT（Diffusion Transformer）架构，在内部已有 NPU 后端支持。本 PR 的目标是让它也能在 NVIDIA GPU（CUDA）上运行，供更广泛的环境使用。

这件事比听起来复杂。xLLM 的 DiT 路径此前只有 Flux 系列模型在 CUDA 上完整跑通，LongCat-Image 在架构上有几处和 Flux 不同的地方：

- **文本编码器**：Flux 使用 CLIP + T5 的组合，而 LongCat-Image 使用 **Qwen2.5-VL** 作为文本编码器——这是一个多模态 LLM，而不是专用编码器；
- **注意力掩码**：Qwen2.5-VL 编码文本时需要 padding mask，而 CUDA 路径的 `batch_prefill` 原先不支持自定义 mask；
- **位置编码**：文本序列通过 MROPE（Multimodal RoPE）计算位置，需要从 `cu_query_lens` 推断位置，而非依赖显式 `position_ids`。

这三个差异都需要在底层基础设施上打补丁，才能把 LongCat-Image 的 pipeline 跑起来。

---

## 前置知识

### DiT 与 FlowMatch

LongCat-Image 的去噪过程使用 **FlowMatch Euler Discrete** 调度器，而不是传统的 DDPM/DDIM。核心区别是 noise schedule：FlowMatch 以直线（flow）而非曲线逼近从噪声到数据的路径，通常只需 50 步左右就能生成高质量图像。

Timestep 的安排由 `calculate_shift()` 函数动态调整——图像序列越长，`mu`（shift 参数）越大，意味着调度器在高 sigma 区域停留更久：

```cpp title="xllm/models/dit/pipelines/pipeline_longcat_image.h"
float calculate_shift(int64_t image_seq_len,
                      int64_t base_seq_len = 256,
                      int64_t max_seq_len = 4096,
                      float base_shift = 0.5f,
                      float max_shift = 1.15f) {
  float m = (max_shift - base_shift) /
            static_cast<float>(max_seq_len - base_seq_len);
  float b = base_shift - m * static_cast<float>(base_seq_len);
  return static_cast<float>(image_seq_len) * m + b;
}
```

### FlashInfer 与 packed bitmap mask

xLLM 的 CUDA attention 后端使用 [FlashInfer](https://flashinfer.ai/)。FlashInfer 的 FA2（FlashAttention 2）路径支持自定义掩码，但格式不是浮点矩阵，而是 **packed uint8 bitmap**：每 8 个掩码元素打包为 1 字节，节省显存带宽。这套格式和 layout 需要调用方自己构造，再通过 `mask_indptr` 传递批次边界。

### Classifier-Free Guidance（CFG）与 CFG Renorm

CFG 是文生图模型的标准技巧：同时做 conditional 和 unconditional 推断，然后按 `guidance_scale` 加权合并：

```
noise_pred = uncond + guidance_scale × (cond - uncond)
```

CFG Renorm 是对此的改进——当 CFG 放大 noise_pred 的模长时，将其重新归一化到 conditional 预测的尺度，防止过强的 CFG 导致色彩饱和或伪影：

```cpp title="CFG Renorm（pipeline_longcat_image.h）"
if (enable_cfg_renorm) {
  torch::Tensor cond_norm = torch::norm(noise_pred_text, 2, -1, true);
  torch::Tensor noise_norm = torch::norm(noise_pred, 2, -1, true);
  torch::Tensor scale = (cond_norm / (noise_norm + 1e-8f))
                            .clamp_min(cfg_renorm_min)
                            .clamp_max(1.0f);
  noise_pred = noise_pred * scale;
}
```

`clamp_min(cfg_renorm_min)` 保证 scale 不会太小，避免过度抑制细节。

---

## 实现

### 总体架构

LongCat-Image 的 pipeline 由五个组件组成，在 `LongCatImagePipelineImpl` 的构造函数中初始化：

```
LongCatImagePipeline
├── text_encoder: Qwen2_5_VLForConditionalGeneration  ← 文本编码
├── scheduler: FlowMatchEulerDiscreteScheduler         ← 去噪调度
├── transformer: LongCatImageTransformer2DModel        ← 主去噪网络
├── vae: AutoencoderKL                                 ← 编解码器
└── pos_embed: LongCatImagePosEmbed                    ← 旋转位置编码
```

Transformer 架构继承自 Flux，分为双流和单流两种 block：

| 组件 | 数量（默认） | 说明 |
|---|---|---|
| `LongCatImageTransformerBlock` | 19 层 | 双流 block，复用 `FluxTransformerBlock` |
| `LongCatImageSingleTransformerBlock` | 38 层 | 单流 block，独立实现 |
| `in_channels` / `out_channels` | 64 | Flux 为 16，LongCat-Image 使用更宽的 latent |
| `joint_attention_dim` | 3584 | 对应 Qwen2.5-VL 的 hidden size |

> LongCat-Image 的 `in_channels=64` 是 Flux（16）的 4 倍，因为 patch 在打包时做了 2×2 的 pixel shuffle：每个 latent patch 包含 4 个空间位置 × 16 channels。

### Transformer 注册的特殊处理

xLLM 通常用宏注册模型：

```cpp
REGISTER_DIT_MODEL(ModelType, Class)
```

但这个宏会将 `ModelType` 拼入 C++ 变量名（如 `ModelType##_registered`），而 `"LongCat-Image"` 含有连字符，在 C++ 标识符中非法。因此改为手动注册：

```cpp title="xllm/models/dit/pipelines/pipeline_longcat_image.h"
namespace {
const bool longcat_image_dit_registered = []() {
  ModelRegistry::register_dit_model_factory(
      "LongCat-Image", [](const DiTModelContext& context) {
        LongCatImagePipeline model(context);
        model->eval();
        return std::make_unique<DiTModelImpl<LongCatImagePipeline>>(
            std::move(model), context.get_tensor_options());
      });
  return true;
}();
}  // namespace
```

匿名命名空间中的 static 初始化在程序启动时自动执行，效果等价于宏，但不受变量名的字符限制。

### Qwen2.5-VL 做文本编码器

LongCat-Image 用 Qwen2.5-VL 提取文本特征，而不是 CLIP/T5。这意味着它的文本端走的是完整的 LLM forward pass，还需要处理 MROPE 位置编码。

`encode_prompt_qwen()` 分 7 步走：

1. **Tokenize**：用 `split_quotation()` 处理引号，再分段 tokenize
2. **Pad**：填充到 `max_sequence_length`，使用 pad token id（Qwen2 默认 151643）
3. **拼模板**：在头尾加 system/user/assistant 的 chat template
4. **构造 MROPE positions**：`cumsum(attention_mask) - 1`，三维展开（T/H/W 相同），触发 `apply_mrope()`
5. **Forward**：调用 Qwen2.5-VL 的 `forward()`
6. **裁剪**：去掉 prefix 和 suffix 的 hidden states，保留 prompt 部分
7. **Repeat**：按 `num_images_per_prompt` 复制

```cpp title="encode_prompt_qwen 的 MROPE positions 构造"
auto mask_flat = attention_mask.view({-1});
auto positions_1d = mask_flat.to(torch::kInt64).cumsum(-1) - 1;
positions_1d = positions_1d.masked_fill(mask_flat == 0, 1);

// [3, seq_len]: 三个 MROPE 维度（T/H/W）对文本均相同
torch::Tensor positions_2d =
    positions_1d.unsqueeze(0).expand({3, -1}).contiguous();
```

`positions.dim() == 2` 会触发 xLLM 的 `apply_mrope()` 逻辑，这是和普通 LLM forward 的关键区别。

### 位置 ID 的精度陷阱

Pipeline 在构造图像 latent 的位置 ID 时有一段 `CRITICAL FIX` 注释：

```cpp title="prepare_latent_image_ids（精度修复）"
// CRITICAL FIX: Convert to float32 instead of options_.dtype() to avoid
// precision loss. bfloat16 cannot accurately represent 511, causing it to
// round to 512.
torch::TensorOptions float32_options =
    options_.dtype(torch::kFloat32).device(options_.device());
torch::Tensor latent_image_ids = latent_image_ids_int.to(float32_options);
```

图像位置 ID 从 512 开始（`TOKENIZER_MAX_LENGTH = 512`），避免和文本位置重叠。bfloat16 的尾数只有 7 位，无法精确表示 511（0x1FF），会四舍五入为 512，导致文本和图像位置重叠、RoPE 计算错误。修复方法是先用 int64 做加法，再转换为 float32。

### 通用化 attn_mask：从 NPU 到 CUDA

Qwen2.5-VL 对 padding token 做 attention mask（attention_mask=0 的位置不参与 attention）。原来这个 `attn_mask` 字段只在 `#if defined(USE_NPU)` 块内定义，CUDA 无法访问。

这次将其移到公共区域：

```cpp title="xllm/core/layers/common/attention_metadata.h（简化）"
struct AttentionMetadata {
  // 原来仅 NPU 可用，现在提升为通用字段
  torch::Tensor attn_mask;
  // ...
};
```

`attention_metadata_builder.cpp` 的填充逻辑也从 `USE_NPU` 扩展到 `USE_CUDA || USE_NPU`，并支持两级 fallback：

```cpp title="xllm/core/layers/common/attention_metadata_builder.cpp"
// 优先使用显式传入的 attn_mask
std::optional<torch::Tensor> mask_to_use = attn_mask;
// fallback：从 graph_buffer 取（Qwen2.5-VL/LongCat 文本编码时设置）
if (!mask_to_use.has_value() && params.graph.attn_mask.defined()) {
  mask_to_use = params.graph.attn_mask;
}
if (mask_to_use.has_value()) {
  attn_metadata.attn_mask = mask_to_use.value();
}
```

### batch_prefill 的 packed bitmap 实现

FlashInfer FA2 要求自定义 mask 以 **packed uint8 bitmap** 格式传入，8 个 attention pair 打包为 1 字节。`batch_prefill_impl()` 中新增了这段转换：

```cpp title="xllm/core/kernels/cuda/batch_prefill.cpp"
if (mask.has_value()) {
  auto m = mask.value().to(query.device()).to(torch::kFloat32);
  int64_t seq_len = m.size(0);

  // 构造因果掩码，与 padding mask 合并
  // → attend where (j <= i) AND (mask[j] == 1)
  auto causal_mask = torch::tril(torch::ones(
      {seq_len, seq_len},
      torch::TensorOptions().dtype(torch::kFloat32).device(device)));
  auto combined_mask =
      causal_mask * m.unsqueeze(0).expand({seq_len, seq_len});

  // 按位打包：1 byte per 8 positions
  const int64_t n = seq_len * seq_len;
  const int64_t num_bytes = (n + 7) / 8;
  auto flat = combined_mask.contiguous().view({-1}).cpu();
  auto packed = torch::zeros({num_bytes},
      torch::TensorOptions().dtype(torch::kUInt8));
  auto flat_acc = flat.accessor<float, 1>();
  auto packed_acc = packed.accessor<uint8_t, 1>();
  for (int64_t i = 0; i < n; ++i) {
    if (flat_acc[i] > 0.5f) {
      packed_acc[i / 8] |= static_cast<uint8_t>(1u << (i % 8));
    }
  }

  processed_mask = packed.to(device).contiguous();
  // mask_indptr: [0, num_bytes]，标记 batch 边界
  mask_indptr_opt = torch::tensor({0, (int32_t)num_bytes},
      torch::TensorOptions().dtype(torch::kInt32).device(device));
}
```

有了 `processed_mask` 之后，会强制选择 FA2 后端（FA3 不支持自定义 mask），再透传给 FlashInfer：

```cpp title="FlashInfer FA2 调用片段"
bool use_custom_mask = processed_mask.has_value();
std::string backend = determine_attention_backend(
    /*pos_encoding_mode=*/0, /*use_fp16_qk_reduction=*/false, use_custom_mask);

// backend == "fa2" 时才带 mask 参数
get_function(uri, "ragged_run")(
    ...,
    processed_mask.has_value() ? to_ffi_tensor(processed_mask.value())
                               : ffi::Optional<ffi::Tensor>(),
    mask_indptr_opt.has_value() ? to_ffi_tensor(mask_indptr_opt.value())
                                : ffi::Optional<ffi::Tensor>(),
    ...);
```

### apply_rotary 的三路分支

在不提供显式 `position_ids` 的情况下（如 LongCat-Image 的 transformer 内部），`apply_rotary()` 现在支持三种路径：

```cpp title="xllm/core/kernels/ops_api.cpp — CUDA 路径"
if (params.position_ids.has_value()) {
  // 路径 1：有显式 position_ids，直接用
  pos_ids = params.position_ids.value().to(torch::kInt64);
} else if (params.cu_query_lens.has_value()) {
  // 路径 2：从累积长度推断 seq_len，生成 [0, seq_len) 的 position_ids
  auto cu = params.cu_query_lens.value().to(torch::kInt64);
  int64_t seq_len = cu[1].item<int64_t>() - cu[0].item<int64_t>();
  pos_ids = torch::arange(seq_len, ...);
} else {
  // 路径 3：从 q.size(0) 推断（LongCat-Image-Edit 场景）
  int64_t seq_len = params.q.size(0);
  pos_ids = torch::arange(seq_len, ...);
}
```

这个扩展使得 LongCat-Image 在 transformer 内做 attention 时，不需要显式构造 `position_ids`，简化了调用方的负担。

---

## Review

本 PR 经过多轮 review（约 10 次 force-push），几个有价值的改动：

**transformer_flux.h 的 `#elif` 修复**（yiming-l21，commit `b3c33b5`）：

原代码在预处理器条件链中用了 `#else`，逻辑上是正确的，但当中间某个 `#elif` 被激活时，`#else` 会捕获所有剩余情况，可能掩盖其他平台的路径。改为 `#elif defined(USE_CUDA)` 使条件更精确。

**attention_metadata_builder 的 mask 优先级**（xiao-yu-chen）：

最初实现直接取 `params.graph.attn_mask`，review 后改为：先看显式传入的 `attn_mask` 参数，再 fallback 到 `graph.attn_mask`。这让调用方有更高的优先级，不会被 graph buffer 的残留值干扰。

---

## 问题

### 单设备 VLM 初始化需要 ProcessGroup

Qwen2.5-VL 的 forward 依赖 `ParallelArgs::tp_group_`，但在单 GPU 的 DiT 场景里，`tp_group_` 可能是 `nullptr`（LLM serving 场景里 tp_group 由更上层初始化）。

解决方式是在 pipeline 构造时检测，如果 `tp_group_` 为空则临时创建一个单进程的 `ProcessGroup`：

```cpp title="pipeline_longcat_image.h — 单设备 VLM 初始化"
if (original_parallel_args.tp_group_ == nullptr) {
  LOG(INFO) << "Creating real ProcessGroup for single-device VLM init.";
  vlm_tp_group_ = create_process_group(
      0, 1, 1, 29500, false, "127.0.0.1", "vlm_tp_group", options_.device());
  vlm_parallel_args.tp_group_ = vlm_tp_group_.get();
}
```

端口 29500 是约定好的 fallback，单进程下不会真正通信。

### CFG 的 cache 隔离

DiT transformer 内部有 block-level cache。CFG 需要对同一个 `prepared_latents` 分别做 conditional 和 unconditional forward，如果两次 forward 的 cache key 一样，会取到脏数据。

解决方法是 unconditional forward 时传入一个偏移后的 `step_idx`：

```cpp title="CFG cache 隔离"
torch::Tensor negative_noise_pred = transformer_->forward(
    prepared_latents,
    negative_encoded_embeds,
    timestep,
    negative_image_rotary_emb,
    i + 10000);  // Use different step_idx to avoid cache collision
```

加偏移 10000 是一个实用 hack，在 `num_inference_steps` 通常只有 50 的情况下，不会和正向 step 的 index 碰撞。

---

## 意义与影响

这个 PR 实现的东西可以分为两层：

**上层**：LongCat-Image 可以在 CUDA GPU 上运行，通过 xLLM HTTP API 提供文生图服务，请求格式兼容 OpenAI 风格。

**下层**：三处基础设施改进对其他模型同样有价值——

| 改动 | 受益场景 |
|---|---|
| `attn_mask` 通用化 | 任何需要 padding mask 的 CUDA 模型 |
| `batch_prefill` packed bitmap mask | FlashInfer FA2 路径的自定义注意力模式 |
| `apply_rotary` 三路分支 | 无显式 position_ids 的 attention 场景 |

LongCat-Image 使用 Qwen2.5-VL 作为文本编码器这一点值得关注——它说明 xLLM 的 DiT pipeline 并不局限于传统的 CLIP/T5 组合，已经可以将任意 LLM 接入文生图流程，这为后续多模态模型的支持铺平了路。

---

## 参考

- [diffusers LongCat-Image Pipeline](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/longcat_image/pipeline_longcat_image.py)
- [diffusers LongCat-Image Transformer](https://github.com/huggingface/diffusers/blob/main/src/diffusers/models/transformers/transformer_longcat_image.py)
- [FlashInfer Custom Mask 文档](https://docs.flashinfer.ai/api/python/attention.html)
- [FlowMatch Euler Discrete Scheduler](https://huggingface.co/docs/diffusers/api/schedulers/flow_match_euler_discrete)
