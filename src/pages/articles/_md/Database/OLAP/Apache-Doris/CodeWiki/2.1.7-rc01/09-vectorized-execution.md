---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "向量化执行"
date: "2026-08-24T10:22:21+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.7-rc01"]
tags: ["Apache Doris", "向量化", "Block", "IColumn", "COW", "CRTP", "IFunction", "ClickHouse"]
description: "Doris 2.1.7 向量化 vec/：Block/IColumn COW + VExpr 表达式 + IFunction 函数 + IAggregateFunction CRTP 聚合，源自 ClickHouse。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.7-rc01/00-overview)

---

## 模块定位

向量化执行是 `be/src/vec/`（~21.5 万行，878 文件），是 BE 性能基石。它提供列式批处理数据结构（`Block`/`IColumn`）、表达式求值（`VExpr`）、标量函数（`IFunction`）、聚合函数（`IAggregateFunction`）的完整栈。独立成文是因为向量化是 Doris 查询性能的核心——2.1.x 将所有向量化组件统一聚合在 `vec/`（而非分散 `exprs/`/`exec/`），源自 ClickHouse 血统（代码注释 "copied from ClickHouse"）。旧 `exec/` 非向量化算子仍保留共存，`vec/exec/`（前缀 `v`）是对应向量化版本。

## 模块架构

```
Block (vec/core/block.h:70) ── 列式批数据单元
   └─ Container data  ── vector<ColumnWithTypeAndName>
   └─ IndexByName index_by_name  ── phmap hash
   │
   ▼
ColumnWithTypeAndName (vec/core/column_with_type_and_name.h)
   ├─ ColumnPtr column    ── COW<IColumn>::Ptr（不可变引用计数）
   ├─ DataTypePtr type
   └─ String name
   │
   ▼
IColumn (vec/columns/column.h:70) ── 抽象基类, extends COW<IColumn>
   ├─ ColumnVector<T> (column_vector.h:131)  ── 定长数值, PaddedPODArray<T>
   ├─ ColumnStr<T> (column_string.h:56)       ── 变长字符串, chars+offsets
   └─ ColumnNullable (column_nullable.h:62)    ── 嵌套列 + null map
   │
   ▼ 表达式
VExpr (vec/exprs/vexpr.h:66) ── 表达式树基类
   ├─ VSlotRef (vslot_ref.h:35)               ── 叶节点, 引用 Block 列
   └─ VectorizedFnCall (vectorized_fn_call.h:44) ── 函数调用, 持有 FunctionBasePtr
        └─ execute → 递归子表达式 → _function->execute
   │
   ▼ 函数
IFunction 三角色合一 (vec/functions/function.h)
   ├─ FunctionBuilderImpl (:278)   ── get_return_type + build
   ├─ IFunctionBase (:160)        ── execute → prepare → execute
   └─ PreparedFunctionImpl (:94)  ── execute_impl（子类实现）
   │
   ▼ 聚合
IAggregateFunction (vec/aggregate_functions/aggregate_function.h:73)
   └─ IAggregateFunctionHelper<Derived> (:232)  ── CRTP, add_batch 静态分发
        └─ IAggregateFunctionDataHelper<Data, Derived> (:485)
             └─ AggregateFunctionSum (aggregate_function_sum.h:77)
```

## 调用链路

表达式求值流程：

```
VExprContext::execute(Block* block, int* result_column_id) [vexpr_context.cpp:52]
  └─ _root->execute(this, block, result_column_id)
     ├─ [VSlotRef::execute] *result_column_id = _column_id  [vslot_ref.cpp]
     └─ [VectorizedFnCall::_do_execute] [vectorized_fn_call.cpp:138]
        1. for i: _children[i]->execute(context, block, &column_id)  ── 递归子表达式
        2. block->insert({nullptr, _data_type, _expr_name})  ── 插空结果列
        3. _function->execute(context->fn_context(), *block, args, ...)
           └─ PreparedFunctionImpl::execute [function.h] (final)
              ├─ default_implementation_for_nulls  ── Nullable 自动处理
              ├─ default_implementation_for_constant_arguments
              └─ execute_impl(context, block, arguments, result, ...)  ── 子类
```

聚合执行流程：

```
AggregationNode::open(state) [vec/exec/vaggregation_node.cpp:425]
  └─ while (!eos): _children[0]->get_next(state, &block, &eos)
     _executor.execute(block) [:506]
     ├─ [无 GROUP BY] _execute_without_key [:654]
     │   evaluator->execute_single_add(block, agg_data_place, arena)
     │     └─ IAggregateFunctionHelper::add_batch_single_place  ── CRTP 循环
     └─ [有 GROUP BY] _execute_with_serialized_key
         1. probe_expr_ctxs → execute → key columns
         2. 哈希 → HashMap emplace（找/建聚合槽位）
         3. evaluator->execute_batch_add → _function->add_batch  ── CRTP
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `VExprContext.execute` | 表达式求值 | 递归后序遍历，结果列存 Block |
| `VectorizedFnCall._do_execute` | 函数调用 | 先递归子表达式，再 IFunction::execute |
| `PreparedFunctionImpl.execute` | 函数分发 | final，Nullable/常量自动处理→execute_impl |
| `IAggregateFunctionHelper.add_batch` | 批量累加 | CRTP assert_cast<Derived*> 静态分发 |
| `COW.shallow_mutate` | 写时复制 | use_count>1 才 clone，否则直接用 |
| `SimpleFunctionFactory.get_function` | 函数查找 | 函数名 key，Creator 注册 |

</details>

## 核心实现

### Block/IColumn 与 COW

`Block`（`vec/core/block.h:70`）是列式批数据单元，含 `Container data`（`vector<ColumnWithTypeAndName>`）+ `IndexByName`。`IColumn`（`vec/columns/column.h:70`）继承 `COW<IColumn>`（`vec/common/cow.h:85`），实现写时复制——`Ptr`（不可变共享）与 `MutablePtr`（可变独占）。`shallow_mutate()`（`cow.h:303`）在 `use_count() > 1` 时 `clone()`，否则直接用——零拷贝共享 + 惰性复制。`Block::mem_reuse()`（`block.h:252`）检查列结构复用列内存。`ColumnVector<T>` 用 `PaddedPODArray<T>`，`ColumnStr<T>` 用 chars+offsets 两段存储。

### VExpr 表达式树与求值

`VExpr`（`vexpr.h:66`）持有子表达式列表 `_children`，`create_tree_from_thrift`（`:165`）从 Thrift 构建树。`VectorizedFnCall::_do_execute`（`vectorized_fn_call.cpp:138`）先递归 `_children[i]->execute` 求值子表达式（结果列存 Block），再调 `_function->execute`——后序遍历。`VSlotRef`（`vslot_ref.h:35`）是叶节点，`execute` 直接返回 Block 中已有列索引。`VExprContext::filter_block`（`:123`）执行 WHERE 过滤，`execute_conjuncts`（`:145`）执行多 conjunct AND。

### IFunction 三角色合一与 CRTP 聚合

`IFunction`（`vec/functions/function.h`）**多重继承**三个角色：`FunctionBuilderImpl`（`:278` 构建：get_return_type + build）、`IFunctionBase`（`:160` 执行入口）、`PreparedFunctionImpl`（`:94` 实际执行）。`execute`（`PreparedFunctionImpl`，final）按序调 `default_implementation_for_nulls`（Nullable 自动处理）→ `default_implementation_for_constant_arguments`（常量展开）→ `execute_impl`（子类实现）。

`IAggregateFunctionHelper<Derived>`（`aggregate_function.h:232`）用 CRTP：`add_batch`（`:186`）等批量方法通过 `assert_cast<const Derived*>(this)->add(...)` 转发到子类，编译期内联展开 `add`——消除内层循环虚函数开销（`batch_size` 通常 1024-4096 次）。首次虚调用定位子类 `add_batch` 后，内部循环全部静态分发（devirtualization and inlining，`:184` 注释）。`AggregateFunctionSum`（`aggregate_function_sum.h:77`）的 `add` 只一行，内联后零开销。

### 统一 vec/ 与工厂注册

`SimpleFunctionFactory`（`simple_function_factory.h:107`）和 `AggregateFunctionSimpleFactory`（`aggregate_function_simple_factory.h:52`）用工厂+注册表：函数名 key → Creator。`register_all()` 调各 `register_function_xxx`。统一在 `vec/` 而非分散——`IColumn`/`IDataType`/`Field`/`Block` 紧密耦合，分散会导致头文件循环依赖；且与旧 `exec/` 替换路径清晰（`exec/` → `vec/exec/`，前缀 `v`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| COW | `COW<IColumn>` in `vec/common/cow.h:85` | 列零拷贝共享，写时复制，避免深拷贝 |
| CRTP | `IAggregateFunctionHelper<Derived>` in `aggregate_function.h:232` | 编译期消除虚函数，热路径零成本抽象 |
| Visitor | `VExpr` 递归 in `vec/exprs/vexpr.h:66` | 表达式树后序遍历求值 |
| Strategy + 工厂 | `SimpleFunctionFactory` in `simple_function_factory.h:107` | 函数名注册分发，新增函数加 register |

## 模块间交互

`vec` 被 `pipeline` Operator 调用（`AggSinkOperatorX` 持 `AggFnEvaluator` 列表调 `add_batch`，Source 调 `insert_result_into`）、被旧 `vec/exec/` ExecNode 桥接（`AggregationNode` in `vaggregation_node.h:401` 继承 `ExecNode`）、从 `olap` 读取（`vec/olap/block_reader.cpp` + `olap_data_convertor.cpp` segment→IColumn 转换）。`Block::serialize`/`deserialize`（`block.cpp`）用于 Exchange 网络传输 + spill。

## 扩展方式

**新增一个标量函数**：在 `be/src/vec/functions/` 新建函数类继承 `IFunction`（`function.h`），实现 `static constexpr auto name`/`get_number_of_arguments`/`get_return_type_impl`/`execute_impl`（参照 `function_string.h` `FunctionStrcmp`）；在 `simple_function_factory.h` 声明 `register_function_my_func`，在 `register_all()` 调用；在 `.cpp` 实现 `factory.register_function<FunctionMyFunc>()`（参照 `plus.cpp`）。FE 侧注册函数元信息。对应测试：`be/test/vec/function/`。

**新增一个聚合函数**：定义聚合状态结构 `AggregateFunctionMyAggData<T>`（参照 `aggregate_function_sum.h`，实现 `add`/`merge`/`write`/`read`/`get`）；实现 `AggregateFunctionMyAgg extends IAggregateFunctionDataHelper<Data, Derived>`（`:485`），实现 `add`/`merge`/`serialize`/`deserialize`/`insert_result_into`；在 `aggregate_function_simple_factory.cpp` 注册 `factory.register_function_both("my_agg", creator)`（参照 `aggregate_function_sum.cpp`）。对应测试：`be/test/vec/aggregate_functions/`。
