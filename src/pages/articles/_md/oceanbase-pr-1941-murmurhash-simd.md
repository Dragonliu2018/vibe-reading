---
title: "用 AVX-512 向量化加速 MurmurHash 批量哈希计算"
source:
  project: "OceanBase"
  type: "PR"
  id: "1941"
  url: "https://github.com/oceanbase/oceanbase/pull/1941"
  prType: "enhancement"
date: "2026-08-05T19:30:00+08:00"
category: [Database, OceanBase, Contributions]
tags: ["OceanBase", "SIMD", "AVX-512", "MurmurHash", "向量化", "C++", "ClickBench"]
description: "新增 murmurhash64A 批量模板函数，利用 AVX-512 指令同时处理 8~128 个定长 key 的哈希计算，集成到 ObFixedLengthVector 的批量哈希路径，面向 ClickBench Q36 等 Hash Group By 场景。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#1941](https://github.com/oceanbase/oceanbase/pull/1941) · **Issue** [#1939](https://github.com/oceanbase/oceanbase/issues/1939) · **commit** [161ba88c](https://github.com/oceanbase/oceanbase/commit/161ba88c3628ab4a79fb647dcf84d6cde8d44e3f) · **首发版本** - · **变更行数** +312 行 · **合并时间** -（未合并）

> ⚠️ 本 PR 尚未合并。GitHub 显示的 +6303/-115 包含 develop 分支合并的噪声 commit；实际有效变更仅为 commit `161ba88c`，+312/-30，涉及 5 个文件。

> 📎 本文与 [用 SIMD 优化 LIKE 模式匹配](/vibe-reading/articles/oceanbase-pr-2016-simd-like-optimization) 是同一思路的两条落地线，均面向 ClickBench 场景的 SIMD 加速，建议对照阅读。

---

## 背景

Issue [#1939](https://github.com/oceanbase/oceanbase/issues/1939) 指出，在向量化执行引擎中，Hash Group By 等算子会对定长数据批量计算哈希值。当前实现逐个 key 调用 `murmurhash64A` 标量函数，无法利用 CPU 的 SIMD 并行能力。ClickBench 的 Q36 查询是典型受影响场景：

```sql title="ClickBench Q36"
SELECT /*+ CB_Q36 parallel(64) */
    ClientIP, ClientIP - 1, ClientIP - 2, ClientIP - 3, COUNT(*) AS c
FROM hits
GROUP BY ClientIP, ClientIP - 1, ClientIP - 2, ClientIP - 3
ORDER BY c DESC LIMIT 10;
```

该查询对 `ClientIP`（4 字节整型）及其衍生列做 4 路 Group By，每路都需要对全表数据批量计算 MurmurHash。标量实现下，每个 key 需要独立的乘法、移位、异或操作，无法并行。

## 前置知识

### MurmurHash 2 (murmurhash64A)

OceanBase 使用的 `murmurhash64A` 是 Austin Appleby 设计的 MurmurHash 2 的 64 位变体。核心算法对每个 8 字节块执行以下操作：

```
val *= m          // 乘法（扩散）
val ^= val >> r   // 右移异或（混淆）
val *= m          // 再次乘法
ret ^= val        // 累加到结果
ret *= m          // 结果也乘法
```

其中 `m = 0xc6a4a7935bd1e995`（常数乘数），`r = 47`（移位量）。

### AVX-512 与 512 位向量寄存器

AVX-512 引入了 512 位向量寄存器（`__m512i`），可在一个指令中操作 8 个 64 位整数：

| 指令 | 作用 | 对应标量操作 |
| --- | --- | --- |
| `_mm512_loadu_si512` | 加载 512 位数据（8 × uint64） | 8 次 `*data++` |
| `_mm512_mullo_epi64` | 8 路独立 64 位乘法（取低 64 位） | 8 次 `val *= m` |
| `_mm512_srli_epi64` | 8 路独立逻辑右移 | 8 次 `val >> r` |
| `_mm512_xor_si512` | 512 位异或 | 8 次 `val ^= ...` |
| `_mm512_storeu_si512` | 存储 512 位结果 | 8 次 `*hashes++ = ret` |

关键指令 `_mm512_mullo_epi64` 要求 **AVX-512DQ** 指令集（不是 AVX-512F 的子集），这是本 PR 修改 `ob_target_specific.h` 的原因。

### OceanBase 多目标代码框架

OceanBase 使用编译器 `target` 属性实现运行时分发——同一函数的多个版本在编译时生成，运行时根据 CPU 能力选择最优版本：

```cpp title="多目标代码框架（概念）"
// AVX-512 版本：带 target 属性，只在支持 AVX-512 的 CPU 上执行
OB_DECLARE_AVX512_SPECIFIC_CODE(
    void murmurhash64A_batch(...) { /* SIMD 实现 */ }
)

// 标量版本：无 target 属性，任何 CPU 都能执行
OB_DECLARE_DEFAULT_CODE(
    void murmurhash64A_batch(...) { /* 逐个调用标量函数 */ }
)

// 运行时分发
int murmurhash64A_batch(...) {
    if (is_arch_supported(AVX512)) {
        avx512::murmurhash64A_batch(...);    // 走 SIMD 路径
    } else {
        normal::murmurhash64A_batch(...);     // 走标量路径
    }
}
```

## 实现

### 编译目标扩展：添加 AVX-512DQ

`_mm512_mullo_epi64` 属于 AVX-512DQ 指令集，需要在 target 属性中显式声明：

```cpp title="deps/oblib/src/common/ob_target_specific.h"
// 修改前：AVX-512 target 不含 avx512dq
#define OB_AVX512_FUNCTION_SPECIFIC_ATTRIBUTE \
    __attribute__((target("sse,sse2,...,avx512f,avx512bw")))

// 修改后：添加 avx512dq
#define OB_AVX512_FUNCTION_SPECIFIC_ATTRIBUTE \
    __attribute__((target("sse,sse2,...,avx512f,avx512bw,avx512dq")))
```

同样修改了 Clang pragma 形式（`OB_BEGIN_AVX512_SPECIFIC_CODE`），确保两种编译器路径一致。

### 核心实现：批量 murmurhash64A 模板函数

新增模板函数 `murmurhash64A<KEY_LEN, IS_BATCH_SEED>`，一次处理多个定长 key：

```cpp title="deps/oblib/src/lib/hash_func/murmur_hash.h — AVX-512 版本"
template<size_t KEY_LEN, bool IS_BATCH_SEED>
inline void murmurhash64A(const void *keys, uint64_t *hashes,
                          size_t total_len, const uint64_t *seeds)
{
    int32_t key_cnt = total_len / KEY_LEN;
    const uint64_t multiply = 0xc6a4a7935bd1e995;
    const int rotate = 47;
    __m512i multiply512 = _mm512_set1_epi64(multiply);  // 乘数广播到 8 个 lane

    if (KEY_LEN == 8) {
        const uint64_t *data = static_cast<const uint64_t *>(keys);
        // 主循环：每次处理 128 个 key（16 个 __m512i 寄存器）
        for (; key_cnt >= 128; key_cnt -= 128) {
            BIT_OPS(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16);
            hash_idx += 128;
        }
        // 中间循环：每次 64 个 key（8 个寄存器）
        for (; key_cnt >= 64; key_cnt -= 64) {
            BIT_OPS(1,2,3,4,5,6,7,8);
            hash_idx += 64;
        }
        // 尾循环：每次 8 个 key（1 个寄存器）
        for (; key_cnt >= 8; key_cnt -= 8) {
            BIT_OPS(1);
            hash_idx += 8;
        }
    }
    // 剩余 key 用标量逐个处理
    for (; key_cnt > 0; key_cnt--) {
        hashes[hash_idx] = common::murmurhash64A(
            (char *)keys + hash_idx * KEY_LEN, KEY_LEN, SEEDS(hash_idx));
        hash_idx++;
    }
}
```

模板参数：

| 参数 | 含义 | 取值 |
| --- | --- | --- |
| `KEY_LEN` | 单个 key 的字节长度 | 1 / 2 / 4 / 8（对应 int8/int16/int32/int64） |
| `IS_BATCH_SEED` | 是否每个 key 有独立 seed | `true`：每 key 一个 seed；`false`：所有 key 共享一个 seed |

`IS_BATCH_SEED = false` 时省略 seed 数组的逐元素加载，进一步减少内存访问。

### 宏驱动的循环展开

8 字节 key 路径使用宏生成 SIMD 操作序列，根据处理的 key 数量选择不同的展开程度：

```cpp title="deps/oblib/src/lib/hash_func/murmur_hash.h — 宏定义"
// 加载 8 个 uint64 到 __m512i
#define VAL_LOAD(unused, idx) \
    __m512i val##idx = _mm512_loadu_si512(data + hash_idx + (idx-1)*8)

// 8 路并行乘法
#define VAL_MUL(unused, idx) \
    val##idx = _mm512_mullo_epi64(val##idx, multiply512)

// 8 路并行右移异或
#define VAL_SR_XOR(unused, idx) \
    val##idx = _mm512_xor_si512(val##idx, _mm512_srli_epi64(val##idx, rotate))

// 结果初始化：ret = seed ^ (len * m)
#define RET_DEF(unused, idx) \
    __m512i ret##idx { RETX((idx-1)*8), RETX((idx-1)*8+1), ... }

// 完整的 8-key 处理链
#define BIT_OPS(...) \
    LST_DO2(VAL_LOAD, (;), ##__VA_ARGS__);     \  // 1. 加载数据
    LST_DO2(VAL_MUL, (;), ##__VA_ARGS__);      \  // 2. val *= m
    LST_DO2(VAL_SR_XOR, (;), ##__VA_ARGS__);   \  // 3. val ^= val >> r
    LST_DO2(VAL_MUL, (;), ##__VA_ARGS__);      \  // 4. val *= m
    LST_DO2(RET_DEF, (;), ##__VA_ARGS__);      \  // 5. 初始化 ret
    LST_DO2(RET_XOR, (;), ##__VA_ARGS__);      \  // 6. ret ^= val
    LST_DO2(RET_MUL_SIMD, (;), ##__VA_ARGS__); \  // 7. ret *= m
    LST_DO2(RET_SR_XOR, (;), ##__VA_ARGS__);   \  // 8. ret ^= ret >> r
    LST_DO2(RET_MUL_SIMD, (;), ##__VA_ARGS__); \  // 9. ret *= m
    LST_DO2(RET_SR_XOR, (;), ##__VA_ARGS__);   \  // 10. ret ^= ret >> r
    LST_DO2(RET_STORE, (;), ##__VA_ARGS__);       // 11. 存储结果
```

`LST_DO2` 是 OceanBase 的宏元编程工具，将宏应用到可变参数列表的每个元素。例如 `BIT_OPS(1, 2, 3, 4, 5, 6, 7, 8)` 展开后处理 64 个 key（8 个 `__m512i` 寄存器），全部操作通过 SIMD 指令并行执行。

### 短 key 路径：1/2/4 字节

对于 1、2、4 字节的 key，由于单个 key 不足 8 字节，无法直接用 `_mm512_loadu_si512` 加载 8 个 key 的值。代码改为先加载 seed 和初始 ret，再手动组装 key 数据：

```cpp title="deps/oblib/src/lib/hash_func/murmur_hash.h — 4 字节 key 路径"
if (KEY_LEN == 4) {
    for (; key_cnt >= 8; key_cnt -= 8) {
        // 手动加载 8 个 4 字节 key，组装到 ret 的低 32 位
        LST_DO2(RET_LOAD4, (;), 1,2,3,4,5,6,7,8);
        LST_DO2(RET_MUL, (;), 1,2,3,4,5,6,7,8);    // 标量乘法
        RET_CALC_STROE();                             // SIMD 完成后续步骤
        hash_idx += 8;
    }
}
```

`RET_CALC_STROE` 将 8 个标量 ret 组装到一个 `__m512i`，然后用 SIMD 完成剩余的移位、异或、乘法步骤。

### 标量回退版本

非 AVX-512 平台使用简单的逐元素循环：

```cpp title="deps/oblib/src/lib/hash_func/murmur_hash.h — 标量版本"
OB_DECLARE_DEFAULT_CODE(
template<size_t KEY_LEN, bool IS_BATCH_SEED>
inline void murmurhash64A(const void *keys, uint64_t *hashes,
                          size_t total_len, const uint64_t *seeds)
{
    for (int i = 0; i < total_len / KEY_LEN; i++) {
        hashes[i] = common::murmurhash64A(
            (char *)keys + i * KEY_LEN, KEY_LEN, SEEDS(i));
    }
}
)
```

### 运行时分发

```cpp title="deps/oblib/src/lib/hash_func/murmur_hash.h — 分发函数"
template<size_t KEY_LEN, bool IS_BATCH_SEED>
inline int murmurhash64A(const void *keys, uint64_t *hashes,
                         size_t total_len, const uint64_t *seeds)
{
    int ret = OB_SUCCESS;
    if (KEY_LEN > 0 && total_len % KEY_LEN != 0) {
        ret = OB_ERROR;                              // 长度校验
        return ret;
    }
#if OB_USE_MULTITARGET_CODE
    if (common::is_arch_supported(ObTargetArch::AVX512)) {
        common::specific::avx512::murmurhash64A<KEY_LEN, IS_BATCH_SEED>(
            keys, hashes, total_len, seeds);          // SIMD 路径
    } else {
        common::specific::normal::murmurhash64A<KEY_LEN, IS_BATCH_SEED>(
            keys, hashes, total_len, seeds);          // 标量路径
    }
#else
    common::specific::normal::murmurhash64A<KEY_LEN, IS_BATCH_SEED>(
        keys, hashes, total_len, seeds);
#endif
    return ret;
}
```

### 集成到向量化执行引擎

`ObFixedLengthVector::murmur_hash_v3` 是定长向量的批量哈希入口。修改后，在无 NULL 且所有行活跃时走 SIMD 批量路径：

```cpp title="src/share/vector/ob_fixed_length_vector.cpp"
template<typename ValueType, typename BasicOp>
int ObFixedLengthVector<ValueType, BasicOp>::murmur_hash_v3(
        BATCH_EVAL_HASH_ARGS) const
{
    if (!this->has_null() && bound.get_all_rows_active()) {
        // 快速路径：无 NULL，无 skip，直接批量 SIMD 哈希
        const void *keys = this->get_data() + bound.start() * sizeof(ValueType);
        uint64_t *hashes = hash_values + bound.start();
        size_t total_len = bound.range_size() * sizeof(ValueType);
        const uint64_t *target_seeds = seeds + bound.start();
        if (is_batch_seed) {
            return murmurhash64A<sizeof(ValueType), true>(
                keys, hashes, total_len, target_seeds);
        }
        return murmurhash64A<sizeof(ValueType), false>(
            keys, hashes, total_len, target_seeds);
    }
    // 慢速路径：有 NULL 或 skip，逐行哈希
    BatchHashResIter hash_iter(hash_values);
    return VecOpUtil::template hash_dispatch<ObMurmurHash, true, BatchHashResIter>(
        hash_iter, expr.obj_meta_, *this, skip, bound, seeds, is_batch_seed);
}
```

快速路径的触发条件：

| 条件 | 原因 |
| --- | --- |
| `!has_null()` | NULL 行需要跳过，无法批量处理 |
| `get_all_rows_active()` | 有 skip bitmap 时需要逐行检查，无法批量 |

满足两个条件时，整段连续内存可以安全地用 SIMD 批量处理，否则回退到逐行 `hash_dispatch`。

## 测试

### 正确性测试

新增 `test_murmur_hash.cpp`（+96 行），对 8 种 key 长度 × 多种数量组合验证 SIMD 与标量结果一致：

```cpp title="unittest/sql/common/test_murmur_hash.cpp"
TEST(TestMurmurHash, ALL) {
    TestMurmurHash test;
    test.check_hashes<1, 512>();     // int8
    test.check_hashes<2, 512>();     // int16
    test.check_hashes<4, 512>();     // int32 (ClientIP)
    test.check_hashes<8, 512>();     // int64
    test.check_hashes<10, 512>();    // 非标准长度
    test.check_hashes<16, 512>();
    test.check_hashes<32, 512>();
    test.check_hashes<64, 512>();
}
```

测试逻辑：生成 512 个随机 key 和随机 seed，分别用 SIMD 批量函数和标量逐个函数计算哈希，逐元素比较结果是否一致。对每种 key 长度，从 1 个 key 到 512 个 key 逐步增加，覆盖主循环、中间循环、尾循环和标量回退所有路径。

同时验证了 `IS_BATCH_SEED = true`（每 key 独立 seed）和 `false`（共享 seed）两种模式。

## 问题

### 为什么需要 AVX-512DQ？

`_mm512_mullo_epi64`（8 路 64 位乘法取低位）属于 AVX-512DQ 指令集，不是 AVX-512F 的子集。AVX-512F 只提供 `_mm512_mul_epu32`（32×32→64 乘法），无法直接做 64×64→64 乘法。MurmurHash 的核心操作是 64 位乘法（`val *= 0xc6a4a7935bd1e995`），必须使用 DQ 扩展。

### 为什么 8 字节 key 能一次处理 128 个？

128 个 uint64 = 1024 字节 = 16 个 `__m512i` 寄存器。AVX-512 有 32 个 512 位寄存器（zmm0~zmm31），16 个存数据 + 16 个存中间结果，刚好在寄存器预算内。循环展开 16 次可以最大化指令级并行（ILP），让 CPU 乱序执行引擎充分利用多个执行端口。

### 短 key（1/2/4 字节）为什么不能像 8 字节那样完全向量化？

8 字节 key 可以直接用 `_mm512_loadu_si512` 一次加载 8 个 key 的原始数据到 `__m512i`。但 1/2/4 字节 key 不足 8 字节，加载后的数据需要对齐和移位才能放到 `__m512i` 的正确 lane。代码选择先用标量组装 `ret` 的初始值（含 key 数据），再将 8 个 `ret` 打包到 `__m512i` 做后续的 SIMD 运算。这是一种"半向量化"策略——加载用标量，运算用 SIMD。

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| Hash Group By（无 NULL） | 逐 key 标量哈希 | 8~128 key 并行 SIMD 哈希 |
| Hash Join（无 NULL） | 逐 key 标量哈希 | 同上 |
| 有 NULL 或 skip 的哈希 | 逐 key 标量哈希 | 不变（回退到标量路径） |
| 非 AVX-512 CPU | 逐 key 标量哈希 | 不变（运行时分发到标量路径） |

**面向 ClickBench Q36**：该查询对 `ClientIP`（int32）做 4 路 Group By，每路扫描约 1 亿行。SIMD 路径一次处理 8 个 int32 的哈希计算，理论吞吐提升约 8 倍（实际受内存带宽和 Group By 聚合开销限制，提升幅度小于 8 倍）。

**设计上的折中**：

- 仅支持定长 key（1/2/4/8 字节），变长 key 仍走标量路径
- 仅在无 NULL 且全行活跃时触发快速路径，有 NULL 时回退
- 8 字节 key 的 SIMD 路径最充分（一次 128 key），短 key 路径受限（一次 8 key）
- 使用宏元编程展开循环，代码可读性较差但避免了手写大量重复的 SIMD 指令序列

> **后续**：本文与 [用 SIMD 优化 LIKE 模式匹配](/vibe-reading/articles/oceanbase-pr-2016-simd-like-optimization) 是同一作者面向 ClickBench 场景的 SIMD 加速系列，分别针对 Hash Group By 和 LIKE 模式匹配两条路径。
