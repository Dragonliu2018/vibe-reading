---
source:
  type: "源码解读"
  project: "LLVM"
  url: "https://github.com/llvm/llvm-project"
title: "Support 与 ADT"
date: "2026-08-20T10:23:42+08:00"
category: ["Languages", "C/C++", "Tools", "LLVM", "CodeWiki", "24"]
tags: ["LLVM", "ADT", "SmallVector", "StringRef", "APInt", "DenseMap", "Error"]
description: "LLVM 基础设施——SmallVector 小对象优化、StringRef 视图、APInt 任意精度、DenseMap 开寻址、Error 代数类型"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/LLVM/CodeWiki/24/00-overview)

---

## 模块定位

`Support` 与 `ADT`（Abstract Data Types）是 LLVM 全项目的地基——最高扇入（7409 个源文件 include Support、4967 include ADT），但自身不依赖任何业务模块。它们定义了 LLVM 的代码风格：用 `SmallVector` 替代 `std::vector`、用 `StringRef` 替代 `const std::string&`、用 `Error/Expected` 替代异常、用 `isa/dyn_cast` 替代 RTTI。理解这套基础设施，就读懂了 LLVM 全项目代码的"通用词汇"。

## 模块架构

ADT 提供数据结构容器（`SmallVector`/`StringRef`/`APInt`/`DenseMap`/`ilist`/`SmallPtrSet` 等），Support 提供运行时工具（`Error`/`raw_ostream`/内存分配/线程/路径/hash），两者共同构成依赖树的叶子节点：

```
ADT（数据结构）                 Support（运行时工具）
├── SmallVector（SOO 容器）       ├── Error / Expected（错误处理）
├── StringRef（字符串视图）        ├── raw_ostream（流式输出）
├── APInt / APFloat（任意精度）    ├── Allocator（BumpPtrAllocator）
├── DenseMap / DenseSet（开寻址）  ├── Casting（isa/dyn_cast，依赖 SubclassID）
├── ilist（半侵入式链表）          ├── MemoryBuffer / SourceMgr
└── SmallPtrSet / TinyPtrVector   └── CommandLine / Threading / Path
```

两者都只依赖 C++ 标准库和少量底层自身头文件（如 `Compiler.h`/`MathExtras.h`），被全项目传递依赖。

## 调用链路

以 `SmallVector::push_back` 为例，看 SOO 容器如何在小数据时走快路径零堆分配：

```
SmallVector<T,N>::push_back(Elt)                              [include/llvm/ADT/SmallVector.h:579]
  │  输入：T → 输出：void（追加元素）
  ├─ if (size() >= capacity()) ──yes─► growAndPushBack(Elt)   # 慢路径，LLVM_ATTRIBUTE_NOINLINE
  │                                      └─ grow() → 2*Cap+1  [lib/Support/SmallVector.cpp:90]
  └─ no ─► std::memcpy(end(), &Elt, sizeof(T))                # TriviallyCopyable 快路径
          set_size(size()+1)
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `SmallVector::grow` in `SmallVector.cpp:90` | 容量增长 | 倍增+1（`2*Cap+1`，+1 保证 0 也能长） |
| `DenseMap::doFind` in `DenseMap.h:722` | 开寻址查找 | 线性探测 + 1-bit used 位数组 |
| `Error::~Error` in `Error.h:232` | 析构检查 | 未检查的 Error → abort() |

## 核心实现

### SmallVector 小对象优化

`SmallVector` 用四层模板继承链把"与 N 无关的逻辑"上提到 `SmallVectorImpl<T>`，避免模板膨胀：

```cpp title="include/llvm/ADT/SmallVector.h"
SmallVectorBase<Size_T>                 // 无 T 的公共基类（BeginX/Size/Capacity）
  └─ SmallVectorTemplateCommon<T>       // begin/end/operator[]
       └─ SmallVectorTemplateBase<T, TriviallyCopyable>  // 特化分两份
            └─ SmallVectorImpl<T>        // 与 N 无关的实现
                 └─ SmallVector<T, N> : SmallVectorImpl<T>, SmallVectorStorage<T,N>
```

最终类同时继承 `SmallVectorImpl<T>`（逻辑）和 `SmallVectorStorage<T,N>`（内联 char 数组），利用 C++ 对象布局使内联存储紧跟 base 字段后。`BeginX` 初始指向 `FirstEl`（`SmallVector.h:133` 用 `offsetof` 计算），小数据零堆分配。默认内联元素数 `CalculateSmallVectorDefaultInlinedElements`（`SmallVector.h:1169`）使 `sizeof(SmallVector<T>)` 约 64 字节——一个 cache line。

**为什么默认内联**：编译器场景里大量 vector 实际元素数 < 10（如未优化前 BasicBlock 指令列表很短）。内联使小数据零堆分配（`isSmall()` 检测）、cache 行命中率高、析构无需 `free`。`push_back` 热路径只有一次比较 + memcpy + size++，慢路径 `growAndPushBack` 标 `LLVM_ATTRIBUTE_NOINLINE` 避免污染热路径寄存器分配。

### StringRef 视图

```cpp title="include/llvm/ADT/StringRef.h:56"
class LLVM_GSL_POINTER StringRef {
  const char *Data = nullptr;   // 外部缓冲区指针（不拥有）
  size_t Length = 0;
};
```

仅 16 字节，不持有数据。`LLVM_GSL_POINTER` 注解告知静态分析器它是 GSL-style 指针视图。**为什么不拥有数据**：LLVM 中字符串传递极频繁（IR 名/路径/诊断），`std::string` 传参要 copy，`StringRef` 作 16 字节视图只拷贝 2 个指针。从 `const char*`/`std::string`/`string_view` 隐式构造，零拷贝。文档警告"not in general safe to store a StringRef"——仅传参和临时用，禁用从临时 `std::string` 赋值防悬垂引用。

### APInt 任意精度整数

```cpp title="include/llvm/ADT/APInt.h:78"
class APInt {
  union { uint64_t VAL; uint64_t *pVal; } U;  // ≤64bit 栈上，>64bit 堆
  unsigned BitWidth = 1;
  bool isSingleWord() const { return BitWidth <= 64; }
};
```

双模式：`BitWidth ≤ 64` 用栈上 `U.VAL`（零堆分配），`> 64` 用 `U.pVal` 指堆数组。常量折叠、类型计算频繁用 `APInt`，单 word 路径无分配开销。

### DenseMap 开寻址 + Knuth 删除

`DenseMap` 用独立 1-bit-per-bucket "used" 位数组追踪 bucket 占用（`DenseMap.h:62`），**不用 tombstone/empty 哨兵 key**：

```cpp title="include/llvm/ADT/DenseMap.h:722"
const BucketT *doFind(const LookupKeyT &Val) const {
  unsigned Mask = NumBuckets - 1;                 // power-of-2
  unsigned BucketNo = KeyInfoT::getHashValue(Val) & Mask;
  while (true) {
    if (!used(U, BucketNo)) return nullptr;       // 空 bucket 终止
    if (KeyInfoT::isEqual(Val, Bucket->getFirst())) return Bucket;
    BucketNo = (BucketNo + 1) & Mask;             // 线性探测
  }
}
```

删除用 Knuth Algorithm R（`eraseFromFilledBucket` in `DenseMap.h:580`）——向后移位填补空洞保持探测链不断裂，不设 tombstone，避免多次删除后探测链变长。负载因子 0.75。**为什么不在 std 名空间且用开寻址**：避免与 `std::unordered_map` 的 ADL 冲突；key 不要求可默认构造（无 sentinel）；开寻址 cache 友好。

### Error / Expected 代数类型

LLVM 禁用 C++ 异常（`-fno-exceptions`），用 `Error`（和类型 Success|Error(Payload)）与 `Expected<T>`（tagged union）替代：

```cpp title="include/llvm/Support/Error.h:159"
class [[nodiscard]] Error {
  ErrorInfoBase *Payload = nullptr;   // nullptr=success，非空=错误
};
template <class T> class [[nodiscard]] Expected {
  union { storage_type TStorage; error_type ErrorStorage; };
  bool HasError : 1;
};
```

`[[nodiscard]]` 编译期禁忽略返回值；`ErrorInfoBase` 用 `ErrorInfo<T>` CRTP 提供 `static char ID` 做 type tag（自定义 RTTI，避免标准 RTTI 开销）。`handleErrors`（`Error.h:990`）用 variadic template 按错误类型分发。**为什么不用异常**：异常路径不可预测、嵌入式/禁 RTTI 场景不兼容；`Error` 的 Checked 位在析构时检查——未检查的 Error 触发 `fatalUncheckedError` → `abort()`，强制处理每个错误。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| RAII | `SmallVectorImpl::~` in `SmallVector.h:619`、`Error::~` in `Error.h:232` | 析构自动释放/检查 |
| CRTP | `SmallVectorTemplateCommon<T>` 四层链、`DenseMapBase<DerivedT>` | N 无关代码上提，避免模板膨胀 |
| Concept+Model 多态 | `ErrorInfoBase`(Concept) + `ErrorInfo<T>`(Model) in `Error.h:44,353` | 自定义 RTTI，`static char ID` 替代 typeid |
| Flyweight/视图 | `StringRef` in `StringRef.h:56` | 16 字节视图，零拷贝传参 |
| Template Method | `raw_ostream::write_impl` 纯虚 in `raw_ostream.h:380` | 基类管缓冲区，子类只 override 输出目标 |
| Tagged Union | `Expected<T>` union、`APInt::U` union | 位区分值/错误，单 word/多 word |

## 模块间交互

ADT/Support 是依赖树叶子节点，被全项目 include（扇入最高），不反向依赖任何业务模块。作为"地基"意味着：其 ABI 变化影响全项目（`LLVM_ABI` 标记控制跨 .so 边界可见性），大量函数 out-of-line 以减少代码膨胀（`SmallVector.cpp` 注释"Moving this function into the header may cause performance regression"）。`isa/dyn_cast` 被 IR/CodeGen/MC 全部用于 `Value`/`MachineInstr`/`MCFragment` 的类型分派。

## 扩展方式

新增一个 ADT 容器：参考 `DenseMapBase::doFind`（`DenseMap.h:722`）线性探测与 `grow`（`DenseMap.h:686`）rehash，若需 SOO 参考 `SmallVectorStorage`（`SmallVector.h:1149`）。扩展 `Error` 类型：业务模块新建错误类继承 `ErrorInfo<MyError>`（CRTP 自动获得 RTTI），用 `make_error<MyError>(args)` 构造、`handleErrors` + lambda 按类型分发——无需改 `Error.h`。新增 `raw_ostream` sink：override `write_impl(const char*, size_t)` 纯虚函数（`raw_ostream.h:380`），参考 `raw_string_ostream`/`raw_fd_ostream`。
