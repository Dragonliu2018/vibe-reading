---
title: "对齐 Repeat 节点输出槽位与 pre-repeat 表达式的顺序"
source:
  project: "Doris"
  type: "PR"
  id: "32662"
  url: "https://github.com/apache/doris/pull/32662"
  prType: "fix"
date: "2026-07-31T10:00:00+08:00"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "Nereids", "Repeat", "GROUPING SETS", "物化视图"]
description: "Nereids 翻译 PhysicalRepeat 时输出槽位顺序与 pre-repeat 表达式顺序不一致，BE 按位置映射列时类型错配触发核心转储；修复让两者统一以 grouping set 表达式优先排列。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#32662](https://github.com/apache/doris/pull/32662) · **Issue** - · **commit** [d6ddd7ae](https://github.com/apache/doris/commit/d6ddd7ae7a2a5bad3dc0433aa831703db22414d0) · **首发版本** 2.0.11 · **变更行数** +61 / −13 行 · **合并时间** 2024-03-26

---

## 背景

`GROUPING SETS` / `CUBE` / `ROLLUP` 这类多维聚合查询在 Doris 里由 **Repeat 算子**承担：它把一行输入展开成多行输出，每行对应一个 grouping set，并在不属于该 set 的列上填 NULL、追加一列 `grouping_id`。这条路径在 Nereids 优化器里被翻译成 `PhysicalRepeat` → `RepeatNode`，再下发到 BE 的 `RepeatOperatorX` 执行。

PR #32662 修复的是这条路径上的一个 **BE 核心转储（core dump）**。触发场景很有代表性：**带物化视图改写**的 `GROUPING SETS` 查询。作者在 PR 描述里给出的崩溃调用栈（自顶向下为从内到外）：

```text title="BE 崩溃调用栈（PR 描述）"
assert_cast failure (LogMessageFatal)                  // 类型断言失败
ColumnVector::insert_range_from      (column_vector.cpp:349)
ColumnNullable::insert_range_from    (column_nullable.cpp:282)
RepeatLocalState::get_repeated_block (repeat_operator.cpp:154)
RepeatOperatorX::pull                (repeat_operator.cpp:226)
```

栈顶的 `assert_cast` 失败说明：BE 在把某一列数据 `insert_range_from` 进输出 block 时，**源列与目标列的类型对不上**。这并非真的遇到了脏数据——根因在 FE 下发给 BE 的两个列表**顺序不一致**：`preRepeatExprs`（决定中间 block 的列顺序）与 `outputSlots`（决定输出 tuple 的列顺序）没有对齐。BE 按位置一一映射列时，第 `i` 个 pre-repeat 列被塞进了第 `i` 个类型不同的输出槽，类型断言随之崩溃。

一句话定性：**这是一个 FE 翻译阶段的顺序契约（ordering contract）被破坏导致的执行期崩溃**，修复只需让两个列表采用同一种排列顺序。

---

## 前置知识

理解这个 bug 需要先弄清 Repeat 算子的 FE→BE 数据契约，尤其是「按位置映射」这一隐式约定。

### Repeat 算子在做什么

BE 源码 `repeat_operator.cpp` 的注释给出了一个最小例子：

```text title="repeat_operator.cpp 中的算子语义示例"
select tc1,tc2,sum(tc3) from t1 group by grouping sets((tc1),(tc2));
insert into t1 values(1,2,1),(1,3,1),(2,1,1),(3,1,1);
slot_id_set_list = [[0],[1]],  repeat_id_idx = 0,
child_block  1,2,1 | 1,3,1 | 2,1,1 | 3,1,1
output_block 1,null,1,1 | 1,null,1,1 | 2,null,1,1 | 3,null,1,1
```

输入列是 `(tc1, tc2, tc3)`，输出列是 `(tc1, tc2, tc3, grouping_id)`。对 grouping set `(tc1)`（`repeat_id_idx=0`），`tc2` 被置 NULL，`tc1`/`tc3` 原样保留，末列填 `grouping_id`。关键在于：**输出列的前若干列与输入列一一对应，靠位置对齐**。

### 两个列表与一条隐式契约

FE 在 `PhysicalPlanTranslator.visitPhysicalRepeat` 里会产出两个核心结构：

| FE 侧结构 | 经 thrift 下发到 BE | 决定什么 |
| --- | --- | --- |
| `preRepeatExprs`（pre-repeat 表达式） | `repeat_node.exprs` → `_expr_ctxs` | `push` 阶段在中间 block 里**生成列的顺序** |
| `outputSlots`（输出槽位） | `output_tuple_id` → `_output_slots` | 输出 tuple 的**列顺序** |

BE 的 `RepeatOperatorX::push` 按 `_expr_ctxs` 顺序逐个求值、插入中间 block；随后 `get_repeated_block` 把中间 block 的列搬进输出 block，其核心循环（`repeat_operator.cpp`）如下：

```cpp title="repeat_operator.cpp — get_repeated_block 的按位置映射"
size_t cur_col = 0;
for (size_t i = 0; i < input_column_size; i++) {
    const ColumnWithTypeAndName& src_column = input_block->get_by_position(i);  // preRepeatExprs[i]
    const auto slot_id = p._output_slots[cur_col]->id();                         // outputSlots[i]
    const bool is_repeat_slot = p._all_slot_ids.contains(slot_id);
    const bool is_set_null_slot = !p._slot_id_set_list[repeat_id_idx].contains(slot_id);
    if (is_repeat_slot) {
        auto* nullable_column = assert_cast<ColumnNullable*>(output_columns[cur_col].get());
        if (is_set_null_slot) {
            nullable_column->insert_many_defaults(row_size);          // 该 set 不含此列，全填 NULL
        } else if (!src_column.type->is_nullable()) {
            nullable_column->get_nested_column().insert_range_from(  // 非空源 → 嵌套列，类型须匹配
                    *src_column.column, 0, row_size);
            nullable_column->push_false_to_nullmap(row_size);
        } else {
            nullable_column->insert_range_from(*src_column.column, 0, row_size);  // ← 崩溃栈命中此路径
        }
    } else {
        output_columns[cur_col]->insert_range_from(*src_column.column, 0, row_size);
    }
    cur_col++;  // 始终 i 与 cur_col 同步，这就是「按位置映射」
}
```

这里 `input_block->get_by_position(i)` 取的是 `preRepeatExprs[i]` 的求值结果，而 `output_columns[cur_col]`（`cur_col == i`）对应的是 `outputSlots[i]`。**BE 假定两个列表在同一位置 `i` 上指向同一个逻辑列。** 这就是那条隐式契约：`preRepeatExprs` 与 `outputSlots` 必须顺序一致。一旦不一致，`insert_range_from` 会在类型不匹配时触发 `assert_cast` 失败，进程 core dump。

---

## 实现

修复只动了 `PhysicalPlanTranslator.visitPhysicalRepeat` 一个方法，但它把「顺序契约」从一个隐式假设变成了显式保证。

### 修复前：两个列表各排各的

```java title="PhysicalPlanTranslator.java — 修复前"
Set<Expression> usedSlotInRepeat = ImmutableSet.<Expression>builder()
        .addAll(flattenGroupingSetExprs)
        .addAll(aggregateFunctionUsedSlots)
        .build();

List<Expr> preRepeatExprs = usedSlotInRepeat.stream()
        .map(expr -> ExpressionTranslator.translate(expr, context))
        .collect(ImmutableList.toImmutableList());

List<Slot> outputSlots = repeat.getOutputExpressions()
        .stream()
        .map(NamedExpression::toSlot)
        .collect(ImmutableList.toImmutableList());
```

`preRepeatExprs` 由一个 `ImmutableSet` 串起两类表达式——grouping set 表达式 `flattenGroupingSetExprs` 和聚合函数用到的槽位 `aggregateFunctionUsedSlots`——再翻译成 `Expr`。`outputSlots` 则直接遍历 `repeat.getOutputExpressions()` 取槽位。问题在于：**两者排列表達式的依据不同**。`ImmutableSet` 的迭代顺序按插入顺序（grouping set 表达式在前），而 `getOutputExpressions()` 的自然顺序会把聚合函数相关的输出槽穿插进来，两个顺序并不一致。

结果就是前置知识里那条契约被打破：在某个位置 `i` 上，`preRepeatExprs[i]` 可能是一个 grouping set 列（可空 / 字符串），而 `outputSlots[i]` 是一个聚合函数输入槽（非空 / 数值），BE 按位置做 `insert_range_from` 时类型对不上，`assert_cast` 直接 core dump。

### 修复后：统一成「grouping set 表达式优先」

```java title="PhysicalPlanTranslator.java — 修复后"
// keep flattenGroupingSetExprs comes first
List<Expr> preRepeatExprs = Stream.concat(
                flattenGroupingSetExprs.stream(), aggregateFunctionUsedSlots.stream())
        .map(expr -> ExpressionTranslator.translate(expr, context))
        .collect(ImmutableList.toImmutableList());

// outputSlots's order need same with preRepeatExprs
List<Slot> outputSlots = Stream.concat(
                repeat.getOutputExpressions().stream().filter(output -> flattenGroupingSetExprs.contains(output)),
                repeat.getOutputExpressions().stream().filter(output -> !flattenGroupingSetExprs.contains(output)))
        .map(NamedExpression::toSlot)
        .collect(ImmutableList.toImmutableList());
```

改动只有两处，但思路一致：**让两个列表按同一种规则排序**，grouping set 表达式一律在前，其余在后。

- `preRepeatExprs`：用 `Stream.concat(flattenGroupingSetExprs, aggregateFunctionUsedSlots)` 显式拼接，注释点明 `keep flattenGroupingSetExprs comes first`。语义上和修复前的 `ImmutableSet.builder().addAll(...).addAll(...)` 一致，但用 `List` 固定顺序、去掉了 `Set` 带来的歧义。
- `outputSlots`：不再直接用 `getOutputExpressions()` 的自然顺序，而是用两次 `filter` 把它重排成「**属于 `flattenGroupingSetExprs` 的在前，不属于的在后**」，注释写明 `outputSlots's order need same with preRepeatExprs`。

修复后两个列表在同一组划分下（grouping set 表达式 / 其余）各自保持自己的元素顺序，但**组与组之间的先后被强行对齐**：`preRepeatExprs` 的 grouping-set 段对应 `outputSlots` 的 grouping-set 段，`preRepeatExprs` 的聚合段对应 `outputSlots` 的聚合段。位置 `i` 两侧终于指向同一个逻辑列，BE 的 `assert_cast` 不再炸。

> 这是一处典型的「**修复在 FE，崩溃在 BE**」的 bug：真正的类型断言发生在 BE 的向量化执行引擎里，但根因是 FE 下发了两个不自洽的列表。修 BE 没用，必须修 FE 的顺序契约。

---

## 测试

### 回归测试

PR 附带了一个回归测试 `test_dup_mv_repeat`，位于 `regression-test/suites/mv_p0/test_dup_mv_repeat/`。它精确复现了崩溃场景：建一张 duplicate 表，建一个按 `dt,s` 分组的物化视图，再用 `GROUPING SETS((s))` 配合 `sum(n) / count(DISTINCT dt)` 去查——这种写法会被物化视图改写命中、并走到 Repeat 路径。

```groovy title="test_dup_mv_repeat.groovy"
sql """
        CREATE TABLE `db1` (
        `dt` date NULL,
        `s` varchar(128) NULL,
        `n` bigint NULL
        ) ENGINE=OLAP
        DUPLICATE KEY(`dt`)
        DISTRIBUTED BY HASH(`dt`) BUCKETS 1
        PROPERTIES ( "replication_allocation" = "tag.location.default: 1",
                     "storage_format" = "V2" );
    """

sql "insert into db1 values('2020-01-01','abc',123),('2020-01-02','def',456);"

createMV ("create materialized view dbviwe as select dt,s,sum(n) as n from db1 group by dt,s;")

explain {
    sql("SELECT s AS s, sum(n) / count(DISTINCT dt) AS n FROM db1 GROUP BY GROUPING SETS((s)) order by 1;")
    contains "(dbviwe)"
}
qt_select_mv "SELECT s AS s, sum(n) / count(DISTINCT dt) AS n FROM db1 GROUP BY GROUPING SETS((s)) order by 1;"
```

测试做了两件断言：

- **`explain ... contains "(dbviwe)"`**：确认该查询被物化视图 `dbviwe` 改写命中。这是触发 bug 的前提——不走 MV 改写、不走到 Repeat 节点就不会崩。
- **`qt_select_mv`**：对比查询结果文件，期望输出 `abc 123.0` / `def 456.0`。修复前这一步直接 BE core dump，根本拿不到结果。

```text title="test_dup_mv_repeat.out"
-- !select_mv --
abc	123.0
def	456.0
```

这个用例的价值在于它把「MV 改写 + `GROUPING SETS` + 聚合函数」三者凑齐，正好踩中 `outputSlots` 与 `preRepeatExprs` 顺序分叉的组合，是一份防回归的最小复现。

---

## 意义与影响

这个 bug 的影响面其实不小：**凡是用 Nereids 优化器执行 `GROUPING SETS` / `CUBE` / `ROLLUP`、且查询输出槽位顺序恰好与 pre-repeat 表达式顺序分叉的查询，都可能 BE 崩溃**。叠加物化视图改写后，触发概率进一步上升——MV 改写会改变 `getOutputExpressions()` 的构成与排列，正好把这个顺序分叉暴露出来。对线上集群而言，这是一类「查询本身合法、却直接打挂 BE」的高危问题。

修复的价值在于：

1. **把隐式契约显式化**。两个列表的顺序一致性原本只是 BE 的一个未声明的假设，修复后 FE 用 `Stream.concat` + 两次 `filter` 把「grouping set 表达式优先」写成了双方的共同规则，并在注释里点明。这类 bug 以后再难出现。
2. **修在正确的层**。崩溃在 BE 的向量化 `insert_range_from`，但根因在 FE 翻译；作者没有去 BE 加防御性的类型兼容判断，而是直接修正 FE 下发的顺序，符合「谁破坏契约谁修」的思路，也避免了 BE 为 FE 的错误买单带来的额外开销。
3. **附回归测试**。`test_dup_mv_repeat` 锁住了「MV 改写 + `GROUPING SETS`」这条触发路径，后续任何改动 Repeat 翻译或 MV 改写的 PR 都会被这道闸拦下。

版本层面，PR 于 2024-03-26 合入 master，随后通过 backport PR [#34803](https://github.com/apache/doris/pull/34803) 进入 2.0.x 线，首发于 **2.0.11**；master 线则随 **3.0.0-rc04** 发版。仍在 2.0.x 早版本上跑 `GROUPING SETS` + 物化视图的集群，建议升级到 2.0.11 及以上以规避此崩溃。
