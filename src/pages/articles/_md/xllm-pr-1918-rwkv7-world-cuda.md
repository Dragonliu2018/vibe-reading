---
title: "在 CUDA 上支持 RWKV-7-World 线性注意力模型"
source:
  project: "xLLM"
  type: "PR"
  id: "1918"
  url: "https://github.com/xLLM-AI/xllm/pull/1918"
  prType: "feat"
date: "2026-07-10"
category: [AI, 推理, xLLM, Contributions]
tags: ["RWKV-7", "线性注意力", "RNN", "Linear Attention", "KV Cache", "Trie Tokenizer", "CUDA"]
description: "为 xLLM 实现 RWKV-7-World CUDA 推理：复用 linear-attention KV cache 存 W-matrix 状态、time-mix 的 LoRA 衰减与 in-context learning 修正、channel-mix 门控 FFN、v_first 跨层值残差，以及原生 .pth 到 HF 目录的转换工具。"
readingTime: "16 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1918](https://github.com/xLLM-AI/xllm/pull/1918) · **Issue** - · **commit** [df42f19](https://github.com/xLLM-AI/xllm/commit/df42f19) · **首发版本** -（PR 未合并）· **变更行数** +2702 行 · **合并时间** -

---

## 背景

RWKV-7 "Goose" 是 RWKV 系列的最新一代**线性注意力/RNN 架构**语言模型。和 Transformer LLM 的根本区别：

| 特性 | Transformer LLM | RWKV-7 |
|---|---|---|
| 位置编码 | RoPE / ALiBi 等 | **无**（递推替代位置）|
| 序列建模 | 全局注意力 O(n²) | **固定大小递推状态** O(n) |
| KV cache | 存历史 K/V 分页 | 存 **W-matrix 状态** + shift 状态 |
| 推理显存 | 随上下文长度增长 | **恒定**（与上下文长度无关）|

RWKV-7 的核心是每层维护一个 `[n_heads, head_size, head_size]` 的 **W-matrix 状态**——它随每个 token 递推更新，编码了"截至当前位置的全部历史"。这使得推理显存与上下文长度解耦，理论上可以处理无限长上下文。

本 PR 把 RWKV-7-World 接入 xLLM。挑战在于：

1. RWKV-7 不是标准 attention，但 xLLM 的 KV cache 基础设施是按 paged attention 设计的——如何复用？
2. RWKV-7 官方权重是原生 `.pth` 格式，没有 `config.json`/safetensors/tokenizer，如何接入 xLLM 的 HF 风格加载流程？
3. time-mix 的 LoRA 衰减、in-context learning 修正、v_first 跨层值残差等结构在 C++ 中如何精确复现？

PR 新增约 2700 行，核心是 4 个新文件。下文按"架构 → time-mix → channel-mix → KV cache 复用 → tokenizer → 转换工具"展开。

---

## 前置知识

### RWKV-7 的递推状态

每个 token 处理时，W-matrix 状态按以下公式更新：

```
vk = v ⊗ k                          # 外积 [H, N, N]
ab = (-kk) ⊗ (kk * a)               # in-context learning 修正 [H, N, N]
s = s * decay + s @ ab + vk         # 状态递推
out = (s @ r)                        # 读出
```

其中 `decay = exp(-exp(w))`，`w` 由 LoRA 计算。状态 `s` 是 `[H, N, N]` 矩阵，每层独立维护，跨 token 递推——这就是"线性注意力"的本质：把注意力的 softmax 替换成可递推的矩阵运算。

### Linear Attention KV Cache

xLLM 此前已有 linear-attention 的 KV cache 基础设施（用于其他线性注意力模型），支持两种缓存张量：

- **conv_cache**：一维卷积历史状态（token-shift 用）
- **ssm_cache**：状态空间模型的状态矩阵

RWKV-7 巧妙地复用了这两个缓存：conv_cache 存 shift 状态，ssm_cache 存 W-matrix。

---

## 实现

### 模型顶层：embedding + blocks + ln_out + head

`rwkv7.h` 定义 `RWKV7ForCausalLM`，结构极简：

```
RWKV7ForCausalLM
├── model: RWKV7Model
│   ├── emb: Embedding(vocab, hidden)
│   ├── blocks: ModuleList[RWKV7DecoderLayer × n_layers]
│   └── ln_out: LayerNorm
└── head: Linear(hidden, vocab, bias=false)
```

`forward` 把所有序列的 token 打包成一维 `[total_tokens, hidden]`，逐层过 decoder block：

```cpp title="xllm/models/llm/rwkv7.h — forward"
ModelOutput forward(const torch::Tensor& tokens,
                    const torch::Tensor& /*positions*/,  // RWKV-7 无位置编码
                    std::vector<KVCache>& kv_caches,
                    const ModelInputParams& input_params) {
  torch::Tensor h = emb_(tokens);  // [total_tokens, hidden_size]

  // v_first：跨层值残差，由 block 0 初始化，传给后续所有 block
  torch::Tensor v_first;

  for (size_t i = 0; i < blocks_.size(); ++i) {
    h = blocks_[i]->forward(h, kv_caches[i], input_params,
                            static_cast<int32_t>(i), v_first);
  }

  torch::Tensor hidden_states = ln_out_(h);
  return ModelOutput(hidden_states, std::nullopt);
}
```

注意 `positions` 参数被忽略——RWKV-7 没有位置编码，位置信息完全由递推状态的演化隐式编码。

### Time-Mix：注意力替代

`rwkv7_decoder_layer.cpp` 的 `RWKV7TimeMixImpl` 是核心。每个 token 的处理流程：

#### Step 1：Token-shift 混合

```cpp title="token-shift：用前一 token 的嵌入做差分"
torch::Tensor xx = shifted - xs;  // [T, C]，shifted 是上一 token 的嵌入

auto mix = [&](const torch::Tensor& coeff) {
  return xs + xx * coeff.view({hidden_size_});  // [T, C]
};
torch::Tensor xr = mix(x_r_);  // 6 个混合系数 x_r/x_w/x_k/x_v/x_a/x_g
torch::Tensor xw = mix(x_w_);
// ...
```

这是 RNN 风格的"时序差分"——用当前与上一 token 的差作为额外输入，6 个可学习系数控制不同投影支路的混合比例。

#### Step 2：LoRA 衰减计算

衰减 `w` 不是直接参数，而是由低秩 LoRA 动态计算：

```cpp title="compute_decay — LoRA 计算动态衰减"
torch::Tensor RWKV7TimeMixImpl::compute_decay(const torch::Tensor& xw) const {
  // w = log_sigmoid(w0 + tanh(xw @ w1) @ w2) - 0.5
  torch::Tensor lora = torch::tanh(xw.matmul(w1_)).matmul(w2_);  // [T, C]
  torch::Tensor w_raw = w0_.view({hidden_size_}) + lora;
  torch::Tensor w = torch::log_sigmoid(w_raw) - 0.5f;
  // decay = exp(-exp(w))  ∈ (0, 1)
  torch::Tensor decay = torch::exp(-torch::exp(w));
  return decay.view({-1LL, n_heads_, head_size_});  // [T, H, N]
}
```

双重指数 `exp(-exp(w))` 把任意实数 `w` 映射到 `(0, 1)` 区间作为衰减系数。`w1`/`w2` 的秩从 checkpoint 动态推断（不同规模模型 LoRA 秩不同），因此用 plain tensor 而非注册参数。

#### Step 3：A-gate（in-context learning 修正）

```cpp title="A-gate：in-context learning 调制"
// a = sigmoid(a0 + xa @ a1 @ a2)  →  [T, C]
torch::Tensor a_gate =
    torch::sigmoid(a0_.view({hidden_size_}) + xa.matmul(a1_).matmul(a2_));

// Key 被 a-gate 调制
torch::Tensor k_mod =
    k_h * (1.0f + (a_h - 1.0f) * k_a_.view({1LL, n_heads_, head_size_}));
```

a-gate 让模型根据上下文动态调整 key 的强度，是 RWKV-7 相比 RWKV-6 的关键改进——"in-context learning"能力由此而来。

#### Step 4：V-first 跨层值残差

```cpp title="v_first：block 0 初始化，后续层混合"
torch::Tensor v_h_blend = v_h;
if (is_layer0) {
  // block 0：把 v 写入 v_first，供后续层使用
  v_first.slice(0, token_offset, token_offset + T).copy_(v_proj);
} else {
  // 后续层：v 与 block 0 的 v_first 混合
  torch::Tensor vf = v_first.slice(0, token_offset, token_offset + T)
                         .view({T, n_heads_, head_size_});
  torch::Tensor blend =
      torch::sigmoid(v0_.view({hidden_size_}) + xv.matmul(v1_).matmul(v2_))
          .view({T, n_heads_, head_size_});
  v_h_blend = v_h + (vf - v_h) * blend;  // 残差混合
}
```

`v_first` 是 RWKV-7 的"跨层值残差"——block 0 的 value 通过 `v_first` 张量直接传给所有后续层，每层用自己的 value 与之混合。这让深层网络也能保留早期层的值信息，类似 Transformer 中的残差连接但作用在 value 通道上。

#### Step 5：核心递推循环

`rwkv7_recurrence` 是逐 token 的串行循环（这是 RWKV 推理的瓶颈所在）：

```cpp title="rwkv7_recurrence — 逐 token 状态递推"
for (int64_t t = 0; t < T; ++t) {
  // 外积：vk = v ⊗ k  →  [H, N, N]
  torch::Tensor vk = v[t].view({H, N, 1}).bmm(k[t].view({H, 1, N}));

  // in-context learning 修正：ab = (-kk) ⊗ (kk * a)
  torch::Tensor ab = (-kkt).view({H, N, 1}).bmm((kkt * at).view({H, 1, N}));

  // 状态递推：s = s * decay + s @ ab + vk
  s = s * wt + s.bmm(ab) + vk;

  // 读出：out[t] = (s @ r)
  out[t] = s.bmm(rt).view({H * N}).to(r.dtype());
}
```

注意状态 `s` 强制用 **float32** 计算（`s = state.to(torch::kFloat32)`），即使模型整体跑在 bf16——W-matrix 的递推累积对精度敏感，bf16 会在长序列上漂移。这是"前向 bf16、状态 fp32"的精度边界管理。

#### Step 6：Receptance-key 残差

递推输出后还有一层 per-head 的点积修正：

```cpp title="rk_res：receptance-key 残差"
torch::Tensor rk_dot = (r_h * k_mod * r_k_.unsqueeze(0))
                           .sum(-1, true);  // [T, H, 1]
torch::Tensor rk_res = (rk_dot * v_h_blend).view({T, hidden_size_});
torch::Tensor block_out = output_((normed + rk_res) * gate);  // [T, C]
```

`r_k_` 是 per-head 的可学习缩放，让 receptance（r）和 key 的点积作为额外残差加回去。

### Channel-Mix：FFN 替代

`RWKV7ChannelMixImpl` 是简化的门控 FFN，同样用 token-shift：

```cpp title="channel-mix — 门控 FFN"
torch::Tensor xx = shifted - xs;
torch::Tensor k = xs + xx * x_k_.view({C});  // token-shift 混合

// Gated FFN: relu(key(k))^2 → value
torch::Tensor k_act = torch::pow(torch::relu(key_(k)), 2.0f);
torch::Tensor out_s = value_(k_act);  // [T, C]
```

和 time-mix 一样用 shift 差分，但激活是 `relu²`（平方 ReLU）而非 GeLU/SiLU——这是 RWKV 的传统选择，计算更廉价且梯度特性好。

### KV Cache 复用：把 W-matrix 塞进 ssm_cache

这是本 PR 最巧妙的设计。RWKV-7 的状态有两部分：

| 状态 | 维度 | xLLM 缓存位置 |
|---|---|---|
| `att_x_prev`（time-mix shift） | `[hidden]` | conv_cache `[0:H]` |
| `ffn_x_prev`（channel-mix shift） | `[hidden]` | conv_cache `[H:2H]` |
| `att_kv`（W-matrix） | `[H, N, N]` | ssm_cache |

`read_state` / `write_state` 负责打包/拆包：

```cpp title="xllm/core/layers/rwkv7_decoder_layer.cpp — 状态打包"
// 读：从 conv_cache 拆出两个 shift 状态，从 ssm_cache 读 W-matrix
torch::Tensor flat = sel_conv.squeeze(1);  // [S, 3H]
torch::Tensor att_x_prev = flat.slice(-1, 0, hidden_size_).contiguous();
torch::Tensor ffn_x_prev = flat.slice(-1, hidden_size, 2*hidden_size).contiguous();
// att_kv = sel_ssm  [S, H, N, N]

// 写：把更新后的 shift 和 W-matrix 写回
new_conv.squeeze(1).slice(-1, 0, hidden_size).copy_(att_x_prev);
new_conv.squeeze(1).slice(-1, hidden, 2*hidden).copy_(ffn_x_prev);
conv.index_copy_(0, state_indices, new_conv);
ssm.index_copy_(0, state_indices, att_kv);
```

conv_cache 的第三段 `[2H:3H]` 是 KVCacheShape 公式的产物，实际未使用（注释里标注 "artefact"）。

### 触发 linear-attention KV cache 的配置技巧

xLLM 的 KV cache 默认创建标准 paged attention 的 block cache。要让每层创建 `LinearAttentionKVCacheImpl`，`REGISTER_MODEL_ARGS(rwkv7, ...)` 里有一段关键配置：

```cpp title="rwkv7.h — 触发 linear-attention KV cache 的配置"
// 1. full_attention_interval = n_layers + 1
//    使 has_linear_attention_layers(args) == true（因为 > 1）
//    → worker_impl 设置 enable_linear_attention = true
//    → KVCacheShape 分配 conv_cache + ssm_cache
SET_ARG(full_attention_interval, static_cast<int32_t>(args->n_layers() + 1));

// 2. 使 is_linear_attention_layer(i, interval) 对所有 i ∈ [0, n_layers) 为 true
//    因为 (i+1) % (n_layers+1) ≠ 0（i < n_layers）
//    → 每层都创建 LinearAttentionKVCacheImpl
//
// 3. layer_types 全标 "rwkv7"，双重保险
SET_ARG(layer_types,
        std::vector<std::string>(n_layers, "rwkv7"));

// 4. n_kv_heads=1（dummy），让标准 paged cache 分配最小
SET_ARG(n_kv_heads, static_cast<int64_t>(1));
```

注释明确警告：如果配错，会创建标准 `KVCacheImpl`，`get_conv_cache()`/`get_ssm_cache()` 返回 undefined tensor，首次 forward 触发 `DCHECK` 失败。这是 RWKV-7 接入 xLLM 时最容易踩的坑——复用基础设施需要对触发条件有精确理解。

### RWKV Trie Tokenizer

`rwkv_tokenizer.cpp` 实现了 RWKV-5+ World 系列的 trie 分词器，词表文件 `rwkv_vocab_v20230424.txt`：

```cpp title="xllm/core/framework/tokenizer/rwkv_tokenizer.cpp — trie 结构"
struct RwkvTrieNode {
  absl::flat_hash_map<uint8_t, std::unique_ptr<RwkvTrieNode>> children;
  // ...
};
```

和 BPE/SentencePiece 不同，RWKV 用**前缀树**做最长匹配分词——从根节点逐字节下行，遇到叶子节点就输出一个 token。这种分词器没有合并规则，实现简单且确定性强。

词表加载用 `shared_ptr<const VocabData>` 缓存，多个 tokenizer 实例共享同一份词表，避免重复解析 65536 条词表项的内存开销。

### 转换工具：.pth → HF 目录

`tools/convert_rwkv7_world.py` 把 BlinkDL 原生 `.pth` 转成 xLLM 需要的 HF 风格目录。核心是 `infer_arch`——从权重张量形状反推架构参数：

```python title="tools/convert_rwkv7_world.py — 从权重反推架构"
def infer_arch(state: dict) -> dict:
    emb = state["emb.weight"]
    n_layers = max(int(key.split(".")[1])
                   for key in state if key.startswith("blocks.")) + 1
    head_size = int(state["blocks.0.att.r_k"].shape[-1])
    hidden_size = int(emb.shape[1])
    return {
        "vocab_size": int(emb.shape[0]),
        "hidden_size": hidden_size,
        "num_hidden_layers": n_layers,
        "head_size": head_size,  # 从 r_k 形状推断
        "intermediate_size": int(state["blocks.0.ffn.key.weight"].shape[0]),
        "num_attention_heads": hidden_size // head_size,
    }
```

原生 `.pth` 没有任何配置——`n_layers` 从 `blocks.N.*` 的最大 N 推断，`head_size` 从 `att.r_k` 的最后一维推断，`hidden_size` 从 embedding 形状推断。转换后生成：

```
rwkv-7-world-2.9b-xllm/
├── config.json            # model_type=rwkv7 + 推断的架构参数
├── model.safetensors      # 同一份权重，safetensors 格式
├── rwkv_vocab_v20230424.txt
└── tokenizer_config.json  # tokenizer_type=rwkv
```

`--sizes all` 支持一次转换所有规格（1.6B/2.9B/...）。

### 权重加载：多前缀兼容

`load_model` 同时兼容 BlinkDL 原生格式和 HF 格式：

```cpp title="rwkv7.h — 多前缀权重加载"
// body 权重：试 "model." 前缀（HF）和 ""（原生 BlinkDL）
model_->load_state_dict(state_dict->get_dict_with_prefix(
    std::vector<std::string>{"model.", ""}));

// LM head：试三种 key
for (const auto& key : {"head.weight", "lm_head.weight", "model.head.weight"}) {
  torch::Tensor head_w = state_dict->get_tensor(key);
  if (head_w.defined()) {
    head_->weight = head_w.to(...);
    break;
  }
}
```

这种"多前缀候选"模式在 xLLM 其他模型中也常见（如 `LlmForCausalLMImplBase::load_model`），提升了跨 checkpoint 格式的兼容性。

---

## 测试

PR 附带三个测试：

| 测试文件 | 内容 |
|---|---|
| `rwkv_tokenizer_test.cpp`（+165 行）| trie 分词的 encode/decode 往返、特殊 token 处理 |
| `rwkv7_decoder_layer_test.cpp`（+250 行）| decoder layer 前向数值正确性、状态递推一致性 |
| `hf_model_loader_test.cpp`（+41 行）| rwkv7 config 参数解析 |

实测（A800-40GB，`rwkv-7-world-2.9b`）：

```
Prompt: The capital of France is
Output: Paris
```

---

## 意义与影响

RWKV-7 是 xLLM 接入的**第一个非 Transformer 架构的因果语言模型**，验证了框架对线性注意力/RNN 架构的适配能力。

几个值得关注的设计：

**KV cache 基础设施的复用**：RWKV-7 没有用标准 paged attention，但通过 `conv_cache` + `ssm_cache` 两个张量复用了 xLLM 的 linear-attention KV cache 通路。W-matrix 状态 `[H, N, N]` 塞进 ssm_cache，shift 状态塞进 conv_cache——这种"语义重映射"让 RWKV-7 免费获得了 xLLM 的连续批处理、调度、PD 分离等基础设施支持。触发条件（`full_attention_interval = n_layers+1` + `layer_types`）的精确配置是接入的关键。

**状态精度的 fp32 边界**：模型整体跑 bf16，但 W-matrix 递推用 fp32。线性注意力的状态是**累积量**——长序列上 bf16 的舍入误差会指数级放大，fp32 是必须的。这和扩散模型"前向 bf16、latent fp32"的精度管理思路一致。

**LoRA 的动态秩**：衰减 `w`、a-gate `a`、v-first blend 三个 LoRA 的秩从 checkpoint 动态推断（不同规模模型秩不同），因此用 plain tensor 而非注册参数。`load_state_dict` 时按 checkpoint 实际形状加载，避免了硬编码秩。

**v_first 跨层残差**：block 0 的 value 通过一个跨层张量 `v_first` 直接传给所有后续层。这种"值残差"机制让深层 RWKV 也能保留早期信息，是 RWKV-7 相比前代的关键改进之一。在 C++ 实现中，`v_first` 作为 `forward` 的引用参数在层间传递，由 `RWKV7Model::forward` 统一管理生命周期。

**转换工具的架构反推**：原生 `.pth` 没有配置文件，转换脚本从权重张量形状反推所有架构参数。这种"权重即配置"的思路对其他没有标准 config 的原生格式模型（如某些 MoE 的原生导出）有借鉴价值。

---

## 参考

- [RWKV-7 官方仓库](https://github.com/BlinkDL/RWKV-LM/tree/main/RWKV-v7)
- [RWKV-7-World 模型（ModelScope）](https://www.modelscope.cn/models/Blink_DL/rwkv-7-world)
- [RWKV 线性注意力机制详解](https://arxiv.org/abs/2305.13048)
- [Linear Attention 与 RNN 的等价性](https://arxiv.org/abs/2002.02509)
