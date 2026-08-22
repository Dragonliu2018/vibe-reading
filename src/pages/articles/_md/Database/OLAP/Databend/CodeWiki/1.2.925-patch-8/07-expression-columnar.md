---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "表达式与列式内核"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "列式存储", "DataType", "enum dispatch"]
description: "Databend 表达式与列式内核——全仓 fan-in 最高模块，enum dispatch 零开销 + 向量化 kernel + 表达式求值。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

表达式与列式内核模块（`src/query/expression/` ~65k 行 + `src/common/column/` ~11k 行 + `src/query/datavalues/`）是 Databend 的**数据结构基础**。它是全仓被 import 最多的模块（7187 次），定义了所有模块共享的 `DataType`/`Column`/`DataBlock`/`Expression`/`Evaluator` 核心类型。几乎所有编译、执行、存储路径都依赖它的列式数据表示。它的核心设计是 **enum dispatch**——用 enum 替代 trait object 实现零开销虚函数，配合 `with_number_type!` 宏在编译时展开类型分支。

## 模块架构

模块由四个核心抽象构成：`DataType`（类型系统）、`Column`/`Scalar`/`ColumnBuilder`（列式值）、`DataBlock`/`BlockEntry`（列容器）、`Expr`/`Evaluator`（表达式树求值）。

```
DataType (类型枚举) ─→ Column/Scalar/ColumnBuilder (列式值)
                              ↓
                    DataBlock/BlockEntry (列容器，Const 优化)
                              ↑
Expr (表达式树) ─→ Evaluator::run (递归求值) ─→ kernels (向量化)
```

## 调用链路

```
Evaluator::run(expr)                        [evaluator.rs:150]
└── match Expr { ... }
    └── Expr::FunctionCall(call) → eval_common_call()  [evaluator.rs:277]
        ├── partial_run() 递归求值参数 → Vec<Value<AnyType>>
        ├── 构建 EvalContext
        └── function.eval.as_scalar().eval(&args, &mut ctx) → Value
```

数据类型变化：`Expr`（表达式树）→ 递归求值参数为 `Value<AnyType>`（`Scalar` 或 `Column` 二选一）→ 函数 `eval` 产出 `Value` → 组装为 `BlockEntry` → `DataBlock`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Evaluator::run` | 表达式树求值入口 | `partial_run` 递归 |
| `type_check::check` | RawExpr→Expr 类型检查 | `check_function` 重载选择 |
| `ConstantFolder` | 常量折叠 | Domain 传播优化 |
| `FilterVisitor` | 向量化过滤 | selectivity-aware 迭代策略 |

</details>

## 核心实现

### DataType 枚举与 enum dispatch

`DataType`（`types.rs`）是类型系统的核心枚举，通过 enum dispatch 实现零开销多态——编译时 `with_number_type!` 宏展开类型分支，避免运行时 trait object 的虚函数开销：

```rust title="types.rs"
pub enum DataType {
    Boolean, Null,
    Number(NumberDataType),  // UInt8/16/32/64, Int8.., Float32/64
    String, Binary, Bitmap,
    Decimal(DecimalDataType),
    Timestamp, Date, Interval,
    Nullable(Box<DataType>),
    Array(Box<DataType>), Map(Box<DataType>),
    Tuple(Vec<DataType>),
    Variant,                 // JSON
    Geometry(GeometryDataType),
    Vector(u64),             // 向量检索
    Generic(usize),
}
```

`ValueType`/`AccessType`/`ReturnType`/`ArgType` trait 层次为每种类型定义列访问方式。类型系统覆盖 number/decimal/string/nullable/array/map/tuple/variant/vector/bitmap/date/timestamp/geometry 等。

### Column / Scalar / Value

`Value<T>`（`values.rs`）是 `Scalar`（标量单值）或 `Column`（列批量）的二选一枚举，这使函数同时支持标量和列式求值：

```rust title="values.rs"
pub enum Value<T: ValueType> {
    Scalar(Scalar),    // 标量单值
    Column(Column),    // 列批量值
}
pub enum Column {
    Boolean(Bitmap),
    Nullable { column: Box<Column>, validity: Bitmap },
    Number(NumberColumn),
    String(StringColumn),
    // ...
}
```

`ColumnBuilder` 负责列的增量构建。`Scalar`/`ScalarRef` 是标量值的表示。

### DataBlock 与 BlockEntry::Const 传播优化

`DataBlock`（`block.rs:49`）是列容器，`BlockEntry` 有 `Const` 和 `Column` 两个变体——当 `Evaluator` 对 `Expr::Constant` 求值返回 `Value::Scalar` 时自动选 `Const` 变体，后续 kernel（如 filter）遇到 `Value::Scalar` 直接短路，不遍历整个列。`convert_to_full()` 仅在需要物理展开时（如写 parquet）才展开为完整 Column。

```rust title="block.rs"
pub struct DataBlock {
    pub entries: Vec<BlockEntry>,
    pub num_rows: usize,
    pub meta: Option<BlockMetaInfoPtr>,
}
pub enum BlockEntry {
    Const(Scalar, DataType, usize),  // 标量+类型+行数
    Column(Column),
}
```

### Expr 表达式树与 Evaluator

`Expr`（`expression.rs`）是求值前的表达式树，含 `ColumnRef`/`Literal`/`FunctionCall`/`Cast`/`Lambda` 等变体。`RawExpr` 是类型检查前、`Expr` 是类型检查后（携带类型信息）。`RemoteExpr` 用于跨节点序列化。

`Evaluator::run`（`evaluator.rs:150`）递归遍历 `Expr` 树求值。`EvalContext`（`function.rs:176`）持有 `validity`（外层 nullable 有效位图）和 `errors: Option<(MutableBitmap, String)>`（逐行错误收集）——函数可在特定行报错（如除零），错误记录在位图中而非直接 panic，`render_error()` 最终聚合抛出，实现行级错误隔离。`is_not_error` 函数设 `suppress_error=true` 收集错误。

### 向量化 Kernel

`kernels/` 实现核心向量化操作：`filter.rs`（`FilterVisitor` + `IterationStrategy` selectivity-aware 选择最优迭代）、`sort.rs`/`sort_compare.rs`（排序与排列重排）、`take.rs`（索引重排，多个变体 take_index/take_chunks/take_compact/take_ranges）、`group_by.rs`/`group_by_hash.rs`（哈希聚合）、`scatter.rs`（数据分散）、`topk.rs`（Top-K）、`concat.rs`（块拼接）。

kernel 通过 `ValueVisitor` 模式对每种列类型做特化处理。`filter` kernel 根据 selectivity（选择率）选择迭代策略——高选择率用 bitmap 迭代，低选择率用 index 迭代。

### 常量折叠与 Domain

`ConstantFolder`（`constant_folder.rs`）利用 `Domain`（值域）信息做常量消除优化——每个函数注册时提供 `calc_domain` 闭包从输入列 Domain 推导输出 Domain，优化器用此做 `WHERE x > 5` 的恒真/恒假判断。`FunctionDomain` 三态：`Full`（全集）/`Domain(d)`（特定域）/`MayThrow`。

### Lambda 批量优化

`run_lambda`（`evaluator.rs:1942`）对 `array_map`/`array_filter` 做**批量优化**：当参数只有一列 Array 类型时，直接提取内部 Column 和 offsets，构造包含所有元素的临时 DataBlock，一次性对全部行求值 lambda，而非逐行循环——将 N 个数组 M 个元素的总求值从 O(N*M) 次 Evaluator 调用降为 1 次。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| enum dispatch | `types.rs` DataType/Column | 替代 trait object，零开销虚函数，编译期展开 |
| Value 二选一 | `values.rs` Scalar/Column | 函数同时支持标量与列式求值 |
| BlockEntry::Const 传播 | `block.rs:56` | 标量短路优化，避免展开整列 |
| 行级错误隔离 | `function.rs` EvalContext.errors | 逐行错误位图，非 panic |
| Domain 推导 | `property.rs` calc_domain | 服务优化器常量折叠与谓词下推 |
| Visitor 模式 | `expr` 的 `ExprVisitor` + kernel 的 `ValueVisitor` | 类型特化遍历 |

**为什么用 enum dispatch 而非 trait object**：Rust 的 `dyn Trait` 有虚函数开销，而 enum 的 match 分支在编译期可被优化器内联（零开销）。配合 `with_number_type!` 宏在编译时为每种数值类型生成特化代码，CPU 缓存友好。代价是枚举变体增多时代码膨胀，但对数据库内核的性能至关重要。

## 模块间交互

`databend-common-expression` 依赖 `databend-common-column`（底层列存储 binary/binview/bitmap/buffer）、`databend-datavalues`（遗留兼容层，`DataValue` 已被 `Scalar` 取代）。被几乎所有模块依赖——pipeline（DataBlock 流动）、storages/fuse（TableSchema/DataBlock）、sql（ScalarExpr/类型检查）、functions（Function trait 定义在此）、optimizer（统计推导）。

## 扩展方式

**新增一种 DataType**：在 `types.rs` 的 `DataType` 枚举添加变体 → 在 `types/` 新建类型实现 `ValueType`/`AccessType` 等 trait → 更新 `Column`/`Scalar`/`ColumnBuilder` 枚举 → 在 `type_check.rs` 的类型推断添加规则 → 更新相关 kernel 的 `ValueVisitor` 分支。

**新增一个 kernel**：在 `kernels/` 新建文件，用 `ValueVisitor` 模式对每种列类型特化处理 → 在 `Evaluator` 或 transform 中调用。
