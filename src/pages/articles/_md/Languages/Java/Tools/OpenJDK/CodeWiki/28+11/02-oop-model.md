---
source:
  type: "源码解读"
  project: "OpenJDK"
  url: "https://github.com/openjdk/jdk"
title: "对象模型"
date: "2026-08-19T23:29:36+08:00"
category: ["Languages", "Java", "Tools", "OpenJDK", "CodeWiki", "28+11"]
tags: ["OpenJDK", "HotSpot", "Oop", "Klass", "markWord", "vtable", "CompressedOops"]
description: "HotSpot 对象模型——Oop/Klass 二级分离、markWord 对象头、InstanceKlass 元数据、vtable/itable 多继承分发、MethodData profiling"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Tools/OpenJDK/CodeWiki/28+11/00-overview)

---

## 模块定位

对象模型模块（`share/oops/`，~52k 行）定义了 HotSpot 中"Java 对象是什么"——对象的内存表示、对象头、类元数据、方法/常量池/运行时 profiling 数据。它是几乎所有其他模块的共同基础：GC 要遍历对象字段、解释器要执行 Method 的字节码、编译器要读 MethodData 的 profiling。`oops` 自身几乎不依赖其他子系统（除 `memory` 分配与基础工具），形成清晰的依赖倒金字塔——它是 VM 的最底层核心契约。

## 模块架构

![Oop/Klass 对象模型](/vibe-reading/images/articles/openjdk-hotspot/oop-model-arch.svg)

HotSpot 采用 **Oop/Klass 二级分离**：左列是堆中对象实例（`oopDesc`→`instanceOopDesc`/`arrayOopDesc`），右列是 Metaspace 中的类元数据（`Klass`→`InstanceKlass`/`ArrayKlass`）。`instanceOopDesc` 是空类——实例对象的字段布局完全由其 `Klass` 决定，对象本身只含对象头（`markWord` + 压缩 klass 指针）。`oop→klass()` 经 `CompressedKlassPointers::decode` 解码 narrowKlass 得到 `Klass*`，类型分派再经 `Klass` 的 C++ vtable 完成。`markWord`（64 位）编码 hash/age/lock/self-fwd 等状态。

## 调用链路

### 对象分配路径

`new Foo()` → `InstanceKlass::allocate_instance`（`instanceKlass.cpp:1936`）：

```
InstanceKlass::allocate_instance(TRAPS)        (instanceKlass.cpp:1936)
├─ size = size_helper()                         # 从 _layout_helper 取大小
└─ Universe::heap()->obj_allocate(this, size, THREAD)   # 交 GC 堆分配
    └─ MemAllocator::finish() → oopDesc::release_set_klass(mem, _klass)  # 写 klass 指针
```

`size_helper`（`instanceKlass.hpp:1099`）把 `_layout_helper` 正值右移 `LogBytesPerWord` 得对象大小。分配与对象头/字段布局的衔接见 [内存管理模块](/vibe-reading/articles/Languages/Java/Tools/OpenJDK/CodeWiki/28+11/07-memory)。

### 方法调用与入口选择

`Method::link_method`（`method.cpp:1313`）在类链接阶段设置三个入口点：`_i2i_entry`（解释器→解释器）、`_from_compiled_entry`（编译代码→解释器，c2i 适配器）、`_from_interpreted_entry`（解释器→编译代码，i2c 适配器）。JIT 完成后 `Method::set_code`（`method.cpp:1441`）更新 `_code` 与 `_from_interpreted_entry`，使后续调用跳转编译代码。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `InstanceKlass::allocate_instance` (`instanceKlass.cpp:1936`) | 实例分配 | size_helper 取大小，交堆分配 |
| `Method::link_method` (`method.cpp:1313`) | 设置方法入口 | 三入口点（i2i/c2i/i2c）适配器 |
| `Method::set_code` (`method.cpp:1441`) | JIT 完成改写入口 | 原子改 _from_interpreted_entry 为 i2c |
| `klassVtable::method_at` (`klassVtable.hpp:205`) | vtable 查找 | O(1) 数组索引 |
| `MethodData::build_profiling_method_data` (`method.cpp:680`) | 创建 MDO | 供 JIT profiling |

</details>

## 核心实现

### Oop/Klass 二级分离

`oopDesc`（`oop.hpp:47`）是所有 Java 对象基类，持 `volatile markWord _mark` 与 `narrowKlass _compressed_klass`，**不允许有 C++ virtual 函数**。`klass.hpp:44-49` 注释解释了原因：避免每个 Java 对象携带 C++ vtbl 指针。一个 Java 应用可能有数百万对象实例，但每类只有一个 `Klass`。分离后对象头仅 8-16 字节，C++ vtable 只存于 Metaspace 的 `Klass`（每类一份）；类型分派经 `oop→klass()→C++ vtable` 两跳完成。对比 Smalltalk/Self 的一体模型（每对象内嵌类指针+方法表，更灵活但内存开销大），HotSpot 用牺牲一点灵活性换取显著的内存节省与缓存友好性。

### markWord 与锁状态

`markWord`（`markWord.hpp`）64 位编码 `hash(31)+valhalla(4)+age(4)+self-fwd(1)+lock(2)+unused/klass(22)`。锁状态用最低 2 位：`unlocked(01)`/`locked(00)`/`monitor(10)`/`marked(11)`。`locked` 与 `unlocked` 都存真实数据（hash/age），仅 lock 位不同，fast-lock 不替换 header；`marked` 整个 mark 被替换为 GC 转发指针（`encode_pointer_as_mark`/`decode_pointer`）。紧凑设计的原因：对象头是每对象固定开销，一个仅含一个 int 的对象若 header 24 字节则 75% 被头占用；紧凑到 8 字节（compact headers）使占比降到 66%。当前版本 `markWord::monitor()` 是 `ShouldNotCallThis()`——ObjectMonitor 指针不再存于 mark word，而用独立 OM table。

### InstanceKlass 与 vtable/itable

`InstanceKlass`（`instanceKlass.hpp:178`）是 Java 类的完整元数据，持 `_constants`(ConstantPool)、`_methods`、`_init_state`(状态机 `allocated→loaded→linked→being_initialized→fully_initialized`)，末尾内嵌变长的 Java vtable、itable、oop-map blocks。vtable（`klassVtable.hpp:43`）利用 Java 单继承的 prefix property——子类 vtable 前 N 槽与父类一致，override 直接覆盖，查找 O(1)。itable（`klassVtable.hpp:281`）用 offset table（记 interface Klass* + 偏移）+ method table 两段结构处理多接口：先搜 offset table 定位接口，再按偏移直接索引方法槽。miranda 方法（接口声明但类中无实现）指向 `AbstractMethodError` stub。

### Method / ConstantPool / MethodData

`Method`（`method.hpp:68`）刻意保持紧凑（注释明示 footprint 影响），持 `_constMethod`、`_method_data`(MDO)、`_method_counters`、`_code`(nmethod)、入口点字段、`_intrinsic_id`。`ConstantPool`（`constantPool.hpp:81`）持 `_tags`、`_cache`(ConstantPoolCache)、`_pool_holder`。`MethodData`（`methodData.hpp:2185`）收集运行时 profiling 供 JIT：`CounterData`(调用/回边计数)、`ReceiverTypeData`/`VirtualCallData`(接收者类型，驱动 devirtualization)、`BranchData`/`MultiBranchData`(分支概率)、`SpeculativeTrapData`(投机 trap)、trap history（反优化原因统计）。`methodData.hpp:41-59` 注释说明：profile 为激进优化提供"罕见性"证据，使投机优化可行。

### CompressedOops / CompressedKlass

`narrowOop` 是 `uint32_t`（`oopsHierarchy.hpp:37`），把 64 位 oop 压缩为 32 位，节省 50% 对象内引用空间。模式（`compressedOops.hpp:67`）：`UnscaledNarrowOop`(堆<4GB)/`ZeroBasedNarrowOop`(<32GB)/`HeapBasedNarrowOop`。Klass 指针压缩更进一步：紧凑模式（`UseCompactObjectHeaders`）把 narrowKlass 从 32 位压到 22 位嵌入 mark word 高位，省去整个 `_compressed_klass` 字段，对象头从 16 字节降到 8 字节。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Oop/Klass 二级分离 | `oops/oop.hpp` + `klass.hpp:44` | 避免 Java 对象携带 C++ vtbl，节省内存 |
| 指针压缩 | `compressedOops.hpp`/`compressedKlass.hpp` | 64 位下压缩引用与 klass 指针，省空间 |
| 紧凑对象头 | `markWord.hpp` + `objLayout.cpp` | 64 位编码多种状态，最小化每对象固定开销 |
| 内嵌变长数据 | `InstanceKlass` 末尾 vtable/itable/oopmap | 连续布局提升缓存局部性，单次分配 |

## 模块间交互

`oops` 被几乎所有模块依赖：`runtime`(对象头操作/锁)、`classfile`(解析产物即 InstanceKlass)、`interpreter`(字节码执行/常量池)、`compiler/opto`(profiling/OopMap)、`gc`(对象遍历/mark word)。它只依赖 `memory`(分配)、`runtime/handles`、`runtime/globals`、`runtime/atomicAccess` 等基础层，是最底层核心。

## 扩展方式

新增一个对象头状态位：改 `markWord.hpp` 的 bit 布局常量（`lock_bits`/`age_bits`/`hash_bits`）与新 `is_xxx()`/`set_xxx()` accessor，若影响 header 大小改 `ObjLayout::initialize`(`objLayout.cpp`)，并同步影响所有 GC 的 `ageTable` 与 `runtime/basicLock`。新增 profiling 数据类型：在 `methodData.hpp` 的 `DataLayout` tag 枚举加 tag，继承 `ProfileData` 新增子类，在 `MethodData::initialize_data`/`bytecode_cell_count` 注册，并影响 `opto/compile` 与 `c1`。
