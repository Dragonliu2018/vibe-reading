---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "函数与聚合工厂"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "FunctionFactory", "IFunction", "IAggregateFunction", "CRTP"]
description: "ClickHouse 函数与聚合工厂源码解读——四层抽象、工厂注册器、适配器桥接、CRTP 去虚化与组合器。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/Functions/` + `src/AggregateFunctions/` 是 ClickHouse 的标量与聚合函数库。1000+ 标量函数 + 大量聚合函数，全部经工厂+注册器按名查找。它独立成模块因为函数库架构统一（每个函数实现同一接口），是工厂+注册器扩展模式的典范——理解它就理解了 ClickHouse 的扩展点设计。

## 模块架构

```text
src/Functions/
  ├─ IFunction.h               ── 四层抽象（IExecutableFunction/IFunctionBase/IFunctionOverloadResolver/IFunction）
  ├─ FunctionFactory.h/.cpp    ── 标量函数工厂（单例，按名注册/查找）
  ├─ IFunctionAdaptors.h       ── 适配器三件套（IFunction→三层抽象桥接）
  └─ abs.cpp/plus.cpp/...      ── 1000+ 函数实现（各 .cpp，REGISTER_FUNCTION 自注册）
src/AggregateFunctions/
  ├─ IAggregateFunction.h      ── 聚合函数基类 + CRTP 去虚化（IAggregateFunctionHelper/DataHelper）
  ├─ AggregateFunctionFactory.h ── 聚合函数工厂
  └─ AggregateFunctionSum.h/quantile.h/...
```

## 调用链路

标量函数（`SELECT abs(-0.5)`）：
```text
ActionsVisitor::visit（解析 ASTFunction）→ FunctionFactory::instance().get(name, context)
  └─ getImpl → tryGetImpl → functions map 查 creator → (*creator)(context) → IFunctionOverloadResolver
     └─ ActionsDAG::addFunction → function->build(arguments) → IFunctionBase
        └─ IFunctionBase::execute → prepare(arguments)->execute(...)
           └─ IExecutableFunction::execute 层层剥离 Null/LowCardinality/Sparse/Const 列适配
              └─ executeImpl → abs.cpp 的 FunctionUnaryArithmetic::executeImpl（向量化）
```

聚合函数（`SELECT sum(x) GROUP BY k`）：
```text
AggregateFunctionFactory::get → getImpl → creator → AggregateFunctionSum
  └─ Aggregator: addBatch/addBatchSinglePlace（CRTP 去虚化循环）
     └─ AggregateFunctionSumData::add → 累加到 sum 成员
  └─ 分布式 merge: serialize(WriteBuffer) → 传输 → deserialize → merge
  └─ insertResultInto → data(place).get() → push 到结果 Column
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `FunctionFactory::get` in `FunctionFactory.cpp:120` | 按名查函数 | 单例+注册表+别名 |
| `IFunctionOverloadResolver::build` in `IFunction.cpp:806` | 按参数类型选重载 | 中间层解析重载 |
| `IExecutableFunction::execute` in `IFunction.cpp:550` | 层层剥离列适配 | default impl 开关 |
| `IAggregateFunction::addBatch` | 批量 add | CRTP 去虚化 |
| `IAggregateFunction::serialize/deserialize` | 状态序列化 | 分布式 merge |
| `REGISTER_FUNCTION` 宏 in `Common/register_objects.h` | 编译期自注册 | 无需改中心文件 |

</details>

## 核心实现

### 四层抽象与适配器桥接

```cpp title="src/Functions/IFunction.h"
class IExecutableFunction {        // 第一层：可执行函数
    virtual ColumnPtr executeImpl(...) const = 0;
    virtual bool useDefaultImplementationForNulls() const { return true; }  // 框架帮处理 Nullable
    // ... 8 个 default impl 开关
};
class IFunctionBase {              // 第二层：已知参数/返回类型
    virtual ExecutableFunctionPtr prepare(const ColumnsWithTypeAndName &) const = 0;
};
class IFunctionOverloadResolver {  // 第三层：重载解析器
    virtual FunctionBasePtr build(const ColumnsWithTypeAndName &) const;
};
class IFunction {                  // 第四层：简化接口（旧版，大量函数用此）
    virtual ColumnPtr executeImpl(...) const = 0;
    virtual DataTypePtr getReturnTypeImpl(const DataTypes &) const;
};
```

大部分简单函数只实现 `IFunction`（第四层），适配器三件套自动桥接到三层抽象体系：`FunctionToOverloadResolverAdaptor` → `FunctionToFunctionBaseAdaptor` → `FunctionToExecutableFunctionAdaptor`（`src/Functions/IFunctionAdaptors.h`）。

### 工厂+注册器：REGISTER_FUNCTION 宏

```cpp title="src/Common/register_objects.h"
struct FunctionRegister {
    FunctionRegister(std::function<void(FunctionFactory&)> reg) {
        FunctionRegisterMap::instance().add(std::move(reg));   // 编译期插入全局 map
    }
};
#define REGISTER_FUNCTION(name) \
    static FunctionRegister reg_##name([](FunctionFactory & f){ registerFunction##name(f); });
```

每个函数 `.cpp` 用 `REGISTER_FUNCTION(Abs)` 声明一个 static 对象，在 `main` 前自动插入全局 map。`registerFunctions()`（`registerFunctions.cpp:11`）遍历 map 逐个注册。新增函数不需改任何中心文件——在自己的 `.cpp` 中 `REGISTER_FUNCTION` 即可。

### CRTP 去虚化：聚合函数热路径

```cpp title="src/AggregateFunctions/IAggregateFunction.h"
template <typename Derived>
class IAggregateFunctionHelper : public IAggregateFunction {
    static void addFree(const IAggregateFunction * that, AggregateDataPtr place,
                        const IColumn ** columns, size_t row_num, Arena * arena) {
        static_cast<const Derived &>(*that).add(place, columns, row_num, arena);  // 编译期消虚函数
    }
    AddFunc getAddressOfAddFunction() const final { return &addFree; }
    void addBatch(...) const { /* static_cast<Derived*> 循环调用 add，可向量化内联 */ }
};
```

`IAggregateFunctionHelper<Derived>`（CRTP）把 `addBatch` 等热路径方法在具体列编译单元实例化为非虚函数，编译器可内联向量化。这是 ClickHouse 聚合性能关键——逐行 `add` 在 CRTP 下编译为内联循环。

### Default implementation 开关

`IExecutableFunction` 约 8 个 `useDefaultImplementationFor*()` 开关让函数声明"框架帮我处理 Nullable/LowCardinality/Sparse/Constant 列"。`execute` 在 `IFunction.cpp:550-726` 层层剥离包装列，调 `executeImpl` 处理裸数据，再包装回去。避免每个函数手写列类型适配。

### 聚合状态序列化与组合器

`IAggregateFunction` 定义 `serialize`/`deserialize` 接口——分布式查询各节点独立聚合，序列化状态字节流传输，目标节点 `merge`。`AggregateFunctionSumData::write` 用 `writeBinaryLittleEndian`。组合器模式（`AggregateFunctionCombinatorFactory`）支持 `-If`/`-Merge`/`-State`/`-Array`/`-ForEach`/`-Null` 后缀，递归解析嵌套函数——`sumIf(x,cond)` 复用 `AggregateFunctionSum` 全部实现，不修改基础函数。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂+注册器 | `FunctionFactory`/`AggregateFunctionFactory` | 1000+ 函数按名 O(1) 查找，编译隔离 |
| 适配器 | `IFunctionAdaptors.h` 三件套 | 简化 IFunction 桥接到三层抽象 |
| CRTP 去虚化 | `IAggregateFunctionHelper<Derived>` | 热路径编译期消虚函数 |
| 模板策略 | `FunctionUnaryArithmetic<Op,Name>` | 一元运算注入具体运算策略复用基础设施 |
| 组合器 | `AggregateFunctionCombinatorFactory` | 后缀扩展不修改基础函数 |

## 重要设计决策

### 为什么工厂+注册器而非虚函数表/switch

1000+ 函数，switch 集中所有 case 编译不可接受，虚函数表无法按名查找。工厂+注册器：编译隔离（每函数独立 .cpp + REGISTER_FUNCTION 自注册）、按需查找 O(1)、别名支持（SUBSTR→substring）、文档内联（`FunctionDocumentation`）。

### 函数重载怎么解决

`IFunctionOverloadResolver` 作中间层——工厂返回的是 resolver（未确定重载），`build(arguments)` 时按实际参数类型选 `IFunctionBase`。简单函数用适配器自动桥接不需手写重载逻辑，复杂函数（cast/plus）可直接实现 resolver 做类型推导。

## 扩展方式

新增标量函数 `myfunc(x)`：建 `src/Functions/myfunc.cpp`，实现 `MyFuncImpl::apply` + `NameMyFunc`，用 `FunctionUnaryArithmetic<MyFuncImpl,NameMyFunc>` 组装或直接实现 IFunction，`REGISTER_FUNCTION(MyFunc)` 注册。无需改 FunctionFactory。新增聚合函数 `myagg`：建 `AggregateFunctionMyAggData`（含 add/merge/write/read/get）+ `AggregateFunctionMyAgg : IAggregateFunctionDataHelper<Data,Self>`，建 `.cpp` 工厂函数 + `registerAggregateFunctionMyAgg`，在 `registerAggregateFunctions.cpp` 调用。

## 模块间交互

Parsers 解析生成 `ASTFunction`；`ActionsVisitor`（Interpreters）调 `FunctionFactory::get` 获取 resolver；`ActionsDAG` 调 `build` 构 IFunctionBase；Processors 执行阶段从 DAG 取出 `execute` 生成 Column。`TreeRewriter` 调 `AggregateFunctionFactory::instance()` 判断聚合函数。依赖 `Core`（Block/ColumnWithTypeAndName）、`Columns`、`DataTypes`、`IO`（状态序列化）、`Common`（Arena 内存池）。
