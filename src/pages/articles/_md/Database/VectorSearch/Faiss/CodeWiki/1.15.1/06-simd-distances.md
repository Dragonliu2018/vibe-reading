---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "距离核与 SIMD"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "SIMD", "AVX-512", "NEON"]
description: "Faiss SIMD 基础设施解读——simdlib 类型化 API 体系、with_simd_level 循环外分派、BLAS 阈值切换、HammingComputer 码长分派、16 桶直方图 partitioning 与 approx_topk 桶化堆"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)

---

## 模块定位

`faiss/utils/distances.*` + `faiss/impl/simd_dispatch.h` + `faiss/impl/simdlib/` 是全库的计算地基。它回答的问题：**一份算法代码如何同时服务 AVX2/AVX-512/NEON/SVE/RVV/PPC64 六个 ISA？** Faiss 的答案分两层：simdlib 提供"一套类型化 SIMD API + 每 ISA 一份特化 + emulated 兜底"；dispatch 层用"编译期多份 + 运行时一次选"把 `SIMDLevel` 作为模板实参在**循环外**选定——此后整个循环体以纯编译期常量等级运行，无逐次调用开销、无函数指针间接跳转。对比 USearch 的 NumKong 路由（核注册为运行时可换的回调表）：Faiss 选模板实参，编译器可跨核内联与特化常量，代价是逐 ISA 编译多份 TU 与一整套 ODR 纪律。

## 模块架构

![SIMD 动态分派](/vibe-reading/images/articles/faiss-internals/simd-dispatch.svg)

编译期：DD 模式（`FAISS_OPT_LEVEL=dd`，Python wheel 默认）下同一 `faiss` target 编进全部 ISA 的 TU，**逐文件**设置不同 `-m` 标志（AVX2 源 `-mavx2 -mfma -mf16c -mpopcnt`，SPR 源再加 VNNI/FP16/BF16；公共源反而显式 `-mno-avx -mno-avx2` **防自动向量化**，faiss/CMakeLists.txt:551-553）。非 DD 模式则整套装进 `faiss_avx2`/`faiss_avx512`/`faiss_avx512_spr`/`faiss_sve` 各自的 object library。运行时：`SIMDConfig::auto_detect_simd_level()`（cpuid/xgetbv）检测，环境变量 `FAISS_SIMD_LEVEL` 或 `set_level()` 覆盖。

## 核心实现

### SIMDLevel 与三级分派

枚举（`utils/simd_levels.h:19-37`）：`NONE / AVX2 / AVX512 / AVX512_SPR（Sapphire Rapids 全家桶）/ ARM_NEON / ARM_SVE / RISCV_RVV / AVX512_VPOPCNT`——新值**按序追加**保数值稳定。三级机制：

- `get_simd_fallback`（simd_dispatch.h:56）：编译期回退链 SPR→VPOPCNT→AVX512→AVX2→NONE（x86）、SVE→NEON→NONE（ARM）；
- `with_selected_simd_levels`（simd_dispatch.h:114）：核心入口，DD 模式下对 `SIMDConfig::level` 做一次 switch，每个 case 由 `#ifdef COMPILE_SIMD_XXX` 编译期裁剪 + `[[fallthrough]]` 逐级下探；静态模式下走编译期 `dispatch_with_fallback`——运行时开销严格为零；
- `dispatch_simd_level_or_lower`（simd_dispatch.h:91）：供"工厂型"动作——某级别可以**返回空拒绝**（如 AVX-512 版核要求 `d % 16 == 0`），运行时沿链重试下一级。

`with_simd_level` 的头注释（simd_dispatch.h:215-218）点明收益："分派发生在任何循环之外，loop body 以最优实现运行而无需 per-iteration 开销"。`SIMDConfig::avx512_split` 标志识别 AMD Zen 4 的分裂 512 数据通路（family 0x19，simd_levels.cpp:137），让 [FastScan](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/04-fastscan) 优先选 256-bit 内核。

### simdlib：类型化 SIMD API

主模板按"位宽 × 元素解释"分型（`impl/simdlib/simdlib.h:26-45`）：256 位族 `simd256bit_tpl`/`simd32uint8_tpl`/`simd8float32_tpl`…，512 位族同理——全部以 `SIMDLevel` 为模板参数。每 ISA 一份特化：`simdlib_avx2.h`（29K 行，持 `__m256`，提供 operator+/-/*、loadu/storeu）、`simdlib_avx512.h`（12K，持 `__m512i`）、`simdlib_neon.h`（49K）、`simdlib_ppc64.h`、`simdlib_emulated.h`（31K，`simd256bit_tpl<NONE>` 是 32 字节 union + memcpy 语义——**emulated 兜底让无 SIMD 平台/调试构建也跑通全部代码路径**）。

**为什么不直接写 intrinsics**（设计动机）：一套 API 覆盖全部 ISA，跨平台核只写一遍；类型安全——`simd16uint16` 与 `simd8float32` 是不同类型，做错 lane 解释编译期报错（intrinsics 全是裸 `__m256i`）；emulated 参考实现可验证。配套 `simd256_level_selector`（simd_levels.h:86）解决"512 位等级下 256 位类型映射到谁"（AVX512*→AVX2、SVE→NEON）。

**简单核反而不用 simdlib**：`fvec_L2sqr`/`fvec_inner_product` 等用 `FAISS_PRAGMA_IMPRECISE_LOOP` 标记的普通标量循环让编译器**自动向量化**（distances_autovec-inl.h:22 注释），每个 ISA TU 用各自的 `-mavx2` 旗标各自 autovec——手写只留给编译器做不好的（维度特化 D2/D4/D8 核，distances_avx2.cpp:241-570）。

### 距离核 API 与 KNN 驱动

两级 API（`utils/distances.h`）：每核一个普通函数 + 一个 `template <SIMDLevel>` 版本。族系：单对（`fvec_L2sqr`/`fvec_inner_product`）、批量 4 路（`fvec_L2sqr_batch_4`——HNSW 的 distances_batch_4 消费）、1:N（`_ny` 后缀及转置版）。

`knn_L2sqr`（distances.cpp:841）完整决策链：

```
1. IDSelectorRange/Array 的 dynamic_cast 短路（翻译成指针平移或 by_idx）
2. should_use_db_parallel（distances.cpp:760）：
   查询数 < 线程数 且 库 > max(10000, nt×1024) → 按数据库分段并行
3. dispatch_knn_ResultHandler（ResultHandler.h:715）三档选处理器：
   k==1 → Top1Block / k<100 → HeapBlock / 否则 → ReservoirBlock
4. Run_search_L2sqr（distances.cpp:581）：
   res.sel 非空 或 nx*d < 128000 → 顺序 SIMD（exhaustive_L2sqr_seq）
   否则 → exhaustive_L2sqr_blas
```

BLAS 路径（`exhaustive_L2sqr_blas_default_impl`，distances.cpp:425-511；sgemm 经 `#define FINTEGER long` + `extern "C"` 声明直链 Fortran BLAS，distances.cpp 顶部）：预计算两侧范数 → 按 4096×1024 分块 `sgemm_("Transpose",...)` 算内积块 → `dis = x_norms[i] + y_norms[j] − 2·ip` 回填（负值截 0）。k=1 特化优先尝试**融合核** `exhaustive_L2sqr_fused_cmax`（`utils/distances_fused/`，按维度硬编码展开——避免把临时点积写回 RAM，主要服务 PQ/k-means 训练的 top-1 赋值）。

**阈值是 `nx*d`（元素数）不是查询数**：`distance_compute_blas_threshold = 128000`（distances.cpp:607）——小批量下 GEMM 的打包开销反而输给内联 SIMD 循环（查询驻留寄存器、结果直接喂堆）。同文件还有被 `#if 0` 掉的 sgemv 尝试（"BLAS slower for the use cases here"，distances_simd.cpp:76）——Faiss 在阈值调优上留下的诚实痕迹。

### distances_dispatch.h：一行一个的分派包装

不是宏，是 256 行 inline 包装函数（`utils/distances_dispatch.h:31-221`）：

```cpp title="utils/distances_dispatch.h:46"
inline float fvec_L2sqr_dispatch(const float* x, const float* y, size_t d) {
    return with_selected_simd_levels<AVAILABLE_SIMD_LEVELS_BASE_WITH_SVE>(
            [&]<SIMDLevel SL>() { return fvec_L2sqr<SL>(x, y, d); });
}
```

**新增一个距离核的最少改动**：声明 2 行（distances.h）+ 分派包装 4 行（dispatch.h）+ 公共函数体 1 行委托（distances.cpp）+ 实现 1 份（最省事路径：只在 `distances_autovec-inl.h` 写标量循环，所有 ISA TU 各自 autovec，0 份手写 ISA 代码）。

### Hamming：码长 × SIMD 的二级编译期分派

`HammingComputer{4,8,16,20,32,64,Default}_tpl<SL>` 系列（`utils/hamming_distance/hamming_computer.h:51`）：把查询码装进寄存器的"查询端"对象，`hamming(b)` 内联展开。**4/8 字节版不分 ISA**（寄存器太宽不划算，hamming_computer.h:66 注释），其余按 SL 特化。`with_HammingComputer<SL>(code_size, f)`（hamming_computer.h:125）按 code_size switch 选型。popcount：标量层 `__builtin_popcount`；NEON `vcntq_u8`；**AVX512_VPOPCNT** 用 `_mm512_popcnt_epi8 + _mm512_sad_epu8`（hamming_computer-avx512_vpopcnt.h:68，v1.15 新增级别的主要受益者）。

`hammings_knn_mc`（counting-max）利用汉明距离取值只有 `bytes×8+1` 种的性质做**桶计数代替堆**——k 大时显著快（hamming_impl.h:129-171）。**impl-header 分派模式**（`impl/binary_hamming/`）：`dispatch.h` 只放 `template <SIMDLevel> ... _fixSL` 前向声明；avx2.cpp/avx512.cpp/neon.cpp/rvv.cpp 各自定义 `THE_SIMD_LEVEL` + include 全部 impl 头——ODR 契约（每 TU 的 THE_SIMD_LEVEL 全局唯一、匿名命名空间内部链接）写在 hamming_impl.h:16-30。

### partitioning：16 桶直方图基数划分

`partition_fuzzy_median3`（utils/partitioning.cpp:121）：不是快排式 qselect，而是 median-of-3 阈值二分 + **原地压缩**（注释自述 O(n log n) 但避免 shuffle，对 cache 友好）；阈值采样用大素数步长 6700417 跳采。SIMD 路径 `partition_fuzzy_simd`（`simd_impl/partitioning_simdlib256.h:375`）：**16 桶直方图基数划分**——对 [s0,s1] 值域反复取高 4 位建 16-bin 直方图（2-bit→4-bit→8-bit 三级位打包累加器），按计数折半，~4 轮收敛——**16-bit 量化码（FastScan 阶段）做 top-k 截断与 kmeans 划分的主力**。

### approx_topk：桶化堆

`impl/approx_topk/`（头注释整页伪代码）：把 n 个候选分进 NBUCKETS 个桶，每桶 SIMD 只维护"每桶最小 D 个"（D=1/2/3），最后各桶代表压入常规堆——以可控精度损失换速度，摊薄堆的标量分支。用在汉明 knn（`SearchParametersHamming` 的模式开关）与 RQ beam search（`rq_beam_search_tab-inl.h`）。

### CMin/CMax 与 Heap：贯穿全库的一等抽象

`utils/ordered_key_value.h:42/65` 的比较器定义 `cmp2(a1,b1,a2,b2)`——"值相等时再比 id"的字典序比较（Heap.h:129 注释），**保证结果确定性**。堆 API 无对象、直接操作 `(bh_val, bh_ids)` 双数组，1-based 索引技巧；`heap_replace_top`（Heap.h:113）是 knn 主循环唯一热操作。这两个类型贯穿：knn 堆、ResultHandler、partitioning、approx_topk、merge_knn_results、HNSW 的 CMin/CMax 双比较器——是 Faiss 最核心的一等抽象。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 类型特化替代条件编译 | simdlib 主模板 + 每 ISA 特化 | ISA 条件从算法代码挪进类型层 |
| 循环外单次分派 | `with_simd_level`（simd_dispatch.h:237） | 零 per-iteration 开销 + 可内联 |
| emulated 兜底 | `simd256bit_tpl<NONE>`（simdlib_emulated.h:20） | 可验证、可移植 |
| autovec 优先 | `FAISS_PRAGMA_IMPRECISE_LOOP`（distances_autovec-inl.h:22） | 不为收益不大的核手写 5 份 |
| 二级编译期分派 | `with_HammingComputer<SL>(code_size)`（hamming_computer.h:125） | 码长 × ISA 的组合裁剪 |

## 模块间交互

被所有索引层消费：IndexFlat 的 BLAS/SIMD 双路径、[IVF scanner](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/02-ivf-inverted-lists) 的 `with_VectorDistance`、[HNSW](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/05-graph-indexes) 的 `distances_batch_4`、[FastScan](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/04-fastscan) 的 `lookup_2_lanes`/`combine2x2`、Clustering 的 k-means 内循环。`AlignedTable.h`（posix_memalign 对齐容器）服务 FastScan 块与 LUT。

## 扩展方式

**新增一个距离核**：沿 `fvec_L1` 样板——声明 2 行 + 分派包装 4 行 + 委托 1 行 + 实现 1 份 autovec（要极致性能才按 ISA 特化）；要进 `VectorDistance`/`with_metric_type` 体系（11 种度量的统一分发）则加 operator() 特化。CMake 只有新增独立 per-ISA .cpp 文件时才登记进 `FAISS_SIMD_*_SRC`。
