---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "c10 核心库"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "C++", "TensorImpl", "intrusive_ptr", "DispatchKeySet"]
description: "c10 是 PyTorch 最底层 C++ 核心库，定义 TensorImpl/Storage/intrusive_ptr/DispatchKeySet/SymInt/CachingAllocator 等基础抽象，零开销分层基石。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

c10 是 PyTorch 最底层的 C++ 核心库（"C++10"，得名于它只依赖 C++10 标准库），定义了整个框架赖以构建的基础抽象：`TensorImpl`（张量元数据）、`Storage`（数据载体）、`intrusive_ptr`（引用计数智能指针）、`Device`/`Stream`（设备与流）、`DispatchKeySet`（算子分发位集）、`SymInt`（符号化形状）和 `CachingAllocator`（缓存分配器）。

它位于分层架构的最底层（见概览架构图黄框），ATen、`torch/csrc`、Python `torch` 全部直接或间接依赖它。c10 的设计目标是**零开销抽象**——既要提供足够丰富的元信息支持自动微分、算子分发、设备迁移，又不能在热路径引入额外内存分配或虚函数调用。c10 本身不含任何算子实现，只提供"张量是什么"的答案，"张量怎么算"留给 ATen。

## 模块架构

c10 内部按职责分为三组核心抽象，围绕 `TensorImpl` 这一中心组织：

```text
┌─────────────────────────────────────────────────────────────────┐
│                       TensorImpl (TensorImpl.h)                  │
│  storage_ · sizes_and_strides_ · data_type_ · device_opt_        │
│  key_set_(DispatchKeySet) · version_counter_ · autograd_meta_    │
└───────┬───────────────────────────────────┬─────────────────────┘
        │ 持有                              │ 挂载（unique_ptr 懒加载）
        ▼                                   ▼
┌───────────────┐    ┌──────────────────┐  ┌─────────────────────┐
│ Storage       │    │ DispatchKeySet   │  │ AutogradMetaInterface│
│ (pimpl)       │    │ (uint64 位集)     │  │ (抽象，实现在 libtorch)│
└──────┬────────┘    └──────────────────┘  └─────────────────────┘
       │ intrusive_ptr
       ▼
┌───────────────┐    ┌──────────────────┐  ┌─────────────────────┐
│ StorageImpl   │    │  intrusive_ptr    │  │  CachingAllocator   │
│ data_ptr_     │    │  _target          │  │  (BlockPool/Block)   │
│ size_bytes_   │    │  combined_refcount_│  │  small/large 分池    │
│ allocator_    │    │  (strong+weak+py) │  │  stream/event 回收   │
└───────────────┘    └──────────────────┘  └─────────────────────┘
       │                     │                        │
       ▼                     │                        ▼
┌───────────────┐    ┌──────────────────┐  ┌─────────────────────┐
│ DataPtr       │    │  SymInt/SymBool  │  │  Device/Stream       │
│ (指针+deleter) │    │  (符号化形状)     │  │  (DeviceType+index)  │
└───────────────┘    └──────────────────┘  └─────────────────────┘
```

三组抽象的分工：**张量表示组**（`TensorImpl`/`Storage`/`StorageImpl`/`DataPtr`）回答"数据在哪、怎么排布"；**基础设施组**（`intrusive_ptr`/`DispatchKeySet`/`SymInt`/`Device`/`Stream`）提供引用计数、分发寻址、符号形状等机制；**内存管理组**（`Allocator`/`CachingAllocator`）负责设备内存的分配与回收。三组通过 `TensorImpl` 这一枢纽协作——它用 `intrusive_ptr` 管理生命周期，用 `DispatchKeySet` 标识身份，用 `Storage` 持有数据，用 `autograd_meta_` 挂载反向图。

## 核心实现

### TensorImpl 与 Storage 的分离

`TensorImpl`（`c10/core/TensorImpl.h:510`）继承 `intrusive_ptr_target`，是 Tensor 的底层表示。它持有的核心字段：

```cpp title="c10/core/TensorImpl.h"
struct C10_API TensorImpl : public c10::intrusive_ptr_target {
  Storage storage_;                          // 数据载体
  c10::impl::SizesAndStrides sizes_and_strides_;  // 形状与步长
  int64_t storage_offset_ = 0;
  int64_t numel_ = 1;                        // 元素总数
  caffe2::TypeMeta data_type_;               // dtype
  std::optional<c10::Device> device_opt_;
  DispatchKeySet key_set_;                   // 分发身份位集
  c10::VariableVersion version_counter_;     // 写入版本号
  std::unique_ptr<c10::AutogradMetaInterface> autograd_meta_;  // 懒加载
};
```

`Storage`（`c10/core/Storage.h:25`）是 `StorageImpl` 的 pimpl wrapper，只持有一个 `intrusive_ptr<StorageImpl>`。`StorageImpl`（`StorageImpl.h:55`）才真正拥有 `DataPtr data_ptr_`（指针+deleter）、`SymInt size_bytes_` 和 `Allocator*` 指针。

这种分离的设计决策是 **view 语义**的基础（`TensorImpl.h:447`）：多个 view（如 `slice`/`transpose`/`expand`）共享同一个 `Storage`——同一份内存、同一个 `data_ptr_`，仅在各自的 `TensorImpl` 中存不同的 `sizes_`/`strides_`/`storage_offset_`。这避免了视图操作时的数据拷贝，是 PyTorch "view 无开销"承诺的实现根基。`storage_.data_ptr().get() + storage_offset_ * itemsize` 就是该 tensor 实际数据起始地址。

元数据修改走 `set_sizes_and_strides`（`TensorImpl.h:1913`），它会级联调用 `refresh_numel()`（重算 `numel_ = product(sizes)`）和 `refresh_contiguous()`（重算连续性标志），保证元数据始终自洽。`version_counter_` 在每次 in-place 修改时自增，供 autograd 检测"前向输出被改写后能否安全复用"。

### intrusive_ptr 引用计数

`intrusive_ptr`（`c10/util/intrusive_ptr.h:333`）是 PyTorch 自研的引用计数智能指针，替代 `std::shared_ptr`。基类 `intrusive_ptr_target`（`intrusive_ptr.h:144`）将三个计数器打包进单个 `atomic<uint64_t>`：

```cpp title="c10/util/intrusive_ptr.h"
class intrusive_ptr_target {
  mutable std::atomic<uint64_t> combined_refcount_;
  // 低 32 位 = strong refcount
  // 高 32 位 = weakcount（含 bit63 = kHasPyObject 标志）
  virtual void release_resources() {}  // refcount→0 时回调
  virtual void incref_pyobject() const noexcept {}
  virtual void decref_pyobject() const noexcept {}
};
```

不用 `shared_ptr` 的原因（`intrusive_ptr.h:117`）：(1) `shared_ptr` 需额外分配控制块（一次 `malloc`），而 `intrusive_ptr` 的计数嵌入对象自身，零额外分配；(2) `intrusive_ptr` 可以从裸指针 `reclaim()` 重构（`intrusive_ptr.h` 的 `reclaim` 方法），这在跨 C++/Python 语言边界传递时至关重要——Python 侧的 `THPVariable` 和 C++ 侧的 `at::Tensor` 共享同一个 `TensorImpl`，无需多次包装；(3) `combined_refcount_` 的 bit63（`kHasPyObject`）标记"此对象有对应 Python wrapper"，当 C++ 侧 refcount 从 1→2 时自动 `incref_pyobject()` 保鲜 Python 对象，避免 C++ 持有期间被 GC 回收。

refcount 机制的核心方法：`retain_()`（`intrusive_ptr.h:374`）做 `fetch_add(kReferenceCountOne, relaxed)`；`reset_not_null_()`（`intrusive_ptr.h:407`）在 uniquely_owned（refcount==1 且 weakcount==1）时直接 `delete target`（快路径，无原子操作），否则 `fetch_sub(acq_rel)`，refcount 归零时调 `release_resources()` 再减 weakcount。`TensorImpl::release_resources`（`TensorImpl.cpp:326`）依次 `autograd_meta_.reset()` 和 `storage_ = {}`，级联释放反向图与数据。

### DispatchKeySet 位集

`DispatchKeySet`（`c10/core/DispatchKeySet.h:167`）是 PyTorch 算子分发的寻址基础，用单个 `uint64_t` 编码一个 tensor 的全部"身份"：

```cpp title="c10/core/DispatchKeySet.h"
class DispatchKeySet final {
  uint64_t repr_;
  // 低 ~16 位 = backend bits（CPU/CUDA/HIP/MPS/XPU/...）
  // 高位 = functionality bits（Dense/Sparse/Autograd/Functionalize/...）
  constexpr DispatchKeySet(DispatchKey k);  // 自动拆分 backend+functionality
  bool has(DispatchKey t) const;
  DispatchKey highestPriorityTypeId() const;  // CLZ 取最高优先级 key
};
```

设计决策（`DispatchKeySet.h:72`）：PyTorch 的分发维度是 **backend（设备）× functionality（处理层）** 的笛卡尔积。如果每个组合占一个 bit，64 位装不下（~12 backend × ~10 functionality = 120 个组合）。解法是把 64 位拆成**低位 backend 段 + 高位 functionality 段**，一个 DispatchKey = (functionality, backend) 二维坐标。运行时 `highestPriorityTypeId()` 用 count-leading-zeros 指令 O(1) 取最高优先级 key——功能位越高优先级越高（Autograd 高于 backend，Functionalize 高于 Autograd），这保证了"一个 requires_grad 的 CPU tensor"会先命中 Autograd kernel 而非直接跑到 CPU kernel。

一个 `TensorImpl` 仅存 8 字节的 `key_set_`，却能在每次算子调用时 O(1) 定位到正确的 kernel。`DispatchKey` 枚举定义见 `c10/core/DispatchKey.h:136`，backend 段由 `BackendComponent` 枚举（`DispatchKey.h:36`）的 `C10_FORALL_BACKEND_COMPONENTS` 宏展开。

### SymInt 符号化形状

`SymInt`（`c10/core/SymInt.h:36`）支持动态形状 tracing——形状可以是一个符号变量而非具体数值：

```cpp title="c10/core/SymInt.h"
class C10_API SymInt {
  int64_t data_;  // 正常 int64 或编码后的 SymNodeImpl* 指针
  bool is_heap_allocated() const { return !check_range(data_); }
  int64_t expect_int() const;       // 要求非符号化，否则报错
  int64_t guard_int(const char* file, int64_t line) const;  // 插入 guard
};
```

设计决策（`SymInt.h:22`）：用 `int64_t` 的负数空间编码 `SymNodeImpl*` 指针（`is_heap_allocated` 检查范围），单字大小无额外内存开销。当 Dynamo tracing 遇到 `x.size(0)` 这种动态维度时，用 `SymInt` 表示而不烘焙成具体值；`guard_int(__FILE__, __LINE__)` 在后端需要具体值时插入 guard，让同一编译图覆盖一个 shape 族（如任意 batch size），避免每个 batch size 重编译。这是 `torch.compile` 支持 dynamic shapes 的底层基石。`SymBool`（`SymBool.h`）同理。

### CachingAllocator 缓存分配器

CUDA 内存分配由 `DeviceCachingAllocator`（`c10/cuda/CUDACachingAllocator.cpp:1426`）和顶层 `NativeCachingAllocator`（`:4527`）管理：

```cpp title="c10/cuda/CUDACachingAllocator.cpp"
class DeviceCachingAllocator {
  BlockPool large_blocks;   // >1MB 缓存块
  BlockPool small_blocks;   // ≤1MB 缓存块
  ska::flat_hash_set<Block*> active_blocks;
  Block* malloc(size_t orig_size, cudaStream_t stream);
};
class NativeCachingAllocator : public CUDAAllocator {
  std::vector<std::unique_ptr<DeviceCachingAllocator>> device_allocator;
  static constexpr size_t kNumMutexShard = 67;  // 分片锁降争用
};
```

设计决策（`CUDACachingAllocator.cpp:79`）：(1) **small/large 分池**——≤1MB 走 `small_blocks`，>1MB 走 `large_blocks`，减少碎片；1-10MB 请求分配 20MB 大块再 `Block::splice` split。(2) **stream 绑定**——同 stream 内 free→realloc 无需同步（CUDA 流保序）；跨流用 CUDA event 延迟回收，event 完成前不可复用。(3) **分片锁**（`kNumMutexShard=67`）——`allocated_blocks` 按 hash 分片到 67 个 map，降低多线程分配争用。(4) CUDA graph capture 时切 private pool 冻结地址（`:112`），保证可重放。`Allocator` 抽象接口（`c10/core/Allocator.h:180`）通过 `REGISTER_ALLOCATOR` 宏（`:299`）注册到全局 `allocator_array`，`GetAllocator(DeviceType)` 查表返回，CPU 注册 `CPUAllocator`、CUDA 注册 `NativeCachingAllocator`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Pimpl | `Storage` → `StorageImpl`（`Storage.h:226`） | 切断编译依赖，`Storage` 头文件不需 include `StorageImpl` 全部细节 |
| Intrusive refcounting | `intrusive_ptr_target`（`intrusive_ptr.h:188`） | 零额外分配、可跨语言 reclaim、PyObject 保鲜，比 `shared_ptr` 更适合热路径 |
| 对象池 | `DeviceCachingAllocator`（`CUDACachingAllocator.cpp:1426`） | 摊销 `cudaMalloc` 同步开销，best-fit 复用已释放块 |
| 位集寻址 | `DispatchKeySet`（`DispatchKeySet.h:167`） | O(1) 分发寻址，8 字节编码 backend×functionality 多重身份 |
| 懒加载 | `autograd_meta_` unique_ptr（`TensorImpl.h:2901`） | 无梯度时零开销，`materialize_autograd_meta` 首次访问才分配 |

## 模块间交互

c10 是纯基础库，不依赖 PyTorch 其他模块，被所有上层模块依赖：

- **ATen 依赖 c10**：`at::TensorBase`（`aten/src/ATen/core/TensorBase.h:93`）只是一个壳，持有 `c10::intrusive_ptr<TensorImpl>`，所有方法转调 `impl_`。ATen 算子通过 `TensorImpl::key_set_` 参与 Dispatcher 分发。
- **autograd 挂载**：`c10/core/TensorImpl.h:163` 定义抽象 `AutogradMetaInterface`，但 `AutogradMeta` 实现在 libtorch.so（`torch/csrc/autograd/variable.h:225`），TensorImpl 在 libc10.so。跨 so 无法直接 `make_unique<AutogradMeta>`，故用 `AutogradMetaFactory`（`TensorImpl.h:188`）间接构造，`ConcreteAutogradMetaFactory` 在 `variable.cpp:151` 注册——这是分层解耦的经典手法。
- **分配器注册**：`REGISTER_ALLOCATOR` 在各 backend 初始化时注册到全局表，上层 `at::empty()` 调 `GetAllocator(device)` 取分配器。

## 扩展方式

**新增 Device**：在 `BackendComponent` enum（`DispatchKey.h:36` 的 `C10_FORALL_BACKEND_COMPONENTS` 宏）加 `NewBackendBit`，在 `DeviceType` 加枚举值，在 `Device.h` 加 `is_newbackend()` 方法，最后为新 backend 注册 fallthrough kernel（否则算子 `lookup` 会 `reportError`）。

**新增分配策略**：继承 `Allocator`（`Allocator.h:180`）实现 `allocate()`/`raw_deleter()`/`copy_data()`，用 `REGISTER_ALLOCATOR(DeviceType::X, new MyAllocator())` 注册。CUDA 侧可继承 `CUDAAllocator` 替换 `NativeCachingAllocator`。

**扩展 SymInt 支持**：新算子用 `sym_sizes()` 替代 `sizes()`（`TensorImpl.h:622`），取具体值时用 `guard_int(__FILE__, __LINE__)`；符号运算走 `operator_add_slow_path` 等 slow path（`SymInt.h:175`）。
