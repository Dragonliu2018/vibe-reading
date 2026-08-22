---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "I/O、磁盘与压缩"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "ReadBuffer", "IDisk", "Compression", "栈式I/O"]
description: "ClickHouse I/O、磁盘与压缩源码解读——栈式 ReadBuffer/WriteBuffer、IDisk 磁盘抽象、按 block 压缩与编解码工厂。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/IO/` + `src/Disks/` + `src/Compression/` 构成 ClickHouse 的存储 I/O 栈。`ReadBuffer`/`WriteBuffer` 是读写抽象（栈式装饰器，可层层包压缩/解密/缓冲）；`Disks` 抽象本地/远程磁盘；`Compression` 实现编解码。它独立成模块因为 I/O 层栈式组合独立于存储引擎——MergeTree 只拿到一个 `ReadBuffer`，不关心背后是本地文件还是 S3 HTTP。

## 模块架构

```text
src/IO/
  ├─ ReadBuffer.h/WriteBuffer.h   ── 读写 buffer 抽象基类（virtual read/write/nextImpl）
  ├─ ReadHelpers.h/WriteHelpers.h ── 类型化读写辅助（writeIntBinary/readFloatText...）
  ├─ ReadBufferFromFile.h          ── 文件读 buffer
  ├─ WriteBufferFromOStream.h      ── 流写 buffer
  └─ Operators.h                   ── 流式操作符（<< >>）
src/Disks/
  ├─ IDisk.h                      ── 磁盘抽象接口（readFile/writeFile/exists）
  ├─ DiskFactory.h/.cpp           ── 磁盘工厂（注册 local/s3/hdfs）
  ├─ DiskLocal.h                  ── 本地磁盘
  ├─ DiskObjectStorage.h          ── 对象存储磁盘（S3/Azure）
  └─ IDiskTransaction.h            ── 事务扩展
src/Compression/
  ├─ ICompressionCodec.h          ── 编解码器抽象基类
  ├─ CompressionFactory.h/.cpp    ── 编解码工厂（按名注册 LZ4/ZSTD/Gorilla/Delta）
  ├─ CompressedReadBuffer.h       ── 解压读 buffer（栈式装饰 ReadBuffer）
  ├─ CompressedWriteBuffer.h      ── 压缩写 buffer
  └─ CompressionInfo.h            ── 压缩块头（method+checksum+size）
```

## 调用链路

写入路径：
```text
MergeTreeDataWriter → IMergedBlockOutputStream
  └─ WriteBuffer → CompressionCodec::compress → IDisk::writeFile
     （栈：CompressedWriteBuffer 包 WriteBufferFromFile 包 DiskLocal）
```

读取路径：
```text
IDisk::readFile → prepareRead(ReadPipeline) → build() → ReadBufferFromFileBase
  └─ CompressedReadBufferBase::readCompressedData → CompressionCodec::decompress
     └─ ReadBuffer → 原始数据
     （栈：CompressedReadBuffer 包 ConcatSeekableReadBuffer 包 ReadBufferFromFile 包 DiskLocal）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ReadBuffer::nextImpl` in `ReadBuffer.h` | 填充内部 buffer | 虚函数，子类实现 |
| `IDisk::readFile` in `IDisk.h` | 读文件 | 返回 ReadPipeline（可插拔阶段） |
| `DiskFactory::get` in `DiskFactory.h` | 按名查磁盘类型 | 工厂+注册表 |
| `CompressionCodec::compress/decompress` | 编解码 | 按 block |
| `CompressionFactory::get` in `CompressionFactory.h` | 按名查编解码 | 单例+注册表 |

</details>

## 核心实现

### 栈式 ReadBuffer/WriteBuffer

```cpp title="src/IO/ReadBuffer.h"
class ReadBuffer {
    Buffer buffer;            // 内部缓冲区
    Position pos;            // 当前读位置
    Buffer::Iterator working_buffer_end;
    virtual bool nextImpl() = 0;   // 填充 buffer，子类实现
public:
    bool next() { pos = working_buffer_begin; return nextImpl(); }
    bool eof() const { return !nextAllowed; }
};
```

ClickHouse 的 I/O 用栈式装饰器：`CompressedReadBuffer` 包 `ConcatSeekableReadBuffer` 包 `ReadBufferFromFile`。上层调 `read()`，下层从文件读，经解压层还原数据。每层只实现 `nextImpl()` 填充自己的 buffer，上层消费。这种组合可任意叠加——解压、解密、缓冲、压缩按需组合，无需改任一层。

`ReadHelpers`/`WriteHelpers` 提供类型化辅助：`writeIntBinary(i, buf)`、`readFloatText(s, buf)`、`writeString(s, buf)` 等，配合流式操作符 `buf << i << s`。

### IDisk 与磁盘抽象

```cpp title="src/Disks/IDisk.h"
class IDisk {
    virtual std::unique_ptr<ReadBufferFromFileBase> readFile(...) const = 0;
    virtual std::unique_ptr<WriteBufferFromFileBase> writeFile(...) const = 0;
    virtual bool exists(const String & path) const = 0;
    virtual void createDirectory(const String & path) = 0;
};
```

`IDisk` 让本地磁盘（`DiskLocal`）与对象存储（`DiskObjectStorage`，S3/Azure）统一接口。`DiskFactory`（`src/Disks/DiskFactory.h`）单例注册磁盘类型，`config.xml` 的 `<disks>` 节按 type 创建对应磁盘。

`IDisk::readFile` 不直接返回 `ReadBuffer`，而是先 `prepareRead` 填充 `ReadPipeline` 再 `build()` 组装（`src/Disks/IDisk.cpp:81`）——允许磁盘在读链插多个阶段：`DiskLocal` 可插 mmap 读取，`DiskObjectStorage` 可插 HTTP 读取+缓存检查，调用方只看到一个 `ReadBufferFromFileBase`。

### 按 block 压缩

```cpp title="src/Compression/ICompressionCodec.h"
class ICompressionCodec {
    virtual UInt32 getMethodCode() const = 0;
    virtual UInt32 getMaxCompressionDataSize(UInt32 uncompressed_size) const = 0;
    virtual UInt32 doCompressData(const char * source, UInt32 size, char * dest) const = 0;
    virtual UInt32 doDecompressData(const char * source, UInt32 size, char * dest, UInt32 uncompressed_size) const = 0;
};
```

压缩按 block 而非整文件——每个压缩块有头（method+checksum+compressed_size+uncompressed_size），可独立解压、随机跳转。`CompressionCodecMultiple`（`CompressionCodecMultiple.h:8`）支持多级压缩 `CODEC(Delta, LZ4)`——`doCompressData` 依次每 codec，`doDecompressData` 反向。

`CompressionFactory`（`src/Compression/CompressionFactory.h`）单例按名注册 LZ4/ZSTD/Gorilla/Delta 等。`CompressedReadBufferBase::readCompressedData`（`src/Compression/CompressedReadBufferBase.cpp:175`）读每块后 `validateChecksum`，校验和不匹配且块<1MB 时逐 bit 翻转测试判断单 bit 翻转（硬件故障）并给 RAM/磁盘/CPU 故障诊断——应对静默数据损坏。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 装饰器 | 栈式 buffer（Compressed 包 ReadBuffer 包 File） | 多层 I/O 变换可任意组合 |
| 工厂 | `DiskFactory`/`CompressionFactory` | 按名注册/查找磁盘与编解码 |
| 策略 | 不同编解码实现 ICompressionCodec | LZ4/ZSTD/Gorilla 各为策略 |
| 建造者 | `ReadPipeline`（prepareRead→build） | 读链可插拔多阶段 |

## 重要设计决策

### 为什么 ReadBuffer/WriteBuffer 用栈式装饰器而非一层

I/O 需多层变换（压缩、解密、缓冲、网络），栈式装饰器让每层只实现 `nextImpl()`，组合任意叠加而不改任一层。单层 buffer 无法表达"解压一段压缩数据需先从文件读"的嵌套。

### IDisk 抽象为什么让 S3 和本地统一

MergeTree 只拿 `ReadBuffer`，不关心背后是本地还是 S3——存储后端可替换。`ReadPipeline` 机制让磁盘在读链插阶段（mmap/HTTP/缓存），调用方透明。

### 压缩为什么按 block 而非整文件

按 block 压缩可独立解压、随机跳转（读取特定 granule 只解压相关块），契合 MergeTree 的 mark 索引按 granule 跳跃读取。整文件压缩需从头解压无法随机访问。

## 扩展方式

新增存储后端（如 GCS）：建 `src/Disks/DiskGCS.h/.cpp` 继承 `IDisk`，实现 `readFile`/`writeFile`/`exists` 等；在 `DiskFactory` 注册；`config.xml` 配 `<disk type="gcs">`。新增压缩算法：建 `src/Compression/CompressionCodecMy.h` 继承 `ICompressionCodec`，实现 `doCompressData`/`doDecompressData`；在 `CompressionFactory` 注册；`registerCompressionCodecs` 调用。

## 模块间交互

IO 被几乎所有模块使用（630+ 次 include `WriteHelpers`/`ReadHelpers`）。Disks 被 `Storages`（MergeTree 落盘读盘）使用。Compression 被 IO（`CompressedReadBuffer`/`CompressedWriteBuffer`）与 Storages 使用。`Common`（Allocator/PODArray）是底层依赖。`ReadPipeline` 让磁盘在读链插入阶段而不影响 MergeTree 的读取逻辑。
