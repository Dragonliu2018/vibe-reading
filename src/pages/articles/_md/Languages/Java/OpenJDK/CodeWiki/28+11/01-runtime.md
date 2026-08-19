---
source:
  type: "源码解读"
  project: "OpenJDK"
  url: "https://github.com/openjdk/jdk"
title: "运行时与 VM 生命周期"
date: "2026-08-19T23:29:36+08:00"
category: [Languages, Java, OpenJDK, CodeWiki, "28+11"]
tags: ["OpenJDK", "HotSpot", "Threads", "Safepoint", "ObjectMonitor", "Continuation"]
description: "HotSpot 运行时模块——VM 生命周期、JavaThread 状态机、Safepoint、synchronized 锁升级、反优化与虚拟线程续体"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/OpenJDK/CodeWiki/28+11/00-overview)

---

## 模块定位

运行时模块（`share/runtime/`，~87k 行）是 HotSpot 的核心枢纽：它管理 VM 从启动到退出的生命周期、所有线程的创建与状态、safepoint 的协作式停止、`synchronized` 的锁实现，以及反优化与虚拟线程续体。几乎所有其他模块都依赖它——解释器需要 `JavaThread` 上下文、编译器需要 `SharedRuntime` 的调用入口、GC 需要 `SafepointSynchronize` 与 `Threads::oops_do` 遍历。它的核心职责边界是"运行期状态与并发协调"，不含对象表示（`oops`）、类加载（`classfile`）或具体 GC 算法。

## 模块架构

![运行时核心组件](/vibe-reading/images/articles/openjdk-hotspot/runtime-arch.svg)

`Threads` 是全局线程管理器（`AllStatic`），持有 VM 启动入口 `create_vm`。运行期有两类核心线程：`JavaThread`（应用线程，持 `_thread_state` 状态机）与 `VMThread`（全局唯一的 VM 操作执行者，单消费者队列）。`SafepointSynchronize` 用 polling page 实现协作式停止；`ObjectSynchronizer`/`ObjectMonitor` 实现 `synchronized` 的多级锁升级；`Deoptimization` 把编译代码安全回退到解释器；`Continuation` 的 freeze/thaw 支撑百万级虚拟线程。组件之间通过 VM 生命周期串联：`Threads::create_vm` 创建主线程与 VMThread，VMThread 在 safepoint 执行 GC/反优化，JavaThread 在解释/编译代码中运行并由 `SafepointSynchronize` 协调。

## 调用链路

### VM 启动链

`Threads::create_vm`（`threads.cpp:448`）装配全部子系统：

```
Threads::create_vm(args)                        (threads.cpp:448)
├─ VM_Version::early_initialize()              # CPU 特性
├─ Arguments::parse(args) → apply_ergo()
├─ SafepointMechanism::initialize()
├─ JavaThread* main = new JavaThread()          # (threads.cpp:560)
├─ universe_init() → Universe::genesis()        # 堆 + 基本类型 Klass
├─ VMThread::create() → os::start_thread()      # (threads.cpp:638)
├─ initialize_java_lang_classes()               # java.lang.*、main Thread
├─ CompileBroker::compilation_init()            # 编译器、CompilerThread
└─ call_initPhase2/3()                           # 模块系统/SecurityManager
```

### JavaThread 运行与状态机

`JavaThread::run`（`javaThread.cpp:599`）→ `thread_main_inner`（`:642`）→ 调用线程入口函数 `entry_point`（普通 Java 线程是 `JavaCalls::call_virtual(Thread.run)`，CompilerThread 是 `CompilerThread::thread_entry`）。状态机由 `JavaThreadState`（`globalDefinitions.hpp:1027`）枚举驱动：`_thread_new`→`_thread_in_vm`→`_thread_in_Java`/`_thread_in_native`/`_thread_blocked`，每个状态有 `_trans` 过渡态，状态转换在 `interfaceSupport.inline.hpp` 的 `transition_from_java/native/vm` 中完成。过渡态让 safepoint 代码能正确处理正在转换的线程。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `Threads::create_vm` (`threads.cpp:448`) | VM 启动装配 | 分阶段初始化，主线程先于 VMThread |
| `JavaThread::run` (`javaThread.cpp:599`) | 线程运行入口 | 经 `thread_main_inner` 调 `entry_point` |
| `SafepointSynchronize::begin` (`safepoint.cpp:334`) | 进入 safepoint | polling page 武装 + 旋转等待 |
| `ObjectSynchronizer::enter` (`synchronizer.cpp:1725`) | synchronized 进入 | 多级锁升级链 |
| `ObjectMonitor::enter` (`objectMonitor.cpp:484`) | 重量级锁获取 | 自适应自旋 + entry_list 阻塞 |
| `Deoptimization::deoptimize_all_marked` (`deoptimization.cpp:1082`) | 批量反优化 | 编译→解释器 pack/unpack |
| `Freeze::try_freeze_fast` (`continuationFreezeThaw.cpp:604`) | 虚拟线程卸载栈 | 栈帧拷到堆上 StackChunk |

</details>

## 核心实现

### JavaThread 状态机与 safepoint 安全性

`JavaThread`（`javaThread.hpp:267`）继承 `Thread`，持 `volatile JavaThreadState _thread_state`、`ThreadSafepointState* _safepoint_state`、`ObjectMonitor* _current_pending_monitor`、`HandshakeState _handshake`、`LockStack _lock_stack` 等。状态机存在的原因是 **safepoint 安全性**：GC 需要知道每个线程在哪执行以确定 oop 引用是否安全——`_thread_in_native` 的线程 oops 都在 jobject handle 中（安全）；`_thread_in_Java` 的线程可能持裸 oop 在寄存器/栈上（需 safepoint 处理）；`_thread_blocked` 的线程栈已 walkable。过渡态（`_xxx_trans`）让 safepoint 代码等待正在转换的线程而非直接阻塞，避免遗漏。代码位置：`JavaThreadState` 枚举 `globalDefinitions.hpp:1027`，状态转换 `interfaceSupport.inline.hpp:87`。

### Safepoint 协作式停止

`SafepointSynchronize`（`safepoint.hpp`，`AllStatic`）用 `_state`（`_not_synchronized`/`_synchronizing`/`_synchronized`）与 `_safepoint_counter`（奇数=safepoint 中）协调。`begin`（`safepoint.cpp:334`）由 VMThread 调用：`arm_safepoint`（`:277`）武装 per-thread polling page 并自增 counter，`synchronize_threads`（`:191`）旋转等待 `_waiting_to_block` 归零。各线程到达方式按状态不同：`_thread_in_Java` 解释器在分支/返回字节码处检查 polling 标记→`block()`；编译代码读 local polling page 触发 fault 进入 safepoint stub；`_thread_in_native` 返回时在 native→VM 屏障阻塞；`_thread_blocked` 直接算安全。safepoint 被 GC、`Deoptimization`、栈上替换、堆验证等触发——它们都需要全局一致状态。

### synchronized 锁升级与自适应自旋

`ObjectSynchronizer::enter`（`synchronizer.cpp:1725`）实现锁升级链，代价递增但功能递增：

```
LockStack 递归(零开销) → fast-lock CAS(markWord) → fast-lock 自旋 → inflate → ObjectMonitor(重量级)
```

无竞争的 synchronized 块走 fast-lock 路径几乎零开销（CAS `markWord` 的 lock 位 01→00）。竞争或需要 `wait/notify` 时 `inflate_and_enter`（`synchronizer.cpp:1935`）inflate 出 `ObjectMonitor`。`ObjectMonitor::enter`（`objectMonitor.cpp:484`）先 `try_spin` 自适应自旋——`try_spin`（`:2295`）按 per-monitor `_SpinDuration` 调整：成功调高（`adjust_up`）、失败调低（`adjust_down`），自旋成功率是未来成功率的良好预测器。失败后 `enter_with_contention_mark` 把 `ObjectWaiter` 入 entry_list（CAS 无锁入队）并 park。`ObjectMonitor` 的关键字段：`_owner`（owner ID）、`_recursions`、`_entry_list`、`_wait_set`、`_SpinDuration`、`_contentions`。

> 注意：JDK 15 起偏向锁（biased locking）已移除，`markWord` 中无 `biased` 相关位。当前是 LockStack（轻量级 fast-lock）→ ObjectMonitor（重量级）两级模型，`markWord::monitor()` 已变为 `ShouldNotCallThis()`——ObjectMonitor 指针不再存于 mark word，而用独立的 OM table。

### VMThread 单消费者队列

`VMThread`（`vmThread.hpp`，继承 `NamedThread`）是全局唯一的 VM 操作执行者。外部线程通过 `VMThread::execute(op)`（`vmThread.cpp:516`）提交 `VM_Operation` 并阻塞等待完成。`loop`（`:472`）→ `wait_for_operation` → `inner_execute`（含 safepoint begin/end）串行执行。单消费者设计简化了并发控制——所有需要全局一致性的操作（GC、反优化、堆检查）串行，避免并行一致性难题。`_next_vm_operation` 是单槽"队列"，`VMOperation_lock` 保护。

### Deoptimization 与 Continuation

`Deoptimization`（`deoptimization.cpp`）在依赖失效时把编译代码安全回退到解释器：`deoptimize_all_marked`（`:1082`）→ `CodeCache::make_marked_nmethods_deoptimized` 把 nmethod 标 `not_entrant` 并 patch 入口，再经 pack（`fetch_unroll_info`，`:522`，重建 `vframeArray` 含 Method/BCI/locals/monitors）/unpack（`unpack_frames`，`:904`，把帧恢复到解释器栈）。`Continuation`（`continuationFreezeThaw.cpp`）支撑虚拟线程：unmount 时 `Freeze::try_freeze_fast`（`:604`）把栈帧拷到堆上 `StackChunk`，mount 时 thaw 拷回载体线程栈，使百万级虚拟线程复用少数载体线程栈。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 | `JavaThreadState` (`globalDefinitions.hpp:1027`) | 区分执行区域以定 safepoint 安全性，过渡态处理转换中线程 |
| 自适应自旋 | `ObjectMonitor::try_spin` (`objectMonitor.cpp:2295`) | 按历史成功率动态调自旋时长，适应不同负载 |
| 单消费者队列 | `VMThread::loop` (`vmThread.cpp:472`) | VM 操作需全局一致，串行避免并发一致性难题 |
| 无锁队列 | `ObjectMonitor::add_to_entry_list` (`objectMonitor.cpp:696`) | 多生产者 CAS 入队、单消费者出队 |
| 协作式停止 | `SafepointSynchronize::arm_safepoint` (`safepoint.cpp:277`) | polling page 让编译代码自己检查，避免强制挂起 |

## 模块间交互

`runtime` 是依赖最广的枢纽：它依赖 `oops`（对象头/InstanceKlass）、`classfile`（vmClasses/javaClasses）、`memory`（ResourceArea）、`gc`（屏障）、`code`（nmethod 反优化）、`prims`（JVMTI）。被几乎所有模块依赖：`interpreter` 经 `JavaThread`/`SharedRuntime` 进入；`compiler` 经 `JavaThread`/`Deoptimization`；`gc` 经 `SafepointSynchronize`/`Threads::oops_do`；`classfile` 经 `JavaCalls`。交互方式有直接 C++ 调用、闭包回调（`ThreadClosure`/`OopClosure`）、`VM_Operation` 提交、per-thread `Handshake`。

## 扩展方式

新增一种 GC 线程类型：`runtime/nonJavaThread.hpp` 定义新 `NonJavaThread` 子类；`threads.cpp` 的 `non_java_threads_do` 与 VMThread `print_on_error` 列入；`safepoint.cpp` 的 `safepoint_synchronize_begin/end` 处理其暂停。调整锁策略：改 `objectMonitor.cpp` 的 `try_spin`/`adjust_up`/`adjust_down` 与 `objectMonitor.hpp` 的 `Knob_SpinLimit`/`Knob_PreSpin`，并同步解释器与编译器的 fast-path（`synchronizer.cpp:208` 警告必须同步修改）。
