---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Types & Vector"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Vector", "LogicalType", "DataChunk"]
description: "DuckDB 类型系统与向量化数据表示——LogicalType/PhysicalType 双层类型、5 种 Vector 布局、DataChunk 批处理容器。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Types & Vector 模块（`src/common/` 核心部分）是 DuckDB 向量化执行的基础设施——定义了类型系统（`LogicalType`/`PhysicalType`）、向量化数据容器（`Vector`/`DataChunk`）、选择向量（`SelectionVector`）和批量运算框架（`VectorOperations`）。几乎所有其他模块都依赖这个模块：Execution 用 `DataChunk`/`Vector` 做向量化执行，Planner 用 `LogicalType` 做类型推导，Storage 用 `Vector` 存列数据，Function 的签名基于 `DataChunk`/`Vector`。

## 模块架构

`LogicalType` 采用双层设计：`LogicalTypeId`（SQL 语义类型，用户可见，如 `DECIMAL(18,2)`/`TIMESTAMP_TZ`/`MAP(VARCHAR, INTEGER)`）和 `PhysicalType`（内存物理布局，执行层关心，如 `INT64`/`INT128`/`LIST`/`STRUCT`）。映射通过 `LogicalType::GetInternalType()` 实现——`DECIMAL` 根据 width 选择 `INT16`/`INT32`/`INT64`/`INT128`，`VARCHAR`/`BLOB`/`BIT`/`GEOMETRY` 统一为 `VARCHAR` 物理类型（string_t 表示）。

`Vector` 支持 5 种物理布局，通过 friend struct 模式访问（不用虚函数，避免每元素虚调用开销）：

| 布局 | 场景 | 为什么不直接用 Flat |
| --- | --- | --- |
| Flat | 标准未压缩数据 | 基础布局 |
| Constant | `WHERE x = 5` 中的字面量 5 | 避免重复存储 2048 个相同值 |
| Dictionary | Low-cardinality 列、Filter 后的数据 | 避免复制，仅用 SelectionVector 引用 |
| FSST | 字符串列压缩存储 | FSST 压缩减少内存带宽 |
| Sequence | `generate_series(1, 1000000)` | 零存储，仅存 start/increment/count |

`DataChunk` 是执行引擎的中间表示，持有 `vector<Vector>`（所有 Vector 长度相同）。`VectorCache` 实现零分配 `Reset()`——构造时一次性分配好所有内存，`ResetFromCache` 将 Vector 恢复为空 FlatVector 而无需任何内存分配。

## 调用链路

### 向量数据访问

```
FlatVector::GetData<T>(vector)[i]              — 直接索引 data 指针
ConstantVector::GetData<T>(vector)[0]          — 所有行相同，只看 data[0]
DictionaryVector::Child(vec)[sel[i]]           — child[sel[i]] 间接索引
Vector::ToUnifiedFormat(count, format)         [vector.cpp:1199]
  └→ switch(VectorType):
       DICTIONARY → 拷贝 SelectionVector 到 owned_sel，零拷贝
       CONSTANT → sel = ZeroSelectionVector（所有指向 index 0），零拷贝
       FLAT/FSST/SEQUENCE → Flatten(count) 后取 data，需解压
```

### VectorOperations 批量运算

以 `VectorOperations::Equals` 为例（三层调用链）：

```
VectorOperations::Equals(left, right, result, count)              [comparison_operators.cpp:285]
  → ComparisonExecutor::Execute<Equals>(left, right, result, count)  [:216]
    └→ switch(left.InternalType()):                 — 按 PhysicalType 分发
         INT32 → TemplatedExecute<int32_t, Equals>  → BinaryExecutor
         LIST/STRUCT → NestedComparisonExecutor      — 递归嵌套类型
  → BinaryExecutor::Execute<TA,TB,TR,OP>(left, right, result, count)
    └→ 编译时特化 LEFT_CONSTANT/RIGHT_CONSTANT 4 种组合
         → ExecuteFlatLoop → Equals::Operation(left_val, right_val)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Vector::ToUnifiedFormat` | 统一格式转换 | Dict/Const 零拷贝，FSST/Seq 需 Flatten |
| `FlatVector::GetData<T>` | 获取裸数据指针 | 直接 `vector.data` 指针 |
| `DataChunk::Reset` | 重置为空 | `ResetFromCache` 零分配 |
| `DataChunk::Slice` | 切片 | 变为 Dictionary Vector，不复制数据 |
| `VectorOperations::Equals` | 批量比较 | BinaryExecutor 模板特化 4 种常量组合 |
| `BinaryExecutor::Execute` | 二元运算展开 | `__restrict` 指针 + 编译时特化 |

</details>

## 核心实现

### LogicalType vs PhysicalType 双层类型系统

`LogicalType` 保留 SQL 语义（显示格式、cast 规则、比较行为），`PhysicalType` 决定内存布局。向量化运算按 `PhysicalType` 分发（如 `ComparisonExecutor` 的 switch），因为物理类型决定了数据宽度和模板特化。如果按 `LogicalType` 分发会有大量冗余分支——`TIMESTAMP` 和 `BIGINT` 都是 `INT64` 物理类型但语义不同。`ExtraTypeInfo` 层次（通过 `shared_ptr` 共享）携带逻辑类型的附加信息：`DecimalTypeInfo`（width/scale）、`ListTypeInfo`（child type）、`StructTypeInfo`（child types）等。

### UnifiedVectorFormat 统一读取抽象

这是处理多布局的核心模式。所有运算的 executor 先调用 `ToUnifiedFormat()` 获取 `UnifiedVectorFormat`（含 `sel`/`data`/`validity`），再通过 `data[sel->get_index(i)]` 统一访问。对于 Dictionary 和 Constant 向量这是**零拷贝**操作（只复制指针和 SelectionVector）；只有 FSST 和 Sequence 需要 Flatten。这使得大部分运算无需为每种 Vector 布局编写特化版本——只需在 `ToUnifiedFormat` 中处理转换。

### SelectionVector 延迟解压

`SelectionVector` 允许 Filter 操作**不复制数据**。`Vector::Slice(other, sel, count)` 将向量变为 Dictionary Vector，buffer 持有 SelectionVector，auxiliary 持有原始向量引用。后续访问通过 `sel[i]` 间接索引。`sel_t` 通常为 `uint32_t`，`get_index(idx)` 在 `sel_vector` 为 null 时直接返回 idx（flat 模式）。

### BinaryExecutor 模板元编程

`BinaryExecutor` 通过 `LEFT_CONSTANT`/`RIGHT_CONSTANT` 模板参数在编译时生成 4 个特化版本（Flat-Flat、Constant-Flat、Flat-Constant、Constant-Constant），消除运行时 if 分支。核心循环 `ExecuteFlatLoop` 使用 `__restrict` 指针和 `ASSERT_RESTRICT` 保证无别名冲突，允许编译器充分优化。

### STANDARD_VECTOR_SIZE = 2048

选择 2048 的原因：必须是 2 的幂（SIMD 对齐要求）；2048 × 8 bytes = 16KB，刚好在 L1 cache 内（典型 L1 为 32-64KB，留空间给其他数据）。太大导致 cache miss，太小导致循环开销占比过高。编译时可通过 CMake `STANDARD_VECTOR_SIZE` 选项覆盖。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 双层类型系统 | `LogicalType` + `PhysicalType` in `types.hpp` | 语义 vs 布局解耦，执行按物理类型分发 |
| Friend Struct 多态 | `FlatVector`/`ConstantVector`/... in `vector.hpp` | 不用虚函数，避免每元素虚调用开销 |
| 统一读取抽象 | `UnifiedVectorFormat` in `vector.hpp:31` | 多布局零拷贝统一访问 |
| 对象池 | `VectorCache` in `vector_cache.cpp` | 零分配 Reset，避免执行引擎重复 malloc |
| 模板元编程 | `BinaryExecutor` in `binary_executor.hpp` | 编译时特化消除运行时分支 |

## 模块间交互

`DataChunk` 是 Pipeline 中算子间传递的标准数据单元，`PhysicalOperator::GetData()` 返回 DataChunk，`ExpressionExecutor` 通过 `Vector`/`UnifiedVectorFormat` 读取输入。Planner 用 `LogicalType::MaxLogicalType()` 做类型强制转换决策。Storage 的列数据从磁盘读入 Vector，存储格式直接构建 Dictionary Vector 或 FSST Vector 避免不必要的解压。Function 的 `scalar_function_t` 签名基于 `DataChunk`/`Vector`，函数内部循环由 `UnaryExecutor`/`BinaryExecutor` 的模板展开。

## 扩展方式

新增一种数据类型（如 JSON）：`src/include/duckdb/common/types.hpp` 的 `LogicalTypeId` 枚举添加 → `src/common/types.cpp` 的 `GetInternalType()` switch 添加映射（如 `JSON → VARCHAR`）→ `LogicalTypeIdToString`/`TransformStringToLogicalTypeId` 添加序列化 → `src/common/types/value.cpp` 的 `Value::GetValue`/`SetValue` 添加处理 → `src/function/cast/` 定义 cast 规则。如果新类型的 PhysicalType 已有（如 JSON → VARCHAR），改动量小——主要在 LogicalType 层面。

新增一种 Vector 布局（如 RLE）：`src/include/duckdb/common/enums/vector_type.hpp` 添加枚举 → 新增 `struct RLEVector`（friend of Vector）→ `ToUnifiedFormat`/`Flatten`/`GetValue` 添加处理 → 所有 executor 的 switch 检查是否需新增特化路径。通过 `ToUnifiedFormat` 抽象限制了影响范围——大部分运算只需在 `ToUnifiedFormat` 中添加转换逻辑。
