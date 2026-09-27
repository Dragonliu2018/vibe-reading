---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "向量化数据结构"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "向量化", "Column", "Chunk", "SIMD", "函数注册表"]
description: "StarRocks BE 向量化基础：COW Column 体系、Chunk eager 过滤语义、NullableColumn 组合设计与双端生成的函数注册表。"
readingTime: "15 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`be/src/column/`（3.8 万行）+ `types/`（2 万）+ `exprs/`（7.2 万）是全 BE 的内存格式底座：`Chunk`/`Column` 被 import/include 两百余次，所有算子、表达式求值、文件读写都在这层结构上工作。它独立成篇回答一个问题：**为什么自研而不用 Arrow**——答案写在 `column.h` 的设计细节里。

## 模块架构

三块：`Column` 类族（COW 基类 + FixedLength/Binary/Nullable/Const 等派生）、`Chunk`（列组合 + Schema）、向量化表达式（`Expr`/`ExprContext`/`VectorizedFunctionCallExpr` + 双端生成的注册表）。`types/logical_type.h` 的 `LogicalType` 枚举（TYPE_TINYINT=1 … TYPE_VARIANT=55）贯穿全栈，DECIMAL32/64/128 经 `DelegateType` 模板映射到整数物理类型。

## 调用链路

### 表达式求值链

```text
ExprContext::evaluate(Chunk*, uint8_t* filter)      # expr_context.cpp:164
  → 递归 Expr::evaluate_checked(context, chunk)      # expr.h:162
    → VectorizedFunctionCallExpr::evaluate_checked   # function_call_expr.cpp:178
        先 evaluate 各子节点收集 Columns args
        → _fn_desc->scalar_function(fn_ctx, args)    # 查 BuiltinFunctions 注册表
```

异常用 try/catch 包裹转 `RuntimeError`。`BuiltinFunctions`（`builtin_functions.h`）= `unordered_map<uint64_t fid, FunctionDescriptor>`，`ScalarFunction` 是 `std::function<StatusOr<ColumnPtr>(FunctionContext*, const Columns&)>`。fid 从 FE 的 `TFunction.fid` 传下来，`_get_function_by_fid` 直接查表。

## 核心实现

### Column：COW 基类（`column/column.h`，557 行）

```cpp title="column/column.h（节选）"
class Column : public Cow<Column> {   // common/cow.h 的 Copy-on-Write 基类
    Column::Ptr / MutablePtr;          // mutate() / try_mutate()
```

**这是自研而非复用 Arrow 的核心**：查询执行中同一列常被多个算子共享（如 filter 前后），COW 让只读共享零拷贝、写时才 clone（受 `config::enable_cow_optimization` 开关控制，column.h:472）。关键纯虚函数按语义分组：

- **追加/gather**：`append_datum`、`append_selective(src, indexes, from, size)`（gather 语义）、`append_strings_overflow(Slice*, size, max_length)`——**允许越界读 16 字节换取批量定长拷贝**（头部注释实测 2GB/350M 行从 8s 降到 3.5s），Arrow 无此优化；
- **过滤/复制**：`filter(const Filter&)`/`filter_range(filter, from, to)`（`Filter = Buffer<uint8_t>`，1 保留 0 删除）、`clone()/clone_empty()`、`replicate(offsets)`（lambda 数组展开按 offset 复制行）；
- **序列化**：`serialize_batch`、`serialize_batch_at_interval`——**专为 HashJoin 宽键多列拼键设计**（间隔式写入）；
- **比较/哈希**：`compare_at`（含 `nan_direction_hint` 排序语义）、`fnv_hash`/`crc32_hash`/`xxh3_hash` 各带 `_selective` 变体——**shuffle 与 join 哈希刻意不同**（分布均匀性 vs 桶局部性的取舍）；
- `upgrade_if_overflow()`：BinaryColumn→LargeBinaryColumn 溢出升级。

派生类经 `ColumnFactory<Base, Derived>` CRTP 生成 visitor 分发（`accept(ColumnVisitor*)`）。

### Chunk（`column/chunk.h`，715 行）

`Columns _columns + SchemaPtr _schema + SlotHashMap _slot_id_to_index` 三元组合，外加 `ChunkExtraData`（扩展槽，如 Stream MV 的 `_op_` 隐藏列）和 `MissingColumnProvider`（Parquet 懒物化回调）。**过滤语义是 eager 的**：`Chunk::filter(selection, force)`（chunk.cpp:362）先 `SIMD::all_ones` 短路，再逐列 `column->filter(selection)` 物理压缩——当前 HEAD 已无 sel_vector 成员；选择向量只剩局部形式（hash 函数的 `uint16_t* sel` 参数，供 OLAP scan late materialization）。保留负数 slot id 常量（`HASH_JOIN_SPILL_HASH_SLOT_ID = -1` 等）挂中间结果。

### NullableColumn：组合而非位内联

`_data_column + _null_column(FixedLengthColumn<uint8_t>) + bool _has_null`（`nullable_column.h`）。null 是**独立 UInt8 列**，可直接参与 SIMD filter/gather；`_has_null` 标志让 `is_null` 在全非空时 O(1) 短路；`wrap_if_necessary` 把非空列包成 nullable。另有 `adaptive_nullable_column`（未物化 null 时 materialized_nullable）。

### 双端生成的函数注册表

**注册宏不存在手写调用**：`gensrc/script/functions.py` 的 `vectorized_functions` 表（fid→名字、返回/参数类型、BE 符号如 `"MathFunctions::abs_double"`），由 `gensrc/script/gen_functions.py` 双端生成——FE 侧 `VectorizedBuiltinFunctions.java`（FunctionSet 注册），BE 侧 `gen_cpp/opcode/<Module>.inc`（逐条 `BuiltinFunctions::emplace_builtin_function(fid, "abs", ...)`，被 `math_functions.cpp:1693`、`string_functions.cpp:5514` 等 `#include` 进构造）。实现侧惯用宏：`DEFINE_VECTORIZED_FN(NAME)`（function_helper.h:107）、`DEFINE_MATH_UNARY_FN` 等模板宏，底层由 `VectorizedStrictBinaryFunction<Impl>::evaluate<LTYPE,RTYPE,RESULT_TYPE>`（binary_function.h）做逐类型模板分发。

### SIMD 落点

- **filter/gather/expand**：`be/src/base/simd/`（filter.h、selector.h、expand、gather、rle_simd）；`FixedLengthColumnBase::filter_range`（fixed_length_column_base.cpp:184）调 `SIMD::Filter::filter_range`；AVX2/AVX-512 经 target attribute 局部启用（delta_decode.h:59 注释）；
- **字符串函数**：`string_functions.cpp:1978` 起 lower/upper 用 `_mm_loadu_si128` + `_mm_set1_epi8` 批量大小写翻转；`binary_column.cpp:952` 比较/拷贝按 256-bit 批处理；
- **like/时间/聚合**：`like_predicate.cpp`、`time_functions.cpp`、`agg/nullable_aggregate.h`、`function_helper.cpp` 均有 `_mm_*` 内联。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| COW | `common/cow.h` + `Column` | 共享读、clone 写 |
| CRTP + Visitor | `ColumnFactory<Base, Derived>` + `accept(ColumnVisitor*)` | 静态分发避免动态 cast |
| 注册表（代码生成） | `gensrc/script/functions.py` → 双端生成 | FE fid 与 BE 符号永不漂移 |
| 模板分发 | `VectorizedStrictBinaryFunction<Impl>::evaluate<...>` | 逐类型实例化铺开 SIMD 通道 |

## 模块间交互

- 被所有 BE 模块依赖：[09 Pipeline](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/09-pipeline) 的算子接口直接以 `ChunkPtr` 为单位；[05 Connector](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/05-connector) 的 parquet/orc reader 产出 Column；[11 存储](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/11-storage) 的 segment 读出也转成 Column。
- FE 侧的函数签名/类型经 thrift `TFunction`/`TTypeDesc` 传入，与 `LogicalType` 对齐。

## 扩展方式

**新增一个内建向量化函数**：① `gensrc/script/functions.py` 的 `vectorized_functions` 加一行（fid 按 `{module}{group}{sub}` 编码规则分配，如 10130=round）；② `be/src/exprs/<module>_functions.h/.cpp` 实现 `fn_impl`（用 `DEFINE_VECTORIZED_FN`/Unary 模板宏）；③ 无需手写注册——重跑 `gen_functions.py` 生成 BE `.inc` 与 FE `VectorizedBuiltinFunctions.java`；有可变状态再加 `prepare/close` 静态方法写进表第 8/9 列。

**待核实**：`common/function-registry/`（gen_functions.py:47 注释提到的新统一函数目录）在本仓库不存在，疑似迁移中；COW 优化生产默认值未核实。
