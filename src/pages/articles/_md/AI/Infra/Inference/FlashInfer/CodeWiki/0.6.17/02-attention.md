---
source:
  type: "源码解读"
  project: "FlashInfer"
  url: "https://github.com/flashinfer-ai/flashinfer"
title: "注意力后端"
date: "2026-08-12T15:50:29+08:00"
category: [AI, Infra, Inference, FlashInfer, CodeWiki, "0.6.17"]
tags: ["FlashInfer", "Attention", "PagedKVCache", "MLA", "PersistentKernel"]
description: "FlashInfer 注意力后端解读：BatchAttention 统一 API、plan/run 两阶段、多 backend 选择、MLA、persistent cooperative kernel。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/00-overview)

---

## 模块定位

注意力后端是 FlashInfer 的**最核心算子模块**——推理延迟的绝大部分花在 attention。FlashInfer 提供 prefill、decode、append 三种 attention 阶段的 kernel，支持 paged KV-cache（非连续内存，通过 page 索引）、MLA（DeepSeek Multi-Latent Attention）、cascade（共享前缀层级 KV-cache）、稀疏注意力。v0.6.x 的重大变化是引入统一 API `BatchAttention`——用一个 **holistic persistent cooperative kernel** 同时处理 prefill 和 decode 混合请求，取代旧的 `BatchDecodeWithPagedKVCacheWrapper` / `BatchPrefillWithPagedKVCacheWrapper` 双 API。

模块边界：attention 模块只管"给定 q/kv_cache 算 attention"，不管 KV-cache 的生命周期管理（由推理引擎管）、不管采样（在 sampling 模块）、不管 MoE 的 expert 计算（在 fused_moe）。

## 模块架构

![注意力 Backend 选择与 Plan/Run 分离](/vibe-reading/images/articles/flashinfer-internals/attention-backend-dispatch.svg)

attention 模块有两套并行的 API 体系。**新统一 API**（`BatchAttention`，`_core.py:44`）走 holistic persistent kernel 路径——一个 cooperative kernel 内含 prefill runner（`CTA_TILE_Q=128`）和 decode runner（`CTA_TILE_Q=16`），由 plan 阶段按 query 长度自动区分请求类型，不经过 FA2/FA3/cuDNN 的 backend 分发。**旧 API**（`BatchDecodeWithPagedKVCacheWrapper`、`BatchPrefillWithPagedKVCacheWrapper`、`BatchMLAPagedAttentionWrapper`）走多 backend 分发——`determine_attention_backend()`（`utils.py:522`）按 SM 架构和约束条件在 `fa2`/`fa3`/`cudnn`/`trtllm-gen`/`cute-dsl`/`cutlass` 间选择。

两套 API 共享 **plan/run 两阶段**设计：plan 做 host-side 规划（backend 选择、JIT 编译、split-kv 调度、CPU↔GPU 传输），run 做纯 kernel launch。这是 FlashInfer 兼容 CUDAGraph 和 `torch.compile` 的关键——plan 含 host 同步无法入图，run 只做 launch 可被捕获。

## 调用链路

### BatchAttention（新统一 API）

```
BatchAttention.plan(qo_indptr, kv_indptr, kv_indices, ...)   [_core.py:94-213]
  ├── get_holistic_attention_module(dtype_q, dtype_kv, ...)  [_core.py:39, @functools.cache]
  │   └── gen_batch_attention_module()                       [jit/attention/modules.py:1139]
  │       └── gen_customize_batch_attention_module()         [modules.py:1902]
  │           ├── Jinja 渲染: config.inc + 4 个 .cu (mask_mode 0-3)
  │           └── gen_jit_spec(uri, sources, ...)            [jit/core.py:515]
  ├── JitSpec.build_and_load()                               [jit/core.py:300]
  ├── qo_indptr/kv_indptr/kv_len_arr → CPU (non_blocking) + cuda.synchronize()
  └── module.plan(float_ws, int_ws, page_locked_ws, ...)     [_core.py:201]
      └── [C++] TwoStageHolisticPlan                         [include/.../scheduler.cuh:1240]
          ├── 按 packed_qo_len 分 prefill task / decode task
          ├── MinHeap 负载均衡 (cost = 2*qo_len + kv_len)
          └── 产出 plan_info (28×int64) + cudaMemcpyAsync → GPU

BatchAttention.run(q, kv_cache, out, lse, ...)               [_core.py:215-327]
  ├── _unpack_paged_kv_cache(kv_cache) → (k_cache, v_cache)  [utils.py:186]
  ├── 计算 sm_scale (1/sqrt(head_dim_qk), 可选 k_scale 乘入)
  └── module.run(float_ws, int_ws, plan_info, q, k, v, ...)  [_core.py:302]
      └── [C++] BatchPagedAttentionRun                       [csrc/batch_attention.cu:67]
          ├── HolisticPlanInfo.FromVector(plan_info)
          ├── DISPATCH_context (编译期模板: dtype/head_dim/mask_mode)
          └── cudaLaunchCooperativeKernel(PersistentKernelTemplate)
              ├── BlockPersistentRunner1.Run (prefill, CTA_TILE_Q=128)
              ├── grid.sync()  ← cooperative groups 全局同步
              ├── BlockPersistentRunner2.Run (decode, CTA_TILE_Q=16)
              └── grid.sync() → BlockReductionPersistent (split-KV merge)
```

### 旧 API backend 分发

旧 API 的 plan 阶段调 `determine_attention_backend()`（`utils.py:522`）决策：SM90a + CUDA ≥ 12.3 + `is_fa3_backend_supported()`（不支持 custom_mask/RoPE/fp16_qk_reduction/FP8-KV-非FP8-Q/NVFP4）+ head_dim 支持 → `fa3`，否则 `fa2`。Decode 额外支持 `trtllm-gen`（Hopper）和 `cute-dsl`（Blackwell SM100+）。MLA 的 `determine_mla_backend()`（`utils.py:676`）SM90a 返回 `fa3`，否则 `fa2`，还支持 `cutlass`（SM100/110）和 `trtllm-gen`（via autotuner）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `BatchAttention.plan` (`_core.py:94`) | JIT 编译 + CPU 侧调度 | plan_info 编码 28 个 offset |
| `BatchAttention.run` (`_core.py:215`) | cooperative kernel launch | prefill+decode 融合单 kernel |
| `TwoStageHolisticPlan` (`scheduler.cuh:1240`) | 负载均衡调度 | MinHeap + cost function |
| `determine_attention_backend` (`utils.py:522`) | 旧 API backend 选择 | SM90a 优先 fa3，否则 fa2 |
| `_unpack_paged_kv_cache` (`utils.py:186`) | 拆解 paged KV | 支持 NHD/HND + 分离/打包式 |
| `BatchDecodeWithPagedKVCacheWrapper.plan` (`decode.py:1239`) | 旧 decode 规划 | use_tensor_cores 时复用 prefill kernel |

</details>

## 核心实现

### Plan/Run 两阶段与 CUDAGraph 兼容

Plan 阶段（`_core.py:94-213`、`decode.py:1376-1695`）做 host-side 规划：将 `indptr`/`indices` 拷贝到 CPU、计算 split-kv 策略、构建辅助数组、触发 JIT 编译。这些操作涉及动态内存分配和 CPU-GPU 同步，无法被 CUDAGraph 捕获（代码注释 `decode.py:1339`："The plan method cannot be used in Cuda Graph or in torch.compile"）。

Run 阶段（`_core.py:215-327`、`decode.py:1809`）只执行 kernel launch，所有输入 tensor（含 plan 产出的 `_plan_info`、`_paged_kv_indptr_buf`）在 CUDAGraph 模式下用预分配固定大小 buffer（`decode.py:887`），确保 shape 不变，可被捕获。`BatchAttention` 进一步简化：workspace buffer 由实例自身拥有并在 plan/run 间复用（`_core.py:77`），不需用户管理。

### Paged KV-Cache 布局

支持两种 layout（`_core.py:276`、`decode.py:1838`）：**NHD**（token-major）`[max_num_pages, page_size, num_kv_heads, head_dim]` 和 **HND**（head-major）`[max_num_pages, num_kv_heads, page_size, head_dim]`。支持两种存储形式：分离式 `(k_cache, v_cache)` 元组，各 4D；打包式单个 5D tensor `[max_num_pages, 2, page_size, num_kv_heads, head_dim]`（`[:,0]` 为 K，`[:,1]` 为 V）。`_unpack_paged_kv_cache()`（`utils.py:186`）统一处理。layout 通过 `TensorLayout[self._kv_layout].value` 传给 kernel。

MLA 的 page 布局特殊：分离的 `ckv_cache`（compressed KV，`[num_pages, page_size, head_dim_ckv]`，DeepSeek 为 512）和 `kpe_cache`（key positional embedding，`[num_pages, page_size, head_dim_kpe]`，64）。

### Persistent Cooperative Kernel

`BatchAttention` 的底层是 `PersistentKernelTemplate`（`include/flashinfer/attention/persistent_template.cuh:57`），用 `cudaLaunchCooperativeKernel`（`persistent.cuh:691`）启动。这意味着所有 thread block 必须同时驻留 GPU（occupancy 100%），可用 `grid.sync()`（`persistent_template.cuh:82`）做全局同步。`num_blks_y` = `num_clusters` = SM 数量（head_dim < 256 时为 2×SM）。

plan 阶段的 `TwoStageHolisticPlan`（`scheduler.cuh:1240`）按 query 长度区分请求类型：`packed_qo_len > 16` 归 task[0]（prefill，`CTA_TILE_Q=128`），否则归 task[1]（decode，`CTA_TILE_Q=16`）。用 MinHeap 基于 `cost = 2*qo_len + kv_len` 做负载均衡，分配到各 SM cluster。kernel 内三类 runner 顺序执行：prefill runner → `grid.sync()` → decode runner → `grid.sync()` → `BlockReductionPersistent` 合并 split-KV 的 `partial_o`/`partial_lse`。

### MLA 与普通 attention 的差异

MLA（`mla/_core.py:1414` `BatchMLAPagedAttentionWrapper`）的核心差异：**Head 维度分离**——用 `MLAHeadDimensions`（`mla/_core.py:87`）含 `qk_nope_head_dim`（不带 RoPE）、`qk_rope_head_dim`（带 RoPE）、`v_head_dim`、`kv_lora_rank`（压缩 KV 维度）。**Matrix Absorption** 技巧：decode 时 W_UQ 吸收 W_UK、W_UV 吸收 W_O，使 Q 维度变为 `kv_lora_rank` 而非原始 `qk_nope_head_dim`。**输入分离**：run 接收 `q_nope`/`q_pe`/`ckv_cache`/`kpe_cache` 四个 tensor。**Autotuner 集成**：MLA decode 支持 `trtllm-gen` 和 `cute-dsl` 两个 runner 通过 `AutoTuner.choose_one` 竞争（`mla/_core.py:3674`），普通 attention 无此机制。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Plan-Run 两阶段 | `BatchAttention.plan/run` in `_core.py:94/215` | host 规划与 kernel launch 分离，后者可入图 |
| Wrapper | `BatchAttentionWithAttentionSinkWrapper` in `_core.py:330` | variant 通过 jit_args 注入，不改基类 |
| Backend 选择策略 | `determine_attention_backend` in `utils.py:522` | 按 arch/约束自动选 fa3/fa2/cudnn/... |
| Autotuner（MLA） | `TrtllmGenMlaDecodeRunner` in `mla/_core.py:2514` | trtllm-gen 与 cute-dsl runner 竞速 |
| JIT Module 缓存 | `@functools.cache` on `get_holistic_attention_module` in `_core.py:39` | 同参数 module 只编译一次 |

## 模块间交互

attention → jit：`BatchAttention.plan()` 调 `gen_batch_attention_module()`（`jit/attention/modules.py:1139`）生成 JitSpec 并 `build_and_load()`。Jinja 模板把 dtype/head_dim/pos_encoding 实例化为 C++ 类型，每个 mask_mode（0-3）生成一个 `.cu` 文件做模板实例化。

attention → autotuner：仅 MLA decode 路径（`mla/_core.py:3674`）构建 `List[TunableRunner]` 调 `AutoTuner.choose_one`。普通 attention 不走 autotuner——config 在编译期（Jinja）和 plan 期（调度）完成。

decode ↔ prefill 交叉依赖：`decode.py` 导入 `BatchPrefillWithPagedKVCacheWrapper`（`decode.py:54`），`use_tensor_cores=True` 时 decode 复用 prefill kernel（`decode.py:1656`）。`cascade.py` 同时依赖两者。

## 扩展方式

**新增 attention variant**（如 attention sink）：参考 `BatchAttentionWithAttentionSinkWrapper`（`_core.py:330`）——在 `flashinfer/jit/attention/variants.py` 定义 variant 的 C++ 声明，创建子类构造 `jit_args`（含 `variant_name`/`variant_decl`）传父类 `__init__`，在 `include/flashinfer/attention/variants.cuh` 加 C++ 实现。

**新增 backend**：在 `determine_attention_backend()`（`utils.py:522`）加选择逻辑，在 `jit/attention/modules.py` 加 `gen_*_module`，在 `decode.py:_plan_impl()`/`run()` 加 backend 分支，在 `include/flashinfer/attention/` 加 `.cuh` kernel。若用 autotuner，实现 `TunableRunner` 子类（参考 `TrtllmGenMlaDecodeRunner`）。
