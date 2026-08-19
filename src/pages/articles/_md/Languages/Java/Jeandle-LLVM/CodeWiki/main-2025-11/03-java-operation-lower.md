---
source:
  type: "源码解读"
  project: "Jeandle-LLVM"
  url: "https://github.com/jeandle/jeandle-llvm"
title: "Java 操作降级"
date: "2026-08-19T19:41:28+08:00"
category: [Languages, Java, Jeandle-LLVM, CodeWiki, "main-2025-11"]
tags: ["Jeandle", "LLVM", "Inlining", "JavaOp"]
description: "JavaOperationLower 两阶段 pass——按 lower-phase 属性内联并擦除 JavaOp 模板函数"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Jeandle-LLVM/CodeWiki/main-2025-11/00-overview)

---

## 模块定位

Java 操作降级模块是 jeandle-jdk 抽象解释器与 LLVM 优化流水线之间的关键桥梁。jeandle-jdk 的抽象解释器在翻译字节码时，并不直接产出最终 IR，而是产出大量**模板函数调用**——每个"Java 操作"（算术、类型转换、屏障、运行时调用）是一个标了 `lower-phase` 属性的小函数，由调用点引用。`JavaOperationLower` 的职责是在流水线的两个相位把这些模板函数**内联展开到调用点并擦除定义**，让后续 pass 看到的是真实代码而非不透明的 call。这个模块独立成文，因为"两阶段降级"是 Jeandle 最独特的设计——它让屏障等运行时逻辑既能被 O3 优化（早期不展开）、又能最终落地（晚期展开），是 JavaOp 模板机制的核心。代码在 `llvm/lib/Transforms/Jeandle/JavaOperationLower.cpp`（173 行）。

## 模块架构

```
JavaOperationLower(Phase)            ← Module pass，Phase=0 或 1
   │
   ▼
 run(M, MAM)                          ← 入口，取 FAM/PSI/AA/AssumptionCache
   │
   ▼
 runImpl(M, Phase, FAM, GetAAR, PSI, GetAssumptionCache)
   │
   ├─ shouldInline(F)                 ← 判定：函数有 lower-phase 属性 且 值==Phase？
   │     └─ 读 jeandle::Attribute::LowerPhase ("lower-phase")
   │
   │  for each matching Function F:
   │    ├─ removeFunctionFromLLVMUsed(M, F)   ← 从 llvm.used 摘掉 F（否则删不掉）
   │    ├─ for each CallBase CB in F.users():
   │    │     └─ InlineFunction(*CB, ...)     ← 内联到调用点
   │    ├─ F.removeDeadConstantUsers()
   │    └─ M.getFunctionList().erase(F)      ← 擦除模板函数定义
   │
   ▼
 return Changed
```

`JavaOperationLower` 是个极简 pass——它只做"按属性筛选 + 内联 + 删除"三件事，没有任何 Java 语义知识。JavaOp 是什么、展开成什么，全由 jeandle-jdk 抽象解释器在产出 IR 时决定。pass 只认 `lower-phase` 属性，相位匹配就内联。这种"机制与策略分离"让它能承载任意的模板降级需求——新增一种 JavaOp 不改这个 pass。

## 调用链路

```
JavaOperationLower::run(M, MAM)                    // JavaOperationLower.cpp:152
  └─ FAM = MAM.getResult<...FunctionAnalysisManagerModuleProxy>(M)
  └─ runImpl(M, Phase, &FAM, GetAAR, PSI, GetAssumptionCache)  // :164
       │
       for (Function &F : make_early_inc_range(M))    // :94 遍历模块函数
         └─ shouldInline(F)                           // :83 查 lower-phase 属性
              ├─ removeFunctionFromLLVMUsed(M, F)     // :105
              ├─ for CB in F.users(): InlineFunction  // :117-130
              ├─ F.removeDeadConstantUsers()          // :132
              └─ M.getFunctionList().erase(F)         // :138
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `shouldInline` (lambda) in `JavaOperationLower.cpp:83` | 判定函数是否本相位该内联 | 用 `lower-phase` 属性值==Phase 匹配，不匹配的留到下一相位 |
| `removeFunctionFromLLVMUsed` in `JavaOperationLower.cpp:29` | 从 `llvm.used` 摘除函数 | 不摘则 erase 失败——`llvm.used` 保护函数不被删 |
| `InlineFunction` (上游) in `:120` | 把模板内联到调用点 | `MergeAttributes=true` 让属性合并到调用者 |
| `run` in `:152` | 装配分析后委托 runImpl | 取 FAM/PSI/AA/AssumptionCache 供内联用 |

</details>

## 核心实现

### 两阶段降级的 Phase 机制

`JavaOperationLower` 用构造参数 `Phase` 区分执行时机，同一类在流水线里跑两次：

```cpp title="llvm/include/llvm/Transforms/Jeandle/JavaOperationLower.h"
class JavaOperationLower : public PassInfoMixin<JavaOperationLower> {
public:
  JavaOperationLower(int Phase) : Phase(Phase) {}
  void printPipeline(raw_ostream &OS, ...) {
    OS << "<phase=" << Phase << '>';   // 流水线文本显示 phase=0 / phase=1
  }
  PreservedAnalyses run(Module &M, ModuleAnalysisManager &MAM);
private:
  int Phase;
};
```

`Phase` 是 `int` 而非枚举，支持未来扩展更多相位。`printPipeline` 让 `opt --print-pipeline-passes` 输出 `java-operation-lower<phase=0>` 与 `java-operation-lower<phase=1>`——`opt-option.ll` 测试就靠这个核对流水线装配正确。

两相位的意义在流水线编排里：phase 0 在 O3 之前展开"早期 JavaOp"（字节码直接对应的操作），让优化器看到真实代码；phase 1 在 O3 之后、GC 屏障插入之后展开"晚期 JavaOp"（如 `jeandle.card_table_barrier`，需先被插入再被展开）。`shouldInline` 的判定逻辑把相位匹配做成了纯属性查询：

```cpp title="llvm/lib/Transforms/Jeandle/JavaOperationLower.cpp"
auto shouldInline = [Phase](const Function &F) -> bool {
  if (!F.hasFnAttribute(jeandle::Attribute::LowerPhase))
    return false;
  int V = 0;
  bool Failed = F.getFnAttribute(jeandle::Attribute::LowerPhase)
                    .getValueAsString()
                    .getAsInteger(10, V);
  assert(!Failed && "wrong value of LowerPhase attribute");
  return V == Phase;
};
```

没有 `lower-phase` 属性的函数一律跳过——这些是正常的 Java 方法或运行时函数，不是 JavaOp 模板。有属性且值等于当前 Phase 的才内联。`assert` 守护属性值必须是合法整数，避免字符串属性配错导致静默错误。

### JavaOp 内联流程

`runImpl` 对每个匹配的 JavaOp 函数，先处理 `llvm.used` 再逐个内联调用点，最后擦除函数：

```cpp title="llvm/lib/Transforms/Jeandle/JavaOperationLower.cpp"
for (Function &F : make_early_inc_range(M)) {
  if (!shouldInline(F))
    continue;
  // ... assertions: 不是 presplit coroutine、不是 declaration、可内联
  if (removeFunctionFromLLVMUsed(M, F)) { /* ... */ }

  Calls.clear();
  for (User *U : F.users())
    if (auto *CB = dyn_cast<CallBase>(U)) {
      if (CB->getCalledFunction() == &F)
        Calls.insert(CB);
    }

  for (CallBase *CB : Calls) {
    Function *Caller = CB->getCaller();
    InlineFunctionInfo IFI(GetAssumptionCache, &PSI, nullptr, nullptr);
    InlineResult Res = InlineFunction(*CB, IFI, /*MergeAttributes=*/true,
                                      &GetAAR(F), /*InsertLifetime=*/true);
    if (!Res.isSuccess()) { /* debug log, continue */ }
    if (FAM)
      FAM->invalidate(*Caller, PreservedAnalyses::none());
  }

  F.removeDeadConstantUsers();
  assert(F.user_empty() && "JavaOp should not be used after lowering");
  if (FAM)
    FAM->clear(F, F.getName());
  M.getFunctionList().erase(F);
}
```

几个设计细节值得注意：

- **`make_early_inc_range`**：遍历时安全删除——`erase(F)` 改变 `Module` 的函数链表，普通迭代器会失效，早期递增迭代器在自增前擦除当前元素才安全。
- **`MergeAttributes=true`**：内联时把 JavaOp 的函数属性合并到调用者。这让 `use-compressed-oops` 等属性从模板传播到真正的方法函数，后端才能据此预留寄存器。
- **`FAM->invalidate` 与 `FAM->clear`**：内联改了调用者函数体，必须失效其分析缓存；擦除函数后清掉它的分析结果，防止悬空引用。这是 New Pass Manager 的正确性要求。
- **`assert(F.user_empty())`**：内联完所有调用点后，JavaOp 应无人引用——若仍有 user 说明有非 `CallBase` 的使用（如地址被取），这违背 JavaOp 的契约，断言失败暴露问题。
- **`InsertLifetime=true`**：插入 lifetime 标记，帮助优化器管理栈槽——这对 JavaOp 展开后的局部变量生命周期分析有用。

### llvm.used 处理

`removeFunctionFromLLVMUsed` 解决一个具体的工程障碍：`llvm.used` 是个全局数组，列出"不可被优化器删除"的符号。jeandle-jdk 把 JavaOp 模板放进 `llvm.used` 防止它们在 phase 0 之前被 DCE 误删。但 `JavaOperationLower` 要主动 erase 这些函数，若不先从 `llvm.used` 摘除，`erase` 会因"仍被 `llvm.used` 引用"而失败或留残：

```cpp title="llvm/lib/Transforms/Jeandle/JavaOperationLower.cpp"
static bool removeFunctionFromLLVMUsed(Module &M, Function &F) {
  GlobalVariable *UsedArray = M.getGlobalVariable("llvm.used");
  if (!UsedArray) return false;
  ConstantArray *InitArray = cast<ConstantArray>(UsedArray->getInitializer());
  // ... 收集非 F 的元素到 NewElements
  if (!found) return false;
  UsedArray->eraseFromParent();           // 删旧数组
  if (NewElements.empty()) return true;   // 空了不再重建
  // 用保留的元素重建 llvm.used
  auto *NewUsedArray = new GlobalVariable(
      M, NewArrayTy, false, GlobalValue::AppendingLinkage,
      ConstantArray::get(NewArrayTy, NewElements), "llvm.used");
  NewUsedArray->setSection("llvm.metadata");
  return true;
}
```

实现是"删旧建新"——`llvm.used` 是不可变的全局，不能原地改元素，只能 erase 掉再用保留的元素重建。`lately-use-cross-default-opt.ll` 测试专门验证跨 `default<O3>` 的 `llvm.used` 处理：phase 0 后 `llvm.used` 仍含屏障函数（phase 1 才展开），phase 1 后 `llvm.used` 被清空、屏障函数被 erase。这印证了两阶段时序——`llvm.used` 在两次降级间保护了 phase 1 的 JavaOp 不被 O3 误删。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 模板方法（相位参数化） | `JavaOperationLower(Phase)` 构造 in `JavaOperationLower.h:20` | 同一 pass 类复用两次，相位用参数区分而非拆两个类——减少代码重复 |
| 策略筛选（属性驱动） | `shouldInline` lambda in `:83` | 内联决策完全由 IR 属性驱动，pass 不硬编码"哪些是 JavaOp"——jeandle-jdk 贴属性即声明 |
| 早期递增遍历 | `make_early_inc_range(M)` in `:94` | 遍历中删除元素的安全惯用法，LLVM 标准模式 |

## 模块间交互

`JavaOperationLower` 是 Module 级 pass，被 `Pipeline` 在阶段 1（phase 0）和阶段 4（phase 1）显式 `addPass`。它依赖 GC 基础设施层的 `Attributes.h`（`LowerPhase` 常量）与上游 `InlineFunction`（需 `AssumptionCache`/`AAResults`/`ProfileSummaryInfo` 分析）。它的"上游"是 jeandle-jdk 抽象解释器产出的 IR（贴了 `lower-phase` 属性的 JavaOp 函数），"下游"是 O3 优化（phase 0 后 O3 看到展开的代码）与后端代码生成（phase 1 后模板全消失，只剩具体 IR）。与 `InsertGCBarriers` 协作：后者插入的 `jeandle.card_table_barrier` 是 phase 1 的 JavaOp，由本 pass 在阶段 4 展开。
