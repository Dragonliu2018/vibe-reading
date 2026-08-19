---
source:
  type: "源码解读"
  project: "Jeandle-LLVM"
  url: "https://github.com/jeandle/jeandle-llvm"
title: "GC 基础设施"
date: "2026-08-19T19:41:28+08:00"
category: [Languages, Java, Jeandle-LLVM, CodeWiki, "main-2025-11"]
tags: ["Jeandle", "LLVM", "GC", "Statepoint", "IR"]
description: "HotspotGC 策略、地址空间划分、元数据/属性常量与 hotspotcc IR 文本语法"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/00-overview)

---

## 模块定位

GC 基础设施模块是 Jeandle-LLVM 的"定义层"——它不变换 IR（那是降级变换层的活），只定义"LLVM 怎么识别 Java 的指针、谁管 GC、IR 文本怎么写"。具体包括：`HotspotGC` GC 策略（告诉 LLVM 哪些指针受 GC 管理、用 statepoint 机制）、地址空间与元数据/属性常量（给降级 pass 和后端引用的命名约定）、RS4GC 的 landingpad 改写（让 statepoint 能处理 Java 异常路径）、以及 `hotspotcc` IR 文本关键字（让人能手写 Jeandle IR）。代码散布在 `llvm/lib/IR/Jeandle/`、`llvm/lib/IR/`、`llvm/lib/AsmParser/`、`llvm/lib/IR/AsmWriter.cpp` 与 `RewriteStatepointsForGC.cpp`。这个模块独立存在，是因为"定义 Java 语义的 IR 标记"与"用这些标记变换 IR"是正交的关注点——定义层稳定，变换层多变。

## 模块架构

```
┌─ GC 基础设施 ─────────────────────────────────────────────┐
│                                                            │
│  GCStrategy.h/cpp        HotspotGC 策略 + "hotspotgc" 注册   │
│       │  isGCManagedPointer(addrspace==1?)                  │
│       │  UseStatepoints=true, UseRS4GC=true                 │
│       ▼                                                     │
│  lib/IR/GCStrategy.cpp   linkAllJeandleGCs() ← 链接期注册    │
│       │                                                     │
│  Metadata.h              AddrSpace{0=CHeap,1=JavaHeap,2=TLS}│
│                          元数据名: current_thread 等         │
│  Attributes.h            属性名: lower-phase 等              │
│                                                            │
│  ── 消费者（其他模块引用这些常量）──                          │
│  InsertGCBarriers        读 JavaHeapAddrSpace + java_method  │
│  TLSPointerRewrite       读 TLSAddrSpace + current_thread    │
│  X86/AArch64 RegisterInfo 读 use-compressed-oops 属性        │
│                                                            │
│  ── IR 文本语法 ──                                          │
│  AsmParser(LLLexer/LLParser)  hotspotcc 关键字 → 解析         │
│  AsmWriter                    Hotspot_JIT → 打印 hotspotcc    │
│                                                            │
│  ── RS4GC landingpad 改写 ──                                 │
│  RewriteStatepointsForGC.cpp  isJeandleGC() → token 类型改写 │
└────────────────────────────────────────────────────────────┘
```

这个模块的核心是"命名约定即契约"：`Metadata.h` 与 `Attributes.h` 用 `constexpr` 字符串常量定义所有标记名，降级 pass 与后端引用这些常量而非硬编码字符串——改名只动一处。`HotspotGC` 通过 `GCRegistry` 静态对象注册，链接 `LLVMJeandle` 库即自动启用，无需显式初始化。

## 调用链路

GC 策略查询链路（`RewriteStatepointsForGC` 运行时）：

```
RewriteStatepointsForGC::run()
  └─ Call->getCaller()->getGC()           // 取函数的 GC 名 = "hotspotgc"
       └─ jeandle::isJeandleGC(Name)      // GCStrategy.cpp:43, 判断是否 Jeandle GC
            └─ (查 GCRegistry 找到 HotspotGC)
                 └─ HotspotGC::isGCManagedPointer(Ty)  // GCStrategy.cpp:29
                      └─ return AddrSpace::JavaHeapAddrSpace == PT->getAddressSpace()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `HotspotGC()` ctor in `GCStrategy.cpp:20` | 设 UseStatepoints/UseRS4GC=true，关 gc.root | 选定 statepoint 而非 gc.root 作为 Java GC 模型 |
| `isGCManagedPointer` in `GCStrategy.cpp:29` | 判断类型是否受 GC 管理 | 仅 addrspace(1) 算受管，C 堆/TLS 指针 GC 不碰 |
| `linkAllJeandleGCs` in `GCStrategy.cpp:45` | 触发链接器保留 GC 注册 | 空函数，靠静态对象 `A` 的副作用注册 |
| `isJeandleGC` in `GCStrategy.cpp:43` | 名字比对 | 简单字符串比较，供 RS4GC 判断是否做 Jeandle 特化 |

</details>

## 核心实现

### HotspotGC 策略与 GCRegistry 注册

`HotspotGC` 继承上游 `llvm::GCStrategy`，通过设置成员标志告诉 LLVM 用哪套 GC 机制：

```cpp title="llvm/lib/IR/Jeandle/GCStrategy.cpp"
class HotspotGC : public llvm::GCStrategy {
public:
  HotspotGC() {
    UseStatepoints = true;   // 用 statepoint 表示 GC 安全点
    UseRS4GC = true;         // 启用 RewriteStatepointsForGC pass
    NeededSafePoints = false; // 以下两项关掉 gc.root 机制
    UsesMetadata = false;
  }
  std::optional<bool> isGCManagedPointer(const llvm::Type *Ty) const override {
    const llvm::PointerType *PT = llvm::cast<llvm::PointerType>(Ty);
    return (llvm::jeandle::AddrSpace::JavaHeapAddrSpace ==
            PT->getAddressSpace());
  }
};
```

三个标志的选择反映了 Jeandle 对 Java GC 模型的取舍。`UseStatepoints=true` 让 LLVM 用 statepoint intrinsic 表示含 GC 管理指针的调用点——statepoint 把"调用 + GC 可能在此发生 + 之后指针可能被移动更新"打包成一个 IR 构造，这正是 Java 的 Stop-The-World GC 需要的。`UseRS4GC=true` 启用 `RewriteStatepointsForGC` pass（流水线阶段 6），由它把隐式 statepoint 改写为显式 statepoint + gc.relocate。`NeededSafePoints=false` 与 `UsesMetadata=false` 关掉上游的 `gc.root` 机制——Java 不用那套，留着会让 `gc.root` lowering 误伤。

`isGCManagedPointer` 是 GC 策略最关键的方法：它回答"这个指针类型 GC 要不要管"。Jeandle 的答案是**看地址空间**——只有 `addrspace(1)`（Java 堆）的指针受 GC 管理，`addrspace(0)`（C 堆）与 `addrspace(2)`（TLS）GC 一概不碰。这让 jeandle-jdk 抽象解释器只需用地址空间标记指针来源，GC 策略自动区分。

注册用上游的 `GCRegistry`：

```cpp title="llvm/lib/IR/Jeandle/GCStrategy.cpp"
static llvm::GCRegistry::Add<HotspotGC> A(JeandleGC, "For Jeandle GC.");
```

`GCRegistry::Add` 是个静态对象——程序启动时构造，把 `HotspotGC` 工厂注册到 registry 表里，key 是 `"hotspotgc"`（`JeandleGC` 常量）。但静态对象可能被链接器优化掉，所以 `lib/IR/GCStrategy.cpp` 的 `linkAllBuiltinGCs()` 旁边调了 `linkAllJeandleGCs()`（空函数，引用即保留注册）：

```cpp title="llvm/lib/IR/GCStrategy.cpp（Jeandle 改动片段）"
llvm::linkAllBuiltinGCs();
llvm::jeandle::linkAllJeandleGCs();
```

函数名 `JeandleGC` 的字符串值定义在头文件里：`constexpr const char *JeandleGC = "hotspotgc"`。jeandle-jdk 产出的 IR 里函数标 `gc "hotspotgc"`，运行时按此名查 registry 找到 `HotspotGC`。

### 地址空间与元数据/属性常量

`Metadata.h` 定义两个核心枚举——地址空间与元数据名：

```cpp title="llvm/include/llvm/IR/Jeandle/Metadata.h"
class Metadata {
public:
  static constexpr const char *CurrentThread = "current_thread";
  static constexpr const char *StackPointer = "stack_pointer";
  static constexpr const char *JavaMethodCompilation = "java_method_compilation";
};
enum AddrSpace : unsigned {
  CHeapAddrSpace = 0,
  JavaHeapAddrSpace = 1,
  TLSAddrSpace = 2
};
```

地址空间是 Jeandle 区分指针来源的基石。jeandle-jdk 抽象解释器产出的 IR 里，Java 堆对象指针写 `ptr addrspace(1)`，线程局部存储写 `ptr addrspace(2)`，普通 C 堆指针写 `ptr`（addrspace 0）。这套划分贯穿全栈：GC 策略用它判断受管指针、`InsertGCBarriers` 用它识别 Java 堆写、`TLSPointerRewrite` 用它找 TLS 指针、后端寄存器分配按它决定寻址。三个地址空间是正交的，没有重叠。

元数据名串起 IR 与降级 pass 的约定：`current_thread` 命名线程寄存器（`!current_thread = !{!"r15"}`），`TLSPointerRewrite` 读它取 TLS 基址；`java_method_compilation` 标记"这是 Java 方法编译产物"，`InsertGCBarriers` 只对有此元数据的模块插屏障——避免给 C/C++ 代码误插。`stack_pointer` 预留给栈指针标记。

`Attributes.h` 定义函数属性名：

```cpp title="llvm/include/llvm/IR/Jeandle/Attributes.h"
class Attribute {
public:
  static constexpr const char *UseCompressedOops = "use-compressed-oops";
  static constexpr const char *StatepointID = "statepoint-id";
  static constexpr const char *StatepointNumPatchBytes = "statepoint-num-patch-bytes";
  static constexpr const char *LowerPhase = "lower-phase";
};
```

`use-compressed-oops` 通知后端预留 compressed-oops 基址寄存器（X86 的 R12、AArch64 的 X27）；`lower-phase` 驱动 `JavaOperationLower` 的相位内联；`statepoint-id` 与 `statepoint-num-patch-bytes` 服务于 statepoint 调用点 patching——后者让 `X86MCInstLower` 知道留多少可 patch 字节并对齐。这些常量集中定义，jeandle-jdk 与 jeandle-llvm 双方共用，避免字符串不一致。

### RS4GC 的 landingpad token 改写

`RewriteStatepointsForGC`（上游 pass，流水线阶段 6）在改写 statepoint 时，需要在异常路径的 landingpad 上附加 GC relocate。上游 landingpad 的返回类型由前端决定，但 statepoint 要求 landingpad 类型为 `token`。Jeandle 的解法是在 RS4GC 里**就地改写类型**：

```cpp title="llvm/lib/Transforms/Scalar/RewriteStatepointsForGC.cpp（Jeandle 改动片段）"
Instruction *ExceptionalToken = UnwindBlock->getLandingPadInst();
if (jeandle::isJeandleGC(Call->getCaller()->getGC()) &&
    ExceptionalToken->getType() !=
        Type::getTokenTy(ExceptionalToken->getContext())) {
  assert(ExceptionalToken->user_empty() &&
         "Unsupported landingpad type for Jeandle when using statepoint!");
  ExceptionalToken->mutateType(
      Type::getTokenTy(ExceptionalToken->getContext()));
}
```

为什么不在前端直接定义 landingpad 为 token？因为 PR #34 的提交信息说明：在前端（jeandle-jdk 抽象解释器）把 landingpad 类型定为 token 会让某些优化 pass 失败。所以 Jeandle 让前端产出正常的类型化 landingpad（如 `landingpad i64`），在 RS4GC 阶段、当确实要给这个 landingpad 挂 GC relocate 时，才用 `mutateType` 改成 token。`assert(user_empty())` 守护了安全性——只有当 landingpad 尚未被其他指令使用时才改，避免破坏类型一致性。`isJeandleGC()` 守卫确保这特化只对 `"hotspotgc"` 策略生效，不影响上游其他 GC 策略的行为。

### hotspotcc IR 文本语法

为了让 Jeandle IR 可读可手写（测试文件全是 `.ll` 文本），Jeandle 在 AsmParser 与 AsmWriter 各加一处 `Hotspot_JIT` 支持。词法层加关键字：

```cpp title="llvm/include/llvm/AsmParser/LLToken.h（Jeandle 改动片段）"
kw_hotspotcc,   // 新增关键字 token
```

```cpp title="llvm/lib/AsmParser/LLLexer.cpp"
KEYWORD(hotspotcc);   // "hotspotcc" → kw_hotspotcc
```

语法层把关键字映射到调用约定枚举：

```cpp title="llvm/lib/AsmParser/LLParser.cpp（Jeandle 改动片段）"
case lltok::kw_hotspotcc:
  CC = CallingConv::Hotspot_JIT;
```

打印层反过来：

```cpp title="llvm/lib/IR/AsmWriter.cpp"
case CallingConv::Hotspot_JIT:
  Out << "hotspotcc";
```

这样 `define hotspotcc i32 @foo(...)` 能被 `opt`/`llc` 正确解析，`opt -S` 也能正确打印。`Hotspot_JIT = 112` 这个 ID 定义在 `CallingConv.h:277`，注释说明它兼容 HotSpot JIT 的约定。整套 IR 文本语法改动不到 10 行，却让 Jeandle 的所有 `.ll` 测试能直接写 Java 函数签名——这是测试可读性的基础。

## 模块间交互

GC 基础设施是 Jeandle-LLVM 中被引用最多的模块——它不主动调别人，别人都来引用它的常量与策略。`InsertGCBarriers` 与 `TLSPointerRewrite` 引用 `Metadata.h`/`Attributes.h` 的地址空间与元数据名；`RewriteStatepointsForGC` 查 `HotspotGC` 的 `isGCManagedPointer` 决定哪些指针要 relocate；X86/AArch64 后端读 `use-compressed-oops` 属性决定预留哪个寄存器。`Pipeline` 在阶段 6 显式 `addPass(RewriteStatepointsForGC())` 触发它。与 jeandle-jdk 的契约是单向的：jeandle-jdk 贴 `gc "hotspotgc"`/属性/元数据，jeandle-llvm 读它们——双方靠 `Metadata.h`/`Attributes.h` 的常量定义对齐字符串。
