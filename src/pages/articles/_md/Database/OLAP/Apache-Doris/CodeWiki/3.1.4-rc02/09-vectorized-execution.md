---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "向量化与函数"
date: "2026-08-23T19:04:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "向量化", "CRTP", "IFunction", "Block", "COW", "ClickHouse"]
description: "Doris 3.1.4 向量化与函数 vec：VExpr + IFunction/IAggregateFunction(CRTP) + Block/Column COW，源自 ClickHouse。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

向量化与函数模块是 `be/src/vec/`（~21.2 万行），3.1.4 中**统一**聚合了向量化执行所需的一切——表达式（`exprs/`）、标量函数（`functions/`）、聚合函数（`aggregate_functions/`）、列数据结构（`columns/`）、数据类型（`data_types/`）、执行算子（`exec/`）、Block（`core/`）。它源自 ClickHouse（`function.h` 头部明确注明 copied from ClickHouse），独立成文是因为向量化是性能基石：批处理（Block）+ SIMD 友好的列式内存布局 + CRTP 零虚函数开销，使 BE 执行引擎能榨干 CPU。3.1.x 将这些统一在 `vec/` 下（4.x 起部分拆分 `exprs/`、`exec/`），便于内联与编译期优化。

## 模块架构

```
Block (vec/core/block.h:70) ── 列式批数据单元
   ├─ Container = ColumnsWithTypeAndName (:74)
   ├─ insert / get_by_position (:103/129)
   └─ clone_empty (:221) ── 空结构复制
         │
   ▼ (算子间传递)
Pipeline Operators ── vec/exec/, vec/sink/
   │  pull Block
   ▼
VExpr (vec/exprs/vexpr.h) ── 表达式树
   ├─ execute(Block) ── 在 Block 上求值
   └─ vectorized evaluation
         │
   ▼
IFunction (vec/functions/function.h) ── 标量函数
   ├─ IPreparedFunction (:91) ── prepare 一次
   ├─ PreparedFunctionImpl (:104) ── execute per Block
   └─ get_return_type / get_name
         │
   ▼
IAggregateFunction (vec/aggregate_functions/) ── 聚合函数 (CRTP)
   ├─ add Batch / merge
   └─ insert_result_into
         │
   ▼
Column (vec/columns/) ── COW 列数据
   ├─ ColumnNullable / ColumnString / ColumnVector ...
   └─ DataType (vec/data_types/) ── 类型分发
```

## 调用链路

查询执行中向量化求值链：

```
PipelineTask.execute(&eos)
  └─ Operator.pull → 拿到 Block
  └─ VExpr.execute(block, n) (vexpr.h) ── 表达式在 Block 上求值
       └─ VFunctionExecutor / 各 VExpr 子类
            └─ IFunction → prepare (FunctionFactory 查找)
            └─ PreparedFunction.execute(context, block, args, result, rows, dry_run) (function.h:98)
                 └─ 具体函数 (CRTP 派生) ── SIMD/向量化实现
  └─ Sink.push(Block) ── 结果或中间数据
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Block.insert` (`:103`) | 加列 | 任意位置插入，列名+类型+数据 |
| `Block.clone_empty` (`:221`) | 空结构复制 | 复用 schema 不拷数据 |
| `VExpr.execute` | 表达式求值 | 在 Block 上批量计算，非逐行 |
| `IPreparedFunction.execute` (`:98`) | 函数执行 | prepare 一次后每 Block 复用 |
| `IFunction.get_return_type` | 推导返回类型 | 静态类型推导，编译期分发 |

</details>

## 核心实现

### prepare-then-execute 模式

`function.h` 的设计精髓是"prepare 一次，execute 多次"（`:88-90` 注释 "Prepare something heavy once before main execution loop instead of doing it for each block"）。`IPreparedFunction`（`:91`）是接口，`PreparedFunctionImpl`（`:104`）是基类——`execute` 是 `final`（`:107`），子类实现 `execute_impl`。`FunctionFactory` 按 `get_name()` 查找并 prepare 一次，之后每 Block 复用 prepared 对象。

设计决策：**为何 prepare/execute 分离**——函数初始化（如解析正则、建查找表）开销大，每行做浪费；prepare 一次后 execute 只跑热路径（向量化批处理+SIMD），把固定成本摊销到全表。这正是向量化数据库的核心性能模式。

### CRTP 零虚函数开销

标量函数与聚合函数用 CRTP（Curiously Recurring Template Pattern）：`IAggregateFunction<Derived, ...>` 模式让基类调用派生类方法在编译期绑定，**消除虚函数调用开销**。向量化热路径每行可能调函数，虚函数的间接跳转会破坏流水线、阻碍内联，CRTP 把多态代价移到编译期。

```cpp title="vec/functions/function.h (节选)"
class IPreparedFunction {
public:
    virtual String get_name() const = 0;
    virtual Status execute(FunctionContext* context, Block& block,
                           const ColumnNumbers& arguments, size_t result,
                           size_t input_rows_count, bool dry_run) const = 0;
};
class PreparedFunctionImpl : public IPreparedFunction {
public:
    Status execute(...) const final;  // 框架 final，调 execute_impl
    // 子类实现 execute_impl
};
```

设计决策：**为何 CRTP 而非普通虚函数**——向量化执行每秒处理千万级行，虚函数的间接调用+无法内联是性能毒药；CRTP 使编译器内联具体实现，SIMD 向量化才可能。代价是代码膨胀（每个具体类型一份实例），用模板特化控制。

### Block 与 COW 列

`Block`（`vec/core/block.h:70`）是列式批数据单元，`Container = ColumnsWithTypeAndName`（`:74`），即"列名+类型+数据"的向量。它是算子间传递的基本单位——一次处理一批行而非逐行。`Column`（`vec/columns/`）用 COW（Copy-on-Write）模式：`ColumnPtr` 是 `shared_ptr`，不可变列共享，修改时 `assume_mutable` 复制，`clone_empty`（`:221`）只复制 schema 不拷数据。

设计决策：**为何 Block 而非行**——列式批处理使 CPU cache 友好、SIMD 可向量化、减少虚函数调用次数（一列一次而非一行一次）。COW 使浅拷贝零成本，过滤/投影操作（只改列引用不改数据）几乎免费。

### 表达式向量化求值

`VExpr`（`vec/exprs/vexpr.h`）是表达式树节点，`execute(Block, n)` 在整个 Block 上批量求值而非逐行。表达式树（如 `a + b > 10`）的算子节点递归 execute，最终每个算子调 `IFunction.execute` 处理整列。这与逐行解释执行相比，把解释开销摊销到一批，是向量化数据库的核心。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| CRTP | `IAggregateFunction<Derived>`、`PreparedFunctionImpl` | 编译期多态，零虚函数开销，可内联 |
| prepare-then-execute | `IFunction` | 重初始化摊销，热路径只跑向量化 |
| COW | `Column`/`ColumnPtr` | 共享不可变列，写时复制，浅拷贝免费 |
| 批处理（Block） | `Block` | cache 友好、SIMD、解释开销摊销 |
| 工厂 | `FunctionFactory` | 按名查找 prepare，统一注册 |

## 模块间交互

`vec/` **依赖** `runtime/`（`MemTracker`、`FunctionContext`）、`olap/`（`vec/olap/` 读存储列）。**被** `pipeline/` 算子广泛调用（Source pull Block、Operator 求值、Sink push）、`exprs/` 也在 `vec/exprs/`。`vec/io/` 读写 Parquet/ORC，`vec/runtime/` 持运行时辅助。是 BE 全链路的底层数据结构与函数库。

## 扩展方式

新增一个标量函数：在 `vec/functions/` 加实现（CRTP 继承 `PreparedFunctionImpl` 或用函数注册宏），在 `FunctionFactory` 注册 `get_name`，在 FE 侧 `BuiltinScalarFunctions.java` 加元信息。新增聚合函数：在 `vec/aggregate_functions/` 加 `IAggregateFunction` 实现，注册到 `AggregateFunctionFactory`。对应测试：`be/test/vec/function/`。
