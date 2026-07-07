---
title: "在 CUDA 上支持 LongCat-AudioDiT 音频生成"
source:
  project: "xLLM"
  type: "PR"
  id: "1478"
  url: "https://github.com/jd-opensource/xllm/pull/1478"
  prType: "feat"
date: "2026-07-06"
category: [AI, 推理, xLLM, Contributions]
tags: ["DiT", "TTS", "Voice Cloning", "Audio Generation", "UMT5", "ODE", "APG", "WAV-VAE"]
description: "为 xLLM 实现 LongCat-AudioDiT CUDA 支持：WAV-VAE 音频压缩、UMT5 文本编码、全局 AdaLN + 长跳连接的 DiT 骨干、Euler ODE 求解、APG 引导的 Voice Cloning，以及 weight_norm 权重重建工具。"
readingTime: "20 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1478](https://github.com/jd-opensource/xllm/pull/1478) · **Issue** - · **commit** [9e8a663](https://github.com/jd-opensource/xllm/commit/9e8a663) · **首发版本** v0.10.0 · **变更行数** +2200 行 · **合并时间** 2026-05-21

---

## 背景

LongCat-AudioDiT 是美团自研的音频生成模型，支持两种场景：

| 场景 | 输入 | 输出 | 实测性能 |
|---|---|---|---|
| TTS（文本转语音）| 文本 | 语音 | RTF=0.66x（5.21s 音频，耗时 3.4s）|
| Voice Cloning（声音克隆）| 文本 + 参考音频 | 克隆声音 | RTF=0.30x（6.66s 音频，耗时 2.0s）|

RTF（Real-Time Factor）< 1 表示生成速度快于实时播放，0.30x 意味着生成一秒音频只需 0.3 秒。

和之前支持的图像 DiT（LongCat-Image/Edit）相比，AudioDiT 有几处结构上的根本差异：

- **VAE 对象不同**：图像走 2D VAE（空间压缩），音频走 1D WAV-VAE（时序压缩，降采样比 2048×）
- **文本编码器不同**：图像用 Qwen2.5-VL，音频用 **UMT5**（google/umt5-base）
- **去噪 ODE 不同**：图像走 FlowMatch 调度器（Euler），音频直接在 pipeline 内嵌一个 Euler 积分循环
- **引导方式不同**：图像用 CFG/CFG Renorm，音频支持标准 CFG 和 **APG**（Adaptive Projected Guidance）

本 PR 新增了约 2200 行代码，包含 3 个新文件和大量跨层的修改。

---

## 架构总览

```
LongCatAudioDiTPipeline
├── AudioDiTVae           ← WAV-VAE（音频↔latent，float16）
│   ├── VaeEncoder        ← 5 级下采样，SnakeBeta + weight_norm conv
│   └── VaeDecoder        ← 5 级上采样，SnakeBeta + ConvTranspose1d
├── AudioDiTTransformer   ← DiT 骨干（24 块，float32）
│   ├── AudioTimestepEmbedding   ← 正弦 + MLP(SiLU)
│   ├── AudioEmbedder ×3         ← latent / text / latent_cond 投影
│   ├── AudioConvNeXtV2Block ×4  ← 文本序列 1D 卷积精炼
│   ├── AudioDiTBlock ×24        ← Self-Attn + Cross-Attn + FFN
│   │   └── global AdaLN         ← 统一时步调制，per-block 偏移
│   └── long-skip connection     ← repa_layer=8 处 + 尾部各加一次
└── UMT5TextEncoder       ← UMT5-base，float32
    └── UMT5EncoderModel  ← 12 块，每块独立 relative position bias
```

去噪过程：Euler ODE，`t ∈ [0, 1]`，inline 在 `forward()` 中，无外部调度器。

---

## 前置知识

### SnakeBeta 激活

WAV-VAE 的 encoder/decoder 不用 ReLU/GELU，而用 SnakeBeta——一种带有**可学习频率**的周期激活函数：

```
f(x) = x + (1/β) · sin(αx)²
```

其中 α、β 都是 per-channel 可学习参数，以 log-scale 存储：

```cpp title="xllm/models/dit/transformers/transformer_longcat_audiodit.h — AudioSnakeBeta"
torch::Tensor forward(const torch::Tensor& x) {
  // x: (B, C, T)
  torch::Tensor alpha = alpha_.unsqueeze(0).unsqueeze(-1);
  torch::Tensor beta  = beta_.unsqueeze(0).unsqueeze(-1);
  if (alpha_logscale_) {
    alpha = torch::exp(alpha);
    beta  = torch::exp(beta);
  }
  return x + (1.0 / (beta + 1e-9f)) * torch::sin(x * alpha).pow(2);
}
```

相比 ELU，SnakeBeta 在音频信号的高频周期成分上拟合更好——这是语音合成模型的常见选择（也见于 BigVGAN）。

### UMT5 vs T5

UMT5（Universal Multilingual T5）和 T5 的结构差异集中在 **relative position bias**：

| 特性 | T5 | UMT5 |
|---|---|---|
| relative_attention_bias | 只有 block 0 有 | **每个 block 独立拥有** |
| position_bias 跨 block 传递 | 是（block 0 算好传给所有 block）| 否（每 block 自己算）|
| forward 签名 | 接受/返回 position_bias | 不传递 position_bias |

这意味着 UMT5 的每个注意力层都独立维护一套 bias 查找表，计算量更大但表达能力更强。xLLM 用 `UMT5LayerSelfAttention` 封装了这个差异，复用了已有的 `T5Attention` 组件：

```cpp title="umt5_encoder.h — 每块独立 bias 的关键"
// UMT5: every self-attention layer has its own relative_attention_bias.
self_attention_ = register_module(
    "SelfAttention",
    T5Attention(context, /*has_relative_attention_bias=*/true));  // 每层都 true
```

### APG（Adaptive Projected Guidance）

APG 是 CFG 的改进版本，核心思想：不直接用 `cond - uncond` 作为引导方向，而是把这个差向量**投影到条件预测的正交分量**，再用 momentum buffer 平滑历史梯度：

```
diff = pred_cond - pred_uncond                     # 引导方向
diff = running_average(diff)                        # 动量平滑（momentum=-0.3）
diff_parallel, diff_orthogonal = project(diff, pred_cond)
update = diff_orthogonal + η * diff_parallel       # η=0.5
result = pred_cond + scale * update
```

正交分量携带的是"方向上的差异"而不是"幅度上的差异"，减少了 CFG 在高 scale 时的伪影问题。

---

## 实现

### WAV-VAE：音频压缩基础设施

WAV-VAE 将原始波形（24kHz, 单声道）压缩到 latent 空间，**降采样比为 2048×**（5 级 stride 相乘：2×4×4×8×8=2048）。1 秒音频在 24kHz 采样率下是 24000 帧，压缩后只有 24000/2048 ≈ 12 个 latent 帧。

**Encoder 结构**（5 级）：

```
in_conv(1→128, k=7)
→ EncoderBlock(128→256, stride=2)    ← 3×ResUnit + SnakeBeta + stride conv
→ EncoderBlock(256→512, stride=4)
→ EncoderBlock(512→1024, stride=4)
→ EncoderBlock(1024→2048, stride=8)
→ EncoderBlock(2048→2048, stride=8)  ← c_mults=[1,2,4,8,16], channels=128
→ out_conv(2048→128, k=3)            ← 128 = encoder_latent_dim = 2×64
```

Encoder 输出 128 维，然后 VAE bottleneck 分为均值（64 维）和对数方差（64 维），采样：

```cpp title="AudioDiTVaeImpl::encode — VAE 采样"
std::vector<torch::Tensor> chunks = enc_out.chunk(2, 1);
torch::Tensor mean = chunks[0];
torch::Tensor scale_param = chunks[1];
torch::Tensor stdev = torch::nn::functional::softplus(scale_param, ...) + 1e-4f;
torch::Tensor noise = torch::randn_like(mean);
torch::Tensor latents = noise * stdev + mean;
return latents / scale_;  // scale_=0.71，归一化 latent 分布
```

Decoder 镜像结构。VAE 在 float16 精度下运行（显存更省），推理时通过 `to_half()` 手动转换。

**Shortcut 设计**：每级 EncoderBlock 有 residual shortcut，用 `pixel_unshuffle_1d` 做 1D 下采样再平均——这是音频 VAE 中常见的梯度捷径设计，避免信息在多层卷积后完全丢失：

```cpp title="pixel_unshuffle_1d — 1D 信号下采样"
// (B, C, W) -> (B, C*factor, W/factor) -> 平均回 (B, out_C, W/factor)
inline torch::Tensor pixel_unshuffle_1d(const torch::Tensor& x, int64_t factor) {
  int64_t b = x.size(0), c = x.size(1), w = x.size(2);
  return x.view({b, c, w / factor, factor})
           .permute({0, 1, 3, 2}).contiguous()
           .view({b, c * factor, w / factor});
}
```

**weight_norm 重建**：官方 Python 模型使用 PyTorch weight_norm，checkpoint 中存储的不是普通权重 `weight`，而是 `weight_g`（模长）和 `weight_v`（方向）。`load_module_from_state_dicts` 第一遍扫描收集所有 `weight_g/weight_v` 对，再做二次重建：

```cpp title="weight_norm 重建逻辑"
// effective_weight = g * v / ||v||_per_output_channel
torch::Tensor v_norm = v.view({c_out, -1}).norm(2, 1, /*keepdim=*/true);
std::vector<int64_t> norm_shape(v.dim(), 1);
norm_shape[0] = c_out;
v_norm = v_norm.view(norm_shape);
torch::Tensor w = g * v / (v_norm + 1e-12f);
```

### AudioDiT Transformer：全局 AdaLN + 长跳连接

AudioDiT Transformer 有 24 个 Block，每个 Block 包含 Self-Attention + Cross-Attention + FFN，配置上有两个关键选项：

**全局 AdaLN（Global Adaptive LayerNorm）**

不同于每个 Block 独立跑一个 MLP 来计算 scale/shift（`adaln_type="local"`），全局模式只用一个 `adaln_global_mlp` 计算基础调制向量，再让每个 Block 加上自己的可学习偏移 `adaln_scale_shift`：

```cpp title="AudioDiTTransformerImpl::forward — 全局 AdaLN"
// 只跑一次 MLP
adaln_mlp_out = adaln_global_mlp_->forward(norm_cond);  // (B, dim*6)

// 每个 Block 使用：
// adaln_out = adaln_global_out + adaln_scale_shift_.unsqueeze(0)
// → 避免 24 次独立 MLP 前向，节省约 24x MLP 开销
```

`norm_cond = timestep_emb + text_mean`——文本均值（按有效 token 数归一化）与时步嵌入相加，让 AdaLN 感知文本全局信息。

**长跳连接（Long Skip Connection）**

模型在 `repa_layer=8` 处和末尾各添加一次 `x = x + x_clone`：

```cpp title="AudioDiTTransformerImpl::forward — 双重长跳"
if (long_skip_) x_clone = x.clone();

for (int64_t i = 0; i < depth_; ++i) {
  x = dit_blocks_[i]->forward(...);
  // 第 7 个 block（index=7）执行后提前加一次
  if (long_skip_ && repa_layer_ > 0 && i == repa_layer_ - 1) {
    x = x + x_clone;
  }
}
// 所有 block 后再加一次
if (long_skip_) x = x + x_clone;
```

`x_clone` 是进入 transformer block 之前的 latent 快照。两次相加实现了从输入到第 8 块、从第 8 块到尾部的两段长跳，有助于低频信息流（基础音色/节奏）绕过深层 block 直接影响输出。

**Cross-Attention 的 NaN 防护**

CFG 的 unconditional pass 使用全零文本嵌入，但 cross-attention 里 `softmax` 在 all-masked 时会产生 `0/0=NaN`：

```cpp title="AudioCrossAttentionImpl::forward — nan_to_num 防护"
// nan_to_num(0): when all keys are masked, every score is -inf
// and softmax produces NaN. Replace with 0.
torch::Tensor weights =
    torch::nan_to_num(
        torch::softmax(scores.to(torch::kFloat32), -1), 0.0)
        .to(q.dtype());
```

用 `torch::nan_to_num(…, 0.0)` 把 NaN 替换为 0，这样全零掩码时 cross-attention 输出就是零向量——而不是 NaN 传染整个前向。

**手动 Attention（规避 cuDNN 后端）**

Self-Attention 和 Cross-Attention 都不用 `torch::scaled_dot_product_attention`，原因是：

```cpp
// Manual attention to avoid torch::scaled_dot_product_attention dispatch,
// which may select the cuDNN backend (unsupported for AudioDiT head_dim).
double scale = 1.0 / std::sqrt(static_cast<double>(head_dim));
torch::Tensor scores = torch::matmul(q, k.transpose(-2, -1)) * scale;
```

AudioDiT 的 `head_dim = dim / heads = 1536 / 24 = 64`——这个尺寸虽然是 2 的幂次，但某些 cuDNN flash 路径的实现对 head_dim 有附加约束（类似 PR #957 中 Qwen vision `head_dim=80` 的问题）。显式写 matmul 保证了跨平台的正确性。

### 文本编码的五处工程细节

**1. EOS token 手动追加**

SentencePiece tokenizer 不会自动添加 EOS，但 HuggingFace AutoTokenizer 会。xLLM 使用 SentencePiece，必须手动追加：

```cpp title="pipeline_longcat_audiodit.h — 手动追加 EOS"
if (!tokens.empty()) {
  tokens.push_back(1);  // EOS token id for UMT5 / SentencePiece
}
```

**2. 按实际长度截断，不送满 512**

Padding 到 512 再送 T5 会导致问题：线性层的 bias 在 padding 位置也会产生非零输出，ConvNeXtV2 的 depthwise conv 也会把 bias 泄漏到相邻位置，cross-attention 会把 487 个无效 token 也纳入计算。

```cpp title="encode_text — 截断到实际长度"
int64_t actual_len =
    attention_mask.to(torch::kLong).sum(1).max().item<int64_t>();
torch::Tensor ids = input_ids.slice(1, 0, actual_len);
return text_encoder_->forward(ids);
```

**3. CFG unconditional 用真实 mask，不用 all-False**

直觉上 unconditional pass 应该全部 mask 掉文本——但实际上不行：

```cpp title="CFG unconditional 策略"
// Python reference: neg_text=zeros with cond_mask=text_mask (the real mask).
// AudioDiTEmbedder's two masked_fills only zero out *padding* positions,
// so the linear-bias output on real positions remains non-zero.
// Using an all-False mask would zero the entire text embedding and diverges.
torch::Tensor neg_text      = torch::zeros_like(text_condition);
torch::Tensor neg_text_mask = attention_mask;  // 使用真实 mask，非全 False
torch::Tensor neg_text_len  = text_len.clone();  // 保持除数非零
```

原因：`AudioEmbedder` 内部的 `masked_fill` 只对 padding 位置置零；真实 token 位置经过 Linear 的 bias 后仍然非零。如果用 all-False mask，zero text 的归一化除数变为 0，global AdaLN 的 text_mean 会产生 NaN 或异常大的值。

**4. UMT5TextEncoder 的双重 layer_norm**

官方 Python 的 `AudioDiTModel.encode_text()` 做了额外处理，不只是返回最后的 hidden state：

```cpp title="UMT5TextEncoderImpl::forward — last_hidden + first_hidden"
// Match official Python AudioDiTModel.encode_text():
//   emb = F.layer_norm(last_hidden_state, ...) 
//   first_hidden = F.layer_norm(embed_tokens(input_ids), ...)
//   return (emb + first_hidden).float()
torch::Tensor last_hidden  = torch::layer_norm(umt5_out, {d_model_}, {}, {}, 1e-6f);
torch::Tensor embed_out    = umt5_->get_input_embeddings()->forward(input_ids);
torch::Tensor first_hidden = torch::layer_norm(embed_out.to(torch::kFloat32), {d_model_}, {}, {}, 1e-6f);
return last_hidden + first_hidden;
```

把最终隐态和词嵌入层归一化后相加，相当于给编码器加了一条跳跃连接，保留了词嵌入的词汇信息。

**5. checkpoint key 的点→下划线翻译**

libtorch 不允许 `register_module` 的名字含有点，但 checkpoint 里的 key 通常是 `"layers.0.weight"`、`"to_out.0.weight"` 这样的格式。`checkpoint_key_to_cpp_key()` 专门处理"`.`后跟数字"的情况：

```cpp title="checkpoint_key_to_cpp_key"
inline std::string checkpoint_key_to_cpp_key(const std::string& key) {
  std::string result;
  for (size_t i = 0; i < key.size(); ++i) {
    if (key[i] == '.' && i + 1 < key.size() && std::isdigit(key[i + 1])) {
      result += '_';  // "layers.0" → "layers_0"
    } else {
      result += key[i];
    }
  }
  return result;
}
```

这个函数只替换"点后紧跟数字"的情况，保留模块间的 `.` 分隔符不变，精确区分了两种点的语义。

### Voice Cloning：prompt 音频的编码与混合

Voice Cloning 的核心机制：用参考音频的 latent 作为条件，在每个去噪步中将噪声 latent 的前几帧与参考音频 latent 混合。

**参考音频编码**：

```cpp title="encode_prompt_audio — 编码参考音频"
// Extra offset padding: official Python adds 3 frames of padding before encoding,
// then trims them off after.
wav = torch::nn::functional::pad(wav, PadFuncOptions({0, full_hop * kOffset}));
torch::Tensor latent = vae_->encode(wav);  // (B, 64, T')
if (kOffset != 0) {
  latent = latent.slice(2, 0, latent.size(2) - kOffset);  // 去掉 3 帧
}
int64_t prompt_frames = latent.size(2);
return {latent.permute({0, 2, 1}), prompt_frames};  // (B, prompt_frames, 64)
```

`kOffset=3` 的作用：VAE encoder 的卷积核在边界处有填充效应，预先加 3 帧 padding 后再编码，最终截掉末尾 3 帧，得到更干净的边界。

**去噪循环中的帧混合**：

```cpp title="Euler 循环 — prompt 帧混合"
if (prompt_dur > 0) {
  // 在时间 t 处，prompt 帧是 (1-t)*noise + t*latent_cond 的线性插值
  // t=0 时全是噪声，t=1 时全是真实 latent
  torch::Tensor blended = prompt_noise * (1.0f - t_val)
                        + latent_cond.slice(1, 0, prompt_dur) * t_val;
  y.slice(1, 0, prompt_dur) = blended;
}
```

每步把前 `prompt_dur` 帧替换为"当前噪声到参考 latent 的线性插值"。这样 transformer 在每一步都能"看到"一个与参考音频特征一致的条件，从而学到参考说话人的音色。

**APG 只作用于生成帧**：

APG 引导时需要把 prompt 帧排除在外，只对生成部分做投影：

```cpp title="APG 引导 — 仅生成帧"
torch::Tensor x_s      = y.slice(1, prompt_dur);       // (B, gen_frames, D)
torch::Tensor pred_s   = pred.slice(1, prompt_dur);
torch::Tensor null_s   = null_pred.slice(1, prompt_dur);
// 在生成帧上做 APG
torch::Tensor apg_out  = apg_forward(pred_sample, null_sample, cfg_strength, ...);
// 再 pad 回包含 prompt 帧的完整长度（prompt 帧部分填 0）
guided_pred = torch::nn::functional::pad(apg_velocity,
    PadFuncOptions({0, 0, prompt_dur, 0}));
```

### 自动时长估计

当用户不传 `audio_duration_frames` 时，pipeline 根据文本字符数估算合适的时长：

```
中文字符：0.21 秒/字
英文字符：0.082 秒/字  (kEnDurPerChar)
混合规则：以 CJK/ASCII 数量多的那类为主
上限：30 秒
```

Voice Cloning 时还有额外的 ratio 调整：

```
ratio = clip(prompt_time / approx_prompt_duration, 1.0, 1.5)
dur_sec *= ratio  # 参考音频比预估短时说话慢，相应延长生成时长
```

### 模型加载：Flat / Component 双布局

xLLM 对 AudioDiT 支持两种模型文件布局：

| 布局 | 文件结构 | 适用场景 |
|---|---|---|
| **Component** | `transformer/`、`vae/`、`text_encoder/` 各自一个目录 | 标准分组模型 |
| **Flat** | 根目录 `model.safetensors`，key 有 `transformer./vae./text_encoder.` 前缀 | 一体化权重文件 |

`load_module_from_state_dicts` 通过 `key_prefix` 参数支持 Flat 布局：

```cpp title="Flat 布局加载示意"
load_module_from_state_dicts(*flat_loader, transformer_.ptr().get(), "transformer.");
load_module_from_state_dicts(*flat_loader, vae_.ptr().get(), "vae.");
text_encoder_->load_model_from_state_dicts(
    flat_loader->get_state_dicts());  // 内部用 "text_encoder." 前缀
```

Transformer 和 UMT5 运行在 float32，VAE 运行在 float16——这与官方 Python 的 `model_half=True` 对 VAE 的处理一致。

### 服务层集成

HTTP 请求路径：

```
POST /v1/audio/generations
  → APIService::AudioGenerationHttp()
  → AudioGenerationServiceImpl::process_async()
  → DiTMaster::handle_request()
  → LongCatAudioDiTPipeline::forward()
  → AudioGenerationServiceImpl::send_result_to_client_brpc()
      → Base64 编码波形 → JSON 响应
```

`AudioGenerationServiceImpl` 和 `ImageGenerationServiceImpl` 共用同一个 `DiTMaster`，在 `service_impl_factory.cpp` 的工厂 lambda 中同时实例化：

```cpp title="service_impl_factory.cpp — 共用 DiTMaster"
auto dit_master = dynamic_cast<DiTMaster*>(master);
image_generation_service_impl_ =
    std::make_unique<ImageGenerationServiceImpl>(dit_master, ...);
audio_generation_service_impl_ =
    std::make_unique<AudioGenerationServiceImpl>(dit_master, ...);
```

图像和音频请求共享同一个 DiT 服务实例，由 model_type（`"audiodit"` vs `"LongCat-Image"` 等）在 pipeline 层面区分处理。

---

## 意义与影响

这个 PR 的意义在于把 xLLM 的 DiT 基础设施从**图像生成**拓展到了**音频生成**，验证了同一套 master/worker/scheduler/service 架构对不同模态的适配能力。

几个值得记录的工程决策：

**`checkpoint_key_to_cpp_key` 的精确范围**：只替换"点后跟数字"的情况（保留模块间分隔符），而不是全局替换所有点。这个细节保证了 `encoder.block.0.layer.0.weight` → `encoder.block_0.layer_0.weight` 的正确翻译，不会误伤 `some.module.weight` 中的结构性点。

**全局 AdaLN 的计算效率**：24 个 block 共用一次 MLP 前向，再各自加可学习偏移。相比 local 模式节省了 23 次 MLP 计算，同时通过 per-block `adaln_scale_shift` 参数保持了各 block 的独立调制能力。

**双重长跳（repa_layer=8 + 尾部）**：这是 AudioDiT 特有的设计，来自官方 Python 实现中的 `repa_dit_layer` 参数。第一次跳连在 block 7 之后发生（让低层特征直接影响中层），第二次在所有 block 之后（让输入直接融合进最终输出）。

**Voice Cloning 的 batch 限制**：`dit_batch.cpp` 的注释说明了当前不支持 batch Voice Cloning 的原因——不同请求的 `prompt_audio` 长度各不相同，无法简单 stack 成一个 batch tensor，属于有意为之的暂时限制。

---

## 参考

- [LongCat-AudioDiT 官方实现](https://github.com/meituan-longcat/LongCat-AudioDiT/blob/main/audiodit/modeling_audiodit.py)
- [APG: Adaptive Projected Guidance（arXiv 2410.02416）](https://arxiv.org/abs/2410.02416)
- [SnakeBeta / BigVGAN](https://arxiv.org/abs/2206.04658)
- [UMT5 (HuggingFace Transformers)](https://github.com/huggingface/transformers/tree/main/src/transformers/models/umt5)
