---
source:
  type: "源码解读"
  project: "OpenJDK"
  url: "https://github.com/openjdk/jdk"
title: "内存管理"
date: "2026-08-19T23:29:36+08:00"
category: ["Languages", "Java", "Tools", "OpenJDK", "CodeWiki", "28+11"]
tags: ["OpenJDK", "HotSpot", "Universe", "CollectedHeap", "Metaspace", "Arena", "allocation", "BarrierSet"]
description: "HotSpot 内存管理基础设施——Universe 全局、CollectedHeap/BarrierSet 抽象、Metaspace 元数据区、Arena bump-pointer 分配、分配标记基类"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Tools/OpenJDK/CodeWiki/28+11/00-overview)

---

## 模块定位

内存管理模块（`share/memory/`，~22k 行）是 HotSpot 的内存基础设施层。注意与 `gc/`（GC 算法实现，独立 20 万行主题）的区别：`memory/` 提供更底层的抽象——`Universe` 全局命名空间、`CollectedHeap`/`BarrierSet` 抽象基类（被 GC 子类实现）、`Metaspace` 类元数据区、`Arena`/`ResourceArea` 临时分配，以及 `allocation.hpp` 的分配标记基类体系。职责边界是"堆/元空间/临时分配的抽象与分配方式控制"，不含具体 GC 算法。

## 模块架构

![内存管理核心组件](/vibe-reading/images/articles/openjdk-hotspot/memory-arch.svg)

`Universe`（`AllStatic`）是 VM 全局命名空间，持有 `_collectedHeap`（唯一堆指针）、基本类型 Klass、预分配异常、镜像 Class 等根对象。`CollectedHeap`（抽象基类，定义于 `gc/shared/`）定义分配/遍历/GC 接口，GC 子类（G1/ZGC/Serial/...）实现；`BarrierSet` 通过 `AccessBarrier` 模板提供默认访问操作，GC 子类特化覆写特定屏障。`Metaspace` 按类加载器隔离管理元数据；`Arena`/`ResourceArea` 做线程局部 bump-pointer 分配；`allocation.hpp` 的标记基类（`CHeapObj`/`StackObj`/`ResourceObj`/`MetaspaceObj`/`ArenaObj`）在编译期强制对象分配位置。

## 调用链路

### 堆初始化与对象分配

```
universe_init()                                   (universe.cpp:873)
  → GCConfig::create_heap() → _collectedHeap->initialize()  (:964/967)
  → Metaspace::global_initialize()               (metaspace.cpp:718)
  → Universe::genesis()                           (:409) 基本类型 Klass + SystemDictionary

对象分配:
  InstanceKlass::allocate_instance → CollectedHeap::obj_allocate  (collectedHeap.inline.hpp:36)
    → ObjAllocator → MemAllocator::mem_allocate  (memAllocator.cpp:327)
       ├─ mem_allocate_inside_tlab_fast  (:250)  # TLAB 快路径
       ├─ mem_allocate_inside_tlab_slow  (:341)  # TLAB 满则 retire+重分配
       └─ mem_allocate_outside_tlab (:347)        # 直接堆
    → finish → oopDesc::release_set_klass        (memAllocator.cpp:389)

Metaspace 分配:
  InstanceKlass 加载 → Metaspace::allocate(loader_data, size, type)  (metaspace.cpp:903)
    → ClassLoaderMetaspace::allocate → MetaspaceArena::allocate_inner  (metaspaceArena.hpp:132)
       ├─ 当前 chunk 够 → bump pointer
       └─ 不够 → allocate_new_chunk → ChunkManager::get_chunk
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `Universe::initialize_heap` (`universe.cpp:962`) | 堆初始化 | GCConfig 选 GC 子类 |
| `CollectedHeap::obj_allocate` (`collectedHeap.inline.hpp:36`) | 对象分配入口 | TLAB 优先 |
| `Metaspace::allocate` (`metaspace.cpp:903`) | 元数据分配 | chunk→block |
| `Arena::Amalloc` (`arena.hpp:172`) | Arena 分配 | O(1) bump pointer |
| `ResourceMark::~ResourceMarkImpl` (`resourceArea.hpp:179`) | RAII 回滚 | rollback_to 水位 |

</details>

## 核心实现

### allocation.hpp 分配标记基类

`allocation.hpp` 通过继承特定基类在**编译期**强制对象分配位置：`CHeapObj<mtGC>`（`operator new` 调 `AllocateHeap`，走 malloc+NMT，须 `delete`，`:179`）、`StackObj`（`operator new = delete`，只能栈上构造，`:229`）、`ResourceObj`（`operator new` 调 `resource_allocate_bytes`，从线程局部 ResourceArea 分配，随 `ResourceMark` 析构回收，`:403`）、`MetaspaceObj`（`operator new` 接 `ClassLoaderData*`，从 Metaspace 分配，禁 `delete`，`:370`）、`ArenaObj`（接 `Arena*`，`:420`）。核心价值：防泄漏 + 可预测生命周期——不同子系统（GC/编译器/运行时）对象有不同生命周期要求，编译期强制比运行时检查更安全；NMT（Native Memory Tracking）通过 `MemTag` 模板参数在分配时自动标记内存用途。这是 HotSpot 特有设计。

### CollectedHeap / BarrierSet 抽象

`CollectedHeap`（`gc/shared/collectedHeap.hpp:92`，定义于 gc/shared 但被 `memory/Universe` 持有初始化）定义纯虚接口（`initialize`/`mem_allocate`/`allocate_new_tlab`/`collect`/`is_in`/`capacity` 等），GC 子类实现各自策略，公共逻辑（`obj_allocate`/`fill_with_object`）在基类。`BarrierSet`（`barrierSet.hpp:46`）通过内嵌 `AccessBarrier` 模板（`:186`)在 `oops/access.hpp` 的 Access API 自动解析，GC 子类只需覆写需要的操作（G1 的 SATB、ZGC 的 load barrier），其余走 `RawAccessBarrier` 默认；`BarrierSetAssembler`/`BarrierSetC1`/`BarrierSetC2`（`:74`）让屏障在汇编/C1/C2 层注入，编译器代码无需 if-else。新 GC 接入只需继承 `CollectedHeap`+`BarrierSet`+在 `barrierSetConfig.hpp` 注册。

### Metaspace

`Metaspace`（`metaspace.hpp:44`，`AllStatic`）JDK 8 起取代 PermGen。每个 `ClassLoaderData` 拥有 `ClassLoaderMetaspace`（`classLoaderMetaspace.hpp:67`），后者管两个 `MetaspaceArena`（class space + non-class space）。取代 PermGen 的原因：**自动扩缩**（`MetaspaceGC::compute_new_size` 按比例动态调 HWM，PermGen 固定上限易 OOM）；**按类加载器隔离**（类卸载时整个 arena 释放 `purge`，不影响其他加载器，PermGen 全局共享卸载后碎片化）；**class/non-class 分离**（64 位下 Klass 用 compressed klass，压缩指针仅覆盖 class space 节省位宽）；**chunk 管理**（buddy allocator 管理层级，按需 commit/uncommit 虚拟内存）。分配经 `MetaspaceArena::allocate_inner`（`metaspaceArena.hpp:132`）→ chunk 不够则 `ChunkManager::get_chunk`，失败触发 GC 重试（`satisfy_failed_metadata_allocation`）。

### Arena / ResourceArea

`Arena`（`arena.hpp:116`，继承 `CHeapObjBase`）用 `_hwm` 高水位做 bump-pointer 分配：`Amalloc`（`:172`）→ `internal_amalloc`（`:149`）比较 `_max-_hwm >= x` 移动指针，O(1)、无锁（线程局部）、无系统调用；chunk 不够则 `grow`（`arena.cpp:327`）经 `ChunkPool`（`:86`，缓存 4 种标准 chunk 免反复 malloc/free）。`ResourceArea`（`resourceArea.hpp:45`，继承 `Arena`）加 `SavedState`+`rollback_to`（`:104`）支持 `ResourceMark`（`:189`，继承 `StackObj` 禁堆分配）RAII 回滚——构造存 `_hwm`，析构回滚水位，批量释放无需逐对象 free。C2 编译一个方法可能创建数千 Node，批量释放是刚需。`Arena::Tag`（`:100`，`tag_node`/`tag_comp`/`tag_type`）支持 `CompilationMemoryStatistic` 统计。

### Universe 全局单例

`Universe`（`universe.hpp:48`，继承 `AllStatic`，全部 static 成员）是 VM 根命名空间——持 `_collectedHeap`、基本类型 `TypeArrayKlass`、`OopHandle` 镜像 Class、预分配 OOM 异常、`_reference_pending_list`、`OopStorage` 等。提供全局访问点（`heap()`/`int_mirror()`/`out_of_memory_error_java_heap()`）。初始化严格分阶段（`universe_init`→`genesis`→`universe_post_init`），`_bootstrapping`/`_fully_initialized` 控时序，`friend` 声明精确控制可修改内部状态的类。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 抽象基类 + 模板方法 | `CollectedHeap`/`BarrierSet` (`gc/shared/`) | 多 GC 共存，子类只实现策略 |
| 策略 | `GCConfig::create_heap` (`universe.cpp:964`) | 运行期按参数选 GC |
| 区域分配器/Bump Pointer | `Arena` (`arena.hpp:116`) | O(1) 分配、批量释放、无碎片 |
| RAII | `ResourceMark`/`HandleMark` (`resourceArea.hpp:189`) | 栈对象构造存状态析构回滚 |
| 编译期分配控制 | `allocation.hpp` 标记基类 | 强制分配位置防泄漏 |

## 模块间交互

`memory` 是基础设施，被 `gc`(算法实现继承 CollectedHeap/BarrierSet)、`oops`(对象头由 `MemAllocator::finish` 设 klass)、`classfile`(InstanceKlass 元数据从 Metaspace 分配)、`opto`(C2 用 Arena 分配 Node/Type，`tag_node`/`tag_type`)、`runtime`(Thread 持 ResourceArea，HandleMark 管 JNI handle) 使用。与 `gc/` 边界：`memory/` 提供抽象与基础设施，`gc/shared/` 提供 `CollectedHeap`/`BarrierSet` 抽象基类，GC 算法在 `gc/g1/`/`gc/z/` 等继承实现。`memory/heap.hpp` 的 `CodeHeap` 是 CodeCache 专用堆非 GC 堆。

## 扩展方式

接入新 GC 屏障：`gc/shared/barrierSetConfig.hpp` 加枚举；继承 `BarrierSet` 特化 `AccessBarrier` 覆写需拦截操作；实现 `BarrierSetAssembler/C1/C2` 子类注入层屏障；GC 的 `CollectedHeap` 子类 `initialize` 中 `BarrierSet::set_barrier_set` 安装。修改 Arena 分配策略：改 `Arena::internal_amalloc`（`arena.hpp:149`）与 `grow`（`arena.cpp:327`）的 chunk 选大小逻辑或 `ARENA_ALIGN`（`:35`）。修改 Metaspace 扩容：调 `MetaspaceGC::delta_capacity_until_GC`（`metaspace.cpp:293`）的 `MinMetaspaceExpansion`/`MaxMetaspaceExpansion` 或 `MetaspaceArena::allocate_inner` 的 chunk 选择与 `ArenaGrowthPolicy`。
