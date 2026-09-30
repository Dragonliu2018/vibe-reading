---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Common 共享基础"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "列式存储", "类型系统"]
description: "Common 模块解读：StreamChunk/DataChunk 列式数据结构、for_all_variants 宏单一真源、22 类型系统、visibility bitmap 与 EstimateSize 内存治理"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

common 是依赖图的根：被全仓库 import 3800+ 次，自己却只依赖"叶子级"库（bytes/itertools/chrono + `risingwave_pb` + `risingwave_error`）。它定义了整个系统的**数据契约**——列式内存表示（StreamChunk/DataChunk）、类型系统（DataType）、catalog 模型、row 编码。error 体系已拆出到 `risingwave_error` crate（error.rs 只剩 17 行 re-export）。

## 模块架构

```text
src/common/src/
├── array/               # 列式数组核心
│   ├── stream_chunk.rs      # StreamChunk = ops + DataChunk
│   ├── data_chunk.rs        # DataChunk = columns + visibility
│   ├── mod.rs               # Array/ArrayBuilder trait + ArrayImpl 枚举
│   ├── primitive_array.rs bytes_array.rs utf8_array.rs ...
│   └── stream_chunk_builder.rs
├── types/               # 类型系统
│   ├── mod.rs               # DataType 枚举（22 变体）+ ScalarImpl
│   ├── macros.rs            # for_all_variants! 单一真源宏
│   └── interval.rs ordered.rs serial.rs ...
├── catalog/             # Schema/Field/ColumnDesc/ColumnCatalog
├── row/                 # Row trait + 零拷贝行视图（owned/slice/project/chain）
├── util/                # epoch.rs / row_id.rs / sort_util.rs / value_encoding/
└── bitmap.rs            # Bitmap/BitmapBuilder
```

## 核心实现

### StreamChunk 与 DataChunk 为什么是两个结构

```rust
// src/common/src/array/stream_chunk.rs:105
pub struct StreamChunk {
    ops: Arc<[Op]>,      // 每行一个操作标记
    data: DataChunk,
}
// src/common/src/array/data_chunk.rs:63
pub struct DataChunk {
    columns: Arc<[ArrayRef]>,
    visibility: Bitmap,
}
```

批查询只需要"值"，流查询还需要"每行发生了什么"。`StreamChunk = ops + DataChunk` 的组合让批执行器零成本复用同一 DataChunk，共享逻辑只写一遍。`Op` 枚举（stream_chunk.rs:44）的 `UpdateDelete`/`UpdateInsert` **必须成对相邻出现**且两行 stream key 相同——语义上等价 Delete/Insert 但保留"这是一次 update"的信息，`Op::normalize_update()`（:75）可折叠回去。

**watermark 不在 StreamChunk 里**——它在 stream crate 的消息信封 `MessageInner` 中；common 只提供 `Epoch`（util/epoch.rs:31）作为 barrier 时间戳基础。

### visibility：O(1) 过滤与两套长度

谓词过滤/Join 丢弃行时，`with_visibility`（data_chunk.rs:169）只 clone Arc 列、换一张 bitmap——**不复制数据**；`compact_vis`（:241）才真正拷贝。配套两套长度：`cardinality()`（可见行数）与 `capacity()`（物理行数），使过滤 O(1)；`to_protobuf` 断言 `visibility.all()`——**出网络前必须 compact**，碎片留在算子内部（data_chunk.rs:217）。

### 列式物理布局

变长数组 `BytesArray`（bytes_array.rs:30）= `offset: Box<[u32]>` + null bitmap + 连续 `data: Box<[u8]>`（builder 的"arena"就是单个 Vec 的追加写）；`PrimitiveArray<T>` = bitmap + `Box<[T]>`，经 `PrimitiveArrayItemType::erase_array_type` 抹掉泛型装入 `ArrayImpl`。注意 `Buffer` 只是 proto 传输结构，不是独立的 arena 分配器。

### for_all_variants! 宏：22 类型的 O(n²) 样板压成一张表

22 个物理类型 × Array/Scalar/Builder/转换矩阵是 O(n²) 样板。`for_all_variants!`（types/macros.rs:38）把每个类型的七元组定义在一处，`array_impl_enum!`/`scalar_impl_enum!`/`dispatch_array_variants!` 等宏消费它展开出全部枚举、转换与 match 分派（**宏做 trait-object 分派**，替代 dyn 的虚表开销）。新增类型成本 = 加一行七元组 + 写一个 array 文件（macros.rs:15-17 文档直接这么说）。

### 显式驱逐默认排序

`impl !PartialOrd for ScalarImpl`（types/mod.rs:809）：SQL 排序依赖 ASC/DESC/NULLS FIRST/LAST 六种组合（util/sort_util.rs:95 的 `OrderType`），错误的默认 `Ord` 会是隐蔽 bug——排序必须走 `DefaultOrdered` 包装或 `cmp_datum`。

### EstimateSize：缓存逐出的统一度量

`estimated_heap_size()` 递归估算堆占用，`ArrayImpl`/`ScalarImpl` 全部 derive——LRU/cache 按**真实字节数**而非条目数管理（stream crate 的 `ManagedLruCache`、hummock 的 buffer_tracker 都消费它）。

### Row：借用视图而非物化

行的运行时形态是 `RowRef`（对 DataChunk 一行的借用视图，实现 `Row` trait）；row/ 目录组织了 owned/slice/project（投影零拷贝）/chain/once 等多种实现。`RowId = i64` 是 snowflake 布局（41 bit 时间戳 + vnode + 序列），时钟回拨时自旋等下一毫秒（util/row_id.rs:60-95）——无主键表按 row id 前缀哈希到 vnode。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 单一真源宏 | `for_all_variants!` in types/macros.rs:38 | 22 类型样板集中一处 |
| Builder | `ArrayBuilder` trait + `StreamChunkBuilder`（Drop 时 warn 丢弃行） | 数组构建统一接口 |
| newtype 防误用 | `ColumnId(i32)`、`Epoch(u64)`、`F32/F64 = OrderedFloat` | 浮点可作 HashMap key |
| 派生宏 | `EstimateSize`（estimate_size 子 crate）、`Fields` | 内存统计/结构生成 |

## 模块间交互

被所有人用：frontend 的 plan Schema、expr 的向量化求值（直接吃 DataChunk）、stream 的 StreamChunk/Barrier、storage 的 value encoding 与 memcomparable、meta 的 catalog proto 往返。它依赖的只有基础库 + `risingwave_pb`（TableId 等直接从 pb re-export）——**不依赖任何上层业务 crate**，这是它能当根的前提。

## 扩展方式

**新增一种数据类型**（macros.rs 文档给出的标准路径）：`types/macros.rs` 的 `for_all_variants!` 表加一行七元组 → `types/mod.rs` 的 `DataType` 枚举 + `From<&PbDataType>`/`PbTypeName` 两个 match 补 arm + `data_types` 宏归类 → 新建 `array/foo_array.rs` 实现 Array/ArrayBuilder → proto `data.proto` 加 `PbTypeName`/`PbArray` → 外围（expr cast、storage 编码、frontend parser/binder）跟进——common 是改动的第一站。

**调整过滤/可见性语义**：集中在 `data_chunk.rs` 的 `compact_vis/expand_vis/with_visibility` 与 `bitmap.rs`；`ArrayCompactVisExt`（array/mod.rs:316）是所有数组 compaction 的共享入口。
