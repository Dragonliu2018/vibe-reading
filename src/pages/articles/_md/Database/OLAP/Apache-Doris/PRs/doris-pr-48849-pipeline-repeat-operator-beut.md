---
title: "为 pipeline RepeatOperator 补齐 BE 单元测试"
source:
  project: "Doris"
  type: "PR"
  id: "48849"
  url: "https://github.com/apache/doris/pull/48849"
  prType: "refactor"
date: "2026-08-11T16:56:24+08:00"
category: [Database, OLAP, "Apache Doris", PRs]
tags: ["Apache Doris", "C++", "Pipeline", "BE", "单元测试", "Grouping Sets"]
description: "为 pipeline RepeatOperator 补齐 BE 单元测试，并重构算子使其可测试——统一 pull() 控制流、用 ColumnNullable 高层 API 替代手动 null_map 操作。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#48849](https://github.com/apache/doris/pull/48849) · **Issue** - · **commit** [24de884](https://github.com/apache/doris/commit/24de884d4ded2725c26ce98918e126aaf86a7b96) · **首发版本** 4.0.0-rc01 · **变更行数** +402 行 · **合并时间** 2025-03-11

---

## 背景

**RepeatOperator** 是 Doris pipeline 执行引擎中实现 `GROUP BY GROUPING SETS` / `CUBE` / `ROLLUP` 的算子。这类多维分组聚合在 OLAP 场景下极为常见——一条 `GROUPING SETS` 查询会同时计算多个分组维度的聚合结果，执行引擎需要把每个输入行"展开"成多行，每行对应一个分组集，非该分组集的列置 NULL，并追加 `grouping_id` 虚拟列以区分。

然而在 PR #48849 之前，这个算子**没有任何 BE（Backend）层单元测试**。它的正确性完全依赖端到端回归测试覆盖——回归测试能验证"整条 SQL 跑对了"，但一旦结果出错，很难定位是 RepeatOperator 的展开逻辑问题、还是上下游算子的问题。算子内部的 `null` 填充、`grouping_id` 追加、`_repeat_id_idx` 状态机推进等关键逻辑，缺少可直接断言的细粒度测试。

PR #48849 由 **Mryange** 提交，标题 `[test](beut) add pipeline RepeatOperator beut`，核心动作有二：

1. 新增 `be/test/pipeline/operator/repeat_operator_test.cpp`（341 行），覆盖三种典型场景；
2. 对 `repeat_operator.cpp` / `.h` 及两个公共头做**可测试性重构**——让算子能在不构造完整 `TPlanNode` / `DescriptorTbl` 的前提下被单测直接组装和驱动。

> PR body 使用的是默认模板（`Issue Number: close #xxx` 未填写），没有文字描述动机。下文的设计意图均从实际 diff 与本地源码上下文推断。

下图标注了 RepeatOperator 在 pipeline 中的数据流与本次 PR 的 6 处改动位置。整体被黄色虚线框圈出的 `RepeatOperatorX` 表示改动集中在此算子；数据流主线为 `push`（求值 expr 缓存到 `_intermediate_block`）→ `pull` 按 `_repeat_id_idx` 状态机逐次展开，分 expr / no-expr 两路填充列与 `grouping_id`，汇合输出一组分组集 Block 给下游聚合算子。

![RepeatOperator 数据流与 PR 改动位置](/vibe-reading/images/articles/doris-pr-48849-pipeline-repeat-operator-beut/architecture.svg)

黄框 ④⑤ 是数据流节点上的**行为变更**：`get_repeated_block` 改用 `ColumnNullable` 高层 API（④），`pull` 的 no-expr 分支从 `for` 循环改为与 expr 路径一致的 `_repeat_id_idx` 状态机（⑤）。①②③⑥ 是配套的可测试性重构（默认构造、`init` 校验、移除 `_output_tuple_desc`、成员精简 + `MOCK_REMOVE`），本身不改变数据流行为，但让算子可在单测中直接组装驱动。下文「实现」节按此顺序逐项展开。

---

## 前置知识

### GROUPING SETS 的展开语义

以代码注释中的例子说明：

```sql title="代码注释中的样例查询"
SELECT tc1, tc2, sum(tc3) FROM t1 GROUP BY GROUPING SETS ((tc1), (tc2));
-- 数据：insert into t1 values (1,2,1),(1,3,1),(2,1,1),(3,1,1);
```

`GROUPING SETS ((tc1), (tc2))` 有 2 个分组集，因此每个输入行要被展开成 **2 行**：第一行保留 `tc1`、将 `tc2` 置 NULL；第二行将 `tc1` 置 NULL、保留 `tc2`。同时追加 `grouping_id` 列标识当前行属于哪个分组集。RepeatOperator 就是干这件事的：**输入一个 Block，输出 `_repeat_id_list_size` 个 Block**，每个输出 Block 对应一个分组集。

### pipeline 的 push/pull 模型

RepeatOperator 继承自 `StatefulOperatorX<RepeatLocalState>`，是有状态的算子，对外暴露三个核心方法：

| 方法 | 职责 |
|---|---|
| `push(state, input_block, eos)` | 缓存输入：对输入 Block 求值 expr，写入 `_intermediate_block` |
| `need_more_input_data(state)` | 背压控制：`_child_block` 为空且未 eos 时返回 true，表示还需要更多输入 |
| `pull(state, output_block, eos)` | 产出输出：按 `_repeat_id_idx` 逐次产出重复块 |

`_repeat_id_idx` 是 `RepeatLocalState` 的核心状态变量，记录"当前输入行已经展开到第几个分组集"。它从 0 递增到 `_repeat_id_list_size`，到顶后清空缓存并归零——这就是下文反复提到的**状态机**。

---

## 实现

改动涉及 5 个文件，其中 4 个是生产代码（可测试性重构），1 个是新增测试：

| 文件 | 改动 | 性质 |
|---|---|---|
| `be/src/pipeline/exec/repeat_operator.cpp` | +54 −46 | 重构 |
| `be/src/pipeline/exec/repeat_operator.h` | +5 −3 | 重构 |
| `be/src/runtime/descriptors.h` | +1 −1 | 可测试性 |
| `be/src/vec/utils/util.hpp` | +1 −1 | 清理 |
| `be/test/pipeline/operator/repeat_operator_test.cpp` | +341 | 新增测试 |

> 注：PR 合并时路径为 `be/src/pipeline/exec/`，后续 Doris 主干将 pipeline 算子迁移到了 `be/src/exec/operator/`。本文代码片段取自 PR diff（改动前后对比），文字描述参考本地仓库当前源码。

### 为可测试性重构生产代码

#### 1. 默认构造函数：让算子可直接 new 出来

生产环境的 `RepeatOperatorX` 构造函数需要 `ObjectPool`、`TPlanNode`、`DescriptorTbl` 三件套——这些在单测里构造成本极高。PR 在头文件中新增了一个 `#ifdef BE_TEST` 守卫的默认构造函数：

```cpp title="be/src/pipeline/exec/repeat_operator.h — 默认构造函数"
#ifdef BE_TEST
    RepeatOperatorX() = default;
#endif
```

`BE_TEST` 宏只在编译测试目标时定义，生产二进制中该构造函数不存在，零开销。测试因此可以直接 `std::make_unique<RepeatOperatorX>()`，再手工填充成员变量来驱动算子。

#### 2. `_repeat_id_list` 向量 → `_repeat_id_list_size` 标量

原实现持有完整的 `_repeat_id_list`（`std::vector<int64_t>`），但通读全文件后发现**只有 `.size()` 被用过**——列表里的具体 `int64_t` 值从未被读取（`grouping_id` 实际取自 `_grouping_list`）。PR 把它收敛成一个标量：

```cpp title="be/src/pipeline/exec/repeat_operator.h — 成员精简"
-    std::vector<int64_t> _repeat_id_list;
+    int64_t _repeat_id_list_size;
```

构造函数相应改为 `_repeat_id_list_size(tnode.repeat_node.repeat_id_list.size())`。这既是"删除死字段"的清理，也让测试只需设一个整数而非构造 vector。

#### 3. 移除 `_output_tuple_desc` 成员

原 `RepeatOperatorX` 持有 `const TupleDescriptor* _output_tuple_desc`，在 `prepare` 中赋值，但唯一的使用点是 `add_grouping_id_column` 里的三个 `DCHECK`：

```cpp title="改动前 — add_grouping_id_column 中的 DCHECK 依赖 _output_tuple_desc"
DCHECK_LT(slot_idx, p._output_tuple_desc->slots().size());
const SlotDescriptor* _virtual_slot_desc = p._output_tuple_desc->slots()[cur_col];
DCHECK_EQ(_virtual_slot_desc->type().type, p._output_slots[cur_col]->type().type);
DCHECK_EQ(_virtual_slot_desc->col_name(), p._output_slots[cur_col]->col_name());
```

这些断言拿 `_output_tuple_desc` 和 `_output_slots` 做交叉校验，语义上纯属防御性检查。问题是：测试无法轻易构造真实的 `TupleDescriptor`，这个成员成了测试的拦路虎。PR 的处理很干脆——`prepare` 改用局部变量 `output_tuple_desc`（不再存为成员），三个 `DCHECK` 替换为对 `_output_slots.size()` 的单一断言：

```cpp title="改动后 — 用 _output_slots 替代 _output_tuple_desc"
-    _output_tuple_desc = state->desc_tbl().get_tuple_descriptor(_output_tuple_id);
-    if (_output_tuple_desc == nullptr) {
+    const auto* output_tuple_desc = state->desc_tbl().get_tuple_descriptor(_output_tuple_id);
+    if (output_tuple_desc == nullptr) {
         return Status::InternalError("Failed to get tuple descriptor.");
     }
-    RETURN_IF_ERROR(vectorized::VExpr::prepare(_expr_ctxs, state, _child->row_desc()));
-    for (const auto& slot_desc : _output_tuple_desc->slots()) {
+    for (const auto& slot_desc : output_tuple_desc->slots()) {
         _output_slots.push_back(slot_desc);
     }
+    RETURN_IF_ERROR(vectorized::VExpr::prepare(_expr_ctxs, state, _child->row_desc()));
```

注意这里还调整了顺序：**先收集 `_output_slots`，再 `VExpr::prepare`**。原顺序是先 prepare exprs 再收集 slots，调整后逻辑更清晰（先就位描述符，再准备表达式），也让 `_output_slots` 在 expr prepare 前已可用。同时 `_output_slots` 去掉了多余的 `mutable` 限定——它在 `prepare` 之后不再被修改，`mutable` 本就是多余的。

#### 4. `MOCK_REMOVE(const)`：在测试下去掉 `const` 以便赋值

`test_with_expr2` 用例需要手工设置 slot 的 id 和 nullable 属性（`op->_output_slots[0]->_id = 0;`）。但 `SlotDescriptor::_id` 声明为 `const SlotId _id`，`const` 成员无法赋值。PR 的解法是引入一个已有的测试宏 `MOCK_REMOVE`：

```cpp title="be/src/runtime/descriptors.h — 去掉 _id 的 const"
-    const SlotId _id;
+    MOCK_REMOVE(const) SlotId _id;
```

`MOCK_REMOVE` 定义在 `be/src/common/be_mock_util.h`，是一个条件宏——编译测试时（`BE_TEST` 定义）展开为空，`_id` 变成可赋值的普通成员；生产编译时展开为 `const`，行为不变：

```cpp title="be/src/common/be_mock_util.h — MOCK_REMOVE 定义"
#ifdef BE_TEST
#define MOCK_REMOVE(str)
#else
#define MOCK_REMOVE(str) str
#endif
```

这是一个干净的可测试性模式：用宏在测试编译单元里"摘掉" `const`，生产零影响。`mock_descriptors.h` 里的 `MockRowDescriptor` / `MockTupleDescriptor` 也是同思路——绕过真实 `DescriptorTbl` 构造链，直接 `pool->add(new SlotDescriptor())` 并设置 `_type`。

#### 5. `get_repeated_block`：用高层 API 替代手动 null_map 操作

这是重构里语义最清晰的一块。原实现直接操作 `ColumnNullable` 的 `null_map` 内存：

```cpp title="改动前 — 手动操作 null_map"
auto* nullable_column = reinterpret_cast<vectorized::ColumnNullable*>(columns[cur_col].get());
auto& null_map = nullable_column->get_null_map_data();
auto* column_ptr = columns[cur_col].get();
if (is_set_null_slot) {
    nullable_column->resize(row_size);
    memset(nullable_column->get_null_map_data().data(), 1,
           sizeof(vectorized::UInt8) * row_size);   // 全置 NULL
} else {
    if (!src_column.type->is_nullable()) {
        for (size_t j = 0; j < row_size; ++j) null_map.push_back(0);  // 逐个 push 0
        column_ptr = &nullable_column->get_nested_column();
    }
    column_ptr->insert_range_from(*src_column.column, 0, row_size);
}
```

问题：`reinterpret_cast` 无类型检查、`memset` 直接写裸内存、`for` 循环逐个 `push_back(0)` 低效且易错。PR 改用 `ColumnNullable` 的高层方法 + 带类型检查的 `assert_cast`：

```cpp title="改动后 — ColumnNullable 高层 API + assert_cast"
auto* nullable_column = assert_cast<vectorized::ColumnNullable*>(output_columns[cur_col].get());
if (is_set_null_slot) {
    nullable_column->insert_many_defaults(row_size);              // 全置 NULL（默认值即 null）
} else {
    if (!src_column.type->is_nullable()) {
        nullable_column->insert_range_from_not_nullable(*src_column.column, 0, row_size);
    } else {
        nullable_column->insert_range_from(*src_column.column, 0, row_size);
    }
}
```

三个分支的语义：

| 场景 | 旧实现 | 新实现 |
|---|---|---|
| 该 slot 置 NULL | `resize` + `memset` null_map 全 1 | `insert_many_defaults(row_size)` |
| 源列非 nullable、保留 | 循环 `push_back(0)` + `insert_range_from` | `insert_range_from_not_nullable(...)` |
| 源列 nullable、保留 | `insert_range_from` | `insert_range_from(...)`（保留原 null_map） |

`insert_range_from_not_nullable` 是 `ColumnNullable` 专用于"从非 nullable 源插入"的方法，隐式把 null_map 置 0；`insert_many_defaults` 插入 `row_size` 个默认值（nullable 列的默认值即 NULL）。两者都比手写 `memset` / `push_back` 循环更安全、更声明式。`assert_cast`（替代 `reinterpret_cast`）在 debug 构建下会校验类型，类型不匹配直接断言失败，避免UB。

#### 6. `pull()` else 分支控制流统一（核心改动）

这是本 PR **最实质的行为变更**。`pull()` 内部按 `_intermediate_block` 是否有数据分两路：

- **expr 路径**（`_intermediate_block.rows() > 0`）：调用 `get_repeated_block`，一次产出一组分组集，`_repeat_id_idx++`，到顶清空归零；
- **no-expr 路径**（`else if _expr_ctxs.empty()`）：没有 expr 时，输出 Block 只有 `grouping_id` 列，无需走 `get_repeated_block`。

问题在 no-expr 路径。重构前，它用一个 `for` 循环**一次性遍历所有 `repeat_id_idx`**，把全部分组集的 `grouping_id` 一次性塞进输出 Block：

```cpp title="改动前 — no-expr 路径一次性产出全部分组集"
for (int repeat_id_idx = 0; repeat_id_idx < _repeat_id_list.size(); repeat_id_idx++) {
    std::size_t cur_col = 0;
    RETURN_IF_ERROR(
            local_state.add_grouping_id_column(rows, cur_col, columns, repeat_id_idx));
}
_child_block.clear_column_data(_child->row_desc().num_materialized_slots());
```

这意味着 expr 路径和 no-expr 路径的**控制流完全不同**：前者一次 pull 一组（多次 pull 才耗尽一组输入），后者一次 pull 全部组。两路对 `_repeat_id_idx` 的使用方式不一致，`need_more_input_data` / `eos` 的时序也因此不同——这正是单测难以精确断言的原因。

重构后，no-expr 路径被改成与 expr 路径**共享同一个 `_repeat_id_idx` 状态机**：

```cpp title="改动后 — no-expr 路径对齐为逐次递增"
std::size_t cur_col = 0;
RETURN_IF_ERROR(
        local_state.add_grouping_id_column(rows, cur_col, columns, _repeat_id_idx));
_repeat_id_idx++;

if (_repeat_id_idx >= _repeat_id_list_size) {
    _intermediate_block->clear();
    _child_block.clear_column_data(_child->row_desc().num_materialized_slots());
    _repeat_id_idx = 0;
}
```

![pull() 控制流：no-expr 路径对齐 expr 路径](/vibe-reading/images/articles/doris-pr-48849-pipeline-repeat-operator-beut/pull-flow-unify.svg)

上图左右对比了重构前后的 `pull()` 控制流。左侧（粉）no-expr 路径用 `for` 循环一次性产出全部分组集，与 expr 路径（蓝）的逐次递增不一致；右侧（青）no-expr 路径改为 `add_grouping_id_column(idx)` + `idx++` + 到顶清空归零，与 expr 路径完全同构。底部黄色框标注了统一的 `_repeat_id_idx` 状态机：0 → 1 → … → `_repeat_id_list_size` → 归零。重构后一次 `pull` 恒产出一组分组集，输出 Block 行数均匀，`need_more_input_data` 的恢复时机也可被单测精确断言——`test_without_expr` 正是断言"两次 pull 各产 4 行、第三次 `need_more_input_data` 恢复 true"。

> 这一处改动使得 no-expr 路径的输出块大小从"一次 N×R 行"变为"每次 R 行、共 N 次"，最终结果集不变，但块粒度更均匀，利于下游算子的流水线与内存预估。`eos` 判定 `_child_eos && _child_block.rows() == 0` 仍只在 `_repeat_id_idx` 归零、`_child_block` 被清空后才为 true，语义保持。

#### 7. `init()` 增加 `grouping_list` 长度校验

顺带在 `init()` 中加了一道防御性校验——每个 `grouping_list` 子向量的长度不得小于 `_repeat_id_list_size`，否则 `add_grouping_id_column` 里 `_grouping_list[slot_idx][repeat_id_idx]` 会越界：

```cpp title="be/src/pipeline/exec/repeat_operator.cpp — init 校验"
for (const auto& slot_idx : _grouping_list) {
    if (slot_idx.size() < _repeat_id_list_size) {
        return Status::InternalError(
                "grouping_list size {} is less than repeat_id_list size {}", slot_idx.size(),
                _repeat_id_list_size);
    }
}
```

把原本可能触发的 `DCHECK` 越界（仅 debug 生效）前移为 `init` 阶段的显式报错（release 也生效）。

#### 8. `util.hpp`：`build_mutable_mem_reuse_block` 参数 `const` 化

```cpp title="be/src/vec/utils/util.hpp — slots 参数 const 化"
 static MutableBlock build_mutable_mem_reuse_block(Block* block,
-                                                  std::vector<SlotDescriptor*>& slots) {
+                                                  const std::vector<SlotDescriptor*>& slots) {
```

该方法不修改 `slots`，加 `const` 是常规清理，同时便于绑定到持有 `const` 引用的调用方。

### 测试基础设施

新增测试文件并不"从零造轮子"，而是复用了 Doris 已有的 mock 工具链：

| 工具 | 路径 | 作用 |
|---|---|---|
| `MockOperatorX` | `be/src/pipeline/exec/mock_operator.h` | mock 源算子，从 `_outout_blocks` 队列吐数据 |
| `MockRuntimeState` | `be/test/testutil/mock/mock_runtime_state.h` | mock `RuntimeState`，免去 `FragmentMgr` / `QueryContext` 重型依赖 |
| `MockRowDescriptor` / `MockTupleDescriptor` | `be/test/testutil/mock/mock_descriptors.h` | 用 `DataTypePtr` 列表直接构造任意 slot 类型组合 |
| `MockSlotRef` | `be/test/testutil/mock/mock_slot_ref.h` | mock `VSlotRef` 表达式，`execute` 直接返回指定 column_id |
| `ColumnHelper` | `be/test/testutil/column_helper.h` | 构造预期 Block 并做 `block_equal` 断言 |

测试夹具 `RepeatOperatorTest` 在 `SetUp` 中组装算子：`op->_child = mock_op`、`state->batsh_size = 10`（`batsh_size` 是当时 `MockRuntimeState` 的公开字段，后已重命名为 `_batch_size`）。`set_output_slots` 通过 `MockRowDescriptor` 按给定 `DataTypes` 构造一组 `SlotDescriptor` 塞进 `op->_output_slots`；`create_local_state` 手工 `init` + `open` 一个 `RepeatLocalState` 并注册到 `state`。

```cpp title="be/test/pipeline/operator/repeat_operator_test.cpp — 测试夹具"
struct RepeatOperatorTest : public ::testing::Test {
    void SetUp() override {
        op = std::make_unique<RepeatOperatorX>();   // BE_TEST 默认构造函数
        mock_op = std::make_shared<MockOperatorX>();
        state = std::make_shared<MockRuntimeState>();
        state->batsh_size = 10;
        op->_child = mock_op;
    }
    void set_output_slots(DataTypes output_types) {
        output_desc = std::make_shared<MockRowDescriptor>(output_types, &pool);
        op->_output_slots = output_desc->tuple_descriptors()[0]->slots();
    }
    // ...
};
```

正是前述 4 个生产文件的可测试性重构（默认构造、移除 `_output_tuple_desc`、`MOCK_REMOVE(const)`、`_repeat_id_list_size` 标量化），让这个夹具能如此精简——无需 `TPlanNode`、无需 `DescriptorTbl`、无需 FE 介入。

### 三个测试用例

| 用例 | 场景 | 输入 | 验证点 |
|---|---|---|---|
| `test_without_expr` | 无 expr，仅 grouping_id | 1 列输入 × 4 行，`repeat_id_list_size=2`，3 个 grouping_id 列 | 2 次 pull 各产 4 行（值分别取 `grouping_list` 的两列），耗尽后 `need_more_input_data` 恢复 true |
| `test_with_expr` | 有 expr，slot 全保留 | 2 列输入经 expr 投影 + 3 个 grouping_id = 5 列输出，`_slot_id_set_list` 全包含 | expr 列原样透传，grouping_id 按 `repeat_id_idx` 取值 |
| `test_with_expr2` | 有 expr + nullable + 部分 slot 置 NULL | 3 列输入（含一列原 nullable 且含 NULL），`_slot_id_set_list[0]={1,2}` 使 slot 0 在第一组置 NULL | 验证 `is_set_null_slot` 分支：第一组 slot 0 全 NULL、其余保留；第二组 slot 0 保留原值（含原有 NULL） |

`test_with_expr2` 是覆盖最全面的用例——它同时触及：源列本身有 NULL（`{100,200,300,400}` 的 null_map `{false,false,false,true}`）、目标列 nullable、`is_set_null_slot` 为 true（全置 NULL）与 false（保留源列）两种分支。用例在注释里画出了预期输出表，再用 `ColumnHelper::block_equal` 逐列断言。

```cpp title="be/test/pipeline/operator/repeat_operator_test.cpp — test_with_expr2 的 NULL 断言（节选）"
// 第一组：slot 0 不在 _slot_id_set_list[0]={1,2} 中 → is_set_null_slot=true → 全 NULL
EXPECT_TRUE(ColumnHelper::block_equal(
        block, Block {
                       ColumnHelper::create_nullable_column_with_name<DataTypeInt64>(
                               {1, 2, 3, 4}, {true, true, true, true}),   // 全 NULL
                       ColumnHelper::create_nullable_column_with_name<DataTypeInt64>(
                               {10, 20, 30, 40}, {false, false, false, false}),
                       ColumnHelper::create_nullable_column_with_name<DataTypeInt64>(
                               {100, 200, 300, 400}, {false, false, false, true}),  // 保留原 NULL
                       ColumnHelper::create_column_with_name<DataTypeInt64>({1, 1, 1, 1}),
                       ColumnHelper::create_column_with_name<DataTypeInt64>({3, 3, 3, 3}),
                       ColumnHelper::create_column_with_name<DataTypeInt64>({5, 5, 5, 5}),
               }));
```

---

## 测试

### 单元测试

三个用例构成对 `get_repeated_block` / `add_grouping_id_column` / `pull` 状态机的逐层覆盖：

- **`test_without_expr`** 走 `pull()` 的 **else 分支**（`_expr_ctxs.empty()`），直接验证重构后的 no-expr 状态机：`repeat_id_list_size=2` → 恰好 2 次 pull，每次产出 4 行（输入行数），第 3 次调用 `need_more_input_data` 恢复 true。这恰好断言了"一次 pull 恒产出一组"的新行为——若用旧版的 for 循环实现，第一次 pull 就会产出 8 行，断言会失败。
- **`test_with_expr`** 走 `pull()` 的 **if 分支**（`_intermediate_block.rows() > 0`），验证 expr 投影列原样透传 + grouping_id 追加，且 `_slot_id_set_list` 全包含时无 NULL 填充。
- **`test_with_expr2`** 同样走 if 分支，但激活 `is_set_null_slot` 的 NULL 填充分支与源列 nullable 的 `insert_range_from` 分支，是 `get_repeated_block` 内三个条件分支的完整覆盖。

三个用例都遵循同一断言范式：构造预期 `Block`（用 `ColumnHelper::create_column_with_name` / `create_nullable_column_with_name`），与实际输出做 `block_equal` 逐列比较，并对每次 pull 前后的 `need_more_input_data` 状态做断言——把 `_repeat_id_idx` 状态机的推进时序也纳入了测试边界。

---

## 意义与影响

**填补测试空白**。RepeatOperator 此前是 pipeline 算子中少数没有 BE 单测覆盖的算子之一。三个用例把 `null` 填充、`grouping_id` 追加、`_repeat_id_idx` 状态机推进等关键逻辑纳入了可断言的细粒度测试，未来改动该算子时有了快速回归兜底，无需依赖整条 SQL 的端到端验证。

**重构提升正确性与可读性**。`get_repeated_block` 用 `insert_many_defaults` / `insert_range_from_not_nullable` 替代手写 `memset` + `push_back` 循环，消除了裸内存操作和 `reinterpret_cast` 的 UB 风险；`assert_cast` 在 debug 下提供类型校验。`init()` 的 `grouping_list` 长度校验把潜在越界从 debug-only 的 `DCHECK` 前移为 release 生效的显式报错。

**统一 `pull()` 控制流**。这是附带的最有价值改动——expr 与 no-expr 两路从此共用同一个 `_repeat_id_idx` 状态机，一次 pull 恒产出一组分组集。输出块粒度更均匀，`need_more_input_data` / `eos` 的时序在两路间一致，既利于下游流水线，也让算子行为可被单测精确断言（`test_without_expr` 直接依赖这一性质）。

**`MOCK_REMOVE` 可复用模式**。用条件宏在测试编译单元里"摘掉" `const`、生产零影响的可测试性手法，可推广到其他需要 mutable slot 的算子单测——`SlotDescriptor::_id` 不是唯一一个被 `const` 拦住测试的场景。

---

## 参考

- [SQL 标准 `GROUPING SETS` / `CUBE` / `ROLLUP` 语义](https://en.wikipedia.org/wiki/SQL_syntax#GROUP_BY) — 多维分组聚合的 SQL 标准定义，RepeatOperator 的展开逻辑即为其向量化实现
- [Apache Doris 官方文档 — Grouping Sets](https://doris.apache.org/docs/sql-manual/sql-statements/Select-Statements/grouping-sets/) — Doris 中 `GROUPING SETS` 的用法与 `grouping_id` 函数说明
