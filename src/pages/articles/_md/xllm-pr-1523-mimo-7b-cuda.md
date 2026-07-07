---
title: "在 CUDA 上支持 MiMo-7B-Base 推理"
source:
  project: "xLLM"
  type: "PR"
  id: "1523"
  url: "https://github.com/jd-opensource/xllm/pull/1523"
  prType: "feat"
date: "2026-07-06"
category: [AI, 推理, xLLM, Contributions]
tags: ["MiMo", "Qwen2", "MRoPE", "MTP", "CUDA", "LLM", "推理框架"]
description: "122 行为 xLLM 添加 MiMo-7B-Base CUDA 推理：解析 LlmModelImplBase 模板复用 Qwen2 层的机制、apply_mrope 的分段选择算法、concat 格式 RoPE 缓存构建，以及 num_nextn_predict_layers 对 MTP 的支持声明。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1523](https://github.com/jd-opensource/xllm/pull/1523) · **Issue** - · **commit** [f1e9f41](https://github.com/jd-opensource/xllm/commit/f1e9f41) · **首发版本** v0.10.0 · **变更行数** +126 行 · **合并时间** 2026-06-01

---

## 背景

MiMo-7B-Base 是小米开源的推理增强型语言模型，基于 Qwen2.5 架构训练，通过强化学习在数学和代码推理任务上做了专项优化。本 PR 在 xLLM 中以 122 行新增代码完成了对它的支持——这个数字体现了 xLLM 模板化模型注册体系的复用效率。

从工程上看，支持 MiMo-7B-Base 有两处值得深入：

1. **MRoPE 支持的预留**：模型注册了 `apply_mrope()` 覆写，引入了和 Qwen2-VL 相同的分段旋转位置编码逻辑——尽管文本推理路径不会触发它；
2. **MTP 参数声明**：`num_nextn_predict_layers=1` 是 MiMo-7B 配置的特有字段，为后续的 Multi-Token Prediction 推测解码铺路。

---

## 前置知识

### `LlmModelImplBase<DecoderLayerType>` 模板

xLLM 的 LLM 模型层用一个 CRTP 风格的基类模板统一 forward 流程：

```cpp title="xllm/models/llm/llm_model_base.h（简化）"
template <typename DecoderLayerType>
class LlmModelImplBase : public torch::nn::Module {
 protected:
  torch::Tensor cos_sin_;
  std::vector<int64_t> mrope_section_;
  layer::WordEmbedding embed_tokens_{nullptr};
  layer::RMSNorm norm_{nullptr};
  std::vector<DecoderLayerType> layers_;

 public:
  virtual std::pair<torch::Tensor, torch::Tensor> apply_mrope(
      const torch::Tensor positions) {
    return {torch::Tensor(), torch::Tensor()};  // 默认空实现
  }

  virtual ModelOutput forward(...) {
    // ...
    if (positions.dim() == 2) {   // 3D positions → MRoPE 模式
      std::tie(attn_metadata.mrope_cos, attn_metadata.mrope_sin) =
          apply_mrope(positions);
    }
    for (auto& layer : layers_) {
      h = layer(h, residual, positions, attn_metadata, kv_caches[i], params);
    }
    // ...
  }
};
```

`DecoderLayerType` 作为类型参数传入，整个 forward 循环、weight loading、embedding 管理都在基类里实现。子类只需关注：(1) 用什么 Decoder Layer；(2) 是否覆写 `apply_mrope`。

### Concat 格式 RoPE 缓存

xLLM 预计算两种 RoPE 格式：

| 函数 | 格式 | 频率排列 |
|---|---|---|
| `get_concat_rotary_embedding` | concat | `[f₀, f₁, …, f_{n/2-1}, f₀, f₁, …, f_{n/2-1}]` |
| 标准 interleaved | 交错 | `[f₀, f₀, f₁, f₁, …, f_{n/2-1}, f_{n/2-1}]` |

concat 格式将频率序列**拼接两遍**（而不是交错），对应的旋转操作是 `rotate_half`（把后半段取负后和前半段拼接），interleaved 格式对应 `rotate_every_two`。Qwen2/MiMo 使用 concat 格式。

`get_concat_rotary_embedding` 返回形如 `[max_position_embeddings, 2 × head_dim]` 的缓存（cos 和 sin 沿最后一维拼接），通过位置索引可以直接查表：

```cpp title="rotary_embedding_util.cpp — compute_rotary_embedding(use_cat=true)"
if (use_cat) {
  emb = torch::cat({freqs, freqs}, -1);  // [seq_len, dim]
}
auto rope_cos = torch::cos(emb);
auto rope_sin = torch::sin(emb);
return torch::cat({rope_cos, rope_sin}, -1);  // [seq_len, 2*dim]
```

---

## 实现

### `MiMoModelImpl`：122 行的全部

MiMo-7B 和 Qwen2-7B 在 decoder layer 层面完全兼容，差异只在配置参数和 MRoPE 支持。`MiMoModelImpl` 继承 `LlmModelImplBase<layer::Qwen2DecoderLayer>`，构造函数只做三件事：

```cpp title="xllm/models/llm/mimo.h — MiMoModelImpl 构造"
explicit MiMoModelImpl(const ModelContext& context)
    : LlmModelImplBase<layer::Qwen2DecoderLayer>("mimo",
                                                  context.get_model_args()) {
  auto model_args = context.get_model_args();
  auto options = context.get_tensor_options();

  // 1. 若有 mrope_section 配置，预计算 RoPE 缓存
  if (!mrope_section_.empty()) {
    cos_sin_ = layer::rotary::get_concat_rotary_embedding(
        model_args.hidden_size() / model_args.n_heads(),  // head_dim
        model_args.max_position_embeddings(),
        model_args.rope_theta(),
        options);
  }

  // 2. 注册子模块
  norm_         = register_module("norm", layer::RMSNorm(context));
  embed_tokens_ = register_module("embed_tokens", layer::WordEmbedding(context));

  // 3. 逐层创建 Qwen2DecoderLayer
  layers_.reserve(model_args.n_layers());
  for (int32_t i = 0; i < model_args.n_layers(); i++) {
    layers_.emplace_back(layer::Qwen2DecoderLayer(context, i));
  }
}
```

`LlmForCausalLMImplBase<MiMoModel>` 封装了 lm_head 和 `load_model`，同样复用基类逻辑：

```cpp
class MiMoForCausalLMImpl final : public LlmForCausalLMImplBase<MiMoModel> {
 public:
  explicit MiMoForCausalLMImpl(const ModelContext& context)
      : LlmForCausalLMImplBase<MiMoModel>(context) {}
};
TORCH_MODULE(MiMoForCausalLM);
REGISTER_CAUSAL_MODEL(mimo, MiMoForCausalLM);
```

整个可运行模型注册完成。

### `apply_mrope`：分段选择算法

`apply_mrope` 的覆写实现了 Qwen2-VL 风格的多模态旋转位置编码。其入参 `positions` 形状为 `[3, seq_len]`，三行分别对应三个模态维度（时间 T、高度 H、宽度 W）：

```cpp title="mimo.h — apply_mrope"
std::pair<torch::Tensor, torch::Tensor> apply_mrope(
    const torch::Tensor positions) override {
  // positions: [3, seq_len]
  // cos_sin_: [max_pos, 2*head_dim]
  auto target_cos_sin = cos_sin_.index({positions});
  // → [3, seq_len, 2*head_dim]

  auto chunks = target_cos_sin.chunk(2, -1);
  auto cos_pos = chunks[0].contiguous();  // [3, seq_len, head_dim]
  auto sin_pos = chunks[1].contiguous();  // [3, seq_len, head_dim]

  auto apply = [this](torch::Tensor x) {
    // mrope_section_: e.g. {16, 24, 24}  (head_dim/2 per modality)
    auto sections = mrope_section_;
    // 将 sections 复制一遍（因为 head_dim = 2 × head_dim/2）
    sections.insert(sections.end(), sections.begin(), sections.end());
    // → {16, 24, 24, 16, 24, 24}

    auto vec = x.split(sections, -1);  // 按段切分：6 个切片
    std::vector<torch::Tensor> selects;
    for (size_t i = 0; i < vec.size(); ++i) {
      auto m = vec[i];  // [3, seq_len, section_size]
      // 取第 (i % 3) 个模态维度
      selects.emplace_back(m[i % mrope_section_.size()]);
    }
    return torch::cat(selects, -1);
  };

  cos_pos = apply(cos_pos.reshape({positions.size(0), -1, cos_pos.size(-1)}));
  sin_pos = apply(sin_pos.reshape({positions.size(0), -1, sin_pos.size(-1)}));
  return {cos_pos, sin_pos};
}
```

**分段选择的直观含义**：以 `mrope_section_ = {16, 24, 24}` 为例，`head_dim = 64`，sections 扩展为 `{16, 24, 24, 16, 24, 24}`：

| 切片索引 | 大小 | 取模态维度 | 意义 |
|---|---|---|---|
| 0 | 16 | T（0） | 前 16 个频率维度用时间位置 |
| 1 | 24 | H（1） | 接下来 24 个用高度位置 |
| 2 | 24 | W（2） | 接下来 24 个用宽度位置 |
| 3 | 16 | T（0） | cos 另一半的前 16 个 |
| 4 | 24 | H（1） | … |
| 5 | 24 | W（2） | … |

这使 attention head 内部不同的频率维度携带不同的空间信息，是多模态 RoPE 的核心技巧。

### MRoPE 何时触发

对于文本推理，`positions` 是 1D 的 `[seq_len]`（普通 token 序列位置），基类 `forward` 里的判断：

```cpp
if (positions.dim() == 2) {  // 2 对应 [3, seq_len] 形状
  std::tie(attn_metadata.mrope_cos, attn_metadata.mrope_sin) =
      apply_mrope(positions);
}
```

`positions.dim() == 1`，所以 `apply_mrope` **不会被调用**。MiMo-7B-Base 文本推理走的是和 Qwen2 完全相同的标准 RoPE 路径，MRoPE 覆写只是预留接口。

> Gemini bot 在 review 中标记了一个"critical issue"：`REGISTER_MODEL_ARGS(mimo, ...)` 中没有 `LOAD_ARG(rope_scaling_mrope_section, ...)` 的调用，导致 `mrope_section_` 永远为空，`cos_sin_` 也不会被构建。对于纯文本推理场景，这是安全的——`apply_mrope` 不会被调用，空的 `cos_sin_` 也不会被访问。但如果未来需要把 MiMo 接入多模态管线，需要补上这个参数的加载。

### 模型配置：和 Qwen2 的关键差异

MiMo-7B 的 `REGISTER_MODEL_ARGS` 与 Qwen2 系列的主要区别：

```cpp title="mimo.h — REGISTER_MODEL_ARGS(mimo, ...)"
LOAD_ARG_OR(attention_bias, "attention_bias", true);  // ← Qwen2 默认为 false
LOAD_ARG_OR(rope_theta, "rope_theta", 640000.0f);     // ← Qwen2 默认 10000，MiMo 大得多
LOAD_ARG_OR(eos_token_id, "eos_token_id", 151643);    // ← Qwen2 兼容词表
LOAD_ARG_OR(vocab_size, "vocab_size", 151680);         // ← 同 Qwen2.5

// MiMo 特有：MTP（Multi-Token Prediction）层数
LOAD_ARG_OR(num_nextn_predict_layers, "num_nextn_predict_layers", 1);
```

**`attention_bias=true`**：Qwen2 的 attention 层的 Q/K/V 线性层无 bias，MiMo 有。这一差异源自 MiMo 使用了 QKV bias 的预训练配置，如果错误地将其置为 `false`，Q/K/V 投影会缺少 bias 项导致输出偏差。

**`rope_theta=640000`**：远大于 Qwen2 的默认值（10000），较大的 theta 让 RoPE 的旋转频率更低，对长上下文的位置区分度更好——这与 MiMo 在长推理链场景下的应用目标一致。

**`num_nextn_predict_layers=1`**：这是 MiMo-7B 特有的配置字段，表示模型带有 1 个 Multi-Token Prediction 附加层。在本 PR 中，该字段被声明和加载，但尚未被 `MiMoModelImpl` 利用——它是为后续 MTP 推测解码支持所做的配置预留。

### FlashInfer API 适配

`random_sample.cpp` 随同一起更新，将 `sampling_from_probs` 的调用适配到 FlashInfer ≥ 0.6.11 的新签名。新接口在原有参数基础上调整了 `maybe_indices` 的传入方式：

```cpp title="xllm/core/kernels/cuda/random_sample.cpp"
get_function("sampling", "sampling_from_probs")(
    to_ffi_tensor(flat_probs),
    to_ffi_tensor(samples),
    /*maybe_indices=*/ffi::Optional<ffi::Tensor>(),
    /*deterministic=*/true,
    /*philox_seed=*/seed,
    /*philox_offset=*/offset);
```

这是一个与 MiMo 无关的独立基础设施修复，但它影响所有走采样路径的模型，因此随本 PR 一起提交。

---

## 意义与影响

这个 PR 最值得关注的不是 MiMo 本身，而是它展示了 xLLM 模型接入的成本：**一个基于 Qwen2 架构的新模型，只需 122 行代码**，涵盖类定义、MRoPE 接口覆写、模型注册和配置加载。

这得益于 `LlmModelImplBase<DecoderLayerType>` 的设计——forward 循环、weight loading、embedding 管理全部抽象在基类里，子类只需声明"我用什么 layer"和"我的位置编码有什么特殊之处"。

三个参数反映了 MiMo 的技术路线：

- **`attention_bias=true`**：区别于大多数同尺寸模型的配置选择，体现了预训练时对 attention 表达力的偏好；
- **`rope_theta=640000`**：强调长上下文推理能力，与 MiMo 在复杂推理链（数学、代码）上的定位吻合；
- **`num_nextn_predict_layers=1`**：暗示 MiMo-7B 的官方推理加速方案依赖 MTP 推测解码，基础设施在这里提前完成了预留。

---

## 参考

- [MiMo 官方 vLLM 实现](https://github.com/XiaomiMiMo/vllm/commit/3a353c0508437a2341ae67252e62382ad012d165)
- [Qwen2 技术报告](https://arxiv.org/abs/2407.10671)
- [Multi-Token Prediction（MTP）论文](https://arxiv.org/abs/2404.19737)
