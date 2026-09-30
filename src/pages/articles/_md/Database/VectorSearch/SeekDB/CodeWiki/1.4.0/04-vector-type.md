---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "向量类型与距离内核"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "OceanBase", "C++", "SIMD", "向量检索"]
description: "VECTOR 寄生 UDT 数组体系的类型表示、稀疏向量的 ObMapType 键值对、SSE/AVX2 多目标 SIMD 距离内核与函数指针分派表、normalize-then-dot 与 vec_ 前缀撞车辨析"
readingTime: "28 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

本模块回答「VECTOR 在 seekdb 里是什么」与「距离怎么算得快」两个问题，覆盖三块代码：`src/data_plane/api/data_plane/vector/`（18 个头文件——类型公共定义与 SIMD 内核声明的真源）、`src/storage/vector_type/`（26 个文件——模板特化与运行时分派）、`src/sql/engine/expr/ob_expr_vector*.cpp`（SQL 表达式层）。它是被三层消费的**纯函数内核**（SQL 表达式、向量索引构建/refresh、IVF kmeans、PQ 编码、vsag 适配层都要用距离函数），因此必须独立于任何消费方、放在依赖最底层——这也是 v1.4.0 把声明从 storage 上提到 data_plane 层的原因。

先破除两个常见误解：**其一**，`src/sql/engine/vector/`（Uniform/Discrete/Continuous 格式）是执行引擎的列向量化格式，与 AI 向量无关——OB 的「vectorized execution」概念早于「vector type」，命名撞车是历史包袱；**其二**，`src/share/vector/` 里的 `ob_bit_vector.h`/`ob_eval_bound.h` 同属执行引擎（skip 位图与批量求值边界），AI 向量相关只有 `ob_vector_index_mode.h`。

## 模块架构

```shell
src/data_plane/api/data_plane/vector/     # 声明 + SIMD 内核（真源）
├── ob_vector_metric.h                   # ObVectorDistanceType 枚举 + 分派表 + 相似度换算
├── ob_vector_l2_distance.h               # l2/l2_square/l2_norm（SSE/AVX 多目标）
├── ob_vector_cosine_distance.h / ob_vector_ip_distance.h / ob_vector_l1_distance.h
├── ob_sparse_vector_ip_distance.h       # 稀疏内积（双指针归并）
├── ob_vector_pq_coder.h / ob_vector_common_util.h   # PQ 编码 + 归一化 + IVF 质心查找
└── ob_i_vector_index_runtime.h / ob_vector_index_schema.h / ...

src/storage/vector_type/                 # 兼容垫片 + 模板特化
├── ob_vector_l2_distance.cpp            # ObVectorL2Distance<float>::l2_square_func 运行时分派
├── ob_vector_add / ob_vector_div        # 向量算术（实现在 .h 内联）
└── *.h → #include "data_plane/vector/..."   # 全部是一行转发垫片

src/sql/engine/expr/ob_expr_vector.{h,cpp}        # ObExprVector 基类 + ObExprVectorDistance
src/sql/engine/expr/ob_expr_vector_similarity.*  # ObExprVectorSimilarity + 相似度族
src/sql/engine/expr/ob_expr_vec_*.cpp            # ★ vec_ 前缀 = 向量索引内部表表达式（非业务向量）
```

## 调用链路

以 `SELECT l2_distance(embedding, '[...]') FROM t` 为例（`[...]` 字符串到距离值）：

```
ObExprVectorDistance::calc_distance (ob_expr_vector.cpp:144)
├─ ObArrayExprUtils::get_type_vector(expr, ctx, alloc, arr, contain_null)   # 取 ObIArrayType*
│    ├─ 稠密分支: reinterpret_cast<const float*>(arr->get_data())          # float32 数组即内存表示
│    └─ 稀疏分支: dynamic_cast<const ObMapType*>(arr) → is_sparse_vector_type()
├─ 维度校验: arr_l->size() != arr_r->size() → OB_ERR_INVALID_VECTOR_DIM (:168)
└─ DisFunc<float>::distance_funcs[dis_type](data_l, data_r, size, distance)  # 函数指针分派
     ↓ 分派表定义在 data_plane/api/data_plane/vector/ob_vector_metric.h:49
     ObVectorL2Distance<float>::l2_distance_func (storage/vector_type 模板特化)
       └─ if (is_arch_supported(AVX2)) avx2::l2_square ...     # 运行时按 CPU 选实现
```

方法速查表：

| 方法（内核） | 一行职责 | 关键设计 |
| --- | --- | --- |
| `l2_square_func` / `l2_distance_func` | 欧氏距离平方/开方 | SSE42/AVX/AVX2 多目标，**刻意跳过 AVX512** |
| `cosine_distance_func` | 1 − cos | SQL 层先归一化再点积 |
| `ip_distance_func` | 内积 | `ip_similarity = (1+ip)/2` |
| `l1_distance_func` | 曼哈顿 | 纯标量循环（无 SIMD） |
| `spiv_ip_distance_func` | 稀疏内积 | 双指针归并求交（键有序） |
| `vector_norm_func` | L2 范数 | 归约型，允许 AVX512 |
| `L2_normalize_vector` | 归一化 | cosine/ip 统一为归一化点积 |
| `distance_four_codes` | PQ 量化距离 | 4 段 code 一批查 |

<details>
<summary>SQL 表达式族速查（REG_OP 注册于 ob_expr_operator_factory.cpp:960-983）</summary>

```
ObExprVector (基类: ObFuncExprOperator)
├─ ObExprVectorDistance (T_FUN_SYS_VECTOR_DISTANCE "vector_distance", 2-3 参)
│   ├─ ObExprVectorL1Distance / L2Distance / L2Squared / CosineDistance
│   ├─ ObExprVectorIPDistance / NegativeIPDistance（为 HNSW 最大堆语义取负）
├─ ObExprVectorSimilarity (T_FUN_SYS_VECTOR_SIMILARITY)
│   ├─ ObExprVectorL2Similarity / CosineSimilarity / IPSimilarity
├─ ObExprVectorDims (VECTOR_DIMS) / ObExprVectorNorm (VECTOR_NORM)
└─ ObExprSemanticDistance ("semantic_distance" 别名，语法锚点，求值前被改写)
   + ObExprSemanticVectorDistance (真正执行，委托 calc_distance)
```
</details>

## 核心实现

### 类型表示：寄生 UDT 数组体系

VECTOR 不发明新的存储类型，而是**复用 UDT/collection（数组）类型体系**——有独立 `subschema_id_`，稠密向量就是 float32 数组，稀疏向量是 `ObMapType`（排序键值对 map）。证据链：`ObExprVector::VectorCastInfo` 携带 `is_vector_/need_cast_/subschema_id_/dim_cnt_`（`uint16_t dim_cnt_` 即 VECTOR(N) 的 N，随 subschema 元数据传递）；求值统一经 `ObArrayExprUtils::get_type_vector()` 返回 `ObIArrayType*`；注释明确「[a,b,c,…] is array type, there is no dim_cnt_ in ObCollectionArrayType」——数组本身无维度元数据，维度约束在 vector 子类型层。运行时维度校验在 `ObExprVectorDistance::calc_distance`（`ob_expr_vector.cpp:168-170`）报 `OB_ERR_INVALID_VECTOR_DIM`。

稀疏向量的完整表示（`ob_sparse_vector_ip_distance.cpp`）：

```cpp title="src/storage/vector_type/ob_sparse_vector_ip_distance.cpp"
uint32_t len_a = a->cardinality();
uint32_t *keys_a   = reinterpret_cast<uint32_t*>(a->get_key_array()->get_data());   // uint32 维度下标（有序）
float   *values_a = reinterpret_cast<float*>  (a->get_value_array()->get_data());   // float 权重
```

距离计算是**双指针归并求交**：键有序，相等则累乘、否则小者指针前移——这正是稀疏向量能进统一检索原语（SPIV 倒排）的算法基础（见[统一检索原语](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/07-retrieval)）。

### SIMD 多目标内核与运行时分派

内核按 `src/oblib/lib/utility/ob_target_specific.h` 的多目标编译框架声明（`OB_DECLARE_AVX_AND_AVX2_CODE` 等宏为每个指令集编译一份代码），运行时按 CPU 特性选择：

```cpp title="src/storage/vector_type/ob_vector_l2_distance.cpp:22-47（模板特化内）"
if (common::is_arch_supported(ObTargetArch::AVX2)) {
  ret = common::specific::avx2::l2_square(a, b, len, square);
} else if (common::is_arch_supported(ObTargetArch::AVX)) { ... avx::l2_square ... }
  else if (common::is_arch_supported(ObTargetArch::SSE42)) { ... sse42::l2_square ... }
  else { ... normal::l2_square ... }
```

三个值得引用的工程细节：**AVX512 被刻意跳过**——源码注释直书「AVX512 slower than AVX2, maybe using AVX512 lower CPU frequency which leads to worse performance」（`ob_vector_l2_distance.cpp:27,72,109`），但归约型的 `l2_norm_square` 又允许 AVX512（归约操作受益）；**尾部处理**——SIMD 主循环 8 对齐后剩余元素由 `_extra` 版本递归降级（`l2_square_simd8_avx256_extra → simd4_avx128_extra → normal`）；**SQ8 特化无 SIMD**——`uint8_t` 特化（量化向量）走纯标量 + `isinf` 溢出检查。

### 分派表与相似度换算

「SQL 语义枚举 → 内核函数」的映射收敛在 `ob_vector_metric.h` 一处，SQL 层零分支：

```cpp title="src/data_plane/api/data_plane/vector/ob_vector_metric.h（节选）"
// ObVectorDistanceType: COSINE=0 / DOT / EUCLIDEAN / MANHATTAN / EUCLIDEAN_SQUARED / MAX
ObVectorDistanceDispatch<float>::distance_funcs[] =
  { cosine_distance_func, ip_distance_func, l2_distance_func,
    l1_distance_func, l2_square_func, nullptr };   // 尾部 nullptr 为新度量预留
```

新增度量只改表——现成的 `EUCLIDEAN_SQUARED`（`l2_sq`）就是按此模式落地的实例（枚举第 5 位、槽位复用 `l2_square_func`）。相似度侧有静态换算 `vector_similarity_from_distance`（`:59`）：EUCLIDEAN → `1/(1+d²)`、DOT → `(1+d)/2`、COSINE → `(2-d)/2`。一个关键求值决策：**cosine/ip 相似度在 SQL 层先分配临时缓冲、各自 `L2_normalize_vector` 归一化后再算点积**（`ob_expr_vector_similarity.cpp`）——复用同一个 SIMD 点积内核，且与索引层（HNSW 用归一化 + l2 近似 cosine）行为一致（normalize-then-dot）。

### vec_ 前缀表达式：索引内部表的取值器

`ob_expr_vec_*`（`ObExprVecVid/VecType/VecVector/VecScn/VecKey/VecData/VecChunk/VecEmbeddedVec`、`ObExprSpivDim/SpivValue`）与 `ob_expr_vec_ivf_*`（center_vector/flat_data_vector/meta_vector/pq_center_vector/sq8_data_vector）是**向量索引内部表（VEC_/SPIV_ 系统函数）的取值表达式**，服务 index build/scan——与业务向量的 `ob_expr_vector_*` 是两套东西。区分口诀：**业务向量 SQL 函数 = `ob_expr_vector_*`；索引内部/执行引擎 = `ob_expr_vec_*` 与 `engine/vector/`**。另一个易混点：`ob_eval_bound.h`（`share/vector/`，namespace 是 `sql`）是列向量化执行引擎的批量求值边界（`[start_idx_, end_idx_)` 半开区间 + `all_rows_active_` 快速路径），配合 `ObBitVectorImpl` 的 skip 位图使用——与 AI 向量无关。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 函数指针分派表 | `ob_vector_metric.h` 的 `distance_funcs[]`/`similarity_funcs[]` | 枚举→内核映射收敛一处；新增度量零分支侵入；稀疏的 `spiv_distance_funcs[]` 同构预留 |
| 多目标编译 + 运行时选择 | `ob_target_specific.h` 宏 + `is_arch_supported` | 一份源码出 SSE42/AVX/AVX2 多份代码，部署时按 CPU 自动择优 |
| 模板特化 | `ObVectorL2Distance<float>/<uint8_t>` | float 全 SIMD、SQ8 量化标量——不同数据宽度不同策略 |
| 兼容垫片 | `storage/vector_type/*.h` 一行 include data_plane | v1.4.0 层级重排后旧 include 路径零改动 |
| 类型寄生 | VECTOR 复用 `ObIArrayType`/`ObMapType` | 序列化/cast/存储全链路免费继承数组基础设施，不复制一套类型系统 |

## 模块间交互

向上：SQL 表达式层（`ob_expr_vector.cpp` include `data_plane/vector/ob_vector_metric.h` 取分派表）；平行：向量索引体系（vsag adaptor 的 `construct_vsag_search_param` 用同一套 metric 字符串、IVF kmeans 的 `ObVectorKmeansClusterHelper::get_nearest_probe_centers` 用 `l2_square_func` 找最近质心）、retrieval 层的 SPIV 打分与这里的 `spiv_ip_distance_func` 数学同构。由于距离内核在 data_plane/storage 层，依赖方向严格单向（sql → storage → share/oblib），storage 不会反向依赖 SQL——这是 OB 分层铁律，也是把内核从 SQL 层下沉的动因。`storage/vector_type` 与 `data_plane/api/data_plane/vector` 的关系是 v1.4.0 重排的样本：声明上提（平台中立）、特化留守（兼容旧路径）。

## 扩展方式

新增距离度量（如 `hamming`）的最小改动路径：① 新建 `data_plane/api/data_plane/vector/ob_vector_hamming_distance.h`（声明 + SIMD 多目标内核，仿 l2 的宏结构）；② `ob_vector_metric.h` 的 `ObVectorDistanceType` 加 `HAMMING`（`MAX_TYPE` 前）+ 分派表对应槽位填函数（表尾 nullptr 即占位）；③ compat 垫片 `storage/vector_type/ob_vector_hamming_distance.{h,cpp}`（.h 一行 include；.cpp 放运行时分派模板特化）；④ 若要暴露命名 SQL 函数：`ob_expr_vector.h` 加 `ObExprVectorHammingDistance : ObExprVectorDistance` 子类 + `calc_hamming_distance`（一行调 `calc_distance(..., HAMMING)`）+ `REG_OP` 注册 + item type/名字宏/parser 产生式三件套；⑤ ANN 索引支持需 vsag 上游配合（`ob_vector_util.cpp` 的 metric 字符串表加 "hamming"），否则仅 brute-force 可用；⑥ 稀疏向量支持（可选）：`spiv_distance_funcs[]` 对应槽位补 `spiv_hamming_func`。
