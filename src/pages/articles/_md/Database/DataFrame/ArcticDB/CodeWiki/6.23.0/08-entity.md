---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "核心类型"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "AtomKey", "KeyType", "DataType", "类型系统"]
description: "ArcticDB 核心类型：键体系、DataType、TypeDescriptor 与 KeyType 枚举"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

核心类型模块（`cpp/arcticdb/entity/`，~7.5k 行）是全库**类型地基**——被几乎所有模块 import。它定义两件事：**键体系**（`AtomKey`/`RefKey`/`KeyType`，决定数据在存储里如何寻址与链接）与**数据类型系统**（`DataType`/`TypeDescriptor`/`StreamDescriptor`，决定列如何表示）。这层独立存在是因为键与类型是所有层的共享词汇——把它们抽出来避免循环依赖，也让类型决策（如"哪些键先写"、"哪些类型可比较"）集中可维护。

## 模块架构

![键类型体系](/vibe-reading/images/articles/arcticdb-internals/key-type-hierarchy.svg)

类型体系分两支：**键**（`key.hpp`/`atom_key.hpp`/`ref_key.hpp`）与**数据类型**（`types.hpp`/`field_collection.hpp`）。键有 `KeyClass`（ATOM_KEY/REF_KEY）两族：`AtomKeyImpl`（不可变、内容寻址、可哈希，字段 id/version_id/creation_ts/content_hash/key_type/index_start/index_end）与 `RefKey`（可变、仅 id 定位）。`KeyType` 枚举（`key.hpp:62`）定义 29 种键类型，按写入优先级 `key_types_write_precedence()` 排序。`AtomKeyPacked`（`#pragma pack(1)`，40 字节）是紧凑版用于高效哈希（ankerl wyhash）。数据类型侧：`DataType` 枚举（整数/浮点/布尔/时间戳/字符串/特殊）、`Dimension`（Dim0/Dim1/Dim2）、`TypeDescriptor`（DataType + Dimension）、`StreamDescriptor`（字段集合 + 索引描述）、`FieldRef`/`FieldCollection`。

## 调用链路

```text
写入：  数据 → 计算 content_hash → AtomKeyBuilder.build(id, KeyType::TABLE_DATA) → AtomKey
        版本：AtomKeyBuilder.build(id, KeyType::VERSION) → 含 prev 链表指针
        最后：RefKey(id, KeyType::VERSION_REF) → 覆写指向新 VERSION
读取：  RefKey(id, VERSION_REF) → 读出最新 VERSION 的 AtomKey → 沿链表/索引遍历
哈希：  AtomKey::get_cached_hash() → folly::hash_combine(各字段) → 惰性缓存
```

| 类型/方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `AtomKeyImpl` `atom_key.hpp:22` | 不可变内容寻址键 | 7 字段，`get_cached_hash` 惰性 |
| `AtomKeyBuilder` `:149` | 流式构造键 | 避免 7 参数 ctor 字段错位 |
| `AtomKeyPacked` `:227` | 紧凑键（无 StreamId） | `#pragma pack(1)` 40B，wyhash 整块哈希 |
| `RefKey` `ref_key.hpp` | 可变引用键 | 仅 id 定位，可覆写 |
| `KeyType` 枚举 `key.hpp:62` | 29 种键类型 | 含 TABLE_DATA/INDEX/VERSION/REF/TOMBSTONE… |
| `key_types_write_precedence` `:199` | 写入顺序 consteval 数组 | DATA→INDEX→VERSION→REF，last-writer-wins 基础 |
| `DataType` 枚举 `types.hpp` | 列数据类型 | INT8..INT64/FLOAT32/64/BOOL8/NANOSECONDS_UTC64/ASCII/UTF… |
| `TypeDescriptor` `types.hpp` | DataType + Dimension | 描述列类型 |

## 核心实现

### 键类与写入优先级

`KeyClass` 区分 ATOM_KEY（含数据/索引的段，需全字段键才能读）与 REF_KEY（含其他键的引用，仅 id 即可读）。`KeyType` 枚举有 29 个值，每个带详细注释说明用途——如 `TABLE_DATA=2`（叶子数据段）、`TABLE_INDEX=3`（指向多个 DATA）、`VERSION=4`（指向单个 INDEX + prev VERSION 链表）、`VERSION_REF=9`（最新版本快指针）、`TOMBSTONE=15`/`TOMBSTONE_ALL=21`（虚拟键，不独立存盘，只在 VERSION 段内）、`SNAPSHOT_REF=14`、`APPEND_REF=11`（incomplete 链头）、`LOCK=13`/`ATOMIC_LOCK=28`、`COLUMN_STATS=25`。`key_types_write_precedence()`（`consteval`，编译期求值）定义写入顺序：先 `LIBRARY_CONFIG`→`TABLE_DATA`→`TABLE_INDEX`→`MULTI_KEY`→`VERSION`→`VERSION_REF`→`SYMBOL_LIST`→`SNAPSHOT_REF`→`APPEND_REF`…，`key_types_read_precedence()` 是其逆序。这个顺序是 last-writer-wins 并发正确性的基石（见[版本引擎](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/02-version-engine)）。`foreach_key_type_read_precedence`/`_write_precedence` 模板遍历辅助。

### AtomKey 内容寻址与 Packed 优化

`AtomKeyImpl`（`atom_key.hpp:22`）7 字段：`id_`（StreamId = `variant<StringId, NumericId>`）、`version_id_`、`creation_ts_`、`content_hash_`（uint64）、`key_type_`、`index_start_`/`index_end_`（IndexValue = variant<timestamp, string>）。`operator==` 比较全部字段，`get_cached_hash()` 用 `folly::hash::combine` 惰性缓存（`mutable optional<size_t> hash_`）——键频繁用作 hashmap key，缓存哈希省重复计算。`AtomKeyBuilder` 流式 API（`.version_id(v).creation_ts(t).build(id, KeyType)`）避免 7 参数 ctor 字段错位（注释："having a ctor for the key with 4 fields with the same type next to each other is going to result in inverted fields"）。`AtomKeyPacked`（`:227`）是紧凑版——`#pragma pack(push,1)` 40 字节，不含 StreamId（适合同 symbol 大量键的场景），用 ankerl wyhash 整块哈希（`static_assert(sizeof==40+sizeof(int))`）。`IndexTypeKey = AtomKey` 别名标记 `is_index_key_type()`（TABLE_INDEX/MULTI_KEY）。

### 数据类型系统

`DataType` 枚举（`types.hpp`）：整数 INT8/16/32/64 + UINT8/16/32/64、浮点 FLOAT32/64、布尔 BOOL8/BOOL_OBJECT8（可空）、时间戳 NANOSECONDS_UTC64（纳秒 since epoch）、字符串 ASCII_FIXED64/ASCII_DYNAMIC64/UTF_FIXED64/UTF_DYNAMIC64/UTF_DYNAMIC32、特殊 EMPTYVAL/UNKNOWN。谓词：`get_type_size`/`is_floating_point_type`/`is_integer_type`/`is_numeric_type`/`is_sequence_type`。`Dimension` Dim0（标量）/Dim1/Dim2（数组）。`TypeDescriptor{DataType, Dimension}` 描述列类型。`StreamDescriptor` 持字段集合与索引描述，是 `SegmentInMemory` 的 schema。`FieldRef`/`FieldCollection` 引用段中列。`StreamId = variant<StringId, NumericId>` 标识 symbol。错误码（`util/error_code.hpp` 的 `ARCTIC_ERROR_CODES` 宏）：`E_KEY_NOT_FOUND`/`E_SYMBOL_NOT_FOUND`/`E_VERSION_NOT_FOUND`/`E_STORAGE_ERROR`/`E_INVALID_ARGUMENT`/`E_INTERNAL_ERROR`/`E_UNSORTED_DATA`。异常类：`ArcticException` 基 → `StorageException`/`UserInputException`/`InternalException`/`SchemaException`/`SortingException`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 值对象 | `AtomKeyImpl` 不可变 | 内容寻址，可哈希可比较 |
| 建造者 | `AtomKeyBuilder` | 避免多同型参数 ctor 错位 |
| 享元/紧凑 | `AtomKeyPacked` | 同 symbol 大量键省内存 |
| 枚举驱动 + consteval | `KeyType` + `key_types_*_precedence` | 编译期定写入/读取顺序 |
| 变体 | `StreamId`/`IndexValue` variant | 兼容字符串/数值两种 id 与索引 |

## 模块间交互

核心类型无下游依赖（它是地基）。被[版本引擎](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/02-version-engine)（键树）、[管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)（SliceAndKey）、[存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage)（VariantKey = variant<AtomKey, RefKey>）、[列式存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/06-column-store)（TypeDescriptor）、[编解码](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/04-codec)（段头字段描述）全部 import。`protobufs.hpp` 提供 protobuf 互转。

## 扩展方式

新增键类型：在 `key.hpp` 的 `KeyType` 枚举加值（注释说明用途）；`key_types_write_precedence`/`read_precedence` 数组加（若需参与顺序）；`key_type_long_name`/`key_type_short_name`/`variant_type_from_key_type` 加映射；`is_ref_key_class`/`is_string_key_type` 等谓词更新。新增数据类型：`DataType` 枚举加值 + `get_type_size`/`is_*_type` 谓词 + 各模块（Column/codec/processing）加分支 + 归一化加映射。注意向后兼容——新键类型旧客户端需能跳过（`foreach_key_type` 遍历会覆盖）。
