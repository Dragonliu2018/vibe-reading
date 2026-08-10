---
source:
  type: "源码解读"
  project: "fastertransformer"
  url: "https://github.com/NVIDIA/FasterTransformer"
title: "Layers"
date: "2026-08-10T14:00:00+08:00"
category: [AI, Infra, Inference, FasterTransformer, CodeWiki, "5.3"]
tags: ["FasterTransformer", "Attention", "Beam Search", "Sampling", "模板方法"]
description: "FasterTransformer 的层模块——BaseLayer 资源注入、Unfused/Fused/Decoder attention 策略选择、BeamSearch/Sampling 解码、DynamicDecodeLayer 统一调度。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/00-overview)

---

## 模块定位

`layers/` 是 `models/` 和 `kernels/` 之间的**桥接层**——8,228 行 C++/CUDA，封装 transformer 的单个组件逻辑（attention、FFN、beam search、sampling），在 cuBLAS GEMM 和 fused CUDA kernel 之间做策略选择与资源管理。它不实现底层 kernel（那是 `kernels/` 的事），也不编排完整模型 forward（那是 `models/` 的事），而是回答："给定一个 attention/FFN/decode 组件的输入，应该用哪种策略（Unfused/Fused/INT8）、调哪些 kernel、怎么管理中间 buffer"。

这个模块独立存在的原因是：transformer 的组件逻辑复杂度高——attention 有 Unfused（分步 cuBLAS）、Fused（TRT 单 kernel）、Decoder（fused MMHA + KV cache）三种实现，每种又分 INT8/FP8 量化变体；beam search 和 sampling 有各自的 penalty 预处理 + 核心采样两阶段。把这些策略选择和资源管理集中在 layer 层，让 model 层只需声明"我要一个 attention layer"而不关心实现细节。

## 模块架构

```
layers/
├── BaseLayer.h                    # 基类：stream/cublas/allocator 注入 + allocateBuffer/freeBuffer
├── DynamicDecodeBaseLayer.h       # 解码层中间基类：setup/forward(TensorMap*)
├── attention_layers/
│   ├── BaseAttentionLayer.h       # attention 抽象 + getAttentionType() 选择函数
│   ├── UnfusedAttentionLayer      # 非融合（分步 cuBLAS + 自定义 kernel）
│   ├── FusedAttentionLayer        # 融合（TRT MHARunner 单 kernel）
│   ├── DecoderSelfAttentionLayer  # 解码自注意力（fused MMHA + KV cache）
│   ├── GptContextAttentionLayer   # GPT context 阶段 attention
│   └── TensorParallel*            # 各 attention 的 TP 装饰器（加 all-reduce）
├── attention_layers_int8/         # INT8 变体
├── attention_layers_fp8/          # FP8 变体
├── FfnLayer.h                     # FFN（FC1 + activation + FC2）
├── beam_search_layers/
│   ├── BaseBeamSearchLayer        # 模板方法：penalty → softmax(topk) → update cache
│   └── BeamSearchLayer / OnlineBeamSearchLayer
├── sampling_layers/
│   ├── BaseSamplingLayer          # 模板方法：temperature → penalty → runSampling
│   ├── TopKSamplingLayer
│   └── TopPSamplingLayer
└── DynamicDecodeLayer             # 解码策略总调度器（持 4 种 decode layer）
```

三条主线：**attention 系列**（3 种实现 × 精度变体 × TP 装饰器）、**decode 系列**（beam search + sampling，共享 penalty 预处理）、**FFN**（与 attention 并列的 transformer 组件）。`DynamicDecodeLayer` 是 model 层直接使用的解码入口，内部按 `beam_width` 分发到 4 种策略。

## 调用链路

### UnfusedAttentionLayer::forward

```
UnfusedAttentionLayer::forward(output, input, attention_weights)   UnfusedAttentionLayer.cc:23
  输入: input_query [token_num, d_model], attention_mask [batch, 1, seqlen, seqlen]
  输出: hidden_features [token_num, hidden_units]
├── allocateBuffer() → allocator_->reMalloc(...)
├── [1] QKV Projection（is_batched_QKV_ 两种模式）:
│   ├── is_batched_QKV_=true:  cublas_wrapper_->batchedGemm()  # batch_qkv_kernel_ptr_ 传 3 组指针一次算 Q/K/V
│   └── is_batched_QKV_=false: cublas_wrapper_->Gemm() × 3      # 分别算 Q, K, V
│   # is_batched_QKV_ 由 cublas_wrapper_->isFuseBatchGemm(3, n, m, k) 决定
├── [2] Add QKV Bias + Transpose:
│   ├── padding_offset==nullptr: invokeAddQKVBiasIA3Transpose()
│   └── padding_offset!=nullptr: cudaMemsetAsync 清零 q_buf_2_ → invokeAddQKVBiasIA3RebuildPadding()
├── [3] Q*K^T Score: cublas_wrapper_->stridedBatchedGemm(OP_T, OP_N)  # scalar = 1/√d * q_scaling
├── [4] Relative Attention Bias (可选): invokeAddRelativeAttentionBias()
├── [5] Masked Softmax: invokeMaskedSoftmax(param, stream_)
├── [6] Attention * V: cublas_wrapper_->stridedBatchedGemm(OP_N, OP_N)
├── [7] Transpose: invokeTransposeQKV()
└── [8] Output Projection: cublas_wrapper_->Gemm()
```

### DecoderSelfAttentionLayer::forward（GPT 解码核心）

```
DecoderSelfAttentionLayer::forward(output, input, attention_weights)   DecoderSelfAttentionLayer.cc:459
  输入: input_query [batch, d_model], sequence_lengths, step, key_cache, value_cache
  输出: hidden_features [batch, d_model], 更新后的 key_cache/value_cache
├── [1] Fused QKV GEMM（按 int8_mode_ 选择路径）:
│   ├── int8_mode_==1: weight_only_int8_fc_runner_->gemm()  # CutlassFpAIntBGemmRunner
│   ├── int8_mode_==2: cublas_wrapper_->Int8Gemm(per_column_scaling=true)
│   └── 否则:          cublas_wrapper_->Gemm()  # n=3*local_hidden_units
├── [2] Fused Masked Multi-Head Attention:
│   fusedQKV_masked_attention_dispatch<T>(...)
│   ├── params.stride = 3 * hidden_units
│   ├── params.timestep = step + max_prefix_prompt_length - 1
│   ├── params.inv_sqrt_dh = 1.F / (sqrtf(size_per_head) * q_scaling)
│   ├── int8_mode==2 时 params.k/v 用 reinterpret_cast<int8_t*> 偏移，设 qkv_scale_out/attention_out_scale
│   └── masked_multihead_attention(params, stream)   # kernels/decoder_masked_multihead_attention
│       # 融合：add bias → rotary → cache write → Q*K^T → softmax → Attn*V → context output
└── [3] Output Projection（同样按 int8_mode_ 选择 GEMM 路径）
```

构造函数中 `FT_CHECK` 验证 `size_per_head_` 必须是 32/48/64/80/96/128/144/160/192/224/256 之一（与 MMHA kernel 支持的编译期特化值一致）。

### BaseBeamSearchLayer::forward（模板方法）

```
BaseBeamSearchLayer::forward()                     BaseBeamSearchLayer.cu:181
├── invokeAddBiasApplyPenalties(...)               # temperature + repetition + min_length penalty
├── invokeSoftMax()  ← 子类实现（纯虚）             # BeamSearchLayer: logprob + topk + update states
└── update_indir_cache_kernelLauncher(...)         # 仅 beam_width > 1 时调用，更新 cache indirection
```

`update_indir_cache_kernel` 的线程映射：`threadIdx.x` 作 time_step，`threadIdx.y + blockIdx.y*blockDim.y` 作 bb_id（batch×beam）；`bb_id >= beam_width*local_batch_size` 或 `time_step >= min(step+1, max_seq_len)` 或 `finished[bb_id]` 时 return。`time_step==step` 时 `tgt_indir_cache` 设为 `beam_id`（新选出的 beam），否则设为 `src_indir_cache[src_offset]`（沿用历史路径）。

BeamSearchLayer::invokeSoftMax():
├── invokeLogProbAddCumLogProb()                   # logits → log prob，累加 cum_log_probs
├── invokeTopkBeamSearch()                         # vocab 维度 top-k，选 beam_width 候选
└── invokeUpdateStates()                           # 更新 finished/parent_ids/sequence_length/output_ids
```

### BaseSamplingLayer::forward（模板方法）

```
BaseSamplingLayer::forward()                       BaseSamplingLayer.cc:255
├── invokeBatchApplyTemperaturePenalty()           # temperature
├── invokeBatchApplyRepetitionPenalty()  (可选)
├── invokeMinLengthPenalty()             (可选)
├── runSampling()  ← 子类实现（纯虚）
│   ├── TopKSamplingLayer: invokeAddBiasEndMask → invokeAddBiasSoftMax → invokeBatchTopKSampling
│   └── TopPSamplingLayer: invokeTopPInitialize → invokeAddBiasSoftMax → invokeBatchTopPSampling → invokeComputeToppDecay
└── freeBuffer()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `getAttentionType<T>(...)` | 运行时选 UNFUSED/FUSED attention | 按 SM 架构 + 精度 + size_per_head + seq_len 决定 |
| `BaseAttentionLayer::forward` | attention 抽象接口 | 纯虚，子类实现具体策略 |
| `UnfusedAttentionLayer::forward` | 分步 attention（cuBLAS GEMM + 自定义 kernel） | 通用性好，支持所有精度/形状 |
| `FusedAttentionLayer::forward` | TRT 融合 attention（MHARunner 单 kernel） | 性能优，但限 half/fp8 + 特定 SM/size |
| `DecoderSelfAttentionLayer::forward` | 解码 attention（fused MMHA + KV cache） | seq_len=1 场景，KV cache 增量读写 |
| `TensorParallel*::forward` | TP 装饰器（forward 前 all-reduce） | 不改核心，叠加分布式通信 |
| `BaseBeamSearchLayer::forward` | beam search 模板方法 | penalty → softmax(topk) → update cache |
| `BaseSamplingLayer::forward` | sampling 模板方法 | temperature → penalty → runSampling |
| `DynamicDecodeLayer::forward` | 解码策略总调度 | beam_width>1 走 beam search，==1 走 sampling |
| `BaseLayer::allocateBuffer/freeBuffer` | 显式 GPU buffer 管理 | 纯虚，子类实现；`is_free_buffer_after_forward_` 控制释放时机 |

</details>

## 核心实现

### BaseLayer 基类与资源注入

所有 layer 继承 `BaseLayer`，它持有三个设备环境依赖并定义显式内存管理接口：

```cpp title="BaseLayer.h"
class BaseLayer {
public:
    BaseLayer(cudaStream_t stream, cublasMMWrapper* cublas_wrapper,
              IAllocator* allocator, bool is_free_buffer_after_forward,
              cudaDeviceProp* cuda_device_prop = nullptr, bool sparse = false);
protected:
    virtual void allocateBuffer() = 0;   // 纯虚，子类必须实现
    virtual void freeBuffer()     = 0;   // 纯虚，子类必须实现
    cudaStream_t     stream_;
    cublasMMWrapper* cublas_wrapper_;
    IAllocator*      allocator_;
    bool is_free_buffer_after_forward_;  // forward 后是否立即释放中间 buffer
    bool is_allocate_buffer_ = false;    // 防 double-free
};
```

**为什么用基类 + 构造注入**：GPU 推理需统一管理 CUDA stream、cuBLAS handle 和显存分配器。构造注入让所有子类共享同一套资源，避免每层各自创建 stream 导致同步困难、重复创建 cuBLAS handle 的开销、显存碎片化。`is_free_buffer_after_forward_` 允许在单次推理（`true`，省显存）和连续推理（`false`，避免反复分配）间灵活切换——`gpt_example.cc:313` 设为 `false`，因为生成循环中每步 forward 的 batch size 固定，保留 buffer 省去重复分配开销。

### Unfused vs Fused attention 的自动选择

`BaseAttentionLayer.h:46-92` 的 `getAttentionType<T>()` 是 attention 策略选择的核心：

```cpp title="BaseAttentionLayer.h"
template<typename T>
AttentionType getAttentionType(size_t size_per_head, int sm, bool remove_padding,
                               int max_seq_len, ...);
// 返回 UNFUSED_MHA / UNFUSED_PADDED_MHA / FUSED_MHA / FUSED_PADDED_MHA 之一
```

选择条件：精度必须是 `half` 或 `__nv_fp8_e4m3`；SM 架构需在 70/72/75/80/86/89 之中；`size_per_head` 需是 32/40/64/80/128/144/160/256 等特定值；序列长度有限制（Swin 的 `max_seq_len <= 256`）。对 GPT 变体（`causal_mask=true`），满足上述条件且 `remove_padding=true` 时返回 `FUSED_MHA`，`remove_padding=false` 时返回 `UNFUSED_PADDED_MHA`。不满足时自动 fallback 到 Unfused。`AttentionType` 枚举共 4 个值：`UNFUSED_MHA`、`UNFUSED_PADDED_MHA`、`FUSED_MHA`、`FUSED_PADDED_MHA`；`isFusedMHA()` 判断是否融合、`isPaddedMHA()` 判断是否有 padding。

`FusedAttentionLayer` 用 `MHARunner`（来自 `3rdparty/trt_fused_multihead_attention`）将 QK bias add、softmax、AV 乘法融合为单次 `dispatcher_fp16->run(...)` 调用，中间 buffer 更少（无 `qk_buf_`、无分离的 `q_buf_2_`/`k_buf_2_`/`v_buf_2_`），但有 `attn_workspace_` 供 fused kernel 使用。`UnfusedAttentionLayer` 则通过多步 cuBLAS GEMM + 自定义 kernel 拼接，通用性好但中间 buffer 多。

### 显式 allocateBuffer / freeBuffer

`BaseLayer` 声明 `allocateBuffer()` / `freeBuffer()` 为纯虚函数，每个子类维护自己的 buffer 指针并在 forward 中显式管理。以 `UnfusedAttentionLayer` 为例，它持有 `q_buf_`、`k_buf_`、`v_buf_`、`qk_buf_`、`qkv_buf_` 等 8+ 个中间 buffer，全部通过 `allocator_->reMalloc()` 分配。

**为什么不用 GC / RAII 自动管理**：GPU 显存没有 GC，频繁 `cudaMalloc`/`cudaFree` 严重拖慢推理。FT 的策略是：`reMalloc` 内部缓存指针，大小够则复用（REUSE）、不够才 free+malloc（INCREASE）、过大则缩（DECREASE）；`is_free_buffer_after_forward_` 控制是否每次 forward 后释放；`is_allocate_buffer_` 标志防 double-free。这是高性能推理引擎的核心需求——生成循环中每步 forward 的 buffer shape 相同，保留它们避免上百步的重复分配。

### DynamicDecodeLayer 解码策略调度

`DynamicDecodeLayer` 是 model 层直接使用的解码入口，内部持有 4 种 decode layer 实例：

```cpp title="DynamicDecodeLayer.h"
class DynamicDecodeLayer: public BaseLayer {
private:
    DynamicDecodeBaseLayer* online_beamsearch_decode_;  // OnlineBeamSearchLayer
    DynamicDecodeBaseLayer* beamsearch_decode_;         // BeamSearchLayer
    DynamicDecodeBaseLayer* topk_decode_;               // TopKSamplingLayer
    DynamicDecodeBaseLayer* topp_decode_;               // TopPSamplingLayer
public:
    void forward(TensorMap* output_tensors, TensorMap* input_tensors);
};
```

`forward()` 中按 `beam_width` 分发：`>1` 走 beam search（`has_diff_runtime_args_` 为 true 时 `dynamic_decode_batch_size=1` 逐条处理，否则按 `local_batch_size` 批量处理；`beamsearch_decode_` 分支已废弃 `FT_CHECK(false)`，实际走 `online_beamsearch_decode_`），`==1` 同时调用 `topk_decode_->forward` 和 `topp_decode_->forward`（通过 `skip_decode` 机制让 TopK 和 TopP 互补——每个 request 按 runtime args 决定走哪条）。`stop_words_list` 存在时调 `invokeStopWordsCriterion`，`sequence_limit_length` 存在时调 `invokeLengthCriterion`（用 `h_pinned_finished_sum_` 计算 `should_stop`）。model 只需调 `dynamic_decode_layer_->forward()`，不感知 4 种策略的存在。

### BaseSamplingLayer 的 setup 与 penalty 机制

`BaseSamplingLayer::setup` 处理 `random_seed` 三种情况：`size()==1` 时 `invokeCurandInitialize` 单种子初始化；`size()==batch_size` 时 `cudaAutoCpy` 拷贝后 `invokeCurandBatchInitialize` 批量初始化；不存在时用种子 0 调 `invokeCurandInitialize`。`repetition_penalty` 和 `presence_penalty` 互斥——`FT_CHECK_WITH_INFO` 检查不能同时存在：有 `repetition_penalty` 时 `RepetitionPenaltyType=Multiplicative`，有 `presence_penalty` 时为 `Additive`，都没有时为 `None`。

`forward` 中：`skip_decode` 全为 true 时直接 return；`skip_any_` 为 true 时将 logits 拷贝到 `runtime_logits_buf_` 避免影响其他 sampling layer。`temperature` penalty 当 `embedding_bias!=nullptr` 或 temperature 不全为 1.0f 时调 `invokeBatchApplyTemperaturePenalty`；`repetition_penalty` 仅当 `step > 1` 且 `type != None` 且 penalty 值不全等于默认值时调 `invokeBatchApplyRepetitionPenalty`。

### TensorParallel 装饰器

`TensorParallelDecoderSelfAttentionLayer` 继承 `DecoderSelfAttentionLayer`，构造函数中 `FT_CHECK(head_num % tensor_para_.world_size_ == 0)` 验证 head_num 能被 TP size 整除，`local_head_num = head_num / tensor_para_.world_size_` 传给父类。`forward()` 先调父类 `DecoderSelfAttentionLayer<T>::forward()`，之后仅当 `tensor_para_.world_size_ > 1 && do_all_reduce_` 时执行 all-reduce。all-reduce 两条路径：`use_custom_all_reduce_kernel` 由 `enable_custom_all_reduce_ && custom_all_reduce_comm_ != nullptr && do_all_reduce_ && swapInternalBuffer(...)` 决定——true 时调 `customAllReduce`，false 时调 `ftNcclAllReduceSum`：

```cpp title="TensorParallelDecoderSelfAttentionLayer.cc:214-222"
if (tensor_para_.world_size_ > 1 && do_all_reduce_) {
    if (use_custom_all_reduce_kernel) {
        custom_all_reduce_comm_->customAllReduce(size, stream_);
    } else {
        ftNcclAllReduceSum(attention_out, attention_out, size, tensor_para_, stream_);
    }
}
```

这是典型装饰器——不修改核心 attention 逻辑，只叠加分布式通信。同样模式见 `TensorParallelGeluFfnLayer` / `TensorParallelUnfusedAttentionLayer`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 模板方法 | `BaseBeamSearchLayer::forward`（penalty→softmax→update 框架）、`BaseSamplingLayer::forward`（temperature→penalty→runSampling 框架） | 基类定流程骨架，子类只填 `invokeSoftMax` / `runSampling`，统一 penalty 预处理 |
| 策略 | `getAttentionType()` 选 attention 实现、`DynamicDecodeLayer` 按 beam_width 分发 | 运行时条件选最优实现，上层不感知 |
| 桥接（精度模板） | 所有 layer `template<typename T>` + 显式实例化（`float`/`half`/`__nv_bfloat16`/`__nv_fp8_e4m3`） | 算法写一遍，编译期生成各精度特化 |
| 装饰器 | `TensorParallel*` 继承基础 layer，forward 前插入 all-reduce | 不改核心逻辑叠加分布式能力 |

## 模块间交互

`layers/` 被 `models/` 的各 decoder 类调用——`ParallelGptDecoder` 用 `TensorParallelDecoderSelfAttentionLayer` + `TensorParallelGeluFfnLayer` + `DynamicDecodeLayer`；`T5Encoder` 用 `TensorParallelUnfusedAttentionLayer`；`BertLayerINT8` 用 `FusedAttentionLayerINT8`。`layers/` 调用 `kernels/` 的 host wrapper 函数（`masked_multihead_attention`、`invokeMaskedSoftmax`、`invokeTopkBeamSearch` 等），调用时 Tensor 解包为裸指针。`layers/` 依赖 `utils/` 的 `IAllocator`（buffer 分配）、`cublasMMWrapper`（GEMM）、`Tensor`/`TensorMap`（I/O 容器）、`nccl_utils`（TP 通信）、`memory_utils`（`cudaAutoCpy` 等）。INT8 量化的 attention layer 还依赖 `kernels/cutlass_kernels/` 的 `CutlassFpAIntBGemmRunner` / `CutlassInt8GemmRunner`。

## 扩展方式

**新增 attention 变体**：在 `attention_layers/` 下新建 `MyAttentionLayer.h/.cc`，继承 `BaseAttentionLayer<T>`，实现 `forward()` / `allocateBuffer()` / `freeBuffer()`，在 `.cc` 末尾添加 `template class MyAttentionLayer<float>;` 等显式实例化，在 `BaseAttentionLayer.h` 的 `AttentionType` 枚举加新类型（如需），在 model 层 attention 创建逻辑加分支，在 `CMakeLists.txt` 加源文件。

**新增 sampling 策略**：在 `sampling_layers/` 下新建 `XxxSamplingLayer.h/.cu`，继承 `BaseSamplingLayer<T>`，**只需实现 `runSampling()`**（penalty 等通用预处理已在基类），在 `DynamicDecodeLayer` 加成员 + 分发分支。

> 扩展点的契约（`BaseAttentionLayer` / `BaseSamplingLayer` 接口）见概览「架构设计解析 > 核心概念」。
