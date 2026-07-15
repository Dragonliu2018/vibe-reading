---
title: "在 CUDA 上支持 Cola-DLM 文本扩散"
source:
  project: "xLLM"
  type: "PR"
  id: "1539"
  url: "https://github.com/xLLM-AI/xllm/pull/1539"
  prType: "feat"
date: "2026-07-08"
category: [AI, 推理, xLLM, Contributions]
tags: ["Cola-DLM", "Diffusion", "文本生成", "VAE", "DiT", "KV Cache", "Block Causal Mask"]
description: "为 xLLM 实现 ByteDance Cola-DLM 连续潜在扩散语言模型 CUDA 支持：TextVAE 编码 token 到潜在空间、block-wise 潜在先验传输 + CFG + Euler 积分、DiT 与 VAE 共享 KV cache 的分块生成、以及 block-causal 注意力掩码的整数除法陷阱。"
readingTime: "18 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1539](https://github.com/xLLM-AI/xllm/pull/1539) · **Issue** - · **commit** [cc3e400](https://github.com/xLLM-AI/xllm/commit/cc3e400) · **首发版本** -（PR 未合并）· **变更行数** +3957 行 · **合并时间** -

---

## 背景

Cola-DLM（Continuous Latent Diffusion Language Model）是 ByteDance Seed 提出的**潜在扩散语言模型**——它不走传统自回归"逐 token 预测"的路线，而是先把 token 序列压缩到连续潜在空间，再在潜在空间里用扩散过程一次生成一整块（block）的 token。

本 PR 把 Cola-DLM 接入 xLLM 的 DiT 框架（此前已支持图像/音频 DiT），实测在 A800-40GB 上跑通：

```
Prompt: Question: What is the capital of France? Answer:
Output:  Paris ...
```

相比之前接入的图像/音频 DiT，Cola-DLM 有几个独特之处：

- **文本 VAE 而非卷积 VAE**：编码器/解码器都是 transformer，把 token id 映射到潜在向量、再把潜在向量解码回 token 概率
- **block-wise 分块生成**：latent 按 `block_size` 分块，每块独立跑扩散，块之间靠 KV cache 传递上下文
- **block-causal 注意力**：块内有完整双向注意力，块间严格因果——这种掩码用整数除法定义，有一个浮点提升的陷阱
- **DiT 和 VAE 解码器共享 KV cache 语义**：两个网络都支持 prefix prefetch + 分块增量

PR 新增约 4000 行，6 个核心新文件。下文按"VAE → DiT → pipeline 三步推理 → block-causal 掩码 → KV cache → 服务层"的顺序拆解。

---

## 前置知识

### 潜在扩散语言模型

传统 LLM：`token → embedding → 自回归 → token`，每步生成 1 个 token。

Cola-DLM：`token → VAE.encode → latent → 扩散去噪 → latent → VAE.decode → token`，每次扩散生成一个 block（如 16 个 latent，对应 `block_size × patch_size` 个 token）。

VAE 在这里承担"离散 token ↔ 连续 latent"的桥接，是扩散能作用在连续空间的前提。

### Classifier-Free Guidance（CFG）

扩散模型的标准引导技巧：同时跑条件（带 prompt）和无条件（空 prompt）前向，按 `guidance_scale` 加权：

```
drift = drift_uncond + guidance_scale × (drift_cond - drift_uncond)
```

Cola-DLM 在每个 Euler 步都做一次 cond + uncond 两次 DiT 前向。

### Block-wise 生成与 KV cache

Cola-DLM 不是一次性对全长序列扩散，而是**分块**：

```
block 0: [prompt_latents | gen_block_0]   → 扩散 → 解码 → 得到 token 块 0
block 1: [cache(prefix+block0) | gen_block_1] → 扩散 → 解码 → token 块 1
...
```

每生成一块，把这块的 K/V 追加进 cache，下一块就能"看见"前序所有块。这要求 DiT 和 VAE 解码器都支持 KV cache 的增量更新。

---

## 实现

### TextVAE：token ↔ latent 的 transformer 桥梁

`autoencoder_text_vae_cola.h` 实现了 `ColaTextVAEModel`，包含 encoder 和 decoder 两个 transformer 栈。和图像 VAE 的卷积栈不同，这里全是 attention block。

**encode**：token id → embedding → encoder blocks → latent

```cpp title="xllm/models/dit/autoencoders/autoencoder_text_vae_cola.h（encode 签名）"
std::pair<torch::Tensor, std::vector<int64_t>> encode(
    const std::vector<torch::Tensor>& input_ids_list) {
  // ... embedding + encoder blocks
  // 关键：encoder 使用 block-causal mask（无 padding，NA flatten-concat 布局）
  attn_mask = create_block_causal_mask(k_lens, q_lens, block_size, ...);
  // ...
  return {latents, sample_lens};  // latents: (n_patches, latent_dim)
}
```

**decode**：latent → decoder blocks → token logits，支持 KV cache 增量更新：

```cpp title="xllm/models/dit/autoencoders/autoencoder_text_vae_cola.h（decode 语义）"
// update_kv:   append current K/V to cache, read full cache as K/V
//              (False by default — VAE encode blocks never cache)
// use_kv_cache: prepend cached K/V to current K/V
torch::Tensor decode(const torch::Tensor& latents,
                     const std::vector<int64_t>& k_lens,
                     const std::vector<int64_t>& q_lens,
                     bool update_kv = false);
```

VAE 的 RoPE 用 `theta=500000`（DiT 用 `theta=10000`），两者分别配置：

```cpp title="VAERotaryEmbedding — 与 DiT 不同的 theta"
explicit VAERotaryEmbeddingImpl(int64_t dim, int64_t theta = 500000)
```

VAE 的 block 还用 **SwiGLU** 激活（`silu(gate) * x`），这是 Cola 官方实现的选择。

### ColaDiTTransformer：带 AdaLN 的扩散骨干

`transformer_cola_dit.h` 实现扩散去噪网络。核心组件：

- **Sinusoidal Timestep Embedding**：diffusers 风格，`flip_sin_to_cos=False`，分母用 `half_dim`（不是 `half_dim-1`）
- **ColaDiTRotaryEmbedding**：复现官方 `rotary_embedding_torch` 的"每个元素不同角度"语义
- **AdaLN**：自适应 LayerNorm，shift/scale 调制 + gate 调制（"in" mode）
- **ColaDiTAttention**：核心 attention，支持 KV cache 的三种模式

#### Attention 的三种 KV cache 模式

`ColaDiTAttention::forward` 通过 `update_kv` 和 `use_kv_cache` 两个布尔参数区分三种行为：

```cpp title="xllm/models/dit/transformers/transformer_cola_dit.h（KV cache 三模式）"
if (update_kv) {
  // 模式 1：追加当前 K/V 到 cache，再读完整 cache 作为 K
  // 用于 prefix prefetch 和 block 生成完成后的提交
  k_cache_[i] = torch::cat({k_cache_[i], new_ks[i]}, 0);
  full_k = torch::cat(full_ks, 0);  // 完整 cache
} else if (use_kv_cache && !k_cache_.empty()) {
  // 模式 2：把 cache 拼到当前 K 前面，但不修改 cache
  // 用于 Euler 循环内的多次前向（同一块的 cond/uncond 反复读 prefix）
  full_k = torch::cat({k_cache_[i], new_ks[i]}, 0);
} else {
  // 模式 3：无 cache，K = 当前 Q 投影（unconditional pass）
  full_k = txt_k;
}
```

这三种模式覆盖了推理的全部场景：prefill 用模式 1 写 cache，Euler 循环用模式 2 只读 cache，unconditional 路径用模式 3 完全独立。

#### RoPE 的位置偏移

Q 和 K 的 RoPE 位置不同——K 从 0 开始（完整序列），Q 从 `k_len - q_len` 开始（K 的尾部）：

```cpp title="Q/K 的 RoPE 位置错位"
// K positions: [0, k_lens[i]) for each sample i.
// Q positions: [k_lens[i] - q_lens[i], k_lens[i]) — tail of K.
int64_t q_offset = k_lens[i] - q_lens[i];
auto [cq, sq] = rope_->get_cos_sin(q_lens[i], q_offset, txt.device());
```

这保证了 query 和它对应的 key 在 RoPE 旋转后的相对位置一致。

### Pipeline：三步推理算法

`pipeline_cola_dlm.h` 的 `forward()` 实现官方 `generate_task_repaint_inference()` 的三步算法：

#### Step 1-2：tokenize + VAE encode

```cpp title="xllm/models/dit/pipelines/pipeline_cola_dlm.h（encode + latent labels）"
// Step 2: VAE encode（bf16 autocast）
torch::autocast::set_autocast_dtype(torch::kCUDA, torch::kBFloat16);
torch::autocast::set_autocast_enabled(torch::kCUDA, true);
auto [latents, sample_lens] = vae_->encode(input_ids_list);
torch::autocast::set_autocast_enabled(torch::kCUDA, false);
latents = latents.to(torch::kFloat32);  // 匹配 Python .float()

// Step 3: latent labels（1=real, 2=first-block-prompt, 3=padding）
// patch_size > 1 时按 patch 聚合 token labels
if (patch_size > 1) {
  auto reshaped = token_labels.reshape({n_patches, patch_size});
  auto c1 = reshaped.eq(1).any(-1);  // 该 patch 含真实 token
  auto c2 = reshaped.eq(2).any(-1);  // 该 patch 含首块 prompt
  latent_labels = torch::full({n_patches}, 3, ...);
  latent_labels.masked_fill_(c2, 2);
  latent_labels.masked_fill_(c1, 1);
}
```

#### Step 4a：prefix prefetch——把前缀 K/V 预写入 cache

这是性能关键：prefix（prompt 对应的 latent）在所有 block 生成都要用，提前一次写入 cache，后续 Euler 循环里直接读：

```cpp title="prefix prefetch 到 DiT 和 VAE 的 cache"
dit_->set_kv_cache(true);
vae_->set_kv_cache(true);

if (prefix_len > 0) {
  // DiT prefix prefetch at timestep=0
  auto ts_prefix = torch::zeros({prefix_len}, ...);
  dit_->forward(prefix_latents.to(torch::kBFloat16),
                /*k_lens=*/{prefix_len}, /*q_lens=*/{prefix_len},
                ts_prefix,
                /*update_kv=*/true,    // 写入 cache
                /*use_kv_cache=*/true);

  // VAE decoder prefix prefetch
  vae_->decode(prefix_latents,
               /*k_lens=*/{prefix_len}, /*q_lens=*/{prefix_len},
               /*update_kv=*/true);    // 写入 VAE cache
}
```

#### Step 5：block-wise 生成循环

外层按 block 迭代，内层是 Euler 积分 + CFG：

```cpp title="block 生成循环（核心结构）"
for (int64_t block_idx = 0; block_idx < max_blocks; ++block_idx) {
  k_len_cum += block_size;  // 累积 K 长度

  // 画初始 block 噪声
  torch::Tensor txt = torch::randn({block_size, latent_dim}, ...);

  // --- Euler 积分 ---
  for (int64_t t_idx = 0; t_idx < diffusion_steps; ++t_idx) {
    float t_curr = timesteps[t_idx].item<float>();
    float dt = (t_curr - timesteps[t_idx+1]) / kTimestepScale;

    // block 0 clean-guidance：把 prompt 位置钉在真实 latent，timestep 设 0
    if (block_idx == 0 && first_block_prompt_tokens > 0) {
      txt.slice(0, 0, first_block_prompt_tokens) =
          first_block_latents.slice(0, 0, first_block_prompt_tokens);
    }

    // cond + uncond 两次 DiT 前向（bf16 autocast）
    drift_cond = dit_->forward(txt, k_lens_cond, q_lens, ts_tensor,
                               /*update_kv=*/false, /*use_kv_cache=*/true);
    drift_uncond = dit_->forward(txt, k_lens_uncond, q_lens, ts_tensor,
                                 /*update_kv=*/false, /*use_kv_cache=*/false);

    // CFG 组合（bf16）+ Euler 更新（fp32）
    auto drift_bf16 = block_cfg_scale * (drift_cond - drift_uncond) + drift_uncond;
    txt = txt - drift_bf16.to(torch::kFloat32) * dt;

    // Euler 步后重新钉住 prompt 位置
    if (block_idx == 0 && first_block_prompt_tokens > 0) {
      txt.slice(0, 0, first_block_prompt_tokens) =
          first_block_latents.slice(0, 0, first_block_prompt_tokens);
    }
  }

  // VAE 解码当前 block（update_kv=true 提交到 cache）
  auto decoded = vae_->decode(txt, k_lens_cond, q_lens, /*update_kv=*/true);
  // ... token 采样（见下文）
}
```

几个精妙之处：

**block 0 的 clean-guidance**：第一个生成块里可能还含 prompt token（因为 `num_real % block_size != 0` 时首块混合 prompt + gen）。这些 prompt 位置在每一步 Euler 前后都被**强制钉回真实 latent**，且 timestep 设为 0（"已干净"），不参与扩散。

**CFG 的 block 0 退化**：当 `prefix_len == 0`（无 prompt）时，cond 和 uncond 完全相同，CFG 只是放大 bf16 噪声，因此 `cfg_scale_block0 = 1.0` 退化掉。

**bf16/fp32 精度边界**：DiT 前向在 bf16 autocast 下跑（匹配官方），但 latent `txt` 始终是 fp32——CFG 组合在 bf16 算，Euler 更新 `txt = txt - drift * dt` 转回 fp32 算，避免累积精度损失。

#### 噪声种子的两种模式

Cola 官方有两种推理脚本，噪声生成方式不同，本 PR 都要兼容：

```cpp title="确定性 vs 随机噪声"
const bool use_deterministic_noise = seed_is_set && (seed >= 0);
if (!use_deterministic_noise) {
  // 官方 run_cola.py 风格：全局 torch.randn，每次请求不同
  uint64_t request_seed = (++forward_counter_) * 6364136223846793005ULL + ...;
  torch::cuda::manual_seed(request_seed);
}

// 每个 block 画噪声时：
if (use_deterministic_noise) {
  // 官方 run_cola_debug.py 风格：COLA_INFER_PER_SAMPLE_NOISE_SEED
  // 每 block 用 seed + sample_id*1000 + block_idx*10'000'000 派生
  uint64_t effective_seed = seed + sample_id * 1000LL + block_idx * 10'000'000LL;
  noise_gen.set_current_seed(effective_seed);
  txt = torch::randn({block_size, latent_dim}, noise_gen, ...);
} else {
  txt = torch::randn({block_size, latent_dim}, ...);  // 全局 RNG
}
```

确定性模式用 `CUDAGeneratorImpl` + 派生 seed，可复现；随机模式用全局 `manual_seed`，匹配 `run_cola.py` 的 `cola-log.txt` 风格输出。

#### token 采样：repetition penalty + top_k + top_p

VAE 解码出 `(block_tokens, vocab)` 的 logits 后，采样逻辑严格匹配官方 `sample_with_strategies()`：

```cpp title="采样三段式（顺序与官方一致）"
// 1. repetition penalty（在 temperature 之前，greedy 也生效）
if (repetition_penalty != 1.0f && !all_token_ids.empty()) {
  auto scores = torch::gather(logits_rep, 1, prev_ids_exp);
  scores = torch::where(scores < 0,
                        scores * repetition_penalty,
                        scores / repetition_penalty);
  logits_rep.scatter_(1, prev_ids_exp, scores);
}

// 2. greedy 或 temperature+top_k+top_p
if (temperature < 1e-5f) {
  block_ids = logits_rep.argmax(-1);  // greedy
} else {
  auto logits = logits_rep / temperature;
  // top_k：logit 空间截断
  if (top_k > 0) { /* torch::topk + threshold */ }
  // top_p：softmax 累积概率截断
  if (top_p > 0.0f && top_p < 1.0f) { /* sort + cumsum + masked_fill */ }
  auto probs = torch::softmax(logits, -1);
  block_ids = torch::multinomial(probs, 1).squeeze(-1);
}
```

注意 top_k 必须在 **logit 空间**截断（设 -inf），让 softmax 重新归一化，而不是在概率空间截断——这是 nucleus sampling 的正确实现。

### Block-Causal 注意力掩码：整数除法陷阱

`cola_block_causal_mask.h` 构造扩散注意力的掩码。掩码规则：**同 sample 内，query 所在 block 的索引 ≥ key 所在 block 的索引才允许 attend**。

```cpp title="xllm/models/dit/utils/cola_block_causal_mask.h（核心逻辑）"
// Q refers to the LAST q_len_b positions of K within the same sample.
q_local.narrow(0, q_cu[b], q_len_b)
    .copy_(torch::arange(k_len_b - q_len_b, k_len_b));

// ⚠️ 整数除法——必须用 trunc，不能让 int64 提升为 float
auto q_block = torch::div(q_local.unsqueeze(1), block_size, "trunc");
auto k_block = torch::div(k_local.unsqueeze(0), block_size, "trunc");
auto same_sample = q_sample.unsqueeze(1) == k_sample.unsqueeze(0);
auto block_causal = q_block >= k_block;
auto allowed = same_sample & block_causal;
```

代码里有一段关键注释，指出了一个**极易踩的坑**：

> Integer block index — MUST use truncating division (`//`), not float
> division. `q_local / block_size` on int64 promotes to float and wrongly
> applies position-wise causality inside a block.

如果直接写 `q_local / block_size`，PyTorch 会把 `int64 / int` 提升为浮点除法，得到的是逐位置的连续 block 索引——这会让**块内**也出现错误的因果性（块内 token 之间互相屏蔽），完全破坏 Cola 的注意力语义。必须用 `torch::div(..., "trunc")` 做截断整数除法，得到离散的 block 索引。

掩码构造用 `same_sample & block_causal` 两个条件：跨 sample 严格隔离（`same_sample`），同 sample 内块间因果（`block_causal`）。最终转成 additive mask（允许位置 0，禁止位置 `float::lowest`）。

### 权重加载：dot→underscore 翻译 + rope freqs 跳过

`cola_weight_loader.h` 复用了之前 LongCat-AudioDiT 的 `checkpoint_key_to_cpp_key` 模式——libtorch 不允许 `register_module` 名字含点，但 checkpoint key 用点：

```cpp title="xllm/models/dit/utils/cola_weight_loader.h"
inline std::string cola_checkpoint_key_to_cpp_key(const std::string& key) {
  // "layers.0.weight" → "layers_0.weight"（只替换点后跟数字的情况）
  for (size_t i = 0; i < key.size(); ++i) {
    if (key[i] == '.' && i + 1 < key.size() && std::isdigit(key[i + 1])) {
      result += '_';
    } else {
      result += key[i];
    }
  }
}
```

还有一类 key 要**主动跳过**——RoPE 的 `freqs` 缓冲在 C++ 里是运行时计算的，不从 checkpoint 加载：

```cpp title="跳过 rope.freqs（运行时计算）"
inline bool is_cola_ignored_checkpoint_key(const std::string& key) {
  static const std::string kRopeFreqsSuffix = ".rope.rope.freqs";
  return key.ends_with(kRopeFreqsSuffix);  // C++20 ends_with
}
```

### 模型发现：自动识别 Cola-DLM 布局

`dit_model_discovery.h` 新增了 DiT 模型的自动发现机制——扫描模型目录下的子目录，找出含 `config.json` + safetensors 的组件，再映射到已注册的 pipeline 类型：

```cpp title="xllm/core/util/dit_model_discovery.h"
inline std::optional<DitModelLayout> discover_dit_model_layout(
    const std::filesystem::path& model_path) {
  auto components = discover_dit_components(model_path);  // 扫描子目录
  if (!components) return std::nullopt;

  DitModelLayout layout;
  layout.components = std::move(*components);
  layout.pipeline_type = resolve_dit_pipeline_type(layout.components);
  // resolve 通过 component_type 集合反查 ModelRegistry
  return layout;
}
```

这样用户只需指定模型根目录，xLLM 自动识别出 `cola_dit/` + `cola_vae/` + `tokenizer` 的组合，路由到 `ColaDLMPipeline`，无需手动配置 pipeline 类型。

### 服务层：text_generation HTTP 端点

新增 `text_generation.proto` 和 `TextGenerationServiceImpl`，提供 `POST /v1/text/generation` 端点：

```protobuf title="xllm/proto/text_generation.proto"
message TextParameters {
  optional int64 seed = 1;
  optional int32 max_new_tokens = 2;
  optional int32 diffusion_steps = 3;
  optional float guidance_scale = 4;
  optional float temperature = 5;
  optional int32 top_k = 6;
  optional float top_p = 7;
  optional float repetition_penalty = 8;  // 在 temperature/top_k/top_p 之前
}
```

`TextGenerationServiceImpl` 复用 DiT master/worker 架构，和 `ImageGenerationServiceImpl` / `AudioGenerationServiceImpl` 并列注册：

```cpp title="xllm/api_service/text_generation_service_impl.h"
class TextGenerationServiceImpl final
    : public APIServiceImpl<TextGenerationCall> {
  // 和图像/音频服务共享同一个 DiTMaster
  explicit TextGenerationServiceImpl(DiTMaster* master,
                                     const std::vector<std::string>& models);
};
```

---

## 测试

PR 附带了完整的测试程序 `test_cola_dlm.py`（在 PR 描述中），覆盖两种推理模式的对照：

| 模式 | 对应官方脚本 | 噪声来源 | 可复现 |
|---|---|---|---|
| `seed=0`（默认） | `run_cola_debug.py` | `COLA_INFER_PER_SAMPLE_NOISE_SEED` 派生 | 是 |
| `--stochastic` | `run_cola.py` | 全局 `torch.randn` | 否 |

C++ 侧新增两个测试文件：
- `tests/core/framework/request/dit_request_params_test.cpp`（+314 行）：验证 `diffusion_steps`、`guidance_scale` 等新参数的解析
- `tests/models/dit/utils/cola_utils_test.cpp`（+200 行）：验证 block-causal mask、权重 key 翻译等工具函数

实测输出（seed=0，确定性模式）：

```
Prompt: Question: What is the capital of France? Answer:
Output:  Paris
         Answer: Team Paris
         Question: What is the French language? Answer: Athens
         Answer:
```

输出结构和官方 `run_cola_debug.py` 一致——首 token 是 ` Paris`，后续是模型自由续写。

---

## 意义与影响

Cola-DLM 是 xLLM 接入的**第一个文本扩散模型**，标志着框架的 DiT 基础设施从"图像/音频"扩展到了"文本"这一最重要的模态。

几个值得关注的技术点：

**block-wise KV cache 的复用**：DiT 和 VAE 解码器都用同一套 `update_kv` / `use_kv_cache` 双布尔接口管理 cache。这套接口是 PR #1784（MiMo-MTP）等已有机制的泛化——prefix prefetch 写一次、Euler 循环反复读、block 完成再追加。这套模式对任何"分块 + 扩散"的模型都适用。

**block-causal 掩码的整数除法陷阱**：这是 PyTorch 类型提升规则的一个隐蔽坑。`int64 / int` 在 PyTorch 里会提升为浮点除法，而 Cola 官方 Python 用的是 `//`（截断整数除法）。C++ 移植时必须显式用 `torch::div(..., "trunc")`，否则块内注意力会被错误地施加因果性，模型行为完全错乱但不会报错。这类"语义正确但数值错误"的 bug 极难排查——代码里的注释正是踩坑后的经验沉淀。

**bf16/fp32 精度边界管理**：DiT 前向走 bf16 autocast（匹配官方、省显存），但 latent 状态 `txt` 始终保持 fp32，Euler 更新在 fp32 做累积。这种"前向 bf16、状态 fp32"的分工是扩散模型推理的标准实践——bf16 的累积误差在多步 Euler 迭代后会显著偏移。

**两种噪声模式的兼容**：Cola 官方有两套推理脚本，噪声生成方式不同。本 PR 用 `use_deterministic_noise` 分支同时支持，并通过 `forward_counter_` 的 LCG（线性同余）为随机模式生成 per-request 种子，保证并发请求不冲突。

**模型自动发现**：`dit_model_discovery` 让用户不用写配置文件就能加载 Cola-DLM——扫描目录、识别组件、路由 pipeline 全自动。这套机制后续接入其他多组件 DiT 模型（如新的图像/视频/音频模型）时可以直接复用。

---

## 参考

- [Cola-DLM 官方仓库](https://github.com/ByteDance-Seed/Cola-DLM)
- [Cola-DLM HuggingFace 模型](https://huggingface.co/ByteDance-Seed/Cola-DLM)
- [Classifier-Free Guidance（arXiv 2207.12598）](https://arxiv.org/abs/2207.12598)
- [Denoising Diffusion Implicit Models (DDIM) / Euler 积分](https://arxiv.org/abs/2010.02502)
