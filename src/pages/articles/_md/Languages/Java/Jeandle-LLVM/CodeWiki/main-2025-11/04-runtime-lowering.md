---
source:
  type: "源码解读"
  project: "Jeandle-LLVM"
  url: "https://github.com/jeandle/jeandle-llvm"
title: "运行时降级"
date: "2026-08-19T19:41:28+08:00"
category: [Languages, Java, Jeandle-LLVM, CodeWiki, "main-2025-11"]
tags: ["Jeandle", "LLVM", "TLS", "GC-Barrier", "Card-Table"]
description: "TLSPointerRewrite 与 InsertGCBarriers——把抽象的 addrspace 指针与堆写操作具体化"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/00-overview)

---

## 模块定位

运行时降级模块包含两个函数级 pass：`TLSPointerRewrite`（TLS 指针基址改写）与 `InsertGCBarriers`（card-table 写屏障插入）。两者都在流水线末段跑（阶段 4/5，O3 之后），把抽象解释器产出的"带地址空间标记但未具体化"的 IR 翻译为可直接生成机器码的具体 IR。它们归在同一模块，因为职责同构——都是"识别某类抽象操作（addrspace(2) 指针 / addrspace(1) 写）并替换/插入为具体指令序列"，且都是函数级 pass、都消费 GC 基础设施层的地址空间与元数据常量。代码在 `llvm/lib/Transforms/Jeandle/TLSPointerRewrite.cpp`（114 行）与 `InsertGCBarriers.cpp`（104 行）。

## 模块架构

```
┌─ 运行时降级 ──────────────────────────────────────────────┐
│                                                            │
│  TLSPointerRewrite (Function pass)                          │
│   ├─ 扫描所有 addrspace(2) 指针值（指令/常量）               │
│   ├─ 在函数入口 read_register(current_thread) → tls.base    │
│   └─ 改写为 tls.base.ptr + offset（getelementptr inbounds）  │
│                                                            │
│  InsertGCBarriers (Function pass)                           │
│   ├─ 守卫：模块有 java_method_compilation 元数据？           │
│   ├─ 扫描所有 addrspace(1) 原子 store                        │
│   └─ 写后插入 jeandle.card_table_barrier(base) 调用          │
│      （Hotspot_JIT 调用约定，phase=1 JavaOp）               │
│                                                            │
│  共享：Metadata.h（AddrSpace/元数据名）、Attributes.h         │
└────────────────────────────────────────────────────────────┘
```

两个 pass 都不做任何"优化"决策——它们是确定性的改写：见 addrspace(2) 指针就改基址、见 addrspace(1) 写就插屏障。逻辑是否触发只取决于 IR 里有没有对应模式，没有启发式判断。这种"无脑改写"是故意的——运行时语义的判定权交给抽象解释器（它知道哪些是 Java 堆写、哪些是 TLS 访问），pass 只负责忠实落地。

## 调用链路

### TLSPointerRewrite

```
TLSPointerRewrite::run(F, MAM)                 // TLSPointerRewrite.cpp:27
  └─ NeedRewrite(Val) 判定: addrspace==2 且非 phi/getelementptr/global/arg/ret/call
  └─ 收集 ValuesToRewrite
  └─ 入口处: read_register(current_thread) → tls.base (i64)
  └─ tls.base → inttoptr → tls.base.ptr (addrspace(2))
  └─ for each Val: ptrtoint→offset, getelementptr(tls.base.ptr, offset)→newPtr
       └─ replaceUsesWithIf(newPtr)            // 跳过 offset 计算自身
```

### InsertGCBarriers

```
InsertGCBarriers::run(F, FAM)                  // InsertGCBarriers.cpp:59
  └─ 守卫: M.getNamedMetadata("java_method_compilation") 存在？否→return
  └─ 取 jeandle.card_table_barrier 函数
  └─ for instr in F: isJavaHeapStore? 收集 JavaHeapStores
       └─ isJavaHeapStore: store 且 值/地址都 addrspace(1) 且 atomic
  └─ for each store: 在其后插入
       ├─ experimental_gc_get_pointer_base(derived) → base
       └─ call hotspotcc @jeandle.card_table_barrier(base)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `NeedRewrite` (lambda) in `TLSPointerRewrite.cpp:33` | 判定值是否需改 TLS 基址 | 排除 phi/gep/global/arg/ret/call——这些不该或不能改 |
| `TLSPointerRewrite::run` in `:27` | 改写函数内 TLS 指针 | 基址只读一次放入口，所有改写共享 |
| `isJavaHeapStore` in `InsertGCBarriers.cpp:29` | 判定是否 Java 堆写 | 值与地址都需 addrspace(1) 且 atomic |
| `InsertGCBarriers::run` in `:59` | 插入 card-table 屏障 | 用 `experimental_gc_get_pointer_base` 取派生指针的基址 |

</details>

## 核心实现

### TLSPointerRewrite: NeedRewrite 判定与基址改写

Java 的线程局部数据（如当前线程对象、分配缓冲、栈指针等）通过一个固定的线程寄存器访问——x86 上是 R15（HotSpot 的 `rthread`），AArch64 上是 X28。jeandle-jdk 抽象解释器产出 IR 时，把 TLS 访问写成"绝对地址"的 `addrspace(2)` 指针（如 `inttoptr i64 1160 to ptr addrspace(2)`），其中 1160 是相对线程基址的偏移。`TLSPointerRewrite` 负责把这些"伪绝对地址"改成"线程基址 + 偏移"的真实寻址。

判定哪些值要改写（`NeedRewrite`）排除了几类不该碰的：

```cpp title="llvm/lib/Transforms/Jeandle/TLSPointerRewrite.cpp"
auto NeedRewrite = [&](Value *Val) {
  if (dyn_cast<PHINode>(Val)) return false;          // phi 不改（由其入参改）
  PointerType *ValueType = dyn_cast<PointerType>(Val->getType());
  if (ValueType &&
      ValueType->getAddressSpace() == jeandle::AddrSpace::TLSAddrSpace) {
    assert((dyn_cast<Constant>(Val) ||
            (dyn_cast<Instruction>(Val) && !dyn_cast<ReturnInst>(Val) &&
             !dyn_cast<CallInst>(Val))) &&
           !dyn_cast<GlobalVariable>(Val) && !dyn_cast<Argument>(Val) &&
           "invalid TLS pointer");
    return !dyn_cast<GetElementPtrInst>(Val);        // gep 不改（改其 base 即可）
  }
  return false;
};
```

排除理由各有依据：`PHINode` 不改是因为改它的入参（在分支里各自改）phi 自动合并新值；`GetElementPtrInst` 不改是因为改它的 base 指针后 gep 自然指向新地址；`GlobalVariable`/`Argument`/`ReturnInst`/`CallInst` 不允许是 TLS 指针——`assert` 把这当约束违例报错，因为它们不是线程局部的合法表示。

改写逻辑在函数入口读一次线程寄存器，所有 TLS 指针共享这个基址：

```cpp title="llvm/lib/Transforms/Jeandle/TLSPointerRewrite.cpp"
Builder.SetInsertPoint(&*inst_begin(F));                    // 函数入口
NamedMDNode *ThreadRegister =
    M->getNamedMetadata(jeandle::Metadata::CurrentThread);  // !current_thread = !{!"r15"}
Value *ReadRegsArgs[] = {
    MetadataAsValue::get(F.getContext(), ThreadRegister->getOperand(0))};
Instruction *TLSBase =
    Builder.CreateIntrinsic(Intrinsic::read_register, IntptrType,
                            ReadRegsArgs, {}, "tls.base");    // %tls.base = read_register r15
Value *TLSBasePtr = Builder.CreateIntToPtr(
    TLSBase,
    llvm::PointerType::get(F.getContext(), llvm::jeandle::AddrSpace::TLSAddrSpace),
    "tls.base.ptr");                                          // → ptr addrspace(2)

for (Value *Val : ValuesToRewrite) {
  // 在 Val 之后（指令）或入口（常量）插入
  Value *PtrToInt = Builder.CreatePtrToInt(Val, IntptrType, ... ".tls.offset");
  Value *NewPtr = Builder.CreateInBoundsPtrAdd(TLSBasePtr, PtrToInt, ... ".tls.ptr");
  Val->replaceUsesWithIf(NewPtr, [PtrToInt](Use &U) {
    return U.getUser() != PtrToInt;                          // 别替换 offset 计算自身
  });
}
```

核心变换：原 `inttoptr 1160 to ptr addrspace(2)` 变成 `getelementptr i8, ptr addrspace(2) %tls.base.ptr, i64 1160`。`read_register` 是 LLVM intrinsic，把命名的物理寄存器（`r15`）读成整数。`replaceUsesWithIf` 的守卫 `U.getUser() != PtrToInt` 防止把刚生成的 offset 计算指令的输入也替换掉——那会形成自引用死循环。`thread-local-storage.ll` 测试展示了完整变换：原 IR 里多个 `inttoptr` 常量被统一改写为相对 `%tls.base.ptr` 的 gep，连分支里的 phi 入参也各自改写。

### InsertGCBarriers: Java 堆写检测与屏障插入

分代 GC 用 card-table 记录堆中跨代引用：堆按固定大小（HotSpot 512 字节 = 2^9）分卡片，写堆时把目标地址对应的卡标记为"脏"。`InsertGCBarriers` 在每个 Java 堆写后插入这个"标脏"调用。

守卫确保只对 Java 方法插屏障——C/C++ 代码不该有 card-table 屏障：

```cpp title="llvm/lib/Transforms/Jeandle/InsertGCBarriers.cpp"
Module *M = F.getParent();
if (!M->getNamedMetadata(jeandle::Metadata::JavaMethodCompilation)) {
  return PreservedAnalyses::all();   // 非 Java 方法，跳过
}
Function *CardTableBarrierFunc = M->getFunction("jeandle.card_table_barrier");
assert(CardTableBarrierFunc != nullptr && "jeandle.card_table_barrier must exist");
```

`jeandle.card_table_barrier` 是 jeandle-jdk 声明的模板函数（标 `lower-phase=1`），由 `JavaOperationLower(1)` 在阶段 4 内联展开为具体的 card 标脏逻辑（`ptrtoint → lshr 9 → getelementptr → store i8 0`）。所以本 pass 只插"调用"，真正的标脏代码由后续 phase 1 降级产生——这是两阶段降级的典型用例。

堆写检测（`isJavaHeapStore`）要求值与地址都是 addrspace(1) 且原子：

```cpp title="llvm/lib/Transforms/Jeandle/InsertGCBarriers.cpp"
bool isJavaHeapStore(Instruction *I) {
  StoreInst *SI = dyn_cast<StoreInst>(I);
  if (!SI) return false;
  Value *StoredValue = SI->getValueOperand();
  Value *StoreAddress = SI->getPointerOperand();
  if (!StoredValue->getType()->isPointerTy() ||
      !StoreAddress->getType()->isPointerTy()) return false;
  PointerType *StoredValueTy = dyn_cast<PointerType>(StoredValue->getType());
  PointerType *StoreAddressTy = dyn_cast<PointerType>(StoreAddress->getType());
  if (StoredValueTy->getAddressSpace() != jeandle::AddrSpace::JavaHeapAddrSpace ||
      StoreAddressTy->getAddressSpace() != jeandle::AddrSpace::JavaHeapAddrSpace)
    return false;
  assert(SI->isAtomic() && "store in java heap is expected to be atomic");
  return true;
}
```

为什么要求"值与地址都 addrspace(1)"？因为 Jeandle 只关心"把 Java 堆对象指针写到 Java 堆"的写操作（可能产生跨代引用）——写非指针、写 C 堆地址、或从 C 堆写 Java 堆都不是 card-table 屏障的目标。`assert(isAtomic())` 表明 Jeandle 约定 Java 堆写必须原子（与 HotSpot 内存模型一致），非原子写视为约束违例。

插入逻辑用 `experimental_gc_get_pointer_base` 取派生指针的卡基址：

```cpp title="llvm/lib/Transforms/Jeandle/InsertGCBarriers.cpp"
for (auto SI : JavaHeapStores) {
  IRBuilder<> Builder(SI->getNextNode());           // 在写之后插入
  Value *DerivedPointer = SI->getPointerOperand();
  Type *PointerTy = DerivedPointer->getType();
  Value *BasePointer = Builder.CreateIntrinsic(
      Intrinsic::experimental_gc_get_pointer_base, {PointerTy, PointerTy},
      {DerivedPointer}, {}, "base.pointer");         // 取 GC 对象基址
  CallInst *call = Builder.CreateCall(CardTableBarrierFunc, BasePointer);
  call->setCallingConv(CallingConv::Hotspot_JIT);   // Java 调用约定
}
```

`experimental_gc_get_pointer_base` 是 statepoint 配套的 intrinsic——给定一个 GC 管理的派生指针（如对象内某字段地址），返回它所属对象的基址。card-table 按对象基址算卡号（`base >> 9`），所以屏障需要基址而非派生地址。`card-table-barrier.ll` 测试展示了完整链路：原 IR 只有一个堆写，本 pass 插入 `call @jeandle.card_table_barrier(base.pointer)`，phase 1 降级后展开成 `ptrtoint → lshr 9 → getelementptr card_table → store i8 0`。屏障调用标 `Hotspot_JIT` 调用约定，保证参数传递与寄存器使用符合 Java 约定。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 守卫子句（早退） | `InsertGCBarriers::run:66` 的 `java_method_compilation` 检查 | 非 Java 方法立即返回，避免无谓遍历——把"是否需要屏障"的决策前置 |
| 集合-改写两遍法 | `TLSPointerRewrite` 先收集 `ValuesToRewrite` 再改 | 改写会改变 `instructions(F)` 迭代器，先收集后改避免迭代器失效 |
| 共享基址（单次读取） | `TLSPointerRewrite` 入口读一次 `tls.base` | 所有 TLS 指针共享一个基址，避免重复 `read_register`——既高效又符合"线程寄存器值函数内不变"的语义 |

## 模块间交互

两个 pass 都被 `Pipeline` 在阶段 4/5 用 `createModuleToFunctionPassAdaptor` 包装后加入模块流水线——`InsertGCBarriers` 在阶段 3（O3 之后、phase 1 之前），`TLSPointerRewrite` 在阶段 5（phase 1 之后、statepoint 之前）。它们依赖 GC 基础设施层：`TLSPointerRewrite` 读 `Metadata::CurrentThread` 与 `AddrSpace::TLSAddrSpace`，`InsertGCBarriers` 读 `Metadata::JavaMethodCompilation`、`AddrSpace::JavaHeapAddrSpace` 与 `Attributes`。`InsertGCBarriers` 与 `JavaOperationLower(1)` 强协作——前者插入的 `jeandle.card_table_barrier` 调用由后者在阶段 4 展开。`InsertGCBarriers` 还依赖上游 statepoint intrinsic `experimental_gc_get_pointer_base`（阶段 6 RS4GC 的产物之一），所以它必须在 RS4GC 之前跑——实际流水线里它在 phase 1 之前，RS4GC 在最后，顺序正确。
