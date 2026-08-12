---
source:
  type: "源码解读"
  project: "FlashInfer"
  url: "https://github.com/flashinfer-ai/flashinfer"
title: "Overview"
date: "2026-08-12T15:50:29+08:00"
category: [AI, Infra, Inference, FlashInfer, CodeWiki, "0.6.17"]
tags: ["FlashInfer", "CUDA", "Attention", "MoE", "GEMM", "JIT", "推理加速"]
description: "FlashInfer 是面向 LLM 推理的高性能 GPU kernel 库与生成器，提供 attention / GEMM / MoE / sampling 统一 API，多 backend（FlashAttention、cuDNN、CUTLASS、CuTe DSL、TRT-LLM）+ JIT 编译 + autotuning。本文从系统架构、运行时行为到核心模块，全面解读 v0.6.17 的内部原理。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.6.17 · **协议** Apache-2.0 · **语言** Python ≥ 3.10 + C++/CUDA · **代码量** Python ~330k 行 + C++/CUDA ~150k 行 · **仓库** [GitHub](https://github.com/flashinfer-ai/flashinfer)

---

## 总览

### 项目简介

**FlashInfer** 是一个面向大语言模型（LLM）推理的**高性能 GPU kernel 库与 kernel 生成器**。它把推理引擎里最吃性能的几类算子——attention、GEMM、MoE、sampling——做成统一 API，并在底层为每类算子提供多种 backend 实现（FlashAttention-2/3、cuDNN、CUTLASS、CuTe DSL、TensorRT-LLM），由运行时按硬件架构（SM75 Turing 到 SM121 Blackwell）和工作负载自动选择最优 kernel。它的核心价值在于：用 **JIT 编译** 消解"算子 × dtype × 架构"天文数字的编译组合，用 **plan/run 两阶段** 设计让 kernel 兼容 CUDAGraph 与 `torch.compile`，用 **autotuning** 在不同 input shape 下选最优 tile config。

典型使用场景是作为推理引擎（vLLM、SGLang、TensorRT-LLM 等）的底层算子库：模型前向输出 logits 后，FlashInfer 提供 `softmax`、`top_k_sampling_from_probs`、`chain_speculative_sampling` 完成采样；decode/prefill 阶段提供 `BatchAttention` 处理 paged KV-cache；MoE 层提供 `MoELayer` 做 fused expert 计算。**项目边界**：FlashInfer 只负责"单个算子的高效执行"，不负责推理引擎的调度、批处理、显存管理、模型加载——这些由上层引擎完成。它是一个**库**，不是推理框架。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| 统一注意力 API | `flashinfer/attention/_core.py` | `BatchAttention` plan/run，prefill+decode 混合 persistent kernel |
| Decode/Prefill 旧 API | `flashinfer/decode.py`、`flashinfer/prefill.py` | paged KV-cache wrapper，多 backend |
| MLA 注意力 | `flashinfer/mla/_core.py` | DeepSeek Multi-Latent Attention，matrix absorption |
| Cascade 注意力 | `flashinfer/cascade.py` | 共享前缀层级 KV-cache |
| Fused MoE | `flashinfer/fused_moe/` | 统一 API + 7 个 Runner，DSV3/Llama4/标准 routing |
| Expert Parallel | `flashinfer/moe_ep/` | 多 rank token dispatch/combine，NCCL/NVSHMEM/MNNVL |
| GEMM | `flashinfer/gemm/` | BF16/FP8/FP4/MXFP8，多 backend |
| Grouped GEMM | `flashinfer/grouped_mm/` | MoE / LoRA 用，CSR 路由 |
| 采样算子 | `flashinfer/sampling.py`、`include/flashinfer/sampling.cuh` | sorting-free top-k/top-p，speculative chain sampling |
| JIT 编译 | `flashinfer/jit/` | JitSpec + ninja + cubin 预编译 |
| Autotuning | `flashinfer/autotuner/` | `AutoTuner.choose_one`，多级缓存 |
| torch.compile 兼容 | `flashinfer/trace/`、`flashinfer/trace_apply/` | plan_capture + Solution 替换 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| PyTorch ≥ 2.x | 核心 | 张量抽象、CUDA stream、CUDAGraph、`torch.compile` |
| apache-tvm-ffi | 核心 | C++↔Python FFI 绑定（JIT 产出的 .so 通过它加载调用） |
| CUTLASS | 核心 | GEMM / MoE 的 C++ 模板库（SM80–SM107） |
| CuTe DSL (nvidia-cutlass-dsl) | 核心 | Blackwell（SM100+）Python 声明式 kernel 编译 |
| cuDNN | 核心 | attention / GEMM backend（graph 缓存） |
| ninja | 核心 | JIT 增量编译调度 |
| cuda-python | 核心 | cubin 加载、CUDA runtime 调用 |
| nccl4py / NVSHMEM | 可选 | Expert Parallel 通信后端 |
| Triton | 可选 | 部分 kernel 的 Triton backend |

### 版本历史

FlashInfer 从 2023 年起步，最初以 FlashAttention-2/3 的 paged KV-cache wrapper 闻名。v0.4.0（2025-10）加入 Blackwell（SM100+）支持，引入 CuTe DSL kernel 路径。v0.6.x 系列的重大演进是**统一 API**：用 `BatchAttention`（holistic persistent kernel，prefill+decode 融合）取代旧的 `BatchDecodeWithPagedKVCacheWrapper` / `BatchPrefillWithPagedKVCacheWrapper` 双 API；同时 MoE 从分散算子收敛为 `MoELayer` + Runner 策略模式，并 `enforce build()` 生命周期。v0.6.17 是 v0.6 系列的稳定版本，处于 nightly-v0.6.18 开发之前。

---

## 快速上手

```bash
# 安装（默认按需 JIT 编译）
pip install flashinfer-python

# 可选：预装编译产物，减少首次运行延迟
flashinfer install-cubin-wheel
flashinfer install-jit-cache-wheel

# 验证安装
flashinfer show-config
```

最小调用示例（单次 decode attention）：

```python title="basic_usage.py"
import torch, flashinfer

q = torch.randn(32, 128, device="cuda", dtype=torch.float16)        # [num_qo_heads, head_dim]
k = torch.randn(2048, 32, 128, device="cuda", dtype=torch.float16)  # [kv_len, num_kv_heads, head_dim]
v = torch.randn(2048, 32, 128, device="cuda", dtype=torch.float16)

output = flashinfer.single_decode_with_kv_cache(q, k, v)
```

**预期输出**：`output` 形状 `[32, 128]`，dtype 与 `q` 一致。首次调用会触发 JIT 编译（几秒到几十秒，取决于 kernel 复杂度），后续调用直接命中缓存。

---

## 架构设计解析

### 系统架构

FlashInfer 的架构思想是**"算子统一 API × 多 backend × JIT 编译"三角**。同一个算子（如 attention）暴露统一 Python API，底层有多个 backend 实现（FlashAttention、cuDNN、CUTLASS、CuTe DSL、TRT-LLM），由运行时按架构和负载选择；而每个 backend 的 CUDA kernel 不预编译全部组合，而是用 JIT 在首次调用时按需编译，配合 AOT 预编译 wheel 和 cubin 包覆盖常用配置。这样既控制了发行包体积，又能覆盖"dtype × head_dim × 架构"的庞大组合空间。

系统分四层：**API 层**（用户接口，`BatchAttention`/`MoELayer`/`mm_bf16`/`top_k_sampling`）；**计算算子层**（Python wrapper + backend dispatch，plan/run 生命周期）；**调度与编译基础设施层**（JIT、autotuner、trace、compilation_context——这层是 FlashInfer 区别于普通 kernel 库的核心）；**CUDA Kernel 层**（`csrc/` + `include/flashinfer/` 下的 C++/CUDA 源码，CUTLASS/CuTe DSL/cuDNN/TRT-LLM 多来源）。层间依赖单向向下：上层调用下层，下层对上层透明。

![FlashInfer 分层架构](/vibe-reading/images/articles/flashinfer-internals/architecture.svg)

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ------ | -------- | ---------------------- |
| API 层 | `flashinfer/__init__.py` 导出的顶层函数与类 | 隔离用户与内部实现，提供稳定接口契约 |
| 计算算子层 | `attention/`、`fused_moe/`、`gemm/`、`sampling.py`、`grouped_mm/` | 编排 plan/run 生命周期、backend 选择、数据布局处理 |
| 调度与编译基础设施层 | `jit/`、`autotuner/`、`trace/`、`trace_apply/`、`compilation_context.py` | 消解编译组合爆炸、按 shape 选最优 config、兼容 torch.compile |
| CUDA Kernel 层 | `csrc/`、`include/flashinfer/` | 实际 GPU 计算执行，多来源 kernel 融合 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Plan-Run 两阶段 | `attention/_core.py:94` `BatchAttention.plan/run` | 让含 host 同步的规划与纯 kernel launch 分离，后者可被 CUDAGraph 捕获 |
| 策略（多 backend Runner） | `fused_moe/runners.py:163` `MoERunner(TunableRunner)` | 同一算子多 backend 实现可互换，运行时竞速选最优 |
| 模板方法（JIT 生命周期） | `jit/core.py:300` `JitSpec.build_and_load` | 固化缓存检查-锁-build-load 流程，子类只实现 try_load/build/load |
| 注册表 | `jit/core.py:162` `JitSpecRegistry` | 统一管理所有 JitSpec 状态，供 AOT 预编译和调试查询 |
| 捕获-重放 | `trace_apply/plan_capture.py:108` | 在 plan 时 stash 状态、run 时恢复，弥合两阶段 API 与 torch.compile 的矛盾 |
| Sorting-free（radix + scan） | `include/flashinfer/sampling.cuh:579` | 用 radix select + CDF scan 替代全局排序，降复杂度 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `JitSpec` | 一个算子的 JIT 编译规格（源码 + flags + 架构） | 声明后注册到 registry，build 后产出 .so | 子类 `JitSpecNvcc` / `JitSpecCuteDsl` |
| `TunableRunner` | 一个 backend 的可调优执行器 | per-module，autotuner 持有 | 子类 `MoERunner`、`CutlassBf16GemmRunner` 等 |
| `TuningConfig` | 调优的动态维度与 bucket 策略 | 模块级常量 | 含 `DynamicTensorSpec` 描述 M（token 数）bucketing |
| `TraceTemplate` | 一个算子的 schema（axes + inputs/outputs） | 导入时注册到 `_TRACE_REGISTRY` | 与 `Solution`（具体实现）通过 definition_name 关联 |
| `MoEActivationPack` / `MoEWeightPack` | MoE 的瞬态激活 / 长期权重容器 | per-call / 模型加载时 | 分离 lifetime 以支持跨 backend autotune |
| `plan_info` | plan 阶段产出的调度元数据（offset 列表） | per-plan，缓存于 wrapper 实例 | run 阶段据此提取 workspace 指针 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|---------|--------|---------|
| `JitSpec` (ABC) | `jit/core.py:226` | `JitSpecNvcc`、`JitSpecCuteDsl` | `gen_jit_spec()` 构造时自动 `register` |
| `TunableRunner` (ABC) | `autotuner/autotuner.py:560` | `MoERunner`、`CutlassBf16GemmRunner`、`TrtllmGenMlaDecodeRunner` 等 | `AutoTuner.choose_one` 运行时收集 runners 列表 |
| `BackendConfig` (frozen dataclass) | `fused_moe/api.py:268+` | `TrtllmFp4Config`、`CuteDslConfig`、`CutlassConfig` 等 | `MoELayer.__init__` 遍历 `MoEConfig.backend` candidates |
| `StatefulAdapter` | `trace_apply/plan_capture.py:39` | per-API 的 plan/run 适配 | `STATEFUL_ADAPTERS` 字典静态注册 |

---

## 代码目录

```
flashinfer/
├── __init__.py            # 顶层 API 导出（~250 行 import）
├── __main__.py            # CLI 入口（show-config / install-cubin-wheel）
├── attention/             # 统一注意力 API（BatchAttention）
├── decode.py / prefill.py # 旧 paged KV-cache wrapper API
├── cascade.py             # 共享前缀级联注意力
├── mla/                   # Multi-Latent Attention（DeepSeek）
├── fused_moe/             # Fused MoE 统一 API + 7 Runner
├── moe_ep/                # Expert Parallel（多 rank 通信）
├── gemm/                  # GEMM 算子（BF16/FP8/FP4/MXFP8）
├── grouped_mm/            # Grouped GEMM（MoE / LoRA）
├── sampling.py            # 采样算子 Python wrapper
├── jit/                   # JIT 编译系统（JitSpec + ninja + cubin）
├── autotuner/             # 自动调优（AutoTuner + TunableRunner）
├── trace/                 # torch.compile trace 模板系统
├── trace_apply/           # trace 应用 + plan_capture
├── compilation_context.py # CUDA 架构归一化（SM arch → nvcc flag）
├── comm/                  # AllReduce / NVSHMEM 通信
├── norm.py / rope.py / activation.py  # 辅助算子
├── quantization/          # FP4/FP8 量化工具
├── cutile/ / triton/      # cuTile / Triton backend
└── cute_dsl/              # CuTe DSL kernel 定义（Blackwell）

csrc/                      # C++/CUDA 源码（kernel 实现 + binding）
├── batch_attention.cu     # BatchAttention 的 C++ plan/run 入口
├── fmha_v2/               # FlashAttention kernel
├── xqa/                   # xQA decode kernel（TRT-LLM）
├── fused_moe/             # MoE C++ kernel
├── nv_internal/           # NVIDIA 闭源工具链相关
└── ...

include/flashinfer/        # 头文件库（模板化 kernel）
├── attention/             # attention kernel 模板（prefill/decode/persistent）
├── sampling.cuh / topk.cuh / air_top_p.cuh  # 采样 kernel
├── pos_enc.cuh            # RoPE
├── page.cuh               # paged KV-cache 布局
└── vec_dtypes.cuh         # 向量化 dtype 工具
```

---

## 模块地图

FlashInfer 的 7 个核心模块按职责分化自然形成，模块间通过 JitSpec（编译）、TunableRunner（调优）、TraceTemplate（trace）三个抽象解耦。

![模块依赖关系](/vibe-reading/images/articles/flashinfer-internals/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| JIT 编译系统 | 按需编译 CUDA kernel，管理缓存/cubin/AOT | `JitSpec.build_and_load` in `jit/core.py:300` | 编译策略与算子逻辑正交，7 类算子共享同一编译生命周期 | [JIT 编译系统](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/01-jit) |
| 注意力后端 | prefill/decode/MLA/cascade attention，plan/run 两阶段 | `BatchAttention` in `attention/_core.py:44` | attention 是推理最重算子，多 backend + persistent kernel 自成体系 | [注意力后端](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/02-attention) |
| MoE 算子 | fused expert 计算，routing + GEMM 融合，EP 通信 | `MoELayer` in `fused_moe/layer.py:79` | MoE 有独立的 routing 抽象、7 个 backend runner、Expert Parallel 层 | [MoE 算子](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/03-moe) |
| GEMM | 矩阵乘，多 dtype + 多 backend + grouped 变体 | `mm_bf16` / `mm_fp8` in `gemm/gemm_base.py` | GEMM 是 MoE/attention 的底座，但多 backend 策略和 autotuning 独立成模块 | [GEMM](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/04-gemm) |
| 采样算子 | sorting-free top-k/top-p，speculative chain sampling | `top_k_sampling_from_probs` in `sampling.py:280` | 采样用 radix select + CDF scan 替代排序，算法体系独立 | [采样算子](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/05-sampling) |
| Autotuner | 按 shape 选最优 tile config，多级缓存 | `AutoTuner.choose_one` in `autotuner/autotuner.py:1419` | 调优是横切关注点，GEMM/MoE/MLA 共用同一调优框架 | [Autotuner](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/06-autotuner) |
| Trace 系统 | torch.compile 兼容，plan_capture + Solution 替换 | `enable_apply` in `trace_apply/apply.py:569` | 两阶段 API 与 torch.compile 的矛盾需要专门层解决 | [Trace 系统](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/07-trace) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

FlashInfer 作为库，没有独立进程启动，其"启动"是 `import flashinfer` 时的初始化：

```
import flashinfer                                    [__init__.py]
  ├── 读取 version / git_commit
  ├── import jit → 初始化 FLASHINFER_WORKSPACE_DIR（~/.cache/flashinfer/<ver>/<arch>/）
  ├── 检测 compilation_context.TARGET_CUDA_ARCHS（从环境变量或 torch.cuda.get_device_capability）
  ├── 各算子模块导入，注册 @register_custom_op（torch custom op）
  ├── @flashinfer_api(trace=template) 装饰的函数 → 注册到 _TRACE_REGISTRY
  └── if FLASHINFER_TRACE_APPLY=1: trace_apply.enable_apply() → monkey-patch API
```

**对象装配**：`CompilationContext` 是进程级单例，持有 `TARGET_CUDA_ARCHS`（如 `{80, 89, 90a}`），由 `gen_jit_spec` 在生成 nvcc flags 时读取。`AutoTuner` 是双检锁 singleton（`autotuner.py:1222`），持有 `profiling_cache` dict 和 `_file_configs`。各算子的 `get_*_module()` 函数用 `@functools.cache` 装饰，确保 JIT module 只 build 一次。

**配置优先级**：CUDA 架构来自 `FLASHINFER_CUDA_ARCH_LIST` 环境变量 > `torch.cuda.get_device_capability()`；JIT 缓存目录来自 `FLASHINFER_CACHE_DIR` > 默认 `~/.cache/flashinfer/`；`FLASHINFER_DISABLE_JIT=1` 强制只用预编译产物。

### 核心运行流程

下面三条链路覆盖了 FlashInfer 推理时的核心场景。前两条是单算子调用，第三条是跨算子的端到端数据流。

#### Attention：BatchAttention plan → run

业务流程：推理引擎收到一批请求（混合 prefill + decode）→ plan 阶段在 CPU 侧做负载均衡调度（把请求分成 prefill task / decode task，分配到 SM cluster）→ run 阶段启动 cooperative persistent kernel，单个 kernel 内由不同 runner 顺序处理两类请求，中间 `grid.sync()` 做 split-KV 结果合并。

![BatchAttention 端到端数据流](/vibe-reading/images/articles/flashinfer-internals/data-flow.svg)

文字描述：`BatchAttention.__init__` 预分配 384MB float workspace 与 8MB int workspace（含 CPU pinned memory）。`plan()` 先调 `get_holistic_attention_module(dtype, head_dim, ...)` 触发 JIT（Jinja 渲染 `.cu` → `gen_jit_spec` → `build_and_load`，命中 AOT 则直接加载），再把 `qo_indptr`/`kv_indices`/`kv_len_arr` 拷到 CPU，调用 C++ `TwoStageHolisticPlan` 用 MinHeap 按 `cost(qo_len, kv_len) = 2*qo_len + kv_len` 做负载均衡，产出 `plan_info`（28 个 int64 offset）并 `cudaMemcpyAsync` 到 GPU。`run()` 拆解 paged KV-cache，按 `plan_info` 从 workspace 提取各类指针，`DISPATCH_context` 宏按 mask_mode 选择模板实例化，最后 `cudaLaunchCooperativeKernel` 启动 `PersistentKernelTemplate`——内含 prefill runner（`CTA_TILE_Q=128`）和 decode runner（`CTA_TILE_Q=16`），两者顺序执行后 `grid.sync()` 全局同步，再由 `BlockReductionPersistent` 合并 split-KV 的 `partial_o`/`partial_lse`。数据变化：`q [total_qo, N, h]` + `kv_cache [pages]` → `out [total_qo, N, h]` + `lse [total_qo, N]`。

#### MoE：MoELayer 构建竞速执行

业务流程：模型加载时为每个 MoE 层构建 `MoELayer`，遍历 backend candidates（按 arch 筛选）创建多个 `MoERunner`；每次 forward 时按 routing_input_mode 过滤可用 runner，按 token 数映射到 bucket 查 winner 缓存，miss 则跨 backend 竞速（per-runner autotune + CUDA Graph 计时）选最优 runner+tactic，最终调 C++ fused kernel 完成 routing → GEMM1 → activation → GEMM2 → finalize。

![MoE 调用链](/vibe-reading/images/articles/flashinfer-internals/moe-call-chain.svg)

文字描述：构建阶段 `prepare_weights` 把 BF16 权重量化为 FP4/FP8 并做 gated-act reorder + MMA shuffle + `block_scale_interleave`，存入 `MoEWeightPack`（按 backend_key 存多份 native view）。执行阶段 `MoELayer.__call__` 先按 `routing_input_mode`（PackedPrecomputed / UnpackedPrecomputed / FromLogits）过滤 runner，再用 `map_to_hybrid_bucket(num_tokens)` 算 bucket key 查 `_winners[(bucket, mode)]` 缓存。Miss 时 `_select_winner` 对每个 runner 调 `tuner.choose_one` 选其最优 tactic，再用 `bench_gpu_time`（CUDA Graph 计时）跨 runner 对比，winner 入缓存。最终 `runner.forward` 调 C++ `moe_op`（按 dtype 分发 `trtllm_fp4_block_scale_moe` / `trtllm_fp8_block_scale_moe` / `trtllm_bf16_moe`），kernel 内部一次 launch 完成全流程。数据变化：`hidden_states [M, H]` + `routing_logits [M, E]` → `output [M, H]`。

#### Sampling：logits → token

业务流程：模型前向输出 logits → `softmax` 归一化 → `top_k_mask_logits` 过滤 → `top_p_sampling_from_probs` 采样 → 输出 token id。speculative decoding 场景额外用 `chain_speculative_sampling` 做 draft-target 接受/拒绝。

文字描述：`softmax` 用两趟 online softmax kernel（Pass 1 算 running max + denominator，Pass 2 归一化）。`top_k_sampling_from_probs` 不显式排序，而是用迭代二分搜索找 threshold：每轮用 `BlockReduce` 计数大于 pivot 的 prob 之和，缩窄搜索区间，收敛后用 `DeviceSamplingFromProb` 做 CDF scan 采样（`atomicMin` 找第一个 CDF 超过随机数 u 的 index）。`chain_speculative_sampling` 用 modified rejection sampling：逐个检查 draft token（`u * p < q` 判接受），首个拒绝时从 `relu(target_probs - draft_probs)` 残差分布采样 bonus token。数据变化：`logits [batch, vocab]` → `sampled_id [batch]`。

### 状态流

FlashInfer 的关键状态流转在两个维度：

**JitSpec 生命周期**：`声明（gen_jit_spec）→ 注册（registry）→ try_load（AOT 命中？）→ [miss] FileLock + build（ninja）→ load（tvm_ffi）→ 缓存`。`FLASHINFER_DISABLE_JIT` 在 try_load miss 时直接 raise `MissingJITCacheError`，转入"必须用预编译产物"状态。

**Autotuner tuning 状态**：`is_tuning_mode=False（推理）→ search_cache（内存/文件/bundled/fallback）→ [miss] is_tuning_mode=True（调优）→ 生成 profiles → 逐 runner×tactic profiling → 写 profiling_cache → _dirty → __exit__ save_configs`。`tactic=-1` 是始终可用的 fallback state。

---

## 典型修改场景

#### 场景 1：新增一个算子的 JIT 编译支持

新增名为 `my_op` 的 CUDA 算子，需修改：
- `flashinfer/jit/my_op.py`（新建）：定义 `gen_my_op_module()`，调 `gen_jit_spec(name, sources, extra_cuda_cflags, ...)`，用 `current_compilation_context.get_nvcc_flags_list(supported_major_versions=[...])` 指定目标架构
- `flashinfer/jit/__init__.py`：添加 `from .my_op import gen_my_op_module`
- `flashinfer/my_op.py`（运行时调用层）：`module = gen_my_op_module(...).build_and_load(); module.my_op_kernel(...)`
- 可选：`flashinfer/aot.py` 注册到 AOT 批量编译列表

对应测试：`tests/jit/`

#### 场景 2：新增一种 attention backend

- `flashinfer/utils.py:522` `determine_attention_backend()` 中添加新 backend 选择逻辑
- `flashinfer/jit/attention/modules.py` 添加 `gen_*_module` 函数生成 JitSpec
- `decode.py:_plan_impl()` / `prefill.py:plan()` 添加 backend 分支
- `decode.py:run()` / `prefill.py:run()` 添加 dispatch 分支
- `include/flashinfer/attention/` 添加 `.cuh` kernel
- 若用 autotuner：实现 `TunableRunner` 子类（参考 `TrtllmGenMlaDecodeRunner` in `mla/_core.py:2514`）

对应测试：`tests/attention/`

#### 场景 3：新增一种 MoE 量化格式

- `fused_moe/api.py:54` `QuantVariant` 新增 enum 值
- `fused_moe/api.py` 新增 `BackendConfig` 子类（含 `supported(arch)` + `prepare_weights/activations`）
- `fused_moe/prepare.py` 新增 `prepare_xxx_weights()` 实现量化 + layout 转换
- `fused_moe/runners.py` 新增 `XxxRunner(MoERunner)`，实现 `check_support/build/pack_inputs/forward`
- `fused_moe/layer.py:68` `_BACKEND_RUNNERS` 注册 config → runner 映射
- `fused_moe/core.py` 若用新 C++ op，在 `MoERunner.forward` 添加 dtype 分发分支

对应测试：`tests/moe/`

---

## 测试体系

```
tests/
├── attention/        # attention 各 backend 正确性 + 性能
├── moe/ / moe_ep/    # MoE 算子 + Expert Parallel
├── gemm/ / grouped_mm/  # GEMM 各 dtype/backend
├── autotuner/        # 调优框架
├── trace/ / trace_apply/  # torch.compile 兼容
├── jit/              # JIT 编译
├── cli/              # CLI 工具
└── norm/ mamba/ mhc/ kda/ msa_ops/ gdn/ comm/  # 其他算子
```

| 代码层 | 测试类型 | 说明 |
|--------|----------|------|
| CUDA Kernel 层 | `tests/<op>/` 下的正确性测试 | 与 PyTorch reference 对比数值 |
| 计算算子层 | 同目录下的 backend 覆盖测试 | 每个 backend 单独测试 |
| 调度基础设施 | `tests/autotuner/`、`tests/jit/`、`tests/trace/` | 框架自身行为测试 |
| 端到端 | `benchmarks/` | 性能基准（非测试，但可作验证） |

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `flashinfer/__init__.py`（看顶层 API 全貌）→ `flashinfer/attention/_core.py:44` `BatchAttention` 的 `plan`/`run`（理解 plan/run 两阶段）→ `csrc/batch_attention.cu:38` `BatchPagedAttentionPlan`/`Run`（看 C++ 入口）
- **第二遍：理解 JIT 编译基础设施**
  `flashinfer/jit/core.py:226` `JitSpec` 抽象基类 + `:300` `build_and_load` 模板方法 → `:515` `gen_jit_spec` 工厂 → `flashinfer/jit/attention/modules.py:1139` `gen_batch_attention_module`（看一个算子如何声明 JitSpec）
- **第三遍：理解多 backend 策略与 autotuning**
  `flashinfer/gemm/gemm_base.py:542` `mm_bf16`（看 `@backend_requirement` + `AutoTuner.choose_one`）→ `flashinfer/autotuner/autotuner.py:1419` `choose_one`（看调优主循环）→ `flashinfer/fused_moe/layer.py:79` `MoELayer`（看跨 backend 竞速）
- **第四遍：选择重点子模块深入阅读**
  从下方模块文档进入。推荐顺序：[JIT 编译系统](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/01-jit) → [注意力后端](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/02-attention) → [MoE 算子](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/03-moe) → [采样算子](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/05-sampling)

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| Plan/Run | FlashInfer 的两阶段 API：plan 做规划（不可入图），run 做 kernel launch（可入图） |
| Persistent kernel | 一个 CTA 处理多个 work item 的 kernel，配合 `cudaLaunchCooperativeKernel` + `grid.sync()` |
| Paged KV-Cache | KV-cache 按 page 分块存储，通过 `kv_indices` 索引，支持非连续内存 |
| MLA | Multi-Latent Attention，DeepSeek 的注意力变体，KV 压缩 + matrix absorption |
| Tactic | 一个 kernel 的具体配置（tile size / pipeline stage 等），autotuner 在 tactic 空间中选最优 |
| JitSpec | 一个算子的 JIT 编译规格，含源码、nvcc flags、目标架构 |
| AOT | Ahead-of-Time，预编译到 `flashinfer-jit-cache` 包，安装即用 |
| cubin | CUDA device 二进制，trtllm 系列 kernel 的 device 代码以 cubin 形式分发 |
| CuTe DSL | CUTLASS 的 Python 声明式 kernel 编译路径，用于 Blackwell |
| EP | Expert Parallel，MoE 的多 rank 并行，token 跨 rank dispatch/combine |

### 参考资料

- [FlashInfer 官方文档](https://docs.flashinfer.ai)
- [FlashInfer 博客：Sorting-Free GPU Kernels for LLM Sampling](https://flashinfer.ai/2025/03/10/sampling.html)
- [DeepWiki: FlashInfer](https://deepwiki.com/flashinfer-ai/flashinfer)
- 设计文档：`docs/design_docs/`（含 `flashinfer_moe_api.md`、`moe_ep_architecture.md`、`monomoe_kernel.md` 等）
