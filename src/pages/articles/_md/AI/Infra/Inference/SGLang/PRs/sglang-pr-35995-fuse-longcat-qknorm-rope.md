---
title: "融合 LongCat-Image 的 QKNorm 与全宽交错 RoPE"
source:
  project: "SGLang"
  type: "PR"
  id: "35995"
  url: "https://github.com/sgl-project/sglang/pull/35995"
  prType: "perf"
date: "2026-08-26T14:40:53+08:00"
category: [AI, Infra, Inference, SGLang, PRs]
tags: ["Diffusion", "DiT", "SGLang", "CUDA", "RoPE", "QKNorm", "JIT Kernel", "LongCat-Image"]
description: "解读 PR #35995：扩展 JIT QKNorm+RoPE 融合核支持 FP32 全宽交错缓存，落地 LongCat-Image，端到端加速 17% 且输出逐字节一致。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#35995](https://github.com/sgl-project/sglang/pull/35995) · **Issue** - · **commit** [8dcfb3b](https://github.com/sgl-project/sglang/commit/8dcfb3b5e71e05aa921866deae1f8b2686706309) · **首发版本** - · **变更行数** +394 行 · **合并时间** 2026-08-24

> 📎 本文是 [在 SGLang 中接入 LongCat-Image：一个文生图 DiT 模型的全栈适配](/vibe-reading/articles/sglang-pr-23274-support-longcat-image) 的后续优化，建议先阅读原文。

---

## 背景

LongCat-Image 在 PR [#23274](https://github.com/sgl-project/sglang/pull/23274) 中被接入 SGLang `multimodal_gen` 框架，获得了 TP 多卡推理与统一 API。但那次接入在注意力块里留了一处"未融合"的尾巴：**QKNorm 用 SGLang 融合核，RoPE 却仍走 diffusers 的 `apply_rotary_emb`**。

原因是 LongCat 的 RoPE 比较特殊——`axes_dims_rope=[16,56,56]` 之和 = 128 = `head_dim`，是**全维度旋转**（`rotary_dim == head_dim`）。而 SGLang 的 JIT 融合 `fused_qknorm_rope` 核当时只支持 compact 缓存（`rotary_dim < head_dim`），对全宽缓存的支持仅限 NeoX 布局，交错（interleaved）布局的全宽缓存会被 `_can_use_fused_qknorm_rope` 直接拒绝。于是 LongCat 只能退回 diffusers 参考实现。

这条退路代价不低：diffusers 的 `apply_rotary_emb` 把 RoPE 拆成 rotate-pair → mul → add 一长串元素级算子，在 1024×1024 / 50 步的 H200 上会物化出约 **4k 次 QKNorm 调用 + 18k 次拷贝 + 12k 次乘 + 6k 次加 + 12k 次 cat + 6k 次 neg**，光这一段就占约 2.0 s 核时。

本 PR 的目标，是把这些散落的元素级 RoPE 算子**收进同一个 JIT 融合核**里——既保留 LongCat 全宽交错 RoPE 的数值语义，又消除 diffusers 链路的内核启动与中间张量开销。

![LongCat-Image 双流注意力 QKNorm+RoPE 路径改动前/后](/vibe-reading/images/articles/sglang-pr-35995-fuse-longcat-qknorm-rope/attention-before-after.svg)

上图标注了改动位置：改动前（上）QKNorm 已融合但 RoPE 走 diffusers、爆炸为约 54k 次元素级 op；改动后（下）整段替换为单次 `_apply_longcat_qknorm_rope` JIT 融合核。投影、concat、USPAttention 语义不变。

---

## 前置知识

### QKNorm + RoPE 融合核

SGLang 的 `fused_qknorm_rope_warp` 是一个 JIT 编译的 CUDA 核：每个 warp 处理一个 (token, head) 的 Q 或 K 向量，**一次性完成 RMSNorm 归一化 + RoPE 旋转 + 回写**，省去中间张量与多次核启动。核以模板参数特化 `kHeadDim` / `kRopeDim` / `kIsNeox` / `kRoundNormBeforeRope` / `kCacheHasFullWidth` 等编译期选项。

### 交错 RoPE vs NeoX RoPE

- **NeoX**：把 head_dim 前后两半对换旋转（`[a,b,c,d] → [c,d,a,b]` 再算），同一对 `(cos, sin)` 用于一对**跨半**元素。
- **交错（interleaved）**：相邻两个元素 `(x₂ᵢ, x₂ᵢ₊₁)` 成对，输出 `x' = x·cos − y·sin`，`y' = y·cos + x·sin`。LongCat 用的是交错布局。

### compact vs full-width cos/sin 缓存

![cos/sin 缓存布局 compact vs full-width](/vibe-reading/images/articles/sglang-pr-35995-fuse-longcat-qknorm-rope/cache-layout.svg)

上图对比两种缓存布局：compact（左）每对元素共用一个 `(cos, sin)` 索引，一次 load 同时用于 `x` 与 `y`；full-width（右）每个元素有独立的 `cos/sin`（`cos₂ᵢ ≠ cos₂ᵢ₊₁`），需两次 load。LongCat 的全维度旋转属于后者。

### round_norm_before_rope

融合核默认在 FP32 里算完 norm 再算 RoPE、最后才 round 回 bf16，比"split 链"少一次舍入。开启 `round_norm_before_rope=True` 后，核会在 norm 之后、RoPE 之前**先 round 到激活精度**，从而与 split 参考链（先 norm→round bf16，再 RoPE）逐位一致。LongCat 的参考链正是 diffusers：`apply_qk_norm`（RMSNorm 输出 bf16）→ `apply_rotary_emb`（FP32 算 RoPE），所以本 PR 同时开启 `round_norm_before_rope=True` 与 FP32 缓存来匹配。

---

## 设计参考

本 PR 不发明新机制，而是**把已有的融合能力扩展到一条新布局**，并复用已成熟的两套基础设施：

1. **全宽缓存支持已存在**：核的 `kCacheHasFullWidth` 模板参数与 `test_qknorm_rope_preserves_full_width_neox_cache` 测试表明，full-width NeoX 路径此前已落地。本 PR 把"全宽"从 NeoX 扩展到交错布局，并放宽 `round_norm_before_rope` 对 FP32 缓存的限制。
2. **BitExactFusionGate 模式**：GLM / Ernie / FLUX / Sana 等模型早已用 `BitExactFusionGate` 做"首跑逐位校验 + 失败回退"的守护。LongCat 直接复用同一套 gate（`bitexact_gate.py`），把 diffusers 链作为 oracle 做一次性 `torch.equal` 校验。

---

## 实现

### 1. 核：新增 FP32 旋转路径

原有 `rotary_add` / `rotary_sub` 在**激活精度**（bf16/fp16）里用 PTX `mul.rn` / `add.rn` 算旋转，要求 `cos/sin` 与激活同 dtype。但 LongCat 的 `cos/sin` 是 FP32 全宽缓存，若直接套用会把 FP32 的 `cos` 强转 bf16 损失精度、且与 diffusers 的 FP32 oracle 不一致。于是新增两个 FP32 专用旋转函数：

```cpp title="python/sglang/kernels/jit/csrc/diffusion/qknorm_rope.cuh"
template <typename T>
SGL_DEVICE T rotary_add_fp32(T x, float cos, T y, float sin) {
  const float x_fp32 = device::cast<fp32_t>(x);
  const float y_fp32 = device::cast<fp32_t>(y);
#ifdef USE_ROCM
  return device::cast<T>(x_fp32 * cos + y_fp32 * sin);
#else
  const float lhs = __fmul_rn(x_fp32, cos);
  const float rhs = __fmul_rn(y_fp32, sin);
  return device::cast<T>(__fadd_rn(lhs, rhs));
#endif
}
// rotary_sub_fp32 结构对称：lhs = __fmul_rn(x_fp32, cos);
//                            rhs = __fmul_rn(-y_fp32, sin);  return cast<T>(__fadd_rn(lhs, rhs));
```

`__fmul_rn` / `__fadd_rn` 是 CUDA 的 FP32 round-to-nearest-even 内建函数。`x`、`y` 上转 FP32 → FP32 乘加 → 下转回 `T`（bf16），与 diffusers `apply_rotary_emb` 内部 `x.float() * cos + ... .to(x.dtype)` 的数值路径一致。

### 2. 核：放宽静态断言

`round_norm_before_rope` 原本要求 `DType == CacheDType`（缓存与激活同精度），现在新增一个分支：**FP32 缓存也允许**。

```cpp title="python/sglang/kernels/jit/csrc/diffusion/qknorm_rope.cuh"
static_assert(
    !kRoundNormBeforeRope || std::is_same_v<DType, CacheDType>
                          || std::is_same_v<CacheDType, fp32_t>,
    "Rounded QKNorm+RoPE requires cache and activation dtypes to match or an FP32 cache");
```

### 3. 核：交错全宽路径——每元素独立索引

这是最关键的改动。原交错路径用同一个 `half_idx` 给一对 `(x, y)` 取 `cos/sin`（compact 语义）。全宽下 `x` 与 `y` 各有自己的 `cos/sin`，必须取**相邻两个索引**：

```cpp title="python/sglang/kernels/jit/csrc/diffusion/qknorm_rope.cuh"
const auto cache_idx_0 =
    kCacheHasFullWidth ? lane_id * kElemsPerThread + 2 * j
                       : lane_id * kElemsPerThread / 2 + j;
const auto cache_idx_1 = kCacheHasFullWidth ? cache_idx_0 + 1 : cache_idx_0;
const auto cos_0 = load_cache_value(cos_ptr, cache_idx_0);
const auto sin_0 = load_cache_value(sin_ptr, cache_idx_0);
const auto cos_1 = load_cache_value(cos_ptr, cache_idx_1);
const auto sin_1 = load_cache_value(sin_ptr, cache_idx_1);
const auto x = values[0];
const auto y = values[1];
if constexpr (std::is_same_v<CacheDType, fp32_t>) {
  values[0] = rotary_sub_fp32(x, cos_0, y, sin_0);
  values[1] = rotary_add_fp32(y, cos_1, x, sin_1);
} else {
  values[0] = rotary_sub(x, cos_0, y, sin_0);
  values[1] = rotary_add(y, cos_1, x, sin_1);
}
```

对照 diffusers 的 `apply_interleaved` 参考：`out₂ᵢ = x₂ᵢ·cos₂ᵢ − x₂ᵢ₊₁·sin₂ᵢ`，`out₂ᵢ₊₁ = x₂ᵢ₊₁·cos₂ᵢ₊₁ + x₂ᵢ·sin₂ᵢ₊₁`。核里 `values[0]=rotary_sub_fp32(x,cos₀,y,sin₀)=x·cos₀−y·sin₀`、`values[1]=rotary_add_fp32(y,cos₁,x,sin₁)=y·cos₁+x·sin₁`，逐位对齐。`round_norm_before_rope` 分支与默认（FP32 norm）分支都做了同样的索引修正。

### 4. JIT 胶水：拆除两道限制

`_can_use_fused_qknorm_rope` 此前有两处早退挡住了 LongCat：

```python title="python/sglang/kernels/ops/diffusion/rope/qknorm_rope_jit.py"
# 删除：全宽缓存只许 NeoX 的早退
-    elif cache_has_full_width:
-        logger.warning("Full-width cos/sin caches are only supported for NeoX RoPE")
-        return False
# 放宽：round_norm 允许 FP32 缓存
-    if round_norm_before_rope and cache_dtype != dtype:
+    if round_norm_before_rope and cache_dtype not in (dtype, torch.float32):
         logger.warning(
-            "Exact fused QKNorm+RoPE requires cache dtype %s to match activation dtype %s",
+            "Exact fused QKNorm+RoPE requires cache dtype %s to match activation "
+            "dtype %s or use float32",
             cache_dtype, dtype,
         )
```

### 5. 模型：LongCat 融合入口 + 运行时守护

`longcat_image.py` 新增 `_apply_longcat_qknorm_rope` 作为统一入口：能融合就走融合核，否则回退 diffusers 参考链。融合条件严格枚举形状、dtype、连续性、eps 相等，并委托 `can_use_fused_inplace_qknorm_rope(..., is_neox=False, round_norm_before_rope=True, cache_has_full_width=True)` 做最终判定：

```python title="python/sglang/multimodal_gen/runtime/models/dits/longcat_image.py"
_LONGCAT_QKNORM_ROPE = BitExactFusionGate("LongCat fused QKNorm+RoPE")

def _apply_longcat_qknorm_rope(q, k, q_norm, k_norm, head_dim,
                               image_rotary_emb, cos_sin_cache, positions):
    if image_rotary_emb is None:
        return apply_qk_norm(q, k, q_norm, k_norm, head_dim)
    ...
    can_fuse = (
        cos_sin_cache is not None and positions is not None
        and q.is_cuda and not torch.compiler.is_compiling()
        and q_eps == k_eps
        and q.dtype in (torch.float16, torch.bfloat16)
        ...
        and can_use_fused_inplace_qknorm_rope(
            head_dim=head_dim, rope_dim=head_dim, is_neox=False,
            dtype=q.dtype, cache_dtype=cos_sin_cache.dtype,
            round_norm_before_rope=True, cache_has_full_width=True,
        )
    )
    verified = _LONGCAT_QKNORM_ROPE.verified
    if can_fuse and not _LONGCAT_QKNORM_ROPE.disabled \
            and (verified or _LONGCAT_QKNORM_ROPE.can_attempt_once()):
        ...
        try:
            out = apply_qk_norm_rope(q=q, k=k, ..., is_neox=False,
                positions=positions, round_norm_before_rope=True,
                cache_has_full_width=True)
        except Exception as exc:
            _LONGCAT_QKNORM_ROPE.on_exception(exc, logger=logger)
            return _longcat_qknorm_rope_reference(q_input, ...)
        else:
            if verified:
                return out
            ref = _longcat_qknorm_rope_reference(q_input, ...)
            return _LONGCAT_QKNORM_ROPE.accept_or_fallback(
                out, ref, equal=tensors_equal, logger=logger, ...)
    return _longcat_qknorm_rope_reference(q, k, ...)
```

守护逻辑分三层：① `disabled` 永久关闭（首跑失败后置位）；② `verified` 首跑逐位校验通过后常驻开启；③ `can_attempt_once()` 保证首跑不在 `torch.compile` 追踪或 CUDA graph 捕获期间触发（那会因 host sync 中断捕获）。`accept_or_fallback` 用 `tensors_equal`（支持多张量序列的 `torch.equal`）比对融合输出与 diffusers oracle，一致则 `mark_verified`，不一致则 disable 并返回参考输出——**正确性永不受损**。

### 6. 模型：贯穿 cos_sin_cache 与 positions

DiT `forward` 从 `image_rotary_emb`（`pos_embed` 的 FP32 输出）构造融合核所需的 `cos_sin_cache` 与 `positions`，并下传到每个 block：

```python title="python/sglang/multimodal_gen/runtime/models/dits/longcat_image.py"
cos, sin = image_rotary_emb
cos_sin_cache = torch.cat((cos, sin), dim=-1).contiguous()   # [S, 2*head_dim] FP32
positions = torch.arange(cos.shape[0], device=cos.device, dtype=torch.int64)
```

双流块（`_LongCatJointAttention`）按文本/图像段**切分** cos/sin 与 positions，分别给文本流与图像流；单流块整体传入：

```python title="python/sglang/multimodal_gen/runtime/models/dits/longcat_image.py"
cos, sin = image_rotary_emb
image_rotary_emb_txt = (cos[:txt_seq_len], sin[:txt_seq_len])
image_rotary_emb_img = (cos[txt_seq_len:], sin[txt_seq_len:])
positions_txt = positions[:txt_seq_len] if positions is not None else None
positions_img = positions[txt_seq_len:] if positions is not None else None

q, k = _apply_longcat_qknorm_rope(q, k, self.norm_q, self.norm_k,
        self.head_dim, image_rotary_emb_img, cos_sin_cache, positions_img)
eq, ek = _apply_longcat_qknorm_rope(eq, ek, self.norm_added_q, self.norm_added_k,
        self.head_dim, image_rotary_emb_txt, cos_sin_cache, positions_txt)
```

注意一个语义迁移：原实现先 `cat([txt,img])` 再对整段序列施 RoPE；新实现**按流分别施 RoPE 再 cat**。由于 `positions` 与 `cos_sin_cache` 同源切分，数值结果等价，只是融合与并行的粒度更细。原 diffusers `apply_rotary_emb(..., sequence_dim=1)` 的整段调用被删除。

---

## 测试

### 单元测试

`test_rope.py` 新增核级逐位测试 `test_qknorm_rope_preserves_full_width_interleaved_cache`，oracle 是手写的 split 链（`fused_inplace_qknorm` + FP32 `apply_interleaved_rope`），对 fp16 / bf16 两种 dtype 断言 `torch.equal`：

```python title="test/registered/kernels/ops/diffusion/test_rope.py"
def apply_interleaved_rope(x):
    x_real, x_imag = x.float().reshape(*x.shape[:-1], -1, 2).unbind(-1)
    x_rotated = torch.stack((-x_imag, x_real), dim=-1).flatten(-2)
    selected_cos = cos[positions, None]
    selected_sin = sin[positions, None]
    return (x.float() * selected_cos + x_rotated * selected_sin).to(dtype)

fused_inplace_qknorm_rope(q, k, q_weight, k_weight, cache, positions,
    is_neox=False, eps=1e-6, round_norm_before_rope=True, cache_has_full_width=True)
assert torch.equal(q, q_ref)
assert torch.equal(k, k_ref)
```

### 回归测试

`test_model_fast_paths.py` 新增模型级快路径测试 `test_longcat_qknorm_rope_is_bit_exact`，oracle 是 diffusers 链（`apply_qk_norm` + `apply_rotary_emb`）。除了逐位相等，还断言**就地写回**（`data_ptr` 不变）与 gate 状态：

```python title="test/registered/kernels/ops/diffusion/test_model_fast_paths.py"
q_out, k_out = _apply_longcat_qknorm_rope(q_fused, k_fused, q_norm, k_norm,
    head_dim, image_rotary_emb, cache, positions)
assert q_out.data_ptr() == q_fused.data_ptr()
assert k_out.data_ptr() == k_fused.data_ptr()
assert torch.equal(q_out, q_ref)
assert torch.equal(k_out, k_ref)
assert longcat_image._LONGCAT_QKNORM_ROPE.verified
assert not longcat_image._LONGCAT_QKNORM_ROPE.disabled
```

### 性能测试

微基准 `bench_qknorm_rope.py` 新增 `longcat_1024` 形状（`num_tokens=4608, num_heads=24, head_dim=128`，开启 `cache_has_full_width` 与 `round_norm_before_rope`）。split 基线对全宽交错用上述手写 `apply_interleaved`（而非 flashinfer，因为 flashinfer 不支持全宽交错），LINE_NAMES 也从 "JIT QKNorm + FlashInfer RoPE" 改为 "Split QKNorm + RoPE" 以反映这点。

PR body 给出 H200 实测（`meituan-longcat/LongCat-Image`，1024×1024，50 步，seed 42）：

| 指标 | split 基线 | 融合后 | 收益 |
| --- | ---: | ---: | ---: |
| `longcat_1024` 微基准 | 741.28 µs | 54.46 µs | **13.61×** |
| eager 端到端（lossless） | ~9.06 s | ~7.46 s | **17.47%** |
| Breakable CUDA Graph（high 去噪段） | 8.97 s | 7.44 s | 17.09% |
| 该段 GPU 总时长 | ~8.74 s | ~7.20 s | — |

每对 main/PR 输出**逐字节一致**：lossless SHA256 `d3984b9d…ce3dd6f`，high SHA256 `b252ce3f…ded743f9`。BCG（Breakable CUDA Graph）每个 cell 都成功捕获/回放服务签名、无回退。

---

## 问题

### 为什么 LongCat 的 cos/sin 缓存是 FP32 全宽？

LongCat 的 `pos_embed`（RoPE 频率表）按 diffusers 参考在 FP32 计算，且 `axes_dims_rope=[16,56,56]` 之和 = `head_dim = 128`，全维度旋转。于是 `cos`/`sin` 各为 `[seq_len, head_dim]` 的 FP32 张量；`torch.cat((cos, sin), dim=-1)` 拼成 `[seq_len, 2*head_dim]` 的全宽 FP32 缓存。全宽意味着每个元素有独立旋转角，而非每对共享。

### 为什么需要 rotary_add_fp32 而非直接用 rotary_add？

`rotary_add` 用 PTX `mul.rn.bf16` 在 bf16 里算，前提是 `cos/sin` 也是 bf16。LongCat 的 `cos/sin` 是 FP32，若强转 bf16 会丢精度且不匹配 diffusers 的 FP32 oracle。`rotary_add_fp32` 把 `x/y` 上转 FP32、用 `__fmul_rn/__fadd_rn` 做 FP32 round-to-nearest、再下转回 bf16——与 diffusers `x.float() * cos + … .to(x.dtype)` 逐位一致，保证 `torch.equal`。

### 为什么 round_norm_before_rope=True？

diffusers 参考链是 `apply_qk_norm`（RMSNorm，FP32 归一后 round 到 bf16）→ `apply_rotary_emb`（FP32 RoPE）。`round_norm_before_rope=True` 让融合核在 norm 之后、RoPE 之前先 round 到 bf16，复刻这次中间舍入；再配合 FP32 RoPE，整条数值路径与 oracle 对齐，从而逐位相等。若不开，融合核会在 FP32 里连算 norm+RoPE、少一次舍入，与 split 链差约一个 bf16 ULP。

### 为什么还要 runtime gate + 回退？

逐位相等依赖具体的 PTX 舍入行为与 FlashInfer/RMSNorm 后端，跨平台（GPU 架构、驱动、库版本）可能漂移。`BitExactFusionGate` 在**首次**调用时同时跑融合核与 diffusers 参考链、host sync 后 `torch.equal` 比对：一致则 `verified` 常驻、后续直接走融合核（零开销）；不一致则 `disable` 并返回参考输出，正确性不受影响。JIT 编译失败走 `on_exception` 同样回退。这让 PR 能安全合入而不赌平台行为。

---

## 意义与影响

本 PR 把 LongCat-Image 从"QKNorm 融合、RoPE 走 diffusers"升级为**全融合路径**，在 H200 1024×1024 上端到端加速约 17%，且输出与基线逐字节一致、BCG 可捕获可回放。微基准层面 13.6× 的核级加速直接来自消除 diffusers RoPE 链的 ~54k 次元素级 op 与对应内核启动。

更关键的是它**扩展了融合核的能力边界**：此前全宽缓存只覆盖 NeoX，本 PR 证明同一套 `kCacheHasFullWidth` + 每元素独立索引 + FP32 旋转路径也能服务于交错布局与 FP32 缓存。这意味着更多"全维度旋转"的扩散模型（Flux 同族、axes_dims 之和等于 head_dim 者）都能套用这条融合路径，而非被迫退回 diffusers。

`BitExactFusionGate` 的复用也印证了这套守护机制的可移植性：LongCat 只新增了一个 gate 实例和一份 diffusers 参考函数，就接入了与 GLM/Ernie/FLUX/Sana 同款的"首跑校验 + 失败回退"安全网，让性能优化与数值安全解耦。配合核契约文档（README）的同步更新，这是一次边界清晰、可回退、可验证的内核扩展。

---

## 参考

- [diffusers `apply_rotary_emb`](https://github.com/huggingface/diffusers/blob/main/src/diffusers/models/embeddings.py) — LongCat RoPE 的参考实现（FP32 全宽旋转）
- [SGLang diffusion kernel 契约文档](https://github.com/sgl-project/sglang/blob/main/python/sglang/kernels/ops/diffusion/README.md) — `fused_inplace_qknorm_rope` 的全宽/round_norm 契约

---

## 相关阅读

- [在 SGLang 中接入 LongCat-Image：一个文生图 DiT 模型的全栈适配](/vibe-reading/articles/sglang-pr-23274-support-longcat-image) — **前序**·本篇优化的模型在 PR #23274 中的全栈接入，解释了为何当时 RoPE 被迫走 diffusers
- [LongCat-Image Technical Report](/vibe-reading/articles/longcat-image-technical-report) — **模型来源**·LongCat-Image 原论文（MM-DiT 混合架构 + 三阶段数据精炼）
- [在 SGLang 中接入 LongCat-AudioDiT](/vibe-reading/articles/sglang-pr-22191-support-longcat-audiodit) — **同系列落地线**·同系列模型接入 `multimodal_gen` 的文生音频分支，与本篇的扩散算子融合对照
- [LongCat-Image-Edit 接入 SGLang](/vibe-reading/articles/sglang-pr-35829-longcat-image-edit) — **同模型 Edit 分支**·同框架同系列的图像编辑（I2I）接入，隐空间拼接与联合 VL 编码
