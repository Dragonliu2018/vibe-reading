---
source:
  type: "源码解读"
  project: "USearch"
  url: "https://github.com/unum-cloud/USearch"
title: "基础设施与度量"
date: "2026-09-21T15:26:32+08:00"
category: [Database, Misc, USearch, CodeWiki, "2.26.2"]
contentType: "CodeWiki"
tags: ["USearch", "C++", "SIMD", "类型擦除"]
description: "USearch 基础设施层解读——f16/bf16/FP8 标量位级实现与 LUT 转换、metric_punned_t 类型擦除与 NumKong 内核路由、双执行器、arena 分配器与开地址哈希容器"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/00-overview)

---

## 模块定位

`include/usearch/index_plugins.hpp`（4,293 行）是 USearch 的"标准库层"：标量类型系统（f16/bf16/FP8 全家）、距离度量库、`metric_punned_t` 动态派发、执行器（线程池）、分配器、并发原语、哈希容器、K-Means 与精确搜索。文件按序分七段：标量类型（L1-1345）→ 执行器（L1347-1555）→ 分配器（L1557-1795）→ 并发原语（L1797-1883）→ 转换系统（L1885-2235）→ 度量库与 punning 路由（L2247-3231）→ 高层算法件。

它被 `index_dense.hpp:12` include，同时反向 include `index.hpp`（复用 `expected_gt` 与宏，`index_plugins.hpp:11`）。SIMD 能力来自 git 子模块 NumKong（v7.8.1），由 `USEARCH_USE_NUMKONG` 宏门控（CMakeLists.txt:28 的 option，默认 OFF，由各绑定自行开启 + `NK_DYNAMIC_DISPATCH=1` 动态分发）。

## 模块架构

这一层解决的核心矛盾是：**C ABI 和文件序列化只能传 int 枚举，而高性能度量必须是模板**（编译期知道 scalar/result 类型才能向量化）。`metric_punned_t` 用"编译期实例化全部组合 + 运行期一次查表选函数指针"把两个世界接起来，构造期一次决策烘焙进对象，`operator()` 调用零间接分支。这是全库唯一的热路径分发点。

```cpp title="include/usearch/index_plugins.hpp:2891"
inline result_t operator()(byte_t const* a, byte_t const* b) const noexcept {
    return (this->*metric_routed_)(reinterpret_cast<uptr_t>(a), reinterpret_cast<uptr_t>(b));
}
```

为什么用**成员函数指针**而不是直接存内核指针：路由目标需区分多种 thunk——`invoke_numkong<acc, reverse>`（按累加器类型与 IP-reverse 标志模板化）、`invoke_array_array_third`（三参签名）、`invoke_array_array`（二参签名）——成员函数指针让它们共享同一个调用点，零分支、零 `std::function` 堆分配。

## 调用链路

![metric_punned_t 路由机制](/vibe-reading/images/articles/usearch-internals/plugins-metric-dispatch.svg)

`builtin()` 工厂（`index_plugins.hpp:2916`）的决策树：先试 `configure_with_numkong()`——把 metric_kind 映射到 NumKong 内核（ip→dot、cos→angular、l2sq→sqeuclidean、hamming/tanimoto/jaccard→对应二进制内核，**pearson/haversine/divergence/sorensen 没有 NumKong 内核直接返回 false**），标量侧经 `scalar_kind_to_nk_dtype`（`index_plugins.hpp:2688`，b1x8 映射到 `nk_u1_k`）转成 NumKong dtype，`nk_find_kernel_punned` 按 `nk_cached_capabilities()` 探测到的 CPU 能力选最优 ISA；累加器类型由 `nk_kernel_output_dtype` 决定（i8 dot 输出 i32、i8 cos 输出 f32……），据此把 `metric_routed_` 烘焙成 `invoke_numkong<int32_t, reverse>` 等具体实例。**b1x8 的第三参换语义**：二进制集合内核（Hamming/Jaccard/Tanimoto）要的是 bit 数不是字数，所以 NumKong 路径把 `metric_third_arg_` 覆写回 `dimensions_`（`index_plugins.hpp:3087-3089`）。失败则 `configure_with_autovec()`（`index_plugins.hpp:3108`）——metric_kind × scalar_kind 双重 switch 到 `equidimensional_<metric_xxx_gt>` 模板实例（i8/u8 的 cos/l2sq 落到 `metric_cos_i8_t`/`metric_l2sq_i8_t`/`metric_cos_u8_t`/`metric_l2sq_u8_t` 四个专用特化，`index_plugins.hpp:2527-2625`），靠 `#pragma omp simd` / `clang loop vectorize(enable)` / `GCC ivdep` 三连 pragma 让编译器自动向量化。

另外两个工厂：`stateless(dimensions, metric_uintptr, signature, ...)`（`index_plugins.hpp:2946`）把用户 C 函数指针按 signature 二选一挂到 `invoke_array_array` / `invoke_array_array_third`（第三参 = 维度数或 b1x8 字数）——Numba/Rust 回调都走这里；`stateful(dimensions, metric_uintptr, metric_state, ...)`（2973）第三参换成任意状态指针。两个布尔语义值得区分：`operator bool()`（2990）检查 `metric_routed_ && metric_ptr_`（能否计算），`missing()`（2999）在 falsy 且 kind 不为 unknown 时为真——用于"从文件恢复索引时的占位但未初始化"状态。

`metric_third_arg_` 一字段三用（维度数 / b1x8 的字数或位数 / 用户状态指针）是紧凑性的取舍：`metric_punned_t` 保持 POD 尺寸、三张 C 签名共享一个 routed 调用点；代价是语义隐式，读者必须结合 `metric_routed_` 指向的 thunk 才知道第三参含义。

<details>
<summary>度量速查表（点击展开）</summary>

| 度量 | 位置 | 要点 |
|------|------|------|
| `metric_ip_gt` | L2252 | 返回 `1 - ab`（统一"小=近"语义） |
| `metric_cos_gt` | L2277 | 单遍累 ab/a²/b²；零向量查表优雅处理 |
| `metric_l2sq_gt` | L2308 | 不开方（排序不变性） |
| `metric_hamming_gt` | L2335 | `bitset(x^y).count()` |
| `metric_tanimoto_gt` | L2363 | 1 − |a∩b|/|a∪b|（分子指纹） |
| `metric_sorensen_gt` | L2395 | Dice 系数 |
| `metric_jaccard_gt` | L2429 | 稀疏版：四参签名归并两个有序集合 |
| `metric_pearson_gt` | L2454 | 单遍五累加器，dim≤1 或分母≤0 时返回 0 |
| `metric_divergence_gt` | L2499 | Jensen-Shannon 散度，带 epsilon 防 log(0) |
| `metric_haversine_gt` | L2631 | 球面距离（`angle_to_radians` 度转弧度），输入 (纬度, 经度)，dim 恒 2 |
| i8/u8 特化 | L2527-2625 | `metric_cos_i8_t` 等，int32/int64 累加器防溢出，输出恒 f32 |

</details>

## 核心实现

### 标量类型系统：bits 类 + LUT

六个 bits 类（`f16_bits_t` L569、`bf16_bits_t` L633、`e5m2_bits_t` L935、`e4m3_bits_t` L994、`e2m3_bits_t` L1222、`e3m2_bits_t` L1281）结构同构：私有存储 `uint16_t`/`uint8_t`，`operator float()` 是唯一出口。**为什么不用 `_Float16`**：bits 类必须在 MSVC、旧 Clang、嵌入式编译器上零依赖编译，`_Float16` 在这些编译器上要么缺失要么语义不一致，而 `uint16_t` 永远存在——"硬件无关软实现 + 可选硬件加速"双轨（NumKong 开启时转换函数首分支直调 `nk_f16_to_f32_serial` 等内核）。

转换实现三种策略：

1. **f16↔f32 纯位运算**（`f16_to_f32` L430）：denormal 用"FPU normalization trick"——把尾数当整数转 float 借 FPU 归一化，再减 `0x0C000000u` 修正指数偏置，一次除法不用；下转完整实现 RNE（round-to-nearest-even）。
2. **bf16 截断式**（L526）：bf16 本就是 f32 砍低 16 位，上转零扩展、下转右移（截断非 RNE，已知精度取舍）。
3. **FP8/FP6 上转用 LUT**：`e5m2_to_f32`（L701）是 **128 项静态查找表**（7-bit 幅值查表 + sign 位单独处理，表尾处理 inf/NaN）；FP6 的 `e2m3_to_f32`（L1053）是 64 项全表。**为什么查表**：表 512B/256B 稳进 L1，一次内存读代替"拆 sign/exp/mant → 移位重组"的多条依赖指令，且无分支；同时规避 FP6 非标 exponent bias（e2m3 bias=1）下手写移位容易错。读密集（查询路径每个向量元素都要上转）所以查表、写稀疏（量化时才下转）所以可以慢而正确——不对称优化。下转（`f32_to_e5m2` L753）是几十行分支：E5M2 溢出→inf、E4M3 饱和到 ±448、subnormal 缩放、RNE 舍入；FP6 干脆用 `std::frexp`。

### cast_gt 转换矩阵

`cast_gt<from, to>`（L1889）泛型主模板 + 五类特化：恒等特化 `try_` 返回 false 表示"无需转换"（上层据此直接 memcpy）；`cast_to_b1x8_gt` 正值置位；**`cast_to_i8_gt` 不是 clamp 而是范数缩放**——先算向量 L2 范数再 `x×127/magnitude` 映射进 [-127,127]（L1966-1969 注释警告：假设 dot-product-like 度量，其他度量语义不保真）。所有 fp8/fp6 × {f32,f64,f16,bf16} 的 16 个组合全部委托 `cast_through_f32_gt`（L2049，graphify 全局第 6 度）——因为 bits 类只实现了 `operator float()` 一个出口。运行时入口是 `casts_punned_t`（L2156）：11 个函数指针组成的表 × from/to 两组，`make<scalar_t>()` 编译期填 22 格——转换界的 `metric_punned_t` 同款设计。

### 执行器：STL 与 OpenMP 双轨

`executor_stl_t`（L1351）不是常驻线程池——注释自陈"小批量低效，每次调用重建线程"。内嵌 RAII 包装 `jthread_t`（L1354，析构 join）。三种调度：`fixed` 按线程均分区间、主线程亲自跑第 0 段（省一次 spawn）；`dynamic` 同样静态分区但共享 `atomic_bool stop` 支持提前终止；`parallel` 每线程一个任务。每个 worker lambda 首行调 `nk_configure_thread_`——NumKong 的 per-thread 状态（如 SVE 向长）必须每线程初始化。

`executor_openmp_t`（L1471）的 `fixed` 用 `#pragma omp parallel for schedule(dynamic, 1)`——OpenMP 版才是真动态调度；`dynamic` 因 OpenMP cancellation 多数平台不可用退化为 stop 标志（L1515-1526 大段注释解释 `OMP_CANCELLATION` 限制）。双轨的运行时出口是 `executor_default_t`（L1549/L1553 的 `using` 二选一：开 OpenMP 别名 `executor_openmp_t`，否则 `executor_stl_t`）。`executor_stl_t` 构造参数为 0 时默认取 `std::thread::hardware_concurrency()`（L1362-1363）。**双执行器并存的原因**：OpenMP 调度更优但它是重依赖（嵌入 Python/Rust/WASM 绑定时常不可用），STL 版零依赖保底——同一模板接口让上层无感切换，CMake `USEARCH_USE_OPENMP` 默认 OFF。

### 分配器与容器

`memory_mapping_allocator_gt`（L1653）是 **arena 级 bump 分配器**："alloc many, free at once"，arena 链表藏在每块开头（`head_size()` 存前向指针+容量），4MB 起步 ×2 增长，`total_allocated`/`total_wasted`/`total_reserved` 提供统计。关键语义：任何一次 deallocate 触发 `reset()` 丢弃全部 arena（L1789-1792 警告注释）——适合索引构建期的向量批量分配。`aligned_allocator_gt<T, 64>`（L1561）三平台分支处理对齐（Windows `_aligned_malloc`、Apple/Android `posix_memalign`、其余 `aligned_alloc`）；`page_allocator_t`（L1611）是 4KB 粒度的 mmap/VirtualAlloc 页分配器，供大块映射场景。

`flat_hash_multi_set_gt`（L3728，graphify 度 24）是 key→slot 查找表的底座：**开地址线性探测**（非 robin hood，下一槽 = 当前槽 +1 对 2 的幂容量取模），每 bucket 64 槽，前 16 字节两个位图（populated/deleted）表达三态槽——不用预留哨兵元素（L3720 注释对比 `growing_hash_set_gt` 用 0xFF..FF 当空槽标记）。负载因子 2/3，never shrink。Tombstone 生命周期最精细：`try_emplace`（L4263）负载检查把 tombstone 和活项一起计数（防 churn 下永不 rehash）；`rehash_into`（L3786）重建时从 hash 重新探测而非槽对槽复制（被 tombstone 错位的活项不能复制，否则不可达）。

### 高层算法件

`exact_search_t`（L3287）暴力搜索三阶段：数据并行算全距离矩阵 → 单线程转置避免写竞争 → 每 query `partial_sort`。`kmeans_clustering_gt`（L3410）混合精度 K-Means：质心同时保 f64（聚合防累加误差）与量化（距离计算零转换开销）两份；四种早停（迭代数/惯性阈值/最小迁移/时限）。注意 v2.26.2 中 kmeans 只被 `cpp/test.cpp` 使用，`index_dense_gt::cluster()` 的聚类路径已改为纯 HNSW-level 方案（见[稠密索引](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/03-dense-index)）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 类型擦除 + 成员函数指针路由 | `metric_punned_t` L2856 | C ABI 无模板参数；POD 尺寸可整体落盘（dimensions/kind 跟着走） |
| 双重 dispatch 矩阵 | `configure_with_autovec` L3108 | N×M 组合编译期全实例化、运行期一次查表；矩阵刻意稀疏（haversine 只支持 f64/f32） |
| IP 返回 `1 - ab` | L2267 等 | 统一"距离越小越近"，HNSW 的 top-k 最小堆不需要按度量分支；NumKong 路径在 thunk 里补 `1-x`（L3036） |
| LUT 上转 | `e5m2_to_f32` L701 | 读密集路径查表（512B 进 L1、无分支），写稀疏路径慢而正确 |
| 编译期宏门控 | `USEARCH_USE_OPENMP/NUMKONG` L17-27 | 可选依赖整体消失，关 NumKong 后 `hardware_acceleration_*` 返回 "serial"（L2846） |

## 模块间交互

被 `index_dense.hpp` 消费：`casts_punned_t`（add/search 的精度转换）、`metric_punned_t`（typed_ 引擎与序列化头的度量对象）、`flat_hash_multi_set_gt`（slot_lookup_ 底座）、`ring_gt`（free_keys_ / available_threads_）、两个分配器（index_gt 模板注入）。NumKong 是 git 子模块，`isa_kind_`（L2877）记录实际启用的指令集，`isa_name()`（L3001）报告 haswell/skylake/neon/sve 等名字——这就是 Python `Index.hardware_acceleration` 返回 "sapphire" 的来源。

## 扩展方式

**新增 metric_kind**（5 处）：`metric_kind_t` 加枚举（L114，注意枚举值是 char 且直接落盘）→ 写模板 metric struct（仿 L2308）→ `metric_kind_name`/`metric_from_name` 加名字（L335/L394）→ `configure_with_autovec` 加 case 块（L3108）→ 如要 NumKong 加速再加 `configure_with_numkong` 的映射（L3047）。

**新增 scalar kind**（6-7 处）：枚举（L139）→ `scalar_kind<>`/`bits_per_scalar(_word)`/名字四处的支持函数 → bits 类 + LUT/位运算转换 → `cast_gt` 特化块（L2059-2121 约模板 12 行）→ `casts_punned_t` 加格（L2157/2189）→ autovec 每个相关 metric case 加一行。

**换掉 NumKong 后端**：只动 `nk_find_kernel_punned`/`nk_capability_t` 集成层（L2668-2849 + L3020-3094 + 执行器三处 `nk_configure_thread_`）——"枚举驱动全矩阵"的维护成本集中于此，换来的是图引擎与绑定层完全无感。
