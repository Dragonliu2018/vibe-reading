---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "列式存储"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "SegmentInMemory", "Column", "列式"]
description: "ArcticDB 列式存储：SegmentInMemory、Column、StringPool 与 ChunkedBuffer"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

列式存储模块（`cpp/arcticdb/column_store/`，~13k 行）定义 ArcticDB 的**内存数据格式**——所有层共享的"词汇表"。`SegmentInMemory` 是读写路径上一切数据的载体：归一化产出它、管道切片它、编解码压缩它、查询处理操作它。这层独立存在是因为内存格式是性能基座——列式布局利于向量化与缓存局部性，字符串池化去重省内存，分块缓冲避免大段重分配。把它与落盘格式（[编解码](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/04-codec)）解耦，让两者各自优化。

## 模块架构

![SegmentInMemory 内存结构](/vibe-reading/images/articles/arcticdb-internals/segment-in-memory.svg)

`SegmentInMemory`（`memory_segment.hpp`）用 pimpl 委托 `SegmentInMemoryImpl`——稳定 ABI + 降低编译依赖。它聚合三件东西：`descriptor_`（`StreamDescriptor`，字段名 + `TypeDescriptor`）、`columns_`（`vector<shared_ptr<Column>>`）、`string_pool_`（`StringPool`）。注释明确："a segment is not guaranteed to contain all columns for a row as Arctic tiles across both the rows and the columns"——因为 ArcticDB 同时按行和列切片，一个段可能只是某个行列子集。`Column`（`column.hpp`）持 `type_`（TypeDescriptor）、`data_`（`ChunkedBuffer`）、`shapes_`（多维）、`sparse_map_`（稀疏列的 BitSet）、`last_logical_row_`。`ChunkedBuffer`（`chunked_buffer.hpp`）按 64KB 块增长。`StringPool` 存拼接字节 + offsets，字符串列存 offset 而非内联。

## 调用链路

```text
WRITE:  归一化/RowBuilder → set_scalar<T>(idx,val)/set_string(idx,str) → end_row()
          └─ SegmentInMemory 攒满 → encode → 落盘
READ:   decode → SegmentInMemory
          └─ column(idx).scalar_at<T>(row,col) / string_at(row,col)  随机访问
          └─ filter(BitSet) / truncate / split / concatenate          切片重组
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `set_scalar<T>(idx,val)` `memory_segment.hpp:65` | 写标量到列 | 整型/浮点模板约束 |
| `set_string(idx,str)` `:105` | 写字符串（进 pool 存 offset） | 字符串不内联 |
| `end_row()` `:61` | 结束当前行 | 行边界标记 |
| `column(idx)` `:118` | 取列引用 | pybind 需 const/非 const 两版 |
| `filter(BitSet)` `:250` | 按位集过滤行 | 产出新 SegmentInMemory |
| `truncate(start,end)` `:254` | 截取行范围 | 可选重建 string pool |
| `split(rows)` `:294` | 按行数拆分 | 切片用 |
| `sparsify()`/`unsparsify()` `:176`/`:170` | 稀疏/密集互转 | 稀疏列用 BitSet 标记有效行 |
| `sort(columns)` `:239` | 原地排序 | 多列排序重载 |

## 核心实现

### SegmentInMemory pimpl 与稀疏列

`SegmentInMemory` 的方法都委托给 `impl_`（`SegmentInMemoryImpl*`），构造有多个重载——可指定 `expected_column_size`、`AllocationType`（DYNAMIC 等）、`Sparsity`（NOT_PERMITTED/允许）、`BlockConfigPerColumn`。稀疏列是关键特性：`sparse_map_`（`util::BitSet`）标记哪些行有值，缺失行不占数据空间——这对金融稀疏数据（不同证券字段差异大）省内存。`is_sparse()`/`sparse_map()` 查询，`sparsify()`/`unsparsify()` 互转。`metadata_`（`google::protobuf::Any`）存用户自定义元数据。`offset_` 支持段在更大表中的偏移定位。`calculate_statistics()` 可算列统计（用于 column stats 落盘）。

### Column 与 ChunkedBuffer

`Column`（`column.hpp`）的 `type()` 返回 `TypeDescriptor`（`data_type` + `Dimension` Dim0/Dim1/Dim2），`set_scalar<T>(row,val)`/`scalar_at<T>(row)` 类型安全访问，`buffer()` 取底层 `ChunkedBuffer`，`data()` 取 `ColumnData` 包装器供迭代，`change_type(target)` 改类型（类型提升）。`ChunkedBuffer`（`chunked_buffer.hpp`）按固定块大小（默认 64KB）增长——`blocks_` 向量 + `bytes_` 总量 + `block_size_`。好处：增长时无需昂贵的连续重分配（避免大段 memcpy），追加高效，局部性好。`ColumnData` 提供遍历接口给编解码与查询处理。

### StringPool 去重

`StringPool`（`string_pool.hpp`）把变长字符串存成拼接字节流 + offsets 数组 + shapes（长度）。`get(string_view, deduplicate=true)` 加入字符串并返回 offset（注意方法名是 `get` 不是 `add`），`get_view(offset)`/`get_const_view(offset)` 按 offset 取回。字符串列存的是 `OffsetString`（offset），不是字符串本身——这让重复字符串天然去重（金融数据里 symbol/sector 等高重复列大幅省内存）。`clone()`/`clear()` 管理内存。段间可共享 string pool（`set_string_pool`/`string_pool_ptr`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| pimpl | `SegmentInMemory` → `SegmentInMemoryImpl` | 稳定 ABI + 降低编译耦合 |
| 享元 | `StringPool` 去重 | 重复字符串只存一份 |
| 分块缓冲 | `ChunkedBuffer` 64KB 块 | 避免大段重分配，追加高效 |
| 位图稀疏 | `sparse_map_` BitSet | 稀疏列缺失行不占空间 |
| 迭代器 | `ColumnData`/`SegmentInMemory::iterator` | 统一遍历接口给 codec/processing |

## 模块间交互

列式存储是全库地基——[读写管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)切片/装配它、[编解码](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/04-codec)压缩它、[查询处理](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/05-processing)操作它、[流式模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/09-stream-async)的 `Aggregator`/`RowBuilder` 攒它。类型信息来自[核心类型](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/08-entity)的 `TypeDescriptor`/`DataType`/`StreamDescriptor`。`StringPool` 与段绑定，段间共享通过 `PipelineContext::string_pools_`。

## 扩展方式

新增列数据类型：在[核心类型](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/08-entity)的 `DataType` 枚举加值 + `get_type_size`/`is_*_type` 谓词；`Column` 的 `set_scalar`/`scalar_at` 加特化；编解码加 encode/decode 分支；归一化加 pandas dtype 映射。改段内存策略：调 `AllocationType`/`BlockConfigPerColumn`/`Sparsity`。字符串优化：`string_max_len` hint 让固定长度字符串走 `ASCII_FIXED64` 提速。`compact_blocks()` 合并块减少碎片（未启用，预留）。
