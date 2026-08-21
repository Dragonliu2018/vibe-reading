---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "Parquet 列式文件格式"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "Parquet", "列式存储"]
description: "Apache Parquet 列式文件格式——Thrift 元数据 + 自定义 page encoding、PageReader 迭代器、字典编码与 Parquet↔Arrow schema 转换"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

`cpp/src/parquet/`（~93k 行）实现 Apache Parquet 列式存储文件格式的读写。Parquet 是数据湖的事实标准文件格式，与 Arrow 内存格式不同质：它用 **Thrift** 序列化结构化元数据（schema/row group/column chunk），用**自定义 page encoding**（PLAIN/RLE/Delta/字典）存同质列数据。本模块既提供 Parquet 原生 API，又通过 `parquet/arrow/` 转换层直接与 Arrow `Array`/`Table` 互转。它是 Dataset 扫描的最主要文件格式。

## 模块架构

```
┌──────────── 元数据层（Thrift）────────────┐
│  FileMetaData (metadata.h)  pimpl 代理 Thrift │
│   ├─ RowGroupMetaData → ColumnChunkMetaData  │
│   │    (num_values/compression/statistics)  │
│   └─ SchemaDescriptor (schema.h)             │
│        └─ ColumnDescriptor (max_def/rep_level)│
└────────────────┬──────────────────────────────-┘
                 │ 索引
┌────────────────▼──────────────────────────────┐
│  ParquetFileReader (file_reader.h)            │
│   ParquetFileWriter (file_writer.h)           │
│    └─ RowGroupReader/Writer                   │
│         └─ ColumnReader/Writer (column_*.h)   │
│              ├─ PageReader::NextPage 迭代器    │  column_reader.h
│              │    └─ Page(DataPage V1/V2 / DictionaryPage)│
│              └─ PageWriter::WriteDataPage     │  column_writer.h
└────────────────┬──────────────────────────────-┘
                 │ 编解码
┌────────────────▼──────────────────────────────┐
│  Encoder/Decoder (encoding.h)                │
│   EncodingTraits<DType> → Arrow type + builder │
│    PLAIN / RLE_DICTIONARY / DELTA_BINARY_PACKED│
│    / DELTA_BYTE_ARRAY / BYTE_STREAM_SPLIT     │  decoder.cc/encoder.cc
│  Level 编解码 (level_conversion.h)            │
└────────────────┬──────────────────────────────-┘
                 │ 转换
┌────────────────▼──────────────────────────────┐
│  parquet::arrow (arrow/schema.h reader.h writer.h)│
│   FromParquetSchema/ToParquetSchema  schema 互转│
│   DecodeArrow → 直接写 ArrayBuilder           │
└──────────────────────────────────────────────-┘
```

## 调用链路

读取一列 Parquet 数据到 Arrow（`parquet::arrow::FileReader::ReadTable`）：

```
ParquetFileReader::Open(source)                  file_reader.h
  └─ 读文件尾（magic PAR1 + 4 字节 metadata 长度）
  └─ 反序列化 Thrift FileMetaData
FileReaderImpl::ReadTable()                       arrow/reader.cc:205
  └─ ReadColumn(i, row_groups, ...) → LeafReader  arrow/reader.cc:454
       └─ RecordReader::Make(descr, leaf_info, pool)
            └─ RecordReader::ReadRecords(num)
                 └─ TypedColumnReaderImpl::HasNextInternal  column_reader.cc:778
                      └─ if decoder 空:
                           current_page_ = pager_->NextPage()  column_reader.cc
                                SerializedPageReader::NextPage  column_reader.cc:255
                                 ├─ 反序列化 Thrift PageHeader
                                 ├─ 解密 / 解压
                                 └─ → DataPageV1/V2 / DictionaryPage
                           ├─ if DictionaryPage: ConfigureDictionary  cc:831
                           └─ if DataPage: InitializeLevelDecoders + InitializeDataDecoder
                                └─ MakeDecoder(encoding) → PLAIN/Delta/Dict  decoder.cc:2380
                 └─ Decode def/rep levels + values
                 └─ decoder->DecodeArrow(...) → 直接写 arrow::ArrayBuilder
  └─ 组装 arrow::Table
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `ParquetFileReader::Open` (`file_reader.h`) | 打开文件读 footer | 尾部 magic+length 反向定位 |
| `PageReader::NextPage` (`column_reader.h:169`) | 迭代下一个 page | 抽象迭代器，`DataPageFilter` 谓词下推 |
| `ColumnReader::Make` (`column_reader.cc:1278`) | 建列读 | 按 `physical_type` switch 到 `TypedColumnReaderImpl` |
| `RecordReader::ReadRecords` (`column_reader.h`) | 按 semantic record 读 | 直接输出到 Arrow builder |
| `MakeDecoder` (`decoder.cc:2380`) | 工厂选 decoder | `(Type,Encoding)` 二维分发 |
| `FromParquetSchema` (`arrow/schema.h:73`) | Parquet→Arrow schema | 处理 rep/def level 重建嵌套 |
| `TransferZeroCopy` (`arrow/reader_internal.cc:450`) | Parquet buffer→ArrayData | 零拷贝边界 |
</details>

## 核心实现

### Thrift 元数据 vs 自定义 page encoding

**决策**：metadata 用 Thrift，data 用自定义 page encoding。**为什么**：metadata 是结构化的 schema-like 数据，需版本演进与前向/后向兼容，Thrift `TCompactProtocol` 紧凑且字段可选；data 是同质高吞吐数值/字节，需极致压缩与 SIMD 友好解码，Thrift 通用序列化开销过大。自定义 encoding（RLE/Bit-Packing/Delta）针对数据特征特化——RLE 对低基数列极度有效，Delta 对递增整数有效。`types.h:43-49` 注释明说维护独立 enum 以避免对 Thrift 头文件的传递依赖（metadata 类用 PIMPL 隔离 Thrift，`metadata.h` 头不暴露 Thrift 类型）。

### Page 迭代与 encoding 策略

`PageReader`（`column_reader.h:169`）是抽象迭代器，`NextPage()` 返回 `shared_ptr<Page>`，EOS 返 nullptr。`SerializedPageReader`（`column_reader.cc:255`）从字节流反序列化 Thrift `PageHeader`、解密、解压生成 `Page`。`DataPage`（`column_page.h:67`）是列数据最小单位，携带 `EncodedStatistics`（min/max/null_count）。**Page 作为最小单位的意义**：谓词可下推到 page 级——`PageReader::set_data_page_filter`（`column_reader.h:160`）的回调接收 `DataPageStats`，若 page 的 min/max 不满足 filter，整个 page 跳过无需解压解码，对大文件范围查询至关重要。`ColumnChunkMetaData::GetColumnIndexLoc`/`GetOffsetIndexLoc`（`metadata.h:159`）提供 Page Index，可定位目标 page 而非线性扫描。encoding 由 `MakeDecoder`（`decoder.cc:2380`）按 `(Type,Encoding)` 分发：`PLAIN`→`PlainDecoder`、`DELTA_BINARY_PACKED`→`DeltaBitPackDecoder`、`RLE_DICTIONARY`→`DictDecoder` 等。`ColumnReaderImplBase` 持 `decoders_` map 按 encoding 缓存 decoder（同一列不同 page 可能用不同 encoding）。

### 字典编码

`DictEncoder`/`DictDecoder`（`encoding.h:209-242/348-390`）把重复值去重为字典 + bit-packed 索引。低基数列（string 枚举）只存唯一值一次，data page 中存窄位宽索引，省大量空间。`ConfigureDictionary`（`column_reader.cc:831`）处理字典页——先 PLAIN 解码字典值，再建 `DictDecoder` 并 `SetDict`。Arrow 集成：`DictDecoder::InsertDictionary`/`DecodeIndices` 直接写 `arrow::Dictionary32Builder`，实现 Parquet dictionary→Arrow dictionary 零拷贝。

### Parquet↔Arrow schema 转换

`FromParquetSchema`/`ToParquetSchema`（`arrow/schema.h:73-86`）做双向转换。**难点**：Parquet 用 repetition/definition levels 的**扁平叶节点**表示嵌套，Arrow 用递归 `List<T>`/`Struct<T>`；转换需从叶节点的 rep/def levels 重建嵌套结构。List 有 1-level/2-level/3-level 三种编码（`ResolveList`，`arrow/schema.cc:709` 检测实际编码）。Map 需校验 key required。INT96→timestamp、ConvertedType→LogicalType 等类型映射不一一对应。`SchemaManifest`（`arrow/schema.h:106`）维护列索引↔字段树映射，`LevelInfo` 记录每节点 max_def/max_rep level。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Iterator/Generator | `PageReader::NextPage`（`column_reader.h:169`）+ `RowGroup(i)` | 顺序读，支持预取与 page 级跳过 |
| Strategy | `MakeDecoder`/`MakeEncoder`（`decoder.cc:2380`/`encoder.cc:1769`） | 不同 encoding 的编解码策略 |
| Visitor | `Node::Visitor`（`schema.h:138`）+ 编译期 `EncodingTraits` | 类型分发，schema 转换 |
| PIMPL | metadata 全类（`metadata.h`） | 隔离 Thrust，头不传递依赖 |
| Template + Trait | `EncodingTraits<DType>`（`encoding.h:62`） | Parquet 物理类型↔Arrow 类型/builder 编译期映射 |

## 模块间交互

依赖**核心类型**（`Decoder::DecodeArrow` 直接写 `arrow::ArrayBuilder`，`ReadTable` 返回 `arrow::Table`，`ColumnWriter::WriteArrow` 直接从 `arrow::Array` 写）与 **io**（`Open` 接 `arrow::io::RandomAccessFile`，`PreBuffer` 用 `io::CacheOptions` 范围预取）。Thrift 是外部依赖（`thrift_internal.h` 封装）。被 **dataset** 使用——`ParquetFileReader` 的 `PreBuffer`/`GetReadRanges`/`set_data_page_filter` 专为 dataset 的谓词下推/列裁剪设计。`encryption/` 子模块提供 AES-GCM 页加密（`CryptoContext` 传入 `PageReader::Open`）。交互方式：函数调用 + 迭代器。

## 扩展方式

- **新增 encoding**：改 `types.h`（`Encoding::type` 枚举）、`encoding.h`（`EncodingTraits`/接口）、`decoder.cc`+`encoder.cc`（`MakeDecoder`/`MakeEncoder` 加 `case`、实现类）、`column_reader.cc`（`InitializeDataDecoder` switch，`:968`）、`column_writer.cc`（encoding 选择）、`properties.h`（`WriterProperties` 选项）。
- **支持新物理类型**：改 `types.h`（`Type::type`+`type_traits`+`PhysicalType`）、`encoding.h`（`EncodingTraits` 特化）、`decoder.cc`+`encoder.cc`（各 encoding 的实现+工厂 case）、`column_reader.cc`+`column_writer.cc`（`Make` switch）、`schema.cc`、`statistics.cc`、`arrow/schema.cc`+`reader.cc`+`writer.cc`（Arrow 转换）。
- **新增 page 类型**（如 `DataPageV3`）：改 `column_page.h`（子类）、`types.h`（`PageType::type`）、`column_reader.cc`（`NextPage` 分发+`HasNextInternal`）。
