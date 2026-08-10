---
source:
  type: "源码解读"
  project: "fastertransformer"
  url: "https://github.com/NVIDIA/FasterTransformer"
title: "Kernels"
date: "2026-08-10T14:00:00+08:00"
category: [AI, Infra, Inference, FasterTransformer, CodeWiki, "5.3"]
tags: ["FasterTransformer", "CUDA", "Fused Kernel", "MMHA", "推理加速"]
description: "FasterTransformer 的 CUDA 算子层——fused masked multihead attention、layernorm、beam search、sampling、custom all-reduce 等 43K 行 kernel 的设计与优化原理。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/00-overview)

---

## 模块定位

`kernels/` 是 FasterTransformer 的**性能引擎**——43,359 行 CUDA 代码（131 个文件），承载所有决定推理速度的 fused kernel。它不依赖任何上层（models / layers），只依赖 `utils/` 的 `memory_utils`（`deviceMalloc`/`deviceFree`）和 `Tensor`。上层 layer 通过调用 kernel 的 host wrapper 函数（`invokeXxx` / `masked_multihead_attention` 等）来 launch kernel，传入裸指针 + `cudaStream_t`。

这个模块解决的核心问题是：**通用框架（PyTorch/TF）的 eager 模式会把 transformer 的每一步拆成独立的 kernel 调用，每次读写显存的开销累积起来严重拖慢推理**。FT 的做法是把频繁连续的操作融合成单个 kernel——最典型的是 `decoder_masked_multihead_attention`，将 QKV bias add、rotary embedding、KV cache 读写、Q\*K^T、softmax、attention\*V 全部融合，中间结果只留在 shared memory / register，不落 global memory。

## 模块架构

`kernels/` 内部按功能分为几组，每组解决 transformer 推理的一个环节：

```
kernels/
├── decoder_masked_multihead_attention*.cu   # Fused MMHA（解码阶段，最核心）
│   ├── decoder_masked_multihead_attention.cu          # 多精度入口 + size_per_head 分发
│   ├── decoder_masked_multihead_attention_32.cu       # Dh=32 特化
│   ├── decoder_masked_multihead_attention_64.cu       # Dh=64 特化
│   ├── decoder_masked_multihead_attention_128.cu      # Dh=128 特化（含 FP8）
│   ├── decoder_masked_multihead_attention_template.hpp # 核心模板实现
│   └── decoder_masked_multihead_attention_utils.h     # 向量类型映射工具
├── unfused_attention_kernels.cu / .h        # 非融合 attention 组件（encoder 阶段）
├── layernorm_kernels.cu / activation_kernels.cu        # LayerNorm + 激活（含 add_bias_residual 融合）
├── beam_search_topk_kernels.cu              # Beam search top-k
├── sampling_topk_kernels / sampling_topp_kernels       # TopK / TopP 采样
├── decoding_kernels.cu                      # 解码辅助（初始化、gather）
├── custom_ar_kernels.cu / .h                # 自定义 all-reduce（多 GPU）
├── gpt_kernels.cu                           # GPT 专用（embedding lookup、tile inputs）
├── cutlass_kernels/                         # CUTLASS GEMM（INT8/FP8 混合精度）
└── *_int8_*.cu / *_fp8_*.cu                 # 量化变体（按精度分文件）
```

核心组件有三条主线：**Fused MMHA**（解码 attention 融合，按 `Dh` 编译期特化）、**unfused attention 组件**（encoder/context 阶段的分步 kernel，配合 cuBLAS GEMM）、**decode 组件**（beam search + sampling + decoding 辅助）。此外 `custom_ar_kernels` 实现绕过 NCCL 的 all-reduce，`cutlass_kernels/` 提供 INT8/FP8 混合精度 GEMM。

## 调用链路

上层 layer 调用 kernel 的典型路径——以 `DecoderSelfAttentionLayer` 调用 fused MMHA 为例：

```
DecoderSelfAttentionLayer::forward()           layers/attention_layers/DecoderSelfAttentionLayer.cc
├── cublas_wrapper_->Gemm(QKV projection)      # 先用 cuBLAS 算 Q*K_proj
└── fusedQKV_masked_attention_dispatch<T>(...)  # 调 host wrapper
    └── masked_multihead_attention(params, stream)   # decoder_masked_multihead_attention.h
        └── mmha_launch_kernel<T, Dh, Dh_MAX, ...>(params, stream)  # 按 Dh 分发
            └── masked_multihead_attention_kernel<...><<<grid, block>>>(params)  # 实际 CUDA kernel
                # 内部融合：add bias → rotary → cache write → Q*K^T loop → softmax → Attn*V → output
```

各 layer 与 kernel 的调用关系汇总：

| layer | 调用的 kernel 函数 | kernel 文件 |
|-------|-------------------|------------|
| `UnfusedAttentionLayer` | `invokeAddQKVBiasIA3Transpose`、`invokeMaskedSoftmax`、`invokeTransposeQKV` | `unfused_attention_kernels.h` |
| `FusedAttentionLayer` | `trt_add_QKV_bias`、`MHARunner::run` | `3rdparty/trt_fused_multihead_attention` |
| `DecoderSelfAttentionLayer` | `masked_multihead_attention` | `decoder_masked_multihead_attention.h` |
| `BeamSearchLayer` | `invokeTopkBeamSearch`、`invokeLogProbAddCumLogProb`、`invokeUpdateStates` | `beam_search_topk_kernels.h` |
| `BaseBeamSearchLayer` | `invokeAddBiasApplyPenalties`、`update_indir_cache_kernelLauncher` | `beam_search_penalty_kernels.h` |
| `BaseSamplingLayer` | `invokeBatchApplyTemperaturePenalty`、`invokeBatchApplyRepetitionPenalty`、`invokeMinLengthPenalty` | `sampling_penalty_kernels.h` |
| `TopKSamplingLayer` | `invokeAddBiasEndMask`、`invokeAddBiasSoftMax`、`invokeBatchTopKSampling` | `sampling_topk_kernels.h` |
| `TopPSamplingLayer` | `invokeTopPInitialize`、`invokeAddBiasSoftMax`、`invokeBatchTopPSampling` | `sampling_topp_kernels.h` |
| `ParallelGptDecoder` | `invokeGeneralLayerNorm`、`invokeAddBiasResidualLayerNorm` | `layernorm_kernels.h` |
| TP layer（多 GPU） | `invokeOneOrTwoShotAllReduceKernel` | `custom_ar_kernels.h` |

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `masked_multihead_attention` | Fused MMHA host wrapper | 按 `Dh` 编译期特化，消除运行时分支 |
| `mmha_launch_kernel` | 按 `size_per_head` switch 分发 | `Dh` 必须编译期已知，每个值一个 `.cu` 文件 |
| `invokeMaskedSoftmax` | 带 mask + ALiBi 的 softmax | 自定义 kernel 比 cuBLAS 更快（融合 mask） |
| `invokeAddQKVBiasIA3Transpose` | QKV 加 bias + IA3 + 转置 | 融合 3 个操作减少显存读写 |
| `invokeTopkBeamSearch` | Beam search top-k 选择 | 自定义 top-k kernel（排序 + 状态更新） |
| `invokeBatchTopKSampling` | 批量 top-k 采样 | 每个 request 独立 k 值 |
| `invokeGeneralLayerNorm` | LayerNorm | 模板 `int8_mode` 控制输出精度 |
| `generalAddBiasResidualLayerNormOpt` | LayerNorm + add bias + add residual 融合 | 3 操作融合，减少 2 次 global memory 读写 |
| `invokeOneOrTwoShotAllReduceKernel` | Custom all-reduce | P2P 直访 peer 显存，跳过 NCCL |

</details>

## 核心实现

### Fused Masked Multi-Head Attention（`decoder_masked_multihead_attention`）

这是 FT 最核心的 kernel，解码阶段的 attention 全靠它。非融合实现需要 7+ 步（QKV GEMM → add bias → transpose → Q\*K^T GEMM → softmax → Attn\*V GEMM → transpose），每步都读写 global memory。Fused 版本把整个流程压进单个 kernel，中间结果只留在 shared memory 和 register。

核心模板函数 `masked_multihead_attention_kernel`（`decoder_masked_multihead_attention_template.hpp`）的工作模式：每个 CUDA block 处理一个 batch × head 的 attention，block 内线程沿 sequence 维度遍历历史 K/V cache，计算 Q\*K^T 点积，warp reduce 后 softmax，再与 V 做加权求和。KV cache 直接在 global memory 上读（通过 `K_cache` / `V_cache` 指针），新 token 的 K/V 在 kernel 内计算后写入 cache。

```cpp title="decoder_masked_multihead_attention.cu"
// 多精度入口：按 size_per_head 分发到编译期特化
// 支持 11 种值：32/48/64/80/96/128/144/160/192/224/256
// 每个 case 的第二参数是 Dh，第三参数是 Dh_MAX（取 >= Dh 的最小 2 的幂或 16 倍数）
switch (params.hidden_size_per_head) {
    case 32:  mmha_launch_kernel<T, 32, 64>(params, stream);  break;   // Dh_MAX=64
    case 48:  mmha_launch_kernel<T, 48, 64>(params, stream);  break;   // Dh_MAX=64
    case 64:  mmha_launch_kernel<T, 64, 64>(params, stream);  break;   // Dh_MAX=64
    case 80:  mmha_launch_kernel<T, 80, 128>(params, stream); break;   // Dh_MAX=128
    case 96:  mmha_launch_kernel<T, 96, 128>(params, stream); break;   // Dh_MAX=128
    case 128: mmha_launch_kernel<T, 128, 128>(params, stream); break;  // Dh_MAX=128
    case 144: case 160: case 192: case 224: case 256:
        mmha_launch_kernel<T, ..., 256>(params, stream); break;        // Dh_MAX=256
    default: assert(false);  // 不支持其他值
}
```

kernel 的 grid 维度为 `dim3(params.num_heads, params.batch_size)`——每个 batch × head 对分配一个 threadblock。shared memory 包含 `qk_smem`（float\*，Q\*K^T 分数）、`logits_smem`（softmax 中间值）、`out_smem`（输出）、`q_smem[Dh_MAX]`（当前 Q 向量）和 `red_smem`（warp 归约缓冲）。`static_assert(Dh_MAX % THREADS_PER_KEY == 0)` 保证向量加载对齐。

**为什么按 `Dh` 编译期特化**：kernel 内部用 `Dh` / `Dh_MAX` 决定向量类型（`uint16_t` / `float4` 等）和 shared memory 大小，这些必须编译期常量。运行时 switch 代价远小于每次 kernel 调用省下的分支开销。每个 `Dh` 值一个 `.cu` 文件（`_32.cu` / `_64.cu` / `_128.cu`），各自 `#include` 同一份 `template.hpp` 并显式实例化。

**精度模板**：`T` = `float` / `half` / `__nv_bfloat16` / `__nv_fp8_e4m3`，算法逻辑（Q\*K^T + softmax + V\*softmax）相同，但向量加载类型不同。模板特化在编译期消除 if-else，编译器看到完整类型信息做优化。FP8 特殊处理（`decoder_masked_multihead_attention_template.hpp:1123-1128`）：`constexpr bool FP8_MHA_KERNEL` 编译期分支，logits 计算时乘以 scale factor 的平方，K cache 加载时先转 `float4` 再计算（FP8 无法直接 FMA）。

### 按 tlength 动态选择线程配置

`decoder_masked_multihead_attention_32.cu:49-70` 根据 `tlength`（当前序列长度）选择三套线程配置，这是一个关键的运行时自适应优化：

| tlength | THREADS_PER_KEY | THREADS_PER_BLOCK | 设计理由 |
|---------|----------------|-------------------|---------|
| < 32 | 4 | 64 | 序列极短，4 线程合作算 1 个 key 的点积，避免线程空闲 |
| < 2048 | 2 | 128 | 中等长度，2 线程/key，平衡并行度和归约开销 |
| >= 2048 | 1 | 256 | 长序列，1 线程/key，最大化并行度 |

Q\*K^T 循环中（`template.hpp:1516-1593`），每个线程处理 `Dh/THREADS_PER_KEY` 个元素。序列短时 K 的 timestep 少，若 1 线程/key 则 block 内大量线程空闲；用 4 线程/key 让每个 key 的点积由 4 线程并行计算再 warp reduce，提高短序列 GPU 利用率。序列长时 timestep 多，1 线程/key 让更多 timestep 并行。

### Unfused Attention 组件（encoder/context 阶段）

Context 阶段（prefill）的 attention 不用 fused MMHA——因为它要并行处理所有 input token（sequence length > 1），而 fused MMHA 优化的是 sequence length = 1 的解码场景。Context attention 用 cuBLAS `stridedBatchedGemm` 做 Q\*K^T 和 Attn\*V（充分利用 tensor core），只在 bias add、transpose、softmax 这些 cuBLAS 不擅长的步骤用自定义 kernel：

```cpp title="unfused_attention_kernels.h"
// QKV 加 bias + IA3 + 转置——融合 3 个操作
void invokeAddQKVBiasIA3Transpose(T*           q_buf,
                                  T*           k_buf,
                                  T*           v_buf,
                                  T*           q_buf_2,  // 输出：[batch, head, seq_len, size_per_head]
                                  ...);

// 带 mask + ALiBi 的 softmax——比 cuBLAS 更快（融合 mask）
void invokeMaskedSoftmax(MaskedSoftmaxParam<T>& param, cudaStream_t stream);
```

`invokeMaskedSoftmax` 之所以不用 cuBLAS 的 softmax，是因为它要同时融合 attention mask（causal mask + padding mask）和 ALiBi 位置偏置（`linear_bias_slopes`），这些是 cuBLAS 通用算子不支持的。`MaskedSoftmaxParam<T, T_IN>` 结构体含 `attention_score`、`qk`、`attention_mask`、`batch_size`、`q_length`、`k_length`、`num_heads`、`qk_scale` 字段，以及可选的 `linear_bias_slopes`（ALiBi）。

`unfused_attention_kernels.h` 还声明了 `invokeAddFusedQKVBiasTranspose` 的两个重载：简化版（无 PrefixPrompt、无 rotary）和完整版（带 `PrefixPromptBatchWeightsParam`、`rotary_embedding_dim`、`neox_rotary_style`、`scale`、`int8_mode`）。简化版内部委托调用完整版，传入默认值和 `rotary_embedding_dim=0`。

### LayerNorm + Add Bias + Add Residual 融合

`layernorm_kernels.cu` 的 `generalAddBiasResidualLayerNormOpt` 将 LayerNorm、add bias、add residual 三个操作融合成单个 kernel。非融合实现需要：读 residual → 加 bias → 写回 → 读回做 LayerNorm → 写回，4 次 global memory 读写。融合后只需 1 次读 + 1 次写。

通过模板参数 `int8_mode` 和 `dynamic_scale` 控制行为：`int8_mode==2` 时输出 int8（`layernorm_kernels.cu:133-136`），`dynamic_scaling` 时做 per-token 动态量化（`:142-152`）。

`invokeGeneralAddBiasResidualPreLayerNorm` 按 `opt_version` 和数据类型选择 kernel：`opt_version > 0` 且 `sizeof(T)==2`（half/bf16）且 `n%2==0` 时走 half2/bfloat162 优化路径（多层 dispatch 链选 unroll_factor × residual_num × is_bias × is_output × opt_version 组合）；否则走标量 float 路径。两个核心 kernel 的累加方式不同：`generalAddBiasResidualLayerNormOpt` 两阶段——先循环用 `T` 类型 `local_sum` 做 `hadd2` 累加求均值，再第二个循环算 variance；`generalAddBiasResidualLayerNormOpt2` 单循环 Welford 风格——同一个循环中用 `float` 同时累加 `x_sum` 和 `x2_sum`，通过 `blockReduceSumV2<float, 2>` 一次归约。当 shared memory 超过 48KB 时调 `cudaFuncSetAttribute(cudaFuncAttributeMaxDynamicSharedMemorySize, maxbytes)` 启用动态 shared memory。

### Beam Search 与 Sampling Kernel

`beam_search_topk_kernels.cu` 的 `invokeTopkBeamSearch` 实现自定义 top-k：对 vocab 维度做 top-k 选择，选出 `beam_width` 个候选，同时更新 `finished`、`parent_ids`、`sequence_length`、`output_ids` 状态。不用 `thrust::top_k` 是因为它无法同时做 beam search 的状态更新——这里需要知道每个候选来自哪个 parent beam，以维护 beam search 的路径。

`invokeTopkBeamSearch` 按 `diversity_rate` 分发两条路径：`diversity_rate == 0.0f` 时走 `topk_stage_1_opt3` + `topk_stage_2_opt3`（用 `CASE_K` 宏支持 beam_width=1/4/10/16/32/64，不在预设值时 fallback 到 `topk_stage_1_opt2_general`）；`diversity_rate != 0.0f` 时走 `beam_topK_kernel` + `batch_topK_kernel`（用 `CASE_K_DIV` 宏支持 beam_width=1/4/16/32/64，不在预设值时 `FT_CHECK_WITH_INFO(false)` 报错）。`topk_stage_1_opt3` 中 `finished[row_id]==true` 的 beam 仅由 `block_lane==0 && tid==0` 写入 `end_id` 对应的 log_prob（其余写 -1 和 -MAX_T_VAL），然后 return——保证已完成的 beam 不再参与搜索。`apply_length_penalty` 计算 `log_prob / powf(length, length_penalty)`，当 `length_penalty==0.0f` 或 `length==1` 时直接返回。

`invokeBatchTopKSampling` / `invokeBatchTopPSampling` 支持同 batch 内每个 request 独立 k/p 值，这是 `DynamicDecodeLayer` 实现"同 batch 混合 TopK/TopP"的底层支撑。

### Custom All-Reduce Kernel

`custom_ar_kernels.cu` 的 `invokeOneOrTwoShotAllReduceKernel` 实现绕过 NCCL 的 all-reduce。通过 `cudaDeviceEnablePeerAccess` 建立 P2P 显存访问，每个 GPU 在其他 GPU 显存上分配通信 buffer，kernel 直接读写 peer 显存完成归约。`AbstractCustomComm::swapInternalBuffer` 通过指针交换避免额外拷贝。限制：仅支持 DGX A100 的 8-GPU 节点内场景（`RANKS_PER_NODE=8` 检查）。

`AllReduceParams<T>` 结构体（`custom_ar_kernels.h`）含 `elts_total`、`elts_per_rank`、`elts_per_block`、`rank_offset`、`rank`、`local_rank`、`node_id`、`barrier_flag` 字段，以及 `peer_barrier_ptrs[RANKS_PER_NODE]` 和 `peer_comm_buffer_ptrs[RANKS_PER_NODE]` 数组 + `local_output_buffer_ptr`。关键常量：`CUSTOM_AR_SIZE_THRESHOLD=50331648`（48MB，通信 buffer 上限）、`DEFALUT_ALGO_AR_SIZE_THRESHOLD=196608`（one-shot/two-shot 切分点，注意源码拼写为 `DEFALUT`）、`MAX_ALL_REDUCE_BLOCKS=24`。`invokeOneOrTwoShotAllReduceKernel` 按 `elts_total <= 196608` 选 one-shot（`kernel_algo=0`，单次完成）或 two-shot（`kernel_algo=1`，分两轮降低显存压力）。`FLAG(a)` 宏定义为 `((uint32_t)((a) % 0x146))`，用于 barrier 同步。

**为什么不用 NCCL**：NCCL 是通用多 GPU 通信库，需处理跨节点网络，对节点内 NVLink/NVSwitch 拓扑不是最优。Custom all-reduce 跳过 NCCL 协议栈，直接用 P2P load/store，在 8-GPU 节点内延迟更低。TP layer 中优先用 custom、回退 NCCL（`TensorParallelGeluFfnLayer.cc:44-59`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 模板特化（精度 + Dh） | `template<typename T, int Dh, int Dh_MAX>` + 各 `.cu` 显式实例化 | 编译期消除精度/形状分支，编译器全类型可见做优化 |
| Host Wrapper | `invokeXxx` / `masked_multihead_attention` 函数 | 隔离 kernel launch 细节，layer 只调函数不碰 `<<<grid,block>>>` |
| 按精度分文件 | `*_kernels.cu` / `*_int8_kernels.cu` / `*_fp8_kernels.cu` | int8/fp8 内存布局差异大（Col32、scale factor），强行模板化可读性骤降且编译爆炸 |
| 运行时自适应 | `tlength` → THREADS_PER_KEY 选择 | 序列长度变化大，固定配置无法兼顾短/长序列的 GPU 利用率 |

## 模块间交互

`kernels/` 被 `layers/` 的各 attention / beam search / sampling layer 直接调用（函数调用，非事件/接口），调用时 Tensor 被解包为裸指针 + 标量参数 + `cudaStream_t`。`kernels/` 依赖 `utils/memory_utils.h`（`deviceMalloc`/`deviceFree`）和 `utils/Tensor.h`（少数 wrapper 用）。`cutlass_kernels/` 子目录被 INT8/FP8 的 attention layer 调用（`CutlassFpAIntBGemmRunner`、`CutlassInt8GemmRunner`）。`custom_ar_kernels` 被 `utils/custom_ar_comm.cc` 的 `invokeOneOrTwoShotAllReduceKernel` 调用，上层 TP layer 通过 `AbstractCustomComm` 接口间接触发。

## 扩展方式

**新增 fused kernel**：在 `kernels/` 下新建 `.cu` + `.h`，实现 `__global__` kernel 和 `void invokeXxx(...)` host wrapper，在 `CMakeLists.txt` 加入编译目标，在对应 layer 中调用 wrapper。

**新增 size_per_head**：新建 `decoder_masked_multihead_attention/decoder_masked_multihead_attention_N.cu`，实例化 `mmha_launch_kernel<T, N, Dh_MAX>`，在 `decoder_masked_multihead_attention.cu` 的 switch 加 `case N:`。

**新增 sampling 策略**：新建 `sampling_xxx_kernels.cu`，实现 `__global__ void xxx_sampling_kernel` + `void invokeXxxSampling`，在 `BaseSamplingLayer` 子类的 `runSampling` 中调用。

> 扩展点的契约（精度模板、host wrapper 命名）见概览「架构设计解析 > 核心概念」。
