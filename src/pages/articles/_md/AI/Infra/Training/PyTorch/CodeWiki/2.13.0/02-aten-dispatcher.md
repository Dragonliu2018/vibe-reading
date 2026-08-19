---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "ATen 算子库与 Dispatcher"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "ATen", "Dispatcher", "DispatchKey", "codegen"]
description: "ATen 定义 Tensor 类型、native ops 实现与核心 Dispatcher 分发机制——基于 DispatchKey 位集的 O(1) 运行时分发，PyTorch 摒弃虚函数表、支持正交扩展的根基。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

ATen（"A Tensor Library"）是 PyTorch 的算子库与分发引擎，位于分层架构第二层（青框）。它定义 `Tensor`/`TensorBase` 对外类型、所有 native 算子的 CPU/CUDA 实现，以及核心的 **Dispatcher**——一个基于 `DispatchKey` 位集的运行时分发机制，决定"一次 `torch.add` 该调用哪个 backend 的哪个 kernel"。

ATen 是 c10 的直接消费者（`TensorBase` 只是 `c10::intrusive_ptr<TensorImpl>` 的壳），又是 `torch/csrc`（autograd、JIT）和 Python `torch` 的供应商。理解 ATen 的关键是理解 Dispatcher：它用一张预计算的 dispatch table 把"backend×functionality"的多维分发压缩成 O(1) 数组下标查询，同时支持运行时注册、Jupyter 重载、自定义 backend。这是 PyTorch 摒弃虚函数表、支持正交扩展的根基。深度机制见 [Dispatcher 分发机制详解](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/02b-aten-dispatcher-key-dispatch)。

## 模块架构

ATen 内部围绕 Dispatcher 单例组织，算子注册与调用分离：

```text
┌──────────────────────────────────────────────────────────────┐
│  at::Tensor / TensorBase (TensorBase.h)                       │
│  intrusive_ptr<TensorImpl>  →  委托给 c10::TensorImpl          │
└──────────────────────────┬───────────────────────────────────┘
                           │ at::add(self, other)  (codegen: ops/add.h)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Dispatcher (singleton, Dispatcher.h)                         │
│  operatorLookupTable_:  OperatorName → OperatorHandle         │
│  operators_:  list<OperatorDef>                               │
│  backendFallbackKernels_:  array<AnnotatedKernel>             │
└──────────┬───────────────────────────────────────────────────┘
           │ lookup(dispatchKeySet)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  OperatorEntry (OperatorEntry.h)                              │
│  dispatchTable_: array<KernelFunction, N>  ← O(1) 查表        │
│  dispatchKeyExtractor_: 预计算位掩码                          │
│  kernels_: map<DispatchKey, list<AnnotatedKernel>>  ← 全量历史│
└──────────┬───────────────────────────────────────────────────┘
           │ kernel.call(args)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  KernelFunction (KernelFunction.h)                            │
│  unboxed_kernel_func_ (函数指针, 热路径)                        │
│  boxed_kernel_func_ (IValue 栈, Python/RecordFunction)        │
└──────────┬───────────────────────────────────────────────────┘
           │ 命中 native impl
           ▼
┌──────────────────────────────────────────────────────────────┐
│  native ops (native/BinaryOps.cpp 等)                         │
│  TORCH_META_FUNC → TensorIterator                             │
│  TORCH_IMPL_FUNC → add_stub(device, iter, alpha)              │
│  DispatchStub → CPU(AVX)/CUDA 向量化 kernel                    │
└──────────────────────────────────────────────────────────────┘
```

四个核心组件各司其职：`TensorBase` 是瘦句柄（仅一个 `intrusive_ptr`，切断对 `native_functions.yaml` 的编译依赖以加速增量编译）；`Dispatcher` 是全局单例注册表；`OperatorEntry` 是单算子的注册项，持有预计算 dispatch table；`KernelFunction` 是 kernel 的可调用包装。codegen 闭环：`native/native_functions.yaml`（schema）→ `templates/{Functions.h, Operators.h, TensorBody.h}` → 生成 `ops/<op>.h`、`RegisterCPU.cpp`、`RegisterCUDA.cpp`、`VariableType.cpp`。

## 调用链路

一次 `at::add(a, b)` 的完整分发链：

```text
at::add(self, other, 1)                     # 生成于 ops/add.h (codegen)
  └─ TypedOperatorHandle::call              # Dispatcher.h:613  C10_ALWAYS_INLINE
     └─ Dispatcher::singleton().call        # Dispatcher.h:770
        ├─ dispatchKeyExtractor().getDispatchKeySetUnboxed(args)
        │    # DispatchKeyExtractor.h:62  OR 各 tensor.key_set()
        │    # computeDispatchKeySet: (ks | tls.included) - tls.excluded & mask
        │    → DispatchKeySet
        ├─ op.operatorDef_->op.lookup(dispatchKeySet)
        │    # OperatorEntry.h  idx = ks.getDispatchTableIndexForDispatchKeySet()
        │    # kernel = dispatchTable_[idx]   ← O(1) 数组下标
        │    → const KernelFunction&
        ├─ (可选) callWithDispatchKeySlowPath: RecordFunction/profiler
        └─ kernel.call<Return,Args...>(op, dispatchKeySet, args...)
             └─ unboxed_kernel_func_ 函数指针
                ├─ at::meta::add(self,other,alpha)    # build TensorIterator
                ├─ at::native::TORCH_IMPL_FUNC(add)  # 调 add_stub(...)
                └─ DispatchStub::operator()(device_type, iter, alpha)
                     # DispatchStub.h:256  call_ptr = get_call_ptr(kCPU)
                     # 选 AVX2/AVX512/默认
                     (*call_ptr)(iter, alpha)         # 向量化 kernel
```

分发链的核心设计：`getDispatchKeySetUnboxed` 用 `DispatchKeyExtractor` 预计算的 `dispatch_arg_indices_reverse_` 位掩码（`DispatchKeyExtractor.h:165`），一次性 OR 出所有 tensor 参数的 keyset，避免运行时遍历参数栈。`lookup` 是纯数组下标查询——`dispatchTable_` 是 `std::array<KernelFunction, num_runtime_entries>`，无哈希、无分支预测惩罚。`redispatch`（`Dispatcher.h:843`）路径相同但不做 RecordFunction，`currentDispatchKeySet` 原样使用——这正是 Autograd kernel 调完包装后 `redispatch` 去掉 Autograd 位、下钻到 backend kernel 的机制。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `Dispatcher::call` | `Dispatcher.h:770` | 算子分发主入口 | `C10_ALWAYS_INLINE` 强制内联消除调用开销 |
| `getDispatchKeySetUnboxed` | `DispatchKeyExtractor.h:165` | 从 tensor 参数提取 keyset | 预计算位掩码避免运行时遍历 |
| `OperatorEntry::lookup` | `OperatorEntry.h` | dispatch table 查表 | `std::array` O(1) 下标，进 CPU cache |
| `KernelFunction::call` | `KernelFunction.h:289` | 调用 kernel 函数指针 | unboxed 优先，失败退 boxed |
| `Dispatcher::redispatch` | `Dispatcher.h:843` | 去 key 后重新分发 | Autograd → backend 下钻机制 |
| `registerDef`/`registerImpl` | `Dispatcher.h:247` | 注册算子 schema/kernel | 返回 RAII handle 管理生命周期 |
| `TORCH_IMPL_FUNC(add)` | `native/BinaryOps.cpp:151` | structured op impl | meta+impl 分离，复用 TensorIterator |
| `DispatchStub::operator()` | `DispatchStub.h:256` | 选 ISA 特化 kernel | 运行时 CPUID 选 AVX2/AVX512 |

</details>

## 核心实现

### Dispatcher 单例与算子注册表

`Dispatcher`（`Dispatcher.h`）是全局单例，拥有三张表：

```cpp title="aten/src/ATen/core/dispatch/Dispatcher.h"
class Dispatcher final {
  std::list<OperatorDef> operators_;                      // 算子定义链表
  LeftRight<flat_hash_map<OperatorName, OperatorHandle>>  // 名字→handle 查找
      operatorLookupTable_;
  std::array<AnnotatedKernel, num_runtime_entries>
      backendFallbackKernels_;                            // backend 级 fallback
  static Dispatcher& singleton();                         // C10_ALWAYS_INLINE
};
```

`LeftRight` 是一个无锁读、写时复制的并发容器——读（`call` 热路径）完全无锁，写（`registerImpl`，发生在库加载期）复制后原子切换指针。`operatorLookupTable_` 用 `OperatorName`（namespace::name，如 `aten::add`）查 `OperatorHandle`。注册通过 `registerDef`（声明 schema）、`registerImpl`（注册某 DispatchKey 的 kernel）、`registerFallback`（注册 backend 级 fallback）三个方法，均返回 `RegistrationHandleRAII` 管理生命周期，支持动态库卸载时自动注销。

### OperatorEntry 预计算 dispatch table

`OperatorEntry`（`OperatorEntry.h`）是单算子的注册项，核心是 dispatch table 与 kernel 历史的分离：

```cpp title="aten/src/ATen/core/dispatch/OperatorEntry.h"
class OperatorEntry final {
  OperatorName name_;
  std::optional<AnnotatedSchema> schema_;
  std::array<KernelFunction, num_runtime_entries> dispatchTable_;  // 热路径 O(1)
  DispatchKeyExtractor dispatchKeyExtractor_;                       // 预计算位掩码
  flat_hash_map<DispatchKey, std::list<AnnotatedKernel>> kernels_; // 全量注册历史
};
```

`dispatchTable_` 与 `kernels_` 分离的原因（`OperatorEntry.h` 注释）：dispatch table 频繁访问需小到能进 CPU cache（`num_runtime_entries` 个 `KernelFunction`，每个仅三个指针）；`kernels_` 含 schema/debug 字符串体积大但访问稀疏，且为支持 Jupyter 重复注册——同一 DispatchKey 可注册多次（list 前插），`dispatchTable_[idx]` 始终等于 `kernels_[dk].front()`（新覆盖旧、保留历史用于回滚）。`registerKernel` 写 `kernels_` 并调 `updateDispatchTableEntry_` 重算 table 槽；`updateFallback` 在 backend fallback 变更时遍历所有算子重算。fallback 归 `Dispatcher` 拥有、kernel 归 `OperatorEntry` 拥有——这种非对称是因为 fallback 跨所有算子共享。

### DispatchKey 分层与优先级

`DispatchKey` 枚举（`c10/core/DispatchKey.h:136`）分三类：

- **BackendComponent**（低 ~12 bit）：CPU/CUDA/HIP/MPS/XPU/MTIA/HPU/PrivateUse1…，标识"哪个设备"。
- **Functionality keys**（高位）：`Dense`/`Sparse`/`SparseCsr`/`Quantized`/`BackendSelect`/`Fake`/`Python`/`Functionalize`/`Autograd*` 等，标识"哪一层处理"。
- **Alias keys**：`CompositeImplicitAutograd`/`CompositeExplicitAutograd`/`Autograd`，不占 runtime slot，用于注册跨 backend 的复合实现。

优先级规则（`DispatchKey.h:115`）：高功能位优先。一个 requires_grad 的 CPU float tensor，keyset 含 `AutogradCPU`（高优先级）和 `CPU`——`highestPriorityTypeId` 先命中 `AutogradCPU`，Autograd kernel 执行（构建反向图）后 `redispatch` 去掉 Autograd 位，下钻到 `CPU` kernel。Functionalize 高于 Autograd，用于 functorch 函数化变换。这种层次结构让"正交维度"（设备×处理层）无需类爆炸即可组合。

### KernelFunction 双轨调用约定

`KernelFunction`（`KernelFunction.h:289`）持三个指针：

```cpp title="aten/src/ATen/core/boxing/KernelFunction.h"
BoxedKernel boxed_kernel_func_;   // void(const OperatorHandle&, DispatchKeySet, Stack*)
void* unboxed_kernel_func_;        // 类型擦除的函数指针（热路径）
void* sym_unboxed_kernel_func_;    // 符号化版本
```

双轨设计：**unboxed**（类型擦除的 C 模板实例化函数指针，热路径，无 IValue 装箱开销）与 **boxed**（`void(const OperatorHandle&, DispatchKeySet, Stack*)`，IValue 栈，用于 Python/跨语言/RecordFunction）。`KernelFunction::call` 优先 unboxed（`isValidUnboxed()` 检查），失败才退 boxed。codegen 生成的 `TypedOperatorHandle::call` 是 unboxed 路径，直接传 C++ 类型参数；Python 绑定和 profiler 走 boxed 路径经 `Stack*` 传 IValue。

### structured op 与 DispatchStub

以 `add` 为例的 structured op 实现模式（`native/BinaryOps.cpp:151`）：

```cpp title="aten/src/ATen/native/BinaryOps.cpp"
TORCH_META_FUNC2(add, Tensor) {  // meta: 构造 TensorIterator（输出 shape/dtype 推断）
  build_borrowing_binary_op(miter, self, other);
}
TORCH_IMPL_FUNC(add_out) {  // impl: 调 stub 执行
  add_stub(device_type(), *miter, alpha);
}
```

`add_stub` 是 `DispatchStub`（`native/DispatchStub.h`），`DECLARE_DISPATCH`/`DEFINE_DISPATCH`/`REGISTER_DISPATCH` 在 build 时 codegen 注入 CPU/CUDA 实现。`DispatchStub::operator()`（`:256`）运行时调 `get_call_ptr(kCPU)`，按 CPUID 选 AVX2/AVX512/默认 kernel——这是 CPU 算子 ISA 分支的标准机制。meta+impl 分离让 shape 推断与计算解耦，`TensorIterator` 处理广播、类型提升、内存连续化等通用逻辑，具体 kernel 只需逐元素计算。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 注册表 | `Dispatcher` 单例 + `OperatorEntry`（`Dispatcher.h`） | 支持运行时注册、Jupyter 重载、自定义 backend |
| 预计算查表 | `dispatchTable_` array（`OperatorEntry.h`） | O(1) 分发，进 CPU cache，无哈希无分支 |
| 策略 | DispatchKey 分层 + backend fallback（`DispatchKey.h:136`） | 正交维度组合不类爆炸，优先级保证 Autograd 先于 backend |
| 双轨调用 | unboxed/boxed KernelFunction（`KernelFunction.h:289`） | 热路径零装箱，Python/RecordFunction 走 boxed 保兼容 |
| 模板方法 | structured op meta+impl（`BinaryOps.cpp:151`） | shape 推断与计算解耦，TensorIterator 复用通用逻辑 |

## 模块间交互

- **ATen → c10**：`TensorBase`（`TensorBase.h:93`）只持 `c10::intrusive_ptr<TensorImpl>`，所有方法转调 `impl_`。`DispatchKeySet`/`Device`/`Storage` 全在 `c10/core/`。
- **torch/csrc → ATen**：`VariableType_*` kernel（`torch/csrc/autograd/VariableTypeManual.cpp`）注册到 `DispatchKey::AutogradCPU` 等，在算子执行前后插入 autograd 节点构建。Python 经 `torch._C` 绑定调 `at::` 命名空间函数。
- **JIT → ATen**：JIT IR 的 `Node` 绑 `Operator`，Code 生成时用 `getOperationForDispatchKey(dk)` 填充 `operator_table_`，调用走 `c10::OperatorHandle::callBoxedForDispatchKey` → Dispatcher。

## 扩展方式

**新增 native op**：(1) `native/native_functions.yaml` 加 schema（structured op 需声明 `out`/`functional` 变体）；(2) `native/MyOp.cpp` 写 `TORCH_META_FUNC` + `TORCH_IMPL_FUNC`；(3) `DECLARE_DISPATCH`/`DEFINE_DISPATCH`/`REGISTER_DISPATCH` 接 backend kernel；(4) codegen 自动生成 `ops/my_op.h`、`RegisterCPU.cpp` 并经 `TORCH_LIBRARY_IMPL(aten, CPU)` 注册。参考 `BinaryOps.cpp:151`。

**为已有 op 新增 backend kernel**：在 `native/<backend>/MyOp.cpp` 实现 kernel，`REGISTER_DISPATCH(my_stub, &my_kernel)`（ISA 分支）；若需独立 `DispatchKey`，用 `TORCH_LIBRARY_IMPL(aten, MTIA, m)` 注册结构化 impl。

**新增 DispatchKey**：在 `DispatchKey.h` 的 `BackendComponent` 或 functionality enum 加项，更新 `num_runtime_entries`/`EndOfRuntimeBackendKeys`；`DispatchKeySet.h` 的 `offsetsAndMasks` 自动扩展；为新 key 注册所有算子的 fallthrough（否则 `lookup` `reportError`）。
