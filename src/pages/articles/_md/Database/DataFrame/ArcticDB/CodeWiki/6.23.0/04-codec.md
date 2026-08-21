---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "编解码"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "codec", "LZ4", "ZSTD", "压缩"]
description: "ArcticDB 编解码模块：Segment 落盘格式与 LZ4/ZSTD 压缩"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

编解码模块（`cpp/arcticdb/codec/`，~6.4k 行）定义 ArcticDB 的**落盘格式**。它独立于内存格式（`SegmentInMemory`）——内存里是便于随机访问的列式结构，落盘是紧凑压缩的字节流。这层存在是因为"内存格式"与"存储格式"有截然不同的优化目标：内存要快访问、存储要高压缩 + 抗损坏。把两者解耦，让内存布局与压缩算法可独立演进。

## 模块架构

![Segment 落盘布局](/vibe-reading/images/articles/arcticdb-internals/segment-layout.svg)

一个 Segment（对应一个 `TABLE_DATA` 键）由三部分组成：**HEADER**（Magic Number + `EncodingVersion` V1/V2 + FieldDescriptors + RowCount）→ **COLUMN DATA**（逐列压缩块，每列一个 `EncodedField`，含 descriptor/shapes/values）→ **STRING POOL**（拼接的字节 + offsets，字符串列存偏移而非内联）。`Codec` 枚举（`storage/memory_layout.hpp`）定义 `UNKNOWN`/`ZSTD`/`PFOR`（整数）/`LZ4`（默认）/`PASS`（passthrough）。`codec.cpp` 的 `encode()` 把列数据压成 `EncodedField`，`decode()` 解压回 `ColumnData`。V1 编码（`encode_v1.cpp`）逐列存 + LZ4/ZSTD；V2（`encode_v2.cpp`）更精细——shape encoding 处理稀疏、重复值优化、PFOR/delta 子编码，但**V2 当前实验性、无客户端使用**。

## 调用链路

```text
WRITE:  WriteToSegmentTask → SegmentInMemory
          └─ encode(SegmentInMemory, EncodingVersion) → Segment   codec.cpp
               └─ encode_v1 / encode_v2                            按版本分派
                    └─ 每列：类型强制 → 分块 → 压缩(LZ4/ZSTD/PFOR/PASS) → EncodedField
          └─ 拼装 Segment(header + columns + string_pool) → 落盘

READ:   Segment(字节流) → SegmentHeader 解析
          └─ decode(EncodedField) → ColumnData                      codec.cpp
               └─ 解压块 → 类型提升(若需) → Column
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `encode()` `codec.cpp` | 压缩列数据成 EncodedField | 按 Codec 枚举选压缩器 |
| `decode()` `codec.cpp` | 解压 EncodedField 回 ColumnData | 读路径在 CPU 池并行调 |
| `encode_v1` `encode_v1.cpp` | V1 逐列编码 | 简单可靠，生产默认 |
| `encode_v2` `encode_v2.cpp` | V2 精细编码 | 实验性，含稀疏 shape/子编码 |
| `SegmentHeader` `segment_header.hpp` | 段头结构 | Magic + EncodingVersion + descriptors |

## 核心实现

### 压缩算法选择与权衡

`Codec` 枚举在 `storage/memory_layout.hpp`，与 `EncodingVersion`（`segment_header.hpp`，V1=0/V2=1，经 `LibraryOptions.encoding_version` 配置）正交。LZ4 是默认——压缩/解压都极快、CPU 低，适合实时大流量写入；ZSTD 压缩比更好但较慢，适合归档小数据；PFOR 面向整数列；PASS 不压缩（已压缩数据）。读路径 `decode` 在 CPU 池并行执行（见[异步模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/09-stream-async)）。块大小影响压缩比与解压内存——大块压缩比好但解压更耗内存。

### Segment 与 EncodedField

`Segment` 类（`segment.hpp`）提供 `header()`/`buffer()`/`fields()` 访问。`EncodedField` 表示一个压缩列——含 descriptor、shapes（V2 多维）、values（压缩数据块）。`Buffer` 类管理段字节内存（`data()`/`size()`/`resize()`）。`slice_data_sink.hpp` 提供缓冲管理。段头 Magic Number 用于抗损坏校验（`magic_words.hpp`），`check_magic()` 在解码前验证。字符串列不内联存——字符串进 `StringPool`（见[列式存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/06-column-store)），列里只存到 pool 的 offset，这让重复字符串高效去重。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略模式 | `Codec` 枚举 + encode/decode 分派 | 压缩算法可按列/配置选 |
| 模板方法 | encode_v1/v2 共享列遍历骨架 | 编码版本可演进，V1/V2 共用接口 |
| 池化 | `StringPool` 去重 | 重复字符串只存一份 |

## 模块间交互

编解码向上被[读写管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)的 `WriteToSegmentTask`/`fetch_data` 调用，向下依赖[列式存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/06-column-store)的 `SegmentInMemory`/`Column`/`Buffer` 作为内存载体，类型信息来自[核心类型](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/08-entity)的 `TypeDescriptor`/`DataType`。压缩后的 `Segment` 经 `Store` 写入[存储后端](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage)。

## 扩展方式

新增压缩编码（如 Delta）：在 `memory_layout.hpp` 的 `Codec` 枚举加值；在 `encode_v1.cpp` 或新 `encode_v<version>.cpp` 实现 encode/decode；在 `codec.cpp` 的 `encode()`/`decode()` 加分派分支；如需新段头格式在 `segment_header.hpp` 加 `EncodingVersion`。注意向后兼容——新编码写的数据旧客户端必须能跳过或报清晰错误（见 CLAUDE.md 的 Backwards Compatibility 要求）。对应测试在 `cpp/arcticdb/codec/test/`。
