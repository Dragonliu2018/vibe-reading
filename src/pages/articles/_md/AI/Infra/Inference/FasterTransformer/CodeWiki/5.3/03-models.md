---
source:
  type: "源码解读"
  project: "fastertransformer"
  url: "https://github.com/NVIDIA/FasterTransformer"
title: "Models"
date: "2026-08-10T14:00:00+08:00"
category: [AI, Infra, Inference, FasterTransformer, CodeWiki, "5.3"]
tags: ["FasterTransformer", "ParallelGpt", "Tensor Parallel", "Pipeline Parallel", "模型编排"]
description: "FasterTransformer 的模型编排层——ParallelGpt 的 forward 两阶段调度、Megatron 式权重切分、Context/Generation 分离、MoE 框架。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/00-overview)

---

## 模块定位

`models/` 是**模型编排层**——12,729 行 C++，将 `layers/` 的组件和 `kernels/` 的算子编排成完整模型的 forward 流程，并管理权重加载、tensor/pipeline parallel 切分、context/generation 两阶段调度。每个子目录是一个模型（`multi_gpu_gpt/`、`bert/`、`t5/`、`gptj/` 等），共享相似的结构但各有差异。

这个模块独立存在的原因是：不同模型的 forward 编排有本质差异——GPT 是 decoder-only（无 cross-attention），T5/BART 是 encoder-decoder（有 cross-attention + 两阶段解码），BERT 是 encoder-only（无自回归生成）。把这些编排逻辑放在 layer 层会让 layer 耦合模型语义，放在 kernel 层则超出 kernel 的职责。`models/` 层回答："给定一个模型的全部权重和输入，如何按正确的顺序调用正确的 layer、在正确的位置做多 GPU 通信"。

`multi_gpu_gpt/ParallelGpt` 是本模块的核心——它同时实现 tensor parallel（Megatron 式权重切分）和 pipeline parallel（layer 切分），是 FT 多 GPU 推理的集大成者。

## 模块架构

```
multi_gpu_gpt/
├── ParallelGpt.h / .cc              # 顶层模型类（forward 编排 + 资源管理）
├── ParallelGptWeight.h / .cc        # 权重容器（vector<ParallelGptDecoderLayerWeight>）
├── ParallelGptDecoderLayerWeight    # 单层权重（20 个指针：QKV/bias/output/ffn/layernorm）
├── ParallelGptContextDecoder        # Context 阶段 decoder（处理 input prompt）
├── ParallelGptDecoder               # Generation 阶段 decoder（逐 token）
└── ParallelGptDecoderLayerWeight.h  # gptVariantParams（扩展点：激活类型、rotary 等）

其他模型：
├── bert/ bert_int8/ bert_fp8/       # BERT（encoder-only）
├── t5/                              # T5（encoder-decoder + cross-attention）
├── bart/                            # BART（encoder-decoder）
├── gptj/ gptneox/                   # GPT-J / GPT-NeoX（单 GPU + rotary）
├── vit/ swin/ vit_int8/ swin_int8/  # 视觉 transformer
├── decoding/ decoder/               # 通用 decoder/decoding
└── wenet/                           # 语音（4344 行，最大子目录，含 conv2d）
```

`ParallelGpt` 内部组合 `ParallelGptContextDecoder` + `ParallelGptDecoder` + `DynamicDecodeLayer` 三个组件。两个 decoder 各自组合 N 层 `TensorParallelGptContextAttentionLayer` + `TensorParallelGeluFfnLayer` 或 `TensorParallelDecoderSelfAttentionLayer` + `TensorParallelGeluFfnLayer`。

## 调用链路

`ParallelGpt::forward` 是整个推理的主入口，分两阶段执行：

```
ParallelGpt::forward(output_tensors, input_tensors)    ParallelGpt.cc
├── allocateBuffer()  (if !continue_gen)               # 分配 logits/KV cache/output_ids 等
├── invokeTileGptInputs()                              # beam 展开：[batch, seq] → [batch*beam, seq]
│
├── [Context 阶段]
│   ├── invokeInputIdsEmbeddingLookup()                # int → T embedding
│   ├── ParallelGptContextDecoder::forward()           # ParallelGpt.cc:1084
│   │   ├── [Pipeline 首层] ftNcclRecv + ftNcclAllGather   # 同步点 #1
│   │   └── for each layer (local_num_layer / pp):
│   │       ├── invokeGeneralLayerNorm()
│   │       ├── TensorParallelGptContextAttentionLayer::forward()
│   │       │   └── ftNcclAllReduceSum()               # 同步点 #2
│   │       ├── invokeAddBiasResidualLayerNorm()
│   │       ├── TensorParallelGeluFfnLayer::forward()
│   │       │   └── ftNcclAllReduceSum()               # 同步点 #3
│   │       └── invokeAddBiasResidual()
│   │   └── [Pipeline 末层] ftNcclSend                  # 同步点 #4
│   └── 更新 KV cache（context 计算结果写入 cache）
│
├── [Generation 循环] for step in range(output_len):   # ParallelGpt.cc:1210+
│   ├── [Pipeline 接收] ftNcclGroupStart/Recv/GroupEnd  # 同步点 #5
│   ├── invokeEmbeddingLookup(output_ids_buf_)          # int → T
│   ├── ParallelGptDecoder::forward()                   # ParallelGpt.cc:1334
│   │   ├── [Pipeline 首层] ftNcclRecv + ftNcclAllGather  # 同步点 #6
│   │   └── for each layer:
│   │       ├── invokeGeneralLayerNorm()
│   │       ├── TensorParallelDecoderSelfAttentionLayer::forward()
│   │       │   └── masked_multihead_attention()         # fused MMHA kernel
│   │       │   └── ftNcclAllReduceSum()                 # 同步点 #7
│   │       ├── invokeAddBiasResidualLayerNorm()
│   │       ├── TensorParallelGeluFfnLayer::forward()
│   │       │   └── ftNcclAllReduceSum()                 # 同步点 #8
│   │       └── invokeAddBiasResidual()
│   │   └── [Pipeline 末层] ftNcclSend                   # 同步点 #9
│   ├── invokeGeneralLayerNorm()                         # post-decoder layernorm
│   ├── cublas_wrapper_->Gemm()  (logits)                # T × embedding → float logits
│   ├── ftNcclAllGather(nccl_logits_buf_)                # 同步点 #10（vocab 分片聚合）
│   ├── DynamicDecodeLayer::forward()                    # beam search / sampling
│   └── [Pipeline 发送] ftNcclGroupStart/Send/GroupEnd   # 同步点 #11
│
├── setOutputTensors()                                   # gather + transpose output_ids
└── sendTensorsToFirstPipelineNode()                     # 同步点 #12（PP 结果聚合到 rank 0）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `ParallelGpt::forward` | 两阶段 forward 编排 | Context + Generation 分离，各用最优 attention |
| `ParallelGpt` 构造函数 | 装配权重 + 两个 decoder + dynamic decode | 权重按 TP/PP rank 切分加载，layer 数按 PP 分 |
| `ParallelGpt::allocateBuffer` | 分配 logits/KV cache/output 等 | `is_free_buffer_after_forward_=false` 保留 buffer |
| `ParallelGptContextDecoder::forward` | Context 阶段 N 层循环 | dense attention（cuBLAS），KV cache 写入 |
| `ParallelGptDecoder::forward` | Generation 阶段 N 层循环 | incremental attention（fused MMHA），KV cache 增量 |
| `ParallelGptWeight::loadModel` | 从 .bin 加载权重 | 按 TP rank 切分，支持 shared embedding |
| `setOutputTensors` | 输出整理（gather + transpose） | beam search 路径重组 |
| `sendTensorsToFirstPipelineNode` | PP 结果聚合到 rank 0 | 末 rank Send，首 rank Recv |

</details>

## 核心实现

### Context phase 与 Generation phase 分离

`ParallelGpt` 将 forward 拆成两阶段——`ParallelGptContextDecoder` 处理完整 input prompt（并行计算所有 token），`ParallelGptDecoder` 逐 token 生成：

```cpp title="ParallelGpt.h"
class ParallelGpt {
private:
    ParallelGptContextDecoder* context_decoder_;   // Context 阶段
    ParallelGptDecoder*         decoder_;           // Generation 阶段
    DynamicDecodeLayer*         dynamic_decode_layer_;
    // ...
};
```

**为什么分离**：两阶段的 attention 计算模式根本不同。Context phase 并行处理所有 input token，使用 dense attention（所有 token 互相 attend），sequence length > 1，可以充分利用 GPU 并行度——走 cuBLAS `stridedBatchedGemm`（`TensorParallelGptContextAttentionLayer`）。Generation phase 每步只处理 1 个新 token，使用 incremental attention（新 token attend 历史 KV cache），sequence length = 1，计算量小但需频繁读写 KV cache——走 fused MMHA kernel（`TensorParallelDecoderSelfAttentionLayer` → `masked_multihead_attention`）。分离后各自使用最优 attention 实现，比统一处理两种场景的性能更好。

### Megatron 式 Tensor Parallel 权重切分

FT 的 tensor parallel 遵循 [Megatron-LM](https://arxiv.org/pdf/1909.08053.pdf) 的思路，对每个 transformer block 的两个 GEMM 做非对称切分：

- **Attention QKV 权重**：按 `local_head_num = head_num / tensor_para_size` 切分。每个 TP rank 只持有部分 head 的 QKV 权重，计算各自的 attention——不需要通信（不同 head 独立）。
- **Attention output 权重**：按列切分（`hidden_units / tp`），各 rank 算部分列，结果 `ftNcclAllReduceSum` 聚合（同步点 #2/#7）。
- **FFN intermediate 权重**：按 `inter_size / tp` 切分（第一 GEMM 按行切）。
- **FFN output 权重**：按列切分，`ftNcclAllReduceSum` 聚合（同步点 #3/#8）。
- **Logits GEMM**：按 `vocab_size_padded / tp` 切分，`ftNcclAllGather` 聚合（同步点 #10）。

**为什么第一 GEMM 行切、第二 GEMM 列切**：这样每个 transformer block 只需 2 次 all-reduce（attention 后 + FFN 后），而非每步 GEMM 都通信。行切的结果各 rank 独立无需通信，列切的结果需要聚合——把通信点压缩到每 block 2 次。

### Pipeline Parallel 的 layer 切分

Pipeline parallel 按 layer 切分：`local_num_layer = ceil(num_layer / pipeline_para_size)`。每个 PP rank 只执行分配给自己的层，层间用 `ftNcclSend` / `ftNcclRecv` 传递中间 hidden state。

```cpp title="ParallelGptDecoder.cc:326-339"
// Pipeline 首层：接收上游 PP rank 的 hidden state
if (pp_rank > 0) {
    ftNcclRecv(hidden_features, size, pp_rank - 1, pipeline_para_, stream_);
    ftNcclAllGather(...);  // TP 内聚合
}
// ... 执行 local_num_layer 层 ...
// Pipeline 末层：发送给下游 PP rank
if (pp_rank < pp_size - 1) {
    ftNcclSend(hidden_features, size, pp_rank + 1, pipeline_para_, stream_);
}
```

FT 的 pipeline 不是真正的异步流水线，而是 **micro-batching**——每个 step 内 batch 被分成 `iteration_num` 个 `local_batch_size` 子批次串行处理，填充通信气泡。`getLocalBatchSize`（`nccl_utils.cc`）动态计算：`pp_size==1` 时直接返回 `batch_size`，否则先 `batch_size / pp_size`，再循环减半直到 `local_batch_size * seq_len <= 1024`。关键 PP 通信点后调 `ftNcclStreamSynchronize` 强制同步。官方建议 TP 用于节点内（NVLink 带宽高）、PP 用于节点间（通信量小）。

在 `ParallelGpt::forward` 的 generation 循环中，PP 通信传递的具体 tensor：非末 rank 通过 `ftNcclRecv` 从末 rank 接收 `sequence_lengths_`、`generation_should_stop_`（仅 `ite==0` 时）和 `cache_indirections_`（仅 `beam_width>1` 时），`rank==0` 时额外接收 `output_ids_buf_` 中对应 step 的 token ids；末 rank 在 `step < gen_len-1` 时通过 `ftNcclSend` 向所有其他 rank 发送上述 tensor。发送/接收包裹在 `ftNcclGroupStart/GroupEnd` 中，结束后 `ftNcclStreamSynchronize` 同步。

`ParallelGptContextDecoder::forward` 和 `ParallelGptDecoder::forward` 用 `isValidLayerParallelId(l)` 判断层 `l` 是否属于当前 PP rank 的 `[local_num_layer*rank, local_num_layer*(rank+1))` 范围——不在范围内的层 `continue` 跳过。首层（`isFirstLayerParallelId`）且 `pp_rank != 0` 时 `ftNcclRecv` 接收上游 hidden state 分片再 `ftNcclAllGather` 聚合到所有 TP rank；末层（`isLastLayerParallelId`）且 `pp_rank != world_size-1` 时 `ftNcclSend` 发送给下游 PP rank。`use_shared_contexts` 为 true 时，先 `invokeCompactInputs` 压缩 decoder_input/attention_mask/input_lengths（合并相同 prefix 的请求），每层 attention 后 `invokeUnCompactCaches` 展开紧凑 K/V cache，最后 `invokeUnCompactOutputs` 展开输出——这是 GPT 的 shared context 优化（`shared_contexts_ratio` 参数控制）。

### 权重组织与加载

`ParallelGptWeight` 按 layer 组织成 `vector<ParallelGptDecoderLayerWeight>`，长度为 `num_layer / pipeline_para_size`（每个 PP rank 只持部分层）。每层 `ParallelGptDecoderLayerWeight` 含 20 个权重指针：

```cpp title="ParallelGptDecoderLayerWeight.h"
struct ParallelGptDecoderLayerWeight {
    // pre attention layernorm: 2 (gamma + beta)
    // self attention: 4 (QKV kernel + bias + output kernel + bias)
    // post attention layernorm: 2
    // ffn: 4 (intermediate kernel + bias + output kernel + bias)
    // adapters: 8 (可选)
    LayerNormWeight<T>   pre_attention_layernorm;
    AttentionWeight<T>   self_attention_weights;   // 无 cross_attention（decoder-only）
    LayerNormWeight<T>   post_attention_layernorm;
    FfnWeight<T>         ffn_weights;
};
```

**为什么按 layer vector 组织**：pipeline parallel 需要按 rank 分配层，vector 天然支持按 index 切分。`mallocWeights`（`ParallelGptDecoderLayerWeight.cc:534-613`）在构造时按 `isValidLayerParallelId` 决定是否为该 PP rank 分配权重——不属于本 rank 的层不分配显存，省内存。

权重加载通过 `loadWeightFromBin`（`utils/memory_utils.cu:300`）：`std::ifstream` 读 `.bin` 文件到 host `vector<T>` → `cudaH2Dcpy`（`cudaMemcpy` Host→Device）到 GPU。权重文件格式由 `FtCudaDataType` 控制（FP32/FP16/BF16/INT8），若与目标精度 T 不同则先 D2D 类型转换。加载时按 TP rank 切分——`loadModel` 中根据 `tensor_para_size` 只加载本 rank 对应的 head/inter 分片。

### Shared Embedding（lm_head 复用 word embedding）

加载权重时检测 `model.lm_head.weight.bin` 是否存在。若不存在，则 `shared_embed_ = true`，lm_head 直接复用 word embedding table（`weights_ptr[6] = weights_ptr[1]`），并释放多余的 `weights_ptr[6]` 显存：

```cpp title="ParallelGptWeight.cc:230-237"
if (shared_embed_ && weights_ptr[6] != weights_ptr[1]) {
    deviceFree(weights_ptr[6]);
    post_decoder_embedding.kernel = weights_ptr[1];  // 复用 word embedding
}
```

**为什么复用**：GPT-2 等模型中 word embedding 和 lm_head 权重共享（weight tying），节省约 `vocab_size × hidden_units` 显存（vocab=50257、hidden=768 时约 150MB）。OPT 等模型不共享，需独立加载。

### vocab_size_padded_ 的对齐计算

`ParallelGpt` 构造函数中 `vocab_size_padded_` 的计算考虑了 TP 切分和精度对齐：先 `local_vacab_size = ceil(vocab_size / tp_size)` 按 TP 均分词表，当 `T` 为 `half` 或 `__nv_bfloat16` 时再做 8 字节对齐（`local_vacab_size = ceil(local_vacab_size / 8.f) * 8`），最终 `vocab_size_padded_ = local_vacab_size * tp_size`。对齐是因为 half/bf16 的 GEMM 要求 vocab 维度 8 对齐才能用最优 cublasLt 算法。

### int8_mode 的权重加载

`ParallelGptDecoderLayerWeight::loadModel` 按 `int8_mode_` 分三种加载路径：`mode==0` 用 `loadWeightFromBin<T>` 加载常规浮点权重；`mode==1`（weight-only INT8）用 `loadWeightFromBinAndQuantizeForWeightOnly` 同时加载并量化，写入 `int8_weights_ptr` 和 `weight_only_scale_ptr`；`mode==2`（SmoothQuant）用 `loadWeightFromBin<int8_t>` 以 INT8 格式加载权重 + `loadWeightFromBin<float>` 加载 scale/scale_inter/scale_out（attention QKV 的 `scale_inter` 有 `3*hidden_units_/tp` 个元素、`scale_out` 有 3 个元素），加载后调 `transposeWeight()` 对 int8 权重做转置以匹配 cuBLAS INT8 GEMM 的布局要求。

### MoE 框架

`ParallelGpt` 已内置 Mixture of Experts 支持（`expert_num_`、`moe_k_`、`moe_layer_index_`）。在 `ParallelGptDecoder::forward` 中，MoE 层通过 `std::find(moe_layer_index_.begin(), moe_layer_index_.end(), l) != end` 判断，`use_moe` 为 true 时 FFN 输出 shape 包含 `moe_k_` 倍的 batch，调用 FFN 时传入 MoE routing tensors（`expert_scales_`、`expanded_source_row_to_expanded_dest_row_`、`expert_for_source_row_`），FFN 后用 `finalize_moe_routing_kernelLauncher`（`:584`）替代 `invokeAddBiasResidual` 做最终残差合并。

`has_adapters_` 为 true 时，在每层两个位置插入额外的小 FFN（adapter）：self-attention 之后插入 `after_attention_adapter`（用 `ffn_layer_->resetInterSize(adapter_inter_size_ / tp_size)` 调整 inter size，以 `after_attention_adapter_weights` 为权重），主 FFN 之后插入 `after_ffn_adapter`（同样 inter size 和对应权重）。adapter 输出通过 `after_adapter_attn_output_` 缓冲区中转，在 pre-layernorm 模式下通过 `invokeGeneralAddBiasResidualPreLayerNorm` 合并残差。`ParallelGptWeight` 构造时对 `moe_layer_index_` 中的层创建 MoE 版本的 `ParallelGptDecoderLayerWeight`。

### gptVariantParams 扩展点

`ParallelGptDecoderLayerWeight.h:35` 的 `gptVariantParams` 结构体是支持不同 GPT 变体的扩展点，包含 `activation_type`（GELU/SiLU/ReLU）、rotary embedding 配置等。通过它可以在不改 ParallelGpt 主结构的前提下支持 GPT-J（rotary）、GPT-NeoX（NeoX rotary）、LLaMA（RMSNorm + SwiGLU）等变体——这正是 FT 能覆盖这么多模型的关键。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 编排/组合 | `ParallelGpt` 组合 context_decoder + decoder + dynamic_decode | 将完整 forward 拆解为可独立测试的组件 |
| 两阶段分离 | `ParallelGptContextDecoder` vs `ParallelGptDecoder` | 两种 attention 模式根本不同，各用最优实现 |
| 权重容器 | `ParallelGptWeight` → `vector<ParallelGptDecoderLayerWeight>` | 天然支持 PP 按 layer 切分 |
| 扩展点 | `gptVariantParams` | 不改主结构支持多 GPT 变体 |
| 精度模板 | `template<typename T>` | 算法写一遍支持多精度 |

## 模块间交互

`models/` 调用 `layers/` 的 attention / FFN / DynamicDecode layer（通过 `forward(TensorMap*)` 接口），调用 `kernels/` 的 `invokeGeneralLayerNorm` / `invokeAddBiasResidual` / `invokeInputIdsEmbeddingLookup` 等（在 decoder forward 内）。依赖 `utils/` 的 `nccl_utils`（TP all-reduce + PP send/recv）、`cublasMMWrapper`（logits GEMM）、`IAllocator`（buffer 分配）、`Tensor`/`TensorMap`、`memory_utils`（权重加载 `loadWeightFromBin`）。`models/` 被 `triton_backend/` 的 `ParallelGptTritonModel` / `th_op/` 的 PyTorch OP 包装——这些绑定层将框架请求翻译为 `TensorMap` 后调 `ParallelGpt::forward`。

## 扩展方式

**新增 GPT 变体（如 LLaMA）**：修改 `gptVariantParams`（`ParallelGptDecoderLayerWeight.h:35`）添加 `use_rms_norm`、`activation_type` 等字段 → 在 `ParallelGptWeight::loadModel` 调整权重文件命名 → 在 `ParallelGptDecoder::forward` 替换 `invokeGeneralLayerNorm` 为 `invokeRMSNorm` → 在 attention layer 添加 rotary embedding → 通过 `gptVariantParams.activation_type` 切换 FFN 激活。

**新增 MoE 层**：在 `moe_layer_index_` 中加入目标层 index → `ParallelGptWeight` 构造时为该层创建 MoE 版权重 → `ParallelGptDecoder::forward` 的 `use_moe` 分支已就绪，传入 MoE routing tensors。

**调整 TP 切分策略（如 sequence parallel）**：修改 `mallocWeights` 调整权重分配 → 修改 attention layer 的 all-reduce 逻辑（改为 all-gather / reduce-scatter）→ 修改 `ParallelGptDecoder::forward` 通信点。

> 扩展点的契约（`gptVariantParams`、权重文件命名）见概览「架构设计解析 > 核心概念」。
