---
source:
  type: "源码解读"
  project: "Jeandle-JDK"
  url: "https://github.com/jeandle/jeandle-jdk"
title: "VM 状态与 SSA"
date: "2026-08-19T17:50:32+08:00"
category: ["Languages", "Java", "Tools", "Jeandle-JDK", "CodeWiki", "main-2025-12"]
tags: ["Jeandle", "SSA", "Phi", "抽象解释"]
description: "Jeandle 抽象解释器的 SSA 构造：JeandleVMState 的 Phi 合并、循环头状态与死局部失效"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回抽象解释器](/vibe-reading/articles/Languages/Java/Tools/Jeandle-JDK/CodeWiki/main-2025-12/02-abstract-interpreter)

---

## 主题定位

本深度文档聚焦抽象解释器中最微妙的算法部分：**如何在逐块模拟 JVM 栈帧的同时构造合法的 LLVM SSA**。Jeandle 不像传统编译器先建 CFG 再做独立的 SSA 构造 pass——它把 SSA 构造**融合进抽象解释的过程**，Phi 节点在状态合并时即时创建。这要求 `JeandleVMState` 既是"语义模拟器"又是"SSA 值载体"，两重身份的耦合产生了本文要拆解的几个设计权衡：Phi 的按需创建、循环头的初始状态副本、死局部的失效处理。

## 核心原理

### 双身份的 JeandleVMState

`JeandleVMState` 的栈与局部变量存的是 `TypedValue`（`BasicType` + `llvm::Value*`）。在单前驱直传块里，这些 `llvm::Value*` 就是 `IRBuilder` 生成的普通指令结果；但在多前驱的 join 块里，局部/栈槽的值必须是 `llvm::PHINode`——即来自不同前驱的同名值汇聚成一个 Phi。关键设计是：**Phi 节点在首个前驱到达时创建（`initialize_VM_state_from`），后续前驱到达时补 incoming 值（`update_phi_nodes`）**。这避免了预先知道前驱总数，也让 RPO 工作表遍历天然驱动 Phi 填充——前驱先于后继处理，等到后继被解释时所有前驱都已补完 incoming。

![Phi 合并](/vibe-reading/images/articles/jeandle-jdk/ssa-merge.svg)

合并前先做 `match()` 前置校验——栈深度、对应槽的 LLVM 类型、锁数三者一致才允许合并。这是语义正确性的硬约束：JVM 字节码保证同一点的栈形状确定，若 Jeandle 模拟出的形状不一致说明字节码非法或翻译有 bug，`match` 失败直接 `report_jeandle_error` 而非静默生成非法 IR。

### initialize_VM_state_from：首前驱建 Phi

当后继块的 `_jvm` 还是 `nullptr` 且前驱数 > 1（或它是异常处理块——保守地视作多前驱），`initialize_VM_state_from` 被调用来从首个前驱的状态建立后继状态，并对每个活跃局部/栈槽创建 Phi：

```cpp title="jeandleAbstractInterpreter.cpp"
for (size_t i = 0; i < incoming_state->locals_size(); i++) {
  if (incoming_state->locals_at(i) == nullptr) continue;
  // 用方法 liveness 失效死局部
  if (liveness.is_valid() && !liveness.at(i)) continue;
  llvm::PHINode* phi_node = ir_builder.CreatePHI(incoming_state->locals_at(i)->getType(), 2);
  phi_node->addIncoming(incoming_state->locals_at(i), incoming_block);
  _jvm->set_locals_at(i, TypedValue(incoming_state->locals_type_at(i), phi_node));
}
```

两个 why 在此显形：**Phi 的 `reservedIncomingCount` 给 2**（而非精确前驱数）——因为异常处理块的前驱数无法精确知道（任何抛出点都是隐式前驱），给 2 是保守的小预分配，LLVM 会自动扩容。**liveness 失效死局部**——用 `method->liveness_at_bci` 的活跃性分析跳过非活跃局部，不为死局部建 Phi，既减小 IR 也避免"死值流入"的语义噪音。

### update_phi_nodes：后续前驱补 incoming

后续前驱到达时走另一分支：`_jvm` 已存在且非循环头，调 `update_phi_nodes` 把该前驱的值补进对应 Phi：

```cpp title="jeandleAbstractInterpreter.cpp"
bool JeandleVMState::update_phi_nodes(JeandleVMState* income_jvm, llvm::BasicBlock* income_block) {
  if (!match(income_jvm)) return false;
  for (size_t i = 0; i < _locals.size(); i++) {
    if (_locals[i].is_null()) continue;
    llvm::PHINode* phi_node = llvm::cast<llvm::PHINode>(_locals[i].value());
    if (income_locals[i].is_null() || phi_node->getType() != income_locals[i].value()->getType()) {
      invalidate_local(i);   // 类型漂移，杀掉该局部
      continue;
    }
    phi_node->addIncoming(income_locals[i].value(), income_block);
  }
  // 同理补栈槽 Phi ...
}
```

注意 `cast<PHINode>` 的前提：join 块的局部槽在 `initialize_VM_state_from` 里被设成了 Phi，故这里能安全 cast。若某前驱的对应槽为 null 或类型不匹配（category 漂移），`invalidate_local` 把该槽置 `null_value()`——这会让后续 `load` 该局部时触发断言，实质是拒绝不合法的类型合并。

### 循环头的 _initial_jvm 副本

循环是最棘手的场景。循环头是回边目标，当回边前驱（循环尾块）处理时，循环头的 Phi 已被首前驱创建并已被其他前驱补过——但回边前驱要补的 incoming 此时才出现。问题：循环头的 `_jvm` 在它自身被解释时已被消费（`interpret_block` 用它生成 IR），回边补 incoming 需要找"当初建 Phi 时的状态"而非"解释后的状态"。解法是 `merge_VM_state_from` 在首次建循环头状态时额外存一份 `_initial_jvm = _jvm->copy()`：

```cpp title="jeandleAbstractInterpreter.cpp"
if (is_set(is_loop_header)) {
  _initial_jvm = _jvm->copy();   // 循环头初始状态副本
}
// ...
} else if (is_set(is_loop_header)) {
  assert(_initial_jvm != nullptr, "loop header initial JeandleVMState is needed");
  return _initial_jvm->update_phi_nodes(vm_state, incoming);   // 回边补 incoming 到初始副本的 Phi
}
```

回边前驱把 incoming 补到 `_initial_jvm` 的 Phi 上——而那些 Phi 正是循环头块入口处使用的值。这一副本机制让循环头的既能被正常解释、又能在回边到达时正确补全 Phi，是整个 SSA 构造里最巧妙的点。

## 实现细节

### 双字类型与 Phi 的交互

`push` 双字值（long/double）会压一个 null 占位槽。在 `initialize_VM_state_from` 建栈 Phi 时，遇到 null 槽用 `raw_push(TypedValue::null_value())` 跳过建 Phi——占位槽不参与合并，只有真值槽建 Phi。这保证双字值的 Phi 语义正确（一个 Phi 对应一个真值）。

### 异常处理块的特殊性

`merge_VM_state_from` 里有一段注释揭示了保守设计："Since we don't know exactly how many predecessor blocks an exception handler will have, we create phi nodes for every exception handler conservatively." 异常处理块即使只有显式的一个前驱，也被当多前驱处理建 Phi——因为任何覆盖范围内的抛出点都是隐式前驱。`copy_for_exception_handler` 在合并时清空栈（`clear_stack=true`）再压入异常 oop，复刻 JVM 异常处理块入口"栈仅含异常对象"的语义。

### 单前驱直传：不建 Phi

并非所有后继都建 Phi。单前驱且非异常处理块的情况，`merge_VM_state_from` 直接 `_jvm = vm_state->copy()`——浅拷贝前驱状态，不建任何 Phi。这是优化：直传块无需 Phi，值的定义直接来自前驱。只有多前驱（或异常处理块）才进入建 Phi 路径。

## 性能与权衡

- **按需建 Phi vs 预建全块**：Jeandle 选择按需（首前驱到达时建），省去了预知前驱总数的难题，代价是 Phi 的 `reservedIncomingCount` 给保守值 2，多前驱时 LLVM 内部扩容有轻微开销——可接受，因 join 块前驱数通常不大。
- **RPO 工作表 vs 数据流不动点**：经典 SSA 构造用不动点迭代处理循环，Jeandle 用 RPO 顺序 + `_initial_jvm` 副本一次性完成——一次遍历即可，因 RPO 保证前驱先于后继（除回边外），回边单独用副本处理。代价是循环嵌套深时副本开销线性增长，但 Java 方法循环嵌套通常浅。
- **liveness 失效死局部**：建 Phi 前用活跃性跳过死局部，减小 IR 体积与后续优化负担——这是与 HotSpot C1 类似（注释明示 "Like C1's ValueStack::is_same"）的成熟权衡。
