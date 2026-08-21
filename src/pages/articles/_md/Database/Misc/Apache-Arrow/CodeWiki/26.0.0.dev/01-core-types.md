---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "核心类型与内存"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "列式格式", "内存管理"]
description: "Arrow 列式格式的物理与逻辑表示——DataType 类型体系、引用计数 Buffer、可替换 MemoryPool、ArrayData/Array 双层设计与零拷贝切片"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

这是整个 Arrow 的地基。`type.h`/`buffer.h`/`memory_pool`/`array/` 定义了**列式内存格式的全部数据结构**：类型是什么（`DataType`）、列怎么存（`ArrayData`/`Array`）、内存谁分配（`Buffer`/`MemoryPool`）、批量怎么组合（`RecordBatch`/`Table`/`ChunkedArray`）。所有其它模块——compute、acero、ipc、flight、parquet、dataset——都建立在这些结构之上，且都通过零拷贝的 `shared_ptr<Buffer>` 共享同一份内存。理解本模块是阅读其它任何 Arrow 模块的前提。

## 模块架构

模块内核心组件及其关系（纵向：物理层在下，逻辑层在上）：

```
┌─────────────────────────── 逻辑访问层 ───────────────────────────┐
│  Array (array_base.h)      持 shared_ptr<ArrayData>，强类型接口 │
│  RecordBatch / Table       多列组合 + Schema                    │
│  ChunkedArray              多 Array chunk 组成的逻辑大列         │
│  Datum (datum.h)           类型擦除 variant（Scalar/Array/...）  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 包装
┌───────────────────────────────▼─────────────────────────────────┐
│  ArrayData (array/data.h)   物理层：buffers[0]=validity, [1+]=数据│
│                              child_data[] + dictionary + offset   │
│  ArraySpan (data.h:553)     轻量非拥有，compute kernel 高速路径   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 持有
┌───────────────────────────────▼─────────────────────────────────┐
│  Buffer (buffer.h)          引用计数连续内存，parent_ 保切片源   │
│    └─ MutableBuffer → ResizableBuffer → PoolBuffer               │
│  MemoryPool (memory_pool.h) 分配抽象，BaseMemoryPoolImpl<Alloc>  │
│    └─ System / Jemalloc / Mimalloc（DebugAllocator 越界检测）    │
└──────────────────────────────────────────────────────────────────┘
┌─────────────────────────── 类型系统 ────────────────────────────┐
│  DataType (type.h:136) → FixedWidthType / NestedType / BaseBinary │
│    ├─ IntegerType/FloatingPointType（CRTP CTypeImpl 生成）       │
│    ├─ ListType/StructType/UnionType/BinaryViewType               │
│    └─ DictionaryType                                             │
│  Field / Schema（pimpl）  字段与模式，Fingerprintable 延迟指纹  │
└──────────────────────────────────────────────────────────────────┘
```

`DataType` 决定"这列是什么类型以及它的 buffer 布局"（`DataTypeLayout`），`Buffer` 是"实际字节"，`ArrayData` 把 buffer 按类型规则组装成"一列"，`Array` 在其上提供强类型访问，`RecordBatch`/`Table` 把多列组合成表，`Datum` 把这一切擦除成统一类型给 compute。分层是为了**性能与安全的权衡**：compute kernel 直接操作裸 `ArrayData`/`ArraySpan` 避免虚函数开销，而用户 API 用不可变 `Array` 保证安全。

## 调用链路

构建一个 `Int32Array` 的完整调用链（`ArrayBuilder` 模板方法骨架）：

```
ArrayBuilder::Finish(&out)                      builder_base.cc:343
  └─ FinishInternal(&data)                       纯虚，子类实现
       └─ NumericBuilder<T>::FinishInternal      builder_primitive.h:235
            ├─ null_bitmap_builder_.FinishWithLength()  → validity Buffer
            ├─ data_builder_.FinishWithLength()         → 数据 Buffer
            └─ ArrayData::Make(type, length, {validity, data}, null_count)  array/data.h:119
  └─ MakeArray(data)                              array/util.cc:298
       └─ VisitTypeInline(*type, ArrayDataWrapper)  按 type_id dispatch
            └─ TypeTraits<T>::ArrayType(data)      如 Int32Type→Int32Array
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `ArrayData::Make` (`array/data.h:119`) | 组装物理列 | 不可变 struct，可被多 Array 共享 |
| `MakeArray` (`array/util.cc:298`) | ArrayData→强类型 Array | 用 `VisitTypeInline` visitor dispatch |
| `Array::Slice` (`array_base.h`) | 零拷贝切片 | 改 offset/length，共享 buffers |
| `Buffer::parent_` (`buffer.h:373`) | 切片时持父保活 | shared_ptr 引用计数零拷贝 |
| `AllocateBitmap` (`buffer.cc:182`) | 分配 validity 位图 | memset 清零，默认全 valid |
| `ArrayData::GetNullCount` (`data.h`) | 惰性算 null 数 | `kUnknownNullCount=-1` 延迟扫描 |
</details>

## 核心实现

### DataType 类型体系

`type.h` 用多继承层次组织所有类型。`DataType` 是基类，持 `Type::type id_` 与 `FieldVector children_`：

```cpp title="type.h:136-218"
class ARROW_EXPORT DataType : public std::enable_shared_from_this<DataType>,
                              public detail::Fingerprintable { ... };
```

具体数值类型由 CRTP 模板 `CTypeImpl<DERIVED,BASE,TYPE_ID,C_TYPE>`（`type.h:551`）批量生成，避免为每种整型/浮点手写重复代码：

```cpp title="type.h:625-702 IntegerTypeImpl 生成所有整型"
template <typename DERIVED, Type::type TYPE_ID, typename C_TYPE>
class IntegerTypeImpl : public CTypeImpl<DERIVED, NumberType, TYPE_ID, C_TYPE> {
  bool is_signed() const override { return std::is_signed<C_TYPE>::value; }
};
// UInt8Type..Int64Type 全部由它特化生成
```

嵌套类型走 `NestedType`（`type.h:349`）：`BaseListType` 派生 `ListType`/`LargeListType`/`FixedSizeListType`；`StructType`/`UnionType` 用 pimpl。`BinaryViewType`（`type.h:784`）用 union 实现"12 字节以内内联、超长指外部 buffer"的视图优化。**设计决策**：类型层次用继承而非 `enum+switch`，是因为类型有行为（`layout()`/`byte_width()`/`ComputeFingerprint()`）且需多态 dispatch（`Accept(TypeVisitor*)`）；但数值类型用 CRTP 把"所有整型都一样"的样板收敛到一个模板，编译期生成、零运行时开销。

### Buffer 与零拷贝切片

`Buffer` 是"一段引用计制的连续内存"的统一抽象。基类不拥有内存，由子类决定：

```cpp title="buffer.h:52-390 关键成员"
class Buffer {
  bool is_mutable_; bool is_cpu_;
  const uint8_t* data_; int64_t size_; int64_t capacity_;
  DeviceAllocationType device_type_;
  std::shared_ptr<Buffer> parent_;   // 切片时持父保活
};
```

继承链 `Buffer → MutableBuffer → ResizableBuffer → PoolBuffer`（`buffer.h:464/494`，`memory_pool.cc:898`）。**零拷贝切片**是 Arrow 的核心机制：`SliceBuffer`（`buffer.h:399`）创建一个新 `Buffer` 指向父 buffer 的 offset 位置，同时持 `parent_` shared_ptr 确保父内存不被释放。`Array::Slice()` 调 `ArrayData::Slice()`（改 offset/length，共享 buffers）再 `MakeArray` 包装，全程无字节拷贝。**为什么用 `parent_` 而非手动管理**：引用计数让"谁还在用这块内存"由 `shared_ptr` 自动追踪，进程间、设备间传递 buffer 无需手动 free，是零拷贝流转的物理基础。

### MemoryPool 可替换分配器

`MemoryPool`（`memory_pool.h:109`）是分配抽象，纯虚 `Allocate`/`Reallocate`/`Free`：

```cpp title="memory_pool.cc:457 模板策略基类"
template <typename Allocator>
class BaseMemoryPoolImpl : public MemoryPool {
  Status Allocate(int64_t size, int64_t alignment, uint8_t** out) override {
    return Allocator::AllocateAligned(size, alignment, out);  // 委托给策略
  }
};
using SystemMemoryPool   = BaseMemoryPoolImpl<SystemAllocator>;
using JemallocMemoryPool = BaseMemoryPoolImpl<JemallocAllocator>;
using MimallocMemoryPool = BaseMemoryPoolImpl<MimallocAllocator>;
```

后端在编译时由 `ARROW_JEMALLOC`/`ARROW_MIMALLOC` 宏控制，运行时由 `ARROW_DEFAULT_MEMORY_POOL` 环境变量选（`memory_pool.cc:65,99`），默认 mimalloc。`DebugAllocator`（`memory_pool.cc:218`）在分配末尾追加 `size ^ kDebugXorSuffix` 校验后缀检测越界写入——对 buffer 密集的列式操作尤为重要。`PoolBuffer`（`memory_pool.cc:898`）是 `ResizableBuffer` 与 `MemoryPool` 的桥梁，所有 `AllocateBuffer`/`AllocateResizableBuffer` 创建的都是它。**为什么抽象**：让上层代码不关心分配器实现，可在不改代码前提下换 jemalloc/mimalloc，且 `LoggingMemoryPool`/`CappedMemoryPool` 装饰器可叠加日志与内存上限。64 字节对齐（`memory_pool.cc:981`）满足 SIMD 要求。

### ArrayData/Array 双层与 ArraySpan

`ArrayData`（`array/data.h:85`）是物理层 struct，直接持有 `buffers`/`child_data`/`dictionary`，可变、便于内部操作：

```cpp title="array/data.h:85-521"
struct ArrayData {
  std::shared_ptr<DataType> type;
  int64_t length = 0;
  mutable std::atomic<int64_t> null_count{0};  // 延迟计算
  int64_t offset = 0;
  std::vector<std::shared_ptr<Buffer>> buffers;  // [0]=validity, [1+]=data/offsets
  std::vector<std::shared_ptr<ArrayData>> child_data;
  std::shared_ptr<ArrayData> dictionary;
};
```

`Array`（`array_base.h:53`）是逻辑层，持 `shared_ptr<ArrayData>` 提供不可变强类型访问。一个 `ArrayData` 可被多个 `Array` 共享（零拷贝切片的基础）。`ArraySpan`（`data.h:553`）是 compute kernel 内部用的轻量非拥有容器，固定 3 个 `BufferSpan`，去掉 `shared_ptr` 与 vector 开销——大多数类型不超过 3 个 buffer（变长的 BinaryView 用 `variadicBufferCounts` 处理）。`Datum`（`datum.h:46`）用 `std::variant` 把 Scalar/ArrayData/ChunkedArray/RecordBatch/Table 擦除成统一类型，且**显式存 ArrayData 而非 Array**（`datum.h:60` 注释："ArrayData is stored instead of Array for easier processing"），方便 kernel 直接操作。**为什么分两层**：性能与安全的权衡——kernel 直接操作裸 ArrayData/ArraySpan 免虚函数开销，用户 API 用不可变 Array 保安全，`Datum` 统一入口让 compute 函数签名类型无关。

## 设计模式

| 模式 | 位置（文件名+方法名/行号） | 为什么用 |
|------|------------------------|---------|
| Builder | `ArrayBuilder::Finish`→`FinishInternal`（`builder_base.cc:343`） | 类型各异的组装流程统一到模板方法 |
| enable_shared_from_this | `DataType::GetSharedPtr`（`type.h:201`） | 多所有者场景安全共享类型对象 |
| PIMPL | `Schema::Impl`（`type.h:2431`）、`StructType::Impl` | 隐藏实现，减少编译依赖 |
| 类型擦除 Variant | `Datum`（`datum.h:46`） | compute 函数统一接受任意值类型 |
| Visitor | `MakeArray`+`VisitTypeInline`（`array/util.cc:298`） | 按 `Type::type` dispatch 到特化 Array 子类 |
| 模板策略 | `BaseMemoryPoolImpl<Allocator>`（`memory_pool.cc:457`） | 统一统计逻辑，分配器可插拔 |
| CRTP | `CTypeImpl<DERIVED,...>`（`type.h:551`） | 批量生成数值类型，编译期零开销 |
| Decorator | `LoggingMemoryPool`/`CappedMemoryPool`（`memory_pool.h:184/254`） | 包装增强不改接口 |
| Fingerprintable | `DataType::fingerprint`（`type.h:86`，延迟 atomic） | 类型相等性 O(1) 字符串比较，kernel dispatch 提速 |

## 模块间交互

本模块是**被依赖中心**：compute 接受 `Datum` 操作 `ArrayData`/`ArraySpan`；acero 操作 `RecordBatch`/`Table`；ipc 读写 `ArrayData`/`RecordBatch`/`Schema`；parquet/csv/json 的 reader 通过 `ArrayBuilder`→`Array`→`RecordBatch` 管道输出，writer 反向；flight 传输 `RecordBatch`/`Table`；dataset 建立在 `RecordBatch`/`ChunkedArray` 上。它自身只依赖 `arrow/status.h`/`result.h`/`visitor.h`/`device.h`/`util/*`。交互方式全是函数调用 + `shared_ptr` 共享，无事件/消息。

## 扩展方式

- **新增 DataType**：改 `type_fwd.h`（枚举）、`type.h`（类型类+`layout`+`ComputeFingerprint`）、`type_traits.h`（`TypeTraits` 特化）、`array/`（Array 与 Builder 子类）、`visit_type_inline.h`（`case`）、`type.cc`（`type_singleton`）。`MakeArray` 经 `TypeTraits<T>::ArrayType` 自动适配，无需改 `array/util.cc`。
- **自定义 MemoryPool**：继承 `MemoryPool` 实现 5 个纯虚方法，或实现一个 `Allocator` 类后 `using MyPool = BaseMemoryPoolImpl<MyAllocator>;`。无需改 Arrow 源码，通过 `default_memory_pool()` 或 API 传入即可替换。
- **新增 compute 输出类型**：kernel 输出 `Datum`——用 `MakeBuilder`+`Finish` 或 `ArrayData::Make`+`MakeArray` 组装。
