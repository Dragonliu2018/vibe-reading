---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "I/O 与文件系统"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "I/O", "文件系统"]
description: "Arrow I/O 接口与文件系统抽象——RandomAccessFile::ReadAt 零拷贝、mmap/pread、BufferedInputStream 装饰器与本地/S3 文件系统"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

`cpp/src/arrow/io/`（~12k 行）与 `cpp/src/arrow/filesystem/`（~27k 行）是所有文件相关模块（ipc、parquet、dataset、flight）的底座。它分两层抽象：**io** 是字节流层（随机读/缓冲读/可写流/内存映射），**filesystem** 是路径层（打开文件、列目录、跨本地/S3/HDFS 透明访问）。两层解耦让"读字节"与"找文件"独立演化——同一 `RandomAccessFile` 接口背后可以是本地 mmap、S3 HTTP Range、或内存 buffer。

## 模块架构

```
┌──────────── io 字节流层（io/interfaces.h）────────────┐
│  FileInterface ← InputStream / OutputStream            │
│   ├─ RandomAccessFile  ReadAt/ReadAsync/GetSize       │
│   │    ├─ ReadableFile   pread 系统调用               │  file.h
│   │    ├─ MemoryMappedFile  mmap 零拷贝              │  file.h
│   │    └─ BufferReader   内存零拷贝读                 │  memory.h
│   ├─ WritableFile / FileOutputStream                  │  file.h
│   ├─ BufferOutputStream / FixedSizeBufferWriter       │  memory.h
│   └─ CRCP 并发包装: InputStreamConcurrencyWrapper     │  concurrency.h
│        (shared_guard 读并发 / exclusive_guard 写)    │
│  装饰器: BufferedInputStream/BufferedOutputStream     │  buffered.h
│  默认执行器: default_io_context / IOThreadPool        │  type_fwd.h
└──────────────────────────────────────────────────────-┘
┌──────────── filesystem 路径层（filesystem/filesystem.h）┐
│  FileSystem  OpenInputFile/OpenOutputStream/GetFileInfo│
│   ├─ LocalFileSystem  use_mmap 开关                    │  localfs.h
│   ├─ S3FileSystem                                     │  s3fs.h
│   ├─ SubTreeFileSystem  前缀委托                     │  filesystem.h
│   └─ SlowFileSystem  测试用延迟注入                   │  filesystem.h
│  FileInfo / FileSelector / FileType enum              │
│  注册: FileSystemFactory / FileSystemRegistrar         │
└──────────────────────────────────────────────────────-┘
```

## 调用链路

从打开一个文件到读取一段字节：

```
FileSystem::OpenInputFile(path)            filesystem/filesystem.h
  └─ LocalFileSystem::OpenInputFile        localfs.cc  OpenInputStreamGeneric
       └─ use_mmap ? MemoryMappedFile : ReadableFile(pread)
RandomAccessFile::ReadAt(offset, n)        io/interfaces.h
  └─ ReadableFile: pread(fd, buf, n, offset)  POSIX 系统调用
  └─ MemoryMappedFile: 直接返回映射区指针的 Buffer（零拷贝）
  └─ BufferReader: 直接 SliceBuffer 内存中的 buffer（零拷贝）
→ 返回 shared_ptr<Buffer>
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `FileSystem::OpenInputFile` (`filesystem.h`) | 打开文件读 | 返回 `RandomAccessFile` |
| `RandomAccessFile::ReadAt` (`io/interfaces.h`) | 随机读一段 | 返回 `Buffer`（零拷贝） |
| `RandomAccessFile::ReadAsync` (`io/interfaces.cc`) | 异步读 | 默认实现走 executor |
| `MemoryMappedFile` (`io/file.h`) | mmap 读 | 内核页映射，零拷贝 |
| `ReadableFile::WillNeed` (`io/file.h:114`) | 预取提示 | `posix_fadvise`（实现待核实） |
| `BufferedInputStream::Create` (`io/buffered.h:109`) | 包装缓冲 | 装饰器，减少往返 |
| `LocalFileSystem` (`localfs.h`) | 本地 FS | `use_mmap` 开关选 mmap/pread |
</details>

## 核心实现

### RandomAccessFile 抽象与 ReadAt

`RandomAccessFile`（`io/interfaces.h`）核心方法 `ReadAt(offset, n)` 返回 `shared_ptr<Buffer>`。**为什么用 ReadAt 返回 Buffer 而非填入调用者 buffer**：零拷贝——mmap/BufferReader 可直接返回指向已有内存的 Buffer（`SliceBuffer`），无需拷贝；且支持并发预读与谓词下推的区间读。`ReadAsync` 的默认实现（`io/interfaces.cc`）把同步 `ReadAt` 提交到 `IOContext` 的 executor 异步化，子类可覆盖更高效路径。`ReadManyAsync` 批量并发读多个区间。

### mmap 与 pread 零拷贝路径

`LocalFileSystem`（`localfs.h`）的 `OpenInputStreamGeneric`（`localfs.cc`）按 `use_mmap` 选项选后端：`MemoryMappedFile`（mmap，内核把文件页映射进进程地址空间，`ReadAt` 直接返回映射区指针的 Buffer，全程零拷贝）或 `ReadableFile`（pread 系统调用，数据从内核页缓存拷贝到用户 buffer）。**为什么两条路径**：mmap 适合顺序大文件读、零拷贝但映射生命周期管理复杂；pread 适合随机小读、不占地址空间。`WillNeed`（`file.h:114`）用 `posix_fadvise(POSIX_FADV_WILLNEED)` 提示内核预取（具体平台实现待核实）。

### BufferedInputStream 装饰器

`BufferedInputStream`（`buffered.h:109`）包装任意 `InputStream`，内部维护缓冲区，`Read` 时批量读取减少系统调用/网络往返。对 S3 等高延迟后端尤其重要：

```cpp title="S3 读缓冲示例"
auto raw_stream = s3_fs->OpenInputStream(path);
auto buffered = BufferedInputStream::Create(64 * 1024, default_memory_pool(), std::move(raw_stream));
// buffered->Read() 批量预读，减少 HTTP Range 往返
```

`BufferedOutputStream`（`buffered.h:47`）类似，缓冲写后批量 flush。`CompressedInputStream`/`CompressedOutputStream`（`type_fwd.h` 前向声明）也是装饰器，中间做压缩/解压（实现细节待核实）。

### FileSystem 抽象

`FileSystem`（`filesystem/filesystem.h`）统一本地与云存储：`OpenInputFile`/`OpenOutputStream`/`GetFileInfo`/`GetFileInfoSelector`（列目录）。`FileSelector` 描述目录遍历选项（递归/基准/allow_not_found）。`SubTreeFileSystem` 给路径加前缀委托给底层 FS（如 `s3://bucket/prefix` 的 prefix 处理）。`SlowFileSystem` 给所有操作注入可配置延迟，用于测试超时。注册靠 `FileSystemFactory`/`FileSystemRegistrar`。**为什么抽象**：让上层（dataset/parquet）用同一套 `FileSource`/`FileSystem` 接口透明访问本地或云，新增后端只需实现 `FileSystem` 子类。

### 并发包装

`InputStreamConcurrencyWrapper`/`RandomAccessFileConcurrencyWrapper`（`io/concurrency.h`）用 CRTP 给非线程安全的流实现加并发安全：读操作用 `shared_guard`（允许多读并发），写/seek 用 `exclusive_guard`（独占）。这样底层简单实现无需自己处理锁，包装器统一提供并发语义。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 接口抽象 | `FileInterface`/`RandomAccessFile`（`io/interfaces.h`） | 字节流后端可替换 |
| Adapter | `LocalFileSystem`/`S3FileSystem`（`localfs.h`/`s3fs.h`） | 同一 `FileSystem` 接口适配不同后端 |
| Decorator | `BufferedInputStream`/`BufferedOutputStream`（`buffered.h`） | 缓冲增强不改接口 |
| Strategy | `use_mmap` 选 mmap/pread（`localfs.cc`） | 读策略运行时选 |
| CRTP | `InputStreamConcurrencyWrapper<Derived>`（`concurrency.h`） | 零开销给实现加并发安全 |

## 模块间交互

被几乎所有文件相关模块依赖：**ipc**（输出目标 `OutputStream`/`RandomAccessFile`）、**parquet**（`Open` 接 `RandomAccessFile`，`PreBuffer` 用 `CacheOptions`）、**dataset**（`FileSource` 持路径+`FileSystem`）、**flight**（`StopToken` 交互取消）。依赖**核心类型**（`Buffer`/`Result`/`Status`）。`S3FileSystem` 的 `OpenInputFile` 具体实现（直接继承还是经 ConcurrencyWrapper）待核实；`GcsFileSystem`/`AzureFileSystem` 前向声明于 `type_fwd.h`，接口与 S3 一致性待核实。交互方式：函数调用，I/O 任务在独立 `IOContext` 线程池。

## 扩展方式

- **自定义 FileSystem**：继承 `FileSystem`（`filesystem/filesystem.h`）实现 `OpenInputFile`/`OpenOutputStream`/`GetFileInfo`/`GetFileInfoSelector`，注册到 `FileSystemFactory`/`FileSystemRegistrar`。参考 `LocalFileSystem`（`localfs.cc`）。
- **自定义 RandomAccessFile**：继承 `RandomAccessFile` 实现 `ReadAt`/`GetSize`/`Close`，或继承 `InputStream` 实现 `Read`。可用 `InputStreamConcurrencyWrapper` 加并发安全。
- **注入测试延迟**：用 `SlowFileSystem`（`filesystem.h`）包装真实 FS，给操作加延迟测超时与背压。
