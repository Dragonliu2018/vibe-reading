---
title: "用 SIMD 优化 LIKE 模式匹配"
source:
  project: "OceanBase"
  type: "PR"
  id: "2016"
  url: "https://github.com/oceanbase/oceanbase/pull/2016"
  prType: "perf"
date: "2026-08-05T16:30:00+08:00"
category: [Database, OceanBase, Contributions]
tags: ["OceanBase", "SIMD", "SSE", "LIKE", "C++", "ClickBench"]
description: "参考 Doris/StarRocks/ClickHouse 的思路，用 SSE4.1 指令优化 utf8mb4_bin collation 下的 LIKE 模式匹配，将特定 pattern 转为 substring/start_with/end_with/equal 的 SIMD 实现。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#2016](https://github.com/oceanbase/oceanbase/pull/2016) · **Issue** [#2015](https://github.com/oceanbase/oceanbase/issues/2015) · **commit** [b6fd7b3](https://github.com/oceanbase/oceanbase/commit/b6fd7b3) · **首发版本** - · **变更行数** +337 行 · **合并时间** -（未合并）

> ⚠️ 本 PR 尚未合并，处于开发中状态。commit hash 取自 PR 当前 HEAD。

> 📎 本文与 [用 AVX-512 向量化加速 MurmurHash 批量哈希计算](/vibe-reading/articles/oceanbase-pr-1941-murmurhash-simd) 是同一思路的两条落地线，均面向 ClickBench 场景的 SIMD 加速，建议对照阅读。

---

## 背景

ClickBench 是衡量分析型数据库查询性能的标准基准之一。Issue [#2015](https://github.com/oceanbase/oceanbase/issues/2015) 指出，ClickBench 中有四个查询的性能受制于 `LIKE` 模式匹配：

```sql title="ClickBench 中受 LIKE 影响的查询"
-- Q21: 子串匹配
SELECT COUNT(*) FROM hits WHERE URL LIKE '%google%';
-- Q22: 子串匹配 + 聚合
SELECT SearchPhrase, MIN(URL), COUNT(*) AS c
  FROM hits WHERE URL LIKE '%google%' AND SearchPhrase <> ''
  GROUP BY SearchPhrase ORDER BY c DESC LIMIT 10;
-- Q23: 多个 LIKE + NOT LIKE
SELECT SearchPhrase, MIN(URL), MIN(Title), COUNT(*) AS c, COUNT(DISTINCT UserID)
  FROM hits WHERE Title LIKE '%Google%' AND URL NOT LIKE '%.google.%' AND SearchPhrase <> ''
  GROUP BY SearchPhrase ORDER BY c DESC LIMIT 10;
-- Q24: 子串匹配 + 排序
SELECT * FROM hits WHERE URL LIKE '%google%' ORDER BY EventTime LIMIT 10;
```

这些查询的 `LIKE` pattern 都是 `%xxx%` 形式——即子串匹配。OceanBase 原有的 `LIKE` 实现对每一行文本逐字节比较，无法利用 SIMD 指令的并行能力，在大数据量下成为瓶颈。

Doris、StarRocks、ClickHouse 等数据库已在 `LIKE` 实现中引入了 SIMD 优化。本 PR 将这一思路移植到 OceanBase。

---

## 前置知识

### LIKE 的 instr 模式分解

OceanBase 的 `ObExprLike` 在处理 `LIKE` 时，会先将 pattern 按 `%` 分解为多个子串（instr）。例如 `%abc%ef` 分解为 `abc` 和 `ef` 两个 instr，记录在 `InstrInfo` 中：

| 字段 | 含义 |
| --- | --- |
| `instr_cnt_` | 分解出的 instr 数量 |
| `instr_starts_[]` | 每个 instr 的起始指针 |
| `instr_lengths_[]` | 每个 instr 的长度 |
| `instr_mode_` | `%` 的位置模式（开头/结尾/两端/中间） |

`instr_mode_` 有四种枚举值，描述 `%` 在 pattern 中的位置：

| 模式 | pattern 示例 | 语义 |
| --- | --- | --- |
| `START_WITH_PERCENT_SIGN` | `%abc` | 文本以 `abc` 结尾 |
| `END_WITH_PERCENT_SIGN` | `abc%` | 文本以 `abc` 开头 |
| `START_END_WITH_PERCENT_SIGN` | `%abc%` | 文本包含 `abc` |
| `MIDDLE_PERCENT_SIGN` | `abc%ef` | 文本以 `abc` 开头且以 `ef` 结尾 |

### SIMD 与 SSE4.1

SSE4.1 提供了 128 位（16 字节）的 SIMD 指令，可一次处理 16 个字符：

| 指令 | 作用 |
| --- | --- |
| `_mm_loadu_si128` | 加载 16 字节到 `__m128i` |
| `_mm_set1_epi8` | 将一个字节广播填充整个 `__m128i` |
| `_mm_cmpeq_epi8` | 逐字节比较，匹配位置置 1 |
| `_mm_movemask_epi8` | 将每字节的最高位提取为 16 位掩码 |
| `_mm_and_si128` | 两个 `__m128i` 按位与 |

`__builtin_ctz(mask)` 返回掩码中最低位 1 的位置（即第一个匹配的字节偏移）。

### 跨页安全读取

SIMD 一次读取 16 字节，如果读取位置靠近内存页边界，可能跨越未映射的页导致段错误。`page_safe` 检查当前指针到页尾是否有至少 16 字节的空间：

```cpp
bool page_safe(const void *const ptr) const {
    return ((page_size_ - 1) & reinterpret_cast<std::uintptr_t>(ptr))
           <= page_size_ - m128_size_;
}
```

不安全时回退到逐字节比较。

---

## 设计参考

PR body 明确说明参考了 Doris、StarRocks、ClickHouse 的优化思路。Doris 的 `be/src/exec/common/string_searcher.h` 中有完整的 `StringSearcher` 实现，本 PR 的类结构与之高度一致：

| 设计要素 | Doris | 本 PR |
| --- | --- | --- |
| `page_safe` 跨页检查 | `StringSearcherBase` | `StringSearcher::page_safe` |
| 首字节快速过滤 | `first_pattern_` | `first_pattern_` |
| 前两字节联合过滤 | `second_pattern_` | `second_pattern_` |
| 前 16 字节缓存匹配 | `cache_` + `cache_mask_` | `cache_` + `cache_mask_` |
| 模板特化 | `StringSearcher<true, ASCII>` | 四个方法：`is_substring`/`start_with`/`end_with`/`equal` |

核心思路一致：用首字节（和前两字节）快速定位候选匹配位置，再用缓存的前 16 字节批量验证，最后逐字节确认剩余部分。

---

## 实现

### 优化触发条件

优化仅在 `instr_cnt_ == 1`（pattern 分解后只有一个 instr）时触发。此时根据 `%` 的位置，可以确定性地转换为四种操作之一：

```cpp title="src/sql/engine/expr/ob_expr_like.cpp — set_instr_info"
// optimize for special patterns
if (instr_info.instr_cnt_ == 1) {
    like_ctx.string_searcher_.init(instr_info.instr_starts_[0], instr_info.instr_lengths_[0]);
}
```

```cpp title="src/sql/engine/expr/ob_expr_like.cpp — match_with_instr_mode"
// optimize to calc substring, start_with, end_with or equal.
if (idx_end == 1) {
    if (percent_sign_start && percent_sign_end) {
        return string_searcher.is_substring(text_ptr, text_ptr + text_len);     // %abc%
    }
    if (!percent_sign_start && percent_sign_end) {
        return string_searcher.start_with(text_ptr, text_ptr + text_len);       // abc%
    }
    if (percent_sign_start && !percent_sign_end) {
        return string_searcher.end_with(text_ptr, text_ptr + text_len);         // %abc
    }
    if (!percent_sign_start && !percent_sign_end) {
        return string_searcher.equal(text_ptr, text_ptr + text_len);            // abc
    }
}
```

| pattern | `%` 位置 | 转换为 | SIMD 方法 |
| --- | --- | --- | --- |
| `%abc%` | 两端 | 子串搜索 | `is_substring` |
| `abc%` | 仅尾端 | 前缀匹配 | `start_with` |
| `%abc` | 仅首端 | 后缀匹配 | `end_with` |
| `abc` | 无 | 精确匹配 | `equal` |

### StringSearcher 类

新增的 `StringSearcher` 是 `ObExprLike` 的内部类，在 `init` 阶段预计算 SIMD 所需的向量和掩码：

```cpp title="src/sql/engine/expr/ob_expr_like.h — StringSearcher::init"
__attribute__((target("sse4.1")))
inline void init(const char *pattern, size_t len) {
    pattern_ = pattern;
    pattern_end_ = pattern_ + len;
    pattern_len_ = len;
    first_ = *pattern;

#if defined(__x86_64__)
    // 首字节广播为 16 字节向量
    first_pattern_ = _mm_set1_epi8(first_);
    if (pattern_ + 1 < pattern_end_) {
        second_ = *(pattern_ + 1);
        second_pattern_ = _mm_set1_epi8(second_);
    }
    // 前 16 字节存入 cache_ 向量，cache_mask_ 标记有效字节位
    const char *pattern_pos = pattern_;
    for (size_t i = 0; i < m128_size_; i++) {
        cache_ = _mm_srli_si128(cache_, 1);
        if (pattern_pos != pattern_end_) {
            cache_ = _mm_insert_epi8(cache_, *pattern_pos, m128_size_ - 1);
            cache_mask_ |= 1 << i;
            ++pattern_pos;
        }
    }
#endif
}
```

预计算三个向量：

| 向量 | 内容 | 用途 |
| --- | --- | --- |
| `first_pattern_` | 首字节广播 | 快速定位候选位置 |
| `second_pattern_` | 第二字节广播 | 联合过滤，减少误匹配 |
| `cache_` + `cache_mask_` | pattern 前 16 字节 | 批量验证候选位置 |

### is_substring：子串搜索（核心）

`%abc%` 是 ClickBench 中最常见的 pattern。搜索分三级加速：

```cpp title="src/sql/engine/expr/ob_expr_like.h — is_substring"
inline bool is_substring(const char *text, const char *text_end) const {
    // 快速路径：pattern 长度为 1，只需搜索单字节
    if (pattern_len_ == 1) {
        while (text < text_end) {
            if (text + m128_size_ <= text_end && page_safe(text)) {
                __m128i v_text = _mm_loadu_si128(reinterpret_cast<const __m128i *>(text));
                __m128i v_against_pattern = _mm_cmpeq_epi8(v_text, first_pattern_);
                int mask = _mm_movemask_epi8(v_against_pattern);
                if (mask == 0) {
                    text += m128_size_;          // 16 字节无匹配，跳过
                    continue;
                }
                int offset = __builtin_ctz(mask); // 找到第一个匹配位置
                text += offset;
                return true;
            }
            // 跨页不安全时回退逐字节
            if (*text == first_) { return true; }
            ++text;
        }
        return false;
    }
    // 通用路径：pattern 长度 > 1
    while (text < text_end && text_end - text >= pattern_len_) {
        // 第一级：用前两字节联合过滤定位候选
        __m128i first_block = _mm_loadu_si128(reinterpret_cast<const __m128i *>(text));
        __m128i second_block = _mm_loadu_si128(reinterpret_cast<const __m128i *>(text + 1));
        __m128i first_cmp = _mm_cmpeq_epi8(first_block, first_pattern_);
        __m128i second_cmp = _mm_cmpeq_epi8(second_block, second_pattern_);
        int mask = _mm_movemask_epi8(_mm_and_si128(first_cmp, second_cmp));
        if (mask == 0) {
            text += m128_size_;                  // 16 字节无候选，跳过
            continue;
        }
        int offset = __builtin_ctz(mask);        // 第一个候选位置
        text += offset;
        // 第二级：用 cache_ 批量验证前 16 字节
        __m128i v_text_offset = _mm_loadu_si128(reinterpret_cast<const __m128i *>(text));
        __m128i v_against_cache = _mm_cmpeq_epi8(v_text_offset, cache_);
        int mask_offset = _mm_movemask_epi8(v_against_cache);
        if ((mask_offset & cache_mask_) == cache_mask_) {
            // 第三级：逐字节确认剩余部分
            // ...
            return true;
        }
        ++text;
    }
    return false;
}
```

三级加速策略：

| 级别 | 操作 | 一次处理 | 目的 |
| --- | --- | --- | --- |
| 第一级 | 前两字节联合过滤 | 16 字节 | 快速排除不可能的位置 |
| 第二级 | 前 16 字节缓存匹配 | 16 字节 | 确认候选位置的前缀匹配 |
| 第三级 | 逐字节比较剩余 | 逐字节 | 确认完整匹配 |

### start_with / end_with / equal：SIMD 内存比较

这三种操作本质是固定长度的内存比较，用 `memequal_opt` 实现：

```cpp title="src/sql/engine/expr/ob_expr_like.h — memequal_opt"
inline bool memequal_opt(const char *s1, const char *s2, size_t n) const {
    switch (n) {
        case 1: return *s1 == *s2;
        case 2: return unaligned_load<uint16_t>(s1) == unaligned_load<uint16_t>(s2);
        case 4: return unaligned_load<uint32_t>(s1) == unaligned_load<uint32_t>(s2);
        case 8: return unaligned_load<uint64_t>(s1) == unaligned_load<uint64_t>(s2);
        // ... 其他短长度特化
    }
    if (n <= 16) {
        // 首尾各比较 8 字节
        return unaligned_load<uint64_t>(s1) == unaligned_load<uint64_t>(s2)
            && unaligned_load<uint64_t>(s1 + n - 8) == unaligned_load<uint64_t>(s2 + n - 8);
    }
#if defined(__x86_64__)
    // 长文本：每次 64 字节（4 个 __m128i）
    while (n >= 64) {
        if (memequal_sse<4>(s1, s2)) { s1 += 64; s2 += 64; n -= 64; }
        else { return false; }
    }
    // 尾部 16/32/48 字节
    // ...
#endif
}
```

`memequal_sse<4>` 一次比较 4 个 `__m128i`（64 字节），用 `_mm_and_si128` 合并四组比较结果：

```cpp title="src/sql/engine/expr/ob_expr_like.h — memequal_sse<4>"
template <int cnt>
inline bool memequal_sse(const char *p1, const char *p2) const {
    if (cnt == 4) {
        return 0xFFFF == _mm_movemask_epi8(
            _mm_and_si128(
                _mm_and_si128(
                    _mm_cmpeq_epi8(_mm_loadu_si128(...p1), _mm_loadu_si128(...p2)),
                    _mm_cmpeq_epi8(_mm_loadu_si128(...p1 + 1), _mm_loadu_si128(...p2 + 1))),
                _mm_and_si128(
                    _mm_cmpeq_epi8(_mm_loadu_si128(...p1 + 2), _mm_loadu_si128(...p2 + 2)),
                    _mm_cmpeq_epi8(_mm_loadu_si128(...p1 + 3), _mm_loadu_si128(...p2 + 3)))));
    }
}
```

### 向量化集成

`StringSearcher` 实例存储在 `ObExprLikeContext` 中，随 `InstrInfo` 一起在批处理和向量化路径中传递。调用链为：`like_text_vectorized_inner` / `like_text_vectorized_inner_vec2` → `calc_with_instr_mode` → `match_text_batch` / `match_text_vector`（通过 `BATCH_EVAL_FUNC_ARG_DECL` / `VECTOR_EVAL_FUNC_ARG_DECL` 宏传递参数）→ `match_with_instr_mode`。每一层都新增 `string_searcher` 参数：

```cpp title="src/sql/engine/expr/ob_expr_like.h — ObExprLikeContext"
class ObExprLikeContext : public ObExprOperatorCtx {
    // ...
    StringSearcher string_searcher_;   // 新增
};
```

`match_text_batch` 和 `match_text_vector` 的函数签名增加 `string_searcher` 参数，在批处理循环中每行都调用 SIMD 优化路径：

```cpp title="src/sql/engine/expr/ob_expr_like.cpp — match_text_batch"
template <bool NullCheck, bool UseInstrMode, INSTR_MODE InstrMode>
int ObExprLike::match_text_batch(BATCH_EVAL_FUNC_ARG_DECL,
                                 const ObCollationType coll_type,
                                 const int32_t escape_wc,
                                 const ObString &pattern_val,
                                 const InstrInfo instr_info,
                                 const StringSearcher &string_searcher) {  // 新增参数
    // ...
    int64_t res = ALL_PERCENT_SIGN == InstrMode ? 1
            : match_with_instr_mode<PERCENT_SIGN_START(InstrMode), PERCENT_SIGN_END(InstrMode)>
            (text_datums[i].get_string(), instr_info, string_searcher);  // 传递 searcher
}
```

### 限制条件

优化仅在以下条件全部满足时触发：

* **`CS_TYPE_UTF8MB4_BIN` collation**：二进制比较，字节级匹配，SIMD 直接适用。其他 collation（如大小写不敏感）需要字符级转换，无法直接用 SIMD
* **`instr_cnt_ == 1`**：pattern 按 `%` 分解后只有一个子串。多子串（如 `%abc%ef`）仍走原有路径
* **`__x86_64__` 架构**：非 x86-64 平台回退到 `memcmp` / 逐字节比较

---

## 测试

### 性能测试

PR body 报告了 ClickBench 性能结果：

| 查询 | pattern | 提升幅度 |
| --- | --- | --- |
| Q21 | `URL LIKE '%google%'` | **+53%** |
| Q24 | `URL LIKE '%google%'` + ORDER BY | **+32%** |
| Q22 | `URL LIKE '%google%'` + 聚合 | 几乎不变 |
| Q23 | 多个 LIKE + NOT LIKE | 几乎不变 |

Q21 提升最大（53%），因为它是纯 `LIKE` 过滤，优化收益直接。Q24 有 `ORDER BY LIMIT`，LIKE 优化仍占主导（+32%）。Q22/Q23 包含聚合和 `COUNT(DISTINCT)`，LIKE 不再是瓶颈，提升不明显。

---

## 问题

### 为什么仅优化 instr_cnt_ == 1

多 instr 的 pattern（如 `%abc%ef`）需要同时满足多个子串条件——先找 `abc`，再在后续位置找 `ef`。这种组合搜索的 SIMD 优化更复杂，需要处理子串间的相对位置约束。本 PR 先覆盖最常见的单子串场景（`%abc%`、`abc%`、`%abc`），多子串留待后续。

### second_pattern_ 的作用

仅用首字节过滤，误匹配率高（如 pattern `abc` 在文本 `aXXaXX...` 中每 3 字节就有一个首字节匹配）。加入第二字节联合过滤——只有前两字节都匹配的位置才进入缓存验证阶段，大幅减少候选数量。这是 Doris/ClickHouse 同类实现的标配技巧。

### cache_mask_ 的含义

pattern 可能短于 16 字节（如 `abc` 只有 3 字节）。`cache_` 向量中只有前 3 字节是有效 pattern 内容，其余为 0。`cache_mask_` 用位掩码标记有效字节（`0b111 = 7`），验证时只检查有效位：`(mask_offset & cache_mask_) == cache_mask_`。

---

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| `URL LIKE '%google%'`（utf8mb4_bin） | 逐字节子串搜索 | SSE4.1 三级加速 |
| `name LIKE 'abc%'`（前缀匹配） | 逐字节比较 | `memequal_opt` SIMD 比较 |
| `name LIKE '%abc'`（后缀匹配） | 逐字节比较 | `memequal_opt` SIMD 比较 |
| `name LIKE 'abc'`（精确匹配） | 逐字节比较 | `memequal_opt` SIMD 比较 |
| 非 utf8mb4_bin collation | 逐字节 | 逐字节（不优化） |
| 多 `%` 的 pattern | 逐字节 | 逐字节（不优化） |

* **性能收益**：ClickBench Q21 提升 53%，验证了 SIMD 在 LIKE 子串搜索中的价值。对于以 URL/文本过滤为主的查询场景，这是显著的性能改进。
* **设计思路验证**：本 PR 验证了 Doris/ClickHouse 的 StringSearcher 设计在 OceanBase 中的可行性，为后续的通用化重构（`ObStringSearcher` + AVX2）铺平了道路。
* **渐进式优化**：先覆盖单子串场景（`instr_cnt_ == 1`），抓住最大的性能瓶颈，多子串和大小写不敏感场景留待后续。这是一种务实的优化策略——先拿 80% 的收益，再逐步扩展覆盖范围。


## 附录：重构后 ObStringSearcher 核心实现

将 `StringSearcher` 从 `ObExprLike` 内部类提取为 `common::specific::avx2::ObStringSearcher` 独立组件，并从 SSE4.1 升级到 AVX2。重构并非简单搬家，核心算法在每个环节都有实质改进：

| 维度 | 本 PR (SSE4.1) | 重构后 (AVX2) |
| --- | --- | --- |
| SIMD 宽度 | `__m128i`（16 字节） | `__m256i`（32 字节），吞吐翻倍 |
| 快速过滤 | 首字节 + **第二字节**联合（固定偏移 +1） | 首字节 + **末字节**联合（偏移 `pattern_len_-1`，候选更分散） |
| 批量验证 | `cache_` 向量 + `cache_mask_` 匹配前 16 字节 | 去掉缓存，直接 `memequal_opt` 比较中间字节 |
| 候选遍历 | 找到第一个候选即跳到下一轮 | `mask &= (mask - 1)` 遍历同窗口所有候选 |
| 跨页安全 | `page_safe` 检查 + 逐字节回退 | 对齐循环 + `MEMMEM` 处理尾部，无需 page_safe |
| 返回值 | `bool` | `int`（错误码）+ `bool& res`（OB 风格） |
| 复用性 | `ObExprLike` 内部类 | `common` 命名空间独立类，`ob_expr_replace` 等也复用 |

以下逐段解读重构后的核心实现。

### 类结构：首末字节向量替代四向量缓存

重构后的类声明精简了预计算字段——从原版的 `first_pattern_` + `second_pattern_` + `cache_` + `cache_mask_` 四个向量，缩减为 `vfirst_` + `vlast_` 两个 AVX2 向量：

```cpp title="src/sql/engine/expr/ob_expr_string_searcher.h — 类声明"
class ObStringSearcher {
private:
  static constexpr int AVX2_SIZE = sizeof(__m256i);   // 32 字节

public:
  int init(const char *pattern, size_t len);
  int instr(const char *text, const char *text_end, int64_t &res, bool &find) const;
  int is_substring(const char *text, const char *text_end, bool &res) const;
  int start_with(const char *text, const char *text_end, bool &res) const;
  int end_with(const char *text, const char *text_end, bool &res) const;
  int equal(const char *text, const char *text_end, bool &res) const;
  bool memequal_opt(const char *s1, const char *s2, size_t n) const;

private:
  template <typename T> bool memequal_plain(const char *p1, const char *p2) const;
  template <int cnt> bool memequal_sse(const char *p1, const char *p2) const;

  const char *pattern_;
  const char *pattern_end_;
  size_t pattern_len_;
  uint8_t first_;        // pattern 首字节
  uint8_t last_;         // pattern 末字节
  __m256i vfirst_;       // 首字节广播为 32 字节向量
  __m256i vlast_;        // 末字节广播为 32 字节向量
};
```

去掉 `cache_`/`cache_mask_` 的原因：原版用它批量验证候选位置的前 16 字节，但重构版改为直接用 `memequal_opt` 比较中间字节（首末字节已匹配，只需比 `pattern_len_ - 2` 字节），不再需要缓存向量。新增 `instr` 方法返回匹配位置（`is_substring` 只返回是否匹配），供 `REPLACE` 等需要位置信息的场景使用。

### init：预计算首末字节向量

`init` 的职责变为只预计算两个 AVX2 向量——首字节和末字节各广播为 32 字节：

```cpp title="src/sql/engine/expr/ob_expr_string_searcher.cpp — init"
int ObStringSearcher::init(const char *pattern, size_t len) {
  int ret = OB_SUCCESS;
  if (nullptr == pattern || 0 == len) {
    ret = OB_INVALID_ARGUMENT;
  } else {
    pattern_ = pattern;
    pattern_end_ = pattern_ + len;
    pattern_len_ = len;

    first_ = *pattern;
    vfirst_ = _mm256_set1_epi8(first_);       // 首字节广播为 32 字节向量
    if (2 <= pattern_len_) {
      last_ = *(pattern_end_ - 1);
      vlast_ = _mm256_set1_epi8(last_);       // 末字节广播为 32 字节向量
    }
  }
  return ret;
}
```

为何选末字节而非第二字节？第二字节固定在偏移 +1 处，而末字节在偏移 `pattern_len_ - 1` 处——不同 pattern 长度的末字节位置天然不同，候选位置更分散，联合过滤的误匹配率更低。例如 pattern 长度为 3 时，首末字节相距 2；长度为 10 时相距 9，过滤特性完全不同。

### is_substring：AVX2 首末字节联合过滤

子串搜索是核心方法，分两条路径——单字节快速路径和多字节通用路径：

```cpp title="src/sql/engine/expr/ob_expr_string_searcher.cpp — is_substring"
int ObStringSearcher::is_substring(const char *text, const char *text_end, bool &res) const {
  int ret = OB_SUCCESS;
  res = false;
  const char *text_cur = text;

  if (nullptr == pattern_ || 0 == pattern_len_) {
    ret = OB_INVALID_ARGUMENT;
  } else if (text == text_end) {
    // text 为空
  } else if (1 == pattern_len_) {
    // 快速路径：pattern 长度为 1，只需搜索单字节
    // 按 AVX2_SIZE 对齐循环，每次比较 32 字节
    const char *avx_end = text + ((text_end - text) & ~(AVX2_SIZE - 1));
    for (; text_cur < avx_end; text_cur += AVX2_SIZE) {
      __m256i first_block = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(text_cur));
      __m256i first_cmp = _mm256_cmpeq_epi8(first_block, vfirst_);
      uint32_t mask = _mm256_movemask_epi8(first_cmp);
      if (0 != mask) { res = true; break; }
    }
  } else {
    // 通用路径：pattern 长度 > 1
    // 首末字节联合过滤：同时检查 text[i] == first_ && text[i + pattern_len_ - 1] == last_
    const char *avx_end =
        text + ((text_end - (text + pattern_len_ - 1)) & ~(AVX2_SIZE - 1));
    for (; !res && text_cur < avx_end; text_cur += AVX2_SIZE) {
      const char *last_cur = text_cur + pattern_len_ - 1;
      __m256i first_block = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(text_cur));
      __m256i last_block = _mm256_loadu_si256(reinterpret_cast<const __m256i *>(last_cur));
      __m256i first_cmp = _mm256_cmpeq_epi8(first_block, vfirst_);
      __m256i last_cmp = _mm256_cmpeq_epi8(last_block, vlast_);
      uint32_t mask = _mm256_movemask_epi8(_mm256_and_si256(first_cmp, last_cmp));
      // 遍历所有首末字节都匹配的候选位置
      while (mask != 0) {
        int offset = __builtin_ctz(mask);
        // 首末字节已匹配，只需比较中间字节
        if (2 == pattern_len_ ||
            memequal_opt(text_cur + offset + 1, pattern_ + 1, pattern_len_ - 2)) {
          res = true; break;
        }
        mask &= (mask - 1);   // 清除最低位，检查下一个候选
      }
    }
  }
  // 尾部不足 AVX2_SIZE 的部分用 MEMMEM 处理
  if (!res && text_end - text_cur >= pattern_len_) {
    res = NULL != MEMMEM(text_cur, text_end - text_cur, pattern_, pattern_len_);
  }
  return ret;
}
```

通用路径的关键逻辑：

1. **对齐循环**：`avx_end` 按 `AVX2_SIZE`（32 字节）对齐，循环体内每次加载 32 字节。注意 `avx_end` 的计算减去了 `pattern_len_ - 1`，因为末字节读取位置 `last_cur = text_cur + pattern_len_ - 1` 不能超过 `text_end`。
2. **首末字节联合过滤**：同时加载 `text_cur` 和 `text_cur + pattern_len_ - 1` 处的 32 字节，分别与 `vfirst_` 和 `vlast_` 比较，用 `_mm256_and_si256` 合并——只有首末字节都匹配的位置对应的 mask 位才为 1。
3. **候选遍历**：`while (mask != 0)` 循环用 `__builtin_ctz` 取最低位 1 的偏移，验证中间字节后，`mask &= (mask - 1)` 清除该位继续检查下一个候选。这比原版的"找到第一个候选就跳到下一轮"更彻底——同一 32 字节窗口内的多个候选都会验证。
4. **尾部处理**：循环结束后不足 32 字节的尾部，直接用 `MEMMEM`（glibc 的 memmem）一次性处理，替代了原版的逐字节回退。

### start_with / end_with / equal：定长比较

这三个方法的逻辑简单——检查长度后调用 `memequal_opt` 做定长内存比较：

```cpp title="src/sql/engine/expr/ob_expr_string_searcher.cpp — start_with / end_with / equal"
int ObStringSearcher::start_with(const char *text, const char *text_end, bool &res) const {
  // pattern_len_ > text 长度 → false；否则比较 text 前 pattern_len_ 字节
  if (pattern_len_ > text_end - text) { res = false; }
  else { res = memequal_opt(text, pattern_, pattern_len_); }
}

int ObStringSearcher::end_with(const char *text, const char *text_end, bool &res) const {
  // 比较 text 末尾 pattern_len_ 字节
  if (pattern_len_ > text_end - text) { res = false; }
  else { res = memequal_opt(text_end - pattern_len_, pattern_, pattern_len_); }
}

int ObStringSearcher::equal(const char *text, const char *text_end, bool &res) const {
  // 长度必须完全相等
  if (pattern_len_ != text_end - text) { res = false; }
  else { res = memequal_opt(text, pattern_, pattern_len_); }
}
```

与原版逻辑一致，差异仅在返回值风格（`int` 错误码 + `bool& res` 替代直接 `return bool`），符合 OceanBase 的错误处理约定。

### memequal_opt：按长度分级的 SIMD 内存比较

`memequal_opt` 是 `start_with`/`end_with`/`equal` 以及 `is_substring` 中间字节验证的共用基础。按比较长度分级特化：

```cpp title="src/sql/engine/expr/ob_expr_string_searcher.cpp — memequal_opt + memequal_sse"
bool ObStringSearcher::memequal_opt(const char *s1, const char *s2, size_t n) const {
  // 短长度特化：用 int8_t/int16_t/int32_t/int64_t 直接比较
  switch (n) {
    case 1:  return *s1 == *s2;
    case 2:  return memequal_plain<int16_t>(s1, s2);
    case 4:  return memequal_plain<int32_t>(s1, s2);
    case 8:  return memequal_plain<int64_t>(s1, s2);
    // 3/5/6/7 拆分为 int32 + int16/int8 组合
    default: break;
  }
  if (n <= 16) {
    // 首尾各比较 8 字节（覆盖重叠区域）
    return memequal_plain<int64_t>(s1, s2) &&
           memequal_plain<int64_t>(s1 + n - 8, s2 + n - 8);
  }
  // 长文本：每次 64 字节（4 个 __m128i）
  while (n >= 64) {
    if (memequal_sse<4>(s1, s2)) { s1 += 64; s2 += 64; n -= 64; }
    else { return false; }
  }
  // 尾部 16/32/48 字节（fall-through）
  switch (n / 16) {
    case 3: if (!memequal_sse<1>(s1 + 32, s2 + 32)) return false;  // fall through
    case 2: if (!memequal_sse<1>(s1 + 16, s2 + 16)) return false;  // fall through
    case 1: if (!memequal_sse<1>(s1, s2)) return false;
  }
  return memequal_sse<1>(s1 + n - 16, s2 + n - 16);
}

template <int cnt>
bool ObStringSearcher::memequal_sse(const char *p1, const char *p2) const {
  if (cnt == 1) {
    // 单个 __m128i（16 字节）比较
    return 0xFFFF == _mm_movemask_epi8(_mm_cmpeq_epi8(
        _mm_loadu_si128(reinterpret_cast<const __m128i *>(p1)),
        _mm_loadu_si128(reinterpret_cast<const __m128i *>(p2))));
  }
  if (cnt == 4) {
    // 4 个 __m128i（64 字节）合并比较
    return 0xFFFF == _mm_movemask_epi8(_mm_and_si128(
        _mm_and_si128(
            _mm_cmpeq_epi8(_mm_loadu_si128(...p1),     _mm_loadu_si128(...p2)),
            _mm_cmpeq_epi8(_mm_loadu_si128(...p1 + 1), _mm_loadu_si128(...p2 + 1))),
        _mm_and_si128(
            _mm_cmpeq_epi8(_mm_loadu_si128(...p1 + 2), _mm_loadu_si128(...p2 + 2)),
            _mm_cmpeq_epi8(_mm_loadu_si128(...p1 + 3), _mm_loadu_si128(...p2 + 3)))));
  }
}
```

四个长度级别的策略：

| 长度 | 策略 | 原理 |
| --- | --- | --- |
| 1 字节 | 直接 `*s1 == *s2` | 最简单，无开销 |
| 2/4/8 字节 | `memequal_plain<T>` 整型比较 | 一次 load + compare，无 SIMD 开销 |
| 3/5/6/7 字节 | 拆分为 int32 + int16/int8 组合 | 避免逐字节，用尽可能大的整型覆盖 |
| 9~16 字节 | 首尾各 8 字节（int64）比较 | 两次 int64 比较覆盖整个区域，有重叠但不影响正确性 |
| >16 字节 | `memequal_sse` 每 64 字节批量比较 | 4 个 `__m128i` 用 `_mm_and_si128` 合并 |

`memequal_sse<4>` 一次比较 64 字节（4 个 `__m128i`），用两层 `_mm_and_si128` 合并四组比较结果——全部相等时 `movemask` 返回 `0xFFFF`。尾部的 fall-through switch 处理不足 64 字节的剩余部分（16/32/48 字节各一轮）。
