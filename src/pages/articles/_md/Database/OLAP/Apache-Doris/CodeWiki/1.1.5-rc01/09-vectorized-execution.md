---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "向量化执行"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "vec", "Block", "IColumn", "COW", "CRTP", "IFunction", "ClickHouse"]
description: "Doris 1.1.5 向量化执行 vec：源自 ClickHouse 的自包含列式栈（Block/IColumn COW/DataType/VExpr/IFunction 三层/IAggregateFunction CRTP），21 个 V*Node，enable_vectorized_engine 默认开启。2.x 起统一向量化。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

`be/src/vec/`（~7.0 万行）是 1.1.5 的**向量化执行子系统**，源自 ClickHouse 集成，是自包含的列式栈：`columns/`（列实现）、`core/`（Block/Field）、`data_types/`（类型）、`functions/`（标量函数）、`aggregate_functions/`（聚合函数）、`exprs/`（VExpr）、`exec/`（向量化算子 V*Node）、`common/`（COW/PODArray/Arena）。它是 2.x 统一向量化的前身，与 legacy `exec/`+`exprs/` 行式路径双轨并存，由 `enable_vectorized_engine`（默认 true）选择。

## 模块架构

```
Block (vec/core/block.h:57) ── 列式批数据单元
   ├─ Container data (ColumnsWithTypeAndName)
   ├─ IndexByName (phmap::flat_hash_map<String,size_t>)
   └─ filter_block (block.cpp:664) / materialize_block_inplace (materialize_block.h)
       │
       ▼  列
IColumn (vec/columns/column.h) ── 抽象基类, COW<IColumn> CRTP
   ├─ COW (vec/common/cow.h) ── intrusive ref_count, 共享不可变写时复制
   ├─ ColumnVector<T> (column_vector.h) ── PaddedPODArray, SIMD 友好连续内存
   ├─ ColumnNullable (column_nullable.h) ── null_map + nested_column
   ├─ ColumnConst (column_const.h) ── 单值常量列
   ├─ ColumnString (column_string.h) ── offsets + chars 变长
   └─ ColumnDictionary (column_dictionary.h) ── 字典编码列 (scan 下推)
       │
       ▼  类型
IDataType (vec/data_types/data_type.h) ── 抽象基类 + WhichDataType
   └─ DataTypeFactory (data_type_factory.hpp) ── 单例
       │
       ▼  表达式
VExpr (vec/exprs/vexpr.h:73) ── 向量化表达式基类
   ├─ execute(VExprContext*, Block*, int* result_column_id) ── 返回列索引(非单值)
   ├─ VSlotRef (vslot_ref.h) ── execute 直接返回 block 中已有列 id
   ├─ VectorizedFnCall (vectorized_fn_call.h) ── execute: block 末尾 append 结果列 → _function->execute
   └─ VExprContext (vexpr_context.h) ── filter_block / execute
       │
       ▼  函数
IFunction 三层 (vec/functions/function.h):
   ├─ IFunctionBase ── 知道签名 (get_return_type/get_arg_types)
   ├─ IPreparedFunction ── 绑定参数类型后 prepare (返回 PreparedFunctionImpl)
   └─ PreparedFunctionImpl ── execute_impl (实际执行)
   + SimpleFunctionFactory (simple_function_factory.h) ── 单例, 注册 40+ 普通函数
       │
       ▼  聚合
IAggregateFunction 三层 CRTP (vec/aggregate_functions/aggregate_function.h):
   ├─ IAggregateFunction ── 接口
   ├─ IAggregateFunctionHelper<Derived> ── CRTP 中层
   └─ IAggregateFunctionDataHelper<Derived,T> ── CRTP + Data 模板
   + AggregateFunctionSimpleFactory (aggregate_function_simple_factory.h) ── 单例
       │
       ▼  算子 (vec/exec/, 21 个 V*Node)
VOlapScanNode (volap_scan_node.h) extends OlapScanNode ── Block 调度 + _free_blocks 内存复用
AggregationNode (vaggregation_node.h) ── AggregatedDataVariants + executor std::function + streaming preagg
HashJoinNode (join/vhash_join_node.h) ── HashTableVariants + JoinOpVariants + friend ProcessHashTableBuild/Probe
VSortNode (vsort_node.h) ── SortCursorImpl + priority_queue 归并
VAnalyticEvalNode (vanalytic_eval_node.h) ── pull + _buffered_block + _partition_cur/_end 游标窗口帧
VExchangeNode/VCrossJoinNode/VUnionNode/VIntersectNode/VExceptNode/VSelectNode/VRepeatNode...
```

## 调用链路

```
ExecNode::create_node (exec/exec_node.cpp:343) ── 工厂
  → 每 case if (state->enable_vectorized_exec()) → new vec::V*Node (否则 legacy 节点)
    (RuntimeState::enable_vectorized_exec in runtime_state.h:338 读 enable_vectorized_engine)

PlanFragmentExecutor::open_vectorized_internal (plan_fragment_executor.cpp:352)
  → _plan->open (ExecNode::open 递归)
  → while: _plan->get_next(state, block, &done)  ── 向量化 get_next(Block) 重载
      VOlapScanNode::get_next → VOlapScanner::get_block (volap_scanner.cpp)
        → BlockReader::next_block_with_aggregation  ── 读 olap 列存
        → VExprContext::filter_block (vexpr_context) ── 谓词过滤列
      AggregationNode::get_next → child get_next(Block) → executor (hash agg/streaming preagg)
      HashJoinNode::get_next → ProcessHashTableBuild/Probe
      → VExprContext::execute (vexpr.h) → _function->execute(Block, size_t)
      → _sink->send(block)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `VExpr.execute` | 求值 | 返回列索引 result_column_id，批量 |
| `VSlotRef.execute` | 列引用 | 直接返回 block 已有列 id，零拷贝 |
| `VectorizedFnCall.execute` | 函数调用 | append 结果列后调 `_function->execute` |
| `IFunction.execute` | 标量函数 | 三层架构，绑定参数后复用 PreparedFunction |
| `IColumn` 多态 | 列操作 | COW 共享不可变，写时复制 |
| `VOlapScanNode.get_next` | scan | `_free_blocks` Block 内存复用 |
| `AggregationNode` | 聚合 | AggregatedDataVariants + streaming preagg |

</details>

## 核心实现

### 向量化按 Block 列存

`Block`（`vec/core/block.h:57`）含 `ColumnsWithTypeAndName`，列式连续内存。算子间传递 Block，`VExpr::execute` 返回 `result_column_id`（列索引）而非单值。**为什么**：分析查询只读所需列减少 I/O；列连续内存 SIMD 友好；每批（2048/4096 行）一次虚函数分派而非每行；`IColumn` 多态 + COW 共享不可变写时复制避免深拷贝。

### 源自 ClickHouse

`vec/` 子目录（columns/common/core/data_types/functions/aggregate_functions/exec/exprs）几乎对应 ClickHouse 核心模块，Doris 直接集成成熟列式栈而非自研，缩短向量化落地周期。`COW<Derived>`（`vec/common/cow.h`）intrusive ref_count、`PaddedPODArray` SIMD 友好、`Arena` 内存池、`StringRef` 均来自 ClickHouse。

### IColumn COW 多态

`IColumn`（`vec/columns/column.h`）经 `COW<IColumn>` CRTP 实现引用计数 + 写时复制——`ColumnPtr` 是 `shared_ptr`，多算子读同一列零拷贝，写时 `mutate()` 复制。子类：`ColumnVector<T>`（`PaddedPODArray` 连续内存）、`ColumnNullable`（null_map+nested）、`ColumnConst`（单值）、`ColumnString`（offsets+chars）、`ColumnDictionary`（字典编码，scan 下推用）。

### IFunction / IAggregateFunction 三层 CRTP

`IFunction`（`vec/functions/function.h`）三层：`IFunctionBase`（知签名）、`IPreparedFunction`（绑定参数类型后 `prepare` 返回 `PreparedFunctionImpl`）、`PreparedFunctionImpl`（`execute_impl`）。**为什么**：绑定参数类型后编译期特化，消除运行时类型分发；`SimpleFunctionFactory` 单例按名查找。`IAggregateFunction` 三层 CRTP（`IAggregateFunction`→`IAggregateFunctionHelper<Derived>`→`IAggregateFunctionDataHelper<Derived,T>`）编译期消除虚函数，向量化热路径零成本抽象。

### 双轨切换

`enable_vectorized_engine`（`SessionVariable.java:169`，默认 true，`:426`）经 `VectorizedUtil.isVectorized()` 在 `Coordinator.java:316` 写入 `TQueryOptions` 下发 BE。`ExecNode::create_node`（`exec_node.cpp:343`）工厂每 case `if (state->enable_vectorized_exec())` 二选一。`vec/exec/` 共 21 个 V*Node，覆盖 `create_node` 白名单 17 种 `TPlanNodeType`——`MERGE_NODE`/`BROKER_SCAN_NODE`/`ES_SCAN_NODE` 无向量化实现，走 legacy。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略（IColumn 多态） | `vec/columns/column.h` 各 Column 子类 | 不同列类型可互换，Block 持 IColumn |
| CRTP 静态多态 | `IFunction`/`IAggregateFunction` in `function.h`、`aggregate_function.h` | 编译期消除虚函数，热路径零成本 |
| COW | `vec/common/cow.h`、`ColumnPtr` | 列数据共享不可变，写时复制 |
| 模板 | `DataType` 模板、`ColumnVector<T>` | 类型参数化 |
| 工厂 | `SimpleFunctionFactory`/`AggregateFunctionSimpleFactory` 单例 | 按名注册/查找函数 |
| 模板方法 | `ExecNode` 双 `get_next` 重载 | legacy/向量化共用基类接口 |

## 模块间交互

被 `ExecNode::create_node` 工厂选择实例化（`enable_vectorized_exec`）。`VOlapScanNode` 继承 `OlapScanNode` 复用 scan 逻辑，读 `olap` 存储引擎（`vec/olap/block_reader.cpp`）。依赖 `runtime`（部分共享）、`vec/common`（COW/Arena）。`V*Node` 经 `VDataStreamMgr`（`transmit_block` brpc）跨 BE 传列数据。

## 扩展方式

**新增向量化标量函数**：`vec/functions/` 新建继承 `IFunction`（`function.h`）实现 `execute_impl`/`get_return_type`；`simple_function_factory.h` 注册入口调 `register_function<MyFunc>`；FE `FunctionSet.java:73` 注册元信息。**新增向量化聚合函数**：`vec/aggregate_functions/` 新建继承 `IAggregateFunctionDataHelper<Derived,Data>`（参考 `aggregate_function_avg.h`）实现 `add/merge/serialize/deserialize/insert_result_into`；`aggregate_function_simple_factory.cpp` 注册 `register_function_xxx`。**新增向量化算子**：参考 `vanalytic_eval_node.h/cpp` 继承 `ExecNode` 实现 `get_next(Block*)`；`exec_node.cpp:361-571` `create_node` switch 加分支 + 白名单。对应测试：`be/test/vec/`、`regression-test/suites/`。
