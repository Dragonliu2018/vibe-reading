---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "Overview"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "列式格式", "内存分析"]
description: "Apache Arrow C++ 源码架构解读——通用列式内存格式与多语言工具箱，零拷贝内存模型、计算内核、Acero 流式执行引擎、IPC/Flight 传输、Parquet 与 Dataset 的完整内幕"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 26.0.0.dev · **协议** Apache 2.0 · **语言** C++17（核心）+ Python/Ruby/R/GLib · **代码量** ~785,000 行 C++ · **仓库** [GitHub](https://github.com/apache/arrow)
>
> **解读基线** commit [`2c35b59546`](https://github.com/apache/arrow/commit/2c35b59546913987fdcfb6966f9035a6ea89c1e0)（2026-08-21，`main` 分支快照，26.0.0 开发中，最新 release 为 25.0.1）

---

## 总览

### 项目简介

Apache Arrow 是一个**通用列式内存格式与多语言工具箱**，用于快速数据交换与内存分析。它解决的核心问题是：数据系统之间交换数据时，序列化/反序列化与行式↔列式转换的反复拷贝吞噬了分析性能。Arrow 用一套**语言无关的列式内存规范**统一了内存表示——只要两个系统都讲 Arrow，数据就可以在进程间、语言间、机器间以**零拷贝**方式流转，CPU 的 SIMD 向量化计算也能直接作用在连续的列缓冲区上。

核心价值三层：**列式内存格式**（`Buffer`/`Array`/`RecordBatch`）让分析负载高效；**IPC 与 Flight RPC** 让数据跨进程/跨网络零拷贝传输；**计算内核与 Acero 执行引擎** 让查询可以直接在 Arrow 内存上求值。典型场景包括数据湖查询引擎（Dremio、InfluxDB 3、GreptimeDB 都建立在 Arrow/DataFusion 之上）、列式文件读写（Parquet）、以及跨语言数据交换（Python↔R↔Java）。

**项目边界**：Arrow 负责内存格式、序列化与计算原语，**不是**数据库或查询引擎本身——它提供的是上层系统（DataFusion、Spark、Pandas）构建分析能力的"列式地基"。仓库内的 Java/Rust/Go/JS 等语言实现维护在各自独立仓库（README 以 `↗` 标注），本仓库（`cpp/`）是**参考实现**，其它语言绑定大多直接或间接包装它。

### 功能矩阵

| 特性 | 实现目录 | 说明 |
|------|---------|------|
| 列式类型系统 | `cpp/src/arrow/type.h`、`array/` | DataType/Field/Schema/Array/RecordBatch/Table |
| 零拷贝内存管理 | `cpp/src/arrow/buffer.h`、`memory_pool.cc` | 引用计数 Buffer + 可替换 MemoryPool（jemalloc/mimalloc） |
| 计算内核 | `cpp/src/arrow/compute/` | Function/Kernel 调度 + Expression AST，~131k 行 |
| 流式执行引擎 | `cpp/src/arrow/acero/` | push-based ExecPlan，filter/project/join/aggregate |
| IPC 序列化 | `cpp/src/arrow/ipc/` | FlatBuffers 元数据 + 原始 body，stream/file 两种 |
| Flight RPC | `cpp/src/arrow/flight/` | gRPC streaming 数据传输 + 中间件/认证 |
| Dataset API | `cpp/src/arrow/dataset/` | 多文件多格式统一扫描 + 谓词/投影下推 |
| Parquet 读写 | `cpp/src/parquet/` | 列式文件格式，page/encoding/metadata，~93k 行 |
| I/O 与文件系统 | `cpp/src/arrow/io/`、`filesystem/` | 随机读/缓冲/mmap + 本地/S3/HDFS 抽象 |
| Gandiva JIT | `cpp/src/gandiva/` | LLVM 表达式编译器，filter/project 的机器码生成 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C++17 | 核心 | 参考实现语言，`cpp/` 目录 |
| FlatBuffers | 核心 | IPC 元数据序列化（`format/Schema.fbs`、`Message.fbs`、`File.fbs`） |
| Thrift | 核心 | Parquet metadata 序列化（`parquet/thrift_internal.h`） |
| gRPC + Protobuf | 核心 | Flight RPC 传输（`format/Flight.proto`） |
| LLVM | 可选 | Gandiva JIT 编译器 |
| jemalloc / mimalloc | 可选 | MemoryPool 后端（运行时 `ARROW_DEFAULT_MEMORY_POOL` 选择） |
| RapidJSON / SimDJSON | 可选 | JSON 读取加速 |
| OpenSSL / AES-GCM | 可选 | Parquet 页加密、Flight TLS |
| CMake ≥ 3.25 | 构建 | C++ 构建系统（`cpp/CMakeLists.txt`，`ARROW_VERSION "26.0.0-SNAPSHOT"`） |
| Cython | 绑定 | pyarrow Python 绑定（`python/`，~81k 行） |

### 版本历史

Arrow 主版本号与语言无关地统一推进。当前 `main` 处于 **26.0.0 开发线**（CMake 标注 `26.0.0-SNAPSHOT`，最近 release tag 为 `apache-arrow-25.0.1`）。近年关键里程碑：**1.0**（2020）确立列式格式稳定性；**6.0** 引入 Acero 执行引擎替代旧 `compute::ExecPlan`；**12.0** 起 Dataset API 与 Parquet 谓词下推成熟；**14.0** 引入 `BinaryView`/`Utf8View` 类型优化变长字符串；**15.0+** Flight SQL 与传输层抽象（`TransportRegistry`）成型。本解读基于 26.0.0 开发快照，反映 Acero/Compute/Dataset 的最新形态。

---

## 快速上手

以 C++ 库为例，最快看到 Arrow "跑起来" 的方式是用 CMake 构建并运行一个构建 `Array` 并序列化的最小示例。

```bash title="构建 C++ 库（最小配置）"
cd cpp
mkdir build && cd build
cmake .. -DARROW_COMPUTE=ON -DARROW_IPC=ON -DARROW_PARQUET=ON -DARROW_DATASET=ON
cmake --build . --parallel
```

一个端到端验证：构建一个 `Int32Array`，写入 IPC stream，再读回——若读出的值与写入一致，说明类型系统、内存与 IPC 链路打通：

```cpp title="quickstart.cpp"
#include "arrow/api.h"
#include "arrow/io/memory.h"
#include "arrow/ipc/reader.h"
#include "arrow/ipc/writer.h"

auto pool = arrow::default_memory_pool();
arrow::Int32Builder builder(pool);
ARROW_RETURN_NOT_OK(builder.AppendValues({1, 2, 3, 4, 5}));
std::shared_ptr<arrow::Array> arr;
ARROW_RETURN_NOT_OK(builder.Finish(&arr));
auto schema = arrow::schema({arrow::field("c", arrow::int32())});
auto batch = arrow::RecordBatch::Make(schema, arr->length(), {arr});

auto sink = arrow::io::BufferOutputStream::Create(pool).ValueOrDie();
auto writer = arrow::ipc::NewStreamWriter(sink.get(), schema).ValueOrDie();
ARROW_RETURN_NOT_OK(writer->WriteRecordBatch(*batch));
ARROW_RETURN_NOT_OK(writer->Close());
auto buffer = sink->Finish().ValueOrDie();   // 序列化完成
// 读回
auto reader = arrow::ipc::RecordBatchStreamReader::Open(
    std::make_shared<arrow::io::BufferReader>(buffer)).ValueOrDie();
std::shared_ptr<arrow::RecordBatch> roundtrip;
ARROW_RETURN_NOT_OK(reader->ReadNext(&roundtrip));
// roundtrip->column(0) 与 arr 内容一致
```

> 本仓库是库，没有"启动服务"概念；上述即"最小调用示例"。pyarrow 用户则可直接 `pip install pyarrow` 后 `import pyarrow as pa; pa.array([1,2,3])`。

---

## 架构设计解析

### 系统架构

Arrow 的整体设计围绕一个核心思想：**把"内存格式"从任何具体语言、运行时和存储格式中剥离出来，成为所有数据系统的公共契约**。这样做带来三个直接后果——数据零拷贝流转、跨语言二进制兼容、SIMD 友好的列式布局。架构自底向上分六层，下层不感知上层，上层依赖下层：

![分层架构](/vibe-reading/images/articles/arrow-internals/architecture.svg)

最底层是**核心类型与内存**（`type.h`/`buffer.h`/`memory_pool`/`array`），定义 `DataType`/`Field`/`Schema`/`Buffer`/`Array`/`RecordBatch` 等所有模块共享的列式数据结构。其上是**计算内核**（`compute`），以 `Function`/`Kernel`/`Expression` 提供类型化、可向量化的运算。再上是**执行引擎 Acero**（`acero`），用 push-based `ExecPlan` 把多个 kernel 串成流水线。**I/O 与文件格式**层（`io`/`filesystem`/`parquet`/`csv`/`json`）统一字节流与文件访问。**数据访问 Dataset**（`dataset`）是顶层编排者，用 `Scanner` 把"扫描多文件 + 下推过滤/投影"编译成一个 Acero 计划。最顶的**传输层**（`ipc`/`flight`）负责序列化与 RPC。`Gandiva` 作为右侧并行的 JIT 路径，对复杂表达式走 LLVM 编译而非 compute 的逐函数解释。`format/` 目录的 FlatBuffers/protobuf 规范是 wire format 的"唯一真相源"，`ipc`/`flight` 的元数据代码即由它生成。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|----------------------|
| 传输层 | `ipc/`、`flight/` | 把列式内存序列化或经网络传输，不改变数据语义 |
| 数据访问 | `dataset/` | 统一多文件多格式为可扫描数据集，下推谓词/投影 |
| I/O 与文件格式 | `io/`、`filesystem/`、`parquet/`、`csv/`、`json/` | 抽象字节流与路径，封装列式/行式文件编解码 |
| 执行引擎 | `acero/` | push 流水线编排多个 kernel，提供并行与背压 |
| 计算内核 | `compute/` | 类型化向量化运算的注册与调度 |
| 核心类型与内存 | `arrow/`（根）、`array/` | 列式格式的物理与逻辑表示，零拷贝内存 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Builder | `ArrayBuilder::Finish`→`FinishInternal`（`builder_base.cc:343`） | 类型各异的组装流程统一到模板方法骨架 |
| 引用计数零拷贝 | `Buffer::parent_`（`buffer.h:373`）、`SliceBuffer` | 切片/子数组共享底层内存，靠 `shared_ptr` 管理生命周期 |
| PIMPL | `Schema::Impl`、`ExecPlanImpl`、`FlightServerBase::Impl` | 隔离 Thrift/gRPC 等重依赖，缩短编译时间 |
| Visitor | `VisitTypeInline`+`MakeArray`（`array/util.cc:298`）、`TypeVisitor` | 按类型枚举 dispatch 到特化实现，是 Arrow 核心分发机制 |
| Registry | `FunctionRegistry`（`compute/registry.cc`）、`ExecFactoryRegistry`（`acero`） | 函数/节点可扩展注册，内置集在首次访问时惰性构建 |
| Template + Trait | `CTypeImpl<...>`（`type.h:551`）、`EncodingTraits<DType>`（`parquet/encoding.h`） | 编译期生成类型特化代码，避免运行时 switch 开销 |
| Decorator | `LoggingMemoryPool`/`CappedMemoryPool`（`memory_pool.h:184/254`）、`BufferedInputStream` | 包装增强（日志/限流/缓冲）而不改接口 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `Buffer` | 一段引用计数的连续内存块 | 由 `shared_ptr` 管理，切片时持 `parent_` | `ArrayData` 的 `buffers[]` 持有它 |
| `ArrayData` | 列的物理层（buffers + null 位图 + child_data + offset/length） | 不可变 struct，可被多个 `Array` 共享 | `Array` 包装它；`Datum` 直接存它 |
| `Array` | 列的逻辑访问器（强类型） | 持 `shared_ptr<ArrayData>` | `RecordBatch`/`Table` 组合多个 |
| `RecordBatch` | 同长度 `Array` 的集合 + `Schema` | 不可变 | IPC/Dataset/Acero 的基本交换单位 |
| `Datum` | 类型擦除值容器（Scalar/Array/ChunkedArray/RecordBatch/Table） | `std::variant` | compute 函数的输入输出 |
| `ExecBatch` | 一组 `Datum` + 长度，compute 的执行输入 | 短生命周期，跨 Acero 节点传递 | Acero 节点间数据载体 |
| `ExecPlan`/`ExecNode` | Acero 执行计划与节点 | 计划级，`StartProducing` 后活跃 | 节点间 `InputReceived` push 数据 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `MemoryPool` | `memory_pool.h:109` | `SystemMemoryPool`/`JemallocMemoryPool`/`MimallocMemoryPool` | `BaseMemoryPoolImpl<Allocator>` 模板策略 |
| `Function` | `compute/function.h:142` | `ScalarFunction`/`VectorFunction`/`ScalarAggregateFunction`/`HashAggregateFunction`/`MetaFunction` | `FunctionRegistry::AddFunction` |
| `RandomAccessFile` | `io/interfaces.h` | `ReadableFile`(pread)/`MemoryMappedFile`(mmap)/`BufferReader` | 工厂 + CRTP 并发包装 |
| `FileSystem` | `filesystem/filesystem.h` | `LocalFileSystem`/`S3FileSystem`/`SubTreeFileSystem` | `FileSystemFactory`/`FileSystemRegistrar` |
| `ExecNode` | `acero/exec_plan.h:125` | `SourceNode`/`MapNode`(filter/project)/`HashJoinNode`/`AggregateNode`/`SinkNode` | `ExecFactoryRegistry::AddFactory` |
| `FlightServerBase` | `flight/server.h:185` | 用户子类 override `DoGet`/`DoPut` 等 | 继承 + `TransportRegistry` 选传输 |

---

## 代码目录

```text
arrow/
├── cpp/                 # C++ 参考实现（~785k 行，本解读主体）
│   └── src/
│       ├── arrow/       # 核心库（type/buffer/memory/array + 各子模块）
│       │   ├── array/   # Array/ArrayData/Builder
│       │   ├── compute/ # 计算内核与 kernel
│       │   ├── acero/   # Acero 流式执行引擎
│       │   ├── ipc/     # IPC 序列化
│       │   ├── flight/  # Flight RPC
│       │   ├── dataset/ # Dataset/Scanner API
│       │   ├── io/      # I/O 接口（RandomAccessFile/Buffered）
│       │   ├── filesystem/ # 文件系统抽象（Local/S3）
│       │   ├── csv/ json/ # 行式文件格式
│       │   └── util/    # 基础设施（thread_pool/async_generator/bitmap_ops）
│       ├── parquet/     # Parquet 列式文件格式
│       ├── gandiva/     # LLVM JIT 表达式编译器
│       └── generated/   # 由 FlatBuffers 生成的代码
├── format/              # wire format 规范（Schema/Message/File.fbs + Flight.proto）
├── python/              # pyarrow 绑定（~81k 行）
├── r/ ruby/ c_glib/     # R/Ruby/GLib 绑定
├── ci/ dev/             # CI 与开发工具（archery）
└── testing/             # 跨语言集成测试数据
```

特殊目录：`format/` 是**协议源头**——`Schema.fbs` 的 `Type` union 定义了所有数据类型，`Message.fbs` 的 `RecordBatch`/`FieldNode`/`Buffer` 定义了 IPC wire 布局，`cpp/src/generated/` 与各语言的元数据代码都从这里生成。`testing/` 存放跨语言二进制兼容性的 golden 数据。

## 模块地图

![模块依赖](/vibe-reading/images/articles/arrow-internals/module-dependencies.svg)

依赖方向自上而下：上层依赖下层。左侧 `Dataset → Acero → Compute → Core` 是查询执行主链；右侧 `Flight → IPC → I/O` 是传输链；`Parquet` 横跨文件格式与 I/O；`Gandiva` 并行于 `Compute` 走 JIT 路径。所有模块最终汇聚到底层 `Core` 类型与内存。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 核心类型与内存 | 列式格式的物理/逻辑表示与零拷贝内存 | `arrow/type.h`、`buffer.h` | 一切模块的地基，独立性源于"格式规范"地位 | [01-核心类型与内存](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/01-core-types) |
| 计算内核 | 类型化运算的注册、调度与表达式求值 | `compute::CallFunction` | 复用一套 kernel 框架服务所有运算，独立于执行引擎 | [02-计算内核](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/02-compute) |
| Acero 执行引擎 | push 流水线编排，提供并行/背压 | `ExecPlan::StartProducing` | 把"单 kernel"升级为"流水线"，是查询执行的核心 | [03-Acero 执行引擎](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/03-acero) |
| IPC 序列化 | 列式内存↔字节流转换 | `ipc::RecordBatchStreamWriter` | wire format 的读写实现，与内存表示解耦 | [04-IPC 序列化](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/04-ipc) |
| Flight RPC | 跨网络传输 Arrow 数据 | `FlightServerBase::DoGet` | 传输语义独立于数据语义，gRPC 仅是默认传输 | [05-Flight RPC](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/05-flight) |
| Dataset API | 多文件多格式统一扫描 | `Scanner::ToTable` | 高层编排，把扫描/下推/执行三者解耦 | [06-Dataset API](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/06-dataset) |
| Parquet | 列式文件格式读写 | `parquet::arrow::FileReader` | 文件格式与内存格式不同质（thrift 元数据 + page 编码） | [07-Parquet 列式文件](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/07-parquet) |
| I/O 与文件系统 | 字节流与路径抽象 | `RandomAccessFile::ReadAt`、`FileSystem::OpenInputFile` | I/O 是所有文件相关模块的底座，须与具体后端解耦 | [08-I/O 与文件系统](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/08-io-filesystem) |
| Gandiva | LLVM 表达式 JIT 编译 | `gandiva::Filter::Make` | 复杂表达式走编译而非解释，是 compute 的重型替代 | [09-Gandiva JIT 编译器](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/09-gandiva) |

> 模块间的动态调用顺序见下文「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

作为库，Arrow 没有"进程启动"，但有一组**惰性初始化**发生在首次使用各核心设施时：

```
首次 GetFunctionRegistry()
  └─ CreateBuiltInRegistry()            compute/registry.cc:282
       ├─ RegisterScalarArithmetic / RegisterScalarCast / ...   批量注册 kernel
       └─ name_to_function_ 填充（带 mutex）

首次 default_memory_pool()
  └─ 按 ARROW_DEFAULT_MEMORY_POOL 选后端    memory_pool.cc:65
       └─ BaseMemoryPoolImpl<Allocator>     默认 mimalloc，64 字节对齐

构建 Scanner → ExecPlan
  └─ Declaration::AddToPlan → MakeExecNode  acero/exec_plan.cc:572
       └─ 工厂从 default_exec_factory_registry() 取节点构造器（首次访问时注册所有内置节点）

FlightServer::Init
  └─ TransportRegistry 按 URI scheme 选传输   flight/server.cc:155
       └─ gRPC 后端在 InitializeFlightGrpcServer() 注册自己
```

对象装配的关键：`MemoryPool` 与 `Executor`（CPU 线程池）通过 `ExecContext` 一路传递到 kernel 与 Acero 节点；`FunctionRegistry` 是全局单例；Acero 节点由工厂构造，节点间在构造时自动建立 `output_` 指针关系（`exec_plan.cc:462`）。

### 核心运行流程

下面三条链路覆盖 Arrow 最常见的运行模式：数据扫描、表达式求值、远程取数。

#### 数据扫描：Dataset → Acero → Parquet → Table

业务流程：用户给 `Scanner` 一个 Dataset + filter/projection → Scanner 编译 Acero 计划 → scan 节点异步拉 Parquet 文件 → 解码为 Arrow ArrayData → Acero 节点 push 处理 → sink 聚合 → 组装 Table。

![Dataset 扫描数据流](/vibe-reading/images/articles/arrow-internals/data-flow.svg)

文字描述：入口 `Scanner::ToTable()`（`scanner.cc`）调用 `AsyncScanner::ToTableAsync()`，后者用 `Declaration::Sequence({"scan","filter","augmented_project","sink"})` 构建一个 Acero `ExecPlan` 并 `StartProducing()`。`SourceNode` 持有一个 `AsyncGenerator`（由 `ParquetFileFormat::ScanBatchesAsync` 产出），在 loop 中拉取 morsel 并 `InputReceived` push 给 `FilterNode`（继承 `MapNode`，`map_node.cc:71`）。Parquet 侧由 `parquet::arrow::FileReaderImpl::GetRecordBatchGenerator` 经 `RowGroupGenerator`→`DecodeRowGroups`→`LeafReader::LoadBatch`→`RecordReader::ReadRecords` 驱动，最终在 `SerializedPageReader::NextPage`（`column_reader.cc:255`）反序列化 Thrift PageHeader、解压、解出 `Page`，由 decoder 解码 encoding。**零拷贝边界**在 `TransferZeroCopy`（`parquet/arrow/reader_internal.cc:450`）：`RecordReader::ReleaseValues()` 把 `shared_ptr<ResizableBuffer>` 直接移入 `ArrayData::buffers[1]`，此后该 buffer 经 `Datum`→`ExecBatch`→Acero 节点→`RecordBatch`→`Table` 全程 `shared_ptr` 引用计数零拷贝。数据拷贝只发生在三处：Parquet 解码（不可避免）、`compute::Filter()` 过滤行、投影中的计算表达式。并行性来自 Acero 的 CPU 线程池（`QueryContext::executor()`），多个 RowGroup/Fragment 并发扫描；SinkNode 的背压（高低水位 + 单调 counter，`backpressure_handler.h:50`）在内存超限时 `PauseProducing` 上游。

#### 表达式求值：CallFunction → Kernel dispatch

用户调用 `compute::CallFunction("add", {arg1, arg2})`（`exec.cc:1362`）。它先从 `FunctionRegistry` 查到 `add` 对应的 `Function`，再 `GetBestExecutor` 经 `DispatchExact`/`DispatchBest`（`function.cc:298`）遍历 `kernels_` 用 `KernelSignature::MatchesInputs` 找类型匹配的 `Kernel`，并按 `SimdLevel` 优先选 AVX512>AVX2>NONE。选中的 `KernelExecutor`（`ScalarExecutor`）在 `Init` 阶段创建 `KernelState`，在 `Execute` 阶段把输入 `Datum` 转成 `ExecSpan`（轻量 `ArraySpan`），按 `null_handling`（默认 `INTERSECTION`，框架自动对 validity bitmap 求交）处理 null，最后调用 kernel 的 `exec` 函数指针完成逐 span 向量化运算，结果由 `WrapResults` 装回 `Datum`。`Expression` 路径在 `Bind()` 阶段（`expression.cc:539`）就完成 Function 查找与 Kernel 匹配并缓存到 `Call::kernel`/`kernel_state`，执行期 `ExecuteScalarExpression` 直接复用，实现"编译一次执行多次"。

#### 远程取数：Flight DoGet RPC

客户端 `FlightClient::DoGet(ticket)`（`client.cc:677`）委托 `ClientTransport`（gRPC）发起 RPC。服务端 `GrpcServiceHandler::DoGet`（`grpc_server.cc:482`）先 `CheckAuth` 验证 token，再经 `ServerMiddlewareFactory::StartCall` 链装配中间件，然后调用用户 override 的 `FlightServerBase::DoGet`，返回一个 `RecordBatchStream`（包装 `RecordBatchReader`）。`RecordBatchStream` 内部用 `ipc::RecordBatchWriter` 把每个 `RecordBatch` 序列化为 `IpcPayload`（metadata + body buffer），封装进 `FlightPayload`，再经 `reinterpret_cast` 与 `pb::FlightData` 内存布局对齐**零拷贝**写入 gRPC stream（`serialization_internal.cc:220`）。客户端 `ClientStreamReader` 用 `ipc::RecordBatchStreamReader` 反序列化回 `RecordBatch`。IPC 层是 Flight 的"序列化引擎"，Flight 层只管 gRPC 传输与 RPC 语义。

### 状态流

Acero 的 `ExecNode` 有明确生命周期状态：`Init`（构造后初始化）→ `StartProducing`（开始生产）↔ `PauseProducing`/`ResumeProducing`（背压触发，靠单调 counter 去竞态）→ `StopProducing`（终止）。状态转换由 `ExecPlan` 的拓扑排序与 `BackpressureHandler` 驱动；`PauseProducing` 携带的 counter 保证乱序到达的旧 resume 不会错误唤醒已暂停的源节点（`exec_plan.h:278` 注释详述）。Flight 的连接则有两阶段认证状态：`Authenticate`（初始握手协商）→ `IsValid`（每个 RPC 验证 token），由 `ServerAuthHandler` 策略实现。

---

## 典型修改场景

#### 场景 1：新增一种 DataType

需改 `cpp/src/arrow/type_fwd.h`（加 `Type::type` 枚举）、`type.h`（定义类型类，继承 `FixedWidthType`/`NestedType`，实现 `ToString`/`name`/`layout`/`ComputeFingerprint`）、`type_traits.h`（加 `TypeTraits` 特化）、`array/` 下加 Array 与 Builder 子类、`visit_type_inline.h`（加 `case`）、`type.cc` 的 `type_singleton()`。`MakeArray` 会通过 `TypeTraits<T>::ArrayType` 自动创建对应 Array 子类，无需额外改 `array/util.cc`。

#### 场景 2：新增一个 compute kernel（如 `bit_count`）

在 `cpp/src/arrow/compute/kernels/scalar_arithmetic.cc` 实现 functor（`struct BitCount { template<typename T,typename A> static T Call(...) }`），在 `RegisterScalarArithmetic` 中用 `MakeUnaryArithmeticFunction<BitCount>("bit_count", doc)` 批量注册所有数值类型 kernel，最后 `registry->AddFunction`。聚合函数则需实现 `KernelInit`/`consume`/`merge`/`finalize` 四阶段（参考 `kernels/aggregate_basic.cc`）。对应测试：`cpp/src/arrow/compute/kernels/*_test.cc`。

#### 场景 3：支持一种新文件格式到 Dataset

实现 `FileFormat` 子类（`dataset/file_base.h`）的 `ScanBatchesAsync`/`Inspect`，实现 `FileFragment` 子类的 `ReadRowGroup`/`SplitRowGroups`，在 `dataset/plan.h` 的 `Initialize()` 中注册工厂。过滤/投影下推靠实现 `FileReader` 的 `GetReadRanges`/`set_data_page_filter`（Parquet 的范例见 `file_parquet.cc`）。对应测试：`cpp/src/arrow/dataset/*_test.cc`。

---

## 测试体系

```
cpp/src/arrow/{module}/*_test.cc        # 模块内单元测试（共 ~355 个 _test.cc 文件）
cpp/src/arrow/integration/             # 跨语言二进制兼容性集成测试
testing/                                # golden 数据（跨语言 IPC round-trip）
```

测试与代码同目录混排（`*_test.cc` 与 `*.cc` 并列），分两层：模块内 `*_test.cc` 做单元测试（如 `compute/kernels/scalar_arithmetic_test.cc` 测算术 kernel）；`arrow/integration/` 与根 `testing/` 做跨语言集成（验证 Java 写的 IPC stream 能被 C++ 正确读回）。理解某个类时，优先读它旁边的 `*_test.cc`——它们是可执行的 API 文档。改 compute kernel 参照 `kernels/*_test.cc`，改 Dataset 参照 `dataset/*_test.cc`。

## 阅读源码推荐路线

- 第一遍：理解列式内存主流程
  `cpp/src/arrow/type.h` 的 `DataType`/`Field`/`Schema` → `buffer.h` 的 `Buffer`/`SliceBuffer` → `array/data.h` 的 `ArrayData` → `array/array_base.h` 的 `Array` → `array/util.cc:298` 的 `MakeArray` → `record_batch.h`
- 第二遍：理解零拷贝与内存
  `memory_pool.h` 的 `MemoryPool` → `memory_pool.cc:457` 的 `BaseMemoryPoolImpl<Allocator>` 与 `PoolBuffer` → `buffer.h:373` 的 `parent_` 切片链
- 第三遍：理解计算调度
  `compute/exec.h` 的 `CallFunction` → `function.h` 的 `Function`/`kernel.h` 的 `Kernel` → `exec.cc:1362` 的 dispatch 路径 → `expression.h` 的 `Bind`/`ExecuteScalarExpression`
- 第四遍：理解执行引擎与数据流
  `acero/exec_plan.h` 的 `ExecPlan`/`ExecNode` → `exec_plan.cc:96` 的 `StartProducing` → `map_node.cc:71` 的 `InputReceived` → `dataset/scanner.cc` 的 `ToTable` → `parquet/arrow/reader_internal.cc:450` 的 `TransferZeroCopy`
- 第五遍：按兴趣选模块深读（见上方模块地图链接）；若关注传输读 `ipc/writer.cc`+`flight/server.cc`，关注 JIT 读 `gandiva/llvm_generator.cc`

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| 列式格式（Columnar Format） | 每列数据连续存放的内存布局，利于向量化与压缩 |
| 零拷贝 | 数据在模块/进程间以 `shared_ptr` 共享 buffer 传递，无字节级拷贝 |
| ArrayData / Array | 物理层（buffers+child）/ 逻辑层（强类型访问器）的双层设计 |
| validity bitmap | 每值 1 bit 的 null 标记位图，bit-packed 省 8× 内存 |
| RecordBatch | 同长度 Array 集合 + Schema，Arrow 基本交换单位 |
| ExecBatch | compute 执行输入（一组 Datum + 长度），Acero 节点间载体 |
| push-based | 上游主动 push 数据到下游，区别于 Volcano 的下游 pull |
| Morsel | Acero 中一批数据（≤ 32768 行），并行调度单位 |
| BinaryView / Utf8View | 短字符串内联、长字符串指向外部 buffer 的视图类型，省去 offsets |

### 参考资料

- [Arrow 列式格式规范](https://arrow.apache.org/docs/dev/format/Columnar.html)（`docs/source/format`）
- [Arrow Flight RPC 协议](https://arrow.apache.org/docs/dev/format/Flight.html)
- [DataFusion](https://github.com/apache/datafusion)（建立在 Arrow 之上的查询引擎，可作上层用例参考）
- [Acero 设计文档](https://arrow.apache.org/docs/dev/cpp/streaming_execution.html)

> 各模块的实现细节见对应的模块文档（上方模块地图链接）。本文为解读初稿（`reviewed: false`），部分跨模块调用链的行号可能随 26.0.0 开发推进而变化，已在模块文档中对不确定处标注"待核实"。
