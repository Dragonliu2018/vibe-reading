---
title: "full sort 的常量列展开与列指针缓存优化"
source:
  project: "Doris"
  type: "PR"
  id: "55317"
  url: "https://github.com/apache/doris/pull/55317"
  prType: "enhancement"
date: "2026-08-10T19:49:45+08:00"
category: [Database, "Apache Doris", PRs]
tags: ["Apache Doris", "C++", "Sort", "BE", "ColumnConst", "Performance"]
description: "解读 PR #55317：FullSorter 在 append_block 时跳过 ColumnConst 的 convert_to_full_column_if_const 物化开销，直接用 insert_many_from 逐行插入；同时为 MergeSortCursorImpl 新增 columns 缓存成员，消除 merge 阶段逐行 get_columns 的冗余调用。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#55317](https://github.com/apache/doris/pull/55317) · **Issue** - · **commit** [e7ee762](https://github.com/apache/doris/commit/e7ee762e57a1aac15d30ad572adf0fd09b041622) · **首发版本** - · **变更行数** +22 / -11 行（2 文件）· **合并时间** 2025-08-27

---

## 背景

Doris 的 `FullSorter` 是全排序算子的核心实现，负责将上游传入的数据块（Block）累积排序后输出。它在两个阶段与列对象（`IColumn`）密切交互：

1. **数据累积阶段**——`FullSorter::append_block` 将上游 Block 的各列逐列追加到内部 `unsorted_block_` 中
2. **归并输出阶段**——`MergeSorterState::_merge_sort_read_impl` 从排序后的多个 Block 中按堆归并取行，拼装成结果 Block

两个阶段各有一个性能浪费点：

**累积阶段**：`append_block` 中对每一列调用 `convert_to_full_column_if_const()` 再 `insert_range_from`。当上游传来的是 **ColumnConst**（常量列，即整列只有一个值、逻辑上展开为 N 行的虚拟列）时，`convert_to_full_column_if_const()` 会先把这个单值物化成 N 行的完整列，再拷贝到目标列——白白分配了一整列的内存只为了"展开后拷贝"。

**归并阶段**：`_merge_sort_read_impl` 中每合并一行就调用 `current->block->get_columns()[i]` 获取列指针。`get_columns()` 返回 `Columns`（`std::vector<ColumnPtr>`，即 `shared_ptr<IColumn>` 的 vector）的**按值拷贝**，逐行调用意味着每行都在构造和析构这个临时 vector。

PR [#55317](https://github.com/apache/doris/pull/55317) 由 **qzsee** 提交，针对这两个浪费点做了对应优化：累积阶段跳过常量列物化、归并阶段缓存列指针。

---

## 前置知识

### ColumnConst：常量列的虚拟表示

Doris 的列式存储中，`ColumnConst` 是一种特殊列——它内部只持有**一个值**（通过 `data` 成员指向底层列的第 0 行），但逻辑上表现为 N 行相同的列。这种设计避免了在查询中出现常量表达式时重复存储相同值。

```cpp title="be/src/vec/columns/column_const.h"
class ColumnConst final : public COWHelper<IColumn, ColumnConst> {
private:
    WrappedPtr data;  // 底层列（只取第 0 行作为值）
    size_t s;         // 逻辑行数
    // ...
public:
    ColumnPtr convert_to_full_column() const;  // 物化为完整列
    const IColumn& get_data_column() const { return *data; }
    // ...
};
```

当需要以"普通列"形式访问 ColumnConst 时，可以调用 `convert_to_full_column()`——它会将单值展开为 `s` 行的真实列。但这个操作的代价是分配内存 + 拷贝数据。

### insert_range_from vs insert_many_from

`IColumn` 提供了两种批量插入接口：

```cpp title="be/src/vec/columns/column.h"
/// 从 src 的 start 位置开始，拷贝 length 个连续行
virtual void insert_range_from(const IColumn& src, size_t start, size_t length) = 0;

/// 从 src 的 position 位置取一个值，重复插入 length 次
virtual void insert_many_from(const IColumn& src, size_t position, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        insert_from(src, position);
    }
}
```

- `insert_range_from` 拷贝的是**连续的多行**，适合普通列的批量数据复制
- `insert_many_from` 取的是**同一行**重复多次，恰好对应 ColumnConst 的语义——单值重复 N 次

`insert_many_from` 的默认实现是逐行 `insert_from` 循环，但各具体列类型可以 override 它做更高效的实现（例如直接 resize + 填充）。

---

## 实现

### 改动一：append_block 跳过常量列物化

这是本 PR 最核心的优化。`FullSorter::append_block` 负责将上游 Block 的各列追加到累积列中。

**改动前**：

```cpp title="be/src/vec/common/sort/sorter.cpp — 改动前"
//TODO: to eliminate unnecessary expansion, we need a `insert_range_from_const` for every column type.
data[i].column->assume_mutable()->insert_range_from(
        *arrival_data[i].column->convert_to_full_column_if_const(), 0, sz);
```

对**每一列**都无条件调用 `convert_to_full_column_if_const()`。如果该列是 ColumnConst，这一步会将其物化为 `sz` 行的完整列（分配内存 + 拷贝数据），然后 `insert_range_from` 再从这个物化列拷贝到目标。两次内存操作，一次物化一次拷贝。

**改动后**：

```cpp title="be/src/vec/common/sort/sorter.cpp — 改动后"
if (is_column_const(*arrival_data[i].column)) {
    data[i].column->assume_mutable()->insert_many_from(
            assert_cast<const ColumnConst*>(arrival_data[i].column.get())
                    ->get_data_column(),
            0, sz);
} else {
    data[i].column->assume_mutable()->insert_range_from(*arrival_data[i].column, 0, sz);
}
```

优化逻辑分两支：

- **常量列分支**：用 `is_column_const` 判断后，直接取 ColumnConst 内部的 `get_data_column()`（即底层单值列），以 `insert_many_from` 将第 0 行重复插入 `sz` 次。**完全跳过了物化步骤**——不需要分配 `sz` 行的临时列，不需要展开后的拷贝。旧代码的 TODO 注释（"to eliminate unnecessary expansion"）也被一并移除——这个 PR 就是它的回答。
- **普通列分支**：直接 `insert_range_from`，不再调用 `convert_to_full_column_if_const()`。对普通列来说 `convert_to_full_column_if_const()` 本来就是 no-op（直接返回自身），但省掉一次虚函数调用和引用计数操作。

### 改动二：MergeSortCursorImpl 缓存列指针

`MergeSortCursorImpl` 是归并排序的游标，在堆中排序多个已排序 Block。`reset()` 在每次加载新 Block 时被调用，准备排序所需的列指针。

**改动前**的 `reset()` 只缓存 `sort_columns`（排序列指针），其余列指针不缓存：

```cpp title="be/src/vec/core/sort_cursor.h — 改动前"
void reset() {
    sort_columns.clear();
    auto columns = block->get_columns_and_convert();  // 局部变量
    for (size_t j = 0, size = desc.size(); j < size; ++j) {
        auto& column_desc = desc[j];
        size_t column_number = ...;
        sort_columns.push_back(columns[column_number].get());
    }
    pos = 0;
    rows = block->rows();
}
```

**改动后**新增了 `ColumnRawPtrs columns` 成员，在 `reset()` 中一次性缓存**所有列**的指针：

```cpp title="be/src/vec/core/sort_cursor.h — 改动后"
struct MergeSortCursorImpl {
    // ...
    ColumnRawPtrs sort_columns;
    ColumnRawPtrs columns;  // 新增：缓存所有列指针
    // ...

    void reset() {
        sort_columns.clear();
        columns.clear();
        auto tmp_columns = block->get_columns_and_convert();
        columns.reserve(tmp_columns.size());
        for (auto col : tmp_columns) {
            columns.push_back(col.get());  // 缓存所有列
        }
        for (auto& column_desc : desc) {
            size_t column_number = ...;
            sort_columns.push_back(columns[column_number]);
        }
        pos = 0;
        rows = block->rows();
    }
};
```

`columns` 成员在游标生命周期内持续有效，供归并输出阶段直接使用。

### 改动三：merge_sort_read_impl 使用缓存列指针

`_merge_sort_read_impl` 在堆归并中逐行取数据。改动前每行都调用 `block->get_columns()[i]` 获取列指针：

```cpp title="be/src/vec/common/sort/sorter.cpp — 改动前"
for (size_t i = 0; i < num_columns; ++i)
    merged_columns[i]->insert_from(*current->block->get_columns()[i], current->pos);
```

`block->get_columns()` 返回 `Columns`（`std::vector<ColumnPtr>`，即 `shared_ptr<IColumn>` 的 vector）的按值拷贝。在归并循环中**每行**都构造+析构这个临时 vector，行数多时开销可观。

改动后直接使用改动二中缓存的 `columns` 成员：

```cpp title="be/src/vec/common/sort/sorter.cpp — 改动后"
for (size_t i = 0; i < num_columns; ++i)
    merged_columns[i]->insert_from(*current->columns[i], current->pos);
```

`current->columns[i]` 是在 `reset()` 时一次性缓存好的裸指针，零开销访问。

### 附加改动：std::move 优化构造

构造函数中 `block_` 和 `desc_` 参数改为 `std::move` 传递，避免 shared_ptr 和 SortDescription 的拷贝：

```cpp title="be/src/vec/core/sort_cursor.h — 构造函数"
MergeSortCursorImpl(std::shared_ptr<Block> block_, const SortDescription& desc_)
        : block(std::move(block_)), desc(std::move(desc_)), sort_columns_size(desc.size()) {
    reset();
}
```

这是一个独立的微优化，与核心逻辑无直接关联。

---

## 意义与影响

### 性能收益

| 场景 | 改动前 | 改动后 | 收益 |
| --- | --- | --- | --- |
| 常量列 append | 物化 N 行临时列 + 拷贝 | 直接 `insert_many_from` 逐行插入 | 跳过内存分配和数据拷贝 |
| 普通列 append | `convert_to_full_column_if_const` 虚调用 + `insert_range_from` | 直接 `insert_range_from` | 省一次虚函数调用 |
| 归并取行 | 每行构造 `Columns`（`vector<ColumnPtr>`）临时 vector | 用预缓存裸指针 | 消除逐行 vector 构造析构 |

常量列场景在查询中并不罕见——当 SQL 包含常量表达式（如 `SELECT col, 1 FROM t ORDER BY col`）时，常量 `1` 就会以 ColumnConst 形式参与排序。数据量越大、Block 行数越多，物化开销节省越明显。

### 影响范围

改动局限于 `sorter.cpp` 和 `sort_cursor.h` 两个文件，涉及 `FullSorter` 和 `MergeSortCursorImpl` 两个类。不改变排序语义、不改变 Block 结构、不改变公共 API，对上层调用方透明。PR 的 review 由 **BiteTheDDDDt** 和 **yiguolei** 完成，均投票 APPROVED。

### 后续落地

该 PR 合入 `branch-2.1`（commit `e7ee762`），随后通过 PR [#56944](https://github.com/apache/doris/pull/56944) cherry-pick 至 master 分支（commit `2cfcc0f`，2026-01-05 合并）。截至写作时，尚未有发布版本标签包含此改动。
