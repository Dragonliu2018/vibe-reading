---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "IPC 序列化"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "IPC", "FlatBuffers"]
description: "Arrow IPC 序列化——FlatBuffers 元数据描述 buffer 布局、原始 body 零拷贝、stream/file 双模式与字典/variadic buffer 处理"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

`cpp/src/arrow/ipc/`（~19k 行）实现 Arrow IPC 格式的读写。它把内存中的 `RecordBatch`/`Schema` 转成字节流，反之亦然——但关键在于**元数据与数据分离**：用 FlatBuffers 描述"每个 buffer 在哪、多长"（metadata），而数据本身是原始 buffer（body），不做序列化转换。这让 Arrow 数据在进程/语言间可以**零拷贝**共享：读端只需按 metadata 的 offset/length 把 body 区段映射成 `ArrayData`。它是 Flight RPC 的序列化引擎，也是 Parquet 之外 Arrow 原生数据交换的载体。

## 模块架构

```
┌────────────────── 写入端 ──────────────────┐
│  RecordBatchWriter (writer.h) 抽象基类      │
│   ├─ StreamWriter   顺序流，无 footer        │
│   └─ FileWriter     带 Footer，随机访问      │
│        └─ RecordBatchSerializer (writer.cc) │
│             ├─ 序列化 metadata (FlatBuffers) │
│             ├─ 对齐 body buffers (8/64 字节) │
│             └─ 写出 Message = metadata+body  │
└──────────────────┬──────────────────────────-┘
                   │ 产出
┌──────────────────▼──────────────────────────┐
│  Message (message.h)                         │
│   ├─ metadata: FlatBuffer (Schema/RecordBatch│
│   │            /DictionaryBatch)             │
│   └─ body: 原始 buffers 拼接                  │
│  IpcPayload (writer.h) / IpcPayloadWriter    │
└──────────────────┬──────────────────────────-┘
                   │ 读取
┌──────────────────▼──────────────────────────┐
│  RecordBatchReader (reader.h) 抽象基类       │
│   ├─ StreamReader  顺序读                    │
│   └─ FileReader     读 Footer 后随机定位     │
│        └─ ArrayLoader/RecordBatchLoader     │
│             (reader.cc) 按 metadata 的       │
│              offset/length 零拷贝映射 body    │
└─────────────────────────────────────────────-┘
  配置：IpcWriteOptions/IpcReadOptions (options.h)  compression/alignment
  字典：DictionaryMemo (dictionary.h)
```

## 调用链路

写入一个 `RecordBatch`：

```
StreamWriter::WriteRecordBatch(batch)           writer.cc
  └─ RecordBatchSerializer::VisitRecordBatch
       ├─ 序列化 Schema → FlatBuffer metadata
       ├─ 遍历列：写 FieldNode(length, null_count) + Buffer(offset,length)
       ├─ 对齐各 buffer 到 8/64 字节边界（padding）
       └─ body = 拼接所有原始 buffer
  └─ Message = {metadata, bodyLength, body}
  └─ payload_writer_->Write(payload)

FileWriter 额外：Close() 时写 Footer(version, schema, dictionaries[], recordBatches[]) 到末尾 + magic
```

读取（File 模式，随机访问）：

```
RecordBatchFileReaderImpl::ReadFooter()         reader.cc:1878
  └─ 读末尾 10 字节（6 magic + 4 footer_length）
  └─ 验证 magic，回读 Footer FlatBuffer
  └─ Footer.recordBatches[] = [Block(offset, metaDataLength, bodyLength)]
ReadRecordBatch(i)
  └─ Block = Footer.recordBatches[i]
  └─ 定位到 offset，读 metadata + body
  └─ ArrayLoader::Load: 按 metadata 的 Buffer(offset,length)
       └─ 零拷贝切 body 子段 → ArrayData::buffers[]
  └─ RecordBatchLoader 组装 RecordBatch
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `NewStreamWriter`/`NewFileWriter` (`writer.h`) | 建写入器 | stream 无 footer，file 有 |
| `RecordBatchSerializer` (`writer.cc`) | batch→metadata+body | FlatBuffers 元数据 + 原始 body |
| `WriteRecordBatch` (`writer.h`) | 写一个 batch | body buffer 对齐 padding |
| `RecordBatchFileReaderImpl::ReadFooter` (`reader.cc:1878`) | 读文件末尾 footer | magic + length 反向定位 |
| `ArrayLoader::Load` (`reader.cc`) | body→ArrayData | 按 offset/length 零拷贝映射 |
| `kIpcContinuationToken` (`metadata_internal.h`) | 流中分隔消息 | 0xFFFFFFFF 标记后跟 length |
</details>

## 核心实现

### FlatBuffers 元数据 + 原始 body 的零拷贝

`format/Message.fbs` 的 `RecordBatch` table 描述了 wire 布局：

```fbs title="format/Message.fbs RecordBatch（精简）"
table RecordBatch {
  length: long;                    // 行数
  nodes: [FieldNode];              // 每字段：length + null_count
  buffers: [Buffer];               // 每缓冲区：offset + length（相对 body 起始）
  compression: BodyCompression;    // 可选压缩
  variadicBufferCounts: [long];    // BinaryView/Utf8View 的变长 buffer 数
}
struct FieldNode { length: long; null_count: long; }   // 固定 16 字节
struct Buffer { offset: long; length: long; }          // 固定 16 字节
table Message { version; header: MessageHeader; bodyLength: long; }
```

**核心机制**：metadata 是一个"目录"——告诉读端 body 里第几个 buffer 在 offset 处、多长。body 是各列原始 buffer 按序拼接的连续字节。读端用 `ArrayLoader` 按 `Buffer.offset/length` 在 body 上切片（`SliceBuffer` 零拷贝），直接作为 `ArrayData::buffers[]`——**没有任何反序列化**。这就是 Arrow IPC 零拷贝的本质。**为什么 metadata 用 FlatBuffers**：FlatBuffers 本身零拷贝、前向兼容（字段可选）、跨语言（所有 Arrow 实现共享同一 `.fbs`）；而 body 不用任何序列化格式，因为它是同质的数值/字节流，任何包装都是纯开销。

### stream vs file 模式

两种模式对应两种使用场景：**stream 模式**（`StreamWriter`/`StreamReader`）是顺序的——先写 Schema 消息，再连续写 RecordBatch 消息，无 footer，适合管道/socket 流式传输；**file 模式**（`FileWriter`/`FileReader`）在末尾写一个 `Footer`（`format/File.fbs`），内含所有 RecordBatch 的 `Block(offset, metaDataLength, bodyLength)` 列表，读端先读 footer 即可随机访问任意 batch。`ReadFooter`（`reader.cc:1878`）从文件末尾读 10 字节（6 字节 magic `ARROW1` + 4 字节 footer_length），验证 magic 后回读 footer。**为什么分两种**：流只能顺序读（socket/管道），而文件支持随机访问——footer 让你无需扫描全文件就能定位第 N 个 batch。

### 字典编码与 variadic buffers

**字典**：`DictionaryMemo`（`dictionary.h`）跟踪哪些字段是字典编码的，写字典值用 `DictionaryBatch`（`isDelta` 标记增量追加 vs 全量替换）。读端按 `DictionaryBatch.id` 重建字典并挂到对应 `ArrayData::dictionary`。**Variadic buffers**：`BinaryView`/`Utf8View` 类型用变长数量的 data buffer（一个 views buffer + 多个 data buffer），`RecordBatch.variadicBufferCounts` 记录每字段有几个 variadic buffer。写入端（`writer.cc:500`）把 views buffer 推入 body，设 `variadic_buffer_counts = buffers.size()-2`，再推所有 data buffer；读端（`reader.cc:267`）`GetVariadicCount(i)` 预分配 buffer 槽位。压缩（lz4/zstd）可选，作用于 body。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 零拷贝（metadata 描述 + 原始 body） | `RecordBatchSerializer`+`ArrayLoader`（`writer.cc`/`reader.cc`） | body 即 `ArrayData`，无反序列化 |
| FlatBuffers 前向兼容 | `format/Schema.fbs`/`Message.fbs`/`File.fbs` | 字段可选，跨语言版本演进 |
| Template Method | `RecordBatchWriter` 写入骨架 | stream/file 共用流程，差异在 footer |
| Adapter | `IpcPayloadWriter`/`IpcPayloadReader` | 适配不同输出/输入目标 |

## 模块间交互

依赖**核心类型**（`Schema`/`RecordBatch`/`ArrayData`/`Buffer`）与 **io**（输出目标 `OutputStream`/`RandomAccessFile`）。被 **flight** 用作序列化引擎（`RecordBatchStream` 内部用 `ipc::RecordBatchWriter`，`ClientStreamReader` 用 `RecordBatchStreamReader`）；被 **compute** 用于序列化 `Expression`（AST 编码为 RecordBatch metadata）。是 Arrow 原生数据交换的标准载体。

## 扩展方式

- **自定义压缩**：实现 `arrow::util::Codec` 子类（在 `arrow/util/compression.h` 注册），通过 `IpcWriteOptions.compression` 指定。
- **读 Footer 做随机访问**：`RecordBatchFileReader` 的 `num_record_batches()`+`ReadRecordBatch(i)`，按需读而非顺序。
- **自定义 IPC payload 目标**：实现 `IpcPayloadWriter`（`writer.h`），把 `IpcPayload` 写到任意 sink（内存/网络）。
