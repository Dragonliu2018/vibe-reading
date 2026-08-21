---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "读写管道"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "pipeline", "slicing", "column stats"]
description: "ArcticDB 读写管道：切片、并行编解码、段装配与列统计裁剪"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

读写管道（`cpp/arcticdb/pipeline/`，~14k 行）是 ArcticDB 的数据流骨架。它解决"如何把一个 DataFrame 变成一批可并行处理的段、又如何把一批段拼回 DataFrame"。这层独立存在，是因为**切片粒度与并行度直接决定压缩率与随机访问性能的权衡**——默认 10 万行一段，这个决策需要一个专门模块统筹切片、编码、存储写入、读时裁剪与装配，让版本引擎不必关心数据如何分片。

## 模块架构

![写入与读取数据流](/vibe-reading/images/articles/arcticdb-internals/data-flow.svg)

管道分两向：**写入管道**（`write_frame.cpp`）把 `InputFrame` 经 `slice_and_write` 切成 `FrameSlice`，每个切片由 `WriteToSegmentTask`（一个 `async::BaseTask`）在 CPU 池编码成 `SegmentInMemory` 再压缩落盘，产出 `SliceAndKey`（切片 + 键）列表；**读取管道**（`read_frame.cpp`）从 `TABLE_INDEX` 读出切片元数据，按行范围/列选择/列统计裁剪，并行拉取 + 解压段，`decode_into_frame` 装配回 `SegmentInMemory`。贯穿两者的是 `PipelineContext`（`pipeline_context.hpp`）——一次操作的全局状态，持有 `slice_and_keys_`、`desc_`（StreamDescriptor）、`selected_columns_`（BitSet）、`filter_columns_`、`string_pools_` 等。`column_stats_filter.hpp` 是读路径的优化支线：用段级 min/max 裁剪不匹配的行分片。

## 调用链路

```text
WRITE:  write_frame(IndexPartialKey, frame, slicing, store)       write_frame.hpp:67
          └─ slice_and_write(frame, slicing, partial_key, sink)   :53  切片 + 并行编码
               └─ write_slices(frame, slices, partial_key, ...)    :61  返回 SemiFuture<vector<Try<SliceAndKey>>>
                    └─ WriteToSegmentTask()::operator()             :39  → (PartialKey, SegmentInMemory, FrameSlice)
          └─ rollback_on_quota_exceeded<T>(try_slices, remove_fn)  :102  配额超限回滚已写键

READ:   fetch_data(frame, context, ssource, read_query, ...)       read_frame.hpp:69
          └─ decode_into_frame_static / _dynamic                   :75/:81  按是否动态 schema 分派
          └─ reduce_and_fix_columns(context, frame, read_options)  :87      修整列类型/缺失
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `write_frame` `write_frame.hpp:67` | 写入主入口，返回 `Future<AtomKey>`（index 键） | 编码并行化，最后聚合 index |
| `slice_and_write` `:53` | 切片 + 并行写，返回 `Future<vector<SliceAndKey>>` | 按 `SlicingPolicy` 切 |
| `WriteToSegmentTask::operator()` `:39` | 单切片编码任务 | `CopyMode` 控制是否可与 frame 共享内存 |
| `fetch_data` `read_frame.hpp:69` | 并行拉取 + 解压段 | I/O 池拉取、CPU 池解压 |
| `decode_into_frame_static`/`_dynamic` `:75`/`:81` | 段解码进 frame | 静态/动态 schema 两条路径 |
| `allocate_frame` `:22` | 按 context 预分配输出 frame | 列类型/行数已知时一次分配 |
| `check_and_mark_slices` `:25` | 校验切片行连续 + 标记 | 不连续抛 `E_UNSORTED_DATA` |
| `rollback_on_quota_exceeded` `write_frame.hpp:102` | 配额超限回滚 | 删已写键，抛 `QuotaExceededException` |

## 核心实现

### 切片策略与 PipelineContext

`SlicingPolicy`（`slicing.hpp`）是 `std::variant<NoSlicing, FixedSlicer, HashedSlicer>`——不切（单段）、固定行列数切（默认 10 万行，`FixedSlicer`）、哈希切（分区）。`get_slicing_policy(WriteOptions, InputFrame)` 按 WriteOptions 选策略。切片产出的 `FrameSlice` 描述每个段的行/列范围，与键一起组成 `SliceAndKey`。`PipelineContext`（`pipeline_context.hpp:54`）是"一次操作的状态背包"，注释明确说"persists throughout the lifetime of an operation... instantiated high up in the call stack and passed through"——它在版本引擎高层构造，向下传给管道每一步。它持有 `desc_`/`orig_desc_`/`staged_descriptor_`（三套描述符应对动态 schema）、`slice_and_keys_`、`fetch_index_`（BitSet 标记哪些切片要拉 index）、`selected_columns_`/`overall_column_bitset_`（用户选列 vs 实际需读列，后者是前者的超集以支持投影依赖）、`default_values_`（如 sum 聚合缺失段填 0）。`tsd_`（`TimeseriesDescriptor`）携带归一化元数据，`is_pickled()` 判断是否 msgpack 兜底。

### 列统计裁剪（Column Stats）

`column_stats_filter.hpp`/`column_stats_dispatch.hpp` 是读路径的性能关键。写入时可选地为 tracked 列生成 `COLUMN_STATS` 键（`index_key_to_column_stats_key` in `version_core.cpp`），段内存每行分片的 min/max。读时若首个非范围 clause 是 `FilterClause` 且 `ColumnStats.UseForQueries` 开启（`should_try_column_stats_read()`），`fetch_index_and_column_stats`（`version_core.cpp`）并行拉 index 与 stats，`create_column_stats_filter()` 把过滤表达式对 stats 求值，`NONE_MATCH` 的分片直接不拉取。求值用**三值逻辑**（`StatsComparison: ALL_MATCH/NONE_MATCH/UNKNOWN`）：`ALL_MATCH` 全段满足（可跳过逐行过滤优化）、`NONE_MATCH` 跳过整个段、`UNKNOWN` 必须拉取逐行判。NaN/NaT 遵循 Pandas 语义——NaT 比较除 `!=` 外全 False，`MinMaxAggregatorData` 跳过 NaT 只在全 NaT 段写 `(NaT, NaT)`。`isin`/`isnotin` 用 `ValueSet` 的缓存 min/max 先做范围不相交快速判断，再回退到逐元素。多 filter clause 的 `ExpressionContext` 由 `and_filter_expression_contexts`（`query_planner.cpp`）AND 成一个图。

### 配额回滚与更新段重排

`rollback_on_quota_exceeded<T>`（`write_frame.hpp:102`）是写入正确性保障：`write_slices` 返回 `vector<Try<SliceAndKey>>`，若任一因 `QuotaExceededException` 失败，该模板收集已成功的键、经 `remove_future` 在 CPU 池删除它们，避免孤儿段污染存储。`flatten_and_fix_rows`（`:96`）服务 `update` 操作——把更新区间涉及的 5 类段（前不交/前交/全含/后交/后不交）重排成一个连续切片列表，`AffectedSegmentPart { START, END }`（`:78`）标记被部分影响的段需 `asyncrewrite_partial_segment` 重写边界。这体现了"段级不可变"的代价：update 不能就地改段，必须重写边界段。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略模式 | `SlicingPolicy` variant | 切片策略可按 WriteOptions 切换 |
| 命令模式 | `WriteToSegmentTask : BaseTask` | 切片编码封装成任务投到 CPU 池并行 |
| 上下文对象 | `PipelineContext` | 贯穿调用栈共享状态，避免长参数列表 |
| Future 流水线 | `slice_and_write`/`write_slices` 返回 SemiFuture | 段级并行，`Try` 承载成败 |
| 补偿事务 | `rollback_on_quota_exceeded` | 部分失败时回滚已写键 |

## 模块间交互

管道向下用[列式存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/06-column-store)的 `SegmentInMemory`/`Column` 作内存格式，用[编解码](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/04-codec)压缩落盘，经 `Store`（[存储后端](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage)）读写键，并行任务投到[异步模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/09-stream-async)的 CPU/I/O 池。读路径若带查询则把段交给[查询处理](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/05-processing)的 Clause 管道。向上被[版本引擎](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/02-version-engine)调度。`ReadQuery`（`read_query.hpp`，含 `columns`/`row_range`/`clauses_`）与 `VersionQuery`（`query.hpp`）是版本引擎传给管道的契约。

## 扩展方式

改切片粒度：调 `LibraryOptions.segment_row_size`/`column_group_size`（影响压缩率与随机访问权衡）。新增读时裁剪优化：在 `column_stats_filter.hpp` 加 stats 求值分支，配合 `column_stats_dispatch.hpp` 的 `StatsComparison` 三值逻辑。新增一种切片策略：在 `slicing.hpp` 的 `SlicingPolicy` variant 加类型 + `get_slicing_policy` 分支 + `slice_and_write` 内处理。管道内存上限可经近期引入的 pipeline memory bounding（`Bound processing pipeline memory use` PR）配置。
