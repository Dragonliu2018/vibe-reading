---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "列式数据模型"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "Block", "IColumn", "COW", "IDataType"]
description: "ClickHouse 列式数据模型源码解读——Block/IColumn/IDataType/Field 抽象与 DataTypeFactory 工厂。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

本模块（`src/Core/` + `src/Columns/` + `src/DataTypes/`）建立 ClickHouse 从"类型描述 → 列存储 → 批次封装"的完整抽象，是所有数据处理的基础设施。它独立成模块因为列式内存表示独立于存储格式与执行策略——无论数据来自 MergeTree 磁盘还是网络，都统一为 `Block` 流转。

## 模块架构

```text
src/Core/
  ├─ Block.h/.cpp     ── Block = {列名,类型,列} 批次，数据处理基本单元
  ├─ Field.h          ── Field = tagged union 单值容器
  └─ Chunk.h          ── Chunk = 不含类型信息的列批次（Port 传输用）
src/Columns/
  ├─ IColumn.h        ── IColumn 抽象基类（继承 COW<IColumn>）
  ├─ ColumnString.h   ── 变长字符串列（chars+offsets 两数组）
  ├─ ColumnNullable.h ── null 列（嵌套列 + ColumnUInt8 null_map）
  ├─ ColumnConst.h    ── 常量列（单值+size，延迟物化）
  ├─ ColumnVector.h   ── 定长数值列（PaddedPODArray<T>）
  └─ ColumnSparse.h   ── 稀疏列
src/DataTypes/
  ├─ IDataType.h      ── IDataType 抽象基类（不可变）
  ├─ DataTypeFactory.cpp ── 类型工厂单例，注册 26 个类型族
  └─ DataTypeString.h / DataTypeNullable.h / ...
```

核心抽象关系：`IDataType::createColumn()` 产出 `IColumn`，`ColumnWithTypeAndName{column, type, name}` 是 Block 的元素，Block 持有 `vector<ColumnWithTypeAndName>` + 列名哈希索引。

## 调用链路

从"创建一个 Block"出发：

```text
DataTypeFactory::get("Nullable(String)") in DataTypeFactory.cpp:120
  └─ getImpl(ast) → getImpl(family_name, parameters) in DataTypeFactory.cpp:237
     └─ findCreatorByName → (*creator)(parameters) → DataTypePtr
        └─ IDataType::createColumn() in IDataType.h:159
           ├─ DataTypeNullable::createColumn() → ColumnNullable::create(nested->createColumn(), ColumnUInt8::create())
           └─ DataTypeString::createColumn() → ColumnString::create()
              └─ 组装 ColumnWithTypeAndName{column, type, "name"}
                 └─ Block::insert(elem) in Block.cpp:226
                    └─ push 到 data + 更新 index_by_name
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Block::insert` in `Block.cpp:226` | 插入列并建索引 | 列名→位置哈希索引 |
| `IColumn::filter` in `IColumn.h` | WHERE 过滤 | 纯虚，各列实现 |
| `IColumn::mutate` in `IColumn.h` | 取可变引用 | COW：引用计数>1 时 clone |
| `IDataType::createColumn` in `IDataType.h:159` | 类型→列工厂 | 每类型重写 |
| `DataTypeFactory::get` in `DataTypeFactory.cpp:120` | 按名查类型 | 单例+注册表+别名 |
| `Field::dispatch` in `Field.h:484` | 值类型分发 | switch-case 跳转表 |

</details>

## 核心实现

### Block：数据处理的基本单元

```cpp title="src/Core/Block.h"
class Block {
    using Container = ColumnsWithTypeAndName;           // vector<ColumnWithTypeAndName>
    using IndexByName = UnorderedMapWithMemoryTracking<String, size_t>;
    Container data;                 // 列数组
    IndexByName index_by_name;       // 列名→位置索引
public:
    void insert(ColumnWithTypeAndName elem);
    ColumnWithTypeAndName & getByName(const std::string & name);   // 哈希查找
    size_t rows() const;             // 取首列 size（各列等长）
    Block cloneWithColumns(const Columns & columns) const;          // 换列保留 header
    Block compress() const;          // 压缩
};
```

注释明确定位："Container for set of columns for bunch of rows in memory. This is unit of data processing." Block 是流水线流转的单元——`Processors` 通过 Port 传 Block，`Functions` 按 Block 的列计算，`Storages` 从盘组装 Block。Block 的 header（列名+类型）定义数据流结构契约，`blocksHaveEqualStructure` 验证。

### IColumn 与 COW 写时复制

```cpp title="src/Columns/IColumn.h"
class IColumn : public COW<IColumn> {     // Copy-on-Write 基类
public:
    using Ptr = COW<IColumn>::Ptr;          // immutable 指针
    using MutablePtr = COW<IColumn>::MutablePtr;  // mutable，不可拷贝
    virtual size_t size() const = 0;
    virtual Field operator[](size_t n) const = 0;
    virtual Ptr filter(const Filter & filt, ssize_t result_size_hint) const = 0;
    virtual Ptr permute(const Permutation &, size_t limit) const = 0;
    virtual int compareAt(size_t n, size_t m, const IColumn & rhs, int nan_hint) const = 0;
    virtual void getPermutation(...) const = 0;
    virtual Ptr replicate(const Offsets &) const = 0;
    virtual size_t byteSize() const = 0;
    static MutablePtr mutate(Ptr ptr);      // 引用计数>1 时 clone
};
```

`COW<IColumn>`（`src/Common/COW.h`）提供 `Ptr`（不可变）与 `MutablePtr`（可变、不可拷贝）双指针。`mutate()` 在 `use_count() > 1` 时 clone，否则直接复用——实现零拷贝切片：同一列被多个 Block 共享，改写时才 clone。

`IColumnHelper<Derived>`（`IColumn.h:989`）是 CRTP 去虚化层：把 `scatter`/`gather`/`compareColumn` 等方法在具体列编译单元实例化为非虚函数，编译器可内联——这是 ClickHouse 性能优化关键技巧。具体列继承 `COWHelper<IColumnHelper<ColumnString>, ColumnString>`。

### Field：手动 tagged union

```cpp title="src/Core/Field.h"
class Field {
    AlignedUnionT<DBMS_MIN_FIELD_SIZE - sizeof(Types::Which),
        Null, UInt64, UInt128, UInt256, Int64, Int128, Int256,
        UUID, IPv4, IPv6, Float64, String, Array, Tuple, Map,
        DecimalField<Decimal32>, ...> storage;   // 栈上，无堆分配
    Types::Which which{};
    template <typename F> static auto dispatch(F && f, Field && field);  // switch 分发
};
```

注释直言"Made for replacement of `boost::variant`, is not generalized, but somewhat more efficient, and simpler"。Field 是热点对象（`IColumn::operator[]` 每次调用创建 Field），固定 32-40 字节栈分配，`dispatch` 是 switch-case 跳转表。深度嵌套的 Array/Tuple 用 `createContainerIteratively` 显式工作列表防栈溢出。

### IDataType 与 DataTypeFactory

```cpp title="src/DataTypes/IDataType.h"
class IDataType : private boost::noncopyable,
                  public std::enable_shared_from_this<IDataType> {
public:
    virtual MutableColumnPtr createColumn() const = 0;   // 类型→列工厂
    virtual Field getDefault() const = 0;
    virtual SerializationPtr doGetSerialization(...) const = 0;
    // 注释："DataType is totally immutable object. You can always share them."
};
```

IDataType 完全不可变（`boost::noncopyable` + `shared_ptr<const>`），全系统安全共享无需同步。

```cpp title="src/DataTypes/DataTypeFactory.h"
class DataTypeFactory final : private boost::noncopyable,
    public IFactoryWithAliases<std::function<DataTypePtr(const ASTPtr &)>> {
public:
    static DataTypeFactory & instance();          // 单例
    DataTypePtr get(const String & full_name) const;
    void registerDataType(const String & family_name, Value creator, ...);
private:
    DataTypesDictionary data_types;               // 名→creator 映射
    DataTypeFactory();                             // 构造时注册 26 个类型族
};
```

构造函数调用 26 个 `registerDataTypeNumbers`/`registerDataTypeString` 等。Enum/Tuple 因参数在 AST 中定义，`getImpl(ASTPtr)` 有特殊分支直接构造。

### NULL 表示：ColumnNullable

`ColumnNullable`（`src/Columns/ColumnNullable.h:16`）把 null 标记存为独立 `ColumnUInt8` null_map，而非每个值嵌入。注释解释用 byte map 而非 bitmap："columns are usually stored on disk as compressed files. Using a bitmap instead of a byte map would greatly complicate the implementation with little to no benefits"——压缩后差异可忽略。`isNullAt(n)` 检查 `null_map.getData()[n]` 是 O(1)。嵌套列不需感知 null，null_map 与数据列可独立压缩。

`ColumnConst`（`src/Columns/ColumnConst.h`）包装单值列+size 模拟任意大小列，延迟物化常量——10 亿行常量列只存 1 值+1 size_t，`convertToFullColumnIfConst()` 在需真实数据时才展开。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂+注册表 | `DataTypeFactory` | 26 类型按名 O(1) 查找，支持别名与大小写不敏感 |
| COW | `COW<IColumn>` | 列共享不可变，改写才 clone，零拷贝 |
| CRTP 去虚化 | `IColumnHelper<Derived>` | 热路径方法编译期消虚函数 |
| 策略 | 不同列实现 IColumn | 列类型=存储策略 |
| 装饰器 | `ColumnConst`/`ColumnNullable` 包嵌套列 | 列可层层包装 |

## 扩展方式

新增数据类型 `QBit`：新建 `src/DataTypes/DataTypeQBit.h`（继承 IDataType，实现 `createColumn`/`getDefault`/`doGetSerialization`）+ `src/Columns/ColumnQBit.h`（继承 `COWHelper<IColumnHelper<ColumnQBit>, ColumnQBit>`）；在 `DataTypeFactory()` 构造函数调 `registerDataTypeQBit`；更新 `src/Core/TypeId.h` 与 `WhichDataType`。无需改 Block 或流水线——它们通过 IColumn/IDataType 抽象处理任意类型。

## 模块间交互

本模块被 `Functions`（接收 Block 操作 IColumn）、`Processors`（Port 传 Block）、`Storages`（读写组装 Block）、`Interpreters`（类型转换、表达式求值）广泛 import。依赖 `Common`（COW、PODArray、Allocator）、`IO`（序列化）、`Parsers`（`DataTypeFactory` 用 `ParserDataType` 解析类型字符串）。Block 作为统一数据单元跨模块流转，header 契约由 `assertBlocksHaveEqualStructure` 保证。
