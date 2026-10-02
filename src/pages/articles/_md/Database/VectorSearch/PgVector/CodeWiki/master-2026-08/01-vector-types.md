---
source:
  type: "源码解读"
  project: "pgvector"
  url: "https://github.com/pgvector/pgvector"
title: "向量类型"
date: "2026-10-02T16:47:23+08:00"
category: [Database, VectorSearch, PgVector, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, PgVector, CodeWiki, "master-2026-08"]
tags: ["PgVector", "C", "PostgreSQL", "varlena", "SIMD"]
description: "pgvector 向量类型模块解读——vector/halfvec/sparsevec 三种 varlena 布局、text/binary I/O 与 typmod 校验、四档 CPU 分发的距离内核（target_clones/F16C/AVX-512 popcount）、cast 矩阵与 support proc 解耦全解"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

这个模块回答一个问题：**「向量」作为一种 Postgres 类型长什么样、怎么算距离**。它是 pgvector 的地基——没有索引也可以用（精确搜索就是全表扫 + 排序），没有类型则一切都不存在。职责边界：四种类型的磁盘/内存表示、I/O 解析、距离内核、cast、聚合，到「SQL 可调用的函数」为止；索引怎么用这些距离（support proc 协议）是 HNSW/IVFFlat 模块的事，本模块只保证内核够快、语义正确。

设计上最有辨识度的决策是：三种类型**共享同构的 8 字节头**，而 halfvec 的半精度与 bit 的二值化把「量化」从索引层挪到了类型层——pgvector 不做索引内 PQ，换精度就换类型（`halfvec`、`binary_quantize` 转 `bit`）。

## 模块架构

![类型内存布局与 CPU 分发策略](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/type-layout-dispatch.svg)

内部结构分两半。左半是**数据模型**：三种新类型都是 varlena 可变长度类型（第 4 字节 `vl_len_` 是 varlena 头，不可直接读写，须经 `SET_VARSIZE`/`PG_DETOAST_DATUM`），`int16 dim + int16 unused` 恰好凑成 8 字节对齐头——数据区 4 字节对齐是 `HnswElementTupleData`（hnsw.h:381）能直接内嵌 `Vector` 复用布局的前提。sparsevec 用 `int32 dim` 是因为它要支持 10 亿逻辑维，其大小只随 nnz 增长。右半是**距离内核的分发策略**：按「编译器能自动向量化的用 target_clones、需要手写 intrinsic 的用启动期函数指针」分四档，全部有可移植 Default 兜底，`DISABLE_DISPATCH` 宏可整体关闭。

## 调用链路

![距离函数调用链——SQL 到 SIMD 内核](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/distance-call-chain.svg)

关键设计在这条链的中段：`<->` 运算符绑定的 `PROCEDURE` 是含 sqrt 的 `l2_distance`，但 opclass `FUNCTION 1` 注册的是**平方版** `vector_l2_squared_distance`——图遍历/排序只需单调同序，每元组省一次 sqrt。数据形态单向收缩：`Datum`（varlena）→ `Vector*`（detoast 强转）→ `double` 距离。索引层永远经 `FunctionCall2Coll` 调用（HnswGetDistance in hnswutils.c:525），本模块与索引代码零直接耦合。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `vector_in` (vector.c:177) | text → Vector | `strtof` 直接到 float32，避免 double 双重舍入 |
| `vector_out` (vector.c:290) | Vector → text | `float_to_shortest_decimal_bufn` 最短表示，round-trip 精确 |
| `vector_recv` (vector.c:376) | 二进制 → Vector | `unused` 强制为 0，前向兼容哨兵 |
| `CheckDim` (vector.c:95) | 维度校验 | 1..16000，超出报 `ERRCODE_DATA_EXCEPTION` |
| `CheckExpectedDim` (vector.c:84) | typmod 校验 | `typmod != -1 && typmod != dim` 报错 |
| `CheckElement` (vector.c:112) | 元素值校验 | 拒绝 NaN/Inf——距离函数在非有限值下未定义 |
| `VectorL2SquaredDistance` (vector.c:561) | L2² 内核 | 挂 `VECTOR_TARGET_CLONES`，编译器自动向量化 |
| `VectorCosineSimilarity` (vector.c:650) | 余弦相似度 | 单趟三累加，除 `sqrt(a*b)` 少两次开方 |
| `vector_spherical_distance` (vector.c:704) | 角距离 | 供球面 kmeans 用——cosine 不满足三角不等式 |
| `halfvec_l2_distance` (halfvec.c:561) | halfvec 距离包装 | 调 `HalfvecL2SquaredDistance` 函数指针 |
| `halfvec_in` (halfvec.c) | text → HalfVector | 转 half 后检测 `HalfIsInf && !isinf(源)` 报溢出 |
| `sparsevec_in` (sparsevec.c:204) | text → SparseVector | 先数逗号预分配，`qsort` 后查严格升序 |
| `SPARSEVEC_VALUES` (sparsevec.h:44) | 取 values 区偏移 | 避免 struct 尾部对齐空洞 |
| `binary_quantize` (vector.c:953) | vector → bit | 符号位二值化，量化路线的桥 |
| `HalfToFloat4` (halfutils.h:63) | half → float | 三档：F16C 指令 / `_Float16` / 手写位操作 |
| `Float4ToHalf` (halfutils.h:245) | float → half（checked） | 溢出（>65504）报错而非静默 Inf |
| `_PG_init` (vector.c:57) | .so 入口 | 四行分派四个 Init，本模块占前两个 |

</details>

## 核心实现

### 三种 varlena 布局与 sparsevec 的 COO 设计

```c title="src/vector.h"
typedef struct Vector
{
	int32		vl_len_;		/* varlena header (do not touch directly!) */
	int16		dim;			/* number of dimensions */
	int16		unused;			/* reserved for future use, always zero */
	float		x[FLEXIBLE_ARRAY_MEMBER];
}			Vector;
```

`HalfVector`（halfvec.h:67）逐字段同构，仅 `x[]` 元素类型为 `half`。`half` 本身是编译期分派的（halfvec.h:52）：编译器支持 `_Float16` 就直接用；否则退化为 `uint16` 位模式，转换全靠 halfutils 的软件位操作。

```c title="src/sparsevec.h"
typedef struct SparseVector
{
	int32		vl_len_;
	int32		dim;			/* 逻辑维度，最大 1e9 */
	int32		nnz;			/* 非零元素数，最大 16000 */
	int32		unused;
	int32		indices[FLEXIBLE_ARRAY_MEMBER];   /* 0-based、升序、去重 */
}			SparseVector;
```

values 区不落在 struct 字段里，由 `SPARSEVEC_VALUES`（sparsevec.h:44）按 `nnz` 个 int32 的偏移计算取得。为什么是 COO 而非 CSR/CSC：Postgres datum 是连续内存块，没有"行指针"概念，两个平行数组（indices 在前、values 紧随）最自然，也使 send/recv 可以接近 memcpy。**升序去重不变式**（sparsevec.h:19 注释明确约定）是所有稀疏距离函数做双指针 merge 的前提——`sparsevec_in` 解析后 `qsort` 再逐个 `CheckIndex`（sparsevec.c:108）校验界内、严格升序；解析时 0 值元素直接丢弃（"Do not store zero values"，sparsevec.c:323），`sparsevec_recv` 同样拒绝二进制格式的零值（sparsevec.c:555），共同维持 nnz 不变式。一个易踩的细节：文本格式索引 1-based（面向 SQL 习惯），二进制格式 0-based（面向程序省一次转换），`sparsevec_in` 做 `index - 1`、`sparsevec_out` 做 `+ 1`（sparsevec.c:327/464）。

三种类型的上限由各自头文件的宏定义：`VECTOR_MAX_DIM 16000`（vector.h:11）、`HALFVEC_MAX_DIM 16000`（halfvec.h:60）、`SPARSEVEC_MAX_DIM 1000000000` + `SPARSEVEC_MAX_NNZ 16000`（sparsevec.h:11-12）。**类型层允许 16000 维，索引层收紧到 2000（halfvec 4000、bit 64000）**——后者是索引 tuple 须放进 8KB 页的约束（见[模块间交互](#模块间交互)）。

### 类型 I/O：从 text 到 Datum

`vector_in`（vector.c:177）的解析循环里有个容易忽略的正确性决策：用 `strtof` 而不是 `strtod` 再截断（vector.c:229 注释 "Use strtof like float4in to avoid a double-rounding problem"）——先到 double 再降到 float 会引入双重舍入误差，直接 strtof 一步到位。每个元素过 `CheckElement` 拒绝 NaN/Inf：距离函数（尤其 cosine 的除法）在非有限值下结果未定义，放进索引会破坏一致性。输出侧用 Postgres 的 `float_to_shortest_decimal_bufn` 做**最短十进制表示**——float32 只有 ~7 位有效数字，`%g` 要么截断失真要么打印垃圾位，最短表示保证 round-trip 精确。

typmod 机制：`vector(3)` 声明维度时 `vector_typmod_in`（vector.c:345）校验 1..16000 并返回维度数作为 typmod；`vector_in`/`vector_recv` 经第 3 参数拿到 typmod，`CheckExpectedDim` 中 `typmod != -1 && typmod != dim` 即报错（-1 表示未声明）。同名函数 `vector(vector, integer, boolean)` 是 typmod 调整 cast，服务于 `CAST(v AS vector(3))`。

### 距离内核：四档 CPU 分发

这是本模块性能设计的核心。**为什么分四档而不是统一一套**：每种类型的向量化路径不同——float32 标量循环编译器能自动向量化（挂 `target_clones("default", "fma")` 让 glibc IFUNC 在运行时选含 FMA 的克隆）；half→float 转换没有自动向量化路径，必须手写 `_mm256_cvtph_ps`（一条指令转 8 个 half）；popcount 有专用 AVX-512 指令。统一策略必然牺牲某一档。

```c title="src/vector.c — target_clones 分发"
#if defined(USE_TARGET_CLONES) && !defined(__FMA__)
#define VECTOR_TARGET_CLONES __attribute__((target_clones("default", "fma")))
#endif
```

halfvec 走**启动期函数指针**：`HalfvecInit`（halfutils.c:279）默认装 `*Default` 版本（循环内 `HalfToFloat4` 软/硬转换后按 float32 计算），`SupportsCpuFeature(AVX|F16C|FMA)`（CPUID + `_xgetbv` 检查 OSXSAVE 使能，halfutils.c:255）成立则装 `*F16c` 版本。halfvec.h:46 注释还指出 F16C 比编译器 `_Float16` 更快，因此 dispatch 开启时故意不用 `FLT16_SUPPORT`。bitvec 的 `BitvecInit`（bitutils.c:208）同理按 `SupportsAvx512Popcount` 选 `_mm512_popcnt_epi64`，否则 64 位 `popcount64` + `pg_number_of_ones` 查表兜底。两个距离的底层公式：hamming 按 64 位块 XOR 后 popcount 累加（`BitHammingDistanceDefault`，bitutils.c:62），jaccard 单趟同时累加交集 ab 与两侧 1 的个数 aa/bb、**交集为 0 时直接返回 1**（`BitJaccardDistanceDefault`）。一个真实的兼容性权衡：bitutils.c:28 对 popcnt 的 target_clones 因 LLVM bitcode 生成崩溃被 `!defined(__llvm__)` 条件禁用。

度量语义上值得注意的三处：(1) `<#>` 内积取负（`vector_negative_inner_product`）——Postgres 索引扫描只支持 ASC，最大内积等价最小负内积；(2) `vector_spherical_distance` 用 `acos(ip)/π` 角距离并假设输入已单位化——spherical kmeans 需要满足三角不等式，cosine 不满足所以不能用（vector.c:704 注释）；(3) cosine 的 `1-similarity` 先把 similarity clamp 到 [-1,1] 防 `1-sim` 出负数（MSVC `/fp:fast` 下 NaN 传播不可靠还有特判，vector.c:683）。

### Cast 矩阵与聚合

| cast | 函数 | 位置 | 精度处理 |
|---|---|---|---|
| halfvec → vector | `halfvec_to_vector` | vector.c:542 | 无损（半→单精度） |
| vector → halfvec | `vector_to_halfvec` | halfvec.c:539 | round-to-nearest-even；溢出（>65504）报错 |
| sparsevec → vector | `sparsevec_to_vector` | vector.c:1324 | 展开为稠密，零填充 |
| vector → sparsevec | `vector_to_sparsevec` | sparsevec.c:607 | 两趟：先数非零得 nnz 再填充 |
| halfvec ↔ sparsevec | `halfvec_to_sparsevec` / `sparsevec_to_halfvec` | sparsevec.c:651 / halfvec.c:1199 | `HalfIsZero` 处理 -0.0 位模式 |

`vector → halfvec` 标为 `AS IMPLICIT`（sql/vector.sql:694）——转换语义安全（checked、只损精度不静默溢出），用户往 halfvec 列直接插 vector 字面量即可。0.8.7 对 sparsevec 双向 cast 的加固（#1016，`Hardened sparsevec_to_vector` 等提交）就在这条矩阵边上。聚合走 float8[] state 数组（`vector_accum`/`vector_combine`/`vector_avg`，vector.c:1149 起），`vector_combine` 注释提醒 halfvec_combine 共用同一实现；0.8.7 修了 `avg` 无匹配行时报错的 bug（vector_avg 加 `n == 0` 返回 NULL）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 函数指针虚表 | `halfutils.h:13` 四个 `Halfvec*` 指针、`bitutils.h:11` 两个 popcount 指针 | 启动期一次性选内核，热路径零分支开销 |
| target_clones（多版本函数） | `VECTOR_TARGET_CLONES`（vector.c:42） | 让编译器/glibc 做运行时选择，代码保持可读的标量循环 |
| 三档降级 | `HalfToFloat4`（halfutils.h:63）：F16C → `_Float16` → 手写位操作 | 覆盖从现代 x86 到无半精度硬件的全谱系 |
| 工厂初始化 | `_PG_init` → `BitvecInit`/`HalfvecInit` | .so 加载即装配，SQL 侧无感知 |

## 模块间交互

本模块是**被依赖者**：`hnswutils.c`/`ivfutils.c` 经 opclass support proc 间接调用距离内核（`HnswGetDistance` in hnswutils.c:525）；`ivfutils.c:322/360` 的质心累加直接用 `Float4ToHalfUnchecked`/`HalfToFloat4`；`hnswutils.c:1401` 按类型放宽维度上限（halfvec 4000 = `HNSW_MAX_DIM × 2`、bit 64000 = `×32`，依据是索引 tuple 须放进 8KB 页——**类型层上限 16000，索引层上限 2000/4000/64000 是两回事**，常被混淆）。对外只通过两个窄接口：`HnswQuery.value`（Datum 包装）和 `HnswSupport`（FmgrInfo），无循环依赖。

## 扩展方式

- **新增距离度量**：内核挂 `VECTOR_TARGET_CLONES` + `PG_FUNCTION_INFO_V1` 包装 → SQL 层在**每个** opclass 加 `FUNCTION 1`（工作量在 SQL 不在 C，索引代码零改动）→ 不满足三角不等式的度量须先变换（参照 `vector_spherical_distance`）
- **新增向量类型**：照 vector.c 全套复制 + SQL 五段模板 + `hnswutils.c`/`ivfutils.c` 各加一份 `*_support` 返回 `TypeInfo`；有专用指令再建 utils 文件仿 halfutils 的指针分发
- **关闭分发调试**：编译加 `DISABLE_DISPATCH=1`（halfvec.h:17），全部退回可移植路径，用于隔离 SIMD 引入的数值差异
