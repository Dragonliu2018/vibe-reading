---
title: "Set 操作 build_block 覆盖致悬空 row_num 崩溃修复"
source:
  project: "Doris"
  type: "PR"
  id: "61471"
  url: "https://github.com/apache/doris/pull/61471"
  prType: "fix"
date: "2026-08-24T22:19:55+08:00"
category: [Database, OLAP, Apache Doris, PRs]
tags: ["SetOperator", "ColumnString", "Overflow", "Coredump", "Pipeline"]
description: "Doris INTERSECT/EXCEPT 在 build 侧 String 总量超 4GB 时 coredump，根因是 4GB 阈值分段 flush 覆盖 build_block、哈希表只存行号致悬空引用。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#61471](https://github.com/apache/doris/pull/61471) · **Issue** `-` · **commit** [f28cbd3](https://github.com/apache/doris/commit/f28cbd39857117e1266ebc8f00c0d5f5413dbb1b) · **首发版本** 4.0.5 / 4.1.0 · **变更行数** +277 行 · **合并时间** 2026-03-20

---

## 背景

Doris 的集合运算（`INTERSECT` / `EXCEPT`）在 BE 侧由 `SetSinkOperatorX` 构建哈希表、`SetSourceOperatorX` 输出结果。当 build 侧 String 列的**总数据量超过 4GB** 时，查询进程直接 coredump（SIGSEGV）。这类查询在合规导出、大文本去重等场景并不罕见——单列累积到 4GB 字符串数据只需几千行 1MB 的长文本。

崩溃不是随机内存错误，而是一条清晰的**悬空引用链路**：4GB 阈值触发分段 flush，每次 flush 覆盖 `build_block`，而哈希表里只存了行号，旧行号便指向了已被销毁的数据。`sink` 的旧逻辑可概括为：

```cpp title="set_sink_operator.cpp（修复前，节选）"
constexpr static auto BUILD_BLOCK_MAX_SIZE = 4 * 1024UL * 1024UL * 1024UL; // 4GB

RETURN_IF_ERROR(local_state._mutable_block.merge(*in_block));

// 关键：4GB 阈值 OR eos 都会触发 flush
if (eos || local_state._mutable_block.allocated_bytes() >= BUILD_BLOCK_MAX_SIZE) {
    build_block = local_state._mutable_block.to_block();  // 覆盖 build_block!
    RETURN_IF_ERROR(_process_build_block(local_state, build_block, state));
    local_state._mutable_block.clear();
    if (eos) { /* 记录哈希表大小、set_ready、发送 runtime filter */ }
}
```

当 build 侧总量超过 4GB，这个 flush 会触发多次，问题随之而来：

![Set 操作 build_block 覆盖致悬空 row_num 崩溃链路](/vibe-reading/images/articles/doris-pr-61471-set-op-coredump-4g/bug-mechanism.svg)

上图自上而下是完整的崩溃链路，根因落在最顶部的紫色横幅：哈希表的 `Mapped` 只存 `uint32_t` 行号，没有 block 指针或批次偏移。`hash_table_set_build.h` 在 `lazy_emplace` 时执行的就是 `ctor(key, Mapped {k})`——`k` 是当前批次的行号，仅此而已。

1. **flush #1**（`allocated_bytes` 达 4GB）：`build_block = batch1`，哈希表存入行号 `0..N1`，随后 `_mutable_block.clear()` 继续累积。
2. **flush #2**（`eos`）：`build_block = batch2`，`batch1` 的列数据被销毁；哈希表新增行号 `0..N2`，但来自 `batch1` 的旧条目行号仍原样保留——它们现在指向了不存在的数据。
3. **输出阶段**：`SetSourceOperatorX` 只持有一份 `build_block`（即最后的 `batch2`），却用哈希表里所有行号去 `insert_from`。`batch1` 的行号 `X` 一旦超过 `batch2` 的行数，读 `src.offsets[X]` 就是越界——读到垃圾 offset，`memcpy` 到未映射内存，SIGSEGV。

换句话说，4GB 阈值本意是"防溢出"——在单列 String 达到 4GB 前先把数据落进哈希表。但它制造了更隐蔽的悬空引用 bug：阈值触发的分段 flush 与"哈希表只存行号"的假设冲突了。

## 前置知识

理解这个修复要先看 Doris 列存里 `ColumnString` 的位宽溢出机制。`ColumnStr<T>` 是一个模板，`T` 是 offset 的整数类型：

```cpp title="column_string.h"
using ColumnString = ColumnStr<UInt32>;   // offset 用 uint32，上限 ~4GB
using ColumnString64 = ColumnStr<UInt64>; // offset 用 uint64，无实际上限

static constexpr size_t MAX_STRING_SIZE = 4294967295; // 2^32 - 1
```

`ColumnString` 把所有字符串连续存放在一个 `chars` 字节数组里，`offsets[i]` 标记第 `i` 行的结尾位置。offset 是 `uint32`，所以 `chars` 总长不能超过 ~4GB。常规写入路径都过 `check_chars_length`，一旦超限**直接抛异常**：

```cpp title="column_string.h"
void static check_chars_length(size_t total_length, size_t element_number, size_t rows = 0) {
    if (UNLIKELY(total_length > MAX_STRING_SIZE)) {
        throw Exception(...); // 超 4GB 即抛
    }
}
```

而 set 操作需要把 build 侧**全部**数据攒进一个 block 再建哈希表，单列 String 完全可能超 4GB。如果用常规 `merge`（内部走 `insert_range_from` → `check_chars_length`），攒到 4GB 就抛异常了——这正是旧代码用 4GB 阈值分段 flush 的初衷：赶在单列溢出前把数据落进哈希表，让每个 `batch` 的 String 列都保持在 4GB 以内。

Doris 其实早已为 hash join 准备了一套溢出处理原语，本 PR 把它引入 set 操作：

- `MutableBlock::merge_ignore_overflow` → 内部走 `ColumnStr::insert_range_from_ignore_overflow`，**跳过** `check_chars_length`，允许 `chars` 超 4GB 累积（uint32 offset 会回绕，但暂时忽略）。
- `ColumnStr::convert_column_if_overflow`：累积结束后调用，若 `chars.size() <= MAX_STRING_SIZE` 直接返回自身；否则构造一个 `ColumnStr<uint64_t>`，把 `chars` 搬过去，并**重建 offset**——通过检测 offset 回绕点（`offsets[loc] < offsets[loc-1]`）定位溢出位置，再用 delta 累加推出正确的 uint64 offset。

源码注释把这层关系讲得很直白：

```cpp title="column_string.cpp"
// This method is only called by MutableBlock::merge_ignore_overflow
// by hash join operator to collect build data to avoid
// the total string length of a ColumnStr<uint32_t> column exceeds the 4G limit.
//
// After finishing collecting build data, a ColumnStr<uint32_t> column
// will be converted to ColumnStr<uint64_t> if the total string length
// exceeds the 4G limit by calling convert_column_if_overflow.
void ColumnStr<T>::insert_range_from_ignore_overflow(const IColumn& src, size_t start, size_t length) { ... }
```

## 实现

修复的总思路是：**不再分段 flush，把数据攒到 `eos` 一次性落进哈希表**——`build_block` 只构建一次，悬空引用无从发生。而"一次性攒到 4GB 以上"的溢出问题，交给 `merge_ignore_overflow` + `convert_column_if_overflow` 正面解决。改动落在三个文件。

![修复后的数据流：单次 flush 加溢出转换](/vibe-reading/images/articles/doris-pr-61471-set-op-coredump-4g/fix-flow.svg)

上图自上而下是修复后的链路：累积阶段（黄）容许超 4GB、仅 `eos` 时 flush 一次（绿）、`_process_build_block` 里做溢出转换、Source 用 `insert_indices_from` 读取。四个节点分别对应下文的三处改动。

### 改动 1：去掉 4GB 阈值，仅 `eos` 时 flush

`set_sink_operator.cpp` 的 `sink` 里，删掉 `BUILD_BLOCK_MAX_SIZE` 常量，flush 条件从 `eos || allocated_bytes >= 4GB` 收窄为**只有 `eos`**。`build_block` 因此只构建一次，哈希表里的行号全部指向同一份有效数据，悬空引用的根因被消除：

```cpp title="set_sink_operator.cpp（修复后，sink 节选）"
if (in_block->rows() != 0) {
    // 首个非空 block 到达时，按其结构初始化 _mutable_block
    if (local_state._mutable_block.empty()) {
        auto tmp_build_block = *(in_block->create_same_struct_block(0, false));
        local_state._mutable_block = MutableBlock::build_mutable_block(&tmp_build_block);
    }
    {
        SCOPED_TIMER(local_state._merge_block_timer);
        RETURN_IF_ERROR(local_state._mutable_block.merge_ignore_overflow(std::move(*in_block)));
    }
    if (local_state._mutable_block.rows() > std::numeric_limits<uint32_t>::max()) {
        return Status::NotSupported("set operator do not support build table rows over: ...");
    }
}

if (eos) {   // 只在 eos 时 flush一次
    SCOPED_TIMER(local_state._build_timer);
    build_block = local_state._mutable_block.to_block();
    RETURN_IF_ERROR(_process_build_block(local_state, build_block, state));
    local_state._mutable_block.clear();

    uint64_t hash_table_size = local_state._shared_state->get_hash_table_size();
    valid_element_in_hash_tbl = is_intersect ? 0 : hash_table_size;
    COUNTER_SET(local_state._hash_table_size, (int64_t)hash_table_size);
    COUNTER_SET(local_state._valid_element_in_hash_table, valid_element_in_hash_tbl);
    local_state._shared_state->probe_finished_children_dependency[_cur_child_id + 1]->set_ready();
    DCHECK_GT(_child_quantity, 1);
    RETURN_IF_ERROR(local_state._runtime_filter_producer_helper->send_filter_size(
            state, hash_table_size, local_state._finish_dependency));
}
```

两个连带细节值得注意：一是把 `merge` 换成 `merge_ignore_overflow`，否则攒到 4GB 就抛异常，"只 flush 一次"根本做不到；二是原来嵌在 `if (eos)` 里的哈希表大小记录、`set_ready`、runtime filter 发送逻辑被提到外层（现在 `eos` 分支本身就是终态，不再需要内层判断）。另外，行数仍受 `uint32_t` 上限制约——`rows()` 超 `uint32_max` 会返回 `NotSupported`，这是哈希表 `Mapped` 用 `uint32_t` 行号决定的，不在本 PR 范围（见 [TODO](#todo)）。

### 改动 2：`_process_build_block` 里做溢出转换

既然攒数据时放任 offset 回绕，落进哈希表前必须把超 4GB 的 String 列转成 `ColumnString64` 并修复 offset。`_process_build_block` 在 `materialize_block_inplace` 之后、`_extract_build_column` 之前，对 block 的每一列调用 `convert_column_if_overflow`：

```cpp title="set_sink_operator.cpp（_process_build_block 节选）"
materialize_block_inplace(block);
// Dispose the overflow of ColumnString
for (auto& data : block) {
    data.column = std::move(*data.column).mutate()->convert_column_if_overflow();
}
```

`convert_column_if_overflow` 对 `ColumnStr<UInt32>` 的处理逻辑：未超 4GB 直接返回自身；超了就构造 `ColumnStr<uint64_t>`，把 `chars` 整块搬过去，再扫描 offset 数组——`while (offsets[loc] >= offsets[loc - 1])` 段是回绕前的正常前缀，直接复制；进入 `while (loc < length)` 段后用 `(offsets[loc] - offsets[loc - 1]) + large_offsets[loc - 1]` 逐行重建正确的 uint64 offset。这样一份语义正确的 `ColumnString64` 就交到了哈希表构建和后续 Source 读取手里。

### 改动 3：Source 改用 `insert_indices_from` 支持 ColumnString64

`build_block` 的 String 列现在可能是 `ColumnString64`，`SetSourceOperatorX::_add_result_columns` 原来的读取方式跟不上：

```cpp title="set_source_operator.cpp（修复前）"
const auto& column = *build_block.get_by_position(idx.second).column;
column.append_data_by_selector(_mutable_cols[idx.first], _result_indexs);
```

`append_data_by_selector` 是 `COWHelper` 的模板默认实现 `append_data_by_selector_impl<Derived>`，**按源列的 `Derived` 类型分发**——`ColumnStr` 并没有重写它。当源列是 `ColumnStr<uint64_t>`（ColumnString64）、而输出列 `_mutable_cols` 是 `ColumnStr<uint32_t>`（ColumnString）时，这个跨位宽场景无法处理，会走到错误的 `assert_cast`。修复改成在**目标列**上调用 `insert_indices_from`：

```cpp title="set_source_operator.cpp（修复后）"
// use insert_indices_from to support ColumnString64
_mutable_cols[idx.first]->insert_indices_from(column, _result_indexs.data(),
                                              &_result_indexs[_result_indexs.size()]);
```

`ColumnStr<T>::insert_indices_from` 内部用 `src.is_column_string64()` 分支，**同时支持** `ColumnStr<uint32_t>` 和 `ColumnStr<uint64_t>` 两种源列：

```cpp title="column_string.cpp（insert_indices_from 节选）"
void ColumnStr<T>::insert_indices_from(const IColumn& src, const uint32_t* indices_begin,
                                       const uint32_t* indices_end) {
    auto do_insert = [&](const auto& src_str) {
        // 按 indices 从 src 取行，写入本列（T 决定本列 offset 位宽）
        ...
    };
    if (src.is_column_string64()) {
        do_insert(assert_cast<const ColumnStr<uint64_t>&>(src));
    } else {
        do_insert(assert_cast<const ColumnStr<uint32_t>&>(src));
    }
}
```

由于 `_result_indexs` 是按 `batch_size` 分批取的（一批至多几百上千行），单批拷贝的 `chars` 量远小于 4GB，输出列仍用 `ColumnString`（uint32）即可，不会再次溢出。改动 3 因此只解决"从 `ColumnString64` 源读取"的兼容性，不必让输出列也升级到 64 位。

## 测试

### 单元测试

`be/test/exec/operator/set_operator_test.cpp` 新增两个用例，分别覆盖 `INTERSECT` 和 `EXCEPT` 的超 4GB 场景：

```cpp title="set_operator_test.cpp"
TEST_F(IntersectOperatorTest, test_sink_large_string_data_over_4g) {
    init_op(2, {std::make_shared<DataTypeString>()});
    // ...
    const size_t large_str_size = 1 * 1024 * 1024; // 每行 1MB
    const size_t num_rows = 4200;                  // 共 ~4.1GB，越过 4GB 线
    std::string large_str(large_str_size, 'x');
    // 分批 sink（非 eos），最后一批置 eos，逼出 convert_column_if_overflow 路径
    const size_t rows_per_batch = 500;
    for (size_t batch_start = 0; batch_start < num_rows; batch_start += rows_per_batch) {
        // 给每行加不同后缀，避免哈希表去重
        ...
        auto st = sink_op->sink(state.get(), &block, is_last);
        EXPECT_TRUE(st.ok()) << st.to_string();
    }
    EXPECT_EQ(shared_state->get_hash_table_size(), num_rows);
    // 用第 0 行 probe，INTERSECT 应只返回匹配的那一行
    { ... EXPECT_EQ(block.rows(), 1); }
}
```

`ExceptOperatorTest::test_sink_large_string_data_over_4g` 同理构造 ~4.1GB 数据，用空 block probe，验证 EXCEPT 在超 4GB 下能正确返回全部 `num_rows` 行而不崩溃。两个用例直接命中本 PR 修复的 `merge_ignore_overflow` + `convert_column_if_overflow` + `insert_indices_from` 三条路径。

### 回归测试

`regression-test/suites/query_p2/test_set_operation_large_string.groovy` 在端到端层面复现：建表后用 `repeat('x', 1048576)` 生成每行 1MB 的字符串，分批 `INSERT` 4210 行（~4.1GB），再跑四组集合运算：

| 用例 | 语义 | 期望 |
| --- | --- | --- |
| `except_subset` | 表 `EXCEPT` 去掉 `id < 4208` 的子集 | 返回 4208、4209 两行（前 100 字符） |
| `except_self` | 表 `EXCEPT` 自身 | 空集 |
| `intersect_subset` | 表 `INTERSECT` `id < 2` 的子集 | 返回 0、1 两行 |
| `intersect_self` | 表 `INTERSECT` 自身 | 4210 行（`count(*)`） |

测试还显式 `set parallel_pipeline_task_num = 1`、`batch_size = 128`，确保走单 pipeline、小 batch 的最易触溢出路径，并 `set disable_nereids_rules = "INFER_SET_OPERATOR_DISTINCT"` 关闭把 set 改写为 `DISTINCT` 的优化，保证确实落到 set 算子。

## 问题

一个自然的疑问：去掉 4GB 阈值后，build 侧数据要全量驻留内存直到 `eos`，内存峰值是否更高？答案是有意为之的取舍。旧代码分段 flush 的"省内存"是错觉——`_mutable_block.clear()` 之后哈希表里仍持有等量行号引用，而 `build_block` 本身也得保留全部 build 列供 Source 读取，真正能释放的只是批次间的临时拼装开销。新方案把拼装合并成一次，换来的是正确性（无悬空引用）和对超 4GB String 列的支撑。如果 build 侧总量大到内存吃紧，更合适的出路是落盘 spill，而非靠一个会引发 coredump 的分段 flush 阈值来"缓解"。

## 意义与影响

这个 PR 修复了一类隐蔽且高危的崩溃：set 操作 build 侧 String 总量超 4GB 即 coredump。它揭示了旧设计里一对本不该共存的假设——"4GB 阈值分段 flush"与"哈希表只存行号"——只有在 build 侧永远小于 4GB 时两者才相安无事，一旦越过 4GB 就暴露出悬空引用。修复没有去补"让哈希表也存 block 指针"这种治标方案，而是直接拔掉 4GB 阈值、用 `ColumnString64` 正面解决溢出，根因和表象一起治掉了。

影响范围上，`INTERSECT` / `EXCEPT` 所有在 build 侧可能累积超 4GB String 数据的查询都受益；非 String 类型或小数据量场景行为不变。同一套 `merge_ignore_overflow` + `convert_column_if_overflow` 原语已在 hash join 的 build 侧（`hashjoin_build_sink.cpp`）验证过，set 操作复用它属于把成熟机制扩散到同类算子，风险可控。首发版本覆盖 `4.0.5` 与 `4.1.0` 两个分支。

## TODO

- [ ] 哈希表 `Mapped` 用 `uint32_t` 行号，set 操作仍不支持 build 表行数超过 `uint32_t` 上限（约 42 亿行）。`sink` 里已用 `rows() > std::numeric_limits<uint32_t>::max()` 返回 `NotSupported` 兜底。若未来要支持更大 build 表，需把 `Mapped` 的行号类型升级到 `uint64_t`，并相应调整 `hash_table_set_build.h` 的 `lazy_emplace`。

## 参考

- [ClickHouse ColumnString.h](https://github.com/ClickHouse/ClickHouse/blob/master/src/Columns/ColumnString.h) — Doris `ColumnStr<T>` 的设计来源（`column_string.h` 头部注释注明），`uint32`/`uint64` 双位宽模板与 offset 机制同源。

## 相关阅读

- [修复大块数据 RPC 传输溢出，并默认启用 brpc HTTP 通道](/vibe-reading/articles/Database/OLAP/Apache-Doris/PRs/doris-pr-35770-fix-transfer-large-data-brpc) — 同属"大数据量触发位宽/上限溢出"的 BE 修复，可对照阅读另一条 overflow 修复线。
- [Pipeline 执行引擎](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/07-pipeline) — Doris 4.1.3 CodeWiki，理解 `SetSinkOperatorX` / `SetSourceOperatorX` 所处的 Pipeline 算子体系与 sink/source 协作模型。
- [列存类型与运行时](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/09-core-runtime) — Doris 4.1.3 CodeWiki，涵盖 `ColumnString` / `ColumnString64` 等列存类型与运行时行为，是本 PR 溢出机制的背景上下文。
