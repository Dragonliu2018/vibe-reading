---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "查询处理"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "pushdown", "Clause", "表达式树", "聚合"]
description: "ArcticDB 查询处理：Clause 管道、表达式引擎与聚合下推"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

查询处理模块（`cpp/arcticdb/processing/`，~24k 行）把用户查询**下推到段级执行**，避免把整个 symbol 的数据拉回 Python 再过滤。这层独立存在是因为"下推 vs 物化"是时序数据库的核心性能杠杆——金融场景常只需读某时间区间内满足条件的少数列，若全量物化再过滤，网络与内存成本不可接受。ArcticDB 的做法是：查询被编译成一串 `Clause`（filter/project/aggregate/sort/resample…），在段级流式执行，只产出最终结果。

## 模块架构

![查询处理 Clause 管道与表达式树](/vibe-reading/images/articles/arcticdb-internals/clause-pipeline.svg)

模块核心是 **Clause 管道** + **表达式引擎**两部分。Clause 用 `folly::Poly<IClause>` 做类型擦除多态（`clause.hpp`），每个 Clause 实现 `structure_for_processing`（把段重组成 `ProcessingUnit` 分组）与 `process`（执行算子）。内置 Clause：`FilterClause`/`ProjectClause`/`AggregationClause`/`ResampleClause`/`SortClause`/`DateRangeClause`/`RowRangeClause`/`PassthroughClause`。表达式引擎（`expression_node.hpp`）把过滤/投影条件表示成 AST——`ExpressionContext` 持有根 `ExpressionNode`，`compute()` 递归求值，子树结果按 `label_` 备忘在 `ProcessingUnit::computed_data_`（共享子树只算一次）。`ComponentManager`（`component_manager.hpp`）用 entt entity-component 系统管理处理组件生命周期。Python 侧 `QueryBuilder`（`version_store/processing.py`）是 DSL 入口，序列化成 C++ Clause。

## 调用链路

```text
lib.read("sym", query_builder=q)  → read 路径带 clauses_
  plan_query(clauses)                                   query_planner.cpp  规划 + and_filter_expression_contexts
  for clause in clauses:
      clause.structure_for_processing(ranges_and_keys)  → 分组为 ProcessingUnit
      clause.process(entity_ids)                         → 执行（filter 算 bitset / aggregate 累积）
  FilterClause:  ExpressionContext.root_->compute() → bitset → ProcessingUnit.apply_filter()
  AggregationClause:  sorted_aggregation 或 unsorted_aggregation（按是否已排序分组键分派）
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `IClause::structure_for_processing` `clause.hpp:55` | 把段重组成 ProcessingUnit 分组 | 不同 clause 需不同分组（filter 按行切片、aggregate 全集） |
| `IClause::process` `clause.hpp:67` | 执行算子，返回处理后的 entity ids | 段级流式 |
| `ExpressionContext::compute` `expression_context.hpp` | 递归求值表达式树 | 子树按 label 备忘 |
| `plan_query` `query_planner.cpp` | 规划 clause 顺序 | 多 filter 的 ExpressionContext AND 成一个图 |
| `and_filter_expression_contexts` `query_planner.cpp` | 合并多 filter 上下文 | 用于 column stats 求值 |
| `dispatch_binary` `operation_dispatch.cpp` | 按数据类型分派二元运算 | 运行时类型分发 |

## 核心实现

### Clause 类型擦除与管道

`IClause`（`clause.hpp:49`）用 `folly::Poly` 而非虚函数——因为 Clause 要存进 `vector<shared_ptr<Clause>>` 且需值语义，`Poly` 比传统继承更灵活。接口 8 个方法：两个 `structure_for_processing` 重载、`process`、`clause_info`、`set_processing_config`、`set_component_manager`、`modify_schema`、`join_schemas`。`FilterClause`（`:146`）构造时校验 AST 根是 operation（产出 bitset 而非列），否则抛 `E_INVALID_USER_ARGUMENT`。`PassthroughClause`（`:114`）用 `structure_by_row_slice` 不做处理。Clause 顺序敏感——filter 应在 groupby 前（注释 "Order matters - filter before groupby"）。

### 表达式引擎与三值统计求值

`ExpressionNode`（`expression_node.hpp`）是 AST 节点，`ExpressionNodeType` 有 `BINARY_OP`/`COLUMN`/`VALUE`/`VALUE_NAME` 等。`OperationType` 枚举（`operation_types.hpp`）含一元（ABS/NEG/ISNULL/NOT）、比较（EQ/NE/LT/LE/GT/GE）、算术（ADD/SUB/MUL/DIV）、逻辑（AND/OR/XOR）、字符串（ISIN/ISNOTIN）。运算分派在 `operation_dispatch.cpp`/`operation_dispatch_binary.hpp`。同一套比较算子结构体（`LessThanOperator` 等）有**双重重载**：`(Value, Value) → bool` 用于逐行求值，`(ValueRange<T>, scalar) → StatsComparison` 用于列统计三值求值（见[管道模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)的 column stats）。`ValueRange<T>` 持 min/max，`FlippedComparator` trait 处理操作数翻转（`5 < col` → `col > 5`）。`check_range_for_nan`/`check_time_stats_for_nat` 复用 NaN/NaT 处理。列对列比较（`col1 < col2`）走 `(ValueRange, ValueRange)` 重载，`column_absent` 区分"列不在段里"vs"在但无统计"。

### 聚合：sorted vs unsorted

`AggregationClause` 按 group key 是否已排序分派（`sorted_aggregation.cpp`/`unsorted_aggregation.cpp`）：已排序走 O(n) 单遍；未排序走 O(n log n) 哈希表。`AggregationOperator` 枚举：SUM/MEAN/MIN/MAX/FIRST/LAST/COUNT。聚合结果分区并行计算后做最终 merge。`ProcessingUnit`（`processing_unit.hpp`）持 `segments_`/`row_ranges_`/`col_ranges_`/`atom_keys_`（同长度，同 index 相关）、`bucket_`（分区）、`expression_context_`、`computed_data_`（按 label 备忘）。`ComponentManager`（`component_manager.hpp`）用 entt 管理 entity 生命周期——`get_new_entity_ids`/`add_entity`/`get_entities_and_decrement_refcount`（引用计数到 0 自动移除）。

### Python QueryBuilder DSL

`QueryBuilder`（`processing.py`）用 `__getitem__`（`q[q["price"] > 100]`）加 filter——刻意模仿 pandas 语法。`groupby`/`agg`/`resample`/`head`/`tail`/`apply`/`row_range` 各映射一个 C++ Clause（见概览功能矩阵）。`ExpressionNode` 支持 `&`/`|`/`~`/`^`/比较/`isna`/`isin`/`regex_match`。`LazyDataFrame`（`lib.read(lazy=True)`）是延迟执行变体，用 `col()` 函数引用列，`collect()` 触发。查询经 pybind 序列化成 C++ Clause 管道在存储层执行——filters 在数据离开存储前应用、只读所需列、聚合在 C++ 完成。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 类型擦除多态 | `folly::Poly<IClause>` | Clause 值语义存 vector，比虚函数灵活 |
| 解释器模式 | `ExpressionContext` AST 递归求值 | 表达式可任意嵌套 |
| 备忘录 | `computed_data_` 按 label 缓存子树 | 共享子树只算一次 |
| 策略分派 | sorted/unsorted aggregation | 按数据是否已排序选 O(n) 或 O(n log n) |
| ECS | `ComponentManager` + entt | 解耦处理组件与数据，支持并行分区 |

## 模块间交互

查询处理在读路径中被[读写管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)调度——段拉取解压后交给 Clause 管道。它依赖[列式存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/06-column-store)的 `SegmentInMemory`/`Column` 作数据载体，类型来自[核心类型](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/08-entity)。列统计求值复用[管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)的 `column_stats_filter`。Python 侧 `QueryBuilder` 经[Python 绑定](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/10-python-bindings)序列化 Clause。错误：类型不匹配抛 `SchemaException`，非法输入抛 `UserInputException`。

## 扩展方式

新增查询算子（如 window 聚合）：在 `clause.hpp`/`clause.cpp` 加 `WindowClause` struct 实现 `IClause` 接口；`operation_types.hpp` 加聚合算子枚举（如需要）；`aggregation_utils.cpp`/`sorted_aggregation.cpp`/`unsorted_aggregation.cpp` 实现算子；`processing.py` 的 `QueryBuilder` 暴露方法并序列化。注意 `structure_for_processing` 的分组策略要匹配算子语义（window 需按时间窗口分组）。对应测试 `python/tests/unit/arcticdb/version_store/test_processing.py`。
