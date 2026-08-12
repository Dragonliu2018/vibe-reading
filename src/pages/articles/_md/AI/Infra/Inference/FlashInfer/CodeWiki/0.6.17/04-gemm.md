---
source:
  type: "源码解读"
  project: "FlashInfer"
  url: "https://github.com/flashinfer-ai/flashinfer"
title: "GEMM"
date: "2026-08-12T15:50:29+08:00"
category: [AI, Infra, Inference, FlashInfer, CodeWiki, "0.6.17"]
tags: ["FlashInfer", "GEMM", "CUTLASS", "CuTeDSL", "cuDNN", "FP4", "FP8"]
description: "FlashInfer GEMM 模块解读：多 backend 策略（cuDNN/CUTLASS/CuTe DSL/cuBLASLt/TGV）、@backend_requirement 装饰器、M-bucket autotuning、grouped GEMM、FP4 shuffle 预处理。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/00-overview)

---

## 模块定位

GEMM 模块是 FlashInfer 的**矩阵乘算子层**——它是 attention 和 MoE 的底座（MoE 的 expert 计算本质是 grouped GEMM，attention 的投影层是 dense GEMM），也独立提供 `mm_bf16`/`mm_fp8`/`mm_fp4`/`mm_mxfp8` 公共 API。支持 BF16、FP8（per-tensor / groupwise / blockscaled）、FP4（NVFP4 / MXFP4）、MXFP8 多种 dtype，cuDNN / CUTLASS / CuTe DSL / cuBLASLt / TGV / tinygemm 多种 backend，以及 dense GEMM 和 grouped GEMM（MoE / LoRA 用，CSR 路由）两种形态。核心文件 `gemm_base.py` 有 9224 行，是整个项目最大的单文件。

模块边界：GEMM 管"矩阵乘计算"，不管 routing（在 fused_moe）、不管 attention 的 softmax。grouped_mm 是 GEMM 与 fused_moe 之间的中间层，封装 MoE 场景的 grouped GEMM。

## 模块架构

GEMM 模块的核心设计是**`@backend_requirement` 装饰器 + 多 backend Runner + M-bucket autotuning**。每个 GEMM 函数（如 `mm_bf16`）通过装饰器注册多个 backend 的 requirement checker，运行时按 SM capability 和参数（bias/pdl）筛选可用 backend 列表，再用 `AutoTuner.choose_one` 在候选 runner × tactic 中选最优。M（token 数）是动态维度，通过 `get_hybrid_num_tokens_buckets` + `map_to_hybrid_bucket_uncapped` 映射到有限 bucket，避免缓存爆炸。

文件职责分工：`gemm_base.py`（核心，所有 dense GEMM + group GEMM + SegmentGEMM + cuDNN graph）、`gemm_bf16_fp4.py`（W4A16 FP4，cuDNN/cute-dsl 双 backend）、`gemm_bf16_fp4_cute_dsl.py`（CuTe-DSL weight repack + kernel launch）、`routergemm.py`（MoE router 专用超低延迟 GEMM，M≤16，针对特定模型维度硬编码）、`gemm_svdquant.py`（NVFP4 + SVD 低秩补偿融合）、`grouped_mm/core.py`（grouped GEMM facade）。

## 调用链路

### mm_bf16（典型多 backend GEMM）

```
mm_bf16(a, b, backend="auto")                              [gemm_base.py:542]
  ├── @backend_requirement 装饰器 (gemm_base.py:529)
  │   ├── _check_mm_bf16_problem_size()                    # 通用形状/dtype 检查
  │   ├── 各 backend *_requirement 函数                     # 按 SM capability 筛选
  │   │   ├── _cutlass_mm_bf16_requirement  (SM100/103/107)
  │   │   ├── _cudnn_mm_bf16_requirement    (SM80+)
  │   │   ├── _tgv_gemm_requirement         (SM100/103)
  │   │   ├── _cublaslt_mm_bf16_requirement (SM80+)
  │   │   └── _tinygemm_mm_bf16_requirement (SM90+)
  │   └── _heuristic_func_mm_bf16()                        # 按 bias/pdl 筛选
  │       └── → mm_bf16.suitable_auto_backends
  │
  ├── bf16_gemm_sm100(a, b, bias, pdl, out, workspace, backends)  [gemm_base.py:1419]
  │   ├── tuner = AutoTuner.get()
  │   ├── 按 backends 构建 runners:
  │   │   ├── "cudnn"   → _cudnn_gemm_bf16_runner()
  │   │   ├── "cutlass" → cutlass_bf16_gemm_runner()
  │   │   ├── "tgv"     → _tgv_gemm_runner()
  │   │   └── ...
  │   ├── tuner.choose_one("bf16_gemm", runners, TUNING_CONFIG, inputs)
  │   └── chosen_runner(inputs=inputs, tactic=tactic)
  │
  └── 返回 out
```

### mm_bf16_fp4（双 backend 显式分发）

```
mm_bf16_fp4(a, b, b_descale, alpha, backend="cute-dsl")    [gemm_bf16_fp4.py:207]
  ├── @backend_requirement (gemm_bf16_fp4.py:199)
  │   ├── _cudnn_bf16_fp4_requirement()    # uint8 权重 + cuDNN 版本
  │   └── _cute_dsl_bf16_fp4_requirement() # int32 权重 + CuTe DSL 可用
  ├── backend == "cudnn" → _compute_cudnn()                [gemm_bf16_fp4_cudnn.py]
  └── backend == "cute-dsl" → _compute_cute_dsl()          [gemm_bf16_fp4_cute_dsl.py:429]
      ├── AutoTuner.get()
      ├── _cute_dsl_bf16_fp4_runner(enable_pdl)
      ├── tuner.choose_one("bf16_fp4_cute_dsl_gemm", ...)
      │   └── CuteDslBf16Fp4Runner.forward()
      │       ├── tactic<0: _select_bf16_fp4_tile_shape(m,n,k)   # 启发式 fallback
      │       ├── tactic>=0: _bf16_fp4_cute_dsl_tactic_configs(n,k)[tactic]
      │       └── _get_cute_dsl_bf16_fp4_gemm(tile, ...)          # cute.compile + 缓存
      └── chosen_runner(inputs, tactic)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `mm_bf16` (`gemm_base.py:542`) | BF16 dense GEMM | `@backend_requirement` 多 backend 自动筛选 |
| `mm_fp8` (`gemm_base.py:4232`) | FP8 GEMM | trtllm_low_latency backend 默认 |
| `mm_fp4` (`gemm_base.py:6534`) | FP4 GEMM | auto 选 b12x/cutlass/cudnn |
| `bf16_gemm_sm100` (`gemm_base.py:1419`) | SM100 GEMM 调度 | `AutoTuner.choose_one` 多 runner 竞速 |
| `prepare_bf16_fp4_weights` (`gemm_bf16_fp4.py:122`) | FP4 权重 repack | backend 不可互换（uint8 vs int32） |
| `grouped_mm_bf16` (`grouped_mm/core.py:81`) | grouped GEMM | cuDNN MOE graph + CSR 路由 |
| `SegmentGEMMWrapper.run` (`gemm_base.py:1947`) | 变长 segment GEMM | CUTLASS segment kernel |

</details>

## 核心实现

### 多 Backend 策略（@backend_requirement）

`@backend_requirement({backend_name: check_func, ...}, common_check=..., heuristic_func=...)` 装饰器依次执行通用检查和各 backend 特定检查，收集通过的 backend 列表存入 `func.suitable_auto_backends`（`gemm_base.py:529`）。`@supported_compute_capability([100, 103, ...])` 过滤当前 GPU 不支持的 backend。`heuristic_func` 按运行时参数进一步筛选——如 `_heuristic_func_mm_bf16`（`gemm_base.py:494`）在有 bias/pdl 时排除 cutlass 和 cublaslt。`backend="auto"` 时用 `suitable_auto_backends`，指定时调 heuristic 过滤。

### M-bucket Autotuning

M（token 数）是动态维度，直接用实际 M 做 cache key 会导致缓存爆炸。`TuningConfig`（如 `_FP8_GEMM_SM100_TUNING_CONFIG`，`gemm_base.py:1116`）用 `DynamicTensorSpec` 描述 M 维度的 bucketing：`get_hybrid_num_tokens_buckets` 定义 bucket 边界（1, 2, 4, 8, 16, 32, 64, 128, ...），`map_to_hybrid_bucket_uncapped` 将 runtime M 映射到 bucket。同一 bucket 内复用同一 tuned tactic。`ConstraintSpec` 让 output shape 跟随 M（`ConstraintSpec(4, -2, lambda shapes: shapes[0][-2])`）。GEMM 和 fused_moe 共享同一套 bucketing 函数（来自 `fused_moe.utils`），确保 MoE 内部 GEMM 调优与独立 GEMM 一致。

### FP4 权重 Shuffle/Scale 预处理

**为什么需要**（`gemm_bf16_fp4.py:122` `prepare_bf16_fp4_weights`、`gemm_bf16_fp4_cute_dsl.py:196` `_cute_dsl_pack_fp4_weight`）：(1) **FP4 repack**——FP4 数据是 2 个 4-bit 值打包在 1 byte（`uint8`），不同 backend 用不同 tensor core 布局，需重排为 kernel 直接可读格式。CuTe-DSL 将权重 repack 为 `(K//16, N*2)` 的 `int32`（每个含 8 个 FP4，按 MMA lane 映射），kernel 运行时无需 dequant。(2) **Scale unswizzle**——`nvfp4_quantize` 产出的 scale 是 128x4 swizzled 布局（为 TMA 优化），CuTe-DSL kernel 需线性 `(K_sf, N)` + S0E5M3 格式，`_unswizzle_sf_128x4`（`gemm_bf16_fp4.py:277`）+ `_e4m3_to_s0e5m3`（`gemm_bf16_fp4_cute_dsl.py:182`）转换。cuDNN backend 直接消费 swizzled 格式。**backend 不可互换**：cuDNN 用 `uint8`，CuTe-DSL 用 `int32`，`prepare_bf16_fp4_weights` 和 `mm_bf16_fp4` 必须用相同 backend 参数。

### Grouped GEMM vs 普通 GEMM

| 维度 | 普通 GEMM (`mm_*`) | Grouped GEMM (`grouped_mm_*`) |
|------|-------------------|------------------------------|
| 输入 | A:`(M,K)`, B:`(K,N)` | A:`(cum_M,K)`, B:`(num_experts,N,K)` |
| 路由 | 无 | `m_indptr:(num_experts+1,)` CSR |
| backend | 多（cuDNN/CUTLASS/cuBLASLt/TGV/...） | 主要 cuDNN MOE graph，部分 CuTe/TRT-LLM |
| cuDNN graph | 标准 matmul | `cudnn.moe_grouped_matmul_mode` 专用 |
| Autotuning | M-bucket + 多 runner | tactic = cuDNN execution-plan index |

Grouped GEMM 核心挑战是每个 expert 的 M 不同（变长 segment），cuDNN MOE graph 原生支持 CSR 路由；CUTLASS 风格 `group_gemm_fp8_nt_groupwise` 通过 `m_indptr` 在 kernel 内 segment 循环。

### CuTe DSL 与 CUTLASS backend 选择

对 `mm_bf16_fp4`（显式双 backend）：用户指定 `backend="cudnn"` 或 `"cute-dsl"`，无自动选择。对 `mm_fp4`（`backend="auto"`）：`@backend_requirement` 按 SM 筛选，SM120 优先 `"b12x"`（`Sm120B12xBlockScaledDenseGemmKernel`，CuTe-DSL，consumer GPU 专用），然后 `"cutlass"`，最后 `"cudnn"`。`"cute-dsl"` 和 `"trtllm"` 永不被 auto-selected（需不同权重预处理，`gemm_base.py:6579` 注释）。**设计理由**：CUTLASS 通用首选（稳定、无需特殊权重准备），CuTe-DSL 是 Blackwell 高性能替代但需 repack，cuDNN 兼容性回退。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 多 Backend 策略 | `@backend_requirement` + `suitable_auto_backends` in `gemm_base.py:529` | 多 backend 可互换，按 arch/参数自动选 |
| Autotuning | `TuningConfig` + `AutoTuner.choose_one` in `gemm_base.py:1116/1430` | M-bucket 降缓存爆炸，多 runner 竞速选最优 |
| JIT 编译 + 模块缓存 | `@functools.cache` on `get_gemm_module` in `gemm_base.py:144` | 同参数 module 只编译一次 |
| cuDNN Graph 缓存 | `@functools.lru_cache(maxsize=1024)` in `grouped_mm/cudnn/core.py:136` | graph 构建昂贵，override-shape 复用 |

## 模块间交互

GEMM 与 fused_moe：fused_moe **不直接调** `mm_*` 公共 API。而是：(1) 直接引用 GEMM kernel 类（`fused_moe/cute_dsl/blackwell_sm12x/` import `flashinfer.gemm.kernels.dense_blockscaled_gemm_sm120_b12x.Sm120B12xBlockScaledDenseGemmKernel`）；(2) 通过 `grouped_mm` API；(3) 共享 `AutoTuner` 和 bucketing 策略（`get_hybrid_num_tokens_buckets` 来自 `fused_moe.utils`）。`routergemm.py` 的 `mm_M1_16_K7168_N256` 等是 MoE router（gate 网络）专用超低延迟 GEMM，M≤16，是 fused_moe pipeline 第一步。

GEMM 与 jit：`flashinfer/jit/gemm.py` 提供大量 `gen_*_module()` 函数（`gen_gemm_sm90_module`/`gen_gemm_sm100_module`/`gen_gemm_sm100_module_cutlass_fp4`/`gen_trtllm_gen_gemm_module`/`gen_deepgemm_sm100_module`/`gen_tinygemm2_module` 等），每个对应一种 C++ kernel，返回 `JitSpec`。CuTe-DSL kernel 用 `cute.compile()` 按 `(tile_shape, dtype, atom_layout, pipeline_depth, ...)` 做 cache key（`_get_cute_dsl_bf16_fp4_gemm` in `gemm_bf16_fp4_cute_dsl.py:83`）。

GEMM 与 autotuner：所有多 backend GEMM 函数通过 `AutoTuner.get().choose_one(cache_key, runners, tuning_config, inputs)` 选最优。一次 `choose_one` 可同时比较 cudnn/cublaslt/cutlass/tgv/tinygemm 五种 backend（`gemm_base.py:1437`）。

## 扩展方式

**新增数据类型**（如 INT4）：`gemm_base.py` 加 `mm_<dtype>` 函数（参考 `mm_fp4`）+ 各 backend `_*_requirement` + `_heuristic_func_mm_<dtype>` + `@backend_requirement` 装饰的公共函数 + `TuningConfig`；`gemm/__init__.py` 和 `flashinfer/__init__.py` 导出；`jit/gemm.py` 加 `gen_*_module`；`trace/templates/gemm.py` 加 trace template；C++ kernel 实现。

**新增 backend**（如 Triton）：目标 GEMM 函数的 `@backend_requirement` 字典加 `"triton": _triton_requirement`；实现 `TunableRunner` 子类（`get_valid_tactics`/`forward`/`get_cache_key_extras`）；更新 `_heuristic_func_*`；若支持 grouped，在 `grouped_mm/core.py` dispatch 加分支 + 新建 `grouped_mm/<backend>/` 子包。
