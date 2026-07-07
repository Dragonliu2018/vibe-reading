---
title: "在 CUDA 上支持 LongCat-Image-Edit 图像编辑"
source:
  project: "xLLM"
  type: "PR"
  id: "957"
  url: "https://github.com/jd-opensource/xllm/pull/957"
  prType: "feat"
date: "2026-07-06"
category: [AI, 推理, xLLM, Contributions]
tags: ["DiT", "Image Editing", "Qwen2.5-VL", "FlashInfer", "CUDA", "FlowMatch", "MROPE"]
description: "为 xLLM 实现 LongCat-Image-Edit CUDA 支持：图像编辑双流 latent 拼接、Qwen2.5-VL 多模态文本编码、CUDA vision attention 的 SDPA 回退、以及 bmm 优化的 eager attention。"
readingTime: "18 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#957](https://github.com/jd-opensource/xllm/pull/957) · **Issue** - · **commit** [dca05bb](https://github.com/jd-opensource/xllm/commit/dca05bb) · **首发版本** v0.9.0 · **变更行数** +700 行 · **合并时间** 2026-03-07

---

## 背景

PR #849 为 xLLM 带来了 LongCat-Image（文生图）的 CUDA 支持。LongCat-Image-Edit 是同系列的图像编辑模型——给定一张原图和编辑指令，输出修改后的图像。Demo 效果：输入一张猫的图片，指令"将猫变成狗"，输出一只狗。

和文生图相比，图像编辑在 pipeline 层面有几个结构上的差异：

| 特性 | LongCat-Image | LongCat-Image-Edit |
|---|---|---|
| 输入 | 文本 | 文本 + 参考图像 |
| 文本编码器输入 | 纯文字 token | 图像 token + 文字 token |
| Latent 构成 | 纯噪声 | 噪声 latent ∥ 图像 latent（拼接）|
| 模态 ID | 1（图像）| 1（噪声 latent），2（图像 latent）|
| 分辨率策略 | 固定 | 动态，按长宽比缩放到 ~1M 像素 |

这些差异带来了三个新问题：Qwen2.5-VL 的图像 token 如何在 CUDA attention 上高效运行、MROPE 位置如何与图像 patch 对齐、以及双流 latent 如何在 transformer 中共同去噪。本 PR 逐一解决了它们。

---

## 前置知识

### 图像编辑的双流 latent 结构

LongCat-Image-Edit 的编辑机制参考 Flux-Fill / inpainting 架构：在每个去噪步中，将**随机噪声 latent**（待生成）和 **VAE 编码的参考图 latent**（条件）沿序列维度拼接，一并送入 transformer：

```
latent_model_input = cat([prepared_latents, image_latents], dim=1)
# shape: [B, noise_seq + img_seq, C]
```

Transformer 的注意力在整个拼接序列上计算，使噪声 token 能"看见"参考图的 latent。调度器步进时只取噪声部分：

```cpp title="去噪循环中的双流拆分"
torch::Tensor noise_pred_text_full = transformer_->forward(
    latent_model_input, encoded_prompt_embeds, timestep, image_rotary_emb);
// 只取 [0, image_seq_len) 对应的噪声预测
torch::Tensor noise_pred = noise_pred_text_full.narrow(1, 0, image_seq_len);
```

### MROPE 位置编码的多模态感知

Qwen2.5-VL 的 MROPE 使用三个维度（时间 T / 高度 H / 宽度 W）编码位置，对文本和图像 patch 分别赋予不同的 T/H/W 坐标。图像区域内部的 H/W 坐标反映 patch 在原图中的空间位置，从而让 attention 具有 2D 感知。

---

## 实现

### Pipeline 总体结构

`LongCatImageEditPipelineImpl` 和 T2I 版本共享相同的组件集，但有两处关键差异：

1. 新增了 `Qwen2VLImageProcessor vl_image_processor_`——图像编辑模式下文本编码器需要处理真实图像 patch，不再是纯文本
2. ProcessGroup 端口从 29500 改为 **29501**，避免同机部署时和 T2I pipeline 冲突

```cpp title="pipeline_longcat_image_edit.h — 初始化片段"
vlm_tp_group_ = create_process_group(
    0, 1, 1, 29501,  // Different port from T2I (29500)
    false, "127.0.0.1", "vlm_tp_group_longcat_edit", options_.device());
```

### 动态分辨率

T2I 版本使用固定宽高，Edit 版本需要适配输入图像的任意长宽比。`calculate_dimensions_edit()` 按比例缩放到目标面积（1024×1024 = 1M 像素），并对齐到 16 像素边界：

```cpp title="pipeline_longcat_image_edit.h — 分辨率计算"
inline std::pair<int64_t, int64_t> calculate_dimensions_edit(
    int64_t target_area, float ratio) {
  double width  = std::sqrt(static_cast<double>(target_area) * ratio);
  double height = width / ratio;

  auto round_to_16 = [](double x) -> int64_t {
    int64_t v = static_cast<int64_t>(x);
    if (v % 16 != 0) v = (v / 16 + 1) * 16;
    return v;
  };
  return {round_to_16(width), round_to_16(height)};
}
```

输入图像在 `forward_()` 中经过两次缩放：

- **全分辨率**（`calculated_height × calculated_width`）→ VAE 编码为 image_latents
- **半分辨率**（`calculated_height / 2 × calculated_width / 2`）→ Qwen2.5-VL 文本编码（match diffusers 行为）

### Latent 准备：两种模态 ID

图像编辑的位置 ID 使用不同的**模态 ID**来区分噪声 latent 和图像 latent：

```cpp title="prepare_latents_with_image — 位置 ID 构造"
int64_t start = prompt_length;  // 图像位置从 prompt_length 开始，避开文本位置

torch::Tensor latents_ids = prepare_image_pos_ids(
    /*modality_id=*/1,           // 噪声 latent 的模态 ID
    /*start_row=*/start, /*start_col=*/start,
    /*height=*/adjusted_height / 2, /*width=*/adjusted_width / 2);

torch::Tensor image_latents_ids = prepare_image_pos_ids(
    /*modality_id=*/2,           // 图像 latent 的模态 ID
    /*start_row=*/start, /*start_col=*/start,
    /*height=*/adjusted_height / 2, /*width=*/adjusted_width / 2);
```

两组 latent 的 H/W 坐标完全相同（因为它们对应的是同一张图的不同表示），但模态 ID 不同——transformer 的注意力机制通过 RoPE 中嵌入的模态 ID 区分两种 latent 的语义，同时又能跨模态地进行信息交换。

最终位置 ID 拼接后送入 `pos_embed_`：

```cpp title="RoPE 计算"
torch::Tensor all_image_ids = torch::cat({latents_ids, image_latents_ids}, 0);
auto [rot_emb1, rot_emb2] = pos_embed_->forward_cache(
    text_ids, all_image_ids, height / (vae_scale_factor_ * 2), ...);
```

### 多模态文本编码：MROPE 位置的精确构建

图像编辑的文本编码比文生图复杂得多——Prompt 模板中嵌入了真实的图像 token：

```
<|im_start|>system\n<编辑专家描述>...<|im_end|>
<|im_start|>user\n<|vision_start|><|image_pad|>×N<|vision_end|><编辑指令><|im_end|>
<|im_start|>assistant\n
```

其中 `<|image_pad|>` 在 tokenize 前被展开为 `N = image_grid_thw.prod() / merge_length` 个副本，N 是经过 `merge_size²` 压缩后实际送入 LLM 的 vision token 数量。

`build_qwen2_5_vl_mrope_positions()` 实现了 MROPE 位置的精确计算。核心逻辑：

1. 遍历序列，在 `vision_start + image_token` 出现处检测图像区域
2. 图像区域前的文字使用连续的 1D 位置（三个维度相同）
3. 图像区域内部使用 `(t, h, w)` 三维坐标，由 `image_grid_thw` 确定网格形状
4. 图像区域之后的文字位置从图像最大位置 +1 继续

```cpp title="build_qwen2_5_vl_mrope_positions — 图像区域坐标构建"
int64_t llm_grid_h = h / spatial_merge_size;  // 合并后的网格高
int64_t llm_grid_w = w / spatial_merge_size;

auto t_index = torch::arange(llm_grid_t)
                   .view({-1, 1}).expand({-1, llm_grid_h * llm_grid_w}).flatten();
auto h_index = torch::arange(llm_grid_h)
                   .view({1, -1, 1}).expand({llm_grid_t, -1, llm_grid_w}).flatten();
auto w_index = torch::arange(llm_grid_w)
                   .view({1, 1, -1}).expand({llm_grid_t, llm_grid_h, -1}).flatten();

auto vision_pos = torch::stack({t_index, h_index, w_index}, 0) + text_len + st_idx;
```

相比 T2I 版本（全程用相同的 3D 位置），Edit 版本的 MROPE 构建更接近 Qwen2.5-VL 原生实现，正确区分了文字位置和图像 patch 的空间位置。

### CUDA Vision Attention：绕开 head_dim=80 的限制

Qwen2.5-VL 的视觉注意力使用 `head_dim=80`，但 xLLM 所用的 FlashInfer 预编译 AOT kernel 不支持这个维度（FlashInfer 标准编译版本只覆盖 64、128、256 等 2 的幂次）。

解决方案是为 CUDA 新增一条纯 PyTorch SDPA 路径 `compute_qwen2_vision_attention_cuda()`，完全绕开 FlashInfer：

```cpp title="qwen2_vision_attention.cpp — CUDA SDPA 路径"
void compute_qwen2_vision_attention_cuda(
    torch::Tensor& q, torch::Tensor& k, torch::Tensor& v,
    torch::Tensor& output,
    const std::vector<int32_t>& cu_seq_len_vec, float scale) {

  const int32_t num_seqs = cu_seq_len_vec.size() - 1;
  for (int32_t i = 0; i < num_seqs; ++i) {
    int32_t start = cu_seq_len_vec[i], end = cu_seq_len_vec[i + 1];
    int32_t len = end - start;

    // [len, H, D] -> [H, len, D]
    auto q_i = q.slice(0, start, end).permute({1, 0, 2});
    auto k_i = k.slice(0, start, end).permute({1, 0, 2});
    auto v_i = v.slice(0, start, end).permute({1, 0, 2});

    // Scaled dot-product attention (non-causal for vision encoder)
    auto scores = torch::matmul(q_i * scale, k_i.transpose(1, 2));  // [H, len, len]
    auto attn   = torch::softmax(scores, -1);
    auto out_i  = torch::matmul(attn, v_i);  // [H, len, D]

    out_i = out_i.permute({1, 0, 2}).contiguous();
    output.slice(0, start, end).copy_(out_i);
  }
}
```

对应的调用处有明确的注释说明选择原因：

```cpp title="USE_CUDA 路径选择（注释）"
// CUDA path: use a pure PyTorch vision attention implementation that matches
// Transformers Qwen2.5-VL VisionAttention. FlashInfer's precompiled AOT
// kernels in this project do not support head_dim=80, so we intentionally do
// not call FlashInfer here and run attention entirely in PyTorch instead.
compute_qwen2_vision_attention_cuda(q, k, v, output, cu_seq_len_vec, scale_);
```

### RoPE 双重应用 Bug 修复

在修复过程中发现了一个存量 bug：原代码对 `k` 调用了两次 `apply_rotary`，导致 key 的旋转位置编码被应用了两次，模型输出不正确。

修复后，q 和 k 在做 RoPE 前先 reshape 到 `[B*S, H, D]`，然后在**一次** `apply_rotary` 调用中同时处理：

```cpp title="qwen2_vision_attention.cpp — RoPE 单次调用"
// Reshape [B, S, H, D] -> [B*S, H, D]
q = q.reshape({B * S, num_attention_heads_per_partition_, head_dim});
k = k.reshape({B * S, num_attention_heads_per_partition_, head_dim});

// Apply rotary position embedding to both q and k in a single call.
// NOTE: Do NOT call apply_rotary twice; the first call already handles both
// q and k. A second call would incorrectly apply RoPE to k a second time.
xllm::kernel::RotaryParams rotary_params;
rotary_params.q = q;
rotary_params.k = k;
rotary_params.sin = m_sin_pos;
rotary_params.cos = m_cos_pos;
rotary_params.cu_query_lens = cu_seq_len;
xllm::kernel::apply_rotary(rotary_params);
```

### Eager Causal Attention 的 bmm 优化

`run_eager_causal_padded_attention()` 是 LongCat 文本编码器走自定义掩码路径时的 fallback（FlashInfer 的 custom mask 路径存在 token-0 输出错误）。原实现在计算 attention score 时存在内存放大问题：

**优化前**（隐含的中间张量）：

```
Q: [T, H, D]  ×  K: [T, H, D]
→ 广播展开后会产生 [T, T, H, D] 的中间张量
→ 显存：O(T² × H × D)
```

**优化后**（bmm 路径）：

```cpp title="flashinfer_attention.cpp — bmm 优化"
// Q: [T, H, D] -> [H, T, D],  K: [T, H, D] -> [H, D, T]
auto Qf_HTD = Qf.permute({1, 0, 2});
auto Kf_HDT = Kf.permute({1, 2, 0});
// scores = Q @ K^T: [H, T, T]  → 无 D 维度的中间张量
auto scores = torch::bmm(Qf_HTD, Kf_HDT) * scale;
scores = scores.permute({1, 0, 2});  // [T, H, T]
```

优化后显存复杂度从 `O(T² × H × D)` 降至 `O(T² × H)`，当 `D`（head_dim）较大时收益明显。对于 LongCat 的文本编码序列（通常 512+ token），这个差值会相当可观。

### 模型加载：preprocessor_config.json 解析

Edit 模式的文本编码器使用真实图像，需要读取 `preprocessor_config.json` 来配置 `Qwen2VLImageProcessor` 的归一化参数。`DiTFolderLoader::load_image_preprocessor_args()` 在加载 safetensors 时自动调用：

```cpp title="dit_model_loader.cpp — 预处理器参数加载"
bool DiTFolderLoader::load_image_preprocessor_args(
    const std::string& model_weights_path) {
  const std::string path = model_weights_path + "/preprocessor_config.json";
  // ...
  args_.mm_image_min_pixels() =
      reader.value_or<int>("min_pixels", args_.mm_image_min_pixels());
  args_.mm_image_max_pixels() =
      reader.value_or<int>("max_pixels", args_.mm_image_max_pixels());
  if (reader.contains("image_mean")) {
    args_.image_mean() = reader.data()["image_mean"]
                             .get<std::vector<double>>();
  }
  if (reader.contains("image_std")) {
    args_.image_std() = reader.data()["image_std"]
                            .get<std::vector<double>>();
  }
}
```

`value_or` 提供了安全的默认值回退，缺字段时不会导致崩溃——这也是 gemini-code-assist 在 review 中关注的错误处理问题。

---

## Review

**Gemini bot** 指出 `load_image_preprocessor_args` 在 `preprocessor_config.json` 不存在时返回 `false` 但调用方没有做错误处理，可能导致静默失败。实际上代码里用了 `value_or` 回退，最终采用了日志 + 继续运行的方式（`LOG(ERROR)` 但不中断加载），对推理场景而言是合理的。

**yiming-l21** 注意到 `transformer_flux.h` 的 `#else` → `#elif` 问题（同 PR #849），本 PR 中也有类似改动已随之修正。

---

## 问题

### 回归：RoPE 模式切换影响 Qwen VL on MLU

`qwen2_vision_attention.cpp` 的 RoPE 修复（reshape + 单次 apply_rotary）改变了 q/k 进入 `apply_rotary` 前的 shape，这在 CUDA 上工作正常，但触发了 MLU 路径上 `apply_rotary` 中的一个不同的形状假设，导致 Qwen VL 在 MLU 设备上出错。

后续 PR #1023 专门修复了这个回归。这是跨硬件平台的 kernel 参数敏感性的典型案例：CUDA 和 MLU 共用上层接口，但底层 kernel 对 shape 的假设不一样，一处 "看起来等价" 的修改可能在另一个平台上破坏行为。

---

## 意义与影响

LongCat-Image-Edit 的 CUDA 支持使 xLLM 在图像生成领域从"文生图"拓展到"图像编辑"，两者使用相同的 HTTP API 接口。

几个值得关注的技术价值：

1. **双流 latent 拼接模式**：噪声 latent 与参考图 latent 沿序列维度拼接后共同去噪，这种 in-context conditioning 不需要修改 transformer 结构，对后续的 inpainting、super-resolution 等图像编辑任务有普适的参考价值。

2. **CUDA vision attention 回退路径**：`head_dim=80` 的 FlashInfer 限制反映了 AOT 编译的固有约束——FlashInfer 为了性能在编译期固定 head_dim，非 2 的幂次不支持。纯 PyTorch SDPA 虽然不是最优，但正确性有保证，且 vision encoder 通常只在推理开始时跑一次，性能影响有限。

3. **多模态 MROPE 位置构建**：相比 T2I 版本的简化版，Edit 版本的 `build_qwen2_5_vl_mrope_positions()` 是完整的 Qwen2.5-VL MROPE 实现，后续接入其他需要真实 MROPE 的 VLM 模型时可以直接复用。

4. **bmm 优化普适性**：`run_eager_causal_padded_attention` 的 bmm 优化是纯数学等价变换，对所有使用这条 fallback 路径的模型（不只是 LongCat）都有显存收益。

---

## 参考

- [diffusers LongCat-Image-Edit Pipeline](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/longcat_image/pipeline_longcat_image_edit.py)
- [Qwen2.5-VL 技术报告](https://arxiv.org/abs/2502.13923)
- [FlashInfer AOT 编译文档](https://docs.flashinfer.ai/installation.html)
