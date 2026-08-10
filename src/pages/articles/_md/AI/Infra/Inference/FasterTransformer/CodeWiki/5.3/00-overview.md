---
source:
  type: "源码解读"
  project: "fastertransformer"
  url: "https://github.com/NVIDIA/FasterTransformer"
title: "Overview"
date: "2026-08-10T14:00:00+08:00"
category: [AI, Infra, Inference, FasterTransformer, CodeWiki, "5.3"]
tags: ["FasterTransformer", "C++/CUDA", "Transformer 推理加速", "Fused Kernel", "Tensor Parallel"]
description: "NVIDIA FasterTransformer 是基于 CUDA/cuBLAS 的高度优化 transformer 推理库。本文从分层架构、fused kernel、多 GPU 并行到核心模块，全面解读 v5.3 的内部原理。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v5.3（2023-01）· **协议** Apache-2.0 · **语言** C++ / CUDA（主体）+ Python/PyTorch/TF 绑定 · **代码量** src 约 95,000 行（397 文件）· **仓库** [GitHub](https://github.com/NVIDIA/FasterTransformer)

> ⚠️ FasterTransformer 开发已迁移至 [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM)，本仓库不再更新。v5.3 是最后一个 release，但其 fused kernel 设计、Megatron 式 tensor parallel、GEMM 自动调优等思想被 TensorRT-LLM 直接继承，仍是理解 NVIDIA 推理栈的绝佳教材。

---

## 总览

### 项目简介

FasterTransformer（简称 FT）是 NVIDIA 开源的 **transformer encoder/decoder 高度优化推理库**，基于 CUDA、cuBLAS、cuBLASLt 和 C++ 构建。它不是通用的深度学习框架，而是一组**手写的高性能 CUDA kernel + C++ 编排层**，直接将 transformer 推理的每一步（attention、FFN、layernorm、beam search、sampling）映射到 GPU 上的最优实现，绕过框架开销。

**核心价值**：把"在 GPU 上高效跑一次 transformer forward"这件事做到极致——fused masked multihead attention 将 QKV bias add、rotary embedding、KV cache 更新、Q\*K^T、softmax、attention\*V 融合成单个 kernel 调用；cuBLAS GEMM 离线自动调优选择最优算法；Megatron 式 tensor parallel + pipeline parallel 支持多 GPU 多节点推理。官方实测在 T4 上比 PyTorch TorchScript 快 4-6x（FP16），配合 INT8 可达 5x 以上加速。

**核心使用场景**：在线 LLM 推理服务（通过 Triton backend 部署）、多 GPU 多节点大模型推理（GPT-3 175B、BLOOM 等）、encoder/decoder 模型加速（BERT、T5、BART）、视觉 transformer（ViT、Swin）。

**项目边界**：负责推理计算本身（kernel 实现、模型编排、多 GPU 通信、权重加载）；不负责训练、不实现自研的通用算子库（依赖 cuBLAS/CUTLASS）、不提供完整的 serving 中间件（Triton backend 是适配层，调度由 Triton Inference Server 负责）。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|----------|------|
| Fused Masked Multi-Head Attention | `kernels/decoder_masked_multihead_attention.cu` | 解码阶段 attention 单 kernel 融合，FT 最核心优化 |
| Fused QKV-to-Context (TRT) | `layers/attention_layers/FusedAttentionLayer` + `3rdparty/trt_fused_multihead_attention` | encoder/context 阶段融合 attention（来自 TensorRT） |
| Tensor Parallel（Megatron 式） | `layers/attention_layers/TensorParallel*` + `utils/nccl_utils` | QKV 按行切、FFN 按列切，每层仅需 2 次 all-reduce |
| Pipeline Parallel | `models/multi_gpu_gpt/ParallelGptDecoder` + `ftNcclSend/Recv` | 按 layer 切分，micro-batch 流水填充气泡 |
| Custom All-Reduce | `utils/custom_ar_comm` + `kernels/custom_ar_kernels` | 绕过 NCCL，P2P 直访显存，8-GPU 节点内更低延迟 |
| GEMM 自动调优 | `utils/gemm_test/` + `utils/cublasAlgoMap` | 离线遍历 cublasLt 算法，结果写入 `gemm_config.in` |
| 多精度推理 | 模板参数 `T` + 条件编译 | FP32 / FP16 / BF16 / INT8 / FP8 同一套代码 |
| Beam Search / Sampling | `layers/beam_search_layers/` + `layers/sampling_layers/` | TopK、TopP、beam search，`DynamicDecodeLayer` 统一调度 |
| KV Cache 复用 | `ParallelGpt::allocateBuffer` 中的 `key_cache_` / `value_cache_` | 避免重算历史 K/V，生成阶段增量追加 |
| 内存复用 | `is_free_buffer_after_forward_` + `reMalloc` REUSE 策略 | 多层 decoder 共享同一 buffer，GPT-3 的 96 层只需 1/96 显存 |
| 框架集成 | `triton_backend/`、`th_op/`、`tf_op/`、`tensorrt_plugin/` | Triton / PyTorch / TensorFlow / TensorRT 四路接入 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| CUDA | 核心 | GPU 编程模型，所有 kernel 的基础 |
| cuBLAS / cuBLASLt | 核心 | GEMM 计算 + 算法自动调优 |
| CUTLASS | 核心 | INT8/FP8 混合精度 GEMM（`cutlass_extensions/`） |
| NCCL | 核心 | 多 GPU 通信（all-reduce / send / recv） |
| MPI | 核心 | 多节点进程管理 + NCCL 拓扑建立 |
| TensorRT fused MHA | 可选 | encoder 阶段融合 attention kernel（`3rdparty/trt_fused_multihead_attention`） |
| PyTorch C++ API | 可选 | PyTorch OP 绑定（`th_op/`） |
| TensorFlow C++ API | 可选 | TensorFlow OP 绑定（`tf_op/`） |
| Triton Backend API | 可选 | Triton Inference Server 后端（`triton_backend/`） |
| cuDNN | 可选 | 部分 conv 操作（WeNet） |

### 版本历史

FT 的演进脉络清晰反映了大模型推理技术的发展：

| 时间 | 版本 | 关键里程碑 |
|------|------|-----------|
| 2019 | v1.0 | BERT encoder 推理，FP16 + Tensor Core |
| 2020 | v3.0 | INT8 量化（Turing+）、Decoder/Decoding 模块 |
| 2022-05 | v5.1 | BF16 支持、OPT、多节点多 GPU BERT |
| 2022-12 | v5.2 | BLOOM、fused MHA in GPT、min length penalty、T5 MoE |
| 2023-01 | v5.3 | GPT MoE、FP8（Bert/GPT，实验性）、DeBERTa —— **最终版本** |

v5.3 之后 NVIDIA 将推理栈整合到 TensorRT-LLM，FT 的 fused kernel、tensor parallel 切分策略、GEMM 调优机制被直接继承。

---

## 快速上手

以 C++ GPT example 为例（最贴近 FT 核心的入口）：

```bash
# 1. 构建（需要 CUDA 11+，建议 11.8 以启用 FP8）
mkdir build && cd build
cmake -DSM=80 -DCMAKE_BUILD_TYPE=Release ..
make -j12 gpt_example

# 2. 离线 GEMM 调优（首次必跑，生成 gemm_config.in）
./bin/gpt_gemm 8 1 512 12 64 3072 50257 1 0 0
# 参数：batch beam max_input_len head_num size_per_head inter_size vocab tp_size is_append

# 3. 修改 gpt_config.ini 指向你的模型权重目录（.bin 格式）
#    [ft_instance_hyperparameter] model_dir=.../1-gpu

# 4. 运行推理
./bin/gpt_example ../examples/cpp/gpt/gpt_config.ini
```

预期输出：控制台打印每个 step 的延迟，最终将生成的 token 序列写入 `output` 文件。`data_type=fp16` 时在 A100 上单 batch 短输入的 step 延迟通常在毫秒级。

> 多 GPU 推理用 `mpirun -n 8 ./bin/multi_gpu_gpt_example ...`，进程数 = `tensor_para_size × pipeline_para_size`。PyTorch 绑定用 `python examples/pytorch/gpt/multi_gpu_gpt_example.py --tensor_para_size=8`。

---

## 架构设计解析

### 系统架构

FasterTransformer 采用**严格的五层分层架构**，依赖方向自上而下单向流动——上层调用下层，下层不知道上层存在。这种设计让核心计算（kernel）完全独立于框架（Triton/PyTorch/TF），同一套 kernel 可以通过不同的绑定层接入任意框架。

![FasterTransformer 分层架构](/vibe-reading/images/articles/fastertransformer-internals/architecture.svg)

五层各自解决一个明确问题：**框架集成层**隔离外部协议（Triton/PyTorch/TF/TensorRT 各有不同调用约定），保护核心计算不受接口变化影响；**模型编排层**将 transformer 的"多层 block 循环 + embedding + lm_head"编排成完整 forward 流程，并管理权重加载与多 GPU 切分；**层模块层**封装单个 transformer 组件（attention、FFN、beam search）的逻辑，在 cuBLAS GEMM 和 CUDA kernel 之间做桥接；**算子层**是性能核心，所有 fused kernel 在此实现，决定 FT 的速度上限；**基础设施层**提供 Tensor 抽象、内存分配、cuBLAS 封装、NCCL 通信等运行时支撑，被所有上层共享。

层间协作的关键设计是：**上层只通过 `TensorMap*`（string-keyed 张量表）和权重指针与下层通信**，CUDA stream / cuBLAS handle / allocator 通过构造函数注入向下传递，所有层共享同一套设备资源——这避免了每层各自创建 stream 导致的同步困难。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|-------------------------|
| 框架集成层 | `triton_backend/`、`th_op/`、`tf_op/`、`tensorrt_plugin/` | 隔离外部协议，将框架请求翻译为 FT 内部 `TensorMap`，保护核心不受接口变化影响 |
| 模型编排层 | `models/` | 编排完整 forward 流程，管理权重加载、tensor/pipeline parallel 切分、context/generation 两阶段调度 |
| 层模块层 | `layers/` | 封装 transformer 组件逻辑，在 cuBLAS GEMM 与 fused kernel 间桥接，提供 Unfused/Fused 策略选择 |
| 算子层 | `kernels/`、`cutlass_extensions/` | 承载所有 fused CUDA kernel，是性能核心，决定推理速度上限 |
| 基础设施层 | `utils/` | 提供 Tensor / IAllocator / cublasMMWrapper / nccl_utils，统一设备资源管理与 GEMM 调优 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 模板方法 | `BaseLayer::allocateBuffer/freeBuffer`（纯虚）+ `BaseBeamSearchLayer::forward`（固定流程框架） | 基类定义流程骨架，子类只填具体策略，统一内存管理与 decode 流程 |
| 策略 | `getAttentionType()` in `BaseAttentionLayer.h` + `DynamicDecodeLayer` 持 4 种 decode | 运行时根据 SM 架构/精度选 Unfused/Fused attention；根据 beam_width 选 beam search/sampling |
| 桥接（精度模板） | 所有 layer 的 `template<typename T>` + 显式实例化 | 算法代码写一遍，编译期为 float/half/bf16/fp8 各生成特化，消除运行时分支 |
| 装饰器 | `TensorParallelDecoderSelfAttentionLayer` 继承 `DecoderSelfAttentionLayer` | 不改核心逻辑，在 forward 前插入 all-reduce 通信，叠加分布式能力 |
| 接口/实现分离 | `IAllocator` + `Allocator<CUDA/TF/TH>` 三特化 | 上层通过 `IAllocator*` 用内存，底层可复用 PyTorch/TF 的 caching allocator 或独立内存池 |
| Wrapper/Facade | `cublasMMWrapper` 封装 cublasHandle + cublasLtHandle + algoMap + mutex + workspace | 调用方不感知 descriptor 创建/销毁、算法选择、workspace 管理细节 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|----------|----------|
| `Tensor` | 非拥有式数据描述符（where + type + shape + data 裸指针） | 由调用方持有，layer 间传递引用 | 包装 `IAllocator` 分配的内存或外部框架 buffer |
| `TensorMap` | `unordered_map<string, Tensor>` 包装，模型 I/O 容器 | 单次 forward 内有效 | 所有 layer 的 forward 输入输出统一载体 |
| `IAllocator` | GPU 内存分配抽象，`reMalloc` 实现 REUSE/INCREASE/DECREASE | 整个引擎生命周期 | 被 `BaseLayer` 持有，所有 layer 共享 |
| `cublasMMWrapper` | cuBLAS GEMM 封装 + 算法表查询 | 整个引擎生命周期 | 被 `BaseLayer` 持有，layer 调 `Gemm()` 做 linear projection |
| `NcclParam` | NCCL 通信域（rank + world_size + comm） | 整个引擎生命周期 | tensor_para / pipeline_para 各一个，layer 间传递 |
| `ParallelGptWeight` | GPT 全部权重（按 layer 组织的 vector） | 模型生命周期 | 含 `vector<ParallelGptDecoderLayerWeight>`，每层 20 个权重指针 |
| `AttentionWeight<T>` | 单层 attention 权重（query_weight + output_weight，各含 kernel+bias） | 模型生命周期 | 被 attention layer 的 forward 引用 |

```
ParallelGpt
 ├── ParallelGptWeight
 │    └── vector<ParallelGptDecoderLayerWeight>  (num_layer / pp 个)
 │         ├── self_attention_weights (AttentionWeight: QKV kernel+bias, output kernel+bias)
 │         └── ffn_weights (FfnWeight: intermediate kernel+bias, output kernel+bias)
 ├── ParallelGptContextDecoder  ──→ TensorParallelGptContextAttentionLayer + FfnLayer
 ├── ParallelGptDecoder          ──→ TensorParallelDecoderSelfAttentionLayer + FfnLayer
 └── DynamicDecodeLayer          ──→ BeamSearchLayer / TopKSamplingLayer / TopPSamplingLayer
```

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|----------|--------|----------|
| `BaseLayer` | `layers/BaseLayer.h` | 所有 layer 基类 | 构造函数注入 stream/cublas/allocator |
| `BaseAttentionLayer<T>` | `layers/attention_layers/BaseAttentionLayer.h` | `UnfusedAttentionLayer`、`FusedAttentionLayer`、`DecoderSelfAttentionLayer` | `getAttentionType()` 运行时决定，model 层 `new` 对应类 |
| `DynamicDecodeBaseLayer` | `layers/DynamicDecodeBaseLayer.h` | `BeamSearchLayer`、`TopKSamplingLayer`、`TopPSamplingLayer`、`OnlineBeamSearchLayer` | `DynamicDecodeLayer::initialize()` 创建全部 4 个，forward 分发 |
| `IAllocator` | `utils/allocator.h` | `Allocator<CUDA>`、`Allocator<TF>`、`Allocator<TH>` | `AllocatorType` enum + 模板特化，构造时选择 |
| `AbstractCustomComm` | `utils/custom_ar_comm.h` | `CustomAllReduceComm<T>` | `enable_custom_all_reduce` 时创建，注入 TP layer |

---

## 代码目录

```
FasterTransformer/
├── src/fastertransformer/          # 核心库（~95,000 行）
│   ├── kernels/                    # CUDA 算子（43K 行，性能核心）
│   │   ├── decoder_masked_multihead_attention*.cu   # Fused MMHA（最核心）
│   │   ├── unfused_attention_kernels.cu              # 非融合 attention 组件
│   │   ├── layernorm_kernels.cu                      # LayerNorm + add_bias_residual 融合
│   │   ├── beam_search_topk_kernels.cu               # Beam search top-k
│   │   ├── sampling_topk_kernels / sampling_topp_kernels  # 采样
│   │   ├── custom_ar_kernels                         # 自定义 all-reduce
│   │   ├── cutlass_kernels/                          # INT8/FP8 GEMM（CUTLASS）
│   │   └── *_int8_*.cu / *_fp8_*.cu                  # 量化变体（按精度分文件）
│   ├── layers/                     # 层模块（8K 行，kernel 与 model 的桥梁）
│   │   ├── BaseLayer.h              # 基类（stream/cublas/allocator 注入）
│   │   ├── attention_layers/        # Unfused / Fused / DecoderSelfAttn + TP 变体
│   │   ├── beam_search_layers/      # BeamSearchLayer
│   │   ├── sampling_layers/         # TopK / TopP Sampling
│   │   ├── DynamicDecodeLayer       # 解码策略总调度器
│   │   └── FfnLayer                 # FFN（FC1+activation+FC2）
│   ├── models/                     # 模型编排（12K 行）
│   │   ├── multi_gpu_gpt/          # ParallelGpt（tensor+pipeline parallel，核心）
│   │   ├── gptj/ gptneox/          # GPT-J / GPT-NeoX
│   │   ├── bert/ bert_int8/ bert_fp8/  # BERT 全精度变体
│   │   ├── t5/ bart/               # encoder-decoder 模型
│   │   ├── vit/ swin/              # 视觉 transformer
│   │   └── decoding/ decoder/      # 通用 decoder/decoding
│   ├── utils/                      # 基础设施（7.6K 行，最高扇入）
│   │   ├── Tensor.h                # 非拥有式数据描述符
│   │   ├── allocator.h             # IAllocator + CUDA/TF/TH 三实现
│   │   ├── cublasMMWrapper         # cuBLAS GEMM 封装
│   │   ├── nccl_utils              # NCCL 通信原语
│   │   ├── custom_ar_comm          # 自定义 all-reduce
│   │   ├── cublasAlgoMap           # GEMM 算法映射表
│   │   ├── gemm_test/              # 离线 GEMM 调优工具
│   │   └── memory_utils / logger   # 内存工具 / 日志
│   ├── cutlass_extensions/         # CUTLASS GEMM 扩展（INT8/FP8 混合精度）
│   ├── triton_backend/             # Triton 后端适配
│   ├── th_op/                      # PyTorch OP 绑定
│   ├── tf_op/                      # TensorFlow OP 绑定
│   └── tensorrt_plugin/            # TensorRT 插件
├── examples/                       # 各框架调用示例
│   ├── cpp/{gpt,bert,t5,vit,...}/  # C++ example（最贴近核心）
│   ├── pytorch/ tensorflow/ tensorrt/
├── benchmarks/                    # 性能基准脚本
├── tests/                         # 单元测试
├── docs/                          # 各模型实现文档（*_guide.md）
├── 3rdparty/                      # INIReader / trt_fused_mha / CUTLASS
└── CMakeLists.txt                 # 构建系统（SM 版本/精度开关/框架绑定）
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/fastertransformer-internals/module-dependencies.svg)

模块间的依赖方向是单向自上而下：入口层（examples / triton_backend / th_op）调用模型编排层，模型编排层组合层模块层，层模块层调用算子层，所有层共享基础设施层。数据在层间以 `TensorMap*` 传递，跨 layers→kernels 边界时解包为裸指针。`utils/` 作为共享底座被所有层依赖，这是它代码量不算最大但扇入最高的原因。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| kernels | Fused CUDA 算子实现 | `decoder_masked_multihead_attention`、`unfused_attention_kernels` | 性能核心，纯 CUDA，不依赖上层；决定 FT 速度上限 | [01-kernels](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/01-kernels) |
| layers | transformer 组件逻辑桥接 | `BaseAttentionLayer`、`FfnLayer`、`DynamicDecodeLayer` | 在 GEMM 与 kernel 间做策略选择与资源管理，隔离 model 与 kernel | [02-layers](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/02-layers) |
| models | 模型 forward 编排与多 GPU 切分 | `ParallelGpt`、`ParallelGptWeight` | 编排完整推理流程，管理权重与并行策略，是各模型的差异所在 | [03-models](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/03-models) |
| utils | 运行时基础设施 | `Tensor`、`IAllocator`、`cublasMMWrapper`、`nccl_utils` | 被所有层共享，抽象设备资源与通信，支持多框架后端 | [04-utils](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/04-utils) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

以 `gpt_example.cc` 为例，从进程启动到首次 forward 的对象装配过程：

```
main(argc, argv)                                    gpt_example.cc:38
├── cudaGetDeviceProperties(&prop, 0)               // 探测 GPU SM 版本
├── INIReader(ini_name)                             // 解析 gpt_config.ini
├── gpt_example<T>(reader)                          // 按精度分发（fp32/fp16/bf16）
│   ├── read_start_ids(...)                         // 从 CSV 读取 input token ids
│   ├── deviceMalloc + cudaH2Dcpy                   // input_ids / lengths → GPU
│   ├── new cublasAlgoMap(GEMM_CONFIG)              // 加载 gemm_config.in（离线调优结果）
│   ├── new Allocator<AllocatorType::CUDA>(getDevice())  // 创建 CUDA 内存池
│   ├── new cublasMMWrapper(handle, ..., algo_map, allocator)  // cuBLAS 封装
│   ├── ftNcclInitialize(tensor_para, pipeline_para, tp_size, pp_size)  // NCCL 通信域
│   ├── getAttentionType<T>(size_per_head, sm, ...)  // 运行时选 FUSED / UNFUSED
│   ├── new ParallelGptWeight<T>(...)               // 权重对象
│   │   └── loadModel() → loadWeightFromBin()       // .bin 文件 → GPU（cudaH2Dcpy）
│   ├── new ParallelGpt<T>(head_num, size_per_head, ...,  // 模型对象装配
│   │       tensor_para, pipeline_para, stream,     //   stream/cublas/allocator 注入
│   │       &cublas_wrapper, &allocator, ...)
│   │   └── 内部创建 ParallelGptContextDecoder + ParallelGptDecoder + DynamicDecodeLayer
│   ├── 构造 input_tensors / output_tensors (TensorMap)  // 包装裸指针
│   └── gpt.forward(&output_tensors, &input_tensors)  // 首次推理
└── cudaDeviceSynchronize() + 输出回写
```

**对象装配的关键**：配置来自 `gpt_config.ini`（INIReader 解析），覆盖优先级是 `[model_name]` section 的模型超参 + `[ft_instance_hyperparameter]` 的运行时参数。对象实例化顺序是 allocator → cublasAlgoMap → cublasMMWrapper → NCCL → weights → model，严格按依赖顺序。依赖注入方式是构造函数传指针（手动 new，非 DI 容器）。`tensor_para` / `pipeline_para` 两个 `NcclParam` 在 `ftNcclInitialize` 中创建（内部用 MPI 建立 2D 拓扑 → `MPI_Cart_sub` 分裂 TP/PP 子通信器 → `ncclCommInitRank`）。

**GEMM 调优在启动时加载**：`cublasAlgoMap` 构造时 `loadGemmConfig()` 读取 `gemm_config.in`（离线调优产物），运行时 `cublasMMWrapper::Gemm` 按 `"batchCount_m_n_k_dataType"` 查表取最优算法。若文件不存在则警告并用默认算法。

### 核心运行流程

GPT 推理包含两条核心链路：**Context 阶段**（prefill，并行处理完整 input prompt）和 **Generation 循环**（逐 token 自回归生成）。两者共享权重与 KV cache，但 attention 计算模式根本不同——context 用 dense attention（所有 token 互 attend，走 cuBLAS GEMM），generation 用 incremental attention（新 token attend 历史 cache，走 fused MMHA kernel）。此外还有**多 GPU 通信链路**贯穿两条之中。

![GPT 推理数据流](/vibe-reading/images/articles/fastertransformer-internals/data-flow.svg)

#### Context 阶段：input prompt 并行编码

业务流程：input_ids → embedding lookup → N 层 transformer block（context attention + FFN）→ 写入 KV cache。

从 `ParallelGpt::forward` 出发，context 阶段调用 `ParallelGptContextDecoder::forward`（`ParallelGpt.cc:1084`）。数据结构变化：`int* input_ids [batch*beam, max_input_len]` → `invokeInputIdsEmbeddingLookup` → `T* context_decoder_input_buf_ [batch*beam, max_input_len, hidden_units]`（token id 转为 embedding 向量）。Context decoder 内部对每层调用 `TensorParallelGptContextAttentionLayer::forward` + `TensorParallelGeluFfnLayer::forward`。Context attention 用 cuBLAS `stridedBatchedGemm` 做 Q\*K^T 和 Attn\*V（充分利用 tensor core），每层 attention 后做 `ftNcclAllReduceSum`（TP 同步点 #2），FFN 后再 `ftNcclAllReduceSum`（同步点 #3）。Pipeline 首层 `ftNcclRecv` 接收上游输出（同步点 #1），末层 `ftNcclSend` 发送（同步点 #4）。KV cache 在此阶段写入，供 generation 复用。

#### Generation 循环：逐 token 自回归生成

业务流程：上一步 output_id → embedding → N 层 decoder block（fused self-attention + FFN）→ layerNorm → logits GEMM → dynamic decode（beam search/sampling）→ output token。

Generation 是 FT 性能的主战场。每步调用 `ParallelGptDecoder::forward`（`ParallelGpt.cc:1334`），数据流：`int* output_ids_buf_` → embedding → `T* decoder_input_buf_ [batch*beam, hidden]` → decoder layers → `T* decoder_output_buf_` → `invokeGeneralLayerNorm` → logits GEMM（`cublas_wrapper_->Gemm`，`T*` normed × `T*` embedding → `float* logits_buf_ [batch*beam, vocab_size_padded]`，**half→float 精度提升**）→ `ftNcclAllGather` 聚合各 TP rank 的 vocab 分片（同步点 #10）→ `DynamicDecodeLayer::forward`。Decoder self-attention 调 `fusedQKV_masked_attention_dispatch` → `masked_multihead_attention` kernel（融合 QKV bias + rotary + cache 读写 + Q\*K^T + softmax + Attn\*V），这是 FT 最核心的优化。每层 attention 后 all-reduce（同步点 #7），FFN 后 all-reduce（同步点 #8）。Pipeline 层间 Send/Recv（同步点 #6/#9），step 结束 `ftNcclGroupStart/Send/GroupEnd`（同步点 #11）。`DynamicDecodeLayer` 按 `beam_width` 分发：`>1` 走 `BeamSearchLayer`（`invokeTopkBeamSearch`），`==1` 走 `TopKSamplingLayer` / `TopPSamplingLayer`（可同 batch 混合）。输出 `float* logits` → `int* output_ids_buf_`（logits→token id）。

#### 多 GPU 通信链路：Tensor Parallel + Pipeline Parallel

Tensor parallel 按 Megatron 思路切分：attention 的 QKV 权重按 `head_num / tp_size` 切（每 rank 只持部分 head），FFN 按 `inter_size / tp_size` 切，logits 按 `vocab_size / tp_size` 切。关键优化是**第一 GEMM 按行切、第二 GEMM 按列切**，使每个 transformer block 只需 2 次 all-reduce（attention 后 + FFN 后）。Pipeline parallel 按 layer 切分（`local_num_layer = ceil(num_layer / pp_size)`），用 Send/Recv 传递中间结果，batch 分成 micro-batch 流水填充气泡。共 12 个 NCCL 同步点（见 SVG 标注），关键 PP 通信点后调 `ftNcclStreamSynchronize` 强制同步。Custom all-reduce 可替代 TP 的 all-reduce（`enable_custom_all_reduce=1`），通过 P2P 直访显存绕过 NCCL 协议栈。

---

## 典型修改场景

#### 场景 1：支持新的 GPT 变体（如 LLaMA 的 RMSNorm + Rotary + SwiGLU）

`ParallelGpt` 已内置 `gptVariantParams` 扩展点：

- `ParallelGptDecoderLayerWeight.h:35` — 添加 `use_rms_norm`、`activation_type` 等字段
- `ParallelGptWeight.cc:293` `loadModel()` — 调整权重文件命名（LLaMA 命名与 GPT-2 不同）
- `ParallelGptDecoder.cc:257` `forward()` — `invokeGeneralLayerNorm` 改为 `invokeRMSNorm`
- `TensorParallelDecoderSelfAttentionLayer` — 添加 rotary embedding 计算
- FFN 通过 `gptVariantParams.activation_type` 切换为 `TensorParallelSiluFfnLayer`

对应测试：`tests/bert/`（attention kernel 测试范式可复用）。

#### 场景 2：新增 size_per_head（如 40）

FT 的 fused MMHA 按编译期 `Dh` 模板特化，需新增一个特化文件：

- 新建 `kernels/decoder_masked_multihead_attention/decoder_masked_multihead_attention_40.cu` — 实例化 `mmha_launch_kernel<T, 40, 64, ...>`
- `decoder_masked_multihead_attention.cu:28` — switch 中加 `case 40:`
- `kernels/CMakeLists.txt` — 加入编译目标

对应测试：`tests/unittests/`（attention kernel 单测）。

#### 场景 3：新增一种 sampling 策略（如 typical sampling）

- `layers/sampling_layers/` 新建 `TypicalSamplingLayer.h/.cu`，继承 `BaseSamplingLayer<T>`，只实现 `runSampling()`
- `layers/DynamicDecodeLayer.cc` `initialize()` 创建 + `forward()` 加分发分支
- `kernels/` 新建对应 `invokeTypicalSampling` kernel
- `BaseSamplingLayer::forward` 已统一处理 temperature/penalty，新策略只关注核心采样

对应测试：`tests/decoding/`。

---

## 测试体系

```
tests/
├── bert/                    # BERT encoder 端到端测试
├── decoding/               # Decoding / beam search / sampling 测试
├── gemm_dequantize/        # GEMM 反量化测试
├── int8_gemm/              # INT8 GEMM 测试
├── longformer/             # Longformer 测试
├── moe/                    # MoE 测试
├── unittests/              # 单元测试（attention kernel 等）
├── weight_only_quant_ops/  # weight-only 量化算子测试
└── data/                   # 测试数据
```

测试以 C++ 端到端为主（对比 FT 输出与参考实现的数值误差），辅以 `unittests/` 的 kernel 级单测。理解某个 attention kernel 时，优先看 `tests/unittests/` 对应测试——它是最好的"可执行文档"。`tests/gemm_dequantize/` 和 `tests/int8_gemm/` 对应量化路径，修改 INT8/FP8 kernel 时参照。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `examples/cpp/gpt/gpt_example.cc` 的 `main` → `gpt_example<T>()` → `ParallelGpt::forward`（`ParallelGpt.cc`）→ `ParallelGptDecoder::forward`。读这一遍就能回答"FT 怎么把 input ids 变成 output tokens"。

- **第二遍：理解核心优化——fused MMHA**
  `kernels/decoder_masked_multihead_attention.cu` 的 `masked_multihead_attention` 入口 → `decoder_masked_multihead_attention_32.cu` 的 `mmha_launch_kernel` → `decoder_masked_multihead_attention_template.hpp` 的 `masked_multihead_attention_kernel` 模板。这是 FT 速度的来源，重点看 Q\*K^T 循环、KV cache 读写、softmax 融合。

- **第三遍：理解多 GPU 并行**
  `utils/nccl_utils.cc` 的 `ftNcclInitialize`（NCCL 通信域建立）→ `layers/attention_layers/TensorParallelDecoderSelfAttentionLayer.cc`（all-reduce 装饰器）→ `ParallelGptDecoder.cc:326-638`（Pipeline Send/Recv 点）。对照数据流 SVG 的 12 个同步点。

- **第四遍：理解基础设施与扩展机制**
  `utils/Tensor.h`（非拥有式描述符）→ `utils/allocator.h`（`IAllocator` + `reMalloc` REUSE 策略）→ `utils/cublasMMWrapper.cc`（GEMM 算法选择）→ `utils/gemm_test/gpt_gemm_func.cc`（离线调优）。然后选一个模块文档深入：[01-kernels](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/01-kernels)、[02-layers](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/02-layers)、[03-models](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/03-models)、[04-utils](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/04-utils)。

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| FT | FasterTransformer 简称 |
| MMHA | Masked Multi-Head Attention，解码阶段融合 attention kernel |
| Fused MHA | TensorRT 的 QKV-to-Context 融合 kernel（encoder/context 阶段） |
| Tensor Parallel (TP) | 按 head / inter_size 切分权重，单层内多 GPU 并行 |
| Pipeline Parallel (PP) | 按 layer 切分，多 GPU 流水线执行 |
| Context phase | prefill 阶段，并行处理完整 input prompt |
| Generation phase | 自回归逐 token 生成阶段 |
| KV Cache | 缓存历史 key/value，避免重算 |
| Custom All-Reduce | 绕过 NCCL 的 P2P all-reduce，节点内拓扑优化 |
| `gemm_config.in` | 离线 GEMM 调优产物，记录各 shape 的最优 cuBLASLt 算法 |

### 参考资料

- [FasterTransformer GitHub](https://github.com/NVIDIA/FasterTransformer)（本仓库）
- [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM)（继任者，继承 FT 的 kernel 设计）
- [Megatron-LM 论文](https://arxiv.org/pdf/1909.08053.pdf)（TP 切分策略的理论来源）
- `docs/gpt_guide.md`、`docs/bert_guide.md`、`docs/t5_guide.md` 等（各模型实现文档）
- `docs/QAList.md`（常见问题）
